import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { isDocumentFile } from "./document-text";
import { isAudioFile } from "./canvas-generation-helpers";

/**
 * 剪贴板 → 画布的纯函数集合。
 *
 * 放在 `lib` 而不是页面里，是因为「粘贴识别不上」是一串**可单测的判定**：
 * 远程图 src、没有 MIME 的文件、纯文本里的 data: 媒体、以及「这段剪贴板是不是画布自己写的」。
 * 页面里只留事件编排，判定全部收在这里（探针 `threefix-probe.ts` 直接盖这些函数）。
 */

/**
 * 从 paste 事件读出可贴进输入框的纯文本。
 * 飞书 / Word / 网页常只有 html、或 text/plain 为空；不能只认 plain，否则 preventDefault 后就是「粘贴为空」。
 */
export function readClipboardEventText(data: DataTransfer | null | undefined): string {
    if (!data) return "";
    const plain = data.getData("text/plain") || data.getData("text") || "";
    if (plain) return plain;
    const html = data.getData("text/html") || "";
    if (!html) return "";
    return htmlToPlainText(html);
}

export function htmlToPlainText(html: string): string {
    if (!html) return "";
    // DOMParser 比一串 replace 更稳：能解开实体、丢掉 script/style。
    try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc.querySelectorAll("script,style,noscript").forEach((node) => node.remove());
        // 块级结束补换行，避免「一段粘成一行」。
        doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
        doc.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6").forEach((node) => {
            if (!node.textContent?.endsWith("\n")) node.append("\n");
        });
        return (doc.body?.textContent || "").replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
    } catch {
        return html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/gi, " ")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&amp;/gi, "&")
            .replace(/\r\n?/g, "\n");
    }
}

/** 把文本插入受控 textarea / input，并摆好光标。 */
export function insertTextIntoInputElement(element: HTMLInputElement | HTMLTextAreaElement, text: string, currentValue: string) {
    const start = element.selectionStart ?? currentValue.length;
    const end = element.selectionEnd ?? currentValue.length;
    const next = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
    const caret = start + text.length;
    return { next, caret };
}

/**
 * 剪贴板 html 里的**远程**图片地址（`<img src="https://…">`）。
 *
 * 只认 `data:` 的那条路（`extractClipboardDataImage`）不够用：网页 / 飞书 / 语雀复制正文时
 * 更常见的是远程 src，且剪贴板里既没有 file 项、图也不是 data: —— 以前这类内容会掉进
 * 「纯文本」分支，于是只有一段 URL 或什么都没有，用户看到的就是「粘不进图」。
 */
export function extractClipboardRemoteImage(html: string): string {
    if (!html) return "";
    const pattern = /<img[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
    for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
        const url = match[1];
        // 统计图标 / 分隔线几乎都在这几个词里，别把网页的装饰图贴进画布。
        if (/emoji|sprite|icon/i.test(url)) continue;
        return url;
    }
    return "";
}

/**
 * 文件的媒体种类（粘贴 / 拖拽落节点时分流用）。
 *
 * `file.type` 缺失（资源管理器复制、部分 WebView）时按扩展名兜底 —— 否则一段 mp4 会被
 * 当成图片塞进 `createImageFileNode`，表现是「粘进来了但什么都没有」。
 */
export function resolveClipboardMediaKind(file: File): "document" | "audio" | "video" | "image" {
    if (isDocumentFile(file)) return "document";
    if (isAudioFile(file) || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma|amr)$/i.test(file.name || "")) return "audio";
    if ((file.type || "").toLowerCase().startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v|avi|mpe?g|ts)$/i.test(file.name || "")) return "video";
    return "image";
}

/** 剪贴板里能变成节点的文件（含「type 为空、只靠扩展名认出」的情况）。 */
export function isPasteableNodeFile(file: File) {
    const type = (file.type || "").toLowerCase();
    if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return true;
    if (isDocumentFile(file) || isAudioFile(file)) return true;
    return /\.(png|jpe?g|webp|gif|bmp|avif|heic|mp4|mov|webm|mkv|m4v|mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name || "");
}

/** 纯文本本身就是一张 `data:` 图 / 一段媒体（开发者工具、编辑器里复制 base64 很常见）。 */
export function mediaFileFromClipboardText(text: string): File | null {
    if (!/^data:(image|video|audio)\//i.test(text)) return null;
    const head = text.slice(0, text.indexOf(","));
    const mime = head.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || "";
    const extension = mime.split("/")[1]?.split(";")[0]?.replace(/\+.*$/, "") || "bin";
    try {
        const [, payload] = text.split(",");
        if (!payload) return null;
        if (/;base64$/i.test(head)) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return new File([bytes], `clipboard-${Date.now()}.${extension}`, { type: mime });
        }
        return new File([decodeURIComponent(payload)], `clipboard-${Date.now()}.${extension}`, { type: mime });
    } catch {
        return null;
    }
}

/**
 * Ctrl+C 时同时写进系统剪贴板的「指纹」。
 *
 * 画布内复制节点不写系统剪贴板，于是 Ctrl+V 时无法区分「要粘贴刚复制的节点」和「要粘贴外部内容」——
 * 以前一律当成内部粘贴（`preventDefault()` 掉原生事件），这就是「从外部复制的内容粘不进来」的根因。
 * 现在复制时把这段文字也写进剪贴板：文本节点写内容（顺带变成「复制文本」），其余节点写标题清单；
 * 粘贴时只要剪贴板里的文字与之一致，就确认是内部复制。
 */
export function clipboardTextSnapshot(nodes: CanvasNodeData[]): string {
    const only = nodes.length === 1 ? nodes[0] : null;
    if (only && (only.type === CanvasNodeType.Text || only.type === CanvasNodeType.Script)) {
        const content = (only.metadata?.content || "").trim();
        if (content) return content;
    }
    return `画布节点 ${nodes.length} 个：${nodes.map((node) => node.title || node.type).join("、")}`;
}
