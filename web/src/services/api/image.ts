import axios from "axios";

import i18n from "@/i18n";
import { buildApiUrl, resolveModelChannel, resolveModelRequestConfig, resolveModelScript, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { proxyApiUrl } from "@/lib/api-proxy";
import { parseComfyApiWorkflow, runNativeComfyUiJob, shouldUseNativeComfyUi } from "@/lib/comfyui-native";
import { pickRunningHubWorkflowId, pollRunningHubQuery, readRunningHubTask, runningHubOrigin, runRunningHubWorkflow } from "@/lib/runninghub-workflow";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { nanoid } from "nanoid";
import { compressBodyImagesForProxy, compressReferenceDataUrl, dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { uploadTemporaryPublicImageFromDataUrl } from "@/lib/temp-public-image";
import { fetchRemoteImageBlob, imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    id?: string;
    object?: string;
    status?: string;
    progress?: number;
    url?: string;
    result?: { type?: string; url?: string; data?: Array<Record<string, unknown>>; images?: Array<Record<string, unknown>> };
    data?: Array<Record<string, unknown>> | Record<string, unknown>;
    images?: Array<Record<string, unknown>>;
    results?: Array<Record<string, unknown>>;
    error?: { message?: string; code?: string | number };
    code?: number;
    msg?: string;
};

const IMAGE_TASK_POLL_INTERVAL_MS = 3000;
const IMAGE_TASK_POLL_TIMEOUT_MS = 300_000;
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };
export type ChatToolDefinition = ResponseFunctionTool;
export type ChatRequestOptions = RequestOptions & {
    tools?: ChatToolDefinition[];
    toolChoice?: ToolChoice;
    executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
    onToolStart?: (name: string, callId: string) => void;
    onToolEnd?: (name: string, callId: string, output: string) => void;
    maxToolRounds?: number;
};

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    xhigh: 3328,
    max: 3840,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";
const IMAGE_RESPONSE_FORMAT = "b64_json";

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "9:21", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };
const APIMART_GPT_IMAGE_1_RATIOS = ["1:1", "3:2", "2:3"];
const APIMART_GPT_IMAGE_2_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"];
const APIMART_QWEN_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const APIMART_SEEDREAM_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"];
const APIMART_GEMINI_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"];
const APIMART_DEFAULT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "9:21"];

function isApimartBaseUrl(baseUrl: string) {
    return /apimart\.ai/i.test(baseUrl.trim());
}

/**
 * Seedance.nz sells text-to-image and image-edit as separate model ids (zhenzhen-image-g2-t2i vs
 * -i2i, wan-2.7-global-t2i vs -i2i; zhenzhen-image-gk-v15 is t2i-only with a separate -edit model).
 * A t2i model silently ignores the `images` param — the user pays for a generation that never
 * looks at their reference. Detect these so requestEdit can fail fast with the i2i sibling name.
 */
function isTextToImageOnlySeedanceModel(model: string) {
    const value = model.trim();
    if (/(?:^|[-_])t2i(?:$|[-_])/i.test(value)) return true;
    return /^zhenzhen-image-gk-v15$/i.test(value);
}

function suggestImageToImageModelName(model: string) {
    const value = model.trim();
    if (/(?:^|[-_])t2i(?:$|[-_])/i.test(value)) return value.replace(/-t2i/i, "-i2i");
    if (/^zhenzhen-image-gk-v15$/i.test(value)) return `${value}-edit`;
    return value;
}

function isSeedanceNzBaseUrl(baseUrl: string) {
    return /seedance\.nz/i.test(baseUrl.trim());
}

function isApiSuccessCode(code: number) {
    // OpenAI-compatible CN relays commonly use 0; APIMart / Seedance use HTTP-style 200.
    return code === 0 || code === 200;
}

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

function isGptImageModel(model: string) {
    return model.trim().toLowerCase().startsWith("gpt-image-");
}

function isImagenModel(model: string) {
    return /imagen/i.test(model.trim());
}

/**
 * Some relays expose Gemini / Imagen image models on OpenAI `/v1/images/generations`
 * (e.g. ToAPIs). Others (New API) only accept Imagen there and serve Gemini via generateContent.
 */
function isGeminiNativeImageModel(model: string) {
    const value = model.trim().toLowerCase();
    if (!value.includes("gemini")) return false;
    return /flash-image|image-preview|image-generation|nano-banana/.test(value);
}

function prefersOpenAiImagesEndpoint(model: string) {
    if (isImagenModel(model)) return true;
    return isGeminiNativeImageModel(model);
}

/** Gemini flash-image relays expect reference images as public URLs on /images/generations. */
function usesImageUrlReferences(model: string) {
    return isGeminiNativeImageModel(model);
}

function isPublicHttpUrl(value: string) {
    return /^https?:\/\//i.test(value.trim());
}

function resolveImageRequestConfig(config: AiConfig) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    // Imagen is always called through the OpenAI-compatible images endpoint on CN relays.
    if (isImagenModel(requestConfig.model)) {
        return { ...requestConfig, apiFormat: "openai" as const };
    }
    // Do not force Gemini flash-image onto OpenAI format: Gemini-format channels must use
    // generateContent. OpenAI-format channels still try /images/generations first.
    return requestConfig;
}

function isImagenOnlyEndpointError(message: string) {
    return /only imagen models are supported|仅支持\s*Imagen|only supports Imagen/i.test(message);
}

function normalizeImageApiErrorMessage(message: string, model?: string) {
    if (isImagenOnlyEndpointError(message)) {
        return apiText("imagenOnlyModel", { model: model || "?" });
    }
    // The provider fetched one of our reference image URLs and got an HTML error page / non-image
    // bytes back — the reference link is dead or hotlink-protected from the provider's network.
    if (/remote\s+image\s+returned\s+(an?\s+)?unexpected\s+content\s+type|unexpected\s+content\s+type:\s*text\/html/i.test(message)) {
        return apiText("referenceUrlUnreachable");
    }
    if (/generateContent/i.test(message) && /\/v1\/images\/generations/i.test(message)) {
        return apiText("geminiImageUseOpenAi", { model: model || "?" });
    }
    if (/aspect_ratio\s+\S+\s+is not supported/i.test(message)) {
        return apiText("unsupportedAspectRatio", { model: model || "?" });
    }
    if (/get_channel_failed|Please wait and try again later/i.test(message)) {
        return apiText("providerChannelFailed");
    }
    if (/model_not_found|model[^\n]{0,40}(not\s*found|does\s*not\s*exist)/i.test(message)) {
        return apiText("modelNotFoundOnProvider", { model: model || "?" });
    }
    return message;
}

/** gpt-image-1 / 1.5 / mini only accept a fixed size enum. */
function isGptImageFixedSizeModel(model: string) {
    const value = model.trim().toLowerCase();
    if (!value.startsWith("gpt-image-")) return false;
    if (value.startsWith("gpt-image-2")) return false;
    return true;
}

function isDalleModel(model: string) {
    const value = model.trim().toLowerCase();
    return value.startsWith("dall-e") || value.startsWith("dalle");
}

function isVolcengineArkBaseUrl(baseUrl: string) {
    const value = baseUrl.trim();
    return /ark\.cn-beijing\.volces\.com/i.test(value) || /volces\.com\/api\/(plan|coding)\/v\d+/i.test(value);
}

function isSeedreamModel(model: string) {
    return /seedream/i.test(model.trim());
}

export function isMidjourneyModel(model: string) {
    return /midjourney|\bmj[-_]?/i.test(model.trim());
}

export type GeneratedImageResult = {
    id: string;
    dataUrl: string;
    fallbackUrls?: string[];
    midjourneyTaskId?: string;
    midjourneyIndex?: number;
};

/** Agent Plan / Ark Seedream: OpenAI-shaped /images/generations with Volcengine-specific size rules. */
function usesVolcengineImageApi(config: AiConfig) {
    if (isSeedreamModel(config.model)) return true;
    if (!isVolcengineArkBaseUrl(config.baseUrl)) return false;
    return !isGptImageModel(config.model) && !isDalleModel(config.model) && !isGeminiNativeImageModel(config.model) && !prefersOpenAiImagesEndpoint(config.model);
}

const VOLC_SEEDREAM_PIXEL_SIZES = [
    { ratio: 1, size: "2048x2048" },
    { ratio: 16 / 9, size: "2560x1440" },
    { ratio: 9 / 16, size: "1440x2560" },
    { ratio: 4 / 3, size: "2304x1728" },
    { ratio: 3 / 4, size: "1728x2304" },
    { ratio: 3 / 2, size: "2496x1664" },
    { ratio: 2 / 3, size: "1664x2496" },
    { ratio: 21 / 9, size: "3136x1344" },
];

function resolveVolcengineImageSize(quality: string | undefined, size: string) {
    const value = size.trim();
    const tier = quality === "high" ? "3K" : "2K";
    if (!value || value.toLowerCase() === "auto") return tier;
    if (/^[1234]k$/i.test(value)) return value.toUpperCase();
    const dimensions = parseImageDimensions(value);
    if (dimensions && dimensions.width * dimensions.height >= 3_686_400) {
        return `${dimensions.width}x${dimensions.height}`;
    }
    const target = readSizeAspectRatio(value);
    let best = VOLC_SEEDREAM_PIXEL_SIZES[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const item of VOLC_SEEDREAM_PIXEL_SIZES) {
        const delta = Math.abs(item.ratio - target);
        if (delta < bestDelta) {
            best = item;
            bestDelta = delta;
        }
    }
    return best.size;
}

/**
 * hfsyapi seedream `size` accepts only the ~1K pixel sizes from its docs `sizeTable`.
 * "1K" in the parameter description is the resolution tier, NOT a literal value —
 * sending "1K" makes the provider fall back to its 1:1 default and ignores the user's ratio.
 */
const HFSY_SEEDREAM_SIZES = [
    { ratio: 16 / 9, size: "1280x720" },
    { ratio: 4 / 3, size: "1024x768" },
    { ratio: 4 / 5, size: "1024x832" },
    { ratio: 9 / 16, size: "720x1280" },
    { ratio: 1, size: "1024x1024" },
    { ratio: 2, size: "1024x512" },
    { ratio: 1.85, size: "1024x554" },
    { ratio: 2.4, size: "1024x427" },
    { ratio: 21 / 9, size: "1344x576" },
];

function resolveHfsySeedreamSize(size: string) {
    const value = (size || "").trim();
    if (!value || value.toLowerCase() === "auto") return "1024x1024";
    const target = readSizeAspectRatio(value);
    let best = HFSY_SEEDREAM_SIZES[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const item of HFSY_SEEDREAM_SIZES) {
        const delta = Math.abs(item.ratio - target);
        if (delta < bestDelta) {
            best = item;
            bestDelta = delta;
        }
    }
    return best.size;
}

function resolveVolcengineImageParams(config: AiConfig, count: number) {
    const n = Math.max(1, Math.min(count, 15));
    // hfsyapi seedream takes a ~1K pixel size (not Volcengine's 2K/3K tiers) and knows nothing
    // about Volcengine's sequential_image_generation params.
    if (usesHfsySeedreamImageApi(config)) {
        return {
            size: resolveHfsySeedreamSize(config.size),
            response_format: IMAGE_RESPONSE_FORMAT,
            ...(n > 1 ? { n: Math.min(n, 10) } : {}),
        } as Record<string, unknown>;
    }
    const size = resolveVolcengineImageSize(normalizeQuality(config.quality), config.size);
    return {
        size,
        response_format: IMAGE_RESPONSE_FORMAT,
        watermark: false,
        ...(n > 1
            ? {
                  sequential_image_generation: "auto",
                  sequential_image_generation_options: { max_images: n },
              }
            : {}),
    } as Record<string, unknown>;
}

function resolveOpenAiImageParams(config: AiConfig, count: number) {
    // APIMart expects size as aspect ratio + optional resolution tier (not arbitrary WxH / response_format).
    if (isApimartBaseUrl(config.baseUrl)) {
        return resolveApimartImageParams(config, count);
    }
    // Gemini/Imagen relays often convert WxH into a reduced aspect_ratio and reject
    // non-whitelisted ratios like 85:48 (from 2720x1536). Send a supported ratio instead.
    if (prefersOpenAiImagesEndpoint(config.model)) {
        return resolveGeminiRelayImageParams(config, count);
    }
    if (usesVolcengineImageApi(config)) {
        return resolveVolcengineImageParams(config, count);
    }

    const quality = normalizeQuality(config.quality);
    const requestSize = isGptImageModel(config.model) ? resolveGptImageRequestSize(config.model, quality, config.size) : resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const params: Record<string, string | number | boolean | Record<string, unknown>> = {
        n: isGptImageModel(config.model) ? Math.min(count, 10) : count,
        ...(quality ? { quality } : {}),
        ...(requestSize ? { size: requestSize } : {}),
        ...(background ? { background } : {}),
    };

    if (isGptImageModel(config.model)) {
        // GPT Image models return base64 by default and reject response_format.
        params.output_format = IMAGE_OUTPUT_FORMAT;
    } else if (isDalleModel(config.model)) {
        params.response_format = IMAGE_RESPONSE_FORMAT;
    } else {
        // Keep the existing broad relay compatibility for non-OpenAI image models.
        params.response_format = IMAGE_RESPONSE_FORMAT;
        params.output_format = IMAGE_OUTPUT_FORMAT;
    }

    return params;
}

