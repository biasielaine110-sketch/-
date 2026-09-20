/**
 * Native ComfyUI cloud/server API (rented GPU / RunningHub proxy / self-host).
 * Flow: optional /upload/image → POST /prompt → poll /history/{id} → GET /view
 *
 * Does NOT use AutoDL hosted workflow API (autodl.art /comfyui/comfyui_workflow/...).
 * Base URL must be the ComfyUI root (e.g. http://host:8188) — never append /v1.
 */

import axios from "axios";
import { nanoid } from "nanoid";

import { proxyApiUrl } from "@/lib/api-proxy";
import { dataUrlToFile } from "@/lib/image-utils";

export type ComfyNode = {
    class_type?: string;
    inputs?: Record<string, unknown>;
    _meta?: { title?: string };
};

export type ComfyWorkflow = Record<string, ComfyNode>;

type RequestOptions = { signal?: AbortSignal };

export type NativeComfyUiResult = {
    images: Array<{ id: string; dataUrl: string }>;
    videos: Array<{ blob: Blob; mimeType: string; url?: string }>;
};

const HISTORY_INTERVAL_MS = 2000;
const HISTORY_TIMEOUT_MS = 20 * 60 * 1000;

/** True for typical rented / proxied ComfyUI endpoints (not AutoDL hosted workflow API). */
export function isNativeComfyUiBaseUrl(baseUrl: string): boolean {
    const raw = String(baseUrl || "").trim();
    if (!raw) return false;
    if (/autodl\.art/i.test(raw)) return false;
    try {
        const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        // Port in URL, or Compshare / similar pods that put 8188 in the subdomain.
        if (/:(8188|8189)\b/.test(raw) || url.port === "8188" || url.port === "8189") return true;
        if (/^8188[-.]|^8189[-.]/i.test(host) || /\.pod\.compshare\.cn$/i.test(host)) return true;
        if (/runninghub\.cn/i.test(host) && /\/proxy(-plus)?(\/|$)/i.test(path)) return true;
        if (/seetacloud\.com|cloud\.ai\.cpolar|ngrok|trycloudflare|compshare\.cn/i.test(host)) return true;
        if (/comfyui/i.test(host) || /\/comfyui\/?$/i.test(path)) return true;
        return false;
    } catch {
        return /:(8188|8189)\b|^8188[-.]|pod\.compshare|runninghub\.cn\/proxy|comfyui/i.test(raw);
    }
}

/**
 * Model script is an Export Workflow (API) JSON object (node-id keys with class_type),
 * optionally wrapped as `{ "prompt": { ... } }`.
 */
export function parseComfyApiWorkflow(script: string | undefined | null): ComfyWorkflow | null {
    const trimmed = String(script || "").trim();
    if (!trimmed.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const candidate =
            parsed.prompt && typeof parsed.prompt === "object" && !Array.isArray(parsed.prompt)
                ? (parsed.prompt as Record<string, unknown>)
                : parsed;
        const nodes = Object.values(candidate);
        if (!nodes.length) return null;
        const looksLikeApi = nodes.some((node) => node && typeof node === "object" && "class_type" in (node as object));
        if (!looksLikeApi) return null;
        return candidate as ComfyWorkflow;
    } catch {
        return null;
    }
}

export function shouldUseNativeComfyUi(baseUrl: string, model: string, script?: string): boolean {
    if (/autodl\.art/i.test(baseUrl) || /runninghub\.(cn|ai)/i.test(baseUrl)) return false;
    if (parseComfyApiWorkflow(script)) return true;
    const name = String(model || "")
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    if (/^comfyui([_:-]|$)/i.test(name) || name === "comfy") return isNativeComfyUiBaseUrl(baseUrl) || Boolean(baseUrl.trim());
    return isNativeComfyUiBaseUrl(baseUrl) && Boolean(parseComfyApiWorkflow(script));
}

/** Strip trailing slash and accidental /v1 so /prompt lands on the ComfyUI root. */
export function normalizeComfyUiRoot(baseUrl: string): string {
    return String(baseUrl || "")
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/v1$/i, "");
}

export function comfyUiUrl(baseUrl: string, path: string): string {
    const root = normalizeComfyUiRoot(baseUrl);
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return proxyApiUrl(`${root}${normalizedPath}`);
}

