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
import { compressReferenceDataUrl, dataUrlToFile } from "@/lib/image-utils";

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
    /**
     * Text outputs collected from text-sink nodes (`ShowText|pysssss` …). Populated only for the
     * detected text-output family (see `isComfyTextOutputWorkflow`); empty for every other graph,
     * so image/video callers are unaffected by its presence.
     */
    texts?: string[];
};

const HISTORY_INTERVAL_MS = 2000;
/** Faster poll once a video graph has started returning history (cut return latency after the pod finishes). */
const HISTORY_FAST_INTERVAL_MS = 400;
/** Even tighter poll when ComfyUI already reports success but the VHS mp4 has not landed yet. */
const HISTORY_VIDEO_DONE_INTERVAL_MS = 250;
// H3 等 DiT 视频工作流在共享 GPU / 长队列下可能跑很久（排队 + 采样 + VAE 解码），
// 60 分钟是实测安全上限；超时后任务仍在服务器跑，只是画布停止等待。
const HISTORY_TIMEOUT_MS = 60 * 60 * 1000;
/** After status=success, keep polling this many times for a late-persisted VHS mp4 (ComfyUI #11540). */
const VIDEO_HISTORY_GRACE_POLLS = 8;
/**
 * U24 DualClock / H3-video on rented pods: long clips + HIGH refine routinely OOM the worker and
 * seetacloud's nginx then answers every subsequent call with HTTP 502. This is the *floor* of the
 * duration guard only — the effective ceiling is `max(this, the graph's own baked duration)` so the
 * guard never clamps below a default run (see `h3AuthoredDurationSeconds`). V927 bakes 20 s, so a
 * 15 s pick reaches the graph; a template that bakes 15 s reaches 15 s. Only a graph whose baked
 * duration is smaller than this — or unreadable — keeps this 10 s floor.
 */
const TWO_PASS_H3_MAX_SECONDS = 10;
/**
 * **Delivered**-resolution ceiling for the DualClock two-pass H3 video family (U24 …).
 *
 * The delivered clip is the ResolutionSelector's `megapixels` multiplied back up by the learned
 * latent upscaler's factor, so a ceiling placed on the *draft* silently caps the output: the
 * shipped 0.7 MP draft cap delivered ≈1.0 MP (≈720p) for **every** canvas tier — picking 1080p or
 * 2K still came back 720p, contradicting the app's own "常用选 1080p；需要更高成片可选 2K" hint.
 *
 * A draft number also cannot be shared across templates: it is only correct for the exact
 * `scale_by` it was measured against (0.95 was tuned for the V2 template's ×1.5), while the V927
 * template ships ×1.2 — so restoring "0.95" would land 1080p at ≈1.37 MP there, not 1920×1080.
 * Expressed on the **delivered** megapixels the guard is factor-independent: 720p / 1080p / 2K
 * each land exactly on the canvas tier, and only the VRAM-infeasible 4K tier is clamped back
 * (≈2K). This is the same guard that was accidentally removed along with the duration clamp when
 * `7ddd219` ("full 1080p draft budget") was reverted by `1525ca8`.
 */
const TWO_PASS_H3_MAX_DELIVERED_MEGAPIXELS = 4;

/** Rented / tunnel hosts whose nginx often returns 502 while ComfyUI is unloading or restarting. */
function isFlakyComfyGatewayHost(baseUrl: string) {
    return /seetacloud\.com|cloud\.ai\.cpolar|ngrok|trycloudflare|compshare\.cn/i.test(String(baseUrl || ""));
}

function isComfyGatewayRetryStatus(status: number | undefined) {
    return status === 502 || status === 503 || status === 504;
}

/**
 * Retry transient gateway failures (502/503/504) that rented ComfyUI proxies emit under load
 * or brief upstream blips. Does not retry 4xx / abort.
 */
