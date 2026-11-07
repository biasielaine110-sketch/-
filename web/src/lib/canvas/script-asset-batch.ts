import { collectScriptAssetPromptCandidates, SCRIPT_ASSET_GENERATABLE_ROLE_IDS, type ScriptAssetRole, type StoryScriptRow } from "@/constant/story-script";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 脚本节点「资产图一键批量生成」的纯逻辑：**选哪些** + **摆哪儿**。
 *
 * 两件事都刻意放在 lib 里（不写进组件），因为它们在浏览器里看起来都对、错了只有用户能发现：
 *  - 选哪些：按分类从分镜表汇总去重（角色按名字、场景 / 道具按名字 + 描述），
 *    已经生成过的那条要标出来并默认不勾 —— 否则「再点一次批量」会把已有的图再出一遍；
 *  - 摆哪儿：批量出来的图是一整块网格，必须避开脚本节点自己、已有的资产图、以及**已经铺好的分镜链路**，
 *    否则第二次生成就会和第一批叠在一起（用户原话：「需要排布整齐一些」）。
 *
 * 车道（lane）= 脚本节点右侧给资产图留的那一竖条。车道上的节点带 `metadata.scriptAssetLane = 脚本节点 id`，
 * 见 types/canvas.ts；「一键铺链路」会读车道右边界把三列起点让开（`scriptAssetLaneRight`）。
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

// ── 排布：脚本节点右侧的「资产车道」─────────────────────────────────────────────────────

/** 资产车道与脚本节点右边缘的水平间距。 */
export const SCRIPT_ASSET_LANE_GAP_X = 64;
/** 车道被别的节点占住时，整条车道往右让开后再留的间距。 */
export const SCRIPT_ASSET_LANE_SHIFT_GAP = 48;
/** 车道里一排摆几张。固定值 = 「整齐」的来源：同比例的图排成规整矩阵，不上下来回错位。 */
export const SCRIPT_ASSET_GRID_COLUMNS = 3;
/** 车道里的行距 / 列距。 */
export const SCRIPT_ASSET_GRID_GAP = 24;
/** 一批最多同时提交几张生图（十几张一起打上游容易被限流）。 */
export const SCRIPT_ASSET_LAUNCH_BATCH = 3;

export type ScriptAssetRect = { x: number; y: number; width: number; height: number };

export type ScriptAssetLaneSource = { id: string; position: { x: number; y: number }; width: number; height: number };

/** 两张矩形是否真的重叠（留 1px 容差，避免「刚好贴边」被判成打架）。 */
function rectsOverlap(a: ScriptAssetRect, b: ScriptAssetRect) {
    return a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
}

/** 车道整块的宽度（按排数与单元尺寸算）。 */
export function scriptAssetLaneWidth(cellWidth: number, columns = SCRIPT_ASSET_GRID_COLUMNS) {
    const count = Math.max(1, columns);
    const width = Math.max(1, cellWidth);
    return width * count + SCRIPT_ASSET_GRID_GAP * (count - 1);
}

/**
 * 车道起点 x。
 *
 * 默认紧贴脚本节点右侧（`右边缘 + 64`），但**这一竖条已经被别的节点占了就整条往右让**：
 * 用户先「一键铺链路」再生成资产是最常见的顺序，不让开的话资产图会正好盖在「文本」那一列上。
 * 本节点自己的资产图（`scriptAssetLane === 本节点 id`）不算占位 —— 否则第二次生成会把车道推得越来越远。
 */
export function resolveScriptAssetLaneX(source: ScriptAssetLaneSource, nodes: readonly CanvasNodeData[], laneWidth: number) {
    const width = Math.max(1, laneWidth);
    let x = source.position.x + source.width + SCRIPT_ASSET_LANE_GAP_X;
    for (let guard = 0; guard < 32; guard += 1) {
        const bandRight = x + width;
        const blockers = nodes.filter(
            (node) => node.id !== source.id && node.metadata?.scriptAssetLane !== source.id && node.position.x < bandRight - 1 && node.position.x + node.width > x + 1,
        );
        if (!blockers.length) return x;
        x = Math.max(...blockers.map((node) => node.position.x + node.width)) + SCRIPT_ASSET_LANE_SHIFT_GAP;
    }
    return x;
}

/**
 * 车道里已经有了什么（给「一键铺链路」让位用）。
 * 没有资产图时返回 `null`（调用方据此保持原来的三列起点，行为与改造前逐像素一致）。
 */
export function scriptAssetLaneRight(nodes: readonly CanvasNodeData[], scriptNodeId: string) {
    const lane = nodes.filter((node) => node.metadata?.scriptAssetLane === scriptNodeId);
    if (!lane.length) return null;
    return Math.max(...lane.map((node) => node.position.x + node.width));
}

/**
 * 把一批资产图排成整齐的网格。
 *
 * - 单元尺寸取这批里最大的宽 / 高，每张图在格子里居中 → 同比例的图完全对齐；万一混了比例也不会参差。
 * - **已经被占住的格子直接跳过**（`occupied` 传除脚本节点以外的所有节点）：
 *   所以「先铺链路再生成资产」会自动落到链路右侧空地上，「删掉中间一张再补一张」也会补回空位。
 * - 按行优先顺序取位，读起来就是「从左到右、从上到下」。
 */
export function planScriptAssetSlots(
    origin: { x: number; y: number },
    sizes: ReadonlyArray<{ width: number; height: number }>,
    occupied: readonly ScriptAssetRect[],
    options?: { columns?: number; gap?: number },
): Array<{ x: number; y: number }> {
    if (!sizes.length) return [];
    const columns = Math.max(1, Math.floor(options?.columns ?? SCRIPT_ASSET_GRID_COLUMNS));
    const gap = Math.max(0, options?.gap ?? SCRIPT_ASSET_GRID_GAP);
    const cellWidth = Math.max(1, ...sizes.map((size) => size.width));
    const cellHeight = Math.max(1, ...sizes.map((size) => size.height));
    const placed: Array<{ x: number; y: number }> = [];
    const limit = sizes.length + occupied.length + columns * 2 + 8;
    for (let slot = 0; slot < limit && placed.length < sizes.length; slot += 1) {
        const column = slot % columns;
        const row = Math.floor(slot / columns);
        const size = sizes[placed.length];
        const rect: ScriptAssetRect = {
            x: origin.x + column * (cellWidth + gap) + (cellWidth - size.width) / 2,
            y: origin.y + row * (cellHeight + gap) + (cellHeight - size.height) / 2,
            width: size.width,
            height: size.height,
        };
        if (occupied.some((other) => rectsOverlap(other, rect))) continue;
        placed.push({ x: rect.x, y: rect.y });
    }
    return placed;
}

/** 除脚本节点本身之外，所有节点在画布上的占位（车道排布的 `occupied`）。 */
export function collectScriptAssetOccupied(nodes: readonly CanvasNodeData[], sourceId: string): ScriptAssetRect[] {
    return nodes.filter((node) => node.id !== sourceId && node.width > 0 && node.height > 0).map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));
}
