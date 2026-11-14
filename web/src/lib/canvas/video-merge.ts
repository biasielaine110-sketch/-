import { CanvasNodeType, type CanvasNodeData, type CanvasVideoMergeClip } from "@/types/canvas";

/** 图片没有源时长，进时间线时先按这个长度占位。 */
export const DEFAULT_IMAGE_HOLD_SEC = 3;
/** 一段素材最短能裁到多长 —— 低于这个值剪映会当成空片段。 */
export const MIN_MERGE_CLIP_SEC = 0.1;
/** 画幅选项：original = 跟随第一段素材。 */
export const VIDEO_MERGE_ASPECTS = ["original", "16:9", "9:16", "1:1"] as const;
export type VideoMergeAspect = (typeof VIDEO_MERGE_ASPECTS)[number];

export const VIDEO_MERGE_ASPECT_SIZES: Record<Exclude<VideoMergeAspect, "original">, { width: number; height: number }> = {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1080, height: 1080 },
};

/** 组件层用的「已解析素材」：clip 是排好序的元数据，其余是从源节点读出来的展示信息。 */
export type ResolvedVideoMergeClip = {
    clip: CanvasVideoMergeClip;
    url: string;
    storageKey?: string;
    width?: number;
    height?: number;
    /** 源节点已删除 / 内容被清空 —— 时间线上保留占位，导出时跳过。 */
    missing: boolean;
};

export function roundSeconds(value: number) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

export function mediaSeconds(durationMs?: number) {
    const value = Number(durationMs) || 0;
    return value > 0 ? value / 1000 : 0;
}

/**
 * 能不能被「X 拾取」收进视频合并节点。
 *
 * 只看视频 / 图片 / **MochiAni** 节点，而且必须已经有内容（storageKey 或 content 任一）；
 * 空壳节点拾取进去只会占一行却导不出文件。
 *
 * MochiAni 为什么要算进来（用户 2026-11-10 第 01 条）：脚本链路的「每段一个生视频窗口」可以整条换成
 * MochiAni 节点，而这些节点的输出仍然要接进一个视频合并节点。MochiAni 生成完成后会把媒体引用
 * **镜像到自己身上**（`createBridgeVideoNode` 的 `hostNodeId`），所以判据与视频节点完全一致 ——
 * 没跑之前同样是空壳、同样只占位不导出。
 */
export function isVideoMergeSourceNode(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Mochiani) return false;
    return Boolean(node.metadata?.storageKey || node.metadata?.content);
}

/**
 * 由源节点生成一段默认的裁剪区间：视频取整段，图片按默认时长占位。
 * `durationSec` 允许外部（导出前探测到的真实时长）覆盖节点上记录的时长。
 *
 * MochiAni 与视频节点同一档（`kind: "video"`）：它产出的就是一段视频。
 */
export function videoMergeClipFromNode(node: CanvasNodeData, durationSec?: number): CanvasVideoMergeClip | null {
    if (!isVideoMergeSourceNode(node)) return null;
    const kind = node.type === CanvasNodeType.Image ? "image" : "video";
    if (kind === "image") {
        return {
            nodeId: node.id,
            kind,
            title: node.title || node.id,
            durationSec: 0,
            inSec: 0,
            outSec: DEFAULT_IMAGE_HOLD_SEC,
        };
    }
    const source = roundSeconds(Number(durationSec) || mediaSeconds(node.metadata?.durationMs));
    return {
        nodeId: node.id,
        kind,
        title: node.title || node.id,
        durationSec: source || undefined,
        inSec: 0,
        // 时长还没测出来时先给个 1 秒，节点上会自己探测真实时长再回填。
        outSec: source > 0 ? source : 1,
        // 拾取进来的段默认「跟随源片真实时长」（用户 2026-11-14）：节点上测出几秒就是几秒，
        // 不靠 `metadata.durationMs` 猜 —— 那个值在老数据 / 别的通道写进来的片子上经常是空的或过期的。
        autoDuration: true,
    };
}

/** 一段在时间线上实际占的长度。 */
export function clipLengthSec(clip: CanvasVideoMergeClip) {
    return Math.max(0, roundSeconds(clip.outSec - clip.inSec));
}

export function totalMergeLengthSec(clips: readonly CanvasVideoMergeClip[]) {
    return roundSeconds(clips.reduce((sum, clip) => sum + clipLengthSec(clip), 0));
}

