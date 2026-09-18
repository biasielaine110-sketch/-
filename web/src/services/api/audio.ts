import axios from "axios";

import i18n from "@/i18n";
import {
    AUTODL_INDEXTTS_EMO_CONTROL_REF_AUDIO,
    AUTODL_INDEXTTS_EMO_CONTROL_SAME_AS_VOICE,
    isAutodlComfyAudioModel,
    isAutodlIndexTtsWorkflow,
} from "@/lib/autodl-comfy-audio";
import {
    audioMimeType,
    isSeedAudioModel,
    isSunoAudioModel,
    normalizeAudioFormatValue,
    normalizeAudioSpeedValue,
    normalizeAudioVoiceValue,
    normalizeSeedAudioFormatValue,
    normalizeSeedAudioSpeakerValue,
    normalizeSunoFlagValue,
    normalizeSunoFormatValue,
    normalizeSunoVersionValue,
    normalizeSunoVocalGenderValue,
} from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { proxyApiUrl } from "@/lib/api-proxy";
import type { ReferenceAudio } from "@/types/media";
import { uploadProviderMediaFile } from "./video";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal; referenceAudios?: ReferenceAudio[] };
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

export type GeneratedAudioPayload = Blob | { remoteUrl: string; mimeType?: string };

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<GeneratedAudioPayload> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    // Keep audio/suno settings from the generation config (node + global), not only channel fields.
    const audioRequestConfig: AiConfig = {
        ...requestConfig,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
        sunoVersion: config.sunoVersion,
        sunoCustom: config.sunoCustom,
        sunoInstrumental: config.sunoInstrumental,
        sunoTitle: config.sunoTitle,
        sunoStyle: config.sunoStyle,
        sunoVocalGender: config.sunoVocalGender,
    };

    // Seedance Suno must use /v1/music/* — never scripts that hit /audio/speech.
    if (isSunoAudioModel(model)) {
        assertAudioConfig(requestConfig, model);
        try {
            return await requestSunoMusic(audioRequestConfig, prompt, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }

    // Seed Audio / Seedance TTS: async /v1/audio/generations (not OpenAI /audio/speech).
    if (isSeedanceNzBaseUrl(requestConfig.baseUrl) || isSeedAudioModel(model)) {
        assertAudioConfig(requestConfig, model);
        try {
            return await requestSeedanceAudioGenerations(audioRequestConfig, prompt, options);
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

    // AutoDL ComfyUI TTS (e.g. indextts2-v1): POST workflow → poll result — not OpenSpeech /audio/speech.
    if (isAutodlComfyAudioModel(model, requestConfig.baseUrl)) {
        try {
            return await requestAutodlComfyAudio(requestConfig, prompt, format, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }

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

function isSeedanceNzBaseUrl(baseUrl: string) {
    return /seedance\.nz/i.test(baseUrl.trim());
}

type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };

/**
 * AutoDL ComfyUI audio (docs: https://autodl.art/docs/comfyui_api/)
 * POST /comfyui/comfyui_workflow/{workflow_id} → poll /result/{task_id}
 * indextts2-v1: prompt_text + prompt_simple (参考音色音频)
 */
async function requestAutodlComfyAudio(config: AiConfig, prompt: string, format: string, options?: RequestOptions): Promise<Blob> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (isOpenSpeechBaseUrl(config.baseUrl)) throw new Error(apiText("autodlComfyWrongBaseUrl"));

    const workflowId = modelOptionName(config.model).trim();
    if (!workflowId) throw new Error(apiText("autodlWorkflowRequired"));

    const text = prompt.trim();
    if (!text) throw new Error(apiText("invalidRequest"));

    const refs = options?.referenceAudios || [];
    if (!refs.length) throw new Error(apiText("autodlIndexTtsRefRequired"));

    const speakerAudio = await resolveAutodlAudioUrl(refs[0], options?.signal);
    if (!speakerAudio) throw new Error(apiText("autodlIndexTtsRefRequired"));

    const token = String(config.apiKey || "").replace(/^Bearer\s+/i, "").trim();
    const headers = { Authorization: token, "Content-Type": "application/json" };

    const body: Record<string, unknown> = isAutodlIndexTtsWorkflow(workflowId)
        ? {
              // Schema: https://autodl.art/api/v1/comfyui/workflows/indextts2-v1
              // emo_control_method / emo_surprised are enums → must be strings.
              prompt_text: text.slice(0, 2048),
              prompt_simple: speakerAudio,
              emo_control_method: AUTODL_INDEXTTS_EMO_CONTROL_SAME_AS_VOICE,
              emo_surprised: "0",
              emo_random: false,
          }
        : {
              prompt: text,
              prompt_text: text,
              text,
              prompt_simple: speakerAudio,
              audio: speakerAudio,
              audio_url: speakerAudio,
          };

    if (refs[1]) {
        const emoAudio = await resolveAutodlAudioUrl(refs[1], options?.signal);
        if (emoAudio) {
            body.emo_ref_audio = emoAudio;
            if (isAutodlIndexTtsWorkflow(workflowId)) {
                body.emo_control_method = AUTODL_INDEXTTS_EMO_CONTROL_REF_AUDIO;
            }
        }
    }

    try {
        const submit = (
            await axios.post<ApiEnvelope<{ task_id?: string; status?: string; message?: string }>>(
                aiApiUrl(config, `/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`),
                body,
                { headers, signal: options?.signal },
            )
        ).data;
        const submitCode = submit && typeof submit === "object" && "code" in submit ? String((submit as { code?: unknown }).code || "") : "";
        if (submitCode && !/^success$/i.test(submitCode)) {
            throw new Error(readApiErrorMessage(submit) || apiText("audioGenerationFailed"));
        }
        const taskId =
            (submit && typeof submit === "object" && "data" in submit ? (submit as { data?: { task_id?: string } }).data?.task_id : undefined) ||
            (submit && typeof submit === "object" && "task_id" in submit ? (submit as { task_id?: string }).task_id : undefined);
        if (!taskId) throw new Error(readApiErrorMessage(submit) || apiText("autodlNoTaskId"));

        const deadline = performance.now() + 15 * 60 * 1000;
        for (;;) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const state = (
                await axios.get<ApiEnvelope<{ status?: string; results?: unknown[]; message?: string }>>(
                    aiApiUrl(config, `/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`),
                    { headers: { Authorization: token }, signal: options?.signal },
                )
            ).data;
            const data =
                state && typeof state === "object" && "data" in state && (state as { data?: unknown }).data
                    ? ((state as { data: Record<string, unknown> }).data as Record<string, unknown>)
                    : (state as Record<string, unknown>);
            const status = String(data?.status || "");
            if (/^failed|failure$/i.test(status)) {
                throw new Error(readApiErrorMessage(state) || readApiErrorMessage(data) || apiText("autodlTaskFailed"));
            }
            if (/^success|completed$/i.test(status)) {
                const url = readAutodlResultUrl(data?.results);
                if (!url) throw new Error(apiText("autodlNoResults"));
                const response = await axios.get<Blob>(proxyApiUrl(url), { responseType: "blob", signal: options?.signal });
                const mime = response.data.type?.startsWith("audio/") ? response.data.type : audioMimeType(format === "wav" ? "wav" : format);
                return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: mime });
            }
            if (performance.now() >= deadline) throw new Error(apiText("videoTaskTimedOut"));
            await sleep(2000, options?.signal);
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
            throw new Error(apiText("autodlComfyAuthFailed"));
        }
        throw error instanceof Error ? error : new Error(apiText("audioGenerationFailed"));
    }
}

function readAutodlResultUrl(results: unknown): string {
    if (!Array.isArray(results)) return "";
    for (const item of results) {
        if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const url = [record.url, record.audio_url, record.file_url, record.video_url, record.image_url].find(
            (value) => typeof value === "string" && /^https?:\/\//i.test(value),
        );
        if (typeof url === "string") return url;
    }
    return "";
}

async function resolveAutodlAudioUrl(audio: ReferenceAudio, signal?: AbortSignal): Promise<string> {
    const source = (audio.url || "").trim();
    if (!source) return "";
    if (/^https?:\/\//i.test(source) && !/^blob:/i.test(source)) return source;
    if (source.startsWith("data:")) return source;
    const response = await axios.get<Blob>(proxyApiUrl(source), { responseType: "blob", signal });
    const blob = response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audio.type || "audio/mpeg" });
    return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read audio"));
        reader.readAsDataURL(blob);
    });
}

