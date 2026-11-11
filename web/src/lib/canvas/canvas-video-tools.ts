import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    type ConversionOptions,
} from "mediabunny";

import { proxyMediaUrl } from "@/lib/api-proxy";
import { getMediaBlob } from "@/services/file-storage";

export const VIDEO_UPSCALE_RESOLUTIONS = [
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
] as const;

export type VideoUpscaleResolution = (typeof VIDEO_UPSCALE_RESOLUTIONS)[number]["value"];

/**
 * 缩放档位：**按原尺寸的百分比**降（不提供放大，放大走「超分」页签）。
 * 20% 是最小档 —— 720P 缩到 20% 就是 256×144，再小就没法看了。
 * 60% 是 G 快捷键用的那一档（用户 2026-11-11 第 02 条），顺手也放进面板可选。
 */
export const VIDEO_SCALE_PERCENTAGES = [80, 70, 60, 50, 30, 20] as const;

export type VideoScalePercentage = (typeof VIDEO_SCALE_PERCENTAGES)[number];

/**
 * 画布里按 **G** 直接对视频执行的缩放比例（用户 2026-11-11 第 02 条：
 * 「对画布中的视频按 g，可直接执行将其视频大小缩放之百分之 60 的命令」）。
 *
 * 图片按 G 仍是原来的「99% 像素降采样覆盖」，两条路互不影响。
 */
export const VIDEO_SCALE_SHORTCUT_PERCENT = 60;

export function isVideoUpscalerModel(model: string) {
    return /upscaler|zhenzhen-upscaler/i.test(model.trim());
}

const isLocalUrl = (url: string) => url.startsWith("blob:") || url.startsWith("data:");

/**
 * 取视频字节。顺序刻意排成「先本地、后网络」：
 *
 * 1. `blob:` / `data:` 直接读；
 * 2. **节点自己的 IndexedDB 副本**（`storageKey`）—— 这条最重要：远程直链（COS 签名地址）
 *    会过期、也可能不带 CORS 头，`<video>` 能播而 `fetch` 拿不到字节，于是裁段/取帧/缩放
 *    全都在「读视频」这一步就报错；
 * 3. 站点代理 `proxyMediaUrl(url)`；
 * 4. 原地址。
 *
 * 以前只有第 4 步（且直接 `fetch(proxyMediaUrl(url))`），所以视频能播放但工具一律失败。
 */
export async function loadVideoBlob(url: string, storageKey?: string): Promise<Blob> {
    if (!url && !storageKey) throw new Error("视频地址是空的（节点没有内容）");
    if (url && isLocalUrl(url)) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                const blob = await response.blob();
                if (blob.size) return blob;
            }
        } catch {
            // blob URL 可能已被回收 —— 继续往下走 storageKey
        }
    }
    if (storageKey) {
        const local = await getMediaBlob(storageKey).catch(() => null);
        if (local && local.size) return local;
    }
    if (!url) throw new Error("视频地址是空的（节点没有内容）");
    const targets = Array.from(new Set([proxyMediaUrl(url), url].filter(Boolean)));
    let lastError = "";
    for (const target of targets) {
        try {
            const response = await fetch(target);
            if (!response.ok) {
                lastError = `HTTP ${response.status}`;
                continue;
            }
            const blob = await response.blob();
            if (blob.size) return blob;
            lastError = "返回 0 字节";
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`读不到视频数据（${lastError || "所有地址都没取到字节"}）`);
}

/** 把 mediabunny 丢弃轨道的 reason 翻成一句能看懂的话（放进错误提示）。 */
function describeDiscarded(conversion: Conversion) {
    const items = (conversion.discardedTracks || []).map((item) => {
        const track = item?.track as { type?: string; codec?: string } | undefined;
        const kind = track?.type === "video" ? "视频轨" : track?.type === "audio" ? "音频轨" : "轨道";
        const codec = track?.codec ? ` ${String(track.codec)}` : "";
        const reason = String(item?.reason || "未知原因");
        return `${kind}${codec}（${reason}）`;
    });
    return items.length ? items.join("；") : "没有可用轨道";
}

function mp4Output() {
    return new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
}

function toMp4Blob(output: Output<Mp4OutputFormat, BufferTarget>) {
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength === 0) throw new Error("处理结果是空文件");
    return new Blob([buffer], { type: "video/mp4" });
}

/**
 * 裁段。
 *
 * 两级策略：先让 mediabunny **直接拷贝**（快、不掉画质）；`isValid === false` 或执行抛错
 * 才退到**强制转码**（慢，但剪点精确、能救 HEVC 之类没法直接拷进 mp4 的源）。
 * 以前只有第一级，所以遇到 `no_encodable_target_codec` / 非 mp4 源就整单失败，只会甩一句
 * “Unable to trim this video in the current browser”。
 */
