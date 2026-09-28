import { getNodeSpec } from "@/constant/canvas";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * In-place node type conversion (image node ↔ video node).
 *
 * Image and video nodes are two flavours of the same "generation slot": same left/right handles, same
 * prompt, same incoming references. So the conversion rewrites the node instead of recreating it —
 * the id never changes, which is what keeps every connection, group membership, merge slot and
 * mention label pointing at the same node.
 *
 * The payload the node renders cannot cross the boundary (a `<video>` pointed at an image is a broken
 * node, and vice versa), so it is *parked* under `metadata.convertedMedia[<type it belonged to>]`
 * rather than dropped: converting back restores it, and because the parked `storageKey` is still
 * referenced by the project JSON, the asset cleanup keeps the file on disk.
 */
const CONVERSION_COUNTERPARTS: Record<string, CanvasNodeType> = {
    [CanvasNodeType.Image]: CanvasNodeType.Video,
    [CanvasNodeType.Video]: CanvasNodeType.Image,
};

/** The type this node can be converted into, or null for node types without a counterpart. */
export function nodeConversionTarget(type: string): CanvasNodeType | null {
    return CONVERSION_COUNTERPARTS[type] || null;
}

/** The media payload the node renders — parked wholesale on conversion. */
const MEDIA_FIELDS = [
    "content",
    "storageKey",
    "thumbnailContent",
    "thumbnailStorageKey",
    "mimeType",
    "bytes",
    "durationMs",
    "naturalWidth",
    "naturalHeight",
    "images",
    "primaryImageId",
    "midjourneyTaskId",
    "midjourneyIndex",
] as const;

/** Generation knobs that only ever applied to one of the two types. */
const IMAGE_ONLY_FIELDS = ["size", "quality", "count", "background", "mjVersion", "generationType", "freeResize"] as const;
const VIDEO_ONLY_FIELDS = ["seconds", "videoResolution", "vquality", "generateAudio", "watermark", "steps", "refImageSize", "samplerName", "scheduler"] as const;

/** Knobs are a real user choice even when falsy (`generateAudio: false`), so they always travel. */
const SOURCE_TYPE_KNOBS: Record<string, readonly string[]> = {
    [CanvasNodeType.Image]: IMAGE_ONLY_FIELDS,
    [CanvasNodeType.Video]: VIDEO_ONLY_FIELDS,
};

type MetadataBag = Record<string, unknown>;

/**
 * A placeholder — not a payload. An untouched node ships `content: ""`, and parking that would keep a
 * useless `convertedMedia` record on every empty node (growing the project JSON) for media that does
 * not exist. Absence is already lossless for a placeholder.
 */
function isPlaceholder(value: unknown) {
    if (value === undefined || value === null || value === "") return true;
    return Array.isArray(value) && value.length === 0;
}

function moveField(from: MetadataBag, to: MetadataBag, field: string, skipPlaceholders = false) {
    if (!(field in from)) return;
    const value = from[field];
    delete from[field];
    if (value === undefined) return;
    if (skipPlaceholders && isPlaceholder(value)) return;
    to[field] = value;
}

/** Does this payload still hold something the node could render? Decides the restored status. */
function hasRenderableMedia(snapshot: MetadataBag) {
    if (typeof snapshot.content === "string" && snapshot.content) return true;
    if (typeof snapshot.storageKey === "string" && snapshot.storageKey) return true;
    const images = snapshot.images;
    return Array.isArray(images) && images.some((image) => Boolean((image as { content?: string })?.content));
}

/**
 * An export / draft round trip scrubs `blob:` URLs while the storage key survives, so a restored
 * payload can come back with a key and no URL. Seeding the URL with the key keeps the display layer
 * on its normal recovery path — a candidate that fails to load is what makes it rebuild a live URL
 * from the key — instead of rendering a blank node for media that is still on disk.
 */
function restoredUrl(content: unknown, storageKey: unknown) {
    if (typeof content === "string" && content) return content;
    return typeof storageKey === "string" ? storageKey : "";
}

function restoreMedia(target: MetadataBag, snapshot: MetadataBag) {
    Object.assign(target, snapshot);
    target.content = restoredUrl(snapshot.content, snapshot.storageKey);
    if (snapshot.thumbnailStorageKey || snapshot.thumbnailContent) target.thumbnailContent = restoredUrl(snapshot.thumbnailContent, snapshot.thumbnailStorageKey);
    if (Array.isArray(snapshot.images)) {
        target.images = snapshot.images.map((image) => {
            const entry = { ...(image as MetadataBag) };
            entry.content = restoredUrl(entry.content, entry.storageKey);
            if (entry.thumbnailStorageKey || entry.thumbnailContent) entry.thumbnailContent = restoredUrl(entry.thumbnailContent, entry.thumbnailStorageKey);
            return entry;
        });
    }
}

export function convertNodeType(node: CanvasNodeData, targetType: CanvasNodeType): CanvasNodeData {
    const sourceType = node.type as CanvasNodeType;
    // Only the image ↔ video pair converts, and only into its counterpart.
    if (nodeConversionTarget(sourceType) !== targetType) return node;

    const metadata = { ...(node.metadata || {}) } as MetadataBag;
    const parkedByType = { ...((metadata.convertedMedia as Record<string, MetadataBag>) || {}) };
    // The counterpart's payload (if the node was once that type) is consumed by this conversion.
    const restored = parkedByType[targetType];

    // 1. Take off everything that belongs to the type we are leaving. Media travels only when it is
    //    actually there; the knobs and the model travel with it either way.
    const parked: MetadataBag = {};
    for (const field of MEDIA_FIELDS) moveField(metadata, parked, field, true);
    for (const field of SOURCE_TYPE_KNOBS[sourceType] || []) moveField(metadata, parked, field);
    // The model was picked for the source type's capability, so it leaves with the payload.
    moveField(metadata, parked, "model", true);

    // 2. Put the target type's parked payload back, so convert-back is lossless.
    delete parkedByType[targetType];
    if (Object.keys(parked).length) parkedByType[sourceType] = parked;
    if (Object.keys(parkedByType).length) metadata.convertedMedia = parkedByType;
    else delete metadata.convertedMedia;
    if (restored) restoreMedia(metadata, restored);

    // Status is recomputed rather than parked: a stale "error" must not follow the media around.
    metadata.status = restored && hasRenderableMedia(restored) ? "success" : "idle";
    delete metadata.errorDetails;

    // Only a title the user never touched follows the node to its new type.
    const spec = getNodeSpec(targetType);
    const title = node.title === getNodeSpec(sourceType).title ? spec.title : node.title;

    return { ...node, type: targetType, title, metadata: metadata as CanvasNodeData["metadata"] };
}

/** The parked payload this conversion left behind, so the caller can tell the user it was kept. */
export function convertedNodeKeptMedia(converted: CanvasNodeData, sourceType: CanvasNodeType) {
    const parked = converted.metadata?.convertedMedia?.[sourceType];
    return Boolean(parked && (parked.content || parked.storageKey || parked.images?.length));
}
