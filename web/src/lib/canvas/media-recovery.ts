import i18n from "@/i18n";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { listIndexedDbImageEntries, refreshImageUrl } from "@/services/image-storage";
import { listIndexedDbMediaEntries, refreshMediaUrl } from "@/services/file-storage";

/**
 * 「本地文件缺失」的**找回**通道 —— 只读本地库，绝不发起任何生成请求。
 *
 * 为什么需要这一层：`hydrateCanvasImages` 用的是 `resolveImageUrl`，它会命中模块内的
 * `objectUrls` 缓存。缓存里那条 URL 只要被 revoke 过（清理、切画布、配额回收都可能），
 * 之后每次「恢复」都会拿到同一个死 URL —— 节点永远显示「图片缓存已失效」，
 * 用户只能点「重试」→ 重新生成 → 真花钱。这里用 `refresh*Url` **强制重读字节、重建 URL**，
 * 把「能找回的」全部找回，剩下的才是真的没了。
 *
 * 🔴 本模块所有函数都是只读的：不删字节、不发请求、不改费用。
 */

const IMAGE_TYPES = new Set<string>([CanvasNodeType.Image, CanvasNodeType.Annotate]);
const MEDIA_TYPES = new Set<string>([CanvasNodeType.Video, CanvasNodeType.Audio]);

/** 这段 errorDetails 是不是「本地文件缺失」（而不是模型真的生成失败）。 */
export function isMediaMissingDetail(detail: string | undefined) {
    const text = String(detail || "");
    if (!text) return false;
    const missing = i18n.t("canvas.generation.mediaMissing");
    if (text === missing) return true;
    return /媒体丢失|本地文件缺失|图片缓存已失效|media .*missing|Image cache is missing/i.test(text);
}

/** 节点是不是「一个能显示的媒体都没有」。 */
export function needsMediaRecovery(node: CanvasNodeData) {
    if (!IMAGE_TYPES.has(node.type) && !MEDIA_TYPES.has(node.type)) return false;
    const meta = node.metadata;
    if (!meta) return false;
    // 没有任何本地线索的节点（既没 key 也没 content）连试都不用试。
    const hasKeys = Boolean(meta.storageKey || meta.thumbnailStorageKey) || (meta.images || []).some((image) => image.storageKey || image.thumbnailStorageKey);
    if (!hasKeys) return false;
    const visible = Boolean(meta.content || meta.thumbnailContent) || (meta.images || []).some((image) => image.content || image.thumbnailContent);
    return !visible;
}

/**
 * 对**单个**节点强制重读本地字节。找回成功返回打过补丁的节点，找不回返回 null。
 *
 * 顺序：主图 storageKey → 主图缩略图 → 每个历史版本的 storageKey / 缩略图。
 * 只要有一个能读出字节，就把它当成可见内容挂回去（缩略图也能先顶上，不至于空白）。
 */
