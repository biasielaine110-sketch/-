/**
 * miora 图像后端（WorkBuddy 的 `copilot-image`）只接受**固定的几个尺寸**。
 *
 * 背景（2026-10-21 报障）：渠道里配的是 `hy-image-3.5-edit`（生图 / 改图都走 miora），
 * 画布按「质量 + 比例」算出 `1824x1024` / `2720x1536` 这类任意像素值塞进 `size`，
 * 上游直接回 400 `{"code":14402,"msg":"...The requested output image size is not supported..."}`
 * —— 经 workbuddy2api 转发后变成 502，界面上只剩一坨 JSON。
 *
 * 下面这张表不是猜的：`workbuddy2api` 的 `internal/server/image_compat.go`
 * 里 `imageSizeAliases` 就是**对着上游实测**出来的、比例 → 像素的对照（画布发比例时网关会用这张表翻译）。
 * 现在画布自己也按这张表收口，任意像素尺寸一律吸附到最接近的一档，避免把必然失败的值发上去。
 *
 * ⚠️ 表外尺寸一律不许透传：上游会整单失败，且错误信息不带可用尺寸列表。
 */

/** 实测可用的尺寸（1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16 / 21:9）。 */
export const MIORA_IMAGE_SIZES = [
    "1024x1024",
    "1024x768",
    "768x1024",
    "1152x768",
    "768x1152",
    "1280x720",
    "720x1280",
    "1344x576",
] as const;

/**
 * 是不是 miora 系图片模型（也就是「尺寸只认固定表」的那一族）。
 *
 * - `miora-image` / `miora-image-edit`：画布自己起的名字（队列通道）。
 * - `hy-image-3.5-wb` / `hy-image-3.5-edit`：wb2api 暴露的名字，上游回报的 model 也是这两个
 *   （`media_miora_image.go` 注释），用户渠道里写的就是 `hy-image-3.5-edit`。
 *
 * 前缀 `cn:` / `rh:` / `u:` 要先剥掉（渠道里两种写法都有人用）。
 */
export function isMioraImageFamilyModel(model?: string): boolean {
    const bare = String(model || "")
        .trim()
        .toLowerCase()
        .replace(/^(cn|rh|u):/, "");
    return bare.startsWith("miora-image") || bare.startsWith("hy-image");
}

function parsePixelSize(size: string): { width: number; height: number } | null {
    const matched = /^(\d{1,5})\s*[x×*]\s*(\d{1,5})$/i.exec(size.trim());
    if (!matched) return null;
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * 把任意像素尺寸吸附到 miora 的白名单档位（按画幅比例取最近，用对数距离 ——
 * 直接比 `|r1-r2|` 会让 21:9 这种宽画幅被 16:9 抢走）。
 *
 * 已经是表内尺寸 → 原样返回（不要因为「重算」把用户明确选的档位改掉）。
 * 不是 `WxH` 写法（比例 / auto / 空）→ 返回空串，交给上游用默认尺寸
 * （网关自己会认 `16:9` 这类比例，画布不该在这里猜）。
 */
export function resolveMioraImageSize(size: string): string {
    const value = String(size || "").trim();
    if (!value || value.toLowerCase() === "auto") return "";
    const dimensions = parsePixelSize(value);
    if (!dimensions) return "";
    const wanted = dimensions.width / dimensions.height;
    let best: string = MIORA_IMAGE_SIZES[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of MIORA_IMAGE_SIZES) {
        const parsed = parsePixelSize(candidate);
        if (!parsed) continue;
        const delta = Math.abs(Math.log(parsed.width / parsed.height / wanted));
        if (delta < bestDelta) {
            best = candidate;
            bestDelta = delta;
        }
    }
    return best;
}

/**
 * 上游「这个尺寸我不支持」的报错。
 *
 * 覆盖：miora 的 `code:14402` + `unsupported_image_size`、通用文案
 * `The requested output image size is not supported`，以及 OpenAI 风格的
 * `size ... not supported`（只在小写文本里出现 `size` 与 `not supported` 相邻时才认，
 * 避免把别的 400 也当尺寸问题去重试）。
 */
export function isUnsupportedImageSizeError(message: string): boolean {
    const text = String(message || "");
    if (/unsupported_image_size|14402/i.test(text)) return true;
    if (/requested\s+(output\s+)?image\s+size\s+is\s+not\s+supported/i.test(text)) return true;
    return /size[^.\n]{0,40}not\s+supported/i.test(text);
}