const SEEDANCE_AUDIO_POLL_INTERVAL_MS = 3_000;
const SEEDANCE_AUDIO_MAX_WAIT_MS = 10 * 60_000;

/** Seedance: POST /v1/audio/generations + poll (not OpenAI /audio/speech). */
async function requestSeedanceAudioGenerations(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const text = ensureSeedAudioPrompt(prompt);
    const model = resolveSeedanceAudioModel(config.model);
    const format = mapSeedanceAudioFormat(normalizeSeedAudioFormatValue(config.audioFormat));
    const speechRate = mapSeedanceSpeechRate(Number(normalizeAudioSpeedValue(config.audioSpeed)));
    const referenceAudios = (options?.referenceAudios || []).slice(0, 3);
    const referenceUrls = referenceAudios.length ? await resolveSeedanceReferenceAudioUrls(config, referenceAudios, options) : [];

    // Docs: speaker / audio_url / images are mutually exclusive. Only use other-node refs as audio_url.
    const metadata: Record<string, unknown> = {
        format,
        sample_rate: "24000",
        speech_rate: speechRate,
    };
    if (referenceUrls.length) {
        metadata.audio_url = referenceUrls.length === 1 ? referenceUrls[0] : referenceUrls;
    } else {
        const speaker = resolveSeedanceSpeaker(normalizeSeedAudioSpeakerValue(config.audioVoice || ""), config.audioInstructions || "");
        // Omit speaker for prompt-described / multi-character Seed Audio scenes.
        if (speaker && !/^(auto|none)$/i.test(speaker)) metadata.speaker = speaker;
    }

    const body: Record<string, unknown> = {
        model,
        prompt: text,
        metadata,
    };

    let submit;
    try {
        submit = await axios.post(aiApiUrl(config, "/audio/generations"), body, {
            headers: aiHeaders(config),
            signal: options?.signal,
            transformResponse: [(data) => data],
        });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }

    const submitPayload = coerceJsonPayload(submit.data);
    if (!submitPayload) throw new Error(apiText("audioGenerationFailed"));
    if (isSunoApiFailureCode(submitPayload.code as number | string | undefined)) {
        throw new Error(readApiErrorMessage(submitPayload) || apiText("audioGenerationFailed"));
    }

    const taskId = readSunoTaskId(submitPayload as { data?: Array<{ task_id?: string; id?: string }> | { task_id?: string; id?: string }; task_id?: string; id?: string });
    if (!taskId) throw new Error(readApiErrorMessage(submitPayload) || apiText("audioGenerationFailed"));

    const started = Date.now();
    while (Date.now() - started < SEEDANCE_AUDIO_MAX_WAIT_MS) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await sleep(SEEDANCE_AUDIO_POLL_INTERVAL_MS, options?.signal);

        let poll;
        try {
            poll = await axios.get(aiApiUrl(config, `/audio/generations/${encodeURIComponent(taskId)}`), {
                headers: aiHeaders(config),
                signal: options?.signal,
                transformResponse: [(data) => data],
            });
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }

        const pollPayload = coerceJsonPayload(poll.data);
        if (!pollPayload) throw new Error(apiText("audioGenerationFailed"));
        if (isSunoApiFailureCode(pollPayload.code as number | string | undefined)) {
            throw new Error(readApiErrorMessage(pollPayload) || apiText("audioGenerationFailed"));
        }

        const data = (pollPayload.data && typeof pollPayload.data === "object" && !Array.isArray(pollPayload.data) ? pollPayload.data : pollPayload) as Record<string, unknown>;
        const nested = data.data && typeof data.data === "object" && !Array.isArray(data.data) ? (data.data as Record<string, unknown>) : null;
        const status = String(data.status || nested?.status || "").toLowerCase().replace(/_/g, "");
        if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) {
            const reason =
                (typeof data.fail_reason === "string" && data.fail_reason) ||
                (typeof nested?.fail_reason === "string" && nested.fail_reason) ||
                readApiErrorMessage(pollPayload) ||
                readApiErrorMessage(data) ||
                "";
            throw new Error(reason || apiText("audioGenerationFailed"));
        }

        const audioUrl = readSeedanceAudioUrl(data) || (nested ? readSeedanceAudioUrl(nested) : "") || readSeedanceAudioUrl(pollPayload);
        if (audioUrl) {
            try {
                const response = await axios.get<Blob>(proxyApiUrl(audioUrl), { responseType: "blob", signal: options?.signal });
                const mime = audioMimeType(format === "ogg_opus" ? "opus" : format);
                const blob = response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: mime });
                await assertAudioBlob(blob);
                return blob;
            } catch (error) {
                // Signed CDN URLs sometimes reject Authorization forwarding; retry direct once.
                if (axios.isAxiosError(error) && error.response && /^https?:\/\//i.test(audioUrl)) {
                    const response = await axios.get<Blob>(audioUrl, { responseType: "blob", signal: options?.signal });
                    const mime = audioMimeType(format === "ogg_opus" ? "opus" : format);
                    return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: mime });
                }
                throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
            }
        }
        if (["success", "succeeded", "completed", "complete"].includes(status)) {
            throw new Error(apiText("audioGenerationFailed"));
        }
    }

    throw new Error(apiText("audioGenerationFailed"));
}