async function comfyRequestWithGatewayRetry<T>(
    run: () => Promise<T>,
    options?: { signal?: AbortSignal; attempts?: number; label?: string; backoffMs?: number },
): Promise<T> {
    const attempts = Math.max(1, options?.attempts ?? 3);
    const backoffMs = Math.max(200, options?.backoffMs ?? 800);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            return await run();
        } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            const network = axios.isAxiosError(error) && !error.response;
            if ((!isComfyGatewayRetryStatus(status) && !network) || attempt >= attempts - 1) throw error;
            await sleep(backoffMs * (attempt + 1), options?.signal);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(options?.label || "ComfyUI gateway request failed");
}

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
        if (/-(?:8188|8189)[-.]proxy\.runpod\.net$/i.test(host) || /[-.]8188[-.]proxy\.runpod\.net$/i.test(host)) return true;
        if (/comfyui/i.test(host) || /\/comfyui\/?$/i.test(path)) return true;
        return false;
    } catch {
        return /:(8188|8189)\b|^8188[-.]|pod\.compshare|runninghub\.cn\/proxy|comfyui|[-.]8188[-.]proxy\.runpod\.net|-(?:8188|8189)[-.]proxy\.runpod\.net/i.test(raw);
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
    // A recognized ComfyUI server must never fall through to the OpenAI-style call: that path
    // sends `Authorization: Bearer ...`, the server answers 401 + WWW-Authenticate: Basic, and
    // the browser pops a native login dialog on every generation request. Route to the native
    // path instead so an empty script surfaces the clear "workflow required" error.
    if (isNativeComfyUiBaseUrl(baseUrl)) return true;
    return Boolean(parseComfyApiWorkflow(script));
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

/** `user:pass` (Basic Auth) vs a Bearer/raw token. Returns the Basic credential, or null. */
function parseBasicCredential(apiKey: string): { user: string; pass: string } | null {
    const raw = String(apiKey || "").trim();
    if (!raw || /^(none|-|n\/a)$/i.test(raw)) return null;
    if (/^Bearer\s+/i.test(raw)) return null;
    const colon = raw.indexOf(":");
    if (colon <= 0 || colon === raw.length - 1) return null;
    return { user: raw.slice(0, colon), pass: raw.slice(colon + 1) };
}

function authHeaders(apiKey: string, contentType?: string): Record<string, string> {
    const token = String(apiKey || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    const basic = parseBasicCredential(apiKey);
    if (basic) {
        headers.Authorization = `Basic ${btoa(`${basic.user}:${basic.pass}`)}`;
    } else if (token && !/^(none|-|n\/a)$/i.test(token)) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

/** Whether a channel apiKey is a `user:pass` Basic-Auth credential (vs a Bearer token). */
export function isBasicAuthCredential(apiKey: string): boolean {
    return Boolean(parseBasicCredential(apiKey));
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
    if (/CR\s*PromptText/i.test(type)) return 35;
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
    let wrote = false;
    const type = String(node.class_type || "");
    // CR PromptText keeps the long screenplay in `prompt` and a short stub in `text`.
    const fields =
        /CR\s*PromptText|PromptText/i.test(type) || ("prompt" in node.inputs && "text" in node.inputs)
            ? ["prompt", ...PROMPT_FIELDS.filter((field) => field !== "prompt")]
            : PROMPT_FIELDS;

    for (const field of fields) {
        if (!(field in node.inputs) || isNegativeComfyNode(node, field)) continue;
        const current = node.inputs[field];
        if (typeof current === "string") {
            node.inputs[field] = value;
            wrote = true;
            // Keep writing sibling string fields on the same node (CR PromptText has both).
            continue;
        }
        const source = linkedComfyNode(workflow, current);
        if (source && writeComfyPromptFields(workflow, source, value, depth + 1, false)) wrote = true;
    }
    if (wrote) return true;
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

/**
 * LoadImage node ids in MiniMax H3 reference-slot order.
 *
 * H3 conditioning nodes consume references through named slots `ref_images.ref_image_0…N`,
 * and the slot order is defined by the *links* — never by node-id order. A real workflow
 * can wire ref_image_0…3 to node ids 66/65/58/59, so sorting loaders by id would scramble
 * every reference (subject 1 ↔ picture 3, …). Only trust the slot order when every slot
 * points at a real image loader; otherwise return [] and let the caller fall back.
 */
function comfyReferenceSlotOrder(workflow: ComfyWorkflow): string[] {
    const targets = Object.entries(workflow)
        .filter(([, node]) => isMiniMaxH3ConditioningNode(node))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    for (const [, node] of targets) {
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        const slots: Array<{ index: number; id: string }> = [];
        for (const key of Object.keys(inputs)) {
            const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
            if (!match) continue;
            const value = (inputs as Record<string, unknown>)[key];
            if (!Array.isArray(value) || value[0] == null) continue;
            slots.push({ index: Number(match[1]), id: String(value[0]) });
        }
        if (slots.length < 2) continue;
        slots.sort((a, b) => a.index - b.index);
        const ids = slots.map((slot) => slot.id);
        if (ids.every((id) => workflow[id] && isComfyImageLoader(workflow[id]))) return ids;
    }
    return [];
}

/** Ascending picture index from a loader title (`加载图像1` / `Load Image 2`), else null. */
function comfyLoaderAscIndex(node: ComfyNode | undefined): number | null {
    const title = String(node?._meta?.title || "");
    const match = /(?:加载图像|Load\s*Image|Image)\s*(\d+)/i.exec(title);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

/**
 * Picture-slot plan for one H3 node, repaired so each `ref_image_N` slot reads its own loader.
 *
 * `comfyReferenceSlotOrder` returns the slot links verbatim. The multi-reference *video* family
 * (U06 …多图参考生视频) additionally names its loaders with ascending titles (`加载图像1…N`), and
 * re-exports have shipped with one slot linked twice to the same loader while the intended loader
 * sits unreferenced — exactly the U06 V8 template, where `ref_image_0`/`ref_image_1` both point at
 * `加载图像2` and `加载图像1` is orphaned. Under a verbatim mapping the first upload landed on the
 * orphan node and every picture shifted by one, so `<Picture 1>` showed the 2nd upload and the last
 * upload was silently dropped.
 *
 * Fixing the mapping therefore needs *two* things for a duplicated slot: point it at a spare loader
 * (the orphan the author clearly meant to keep, ascending title) **and** rewire the link, otherwise
 * the slot keeps reading the shared loader and the substitution is invisible. When the *first*
 * occurrence of a duplicated loader has an earlier-titled spare (`加载图像1` vs `加载图像2`), that
 * spare is claimed for the earlier slot so `<Picture 1>` lands on `加载图像1` — assigning the spare
 * only to the *second* occurrence would leave Picture 1/2 swapped. Only when no spare is left drop
 * the repeat, so no upload is ever wasted on the same loader twice.
 *
 * Returns `null` when the node does not expose at least two validated slots, letting the caller keep
 * its previous behaviour.
 */
function comfyMultiReferenceSlotPlan(
    workflow: ComfyWorkflow,
): { nodeId: string; ordered: string[]; rewire: Array<{ key: string; to: string }> } | null {
    const entry = Object.entries(workflow)
        .filter(([, candidate]) => isMiniMaxH3ConditioningNode(candidate))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))[0];
    const inputs = entry?.[1]?.inputs;
    if (!entry || !inputs || typeof inputs !== "object") return null;
    const slots: Array<{ key: string; index: number; id: string }> = [];
    for (const key of Object.keys(inputs)) {
        const match = /^ref_images\.ref_image_(\d+)$/.exec(key);
        if (!match) continue;
        const value = (inputs as Record<string, unknown>)[key];
        if (!Array.isArray(value) || value[0] == null) continue;
        const id = String(value[0]);
        if (!workflow[id] || !isComfyImageLoader(workflow[id])) continue;
        slots.push({ key, index: Number(match[1]), id });
    }
    if (slots.length < 2) return null;
    slots.sort((a, b) => a.index - b.index);
    const referenced = new Set(slots.map((slot) => slot.id));
    const spares = Object.entries(workflow)
        .filter(([id, candidate]) => isComfyImageLoader(candidate) && !referenced.has(id))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([id]) => id);
    const used = new Set<string>();
    const ordered: string[] = [];
    const rewire: Array<{ key: string; to: string }> = [];
    for (const slot of slots) {
        if (!used.has(slot.id)) {
            // U06 V8: first of a duplicated pair should claim the earlier orphan (`加载图像1`) so
            // `<Picture 1>` is not stuck on `加载图像2`. Leave `slot.id` unused for the later twin.
            const hasLaterDuplicate = slots.some((other) => other.index > slot.index && other.id === slot.id);
            if (hasLaterDuplicate && spares.length) {
                const currentIdx = comfyLoaderAscIndex(workflow[slot.id]) ?? Number(slot.id);
                let bestPos = -1;
                let bestIdx = Infinity;
                for (let i = 0; i < spares.length; i += 1) {
                    const spareIdx = comfyLoaderAscIndex(workflow[spares[i]]) ?? Number(spares[i]);
                    if (spareIdx < currentIdx && spareIdx < bestIdx) {
                        bestIdx = spareIdx;
                        bestPos = i;
                    }
                }
                if (bestPos >= 0) {
                    const spare = spares.splice(bestPos, 1)[0];
                    used.add(spare);
                    ordered.push(spare);
                    rewire.push({ key: slot.key, to: spare });
                    continue;
                }
            }
            used.add(slot.id);
            ordered.push(slot.id);
            continue;
        }
        const spare = spares.shift();
        if (!spare) continue; // duplicate with no spare — drop rather than overwrite the same loader twice
        used.add(spare);
        ordered.push(spare);
        rewire.push({ key: slot.key, to: spare });
    }
    return { nodeId: entry[0], ordered, rewire };
}

/**
 * Structural fingerprint of the MiniMax H3 "two-pass / 双采" multi-reference family.
 *
 * These graphs get re-exported and renamed constantly: the exported file name changes every
 * revision (…V1 / …V2 / …V3) and the app's model option can be anything at all (e.g.
 * "H3-video"). Keying behaviour off one exact name turns the adapter into dead code the moment
 * either side is renamed — which is exactly how this workflow silently regressed. Detect the
 * family by shape instead:
 *
 *  1. `comfyReferenceSlotOrder` finds >= 2 named reference slots (`ref_images.ref_image_N` on a
 *     MiniMax H3 conditioning node) and *every* slot resolves to a real image loader. Those
 *     slots are the picture ordinals (`<Picture N+1>` ↔ `ref_image_N`), so slot order is
 *     correct by definition while node-id order is arbitrary;
 *  2. the graph runs the LOW + HIGH two-pass pair (>= 2 H3 conditioning nodes).
 *
 * Both are required, so a single-pass H3 graph, an image graph, or any workflow without
 * validated named slots never matches and keeps its previous behaviour.
 */
export function isComfyH3TwoPassReferenceWorkflow(workflow: ComfyWorkflow): boolean {
    if (comfyReferenceSlotOrder(workflow).length < 2) return false;
    return Object.values(workflow).filter((node) => isMiniMaxH3ConditioningNode(node)).length >= 2;
}

/** True for the DualClock sampler node whose class name accidentally matches `/KSampler/i`. */
function isComfyDualClockSamplerNode(node: ComfyNode) {
    return /MiniMaxH3DualClockSampler/i.test(String(node?.class_type || ""));
}

/**
 * Structural fingerprint of the MiniMax H3 "single-reference image edit" family
 * (e.g. U33-Minimax-H3图像编辑全能工作流).
 *
 * Shape: exactly one H3 conditioning node carrying exactly one validated named reference
 * slot (`ref_images.ref_image_N` → a real image loader), sampled by a plain `KSampler`,
 * with none of the two-pass machinery (`ResolutionSelector` / `RandomNoise` / `SamplerCustom`
 * / learned upscaler) that marks the video family. These graphs bake the output size straight
 * onto the H3 node (`width`/`height` = 2048×2048 in the U33 template), and the *image* path
 * passes no canvas size — so the shared geometry writer would otherwise invent a 16:9 @1280
 * default and clobber the author's square size on every run.
 *
 * Deliberately disjoint from `isComfyH3TwoPassReferenceWorkflow` (that one requires ≥2 slots
 * and ≥2 conditioning nodes). Any graph that does not match exactly keeps its previous
 * behaviour, so no other channel/model is affected.
 */
export function isComfyH3SingleReferenceImageWorkflow(workflow: ComfyWorkflow): boolean {
    const conditioning = Object.values(workflow).filter((node) => isMiniMaxH3ConditioningNode(node));
    if (conditioning.length !== 1) return false;
    const inputs = conditioning[0]?.inputs;
    if (!inputs || typeof inputs !== "object") return false;
    const slotKeys = Object.keys(inputs).filter((key) => /^ref_images\.ref_image_\d+$/.test(key));
    if (slotKeys.length !== 1) return false;
    const slotValue = (inputs as Record<string, unknown>)[slotKeys[0]];
    if (!Array.isArray(slotValue) || slotValue[0] == null) return false;
    const loader = workflow[String(slotValue[0])];
    if (!loader || !isComfyImageLoader(loader)) return false;
    const types = Object.values(workflow).map((node) => String(node?.class_type || ""));
    if (types.some((type) => /ResolutionSelector|RandomNoise|SamplerCustom|LatentUpscale/i.test(type))) return false;
    return types.some((type) => /^KSampler$/i.test(type));
}

/**
 * Structural fingerprint of the Krea2 image "character sheet / 4-view" edit family
 * (e.g. T10-Krea2做剧图像4视图).
 *
 * Shape: at least one Krea2 Edit node (`Krea2EditModelPatch` / `Krea2EditGroundedEncode` — node
 * types that exist only in the Krea2 edit pipeline), a plain `KSampler`, and a text-to-image
 * `Empty*LatentImage`. These graphs push a single `LoadImage` reference through the edit encoder
 * and bake the *output* canvas straight onto that latent node (1536×1024 = 3:2 in the T10
 * template), because the `krea2_4panel` LoRA is trained for that exact grid — the canvas is part
 * of the model, not a user knob.
 *
 * The image path passes no canvas size, so the shared geometry writer would otherwise invent its
 * 16:9 @1280 default (1280×736 after the 32-px snap) and clobber the author's 3:2 canvas on every
 * run, squashing the four panels into a strip.
 *
 * Disjoint from both H3 fingerprints (Krea2 node types never appear in an H3 graph), so every
 * other graph keeps its previous behaviour.
 */
export function isComfyKrea2EditWorkflow(workflow: ComfyWorkflow): boolean {
    const types = Object.values(workflow).map((node) => String(node?.class_type || ""));
    if (!types.some((type) => /^Krea2Edit/i.test(type))) return false;
    if (!types.some((type) => /^KSampler$/i.test(type))) return false;
    return types.some((type) => /^Empty(?:SD3|SDXL|Latent|FLUX|SD)?LatentImage/i.test(type));
}

/**
 * Structural fingerprint of the MiniMax H3 **single-pass multi-reference video** family
 * (e.g. U06-h3_多图参考生视频V8).
 *
 * Shape: *exactly one* H3 conditioning node that carries >= 2 validated named reference slots
 * (`ref_images.ref_image_N`, every slot pointing at a real image loader) and a video sink
 * (`VHS_VideoCombine` / `SaveVideo`). This is the third H3 family the codebase had no adapter for:
 * it is neither the two-pass video family (that one runs two H3 conditioning nodes) nor the
 * single-reference *image* family (that one has exactly one slot and no video sink), so it fell
 * through every fingerprint.
 *
 * Consequences of falling through (both fixed by opting in here):
 *  - the reference-slot mapping never engaged, so uploads were spread over loaders in node-id order
 *    (see `comfyMultiReferenceSlotPlan`) — see that helper for the U06 V8 off-by-one;
 *  - `keepTunedResolution` stayed false, so a variant that bakes a scalar size straight onto the H3
 *    node would have had it rewritten from the 16:9 @1280 image-path fallback.
 *
 * Strictly disjoint from every other fingerprint: two-pass needs >= 2 H3 nodes, the image family
 * needs exactly 1 slot, and Krea2/text families need node types that never appear here. Any graph
 * that does not match exactly keeps its previous behaviour.
 */
export function isComfyH3MultiReferenceVideoWorkflow(workflow: ComfyWorkflow): boolean {
    const conditioning = Object.values(workflow).filter((node) => isMiniMaxH3ConditioningNode(node));
    if (conditioning.length !== 1) return false;
    if (comfyReferenceSlotOrder(workflow).length < 2) return false;
    return hasComfyVideoSink(workflow);
}

/** True when the graph ends in a video sink (`VHS_VideoCombine` / `SaveVideo`). */
function hasComfyVideoSink(workflow: ComfyWorkflow): boolean {
    return Object.values(workflow).some((node) => /VideoCombine|SaveVideo/i.test(String(node?.class_type || "")));
}

/**
 * Structural fingerprint of the MiniMax H3 **SelfLift 自采/双采「上下文无缝无色差长视频」** family
 * (e.g. U37-真-上下文无缝无色差长视频-SelfLift双采).
 *
 * Shape: exactly one H3 conditioning node sampled by the family's own `SelfLiftH3Sampler` — a
 * progressive low→high resolution sampler with a learned upscaler whose node type appears in no
 * other H3 graph — and a video sink.
 *
 * It also satisfies `isComfyH3MultiReferenceVideoWorkflow`, but rides that family's behaviour
 * wrongly on all three counts this adapter exists to fix:
 *  - the `ResolutionSelector` *is* this graph's delivered resolution (the H3 node's width/height are
 *    links into it and the sampler only splits that one target into a cheap low-res pass
 *    internally), so treating it as a tuned draft left the canvas size/ratio with no effect;
 *  - its spare reference slots park the author's own `…blank…` placeholder, while the generic
 *    fill-up repeated the *last* upload there — handing the model one picture up to eight times;
 *  - its seed sits in `SelfLiftH3Sampler.seed`, whose class name contains no "KSampler" substring,
 *    so the shared seed randomiser never reached it and every run replayed the identical video.
 *
 * Disjoint from every other fingerprint: the two-pass family runs >= 2 H3 nodes, the single-
 * reference image family owns exactly one slot, and the U06 single-pass video family has no
 * SelfLift sampler. Any graph that does not match keeps its previous behaviour untouched.
 */
export function isComfyH3SelfLiftWorkflow(workflow: ComfyWorkflow): boolean {
    const conditioning = Object.values(workflow).filter((node) => isMiniMaxH3ConditioningNode(node));
    if (conditioning.length !== 1) return false;
    if (!hasComfyVideoSink(workflow)) return false;
    return Object.values(workflow).some((node) => /^SelfLiftH3Sampler$/i.test(String(node?.class_type || "")));
}

/**
 * True when an H3 conditioning node's width/height link into a `ResolutionSelector`.
 * Shared by U35 官流 (selector = delivered) and U30 Singularity (selector = LOW draft).
 */
function h3LinksToResolutionSelector(workflow: ComfyWorkflow): boolean {
    const conditioning = Object.values(workflow).find((node) => isMiniMaxH3ConditioningNode(node));
    const inputs = conditioning?.inputs;
    if (!inputs || typeof inputs !== "object") return false;
    for (const field of ["width", "height"]) {
        const link = inputs[field];
        if (!Array.isArray(link) || link[0] == null) continue;
        const holder = workflow[String(link[0])];
        if (/ResolutionSelector/i.test(String(holder?.class_type || ""))) return true;
    }
    return false;
}

/**
 * Structural fingerprint of the MiniMax H3 **Singularity 超双采放大** family
 * (e.g. U30-Minimax-H3-Singularity超双采放大-AIGC特异点).
 *
 * Shape: the same single-H3 + ≥2 ref slots + video sink + ResolutionSelector-linked size as U35
 * 官流, **plus** a `MinimaxH3LatentUpscaler3D` that multiplies the selector's geometry (author
 * bake: selector 0.7 MP × 1.5 scale → ~1.6 MP delivered). Without this fingerprint the graph
 * rides the U35 "selector = delivered" path and the canvas megapixels are written straight onto
 * the *draft*, then multiplied again by 1.5² — inflating far past what the user asked for and
 * OOMing the pod.
 *
 * Disjoint from DualClock two-pass (≥2 H3 conditioning nodes), SelfLift, and U35 (no 3D latent
 * upscaler). Any graph that does not match keeps its previous behaviour untouched.
 */
export function isComfyH3SingularityUpscaleWorkflow(workflow: ComfyWorkflow): boolean {
    if (!isComfyH3MultiReferenceVideoWorkflow(workflow)) return false;
    if (isComfyH3SelfLiftWorkflow(workflow)) return false;
    if (!h3LinksToResolutionSelector(workflow)) return false;
    return Object.values(workflow).some((node) => /MinimaxH3LatentUpscaler3D/i.test(String(node?.class_type || "")));
}

/**
 * Structural fingerprint of the MiniMax H3 **官流 / ResolutionSelector-delivered** single-pass
 * multi-reference video family (e.g. U35-H3官流-终极版-神棍).
 *
 * Shape: the same single-H3 + ≥2 ref slots + video sink as `isComfyH3MultiReferenceVideoWorkflow`,
 * but the H3 node's width/height are *links into a `ResolutionSelector`* (aspect + megapixels) —
 * not a `WJILatentPreset` (U06) and not a SelfLift sampler (U37). The selector is therefore the
 * *delivered* resolution.
 *
 * Without this fingerprint the graph rides the generic multi-ref / `keepTunedResolution` path:
 *  - aspect is frozen (authored megapixels is present, so the keep-tuned branch never rewrites it);
 *  - megapixels is only clamped down, never driven by the canvas;
 *  - `reshapeLinkedH3Canvas` looks for `自定义宽`/`width` scalars and finds none on a
 *    ResolutionSelector, so size/ratio stay dead.
 *
 * Disjoint from SelfLift (no `SelfLiftH3Sampler`), from U30 Singularity (has LatentUpscaler3D),
 * and from U06 (no ResolutionSelector size link). Any graph that does not match keeps its
 * previous behaviour untouched.
 */
export function isComfyH3ResolutionSelectorVideoWorkflow(workflow: ComfyWorkflow): boolean {
    if (!isComfyH3MultiReferenceVideoWorkflow(workflow)) return false;
    if (isComfyH3SelfLiftWorkflow(workflow)) return false;
    if (isComfyH3SingularityUpscaleWorkflow(workflow)) return false;
    return h3LinksToResolutionSelector(workflow);
}

/**
 * True for every family whose resolution/geometry is locked by the graph author rather than by
 * the canvas controls: the two-pass H3 video family (ResolutionSelector megapixels), the
 * single-reference H3 image family (the H3 node's own width/height), the single-pass H3
 * multi-reference video family (the linked `WJILatentPreset` / H3 node size), and the Krea2 edit
 * image family (`Empty*LatentImage` canvas). Drives `keepTunedResolution`, seed randomization and
 * the upload size guard — and nothing else, so all other native ComfyUI models are untouched.
 */
export function isComfyGeometryLockedWorkflow(workflow: ComfyWorkflow): boolean {
    return (
        isComfyH3TwoPassReferenceWorkflow(workflow) ||
        isComfyH3SingleReferenceImageWorkflow(workflow) ||
        isComfyH3MultiReferenceVideoWorkflow(workflow) ||
        isComfyKrea2EditWorkflow(workflow)
    );
}

/**
 * The 群主版 "H3 prompt writer" LLM node (`ZealmanLLM_Generate`), which holds the user-facing
 * instruction in the Chinese field `提示词`.
 *
 * Deliberately exact: the sibling `ZealmanLLM_ModelLoader` is only the weights loader and must
 * never be treated as a generate target.
 */
function isComfyLlmGenerateNode(node: ComfyNode): boolean {
    return /^ZealmanLLM_Generate$/i.test(String(node?.class_type || ""));
}

/**
 * Structural fingerprint of the "群主版 Qwen3.8-VL H3 prompt writer" *text-output* family (U00).
 *
 * These graphs are not image/video pipelines at all: four `LoadImage` references feed a local
 * LLM node whose answer is displayed by a `ShowText|pysssss` sink. The app's native ComfyUI path
 * only knew how to collect images/videos, so a text graph used to look like a run that returned
 * nothing. Detect the family by shape — a `ZealmanLLM_Generate` node *and* a text sink — so a
 * graph missing either half keeps its previous (unchanged) behaviour.
 */
export function isComfyTextOutputWorkflow(workflow: ComfyWorkflow): boolean {
    const nodes = Object.values(workflow);
    if (!nodes.some((node) => isComfyLlmGenerateNode(node))) return false;
    return nodes.some((node) => /ShowText/i.test(String(node?.class_type || "")));
}

/**
 * Inject the user prompt into a native ComfyUI *text* workflow's LLM node.
 *
 * `applyComfyPrompt` keys off `PROMPT_FIELDS` / node titles, and neither `提示词` (the user
 * instruction) nor `系统提示词` (the family's own rewrite rules) is in that list — so the generic
 * writer leaves this graph untouched and its blind fallback could even append a bogus `text`
 * input. This writer is scoped to the detected text family and writes `提示词` only, never the
 * authored `系统提示词`. No other native ComfyUI workflow is affected.
 */
export function applyComfyTextPrompt(workflow: ComfyWorkflow, prompt: string): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    const value = String(prompt ?? "");
    for (const node of Object.values(next)) {
        if (!isComfyLlmGenerateNode(node) || !node.inputs || typeof node.inputs !== "object") continue;
        for (const field of ["提示词", "prompt", "text"]) {
            if (typeof node.inputs[field] === "string") {
                node.inputs[field] = value;
                break;
            }
        }
    }
    return next;
}

/**
 * Map uploaded references onto the image slots a text LLM node actually consumes.
 *
 * The shared `applyComfyLoadImages` spreads references over *every* `LoadImage` node in node-id
 * order, but a text graph only reads the loaders wired to its LLM node (`图片N` inputs). In the
 * U00 template only `图片4` is linked, so an id-order fill would hand the single upload to `图片1`
 * and leave the LLM reading the author's baked sample. Order by the numeric `图片N` suffix and
 * touch consumed slots only — unreachable `LoadImage` nodes are never executed by ComfyUI, so
 * their baked filenames are harmless and are deliberately left alone.
 */
export function applyComfyTextReferenceImages(workflow: ComfyWorkflow, filenames: string[]): ComfyWorkflow {
    if (!filenames.length) return workflow;
    const next = cloneWorkflow(workflow);
    const slots: Array<{ index: number; id: string }> = [];
    for (const node of Object.values(next)) {
        if (!isComfyLlmGenerateNode(node)) continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const key of Object.keys(inputs)) {
            const match = /^图片\s*(\d+)$/.exec(key);
            if (!match) continue;
            const link: unknown = inputs[key];
            if (!Array.isArray(link) || link[0] == null) continue;
            const id = String(link[0]);
            if (!next[id] || !isComfyImageLoader(next[id])) continue;
            slots.push({ index: Number(match[1]), id });
        }
        break;
    }
    slots.sort((a, b) => a.index - b.index);
    slots.forEach((slot, position) => {
        const name = filenames[position];
        if (!name) return;
        const loader = next[slot.id];
        if (!loader.inputs || typeof loader.inputs !== "object") loader.inputs = {};
        if ("image" in loader.inputs || !("url" in loader.inputs)) loader.inputs.image = name;
        else loader.inputs.url = name;
    });
    return next;
}

/**
 * Extra allow-list of workflows that map uploaded references by consumer slot order.
 *
 * The structural fingerprint above is the primary trigger; this list is only an escape hatch
 * for a graph whose shape stops matching (e.g. a single-pass rewrite) but whose
 * `ref_images.ref_image_N` wiring is known to be ordinal. Add a name only after verifying that
 * wiring — a wrong entry would scramble that workflow's references.
 */
export const COMFY_REFERENCE_SLOT_WORKFLOWS = [
    "U24-文武双修T8版MiniMaxH3双采参考生视频V2",
    // Same DualClock graph under the seetacloud model display name.
    "H3-video",
    "H3_video",
] as const;

/**
 * Every comparable spelling of a workflow option value: the whole string plus each
 * `::`-separated segment. Model options are stored as `<channelId>::<modelName>`
 * (see use-config-store CHANNEL_MODEL_SEPARATOR), so this matches whether the caller
 * passes the full value, the bare model name, or a prefixed variant.
 */
function comfyWorkflowKeys(value: string | undefined | null): string[] {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return [];
    const keys = new Set<string>([raw]);
    for (const part of raw.split("::")) {
        const segment = part.trim();
        if (segment) keys.add(segment);
    }
    return [...keys];
}

/** True only for allow-listed workflows that must use reference-slot (link) order. */
export function usesComfyReferenceSlotOrder(workflowId: string | undefined | null): boolean {
    const keys = comfyWorkflowKeys(workflowId);
    if (!keys.length) return false;
    const allowed = new Set(COMFY_REFERENCE_SLOT_WORKFLOWS.flatMap((item) => comfyWorkflowKeys(item)));
    return keys.some((key) => allowed.has(key));
}

/**
 * Filename a graph uses as its own "empty slot" placeholder (e.g. `zealman-blank-image.png`).
 *
 * On rented pods that file is usually missing or broken — DualClock must upload a real blank and
 * rewrite spare LoadImages to that uploaded name (never trust the authored string alone).
 */
function comfyBlankImagePlaceholder(workflow: ComfyWorkflow): string | null {
    for (const node of Object.values(workflow)) {
        if (!isComfyImageLoader(node)) continue;
        const name = node.inputs?.image;
        if (typeof name === "string" && /blank|empty|placeholder|transparent|^none\./i.test(name)) return name;
    }
    return null;
}

/** Author-machine LoadImage names that are not on seetacloud (V927 Untitled / snowtp / zealman). */
function isComfyAuthorLocalImageName(name: string) {
    return /blank|empty|placeholder|transparent|untitled|snowtp|^none\./i.test(String(name || ""));
}