/** APIMart: https://docs.apimart.ai — size is ratio (16:9), resolution tier varies by model. */
function resolveApimartImageParams(config: AiConfig, count: number) {
    const model = config.model.trim();
    const size = resolveApimartSize(model, config.size);
    const params: Record<string, string | number | boolean> = {
        ...(size ? { size } : {}),
    };

    // Seedream on APIMart is single-image only; n>1 / group params → 400.
    if (isSeedreamModel(model)) {
        const resolution = resolveApimartResolution(model, config.quality);
        if (resolution) params.resolution = resolution;
        return params;
    }

    // GPT-Image-2.5 (flare/sunburst): n 1-4, quality low/medium/high, 1k/2k/4k tiers.
    if (isApimartGptImage25Model(model)) {
        params.n = Math.max(1, Math.min(count, 4));
        const quality = normalizeQuality(config.quality);
        if (quality) params.quality = quality;
        const resolution = resolveApimartResolution(model, config.quality);
        if (resolution) params.resolution = resolution;
        return params;
    }

    params.n = Math.max(1, Math.min(count, resolveApimartMaxImages(model)));

    if (isGptImageFixedSizeModel(model) || /^gpt-image-1(?!.*2)/i.test(model)) {
        const quality = normalizeQuality(config.quality);
        params.quality = quality || "auto";
        const background = normalizeBackground(config.background);
        if (background) params.background = background;
        params.output_format = IMAGE_OUTPUT_FORMAT;
        return params;
    }

    const resolution = resolveApimartResolution(model, config.quality);
    if (resolution) params.resolution = resolution;
    return params;
}

function resolveApimartMaxImages(model: string) {
    if (isSeedreamModel(model)) return 1;
    if (/gpt-image-2/i.test(model)) return 4;
    if (isGptImageModel(model)) return 4;
    if (/qwen/i.test(model)) return 6;
    if (isGeminiNativeImageModel(model) || isImagenModel(model)) return 4;
    return 4;
}

function resolveApimartResolution(model: string, quality: string) {
    const normalized = normalizeQuality(quality);
    // Seedream: 1K / 1.5K / 2K only — 3K/4K → 400.
    if (isSeedreamModel(model)) {
        if (normalized === "low" || normalized === "standard") return "1K";
        if (normalized === "medium" || normalized === "hd") return "1.5K";
        return "2K";
    }
    // Qwen / Gemini family: uppercase K.
    if (/qwen/i.test(model) || isGeminiNativeImageModel(model) || isImagenModel(model)) {
        if (normalized === "low" || normalized === "standard") return "1K";
        if (normalized === "high") return /qwen/i.test(model) ? "2K" : "4K";
        return "2K";
    }
    // GPT-Image-2 family: lowercase k.
    if (normalized === "low" || normalized === "standard") return "1k";
    if (normalized === "high") return "4k";
    return "2k";
}

function resolveApimartSize(model: string, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return "auto";
    // Seedream also accepts tier tokens in `size`; keep them as-is.
    if (isSeedreamModel(model) && /^(1k|1\.5k|2k|auto)$/i.test(value)) {
        if (/^auto$/i.test(value)) return "auto";
        return value.toUpperCase();
    }
    const allowed = /^gpt-image-1(?!.*2)/i.test(model) || isGptImageFixedSizeModel(model)
        ? APIMART_GPT_IMAGE_1_RATIOS
        : /gpt-image-2/i.test(model)
          ? APIMART_GPT_IMAGE_2_RATIOS
          : /qwen/i.test(model)
            ? APIMART_QWEN_RATIOS
            : isSeedreamModel(model)
              ? APIMART_SEEDREAM_RATIOS
              : isGeminiNativeImageModel(model) || isImagenModel(model)
                ? APIMART_GEMINI_RATIOS
                : APIMART_DEFAULT_RATIOS;
    const dimensions = parseImageDimensions(value);
    const ratioText = dimensions
        ? `${dimensions.width}:${dimensions.height}`
        : value.includes("x") || value.includes("X") || value.includes("×")
          ? value.replace(/[xX×]/g, ":")
          : value;
    return closestAspectRatioLabel(ratioText, allowed);
}

function closestAspectRatioLabel(value: string, allowed: string[]) {
    try {
        const ratio = parseRatioValue(value.includes("x") || value.includes("X") ? value.replace(/[xX×]/g, ":") : value);
        const target = ratio.width / ratio.height;
        return allowed.reduce((best, item) => {
            const current = parseRatioValue(item);
            const bestRatio = parseRatioValue(best);
            return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
        });
    } catch {
        return allowed[0] || "1:1";
    }
}

/** OpenAI-compatible /images/* params for Gemini flash-image / Imagen relays. */
function resolveGeminiRelayImageParams(config: AiConfig, count: number) {
    const quality = normalizeQuality(config.quality);
    const aspectRatio = resolveGeminiAspectRatioForSize(config.size);
    const background = normalizeBackground(config.background);
    const resolution = resolveGeminiRelayResolution(config.quality);
    return {
        n: Math.max(1, Math.min(count, 10)),
        ...(quality ? { quality } : {}),
        ...(aspectRatio ? { size: aspectRatio, aspect_ratio: aspectRatio } : {}),
        ...(background ? { background } : {}),
        ...(resolution ? { metadata: { resolution } } : {}),
        response_format: IMAGE_RESPONSE_FORMAT,
        output_format: IMAGE_OUTPUT_FORMAT,
    };
}

function resolveGeminiRelayResolution(quality: string) {
    const normalized = normalizeQuality(quality);
    if (!normalized) return undefined;
    return GEMINI_IMAGE_SIZE_BY_QUALITY[normalized] || undefined;
}

function resolveGeminiAspectRatioForSize(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    const ratioText = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    return closestGeminiAspectRatio(ratioText);
}

async function uploadProviderReferenceImage(config: AiConfig, image: ReferenceImage, options?: RequestOptions) {
    const dataUrl = await prepareReferenceDataUrl(image, 1);
    const file = dataUrlToFile({ ...image, dataUrl });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("purpose", "generation");
    try {
        const response = await axios.post<{ success?: boolean; message?: string; data?: { url?: string }; url?: string }>(aiApiUrl(config, "/uploads/images"), formData, {
            headers: aiHeaders(config),
            signal: options?.signal,
        });
        const payload = response.data;
        const url = payload?.data?.url || payload?.url;
        if (typeof url === "string" && isPublicHttpUrl(url)) return url;
        if (payload && payload.success === false) throw new Error(payload.message || apiText("providerImageUploadFailed"));
        throw new Error(apiText("providerImageUploadFailed"));
    } catch (error) {
        if (error instanceof Error && !axios.isAxiosError(error)) throw error;
        if (axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 405)) {
            throw new Error(apiText("providerImageUploadUnsupported"));
        }
        const message = normalizeImageApiErrorMessage(readAxiosError(error, apiText("providerImageUploadFailed")), config.model);
        if (/404|not\s*found|invalid url|uploads\/images/i.test(message)) {
            throw new Error(apiText("providerImageUploadUnsupported"));
        }
        throw new Error(message);
    }
}

function isProviderUploadUnsupported(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /providerImageUploadUnsupported|uploads\/images|参考图上传.*不支持|does not support image upload/i.test(message);
}

function isHfsyApiBaseUrl(baseUrl: string) {
    return /hfsyapi\.cn/i.test(baseUrl.trim());
}

function isToapisBaseUrl(baseUrl: string) {
    // Domestic CN users use toapis.cn; the docs' international examples use toapis.com.
    return /toapis\.(com|cn)/i.test(baseUrl.trim());
}

function isReferenceBase64Unsupported(message: string) {
    return /参考图不支持\s*base64|does\s*not\s*support\s*base64|base64[^\n]{0,40}not\s*supported|invalid_request[^\n]{0,40}base64|base64[^\n]{0,40}(not\s*allowed|is\s*not\s*allowed|不允许|不支持)/i.test(message);
}

/**
 * Upstream states it only accepts public image URLs for references — base64 and/or multipart
 * uploads are rejected. Used to trigger the temporary-public-host retry on any relay.
 */
function isReferenceUrlRequired(message: string) {
    return (
        isReferenceBase64Unsupported(message) ||
        /only\s+supports?\s+image\s+urls|only\s+support\s+image\s+urls|image\s+urls?\s+are\s+(only\s+)?supported|multipart\s+(file\s+)?uploads?\s+(are\s+)?not\s+supported|does\s+not\s+(accept|support)\s+(base64|multipart)/i.test(message)
    );
}

/**
 * A reference URL the provider cannot fetch (dead host, HTML error page) surfaces upstream as
 * "remote image returned unexpected content type: text/html" — e.g. previously generated images
 * hosted on a flaky provider CDN. Verify the URL still serves image bytes before passing it;
 * when it does not, re-host fresh local bytes (IndexedDB survives restarts) on a temporary
 * public host instead.
 */
async function resolveFetchableReferenceUrl(config: AiConfig, image: ReferenceImage, referenceCount: number, options?: RequestOptions & { allowProviderUpload?: boolean }) {
    const remoteUrl = [image.url, image.dataUrl].find((value) => value && isPublicHttpUrl(value) && !value.startsWith("data:"))?.trim();
    if (remoteUrl && (await fetchRemoteImageBlob(remoteUrl))) return remoteUrl;
    if (!remoteUrl && options?.allowProviderUpload && !isHfsyApiBaseUrl(config.baseUrl)) {
        // hfsyapi has no /v1/uploads/images (confirmed 404) — skip straight to the public host.
        try {
            return await uploadProviderReferenceImage(config, image, options);
        } catch (error) {
            if (options.signal?.aborted || axios.isCancel(error)) throw error;
            if (!isProviderUploadUnsupported(error)) throw error;
        }
    }
    try {
        const dataUrl = await prepareReferenceDataUrl(image, referenceCount);
        return await uploadTemporaryPublicImageFromDataUrl(dataUrl, options?.signal);
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        // Last resort: the provider's network may still reach the original URL even when ours cannot.
        if (remoteUrl) return remoteUrl;
        throw error;
    }
}

async function resolveReferenceImageUrls(config: AiConfig, references: ReferenceImage[], options?: RequestOptions) {
    const urls: string[] = [];
    const referenceCount = Math.max(1, references.length);
    for (const image of references.slice(0, 14)) {
        urls.push(await resolveFetchableReferenceUrl(config, image, referenceCount, { ...options, allowProviderUpload: true }));
    }
    if (!urls.length) throw new Error(apiText("referenceImageReadFailed"));
    return urls;
}

/** hfsyapi is a New API fork: seedream there takes `reference_images` (public URLs), not the Volcengine `image` field. */
function usesHfsySeedreamImageApi(config: AiConfig) {
    return isSeedreamModel(config.model) && isHfsyApiBaseUrl(config.baseUrl);
}

/**
 * hfsyapi seedream (docs: https://www.hfsyapi.cn/docs):
 *   POST /v1/images/generations
 *   { model, prompt, reference_images: [url], n, size: "<WxH>", response_format }
 * `size` must be one of the docs' ~1K `sizeTable` pixel sizes (the "1K" in the parameter
 * description is a resolution tier, not a literal value). Reference images MUST be public URLs —
 * sending base64 in `image` gets the reference silently dropped (random output).
 */
async function requestHfsySeedreamImage(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const n = Math.max(1, Math.min(count, 10));
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        size: resolveHfsySeedreamSize(config.size),
        response_format: IMAGE_RESPONSE_FORMAT,
    };
    if (n > 1) body.n = n;
    if (references.length) {
        // The docs cap reference images at 10 per request.
        const refs = references.slice(0, 10);
        const dataUrls = await Promise.all(refs.map((image) => prepareReferenceDataUrl(image, refs.length)));
        // Public URLs are what the docs ask for; if no host is reachable, fall back to the data URLs
        // themselves rather than dropping the reference and silently generating a random image.
        try {
            body.reference_images = await resolveReferenceImageUrls(config, refs, options);
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            body.reference_images = dataUrls;
        }
    }
    const response = await postImageJson<ImageApiResponse>(config, "/images/generations", body, options);
    return resolveImageApiResponse(config, response.data, options);
}

/** APIMart GPT-Image-2.5 (flare/sunburst, incl. relay suffixes like -official). */
function isApimartGptImage25Model(model: string) {
    return /^gpt-image-2\.5-(flare|sunburst)/i.test(model.trim());
}

/**
 * APIMart Nano-Banana-2-Lite (incl. relay suffixes like -ext). Unlike the regular Nano-Banana
 * (Gemini 3 Pro Image), the -2-Lite tier maps to Gemini 3.1 Flash Lite Image and is served ONLY
 * via /v1/chat/completions (billed per token); it 400s on /images/edits and has no /images/generations
 * route. Its response is raw base64 in choices[0].message.content (no data: prefix).
 */
function isApimartNanoBananaLiteModel(model: string) {
    return /nano-banana-2-lite/i.test(model.trim());
}

/**
 * APIMart GPT-Image-2.5 per docs.apimart.ai: editing is NOT multipart /images/edits (400) —
 * it is the async JSON task on /images/generations with `image_urls` (public HTTP(S) URLs
 * only, up to 16). Local refs upload via /v1/uploads/images (temporary public host as
 * fallback). Submission returns data[0].task_id; the shared poller reads
 * data.result.images[].url[] on /tasks/{id}.
 */
