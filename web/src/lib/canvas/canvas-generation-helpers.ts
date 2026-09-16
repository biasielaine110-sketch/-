import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { ensureImageThumbnail, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageMetadata, referenceUrl } from "@/lib/canvas/canvas-node-factory";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeImage, type CanvasNodeMetadata } from "@/types/canvas";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export type HydrateCanvasMediaOptions = {
    /** `fast` (default): primary + thumbs only — keeps refresh snappy. `full`: every history version. */
    mode?: "fast" | "full";
};

function isDeadBlobUrl(url?: string) {
    return Boolean(url?.startsWith("blob:"));
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[], options?: HydrateCanvasMediaOptions) {
    const mode = options?.mode || "fast";
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                const list = node.metadata?.images || [];
                const primaryId = node.metadata?.primaryImageId || list[0]?.id;
                const images = await Promise.all(
                    list.map(async (image) => {
                        if (!image.content && !image.storageKey) return image;
                        const isPrimary = image.id === primaryId;
                        // Fast path: only materialize the playable primary; keep storageKey for later.
                        if (mode === "fast" && !isPrimary) {
                            return {
                                ...image,
                                content: isDeadBlobUrl(image.content) ? "" : image.content,
                            };
                        }
                        const nextContent = image.storageKey
                            ? await resolveMediaUrl(image.storageKey, image.content)
                            : isDeadBlobUrl(image.content)
                              ? ""
                              : image.content;
                        return { ...image, content: nextContent };
                    }),
                );
                const primary = images.find((image) => image.id === primaryId && image.content) || images.find((image) => image.content);
                const nextContent = node.metadata?.storageKey
                    ? await resolveMediaUrl(node.metadata.storageKey, content)
                    : isDeadBlobUrl(content)
                      ? primary?.content || ""
                      : content;
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        content: nextContent || primary?.content || "",
                        storageKey: node.metadata?.storageKey || primary?.storageKey,
                        images,
                    },
                };
            }
            if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Annotate) return node;
            // storageKey alone is enough after draft import (content may be scrubbed empty / dead blob).
            if (!content && !node.metadata?.storageKey && !(node.metadata?.images || []).some((image) => image.storageKey || image.content)) return node;
            const list = node.metadata?.images || [];
            const primaryId = node.metadata?.primaryImageId || list[0]?.id;
            const images = await Promise.all(
                list.map(async (image) => {
                    if (!image.content && !image.storageKey) return image;
                    const isPrimary = image.id === primaryId;
                    const thumbnailContent = image.thumbnailStorageKey
                        ? await resolveImageUrl(image.thumbnailStorageKey, image.thumbnailContent || "")
                        : isDeadBlobUrl(image.thumbnailContent)
                          ? ""
                          : image.thumbnailContent;
                    // Fast path: non-primary versions only need a thumb for the filmstrip.
                    if (mode === "fast" && !isPrimary) {
                        return {
                            ...image,
                            content: isDeadBlobUrl(image.content) ? "" : image.content,
                            thumbnailContent,
                        };
                    }
                    const nextContent = image.storageKey ? await resolveImageUrl(image.storageKey, image.content) : isDeadBlobUrl(image.content) ? "" : image.content;
                    return { ...image, content: nextContent, thumbnailContent };
                }),
            );
            if (node.metadata?.storageKey) {
                const thumbnailContent = node.metadata.thumbnailStorageKey
                    ? await resolveImageUrl(node.metadata.thumbnailStorageKey, node.metadata.thumbnailContent || "")
                    : isDeadBlobUrl(node.metadata.thumbnailContent)
                      ? ""
                      : node.metadata.thumbnailContent;
                // Prefer thumbnail for canvas chrome when available; still resolve full primary for crisp display.
                const fullContent = await resolveImageUrl(node.metadata.storageKey, content);
                return { ...node, metadata: { ...node.metadata, content: fullContent, thumbnailContent, images } };
            }
            if (!content || !content.startsWith("data:image/")) return { ...node, metadata: { ...node.metadata, content: isDeadBlobUrl(content) ? "" : content, images } };
            return { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadImage(content)), images } };
        }),
    );
}

/** Fill remaining history versions after first paint (video/audio/image batch). */
export async function hydrateCanvasMediaDeferred(nodes: CanvasNodeData[], signal?: AbortSignal) {
    const needsWork = nodes.some((node) => {
        const list = node.metadata?.images || [];
        if (list.length <= 1) return false;
        const primaryId = node.metadata?.primaryImageId || list[0]?.id;
        return list.some((image) => image.id !== primaryId && image.storageKey && (!image.content || isDeadBlobUrl(image.content)));
    });
    if (!needsWork) return nodes;
    if (signal?.aborted) return nodes;
    return hydrateCanvasImages(nodes, { mode: "full" });
}