/**
 * Solid 64×64 PNG for DualClock spare slots. A 1×1 blank triggered LoadImage
 * "Invalid argument returned 22" on seetacloud; keep the file small but large enough for PIL/H3.
 */
const COMFY_DUALCLOCK_BLANK_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAY0lEQVR42u3QQREAAAgDoEVfc83hyYMCpO18FgECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIOC+BYjT8kqKv7OUAAAAAElFTkSuQmCC";

function dualClockBlankPngDataUrl(): string {
    try {
        if (typeof document !== "undefined") {
            const canvas = document.createElement("canvas");
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.fillStyle = "#808080";
                ctx.fillRect(0, 0, 64, 64);
                return canvas.toDataURL("image/png");
            }
        }
    } catch {
        /* fall through */
    }
    return COMFY_DUALCLOCK_BLANK_PNG_DATA_URL;
}

/** Map uploaded filenames onto LoadImage nodes in order. */
export function applyComfyLoadImages(
    workflow: ComfyWorkflow,
    filenames: string[],
    workflowId?: string,
    options?: { blankFilename?: string },
): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    // Name allow-list OR structural fingerprint. Without the fingerprint a renamed model fell back
    // to node-id order and scrambled every reference (ref_image_0 got the last uploaded picture).
    // The single-pass multi-reference video family needs the *repaired* slot order: its export can
    // link one slot twice and orphan the loader the author meant to keep, so the verbatim order
    // would still shift every picture by one.
    const slotPlan = isComfyH3MultiReferenceVideoWorkflow(next) ? comfyMultiReferenceSlotPlan(next) : null;
    // U06 V8: always apply the slot rewire, even when the user uploaded no images. Leaving the
    // duplicated `ref_image_0`/`ref_image_1` → `加载图像2` wiring intact made Picture 1/2 share one
    // loader whenever generation ran without fresh uploads (early-return used to skip the repair).
    if (slotPlan) {
        const inputs = next[slotPlan.nodeId]?.inputs;
        for (const fix of slotPlan.rewire) {
            if (inputs && inputs[fix.key]) inputs[fix.key] = [fix.to, 0];
        }
    }
    if (!filenames.length) return slotPlan ? next : workflow;
    const slotOrder =
        usesComfyReferenceSlotOrder(workflowId) || isComfyH3TwoPassReferenceWorkflow(next)
            ? comfyReferenceSlotOrder(next)
            : slotPlan
              ? slotPlan.ordered
              : [];
    // When a template declares its own blank placeholder, the spare slots are meant to stay empty.
    // Repeating the last uploaded picture there (the legacy fallback) made the model see one
    // reference up to 8× — e.g. U24 V927 and U37 both expose 9 slots where only the first few are
    // real. Graphs without such a placeholder keep the legacy fill-up.
    // DualClock: ONLY the uploaded blank counts — never the authored zealman-blank string alone
    // (missing/broken file → LoadImage #94 "Invalid argument returned 22" on seetacloud).
    const twoPassRefs = isComfyH3TwoPassReferenceWorkflow(next);
    const uploadedBlank = (options?.blankFilename || "").trim();
    const blankSlot =
        uploadedBlank ||
        (!twoPassRefs && isComfyH3SelfLiftWorkflow(next) ? comfyBlankImagePlaceholder(next) : null);
    const loaders = slotOrder.length
        ? slotOrder.map((id) => next[id]).filter((node): node is ComfyNode => Boolean(node))
        : Object.entries(next)
              .filter(([, node]) => isComfyImageLoader(node))
              .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
              .map(([, node]) => node);
    // U24 DualClock: never delete spare `ref_images.ref_image_N` — MiniMaxH3AudioConditioningT8
    // then fails `/prompt` ("required input missing"). Never repeat the last large ref into spare
    // slots (OOM). Use the uploaded blank from runNativeComfyUiJob when present.
    const uploadedSet = new Set(filenames.filter(Boolean));
    loaders.forEach((node, index) => {
        const name =
            filenames[index] || blankSlot || (twoPassRefs && !blankSlot ? "" : filenames[filenames.length - 1]);
        if (!name) return;
        if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
        if ("image" in node.inputs || !("url" in node.inputs)) node.inputs.image = name;
        else node.inputs.url = name;
    });
    // DualClock: every LoadImage that is not one of the user's uploads must point at the uploaded
    // blank — including #94 zealman-blank and any Untitled/snowtp leftovers. Matching only
    // "author-local" names was too narrow if the pod still had a stale/broken filename.
    if (twoPassRefs && uploadedBlank) {
        for (const node of Object.values(next)) {
            if (!isComfyImageLoader(node)) continue;
            if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
            const field = "image" in node.inputs || !("url" in node.inputs) ? "image" : "url";
            const current = node.inputs[field];
            if (typeof current === "string" && uploadedSet.has(current)) continue;
            node.inputs[field] = uploadedBlank;
        }
    }
    return next;
}

const AUDIO_FILENAME_FIELDS = ["audio", "audio_path", "audio_file", "path", "file", "filename"];

function isComfyAudioLoader(node: ComfyNode) {
    const type = String(node?.class_type || "");
    const title = String(node?._meta?.title || "");
    if (/FromUrl|FromPath|FromBase64|LoadVideo|LoadImage/i.test(type)) return false;
    if (/LoadAudio|AudioLoader|VHS_LoadAudio|LoadAudioUpload|AudioLoad/i.test(type)) return true;
    if (/参考音频|音频|ref.?audio|load.?audio|audio.?ref/i.test(title)) {
        return AUDIO_FILENAME_FIELDS.some((field) => typeof node.inputs?.[field] === "string");
    }
    return false;
}

function writeComfyAudioFilename(node: ComfyNode, filename: string) {
    if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
    for (const field of AUDIO_FILENAME_FIELDS) {
        if (field in node.inputs && typeof node.inputs[field] === "string") {
            node.inputs[field] = filename;
            return;
        }
    }
    node.inputs.audio = filename;
}

/**
 * The graph's own "empty audio slot" placeholder (e.g. `zealman-blank-audio.mp3`), mirroring
 * `comfyBlankImagePlaceholder` on the audio side. Templates that expose more audio slots than they
 * expect to be filled park that same asset in the spare `LoadAudio` nodes.
 */
function comfyBlankAudioPlaceholder(workflow: ComfyWorkflow): string | null {
    for (const node of Object.values(workflow)) {
        if (!isComfyAudioLoader(node)) continue;
        for (const field of AUDIO_FILENAME_FIELDS) {
            const name = node.inputs?.[field];
            if (typeof name === "string" && /blank|empty|placeholder|silence|^none\./i.test(name)) return name;
        }
    }
    return null;
}

/**
 * Resolve the H3 conditioning node's declared `ref_audios.ref_audio_*` slots in **slot-index order**
 * (the order the node consumes them), never by node id — the author's slot wiring is what the model
 * reads, and id order can disagree with it.
 */
function minimaxH3AudioSlots(workflow: ComfyWorkflow) {
    const consumer = Object.values(workflow).find(
        (node) =>
            isMiniMaxH3ConditioningNode(node) &&
            node.inputs &&
            Object.keys(node.inputs).some((key) => key.startsWith("ref_audios.")),
    );
    if (!consumer?.inputs) return null;
    const slots = Object.entries(consumer.inputs)
        .map(([key, value]) => {
            const match = /^ref_audios\.ref_audio_(\d+)$/.exec(key);
            if (!match || !Array.isArray(value)) return null;
            return { index: Number(match[1]), loaderId: String(value[0]) };
        })
        .filter((slot): slot is { index: number; loaderId: string } => slot !== null)
        .sort((a, b) => a.index - b.index);
    return slots.length ? slots : null;
}

/**
 * MiniMax H3 **SelfLift 双采** (e.g. U37) audio path — scoped to that structural fingerprint.
 *
 * Its single `MiniMaxH3ReferenceToVideo` node declares only plain `ref_audios.ref_audio_*` inputs
 * (slot 0 = the author's own voice-timbre reference, slots 1–2 park `…blank-audio.mp3`). Two things
 * the generic writers get wrong here:
 *  - `applyComfyMiniMaxDriveAudio` stamps the Compshare contract (`drive_audio`, `final_audio`,
 *    `audio_mode`, …) onto the node, but its `execute()` declares none of those and rejects the whole
 *    submission — "got an unexpected keyword argument 'drive_audio'". This node consumes audio purely
 *    through the baked `ref_audios.*` references, so nothing needs inventing.
 *  - the generic loader pass repeats the *last* upload into every spare loader, feeding one canvas
 *    audio to the voice reference three times. Map uploads onto the declared slots in order and leave
 *    the trailing `…blank-audio…` placeholders exactly as authored (the same treatment the image side
 *    already gives U37's blank image slots).
 *
 * Returns `null` when the graph declares no `ref_audios.*` slot, so the caller can fall back.
 */
function applyComfySelfLiftAudios(workflow: ComfyWorkflow, filenames: string[]): ComfyWorkflow | null {
    const slots = minimaxH3AudioSlots(workflow);
    if (!slots) return null;
    const blank = comfyBlankAudioPlaceholder(workflow);
    slots.forEach((slot, position) => {
        const name = filenames[position] || blank;
        if (!name) return;
        const loader = workflow[slot.loaderId];
        if (loader) writeComfyAudioFilename(loader, name);
    });
    return workflow;
}

/** Map uploaded filenames onto LoadAudio nodes in order. */
export function applyComfyLoadAudios(workflow: ComfyWorkflow, filenames: string[]): ComfyWorkflow {
    if (!filenames.length) return workflow;
    const next = cloneWorkflow(workflow);
    // U37 SelfLift 双采 consumes audio only through its declared `ref_audios.*` references, and its
    // `execute()` rejects the Compshare `drive_audio` contract. Handle it on its own so neither the
    // generic loader fill-up (repeat last) nor the drive-audio writer ever touches it. Every other
    // graph keeps the previous path untouched.
    if (isComfyH3SelfLiftWorkflow(next)) {
        const selfLift = applyComfySelfLiftAudios(next, filenames);
        if (selfLift) return selfLift;
    }
    const loaders = Object.entries(next)
        .filter(([, node]) => isComfyAudioLoader(node))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([, node]) => node);
    loaders.forEach((node, index) => {
        const name = filenames[index] || filenames[filenames.length - 1];
        if (!name) return;
        writeComfyAudioFilename(node, name);
    });
    // MiniMax H3 graphs often have no LoadAudio — wire drive_audio / ref_audios instead.
    return applyComfyMiniMaxDriveAudio(next, filenames);
}

function isMiniMaxH3ConditioningNode(node: ComfyNode) {
    // MiniMax H3 exposes width/height/length on both the audio-conditioning and the
    // reference-to-video conditioning nodes (MiniMaxH3ReferenceToVideo / MiniMaxH3AudioConditioning*).
    return /MiniMaxH3(?:AudioConditioning|ReferenceToVideo|TextToVideo|VideoConditioning)/i.test(String(node?.class_type || ""));
}

/** The exact inputs the Compshare drive-audio contract writes onto an H3 conditioning node. */
const H3_AUDIO_DRIVING_FIELDS = [
    "drive_audio",
    "final_audio",
    "audio_mode",
    "add_source_as_reference",
    "prompt_primary_audio_ordinal",
];

/**
 * True for an H3 conditioning node that declares *some* audio-driving surface, i.e. the contract in
 * `applyComfyMiniMaxDriveAudio` has somewhere legitimate to land.
 *
 * The U06 「多图参考生视频」 `MiniMaxH3ReferenceToVideo` node declares none of these — only an
 * `audio_vae` for its own native track — yet the writer still stamped `drive_audio` onto it, and the
 * server's `MiniMaxH3ReferenceToVideo.execute()` rejects that keyword, failing the whole submission
 * before a single step ran. Gating on the node's own declared surface touches only nodes whose every
 * injected field would be an invention: Compshare's `MiniMaxH3AudioConditioningT8` declares
 * `audio_mode` / `add_source_as_reference` / `prompt_primary_audio_ordinal`, and any graph that wires
 * real `ref_audios.*` slots keeps the exact injection it had before.
 */
function isComfyMiniMaxAudioDrivingNode(node: ComfyNode) {
    if (!isMiniMaxH3ConditioningNode(node) || !node.inputs) return false;
    return Object.keys(node.inputs).some(
        (key) => key.startsWith("ref_audios.") || H3_AUDIO_DRIVING_FIELDS.includes(key),
    );
}

function nextComfyNodeId(workflow: ComfyWorkflow, prefix: string) {
    let index = 1;
    while (workflow[`${prefix}${index}`]) index += 1;
    return `${prefix}${index}`;
}

/**
 * Compshare MiniMax H3: inject canvas audio by adding LoadAudio nodes and linking
 * `drive_audio` / `ref_audios.ref_audio_*` on MiniMaxH3AudioConditioningT8.
 * When audio is provided, switch `audio_mode` away from `native` so the source is used.
 */
export function applyComfyMiniMaxDriveAudio(workflow: ComfyWorkflow, filenames: string[]): ComfyWorkflow {
    if (!filenames.length) return workflow;
    const next = cloneWorkflow(workflow);
    // Only inject where the node itself declares an audio-driving surface (see the helper). The U06
    // 「多图参考生视频」 `MiniMaxH3ReferenceToVideo` declares none and its `execute()` rejects
    // `drive_audio`, so stamping it there failed every submission with "got an unexpected keyword
    // argument 'drive_audio'". Nodes that do expose the surface keep the exact injection as before.
    const targets = Object.values(next).filter(isComfyMiniMaxAudioDrivingNode);
    // No node in this graph can consume audio, so the upload is unusable here. Leave the graph
    // exactly as authored instead of planting orphan `LoadAudio` nodes nothing links to.
    if (!targets.length) return next;

    const existingLoaders = Object.entries(next)
        .filter(([, node]) => isComfyAudioLoader(node))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

    const loaderIds: string[] = [];
    filenames.forEach((filename, index) => {
        if (!filename) return;
        let loaderId = existingLoaders[index]?.[0];
        if (loaderId) {
            writeComfyAudioFilename(next[loaderId], filename);
        } else {
            loaderId = nextComfyNodeId(next, "ia_audio_");
            next[loaderId] = {
                class_type: "LoadAudio",
                inputs: { audio: filename },
                _meta: { title: `Canvas Audio ${index + 1}` },
            };
        }
        loaderIds.push(loaderId);
    });

    if (!loaderIds.length) return next;
    const primary = loaderIds[0];

    for (const node of targets) {
        if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
        node.inputs.drive_audio = [primary, 0];
        node.inputs.final_audio = [primary, 0];
        loaderIds.forEach((id, index) => {
            node.inputs![`ref_audios.ref_audio_${index}`] = [id, 0];
        });
        // `native` ignores drive_audio and synthesizes sound — force lock when canvas audio exists.
        const mode = String(node.inputs.audio_mode || "");
        if (!mode || /^native$/i.test(mode)) {
            node.inputs.audio_mode = "lock_source";
        }
        node.inputs.add_source_as_reference = true;
        if (!node.inputs.prompt_primary_audio_ordinal || node.inputs.prompt_primary_audio_ordinal === 0) {
            node.inputs.prompt_primary_audio_ordinal = 1;
        }
    }
    return next;
}

const RESOLUTION_SELECTOR_ASPECTS: Array<{ ratio: string; label: string; value: number }> = [
    { ratio: "1:1", label: "1:1 (Square)", value: 1 },
    { ratio: "2:3", label: "2:3 (Portrait Photo)", value: 2 / 3 },
    { ratio: "3:2", label: "3:2 (Photo)", value: 3 / 2 },
    { ratio: "3:4", label: "3:4 (Portrait Standard)", value: 3 / 4 },
    { ratio: "4:3", label: "4:3 (Standard)", value: 4 / 3 },
    { ratio: "9:16", label: "9:16 (Portrait Widescreen)", value: 9 / 16 },
    { ratio: "16:9", label: "16:9 (Widescreen)", value: 16 / 9 },
    { ratio: "21:9", label: "21:9 (Ultrawide)", value: 21 / 9 },
];

function parseCanvasAspectRatio(size?: string): string {
    const raw = String(size || "").trim();
    if (!raw || /^auto|adaptive$/i.test(raw)) return "16:9";
    const named = raw.match(/^(\d+)\s*:\s*(\d+)/);
    if (named) return nearestAspectRatio(Number(named[1]) / Number(named[2]));
    const pixels = raw.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (pixels) return nearestAspectRatio(Number(pixels[1]) / Number(pixels[2]));
    return "16:9";
}

function nearestAspectRatio(ratio: number) {
    let best = RESOLUTION_SELECTOR_ASPECTS[6];
    let bestDiff = Infinity;
    for (const item of RESOLUTION_SELECTOR_ASPECTS) {
        const diff = Math.abs(ratio - item.value);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = item;
        }
    }
    return best.ratio;
}

