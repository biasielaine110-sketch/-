import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

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

// ---------------------------------------------------------------------------
// Export: text node content → .docx
//
// A .docx is just a ZIP of OOXML parts, and fflate is already a dependency, so the package is
// assembled here by hand instead of pulling in a document library. Five parts are enough for Word,
// WPS and LibreOffice: the content-type map, the package relationships, both docProps and the body.
// ---------------------------------------------------------------------------

export const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Word measures run sizes in half-points. The body is set at 21 (10.5pt ≈ 五号), the size Chinese
 * documents are normally written in; headings scale up from there by level.
 */
const DOCX_BODY_HALF_POINTS = 21;
const DOCX_HEADING_HALF_POINTS = [32, 28, 24, 22, 22, 22];
const DOCX_CODE_FONT = "Consolas";
const DOCX_BODY_PPROPS = '<w:spacing w:after="120"/>';
const DOCX_LIST_PPROPS = '<w:ind w:left="420" w:hanging="210"/><w:spacing w:after="60"/>';
const DOCX_QUOTE_PPROPS = '<w:ind w:left="420"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:spacing w:after="120"/>';
const DOCX_CODE_PPROPS = '<w:ind w:left="420"/><w:spacing w:after="0"/>';
const DOCX_RULE_PPROPS = '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:before="120" w:after="120"/>';
// XML 1.0 forbids these code points outright; one stray control char pasted into a text node would
// make the whole package unopenable rather than merely ugly.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const DOCX_PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOCX_APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Infinite Atelier</Application></Properties>`;

/**
 * Build an OOXML package (.docx) from the markdown-ish text a text node holds. Headings, lists,
 * quotes and inline emphasis become real Word formatting so the exported file opens formatted
 * instead of showing raw `#` / `**` markers.
 */
export function buildDocxBlob(markdown: string, options?: { title?: string }): Blob {
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXmlText(options?.title || "")}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
    const entries: Record<string, Uint8Array> = {
        "[Content_Types].xml": strToU8(DOCX_CONTENT_TYPES),
        "_rels/.rels": strToU8(DOCX_PACKAGE_RELS),
        "docProps/app.xml": strToU8(DOCX_APP_PROPS),
        "docProps/core.xml": strToU8(core),
        "word/document.xml": strToU8(buildDocumentXml(markdown)),
    };
    return new Blob([zipSync(entries)], { type: DOCX_MIME_TYPE });
}

function escapeXmlText(value: string) {
    return value
        .replace(INVALID_XML_CHARS, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

type DocxRunStyle = { size: number; bold?: boolean; italic?: boolean; code?: boolean };

function docxRun(text: string, style: DocxRunStyle) {
    const value = escapeXmlText(text);
    if (!value) return "";
    const props = [
        style.code ? `<w:rFonts w:ascii="${DOCX_CODE_FONT}" w:hAnsi="${DOCX_CODE_FONT}" w:cs="${DOCX_CODE_FONT}"/>` : "",
        style.bold ? "<w:b/>" : "",
        style.italic ? "<w:i/>" : "",
        `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`,
    ].join("");
    return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${value}</w:t></w:r>`;
}

function docxParagraph(runs: string, props = DOCX_BODY_PPROPS) {
    return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs}</w:p>`;
}

// Delimiters are captured so `split` keeps them and the loop below can classify each part.
const INLINE_TOKEN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

/** Inline markdown → a run sequence. Nesting inside emphasis is not recursed. */
function docxRunsOf(text: string, base?: Partial<DocxRunStyle>) {
    if (!text) return "";
    return text
        .split(INLINE_TOKEN)
        .map((part) => {
            if (!part) return "";
            const size = base?.size ?? DOCX_BODY_HALF_POINTS;
            if (part.length > 4 && (part.startsWith("**") || part.startsWith("__")) && part.endsWith(part.slice(0, 2))) {
                return docxRun(part.slice(2, -2), { size, bold: true, italic: base?.italic });
            }
            if (part.length > 2 && (part.startsWith("*") || part.startsWith("_")) && part.endsWith(part[0])) {
                return docxRun(part.slice(1, -1), { size, italic: !base?.italic, bold: base?.bold });
            }
            if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
                return docxRun(part.slice(1, -1), { size, code: true, bold: base?.bold, italic: base?.italic });
            }
            const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
            if (link) {
                // Keep the target address: a .docx is often read away from the canvas, where a bare
                // label would lose the destination for good.
                const label = link[1] === link[2] ? link[1] : `${link[1]} (${link[2]})`;
                return docxRun(label, { size, bold: base?.bold, italic: base?.italic });
            }
            return docxRun(part, { size, bold: base?.bold, italic: base?.italic });
        })
        .join("");
}

function buildDocumentXml(markdown: string) {
    const body: string[] = [];
    let inCodeFence = false;
    for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (/^\s*(```|~~~)/.test(line)) {
            inCodeFence = !inCodeFence;
            continue;
        }
        if (inCodeFence) {
            body.push(docxParagraph(docxRun(line || " ", { size: DOCX_BODY_HALF_POINTS, code: true }), DOCX_CODE_PPROPS));
            continue;
        }
        // Blank lines separate blocks in markdown, but each line already becomes its own Word
        // paragraph, so emitting them too would double every gap.
        if (!line.trim()) continue;
        if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
            body.push(docxParagraph("", DOCX_RULE_PPROPS));
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            const props = `<w:spacing w:before="${level === 1 ? 0 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/>`;
            body.push(docxParagraph(docxRunsOf(heading[2], { size: DOCX_HEADING_HALF_POINTS[level - 1], bold: true }), props));
            continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            body.push(docxParagraph(docxRun("• ", { size: DOCX_BODY_HALF_POINTS }) + docxRunsOf(bullet[1]), DOCX_LIST_PPROPS));
            continue;
        }
        const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
        if (ordered) {
            body.push(docxParagraph(docxRun(`${ordered[1]}. `, { size: DOCX_BODY_HALF_POINTS }) + docxRunsOf(ordered[2]), DOCX_LIST_PPROPS));
            continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
            body.push(docxParagraph(docxRunsOf(quote[1], { italic: true }), DOCX_QUOTE_PPROPS));
            continue;
        }
        body.push(docxParagraph(docxRunsOf(line)));
    }
    // A body must not be empty and must end with a paragraph before sectPr, or Word "repairs" the file.
    if (!body.length) body.push(docxParagraph(""));
    const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}${sectPr}</w:body></w:document>`;
}
