import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import {
    autodlH3DurationMax,
    autodlH3DurationOptions,
    autodlH3ResolutionDisplay,
    autodlH3ResolutionLabel,
    autodlH3ResolutionOptions,
    isAutodlH3ComfyVideoModel,
    normalizeAutodlH3Duration,
    normalizeAutodlH3Resolution,
} from "@/lib/autodl-h3-comfy";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { normalizeSubtitleCropMode } from "@/lib/video-subtitle-crop";
import { resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import {
    FISHER_LORA_STRENGTH_OPTIONS,
    isMinimaxH3FisherWorkflowId,
    isMinimaxH3HdDynamicWorkflowId,
    isMinimaxH3SingularityWorkflowId,
    isMinimaxH3WenxiLowWorkflowId,
    isMinimaxH3WenxiWorkflowId,
    isMinimaxH3YzjinyuWorkflowId,
    isWorkFisherLightAiAppId,
    isMinimaxH3SingularityLightAiAppId,
    normalizeRunningHubInstanceType,
    type RunningHubInstanceType,
    normalizeFisherLoraStrength,
    normalizeFisherPipelineMode,
    type FisherPipelineMode,
} from "@/lib/runninghub-workflow";
import { isRelayMiniMaxH3Video } from "@/services/api/video";
import {
    COMFY_H3_STABLE_SEED,
    COMFY_H3_STABLE_SEED_B,
    isComfyH3MultiReferenceVideoWorkflow,
    isComfyH3ResolutionSelectorVideoWorkflow,
    isComfyH3SelfLiftWorkflow,
    isComfyH3SingularityUpscaleWorkflow,
    isComfyH3TwoPassReferenceWorkflow,
    normalizeComfyH3AudioMode,
    parseComfyApiWorkflow,
    shouldUseNativeComfyUi,
} from "@/lib/comfyui-native";

const resolutionOptions = [
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
];

/** MiniMax-H3 OpenAI relays (wb2api / miora-minimax-h3…): 768P vs 2K delivery tiers. */
const relayH3ResolutionOptions = [
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
    { value: "2k", label: "2K" },
];

/** U24 / H3-video two-pass: 900p mid tier between 720 and full 1080 (VRAM-friendly). */
const twoPassResolutionOptions = [
    { value: "720", label: "720p" },
    { value: "900", label: "900p" },
    { value: "1080", label: "1080p" },
    { value: "2k", label: "2K" },
];

/** Work-Fisher / 轻量 AI App：单采无放大，高于约 0.8MP 也会被压回，面板只给真实档位。 */
const fisherResolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p ≈0.8MP" },
];

/** RunningHub AI App 机器档位（对应提交体 instanceType）。 */
const rhInstanceOptions: Array<{ value: RunningHubInstanceType; labelKey: string; recommended?: boolean }> = [
    { value: "default", labelKey: "standard", recommended: true },
    { value: "plus", labelKey: "plus" },
    { value: "ultra", labelKey: "ultra" },
];

/** U35 官流: lift author 1MP up to ~1080-tier delivery; 900p mid tier for VRAM. */
const u35ResolutionOptions = [
    { value: "720", label: "720p" },
    { value: "900", label: "900p" },
    { value: "1080", label: "1080p" },
    { value: "2k", label: "2K" },
];

/** U06 multi-ref: author long-edge tier (WJILatentPreset 1376); 900p mid tier for VRAM. */
const u06ResolutionOptions = [
    { value: "720", label: "720p" },
    { value: "900", label: "900p" },
    { value: "1376", label: "1376" },
    { value: "480", label: "480p" },
];

const sizeOptions = [
    { value: "16:9", labelKey: "landscape", width: 1280, height: 720 },
    { value: "9:16", labelKey: "portrait", width: 720, height: 1280 },
    { value: "1:1", labelKey: "square", width: 1024, height: 1024 },
    { value: "21:9", labelKey: "widescreen", width: 1792, height: 768 },
    { value: "3:4", labelKey: "tall", width: 768, height: 1024 },
    { value: "auto", labelKey: "auto", width: 0, height: 0 },
];

/** U37 SelfLift: landscape/portrait first so orientation is one click. */
const selfLiftSizeOptions = [
    { value: "16:9", labelKey: "landscape", width: 1280, height: 720 },
    { value: "9:16", labelKey: "portrait", width: 720, height: 1280 },
    { value: "1:1", labelKey: "square", width: 1024, height: 1024 },
    { value: "auto", labelKey: "auto", width: 0, height: 0 },
];

