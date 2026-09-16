import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { getLocalMediaLibraryMeta, requestLocalMediaLibraryAccess } from "@/services/local-media-library";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function buildCanvasProjectsZip(projects: CanvasProject[]) {
    // Draft/export is always user-triggered — re-acquire local media library permission so blobs
    // migrated out of IndexedDB can still be packed into the zip for another computer.
    if (await getLocalMediaLibraryMeta()) {
        try {
            await requestLocalMediaLibraryAccess();
        } catch {
            // Continue; recovery below may still find in-memory object URLs / data URLs.
        }
    }

    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            const contentByKey = collectContentUrlsByStorageKey(project);
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const blob = await resolveExportBlob(storageKey, contentByKey.get(storageKey));
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project: scrubProjectBlobUrls(project), files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    return createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
}

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    const zip = await buildCanvasProjectsZip(projects);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = await resolveExportBlob(storageKey, node.metadata?.content);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

async function resolveExportBlob(storageKey: string, contentUrl?: string) {
    const fromStore = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
    if (fromStore) return fromStore;
    const url = String(contentUrl || "").trim();
    if (!url) return null;
    if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("http:") || url.startsWith("https:")) {
        try {
            return await (await fetch(url)).blob();
        } catch {
            return null;
        }
    }
    return null;
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    const record = value as Record<string, unknown>;
    for (const field of ["storageKey", "thumbnailStorageKey"] as const) {
        const key = record[field];
        if (typeof key === "string" && key.includes(":")) keys.add(key);
    }
    Object.values(record).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function collectContentUrlsByStorageKey(value: unknown, map = new Map<string, string>()) {
    if (!value || typeof value !== "object") return map;
    const record = value as Record<string, unknown>;
    const storageKey = typeof record.storageKey === "string" ? record.storageKey : "";
    const thumbnailStorageKey = typeof record.thumbnailStorageKey === "string" ? record.thumbnailStorageKey : "";
    const content = typeof record.content === "string" ? record.content : typeof record.dataUrl === "string" ? record.dataUrl : "";
    const thumbnailContent = typeof record.thumbnailContent === "string" ? record.thumbnailContent : "";
    if (storageKey.includes(":") && content && !map.has(storageKey)) map.set(storageKey, content);
    if (thumbnailStorageKey.includes(":") && thumbnailContent && !map.has(thumbnailStorageKey)) map.set(thumbnailStorageKey, thumbnailContent);
    Object.values(record).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectContentUrlsByStorageKey(child, map)) : collectContentUrlsByStorageKey(item, map)));
    return map;
}

/** Drop machine-local blob: URLs so the other computer doesn't try to open dead addresses. */
function scrubProjectBlobUrls(project: CanvasProject): CanvasProject {
    return JSON.parse(JSON.stringify(project, (_key, value) => (typeof value === "string" && value.startsWith("blob:") ? "" : value))) as CanvasProject;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
