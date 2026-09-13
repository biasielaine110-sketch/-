import { strFromU8, unzipSync } from "fflate";

import i18n from "@/i18n";

const PLAIN_TEXT_EXTENSIONS = /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|log|html?|xml|ya?ml|toml|ini|cfg|conf|rtf|srt|vtt)$/i;
const DOCX_EXTENSION = /\.docx$/i;
const PDF_EXTENSION = /\.pdf$/i;
const DOC_EXTENSION = /\.docx?$/i;

/** True for files that should become canvas text nodes when dropped/imported. */
export function isDocumentFile(file: File) {
    const name = file.name || "";
    const type = (file.type || "").toLowerCase();
    if (DOCX_EXTENSION.test(name) || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
    if (PDF_EXTENSION.test(name) || type === "application/pdf") return true;
    if (/\.doc$/i.test(name) || type === "application/msword") return true;
    if (type.startsWith("text/")) return true;
    if (type === "application/json" || type === "application/xml" || type === "application/rtf") return true;
    return PLAIN_TEXT_EXTENSIONS.test(name);
}

export function isPlainTextDocumentFile(file: File) {
    if (!isDocumentFile(file)) return false;
    const name = file.name || "";
    const type = (file.type || "").toLowerCase();
    if (DOC_EXTENSION.test(name) || type.includes("word") || type === "application/pdf" || PDF_EXTENSION.test(name)) return false;
    return true;
}

/** Read document bytes into plain text for a Text node. */
export async function readDocumentAsText(file: File): Promise<string> {
    const name = file.name || "document";
    const type = (file.type || "").toLowerCase();

    if (/\.doc$/i.test(name) && !DOCX_EXTENSION.test(name)) {
        throw new Error(i18n.t("canvas.projectPage.documentDocUnsupported"));
    }

    if (DOCX_EXTENSION.test(name) || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        return readDocxAsText(await file.arrayBuffer());
    }

    if (PDF_EXTENSION.test(name) || type === "application/pdf") {
        return readPdfAsText(await file.arrayBuffer());
    }

    if (/\.rtf$/i.test(name) || type === "application/rtf" || type === "text/rtf") {
        return stripRtf(await file.text());
    }

    const text = await file.text();
    const trimmed = text.replace(/^\uFEFF/, "").trim();
    if (!trimmed) throw new Error(i18n.t("canvas.projectPage.documentEmpty", { name }));
    return trimmed;
}

function readDocxAsText(buffer: ArrayBuffer) {
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(new Uint8Array(buffer));
    } catch {
        throw new Error(i18n.t("canvas.projectPage.documentReadFailed"));
    }
    const doc = entries["word/document.xml"];
    if (!doc) throw new Error(i18n.t("canvas.projectPage.documentReadFailed"));
    const xml = strFromU8(doc);
    const text = xml
        .replace(/<w:tab\/>/gi, "\t")
        .replace(/<w:br\b[^>]*\/>/gi, "\n")
        .replace(/<\/w:p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (!text) throw new Error(i18n.t("canvas.projectPage.documentEmpty", { name: "document.docx" }));
    return text;
}

async function readPdfAsText(buffer: ArrayBuffer) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const loadingTask = pdfjs.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const line = content.items
            .map((item) => ("str" in item ? String(item.str || "") : ""))
            .join(" ")
            .replace(/[ \t]+/g, " ")
            .trim();
        if (line) pages.push(line);
    }
    const text = pages.join("\n\n").trim();
    if (!text) throw new Error(i18n.t("canvas.projectPage.documentPdfNoText"));
    return text;
}

function stripRtf(input: string) {
    const text = input
        .replace(/\\par[d]?/g, "\n")
        .replace(/\\tab/g, "\t")
        .replace(/\\'[0-9a-fA-F]{2}/g, "")
        .replace(/\\[a-z]+(-?\d+)?[ ]?/gi, "")
        .replace(/[{}]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (!text) throw new Error(i18n.t("canvas.projectPage.documentEmpty", { name: "document.rtf" }));
    return text;
}
