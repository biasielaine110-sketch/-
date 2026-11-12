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
import { boolConfig, buildApiUrl, modelOptionName, resolveModelChannel, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { resolveApiTransport, proxyApiUrl, proxyMediaUrl, forceProxyMediaUrl, forceProxyApiUrl, isKnownDirectCorsUrl, isTunnelCorsUrl } from "@/lib/api-proxy";
import { uploadTemporaryPublicImage, uploadTemporaryPublicImageFromDataUrl } from "@/lib/temp-public-image";
import { parseComfyApiWorkflow, runNativeComfyUiJob, shouldUseNativeComfyUi } from "@/lib/comfyui-native";
import {
    isMinimaxH3FisherWorkflowId,
    isWorkFisherLightAiAppId,
    isMinimaxH3HdDynamicWorkflowId,
    isMinimaxH3SingularityWorkflowId,
    isMinimaxH3SingularityLightAiAppId,
    isMinimaxH3WenxiLowWorkflowId,
    isMinimaxH3WenxiWorkflowId,
    isMinimaxH3YzjinyuWorkflowId,
    pickRunningHubWorkflowId,
    runningHubOrigin,
    runRunningHubWorkflow,
} from "@/lib/runninghub-workflow";
import { isMioraQueueBaseUrl, mediaUrlToBlob, runMioraGeneration } from "@/lib/miora-queue";
import { cropVideoBottomBand, normalizeSubtitleCropMode } from "@/lib/video-subtitle-crop";
import { runModelPlugin } from "./model-plugin";
import { buildJusuanhubVideoRequestBody, inspectJusuanhubMp4, isJusuanhubMediaBaseUrl, looksLikeTextPayload, orderJusuanhubApiKeys, readJusuanhubJobId, readJusuanhubJobState } from "./jusuanhub-media";
import { runWithJusuanhubKeyFailover, runWithJusuanhubRetry } from "./jusuanhub-retry";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = {
    id: string;
    status?: string;
    progress?: number;
    error?: { message?: string; code?: string };
    url?: string;
    result_url?: string;
    video_url?: string;
    content?: { video_url?: string; url?: string } | null;
    // work-fisher（api.work-fisher.com）与 OpenAI video 契约：完成态直链在 `metadata.url`，
    // 是个带签名的临时地址（X-Tos-Signature 之类），取到就得立刻下载转存。
    metadata?: { url?: string; video_url?: string } | null;
    // MiniMax-H3 `/v2/query/video_generation/{id}`：直链在 `task.content.url`。
    task?: { content?: { url?: string } | null } | null;
};
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal; referenceAudios?: ReferenceAudio[]; referenceVideos?: ReferenceVideo[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; extraImages?: string[] };
export type VideoGenerationTask = {
    id: string;
    provider: "openai" | "plugin" | "jusuanhub";
    model: string;
    /**
     * 聚算 Hub 专用：本次任务随机选中的 Key。
     *
     * 这一家的 job 是**账户级**的（key A 提交的 jobId，用 key B 查就是 404），而轮询会重新
     * `resolveModelRequestConfig`，多 Key 时又会随机到另一个 —— 所以提交时把 Key 记在任务上，
     * 轮询 / 取字节沿用同一个。其它 provider 不设这个字段，行为不变。
     */
    apiKey?: string;
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return proxyApiUrl(buildApiUrl(config.baseUrl, path), config.apiTransport);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

/** Vercel serverless functions reject request bodies over ~4.5MB with HTTP 413. */
const PROXY_BODY_SAFE_BYTES = 3_400_000;

/**
 * 视频任务轮询上限。原先为 120 次 × 2500ms（≈6 分钟），但长时长任务会超过它：
 * 实测 10s 片约 4 分 40 秒（能过），15s 片约 8 分 20 秒（会被误判超时）。
 * 360 次 × 2500ms ≈ 15 分钟（含轮询开销约 19 分钟），给长时长留足余量。
 */
const VIDEO_POLL_MAX_ATTEMPTS = 360;
const VIDEO_POLL_INTERVAL_MS = 2500;

function estimateBodyBytes(body: unknown): number {
    if (typeof body === "string") return body.length;
    if (body instanceof FormData) {
        let total = 0;
        body.forEach((value) => {
            if (typeof value === "string") total += value.length;
            else if (value instanceof Blob) total += value.size;
        });
        return total;
    }
    try {
        return JSON.stringify(body ?? "").length;
    } catch {
        return 0;
    }
}

/**
 * Most CN relay sites (New API / hfsyapi / autodl) allow browser CORS, so when a
 * body would exceed the site-proxy cap, POST the direct URL instead of dying 413.
 */
function aiUrlForBody(config: AiConfig, path: string, body: unknown) {
    const bypass = resolveApiTransport() === "proxy" && estimateBodyBytes(body) > PROXY_BODY_SAFE_BYTES;
    return { url: bypass ? buildApiUrl(config.baseUrl, path) : aiApiUrl(config, path), bypass };
}

/** Direct oversized uploads blocked by CORS surface as opaque network errors — explain the real cause. */
function mapOversizeUploadError(error: unknown, bypassed: boolean): unknown {
    if (bypassed && axios.isAxiosError(error) && !error.response) return new Error(apiText("payloadTooLarge"));
    return error;
}

/**
 * True for a browser network-layer failure (no HTTP response at all). Axios collapses every
 * transport failure to `ERR_NETWORK`, so an HTTP/2 reset (`net::ERR_HTTP2_PROTOCOL_ERROR`, which is
 * what a relay edge does when it slams the connection shut) lands here too — that is exactly the
 * case worth retrying on the other transport, because the proxy hop often still answers with a
 * readable edge error page.
 */
function isTransportFailure(error: unknown) {
    if (!axios.isAxiosError(error) || error.response) return false;
    const code = String((error as { code?: string }).code || "");
    if (!code || code === "ERR_NETWORK" || code === "ERR_FAILED") return true;
    return /ERR_(HTTP2|HTTP3|CONNECTION|QUIC|SSL|TIMED_OUT|EMPTY_RESPONSE|INCOMPLETE_CHUNKED)/i.test(code);
}

/**
 * Run a create POST, and when the transport dies without a response, retry once on the *other*
 * transport (direct ↔ site proxy). Two reasons this is worth doing rather than just surfacing the
 * error:
 *   1. A flaky edge on either hop sometimes succeeds on the other one.
 *   2. When the direct hop is reset but the proxy hop answers (e.g. Cloudflare `1016 Origin DNS
 *      error` HTML for a relay whose origin DNS is broken), the user gets that diagnosable answer
 *      instead of a bare `net::ERR_HTTP2_PROTOCOL_ERROR`.
 * Oversized bodies never go proxy-side (that hop resets request bodies) — they keep the direct try.
 */
async function retryAlternateTransport<T>(config: AiConfig, path: string, primaryUrl: string, body: unknown, run: (url: string) => Promise<T>): Promise<T> {
    try {
        return await run(primaryUrl);
    } catch (error) {
        if (axios.isCancel(error) || !isTransportFailure(error)) throw error;
        const proxied = /\/api(?:-)?proxy\?target=/i.test(primaryUrl);
        const alternate = proxied ? buildApiUrl(config.baseUrl, path) : forceProxyApiUrl(primaryUrl);
        if (!alternate || alternate === primaryUrl) throw error;
        if (!proxied && estimateBodyBytes(body) > PROXY_BODY_SAFE_BYTES) throw error;
        console.warn(`[video] ${path} via ${proxied ? "proxy" : "direct"} failed at the transport layer; retrying alternate transport`);
        return run(alternate);
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 聚算 Hub（`*.jusuanhub.com`）视频链路：minimax-h3
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * 这一家的 minimax-h3 **不是** OpenAI `/v1/videos`，也不是 CometAPI 那套 `input_reference`：
 *
 *   POST /v1/media/generations  { model, prompt, seconds, generationMode, aspectRatio,
 *                                 resolutionTier, input_image_url?, referenceInputs?[] }
 *   GET  /v1/jobs/{jobId}       → { status, outputs:[{ contentUrl }] }
 *   GET  contentUrl（**带同一个 Bearer**）
 *
 * 🔴 两个必填字段最容易漏，漏了就是 400：
 *   · `seconds` 只收 5–15 的**整数**（白名单，不是区间）；
 *   · `generationMode` 必须和素材精确匹配（t2v / i2v / universal_reference_video），
 *     传了图却报 t2v 会被拒，反之亦然。
 *
 * 🔴 分支顺序：`minimax-h3` 会被 `isRelayMiniMaxH3Video` 的 `minimax[-_]?h3` 命中，
 *    所以本分支必须在它**之前**（与 work-fisher 同一个坑）。
 */
const JUSUANHUB_VIDEO_CREATE_TIMEOUT_MS = 120_000;
const JUSUANHUB_VIDEO_REQUEST_TIMEOUT_MS = 60_000;

function newJusuanhubVideoIdempotencyKey() {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {
        // 非安全上下文没有 randomUUID，退回时间戳 + 随机串。
    }
    return `jsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 参考图 → 上游要的 URL：公网 https 优先，本地图**必须先换成公网链接**。
 *
 * 🔴 **绝不能发 `data:` URL**（2026-11-12 实测）：这家 nginx 对请求体里的 `data:image` 直接
 * 返回 `403 <h1>403 Forbidden</h1> nginx`，浏览器里看就是「提交就 403」。门户也不提供素材
 * 上传（`POST /v1/assets/input` → `Asset upload is not available on this portal`），
 * 所以本地图只能先传临时图床换 https 地址。公网 URL 是通的（实测 i2v → 202）。
 */
async function collectJusuanhubVideoReferenceUrls(references: ReferenceImage[], limit: number, signal?: AbortSignal): Promise<string[]> {
    const urls: string[] = [];
    let uploadFailed = false;
    for (const image of references.slice(0, limit)) {
        const remote = [image.url, image.dataUrl]
            .map((value) => String(value || "").trim())
            .find((value) => isPublicHttpUrl(value) && !/^blob:/i.test(value));
        if (remote) {
            urls.push(remote);
            continue;
        }
        try {
            const dataUrl = await imageToDataUrl(image);
            if (!dataUrl?.startsWith("data:image/")) continue;
            const compressed = await compressReferenceDataUrl(dataUrl, Math.max(1, references.length));
            urls.push(await uploadTemporaryPublicImageFromDataUrl(compressed, signal));
        } catch {
            uploadFailed = true;
        }
    }
    // 有参考图却一张都没换成公网地址：直接报错，别悄悄退化成 t2v（出来的片会完全不是要的内容）。
    if (references.length > 0 && urls.length === 0 && uploadFailed) throw new Error(apiText("tempImageHostUnavailable"));
    return urls;
}

/** 这次提交可以用的 Key：渠道/模型上配的全部 Key（`config.apiKey` 通常已包含在 `apiKeys` 里，靠 Set 去重）。 */
function jusuanhubKeyCandidates(config: AiConfig): string[] {
    const keys = Array.isArray(config.apiKeys) ? config.apiKeys : [];
    return [...keys, config.apiKey || ""].filter(Boolean);
}

async function createJusuanhubVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model).trim() || "minimax-h3";
    const imageUrls = await collectJusuanhubVideoReferenceUrls(references, 9, options?.signal);
    const body = buildJusuanhubVideoRequestBody({
        model: modelName,
        prompt,
        seconds: config.videoSeconds,
        size: config.size,
        vquality: config.vquality,
        imageUrls,
    });
    // 🔴 429（上游账户排队/并发额度打满）是这一家最常见的「假失败」，两层应对：
    //   ① 多 Key：随机顺序逐个试，前一个被 401/402/403/429 挡住就换下一个账户
    //      —— 别把 90 秒耗在一个已经排满的队列上，另一个账户可能还有空位；
    //   ② 全部 Key 都排满（或只有一个 Key）：回到第一个 Key 做带退避的长等，
    //      退避 3→6→12→24→30 约 75 秒用完，再不行就把原始 429 抛给用户。
    // Idempotency-Key 在环外生成一次，换 Key 复用它：每个账户幂等空间独立，不会串单。
    const idempotencyKey = newJusuanhubVideoIdempotencyKey();
    const keys = orderJusuanhubApiKeys(jusuanhubKeyCandidates(config));
    // 实际提交成功的那个 Key 要记下来 —— 轮询 `/v1/jobs/{id}` 必须用它（job 是账户级的）。
    let submittedKey = keys[0] || config.apiKey;
    const response = await runWithJusuanhubKeyFailover(
        keys,
        (apiKey) => {
            submittedKey = apiKey;
            return axios.post<unknown>(aiApiUrl(config, "/media/generations"), body, {
                headers: { ...aiHeaders({ ...config, apiKey }, "application/json"), "Idempotency-Key": idempotencyKey },
                signal: options?.signal,
                timeout: JUSUANHUB_VIDEO_CREATE_TIMEOUT_MS,
            });
        },
        { signal: options?.signal, perKeyDeadlineMs: 90_000, finalRetry: { maxAttempts: 6, deadlineMs: 90_000 } },
    );
    const jobId = readJusuanhubJobId(response.data);
    if (!jobId) throw new Error(apiText("noVideoTaskId"));
    // 把本次用的 Key 记在任务上：轮询 / 取字节必须用同一个账户，否则 404。
    return { id: jobId, provider: "jusuanhub", model, apiKey: submittedKey };
}

async function pollJusuanhubVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    // 同上：轮询撞 429 只说明查得太勤，不代表任务挂了。
    const response = await runWithJusuanhubRetry(
        () =>
            axios.get<unknown>(aiApiUrl(config, `/jobs/${encodeURIComponent(task.id)}`), {
                headers: aiHeaders(config),
                signal: options?.signal,
                timeout: JUSUANHUB_VIDEO_REQUEST_TIMEOUT_MS,
            }),
        { signal: options?.signal, maxAttempts: 3 },
    );
    const state = readJusuanhubJobState(response.data);
    if (state.status === "pending") return { status: "pending" };
    if (state.status === "failed") return { status: "failed", error: state.error };
    return { status: "completed", result: await fetchJusuanhubVideoResult(config, state.urls[0], options) };
}

/**
 * 取回成片。**contentUrl 不是公开直链**：不带 Bearer 就是 401，而且
 * `/v1/assets/{id}/content` 不回 `Access-Control-Allow-Origin`，带 Authorization 的浏览器直连
 * 会先死在 preflight。所以默认走同源代理并把 Bearer 交给它转发（`functions/_lib/proxy.js`
 * 原样转发请求头，图片侧已实测 200 + 4.5MB）。代理不通再试直连。
 *
 * 🔴 这里**绝不退回 `{ url }`**。旧实现两条都失败时把 contentUrl 当直链交给画布，而那个 URL
 * 不带 Bearer 就是 401 —— 画布把它当远程视频取，落库时又被「非媒体也重贴 video/mp4」的规则
 * 存成一条假 mp4，用户最后看到的就是 `DEMUXER_ERROR_COULD_NOT_OPEN`（"视频无法播放"），
 * 但真正的原因（下载 401 / 截断）被彻底藏掉了。现在改成：校验字节 + 重试，仍不行就报明确的错。
 */
async function fetchJusuanhubVideoResult(config: AiConfig, url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    const direct = String(url || "").trim();
    const absolute = /^https?:\/\//i.test(direct) ? direct : buildApiUrl(config.baseUrl, direct);
    const proxied = forceProxyMediaUrl(absolute);
    const targets = proxied ? [proxied, absolute] : [absolute];
    let lastError: unknown;
    for (let round = 0; round < 3; round += 1) {
        for (const target of targets) {
            try {
                const response = await runWithJusuanhubRetry(
                    () =>
                        axios.get<Blob>(target, {
                            headers: aiHeaders(config),
                            responseType: "blob",
                            signal: options?.signal,
                            timeout: JUSUANHUB_VIDEO_REQUEST_TIMEOUT_MS,
                        }),
                    { signal: options?.signal, maxAttempts: 3 },
                );
                await assertVideoBlob(response.data);
                const blob = await assertJusuanhubPlayableMp4(response.data);
                // 统一重贴成 video/mp4：`<video>` 只认媒体类型，octet-stream 会被拒。
                return { blob: blob.type === "video/mp4" ? blob : blob.slice(0, blob.size, "video/mp4"), mimeType: "video/mp4" };
            } catch (error) {
                if (axios.isCancel(error) || options?.signal?.aborted) throw error;
                lastError = error;
                // 换下一条再试（代理不通 → 直连；直连被 CORS 拦 → 下一轮再来）。
            }
        }
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await delay(1_200 * (round + 1), options?.signal);
    }
    // 最后一轮拿到的仍是「字节层面就能定性」的错（空/截断/不是 MP4），原样抛，
    // 不要再包一层「下载未完成」，否则用户看到的是「下载未完成（返回的不是可播放的 MP4）」这种绕口话。
    if (lastError instanceof Error && (lastError as Error & { jusuanhubDefinitive?: boolean }).jusuanhubDefinitive) throw lastError;
    const reason = lastError instanceof Error && lastError.message ? lastError.message : "下载失败";
    throw new Error(apiText("videoDownloadIncomplete", { reason }));
}

/**
 * 校验「拿到的字节是能播的 MP4」。这一步是把 Chrome 那句
 * `DEMUXER_ERROR_COULD_NOT_OPEN` 拆成可定位的原因：
 *  · 文本响应（401 的 JSON / 代理错误页）→ 直接把响应内容带出来；
 *  · 缺 `moov`（下载被截断）→ 说明还没写完/传输中断，让上层重试；
 *  · 不是 MP4 容器 → 报「返回的不是 MP4」。
 */
async function assertJusuanhubPlayableMp4(input: Blob): Promise<Blob> {
    const headBytes = await input.slice(0, Math.min(input.size, 1 << 20)).arrayBuffer();
    const tailBytes = await input.slice(Math.max(0, input.size - (1 << 20))).arrayBuffer();
    const head = new Uint8Array(headBytes);
    const tail = new Uint8Array(tailBytes);
    if (looksLikeTextPayload({ head, contentType: input.type })) {
        const text = new TextDecoder().decode(head).replace(/\s+/g, " ").trim().slice(0, 160);
        throw definitiveDownloadError(text || apiText("videoDownloadFailed"));
    }
    const verdict = inspectJusuanhubMp4({ size: input.size, head, tail });
    if (verdict.ok) return input;
    throw definitiveDownloadError(
        verdict.reason === "empty"
            ? apiText("videoDownloadEmpty")
            : verdict.reason === "missing_moov"
              ? apiText("videoDownloadTruncated", { bytes: input.size })
              : apiText("videoDownloadNotMp4", { bytes: input.size }),
    );
}

/** 打上标记：这个错误已经说清「字节哪里不对」，调用方不必再套一层笼统文案。 */
function definitiveDownloadError(message: string): Error {
    const error = new Error(message) as Error & { jusuanhubDefinitive?: boolean };
    error.jusuanhubDefinitive = true;
    return error;
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, options);
    for (let attempt = 0; attempt < VIDEO_POLL_MAX_ATTEMPTS; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === VIDEO_POLL_MAX_ATTEMPTS - 1) throw new Error(apiText("videoTimeout", { provider: "" }));
        await delay(VIDEO_POLL_INTERVAL_MS, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    // Pre-compress oversized local references before dispatch so no path sends a body
    // that trips the Vercel ~4.5MB serverless cap (HTTP 413 "请求实体过大").
    const safeReferences = await compressVideoReferences(references);
    // WorkBuddy local file-queue VideoGen — no API key; runs on this machine only.
    if (isMioraQueueBaseUrl(requestConfig.baseUrl)) {
        return createMioraVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    // work-fisher 必须在所有「按模型名猜形状」的启发式之前：它挂的 `rh-*-h3-*` 工作流模型
    // 会被 `isRelayMiniMaxH3Video` 抢走，套上 CometAPI 形状后上游收不到 prompt。
    if (isWorkFisherVideoHost(requestConfig.baseUrl)) {
        assertVideoConfig(requestConfig, requestConfig.model);
        return createWorkFisherVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    // 聚算 Hub（`*.jusuanhub.com`）必须同样放在所有「按模型名猜形状」的启发式之前：
    // 它的 `minimax-h3` 会被 `isRelayMiniMaxH3Video` 命中，套上 CometAPI 形状后打到 /videos 只会 404。
    if (isJusuanhubMediaBaseUrl(requestConfig.baseUrl)) {
        assertVideoConfig(requestConfig, requestConfig.model);
        return createJusuanhubVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    // Metaso MiniMax-H3 must use OpenAI /videos before any AutoDL ComfyUI heuristic.
    if (isMetasoH3Video(requestConfig, selectedModel)) {
        assertVideoConfig(requestConfig, requestConfig.model);
        return createOpenAIVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    // Seedance.nz `zhenzhen-video-muse`: fixed 10s/720p/audio, refs as JSON `images[]` (no multipart),
    // so it must not fall through to the generic OpenAI shape (which posts `input_reference` files).
    if (isZhenzhenMuseVideoModel(selectedModel)) {
        return createMuseVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    // APIMart `muse-video-ext`：另一套契约（/videos/generations + /tasks/{id} + image_urls），
    // 落到下面的 OpenAI 形状会 404/400，所以必须在通用路径之前单独分流。
    if (isApimartMuseVideoModel(selectedModel)) {
        return createApimartMuseVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    // Built-in AutoDL ComfyUI path owns resolution/ref_audio mapping. Never let a stale
    // channel script omit ref_audio_0 and surface "模型调用脚本执行失败".
    if (shouldUseAutodlComfyVideoBuiltin(selectedModel, requestConfig.baseUrl, script)) {
        return createAutodlComfyVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
    }
    if (runningHubOrigin(requestConfig.baseUrl)) {
        const channel = resolveModelChannel(config, selectedModel);
        const workflowId = pickRunningHubWorkflowId({
            baseUrl: requestConfig.baseUrl || channel.baseUrl,
            model: requestConfig.model || modelOptionName(selectedModel),
            script,
            channelName: channel.name,
            siblingModels: channel.models,
        });
        if (!workflowId) throw new Error(apiText("runningHubWorkflowFetchFailed", { model: requestConfig.model || modelOptionName(selectedModel) || "空" }));
        return createRunningHubVideoTask(requestConfig, workflowId, script, prompt, safeReferences, options);
    }
    // Native ComfyUI cloud/server: model script = Export Workflow (API) JSON.
    if (shouldUseNativeComfyUi(requestConfig.baseUrl, selectedModel, script) || parseComfyApiWorkflow(script)) {
        return createNativeComfyUiVideoTask(requestConfig, selectedModel, script, prompt, safeReferences, options);
    }
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, safeReferences, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, safeReferences, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const resolved = resolveModelRequestConfig(config, task.model);
    // 聚算任务把 Key 钉在任务上（多 Key 随机只发生在提交那一次）：这里沿用它，别重新随机。
    const requestConfig = task.apiKey && task.apiKey !== resolved.apiKey ? { ...resolved, apiKey: task.apiKey } : resolved;
    assertVideoConfig(requestConfig, requestConfig.model);
    // 聚算 Hub：查询端点是 `/v1/jobs/{id}`，不是 `/videos/{id}`（后者只会 404）。
    if (task.provider === "jusuanhub") return pollJusuanhubVideoTask(requestConfig, task, options);
    // muse 走自己的查询端点（`/video/generations/{id}`，结果在 `data.result_url`）。
    if (isZhenzhenMuseVideoModel(task.model)) return pollMuseVideoTask(requestConfig, task, options);
    // APIMart muse 查的是 `/tasks/{id}`（`data.result.videos[0].url[0]`）。
    if (isApimartMuseVideoModel(task.model)) return pollApimartMuseVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

/**
 * Pre-compress oversized local reference images before any video path sends them.
 * Remote public URLs are left untouched (they don't occupy request-body bytes). Local
 * data URLs / blob images larger than ~700KB are re-encoded to a bounded JPEG so the
 * final request body stays well under the Vercel ~4.5MB serverless cap (413).
 */
async function compressVideoReferences(references: ReferenceImage[]): Promise<ReferenceImage[]> {
    if (!references.length) return references;
    const count = references.length;
    const maxBytes = Math.min(650_000, Math.floor(2_200_000 / count));
    const out: ReferenceImage[] = [];
    for (const image of references) {
        try {
            // Keep existing remote URLs as-is — they are referenced by URL, not inlined.
            const existingRemote = [image.url, image.dataUrl].map((v) => String(v || "").trim()).find((v) => isPublicHttpUrl(v) && !/^blob:/i.test(v));
            if (existingRemote) {
                out.push(image);
                continue;
            }
            const dataUrl = await imageToDataUrl(image);
            if (!dataUrl?.startsWith("data:image/")) {
                out.push(image);
                continue;
            }
            if (getDataUrlByteSize(dataUrl) <= 700_000) {
                out.push(image);
                continue;
            }
            const compressed = await compressReferenceDataUrl(dataUrl, count, { maxEdge: 1280, maxBytes });
            out.push({ ...image, dataUrl: compressed });
        } catch {
            out.push(image);
        }
    }
    return out;
}

async function createMioraVideoTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    const { files } = await runMioraGeneration({
        type: "video",
        prompt,
        references,
        size: config.size,
        vquality: config.vquality,
        signal: options?.signal,
    });
    const videoUrl =
        files.find((url) => /\.(mp4|webm|mov)(\?|$)/i.test(url)) ||
        files.find((url) => url.includes("/api/miora/media")) ||
        files[0];
    if (!videoUrl) throw new Error("WorkBuddy 未返回可用视频");
    const blob = await mediaUrlToBlob(videoUrl, options?.signal);
    const id = nanoid();
    pluginVideoResults.set(id, { blob, mimeType: blob.type || "video/mp4" });
    return { id, provider: "plugin", model };
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
 * RunningHub official workflow API. Model name = workflowId.
 * SelfLift / Singularity and similar shared graphs: paste Export Workflow (API) JSON into the model
 * script when the shared workflow denies API access.
 */
async function createRunningHubVideoTask(
    config: AiConfig,
    model: string,
    script: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
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
    const audioSources = await resolveNativeComfyAudioSources(options?.referenceAudios || [], options?.signal);
    // 文武双全 (YZ金鱼) is the only RunningHub family whose graph exposes `ref_videos.ref_video_0`.
    // Scoped to it so every other model keeps its image+audio-only payload (and never pays for an
    // upload it cannot place). A clip the user wired but we cannot read must fail loudly instead of
    // rendering something unrelated.
    const requestedVideos = options?.referenceVideos || [];
    const videoSources = isMinimaxH3YzjinyuWorkflowId(model) ? await resolveRunningHubVideoSources(requestedVideos, options?.signal) : [];
    if (requestedVideos.length && isMinimaxH3YzjinyuWorkflowId(model) && !videoSources.length) throw new Error(apiText("referenceVideoReadFailed"));
    const result = await runRunningHubWorkflow({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        apiKeys: config.apiKeys,
        model,
        script,
        prompt,
        size: config.size,
        seconds: config.videoSeconds,
        // Singularity / HD Dynamic / Fisher / 文武双全 / 八月文戏: canvas vquality → ResolutionSelector megapixels mapping.
        ...(isMinimaxH3SingularityWorkflowId(model) ||
        isMinimaxH3SingularityLightAiAppId(model) ||
        isMinimaxH3HdDynamicWorkflowId(model) ||
        isMinimaxH3FisherWorkflowId(model) ||
        isWorkFisherLightAiAppId(model) ||
        isMinimaxH3YzjinyuWorkflowId(model) ||
        isMinimaxH3WenxiWorkflowId(model)
            ? { resolution: config.vquality }
            : {}),
        ...(isMinimaxH3FisherWorkflowId(model) ? { fisherMode: config.videoFisherMode } : {}),
        // 韩语人声 / 硬字幕 / 多余台词的共同源头就是 279 号 `MysticXXX_MMH3-V1` LoRA，
        // 默认 0 = 关（纯官方 H3，中文、不烧字、不自己加台词）。要韩剧质感再从面板拖回去。
        // 轻量 AI App `211550…` 同样暴露 279.strength_model，一并传档位。
        // 用 workflowId（本函数的 model 参数）判断；配置里的展示名可能不含数字 id。
        ...(isMinimaxH3FisherWorkflowId(model) ||
        isWorkFisherLightAiAppId(model) ||
        isMinimaxH3SingularityLightAiAppId(model) ||
        isMinimaxH3WenxiLowWorkflowId(model)
            ? { fisherLoraStrength: config.videoFisherLoraStrength ?? "0" }
            : {}),
        // 「提交视觉风格字段」（默认 off）：off 时 `视觉风格：…` 整行不进提示词 —— H3 会把那段中文
        // 当旁白念出来（2026-10-25 第八次报障）。on 时只丢字段名、值照发，给用户做 A/B。
        ...(isMinimaxH3FisherWorkflowId(model) ? { fisherStyleFields: config.videoFisherStyleFields || "off" } : {}),
        // RunningHub Standard / Plus / Ultra → instanceType default|plus|ultra（轻量 App / Fisher / Singularity 轻量）。
        ...(isMinimaxH3FisherWorkflowId(model) || isWorkFisherLightAiAppId(model) || isMinimaxH3SingularityLightAiAppId(model)
            ? { instanceType: config.videoRhInstanceType || "default" }
            : {}),
        media: "video",
        referenceDataUrls: refs.filter(Boolean),
        // Timbre / voice reference: uploaded and written into `ref_audios.ref_audio_*` by the
        // RunningHub adapter. Without this the audio node on the canvas did nothing at all.
        referenceAudioDataUrls: audioSources,
        // Same story for a clip wired into the video node: written into `ref_videos.ref_video_0`.
        ...(videoSources.length ? { referenceVideoDataUrls: videoSources } : {}),
        signal: options?.signal,
    });
    const videoUrl = result.videos[0];
    if (!videoUrl) throw new Error(apiText("runningHubNoVideo"));
    const id = nanoid();
    /**
     * 去字幕：H3 会把硬字幕烧进画面（图里没有字幕节点、节点也没有字幕开关，连静音镜都照样出字），
     * 唯一可靠的办法是生成后重画一遍。
     *
     * 2026-10-26 用户要求：开关从 Fisher 专属组提到**通用视频设置**，默认**关**。所以这里的门
     * 不再是「模型是 Fisher」，而是「用户在这个节点/全局上开了一档」—— 谁开谁生效，默认一个字节不动。
     * 三档见 `SubtitleCropMode`（fill 切完放大回原尺寸 / crop 只切 / blur 模糊盖住）。
     * 裁切是「尽力而为」：拿不到字节 / 浏览器不支持录制 / 超时一律保持原片 —— 带字幕的片子也比没有片子强。
     */
    const cropMode = normalizeSubtitleCropMode(config.videoCropSubtitles);
    const cropped = cropMode
            ? await cropVideoBottomBand(
                  { url: videoUrl },
                  // 实时播放一遍才能保住音轨，所以超时按片长放宽，再留 30 秒余量。
                  { timeoutMs: (Math.max(1, Number(config.videoSeconds) || 10) + 30) * 1000, mode: cropMode },
              ).then((output) => {
                  console.info(
                      `[runninghub] ${model}: subtitle crop (${cropMode}) ${output ? `${output.width}x${output.height} ${output.mimeType}` : "skipped (kept original)"}`,
                  );
                  return output;
              })
            : null;
    // Storyboard-style workflows emit extra images next to the video (e.g. per-scene frames).
    // Carry them through so the canvas can place every output instead of dropping all but one.
    pluginVideoResults.set(
        id,
        cropped
            ? { blob: cropped.blob, mimeType: cropped.mimeType, ...(result.images.length ? { extraImages: result.images } : {}) }
            : { url: videoUrl, mimeType: "video/mp4", ...(result.images.length ? { extraImages: result.images } : {}) },
    );
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
    const audioSources = await resolveNativeComfyAudioSources(options?.referenceAudios || [], options?.signal);
    try {
        const result = await runNativeComfyUiJob({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            workflow,
            workflowId: model,
            prompt,
            referenceDataUrls: refs.filter(Boolean),
            referenceAudioSources: audioSources,
            size: config.size,
            seconds: config.videoSeconds,
            vquality: config.vquality,
            steps: config.videoSteps,
            refImageSize: config.videoRefImageSize,
            samplerName: config.videoSamplerName,
            scheduler: config.videoScheduler,
            seedMode: config.videoSeedMode,
            seed: config.videoSeed,
            audioMode: config.videoAudioMode,
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
        // Surface seetacloud / proxy 502 with the native job's own wording when present; otherwise
        // keep the short gateway label so users are not left with a bare Axios status string.
        if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
            throw new Error(
                error.message?.includes("认证")
                    ? error.message
                    : `ComfyUI 认证失败（HTTP ${error.response.status}）。请确认渠道 API Key 后重试。`,
            );
        }
        if (axios.isAxiosError(error) && (error.response?.status === 502 || error.response?.status === 503 || error.response?.status === 504)) {
            throw new Error(
                error.message?.includes("网关") || error.message?.includes("H3-video") || error.message?.includes("DualClock")
                    ? error.message
                    : `${apiText("badGateway")}（ComfyUI / seetacloud）。请等待 30–60 秒后重试；若刚跑过重任务，勿连续提交。H3-video 双采建议 1080p（长时长更易占满显存），并确认已粘贴 U24 Export JSON。`,
            );
        }
        throw new Error(error instanceof Error ? error.message : apiText("requestFailed"));
    }
}

/** Resolve canvas audio (blob:/storageKey/http) into uploadable sources for native ComfyUI. */
async function resolveNativeComfyAudioSources(audios: ReferenceAudio[], signal?: AbortSignal): Promise<string[]> {
    const { getMediaBlob } = await import("@/services/file-storage");
    const out: string[] = [];
    for (const audio of audios.slice(0, 3)) {
        const url = String(audio.url || "").trim();
        const storageKey = String(audio.storageKey || "").trim();
        if (/^https?:\/\//i.test(url) && !/^blob:/i.test(url)) {
            out.push(url);
            continue;
        }
        if (url.startsWith("data:")) {
            out.push(url);
            continue;
        }
        if (storageKey.includes(":")) {
            try {
                const blob = await getMediaBlob(storageKey);
                if (blob) {
                    out.push(await blobToDataUrl(blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audio.type || "audio/mpeg" })));
                    continue;
                }
            } catch {
                // fall through
            }
        }
        if (/^blob:/i.test(url)) {
            try {
                const response = await fetch(url, { signal });
                const blob = await response.blob();
                out.push(await blobToDataUrl(blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audio.type || "audio/mpeg" })));
                continue;
            } catch {
                // fall through
            }
        }
        if (url && !url.includes(":")) {
            // Unknown local path — skip rather than send a bad value.
            continue;
        }
    }
    return out;
}

/**
 * Resolve a canvas clip into an **uploadable data URL**. RunningHub's VHS loader takes a filename
 * inside the worker's input dir, so a remote URL cannot be handed through untouched the way an
 * image URL can — the bytes have to go up (same reason audio is resolved to a data URL).
 * Canvas clips live in IndexedDB under a `media:` storage key; anything else falls back to the
 * three-step fetch ladder the result download uses (COS/TOS buckets omit ACAO).
 */
async function resolveRunningHubVideoSources(videos: ReferenceVideo[], signal?: AbortSignal): Promise<string[]> {
    const video = videos[0];
    if (!video) return [];
    const type = video.type || "video/mp4";
    const url = String(video.url || "").trim();
    const storageKey = String(video.storageKey || "").trim();
    const asDataUrl = async (blob: Blob) => blobToDataUrl(blob.type.startsWith("video/") ? blob : new Blob([blob], { type }));
    if (storageKey.includes(":")) {
        try {
            const { getMediaBlob } = await import("@/services/file-storage");
            const blob = await getMediaBlob(storageKey);
            if (blob?.size) return [await asDataUrl(blob)];
        } catch {
            // fall through to the URL ladder
        }
    }
    if (/^data:video\//i.test(url)) return [url];
    if (/^blob:/i.test(url) || url.startsWith("/")) {
        try {
            const blob = await (await fetch(url, { signal })).blob();
            if (blob.size) return [await asDataUrl(blob)];
        } catch (error) {
            if (signal?.aborted) throw error;
        }
        return [];
    }
    if (!/^https?:\/\//i.test(url)) return [];
    for (const target of [...new Set([url, proxyMediaUrl(url), forceProxyMediaUrl(url)].filter(Boolean))]) {
        try {
            const response = await axios.get<Blob>(target, { responseType: "blob", signal });
            if (response.data?.size) return [await asDataUrl(response.data)];
        } catch (error) {
            if (axios.isCancel(error) || signal?.aborted) throw error;
        }
    }
    return [];
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
    const { url: submitUrl, bypass: submitBypass } = aiUrlForBody(config, `/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`, body);

    try {
        const submit = (
            await axios.post<ApiEnvelope<{ task_id?: string; status?: string; message?: string }>>(
                submitUrl,
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
        throw new Error(readAxiosError(mapOversizeUploadError(error, submitBypass), apiText("videoTaskCreateFailed")));
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
    if (result.blob) {
        // ComfyUI /view and some proxies reply with application/octet-stream for real
        // media; retype with slice (no full copy) so IndexedDB / <video> see video/mp4.
        const desired =
            result.mimeType && result.mimeType.startsWith("video/")
                ? result.mimeType
                : result.blob.type.startsWith("video/")
                  ? result.blob.type
                  : "video/mp4";
        const blob = result.blob.type === desired ? result.blob : result.blob.slice(0, result.blob.size, desired);
        return uploadMediaFile(blob, "video");
    }
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

    let payload = blob;
    // Shrink oversized image references so the upload fits the site-proxy body budget.
    if (payload.type.startsWith("image/") && payload.size > 2_800_000) {
        try {
            const compressed = await compressReferenceDataUrl(await blobToDataUrl(payload));
            if (compressed.startsWith("data:")) payload = await (await fetch(compressed)).blob();
        } catch {
            // Keep the original blob; the sized-URL fallback below still applies.
        }
    }

    const form = new FormData();
    form.append("file", payload, filename);
    const { url: uploadUrl, bypass } = aiUrlForBody(requestConfig, "/files/upload", form);
    try {
        const response = await axios.post<{ url?: string; data?: { url?: string } | null; code?: number | string; msg?: string; message?: string }>(
            uploadUrl,
            form,
            { headers: { Authorization: `Bearer ${requestConfig.apiKey}` }, signal: options?.signal },
        );
        const hosted = response.data?.url || (response.data?.data && typeof response.data.data === "object" ? response.data.data.url : "") || "";
        if (!hosted || !/^https?:\/\//i.test(hosted)) {
            throw new Error(readApiErrorMessage(response.data) || apiText("providerImageUploadFailed"));
        }
        return hosted;
    } catch (error) {
        throw new Error(readAxiosError(mapOversizeUploadError(error, bypass), apiText("providerImageUploadFailed")));
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
        const postUrl = aiApiUrl(requestConfig, "/videos");
        const created = unwrapVideoTaskResponse(
            (await retryAlternateTransport(requestConfig, "/videos", postUrl, payload, (url) => axios.post<ApiVideoResponse>(url, payload, { headers: aiHeaders(requestConfig, "application/json"), signal: options.signal }))).data,
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

/**
 * Seedance.nz `zhenzhen-video-muse` —— 固定 10 秒 / 720p / 有声的异步视频任务。
 * 契约（https://api.seedance.nz/docs/#muse-video）：
 *   提交 `POST /v1/video/generations`，轮询 `GET /v1/video/generations/{id}`；
 *   `duration` 只收 10、`resolution` 只收 720p、`n` 只收 1、`audio` 只收 true —— **别的值直接被拒**，
 *   所以画布上的时长 / 清晰度旋钮对这个模型不生效（设置面板里有说明）；
 *   参考图走 JSON `images: string[]`（公开 URL 或 data URI），0–9 张，
 *   **不吃 multipart `input_reference`**（通用 OpenAI 路径那条会 400）；
 *   结果在 `data.result_url`，完整列表在 `data.data.content.video_urls[]`，兼容查询时也有 `metadata.url`。
 */
export function isZhenzhenMuseVideoModel(model: string) {
    return /zhenzhen-video-muse/i.test(modelOptionName(model));
}

/** muse 只接受这一个时长 / 分辨率组合（传别的值直接报错）。 */
const MUSE_VIDEO_SECONDS = 10;
const MUSE_VIDEO_RESOLUTION = "720p";
/** `size` 白名单：21:9 不在里面，要退到最接近的 16:9。 */
const MUSE_VIDEO_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function museVideoSize(config: AiConfig) {
    const raw = String(config.size || "").trim();
    // 空 / auto：交给 API 自己决定（文生视频 16:9，带参考图则跟随参考构图）。
    if (!raw || raw === "auto" || raw === "adaptive") return "";
    if ((MUSE_VIDEO_RATIOS as readonly string[]).includes(raw)) return raw;
    const ratio = normalizeVideoRatio(raw);
    if (ratio === "21:9") return "16:9";
    return (MUSE_VIDEO_RATIOS as readonly string[]).includes(ratio) ? ratio : "16:9";
}

async function resolveMuseReferenceImages(references: ReferenceImage[]) {
    const list = references.slice(0, 9);
    if (!list.length) return [] as string[];
    const urls = await Promise.all(list.map((image) => resolveAutodlComfyReferenceUrl(image, list.length)));
    return urls.map((url) => String(url || "").trim()).filter(Boolean);
}

async function createMuseVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    assertVideoConfig(config, modelName);
    if (!prompt.trim()) throw new Error(apiText("videoTaskCreateFailed"));
    const images = await resolveMuseReferenceImages(references);
    const size = museVideoSize(config);
    const payload: Record<string, unknown> = {
        model: modelName,
        prompt,
        duration: MUSE_VIDEO_SECONDS,
        resolution: MUSE_VIDEO_RESOLUTION,
        n: 1,
        audio: true,
        ...(size ? { size } : {}),
        ...(images.length ? { images } : {}),
    };
    try {
        return { id: await postMuseVideoTask(config, "/video/generations", payload, options), provider: "openai", model };
    } catch (error) {
        // 只有「muse 专用端点不存在」（404/405）才退回 OpenAI 兼容的 /videos：有些中转站只挂了通用
        // 视频端点。参数错 / 鉴权错一律原样抛出，绝不因为一个 400 就重复下单（那是白花钱）。
        if (!isMissingVideoEndpoint(error)) throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
        const fallback: Record<string, unknown> = {
            model: modelName,
            prompt,
            seconds: String(MUSE_VIDEO_SECONDS),
            duration: String(MUSE_VIDEO_SECONDS),
            resolution: MUSE_VIDEO_RESOLUTION,
            ...(size ? { ratio: size, size } : {}),
            ...(images.length ? { images } : {}),
        };
        try {
            return { id: await postMuseVideoTask(config, "/videos", fallback, options), provider: "openai", model };
        } catch (retryError) {
            throw new Error(readAxiosError(retryError, apiText("videoTaskCreateFailed")));
        }
    }
}

async function postMuseVideoTask(config: AiConfig, path: string, payload: Record<string, unknown>, options?: RequestOptions) {
    const { url: postUrl, bypass } = aiUrlForBody(config, path, payload);
    try {
        const created = unwrapVideoTaskResponse(
            (await retryAlternateTransport(config, path, postUrl, payload, (url) => axios.post<ApiVideoResponse>(url, payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }))).data,
        );
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return created.id;
    } catch (error) {
        throw mapOversizeUploadError(error, bypass);
    }
}

/** 404/405 = 这条路径没挂上（不是参数被拒）；用来决定「能不能换一条路重试」。 */
function isMissingVideoEndpoint(error: unknown) {
    if (!axios.isAxiosError(error) || !error.response) return false;
    if (error.response.status === 404 || error.response.status === 405) return true;
    return /not\s*found|no\s*route|unsupported\s*path/i.test(readAxiosError(error, ""));
}

function museResultUrl(payload: unknown) {
    const root = readObject(payload);
    if (!root) return "";
    const inner = readObject(root.data) || root;
    const content = readObject(inner.content);
    const nested = readObject(inner.data);
    const nestedContent = readObject(nested?.content);
    const metadata = readObject(inner.metadata);
    const candidates: unknown[] = [
        inner.result_url,
        inner.video_url,
        inner.url,
        content?.video_url,
        content?.url,
        inner.video_urls,
        nested?.result_url,
        nested?.video_url,
        nestedContent?.video_url,
        nestedContent?.video_urls,
        metadata?.url,
        metadata?.video_url,
        metadata?.video_urls,
    ];
    for (const value of candidates) {
        if (typeof value === "string" && value.trim() && /^https?:\/\//i.test(value.trim())) return value.trim();
        if (Array.isArray(value)) {
            const first = value.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item.trim()));
            if (first) return first.trim();
        }
    }
    return "";
}

async function pollMuseVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/video/generations/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const root = readObject(payload) || {};
        const inner = readObject(root.data) || root;
        const url = museResultUrl(payload);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        const status = String(inner.status || root.status || "").toLowerCase();
        if (/fail|cancel|error/.test(status)) {
            const message = [readObject(inner.error)?.message, inner.error, inner.msg, inner.message, inner.fail_reason, root.msg, root.message].find(
                (value): value is string => typeof value === "string" && Boolean(value.trim()),
            );
            return { status: "failed", error: readApiErrorMessage(message) || apiText("videoGenerationFailed") };
        }
        // `completed` 但这一轮还没带出 url（结算后才写 metadata）：继续轮，别提前判死。
        return { status: "pending" };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (!isMissingVideoEndpoint(error)) throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
    // 这个中转站没有 muse 专用查询端点 → 用 OpenAI 兼容的 /videos/{id} 读（同站文档明确支持）。
    return pollOpenAIVideoTask(config, task, options);
}

/**
 * APIMart `muse-video-ext`（https://docs.apimart.ai/cn/api-reference/videos/muse-video-ext/generation）。
 *
 * 它和 Seedance 的 `zhenzhen-video-muse` 是**两套不同契约**，共用一条路就是它跑不通的原因：
 *   · 提交 `POST /v1/videos/generations`，轮询 `GET /v1/tasks/{task_id}`（不是 `/video/generations`）；
 *   · 参考图字段是 `image_urls`（不是 `images`），比例字段是 `aspect_ratio`（不是 `size`，也不吃 WxH）；
 *   · 提交响应 `{code:200, data:[{status:"submitted", task_id:"task_..."}]}` → 任务 ID 在 `data[0].task_id`；
 *   · 查询响应的 `data` 是**对象**，`data.status` + `data.result.videos[0].url[0]`（url 是数组）；
 *   · 规格写死 10s / 720p / 有声 / n=1；`audio:false`、`size:"1024x1024"`、`quality`、`seed` 一律别传。
 */
export function isApimartMuseVideoModel(model: string) {
    return /muse-video-ext/i.test(modelOptionName(model));
}

/**
 * 幂等键：一次「独立生成」一个新键；同一次提交的传输层重试沿用同一个键，
 * 这样超时重发不会变成两笔扣费（文档 409 idempotency_in_progress 就是给这条用的）。
 */
function apimartMuseHeaders(config: AiConfig) {
    const cryptoApi = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
    const key = cryptoApi?.randomUUID ? cryptoApi.randomUUID() : `muse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return { ...aiHeaders(config, "application/json"), Accept: "application/json", "Idempotency-Key": key };
}

/** `data[0].task_id` 为主；`X-APIMart-Response-Version: 2026-07-27` 那种版本则落在 `data.id`。导出供探针复用。 */
export function apimartMuseTaskId(payload: unknown) {
    const root = readObject(payload);
    if (!root) return "";
    const first = readObject(Array.isArray(root.data) ? root.data[0] : null);
    const data = readObject(root.data);
    const candidates = [first?.task_id, first?.id, data?.task_id, data?.id, root.task_id, root.id];
    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

/** `data.result.videos[0].url[0]`；顺带兼容 `video_url` / `result_url` 这类同义写法。导出供探针复用。 */
export function apimartMuseResultUrl(payload: unknown) {
    const root = readObject(payload);
    if (!root) return "";
    const data = readObject(root.data) || root;
    const result = readObject(data.result) || readObject(root.result);
    const videos = Array.isArray(result?.videos) ? result.videos : [];
    const first = readObject(videos[0]);
    const candidates: unknown[] = [first?.url, first?.video_url, result?.video_url, result?.url, data.video_url, data.url, data.result_url];
    for (const value of candidates) {
        if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
        if (Array.isArray(value)) {
            const hit = value.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item.trim()));
            if (hit) return hit.trim();
        }
    }
    return "";
}

/**
 * 提交体。**只放文档认的字段**：`size`、`images`、`audio`、`quality`、`seed`、`negative_prompt`
 * 都不是这个模型的参数（有的直接 400，有的静默忽略），发出去只是给中转站多一个判断点。
 * 导出供探针断言字段面。
 */
export function buildApimartMuseVideoPayload(config: AiConfig, model: string, prompt: string, images: string[] = []) {
    // 空 / auto 一律**省略**这个字段：文档明确不能传 "auto"（省略 = 文生 16:9、参考图生跟随构图）。
    const ratio = museVideoSize(config);
    return {
        model: modelOptionName(model),
        prompt,
        duration: MUSE_VIDEO_SECONDS,
        resolution: MUSE_VIDEO_RESOLUTION,
        n: 1,
        ...(ratio ? { aspect_ratio: ratio } : {}),
        ...(images.length ? { image_urls: images.slice(0, 9) } : {}),
    } as Record<string, unknown>;
}

async function createApimartMuseVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    assertVideoConfig(config, modelName);
    if (!prompt.trim()) throw new Error(apiText("videoTaskCreateFailed"));
    const images = await resolveMuseReferenceImages(references);
    const payload = buildApimartMuseVideoPayload(config, modelName, prompt, images);
    const path = "/videos/generations";
    const { url: postUrl, bypass } = aiUrlForBody(config, path, payload);
    const headers = apimartMuseHeaders(config);
    try {
        const response = await retryAlternateTransport(config, path, postUrl, payload, (url) => axios.post<unknown>(url, payload, { headers, signal: options?.signal }));
        const id = apimartMuseTaskId(response.data);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(mapOversizeUploadError(error, bypass), apiText("videoTaskCreateFailed")));
    }
}

async function pollApimartMuseVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    let payload: unknown;
    try {
        const response = await axios.get<unknown>(aiApiUrl(config, `/tasks/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal });
        payload = response.data;
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
    const root = readObject(payload) || {};
    const data = readObject(root.data) || root;
    const status = String(data.status || root.status || "").toLowerCase();
    // 失败也可能是 HTTP 200 —— 只认 `data.status`，别拿 HTTP 码或 progress=100 当成功。
    if (/fail|error|cancel|reject|denied/.test(status)) {
        const errorNode = readObject(data.error);
        const message = [errorNode?.message, data.error, data.message, data.msg, root.message, root.msg].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
        return { status: "failed", error: readApiErrorMessage(message) || apiText("videoGenerationFailed") };
    }
    const url = apimartMuseResultUrl(payload);
    if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
    // `completed` 但这一轮还没写结果 URL、以及 `unknown` 这种暂不明确的状态，都继续轮 —— 别提前判死。
    return { status: "pending" };
}

/**
 * work-fisher（https://api.work-fisher.com，文档 `#models-workfisher-ext`）—— 单独分流。
 *
 *   提交  POST /v1/videos        { model, prompt, seconds, metadata:{ resolution, ratio, generate_audio } }
 *   查询  GET  /v1/videos/{id}   status: queued | in_progress | completed | failed
 *   直链  completed 时在 **`metadata.url`**（带签名的临时地址，取到就得立刻下载转存）
 *   参考图 `images: string[]`（1 张 = 首帧，2 张 = 首帧 + 尾帧）；超过 2 张走 `metadata.content`
 *
 * 🔴 为什么必须单独分流：模型名 `rh-ai-aifisher-h3-m10-s10` 里的 `-h3-` 会命中
 *    `isRelayMiniMaxH3Video`，被当成 MiniMax-H3 中转 → 发 `size:1344x768` /
 *    `resolution:768P` / `input_reference:{image_url}` 这一套 CometAPI 形状，而 work-fisher
 *    只认 `metadata`。请求被降级解析后上游会按工作流自带的示例提示词出片 ——
 *    表现就是「生成的画面跟我的提示词完全没关系」。
 */
async function createWorkFisherVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model).trim();
    if (!modelName) throw new Error(apiText("videoModelRequired"));
    const promptText = String(prompt || "").trim();
    // 🔴 空提示词不要下发：RunningHub 系工作流（`rh-*`）在收不到提示词时会**用工作流自带的
    //    示例提示词出片**，看着像「正常生成」，实际内容和用户写的毫无关系。宁可在这里拦下来。
    //    （挂了参考图的图生视频允许不写提示词 —— 但那也要让人看得见「没发提示词」这件事。）
    if (!promptText && !references.length) throw new Error(apiText("videoPromptRequired"));
    if (!promptText) console.warn(`[work-fisher] ${modelName} 这次没有提示词，上游会用工作流自带的示例提示词出片`);

    const ratio = normalizeVideoRatio(config.size);
    const resolution = normalizeWorkFisherResolution(config.vquality);
    const seconds = workFisherSeconds(config.videoSeconds);
    const generateAudio = boolConfig(config.videoGenerateAudio, true);

    // 参考图：文档只收公开 URL（不收 data URI），本地图先传到上游 /v1/files/upload 换成 URL。
    // 单张失败不该毁掉整单 —— 能发几张发几张。
    const imageUrls: string[] = [];
    for (const image of references.slice(0, 9)) {
        const existing = [image.url, image.dataUrl].map((value) => String(value || "").trim()).find((value) => isPublicHttpUrl(value) && !value.startsWith("data:"));
        if (existing) {
            imageUrls.push(existing);
            continue;
        }
        try {
            const dataUrl = await imageToDataUrl(image);
            if (!dataUrl?.startsWith("data:image/")) continue;
            const blob = await (await fetch(dataUrl)).blob();
            const uploaded = await uploadProviderMediaFile(config, blob, publicImageFilename(blob), options);
            if (isPublicHttpUrl(uploaded) && !uploaded.startsWith("data:")) imageUrls.push(uploaded);
        } catch {
            // 忽略单张失败
        }
    }

    const metadata: Record<string, unknown> = { resolution, ratio, generate_audio: generateAudio };
    // 文档：`images` 只用于图生视频，1 张首帧 / 2 张首尾帧；更多参考素材走 `metadata.content`
    //（一旦给了 content，顶层 images 会被整体覆盖）。
    if (imageUrls.length > 2) {
        metadata.content = imageUrls.map((url) => ({ type: "image_url", image_url: { url } }));
    }
    const images = imageUrls.length <= 2 && imageUrls.length ? imageUrls : undefined;

    const base: Record<string, unknown> = { model: modelName, prompt: promptText, ...(images ? { images } : {}) };
    const attempts: Record<string, unknown>[] = [
        // 文档形状：`seconds` 在顶层。
        { ...base, seconds, metadata },
        // 官方 curl 形状：`seconds` 塞进 metadata（老版 /v1/video/generations 的写法）。
        // 只在第一发 400 时才会走到，避免个别适配器只读这一处。
        { ...base, metadata: { ...metadata, seconds } },
        // 最小合法体：某些严格适配器（不适合 ratio / generate_audio 的模型）会对多余键报 400，
        // 退到只剩文档里最核心的三个字段。
        { ...base, seconds, metadata: { resolution } },
    ];

    let lastError: unknown;
    for (const payload of attempts) {
        // 排查「出片内容跟提示词无关」时最需要的就是「我们到底发了什么」——payload 里没有密钥，
        // 只有 model / prompt / metadata，所以线上也打（提示词截断到 300 字）。
        console.info("[work-fisher] create video body", {
            model: payload.model,
            seconds: payload.seconds ?? (payload.metadata as Record<string, unknown> | undefined)?.seconds,
            images: Array.isArray(payload.images) ? payload.images.length : 0,
            promptPreview: String(payload.prompt || "").slice(0, 300),
            promptLength: String(payload.prompt || "").length,
            metadata: payload.metadata,
        });
        try {
            const postUrl = aiApiUrl(config, "/videos");
            const rawCreated = (await retryAlternateTransport(config, "/videos", postUrl, payload, (url) => axios.post<ApiVideoResponse>(url, payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }))).data;
            const created = unwrapVideoResponse(rawCreated);
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            // 上游若回显 prompt，就核对一下：不一致 = 网关把提示词改写了/丢了，
            // 那就是「出片跟提示词无关」的直接证据（比事后猜字段快得多）。
            const echoed = (rawCreated as unknown as { prompt?: unknown; input?: { prompt?: unknown } }) || {};
            const upstreamPrompt = typeof echoed.prompt === "string" ? echoed.prompt : typeof echoed.input?.prompt === "string" ? echoed.input.prompt : "";
            if (upstreamPrompt && promptText && !upstreamPrompt.includes(promptText.slice(0, 12))) {
                console.warn("[work-fisher] 上游回显的提示词与我们提交的不一致（提示词可能在网关被改写）", {
                    sent: promptText.slice(0, 300),
                    got: upstreamPrompt.slice(0, 300),
                });
            }
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            if (!axios.isAxiosError(error) || error.response?.status !== 400) break;
        }
    }
    throw new Error(readAxiosError(lastError, apiText("videoTaskCreateFailed")));
}

/** work-fisher 清晰度档位：480p / 720p / 1080p / 2k / 4k（另有 native1080p / native4k）。 */
export function normalizeWorkFisherResolution(value: string) {
    const raw = (value || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!raw) return "720p";
    if (raw === "native1080p" || raw === "native4k" || raw === "2k" || raw === "4k") return raw;
    const aliases: Record<string, string> = {
        low: "480p",
        sd: "480p",
        "480": "480p",
        medium: "720p",
        standard: "720p",
        auto: "720p",
        "720": "720p",
        high: "1080p",
        hd: "1080p",
        "1080": "1080p",
    };
    if (aliases[raw]) return aliases[raw];
    const numeric = Number(raw.replace(/p$/, ""));
    if (!Number.isFinite(numeric)) return "720p";
    if (numeric <= 480) return "480p";
    if (numeric <= 720) return "720p";
    if (numeric <= 1080) return "1080p";
    if (numeric <= 1440) return "2k";
    return "4k";
}

/** work-fisher 时长：整数秒，Seedance 2.0 收 4–15、2.5 收 4–30，这里给 [1,30] 让上游自己校验。 */
function workFisherSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return String(Math.max(1, Math.min(30, seconds)));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (isMetasoH3Video(config, model)) {
        return createMetasoH3VideoTask(config, model, prompt, references, options);
    }
    if (isRelayMiniMaxH3Video(config, model)) {
        return createRelayMiniMaxH3VideoTask(config, model, prompt, references, options);
    }
    // aicost.me 的 Seedance 中转只认 JSON（参考图走 `images: string[]`）。走通用 multipart
    // 分支会被 Go 服务端把表单值当字符串再反序列化进 bool 字段 → HTTP 400。
    if (isAicostJsonVideoHost(config.baseUrl)) {
        return createJsonReferenceVideoTask(config, model, prompt, references, options);
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
            const postUrl = aiApiUrl(config, "/videos");
            const created = unwrapVideoResponse(
                (await retryAlternateTransport(config, "/videos", postUrl, payload, (url) => axios.post<ApiVideoResponse>(url, payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }))).data,
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
    const files = await Promise.all(
        references.slice(0, 7).map(async (image) => {
            const rawDataUrl = await imageToDataUrl(image);
            // Keep the multipart body under the site-proxy cap for large photos.
            const dataUrl = rawDataUrl.startsWith("data:image/") ? await compressReferenceDataUrl(rawDataUrl, Math.max(1, references.length)) : rawDataUrl;
            return dataUrlToFile({ ...image, dataUrl });
        }),
    );
    // OpenAI / New API expect repeated `input_reference`, not `input_reference[]`.
    files.forEach((file) => body.append("input_reference", file));
    const { url: postUrl, bypass } = aiUrlForBody(config, "/videos", body);
    try {
        const created = unwrapVideoResponse(
            (await retryAlternateTransport(config, "/videos", postUrl, body, (url) => axios.post<ApiVideoResponse>(url, body, { headers: aiHeaders(config), signal: options?.signal }))).data,
        );
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        const mapped = mapOversizeUploadError(error, bypass);
        // 部分 New API 系（Go）中转把 multipart 字段一律当字符串再反序列化进结构体：
        // `json: cannot unmarshal string into Go struct field .Alias.generate_audio of type bool`
        // → 挂了参考图必 400（文生视频走 JSON 反而正常）。这类渠道只能换 JSON + `images[]` 再试。
        if (isGoFormBoolUnmarshalError(mapped)) {
            try {
                return await createJsonReferenceVideoTask(config, model, prompt, references, options);
            } catch (fallbackError) {
                throw new Error(readAxiosError(fallbackError, apiText("videoTaskCreateFailed")));
            }
        }
        throw new Error(readAxiosError(mapped, apiText("videoTaskCreateFailed")));
    }
}

/**
 * JSON + `images: string[]` 提交：aicost.me 的 Seedance 契约（https://www.aicost.me/api-docs），
 * 同时作为 New API 系中转「multipart 字段被字符串化」的兜底形状。
 *
 *   POST /v1/videos   application/json
 *   { model, prompt, seconds, aspect_ratio, resolution, images?: string[] }
 *   查询 GET /v1/videos/{id}（结果在 `result_url`），下载 GET /v1/videos/{id}/content
 *
 * 🔴 关键：**一个字符串化的 bool 都不能发**。Go 端 `generate_audio bool` / `watermark bool`
 *    收到 `"true"` 会直接 unmarshal 失败；`seconds` 也发数字而不是 `"5"`。文档里没有的
 *    `preset` / `size` / `duration` / `resolution_name` 也一律不发，少一个字段少一种 400。
 */
export type JsonVideoRequestBody = {
    model: string;
    prompt: string;
    seconds: number;
    aspect_ratio: string;
    resolution: string;
    images?: string[];
};

/**
 * 模型名自带分辨率后缀时以它为准：aicost 的模型广场就按这个规则命名
 * （`seedance2.0-xxx-720p`、`seedance2.0-xxx-1080p`、用户的 `2.5-480p-…`），
 * 官方文档也写明「720p 专属模型只收 720p，传别的值返回参数错误」。
 */
function resolutionFromModelName(model: string) {
    const matched = modelOptionName(model).match(/(?:^|[^0-9])(480|720|1080)\s*p(?:[^a-z0-9]|$)/i);
    return matched ? `${matched[1]}p` : "";
}

/**
 * 纯函数：aicost.me / New API 系「JSON 视频」请求体。
 * 只发文档里有的字段，且 `seconds` 是**数字**——Go 端 `json.Unmarshal` 不会帮我们做
 * `"6"` → `6` 的转换，类型不对就是 400。
 */
export function buildJsonVideoRequestBody(
    config: Pick<AiConfig, "size" | "vquality" | "videoSeconds">,
    model: string,
    prompt: string,
    images: string[] = [],
): JsonVideoRequestBody {
    const body: JsonVideoRequestBody = {
        model: modelOptionName(model),
        prompt,
        seconds: Math.max(4, Math.min(15, Math.floor(Number(config.videoSeconds) || 5))),
        aspect_ratio: normalizeVideoRatio(config.size),
        resolution: resolutionFromModelName(model) || normalizeVideoResolution(config.vquality),
    };
    if (images.length) body.images = images;
    return body;
}

async function createJsonReferenceVideoTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    if (!prompt.trim()) throw new Error(apiText("videoTaskCreateFailed"));
    const images = await buildJsonReferenceImages(references);
    const payload = buildJsonVideoRequestBody(config, model, prompt, images);
    // 参考图是 data URL 时 body 会很大：交给 aiUrlForBody 决定是否绕开站点代理。
    const { url: postUrl, bypass } = aiUrlForBody(config, "/videos", payload);
    try {
        const created = unwrapVideoResponse(
            (await retryAlternateTransport(config, "/videos", postUrl, payload, (url) => axios.post<ApiVideoResponse>(url, payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }))).data,
        );
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(mapOversizeUploadError(error, bypass), apiText("videoTaskCreateFailed")));
    }
}

