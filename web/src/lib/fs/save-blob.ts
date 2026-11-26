import { saveAs } from "file-saver";

import { forceProxyMediaUrl, isLocalNetworkUrl, proxyMediaUrl } from "@/lib/api-proxy";
import { supportsFileSystemAccess, writeBlobToDraftDirectory } from "@/lib/canvas/canvas-draft";
import { portableMediaUrls, preferPublicMediaUrl } from "@/lib/media-portable";
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
     * 该媒体是由哪个模型生成的（`channelId::model`）。只用于**存量本机地址**的救回：
     * 按它找到真正的渠道，把 `127.0.0.1:17800/v1/files/x.mp4` 重拼成公开地址再取一次
     * （见 `lib/media-portable.ts`）。不传就退化成「按配置里的全部渠道逐个试」。
     */
    model?: string | null;
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
export async function resolveBlobSource(source: Blob | string, options?: { storageKey?: string | null; model?: string | null }): Promise<Blob> {
    if (typeof source !== "string") return source;
    const input = String(source || "").trim();
    const isObjectUrl = input.startsWith("blob:") || input.startsWith("data:");
    if (!input) return await storedMediaOrThrow(options?.storageKey, new Error("没有可下载的地址"));
    /**
     * 🔴 公网页面 + 本机网关地址：**先换成公开入口再取字节**（2026-11-26 用户报障「点下载没反应」）。
     *
     * `metadata.content` 常是 `http://127.0.0.1:17800/v1/files/x.mp4`。Chrome 142+ 的 LNA 会让
     * 公网页面直连 loopback 的 `fetch` **静默挂起**：既不 resolve 也不 reject，于是
     * `saveBlobAs` 的 await 永远不返回 —— 界面表现就是「按钮点了没作用」，连报错都没有。
     * 播放器早就改成取 src 时先换公开地址（`preferPublicMediaUrl`），下载入口漏了这一步。
     * 页面自己在本机时它原样返回，dev 行为不变。
     */
    const raw = isObjectUrl ? input : preferPublicMediaUrl(input);
    try {
        return await fetchBlobOrThrow(raw);
    } catch (error) {
        // 对象 URL / data URL：代理对非 http(s) 无能为力，直接交给本地副本兜底。
        if (isObjectUrl) return await storedMediaOrThrow(options?.storageKey, error);
        /**
         * 🔴 本机网关（`http://127.0.0.1:17800/v1/files/x.mp4`）：站点代理跑在 Cloudflare 边缘，
         * 永远打不到用户自己的机器（只会 403）。直连失败就是**网关没起来 / 文件已过期**，
         * 别再往「跨域拦截」上引，也别去试代理（用户 2026-11-25 第 04 条：既播不了也下载不了）。
         */
        if (isLocalNetworkUrl(input)) {
            const key = String(options?.storageKey || "").trim();
            if (key) {
                const stored = await getMediaBlob(key).catch(() => null);
                if (stored && stored.size) return stored;
            }
            /**
             * 存量节点：`127.0.0.1:17800/v1/files/<id>.mp4` 直连不上，但同一份字节经渠道的公开
             * 域名（Funnel）仍能取到 —— 按当前配置重拼出公开地址再试一轮。这样「播不了也下载不了」
             * 的老成片不用重新生成，也不用用户自己改地址。
             * 上面已经按公开入口试过一次（`raw !== input`），这时不必重复试同一批候选。
             */
            const candidates = raw === input ? portableMediaUrls(input, options?.model) : [];
            for (const candidate of candidates) {
                try {
                    return await fetchBlobOrThrow(candidate);
                } catch {
                    // 下一个候选；全失败才按「本机网关连不上」报错。
                }
            }
            const host = (input.match(/^https?:\/\/([^/?#]+)/i) || [])[1] || "本机网关";
            const reason = error instanceof Error ? error.message : String(error ?? "");
            throw new Error(
                `这条成片只存在本机网关（${host}），现在连不上 —— 先启动该网关再试；若网关里的文件已被清理，只能重新生成${reason ? `（${reason}）` : ""}`,
            );
        }
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
    // `timed out` 也要算进来：取字节有 120s 上限，超时同样是「浏览器说不清原因」的那一类。
    if (/failed to fetch|networkerror|load failed|net::|timed out|timeout/i.test(message)) {
        throw new Error(`链接已失效或被跨域拦截（${message}），这个节点本地也没有可用的副本`);
    }
    throw reason instanceof Error ? reason : new Error(message || "无法读取媒体数据");
}

/**
 * 单次取字节的上限。没有上限时，一条**永远不会回话**的连接（Chrome LNA 挂起、死 Funnel、
 * 被代理软件吞掉的 loopback）会让 `saveBlobAs` 的 await 永不返回 —— 用户看到的就是
 * 「点了下载没作用」。超时后至少能走下一跳 / 报出原因。
 */
const MEDIA_FETCH_TIMEOUT_MS = 120_000;

async function fetchBlobOrThrow(url: string) {
    let signal: AbortSignal | undefined;
    try {
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
            signal = AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS);
        }
    } catch {
        signal = undefined;
    }
    const response = await fetch(url, signal ? { signal } : undefined);
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
    let blob = await resolveBlobSource(source, { storageKey: options?.storageKey, model: options?.model });
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
