import type { CanvasNodeMetadata } from "@/types/canvas";

export type ChatSendOptions = {
    text: boolean;
    image: boolean;
};

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
