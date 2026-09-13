import { saveAs } from "file-saver";

import { getCanvasDraftHandle, supportsFileSystemAccess, writeBlobToFileHandle } from "@/lib/canvas/canvas-draft";

export type SaveBlobOptions = {
    /** Prefer opening the save dialog in the same folder as this project's bound draft. */
    projectId?: string | null;
    /** Optional MIME accept map for showSaveFilePicker, e.g. { "image/png": [".png"] }. */
    accept?: Record<string, string[]>;
    description?: string;
};

function extensionOf(fileName: string) {
    const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
    return match?.[1]?.toLowerCase() || "";
}

function guessAccept(fileName: string, blobType?: string): Record<string, string[]> {
    const ext = extensionOf(fileName);
    if (ext === "png") return { "image/png": [".png"] };
    if (ext === "jpg" || ext === "jpeg") return { "image/jpeg": [".jpg", ".jpeg"] };
    if (ext === "webp") return { "image/webp": [".webp"] };
    if (ext === "gif") return { "image/gif": [".gif"] };
    if (ext === "mp4") return { "video/mp4": [".mp4"] };
    if (ext === "webm") return { "video/webm": [".webm"] };
    if (ext === "mp3") return { "audio/mpeg": [".mp3"] };
    if (ext === "wav") return { "audio/wav": [".wav"] };
    if (ext === "json") return { "application/json": [".json"] };
    if (ext === "zip") return { "application/zip": [".zip"] };
    if (blobType && blobType !== "application/octet-stream") return { [blobType]: ext ? [`.${ext}`] : [] };
    return { "application/octet-stream": ext ? [`.${ext}`] : [] };
}

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
 * Save a blob/url with a picker that prefers the bound draft folder when possible.
 * Falls back to browser download (`saveAs`) when FS Access is unavailable or the user cancels.
 */
export async function saveBlobAs(source: Blob | string, suggestedName: string, options?: SaveBlobOptions) {
    const fileName = suggestedName.trim() || "download.bin";
    const blob = await resolveBlobSource(source);

    if (supportsFileSystemAccess() && typeof window.showSaveFilePicker === "function") {
        try {
            const projectId = options?.projectId || resolveCanvasProjectIdFromLocation();
            const draftHandle = projectId ? await getCanvasDraftHandle(projectId) : null;
            const accept = options?.accept || guessAccept(fileName, blob.type);
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                id: "infinite-atelier-asset-download",
                ...(draftHandle ? { startIn: draftHandle } : {}),
                types: [
                    {
                        description: options?.description || "Download",
                        accept,
                    },
                ],
            });
            await writeBlobToFileHandle(handle, blob);
            return { method: "picker" as const, fileName: handle.name || fileName };
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                return { method: "canceled" as const, fileName };
            }
            // Permission / stale handle / unsupported startIn — fall back to download.
        }
    }

    saveAs(blob, fileName);
    return { method: "download" as const, fileName };
}
