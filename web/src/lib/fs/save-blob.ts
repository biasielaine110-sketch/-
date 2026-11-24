import { saveAs } from "file-saver";

import { forceProxyMediaUrl, proxyMediaUrl } from "@/lib/api-proxy";
import { supportsFileSystemAccess, writeBlobToDraftDirectory } from "@/lib/canvas/canvas-draft";
import { getMediaBlob } from "@/services/file-storage";

export type SaveBlobOptions = {
    /** When set, can write into this project's bound draft folder — **only** if `preferDraftFolder` is on. */
    projectId?: string | null;
    /**
     * 节点自己的 IndexedDB 副本键（`metadata.storageKey`）。远程直链过期、`blob:` 地址随刷新作废时，
     * 这条是唯一能救回来的路 —— 见 `resolveBlobSource` 的第 ③ 步。
     */
    storageKey?: string | null;
    /**
     * 显式要求「写进绑定的草稿文件夹」而不是走浏览器下载。
     *
     * 🔴 默认 **false**（用户 2026-11-24：「点击下载的图片和视频等，默认存放在跟浏览器的下载路径下」）：
     * 以前只要项目绑过草稿文件夹，下载就被静默塞进那个文件夹 —— 用户在系统「下载」目录里翻不到文件，
     * 还以为下载失败了。草稿文件夹现在只留给草稿 zip 自动保存（`canvas-draft.ts`），
     * 所有「下载」按钮一律走浏览器默认下载目录；真需要落进文件夹的入口得自己显式开启这个开关。
     */
    preferDraftFolder?: boolean;
};

export type SaveBlobResult =
    | { method: "draft"; fileName: string; folderName?: string }
    | { method: "download"; fileName: string };

/**
 * Turn a url/blob into bytes. A cross-origin media URL that a <video>/<img> renders happily still
 * fails here: media elements are not CORS-checked, fetch() is. That is why a playing video could
 * never be downloaded from an external host — the rejection escaped as an unhandled error and the
 * button looked dead. Retry through the same-origin media proxy before giving up.
 *
 * 取字节的顺序（与 `lib/canvas/canvas-video-tools.ts` 的 `loadVideoBlob` 同一套体例，别各写一套）：
 *  ① 直连（`blob:` / `data:` 也就这一条路，读不到说明对象 URL 已被回收）；
 *  ② 非 `blob:`/`data:` 的地址再强制走一次站点代理（`/api/proxy?target=…`）；
 *  ③ 都失败 → **节点自己的 IndexedDB 副本**（`options.storageKey`）。
 *
 * ③ 不是锦上添花：视频节点的 `metadata.content` 经常是上次会话创建的对象 URL，刷新页面就失效，
 * `fetch` 只会抛一句 `Failed to fetch` —— 而字节好端端躺在本地库里。用户看到的
 * 「下载失败: Failed to fetch」绝大多数就是这一种，别再去猜 CORS 或代理挂了。
 */
export async function resolveBlobSource(source: Blob | string, options?: { storageKey?: string | null }): Promise<Blob> {
    if (typeof source !== "string") return source;
    const raw = String(source || "").trim();
    const isObjectUrl = raw.startsWith("blob:") || raw.startsWith("data:");
    if (!raw) return await storedMediaOrThrow(options?.storageKey, new Error("没有可下载的地址"));
    try {
        return await fetchBlobOrThrow(raw);
    } catch (error) {
        // 对象 URL / data URL：代理对非 http(s) 无能为力，直接交给本地副本兜底。
        if (isObjectUrl) return await storedMediaOrThrow(options?.storageKey, error);
        // proxyMediaUrl declines to rewrite "known CORS-open" hosts, but that list is about API
        // POSTs with Authorization — not media GETs — so force the proxy as a last resort.
        const proxied = forceProxyMediaUrl(raw) || proxyMediaUrl(raw);
        if (!proxied || proxied === raw) return await storedMediaOrThrow(options?.storageKey, error);
        try {
            return await fetchBlobOrThrow(proxied);
        } catch (proxyError) {
            return await storedMediaOrThrow(options?.storageKey, proxyError);
        }
    }
}

