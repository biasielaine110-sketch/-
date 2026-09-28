/**
 * RunningHub workflow API: model name = workflowId.
 * Fetches the saved API graph, injects prompt + LoadImage, then polls the V2 task envelope
 * `{ taskId, status, results, errorMessage, ... }`.
 */

import axios from "axios";

import i18n from "@/i18n";
import { proxyApiUrl } from "@/lib/api-proxy";
import { applyComfyPrompt, parseComfyApiWorkflow, type ComfyNode, type ComfyWorkflow } from "@/lib/comfyui-native";
import { dataUrlToFile } from "@/lib/image-utils";

type RequestOptions = { signal?: AbortSignal };

export type RunningHubMedia = {
    images: string[];
    videos: string[];
};

export type RunningHubTaskView = {
    taskId: string;
    status: string;
    images: string[];
    videos: string[];
    errorMessage: string;
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

const apiText = (key: string) => i18n.t(`apiErrors.${key}`);

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function bearer(apiKey: string) {
    const token = String(apiKey || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function readMessage(value: unknown) {
    const record = asRecord(value);
    if (!record) return "";
    const nested = asRecord(record.error);
    const candidates = [record.errorMessage, record.failedReason, record.msg, record.message, nested?.message, record.errorCode];
    for (const item of candidates) {
        if (typeof item === "string" && item.trim() && !/^success$/i.test(item.trim())) return item.trim();
    }
    return "";
}

function isFailedStatus(status: string) {
    return /fail|cancel|error/i.test(status);
}

function isDoneStatus(status: string) {
    return /^(success|succeeded|completed)$/i.test(status);
}

function mediaKind(url: string, outputType?: string) {
    const type = String(outputType || "").toLowerCase();
    if (/video|mp4|webm|mov|mkv|avi/.test(type) || /\.(mp4|webm|mov|mkv|avi)(\?|$)/i.test(url)) return "video" as const;
    return "image" as const;
}

function collectResultMedia(value: unknown) {
    const images: string[] = [];
    const videos: string[] = [];
    if (!Array.isArray(value)) return { images, videos };
    for (const item of value) {
        if (typeof item === "string" && /^https?:/i.test(item)) {
            (mediaKind(item) === "video" ? videos : images).push(item);
            continue;
        }
        const record = asRecord(item);
        if (!record) continue;
        const url = [record.url, record.fileUrl, record.file_url, record.download_url, record.downloadUrl].find(
            (entry) => typeof entry === "string" && /^https?:/i.test(entry),
        );
        if (typeof url !== "string") continue;
        const outputType = typeof record.outputType === "string" ? record.outputType : typeof record.fileType === "string" ? record.fileType : "";
        (mediaKind(url, outputType) === "video" ? videos : images).push(url);
    }
    return { images, videos };
}

/** Site root for the official task API, including when Base URL is a /proxy address. */
export function runningHubOrigin(baseUrl: string): string | null {
    const raw = String(baseUrl || "").trim();
    if (!raw) return null;
    try {
        const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
        if (!/(^|\.)runninghub\.(cn|ai)$/i.test(url.hostname)) return null;
        return `${url.protocol}//${url.host}`;
    } catch {
        return null;
    }
}

export function isRunningHubComfyProxy(baseUrl: string): boolean {
    const raw = String(baseUrl || "").trim();
    if (!runningHubOrigin(raw)) return false;
    try {
        const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
        return /\/proxy(-plus)?(\/|$)/i.test(url.pathname);
    } catch {
        return false;
    }
}

export function runningHubApiKey(baseUrl: string, apiKey: string): string {
    const token = String(apiKey || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    if (token && !/^(none|-|n\/a)$/i.test(token)) return token;
    try {
        const url = new URL(String(baseUrl || "").includes("://") ? baseUrl : `https://${baseUrl}`);
        const embedded = url.pathname.match(/\/proxy(?:-plus)?\/([^/]+)/i)?.[1];
        return embedded ? decodeURIComponent(embedded) : "";
    } catch {
        return "";
    }
}

function idFromText(value: string) {
    const trimmed = value
        .trim()
        .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
        .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30));
    if (/^\d{8,}$/.test(trimmed)) return trimmed;
    const fromQuery = trimmed.match(/[?&#](?:workflowId|webappId|id)=(\d{8,})/i)?.[1];
    if (fromQuery) return fromQuery;
    const fromPath = trimmed.match(/\/(?:workflow|ai-detail|webapp|post)\/(\d{8,})/i)?.[1];
    if (fromPath) return fromPath;
    const fromHost = trimmed.match(/runninghub\.(?:cn|ai)\/[^?\s#]*?(\d{8,})/i)?.[1];
    if (fromHost) return fromHost;
    return trimmed.match(/\d{16,}/)?.[0] || null;
}

function idFromScript(script: string) {
    const trimmed = script.trim();
    if (!trimmed.startsWith("{")) return idFromText(trimmed);
    const explicit = trimmed.match(/"(?:workflowId|webappId)"\s*:\s*"(\d{8,})"/);
    return explicit?.[1] || null;
}

/** Model name, workflow/AI-app URL, Base URL path, or a script that is only the id. */
export function parseRunningHubWorkflowId(model: string, script?: string, baseUrl?: string): string | null {
    const name = String(model || "")
        .split("::")
        .pop()
        ?.trim()
        .replace(/^(rh|runninghub|workflow)[:_-]/i, "")
        .trim();
    return (name ? idFromText(name) : null) || idFromScript(String(script || "")) || (baseUrl ? idFromText(baseUrl) : null);
}

export function pickRunningHubWorkflowId(input: { baseUrl?: string; model?: string; script?: string; channelName?: string; siblingModels?: Array<{ name?: string; script?: string }> }) {
    const direct = parseRunningHubWorkflowId(input.model || "", input.script, input.baseUrl);
    if (direct) return direct;
    const fromChannel = parseRunningHubWorkflowId(input.channelName || "", "", input.baseUrl);
    if (fromChannel) return fromChannel;
    const ids = [...new Set((input.siblingModels || []).map((item) => parseRunningHubWorkflowId(item.name || "", item.script, input.baseUrl)).filter((id): id is string => Boolean(id)))];
    return ids.length === 1 ? ids[0] : null;
}

export function shouldUseRunningHubWorkflow(baseUrl: string, model: string, script?: string) {
    return Boolean(runningHubOrigin(baseUrl) && parseRunningHubWorkflowId(model, script, baseUrl));
}

/** V2 query / run envelope. Returns null for unrelated payloads. */
export function readRunningHubTask(payload: unknown): RunningHubTaskView | null {
    const root = asRecord(payload);
    if (!root) return null;
    const data = asRecord(root.data);
    const record = typeof root.taskId === "string" && root.taskId ? root : data && typeof data.taskId === "string" && data.taskId ? data : null;
    if (!record) return null;
    const signature = "promptTips" in record || "errorCode" in record || "failedReason" in record || "taskUsageList" in record;
    if (!signature) return null;
    const status = String(record.status || record.taskStatus || "");
    const media = collectResultMedia(record.results ?? data?.results);
    return {
        taskId: String(record.taskId),
        status,
        images: media.images,
        videos: media.videos,
        errorMessage: isFailedStatus(status) ? readMessage(record) || readMessage(root) : "",
    };
}

function isMissingIdMessage(message: string) {
    return /WORKFLOW_NOT_EXISTS|WEBAPP_NOT_EXISTS/i.test(message);
}

function isAuthMessage(message: string) {
    return /APIKEY_UNAUTHORIZED|APIKEY_UNSUPPORTED_FREE_USER|TOKEN_INVALID|APIKEY_USER_NOT_FOUND|CORPAPIKEY_INVALID/i.test(message);
}

function isBalanceMessage(message: string) {
    return /NOT_ENOUGH_BALANCE|INSUFFICIENT_BALANCE|NO_ENOUGH_BALANCE|BALANCE_NOT_ENOUGH|NOT_ENOUGH_POINTS|INSUFFICIENT_POINTS|余额不足|额度不足/i.test(message);
}

function isUnknownServerError(message: string) {
    return /UNKNOWN_ERROR|^Unknown error/i.test(message);
}

function errorText(error: unknown) {
    if (axios.isAxiosError(error)) return readMessage(error.response?.data) || error.message;
    return error instanceof Error ? error.message : "";
}

function explainRunningHubError(error: unknown, workflowId: string): Error {
    const message = errorText(error);
    if (isMissingIdMessage(message)) return new Error(i18n.t("apiErrors.runningHubWorkflowNotExists", { id: workflowId }));
    if (/WORKFLOW_NOT_SAVED_OR_NOT_RUNNING/i.test(message)) return new Error(apiText("runningHubWorkflowNotRun"));
    if (/NOT_ENOUGH_BALANCE|INSUFFICIENT_BALANCE|NO_ENOUGH_BALANCE|BALANCE_NOT_ENOUGH|NOT_ENOUGH_POINTS|INSUFFICIENT_POINTS/i.test(message)) return new Error(apiText("runningHubNoBalance"));
    if (isUnknownServerError(message)) return new Error(apiText("runningHubUnknownError"));
    if (error instanceof Error && error.message && !isUnknownServerError(error.message)) return error;
    return new Error(message || apiText("requestFailed"));
}

function assertOk(payload: unknown, fallback: string) {
    const record = asRecord(payload);
    if (!record) return;
    const code = typeof record.code === "number" ? record.code : typeof record.code === "string" && /^\d+$/.test(record.code) ? Number(record.code) : null;
    if (code !== null && code !== 0 && code !== 200) {
        throw new Error(readMessage(record) || fallback);
    }
    if (isMissingIdMessage(readMessage(record))) throw new Error(readMessage(record));
}

async function fetchWorkflow(origin: string, apiKey: string, workflowId: string, signal?: AbortSignal): Promise<ComfyWorkflow> {
    const response = await axios.post(
        proxyApiUrl(`${origin}/api/openapi/getJsonApiFormat`),
        { apiKey: apiKey.replace(/^Bearer\s+/i, "").trim(), workflowId },
        { headers: bearer(apiKey), signal, timeout: 60_000 },
    );
    assertOk(response.data, apiText("runningHubWorkflowFetchFailed"));
    const data = asRecord(response.data)?.data ?? response.data;
    const record = asRecord(data);
    const prompt = record?.prompt ?? record?.workflow ?? record?.json ?? record?.apiFormat ?? data;
    const raw = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    const workflow = parseComfyApiWorkflow(raw.startsWith("{") ? raw : "");
    if (!workflow) throw new Error(readMessage(response.data) || apiText("runningHubWorkflowFetchFailed"));
    return workflow;
}

type WebappNode = { nodeId: string; fieldName: string; fieldValue: string; fieldType?: string; nodeName?: string; description?: string };

const QWEN_IMAGE_21_WORKFLOW_ID = "2101992508854202370";
// Second Qwen Image 2.1 (文生图) workflow. Its nodes are numbered differently
// (ResolutionSelector "13", TextEncodeQwenImage21 "471"), so node lookup must be
// driven by class_type, not hard-coded node ids.
const QWEN_IMAGE_21_V1_WORKFLOW_ID = "2102725625755820033";
// Qwen Image 2.1 (图生图) workflow. Uses TextEncodeQwenImage21 with images.image_1..10
// reference inputs plus a ComfySwitchNode (483) toggling I2I/T2I, and ships with several
// pre-baked LoadImage references that must be cleared when the user links their own images.
const QWEN_IMAGE_21_I2I_WORKFLOW_ID = "2102726433268387841";
const QWEN_IMAGE_21_WORKFLOW_IDS = new Set([QWEN_IMAGE_21_WORKFLOW_ID, QWEN_IMAGE_21_V1_WORKFLOW_ID, QWEN_IMAGE_21_I2I_WORKFLOW_ID]);
const QWEN_IMAGE_21_LOAD_IMAGE_ORDER = ["420", "432", "433", "436", "435", "434"];

const RUNNINGHUB_RESOLUTION_SELECTOR_ASPECTS: Array<{ ratio: string; label: string; value: number }> = [
    { ratio: "1:1", label: "1:1 (Square)", value: 1 },
    { ratio: "2:3", label: "2:3 (Portrait Photo)", value: 2 / 3 },
    { ratio: "3:2", label: "3:2 (Photo)", value: 3 / 2 },
    { ratio: "3:4", label: "3:4 (Portrait Standard)", value: 3 / 4 },
    { ratio: "4:3", label: "4:3 (Standard)", value: 4 / 3 },
    { ratio: "9:16", label: "9:16 (Portrait Widescreen)", value: 9 / 16 },
    { ratio: "16:9", label: "16:9 (Widescreen)", value: 16 / 9 },
    { ratio: "21:9", label: "21:9 (Ultrawide)", value: 21 / 9 },
];

function isQwenImage21Workflow(workflowId?: string | null) {
    return Boolean(workflowId && QWEN_IMAGE_21_WORKFLOW_IDS.has(workflowId));
}

function isQwenImage21I2IWorkflow(workflowId?: string | null) {
    return workflowId === QWEN_IMAGE_21_I2I_WORKFLOW_ID;
}

function resolutionSelectorAspectLabel(aspect: string) {
    return RUNNINGHUB_RESOLUTION_SELECTOR_ASPECTS.find((item) => item.ratio === aspect)?.label || "16:9 (Widescreen)";
}

function closestResolutionSelectorAspect(width: number, height: number) {
    const target = width / Math.max(1, height);
    let best = RUNNINGHUB_RESOLUTION_SELECTOR_ASPECTS[6];
    let bestDiff = Infinity;
    for (const item of RUNNINGHUB_RESOLUTION_SELECTOR_ASPECTS) {
        const diff = Math.abs(target - item.value);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = item;
        }
    }
    return best.ratio;
}

function qwenImage21Megapixels(size: { width: number; height: number } | null | undefined, rawSize: string) {
    const tier = canvasResolutionTier(rawSize);
    if (tier === "4k") return 8.3;
    if (tier === "2k") return 4.2;
    if (size?.width && size.height) return Math.max(0.1, Math.min(16, Math.round(((size.width * size.height) / 1_000_000) * 10) / 10));
    return 2.2;
}

function applyQwenImage21Settings(workflow: ComfyWorkflow, imageValues: string[], size?: { width: number; height: number } | null, aspect = "", rawSize = "", workflowId?: string) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    const hasReferenceImages = imageValues.length > 0;
    // I2I/T2I switch. The RunningHub nodeInfo API can override scalar inputs, but cannot create
    // a missing ComfyUI link. Only toggle into I2I when the saved workflow already exposes on_false.
    // The switch node id differs across Qwen workflows, so fall back to a class_type scan.
    const switchNode = next["419"] || findComfyNode(next, (node) => /switch/i.test(node.class_type || ""));
    if (switchNode?.inputs && (!hasReferenceImages || "on_false" in switchNode.inputs)) switchNode.inputs.switch = !hasReferenceImages;

    // ResolutionSelector drives aspect_ratio (a display label like "16:9 (Widescreen)") and
    // megapixels (a numeric tier). Its node id differs per workflow, so locate it by class_type.
    const selector = next["424"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "9:16");
        if ("aspect_ratio" in selector.inputs) selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        if ("megapixels" in selector.inputs) selector.inputs.megapixels = qwenImage21Megapixels(size, rawSize);
    }

    // Qwen Image 2.1 encodes text at a fixed resolution matching the long side of the latent.
    const encoder = next["418"] || findComfyNode(next, (node) => /TextEncodeQwenImage21/i.test(node.class_type || ""));
    if (encoder?.inputs && "resolution" in encoder.inputs) {
        // 图生图：resolution 跟随用户选择的画幅长边(而非 0 跟随参考图 image_1)，使输出
        // 严格按所选画幅(9:16/16:9 等)resize，而非被参考图自身宽高比或工作流默认值决定。
        if (size?.width && size.height) {
            encoder.inputs.resolution = Math.max(size.width, size.height);
        }
    }

    // The 图生图 workflow ships with several pre-baked LoadImage references (image 1/2/3 hold real
    // files). When the user links their own reference images, only the first N loaders should carry
    // the uploaded files — every remaining loader must be cleared to "None" so the model does not
    // pull the baked-in pictures and produce a garbled result.
    if (isQwenImage21I2IWorkflow(workflowId)) {
        const loaders = qwenImage21I2ILoadImageOrder(next);
        loaders.forEach((entry, index) => {
            const node = entry[1];
            const filename = imageValues[index] || "";
            if (node?.inputs && typeof node.inputs.image === "string" && node.inputs.image !== "None") {
                node.inputs.image = filename || "None";
            }
        });
    }

    return next;
}

/** The 图生图 workflow's reference images are ordered by the "Load Image N" title, not node id. */
function qwenImage21I2ILoadImageOrder(workflow: ComfyWorkflow): Array<readonly [string, ComfyNode]> {
    return Object.entries(workflow)
        .filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")))
        .sort(([idA, nodeA], [idB, nodeB]) => {
            const numA = titleImageIndex(nodeA) ?? Number.MAX_SAFE_INTEGER;
            const numB = titleImageIndex(nodeB) ?? Number.MAX_SAFE_INTEGER;
            if (numA !== numB) return numA - numB;
            return idA.localeCompare(idB, undefined, { numeric: true });
        });
}

function titleImageIndex(node: ComfyNode | undefined): number | null {
    const title = String(node?._meta?.title || "");
    const match = title.match(/(\d+)\s*$/);
    return match ? Number(match[1]) : null;
}

function findComfyNode(workflow: ComfyWorkflow, predicate: (node: ComfyNode) => boolean): ComfyNode | undefined {
    for (const node of Object.values(workflow)) {
        if (predicate(node)) return node;
    }
    return undefined;
}

// Qwen Image 2.1 文生与编辑加速工作流（双自动提示词）: a runninghub.cn/.ai text-to-image +
// edit pair. The prompt itself already lands correctly in the "CR Prompt Text" node (the generic
// writer gives it score 40 and writes its `prompt` field), but everything around resolution is
// mismatched:
//   - ResolutionSelector (406) drives EmptyLatentImage, so it alone decides the output size,
//     yet its `aspect_ratio` is a label enum ("16:9 (Widescreen)") the generic writer cannot
//     produce — the canvas aspect choice was silently ignored;
//   - its `megapixels` is a number the tier writer force-maps 1k/2k/4k → 1/2/4, so every named
//     aspect (always "1k") knocked the workflow's baked 2MP down to 1MP;
//   - both KSamplers (442 / 902) bake a fixed seed, so identical inputs repeated identical images.
// Everything below is scoped to these two workflow ids only.
const QWEN_IMAGE_21_DUAL_WORKFLOW_IDS = new Set(["2104231628587798530", "2104232576453009410"]);
// Reference loaders in graph order = 图1..图4 (kept as an explicit order so a re-numbered variant
// still maps the user's images onto the same slots).
const QWEN_IMAGE_21_DUAL_LOAD_IMAGE_ORDER = ["420", "432", "433", "436"];

function isQwenImage21DualWorkflow(workflowId?: string | null) {
    return Boolean(workflowId && QWEN_IMAGE_21_DUAL_WORKFLOW_IDS.has(workflowId));
}

function qwenImage21DualLoadImageOrder(workflow: ComfyWorkflow): Array<readonly [string, ComfyNode]> {
    const named = QWEN_IMAGE_21_DUAL_LOAD_IMAGE_ORDER.map((nodeId) => [nodeId, workflow[nodeId]] as const).filter(
        (entry): entry is readonly [string, ComfyNode] => Boolean(entry[1]) && /LoadImage/i.test(String(entry[1]?.class_type || "")),
    );
    if (named.length) return named;
    return Object.entries(workflow)
        .filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")))
        .sort(([idA], [idB]) => idA.localeCompare(idB, undefined, { numeric: true }));
}

/**
 * The saved "文生与编辑" graph ships its reference branch disconnected: the four LoadImage nodes
 * (420/432/433/436) feed ImageScaleToMaxDimension (873..876), but those scalers plug into nothing
 * and the TextEncodeQwenImage21 node (404) declares no `images.*` slots — so writing the uploaded
 * filenames into the loaders alone leaves the graph in pure text-to-image and the references never
 * reach the sampler.
 *
 * Re-attach each scaled reference to the encoder's growable `images.image_N` slot (slot order =
 * 图1..图4, exactly the order the prompt addresses them by) so the visual reference actually
 * conditions the result, and drop any slot the user did not fill so a baked demo picture can never
 * leak in. Returns true when the wiring changed, i.e. the repaired graph must be submitted.
 */
function wireQwenImage21DualReferences(workflow: ComfyWorkflow, imageValues: string[]): boolean {
    const encoder = workflow["404"] || findComfyNode(workflow, (node) => /TextEncodeQwenImage21/i.test(String(node.class_type || "")));
    if (!encoder?.inputs) return false;

    const ordered = qwenImage21DualLoadImageOrder(workflow).slice(0, 16);
    const filled: number[] = [];
    ordered.forEach((_entry, index) => {
        const value = imageValues[index];
        if (value && value !== "None") filled.push(index);
    });
    const trailing = filled.length ? filled[filled.length - 1] + 1 : ordered.length;

    let changed = false;
    for (const index of filled) {
        const field = `images.image_${index + 1}`;
        const source = qwenImage21ReferenceSource(workflow, ordered[index][0]);
        const current = encoder.inputs[field];
        if (Array.isArray(current) && String(current[0]) === source) continue;
        encoder.inputs[field] = [source, 0];
        changed = true;
    }
    for (let index = trailing; index < 16; index += 1) {
        const field = `images.image_${index + 1}`;
        if (field in encoder.inputs) {
            delete encoder.inputs[field];
            changed = true;
        }
    }

    return changed;
}

/**
 * The node that consumes a LoadImage output — the graph's per-figure ImageScaleToMaxDimension —
 * so the encoder receives the normalized reference rather than the raw upload. Falls back to the
 * loader itself on a variant that wires the references directly.
 */
function qwenImage21ReferenceSource(workflow: ComfyWorkflow, loadImageNodeId: string): string {
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!/ImageScale/i.test(String(node?.class_type || ""))) continue;
        const feedsLoader = Object.values(node?.inputs || {}).some((value) => Array.isArray(value) && String(value[0]) === loadImageNodeId);
        if (feedsLoader) return nodeId;
    }
    return loadImageNodeId;
}

/**
 * @param workflow patched graph (generic prompt/size/tier writers already ran)
 * @param pristine untouched API graph, used for baked defaults and for scrubbing synthetic inputs
 * @returns the patched graph plus whether the reference wiring had to be repaired — when it did, the
 * caller must submit the graph itself because nodeInfoList cannot create links.
 */
function applyQwenImage21DualSettings(
    workflow: ComfyWorkflow,
    pristine: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    size?: { width: number; height: number } | null,
    aspect = "",
    rawSize = "",
): { workflow: ComfyWorkflow; rewired: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // Prompt → "CR Prompt Text" (node 456), the head of the
    // 456 → StringConcatenate(701/702) → Any Switch(710) → TextEncodeQwenImage21(404) chain.
    // Write it explicitly so a variant whose titles drift cannot fall through to the forceText
    // path, which would invent a `text` input the encoder does not declare.
    if (prompt.trim()) {
        const promptNode =
            next["456"] ||
            findComfyNode(next, (node) => /CR\s*Prompt\s*Text/i.test(String(node.class_type || "")) && typeof node.inputs?.prompt === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.prompt === "string") promptNode.inputs.prompt = prompt;
    }

    // Drop inputs that are not part of the node's declared API surface. RunningHub rejects
    // overrides for unknown fields, and that rejection takes the whole nodeInfo batch with it —
    // which would silently fall back to the workflow's baked demo prompt.
    for (const [nodeId, node] of Object.entries(next)) {
        if (!node?.inputs) continue;
        const declared = pristine[nodeId]?.inputs || {};
        for (const field of Object.keys(node.inputs)) {
            if (!(field in declared)) delete node.inputs[field];
        }
    }

    // Aspect ratio → ResolutionSelector label enum (node 406). This node feeds
    // EmptyLatentImage, so it is the single lever for the rendered size.
    const selector = next["406"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        const pristineSelector = pristine["406"] || findComfyNode(pristine, (node) => node.class_type === "ResolutionSelector" && "megapixels" in (node.inputs || {}));
        const bakedMegapixels = typeof pristineSelector?.inputs?.megapixels === "number" ? pristineSelector.inputs.megapixels : NaN;

        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        }

        // Precision stays ours: the workflow's baked value is a floor, so picking a shape (always a
        // "1k" tier) can no longer silently degrade the output, while an explicit 2k/4k size may
        // still raise it. With an "auto" size nothing is requested and the baked value stands.
        if (typeof selector.inputs.megapixels === "number" || typeof selector.inputs.megapixels === "string") {
            const tier = canvasResolutionTier(rawSize);
            const tierMegapixels = tier === "4k" ? 4 : tier === "2k" ? 2 : 1;
            const requested = Number.isFinite(bakedMegapixels) && bakedMegapixels > 0 ? Math.max(bakedMegapixels, tierMegapixels) : tierMegapixels;
            if (requested > 0) selector.inputs.megapixels = requested;
        }
    }

    // Fixed seeds → identical results for identical inputs. Randomize per submission.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/RandomNoise/i.test(type) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        else if (/KSampler|SamplerCustom/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    // Reference images → 图1..图4 loaders. The saved graph ships demo portraits; once the user
    // links their own images only the first N slots carry them and every leftover is cleared, so
    // baked-in characters never leak into the edit result.
    if (imageValues.length) {
        qwenImage21DualLoadImageOrder(next).forEach((entry, index) => {
            const node = entry[1];
            if (!node?.inputs || typeof node.inputs.image !== "string") return;
            node.inputs.image = imageValues[index] || "None";
        });
    }

    // Writing the loaders is not enough on its own — the graph also has to consume them.
    const rewired = wireQwenImage21DualReferences(next, imageValues);

    return { workflow: next, rewired };
}

