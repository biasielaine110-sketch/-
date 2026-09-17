import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import {
    AUTODL_H3_BLANK_AUDIO_URL,
    autodlH3DurationSeconds,
    autodlH3SupportsRefAudio,
    isAutodlH3ComfyVideoModel,
    normalizeAutodlH3Duration,
    normalizeAutodlH3Resolution,
    shouldUseAutodlComfyVideoBuiltin,
} from "@/lib/autodl-h3-comfy";
import { dataUrlToFile, compressReferenceDataUrl, getDataUrlByteSize } from "@/lib/image-utils";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { resolveApiTransport, proxyApiUrl } from "@/lib/api-proxy";
import { parseComfyApiWorkflow, runNativeComfyUiJob, shouldUseNativeComfyUi } from "@/lib/comfyui-native";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal; referenceAudios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return proxyApiUrl(buildApiUrl(config.baseUrl, path));
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, options);
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 119) throw new Error(apiText("videoTimeout", { provider: "" }));
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    // Metaso MiniMax-H3 must use OpenAI /videos before any AutoDL ComfyUI heuristic.
    if (isMetasoH3Video(requestConfig, selectedModel)) {
        assertVideoConfig(requestConfig, requestConfig.model);
        return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
    }
    // Built-in AutoDL ComfyUI path owns resolution/ref_audio mapping. Never let a stale
    // channel script omit ref_audio_0 and surface "模型调用脚本执行失败".
    if (shouldUseAutodlComfyVideoBuiltin(selectedModel, requestConfig.baseUrl, script)) {
        return createAutodlComfyVideoTask(requestConfig, selectedModel, prompt, references, options);
    }
    // Native ComfyUI cloud/server: model script = Export Workflow (API) JSON.
    if (shouldUseNativeComfyUi(requestConfig.baseUrl, selectedModel, script) || parseComfyApiWorkflow(script)) {
        return createNativeComfyUiVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    }
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(
        references.slice(0, 9).map(async (image, _index, list) => {
            const resolved = await resolveAutodlComfyReferenceUrl(image, Math.min(9, list.length || 1));
            return resolved;
        }),
    );
    const ratio = normalizeVideoRatio(config.size);
    const pixelSize = normalizeVideoSize(config.size);
    const h3Comfy = isAutodlH3ComfyVideoModel(model, config.baseUrl);
    const seconds = h3Comfy
        ? normalizeAutodlH3Duration(config.videoSeconds, model)
        : isSeedanceVideoModel(model)
          ? normalizeSeedanceSeconds(config.videoSeconds)
          : normalizeVideoSeconds(config.videoSeconds);
    const resolution = h3Comfy ? normalizeAutodlH3Resolution(config.vquality, model) : normalizeVideoResolution(config.vquality);
    // Seedance / Doubao scripts often bind `size` into the API `ratio` field by mistake.
    // For those models, pass the ratio enum in both `ratio` and `size`.
    const seedance = isSeedanceVideoModel(model);
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds,
                duration: h3Comfy ? autodlH3DurationSeconds(config.videoSeconds, model) : Number(seconds) || seconds,
                size: seedance ? ratio : pixelSize,
                pixelSize,
                resolution,
                ratio,
                aspect_ratio: ratio,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
                audios: await resolveAutodlComfyAudioUrls(options?.referenceAudios || [], options?.signal),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

/**
 * Native ComfyUI (/prompt) on a rented or proxied server.
 * Put Export Workflow (API) JSON into the model's script field.
 */
async function createNativeComfyUiVideoTask(
    config: AiConfig,
    model: string,
    script: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    const workflow = parseComfyApiWorkflow(script);
    if (!workflow) throw new Error(apiText("comfyWorkflowRequired"));
    const refs = await Promise.all(
        references.slice(0, 8).map(async (image) => {
            try {
                const dataUrl = await imageToDataUrl(image);
                return dataUrl?.startsWith("data:") || /^https?:\/\//i.test(dataUrl || "") ? dataUrl : "";
            } catch {
                return "";
            }
        }),
    );
    try {
        const result = await runNativeComfyUiJob({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            workflow,
            prompt,
            referenceDataUrls: refs.filter(Boolean),
            signal: options?.signal,
        });
        const video = result.videos[0];
        if (!video?.blob) {
            if (result.images[0]?.dataUrl) {
                // Some workflows return image strips; surface a clear error for video capability.
                throw new Error(apiText("comfyNoVideo"));
            }
            throw new Error(apiText("comfyNoVideo"));
        }
        const id = nanoid();
        pluginVideoResults.set(id, { blob: video.blob, mimeType: video.mimeType });
        return { id, provider: "plugin", model };
    } catch (error) {
        if (error instanceof Error && (error.message.includes("comfy") || error.message.includes("ComfyUI"))) throw error;
        throw new Error(error instanceof Error ? error.message : apiText("requestFailed"));
    }
}

