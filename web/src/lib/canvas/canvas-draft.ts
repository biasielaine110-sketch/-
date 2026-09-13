import localforage from "localforage";
import { saveAs } from "file-saver";

import { buildCanvasProjectsZip } from "@/lib/canvas/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasDraftMeta = {
    projectId: string;
    fileName: string;
    lastSavedAt?: string;
    /** True when a File System Access handle is bound for in-place overwrite. */
    hasHandle?: boolean;
};

type StoredDraft = CanvasDraftMeta & {
    handle?: FileSystemFileHandle;
    /** Parent folder of the bound draft zip — used for silent asset/config exports. */
    directoryHandle?: FileSystemDirectoryHandle;
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

export function safeExportFileName(value: string) {
    return value.trim().replace(/[\\/:*?"<>|]/g, "_") || "download.bin";
}

async function resolveDirectoryFromFileHandle(handle: FileSystemFileHandle) {
    if (typeof handle.getParent !== "function") return null;
    try {
        return (await handle.getParent()) || null;
    } catch {
        return null;
    }
}

export async function getCanvasDraftDirectory(projectId: string) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    if (stored?.directoryHandle) return stored.directoryHandle;
    if (!stored?.handle) return null;
    const directory = await resolveDirectoryFromFileHandle(stored.handle);
    if (directory) {
        await draftStore.setItem(draftKey(projectId), { ...stored, directoryHandle: directory });
    }
    return directory;
}

export async function getCanvasDraftMeta(projectId: string): Promise<CanvasDraftMeta | null> {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    if (!stored) return null;
    return { projectId: stored.projectId, fileName: stored.fileName, lastSavedAt: stored.lastSavedAt, hasHandle: Boolean(stored.handle) };
}

export async function getCanvasDraftHandle(projectId: string) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    return stored?.handle || null;
}

export async function clearCanvasDraft(projectId: string) {
    await draftStore.removeItem(draftKey(projectId));
}

async function ensureWritePermission(handle: FileSystemFileHandle | FileSystemDirectoryHandle) {
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
    // keepExistingData:false truncates first so each save fully replaces the previous draft.
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
        await writable.write(blob);
    } finally {
        await writable.close();
    }
}

/** Write a file next to the bound draft zip without opening a save picker. */
export async function writeBlobToDraftDirectory(projectId: string, fileName: string, blob: Blob) {
    const directory = await getCanvasDraftDirectory(projectId);
    if (!directory) return null;
    const allowed = await ensureWritePermission(directory);
    if (!allowed) throw new Error("FILE_PERMISSION_DENIED");
    const safeName = safeExportFileName(fileName);
    const fileHandle = await directory.getFileHandle(safeName, { create: true });
    await writeBlobToFileHandle(fileHandle, blob);
    return { fileName: safeName, folderName: directory.name };
}

export async function saveCanvasDraftToHandle(project: CanvasProject, handle: FileSystemFileHandle) {
    const zip = await buildCanvasProjectsZip([project]);
    await writeBlobToFileHandle(handle, zip);
    const directoryHandle = (await resolveDirectoryFromFileHandle(handle)) || undefined;
    const meta: StoredDraft = {
        projectId: project.id,
        fileName: handle.name || safeDraftFileName(project.title),
        lastSavedAt: new Date().toISOString(),
        handle,
        directoryHandle,
    };
    await draftStore.setItem(draftKey(project.id), meta);
    return { projectId: meta.projectId, fileName: meta.fileName, lastSavedAt: meta.lastSavedAt, hasHandle: true };
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
    return { projectId: meta.projectId, fileName: meta.fileName, lastSavedAt: meta.lastSavedAt, hasHandle: false };
}

/** Overwrite the bound draft file in place. Never downloads a new file. */
export async function overwriteCanvasDraft(project: CanvasProject) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(project.id));
    if (!stored?.handle) return null;
    try {
        return await saveCanvasDraftToHandle(project, stored.handle);
    } catch (error) {
        if (error instanceof Error && error.message === "FILE_PERMISSION_DENIED") throw error;
        // Handle may be stale after browser restart; drop it so the user must rebind the same file.
        await draftStore.setItem(draftKey(project.id), { projectId: project.id, fileName: stored.fileName, lastSavedAt: stored.lastSavedAt });
        throw error;
    }
}
