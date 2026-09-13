import { saveAs } from "file-saver";

import { supportsFileSystemAccess, writeBlobToDraftDirectory } from "@/lib/canvas/canvas-draft";

export type SaveBlobOptions = {
    /** When set, try writing into this project's bound draft folder first. */
    projectId?: string | null;
    description?: string;
};

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
 * Falls back to browser download when draft storage is unavailable.
 */
export async function saveBlobAs(source: Blob | string, suggestedName: string, options?: SaveBlobOptions) {
    const fileName = suggestedName.trim() || "download.bin";
    const blob = await resolveBlobSource(source);
    const projectId = options?.projectId || resolveCanvasProjectIdFromLocation();

    if (projectId && supportsFileSystemAccess()) {
        try {
            const saved = await writeBlobToDraftDirectory(projectId, fileName, blob);
            if (saved) return { method: "draft" as const, fileName: saved.fileName, folderName: saved.folderName };
        } catch (error) {
            if (error instanceof Error && error.message === "FILE_PERMISSION_DENIED") {
                // Fall back to browser download below.
            }
        }
    }

    saveAs(blob, fileName);
    return { method: "download" as const, fileName };
}
