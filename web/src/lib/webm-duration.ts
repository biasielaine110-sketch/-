/**
 * 给 `MediaRecorder` 产出的 webm 补写真实时长。
 *
 * 为什么必须做（2026-10-25 用户「画面还是坏掉的 / 卡住只有一帧 / 播不动」的根因之一）：
 *  - `MediaRecorder` 录 webm 时写的是**未知长度 Segment**，`Duration` 字段留 0（或干脆不写）；
 *  - 浏览器 `<video>.duration` 于是返回 `Infinity` —— 画布视频节点的进度条依赖它
 *    （`canvas-node.tsx:1614` 判 `Number.isFinite`），拿到 Infinity 就把时长当 0：
 *    拖动条禁用、显示 0:00，整条片子「播不动」；
 *  - 下载下来丢进 PR / 剪映 / 达芬奇也一样：没有时长 = 时间线拖不动。
 *
 * 做法：按 EBML 结构定位 `Segment → Info → Duration`，**原地改那个 float**
 * （4 字节 float32 或 8 字节 float64，Chrome 写的是 float64）。
 * 元素不存在或者结构不认识 → **原样返回**，绝不让补时长这一步把片子弄坏。
 *
 * ⚠️ 这是个**零依赖纯函数模块**，就为了能让浏览器端 e2e 直接 import 测（`crop-live` 会把它 bundle 成 IIFE）。
 */
const EBML_ID = {
    segment: 0x18538067,
    info: 0x1549a966,
    cluster: 0x1f43b675,
    timecodeScale: 0x2ad7b1,
    duration: 0x4489,
} as const;

/** TimecodeScale 缺省值：1_000_000 ns = 1 ms/单位（此时 Duration 的数值就等于毫秒数）。 */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

type Vint = { length: number; value: number; unknown: boolean };

/** 读一个 EBML 变长整数（长度由首字节的标记位决定，值里**去掉**标记位）。 */
function readVint(bytes: Uint8Array, offset: number): Vint | null {
    const first = bytes[offset];
    if (!first) return null; // 0x00 不可能出现在 vint 首字节
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length += 1;
    }
    if (length > 8) return null;
    let value = first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < length; i += 1) {
        const next = bytes[offset + i];
        if (next === undefined) return null;
        value = value * 256 + next;
        if (next !== 0xff) allOnes = false;
    }
    return { length, value, unknown: allOnes };
}

/** 读一个 EBML 元素 ID（**保留**标记位，这是 ID 的规范写法）。 */
function readId(bytes: Uint8Array, offset: number): { length: number; id: number } | null {
    const first = bytes[offset];
    if (!first) return null;
    let length = 1;
    let mask = 0x80;
    while (length <= 4 && (first & mask) === 0) {
        mask >>= 1;
        length += 1;
    }
    if (length > 4) return null;
    let id = 0;
    for (let i = 0; i < length; i += 1) {
        const next = bytes[offset + i];
        if (next === undefined) return null;
        id = id * 256 + next;
    }
    return { length, id };
}

type DurationSlot = { valueOffset: number; size: number; scale: number };

type InfoBox = { start: number; idLength: number; payloadStart: number; payloadEnd: number; end: number };

/** 定位 Segment 的第一个子元素 Info，返回它的边界（重写用）。 */
export function locateWebmInfo(bytes: Uint8Array): InfoBox | null {
    const headerId = readId(bytes, 0);
    if (!headerId || headerId.id !== 0x1a45dfa3) return null;
    const headerSize = readVint(bytes, headerId.length);
    if (!headerSize || headerSize.unknown) return null;
    let pos = headerId.length + headerSize.length + headerSize.value;

    const segmentId = readId(bytes, pos);
    if (!segmentId || segmentId.id !== EBML_ID.segment) return null;
    const segmentSize = readVint(bytes, pos + segmentId.length);
    if (!segmentSize) return null;
    pos += segmentId.length + segmentSize.length;
    const segmentEnd = segmentSize.unknown ? bytes.length : Math.min(bytes.length, pos + segmentSize.value);

    while (pos < segmentEnd) {
        const id = readId(bytes, pos);
        if (!id) return null;
        const size = readVint(bytes, pos + id.length);
        if (!size) return null;
        const payloadStart = pos + id.length + size.length;
        const payloadEnd = Math.min(segmentEnd, payloadStart + size.value);
        if (id.id === EBML_ID.info) return { start: pos, idLength: id.length, payloadStart, payloadEnd, end: payloadEnd };
        if (id.id === EBML_ID.cluster) return null; // Info 一定在 Cluster 之前
        pos = payloadEnd;
    }
    return null;
}

