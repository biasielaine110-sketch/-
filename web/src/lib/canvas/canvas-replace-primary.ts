import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/**
 * 「替换首图」候选：连进图片节点的一张链接图，打包成可直接落到目标节点
 * `metadata.images` 列表里的一份**拷贝**（content / storageKey / 缩略图 / 原始尺寸一起搬）。
 *
 * 字段口径与「连线即拾取 → Annotate 载图」（project.tsx）完全一致：先取列表里的主图，
 * 没有列表才回落 `metadata.content` 那份旧版单图。
 */
export type ReplacePrimaryCandidate = {
    /** 链接图所在的源节点（多图源节点会产出多个候选）。 */
    nodeId: string;
    /** 源节点里这张图自己的 id（多图源的 React key / 去重用）。 */
    imageId: string;
    /** 源节点标题，选择弹窗里显示用。 */
    title: string;
    content: string;
    storageKey: string;
    thumbnailContent?: string;
    thumbnailStorageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

const IMAGE_STATUS_SUCCESS = "success";
const IMAGE_STATUS_LOADING = "loading";

function isSuccessfulImage(image: { status?: string; content?: string } | undefined): boolean {
    return Boolean(image && image.content && image.status !== IMAGE_STATUS_LOADING);
}

function payloadFromImage(node: CanvasNodeData, imageId: string, image: { content: string; storageKey?: string; thumbnailContent?: string; thumbnailStorageKey?: string; naturalWidth?: number; naturalHeight?: number; bytes?: number; mimeType?: string }): ReplacePrimaryCandidate {
    const meta = node.metadata;
    return {
        nodeId: node.id,
        imageId,
        title: node.title || "",
        content: image.content,
        storageKey: image.storageKey || meta?.storageKey || "",
        thumbnailContent: image.thumbnailContent || meta?.thumbnailContent,
        thumbnailStorageKey: image.thumbnailStorageKey || meta?.thumbnailStorageKey,
        naturalWidth: image.naturalWidth || meta?.naturalWidth || 0,
        naturalHeight: image.naturalHeight || meta?.naturalHeight || 0,
        bytes: image.bytes || meta?.bytes || 0,
        mimeType: image.mimeType || meta?.mimeType || "",
    };
}

/**
 * 一个图片 / 标注节点上所有「能当首图」的图：
 * - 有批图列表（`metadata.images`）→ 列出全部成功且带内容的图（一张源节点也能给出多张候选）；
 * - 没有列表 → 回落旧版单图 `metadata.content`。
 */
export function imagePayloadsFromNode(node: CanvasNodeData | undefined): ReplacePrimaryCandidate[] {
    if (!node?.metadata) return [];
    const meta = node.metadata;
    const listed = (meta.images || []).filter(isSuccessfulImage);
    if (listed.length) {
        return listed.map((image) => payloadFromImage(node, image.id, image));
    }
    if (!meta.content) return [];
    return [
        payloadFromImage(node, meta.primaryImageId || `legacy-${node.id}`, {
            content: meta.content,
            storageKey: meta.storageKey,
            naturalWidth: meta.naturalWidth,
            naturalHeight: meta.naturalHeight,
            bytes: meta.bytes,
            mimeType: meta.mimeType,
        }),
    ];
}

/**
 * 「替换首图」的候选集：图片节点上**连着的**图片 / 标注节点（连线即拾取的那批）。
 *
 * - 只认 `Image` / `Annotate` 两类源（其它类型就算带了 content 也不是图）；
 * - 排除自己（理论上不会有自环，保险）；
 * - 连线两个方向都算：拖手柄 / 按 X 拾取 / 右键连线的落点方向不统一，
 *   Annotate 载图那条路也是双向认的，这里保持同口径。
 */
export function collectReplacePrimaryCandidates(node: CanvasNodeData | undefined, nodes: CanvasNodeData[], connections: CanvasConnection[]): ReplacePrimaryCandidate[] {
    if (!node) return [];
    const linkedIds = new Set<string>();
    for (const connection of connections) {
        if (connection.toNodeId === node.id) linkedIds.add(connection.fromNodeId);
        else if (connection.fromNodeId === node.id) linkedIds.add(connection.toNodeId);
    }
    linkedIds.delete(node.id);
    if (!linkedIds.size) return [];
    const byId = new Map(nodes.map((item) => [item.id, item]));
    const candidates: ReplacePrimaryCandidate[] = [];
    for (const id of linkedIds) {
        const source = byId.get(id);
        if (!source) continue;
        const isImageish = source.type === CanvasNodeType.Image || source.type === CanvasNodeType.Annotate;
        if (!isImageish) continue;
        candidates.push(...imagePayloadsFromNode(source));
    }
    return candidates;
}
