import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { defaultTextPrompts, normalizeTextPrompts, type TextPromptEntry } from "@/constant/text-prompt-library";
import { normalizeSunoVersionValue } from "@/lib/audio-generation";
import { isNativeComfyUiBaseUrl, parseComfyApiWorkflow } from "@/lib/comfyui-native";

export type { TextPromptEntry };

export type ApiCallFormat = "openai" | "gemini";
export type ApiTransport = "direct" | "proxy";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    /** Per-model protocol; falls back to the channel default when omitted. */
    apiFormat?: ApiCallFormat;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type ImageQuickToolsPreference = {
    ids: string[];
    showLabels: boolean;
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    sunoVersion: string;
    sunoCustom: string;
    sunoInstrumental: string;
    sunoTitle: string;
    sunoStyle: string;
    sunoVocalGender: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    /** direct = browser→API (no Vercel 60s cap); proxy = via /api/proxy for CORS. */
    apiTransport: ApiTransport;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    textPrompts: TextPromptEntry[];
    /** Image node quick-toolbar visibility + order (also used by image context menu). */
    imageQuickTools: ImageQuickToolsPreference;
    /** Canvas blank create-menu button order. */
    nodeCreateMenuOrder: string[];
    /** Image node right-click menu button order. */
    imageContextMenuOrder: string[];
};

export type ConfigTabKey = "channels" | "preferences" | "backup";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    sunoVersion: "v6",
    sunoCustom: "false",
    sunoInstrumental: "false",
    sunoTitle: "",
    sunoStyle: "",
    sunoVocalGender: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    // Default via same-origin proxy — most relay APIs block browser CORS.
    apiTransport: "proxy",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "medium",
    size: "2048x1152",
    background: "",
    count: "1",
    canvasImageCount: "1",
    textPrompts: defaultTextPrompts.map((item) => ({ ...item })),
    imageQuickTools: { ids: [], showLabels: false },
    nodeCreateMenuOrder: [],
    imageContextMenuOrder: [],
};

type ConfigStore = {
    config: AiConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo", "upscaler", "minimax", "h3", "lightx2v", "comfy"];
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound", "suno"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}

/** Preferred chat/text model when present in any channel (e.g. deepseek-flash). */
const PREFERRED_TEXT_MODEL_NAMES = ["deepseek-flash"];
const LEGACY_IMAGE_QUICK_TOOLS_KEY = "canvas-image-quick-tools-v10";

function readLegacyStringArray(storageKey: string): string[] {
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    } catch {
        return [];
    }
}

function readLegacyImageQuickTools(): ImageQuickToolsPreference {
    try {
        const raw = window.localStorage.getItem(LEGACY_IMAGE_QUICK_TOOLS_KEY);
        if (!raw) return { ids: [], showLabels: false };
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return { ids: parsed.filter((item): item is string => typeof item === "string"), showLabels: false };
        if (!parsed || typeof parsed !== "object") return { ids: [], showLabels: false };
        const data = parsed as Partial<ImageQuickToolsPreference>;
        return {
            ids: Array.isArray(data.ids) ? data.ids.filter((item): item is string => typeof item === "string") : [],
            showLabels: data.showLabels === true,
        };
    } catch {
        return { ids: [], showLabels: false };
    }
}

function normalizeStringIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || !item.trim() || seen.has(item)) continue;
        seen.add(item);
        result.push(item);
    }
    return result;
}

function normalizeImageQuickToolsPreference(value: unknown): ImageQuickToolsPreference {
    if (!value || typeof value !== "object") return { ids: [], showLabels: false };
    const data = value as Partial<ImageQuickToolsPreference>;
    return {
        ids: normalizeStringIdList(data.ids),
        showLabels: data.showLabels === true,
    };
}

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

