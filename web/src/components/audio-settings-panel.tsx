import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import {
    audioFormatOptions,
    audioSpeedLabel,
    audioVoiceOptions,
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
    seedAudioFormatOptions,
    seedAudioSpeakerOptions,
    sunoFormatOptions,
    sunoVersionOptions,
    sunoVocalGenderOptions,
} from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

export type AudioSettingKey =
    | "audioVoice"
    | "audioFormat"
    | "audioSpeed"
    | "audioInstructions"
    | "sunoVersion"
    | "sunoCustom"
    | "sunoInstrumental"
    | "sunoTitle"
    | "sunoStyle"
    | "sunoVocalGender";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const { t } = useTranslation();
    const model = config.model || config.audioModel || "";
    const suno = isSunoAudioModel(model);
    const seedAudio = !suno && isSeedAudioModel(model);

    if (suno) {
        const version = normalizeSunoVersionValue(config.sunoVersion || "");
        const custom = normalizeSunoFlagValue(config.sunoCustom) === "true";
        const instrumental = normalizeSunoFlagValue(config.sunoInstrumental) === "true";
        const format = normalizeSunoFormatValue(config.audioFormat);
        const vocalGender = normalizeSunoVocalGenderValue(config.sunoVocalGender || "");

        return (
            <ImageSettingsTheme theme={theme}>
                <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                    {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.sunoTitle")}</div> : null}
                    <SettingGroup title={t("settingsPanels.audio.sunoMode")} color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            <OptionPill selected={!custom} theme={theme} onClick={() => onConfigChange("sunoCustom", "false")}>
                                {t("settingsPanels.audio.sunoInspo")}
                            </OptionPill>
                            <OptionPill selected={custom} theme={theme} onClick={() => onConfigChange("sunoCustom", "true")}>
                                {t("settingsPanels.audio.sunoCustom")}
                            </OptionPill>
                        </div>
                    </SettingGroup>
                    <SettingGroup title={t("settingsPanels.audio.sunoVersion")} color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {sunoVersionOptions.map((item) => (
                                <OptionPill key={item.value} selected={version === item.value} theme={theme} onClick={() => onConfigChange("sunoVersion", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                    <SettingGroup title={t("settingsPanels.audio.sunoInstrumental")} color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            <OptionPill selected={!instrumental} theme={theme} onClick={() => onConfigChange("sunoInstrumental", "false")}>
                                {t("settingsPanels.audio.sunoVocal")}
                            </OptionPill>
                            <OptionPill selected={instrumental} theme={theme} onClick={() => onConfigChange("sunoInstrumental", "true")}>
                                {t("settingsPanels.audio.sunoInstrumentalOn")}
                            </OptionPill>
                        </div>
                    </SettingGroup>
                    {!instrumental ? (
                        <SettingGroup title={t("settingsPanels.audio.sunoVocalGender")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {sunoVocalGenderOptions.map((item) => (
                                    <OptionPill key={item.value || "auto"} selected={vocalGender === item.value} theme={theme} onClick={() => onConfigChange("sunoVocalGender", item.value)}>
                                        {item.value === "" ? t("settingsPanels.common.auto") : item.value === "Male" ? t("settingsPanels.audio.sunoMale") : t("settingsPanels.audio.sunoFemale")}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                    ) : null}
                    <SettingGroup title={t("settingsPanels.audio.format")} color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {sunoFormatOptions.map((item) => (
                                <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                    {custom ? (
                        <>
                            <SettingGroup title={t("settingsPanels.audio.sunoSongTitle")} color={theme.node.muted}>
                                <input
                                    value={config.sunoTitle || ""}
                                    maxLength={80}
                                    placeholder={t("settingsPanels.audio.sunoSongTitlePlaceholder")}
                                    className="h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                                    onChange={(event) => onConfigChange("sunoTitle", event.target.value)}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </SettingGroup>
                            <SettingGroup title={t("settingsPanels.audio.sunoStyle")} color={theme.node.muted}>
                                <textarea
                                    value={config.sunoStyle || ""}
                                    maxLength={1000}
                                    placeholder={t("settingsPanels.audio.sunoStylePlaceholder")}
                                    className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                    onChange={(event) => onConfigChange("sunoStyle", event.target.value)}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </SettingGroup>
                        </>
                    ) : null}
                    <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                        {custom ? t("settingsPanels.audio.sunoCustomHint") : t("settingsPanels.audio.sunoInspoHint")}
                    </div>
                </div>
            </ImageSettingsTheme>
        );
    }

    if (seedAudio) {
        const speaker = normalizeSeedAudioSpeakerValue(config.audioVoice || "");
        const format = normalizeSeedAudioFormatValue(config.audioFormat);
        const speed = normalizeAudioSpeedValue(config.audioSpeed);
        const presetSelected = seedAudioSpeakerOptions.some((item) => item.value === speaker);

        return (
            <ImageSettingsTheme theme={theme}>
                <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                    {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.seedTitle")}</div> : null}
                    <SettingGroup title={t("settingsPanels.audio.seedSpeaker")} color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            {seedAudioSpeakerOptions.map((item) => (
                                <OptionPill key={item.value} selected={speaker === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                    <SettingGroup title={t("settingsPanels.audio.seedSpeakerCustom")} color={theme.node.muted}>
                        <input
                            value={presetSelected ? "" : speaker}
                            placeholder={t("settingsPanels.audio.seedSpeakerPlaceholder")}
                            className="h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                            onChange={(event) => onConfigChange("audioVoice", event.target.value)}
                            onBlur={(event) => onConfigChange("audioVoice", normalizeSeedAudioSpeakerValue(event.target.value || speaker))}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                    <SettingGroup title={t("settingsPanels.audio.format")} color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {seedAudioFormatOptions.map((item) => (
                                <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                    <SettingGroup title={t("settingsPanels.audio.speed")} color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {speedOptions.map((value) => (
                                <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                    {audioSpeedLabel(value)}
                                </OptionPill>
                            ))}
                        </div>
                        <input
                            type="number"
                            min={0.25}
                            max={4}
                            step={0.05}
                            className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                            value={config.audioSpeed || "1"}
                            onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                            onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                    <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                        {t("settingsPanels.audio.seedHint")}
                    </div>
                </div>
            </ImageSettingsTheme>
        );
    }

    const voice = normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.audio.voice")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {audioVoiceOptions.map((item) => (
                            <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.audio.format")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {audioFormatOptions.map((item) => (
                            <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.audio.speed")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {speedOptions.map((value) => (
                            <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                {audioSpeedLabel(value)}
                            </OptionPill>
                        ))}
                    </div>
                    <input
                        type="number"
                        min={0.25}
                        max={4}
                        step={0.05}
                        className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                        value={config.audioSpeed || "1"}
                        onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                        onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.audio.instructions")} color={theme.node.muted}>
                    <textarea
                        value={config.audioInstructions || ""}
                        placeholder={t("settingsPanels.audio.instructionsPlaceholder")}
                        className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
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
