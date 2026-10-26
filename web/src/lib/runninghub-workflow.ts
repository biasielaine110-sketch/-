/**
 * RunningHub workflow API: model name = workflowId.
 * Fetches the saved API graph, injects prompt + LoadImage, then polls the V2 task envelope
 * `{ taskId, status, results, errorMessage, ... }`.
 */

import axios from "axios";

// 第四套 `video_motion_prompt` 末尾那块固定尾巴（`【禁止项】` / `【强制声明】`）的**唯一判据**。
// 全项目只有 `constant/story-script.ts` 一处定义文案与指纹，这里只借用「这一行是不是我们追加的尾巴」，
// 绝不在这里抄一份字符串 —— 文案改过一次了（`不要出现字幕…` → 四行块），抄一份就会漂。
import { isStoryScriptDirectorSoundNoteLine } from "@/constant/story-script";
import i18n from "@/i18n";
import { proxyApiUrl } from "@/lib/api-proxy";
import {
    applyComfyPrompt,
    parseComfyApiWorkflow,
    repairSingularityLatentUpscaler,
    type ComfyNode,
    type ComfyWorkflow,
} from "@/lib/comfyui-native";
import { compressReferenceDataUrl, dataUrlToFile, getDataUrlByteSize } from "@/lib/image-utils";
// Vendored Export (API) copy of 全能生图王 — see bundledRunningHubGraph. Baked preview artifacts
// (the author's local /view URLs) are blanked; both nodes are pruned before submission anyway.
import workfisherMossWorkflow from "./runninghub-workflows/workfisher-moss-image.json";
// 【MINIMAX-H3】八月最强文戏 低配 / 高配 —— 见 `bundledRunningHubGraph`。两位作者的图都是第三方
// 发布 id，`getJsonApiFormat` 对普通 key 常是 ACL 拒绝，这两份内置图是「开箱能跑」的底线。
import minimaxH3WenxiLowWorkflow from "./runninghub-workflows/minimax-h3-wenxi-low.json";
import minimaxH3WenxiHighWorkflow from "./runninghub-workflows/minimax-h3-wenxi-high.json";

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

// `values` feeds i18next interpolation ({{size}} / {{limit}} …). Callers that pass only a key keep
// the previous behaviour exactly. The call is typed through a narrow signature because i18next's
// generic overloads pick the `{returnDetails:true}` shape for a loose options argument, which would
// make every call site "not a string".
const apiText = (key: string, values?: Record<string, string | number>): string =>
    (i18n.t as (k: string, options?: Record<string, unknown>) => string)(`apiErrors.${key}`, values);

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

/** Shared/community workflow the caller's key cannot open via getJsonApiFormat / create. */
function isWorkflowPermissionMessage(message: string) {
    return /无权限访问该工作流|请联系作者开通|WORKFLOW_ACCESS_DENIED|WORKFLOW_NO_PERMISSION|ACCESS_DENIED.*WORKFLOW/i.test(message);
}

function isBalanceMessage(message: string) {
    return /NOT_ENOUGH_BALANCE|INSUFFICIENT_BALANCE|NO_ENOUGH_BALANCE|BALANCE_NOT_ENOUGH|NOT_ENOUGH_POINTS|INSUFFICIENT_POINTS|余额不足|额度不足/i.test(message);
}

/**
 * "This key cannot serve this request" — a different account in the same channel may still work, so
 * the caller walks to the next key instead of failing the whole generation. Covers a drained balance,
 * a dead/revoked key (401), and a workflow the account has no access to (multi-account channels often
 * hold keys with uneven workflow permissions, which otherwise fails at random).
 * Deliberately NOT included: UNKNOWN_ERROR and plain network/transport errors — those say nothing
 * about the key, and retrying every key just multiplies the wait.
 */
export function isRunningHubKeyFailoverMessage(message: string) {
    const text = String(message || "");
    if (isBalanceMessage(text) || isAuthMessage(text) || isWorkflowPermissionMessage(text)) return true;
    return /status\s*code\s*40[13]|unauthori[sz]ed|invalid\s*(?:api[\s-_]*)?key|api[\s-_]*key\s*(?:is\s*)?(?:invalid|expired|rejected|not\s*(?:valid|found|exist))|token\s*(?:is\s*)?(?:invalid|expired)/i.test(
        text,
    );
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
    // SelfLift 双采(简易版) is a shared graph: without a local Export (API) JSON in the model
    // script the caller cannot open the author's copy. Surface the paste-script hint only for
    // that workflow id so every other model keeps the raw platform message.
    if (isWorkflowPermissionMessage(message) && isMinimaxH3SelfLiftWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubSelfLiftScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isQwenKleinSkinWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubKleinSkinScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isMinimaxH3RefTopWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubH3RefTopScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isKrea2PastoralMjWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubKrea2PastoralMjScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isKrea2AidenLoraWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubKrea2AidenLoraScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isMinimaxH3SingularityWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubH3SingularityScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isMinimaxH3HdDynamicWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubH3HdDynamicScriptRequired", { id: workflowId }));
    }
    if (isWorkflowPermissionMessage(message) && isMinimaxH3FisherWorkflow(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubH3FisherScriptRequired", { id: workflowId }));
    }
    // 兜底：任何「支持脚本贴 Export」的族在 ACL 拒绝时都该说清出路，而不是甩一句 workflow not exists。
    // （各族的专属文案在上面，先命中先返回；这里只接没被那些分支认领的 id，例如独立模型
    //  `2114341115852099586`。）
    if (isWorkflowPermissionMessage(message) && usesRunningHubLocalExportGraph(workflowId)) {
        return new Error(i18n.t("apiErrors.runningHubExportScriptRequired", { id: workflowId }));
    }
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

// Qwen Image 2.1 文生、图像编辑一体化 workflow (runninghub.cn 2105280251281625089 /
// runninghub.ai 2105280279937130497). One graph serves both text-to-image and image editing:
// the QwenImagePromptOptimizer (179) rewrites the user prompt with the PE model matching the mode
// it detects, and a GoohaiRouteBlocker (170) either passes the LoadImageGoohai reference (193)
// into the encoder's image_01 slot or blocks it. Its knobs do not match the generic heuristics:
//   - the prompt lives in a DF_Text_Box (22) whose field is capitalised `Text` — PROMPT_FIELDS
//     only knows lowercase `text`, so neither the generic writer nor applyComfyPrompt can reach
//     it and the graph would keep running its baked demo prompt;
//   - output size is decided by GoohaiRatioAndResolution (39), whose `比例` is a ratio enum
//     ("原始比例" …) the generic size writer cannot produce — the canvas aspect choice would
//     be silently ignored. Only the ratio is mapped: the author's 总像素 + 2MP mode stays as
//     baked, so an unknown 百万像素 combo value can never hard-fail the task;
//   - the KSampler (12) bakes a fixed seed, so identical inputs repeated identical images.
// The single reference loader (193) also feeds the optimizer's 图像_01, so the generic LoadImage
// mapping is enough *when the user actually brings a picture* — see the T2I branch below for the
// one case where the link itself has to go. Everything below is scoped to these two ids only.
const QWEN_IMAGE_21_UNIFIED_WORKFLOW_IDS = new Set(["2105280251281625089", "2105280279937130497"]);
const QWEN_IMAGE_21_UNIFIED_OPTIMIZER_NODE = "179";
const QWEN_IMAGE_21_UNIFIED_ROUTE_NODE = "170";
const QWEN_IMAGE_21_UNIFIED_OPTIMIZER_IMAGE_FIELD = "图像_01";

function isQwenImage21UnifiedWorkflow(workflowId?: string | null) {
    return Boolean(workflowId && QWEN_IMAGE_21_UNIFIED_WORKFLOW_IDS.has(workflowId));
}

/**
 * Drop the saved graph's demo reference so a text-to-image run really is text-to-image.
 *
 * LoadImageGoohai (193) ships the workflow author's demo portrait, and that one node feeds both
 * 179.图像_01 and, through GoohaiRouteBlocker (170), the encoder's image_01. `图像_01` is the
 * graph's own mode switch: with an image attached the optimizer runs its vision/I2I PE model —
 * it describes that portrait and folds the description into the prompt — and reports "do not
 * block" on 是否阻断, so the same portrait also conditions the sampler. The canvas only rewrites
 * 193.image when the user brings a reference, so *every* run without one was silently an edit of
 * the author's demo character: role sheets, scenery, everything came back with that person.
 *
 * nodeInfoList overrides scalars only and cannot unlink an input, so this is a graph repair:
 * unlink 图像_01 (the state the RunningHub UI shows when no image is connected, which puts the
 * optimizer on its 文生图 model) and pin 是否阻断 so the reference can never reach the encoder
 * even if the optimizer still answers "pass". Only runs with no reference take this path; a run
 * that does have one keeps the author's graph untouched.
 */
function disconnectQwenImage21UnifiedDemoReference(workflow: ComfyWorkflow) {
    const optimizer =
        workflow[QWEN_IMAGE_21_UNIFIED_OPTIMIZER_NODE] ||
        findComfyNode(workflow, (node) => /QwenImagePromptOptimizer/i.test(String(node.class_type || "")));
    let repaired = false;
    if (optimizer?.inputs && Array.isArray(optimizer.inputs[QWEN_IMAGE_21_UNIFIED_OPTIMIZER_IMAGE_FIELD])) {
        delete optimizer.inputs[QWEN_IMAGE_21_UNIFIED_OPTIMIZER_IMAGE_FIELD];
        repaired = true;
    }
    // The route blocker is the one whose 是否阻断 is still a link (174 is a second blocker in the
    // same graph, but it is wired to a constant `true` and drives the mask slot).
    const route =
        workflow[QWEN_IMAGE_21_UNIFIED_ROUTE_NODE] ||
        findComfyNode(workflow, (node) => node.class_type === "GoohaiRouteBlocker" && Array.isArray(node.inputs?.["是否阻断"]));
    if (route?.inputs && Array.isArray(route.inputs["是否阻断"])) {
        route.inputs["是否阻断"] = true;
        repaired = true;
    }
    return repaired;
}

function applyQwenImage21UnifiedSettings(
    workflow: ComfyWorkflow,
    pristine: ComfyWorkflow,
    prompt: string,
    size?: { width: number; height: number } | null,
    aspect = "",
    imageValues: string[] = [],
) {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // User prompt → DF_Text_Box "Text" (node 22), head of the
    // 22 → QwenImagePromptOptimizer(179) → ShowText(111) → TextEncodeQwenImage21GH(118) chain.
    // The optimizer rewrites/annotates it, so the raw user text must land here, not at the encoder.
    if (prompt.trim()) {
        const promptNode =
            next["22"] ||
            findComfyNode(next, (node) => typeof node.inputs?.Text === "string" && /提示词|prompt/i.test(`${node.class_type || ""} ${node._meta?.title || ""}`));
        if (promptNode?.inputs && typeof promptNode.inputs.Text === "string") promptNode.inputs.Text = prompt;
    }

    // Drop inputs that are not part of the node's declared API surface. The generic prompt
    // writer falls through to applyComfyPrompt here (DF_Text_Box's capitalised `Text` is outside
    // PROMPT_FIELDS), whose force path invents a `text` input on the optimizer (179) that the node
    // does not declare — RunningHub rejects overrides for unknown fields, and that rejection takes
    // the whole nodeInfo batch with it, silently falling back to the baked demo prompt.
    for (const [nodeId, node] of Object.entries(next)) {
        if (!node?.inputs) continue;
        const declared = pristine[nodeId]?.inputs || {};
        for (const field of Object.keys(node.inputs)) {
            if (!(field in declared)) delete node.inputs[field];
        }
    }

    // Canvas aspect → GoohaiRatioAndResolution `比例` (node 39). Ratio strings are that node's own
    // enum values ("原始比例" is just its "follow the reference" option), and
    // closestResolutionSelectorAspect snaps the canvas size onto the shared 8-ratio set.
    const ratioNode = next["39"] || findComfyNode(next, (node) => node.class_type === "GoohaiRatioAndResolution");
    if (ratioNode?.inputs && typeof ratioNode.inputs["比例"] === "string") {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect) ratioNode.inputs["比例"] = nextAspect;
    }

    // Fixed seeds → identical results for identical inputs. Randomize per submission.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/RandomNoise/i.test(type) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        else if (/KSampler|SamplerCustom/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    // No reference from the canvas → the saved demo portrait must not be what gets edited.
    const hasReference = imageValues.some((value) => Boolean(String(value || "").trim()));
    const structuralRepair = hasReference ? false : disconnectQwenImage21UnifiedDemoReference(next);

    return { workflow: next, structuralRepair };
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

// MiniMax H3 人物卡四视图 / 各种资产卡 (RunningHub 2106992929079386114).
// One reference-to-video render per submission, then a still-frame sheet is cut out of the clip:
// MiniMaxH3ReferenceToVideo (153) renders the video, GetImagesFromBatchIndexed (253) pulls four
// evenly spread frames, ImageConcatFromBatch (442) lays them out 2-up, and a SeedVR2 upscale
// (488:0..7) cleans the sheet up before it is previewed (492/493). The user wants both the clip
// and the sheet, so the task legitimately reports one video plus several images.
//
// The generic writers all miss — or actively break — this graph, which is why it bypasses them:
//   - the prompt lives in TWO PrimitiveStringMultiline nodes: 185 (English, the one Any Switch 409
//     actually feeds to the sampler) and 323 (a Chinese reference copy that nothing consumes).
//     Both score 40, so the generic writer overwrites BOTH — the user text lands in 185 (correct)
//     but also clobbers the author's paired translation, which is documentation, not input;
//   - duration is a PrimitiveFloat titled 视频长度（秒）(node 143, field `value`), which the
//     duration/seconds/video_length probe cannot reach, so the canvas duration was ignored;
//   - output shape is a ResolutionSelector (133) whose aspect_ratio is a *label* enum
//     ("9:16 (Portrait Widescreen)") the aspect writer cannot produce, while its `megapixels` is
//     a number the tier writer force-maps 1k/2k/4k → 1/2/4 (always downgrading the baked 2MP);
//   - `writeRunningHubSize` matches ANY node carrying width+height or an `aspect_ratio`, so it
//     overwrites AutoCropFaces (160) — where `aspect_ratio: "1:1"` is the *face crop* shape, not the
//     output shape. Writing 9:16 there stretches every cropped face;
//   - references are consumed through named `ref_images.ref_image_N` slots, but only two loaders
//     exist (243 → AutoCropFaces → slot 0, 155 → slot 1) and node-id order (155, 243) is the
//     *reverse* of the slot order, so a naive write swaps face and outfit references. Slot 0 goes
//     through an AutoCropFaces/PreviewImage chain rather than a bare loader, so it has to be
//     resolved by walking the links, not by listing LoadImage nodes;
//   - both loaders ship the same baked demo face, so a slot the user did not fill leaks the
//     author's character into the render. Unfilled slots are disconnected instead;
//   - RandomNoise (139) bakes a fixed seed, so identical inputs repeated an identical clip.
//
// Everything below is scoped to this workflow id; every other model keeps the generic path.
const MINIMAX_H3_FOUR_VIEW_WORKFLOW_ID = "2106992929079386114";
/**
 * Keep the baked prompt's hard-coded timing/shape in step with the knobs we just changed.
 *
 * The shipped English prompt states the design literally — "A 2-second 9:16 vertical video …
 * four static shots of 0.5 seconds each" — and the Chinese counterpart repeats it. Change the
 * duration or the aspect without touching those phrases and the model is simultaneously told to
 * render 6 seconds and 2 seconds, which is how a coherent four-view sheet turns into four frames
 * of the same pose. Rewriting only the numeric/label tokens keeps the prompt's structure (and the
 * user's own text) intact, and only when the value actually differs from the baked one.
 */
function retargetMinimaxH3FourViewPrompt(text: string, seconds: number, aspectLabel: string) {
    let next = text;
    // The two copies word the timing differently: English says "A 2-second 9:16 vertical video …
    // four static shots of 0.5 seconds each", Chinese says "2秒 9:16 竖屏 … 四个镜头各0.5秒".
    // Both are handled so neither copy ends up contradicting the rendered length.
    if (Number.isFinite(seconds) && seconds > 0) {
        next = next.replace(/\b\d+(?:\.\d+)?-second\b/g, `${seconds}-second`);
        next = next.replace(/(\d+(?:\.\d+)?)\s*秒/g, `${seconds} 秒`);
        // Four shots share the clip evenly: each lasts duration/4. "1 seconds" is ungrammatical.
        const perShot = Math.round((seconds / 4) * 100) / 100;
        const each = `${perShot} ${perShot === 1 ? "second" : "seconds"} each`;
        next = next.replace(/\b\d+(?:\.\d+)?\s*seconds?\s+each\b/g, each);
        // "各0.5秒" (per-shot) must move with the per-shot length, not the total.
        next = next.replace(/各\s*\d+(?:\.\d+)?\s*秒/g, `各${perShot} 秒`);
        next = next.replace(/每\s*\d+(?:\.\d+)?\s*秒/g, `每 ${perShot} 秒`);
    }
    if (aspectLabel) {
        // The label form the prompt uses ("9:16"), not the enum label.
        const ratio = RUNNINGHUB_RESOLUTION_SELECTOR_ASPECTS.find((item) => item.label === aspectLabel)?.ratio || "";
        // Only the ratio that names the *frame shape* — a "16:9" inside unrelated prose is not the
        // output aspect, so the lookahead requires an orientation word right after it.
        if (ratio) next = next.replace(/\b\d{1,2}:\d{1,2}\b(?=\s*(?:vertical|horizontal|竖屏|横屏))/g, ratio);
    }
    return next;
}

/**
 * The asset-card sheet is four still frames; more than a couple of seconds per view is wasted render time.
 */
const MINIMAX_H3_FOUR_VIEW_SECONDS = { min: 2, max: 8 };
function isMinimaxH3FourViewWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => segment.trim().replace(/^(rh|runninghub|workflow)[:_-]/, "").trim() === MINIMAX_H3_FOUR_VIEW_WORKFLOW_ID);
}

/** Public gate so the video settings panel can offer this graph's duration/resolution controls. */
export function isMinimaxH3FourViewWorkflowId(workflowId?: string | null) {
    return isMinimaxH3FourViewWorkflow(workflowId);
}

/** Python-style modulo: the graph's math node relies on `%` returning a non-negative remainder. */
function comfyMod(value: number, modulus: number) {
    return ((value % modulus) + modulus) % modulus;
}

/**
 * Frame count this graph will render for `seconds`, replicating ComfyMathExpression node 150:
 * `max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17` — H3 only accepts lengths of
 * the form 17n+5, so the expression snaps the requested duration up to the next valid length.
 */
function minimaxH3FourViewFrameCount(seconds: number) {
    const base = Math.max(5, Math.round(seconds * 24));
    return base + comfyMod(5 - comfyMod(base, 17), 17);
}

/** The reference-to-video node plus its `ref_images.ref_image_N` slots, in slot order. */
function minimaxH3FourViewSlots(workflow: ComfyWorkflow) {
    const consumer = Object.entries(workflow).find(([, node]) => /MiniMaxH3ReferenceToVideo/i.test(String(node?.class_type || "")));
    if (!consumer) return null;
    const [consumerId, node] = consumer;
    const slots: Array<{ index: number; key: string; sourceId: string }> = [];
    for (const [key, value] of Object.entries(node.inputs || {})) {
        const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
        if (!match) continue;
        const sourceId = Array.isArray(value) ? String(value[0]) : "";
        if (sourceId) slots.push({ index: Number(match[1]), key, sourceId });
    }
    if (!slots.length) return null;
    slots.sort((a, b) => a.index - b.index);
    return { consumerId, consumer: node, slots };
}

/**
 * Walk upstream from a reference slot to the LoadImage that feeds it. Slot 0 is not wired to a
 * loader directly — it goes LoadImage → AutoCropFaces → PreviewImage — so the loader has to be
 * found by following the links back, never by listing LoadImage nodes (whose id order is the
 * reverse of the slot order here).
 */
function minimaxH3FourViewLoader(workflow: ComfyWorkflow, startId: string, depth = 0): string {
    if (depth > 6) return "";
    const node = workflow[startId];
    if (!node) return "";
    if (/LoadImage/i.test(String(node.class_type || "")) && imageFieldName(node)) return startId;
    // Follow the first image-ish link this node consumes (the graph chains are linear per slot).
    for (const [field, value] of Object.entries(node.inputs || {})) {
        if (!Array.isArray(value) || value[0] == null) continue;
        if (!/image/i.test(field)) continue;
        const found = minimaxH3FourViewLoader(workflow, String(value[0]), depth + 1);
        if (found) return found;
    }
    return "";
}

/**
 * The asset-card sheet is four stills sampled across the clip (GetImagesFromBatchIndexed 253 pulls
 * absolute frame indexes). The saved graph bakes "1, 21, 30, 49", which only lands one frame in
 * each of the four views at the 2s bake — at any other duration the four shots collapse into the
 * opening second (or run past the end and error). Re-space them evenly over the real frame count so
 * every view is sampled mid-shot whatever duration was asked for.
 */
function minimaxH3FourViewFrameIndexes(frameCount: number) {
    const views = 4;
    const last = Math.max(1, frameCount - 1);
    return Array.from({ length: views }, (_, i) => Math.min(last, Math.max(0, Math.round(((i + 0.5) * frameCount) / views))));
}

/** Prune the noise this graph's leftovers add to the task result. */
function pruneMinimaxH3FourViewOutputs(workflow: ComfyWorkflow) {
    let changed = false;
    for (const [id, node] of Object.entries(workflow)) {
        // The Image Comparer (rgthree) is an authoring leftover: it stores two baked preview URLs
        // (audit tokens and all) and renders nothing, so it only adds payload.
        if (/Image\s*Comparer/i.test(String(node?.class_type || ""))) {
            delete workflow[id];
            changed = true;
        }
    }
    return changed;
}

/** Every node reachable from `startId` in either direction (who consumes it, and what it consumes). */
function comfyChainIds(workflow: ComfyWorkflow, startId: string) {
    const consumers = new Map<string, string[]>();
    for (const [id, node] of Object.entries(workflow)) {
        for (const value of Object.values(node?.inputs || {})) {
            if (!Array.isArray(value) || value[0] == null) continue;
            const from = String(value[0]);
            const list = consumers.get(from);
            if (list) list.push(id);
            else consumers.set(from, [id]);
        }
    }
    const seen = new Set<string>([startId]);
    const queue = [startId];
    while (queue.length) {
        const current = queue.pop() as string;
        for (const next of [...(consumers.get(current) || []), ...Object.values(workflow[current]?.inputs || {}).filter(Array.isArray).map((value) => String((value as unknown[])[0]))]) {
            if (!next || seen.has(next) || !workflow[next]) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return seen;
}

/**
 * Drop a disconnected reference branch (LoadImage → AutoCropFaces → PreviewImage chains). Leaving
 * it in place keeps the workflow author's baked demo face loaded and previewed even though nothing
 * consumes it any more. Iterated to a fixed point because dropping a node can orphan the next one.
 */
function pruneOrphanedReferenceChain(workflow: ComfyWorkflow, seedIds: string[]) {
    const candidates = new Set<string>();
    for (const seedId of seedIds) {
        for (const id of comfyChainIds(workflow, seedId)) {
            if (id !== seedId || /LoadImage|AutoCropFaces|PreviewImage|Resize/i.test(String(workflow[id]?.class_type || ""))) candidates.add(id);
        }
    }
    let changed = false;
    for (let pass = 0; pass < 8; pass += 1) {
        const consumed = comfyConsumedIds(workflow);
        let removed = false;
        for (const id of candidates) {
            if (!workflow[id] || consumed.has(id)) continue;
            delete workflow[id];
            removed = true;
            changed = true;
        }
        if (!removed) break;
    }
    return changed;
}

function applyMinimaxH3FourViewSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    size?: { width: number; height: number } | null,
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // Prompt is written last: the baked text hard-codes "A 2-second 9:16 vertical video …", so it
    // has to be retargeted against the duration/aspect this call actually settled on. Node 323
    // holds the author's Chinese counterpart (nothing consumes it) and stays untouched.
    //
    // Reference images → `<Picture 1>…` slot order (resolved through each slot's link chain, so
    // the face reference and the outfit reference cannot swap). A slot the user did not fill is
    // disconnected: both loaders ship the author's baked demo face, and leaving it wired would put
    // a stranger's character into the render.
    let writtenReferences = 0;
    const slotInfo = minimaxH3FourViewSlots(next);
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        const disconnected: string[] = [];
        slots.forEach((slot, position) => {
            const loaderId = minimaxH3FourViewLoader(next, slot.sourceId);
            const loader = loaderId ? next[loaderId] : undefined;
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            const consumerInputs = consumer.inputs;
            if (consumerInputs && slot.key in consumerInputs) {
                delete consumerInputs[slot.key];
                disconnected.push(slot.sourceId);
                structuralRepair = true;
            }
        });
        // A disconnected slot's whole branch (loader + AutoCropFaces + its preview) is now dead
        // weight, and it still carries the author's baked demo face — drop it.
        if (disconnected.length && pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    } else if (imageValues.length) {
        // The graph served by RunningHub doesn't match the saved structure closely enough to find
        // the reference slots. Never silently render the baked demo images: fall back to the
        // generic mapping (each uploaded reference onto a LoadImage, document order) so the
        // references at least reach the task.
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    // The one failure mode worse than an error: the user hands over references, the task renders
    // anyway, and the clip has nothing to do with them. If none of the uploaded references landed
    // in the graph, stop instead of burning credits on the baked demo.
    if (imageValues.length && !writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // Duration → PrimitiveFloat 视频长度（秒）(node 143, field `value`).
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_FOUR_VIEW_SECONDS.max, Math.max(MINIMAX_H3_FOUR_VIEW_SECONDS.min, duration));
        const durationNode =
            next["143"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") {
            durationNode.inputs.value = clamped;
            // Re-space the four sheet frames over the length actually rendered (17n+5 frames).
            const extractor = next["253"] || findComfyNode(next, (node) => /GetImagesFromBatchIndexed/i.test(String(node.class_type || "")));
            if (extractor?.inputs && typeof extractor.inputs.indexes === "string") {
                extractor.inputs.indexes = minimaxH3FourViewFrameIndexes(minimaxH3FourViewFrameCount(clamped)).join(", ");
            }
        }
    }

    // Output shape → ResolutionSelector (133): aspect_ratio is a label enum, megapixels a number.
    const selector = next["133"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    let aspectLabel = "";
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect && typeof selector.inputs.aspect_ratio === "string") {
            const label = resolutionSelectorAspectLabel(nextAspect);
            selector.inputs.aspect_ratio = label;
            aspectLabel = label;
        }
        const requested = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(requested) && requested > 0) {
            const baked = typeof workflow["133"]?.inputs?.megapixels === "number" ? Number(workflow["133"].inputs?.megapixels) : 0;
            if (typeof selector.inputs.megapixels === "number") selector.inputs.megapixels = Math.max(baked, requested);
        }
    }

    // Prompt, once the duration and aspect this submission settled on are known: the baked text
    // names both literally, so it is retargeted to match rather than left contradicting the graph.
    // Runs whether or not the user typed a prompt — an empty prompt means the *baked* four-view
    // prompt is what gets rendered, and that is precisely the text that names "2-second".
    {
        const consumer = minimaxH3FourViewSlots(next)?.consumer;
        const sourceId = consumer ? minimaxH3FourViewPromptSource(next, consumer) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["185"] ||
            findComfyNode(
                next,
                (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string" && /英文|english/i.test(String(node._meta?.title || "")),
            );
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") {
            const durationNode = next["143"];
            const rendered = typeof durationNode?.inputs?.value === "number" ? Number(durationNode.inputs.value) : NaN;
            // An empty canvas prompt means the *baked* four-view prompt is what will be rendered —
            // so retarget that text rather than replacing it with nothing. A user prompt is used
            // as typed, only retargeted when it actually names a duration or frame shape.
            const base = prompt.trim() ? prompt : promptNode.inputs.value;
            const text = retargetMinimaxH3FourViewPrompt(base, rendered, aspectLabel);
            promptNode.inputs.value = text;
            // The Chinese counterpart (323) is the author's translation of the baked English text.
            // It retargets its own copy — the numeric rules above are language-agnostic, so the
            // pair stays a translation of each other instead of the Chinese node silently turning
            // into English. Like the English side it only follows the *baked* prompt; once the
            // user supplies their own text the translation no longer describes anything.
            const translated =
                next["323"] ||
                findComfyNode(next, (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string" && /中文|chinese|对照/i.test(String(node._meta?.title || "")));
            if (translated && translated !== promptNode && translated.inputs && typeof translated.inputs.value === "string" && !prompt.trim()) {
                const zh = retargetMinimaxH3FourViewPrompt(translated.inputs.value, rendered, aspectLabel);
                if (zh !== translated.inputs.value) translated.inputs.value = zh;
            }
        }
    }

    // The graph bakes a fixed noise seed — identical inputs would render an identical clip on
    // every run. Randomize per submission.
    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
    }

    if (pruneMinimaxH3FourViewOutputs(next)) structuralRepair = true;
    return { workflow: next, structuralRepair };
}

/**
 * Follow the sampler's `prompt` link back to the string node that actually feeds it, so the user's
 * text lands in the live prompt (185) and not in the unused translation copy (323).
 */
function minimaxH3FourViewPromptSource(workflow: ComfyWorkflow, consumer: ComfyNode, depth = 0): string {
    if (depth > 6) return "";
    const prompt = consumer.inputs?.prompt;
    const sourceId = Array.isArray(prompt) ? String(prompt[0]) : "";
    if (!sourceId) return "";
    const source = workflow[sourceId];
    if (!source) return "";
    if (source.class_type === "PrimitiveStringMultiline" && typeof source.inputs?.value === "string") return sourceId;
    // Any Switch (rgthree) and similar pass-throughs: keep walking.
    for (const value of Object.values(source.inputs || {})) {
        const upstreamId = Array.isArray(value) ? String(value[0]) : "";
        if (!upstreamId || !workflow[upstreamId]) continue;
        const found = minimaxH3FourViewPromptSource(workflow, workflow[upstreamId], depth + 1);
        if (found) return found;
    }
    return "";
}

/**
 * The task reports the clip plus several previews (the raw face-crop preview 162 and both sides of
 * the SeedVR2 comparison). The concatenated four-view sheet is the deliverable image, so put it
 * first; the clip is the only video and needs no ordering.
 * Exported alongside buildWorkflowPatch so the selection can be exercised headlessly.
 */
export function normalizeMinimaxH3FourViewResult(result: RunningHubMedia, workflow: ComfyWorkflow | null): RunningHubMedia {
    const sheet = minimaxH3FourViewSheetPrefix(workflow);
    if (!sheet || result.images.length < 2) return result;
    const preferred = result.images.filter((url) => url.includes(sheet) || decodeURIComponent(url).includes(sheet));
    if (!preferred.length) return result;
    return { images: [...preferred, ...result.images.filter((url) => !preferred.includes(url))], videos: result.videos };
}

/** `filename_prefix` of the PreviewImage fed by the concatenated sheet, used to recognise it. */
function minimaxH3FourViewSheetPrefix(workflow: ComfyWorkflow | null) {
    if (!workflow) return "";
    const concat = Object.entries(workflow).find(([, node]) => /ImageConcatFromBatch/i.test(String(node?.class_type || "")));
    if (!concat) return "";
    // The sheet reaches its preview through ResizeImageMaskNode → Any Switch (and again through the
    // SeedVR2 chain), so walk up from every preview until the concat node shows up.
    for (const [id, node] of Object.entries(workflow)) {
        if (!/PreviewImage/i.test(String(node?.class_type || ""))) continue;
        let cursor = Array.isArray(node.inputs?.images) ? String((node.inputs?.images as unknown[])[0]) : "";
        for (let depth = 0; cursor && depth < 8; depth += 1) {
            if (cursor === concat[0]) return id;
            const upstream = workflow[cursor];
            if (!upstream) break;
            const next = Object.entries(upstream.inputs || {}).find(([field, value]) => /image/i.test(field) && Array.isArray(value));
            cursor = next && Array.isArray(next[1]) ? String((next[1] as unknown[])[0]) : "";
        }
    }
    return "";
}

