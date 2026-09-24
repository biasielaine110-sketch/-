import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";

import { refreshImageUrl } from "@/services/image-storage";

const MAX_CACHE = 96;
/** Evicted blob URLs are revoked after this grace period, not immediately. */
const OWNED_URL_REVOKE_DELAY_MS = 30_000;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
/** Blob URLs this module created — the only ones we are allowed to revoke. */
const ownedUrls = new Set<string>();

/** Hard cap for on-canvas image decode / display (CSS px before DPR). */
export const CANVAS_DISPLAY_MAX_EDGE = 768;

function cacheKey(src: string, maxEdge: number) {
    return `${src}\0${maxEdge}`;
}

function scheduleOwnedUrlRevoke(url: string) {
    // A cache entry can be the live src of several mounted <img> elements at once (nodes
    // sharing the same source). Revoking on eviction would blank them mid-frame; the grace
    // period lets their recovery chain repaint from storage before the bytes go away.
    window.setTimeout(() => URL.revokeObjectURL(url), OWNED_URL_REVOKE_DELAY_MS);
}

function touch(key: string, url: string) {
    cache.delete(key);
    cache.set(key, url);
    while (cache.size > MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (!oldest) break;
        const oldUrl = cache.get(oldest);
        cache.delete(oldest);
        // Never revoke a caller-owned blob: URL — image-storage hands us its own object URLs,
        // and revoking one here blanks the node everywhere until it is re-resolved.
        if (oldUrl && ownedUrls.has(oldUrl)) {
            ownedUrls.delete(oldUrl);
            scheduleOwnedUrlRevoke(oldUrl);
        }
    }
}

function clampDisplayEdge(maxEdge?: number) {
    const raw = Number(maxEdge);
    if (!Number.isFinite(raw) || raw <= 0) return CANVAS_DISPLAY_MAX_EDGE;
    return Math.min(Math.round(raw), CANVAS_DISPLAY_MAX_EDGE);
}

/** Downscale large sources so canvas nodes don't keep multi‑MB bitmaps in GPU memory. */
export async function getCanvasDisplaySrc(src: string, maxEdge = CANVAS_DISPLAY_MAX_EDGE): Promise<string> {
    if (!src || src.startsWith("data:image/svg")) return src;
    const edge = clampDisplayEdge(maxEdge);
    const key = cacheKey(src, edge);
    const cached = cache.get(key);
    if (cached) {
        touch(key, cached);
        return cached;
    }
    const pending = inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
        try {
            // Probe dimensions via createImageBitmap (a GPU bitmap, cheaper than <img>.decode)
            // then downsample only when the source actually exceeds the display edge. This keeps
            // large (4K+) images from being fully decoded into multi‑MB buffers — the main cause
            // of jank on canvases with many big images.
            let width = 0;
            let height = 0;
            let bitmap: ImageBitmap | null = null;
            if (typeof createImageBitmap === "function") {
                try {
                    // createImageBitmap wants a Blob/ImageBitmapSource, not a URL string.
                    const blob = await (await fetch(src)).blob();
                    bitmap = await createImageBitmap(blob);
                    width = bitmap.width || 0;
                    height = bitmap.height || 0;
                } catch {
                    bitmap = null;
                }
            }
            if (!width || !height) {
                const image = new Image();
                image.decoding = "async";
                image.src = src;
                await image.decode();
                width = image.naturalWidth || 0;
                height = image.naturalHeight || 0;
            }
            if (!width || !height || Math.max(width, height) <= edge) {
                if (bitmap) bitmap.close();
                touch(key, src);
                return src;
            }
            const scale = edge / Math.max(width, height);
            const targetW = Math.max(1, Math.round(width * scale));
            const targetH = Math.max(1, Math.round(height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                if (bitmap) bitmap.close();
                touch(key, src);
                return src;
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "medium";
            if (bitmap) {
                ctx.drawImage(bitmap, 0, 0, targetW, targetH);
                bitmap.close();
            } else {
                const image = new Image();
                image.decoding = "async";
                image.src = src;
                await image.decode();
                ctx.drawImage(image, 0, 0, targetW, targetH);
            }
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
            if (!blob) {
                touch(key, src);
                return src;
            }
            const url = URL.createObjectURL(blob);
            ownedUrls.add(url);
            touch(key, url);
            return url;
        } catch {
            // A dead blob:/revoked URL must not be cached or returned as-is — otherwise the
            // <img> stays pinned to an undecodable src and the node renders transparent/blank.
            // Return "" so CanvasDisplayImage's onError→refreshImageUrl chain takes over.
            cache.delete(key);
            return "";
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, task);
    return task;
}

type CanvasDisplayImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    src?: string;
    /** Persisted/on-disk thumbnail — preferred for canvas display when present. */
    previewSrc?: string;
    /** Longest edge for the on-canvas preview (CSS pixels × DPR handled inside). Clamped to CANVAS_DISPLAY_MAX_EDGE. */
    maxEdge?: number;
    /** Storage key behind `src` — lets a dead URL be rebuilt from the stored blob. */
    storageKey?: string;
    /** Storage key behind `previewSrc`. */
    previewStorageKey?: string;
};

/** Candidate URLs in preference order (cheap thumbnail first), de-duplicated. */
function buildCandidates(previewSrc?: string, src?: string) {
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const value of [previewSrc, src]) {
        const url = String(value || "").trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        candidates.push(url);
    }
    return candidates;
}

