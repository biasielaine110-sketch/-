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
// H3 等 DiT 视频工作流在共享 GPU / 长队列下可能跑很久（排队 + 采样 + VAE 解码），
// 60 分钟是实测安全上限；超时后任务仍在服务器跑，只是画布停止等待。
const HISTORY_TIMEOUT_MS = 60 * 60 * 1000;

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
 * (the orphan the author clearly meant to keep, ascending id) **and** rewire the link, otherwise the
 * slot keeps reading the shared loader and the substitution is invisible. Only when no spare is left
 * drop the repeat, so no upload is ever wasted on the same loader twice.
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
export const COMFY_REFERENCE_SLOT_WORKFLOWS = ["U24-文武双修T8版MiniMaxH3双采参考生视频V2"] as const;

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
 * Templates that expose more reference slots than they expect to be filled park a blank image in
 * the spare ones. Reusing that same asset to clear unused slots keeps the call sites honest
 * (the blank file is part of the exported graph, so it already exists on the server) instead of
 * inventing a name that would fail ComfyUI's LoadImage.
 */
function comfyBlankImagePlaceholder(workflow: ComfyWorkflow): string | null {
    for (const node of Object.values(workflow)) {
        if (!isComfyImageLoader(node)) continue;
        const name = node.inputs?.image;
        if (typeof name === "string" && /blank|empty|placeholder|transparent|^none\./i.test(name)) return name;
    }
    return null;
}