export async function trimVideoBlob(blob: Blob, startSec: number, endSec: number, onProgress?: (progress: number) => void): Promise<Blob> {
    const start = Math.max(0, Number(startSec) || 0);
    const end = Math.max(start + 0.05, Number(endSec) || start + 0.05);
    const attempts: Array<{ label: string; options: Omit<ConversionOptions, "input" | "output"> }> = [
        { label: "直接拷贝", options: { trim: { start, end } } },
        {
            label: "强制转码",
            options: { trim: { start, end }, video: { forceTranscode: true }, audio: { forceTranscode: true } },
        },
    ];
    const failures: string[] = [];
    for (const attempt of attempts) {
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const output = mp4Output();
        let conversion: Conversion;
        try {
            conversion = await Conversion.init({ input, output, ...attempt.options });
        } catch (error) {
            failures.push(`${attempt.label}：${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (!conversion.isValid) {
            failures.push(`${attempt.label}：${describeDiscarded(conversion)}`);
            continue;
        }
        if (onProgress) conversion.onProgress = (progress) => onProgress(progress);
        try {
            await conversion.execute();
            return toMp4Blob(output);
        } catch (error) {
            failures.push(`${attempt.label}：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`这个视频剪不了 —— ${failures.join("；")}`);
}

/** h264/yuv420 要求偶数边长，宁可少 1px 也别让编码器直接拒。 */
function toEven(value: number) {
    const safe = Math.max(2, Math.round(value));
    return safe % 2 === 0 ? safe : safe - 1;
}

export type VideoScaleResult = { blob: Blob; width: number; height: number; percent: number };

/**
 * 按原尺寸百分比缩放（**只缩不放**，放大请用「超分」）。
 *
 * 走 `process` + `processedWidth/Height`：每帧缩放到目标尺寸后重编码（H.264）。
 * 注意 `ConversionVideoOptions` 本身不带 width/height，缩放只能靠 process 手动做——
 * 不设 `processedWidth/Height` 的话编码器会按原尺寸配置，出来还是原分辨率。
 */
export async function scaleVideoBlob(blob: Blob, percent: number, onProgress?: (progress: number) => void): Promise<VideoScaleResult> {
    const ratio = Math.min(100, Math.max(5, Number(percent) || 50)) / 100;
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("这个文件里没有视频轨道");
    // 用异步版 `getDisplayWidth()`：同步 getter 已废弃，且在 metadata 未落地时会直接抛。
    const sourceWidth = Math.max(2, Number(await track.getDisplayWidth()) || 0);
    const sourceHeight = Math.max(2, Number(await track.getDisplayHeight()) || 0);
    const width = toEven(sourceWidth * ratio);
    const height = toEven(sourceHeight * ratio);
    const output = mp4Output();
    const conversion = await Conversion.init({
        input,
        output,
        video: {
            forceTranscode: true,
            process: (sample) => sample.transform({ width, height, fit: "fill" }),
            processedWidth: width,
            processedHeight: height,
        },
    });
    if (!conversion.isValid) {
        throw new Error(`这个视频缩放不了 —— ${describeDiscarded(conversion)}`);
    }
    if (onProgress) conversion.onProgress = (progress) => onProgress(progress);
    await conversion.execute();
    return { blob: toMp4Blob(output), width, height, percent: Math.round(ratio * 100) };
}

/** Capture a still frame at an absolute timestamp (seconds). */
export function extractVideoFrameDataUrl(url: string, timeSec: number): Promise<string | null> {
    if (!url) return Promise.resolve(null);
    return new Promise((resolve) => {
        const video = document.createElement("video");
        let settled = false;
        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            video.removeAttribute("src");
            video.load();
            resolve(value);
        };
        const timer = window.setTimeout(() => finish(null), 12_000);
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.onerror = () => {
            window.clearTimeout(timer);
            finish(null);
        };
        video.onloadedmetadata = () => {
            try {
                const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
                const target = Math.min(Math.max(0, timeSec), Math.max(0, duration - 0.05));
                video.currentTime = target;
            } catch {
                window.clearTimeout(timer);
                finish(null);
            }
        };
        video.onseeked = () => {
            try {
                const width = video.videoWidth || 640;
                const height = video.videoHeight || 360;
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext("2d");
                if (!context) {
                    window.clearTimeout(timer);
                    finish(null);
                    return;
                }
                context.drawImage(video, 0, 0, width, height);
                window.clearTimeout(timer);
                finish(canvas.toDataURL("image/jpeg", 0.92));
            } catch {
                window.clearTimeout(timer);
                finish(null);
            }
        };
        video.src = isLocalUrl(url) ? url : proxyMediaUrl(url);
    });
}

export function formatVideoClock(seconds: number) {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const whole = Math.floor(safe);
    const mins = Math.floor(whole / 60);
    const secs = whole % 60;
    const ms = Math.round((safe - whole) * 10);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${ms}`;
}