// MiniMax H3 reference-to-video clip graphs — one clip out, no storyboard sheet. The same graph
// shape ships as two published models per host (the sampler chain differs — 8-step turbo LoRA vs a
// 4-step DMAD LoRA with ExtendIntermediateSigmas/BlockSparseAttention/SigmaShift — but none of
// those are user-facing knobs, and every knob the adapter does touch sits at the same node id):
//   氛围感短视频:   2107016187795304449 (runninghub.cn) / 2107014873040396289 (runninghub.ai)
//   官流单采极速文戏: 2107149772913201154 (runninghub.cn) / 2107045636834172929 (runninghub.ai)
//                    + 2107156102268940290 (runninghub.cn, another published copy of the same graph)
//
// The generic writers reach the prompt and the two reference loaders by luck of the field names
// (`value`/`image` are both in PROMPT_FIELDS / the LoadImage scan), but they miss everything else —
// and the misses are not cosmetic:
//   - duration is a PrimitiveFloat titled "Float (Duration)" (node 132, field `value`); the
//     seconds writer only probes duration/seconds/video_length, so every render ignored the canvas
//     duration and kept the author's baked 10s. Worse, `writeRunningHubSeconds` DOES match the
//     sampler's `length` input and would overwrite the ComfyMathExpression node 131 output with a
//     raw second count — H3 only accepts lengths of the form 17n+5, so that input is a *link*, and
//     the guard there (`length <= 30`) happens to skip it. Pinning the duration at 132 is what
//     makes the linked math expression re-derive a legal frame count;
//   - output shape is a ResolutionSelector (115) whose aspect_ratio is a label enum
//     ("9:16 (Portrait Widescreen)") the aspect writer cannot produce, and whose `megapixels` the
//     tier writer force-maps 1k/2k/4k → 1/2/4 (this graph ships `megapixels: 1` and `multiple: 32`,
//     so a 2k/4k canvas size would silently rescale the whole render);
//   - `writeRunningHubSize` matches ANY node carrying width+height, so it would write the canvas
//     pixel pair onto the sampler's linked `width`/`height` inputs — but those are *links* to the
//     ResolutionSelector, so the write is skipped. The selector is the only real lever;
//   - RandomNoise (129) bakes a fixed seed, so identical inputs repeated an identical clip.
//
// Reference images: both slots are wired LoadImage → sampler DIRECTLY (no AutoCropFaces chain,
// unlike the four-view graph), so the loader for a slot is its link target — one hop, no walk.
// Both loaders ship the author's baked demo photos; leaving an unfilled slot wired would render a
// stranger's character into the clip, so unfilled slots are disconnected instead.
const MINIMAX_H3_REFERENCE_CLIP_WORKFLOW_IDS = new Set([
    "2107016187795304449",
    "2107014873040396289",
    "2107149772913201154",
    "2107045636834172929",
    "2107156102268940290",
]);
/** H3 accepts lengths of the form 17n+5; the graph's own math node enforces the minimum of 5. */
const MINIMAX_H3_VIBE_SHORT_SECONDS = { min: 2, max: 20 };

function isMinimaxH3ReferenceClipWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    // Both hosts share the graph shape but have their own saved copy under a different id, so the
    // gate matches the bare id or any `::`-separated / prefixed runtime form of it.
    return raw.split("::").some((segment) => {
        const id = segment.trim().replace(/^(rh|runninghub|workflow)[:_-]/, "").trim();
        return MINIMAX_H3_REFERENCE_CLIP_WORKFLOW_IDS.has(id);
    });
}

/**
 * Public gate for the H3 clip-only graph family (氛围感短视频 + 官流单采极速文戏): the image path
 * hands a clip-only finish back to the canvas, and the duration/resolution knobs are honored there.
 */
export function isMinimaxH3VibeShortWorkflowId(workflowId?: string | null) {
    return isMinimaxH3ReferenceClipWorkflow(workflowId);
}

/**
 * The reference-to-video node and its `ref_images.ref_image_N` slots. Unlike the four-view graph
 * the slot link target IS the loader, so no link walk is needed — but the slots are still resolved
 * by index, never by LoadImage id order (which is the reverse here: slot 0 → 137, slot 1 → 139).
 */
function minimaxH3ReferenceVideoSlots(workflow: ComfyWorkflow) {
    const consumer = Object.entries(workflow).find(([, node]) => /MiniMaxH3ReferenceToVideo/i.test(String(node?.class_type || "")));
    if (!consumer) return null;
    const [consumerId, node] = consumer;
    const slots: Array<{ index: number; key: string; sourceId: string }> = [];
    for (const [key, value] of Object.entries(node.inputs || {})) {
        const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
        if (!match) continue;
        const sourceId = Array.isArray(value) ? String(value[0]) : "";
        if (sourceId) slots.push({ index: Number(match[1]), key, sourceId });
    }
    if (!slots.length) return null;
    slots.sort((a, b) => a.index - b.index);
    return { consumerId, consumer: node, slots };
}

function applyMinimaxH3VibeShortSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // Reference images → `<Picture 1>`/`<Picture 2>` slot order. Each slot's link target is its
    // loader, so writing the loader is enough; an unfilled slot is disconnected from the sampler
    // so the author's baked demo photo cannot leak into the render.
    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loader = next[slot.sourceId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            const consumerInputs = consumer.inputs;
            if (consumerInputs && slot.key in consumerInputs) {
                delete consumerInputs[slot.key];
                disconnected.push(slot.sourceId);
                structuralRepair = true;
            }
        });
    } else if (imageValues.length) {
        // The graph served by RunningHub doesn't match the saved structure closely enough to find
        // the reference slots. Never silently render the baked demo images: fall back to the
        // generic mapping (each uploaded reference onto a LoadImage, document order) so the
        // references at least reach the task.
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    // A disconnected slot's loader is now dead weight that still carries the author's baked demo
    // photo — drop it so a stale filename cannot reach the task payload at all.
    if (disconnected.length && pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    // The one failure mode worse than an error: the user hands over references, the task renders
    // anyway, and the clip has nothing to do with them. If none of the uploaded references landed
    // in the graph, stop instead of burning credits on the baked demo.
    if (imageValues.length && !writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // Duration → PrimitiveFloat "Float (Duration)" (node 132, field `value`). The linked
    // ComfyMathExpression (131) turns this into a 17n+5 frame count, so only the seconds are set
    // here — touching the sampler's `length` link would break H3's length constraint.
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_VIBE_SHORT_SECONDS.max, Math.max(MINIMAX_H3_VIBE_SHORT_SECONDS.min, duration));
        const durationNode =
            next["132"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // Output shape → ResolutionSelector (115): aspect_ratio is a label enum, megapixels a number.
    // The canvas aspect wins when given; otherwise the baked default stands. Megapixels is only
    // written when the caller explicitly asks (video precision), and never below the baked floor —
    // this graph bakes 1 with `multiple: 32`, and the generic tier writer would force 2/4 onto it.
    const selector = next["115"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        const requested = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(requested) && requested > 0) {
            const baked = typeof selector.inputs.megapixels === "number" ? Number(selector.inputs.megapixels) : 0;
            selector.inputs.megapixels = Math.max(baked, requested);
        }
    }

    // Prompt → the multiline node the sampler's `prompt` link resolves to (node 138). Written last
    // so an empty canvas prompt keeps the author's baked text rather than blanking it.
    // ⚠️ 空提示词也要写。作者导出里那个 prompt 节点（138）塞着一段示例台词，
    // 「prompt 为空就不写」等于把作者的示例台词原样念出来 —— 用户「总是出现我没写过的台词」
    // 最像这个（示例台词是作者写死的，所以每次都是同一批句子）。
    {
        const consumer = minimaxH3ReferenceVideoSlots(next)?.consumer;
        const sourceId = consumer ? minimaxH3FourViewPromptSource(next, consumer) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["138"] ||
            findComfyNode(next, (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;

        // 兜底清扫：同图里其它**文本节点**上的作者示例一律清空，
        // 万一上面挑错了节点，也不会把别人的台词当成本片台词念出来。
        // ⚠️ 2026-10-25 第二次返工：判据原来是「只有带 `<d>` 才清」，可作者那份示例不一定是 `<d>` 写法
        // （也可能就是 `苏晚：你终于来了` 这种自然语言），漏网的示例照样会被念成「没说过的台词」。
        // 现在改成「像台词/示例就清」：带 `<d>`、带 `(S1)`、带 `says:`、或「名字＋说/道/问/喊：」开头；
        // 另外 `138` 是作者写死示例台词的固定落点（见 `4967cc2`），只要它不是本次提示词落点就无条件清空 ——
        // 用户 2026-10-25「还是自动乱说话…这次是乱说中文」，头号嫌疑就是这类没带标记的示例。
        const promptNodeId = promptNode ? Object.keys(next).find((id) => next[id] === promptNode) || "" : "";
        for (const [id, node] of Object.entries(next)) {
            if (id === promptNodeId) continue;
            if (!/PrimitiveString|CLIPTextEncode|^Text$|String/i.test(String(node?.class_type || ""))) continue;
            const inputs = (node?.inputs || {}) as Record<string, unknown>;
            const value = inputs.value ?? inputs.text;
            if (typeof value !== "string" || !value.trim()) continue;
            const looksLikeExampleDialogue =
                id === "138" ||
                /<\s*d\s*>/i.test(value) ||
                /\(\s*S\d+\s*\)/.test(value) ||
                /\bsays\s*[:：]/i.test(value) ||
                /(?:^|\n)\s*[^：:\n]{1,12}\s*(?:说|道|问|喊)\s*[：:]/.test(value);
            if (!looksLikeExampleDialogue) continue;
            if ("value" in inputs) inputs.value = "";
            else if ("text" in inputs) inputs.text = "";
        }
    }

    // The graph bakes a fixed noise seed — identical inputs would render an identical clip on
    // every run. Randomize per submission.
    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
    }

    return { workflow: next, structuralRepair };
}

// MiniMax H3 真·上下文无缝无色差长视频 SelfLift 双采(简易版) — runninghub.ai 2108476378258038785.
// The same SelfLift family as the native U37 graph: a single H3 reference-to-video node (136) whose
// `width`/`height` are LINKS into the delivered ResolutionSelector (115) and whose `length` is a LINK
// to a ComfyMathExpression (131, 17n+5) driven by the Float (Duration) primitive (132), sampled by
// `SelfLiftH3Sampler` (250). None of the generic RunningHub writers reach those knobs:
//   - writeRunningHubSize only writes onto a node that exposes scalar `width`+`height`; 136's pair
//     are links it follows into 115, which holds a label enum ("9:16 (Portrait Widescreen)") and no
//     scalar `value`/`int`/`number` field — so the canvas shape was silently ignored;
//   - writeRunningHubTier sees the selector's numeric `megapixels: 2` inside its [1,2,4] set and
//     force-maps it to the size tier, silently rescaling the render;
//   - writeRunningHubSeconds only rewrites a scalar `length` ≤ 30; the clip's sole length is the math
//     link and the duration scalar is 132's `value` (a field none of its names match), so the canvas
//     duration never landed — every run stayed at the baked 5s;
//   - nothing generic randomizes seeds, so `SelfLiftH3Sampler.seed: 42` replayed the same clip.
// Reference slots are resolved by `ref_images.ref_image_N` index, never by LoadImage node id order:
// here the id order swaps slots 5/6 (313 < 314 as ids, yet ref_image_5 → 314, ref_image_6 → 313).
const MINIMAX_H3_SELFLIFT_WORKFLOW_IDS = new Set(["2108476378258038785"]);
/** H3 lengths are 17n+5; the graph's math node floors that at 5s and the canvas UI caps duration at 30s. */
const MINIMAX_H3_SELFLIFT_SECONDS = { min: 2, max: 30 };

function isMinimaxH3SelfLiftWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment.trim().replace(/^(rh|runninghub|workflow)[:_-]/, "").trim();
        return MINIMAX_H3_SELFLIFT_WORKFLOW_IDS.has(id);
    });
}

/**
 * Public gate for the SelfLift 双采(简易版) graph: it renders a clip only (SaveVideo → CreateVideo),
 * so the image path hands a video back and the duration/resolution knobs are honored there.
 */
export function isMinimaxH3SelfLiftWorkflowId(workflowId?: string | null) {
    return isMinimaxH3SelfLiftWorkflow(workflowId);
}

function applyMinimaxH3SelfLiftSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // Reference images → `<Picture 1>`… slot order, keyed by `ref_images.ref_image_N` index. A slot
    // the user did not fill is disconnected and its loader pruned: slot 0 ships the author's baked
    // character sheet (a stranger's face would otherwise render into the clip), and leaving the
    // spare slots wired keeps their literal "None" loaders in the task payload for nothing.
    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loader = next[slot.sourceId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            const consumerInputs = consumer.inputs;
            if (consumerInputs && slot.key in consumerInputs) {
                delete consumerInputs[slot.key];
                disconnected.push(slot.sourceId);
                structuralRepair = true;
            }
        });
    } else if (imageValues.length) {
        // The graph served by RunningHub does not expose the reference slots we expect. Never
        // silently render the baked character sheet: fall back to the generic mapping (each upload
        // onto a LoadImage, document order) so the references at least reach the task.
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    if (disconnected.length && pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    if (imageValues.length && !writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // Duration → the PrimitiveFloat (132) the sampler's `length` math link reads. Only the seconds
    // are written: 131 turns them into a 17n+5 frame count, so touching the `length` link would break
    // H3's length constraint.
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_SELFLIFT_SECONDS.max, Math.max(MINIMAX_H3_SELFLIFT_SECONDS.min, duration));
        const durationNode =
            next["132"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // Output shape → ResolutionSelector (115), the *delivered* size since the H3 node links into it.
    // The canvas aspect wins when given, and an explicit precision follows the picker; an unset
    // ("auto"/empty) pair keeps the author's baked 9:16 @2MP verbatim.
    const selector = next["115"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        const requested = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(requested) && requested > 0 && typeof selector.inputs.megapixels === "number") {
            selector.inputs.megapixels = requested;
        }
    }

    // Prompt → the multiline node the sampler's `prompt` link resolves to (138). Written last so an
    // empty canvas prompt keeps the author's baked text rather than blanking it.
    // ⚠️ 空提示词也要写。作者导出里那个 prompt 节点（138）塞着一段示例台词，
    // 「prompt 为空就不写」等于把作者的示例台词原样念出来 —— 用户「总是出现我没写过的台词」
    // 最像这个（示例台词是作者写死的，所以每次都是同一批句子）。
    {
        const consumer = minimaxH3ReferenceVideoSlots(next)?.consumer;
        const sourceId = consumer ? minimaxH3FourViewPromptSource(next, consumer) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["138"] ||
            findComfyNode(next, (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;

        // 兜底清扫：同图里其它**文本节点**上的作者示例一律清空，
        // 万一上面挑错了节点，也不会把别人的台词当成本片台词念出来。
        // ⚠️ 2026-10-25 第二次返工：判据原来是「只有带 `<d>` 才清」，可作者那份示例不一定是 `<d>` 写法
        // （也可能就是 `苏晚：你终于来了` 这种自然语言），漏网的示例照样会被念成「没说过的台词」。
        // 现在改成「像台词/示例就清」：带 `<d>`、带 `(S1)`、带 `says:`、或「名字＋说/道/问/喊：」开头；
        // 另外 `138` 是作者写死示例台词的固定落点（见 `4967cc2`），只要它不是本次提示词落点就无条件清空 ——
        // 用户 2026-10-25「还是自动乱说话…这次是乱说中文」，头号嫌疑就是这类没带标记的示例。
        const promptNodeId = promptNode ? Object.keys(next).find((id) => next[id] === promptNode) || "" : "";
        for (const [id, node] of Object.entries(next)) {
            if (id === promptNodeId) continue;
            if (!/PrimitiveString|CLIPTextEncode|^Text$|String/i.test(String(node?.class_type || ""))) continue;
            const inputs = (node?.inputs || {}) as Record<string, unknown>;
            const value = inputs.value ?? inputs.text;
            if (typeof value !== "string" || !value.trim()) continue;
            const looksLikeExampleDialogue =
                id === "138" ||
                /<\s*d\s*>/i.test(value) ||
                /\(\s*S\d+\s*\)/.test(value) ||
                /\bsays\s*[:：]/i.test(value) ||
                /(?:^|\n)\s*[^：:\n]{1,12}\s*(?:说|道|问|喊)\s*[：:]/.test(value);
            if (!looksLikeExampleDialogue) continue;
            if ("value" in inputs) inputs.value = "";
            else if ("text" in inputs) inputs.text = "";
        }
    }

    // VRAM: `SelfLiftH3Sampler` ("SelfLift Progressive Sampler") draws a low-res pass at
    // `lowres_scale` and then upscales the whole frame to full size. This export ships
    // `highres_tiling: false`, so that upscale pass holds the entire frame in VRAM at once and long
    // clips die with an OOM ("显存不足"). Flip the sampler's own memory switch on: it tiles the
    // high-res pass, cutting peak VRAM only — the delivered duration and resolution are untouched.
    // The sibling SelfLift graph (U32) ships it on, so this is the author's supported mode.
    for (const node of Object.values(next)) {
        if (/SelfLiftH3Sampler/i.test(String(node.class_type || "")) && typeof node.inputs?.highres_tiling === "boolean") {
            node.inputs.highres_tiling = true;
        }
    }

    // SelfLift hard-requires the standard Euler sampler (KSamplerSelect → SelfLiftH3Sampler).
    // Keep the author's `euler` even if a stale export drifted away from it.
    for (const node of Object.values(next)) {
        if (/KSamplerSelect/i.test(String(node.class_type || "")) && node.inputs && "sampler_name" in node.inputs) {
            node.inputs.sampler_name = "euler";
        }
    }

    // `SelfLiftH3Sampler` parks the run seed in its own `seed` field, and its class name carries
    // neither "KSampler" nor "RandomNoise", so every shared randomizer misses it — identical inputs
    // would render an identical clip forever. Randomize per submission.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/RandomNoise/i.test(type) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        else if (/SamplerCustom|KSampler|SelfLiftH3Sampler/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    // Always structural: unused reference slots are disconnected above, and the local Export (API)
    // JSON path (used when the shared workflow denies getJsonApiFormat) can only run by submitting
    // the full graph. Returning graph every time keeps both routes on the same contract.
    return { workflow: next, structuralRepair: true };
}

// MiniMax H3 Ref 顶级多参（不偏色不油光）— runninghub.cn 2108554342591717378.
// Single-pass Ref2VA: MiniMaxH3ReferenceToVideo (153) with width/height links into
// ResolutionSelector (115), length via Float (Duration) (132) → ComfyMathExpression (131).
// The user idea text lives in PrimitiveStringMultiline (220) → QwenH3PromptLocal (219) →
// YC_ShowText (215) → H3 `prompt`; CLIPTextEncode (199) is a fixed anti-oil negative.
// Reference slot `ref_image_0` links through ImageResizeKJv2 (155) into LoadImage (137) — the
// vibe-short writer only knows direct LoadImage targets, so it would disconnect the only slot
// and throw "reference not applied". Generic prompt/size/tier writers also miss 220 / 115 / 132.
// Scoped to this one id only (previously mis-listed under the Klein T2I allow-list).
const MINIMAX_H3_REF_TOP_WORKFLOW_IDS = new Set(["2108554342591717378"]);
const MINIMAX_H3_REF_TOP_SECONDS = { min: 2, max: 30 };

function isMinimaxH3RefTopWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment.trim().replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "").trim();
        return MINIMAX_H3_REF_TOP_WORKFLOW_IDS.has(id);
    });
}

/** Public gate: clip-only H3 Ref graph (image path may hand a video back). */
export function isMinimaxH3RefTopWorkflowId(workflowId?: string | null) {
    return isMinimaxH3RefTopWorkflow(workflowId);
}

/** Walk ImageResize / pass-throughs to the LoadImage that actually holds the filename. */
function resolveComfyImageLoaderId(workflow: ComfyWorkflow, startId: string, depth = 0): string {
    if (!startId || depth > 6) return "";
    const node = workflow[startId];
    if (!node) return "";
    if (/LoadImage/i.test(String(node.class_type || "")) && imageFieldName(node)) return startId;
    for (const field of ["image", "images", "url", "source", "input"]) {
        const value = node.inputs?.[field];
        if (!Array.isArray(value) || value[0] == null) continue;
        const found = resolveComfyImageLoaderId(workflow, String(value[0]), depth + 1);
        if (found) return found;
    }
    for (const value of Object.values(node.inputs || {})) {
        if (!Array.isArray(value) || value[0] == null) continue;
        const found = resolveComfyImageLoaderId(workflow, String(value[0]), depth + 1);
        if (found) return found;
    }
    return "";
}

/**
 * User idea text for QwenH3PromptLocal: prefer the multiline feeding that node's `prompt`, not the
 * H3 sampler's baked ShowText / negative CLIP slots the generic scorer would hit.
 */
function minimaxH3RefTopPromptNodeId(workflow: ComfyWorkflow): string {
    const optimizer = Object.entries(workflow).find(([, node]) => /QwenH3PromptLocal/i.test(String(node?.class_type || "")));
    if (optimizer) {
        const link = optimizer[1].inputs?.prompt;
        const sourceId = Array.isArray(link) ? String(link[0]) : "";
        if (sourceId && workflow[sourceId]?.class_type === "PrimitiveStringMultiline") return sourceId;
    }
    const titled = Object.entries(workflow).find(
        ([, node]) =>
            node.class_type === "PrimitiveStringMultiline" &&
            typeof node.inputs?.value === "string" &&
            /Input Text \(Prompt\)|提示词|prompt/i.test(String(node._meta?.title || "")),
    );
    if (titled) return titled[0];
    return workflow["220"] ? "220" : "";
}

function applyMinimaxH3RefTopSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // Reference → walk Resize → LoadImage. Unfilled slots are disconnected so the author's baked
    // demo face cannot leak; require at least one upload when the user provided any.
    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loaderId = resolveComfyImageLoaderId(next, slot.sourceId) || slot.sourceId;
            const loader = next[loaderId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            const consumerInputs = consumer.inputs;
            if (consumerInputs && slot.key in consumerInputs) {
                delete consumerInputs[slot.key];
                disconnected.push(slot.sourceId);
                if (loaderId !== slot.sourceId) disconnected.push(loaderId);
                structuralRepair = true;
            }
        });
        // QwenH3PromptLocal also wires `reference_images.reference_image_0` into the same resize —
        // drop unused keys there too so a disconnected resize chain is fully unused.
        for (const node of Object.values(next)) {
            if (!/QwenH3PromptLocal/i.test(String(node.class_type || "")) || !node.inputs) continue;
            for (const key of Object.keys(node.inputs)) {
                if (!/^reference_images\.reference_image_\d+$/.test(key)) continue;
                const link = node.inputs[key];
                const sourceId = Array.isArray(link) ? String(link[0]) : "";
                if (sourceId && disconnected.includes(sourceId)) {
                    delete node.inputs[key];
                    structuralRepair = true;
                }
            }
        }
    } else if (imageValues.length) {
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    if (disconnected.length && pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    if (imageValues.length && !writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_REF_TOP_SECONDS.max, Math.max(MINIMAX_H3_REF_TOP_SECONDS.min, duration));
        const durationNode =
            next["132"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    const selector = next["115"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        const requested = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(requested) && requested > 0) {
            const baked = typeof selector.inputs.megapixels === "number" ? Number(selector.inputs.megapixels) : 0;
            selector.inputs.megapixels = Math.max(baked > 0 ? baked : 0, requested);
        }
    }

    if (prompt.trim()) {
        const promptId = minimaxH3RefTopPromptNodeId(next);
        const promptNode = promptId ? next[promptId] : undefined;
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;
    }

    // RandomNoise + QwenH3PromptLocal seed — fixed seeds would replay the same clip / rewrite.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/RandomNoise/i.test(type) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        if (/QwenH3PromptLocal/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    // Always structural: local Export (API) JSON is the runnable copy when getJsonApiFormat denies.
    return { workflow: next, structuralRepair: true };
}

// AIGC特异点 MiniMax-H3 多参考双采放大（Singularity）
// runninghub.ai 2110419404622643201 / runninghub.cn 2110419416746909698.
// Export: AIGC特异点-Minimax-H3多参考双采放大生成视频（Singularity）_api.json
//
// Shape: MiniMaxH3ReferenceToVideo (265) + ResolutionSelector (252, DRAFT) × LatentUpscaler3D (140)
// scale 1.5 + PrimitiveFloat 时长 (259) → ComfyMathExpression (250) + Text prompt (263) +
// dual SamplerCustomAdvanced. Generic writers break this graph:
//   - prompt lives on a `Text` node (`text`), not PrimitiveStringMultiline (`value`);
//   - size/tier writers miss ResolutionSelector labels and would treat draft MP as delivered;
//   - seconds writer cannot reach the Float behind the 17n+5 math link;
//   - baked pasted/ hash LoadImages + empty VHS_LoadVideo / LoadAudio("None") fail on RH machines.
// Scoped to these two ids only.
const MINIMAX_H3_SINGULARITY_WORKFLOW_IDS = new Set(["2110419404622643201", "2110419416746909698"]);
const MINIMAX_H3_SINGULARITY_SECONDS = { min: 2, max: 30 };
const MINIMAX_H3_SINGULARITY_MAX_DELIVERED_MP = 4;

function isMinimaxH3SingularityWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return MINIMAX_H3_SINGULARITY_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the Singularity 双采放大 clip graph on RunningHub. */
export function isMinimaxH3SingularityWorkflowId(workflowId?: string | null) {
    return isMinimaxH3SingularityWorkflow(workflowId);
}

/** Canvas quality / megapixels string → delivered MP budget for Singularity draft math. */
function singularityDeliveredMegapixels(quality: string) {
    const raw = String(quality || "")
        .trim()
        .toLowerCase();
    if (!raw) return 0;
    if (/2k|1440|2560|high/.test(raw)) return 3.69;
    if (/1080|hd/.test(raw)) return 2.07;
    if (/900|准高清|mid/.test(raw)) return 1.44;
    if (/720|sd|medium|auto/.test(raw)) return 0.92;
    if (/480|low/.test(raw)) return 0.41;
    const numeric = Number(raw.replace(/p$/i, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    // Already a megapixel budget (story-style) vs a long-edge pixel label.
    if (numeric <= 16) return numeric;
    if (numeric >= 2000) return 3.69;
    if (numeric >= 1080) return 2.07;
    if (numeric >= 720) return 0.92;
    return 0;
}

/** LatentUpscaler3D scale multiplier (author bake: easy float 1.5), or null. */
function singularityUpscaleFactor(workflow: ComfyWorkflow): number | null {
    for (const node of Object.values(workflow)) {
        if (!/MinimaxH3LatentUpscaler3D/i.test(String(node?.class_type || ""))) continue;
        const raw = node.inputs?.["mode.scale"] ?? node.inputs?.scale_by;
        if (typeof raw === "number" && raw > 0) return raw;
        if (Array.isArray(raw) && raw[0] != null) {
            const source = workflow[String(raw[0])]?.inputs;
            for (const key of ["value", "float", "number", "Number", "int"]) {
                const value = Number(source?.[key]);
                if (Number.isFinite(value) && value > 0) return value;
            }
        }
    }
    return null;
}

function applyMinimaxH3SingularitySettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    let next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // Drop author-only junk nodes that never feed the sampler chain.
    for (const [id, node] of Object.entries(next)) {
        if (/忽略多组|孤海/.test(String(node?.class_type || ""))) {
            delete next[id];
            structuralRepair = true;
        }
    }

    // Reference images → ref_image_N slot order. Unfilled slots (incl. author pasted/ hashes) are
    // disconnected so RH cannot load missing filenames; empty video/audio slots are dropped too.
    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (!imageValues.length) throw new Error(apiText("runningHubReferenceNotApplied"));
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loader = next[slot.sourceId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            if (consumer.inputs && slot.key in consumer.inputs) {
                delete consumer.inputs[slot.key];
                disconnected.push(slot.sourceId);
                structuralRepair = true;
            }
        });
        // Empty VHS video / LoadAudio("None") fail validation on RunningHub — disconnect them.
        for (const key of Object.keys(consumer.inputs || {})) {
            if (!/^ref_(videos|audios)\./.test(key)) continue;
            const link = consumer.inputs?.[key];
            const sourceId = Array.isArray(link) ? String(link[0]) : "";
            const media = sourceId ? next[sourceId] : undefined;
            if (!media?.inputs) {
                delete consumer.inputs![key];
                structuralRepair = true;
                continue;
            }
            const type = String(media.class_type || "");
            const video = String(media.inputs.video || "").trim();
            const audio = String(media.inputs.audio || "").trim();
            const emptyVideo = /VHS_LoadVideo|LoadVideo/i.test(type) && !video;
            const emptyAudio = /LoadAudio/i.test(type) && (!audio || /^none$/i.test(audio));
            if (emptyVideo || emptyAudio) {
                delete consumer.inputs![key];
                disconnected.push(sourceId);
                structuralRepair = true;
            }
        }
    } else {
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    if (disconnected.length) {
        for (const id of disconnected) {
            if (next[id] && /LoadAudio|VHS_LoadVideo|LoadVideo/i.test(String(next[id]?.class_type || ""))) {
                delete next[id];
                structuralRepair = true;
            }
        }
        if (pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    }
    if (!writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // Duration → PrimitiveFloat「视频时长（秒）」(259) feeding the 17n+5 math link.
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_SINGULARITY_SECONDS.max, Math.max(MINIMAX_H3_SINGULARITY_SECONDS.min, duration));
        const durationNode =
            next["259"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // Draft ResolutionSelector (252): aspect from canvas; megapixels = delivered / scale² so the
    // LatentUpscaler3D pass lands on the requested tier (author bake 0.5 × 1.5² ≈ 1.1 MP).
    const selector = next["252"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        const delivered = singularityDeliveredMegapixels(megapixels);
        if (delivered > 0 && typeof selector.inputs.megapixels === "number") {
            const scale = singularityUpscaleFactor(next) || 1.5;
            const authored = Number(selector.inputs.megapixels) || 0.5;
            const budget = Math.min(delivered, MINIMAX_H3_SINGULARITY_MAX_DELIVERED_MP);
            const draft = Math.max(0.1, Math.round((budget / (scale * scale)) * 100) / 100);
            selector.inputs.megapixels = Math.max(authored, draft);
        }
    }

    // Prompt → Text (263) linked from H3 `prompt` (field is `text`, not `value`).
    if (prompt.trim()) {
        const consumer = minimaxH3ReferenceVideoSlots(next)?.consumer;
        const link = consumer?.inputs?.prompt;
        const sourceId = Array.isArray(link) ? String(link[0]) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["263"] ||
            findComfyNode(next, (node) => /^Text$/i.test(String(node.class_type || "")) && typeof node.inputs?.text === "string");
        if (promptNode?.inputs) {
            if (typeof promptNode.inputs.text === "string") promptNode.inputs.text = prompt;
            else if (typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;
        }
    }

    // Latent upscaler: normalize mis-mapped widgets + prefer chunking on RH VRAM.
    next = repairSingularityLatentUpscaler(next);
    for (const node of Object.values(next)) {
        if (!/MinimaxH3LatentUpscaler3D/i.test(String(node?.class_type || "")) || !node.inputs) continue;
        if (typeof node.inputs.enable_chunking === "boolean") node.inputs.enable_chunking = true;
    }

    // Fixed RandomNoise seed would replay the same clip.
    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") {
            node.inputs.noise_seed = randomComfySeed();
        }
    }

    return { workflow: next, structuralRepair: true };
}

// MiniMax-H3 高速大动态 / 无劣化抗形变模糊（工作版）
// runninghub.ai 2110627951858757634 / runninghub.cn 2110628673236852738.
// Export: MiniMax-H3 高速大动态 _ 无劣化抗形变模糊工作流  （工作版）_api.json
//
// Shape: MiniMaxH3ReferenceToVideo (136) + ResolutionSelector (115, DELIVERED) +
// PrimitiveFloat (132) → ComfyMathExpression (131) + PrimitiveStringMultiline prompt (138) +
// dual SamplerCustomAdvanced (ManualSigmas split) + Semantic Bridge T8. No LatentUpscaler3D.
// Generic writers break this graph the same way as vibe-short / SelfLift:
//   - size/tier miss ResolutionSelector labels and would force megapixels ∈ {1,2,4};
//   - seconds cannot reach the Float behind the 17n+5 math link;
//   - baked hash LoadImages fail on RH machines.
// Do NOT prune `布尔孤海` — it drives the VRAM ifElse chain. Scoped to these two ids only.
const MINIMAX_H3_HD_DYNAMIC_WORKFLOW_IDS = new Set(["2110627951858757634", "2110628673236852738"]);
const MINIMAX_H3_HD_DYNAMIC_SECONDS = { min: 2, max: 30 };

function isMinimaxH3HdDynamicWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return MINIMAX_H3_HD_DYNAMIC_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the H3 高速大动态 / 无劣化 clip graph on RunningHub. */
export function isMinimaxH3HdDynamicWorkflowId(workflowId?: string | null) {
    return isMinimaxH3HdDynamicWorkflow(workflowId);
}

function applyMinimaxH3HdDynamicSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (!imageValues.length) throw new Error(apiText("runningHubReferenceNotApplied"));
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loader = next[slot.sourceId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            if (consumer.inputs && slot.key in consumer.inputs) {
                delete consumer.inputs[slot.key];
                disconnected.push(slot.sourceId);
                structuralRepair = true;
            }
        });
    } else {
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    if (disconnected.length && pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    if (!writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // Duration → PrimitiveFloat (132) feeding the 17n+5 math link (title is plain "Float").
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_HD_DYNAMIC_SECONDS.max, Math.max(MINIMAX_H3_HD_DYNAMIC_SECONDS.min, duration));
        const durationNode =
            next["132"] ||
            findComfyNode(
                next,
                (node) =>
                    /PrimitiveFloat/i.test(String(node.class_type || "")) &&
                    typeof node.inputs?.value === "number" &&
                    !Array.isArray(node.inputs.value),
            );
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // ResolutionSelector (115) is the sampler latent (no LatentUpscaler3D). Do not write
    // Singularity "delivered" budgets above the Export bake — that OOMs SamplerCustomAdvanced.
    const selector = next["115"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        const delivered = singularityDeliveredMegapixels(megapixels);
        if (delivered > 0 && typeof selector.inputs.megapixels === "number") {
            const authored = Number(selector.inputs.megapixels);
            const ceiling = Number.isFinite(authored) && authored > 0 ? authored : delivered;
            selector.inputs.megapixels = Math.min(delivered, ceiling);
        }
    }

    // Prompt → PrimitiveStringMultiline (138) linked from H3 `prompt`.
    // ⚠️ 空提示词也要写。作者导出里那个 prompt 节点（138）塞着一段示例台词，
    // 「prompt 为空就不写」等于把作者的示例台词原样念出来 —— 用户「总是出现我没写过的台词」
    // 最像这个（示例台词是作者写死的，所以每次都是同一批句子）。
    {
        const consumer = minimaxH3ReferenceVideoSlots(next)?.consumer;
        const sourceId = consumer ? minimaxH3FourViewPromptSource(next, consumer) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["138"] ||
            findComfyNode(next, (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;

        // 兜底清扫：同图里其它**文本节点**上的作者示例一律清空，
        // 万一上面挑错了节点，也不会把别人的台词当成本片台词念出来。
        // ⚠️ 2026-10-25 第二次返工：判据原来是「只有带 `<d>` 才清」，可作者那份示例不一定是 `<d>` 写法
        // （也可能就是 `苏晚：你终于来了` 这种自然语言），漏网的示例照样会被念成「没说过的台词」。
        // 现在改成「像台词/示例就清」：带 `<d>`、带 `(S1)`、带 `says:`、或「名字＋说/道/问/喊：」开头；
        // 另外 `138` 是作者写死示例台词的固定落点（见 `4967cc2`），只要它不是本次提示词落点就无条件清空 ——
        // 用户 2026-10-25「还是自动乱说话…这次是乱说中文」，头号嫌疑就是这类没带标记的示例。
        const promptNodeId = promptNode ? Object.keys(next).find((id) => next[id] === promptNode) || "" : "";
        for (const [id, node] of Object.entries(next)) {
            if (id === promptNodeId) continue;
            if (!/PrimitiveString|CLIPTextEncode|^Text$|String/i.test(String(node?.class_type || ""))) continue;
            const inputs = (node?.inputs || {}) as Record<string, unknown>;
            const value = inputs.value ?? inputs.text;
            if (typeof value !== "string" || !value.trim()) continue;
            const looksLikeExampleDialogue =
                id === "138" ||
                /<\s*d\s*>/i.test(value) ||
                /\(\s*S\d+\s*\)/.test(value) ||
                /\bsays\s*[:：]/i.test(value) ||
                /(?:^|\n)\s*[^：:\n]{1,12}\s*(?:说|道|问|喊)\s*[：:]/.test(value);
            if (!looksLikeExampleDialogue) continue;
            if ("value" in inputs) inputs.value = "";
            else if ("text" in inputs) inputs.text = "";
        }
    }

    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") {
            node.inputs.noise_seed = randomComfySeed();
        }
    }

    return { workflow: next, structuralRepair: true };
}

// 【Work-Fisher】AI短剧制作全流程
// runninghub.ai 2110621324220567554 / runninghub.cn 2110621014144147458.
// Export: 【Work-Fisher】AI短剧制作全流程_api.json (multi-ref video graph).
//
// Shape: MiniMaxH3ReferenceToVideo (136) + 6×LoadImage refs + ResolutionSelector (115) +
// Float Duration (132) → math (131) + PrimitiveStringMultiline (138) + VHS_VideoCombine.
// Single-pass — no LatentUpscaler3D. Export bakes ResolutionSelector megapixels ≈ 0.8.
// Writing Singularity "delivered" budgets (720→0.92 / 1080→2.07) straight onto (115) inflates
// the SamplerCustomAdvanced latent and triggers RH 【VRAM OOM Alert】.
// The published RH app advertises 4 pipeline modes (多参生视频 / 角色资产 / 场景资产 / 多视角);
// this Export is the video graph only. Mode switching:
//   - plain Export JSON → always「多参生视频」;
//   - optional script bag `{ "video": {...}, "character": {...}, "scene": {...}, "multiview": {...} }`
//     selects the subgraph for the canvas mode pill.
// Scoped to these two ids only.
const MINIMAX_H3_FISHER_WORKFLOW_IDS = new Set([
    "2110621324220567554",
    "2110621014144147458",
    // ⚠️ 2026-10-25（用户要求）：runninghub.ai `2114341115852099586` **不是** Fisher 成员 ——
    // 它确实是同一张图的另一个发布 id，但用户要的是「独立模型，不要把那两个模型的改动加到它身上」。
    // 所以下面这一整套一概**不**作用于它：
    //   干净模式提示词 / `<Picture N>` 参考图绑定 / `视觉风格：…` 整行不发 / 示例台词清扫 /
    //   279 风格 LoRA 默认归零 / 0.8MP 天花板 / 时长夹 2–12s / 静音镜不挂音色 / 浏览器直传 / 内置 Export 图。
    // 它是「对照组」：走公开的通用 RunningHub 管线（模型脚本贴 Export → comfy/run，或远端取图）。
    // 加回来之前先问用户 —— 这是**故意**排除的，不是漏加（`runninghub-fisher-scope-probe` 反向锁着）。
]);
/** Export author bake is 10s; longer multi-ref clips OOM SamplerCustomAdvanced on RH. */
const MINIMAX_H3_FISHER_SECONDS = { min: 2, max: 12 };
/** Export bake ceiling — selector MP is the sampler latent on this single-pass graph. */
const MINIMAX_H3_FISHER_MAX_MEGAPIXELS = 0.8;

export type FisherPipelineMode = "video" | "character" | "scene" | "multiview";

const FISHER_MODE_SCRIPT_KEYS: Record<FisherPipelineMode, string[]> = {
    video: ["video", "多参生视频", "多参", "ref2v", "ref_video"],
    character: ["character", "角色", "角色资产", "角色资产图", "char"],
    scene: ["scene", "场景", "场景资产", "场景资产图"],
    multiview: ["multiview", "多视角", "多视角视图", "四视图", "four_view", "fourview"],
};

function isMinimaxH3FisherWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return MINIMAX_H3_FISHER_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the Work-Fisher short-drama pipeline on RunningHub. */
export function isMinimaxH3FisherWorkflowId(workflowId?: string | null) {
    return isMinimaxH3FisherWorkflow(workflowId);
}

/**
 * 2026-10-25 撤掉：曾经有一份内置的【Work-Fisher】AI短剧 Export (API) 图，只兜底 runninghub.ai
 * `2114341115852099586`（作者那份 `getJsonApiFormat` 对普通 key 是 ACL 拒绝的）。
 * 用户要求把这个 id 变回「独立模型、不吃那两个模型的任何特殊照顾」→ 内置图一并删掉：
 * 现在它和别的第三方 app 图一样，要么远端取图，要么把 Export JSON 贴进模型脚本。
 * 探针 `runninghub-fisher-scope-probe` 锁住「这个 id 拿不到任何内置图」。
 */

/**
 * 独立模型：runninghub.ai `2114341115852099586`（【Work-Fisher】AI短剧制作全流程 的另一份发布 id）。
 *
 * 用户 2026-10-25：「我需要让它是个独立的模型，不跟那两个模型混在一起修改…」（那两个 = `.ai
 * 2110621324220567554` / `.cn 2110621014144147458`）。
 * 用户 2026-10-26：「将这个独立模型移出 H3 家族的台词方言层，恢复到原本工作流的对话的内容输出逻辑」。
 *
 * 所以它**不在** `MINIMAX_H3_FISHER_WORKFLOW_IDS`，**也不在** `isMinimaxH3FamilyWorkflow`：
 *  - Fisher 那一整套（干净模式 / `<Picture N>` / 视觉风格整行不发 / 示例台词清扫 / 279 LoRA 归零 /
 *    0.8MP / 2–12s / 静音镜不挂音色 / 浏览器直传 / 内置 Export 图）**一条都不作用于它**；
 *  - 连 H3 全族共享的**台词方言层**（`<d>[语言]…</d>` / `(S1) says:` / `<Audio N>` 绑定声明 /
 *    剥分镜表骨架 / 撤模板尾巴 / 视觉风格行处理）也**不再作用**于它 —— 画布给的提示词**逐字原样**
 *    写进它自己那张图，对话内容怎么被念出来由作者工作流原本的逻辑决定，我们不做转写。
 * 只保留一条**通用**能力：模型脚本里贴 Export (API) JSON → `comfy/run` 提交
 * （`getJsonApiFormat` 对第三方 app 常是 ACL 拒），跟 SelfLift / Klein / 文武双全 同一条兜底。
 * 分辨率 / 时长 / LoRA / 提示词**全都不动**，用它自己图里烘焙的值。
 */
const STANDALONE_H3_EXPORT_WORKFLOW_IDS = new Set(["2114341115852099586"]);

function isStandaloneH3ExportWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return STANDALONE_H3_EXPORT_WORKFLOW_IDS.has(id);
    });
}

