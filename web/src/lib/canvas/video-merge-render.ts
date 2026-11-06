import { ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSampleSink } from "mediabunny";

/**
 * 视频合并节点 → 真·一条 mp4。
 *
 * 剪映导出那条路（`jianying-draft.ts`）只写 in/out 元数据、不重新编码；这里相反：把每段按
 * 画幅裁好、逐帧重画、音轨拼起来，输出一条 AV 对齐的 H.264/AAC mp4，直接落成画布上的视频节点。
 *
 * 为什么不用 `Conversion`：它只吃一个 input，多段拼接得自己驱动
 * `VideoSampleSink.samplesAtTimestamps()`（时间戳单调 → 一次解码到底）→ `CanvasSource`
 * → `AudioBufferSource`（逐个 buffer 首尾相接）→ `Mp4OutputFormat`。音频/视频各走各的轨道，
 * 靠共享的时间线游标对齐：**每段占的时长完全相同**，即使某段没有音轨也补等长静音。
 */

/** 浏览器没有 WebCodecs 时抛这个 —— 上层换成可读文案，别把黄脸报错丢给用户。 */
export const MERGE_RENDER_UNSUPPORTED = "merge-render-unsupported";
/** 一段可用素材都没有 / 全都解不开。 */
export const MERGE_RENDER_EMPTY = "merge-render-empty";

/** 30fps：和剪映草稿默认序列一致，也不会让编码时间翻倍。 */
export const MERGE_RENDER_FPS = 30;
/** 统一到 48k / 立体声 —— AAC 友好，且能吃掉 44.1k / 单声道这种源。 */
const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;
/** 短于这个长度的段直接丢（编码器不接受零长轨道）。 */
const MIN_RENDER_SEC = 0.05;

export type MergeRenderClip = {
    kind: "video" | "image";
    blob: Blob;
    inSec: number;
    outSec: number;
    title?: string;
};

export type MergeRenderOptions = {
    clips: MergeRenderClip[];
    width: number;
    height: number;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
};

export type MergeRenderResult = {
    blob: Blob;
    width: number;
    height: number;
    durationSec: number;
};

type OpenedVideoClip = {
    kind: "video";
    title?: string;
    input: Input;
    videoTrack: NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>;
    audioTrack: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>;
    start: number;
    lengthSec: number;
};

type OpenedImageClip = {
    kind: "image";
    title?: string;
    bitmap: ImageBitmap;
    lengthSec: number;
};

type OpenedClip = OpenedVideoClip | OpenedImageClip;

export function canRenderMergedVideo() {
    return typeof document !== "undefined" && typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined" && typeof AudioBuffer !== "undefined";
}

function abortError() {
    return typeof DOMException === "function" ? new DOMException("Aborted", "AbortError") : new Error("Aborted");
}

function evenSize(value: number) {
    return Math.max(2, Math.round((Number(value) || 0) / 2) * 2);
}

/** 视频编码器要偶数边长；这里同时兜住「传进来是 0」的异常输入。导出给探针断言。 */
export function normalizeMergeRenderSize(width: number, height: number) {
    return { width: evenSize(width || 1920), height: evenSize(height || 1080) };
}