function authHeaders(apiKey: string, contentType?: string): Record<string, string> {
    const token = String(apiKey || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    if (token && !/^(none|-|n\/a)$/i.test(token)) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
    return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}

const PROMPT_FIELDS = ["text", "prompt", "string", "value", "caption", "positive", "positive_prompt", "text_g", "text_l", "clip_l", "t5xxl"];

function isNegativeComfyNode(node: ComfyNode, field = "") {
    return /negative|负面|\bneg\b/i.test(`${field} ${node._meta?.title || ""} ${node.class_type || ""}`);
}

function comfyPromptScore(node: ComfyNode) {
    if (isNegativeComfyNode(node)) return -1;
    const title = String(node._meta?.title || "");
    const type = String(node.class_type || "");
    if (/positive|正面|提示词|\bprompt\b/i.test(title)) return 40;
    if (/CLIPTextEncode|TextEncode/i.test(type)) return 30;
    if (/Prompt|CRText|PrimitiveString|StringConstant|Wildcard/i.test(type)) return 20;
    if (PROMPT_FIELDS.some((field) => typeof node.inputs?.[field] === "string" && !isNegativeComfyNode(node, field))) return 10;
    return 0;
}

function linkedComfyNode(workflow: ComfyWorkflow, value: unknown): ComfyNode | null {
    if (!Array.isArray(value) || value[0] == null) return null;
    return workflow[String(value[0])] || null;
}

/** Write prompt into a node, following [nodeId, slot] links to Primitive/String sources. */
function writeComfyPromptFields(
    workflow: ComfyWorkflow,
    node: ComfyNode,
    value: string,
    depth = 0,
    forceText = false,
): boolean {
    if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
    if (depth > 3) return false;
    for (const field of PROMPT_FIELDS) {
        if (!(field in node.inputs) || isNegativeComfyNode(node, field)) continue;
        const current = node.inputs[field];
        if (typeof current === "string") {
            node.inputs[field] = value;
            return true;
        }
        const source = linkedComfyNode(workflow, current);
        if (source && writeComfyPromptFields(workflow, source, value, depth + 1, false)) return true;
    }
    // Only force `text` on an already-selected prompt node (not blind fallback).
    if (forceText && depth === 0) {
        node.inputs.text = value;
        return true;
    }
    return false;
}

/** Inject user prompt into CLIP / text-encode positive nodes. */
export function applyComfyPrompt(workflow: ComfyWorkflow, prompt: string): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    const scored = Object.values(next)
        .map((node) => ({ node, score: comfyPromptScore(node) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score || 0;
    // Prefer every title-marked positive node; otherwise only the top match.
    const chosen = best >= 40 ? scored.filter((item) => item.score === best) : scored.slice(0, 1);

    if (chosen.length) {
        for (const item of chosen) writeComfyPromptFields(next, item.node, prompt, 0, true);
        return next;
    }

    // Fallback: first node that already has a string prompt-like field (or linked Primitive).
    for (const [, node] of Object.entries(next)) {
        if (!node?.inputs || isNegativeComfyNode(node)) continue;
        if (writeComfyPromptFields(next, node, prompt, 0, false)) return next;
    }
    return next;
}

function isComfyImageLoader(node: ComfyNode) {
    const type = String(node?.class_type || "");
    const title = String(node?._meta?.title || "");
    // Skip URL/path/base64/video loaders — those need different input fields.
    if (/FromUrl|FromPath|FromBase64|LoadVideo|VHS_LoadVideo|LoadAudio/i.test(type)) return false;
    if (/LoadImage|ImageLoader|LoadImageMask|EasyLoadImage|LoadImageOutput/i.test(type)) return true;
    // Title-marked start/ref frames that already expose a filename `image` string.
    if (/参考|首帧|start.?image|ref.?image|load.?image/i.test(title) && typeof node.inputs?.image === "string") return true;
    return typeof node.inputs?.image === "string" && /image/i.test(type);
}

/** Map uploaded filenames onto LoadImage nodes in order. */
export function applyComfyLoadImages(workflow: ComfyWorkflow, filenames: string[]): ComfyWorkflow {
    if (!filenames.length) return workflow;
    const next = cloneWorkflow(workflow);
    // Stable order by node id so multi-ref mapping is predictable across runs.
    const loaders = Object.entries(next)
        .filter(([, node]) => isComfyImageLoader(node))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([, node]) => node);
    loaders.forEach((node, index) => {
        const name = filenames[index] || filenames[filenames.length - 1];
        if (!name) return;
        if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
        if ("image" in node.inputs || !("url" in node.inputs)) node.inputs.image = name;
        else node.inputs.url = name;
    });
    return next;
}

async function referenceToUploadFile(dataUrlOrHttp: string, fileName: string, signal?: AbortSignal): Promise<File> {
    if (dataUrlOrHttp.startsWith("data:")) {
        return dataUrlToFile({ id: fileName, name: fileName, dataUrl: dataUrlOrHttp, type: "image/png" });
    }
    if (/^https?:\/\//i.test(dataUrlOrHttp)) {
        const response = await axios.get(proxyApiUrl(dataUrlOrHttp), { responseType: "blob", signal });
        const blob = response.data as Blob;
        return new File([blob], fileName, { type: blob.type || "image/png" });
    }
    throw new Error("Unsupported ComfyUI reference image");
}

export async function uploadComfyImage(
    baseUrl: string,
    apiKey: string,
    dataUrl: string,
    fileName: string,
    options?: RequestOptions,
): Promise<string> {
    const file = await referenceToUploadFile(dataUrl, fileName, options?.signal);
    const body = new FormData();
    body.append("image", file);
    body.append("overwrite", "true");
    const response = await axios.post(comfyUiUrl(baseUrl, "/upload/image"), body, {
        headers: authHeaders(apiKey),
        signal: options?.signal,
    });
    const name = response.data?.name || response.data?.filename || file.name;
    if (!name) throw new Error("ComfyUI upload did not return a filename");
    return String(name);
}

type HistoryOutputs = Record<
    string,
    {
        images?: Array<{ filename: string; subfolder?: string; type?: string }>;
        gifs?: Array<{ filename: string; subfolder?: string; type?: string }>;
        videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
    }
>;

function collectMediaFromHistory(outputs: HistoryOutputs | undefined) {
    const images: Array<{ filename: string; subfolder: string; type: string }> = [];
    const videos: Array<{ filename: string; subfolder: string; type: string }> = [];
    if (!outputs || typeof outputs !== "object") return { images, videos };
    for (const node of Object.values(outputs)) {
        for (const item of node.images || []) {
            if (!item?.filename) continue;
            const entry = { filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output" };
            if (/\.(mp4|webm|mov)$/i.test(item.filename)) videos.push(entry);
            else images.push(entry);
        }
        for (const item of [...(node.gifs || []), ...(node.videos || [])]) {
            if (!item?.filename) continue;
            videos.push({ filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output" });
        }
    }
    return { images, videos };
}

async function fetchComfyView(
    baseUrl: string,
    apiKey: string,
    file: { filename: string; subfolder: string; type: string },
    options?: RequestOptions,
): Promise<Blob> {
    // Bake query into the ComfyUI URL BEFORE proxy wrapping. Axios `params` on an
    // already-proxied URL (`/api/proxy?target=.../view`) would attach to the outer
    // proxy URL and leave upstream `/view` without filename → 404.
    const query = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder || "",
        type: file.type || "output",
    });
    const response = await axios.get(comfyUiUrl(baseUrl, `/view?${query.toString()}`), {
        headers: authHeaders(apiKey),
        responseType: "blob",
        signal: options?.signal,
    });
    return response.data as Blob;
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read ComfyUI output"));
        reader.readAsDataURL(blob);
    });
}

function readSubmitRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value === "string") {
        try {
            return readSubmitRecord(JSON.parse(value));
        } catch {
            return null;
        }
    }
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readComfySubmit(data: unknown) {
    const root = readSubmitRecord(data);
    const nested = readSubmitRecord(root?.data);
    const records = [root, nested].filter((item): item is Record<string, unknown> => Boolean(item));
    let promptId = "";
    let taskId = "";
    let message = "";
    for (const record of records) {
        if (!promptId) {
            const id = record.prompt_id || record.promptId;
            if (typeof id === "string" || typeof id === "number") promptId = String(id);
        }
        if (!taskId) {
            const id = record.taskId || record.task_id;
            if (typeof id === "string" && id) taskId = id;
        }
        if (!message) {
            const text = [record.errorMessage, record.failedReason, record.msg, record.message, record.errorCode].find(
                (item) => typeof item === "string" && item.trim() && !/^success$/i.test(item.trim()),
            );
            if (typeof text === "string") message = text.trim();
        }
    }
    return { promptId, taskId, message };
}

