import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { getGenerationResourceNodes } from "@/lib/canvas/canvas-resource-references";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt);
    }

    const upstreamText = inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: mergePromptWithUpstream(prompt, upstreamText),
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

/** Join user prompt + connected text once; skip when the prompt already carries the same upstream body. */
function mergePromptWithUpstream(prompt: string, upstreamText: string) {
    const base = prompt.trim();
    const upstream = upstreamText.trim();
    if (!upstream) return base;
    if (!base) return upstream;
    if (base === upstream || base.endsWith(upstream)) return base;
    return `${base}\n\n${upstream}`;
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = generationLabel(input.type, counts[input.type]++);
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else selectedInputs.push(input);
            }
            nextPrompt += input.type === "text" ? `【${label}】` : label;
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;

    // @mentions shape the prompt text; connected media always count as API references
    // (Config panel shows linked images even when the user did not @ them).
    const mentionedImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const mentionedVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const mentionedAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const connectedImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const connectedVideos = inputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const connectedAudios = inputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const referenceImages = mentionedImages.length ? mentionedImages : connectedImages;
    const referenceVideos = mentionedVideos.length ? mentionedVideos : connectedVideos;
    const referenceAudios = mentionedAudios.length ? mentionedAudios : connectedAudios;

    return {
        prompt: hasToken ? nextPrompt : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: hasToken ? counts.text : inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
        return [];
    });
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    const referenceImages = (
        await Promise.all(
            context.referenceImages.map(async (image) => {
                try {
                    const dataUrl = await imageToDataUrl(image);
                    if (!dataUrl?.startsWith("data:image/") && !/^https?:\/\//i.test(dataUrl || "")) return null;
                    return { ...image, dataUrl };
                } catch {
                    return null;
                }
            }),
        )
    ).filter((image): image is NonNullable<typeof image> => Boolean(image));
    if (context.referenceImages.length && !referenceImages.length) {
        throw new Error(i18n.t("apiErrors.metasoH3ImageUnreadable"));
    }
    return { ...context, referenceImages, imageCount: referenceImages.length };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (type === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Annotate) return null;
    const images = node.metadata?.images || [];
    const primaryId = node.metadata?.primaryImageId || images[0]?.id;
    const primary = images.find((image) => image.id === primaryId) || images[0];
    // Prefer primary version fields — top-level content is often a stale blob: preview after refresh.
    const content = String(primary?.content || node.metadata?.content || "").trim();
    const storageKey = String(primary?.storageKey || node.metadata?.storageKey || "").trim();
    const thumbnailContent = String(primary?.thumbnailContent || node.metadata?.thumbnailContent || "").trim();
    const thumbnailStorageKey = String(primary?.thumbnailStorageKey || node.metadata?.thumbnailStorageKey || "").trim();
    if (!content && !storageKey && !thumbnailContent && !thumbnailStorageKey) return null;
    const preview = content || thumbnailContent;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: primary?.mimeType || node.metadata?.mimeType || "image/png",
        // Keep live blob:/data:/http content for same-session reads; imageToDataUrl recovers via storageKey when blob dies.
        dataUrl: preview || "",
        url: /^https?:\/\//i.test(preview) ? preview : undefined,
        storageKey: storageKey || undefined,
        thumbnailStorageKey: thumbnailStorageKey || undefined,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio) return null;
    const url = node.metadata?.content || node.metadata?.storageKey || "";
    if (!url) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata?.mimeType || "audio/mpeg",
        url,
        storageKey: node.metadata?.storageKey,
        durationMs: node.metadata?.durationMs,
    };
}