async function requestApimartGptImage(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const n = Math.max(1, Math.min(4, count));
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        ...resolveApimartImageParams(config, n),
    };
    if (references.length) {
        const urls: string[] = [];
        for (const image of references.slice(0, 16)) {
            urls.push(await resolveFetchableReferenceUrl(config, image, Math.max(1, references.length), { ...options, allowProviderUpload: true }));
        }
        if (!urls.length) throw new Error(apiText("referenceImageReadFailed"));
        body.image_urls = urls;
        // Image-to-image: omit size so the service derives dimensions from the references.
        delete body.size;
    }
    const response = await postImageJson<ImageApiResponse>(config, "/images/generations", body, options);
    return resolveImageApiResponse(config, response.data, options);
}

/** ToAPIs GPT-Image-2.5 (flare/sunburst, incl. -official suffixes). */
function isToapisGptImage25Model(model: string) {
    return /^gpt-image-2\.5-(flare|sunburst)/i.test(model.trim());
}

/**
 * ToAPIs GPT-Image-2.5 per docs.toapis.com: unified async image task on POST /v1/images/generations.
 * Reference images go in `image_urls` as an array of objects `[{ url }]` (public URLs only — base64
 * is rejected with "base64 image is not allowed"). Local refs upload via /v1/uploads/images.
 * size is an aspect-ratio token ("1:1", "16:9", …); resolution lives in metadata.resolution
 * ("0.5K"/"1K"/"2K"/"4K"); quality supports low/medium/high/xhigh/max. Submission returns
 * { id: task_id, status: "queued" }; the shared poller reads /v1/images/generations/{id}.
 */
async function requestToapisGptImage25(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const n = Math.max(1, Math.min(4, count));
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        n,
        size: resolveToapisGptImage25Size(config.size),
    };
    const quality = normalizeQuality(config.quality);
    if (quality) body.quality = quality;
    const resolution = resolveToapisGptImage25Resolution(config.quality);
    if (resolution) body.metadata = { resolution };
    if (references.length) {
        // image_urls is an array of { url } objects — base64 is rejected outright.
        const urls: Array<{ url: string }> = [];
        for (const image of references.slice(0, 16)) {
            urls.push({ url: await resolveFetchableReferenceUrl(config, image, Math.max(1, references.length), { ...options, allowProviderUpload: true }) });
        }
        if (!urls.length) throw new Error(apiText("referenceImageReadFailed"));
        body.image_urls = urls;
    }
    const response = await postImageJson<ImageApiResponse>(config, "/images/generations", body, options);
    return resolveImageApiResponse(config, response.data, options);
}

function resolveToapisGptImage25Size(size: string) {
    return resolveApimartSize("gpt-image-2", size);
}

function resolveToapisGptImage25Resolution(quality: string) {
    const normalized = normalizeQuality(quality);
    if (!normalized) return undefined;
    if (normalized === "low" || normalized === "standard") return "1K";
    if (normalized === "high") return "4K";
    return "2K";
}

async function requestGeminiRelayImageToImage(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const imageUrls = await resolveReferenceImageUrls(config, references, options);
    const imageParams = resolveGeminiRelayImageParams(config, count);
    const { metadata, ...restParams } = imageParams as Record<string, unknown> & { metadata?: { resolution?: string } };
    try {
        const response = await postImageJson<ImageApiResponse>(
            config,
            "/images/generations",
            {
                model: config.model,
                prompt: withSystemPrompt(config, prompt),
                image_urls: imageUrls,
                ...restParams,
                ...(metadata ? { metadata } : {}),
            },
            options,
        );
        return await resolveImageApiResponse(config, response.data, options);
    } catch (error) {
        const message = readAxiosError(error, apiText("requestFailed"));
        // Keep the raw Imagen-only signal so callers can fall back to generateContent.
        if (isImagenOnlyEndpointError(message)) throw new Error(message);
        throw new Error(normalizeImageApiErrorMessage(message, config.model));
    }
}

function appendOpenAiImageParams(formData: FormData, params: Record<string, unknown>) {
    for (const [key, value] of Object.entries(params)) {
        if (value == null || typeof value === "object") continue;
        formData.set(key, String(value));
    }
}

async function requestVolcengineImageGeneration(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length || 1))));
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        ...resolveVolcengineImageParams(config, count),
    };
    if (refs.length === 1) body.image = refs[0];
    else if (refs.length > 1) body.image = refs;
    const response = await postImageJson<ImageApiResponse>(config, "/images/generations", body, options);
    return resolveImageApiResponse(config, response.data, options);
}

/** Many OpenAI-compatible relays (New API style) expose img2img on /images/generations + `image`, not multipart /images/edits. */
async function requestOpenAiCompatImageToImageViaGenerations(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length || 1))));
    if (!refs.length) throw new Error(apiText("referenceImageReadFailed"));
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        ...resolveOpenAiImageParams(config, count),
    };
    body.image = refs.length === 1 ? refs[0] : refs;
    try {
        const response = await postImageJson<ImageApiResponse>(config, "/images/generations", body, options);
        return resolveImageApiResponse(config, response.data, options);
    } catch (error) {
        const message = readAxiosError(error, apiText("requestFailed"));
        // Upstream explicitly demands public image URLs (rejects base64 data URLs and/or multipart).
        // Upload references to a short-lived public host and retry with image_urls — regardless of
        // which relay this is, the message itself is the trigger.
        if (!isReferenceUrlRequired(message)) throw error;
        const imageUrls = await Promise.all(refs.map((dataUrl) => uploadTemporaryPublicImageFromDataUrl(dataUrl, options?.signal)));
        const retryBody: Record<string, unknown> = {
            model: config.model,
            prompt: withSystemPrompt(config, prompt),
            ...resolveOpenAiImageParams(config, count),
            image_urls: imageUrls,
            image: imageUrls.length === 1 ? imageUrls[0] : imageUrls,
        };
        const response = await postImageJson<ImageApiResponse>(config, "/images/generations", retryBody, options);
        return resolveImageApiResponse(config, response.data, options);
    }
}

function isImageEditsEndpointMissing(error: unknown, message: string) {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404 || status === 405) return true;
        // Some relays answer 400 when the endpoint exists but cannot serve this model/request.
        if (status === 400 && isImageEditsModelRestricted(message)) return true;
    }
    return isImageEditsModelRestricted(message) || /404|not\s*found|接口地址不存在|unknown\s*url|invalid\s*url|method\s*not\s*allowed|405|does\s*not\s*exist/i.test(message);
}

/**
 * Relays that reject multipart /images/edits for non-Grok models or demand public image URLs
 * ("only supports Grok image models", "async image tasks only support image URLs; multipart file
 * uploads are not supported"). The endpoint exists, but this request can never succeed on it —
 * fall through to the URL/base64 generations paths instead of surfacing the raw error.
 */
function isImageEditsModelRestricted(message: string) {
    return /only\s+supports?\s+grok|multipart\s+(file\s+)?uploads?\s+(are\s+)?not\s+supported|async\s+image\s+tasks\s+only\s+support|only\s+supports?\s+image\s+urls/i.test(message);
}

function pushChatImageCandidate(urls: string[], value: unknown) {
    if (typeof value !== "string") return;
    const text = value.trim();
    if (!text) return;
    if (text.startsWith("data:image/")) {
        urls.push(text.replace(/\s/g, ""));
        return;
    }
    for (const match of text.matchAll(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi)) {
        urls.push(match[0].replace(/\s/g, ""));
    }
    for (const match of text.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi)) {
        urls.push(match[1]);
    }
    if (/^https?:\/\/\S+$/i.test(text)) urls.push(text);
}

function collectChatImageSources(payload: unknown) {
    const urls: string[] = [];
    const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices || [];
    for (const choice of choices) {
        const content = choice.message?.content;
        if (typeof content === "string") {
            pushChatImageCandidate(urls, content);
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!part || typeof part !== "object") continue;
            const record = part as { text?: string; url?: string; image?: string; image_url?: { url?: string } };
            pushChatImageCandidate(urls, record.image_url?.url);
            pushChatImageCandidate(urls, record.url);
            pushChatImageCandidate(urls, record.image);
            pushChatImageCandidate(urls, record.text);
        }
    }
    return [...new Set(urls)];
}

/** Some relays (including New API forks) expose gpt-image only on /chat/completions and 404 the Images API. */
async function requestChatCompletionsImages(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const text = withSystemPrompt(config, prompt);
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text }];
    const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length || 1))));
    for (const url of refs) content.push({ type: "image_url", image_url: { url } });
    const response = await postImageJson<unknown>(
        config,
        "/chat/completions",
        {
            model: config.model,
            messages: [{ role: "user", content: references.length ? content : text }],
            stream: false,
        },
        options,
    );
    const sources = collectChatImageSources(response.data);
    const images: GeneratedImageResult[] = [];
    for (const source of sources) {
        const dataUrl = source.startsWith("data:image/") ? source : await imageToDataUrl({ url: source });
        if (dataUrl.startsWith("data:image/")) images.push({ id: nanoid(), dataUrl });
    }
    if (!images.length) throw new Error(apiText("requestFailed"));
    return images;
}

/**
 * APIMart Nano-Banana-2-Lite: chat-only model. References go in messages as `image_url` (base64
 * data URL is accepted). The reply carries the image as raw base64 in choices[0].message.content
 * (no data: prefix) — normalise it into a data URL ourselves.
 */
async function requestApimartNanoBananaLite(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const text = withSystemPrompt(config, prompt);
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text }];
    if (references.length) {
        const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length))));
        for (const url of refs) content.push({ type: "image_url", image_url: { url } });
    }
    const response = await postImageJson<unknown>(
        config,
        "/chat/completions",
        { model: config.model, messages: [{ role: "user", content }], stream: false },
        options,
    );
    const choices = (response.data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices || [];
    const images: GeneratedImageResult[] = [];
    for (const choice of choices) {
        const value = choice.message?.content;
        if (typeof value !== "string") continue;
        const raw = value.trim();
        if (!raw) continue;
        if (raw.startsWith("data:image/")) {
            images.push({ id: nanoid(), dataUrl: raw.replace(/\s/g, "") });
            continue;
        }
        // Raw base64 output (no data: prefix) — sniff the image type and wrap it.
        if (/^[a-z0-9+/=\s]+$/i.test(raw) && raw.length > 128) {
            const mime = /^\/9j\//.test(raw) ? "image/jpeg" : /^iVBOR/.test(raw) ? "image/png" : "image/png";
            images.push({ id: nanoid(), dataUrl: `data:${mime};base64,${raw.replace(/\s/g, "")}` });
        }
    }
    if (!images.length) throw new Error(apiText("requestFailed"));
    return images;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

/**
 * Map UI size/ratio into channel-friendly sizes for GPT Image models.
 * Relays (NewAPI etc.) often reject uncommon WxH like 2720x1536 even when OpenAI accepts them.
 */
function resolveGptImageRequestSize(model: string, quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return "auto";

    if (isGptImageFixedSizeModel(model)) {
        return snapToFixedGptImageSize(value);
    }

    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveGptImage2PresetSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

const GPT_IMAGE_FIXED_SIZES = [
    { width: 1024, height: 1024, size: "1024x1024" },
    { width: 1536, height: 1024, size: "1536x1024" },
    { width: 1024, height: 1536, size: "1024x1536" },
];

/** Popular gpt-image-2 sizes that most distributors whitelist. */
const GPT_IMAGE_2_PRESETS: Array<{ ratio: number; low: string; medium: string; high: string }> = [
    { ratio: 1, low: "1024x1024", medium: "2048x2048", high: "2048x2048" },
    { ratio: 3 / 2, low: "1536x1024", medium: "2304x1536", high: "2880x1920" },
    { ratio: 2 / 3, low: "1024x1536", medium: "1536x2304", high: "1920x2880" },
    { ratio: 4 / 3, low: "1360x1024", medium: "2048x1536", high: "2720x2040" },
    { ratio: 3 / 4, low: "1024x1360", medium: "1536x2048", high: "2040x2720" },
    { ratio: 16 / 9, low: "1536x864", medium: "2048x1152", high: "3840x2160" },
    { ratio: 9 / 16, low: "864x1536", medium: "1152x2048", high: "2160x3840" },
];

function snapToFixedGptImageSize(size: string) {
    const targetRatio = readSizeAspectRatio(size);
    let bestSize = GPT_IMAGE_FIXED_SIZES[0].size;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const item of GPT_IMAGE_FIXED_SIZES) {
        const delta = Math.abs(item.width / item.height - targetRatio);
        if (delta < bestDelta) {
            bestSize = item.size;
            bestDelta = delta;
        }
    }
    return bestSize;
}

function resolveGptImage2PresetSize(quality: string | undefined, ratio: string) {
    const parsed = parseImageRatio(ratio);
    const target = parsed.width / parsed.height;
    let bestPreset = GPT_IMAGE_2_PRESETS[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const preset of GPT_IMAGE_2_PRESETS) {
        const delta = Math.abs(preset.ratio - target);
        if (delta < bestDelta) {
            bestPreset = preset;
            bestDelta = delta;
        }
    }
    const tier = resolveGptImage2QualityTier(quality);
    return bestPreset[tier];
}

function resolveGptImage2QualityTier(quality: string | undefined): "low" | "medium" | "high" {
    if (quality === "low" || quality === "standard") return "low";
    if (quality === "high") return "high";
    return "medium";
}

function readSizeAspectRatio(size: string) {
    const value = size.trim();
    const dimensions = parseImageDimensions(value);
    if (dimensions) return dimensions.width / Math.max(1, dimensions.height);
    if (value.includes(":")) {
        const ratio = parseImageRatio(value);
        return ratio.width / ratio.height;
    }
    return 1;
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = (config.size || "").trim();
    const dimensions = parseImageDimensions(value);
    const ratioText = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratioText) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    const imageConfig = {
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(imageSize ? { imageSize } : {}),
    };
    // Official Gemini image API expects generationConfig.imageConfig.{aspectRatio,imageSize}.
    // Older mistaken shape responseFormat.image was ignored → always defaulted to 1:1.
    return Object.keys(imageConfig).length ? { imageConfig } : {};
}