function resolutionSelectorAspectLabel(ratio: string) {
    return RESOLUTION_SELECTOR_ASPECTS.find((item) => item.ratio === ratio)?.label || "16:9 (Widescreen)";
}

/** Map canvas quality to a long-side pixel target for video. */
function longSideFromQuality(vquality?: string) {
    const raw = String(vquality || "").trim().toLowerCase();
    if (!raw || raw === "auto" || raw === "medium") return 1280;
    if (/4k|2160|3840/.test(raw)) return 3840;
    if (/2k|1440|2560|high/.test(raw)) return 2560;
    // U06 V8 author long edge — must win over the generic `>= 1080 → 1920` numeric ladder.
    if (/^1376(?:p)?$/.test(raw)) return 1376;
    if (/1080|hd/.test(raw)) return 1920;
    if (/720|sd/.test(raw)) return 1280;
    if (/480|low/.test(raw)) return 854;
    const numeric = Number(raw.replace(/p$/i, ""));
    if (Number.isFinite(numeric) && numeric > 0) {
        if (numeric >= 3000) return 3840;
        if (numeric >= 2000) return 2560;
        if (numeric === 1376) return 1376;
        if (numeric >= 1080) return 1920;
        if (numeric >= 720) return 1280;
        return 854;
    }
    return 1280;
}

function pixelsFromSizeAndQuality(size?: string, vquality?: string) {
    const ratioLabel = parseCanvasAspectRatio(size);
    const aspect = RESOLUTION_SELECTOR_ASPECTS.find((item) => item.ratio === ratioLabel) || RESOLUTION_SELECTOR_ASPECTS[6];
    const longSide = longSideFromQuality(vquality);
    const snap = (value: number) => Math.max(64, Math.round(value / 32) * 32);
    if (aspect.value >= 1) {
        return { width: longSide, height: snap(longSide / aspect.value), ratio: ratioLabel };
    }
    return { width: snap(longSide * aspect.value), height: longSide, ratio: ratioLabel };
}

function megapixelsFromPixels(width: number, height: number) {
    return Math.max(0.1, Math.min(16, Math.round(((width * height) / 1_000_000) * 100) / 100));
}

/**
 * True when the canvas size is an actual user choice rather than the "auto"/empty sentinel.
 *
 * The canvas Size control offers "auto" plus concrete ratios, and the global default is a pixel
 * string ("2048x1152"). "auto"/"" must leave the workflow's own baked geometry alone, so callers
 * gate any canvas-driven override on this.
 */
function isExplicitCanvasSize(size?: string): boolean {
    const raw = String(size || "").trim();
    return Boolean(raw) && !/^(?:auto|adaptive)$/i.test(raw);
}

/**
 * Reshape an H3 node's authored canvas to the user's canvas size.
 *
 * The U33 template bakes a square 2048×2048 straight onto its MiniMax H3 node, so the canvas
 * ratio is ignored and every run comes back square regardless of what the user picked. Anchoring
 * the reshape on the *author's own long edge* fixes that without ever inflating past the geometry
 * the author tuned (a 1:1 request therefore returns the template's own 2048×2048 verbatim), and an
 * explicit `WxH` string is honored literally. Everything snaps to a multiple of 32, which ComfyUI
 * latents require.
 */
function shapeH3CanvasToSize(bakedWidth: number, bakedHeight: number, size: string) {
    const snap = (value: number) => Math.max(64, Math.round(value / 32) * 32);
    const explicit = size.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (explicit) return { width: snap(Number(explicit[1])), height: snap(Number(explicit[2])) };
    const ratio = parseCanvasAspectRatio(size);
    const aspect = RESOLUTION_SELECTOR_ASPECTS.find((item) => item.ratio === ratio)?.value || 1;
    const longEdge = snap(Math.max(bakedWidth, bakedHeight));
    return aspect >= 1
        ? { width: longEdge, height: snap(longEdge / aspect) }
        : { width: snap(longEdge * aspect), height: longEdge };
}

/**
 * Reshape the *linked* canvas of the U06 「h3_多图参考生视频」 family (see
 * `isComfyH3MultiReferenceVideoWorkflow`).
 *
 * That graph parks its delivered size in a separate size holder — a `WJILatentPreset` node whose
 * `自定义宽`/`自定义高` are the only thing the H3 node consumes (its `width`/`height` are *links* into
 * it, and the preset's own latent output goes nowhere). So `shapeH3CanvasToSize` on the H3 node has
 * no scalar to move and the app's size/ratio control was silently dead: every run delivered the
 * author's baked 1376×768 (43:24) regardless of the canvas.
 *
 * Follow the links one hop to the holder and rewrite its authoring fields instead. Always anchored
 * on the holder's *own* baked long edge — never the canvas's absolute `WxH`. The app default
 * (`2048x1152`) is an "explicit" size, and feeding it through `shapeH3CanvasToSize`'s literal WxH
 * path used to inflate V8 from 1376×768 to 2048×1152 (~2.25× pixels) and OOM the pod. A 16:9
 * canvas against the author's 16:9 bake stays byte-identical; only the *ratio* changes the shape.
 * The sole quality override this family accepts is the explicit `1376` long-edge tier (the author
 * bake); generic 1080/2k must not inflate the preset. The preset is pinned to custom mode so the
 * rewritten dimensions are the ones that actually apply.
 */
function reshapeLinkedH3Canvas(
    workflow: ComfyWorkflow,
    widthLink: unknown,
    heightLink: unknown,
    size: string,
    vquality?: string,
): void {
    const holders = new Set<string>();
    for (const link of [widthLink, heightLink]) {
        if (Array.isArray(link) && link[0] != null) holders.add(String(link[0]));
    }
    const snap = (value: number) => Math.max(64, Math.round(value / 32) * 32);
    const aspectFromSize = (() => {
        const explicit = String(size || "")
            .trim()
            .match(/^(\d+)\s*[x×]\s*(\d+)$/i);
        if (explicit) {
            const w = Number(explicit[1]);
            const h = Number(explicit[2]);
            if (w > 0 && h > 0) return w / h;
        }
        const ratio = parseCanvasAspectRatio(size);
        return RESOLUTION_SELECTOR_ASPECTS.find((item) => item.ratio === ratio)?.value || 0;
    })();
    // Only the dedicated U06 "1376" quality pill may replace the baked long edge; every other
    // vquality keeps the author's pixel budget so 1080/2k cannot OOM this family.
    const qualityLong = /^1376(?:p)?$/i.test(String(vquality || "").trim()) ? 1376 : 0;
    for (const id of holders) {
        const holder = workflow[id];
        if (!holder?.inputs || typeof holder.inputs !== "object") continue;
        // `WJILatentPreset` keeps its authoring fields in Chinese; other size holders use width/height.
        const fields: [string, string] =
            typeof holder.inputs["自定义宽"] === "number" && typeof holder.inputs["自定义高"] === "number"
                ? ["自定义宽", "自定义高"]
                : ["width", "height"];
        const bakedWidth = Number(holder.inputs[fields[0]]);
        const bakedHeight = Number(holder.inputs[fields[1]]);
        if (!(bakedWidth > 0) || !(bakedHeight > 0)) continue;
        const aspect = aspectFromSize > 0 ? aspectFromSize : bakedWidth / bakedHeight;
        const longEdge = snap(qualityLong > 0 ? qualityLong : Math.max(bakedWidth, bakedHeight));
        const shaped =
            aspect >= 1
                ? { width: longEdge, height: snap(longEdge / aspect) }
                : { width: snap(longEdge * aspect), height: longEdge };
        if (!writeComfyNumberInput(holder, fields[0], shaped.width)) continue;
        writeComfyNumberInput(holder, fields[1], shaped.height);
        writeComfyStringInput(holder, "预设分辨率", "自定义");
    }
}

/**
 * The learned-latent-upscale factor of a two-pass H3 graph (the `scale_by` knob, normally wired to
 * a `PrimitiveFloat` titled 2采放大倍率), or null when the graph has no ratio upscale.
 *
 * The HIGH refine pass runs at the LOW draft resolution times this factor (0.4 MP draft × 1.5 =
 * 0.9 MP refine in the V2 template), so it is what converts a canvas *delivered* budget into a
 * *draft* budget. Returning null keeps the caller from guessing a factor it could not read.
 */
function h3LatentUpscaleFactor(workflow: ComfyWorkflow): number | null {
    for (const node of Object.values(workflow)) {
        if (!/LatentUpscale/i.test(String(node?.class_type || ""))) continue;
        const inputs = node?.inputs;
        if (!inputs) continue;
        // U24 T8: `size_mode=scale_by` + `scale_by`. U30 Singularity: `mode=scale by multiplier` +
        // `mode.scale` (easy float). `target_size` / non-scale modes fix the refine resolution
        // themselves — only a scale multiplier converts a delivered canvas budget into a draft.
        const sizeMode = String(inputs.size_mode ?? "").trim().toLowerCase();
        const mode = String(inputs.mode ?? "").trim().toLowerCase();
        if (sizeMode && sizeMode !== "scale_by") continue;
        if (!sizeMode && mode && !/scale\s*by|multiplier/i.test(mode)) continue;
        const raw = inputs.scale_by ?? inputs["mode.scale"];
        if (typeof raw === "number" && raw > 0) return raw;
        if (Array.isArray(raw) && raw[0] != null) {
            const source = workflow[String(raw[0])]?.inputs as Record<string, unknown> | undefined;
            for (const key of ["value", "float", "number", "Number", "int"]) {
                const value = Number(source?.[key]);
                if (Number.isFinite(value) && value > 0) return value;
            }
        }
    }
    return null;
}

function parseCanvasSeconds(seconds?: string | number) {
    const value = typeof seconds === "number" ? seconds : Number(String(seconds || "").trim());
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.max(1, Math.min(30, value));
}

/** MiniMax H3 frame length from seconds @24fps, snapped to 17n+5. */
function h3LengthFromSeconds(seconds: number) {
    const frames = Math.max(5, Math.round(seconds * 24));
    return frames + ((5 - (frames % 17)) % 17);
}

/**
 * The duration the graph's **author** baked in, in seconds — the upstream duration float that feeds
 * the H3 frame-length formula (`length` → ComfyMathExpression → `values.a`).
 *
 * This is the anchor for the two-pass duration guard. That guard exists to keep long clips off
 * rented cards, but it must never clamp *below the graph's own default run*: a template whose baked
 * default is 20 s would otherwise be forced to 10 s even when the operator asks for 15 s, so the app
 * silently delivers less than a plain default run would.
 */