/** Public gate: 这个 id 是「独立模型」（不吃 Fisher 补丁，只保留 H3 方言 + 脚本贴 Export）。 */
export function isStandaloneH3ExportWorkflowId(workflowId?: string | null) {
    return isStandaloneH3ExportWorkflow(workflowId);
}

export function normalizeFisherPipelineMode(value?: string | null): FisherPipelineMode {    const raw = String(value || "")
        .trim()
        .toLowerCase();
    if (/character|角色/.test(raw)) return "character";
    if (/scene|场景/.test(raw)) return "scene";
    if (/multiview|多视角|四视|four/.test(raw)) return "multiview";
    return "video";
}

function looksLikeComfyApiWorkflow(value: unknown): value is ComfyWorkflow {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.prompt && typeof record.prompt === "object" && !Array.isArray(record.prompt)) {
        return looksLikeComfyApiWorkflow(record.prompt);
    }
    return Object.values(record).some((node) => node && typeof node === "object" && "class_type" in (node as object));
}

/**
 * Resolve the Fisher Export graph for the selected pipeline mode.
 * Plain API JSON = video mode. A mode bag supplies per-mode Export objects.
 */
export function resolveFisherWorkflowFromScript(script: string | undefined | null, mode: FisherPipelineMode): ComfyWorkflow | null {
    const trimmed = String(script || "").trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (looksLikeComfyApiWorkflow(parsed)) {
        if (mode !== "video") return null;
        return parseComfyApiWorkflow(trimmed);
    }
    for (const key of FISHER_MODE_SCRIPT_KEYS[mode]) {
        const entry = parsed[key];
        if (looksLikeComfyApiWorkflow(entry)) {
            return parseComfyApiWorkflow(JSON.stringify(entry));
        }
    }
    return null;
}

/**
 * Fisher 风格 LoRA（`MysticXXX_MMH3-V1`）权重档位。
 *
 * 2026-10-25 用户第三次报「还是有韩语、字幕、多余的乱台词」后的结论：
 * 前三轮回合全在提示词上加约束（旁白镜 / 口型约定 / 删掉声音说明），一条都没用 ——
 * 因为这三件事**不是提示词能管住的**：节点 136 `MiniMaxH3ReferenceToVideo` 没有字幕/语言开关，
 * 图里也没有任何字幕节点，字是模型「画」进画面的；而这支 LoRA 训练在真人韩剧素材上，
 * 自带韩语人声 + 硬字幕 + 顺口溜对白的先验，强度 0.5 时它会盖过提示词。
 * 所以把它做成档位，默认 0（纯官方 H3 底模 = 中文、无字幕、不自己加台词）。
 */
export const FISHER_LORA_STRENGTH_DEFAULT = 0;
export const FISHER_LORA_STRENGTH_OPTIONS = [0, 0.2, 0.35, 0.5] as const;

/** `""`/非法值一律落到默认档（0 = 关），把 1 以上夹到 1。 */
export function normalizeFisherLoraStrength(value?: string | number | null): number {
    const raw = Number(String(value ?? "").trim());
    if (!Number.isFinite(raw)) return FISHER_LORA_STRENGTH_DEFAULT;
    return Math.min(1, Math.max(0, raw));
}

function applyMinimaxH3FisherSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
    loraStrength: string | number = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    for (const [id, node] of Object.entries(next)) {
        if (/忽略多组|孤海/.test(String(node?.class_type || ""))) {
            delete next[id];
            structuralRepair = true;
        }
    }

    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (!imageValues.length) throw new Error(apiText("runningHubReferenceNotApplied"));
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loader = next[slot.sourceId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            if (consumer.inputs && slot.key in consumer.inputs) {
                delete consumer.inputs[slot.key];
                disconnected.push(slot.sourceId);
                structuralRepair = true;
            }
        });
    } else {
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    if (disconnected.length && pruneOrphanedReferenceChain(next, disconnected)) structuralRepair = true;
    if (!writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_FISHER_SECONDS.max, Math.max(MINIMAX_H3_FISHER_SECONDS.min, duration));
        const durationNode =
            next["132"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // ResolutionSelector (115) is the final latent size (no upscale pass). Cap to Export bake.
    const selector = next["115"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        if (typeof selector.inputs.megapixels === "number") {
            const authored =
                Number.isFinite(selector.inputs.megapixels) && selector.inputs.megapixels > 0
                    ? selector.inputs.megapixels
                    : MINIMAX_H3_FISHER_MAX_MEGAPIXELS;
            const ceiling = Math.min(authored, MINIMAX_H3_FISHER_MAX_MEGAPIXELS);
            const requested = singularityDeliveredMegapixels(megapixels);
            // Canvas 480 can go below bake; 720/900/1080 must not inflate past Export 0.8.
            selector.inputs.megapixels = requested > 0 ? Math.min(requested, ceiling) : ceiling;
        }
    }

    // Keep ref_image_size on the authored "match" contract from Export (node 136).

    // ⚠️ 静音镜这里**什么都不用改图**：
    // 唇动是 `<d>` 驱动的，没有 `<d>` 就已经不会对口型；再由适配器在正文末尾追加一句
    // `【静场】人物全程闭口…本镜只有环境音`（见 `withH3NarrationShotNote`）。所以：
    //   - 音轨照旧（用户要环境音效，`84f8517` 摘过，已撤回）；
    //   - 画面/采样/解码链路一个字节不动。
    // ⚠️ 这一句**绝不能再写成「声音是画外旁白」**（`e86f9dd` 那版）：那是给 H3 正向下单一条旁白，
    // 成片里就真有一条中文旁白 + 为它烧进画面的字幕（用户 2026-10-25「乱说中文 + 带字幕」）。
    //
    // ⚠️ 风格 LoRA 例外：`405ab7c` 把它归零过一次，后来为了「有声镜/静音镜质感一致」又撤回了
    // （`84f8517`）。但撤回之后用户第三次报「有韩语 / 有字幕 / 有多余台词」，说明这三点压根不是
    // 音轨和提示词的事 —— 是这支 LoRA 自带的先验。于是改成**可控档位、默认 0**（见上面
    // `FISHER_LORA_STRENGTH_OPTIONS`），要韩剧质感就把滑块拖回去，不拖就是干净的中文 H3。
    {
        const strength = normalizeFisherLoraStrength(loraStrength);
        const loraNode =
            next["279"] ||
            findComfyNode(
                next,
                (node) => /LoraLoader/i.test(String(node.class_type || "")) && /Mystic/i.test(String(node.inputs?.lora_name || "")),
            );
        if (loraNode?.inputs) {
            // 0 在 ComfyUI 里是短路（直接返回底模权重），比改 class_type 更稳：
            // 不动图结构，任何 worker 都认得这个分支。
            loraNode.inputs.strength_model = strength;
            if (typeof loraNode.inputs.strength_clip === "number") loraNode.inputs.strength_clip = strength;
        }
    }

    // ⚠️ 空提示词也要写。作者导出里那个 prompt 节点（138）塞着一段示例台词，
    // 「prompt 为空就不写」等于把作者的示例台词原样念出来 —— 用户「总是出现我没写过的台词」
    // 最像这个（示例台词是作者写死的，所以每次都是同一批句子）。
    {
        const consumer = minimaxH3ReferenceVideoSlots(next)?.consumer;
        const sourceId = consumer ? minimaxH3FourViewPromptSource(next, consumer) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["138"] ||
            findComfyNode(next, (node) => node.class_type === "PrimitiveStringMultiline" && typeof node.inputs?.value === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;

        // 兜底清扫：同图里其它**文本节点**上的作者示例一律清空，
        // 万一上面挑错了节点，也不会把别人的台词当成本片台词念出来。
        // ⚠️ 2026-10-25 第二次返工：判据原来是「只有带 `<d>` 才清」，可作者那份示例不一定是 `<d>` 写法
        // （也可能就是 `苏晚：你终于来了` 这种自然语言），漏网的示例照样会被念成「没说过的台词」。
        // 现在改成「像台词/示例就清」：带 `<d>`、带 `(S1)`、带 `says:`、或「名字＋说/道/问/喊：」开头；
        // 另外 `138` 是作者写死示例台词的固定落点（见 `4967cc2`），只要它不是本次提示词落点就无条件清空 ——
        // 用户 2026-10-25「还是自动乱说话…这次是乱说中文」，头号嫌疑就是这类没带标记的示例。
        const promptNodeId = promptNode ? Object.keys(next).find((id) => next[id] === promptNode) || "" : "";
        for (const [id, node] of Object.entries(next)) {
            if (id === promptNodeId) continue;
            if (!/PrimitiveString|CLIPTextEncode|^Text$|String/i.test(String(node?.class_type || ""))) continue;
            const inputs = (node?.inputs || {}) as Record<string, unknown>;
            const value = inputs.value ?? inputs.text;
            if (typeof value !== "string" || !value.trim()) continue;
            const looksLikeExampleDialogue =
                id === "138" ||
                /<\s*d\s*>/i.test(value) ||
                /\(\s*S\d+\s*\)/.test(value) ||
                /\bsays\s*[:：]/i.test(value) ||
                /(?:^|\n)\s*[^：:\n]{1,12}\s*(?:说|道|问|喊)\s*[：:]/.test(value);
            if (!looksLikeExampleDialogue) continue;
            if ("value" in inputs) inputs.value = "";
            else if ("text" in inputs) inputs.text = "";
        }
    }

    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") {
            node.inputs.noise_seed = randomComfySeed();
        }
    }

    return { workflow: next, structuralRepair: true };
}

// YZ金鱼 MiniMax H3 终极篇·文武双全 — runninghub.ai 2112546467369263106 /
// runninghub.cn 2112546421823070209. Export: YZ金鱼-MiniMax H3 终极篇-文武双全_api.json.
//
// Shape: MiniMaxH3ReferenceToVideo (265) whose `prompt` links to Text (263) and whose
// width/height link into ResolutionSelector (252); `length` comes from ComfyMathExpression (250)
// driven by PrimitiveFloat「视频时长（秒）」(259) so the 17n+5 frame contract stays intact. Sampling
// is `SelfLiftH3Sampler` (397) behind a two-LoRA stack (192 → 53 @0.8 → 400 @0.35) and the
// attention/sigma-shift/chunk chain (331 → 332 → 333 → 401 → 329). Media: 6 image refs
// (`ref_images.ref_image_0..5`), 1 video ref (`ref_videos.ref_video_0` → VHS_LoadVideo 27) and 3
// audio refs (`ref_audios.ref_audio_0..2` → LoadAudio 48/14/15).
//
// Every generic writer misses a knob here, and each miss is fatal rather than cosmetic:
//   - the size writer cannot produce `aspect_ratio`'s label enum and the tier writer force-maps
//     any `megapixels` onto a 1/2/4 set, silently rescaling the authored 1.5MP (1633×919 @16:9);
//   - the seconds writer cannot reach 259 (field `value`, title 视频时长) and must never touch
//     `length`, which is a *link* carrying H3's 17n+5 frame count;
//   - nothing randomizes `SelfLiftH3Sampler.seed` — its class name carries neither "KSampler" nor
//     "RandomNoise" — so identical inputs replayed an identical clip;
//   - LoadImage 49/50/51 ship baked hash filenames that do not exist on the workers while
//     19/23/43 ship `"None"`, so an unfilled image slot must be *disconnected* (a stranger's render
//     or a missing-file failure otherwise);
//   - VHS_LoadVideo (27) ships an empty path and LoadAudio 14/15/48 ship `"None"`; RunningHub
//     rejects those, so unfilled media slots are unlinked and pruned too.
//
// 文武双全 = text path and reference path are both first class: with no reference at all every
// `ref_images.*` link is dropped and the node degrades to plain text-to-video, so an empty ref list
// is NOT an error here (unlike the Singularity / Fisher adapters). Scoped to these two ids only.
const MINIMAX_H3_YZJINYU_WORKFLOW_IDS = new Set(["2112546467369263106", "2112546421823070209"]);
const MINIMAX_H3_YZJINYU_SECONDS = { min: 2, max: 30 };
/** SelfLift upscales internally, so the selector is the *delivered* size; 4MP is the safe ceiling. */
const MINIMAX_H3_YZJINYU_MAX_MEGAPIXELS = 4;

function isMinimaxH3YzjinyuWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return MINIMAX_H3_YZJINYU_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the H3 文武双全 clip graph (text-to-video + multi-ref, audio refs included). */
export function isMinimaxH3YzjinyuWorkflowId(workflowId?: string | null) {
    return isMinimaxH3YzjinyuWorkflow(workflowId);
}

