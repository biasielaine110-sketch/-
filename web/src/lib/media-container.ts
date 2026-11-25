/**
 * 视频字节的**容器嗅探** —— 回答一个问题：浏览器 `<video>` 到底能不能打开这条文件？
 *
 * 为什么需要：Chrome 对「不是容器 / 容器残缺 / 容器不支持 / 编码不支持」只给两句很含糊的话：
 *  · `PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`（容器打不开）
 *  · `MEDIA_ELEMENT_ERROR: Format error`（= `MEDIA_ERR_SRC_NOT_SUPPORTED`：容器认得，但流不被支持）
 * 用户看到的就是「视频无法播放」——而真因可能只是**下载被截断**（上游任务已经成功、钱已经扣了），
 * 让他重新生成是纯损失。
 *
 * 三层判定，逐层加细：
 *  ① **魔数**：GIF / MPEG-TS / AVI / WebM / HTML 错误页 / JSON 报错体 / 0 字节；
 *  ② **盒结构**（MP4 顶层 box 链）：有没有 `moov`；声明长度超过实际字节 = **被截断**
 *     （这一条能抓到 `moov` 在头、`mdat` 被截断的情况 —— 旧实现只看「有没有 moov」，会漏）；
 *  ③ **轨道表**（`moov → trak → mdia → hdlr/minf/stbl/stsd`）：视频编码、音轨编码、
 *     H.264 的 `avcC` 档次（High 10 / 4:2:2 / 4:4:4 在 Chrome 里同样是 `Format error`）。
 *
 * 🔴 判据只看字节结构，不看文件名和 content-type —— 上游把 GIF 叫 `.mp4`、把错误页叫
 * `video/mp4` 都发生过。
 * 🔴 结构解析全程**防御式**：任何一步读不通就退回上一层结论，绝不因为「解析器不懂」把一条
 * 能播的片子判死（真的判死 = 用户白花一次生成费）。
 */

export type VideoContainerKind = "mp4" | "webm" | "gif" | "mpegts" | "avi" | "html" | "json" | "empty" | "unknown";

export type VideoCodec = "h264" | "hevc" | "av1" | "vp9" | "vp8" | "prores" | "mpeg4" | "mjpeg" | "dolby-vision" | "unknown";

export type AudioCodec = "aac" | "mp3" | "opus" | "flac" | "alac" | "ac3" | "eac3" | "dts" | "pcm" | "none" | "unknown";

export type VideoContainerInfo = {
    kind: VideoContainerKind;
    size: number;
    /** 只有 mp4 有意义：找不到 moov 就是「下载被截断」。 */
    hasMoov: boolean;
    /** 视频编码（历史字段名，等于 `videoCodec`）。 */
    codec: VideoCodec;
    videoCodec: VideoCodec;
    /** `none` = 轨道表里确实没有音轨；`unknown` = 没解析出轨道表，不做判断。 */
    audioCodec: AudioCodec;
    /** H.264 的 `profile_idc`（66 baseline / 77 main / 100 high / 110 high10 / 122 high422 / 244 high444）。 */
    h264Profile?: number;
    /** MP4 盒结构声明长度 > 实际字节：下载被截断。 */
    truncated: boolean;
    /** 截断时「按盒声明本应有多少字节」。 */
    declaredSize?: number;
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

/** Chrome 能解的 H.264 档次（8bit 4:2:0）。110 / 122 / 144 / 244 全会 `Format error`。 */
const PLAYABLE_H264_PROFILES = new Set([66, 77, 88, 100]);

const H264_PROFILE_NAMES: Record<number, string> = {
    66: "Baseline",
    77: "Main",
    88: "Extended",
    100: "High",
    110: "High 10",
    122: "High 4:2:2",
    144: "High 4:4:4",
    244: "High 4:4:4 Predictive",
};

const VIDEO_FOURCC: Record<string, VideoCodec> = {
    avc1: "h264",
    avc3: "h264",
    hvc1: "hevc",
    hev1: "hevc",
    av01: "av1",
    vp09: "vp9",
    vp08: "vp9",
    ap4h: "prores",
    apch: "prores",
    apcn: "prores",
    apcs: "prores",
    apco: "prores",
    ap4x: "prores",
    mp4v: "mpeg4",
    mjpa: "mjpeg",
    mjpb: "mjpeg",
    dvh1: "dolby-vision",
    dvhe: "dolby-vision",
};

const AUDIO_FOURCC: Record<string, AudioCodec> = {
    mp4a: "aac",
    ".mp3": "mp3",
    "mp3 ": "mp3",
    Opus: "opus",
    fLaC: "flac",
    alac: "alac",
    "ac-3": "ac3",
    "ec-3": "eac3",
    dtsc: "dts",
    dtsh: "dts",
    dtsl: "dts",
    lpcm: "pcm",
    sowt: "pcm",
    twos: "pcm",
};

const VIDEO_CODEC_LABELS: Record<VideoCodec, string> = {
    h264: "H.264",
    hevc: "H.265/HEVC",
    av1: "AV1",
    vp9: "VP9",
    vp8: "VP8",
    prores: "ProRes",
    mpeg4: "MPEG-4",
    mjpeg: "MJPEG",
    "dolby-vision": "Dolby Vision",
    unknown: "编码未知",
};

const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
    aac: "AAC",
    mp3: "MP3",
    opus: "Opus",
    flac: "FLAC",
    alac: "ALAC",
    ac3: "AC-3",
    eac3: "E-AC-3",
    dts: "DTS",
    pcm: "PCM",
    none: "无音轨",
    unknown: "音轨未知",
};

