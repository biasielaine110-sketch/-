import axios from "axios";

import i18n from "@/i18n";
import { isSeedAudioModel, isSunoAudioModel } from "@/lib/audio-generation";
import { isAutodlComfyAudioModel } from "@/lib/autodl-comfy-audio";
import { isAutodlH3ComfyVideoModel } from "@/lib/autodl-h3-comfy";
import { isNativeComfyUiBaseUrl, parseComfyApiWorkflow, probeNativeComfyUi } from "@/lib/comfyui-native";
import { proxyApiUrl } from "@/lib/api-proxy";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

export type ModelHealthStatus = "idle" | "checking" | "ok" | "fail";

export type ModelHealthEntry = {
    status: ModelHealthStatus;
    message?: string;
    checkedAt: number;
};

const HEALTH_TTL_MS = 5 * 60_000;
const HEALTH_TIMEOUT_MS = 12_000;
const MAX_CONCURRENT = 2;
const PRIORITY_SELECTED = 100;

const cache = new Map<string, ModelHealthEntry>();
const inflight = new Map<string, Promise<ModelHealthEntry>>();
const listeners = new Set<() => void>();
let activeProbes = 0;

type QueuedProbe = {
    key: string;
    priority: number;
    start: () => void;
};

const queue: QueuedProbe[] = [];

const apiText = (key: string) => i18n.t(`apiErrors.${key}`);

export function modelHealthKey(config: AiConfig, encodedModel: string, capability: ModelCapability) {
    const request = resolveModelRequestConfig(config, encodedModel);
    return `${request.baseUrl}\0${request.apiKey.slice(0, 16)}\0${request.model}\0${capability}`;
}

export function getModelHealth(key: string): ModelHealthEntry {
    return cache.get(key) || { status: "idle", checkedAt: 0 };
}

export function subscribeModelHealth(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function emitHealth() {
    listeners.forEach((listener) => listener());
}

function setHealth(key: string, entry: ModelHealthEntry) {
    cache.set(key, entry);
    emitHealth();
}

function runQueued() {
    queue.sort((a, b) => b.priority - a.priority);
    while (activeProbes < MAX_CONCURRENT && queue.length) {
        const next = queue.shift();
        next?.start();
    }
}

/** Boost a waiting probe so the selected model runs before the rest of a bulk check. */
export function prioritizeModelHealth(key: string) {
    const index = queue.findIndex((item) => item.key === key);
    if (index < 0) return;
    const [item] = queue.splice(index, 1);
    item.priority = Math.max(item.priority, PRIORITY_SELECTED);
    queue.unshift(item);
    runQueued();
}

function enqueue<T>(key: string, task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const start = () => {
            activeProbes += 1;
            task()
                .then(resolve, reject)
                .finally(() => {
                    activeProbes -= 1;
                    runQueued();
                });
        };

        // Prefer draining the priority queue when a slot is free so a just-boosted model can jump ahead.
        if (activeProbes < MAX_CONCURRENT && queue.length === 0) {
            start();
            return;
        }

        queue.push({ key, priority, start });
        runQueued();
    });
}

export async function ensureModelHealth(
    config: AiConfig,
    encodedModel: string,
    capability: ModelCapability,
    options?: { force?: boolean; priority?: boolean; signal?: AbortSignal },
) {
    const key = modelHealthKey(config, encodedModel, capability);
    const priority = options?.priority ? PRIORITY_SELECTED : 0;
    const cached = cache.get(key);
    const pending = inflight.get(key);

    if (pending) {
        if (options?.priority) prioritizeModelHealth(key);
        return pending;
    }

    if (!options?.force && cached && cached.status !== "checking" && cached.status !== "idle" && Date.now() - cached.checkedAt < HEALTH_TTL_MS) {
        return cached;
    }

    setHealth(key, { status: "checking", checkedAt: Date.now(), message: cached?.message });

    let resolveRun!: (entry: ModelHealthEntry) => void;
    let rejectRun!: (error: unknown) => void;
    const run = new Promise<ModelHealthEntry>((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
    });
    // Reserve inflight synchronously to avoid duplicate enqueue races.
    inflight.set(key, run);

    enqueue(
        key,
        async () => {
            try {
                const result = await probeModelHealth(config, encodedModel, capability, options?.signal);
                if (options?.signal?.aborted) return getModelHealth(key);
                const entry: ModelHealthEntry = { status: result.ok ? "ok" : "fail", message: "message" in result ? result.message : undefined, checkedAt: Date.now() };
                setHealth(key, entry);
                return entry;
            } catch (error) {
                if (options?.signal?.aborted || axios.isCancel(error)) return getModelHealth(key);
                const entry: ModelHealthEntry = {
                    status: "fail",
                    message: error instanceof Error ? error.message : apiText("requestFailed"),
                    checkedAt: Date.now(),
                };
                setHealth(key, entry);
                return entry;
            } finally {
                inflight.delete(key);
            }
        },
        priority,
    ).then(resolveRun, rejectRun);

    return run;
}