function h3AuthoredDurationSeconds(workflow: ComfyWorkflow): number | null {
    const readNumber = (value: unknown): number | null => {
        if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
        if (Array.isArray(value) && value[0] != null) {
            const source = workflow[String(value[0])]?.inputs as Record<string, unknown> | undefined;
            for (const key of ["value", "float", "number", "Number", "int"]) {
                const n = Number(source?.[key]);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        return null;
    };
    // Preferred: follow the H3 `length` link (length → math expression → seconds float).
    for (const node of Object.values(workflow)) {
        if (!isMiniMaxH3ConditioningNode(node)) continue;
        const inputs = node?.inputs as Record<string, unknown> | undefined;
        if (!inputs) continue;
        const lengthLink = inputs.length;
        if (!Array.isArray(lengthLink) || lengthLink[0] == null) {
            // A scalar `length` is already in frames.
            const frames = Number(lengthLink);
            if (Number.isFinite(frames) && frames > 0) return frames / 24;
            continue;
        }
        const mathInputs = workflow[String(lengthLink[0])]?.inputs as Record<string, unknown> | undefined;
        const seconds = readNumber(mathInputs?.["values.a"] ?? mathInputs?.a);
        if (seconds != null) return seconds;
    }
    // Fallback: a standalone float/int the author titled for the duration.
    for (const node of Object.values(workflow)) {
        const type = String(node?.class_type || "");
        const title = String(node?._meta?.title || "");
        if (!/Primitive(Float|Int|Number)|Float|Int/i.test(type)) continue;
        if (!/duration|时长/i.test(title)) continue;
        const value = Number((node?.inputs as Record<string, unknown> | undefined)?.value);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
}

function writeComfyNumberInput(node: ComfyNode, field: string, nextValue: number) {
    if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
    const current = node.inputs[field];
    if (typeof current === "number") {
        node.inputs[field] = nextValue;
        return true;
    }
    if (typeof current === "string" && /^-?\d+(\.\d+)?$/.test(current.trim())) {
        node.inputs[field] = String(nextValue);
        return true;
    }
    return false;
}

function writeComfyStringInput(node: ComfyNode, field: string, nextValue: string) {
    if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
    const current = node.inputs[field];
    if (typeof current === "string") {
        node.inputs[field] = nextValue;
        return true;
    }
    return false;
}

/** Parse sampling steps (empty → null, invalid → null). Clamped to 1..10000 (BasicScheduler range). */
function parseComfySteps(value?: string | number) {
    const raw = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.max(1, Math.min(10000, Math.round(raw)));
}

/** Normalize MiniMax H3 ref_image_size (only accepts "match" / "max"; otherwise null). */
function normalizeH3RefImageSize(value?: string) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "match" || raw === "max") return raw;
    return null;
}

/** Normalize a free-text ComfyUI combo value (trim; empty → null). */
function normalizeComfyCombo(value?: string) {
    const raw = String(value ?? "").trim();
    return raw || null;
}

function writeLinkedComfyNumber(workflow: ComfyWorkflow, value: unknown, nextValue: number): boolean {
    if (!Array.isArray(value) || value[0] == null) return false;
    const source = workflow[String(value[0])];
    if (!source?.inputs) return false;
    for (const key of ["value", "int", "number", "Number", "float"]) {
        if (writeComfyNumberInput(source, key, nextValue)) return true;
    }
    return false;
}

/**
 * Inject canvas aspect / megapixels / duration into native ComfyUI graphs
 * (ResolutionSelector + duration PrimitiveFloat + MiniMax H3 width/height/length).
 */
export function applyComfyVideoSettings(
    workflow: ComfyWorkflow,
    settings: {
        size?: string;
        seconds?: string | number;
        vquality?: string;
        steps?: string | number;
        refImageSize?: string;
        samplerName?: string;
        scheduler?: string;
        /**
         * Geometry-locked graphs keep the resolution knobs the workflow author tuned: the
         * multi-reference H3 "two-pass" video family (ResolutionSelector megapixels) and the
         * single-reference H3 image family (the H3 node's own width/height). See both branches
         * below; every other graph is untouched.
         */
        keepTunedResolution?: boolean;
        /**
         * U33 single-reference H3 image family only: the template bakes a *square* canvas onto its
         * H3 node, so the user's canvas size/ratio is otherwise ignored and every run is square.
         * When set together with an explicit canvas size, reshape that baked canvas to the user's
         * ratio (see `shapeH3CanvasToSize`) instead of freezing it. Every other geometry-locked
         * family keeps `keepTunedResolution` semantics untouched.
         */
        reshapeCanvas?: boolean;
        /**
         * U24 two-pass H3 *video* family. Being this family has two consequences:
         *  - the canvas must drive the delivered video, which needs both halves of the
         *    ResolutionSelector to follow it (see the branch below) — the draft budget is the canvas
         *    budget divided by the learned upscaler's `scale_by`², which lands the "auto" tier back
         *    on the author's own draft, so the default run stays the author's render;
         *  - the author's *coupled dual-clock sampling contract* must survive: the generic steps /
         *    sampler / scheduler writers reach `MiniMaxH3DualClockSamplerT8` purely by accident
         *    (`DualCloc` + `kSampler` reads as "KSampler" under a case-insensitive match), and
         *    overwriting `dual_clock_euler` with a plain combo value — or resteps-ing a distilled
         *    4-step schedule whose sigmas come from the learned two-pass parity plan — breaks the
         *    pipeline rather than tuning it.
         * Every other graph keeps the old behaviour untouched.
         */
        twoPassH3Video?: boolean;
        /**
         * U30 Singularity 超双采放大 family only (see `isComfyH3SingularityUpscaleWorkflow`).
         * Same draft-vs-delivered math as `twoPassH3Video` (ResolutionSelector × LatentUpscaler3D
         * scale), but the graph has a single H3 conditioning node rather than DualClock — so it
         * must not ride the U35 "selector = delivered" path. Sampling stays author-locked
         * (`euler` + BasicScheduler steps=6).
         */
        singularityH3Video?: boolean;
        /**
         * U37 SelfLift 双采 family only (see `isComfyH3SelfLiftWorkflow`). Unlike every other
         * geometry-locked family, this graph's `ResolutionSelector` is not a draft knob: the H3
         * node's width/height are *links* into it and `SelfLiftH3Sampler` splits that single target
         * into its internally-scaled low-res pass — so the selector is the *delivered* resolution
         * and resolving it from the canvas is what makes the size/ratio control work at all.
         * Only an explicit canvas size (`auto`/empty keeps the author's 9:16 @2MP) writes it.
         * Also locks the author's sampling contract (`KSamplerSelect=euler`, BasicScheduler
         * steps/scheduler untouched) — SelfLift hard-rejects any non-Euler sampler. Confined to
         * this family, so U24/U06/T10 and every other graph keep the exact geometry/sampling they
         * have today.
         */
        selfLiftH3Video?: boolean;
        /**
         * U06 single-pass multi-reference H3 *video* family only (see
         * `isComfyH3MultiReferenceVideoWorkflow`). Its canvas is not on the H3 node: `width`/`height`
         * are *links* into a separate size holder (the `WJILatentPreset`, whose own latent output
         * nothing consumes), so the geometry writers never found a scalar to move and the app's
         * size/ratio control was dead — every run delivered the author's baked 1376×768 no matter
         * what the canvas said. Reshape that linked holder instead (see `reshapeLinkedH3Canvas`).
         * Only an explicit canvas size writes it, anchored on the author's own long edge so the pixel
         * budget is unchanged; "auto"/empty (and the untouched "16:9" default) stays byte-identical.
         * Also locks the author's sampling contract: V8 ships `KSamplerSelect=er_sde` +
         * `ManualSigmas`, and the canvas default (`dpmpp_2m`) must not clobber that combo.
         */
        multiRefH3Video?: boolean;
        /**
         * U35 官流 family only (see `isComfyH3ResolutionSelectorVideoWorkflow`). Same single-pass
         * multi-ref shape as U06, but the delivered size lives on a linked `ResolutionSelector`
         * (not `WJILatentPreset`). Drive that selector from an explicit canvas size — same contract
         * as SelfLift's delivered-resolution branch — and leave sampling (`er_sde` + ManualSigmas /
         * authored BasicScheduler) alone. Confined to this fingerprint.
         */
        resolutionSelectorH3Video?: boolean;
    },
): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    const pixels = pixelsFromSizeAndQuality(settings.size, settings.vquality);
    const megapixels = megapixelsFromPixels(pixels.width, pixels.height);
    const aspectLabel = resolutionSelectorAspectLabel(pixels.ratio);
    // Two-pass H3 video: the VRAM guard keeps long clips off rented cards, but it is anchored on the
    // graph's own baked duration so it can never reach below what a default run already produces
    // (see `h3AuthoredDurationSeconds`). Without that anchor the V927 template — which bakes 20 s —
    // silently clamped every operator request down to 10 s, so a 15 s pick came back as 10 s.
    const parsedSeconds = parseCanvasSeconds(settings.seconds);
    const seconds =
        settings.twoPassH3Video && parsedSeconds != null
            ? Math.min(parsedSeconds, Math.max(TWO_PASS_H3_MAX_SECONDS, h3AuthoredDurationSeconds(next) ?? 0))
            : parsedSeconds;

    // Sampling steps for scheduler nodes (BasicScheduler / KSampler / Scheduler steps).
    const steps = parseComfySteps(settings.steps);
    // MiniMax H3 reference image sizing (match / max) — only applied to H3 conditioning nodes.
    const refImageSize = normalizeH3RefImageSize(settings.refImageSize);
    const samplerName = normalizeComfyCombo(settings.samplerName);
    const scheduler = normalizeComfyCombo(settings.scheduler);

    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        const title = String(node._meta?.title || "");
        if (!node.inputs || typeof node.inputs !== "object") continue;

        if (/ResolutionSelector/i.test(type) || /分辨率/i.test(title)) {
            const authoredMegapixels = typeof node.inputs.megapixels === "number" ? node.inputs.megapixels : null;
            if (settings.twoPassH3Video || settings.singularityH3Video) {
                // U24 DualClock two-pass, and U30 Singularity 超双采放大. The selector drives the
                // *cheap LOW draft* only — the HIGH / upscaled pass is that draft times the learned
                // upscaler's factor — so the canvas budget has to be divided by factor² before it
                // can stand in for the delivered resolution. U30 must NOT use the U35 "write full
                // MP" path or the draft is inflated and then multiplied again by 1.5².
                if (isExplicitCanvasSize(settings.size) && "aspect_ratio" in node.inputs) {
                    node.inputs.aspect_ratio = aspectLabel;
                }
                const scale = h3LatentUpscaleFactor(next);
                if (authoredMegapixels != null && scale != null && "megapixels" in node.inputs) {
                    // The canvas budget is the DELIVERED target; the selector only drives the cheap LOW
                    // draft that the learned upscaler multiplies by `scale` on the refine pass, so the
                    // budget is divided by scale² to become a draft. Measuring the guard on the
                    // *delivered* megapixels (not the draft) keeps it independent of each template's
                    // factor: 720p / 1080p / 2K each land exactly on the canvas tier and only the
                    // infeasible 4K tier is clamped back to ≈2K. A draft-numbered cap WAS the bug — the
                    // shipped 0.7 silently delivered ≈1.0 MP (720p) for every tier, and it could not be
                    // shared across templates anyway (0.95 was tuned for a ×1.5 sibling, but V927 ships
                    // ×1.2, so 0.95 would have landed 1080p at ≈1.37 MP, still short).
                    const deliveredBudget = Math.min(megapixels, TWO_PASS_H3_MAX_DELIVERED_MEGAPIXELS);
                    const draft = Math.max(0.1, Math.round((deliveredBudget / (scale * scale)) * 100) / 100);
                    // Never pull below the author's own tuned draft (U24 0.5 / U30 0.7), mirroring the
                    // duration guard's "never clamp below a default run" contract.
                    const nextMegapixels = Math.max(authoredMegapixels, draft);
                    writeComfyNumberInput(node, "megapixels", nextMegapixels);
                }
            } else if (settings.selfLiftH3Video || settings.resolutionSelectorH3Video) {
                // Delivered-resolution families whose H3 width/height link into a ResolutionSelector:
                // U37 SelfLift 双采, and U35 官流 (e.g. 终极版-神棍). Freezing the selector under
                // `keepTunedResolution` made canvas size/ratio dead. Drive both halves from the
                // canvas when — and only when — the canvas carries an explicit size; "auto"/empty
                // keeps the author's own geometry verbatim. Scoped to these fingerprints.
                if (isExplicitCanvasSize(settings.size)) {
                    if ("aspect_ratio" in node.inputs) node.inputs.aspect_ratio = aspectLabel;
                    if ("megapixels" in node.inputs) writeComfyNumberInput(node, "megapixels", megapixels);
                }
            } else if (settings.keepTunedResolution) {
                // Geometry-locked graphs (H3 two-pass family): the HIGH refine pass takes its size from a
                // fixed learned upscaler (target_width/height on the upscale node), so the
                // ResolutionSelector only drives the cheap LOW draft pass — and the author tunes that
                // draft deliberately small (0.4 MP in the U24/T8 template). Rewriting it with the canvas
                // budget (auto quality → 0.94 MP) made the draft as heavy as the refine pass and pushed a
                // 24 GB card over its limit ("allocation would exceed allowed memory"). Keep the saved
                // aspect and never inflate `megapixels`.
                if (authoredMegapixels == null && "aspect_ratio" in node.inputs) node.inputs.aspect_ratio = aspectLabel;
                if ("megapixels" in node.inputs) {
                    writeComfyNumberInput(node, "megapixels", authoredMegapixels == null ? megapixels : Math.min(megapixels, authoredMegapixels));
                }
            } else {
                if ("aspect_ratio" in node.inputs) node.inputs.aspect_ratio = aspectLabel;
                if ("megapixels" in node.inputs) writeComfyNumberInput(node, "megapixels", megapixels);
            }
        }

        if (seconds != null && (/duration|时长|seconds/i.test(title) || (/Primitive(Float|Int|Number)/i.test(type) && /duration|时长/i.test(title)))) {
            writeComfyNumberInput(node, "value", seconds);
        }
    }

    // Sampling steps: BasicScheduler / KSampler expose an integer `steps` field. Never for the
    // two-pass H3 video family — its steps are coupled to the learned parity plan, and the match
    // here is accidental anyway (`MiniMaxH3DualCloc` + `kSampler` reads as "KSampler" when the
    // comparison is case-insensitive). Same lock for SelfLift / U35 官流 / U06 multi-ref: those
    // graphs ship author-tuned schedules (`ManualSigmas` and/or a baked BasicScheduler) that the
    // canvas default (40 / karras) must not clobber.
    const lockAuthoredSampling = Boolean(
        settings.twoPassH3Video ||
            settings.singularityH3Video ||
            settings.selfLiftH3Video ||
            settings.multiRefH3Video ||
            settings.resolutionSelectorH3Video,
    );
    if (steps != null && !lockAuthoredSampling) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            // DualClockSamplerT8 class name contains the substring "kSampler" (…Clock + Sampler…);
            // never rewrite its coupled steps/shift contract even if the family lock is off.
            if (isComfyDualClockSamplerNode(node)) continue;
            if (!/BasicScheduler|KSampler|Scheduler/i.test(type) || !node.inputs) continue;
            if ("steps" in node.inputs) writeComfyNumberInput(node, "steps", steps);
        }
    }

    // Scheduler (BasicScheduler.scheduler) — string combo.
    if (scheduler && !lockAuthoredSampling) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            if (isComfyDualClockSamplerNode(node)) continue;
            if (!/BasicScheduler|Scheduler/i.test(type) || !node.inputs) continue;
            if ("scheduler" in node.inputs) writeComfyStringInput(node, "scheduler", scheduler);
        }
    }

    // Sampler name (KSamplerSelect.sampler_name) — string combo. Blocked for the two-pass H3 video
    // family: its sampler is the custom `dual_clock_euler` enum, and the match here is accidental
    // (`MiniMaxH3DualCloc` + `kSampler` reads as "KSampler"), so writing a generic combo value would
    // be a hard validation error rather than a tweak.
    // SelfLift 双采 family: `SelfLiftH3Sampler` hard-requires the standard Euler sampler (see the
    // author's KSamplerSelect titled "Standard Euler · SelfLift required"). The canvas default
    // `dpmpp_2m` used to overwrite that `euler` and fail the run with
    // "SelfLift requires the standard Euler sampler". Keep / restore euler only for this family.
    // U06 / U35 multi-reference video families: ship `er_sde` paired with a fixed `ManualSigmas`
    // schedule — overwriting with the canvas default breaks that contract. Leave the author's
    // sampler untouched (do not force a value; just skip the generic write).
    if (settings.selfLiftH3Video) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            if (!/KSamplerSelect/i.test(type) || !node.inputs) continue;
            if ("sampler_name" in node.inputs) writeComfyStringInput(node, "sampler_name", "euler");
        }
    } else if (samplerName && !lockAuthoredSampling) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            if (isComfyDualClockSamplerNode(node)) continue;
            if (!/KSamplerSelect|KSampler/i.test(type) || !node.inputs) continue;
            if ("sampler_name" in node.inputs) writeComfyStringInput(node, "sampler_name", samplerName);
        }
    }

    // Text-to-image latent nodes (EmptySD3LatentImage / EmptyLatentImage / EmptySDXL...) expose
    // scalar width/height. Inject canvas dimensions so aspect-ratio switching works for these graphs.
    // Geometry-locked graphs (Krea2 edit family) instead carry the author's canvas here — and the
    // image path passes no canvas size, so `pixels` is only the 16:9 @1280 fallback (1280×736 after
    // the 32-px snap) that would clobber that author size. Skip the write for them; every other
    // graph (which is not geometry-locked) still gets its canvas dimensions as before.
    if (!settings.keepTunedResolution) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            if (!/Empty(?:SD3|SDXL|Latent|FLUX|SD)?LatentImage/i.test(type) || !node.inputs) continue;
            if (writeComfyNumberInput(node, "width", pixels.width) || writeLinkedComfyNumber(next, node.inputs.width, pixels.width)) {
                writeComfyNumberInput(node, "height", pixels.height) || writeLinkedComfyNumber(next, node.inputs.height, pixels.height);
            }
        }
    }

    // MiniMax H3 conditioning often exposes width/height/length (scalar or linked) and ref_image_size.
    for (const node of Object.values(next)) {
        if (!isMiniMaxH3ConditioningNode(node) || !node.inputs) continue;
        // U06 single-pass multi-reference video family: its canvas is *not* on the H3 node — width and
        // height are links into a separate size holder — so the scalar writers above/below can never
        // reach it and the app's size/ratio control was dead. Reshape that linked holder instead (see
        // the helper); only an explicit canvas size writes it and the reshape preserves the author's
        // pixel budget, so the untouched default stays byte-identical. Scoped to this one family, so
        // U24/U37/U33 and every other graph keep the geometry handling around this block untouched.
        // Reshape on an explicit canvas size (ratio), or when the user picks the dedicated U06
        // "1376" long-edge tier — that pill must work even if size is still "auto".
        if (
            settings.multiRefH3Video &&
            (isExplicitCanvasSize(settings.size) || /^1376(?:p)?$/i.test(String(settings.vquality || "").trim()))
        ) {
            reshapeLinkedH3Canvas(
                next,
                node.inputs.width,
                node.inputs.height,
                String(settings.size || "16:9"),
                settings.vquality,
            );
        }
        // U33 single-reference H3 image family bakes a square canvas onto the node, so the user's
        // canvas size/ratio never took effect and every run came back square. When the canvas
        // carries an explicit size, reshape the baked canvas to it (anchored on the author's own
        // long edge so resolution is never inflated). "auto"/empty keeps the author's geometry, and
        // a graph whose width/height are *links* is left to its own family (U06 above routes those
        // into the linked size holder) rather than being guessed at here.
        if (
            settings.reshapeCanvas &&
            isExplicitCanvasSize(settings.size) &&
            typeof node.inputs.width === "number" &&
            typeof node.inputs.height === "number"
        ) {
            const shaped = shapeH3CanvasToSize(node.inputs.width, node.inputs.height, String(settings.size));
            writeComfyNumberInput(node, "width", shaped.width);
            writeComfyNumberInput(node, "height", shaped.height);
        } else if (!settings.keepTunedResolution && !settings.multiRefH3Video) {
            // Geometry-locked H3 families keep the width/height the author baked onto the node. The
            // image path passes no canvas size, so `pixels` is only the 16:9 @1280 fallback — writing it
            // would silently rewrite a 2048×2048 author size on every run.
            // U06 multi-ref: size lives on the linked WJILatentPreset rewritten above — never let the
            // generic linked-number writer touch that holder (or any fallback) for this family.
            if (!writeComfyNumberInput(node, "width", pixels.width)) writeLinkedComfyNumber(next, node.inputs.width, pixels.width);
            if (!writeComfyNumberInput(node, "height", pixels.height)) writeLinkedComfyNumber(next, node.inputs.height, pixels.height);
        }
        if (refImageSize && "ref_image_size" in node.inputs) {
            writeComfyStringInput(node, "ref_image_size", refImageSize);
        }
        if (seconds != null) {
            const length = h3LengthFromSeconds(seconds);
            if (!writeComfyNumberInput(node, "length", length)) {
                // Prefer writing the upstream duration float (seconds) when length is math-derived.
                const lengthLink = node.inputs.length;
                if (Array.isArray(lengthLink) && lengthLink[0] != null) {
                    const mathNode = next[String(lengthLink[0])];
                    const durationLink = mathNode?.inputs?.["values.a"] ?? mathNode?.inputs?.a;
                    if (!writeLinkedComfyNumber(next, durationLink, seconds)) {
                        writeLinkedComfyNumber(next, lengthLink, length);
                    }
                }
            }
        }
    }

    // Fallback: any standalone duration float/int titled for video length.
    if (seconds != null) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            const title = String(node._meta?.title || "");
            if (!/Primitive(Float|Int)|float|int/i.test(type)) continue;
            if (!/duration|时长|seconds|秒/i.test(title)) continue;
            writeComfyNumberInput(node, "value", seconds);
        }
    }

    return next;
}

/**
 * Canvas `<video>` only reliably plays browser-safe H.264/yuv420p MP4. Author templates often leave
 * VHS_VideoCombine on `image/gif`, `video/webm`, or an nvenc/ffmpeg variant that still lands a
 * `.mp4` filename but Chrome rejects at play() — the node looks ready then shows "无法播放".
 * Scoped to the U24 DualClock / H3-video family only (see call site).
 */
function applyBrowserSafeVhsFormat(workflow: ComfyWorkflow): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    for (const node of Object.values(next)) {
        const type = String(node?.class_type || "");
        if (!/VideoCombine/i.test(type) || !node.inputs || typeof node.inputs !== "object") continue;
        node.inputs.format = "video/h264-mp4";
        if ("pix_fmt" in node.inputs && typeof node.inputs.pix_fmt === "string") {
            node.inputs.pix_fmt = "yuv420p";
        }
    }
    return next;
}