/**
 * 把任意（用户手输 / 旧数据 / 探测回填）的区间收进合法范围。
 *
 * 图片只夹最小长度，不设上限；视频必须落在 [0, 源时长] 内，且长度 ≥ MIN_MERGE_CLIP_SEC。
 * 源时长未知（0）时按用户给的值算上限，避免把区间压成负数。
 */
export function normalizeMergeClip(clip: CanvasVideoMergeClip): CanvasVideoMergeClip {
    const rawIn = Math.max(0, Number(clip.inSec) || 0);
    const rawOut = Math.max(0, Number(clip.outSec) || 0);
    if (clip.kind === "image") {
        return { ...clip, inSec: 0, outSec: roundSeconds(Math.max(MIN_MERGE_CLIP_SEC, rawOut || DEFAULT_IMAGE_HOLD_SEC)) };
    }
    const source = Math.max(0, Number(clip.durationSec) || 0);
    const limit = source > 0 ? source : Math.max(rawOut, rawIn + MIN_MERGE_CLIP_SEC);
    const inSec = roundSeconds(Math.min(rawIn, Math.max(0, limit - MIN_MERGE_CLIP_SEC)));
    const outSec = roundSeconds(Math.min(Math.max(rawOut, inSec + MIN_MERGE_CLIP_SEC), limit));
    return { ...clip, inSec, outSec };
}

export function normalizeMergeClips(clips: readonly CanvasVideoMergeClip[]) {
    return clips.map(normalizeMergeClip);
}

/**
 * 这一段要不要「按源片真实时长」对齐（用户 2026-11-14：
 * 「视频合并的每段的时间以拾取视频的实际时长为准，即拾取的视频为几秒那么视频合并的段落时长就是几秒」）。
 *
 * 三条互斥的来历：
 *  - `autoDuration === true`  → 拾取 / 铺链路写进来的，跟随源片；
 *  - `autoDuration === false` → 用户手动调过入出点，别覆盖；
 *  - 不写（老数据）→ 只认「还没有已知时长」的段（铺链路的占位段、老节点），
 *    已经有 `durationSec` 的旧时间线不动 —— 用户可能早就裁好了，不能因为这次升级把区间全拉回整段。
 */
export function mergeClipFollowsSource(clip: CanvasVideoMergeClip) {
    if (clip.kind !== "video") return false;
    if (clip.autoDuration === false) return false;
    const known = Math.max(0, Number(clip.durationSec) || 0);
    if (known > 0) return clip.autoDuration === true;
    return clip.autoDuration === true || clip.inSec === 0;
}

/**
 * 测出真实时长后把这一段对齐成「整段」：`inSec = 0`、`outSec = 真实时长`、`durationSec = 真实时长`。
 *
 * 不跟随源片的段（图片 / 用户手动裁过的）原样返回，调用方可以直接拿返回值做「有没有变化」的比较。
 */
export function applyMergeClipSourceDuration(clip: CanvasVideoMergeClip, seconds: number): CanvasVideoMergeClip {
    if (!mergeClipFollowsSource(clip)) return clip;
    const real = roundSeconds(Number(seconds) || 0);
    if (!(real > 0)) return clip;
    return normalizeMergeClip({ ...clip, autoDuration: true, durationSec: real, inSec: 0, outSec: real });
}

/** 用户手动裁过这一段 → 打上「别再自动对齐」的标记（入点 / 出点 / 设入点 / 设出点 都走它）。 */
export function markMergeClipTrimmed(clip: CanvasVideoMergeClip): CanvasVideoMergeClip {
    return clip.autoDuration === false ? clip : { ...clip, autoDuration: false };
}

/** 「整段」按钮：区间回到整段，并且重新跟随源片真实时长。 */
export function resetMergeClipToFull(clip: CanvasVideoMergeClip): CanvasVideoMergeClip {
    const full = Math.max(0, Number(clip.durationSec) || 0) || clip.outSec;
    return normalizeMergeClip({ ...clip, autoDuration: clip.kind === "video", inSec: 0, outSec: full });
}