function applyMinimaxH3YzjinyuSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    // Always structural: unused ref slots are unlinked below and the local Export (API) JSON path
    // (used when the shared workflow denies getJsonApiFormat) can only run by submitting the whole
    // graph. Returning graph every time keeps both routes on the same contract.
    const structuralRepair = true;

    // Author-only junk nodes (307/308/309/363): placeholders that never feed the sampler chain and
    // only bloat the payload.
    for (const [id, node] of Object.entries(next)) {
        if (/忽略多组|孤海/.test(String(node?.class_type || ""))) delete next[id];
    }

    // Reference images → `ref_images.ref_image_N` slot order, never LoadImage id order. The audio
    // refs were already written into 48/14/15 by applyRunningHubReferenceAudios *before* this runs.
    let writtenReferences = 0;
    const disconnected: string[] = [];
    const slotInfo = minimaxH3ReferenceVideoSlots(next);
    if (slotInfo) {
        const { consumer, slots } = slotInfo;
        slots.forEach((slot, position) => {
            const loader = next[slot.sourceId];
            const field = loader ? imageFieldName(loader) : "";
            const value = imageValues[position];
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
                return;
            }
            // Unfilled: drop the link so neither the baked hash nor the `"None"` placeholder reaches
            // the worker. Everything below re-links by slot key, so the order stays contiguous.
            if (consumer.inputs && slot.key in consumer.inputs) {
                delete consumer.inputs[slot.key];
                disconnected.push(slot.sourceId);
            }
        });
        // Empty video / audio slots fail validation on RunningHub (27 ships "" and 14/15/48 ship
        // "None" when the canvas brought no timbre reference).
        for (const key of Object.keys(consumer.inputs || {})) {
            if (!/^ref_(videos|audios)\./.test(key)) continue;
            const link = consumer.inputs?.[key];
            const sourceId = Array.isArray(link) ? String(link[0]) : "";
            const media = sourceId ? next[sourceId] : undefined;
            if (!media?.inputs) {
                delete consumer.inputs![key];
                continue;
            }
            const type = String(media.class_type || "");
            const video = String(media.inputs.video || "").trim();
            const audio = String(media.inputs.audio || "").trim();
            const emptyVideo = /VHS_LoadVideo|LoadVideo/i.test(type) && !video;
            const emptyAudio = /LoadAudio/i.test(type) && (!audio || /^none$/i.test(audio));
            if (emptyVideo || emptyAudio) {
                delete consumer.inputs![key];
                disconnected.push(sourceId);
            }
        }
    } else if (imageValues.length) {
        // Unexpected export: fall back to the generic mapping (upload → LoadImage, document order)
        // rather than silently rendering the author's baked references.
        const loaders = Object.entries(next).filter(([, node]) => /LoadImage/i.test(String(node?.class_type || "")) && imageFieldName(node));
        imageValues.forEach((value, index) => {
            const loader = loaders[index]?.[1];
            const field = loader ? imageFieldName(loader) : "";
            if (value && field && loader?.inputs) {
                loader.inputs[field] = value;
                writtenReferences += 1;
            }
        });
    }
    if (disconnected.length) {
        // VHS/LoadAudio 节点没有可保留的片段，直接整节点删掉（prune 只覆盖图片链）。
        for (const id of disconnected) {
            if (next[id] && /LoadAudio|VHS_LoadVideo|LoadVideo/i.test(String(next[id]?.class_type || ""))) delete next[id];
        }
        pruneOrphanedReferenceChain(next, disconnected);
    }
    // Only an unapplied *upload* is an error — a text-only run is legitimate for this graph.
    if (imageValues.length && !writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // Duration → PrimitiveFloat「视频时长（秒）」(259). Only the seconds are written: 250 turns them
    // into `max(5, round(s*24))` plus a modulus fix-up, so rewriting the `length` link would break
    // the 17n+5 contract.
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_YZJINYU_SECONDS.max, Math.max(MINIMAX_H3_YZJINYU_SECONDS.min, duration));
        const durationNode =
            next["259"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // Output shape → ResolutionSelector (252), which is the *delivered* size (the H3 node links its
    // width/height into it and SelfLift upscales internally). Lift-only: the delivered budget can
    // raise the authored 1.5MP bake but never drops below it, so picking 720p on the canvas cannot
    // silently downscale a graph the author shipped at ~919p.
    const selector = next["252"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        if (typeof selector.inputs.megapixels === "number") {
            const authored = Number(selector.inputs.megapixels);
            const base = Number.isFinite(authored) && authored > 0 ? authored : 1.5;
            const requested = singularityDeliveredMegapixels(megapixels);
            selector.inputs.megapixels = requested > 0 ? Math.min(Math.max(base, requested), MINIMAX_H3_YZJINYU_MAX_MEGAPIXELS) : base;
        }
    }

    // Prompt → whatever the H3 node's `prompt` link resolves to (Text node 263, field `text` — not
    // `value`). Written last so an empty canvas prompt keeps the author's baked text.
    if (prompt.trim()) {
        const consumer = minimaxH3ReferenceVideoSlots(next)?.consumer;
        const link = consumer?.inputs?.prompt;
        const sourceId = Array.isArray(link) ? String(link[0]) : "";
        const promptNode =
            (sourceId ? next[sourceId] : undefined) ||
            next["263"] ||
            findComfyNode(next, (node) => /^Text$/i.test(String(node.class_type || "")) && typeof node.inputs?.text === "string");
        if (promptNode?.inputs) {
            if (typeof promptNode.inputs.text === "string") promptNode.inputs.text = prompt;
            else if (typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;
        }
    }

    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        // `SelfLiftH3Sampler` draws a low-res pass then upscales to the full frame; with tiling off
        // that upscale holds the entire frame in VRAM and long clips die with "显存不足". The
        // author's sibling exports ship it on.
        if (/SelfLiftH3Sampler/i.test(type) && typeof node.inputs?.highres_tiling === "boolean") {
            node.inputs.highres_tiling = true;
        }
        // SelfLift hard-requires the standard Euler sampler (KSamplerSelect → 397).
        if (/KSamplerSelect/i.test(type) && node.inputs && "sampler_name" in node.inputs) {
            node.inputs.sampler_name = "euler";
        }
        // Fixed seed → every run replayed the same clip; the H3 sampler class name is matched by no
        // shared randomizer.
        if (/RandomNoise/i.test(type) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        else if (/SamplerCustom|KSampler|SelfLiftH3Sampler/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    return { workflow: next, structuralRepair };
}

// 【MINIMAX-H3】八月最强文戏（低配 / 高配）— runninghub.ai
//   低配 `2114557183900192769`  Export: 【MINIMAX-H3】八月最强文戏-低配版 _api.json
//   高配 `2114552017984241666`  Export: 【MINIMAX-H3】八月最强文戏-高配版_api.json
//
// 两张图都是 MiniMax H3 **Ref2VA 文戏片**：3 张参考图 + 2 条音色参考 + 0.5MP 草稿 + 1.5× latent
// 放大；提示词落在 `CR Prompt Text`（字段 `prompt`，既不是 `value` 也不是 `text`），时长是
// `PrimitiveFloat`「Float (duration)」→ `ComfyMathExpression` 的 17n+5 帧数链路。
// 通用写法在这里每一条都会出事，而且都不是观感问题，是「白烧一次渲染」：
//   - `writeRunningHubPrompt` 不认 `CR Prompt Text` → 作者写死的示例台词（Gu Yan / Xiao Yu /
//     私人飞机停机坪）原样进片。那是**作者的角色**，跟用户的镜头毫无关系；
//   - `writeRunningHubSize` 造不出 `ResolutionSelector.aspect_ratio` 的标签枚举
//     （`"16:9 (Widescreen)"`），`writeRunningHubTier` 又把 megapixels 硬映射到 1/2/4 ——
//     作者的 0.5MP 草稿被抬成 1MP，再乘 1.5² 就是 2.25MP 交付，RH 直接显存告警；
//   - `writeRunningHubSeconds` 够不到 `PrimitiveFloat`；而 `length` 是 17n+5 的**链接**，绝不能改；
//   - 参考图槽是 `ref_images.ref_image_N` → `LayerUtility: ImageScaleByAspectRatio V2` → `LoadImage`
//     三级链，槽目标**不是** LoadImage —— 只写槽目标等于没写，必须沿 `image` 链走到 LoadImage；
//   - 作者的 `LoadImage`（低配 525/526/527 · 高配 230/237/238）、`LoadAudio`（低配 522/523 ·
//     高配 223/225）都烧着他自己 input 目录里的哈希文件名。不摘掉就提交，轻则 worker 找不到
//     文件失败，重则把作者那张 demo 人像当参考图渲染出来；
//   - 低配图有两个 `VHS_VideoCombine`（521 首轮草稿 / 563 二轮放大交付）+ 3 个参考图预览，
//     高配图 1 个 VHS（226）+ 3 个预览 —— 不收敛就一次生成回来好几条片子和几张图。
//
// 两张图只有采样骨架不同（低配 `MiniMaxH3ReferenceToVideo`(338) 单次 + `SamplerCustomAdvanced`；
// 高配 `MiniMaxH3AudioConditioningT8`(7 LOW / 14 HIGH) + `MiniMaxH3DualClockSamplerT8`(8) 双通道），
// 而提示词 / 参考图 / 音轨 / 时长 / 画幅 / 输出**完全同构**，所以共用一个适配器。按 id 只分两处：
// 低配那支 `MysticXXX_MMH3-V1` 风格 LoRA 走档位（默认 0，理由见 Fisher 那段长注释）、
// 以及"是否内置 Export 图"的兜底（两张图都内置，见 `bundledRunningHubGraph`）。
// Scoped to these two ids only — 其它族一个字节都不变。
const MINIMAX_H3_WENXI_WORKFLOW_IDS = new Set(["2114557183900192769", "2114552017984241666"]);
/** 只有低配图挂着 `MysticXXX_MMH3-V1`（548 @0.5）；高配图是 `FeiHou_MiniMax-H3_Remix` + 8step turbo。 */
const MINIMAX_H3_WENXI_LOW_WORKFLOW_IDS = new Set(["2114557183900192769"]);
/** 高配节点 7/14 写死 `reference_video_policy: official_2_to_15s` → 时长按官方区间夹。 */
const MINIMAX_H3_WENXI_SECONDS = { min: 2, max: 15 };
/**
 * 交付天花板取 1080 档（2.07MP）：草稿 = 交付 / 1.5²，1080 档草稿 0.92MP 已比作者 bake（0.5）
 * 高 84%，再往上这两张 8/15 秒双通道图在 RH 上就是显存告警。
 */
const MINIMAX_H3_WENXI_MAX_DELIVERED_MP = 2.07;

function isMinimaxH3WenxiWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return MINIMAX_H3_WENXI_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the 【MINIMAX-H3】八月最强文戏 pair (低配 / 高配). */
export function isMinimaxH3WenxiWorkflowId(workflowId?: string | null) {
    return isMinimaxH3WenxiWorkflow(workflowId);
}

function isMinimaxH3WenxiLowWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return MINIMAX_H3_WENXI_LOW_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the 低配 graph only (it is the one carrying the Mystic style LoRA). */
export function isMinimaxH3WenxiLowWorkflowId(workflowId?: string | null) {
    return isMinimaxH3WenxiLowWorkflow(workflowId);
}

/**
 * Reference/audio slot consumers for the 文戏 pair.
 *
 * 低配是 `MiniMaxH3ReferenceToVideo`(338) 一个；高配是 `MiniMaxH3AudioConditioningT8` **两个**
 * （7 = LOW 草稿通道 / 14 = HIGH 放大通道），两边指向**同一批** scaler（236/231/232）和
 * 同一批 `LoadAudio`（225/223）。所以 slots 只从第一个 consumer 取（两边槽序一致），
 * 但增删链接必须**遍历每一个** consumer，否则高配只改了半张图。
 */
function minimaxH3WenxiRefConsumers(workflow: ComfyWorkflow) {
    const out: Array<{ id: string; node: ComfyNode; slots: Array<{ index: number; key: string; sourceId: string }> }> = [];
    for (const [id, node] of Object.entries(workflow)) {
        const type = String(node?.class_type || "");
        if (!/MiniMaxH3ReferenceToVideo|MiniMaxH3AudioConditioning/i.test(type)) continue;
        const slots: Array<{ index: number; key: string; sourceId: string }> = [];
        for (const [key, value] of Object.entries(node.inputs || {})) {
            const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
            if (!match) continue;
            const sourceId = Array.isArray(value) ? String(value[0]) : "";
            if (sourceId) slots.push({ index: Number(match[1]), key, sourceId });
        }
        if (!slots.length) continue;
        slots.sort((a, b) => a.index - b.index);
        out.push({ id, node, slots });
    }
    return out;
}

/** Latent upscale multiplier (低配 `MinimaxH3LatentUpscaler3D` / 高配 `MiniMaxH3LearnedLatentUpscaleT8`). */
function minimaxH3WenxiUpscaleFactor(workflow: ComfyWorkflow) {
    for (const node of Object.values(workflow)) {
        if (!/LatentUpscal/i.test(String(node?.class_type || ""))) continue;
        for (const key of ["scale_by", "mode.scale", "scale"]) {
            const value = Number(node.inputs?.[key]);
            if (Number.isFinite(value) && value > 1) return value;
        }
    }
    return 1.5;
}

/** Strict upstream walk (links only, never consumers) — used to tell the draft sink from the final one. */
function comfyUpstreamIds(workflow: ComfyWorkflow, startId: string, limit = 500) {
    const seen = new Set<string>();
    const queue = [startId];
    while (queue.length && seen.size < limit) {
        const id = queue.pop() as string;
        if (!id || seen.has(id) || !workflow[id]) continue;
        seen.add(id);
        for (const value of Object.values(workflow[id]?.inputs || {})) {
            if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string") continue;
            queue.push(value[0]);
        }
    }
    return seen;
}

/**
 * 摘掉一条**空的**参考图槽：scaler（可能多级）→ `LoadImage` 一起删。
 *
 * `pruneOrphanedReferenceChain` 在这里不够用：它只把 `LoadImage / Resize / PreviewImage` 这些类名
 * 当候选，而这两张文的槽目标是 `LayerUtility: ImageScaleByAspectRatio V2` —— 它既不是候选、
 * 又一直消费着下游 `LoadImage`，于是整条链原地留着，作者烧死的哈希文件名继续进负载。
 * 判定口径：链上每个节点「是否还有别的消费者」，没有就删；从槽端往下走，天然是拓扑序。
 */
function pruneMinimaxH3WenxiEmptySlot(workflow: ComfyWorkflow, startId: string) {
    const chain: string[] = [];
    let current = startId;
    for (let depth = 0; depth < 8 && current && workflow[current]; depth += 1) {
        const node = workflow[current];
        chain.push(current);
        if (/LoadImage/i.test(String(node.class_type || ""))) break;
        const link = Object.values(node.inputs || {}).find(
            (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string",
        ) as [string, number] | undefined;
        current = link ? link[0] : "";
    }
    let changed = false;
    for (const id of chain) {
        if (!workflow[id]) continue;
        // 高配的两条 conditioning 共用同一批 scaler：只要还有别的消费者连着，这一条就不能删。
        if (comfyConsumedIds(workflow).has(id)) continue;
        delete workflow[id];
        changed = true;
    }
    return changed;
}

/**
 * One clip out, no stills.
 *
 * 低配图留了两个 `VHS_VideoCombine`：521 喂的是首轮 `VAEDecode`（草稿分辨率），563 喂的是
 * 1.5× 放大后二轮采样的 `VAEDecode`（交付分辨率）。用「上游能不能走到 latent 放大器」判定谁是
 * 交付端，而不是写死 id —— 作者换个 id 重新导出也不会挑错。三个 `PreviewImage` 预览的是参考图
 * 本身（scaler 输出），留着会让一次生成回来三张图。
 */
function pruneMinimaxH3WenxiOutputs(workflow: ComfyWorkflow) {
    let changed = false;
    for (const [id, node] of Object.entries(workflow)) {
        if (/^PreviewImage$/i.test(String(node?.class_type || ""))) {
            delete workflow[id];
            changed = true;
        }
    }
    const sinks = Object.entries(workflow).filter(([, node]) => /VHS_VideoCombine/i.test(String(node?.class_type || "")));
    if (sinks.length <= 1) return changed;
    const upscaled = new Set(
        Object.entries(workflow)
            .filter(([, node]) => /LatentUpscal/i.test(String(node?.class_type || "")))
            .map(([id]) => id),
    );
    const finals = sinks.filter(([id]) => {
        const chain = comfyUpstreamIds(workflow, id);
        for (const upstreamId of chain) if (upscaled.has(upstreamId)) return true;
        return false;
    });
    // 判定不出来（图里没有放大器）时保留**最后一个** sink，总比一条片子都不回强。
    const keep = new Set((finals.length ? finals : sinks.slice(-1)).map(([id]) => id));
    for (const [id] of sinks) {
        if (keep.has(id)) continue;
        delete workflow[id];
        changed = true;
    }
    return changed;
}

function applyMinimaxH3WenxiSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    seconds?: string,
    aspect = "",
    megapixels = "",
    loraStrength: string | number = "",
    audioCount = 0,
    lowConfig = false,
): { workflow: ComfyWorkflow; structuralRepair: boolean } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let structuralRepair = false;

    // 1) 作者的占位节点（`忽略多组 孤海`）：不进采样链，纯负载。
    for (const [id, node] of Object.entries(next)) {
        if (/忽略多组|孤海/.test(String(node?.class_type || ""))) {
            delete next[id];
            structuralRepair = true;
        }
    }

    // 2) 输出收敛**先做**：那三个 `PreviewImage` 就挂在 ref 缩放链上，先删掉它们，
    //    下面摘参考图槽时 `pruneOrphanedReferenceChain` 才能把整条 scaler→LoadImage 剪干净。
    if (pruneMinimaxH3WenxiOutputs(next)) structuralRepair = true;

    // 3) 参考图 → `ref_images.ref_image_N` 槽序（不是 LoadImage id 序）。
    const consumers = minimaxH3WenxiRefConsumers(next);
    if (!consumers.length) throw new Error(apiText("runningHubReferenceNotApplied"));
    // Ref2VA 图没有参考图就没有可绑的演员 —— 宁可报错，也不要拿作者的 demo 人像去渲染。
    if (!imageValues.length) throw new Error(apiText("runningHubReferenceNotApplied"));

    const primary = consumers[0];
    let writtenReferences = 0;
    const disconnected: string[] = [];
    primary.slots.forEach((slot, position) => {
        const value = imageValues[position] || "";
        // 同一个槽在不同 consumer 上指向同一批 scaler，但都要各自走到 LoadImage。
        const loaderIds = new Set<string>();
        for (const consumer of consumers) {
            const peer = consumer.slots.find((item) => item.key === slot.key);
            if (!peer) continue;
            const loaderId = minimaxH3FourViewLoader(next, peer.sourceId);
            if (loaderId) loaderIds.add(loaderId);
        }
        if (value) {
            let wrote = false;
            for (const loaderId of loaderIds) {
                const loader = next[loaderId];
                const field = loader ? imageFieldName(loader) : "";
                if (!field || !loader?.inputs) continue;
                loader.inputs[field] = value;
                wrote = true;
            }
            if (wrote) {
                writtenReferences += 1;
                return;
            }
        }
        // 未填：每个 consumer 上都必须摘掉这条链接，否则作者的 demo 人像照样进片。
        for (const consumer of consumers) {
            if (consumer.node.inputs && slot.key in consumer.node.inputs) {
                delete consumer.node.inputs[slot.key];
                structuralRepair = true;
            }
            const peer = consumer.slots.find((item) => item.key === slot.key);
            if (peer) disconnected.push(peer.sourceId);
        }
    });
    if (imageValues.length && !writtenReferences) throw new Error(apiText("runningHubReferenceNotApplied"));

    // 4) 音轨：用户没带音色参考 → 作者那两条 demo mp3 必须整条摘掉。
    //    H3 会顺着参考音轨往下说，这是「冒出我没写过的台词」的头号来源（见
    //    `applyRunningHubReferenceAudios` 的注释）。带了的情况已经在本函数**之前**由
    //    `applyRunningHubReferenceAudios` 写进低配 522/523 · 高配 225/223 的 `LoadAudio` 里，
    //    这里只补「没带」这一半；槽数与上传数不一致时，超出的槽同样按未带处理。
    for (const consumer of consumers) {
        for (const key of Object.keys(consumer.node.inputs || {})) {
            const audioMatch = /^ref_audios\.ref_audio_(\d+)$/.exec(key);
            const isVideoSlot = /^ref_videos\./.test(key);
            if (!audioMatch && !isVideoSlot) continue;
            const link = consumer.node.inputs?.[key];
            const sourceId = Array.isArray(link) ? String(link[0]) : "";
            const media = sourceId ? next[sourceId] : undefined;
            const index = audioMatch ? Number(audioMatch[1]) : -1;
            const keep = !isVideoSlot && index >= 0 && index < audioCount && Boolean(media?.inputs);
            if (keep) continue;
            delete consumer.node.inputs![key];
            if (sourceId) disconnected.push(sourceId);
            structuralRepair = true;
        }
    }

    if (disconnected.length) {
        // `pruneOrphanedReferenceChain` 只认图片链；`LoadAudio` / 视频加载器要自己删。
        for (const id of new Set(disconnected)) {
            if (!next[id]) continue;
            if (/LoadAudio|VHS_LoadVideo|LoadVideo/i.test(String(next[id]?.class_type || ""))) {
                delete next[id];
                structuralRepair = true;
                continue;
            }
            // 参考图槽：scaler → LoadImage 这条链按「还有没有别的消费者」逐级剪。
            if (pruneMinimaxH3WenxiEmptySlot(next, id)) structuralRepair = true;
        }
        if (pruneOrphanedReferenceChain(next, [...new Set(disconnected)])) structuralRepair = true;
    }

    // 5) 时长 → `PrimitiveFloat`「Float (duration)」（低配 529 / 高配 163）。
    //    只写秒数：`ComfyMathExpression` 负责把它变成 `max(5, round(a*24))` 的 17n+5 帧数，
    //    动 `length` 那个链接就等于破坏 H3 的长度约束。
    const duration = Number(seconds);
    if (Number.isFinite(duration) && duration > 0) {
        const clamped = Math.min(MINIMAX_H3_WENXI_SECONDS.max, Math.max(MINIMAX_H3_WENXI_SECONDS.min, duration));
        const durationNode =
            next["529"] ||
            next["163"] ||
            findComfyNode(next, (node) => /Primitive(Float|Int)/i.test(String(node.class_type || "")) && /时长|duration|长度/i.test(String(node._meta?.title || "")));
        if (durationNode?.inputs && typeof durationNode.inputs.value === "number") durationNode.inputs.value = clamped;
    }

    // 6) 画幅 → `ResolutionSelector`（低配 456 / 高配 164），它是**草稿**尺寸：
    //    aspect_ratio 是标签枚举，megapixels 按「交付 / 1.5²」回推，且只在高于作者 bake 时才抬
    //    （选 720p 不许把作者 0.5MP 的图压小）。
    const selector = next["456"] || next["164"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        if (aspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(aspect);
        }
        const delivered = singularityDeliveredMegapixels(megapixels);
        if (delivered > 0 && typeof selector.inputs.megapixels === "number") {
            const scale = minimaxH3WenxiUpscaleFactor(next) || 1.5;
            const authored = Number(selector.inputs.megapixels) || 0;
            const budget = Math.min(delivered, MINIMAX_H3_WENXI_MAX_DELIVERED_MP);
            const draft = Math.max(0.1, Math.round((budget / (scale * scale)) * 100) / 100);
            selector.inputs.megapixels = authored > 0 ? Math.max(authored, draft) : draft;
        }
    }

    // 7) 提示词 → 采样节点 `prompt` 链接解析出来的那个文本节点（`CR Prompt Text`，字段 `prompt`）。
    //    ⚠️ **空提示词也要写**：作者在这个节点里写死了一整段示例台词（Gu Yan / Xiao Yu / 私人飞机），
    //    「空就不写」= 把别人的角色原样念出来。这是用户「总是出现我没写过的台词」最像的一条。
    {
        const link = consumers[0]?.node?.inputs?.prompt;
        const sourceId = Array.isArray(link) ? String(link[0]) : "";
        const candidates = [sourceId ? next[sourceId] : undefined, next["528"], next["167"]];
        let promptNode = candidates.find(
            (node) =>
                node?.inputs &&
                (typeof node.inputs.prompt === "string" || typeof node.inputs.text === "string" || typeof node.inputs.value === "string"),
        );
        if (!promptNode) {
            promptNode = findComfyNode(
                next,
                (node) => /CR Prompt Text|PrimitiveString|^Text$/i.test(String(node.class_type || "")) && typeof node.inputs?.prompt === "string",
            );
        }
        if (promptNode?.inputs) {
            if (typeof promptNode.inputs.prompt === "string") promptNode.inputs.prompt = prompt;
            else if (typeof promptNode.inputs.text === "string") promptNode.inputs.text = prompt;
            else if (typeof promptNode.inputs.value === "string") promptNode.inputs.value = prompt;
        }
    }

    // 8) 低配那支 `MysticXXX_MMH3-V1`（548）：韩语人声 / 硬字幕 / 自编台词的共同源头，归到档位
    //    （默认 0 = 短路成官方底模，见 `FISHER_LORA_STRENGTH_OPTIONS`）。高配图没有这支，
    //    `minimax_h3_fl2v_turbo_8step` 是 8 步采样必需的 turbo，**任何档位都不许动它**。
    if (lowConfig) {
        const strength = normalizeFisherLoraStrength(loraStrength);
        const loraNode =
            next["548"] ||
            findComfyNode(
                next,
                (node) => /LoraLoader/i.test(String(node.class_type || "")) && /Mystic/i.test(String(node.inputs?.lora_name || "")),
            );
        if (loraNode?.inputs) {
            loraNode.inputs.strength_model = strength;
            if (typeof loraNode.inputs.strength_clip === "number") loraNode.inputs.strength_clip = strength;
        }
    }

    // 9) 固定种子 → 每次跑都重放同一条片（`RandomNoise` 是这族的唯一种子源）。
    for (const node of Object.values(next)) {
        if (/RandomNoise/i.test(String(node.class_type || "")) && typeof node.inputs?.noise_seed === "number") {
            node.inputs.noise_seed = randomComfySeed();
        }
    }

    return { workflow: next, structuralRepair: true };
}

// Qwen Image 2.1 + Flux2 Klein 皮肤肌理 T2I (runninghub.ai U2108554415855054850 /
// runninghub.cn 2108554405246226433). Two-stage graph: KSampler (161) drafts from CLIPTextEncode
// (5)/(7), then SamplerCustomAdvanced + RandomNoise (50) refines with a fixed Klein enhance prompt
// on CLIPTextEncode (54). EmptyLatentImage size is a link into ResolutionSelector (168); Klein's
// ImageScaleToTotalPixels (56) is a separate 4MP refine target. Generic writers break this graph:
//   - writeRunningHubPrompt scores every CLIPTextEncode titled "(Prompt)" at 40, so it would paint
//     the user text onto 5 *and* the negative (7) *and* the Klein enhance slot (54);
//   - writeRunningHubSize cannot produce ResolutionSelector's label enum ("2:3 (Portrait Photo)");
//   - writeRunningHubTier force-maps any `megapixels` in {1,2,4}, including the refine node's 4MP.
// Pure T2I — no LoadImage. Scoped to these ids only.
const QWEN_KLEIN_SKIN_WORKFLOW_IDS = new Set(["2108554415855054850", "2108554405246226433"]);

function isQwenKleinSkinWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return QWEN_KLEIN_SKIN_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the Qwen+Klein skin T2I graph (RH.ai / RH.cn id pair above). */
export function isQwenKleinSkinWorkflowId(workflowId?: string | null) {
    return isQwenKleinSkinWorkflow(workflowId);
}

// Krea2 田园风格 MJ 感 T2I (runninghub.cn 2108931536983773186 /
// runninghub.ai 2108931356129599489). User text lands on CR PromptText (102) → llama_cpp_instruct
// (113) → CLIPTextEncode (3). Canvas size is EmptyLatentImage ← TTResolutionSelector (10) with
// `custom_width`/`custom_height` (not scalar width/height). Generic writers miss the selector and
// can leave the author's fixed KSampler / llama seeds — scoped to these two ids only.
const KREA2_PASTORAL_MJ_WORKFLOW_IDS = new Set(["2108931536983773186", "2108931356129599489"]);

function isKrea2PastoralMjWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return KREA2_PASTORAL_MJ_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the Krea2 pastoral MJ T2I graph (RH.cn / RH.ai id pair above). */
export function isKrea2PastoralMjWorkflowId(workflowId?: string | null) {
    return isKrea2PastoralMjWorkflow(workflowId);
}

// Aiden KREA2 提示词优化 + LoRA 加持 T2I
// (runninghub.cn 2109993221349793794 / runninghub.ai 2109995692252229633).
// Export: 1-Aiden-KREA2模型提示词优化lora加持工作流 _api.json
//
// Why the generic writers / published graph break canvas use:
//   - writeRunningHubPrompt clobbers every easy positive (18/89/136/139);
//   - EmptyLatentImage size is a link into ResolutionSelector (23);
//   - the published author stack (llama GGUF + SeedVR2) often stays RUNNING until the canvas
//     looks stuck; lean Export delivery writes prompt→CLIP, keeps LoRAs, skips llama/SeedVR.
// Scoped to these two ids only.
const KREA2_AIDEN_LORA_WORKFLOW_IDS = new Set(["2109993221349793794", "2109995692252229633"]);

function isKrea2AidenLoraWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return KREA2_AIDEN_LORA_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the Aiden KREA2 LoRA + prompt-optimize T2I graph. */
export function isKrea2AidenLoraWorkflowId(workflowId?: string | null) {
    return isKrea2AidenLoraWorkflow(workflowId);
}

/**
 * Canvas delivery graph for Aiden on RunningHub.
 *
 * The published author graph runs llama (Qwen 9B GGUF) + SeedVR2 7B after Krea2 — that stack often
 * stays RUNNING for a long time (or never surfaces SaveImage files), so the canvas spins with no
 * image. For these two workflow ids we ship a lean graph instead:
 *   - user prompt → CLIPTextEncode (#7) directly (skip llama expander);
 *   - keep UNET + LoRAs + ResolutionSelector + KSampler;
 *   - SaveImage ← VAEDecode (skip SeedVR / Preview / rgthree / 忽略多组孤海).
 */
function pruneKrea2AidenLoraGraph(workflow: ComfyWorkflow, prompt: string) {
    const decode =
        workflow["123"] || findComfyNode(workflow, (node) => /^VAEDecode$/i.test(String(node.class_type || "")) && "samples" in (node.inputs || {}));
    const decodeId =
        (decode && Object.entries(workflow).find(([, node]) => node === decode)?.[0]) || (workflow["123"] === decode ? "123" : "");
    const save =
        workflow["118"] || findComfyNode(workflow, (node) => /^SaveImage$/i.test(String(node.class_type || "")) && "images" in (node.inputs || {}));
    if (save?.inputs && decodeId) save.inputs.images = [decodeId, 0];

    // Bypass llama → showAnything → CLIP: write the canvas caption straight onto CLIPTextEncode.
    const clip =
        workflow["7"] ||
        findComfyNode(workflow, (node) => /^CLIPTextEncode$/i.test(String(node.class_type || "")) && "text" in (node.inputs || {}));
    if (clip?.inputs && prompt.trim()) clip.inputs.text = prompt.trim();

    for (const [id, node] of Object.entries(workflow)) {
        const type = String(node?.class_type || "");
        if (/忽略多组|孤海/.test(type)) delete workflow[id];
        else if (/Image\s*Comparer/i.test(type)) delete workflow[id];
        else if (/SeedVR2/i.test(type)) delete workflow[id];
        else if (/ImageScaleToTotalPixels/i.test(type)) delete workflow[id];
        else if (/^PreviewImage$/i.test(type)) delete workflow[id];
        else if (/llama_cpp/i.test(type)) delete workflow[id];
        else if (/easy\s*showAnything/i.test(type)) delete workflow[id];
        else if (/easy\s*positive/i.test(type)) delete workflow[id];
    }
}

function applyKrea2AidenLoraSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    size?: { width: number; height: number } | null,
    aspect = "",
    rawSize = "",
    megapixels = "",
): { workflow: ComfyWorkflow } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // Canvas size → ResolutionSelector (23). pruneKrea2AidenLoraGraph drops SeedVR; this selector
    // is the only size knob that remains on the lean delivery graph.
    const selector =
        next["23"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        }
        const explicit = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(explicit) && explicit > 0 && typeof selector.inputs.megapixels === "number") {
            selector.inputs.megapixels = explicit;
        } else if (typeof selector.inputs.megapixels === "number") {
            const tier = canvasResolutionTier(rawSize);
            if (tier) {
                const tierMegapixels = tier === "4k" ? 4 : tier === "2k" ? 2 : 1;
                const baked = selector.inputs.megapixels;
                selector.inputs.megapixels = Number.isFinite(baked) && baked > 0 ? Math.max(baked, tierMegapixels) : tierMegapixels;
            }
        }
    }

    // Randomize KSampler seed before prune removes the llama / SeedVR nodes.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/KSampler/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    pruneKrea2AidenLoraGraph(next, prompt);
    return { workflow: next };
}

// WorkFisher 全能生图王 (moss_image T2I)
// (runninghub.ai 2113237431129858050 / runninghub.cn 2113237270584188929).
// Export: 【WorkFisher】全能生图王 _ 适配所有类型_api.json
//
// Why every generic writer mis-fires on this graph:
//   - the positive CLIP (29) is a *link* from the LLM prompt expander (61), so writeRunningHubPrompt
//     only finds the 41k-char `role` system prompt, the negative (36) and the PreviewAny (56) text;
//   - the latent size is a link (`EmptyFlux2LatentImage` 35 ← `ResolutionSelector` 19) and that
//     selector takes a label enum ("16:9 (Widescreen)"), which writeRunningHubSize refuses to touch;
//   - the delivered pixels come from SeedVR2 (46) capped by `INTConstant` 50, not from the latent
//     (the graph renders a draft, downscales it to 0.3MP at 49, then upsamples from that);
//   - KSampler (31), the upscaler (46) and the expander (61) all carry baked seeds → same picture
//     for identical inputs, always;
//   - the author keeps four sinks (draft save 9, preview 52, A/B comparer 47, 4K save 51), so one
//     generation would come back as several images.
// Scoped to these two ids — every other workflow keeps the generic writers untouched.
const WORKFISHER_MOSS_WORKFLOW_IDS = new Set(["2113237431129858050", "2113237270584188929"]);

function isWorkFisherMossWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return WORKFISHER_MOSS_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the 全能生图王 moss_image T2I graph (RH.ai / RH.cn id pair above). */
export function isWorkFisherMossWorkflowId(workflowId?: string | null) {
    return isWorkFisherMossWorkflow(workflowId);
}

/**
 * Export (API) graph shipped with the build for a family whose upstream copy is usually ACL-denied.
 *
 * 全能生图王 is a third-party app: `getJsonApiFormat` answers "您暂时无权限访问该工作流" for most keys,
 * so without this the model only runs after the user hand-pastes a 46KB JSON into the model script.
 * A model script still wins (it is the user's override); this is the floor. Deep-cloned per call so
 * the patcher never mutates the module constant.
 */
function bundledRunningHubGraph(workflowId: string): ComfyWorkflow | null {
    if (isWorkFisherMossWorkflow(workflowId)) return JSON.parse(JSON.stringify(workfisherMossWorkflow)) as unknown as ComfyWorkflow;
    // 【MINIMAX-H3】八月最强文戏：两张图各内置一份，按 id 二选一（低配不会拿到高配的图）。
    if (isMinimaxH3WenxiWorkflow(workflowId)) {
        const graph = isMinimaxH3WenxiLowWorkflow(workflowId) ? minimaxH3WenxiLowWorkflow : minimaxH3WenxiHighWorkflow;
        return JSON.parse(JSON.stringify(graph)) as unknown as ComfyWorkflow;
    }
    return null;
}

function applyWorkFisherMossSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    imageValues: string[],
    size?: { width: number; height: number } | null,
    aspect = "",
    rawSize = "",
    megapixels = "",
): { workflow: ComfyWorkflow } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // 1) User text → the `Text (User Prompt)` primitive (57) the expander reads. Never the expander's
    //    `role` (its 41k system prompt), the negative (36) or the preview (56).
    const userPrompt =
        next["57"] ||
        findComfyNode(next, (node) => /PrimitiveString|StringConstant/i.test(String(node.class_type || "")) && typeof node.inputs?.value === "string");
    if (userPrompt?.inputs && prompt.trim() && typeof userPrompt.inputs.value === "string") userPrompt.inputs.value = prompt.trim();

    // 2) Reference image → the expander's single `image1` slot (62 → 61). With no reference, drop
    //    the link *and* the loader: the author's `example.png` lives in their own input dir, so
    //    submitting our own graph would ask RunningHub for a file this account cannot resolve.
    const expander = next["61"] || findComfyNode(next, (node) => /RH_LLMAPI_Pro_Node/i.test(String(node.class_type || "")) && "image1" in (node.inputs || {}));
    const loader = next["62"] || findComfyNode(next, (node) => /LoadImage/i.test(String(node.class_type || "")));
    const loaderId = loader ? Object.entries(next).find(([, node]) => node === loader)?.[0] || "" : "";
    const reference = imageValues.find(Boolean) || "";
    if (expander?.inputs) {
        if (reference && loaderId) {
            if (typeof loader?.inputs?.image === "string") loader.inputs.image = reference;
            expander.inputs.image1 = [loaderId, 0];
        } else {
            delete expander.inputs.image1;
            if (loaderId) delete next[loaderId];
        }
    }

    // 3) Aspect + resolution. `ResolutionSelector` (19) wants the label enum, so the canvas ratio goes
    //    through the shared table. The delivered long side is `INTConstant` (50) — SeedVR2's
    //    `resolution` — which is the only knob that survives the 0.3MP → upscale round trip.
    const selector = next["19"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    const tier = canvasResolutionTier(rawSize);
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        }
        const explicit = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(explicit) && explicit > 0 && typeof selector.inputs.megapixels === "number") {
            selector.inputs.megapixels = explicit;
        } else if (typeof selector.inputs.megapixels === "number" && tier) {
            const tierMegapixels = tier === "4k" ? 4 : tier === "2k" ? 2 : 1;
            const baked = selector.inputs.megapixels;
            selector.inputs.megapixels = Number.isFinite(baked) && baked > 0 ? Math.max(baked, tierMegapixels) : tierMegapixels;
        }
    }
    const delivered = next["50"] || findComfyNode(next, (node) => /INTConstant/i.test(String(node.class_type || "")) && typeof node.inputs?.value === "number");
    if (tier && delivered?.inputs && typeof delivered.inputs.value === "number") delivered.inputs.value = TIER_LONG_SIDE[tier];

    // 4) Baked seeds → a fresh one per run (draft sampler + upscaler + expander).
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/KSampler|SamplerCustom/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
        else if (/SeedVR2/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }
    if (typeof expander?.inputs?.seed === "number") expander.inputs.seed = randomComfySeed();

    // 5) One image per run: keep the SaveImage fed by the upscaler (the 4K `Work-Fisher` file) and
    //    drop the author's draft save / preview / A/B comparer / final-prompt preview. If the graph
    //    ever loses its upscaler, keep every save rather than returning nothing.
    const upscalerIds = new Set(
        Object.entries(next)
            .filter(([, node]) => /SeedVR2/i.test(String(node?.class_type || "")))
            .map(([id]) => id),
    );
    const saveIds = Object.entries(next)
        .filter(([, node]) => /^SaveImage$/i.test(String(node?.class_type || "")))
        .map(([id]) => id);
    const finalSaves = saveIds.filter((id) => {
        const link = next[id]?.inputs?.images;
        return Array.isArray(link) && upscalerIds.has(String(link[0]));
    });
    if (finalSaves.length) {
        for (const id of saveIds) {
            if (!finalSaves.includes(id)) delete next[id];
        }
    }
    for (const [id, node] of Object.entries(next)) {
        const type = String(node?.class_type || "");
        if (/Image\s*Comparer/i.test(type) || /^PreviewImage$/i.test(type) || /^PreviewAny$/i.test(type)) delete next[id];
    }

    return { workflow: next };
}

function snap16(value: number) {
    return Math.max(64, Math.round(value / 16) * 16);
}

function applyKrea2PastoralMjSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    size?: { width: number; height: number } | null,
): { workflow: ComfyWorkflow } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // User text → CR PromptText (102) only. Do not overwrite llama system_prompt or the linked
    // CLIPTextEncode slot — those carry the Krea2 reverse/edit contract.
    if (prompt.trim()) {
        const promptNode =
            next["102"] ||
            findComfyNode(next, (node) => /CR\s*PromptText/i.test(String(node.class_type || "")) && typeof node.inputs?.prompt === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.prompt === "string") promptNode.inputs.prompt = prompt;
    }

    // Canvas size → TTResolutionSelector (10). EmptyLatentImage width/height are links into this
    // node; writeRunningHubSize only follows links looking for value/int/number, never custom_*.
    if (size?.width && size.height) {
        const selector =
            next["10"] ||
            findComfyNode(next, (node) => /TTResolutionSelector/i.test(String(node.class_type || "")) && "custom_width" in (node.inputs || {}));
        if (selector?.inputs) {
            // Keep the combo `resolution` label as authored; with custom mode the pixel knobs win.
            if ("use_custom_resolution" in selector.inputs) selector.inputs.use_custom_resolution = true;
            if (typeof selector.inputs.custom_width === "number" || typeof selector.inputs.custom_width === "string") {
                writeScalar(selector.inputs, "custom_width", snap16(size.width));
            }
            if (typeof selector.inputs.custom_height === "number" || typeof selector.inputs.custom_height === "string") {
                writeScalar(selector.inputs, "custom_height", snap16(size.height));
            }
        }
    }

    // Fixed seeds on KSampler (97) and llama_cpp_instruct_adv (113) → identical images; randomize.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/KSampler/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
        else if (/llama_cpp_instruct/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    return { workflow: next };
}

// MJ 风格工作流 V2.0 (runninghub.ai 2112477095216926722 / runninghub.cn 2112477039575003138).
// Export: MJ风格工作流V2.0_api.json. Pure text-to-image Krea2-turbo graph with a six-LoRA stack
// (cinematic_layout → detail_slider → realism_engine → zidiusArt → MJ 影视柔光 → MJ 风格滤镜).
// The generic writers leave three knobs wrong:
//   - output shape is ignored: EmptyLatentImage (198) takes width/height as links into
//     ResolutionSelector (205), whose `aspect_ratio` is a label enum ("16:9 (Widescreen)") that
//     writeRunningHubSize can neither read nor produce — every run stayed 16:9;
//   - the same selector's `megapixels` is 4, and writeRunningHubTier force-maps 1/2/4 onto the
//     canvas tier. A tier number is not an area: 4MP at 16:9 is ~2672x1504, so a 4K selection
//     could never deliver 3840x2160 and a 2K one could never deliver 2048x1152. Owned here, from
//     the resolved canvas pixels; `auto` alone keeps the baked 4MP.
//   - KSampler (202) bakes a fixed seed, so identical inputs repeated identical images.
// The prompt itself already lands on CR Prompt Text (214), but for the wrong reason: the generic
// scorer rates 214 *and* CLIPTextEncode (199) 40, and 199's `text` is a link back into 214, so the
// second write happens to be a no-op. It is written here explicitly so a node re-order can never
// paint the encoder directly, or leak into the zeroed-out negative (200). Scoped to these two ids.
const KREA2_MJ_STYLE_WORKFLOW_IDS = new Set(["2112477095216926722", "2112477039575003138"]);
const KREA2_MJ_STYLE_PROMPT_NODE = "214";
const KREA2_MJ_STYLE_SELECTOR_NODE = "205";
const KREA2_MJ_STYLE_SAMPLER_NODE = "202";
/** 210 krea2-Cc-MJ-影视柔光 / 211 krea2-Cc-MJ-风格滤镜 — the two LoRAs that carry the MJ look. */
const KREA2_MJ_FLAVOR_NODES = ["210", "211"] as const;
/** `standard` is null on purpose: the author's 0.55 / 0.60 stays untouched unless asked. */
const KREA2_MJ_FLAVOR_STRENGTHS: Record<string, readonly [number, number] | null> = {
    strong: [0.8, 0.85],
    standard: null,
    light: [0.3, 0.3],
    off: [0, 0],
};
/** What `standard` means in numbers: the graph's own 210 / 211 weights, left untouched. */
const KREA2_MJ_FLAVOR_AUTHOR_WEIGHTS = [0.55, 0.6] as const;