/** 等比塞进画幅（留黑边）—— 跟节点里的 `object-contain` 预览一致，不裁掉画面内容。 */
function drawContain(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    target: { width: number; height: number },
) {
    const sw = Math.max(1, sourceWidth);
    const sh = Math.max(1, sourceHeight);
    const scale = Math.min(target.width / sw, target.height / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(source, (target.width - dw) / 2, (target.height - dh) / 2, dw, dh);
}

async function resampleAudio(buffer: AudioBuffer) {
    if (buffer.sampleRate === AUDIO_RATE && buffer.numberOfChannels === AUDIO_CHANNELS) return buffer;
    const length = Math.max(1, Math.ceil((buffer.duration || 0) * AUDIO_RATE));
    const context = new OfflineAudioContext(AUDIO_CHANNELS, length, AUDIO_RATE);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
    return context.startRendering();
}

/**
 * 把一段的音频解成**恰好 lengthSec 长**的 AudioBuffer。
 *
 * 直接 `AudioBufferSource.add(buffer)` 是首尾相接、不认时间戳的，所以每一段都必须自己裁准：
 * 按 `timestamp - startSec` 算落点，越界的部分丢掉，缺的部分留在静音里。
 */
async function buildClipAudio(sink: AudioBufferSink | null, startSec: number, lengthSec: number) {
    const total = Math.max(1, Math.round(lengthSec * AUDIO_RATE));
    const target = new AudioBuffer({ numberOfChannels: AUDIO_CHANNELS, length: total, sampleRate: AUDIO_RATE });
    if (!sink) return target;
    for await (const item of sink.buffers(startSec, startSec + lengthSec)) {
        const buffer = await resampleAudio(item.buffer);
        const offset = Math.round(((item.timestamp || 0) - startSec) * AUDIO_RATE);
        const sourceSkip = Math.max(0, -offset);
        const destOffset = Math.max(0, offset);
        const copyLength = Math.min(buffer.length - sourceSkip, total - destOffset);
        if (copyLength <= 0) continue;
        for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
            const from = Math.min(channel, buffer.numberOfChannels - 1);
            const data = buffer.getChannelData(from);
            target.copyToChannel(data.subarray(sourceSkip, sourceSkip + copyLength), channel, destOffset);
        }
    }
    return target;
}

/** 逐段打开媒体：这里就把裁剪区间夹进真实时长，后面编码不再需要处理越界。 */
async function openClips(clips: readonly MergeRenderClip[]): Promise<OpenedClip[]> {
    const opened: OpenedClip[] = [];
    const usable = clips.filter((clip) => clip.blob && clip.outSec - clip.inSec > MIN_RENDER_SEC);
    if (!usable.length) throw new Error(MERGE_RENDER_EMPTY);

    try {
        for (const clip of usable) {
            if (clip.kind === "image") {
                const bitmap = await createImageBitmap(clip.blob);
                opened.push({ kind: "image", title: clip.title, bitmap, lengthSec: clip.outSec - clip.inSec });
                continue;
            }
            const input = new Input({ source: new BlobSource(clip.blob), formats: ALL_FORMATS });
            const videoTrack = await input.getPrimaryVideoTrack();
            if (!videoTrack) {
                input.dispose();
                continue;
            }
            const audioTrack = await input.getPrimaryAudioTrack();
            const duration = await videoTrack.computeDuration();
            // 源比记录的短（旧数据 / 探测失败）时按源夹一遍，否则编码到末尾会出空帧。
            const limit = duration > 0 ? duration : clip.outSec;
            const start = Math.max(0, Math.min(clip.inSec, Math.max(0, limit - MIN_RENDER_SEC)));
            const lengthSec = Math.max(0, Math.min(clip.outSec, limit) - start);
            if (lengthSec <= MIN_RENDER_SEC) {
                input.dispose();
                continue;
            }
            opened.push({ kind: "video", title: clip.title, input, videoTrack, audioTrack, start, lengthSec });
        }
    } catch (error) {
        for (const item of opened) disposeClip(item);
        throw error;
    }
    if (!opened.length) throw new Error(MERGE_RENDER_EMPTY);
    return opened;
}

function disposeClip(clip: OpenedClip) {
    if (clip.kind === "image") {
        clip.bitmap.close?.();
        return;
    }
    try {
        clip.input.dispose();
    } catch {
        // 已经释放过就算了 —— 清理失败不该盖掉真正的错误。
    }
}

/**
 * 把若干段拼成一条 mp4。
 *
 * 输出 `video/mp4` / H.264 + AAC（有音轨时）。进度按「帧数 + 段数」线性推，
 * `signal` 中断会立刻抛 `AbortError` 并释放已打开的 input。
 */