/**
 * 整条时间线上每一段占的区间。
 *
 * 「整条显示」只有一条时间线：每段按 `outSec - inSec` 首尾相接排上去，进度条、播放头、
 * 点哪跳哪全用这一份口径算 —— 不能一处按 real 长度、一处按等分，否则播放头会跑偏。
 */
export type MergeClipSpan = { index: number; startSec: number; lengthSec: number };

export function resolveMergeSpans(clips: readonly CanvasVideoMergeClip[]) {
    let cursor = 0;
    const spans: MergeClipSpan[] = clips.map((clip, index) => {
        // 和播放器一致：短于 MIN 的段在时间线上仍占 MIN，否则播放头会卡住不动。
        const lengthSec = Math.max(MIN_MERGE_CLIP_SEC, clipLengthSec(clip));
        const span = { index, startSec: roundSeconds(cursor), lengthSec: roundSeconds(lengthSec) };
        cursor += lengthSec;
        return span;
    });
    return { spans, totalSec: roundSeconds(cursor) };
}

/** 整条时间线上的 `sec` 落在哪一段、段内偏移多少；越界一律夹到首尾。 */
export function locateMergePosition(spans: readonly MergeClipSpan[], totalSec: number, sec: number) {
    const last = spans[spans.length - 1];
    if (!last) return { index: 0, offsetSec: 0 };
    const clamped = Math.min(Math.max(0, Number(sec) || 0), Math.max(0, Number(totalSec) || 0));
    for (const span of spans) {
        if (clamped < span.startSec + span.lengthSec) return { index: span.index, offsetSec: roundSeconds(clamped - span.startSec) };
    }
    return { index: last.index, offsetSec: last.lengthSec };
}

/**
 * 从 `from` 起第一段「真能播」的段。
 *
 * 源节点被删 / 内容被清空的段在时间线上留着占位，但它没有 url 也没 ended 事件，
 * 播放器一旦停在那一段就再也走不动 —— 所以任何切换都必须过这一层。
 * 返回 -1 表示后面没有能播的了。
 */
export function nextPlayableMergeIndex(clips: ReadonlyArray<{ url: string; missing: boolean }>, from: number) {
    let index = Math.max(0, Math.floor(Number(from) || 0));
    while (index < clips.length) {
        const item = clips[index];
        if (item?.url && !item.missing) return index;
        index += 1;
    }
    return -1;
}

