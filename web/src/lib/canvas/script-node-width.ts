import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

import { canvasRectsOverlap, type CanvasFreeRect } from "./canvas-free-space";

/**
 * 脚本节点加宽（配置态拥挤）。
 *
 * 用户 2026-11-11 报障：「脚本生成器的窗口在执行操作前可以左右向加长一倍，现在比较拥挤」。
 * 成因：执行（生成分镜表）之后节点会按表格自动适配宽度（`AUTO_SIZE_MIN_WIDTH` ~ 2200），
 * 但**执行前**的配置态固定按 `NODE_DEFAULT_SIZE.Script` 渲染 —— 760px 装不下
 * 「方案 / 输出格式 / 每镜时长 / 生图比例」这四排胶囊按钮，全被挤成两三行。
 *
 * 默认宽已经改成 1520（`constant/canvas.ts`），这里负责**存量节点**：还停在 760 的脚本节点
 * 一次性加宽到 1520。
 *
 * 为什么不直接 `width = 1520`：
 *  - 一键铺链路是**从脚本节点右侧 48px 开始**排视频节点的（`planRightwardChainSlots`），
 *    老画布上右侧往往紧贴着下游，单纯往右长 760 会正好盖住它们；
 *  - 所以优先「左右各扩 380」（用户原话就是「左右向加长」），左边也挤才退化成只往右长，
 *    两边都挤就**宁可不加宽**也不覆盖下游（用户随时能自己拖右下角）。
 *
 * 纯几何、无副作用，探针里可以单独跑。
 */

/** 改宽之前脚本节点的默认宽度。 */
export const SCRIPT_LEGACY_WIDTH = 760;
/** 配置态目标宽度：老默认宽的一倍。 */
export const SCRIPT_WIDE_WIDTH = SCRIPT_LEGACY_WIDTH * 2;
/** 脚本节点兜底高度（老数据偶尔缺 height）。 */
const SCRIPT_FALLBACK_HEIGHT = 520;

/**
 * 把「宽度还正好是老默认 760」的脚本节点加宽一倍，返回新数组（没有要改的就原样返回）。
 *
 * 只认 760 这个精确值：用户手动拉伸过的（800 / 1100 / …）一律不动 —— 那是他自己的选择。
 */
export function widenLegacyScriptNodes(nodes: readonly CanvasNodeData[]): CanvasNodeData[] {
    const legacyIds = new Set(
        nodes.filter((node) => node.type === CanvasNodeType.Script && Math.round(Number(node.width) || 0) === SCRIPT_LEGACY_WIDTH).map((node) => node.id),
    );
    if (!legacyIds.size) return nodes as CanvasNodeData[];

    // 组框不算占位（半透明容器，节点本来就该能排在里面）。
    // ⚠️ 待扩展的脚本节点**也算占位**（用它现在的矩形）：两个脚本节点挨着时，
    // 前者不能为了变宽把后者盖住 —— 顺序处理时把已扩的那一个换成新矩形再往后判断。
    const occupied: CanvasFreeRect[] = nodes
        .filter((node) => node.type !== CanvasNodeType.Group && node.width > 0 && node.height > 0)
        .map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));

    const halfDelta = Math.round((SCRIPT_WIDE_WIDTH - SCRIPT_LEGACY_WIDTH) / 2);
    const patches = new Map<string, { x: number; width: number }>();
    const rectOf = (node: CanvasNodeData): CanvasFreeRect => ({ x: node.position.x, y: node.position.y, width: Math.max(1, Number(node.width) || 1), height: Math.max(1, Number(node.height) || SCRIPT_FALLBACK_HEIGHT) });

    for (const node of nodes) {
        if (!legacyIds.has(node.id)) continue;
        const height = Number(node.height) || SCRIPT_FALLBACK_HEIGHT;
        const selfRect = rectOf(node);
        // 与自身那一格比较：同坐标同尺寸即为自身，从占位里剔掉。
        const ownIndex = occupied.findIndex((other) => other.x === selfRect.x && other.y === selfRect.y && other.width === selfRect.width && other.height === selfRect.height);
        const others = ownIndex >= 0 ? [...occupied.slice(0, ownIndex), ...occupied.slice(ownIndex + 1)] : occupied;
        const collision = (x: number) => others.some((other) => canvasRectsOverlap(other, { x, y: node.position.y, width: SCRIPT_WIDE_WIDTH, height }));

        // ① 左右各扩一半：不压任何邻居就用它（最常见 —— 脚本节点是链条起点，右边远处才是下游）。
        const centeredX = node.position.x - halfDelta;
        if (!collision(centeredX)) {
            patches.set(node.id, { x: centeredX, width: SCRIPT_WIDE_WIDTH });
            occupied.push({ x: centeredX, y: node.position.y, width: SCRIPT_WIDE_WIDTH, height });
            continue;
        }
        // ② 左边挤：只往右长，前提是右侧本来就空。
        if (!collision(node.position.x)) {
            patches.set(node.id, { x: node.position.x, width: SCRIPT_WIDE_WIDTH });
            occupied.push({ x: node.position.x, y: node.position.y, width: SCRIPT_WIDE_WIDTH, height });
        }
        // ③ 两边都挤（典型：一键视频已经把视频节点排在右侧 48px）→ 保持原宽。
        //    宁可窄，也不盖住下游；用户把下游挪开后再刷新即可。
    }

    if (!patches.size) return nodes as CanvasNodeData[];

    return nodes.map((node) => {
        const patch = patches.get(node.id);
        if (!patch) return node;
        return { ...node, position: { ...node.position, x: patch.x }, width: patch.width };
    });
}
