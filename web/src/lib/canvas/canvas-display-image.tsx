import { useEffect, useState, type ImgHTMLAttributes } from "react";

const MAX_CACHE = 96;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** Hard cap for on-canvas image decode / display (CSS px before DPR). */
export const CANVAS_DISPLAY_MAX_EDGE = 768;

function cacheKey(src: string, maxEdge: number) {
    return `${src}\0${maxEdge}`;
}

function touch(key: string, url: string) {
    cache.delete(key);
    cache.set(key, url);
    while (cache.size > MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (!oldest) break;
        const oldUrl = cache.get(oldest);
        cache.delete(oldest);
        if (oldUrl?.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
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
            const image = new Image();
            image.decoding = "async";
            image.src = src;
            await image.decode();
            const width = image.naturalWidth || 0;
            const height = image.naturalHeight || 0;
            if (!width || !height || Math.max(width, height) <= edge) {
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
                touch(key, src);
                return src;
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "medium";
            ctx.drawImage(image, 0, 0, targetW, targetH);
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
            if (!blob) {
                touch(key, src);
                return src;
            }
            const url = URL.createObjectURL(blob);
            touch(key, url);
            return url;
        } catch {
            touch(key, src);
            return src;
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
};

/** Lazy, async-decoded image that prefers a stored thumbnail, else downscales the full source. */
export function CanvasDisplayImage({ src = "", previewSrc, maxEdge, className, alt = "", ...rest }: CanvasDisplayImageProps) {
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const edge = Math.round(clampDisplayEdge(maxEdge) * dpr);
    // Prefer thumb exclusively for canvas chrome — never decode the full asset when a thumb exists.
    const preferred = previewSrc || src;
    const [displaySrc, setDisplaySrc] = useState(preferred);

    useEffect(() => {
        let cancelled = false;
        setDisplaySrc(preferred);
        if (!preferred) return;
        if (previewSrc) {
            setDisplaySrc(previewSrc);
            return;
        }
        void getCanvasDisplaySrc(src, edge).then((next) => {
            if (!cancelled) setDisplaySrc(next);
        });
        return () => {
            cancelled = true;
        };
    }, [src, previewSrc, preferred, edge]);

    if (!src && !previewSrc) return null;
    return <img src={displaySrc || preferred} alt={alt} loading="lazy" decoding="async" draggable={false} className={className} {...rest} />;
}
