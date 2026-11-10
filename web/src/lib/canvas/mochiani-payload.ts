/**
 * 「发送到 MochiAni」之前给参考图减重。
 *
 * 为什么必须做：画布里的图大多是**本地素材**（`blob:` / IndexedDB），发给桥只能内联成 base64。
 * 一张 3.7MB 的图 base64 后 4.9MB，三张就是 14.7MB —— 实测一次发送光把请求体送进桥
 * 就花了 240 秒（14.77MB / 240s ≈ 60KB/s，正是 Tailscale 中转的速度）。
 *
 * 视频 / 图片模型真正吃到的参考图并不需要 4K：长边压到 1280、JPEG 0.86，
 * 同样的图落到 200KB 量级，观感几乎无差，请求体少 15~20 倍。
 *
 * 不碰 svg（矢量压了没意义）和 gif（会把动图压成静帧）；已经足够小的图原样返回。
 * 任何一步失败都**原样返回**，绝不因为压缩失败把图弄丢。
 */
export const MOCHIANI_IMAGE_MAX_EDGE = 1280;
export const MOCHIANI_IMAGE_QUALITY = 0.86;
export const MOCHIANI_IMAGE_MAX_BYTES = 900 * 1024;

/** base64 载荷的近似字节数（不算头，只用来判断「要不要压」）。 */
function approximateBytes(dataUrl: string) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return 0;
    return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读不出编码结果"));
        reader.readAsDataURL(blob);
    });
}

export interface ShrinkImageOptions {
    maxEdge?: number;
    quality?: number;
    maxBytes?: number;
}

/**
 * 长边超过 `maxEdge` 或体积超过 `maxBytes` 时，等比缩小并重编码成 JPEG。
 *
 * 只处理 png / jpeg / webp 的 base64 dataUrl；其它形态（http 地址、svg、gif、`blob:`）原样返回。
 */
export async function shrinkImageDataUrl(dataUrl: string, options: ShrinkImageOptions = {}): Promise<string> {
    const text = String(dataUrl || "");
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(text)) return text;
    const maxEdge = options.maxEdge ?? MOCHIANI_IMAGE_MAX_EDGE;
    const quality = options.quality ?? MOCHIANI_IMAGE_QUALITY;
    const maxBytes = options.maxBytes ?? MOCHIANI_IMAGE_MAX_BYTES;
    if (approximateBytes(text) <= maxBytes && maxEdge <= 0) return text;

    let bitmap: ImageBitmap | null = null;
    try {
        const blob = await (await fetch(text)).blob();
        if (!blob.size) return text;
        bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        // 又小又不大：不折腾（重编码只会改像素值，没有收益）
        if (scale >= 1 && blob.size <= maxBytes) return text;

        const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
        const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return text;
        // 透明 PNG 直接转 JPEG 会把透明区变黑（视频里就是一圈黑边），先铺白底
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

        const encoded = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, "image/jpeg", quality);
        });
        if (!encoded?.size) return text;
        // 编码反而更大（极小的图会出现）：保留原图
        if (encoded.size >= blob.size) return text;
        const shrunk = await blobToDataUrl(encoded);
        return shrunk.startsWith("data:image/") ? shrunk : text;
    } catch {
        // 浏览器不支持 createImageBitmap / 图已失效 / canvas 被污染 —— 一律不阻断发送
        return text;
    } finally {
        bitmap?.close?.();
    }
}

/** 一批图并发减重，**顺序不变**（顺序 = 文案里 `@图片N` 的下标，绝不能乱）。 */
export async function shrinkImageDataUrls(list: string[], options: ShrinkImageOptions = {}): Promise<string[]> {
    return Promise.all((Array.isArray(list) ? list : []).map((item) => shrinkImageDataUrl(item, options)));
}
