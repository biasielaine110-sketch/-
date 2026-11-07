import { collectScriptAssetPromptCandidates, SCRIPT_ASSET_GENERATABLE_ROLE_IDS, type ScriptAssetRole, type StoryScriptRow } from "@/constant/story-script";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 脚本节点「资产图一键批量生成」的纯逻辑：**选哪些** + **摆哪儿**。
 *
 * 两件事都刻意放在 lib 里（不写进组件），因为它们在浏览器里看起来都对、错了只有用户能发现：
 *  - 选哪些：按分类从分镜表汇总去重（角色按名字、场景 / 道具按名字 + 描述），
 *    已经生成过的那条要标出来并默认不勾 —— 否则「再点一次批量」会把已有的图再出一遍；
 *  - 摆哪儿：批量出来的图排在脚本节点**左侧的一列**（距脚本左边缘 300px，上下顺序，列高随脚本窗口
 *    高度自适应），并且要避开已有的资产图 / 已经铺好的分镜链路，否则第二次生成会和第一批叠在一起。
 *
 * 竖列上的节点依然带 `metadata.scriptAssetLane = 脚本节点 id`（字段名沿用旧版，见 types/canvas.ts）：
 * 它既是「这批是本节点生成的」标记，也是「铺链路让位」与「续排」的判据。
 */

export type ScriptAssetBatchItem = {
    /** 勾选状态的稳定键：`分类:标题`。 */
    key: string;
    role: ScriptAssetRole;
    /** 资产名（角色名 / 场景名 / 道具名…），同时作为建出来的图片节点标题。 */
    title: string;
    /** 喂给生图的提示词。 */
    prompt: string;
    /** 已经有同分类同名的素材节点 → 默认不勾（避免重复出图）。 */
    existingNodeIds: string[];
};

/** 已连到脚本节点的素材（用来判断「这个资产已经有图了」）。 */
export type ScriptAssetExistingAsset = { nodeId: string; title: string; role: ScriptAssetRole };

export function scriptAssetBatchKey(role: ScriptAssetRole, title: string) {
    return `${role}:${String(title || "").trim()}`;
}

/**
 * 从分镜表汇总「所有可以一键生成的资产」。
 *
 * - 分类顺序固定为 `SCRIPT_ASSET_GENERATABLE_ROLE_IDS`（角色 → 场景 → 道具 → 人物站位），
 *   同类内保留分镜表里首次出现的顺序：生成的网格顺序与表里读到的顺序一致，看图时好对。
 * - 去重口径 = `collectScriptAssetPromptCandidates`（角色按名字、场景道具按名字 + 描述），
 *   这里只再按「分类 + 标题」兜一层，避免两个分类恰好同名时被当成同一条。
 * - `existing` 用「分类 + 标题」精确匹配（标题就是资产名，生成时我们还会把标题改回来），
 *   对不上就当作没生成过 —— 宁可多勾一条让用户手动取消，也不要静默漏掉一张该出的图。
 */
export function buildScriptAssetBatchItems(rows: readonly StoryScriptRow[] | null | undefined, existing: readonly ScriptAssetExistingAsset[] = []): ScriptAssetBatchItem[] {
    const existingMap = new Map<string, string[]>();
    for (const asset of existing) {
        const key = scriptAssetBatchKey(asset.role, asset.title);
        const list = existingMap.get(key) || [];
        if (asset.nodeId && !list.includes(asset.nodeId)) list.push(asset.nodeId);
        existingMap.set(key, list);
    }
    const seen = new Set<string>();
    const items: ScriptAssetBatchItem[] = [];
    for (const role of SCRIPT_ASSET_GENERATABLE_ROLE_IDS) {
        for (const candidate of collectScriptAssetPromptCandidates(role, rows)) {
            const key = scriptAssetBatchKey(role, candidate.title);
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ key, role, title: candidate.title, prompt: candidate.prompt, existingNodeIds: existingMap.get(key) || [] });
        }
    }
    return items;
}

/** 按分类分组（弹窗按组渲染）。空分类不返回。 */
export function groupScriptAssetBatchItems(items: readonly ScriptAssetBatchItem[]): Array<{ role: ScriptAssetRole; items: ScriptAssetBatchItem[] }> {
    const groups: Array<{ role: ScriptAssetRole; items: ScriptAssetBatchItem[] }> = [];
    for (const role of SCRIPT_ASSET_GENERATABLE_ROLE_IDS) {
        const list = items.filter((item) => item.role === role);
        if (list.length) groups.push({ role, items: list });
    }
    return groups;
}

/**
 * 默认勾选：**没有出过图的**那几条。用户点开弹窗先看到「还缺哪些」，再按类型筛或逐条取消。
 * （全部默认勾选会让「第二次点批量」把已有资产重复生成一遍，白白花钱。）
 */
export function defaultScriptAssetBatchSelection(items: readonly ScriptAssetBatchItem[]) {
    return items.filter((item) => !item.existingNodeIds.length).map((item) => item.key);
}

// ── 排布：脚本节点**左侧**的「资产竖列」─────────────────────────────────────────────

/**
 * 竖列与脚本节点**左边缘**的水平间距。用户口径就一句：「紧挨着脚本窗口的最左侧，
 * 距离脚本窗口大概间隔 300px」。所以是「图右边缘 → 脚本左边缘 = 300px」，不是 300 起算。
 */
