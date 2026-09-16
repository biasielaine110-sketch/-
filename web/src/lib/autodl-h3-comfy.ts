/**
 * AutoDL MiniMax H3 ComfyUI workflows
 * Docs: https://autodl.art/docs/comfyui_api/
 * Example workflow params (minimax_h3_lightx2v_v5):
 *   prompt, duration(1-10), resolution(480p竖|480p横|…), ref_image_0..8
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
] as const;

export type AutodlH3Resolution = (typeof AUTODL_H3_RESOLUTION_OPTIONS)[number];

const DEFAULT_H3_RESOLUTION: AutodlH3Resolution = "768p竖";
const H3_DURATION_MIN = 1;
const H3_DURATION_MAX = 10;
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

export function normalizeAutodlH3Resolution(value: string): AutodlH3Resolution {
    const raw = String(value || "").trim();
    if ((AUTODL_H3_RESOLUTION_OPTIONS as readonly string[]).includes(raw)) return raw as AutodlH3Resolution;

    const lower = raw.toLowerCase();
    const isSquare = /1\s*:\s*1|正方形|square/i.test(raw);
    const isLandscape = /横|landscape|16\s*:\s*9|21\s*:\s*9/i.test(raw);
    const isPortrait = /竖|portrait|9\s*:\s*16|3\s*:\s*4/i.test(raw);

    let tier: "480" | "768" | "1080" = "768";
    if (/1080/.test(lower)) tier = "1080";
    else if (/480|low/.test(lower)) tier = "480";
    else if (/720|768|medium|high|auto/.test(lower) || /^\d+$/.test(lower)) {
        const numeric = Number(lower.replace(/p$/i, ""));
        if (numeric && numeric <= 480) tier = "480";
        else if (numeric && numeric >= 1000) tier = "1080";
        else tier = "768";
    }

    if (isSquare) return `${tier}p(1:1)` as AutodlH3Resolution;
    if (isLandscape) return `${tier}p横` as AutodlH3Resolution;
    if (isPortrait) return `${tier}p竖` as AutodlH3Resolution;
    return DEFAULT_H3_RESOLUTION;
}

export function normalizeAutodlH3Duration(value: string): string {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) return String(H3_DURATION_DEFAULT);
    return String(Math.min(H3_DURATION_MAX, Math.max(H3_DURATION_MIN, numeric)));
}

export function autodlH3DurationOptions(): number[] {
    return Array.from({ length: H3_DURATION_MAX - H3_DURATION_MIN + 1 }, (_, index) => H3_DURATION_MIN + index);
}

export function autodlH3ResolutionLabel(value: string): string {
    return normalizeAutodlH3Resolution(value);
}
