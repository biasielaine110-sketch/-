import localforage from "localforage";
import { nanoid } from "nanoid";

import { proxyMediaUrl } from "@/lib/api-proxy";
import { describeVideoContainer, readVideoContainer, videoMimeForContainer, type VideoContainerInfo } from "@/lib/media-container";
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

/**
 * 拦下「拿文本冒充媒体」的响应。
 *
 * 这是「视频存进库了但播不了」的最后一环：上游 `contentUrl` 不带 Bearer 就是 401，代理挂掉时
 * 也可能回一段 HTML 错误页；以前这些字节会被下面「非视频也重贴 video/mp4」的规则收下，
 * 于是库里多出一条 type=video/mp4、内容却是 JSON 的假视频，Chrome 只会说
 * `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`，真因被彻底埋掉。
 *
 * 只嗅前 64 字节里第一个非空白字节（`{` / `[` / `<`），二进制媒体头不可能长这样，误伤率 0。
 */
async function assertNotTextPayload(blob: Blob) {
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    for (const byte of head) {
        if (byte === 0xef || byte === 0xbb || byte === 0xbf || byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) continue;
        if (byte !== 0x7b && byte !== 0x5b && byte !== 0x3c) return;
        // 把上游原文带出来：401 的 JSON / 代理错误页本身就是最好的错误说明。
        const text = new TextDecoder().decode(head).replace(/\s+/g, " ").trim().slice(0, 160);
        throw new Error(text || "Media download returned text instead of a media file");
    }
}

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const raw = typeof input === "string" ? await (await fetch(proxyRemoteMediaUrl(input))).blob() : input;
    if (prefix === "video" || prefix === "audio") await assertNotTextPayload(raw);
    /**
     * 视频：**按字节认容器**，不信 content-type、也不信文件名。
     *
     * 这是「画布看着好了、点播放才炸」的最后一道闸。上游把 GIF 预览叫 `.mp4`、把 MPEG-TS 流
     * 回成 `application/octet-stream`、把半截文件回成 200 —— 以前一律被下面「没有视频类型就贴
     * video/mp4」的规则收下，Chrome 打开就只给一句 `DEMUXER_ERROR_COULD_NOT_OPEN`。
     * 现在：容器不是浏览器能开的 → 当场抛错说明白；是 WebM 就按 WebM 存，别再冒充 MP4。
     */
    let videoContainer: VideoContainerInfo | null = null;
    if (prefix === "video") {
        videoContainer = await readVideoContainer(raw);
        const problem = describeVideoContainer(videoContainer);
        if (problem) throw new Error(`视频保存失败：${problem}`);
    }
    // ComfyUI /view often lands as application/octet-stream; without a video/* type, Chrome
    // may refuse to decode the blob URL even when the bytes are a valid mp4.
    const containerType = videoContainer ? videoMimeForContainer(videoContainer) : "";
    const desiredType =
        containerType ||
        (raw.type.startsWith("video/") || raw.type.startsWith("audio/") || raw.type.startsWith("image/")
            ? raw.type
            : prefix === "video"
              ? "video/mp4"
              : prefix === "audio"
                ? "audio/mpeg"
                : raw.type || "application/octet-stream");
    const blob = raw.type === desiredType ? raw : raw.slice(0, raw.size, desiredType);
    const storageKey = `${prefix}:${nanoid()}`;
    // Publish the object URL immediately so callers can paint the canvas while IndexedDB / disk
    // writes and metadata probing overlap — large ComfyUI DualClock mp4s used to wait on these
    // serially and felt like "pod finished, canvas blank for minutes".
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const isVideo = blob.type.startsWith("video/") || prefix === "video";
    const isAudio = blob.type.startsWith("audio/") || prefix === "audio";
    const [meta] = await Promise.all([
        isVideo ? readVideoMeta(url) : isAudio ? readAudioMeta(url) : Promise.resolve({}),
        persistMediaBlob(storageKey, blob, { deferLocalMirror: isVideo && blob.size > 1_500_000 }),
    ]);
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || desiredType, ...meta };
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

/**
 * Drop the cached object URL for a key and rebuild it from the stored blob — the video
 * counterpart of image-storage.refreshImageUrl. The old URL is deliberately NOT revoked:
 * it can still be the live src of another mounted <video>, and revoking it would blank
 * those elements too. Revoking an already-dead URL is a no-op, so skipping is always safe.
 * Returns "" when the blob itself is gone.
 */
export async function refreshMediaUrl(storageKey?: string) {
    if (!storageKey) return "";
    const cached = objectUrls.get(storageKey);
    if (cached) objectUrls.delete(storageKey);
    return resolveMediaUrl(storageKey, "");
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

/**
 * 清理「没有任何项目 / 素材引用」的视频 / 音频字节。
 *
 * 与 `cleanupUnusedImages` 同一道闸门（原因见那里）：store 还没 hydrate 完就清理，
 * `usedKeys` 会是空的 —— 几十个视频一次性删光就是真金白银的损失，宁可漏删也绝不误删。
 */
const CLEANUP_MAX_DELETE_RATIO = 0.9;
const CLEANUP_MIN_SUSPICIOUS_COUNT = 8;

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const allKeys: string[] = [];
    await store.iterate((_value, key) => {
        allKeys.push(key);
    });
    if (allKeys.length === 0) return;
    const unused = allKeys.filter((key) => !usedKeys.has(key));
    if (unused.length === 0) return;
    if (unused.length >= CLEANUP_MIN_SUSPICIOUS_COUNT && unused.length / allKeys.length > CLEANUP_MAX_DELETE_RATIO) {
        console.warn(`[storage] 拒绝清理媒体：本次要删 ${unused.length}/${allKeys.length} 个（疑似项目还没载入完成），已跳过以免误删`);
        return;
    }
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
 *
 * `deferLocalMirror`: for large videos, IndexedDB is the durability that blocks canvas return;
 * the local-folder mirror is best-effort and runs in the background so a 50MB+ write does not
 * sit on the critical path after ComfyUI has already finished.
 */
async function persistMediaBlob(storageKey: string, blob: Blob, options?: { deferLocalMirror?: boolean }) {
    if (options?.deferLocalMirror) {
        void (async () => {
            try {
                if (await isLocalMediaLibraryReady()) await writeLocalMediaBlob(storageKey, blob);
            } catch {
                // Best-effort mirror only.
            }
        })();
        try {
            await store.setItem(storageKey, blob);
        } catch (error) {
            // No local mirror guaranteed yet — still surface quota errors.
            throw error;
        }
        return;
    }
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
        video.preload = "metadata";
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve({
                width: video.videoWidth || 1280,
                height: video.videoHeight || 720,
                durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
            });
            video.removeAttribute("src");
            video.load();
        };
        // Large mp4s through a cold blob URL can stall metadata; do not block canvas return.
        const timer = window.setTimeout(done, 900);
        video.onloadedmetadata = () => {
            window.clearTimeout(timer);
            done();
        };
        video.onerror = () => {
            window.clearTimeout(timer);
            done();
        };
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
