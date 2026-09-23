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
    return workflowId === QWEN_IMAGE_21_WORKFLOW_ID;
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

function applyQwenImage21Settings(workflow: ComfyWorkflow, imageCount: number, size?: { width: number; height: number } | null, aspect = "", rawSize = "") {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    const hasReferenceImages = imageCount > 0;
    const switchNode = next["419"];
    // The RunningHub nodeInfo API can override scalar inputs, but cannot create a missing
    // ComfyUI link. Only toggle into I2I when the saved workflow already exposes on_false.
    if (switchNode?.inputs && (!hasReferenceImages || "on_false" in switchNode.inputs)) switchNode.inputs.switch = !hasReferenceImages;

    const selector = next["424"];
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "9:16");
        if ("aspect_ratio" in selector.inputs) selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        if ("megapixels" in selector.inputs) selector.inputs.megapixels = qwenImage21Megapixels(size, rawSize);
    }

    const encoder = next["418"];
    if (encoder?.inputs && "resolution" in encoder.inputs && size?.width && size.height) {
        encoder.inputs.resolution = Math.max(size.width, size.height);
    }

    return next;
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

function buildNodeInfoList(workflow: ComfyWorkflow, prompt: string, imageValues: string[], size?: { width: number; height: number } | null, seconds?: string, aspect = "", rawSize = "", workflowId?: string) {
    let patched = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    if (prompt.trim()) patched = writeRunningHubPrompt(patched, prompt);
    if (size) patched = writeRunningHubSize(patched, size.width, size.height, aspect);
    const tier = canvasResolutionTier(rawSize);
    if (tier) patched = writeRunningHubTier(patched, tier);
    if (seconds?.trim()) patched = writeRunningHubSeconds(patched, seconds.trim());
    if (isQwenImage21Workflow(workflowId)) patched = applyQwenImage21Settings(patched, imageValues.length, size, aspect, rawSize);
    const list: Array<{ nodeId: string; fieldName: string; fieldValue: string }> = [];
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
    const loaders = isQwenImage21Workflow(workflowId)
        ? QWEN_IMAGE_21_LOAD_IMAGE_ORDER.map((nodeId) => [nodeId, workflow[nodeId]] as const).filter((entry): entry is readonly [string, ComfyNode] => Boolean(entry[1]))
        : Object.entries(workflow).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")));
    imageValues.forEach((value, index) => {
        const entry = loaders[index];
        if (!entry || !value) return;
        const fieldName = imageFieldName(entry[1]);
        if (!fieldName) return;
        const existing = list.find((item) => item.nodeId === entry[0] && item.fieldName === fieldName);
        if (existing) existing.fieldValue = value;
        else list.push({ nodeId: entry[0], fieldName, fieldValue: value });
    });
    return list;
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

async function submitWorkflowTask(origin: string, apiKey: string, workflowId: string, nodeInfoList: ReturnType<typeof buildNodeInfoList>, signal?: AbortSignal) {
    const token = apiKey.replace(/^Bearer\s+/i, "").trim();
    const body: Record<string, unknown> = { apiKey: token, workflowId, addMetadata: true };
    if (nodeInfoList.length) body.nodeInfoList = nodeInfoList;
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

async function pollTaskOutputs(args: { origin: string; apiKey: string; taskId: string; signal?: AbortSignal }): Promise<RunningHubTaskView> {
    const deadline = performance.now() + POLL_TIMEOUT_MS;
    const token = args.apiKey.replace(/^Bearer\s+/i, "").trim();
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
    throw new Error(apiText("runningHubTimeout"));
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
    model: string;
    script?: string;
    prompt: string;
    size?: string;
    seconds?: string;
    media?: "image" | "video";
    referenceDataUrls?: string[];
    signal?: AbortSignal;
}): Promise<RunningHubMedia> {
    const origin = runningHubOrigin(args.baseUrl);
    const workflowId = parseRunningHubWorkflowId(args.model, args.script, args.baseUrl);
    const apiKey = runningHubApiKey(args.baseUrl, args.apiKey);
    if (!origin || !workflowId) throw new Error(apiText("runningHubWorkflowFetchFailed"));
    if (!apiKey || /^(none|-|n\/a)$/i.test(apiKey)) throw new Error(apiText("apiKeyRequired"));

    const workflow = await fetchWorkflow(origin, apiKey, workflowId, args.signal).catch((error: unknown) => {
        if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const message = errorText(error);
        if (isAuthMessage(message)) throw explainRunningHubError(error, workflowId);
        return null;
    });
    const refs = (args.referenceDataUrls || []).filter(Boolean).slice(0, 8);
    const uploaded: string[] = [];
    for (let index = 0; index < refs.length; index += 1) {
        uploaded.push(await uploadImage(origin, apiKey, refs[index], `ref-${index + 1}.png`, args.signal));
    }
    const pixels = resolveCanvasPixels(args.size || "", args.media || "image");
    const aspect = canvasAspect(args.size || "");
    const overrides = workflow ? buildNodeInfoList(workflow, args.prompt, uploaded, pixels, args.seconds, aspect, args.media === "video" ? "" : args.size || "", workflowId) : [];
    const keptOverrides = overrides.filter((item) => /text|prompt|string|value|caption|positive|image|url|image_path|resolution|megapixel|aspect_ratio|switch/i.test(item.fieldName));
    let task: RunningHubTaskView;
    try {
        if (workflow) {
            task = await submitWorkflowTask(origin, apiKey, workflowId, overrides, args.signal);
        } else {
            throw new Error("WORKFLOW_NOT_EXISTS");
        }
    } catch (error) {
        if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const message = errorText(error);
        if (isAuthMessage(message)) throw explainRunningHubError(error, workflowId);
        const canRetryPlain = Boolean(workflow) && overrides.length > 0 && (isUnknownServerError(message) || /APIKEY_INVALID_NODE_INFO|Node info error/i.test(message));
        if (canRetryPlain) {
            const fallback = keptOverrides.length && keptOverrides.length < overrides.length ? keptOverrides : [];
            task = await submitWorkflowTask(origin, apiKey, workflowId, fallback, args.signal).catch(async (retryError: unknown) => {
                if (!fallback.length) throw explainRunningHubError(retryError, workflowId);
                return submitWorkflowTask(origin, apiKey, workflowId, [], args.signal).catch((plainError: unknown) => {
                    throw explainRunningHubError(plainError, workflowId);
                });
            });
        } else {
            const nodes = await fetchWebappNodes(origin, apiKey, workflowId, args.signal).catch((webappError: unknown) => {
                if (isAuthMessage(errorText(webappError))) throw webappError;
                return [] as WebappNode[];
            });
            if (nodes.length) {
                task = await submitWebappTask(origin, apiKey, workflowId, buildWebappNodeInfoList(nodes, args.prompt, uploaded, args.size, args.seconds, args.media), args.signal);
            } else if (!workflow) {
                task = await submitWorkflowTask(origin, apiKey, workflowId, [], args.signal).catch((retryError: unknown) => {
                    throw explainRunningHubError(retryError, workflowId);
                });
            } else {
                throw explainRunningHubError(error, workflowId);
            }
        }
    }
    if (task.errorMessage || isFailedStatus(task.status)) throw explainRunningHubError(new Error(task.errorMessage || apiText("runningHubTaskFailed")), workflowId);
    if (!isDoneStatus(task.status)) {
        task = await pollTaskOutputs({ origin, apiKey, taskId: task.taskId, signal: args.signal });
    }
    return { images: task.images, videos: task.videos };
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
