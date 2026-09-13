import localforage from "localforage";
import { saveAs } from "file-saver";

import { buildCanvasProjectsZip } from "@/lib/canvas/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasDraftMeta = {
    projectId: string;
    fileName: string;
    /** Bound folder name when draft storage is a directory. */
    folderName?: string;
    lastSavedAt?: string;
    /** True when a File System Access handle is bound for in-place overwrite. */
    hasHandle?: boolean;
    /** True when the draft folder can receive silent downloads/exports. */
    hasDirectory?: boolean;
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

export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
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

export async function getCanvasDraftMeta(projectId: string): Promise<CanvasDraftMeta | null> {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    if (!stored) return null;
    return {
        projectId: stored.projectId,
        fileName: stored.fileName,
        folderName: stored.folderName || stored.directoryHandle?.name,
        lastSavedAt: stored.lastSavedAt,
        hasHandle: Boolean(stored.handle),
        hasDirectory: Boolean(stored.directoryHandle),
    };
}

export async function getCanvasDraftHandle(projectId: string) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    return stored?.handle || null;
}

export async function getCanvasDraftDirectory(projectId: string) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(projectId));
    return stored?.directoryHandle || null;
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

/** Ask the user to choose a folder used as draft storage (zip + downloads/exports). */
export async function pickCanvasDraftDirectory() {
    if (!supportsDirectoryPicker() || !window.showDirectoryPicker) {
        throw new Error("FILE_SYSTEM_ACCESS_UNSUPPORTED");
    }
    return window.showDirectoryPicker({ mode: "readwrite" });
}

/** Legacy file picker kept as fallback when directory picker is unavailable. */
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

/** Write a file into the bound draft folder without opening a save picker. */
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

export async function saveCanvasDraftToDirectory(project: CanvasProject, directory: FileSystemDirectoryHandle, draftName: string) {
    const allowed = await ensureWritePermission(directory);
    if (!allowed) throw new Error("FILE_PERMISSION_DENIED");
    const fileName = safeDraftFileName(draftName || project.title);
    const handle = await directory.getFileHandle(fileName, { create: true });
    const zip = await buildCanvasProjectsZip([project]);
    await writeBlobToFileHandle(handle, zip);
    const meta: StoredDraft = {
        projectId: project.id,
        fileName: handle.name || fileName,
        folderName: directory.name,
        lastSavedAt: new Date().toISOString(),
        handle,
        directoryHandle: directory,
        hasHandle: true,
        hasDirectory: true,
    };
    await draftStore.setItem(draftKey(project.id), meta);
    return {
        projectId: meta.projectId,
        fileName: meta.fileName,
        folderName: meta.folderName,
        lastSavedAt: meta.lastSavedAt,
        hasHandle: true,
        hasDirectory: true,
    };
}

export async function saveCanvasDraftToHandle(project: CanvasProject, handle: FileSystemFileHandle, directory?: FileSystemDirectoryHandle | null) {
    const zip = await buildCanvasProjectsZip([project]);
    await writeBlobToFileHandle(handle, zip);
    const directoryHandle = directory || undefined;
    const meta: StoredDraft = {
        projectId: project.id,
        fileName: handle.name || safeDraftFileName(project.title),
        folderName: directoryHandle?.name,
        lastSavedAt: new Date().toISOString(),
        handle,
        directoryHandle,
        hasHandle: true,
        hasDirectory: Boolean(directoryHandle),
    };
    await draftStore.setItem(draftKey(project.id), meta);
    return {
        projectId: meta.projectId,
        fileName: meta.fileName,
        folderName: meta.folderName,
        lastSavedAt: meta.lastSavedAt,
        hasHandle: true,
        hasDirectory: Boolean(directoryHandle),
    };
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
    return { projectId: meta.projectId, fileName: meta.fileName, lastSavedAt: meta.lastSavedAt, hasHandle: false, hasDirectory: false };
}

/** Overwrite the bound draft file in place. Never downloads a new file. */
export async function overwriteCanvasDraft(project: CanvasProject) {
    const stored = await draftStore.getItem<StoredDraft>(draftKey(project.id));
    if (!stored?.handle) return null;
    try {
        return await saveCanvasDraftToHandle(project, stored.handle, stored.directoryHandle);
    } catch (error) {
        if (error instanceof Error && error.message === "FILE_PERMISSION_DENIED") throw error;
        // Handle may be stale after browser restart; drop it so the user must rebind the same file.
        await draftStore.setItem(draftKey(project.id), {
            projectId: project.id,
            fileName: stored.fileName,
            folderName: stored.folderName,
            lastSavedAt: stored.lastSavedAt,
        });
        throw error;
    }
}