/**
 * 参考图 → `images[]`：公网 URL 原样用，本地图转 data URL（aicost 明确接受
 * `data:image/...;base64,...`）并按张数压体积，别把 body 顶到对方 413 线上。
 */
async function buildJsonReferenceImages(references: ReferenceImage[]): Promise<string[]> {
    if (!references.length) return [];
    const count = Math.max(1, references.length);
    const maxBytes = Math.min(650_000, Math.floor(2_200_000 / count));
    const images: string[] = [];
    for (const image of references.slice(0, 7)) {
        const remote = [image.url, image.dataUrl]
            .map((value) => String(value || "").trim())
            .find((value) => isPublicHttpUrl(value) && !value.startsWith("data:") && !/^blob:/i.test(value));
        if (remote) {
            images.push(remote);
            continue;
        }
        try {
            const dataUrl = await imageToDataUrl(image);
            if (!dataUrl?.startsWith("data:image/")) continue;
            images.push(await compressReferenceDataUrl(dataUrl, count, { maxEdge: 1280, maxBytes }));
        } catch {
            // 单张读不出来就跳过，别让整单失败（与 H3 路径一致）。
        }
    }
    return images;
}

/** 识别「multipart 表单值被字符串化后再反序列化进 bool 字段」这一类 Go 中转错误。 */
function isGoFormBoolUnmarshalError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const data = error.response?.data;
    const text = typeof data === "string" ? data : data ? JSON.stringify(data) : String(error.message || "");
    return /cannot unmarshal .* into Go struct field .* of type bool/i.test(text);
}