function closestGeminiAspectRatio(value: string) {
    const normalized = value.includes("x") || value.includes("X") ? value.replace(/[xX×]/g, ":") : value;
    const ratio = parseRatioValue(normalized);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality);
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    if (Array.isArray(item.url)) {
        const first = item.url.find((value): value is string => typeof value === "string" && Boolean(value));
        if (first) return first;
    }
    if (typeof item.dataUrl === "string" && item.dataUrl) {
        return item.dataUrl;
    }
    if (typeof item.fileUrl === "string" && item.fileUrl) return item.fileUrl;
    if (typeof item.file_url === "string" && item.file_url) return item.file_url;
    return null;
}

function collectImageList(payload: ImageApiResponse) {
    const nestedResult = payload.result;
    const dataObject = payload.data && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : null;
    const dataResult = dataObject && typeof dataObject.result === "object" && dataObject.result ? (dataObject.result as { images?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>>; url?: string }) : null;
    const lists = [
        Array.isArray(payload.data) ? payload.data : null,
        payload.images,
        payload.results,
        nestedResult?.data,
        nestedResult?.images,
        dataResult?.images,
        dataResult?.data,
        Array.isArray(dataObject?.images) ? (dataObject.images as Array<Record<string, unknown>>) : null,
    ].filter((list): list is Array<Record<string, unknown>> => Array.isArray(list));
    const fromLists = lists.flatMap((list) => list.map(resolveImageDataUrl).filter((value): value is string => Boolean(value)));
    const resultUrl = typeof (payload as { result_url?: unknown }).result_url === "string" ? (payload as { result_url: string }).result_url : undefined;
    const dataResultUrl = typeof dataObject?.result_url === "string" ? dataObject.result_url : undefined;
    const singles = [payload.url, nestedResult?.url, typeof dataResult?.url === "string" ? dataResult.url : undefined, resultUrl, dataResultUrl].filter(
        (value): value is string => typeof value === "string" && Boolean(value),
    );
    return [...singles, ...fromLists];
}

/** Normalize APIMart / Seedance / relay envelopes into a flat OpenAI-like task or image payload. */
function normalizeImageApiPayload(payload: ImageApiResponse): ImageApiResponse {
    const record = payload as ImageApiResponse & {
        task_id?: string;
        image_urls?: unknown;
        grid_image_url?: unknown;
        result_url?: unknown;
        progress?: unknown;
    };

    // Create: { code:200, data:[{ status:"submitted", task_id:"..." }] }
    if (Array.isArray(payload.data) && payload.data.length === 1) {
        const item = payload.data[0] as Record<string, unknown>;
        const taskId = typeof item.task_id === "string" ? item.task_id : typeof item.id === "string" ? item.id : "";
        const looksLikeTask = Boolean(taskId) && (typeof item.status === "string" || item.object === "generation.task");
        const looksLikeImage = typeof item.b64_json === "string" || typeof item.url === "string" || Array.isArray(item.url);
        if (looksLikeTask && !looksLikeImage) {
            return {
                ...payload,
                id: taskId,
                status: typeof item.status === "string" ? item.status : "submitted",
                object: "generation.task",
                progress: typeof item.progress === "number" ? item.progress : payload.progress,
            };
        }
    }

    // Poll: { code:200, data:{ id, status, result / image_urls / result_url } }
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
        const data = payload.data as Record<string, unknown>;
        const nestedResult =
            data.result && typeof data.result === "object"
                ? (data.result as ImageApiResponse["result"])
                : payload.result;
        const imageUrls = collectStringUrls(data.image_urls) || collectStringUrls((nestedResult as { image_urls?: unknown } | undefined)?.image_urls);
        const gridUrl =
            typeof data.grid_image_url === "string"
                ? data.grid_image_url
                : typeof (nestedResult as { grid_image_url?: unknown } | undefined)?.grid_image_url === "string"
                  ? (nestedResult as { grid_image_url: string }).grid_image_url
                  : typeof data.result_url === "string"
                    ? data.result_url
                    : undefined;
        return {
            ...payload,
            id: typeof data.id === "string" ? data.id : typeof data.task_id === "string" ? data.task_id : payload.id,
            status: typeof data.status === "string" ? data.status : payload.status,
            progress: typeof data.progress === "number" ? data.progress : payload.progress,
            result: nestedResult,
            url: gridUrl || payload.url,
            images: imageUrls.length
                ? imageUrls.map((url) => ({ url }))
                : Array.isArray(data.images)
                  ? (data.images as Array<Record<string, unknown>>)
                  : payload.images,
        };
    }

    // Seedance image submit: { id, task_id, status:"queued" }
    if (!payload.id && typeof record.task_id === "string" && record.task_id) {
        payload = { ...payload, id: record.task_id };
    }

    // Midjourney / Seedance SUCCESS at top level: image_urls / grid_image_url / result_url
    const topUrls = collectStringUrls(record.image_urls);
    const topGrid =
        typeof record.grid_image_url === "string"
            ? record.grid_image_url
            : typeof record.result_url === "string"
              ? record.result_url
              : undefined;
    if (topUrls.length || topGrid) {
        return {
            ...payload,
            url: topGrid || payload.url,
            images: topUrls.length ? topUrls.map((url) => ({ url })) : payload.images,
        };
    }

    return payload;
}

function collectStringUrls(value: unknown) {
    if (!Array.isArray(value)) return [] as string[];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

function isAsyncImageTask(payload: ImageApiResponse) {
    if (typeof payload.id !== "string" || !payload.id.trim()) return false;
    if (typeof payload.status !== "string" || !payload.status.trim()) return false;
    // Sync OpenAI-style payloads already contain image data; do not treat them as tasks.
    if (collectImageList(payload).length > 0) return false;
    const status = payload.status.trim().toLowerCase();
    return ["queued", "submitted", "pending", "in_progress", "processing", "running", "completed", "succeeded", "success", "failed", "failure", "cancelled", "canceled"].includes(status)
        || payload.object === "generation.task"
        || typeof payload.progress === "number"
        || typeof (payload as { progress?: unknown }).progress === "string";
}

function resolveImagePollPaths(config: AiConfig, taskId: string) {
    const id = encodeURIComponent(taskId);
    // Seedance / APIMart Midjourney: https://api.seedance.nz/docs/#mj-overview
    if (isMidjourneyModel(config.model)) {
        return [`/midjourney/tasks/${id}`, `/midjourney/${id}`, `/tasks/${id}`];
    }
    // Seedance image API uses singular /image/generations (not /images/...).
    if (isSeedanceNzBaseUrl(config.baseUrl)) {
        return [`/image/generations/${id}`, `/tasks/${id}`];
    }
    if (isApimartBaseUrl(config.baseUrl)) {
        return [`/tasks/${id}`, `/images/generations/${id}`];
    }
    return [`/images/generations/${id}`, `/tasks/${id}`];
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

async function pollAsyncImageTaskPayload(config: AiConfig, taskId: string, options?: RequestOptions) {
    const deadline = performance.now() + IMAGE_TASK_POLL_TIMEOUT_MS;
    const paths = resolveImagePollPaths(config, taskId);
    let pathIndex = 0;
    let pollPath = paths[0];
    while (performance.now() < deadline) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const response = await axios.get<ImageApiResponse>(aiApiUrl(config, pollPath), {
                headers: aiHeaders(config),
                signal: options?.signal,
            });
            const payload = normalizeImageApiPayload(response.data);
            if (typeof payload.code === "number" && !isApiSuccessCode(payload.code)) {
                throw new Error(payload.msg || readApiErrorMessage(payload) || apiText("requestFailed"));
            }
            const status = String(payload.status || "").trim().toLowerCase();
            if (status === "completed" || status === "succeeded" || status === "success") {
                return payload;
            }
            if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired" || status === "failure") {
                throw new Error(readApiErrorMessage(payload.error) || readApiErrorMessage(payload) || apiText("imageTaskFailed"));
            }
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404 && pathIndex < paths.length - 1) {
                pathIndex += 1;
                pollPath = paths[pathIndex];
                continue;
            }
            throw error;
        }
        await sleep(IMAGE_TASK_POLL_INTERVAL_MS, options?.signal);
    }
    throw new Error(apiText("imageTaskPollTimeout"));
}

async function pollAsyncImageTask(config: AiConfig, taskId: string, options?: RequestOptions) {
    return parseImagePayload(await pollAsyncImageTaskPayload(config, taskId, options));
}

async function resolveRunningHubImageTask(config: AiConfig, payload: ImageApiResponse, options?: RequestOptions) {
    const hub = readRunningHubTask(payload);
    if (!hub) return null;
    if (hub.errorMessage || /fail|cancel|error/i.test(hub.status)) {
        throw new Error(hub.errorMessage || apiText("runningHubTaskFailed"));
    }
    const done = /^(success|succeeded|completed)$/i.test(hub.status);
    const images = done ? hub.images : [];
    if (done) {
        if (!images.length) throw new Error(apiText("runningHubNoImage"));
        return {
            id: hub.taskId,
            status: hub.status,
            url: images[0],
            images: images.map((url) => ({ url })),
            results: images.map((url) => ({ url })),
        } satisfies ImageApiResponse;
    }
    const origin = runningHubOrigin(config.baseUrl) || "https://www.runninghub.cn";
    const finalTask = await pollRunningHubQuery({ origin, apiKey: config.apiKey, taskId: hub.taskId, signal: options?.signal });
    if (!finalTask.images.length) throw new Error(apiText("runningHubNoImage"));
    return {
        id: finalTask.taskId,
        status: finalTask.status,
        url: finalTask.images[0],
        images: finalTask.images.map((url) => ({ url })),
        results: finalTask.images.map((url) => ({ url })),
    } satisfies ImageApiResponse;
}

async function resolveImageTaskPayload(config: AiConfig, payload: ImageApiResponse, options?: RequestOptions) {
    const runningHub = await resolveRunningHubImageTask(config, payload, options);
    if (runningHub) return runningHub;
    const normalized = normalizeImageApiPayload(payload);
    if (isAsyncImageTask(normalized)) {
        const status = String(normalized.status || "").trim().toLowerCase();
        if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired" || status === "failure") {
            throw new Error(readApiErrorMessage(normalized.error) || readApiErrorMessage(normalized) || apiText("imageTaskFailed"));
        }
        if (status === "completed" || status === "succeeded" || status === "success") {
            return normalized;
        }
        if (!normalized.id) throw new Error(apiText("imageTaskFailed"));
        return pollAsyncImageTaskPayload(config, normalized.id, options);
    }
    return normalized;
}

async function resolveImageApiResponse(config: AiConfig, payload: ImageApiResponse, options?: RequestOptions) {
    return parseImagePayload(await resolveImageTaskPayload(config, payload, options));
}

function parseImagePayload(payload: ImageApiResponse, options?: { allowEmpty?: boolean }) {
    if (typeof payload.code === "number" && !isApiSuccessCode(payload.code)) {
        throw new Error(payload.msg || apiText("requestFailed"));
    }
    const images = collectImageList(payload).map((dataUrl) => ({ id: nanoid(), dataUrl }));

    if (images.length === 0) {
        if (options?.allowEmpty) return images;
        // Check whether the response contains data in an unrecognized format.
        const rawKeys = Object.keys(payload).filter((k) => k !== "code" && k !== "msg" && k !== "error");
        throw new Error(rawKeys.length > 0
            ? apiText("unknownImageResponse", { fields: rawKeys.join(", ") })
            : apiText("noImageReturned"));
    }

    return images;
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        // The value may be serialized JSON, such as error.message, or a plain-text error.
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            // Treat an empty parsed object such as "{}" as having no useful message.
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            // Detect HTML error pages.
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return clarifyEdgeError(value);
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown; code?: unknown };
    // error may be a string or an object containing a message.
    const nestedError = payload.error;
    const nestedObj = nestedError && typeof nestedError === "object" ? (nestedError as { message?: unknown; code?: unknown }) : null;
    const errorMsg = typeof nestedError === "string" ? nestedError : nestedObj?.message;
    const codeHint =
        typeof payload.code === "string"
            ? payload.code
            : typeof nestedObj?.code === "string"
              ? nestedObj.code
              : "";
    const text =
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        "";
    if (codeHint && text && !text.includes(codeHint)) return `${text} (${codeHint})`;
    return text || codeHint;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response) {
            // No server response at all: the request never reached the API (CORS block, unreachable address, DNS).
            // Chrome reports these as ERR_FAILED rather than ERR_NETWORK, so treat any response-less failure as a network/cors issue.
            const url = typeof error.config?.url === "string" ? error.config.url : "";
            const hint = url ? `\n${url}` : "";
            return error.code === "ERR_NETWORK" ? `${apiText("corsRequired")}${hint}` : `${apiText("networkFailed")}${hint}`;
        }
        const responseData = error.response?.data;
        // Prefer the API error from the response body.
        const apiMsg = clarifyAuthError(clarifyEdgeError(readApiErrorMessage(responseData)));
        const requestUrl = readRequestTargetUrl(typeof error.config?.url === "string" ? error.config.url : "");
        if (apiMsg) return requestUrl && error.response?.status === 404 ? `${apiMsg}\n${requestUrl}` : apiMsg;
        // Infer the error from the HTTP status when the response body has no usable message.
        const statusMsg = readStatusError(error.response?.status, fallback, requestUrl);
        if (statusMsg) {
            const raw = typeof responseData === "string" ? responseData.slice(0, 300) : "";
            const detail = raw && !/^\s*</.test(raw) ? `\n${raw}` : "";
            return requestUrl ? `${statusMsg}\n${requestUrl}${detail}` : `${statusMsg}${detail}`;
        }
        // Fall back to Axios's own error message.
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || readNetworkMessage(error.message) || error.message : fallback;
}