/** Queue health checks for many models; selected model can jump ahead via ensureModelHealth(..., { priority: true }). */
export async function ensureModelsHealth(
    config: AiConfig,
    encodedModels: string[],
    capability: ModelCapability,
    options?: { force?: boolean; signal?: AbortSignal },
) {
    const unique = Array.from(new Set(encodedModels.filter(Boolean)));
    return Promise.all(unique.map((model) => ensureModelHealth(config, model, capability, { force: options?.force, signal: options?.signal })));
}

export async function probeModelHealth(config: AiConfig, encodedModel: string, capability: ModelCapability, signal?: AbortSignal) {
    const request = resolveModelRequestConfig(config, encodedModel);
    if (!request.baseUrl.trim()) return { ok: false, message: apiText("baseUrlRequired") };
    if (!request.model.trim()) return { ok: false, message: apiText("requestFailed") };
    const script = resolveModelScript(config, encodedModel);
    const nativeComfy = isNativeComfyUiBaseUrl(request.baseUrl) || Boolean(parseComfyApiWorkflow(script));
    if (!nativeComfy && !request.apiKey.trim()) return { ok: false, message: apiText("apiKeyRequired") };

    if (nativeComfy && (capability === "image" || capability === "video")) {
        return probeNativeComfyUi(request.baseUrl, request.apiKey, signal);
    }

    if (capability === "text") return probeText(request, signal);
    if (capability === "image") return probeImage(request, signal);
    if (capability === "audio") return probeAudio(request, signal);
    if (capability === "video") return probeVideo(request, signal);
    return { ok: false, message: apiText("requestFailed") };
}

async function probeText(config: ReturnType<typeof resolveModelRequestConfig>, signal?: AbortSignal) {
    if (config.apiFormat === "gemini") {
        try {
            await axios.post(
                proxyApiUrl(`${geminiRoot(config.baseUrl)}/models/${encodeURIComponent(config.model.replace(/^models\//, ""))}:generateContent`),
                {
                    contents: [{ role: "user", parts: [{ text: "ping" }] }],
                    generationConfig: { maxOutputTokens: 1 },
                },
                {
                    headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey, Authorization: `Bearer ${config.apiKey}` },
                    signal,
                    timeout: HEALTH_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            ).then((response) => assertProbeResponse(response.status, response.data));
            return { ok: true as const };
        } catch (error) {
            return failFromError(error);
        }
    }

    try {
        const response = await axios.post(
            proxyApiUrl(buildApiUrl(config.baseUrl, "/chat/completions")),
            {
                model: config.model,
                messages: [{ role: "user", content: "ping" }],
                max_tokens: 1,
                stream: false,
            },
            {
                headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
                signal,
                timeout: HEALTH_TIMEOUT_MS,
                validateStatus: () => true,
            },
        );
        assertProbeResponse(response.status, response.data);
        return { ok: true as const };
    } catch (error) {
        return failFromError(error);
    }
}

