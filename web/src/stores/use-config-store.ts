import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { defaultTextPrompts, h3PromptOptimizerEntry, normalizeTextPrompts, type TextPromptEntry } from "@/constant/text-prompt-library";
import { normalizeSunoVersionValue } from "@/lib/audio-generation";
import { isNativeComfyUiBaseUrl, parseComfyApiWorkflow } from "@/lib/comfyui-native";
import { isMioraQueueBaseUrl } from "@/lib/miora-queue";

export type { TextPromptEntry };

export type ApiCallFormat = "openai" | "gemini";
export type ApiTransport = "direct" | "proxy";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    /** Name shown on the canvas. Empty means the external model name. Never sent as the API model. */
    canvasName?: string;
    capability: ModelCapability;
    /** Per-model protocol; falls back to the channel default when omitted. */
    apiFormat?: ApiCallFormat;
    script?: string;
    /** When false the model stays in the channel but is hidden from pickers. Defaults to true. */
    enabled?: boolean;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
    /** When false the whole channel is hidden from model pickers. Defaults to true. */
    enabled?: boolean;
    /**
     * Per-channel API transport. When omitted, the global Preferences `apiTransport` applies.
     * Use `direct` for rented ComfyUI / seetacloud hosts that expose CORS so uploads skip the
     * Cloudflare Pages edge (HTTP 522 on :8443).
     */
    apiTransport?: ApiTransport;
    /**
     * Additional API keys for the same provider. When a key hits a "balance exhausted"
     * error the request automatically retries with the next key. `apiKey` is kept equal to
     * `apiKeys[0]` for backward compatibility with every `config.apiKey` reader downstream.
     */
    apiKeys?: string[];
};