// Maps raw browser network error texts (fetch adapters, native fetch, service workers) that axios
// cannot classify to the same clear message as ERR_NETWORK/ERR_FAILED.
function readNetworkMessage(message: string) {
    if (/upstream timed out|aborted due to timeout|TimeoutError|proxy error:.*timed out/i.test(message)) {
        return apiText("proxyTimedOut");
    }
    return /failed to fetch|network error|load failed|net::err_/i.test(message) ? apiText("networkFailed") : null;
}

// Relays pass Cloudflare edge-error prose (520 "invalid or incomplete response", 521 "web server
// is down", 522/524 timeouts) through their JSON error.message — replace it with a clear localized
// cause so users don't mistake a provider-side outage for an app bug.
function clarifyEdgeError(message: string) {
    if (!/cloudflare/i.test(message)) return message;
    const code = message.match(/\b52([0-4])\b/)?.[0] ?? (/origin web server returned an invalid|web server is down/i.test(message) ? "520" : "5xx");
    return apiText("originOverloaded", { status: code });
}

function readStatusError(status: number | undefined, fallback: string, requestUrl = "") {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 413) return apiText("payloadTooLarge");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return /\/models(\/|\?|$)/i.test(requestUrl) ? apiText("notFoundModels") : apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    // Cloudflare edge errors: the request reached the provider but their origin failed.
    if (status && status >= 520 && status <= 524) return apiText("originOverloaded", { status });
    return status ? apiText("httpFailed", { status }) : fallback;
}

async function prepareReferenceDataUrl(image: ReferenceImage, referenceCount = 1, options?: { preserveAlpha?: boolean }) {
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    return compressReferenceDataUrl(dataUrl, referenceCount, { preserveAlpha: options?.preserveAlpha });
}

/**
 * Prefer a verified public HTTP URL; re-host local data: URLs on a temporary public host when
 * the provider only fetches public links. Falls back to the original behaviors (raw remote URL
 * or inline base64) when no host is reachable, so nothing regresses when hosts are down.
 */
async function resolveInlineOrRemoteReferenceUrl(image: ReferenceImage, referenceCount = 1, options?: { signal?: AbortSignal }) {
    const remoteUrl = [image.url, image.dataUrl].find((value) => value && isPublicHttpUrl(value) && !value.startsWith("data:"))?.trim();
    if (remoteUrl && (await fetchRemoteImageBlob(remoteUrl))) return remoteUrl;
    const dataUrl = await prepareReferenceDataUrl(image, referenceCount);
    try {
        return await uploadTemporaryPublicImageFromDataUrl(dataUrl, options?.signal);
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        if (remoteUrl) return remoteUrl;
        return dataUrl;
    }
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function runningHubWorkflowId(config: AiConfig, encodedModel: string, request: { baseUrl: string; model: string }, script: string) {
    const channel = resolveModelChannel(config, encodedModel);
    return pickRunningHubWorkflowId({
        baseUrl: request.baseUrl || channel.baseUrl,
        model: request.model,
        script,
        channelName: channel.name,
        siblingModels: channel.models,
    });
}

async function requestRunningHubImages(config: AiConfig, prompt: string, referenceDataUrls: string[], script: string, options?: RequestOptions) {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    const result = await runRunningHubWorkflow({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model || config.imageModel,
        script,
        prompt,
        size: config.size,
        referenceDataUrls,
        signal: options?.signal,
    });
    if (result.images.length) return result.images.map((dataUrl) => ({ id: nanoid(), dataUrl }));
    throw new Error(apiText("runningHubNoImage"));
}

async function requestNativeComfyUiImages(config: AiConfig, prompt: string, referenceDataUrls: string[], options?: RequestOptions) {
    const script = resolveModelScript(config, config.model || config.imageModel);
    const workflow = parseComfyApiWorkflow(script);
    if (!workflow) throw new Error(apiText("comfyWorkflowRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    const result = await runNativeComfyUiJob({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        workflow,
        prompt,
        referenceDataUrls,
        signal: options?.signal,
    });
    if (result.images.length) return result.images;
    throw new Error(apiText("comfyNoImage"));
}

/** hfsyapi mj_imagine: POST {origin}/mj/submit/imagine, then GET /mj/task/{id}/fetch. Not /v1/midjourney/generations. */
function hfsyApiOrigin(baseUrl: string) {
    try {
        return new URL(baseUrl.trim()).origin;
    } catch {
        return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "");
    }
}

function isHfsyMjImagineModel(config: Pick<AiConfig, "baseUrl" | "model">) {
    return isHfsyApiBaseUrl(config.baseUrl) && /^mj_imagine$/i.test(config.model.trim());
}

function hfsyMjUrl(config: AiConfig, path: string) {
    return proxyApiUrl(`${hfsyApiOrigin(config.baseUrl)}${path}`);
}

function appendMjFlag(prompt: string, flag: string, value?: string) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`${escaped}(?:\\s+\\S+)?`, "i").test(prompt)) return prompt;
    return `${prompt} ${value ? `${flag} ${value}` : flag}`.trim();
}

function hfsyMjPrompt(config: AiConfig, prompt: string) {
    let text = withSystemPrompt(config, prompt).trim();
    const rawSize = config.size.trim();
    if (rawSize && rawSize.toLowerCase() !== "auto") {
        const dimensions = parseImageDimensions(rawSize);
        const ratio = closestAspectRatioLabel(dimensions ? `${dimensions.width}:${dimensions.height}` : rawSize.replace(/[xX×]/g, ":"), APIMART_DEFAULT_RATIOS);
        text = appendMjFlag(text, "--ar", ratio);
    }
    const version = resolveMidjourneyVersionBody(config.mjVersion);
    text = version.niji ? appendMjFlag(text, "--niji", version.version) : appendMjFlag(text, "--v", version.version);
    if (!/--(?:turbo|relax|fast)\b/i.test(text)) {
        const speed = resolveMidjourneySpeed(config.quality);
        text = `${text} ${speed === "turbo" ? "--turbo" : speed === "relax" ? "--relax" : "--fast"}`.trim();
    }
    return text;
}

type HfsyMjSubmit = { code?: number; result?: string | number; taskId?: string; id?: string; description?: string; message?: string };

function readHfsyMjTaskId(payload: HfsyMjSubmit | null | undefined) {
    const id = payload?.result ?? payload?.taskId ?? payload?.id;
    return id == null ? "" : String(id).trim();
}

function unwrapHfsyMjTask(payload: unknown) {
    if (!payload || typeof payload !== "object") return {} as Record<string, unknown>;
    const record = payload as Record<string, unknown>;
    const data = record.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
        const nested = data as Record<string, unknown>;
        if ("status" in nested || "imageUrl" in nested || "imageUrls" in nested || "image_url" in nested || "failReason" in nested) {
            return { ...record, ...nested };
        }
    }
    return record;
}

function readHfsyMjUrls(task: Record<string, unknown>) {
    const urls: string[] = [];
    const push = (value: unknown) => {
        if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) urls.push(value.trim());
    };
    const lists: unknown[] = [task.imageUrls, task.image_urls];
    const data = task.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
        const nested = data as Record<string, unknown>;
        lists.push(nested.imageUrls, nested.image_urls);
        push(nested.image_url);
        push(nested.imageUrl);
        push(nested.result_url);
        push(nested.url);
    }
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (typeof item === "string") push(item);
            else if (item && typeof item === "object") push((item as { url?: unknown }).url);
        }
    }
    push(task.imageUrl);
    push(task.result_url);
    push(task.image_url);
    push(task.url);
    return [...new Set(urls)];
}

