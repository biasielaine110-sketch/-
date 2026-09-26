import { ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, Conversion, Input, Mp3OutputFormat, Output, WavOutputFormat } from "mediabunny";

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

/** Decode an audio blob into its AudioBuffer (via its primary audio track). */
async function decodeToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error("No audio track found in this file");
        const sink = new AudioBufferSink(track);
        const chunks: AudioBuffer[] = [];
        for await (const { buffer } of sink.buffers()) chunks.push(buffer);
        if (!chunks.length) throw new Error("No audio samples could be decoded");
        if (chunks.length === 1) return chunks[0];

        // Reassemble multiple buffer chunks into a single AudioBuffer so merge ordering stays exact.
        const channels = chunks[0].numberOfChannels;
        const sampleRate = chunks[0].sampleRate;
        const totalLength = chunks.reduce((sum, buffer) => sum + buffer.length, 0);
        const output = new AudioBuffer({ numberOfChannels: channels, length: totalLength, sampleRate });
        let offset = 0;
        for (const buffer of chunks) {
            for (let channel = 0; channel < channels; channel++) {
                output.copyToChannel(buffer.getChannelData(channel), channel, offset);
            }
            offset += buffer.length;
        }
        return output;
    } finally {
        input.dispose();
    }
}

/**
 * Resample an AudioBuffer to a common sample rate and channel count using an OfflineAudioContext.
 * This is required before concatenation because mediabunny's AudioBufferSource rejects buffers whose
 * sample rate or channel count differs from the first one added — a very common case when merging
 * TTS outputs that mix 44.1k/48k, mono/stereo.
 */
async function normalizeAudioBuffer(buffer: AudioBuffer, targetSampleRate: number, targetChannels: number): Promise<AudioBuffer> {
    if (buffer.sampleRate === targetSampleRate && buffer.numberOfChannels === targetChannels) return buffer;
    const length = Math.ceil((buffer.duration || 0) * targetSampleRate);
    const context = new OfflineAudioContext(targetChannels, Math.max(1, length), targetSampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
    return context.startRendering();
}

/** Merge multiple audio blobs into one, concatenated in the given order. Prefers wav, falls back to mp3. */
export async function mergeAudioBlobs(blobs: Blob[], onProgress?: (progress: number) => void): Promise<Blob> {
    if (!blobs.length) throw new Error("No audio to merge");
    if (blobs.length === 1) return blobs[0];

    const decoded: AudioBuffer[] = [];
    for (let i = 0; i < blobs.length; i++) {
        decoded.push(await decodeToAudioBuffer(blobs[i]));
        onProgress?.((i + 1) / (blobs.length + 2));
    }

    // Unify to the first buffer's sample rate and channel count so the concatenation never trips
    // mediabunny's sample-rate/channel consistency check.
    const targetSampleRate = decoded[0].sampleRate;
    const targetChannels = decoded[0].numberOfChannels;
    const buffers: AudioBuffer[] = [];
    for (const buffer of decoded) {
        buffers.push(await normalizeAudioBuffer(buffer, targetSampleRate, targetChannels));
    }

    const encode = async (format: "wav" | "mp3"): Promise<Blob> => {
        const output = new Output({
            format: format === "mp3" ? new Mp3OutputFormat() : new WavOutputFormat(),
            target: new BufferTarget(),
        });
        const source = new AudioBufferSource({
            codec: format === "mp3" ? "mp3" : "pcm-s16",
        });
        output.addAudioTrack(source);
        await output.start();
        try {
            for (let i = 0; i < buffers.length; i++) {
                await source.add(buffers[i]);
                onProgress?.((buffers.length + i + 1) / (buffers.length * 2 + 1));
            }
        } finally {
            source.close();
        }
        await output.finalize();
        const buffer = output.target.buffer;
        if (!buffer) throw new Error("Merge produced an empty file");
        return new Blob([buffer], { type: format === "mp3" ? "audio/mpeg" : "audio/wav" });
    };

    try {
        return await encode("wav");
    } catch {
        return encode("mp3");
    }
}