type NativeVideoFamily = "twoPass" | "u35" | "u06" | "selfLift" | "other";

function detectNativeVideoFamily(config: AiConfig): NativeVideoFamily {
    const model = config.model || config.videoModel || "";
    const script = resolveModelScript(config, model);
    const workflow = parseComfyApiWorkflow(script);
    if (workflow) {
        if (isComfyH3SelfLiftWorkflow(workflow)) return "selfLift";
        // U30 Singularity shares draft×upscale math with DualClock two-pass — offer 1080/2K.
        if (isComfyH3SingularityUpscaleWorkflow(workflow) || isComfyH3TwoPassReferenceWorkflow(workflow)) return "twoPass";
        if (isComfyH3ResolutionSelectorVideoWorkflow(workflow)) return "u35";
        if (isComfyH3MultiReferenceVideoWorkflow(workflow)) return "u06";
    }
    const name = String(model)
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    if (/u32|1080p.?高动态不糊|bunny-selflift|u37|selflift|无缝无色差/.test(name)) return "selfLift";
    // U17 shares Singularity draft×upscale math with U30 (LatentUpscaler3D).
    if (/u17|去油腻|修音频-全能|latent放大模型双采加速|u30|singularity|超双采放大/.test(name)) return "twoPass";
    if (/u35|官流|神棍/.test(name)) return "u35";
    if (/u24|v927|文武|h3-video|h3_video|双采参考/.test(name)) return "twoPass";
    // U01 基础版 shares the U06 WJILatentPreset multi-ref UI (long-edge pills); match before the
    // broader `多图参考` pattern so the family is explicit.
    if (/u01(?:[-_]|$)|多图参考生视频基础|u06|多图参考/.test(name)) return "u06";
    return "other";
}

function resolutionOptionsForFamily(family: NativeVideoFamily) {
    if (family === "twoPass") return twoPassResolutionOptions;
    if (family === "u35") return u35ResolutionOptions;
    if (family === "u06") return u06ResolutionOptions;
    if (family === "selfLift") return twoPassResolutionOptions;
    return resolutionOptions;
}

function sizeOptionsForFamily(family: NativeVideoFamily) {
    if (family === "selfLift") return selfLiftSizeOptions;
    return sizeOptions;
}

/** Seed controls are for U30 Singularity + U35 only (not U24 DualClock / U06). */
function supportsVideoSeedControls(config: AiConfig, family: NativeVideoFamily) {
    if (family === "u35") return true;
    if (family !== "twoPass") return false;
    const model = config.model || config.videoModel || "";
    const script = resolveModelScript(config, model);
    const workflow = parseComfyApiWorkflow(script);
    if (workflow && isComfyH3SingularityUpscaleWorkflow(workflow)) return true;
    const name = String(model)
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    return /u17|去油腻|修音频-全能|latent放大模型双采加速|u30|singularity|超双采放大/.test(name);
}

/** DualClock H3-video / u24_v927: canvas audio → reference_only or lock_source. */
function supportsDualClockAudioControls(config: AiConfig, family: NativeVideoFamily) {
    if (family !== "twoPass") return false;
    const model = config.model || config.videoModel || "";
    const script = resolveModelScript(config, model);
    const workflow = parseComfyApiWorkflow(script);
    if (workflow) {
        if (isComfyH3SingularityUpscaleWorkflow(workflow)) return false;
        if (isComfyH3TwoPassReferenceWorkflow(workflow)) return true;
    }
    const name = String(model)
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    if (/u17|去油腻|修音频-全能|latent放大模型双采加速|u30|singularity|超双采放大/.test(name)) return false;
    return /u24|v927|文武|h3-video|h3_video|双采参考/.test(name);
}

/** U30 / U35 / U06: informational tip for ref_audios timbre injection. */
function supportsTimbreAudioHint(config: AiConfig, family: NativeVideoFamily) {
    if (family === "u35" || family === "u06") return true;
    if (family !== "twoPass") return false;
    return supportsVideoSeedControls(config, family);
}