async function resolveSeedanceReferenceAudioUrls(config: AiConfig, audios: ReferenceAudio[], options?: RequestOptions) {
    const urls: string[] = [];
    for (const audio of audios) {
        const source = (audio.url || "").trim();
        if (!source) continue;
        if (/^https?:\/\//i.test(source) && !/^blob:/i.test(source) && !source.startsWith("data:")) {
            urls.push(source);
            continue;
        }
        const response = await axios.get<Blob>(proxyApiUrl(source), { responseType: "blob", signal: options?.signal });
        const blob = response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audio.type || "audio/mpeg" });
        const uploaded = await uploadProviderMediaFile(config, blob, audio.name || "reference.mp3", options);
        if (uploaded) urls.push(uploaded);
    }
    return urls;
}

/** Seedance requires prompt length 5–2048; short Chinese TTS lines like「你好」need padding. */
function ensureSeedAudioPrompt(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error(apiText("invalidRequest"));
    if (trimmed.length >= 5) return trimmed.slice(0, 2048);
    return `${trimmed}${"。".repeat(5 - trimmed.length)}`.slice(0, 2048);
}

function resolveSeedanceAudioModel(model: string) {
    const trimmed = model.trim();
    // Seedance has no OpenAI-compatible /audio/speech; map common OpenAI TTS ids to Seed Audio.
    if (!trimmed || /^(gpt-.*tts|tts-1(\.hd)?|openai)/i.test(trimmed)) return "doubao-seed-audio-1.0";
    // Normalize EvoLink-style doubao-seed-audio-1-0 → Seedance doubao-seed-audio-1.0
    if (/^doubao[-_]?seed[-_]?audio[-_]?1([-_]0)?$/i.test(trimmed)) return "doubao-seed-audio-1.0";
    if (/^seed[-_]?audio[-_]?1([-_.]0)?$/i.test(trimmed)) return "doubao-seed-audio-1.0";
    return trimmed;
}

