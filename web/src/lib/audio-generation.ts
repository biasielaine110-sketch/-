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

/** Doubao Seed Audio / Seedance `/v1/audio/generations` speaker presets. */
export const seedAudioSpeakerOptions = [
    { value: "zh_male_shaonianzixin_uranus_bigtts", label: "少年梓辛" },
    { value: "zh_female_vv_uranus_bigtts", label: "VV" },
    { value: "zh_female_shuangkuaisisi_moon_bigtts", label: "爽快思思" },
    { value: "zh_male_wennuanahu_moon_bigtts", label: "温暖阿虎" },
    { value: "zh_female_tianmeixiaoyuan_moon_bigtts", label: "甜美小源" },
    { value: "zh_male_yuanboxiaoshu_moon_bigtts", label: "渊博小叔" },
    { value: "zh_female_linjia_mars_bigtts", label: "邻家女孩" },
    { value: "zh_male_jingqiangkanye_moon_bigtts", label: "京腔侃爷" },
];

export const seedAudioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "pcm", label: "PCM" },
    { value: "opus", label: "Opus" },
];

export const SEED_AUDIO_DEFAULT_SPEAKER = "zh_male_shaonianzixin_uranus_bigtts";

export function isSunoAudioModel(model: string) {
    return /suno/i.test(model.trim());
}

export function isSeedAudioModel(model: string) {
    // Seedance: doubao-seed-audio-1.0 · EvoLink: doubao-seed-audio-1-0 · Ark: seed-audio-1.0
    return /doubao[-_]?seed[-_]?audio|seed[-_]?audio[-_]?\d/i.test(model.trim());
}

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeSeedAudioSpeakerValue(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return SEED_AUDIO_DEFAULT_SPEAKER;
    if (seedAudioSpeakerOptions.some((item) => item.value === trimmed)) return trimmed;
    // Allow custom Doubao speaker / clone IDs.
    if (/^(zh_|en_|multi_|saturn_|ICL_)/i.test(trimmed) || /_bigtts|_tob|_uranus|_moon|_mars/i.test(trimmed)) return trimmed;
    // OpenAI voice names are invalid for Seed Audio.
    if (audioVoiceOptions.some((item) => item.value === trimmed)) return SEED_AUDIO_DEFAULT_SPEAKER;
    return trimmed || SEED_AUDIO_DEFAULT_SPEAKER;
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeSeedAudioFormatValue(value: string) {
    return seedAudioFormatOptions.some((item) => item.value === value) ? value : "mp3";
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

export function seedAudioSpeakerLabel(value: string) {
    const speaker = normalizeSeedAudioSpeakerValue(value);
    return seedAudioSpeakerOptions.find((item) => item.value === speaker)?.label || speaker;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function seedAudioFormatLabel(value: string) {
    const format = normalizeSeedAudioFormatValue(value);
    return seedAudioFormatOptions.find((item) => item.value === format)?.label || format;
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

export function seedAudioSettingsSummary(options: { voice?: string; format?: string; speed?: string }) {
    return `${seedAudioSpeakerLabel(options.voice || "")} · ${seedAudioFormatLabel(options.format || "")} · ${audioSpeedLabel(options.speed || "1")}`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac" || format === "m4a") return "audio/mp4";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
