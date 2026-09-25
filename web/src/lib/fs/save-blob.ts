import { saveAs } from "file-saver";

import { supportsFileSystemAccess, writeBlobToDraftDirectory } from "@/lib/canvas/canvas-draft";

export type SaveBlobOptions = {
    /** When set, try writing into this project's bound draft folder first. */
    projectId?: string | null;
};

export type SaveBlobResult =
    | { method: "draft"; fileName: string; folderName?: string }
    | { method: "download"; fileName: string };

export async function resolveBlobSource(source: Blob | string): Promise<Blob> {
    if (typeof source !== "string") return source;
    const response = await fetch(source);
    return response.blob();
}

/** Current canvas project id from `/canvas/:id` when available. */
export function resolveCanvasProjectIdFromLocation() {
    if (typeof window === "undefined") return null;
    const match = /^\/canvas\/([^/]+)/.exec(window.location.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Save a blob/url into the bound draft folder when available (no picker).
 * Falls back to browser download when draft folder is unavailable.
 */
export async function saveBlobAs(source: Blob | string, suggestedName: string, options?: SaveBlobOptions): Promise<SaveBlobResult> {
    const fileName = suggestedName.trim() || "download.bin";
    let blob = await resolveBlobSource(source);
    // file-saver falls back to inferring the name from the URL when a Blob has an empty
    // type; a blob: URL has no path, so downloads lose their extension (e.g. "canvas-video"
    // instead of "canvas-video.mp4"). Restore the type from the suggested filename's extension
    // so saveAs keeps the intended name even for proxy-fetched blobs.
    if (!blob.type && /\.[a-z0-9]{1,5}$/i.test(fileName)) {
        const ext = (fileName.match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toLowerCase() || "";
        // file-saver only keeps the suggested name when the Blob has a non-empty type;
        // fall back to a generic binary type so the extension is never dropped.
        const mime = MIME_BY_EXT[ext] || "application/octet-stream";
        blob = new Blob([blob], { type: mime });
    }
    const projectId = options?.projectId || resolveCanvasProjectIdFromLocation();

    if (projectId && supportsFileSystemAccess()) {
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
};