export async function renderMergedVideo({ clips, width, height, onProgress, signal }: MergeRenderOptions): Promise<MergeRenderResult> {
    if (!canRenderMergedVideo()) throw new Error(MERGE_RENDER_UNSUPPORTED);
    const size = normalizeMergeRenderSize(width, height);
    const opened = await openClips(clips);
    const hasAudio = opened.some((clip) => clip.kind === "video" && clip.audioTrack);

    const totalFrames = opened.reduce((sum, clip) => sum + Math.max(1, Math.round(clip.lengthSec * MERGE_RENDER_FPS)), 0);
    const totalSteps = Math.max(1, totalFrames + (hasAudio ? opened.length : 0));
    let done = 0;
    let lastReport = -1;
    const report = () => {
        done += 1;
        const value = Math.min(0.999, done / totalSteps);
        if (onProgress && (value - lastReport >= 0.02 || value >= 0.999)) {
            lastReport = value;
            onProgress(value);
        }
    };

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
        for (const clip of opened) disposeClip(clip);
        throw new Error(MERGE_RENDER_UNSUPPORTED);
    }
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, size.width, size.height);

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const videoSource = new CanvasSource(canvas, { codec: "avc", quality: QUALITY_HIGH, sizeChangeBehavior: "contain" });
    output.addVideoTrack(videoSource, { frameRate: MERGE_RENDER_FPS });
    const audioSource = hasAudio ? new AudioBufferSource({ codec: "aac", quality: QUALITY_HIGH }) : null;
    if (audioSource) output.addAudioTrack(audioSource);

    try {
        await output.start();
        let cursor = 0;
        for (const clip of opened) {
            if (signal?.aborted) throw abortError();
            const frameCount = Math.max(1, Math.round(clip.lengthSec * MERGE_RENDER_FPS));

            if (clip.kind === "image") {
                for (let index = 0; index < frameCount; index += 1) {
                    if (signal?.aborted) throw abortError();
                    // 每一帧都重画：画布只有一块，跨段不能靠「上一帧还在」这种巧合。
                    ctx.fillStyle = "#000000";
                    ctx.fillRect(0, 0, size.width, size.height);
                    drawContain(ctx, clip.bitmap, clip.bitmap.width, clip.bitmap.height, size);
                    await videoSource.add(cursor + index / MERGE_RENDER_FPS, 1 / MERGE_RENDER_FPS);
                    report();
                }
            } else {
                const sink = new VideoSampleSink(clip.videoTrack);
                const timestamps = Array.from({ length: frameCount }, (_, index) => clip.start + index / MERGE_RENDER_FPS);
                let frameIndex = 0;
                for await (const sample of sink.samplesAtTimestamps(timestamps)) {
                    if (signal?.aborted) throw abortError();
                    if (sample) {
                        ctx.fillStyle = "#000000";
                        ctx.fillRect(0, 0, size.width, size.height);
                        drawContain(ctx, sample.toCanvasImageSource(), sample.displayWidth, sample.displayHeight, size);
                    }
                    // sample 为 null = 这一时刻没有新帧 → 保留上一帧，等于「定格」，比补黑帧稳。
                    await videoSource.add(cursor + frameIndex / MERGE_RENDER_FPS, 1 / MERGE_RENDER_FPS);
                    sample?.close();
                    frameIndex += 1;
                    report();
                }
                // 尾部落差（源比 frameCount 短、或解码器吐的数量不足）也补齐，别让轨道短一截。
                while (frameIndex < frameCount) {
                    await videoSource.add(cursor + frameIndex / MERGE_RENDER_FPS, 1 / MERGE_RENDER_FPS);
                    frameIndex += 1;
                    report();
                }
            }

            if (audioSource) {
                const sink = clip.kind === "video" && clip.audioTrack ? new AudioBufferSink(clip.audioTrack) : null;
                await audioSource.add(await buildClipAudio(sink, clip.kind === "video" ? clip.start : 0, clip.lengthSec));
                report();
            }

            cursor += clip.lengthSec;
        }

        await output.finalize();
        const buffer = output.target.buffer;
        if (!buffer) throw new Error(MERGE_RENDER_EMPTY);
        onProgress?.(1);
        return { blob: new Blob([buffer], { type: "video/mp4" }), width: size.width, height: size.height, durationSec: cursor };
    } catch (error) {
        // 半成品必须取消，否则编码器线程 / 写入器会挂在后台。
        await output.cancel().catch(() => undefined);
        throw error;
    } finally {
        for (const clip of opened) disposeClip(clip);
    }
}