export const SCRIPT_ASSET_COLUMN_GAP_X = 300;
/** 竖列里两张图之间的最小间距。 */
export const SCRIPT_ASSET_COLUMN_MIN_GAP = 24;
/** 自适应脚本节点高度时允许的最大间距 —— 再大就散成两截，看着像没排。 */
export const SCRIPT_ASSET_COLUMN_MAX_GAP = 240;
/** 竖列被别的节点占住时，整条往左让开后再留的间距。 */
export const SCRIPT_ASSET_COLUMN_SHIFT_GAP = 48;
/** 一批最多同时提交几张生图（十几张一起打上游容易被限流）。 */
export const SCRIPT_ASSET_LAUNCH_BATCH = 3;

export type ScriptAssetRect = { x: number; y: number; width: number; height: number };

export type ScriptAssetLaneSource = { id: string; position: { x: number; y: number }; width: number; height: number };

/** 两张矩形是否真的重叠（留 1px 容差，避免「刚好贴边」被判成打架）。 */
function rectsOverlap(a: ScriptAssetRect, b: ScriptAssetRect) {
    return a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
}

/**
 * 竖列起点（= 这一列**左边缘**的 x）。
 *
 * 默认在脚本节点左侧 300px 处；**这一竖条已经被别的节点占了就整条往左让**（同 X 区间就算占，
 * 与右侧那版同口径 —— 竖列是整条贯穿的，不按 Y 逐段挑空隙）。
 * 本节点自己的资产图（`scriptAssetLane === 本节点 id`）不算占位 —— 否则第二次生成会把列推得越来越远。
 */
export function resolveScriptAssetColumnX(source: ScriptAssetLaneSource, nodes: readonly CanvasNodeData[], cellWidth: number) {
    const width = Math.max(1, cellWidth);
    let right = source.position.x - SCRIPT_ASSET_COLUMN_GAP_X;
    for (let guard = 0; guard < 32; guard += 1) {
        const left = right - width;
        const blockers = nodes.filter(
            (node) => node.id !== source.id && node.metadata?.scriptAssetLane !== source.id && node.position.x < right - 1 && node.position.x + node.width > left + 1,
        );
        if (!blockers.length) return left;
        right = Math.min(...blockers.map((node) => node.position.x)) - SCRIPT_ASSET_COLUMN_SHIFT_GAP;
    }
    return right - width;
}

/**
 * 把一批资产图排成**一列**（从上到下），列高按脚本节点高度适配。
 *
 * - 间距自适应：`(脚本高 - 整列图高) / 间隔数` 夹进 `[MIN_GAP, MAX_GAP]`。脚本窗口拉高 → 图跟着摊开；
 *   图太多、整列比脚本窗口还高 → 退回 `MIN_GAP` 往下溢出（**不缩图**：用户要看清楚资产）。
 * - 已被占住的格子往下挪（只有一列，没有「换行」这一步），挪完继续按原节奏往下走。
 */
export function planScriptAssetColumn(
    origin: { x: number; y: number },
    sizes: ReadonlyArray<{ width: number; height: number }>,
    occupied: readonly ScriptAssetRect[],
    options?: { gap?: number; span?: number },
): Array<{ x: number; y: number }> {
    if (!sizes.length) return [];
    const minGap = Math.max(0, options?.gap ?? SCRIPT_ASSET_COLUMN_MIN_GAP);
    const cellWidth = Math.max(1, ...sizes.map((size) => size.width));
    const cellHeight = Math.max(1, ...sizes.map((size) => size.height));
    const span = Number(options?.span) || 0;
    let gap = minGap;
    if (span > 0 && sizes.length > 1) {
        const slack = (span - cellHeight * sizes.length) / (sizes.length - 1);
        gap = Math.min(SCRIPT_ASSET_COLUMN_MAX_GAP, Math.max(minGap, Math.round(slack)));
    }
    const placed: Array<{ x: number; y: number }> = [];
    let cursorY = origin.y;
    for (const size of sizes) {
        const x = origin.x + (cellWidth - size.width) / 2;
        let rect: ScriptAssetRect = { x, y: cursorY + (cellHeight - size.height) / 2, width: size.width, height: size.height };
        for (let guard = 0; guard <= occupied.length + 8; guard += 1) {
            const hit = occupied.find((other) => rectsOverlap(other, rect));
            if (!hit) break;
            cursorY = hit.y + hit.height + minGap;
            rect = { x, y: cursorY + (cellHeight - size.height) / 2, width: size.width, height: size.height };
        }
        placed.push({ x: rect.x, y: rect.y });
        cursorY += cellHeight + gap;
    }
    return placed;
}

/** 除脚本节点本身之外，所有节点在画布上的占位（竖列排布的 `occupied`）。 */
export function collectScriptAssetOccupied(nodes: readonly CanvasNodeData[], sourceId: string): ScriptAssetRect[] {
    return nodes.filter((node) => node.id !== sourceId && node.width > 0 && node.height > 0).map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));
}

/**
 * 老版「右侧车道」的右边界 —— **只为已铺好的老画布保留**。
 *
 * 2026-11-07 起资产图改摆**左侧竖列**，新生成的节点不会出现在右边；但存量画布上还躺着
 * 按老规则排在右边的资产图，一键铺链路仍要让开它们，否则分镜链会正好盖在图上。
 * 没有右侧资产图时返回 `null`，调用方据此保持原来的三列起点（与改造前逐像素一致）。
 */
export function scriptAssetLaneRight(nodes: readonly CanvasNodeData[], scriptNodeId: string) {
    const lane = nodes.filter((node) => node.metadata?.scriptAssetLane === scriptNodeId);
    if (!lane.length) return null;
    return Math.max(...lane.map((node) => node.position.x + node.width));
}