/**
 * Metaso MiniMax-H3 via OpenAI-compatible /v1/videos.
 * Spec shape: https://metaso.cn/minimax-h3/new-api-guide
 * Note: that guide's `sora-2` is a New API *channel mapping alias*.
 * Calling https://metaso.cn/api/openai directly requires the real model id (e.g. MiniMax-H3).
 */
async function createMetasoH3VideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!references.length) throw new Error(apiText("metasoH3ImageRequired"));
    const modelName = resolveMetasoDirectModelName(model);
    const seconds = normalizeMetasoH3Seconds(config.videoSeconds);
    const size = normalizeMetasoH3Size(config.size, config.vquality);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) throw new Error(apiText("videoTaskCreateFailed"));

    const { publicUrl, dataUrl, file } = await resolveMetasoH3ImageSources(references[0], size, options);
    const attempts: Array<() => Promise<VideoGenerationTask>> = [];

    // 1) JSON + public HTTPS (docs shape).
    if (publicUrl) {
        attempts.push(() => postMetasoH3VideoJson(config, model, modelName, trimmedPrompt, seconds, size, publicUrl, options));
    }
    // 2) Multipart file (OpenAI-native local reference; Metaso has no /files/upload).
    if (file) {
        attempts.push(async () => {
            const body = new FormData();
            body.append("model", modelName);
            body.append("prompt", trimmedPrompt);
            body.append("seconds", String(seconds));
            body.append("size", size);
            body.append("input_reference", file);
            const { url: postUrl, bypass } = aiUrlForBody(config, "/videos", body);
            const created = unwrapVideoResponse(
                (await axios.post<ApiVideoResponse>(postUrl, body, { headers: aiHeaders(config), signal: options?.signal }).catch((error: unknown) => {
                    throw mapOversizeUploadError(error, bypass);
                })).data,
            );
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            return { id: created.id, provider: "openai", model };
        });
    }
    // 3) JSON + data URL (OpenAI image_url allows base64).
    if (dataUrl) {
        attempts.push(() => postMetasoH3VideoJson(config, model, modelName, trimmedPrompt, seconds, size, dataUrl, options));
    }
    if (!attempts.length) throw new Error(apiText("metasoH3PublicImageRequired"));

    let lastError: unknown;
    for (const attempt of attempts) {
        try {
            return await attempt();
        } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            if (!axios.isAxiosError(error) || error.response?.status !== 400) break;
        }
    }
    throw new Error(readAxiosError(lastError, apiText("videoTaskCreateFailed")));
}