const secondOptions = [6, 10, 12, 16, 20];
/** Work-Fisher single-pass multi-ref: keep duration near Export bake (10s) to avoid RH VRAM OOM. */
const fisherSecondOptions = [6, 8, 10, 12];
/** 【MINIMAX-H3】八月最强文戏：图里写死 `official_2_to_15s`，两端都夹住。 */
const wenxiSecondOptions = [6, 8, 10, 12, 15];
/** Singularity 轻量 AI App：时长上限 30s。 */
const singularitySecondOptions = [6, 10, 15, 20, 30];

const stepOptions = [20, 25, 30, 40, 50];

// High-quality sampler names (subset of KSamplerSelect.sampler_name options).
const samplerNameOptions = ["dpmpp_2m", "euler", "res_multistep", "dpmpp_2m_sde", "uni_pc", "ddim"];

// Scheduler options (subset of BasicScheduler.scheduler options).
const schedulerOptions = ["karras", "simple", "sgm_uniform", "normal"];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = sizeOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.video.sizes.${item.labelKey}`); } }));
export const videoSecondOptions = secondOptions.map((value) => String(value));

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (
        key:
            | "vquality"
            | "size"
            | "videoSeconds"
            | "videoGenerateAudio"
            | "videoWatermark"
            | "videoCropSubtitles"
            | "videoSteps"
            | "videoRefImageSize"
            | "videoSamplerName"
            | "videoScheduler"
            | "videoSeedMode"
            | "videoSeed"
            | "videoAudioMode"
            | "videoFisherMode"
            | "videoFisherLoraStrength"
            | "videoFisherStyleFields"
            | "videoRhInstanceType",
        value: string,
    ) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const model = config.model || config.videoModel || "";
    const requestConfig = resolveModelRequestConfig(config, model);
    const h3Comfy = isAutodlH3ComfyVideoModel(model, requestConfig.baseUrl);
    const relayH3 = !h3Comfy && isRelayMiniMaxH3Video(requestConfig, model);
    const singularityRh = !h3Comfy && isMinimaxH3SingularityWorkflowId(model);
    /** Singularity 形轻量 AI App（211575… MiniMax H3生成视频）。 */
    const singularityLightRh = !h3Comfy && isMinimaxH3SingularityLightAiAppId(model);
    const hdDynamicRh = !h3Comfy && isMinimaxH3HdDynamicWorkflowId(model);
    const fisherRh = !h3Comfy && isMinimaxH3FisherWorkflowId(model);
    /** Work-Fisher 轻量 AI App（211550…）：只露风格 LoRA，不露 Fisher 模式/风格字段全套。 */
    const fisherLightRh = !h3Comfy && isWorkFisherLightAiAppId(model);
    const yzjinyuRh = !h3Comfy && isMinimaxH3YzjinyuWorkflowId(model);
    const wenxiRh = !h3Comfy && isMinimaxH3WenxiWorkflowId(model);
    /** 只有低配图挂着 `MysticXXX_MMH3-V1`，风格 LoRA 档位只对它显示。 */
    const wenxiLoraRh = !h3Comfy && isMinimaxH3WenxiLowWorkflowId(model);
    const fisherMode = normalizeFisherPipelineMode(config.videoFisherMode);
    const fisherLoraStrength = normalizeFisherLoraStrength(config.videoFisherLoraStrength);
    /** 「提交视觉风格字段」：只有显式 `on` 才算打开（默认 off = 整行不发，见 `H3_SCAFFOLD_STYLE_LABELS`）。 */
    const fisherStyleFieldsOn = String(config.videoFisherStyleFields || "off") === "on";
    const rhInstanceType = normalizeRunningHubInstanceType(config.videoRhInstanceType);
    const nativeComfy = shouldUseNativeComfyUi(requestConfig.baseUrl, model, resolveModelScript(config, model));
    const nativeFamily = useMemo(() => (nativeComfy && !h3Comfy ? detectNativeVideoFamily(config) : "other"), [config, nativeComfy, h3Comfy]);
    const qualityChoices = useMemo(() => {
        if (nativeComfy && !h3Comfy) return resolutionOptionsForFamily(nativeFamily);
        if (fisherRh || fisherLightRh) return fisherResolutionOptions;
        if (singularityRh || singularityLightRh || hdDynamicRh || yzjinyuRh || wenxiRh) return twoPassResolutionOptions;
        if (relayH3) return relayH3ResolutionOptions;
        return resolutionOptions;
    }, [nativeComfy, h3Comfy, nativeFamily, singularityRh, singularityLightRh, hdDynamicRh, fisherRh, fisherLightRh, yzjinyuRh, wenxiRh, relayH3]);
    const fisherModeChoices: Array<{ value: FisherPipelineMode; labelKey: string }> = [
        { value: "video", labelKey: "video" },
        { value: "character", labelKey: "character" },
        { value: "scene", labelKey: "scene" },
        { value: "multiview", labelKey: "multiview" },
    ];
    const aspectChoices = useMemo(() => (nativeComfy && !h3Comfy ? sizeOptionsForFamily(nativeFamily) : sizeOptions), [nativeComfy, h3Comfy, nativeFamily]);
    const showSeedControls = useMemo(
        () => nativeComfy && !h3Comfy && supportsVideoSeedControls(config, nativeFamily),
        [config, nativeComfy, h3Comfy, nativeFamily],
    );
    const showAudioModeControls = useMemo(
        () => nativeComfy && !h3Comfy && supportsDualClockAudioControls(config, nativeFamily),
        [config, nativeComfy, h3Comfy, nativeFamily],
    );
    const showTimbreHint = useMemo(
        () => nativeComfy && !h3Comfy && supportsTimbreAudioHint(config, nativeFamily),
        [config, nativeComfy, h3Comfy, nativeFamily],
    );

    if (h3Comfy) {
        const resolutionChoices = autodlH3ResolutionOptions(model);
        const resolution = normalizeAutodlH3Resolution(config.vquality, model);
        const durationMax = autodlH3DurationMax(model);
        const seconds = normalizeAutodlH3Duration(config.videoSeconds, model);
        const durationChoices = autodlH3DurationOptions(model);
        return (
            <ImageSettingsTheme theme={theme}>
                <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                    {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.h3ComfyTitle")}</div> : null}
                    <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        {t("settingsPanels.video.h3ComfyHint", { max: durationMax })}
                    </div>
                    <SettingGroup title={t("settingsPanels.video.resolution")} color={theme.node.muted}>
                        <div className={`grid gap-2 ${resolutionChoices.some((value) => value.includes("(")) ? "grid-cols-2" : "grid-cols-3"}`}>
                            {resolutionChoices.map((value) => (
                                <OptionPill key={value} selected={resolution === value} theme={theme} onClick={() => onConfigChange("vquality", value)}>
                                    {autodlH3ResolutionDisplay(value, model)}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                    <SettingGroup title={`${t("settingsPanels.video.duration")} (duration)`} color={theme.node.muted}>
                        <div className="grid grid-cols-5 gap-2">
                            {durationChoices.map((value) => (
                                <OptionPill key={value} selected={seconds === String(value)} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                    {value}s
                                </OptionPill>
                            ))}
                        </div>
                        <NumberInput
                            value={seconds}
                            min={1}
                            max={durationMax}
                            theme={theme}
                            onChange={(value) => onConfigChange("videoSeconds", normalizeAutodlH3Duration(value, model))}
                        />
                    </SettingGroup>
                </div>
            </ImageSettingsTheme>
        );
    }

    const seconds = config.videoSeconds || "6";
    const size = normalizeVideoSizeValue(config.size);
    const dimensions = readSizeDimensions(size);
    const resolution = normalizeVideoResolutionValue(config.vquality);
    const steps = config.videoSteps || "40";
    const refImageSize = (config.videoRefImageSize || "max") === "max" ? "max" : "match";
    const samplerName = config.videoSamplerName || "dpmpp_2m";
    const scheduler = config.videoScheduler || "karras";
    const seedPreset = /^(fixedb|fixed_b|fixed-b)$/i.test(String(config.videoSeedMode || ""))
        ? "fixedB"
        : config.videoSeedMode === "random"
          ? "random"
          : config.videoSeed === String(COMFY_H3_STABLE_SEED_B)
            ? "fixedB"
            : "fixedA";
    const applySeedPreset = (preset: "random" | "fixedA" | "fixedB") => {
        // Single metadata write; native job maps fixed → 19960422, fixedB → 683072603085674.
        onConfigChange(
            "videoSeedMode",
            preset === "random" ? "random" : preset === "fixedB" ? "fixedB" : "fixed",
        );
    };
    const audioMode = normalizeComfyH3AudioMode(config.videoAudioMode);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {fisherRh ? (
                    <SettingGroup title={t("settingsPanels.video.fisherMode")} color={theme.node.muted}>
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.fisherModeHint")}
                        </div>
                        <div className="grid grid-cols-2 gap-2.5">
                            {fisherModeChoices.map((item) => (
                                <OptionPill
                                    key={item.value}
                                    selected={fisherMode === item.value}
                                    theme={theme}
                                    onClick={() => onConfigChange("videoFisherMode", item.value)}
                                >
                                    {t(`settingsPanels.video.fisherModes.${item.labelKey}`)}
                                </OptionPill>
                            ))}
                        </div>
                        {/* 音色参考的口径：3 条上限、必须配图、台词写在提示词里（音频只给音色）。 */}
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.fisherAudioHint")}
                        </div>
                        {/* 风格 LoRA（279 `MysticXXX_MMH3-V1`）：韩语人声 / 硬字幕 / 自编台词的共同源头。
                            默认 0 = 关，纯官方 H3；想保留韩剧质感再往上拖。 */}
                        <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            <span>{t("settingsPanels.video.fisherLora")}</span>
                            <div className="flex shrink-0 gap-1.5">
                                {FISHER_LORA_STRENGTH_OPTIONS.map((option) => (
                                    <OptionPill
                                        key={option}
                                        selected={fisherLoraStrength === option}
                                        theme={theme}
                                        onClick={() => onConfigChange("videoFisherLoraStrength", String(option))}
                                    >
                                        {option === 0 ? t("settingsPanels.video.fisherLoraOff") : String(option)}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.fisherLoraHint")}
                        </div>
                        {/* 「提交视觉风格字段」：默认不提交 —— `视觉风格：…` 那一行整行不进提示词，
                            因为 H3 会把那段中文当旁白念出来（2026-10-25 第八次报障）。打开只用于 A/B。 */}
                        <div
                            className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px]"
                            style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                        >
                            <span>{t("settingsPanels.video.fisherStyleFields")}</span>
                            <div className="flex shrink-0 gap-2">
                                <OptionPill selected={!fisherStyleFieldsOn} theme={theme} onClick={() => onConfigChange("videoFisherStyleFields", "off")}>
                                    {t("settingsPanels.video.fisherStyleFieldsOff")}
                                </OptionPill>
                                <OptionPill selected={fisherStyleFieldsOn} theme={theme} onClick={() => onConfigChange("videoFisherStyleFields", "on")}>
                                    {t("settingsPanels.video.fisherStyleFieldsOn")}
                                </OptionPill>
                            </div>
                        </div>
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.fisherStyleFieldsHint")}
                        </div>
                    </SettingGroup>
                ) : null}
                {wenxiLoraRh || fisherLightRh || singularityLightRh ? (
                    <SettingGroup title={t("settingsPanels.video.fisherLora")} color={theme.node.muted}>
                        {/* 八月文戏低配 / Work-Fisher / Singularity 轻量 AI App：
                            暴露 `MysticXXX` 一类 strength 时默认关；211575 若未暴露则需作者重发。 */}
                        <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            <span>{t("settingsPanels.video.fisherLora")}</span>
                            <div className="flex shrink-0 gap-1.5">
                                {FISHER_LORA_STRENGTH_OPTIONS.map((option) => (
                                    <OptionPill
                                        key={option}
                                        selected={fisherLoraStrength === option}
                                        theme={theme}
                                        onClick={() => onConfigChange("videoFisherLoraStrength", String(option))}
                                    >
                                        {option === 0 ? t("settingsPanels.video.fisherLoraOff") : String(option)}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.fisherLoraHint")}
                        </div>
                    </SettingGroup>
                ) : null}
                {fisherRh || fisherLightRh || singularityLightRh ? (
                    <SettingGroup title={t("settingsPanels.video.rhInstance")} color={theme.node.muted}>
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.rhInstanceHint")}
                        </div>
                        <div className="grid grid-cols-3 gap-2.5">
                            {rhInstanceOptions.map((item) => (
                                <OptionPill
                                    key={item.value}
                                    selected={rhInstanceType === item.value}
                                    theme={theme}
                                    onClick={() => onConfigChange("videoRhInstanceType", item.value)}
                                >
                                    <span className="inline-flex items-center gap-1">
                                        {t(`settingsPanels.video.rhInstances.${item.labelKey}`)}
                                        {item.recommended ? (
                                            <span className="rounded px-1 text-[9px] leading-4" style={{ background: theme.node.text, color: theme.node.bg || "#111" }}>
                                                {t("settingsPanels.video.rhInstanceRecommended")}
                                            </span>
                                        ) : null}
                                    </span>
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                {/* 字幕：H3 会把硬字幕烧进画面（图里没有字幕节点、节点也没有字幕开关，连静音镜都照样出字）。
                    2026-10-26 用户要求：从 Fisher 专属组提到通用视频设置，且默认**关**（谁要谁开）。
                    仍然只在 RunningHub 渠道生成的视频上生效（裁切重编码那段代码只在 makeRunningHub 里）。 */}
                <SettingGroup title={t("settingsPanels.video.cropSubtitlesGroup")} color={theme.node.muted}>
                    <div
                        className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px]"
                        style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                    >
                        <span>{t("settingsPanels.video.cropSubtitles")}</span>
                        <div className="flex shrink-0 gap-2">
                            <OptionPill selected={normalizeSubtitleCropMode(config.videoCropSubtitles) === "fill"} theme={theme} onClick={() => onConfigChange("videoCropSubtitles", "fill")}>
                                {t("settingsPanels.video.cropSubtitlesFill")}
                            </OptionPill>
                            <OptionPill selected={normalizeSubtitleCropMode(config.videoCropSubtitles) === "crop"} theme={theme} onClick={() => onConfigChange("videoCropSubtitles", "crop")}>
                                {t("settingsPanels.video.cropSubtitlesCrop")}
                            </OptionPill>
                            <OptionPill selected={normalizeSubtitleCropMode(config.videoCropSubtitles) === "blur"} theme={theme} onClick={() => onConfigChange("videoCropSubtitles", "blur")}>
                                {t("settingsPanels.video.cropSubtitlesBlur")}
                            </OptionPill>
                            <OptionPill selected={normalizeSubtitleCropMode(config.videoCropSubtitles) === null} theme={theme} onClick={() => onConfigChange("videoCropSubtitles", "false")}>
                                {t("settingsPanels.video.cropSubtitlesOff")}
                            </OptionPill>
                        </div>
                    </div>
                    <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        {t("settingsPanels.video.cropSubtitlesHint")}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    {nativeFamily === "u06" ? (
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.u06QualityHint")}
                        </div>
                    ) : null}
                    {(nativeFamily === "twoPass" || nativeFamily === "u35") && (
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {nativeFamily === "twoPass" ? t("settingsPanels.video.twoPassQualityHint") : t("settingsPanels.video.u35QualityHint")}
                        </div>
                    )}
                    {fisherRh || fisherLightRh ? (
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.fisherQualityHint")}
                        </div>
                    ) : null}
                    <div className={`grid gap-2.5 ${qualityChoices.length >= 3 ? "grid-cols-4" : "grid-cols-3"}`}>
                        {qualityChoices.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        <ResolutionInput value={resolution} theme={theme} onChange={(value) => onConfigChange("vquality", value)} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    {nativeFamily === "selfLift" ? (
                        <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {t("settingsPanels.video.selfLiftOrientationHint")}
                        </div>
                    ) : null}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={size === "auto" || size.includes(":")} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={size === "auto" || size.includes(":")} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {aspectChoices.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[78px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: size === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{t(`settingsPanels.video.sizes.${item.labelKey}`)}</span>
                                {item.value === "auto" ? null : (
                                    <span className="text-[11px] leading-none opacity-55">
                                        {item.value}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {(fisherRh || fisherLightRh
                            ? fisherSecondOptions
                            : singularityLightRh
                              ? singularitySecondOptions
                              : wenxiRh
                                ? wenxiSecondOptions
                                : secondOptions
                        ).map((value) => (
                            <OptionPill key={value} selected={seconds === String(value)} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                {value}s
                            </OptionPill>
                        ))}
                        <NumberInput
                            value={seconds}
                            min={1}
                            max={fisherRh || fisherLightRh ? 12 : singularityLightRh ? 30 : wenxiRh ? 15 : 20}
                            theme={theme}
                            onChange={(value) =>
                                onConfigChange(
                                    "videoSeconds",
                                    fisherRh || fisherLightRh
                                        ? String(Math.min(12, Math.max(2, Number(value) || 2)))
                                        : singularityLightRh
                                          ? String(Math.min(30, Math.max(2, Number(value) || 2)))
                                          : wenxiRh
                                            ? String(Math.min(15, Math.max(2, Number(value) || 2)))
                                            : value,
                                )
                            }
                        />
                    </div>
                </SettingGroup>
                {nativeComfy && !h3Comfy ? (
                    <>
                        <SettingGroup title={t("settingsPanels.video.steps")} color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-2.5">
                                {stepOptions.map((value) => (
                                    <OptionPill key={value} selected={steps === String(value)} theme={theme} onClick={() => onConfigChange("videoSteps", String(value))}>
                                        {value}
                                    </OptionPill>
                                ))}
                                <NumberInput value={steps} min={1} max={100} theme={theme} onChange={(value) => onConfigChange("videoSteps", value)} />
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.refImageSize")} color={theme.node.muted}>
                            <div className="grid grid-cols-2 gap-2.5">
                                <OptionPill selected={refImageSize === "max"} theme={theme} onClick={() => onConfigChange("videoRefImageSize", "max")}>
                                    {t("settingsPanels.video.refImageMax")}
                                </OptionPill>
                                <OptionPill selected={refImageSize === "match"} theme={theme} onClick={() => onConfigChange("videoRefImageSize", "match")}>
                                    {t("settingsPanels.video.refImageMatch")}
                                </OptionPill>
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.samplerName")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {samplerNameOptions.map((value) => (
                                    <OptionPill key={value} selected={samplerName === value} theme={theme} onClick={() => onConfigChange("videoSamplerName", value)}>
                                        {value}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.scheduler")} color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-2.5">
                                {schedulerOptions.map((value) => (
                                    <OptionPill key={value} selected={scheduler === value} theme={theme} onClick={() => onConfigChange("videoScheduler", value)}>
                                        {value}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        {showSeedControls ? (
                            <SettingGroup title={t("settingsPanels.video.seed")} color={theme.node.muted}>
                                <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                    {t("settingsPanels.video.seedHint")}
                                </div>
                                <div className="grid grid-cols-3 gap-2.5">
                                    <OptionPill selected={seedPreset === "random"} theme={theme} onClick={() => applySeedPreset("random")}>
                                        {t("settingsPanels.video.seedRandom")}
                                    </OptionPill>
                                    <OptionPill selected={seedPreset === "fixedA"} theme={theme} onClick={() => applySeedPreset("fixedA")}>
                                        {t("settingsPanels.video.seedFixedA")}
                                    </OptionPill>
                                    <OptionPill selected={seedPreset === "fixedB"} theme={theme} onClick={() => applySeedPreset("fixedB")}>
                                        {t("settingsPanels.video.seedFixedB")}
                                    </OptionPill>
                                </div>
                                {seedPreset === "fixedA" || seedPreset === "fixedB" ? (
                                    <div className="rounded-full border px-3 py-2 text-center text-[11px] tabular-nums opacity-80" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                        {seedPreset === "fixedB" ? String(COMFY_H3_STABLE_SEED_B) : String(COMFY_H3_STABLE_SEED)}
                                    </div>
                                ) : null}
                            </SettingGroup>
                        ) : null}
                        {showAudioModeControls ? (
                            <SettingGroup title={t("settingsPanels.video.audioMode")} color={theme.node.muted}>
                                <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                    {t("settingsPanels.video.audioModeHint")}
                                </div>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <OptionPill selected={audioMode === "reference_only"} theme={theme} onClick={() => onConfigChange("videoAudioMode", "reference_only")}>
                                        {t("settingsPanels.video.audioModeReference")}
                                    </OptionPill>
                                    <OptionPill selected={audioMode === "lock_source"} theme={theme} onClick={() => onConfigChange("videoAudioMode", "lock_source")}>
                                        {t("settingsPanels.video.audioModeLock")}
                                    </OptionPill>
                                </div>
                            </SettingGroup>
                        ) : null}
                        {showTimbreHint ? (
                            <SettingGroup title={t("settingsPanels.video.audioMode")} color={theme.node.muted}>
                                <div className="rounded-xl border px-3 py-2 text-[11px] leading-5 opacity-70" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                    {t("settingsPanels.video.timbreHint")}
                                </div>
                            </SettingGroup>
                        ) : null}
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoSettingsSummary(config: AiConfig) {
    const model = config.model || config.videoModel || "";
    if (isAutodlH3ComfyVideoModel(model, resolveModelRequestConfig(config, model).baseUrl)) {
        return `${autodlH3ResolutionLabel(config.vquality, model)} · ${normalizeAutodlH3Duration(config.videoSeconds, model)}s`;
    }
    const base = `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.size)} · ${videoSecondsLabel(config.videoSeconds)}`;
    if (isMinimaxH3FisherWorkflowId(model) || isWorkFisherLightAiAppId(model) || isMinimaxH3SingularityLightAiAppId(model)) {
        const instance = normalizeRunningHubInstanceType(config.videoRhInstanceType);
        const label = instance === "plus" ? "Plus" : instance === "ultra" ? "Ultra" : "Standard";
        return `${base} · ${label}`;
    }
    return base;
}

export function videoResolutionLabel(value: string) {
    if (/[竖横]|\(1:1\)/i.test(value || "")) return autodlH3ResolutionLabel(value);
    const normalized = normalizeVideoResolutionValue(value);
    if (/^2k$/i.test(normalized)) return "2K";
    if (/^1376$/i.test(normalized)) return "1376";
    if (/^4k$/i.test(normalized)) return "4K";
    return `${normalized}p`;
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return i18n.t("settingsPanels.video.adaptive");
    const size = normalizeVideoSizeValue(value);
    const option = sizeOptions.find((item) => item.value === size);
    return option ? i18n.t(`settingsPanels.video.sizes.${option.labelKey}`) : size;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto" || value === "adaptive") return "auto";
    if (/^\d+:\d+$/.test(value || "")) return value;
    if (/^\d+x\d+$/i.test(value || "")) {
        const match = value.match(/^(\d+)x(\d+)$/i);
        if (!match) return "16:9";
        const width = Number(match[1]);
        const height = Number(match[2]);
        const ratio = width / Math.max(1, height);
        const presets = [
            { value: "21:9", ratio: 21 / 9 },
            { value: "16:9", ratio: 16 / 9 },
            { value: "4:3", ratio: 4 / 3 },
            { value: "1:1", ratio: 1 },
            { value: "3:4", ratio: 3 / 4 },
            { value: "9:16", ratio: 9 / 16 },
        ];
        return presets.reduce((best, item) => (Math.abs(Math.log(ratio) - Math.log(item.ratio)) < Math.abs(Math.log(ratio) - Math.log(best.ratio)) ? item : best)).value;
    }
    if (value === "1:1") return "1:1";
    if (["9:16", "2:3", "3:4"].includes(value)) return value === "2:3" ? "3:4" : value;
    if (["16:9", "3:2", "4:3", "21:9"].includes(value)) return value === "3:2" ? "16:9" : value;
    return "16:9";
}

export function normalizeVideoResolutionValue(value: string) {
    if (/[竖横]|\(1:1\)/i.test(value || "")) return normalizeAutodlH3Resolution(value).replace(/p.*$/, "") || "768";
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "480p" || raw === "low") return "480";
    if (raw === "720p" || raw === "auto" || raw === "medium") return "720";
    if (raw === "900p" || raw === "900" || raw === "准高清" || raw === "mid") return "900";
    if (raw === "1080p" || raw === "hd") return "1080";
    if (raw === "2k" || raw === "1440" || raw === "1440p" || raw === "high") return "2k";
    if (raw === "1376" || raw === "1376p") return "1376";
    if (raw === "4k" || raw === "2160" || raw === "2160p") return "4k";
    return raw.replace(/p$/i, "") || "720";
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-1.5 text-[12px] transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function NumberInput({ value, min, max, theme, onChange }: { value: string; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-9 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const ratioMatch = size.match(/^(\d+):(\d+)$/);
    if (ratioMatch) {
        const widthRatio = Number(ratioMatch[1]);
        const heightRatio = Number(ratioMatch[2]);
        if (widthRatio >= heightRatio) return { width: 1280, height: Math.max(1, Math.round((1280 * heightRatio) / widthRatio)) };
        return { width: Math.max(1, Math.round((1280 * widthRatio) / heightRatio)), height: 1280 };
    }
    const match = size.match(/^(\d+)x(\d+)$/i);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}