// MiniMax H3 高一致性-故事多分镜图 workflow (reference-to-video + 6 storyboard frames).
// Its knobs do not match the generic field-name heuristics: duration is a PrimitiveFloat
// titled "Float (Duration)" (field "value", not "duration"), the ResolutionSelector stores a
// label enum ("16:9 (Widescreen)"), the storyboard extractor's frame indexes assume 6s@24fps,
// and RandomNoise ships a fixed seed. Everything below is scoped to this workflow id only.
const MINIMAX_H3_STORY_WORKFLOW_ID = "2103743201025814529";
const MINIMAX_H3_STORY_LOAD_IMAGE_ORDER = ["154", "155", "156"]; // 角色1, 角色2, 场景1
const MINIMAX_H3_STORYBOARD_FRAMES = 6;

function isMinimaxH3StoryWorkflow(workflowId?: string | null) {
    return workflowId === MINIMAX_H3_STORY_WORKFLOW_ID;
}

/** Public gate for callers outside this module (e.g. the image path deciding whether to send seconds). */
export function isMinimaxH3StoryWorkflowId(workflowId?: string | null) {
    return isMinimaxH3StoryWorkflow(workflowId);
}

function randomComfySeed() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function applyMinimaxH3StorySettings(workflow: ComfyWorkflow, prompt: string, seconds?: string, aspect = "", megapixels = "", fallbackMegapixels?: number) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // Prompt → the multiline string titled 故事分镜图提示词 (node 283; node 151 links to it).
    if (prompt.trim()) {
        const promptNode =
            next["283"] ||
            findComfyNode(
                next,
                (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string" && /分镜|故事/.test(String(node._meta?.title || "")),
            );
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;
    }

    // Duration (seconds) → PrimitiveFloat "Float (Duration)" (node 143, field "value"). The
    // generic seconds writer only probes fields named duration/seconds/video_length and misses it.
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const durationNode =
            next["143"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /duration|时长/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = duration;
        // The storyboard extractor pulls 6 frames by absolute index ("12, 36, 60, 84, 108, 132"
        // = evenly spaced over 6s*24fps). Recompute for the chosen duration so a shorter video
        // never indexes past the rendered frame count.
        const extractor = next["294"] || findComfyNode(next, (node) => /GetImagesFromBatchIndexed/i.test(String(node.class_type || "")));
        if (extractor?.inputs && typeof extractor.inputs.indexes === "string") {
            const base = Math.max(MINIMAX_H3_STORYBOARD_FRAMES * 2, Math.round(duration * 24));
            const indexes = Array.from({ length: MINIMAX_H3_STORYBOARD_FRAMES }, (_, i) => Math.round(((i + 0.5) * base) / MINIMAX_H3_STORYBOARD_FRAMES));
            extractor.inputs.indexes = indexes.join(", ");
        }
    }

    // Aspect ratio → ResolutionSelector label enum (node 133). The generic writer only accepts a
    // bare "16:9" value and cannot touch the "16:9 (Widescreen)" label format.
    if (aspect) {
        const selector = next["133"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
        if (selector?.inputs && typeof selector.inputs.aspect_ratio === "string") selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
    }

    // Video/frame resolution (megapixels) → ResolutionSelector node 133. The generic tier writer
    // force-maps 1k/2k/4k presets onto this field (and downgrades named aspects to 1), so always
    // write it explicitly here: the user's precision choice wins, otherwise keep the workflow's
    // baked default so the output quality never silently drifts with the aspect/size presets.
    if (typeof megapixels === "string" && megapixels.trim()) {
        const selector = next["133"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "megapixels" in (node.inputs || {}));
        if (selector?.inputs && (typeof selector.inputs.megapixels === "number" || typeof selector.inputs.megapixels === "string")) {
            const requested = Number(megapixels);
            if (Number.isFinite(requested) && requested > 0) selector.inputs.megapixels = requested;
            else if (typeof fallbackMegapixels === "number" && fallbackMegapixels > 0) selector.inputs.megapixels = fallbackMegapixels;
        }
    } else if (typeof fallbackMegapixels === "number" && fallbackMegapixels > 0) {
        const selector = next["133"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "megapixels" in (node.inputs || {}));
        if (selector?.inputs && (typeof selector.inputs.megapixels === "number" || typeof selector.inputs.megapixels === "string")) selector.inputs.megapixels = fallbackMegapixels;
    }

    // The saved workflow bakes a fixed noise_seed — identical inputs would render identical
    // videos on every run. Randomize per submission.
    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") {
            node.inputs.noise_seed = randomComfySeed();
        }
    }
    return next;
}