async function postMetasoH3VideoJson(
    config: AiConfig,
    model: string,
    modelName: string,
    prompt: string,
    seconds: number,
    size: string,
    imageUrl: string,
    options?: RequestOptions,
): Promise<VideoGenerationTask> {
    const payload = {
        model: modelName,
        prompt,
        seconds,
        size,
        input_reference: { image_url: imageUrl },
    };
    // Inline base64 can exceed the site-proxy body cap — bypass to direct POST when it does.
    const { url: postUrl, bypass } = aiUrlForBody(config, "/videos", payload);
    const created = unwrapVideoResponse(
        (await axios.post<ApiVideoResponse>(postUrl, payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }).catch((error: unknown) => {
            throw mapOversizeUploadError(error, bypass);
        })).data,
    );
    if (!created.id) throw new Error(apiText("noVideoTaskId"));
    return { id: created.id, provider: "openai", model };
}

/**
 * Prefer a public HTTPS URL (docs examples). Keep a sized file/data URL as fallbacks
 * when temp hosts fail or Metaso cannot fetch the hosted file.
 */
async function resolveMetasoH3ImageSources(image: ReferenceImage, size: string, options?: RequestOptions) {
    const existing = [image.url, image.dataUrl].map((value) => String(value || "").trim()).find((value) => isPublicHttpUrl(value) && !value.startsWith("data:") && !/^blob:/i.test(value));
    const rawDataUrl = await imageToDataUrl(image);
    if (!rawDataUrl?.startsWith("data:image/")) {
        if (existing) return { publicUrl: existing, dataUrl: "", file: null as File | null };
        throw new Error(apiText("metasoH3ImageUnreadable"));
    }

    const sizedDataUrl = await resizeImageDataUrlToExactSize(rawDataUrl, size);
    const blob = await (await fetch(sizedDataUrl)).blob();
    const file = new File([blob], publicImageFilename(blob), { type: blob.type || "image/jpeg" });
    let publicUrl = "";
    try {
        const hosted = await uploadTemporaryPublicImage(blob, publicImageFilename(blob), options?.signal);
        if (isPublicHttpUrl(hosted) && !hosted.startsWith("data:")) publicUrl = hosted;
    } catch {
        // Temp hosts may be blocked; multipart / data URL still work.
    }

    const dataUrl = sizedDataUrl.startsWith("data:image/") && sizedDataUrl.length < 3_500_000 ? sizedDataUrl : "";
    if (!publicUrl && !dataUrl && !file.size) {
        if (existing) return { publicUrl: existing, dataUrl: "", file: null };
        throw new Error(apiText("metasoH3PublicImageRequired"));
    }
    return { publicUrl, dataUrl, file };
}