function yieldToMain() {
    return new Promise<void>((resolve) => {
        const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
        if (typeof idle === "function") idle(() => resolve(), { timeout: 800 });
        else setTimeout(resolve, 24);
    });
}

async function ensureNodeImageThumb(image: Pick<CanvasNodeImage, "storageKey" | "content" | "thumbnailStorageKey" | "thumbnailContent" | "naturalWidth" | "naturalHeight">) {
    if (image.thumbnailStorageKey && image.thumbnailContent) return null;
    if (!image.storageKey) return null;
    return ensureImageThumbnail({
        storageKey: image.storageKey,
        contentUrl: image.content,
        thumbnailStorageKey: image.thumbnailStorageKey,
        width: image.naturalWidth,
        height: image.naturalHeight,
    });
}

/** Background-fill persisted thumbnails for legacy nodes missing them. Safe to interrupt. */
export async function backfillCanvasImageThumbnails(
    nodes: CanvasNodeData[],
    onNodePatched?: (nodeId: string, patch: { thumbnailContent?: string; thumbnailStorageKey?: string; images?: CanvasNodeImage[] }) => void,
    signal?: AbortSignal,
) {
    for (const node of nodes) {
        if (signal?.aborted) return;
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Annotate) continue;

        let imagesChanged = false;
        const images = node.metadata?.images ? [...node.metadata.images] : undefined;
        if (images?.length) {
            for (let index = 0; index < images.length; index += 1) {
                if (signal?.aborted) return;
                const image = images[index];
                const thumb = await ensureNodeImageThumb(image);
                if (thumb) {
                    images[index] = { ...image, thumbnailContent: thumb.thumbnailUrl, thumbnailStorageKey: thumb.thumbnailStorageKey };
                    imagesChanged = true;
                }
                await yieldToMain();
            }
        }

        let primaryThumb: { thumbnailUrl: string; thumbnailStorageKey: string } | null = null;
        if (node.metadata?.storageKey && !(node.metadata.thumbnailStorageKey && node.metadata.thumbnailContent)) {
            primaryThumb = await ensureImageThumbnail({
                storageKey: node.metadata.storageKey,
                contentUrl: node.metadata.content,
                thumbnailStorageKey: node.metadata.thumbnailStorageKey,
                width: node.metadata.naturalWidth,
                height: node.metadata.naturalHeight,
            });
            await yieldToMain();
        }

        if (!primaryThumb && !imagesChanged) continue;
        onNodePatched?.(node.id, {
            ...(primaryThumb ? { thumbnailContent: primaryThumb.thumbnailUrl, thumbnailStorageKey: primaryThumb.thumbnailStorageKey } : {}),
            ...(imagesChanged ? { images } : {}),
        });
    }
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...config,
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        sunoVersion: node?.metadata?.sunoVersion || config.sunoVersion || defaultConfig.sunoVersion,
        sunoCustom: node?.metadata?.sunoCustom || config.sunoCustom || defaultConfig.sunoCustom,
        sunoInstrumental: node?.metadata?.sunoInstrumental || config.sunoInstrumental || defaultConfig.sunoInstrumental,
        sunoTitle: node?.metadata?.sunoTitle || config.sunoTitle || defaultConfig.sunoTitle,
        sunoStyle: node?.metadata?.sunoStyle || config.sunoStyle || defaultConfig.sunoStyle,
        sunoVocalGender: node?.metadata?.sunoVocalGender || config.sunoVocalGender || defaultConfig.sunoVocalGender,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
    };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    return nodes.map((node) =>
        node.metadata?.status === "loading"
            ? {
                  ...node,
                  metadata: {
                      ...node.metadata,
                      status: "error" as const,
                      errorDetails: i18n.t("canvas.generation.interrupted"),
                      images: node.metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : image)),
                  },
              }
            : node,
    );
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === i18n.t("common.requestCanceled") || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? i18n.t("canvas.generation.front") : params.horizontalAngle > 0 ? i18n.t("canvas.generation.rotateRight", { angle: params.horizontalAngle }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(params.horizontalAngle) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", { horizontal, pitch, distance: params.cameraDistance.toFixed(1), lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard") });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}