// Qwen3VL + Next Scene 自动分镜 workflow (RunningHub 2104556548226895873).
// One reference image + one instruction → Qwen3-VL writes six "Next Scene:" prompts → a
// Qwen-Image-Edit batch renders all six storyboard frames in a single run (SaveImage "Batch"), so
// one submission returns several images and the canvas places every frame.
// Its knobs do not match the generic heuristics:
//   - node 366 ("CR Prompt Text") is the instruction slot, and node 364 appends the fixed writing
//     template. The generic prompt writer does reach 366, but it overwrites the whole directive —
//     including the "六段…连续性…按下文模版" contract that makes the batch emit six frames. The scoped
//     writer below keeps that contract and only swaps the subject;
//   - the only reference-image loader is node 342;
//   - the KSampler bakes a fixed seed (214), so every run rendered byte-identical frames.
// Everything below is scoped to this workflow id only.
const QWEN3VL_STORY_WORKFLOW_ID = "2104556548226895873";
const QWEN3VL_STORY_LOAD_IMAGE_ORDER = ["342"];
const QWEN3VL_STORY_PROMPT_NODE = "366";
const QWEN3VL_STORY_SEED_NODE = "218";

/** Wrap a subject back into the workflow author's "六段…连续性…按下文模版" storyboard contract. */
function qwen3VlStoryPrompt(subject: string) {
    const trimmed = subject.replace(/^根据下面的模版生成六段关于连续性的/, "").replace(/的分镜文字\s*$/, "").trim();
    return trimmed ? `根据下面的模版生成六段关于连续性的${trimmed}的分镜文字` : "";
}

function isQwen3VlStoryWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    // The runtime id can arrive channel-encoded ("<channelId>::<model>") or prefixed ("rh-<id>").
    return raw.split("::").some((segment) => segment.trim().replace(/^(rh|runninghub|workflow)[:_-]/, "").trim() === QWEN3VL_STORY_WORKFLOW_ID);
}

/** Public gate for callers outside this module (image/video paths, settings panels). */
export function isQwen3VlStoryWorkflowId(workflowId?: string | null) {
    return isQwen3VlStoryWorkflow(workflowId);
}

function applyQwen3VlStorySettings(workflow: ComfyWorkflow, prompt: string) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // Storyboard instruction → the CR Prompt Text slot (366). Keep the author's six-frame contract
    // and only replace the subject; an empty prompt leaves the saved directive untouched.
    const instruction = qwen3VlStoryPrompt(prompt);
    if (instruction) {
        const node =
            next[QWEN3VL_STORY_PROMPT_NODE] ||
            findComfyNode(next, (item) => /CR\s*PromptText/i.test(String(item.class_type || "")) && typeof item.inputs?.prompt === "string");
        if (node?.inputs && typeof node.inputs.prompt === "string") node.inputs.prompt = instruction;
    }

    // The KSampler bakes a fixed seed — identical inputs would render identical frames on every run.
    const seedNode =
        next[QWEN3VL_STORY_SEED_NODE] ||
        findComfyNode(next, (item) => /^KSampler/i.test(String(item.class_type || "")) && typeof item.inputs?.seed === "number");
    if (seedNode?.inputs && typeof seedNode.inputs.seed === "number") seedNode.inputs.seed = randomComfySeed();

    return next;
}