export function moveMergeClip<T>(clips: readonly T[], from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return [...clips];
    const next = [...clips];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function removeMergeClip<T>(clips: readonly T[], index: number) {
    return clips.filter((_, itemIndex) => itemIndex !== index);
}

/** `m:ss.s` —— 时间线上够用的精度，不再往毫秒走。 */
export function formatMergeClock(seconds: number) {
    const total = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** 导出文件名用的安全标题：去掉路径/保留字符，压掉空白，限长。 */
export function mergeClipFileBase(title: string, index: number, kind: "video" | "image") {
    const cleaned = String(title || "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    const prefix = String(index + 1).padStart(2, "0");
    return `${prefix}_${cleaned || (kind === "video" ? "clip" : "image")}`;
}

/**
 * 用隐藏的 `<video>` 探一次真实时长与像素尺寸。
 *
 * 为什么需要：视频节点的 `metadata.durationMs` 是老数据 / 别的通道写进来的，偶尔为空；
 * 而裁剪必须有上限，否则用户可以拖到超出源片尾，剪映会拿到空片段。
 * 尺寸则要给剪映草稿的素材用 —— 画布上的节点尺寸是缩放后的显示尺寸，不能直接当像素尺寸。
 */
export function probeVideoMeta(url: string): Promise<{ durationSec: number; width: number; height: number }> {
    if (!url) return Promise.resolve({ durationSec: 0, width: 0, height: 0 });
    return new Promise((resolve) => {
        const video = document.createElement("video");
        let settled = false;
        const finish = (durationSec: number) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
            const width = video.videoWidth || 0;
            const height = video.videoHeight || 0;
            try {
                video.removeAttribute("src");
                video.load();
            } catch {
                // 浏览器已卸载元素 —— 无所谓，我们只为拿一组数字。
            }
            resolve({ durationSec: seconds, width, height });
        };
        const timer = window.setTimeout(() => finish(0), 8000);
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => finish(video.duration);
        video.onerror = () => finish(0);
        video.src = url;
    });
}

export function probeMediaDuration(url: string) {
    return probeVideoMeta(url).then((meta) => meta.durationSec);
}

/** 图片素材的真实像素尺寸；`createImageBitmap` 不可用时退到节点显示尺寸。 */
export async function probeImageSize(blob: Blob, fallback: { width?: number; height?: number }) {
    const fallbackSize = { width: Math.max(2, Math.round(Number(fallback.width) || 1920)), height: Math.max(2, Math.round(Number(fallback.height) || 1080)) };
    if (typeof createImageBitmap !== "function") return fallbackSize;
    try {
        const bitmap = await createImageBitmap(blob);
        const size = { width: bitmap.width || fallbackSize.width, height: bitmap.height || fallbackSize.height };
        bitmap.close?.();
        return size;
    } catch {
        return fallbackSize;
    }
}

/**
 * 尽力抠一张封面。
 *
 * 剪映 7.0+ 收紧了封面校验，缺 `draft_cover` 更容易被判成草稿损坏。图片直接画；视频 seek 到
 * 第一帧附近再画。超时 / 跨域失败一律返回 null —— 没有封面也能打开，只是风险高一点。
 */
export function captureMergeCover(url: string, kind: "video" | "image", timeoutMs = 4000): Promise<Blob | null> {
    if (!url) return Promise.resolve(null);
    return new Promise<Blob | null>((resolve) => {
        let settled = false;
        let video: HTMLVideoElement | null = null;
        let timer = 0;
        const finish = (blob: Blob | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            if (video) {
                try {
                    video.removeAttribute("src");
                    video.load();
                } catch {
                    // 元素可能已被回收。
                }
            }
            resolve(blob);
        };
        const draw = (source: CanvasImageSource, width: number, height: number) => {
            try {
                const scale = Math.min(1, 960 / Math.max(1, width, height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(2, Math.round((width || 1920) * scale));
                canvas.height = Math.max(2, Math.round((height || 1080) * scale));
                const ctx = canvas.getContext("2d");
                if (!ctx) return finish(null);
                ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.85);
            } catch {
                finish(null);
            }
        };
        timer = window.setTimeout(() => finish(null), timeoutMs);
        if (kind === "image") {
            const image = new Image();
            image.onload = () => draw(image, image.naturalWidth, image.naturalHeight);
            image.onerror = () => finish(null);
            image.src = url;
            return;
        }
        const element = document.createElement("video");
        video = element;
        element.preload = "auto";
        element.muted = true;
        element.onloadeddata = () => {
            try {
                element.currentTime = Math.min(0.1, Math.max(0, element.duration / 2));
            } catch {
                draw(element, element.videoWidth, element.videoHeight);
            }
        };
        element.onseeked = () => draw(element, element.videoWidth, element.videoHeight);
        element.onerror = () => finish(null);
        element.src = url;
    });
}

/** 画布尺寸：original 跟随第一段素材（长边压到 1920），其余走固定表。 */
export function resolveMergeCanvasSize(aspect: string | null | undefined, sizes: ReadonlyArray<{ width?: number; height?: number }>) {
    const fixed = VIDEO_MERGE_ASPECT_SIZES[String(aspect) as Exclude<VideoMergeAspect, "original">];
    if (fixed) return { ...fixed };
    const picked = sizes.find((item) => (Number(item.width) || 0) > 0 && (Number(item.height) || 0) > 0);
    if (!picked) return { width: 1920, height: 1080 };
    const width = Number(picked.width) || 1920;
    const height = Number(picked.height) || 1080;
    const scale = Math.min(1, 1920 / Math.max(width, height));
    return { width: evenSize(width * scale), height: evenSize(height * scale) };
}

/** 剪映对奇数分辨率不友好（编码器要求偶数）。 */
function evenSize(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * 落盘扩展名。
 *
 * 素材是按 blob 存的，`type` 偶尔是 `application/octet-stream`（ComfyUI /view 就是这样）；
 * 那种情况按节点类型给个保守默认值，剪映靠内容嗅探也能认。
 */
export function mediaExtension(mimeType: string, kind: "video" | "image") {
    const type = String(mimeType || "").toLowerCase();
    if (type.includes("quicktime")) return "mov";
    if (type.includes("webm")) return "webm";
    if (type.includes("matroska")) return "mkv";
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    return kind === "image" ? "png" : "mp4";
}
