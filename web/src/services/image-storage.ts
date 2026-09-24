import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { proxyMediaUrl } from "@/lib/api-proxy";
import { deleteLocalMediaBlob, getLocalMediaLibraryDirectory, isLocalMediaLibraryReady, readLocalMediaBlob, requestLocalMediaLibraryAccess, writeLocalMediaBlob } from "@/services/local-media-library";

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

const THUMB_MAX_EDGE = 768;

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await fetchImageBlob(input) : input;
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    try {
        const meta = await readStrictImageMeta(url);
        await persistImageBlob(storageKey, blob);
        objectUrls.set(storageKey, url);
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
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

/** Decode a data: URL into a Blob locally — `fetch` cannot handle data URLs. */
function dataUrlToBlob(url: string): Blob | null {
    if (!/^data:image\//i.test(url)) return null;
    try {
        const [head, payload] = url.split(",");
        if (!payload) return null;
        const mime = head.match(/^data:([^;,]+)/i)?.[1] || "image/png";
        if (/;base64$/i.test(head)) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch {
        return null;
    }
}

/** Some flaky hosts answer 200 with an HTML error/challenge page instead of image bytes. */
function isImageLikeContentType(contentType: string | null | undefined) {
    if (!contentType) return true;
    const value = contentType.toLowerCase().trim();
    return value.startsWith("image/") || value === "application/octet-stream" || value === "binary/octet-stream";
}

async function fetchImageBlob(url: string) {
    // Data URLs must be decoded locally — routing them through `fetch` always fails.
    const fromDataUrl = dataUrlToBlob(url);
    if (fromDataUrl?.size) return fromDataUrl;
    const target = proxyRemoteMediaUrl(url);
    // Retries absorb transient proxy/CDN hiccups (e.g. intermittent 502s from flaky image hosts).
    // Per-attempt timeout keeps dead hosts that hang (no RST, no response) from stalling for minutes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(target, { signal: AbortSignal.timeout(45_000) });
            if (response.ok) {
                const blob = await response.blob();
                const contentType = blob.type || response.headers.get("content-type");
                // An HTML "image" is an error page — reject it instead of storing junk.
                if (blob.size && isImageLikeContentType(contentType)) return blob;
            }
        } catch {
            // Fall through to the retry; the final throw keeps the user-facing message stable.
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    throw new Error(i18n.t("common.imageReadFailed"));
}

/**
 * Best-effort download of a remote image through the media proxy.
 * Returns null when the URL is dead, times out, or serves non-image content —
 * used to verify a reference URL is still fetchable before handing it to a provider.
 */
export async function fetchRemoteImageBlob(url: string): Promise<Blob | null> {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return null;
    try {
        return await fetchImageBlob(target);
    } catch {
        return null;
    }
}

function readStrictImageMeta(url: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve, reject) => {
        const image = new Image();
        const timer = window.setTimeout(() => reject(new Error(i18n.t("common.imageReadFailed"))), 8000);
        image.onload = () => {
            window.clearTimeout(timer);
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) {
                reject(new Error(i18n.t("common.imageReadFailed")));
                return;
            }
            resolve({ width, height, mimeType: url.match(/^data:([^;]+)/)?.[1] || "image/png" });
        };
        image.onerror = () => {
            window.clearTimeout(timer);
            reject(new Error(i18n.t("common.imageReadFailed")));
        };
        image.src = url;
    });
}