/**
 * Structural repair for the U30 Singularity 超双采放大 family's `MinimaxH3LatentUpscaler3D`.
 *
 * The shipped export carries a **mis-mapped widget order**: the two BOOLEAN switches
 * `enable_temporal_chunking` / `force_unload` hold the strings `"cuda"` / `"bf16"` — which are the
 * values of the neighbouring `device` / `precision` widgets — while `precision` is `"fp16"` on a
 * node that loads `minimax_h3_latent_upscaler_3d_bf16.safetensors`.
 *
 * The node pack's own contract (LBH-123 ComfyUI-Easy-Media "Minimax H3 Latent Upscaler (3D)") is
 * `enable_temporal_chunking BOOLEAN True` / `force_unload BOOLEAN True` / `device cuda|rocm|cpu` /
 * `precision fp32|fp16|bf16`. The sibling U17 template (`…latent放大模型双采加速…`), which ships the
 * *same* node delivering ≈1080p (selector 0.9 MP × 1.5² ≈ 2.0 MP), ships `true / true / "cuda" /
 * "bf16"` and renders cleanly.
 *
 * Running the learned latent upscaler in fp16 against bf16 weights is the classic source of the
 * "画面花掉" the operator reports: the upscaler's latent activations leave fp16's usable range and
 * the decoded frames come back as noise. It is invisible at the author's small baked draft
 * (selector 0.7 MP → ≈1.6 MP delivered) and only appears once the canvas pushes the draft up —
 * i.e. exactly when 1080p / 2K is picked.
 *
 * Normalize the node to the pack's documented defaults, and only ever repair a value that is
 * plainly wrong, so a template that already ships sane values stays byte-identical. Scoped to the
 * Singularity fingerprint at the call site; every other native ComfyUI workflow is untouched.
 */
export function repairSingularityLatentUpscaler(workflow: ComfyWorkflow): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    for (const node of Object.values(next)) {
        if (!/MinimaxH3LatentUpscaler3D/i.test(String(node?.class_type || ""))) continue;
        if (!node.inputs || typeof node.inputs !== "object") continue;
        // BOOLEAN switches must be real booleans. Defaults are "on": temporal chunking lowers the
        // peak memory of long latents, force_unload frees VRAM for the following refine pass.
        if (typeof node.inputs.enable_temporal_chunking !== "boolean") node.inputs.enable_temporal_chunking = true;
        if (typeof node.inputs.force_unload !== "boolean") node.inputs.force_unload = true;
        // Inference precision must match the loaded checkpoint's dtype.
        const model = String(node.inputs.model_name || "");
        const precision = String(node.inputs.precision || "");
        if (/fp16/i.test(precision) && /bf16/i.test(model)) node.inputs.precision = "bf16";
        else if (/bf16/i.test(precision) && /fp16/i.test(model)) node.inputs.precision = "fp16";
        // Device must be a backend the pack knows; anything else silently falls back to a bad path.
        if (!/^(cuda|rocm|cpu)$/i.test(String(node.inputs.device || ""))) node.inputs.device = "cuda";
    }
    return next;
}

/** Random 64-bit-safe seed (same convention as the RunningHub workflow adapters). */
function randomComfySeed() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * Exported graphs bake a fixed `noise_seed`, so identical inputs render the *identical* video on
 * every run — the model looks frozen. Randomize per submission, mirroring the RunningHub
 * adapters. Only applied to the detected geometry-locked H3 families (see
 * `isComfyGeometryLockedWorkflow`); every other native ComfyUI model keeps its saved seed and
 * its reproducibility. `restart_seed` and friends are deliberately left alone — they are not the
 * sampling seed.
 *
 * Some templates park the seed in a separate node (e.g. the `easy seed` node) and *link*
 * `noise_seed` to it, so a flat numeric write finds nothing and the run stays frozen. Pass
 * `followLinkedSeed` to follow such a link one hop to its numeric `seed` / `noise_seed` source.
 * It is opt-in so the families that already randomize keep the exact same behaviour.
 */
export function applyComfyRandomSeed(
    workflow: ComfyWorkflow,
    options?: { followLinkedSeed?: boolean },
): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    for (const node of Object.values(next)) {
        const type = String(node.class_type || "");
        // `SelfLiftH3Sampler` is the U37 SelfLift 双采 sampler: it parks the run seed straight in
        // `seed`, but its class name contains no "KSampler" substring so the previous match never
        // reached it and that family replayed the identical video on every submission. Listed
        // explicitly, and only that family's graphs contain the type — no other model is touched.
        if (!/RandomNoise|SamplerCustom|KSampler|SelfLiftH3Sampler/i.test(type) || !node.inputs) continue;
        if (typeof node.inputs.noise_seed === "number") node.inputs.noise_seed = randomComfySeed();
        else if (typeof node.inputs.seed === "number") node.inputs.seed = randomComfySeed();
        else if (options?.followLinkedSeed) {
            for (const field of ["noise_seed", "seed"]) {
                const link = node.inputs[field];
                if (!Array.isArray(link) || link[0] == null) continue;
                const source = next[String(link[0])];
                if (!source?.inputs || typeof source.inputs !== "object") continue;
                if (writeComfyNumberInput(source, "seed", randomComfySeed())) break;
                if (writeComfyNumberInput(source, "noise_seed", randomComfySeed())) break;
            }
        }
    }
    return next;
}

async function referenceToUploadFile(
    dataUrlOrHttp: string,
    fileName: string,
    signal?: AbortSignal,
    fallbackType = "image/png",
): Promise<File> {
    if (dataUrlOrHttp.startsWith("data:")) {
        return dataUrlToFile({ id: fileName, name: fileName, dataUrl: dataUrlOrHttp, type: fallbackType });
    }
    if (/^https?:\/\//i.test(dataUrlOrHttp)) {
        const response = await axios.get(proxyApiUrl(dataUrlOrHttp), { responseType: "blob", signal });
        const blob = response.data as Blob;
        return new File([blob], fileName, { type: blob.type || fallbackType });
    }
    if (/^blob:/i.test(dataUrlOrHttp)) {
        const response = await fetch(dataUrlOrHttp, { signal });
        const blob = await response.blob();
        return new File([blob], fileName, { type: blob.type || fallbackType });
    }
    throw new Error("Unsupported ComfyUI reference media");
}

/**
 * Extra allow-list of workflows whose reference uploads go through the size guard.
 *
 * The geometry-locked H3 fingerprints (`isComfyGeometryLockedWorkflow`) are the primary trigger;
 * this list stays for workflows that are not those H3 graphs. Unlike the
 * reference-slot list, a wrong entry here is harmless (it only re-encodes an oversized image),
 * so the threshold for adding one is low — but it is still opt-in rather than global.
 */
export const COMFY_UPLOAD_GUARD_WORKFLOWS = [
    "U24-文武双修T8版MiniMaxH3双采参考生视频V2",
    "H3-video",
    "H3_video",
    "U06-minimax_h3_lightX2v多图参考生视频V5",
    "U06-h3_多图参考生视频V8",
    "U06-minimax_h3_多图参考生视频V8",
    "U35-H3官流-终极版-神棍",
    "U30-H3-Singularity超双采放大",
    "U30-Minimax-H3-Singularity超双采放大-AIGC特异点",
] as const;

/** True only for allow-listed workflows that must size-guard their reference uploads. */
export function usesComfyUploadGuard(workflowId: string | undefined | null): boolean {
    const keys = comfyWorkflowKeys(workflowId);
    if (!keys.length) return false;
    const allowed = new Set(COMFY_UPLOAD_GUARD_WORKFLOWS.flatMap((item) => comfyWorkflowKeys(item)));
    return keys.some((key) => allowed.has(key));
}

/**
 * Vercel serverless proxies cap request bodies at ~4.5MB, so a reference image over
 * that budget fails the multipart upload with HTTP 413 before ComfyUI ever sees it.
 * Unlike the JSON-body providers, the native path re-uploads reference bytes (including
 * remote-URL refs), so any oversized image must be shrunk before it goes on the wire.
 * Images already within budget are returned untouched.
 */
type ComfyUploadOptions = RequestOptions & { workflowId?: string; guardUpload?: boolean };

const COMFY_UPLOAD_BYTE_BUDGET = 2_400_000;
const COMFY_UPLOAD_MAX_EDGE = 1536;

async function shrinkOversizedUpload(file: File): Promise<File> {
    if (!file.type.startsWith("image/") || file.size <= COMFY_UPLOAD_BYTE_BUDGET) return file;
    try {
        const dataUrl = await blobToDataUrl(file);
        if (!dataUrl.startsWith("data:")) return file;
        const compressed = await compressReferenceDataUrl(dataUrl, 1, {
            maxEdge: COMFY_UPLOAD_MAX_EDGE,
            maxBytes: COMFY_UPLOAD_BYTE_BUDGET,
        });
        if (!compressed.startsWith("data:") || compressed === dataUrl) return file;
        const rebuilt = dataUrlToFile({ id: file.name, name: file.name, dataUrl: compressed, type: file.type });
        return rebuilt.size > 0 && rebuilt.size < file.size ? rebuilt : file;
    } catch {
        return file;
    }
}

/**
 * Read the stored-file name out of a ComfyUI /upload/image reply. ComfyUI answers
 * `{ name, subfolder, type }`; a bare filename string is tolerated for compatible servers.
 * Anything else (an HTML gateway page, an empty body) must NOT be accepted — the previous
 * `response.data?.name || response.data?.filename || file.name` fallback silently kept the
 * local name, so a wrong base URL looked like a successful upload and only blew up later as
 * an unexplained prompt rejection.
 */
function readComfyUploadName(payload: unknown): string {
    if (typeof payload === "string") {
        const text = payload.trim();
        return text && text.length <= 512 && !/[<>\r\n]/.test(text) ? text : "";
    }
    if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const value = record.name ?? record.filename;
        return typeof value === "string" ? value.trim() : "";
    }
    return "";
}

async function uploadComfyInputFile(
    baseUrl: string,
    apiKey: string,
    source: string,
    fileName: string,
    fallbackType: string,
    options?: ComfyUploadOptions,
): Promise<string> {
    const upload = await referenceToUploadFile(source, fileName, options?.signal, fallbackType);
    // Explicit flag (structural fingerprint, decided by the caller) wins over the name allow-list;
    // every other model is left untouched.
    const guarded = options?.guardUpload ?? usesComfyUploadGuard(options?.workflowId);
    const file = guarded ? await shrinkOversizedUpload(upload) : upload;
    const body = new FormData();
    // ComfyUI stores uploads under input/ via this endpoint for images and audio alike.
    body.append("image", file);
    body.append("overwrite", "true");
    const response = await comfyRequestWithGatewayRetry(
        () =>
            axios.post(comfyUiUrl(baseUrl, "/upload/image"), body, {
                headers: authHeaders(apiKey),
                signal: options?.signal,
            }),
        { signal: options?.signal, attempts: isFlakyComfyGatewayHost(baseUrl) ? 3 : 1, label: "ComfyUI /upload/image" },
    );
    const name = readComfyUploadName(response.data);
    if (!name) {
        const mime = String((response.headers as unknown as Record<string, unknown> | undefined)?.["content-type"] || "").split(";")[0].trim();
        const raw = typeof response.data === "string" ? response.data : response.data == null ? "" : JSON.stringify(response.data);
        const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 200);
        throw new Error(
            `ComfyUI /upload/image did not return a filename (HTTP ${response.status}${mime ? `, ${mime}` : ""})` +
                `${snippet ? `: ${snippet}` : ": the response body was empty"}. The Base URL is not answering as a ComfyUI API — verify the host/port (ComfyUI usually listens on 8188).`,
        );
    }
    return name;
}

export async function uploadComfyImage(
    baseUrl: string,
    apiKey: string,
    dataUrl: string,
    fileName: string,
    options?: ComfyUploadOptions,
): Promise<string> {
    return uploadComfyInputFile(baseUrl, apiKey, dataUrl, fileName, "image/png", options);
}

export async function uploadComfyAudio(
    baseUrl: string,
    apiKey: string,
    source: string,
    fileName: string,
    options?: ComfyUploadOptions,
): Promise<string> {
    const ext = /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(fileName) ? "" : ".mp3";
    return uploadComfyInputFile(baseUrl, apiKey, source, `${fileName}${ext}`, "audio/mpeg", options);
}

type HistoryOutputs = Record<
    string,
    {
        images?: Array<{ filename: string; subfolder?: string; type?: string }>;
        gifs?: Array<{ filename: string; subfolder?: string; type?: string }>;
        videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
        /** Text sink payload. ComfyUI flattens a node's `ui` dict into its output entry, so a
         *  `ShowText|pysssss` node lands here as `text: ["..."]`; some packs also nest it under
         *  `ui.text`. Both shapes are read. */
        text?: unknown;
        string?: unknown;
        ui?: { text?: unknown } | null;
    }
>;

/** Flatten the string (or string[]) payload a text-sink node reports. */
function pushComfyText(target: string[], value: unknown, depth = 0): void {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
        if (value.trim()) target.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) pushComfyText(target, item, depth + 1);
        return;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        pushComfyText(target, record.text, depth + 1);
        pushComfyText(target, record.string, depth + 1);
    }
}

/**
 * Text outputs from `/history` (`ShowText|pysssss` and friends).
 *
 * `collectMediaFromHistory` only understands images/gifs/videos, so a text-only graph used to look
 * like a graph that returned nothing at all. This reads the text payload of every output node,
 * tolerating both the flattened (`{ text: [...] }`) and the nested (`{ ui: { text: [...] } }`)
 * shape a text sink can report.
 */
function collectTextsFromHistory(outputs: HistoryOutputs | undefined): string[] {
    const texts: string[] = [];
    if (!outputs || typeof outputs !== "object") return texts;
    for (const node of Object.values(outputs)) {
        if (!node || typeof node !== "object") continue;
        pushComfyText(texts, node.text);
        pushComfyText(texts, node.ui?.text);
    }
    return texts;
}

/** True for a ComfyUI history filename that is a real playable video container (not a preview gif). */
function isComfyVideoFilename(filename: string) {
    return /\.(mp4|webm|mov|mkv)$/i.test(filename || "");
}

function collectMediaFromHistory(outputs: HistoryOutputs | undefined) {
    const images: Array<{ filename: string; subfolder: string; type: string }> = [];
    const videos: Array<{ filename: string; subfolder: string; type: string }> = [];
    if (!outputs || typeof outputs !== "object") return { images, videos };
    for (const node of Object.values(outputs)) {
        for (const item of node.images || []) {
            if (!item?.filename) continue;
            const entry = { filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output" };
            if (isComfyVideoFilename(item.filename)) videos.push(entry);
            else images.push(entry);
        }
        // VHS_VideoCombine parks animated *preview* stills in `gifs` (often `.gif` / `.webp`) while
        // the delivered clip is the `.mp4` in the same array (or in `videos`). Treating every `gifs`
        // entry as a video made the poll break as soon as a preview appeared, then
        // `pickPrimaryComfyVideo` fell back to that gif and stamped it `video/mp4` — the canvas
        // node looked ready but click-to-play failed. Only real video containers count here.
        for (const item of [...(node.gifs || []), ...(node.videos || [])]) {
            if (!item?.filename) continue;
            const entry = { filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output" };
            if (isComfyVideoFilename(item.filename)) videos.push(entry);
            else if (/\.(gif|webp|png|jpe?g)$/i.test(item.filename)) images.push(entry);
        }
    }
    return { images, videos };
}

/**
 * Pick the final delivered clip from a history media list.
 *
 * Preview / intermediate nodes often also land stubs in `gifs`; downloading every one through the
 * seetacloud proxy added minutes after the workflow had already finished. Prefer a real `.mp4`,
 * else the last playable container (VHS_VideoCombine is typically the terminal writer). Never fall
 * back to a non-video filename — that path produced unplayable canvas nodes.
 */
function pickPrimaryComfyVideo(
    videos: Array<{ filename: string; subfolder: string; type: string }>,
): { filename: string; subfolder: string; type: string } | null {
    const playable = videos.filter((item) => isComfyVideoFilename(item.filename));
    if (!playable.length) return null;
    const mp4s = playable.filter((item) => /\.mp4$/i.test(item.filename));
    const pool = mp4s.length ? mp4s : playable;
    return pool[pool.length - 1] || null;
}

/**
 * Reject empty / HTML / JSON / GIF bodies that proxies sometimes return with HTTP 200 for `/view`.
 * Without this check those bytes get force-typed as `video/mp4` and land on the canvas as a black,
 * unplayable node.
 */
function bufferHasFourcc(buf: Uint8Array, fourcc: string) {
    if (fourcc.length !== 4 || buf.length < 4) return false;
    const a = fourcc.charCodeAt(0);
    const b = fourcc.charCodeAt(1);
    const c = fourcc.charCodeAt(2);
    const d = fourcc.charCodeAt(3);
    for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) return true;
    }
    return false;
}