/**
 * AutoDL ComfyUI video (docs: https://autodl.art/docs/comfyui_api/)
 * POST /comfyui/comfyui_workflow/{workflow_id} → poll /result/{task_id}
 * Auth: ComfyUI-group token as raw Authorization value (no Bearer).
 */
async function createAutodlComfyVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (/openspeech\.bytedance\.com/i.test(config.baseUrl)) {
        throw new Error(apiText("autodlComfyWrongBaseUrl"));
    }
    if (!/autodl\.art/i.test(config.baseUrl)) {
        throw new Error(apiText("autodlComfyWrongBaseUrl"));
    }
    const workflowId = modelOptionName(model).trim();
    if (!workflowId) throw new Error(apiText("autodlWorkflowRequired"));
    const token = String(config.apiKey || "").replace(/^Bearer\s+/i, "").trim();
    const headers = { Authorization: token, "Content-Type": "application/json" };
    const duration = autodlH3DurationSeconds(config.videoSeconds, workflowId);
    const resolution = normalizeAutodlH3Resolution(config.vquality, workflowId);
    const refs = await Promise.all(references.slice(0, 9).map((image) => resolveAutodlComfyReferenceUrl(image, Math.min(9, references.length || 1))));
    const audioUrls = await resolveAutodlComfyAudioUrls(options?.referenceAudios || [], options?.signal);
    // AutoDL body: duration must be an integer (seconds), see https://autodl.art/docs/comfyui_api/
    const body: Record<string, unknown> = { prompt, duration, resolution };
    refs.forEach((item, index) => {
        const url = String(item || "").trim();
        if (!url) return;
        body[`ref_image_${index}`] = url;
        if (index === 0 && /^https?:\/\//i.test(url)) {
            body.image = url;
            body.image_url = url;
        }
    });
    const supportsAudio = autodlH3SupportsRefAudio(workflowId);
    // Audio-capable workflows (z09 / zm / image+audio) always send ref_audio_0.
    // Do NOT send ref_audio to lightx2v-style workflows — they have no such input.
    if (supportsAudio || audioUrls.length) {
        const slots = [audioUrls[0], audioUrls[1], audioUrls[2]];
        if (supportsAudio && !slots[0]) slots[0] = AUTODL_H3_BLANK_AUDIO_URL;
        slots.forEach((url, index) => {
            const value = String(url || "").trim();
            if (!value) return;
            body[`ref_audio_${index}`] = value;
        });
    }
    assertProxyBodyFits(body);

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
            throw new Error(readApiErrorMessage(submit) || apiText("videoTaskCreateFailed"));
        }
        const taskId =
            (submit && typeof submit === "object" && "data" in submit ? (submit as { data?: { task_id?: string } }).data?.task_id : undefined) ||
            (submit && typeof submit === "object" && "task_id" in submit ? (submit as { task_id?: string }).task_id : undefined);
        if (!taskId) throw new Error(readApiErrorMessage(submit) || apiText("autodlNoTaskId"));

        const deadline = performance.now() + 20 * 60 * 1000;
        for (;;) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const state = (
                await axios.get<ApiEnvelope<{ status?: string; results?: unknown[]; message?: string }>>(
                    aiApiUrl(config, `/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`),
                    { headers: { Authorization: token }, signal: options?.signal },
                )
            ).data;
            const data = state && typeof state === "object" && "data" in state && (state as { data?: unknown }).data ? (state as { data: Record<string, unknown> }).data : (state as Record<string, unknown>);
            const status = String(data?.status || "");
            if (/^failed|failure$/i.test(status)) throw new Error(readApiErrorMessage(state) || readApiErrorMessage(data) || apiText("autodlTaskFailed"));
                if (/^success|completed$/i.test(status)) {
                    const list = (Array.isArray(data.results) ? data.results : [])
                        .map((item) => {
                            if (typeof item === "string") return item;
                            if (!item || typeof item !== "object") return "";
                            const record = item as Record<string, unknown>;
                            return [record.url, record.video_url, record.image_url, record.file_url, record.audio_url].find((value) => typeof value === "string" && value) as string | undefined;
                        })
                        .filter(Boolean) as string[];
                    if (!list.length) throw new Error(apiText("autodlNoResults"));
                    const id = nanoid();
                    pluginVideoResults.set(id, { url: list[0], mimeType: "video/mp4" });
                    return { id, provider: "plugin", model: workflowId };
                }
            if (performance.now() >= deadline) throw new Error(apiText("videoTaskTimedOut"));
            await new Promise((resolve) => window.setTimeout(resolve, 2000));
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
            throw new Error(apiText("autodlComfyAuthFailed"));
        }
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch (error) {
            // Keep remote https URLs as a temporary fallback, but never persist empty storageKey + dead blob.
            if (/^https?:\/\//i.test(result.url)) {
                return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
            }
            throw error instanceof Error ? error : new Error(String(error));
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

/** Upload a local media blob to the provider and get a temporary public URL (Seedance /v1/files/upload). */
export async function uploadProviderMediaFile(config: AiConfig, blob: Blob, filename = "video.mp4", options?: RequestOptions): Promise<string> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.videoModel);
    if (!requestConfig.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!requestConfig.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));

    const form = new FormData();
    form.append("file", blob, filename);
    try {
        const response = await axios.post<{ url?: string; data?: { url?: string } | null; code?: number | string; msg?: string; message?: string }>(
            aiApiUrl(requestConfig, "/files/upload"),
            form,
            { headers: { Authorization: `Bearer ${requestConfig.apiKey}` }, signal: options?.signal },
        );
        const url = response.data?.url || (response.data?.data && typeof response.data.data === "object" ? response.data.data.url : "") || "";
        if (!url || !/^https?:\/\//i.test(url)) {
            throw new Error(readApiErrorMessage(response.data) || apiText("providerImageUploadFailed"));
        }
        return url;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("providerImageUploadFailed")));
    }
}