function resolveSeedanceSpeaker(voice: string, instructions: string) {
    const hint = instructions.trim();
    if (hint && (/^(zh_|en_|multi_|saturn_|ICL_)/i.test(hint) || /_bigtts|_tob|_uranus|_moon|_mars/i.test(hint))) return hint;
    const normalized = normalizeSeedAudioSpeakerValue(voice);
    if (/^(auto|none)$/i.test(normalized)) return "";
    return normalized;
}

function mapSeedanceAudioFormat(format: string) {
    if (format === "opus") return "ogg_opus";
    if (format === "wav" || format === "mp3" || format === "pcm") return format;
    return "mp3";
}

function mapSeedanceSpeechRate(speed: number) {
    if (!Number.isFinite(speed)) return 0;
    return Math.max(-50, Math.min(100, Math.round((speed - 1) * 50)));
}

function readSeedanceAudioUrl(payload: Record<string, unknown>): string {
    const directKeys = ["result_url", "audio_url", "output_url", "url", "file_url"] as const;
    for (const key of directKeys) {
        const value = payload[key];
        if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    }
    if (Array.isArray(payload.audio_urls) && typeof payload.audio_urls[0] === "string" && payload.audio_urls[0]) return payload.audio_urls[0];

    const nested = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : null;
    if (nested) {
        const nestedUrl: string = readSeedanceAudioUrl(nested);
        if (nestedUrl) return nestedUrl;
    }

    const content = payload.content && typeof payload.content === "object" && !Array.isArray(payload.content) ? (payload.content as Record<string, unknown>) : null;
    if (content) {
        if (typeof content.audio_url === "string" && content.audio_url) return content.audio_url;
        if (Array.isArray(content.audio_urls) && typeof content.audio_urls[0] === "string") return content.audio_urls[0];
        for (const key of directKeys) {
            const value = content[key];
            if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
        }
    }
    return "";
}