/** Direct Metaso OpenAI root expects MiniMax-H3; `sora-2` is only a New API mapping alias. */
function resolveMetasoDirectModelName(model: string) {
    const name = modelOptionName(model).trim();
    if (!name || /^sora-2$/i.test(name)) return "MiniMax-H3";
    return name;
}

/** Cover-crop / scale so pixel WxH equals Metaso `size`. */
async function resizeImageDataUrlToExactSize(dataUrl: string, size: string) {
    const match = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(size.trim());
    if (!match) return dataUrl;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return dataUrl;

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(apiText("metasoH3ImageUnreadable")));
        element.src = dataUrl;
    });

    if (image.naturalWidth === width && image.naturalHeight === height) {
        // Re-encode as JPEG for a stable content-type when hosting.
        if (/^data:image\/jpeg/i.test(dataUrl)) return dataUrl;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;

    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const dx = (width - drawWidth) / 2;
    const dy = (height - drawHeight) / 2;
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, dx, dy, drawWidth, drawHeight);

    return canvas.toDataURL("image/jpeg", 0.92);
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
    // 「请求尺寸」和「参考图裁切尺寸」必须是同一个值：不一致时上游只会认其中一个，
    // 另一个被静默忽略 —— 表现就是「明明选了 1:1 / 21:9，出来的却是 16:9」。
    // 官方 H3 只有 16:9 / 9:16（及近似竖版）这几档，其余比例用 CometAPI 的 WxH 表。
    const targetSize = ["16:9", "9:16", "3:4", "2:3"].includes(ratio) ? metasoSize : size;

    // ⚠️ H3 的构图比例实际来自首帧 / 参考图本身：中转站对 `size` / `aspect_ratio` 基本是
    //    「收下但不报错」，出片仍按参考图比例来。所以必须先把参考图 **cover 裁到目标比例**
    //    再上传（与 Metaso 路径共用 `resizeImageDataUrlToExactSize`）—— 否则用户选 16:9、
    //    参考图是竖图，成品依旧是 9:16。裁切只改画幅，不改构图中心。
    const imageUrls: string[] = [];
    for (const image of references.slice(0, 9)) {
        let dataUrl = "";
        try {
            dataUrl = await imageToDataUrl(image);
        } catch {
            dataUrl = "";
        }
        if (dataUrl?.startsWith("data:image/")) {
            try {
                const sized = await resizeImageDataUrlToExactSize(dataUrl, targetSize);
                const blob = await (await fetch(sized)).blob();
                const uploaded = await uploadProviderMediaFile(config, blob, publicImageFilename(blob), options);
                if (isPublicHttpUrl(uploaded) && !uploaded.startsWith("data:")) {
                    imageUrls.push(uploaded);
                    continue;
                }
            } catch {
                // 裁切 / 上传失败 → 退回原图直连：比例可能不保，但别让整单失败。
            }
        }
        const publicUrl = [image.url, image.dataUrl].map((value) => String(value || "").trim()).find((value) => isPublicHttpUrl(value) && !value.startsWith("data:"));
        if (publicUrl) imageUrls.push(publicUrl);
    }

    const attempts: Record<string, unknown>[] = [
        // New API / Sora-compatible JSON (primary for manxueapi.com).
        // 🔴 比例字段必须**一次给全**：不同中转分别读 `size` / `aspect_ratio` / `ratio`，
        //    不认的会被忽略；但绝不能像以前那样「第一发只给 size，返回 200 就再也不发
        //    aspect_ratio」—— 那正是「选了 16:9 出来还是 9:16」的第二个原因。
        {
            model: modelName,
            prompt,
            seconds,
            duration: secondsNum,
            size: targetSize,
            aspect_ratio: ratio,
            ratio,
            resolution,
            ...(imageUrls[0] ? { input_reference: { image_url: imageUrls[0] } } : {}),
        },
        // Same shape with CometAPI WxH sizes some H3 adapters expect.
        {
            model: modelName,
            prompt,
            seconds,
            duration: secondsNum,
            size,
            aspect_ratio: ratio,
            ratio,
            resolution,
            ...(imageUrls[0] ? { input_reference: { image_url: imageUrls[0] } } : {}),
        },
        // MiniMax-native field names used by some New API model adapters.
        {
            model: modelName,
            prompt,
            duration: secondsNum,
            seconds,
            size: targetSize,
            resolution,
            aspect_ratio: ratio,
            ratio,
            ...(imageUrls[0] ? { first_frame_image: imageUrls[0] } : {}),
        },
    ];

    let lastError: unknown;
    for (const payload of attempts) {
        const { url: postUrl, bypass } = aiUrlForBody(config, "/videos", payload);
        try {
            const created = unwrapVideoResponse(
                (await retryAlternateTransport(config, "/videos", postUrl, payload, (url) => axios.post<ApiVideoResponse>(url, payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal }))).data,
            );
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            lastError = mapOversizeUploadError(error, bypass);
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
            // Only retry alternate shapes on 400 validation errors.
            if (!axios.isAxiosError(error) || error.response?.status !== 400) break;
        }
    }

    // Last resort: multipart (CometAPI-style) when the relay rejects JSON shapes.
    if (imageUrls.length || references.length) {
        const body = new FormData();
        body.append("model", modelName);
        body.append("prompt", prompt);
        body.append("seconds", seconds);
        body.append("size", targetSize);
        body.append("aspect_ratio", ratio);
        body.append("ratio", ratio);
        for (const imageUrl of imageUrls.slice(0, 9)) body.append("images", imageUrl);
        if (!imageUrls.length) {
            for (const image of references.slice(0, 9)) {
                const rawDataUrl = await imageToDataUrl(image);
                if (!rawDataUrl?.startsWith("data:image/")) continue;
                // 与上面一致：先 cover 裁到目标画幅，再压体积（不然还是按参考图比例出片）。
                const sizedDataUrl = await resizeImageDataUrlToExactSize(rawDataUrl, targetSize).catch(() => rawDataUrl);
                // Compressed so the multipart body fits the site-proxy cap.
                const dataUrl = await compressReferenceDataUrl(sizedDataUrl, Math.max(1, references.length));
                body.append("input_reference", await dataUrlToFile({ ...image, dataUrl }));
            }
        }
        const { url: postUrl, bypass } = aiUrlForBody(config, "/videos", body);
        try {
            const created = unwrapVideoResponse(
                (await retryAlternateTransport(config, "/videos", postUrl, body, (url) => axios.post<ApiVideoResponse>(url, body, { headers: aiHeaders(config), signal: options?.signal }))).data,
            );
            if (!created.id) throw new Error(apiText("noVideoTaskId"));
            return { id: created.id, provider: "openai", model };
        } catch (error) {
            lastError = mapOversizeUploadError(error, bypass);
        }
    }

    throw new Error(readAxiosError(lastError, apiText("videoTaskCreateFailed")));
}

