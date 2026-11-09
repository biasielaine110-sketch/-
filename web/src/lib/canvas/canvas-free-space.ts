import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

/**
 * 「往右找空地」：把自动创建出来的一串节点排在**已有节点右侧**，而不是叠在同一个点上。
 *
 * 用户 2026-11-09 报障：「执行这套工作流时，创建出来的窗口节点的排布有点太乱了……
 * 能不能都往右创建出来，不要在原点创建出来，全创建在原点就都叠加到一起了」。
 *
 * 根因不是「坐标写成了 0,0」，而是**锚点永远是同一个节点**：
 *  - 反推链（对话 → 文本 → 脚本）以前直接按 `视频节点.right + 间距` 排 —— 同一个视频节点跑两次，
 *    两条链的坐标完全一样，第二次就精确盖在第一次上面；
 *  - 一键铺链路以前按 `脚本节点.right + 间距` 排 —— 脚本节点若是复用的（或画布右侧本来就躺着
 *    上一轮铺出来的视频 / 合并节点），新的一列视频同样会压在旧内容上。
 * 所以这里做两件事，都是纯几何、可单测：
 *  ① `findFreeColumnX`：从期望位置开始**往右**找第一个不压任何已占位节点的 x；
 *  ② `planRightwardChainSlots`：一串节点依次往右排，遇到占位就整条链一起往右让（不左右穿插）。
 *
 * ⚠️ 组框（`Group`）**不算占位**：它是半透明容器，链路本来就该能排在它里面 / 旁边；
 * 把它当实体只会让新链被推到天边。
 */

/** 自动排布用的一张矩形（画布世界坐标，左上角 + 宽高）。 */
export type CanvasFreeRect = { x: number; y: number; width: number; height: number };

/** 自动排布的默认间距：与一键铺链路的 `gapX` / 资产阵的 `SCRIPT_ASSET_COLUMN_GAP_X` 同一个量级。 */
export const CANVAS_FREE_SPACE_GAP = 48;

/** 两张矩形是否真的重叠（留 1px 容差：贴边不算压）。 */
export function canvasRectsOverlap(a: CanvasFreeRect, b: CanvasFreeRect, tolerance = 1): boolean {
    return a.x < b.x + b.width - tolerance && b.x < a.x + a.width - tolerance && a.y < b.y + b.height - tolerance && b.y < a.y + a.height - tolerance;
}

/**
 * 现有节点 → 占位矩形。
 *
 * @param excludeIds 这次要新建的那几个节点（还没进 nodes 就不用传）以及调用方想忽略的节点（如源脚本节点）。
 */
export function collectCanvasOccupied(nodes: readonly CanvasNodeData[], excludeIds?: Iterable<string>): CanvasFreeRect[] {
    const skip = new Set(excludeIds || []);
    return nodes
        .filter((node) => node.type !== CanvasNodeType.Group && !skip.has(node.id) && node.width > 0 && node.height > 0)
        .map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));
}

/**
 * 从 `desiredX` 开始**往右**找第一个「这一列（给定竖向范围）不压任何占位」的 x。
 *
 * 一次只让到「已经压到的那几个节点的右边 + gap」，所以：
 *  - 没有占位时**逐像素等于 `desiredX`**（老画布上的结果不变）；
 *  - 有占位时最小的位移就够，不会平白把节点甩到几百像素以外。
 */
export function findFreeColumnX(input: {
    desiredX: number;
    width: number;
    top: number;
    height: number;
    occupied?: readonly CanvasFreeRect[];
    gap?: number;
}): number {
    const gap = Math.max(0, input.gap ?? CANVAS_FREE_SPACE_GAP);
    const occupied = input.occupied || [];
    const width = Math.max(1, Number(input.width) || 1);
    const height = Math.max(1, Number(input.height) || 1);
    let x = Number(input.desiredX) || 0;
    // 64 次上限只是防脏数据死循环（正常最多让几次就出去了）。
    for (let guard = 0; guard < 64; guard += 1) {
        const rect: CanvasFreeRect = { x, y: input.top, width, height };
        const hits = occupied.filter((other) => canvasRectsOverlap(other, rect));
        if (!hits.length) return x;
        x = Math.max(...hits.map((other) => other.x + other.width)) + gap;
    }
    return x;
}

/**
 * 一串节点从 `source` **右侧**开始依次往右排（竖向都以源节点中线为准）。
 *
 * @returns 每个节点的**中心点** —— 与 `createCanvasNode(type, position)` 的 position 口径一致
 *          （那个函数会自己减掉半宽半高）。
 */
export function planRightwardChainSlots(input: {
    source: { position: Position; width: number; height: number };
    sizes: ReadonlyArray<{ width: number; height: number }>;
    occupied?: readonly CanvasFreeRect[];
    gap?: number;
}): Position[] {
    const gap = Math.max(0, input.gap ?? CANVAS_FREE_SPACE_GAP);
    const sourceWidth = Math.max(0, Number(input.source.width) || 0);
    const sourceHeight = Math.max(0, Number(input.source.height) || 0);
    const centerY = input.source.position.y + sourceHeight / 2;
    const slots: Position[] = [];
    let cursorX = input.source.position.x + sourceWidth + gap;
    for (const size of input.sizes) {
        const width = Math.max(1, Number(size.width) || 1);
        const height = Math.max(1, Number(size.height) || 1);
        const x = findFreeColumnX({ desiredX: cursorX, width, top: centerY - height / 2, height, occupied: input.occupied, gap });
        slots.push({ x: x + width / 2, y: centerY });
        cursorX = x + width + gap;
    }
    return slots;
}