async function requestSunoMusic(config: AiConfig, prompt: string, options?: RequestOptions): Promise<GeneratedAudioPayload> {
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
    let terminalMisses = 0;
    while (Date.now() - started < SUNO_MAX_WAIT_MS) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await sleep(SUNO_POLL_INTERVAL_MS, options?.signal);

        let poll;
        try {
            poll = await axios.get(aiApiUrl(config, `/music/tasks/${encodeURIComponent(taskId)}`), {
                headers: aiHeaders(config),
                signal: options?.signal,
                timeout: 25_000,
                transformResponse: [(data) => data],
            });
        } catch (error) {
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            continue;
        }

        const pollPayload = coerceJsonPayload(poll.data) as {
            code?: number | string;
            msg?: string;
            message?: string;
            data?: SunoTaskPayload;
        } | null;
        // One bad poll (proxy timeout / empty body) must not abandon a task the backend already accepted.
        if (!pollPayload) continue;

        if (isSunoApiFailureCode(pollPayload.code)) {
            throw new Error(readApiErrorMessage(pollPayload) || apiText("audioGenerationFailed"));
        }

        const payload = unwrapSunoTask(pollPayload);
        const status = normalizeSunoStatus(payload?.status);
        if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) {
            throw new Error(readSunoErrorMessage(payload) || readApiErrorMessage(pollPayload) || apiText("audioGenerationFailed"));
        }

        const audioUrl = readSunoAudioUrl(payload);
        const progress = Number(payload?.progress);
        const finished = ["completed", "complete", "success", "succeeded", "done", "finished"].includes(status) || (Number.isFinite(progress) && progress >= 100 && Boolean(audioUrl));
        if (finished && !audioUrl) {
            terminalMisses += 1;
            if (terminalMisses >= 6) throw new Error(apiText("audioGenerationFailed"));
            continue;
        }
        if (!finished || !audioUrl) continue;

        const mime = audioMimeType(outputFormat);
        const blob = await downloadSunoAudio(audioUrl, mime, options?.signal);
        if (blob) return blob;
        return { remoteUrl: audioUrl, mimeType: mime };
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

type SunoTrack = Record<string, unknown> & { audio_url?: string; audioUrl?: string; url?: string; status?: string };
type SunoTaskPayload = {
    status?: string;
    progress?: number | string;
    error?: string | { message?: string };
    message?: string;
    result?: { music?: SunoTrack[]; clips?: SunoTrack[]; songs?: SunoTrack[] };
    music?: SunoTrack[];
    clips?: SunoTrack[];
    songs?: SunoTrack[];
    data?: SunoTrack[] | SunoTaskPayload;
    response?: { sunoData?: SunoTrack[]; data?: SunoTrack[] };
};

function normalizeSunoStatus(value: unknown) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
}

function unwrapSunoTask(payload: { data?: SunoTaskPayload } | null | undefined): SunoTaskPayload | undefined {
    const data = payload?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const nested = data.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && (nested.status || nested.result || nested.response || nested.music)) {
        return { ...data, ...nested };
    }
    return data;
}

