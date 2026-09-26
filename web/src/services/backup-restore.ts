import { saveAs } from "file-saver";
import localforage from "localforage";

import i18n from "@/i18n";
import { createZip, readZipStreaming } from "@/lib/zip";
import { setImageBlob } from "@/services/image-storage";
import { setMediaBlob } from "@/services/file-storage";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

type BackupItem = { storageKey: string; path: string; mimeType: string };

type AppBackupFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    projects: CanvasProject[];
    assets: Asset[];
    config: AiConfig;
    files: BackupItem[];
};

// Export every canvas project, asset, media file, and configuration as a single zip that can be restored later.
export async function exportAppBackup() {
    const { projects } = useCanvasStore.getState();
    const { assets } = useAssetStore.getState();
    const { config } = useConfigStore.getState();
    const files: BackupItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];
    await Promise.all([collectStoreFiles(imageStore, files, zipFiles), collectStoreFiles(mediaStore, files, zipFiles)]);
    const data: AppBackupFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), projects, assets, config, files };
    zipFiles.push({ name: "backup.json", data: new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }) });
    const zip = await createZip(zipFiles);
    const stamp = new Date().toISOString().slice(0, 10);
    saveAs(zip, `infinite-canvas-backup-${stamp}.zip`);
}

// Restore projects, assets, media files, and configuration from a backup zip, replacing current data.
export async function importAppBackup(file: File) {
    // Pass 1: stream the archive to read only the manifest (backup.json). Media bytes are skipped
    // without being retained, so even a multi-hundred-MB backup costs little memory here.
    let manifestText = "";
    await readZipStreaming(file, (name, blob) => {
        if (name === "backup.json") void blob.text().then((text) => (manifestText = text));
    });

    let data: AppBackupFile;
    try {
        data = JSON.parse(manifestText) as AppBackupFile;
    } catch {
        throw new Error(i18n.t("backup.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.assets) || !data.config) throw new Error(i18n.t("backup.invalidFile"));

    // Pass 2: stream again, persisting each media blob to storage as it is decompressed, with bounded
    // concurrency. Peak memory stays near a single file rather than the whole archive.
    const filesByPath = new Map(data.files.map((item) => [item.path, item] as const));
    const writes: Array<Promise<void>> = [];
    await readZipStreaming(file, async (name, blob) => {
        if (name === "backup.json") return;
        const item = filesByPath.get(name);
        if (!item) return;
        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType || "application/octet-stream");
        writes.push(
            (async () => {
                await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
            })().catch(() => undefined),
        );
        if (writes.length >= 8) await Promise.all(writes.splice(0, 8));
    });
    await Promise.all(writes);

    useConfigStore.setState({ config: data.config });
    useCanvasStore.getState().replaceProjects(data.projects);
    useAssetStore.getState().replaceAssets(data.assets);
}

async function collectStoreFiles(store: LocalForage, files: BackupItem[], zipFiles: { name: string; data: BlobPart }[]) {
    await store.iterate((value, key) => {
        if (!(value instanceof Blob)) return;
        const extension = fileExtension(value.type);
        const path = `files/${safeFileName(key)}.${extension}`;
        files.push({ storageKey: key, path, mimeType: value.type || "application/octet-stream" });
        zipFiles.push({ name: path, data: value });
    });
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    return "bin";
}