function normalizeKrea2MjFlavor(value?: string | null) {
    const raw = String(value || "").trim().toLowerCase();
    return raw === "strong" || raw === "light" || raw === "off" ? raw : "standard";
}

/**
 * Effective 210 (MJ 柔光) / 211 (MJ 风格滤镜) weights for a tier — single source of truth for the
 * canvas picker, so the numbers shown can never drift away from what is actually written.
 */
export function krea2MjFlavorWeights(flavor?: string | null): readonly [number, number] {
    return KREA2_MJ_FLAVOR_STRENGTHS[normalizeKrea2MjFlavor(flavor)] || KREA2_MJ_FLAVOR_AUTHOR_WEIGHTS;
}

function isKrea2MjStyleWorkflow(workflowId?: string | null) {
    const raw = String(workflowId || "")
        .trim()
        .toLowerCase();
    if (!raw) return false;
    // The runtime id can arrive channel-encoded ("<channelId>::<model>") or prefixed ("rh-<id>").
    return raw.split("::").some((segment) => {
        const id = segment
            .trim()
            .replace(/^(rh|runninghub|workflow|u)[:_-]?/i, "")
            .trim();
        return KREA2_MJ_STYLE_WORKFLOW_IDS.has(id);
    });
}

/** Public gate for the MJ 风格 V2.0 T2I graph (the canvas shows its 味型 picker only for it). */
export function isKrea2MjStyleWorkflowId(workflowId?: string | null) {
    return isKrea2MjStyleWorkflow(workflowId);
}

function applyKrea2MjStyleSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    size?: { width: number; height: number } | null,
    aspect = "",
    rawSize = "",
    megapixels = "",
    mjFlavor = "",
): { workflow: ComfyWorkflow } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // User prompt → ⚙️ CR Prompt Text (214). 199 consumes it through a link, so writing the source
    // node is enough; the negative is ConditioningZeroOut (200) off the same encode (cfg 1).
    if (prompt.trim()) {
        const promptNode =
            next[KREA2_MJ_STYLE_PROMPT_NODE] ||
            findComfyNode(next, (node) => /CR\s*Prompt\s*Text/i.test(String(node.class_type || "")) && typeof node.inputs?.prompt === "string");
        if (promptNode?.inputs && typeof promptNode.inputs.prompt === "string") promptNode.inputs.prompt = prompt;
    }

    // Canvas shape + precision → ResolutionSelector (205). Aspect is the label enum that only this
    // adapter can produce; `megapixels` is an absolute area, rewritten here after the tier writer so
    // the canvas preset is what actually ships (2048x1152 → 2.36MP, 3840x2160 → 8.29MP, `auto` →
    // the author's 4MP).
    const selector =
        next[KREA2_MJ_STYLE_SELECTOR_NODE] ||
        findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        }
        if (typeof selector.inputs.megapixels === "number") {
            const explicit = Number(megapixels);
            if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(explicit) && explicit > 0) {
                selector.inputs.megapixels = explicit;
            } else {
                // WYSIWYG: `megapixels` is an absolute area, so the canvas preset has to be converted
                // into the pixel budget it actually stands for. A tier number is wrong for every
                // ratio but square — 4 would be ~2672x1504 at 16:9, not the 4K preset's 3840x2160,
                // and 2 would be 1792x1008 at 16:9, not 2048x1152. Fractions are fine here: the same
                // ResolutionSelector accepts 8.3 / 4.2 elsewhere in this file. `auto` (no concrete
                // size) is the one case that keeps the author's baked 4MP.
                const pixels = size?.width && size.height ? size : resolveCanvasPixels(rawSize);
                if (pixels?.width && pixels.height) {
                    const area = Math.round(((pixels.width * pixels.height) / 1_000_000) * 100) / 100;
                    if (Number.isFinite(area) && area > 0) selector.inputs.megapixels = Math.min(16, Math.max(0.1, area));
                }
            }
        }
    }

    // MJ 味型 → the two MJ LoRAs only (210 影视柔光 / 211 风格滤镜). `standard` writes nothing so the
    // author's 0.55 / 0.60 stays authoritative; `off` zeroes both rather than unlinking them, because
    // a strength is a scalar nodeInfoList can carry while a link change needs the whole graph.
    // 209 zidiusArt is the baseline art style and is intentionally NOT part of this knob.
    const flavor = KREA2_MJ_FLAVOR_STRENGTHS[normalizeKrea2MjFlavor(mjFlavor)];
    if (flavor) {
        KREA2_MJ_FLAVOR_NODES.forEach((nodeId, index) => {
            const node = next[nodeId];
            const strength = flavor[index];
            if (node?.inputs && typeof node.inputs.strength_model === "number") node.inputs.strength_model = strength;
        });
    }

    // Fixed seed on KSampler (202) → identical images for identical inputs; randomize per run.
    const sampler = next[KREA2_MJ_STYLE_SAMPLER_NODE] || findComfyNode(next, (node) => /^KSampler/i.test(String(node.class_type || "")));
    if (sampler?.inputs && typeof sampler.inputs.seed === "number") sampler.inputs.seed = randomComfySeed();

    return { workflow: next };
}

/** Workflows that prefer model-script Export (API) JSON + comfy/run when the shared id denies ACL. */
function usesRunningHubLocalExportGraph(workflowId?: string | null) {
    return (
        isMinimaxH3SelfLiftWorkflow(workflowId) ||
        isQwenKleinSkinWorkflow(workflowId) ||
        isMinimaxH3RefTopWorkflow(workflowId) ||
        isMinimaxH3SingularityWorkflow(workflowId) ||
        isMinimaxH3HdDynamicWorkflow(workflowId) ||
        isMinimaxH3FisherWorkflow(workflowId) ||
        isMinimaxH3YzjinyuWorkflow(workflowId) ||
        isKrea2PastoralMjWorkflow(workflowId) ||
        // 独立模型（`2114341115852099586`）：不继承 Fisher 任何补丁，但第三方 app 图普遍 ACL 拒绝，
        // 所以保留「脚本里贴 Export」这条**通用**兜底 —— 否则它连提交都提交不了。
        isStandaloneH3ExportWorkflow(workflowId) ||
        isKrea2AidenLoraWorkflow(workflowId) ||
        isWorkFisherMossWorkflow(workflowId) ||
        // 【MINIMAX-H3】八月最强文戏：两张内置图 + `comfy/run`，不走远端 getJsonApiFormat。
        isMinimaxH3WenxiWorkflow(workflowId)
    );
}

/** Multi-ref Export graphs that prefer browser-direct upload/create (Pages proxy ERR_CONNECTION_CLOSED). */
function prefersRunningHubDirectSubmit(workflowId?: string | null) {
    return (
        isMinimaxH3SingularityWorkflow(workflowId) ||
        isMinimaxH3HdDynamicWorkflow(workflowId) ||
        isMinimaxH3FisherWorkflow(workflowId) ||
        isMinimaxH3YzjinyuWorkflow(workflowId) ||
        // 文戏 pair：3 图 + 2 音色一起上传，走 Pages 代理会 ERR_CONNECTION_CLOSED（同 Fisher/文武双全）。
        isMinimaxH3WenxiWorkflow(workflowId)
    );
}