export function findPreferredModelOption(channels: ModelChannel[], capability: ModelCapability, preferredNames: string[]) {
    for (const preferred of preferredNames) {
        for (const channel of channels) {
            const model = channel.models.find((item) => item.name === preferred && item.capability === capability);
            if (model) return encodeChannelModel(channel.id, model.name);
        }
    }
    return "";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    const selectable = selectableModelsByCapability(config, capability);
    if (currentModel && (selectable.includes(currentModel) || modelMatchesCapability(config, currentModel, capability))) return currentModel;
    if (defaultModel && (selectable.includes(defaultModel) || modelMatchesCapability(config, defaultModel, capability))) return defaultModel;
    if (capability === "text") {
        const preferred = findPreferredModelOption(config.channels, "text", PREFERRED_TEXT_MODEL_NAMES);
        if (preferred) return preferred;
    }
    return selectable[0] || fallbackModel;
}

function resolvePersistedTextModel(config: Partial<AiConfig>, channels: ModelChannel[]) {
    const preferred = findPreferredModelOption(channels, "text", PREFERRED_TEXT_MODEL_NAMES);
    const current = normalizeModelOptionValue(config.textModel || config.model, channels);
    if (preferred && (!current || modelOptionName(current) === "gpt-5.5")) return preferred;
    return current || preferred || "";
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    if (!model.trim() || !channel.baseUrl.trim()) return false;
    // Native ComfyUI often has no auth token (or key embedded in RunningHub proxy URL).
    const script = channel.models.find((item) => item.name === modelOptionName(model))?.script || "";
    if (isNativeComfyUiBaseUrl(channel.baseUrl) || parseComfyApiWorkflow(script)) return true;
    return Boolean(channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            version: 5,
            partialize: (state) => ({ config: state.config }),
            migrate: (persisted, version) => {
                const state = (persisted || {}) as Partial<ConfigStore> & { config?: Partial<AiConfig> };
                // v1 briefly defaulted apiTransport to "direct", which broke CORS for most relays.
                if (version < 2 && state.config) {
                    state.config = { ...state.config, apiTransport: "proxy" };
                }
                // v3: prefer deepseek-flash as the default chat/text model when available.
                if (version < 3 && state.config) {
                    state.config = { ...state.config, textModel: "" };
                }
                // v4: seed text-node prompt library defaults when missing.
                if (version < 4 && state.config && !Array.isArray(state.config.textPrompts)) {
                    state.config = { ...state.config, textPrompts: defaultTextPrompts.map((item) => ({ ...item })) };
                }
                // v5: fold canvas menu / quick-tool order into exportable config (migrate from localStorage).
                if (version < 5 && state.config) {
                    state.config = {
                        ...state.config,
                        imageQuickTools: state.config.imageQuickTools || readLegacyImageQuickTools(),
                        nodeCreateMenuOrder: Array.isArray(state.config.nodeCreateMenuOrder) ? state.config.nodeCreateMenuOrder : readLegacyStringArray("canvas-node-create-menu-order-v1"),
                        imageContextMenuOrder: Array.isArray(state.config.imageContextMenuOrder) ? state.config.imageContextMenuOrder : readLegacyStringArray("canvas-image-context-menu-order-v1"),
                    };
                }
                return state as ConfigStore;
            },
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) config.channels = [];
                const channels = normalizeChannels(config);
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                        videoModel: normalizeModelOptionValue(config.videoModel, channels),
                        textModel: resolvePersistedTextModel(config, channels),
                        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        sunoVersion: normalizeSunoVersionValue(config.sunoVersion || defaultConfig.sunoVersion),
                        sunoCustom: config.sunoCustom || defaultConfig.sunoCustom,
                        sunoInstrumental: config.sunoInstrumental || defaultConfig.sunoInstrumental,
                        sunoTitle: config.sunoTitle || "",
                        sunoStyle: config.sunoStyle || "",
                        sunoVocalGender: config.sunoVocalGender || "",
                        reasoningEffort: config.reasoningEffort || "auto",
                        apiTransport: config.apiTransport === "direct" ? "direct" : "proxy",
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        canvasImageCount: config.canvasImageCount || "1",
                        quality: config.quality || "medium",
                        size: config.size || "2048x1152",
                        textPrompts: normalizeTextPrompts(config.textPrompts),
                        imageQuickTools: (() => {
                            const normalized = normalizeImageQuickToolsPreference(config.imageQuickTools);
                            return normalized.ids.length ? normalized : readLegacyImageQuickTools();
                        })(),
                        nodeCreateMenuOrder: (() => {
                            const normalized = normalizeStringIdList(config.nodeCreateMenuOrder);
                            return normalized.length ? normalized : readLegacyStringArray("canvas-node-create-menu-order-v1");
                        })(),
                        imageContextMenuOrder: (() => {
                            const normalized = normalizeStringIdList(config.imageContextMenuOrder);
                            return normalized.length ? normalized : readLegacyStringArray("canvas-image-context-menu-order-v1");
                        })(),
                    },
                };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        const apiFormat = typeof item === "string" || item.apiFormat == null ? undefined : normalizeApiFormat(item.apiFormat);
        result.push(apiFormat ? { name, capability, apiFormat, script } : { name, capability, script });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: normalizeProviderBaseUrl(channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat)),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    const modelName = modelOptionName(value || config.model);
    const model = channel.models.find((item) => item.name === modelName);
    return {
        ...config,
        model: modelName,
        baseUrl: normalizeProviderBaseUrl(channel.baseUrl),
        apiKey: sanitizeApiKey(channel.apiKey),
        apiFormat: resolveChannelModelApiFormat(channel, model),
    };
}