// MiniMax H3 五段加速流 (参考生视频, 五段 × 二次采样) — RunningHub 2104606149466222593.
// Five MiniMax H3 reference-to-video segments render back to back (a fast pass, then an upscaled
// second pass each) and are stitched into one long clip, so one submission returns one video.
// It is really a five-chapter film: every segment node (734/757/782/806/829, which is also the
// order the stitched clip follows) carries its *own* plot prompt and all five share the same six
// reference images. Its knobs do not match the generic heuristics:
//   - the prompt is per chapter, and the app only asks for one. Segment 1 links a plain `Text` node
//     while the other four hold literal strings, three of them titled 第N段剧情提示词 — which the
//     generic prompt writer scores above the link source, so a naive write leaves chapters 1-2
//     running the workflow author's baked-in demo story while only 3-5 follow the user. A prompt
//     written in the workflow's own screenplay shape is split across the chapters instead (see
//     minimaxH3SegmentPrompts); anything else is written to all five;
//   - references are consumed through the named slots `ref_images.ref_image_0…5` (Picture 1…6) and
//     the slot order is defined by the links, never by node-id order — the graph wires
//     ref_image_0…5 to nodes 51/49/50/43/19/23, so sorting loaders by id scrambles every subject;
//   - `ref_images` is an optional 0..9 socket, so a slot the user did not fill has to be
//     disconnected: leaving it wired renders the author's baked-in demo characters;
//   - per-segment duration is a PrimitiveFloat titled 视频时长（秒）(field `value`), which the
//     generic duration writer (duration/seconds/video_length) cannot reach, and the
//     ResolutionSelector stores a label enum ("16:9 (Widescreen)") the aspect writer cannot produce;
//   - all five RandomNoise nodes ship the same fixed seed, so identical inputs repeated identical
//     videos;
//   - beside the stitched video the graph also saves one video per chapter, and its audio passes
//     through a deprecated SaveAudio class — both make the task report more than the one video the
//     caller wants (and a .flac that has no video extension lands in the image bucket).
// Everything below is scoped to this workflow id only.
const MINIMAX_H3_FIVE_SEGMENT_WORKFLOW_ID = "2104606149466222593";
// MiniMax H3 is trained on ~124-362 frames at 24 fps (≈5.2-15.1 s) and its length formula snaps to
// 17n+5, so keep the per-segment duration inside that band. Note this is the length of *each* of
// the five segments — the finished clip is five times as long.
const MINIMAX_H3_FIVE_SEGMENT_SECONDS = { min: 5, max: 15 };
const AUDIO_FILE_RE = /\.(flac|wav|mp3|m4a|aac|ogg|opus)(\?|$)/i;

function isMinimaxH3FiveSegmentWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    // The runtime id can arrive channel-encoded ("<channelId>::<model>") or prefixed ("rh-<id>") —
    // the same shapes isQwen3VlStoryWorkflow has to accept — so a bare equality check would leave
    // this whole adapter as dead code on those paths.
    return raw.split("::").some((segment) => segment.trim().replace(/^(rh|runninghub|workflow)[:_-]/, "").trim() === MINIMAX_H3_FIVE_SEGMENT_WORKFLOW_ID);
}

function isMiniMaxH3ReferenceNode(node?: ComfyNode | null) {
    return /MiniMaxH3ReferenceToVideo/i.test(String(node?.class_type || ""));
}

/**
 * Every reference-to-video segment plus the reference slots they consume.
 *
 * Consumers come back in node-id order, which is also the chapter order the stitched video follows
 * (734 → 757 → 782 → 806 → 829 render chapters 1..5). Slot 0 is `<Picture 1>`, so the slot indexes —
 * not the node ids — decide which loader holds the user's first image.
 */
function minimaxH3ReferenceSlots(workflow: ComfyWorkflow) {
    const consumers = Object.entries(workflow)
        .filter(([, node]) => isMiniMaxH3ReferenceNode(node))
        .sort(([left], [right]) => Number(left) - Number(right));
    for (const [, consumer] of consumers) {
        const inputs = consumer.inputs || {};
        const slots: Array<{ index: number; key: string; loaderId: string }> = [];
        for (const key of Object.keys(inputs)) {
            const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
            if (!match) continue;
            const value = inputs[key];
            const loaderId = Array.isArray(value) ? String(value[0]) : "";
            const loader = loaderId ? workflow[loaderId] : undefined;
            if (!loader || !imageFieldName(loader)) continue;
            slots.push({ index: Number(match[1]), key, loaderId });
        }
        if (slots.length < 2) continue;
        slots.sort((a, b) => a.index - b.index);
        return { consumers, slots };
    }
    return { consumers, slots: [] as Array<{ index: number; key: string; loaderId: string }> };
}

/**
 * Loaders in `<Picture 1>…<Picture N>` order, or null when the graph does not expose reference
 * slots (caller keeps the historical node-id order).
 */
function minimaxH3FiveSegmentLoaders(workflow: ComfyWorkflow) {
    const { slots } = minimaxH3ReferenceSlots(workflow);
    if (!slots.length) return null;
    return slots
        .map((slot) => [slot.loaderId, workflow[slot.loaderId]] as const)
        .filter((entry): entry is readonly [string, ComfyNode] => Boolean(entry[1]));
}

/**
 * Contiguous, as-even-as-possible shot counts — e.g. 10 shots over 5 chapters → 2,2,2,2,2.
 * Callers guarantee `shots >= chapters`, so no chapter is ever left empty.
 */
function minimaxH3ShotCounts(shots: number, chapters: number) {
    const base = Math.floor(shots / chapters);
    const extra = shots % chapters;
    return Array.from({ length: chapters }, (_, index) => base + (index < extra ? 1 : 0));
}

/**
 * The saved graph is five *sequential chapters* and each segment node carries its own plot prompt —
 * the author's baked-in text is a five-chapter story (each chapter declaring 15s) — while the app
 * only asks the user for one prompt. So a prompt that already follows the workflow's own screenplay
 * shape is distributed one slice per chapter.
 *
 * A slice keeps the shared preamble (subject_definitions / summary / retention_analysis) and the
 * shared tail (overall_soundscape / non_diegetic_music), because every chapter has to redefine the
 * same `<Subject N>` cast it references as `<Picture N>`; only the shot list is split.
 *
 * Returns null when the prompt cannot be split — plain prose, no `detailed_description:` section,
 * or fewer `[Shot N]` blocks than chapters — and the caller then writes the same prompt to every
 * chapter rather than leaving some of them on the author's baked-in demo story.
 *
 * The `detailed_description:` heading is required on purpose: it is what separates the shared
 * preamble from the shot list, and without it a stray `[Shot N]` mention in `summary:` would be
 * mistaken for the first shot and the cast definitions would be dropped from every chapter.
 */
function minimaxH3SegmentPrompts(prompt: string, chapters: number): string[] | null {
    if (chapters < 2) return null;
    const markers = [...prompt.matchAll(/\[Shot\s*\d+\]/g)];
    if (markers.length < chapters) return null;

    const header = /^[ \t]*detailed_description[ \t]*:/im.exec(prompt);
    if (!header) return null;
    const bodyStart = header.index + header[0].length;
    const tailOffset = /^[ \t]*(?:overall_soundscape|non_diegetic_music|non_diegetic|soundscape)[ \t]*:/im.exec(prompt.slice(bodyStart));
    const bodyEnd = tailOffset ? bodyStart + tailOffset.index : prompt.length;

    // Only shots inside the description body count — a `summary:` line also mentions "[Shot 1]".
    const starts = markers.map((marker) => marker.index ?? 0).filter((index) => index >= bodyStart && index < bodyEnd);
    if (starts.length < chapters) return null;

    const preamble = (prompt.slice(0, header.index) + header[0]).trimEnd();
    const tail = prompt.slice(bodyEnd).trim();

    const out: string[] = [];
    let cursor = 0;
    for (const count of minimaxH3ShotCounts(starts.length, chapters)) {
        const from = starts[cursor];
        const to = cursor + count < starts.length ? starts[cursor + count] : bodyEnd;
        out.push([preamble, prompt.slice(from, to).trim(), tail].filter(Boolean).join("\n"));
        cursor += count;
    }
    return out;
}

/**
 * The stitched video is the one the caller wants, and its combiner is the only one fed by a batch
 * node — the per-segment combiners all consume a single VAE decode. Returns the stitched combiner's
 * `filename_prefix`, used to recognise it in the task results.
 */
function minimaxH3StitchedVideoPrefix(workflow: ComfyWorkflow | null) {
    if (!workflow) return "";
    const batched = new Set(
        Object.entries(workflow)
            .filter(([, node]) => /batch/i.test(String(node?.class_type || "")))
            .map(([id]) => id),
    );
    if (!batched.size) return "";
    for (const node of Object.values(workflow)) {
        if (!/VHS_VideoCombine/i.test(String(node?.class_type || ""))) continue;
        const images = node?.inputs?.images;
        if (!Array.isArray(images) || !batched.has(String(images[0]))) continue;
        const prefix = node?.inputs?.filename_prefix;
        if (typeof prefix === "string" && prefix.trim()) return prefix.trim();
    }
    return "";
}

/** Consumed by any other node? Used to tell a redundant output node from a wired one. */
function comfyConsumedIds(workflow: ComfyWorkflow) {
    const consumed = new Set<string>();
    for (const node of Object.values(workflow)) {
        for (const value of Object.values(node?.inputs || {})) {
            if (Array.isArray(value) && value[0] != null) consumed.add(String(value[0]));
        }
    }
    return consumed;
}

/**
 * Keep a single video output. Drops the per-segment VHS_VideoCombine nodes (the stitched combiner
 * stays), and muxes the segment-stitched audio straight into the final combiner instead of routing
 * it through the deprecated SaveAudio pass-through — the pass-through hands back the very bytes it
 * was given, so the audio is identical while the graph stops emitting a stray .flac (and stops
 * depending on a node class ComfyUI only keeps around for backwards compatibility).
 */
function pruneMinimaxH3FiveSegmentOutputs(workflow: ComfyWorkflow) {
    let changed = false;

    const finalCombiner = Object.values(workflow).find((node) => {
        if (!/VHS_VideoCombine/i.test(String(node?.class_type || ""))) return false;
        const images = node?.inputs?.images;
        const source = Array.isArray(images) ? workflow[String(images[0])] : undefined;
        return /batch/i.test(String(source?.class_type || ""));
    });
    if (finalCombiner?.inputs) {
        const audio = finalCombiner.inputs.audio;
        const passThrough = Array.isArray(audio) ? workflow[String(audio[0])] : undefined;
        if (/^SaveAudio/i.test(String(passThrough?.class_type || ""))) {
            const upstream = passThrough?.inputs?.audio;
            if (Array.isArray(upstream) && workflow[String(upstream[0])]) {
                finalCombiner.inputs.audio = upstream;
                changed = true;
            }
        }
    }

    // Reachability has to be sampled *after* the rewire above: the SaveAudio node we just bypassed
    // has no consumer left, and computing this first would keep it alive as if it were still wired.
    const consumed = comfyConsumedIds(workflow);

    // Only drop output nodes nothing consumes, so the render itself can never be cut short.
    for (const [id, node] of Object.entries(workflow)) {
        if (consumed.has(id)) continue;
        if (/^SaveAudio/i.test(String(node?.class_type || ""))) {
            delete workflow[id];
            changed = true;
            continue;
        }
        if (!/VHS_VideoCombine/i.test(String(node?.class_type || ""))) continue;
        const images = node?.inputs?.images;
        const source = Array.isArray(images) ? workflow[String(images[0])] : undefined;
        if (/batch/i.test(String(source?.class_type || ""))) continue;
        delete workflow[id];
        changed = true;
    }
    return changed;
}