/** 浏览器解不了的视频编码 → 一句人话。`h264/av1/vp9/vp8` 不在这里（能播）。 */
function videoCodecProblem(codec: VideoCodec): string {
    switch (codec) {
        case "hevc":
            return "这条是 H.265/HEVC 编码，Chrome 没装系统 HEVC 扩展时无法解码（就是 Format error），生成时请选 H.264";
        case "prores":
            return "这条是 ProRes 编码（剪辑中间格式），浏览器不能播，需要转成 H.264 MP4";
        case "mpeg4":
            return "这条是 MPEG-4 Part 2 编码（不是 H.264），Chrome 不能播，需要转成 H.264 MP4";
        case "mjpeg":
            return "这条是 Motion JPEG 编码，Chrome 不能播，需要转成 H.264 MP4";
        case "dolby-vision":
            return "这条是 Dolby Vision（杜比视界），Chrome 不能播，需要转成 H.264 SDR MP4";
        default:
            return "";
    }
}

/** 浏览器解不了的音轨编码 → 一句人话（画面没问题、只是音轨拖累整条播不了）。 */
function audioCodecProblem(codec: AudioCodec): string {
    switch (codec) {
        case "ac3":
        case "eac3":
            return `音轨是 ${AUDIO_CODEC_LABELS[codec]}（杜比数字），Chrome 不能播 —— 整条视频会直接 Format error，需要让它输出 AAC 音轨`;
        case "dts":
            return "音轨是 DTS，Chrome 不能播 —— 需要让它输出 AAC 音轨";
        case "alac":
            return "音轨是 ALAC（Apple 无损），Chrome 不能播 —— 需要让它输出 AAC 音轨";
        case "pcm":
            return "音轨是 PCM（MP4 里塞未压缩音频），Chrome 播不了 —— 需要让它输出 AAC 音轨";
        default:
            return "";
    }
}

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