function collectSunoTracks(payload: SunoTaskPayload | undefined) {
    if (!payload) return [] as SunoTrack[];
    const buckets = [
        payload.result?.music,
        payload.result?.clips,
        payload.result?.songs,
        payload.music,
        payload.clips,
        payload.songs,
        payload.response?.sunoData,
        payload.response?.data,
        Array.isArray(payload.data) ? payload.data : undefined,
    ];
    return buckets.flatMap((list) => (Array.isArray(list) ? list : []));
}

function readTrackAudioUrl(track: SunoTrack) {
    const keys = ["audio_url", "audioUrl", "source_audio_url", "sourceAudioUrl", "download_url", "downloadUrl", "file_url", "url", "stream_audio_url", "streamAudioUrl"];
    for (const key of keys) {
        const value = track[key];
        if (typeof value === "string" && /^https?:\/\//i.test(value) && !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(value)) return value;
    }
    return "";
}

async function downloadSunoAudio(url: string, mime: string, signal?: AbortSignal) {
    const attempts = [() => axios.get<Blob>(proxyApiUrl(url), { responseType: "blob", signal, timeout: 90_000 }), () => axios.get<Blob>(url, { responseType: "blob", signal, timeout: 90_000 })];
    for (const attempt of attempts) {
        try {
            const response = await attempt();
            const blob = response.data;
            if (!blob || blob.size < 64 || blob.type.includes("json") || blob.type.includes("html")) continue;
            return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: mime });
        } catch (error) {
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        }
    }
    return null;
}

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
    const record = payload as { taskId?: string };
    if (typeof record.taskId === "string" && record.taskId) return record.taskId;
    const data = payload.data;
    if (Array.isArray(data)) return data[0]?.task_id || data[0]?.id || "";
    if (data && typeof data === "object") return data.task_id || data.id || "";
    return "";
}

function readSunoAudioUrl(payload: SunoTaskPayload | undefined) {
    const tracks = collectSunoTracks(payload);
    const ready = tracks.find((track) => {
        const status = normalizeSunoStatus(track.status);
        return Boolean(readTrackAudioUrl(track)) && (!status || ["complete", "completed", "success", "succeeded", "done", "finished"].includes(status));
    });
    const track = ready || tracks.find((item) => readTrackAudioUrl(item));
    return track ? readTrackAudioUrl(track) : "";
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
    const apiKey = config.apiKey.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
    if (!apiKey) throw new Error(apiText("openSpeechInvalidKey"));
    // AutoDL ComfyUI tokens / Ark keys use different auth; OpenSpeech only accepts Doubao Speech X-Api-Key.
    if (/^ark-/i.test(apiKey) || /autodl\.art/i.test(config.baseUrl)) {
        throw new Error(apiText("openSpeechInvalidKey"));
    }
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
                "X-Api-Key": apiKey,
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

export async function storeGeneratedAudio(input: GeneratedAudioPayload, format = "mp3"): Promise<UploadedFile> {
    if (!(input instanceof Blob)) {
        try {
            return await uploadMediaFile(input.remoteUrl, "audio");
        } catch {
            return { url: input.remoteUrl, storageKey: "", bytes: 0, mimeType: input.mimeType || audioMimeType(format) };
        }
    }
    const audio = input.type.startsWith("audio/") ? input : new Blob([input], { type: audioMimeType(format) });
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
        const statusMsg = statusMessage(error.response?.status, fallback, typeof error.config?.url === "string" ? error.config.url : "");
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || readNetworkMessage(error.message) || error.message : fallback;
}

function readNetworkMessage(message: string) {
    return /failed to fetch|network error|load failed|net::err_/i.test(message) ? apiText("networkFailed") : null;
}

function statusMessage(status: number | undefined, fallback: string, requestUrl = "") {
    if (status === 401 || status === 403) {
        const decoded = (() => {
            try {
                return decodeURIComponent(requestUrl);
            } catch {
                return requestUrl;
            }
        })();
        if (/openspeech\.bytedance\.com/i.test(requestUrl) || /openspeech\.bytedance\.com/i.test(decoded)) {
            return apiText("openSpeechInvalidKey");
        }
        if (/autodl\.art/i.test(requestUrl) || /autodl\.art/i.test(decoded)) {
            return apiText("autodlComfyAuthFailed");
        }
        return apiText("authenticationFailed");
    }
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 400) return apiText("invalidRequest");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}