async function assertPlayableComfyVideoBlob(blob: Blob, mimeHint: string) {
    if (!blob || blob.size < 32) throw new Error("ComfyUI returned an empty video file");
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const asLatin = String.fromCharCode(...head);
    if (head[0] === 0x3c /* < */ || /^\s*</.test(asLatin)) {
        throw new Error("ComfyUI /view returned an HTML page instead of a video file (check the Base URL / proxy)");
    }
    if (head[0] === 0x7b /* { */ || head[0] === 0x5b /* [ */) {
        throw new Error("ComfyUI /view returned JSON instead of a video file");
    }
    // GIF87a / GIF89a — the classic VHS preview mis-labeled as mp4.
    if (asLatin.startsWith("GIF8")) {
        throw new Error("ComfyUI returned a GIF preview instead of the final MP4 — wait for the VHS output and retry");
    }
    const isFtyp = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70; // ....ftyp
    const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    const isRiff = asLatin.startsWith("RIFF");
    const hint = String(mimeHint || "").toLowerCase();
    if (hint.includes("webm")) {
        if (!isWebm) throw new Error("ComfyUI returned a file that is not a WebM video");
        return;
    }
    if (hint.includes("mp4") || hint.includes("quicktime") || !hint) {
        if (!isFtyp && !isRiff && !isWebm) {
            throw new Error("ComfyUI returned a file that is not a playable MP4/WebM video");
        }
        // Truncated proxy downloads often keep a valid ftyp head but lose the moov box — Chrome
        // then paints a black unplayable node. Probe both ends (moov may be fast-start or trailing).
        if (isFtyp && blob.size >= 64) {
            const probe = Math.min(blob.size, 512 * 1024);
            const headProbe = new Uint8Array(await blob.slice(0, probe).arrayBuffer());
            const tailProbe =
                blob.size > probe ? new Uint8Array(await blob.slice(blob.size - probe).arrayBuffer()) : headProbe;
            if (!bufferHasFourcc(headProbe, "moov") && !bufferHasFourcc(tailProbe, "moov")) {
                throw new Error("ComfyUI video download looks incomplete (missing moov atom) — retry the run");
            }
        }
    }
}

/**
 * Container sniff is not enough: VHS can write an `.mp4` whose codec/profile Chrome refuses
 * (yuv444, mpeg4-ASP, broken audio). Ask the browser to decode one frame before the canvas
 * accepts the clip, so failures surface at generate-time instead of a dead Play button.
 */
function assertBrowserCanDecodeVideo(blob: Blob, mimeHint: string): Promise<void> {
    if (typeof document === "undefined") return Promise.resolve();
    const typed =
        blob.type && blob.type.startsWith("video/")
            ? blob
            : blob.slice(0, blob.size, mimeHint.startsWith("video/") ? mimeHint : "video/mp4");
    const url = URL.createObjectURL(typed);
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            video.removeAttribute("src");
            try {
                video.load();
            } catch {
                // ignore
            }
            URL.revokeObjectURL(url);
            if (error) reject(error);
            else resolve();
        };
        const timer = window.setTimeout(
            () => finish(new Error("Browser could not decode the ComfyUI MP4 in time — check VHS format is video/h264-mp4")),
            12_000,
        );
        video.onloadeddata = () => {
            if (video.videoWidth > 0 || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
            else finish(new Error("ComfyUI returned an MP4 with no decodable video track"));
        };
        video.onerror = () =>
            finish(
                new Error(
                    "Browser cannot play this ComfyUI MP4 (codec/profile). Set VHS_VideoCombine format to video/h264-mp4 and retry.",
                ),
            );
        video.src = url;
    });
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
    const url = comfyUiUrl(baseUrl, `/view?${query.toString()}`);
    const headers = authHeaders(apiKey);
    const takeBlob = (response: { data: Blob; headers?: Record<string, unknown> }) => {
        const blob = response.data as Blob;
        const rawLen = response.headers?.["content-length"] ?? response.headers?.["Content-Length"];
        const expected = Number(rawLen);
        // Proxied DualClock mp4s that stop mid-stream still look like success to axios; reject
        // obviously truncated bodies before they become black canvas nodes.
        if (Number.isFinite(expected) && expected > 1024 && blob.size < expected * 0.9) {
            throw new Error(`ComfyUI video download truncated (${blob.size} / ${expected} bytes) — retry`);
        }
        return blob;
    };
    try {
        const response = await axios.get(url, { headers, responseType: "blob", signal: options?.signal });
        return takeBlob(response);
    } catch (error) {
        // Transient seetacloud / Vercel proxy 502s are common right after a heavy DualClock job
        // finishes (worker still restarting). One short retry absorbs that class of failure without
        // changing behaviour for any other status or host.
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status !== 502 && status !== 503) throw error;
        await sleep(1500, options?.signal);
        const retry = await axios.get(url, { headers, responseType: "blob", signal: options?.signal });
        return takeBlob(retry);
    }
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

/**
 * Explain why a `/prompt` submission came back without a prompt_id.
 *
 * The old message was a bare "ComfyUI did not return prompt_id", which is indistinguishable
 * between "the workflow was rejected", "the base URL is not ComfyUI", and "a gateway/WAF
 * answered with an HTML page" — three completely different fixes. Surface the status,
 * content type, an effective URL and a bounded body snippet instead. Never include the API
 * key: it lives in a header, not in this string.
 */
function describeComfySubmitFailure(args: { status: number; contentType: string; data: unknown; url: string; message: string }) {
    const record = readSubmitRecord(args.data);
    const err = record?.error ?? record?.node_errors;
    const errText = typeof err === "string" ? err.trim() : err && typeof err === "object" && Object.keys(err).length ? JSON.stringify(err) : "";
    const combined = `${errText} ${args.message || ""}`.toLowerCase();
    if (args.status === 401 || args.status === 403 || /unauthorized|forbidden|auth/i.test(combined)) {
        return `ComfyUI 认证失败（HTTP ${args.status || 401}）。请确认渠道 API Key 与实例要求一致后重试。`;
    }
    if (errText) return errText;
    if (args.message) return args.message;

    const raw = typeof args.data === "string" ? args.data : args.data == null ? "" : JSON.stringify(args.data);
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 300);
    const mime = args.contentType.split(";")[0].trim();
    const head = `ComfyUI did not return prompt_id (HTTP ${args.status}${mime ? `, ${mime}` : ""}, ${args.url})`;
    if (!snippet || /^\{\s*\}$/.test(snippet) || /^\[\s*\]$/.test(snippet)) {
        return `${head}: the response carried no fields. The base URL is not answering as a ComfyUI API — check the pod is running, that the port maps to ComfyUI (usually 8188), and open that URL in a browser to see what it serves.`;
    }
    if (mime.includes("text/html") || snippet.startsWith("<")) {
        return `${head}: it returned an HTML page instead of ComfyUI JSON, so this URL is a web UI / gateway rather than the ComfyUI API root. Open it in a browser to confirm. Body starts with: ${snippet}`;
    }
    return `${head}: ${snippet}`;
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
    /** Model / workflow option name — gates the strict reference-slot allow-list. */
    workflowId?: string;
    prompt: string;
    referenceDataUrls?: string[];
    /** data:/http(s):/blob: audio sources to upload into LoadAudio nodes. */
    referenceAudioSources?: string[];
    /** Canvas video size / ratio (e.g. 16:9, 1280x720). */
    size?: string;
    /** Canvas duration in seconds. */
    seconds?: string | number;
    /** Canvas quality tier (e.g. 720, 1080, 2k). */
    vquality?: string;
    /** ComfyUI sampling steps. */
    steps?: string | number;
    /** MiniMax H3 reference image sizing (match / max). */
    refImageSize?: string;
    /** ComfyUI sampler name (KSamplerSelect.sampler_name). */
    samplerName?: string;
    /** ComfyUI scheduler (BasicScheduler.scheduler). */
    scheduler?: string;
    signal?: AbortSignal;
};

/**
 * Upload references, inject prompt/images/audio/size/duration, queue prompt, poll history, download outputs.
 */
/**
 * Turn a failed `/history` entry into something the user can act on.
 *
 * ComfyUI reports execution failures as `status.messages` entries shaped
 * `["execution_error", { node_id, node_type, exception_type, exception_message, traceback }]`.
 * The bare "workflow execution failed" this used to throw hid the only fact that matters —
 * for example that the GPU ran out of memory — so the node just said "failed" with no way
 * forward.
 */
export function describeComfyExecutionError(entry: unknown): string {
    const status = (entry as { status?: { messages?: unknown } } | undefined)?.status;
    const messages = Array.isArray(status?.messages) ? status.messages : [];
    const failure = messages.find((item) => Array.isArray(item) && item[0] === "execution_error")?.[1] as Record<string, unknown> | undefined;
    const nodeType = String(failure?.node_type || "").trim();
    const nodeId = failure?.node_id == null ? "" : String(failure.node_id);
    const exception = String(failure?.exception_message || failure?.exception_type || "").trim();
    const where = [nodeType, nodeId && `#${nodeId}`].filter(Boolean).join(" ");
    const detail = [where, exception].filter(Boolean).join(": ");
    const head = detail ? `ComfyUI workflow execution failed — ${detail}` : "ComfyUI workflow execution failed";
    if (/exceeds allowed memory|out of memory|outofmemoryerror|allocation on device/i.test(detail)) {
        return (
            `${head}. The GPU ran out of VRAM (this pod is ~32GB). ` +
            `Use 720p or 1080p instead of 2K, shorten the duration, wait ~30s for VRAM to settle, then retry.`
        );
    }
    return head;
}

/**
 * Stop a running/pending ComfyUI prompt *on the server*.
 *
 * Aborting the local request only closes the HTTP call: ComfyUI keeps executing, and a video job
 * then finishes on its own and writes its MP4 into the pod's output folder. Cancelling has to
 * reach the server, so `runNativeComfyUiJob` posts here when its signal aborts. Best-effort.
 */
async function interruptComfyJob(baseUrl: string, apiKey: string, promptId: string): Promise<void> {
    const jsonHeaders = authHeaders(apiKey, "application/json");
    const actions: Array<() => Promise<unknown>> = [];
    try {
        const queue = await axios.get(comfyUiUrl(baseUrl, "/queue"), { headers: authHeaders(apiKey), timeout: 15_000 });
        const pending = Array.isArray(queue.data?.queue_pending) ? queue.data.queue_pending : [];
        const running = Array.isArray(queue.data?.queue_running) ? queue.data.queue_running : [];
        const queued = pending.find((entry: unknown) => Array.isArray(entry) && String(entry[1]) === promptId);
        const isRunning = running.some((entry: unknown) => Array.isArray(entry) && String(entry[1]) === promptId);
        const queueNumber = Array.isArray(queued) ? Number(queued[0]) : NaN;
        if (Number.isFinite(queueNumber)) {
            actions.push(() => axios.post(comfyUiUrl(baseUrl, "/queue"), { delete: [queueNumber] }, { headers: jsonHeaders, timeout: 15_000 }));
        } else if (isRunning || queued) {
            // Running (or queued without a usable number): ask ComfyUI to stop the current execution.
            actions.push(() => axios.post(comfyUiUrl(baseUrl, "/interrupt"), {}, { headers: jsonHeaders, timeout: 15_000 }));
        } else {
            // Neither queued nor running: the prompt already finished, so there is nothing to stop.
            return;
        }
    } catch {
        // `/queue` unavailable → fall back to interrupting whatever this pod is executing.
        actions.push(() => axios.post(comfyUiUrl(baseUrl, "/interrupt"), {}, { headers: jsonHeaders, timeout: 15_000 }));
    }
    for (const action of actions) {
        try {
            await action();
        } catch {
            // Best-effort only.
        }
    }
}

