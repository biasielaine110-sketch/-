/**
 * AutoDL MiniMax H3 ComfyUI workflows
 * Docs: https://autodl.art/docs/comfyui_api/
 * Workflow schemas: GET /api/v1/comfyui/workflows/{workflow_id}
 *
 * Resolution option strings differ by workflow:
 * - lightx2v-style: 480p竖 / 1080p横 / 768p(1:1)
 * - image+audio (v2_15s): 480p竖 / 768p横 only
 * - z09xx (e.g. minimax_h3_z0903): 1088p横(1920*1088) — includes pixel size, uses 1088 not 1080
 */

/** Default / lightx2v-style options (minimax_h3_lightx2v_v5). */
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

const AUTODL_H3_IMAGE_AUDIO_RESOLUTIONS = ["480p竖", "480p横", "768p竖", "768p横"] as const;

/** minimax_h3_zm_u24 等：480/768 + 1:1，无 1080/1088/1440。 */
const AUTODL_H3_ZM_RESOLUTIONS = ["480p竖", "480p横", "480p(1:1)", "768p竖", "768p横", "768p(1:1)"] as const;

/** minimax_h3_z0902 / z0903 — exact enum labels from AutoDL input_rules. */
const AUTODL_H3_Z09_RESOLUTIONS = [
    "480p竖(480*864)",
    "480p横(864*480)",
    "768p竖(768*1376)",
    "768p横(1376*768)",
    "1088p竖(1088*1920)",
    "1088p横(1920*1088)",
    "1440p竖(1440*2560)",
    "1440p横(2560*1440)",
] as const;

export type AutodlH3Resolution = string;
type AutodlH3Tier = "480" | "768" | "1080" | "1088" | "1440";
type AutodlH3Orientation = "竖" | "横" | "(1:1)";

const DEFAULT_H3_RESOLUTION = "768p竖";
const DEFAULT_Z09_RESOLUTION = "768p竖(768*1376)";
const H3_DURATION_MIN = 1;
const H3_DURATION_MAX = 15;
const H3_DURATION_DEFAULT = 5;

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
    if (/minimax[_-]?h3|h3comfyui|h3[_-]?comfy|lightx2v|h3_image_audio|image_audio_to_video|z09\d{2}/i.test(name)) return true;
    if (/autodl\.art/i.test(baseUrl) && /(^|[_-])h3([_-]|$)/i.test(name)) return true;
    return false;
}

/** Workflows whose resolution enum embeds pixel sizes and uses 1088p (not 1080p). */
export function isAutodlH3Z09Workflow(model = ""): boolean {
    return /z09\d{2}/i.test(workflowId(model));
}

/** zm_* 升级画质类：仅 480/768（含 1:1）。 */
export function isAutodlH3ZmWorkflow(model = ""): boolean {
    return /(?:^|[_-])zm(?:[_-]|$)/i.test(workflowId(model));
}

function isImageAudioWorkflow(model = ""): boolean {
    const name = workflowId(model);
    if (isAutodlH3Z09Workflow(name) || isAutodlH3ZmWorkflow(name)) return false;
    return /image[_-]?audio|audio[_-]?to[_-]?video/i.test(name);
}

/** Workflows that accept / require ref_audio_0… (image+audio / z09 / zm). */
export function autodlH3SupportsRefAudio(model = ""): boolean {
    return isAutodlH3Z09Workflow(model) || isAutodlH3ZmWorkflow(model) || isImageAudioWorkflow(model);
}

/** z0903 marks ref_audio_0 as required; others usually optional with a blank default. */
export function autodlH3RequiresRefAudio(model = ""): boolean {
    return isAutodlH3Z09Workflow(model);
}

/** AutoDL blank wav used as workflow default when no reference audio is connected. */
export const AUTODL_H3_BLANK_AUDIO_URL = "https://codewithgpu.ks3-cn-beijing.ksyuncs.com/comfyui_api/blank/blank.wav";

/** Allowed resolution strings for the given workflow. */
export function autodlH3ResolutionOptions(model = ""): readonly string[] {
    if (isAutodlH3Z09Workflow(model)) return AUTODL_H3_Z09_RESOLUTIONS;
    if (isAutodlH3ZmWorkflow(model)) return AUTODL_H3_ZM_RESOLUTIONS;
    if (isImageAudioWorkflow(model)) return AUTODL_H3_IMAGE_AUDIO_RESOLUTIONS;
    return AUTODL_H3_RESOLUTION_OPTIONS;
}

/** Max duration in seconds for AutoDL H3 workflows. */
export function autodlH3DurationMax(_model = ""): number {
    return H3_DURATION_MAX;
}