/**
 * 文件里有没有**绝对偏移引用**（`SeekHead` / `Cues`）。
 *
 * 插入 Duration 会让 Info 之后的所有字节后移，这些引用就会指错位置。`MediaRecorder`
 * 边录边写（live 模式）不会写它们，所以正常情况返回 `false`；一旦探测到就放弃插入，
 * 宁可不补时长，也不给一个 seek 指针全错的文件。
 */
export function hasWebmOffsetReferences(bytes: Uint8Array): boolean {
    const patterns = [
        [0x11, 0x4d, 0x9b, 0x74], // SeekHead
        [0x1c, 0x53, 0xbb, 0x6b], // Cues
    ];
    for (const pattern of patterns) {
        outer: for (let i = 0; i + pattern.length <= bytes.length; i += 1) {
            for (let j = 0; j < pattern.length; j += 1) {
                if (bytes[i + j] !== pattern[j]) continue outer;
            }
            return true;
        }
    }
    return false;
}

/** 最小长度的 EBML 变长整数编码（值 < 2^53）。 */
function encodeVint(value: number): Uint8Array {
    let length = 1;
    while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
    const out = new Uint8Array(length);
    let rest = Math.max(0, Math.floor(value));
    for (let i = length - 1; i >= 0; i -= 1) {
        out[i] = rest & 0xff;
        rest = Math.floor(rest / 256);
    }
    out[0] |= 0x80 >> (length - 1);
    return out;
}

/**
 * 找到**已有**的 `Duration` 值所在位置。没有这个元素 → `null`（真实 `MediaRecorder`
 * 产物就是这种情况，见 `patchWebmDuration` 里的「插入」分支）。
 */
export function locateWebmDuration(bytes: Uint8Array): DurationSlot | null {
    const info = locateWebmInfo(bytes);
    if (!info) return null;
    return scanInfo(bytes, info.payloadStart, info.payloadEnd);
}

function scanInfo(bytes: Uint8Array, start: number, end: number): DurationSlot | null {
    const withScale = (value: { valueOffset: number; size: number } | null, scaleNs: number): DurationSlot | null =>
        value ? { valueOffset: value.valueOffset, size: value.size, scale: scaleNs } : null;
    let scale = DEFAULT_TIMECODE_SCALE;
    let slot: { valueOffset: number; size: number } | null = null;
    let pos = start;
    while (pos < end) {
        const id = readId(bytes, pos);
        if (!id) return withScale(slot, scale);
        const size = readVint(bytes, pos + id.length);
        if (!size) return withScale(slot, scale);
        const payloadStart = pos + id.length + size.length;
        if (id.id === EBML_ID.timecodeScale && size.value > 0 && size.value <= 8) {
            let value = 0;
            for (let i = 0; i < size.value; i += 1) value = value * 256 + (bytes[payloadStart + i] ?? 0);
            if (value > 0) scale = value;
        } else if (id.id === EBML_ID.duration) {
            // Duration 是 float：Chrome 写 8 字节 float64，规范允许 4 字节 float32。
            if (size.value !== 4 && size.value !== 8) return null;
            slot = { valueOffset: payloadStart, size: size.value };
        }
        pos = payloadStart + size.value;
        if (slot) {
            // 已经拿到 Duration，TimecodeScale 只会出现在它前面（规范顺序），可以收工。
            return withScale(slot, scale);
        }
    }
    return withScale(slot, scale);
}

/** 读出现有 Duration（毫秒）。读不到 / 是 0 / 结构不认识 → `null`。给探针用。 */
export function readWebmDurationMs(bytes: Uint8Array): number | null {
    const slot = locateWebmDuration(bytes);
    if (!slot) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const raw = slot.size === 8 ? view.getFloat64(slot.valueOffset) : view.getFloat32(slot.valueOffset);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return (raw * slot.scale) / 1_000_000;
}

