import type { CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type ChatSendOptions = {
    text: boolean;
    image: boolean;
    /** Activated media (image/video) references pinned in the composer, passed through to image generation. */
    linkedMedia?: CanvasResourceReference[];
};

/** 回复里常带 ``` 围栏或「提示词：」前缀 —— 出图前把这些包装剥掉，只留正文。 */
const PROMPT_FENCE_RE = /```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/;
const PROMPT_PREFIX_RE = /^\s*(最终|出图)?\s*(提示词|prompt)\s*[:：]\s*/i;
/** 回复太长基本可以判定不是一段提示词（多半是长报告），此时宁可用用户原话。 */
const MAX_REPLY_PROMPT_CHARS = 2000;

/**
 * 「Agent 写词 + 出图」开关：agent 没往节点里写东西时，用它的回复正文当生图提示词。
 * 拿不到像样的一段词就返回空串，调用方会回落到用户原话 —— 绝不能拿半截汇报去出图。
 */
export function extractPromptFromReply(reply: string | null | undefined): string {
    let text = (reply || "").trim();
    if (!text || text.length > MAX_REPLY_PROMPT_CHARS) return "";
    const fenced = text.match(PROMPT_FENCE_RE);
    if (fenced) text = fenced[1].trim();
    text = text.replace(PROMPT_PREFIX_RE, "").trim();
    return text.length > MAX_REPLY_PROMPT_CHARS ? "" : text;
}

export function resolveChatSendOptions(metadata?: CanvasNodeMetadata): ChatSendOptions {
    if (metadata?.chatTextEnabled !== undefined || metadata?.chatImageEnabled !== undefined) {
        return {
            text: metadata.chatTextEnabled !== false,
            image: Boolean(metadata.chatImageEnabled),
        };
    }
    if (metadata?.generationMode === "image") return { text: false, image: true };
    return { text: true, image: false };
}
