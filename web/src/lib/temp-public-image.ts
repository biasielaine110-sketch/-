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
    const attempts = [() => uploadLitterboxImage(blob, name, signal), () => uploadCatboxImage(blob, name, signal), () => uploadNullPointerImage(blob, name, signal)];
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