function pickOrientation(raw: string): AutodlH3Orientation {
    if (/1\s*:\s*1|正方形|square|\(1:1\)/i.test(raw)) return "(1:1)";
    if (/横|landscape|16\s*:\s*9|21\s*:\s*9/i.test(raw)) return "横";
    if (/竖|portrait|9\s*:\s*16|3\s*:\s*4/i.test(raw)) return "竖";
    return "竖";
}

function pickTier(lower: string, prefer1088: boolean): AutodlH3Tier {
    if (/1440|2k|qhd/i.test(lower)) return "1440";
    if (/1088/.test(lower)) return prefer1088 ? "1088" : "1080";
    if (/1080|full\s*hd|fhd/i.test(lower)) return prefer1088 ? "1088" : "1080";
    if (/480|low/.test(lower)) return "480";
    if (/720|768|medium|high|auto/.test(lower) || /^\d+/.test(lower)) {
        const numeric = Number(lower.replace(/p$/i, "").replace(/[^\d.].*$/, ""));
        if (Number.isFinite(numeric) && numeric > 0) {
            if (numeric <= 480) return "480";
            if (numeric >= 1400) return "1440";
            if (numeric >= 1080) return prefer1088 ? "1088" : "1080";
            return "768";
        }
        return "768";
    }
    return "768";
}

function optionPrefix(option: string): string {
    return option.replace(/\([^)]*\)$/, "");
}

function tierFallback(tier: AutodlH3Tier, prefer1088: boolean): AutodlH3Tier[] {
    if (prefer1088) {
        const map: Record<AutodlH3Tier, AutodlH3Tier[]> = {
            "480": ["480", "768", "1088", "1440"],
            "768": ["768", "480", "1088", "1440"],
            "1080": ["1088", "1440", "768", "480"],
            "1088": ["1088", "1440", "768", "480"],
            "1440": ["1440", "1088", "768", "480"],
        };
        return map[tier];
    }
    const map: Record<AutodlH3Tier, AutodlH3Tier[]> = {
        "480": ["480", "768", "1080", "1440"],
        "768": ["768", "480", "1080", "1440"],
        "1080": ["1080", "1440", "768", "480"],
        "1088": ["1080", "1440", "768", "480"],
        "1440": ["1440", "1080", "768", "480"],
    };
    return map[tier];
}

function clampToOptions(candidate: string, options: readonly string[], prefer1088: boolean): string {
    if (options.includes(candidate)) return candidate;

    const byPrefix = options.find((item) => optionPrefix(item) === candidate || optionPrefix(item) === optionPrefix(candidate));
    if (byPrefix) return byPrefix;

    const orientation = pickOrientation(candidate);
    const tier = pickTier(candidate.toLowerCase(), prefer1088);
    const tierOrder = tierFallback(tier, prefer1088);

    const sameOrientation = options.filter((item) => {
        const prefix = optionPrefix(item);
        if (orientation === "(1:1)") return /\(1:1\)$/.test(prefix);
        return prefix.endsWith(orientation);
    });
    for (const nextTier of tierOrder) {
        const hit = sameOrientation.find((item) => optionPrefix(item).startsWith(`${nextTier}p`));
        if (hit) return hit;
    }

    const anyTier = tierOrder.map((nextTier) => options.find((item) => optionPrefix(item).startsWith(`${nextTier}p`))).find(Boolean);
    return anyTier || options[0] || (prefer1088 ? DEFAULT_Z09_RESOLUTION : DEFAULT_H3_RESOLUTION);
}

export function normalizeAutodlH3Resolution(value: string, model = ""): AutodlH3Resolution {
    const options = autodlH3ResolutionOptions(model);
    const prefer1088 = isAutodlH3Z09Workflow(model);
    const raw = String(value || "").trim();
    if (options.includes(raw)) return raw;

    // Short forms / legacy values → workflow-specific enum label.
    let remapped = raw;
    if (prefer1088) {
        remapped = remapped.replace(/1080p/gi, "1088p");
    } else {
        remapped = remapped.replace(/1088p/gi, "1080p");
    }
    remapped = remapped.replace(/2k/gi, "1440p");

    if (options.includes(remapped)) return remapped;
    const prefixHit = options.find((item) => optionPrefix(item) === remapped || optionPrefix(item) === optionPrefix(remapped));
    if (prefixHit) return prefixHit;

    const orientation = pickOrientation(remapped);
    const tier = pickTier(remapped.toLowerCase(), prefer1088);
    const candidate = orientation === "(1:1)" ? `${tier}p(1:1)` : `${tier}p${orientation}`;
    return clampToOptions(candidate, options, prefer1088);
}

/** Short label for UI pills (strip trailing pixel size). */
export function autodlH3ResolutionDisplay(value: string, model = ""): string {
    return optionPrefix(normalizeAutodlH3Resolution(value, model));
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
    return autodlH3ResolutionDisplay(value, model);
}