function applyMinimaxH3FiveSegmentSettings(workflow: ComfyWorkflow, prompt: string, imageValues: string[], seconds?: string, aspect = "", megapixels = "") {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // Segments in chapter order (734 → 757 → 782 → 806 → 829) plus the reference slots they consume.
    const { consumers, slots } = minimaxH3ReferenceSlots(next);

    // Prompt → every chapter. A prompt that carries the workflow's own shot structure is split one
    // slice per chapter; anything else goes to all of them — either way no chapter keeps the author's
    // baked-in demo story. A chapter holding a literal string is written directly; one that links a
    // prompt node writes through to that node, so a link is never turned into a literal.
    if (prompt.trim()) {
        const perChapter = minimaxH3SegmentPrompts(prompt, consumers.length);
        consumers.forEach(([, node], index) => {
            const text = perChapter?.[index] || prompt;
            if (!node.inputs) return;
            const current = node.inputs.prompt;
            if (typeof current === "string") {
                node.inputs.prompt = text;
                return;
            }
            const source = linkedNode(next, current);
            if (source?.inputs && typeof source.inputs.text === "string") source.inputs.text = text;
            else if (source?.inputs && typeof source.inputs.value === "string") source.inputs.value = text;
        });
    }

    // Reference images → `<Picture 1>…` slot order. A slot the user did not fill is disconnected on
    // every chapter, so the workflow author's baked-in demo characters never reach the render.
    slots.forEach((slot, index) => {
        const loader = next[slot.loaderId];
        const field = loader ? imageFieldName(loader) : "";
        const value = imageValues[index];
        if (value && field && loader?.inputs) {
            loader.inputs[field] = value;
            return;
        }
        for (const [, consumer] of consumers) {
            if (!consumer.inputs || !(slot.key in consumer.inputs)) continue;
            delete consumer.inputs[slot.key];
            structuralRepair = true;
        }
    });

    // Duration (seconds) → PrimitiveFloat "视频时长（秒）" (node 259, field `value`); node 250 turns it
    // into the segment frame count (24 fps snapped to 17n+5). Keep it inside the trained band.
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_FIVE_SEGMENT_SECONDS.max, Math.max(MINIMAX_H3_FIVE_SEGMENT_SECONDS.min, duration));
        const durationNode =
            next["259"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // Aspect + precision → ResolutionSelector (node 252). The generic size writer only understands a
    // bare "16:9" value and cannot reach the "16:9 (Widescreen)" label this workflow stores.
    const selector =
        next["252"] ||
        findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        const requested = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(requested) && requested > 0 && typeof selector.inputs.megapixels === "number") {
            selector.inputs.megapixels = requested;
        }
    }

    // The graph bakes one fixed seed across all five noise nodes — identical inputs would render
    // identical videos on every run. Randomize per submission.
    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") {
            node.inputs.noise_seed = randomComfySeed();
        }
    }

    if (pruneMinimaxH3FiveSegmentOutputs(next)) structuralRepair = true;
    return { workflow: next, structuralRepair };
}

/**
 * The task reports one video per segment next to the stitched one, plus the audio save node's
 * .flac (no video extension, so it lands in the image bucket). Put the stitched video first — its
 * filename carries the final combiner's prefix — and drop the stray audio.
 * Exported alongside buildWorkflowPatch so the selection can be exercised headlessly.
 */
export function normalizeMinimaxH3FiveSegmentResult(result: RunningHubMedia, workflow: ComfyWorkflow | null): RunningHubMedia {
    const images = result.images.filter((url) => !AUDIO_FILE_RE.test(url));
    const videos = result.videos.filter((url) => !AUDIO_FILE_RE.test(url));
    if (videos.length < 2) return { images, videos };
    const prefix = minimaxH3StitchedVideoPrefix(workflow);
    if (prefix) {
        const stitched = videos.filter((url) => url.includes(prefix) || decodeURIComponent(url).includes(prefix));
        if (stitched.length) return { images, videos: [...stitched, ...videos.filter((url) => !stitched.includes(url))] };
    }
    // Every segment finishes before the stitched video (it depends on all of them), so the last
    // result is the one the caller wants.
    return { images, videos: [videos[videos.length - 1], ...videos.slice(0, -1)] };
}

/**
 * A RunningHub model name doubles as its workflow id, so one model normally runs one workflow.
 * The 自动分镜 model is the exception: its workflow renders images only, so generating video from
 * the same model entry has to switch to a dedicated video-generation workflow. Point that model's
 * script at the video workflow (`{"workflowId": "2103..."}` or a bare id) and the video path uses
 * it, while the image path keeps the model's own id. Scoped to this workflow id — every other
 * model keeps the previous order, where the model name always wins over the script.
 */
function switchRunningHubWorkflowForMedia(workflowId: string, media: "image" | "video" | undefined, script?: string) {
    if (media !== "video" || !isQwen3VlStoryWorkflow(workflowId)) return workflowId;
    const explicit = idFromScript(String(script || ""));
    return explicit && explicit !== workflowId ? explicit : workflowId;
}

async function fetchWebappNodes(origin: string, apiKey: string, webappId: string, signal?: AbortSignal): Promise<WebappNode[]> {
    const token = apiKey.replace(/^Bearer\s+/i, "").trim();
    const response = await axios.get(proxyApiUrl(`${origin}/api/webapp/apiCallDemo`), {
        params: { apiKey: token, webappId },
        headers: bearer(apiKey),
        signal,
        timeout: 60_000,
    });
    assertOk(response.data, apiText("runningHubWorkflowFetchFailed"));
    const list = asRecord(asRecord(response.data)?.data)?.nodeInfoList;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
        const record = asRecord(item);
        if (!record || (typeof record.nodeId !== "string" && typeof record.nodeId !== "number") || typeof record.fieldName !== "string") return [];
        return [
            {
                nodeId: String(record.nodeId),
                fieldName: record.fieldName,
                fieldValue: record.fieldValue == null ? "" : String(record.fieldValue),
                fieldType: typeof record.fieldType === "string" ? record.fieldType : "",
                nodeName: typeof record.nodeName === "string" ? record.nodeName : "",
                description: typeof record.description === "string" ? record.description : "",
            },
        ];
    });
}

function buildWebappNodeInfoList(nodes: WebappNode[], prompt: string, imageValues: string[], size = "", seconds = "", media: "image" | "video" = "image") {
    const list = nodes.map((node) => ({ nodeId: node.nodeId, fieldName: node.fieldName, fieldValue: node.fieldValue }));
    const setField = (node: WebappNode, value: string) => {
        const item = list.find((entry) => entry.nodeId === node.nodeId && entry.fieldName === node.fieldName);
        if (item) item.fieldValue = value;
    };
    if (prompt.trim()) {
        const textNodes = nodes.filter((node) => /STRING|TEXT/i.test(node.fieldType || "") || /^(text|prompt|string|caption|positive)$/i.test(node.fieldName));
        const positive = textNodes.filter((node) => !/negative|负面/i.test(`${node.fieldName} ${node.nodeName || ""} ${node.description || ""}`));
        const target = positive[0] || textNodes[0];
        if (target) setField(target, prompt);
    }
    const pixels = resolveCanvasPixels(size, media);
    const aspect = canvasAspect(size);
    if (pixels) {
        for (const node of nodes) {
            if (/^width$/i.test(node.fieldName)) setField(node, String(pixels.width));
            else if (/^height$/i.test(node.fieldName)) setField(node, String(pixels.height));
            else if (/aspect/i.test(node.fieldName) && aspect && /^\d+\s*:\s*\d+$/.test(node.fieldValue.trim())) setField(node, aspect);
            else if (/^(resolution|size|image_size)$/i.test(node.fieldName) && /^\d+\s*[x×]\s*\d+$/i.test(node.fieldValue.trim())) setField(node, `${pixels.width}x${pixels.height}`);
        }
    }
    const tier = media === "video" ? null : canvasResolutionTier(size);
    if (tier) {
        for (const node of nodes) {
            const named = /resolution|megapixel|^res$/i.test(node.fieldName) || /分辨率|清晰度/i.test(`${node.nodeName || ""} ${node.description || ""}`);
            const nextValue = resolutionTierValue(node.fieldValue, tier, named);
            if (nextValue) setField(node, nextValue);
        }
    }
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        for (const node of nodes) {
            if (/^(duration|seconds|video_length)$/i.test(node.fieldName)) setField(node, String(duration));
        }
    }
    const imageNodes = nodes.filter((node) => /IMAGE/i.test(node.fieldType || "") || /^image$/i.test(node.fieldName));
    imageValues.forEach((value, index) => {
        const node = imageNodes[index];
        if (!node || !value) return;
        setField(node, value);
    });
    return list;
}

function imageFieldName(node: ComfyNode) {
    const inputs = node.inputs || {};
    if (Array.isArray(inputs.image) || Array.isArray(inputs.url)) return "";
    if ("image" in inputs && !Array.isArray(inputs.image)) return "image";
    if ("url" in inputs && !Array.isArray(inputs.url)) return "url";
    if ("image_path" in inputs && !Array.isArray(inputs.image_path)) return "image_path";
    return "";
}

export type RunningHubNodeInfo = { nodeId: string; fieldName: string; fieldValue: string };

export type RunningHubWorkflowPatch = {
    /** Scalar overrides applied through the normal `nodeInfoList` body field. */
    nodeInfoList: RunningHubNodeInfo[];
    /**
     * Present only when the graph had to be structurally repaired (a reference image needed a link
     * that does not exist in the saved workflow). nodeInfoList cannot create links, so this graph
     * must additionally be submitted through the `workflow` body field.
     */
    graph?: ComfyWorkflow;
};