function videoHostname(value: string) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
        return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
        return "";
    }
}

/**
 * aicost.me（含子域）：Seedance 中转只收 `application/json`，参考图走 `images: string[]`。
 * 走通用 multipart 会被 Go 端反序列化进 `generate_audio bool` 失败 → 400。
 * 导出给探针用。
 */
export function isAicostJsonVideoHost(baseUrl: string) {
    const hostname = videoHostname(baseUrl);
    return hostname === "aicost.me" || hostname.endsWith(".aicost.me");
}

/**
 * work-fisher（api.work-fisher.com 及其子域）：视频走 `/v1/videos` + `metadata` 契约，
 * 结果在 `metadata.url`。**必须在所有模型名启发式之前分流** —— 它挂的模型名里带 `h3`
 * （`rh-ai-aifisher-h3-m10-s10`），否则会被 `isRelayMiniMaxH3Video` 抢走。导出给探针用。
 */
export function isWorkFisherVideoHost(baseUrl: string) {
    const hostname = videoHostname(baseUrl);
    return hostname === "work-fisher.com" || hostname.endsWith(".work-fisher.com");
}

function isMetasoH3Video(config: AiConfig, _model: string) {
    // Only Metaso's OpenAI root uses the sora-2 JSON shape. Other H3 relays differ.
    return /metaso\.cn/i.test(config.baseUrl.trim());
}