export async function recoverNodeMedia(node: CanvasNodeData): Promise<CanvasNodeData | null> {
    const meta = node.metadata;
    if (!meta) return null;

    if (IMAGE_TYPES.has(node.type)) {
        let content = "";
        let storageKey = meta.storageKey;
        let thumbnailContent = meta.thumbnailContent || "";
        let thumbnailStorageKey = meta.thumbnailStorageKey;

        if (storageKey) {
            content = await refreshImageUrl(storageKey);
            if (!content) storageKey = undefined;
        }
        if (!content && thumbnailStorageKey) {
            const thumb = await refreshImageUrl(thumbnailStorageKey);
            if (thumb) {
                thumbnailContent = thumb;
                content = thumb;
                storageKey = thumbnailStorageKey;
            }
        }

        const images = await Promise.all(
            (meta.images || []).map(async (image) => {
                if (image.content) return image;
                const key = image.storageKey || image.thumbnailStorageKey;
                if (!key) return image;
                const url = await refreshImageUrl(key);
                if (!url) return image;
                return {
                    ...image,
                    content: url,
                    storageKey: image.storageKey || key,
                    status: "success" as const,
                    // 字节已经读回来了，单图的「恢复中」标记必须撤掉，否则历史版本会永远转圈。
                    mediaRestoring: undefined,
                    errorDetails: undefined,
                };
            }),
        );
        const primaryId = meta.primaryImageId || images[0]?.id;
        const primary = images.find((image) => image.id === primaryId && image.content) || images.find((image) => image.content);
        if (!content && primary?.content) {
            content = primary.content;
            storageKey = storageKey || primary.storageKey;
            thumbnailContent = thumbnailContent || primary.thumbnailContent || primary.content;
            thumbnailStorageKey = thumbnailStorageKey || primary.thumbnailStorageKey;
        }
        if (!content && !thumbnailContent) return null;

        return {
            ...node,
            metadata: {
                ...meta,
                content,
                storageKey: storageKey || meta.storageKey,
                thumbnailContent: thumbnailContent || meta.thumbnailContent,
                thumbnailStorageKey: thumbnailStorageKey || meta.thumbnailStorageKey,
                images,
                status: "success" as const,
                mediaRestoring: undefined,
                errorDetails: undefined,
            },
        };
    }

    if (MEDIA_TYPES.has(node.type)) {
        if (!meta.storageKey) return null;
        const url = await refreshMediaUrl(meta.storageKey);
        if (!url) return null;
        return {
            ...node,
            metadata: {
                ...meta,
                content: url,
                status: "success" as const,
                mediaRestoring: undefined,
                errorDetails: undefined,
            },
        };
    }

    return null;
}

/**
 * 批量找回：只碰「缺媒体且有本地线索」的节点，逐个强制重读。
 * 纯本地操作，节点再多也只是磁盘读，不会产生任何费用。
 */
export async function recoverMissingMedia(nodes: CanvasNodeData[]) {
    let recovered = 0;
    const missingIds: string[] = [];
    let changed = false;
    const next = await Promise.all(
        nodes.map(async (node) => {
            if (!needsMediaRecovery(node)) return node;
            const fixed = await recoverNodeMedia(node).catch(() => null);
            if (!fixed) {
                missingIds.push(node.id);
                return node;
            }
            recovered += 1;
            changed = true;
            return fixed;
        }),
    );
    return { nodes: changed ? next : nodes, recovered, missingIds };
}

export type LocalMediaInventory = {
    images: number;
    videos: number;
    referenced: number;
    orphanImages: number;
    orphanVideos: number;
};

/**
 * 本地库体检（只读）：数一数库里还有多少字节、其中多少个已经没有任何节点 / 素材引用。
 *
 * ⚠️ 会遍历 IndexedDB 的**值**（视频几十 MB，遍历一次不便宜），所以只在用户**主动点**
 * 「找回本地文件」时调用，绝不能挂在打开画布的热路径上。
 */
export async function inspectLocalMedia(referencedKeys: Set<string>): Promise<LocalMediaInventory> {
    const images = await listIndexedDbImageEntries();
    const videos = await listIndexedDbMediaEntries();
    const orphanImages = images.filter((entry) => !referencedKeys.has(entry.storageKey)).length;
    const orphanVideos = videos.filter((entry) => !referencedKeys.has(entry.storageKey)).length;
    return {
        images: images.length,
        videos: videos.length,
        referenced: referencedKeys.size,
        orphanImages,
        orphanVideos,
    };
}

/** 收集一批节点里所有可能指向本地字节的 key（给体检用）。 */
export function collectNodeMediaKeys(nodes: CanvasNodeData[], keys = new Set<string>()) {
    for (const node of nodes) {
        const meta = node.metadata;
        if (!meta) continue;
        for (const key of [meta.storageKey, meta.thumbnailStorageKey]) {
            if (key) keys.add(key);
        }
        for (const image of meta.images || []) {
            if (image.storageKey) keys.add(image.storageKey);
            if (image.thumbnailStorageKey) keys.add(image.thumbnailStorageKey);
        }
        // 注意：`scriptCellAssets` 存的是**图片节点 id**（不是 storageKey），
        // 资产图能不能找回取决于那张图片节点自己 —— 所以这里不重复收集。
    }
    return keys;
}
