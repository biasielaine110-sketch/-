/**
 * 视频字节的**容器嗅探** —— 回答一个问题：浏览器 `<video>` 到底能不能打开这条文件？
 *
 * 为什么需要：Chrome 对「不是容器 / 容器残缺 / 容器不支持」一律只报一句
 * `PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`，
 * 用户看到的就是「视频无法播放，请重新生成」——而真因可能只是**下载被截断**（上游任务已经成功、
 * 钱已经扣了），让他重新生成是纯损失。
 *
 * 这里把那一句拆成可定位的结论：GIF 预览 / MPEG-TS / AVI / HTML 错误页 / JSON 报错体 /
 * MP4 缺 moov（截断）/ HEVC 编码。判定只看字节结构，不看文件名和 content-type —— 上游把
 * GIF 叫 `.mp4`、把错误页叫 `video/mp4` 都发生过。
 *
 * 🔴 判据是 MP4 的 box 结构，不是文件大小：
 *   · 第 4–8 字节必须是 `ftyp`；
 *   · 必须有 `moov`（轨道/时长索引）。Lavf 默认先写 `mdat` 再写 `moov`，
 *     所以**被截断的下载恰恰缺 moov** —— 这一条正好对上那个 demuxer 报错；
 *   · `moov` 可能在头（faststart）也可能在尾，所以头尾各扫 1MB。
 */

export type VideoContainerKind = "mp4" | "webm" | "gif" | "mpegts" | "avi" | "html" | "json" | "empty" | "unknown";

export type VideoCodec = "h264" | "hevc" | "av1" | "vp9" | "unknown";

export type VideoContainerInfo = {
    kind: VideoContainerKind;
    size: number;
    /** 只有 mp4 有意义：找不到 moov 就是「下载被截断」。 */
    hasMoov: boolean;
    codec: VideoCodec;
    /** 头 8 字节的十六进制，`unknown` 时拿它报错。 */
    magic: string;
};

/**
 * 头尾各扫这么多；moov 在尾部时也能扫到，同时不至于把整条 100MB 片子读进内存。
 *
 * 🔴 窗口不能太小：长片的 moov 盒子本身可能好几 MB，只扫尾部 1MB 会**扫不到盒子头**，
 * 把一条完整片子误判成「缺 moov = 下载截断」。所以小文件（≤12MB，绝大多数 AI 成片）
 * 直接整读，大文件才退回头尾各 4MB。
 */
const PROBE_BYTES = 4 << 20;
const WHOLE_READ_LIMIT = 12 << 20;

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
    if (bytes.length < offset + text.length) return false;
    for (let index = 0; index < text.length; index += 1) {
        if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
    if (bytes.length < text.length) return false;
    const first = text.charCodeAt(0);
    const last = bytes.length - text.length;
    for (let index = 0; index <= last; index += 1) {
        if (bytes[index] !== first) continue;
        if (asciiAt(bytes, index, text)) return true;
    }
    return false;
}

/** 文本响应（401 的 JSON、代理的错误页）不可能是视频。跳过 BOM 与空白看第一个有效字节。 */
function sniffTextPayload(head: Uint8Array): "html" | "json" | null {
    let index = 0;
    while (index < head.length && index < 64) {
        const byte = head[index];
        // BOM / 空白 / NUL
        if (byte === 0xef || byte === 0xbb || byte === 0xbf || byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x00) {
            index += 1;
            continue;
        }
        if (byte === 0x3c) return "html";
        if (byte === 0x7b || byte === 0x5b) return "json";
        return null;
    }
    return null;
}

/** MPEG-TS：包里固定每 188 字节一个 0x47 同步字节。 */
function isMpegTransportStream(head: Uint8Array): boolean {
    if (head.length < 189 || head[0] !== 0x47) return false;
    return head[188] === 0x47;
}

/**
 * 认编码。采样区只有头尾 1MB，`stsd` 一定落在 `moov` 里，所以只要 moov 在这两段内就能认出来。
 * 顺序即优先级：同一条片子里极少同时出现两种，真出现时按 H.264 → HEVC → AV1 → VP9 排。
 */
function detectCodec(head: Uint8Array, tail: Uint8Array): VideoCodec {
    const samples = head === tail ? [head] : [head, tail];
    const has = (fourcc: string) => samples.some((bytes) => containsAscii(bytes, fourcc));
    if (has("avc1") || has("avc3")) return "h264";
    if (has("hvc1") || has("hev1")) return "hevc";
    if (has("av01")) return "av1";
    if (has("vp09") || has("V_VP9")) return "vp9";
    return "unknown";
}