/** Effective protocol for a channel model: model override, else channel default. */
export function resolveChannelModelApiFormat(channel: Pick<ModelChannel, "apiFormat">, model?: Pick<ChannelModel, "apiFormat"> | null): ApiCallFormat {
    return model?.apiFormat ? normalizeApiFormat(model.apiFormat) : normalizeApiFormat(channel.apiFormat);
}

export function channelProtocolSummary(channel: ModelChannel): ApiCallFormat | "mixed" {
    const formats = new Set(channel.models.map((model) => resolveChannelModelApiFormat(channel, model)));
    if (formats.size > 1) return "mixed";
    return formats.values().next().value || channel.apiFormat;
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

export function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function sanitizeApiKey(apiKey: string) {
    return apiKey.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
}

export function normalizeProviderBaseUrl(baseUrl: string) {
    let value = baseUrl.trim().replace(/\/+$/, "");
    if (!value) return value;
    // Users often paste a full endpoint; strip back to the API root.
    value = value.replace(/\/(chat\/completions|responses|images\/generations|images\/edits|audio\/speech|models)(\/.*)?$/i, "");
    value = value.replace(/\/+$/, "");
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const isArkHost = /^ark\.[a-z0-9-]+\.(volces|bytepluses)\.com$/i.test(host);
        if (isArkHost) {
            const path = parsed.pathname.replace(/\/+$/, "") || "/";
            if (path === "/") return `${parsed.origin}/api/plan/v3`;
            if (/^\/api\/plan$/i.test(path)) return `${parsed.origin}/api/plan/v3`;
            if (/^\/api\/coding$/i.test(path)) return `${parsed.origin}/api/coding/v3`;
            if (/^\/api$/i.test(path)) return `${parsed.origin}/api/v3`;
            // Drop a mistaken trailing /v1 on versioned Ark roots.
            if (/^\/api\/(plan|coding)\/v\d+\/v1$/i.test(path) || /^\/api\/v\d+\/v1$/i.test(path)) {
                return `${parsed.origin}${path.replace(/\/v1$/i, "")}`;
            }
        }
    } catch {
        // keep original when not a valid absolute URL
    }
    return value;
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    // Keep provider versioned roots as-is (OpenAI /v1, Gemini /v1beta, Volcengine Ark /api/v3|/api/plan/v3|/api/coding/v3, etc.).
    const hasVersionSuffix =
        /\/(v\d+[a-z0-9._-]*)$/i.test(lowerBaseUrl) ||
        /\/api\/v\d+[a-z0-9._-]*$/i.test(lowerBaseUrl) ||
        /\/api\/(plan|coding)\/v\d+[a-z0-9._-]*$/i.test(lowerBaseUrl);
    const apiBaseUrl = hasVersionSuffix ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${apiBaseUrl}${normalizedPath}`;
}
