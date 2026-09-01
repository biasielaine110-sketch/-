import localforage from "localforage";
import { saveAs } from "file-saver";

import { buildCanvasProjectsZip } from "@/lib/canvas/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasDraftMeta = {
    projectId: string;
    fileName: string;
    lastSavedAt?: string;
};

type StoredDraft = CanvasDraftMeta & {
    handle?: FileSystemFileHandle;
};

const draftStore = localforage.createInstance({ name: "infinite-canvas", storeName: "draft_files" });

export function supportsFileSystemAccess() {
    return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

function draftKey(projectId: string) {
    return `draft:${projectId}`;
}

export function safeDraftFileName(value: string) {
    const cleaned = value.trim().replace(/[\\/:*?"<>|]/g, "_") || "canvas-draft";
    return cleaned.toLowerCase().endsWith(".zip") ? cleaned : `${cleaned}.zip`;
}

export async function getCanvasDraftMeta(projectId: string): Promise<CanvasDraftMeta | null> {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    if (!stored) return null;
    return { projectId: stored.projectId, fileName: stored.fileName, lastSavedAt: stored.lastSavedAt };
}

export async function getCanvasDraftHandle(projectId: string) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    return stored?.handle || null;
}

export async function clearCanvasDraft(projectId: string) {
    await draftStore.removeItem(draftKey(projectId));
}

async function ensureWritePermission(handle: FileSystemFileHandle) {
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") return true;
    const next = await handle.requestPermission({ mode: "readwrite" });
    return next === "granted";
}

export async function pickCanvasDraftFile(suggestedName: string) {
    if (!supportsFileSystemAccess() || !window.showSaveFilePicker) {
        throw new Error("FILE_SYSTEM_ACCESS_UNSUPPORTED");
    }
    return window.showSaveFilePicker({
        suggestedName: safeDraftFileName(suggestedName),
        types: [
            {
                description: "Infinite Atelier Draft",
                accept: { "application/zip": [".zip"] },
            },
        ],
    });
}

export async function writeBlobToFileHandle(handle: FileSystemFileHandle, blob: Blob) {
    const allowed = await ensureWritePermission(handle);
    if (!allowed) throw new Error("FILE_PERMISSION_DENIED");
    const writable = await handle.createWritable();
    try {
        await writable.write(blob);
    } finally {
        await writable.close();
    }
}

export async function saveCanvasDraftToHandle(project: CanvasProject, handle: FileSystemFileHandle) {
    const zip = await buildCanvasProjectsZip([project]);
    await writeBlobToFileHandle(handle, zip);
    const meta: StoredDraft = {
        projectId: project.id,
        fileName: handle.name || safeDraftFileName(project.title),
        lastSavedAt: new Date().toISOString(),
        handle,
    };
    await draftStore.setItem(draftKey(project.id), meta);
    return meta;
}

export async function saveCanvasDraftFallbackDownload(project: CanvasProject, fileName: string) {
    const zip = await buildCanvasProjectsZip([project]);
    const name = safeDraftFileName(fileName || project.title);
    saveAs(zip, name);
    const meta: StoredDraft = {
        projectId: project.id,
        fileName: name,
        lastSavedAt: new Date().toISOString(),
    };
    await draftStore.setItem(draftKey(project.id), meta);
    return meta;
}

export async function overwriteCanvasDraft(project: CanvasProject) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(project.id));
    if (!stored?.handle) {
        if (stored?.fileName) {
            return saveCanvasDraftFallbackDownload(project, stored.fileName);
        }
        return null;
    }
    try {
        return await saveCanvasDraftToHandle(project, stored.handle);
    } catch (error) {
        if (error instanceof Error && error.message === "FILE_PERMISSION_DENIED") throw error;
        // Handle may be stale after browser restart; clear and force rebind.
        await draftStore.setItem(draftKey(project.id), { projectId: project.id, fileName: stored.fileName, lastSavedAt: stored.lastSavedAt });
        throw error;
    }
}