export async function runNativeComfyUiJob(args: RunNativeComfyUiArgs): Promise<NativeComfyUiResult> {
    const { baseUrl, apiKey, prompt, signal } = args;
    if (!normalizeComfyUiRoot(baseUrl)) throw new Error("ComfyUI Base URL is required");

    // Decide the workflow family once, from the submitted graph's shape rather than its model
    // name — the name is user-typed and the exported file name changes every revision, so a
    // name-keyed adapter goes dead code silently.
    const h3TwoPassRefs = isComfyH3TwoPassReferenceWorkflow(args.workflow);
    // Multi-reference video family (U06 …): single H3 node + >= 2 ref slots — its seed lives behind
    // an `easy seed` link, so randomization must follow that link.
    const h3MultiRefVideo = isComfyH3MultiReferenceVideoWorkflow(args.workflow);
    // Geometry-locked H3 families (two-pass video + single-reference image, e.g. U33) keep the
    // size the author baked into the graph; the image path passes no canvas size to override it.
    const keepTunedGeometry = isComfyGeometryLockedWorkflow(args.workflow);
    // The single-reference H3 image family (U33) is the one geometry-locked family whose baked
    // canvas must *follow* the user's size/ratio — its template bakes a square and would otherwise
    // ignore the canvas entirely. Scoped to this family, and excluding any graph that ends in a
    // video sink, so U24/U06/T10 and every video graph keep their tuned geometry untouched.
    const h3SingleRefImage = isComfyH3SingleReferenceImageWorkflow(args.workflow) && !hasComfyVideoSink(args.workflow);
    // U37 SelfLift 双采 family: the one geometry-locked family whose ResolutionSelector is the
    // delivered resolution rather than a draft, so it *must* follow the canvas. Stays geometry-locked
    // otherwise (seed randomisation + upload size guard keep working through `keepTunedGeometry`).
    const h3SelfLift = isComfyH3SelfLiftWorkflow(args.workflow);
    // U35 官流 family: same single-pass multi-ref shape as U06, but size is a linked
    // ResolutionSelector (delivered), not a WJILatentPreset — needs its own canvas drive.
    const h3ResSelectorVideo = isComfyH3ResolutionSelectorVideoWorkflow(args.workflow);
    // U30 Singularity 超双采放大: same single-H3 + ResolutionSelector shape as U35, but the
    // selector is the LOW draft before MinimaxH3LatentUpscaler3D (×1.5) — must use draft math.
    const h3Singularity = isComfyH3SingularityUpscaleWorkflow(args.workflow);
    const guardUpload = keepTunedGeometry || usesComfyUploadGuard(args.workflowId);
    // Text-output family (e.g. U00 H3 prompt writer): prompt and references land on the LLM node's
    // own slots instead of the CLIP/LoadImage conventions the shared writers assume.
    const textFamily = isComfyTextOutputWorkflow(args.workflow);

    let workflow = textFamily ? applyComfyTextPrompt(args.workflow, prompt) : applyComfyPrompt(args.workflow, prompt);
    workflow = applyComfyVideoSettings(workflow, {
        size: args.size,
        seconds: args.seconds,
        vquality: args.vquality,
        steps: args.steps,
        refImageSize: args.refImageSize,
        samplerName: args.samplerName,
        scheduler: args.scheduler,
        keepTunedResolution: keepTunedGeometry,
        reshapeCanvas: h3SingleRefImage,
        // The two-pass H3 video family is the one geometry-locked family where the canvas must win
        // (it otherwise ignores both the aspect and the resolution the user picked) and where the
        // author's coupled dual-clock sampling contract must not be clobbered by accident.
        twoPassH3Video: h3TwoPassRefs,
        singularityH3Video: h3Singularity,
        selfLiftH3Video: h3SelfLift,
        resolutionSelectorH3Video: h3ResSelectorVideo,
        // U06 single-pass multi-reference video family (WJILatentPreset size holder). SelfLift,
        // U35 官流 and U30 Singularity also match `isComfyH3MultiReferenceVideoWorkflow`, so
        // exclude them — their resolution lives in a ResolutionSelector their own branches drive.
        multiRefH3Video: h3MultiRefVideo && !h3SelfLift && !h3ResSelectorVideo && !h3Singularity,
    });
    // U24 DualClock / H3-video only: force browser-safe VHS h264 (author template already ships it;
    // this keeps a mis-exported gif/webm sink from landing unplayable on the canvas).
    if (h3TwoPassRefs) workflow = applyBrowserSafeVhsFormat(workflow);
    // U30 Singularity only: normalize the learned latent upscaler's mis-mapped widget values
    // (see `repairSingularityLatentUpscaler`) so 1080p/2K do not decode to noise.
    if (h3Singularity) workflow = repairSingularityLatentUpscaler(workflow);
    if (keepTunedGeometry) workflow = applyComfyRandomSeed(workflow, { followLinkedSeed: h3MultiRefVideo });
    // U06 single-pass multi-ref (WJILatentPreset holder), excluding SelfLift / U35 / U30.
    const multiRefH3Video = h3MultiRefVideo && !h3SelfLift && !h3ResSelectorVideo && !h3Singularity;
    const refs = (args.referenceDataUrls || []).filter(Boolean).slice(0, 8);
    // U06 V8 / U30 Singularity / U24 DualClock (H3-video) bake author-machine filenames into every
    // LoadImage. Those files do not exist on the seetacloud pod, so a zero-reference submit fails
    // inside LoadImage within a few seconds — or, for DualClock, leaves the worker wedged and the
    // gateway answers later polls with HTTP 502. Require at least one uploaded reference for these
    // families only; SelfLift has its own blank placeholder and is not gated here.
    if ((multiRefH3Video || h3Singularity || h3TwoPassRefs) && !refs.length) {
        throw new Error(
            h3TwoPassRefs
                ? "H3-video / U24 双采需要至少一张参考图。工作流里的 Untitled*.jpg / snowtp.png 只在作者本机，seetacloud 上不存在，请在画布连接参考图后再生成。"
                : "This multi-reference video workflow requires at least one reference image. The workflow's baked LoadImage filenames are local to the author's machine and are not on this ComfyUI server.",
        );
    }
    if (refs.length) {
        const names: string[] = [];
        for (let i = 0; i < refs.length; i += 1) {
            const uploaded = await uploadComfyImage(baseUrl, apiKey, refs[i], `ref-${i + 1}.png`, {
                signal,
                workflowId: args.workflowId,
                guardUpload,
            });
            names.push(uploaded);
        }
        // DualClock: always materialize a 64×64 blank when any refs were uploaded. Gating on
        // `slotCount > names.length` skipped the upload when slot discovery failed, leaving
        // LoadImage #94 on author-only `zealman-blank-image.png` → execution errno 22.
        let blankFilename: string | undefined;
        if (h3TwoPassRefs && !textFamily) {
            try {
                blankFilename = await uploadComfyImage(
                    baseUrl,
                    apiKey,
                    dualClockBlankPngDataUrl(),
                    "h3-dualclock-blank.png",
                    { signal, workflowId: args.workflowId, guardUpload: false },
                );
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`H3-video / U24 双采空槽占位图上传失败，无法推送到工作流：${detail}`);
            }
        }
        workflow = textFamily
            ? applyComfyTextReferenceImages(workflow, names)
            : applyComfyLoadImages(workflow, names, args.workflowId, blankFilename ? { blankFilename } : undefined);
    } else if (!textFamily && h3MultiRefVideo && !h3SelfLift) {
        // U06 V8 (and siblings): rewire duplicated ref slots even with zero uploads so Picture 1/2
        // are not left sharing `加载图像2`. SelfLift keeps its own blank-placeholder path and is
        // unchanged; graphs outside this family never enter applyComfyLoadImages here.
        workflow = applyComfyLoadImages(workflow, [], args.workflowId);
    }

    const audioRefs = (args.referenceAudioSources || []).filter(Boolean).slice(0, 3);
    if (audioRefs.length) {
        const names: string[] = [];
        for (let i = 0; i < audioRefs.length; i += 1) {
            const uploaded = await uploadComfyAudio(baseUrl, apiKey, audioRefs[i], `ref-audio-${i + 1}.mp3`, {
                signal,
                workflowId: args.workflowId,
                guardUpload,
            });
            names.push(uploaded);
        }
        workflow = applyComfyLoadAudios(workflow, names);
    }

    const clientId = nanoid(12);
    const token = String(apiKey || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    const body: Record<string, unknown> = { prompt: workflow, client_id: clientId };
    // Some ComfyUI gateways accept the key in the JSON body as well as (or instead of) the header.
    if (token && !/^(none|-|n\/a)$/i.test(token) && !isBasicAuthCredential(apiKey)) body.token = token;

    const submitUrl = comfyUiUrl(baseUrl, "/prompt");
    // seetacloud: /prompt under load commonly 502s; retry for the whole host.
    const submitRetries = isFlakyComfyGatewayHost(baseUrl) ? 4 : h3TwoPassRefs ? 3 : 1;
    const submitBackoffMs = isFlakyComfyGatewayHost(baseUrl) ? 2000 : 800;
    let submit: { status: number; headers: unknown; data: unknown };
    try {
        submit = await comfyRequestWithGatewayRetry(
            () => axios.post(submitUrl, body, { headers: authHeaders(apiKey, "application/json"), signal }),
            { signal, attempts: submitRetries, backoffMs: submitBackoffMs, label: "ComfyUI /prompt" },
        );
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const data = axios.isAxiosError(error) ? error.response?.data : undefined;
        if (status === 401 || status === 403 || (typeof data === "object" && data && /unauthorized/i.test(JSON.stringify(data)))) {
            throw new Error(
                describeComfySubmitFailure({
                    status: status || 401,
                    contentType: String(axios.isAxiosError(error) ? error.response?.headers?.["content-type"] || "" : ""),
                    data,
                    url: submitUrl,
                    message: "",
                }),
            );
        }
        if (isFlakyComfyGatewayHost(baseUrl) && isComfyGatewayRetryStatus(status)) {
            throw new Error(
                h3TwoPassRefs
                    ? `ComfyUI 网关错误（HTTP ${status}）。H3-video / U24 双采在 seetacloud 上常见于 OOM 或上一个重任务未结束 — 等待 30–60 秒后重试，建议 1080p、连接 1–2 张参考图；长时长更易占满显存。`
                    : `ComfyUI 网关错误（HTTP ${status}）。seetacloud 隧道短暂不可用（常在上一个重任务之后）— 等待 30–60 秒后重试，勿连续猛点生成。`,
            );
        }
        throw error;
    }
    const submitted = readComfySubmit(submit.data);
    if (!submitted.promptId && submitted.taskId && /runninghub\.(cn|ai)/i.test(baseUrl)) {
        return finishRunningHubTask(baseUrl, apiKey, submitted.taskId, signal);
    }
    const promptId = submitted.promptId;
    // U06 / U24 DualClock: ComfyUI can return a prompt_id together with node_errors (validation
    // soft-fail). Treat that as a hard failure so we never poll an empty/aborted history entry that
    // later surfaces as a seetacloud gateway 502.
    if (multiRefH3Video || h3TwoPassRefs) {
        const submitRecord = readSubmitRecord(submit.data);
        const nodeErrors = submitRecord?.node_errors;
        if (nodeErrors && typeof nodeErrors === "object" && Object.keys(nodeErrors as object).length) {
            const detail = describeComfySubmitFailure({
                status: submit.status,
                contentType: String((submit.headers as unknown as Record<string, unknown> | undefined)?.["content-type"] || ""),
                data: submit.data,
                url: submitUrl,
                message: submitted.message,
            });
            throw new Error(
                h3TwoPassRefs
                    ? `H3-video / U24 双采无法推送到工作流（节点校验失败）。请确认模型脚本已粘贴 U24 Export (API) JSON，并连接至少一张参考图。详情：${detail}`
                    : detail,
            );
        }
    }
    if (!promptId) {
        throw new Error(
            describeComfySubmitFailure({
                status: submit.status,
                contentType: String((submit.headers as unknown as Record<string, unknown> | undefined)?.["content-type"] || ""),
                data: submit.data,
                url: submitUrl,
                message: submitted.message,
            }),
        );
    }

    // Cancelling has to reach ComfyUI, not just close the local request: aborting the fetch alone
    // leaves the job running on the pod, and a video job then finishes into its output folder on
    // its own. Best-effort, matched by prompt_id, and native-path only — see `interruptComfyJob`.
    const stopOnAbort = () => {
        void interruptComfyJob(baseUrl, apiKey, promptId);
    };
    if (signal?.aborted) stopOnAbort();
    else signal?.addEventListener("abort", stopOnAbort, { once: true });

    // Video graphs: wait for a real VHS/mp4 artefact (not LoadImage / preview stills), and never
    // download every preview frame through the proxy before fetching the clip — that was the
    // "pod finished, canvas still blank for ~3 minutes" lag on seetacloud.
    const waitForVideoArtifact = hasComfyVideoSink(args.workflow) || multiRefH3Video || h3Singularity || h3TwoPassRefs || h3SelfLift || h3ResSelectorVideo;

    try {
        const deadline = performance.now() + HISTORY_TIMEOUT_MS;
        let outputs: HistoryOutputs | undefined;
        let videoCompletedGrace = 0;
        let sawHistoryEntry = false;
        while (performance.now() < deadline) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            // Video return path: prefer a quick second try over multi-second backoff stacks that
            // used to add seconds after the pod had already finished.
            const historyRetries = waitForVideoArtifact || isFlakyComfyGatewayHost(baseUrl) ? 2 : 1;
            let history: { data: unknown };
            try {
                history = await comfyRequestWithGatewayRetry(
                    () =>
                        axios.get(comfyUiUrl(baseUrl, `/history/${encodeURIComponent(promptId)}`), {
                            headers: authHeaders(apiKey),
                            signal,
                        }),
                    { signal, attempts: historyRetries, backoffMs: 500, label: "ComfyUI /history" },
                );
            } catch (error) {
                const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                // A mid-poll 502 often means the DualClock worker died; keep waiting a bit longer
                // instead of failing the whole job on one flaky gateway response.
                if (h3TwoPassRefs && isComfyGatewayRetryStatus(status)) {
                    await sleep(HISTORY_INTERVAL_MS * 2, signal);
                    continue;
                }
                throw error;
            }
            const historyRoot = history.data as Record<string, unknown> | undefined;
            const entry = (historyRoot?.[promptId] || historyRoot) as
                | {
                      status?: { status_str?: string; messages?: unknown[]; completed?: boolean };
                      outputs?: HistoryOutputs;
                  }
                | undefined;
            const statusStr = String(entry?.status?.status_str || "");
            const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
            const hasExecutionError = messages.some((m: unknown) => Array.isArray(m) && m[0] === "execution_error");
            if (statusStr === "error" || hasExecutionError) {
                throw new Error(describeComfyExecutionError(entry));
            }
            const entryOutputs = entry?.outputs && typeof entry.outputs === "object" ? entry.outputs : undefined;
            if (entryOutputs && Object.keys(entryOutputs).length) {
                sawHistoryEntry = true;
                if (waitForVideoArtifact) {
                    // `collectMediaFromHistory` only counts real containers (.mp4/.webm/…); preview
                    // gifs no longer trip this branch, so we keep polling until VHS writes the clip.
                    const partial = collectMediaFromHistory(entryOutputs);
                    const completed = entry?.status?.completed === true || statusStr === "success";
                    if (partial.videos.length) {
                        outputs = entryOutputs;
                        break;
                    }
                    if (completed) {
                        videoCompletedGrace += 1;
                        if (videoCompletedGrace >= VIDEO_HISTORY_GRACE_POLLS) {
                            outputs = entryOutputs;
                            break;
                        }
                    }
                } else {
                    outputs = entryOutputs;
                    break;
                }
            }
            const completedWaitingForMp4 =
                waitForVideoArtifact &&
                sawHistoryEntry &&
                (entry?.status?.completed === true || statusStr === "success");
            await sleep(
                completedWaitingForMp4
                    ? HISTORY_VIDEO_DONE_INTERVAL_MS
                    : sawHistoryEntry && waitForVideoArtifact
                      ? HISTORY_FAST_INTERVAL_MS
                      : HISTORY_INTERVAL_MS,
                signal,
            );
        }
        if (!outputs) throw new Error("ComfyUI timed out waiting for /history");

        const media = collectMediaFromHistory(outputs);
        const texts = collectTextsFromHistory(outputs);
        // Text-output graphs legitimately finish with no image/video at all. Only the detected text
        // family is exempt from the hard failure below, so every image/video workflow keeps throwing
        // exactly the same error it did before.
        if (waitForVideoArtifact) {
            if (!media.videos.length) {
                throw new Error(
                    multiRefH3Video || h3TwoPassRefs
                        ? "ComfyUI finished but returned no video. Connect reference images on the canvas (the workflow's baked Untitled*.jpg / snowtp.png files are not on this server) and retry."
                        : "ComfyUI finished but returned no video",
                );
            }
        } else if (!media.images.length && !media.videos.length && !(textFamily && texts.length)) {
            throw new Error("ComfyUI finished but returned no images/videos");
        }

        const images: NativeComfyUiResult["images"] = [];
        const videos: NativeComfyUiResult["videos"] = [];

        // Video workflows: fetch only the primary mp4. Preview stills / intermediate gifs used to
        // be downloaded first (each as a proxied blob + data-URL), delaying canvas return by minutes
        // after ComfyUI had already finished.
        if (waitForVideoArtifact && media.videos.length) {
            const primary = pickPrimaryComfyVideo(media.videos);
            if (!primary) {
                throw new Error("ComfyUI finished but returned no playable video file (mp4/webm)");
            }
            const blob = await fetchComfyView(baseUrl, apiKey, primary, { signal });
            const extMime = /\.webm$/i.test(primary.filename)
                ? "video/webm"
                : /\.(mov|mkv)$/i.test(primary.filename)
                  ? "video/quicktime"
                  : "video/mp4";
            const mimeType = blob.type && blob.type.startsWith("video/") ? blob.type : extMime;
            // Force a typed blob so IndexedDB / <video> see a real video MIME even when /view
            // answered with application/octet-stream — but only after the bytes pass the
            // container sniff (rejects HTML/JSON/GIF previews that used to land unplayable).
            await assertPlayableComfyVideoBlob(blob, mimeType);
            // `slice` retypes without copying the whole mp4 into a second ArrayBuffer (unlike
            // `new Blob([blob])`), which mattered for 30–100MB DualClock clips on the return path.
            const typed = blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType);
            // Decode probe only for DualClock / H3-video — other video families keep prior behaviour.
            if (h3TwoPassRefs) await assertBrowserCanDecodeVideo(typed, mimeType);
            videos.push({ blob: typed, mimeType });
        } else {
            for (const file of media.images) {
                const blob = await fetchComfyView(baseUrl, apiKey, file, { signal });
                images.push({ id: nanoid(), dataUrl: await blobToDataUrl(blob) });
            }
            for (const file of media.videos) {
                const blob = await fetchComfyView(baseUrl, apiKey, file, { signal });
                const extMime = /\.webm$/i.test(file.filename)
                    ? "video/webm"
                    : /\.(mov|mkv)$/i.test(file.filename)
                      ? "video/quicktime"
                      : /\.mp4$/i.test(file.filename)
                        ? "video/mp4"
                        : "";
                const mimeType = extMime || (blob.type && blob.type.startsWith("video/") ? blob.type : "video/mp4");
                const typed = blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType);
                videos.push({ blob: typed, mimeType });
            }
        }

        return { images, videos, texts };
    } finally {
        signal?.removeEventListener("abort", stopOnAbort);
    }
}

/**
 * A live ComfyUI answers /system_stats and /object_info with JSON. An HTML page or an empty
 * body means we reached a gateway / WAF interstitial / web UI instead — and the old
 * "any 2xx/4xx counts as healthy" rule reported exactly that as green, which is how a wrong
 * base URL stays invisible until the first generation fails.
 */
function isComfyJsonResponse(response: { headers?: unknown; data?: unknown }): boolean {
    const contentType = String((response.headers as Record<string, unknown> | undefined)?.["content-type"] || "").toLowerCase();
    const data = response.data;
    if (typeof data === "string") {
        const text = data.trim();
        if (!text || text.startsWith("<")) return false;
        try {
            const parsed = JSON.parse(text) as unknown;
            return Boolean(parsed) && typeof parsed === "object";
        } catch {
            return false;
        }
    }
    if (data && typeof data === "object") return true;
    // No parsed body at all — only trust an explicit JSON content type.
    return contentType.includes("json");
}

const NOT_COMFY_JSON_MESSAGE =
    "the endpoint did not answer with ComfyUI JSON (an HTML/gateway page or an empty body). The Base URL looks like a web UI / gateway instead of the ComfyUI API root — verify host and port (ComfyUI usually listens on 8188), then open <Base URL>/system_stats in a browser: it must return JSON.";

/** Health probe: GET /system_stats or /object_info (a live ComfyUI answers both with JSON). */
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
            if (fallback.status >= 200 && fallback.status < 300) {
                return isComfyJsonResponse(fallback) ? { ok: true, message: `HTTP ${fallback.status}` } : { ok: false, message: `HTTP ${fallback.status}: ${NOT_COMFY_JSON_MESSAGE}` };
            }
            if (fallback.status < 500) return { ok: true, message: `HTTP ${fallback.status}` };
            return { ok: false, message: `HTTP ${fallback.status}` };
        }
        if (response.status === 401 || response.status === 403) {
            return { ok: false, message: `ComfyUI 认证失败（HTTP ${response.status}）。请确认渠道 API Key 后重试。` };
        }
        if (response.status >= 200 && response.status < 300) {
            return isComfyJsonResponse(response) ? { ok: true, message: `HTTP ${response.status}` } : { ok: false, message: `HTTP ${response.status}: ${NOT_COMFY_JSON_MESSAGE}` };
        }
        if (response.status < 500) return { ok: true, message: `HTTP ${response.status}` };
        return { ok: false, message: `HTTP ${response.status}` };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