/**
 * Non-Metaso / non-AutoDL MiniMax-H3 OpenAI relays (e.g. wb2api…/v1 + cn:miora-minimax-h3).
 * Exported so the video settings panel can offer 720 / 1080 / 2K for these models.
 */
export function isRelayMiniMaxH3Video(config: AiConfig, model: string) {
    if (/autodl\.art|metaso\.cn/i.test(config.baseUrl.trim())) return false;
    // work-fisher 挂了 RunningHub 系的 `rh-*-h3-*` 工作流模型，名字里带 `-h3-` 但不是
    // MiniMax-H3 中转：它的契约是 `/v1/videos` + `metadata`（见 createWorkFisherVideoTask）。
    if (isWorkFisherVideoHost(config.baseUrl)) return false;
    const name = modelOptionName(model).toLowerCase();
    return /minimax[-_]?h3|(?:^|[-_])h3(?:$|[-_])|1ren[-_]?minimax|miora[-_]?minimax/i.test(name);
}

/** Metaso examples use 4 / 8 / 12 seconds. */
function normalizeMetasoH3Seconds(value: string) {
    const seconds = Math.floor(Number(value) || 4);
    const allowed = [4, 8, 12];
    return allowed.reduce((best, current) => (Math.abs(current - seconds) < Math.abs(best - seconds) ? current : best));
}

/** Metaso documented sizes: 1280x720, 720x1280, 1792x1024, 1024x1792. */
export function normalizeMetasoH3Size(size: string, quality: string) {
    const ratio = normalizeVideoRatio(size);
    const high = /high|2k|1080|1792|1024x1792|1792x1024/i.test(quality || "") || /1792|1024x1792|1792x1024/i.test(size || "");
    if (ratio === "9:16" || ratio === "3:4" || ratio === "2:3") return high ? "1024x1792" : "720x1280";
    return high ? "1792x1024" : "1280x720";
}

