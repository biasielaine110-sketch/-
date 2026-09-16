/**
 * AutoDL MiniMax H3 ComfyUI workflows
 * Docs: https://autodl.art/docs/comfyui_api/
 *
 * Request body (workflow-dependent; H3 video example):
 *   { prompt, duration: <int seconds>, resolution: "480p竖", ref_image_0?… }
 * duration: 1–15 (default 5)
 *
 * Common AutoDL H3 options:
 *   480p / 768p / 1080p / 1440p × 竖|横|(1:1)
 * Pricing may label "1088p"; that string is invalid — map to 1080p.
 * Image+audio variants often only accept 480/768 竖|横.
 */

export const AUTODL_H3_RESOLUTION_OPTIONS = [
    "480p竖",
    "480p横",
    "480p(1:1)",
    "768p竖",
    "768p横",
    "768p(1:1)",
    "1080p竖",
    "1080p横",
    "1080p(1:1)",
    "1440p竖",
    "1440p横",
    "1440p(1:1)",
] as const;

const AUTODL_H3_IMAGE_AUDIO_RESOLUTIONS = ["480p竖", "480p横", "768p竖", "768p横"] as const;

export type AutodlH3Resolution = (typeof AUTODL_H3_RESOLUTION_OPTIONS)[number];
type AutodlH3Tier = "480" | "768" | "1080" | "1440";
type AutodlH3Orientation = "竖" | "横" | "(1:1)";

const DEFAULT_H3_RESOLUTION: AutodlH3Resolution = "768p竖";
const H3_DURATION_MIN = 1;
const H3_DURATION_MAX = 15;
const H3_DURATION_DEFAULT = 5;

const TIER_FALLBACK: Record<AutodlH3Tier, AutodlH3Tier[]> = {
    "480": ["480", "768", "1080", "1440"],
    "768": ["768", "480", "1080", "1440"],
    "1080": ["1080", "1440", "768", "480"],
    "1440": ["1440", "1080", "768", "480"],
};

function workflowId(model: string): string {
    return (
        String(model || "")
            .split("::")
            .pop()
            ?.trim()
            .toLowerCase() || ""
    );
}

/** Detect AutoDL H3 / ComfyUI video workflow ids (model name = workflow_id). */
export function isAutodlH3ComfyVideoModel(model: string, baseUrl = ""): boolean {
    const name = workflowId(model);
    if (!name) return false;
    if (/minimax[_-]?h3|h3comfyui|h3[_-]?comfy|lightx2v|h3_image_audio|image_audio_to_video/i.test(name)) return true;
    if (/autodl\.art/i.test(baseUrl) && /(^|[_-])h3([_-]|$)/i.test(name)) return true;
    return false;
}

function isImageAudioWorkflow(model = ""): boolean {
    return /image[_-]?audio|audio[_-]?to[_-]?video/i.test(workflowId(model));
}

/** Allowed resolution strings for the given workflow (falls back to the common H3 set). */
export function autodlH3ResolutionOptions(model = ""): readonly string[] {
    if (isImageAudioWorkflow(model)) return AUTODL_H3_IMAGE_AUDIO_RESOLUTIONS;
    return AUTODL_H3_RESOLUTION_OPTIONS;
}

/** Max duration in seconds for AutoDL H3 workflows. */
export function autodlH3DurationMax(_model = ""): number {
    return H3_DURATION_MAX;
}

function pickOrientation(raw: string, lower: string): AutodlH3Orientation {
    if (/1\s*:\s*1|正方形|square|\(1:1\)/i.test(raw)) return "(1:1)";
    if (/横|landscape|16\s*:\s*9|21\s*:\s*9/i.test(raw) || /横/.test(lower)) return "横";
    if (/竖|portrait|9\s*:\s*16|3\s*:\s*4/i.test(raw) || /竖/.test(lower)) return "竖";
    return "竖";
}

function pickTier(lower: string): AutodlH3Tier {
    if (/1440|2k|qhd/i.test(lower)) return "1440";
    // Pricing UIs may say 1088p; AutoDL option strings use 1080p for that tier.
    if (/1088|1080|full\s*hd|fhd/i.test(lower)) return "1080";
    if (/480|low/.test(lower)) return "480";
    if (/720|768|medium|high|auto/.test(lower) || /^\d+$/.test(lower)) {
        const numeric = Number(lower.replace(/p$/i, "").replace(/[^\d.].*$/, ""));
        if (Number.isFinite(numeric) && numeric > 0) {
            if (numeric <= 480) return "480";
            if (numeric >= 1400) return "1440";
            if (numeric >= 1000) return "1080";
            return "768";
        }
        return "768";
    }
    return "768";
}

function clampToOptions(candidate: string, options: readonly string[]): string {
    if (options.includes(candidate)) return candidate;

    const orientationMatch = candidate.match(/(竖|横|\(1:1\))$/);
    const orientation = (orientationMatch?.[1] || "竖") as AutodlH3Orientation;
    const tierMatch = candidate.match(/^(\d+)p/);
    const tier = (tierMatch?.[1] || "768") as AutodlH3Tier;
    const tierOrder = TIER_FALLBACK[tier] || TIER_FALLBACK["768"];

    const sameOrientation = options.filter((item) => item.endsWith(orientation));
    for (const nextTier of tierOrder) {
        const hit = sameOrientation.find((item) => item.startsWith(`${nextTier}p`));
        if (hit) return hit;
    }

    const anyTier = tierOrder.map((nextTier) => options.find((item) => item.startsWith(`${nextTier}p`))).find(Boolean);
    return anyTier || options[0] || DEFAULT_H3_RESOLUTION;
}

export function normalizeAutodlH3Resolution(value: string, model = ""): AutodlH3Resolution {
    const options = autodlH3ResolutionOptions(model);
    const raw = String(value || "").trim();
    if (options.includes(raw)) return raw as AutodlH3Resolution;

    // 1088p is a pricing label only — never send it; keep 1440p as its own tier.
    const remapped = raw.replace(/1088p/gi, "1080p").replace(/2k/gi, "1440p");
    if (options.includes(remapped)) return remapped as AutodlH3Resolution;
    if ((AUTODL_H3_RESOLUTION_OPTIONS as readonly string[]).includes(remapped)) {
        return clampToOptions(remapped, options) as AutodlH3Resolution;
    }

    const lower = remapped.toLowerCase();
    const orientation = pickOrientation(remapped, lower);
    const tier = pickTier(lower);
    const candidate = `${tier}p${orientation}`;
    return clampToOptions(candidate, options) as AutodlH3Resolution;
}

/** Clamp to AutoDL integer `duration` seconds for the workflow. */
export function normalizeAutodlH3Duration(value: string, model = ""): string {
    const max = autodlH3DurationMax(model);
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) return String(H3_DURATION_DEFAULT);
    return String(Math.min(max, Math.max(H3_DURATION_MIN, numeric)));
}

/** Integer seconds for API body.duration (AutoDL ComfyUI). */
export function autodlH3DurationSeconds(value: string, model = ""): number {
    return Number(normalizeAutodlH3Duration(value, model));
}

export function autodlH3DurationOptions(model = ""): number[] {
    const max = autodlH3DurationMax(model);
    return Array.from({ length: max - H3_DURATION_MIN + 1 }, (_, index) => H3_DURATION_MIN + index);
}

export function autodlH3ResolutionLabel(value: string, model = ""): string {
    return normalizeAutodlH3Resolution(value, model);
}