export type VideoUpscaleOptions = {
    videoUrl: string;
    resolution?: string;
    signal?: AbortSignal;
};

/** Seedance zhenzhen-upscaler via POST /v1/videos + poll. */
export async function requestVideoUpscale(config: AiConfig, options: VideoUpscaleOptions): Promise<VideoGenerationResult> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.videoModel);
    const modelName = modelOptionName(requestConfig.model || "zhenzhen-upscaler") || "zhenzhen-upscaler";
    assertVideoConfig(requestConfig, modelName);
    if (!options.videoUrl || !/^https?:\/\//i.test(options.videoUrl)) {
        throw new Error(apiText("videoTaskCreateFailed"));
    }
    const resolution = normalizeUpscaleResolution(options.resolution || "1080p");
    const payload = {
        model: modelName,
        prompt: "upscale",
        metadata: {
            resolution,
            content: [{ type: "video_url", video_url: { url: options.videoUrl } }],
        },
    };
    let taskId = "";
    try {
        const created = unwrapVideoTaskResponse(
            (await axios.post<ApiVideoResponse>(aiApiUrl(requestConfig, "/videos"), payload, { headers: aiHeaders(requestConfig, "application/json"), signal: options.signal })).data,
        );
        taskId = created.id || "";
        if (!taskId) throw new Error(apiText("noVideoTaskId"));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }

    for (let attempt = 0; attempt < 180; attempt += 1) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollOpenAIVideoTask(requestConfig, { id: taskId, provider: "openai", model: modelName }, { signal: options.signal });
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        await delay(3000, options.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

function normalizeUpscaleResolution(value: string) {
    const raw = value.trim().toLowerCase();
    if (raw === "720" || raw === "720p") return "720p";
    if (raw === "1080" || raw === "1080p") return "1080p";
    if (raw === "2k") return "2k";
    if (raw === "4k") return "4k";
    return "1080p";
}

function unwrapVideoTaskResponse(payload: ApiVideoResponse): VideoResponse {
    if (!payload) throw new Error(apiText("noVideoTask"));
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        const ok = payload.code === 0 || payload.code === "0" || payload.code === 200 || payload.code === "200";
        if (!ok) throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        const data = payload.data;
        if (!data) throw new Error(apiText("noVideoTask"));
        if (typeof data.id === "string" && data.id) return data;
        // Some relays return { task_id } instead of { id }.
        const record = data as VideoResponse & { task_id?: string };
        return { ...record, id: record.id || record.task_id || "" };
    }
    const record = payload as VideoResponse & { task_id?: string };
    return { ...record, id: record.id || record.task_id || "" };
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (isMetasoH3Video(config, model)) {
        return createMetasoH3VideoTask(config, model, prompt, references, options);
    }
    if (isRelayMiniMaxH3Video(config, model)) {
        return createRelayMiniMaxH3VideoTask(config, model, prompt, references, options);
    }

    const ratio = normalizeVideoRatio(config.size);
    const seedance = isSeedanceVideoModel(model);
    const seconds = seedance ? normalizeSeedanceSeconds(config.videoSeconds) : normalizeVideoSeconds(config.videoSeconds);
    const resolution = normalizeVideoResolution(config.vquality);
    const modelName = modelOptionName(model);
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    const watermark = boolConfig(config.videoWatermark, false);

    // Most CN video relays (Seedance / Doubao / New API) expect JSON for text-to-video.
    // Multipart FormData with pixel `size` is a common source of HTTP 400.
    if (!references.length) {
        const payload: Record<string, unknown> = {
            model: modelName,
            prompt,
            // OpenAI / New API Go bindings expect seconds as a string enum (e.g. "5").
            seconds,
            duration: seconds,
            ratio,
            aspect_ratio: ratio,
            size: seedance ? ratio : normalizeVideoSize(config.size) || ratio,
            resolution,
            resolution_name: resolution,
            generate_audio: generateAudio,
            watermark,
        };
        try {
            const created = unwrapVideoResponse(
                (await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data,
            );
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
        }
    }

    const body = new FormData();
    body.append("model", modelName);
    body.append("prompt", prompt);
    body.append("seconds", seconds);
    body.append("duration", seconds);
    body.append("ratio", ratio);
    body.append("aspect_ratio", ratio);
    body.append("resolution", resolution);
    body.append("resolution_name", resolution);
    body.append("generate_audio", String(generateAudio));
    body.append("watermark", String(watermark));
    body.append("preset", "normal");
    if (seedance) body.append("size", ratio);
    else {
        const size = normalizeVideoSize(config.size);
        if (size) body.append("size", size);
    }
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    // OpenAI / New API expect repeated `input_reference`, not `input_reference[]`.
    files.forEach((file) => body.append("input_reference", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

/**
 * Metaso MiniMax-H3 via OpenAI-compatible /v1/videos.
 * Docs: https://metaso.cn/minimax-h3/new-api-guide
 * Body must stay minimal: model=sora-2, prompt, seconds, size, input_reference.image_url (public HTTPS).
 */
async function createMetasoH3VideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!references.length) throw new Error(apiText("metasoH3ImageRequired"));
    const modelName = resolveMetasoH3ModelName(model);
    const seconds = normalizeMetasoH3Seconds(config.videoSeconds);
    const size = normalizeMetasoH3Size(config.size, config.vquality);
    const imageUrl = await resolveMetasoH3ImageUrl(config, references[0], options);
    if (!isPublicHttpUrl(imageUrl) || imageUrl.startsWith("data:")) {
        throw new Error(apiText("metasoH3PublicImageRequired"));
    }
    const payload = {
        model: modelName,
        prompt,
        seconds,
        size,
        input_reference: { image_url: imageUrl },
    };
    try {
        const created = unwrapVideoResponse(
            (await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data,
        );
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

/**
 * Non-Metaso MiniMax-H3 relays (manxue / New API / similar): JSON /v1/videos.
 * manxueapi returns `new_api_error` — it expects OpenAI-compatible JSON, not multipart.
 */
async function createRelayMiniMaxH3VideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model).trim() || "minimax-h3";
    const secondsNum = Math.min(15, Math.max(4, Math.floor(Number(config.videoSeconds) || 5)));
    const seconds = String(secondsNum);
    const ratio = normalizeVideoRatio(config.size);
    const size = normalizeRelayH3Size(config.size, config.vquality);
    const metasoSize = normalizeMetasoH3Size(config.size, config.vquality);
    const resolution = /high|2k|1080|1440|2560/i.test(config.vquality || "") ? "2K" : "768P";

    const imageUrls: string[] = [];
    for (const image of references.slice(0, 9)) {
        const publicUrl = [image.url, image.dataUrl].map((value) => String(value || "").trim()).find((value) => isPublicHttpUrl(value) && !value.startsWith("data:"));
        if (publicUrl) {
            imageUrls.push(publicUrl);
            continue;
        }
        const dataUrl = await imageToDataUrl(image);
        if (!dataUrl?.startsWith("data:image/")) continue;
        try {
            const blob = await (await fetch(dataUrl)).blob();
            const uploaded = await uploadProviderMediaFile(config, blob, "reference.png", options);
            if (isPublicHttpUrl(uploaded) && !uploaded.startsWith("data:")) imageUrls.push(uploaded);
        } catch {
            // Keep going — text-to-video may still work without a reference URL.
        }
    }

    const attempts: Record<string, unknown>[] = [
        // New API / Sora-compatible JSON (primary for manxueapi.com).
        {
            model: modelName,
            prompt,
            seconds,
            size: metasoSize,
            ...(imageUrls[0] ? { input_reference: { image_url: imageUrls[0] } } : {}),
        },
        // Same shape with CometAPI WxH sizes some H3 adapters expect.
        {
            model: modelName,
            prompt,
            seconds,
            size,
            ...(imageUrls[0] ? { input_reference: { image_url: imageUrls[0] } } : {}),
        },
        // MiniMax-native field names used by some New API model adapters.
        {
            model: modelName,
            prompt,
            duration: secondsNum,
            resolution,
            aspect_ratio: ratio,
            ...(imageUrls[0] ? { first_frame_image: imageUrls[0] } : {}),
        },
    ];

    let lastError: unknown;
    for (const payload of attempts) {
        try {
            const created = unwrapVideoResponse(
                (await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data,
            );
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            // Only retry alternate shapes on 400 validation errors.
            if (!axios.isAxiosError(error) || error.response?.status !== 400) break;
        }
    }

    // Last resort: multipart (CometAPI-style) when the relay rejects JSON shapes.
    if (imageUrls.length || references.length) {
        try {
            const body = new FormData();
            body.append("model", modelName);
            body.append("prompt", prompt);
            body.append("seconds", seconds);
            body.append("size", size);
            for (const url of imageUrls.slice(0, 9)) body.append("images", url);
            if (!imageUrls.length) {
                for (const image of references.slice(0, 9)) {
                    const dataUrl = await imageToDataUrl(image);
                    if (!dataUrl?.startsWith("data:image/")) continue;
                    body.append("input_reference", await dataUrlToFile({ ...image, dataUrl }));
                }
            }
            const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(readAxiosError(lastError, apiText("videoTaskCreateFailed")));
}

function isMetasoH3Video(config: AiConfig, _model: string) {
    // Only Metaso's OpenAI root uses the sora-2 JSON shape. Other H3 relays differ.
    return /metaso\.cn/i.test(config.baseUrl.trim());
}

function isRelayMiniMaxH3Video(config: AiConfig, model: string) {
    if (/autodl\.art|metaso\.cn/i.test(config.baseUrl.trim())) return false;
    const name = modelOptionName(model).toLowerCase();
    return /minimax[-_]?h3|(?:^|[-_])h3(?:$|[-_])|1ren[-_]?minimax/i.test(name);
}

/** Metaso OpenAI examples always post model=sora-2 (mapped to MiniMax-H3 upstream). */
function resolveMetasoH3ModelName(model: string) {
    const name = modelOptionName(model).trim();
    if (/^sora-2$/i.test(name)) return "sora-2";
    if (/minimax|h3/i.test(name)) return "sora-2";
    return name || "sora-2";
}

/** Metaso examples use 4 / 8 / 12 seconds. */
function normalizeMetasoH3Seconds(value: string) {
    const seconds = Math.floor(Number(value) || 4);
    const allowed = [4, 8, 12];
    return allowed.reduce((best, current) => (Math.abs(current - seconds) < Math.abs(best - seconds) ? current : best));
}

/** Metaso documented sizes: 1280x720, 720x1280, 1792x1024, 1024x1792. */
function normalizeMetasoH3Size(size: string, quality: string) {
    const ratio = normalizeVideoRatio(size);
    const high = /high|2k|1080|1792|1024x1792|1792x1024/i.test(quality || "") || /1792|1024x1792|1792x1024/i.test(size || "");
    if (ratio === "9:16" || ratio === "3:4" || ratio === "2:3") return high ? "1024x1792" : "720x1280";
    return high ? "1792x1024" : "1280x720";
}

/** CometAPI canonical H3 WxH table (768P / 2K). */
function normalizeRelayH3Size(size: string, quality: string) {
    const ratio = normalizeVideoRatio(size);
    const high = /high|2k|1080|1440|2560|2912/i.test(quality || "") || /2560|1440|2912|1920/i.test(size || "");
    const table: Record<string, { sd: string; hd: string }> = {
        "21:9": { sd: "1536x672", hd: "2912x1280" },
        "16:9": { sd: "1344x768", hd: "2560x1440" },
        "4:3": { sd: "1024x768", hd: "1920x1440" },
        "1:1": { sd: "768x768", hd: "1440x1440" },
        "3:4": { sd: "768x1024", hd: "1440x1920" },
        "9:16": { sd: "768x1344", hd: "1440x2560" },
    };
    const entry = table[ratio] || table["16:9"];
    return high ? entry.hd : entry.sd;
}

async function resolveMetasoH3ImageUrl(config: AiConfig, image: ReferenceImage, options?: RequestOptions) {
    if (image.url && isPublicHttpUrl(image.url) && !image.url.startsWith("data:") && !/^blob:/i.test(image.url)) return image.url.trim();
    if (image.dataUrl && isPublicHttpUrl(image.dataUrl) && !image.dataUrl.startsWith("data:") && !/^blob:/i.test(image.dataUrl)) return image.dataUrl.trim();
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("metasoH3ImageUnreadable"));
    if (isPublicHttpUrl(dataUrl) && !dataUrl.startsWith("data:")) return dataUrl.trim();
    if (dataUrl.startsWith("data:image/")) {
        try {
            const blob = await (await fetch(dataUrl)).blob();
            const uploaded = await uploadProviderMediaFile(config, blob, "reference.png", options);
            if (isPublicHttpUrl(uploaded) && !uploaded.startsWith("data:")) return uploaded;
        } catch {
            // Metaso rejects data URLs; surface a clear requirement instead of a opaque 400.
        }
        throw new Error(apiText("metasoH3PublicImageRequired"));
    }
    throw new Error(apiText("metasoH3ImageUnreadable"));
}

function isPublicHttpUrl(value: string) {
    return /^https?:\/\//i.test((value || "").trim());
}

/** Prefer remote URLs; otherwise compress data URLs so /api/proxy stays under Vercel ~4.5MB. */
async function resolveAutodlComfyReferenceUrl(image: ReferenceImage, referenceCount = 1) {
    if (image.url && isPublicHttpUrl(image.url) && !/^blob:/i.test(image.url)) return image.url.trim();
    if (image.dataUrl && isPublicHttpUrl(image.dataUrl) && !/^blob:/i.test(image.dataUrl)) return image.dataUrl.trim();
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("metasoH3ImageUnreadable"));
    if (isPublicHttpUrl(dataUrl)) return dataUrl.trim();
    return compressReferenceDataUrl(dataUrl, referenceCount, { maxEdge: 1280, maxBytes: Math.min(650_000, Math.floor(2_200_000 / Math.max(1, referenceCount))) });
}

async function resolveAutodlComfyAudioUrls(audios: ReferenceAudio[], signal?: AbortSignal): Promise<string[]> {
    const list = audios.slice(0, 3);
    const resolved = await Promise.all(list.map((audio) => resolveAutodlComfyAudioUrl(audio, signal)));
    return resolved.filter(Boolean);
}

async function resolveAutodlComfyAudioUrl(audio: ReferenceAudio, signal?: AbortSignal): Promise<string> {
    const candidates = [audio.url, audio.storageKey].map((value) => String(value || "").trim()).filter(Boolean);
    for (const source of candidates) {
        if (isPublicHttpUrl(source) && !/^blob:/i.test(source)) return source;
        if (source.startsWith("data:")) return source;
    }
    const source = candidates[0];
    if (!source) return "";
    try {
        const response = await axios.get<Blob>(proxyApiUrl(source), { responseType: "blob", signal });
        const blob = response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audio.type || "audio/mpeg" });
        return await blobToDataUrl(blob);
    } catch {
        return "";
    }
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read audio"));
        reader.readAsDataURL(blob);
    });
}

