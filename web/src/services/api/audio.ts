import axios from "axios";

import i18n from "@/i18n";
import {
    audioMimeType,
    isSunoAudioModel,
    normalizeAudioFormatValue,
    normalizeAudioSpeedValue,
    normalizeAudioVoiceValue,
    normalizeSunoFlagValue,
    normalizeSunoFormatValue,
    normalizeSunoVersionValue,
    normalizeSunoVocalGenderValue,
} from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { proxyApiUrl } from "@/lib/api-proxy";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
const SUNO_POLL_INTERVAL_MS = 4_000;
const SUNO_MAX_WAIT_MS = 15 * 60_000;

function aiApiUrl(config: AiConfig, path: string) {
    return proxyApiUrl(buildApiUrl(config.baseUrl, path));
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    // Keep suno settings from the generation config (node + global), not only channel fields.
    const sunoConfig: AiConfig = {
        ...requestConfig,
        sunoVersion: config.sunoVersion,
        sunoCustom: config.sunoCustom,
        sunoInstrumental: config.sunoInstrumental,
        sunoTitle: config.sunoTitle,
        sunoStyle: config.sunoStyle,
        sunoVocalGender: config.sunoVocalGender,
        audioFormat: config.audioFormat,
        audioInstructions: config.audioInstructions,
    };

    // Seedance Suno must use /v1/music/* — never scripts that hit /audio/speech.
    if (isSunoAudioModel(model)) {
        assertAudioConfig(requestConfig, model);
        try {
            return await requestSunoMusic(sunoConfig, prompt, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }

    const script = resolveModelScript(config, config.model || config.audioModel);
    if (script) {
        if (!model) throw new Error(apiText("audioModelRequired"));
        if (!requestConfig.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
        if (!requestConfig.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
        try {
            const result = await runModelPlugin({
                capability: "audio",
                script,
                config: requestConfig,
                prompt,
                params: { voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: normalizeAudioSpeedValue(config.audioSpeed), instructions: config.audioInstructions.trim() },
                signal: options?.signal,
            });
            return await audioPluginBlob(result, format);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }
    assertAudioConfig(requestConfig, model);
    const instructions = config.audioInstructions.trim();

    if (isOpenSpeechBaseUrl(requestConfig.baseUrl)) {
        try {
            return await requestOpenSpeechTts(requestConfig, prompt, {
                model,
                format,
                voice: config.audioVoice,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                instructions,
            }, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }

    try {
        const response = await axios.post<Blob>(
            aiApiUrl(requestConfig, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }
}

function isOpenSpeechBaseUrl(baseUrl: string) {
    return /openspeech\.bytedance\.com/i.test(baseUrl.trim());
}

async function requestSunoMusic(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const custom = normalizeSunoFlagValue(config.sunoCustom) === "true";
    const instrumental = normalizeSunoFlagValue(config.sunoInstrumental) === "true";
    const version = normalizeSunoVersionValue(config.sunoVersion || "");
    const style = (config.sunoStyle || "").trim();
    const title = (config.sunoTitle || "").trim();
    const vocalGender = normalizeSunoVocalGenderValue(config.sunoVocalGender || "");
    const outputFormat = normalizeSunoFormatValue(config.audioFormat);
    const maxPrompt = custom ? 5000 : 3000;
    const text = prompt.trim().slice(0, maxPrompt);

    // Inspo: prompt required. Custom+vocal: lyrics required. Custom+instrumental: prompt optional.
    if (!custom && !text) throw new Error(apiText("sunoPromptRequired"));
    if (custom && !instrumental && !text) throw new Error(apiText("sunoLyricsRequired"));

    // Match Seedance Generate music example exactly (inspo).
    const body: Record<string, unknown> = {
        model: "suno",
        custom,
        version,
        prompt: text || undefined,
    };
    if (!body.prompt) delete body.prompt;
    if (instrumental) body.instrumental = true;
    if (custom && title) body.title = title.slice(0, 80);
    if (custom && style) body.style = style.slice(0, 1000);
    if (vocalGender && !instrumental) body.vocal_gender = vocalGender;
    if (outputFormat && outputFormat !== "mp3") body.output_format = outputFormat;

    let submit;
    try {
        submit = await axios.post(aiApiUrl(config, "/music/generations"), body, {
            headers: aiHeaders(config),
            signal: options?.signal,
            // Keep raw text so we can recover JSON even if a proxy left a binary prefix.
            transformResponse: [(data) => data],
        });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }

    const submitPayload = coerceJsonPayload(submit.data) as {
        code?: number | string;
        msg?: string;
        message?: string;
        data?: Array<{ task_id?: string; id?: string; status?: string }> | { task_id?: string; id?: string };
        task_id?: string;
        id?: string;
    } | null;
    if (!submitPayload) throw new Error(apiText("audioGenerationFailed"));

    if (isSunoApiFailureCode(submitPayload.code)) {
        throw new Error(readApiErrorMessage(submitPayload) || apiText("audioGenerationFailed"));
    }

    const taskId = readSunoTaskId(submitPayload);
    if (!taskId) throw new Error(readApiErrorMessage(submitPayload) || apiText("audioGenerationFailed"));

    const started = Date.now();
    while (Date.now() - started < SUNO_MAX_WAIT_MS) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await sleep(SUNO_POLL_INTERVAL_MS, options?.signal);

        let poll;
        try {
            poll = await axios.get(aiApiUrl(config, `/music/tasks/${encodeURIComponent(taskId)}`), {
                headers: aiHeaders(config),
                signal: options?.signal,
                transformResponse: [(data) => data],
            });
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }

        const pollPayload = coerceJsonPayload(poll.data) as {
            code?: number | string;
            msg?: string;
            message?: string;
            data?: SunoTaskPayload;
        } | null;
        if (!pollPayload) throw new Error(apiText("audioGenerationFailed"));

        if (isSunoApiFailureCode(pollPayload.code)) {
            throw new Error(readApiErrorMessage(pollPayload) || apiText("audioGenerationFailed"));
        }

        const payload = pollPayload.data;
        const status = String(payload?.status || "").toLowerCase();
        if (["failed", "error", "cancelled", "canceled"].includes(status)) {
            throw new Error(readSunoErrorMessage(payload) || readApiErrorMessage(pollPayload) || apiText("audioGenerationFailed"));
        }

        const audioUrl = readSunoAudioUrl(payload);
        const finished = ["completed", "complete", "success"].includes(status) || Boolean(payload?.result?.music?.some((track) => track.audio_url || track.audioUrl || track.url));
        if (!finished) continue;
        if (!audioUrl) throw new Error(apiText("audioGenerationFailed"));

        const response = await axios.get<Blob>(proxyApiUrl(audioUrl), { responseType: "blob", signal: options?.signal });
        const mime = audioMimeType(outputFormat);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: mime });
    }

    throw new Error(apiText("audioGenerationFailed"));
}

/** Normalize axios payloads that may arrive as compressed/binary-prefixed text. */
function coerceJsonPayload(data: unknown): Record<string, unknown> | null {
    if (data == null) return null;
    if (typeof data === "object" && !Array.isArray(data) && !(data instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && data instanceof Blob) && !ArrayBuffer.isView(data)) {
        return data as Record<string, unknown>;
    }

    let text = "";
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as ArrayBufferView);
    else return null;

    const trimmed = text.replace(/^\uFEFF/, "").trim();
    if (!trimmed) return null;

    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        // Proxy/compression bugs can leave binary bytes before the JSON object.
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(trimmed.slice(start, end + 1));
                return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
            } catch {
                return null;
            }
        }
        return null;
    }
}

function isSunoApiFailureCode(code: number | string | undefined) {
    if (code === undefined || code === null || code === "") return false;
    if (typeof code === "number") return code !== 200 && code !== 0;
    const normalized = String(code).toLowerCase();
    return normalized !== "200" && normalized !== "0" && normalized !== "ok" && normalized !== "success";
}

type SunoTrack = { audio_url?: string; audioUrl?: string; url?: string; status?: string };
type SunoTaskPayload = {
    status?: string;
    error?: string | { message?: string };
    message?: string;
    result?: { music?: SunoTrack[] };
    music?: SunoTrack[];
};

function readSunoErrorMessage(payload: SunoTaskPayload | undefined) {
    const error = payload?.error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) return error.message;
    if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
    return "";
}

function readSunoTaskId(payload: { data?: Array<{ task_id?: string; id?: string }> | { task_id?: string; id?: string }; task_id?: string; id?: string } | undefined) {
    if (!payload) return "";
    if (typeof payload.task_id === "string" && payload.task_id) return payload.task_id;
    if (typeof payload.id === "string" && payload.id) return payload.id;
    const data = payload.data;
    if (Array.isArray(data)) return data[0]?.task_id || data[0]?.id || "";
    if (data && typeof data === "object") return data.task_id || data.id || "";
    return "";
}

function readSunoAudioUrl(payload: SunoTaskPayload | undefined) {
    const tracks = payload?.result?.music || payload?.music || [];
    const ready = tracks.find((track) => {
        const status = String(track.status || "").toLowerCase();
        return Boolean(track.audio_url || track.audioUrl || track.url) && (!status || ["complete", "completed", "success"].includes(status));
    });
    const track = ready || tracks.find((item) => item.audio_url || item.audioUrl || item.url);
    return track?.audio_url || track?.audioUrl || track?.url || "";
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = globalThis.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            globalThis.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function resolveOpenSpeechTtsUrl(baseUrl: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    // Official V3 path is /api/v3/tts/unidirectional (no /plan/). Rewrite mistaken Plan-style URLs.
    const withoutMistakenPlan = normalized.replace(/\/api\/v3\/plan\/tts\//i, "/api/v3/tts/");
    if (/\/tts\/unidirectional(\/sse)?$/i.test(withoutMistakenPlan)) return withoutMistakenPlan;
    if (/\/api\/v3$/i.test(withoutMistakenPlan)) return `${withoutMistakenPlan}/tts/unidirectional`;
    return `${withoutMistakenPlan}/api/v3/tts/unidirectional`;
}

function resolveOpenSpeechResourceAndSpeaker(model: string, voice: string, instructions: string) {
    const trimmedModel = model.trim();
    const hint = instructions.trim();
    const modelIsResource = /^seed-(tts|icl)/i.test(trimmedModel) || /volc\.(service_type|megatts)/i.test(trimmedModel);
    const speakerFromHint = hint && (/^(zh_|en_|multi_|saturn_|ICL_)/i.test(hint) || /_bigtts|_tob|_uranus|_moon/i.test(hint)) ? hint : "";
    const speakerFromModel = !modelIsResource && trimmedModel ? trimmedModel : "";
    const speakerFromVoice = /^(zh_|en_|multi_)/i.test(voice) ? voice : "";
    return {
        resourceId: modelIsResource ? trimmedModel : "seed-tts-2.0",
        speaker: speakerFromHint || speakerFromModel || speakerFromVoice || "zh_female_vv_uranus_bigtts",
    };
}

function mapOpenSpeechFormat(format: string) {
    if (format === "opus") return "ogg_opus";
    if (format === "pcm") return "pcm";
    return "mp3";
}

function mapOpenSpeechRate(speed: number) {
    return Math.max(-50, Math.min(100, Math.round((speed - 1) * 50)));
}

async function requestOpenSpeechTts(
    config: AiConfig,
    prompt: string,
    options: { model: string; format: string; voice: string; speed: number; instructions: string },
    requestOptions?: RequestOptions,
) {
    const { resourceId, speaker } = resolveOpenSpeechResourceAndSpeaker(options.model, options.voice, options.instructions);
    const audioFormat = mapOpenSpeechFormat(options.format);
    const response = await axios.post<string>(
        proxyApiUrl(resolveOpenSpeechTtsUrl(config.baseUrl)),
        {
            user: { uid: "infinite-atelier" },
            req_params: {
                text: prompt,
                speaker,
                audio_params: {
                    format: audioFormat,
                    sample_rate: 24000,
                    speech_rate: mapOpenSpeechRate(options.speed),
                },
            },
        },
        {
            headers: {
                "Content-Type": "application/json",
                "X-Api-Key": config.apiKey.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim(),
                "X-Api-Resource-Id": resourceId,
                "X-Api-Request-Id": typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
            },
            responseType: "text",
            signal: requestOptions?.signal,
            // OpenSpeech streams concatenated JSON objects; keep full body as text.
            transformResponse: [(data) => data],
        },
    );
    const bytes = parseOpenSpeechAudioChunks(String(response.data || ""));
    if (!bytes.length) throw new Error(apiText("scriptNoAudio"));
    return new Blob([bytes], { type: audioMimeType(audioFormat === "ogg_opus" ? "opus" : audioFormat) });
}

function parseOpenSpeechAudioChunks(payload: string) {
    const chunks: Uint8Array[] = [];
    let depth = 0;
    let start = -1;
    for (let index = 0; index < payload.length; index += 1) {
        const char = payload[index];
        if (char === "{") {
            if (depth === 0) start = index;
            depth += 1;
            continue;
        }
        if (char !== "}" || depth === 0) continue;
        depth -= 1;
        if (depth !== 0 || start < 0) continue;
        const raw = payload.slice(start, index + 1);
        start = -1;
        try {
            const item = JSON.parse(raw) as { code?: number; message?: string; msg?: string; data?: string };
            if (typeof item.code === "number" && item.code !== 0 && !item.data) {
                throw new Error(item.message || item.msg || apiText("audioGenerationFailed"));
            }
            if (typeof item.data === "string" && item.data) {
                const binary = atob(item.data);
                const bytes = new Uint8Array(binary.length);
                for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
                chunks.push(bytes);
            }
        } catch (error) {
            if (error instanceof Error && error.message && error.message !== apiText("audioGenerationFailed")) {
                // skip malformed intermediate fragments unless they carry a business error
                if (/code|message|msg/i.test(raw) && /"code"\s*:\s*(?!0)/.test(raw)) throw error;
            } else if (error instanceof Error) {
                throw error;
            }
        }
    }
    if (!chunks.length) return new Uint8Array();
    const total = chunks.reduce((sum, item) => sum + item.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((item) => {
        merged.set(item, offset);
        offset += item.length;
    });
    return merged;
}

async function audioPluginBlob(result: unknown, format: string): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error(apiText("scriptNoAudio"));
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const blob = await (await fetch(url)).blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("audioModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiAudioUnsupported"));
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("audioGenerationFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as {
        msg?: unknown;
        message?: unknown;
        error?: unknown;
        detail?: unknown;
        code?: unknown;
        header?: { code?: unknown; message?: unknown; msg?: unknown };
    };
    const headerMsg = payload.header?.message || payload.header?.msg;
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : readApiErrorMessage(payload.error);
    const raw =
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(headerMsg) ||
        (typeof errorMsg === "string" ? errorMsg : "") ||
        readApiErrorMessage(payload.detail) ||
        "";
    if (/invalid\s*x-api-key/i.test(raw)) {
        return `${apiText("openSpeechInvalidKey")}\n${raw}`;
    }
    // Prefer explicit message; if only a machine code exists, still surface it.
    if (raw) return raw;
    if (typeof payload.code === "string" && payload.code.trim() && !/^\d+$/.test(payload.code.trim())) {
        return payload.code.trim();
    }
    return "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response) {
            const url = typeof error.config?.url === "string" ? error.config.url : "";
            const hint = url ? `\n${url}` : "";
            return error.code === "ERR_NETWORK" ? `${apiText("corsRequired")}${hint}` : `${apiText("networkFailed")}${hint}`;
        }
        const responseData = error.response?.data;
        const apiMsg = readApiErrorMessage(coerceJsonPayload(responseData) || responseData);
        if (apiMsg) return apiMsg;
        if (typeof responseData === "string" && responseData.trim()) {
            const coerced = coerceJsonPayload(responseData);
            if (coerced) {
                const fromJson = readApiErrorMessage(coerced);
                if (fromJson) return fromJson;
            }
            // Avoid showing binary garbage prefixes from mis-decoded proxy bodies.
            const start = responseData.indexOf("{");
            if (start >= 0) return responseData.slice(start, start + 500);
            return responseData.trim().slice(0, 500);
        }
        if (responseData && typeof responseData === "object") {
            try {
                const raw = JSON.stringify(responseData);
                if (raw && raw !== "{}") return raw.slice(0, 500);
            } catch {
                // ignore
            }
        }
        const statusMsg = statusMessage(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || readNetworkMessage(error.message) || error.message : fallback;
}

function readNetworkMessage(message: string) {
    return /failed to fetch|network error|load failed|net::err_/i.test(message) ? apiText("networkFailed") : null;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 400) return apiText("invalidRequest");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}