/** Map uploaded filenames onto LoadImage nodes in order. */
export function applyComfyLoadImages(workflow: ComfyWorkflow, filenames: string[], workflowId?: string): ComfyWorkflow {
    if (!filenames.length) return workflow;
    const next = cloneWorkflow(workflow);
    // Name allow-list OR structural fingerprint. Without the fingerprint a renamed model fell back
    // to node-id order and scrambled every reference (ref_image_0 got the last uploaded picture).
    // The single-pass multi-reference video family needs the *repaired* slot order: its export can
    // link one slot twice and orphan the loader the author meant to keep, so the verbatim order
    // would still shift every picture by one.
    const slotPlan = isComfyH3MultiReferenceVideoWorkflow(next) ? comfyMultiReferenceSlotPlan(next) : null;
    const slotOrder =
        usesComfyReferenceSlotOrder(workflowId) || isComfyH3TwoPassReferenceWorkflow(next)
            ? comfyReferenceSlotOrder(next)
            : slotPlan
              ? slotPlan.ordered
              : [];
    // Repair duplicated `ref_image_N` links so each picture slot reads its own (spare) loader — a
    // filename write alone cannot fix a slot that still points at the shared loader.
    if (slotPlan) {
        const inputs = next[slotPlan.nodeId]?.inputs;
        for (const fix of slotPlan.rewire) {
            if (inputs && inputs[fix.key]) inputs[fix.key] = [fix.to, 0];
        }
    }
    // When a two-pass H3 graph declares its own blank placeholder, the spare slots are meant to stay
    // empty. Repeating the last uploaded picture there (the legacy fallback) made the model see one
    // reference 8× — e.g. U24 V927 exposes 9 slots where only the first few are real. Graphs without
    // such a placeholder keep the legacy fill-up, so no other model changes behaviour.
    const blankSlot = isComfyH3TwoPassReferenceWorkflow(next) ? comfyBlankImagePlaceholder(next) : null;
    const loaders = slotOrder.length
        ? slotOrder.map((id) => next[id]).filter((node): node is ComfyNode => Boolean(node))
        : Object.entries(next)
              .filter(([, node]) => isComfyImageLoader(node))
              .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
              .map(([, node]) => node);
    loaders.forEach((node, index) => {
        // Legacy fallback (repeat the last upload) is preserved when the graph has no blank slot.
        const name = filenames[index] || blankSlot || filenames[filenames.length - 1];
        if (!name) return;
        if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
        if ("image" in node.inputs || !("url" in node.inputs)) node.inputs.image = name;
        else node.inputs.url = name;
    });
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

/** Map uploaded filenames onto LoadAudio nodes in order. */
export function applyComfyLoadAudios(workflow: ComfyWorkflow, filenames: string[]): ComfyWorkflow {
    if (!filenames.length) return workflow;
    const next = cloneWorkflow(workflow);
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
    const targets = Object.values(next).filter(isMiniMaxH3ConditioningNode);
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
    if (/1080|hd/.test(raw)) return 1920;
    if (/720|sd/.test(raw)) return 1280;
    if (/480|low/.test(raw)) return 854;
    const numeric = Number(raw.replace(/p$/i, ""));
    if (Number.isFinite(numeric) && numeric > 0) {
        if (numeric >= 3000) return 3840;
        if (numeric >= 2000) return 2560;
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
    },
): ComfyWorkflow {
    const next = cloneWorkflow(workflow);
    const pixels = pixelsFromSizeAndQuality(settings.size, settings.vquality);
    const megapixels = megapixelsFromPixels(pixels.width, pixels.height);
    const aspectLabel = resolutionSelectorAspectLabel(pixels.ratio);
    const seconds = parseCanvasSeconds(settings.seconds);

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
            // Geometry-locked graphs (H3 two-pass family): the HIGH refine pass takes its size from a
            // fixed learned upscaler (target_width/height on the upscale node), so the
            // ResolutionSelector only drives the cheap LOW draft pass — and the author tunes that
            // draft deliberately small (0.4 MP in the U24/T8 template). Rewriting it with the canvas
            // budget (auto quality → 0.94 MP) made the draft as heavy as the refine pass and pushed a
            // 24 GB card over its limit ("allocation would exceed allowed memory"). Keep the saved
            // aspect and never inflate `megapixels`; a lighter canvas request still gets through.
            const tunedMegapixels = settings.keepTunedResolution && typeof node.inputs.megapixels === "number" ? node.inputs.megapixels : null;
            if (tunedMegapixels == null && "aspect_ratio" in node.inputs) node.inputs.aspect_ratio = aspectLabel;
            if ("megapixels" in node.inputs) {
                writeComfyNumberInput(node, "megapixels", tunedMegapixels == null ? megapixels : Math.min(megapixels, tunedMegapixels));
            }
        }

        if (seconds != null && (/duration|时长|seconds/i.test(title) || (/Primitive(Float|Int|Number)/i.test(type) && /duration|时长/i.test(title)))) {
            writeComfyNumberInput(node, "value", seconds);
        }
    }

    // Sampling steps: BasicScheduler / KSampler expose an integer `steps` field.
    if (steps != null) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            if (!/BasicScheduler|KSampler|Scheduler/i.test(type) || !node.inputs) continue;
            if ("steps" in node.inputs) writeComfyNumberInput(node, "steps", steps);
        }
    }

    // Scheduler (BasicScheduler.scheduler) — string combo.
    if (scheduler) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
            if (!/BasicScheduler|Scheduler/i.test(type) || !node.inputs) continue;
            if ("scheduler" in node.inputs) writeComfyStringInput(node, "scheduler", scheduler);
        }
    }

    // Sampler name (KSamplerSelect.sampler_name) — string combo.
    if (samplerName) {
        for (const node of Object.values(next)) {
            const type = String(node.class_type || "");
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
        // U33 single-reference H3 image family bakes a square canvas onto the node, so the user's
        // canvas size/ratio never took effect and every run came back square. When the canvas
        // carries an explicit size, reshape the baked canvas to it (anchored on the author's own
        // long edge so resolution is never inflated). "auto"/empty keeps the author's geometry, and
        // a graph whose width/height are *links* is left alone (deliberately scalar-only, so this
        // can never rewrite a size parked in a separate preset node).
        if (
            settings.reshapeCanvas &&
            isExplicitCanvasSize(settings.size) &&
            typeof node.inputs.width === "number" &&
            typeof node.inputs.height === "number"
        ) {
            const shaped = shapeH3CanvasToSize(node.inputs.width, node.inputs.height, String(settings.size));
            writeComfyNumberInput(node, "width", shaped.width);
            writeComfyNumberInput(node, "height", shaped.height);
        } else if (!settings.keepTunedResolution) {
            // Geometry-locked H3 families keep the width/height the author baked onto the node. The
            // image path passes no canvas size, so `pixels` is only the 16:9 @1280 fallback — writing it
            // would silently rewrite a 2048×2048 author size on every run.
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
        if (!/RandomNoise|SamplerCustom|KSampler/i.test(type) || !node.inputs) continue;
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
    "U06-minimax_h3_lightX2v多图参考生视频V5",
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
    const response = await axios.post(comfyUiUrl(baseUrl, "/upload/image"), body, {
        headers: authHeaders(apiKey),
        signal: options?.signal,
    });
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
        return `${head}. The GPU ran out of VRAM — lower the video resolution or duration and retry (freeing VRAM on the server also helps).`;
    }
    return head;
}

/**
 * Best-effort VRAM release before a heavy submission.
 *
 * Rented ComfyUI pods never free VRAM between tasks, which is the classic "first run succeeds,
 * the second dies with 'allocation would exceed allowed memory'". ComfyUI's own `/free` endpoint
 * is the remedy. Deliberately non-fatal: a channel whose ComfyUI does not expose `/free` (or
 * answers slowly) must keep working exactly as it did before, so every failure is swallowed.
 */
async function freeComfyVram(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<void> {
    try {
        await axios.post(
            comfyUiUrl(baseUrl, "/free"),
            { unload_models: true, free_memory: true },
            { headers: authHeaders(apiKey, "application/json"), signal, timeout: 30_000 },
        );
    } catch {
        // Optimisation only — never let a missing/failing /free endpoint break a generation.
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
    });
    if (keepTunedGeometry) workflow = applyComfyRandomSeed(workflow, { followLinkedSeed: h3MultiRefVideo });
    const refs = (args.referenceDataUrls || []).filter(Boolean).slice(0, 8);
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
        workflow = textFamily
            ? applyComfyTextReferenceImages(workflow, names)
            : applyComfyLoadImages(workflow, names, args.workflowId);
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
    // Basic-Auth credentials authenticate via the Authorization header only — never as a body token.
    if (token && !/^(none|-|n\/a)$/i.test(token) && !isBasicAuthCredential(apiKey)) body.token = token;

    // Heavy two-pass H3 graphs run right at the edge of a 24 GB card; release whatever the previous
    // task left resident before asking for another render. Best-effort and family-scoped, so no
    // other native ComfyUI channel changes behaviour.
    if (h3TwoPassRefs) await freeComfyVram(baseUrl, apiKey, signal);

    const submitUrl = comfyUiUrl(baseUrl, "/prompt");
    const submit = await axios.post(submitUrl, body, {
        headers: authHeaders(apiKey, "application/json"),
        signal,
    });
    const submitted = readComfySubmit(submit.data);
    if (!submitted.promptId && submitted.taskId && /runninghub\.(cn|ai)/i.test(baseUrl)) {
        return finishRunningHubTask(baseUrl, apiKey, submitted.taskId, signal);
    }
    const promptId = submitted.promptId;
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

    const deadline = performance.now() + HISTORY_TIMEOUT_MS;
    let outputs: HistoryOutputs | undefined;
    while (performance.now() < deadline) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const history = await axios.get(comfyUiUrl(baseUrl, `/history/${encodeURIComponent(promptId)}`), {
            headers: authHeaders(apiKey),
            signal,
        });
        const entry = history.data?.[promptId] || history.data;
        if (
            entry?.status?.status_str === "error" ||
            (entry?.status?.completed === false && entry?.status?.messages?.some?.((m: unknown) => Array.isArray(m) && m[0] === "execution_error"))
        ) {
            throw new Error(describeComfyExecutionError(entry));
        }
        if (entry?.outputs && Object.keys(entry.outputs).length) {
            outputs = entry.outputs as HistoryOutputs;
            break;
        }
        await sleep(HISTORY_INTERVAL_MS, signal);
    }
    if (!outputs) throw new Error("ComfyUI timed out waiting for /history");

    const media = collectMediaFromHistory(outputs);
    const texts = collectTextsFromHistory(outputs);
    // Text-output graphs legitimately finish with no image/video at all. Only the detected text
    // family is exempt from the hard failure below, so every image/video workflow keeps throwing
    // exactly the same error it did before.
    if (!media.images.length && !media.videos.length && !(textFamily && texts.length)) {
        throw new Error("ComfyUI finished but returned no images/videos");
    }

    const images: NativeComfyUiResult["images"] = [];
    for (const file of media.images) {
        const blob = await fetchComfyView(baseUrl, apiKey, file, { signal });
        images.push({ id: nanoid(), dataUrl: await blobToDataUrl(blob) });
    }

    const videos: NativeComfyUiResult["videos"] = [];
    for (const file of media.videos) {
        const blob = await fetchComfyView(baseUrl, apiKey, file, { signal });
        // ComfyUI /view often replies with a generic application/octet-stream content-type,
        // so trust the filename extension over blob.type when deciding the real MIME.
        const extMime = /\.webm$/i.test(file.filename)
            ? "video/webm"
            : /\.(mov|mkv)$/i.test(file.filename)
              ? "video/quicktime"
              : /\.mp4$/i.test(file.filename)
                ? "video/mp4"
                : "";
        const mimeType = extMime || (blob.type && blob.type.startsWith("video/") ? blob.type : "video/mp4");
        videos.push({ blob, mimeType });
    }

    return { images, videos, texts };
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
        if (response.status === 401 || response.status === 403) return { ok: false, message: "ComfyUI auth failed (check API token)" };
        if (response.status >= 200 && response.status < 300) {
            return isComfyJsonResponse(response) ? { ok: true, message: `HTTP ${response.status}` } : { ok: false, message: `HTTP ${response.status}: ${NOT_COMFY_JSON_MESSAGE}` };
        }
        if (response.status < 500) return { ok: true, message: `HTTP ${response.status}` };
        return { ok: false, message: `HTTP ${response.status}` };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