export async function readVideoContainer(blob: Blob): Promise<VideoContainerInfo> {
    const size = blob?.size || 0;
    const empty: VideoContainerInfo = { kind: "empty", size, hasMoov: false, codec: "unknown", magic: "" };
    if (!size) return empty;
    // 小文件整读一份，头尾都用它；大文件才分段，别把整条片子读进内存。
    const wholeRead = size <= WHOLE_READ_LIMIT;
    const head = new Uint8Array(await blob.slice(0, wholeRead ? size : PROBE_BYTES).arrayBuffer());
    const tail = wholeRead ? head : new Uint8Array(await blob.slice(size - PROBE_BYTES).arrayBuffer());
    const magic = Array.from(head.slice(0, 8))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ");
    const base = { size, hasMoov: false, codec: "unknown" as VideoCodec, magic };

    const textKind = sniffTextPayload(head);
    if (textKind) return { ...base, kind: textKind };
    if (asciiAt(head, 0, "GIF8")) return { ...base, kind: "gif" };
    if (asciiAt(head, 0, "RIFF") && asciiAt(head, 8, "AVI ")) return { ...base, kind: "avi" };
    if (isMpegTransportStream(head)) return { ...base, kind: "mpegts" };
    // EBML：WebM / MKV 共用同一个魔数，靠魔数只能认到这一层。
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
        return { ...base, kind: "webm", codec: detectCodec(head, head) };
    }
    if (asciiAt(head, 4, "ftyp")) {
        const hasMoov = containsAscii(head, "moov") || containsAscii(tail, "moov");
        return { ...base, kind: "mp4", hasMoov, codec: detectCodec(head, tail) };
    }
    return { ...base, kind: "unknown" };
}

/**
 * 用一句中文说清「这条片子为什么播不了」。**可播就返回空串** —— 调用方拿它做唯一判据，
 * 不要再自己写第二套规则。
 */
export function describeVideoContainer(info: VideoContainerInfo): string {
    switch (info.kind) {
        case "empty":
            return "拿到的是 0 字节的空文件";
        case "html":
            return "拿到的是网页 HTML（多半是代理或鉴权返回的错误页），不是视频文件";
        case "json":
            return "拿到的是 JSON 报错体，不是视频文件";
        case "gif":
            return "拿到的是 GIF 预览图，不是最终 MP4 —— VHS 的输出格式要设成 video/h264-mp4";
        case "mpegts":
            return "拿到的是 MPEG-TS 流（.ts），浏览器 <video> 不能直接播，需要先转封装成 MP4";
        case "avi":
            return "拿到的是 AVI，浏览器不能播，需要先转成 MP4";
        case "mp4":
            if (!info.hasMoov) {
                return `MP4 缺少 moov 索引 —— 文件在下载途中被截断了（只拿到 ${info.size} 字节），重新取一次成片即可，不用重新生成`;
            }
            if (info.codec === "hevc") {
                return "这条是 H.265/HEVC 编码，Chrome 没装系统 HEVC 扩展时无法解码，生成时请选 H.264";
            }
            return "";
        case "unknown":
            return info.magic ? `不是可识别的视频容器（头 8 字节 ${info.magic}）` : "不是可识别的视频容器";
        default:
            // webm：Chrome 能播，别拦。
            return "";
    }
}

export function isBrowserPlayableVideo(info: VideoContainerInfo): boolean {
    return describeVideoContainer(info) === "";
}

/** 容器对应的正确 MIME。上游把 WebM 写成 `application/octet-stream` 时，别再一律贴成 video/mp4。 */
export function videoMimeForContainer(info: VideoContainerInfo): string {
    if (info.kind === "mp4") return "video/mp4";
    if (info.kind === "webm") return "video/webm";
    return "";
}

/**
 * 入库前的闸门：不可播就地抛错，**绝不把假 mp4 存进库里**。
 * 存进去的代价是「画布看起来好了、点播放才炸」，用户还得重生成一次才敢相信。
 */
export async function assertBrowserPlayableVideo(blob: Blob, label = "视频"): Promise<VideoContainerInfo> {
    const info = await readVideoContainer(blob);
    const problem = describeVideoContainer(info);
    if (problem) throw new Error(`${label}无法播放：${problem}`);
    return info;
}
