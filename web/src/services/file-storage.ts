import localforage from "localforage";
import { nanoid } from "nanoid";

import { proxyMediaUrl } from "@/lib/api-proxy";
import { deleteLocalMediaBlob, isLocalMediaLibraryReady, readLocalMediaBlob, writeLocalMediaBlob } from "@/services/local-media-library";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

function proxyRemoteMediaUrl(url: string) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? proxyMediaUrl(url) : url;
    } catch {
        return url;
    }
}

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(proxyRemoteMediaUrl(input))).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await persistMediaBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return usableMediaFallback(fallback);
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await getMediaBlob(storageKey);
    if (!blob) return usableMediaFallback(fallback);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

/** Blob object URLs die on refresh; never treat them as a usable fallback. */
function usableMediaFallback(fallback = "") {
    const value = String(fallback || "").trim();
    if (!value || value.startsWith("blob:")) return "";
    return value;
}

export async function getMediaBlob(storageKey: string) {
    const local = await readLocalMediaBlob(storageKey);
    if (local) return local;
    const stored = await store.getItem<Blob>(storageKey);
    if (stored) return stored;
    const cached = objectUrls.get(storageKey);
    if (!cached) return null;
    try {
        return await (await fetch(cached)).blob();
    } catch {
        return null;
    }
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await persistMediaBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
            await deleteLocalMediaBlob(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

export async function listIndexedDbMediaEntries() {
    const entries: Array<{ storageKey: string; blob: Blob }> = [];
    await store.iterate((value, key) => {
        if (value instanceof Blob) entries.push({ storageKey: key, blob: value });
    });
    return entries;
}

export async function removeIndexedDbMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

/**
 * Mirror the blob into the bound local folder *and* IndexedDB (see image-storage.persistImageBlob).
 * Dropping the IndexedDB copy while the folder permission can lapse is what made media disappear.
 */
async function persistMediaBlob(storageKey: string, blob: Blob) {
    const wroteLocal = (await isLocalMediaLibraryReady()) && (await writeLocalMediaBlob(storageKey, blob));
    try {
        await store.setItem(storageKey, blob);
    } catch (error) {
        // IndexedDB quota exhausted — the local folder still holds a durable copy, so keep going.
        if (!wroteLocal) throw error;
    }
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
