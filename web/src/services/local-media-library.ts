import localforage from "localforage";

import { supportsDirectoryPicker } from "@/lib/canvas/canvas-draft";

export type LocalMediaLibraryMeta = {
    folderName: string;
    boundAt: string;
    hasDirectory: boolean;
};

type StoredLibrary = LocalMediaLibraryMeta & {
    directoryHandle?: FileSystemDirectoryHandle;
};

export type LocalMediaMigrateProgress = {
    total: number;
    done: number;
    currentKey?: string;
    bytesCopied: number;
};

export type LocalMediaMigrateResult = {
    total: number;
    copied: number;
    skipped: number;
    failed: number;
    bytesCopied: number;
    errors: string[];
};

const META_KEY = "library";
const libraryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_library" });

export function supportsLocalMediaLibrary() {
    return supportsDirectoryPicker();
}

export async function getLocalMediaLibraryMeta(): Promise<LocalMediaLibraryMeta | null> {
    const stored = await libraryStore.getItem<StoredLibrary>(META_KEY);
    if (!stored?.directoryHandle && !stored?.folderName) return null;
    return {
        folderName: stored.folderName || stored.directoryHandle?.name || "",
        boundAt: stored.boundAt || "",
        hasDirectory: Boolean(stored.directoryHandle),
    };
}

export async function getLocalMediaLibraryDirectory() {
    const stored = await libraryStore.getItem<StoredLibrary>(META_KEY);
    return stored?.directoryHandle || null;
}

export async function clearLocalMediaLibraryBinding() {
    await libraryStore.removeItem(META_KEY);
}

export async function bindLocalMediaLibraryDirectory(directory?: FileSystemDirectoryHandle) {
    if (!supportsLocalMediaLibrary() || !window.showDirectoryPicker) {
        throw new Error("FILE_SYSTEM_ACCESS_UNSUPPORTED");
    }
    const handle = directory || (await window.showDirectoryPicker({ mode: "readwrite" }));
    const allowed = await ensureLibraryPermission(handle);
    if (!allowed) throw new Error("FILE_PERMISSION_DENIED");
    // Ensure subfolders exist up front.
    await handle.getDirectoryHandle("images", { create: true });
    await handle.getDirectoryHandle("media", { create: true });
    const meta: StoredLibrary = {
        folderName: handle.name,
        boundAt: new Date().toISOString(),
        hasDirectory: true,
        directoryHandle: handle,
    };
    await libraryStore.setItem(META_KEY, meta);
    return {
        folderName: meta.folderName,
        boundAt: meta.boundAt,
        hasDirectory: true,
    } satisfies LocalMediaLibraryMeta;
}

export async function isLocalMediaLibraryReady() {
    const directory = await getLocalMediaLibraryDirectory();
    if (!directory) return false;
    return ensureLibraryPermission(directory);
}

export async function writeLocalMediaBlob(storageKey: string, blob: Blob) {
    const directory = await getLocalMediaLibraryDirectory();
    if (!directory) return false;
    const allowed = await ensureLibraryPermission(directory);
    if (!allowed) throw new Error("FILE_PERMISSION_DENIED");
    const { folder, fileName } = resolveLibraryPath(storageKey);
    const folderHandle = await directory.getDirectoryHandle(folder, { create: true });
    const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
        await writable.write(blob);
    } finally {
        await writable.close();
    }
    return true;
}

export async function readLocalMediaBlob(storageKey: string): Promise<Blob | null> {
    const directory = await getLocalMediaLibraryDirectory();
    if (!directory) return null;
    const allowed = await ensureLibraryPermission(directory);
    if (!allowed) return null;
    try {
        const { folder, fileName } = resolveLibraryPath(storageKey);
        const folderHandle = await directory.getDirectoryHandle(folder, { create: false });
        const fileHandle = await folderHandle.getFileHandle(fileName, { create: false });
        return await fileHandle.getFile();
    } catch {
        return null;
    }
}

export async function hasLocalMediaBlob(storageKey: string) {
    const blob = await readLocalMediaBlob(storageKey);
    return Boolean(blob);
}

export async function deleteLocalMediaBlob(storageKey: string) {
    const directory = await getLocalMediaLibraryDirectory();
    if (!directory) return false;
    const allowed = await ensureLibraryPermission(directory);
    if (!allowed) return false;
    try {
        const { folder, fileName } = resolveLibraryPath(storageKey);
        const folderHandle = await directory.getDirectoryHandle(folder, { create: false });
        await folderHandle.removeEntry(fileName);
        return true;
    } catch {
        return false;
    }
}

export async function migrateIndexedDbBlobsToLocalLibrary(
    entries: Array<{ storageKey: string; blob: Blob | null }>,
    onProgress?: (progress: LocalMediaMigrateProgress) => void,
): Promise<LocalMediaMigrateResult> {
    const ready = await isLocalMediaLibraryReady();
    if (!ready) throw new Error("FILE_PERMISSION_DENIED");

    const result: LocalMediaMigrateResult = {
        total: entries.length,
        copied: 0,
        skipped: 0,
        failed: 0,
        bytesCopied: 0,
        errors: [],
    };

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!;
        onProgress?.({
            total: entries.length,
            done: index,
            currentKey: entry.storageKey,
            bytesCopied: result.bytesCopied,
        });

        try {
            if (!entry.blob || entry.blob.size <= 0) {
                result.skipped += 1;
                continue;
            }
            if (await hasLocalMediaBlob(entry.storageKey)) {
                result.skipped += 1;
                continue;
            }
            await writeLocalMediaBlob(entry.storageKey, entry.blob);
            result.copied += 1;
            result.bytesCopied += entry.blob.size;
        } catch (error) {
            result.failed += 1;
            result.errors.push(`${entry.storageKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    onProgress?.({
        total: entries.length,
        done: entries.length,
        bytesCopied: result.bytesCopied,
    });

    return result;
}

function resolveLibraryPath(storageKey: string) {
    const safe = storageKey.replace(/:/g, "__").replace(/[\\/:*?"<>|]/g, "_");
    if (storageKey.startsWith("image:")) return { folder: "images", fileName: safe };
    return { folder: "media", fileName: safe };
}

async function ensureLibraryPermission(handle: FileSystemDirectoryHandle) {
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") return true;
    const next = await handle.requestPermission({ mode: "readwrite" });
    return next === "granted";
}