async function probeImage(config: ReturnType<typeof resolveModelRequestConfig>, signal?: AbortSignal) {
    // Prefer a non-billable models list probe so empty-prompt POSTs don't spam 400 in the console.
    try {
        const modelsResponse = await axios.get(proxyApiUrl(buildApiUrl(config.baseUrl, "/models")), {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal,
            timeout: HEALTH_TIMEOUT_MS,
            validateStatus: () => true,
        });
        if (modelsResponse.status >= 200 && modelsResponse.status < 300) return { ok: true as const };
        if (isAuthFailure(modelsResponse.status, readMessage(modelsResponse.data))) {
            return { ok: false as const, message: readMessage(modelsResponse.data) || `HTTP ${modelsResponse.status}` };
        }
    } catch {
        // Fall through to empty-prompt POST probe.
    }

    // Empty prompt should fail validation after auth/model routing — avoids billing a real image.
    const isMidjourney = /midjourney|\bmj[-_]?/i.test(config.model);
    const isSeedance = /seedance\.nz/i.test(config.baseUrl);
    const path = isMidjourney ? "/midjourney/generations" : isSeedance ? "/image/generations" : "/images/generations";
    const body = isMidjourney
        ? { prompt: "" }
        : isSeedance
          ? { model: config.model, prompt: "", metadata: { resolution: "1k" } }
          : {
                model: config.model,
                prompt: "",
                ...(isSeedreamLike(config.model) || isVolcArk(config.baseUrl) ? { size: "2K", watermark: false } : { n: 1 }),
            };
    try {
        const response = await axios.post(proxyApiUrl(buildApiUrl(config.baseUrl, path)), body, {
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            signal,
            timeout: HEALTH_TIMEOUT_MS,
            validateStatus: () => true,
        });
        return interpretNonTextProbe(response.status, response.data);
    } catch (error) {
        return failFromError(error);
    }
}