export type ImageQuickToolsPreference = {
    ids: string[];
    showLabels: boolean;
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    /** Ordered backup keys for the active channel (random pick per call; auto-switch when a key is refused). */
    apiKeys?: string[];
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
    /** Megapixels for workflows exposing a ResolutionSelector (MiniMax H3 story); empty = workflow default. */
    videoResolution: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    /** ComfyUI video sampling steps (BasicScheduler.steps). */
    videoSteps: string;
    /** MiniMax H3 reference image sizing (match / max). */
    videoRefImageSize: string;
    /** ComfyUI sampler name (KSamplerSelect.sampler_name). */
    videoSamplerName: string;
    /** ComfyUI scheduler (BasicScheduler.scheduler). */
    videoScheduler: string;
    /** U30/U35 seed mode: `random` per run, or `fixed` with `videoSeed`. */
    videoSeedMode: string;
    /** Fixed seed when `videoSeedMode` is `fixed` (default matches U24 V927 authored seed). */
    videoSeed: string;
    /**
     * DualClock (H3-video / u24_v927) when canvas audio is connected:
     * DualClock: `lock_source` (default) or `reference_only`.
     */
    videoAudioMode: string;
    /**
     * Work-Fisher RH pipeline mode: `video` | `character` | `scene` | `multiview`.
     * Only honored for the Fisher workflow id pair.
     */
    videoFisherMode: string;
    /**
     * MJ 风格工作流 V2.0 LoRA 味型：`strong` | `standard` | `light` | `off`.
     * Only the 2112477095216926722 / 2112477039575003138 id pair reads it (it scales the two
     * MJ LoRAs); every other model ignores the field.
     */
    mjFlavor: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    /** direct = browser→API (no Vercel 60s cap); proxy = via /api/proxy for CORS. */
    apiTransport: ApiTransport;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    /** Midjourney Imagine version: 8.2 / 8.1 / 7 / 6.1 / 5.2 / 5.1 / niji7 / niji6. */
    mjVersion: string;
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

/** Local WorkBuddy ImageGen / VideoGen via Vite /api/miora file queue (no API key). */
export const WORKBUDDY_CHANNEL_ID = "workbuddy";

export function createWorkbuddyChannel(): ModelChannel {
    return {
        id: WORKBUDDY_CHANNEL_ID,
        name: "WorkBuddy",
        baseUrl: "/api/miora",
        apiKey: "",
        apiFormat: "openai",
        apiTransport: "direct",
        models: [
            { name: "ImageGen", canvasName: "WorkBuddy 生图", capability: "image" },
            { name: "VideoGen", canvasName: "WorkBuddy 生视频", capability: "video" },
        ],
    };
}

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
        createWorkbuddyChannel(),
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
    videoResolution: "",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoSteps: "40",
    videoRefImageSize: "max",
    videoSamplerName: "dpmpp_2m",
    videoScheduler: "karras",
    videoSeedMode: "fixed",
    videoSeed: "19960422",
    videoAudioMode: "lock_source",
    videoFisherMode: "video",
    mjFlavor: "standard",
    systemPrompt: "",
    reasoningEffort: "auto",
    // Default via same-origin proxy — most relay APIs block browser CORS.
    apiTransport: "proxy",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "medium",
    size: "2048x1152",
    background: "",
    count: "1",
    mjVersion: "8.1",
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

export function isChannelModelEnabled(model: Pick<ChannelModel, "enabled">) {
    return model.enabled !== false;
}

export function isChannelEnabled(channel: Pick<ModelChannel, "enabled">) {
    return channel.enabled !== false;
}

export function findPreferredModelOption(channels: ModelChannel[], capability: ModelCapability, preferredNames: string[]) {
    for (const preferred of preferredNames) {
        for (const channel of channels) {
            if (!isChannelEnabled(channel)) continue;
            const model = channel.models.find((item) => item.name === preferred && item.capability === capability && isChannelModelEnabled(item));
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
    if (currentModel && selectable.includes(currentModel)) return currentModel;
    if (defaultModel && selectable.includes(defaultModel)) return defaultModel;
    if (capability === "text") {
        const preferred = findPreferredModelOption(config.channels, "text", PREFERRED_TEXT_MODEL_NAMES);
        if (preferred && selectable.includes(preferred)) return preferred;
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
    return config.channels.flatMap((channel) => {
        if (!isChannelEnabled(channel)) return [];
        return channel.models
            .filter((model) => isChannelModelEnabled(model) && (!capability || model.capability === capability))
            .map((model) => encodeChannelModel(channel.id, model.name));
    });
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
    // WorkBuddy local queue uses built-in ImageGen / VideoGen — no API key.
    if (isMioraQueueBaseUrl(channel.baseUrl)) return true;
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
            version: 8,
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
                // v6: Midjourney default version moved from 6.1 to 8.1. Keep any other explicit choice.
                if (version < 6 && state.config && (!state.config.mjVersion || state.config.mjVersion === "6.1")) {
                    state.config = { ...state.config, mjVersion: "8.1" };
                }
                // v7: seed the H3 prompt-optimizer entry into an existing text-node prompt library.
                if (version < 7 && state.config && Array.isArray(state.config.textPrompts) && !state.config.textPrompts.some((item) => item?.id === h3PromptOptimizerEntry.id || item?.title?.trim() === h3PromptOptimizerEntry.title)) {
                    state.config = { ...state.config, textPrompts: [...state.config.textPrompts, { ...h3PromptOptimizerEntry }] };
                }
                // v8: inject WorkBuddy local ImageGen / VideoGen channel when missing.
                if (version < 8 && state.config) {
                    const channels = Array.isArray(state.config.channels) ? [...state.config.channels] : [];
                    const hasWorkbuddy = channels.some(
                        (channel) =>
                            channel?.id === WORKBUDDY_CHANNEL_ID ||
                            isMioraQueueBaseUrl(String(channel?.baseUrl || "")),
                    );
                    if (!hasWorkbuddy) channels.push(createWorkbuddyChannel());
                    state.config = { ...state.config, channels };
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
                        videoResolution: config.videoResolution || "",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        videoSteps: config.videoSteps || defaultConfig.videoSteps,
                        videoRefImageSize: config.videoRefImageSize || defaultConfig.videoRefImageSize,
                        videoSamplerName: config.videoSamplerName || defaultConfig.videoSamplerName,
                        videoScheduler: config.videoScheduler || defaultConfig.videoScheduler,
                        videoSeedMode:
                            config.videoSeedMode === "random"
                                ? "random"
                                : /^(fixedb|fixed_b|fixed-b)$/i.test(String(config.videoSeedMode || ""))
                                  ? "fixedB"
                                  : "fixed",
                        videoSeed: config.videoSeed || defaultConfig.videoSeed,
                        videoAudioMode: /^(reference_only|reference|timbre)$/i.test(String(config.videoAudioMode || ""))
                            ? "reference_only"
                            : "lock_source",
                        videoFisherMode: /^(character|scene|multiview|video)$/i.test(String(config.videoFisherMode || ""))
                            ? String(config.videoFisherMode).toLowerCase()
                            : "video",
                        mjFlavor: /^(strong|standard|light|off)$/i.test(String(config.mjFlavor || ""))
                            ? String(config.mjFlavor).toLowerCase()
                            : "standard",
                        canvasImageCount: config.canvasImageCount || "1",
                        mjVersion: config.mjVersion || defaultConfig.mjVersion,
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
        const canvasName = typeof item === "string" ? undefined : item.canvasName?.trim() || undefined;
        const apiFormat = typeof item === "string" || item.apiFormat == null ? undefined : normalizeApiFormat(item.apiFormat);
        const enabled = typeof item === "string" || item.enabled == null ? undefined : Boolean(item.enabled);
        const entry: ChannelModel = { name, capability, script };
        if (canvasName && canvasName !== name) entry.canvasName = canvasName;
        if (apiFormat) entry.apiFormat = apiFormat;
        if (enabled === false) entry.enabled = false;
        result.push(entry);
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const next: ModelChannel = {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: normalizeProviderBaseUrl(channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat)),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
    };
    if (channel?.enabled === false) next.enabled = false;
    if (channel?.apiTransport === "direct" || channel?.apiTransport === "proxy") next.apiTransport = channel.apiTransport;
    const extraKeys = Array.isArray(channel?.apiKeys) ? channel.apiKeys.map((key) => sanitizeApiKey(key)).filter(Boolean) : [];
    if (extraKeys.length) next.apiKeys = Array.from(new Set(extraKeys));
    return next;
}

/** Effective transport for a channel: channel override, else global Preferences default. */
export function resolveChannelApiTransport(
    channel?: Pick<ModelChannel, "apiTransport"> | null,
    globalTransport?: ApiTransport | null,
): ApiTransport {
    if (channel?.apiTransport === "direct" || channel?.apiTransport === "proxy") return channel.apiTransport;
    return globalTransport === "direct" ? "direct" : "proxy";
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

export function channelModelEntry(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (decoded) return config.channels.find((item) => item.id === decoded.channelId)?.models.find((item) => item.name === decoded.model);
    return config.channels.flatMap((channel) => channel.models).find((item) => item.name === value);
}

export function modelCanvasName(entry: Pick<ChannelModel, "name" | "canvasName"> | undefined, fallback: string) {
    return entry?.canvasName?.trim() || fallback;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const raw = decoded?.model || value;
    const shown = modelCanvasName(channelModelEntry(config, value), raw);
    if (!decoded) return shown;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${shown}（${channel.name}）` : shown;
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
        apiKeys: channelApiKeys(channel),
        apiFormat: resolveChannelModelApiFormat(channel, model),
        apiTransport: resolveChannelApiTransport(channel, config.apiTransport),
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

/**
 * Split a multi-line API-key string into a de-duplicated list of cleaned keys.
 * A single input line of "key1, key2" is also treated as two keys. Keeps the first
 * non-empty key as the primary (backward-compatible) `apiKey`.
 */
export function parseApiKeys(raw: string): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const line of String(raw || "").split(/[\n\r,，]+/)) {
        const key = sanitizeApiKey(line);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys;
}

/** The full ordered key list for a channel (primary `apiKey` first, then any `apiKeys`). */
export function channelApiKeys(channel: Pick<ModelChannel, "apiKey" | "apiKeys">): string[] {
    const primary = sanitizeApiKey(channel.apiKey || "");
    const extras = (channel.apiKeys || []).map((key) => sanitizeApiKey(key)).filter(Boolean);
    const merged = [primary, ...extras].filter(Boolean);
    return Array.from(new Set(merged));
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