function u16(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u64(bytes: Uint8Array, offset: number): number {
    return u32(bytes, offset) * 4294967296 + u32(bytes, offset + 4);
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

// ── MP4 盒结构 ────────────────────────────────────────────────────────────────

type Box = { type: string; start: number; size: number; bodyStart: number; end: number };

function boxTypeAt(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** box type 必须是 4 个可打印字符：二进制垃圾（`\0\0\0\0`）会被挡掉，链条到此为止。 */
function isPrintableType(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 0x20 || code > 0x7e) return false;
    }
    return true;
}

/**
 * 走一遍顶层 box 链。三种结果：
 *  · `truncated` = 某个盒子声明 `end > fileSize`（**这是真截断**，最可信的一条判据）；
 *  · `broken` = 遇到非盒子头（垃圾 / 我们的探测窗口不够），**不下结论**；
 *  · 正常走完 = 结构完整。
 */
function walkBoxes(bytes: Uint8Array, from: number, limit: number, fileSize: number): { boxes: Box[]; truncated: boolean; declaredSize: number; broken: boolean } {
    const boxes: Box[] = [];
    let offset = from;
    while (offset + 8 <= limit && offset < fileSize) {
        const size32 = u32(bytes, offset);
        const type = boxTypeAt(bytes, offset + 4);
        if (!isPrintableType(type)) return { boxes, truncated: false, declaredSize: 0, broken: true };
        let header = 8;
        let size = size32;
        if (size32 === 1) {
            if (offset + 16 > limit) return { boxes, truncated: false, declaredSize: 0, broken: true };
            size = u64(bytes, offset + 8);
            header = 16;
        } else if (size32 === 0) {
            // `size === 0` = 一直到文件末尾（分片 MP4 的最后一段常见），不算截断。
            size = fileSize - offset;
        }
        if (size < header) return { boxes, truncated: false, declaredSize: 0, broken: true };
        const end = offset + size;
        boxes.push({ type, start: offset, size, bodyStart: offset + header, end });
        if (end > fileSize) return { boxes, truncated: true, declaredSize: end, broken: false };
        // 盒子尾部超出探测窗口 → 再往后读不到，结构结论到此为止（不算错）。
        if (end > limit) return { boxes, truncated: false, declaredSize: 0, broken: false };
        offset = end;
    }
    return { boxes, truncated: false, declaredSize: 0, broken: false };
}

function childBoxes(bytes: Uint8Array, parent: Box): Box[] {
    return walkBoxes(bytes, parent.bodyStart, Math.min(parent.end, bytes.length), parent.end).boxes;
}

/**
 * 轨道表：`moov → trak → mdia → (hdlr, minf → stbl → stsd)`。
 *
 * 返回第一个视频轨 / 第一个音轨的编码与 H.264 档次。
 * `complete` = 整棵 moov 的顶层子盒都读完了 —— **只有读完才敢断言「这条片子没有音轨」**；
 * 探测窗口不够 / 中途撞到垃圾时说 `complete: false`，让调用方退回 `unknown`（不下结论）。
 */
function parseTracks(bytes: Uint8Array, moov: Box): { video?: VideoCodec; audio?: AudioCodec; h264Profile?: number; complete: boolean } {
    const result: { video?: VideoCodec; audio?: AudioCodec; h264Profile?: number; complete: boolean } = { complete: false };
    let top: { boxes: Box[]; truncated: boolean; declaredSize: number; broken: boolean };
    try {
        top = walkBoxes(bytes, moov.bodyStart, Math.min(moov.end, bytes.length), bytes.length);
    } catch {
        return result;
    }
    const last = top.boxes[top.boxes.length - 1];
    result.complete = !top.broken && !top.truncated && top.boxes.length > 0 && Boolean(last) && last.end === moov.end;
    for (const trak of top.boxes.filter((box) => box.type === "trak")) {
        try {
            const mdia = childBoxes(bytes, trak).find((box) => box.type === "mdia");
            if (!mdia) continue;
            const mdiaChildren = childBoxes(bytes, mdia);
            const hdlr = mdiaChildren.find((box) => box.type === "hdlr");
            const handler = hdlr && hdlr.bodyStart + 12 <= bytes.length ? boxTypeAt(bytes, hdlr.bodyStart + 8) : "";
            const minf = mdiaChildren.find((box) => box.type === "minf");
            const stbl = minf ? childBoxes(bytes, minf).find((box) => box.type === "stbl") : undefined;
            const sampleTable = stbl ? childBoxes(bytes, stbl).find((box) => box.type === "stsd") : undefined;
            if (!sampleTable) continue;
            // stsd: version/flags(4) + entry_count(4) + entries
            const entryStart = sampleTable.bodyStart + 8;
            if (entryStart + 8 > bytes.length) continue;
            const format = boxTypeAt(bytes, entryStart + 4);
            const entrySize = u32(bytes, entryStart);
            if (handler === "vide") {
                if (result.video) continue;
                const codec = VIDEO_FOURCC[format] || "unknown";
                result.video = codec;
                if (codec === "h264") {
                    // VisualSampleEntry 固定 78 字节头（8 SampleEntry + 70 Visual）+ 子盒。
                    const configStart = entryStart + 78;
                    const configEnd = Math.min(entryStart + Math.max(entrySize, 8), bytes.length);
                    if (configStart + 8 <= configEnd) {
                        const config = walkBoxes(bytes, configStart, configEnd, configEnd).boxes.find((box) => box.type === "avcC");
                        if (config && config.bodyStart + 4 <= bytes.length) {
                            result.h264Profile = bytes[config.bodyStart + 1];
                        }
                    }
                }
            } else if (handler === "soun") {
                if (result.audio) continue;
                result.audio = AUDIO_FOURCC[format] || "unknown";
            }
        } catch {
            // 单条轨读坏 → 跳过这条，别把整条片子判死。
        }
    }
    return result;
}

/** 兜底：容器结构读不通时，按 `stsd` 里那几个 fourcc 的裸字符串认编码（旧口径，保留）。 */
function scanCodec(head: Uint8Array, tail: Uint8Array): VideoCodec {
    const samples = head === tail ? [head] : [head, tail];
    const has = (fourcc: string) => samples.some((bytes) => containsAscii(bytes, fourcc));
    if (has("avc1") || has("avc3")) return "h264";
    if (has("hvc1") || has("hev1")) return "hevc";
    if (has("av01")) return "av1";
    if (has("vp09")) return "vp9";
    if (has("ap4h") || has("apch") || has("apcn")) return "prores";
    if (has("dvh1") || has("dvhe")) return "dolby-vision";
    if (has("V_VP9")) return "vp9";
    if (has("V_VP8")) return "vp8";
    if (has("V_AV1")) return "av1";
    return "unknown";
}

export async function readVideoContainer(blob: Blob): Promise<VideoContainerInfo> {
    const size = blob?.size || 0;
    const empty: VideoContainerInfo = {
        kind: "empty",
        size,
        hasMoov: false,
        codec: "unknown",
        videoCodec: "unknown",
        audioCodec: "unknown",
        truncated: false,
        magic: "",
    };
    if (!size) return empty;
    // 小文件整读一份，头尾都用它；大文件才分段，别把整条片子读进内存。
    const wholeRead = size <= WHOLE_READ_LIMIT;
    const head = new Uint8Array(await blob.slice(0, wholeRead ? size : PROBE_BYTES).arrayBuffer());
    const tail = wholeRead ? head : new Uint8Array(await blob.slice(size - PROBE_BYTES).arrayBuffer());
    const magic = Array.from(head.slice(0, 8))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ");
    const base = { size, hasMoov: false, codec: "unknown" as VideoCodec, videoCodec: "unknown" as VideoCodec, audioCodec: "unknown" as AudioCodec, truncated: false, magic };

    const textKind = sniffTextPayload(head);
    if (textKind) return { ...base, kind: textKind };
    if (asciiAt(head, 0, "GIF8")) return { ...base, kind: "gif" };
    if (asciiAt(head, 0, "RIFF") && asciiAt(head, 8, "AVI ")) return { ...base, kind: "avi", audioCodec: "unknown" };
    if (isMpegTransportStream(head)) return { ...base, kind: "mpegts" };
    // EBML：WebM / MKV 共用同一个魔数，靠魔数只能认到这一层。
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
        const codec = scanCodec(head, head);
        return { ...base, kind: "webm", codec, videoCodec: codec };
    }
    if (asciiAt(head, 4, "ftyp")) {
        // ② 盒结构：截断判定（声明长度 > 实际字节）比「有没有 moov」更准。
        const walk = walkBoxes(head, 0, head.length, size);
        const moov = walk.boxes.find((box) => box.type === "moov");
        const hasMoov = Boolean(moov) || containsAscii(head, "moov") || containsAscii(tail, "moov");
        // ③ 轨道表：优先读 moov 里的 hdlr/stsd（能区分视频/音轨、能读 avcC 档次）。
        // 大文件 moov 在尾部时 head 里没有它 —— 此时轨道表读不到，退回扫 fourcc 认视频编码。
        const tracks = moov ? parseTracks(head, moov) : { complete: false } as { video?: VideoCodec; audio?: AudioCodec; h264Profile?: number; complete: boolean };
        const videoCodec = tracks.video || scanCodec(head, tail);
        return {
            ...base,
            kind: "mp4",
            hasMoov,
            codec: videoCodec,
            videoCodec,
            // 读完整个 moov 却只找到视频轨 = 这条片子真的没有音轨；没读全就老实说 unknown。
            audioCodec: tracks.audio || (tracks.video && tracks.complete ? "none" : "unknown"),
            h264Profile: tracks.h264Profile,
            truncated: walk.truncated,
            declaredSize: walk.truncated ? walk.declaredSize : undefined,
        };
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
        case "mp4": {
            if (!info.hasMoov) {
                return `MP4 缺少 moov 索引 —— 文件在下载途中被截断了（只拿到 ${info.size} 字节），重新取一次成片即可，不用重新生成`;
            }
            if (info.truncated) {
                return `MP4 被截断：盒结构声明应有 ${info.declaredSize} 字节，实际只有 ${info.size} 字节 —— 下载或转发中途断了（Chrome 报 Format error），重新取一次成片即可，不用重新生成`;
            }
            const codecProblem = videoCodecProblem(info.codec);
            if (codecProblem) return codecProblem;
            if (info.codec === "h264" && typeof info.h264Profile === "number" && !PLAYABLE_H264_PROFILES.has(info.h264Profile)) {
                const name = H264_PROFILE_NAMES[info.h264Profile] || `profile_idc ${info.h264Profile}`;
                return `H.264 是 ${name} 档次（profile_idc=${info.h264Profile}），Chrome 只解 8bit 4:2:0 的 Baseline/Main/High —— 换成 H.264 Baseline/Main/High 输出`;
            }
            const audioProblem = audioCodecProblem(info.audioCodec);
            if (audioProblem) return audioProblem;
            return "";
        }
        case "unknown":
            return info.magic ? `不是可识别的视频容器（头 8 字节 ${info.magic}）` : "不是可识别的视频容器";
        default:
            // webm：Chrome 能播，别拦。
            return "";
    }
}

