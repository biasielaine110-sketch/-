import axios from "axios";

import i18n from "@/i18n";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { proxyApiUrl } from "@/lib/api-proxy";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

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
        header?: { code?: unknown; message?: unknown; msg?: unknown };
    };
    const headerMsg = payload.header?.message || payload.header?.msg;
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    const raw =
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(headerMsg) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        "";
    if (/invalid\s*x-api-key/i.test(raw)) {
        return `${apiText("openSpeechInvalidKey")}\n${raw}`;
    }
    return raw;
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
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
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
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}