/**
 * Lazy, async-decoded image for canvas chrome.
 *
 * Tries every available source in turn (thumbnail → full asset). When they all fail it
 * rebuilds fresh object URLs from the storage keys, because a `blob:` URL can be dead while
 * the underlying bytes are still stored. Only when nothing can be revived does it render nothing,
 * so a broken source never leaves the node stuck blank forever.
 */
export function CanvasDisplayImage({ src = "", previewSrc, maxEdge, className, alt = "", storageKey, previewStorageKey, ...rest }: CanvasDisplayImageProps) {
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const edge = Math.round(clampDisplayEdge(maxEdge) * dpr);

    const candidates = buildCandidates(previewSrc, src);
    const candidatesKey = candidates.join("\n");
    // URLs revived from storage after every candidate died.
    const [revived, setRevived] = useState<string[]>([]);
    const [attempt, setAttempt] = useState(0);
    const [displaySrc, setDisplaySrc] = useState("");
    const failedRef = useRef(new Set<string>());
    // Latest candidate chain, kept in a ref so `advance` never reads a stale closure value
    // when `onError` fires after several rapid re-renders (the "randomly blank" bug).
    const chainRef = useRef<string[]>([]);
    const attemptRef = useRef(0);
    const revivedRef = useRef<string[]>([]);
    const reviveRetriesRef = useRef(0);
    const candidatesKeyRef = useRef(candidatesKey);

    const chain = [...candidates, ...revived];
    chainRef.current = chain;
    attemptRef.current = attempt;
    revivedRef.current = revived;
    candidatesKeyRef.current = candidatesKey;
    const current = chain[attempt] || "";

    useEffect(() => {
        failedRef.current = new Set();
        reviveRetriesRef.current = 0;
        setRevived([]);
        setAttempt(0);
    }, [candidatesKey]);

    useEffect(() => {
        let cancelled = false;
        if (!current) {
            setDisplaySrc("");
            return;
        }
        setDisplaySrc(current);
        void getCanvasDisplaySrc(current, edge).then((next) => {
            if (cancelled) return;
            if (next === "") {
                // Decode failed for this candidate — advance to the next one (or rebuild
                // from storage). We clear the src so the <img> doesn't stay pinned to a dead
                // URL, and drive the recovery ourselves instead of relying on onError.
                setDisplaySrc("");
                void advance();
                return;
            }
            setDisplaySrc(next || current);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current, edge]);

    const reviveFromStorage = async (chainNow: string[], forCandidatesKey: string) => {
        const rebuilt = (await Promise.all([refreshImageUrl(previewStorageKey), refreshImageUrl(storageKey)])).filter((url): url is string => Boolean(url) && !chainNow.includes(url));
        // The candidates changed while the storage reads were in flight (user swapped the
        // media) — the rebuilt URLs belong to the old source, so drop them.
        if (candidatesKeyRef.current !== forCandidatesKey) return;
        if (rebuilt.length) {
            reviveRetriesRef.current = 0;
            setRevived(rebuilt);
            // Jump to the first rebuilt URL. `attempt` still points at the failed candidate
            // here; without this, `current` (= chain[attempt]) never changes, the load effect
            // never re-runs, and the revived URLs are never displayed — the node stayed blank
            // until the page was reloaded.
            setAttempt(chainNow.length);
            return;
        }
        // Storage reads can fail transiently (IndexedDB / local-folder hiccup). Retry the
        // rebuild a few times before giving up, otherwise the node stays blank until reload.
        if (reviveRetriesRef.current < 3) {
            reviveRetriesRef.current += 1;
            window.setTimeout(() => void reviveFromStorage(chainRef.current, forCandidatesKey), 900 * reviveRetriesRef.current);
            return;
        }
        reviveRetriesRef.current = 0;
        setDisplaySrc("");
    };

    const advance = async () => {
        const chainNow = chainRef.current;
        const attemptNow = attemptRef.current;
        const currentNow = chainNow[attemptNow] || "";
        if (!currentNow) return;
        // The same URL can error more than once before state settles — never skip a candidate.
        if (failedRef.current.has(currentNow)) return;
        failedRef.current.add(currentNow);
        if (attemptNow + 1 < chainNow.length) {
            setAttempt(attemptNow + 1);
            return;
        }
        await reviveFromStorage(chainNow, candidatesKey);
    };

    if (!chain.length || !displaySrc) return null;
    return <img alt={alt} loading="lazy" decoding="async" draggable={false} className={className} {...rest} src={displaySrc} onError={() => void advance()} />;
}