function applyQwenKleinSkinSettings(
    workflow: ComfyWorkflow,
    prompt: string,
    size?: { width: number; height: number } | null,
    aspect = "",
    rawSize = "",
    megapixels = "",
): { workflow: ComfyWorkflow } {
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // User prompt → only the KSampler positive CLIP (5). Never touch negative (7) or the Klein
    // refine enhance text (54): both share the same "(Prompt)" title the generic scorer trusts.
    if (prompt.trim()) {
        const sampler =
            next["161"] || findComfyNode(next, (node) => /^KSampler$/i.test(String(node.class_type || "")) && Array.isArray(node.inputs?.positive));
        const positiveLink = sampler?.inputs?.positive;
        const positiveId = Array.isArray(positiveLink) && positiveLink[0] != null ? String(positiveLink[0]) : "5";
        const promptNode = next[positiveId] || next["5"];
        if (promptNode?.inputs && typeof promptNode.inputs.text === "string") promptNode.inputs.text = prompt;
    }

    // Draft latent size → ResolutionSelector (168). Leave ImageScaleToTotalPixels (56) at the
    // author's 4MP refine target — that node is not the canvas resolution knob.
    const selector = next["168"] || findComfyNode(next, (node) => node.class_type === "ResolutionSelector" && "aspect_ratio" in (node.inputs || {}));
    if (selector?.inputs) {
        const nextAspect = aspect || (size?.width && size.height ? closestResolutionSelectorAspect(size.width, size.height) : "");
        if (nextAspect && typeof selector.inputs.aspect_ratio === "string") {
            selector.inputs.aspect_ratio = resolutionSelectorAspectLabel(nextAspect);
        }
        const explicit = Number(megapixels);
        if (typeof megapixels === "string" && megapixels.trim() && Number.isFinite(explicit) && explicit > 0 && typeof selector.inputs.megapixels === "number") {
            selector.inputs.megapixels = explicit;
        } else if (typeof selector.inputs.megapixels === "number") {
            const tier = canvasResolutionTier(rawSize);
            if (tier) {
                const tierMegapixels = tier === "4k" ? 4 : tier === "2k" ? 2 : 1;
                const baked = selector.inputs.megapixels;
                selector.inputs.megapixels = Number.isFinite(baked) && baked > 0 ? Math.max(baked, tierMegapixels) : tierMegapixels;
            }
        }
    }

    // Fixed seeds on KSampler (161) and RandomNoise (50) → identical images; randomize per run.
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        if (/RandomNoise/i.test(type) && typeof node.inputs?.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        else if (/KSampler|SamplerCustom/i.test(type) && typeof node.inputs?.seed === "number") node.inputs.seed = randomComfySeed();
    }

    return { workflow: next };
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

/** `ref_audios.ref_audio_N`: the MiniMax H3 reference-to-video audio slot. */
const RH_REF_AUDIO_SLOT = /^ref_audios\.ref_audio_(\d+)$/;

function isComfyAudioLoaderNode(node?: ComfyNode) {
    if (!node?.inputs) return false;
    return /LoadAudio|AudioLoader|VHS_LoadAudio|AudioLoad|LoadAudioUpload/i.test(String(node.class_type || ""));
}

/** Field an audio loader expects the uploaded filename in (`audioUI` is the upload widget, not data). */
function audioFieldName(node: ComfyNode) {
    const inputs = node.inputs || {};
    for (const field of ["audio", "audio_file", "audio_path", "filename", "file"]) {
        if (typeof inputs[field] === "string") return field;
    }
    return "audio";
}

export type RunningHubAudioPatch = {
    workflow: ComfyWorkflow;
    /** Filenames actually written into the graph (0 = the graph has no audio surface). */
    applied: number;
    /** `LoadAudio` nodes invented because the export shipped no audio slot at all. */
    planted: number;
};

/**
 * Write uploaded audio references into a RunningHub export graph.
 *
 * Two shapes have to be covered, both real:
 *  - `MiniMaxH3ReferenceToVideo` **with** authored `ref_audios.ref_audio_*` (AIGC特异点 Singularity
 *    2110419404622643201 / 2110419416746909698): the slots exist but their `LoadAudio` nodes still
 *    hold `"None"`, so the model silently speaks with its own voice. Fill them in place.
 *  - The same class **without** any audio key (Work-Fisher 2110621324220567554 /
 *    2110621014144147458): the export never authored `ref_audios`, so a filename alone goes
 *    nowhere — plant `LoadAudio` nodes and add the links. `nodeInfoList` cannot create links, which
 *    is why the caller has to ship the graph whenever `planted > 0`.
 *
 * Both are *reference* audio: the node synthesises speech in that timbre, it does not mux the file.
 */
export function applyRunningHubReferenceAudios(workflow: ComfyWorkflow, fileNames: string[]): RunningHubAudioPatch {
    const names = (fileNames || [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
        .slice(0, 3);
    if (!names.length) return { workflow, applied: 0, planted: 0 };
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

    // Conditioning consumers: authored audio slots, or the reference-to-video class paired with image
    // slots (a text-to-video node has no `ref_images.*` and must not be touched).
    const consumers = Object.entries(next).filter(([, node]) => {
        const keys = Object.keys(node?.inputs || {});
        if (!keys.length) return false;
        if (keys.some((key) => RH_REF_AUDIO_SLOT.test(key))) return true;
        return /MiniMaxH3ReferenceToVideo/i.test(String(node?.class_type || "")) && keys.some((key) => key.startsWith("ref_images."));
    });

    // Numeric ids: some backends reject non-numeric node keys, so plant above the current maximum.
    const numericIds = Object.keys(next)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
    let nextId = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
    const takeId = () => {
        while (next[String(nextId)]) nextId += 1;
        const id = String(nextId);
        nextId += 1;
        return id;
    };

    let applied = 0;
    let planted = 0;
    for (const [, consumer] of consumers) {
        const inputs = consumer.inputs!;
        names.forEach((name, position) => {
            const key = `ref_audios.ref_audio_${position}`;
            const link = inputs[key];
            const sourceId = Array.isArray(link) ? String(link[0]) : "";
            const loader = sourceId ? next[sourceId] : undefined;
            if (loader && isComfyAudioLoaderNode(loader)) {
                loader.inputs![audioFieldName(loader)] = name;
                applied += 1;
                return;
            }
            const id = takeId();
            next[id] = { class_type: "LoadAudio", inputs: { audio: name }, _meta: { title: `Canvas Ref Audio ${position + 1}` } };
            inputs[key] = [id, 0];
            applied += 1;
            planted += 1;
        });
    }
    if (applied) return { workflow: next, applied, planted };

    // Fallback: graphs that consume audio through plain `LoadAudio` nodes (lip-sync / mux pipelines)
    // get the filenames in document order, mirroring the native ComfyUI path.
    const loaders = Object.entries(next)
        .filter(([, node]) => isComfyAudioLoaderNode(node))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    loaders.slice(0, names.length).forEach(([, node], position) => {
        node.inputs![audioFieldName(node)] = names[position];
        applied += 1;
    });
    return { workflow: applied ? next : workflow, applied, planted };
}

// ---------------------------------------------------------------------------
// MiniMax H3 台词方言（`<d>[Chinese]…</d>` + `(S1) says:`）
// ---------------------------------------------------------------------------
//
// 用户 2026-10-24 的两次反馈：
//   ① 「参考音色后，生成的视频会出现没有让他说的台词对话」（该念的没念）
//   ② 「我的意思是总是出现我未描述的对话台词」（不该念的乱念）
// 都不是图/音频接线问题（`applyRunningHubReferenceAudios` 本来就支持 1–3 条，`ref_audios.ref_audio_N`
// 落点也对），而是**提示词契约**问题。H3 的 Qwen3VL 编码器只认官方台词标记：
//   `苏晚 (S1) says: <d>[Chinese]你终于来了。</d>`
// 我们分镜表第四套吐出来的是 `- **对白**：` + `苏晚：“你终于来了。”`，这是自然语言 →
// 被读成「画面描述」而不是「要念出来的台词」；再叠上一条音色参考，模型就把整条片子当氛围片生成。
// 反过来，参考音频里有真人说话、而提示词又没锁死台词时，模型会**顺着参考音轨往下说**，
// 成片里冒出用户没写过的台词（第二条反馈）。
// 所以这里给两样东西：
//   A. 头部「音色声明」——每一条 `<Audio N>` 都点名，只取音色、不得复述/续写其中内容；
//   B. 尾部「台词锁定」——全片只许念 `<d>` 里那 N 句，禁止新增/旁白/画外音/复述参考音轨。
// 多说话人还必须给 `(S1)` / `(S2)` 稳定 ID，否则双人对白串音。
// 只在 MiniMax H3 家族调用；别的模型一个字节不变。作者自带 `<d>` 的正文也不动，只补契约。

/** H3 台词标签里的语种：跟台词本身走，不按界面语言。 */
function h3DialogueLanguage(text: string) {
    if (/[\uac00-\ud7af]/.test(text)) return "Korean";
    if (/[\u3040-\u30ff]/.test(text)) return "Japanese";
    return "Chinese";
}

const H3_DIALOGUE_LABEL = /^(\s*-\s*\*\*\s*对白\s*\*\*\s*[：:]\s*)([\s\S]*)$/;
const H3_DIALOGUE_SILENT = /^(无|无台词|无对白|（无）|\(无\)|none)$/i;
const H3_DIALOGUE_SPEAKER = /^([^：:，,。；;、「」“”"'（）()\s]{1,12})\s*[：:]\s*/;
/** `他低声说：` / `苏晚问：` 是舞台提示，不是说话人。 */
/**
 * 说话人动词尾：`张景惠说：…` / `苏晚低声说：…` / `他问道：…` 里的那一截，转写时要剥掉，
 * 剩下的才是说话人名字（用户 2026-10-25 给的真实写法就是 `张景惠说：`）。
 */
const H3_SPEAKER_VERB_TAIL = /(?:低声|轻声|大声|沉声|柔声|喃喃|自语|开口|嘟囔|继续|接着)?(?:说道|问道|答道|喊道|开口说|说|道|问|答|喊|叫|念|读)$/;

/**
 * `- **对白**：` 的收集边界 —— 碰到这些行就停，它们都不是台词。
 *
 * ⚠️ 用户 2026-10-25 的实样：对白下面紧跟 `视觉风格：七十五毫米镜头，光圈二点八…`，
 * 那行是**画面风格**，只收录到它之前。同理任何字段行、镜号标题、`【镜头 N】` 都是边界 ——
 * 多镜合并（一镜有对白、一镜没对白）时全靠这个不串味。
 */
const H3_DIALOGUE_BOUNDARY =
    /^\s*(?:[-*]\s*\*\*|#{1,6}\s|\[[^\]]*镜头|【[^】]*镜头|镜头\s*\d|镜号|(?:时长|景别|机位|运镜|人物站位|人物站位与构图|主体与动作|人物动作与表演|光影|光影与色调|转场|转场建议|音效|声音|台词与声音|负面|视觉风格|画面风格|画面内容|构图方式|摄影机参数|摄影机|镜头语言|风格|时间)\s*[：:])/;
const H3_PRONOUN_SPEAKER = /^(他|她|我|你|俺|咱)$/;

/**
 * 分镜表里的**字段名**：`- **对白**：` 下面如果漏了下一镜的标签行（写成了 `景别：中景`），
 * `H3_DIALOGUE_SPEAKER` 会把「景别」当成说话人，整行被包进 `<d>` 念出来 —— 这就是
 * 用户 2026-10-25 怀疑的「把我的提示词都当成对话台词」。命中的一律不当说话人。
 */
const H3_FIELD_LABEL =
    /^(时长|时间|秒数|景别|机位|景别／机位|运镜|运镜方式|人物站位|人物站位与构图|人物动作与表演|主体与动作|光影|光影与色调|转场|转场建议|对白|台词|声音|音效|台词与声音|负面|画面|画面内容|画面风格|视觉风格|镜头语言|构图方式|摄影机参数|摄影机|风格|镜头|镜号|镜头编号|镜头时长|场景|道具|情绪|角色|角色1|角色2|出场人物|风格提示词|画面描述)$/;

/**
 * 台词行里**内联**跟出来的分镜表字段 —— 从它开始整段砍掉。
 *
 * `H3_DIALOGUE_BOUNDARY` 只管**行首**：`- **对白**：` 下面那一行如果写成
 * `苏晚说：你终于来了。视觉风格：七十五毫米镜头，浅景深。`（对白和风格挤在同一行，
 * 或者用户手改时把风格接在台词后面），整行会被认成一句台词，**连风格一起包进 `<d>` 念出来**。
 * 用户 2026-10-25 第八次报障的原话「还把视觉风格：后面的提示词念出来了」就是这一种。
 * 所以台词正文在收口进 `<d>` 之前，再按字段名切一刀。
 */
const H3_INLINE_FIELD_CUT =
    /\s*(?:视觉风格|画面风格|影像风格|风格提示词|风格|景别／机位|景别|机位|运镜|时长|音效|声音|转场建议|光影与色调|光影|构图方式|摄影机参数|镜头语言|资产|参考图)\s*[：:]/;
function cutH3InlineFieldLabel(text: string) {
    const hit = String(text || "").search(H3_INLINE_FIELD_CUT);
    return (hit < 0 ? String(text || "") : String(text).slice(0, hit)).trim();
}

/**
 * 第四套 `video_motion_prompt` 末尾那句是**我们自动追加**的：
 * `不要出现字幕和文字，不要音乐，只要对白和环境音效。`（2026-10-25 前的旧版是「只要台词」）
 * —— 「只要对白」等于明确邀请模型说话。这一镜没有对白时，把它改成「只要环境音效」。
 * ⚠️ 新旧两版文案都要认（节点里已存的旧文案 + 用户脚本里手抄的），所以 `台词|对白` 都匹配。
 */
function dropDialogueInvitation(text: string) {
    return text.replace(/只要(?:台词|对白)\s*([和与])\s*环境音效/g, "只要环境音效");
}

/**
 * **有台词**的镜头：把那句模板尾巴里的「只要对白和环境音效」整段摘掉，只留「不要出现字幕和文字，不要音乐」。
 *
 * 2026-10-25 第六次报障（用户：`另外还是有多余的乱语音出现`，且「两种都有」= 有台词镜多念 + 静音镜也出声，
 * 多出来的声音「像在念我的分镜表文字」/「含糊的中文嘀咕」，并且**挂了音色参考**）。
 * 追到的第一条：`dropDialogueInvitation` 只在「没有对白块」和「一个台词都没认出来」两个分支里跑，
 * **有台词的分支一次都没跑过** —— 于是这一镜的提示词里同时存在
 *   `<d>[Chinese]你终于来了。</d>`（台词有界）
 *   和 `…只要对白和环境音效。`（对白无界）
 * 后者是一句无上限的邀请：H3 顺着它把中文正文当台词往外念。有 `<d>` 时正文已经承担台词，
 * 这句话里「对白」两个字纯属多余，必须只留「不要出现字幕和文字，不要音乐」。
 *
 * ⚠️ 不能复用 `dropDialogueInvitation`（它是把「对白」换成「环境音效」）：对**有声镜**说「只要环境音效」
 *    等于反过来把该念的台词压掉。所以这里是**整段删除**。
 */
function stripDialogueInvitationClause(text: string) {
    return text
        .replace(/[，,、]?\s*只要(?:台词|对白)\s*[和与]\s*环境音效\s*[。.]?/g, "。")
        .replace(/[，,]\s*。/g, "。");
}

// ⚠️ **已废弃：`wrapH3DescriptionSlot`（官方第一个槽位）。**
// 第六轮曾把正文套进 `integrated_multimodal_description:`，第七次报障证明反向有害 ——
// 用户「把你配置的规范都读出来了，我写的对话一个字都没念」。原因是 H3 并不解析这套槽位名，
// 它把整段提示词（含槽位头）当素材往下生成，于是 `integrated_multimodal_description:` 这种
// 英文标识也进了「可念内容」。Fisher 现在走「干净模式」，只发正文 + `<d>`（见 `adaptMinimaxH3ReferencePrompt`）。

/**
 * 把分镜表的**字段骨架**从正文里摘掉 —— 用户第六次报障的原话是「像在念我的分镜表文字」。
 *
 * H3 的 `integrated_multimodal_description` 官方定义是「画面 / 动作 / 分镜 / 说话人 / **台词** / 现场音」
 * 那一栏（见官方 `VIDEO_PROMPT_WRITING_GUIDE`）—— 也就是说**这一栏里的中文，模型默认当剧本来念**。
 * 我们的正文是第四套生成的分镜表：`- **时长**：6秒` / `- **景别／机位**：近景` / `- **音效**：…`，
 * 每一个字段名都是一句「可以念的中文」。H3 分不清「标签」和「台词」，就连着标签一起念 ——
 * 于是成片里多出 `画面：` `时长：` 这种声音，还伴着含糊的中文嘀咕。
 *
 * 处理原则（**只改发出的提示词，不动画布节点里的正文**）：
 *  - 镜头标题 `【镜头 1】` → `[Shot 1]`（官方分镜块写法）；
 *  - `画面：X` / `视觉风格：X` / `主体与动作：X` … → **只留 X**（值全部保留，只去掉字段名）；
 *  - `时长：` / `音效：` / `转场建议：` / `镜头编号：` → 整行去掉（时长是节点参数、音效已搬进声音槽位）；
 *  - `对白：` / `台词：` → 值是 `无` 就整行去掉，有内容就降级成散文留下（它没被转成 `<d>`，说明本来就不是台词）；
 *  - 我们的契约行（`【静场】`/`【口型约定】`/`【台词锁定】`）、`Xxx (S1) says:`、`<d>…</d>`、`[Shot N]` 一律不动。
 *
 * ⚠️ 只给 Fisher 两个 id（`audioNegation`）跑：别的族吃的是自然语言，剥掉标签反而丢信息。
 */
const H3_SCAFFOLD_ALWAYS_DROP = new Set(["时长", "镜头时长", "镜头编号", "转场建议", "转场", "字幕", "备注"]);
/**
 * 音效类标签：**只留值、不留标签**。
 *
 * ⚠️ 2026-10-25 第七次报障后，声音槽位整个撤掉了（见 `adaptMinimaxH3ReferencePrompt` 的「干净模式」），
 * 环境音只能回到正文里；但字段名 `音效：` 仍然不念 —— 用户投诉的「念分镜表文字」针对的是标签本身。
 */
const H3_SCAFFOLD_SOUND_LABELS = new Set(["音效", "声音", "环境音", "台词与声音", "声音设计"]);
const H3_SCAFFOLD_DIALOGUE_LABELS = new Set(["对白", "台词"]);
/**
 * 风格类字段：**整行丢掉**（连值一起），clean mode 专有。
 *
 * 用户 2026-10-25 第八次报障：「还把 **视觉风格：后面的提示词**念出来了，之前不是改过，
 * 这两个模型的对话提示词锁定到视觉风格：的前面吗？」
 *
 * 先说清机制：`H3_DIALOGUE_BOUNDARY` 那一层只保证**台词 `<d>` 收集到 `视觉风格：` 之前**（这个没坏，
 * 台词没被吞）。坏的是下一层 —— `stripH3Scaffolding` 把 `视觉风格：七十五毫米镜头，光圈二点八…`
 * **只去掉字段名、把值原样留在正文**，于是那句「七十五毫米镜头，光圈二点八，浅景深，胶片颗粒，冷调」
 * 变成一条独立成段的裸中文，紧跟在该镜 `<d>` 之后。H3 把它当「接着要念的一行」读了出来。
 *
 * 为什么这一版是**删掉**而不是「挪到别处 / 换个写法」：项目里已经用七轮验证过同一件事 ——
 * H3 只认「删掉内容 / `<d>` 定界 / `<Audio N>` 声明 / 不挂参考音频」这四个杠杆，任何「换个说法再发一次」
 * （套槽位、加否定式、改英文、加【静场】）都被它念出来。风格词是纯画面参数、又天然长得像一句旁白，
 * 是这套模型最容易念的东西。画风交给参考图 + 279 风格 LoRA 档位（`videoFisherLoraStrength`）承担。
 *
 * ⚠️ 只有 Fisher（`audioNegation`）走这里。别的族继续保留字段值 —— 它们吃自然语言，风格词有用。
 * ⚠️ 想撤回只需要把这一组清空（`new Set()`），`stripH3Scaffolding` 其余逻辑不用动。
 */
const H3_SCAFFOLD_STYLE_LABELS = new Set(["视觉风格", "画面风格", "影像风格", "风格提示词", "风格"]);
const H3_SCAFFOLD_KEEP_VALUE = new Set([
    "画面", "主体与动作", "动作", "景别", "景别／机位", "景别/机位", "机位",
    "运镜", "镜头运动", "人物站位与构图", "站位与构图", "构图", "光影与色调", "光线与色调",
    "光影", "光线", "色调", "氛围", "首帧提示词", "静帧提示词", "资产", "引用资产", "参考图",
]);
/** `无` / `none` / `—` 这类「没有」写法。 */
const H3_EMPTY_VALUE = /^(?:无|没有|none|n\/?a|—+|–|-|（无）|\(无\))\s*[。.]?$/i;

/**
 * 画布里的参考图 chip 名（`图片1` / `图1` / `image 1`）→ 官方方言 `<Picture 1>`。
 *
 * 用户 2026-10-25：「现在这两个模型**连场景图都参考不上了**」。
 * 图确实传上去了（`ref_images.ref_image_0…` 一一对应，见 `applyMinimaxH3FisherSettings`），
 * 但**正文里没有任何模型认得的绑定记号**：铺链写进去的是中文 chip 名「图片1（苏晚）」，
 * 而 H3 的参考绑定方言是 `<Picture N>`（作者导出里的示例就是 `<Subject 1>` / `<Picture N>` 那一套，
 * 这也是 `comfyui-native.ts` 里反复提到的「`ref_image_N` ↔ `<Picture N+1>`」）。
 * 一串中文「图片1」对模型既是**无意义字符串**、又是一句**可念的中文**，两头不讨好。
 *
 * 所以 clean mode 出站前把它换成官方记号：绑定更硬，且 `<Picture 1>` 是结构 token、不是记叙文。
 * ⚠️ 只作用于正文；`<d>` 台词行不碰（台词里真提到「图片1」是用户的原话）。
 */
const H3_PICTURE_REFERENCE = /(?:参考图|图片|图)\s*([1-9]\d?)|image\s*([1-9]\d?)/gi;
function toH3PictureReferences(text: string) {
    return String(text || "").replace(H3_PICTURE_REFERENCE, (_match, zh: string, en: string) => `<Picture ${zh || en}>`);
}

function stripH3Scaffolding(text: string, options?: { keepStyleFields?: boolean }) {
    const out: string[] = [];
    for (const raw of String(text || "").split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) {
            out.push("");
            continue;
        }
        // 我们自己的契约行 / 官方分镜块 → 原样（`【镜头 N】` 不在此列，它要改写成官方的 `[Shot N]`）
        if (/^【(?:静场|口型约定|台词锁定)】/.test(trimmed) || /^\[Shot\s*\d+\]/i.test(trimmed)) {
            out.push(trimmed);
            continue;
        }
        // 台词块（`苏晚 (S1) says:` + `<d>…</d>`）→ 原样，绝不碰
        if (/says\s*:/i.test(trimmed) || /<\s*d\s*>/i.test(trimmed)) {
            out.push(trimmed);
            continue;
        }
        // 镜号标题（`【镜头 1】`）**原样保留**：它是用户的分镜结构，也是模型认镜边界的地方。
        // ⚠️ 2026-10-25 第七次报障：改写成英文 `[Shot 1]` 反而多出一串可以被念出来的英文 token，
        // 且消息是「把你配置的规范都读出来了」—— 用户的原文越少被改写，越不容易被当稿子念。
        const labelled = trimmed.match(/^[-*·•]?\s*\*{0,2}\s*([^：:*]{1,14}?)\s*\*{0,2}\s*[：:]\s*(.*)$/);
        if (labelled) {
            const label = labelled[1].trim();
            const value = labelled[2].trim();
            if (H3_SCAFFOLD_ALWAYS_DROP.has(label)) continue;
            // 风格类：**连值一起丢**（只有 Fisher 走这里，见 `H3_SCAFFOLD_STYLE_LABELS` 的注释）。
            // `keepStyleFields` = 视频设置面板上的「提交视觉风格字段」开关（Fisher 三个 id，默认关）。
            // 打开后不丢整行，而是落到下面那条兜底「只留值」—— 字段名照样不发音，风格文字能进提示词。
            if (!options?.keepStyleFields && H3_SCAFFOLD_STYLE_LABELS.has(label)) continue;
            // 我们自己的「参考图片编号：图片1、图片2。请按这些编号理解提示词中的图片引用。」也是说明文，
            // 整行不许念（值里的「请按这些编号理解…」就是一句招人声的中文）
            if (/^(?:参考图片编号|参考图编号|图片编号|图编号|编号)$/.test(label)) continue;
            if (H3_SCAFFOLD_SOUND_LABELS.has(label)) {
                if (value && !H3_EMPTY_VALUE.test(value)) out.push(toH3PictureReferences(value));
                continue;
            }
            if (H3_SCAFFOLD_DIALOGUE_LABELS.has(label)) {
                if (!value || H3_EMPTY_VALUE.test(value)) continue;
                out.push(toH3PictureReferences(value));
                continue;
            }
            if (H3_SCAFFOLD_KEEP_VALUE.has(label)) {
                if (value && !H3_EMPTY_VALUE.test(value)) out.push(toH3PictureReferences(value));
                continue;
            }
            // ⚠️ 兜底：**任何** `标签：值` 都只留值（2026-10-25 第八次报障）。
            // 之前只有白名单里的标签才剥名字，`- **场景**：咖啡馆` / `出场人物：…` 这类会把
            // 「- **场景**：」连同星号一起发出去 —— 星号念不出来，但「场景」两个字念得出来，
            // 而且 `**` 会打断模型对整段的解析。未知字段一律降级成裸值。
            if (value && !H3_EMPTY_VALUE.test(value)) out.push(toH3PictureReferences(value));
            continue;
        }
        // 普通散文：去掉列表符号（`- xxx` → `xxx`），让整段读起来是描述而不是清单
        out.push(toH3PictureReferences(trimmed.replace(/^[-*·•]\s+/, "")));
    }
    return out
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");
}

/**
 * 干净模式（Fisher 两个 id + 独立模型）连**我们自动追加的那块尾巴**也一起拿掉。
 *
 * 第四套会给每条 `video_motion_prompt` 末尾补一块固定尾巴（2026-10-26 起是四行
 * `【禁止项】` / `【强制声明】`；更早是单行 `不要出现字幕和文字，不要音乐，只要对白和环境音效。`）。
 * 那是**我们写的、用户脚本里没有的**说明文：H3 不解析它、只会当素材念，而且它明确在要一条
 * 「有音效 / 有人声」的音轨 —— 静音镜（`- **对白**：无`）会被填成一片人声噪杂。
 * 用户 2026-10-25：「静音镜正常是这样的，`- **对白**：无`」—— 那一行是分镜表本身，不能动；
 * 能动的是我们追加的尾巴，干净模式整块不给。
 * ⚠️ 判据**只走** `isStoryScriptDirectorSoundNoteLine`（唯一来源在 `constant/story-script.ts`）：
 * 它同时认新版四行的行首指纹与旧版「不要出现字幕…」前缀，别在这里再抄一份字符串。
 */
function stripH3SoundNote(text: string) {
    return text
        .split("\n")
        .filter((line) => !isStoryScriptDirectorSoundNoteLine(line))
        .join("\n");
}

/**
 * 静音镜的「静场」声明 —— 2026-10-25 第二次返工（上一版是「旁白镜」，已被证明是返效果）。
 *
 * ⚠️ 上一版写的是：`【旁白镜】…声音是画外旁白与环境音，旁白不出现在画面里。`
 * 那句话在当时看是「顺水推舟」（用户诉求：把乱讲的台词变成不动嘴的画外音），但对 H3 是**正向下单**：
 * H3 是音视频联合模型，文本编码器是 Qwen3-VL，**不听否定、只顺着名词往下生成** ——
 * 你要一条「画外旁白」，它就真的配一条旁白音轨，而旁白念的自然就是提示词本身的语言。
 * 用户 2026-10-25 的实样完全对得上：「这次不是乱说韩语了，是乱说中文」——
 * `6ce1a6f` 把风格 LoRA 归零，韩语人声（LoRA 先验）消失了；剩下这条**中文旁白**正是这句话招来的；
 * 而**一旦有了人声，H3 就顺手把字幕烧进画面**（它训练数据里的剧集画面就是带字幕的），
 * 所以「乱说话」和「带字幕」是同一个根因，不是两件事。
 *
 * 这一版的口径：一个「旁白 / 画外音 / 人声 / 台词 / 对白 / 字幕 / 文字」都不许出现。
 * 只留两句正向事实 —— 人物闭口（唇动只由 `<d>` 驱动，这一镜没有 `<d>`）、本镜只有环境音。
 * 字幕不在提示词里跟模型抢（抢不过，见上面的机制），交给生成后的底部裁切
 * （`lib/video-subtitle-crop.ts`）兜底。
 */
const H3_NARRATION_SHOT_NOTE = "【静场】画面内人物全程闭口，唇形与下颌静止，没有开口动作。";

/**
 * 官方 AV 三字段契约 —— 2026-10-25 第四次报障（「现在还是在乱说话」）的根因。
 *
 * 翻 MiniMax H3 官方提示词指南才明白：H3 的提示词**不是段落，是三个具名槽位**
 * （R2V/FL2VA 的 `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`），
 * 官方原话是「**把对白、房间声、配乐都写出来，否则 H3 会自己编**」。
 *
 * 我们前三轮全在改「中文描述正文」，三个槽位里**一个都没填** —— 尤其没有 `overall_soundscape`。
 * 空槽位不会被当成「没有声音」，而是被模型**补全**：它手里是一段中文剧集分镜、人物正对镜头，
 * 补出来的自然是中文人声。所以「不写台词」在 H3 眼里等于「声音随你发挥」。
 * 这也解释了为什么每加一条中文限制（旁白镜/静场/口型约定）都不见效：正文里多一句中文，
 * 只是给「补全」多一个素材，槽位仍然是空的。
 *
 * 所以静音镜的正确做法是**把声音槽位填满、并把「无人声」写进槽位里**（官方同类写法：
 * 「No dialogue, no music, no text.」），而不是在正文里劝它别说话。
 * 官方对「完全无对话的镜头」的指导意见也一致：删掉对白 + 明确写闭嘴 + **给持续安静的具体背景声**。
 *
 * ⚠️ 幂等：正文里已经有 `overall_soundscape:`（用户或作者自己按官方格式写过）就一个字节都不加。
 * ⚠️ 只加这两个槽位，不动正文一个字 —— 正文是用户的分镜表，我们无权改写。
 */
const H3_SOUNDSCAPE_MARK = /overall_soundscape\s*:/i;
/** 正文里「有要念的台词」的唯一判据：官方 `<d>…</d>`。 */
const H3_SCRIPT_DIALOGUE_MARK = /<\s*d\s*>/i;

/** 分镜表里的环境音来源：`- **音效**：…` / `声音：…` / `环境音：…`。 */
const H3_SOUND_FIELD = /^[^\S\r\n]*[-*]?\s*\*{0,2}\s*(?:音效|声音|环境音|台词与声音|声音设计)\s*\*{0,2}\s*[：:]\s*(.*)$/m;
/** 没写环境音时的兜底描述：具体、安静、只有场景底噪（官方要求「给持续安静的具体背景声」）。 */
const H3_SOUNDSCAPE_FALLBACK = "Quiet, continuous ambient sound of the location itself (room tone or outdoor background).";

function h3SoundscapeOf(text: string) {
    const match = String(text || "").match(H3_SOUND_FIELD);
    const value = match ? match[1].trim().replace(/[。.；;]\s*$/, "") : "";
    if (!value || /^(无|无音效|none|n\/?a|—+|–|-)$/i.test(value)) return H3_SOUNDSCAPE_FALLBACK;
    return value;
}

/** 镜号标题：`【镜头 1】` / `[镜头1]` / `## 镜头 2` / `**镜头 1**` / `镜头 3：` / `第 2 镜`。 */
const H3_SHOT_HEADING =
    /^\s*(?:[-*]\s*)?\*{0,2}\s*(?:#{1,6}\s*)?(?:【[^】]{0,10}镜头[^】]{0,10}】|\[[^\]]{0,10}镜头[^\]]{0,10}\]|镜头\s*[0-9０-９一二三四五六七八九十]+|第\s*[0-9０-９一二三四五六七八九十]+\s*镜)/;

/** 按镜号标题把一段提示词切成镜头块（没有标题行就是 1 块）。 */
function splitH3ShotBlocks(text: string): string[] {
    const blocks: string[][] = [];
    for (const line of String(text || "").split("\n")) {
        if (!blocks.length || H3_SHOT_HEADING.test(line)) blocks.push([line]);
        else blocks[blocks.length - 1].push(line);
    }
    return blocks.map((lines) => lines.join("\n")).filter((block) => block.trim());
}

/**
 * 没有镜号标题时的兜底切法：按 `- **对白**：` 出现的位置切段。
 * 合并段（每 2/3/4/5 镜一段）在个别脚本里只剩多个对白块、没有 `【镜头 N】` 标题，
 * 那时也得分段判断「这镜要不要说话」，否则又退回「一句槽位配多镜」。
 */
function splitH3ByDialogueLabels(text: string): string[] {
    const lines = String(text || "").split("\n");
    const starts = lines.reduce<number[]>((acc, line, index) => (H3_DIALOGUE_LABEL.test(line) ? [...acc, index] : acc), []);
    if (starts.length < 2) return [];
    return starts.map((start, position) => lines.slice(start, starts[position + 1] ?? lines.length).join("\n"));
}

/**
 * 多镜提示词的**逐镜**声音槽位 —— 2026-10-25 第五次报障（用户：整张分镜表 + LoRA 0 仍在乱说话，
 * 「静音镜有人说话」和「有声镜多出没写过的台词」同时出现）。
 *
 * 前几版只有**一句全局** `overall_soundscape`，混排时它必然自相矛盾：
 * 有 `<d>` → 不敢写「无人声」（怕把该念的也否掉），于是整段只有环境音几个字；
 * 可 H3 是音视频联合模型，一个槽位配不上多镜，它会自己把剩下的填满 ——
 *   - 静音镜被填出人声（症状一）；
 *   - 有声镜除了台词还多念几句（症状二，槽位没说「只念这些」）。
 * 官方槽位本来就是一整段声音描述，所以多镜就**逐镜写**：每镜一行，静音镜显式排除人声，
 * 有声镜显式限定「只念本镜标出的台词」。这也是唯一能同时压住两个症状的位置（正文里劝没用，见前四轮）。
 */
/**
 * 统计镜数之前，先把**我们自己贴的契约骨架**从提示词里摘掉。
 *
 * 骨架有两段，都不是用户的分镜表：
 *  - 头部 `<Audio 1> is the voice-timbre reference for 苏晚 (S1). …`（`buildH3TimbreDeclaration`）；
 *  - 尾部 `【台词锁定】` 及其下一行（`buildH3DialogueLock`）。
 *
 * ⚠️ 2026-10-25 第六次报障的真凶之一（用户：「还有多余的乱语音出现」，而且**挂了音色参考**）：
 * `withH3VoiceContract` 在 `withH3AudioStatement` **之前**跑，于是那句音色声明顶在正文最前面、
 * 自成一块。`splitH3ShotBlocks` 只按镜号标题切，第一行不是标题就**新起一块** ——
 * 单镜视频硬生生被切成两块：块 1 = 音色声明（没有 `<d>` → 判成静音镜），块 2 = 真镜头。
 * 结果声音槽位变成
 *   `Shot 1: … No dialogue, no voices.` / `Shot 2: … Only the lines written for this shot are spoken`
 * —— 一条不存在的「第 1 镜」在对模型说「这镜没人说话」，等于邀请它自己补一段声音。
 * `audioCount = 0` 时没有声明行，所以这个 bug 只在挂参考音色时出现，正好对上用户的描述。
 *
 * 只用于**统计镜数/取环境音**，不改交付给模型的文本（骨架照旧跟着提示词走）。
 */
function stripH3VoiceContractScaffold(text: string) {
    return String(text || "")
        .split("\n")
        .filter((line) => !/^\s*<Audio\s*\d+>\s*is\b/i.test(line))
        .join("\n")
        .replace(/\n*【台词锁定】[\s\S]*$/, "")
        .replace(/\s+$/, "");
}

function h3PerShotSoundscape(text: string): string {
    const script = stripH3VoiceContractScaffold(text);
    const byHeading = splitH3ShotBlocks(script);
    const blocks = byHeading.length >= 2 ? byHeading : splitH3ByDialogueLabels(script);
    if (blocks.length < 2) return "";
    // 某一镜没写 `- **音效**：` 时，退回整段那条（分镜表常见：只在第一镜写了环境音）。
    const global = h3SoundscapeOf(script);
    return blocks
        .map((block, index) => {
            const own = h3SoundscapeOf(block);
            const ambience = own === H3_SOUNDSCAPE_FALLBACK ? global : own;
            return H3_SCRIPT_DIALOGUE_MARK.test(block)
                ? `Shot ${index + 1}: ${ambience} Only the lines written for this shot are spoken; no other voices, no narration. The description is never read aloud.`
                : `Shot ${index + 1}: ${ambience} No dialogue, no voices. Nothing in the description is read aloud.`;
        })
        .join("\n");
}

/**
 * 补官方声音槽位。`silent` 由「正文里有没有 `<d>`」决定 —— 和 `isMinimaxH3FisherSilentShot` 同一条判据。
 *
 * ⚠️ **两级作用域**（2026-10-25 用户明确要求「改动都只针对这两个模型」）：
 *  - **槽位本身**给 H3 全族（`overall_soundscape` 是官方格式，填上永远比空着对）；
 *  - **两句否定式**（`No dialogue, no voices.` / `non_diegetic_music: N/A`）**只给 Fisher 两个 id**
 *    （`negate` = `isMinimaxH3FisherWorkflow`）。原因：别的族提示词里的台词若没被转成 `<d>`，
 *    加这句会把该念的话也否掉；`non_diegetic_music: N/A` 还会压掉本来要 BGM 的族。
 *    所以**别把 `dropSoundNote` 兼作这个判据** —— 那是「撤掉模板声音说明」，两件事。
 */
function withH3AudioStatement(text: string, negate = false) {
    if (H3_SOUNDSCAPE_MARK.test(text)) return text;
    const hasDialogue = H3_SCRIPT_DIALOGUE_MARK.test(text);
    const ambience = h3SoundscapeOf(text);
    const body = String(text || "").replace(/\s+$/, "");
    if (!negate) return `${body}\n\noverall_soundscape: ${ambience}`;
    // 多镜（整张分镜表 / 合并段）→ 逐镜写；单镜 → 一句写全。两种都只能落在槽位里。
    const perShot = h3PerShotSoundscape(text);
    if (perShot) return `${body}\n\noverall_soundscape:\n${perShot}\nnon_diegetic_music: N/A`;
    const soundscape = hasDialogue
        // 有台词也要说清楚「只念这些」——否则 H3 除了台词还会自己再编几句（症状：多出没写过的台词）。
        // ⚠️ 末句「The description is never read aloud」是 2026-10-25 第六次报障补的：用户说多出来的声音
        // 「像在念我的分镜表文字」——正文（`- **画面**：…`）在没有这个约束时会被当成台词稿朗读。
        ? `${ambience} Only the lines written above are spoken; no other voices, no narration. The description is never read aloud.`
        : `${ambience} No dialogue, no voices. Nothing in the description is read aloud.`;
    return `${body}\n\noverall_soundscape: ${soundscape}\nnon_diegetic_music: N/A`;
}

/**
 * 幂等：正文里已经有 `【静场】` 就不再追加。
 * ⚠️ 顺手摘掉旧版的 `【旁白镜】…` 行（招人声的那句）—— 老提示词/用户手抄的脚本里可能还留着，
 * 不清掉就等于仍然在下单旁白。
 */
function withH3NarrationShotNote(text: string) {
    const body = text
        .split("\n")
        .filter((line) => !line.includes("【旁白镜】"))
        .join("\n")
        .replace(/\s+$/, "");
    if (body.includes("【静场】")) return body;
    return `${body}\n\n${H3_NARRATION_SHOT_NOTE}`;
}

/**
 * 混合镜的「口型约定」—— 用户 2026-10-25 的第四个诉求：
 * 「遇到一个视频的提示词里多个镜头，一个镜头有台词、一个镜头无台词，是否也能把无台词自己产生的乱话
 *  变成不动嘴的画外音，有台词的按我的台词正常动嘴」。
 *
 * 这就是 H3 的原生特性：**唇动只由 `<d>` 驱动**。一个镜头写了 `<d>` 就开口，没写就闭嘴。
 * 但模型不知道我们这套约定，它会把「没写台词」理解成「自由发挥」。所以要给它一句**按镜头的映射**：
 * 有 `<d>` 的镜头正常开口，其余镜头闭口 + 只有环境音。
 *
 * ⚠️ 和 `【静场】` 是**互斥**的两件事，别混用：
 *   - 整段一句话都没有台词 → `【静场】`（全片闭嘴、只有环境音）；
 *   - 有台词也有静音镜 → `【口型约定】`（分镜处理）。写成「全片闭嘴」会把该念的台词也一起闭掉。
 * ⚠️ 这段文字里**不许出现 `<d>` 字面量**：H3 的台词方言是成对的 `<d>…</d>`，单独露一个开标签
 * 可能把后面整段（含台词锁定）都算进台词里。改用「标了台词的镜头」这种自然语言指代。
 * ⚠️ 也**不许出现「画外旁白」**（2026-10-25 第二次返工的教训，见 `H3_NARRATION_SHOT_NOTE`）：
 * 静音镜那半句「声音是画外旁白」等于给模型下单一条中文旁白，连带把字幕烧进画面。
 * ⚠️ 还是要短：H3 不是听指令的 LLM，堆禁止清单等于把「台词/人声」喂给它。
 */
const H3_MIXED_LIPSYNC_NOTE =
    "【口型约定】本次包含多个镜头：标了台词的镜头，人物按台词正常开口说话；没有标台词的镜头，人物全程闭口，唇形与下颌静止，只有环境音。";

/**
 * 幂等：正文里已经有这句就不再追加。
 * ⚠️ 旧版尾巴是「声音是画外旁白与环境音，人物不在画面里开口」—— 含「旁白」的旧行整行摘掉再贴新版。
 */
function withH3MixedLipsyncNote(text: string) {
    // ⚠️ 判重必须在**过滤之前**：老写法先滤掉含【口型约定】的行、再检查 `body.includes`，
    // 那个检查永远为假 → 每次适配都把这句话挪到末尾。加上官方声音槽位之后，
    // 「挪位」会让「适配两次 == 适配一次」失败（幂等探针 M5 抓到）。
    if (text.includes("【口型约定】")) {
        return text
            .split("\n")
            .filter((line) => !line.includes("画外旁白"))
            .join("\n")
            .replace(/\s+$/, "");
    }
    const body = text
        .split("\n")
        .filter((line) => !line.includes("【口型约定】") && !line.includes("画外旁白"))
        .join("\n")
        .replace(/\s+$/, "");
    if (body.includes("【口型约定】")) return body;
    return `${body}\n\n${H3_MIXED_LIPSYNC_NOTE}`;
}

/** 台词锁定的幂等标记：提示词里已经有这段就不再追加。 */
const H3_DIALOGUE_LOCK_MARK = "【台词锁定】";

/**
 * 空提示词的兜底正文。
 *
 * H3 是**音视频联合生成**模型：喂空串等于让它自由发挥 —— 有参考图时会自己编一段戏，
 * 还常常连带编出台词/韩语对白（作者那支 `MysticXXX_MMH3-V1` LoRA 本身就是韩剧味）。
 * 这句只写画面，人声交给 `buildH3DialogueLock(0)` 压住。
 */
const H3_SILENT_FALLBACK_PROMPT =
    "沿用参考图里的人物、场景、光线与构图，人物做自然的细微动作，镜头稳定，写实质感。";

function countH3DialogueLines(text: string) {
    return (text.match(/<\s*d\s*>/gi) || []).length;
}

/**
 * 音色声明：**每一条**传进来的 `<Audio N>` 都必须点名。
 *
 * 措辞照抄 MiniMax 官方 Ref2VA 的 subject_definitions 写法：
 * `<Audio 1> is the voice-timbre reference for <Subject 1> (S1). It provides vocal tone and pacing
 * only; do not copy its original words.` —— 官方明确「只给音色和节奏、不复制原词」。
 *
 * ⚠️ 只声明绑得上说话人的那几条，剩下的 `<Audio 2>`/`<Audio 3>` 在提示词里就是孤儿，
 * 模型会把它们当成「另一条待播的台词轨」→ 成片里冒出用户没写过的台词。
 */
function buildH3TimbreDeclaration(audioCount: number, speakers: string[], sourceText: string) {
    if (audioCount <= 0) return "";
    const anySpeaker = speakers.some((name) => Boolean(String(name || "").trim())) || /\(S\d+\)/.test(sourceText);
    const rows: string[] = [];
    for (let index = 0; index < audioCount; index += 1) {
        const tag = `S${index + 1}`;
        const name = (speakers[index] || "").trim();
        const hasTag = new RegExp(`\\(${tag}\\)`).test(sourceText);
        let who = "";
        if (name) who = `${name} (${tag})`;
        else if (hasTag) who = `the speaker (${tag})`;
        // 整条提示词没有任何说话人（无对白块）→ 第 1 条仍按音色参考声明，别降级成「备用样本」。
        else if (!anySpeaker && index === 0) who = "the speaking character";
        rows.push(
            who
                ? `<Audio ${index + 1}> is the voice-timbre reference for ${who}. It provides vocal tone and pacing only; do not copy its original words.`
                : `<Audio ${index + 1}> is an extra timbre sample and carries no dialogue. It only provides vocal tone; do not copy its original words.`,
        );
    }
    return rows.join("\n");
}

/**
 * 台词锁定：贴在提示词末尾（用户自己的写法也是结尾放 `【强制声明】`）。
 *
 * 用户第二次反馈「总是出现我未描述的对话台词」—— 参考音频里有真人说话时，H3 会顺着往下说；
 * 只写「只取音色」压不住，必须把「全片只有这 N 句台词」写成硬约束。
 * 最后两行抄自 MiniMax 官方 voice-clone 示例的 `AVOID:` 清单（paraphrased dialogue / extra lines）。
 */
/**
 * 台词锁定：**只有真的挂了参考音频时才加**，而且只加两行。
 *
 * ⚠️ 2026-10-25 用户第三次反馈「越改越糟，不管写不写对白全在乱说话」——
 * 上一版这里追加的是一大段中文 + 一条英文 `Avoid: …` 清单。H3 是**音视频联合**模型
 * （文本编码器是 Qwen3-VL，不是会听指令的 LLM），几百字的「台词/人声/对白/旁白/画外音」
 * 说明反而把这些词喂给了它 —— 越强调越说。所以：
 *   - `audioCount <= 0`（没有参考音色，根本没有「复读参考音轨」的风险）→ **一个字都不加**；
 *   - 有音色参考 → 只留「只念这几句、不重复音频原词」两行，不列举、不写英文清单。
 *
 * ⚠️ **这段文字里一个尖括号都不许出现**（2026-10-25 第六次报障的真凶之二，比镜数误切更直接）：
 * 上一版写的是「只念 `<d>` 与 `</d>` 之间的台词，共 N 句；`<Audio N>` 只借音色…」——
 * 那句里的 `<d>` 与 `</d>` 是一对**闭合的台词标记**，中间正好夹着「与」字。
 * H3 的解析器只认标签，于是凭空多出一个只有「与」的台词块，成片里就是一声含糊的中文嘀咕；
 * `<Audio N>` 里的 `N` 不是数字，也会被当成一条编号不明的音轨。
 * 这解释了为什么「挂了音色参考」才出问题：`audioCount = 0` 时这段锁根本不加。
 * 现在的写法只用自然语言指代（「这几句台词」「参考音轨」），不带任何标签字面量。
 */
function buildH3DialogueLock(lineCount: number, audioCount: number) {
    if (audioCount <= 0) return "";
    const rows = [H3_DIALOGUE_LOCK_MARK];
    if (lineCount > 0) {
        rows.push(`全片只有 ${lineCount} 句台词，只念这几句，不增不减；参考音轨只借音色，不重复、不续写、不翻译它里面的内容。`);
    } else {
        rows.push("本段没有台词：只保留环境音与音效，不要出现人声。");
    }
    return rows.join("\n");
}

/** 把「音色声明（头）+ 台词锁定（尾）」贴到提示词上，幂等。`lineCount < 0` 表示不锁台词。 */
function withH3VoiceContract(text: string, audioCount: number, lineCount: number, speakers: string[]) {
    // ⚠️ 判重只认「声明行」本身（`<Audio 1> is …`）。早期版本用 `includes("<Audio 1>")`，
    // 而正文里任何一处提到 `<Audio 1>`（比如旧版的 `says … referenced from <Audio 1>`）都会命中，
    // 结果声明一条都加不上。
    const hasDeclaration = text.includes("<Audio 1> is ");
    const declaration = hasDeclaration ? "" : buildH3TimbreDeclaration(audioCount, speakers, text);
    const lock = lineCount < 0 || text.includes(H3_DIALOGUE_LOCK_MARK) ? "" : buildH3DialogueLock(lineCount, audioCount);
    if (!declaration && !lock) return text;
    const head = declaration ? `${declaration}\n\n` : "";
    if (!lock) return `${head}${text}`;
    return `${head}${text.replace(/\s*$/, "")}\n\n${lock}`;
}

/** 从作者自己写的 H3 提示词里捞出 `名字 (S1)` 形式的说话人，用来绑音色。 */
function extractH3Speakers(text: string) {
    const speakers: string[] = [];
    const pattern = /([^\s<>()：:，,。]{1,12})\s*\(S(\d+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
        const index = Number(match[2]) - 1;
        if (!Number.isFinite(index) || index < 0 || index > 8) continue;
        if (!speakers[index]) speakers[index] = match[1].trim();
    }
    return speakers;
}

/**
 * 把画布的 `- **对白**：名字：“台词”` 改写成 H3 的官方台词块。
 *
 * 输出形态（`audioCount` 决定要不要挂音色绑定）：
 * ```
 * <Audio 1> is the voice-timbre reference for 苏晚 (S1). It provides vocal tone and pacing only;
 * do not copy its original words.
 *
 * - **时长**：…
 * - **对白**：
 * 苏晚 (S1) says:
 * <d>[Chinese]你终于来了。</d>
 *
 * 【台词锁定】
 * 全片只有 1 句台词，只念这几句，不增不减；参考音轨只借音色，不重复、不续写、不翻译它里面的内容。
 * ```
 *
 * ⚠️ 幂等：已经带 `<d>` 的提示词**正文一个字不改**，但仍然补「音色声明 +（有音频时）台词锁定」。
 * ⚠️ **没有对白块、也没有音频时，一个字节都不改**：2026-10-25 用户反馈「越改越糟，不写对白也在
 *   乱说话」—— 追加的「台词/人声/对白」说明文字本身会被音视频模型当成内容。
 * ⚠️ 只在 H3 家族调用（见 `isMinimaxH3FamilyWorkflow`），别的模型一个字节不变。
 */
export function adaptMinimaxH3ReferencePrompt(
    prompt: string,
    options?: {
        audioCount?: number;
        dropSoundNote?: boolean;
        audioNegation?: boolean;
        keepStyleFields?: boolean;
    },
): string {
    // ⚠️ 空提示词不能原样交给 H3：它是**音视频联合生成**的模型，空提示词 + 参考图会让它自己编一段戏。
    // 先垫一句纯画面描述（不加任何「台词」相关的说明）。
    const text = String(prompt || "").trim() ? String(prompt) : H3_SILENT_FALLBACK_PROMPT;
    const audioCount = Math.max(0, Math.min(3, Math.round(Number(options?.audioCount) || 0)));
    /** Fisher 两个 id：这一镜没有 `<d>` 台词时，连我们自动追加的那句声音说明也不给（见 `stripH3SoundNote`）。 */
    const dropSoundNote = Boolean(options?.dropSoundNote);
    /**
     * **只给 Fisher 两个 id** 的一句否定式（`No dialogue, no voices.` / `non_diegetic_music: N/A`）。
     * 和 `dropSoundNote` 是两件事，故意分开传 —— 见 `withH3AudioStatement` 的注释。
     */
    const audioNegation = Boolean(options?.audioNegation);
    /**
     * **混合镜**：这段提示词里既有要念的台词，又有明说 `- **对白**：无` 的镜头。
     * 命中就贴「按镜头的口型约定」而不是「全片旁白」（`withH3MixedLipsyncNote`）。
     * 只看用户的**声明**（`- **对白**：无`），不看转换结果 —— 和 `isMinimaxH3FisherSilentShot` 分工。
     */
    const mixedShots = dropSoundNote && declaresH3SilentDialogue(text);

    /**
     * **干净模式**（= Fisher 两个 id）：只发「正文 + `<d>`」，**我们写的说明一句都不加**。
     *
     * 2026-10-25 第七次报障，用户两条原话：
     *  ①「这次更离谱，怎么把你配置的规范都读出来了，然后我写的对话提示词一个字都没念」；
     *  ②「没有挂参考音色，没有写对话提示词内容的，还是在自己瞎念内容」。
     * 第六轮加的东西 —— `integrated_multimodal_description:` 槽位头、`overall_soundscape: Quiet,
     * continuous … No dialogue, no voices. The description is never read aloud.`、
     * `non_diegetic_music: N/A`、`【静场】`／`【口型约定】`／`【台词锁定】` —— 全是**我们写的散文**。
     * H3 不解析槽位、不读指令，它把提示词整体当素材往下生成，于是**把我们这些说明当台词念了出来**
     * （用户听到的「规范」就是它们），真台词反而被淹掉。
     *
     * 这条路线（写满声音槽位 + 口头约束）连试三轮，用户反馈从「还是在乱说话」一路到「更离谱」，
     * 结论：**这套模型不吃说明文，只吃叙事 + `<d>`**。所以 Fisher 回到最小形态：
     *  - 保留：台词方言（`苏晚 (S1) says:` + `<d>[Chinese]…</d>`）、删除模板邀请句、剥离字段名；
     *  - 去掉：槽位头 / 英文说明 / 静场 / 口型约定 / 台词锁定；
     *  - 参考音频照旧挂（音色要靠它），但只留官方那**一句** `<Audio N> is the voice-timbre reference …`。
     * ⚠️ 别的族不受影响（调用点只对 Fisher 传 `audioNegation`）。
     */
    const minimal = audioNegation;
    /**
     * 音色声明 / 台词锁定的注入条数 = 已挂的参考音轨数。
     * （2026-10-26 之前这里有个 `cleanPrompt` 分支把独立模型归零，那条出口已整体撤掉：
     *  独立模型现在**不经过本函数**，提示词逐字原样提交。）
     */
    const voiceAudio = audioCount;

    /**
     * **提交风格字段**（Fisher 三个 id 的视频设置开关，默认关 = `false`）。
     *
     * `false`：`视觉风格 / 画面风格 / 影像风格 / 风格提示词 / 风格` 整行丢弃（标签和值都不发，
     * 见 `H3_SCAFFOLD_STYLE_LABELS`）—— 这是 2026-10-25 第八次报障的修法。
     * `true`：不丢整行，只丢字段名、把值发出去（走 `stripH3Scaffolding` 的兜底分支），
     * 让风格文字重新影响画面。用户要求保留这个口子做 A/B：**风险同时回来**（那段裸中文可能被念）。
     */
    const keepStyleFields = Boolean(options?.keepStyleFields);

    /**
     * 出口统一收口（顺序不能换）：
     *  1. **有台词**的出口先摘掉模板尾巴里「只要对白和环境音效」那半句（对白已有 `<d>` 定界）；
     *  2. 再剥分镜表字段骨架（`画面：`/`时长：`/`音效：` 这些标签会被 H3 当台词念出来）；
     *  3. 干净模式**不再套** `integrated_multimodal_description:` —— 那个头本身就会念，而且 H3 不解析它。
     * ⚠️ 2 只能作用于**正文**（`overall_soundscape:` 之前），别把用户自己写的槽位行当标签吃掉。
     * ⚠️ 静音镜那条路走的是 `dropDialogueInvitation`（改成「只要环境音效」），两者别混。
     */
    const finish = (value: string, speaking: boolean) => {
        // `minimal` = Fisher 干净模式（`audioNegation`）。独立模型 2026-10-26 已移出本函数，不走这里。
        if (!minimal) return value;
        const cut = value.search(/\n\s*overall_soundscape\s*:/i);
        const head = cut < 0 ? value : value.slice(0, cut);
        const tail = cut < 0 ? "" : value.slice(cut).replace(/^\n+/, "");
        // 干净模式：把我们自己那句模板尾巴（「不要出现字幕和文字，不要音乐…」）整行也去掉 ——
        // 它既是一句会被念出来的说明，又点了「字幕/文字/音乐」三个词（H3 顺着名词生成，越说越有）。
        const raw = minimal ? stripH3SoundNote(head) : head;
        const cleaned = stripH3Scaffolding(speaking ? stripDialogueInvitationClause(raw) : raw, { keepStyleFields });
        // 剥完什么都不剩（正文只有 `时长` / `对白：无` 这类字段）→ 干净模式垫那句中立画面描述，
        // **不要回落到 `head`**：回落等于把「时长/对白」这些标签又发给 H3，正是被念出来的那批词。
        const body = cleaned || (minimal ? H3_SILENT_FALLBACK_PROMPT : head.replace(/\s+$/, ""));
        // 干净模式不套描述槽位（header 本身会被念）；用户自己写的槽位（`tail`）原样留在原位。
        return tail ? `${body}\n\n${tail}` : body;
    };

    // 作者/用户自己写的 H3 台词标记 → 正文不动，只补音色声明（干净模式连台词锁定都不补）。
    if (/<\s*d\s*>/i.test(text)) {
        // 已带 `<d>` 又声明了静音镜 = 一镜说、一镜不说：正文不动，尾部补一句口型约定。
        const body = mixedShots && !minimal ? withH3MixedLipsyncNote(text) : text;
        const contract = withH3VoiceContract(body, voiceAudio, minimal ? -1 : countH3DialogueLines(text), extractH3Speakers(text));
        return finish(minimal ? contract : withH3AudioStatement(contract, audioNegation), true);
    }

    const lines = text.split("\n");
    const labelIndex = lines.findIndex((line) => H3_DIALOGUE_LABEL.test(line));
    if (labelIndex < 0) {
        // ⚠️ 没有对白块 → **什么都不加**。用户 2026-10-25：「你修复完还没最开始没修的时候好，
        // 现在不管写不写对白都在乱说话」—— 上一版在这里追加一大段「本条视频没有任何台词…」，
        // 反而把「台词/人声/对白/旁白」这些词喂给了音视频模型（它不听指令，只顺着词往下生成）。
        // 只做一件有实际作用的事：把第四套自动追加的「只要对白和环境音效」（旧版「只要台词…」）
        // 改成「只要环境音效」—— 那句本身就在邀请模型说话，是「没写台词也在说话」的直接来源。
        // `lineCount = 0` 只会在**真的挂了参考音频**时落成一行「本段没有台词」。
        const base = dropDialogueInvitation(text);
        // Fisher（静音镜）：没有 `<d>` → 撤掉我们自己那句模板声音说明。
        // ⚠️ 干净模式**连【静场】也不加** —— 那句正是被念出来的「规范」（第七次报障）。
        const quiet = dropSoundNote ? stripH3SoundNote(base) : base;
        const silentBody = dropSoundNote && !minimal ? withH3NarrationShotNote(quiet) : quiet;
        const contract = withH3VoiceContract(silentBody, voiceAudio, minimal ? -1 : 0, []);
        return finish(minimal ? contract : withH3AudioStatement(contract, audioNegation), false);
    }

    // ⚠️ 多镜合并（每 2/3/4/5 镜一段）的提示词里有**多个** `- **对白**：` 块，
    // 只转第一块会让其余镜的对白退回自然语言（模型当描述读 → 不念，或者自己编）。
    const speakers: string[] = [];
    const out: string[] = [];
    let lineCount = 0;
    let converted = false;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (!H3_DIALOGUE_LABEL.test(line)) {
            out.push(line);
            index += 1;
            continue;
        }
        const labelMatch = line.match(H3_DIALOGUE_LABEL)!;
        const collected = [labelMatch[2]];
        let cursor = index + 1;
        while (cursor < lines.length) {
            const next = lines[cursor];
            if (/^\s*-\s*\*\*/.test(next) || /^\s*#{1,6}\s/.test(next)) break;
            // 八行之后那块尾巴（`【禁止项】` / `【强制声明】` 四行；旧版是「不要出现字幕…」一句）
            // 不是台词，别把它补上人名 —— 判据统一走 `isStoryScriptDirectorSoundNoteLine`。
            if (isStoryScriptDirectorSoundNoteLine(next)) break;
            // ⚠️ 用户 2026-10-25：`- **对白**：` 的内容**只收录到 `视觉风格：` 之前** ——
            // 那一行是画面风格不是台词；同理任何新字段行、下一镜的镜号标题都是边界。
            if (H3_DIALOGUE_BOUNDARY.test(next)) break;
            collected.push(next);
            cursor += 1;
        }
        const tail: string[] = [];
        while (collected.length > 0 && !collected[collected.length - 1].trim()) tail.unshift(collected.pop() as string);

        const spoken = collected
            .join("\n")
            .split(/\n+/)
            .map((value) => value.trim())
            .filter((value) => value && !H3_DIALOGUE_SILENT.test(value));
        const blocks: string[] = [];
        // 认不出来的行**原样留在原位**，绝不被包进 `<d>`。
        const kept: string[] = [];
        for (const value of spoken) {
            const match = value.match(H3_DIALOGUE_SPEAKER);
            const quoted = /^[「『“"']/.test(value);
            const candidate = match ? match[1].trim() : "";
            // `张景惠说：打算…` → 说话人 `张景惠`（动词尾剥掉）；`他低声说：…` → 代词，交给下面的映射。
            const named = candidate.replace(H3_SPEAKER_VERB_TAIL, "").trim();
            // ⚠️ 只有两种行算台词：`说话人[说]：台词`（说话人还不能是分镜表字段名）、或整行带引号。
            // 其余（下一镜的字段、画面描述、声音要求）一律不动 —— 用户 2026-10-25 怀疑的
            // 「把我的提示词都当成对话台词」，就是这些行被误包进 `<d>` 造成的。
            const rawSpeaker = candidate && !H3_FIELD_LABEL.test(candidate) && named ? named : "";
            if (!rawSpeaker && !quoted) {
                kept.push(value);
                continue;
            }
            // 剥掉动词尾之后，正文从冒号后开始（`张景惠说：` 整段都是前缀）。
            const body = rawSpeaker ? value.slice(match![0].length).trim() : value.trim();
            // `苏晚：“台词”` → `<d>台词</d>`：`<d>` 本身就是台词的边界，引号留在里面会被一起念出来。
            // ⚠️ 先切内联字段（对白和 `视觉风格：`/`音效：` 挤在同一行时），再剥引号 ——
            // 顺序反了会把「风格」那半句留在 `<d>` 里（2026-10-25 第八次报障）。
            const spokenBody = cutH3InlineFieldLabel(body)
                .replace(/^[「『“"']+/, "")
                .replace(/[」』”"']+$/, "")
                .trim();
            if (!spokenBody) continue;
            const name = H3_PRONOUN_SPEAKER.test(rawSpeaker) ? speakers[0] || "" : rawSpeaker;
            if (name && !speakers.includes(name)) speakers.push(name);
            const speakerIndex = name ? speakers.indexOf(name) : 0;
            const speakerId = `S${speakerIndex + 1}`;
            const who = name ? `${name} (${speakerId})` : `(${speakerId})`;
            // ⚠️ 说话人标记里**不要塞 `<Audio N>` 标签**：官方写法是
            // `名字 (Sx) says:` + 独立一行 `<d>[语言]台词</d>`，音色归属写在提示词开头的声明里。
            // 早期版本写成 `says using the voice timbre referenced from <Audio 1>:` ——
            // 媒体标签和台词标记粘在同一行，模型容易把参考音频的内容一起带出来（「乱说话」）。
            blocks.push(`${who} says:`, `<d>[${h3DialogueLanguage(spokenBody)}]${spokenBody}</d>`);
        }
        if (!blocks.length) {
            // 默镜 / 只有 `无`：**原样保留**（不补人名、不生成空 <d>）。
            // ⚠️ 用户 2026-10-25 明确：静音镜的正常写法就是 `- **对白**：无`，
            // 这一行属于分镜表本身，不能被我们改写或删掉（曾试过整块删除，已回滚）。
            out.push(...lines.slice(index, cursor));
            index = cursor;
            continue;
        }
        out.push(`${labelMatch[1].replace(/\s*$/, "")}`, ...blocks, ...kept, ...tail);
        lineCount += blocks.length / 2;
        converted = true;
        index = cursor;
    }
    // 一个能认的台词都没有（全是 `无` / 全被守住）→ 有音频时只加一行「本段没有台词」，否则原样交出去。
     if (!converted) {
        const base = dropDialogueInvitation(text);
        // 同上：全段一个能认的台词都没有 → 静场（闭嘴 + 只有环境音），音轨照旧。
        // ⚠️ 干净模式不加【静场】（会被念出来，见 `minimal`）。
        const quiet = dropSoundNote ? stripH3SoundNote(base) : base;
        const silentBody = dropSoundNote && !minimal ? withH3NarrationShotNote(quiet) : quiet;
        const contract = withH3VoiceContract(silentBody, voiceAudio, minimal ? -1 : 0, speakers);
        return finish(minimal ? contract : withH3AudioStatement(contract, audioNegation), false);
    }
    // 至少一镜转成了 `<d>`：如果同时还有 `- **对白**：无` 的镜头，补「按镜头的口型约定」——
    // 否则那几镜没有任何约束，模型会把它们填成人声噪杂（用户 2026-10-25 的混合镜诉求）。
    // ⚠️ 干净模式下这句也不贴（第七次报障：它被念出来了）。
    const joined = out.join("\n");
    const finalBody = mixedShots && !minimal ? withH3MixedLipsyncNote(joined) : joined;
    const contract = withH3VoiceContract(finalBody, voiceAudio, minimal ? -1 : lineCount, speakers);
    return finish(minimal ? contract : withH3AudioStatement(contract, audioNegation), true);
}

/**
 * Work-Fisher（两个 id）这一镜**有没有要念的台词**。
 *
 * 没有 → 提交时**参考音频整条不提交**（`- **对白**：无` 那一行原样保留，不动用户的脚本）。
 * 用户 2026-10-25：「`- **对白**：无` 的情况还是会自己乱说话」+「静音镜正常是这样的，
 * `- **对白**：无`」—— 提示词本身是对的，问题在外部那条人声参考：H3 是音视频联合模型，
 * 给它一条人声参考等于递了一条「待续写的人声轨」，而这一镜本来没有台词。
 * 判断复用适配器（纯函数，`audioCount: 0` 时不追加任何契约），只认 `<d>`。
 */
export function isMinimaxH3FisherSilentShot(workflowId: string | null | undefined, prompt: string) {
    if (!isMinimaxH3FisherWorkflow(workflowId)) return false;
    return !/<\s*d\s*>/i.test(adaptMinimaxH3ReferencePrompt(prompt, { audioCount: 0 }));
}

/**
 * 分镜表里「这一镜没有台词」的**明确写法**：`- **对白**：无`（用户 2026-10-25：
 * 「静音镜正常是这样的，`- **对白**：无`」）。
 *
 * ⚠️ 只做判断，**绝不改写这一行**。故意比 `isMinimaxH3FisherSilentShot` 更严：
 * 那个只问「有没有 `<d>`」（台词没转成 `<d>` 也算静音），这个问「用户是不是明说了没有台词」。
 */
export function declaresH3SilentDialogue(prompt: string) {
    return /^[^\S\r\n]*[-*]?\s*\*\*对白\*\*\s*[：:]\s*(?:无|none|n\/a|（无）|\(无\)|—+|–|-)\s*[。.]?\s*$/im.test(String(prompt || ""));
}

/**
 * 所有 MiniMax H3 视频家族 —— 台词方言（`<d>[语言]` + `(S1) says:`）统一在这里收口。
 *
 * 只在 H3 上写方言：别的模型（Seedance / Kling / mj 等）吃自然语言，改了就是破坏。
 * 四视图那支是图像资产卡（不生成台词），故意不在名单里。
 * ⚠️ 独立模型 `2114341115852099586` **也不在名单里**（2026-10-26 用户要求把它移出方言层）：
 * 它要的是「提示词逐字原样喂进作者那张图」，不需要 `<d>` 转写、也吃不到任何剥骨架/撤尾巴。
 */
function isMinimaxH3FamilyWorkflow(workflowId?: string | null) {
    return (
        isMinimaxH3StoryWorkflow(workflowId) ||
        isMinimaxH3FiveSegmentWorkflow(workflowId) ||
        isMinimaxH3ReferenceClipWorkflow(workflowId) ||
        isMinimaxH3SelfLiftWorkflow(workflowId) ||
        isMinimaxH3RefTopWorkflow(workflowId) ||
        isMinimaxH3SingularityWorkflow(workflowId) ||
        isMinimaxH3HdDynamicWorkflow(workflowId) ||
        isMinimaxH3FisherWorkflow(workflowId) ||
        isMinimaxH3YzjinyuWorkflow(workflowId) ||
        // 【MINIMAX-H3】八月最强文戏 pair：作者示例提示词本身就是 `<Subject 1> (S1) says:` +
        // `<d>[Chinese]…</d>` 写法 —— 跟方言层吐出来的口径完全一致，所以它们进这张名单（为了
        // `<d>` 转写 / 补 `<Audio N>` 音色绑定），但走的是 `h3PromptForWorkflow` 的**最小形态**：
        // 不加【台词锁定】、不加 `overall_soundscape:`，也**不吃** Fisher 那套（干净模式以外的
        // 静音镜分流 / 撤尾巴 / 风格字段开关 / 0.8MP / 2–12s）。用户 2026-10-26 选定。
        isMinimaxH3WenxiWorkflow(workflowId)
    );
}

/**
 * Public gate: 这个 id 是否走 H3 全族的**台词方言层**（`<d>` / `(S1) says:` / 剥骨架 / 撤尾巴）。
 *
 * 2026-10-26 起独立模型 `2114341115852099586` **不再**在名单里（它要「提示词逐字原样」）。
 */
export function isMinimaxH3FamilyWorkflowId(workflowId?: string | null) {
    return isMinimaxH3FamilyWorkflow(workflowId);
}

/**
 * 提交前把用户提示词转成「这一族该用的口径」—— **唯一入口**（探针必须调这个，别自己抄一份配置）。
 *
 * 三档口径：
 *  - **不在 H3 名单**（含独立模型 `2114341115852099586`）：原文一个字不改；
 *  - **最小形态**（`audioNegation` = Fisher 两个 id + 文戏两个 id）：只留「正文 + `<d>` + 一句
 *    `<Audio N> is the voice-timbre reference …`」。不加【台词锁定】、不加 `overall_soundscape:`、
 *    不套描述槽位 —— 这些散文会被 H3 当稿子念出来（2026-10-25 第七次报障的定论）。
 *    2026-10-26 用户选定：「文戏这两个也走最小形态」。
 *  - **其余 H3 族**：全量说明文（音色声明 + 台词锁定 + `overall_soundscape:` 槽位）。
 *
 * ⚠️ `keepStyleFields`（提交视觉风格字段）：只有 Fisher 有面板开关（默认关）；文戏固定「只丢字段名、
 * 值照发」，不静默删掉用户写的风格；其余族不走 `finish` 的剥骨架分支，这一项无意义。
 */
export function h3PromptForWorkflow(
    workflowId: string | null | undefined,
    prompt: string,
    options?: { audioCount?: number; styleFields?: string },
): string {
    if (!isMinimaxH3FamilyWorkflow(workflowId)) return prompt;
    const fisher = isMinimaxH3FisherWorkflow(workflowId);
    return adaptMinimaxH3ReferencePrompt(prompt, {
        audioCount: options?.audioCount,
        // 静音镜连「只要环境音效」那句模板说明也不给 —— 只 Fisher（文戏没有静音镜分流）。
        dropSoundNote: fisher,
        // ⚠️ 参数名是历史包袱：它的实际作用是「干净模式 / 最小形态」（见函数内 `minimal`）。
        audioNegation: fisher || isMinimaxH3WenxiWorkflow(workflowId),
        // 「提交视觉风格字段」：Fisher 有面板开关（默认关，因为那段裸中文会被念）；文戏没有开关，
        // 固定**保留值、只丢字段名** —— 用户要的是「去掉散文」，不是「把视觉风格整行删掉」。
        keepStyleFields: fisher ? String(options?.styleFields || "") === "on" : isMinimaxH3WenxiWorkflow(workflowId),
    });
}

/** 日志用：这一族走哪一档口径。 */
export function h3PromptMode(workflowId?: string | null) {
    if (!isMinimaxH3FamilyWorkflow(workflowId)) return "verbatim";
    if (isMinimaxH3FisherWorkflow(workflowId)) return "fisher";
    if (isMinimaxH3WenxiWorkflow(workflowId)) return "minimal";
    return "plain";
}

/**
 * Reference video → `ref_videos.ref_video_N` slots (VHS_LoadVideo 27 on the 文武双全 graph).
 *
 * A clip is not interchangeable with an image the way images are with each other: the slot's
 * loader stays the node the sampler links into, and it reads a *filename inside the worker's input
 * dir* — exactly what `/task/openapi/upload` returns. The author shipped `video: ""`, and the
 * family adapter prunes that slot as invalid, so this MUST run before `buildWorkflowPatch` or a
 * supplied clip is silently dropped.
 *
 * Scoping is the caller's job (only graphs whose adapter understands the slot call this).
 */
export function applyRunningHubReferenceVideos(workflow: ComfyWorkflow, fileNames: string[]): { workflow: ComfyWorkflow; applied: number } {
    const names = (fileNames || [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
        .slice(0, 3);
    if (!names.length) return { workflow, applied: 0 };
    const next = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    let applied = 0;

    // Authored slot order (`ref_video_0`, `_1`, …) decides which upload lands where — never the
    // loader's node id, which in these exports is not even monotonic.
    for (const node of Object.values(next)) {
        const inputs = node?.inputs;
        if (!inputs) continue;
        const slots = Object.keys(inputs)
            .map((key) => ({ key, index: Number(/^ref_videos\.ref_video_(\d+)$/.exec(key)?.[1] ?? NaN) }))
            .filter((slot) => Number.isFinite(slot.index))
            .sort((a, b) => a.index - b.index);
        if (!slots.length) continue;
        slots.forEach((slot, position) => {
            const name = names[position];
            if (!name) return;
            const link = inputs[slot.key];
            const sourceId = Array.isArray(link) ? String(link[0]) : "";
            const loader = sourceId ? next[sourceId] : undefined;
            if (!loader || !isComfyVideoLoaderNode(loader)) return;
            writeComfyVideoName(loader, name);
            applied += 1;
        });
    }
    if (applied) return { workflow: next, applied };

    // Fallback: graphs that consume a clip through a plain loader (no `ref_videos.*` slot), in
    // document order — mirrors the audio fallback so a clip is never silently ignored.
    const loaders = Object.entries(next)
        .filter(([, node]) => isComfyVideoLoaderNode(node))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    loaders.slice(0, names.length).forEach(([, node], position) => {
        writeComfyVideoName(node, names[position]);
        applied += 1;
    });
    return { workflow: applied ? next : workflow, applied };
}

function isComfyVideoLoaderNode(node?: ComfyNode) {
    return /^(VHS_LoadVideo\w*|LoadVideo\w*)$/i.test(String(node?.class_type || ""));
}

function comfyVideoFieldName(node?: ComfyNode) {
    const inputs = node?.inputs || {};
    for (const field of ["video", "file", "video_path", "filename"]) {
        if (field in inputs) return field;
    }
    return "";
}

/** Write the uploaded filename; keep VHS's `videopreview` blob pointing at the same upload. */
function writeComfyVideoName(node: ComfyNode, name: string) {
    const inputs = node?.inputs;
    if (!inputs) return;
    const field = comfyVideoFieldName(node);
    if (field) inputs[field] = name;
    const preview = inputs.videopreview;
    if (typeof preview !== "string" || !preview.trim()) return;
    try {
        const parsed = JSON.parse(preview) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object") return;
        parsed.filename = name;
        if ("subfolder" in parsed) parsed.subfolder = "";
        if ("type" in parsed) parsed.type = "input";
        inputs.videopreview = JSON.stringify(parsed);
    } catch {
        // A non-JSON preview string is author data — leave it untouched.
    }
}

/** Container extension for the uploaded filename — RunningHub keys the file type off it. */
function audioFileExtension(source: string) {
    const mime = (/^data:([^;,]+)[;,]/.exec(source)?.[1] || "").toLowerCase();
    if (/mpeg|mp3/.test(mime)) return ".mp3";
    if (/wav/.test(mime)) return ".wav";
    if (/mp4|m4a|aac/.test(mime)) return ".m4a";
    if (/ogg|opus/.test(mime)) return ".ogg";
    if (/flac/.test(mime)) return ".flac";
    if (/webm/.test(mime)) return ".webm";
    return ".mp3";
}

/** Container extension for the uploaded clip — RunningHub keys the file type off it. */
function videoFileExtension(source: string) {
    const mime = (/^data:([^;,]+)[;,]/.exec(source)?.[1] || "").toLowerCase();
    if (/quicktime|mov/.test(mime)) return ".mov";
    if (/webm/.test(mime)) return ".webm";
    if (/matroska|mkv/.test(mime)) return ".mkv";
    if (/x-msvideo|avi/.test(mime)) return ".avi";
    if (/gif/.test(mime)) return ".gif";
    return ".mp4";
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

/**
 * Scalar overrides for everything the patch changed, in the `nodeInfoList` shape. Links and
 * non-scalars are skipped: the body field can only override a scalar input of an existing node.
 */
export function workflowNodeInfoList(before: ComfyWorkflow, after: ComfyWorkflow): RunningHubNodeInfo[] {
    const list: RunningHubNodeInfo[] = [];
    for (const [nodeId, node] of Object.entries(after)) {
        const pristine = before[nodeId]?.inputs || {};
        for (const [fieldName, value] of Object.entries(node.inputs || {})) {
            if (Array.isArray(pristine[fieldName]) || Array.isArray(value)) continue;
            if (pristine[fieldName] === value) continue;
            if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
            list.push({ nodeId, fieldName, fieldValue: String(value) });
        }
    }
    return list;
}

// Exported for the workflow-diagnostics path and tests: the transformation is the risky part, so it
// is exercised directly instead of only through a live task submission.
export function buildWorkflowPatch(workflow: ComfyWorkflow, prompt: string, imageValues: string[], size?: { width: number; height: number } | null, seconds?: string, aspect = "", rawSize = "", workflowId?: string, megapixels = "", mjFlavor = "", fisherLoraStrength = "", audioCount = 0): RunningHubWorkflowPatch {
    let patched = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
    // The 四视图 asset-card graph opts out of the generic writers entirely (see
    // applyMinimaxH3FourViewSettings for what each of them would break here). Its own adapter
    // produces the final graph, so the only remaining work is the scalar diff.
    if (isMinimaxH3FourViewWorkflow(workflowId)) {
        const fourView = applyMinimaxH3FourViewSettings(workflow, prompt, imageValues, size, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, fourView.workflow);
        return fourView.structuralRepair ? { nodeInfoList: list, graph: fourView.workflow } : { nodeInfoList: list };
    }
    // The 氛围感短视频 clip graph opts out for the same reason (see applyMinimaxH3VibeShortSettings):
    // the generic seconds writer cannot reach the Float (Duration) node, the aspect writer cannot
    // produce the ResolutionSelector's label enum, and the tier writer would force a megapixels
    // value this graph does not ask for.
    if (isMinimaxH3ReferenceClipWorkflow(workflowId)) {
        const vibe = applyMinimaxH3VibeShortSettings(workflow, prompt, imageValues, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, vibe.workflow);
        return vibe.structuralRepair ? { nodeInfoList: list, graph: vibe.workflow } : { nodeInfoList: list };
    }
    // The SelfLift 双采(简易版) clip graph opts out too (see applyMinimaxH3SelfLiftSettings): the
    // render scale lives on a ResolutionSelector the size writer cannot reach and the tier writer
    // would clamp, while the duration sits on a Float (Duration) primitive behind a math link and
    // the run seed on `SelfLiftH3Sampler` — a class name no shared randomizer matches.
    // Always ship `graph`: the shared workflow often denies getJsonApiFormat ("无权限访问该工作流"),
    // and the model script's Export (API) JSON is the only runnable copy — nodeInfoList alone cannot
    // stand in for a template the key cannot open.
    if (isMinimaxH3SelfLiftWorkflow(workflowId)) {
        const selfLift = applyMinimaxH3SelfLiftSettings(workflow, prompt, imageValues, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, selfLift.workflow);
        return { nodeInfoList: list, graph: selfLift.workflow };
    }
    // H3 Ref 顶级多参 opts out (see applyMinimaxH3RefTopSettings): ref slot goes through
    // ImageResizeKJv2, user text feeds QwenH3PromptLocal (220), and duration/size sit behind links
    // the generic writers miss. Always ship `graph` for the local Export (API) JSON path.
    if (isMinimaxH3RefTopWorkflow(workflowId)) {
        const refTop = applyMinimaxH3RefTopSettings(workflow, prompt, imageValues, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, refTop.workflow);
        return { nodeInfoList: list, graph: refTop.workflow };
    }
    // Singularity 双采放大 opts out (see applyMinimaxH3SingularitySettings): prompt is a Text node,
    // draft ResolutionSelector must be divided by LatentUpscaler3D scale², and empty media slots
    // must be pruned. Always ship `graph` for the local Export (API) JSON path.
    if (isMinimaxH3SingularityWorkflow(workflowId)) {
        const singularity = applyMinimaxH3SingularitySettings(workflow, prompt, imageValues, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, singularity.workflow);
        return { nodeInfoList: list, graph: singularity.workflow };
    }
    // H3 高速大动态 / 无劣化 opts out (see applyMinimaxH3HdDynamicSettings): delivered
    // ResolutionSelector + Float duration behind math, baked hash refs. Always ship `graph`.
    if (isMinimaxH3HdDynamicWorkflow(workflowId)) {
        const hd = applyMinimaxH3HdDynamicSettings(workflow, prompt, imageValues, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, hd.workflow);
        return { nodeInfoList: list, graph: hd.workflow };
    }
    // Work-Fisher 全流程 opts out (see applyMinimaxH3FisherSettings): multi-ref H3 + Duration
    // Float + ResolutionSelector; baked hash refs. Always ship `graph`.
    if (isMinimaxH3FisherWorkflow(workflowId)) {
        const fisher = applyMinimaxH3FisherSettings(workflow, prompt, imageValues, seconds, aspect, megapixels, fisherLoraStrength);
        const list = workflowNodeInfoList(workflow, fisher.workflow);
        return { nodeInfoList: list, graph: fisher.workflow };
    }
    // YZ金鱼 文武双全 opts out (see applyMinimaxH3YzjinyuSettings): Text prompt node, self-lifting
    // sampler behind a two-LoRA stack, duration on a Float the seconds writer misses, and six baked /
    // "None" reference slots that must be unlinked. Always ship `graph` for the local Export path.
    if (isMinimaxH3YzjinyuWorkflow(workflowId)) {
        const yzjinyu = applyMinimaxH3YzjinyuSettings(workflow, prompt, imageValues, seconds, aspect, megapixels);
        const list = workflowNodeInfoList(workflow, yzjinyu.workflow);
        return { nodeInfoList: list, graph: yzjinyu.workflow };
    }
    // 【MINIMAX-H3】八月最强文戏 低配 / 高配 opts out (see applyMinimaxH3WenxiSettings): prompt lives
    // on `CR Prompt Text` (field `prompt`), refs sit behind a scaler chain, duration is a Float behind
    // the 17n+5 math link, the selector wants a label enum + a *draft* megapixels, and the author ships
    // baked demo portraits / voices plus two video sinks. `audioCount` tells the adapter whether the
    // canvas actually brought timbre references (0 → the author's demo mp3s are unlinked and pruned).
    if (isMinimaxH3WenxiWorkflow(workflowId)) {
        const wenxi = applyMinimaxH3WenxiSettings(
            workflow,
            prompt,
            imageValues,
            seconds,
            aspect,
            megapixels,
            fisherLoraStrength,
            audioCount,
            isMinimaxH3WenxiLowWorkflow(workflowId),
        );
        const list = workflowNodeInfoList(workflow, wenxi.workflow);
        return { nodeInfoList: list, graph: wenxi.workflow };
    }
    // Qwen+Klein 皮肤肌理 T2I opts out for the same class of reasons (see applyQwenKleinSkinSettings):
    // the generic prompt scorer would overwrite the negative and Klein enhance CLIP slots, the size
    // writer cannot produce ResolutionSelector labels, and the tier writer would clamp the refine
    // node's 4MP. Always ship `graph` so a denied getJsonApiFormat can still run via model script.
    if (isQwenKleinSkinWorkflow(workflowId)) {
        const klein = applyQwenKleinSkinSettings(workflow, prompt, size, aspect, rawSize, megapixels);
        const list = workflowNodeInfoList(workflow, klein.workflow);
        return { nodeInfoList: list, graph: klein.workflow };
    }
    // Krea2 田园 MJ opts out (see applyKrea2PastoralMjSettings): size lives on TTResolutionSelector
    // custom_width/height the generic size writer never reaches. Always ship `graph` for local Export.
    if (isKrea2PastoralMjWorkflow(workflowId)) {
        const pastoral = applyKrea2PastoralMjSettings(workflow, prompt, size);
        const list = workflowNodeInfoList(workflow, pastoral.workflow);
        return { nodeInfoList: list, graph: pastoral.workflow };
    }
    // Aiden KREA2 LoRA + prompt-optimize opts out (see applyKrea2AidenLoraSettings): generic prompt
    // writer clobbers llama expander templates; size/tier writers miss ResolutionSelector and would
    // smash the SeedVR downscale megapixels. Always ship `graph` for local Export.
    if (isKrea2AidenLoraWorkflow(workflowId)) {
        const aiden = applyKrea2AidenLoraSettings(workflow, prompt, size, aspect, rawSize, megapixels);
        const list = workflowNodeInfoList(workflow, aiden.workflow);
        return { nodeInfoList: list, graph: aiden.workflow };
    }
    // 全能生图王 moss_image T2I opts out (see applyWorkFisherMossSettings): the user prompt lands on
    // a primitive behind the LLM expander (the positive CLIP is a link), the selector wants a label
    // enum, the delivered long side is the SeedVR2 INT constant, and the graph has four sinks.
    // Always ship `graph` so a denied getJsonApiFormat can still run via the model script.
    if (isWorkFisherMossWorkflow(workflowId)) {
        const workfisher = applyWorkFisherMossSettings(workflow, prompt, imageValues, size, aspect, rawSize, megapixels);
        const list = workflowNodeInfoList(workflow, workfisher.workflow);
        return { nodeInfoList: list, graph: workfisher.workflow };
    }
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
    // Runs after the generic prompt writer so the scoped prompt slot wins over it. A run with no
    // reference also gets a graph repair (see applyQwenImage21UnifiedSettings) that unlinks the
    // author's demo portrait — hence `graph` below for that case.
    if (isQwenImage21UnifiedWorkflow(workflowId)) {
        const unified = applyQwenImage21UnifiedSettings(patched, workflow, prompt, size, aspect, imageValues);
        patched = unified.workflow;
        if (unified.structuralRepair) structuralRepair = true;
    }
    // Runs after the generic size/tier writers: the selector's label enum and the WYSIWYG
    // megapixels are both things those writers cannot deliver (see applyKrea2MjStyleSettings).
    if (isKrea2MjStyleWorkflow(workflowId)) {
        patched = applyKrea2MjStyleSettings(patched, prompt, size, aspect, rawSize, megapixels, mjFlavor).workflow;
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
    const list = workflowNodeInfoList(workflow, patched);
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
    // 独立模型（`2114341115852099586`）：第三方 app 的发布图普遍拒绝 `getJsonApiFormat`，唯一的可跑副本
    // 就是模型脚本里贴进来的 Export。`nodeInfoList` 只能改字段、不能替代模板，所以必须**整图提交**。
    // ⚠️ 这不是 Fisher 补丁：它不改提示词、不改分辨率 / 时长 / LoRA，只是把「用户自己贴的那张图」送上去。
    if (isStandaloneH3ExportWorkflow(workflowId)) return { nodeInfoList: list, graph: patched };
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

// Vercel serverless /api/proxy caps request bodies at ~4.5MB, so an oversized reference
// (e.g. a full-screen clipboard screenshot PNG) fails the multipart upload with HTTP 413
// before RunningHub ever sees it. Mirrors the comfyui-native upload guard: only images
// already within budget stay byte-identical; oversized ones are downscaled/re-encoded.
const RUNNINGHUB_UPLOAD_BYTE_BUDGET = 2_400_000;
const RUNNINGHUB_UPLOAD_MAX_EDGE = 1536;
/** Singularity multi-ref: tighter per-image budget so Pages proxy fallback (if any) stays under CF limits. */
const SINGULARITY_UPLOAD_BYTE_BUDGET = 650_000;
const SINGULARITY_UPLOAD_MAX_EDGE = 1280;

async function shrinkOversizedReferenceDataUrl(dataUrl: string, maxBytes = RUNNINGHUB_UPLOAD_BYTE_BUDGET, maxEdge = RUNNINGHUB_UPLOAD_MAX_EDGE) {
    if (getDataUrlByteSize(dataUrl) <= maxBytes) return dataUrl;
    try {
        const compressed = await compressReferenceDataUrl(dataUrl, 1, { maxEdge, maxBytes });
        return compressed.startsWith("data:") && getDataUrlByteSize(compressed) < getDataUrlByteSize(dataUrl) ? compressed : dataUrl;
    } catch {
        return dataUrl;
    }
}

/**
 * Singularity (and optionally others): prefer browser-direct to RunningHub.
 * Cloudflare Pages `/api/proxy` often closes large multipart / full-graph POSTs to
 * `www.runninghub.ai` with `net::ERR_CONNECTION_CLOSED`; `.cn` already bypasses the proxy via
 * DIRECT_CORS_HOSTS. Direct-first, then one proxy fallback on transport failures only.
 */
async function postRunningHubWithFallback(
    origin: string,
    path: string,
    data: unknown,
    options: {
        headers?: Record<string, string>;
        signal?: AbortSignal;
        timeout?: number;
        preferDirect?: boolean;
        /** Fired once when direct transport fails and the proxy attempt is about to start. */
        onDirectTransportFallback?: () => void;
    },
) {
    const direct = `${String(origin || "").replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
    const proxied = proxyApiUrl(direct);
    const urls = options.preferDirect ? Array.from(new Set([direct, proxied])) : [proxied];
    let lastError: unknown;
    for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index];
        try {
            return await axios.post(url, data, {
                headers: options.headers,
                signal: options.signal,
                timeout: options.timeout,
            });
        } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            // Auth / validation from RH — do not hop transports.
            if (axios.isAxiosError(error) && error.response && error.response.status >= 400 && error.response.status < 500) throw error;
            if (index >= urls.length - 1) break;
            const viaProxy = url.includes("/api/proxy") || url.includes("/api-proxy");
            if (!viaProxy) options.onDirectTransportFallback?.();
            console.warn(
                `[runninghub] ${path} via ${viaProxy ? "proxy" : "direct"} failed; retrying alternate transport`,
            );
        }
    }
    throw lastError;
}

async function uploadImage(
    origin: string,
    apiKey: string,
    source: string,
    fileName: string,
    signal?: AbortSignal,
    options?: {
        preferDirect?: boolean;
        maxBytes?: number;
        maxEdge?: number;
        onDirectTransportFallback?: () => void;
    },
) {
    return uploadBinary(origin, apiKey, source, fileName, signal, { ...options, shrink: true, fallbackType: "image/png" });
}

/**
 * Audio references are uploaded byte-for-byte. `shrinkOversizedReferenceDataUrl` decodes the payload
 * through an `<img>`, so running an mp3 through it yields a broken file (or a 0-byte blob) and
 * RunningHub then loads nothing — the task still succeeds with the model's own voice.
 */
async function uploadAudioFile(origin: string, apiKey: string, source: string, fileName: string, signal?: AbortSignal, preferDirect = false) {
    // A 30s 48k stereo WAV is already ~10MB, so an audio ref is not automatically "small": the same
    // oversized-multipart path that broke clip uploads applies. Both upload hosts answer with
    // `Access-Control-Allow-Origin: *`, so the direct hop is viable and the (buffered) proxy stays
    // the fallback.
    return uploadBinary(origin, apiKey, source, fileName, signal, { shrink: false, fallbackType: "audio/mpeg", preferDirect });
}

/**
 * Reference clips go up byte-for-byte for the same reason audio does: `shrinkOversizedReferenceDataUrl`
 * decodes through an `<img>`, which turns a clip into a corrupt payload. Direct-first matters here
 * because a clip is far bigger than any image, and the Pages proxy used to choke on large multipart
 * bodies (`net::ERR_HTTP2_PROTOCOL_ERROR` on `/api/proxy?target=…/upload`).
 *
 * Two guards make a failure diagnosable instead of a bare network error:
 *   - a clip over the ceiling is refused up front with its real size (a reference clip never needs
 *     to be that big, and an oversized body dies inside the edge before any status comes back).
 *     The value tracks the edge proxy's buffered ceiling (`UPLOAD_BUFFER_MAX` in
 *     `functions/_lib/proxy.js`, 40MB) minus header/encoding slack: refusing a clip the proxy could
 *     actually relay would be a self-inflicted regression;
 *   - a failed upload names the file and the transport that failed.
 */
const RUNNINGHUB_VIDEO_UPLOAD_MAX_BYTES = 36_000_000;

async function uploadVideoFile(origin: string, apiKey: string, source: string, fileName: string, signal?: AbortSignal) {
    const bytes = source.startsWith("data:") ? getDataUrlByteSize(source) : 0;
    if (bytes > RUNNINGHUB_VIDEO_UPLOAD_MAX_BYTES) {
        throw new Error(apiText("referenceVideoTooLarge", { size: Math.round((bytes / 1_000_000) * 10) / 10, limit: RUNNINGHUB_VIDEO_UPLOAD_MAX_BYTES / 1_000_000 }));
    }
    try {
        return await uploadBinary(origin, apiKey, source, fileName, signal, { shrink: false, fallbackType: "video/mp4", preferDirect: true });
    } catch (error) {
        throw new Error(apiText("referenceVideoUploadFailed", { name: fileName, detail: errorText(error).slice(0, 180) }));
    }
}

async function uploadBinary(
    origin: string,
    apiKey: string,
    source: string,
    fileName: string,
    signal?: AbortSignal,
    options?: {
        preferDirect?: boolean;
        maxBytes?: number;
        maxEdge?: number;
        onDirectTransportFallback?: () => void;
        shrink?: boolean;
        fallbackType?: string;
    },
) {
    let file: File;
    if (source.startsWith("data:")) {
        const payload = options?.shrink ? await shrinkOversizedReferenceDataUrl(source, options?.maxBytes, options?.maxEdge) : source;
        file = dataUrlToFile({ id: fileName, name: fileName, dataUrl: payload, type: options?.fallbackType || "image/png" });
    } else if (/^https?:\/\//i.test(source)) {
        return source;
    } else {
        throw new Error(apiText(options?.shrink === false ? "referenceAudioReadFailed" : "referenceImageReadFailed"));
    }
    const body = new FormData();
    body.append("apiKey", apiKey.replace(/^Bearer\s+/i, "").trim());
    body.append("fileType", "input");
    body.append("file", file);
    const response = await postRunningHubWithFallback(origin, "/task/openapi/upload", body, {
        signal,
        timeout: 120_000,
        preferDirect: options?.preferDirect,
        onDirectTransportFallback: options?.onDirectTransportFallback,
    });
    assertOk(response.data, apiText("requestFailed"));
    const data = asRecord(asRecord(response.data)?.data) || asRecord(response.data);
    const name = data?.fileName || data?.filename;
    if (typeof name !== "string" || !name) throw new Error(readMessage(response.data) || apiText("requestFailed"));
    return name;
}

async function submitWorkflowTask(
    origin: string,
    apiKey: string,
    workflowId: string,
    nodeInfoList: RunningHubNodeInfo[],
    graph?: ComfyWorkflow,
    signal?: AbortSignal,
    preferDirect = false,
) {
    const token = apiKey.replace(/^Bearer\s+/i, "").trim();
    const body: Record<string, unknown> = { apiKey: token, workflowId, addMetadata: true };
    if (nodeInfoList.length) body.nodeInfoList = nodeInfoList;
    // `workflow` runs the graph we send instead of the one saved under workflowId. It is the only way
    // to add a link (nodeInfoList overrides scalar inputs only), which is what a reference image
    // needs in order to reach the sampler. workflowId stays in the body, so a backend that ignores
    // the field simply falls back to the previous behaviour rather than failing.
    if (graph) body.workflow = JSON.stringify(graph);
    const response = await postRunningHubWithFallback(origin, "/task/openapi/create", body, {
        headers: bearer(apiKey),
        signal,
        timeout: 60_000,
        preferDirect,
    });
    assertOk(response.data, apiText("runningHubNoTaskId"));
    const problem = readPromptProblems(response.data);
    if (problem) throw new Error(problem);
    const created = readTaskFromCreate(response.data);
    if (!created?.taskId) throw new Error(readMessage(response.data) || apiText("runningHubNoTaskId"));
    return created;
}

/**
 * SelfLift-only escape hatch: `/task/openapi/comfy/run` accepts a full API graph without opening
 * the shared workflowId the caller's key has no permission to fetch. Scoped to graphs we already
 * decided to submit (never used as a generic create replacement).
 */
async function submitComfyRunTask(origin: string, apiKey: string, graph: ComfyWorkflow, signal?: AbortSignal) {
    const token = apiKey.replace(/^Bearer\s+/i, "").trim();
    const response = await axios.post(
        proxyApiUrl(`${origin}/task/openapi/comfy/run`),
        { apiKey: token, workflow: JSON.stringify(graph), addMetadata: true },
        { headers: bearer(apiKey), signal, timeout: 60_000 },
    );
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
                if (completedRounds > 10) {
                    throw new Error(`${apiText("runningHubNoImage")} (taskId: ${args.taskId})`);
                }
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
            // SUCCESS / code 0 with an empty file list used to spin until the 20-minute timeout.
            const statusInfo = await fetchTaskStatus({ origin: args.origin, token, taskId: args.taskId, apiKey: args.apiKey, signal: args.signal }).catch(() => null);
            if (statusInfo && statusInfo.status && isDoneStatus(statusInfo.status)) {
                completedRounds += 1;
                if (completedRounds > 6) {
                    throw new Error(`${apiText("runningHubNoImage")} (taskId: ${args.taskId})`);
                }
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
    /** MJ 风格 V2.0 LoRA 味型 (`strong` | `standard` | `light` | `off`) — that pair only. */
    mjFlavor?: string;
    /** Work-Fisher 风格 LoRA（279 `MysticXXX_MMH3-V1`）权重：`0` = 关（默认），0.2/0.35/0.5 为档位。 */
    fisherLoraStrength?: string;
    /** Work-Fisher 是否把 `视觉风格：…` 那一行的值提交给模型：`on` = 提交（只丢字段名），其余 = 整行不发。 */
    fisherStyleFields?: string;
    /** Work-Fisher pipeline mode (video / character / scene / multiview). */
    fisherMode?: string;
    media?: "image" | "video";
    referenceDataUrls?: string[];
    /** Audio references (data: URLs) → uploaded, then written into `ref_audios.ref_audio_*`. */
    referenceAudioDataUrls?: string[];
    /** Video reference (data: URL) → uploaded, then written into `ref_videos.ref_video_*`. */
    referenceVideoDataUrls?: string[];
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
    // function. A key the platform refuses (drained balance, dead key, no workflow access) then
    // falls through to the next one in the same shuffled order.
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

    const canTryNextKey = (error: unknown) => isRunningHubKeyFailoverMessage(errorText(error));

    let lastError: unknown = null;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        const apiKey = keys[keyIndex];
        try {
            return await runRunningHubWorkflowWithKey({ origin, workflowId, apiKey, args, isLastKey: keyIndex === keys.length - 1 });
        } catch (error) {
            // Cancellation must propagate immediately — never switch keys on a user abort.
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            lastError = error;
            // A key-level rejection (balance / auth / no workflow access) moves on to the next key.
            // Anything else (bad graph, unknown server error, transport failure) is surfaced as-is:
            // retrying it with every key would only multiply the wait.
            if (!canTryNextKey(error)) throw explainRunningHubError(error, workflowId);
            // Fall through to the next key; when the last key is refused too, surface that last error.
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
        /** MJ 风格 V2.0 LoRA 味型 (`strong` | `standard` | `light` | `off`) — that pair only. */
        mjFlavor?: string;
        /** Work-Fisher 风格 LoRA（279）权重，`0` = 关（默认）。 */
        fisherLoraStrength?: string;
        /** Work-Fisher 是否提交 `视觉风格：…` 的值：`on` = 提交，其余 = 整行不发（默认）。 */
        fisherStyleFields?: string;
        fisherMode?: string;
        media?: "image" | "video";
        referenceDataUrls?: string[];
        referenceAudioDataUrls?: string[];
        referenceVideoDataUrls?: string[];
        signal?: AbortSignal;
    };
}): Promise<RunningHubMedia> {
    const { origin, workflowId, apiKey, isLastKey } = args;
    const request = args.args;
    const fisherMode = normalizeFisherPipelineMode(request.fisherMode);
    // SelfLift 双采(简易版) / Qwen+Klein 皮肤肌理: the shared workflowId often returns
    // "您暂时无权限访问该工作流". Prefer the Export (API) JSON pasted into the model script so
    // create can run via `workflow` / comfy/run without opening the author's copy. Every other
    // workflow keeps the remote getJsonApiFormat path unchanged.
    const localExportGraph = !usesRunningHubLocalExportGraph(workflowId)
        ? null
        : isMinimaxH3FisherWorkflow(workflowId)
          ? // 模型脚本（用户覆盖层）优先；没有脚本时只有 .ai 那份 id 有内置图兜底，
            // 另外两个 Fisher id 照旧返回 null → 走下面的「把 Export 贴进脚本」报错，行为不变。
            // ⚠️ 内置图只有「多参生视频」那一张：角色 / 场景 / 多视角模式没有内置图，
            // 必须继续走「脚本里缺该模式 Export」的报错 —— 拿视频图冒充错管线等于白烧一次渲染。
            resolveFisherWorkflowFromScript(request.script, fisherMode) || (fisherMode === "video" ? bundledRunningHubGraph(workflowId) : null)
          : parseComfyApiWorkflow(request.script) || bundledRunningHubGraph(workflowId);
    let workflow = localExportGraph;
    let fetchPermissionDenied = false;
    if (!workflow) {
        // Fisher non-video modes need a mode bag in the script — do not silently fall back to the
        // remote video template and render the wrong pipeline.
        if (isMinimaxH3FisherWorkflow(workflowId) && fisherMode !== "video" && String(request.script || "").trim()) {
            throw new Error(i18n.t("apiErrors.runningHubH3FisherModeScriptRequired", { id: workflowId, mode: fisherMode }));
        }
        workflow = await fetchWorkflow(origin, apiKey, workflowId, request.signal).catch((error: unknown) => {
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            const message = errorText(error);
            // A dead key is the outer loop's business: rethrow untouched so it can see the marker
            // (APIKEY_UNAUTHORIZED / TOKEN_INVALID …) and fail over to the next account. Wrapping it
            // in an explained error here is what used to make a bad key look like a dead end.
            if (isAuthMessage(message)) throw error;
            if (isWorkflowPermissionMessage(message) && usesRunningHubLocalExportGraph(workflowId)) {
                fetchPermissionDenied = true;
                return null;
            }
            return null;
        });
    }
    if (!workflow && fetchPermissionDenied && isMinimaxH3SelfLiftWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubSelfLiftScriptRequired", { id: workflowId }));
    }
    if (!workflow && fetchPermissionDenied && isQwenKleinSkinWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubKleinSkinScriptRequired", { id: workflowId }));
    }
    if (!workflow && fetchPermissionDenied && isMinimaxH3RefTopWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubH3RefTopScriptRequired", { id: workflowId }));
    }
    if (!workflow && fetchPermissionDenied && isKrea2PastoralMjWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubKrea2PastoralMjScriptRequired", { id: workflowId }));
    }
    // Aiden KREA2 always needs the Export (API) JSON in the model script — remote getJsonApiFormat
    // is commonly ACL-denied, and falling through to webapp/nodeInfo would clobber llama templates.
    if (!workflow && isKrea2AidenLoraWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubKrea2AidenLoraScriptRequired", { id: workflowId }));
    }
    // Singularity / HD Dynamic / Fisher: local Export JSON required when remote ACL denies.
    if (!workflow && isMinimaxH3SingularityWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubH3SingularityScriptRequired", { id: workflowId }));
    }
    if (!workflow && isMinimaxH3HdDynamicWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubH3HdDynamicScriptRequired", { id: workflowId }));
    }
    if (!workflow && isMinimaxH3FisherWorkflow(workflowId)) {
        throw new Error(
            fisherMode === "video"
                ? i18n.t("apiErrors.runningHubH3FisherScriptRequired", { id: workflowId })
                : i18n.t("apiErrors.runningHubH3FisherModeScriptRequired", { id: workflowId, mode: fisherMode }),
        );
    }
    // YZ金鱼 文武双全: same ACL story — the shared id commonly denies getJsonApiFormat.
    if (!workflow && isMinimaxH3YzjinyuWorkflow(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubH3YzjinyuScriptRequired", { id: workflowId }));
    }
    // 通用兜底（各族专属文案在上面）：支持「脚本贴 Export」的 id 在 ACL 拒绝 + 没有脚本时，
    // 必须明确告诉用户去贴 Export，而不是让 `WORKFLOW_NOT_EXISTS` 糊过去。
    // 独立模型 `2114341115852099586` 走的就是这一条（它不再有内置图，也不再是 Fisher）。
    if (!workflow && fetchPermissionDenied && usesRunningHubLocalExportGraph(workflowId)) {
        throw new Error(i18n.t("apiErrors.runningHubExportScriptRequired", { id: workflowId }));
    }
    const preferDirectSubmit = prefersRunningHubDirectSubmit(workflowId);
    const refs = (request.referenceDataUrls || []).filter(Boolean).slice(0, 8);
    const uploaded: string[] = [];
    // Sticky transport: after the first .ai direct upload hits HTTP2/connection errors, keep the
    // remaining refs on the Pages proxy so we do not repeat the same failed hop 3–7 more times.
    let preferDirectUpload = preferDirectSubmit && refs.length > 0;
    const multiRefUploadLimits = preferDirectSubmit && refs.length
        ? {
              maxBytes: Math.min(SINGULARITY_UPLOAD_BYTE_BUDGET, Math.floor(2_000_000 / Math.max(1, refs.length))),
              maxEdge: SINGULARITY_UPLOAD_MAX_EDGE,
          }
        : undefined;
    for (let index = 0; index < refs.length; index += 1) {
        uploaded.push(
            await uploadImage(origin, apiKey, refs[index], `ref-${index + 1}.png`, request.signal, {
                ...multiRefUploadLimits,
                preferDirect: preferDirectUpload,
                onDirectTransportFallback: () => {
                    preferDirectUpload = false;
                },
            }),
        );
    }
    const pixels = resolveCanvasPixels(request.size || "", request.media || "image");
    const aspect = canvasAspect(request.size || "");
    // Audio references: upload first, then write them into the graph *before* the per-workflow
    // patch. Singularity's patch deletes `LoadAudio("None")` slots as invalid; filling them first is
    // what keeps the slot, and the author's node ids, alive.
    // ⚠️ 用户 2026-10-25（只针对 Fisher 两个 id）：`- **对白**：无` 的镜头**连参考音频都不挂**。
    // 挂了音色参考 = 给它一条「待续写的人声轨」，H3 是音视频联合模型，会顺着音频把人声续出来 ——
    // 这一镜本来就没台词，音色参考没有任何用处，却正好是「自己乱说话」的燃料。
    // ⚠️ 提示词里那行 `- **对白**：无` **保持原样**（用户 2026-10-25：「静音镜正常是这样的」），
    // 曾经试过整块删掉，已回滚 —— 分镜表的写法不归我们改。
    // ⚠️ 光「不挂参考音频」还不够：用户随后仍报「还是在说韩文」，日志证明提示词干净（audio=0、
    // noDialogue=1）。根因在作者焊死的韩语味风格 LoRA，文本压不住。
    // ⚠️ 2026-10-25 第二次返工：`e86f9dd` 曾经在无 `<d>` 的正文末尾追加
    // `【旁白镜】…声音是画外旁白与环境音` —— 那是**正向下单一条旁白**，LoRA 归零后韩语没了，
    // 剩下的就是这条中文旁白 + 为它烧进画面的字幕（「这次不是乱说韩语了，是乱说中文」）。
    // 现在改成 `【静场】人物全程闭口…本镜只有环境音`（`withH3NarrationShotNote`），
    // 提示词里不再出现「旁白/画外音/人声/字幕/文字」任何一个词。
    // 所以这里既**不摘音轨**（`84f8517` 摘过，已撤回）。
    // ⚠️ 风格 LoRA 例外（2026-10-25 第三次报障后改的）：那支 LoRA 自带韩语/硬字幕/自编台词，
    // 现在归到 `videoFisherLoraStrength` 档位、默认 0 = 关（见 `applyMinimaxH3FisherSettings`）。
    const fisherDialogueFree = isMinimaxH3FisherSilentShot(workflowId, request.prompt);
    // 混合镜（有台词 + 有 `- **对白**：无`）：贴的是「口型约定」而非「全片静场」，日志要能分开看，
    // 否则排查时会把「该念的没念」误判成静场规则串了。
    const fisherMixedShots = isMinimaxH3FisherWorkflow(workflowId) && !fisherDialogueFree && declaresH3SilentDialogue(request.prompt);
    // 「韩语还没走」的第一条排查线索：实际提交的风格 LoRA 权重。用户报障时复制这一行就够。
    if (isMinimaxH3FisherWorkflow(workflowId)) {
        console.info(
            `[runninghub] ${workflowId}: fisherLoRA=${normalizeFisherLoraStrength(request.fisherLoraStrength)} (0 = off, Korean voice / burned subtitles / invented lines come from this LoRA)`,
        );
    }
    const audioSources = fisherDialogueFree ? [] : (request.referenceAudioDataUrls || []).filter(Boolean).slice(0, 3);
    // 文武双全 only: its clips are big *and* it uploads audio/video through the same endpoint, so let
    // the browser reach RunningHub first and keep the edge out of the byte path. Other families keep
    // the previous proxy-only behaviour (no behaviour change for them).
    const yzjinyuRefs = isMinimaxH3YzjinyuWorkflow(workflowId);
    // 【MINIMAX-H3】八月最强文戏 pair：同样「大图 + 音色」一起上传，音轨也走浏览器直传。
    const wenxiRefs = isMinimaxH3WenxiWorkflow(workflowId);
    const uploadedAudios: string[] = [];
    for (let index = 0; index < audioSources.length; index += 1) {
        uploadedAudios.push(await uploadAudioFile(origin, apiKey, audioSources[index], `ref-audio-${index + 1}${audioFileExtension(audioSources[index])}`, request.signal, yzjinyuRefs || wenxiRefs));
    }
    const audioPatch = workflow && uploadedAudios.length ? applyRunningHubReferenceAudios(workflow, uploadedAudios) : null;
    // Silence is the bug we are fixing: audio that cannot be placed must fail loudly instead of
    // billing a render that ignores it (also covers the webapp/nodeInfo path, which has no graph).
    if (audioSources.length && !audioPatch?.applied) throw new Error(apiText("runningHubAudioNotApplied"));
    const audioOverrides = audioPatch?.applied ? workflowNodeInfoList(workflow!, audioPatch.workflow) : [];
    // Reference clip: only the 文武双全 family has an adapter that understands `ref_videos.*`
    // (everywhere else the slot, if any, is pruned or means something else). Uploaded and written
    // BEFORE the per-workflow patch for the same reason audio is: that patch deletes an empty
    // `VHS_LoadVideo` slot, so filling it first is what keeps the link and the author's node id.
    const videoSources = yzjinyuRefs ? (request.referenceVideoDataUrls || []).filter(Boolean).slice(0, 1) : [];
    const uploadedVideos: string[] = [];
    for (let index = 0; index < videoSources.length; index += 1) {
        uploadedVideos.push(await uploadVideoFile(origin, apiKey, videoSources[index], `ref-video-${index + 1}${videoFileExtension(videoSources[index])}`, request.signal));
    }
    let prepared: ComfyWorkflow | undefined = audioPatch?.workflow || workflow || undefined;
    let videoApplied = 0;
    if (prepared && uploadedVideos.length) {
        const videoPatch = applyRunningHubReferenceVideos(prepared, uploadedVideos);
        videoApplied = videoPatch.applied;
        prepared = videoPatch.workflow;
    }
    // Same contract as audio: a clip that cannot be placed is an error, never a render that ignores it.
    if (videoSources.length && !videoApplied) throw new Error(apiText("runningHubVideoNotApplied"));
    // MiniMax H3 只认官方那套台词标记（`苏晚 (S1) says:` + `<d>[Chinese]台词</d>`）。分镜表第四套
    // 吐出来的是自然语言 `- **对白**：苏晚：“…”`，原样喂进去等于让人物「描述」台词而不是「说」——
    // 再叠一条音色参考，模型就把片子当氛围片生成（用户 2026-10-24 的「没有台词对话」）。
    // `audioCount` 决定要不要补 `<Audio N> is the voice-timbre reference …` 绑定声明。
    // 独立模型 `2114341115852099586` **不在这个名单里**（2026-10-26）→ 提示词**逐字原样**提交：
    // 不做 `<d>` 转写、不剥分镜表骨架、不撤尾巴块，由作者工作流原本的对话输出逻辑处理。
    // 文戏两个 id 走**最小形态**（`h3PromptForWorkflow` 里的 `audioNegation` 分支）：转 `<d>` +
    // 一句音色声明，其余说明文一概不发 —— 用户 2026-10-26 选定。
    const effectivePrompt = h3PromptForWorkflow(workflowId, request.prompt, {
        audioCount: uploadedAudios.length,
        styleFields: request.fisherStyleFields,
    });
    // 排查「模型说了我没写过的话」时最缺的就是这一行 —— 实际提交给 H3 的正文原样打出来，
    // 用户直接复制给我们就能定位（是不是有多余的 <d>、是不是还有别的字段在招它开口）。
    if (isMinimaxH3FamilyWorkflow(workflowId)) {
        const styleFieldsOn = isMinimaxH3FisherWorkflow(workflowId) && String(request.fisherStyleFields || "") === "on";
        console.info(`[runninghub] h3 prompt (${workflowId}) mode=${h3PromptMode(workflowId)} audio=${uploadedAudios.length} styleFields=${styleFieldsOn ? "on" : "off"}:\n${effectivePrompt}`);
    }
    const patch: RunningHubWorkflowPatch = prepared
        ? buildWorkflowPatch(prepared, effectivePrompt, uploaded, pixels, request.seconds, aspect, request.media === "video" ? "" : request.size || "", workflowId, request.resolution || "", request.mjFlavor || "", request.fisherLoraStrength || "", uploadedAudios.length)
        : { nodeInfoList: [] };
    const overrides = [...patch.nodeInfoList, ...audioOverrides];
    // Planted `LoadAudio` nodes only exist in our copy, and `nodeInfoList` cannot create links —
    // ship the graph whenever the audio had to invent nodes, or a clip filename had to be written
    // into a loader the saved workflow left blank.
    const repairedGraph = patch.graph || (audioPatch?.planted ? audioPatch.workflow : undefined) || (videoApplied ? prepared : undefined);
    // `strength` is here for the LoRA 味型 knob (strength_model on the MJ graph) — without it the
    // whitelist silently drops the override and the picker does nothing.
    const keptOverrides = overrides.filter((item) => /text|prompt|string|value|caption|positive|image|url|image_path|audio|video|resolution|megapixel|aspect_ratio|switch|strength/i.test(item.fieldName));
    // Observability for the "finished but unrelated to my references" class of bug: one line that
    // shows whether the uploads and their overrides actually made it into the submission.
    const referenceCount = (request.referenceDataUrls || []).filter(Boolean).length + audioSources.length + videoSources.length;
    const imageOverrides = overrides.filter((item) => /image|url/i.test(item.fieldName));
    if (referenceCount) {
        console.info(
            `[runninghub] ${workflowId}: refs=${referenceCount} uploaded=${uploaded.length} imageOverrides=${imageOverrides.length} (${imageOverrides.map((item) => `${item.nodeId}.${item.fieldName}`).join(", ") || "none"}) audio=${uploadedAudios.length} audioApplied=${audioPatch?.applied || 0} audioPlanted=${audioPatch?.planted || 0}${uploadedAudios.length ? ` (${audioOverrides.map((item) => `${item.nodeId}.${item.fieldName}`).join(", ") || "graph-only"})` : ""}${fisherDialogueFree ? " noDialogue=1 audioDropped=1 silentShot=1" : ""}${fisherMixedShots ? " lipsyncMixed=1" : ""} video=${uploadedVideos.length} videoApplied=${videoApplied} graph=${Boolean(repairedGraph)} overrides=${overrides.length} localScript=${Boolean(localExportGraph)}`,
        );
    }
    let task: RunningHubTaskView;
    try {
        // Aiden / Pastoral MJ / 全能生图王 / Singularity / HD Dynamic / Fisher: submit Export via
        // create+workflow (not comfy/run — RH often returns NOT_FOUND). Prefer browser-direct create
        // for multi-ref full graphs (Pages proxy ERR_CONNECTION_CLOSED).
        if ((isKrea2AidenLoraWorkflow(workflowId) || isKrea2PastoralMjWorkflow(workflowId) || isWorkFisherMossWorkflow(workflowId) || preferDirectSubmit) && repairedGraph) {
            task = await submitWorkflowTask(origin, apiKey, workflowId, overrides, repairedGraph, request.signal, preferDirectSubmit);
        } else if (usesRunningHubLocalExportGraph(workflowId) && repairedGraph) {
            // SelfLift / Qwen+Klein: shared workflowId often denies create/getJsonApiFormat.
            // Submit the patched API graph through `/task/openapi/comfy/run`.
            task = await submitComfyRunTask(origin, apiKey, repairedGraph, request.signal);
        } else if (workflow) {
            task = await submitWorkflowTask(origin, apiKey, workflowId, overrides, repairedGraph, request.signal);
        } else {
            throw new Error("WORKFLOW_NOT_EXISTS");
        }
    } catch (error) {
        if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const message = errorText(error);
        // Dead key → hand it back untouched so the outer loop can fail over to the next account.
        if (isAuthMessage(message)) throw error;
        // Balance/quota errors are terminal and platform-side — surface them directly instead of
        // retrying or probing the webapp fallback (which would just fail the same way again).
        // They are rethrown raw so the outer multi-key loop can switch to the next key.
        if (/NOT_ENOUGH_BALANCE|INSUFFICIENT_BALANCE|NO_ENOUGH_BALANCE|BALANCE_NOT_ENOUGH|NOT_ENOUGH_POINTS|INSUFFICIENT_POINTS|余额不足|额度不足/i.test(message)) {
            throw error;
        }
        // 全能生图王: `create` can still answer "您暂时无权限访问该工作流" for a third-party app even when
        // the graph we hold is perfectly runnable. Push the same patched graph through
        // `/task/openapi/comfy/run` once — that endpoint does not need the app ACL — before surfacing.
        if (isWorkFisherMossWorkflow(workflowId) && repairedGraph) {
            console.warn(`[runninghub] ${workflowId}: create+workflow failed (${message.slice(0, 160)}), retrying via comfy/run`);
            task = await submitComfyRunTask(origin, apiKey, repairedGraph, request.signal).catch((retryError: unknown) => {
                throw explainRunningHubError(retryError, workflowId);
            });
        } else if (isKrea2AidenLoraWorkflow(workflowId) || isKrea2PastoralMjWorkflow(workflowId) || preferDirectSubmit) {
            throw explainRunningHubError(error, workflowId);
        }
        // Local-export graphs already preferred comfy/run above. If that endpoint is unavailable on
        // this origin, fall back once to create-with-workflow (docs: `workflow` overrides workflowId).
        if (usesRunningHubLocalExportGraph(workflowId) && repairedGraph) {
            console.warn(`[runninghub] ${workflowId}: comfy/run failed (${message.slice(0, 160)}), retrying local-export graph via create+workflow`);
            task = await submitWorkflowTask(origin, apiKey, workflowId, overrides, repairedGraph, request.signal).catch((retryError: unknown) => {
                throw explainRunningHubError(retryError, workflowId);
            });
        } else {
            // A repaired-graph submission is always retried without it, so an unrecognized `workflow`
            // field or a rejected link degrades to the previous nodeInfoList-only behaviour.
            const canRetryPlain =
                Boolean(workflow) &&
                (overrides.length > 0 || Boolean(repairedGraph)) &&
                (Boolean(repairedGraph) || isUnknownServerError(message) || /APIKEY_INVALID_NODE_INFO|Node info error/i.test(message));
            if (canRetryPlain) {
                const fallback = keptOverrides.length && keptOverrides.length < overrides.length ? keptOverrides : [];
                // A fallback without overrides runs the workflow exactly as saved — the author's baked
                // demo images and all. With references on hand that is worse than failing: the task
                // succeeds, renders something unrelated to them, and the user cannot tell why.
                if (!fallback.length && referenceCount) throw explainRunningHubError(error, workflowId);
                console.warn(`[runninghub] ${workflowId}: graph submission failed (${message.slice(0, 160)}), retrying with ${fallback.length} override(s)`);
                task = await submitWorkflowTask(origin, apiKey, workflowId, fallback, undefined, request.signal).catch(async (retryError: unknown) => {
                    if (!fallback.length) throw explainRunningHubError(retryError, workflowId);
                    if (referenceCount) console.warn(`[runninghub] ${workflowId}: override retry failed too; last resort drops ALL overrides`);
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
                    task = await submitWebappTask(origin, apiKey, workflowId, buildWebappNodeInfoList(nodes, effectivePrompt, uploaded, request.size, request.seconds, request.media), request.signal);
                } else if (!workflow) {
                    task = await submitWorkflowTask(origin, apiKey, workflowId, [], undefined, request.signal).catch((retryError: unknown) => {
                        throw explainRunningHubError(retryError, workflowId);
                    });
                } else {
                    throw explainRunningHubError(error, workflowId);
                }
            }
        }
    }
    if (task.errorMessage || isFailedStatus(task.status)) {
        // A failed task can also carry a key-level rejection (balance / dead key / lost workflow
        // access) in its failure reason — let the outer loop switch keys.
        const message = task.errorMessage || "";
        if (isRunningHubKeyFailoverMessage(message)) {
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
            // Polling can surface a late key-level rejection; let the outer loop switch keys.
            if (isRunningHubKeyFailoverMessage(errorText(error))) {
                if (isLastKey) throw explainRunningHubError(error, workflowId);
                throw error;
            }
            throw error;
        }
    }
    const result: RunningHubMedia = { images: task.images, videos: task.videos };
    if (isMinimaxH3FiveSegmentWorkflow(workflowId)) return normalizeMinimaxH3FiveSegmentResult(result, workflow);
    if (isMinimaxH3FourViewWorkflow(workflowId)) return normalizeMinimaxH3FourViewResult(result, workflow);
    return result;
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
