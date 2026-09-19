import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { channelModelEntry, modelCanvasName, modelOptionName, useConfigStore } from "@/stores/use-config-store";

type BridgeCommand = { id: string; name: string; args: Record<string, unknown> };

const TIER_SIZE: Record<string, Record<string, string>> = {
    "1k": { "1:1": "1:1", "16:9": "16:9", "9:16": "9:16", "3:2": "3:2", "2:3": "2:3", "4:3": "4:3", "3:4": "3:4" },
    "2k": { "1:1": "2048x2048", "16:9": "2048x1152", "9:16": "1152x2048", "3:2": "2048x1360", "2:3": "1360x2048", "4:3": "2048x1536", "3:4": "1536x2048" },
    "4k": { "1:1": "4096x4096", "16:9": "3840x2160", "9:16": "2160x3840", "3:2": "3840x2560", "2:3": "2560x3840", "4:3": "3840x2880", "3:4": "2880x3840" },
};

function aspectOf(size: string) {
    const named = String(size || "").match(/^(\d+)\s*:\s*(\d+)/);
    if (named) return `${named[1]}:${named[2]}`;
    const pixels = String(size || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!pixels) return "1:1";
    const width = Number(pixels[1]);
    const height = Number(pixels[2]);
    const ratio = width / Math.max(1, height);
    const options: Array<[string, number]> = [["1:1", 1], ["16:9", 16 / 9], ["9:16", 9 / 16], ["3:2", 3 / 2], ["2:3", 2 / 3], ["4:3", 4 / 3], ["3:4", 3 / 4]];
    return options.reduce((best, item) => (Math.abs(ratio - item[1]) < Math.abs(ratio - best[1]) ? item : best))[0];
}

export function canvasSizeForTier(tier: string, aspect: string) {
    const normalized = String(tier || "1k").trim().toLowerCase();
    const table = TIER_SIZE[normalized] || TIER_SIZE["1k"];
    return table[aspect] || table["1:1"] || "1:1";
}

function summarizeNode(node: CanvasNodeData) {
    const metadata = node.metadata || {};
    const prompt = metadata.composerContent || metadata.prompt || (node.type === CanvasNodeType.Text ? metadata.content : "") || "";
    return {
        id: node.id,
        type: node.type,
        title: node.title,
        prompt: prompt.slice(0, 2000),
        size: metadata.size || "",
        status: metadata.status || "idle",
        model: metadata.model || "",
        canvasName: metadata.model ? modelCanvasName(channelModelEntry(useConfigStore.getState().config, metadata.model), modelOptionName(metadata.model)) : "",
        hasImage: Boolean(metadata.content && !String(metadata.content).startsWith("data:text")),
        width: metadata.naturalWidth || 0,
        height: metadata.naturalHeight || 0,
        error: metadata.errorDetails || "",
    };
}

const LOCAL_BRIDGE = "http://127.0.0.1:3000";
let bridgeBase: string | null = null;

function bridgeBases() {
    const here = window.location.origin.replace(/\/$/, "");
    if (here === LOCAL_BRIDGE || here === "http://localhost:3000") return [here];
    return [here, LOCAL_BRIDGE];
}

async function bridgeFetch(path: string, init?: RequestInit) {
    const bases = bridgeBase ? [bridgeBase, ...bridgeBases().filter((item) => item !== bridgeBase)] : bridgeBases();
    for (const base of bases) {
        try {
            const response = await fetch(`${base}${path}`, init);
            if (!(response.headers.get("content-type") || "").includes("application/json")) continue;
            bridgeBase = base;
            return response;
        } catch {
            if (bridgeBase === base) bridgeBase = null;
        }
    }
    return null;
}

async function postJson(path: string, body: unknown) {
    const response = await bridgeFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return Boolean(response?.ok);
}

export function startCanvasWorkbuddyBridge(options: {
    projectId: string;
    getNodes: () => CanvasNodeData[];
    setPrompt: (nodeId: string, prompt: string) => void;
    setSize: (nodeId: string, size: string) => void;
    generate: (nodeId: string, mode: CanvasGenerationMode, prompt: string) => Promise<void>;
}) {
    let stopped = false;
    let lastPosted = "";
    const tick = async () => {
        if (stopped) return;
        const nodes = options.getNodes();
        const summary = JSON.stringify({ projectId: options.projectId, nodes: nodes.map(summarizeNode) });
        if (summary !== lastPosted) {
            const posted = await postJson("/api/canvas-bridge/state", JSON.parse(summary)).catch(() => false);
            if (posted) lastPosted = summary;
        }
        const response = await bridgeFetch("/api/canvas-bridge/commands").catch(() => null);
        if (!response?.ok) return;
        const payload = (await response.json()) as { commands?: BridgeCommand[] };
        for (const command of payload.commands || []) {
            const result = await runCommand(command, nodes, options).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            await postJson("/api/canvas-bridge/result", { id: command.id, ...result }).catch(() => undefined);
            lastPosted = "";
        }
    };
    const timer = window.setInterval(() => void tick(), 1000);
    void tick();
    return () => {
        stopped = true;
        window.clearInterval(timer);
    };
}

async function waitForNode(getNodes: () => CanvasNodeData[], nodeId: string) {
    let latest = getNodes().find((item) => item.id === nodeId);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
        const status = latest?.metadata?.status;
        if (status === "success" || status === "error") return latest;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        latest = getNodes().find((item) => item.id === nodeId);
    }
    return latest;
}

async function runCommand(command: BridgeCommand, nodes: CanvasNodeData[], options: Parameters<typeof startCanvasWorkbuddyBridge>[0]) {
    const nodeId = String(command.args.nodeId || "");
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return { ok: false, error: `找不到节点 ${nodeId}` };
    if (command.name === "set_canvas_prompt") {
        const prompt = String(command.args.prompt || "");
        options.setPrompt(nodeId, prompt);
        return { ok: true, nodeId, prompt };
    }
    if (command.name === "set_canvas_size") {
        const tier = String(command.args.tier || "1k");
        const aspect = String(command.args.aspect || aspectOf(node.metadata?.size || ""));
        const size = canvasSizeForTier(tier, aspect);
        options.setSize(nodeId, size);
        return { ok: true, nodeId, tier, aspect, size };
    }
    if (command.name === "generate_canvas_node") {
        const latest = options.getNodes().find((item) => item.id === nodeId) || node;
        const prompt = latest.metadata?.composerContent || latest.metadata?.prompt || "";
        if (!prompt.trim()) return { ok: false, error: "这个节点还没有提示词" };
        const mode: CanvasGenerationMode = latest.type === CanvasNodeType.Video ? "video" : latest.type === CanvasNodeType.Audio ? "audio" : latest.metadata?.generationMode || "image";
        await options.generate(nodeId, mode, prompt);
        const done = await waitForNode(options.getNodes, nodeId);
        const status = done?.metadata?.status || "idle";
        const hasImage = Boolean(done?.metadata?.content && done.metadata.status === "success");
        if (status === "error" || (!hasImage && status !== "success")) {
            return { ok: false, status, error: done?.metadata?.errorDetails || "没有生成出图。请先在这个节点上选好模型和渠道，并保持项目页开着。" };
        }
        return {
            ok: true,
            status,
            hasImage,
            width: done?.metadata?.naturalWidth || 0,
            height: done?.metadata?.naturalHeight || 0,
            error: "",
        };
    }
    return { ok: false, error: `画布不认识指令 ${command.name}` };
}