async function postHfsyMj<T>(config: AiConfig, path: string, data: unknown, options?: RequestOptions) {
    return axios.post<T>(hfsyMjUrl(config, path), data, {
        headers: aiHeaders(config, "application/json"),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
}

async function pollHfsyMjTask(config: AiConfig, taskId: string, options?: RequestOptions) {
    const deadline = performance.now() + IMAGE_TASK_POLL_TIMEOUT_MS;
    const url = hfsyMjUrl(config, `/mj/task/${encodeURIComponent(taskId)}/fetch`);
    while (performance.now() < deadline) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await axios.get<unknown>(url, { headers: aiHeaders(config), signal: options?.signal, timeout: IMAGE_REQUEST_TIMEOUT_MS });
        const task = unwrapHfsyMjTask(response.data);
        const status = String(task.status || task.state || "").trim().toLowerCase();
        if (["failure", "failed", "error", "cancel", "cancelled", "canceled"].includes(status)) {
            const reason = task.failReason || task.description || task.error;
            throw new Error(typeof reason === "string" && reason.trim() ? reason : apiText("imageTaskFailed"));
        }
        const urls = readHfsyMjUrls(task);
        const progress = String(task.progress || "");
        if (urls.length && (status === "success" || status === "completed" || progress === "100%")) {
            const grid = typeof task.imageUrl === "string" ? task.imageUrl : typeof task.result_url === "string" ? task.result_url : "";
            return { urls, grid };
        }
        await sleep(IMAGE_TASK_POLL_INTERVAL_MS, options?.signal);
    }
    throw new Error(apiText("imageTaskPollTimeout"));
}

function hfsyMjImages(taskId: string, done: { urls: string[]; grid: string }, count: number): GeneratedImageResult[] {
    const candidates = [...new Set([done.grid, ...done.urls].filter((url): url is string => /^https?:\/\//i.test(String(url || ""))))];
    const grid = candidates[0] || "";
    if (grid) {
        return [{ id: nanoid(), dataUrl: grid, fallbackUrls: candidates.slice(1), midjourneyTaskId: taskId }];
    }
    const limit = Math.max(1, Math.min(4, count));
    return done.urls.slice(0, limit).map((dataUrl, index) => ({
        id: nanoid(),
        dataUrl,
        fallbackUrls: done.urls.filter((url) => url !== dataUrl),
        midjourneyTaskId: taskId,
        midjourneyIndex: index + 1,
    }));
}

async function requestHfsyMjImagine(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const body: Record<string, unknown> = {
        botType: "MID_JOURNEY",
        prompt: hfsyMjPrompt(config, prompt),
    };
    if (references.length) {
        const images: string[] = [];
        for (const image of references.slice(0, 7)) {
            images.push(await prepareReferenceDataUrl(image, references.length));
        }
        body.base64Array = images;
    }
    const response = await postHfsyMj<HfsyMjSubmit>(config, "/mj/submit/imagine", body, options);
    const taskId = readHfsyMjTaskId(response.data);
    if (!taskId) throw new Error(response.data?.description || response.data?.message || apiText("imageTaskFailed"));
    const done = await pollHfsyMjTask(config, taskId, options);
    if (!done.urls.length && !done.grid) throw new Error(apiText("imageTaskFailed"));
    const count = Math.max(1, Math.min(4, Math.floor(Math.abs(Number(config.count)) || 1)));
    return hfsyMjImages(taskId, done, count);
}

function hfsyUpscaleCustomId(task: Record<string, unknown>, index: number) {
    const buttons = Array.isArray(task.buttons) ? task.buttons : [];
    for (const button of buttons) {
        if (!button || typeof button !== "object") continue;
        const item = button as { customId?: unknown; label?: unknown };
        const customId = typeof item.customId === "string" ? item.customId : "";
        const label = String(item.label || "").trim().toUpperCase();
        if (label === `U${index}` || customId.includes(`upsample::${index}::`)) return customId;
    }
    return "";
}

async function requestHfsyMjUpscale(config: AiConfig, parentTaskId: string, index: number, options?: RequestOptions) {
    const fetched = await axios.get<unknown>(hfsyMjUrl(config, `/mj/task/${encodeURIComponent(parentTaskId)}/fetch`), {
        headers: aiHeaders(config),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
    const customId = hfsyUpscaleCustomId(unwrapHfsyMjTask(fetched.data), index);
    if (!customId) throw new Error(apiText("imageTaskFailed"));
    const response = await postHfsyMj<HfsyMjSubmit>(config, "/mj/submit/action", { taskId: parentTaskId, customId }, options);
    const taskId = readHfsyMjTaskId(response.data);
    if (!taskId) throw new Error(response.data?.description || response.data?.message || apiText("imageTaskFailed"));
    const done = await pollHfsyMjTask(config, taskId, options);
    const url = done.urls[0] || done.grid;
    if (!url) throw new Error(apiText("imageTaskFailed"));
    return [{ id: nanoid(), dataUrl: url }];
}

/** Midjourney (Seedance / APIMart): Imagine only — Upscale is manual. See seedance.nz/docs/#mj-overview */
async function requestMidjourneyGeneration(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    if (isHfsyMjImagineModel(config)) return requestHfsyMjImagine(config, prompt, references, options);
    const size = closestAspectRatioLabel(
        (() => {
            const value = config.size.trim();
            if (!value || value.toLowerCase() === "auto") return "1:1";
            const dimensions = parseImageDimensions(value);
            return dimensions ? `${dimensions.width}:${dimensions.height}` : value.replace(/[xX×]/g, ":");
        })(),
        APIMART_DEFAULT_RATIOS,
    );
    const speed = resolveMidjourneySpeed(config.quality);
    const body: Record<string, unknown> = {
        // Path decides billing SKU (midjourney-imagine); body.model is optional / ignored for routing.
        prompt: withSystemPrompt(config, prompt),
        size,
        speed,
        ...resolveMidjourneyVersionBody(config.mjVersion),
    };
    if (references.length) {
        const urls: string[] = [];
        for (const image of references.slice(0, 5)) {
            urls.push(await resolveInlineOrRemoteReferenceUrl(image, references.length, { signal: options?.signal }));
        }
        body.image_urls = urls;
    }

    const mjConfig = { ...config, model: config.model || "midjourney" };
    const imagineResponse = await postImageJson<ImageApiResponse>(mjConfig, "/midjourney/generations", body, options);
    const imagineTask = await resolveImageTaskPayload(mjConfig, imagineResponse.data, options);
    const parentTaskId = imagineTask.id;
    if (!parentTaskId) throw new Error(apiText("imageTaskFailed"));

    // Do not auto-Upscale. Return Imagine previews (tiles or grid) and keep task id for manual U1–U4.
    const count = Math.max(1, Math.min(4, Math.floor(Math.abs(Number(config.count)) || 1)));
    return parseMidjourneyImagineImages(imagineTask, parentTaskId, count);
}

function readMidjourneyGridUrl(payload: ImageApiResponse) {
    const record = payload as ImageApiResponse & { grid_image_url?: unknown; result_url?: unknown; data?: unknown };
    const data = record.data && !Array.isArray(record.data) ? (record.data as Record<string, unknown>) : null;
    const nestedResult = data && typeof data.result === "object" && data.result ? (data.result as Record<string, unknown>) : null;
    const candidates = [
        typeof record.grid_image_url === "string" ? record.grid_image_url : "",
        typeof record.result_url === "string" ? record.result_url : "",
        typeof data?.grid_image_url === "string" ? data.grid_image_url : "",
        typeof data?.result_url === "string" ? data.result_url : "",
        typeof nestedResult?.grid_image_url === "string" ? nestedResult.grid_image_url : "",
        typeof payload.url === "string" ? payload.url : "",
    ];
    return candidates.find((url) => Boolean(url)) || "";
}

function readMidjourneyTileUrls(payload: ImageApiResponse) {
    const record = payload as ImageApiResponse & { image_urls?: unknown; data?: unknown };
    const data = record.data && !Array.isArray(record.data) ? (record.data as Record<string, unknown>) : null;
    const nestedResult = data && typeof data.result === "object" && data.result ? (data.result as Record<string, unknown>) : null;
    const fromArrays = [
        collectStringUrls(record.image_urls),
        collectStringUrls(data?.image_urls),
        collectStringUrls(nestedResult?.image_urls),
    ].find((urls) => urls.length > 0);
    if (fromArrays?.length) return fromArrays;
    if (Array.isArray(payload.images) && payload.images.length) {
        return payload.images.map(resolveImageDataUrl).filter((value): value is string => Boolean(value));
    }
    return [] as string[];
}

function parseMidjourneyImagineImages(payload: ImageApiResponse, parentTaskId: string, count: number): GeneratedImageResult[] {
    const tiles = readMidjourneyTileUrls(payload);
    const grid = readMidjourneyGridUrl(payload);
    const limit = Math.max(1, Math.min(4, count));

    // Prefer the classic 2×2 grid so the canvas shows one Imagine result; Upscale (U1–U4) is manual.
    if (grid) {
        return [{ id: nanoid(), dataUrl: grid, midjourneyTaskId: parentTaskId }];
    }

    // Fallback when the relay only returns separate tiles (no grid_image_url).
    if (tiles.length >= 1) {
        return tiles.slice(0, limit).map((dataUrl, index) => ({
            id: nanoid(),
            dataUrl,
            midjourneyTaskId: parentTaskId,
            midjourneyIndex: index + 1,
        }));
    }

    return parseImagePayload(payload).map((image) => ({ ...image, midjourneyTaskId: parentTaskId }));
}

/** Manual Midjourney Upscale (U1–U4). Billing uses the upscale path SKU. */
export async function requestMidjourneyUpscale(config: AiConfig, parentTaskId: string, index: number, options?: RequestOptions) {
    const requestConfig = resolveImageRequestConfig(config);
    const safeIndex = Math.max(1, Math.min(4, Math.floor(index) || 1));
    if (isHfsyMjImagineModel(requestConfig) || (isHfsyApiBaseUrl(requestConfig.baseUrl) && isMidjourneyModel(requestConfig.model))) {
        try {
            return await requestHfsyMjUpscale(requestConfig, parentTaskId, safeIndex, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    const mjConfig = { ...requestConfig, model: requestConfig.model || "midjourney" };
    try {
        const response = await postImageJson<ImageApiResponse>(
            mjConfig,
            "/midjourney/generations/upscale",
            { task_id: parentTaskId, index: safeIndex },
            options,
        );
        const task = await resolveImageTaskPayload(mjConfig, response.data, options);
        const images = parseImagePayload(task, { allowEmpty: true });
        // Upscale SUCCESS usually has a single URL in image_urls; prefer non-grid singles.
        if (images.length <= 1) return images;
        // If a relay still returns multiple, keep the first (selected tile).
        return images.slice(0, 1);
    } catch (error) {
        throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), mjConfig.model));
    }
}

/** Seedance normalizes main versions to v8.2/v8.1/v7/v6.1/v5.2/v5.1; Niji is niji + version 7/6. */
function resolveMidjourneyVersionBody(value: string) {
    const normalized = String(value || "8.1").trim().toLowerCase().replace(/^v/, "");
    if (normalized === "niji7" || normalized === "niji-7") return { version: "7", niji: true };
    if (normalized === "niji6" || normalized === "niji-6") return { version: "6", niji: true };
    const allowed = ["8.2", "8.1", "7", "6.1", "5.2", "5.1"];
    return { version: allowed.includes(normalized) ? normalized : "8.1" };
}

function resolveMidjourneySpeed(quality: string) {
    const normalized = normalizeQuality(quality);
    if (normalized === "high") return "turbo";
    if (normalized === "low" || normalized === "standard") return "relax";
    return "fast";
}

/** Seedance.nz non-MJ images: POST /v1/image/generations (singular) + metadata.resolution */
async function requestSeedanceNzImage(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const resolution = resolveSeedanceNzResolution(config.model, config.quality);
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        metadata: {
            ...(resolution ? { resolution } : {}),
            output_format: "png",
        },
    };
    if (references.length) {
        const urls: string[] = [];
        for (const image of references.slice(0, 10)) {
            urls.push(await resolveInlineOrRemoteReferenceUrl(image, references.length, { signal: options?.signal }));
        }
        body.images = urls;
    }
    try {
        const response = await postImageJson<ImageApiResponse>(config, "/image/generations", body, options);
        return resolveImageApiResponse(config, response.data, options);
    } catch (error) {
        // The API validates `metadata.resolution` case-sensitively and lists the accepted values in
        // the error ("resolution must be one of: 1K (invalid_parameter)"). Retry once with a value
        // taken verbatim from that list before giving up — the accepted casing may change again.
        if (options?.signal?.aborted) throw error;
        const message = readAxiosError(error, apiText("requestFailed"));
        const allowed = readSeedanceResolutionErrorValues(message);
        const intended = String((body.metadata as Record<string, unknown> | undefined)?.resolution ?? "");
        const retryValue = pickSeedanceResolutionRetryValue(intended, allowed || []);
        if (!retryValue || retryValue === intended) throw error;
        const retryBody: Record<string, unknown> = { ...body, metadata: { ...(body.metadata as Record<string, unknown>), resolution: retryValue } };
        const retryResponse = await postImageJson<ImageApiResponse>(config, "/image/generations", retryBody, options);
        return resolveImageApiResponse(config, retryResponse.data, options);
    }
}

/** Parse the allowed resolution list out of "resolution must be one of: 1K (invalid_parameter)". */
function readSeedanceResolutionErrorValues(message: string) {
    const match = message.match(/resolution\s+must\s+be\s+(?:one\s+of|among)\s*:?\s*([^(]+)/i);
    if (!match) return null;
    const values = match[1]
        .split(/[,/|]+/)
        .map((value) => value.trim().replace(/^["']|["']$/g, ""))
        .filter((value) => /^[124]k$/i.test(value));
    return values.length ? values : null;
}

function pickSeedanceResolutionRetryValue(intended: string, allowed: string[]) {
    if (!allowed.length) return "";
    const target = intended.trim().toLowerCase();
    return allowed.find((value) => value.toLowerCase() === target) || allowed[0];
}

function resolveSeedanceNzResolution(model: string, quality: string) {
    const normalized = normalizeQuality(quality);
    // The API's validation is case-sensitive: "1k" is rejected, "1K" is accepted.
    if (/zhenzhen-image-g2/i.test(model)) return "1K";
    if (normalized === "low" || normalized === "standard") return "1K";
    if (normalized === "high" && /zhenzhen-image-g-v2-lowprice/i.test(model)) return "4K";
    return "2K";
}

function aiApiUrl(config: AiConfig, path: string) {
    return proxyApiUrl(buildApiUrl(config.baseUrl, path));
}

/** Seedream / image APIs often take 1–3 minutes; keep client wait aligned with the site proxy (Hobby ≤300s). */
const IMAGE_REQUEST_TIMEOUT_MS = 300_000;

async function postImageJson<T>(config: AiConfig, path: string, data: unknown, options?: RequestOptions) {
    return axios.post<T>(aiApiUrl(config, path), data, {
        headers: aiHeaders(config, "application/json"),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
}

async function postImageForm<T>(config: AiConfig, path: string, data: FormData, options?: RequestOptions) {
    return axios.post<T>(aiApiUrl(config, path), data, {
        headers: aiHeaders(config),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    const url = !action ? `${baseUrl}/models` : `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
    return proxyApiUrl(url);
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        // Google native uses x-goog-api-key; New API / most CN relays expect Bearer.
        "x-goog-api-key": config.apiKey,
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(apiText("geminiRejected", { reason: payload.promptFeedback.blockReason }));
}

async function readFetchError(response: Response, fallback: string) {
    const requestUrl = readRequestTargetUrl(response.url);
    const text = await response.text();
    let message = "";
    if (!text) message = readStatusError(response.status, fallback, requestUrl);
    else {
        try {
            message = responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback, requestUrl);
        } catch {
            // Cloudflare edge-error pages carry a recognizable sentence — surface the localized cause.
            if (/cloudflare/i.test(text)) {
                const edge = clarifyEdgeError(text);
                if (edge !== text) return clarifyAuthError(edge);
            }
            // Reverse proxies and CDN edges often return an HTML error page instead of JSON.
            if (/<[a-z][\s\S]*>/i.test(text)) message = apiText("htmlError", { preview: `${text.slice(0, 80)}...` });
            else message = clarifyEdgeError(text.slice(0, 300)) || readStatusError(response.status, fallback, requestUrl);
        }
    }
    if (response.status === 404 && requestUrl && !message.includes(requestUrl)) return `${message}\n${requestUrl}`;
    return clarifyAuthError(message);
}

function clarifyAuthError(message: string) {
    if (!message) return message;
    if (/api key or ak\/sk|missing or invalid|invalidauthorization|unauthorized|鉴权失败/i.test(message)) {
        return `${apiText("authenticationFailed")}\n${message}`;
    }
    return message;
}

function readRequestTargetUrl(url: string) {
    if (!url) return "";
    try {
        const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
        return parsed.searchParams.get("target") || url;
    } catch {
        return url;
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify(await compressBodyImagesForProxy({ ...body, stream: true })),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

async function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = await toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")), config.baseUrl);
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

async function toGeminiContents(messages: ResponseInputMessage[], baseUrl?: string): Promise<GeminiContent[]> {
    const callNameById = new Map<string, string>();
    const usePublicUrls = baseUrl ? prefersGeminiPublicImageUrls(baseUrl) : false;
    const contents: GeminiContent[] = [];
    for (const message of messages) {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            contents.push({ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] });
            continue;
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            contents.push({ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] });
            continue;
        }
        contents.push({ role: message.role === "assistant" ? "model" : "user", parts: await toGeminiParts(message.content, usePublicUrls) });
    }
    return contents;
}

async function toGeminiParts(content: ResponseMessageContent, usePublicUrls: boolean): Promise<GeminiPart[]> {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    const parts: GeminiPart[] = [];
    for (const item of content) {
        if (item.type === "text") {
            parts.push({ text: item.text });
            continue;
        }
        parts.push(await toGeminiImagePart(item.image_url.url, usePublicUrls));
    }
    return parts;
}

async function toGeminiImagePart(url: string, usePublicUrls = false): Promise<GeminiPart> {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) {
        // Some CN relays (hfsyapi, toapis) reject base64 inline images outright — re-host the
        // local bytes on a temporary public host so the model can fetch them as a fileUri.
        if (usePublicUrls) {
            const publicUrl = await uploadTemporaryPublicImageFromDataUrl(url);
            if (publicUrl) return { fileData: { fileUri: publicUrl, mimeType: match[1] } };
        }
        return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    return { fileData: { fileUri: url, mimeType: guessImageMimeType(url) } };
}

function guessImageMimeType(url: string) {
    const path = url.split("?")[0].toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    return "image/png";
}

/** Official Google accepts inline base64; hfsyapi / toapis Gemini only accept public fileUri URLs (reject base64 inline images). */
function prefersGeminiPublicImageUrls(baseUrl: string) {
    return isHfsyApiBaseUrl(baseUrl) || isToapisBaseUrl(baseUrl);
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, rawBody: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    // Inline reference images can push the serialized body past the ~4.5MB proxy limit.
    const body = await compressBodyImagesForProxy(rawBody);
    let response: Response;
    try {
        response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
            method: "POST",
            headers: geminiHeaders(config),
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    } catch (error) {
        // A closed proxy connection has no Response to inspect. Retry once without SSE;
        // the non-streaming endpoint is more tolerant of CDN/proxy connection limits.
        if (isAbortError(error)) throw error;
        return requestGeminiNonStreamingResponse(config, body, options);
    }

    if (!response.ok) {
        const message = await readFetchError(response, apiText("requestFailed"));
        if (shouldFallbackGeminiStream(response, message)) return requestGeminiNonStreamingResponse(config, body, options);
        throw new Error(message);
    }
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
            if (state.error) throw new Error(state.error);
        }
        consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
        if (state.error) throw new Error(state.error);
        return { content: state.text, toolCalls: state.toolCalls };
    } catch (error) {
        // If the edge closes an otherwise valid SSE response before any payload arrives,
        // retry through the simpler JSON endpoint. Do not replay after partial output.
        if (!state.text && !state.toolCalls.length && shouldFallbackGeminiStreamError(error)) {
            return requestGeminiNonStreamingResponse(config, body, options);
        }
        throw error;
    }
}

async function requestGeminiNonStreamingResponse(config: AiConfig, rawBody: Record<string, unknown>, options?: RequestOptions): Promise<ToolResponseResult> {
    const body = await compressBodyImagesForProxy(rawBody);
    const response = await fetch(geminiApiUrl(config, "generateContent"), {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    return parseGeminiToolResponse((await response.json()) as GeminiPayload);
}

function shouldFallbackGeminiStream(response: Response, message: string) {
    const contentType = response.headers.get("content-type") || "";
    return response.status === 522 || response.status === 525 || /html/i.test(contentType) || /connection (closed|reset)|socket|network|proxy error|timed out/i.test(message);
}

function shouldFallbackGeminiStreamError(error: unknown) {
    if (isAbortError(error)) return false;
    const message = error instanceof Error ? error.message : String(error || "");
    return !message || /connection (closed|reset)|socket|network|proxy error|timed out|terminated|failed to fetch/i.test(message);
}

function isAbortError(error: unknown) {
    return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const buildParts = async (usePublicUrls: boolean) => {
        const parts: GeminiPart[] = [{ text: prompt }];
        if (!references.length) return parts;
        if (usePublicUrls) {
            const urls = await resolveReferenceImageUrls(config, references, options);
            for (const url of urls) parts.push(await toGeminiImagePart(url, true));
            return parts;
        }
        const count = Math.max(1, references.length);
        for (const image of references) {
            parts.push(await toGeminiImagePart(await prepareReferenceDataUrl(image, count)));
        }
        return parts;
    };

    const preferPublic = Boolean(references.length) && prefersGeminiPublicImageUrls(config.baseUrl);
    try {
        return await postGeminiImageParts(config, prompt, await buildParts(preferPublic), options);
    } catch (error) {
        const message = readAxiosError(error, apiText("requestFailed"));
        // Retry public fileUri when a base64-averse relay (hfsyapi, toapis) rejects inline base64.
        if (!references.length || !prefersGeminiPublicImageUrls(config.baseUrl) || !isReferenceBase64Unsupported(message) || preferPublic) {
            throw error instanceof Error ? error : new Error(message);
        }
        return await postGeminiImageParts(config, prompt, await buildParts(true), options);
    }
}

async function postGeminiImageParts(config: AiConfig, prompt: string, parts: GeminiPart[], options?: RequestOptions) {
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...(await toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } })),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const dataUrls =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value)) || [];
    // Higher resolutions may return a 1K preview first, then the final image — prefer the last.
    const selected = dataUrls.length ? [dataUrls[dataUrls.length - 1]] : [];
    const images = selected.map((dataUrl) => ({ id: nanoid(), dataUrl }));
    if (!images.length) throw new Error(apiText("geminiNoImage"));
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveImageRequestConfig(config);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (runningHubOrigin(requestConfig.baseUrl)) {
        const workflowId = runningHubWorkflowId(config, config.model || config.imageModel, requestConfig, script);
        if (!workflowId) throw new Error(apiText("runningHubWorkflowFetchFailed", { model: requestConfig.model || "空" }));
        try {
            return await requestRunningHubImages({ ...requestConfig, model: workflowId }, withSystemPrompt(requestConfig, prompt), [], script, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (shouldUseNativeComfyUi(requestConfig.baseUrl, requestConfig.model, script) || parseComfyApiWorkflow(script)) {
        try {
            return await requestNativeComfyUiImages(requestConfig, withSystemPrompt(requestConfig, prompt), [], options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = isGptImageModel(requestConfig.model) ? resolveGptImageRequestSize(requestConfig.model, quality, config.size) : resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    // APIMart Nano-Banana-2-Lite is chat-only (maps to Gemini 3.1 Flash Lite Image); /images/generations
    // and /images/edits both reject it. Route to /chat/completions directly.
    if (isApimartBaseUrl(requestConfig.baseUrl) && isApimartNanoBananaLiteModel(requestConfig.model)) {
        try {
            return await requestApimartNanoBananaLite(requestConfig, prompt, [], options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    // ToAPIs GPT-Image-2.5 text-to-image uses the same async /images/generations task with
    // aspect-ratio size + metadata.resolution (base64 / pixel-size params are rejected).
    if (isToapisBaseUrl(requestConfig.baseUrl) && isToapisGptImage25Model(requestConfig.model)) {
        try {
            return await requestToapisGptImage25(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    // Midjourney relays (Seedance / APIMart): POST /v1/midjourney/generations
    if (isMidjourneyModel(requestConfig.model)) {
        try {
            return await requestMidjourneyGeneration(requestConfig, prompt, [], options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    // Seedance.nz image API is /v1/image/generations (singular), not OpenAI /images/generations.
    if (isSeedanceNzBaseUrl(requestConfig.baseUrl)) {
        try {
            return await requestSeedanceNzImage(requestConfig, prompt, [], options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    const imageParams = resolveOpenAiImageParams(requestConfig, n);
    try {
        const response = await postImageJson<ImageApiResponse>(
            requestConfig,
            "/images/generations",
            {
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, prompt),
                ...imageParams,
            },
            options,
        );
        const images = await resolveImageApiResponse(requestConfig, response.data, options);
        return images;
    } catch (error) {
        const message = readAxiosError(error, apiText("requestFailed"));
        // New API OpenAI image route often only accepts Imagen — retry Gemini models via generateContent.
        if (isGeminiNativeImageModel(requestConfig.model) && isImagenOnlyEndpointError(message)) {
            try {
                return await requestGeminiImages({ ...requestConfig, apiFormat: "gemini" }, prompt, [], n, options);
            } catch (fallbackError) {
                throw new Error(normalizeImageApiErrorMessage(readAxiosError(fallbackError, message), requestConfig.model));
            }
        }
        if (isImageEditsEndpointMissing(error, message)) {
            try {
                return await requestChatCompletionsImages(requestConfig, prompt, [], options);
            } catch (fallbackError) {
                const chatMessage = readAxiosError(fallbackError, message);
                throw new Error(normalizeImageApiErrorMessage(chatMessage === apiText("requestFailed") ? message : chatMessage, requestConfig.model));
            }
        }
        throw new Error(normalizeImageApiErrorMessage(message, requestConfig.model));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const requestConfig = resolveImageRequestConfig(config);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (runningHubOrigin(requestConfig.baseUrl)) {
        const workflowId = runningHubWorkflowId(config, config.model || config.imageModel, requestConfig, script);
        if (!workflowId) throw new Error(apiText("runningHubWorkflowFetchFailed", { model: requestConfig.model || "空" }));
        const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length))));
        try {
            return await requestRunningHubImages({ ...requestConfig, model: workflowId }, withSystemPrompt(requestConfig, requestPrompt), refs, script, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (shouldUseNativeComfyUi(requestConfig.baseUrl, requestConfig.model, script) || parseComfyApiWorkflow(script)) {
        const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length))));
        try {
            return await requestNativeComfyUiImages(requestConfig, withSystemPrompt(requestConfig, requestPrompt), refs, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = isGptImageModel(requestConfig.model) ? resolveGptImageRequestSize(requestConfig.model, quality, config.size) : resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        const refs = await Promise.all(references.map((image) => prepareReferenceDataUrl(image, Math.max(1, references.length))));
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        if (mask) throw new Error(apiText("geminiMaskUnsupported"));
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }

    // APIMart Nano-Banana-2-Lite is chat-only; references go in messages as image_url (base64 is
    // accepted) and the reply is raw base64 in content. Never touch /images/edits or /images/generations.
    if (isApimartBaseUrl(requestConfig.baseUrl) && isApimartNanoBananaLiteModel(requestConfig.model) && !mask) {
        try {
            return await requestApimartNanoBananaLite(requestConfig, requestPrompt, references, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }

    if (isMidjourneyModel(requestConfig.model)) {
        if (mask) throw new Error(apiText("geminiMaskUnsupported"));
        try {
            return await requestMidjourneyGeneration(requestConfig, requestPrompt, references, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }

    if (isSeedanceNzBaseUrl(requestConfig.baseUrl)) {
        if (mask) throw new Error(apiText("geminiMaskUnsupported"));
        // A -t2i model ignores reference images by design — fail fast with the i2i sibling name
        // instead of silently returning a generation that never looked at the user's image.
        if (references.length && isTextToImageOnlySeedanceModel(requestConfig.model)) {
            throw new Error(
                apiText("t2iModelIgnoresReferences", { model: requestConfig.model, suggestion: suggestImageToImageModelName(requestConfig.model) }),
            );
        }
        try {
            return await requestSeedanceNzImage(requestConfig, requestPrompt, references, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }

    // ToAPIs / similar relays: Gemini flash-image refs must be public URLs on /images/generations.
    // New API (hfsyapi etc.) often lacks /v1/uploads/images — fall back to multipart /images/edits,
    // then to native Gemini generateContent when the OpenAI image route only accepts Imagen.
    // APIMart GPT-Image-2.5 (flare/sunburst) rejects multipart /images/edits with 400 — refs go
    // as public `image_urls` on the async JSON /images/generations task instead.
    if (isApimartBaseUrl(requestConfig.baseUrl) && isApimartGptImage25Model(requestConfig.model) && !mask) {
        try {
            return await requestApimartGptImage(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    // ToAPIs GPT-Image-2.5: same async /images/generations task, but `image_urls` is an array of
    // { url } objects (not plain strings) and resolution lives in metadata — base64 is rejected.
    if (isToapisBaseUrl(requestConfig.baseUrl) && isToapisGptImage25Model(requestConfig.model) && !mask) {
        try {
            return await requestToapisGptImage25(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }
    if (usesImageUrlReferences(requestConfig.model) && references.length && !mask) {
        try {
            return await requestGeminiRelayImageToImage(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            const message = error instanceof Error ? error.message : apiText("requestFailed");
            if (isImagenOnlyEndpointError(message)) {
                try {
                    return await requestGeminiImages({ ...requestConfig, apiFormat: "gemini" }, requestPrompt, references, n, options);
                } catch (fallbackError) {
                    throw new Error(normalizeImageApiErrorMessage(readAxiosError(fallbackError, message), requestConfig.model));
                }
            }
            if (!isProviderUploadUnsupported(error)) {
                throw new Error(normalizeImageApiErrorMessage(message, requestConfig.model));
            }
        }
    }

    // hfsyapi seedream: img2img params are `reference_images` (public URLs) + size:"1K".
    // The generic Volcengine branch below would send base64 in `image`, which hfsyapi drops,
    // producing a random image that ignores the linked reference.
    if (usesHfsySeedreamImageApi(requestConfig) && !mask) {
        try {
            return await requestHfsySeedreamImage(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }

    // Volcengine Ark / Seedream image-to-image uses JSON /images/generations + `image`, not multipart /images/edits.
    if (usesVolcengineImageApi(requestConfig) && !mask) {
        try {
            return await requestVolcengineImageGeneration(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(normalizeImageApiErrorMessage(readAxiosError(error, apiText("requestFailed")), requestConfig.model));
        }
    }

    const imageParams = resolveOpenAiImageParams(requestConfig, n);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    for (const [key, value] of Object.entries(imageParams)) {
        if (value == null || typeof value === "object") continue;
        formData.set(key, String(value));
    }
    const refCount = Math.max(1, references.length + (mask ? 1 : 0));
    const files = await Promise.all(
        references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await prepareReferenceDataUrl(image, refCount) })),
    );
    // Multi-image edits follow OpenAI's official `image[]` convention — several strict
    // relays (APIMart etc.) answer 400 on repeated bare "image" keys.
    const imageField = files.length > 1 ? "image[]" : "image";
    files.forEach((file) => formData.append(imageField, file));
    if (mask) {
        const maskDataUrl = await prepareReferenceDataUrl(mask, refCount, { preserveAlpha: true });
        formData.set("mask", dataUrlToFile({ ...mask, dataUrl: maskDataUrl }));
    }

    try {
        const response = await postImageForm<ImageApiResponse>(requestConfig, "/images/edits", formData, options);
        const images = await resolveImageApiResponse(requestConfig, response.data, options);
        return images;
    } catch (error) {
        const message = readAxiosError(error, apiText("requestFailed"));
        if (isGeminiNativeImageModel(requestConfig.model) && isImagenOnlyEndpointError(message) && !mask) {
            try {
                return await requestGeminiImages({ ...requestConfig, apiFormat: "gemini" }, requestPrompt, references, n, options);
            } catch (fallbackError) {
                throw new Error(normalizeImageApiErrorMessage(readAxiosError(fallbackError, message), requestConfig.model));
            }
        }
        // Relays without /images/edits (e.g. some New API hosts): retry img2img via /images/generations + image[],
        // then /chat/completions when the Images API itself is not registered.
        if (!mask && references.length && isImageEditsEndpointMissing(error, message)) {
            // APIMart silently ignores the `image` field on /images/generations — the user pays
            // for a reference-free generation. Its gpt-image models accept refs on the chat
            // endpoint (image_url), so fall back there directly.
            if (isApimartBaseUrl(requestConfig.baseUrl)) {
                try {
                    return await requestChatCompletionsImages(requestConfig, requestPrompt, references, options);
                } catch (chatError) {
                    const chatMessage = readAxiosError(chatError, message);
                    throw new Error(normalizeImageApiErrorMessage(chatMessage === apiText("requestFailed") ? message : chatMessage, requestConfig.model));
                }
            }
            try {
                return await requestOpenAiCompatImageToImageViaGenerations(requestConfig, requestPrompt, references, n, options);
            } catch (fallbackError) {
                const fallbackMessage = readAxiosError(fallbackError, message);
                if (isImageEditsEndpointMissing(fallbackError, fallbackMessage)) {
                    try {
                        return await requestChatCompletionsImages(requestConfig, requestPrompt, references, options);
                    } catch (chatError) {
                        const chatMessage = readAxiosError(chatError, fallbackMessage);
                        throw new Error(normalizeImageApiErrorMessage(chatMessage === apiText("requestFailed") ? fallbackMessage : chatMessage, requestConfig.model));
                    }
                }
                throw new Error(normalizeImageApiErrorMessage(fallbackMessage, requestConfig.model));
            }
        }
        throw new Error(normalizeImageApiErrorMessage(message, requestConfig.model));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: ChatRequestOptions) {
    if (options?.tools?.length && options.executeTool) {
        return requestChatWithTools(config, messages, onDelta, options);
    }
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || apiText("noContent");
            if (text === apiText("noContent")) onDelta(text);
            return text;
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    try {
        const result = await requestChatTurn(requestConfig, withSystemMessage(requestConfig, messages), onDelta, options);
        const answer = result.content || apiText("noContent");
        if (answer === apiText("noContent")) onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

/** Multi-round chat with function tools (skills). */
export async function requestChatWithTools(
    config: AiConfig,
    messages: AiTextMessage[],
    onDelta: (text: string) => void,
    options: ChatRequestOptions,
): Promise<string> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const tools = options.tools || [];
    const executeTool = options.executeTool;
    if (!tools.length || !executeTool) {
        return requestImageQuestion(config, messages, onDelta, { signal: options.signal });
    }

    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        // Custom model scripts do not participate in the native tool loop.
        return requestImageQuestion(config, messages, onDelta, { signal: options.signal });
    }

    let turnMessages: ResponseInputMessage[] = withSystemMessage(requestConfig, messages);
    const maxRounds = Math.max(1, Math.min(8, options.maxToolRounds ?? 6));
    let lastText = "";

    for (let round = 0; round < maxRounds; round += 1) {
        const result = await requestChatTurn(requestConfig, turnMessages, onDelta, {
            signal: options.signal,
            tools,
            toolChoice: options.toolChoice || "auto",
        });
        lastText = result.content || lastText;
        if (!result.toolCalls.length) {
            const answer = lastText || apiText("noContent");
            if (answer === apiText("noContent")) onDelta(answer);
            return answer;
        }

        for (const call of result.toolCalls) {
            options.onToolStart?.(call.function.name, call.id);
            turnMessages = [
                ...turnMessages,
                {
                    type: "function_call",
                    call_id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments || "{}",
                    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
                },
            ];
            let output = "";
            try {
                const args = jsonObject(call.function.arguments || "{}");
                output = await executeTool(call.function.name, args);
            } catch (error) {
                output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
            }
            options.onToolEnd?.(call.function.name, call.id, output);
            turnMessages = [...turnMessages, { role: "tool", tool_call_id: call.id, content: output }];
        }
        // Clear streamed assistant text before the follow-up turn so tool-round prose does not stick.
        onDelta(lastText ? `${lastText}\n\n` : "");
    }

    const answer = lastText || apiText("noContent");
    if (answer === apiText("noContent")) onDelta(answer);
    return answer;
}

async function requestChatTurn(
    config: AiConfig,
    messages: ResponseInputMessage[],
    onDelta: (text: string) => void,
    options?: ChatRequestOptions,
): Promise<ToolResponseResult> {
    const tools = options?.tools || [];
    const toolChoice = options?.toolChoice || "auto";
    const toolPayload =
        tools.length > 0
            ? {
                  tools: tools.map(toResponseTool),
                  tool_choice: toolChoice,
              }
            : {};

    if (config.apiFormat === "gemini") {
        return requestGeminiStreamingResponse(
            config,
            await toGeminiBody(config, messages, toGeminiToolOptions(tools, toolChoice)),
            onDelta,
            options,
        );
    }

    const preferChatCompletions = isVolcengineArkBaseUrl(config.baseUrl);
    if (preferChatCompletions) {
        try {
            return await requestChatCompletionsTurn(config, messages, onDelta, options);
        } catch (chatError) {
            if (!tools.length) {
                try {
                    return await requestStreamingResponse(
                        config,
                        {
                            model: config.model,
                            input: toResponseInput(messages),
                            ...(config.reasoningEffort === "auto" ? {} : { reasoning: { effort: config.reasoningEffort } }),
                            ...toolPayload,
                        },
                        onDelta,
                        options,
                    );
                } catch {
                    throw chatError;
                }
            }
            throw chatError;
        }
    }

    try {
        return await requestStreamingResponse(
            config,
            {
                model: config.model,
                input: toResponseInput(messages),
                ...(config.reasoningEffort === "auto" ? {} : { reasoning: { effort: config.reasoningEffort } }),
                ...toolPayload,
            },
            onDelta,
            options,
        );
    } catch (responsesError) {
        if (!shouldFallbackToChatCompletions(responsesError)) throw responsesError;
        return requestChatCompletionsTurn(config, messages, onDelta, options);
    }
}

async function requestChatCompletionsTurn(
    config: AiConfig,
    messages: ResponseInputMessage[],
    onDelta: (text: string) => void,
    options?: ChatRequestOptions,
): Promise<ToolResponseResult> {
    const tools = options?.tools || [];
    const toolChoice = options?.toolChoice || "auto";
    const chatTools = tools.map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
        },
    }));

    // Tool rounds are more reliable non-streaming on many CN relays.
    if (tools.length) {
        const response = await fetch(aiApiUrl(config, "/chat/completions"), {
            method: "POST",
            headers: aiHeaders(config, "application/json"),
            body: JSON.stringify({
                model: config.model,
                messages: toChatCompletionMessages(messages),
                tools: chatTools,
                tool_choice: toolChoice,
                stream: false,
            }),
            signal: options?.signal,
        });
        if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
        const payload = (await response.json()) as Record<string, unknown>;
        const message = readChatCompletionMessage(payload);
        const content = typeof message?.content === "string" ? message.content : "";
        if (content) onDelta(content);
        const toolCalls = readChatCompletionToolCalls(message);
        return { content, toolCalls };
    }

    return requestStreamingChatCompletions(config, messages, onDelta, options);
}

function readChatCompletionMessage(payload: Record<string, unknown>) {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : null;
    return first && typeof first.message === "object" && first.message ? (first.message as Record<string, unknown>) : null;
}

function readChatCompletionToolCalls(message: Record<string, unknown> | null): ResponseToolCall[] {
    if (!message || !Array.isArray(message.tool_calls)) return [];
    return message.tool_calls
        .map((item) => {
            if (!item || typeof item !== "object") return null;
            const record = item as Record<string, unknown>;
            const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
            const id = typeof record.id === "string" ? record.id : "";
            const name = typeof fn?.name === "string" ? fn.name : "";
            const args = typeof fn?.arguments === "string" ? fn.arguments : "{}";
            if (!id || !name) return null;
            return { id, type: "function" as const, function: { name, arguments: args } };
        })
        .filter((item): item is ResponseToolCall => Boolean(item));
}

function shouldFallbackToChatCompletions(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /404|not\s*found|接口地址不存在|unsupported|not\s*support|unknown\s*url|invalid\s*url|responses?/i.test(message);
}

async function requestStreamingChatCompletions(config: AiConfig, messages: ResponseInputMessage[], onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify(
            await compressBodyImagesForProxy({
                model: config.model,
                messages: toChatCompletionMessages(messages),
                stream: true,
            }),
        ),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as Record<string, unknown>;
        const content = readChatCompletionContent(payload);
        if (content) onDelta?.(content);
        return { content, toolCalls: [] };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
            const match = buffer.match(/\r?\n/);
            if (!match) break;
            const index = match.index ?? 0;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + match[0].length);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
                const payload = JSON.parse(data) as Record<string, unknown>;
                const delta = readChatCompletionDelta(payload);
                if (!delta) continue;
                text += delta;
                onDelta?.(text);
            } catch {
                // ignore malformed SSE chunks
            }
        }
    }
    return { content: text, toolCalls: [] };
}

function toChatCompletionMessages(messages: ResponseInputMessage[]) {
    const result: Array<{ role: string; content: ResponseMessageContent | null; tool_call_id?: string; tool_calls?: unknown[] }> = [];
    let pendingCalls: Array<{ type: "function_call"; call_id: string; name: string; arguments: string }> = [];

    const flushCalls = () => {
        if (!pendingCalls.length) return;
        result.push({
            role: "assistant",
            content: null,
            tool_calls: pendingCalls.map((call) => ({
                id: call.call_id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
            })),
        });
        pendingCalls = [];
    };

    for (const message of messages) {
        if ("type" in message) {
            pendingCalls.push(message);
            continue;
        }
        flushCalls();
        if (message.role === "tool") {
            result.push({ role: "tool", tool_call_id: message.tool_call_id, content: message.content });
            continue;
        }
        result.push({ role: message.role, content: message.content || "" });
    }
    flushCalls();
    return result;
}

function readChatCompletionContent(payload: Record<string, unknown>) {
    const message = readChatCompletionMessage(payload);
    return typeof message?.content === "string" ? message.content : "";
}

function readChatCompletionDelta(payload: Record<string, unknown>) {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : null;
    const delta = first && typeof first.delta === "object" && first.delta ? (first.delta as Record<string, unknown>) : null;
    return typeof delta?.content === "string" ? delta.content : "";
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (isVolcenginePlanBaseUrl(config.baseUrl)) {
            return [...VOLCENGINE_PLAN_MODELS];
        }
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(proxyApiUrl(buildApiUrl(config.baseUrl, "/models")), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

function isVolcenginePlanBaseUrl(baseUrl: string) {
    return /volces\.com\/api\/(plan|coding)\/v\d+/i.test(baseUrl.trim());
}

const VOLCENGINE_PLAN_MODELS = [
    "doubao-seed-2.1-turbo",
    "doubao-seed-2.0-pro",
    "doubao-seed-2.0-lite",
    "doubao-seed-2.0-code",
    "ark-code-latest",
    "doubao-seedream-5.0-lite",
    "doubao-seedream-5.0-pro",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "kimi-k2.6",
    "glm-5.2",
    "minimax-m2.7",
];

export async function fetchChannelModels(channel: ModelChannel) {
    return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