// Exported for the workflow-diagnostics path and tests: the transformation is the risky part, so it
// is exercised directly instead of only through a live task submission.
export function buildWorkflowPatch(workflow: ComfyWorkflow, prompt: string, imageValues: string[], size?: { width: number; height: number } | null, seconds?: string, aspect = "", rawSize = "", workflowId?: string, megapixels = ""): RunningHubWorkflowPatch {
    let patched = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    if (prompt.trim()) patched = writeRunningHubPrompt(patched, prompt);
    if (size) patched = writeRunningHubSize(patched, size.width, size.height, aspect);
    const tier = canvasResolutionTier(rawSize);
    if (tier) patched = writeRunningHubTier(patched, tier);
    if (seconds?.trim()) patched = writeRunningHubSeconds(patched, seconds.trim());
    let structuralRepair = false;
    if (isQwenImage21Workflow(workflowId)) patched = applyQwenImage21Settings(patched, imageValues, size, aspect, rawSize, workflowId);
    if (isQwenImage21DualWorkflow(workflowId)) {
        const dual = applyQwenImage21DualSettings(patched, workflow, prompt, imageValues, size, aspect, rawSize);
        patched = dual.workflow;
        structuralRepair = dual.rewired;
    }
    if (isMinimaxH3StoryWorkflow(workflowId)) {
        // Pristine (pre-tier) megapixels become the fallback so an unset precision keeps the
        // workflow's own default instead of the tier writer's 1k downgrade.
        const pristineSelector = workflow["133"] || findComfyNode(workflow, (node) => node.class_type === "ResolutionSelector" && "megapixels" in (node.inputs || {}));
        const fallbackMegapixels = typeof pristineSelector?.inputs?.megapixels === "number" ? pristineSelector.inputs.megapixels : undefined;
        patched = applyMinimaxH3StorySettings(patched, prompt, seconds, aspect, megapixels, fallbackMegapixels);
    }
    // Runs after the generic prompt writer so the storyboard contract wins over it.
    if (isQwen3VlStoryWorkflow(workflowId)) patched = applyQwen3VlStorySettings(patched, prompt);
    if (isMinimaxH3FiveSegmentWorkflow(workflowId)) {
        const fiveSegment = applyMinimaxH3FiveSegmentSettings(patched, prompt, imageValues, seconds, aspect, megapixels);
        patched = fiveSegment.workflow;
        if (fiveSegment.structuralRepair) structuralRepair = true;
    }
    const list: RunningHubNodeInfo[] = [];
    for (const [nodeId, node] of Object.entries(patched)) {
        const before = workflow[nodeId]?.inputs || {};
        const after = node.inputs || {};
        for (const [fieldName, value] of Object.entries(after)) {
            if (Array.isArray(before[fieldName]) || Array.isArray(value)) continue;
            if (before[fieldName] === value) continue;
            if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
            list.push({ nodeId, fieldName, fieldValue: String(value) });
        }
    }
    // The 图生图 workflow already wires uploaded references (and clears baked-in ones) inside
    // applyQwenImage21Settings, so skip the generic mapping for it. The Qwen Image 2.1 dual
    // (文生/编辑) pair does the same inside applyQwenImage21DualSettings. Other Qwen workflows keep
    // the hard-coded loader order; everything else uses the class_type scan.
    const fiveSegmentLoaders = isMinimaxH3FiveSegmentWorkflow(workflowId) ? minimaxH3FiveSegmentLoaders(workflow) : null;
    const loaders =
        fiveSegmentLoaders ||
        (isQwenImage21I2IWorkflow(workflowId) || isQwenImage21DualWorkflow(workflowId)
            ? []
            : isQwenImage21Workflow(workflowId)
              ? QWEN_IMAGE_21_LOAD_IMAGE_ORDER.map((nodeId) => [nodeId, workflow[nodeId]] as const).filter((entry): entry is readonly [string, ComfyNode] => Boolean(entry[1]))
              : isMinimaxH3StoryWorkflow(workflowId)
                ? MINIMAX_H3_STORY_LOAD_IMAGE_ORDER.map((nodeId) => [nodeId, workflow[nodeId]] as const).filter((entry): entry is readonly [string, ComfyNode] => Boolean(entry[1]))
                : isQwen3VlStoryWorkflow(workflowId)
                  ? QWEN3VL_STORY_LOAD_IMAGE_ORDER.map((nodeId) => [nodeId, workflow[nodeId]] as const).filter((entry): entry is readonly [string, ComfyNode] => Boolean(entry[1]))
                  : Object.entries(workflow).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || ""))));
    imageValues.forEach((value, index) => {
        const entry = loaders[index];
        if (!entry || !value) return;
        const fieldName = imageFieldName(entry[1]);
        if (!fieldName) return;
        const existing = list.find((item) => item.nodeId === entry[0] && item.fieldName === fieldName);
        if (existing) existing.fieldValue = value;
        else list.push({ nodeId: entry[0], fieldName, fieldValue: value });
    });
    return structuralRepair ? { nodeInfoList: list, graph: patched } : { nodeInfoList: list };
}

const CANVAS_IMAGE_SIZES: Record<string, { width: number; height: number }> = {
    "1:1": { width: 1024, height: 1024 },
    "3:2": { width: 1536, height: 1024 },
    "2:3": { width: 1024, height: 1536 },
    "4:3": { width: 1360, height: 1024 },
    "3:4": { width: 1024, height: 1360 },
    "16:9": { width: 1824, height: 1024 },
    "9:16": { width: 1024, height: 1824 },
    "2048x2048": { width: 2048, height: 2048 },
    "2048x1152": { width: 2048, height: 1152 },
    "1152x2048": { width: 1152, height: 2048 },
    "3840x2160": { width: 3840, height: 2160 },
    "2160x3840": { width: 2160, height: 3840 },
};

const CANVAS_VIDEO_SIZES: Record<string, { width: number; height: number }> = {
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
    "1:1": { width: 1024, height: 1024 },
    "21:9": { width: 1792, height: 768 },
    "3:4": { width: 768, height: 1024 },
};

type ResolutionTier = "1k" | "2k" | "4k";

const TIER_LONG_SIDE: Record<ResolutionTier, number> = { "1k": 1024, "2k": 2048, "4k": 3840 };

function canvasResolutionTier(size: string): ResolutionTier | null {
    const value = String(size || "").trim().toLowerCase();
    if (!value || value === "auto") return null;
    if (value.includes("4k") || value === "3840x2160" || value === "2160x3840") return "4k";
    if (value.includes("2k") || value === "2048x2048" || value === "2048x1152" || value === "1152x2048") return "2k";
    const pixels = value.match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (pixels) {
        const longSide = Math.max(Number(pixels[1]), Number(pixels[2]));
        if (longSide >= 3000) return "4k";
        if (longSide >= 1920) return "2k";
        return "1k";
    }
    if (/^\d+\s*:\s*\d+/.test(value) || CANVAS_IMAGE_SIZES[value]) return "1k";
    return null;
}

function aspectRatioOf(size: string) {
    const named = String(size || "").trim().match(/^(\d+)\s*:\s*(\d+)/);
    if (named) return { width: Number(named[1]), height: Number(named[2]) };
    const known = CANVAS_IMAGE_SIZES[size];
    if (known?.width && known.height) return known;
    const pixels = String(size || "").trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!pixels) return null;
    return { width: Number(pixels[1]), height: Number(pixels[2]) };
}

function snap8(value: number) {
    return Math.max(64, Math.round(value / 8) * 8);
}

function pixelsForTier(widthRatio: number, heightRatio: number, tier: ResolutionTier) {
    const longSide = TIER_LONG_SIDE[tier];
    if (!widthRatio || !heightRatio) return { width: longSide, height: longSide };
    if (widthRatio >= heightRatio) return { width: longSide, height: snap8((longSide * heightRatio) / widthRatio) };
    return { width: snap8((longSide * widthRatio) / heightRatio), height: longSide };
}

function resolutionTierValue(current: string, tier: ResolutionTier, named: boolean) {
    const value = current.trim();
    if (!value || value.length > 16) return "";
    if (/match_input|auto|original/i.test(value)) return "";
    if (/^\d+\s*:\s*\d+$/.test(value)) return "";
    const token = value.match(/^(1|2|4)\s*([kK])$/);
    if (token) return `${tier[0]}${token[2]}`;
    if (!named) return "";
    if (/^(1024|2048|4096|3840)$/.test(value)) return tier === "4k" ? "3840" : tier === "2k" ? "2048" : "1024";
    if (/^(1|2|4)$/.test(value)) return tier === "4k" ? "4" : tier === "2k" ? "2" : "1";
    return "";
}

function writeRunningHubTier(workflow: ComfyWorkflow, tier: ResolutionTier) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    for (const node of Object.values(next)) {
        const inputs = node.inputs || {};
        const title = `${node.class_type || ""} ${node._meta?.title || ""}`;
        for (const [field, current] of Object.entries(inputs)) {
            if (Array.isArray(current)) continue;
            const named = /resolution|megapixel|mega_pixels|^res$/i.test(field) || (/分辨率|清晰度|resolution/i.test(title) && /^(value|string|size|resolution|res)$/i.test(field));
            if (typeof current === "string") {
                const nextValue = resolutionTierValue(current, tier, named);
                if (nextValue) inputs[field] = nextValue;
            } else if (typeof current === "number" && /megapixel/i.test(field) && [1, 2, 4].includes(current)) {
                inputs[field] = tier === "4k" ? 4 : tier === "2k" ? 2 : 1;
            }
        }
    }
    return next;
}

function resolveCanvasPixels(size: string, media: "image" | "video" = "image") {
    const value = String(size || "").trim();
    if (!value || /^auto$/i.test(value)) return null;
    if (media === "video" && CANVAS_VIDEO_SIZES[value]) return CANVAS_VIDEO_SIZES[value];
    if (media === "image") {
        const tier = canvasResolutionTier(value);
        const ratio = aspectRatioOf(value);
        if (tier && ratio) return pixelsForTier(ratio.width, ratio.height, tier);
    }
    if (CANVAS_IMAGE_SIZES[value]) return CANVAS_IMAGE_SIZES[value];
    const pixels = value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (pixels) return { width: Number(pixels[1]), height: Number(pixels[2]) };
    const ratio = value.match(/^(\d+)\s*:\s*(\d+)/);
    if (!ratio) return null;
    const widthRatio = Number(ratio[1]);
    const heightRatio = Number(ratio[2]);
    if (!widthRatio || !heightRatio) return null;
    const longSide = media === "video" ? 1280 : 1024;
    if (widthRatio >= heightRatio) return { width: longSide, height: Math.max(64, Math.round((longSide * heightRatio) / widthRatio / 8) * 8) };
    return { width: Math.max(64, Math.round((longSide * widthRatio) / heightRatio / 8) * 8), height: longSide };
}

const ASPECT_RATIOS: Array<[string, number]> = [
    ["1:1", 1],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["21:9", 21 / 9],
];

function canvasAspect(size: string) {
    const named = String(size || "").trim().match(/^(\d+)\s*:\s*(\d+)/);
    if (named) return `${named[1]}:${named[2]}`;
    const pixels = resolveCanvasPixels(size);
    if (!pixels?.width || !pixels.height) return "";
    const ratio = pixels.width / pixels.height;
    let best = ASPECT_RATIOS[0];
    let bestDiff = Infinity;
    for (const item of ASPECT_RATIOS) {
        const diff = Math.abs(ratio - item[1]);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = item;
        }
    }
    return bestDiff < 0.04 ? best[0] : "";
}

const PROMPT_FIELDS = ["text", "prompt", "string", "value", "caption", "positive", "positive_prompt", "text_g", "text_l", "clip_l", "t5xxl"];

function isNegativeNode(node: ComfyNode, field = "") {
    return /negative|负面|\bneg\b/i.test(`${field} ${node._meta?.title || ""} ${node.class_type || ""}`);
}

function promptScore(node: ComfyNode) {
    if (isNegativeNode(node)) return -1;
    const title = String(node._meta?.title || "");
    const type = String(node.class_type || "");
    if (/positive|正面|提示词|\bprompt\b/i.test(title)) return 40;
    if (/CLIPTextEncode|TextEncode/i.test(type)) return 30;
    if (/Prompt|CR Text|PrimitiveString|StringConstant|Wildcard/i.test(type)) return 20;
    if (PROMPT_FIELDS.some((field) => typeof node.inputs?.[field] === "string" && !isNegativeNode(node, field))) return 10;
    return 0;
}

