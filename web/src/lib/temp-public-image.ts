import axios from "axios";

import { proxyMediaUrl } from "@/lib/api-proxy";

function isPublicHttpUrl(value: string) {
    return /^https?:\/\//i.test((value || "").trim());
}

function publicImageFilename(blob: Blob) {
    if (blob.type.includes("png")) return "reference.png";
    if (blob.type.includes("webp")) return "reference.webp";
    return "reference.jpg";
}

function readPlainPublicUrl(response: { data: unknown }, fallbackMessage: string) {
    const text = String(response.data || "").trim();
    const url = text.split(/\s+/)[0] || "";
    if (!isPublicHttpUrl(url)) throw new Error(text.slice(0, 180) || fallbackMessage);
    return url;
}

async function uploadTmpFilesImage(blob: Blob, filename: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append("file", blob, filename);
    const response = await axios.post<{ data?: { url?: string }; url?: string; status?: string }>(proxyMediaUrl("https://tmpfiles.org/api/v1/upload"), form, { signal });
    const raw = String(response.data?.data?.url || response.data?.url || "").trim();
    if (!raw) throw new Error("temporary image host rejected the upload");
    // tmpfiles share links need /dl/ for a direct file URL that Metaso can fetch.
    const match = raw.match(/tmpfiles\.org\/(?:dl\/)?(\d+)\/(.+)$/i);
    if (match) return `https://tmpfiles.org/dl/${match[1]}/${match[2]}`;
    // Newer tmpfiles short links: https://tmpfiles.org/<id>/name — convert to /dl/ when numeric id is present.
    const short = raw.match(/tmpfiles\.org\/([A-Za-z0-9]+)\/(.+)$/i);
    if (short && /^\d+$/.test(short[1])) return `https://tmpfiles.org/dl/${short[1]}/${short[2]}`;
    return raw.replace(/^http:\/\//i, "https://");
}

async function uploadLitterboxImage(blob: Blob, filename: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "24h");
    form.append("fileToUpload", blob, filename);
    return readPlainPublicUrl(
        await axios.post<string>(proxyMediaUrl("https://litterbox.catbox.moe/resources/internals/api.php"), form, { signal, responseType: "text" }),
        "temporary image host rejected the upload",
    );
}

async function uploadCatboxImage(blob: Blob, filename: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", blob, filename);
    return readPlainPublicUrl(
        await axios.post<string>(proxyMediaUrl("https://catbox.moe/user/api.php"), form, { signal, responseType: "text" }),
        "temporary image host rejected the upload",
    );
}

async function uploadNullPointerImage(blob: Blob, filename: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append("file", blob, filename);
    return readPlainPublicUrl(await axios.post<string>(proxyMediaUrl("https://0x0.st"), form, { signal, responseType: "text" }), "temporary image host rejected the upload");
}

/** Upload a local image blob to a short-lived public host (needed when providers reject data URLs). */
export async function uploadTemporaryPublicImage(blob: Blob, filename = "reference.png", signal?: AbortSignal) {
    const name = filename || publicImageFilename(blob);
    const attempts = [() => uploadLitterboxImage(blob, name, signal), () => uploadCatboxImage(blob, name, signal), () => uploadTmpFilesImage(blob, name, signal), () => uploadNullPointerImage(blob, name, signal)];
    let lastError: unknown;
    for (const attempt of attempts) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const url = (await attempt()).trim();
            if (isPublicHttpUrl(url) && !url.startsWith("data:")) return url;
        } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("temporary image host upload failed");
}

export async function uploadTemporaryPublicImageFromDataUrl(dataUrl: string, signal?: AbortSignal) {
    if (!dataUrl?.startsWith("data:image/")) throw new Error("temporary image host upload failed");
    const blob = await (await fetch(dataUrl)).blob();
    return uploadTemporaryPublicImage(blob, publicImageFilename(blob), signal);
}
