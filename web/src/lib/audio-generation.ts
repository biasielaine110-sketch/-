export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
];

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export const sunoVersionOptions = [
    { value: "v6", label: "v6" },
    { value: "v6-wild", label: "v6-wild" },
    { value: "v6-mini", label: "v6-mini" },
];

/** Legacy public versions Seedance no longer accepts on /v1/music/generations. */
const LEGACY_SUNO_VERSIONS = new Set(["v3.5", "v4", "v4.5", "v4.5+", "v4.5-all", "v5", "v5.5"]);

export const sunoVocalGenderOptions = [
    { value: "", label: "Auto" },
    { value: "Male", label: "Male" },
    { value: "Female", label: "Female" },
];

export const sunoFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "m4a", label: "M4A" },
];

export function isSunoAudioModel(model: string) {
    return /suno/i.test(model.trim());
}

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function normalizeSunoVersionValue(value: string) {
    const trimmed = value.trim();
    if (sunoVersionOptions.some((item) => item.value === trimmed)) return trimmed;
    // Old saved configs (v3.5–v5.5) must map to current public API versions.
    if (LEGACY_SUNO_VERSIONS.has(trimmed)) return "v6";
    return "v6";
}

export function normalizeSunoVocalGenderValue(value: string) {
    return sunoVocalGenderOptions.some((item) => item.value === value) ? value : "";
}

export function normalizeSunoFormatValue(value: string) {
    return sunoFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeSunoFlagValue(value: string | boolean | undefined, fallback = false) {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === "true" || value === "1") return "true";
    if (value === "false" || value === "0") return "false";
    return fallback ? "true" : "false";
}

export function audioVoiceLabel(value: string) {
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function sunoSettingsSummary(options: { version?: string; custom?: string; instrumental?: string; vocalGender?: string }) {
    const version = normalizeSunoVersionValue(options.version || "");
    const mode = normalizeSunoFlagValue(options.custom) === "true" ? "Custom" : "Inspo";
    const instrumental = normalizeSunoFlagValue(options.instrumental) === "true" ? "Instrumental" : "Vocal";
    const gender = normalizeSunoVocalGenderValue(options.vocalGender || "");
    return [version, mode, instrumental, gender || null].filter(Boolean).join(" · ");
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac" || format === "m4a") return "audio/mp4";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