/** Fail fast with a clear 413 hint before hitting the site proxy body cap. */
function assertProxyBodyFits(body: Record<string, unknown>) {
    if (resolveApiTransport() !== "proxy") return;
    let encoded = "";
    try {
        encoded = JSON.stringify(body);
    } catch {
        return;
    }
    // Vercel Hobby request body limit is ~4.5MB; leave headroom for headers/encoding.
    if (encoded.length > 3_800_000) {
        throw new Error(apiText("payloadTooLarge"));
    }
    const inlineBytes = Object.values(body).reduce<number>((sum, value) => {
        if (typeof value !== "string" || !value.startsWith("data:")) return sum;
        return sum + getDataUrlByteSize(value);
    }, 0);
    if (inlineBytes > 3_200_000) {
        throw new Error(apiText("payloadTooLarge"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

/** Seedance Mini T2V accepts duration 4–15 only. */
function normalizeSeedanceSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return String(Math.max(4, Math.min(15, seconds)));
}

function isSeedanceVideoModel(model: string) {
    const value = modelOptionName(model).toLowerCase();
    return /seedance|doubao-seedance/.test(value);
}

function normalizeVideoSize(value: string) {
    if (value === "auto" || value === "adaptive") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/i.test(size)) return size;
    if (/^\d+(?:\.\d+)?\s*[:/]\s*\d+(?:\.\d+)?$/.test(size)) {
        const ratio = normalizeVideoRatio(size);
        return ["9:16", "3:4"].includes(ratio) ? "720x1280" : ratio === "1:1" ? "1024x1024" : "1280x720";
    }
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low" || value === "480") return "480p";
    if (value === "auto" || value === "high" || value === "medium" || value === "720") return "720p";
    // Mini does not support 1080p / 4k — clamp upward qualities down to 720p for Seedance callers.
    const resolution = value.replace(/p$/i, "") || "720";
    const numeric = Number(resolution);
    if (Number.isFinite(numeric) && numeric > 720) return "720p";
    return `${resolution}p`;
}

/**
 * Map UI size (WxH / ratio / auto) to Seedance-compatible ratio enums.
 * Prefer fixed ratios: some T2V relays reject `adaptive` even though docs list it.
 */
export function normalizeVideoRatio(value: string) {
    const raw = (value || "").trim();
    if (!raw || raw === "auto" || raw === "adaptive") return "16:9";
    const allowed = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
    if (allowed.has(raw)) return raw;
    if (raw === "adaptive") return "16:9";

    const ratioMatch = raw.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    if (ratioMatch) {
        const width = Number(ratioMatch[1]);
        const height = Number(ratioMatch[2]);
        if (width > 0 && height > 0) return nearestVideoRatio(width / height);
    }

    const sizeMatch = raw.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
    if (sizeMatch) {
        const width = Number(sizeMatch[1]);
        const height = Number(sizeMatch[2]);
        if (width > 0 && height > 0) return nearestVideoRatio(width / height);
    }

    return "16:9";
}

const VIDEO_RATIO_PRESETS = [
    { label: "21:9", value: 21 / 9 },
    { label: "16:9", value: 16 / 9 },
    { label: "4:3", value: 4 / 3 },
    { label: "1:1", value: 1 },
    { label: "3:4", value: 3 / 4 },
    { label: "9:16", value: 9 / 16 },
] as const;

function nearestVideoRatio(ratio: number) {
    let best: (typeof VIDEO_RATIO_PRESETS)[number] = VIDEO_RATIO_PRESETS[1];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const preset of VIDEO_RATIO_PRESETS) {
        const distance = Math.abs(Math.log(ratio) - Math.log(preset.value));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = preset;
        }
    }
    return best.label;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        const ok = payload.code === 0 || payload.code === "0" || payload.code === 200 || payload.code === "200" || payload.code === "success" || payload.code === "ok";
        if (!ok) throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
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
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response) {
            const url = typeof error.config?.url === "string" ? error.config.url : "";
            const hint = url ? `\n${url}` : "";
            return error.code === "ERR_NETWORK" ? `${apiText("corsRequired")}${hint}` : `${apiText("networkFailed")}${hint}`;
        }
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || readNetworkMessage(error.message) || error.message : fallback;
}

function readNetworkMessage(message: string) {
    return /failed to fetch|network error|load failed|net::err_/i.test(message) ? apiText("networkFailed") : null;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 400) return `${fallback}（400）`;
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 413) return apiText("payloadTooLarge");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
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