/** 读 Info 里的 TimecodeScale（ns/单位）；没有就用缺省 1 ms。 */
function readTimecodeScale(bytes: Uint8Array, start: number, end: number): number {
    let scale = DEFAULT_TIMECODE_SCALE;
    let pos = start;
    while (pos < end) {
        const id = readId(bytes, pos);
        if (!id) return scale;
        const size = readVint(bytes, pos + id.length);
        if (!size) return scale;
        const payloadStart = pos + id.length + size.length;
        if (id.id === EBML_ID.timecodeScale && size.value > 0 && size.value <= 8) {
            let value = 0;
            for (let i = 0; i < size.value; i += 1) value = value * 256 + (bytes[payloadStart + i] ?? 0);
            if (value > 0) return value;
        }
        pos = payloadStart + size.value;
    }
    return scale;
}

/**
 * 把真实时长写进 webm 的 `Duration` 字段。
 *
 * 两条路（2026-10-25 实测：`MediaRecorder` 走的是第二条）：
 *  1. **原地改写**：Info 里已经有 `Duration` 元素 → 只覆盖那 8（或 4）个字节，文件长度不变；
 *  2. **插入**：真实录制产物里**根本没有** `Duration`（Chrome 边录边写，时长事先不知道）
 *     → 把 Info 整个重建（原 payload + 新 Duration），Info 是 Segment 的第一个子元素，
 *     后面所有字节整体后移。因为 Cluster 的时间戳是相对的、Segment 又是未知长度，
 *     所以后移不破坏结构。⚠️ 但如果文件里有 `SeekHead`/`Cues` 这类**绝对偏移**引用，
 *     后移会让它们指错位置 → 这种情况直接放弃（返回原文件）。
 *
 * @returns 写好（或本来就不用改）的 blob；结构不认识 / 不是 webm / 任何异常 → **原样返回**。
 */
export async function patchWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
    if (!blob.size || !(durationMs > 0) || !Number.isFinite(durationMs)) return blob;
    try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const info = locateWebmInfo(bytes);
        if (!info) return blob;

        // 1. 已有 Duration → 原地改写
        const slot = scanInfo(bytes, info.payloadStart, info.payloadEnd);
        if (slot) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const raw = (durationMs * 1_000_000) / (slot.scale > 0 ? slot.scale : DEFAULT_TIMECODE_SCALE);
            if (slot.size === 8) view.setFloat64(slot.valueOffset, raw);
            else view.setFloat32(slot.valueOffset, raw);
            return new Blob([bytes], { type: blob.type || "video/webm" });
        }

        // 2. 没有 Duration → 重建 Info 并插入（要求没有绝对偏移引用）
        if (hasWebmOffsetReferences(bytes)) return blob;
        const scale = readTimecodeScale(bytes, info.payloadStart, info.payloadEnd);
        const durationElement = new Uint8Array(11); // 2 字节 ID + 1 字节长度 + 8 字节 float64
        durationElement.set([0x44, 0x89, 0x88]);
        new DataView(durationElement.buffer).setFloat64(3, (durationMs * 1_000_000) / (scale > 0 ? scale : DEFAULT_TIMECODE_SCALE));

        const payload = bytes.subarray(info.payloadStart, info.payloadEnd);
        const sizeVint = encodeVint(payload.length + durationElement.length);
        const suffix = bytes.subarray(info.end);
        const out = new Uint8Array(info.start + info.idLength + sizeVint.length + payload.length + durationElement.length + suffix.length);
        let cursor = 0;
        out.set(bytes.subarray(0, info.start), cursor);
        cursor += info.start;
        out.set(bytes.subarray(info.start, info.start + info.idLength), cursor);
        cursor += info.idLength;
        out.set(sizeVint, cursor);
        cursor += sizeVint.length;
        out.set(payload, cursor);
        cursor += payload.length;
        out.set(durationElement, cursor);
        cursor += durationElement.length;
        out.set(suffix, cursor);
        return new Blob([out], { type: blob.type || "video/webm" });
    } catch {
        // 补时长是「锦上添花」：失败就交回原文件，绝不因为这一步把片子弄没。
        return blob;
    }
}