/** CometAPI canonical H3 WxH table (768P / 2K). */
export function normalizeRelayH3Size(size: string, quality: string) {
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

function isPublicHttpUrl(value: string) {
    return /^https?:\/\//i.test((value || "").trim());
}

function publicImageFilename(blob: Blob) {
    if (blob.type.includes("png")) return "reference.png";
    if (blob.type.includes("webp")) return "reference.webp";
    return "reference.jpg";
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

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const rawResponse = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const video = unwrapVideoResponse(rawResponse);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            // `/videos/{id}/content` 是 **OpenAI 原生 video 契约**才有的一次性下载端点。
            // work-fisher / New API 系中转没有它，直链只在响应体里（上面 `videoResultUrl` 深度扫描过）。
            // 这里再失败就说明「任务完成但响应里没有可用直链」，必须给能定位的文案 ——
            // 把顶层字段和截断的原始 JSON 一起带出去，用户截图/贴回来就能知道该认哪个字段。
            try {
                const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
                await assertVideoBlob(content.data);
                return { status: "completed", result: { blob: content.data } };
            } catch (contentError) {
                if (axios.isCancel(contentError) || options?.signal?.aborted) throw contentError;
                const detail = describeVideoPayload(rawResponse);
                // 也不只是「报错」：完整响应留在控制台，方便下次直接照着补字段。
                console.warn("[video] 任务已完成但没有解析出视频直链，原始响应如下（把这行内容贴给开发者即可定位）", rawResponse);
                throw new Error(`${apiText("videoResultMissing")}\n响应字段：${detail.keys.join(", ") || "（空）"}\n原始：${detail.raw}`);
            }
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    const direct = String(url || "").trim();
    if (!/^https?:\/\//i.test(direct)) return { url: direct, mimeType: "video/mp4" };
    // Result buckets often omit Access-Control-Allow-Origin (Tencent COS / ByteDance TOS), so the
    // direct XHR is blocked by CORS even though the file itself is fine. A remote-URL fallback
    // keeps playback working, but then nothing lands in IndexedDB: no thumbnail, no export, and
    // the node breaks once the signed URL expires. Retry through the same-origin media proxy
    // (which sets ACAO) so we still get a real blob — same ladder as image-storage/save-blob.
    const targets = [...new Set([direct, proxyMediaUrl(direct), forceProxyMediaUrl(direct)].filter(Boolean))];
    for (const target of targets) {
        try {
            const response = await axios.get<Blob>(target, { responseType: "blob", signal: options?.signal });
            await assertVideoBlob(response.data);
            return { blob: response.data };
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        }
    }
    return { url: direct, mimeType: "video/mp4" };
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

/**
 * 从查询响应里挑出视频直链。**顺序有讲究**，也**不能只看顶层那几个字段**。
 *
 * 🔴 踩过两次：
 *   1. work-fisher 完成后直链在 `metadata.url`，早期不认 → `pollOpenAIVideoTask` 以为
 *      「completed 但没 URL」，转去 GET `/videos/{id}/content`（OpenAI 原生 video 才有的端点，
 *      work-fisher 没有）→ 面板报 500，而**后台视频其实早就好了**。
 *   2. 只补 `metadata.url` 仍然不够：`rh-ai-aifisher-*` 这类工作流模型回来的是
 *      `output/outputs[0]/files[0].url`、甚至是字符串里套 JSON。逐字段猜永远猜不完。
 *
 * 所以：先走「已知字段」的快速路径（顺序固定、语义明确），再退到**深度扫描**——
 * 把整个响应（含数组、含字符串里的 JSON）走一遍，按「像不像成片直链」打分取最高：
 *   100 = 带 .mp4/.mov/.webm/.m3u8 后缀
 *    70 = 路径里有 /video /output /result /download 这类段
 *    60 = 已知媒体 CDN（腾讯 COS / 阿里 OSS / 火山 TOS / CloudFront / work-fisher 自己）
 *    10 = 其它 http(s) 链接（最后兜底，宁可给个可疑链接也别报错）
 * 缩略图/封面/参考图（jpg/png…、thumb/cover/image/input 这些键）一律不算。
 */
const MEDIA_KEY_SKIP = /(thumb|cover|poster|preview|placeholder|avatar|icon|logo|image|img|photo|frame|audio|music|voice|prompt|negative|input|source|ref)/i;
/** 名字就像「成片地址」的键，同分时优先（`output` 压过 `trace` 这种审计字段）。 */
const MEDIA_KEY_BONUS = /^(video|video_url|videourl|url|output|outputs|file|files|result|results|download|download_url|downloadurl|play_url|source_url)$/i;
const MEDIA_INPUT_SUBTREE = /^(inputs?|images?|references?|reference_images?|input_reference|ref_images?|prompt|negative_prompt|audios?|audios?)$/i;
const MEDIA_IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|svg)(\?|#|$)/i;

type VideoUrlCandidate = { url: string; key: string; score: number };

function scoreVideoUrl(raw: unknown, key: string): number {
    if (typeof raw !== "string") return 0;
    const url = raw.trim();
    if (!/^https?:\/\//i.test(url)) return 0;
    if (MEDIA_IMAGE_EXT.test(url)) return 0;
    if (key && MEDIA_KEY_SKIP.test(key) && !/video/i.test(key)) return 0;
    const bonus = key && MEDIA_KEY_BONUS.test(key) ? 5 : 0;
    if (/\.(mp4|m4v|mov|webm|mkv|m3u8)(\?|#|$)/i.test(url)) return 100 + bonus;
    let parsed: URL | null = null;
    try {
        parsed = new URL(url);
    } catch {
        parsed = null;
    }
    const path = parsed?.pathname || "";
    if (/(^|\/)(video|videos|output|outputs|result|results|download|media|play)(\/|$)/i.test(path)) return 70 + bonus;
    if (parsed && /(myqcloud\.com|aliyuncs\.com|\.tos-|tos-|volces\.com|cloudfront\.net|work-fisher\.com|runninghub\.)/i.test(parsed.hostname)) return 60 + bonus;
    return 10 + bonus;
}

function collectVideoUrlCandidates(value: unknown, key: string, depth: number, out: VideoUrlCandidate[]) {
    if (value == null || depth > 7 || out.length > 400) return;
    if (typeof value === "string") {
        const text = value.trim();
        // 有些中转把结果再包一层 JSON 字符串。
        if ((text.startsWith("{") || text.startsWith("[")) && text.length < 40000) {
            try {
                collectVideoUrlCandidates(JSON.parse(text), key, depth + 1, out);
                return;
            } catch {
                // 不是 JSON，按普通字符串处理
            }
        }
        const score = scoreVideoUrl(text, key);
        if (score) out.push({ url: text, key, score });
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectVideoUrlCandidates(item, key, depth + 1, out);
        return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        // 参考素材（输入图/参考视频）不是成片，整棵子树跳过。
        if (MEDIA_INPUT_SUBTREE.test(childKey) && typeof childValue !== "string") continue;
        collectVideoUrlCandidates(childValue, childKey, depth + 1, out);
    }
}

export function videoResultUrl(payload: VideoResponse) {
    const candidates = [
        payload.video_url,
        payload.result_url,
        payload.url,
        payload.content?.video_url,
        payload.content?.url,
        payload.metadata?.url,
        payload.metadata?.video_url,
        payload.task?.content?.url,
    ];
    const direct = candidates.find((url) => typeof url === "string" && url.trim() && (isPublicMediaUrl(url) || /\.(mp4|mov|webm)(\?|#|$)/i.test(url)));
    if (direct) return direct;
    const deep: VideoUrlCandidate[] = [];
    collectVideoUrlCandidates(payload, "", 0, deep);
    if (!deep.length) return undefined;
    deep.sort((a, b) => b.score - a.score);
    return deep[0].url;
}

/** 「完成但没直链」时用来定位问题：顶层字段 + 截断的原始 JSON。 */
function describeVideoPayload(payload: unknown) {
    const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const keys = source ? Object.keys(source).slice(0, 30) : [];
    let raw = "";
    try {
        raw = JSON.stringify(payload) || "";
    } catch {
        raw = String(payload ?? "");
    }
    return { keys, raw: raw.length > 900 ? `${raw.slice(0, 900)}…` : raw };
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
            // axios 客户端超时（如 timeout of 120000ms exceeded）——别把原文甩给用户。
            if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || /timeout of \d+ms exceeded/i.test(String(error.message || ""))) {
                if (/runninghub\.ai/i.test(url)) return `${apiText("runningHubAiUnreachable")}${hint}`;
                if (/runninghub\.cn/i.test(url) && /\/upload/i.test(url)) return `${apiText("runningHubUploadTimeout")}${hint}`;
                if (/runninghub\.cn/i.test(url)) return `${apiText("runningHubSubmitTimeout")}${hint}`;
                return `${apiText("videoTaskTimedOut")}${hint}`;
            }
            // Pages proxy 502 without ACAO used to surface here as a fake CORS/network failure.
            if (/\/api(?:-)?proxy\?target=/i.test(url)) {
                if (/runninghub\.ai/i.test(url)) return `${apiText("runningHubAiUnreachable")}${hint}`;
                return `${apiText("proxyUnreachable")}${hint}`;
            }
            if (error.code === "ERR_NETWORK" && isKnownDirectCorsUrl(url)) {
                if (/runninghub\.ai/i.test(url)) return `${apiText("runningHubAiUnreachable")}${hint}`;
                // Only a ts.net tunnel deserves the Tailscale/Funnel checklist — an ordinary relay
                // (aicost.me, autodl.art …) failing this way is the provider's edge, not a tunnel.
                return `${apiText(isTunnelCorsUrl(url) ? "directHostUnreachable" : "directHostUnreachableApi")}${hint}`;
            }
            // A reset/protocol failure is not "blocked by CORS" — the request went out and the
            // connection died mid-flight (HTTP/2 RST_STREAM, TLS teardown, proxy kill).
            if (/ERR_(HTTP2|HTTP3|QUIC|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|INCOMPLETE_CHUNKED)/i.test(String(error.code || ""))) {
                if (/runninghub\.ai/i.test(url)) return `${apiText("runningHubAiUnreachable")}${hint}`;
                return `${apiText("endpointReset")}${hint}`;
            }
            return error.code === "ERR_NETWORK" ? `${apiText("corsRequired")}${hint}` : `${apiText("networkFailed")}${hint}`;
        }
        const responseData = error.response?.data;
        // Cloudflare edge page instead of an API answer → the provider's own origin is broken.
        const edge = clarifyVideoEdgeError(error.response?.status, responseData);
        if (edge) return edge;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || readNetworkMessage(error.message) || error.message : fallback;
}

/**
 * Relays answer with a Cloudflare error page (HTML) when their *own* origin is broken: 530 with
 * "1016 Origin DNS error" means Cloudflare cannot resolve the API host at all, 52x means the origin
 * is down/overloaded. Say that plainly — it is a provider outage, not a canvas setting.
 */
function clarifyVideoEdgeError(status: number | undefined, data: unknown) {
    const text = typeof data === "string" ? data : "";
    if (!text || !/cloudflare/i.test(text)) return "";
    const errorCode = text.match(/errorCode["'\s:=]+(\d{3,4})/i)?.[1] || "";
    if (errorCode === "1016" || /Origin DNS error/i.test(text)) return apiText("originDnsError");
    const code = Number(errorCode) || Number(status) || 0;
    if (code >= 520 && code <= 530) return apiText("originOverloaded", { status: String(code) });
    return apiText("originOverloaded", { status: "5xx" });
}

function readNetworkMessage(message: string) {
    if (/upstream timed out|aborted due to timeout|TimeoutError|proxy error:.*timed out/i.test(message)) {
        return apiText("proxyTimedOut");
    }
    return /failed to fetch|network error|load failed|net::err_/i.test(message) ? apiText("networkFailed") : null;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 400) return `${fallback}（400）`;
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 413) return apiText("payloadTooLarge");
    if (status === 429) return apiText("rateLimited");
    if (status === 503) return apiText("videoServiceBusy");
    if (status === 502) return apiText("badGateway");
    if (status === 504) return apiText("proxyTimedOut");
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
