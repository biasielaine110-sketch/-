import type { CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type ChatSendOptions = {
    text: boolean;
    image: boolean;
    /** Activated media (image/video) references pinned in the composer, passed through to image generation. */
    linkedMedia?: CanvasResourceReference[];
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
