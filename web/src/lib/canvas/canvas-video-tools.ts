import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from "mediabunny";

import { proxyMediaUrl } from "@/lib/api-proxy";

export const VIDEO_UPSCALE_RESOLUTIONS = [
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
] as const;

export type VideoUpscaleResolution = (typeof VIDEO_UPSCALE_RESOLUTIONS)[number]["value"];

export function isVideoUpscalerModel(model: string) {
    return /upscaler|zhenzhen-upscaler/i.test(model.trim());
}

export async function loadVideoBlob(url: string): Promise<Blob> {
    if (!url) throw new Error("Video URL is empty");
    if (url.startsWith("blob:") || url.startsWith("data:")) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load video (${response.status})`);
        return response.blob();
    }
    const response = await fetch(proxyMediaUrl(url));
    if (!response.ok) throw new Error(`Failed to load video (${response.status})`);
    return response.blob();
}

export async function trimVideoBlob(blob: Blob, startSec: number, endSec: number, onProgress?: (progress: number) => void): Promise<Blob> {
    const start = Math.max(0, Number(startSec) || 0);
    const end = Math.max(start + 0.05, Number(endSec) || start + 0.05);
    const input = new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
    });
    const output = new Output({
        format: new Mp4OutputFormat(),
        target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
        input,
        output,
        trim: { start, end },
    });
    if (!conversion.isValid) {
        throw new Error("Unable to trim this video in the current browser");
    }
    if (onProgress) {
        conversion.onProgress = (progress) => onProgress(progress);
    }
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Trim produced an empty file");
    return new Blob([buffer], { type: "video/mp4" });
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
        video.src = url.startsWith("blob:") || url.startsWith("data:") ? url : proxyMediaUrl(url);
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