function writeRunningHubPrompt(workflow: ComfyWorkflow, prompt: string) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    const scored = Object.values(next)
        .map((node) => ({ node, score: promptScore(node) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score || 0;
    const chosen = best >= 40 ? scored.filter((item) => item.score === best) : scored.slice(0, 1);
    let wrote = false;
    for (const item of chosen) {
        if (writePromptFields(next, item.node, prompt, 0)) wrote = true;
    }
    return wrote ? next : applyComfyPrompt(next, prompt);
}

function writePromptFields(workflow: ComfyWorkflow, node: ComfyNode, prompt: string, depth: number): boolean {
    if (!node.inputs || depth > 2) return false;
    for (const field of PROMPT_FIELDS) {
        if (!(field in node.inputs) || isNegativeNode(node, field)) continue;
        const value = node.inputs[field];
        if (typeof value === "string") {
            node.inputs[field] = prompt;
            return true;
        }
        const source = linkedNode(workflow, value);
        if (source && writePromptFields(workflow, source, prompt, depth + 1)) return true;
    }
    return false;
}

function linkedNode(workflow: ComfyWorkflow, value: unknown) {
    if (!Array.isArray(value) || value[0] == null) return null;
    return workflow[String(value[0])] || null;
}

function writeScalar(inputs: Record<string, unknown>, field: string, nextValue: number) {
    const current = inputs[field];
    if (typeof current === "number") {
        inputs[field] = nextValue;
        return true;
    }
    if (typeof current === "string" && /^-?\d+(\.\d+)?$/.test(current.trim())) {
        inputs[field] = String(nextValue);
        return true;
    }
    return false;
}

function writeSizeInput(workflow: ComfyWorkflow, node: ComfyNode, field: string, nextValue: number) {
    const inputs = node.inputs || {};
    if (writeScalar(inputs, field, nextValue)) return true;
    const source = linkedNode(workflow, inputs[field]);
    if (!source?.inputs) return false;
    for (const key of ["value", "int", "number", "Number"]) {
        if (writeScalar(source.inputs, key, nextValue)) return true;
    }
    return false;
}

function writeRunningHubSize(workflow: ComfyWorkflow, width: number, height: number, aspect = "") {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    const nodes = Object.values(next);
    for (const node of nodes) {
        const inputs = node.inputs || {};
        if ("width" in inputs && "height" in inputs) {
            writeSizeInput(next, node, "width", width);
            writeSizeInput(next, node, "height", height);
        }
        if (aspect && typeof inputs.aspect_ratio === "string" && /^\d+\s*:\s*\d+$/.test(inputs.aspect_ratio.trim())) inputs.aspect_ratio = aspect;
        for (const field of ["resolution", "size", "image_size"]) {
            const current = inputs[field];
            if (typeof current === "string" && /^\d+\s*[x×]\s*\d+$/i.test(current.trim())) inputs[field] = `${width}x${height}`;
        }
    }
    return next;
}

function writeRunningHubSeconds(workflow: ComfyWorkflow, seconds: string) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    const numeric = Number(seconds);
    if (!Number.isFinite(numeric) || numeric <= 0) return next;
    for (const node of Object.values(next)) {
        const inputs = node.inputs || {};
        for (const field of ["duration", "seconds", "video_length"]) {
            writeScalar(inputs, field, numeric);
        }
        const length = inputs.length;
        if (typeof length === "number" && length > 0 && length <= 30) inputs.length = numeric;
        else if (typeof length === "string" && /^\d+(\.\d+)?$/.test(length.trim()) && Number(length) <= 30) inputs.length = String(numeric);
    }
    return next;
}

async function uploadImage(origin: string, apiKey: string, source: string, fileName: string, signal?: AbortSignal) {
    let file: File;
    if (source.startsWith("data:")) {
        file = dataUrlToFile({ id: fileName, name: fileName, dataUrl: source, type: "image/png" });
    } else if (/^https?:\/\//i.test(source)) {
        return source;
    } else {
        throw new Error(apiText("referenceImageReadFailed"));
    }
    const body = new FormData();
    body.append("apiKey", apiKey.replace(/^Bearer\s+/i, "").trim());
    body.append("fileType", "input");
    body.append("file", file);
    const response = await axios.post(proxyApiUrl(`${origin}/task/openapi/upload`), body, {
        signal,
        timeout: 120_000,
    });
    assertOk(response.data, apiText("requestFailed"));
    const data = asRecord(asRecord(response.data)?.data) || asRecord(response.data);
    const name = data?.fileName || data?.filename;
    if (typeof name !== "string" || !name) throw new Error(readMessage(response.data) || apiText("requestFailed"));
    return name;
}

async function submitWorkflowTask(origin: string, apiKey: string, workflowId: string, nodeInfoList: RunningHubNodeInfo[], graph?: ComfyWorkflow, signal?: AbortSignal) {
    const token = apiKey.replace(/^Bearer\s+/i, "").trim();
    const body: Record<string, unknown> = { apiKey: token, workflowId, addMetadata: true };
    if (nodeInfoList.length) body.nodeInfoList = nodeInfoList;
    // `workflow` runs the graph we send instead of the one saved under workflowId. It is the only way
    // to add a link (nodeInfoList overrides scalar inputs only), which is what a reference image
    // needs in order to reach the sampler. workflowId stays in the body, so a backend that ignores
    // the field simply falls back to the previous behaviour rather than failing.
    if (graph) body.workflow = JSON.stringify(graph);
    const response = await axios.post(proxyApiUrl(`${origin}/task/openapi/create`), body, {
        headers: bearer(apiKey),
        signal,
        timeout: 60_000,
    });
    assertOk(response.data, apiText("runningHubNoTaskId"));
    const problem = readPromptProblems(response.data);
    if (problem) throw new Error(problem);
    const created = readTaskFromCreate(response.data);
    if (!created?.taskId) throw new Error(readMessage(response.data) || apiText("runningHubNoTaskId"));
    return created;
}

async function submitWebappTask(origin: string, apiKey: string, webappId: string, nodeInfoList: ReturnType<typeof buildWebappNodeInfoList>, signal?: AbortSignal) {
    const token = apiKey.replace(/^Bearer\s+/i, "").trim();
    const response = await axios.post(
        proxyApiUrl(`${origin}/task/openapi/ai-app/run`),
        { apiKey: token, webappId, nodeInfoList },
        { headers: bearer(apiKey), signal, timeout: 60_000 },
    );
    assertOk(response.data, apiText("runningHubNoTaskId"));
    const created = readTaskFromCreate(response.data);
    if (!created?.taskId) throw new Error(readMessage(response.data) || apiText("runningHubNoTaskId"));
    return created;
}

function readPromptProblems(payload: unknown) {
    const root = asRecord(payload);
    const data = asRecord(root?.data) || root;
    const raw = data?.promptTips;
    let tips = asRecord(raw);
    if (typeof raw === "string") {
        try {
            tips = asRecord(JSON.parse(raw));
        } catch {
            tips = null;
        }
    }
    const nodeErrors = asRecord(tips?.node_errors);
    if (!nodeErrors) return "";
    const lines = Object.entries(nodeErrors)
        .filter(([, value]) => value && (typeof value !== "object" || Object.keys(value as object).length > 0))
        .map(([nodeId, value]) => `${nodeId}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    return lines.join("\n");
}

function readFailedReason(payload: unknown) {
    const root = asRecord(payload);
    const data = asRecord(root?.data);
    const reason = asRecord(data?.failedReason) || asRecord(root?.failedReason);
    if (!reason) return "";
    const nodeName = typeof reason.node_name === "string" ? reason.node_name : "";
    const message = [reason.exception_message, reason.exceptionMessage, reason.message].find((item) => typeof item === "string" && item.trim());
    return [nodeName, typeof message === "string" ? message.trim() : ""].filter(Boolean).join(": ");
}

function readTaskFromCreate(payload: unknown): RunningHubTaskView | null {
    const direct = readRunningHubTask(payload);
    if (direct) return direct;
    const root = asRecord(payload);
    const data = asRecord(root?.data) || root;
    const taskId = typeof data?.taskId === "string" ? data.taskId : typeof data?.task_id === "string" ? data.task_id : "";
    if (!taskId) return null;
    return {
        taskId,
        status: String(data?.status || data?.taskStatus || "QUEUED"),
        images: [],
        videos: [],
        errorMessage: "",
    };
}

/**
 * Official task status endpoint (POST /task/openapi/status → data.taskStatus:
 * QUEUED / RUNNING / SUCCESS / FAILED / CANCELED). The outputs endpoint alone keeps answering
 * "still queued/running" (804/813) for failed or cancelled tasks, which previously dead-locked
 * the poller into the full 20-minute timeout. Status errors never kill polling — they only
 * surface when they reveal a terminal state.
 */
async function fetchTaskStatus(args: { origin: string; token: string; taskId: string; apiKey: string; signal?: AbortSignal }) {
    const response = await axios.post(
        proxyApiUrl(`${args.origin}/task/openapi/status`),
        { apiKey: args.token, taskId: args.taskId },
        { headers: bearer(args.apiKey), signal: args.signal, timeout: 30_000 },
    );
    const record = asRecord(response.data);
    const code = typeof record?.code === "number" ? record.code : typeof record?.code === "string" && /^\d+$/.test(record.code) ? Number(record.code) : null;
    if (code !== null && code !== 0 && code !== 200) return null;
    const data = asRecord(record?.data);
    return {
        status: String(data?.taskStatus || data?.status || record?.taskStatus || "").trim(),
        payload: response.data,
    };
}

async function pollTaskOutputs(args: { origin: string; apiKey: string; taskId: string; signal?: AbortSignal }): Promise<RunningHubTaskView> {
    const deadline = performance.now() + POLL_TIMEOUT_MS;
    const token = args.apiKey.replace(/^Bearer\s+/i, "").trim();
    let completedRounds = 0;
    while (performance.now() < deadline) {
        if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await axios.post(proxyApiUrl(`${args.origin}/task/openapi/outputs`), { apiKey: token, taskId: args.taskId }, {
            headers: bearer(args.apiKey),
            signal: args.signal,
            timeout: 30_000,
        });
        const record = asRecord(response.data);
        const code = typeof record?.code === "number" ? record.code : typeof record?.code === "string" && /^\d+$/.test(record.code) ? Number(record.code) : null;
        if (code === 804 || code === 813) {
            const statusInfo = await fetchTaskStatus({ origin: args.origin, token, taskId: args.taskId, apiKey: args.apiKey, signal: args.signal }).catch(() => null);
            if (statusInfo && statusInfo.status && isFailedStatus(statusInfo.status)) {
                throw new Error(readFailedReason(statusInfo.payload) || readMessage(statusInfo.payload) || apiText("runningHubTaskFailed"));
            }
            if (statusInfo && statusInfo.status && isDoneStatus(statusInfo.status)) {
                // Task finished server-side but outputs has not surfaced the files yet —
                // grace-limit the remaining wait instead of burning the full timeout.
                completedRounds += 1;
                if (completedRounds > 10) break;
            }
            await sleep(POLL_INTERVAL_MS, args.signal);
            continue;
        }
        if (code === 805) {
            throw new Error(readFailedReason(response.data) || readMessage(response.data) || apiText("runningHubTaskFailed"));
        }
        if (code === 0) {
            const media = collectResultMedia(Array.isArray(record?.data) ? record.data : asRecord(record?.data)?.results);
            if (media.images.length || media.videos.length) {
                return { taskId: args.taskId, status: "SUCCESS", images: media.images, videos: media.videos, errorMessage: "" };
            }
        }
        if (code !== null && code !== 0) {
            const message = readFailedReason(response.data) || readMessage(response.data);
            if (isUnknownServerError(message)) throw new Error(apiText("runningHubUnknownError"));
            throw new Error(message || apiText("runningHubTaskFailed"));
        }
        const task = readRunningHubTask(response.data);
        if (task && (isDoneStatus(task.status) || task.images.length || task.videos.length)) return task;
        if (task?.errorMessage || (task && isFailedStatus(task.status))) {
            throw new Error(readFailedReason(response.data) || task.errorMessage || apiText("runningHubTaskFailed"));
        }
        await sleep(POLL_INTERVAL_MS, args.signal);
    }
    throw new Error(`${apiText("runningHubTimeout")} (taskId: ${args.taskId})`);
}

export async function pollRunningHubQuery(args: { origin: string; apiKey: string; taskId: string; signal?: AbortSignal }): Promise<RunningHubTaskView> {
    const deadline = performance.now() + POLL_TIMEOUT_MS;
    let latest: RunningHubTaskView = { taskId: args.taskId, status: "QUEUED", images: [], videos: [], errorMessage: "" };
    while (performance.now() < deadline) {
        if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await axios.post(proxyApiUrl(`${args.origin}/openapi/v2/query`), { taskId: args.taskId }, {
            headers: bearer(args.apiKey),
            signal: args.signal,
            timeout: 30_000,
        });
        assertOk(response.data, apiText("runningHubTaskFailed"));
        const task = readRunningHubTask(response.data);
        if (task) latest = task;
        if (latest.errorMessage || isFailedStatus(latest.status)) {
            const detail = readFailedReason(response.data) || latest.errorMessage || readMessage(response.data);
            if (isUnknownServerError(detail)) throw new Error(apiText("runningHubUnknownError"));
            throw new Error(detail || apiText("runningHubTaskFailed"));
        }
        if (isDoneStatus(latest.status)) return latest;
        await sleep(POLL_INTERVAL_MS, args.signal);
    }
    throw new Error(apiText("runningHubTimeout"));
}

export async function runRunningHubWorkflow(args: {
    baseUrl: string;
    apiKey: string;
    /** Backup keys to try in order when the primary key hits a balance/quota error. */
    apiKeys?: string[];
    model: string;
    script?: string;
    prompt: string;
    size?: string;
    seconds?: string;
    /** Megapixels override for workflows exposing a ResolutionSelector (MiniMax H3 story). */
    resolution?: string;
    media?: "image" | "video";
    referenceDataUrls?: string[];
    signal?: AbortSignal;
}): Promise<RunningHubMedia> {
    const origin = runningHubOrigin(args.baseUrl);
    const parsedWorkflowId = parseRunningHubWorkflowId(args.model, args.script, args.baseUrl);
    const primary = runningHubApiKey(args.baseUrl, args.apiKey);
    if (!origin || !parsedWorkflowId) throw new Error(apiText("runningHubWorkflowFetchFailed"));
    // Scoped media switch: the 自动分镜 model renders images only, so generating video from the same
    // model entry needs a dedicated video workflow (see switchRunningHubWorkflowForMedia).
    const workflowId = switchRunningHubWorkflowForMedia(parsedWorkflowId, args.media, args.script);

    // Key list: primary + backups, deduped. With multiple keys the order is shuffled per call
    // (Fisher-Yates below) so every generation spreads load across accounts at random — applies
    // to both runninghub.cn and runninghub.ai, which are the only origins that reach this
    // function. The balance-exhaustion fallback then walks the shuffled order unchanged, so an
    // exhausted key still falls through to the next one.
    const keys = Array.from(
        new Set(
            [primary, ...(args.apiKeys || []).map((key) => runningHubApiKey(args.baseUrl, key))]
                .map((key) => String(key || "").trim())
                .filter((key) => key && !/^(none|-|n\/a)$/i.test(key)),
        ),
    );
    if (!keys.length) throw new Error(apiText("apiKeyRequired"));
    // One fresh random order per generation call; a single-key list is untouched by this.
    for (let i = keys.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }

    const isBalanceError = (error: unknown) => isBalanceMessage(errorText(error));

    let lastError: unknown = null;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        const apiKey = keys[keyIndex];
        try {
            return await runRunningHubWorkflowWithKey({ origin, workflowId, apiKey, args, isLastKey: keyIndex === keys.length - 1 });
        } catch (error) {
            // Cancellation must propagate immediately — never switch keys on a user abort.
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            lastError = error;
            // Only a balance/quota error justifies moving to the next key. Anything else
            // (auth, bad workflow, unknown server error) is surfaced as-is.
            if (!isBalanceError(error)) throw explainRunningHubError(error, workflowId);
            // Fall through to the next key; when the last key also runs out, surface the balance error.
        }
    }
    throw explainRunningHubError(lastError, workflowId);
}

/** One full fetch → upload → submit → poll cycle against a single API key. */
async function runRunningHubWorkflowWithKey(args: {
    origin: string;
    workflowId: string;
    apiKey: string;
    isLastKey: boolean;
    args: {
        baseUrl: string;
        model: string;
        script?: string;
        prompt: string;
        size?: string;
        seconds?: string;
        resolution?: string;
        media?: "image" | "video";
        referenceDataUrls?: string[];
        signal?: AbortSignal;
    };
}): Promise<RunningHubMedia> {
    const { origin, workflowId, apiKey, isLastKey } = args;
    const request = args.args;
    const workflow = await fetchWorkflow(origin, apiKey, workflowId, request.signal).catch((error: unknown) => {
        if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const message = errorText(error);
        if (isAuthMessage(message)) throw explainRunningHubError(error, workflowId);
        return null;
    });
    const refs = (request.referenceDataUrls || []).filter(Boolean).slice(0, 8);
    const uploaded: string[] = [];
    for (let index = 0; index < refs.length; index += 1) {
        uploaded.push(await uploadImage(origin, apiKey, refs[index], `ref-${index + 1}.png`, request.signal));
    }
    const pixels = resolveCanvasPixels(request.size || "", request.media || "image");
    const aspect = canvasAspect(request.size || "");
    const patch: RunningHubWorkflowPatch = workflow
        ? buildWorkflowPatch(workflow, request.prompt, uploaded, pixels, request.seconds, aspect, request.media === "video" ? "" : request.size || "", workflowId, request.resolution || "")
        : { nodeInfoList: [] };
    const overrides = patch.nodeInfoList;
    const repairedGraph = patch.graph;
    const keptOverrides = overrides.filter((item) => /text|prompt|string|value|caption|positive|image|url|image_path|resolution|megapixel|aspect_ratio|switch/i.test(item.fieldName));
    let task: RunningHubTaskView;
    try {
        if (workflow) {
            task = await submitWorkflowTask(origin, apiKey, workflowId, overrides, repairedGraph, request.signal);
        } else {
            throw new Error("WORKFLOW_NOT_EXISTS");
        }
    } catch (error) {
        if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const message = errorText(error);
        if (isAuthMessage(message)) throw explainRunningHubError(error, workflowId);
        // Balance/quota errors are terminal and platform-side — surface them directly instead of
        // retrying or probing the webapp fallback (which would just fail the same way again).
        // They are rethrown raw so the outer multi-key loop can switch to the next key.
        if (/NOT_ENOUGH_BALANCE|INSUFFICIENT_BALANCE|NO_ENOUGH_BALANCE|BALANCE_NOT_ENOUGH|NOT_ENOUGH_POINTS|INSUFFICIENT_POINTS|余额不足|额度不足/i.test(message)) {
            throw error;
        }
        // A repaired-graph submission is always retried without it, so an unrecognized `workflow`
        // field or a rejected link degrades to the previous nodeInfoList-only behaviour.
        const canRetryPlain = Boolean(workflow) && (overrides.length > 0 || Boolean(repairedGraph)) && (Boolean(repairedGraph) || isUnknownServerError(message) || /APIKEY_INVALID_NODE_INFO|Node info error/i.test(message));
        if (canRetryPlain) {
            const fallback = keptOverrides.length && keptOverrides.length < overrides.length ? keptOverrides : [];
            task = await submitWorkflowTask(origin, apiKey, workflowId, fallback, undefined, request.signal).catch(async (retryError: unknown) => {
                if (!fallback.length) throw explainRunningHubError(retryError, workflowId);
                return submitWorkflowTask(origin, apiKey, workflowId, [], undefined, request.signal).catch((plainError: unknown) => {
                    throw explainRunningHubError(plainError, workflowId);
                });
            });
        } else {
            const nodes = await fetchWebappNodes(origin, apiKey, workflowId, request.signal).catch((webappError: unknown) => {
                if (isAuthMessage(errorText(webappError))) throw webappError;
                return [] as WebappNode[];
            });
            if (nodes.length) {
                task = await submitWebappTask(origin, apiKey, workflowId, buildWebappNodeInfoList(nodes, request.prompt, uploaded, request.size, request.seconds, request.media), request.signal);
            } else if (!workflow) {
                task = await submitWorkflowTask(origin, apiKey, workflowId, [], undefined, request.signal).catch((retryError: unknown) => {
                    throw explainRunningHubError(retryError, workflowId);
                });
            } else {
                throw explainRunningHubError(error, workflowId);
            }
        }
    }
    if (task.errorMessage || isFailedStatus(task.status)) {
        // A failed task can also carry a balance error in its failure reason — let the outer loop switch keys.
        const message = task.errorMessage || "";
        if (isBalanceMessage(message)) {
            const err = new Error(message);
            if (isLastKey) throw explainRunningHubError(err, workflowId);
            throw err;
        }
        throw explainRunningHubError(new Error(task.errorMessage || apiText("runningHubTaskFailed")), workflowId);
    }
    if (!isDoneStatus(task.status)) {
        try {
            task = await pollTaskOutputs({ origin, apiKey, taskId: task.taskId, signal: request.signal });
        } catch (error) {
            // Polling can surface a late balance failure; let the outer loop switch keys.
            if (isBalanceMessage(errorText(error))) {
                if (isLastKey) throw explainRunningHubError(error, workflowId);
                throw error;
            }
            throw error;
        }
    }
    const result: RunningHubMedia = { images: task.images, videos: task.videos };
    return isMinimaxH3FiveSegmentWorkflow(workflowId) ? normalizeMinimaxH3FiveSegmentResult(result, workflow) : result;
}

export async function probeRunningHubWorkflow(baseUrl: string, apiKey: string, model: string, script?: string, signal?: AbortSignal) {
    try {
        const origin = runningHubOrigin(baseUrl);
        const workflowId = parseRunningHubWorkflowId(model, script, baseUrl);
        const token = String(apiKey || "")
            .replace(/^Bearer\s+/i, "")
            .trim();
        if (!origin || !workflowId) return { ok: false, message: apiText("runningHubWorkflowFetchFailed") };
        if (!token) return { ok: false, message: apiText("apiKeyRequired") };
        try {
            await fetchWorkflow(origin, token, workflowId, signal);
        } catch (error) {
            const message = axios.isAxiosError(error) ? readMessage(error.response?.data) || error.message : error instanceof Error ? error.message : "";
            if (!isMissingIdMessage(message)) throw error;
            const nodes = await fetchWebappNodes(origin, token, workflowId, signal);
            if (!nodes.length) throw error;
        }
        return { ok: true, message: "" };
    } catch (error) {
        return { ok: false, message: explainRunningHubError(error, parseRunningHubWorkflowId(model, script) || "").message };
    }
}
