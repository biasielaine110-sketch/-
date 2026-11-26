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
export const SEED_AUDIO_SPEAKER_AUTO = "auto";

export const seedAudioSpeakerOptions = [
    { value: SEED_AUDIO_SPEAKER_AUTO, label: "文字描述" },
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

/** Default: let the prompt describe voices (Seed Audio scene mode). */
export const SEED_AUDIO_DEFAULT_SPEAKER = SEED_AUDIO_SPEAKER_AUTO;

export function isSunoAudioModel(model: string) {
    return /suno/i.test(model.trim());
}

export function isSeedAudioModel(model: string) {
    // Seedance: doubao-seed-audio-1.0 · EvoLink: doubao-seed-audio-1-0 · Ark: seed-audio-1.0
    return /doubao[-_]?seed[-_]?audio|seed[-_]?audio[-_]?\d/i.test(model.trim());
}

/**
 * seedance.nz 上只收 WAV 的语音模型（`/docs#gemini-tts` 与 `/docs#qwen3-tts` 的 `metadata.format` 只有 wav）。
 *
 * 传 mp3/pcm/opus 时上游先做价格预检，直接 400 打回：
 *   `price preview returned status 400: {"error":{"code":"invalid_parameter","message":"format must be wav"}}`
 * 任务压根没入队（所以也不扣额度）。这类模型的格式要**钉死 wav**，不看用户选了什么。
 */
const SEEDANCE_WAV_ONLY_AUDIO_MODEL = /gm[-_.]?2[-_.]?5[-_.]?(pro|flash)[-_.]?tts|qwen[-_.]?3[-_.]?tts/i;

export function isSeedanceWavOnlyAudioModel(model: string) {
    return SEEDANCE_WAV_ONLY_AUDIO_MODEL.test(model.trim());
}

/**
 * Gemini 2.5 TTS：`zhenzhen/gm-2.5-pro-tts` / `zhenzhen/gm-2.5-flash-tts`。
 * 契约（`/docs#gemini-tts`）与 Seed Audio **不是同一套**：
 *   - 音色走 `metadata.voice`（30 个 Gemini 音色名，默认 Kore），不是 `metadata.speaker`；
 *   - 表达指令走 `metadata.instructions`（≤1000 字）；
 *   - 只有 `metadata.format = wav`，**没有** `sample_rate` / `speech_rate`，也**不收参考音频**；
 *   - prompt 1–5000 字符，短句不需要像 Seed Audio 那样补到 5 个字。
 */
const SEEDANCE_GEMINI_TTS_MODEL = /gm[-_.]?2[-_.]?5[-_.]?(pro|flash)[-_.]?tts/i;

export function isSeedanceGeminiTtsModel(model: string) {
    return SEEDANCE_GEMINI_TTS_MODEL.test(model.trim());
}

/** 30 个 Gemini 2.5 TTS 音色（大小写不敏感，默认 Kore）。desc 只用于界面提示。 */
export const geminiTtsVoiceOptions = [
    { value: "Zephyr", label: "Zephyr", desc: "女 · 明亮" },
    { value: "Puck", label: "Puck", desc: "男 · 轻快" },
    { value: "Charon", label: "Charon", desc: "男 · 沉稳、适合讲解" },
    { value: "Kore", label: "Kore", desc: "女 · 坚定" },
    { value: "Fenrir", label: "Fenrir", desc: "男 · 兴奋" },
    { value: "Leda", label: "Leda", desc: "女 · 年轻" },
    { value: "Orus", label: "Orus", desc: "男 · 坚定" },
    { value: "Aoede", label: "Aoede", desc: "女 · 轻松" },
    { value: "Callirrhoe", label: "Callirrhoe", desc: "女 · 随和" },
    { value: "Autonoe", label: "Autonoe", desc: "女 · 明亮" },
    { value: "Enceladus", label: "Enceladus", desc: "男 · 气声" },
    { value: "Iapetus", label: "Iapetus", desc: "男 · 清晰" },
    { value: "Umbriel", label: "Umbriel", desc: "男 · 随和" },
    { value: "Algieba", label: "Algieba", desc: "男 · 圆润" },
    { value: "Despina", label: "Despina", desc: "女 · 圆润" },
    { value: "Erinome", label: "Erinome", desc: "女 · 清晰" },
    { value: "Algenib", label: "Algenib", desc: "男 · 沙哑" },
    { value: "Rasalgethi", label: "Rasalgethi", desc: "男 · 沉稳、适合讲解" },
    { value: "Laomedeia", label: "Laomedeia", desc: "女 · 轻快" },
    { value: "Achernar", label: "Achernar", desc: "女 · 柔和" },
    { value: "Alnilam", label: "Alnilam", desc: "男 · 坚定" },
    { value: "Schedar", label: "Schedar", desc: "男 · 平稳" },
    { value: "Gacrux", label: "Gacrux", desc: "女 · 成熟" },
    { value: "Pulcherrima", label: "Pulcherrima", desc: "女 · 直率" },
    { value: "Achird", label: "Achird", desc: "男 · 友好" },
    { value: "Zubenelgenubi", label: "Zubenelgenubi", desc: "男 · 随性" },
    { value: "Vindemiatrix", label: "Vindemiatrix", desc: "女 · 温柔" },
    { value: "Sadachbia", label: "Sadachbia", desc: "男 · 活泼" },
    { value: "Sadaltager", label: "Sadaltager", desc: "男 · 博学" },
    { value: "Sulafat", label: "Sulafat", desc: "女 · 温暖" },
];

export const GEMINI_TTS_DEFAULT_VOICE = "Kore";

/** 只认 30 个音色名（大小写不敏感）；OpenAI 那套 alloy/nova… 一律落回 Kore。 */
export function normalizeGeminiTtsVoice(value: string) {
    const trimmed = String(value || "").trim();
    const hit = geminiTtsVoiceOptions.find((item) => item.value.toLowerCase() === trimmed.toLowerCase());
    return hit ? hit.value : GEMINI_TTS_DEFAULT_VOICE;
}

export function geminiTtsVoiceLabel(value: string) {
    return normalizeGeminiTtsVoice(value);
}

export function geminiTtsVoiceDesc(value: string) {
    const voice = normalizeGeminiTtsVoice(value);
    return geminiTtsVoiceOptions.find((item) => item.value === voice)?.desc || "";
}

/** 实际会发出去的音频格式：wav-only 的模型无视用户选择。 */
export function resolveAudioFormatForModel(model: string, value: string) {
    return isSeedanceWavOnlyAudioModel(model) ? "wav" : value;
}

/** 上游文案点名「format must be wav」——说明这条链路只收 wav，换格式重提一次是安全的（没入队、没扣次数）。 */
export function isAudioFormatMustBeWavError(message: string) {
    return /format\s+must\s+be\s+wav/i.test(String(message || ""));
}

/** 界面倍速 → Seed Audio 的 speech_rate（-50~100，0 = 原速）。Gemini TTS 不吃这个字段。 */
function mapSeedanceSpeechRate(speed: number) {
    if (!Number.isFinite(speed)) return 0;
    return Math.max(-50, Math.min(100, Math.round((speed - 1) * 50)));
}

function resolveSeedanceSpeaker(voice: string, instructions: string) {
    const hint = instructions.trim();
    if (hint && (/^(zh_|en_|multi_|saturn_|ICL_)/i.test(hint) || /_bigtts|_tob|_uranus|_moon|_mars/i.test(hint))) return hint;
    const normalized = normalizeSeedAudioSpeakerValue(voice);
    if (/^(auto|none)$/i.test(normalized)) return "";
    return normalized;
}

export type SeedanceAudioMetadataInput = {
    model: string;
    /** 已归一过的容器（gemini 家族会被强制成 wav）。 */
    format: string;
    voice: string;
    speed: number;
    instructions: string;
    referenceUrls: string[];
};

/**
 * `/v1/audio/generations` 的 `metadata` —— 唯一来源。
 * 两套契约在这里分流，别在调用方拼字段（拼错一个 `speaker`/`voice` 就是 400）。
 */
export function buildSeedanceAudioMetadata(input: SeedanceAudioMetadataInput): Record<string, unknown> {
    const instructions = String(input.instructions || "").trim();
    if (isSeedanceGeminiTtsModel(input.model)) {
        const metadata: Record<string, unknown> = { format: "wav", voice: normalizeGeminiTtsVoice(input.voice) };
        if (instructions) metadata.instructions = instructions.slice(0, 1000);
        return metadata;
    }
    if (isSeedanceWavOnlyAudioModel(input.model)) {
        // 其它只收 wav 的「简单 TTS」（如 qwen/qwen3-tts-1.7b）：文档只有 prompt / metadata.voice / metadata.format，
        // 发 speaker / sample_rate / speech_rate 是自找 400。音色暂用它的默认值，别硬塞 OpenAI 音色名。
        return { format: "wav" };
    }
    // Docs: speaker / audio_url / images 三者互斥；只把「其它节点连进来的音频」当 audio_url。
    const metadata: Record<string, unknown> = {
        format: input.format,
        sample_rate: "24000",
        speech_rate: mapSeedanceSpeechRate(input.speed),
    };
    if (input.referenceUrls.length) {
        metadata.audio_url = input.referenceUrls.length === 1 ? input.referenceUrls[0] : input.referenceUrls;
    } else {
        const speaker = resolveSeedanceSpeaker(normalizeSeedAudioSpeakerValue(input.voice || ""), instructions);
        // Omit speaker for prompt-described / multi-character Seed Audio scenes.
        if (speaker && !/^(auto|none)$/i.test(speaker)) metadata.speaker = speaker;
    }
    return metadata;
}

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeSeedAudioSpeakerValue(value: string) {
    const trimmed = value.trim();
    if (!trimmed || /^(auto|none|free|prompt)$/i.test(trimmed)) return SEED_AUDIO_SPEAKER_AUTO;
    if (seedAudioSpeakerOptions.some((item) => item.value === trimmed)) return trimmed;
    // Allow custom Doubao speaker / clone IDs.
    if (/^(zh_|en_|multi_|saturn_|ICL_)/i.test(trimmed) || /_bigtts|_tob|_uranus|_moon|_mars/i.test(trimmed)) return trimmed;
    // OpenAI voice names are invalid for Seed Audio — fall back to prompt-described voices.
    if (audioVoiceOptions.some((item) => item.value === trimmed)) return SEED_AUDIO_SPEAKER_AUTO;
    return trimmed || SEED_AUDIO_SPEAKER_AUTO;
}

export function isSeedAudioSpeakerAuto(value: string) {
    return normalizeSeedAudioSpeakerValue(value) === SEED_AUDIO_SPEAKER_AUTO;
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
