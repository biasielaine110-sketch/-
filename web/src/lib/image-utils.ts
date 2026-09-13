import i18n from "@/i18n";
import type { ReferenceImage } from "@/types/image";

export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number) {
    const value = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return minutes ? i18n.t("common.durationMinutes", { minutes, seconds: String(seconds).padStart(2, "0") }) : i18n.t("common.durationSeconds", { seconds });
}

export function getDataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) {
        return 0;
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

export function readImageMeta(dataUrl: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
        const image = new Image();
        const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" });
        image.onload = done;
        image.onerror = done;
        setTimeout(done, 3000);
        image.src = dataUrl;
    });
}

export function dataUrlToFile(image: ReferenceImage) {
    const [header, content] = image.dataUrl.split(",", 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
    const binary = atob(content || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], image.name || "reference.png", { type: mimeType });
}

function loadImageElement(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        image.src = dataUrl;
    });
}

function canvasHasAlpha(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const sample = Math.min(width * height, 4096);
    const step = Math.max(1, Math.floor((width * height) / sample));
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let index = 3; index < data.length; index += 4 * step) {
        if (data[index] < 250) return true;
    }
    return false;
}

export type CompressDataUrlOptions = {
    /** Longest edge in pixels (default 2048). */
    maxEdge?: number;
    /** Soft byte budget for the encoded image (default ~1.2MB). */
    maxBytes?: number;
    /** Keep PNG when the source has transparency (masks). */
    preserveAlpha?: boolean;
};

/**
 * Downscale / re-encode a data URL so multipart or base64 API payloads stay under
 * common proxy limits (e.g. Vercel Hobby ~4.5MB request body).
 */
export async function compressDataUrlForApi(dataUrl: string, options?: CompressDataUrlOptions) {
    if (!dataUrl?.startsWith("data:")) return dataUrl;

    const maxEdge = options?.maxEdge ?? 2048;
    const maxBytes = options?.maxBytes ?? 1_200_000;
    const preserveAlpha = options?.preserveAlpha ?? false;
    const originalBytes = getDataUrlByteSize(dataUrl);

    let image: HTMLImageElement;
    try {
        image = await loadImageElement(dataUrl);
    } catch {
        return dataUrl;
    }

    const naturalW = image.naturalWidth || 1024;
    const naturalH = image.naturalHeight || 1024;
    if (naturalW <= maxEdge && naturalH <= maxEdge && originalBytes > 0 && originalBytes <= maxBytes) {
        return dataUrl;
    }

    let width = naturalW;
    let height = naturalH;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return dataUrl;
    ctx.drawImage(image, 0, 0, width, height);

    const keepPng = preserveAlpha && canvasHasAlpha(ctx, width, height);
    let quality = 0.88;
    let out = keepPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality);

    let guard = 0;
    while (getDataUrlByteSize(out) > maxBytes && guard < 8) {
        guard += 1;
        if (keepPng) {
            width = Math.max(1, Math.round(width * 0.82));
            height = Math.max(1, Math.round(height * 0.82));
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(image, 0, 0, width, height);
            out = canvas.toDataURL("image/png");
        } else {
            quality = Math.max(0.45, quality - 0.1);
            if (quality <= 0.55) {
                width = Math.max(1, Math.round(width * 0.85));
                height = Math.max(1, Math.round(height * 0.85));
                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(image, 0, 0, width, height);
            }
            out = canvas.toDataURL("image/jpeg", quality);
        }
    }

    if (originalBytes > 0 && getDataUrlByteSize(out) >= originalBytes && width >= naturalW && height >= naturalH) {
        return dataUrl;
    }
    return out;
}

/** Compress reference images so N files fit under a shared request-body budget. */
export async function compressReferenceDataUrl(dataUrl: string, referenceCount = 1, options?: CompressDataUrlOptions) {
    const count = Math.max(1, referenceCount);
    const maxBytes = options?.maxBytes ?? Math.min(1_200_000, Math.floor(3_200_000 / count));
    return compressDataUrlForApi(dataUrl, { ...options, maxBytes });
}
