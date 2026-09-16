import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp3OutputFormat, Output, WavOutputFormat } from "mediabunny";

import { proxyMediaUrl } from "@/lib/api-proxy";
import { formatVideoClock } from "@/lib/canvas/canvas-video-tools";

export const formatAudioClock = formatVideoClock;

export async function loadAudioBlob(url: string): Promise<Blob> {
    if (!url) throw new Error("Audio URL is empty");
    if (url.startsWith("blob:") || url.startsWith("data:")) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load audio (${response.status})`);
        return response.blob();
    }
    const response = await fetch(proxyMediaUrl(url));
    if (!response.ok) throw new Error(`Failed to load audio (${response.status})`);
    return response.blob();
}

async function convertTrimmedAudio(blob: Blob, start: number, end: number, format: "mp3" | "wav", onProgress?: (progress: number) => void) {
    const input = new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
    });
    const output = new Output({
        format: format === "mp3" ? new Mp3OutputFormat() : new WavOutputFormat(),
        target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
        input,
        output,
        trim: { start, end },
        video: { discard: true },
    });
    if (!conversion.isValid) {
        throw new Error("Unable to trim this audio in the current browser");
    }
    if (onProgress) conversion.onProgress = (progress) => onProgress(progress);
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Trim produced an empty file");
    return new Blob([buffer], { type: format === "mp3" ? "audio/mpeg" : "audio/wav" });
}

/** Trim an audio blob to [startSec, endSec]. Prefers mp3, falls back to wav. */
export async function trimAudioBlob(blob: Blob, startSec: number, endSec: number, onProgress?: (progress: number) => void): Promise<Blob> {
    const start = Math.max(0, Number(startSec) || 0);
    const end = Math.max(start + 0.05, Number(endSec) || start + 0.05);
    try {
        return await convertTrimmedAudio(blob, start, end, "mp3", onProgress);
    } catch {
        return convertTrimmedAudio(blob, start, end, "wav", onProgress);
    }
}