async function probeAudio(config: ReturnType<typeof resolveModelRequestConfig>, signal?: AbortSignal) {
    if (isAutodlComfyAudioModel(config.model, config.baseUrl) || /autodl\.art/i.test(config.baseUrl)) {
        return probeAutodlComfyVideo(config, signal);
    }
    if (/openspeech\.bytedance\.com/i.test(config.baseUrl)) {
        try {
            const response = await axios.post(
                proxyApiUrl(resolveOpenSpeechUrl(config.baseUrl)),
                {
                    user: { uid: "health-check" },
                    req_params: {
                        text: "",
                        speaker: "zh_female_vv_uranus_bigtts",
                        audio_params: { format: "mp3", sample_rate: 24000 },
                    },
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "X-Api-Key": String(config.apiKey || "")
                            .trim()
                            .replace(/^Bearer\s+/i, "")
                            .replace(/^["']|["']$/g, "")
                            .trim(),
                        "X-Api-Resource-Id": /^seed-(tts|icl)/i.test(config.model) ? config.model : "seed-tts-2.0",
                        "X-Api-Request-Id": typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
                    },
                    signal,
                    timeout: HEALTH_TIMEOUT_MS,
                    validateStatus: () => true,
                    responseType: "text",
                    transformResponse: [(data) => data],
                },
            );
            return interpretOpenSpeechProbe(response.status, String(response.data || ""));
        } catch (error) {
            return failFromError(error);
        }
    }

    // Seedance Suno uses /v1/music/* — probing /audio/speech returns 404/503 and false negatives.
    if (isSunoAudioModel(config.model || "")) {
        try {
            const response = await axios.post(
                proxyApiUrl(buildApiUrl(config.baseUrl, "/music/generations")),
                { model: "suno", custom: false, version: "v6", prompt: "" },
                {
                    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
                    signal,
                    timeout: HEALTH_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );
            return interpretNonTextProbe(response.status, response.data);
        } catch (error) {
            return failFromError(error);
        }
    }

    // Seedance TTS / Seed Audio uses async /audio/generations (not OpenAI /audio/speech).
    if (/seedance\.nz/i.test(config.baseUrl) || isSeedAudioModel(config.model || "")) {
        try {
            const response = await axios.post(
                proxyApiUrl(buildApiUrl(config.baseUrl, "/audio/generations")),
                { model: /seed[-_]?audio|doubao/i.test(config.model) ? config.model : "doubao-seed-audio-1.0", prompt: "" },
                {
                    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
                    signal,
                    timeout: HEALTH_TIMEOUT_MS,
                    validateStatus: () => true,
                },
            );
            return interpretNonTextProbe(response.status, response.data);
        } catch (error) {
            return failFromError(error);
        }
    }

    try {
        const response = await axios.post(
            proxyApiUrl(buildApiUrl(config.baseUrl, "/audio/speech")),
            { model: config.model, input: "", voice: "alloy" },
            {
                headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
                signal,
                timeout: HEALTH_TIMEOUT_MS,
                validateStatus: () => true,
            },
        );
        return interpretNonTextProbe(response.status, response.data);
    } catch (error) {
        return failFromError(error);
    }
}

async function probeVideo(config: ReturnType<typeof resolveModelRequestConfig>, signal?: AbortSignal) {
    // AutoDL ComfyUI has no OpenAI /videos route — probing it always 404s and looks like a dead channel.
    if (isAutodlH3ComfyVideoModel(config.model, config.baseUrl) || /autodl\.art/i.test(config.baseUrl)) {
        return probeAutodlComfyVideo(config, signal);
    }

    // Prefer a non-billable /models probe so empty-prompt POSTs don't spam 400 in the console.
    try {
        const modelsResponse = await axios.get(proxyApiUrl(buildApiUrl(config.baseUrl, "/models")), {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal,
            timeout: HEALTH_TIMEOUT_MS,
            validateStatus: () => true,
        });
        if (modelsResponse.status >= 200 && modelsResponse.status < 300) return { ok: true as const };
        if (isAuthFailure(modelsResponse.status, readMessage(modelsResponse.data))) {
            return { ok: false as const, message: readMessage(modelsResponse.data) || `HTTP ${modelsResponse.status}` };
        }
    } catch {
        // Fall through to empty-prompt POST probe.
    }

    const isMetaso = /metaso\.cn/i.test(config.baseUrl);
    // Metaso's OpenAI root accepts MiniMax-H3 (channel model). `sora-2` is only a New API mapping alias.
    // Empty prompt stays a non-billable validation probe (Metaso returns invalid_value, not model_not_found).
    const body = isMetaso
        ? { model: /^sora-2$/i.test(config.model) ? "MiniMax-H3" : config.model || "MiniMax-H3", prompt: "" }
        : { model: config.model, prompt: "" };

    try {
        const response = await axios.post(proxyApiUrl(buildApiUrl(config.baseUrl, "/videos")), body, {
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            signal,
            timeout: HEALTH_TIMEOUT_MS,
            validateStatus: () => true,
        });
        return interpretNonTextProbe(response.status, response.data);
    } catch (error) {
        return failFromError(error);
    }
}

async function probeAutodlComfyVideo(config: ReturnType<typeof resolveModelRequestConfig>, signal?: AbortSignal) {
    try {
        const workflowId = modelOptionName(config.model).trim() || "health-check";
        const token = String(config.apiKey || "").replace(/^Bearer\s+/i, "").trim();
        const response = await axios.post(
            proxyApiUrl(buildApiUrl(config.baseUrl, `/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`)),
            { prompt: "" },
            {
                headers: { Authorization: token, "Content-Type": "application/json" },
                signal,
                timeout: HEALTH_TIMEOUT_MS,
                validateStatus: () => true,
            },
        );
        const message = readMessage(response.data) || `HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) return { ok: false as const, message: apiText("autodlComfyAuthFailed") };
        // Empty prompt / validation errors still mean the route + token are accepted.
        if (response.status >= 200 && response.status < 500) return { ok: true as const, message };
        return { ok: false as const, message };
    } catch (error) {
        return failFromError(error);
    }
}

function assertProbeResponse(status: number, data: unknown) {
    if (status >= 200 && status < 300) return;
    const message = readMessage(data) || `HTTP ${status}`;
    if (isAuthFailure(status, message) || isModelMissing(message) || status === 404) throw new Error(message);
    // Other 4xx after auth often still means the route is reachable for this model.
    if (status >= 400 && status < 500 && !isFatalProbe(message)) return;
    throw new Error(message);
}

function interpretNonTextProbe(status: number, data: unknown) {
    const message = readMessage(data) || `HTTP ${status}`;
    if (status >= 200 && status < 300) return { ok: true as const };
    if (isAuthFailure(status, message) || isModelMissing(message) || (status === 404 && !isValidationFailure(message))) {
        return { ok: false as const, message };
    }
    if (isValidationFailure(message) || (status >= 400 && status < 500)) return { ok: true as const, message };
    return { ok: false as const, message };
}

function interpretOpenSpeechProbe(status: number, raw: string) {
    const message = readOpenSpeechMessage(raw) || `HTTP ${status}`;
    if (status === 401 || status === 403 || /invalid\s*x-api-key|unauthorized|鉴权|permission denied/i.test(message)) {
        return { ok: false as const, message: apiText("openSpeechInvalidKey") };
    }
    if (isModelMissing(message)) return { ok: false as const, message };
    if (status >= 200 && status < 300) {
        // Empty text may still return JSON error chunks with code != 0.
        if (/invalid|empty|required|text/i.test(message) && !/invalid\s*x-api-key/i.test(message)) return { ok: true as const, message };
        if (!message || /code"?\s*:\s*0/.test(raw)) return { ok: true as const };
    }
    if (isValidationFailure(message) || /text|empty|required|param/i.test(message)) return { ok: true as const, message };
    if (status === 404) return { ok: false as const, message };
    if (status >= 400 && status < 500) return { ok: true as const, message };
    return { ok: false as const, message };
}

function failFromError(error: unknown) {
    if (axios.isCancel(error)) return { ok: false as const, message: apiText("requestCanceled") };
    if (axios.isAxiosError(error)) {
        const message = readMessage(error.response?.data) || error.message || apiText("networkFailed");
        return { ok: false as const, message };
    }
    return { ok: false as const, message: error instanceof Error ? error.message : apiText("requestFailed") };
}

function readMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            return readMessage(JSON.parse(value)) || value.slice(0, 200);
        } catch {
            return value.slice(0, 200);
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as {
        message?: unknown;
        msg?: unknown;
        error?: unknown;
        code?: unknown;
        header?: { message?: unknown; msg?: unknown };
    };
    const nested = payload.error;
    const nestedObj = nested && typeof nested === "object" ? (nested as { message?: unknown; code?: unknown; msg?: unknown }) : null;
    const codeHint =
        typeof payload.code === "string"
            ? payload.code
            : typeof nestedObj?.code === "string"
              ? nestedObj.code
              : "";
    const text =
        readMessage(payload.msg) ||
        readMessage(payload.message) ||
        (typeof nested === "string" ? nested : "") ||
        readMessage(nestedObj?.message) ||
        readMessage(nestedObj?.msg) ||
        readMessage(payload.header?.message) ||
        readMessage(payload.header?.msg) ||
        "";
    if (codeHint && text && !text.includes(codeHint)) return `${text} (${codeHint})`;
    return text || codeHint;
}

function readOpenSpeechMessage(raw: string) {
    const match = raw.match(/"message"\s*:\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
    return readMessage(raw);
}

function isAuthFailure(status: number, message: string) {
    return status === 401 || status === 403 || /api key|unauthorized|authentication|invalid\s*x-api-key|鉴权|ak\/sk/i.test(message);
}

function isModelMissing(message: string) {
    return /model_not_found|model[^\n]{0,40}(not\s*found|does\s*not\s*exist|invalid|unknown)|unknown model|模型.*(不存在|无效|未找到)/i.test(message);
}

function isValidationFailure(message: string) {
    return /prompt|text|input|required|empty|blank|invalid\s*param|missing|size|voice|speaker|参数|必填|不能为空/i.test(message);
}

function isFatalProbe(message: string) {
    return isAuthFailure(0, message) || isModelMissing(message) || /not\s*found|接口地址不存在/i.test(message);
}

function isSeedreamLike(model: string) {
    return /seedream/i.test(model);
}

function isVolcArk(baseUrl: string) {
    return /ark\.[a-z0-9-]+\.(volces|bytepluses)\.com|volces\.com\/api\/(plan|coding|v\d+)/i.test(baseUrl);
}

function geminiRoot(baseUrl: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    return lower.endsWith("/v1") || lower.endsWith("/v1beta") ? normalized : `${normalized}/v1beta`;
}

function resolveOpenSpeechUrl(baseUrl: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "").replace(/\/api\/v3\/plan\/tts\//i, "/api/v3/tts/");
    if (/\/tts\/unidirectional(\/sse)?$/i.test(normalized)) return normalized;
    if (/\/api\/v3$/i.test(normalized)) return `${normalized}/tts/unidirectional`;
    return `${normalized}/api/v3/tts/unidirectional`;
}