/**
 * 「这条到底是什么」的一句摘要 —— 给**播放失败**的 toast 用（用户 2026-11-25 第 03 条：
 * 只报一句 `MEDIA_ELEMENT_ERROR: Format error` 谁也修不了）。
 *
 * `describeVideoContainer` 说「哪儿不对」，这里说「实际拿到了什么」：容器 / 视频编码 /
 * 音轨编码 / 大小。两者都为空才说明真的没线索。
 */
export function describeVideoSummary(info: VideoContainerInfo): string {
    const sizeText =
        info.size >= 1024 * 1024 ? `${(info.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(info.size / 1024))} KB`;
    const parts: string[] = [];
    if (info.kind === "mp4") {
        parts.push("MP4", VIDEO_CODEC_LABELS[info.videoCodec]);
        if (info.audioCodec !== "unknown" && info.audioCodec !== "none") parts.push(`音轨 ${AUDIO_CODEC_LABELS[info.audioCodec]}`);
        else if (info.audioCodec === "none") parts.push("无音轨");
        if (typeof info.h264Profile === "number" && info.h264Profile) {
            parts.push(`profile ${H264_PROFILE_NAMES[info.h264Profile] || info.h264Profile}`);
        }
    } else if (info.kind === "webm") {
        parts.push("WebM", VIDEO_CODEC_LABELS[info.videoCodec]);
    } else if (info.kind === "unknown") {
        parts.push(info.magic ? `未知容器（头 8 字节 ${info.magic}）` : "未知容器");
    } else {
        parts.push(info.kind.toUpperCase());
    }
    parts.push(sizeText);
    return parts.join(" · ");
}

export function isBrowserPlayableVideo(info: VideoContainerInfo): boolean {
    return describeVideoContainer(info) === "";
}

/**
 * 「再取一次成片」有没有意义。
 *
 * 只有**传输层**问题值得重取：截断 / 缺 moov / HTML 错误页 / JSON 报错体 / 0 字节。
 * 编码问题（HEVC、ProRes、AC-3 音轨…）重取一百次也是同一份字节，再取一次纯属浪费带宽和时间。
 */
export function isRetryableVideoProblem(info: VideoContainerInfo): boolean {
    if (info.kind === "mp4") return !info.hasMoov || info.truncated;
    return info.kind === "html" || info.kind === "json" || info.kind === "empty";
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