async function createAndStoreThumbnail(sourceUrl: string, fullStorageKey: string, width: number, height: number) {
    if (!width || !height) return null;
    // Always persist a canvas-sized thumb when the source is larger than the display cap.
    if (Math.max(width, height) <= THUMB_MAX_EDGE) return null;
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
    if (!storageKey) return usableImageFallback(fallback);
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await getImageBlob(storageKey);
    if (!blob) return usableImageFallback(fallback);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

/**
 * Drop the cached object URL for a key and rebuild it from the stored blob.
 * `objectUrls` can hold a URL that was revoked elsewhere (or died with a previous decode),
 * and `resolveImageUrl` would keep handing that dead URL back — this forces a fresh one.
 * The old URL is deliberately NOT revoked: it can still be the live src of another mounted
 * <img> (nodes sharing the same image), and revoking it would blank those nodes too.
 * Revoking an already-dead URL is a no-op, so skipping it is always safe.
 * Returns "" when the blob itself is gone.
 */
export async function refreshImageUrl(storageKey?: string) {
    if (!storageKey) return "";
    const cached = objectUrls.get(storageKey);
    if (cached) objectUrls.delete(storageKey);
    return resolveImageUrl(storageKey, "");
}

export async function getImageBlob(storageKey: string) {
    const local = await readLocalMediaBlob(storageKey);
    if (local) return local;
    const stored = await store.getItem<Blob>(storageKey);
    if (stored) return stored;
    // Same-session object URLs still hold bytes even if IndexedDB was cleared after migrating to a local library.
    const cached = objectUrls.get(storageKey);
    if (!cached) return null;
    try {
        return await (await fetch(cached)).blob();
    } catch {
        return null;
    }
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await persistImageBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string; thumbnailStorageKey?: string; storageKeys?: Array<string | undefined>; urls?: Array<string | undefined>; fallbackUrls?: Array<string | undefined>; nodeId?: string }) {
    // Generate is a click, so we can ask for the local folder if IndexedDB was migrated out.
    await ensureLocalLibraryAccess();
    const storageKeys = uniqueStrings([image.storageKey, image.thumbnailStorageKey, ...(image.storageKeys || [])]);
    const urls = uniqueStrings([image.dataUrl, image.url, ...(image.urls || []), ...(image.fallbackUrls || [])]).filter((value) => !storageKeys.includes(value));

    const readCandidate = async (candidate: string) => {
        if (!candidate) return "";
        if (/^(image|media):/i.test(candidate)) return "";
        if (candidate.startsWith("data:image/") && !candidate.startsWith("data:image/svg")) return candidate;
        if (candidate.startsWith("data:")) return "";
        if (!/^(blob:|https?:)/i.test(candidate)) return "";
        // <img> can paint these even when fetch fails or the blob MIME is not image/*.
        // That is the same path the maximize preview uses.
        try {
            return await paintImageDataUrl(candidate);
        } catch {
            if (/^https?:\/\//i.test(candidate)) return candidate;
            return "";
        }
    };

    // Prefer durable store, but keep same-session blob:/http previews as fallback when store misses.
    for (const storageKey of storageKeys) {
        try {
            const fromStore = await resolveImageUrl(storageKey, "");
            const stored = await readCandidate(fromStore);
            if (stored.startsWith("data:image/")) return stored;
        } catch {
            // try next key / fall through
        }
    }

    for (const candidate of urls) {
        const resolved = await readCandidate(candidate);
        if (!resolved.startsWith("data:image/") && !/^https?:\/\//i.test(resolved)) continue;
        const healKey = storageKeys[0];
        if (healKey && resolved.startsWith("data:image/") && /^blob:/i.test(candidate)) {
            try {
                const blob = await (await fetch(resolved)).blob();
                if (blob.size > 0) await setImageBlob(healKey, blob);
            } catch {
                // ignore heal failures
            }
        }
        return resolved;
    }

    if (image.nodeId) return readDisplayedImageDataUrl(image.nodeId);
    return "";
}

/** Last resort: the canvas <img> may still hold a live blob the metadata no longer points at. */
export async function readDisplayedImageDataUrl(nodeId: string) {
    if (typeof document === "undefined" || !nodeId) return "";
    const root = document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!root) return "";
    const sources = Array.from(root.querySelectorAll("img"))
        .map((img) => img.currentSrc || img.src)
        .filter(Boolean);
    for (const src of sources) {
        if (src.startsWith("data:image/") && !src.startsWith("data:image/svg")) return src;
        if (!/^blob:/i.test(src) && !/^https?:\/\//i.test(src)) continue;
        try {
            return await paintImageDataUrl(src);
        } catch {
            if (/^https?:\/\//i.test(src)) return src;
        }
    }
    return "";
}

/** Decode whatever the browser can already paint, including blobs whose MIME type is not image/*. */
function paintImageDataUrl(src: string) {
    return new Promise<string>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            try {
                const width = image.naturalWidth || image.width;
                const height = image.naturalHeight || image.height;
                if (!width || !height) {
                    reject(new Error("empty"));
                    return;
                }
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(new Error("canvas"));
                    return;
                }
                ctx.drawImage(image, 0, 0);
                resolve(canvas.toDataURL("image/png"));
            } catch (error) {
                reject(error);
            }
        };
        image.onerror = () => reject(new Error("decode"));
        image.src = src;
    });
}

async function ensureLocalLibraryAccess() {
    if (await isLocalMediaLibraryReady()) return;
    if (!(await getLocalMediaLibraryDirectory())) return;
    await requestLocalMediaLibraryAccess();
}

function uniqueStrings(values: Array<string | undefined>) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const text = String(value || "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
    }
    return result;
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

/**
 * Persist a blob to the bound local folder *and* IndexedDB.
 *
 * The local folder is the primary copy, but its `readwrite` permission lapses when the browser
 * restarts — and removing the IndexedDB copy at that point left the blob unreadable in both
 * places, which surfaced as images silently disappearing from the canvas. Keeping the IndexedDB
 * copy as a fallback costs browser space; "Clean IndexedDB" in settings stays the explicit way to
 * reclaim it, and only ever deletes keys that are already present in the local folder.
 */
async function persistImageBlob(storageKey: string, blob: Blob) {
    const wroteLocal = (await isLocalMediaLibraryReady()) && (await writeLocalMediaBlob(storageKey, blob));
    try {
        await store.setItem(storageKey, blob);
    } catch (error) {
        // IndexedDB quota exhausted — the local folder still holds a durable copy, so keep going.
        if (!wroteLocal) throw error;
    }
}

/** Blob object URLs die after refresh/import; never treat them as a usable fallback. */
function usableImageFallback(fallback = "") {
    const value = String(fallback || "").trim();
    if (!value || value.startsWith("blob:")) return "";
    return value;
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
