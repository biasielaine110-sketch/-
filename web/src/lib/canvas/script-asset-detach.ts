import { parseScriptCellAssetKey, stripStoryScriptAssetId, type StoryScriptExtraColumn } from "@/constant/story-script";
import type { CanvasNodeMetadata } from "@/types/canvas";

/**
 * **素材引用的统一摘除口**（2026-11-15 用户报障后收口）。
 *
 * 用户原话：「链接的图需要在断开后，表格图片中的图也自行断开嵌入……现在断开链接图片后，表格中的图
 * 还是没有断开的，还是保有历史状态很难处理；而且点图片的叉子，现在只能删除一个镜头的关联，
 * 其他的镜头相关资产也不跟着改，很费劲。」
 *
 * 为什么会有「历史状态」：脚本节点记了**四份**引用，任何一条路径漏清一份，表里就还挂着那张图：
 *  ① `scriptCellAssets`（`镜号:资产列` → 图）—— 批量生成 / 逐格挂图时按**每一镜**写了一遍，
 *     所以「只解一个镜头」根本看不出效果：别的镜头各自存着同一条引用；
 *  ② `scriptNameLocks`（资产名 → 图）—— 格子里显示的图大部分是**它**落下来的（并集显示）；
 *  ③ `scriptRowAssets`（镜号 → 图）—— 逐镜资产池；
 *  ④ `scriptRowAudios`（镜号 → 音频）+ `scriptAssetRoles`（图 → 分类）。
 *
 * 于是「断开」必须一次把这四份里那张图全摘掉，否则用户点了 × 只能看着图还在（用户报的就是这个）。
 *
 * ⚠️ 唯一入口：别在调用点各写一遍 `stripStoryScriptAssetId` —— 以前 `handleScriptAssetRemove`
 * 写了四处、格子 × 一处都没写、删连线一处也没写，就是这么漏出来的。
 */

/** 把入参收成去重后的非空 id 数组（单值 / 数组都收）。 */
function normalizeAssetIds(value: unknown): string[] {
    const list = Array.isArray(value) ? value : [value];
    const out: string[] = [];
    for (const item of list) {
        const id = typeof item === "string" ? item.trim() : "";
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/**
 * 把若干张素材从脚本节点的引用里摘干净，返回**可以直接并进 metadata 的补丁**。
 *
 * @param assetNodeIds 要摘掉的图 / 音频节点 id（单值或数组）。
 * @param options.columnKey 只清某一个资产列的按格引用（格子里的 × 用）；不传 = 所有列都清
 *        （断开连线 / 删素材节点 / 解开名字锁，那三种情况「这张图不属于这张表了」，没有列的概念）。
 *
 * 返回空对象 = 什么都没改（调用方据此跳过 setNodes，别白热一次画布重渲）。
 */
export function stripScriptAssetReferences(
    metadata: CanvasNodeMetadata | undefined,
    assetNodeIds: unknown,
    options: { columnKey?: string | null; extras?: readonly StoryScriptExtraColumn[] | null } = {},
): Partial<CanvasNodeMetadata> {
    const ids = normalizeAssetIds(assetNodeIds);
    if (!ids.length) return {};
    const patch: Partial<CanvasNodeMetadata> = {};
    const columnKey = String(options.columnKey || "");
    const extras = options.extras;

    // ① 按格：只动目标列（`镜号:列key`），其余列原样保留；清空的键直接丢掉（`stripStoryScriptAssetId` 负责）。
    if (metadata?.scriptCellAssets) {
        if (columnKey) {
            const next: Record<string, string[]> = {};
            let changed = false;
            for (const [key, value] of Object.entries(metadata.scriptCellAssets)) {
                const parsed = parseScriptCellAssetKey(key, extras);
                if (!parsed || parsed.columnKey !== columnKey || !Array.isArray(value)) {
                    if (Array.isArray(value)) next[key] = value as string[];
                    continue;
                }
                const kept = (value as string[]).filter((id) => !ids.includes(id));
                if (kept.length !== value.length) changed = true;
                if (kept.length) next[key] = kept;
            }
            if (changed) patch.scriptCellAssets = next;
        } else {
            let cells = metadata.scriptCellAssets as NonNullable<CanvasNodeMetadata["scriptCellAssets"]>;
            let changed = false;
            for (const id of ids) {
                const next = stripStoryScriptAssetId(cells, id);
                if (next !== cells) changed = true;
                cells = next ?? cells;
            }
            if (changed) patch.scriptCellAssets = cells;
        }
    }

    // ② 按名：图没了，任何名字都不该再指向它（一格多名时每个名字都摘）。
    if (metadata?.scriptNameLocks) {
        let locks: NonNullable<CanvasNodeMetadata["scriptNameLocks"]> = metadata.scriptNameLocks;
        let changed = false;
        for (const id of ids) {
            const next = stripStoryScriptAssetId(locks, id);
            if (next && next !== locks) {
                changed = true;
                locks = next;
            }
        }
        if (changed) patch.scriptNameLocks = locks;
    }

    // ③ / ④ 逐镜资产与逐镜声音：同一个资产在别的镜头也不该再带着这张图。
    if (metadata?.scriptRowAssets) {
        let rows: NonNullable<CanvasNodeMetadata["scriptRowAssets"]> = metadata.scriptRowAssets;
        let changed = false;
        for (const id of ids) {
            const next = stripStoryScriptAssetId(rows, id);
            if (next && next !== rows) {
                changed = true;
                rows = next;
            }
        }
        if (changed) patch.scriptRowAssets = rows;
    }
    if (metadata?.scriptRowAudios) {
        let audios: NonNullable<CanvasNodeMetadata["scriptRowAudios"]> = metadata.scriptRowAudios;
        let changed = false;
        for (const id of ids) {
            const next = stripStoryScriptAssetId(audios, id);
            if (next && next !== audios) {
                changed = true;
                audios = next;
            }
        }
        if (changed) patch.scriptRowAudios = audios;
    }

    // 分类：图都不在这张表里了，留着分类只会让「上游素材」列表多一条幽灵记录。
    const roles = metadata?.scriptAssetRoles;
    if (roles && ids.some((id) => id in roles)) {
        const next: NonNullable<CanvasNodeMetadata["scriptAssetRoles"]> = { ...roles };
        for (const id of ids) delete next[id];
        patch.scriptAssetRoles = next;
    }

    return patch;
}
