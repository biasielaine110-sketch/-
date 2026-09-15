import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { proxyMediaUrl } from "@/lib/api-proxy";
import { deleteLocalMediaBlob, isLocalMediaLibraryReady, readLocalMediaBlob, writeLocalMediaBlob } from "@/services/local-media-library";

export type UploadedImage = {
    url: string;
    storageKey: string;
    thumbnailUrl?: string;
    thumbnailStorageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const THUMB_MAX_EDGE = 1024;

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await (await fetch(proxyRemoteMediaUrl(input))).blob() : input;
    const storageKey = `image:${nanoid()}`;
    await persistImageBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    const thumb = await createAndStoreThumbnail(url, storageKey, meta.width, meta.height);
    return {
        url,
        storageKey,
        thumbnailUrl: thumb?.url,
        thumbnailStorageKey: thumb?.storageKey,
        width: meta.width,
        height: meta.height,
        bytes: blob.size,
        mimeType: blob.type || meta.mimeType,
    };
}

async function createAndStoreThumbnail(sourceUrl: string, fullStorageKey: string, width: number, height: number) {
    if (!width || !height || Math.max(width, height) <= THUMB_MAX_EDGE) return null;
    try {
        const image = new Image();
        image.decoding = "async";
        image.src = sourceUrl;
        await image.decode();
        const scale = THUMB_MAX_EDGE / Math.max(width, height);
        const targetW = Math.max(1, Math.round(width * scale));
        const targetH = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(image, 0, 0, targetW, targetH);
        const thumbBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
        if (!thumbBlob) return null;
        const storageKey = `${fullStorageKey}:thumb`;
        await persistImageBlob(storageKey, thumbBlob);
        const url = URL.createObjectURL(thumbBlob);
        objectUrls.set(storageKey, url);
        return { url, storageKey };
    } catch {
        return null;
    }
}

/** Create or reuse a persisted thumbnail for an existing full-size image. */
export async function ensureImageThumbnail(options: {
    storageKey?: string;
    contentUrl?: string;
    thumbnailStorageKey?: string;
    width?: number;
    height?: number;
}): Promise<{ thumbnailUrl: string; thumbnailStorageKey: string } | null> {
    if (options.thumbnailStorageKey) {
        const existing = await resolveImageUrl(options.thumbnailStorageKey, "");
        if (existing) return { thumbnailUrl: existing, thumbnailStorageKey: options.thumbnailStorageKey };
    }
    if (!options.storageKey) return null;

    const expectedKey = `${options.storageKey}:thumb`;
    const stored = await getImageBlob(expectedKey);
    if (stored) {
        const url = await resolveImageUrl(expectedKey, "");
        if (url) return { thumbnailUrl: url, thumbnailStorageKey: expectedKey };
    }

    const sourceUrl = options.contentUrl || (await resolveImageUrl(options.storageKey, ""));
    if (!sourceUrl) return null;

    let width = options.width || 0;
    let height = options.height || 0;
    if (!width || !height) {
        try {
            const meta = await readImageMeta(sourceUrl);
            width = meta.width;
            height = meta.height;
        } catch {
            return null;
        }
    }

    const thumb = await createAndStoreThumbnail(sourceUrl, options.storageKey, width, height);
    if (!thumb) return null;
    return { thumbnailUrl: thumb.url, thumbnailStorageKey: thumb.storageKey };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await getImageBlob(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    const local = await readLocalMediaBlob(storageKey);
    if (local) return local;
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await persistImageBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(proxyRemoteMediaUrl(url))).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
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

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    const record = value as Record<string, unknown>;
    for (const field of ["storageKey", "thumbnailStorageKey"] as const) {
        const key = record[field];
        if (typeof key === "string" && key.startsWith("image:")) keys.add(key);
    }
    Object.values(record).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

export async function listIndexedDbImageEntries() {
    const entries: Array<{ storageKey: string; blob: Blob }> = [];
    await store.iterate((value, key) => {
        if (value instanceof Blob) entries.push({ storageKey: key, blob: value });
    });
    return entries;
}

export async function removeIndexedDbImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

async function persistImageBlob(storageKey: string, blob: Blob) {
    if (await isLocalMediaLibraryReady()) {
        await writeLocalMediaBlob(storageKey, blob);
        await store.removeItem(storageKey);
        return;
    }
    await store.setItem(storageKey, blob);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}

function proxyRemoteMediaUrl(url: string) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? proxyMediaUrl(url) : url;
    } catch {
        return url;
    }
}
