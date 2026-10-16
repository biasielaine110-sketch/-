/**
 * 摄像机参数（机身 / 镜头 / 焦段 / 光圈）。
 * 来源剧集画布（dramaclaw）freezone/route_helpers.py#FREEZONE_IMAGE_CAMERA_OPTIONS。
 *
 * 与风格模板（style-templates.ts）的关系见 mergeStyleAndCameraPrompt：
 * 设定了摄像机 → 用摄像机的（剥掉风格里自带的相机/镜头段，再拼上摄像机段）；
 * 未设定摄像机 → 用选定风格里自带的相机参数。
 */

export type CanvasCameraSelection = {
    /** 机身 id（见 CAMERA_BODIES）。 */
    cameraBody?: string;
    /** 镜头 id（见 CAMERA_LENSES）。 */
    lens?: string;
    /** 焦段，单位 mm（见 CAMERA_FOCAL_LENGTHS_MM）。 */
    focalLengthMm?: number;
    /** 光圈，如 "f/2.8"（见 CAMERA_APERTURES）。 */
    aperture?: string;
};

export type CanvasCameraOption = {
    id: string;
    label: string;
};

export const CAMERA_BODIES: CanvasCameraOption[] = [
    { id: "panavision_dxl2", label: "Panavision DXL2" },
    { id: "arri_alexa_65", label: "ARRI ALEXA 65" },
    { id: "red_vraptor_xl", label: "RED V-Raptor XL" },
    { id: "sony_venice_2", label: "Sony Venice 2" },
];

export const CAMERA_LENSES: CanvasCameraOption[] = [
    { id: "arri_signature_prime", label: "Arri Signature Prime" },
    { id: "cooke_s4i", label: "Cooke S4/i" },
    { id: "zeiss_supreme_prime", label: "Zeiss Supreme Prime" },
    { id: "panavision_primo_70", label: "Panavision Primo 70" },
];

export const CAMERA_FOCAL_LENGTHS_MM: number[] = [8, 14, 24, 35, 50, 75, 125];

export const CAMERA_APERTURES: string[] = ["f/1.4", "f/2", "f/2.8", "f/4", "f/5.6", "f/8"];

const CAMERA_BODY_MAP = new Map(CAMERA_BODIES.map((item) => [item.id, item.label]));
const CAMERA_LENS_MAP = new Map(CAMERA_LENSES.map((item) => [item.id, item.label]));

function resolveLabel(map: Map<string, string>, id?: string | null): string {
    if (!id) return "";
    // 未知 id 静默忽略（旧数据/手改），不把内部 id 泄露进提示词。
    return map.get(id) || "";
}

/** 焦段归一化：接受 number 或纯数字字符串，返回正整数 mm；非法返回 undefined。 */
function normalizeFocalLength(value?: number | string | null): number | undefined {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) return undefined;
        return Math.round(value);
    }
    if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
        return Math.round(parsed);
    }
    return undefined;
}

/** 机身标签；未知返回空串。 */
export function getCameraBodyLabel(id?: string | null): string {
    return resolveLabel(CAMERA_BODY_MAP, id);
}

/** 镜头标签；未知返回空串。 */
export function getCameraLensLabel(id?: string | null): string {
    return resolveLabel(CAMERA_LENS_MAP, id);
}

/** 解析出实际参与提示词的部件（已过滤未知/空值）。 */
function collectCameraParts(selection?: CanvasCameraSelection | null): string[] {
    if (!selection) return [];
    const parts: string[] = [];
    const body = getCameraBodyLabel(selection.cameraBody);
    if (body) parts.push(body);
    const lens = getCameraLensLabel(selection.lens);
    if (lens) parts.push(lens);
    const focal = normalizeFocalLength(selection.focalLengthMm);
    if (focal) parts.push(`${focal}mm`);
    const aperture = typeof selection.aperture === "string" ? selection.aperture.trim() : "";
    if (aperture) parts.push(aperture);
    return parts;
}

/** 是否设定了有效摄像机参数（全部为空/未知 → false）。 */
export function hasCameraSelection(selection?: CanvasCameraSelection | null): boolean {
    return collectCameraParts(selection).length > 0;
}

/** 按钮上的紧凑标签，如 "ARRI ALEXA 65 · 50mm · f/2.8"；未设定返回空串。 */
export function buildCameraSelectionLabel(selection?: CanvasCameraSelection | null): string {
    return collectCameraParts(selection).join(" · ");
}

/**
 * 摄像机段（写入生图提示词）。未设定/无有效部件时返回空串，
 * 空串会被 mergeStyleAndCameraPrompt 视为「未设定摄像机」而原样保留风格自带相机参数。
 */
export function buildCameraSelectionPrompt(selection?: CanvasCameraSelection | null): string {
    const parts = collectCameraParts(selection);
    if (!parts.length) return "";
    return [
        "Camera setup:",
        `- ${parts.join(" | ")}`,
        "- Preserve this camera language in framing, lens feel, depth rendition, and overall optical character where applicable.",
    ].join("\n");
}

/**
 * 选择器缩略图（`web/public/images/{camera,lens,aperture}/*.png`，素材直接取自剧集画布）。
 * 焦段没有配图，UI 用大号数字，所以这里不提供。
 *
 * 别名表照抄剧集画布 CameraPickerPopover 的显式映射：后端 id 与磁盘文件名对不上的，
 * 指到同族基础款；纯 slug 猜测会给出意外匹配，所以宁可写死。
 */
const CAMERA_BODY_IMAGE_ALIAS: Record<string, string> = {
    red_vraptor_xl: "red-v-raptor",
    sony_venice_2: "sony-venice",
};

const CAMERA_LENS_IMAGE_ALIAS: Record<string, string> = {
    cooke_s4i: "cooke-s4",
    zeiss_supreme_prime: "zeiss-ultra-prime",
    panavision_primo_70: "panavision-primo",
};

/** 光圈只有 f-1-4 / f-4 / f-11 三张图，其余档位都落到 f-4。 */
const CAMERA_APERTURE_IMAGE_ALIAS: Record<string, string> = {
    "f/2": "f-4",
    "f/2.8": "f-4",
    "f/5.6": "f-4",
    "f/8": "f-4",
};

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function imageUrlFor(folder: "camera" | "lens" | "aperture", slug: string): string {
    return slug ? `/images/${folder}/${slug}.png` : "";
}

/** 机身缩略图；未知 id 也按 slug 猜一个路径（图缺失时组件会退回图标占位）。 */
export function getCameraBodyImage(id?: string | null, label?: string | null): string {
    const key = (id || "").trim();
    const slug = CAMERA_BODY_IMAGE_ALIAS[key] || slugify(key || (label || "").trim());
    return imageUrlFor("camera", slug);
}

/** 镜头缩略图。 */
export function getCameraLensImage(id?: string | null, label?: string | null): string {
    const key = (id || "").trim();
    const slug = CAMERA_LENS_IMAGE_ALIAS[key] || slugify(key || (label || "").trim());
    return imageUrlFor("lens", slug);
}

/** 光圈缩略图；入参是 "f/1.4" 这类标签。 */
export function getCameraApertureImage(label?: string | null): string {
    const key = (label || "").trim();
    const aliased = CAMERA_APERTURE_IMAGE_ALIAS[key];
    if (aliased) return imageUrlFor("aperture", aliased);
    // "f/1.4" → "f-1-4"，"ƒ/4" → "f-4"
    return imageUrlFor("aperture", slugify(key.replace(/^[fƒ]\//i, "f-")));
}
