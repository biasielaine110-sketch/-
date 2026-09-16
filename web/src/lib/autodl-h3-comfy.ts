/**
 * AutoDL MiniMax H3 ComfyUI workflows
 * Docs: https://autodl.art/docs/comfyui_api/
 *
 * Request body (workflow-dependent; H3 video example):
 *   { prompt, duration: <int seconds>, resolution: "480p竖", ref_image_0?… }
 * duration: 1–15 (default 5)
 * resolution: 480p / 768p / 1080p / 1088p / 1440p × 竖|横|(1:1)
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
    "1088p竖",
    "1088p横",
    "1088p(1:1)",
    "1440p竖",
    "1440p横",
    "1440p(1:1)",
] as const;

export type AutodlH3Resolution = (typeof AUTODL_H3_RESOLUTION_OPTIONS)[number];
type AutodlH3Tier = "480" | "768" | "1080" | "1088" | "1440";

const DEFAULT_H3_RESOLUTION: AutodlH3Resolution = "768p竖";
const H3_DURATION_MIN = 1;
const H3_DURATION_MAX = 15;
const H3_DURATION_DEFAULT = 5;

/** Detect AutoDL H3 / ComfyUI video workflow ids (model name = workflow_id). */
export function isAutodlH3ComfyVideoModel(model: string, baseUrl = ""): boolean {
    const name = String(model || "")
        .split("::")
        .pop()
        ?.trim()
        .toLowerCase() || "";
    if (!name) return false;
    if (/minimax[_-]?h3|h3comfyui|h3[_-]?comfy|lightx2v|h3_image_audio|image_audio_to_video/i.test(name)) return true;
    if (/autodl\.art/i.test(baseUrl) && /(^|[_-])h3([_-]|$)/i.test(name)) return true;
    return false;
}

/** Max duration in seconds for AutoDL H3 workflows. */
export function autodlH3DurationMax(_model = ""): number {
    return H3_DURATION_MAX;
}

export function normalizeAutodlH3Resolution(value: string): AutodlH3Resolution {
    const raw = String(value || "").trim();
    if ((AUTODL_H3_RESOLUTION_OPTIONS as readonly string[]).includes(raw)) return raw as AutodlH3Resolution;

    const lower = raw.toLowerCase();
    const isSquare = /1\s*:\s*1|正方形|square/i.test(raw);
    const isLandscape = /横|landscape|16\s*:\s*9|21\s*:\s*9/i.test(raw);
    const isPortrait = /竖|portrait|9\s*:\s*16|3\s*:\s*4/i.test(raw);

    let tier: AutodlH3Tier = "768";
    if (/1440|2k|qhd/i.test(lower)) tier = "1440";
    else if (/1088/.test(lower)) tier = "1088";
    else if (/1080|full\s*hd|fhd/i.test(lower)) tier = "1080";
    else if (/480|low/.test(lower)) tier = "480";
    else if (/720|768|medium|high|auto/.test(lower) || /^\d+$/.test(lower)) {
        const numeric = Number(lower.replace(/p$/i, ""));
        if (numeric && numeric <= 480) tier = "480";
        else if (numeric >= 1400) tier = "1440";
        else if (numeric >= 1088) tier = "1088";
        else if (numeric >= 1000) tier = "1080";
        else tier = "768";
    }

    if (isSquare) return `${tier}p(1:1)` as AutodlH3Resolution;
    if (isLandscape) return `${tier}p横` as AutodlH3Resolution;
    if (isPortrait) return `${tier}p竖` as AutodlH3Resolution;
    return DEFAULT_H3_RESOLUTION;
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

export function autodlH3ResolutionLabel(value: string): string {
    return normalizeAutodlH3Resolution(value);
}