/**
 * 最后一道：读节点自己的本地副本（`metadata.storageKey`）。读不到就把原始失败原因抛回去，
 * 但把浏览器的 `Failed to fetch` 翻译成人能看懂的一句话（保留原词，方便继续定位）。
 */
async function storedMediaOrThrow(storageKey: string | null | undefined, reason: unknown): Promise<Blob> {
    const key = String(storageKey || "").trim();
    if (key) {
        const stored = await getMediaBlob(key).catch(() => null);
        if (stored && stored.size) return stored;
    }
    const message = reason instanceof Error ? reason.message : String(reason ?? "");
    if (/failed to fetch|networkerror|load failed|net::/i.test(message)) {
        throw new Error(`链接已失效或被跨域拦截（${message}），这个节点本地也没有可用的副本`);
    }
    throw reason instanceof Error ? reason : new Error(message || "无法读取媒体数据");
}

async function fetchBlobOrThrow(url: string) {
    const response = await fetch(url);
    // A refused or dead proxy hop answers with an HTML error body; without this check that body
    // would be saved as the media file, turning a visible failure into a corrupt download.
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.blob();
}

/** Current canvas project id from `/canvas/:id` when available. */
export function resolveCanvasProjectIdFromLocation() {
    if (typeof window === "undefined") return null;
    const match = /^\/canvas\/([^/]+)/.exec(window.location.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Save a blob/url.
 *
 * 🔴 默认走**浏览器下载**（落到浏览器的默认下载目录，与用户点网页里任何「下载」一致）；
 * 只有显式传 `preferDraftFolder: true` 时才尝试写进绑定的草稿文件夹（写作失败再回落浏览器下载）。
 */
export async function saveBlobAs(source: Blob | string, suggestedName: string, options?: SaveBlobOptions): Promise<SaveBlobResult> {
    const fileName = suggestedName.trim() || "download.bin";
    let blob = await resolveBlobSource(source, { storageKey: options?.storageKey });
    // file-saver falls back to inferring the name from the URL when a Blob has an empty or
    // generic ("application/octet-stream") type; a blob: URL has no path, so downloads lose
    // their extension (e.g. "canvas-video" instead of "canvas-video.mp4"). Upstream servers
    // (ComfyUI /view, proxies) also often reply with application/octet-stream for real
    // media, which Windows then mislabels. Rebuild the blob with the correct MIME whenever
    // the filename extension maps to a known type that differs from the blob's own type.
    const extMatch = /\.[a-z0-9]{1,5}$/i.exec(fileName);
    if (extMatch) {
        const ext = extMatch[0].slice(1).toLowerCase();
        const expected = MIME_BY_EXT[ext];
        const normalizedCurrent = (blob.type || "").split(";")[0].trim().toLowerCase();
        if (expected && normalizedCurrent !== expected.toLowerCase()) {
            blob = new Blob([blob], { type: expected });
        } else if (!blob.type) {
            // Unknown extension: still ensure a non-empty type so file-saver keeps the name.
            blob = new Blob([blob], { type: "application/octet-stream" });
        }
    }
    const projectId = options?.projectId || resolveCanvasProjectIdFromLocation();

    if (options?.preferDraftFolder && projectId && supportsFileSystemAccess()) {
        try {
            const saved = await writeBlobToDraftDirectory(projectId, fileName, blob);
            if (saved) return { method: "draft", fileName: saved.fileName, folderName: saved.folderName };
        } catch (error) {
            console.warn("draft folder save failed", error);
        }
    }

    saveAs(blob, fileName);
    return { method: "download", fileName };
}

const MIME_BY_EXT: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    opus: "audio/opus",
    aac: "audio/aac",
    m4a: "audio/mp4",
    flac: "audio/flac",
    pcm: "audio/pcm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