async function finishRunningHubTask(baseUrl: string, apiKey: string, taskId: string, signal?: AbortSignal): Promise<NativeComfyUiResult> {
    const { pollRunningHubQuery, runningHubApiKey, runningHubOrigin } = await import("@/lib/runninghub-workflow");
    const origin = runningHubOrigin(baseUrl);
    const token = runningHubApiKey(baseUrl, apiKey);
    if (!origin || !token) throw new Error("ComfyUI did not return prompt_id");
    const task = await pollRunningHubQuery({ origin, apiKey: token, taskId, signal });
    const images = task.images.map((url) => ({ id: nanoid(), dataUrl: url }));
    const videos: NativeComfyUiResult["videos"] = [];
    for (const url of task.videos) {
        const response = await axios.get<Blob>(proxyApiUrl(url), { responseType: "blob", signal });
        videos.push({ blob: response.data, mimeType: response.data.type || "video/mp4", url });
    }
    if (!images.length && !videos.length) throw new Error("ComfyUI finished but returned no images/videos");
    return { images, videos };
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

export type RunNativeComfyUiArgs = {
    baseUrl: string;
    apiKey: string;
    workflow: ComfyWorkflow;
    prompt: string;
    referenceDataUrls?: string[];
    signal?: AbortSignal;
};

/**
 * Upload references, inject prompt/images, queue prompt, poll history, download outputs.
 */
export async function runNativeComfyUiJob(args: RunNativeComfyUiArgs): Promise<NativeComfyUiResult> {
    const { baseUrl, apiKey, prompt, signal } = args;
    if (!normalizeComfyUiRoot(baseUrl)) throw new Error("ComfyUI Base URL is required");

    let workflow = applyComfyPrompt(args.workflow, prompt);
    const refs = (args.referenceDataUrls || []).filter(Boolean).slice(0, 8);
    if (refs.length) {
        const names: string[] = [];
        for (let i = 0; i < refs.length; i += 1) {
            const uploaded = await uploadComfyImage(baseUrl, apiKey, refs[i], `ref-${i + 1}.png`, { signal });
            names.push(uploaded);
        }
        workflow = applyComfyLoadImages(workflow, names);
    }

    const clientId = nanoid(12);
    const token = String(apiKey || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    const body: Record<string, unknown> = { prompt: workflow, client_id: clientId };
    if (token && !/^(none|-|n\/a)$/i.test(token)) body.token = token;

    const submit = await axios.post(comfyUiUrl(baseUrl, "/prompt"), body, {
        headers: authHeaders(apiKey, "application/json"),
        signal,
    });
    const submitted = readComfySubmit(submit.data);
    if (!submitted.promptId && submitted.taskId && /runninghub\.(cn|ai)/i.test(baseUrl)) {
        return finishRunningHubTask(baseUrl, apiKey, submitted.taskId, signal);
    }
    const promptId = submitted.promptId;
    if (!promptId) {
        const err = submit.data?.error || submit.data?.node_errors;
        const errText = typeof err === "string" ? err : err && typeof err === "object" && Object.keys(err).length ? JSON.stringify(err) : "";
        throw new Error(errText || submitted.message || "ComfyUI did not return prompt_id");
    }

    const deadline = performance.now() + HISTORY_TIMEOUT_MS;
    let outputs: HistoryOutputs | undefined;
    while (performance.now() < deadline) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const history = await axios.get(comfyUiUrl(baseUrl, `/history/${encodeURIComponent(promptId)}`), {
            headers: authHeaders(apiKey),
            signal,
        });
        const entry = history.data?.[promptId] || history.data;
        if (entry?.status?.status_str === "error" || entry?.status?.completed === false && entry?.status?.messages?.some?.((m: unknown) => Array.isArray(m) && m[0] === "execution_error")) {
            throw new Error("ComfyUI workflow execution failed");
        }
        if (entry?.outputs && Object.keys(entry.outputs).length) {
            outputs = entry.outputs as HistoryOutputs;
            break;
        }
        await sleep(HISTORY_INTERVAL_MS, signal);
    }
    if (!outputs) throw new Error("ComfyUI timed out waiting for /history");

    const media = collectMediaFromHistory(outputs);
    if (!media.images.length && !media.videos.length) throw new Error("ComfyUI finished but returned no images/videos");

    const images: NativeComfyUiResult["images"] = [];
    for (const file of media.images) {
        const blob = await fetchComfyView(baseUrl, apiKey, file, { signal });
        images.push({ id: nanoid(), dataUrl: await blobToDataUrl(blob) });
    }

    const videos: NativeComfyUiResult["videos"] = [];
    for (const file of media.videos) {
        const blob = await fetchComfyView(baseUrl, apiKey, file, { signal });
        const mimeType = blob.type || (/\.webm$/i.test(file.filename) ? "video/webm" : "video/mp4");
        videos.push({ blob, mimeType });
    }

    return { images, videos };
}

/** Health probe: GET /system_stats or /object_info (any 2xx/4xx from live server counts). */
export async function probeNativeComfyUi(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    try {
        const response = await axios.get(comfyUiUrl(baseUrl, "/system_stats"), {
            headers: authHeaders(apiKey),
            signal,
            timeout: 12_000,
            validateStatus: () => true,
        });
        if (response.status === 404) {
            const fallback = await axios.get(comfyUiUrl(baseUrl, "/object_info"), {
                headers: authHeaders(apiKey),
                signal,
                timeout: 12_000,
                validateStatus: () => true,
            });
            if (fallback.status >= 200 && fallback.status < 500) return { ok: true, message: `HTTP ${fallback.status}` };
            return { ok: false, message: `HTTP ${fallback.status}` };
        }
        if (response.status === 401 || response.status === 403) return { ok: false, message: "ComfyUI auth failed (check API token)" };
        if (response.status >= 200 && response.status < 500) return { ok: true, message: `HTTP ${response.status}` };
        return { ok: false, message: `HTTP ${response.status}` };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
