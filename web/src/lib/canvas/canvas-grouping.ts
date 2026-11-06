import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

/**
 * 组框留白：四周各留一点，**顶部要多留一截** —— 分组节点自己有一条标题栏
 * （图标 + 「分组」+ 成员数），标题栏下面才是虚线内容区；顶部留白不够会把成员盖住。
 */
export const GROUP_FRAME_PADDING = { top: 64, right: 28, bottom: 28, left: 28 } as const;

/** 组框最小尺寸：只框一两个小节点时不至于缩成一条。 */
export const GROUP_MIN_SIZE = { width: 320, height: 220 } as const;

/**
 * 能被框进组的节点：**分组自己不参与**（不做嵌套 —— `getGroupMemberNodes` 只认一层 `groupId`，
 * 嵌套了取内容时会漏）。其余类型都行：图片 / 文本 / 视频 / 音频……
 */
export function isGroupableNode(node: CanvasNodeData) {
    return node.type !== CanvasNodeType.Group;
}

/** 从选区里挑出真正能成组的节点（保持画布数组顺序，成员顺序稳定、可预期）。 */
export function collectGroupMembers(nodes: CanvasNodeData[], ids: Iterable<string>) {
    const wanted = new Set(ids);
    return nodes.filter((node) => wanted.has(node.id) && isGroupableNode(node));
}

/**
 * 按成员的包围盒 + 留白算出组框的左上角与尺寸。
 *
 * 返回的 `position` 是**左上角**（跟 `node.position` 同口径）；`createCanvasNode` 收的是中心点，
 * 别直接把这里的结果喂过去，否则整个框会偏半个身位。
 */
export function resolveGroupFrame(members: CanvasNodeData[]): { position: Position; width: number; height: number } | null {
    if (!members.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const node of members) {
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    }
    return {
        position: { x: Math.round(left) - GROUP_FRAME_PADDING.left, y: Math.round(top) - GROUP_FRAME_PADDING.top },
        width: Math.max(GROUP_MIN_SIZE.width, Math.round(right - left) + GROUP_FRAME_PADDING.left + GROUP_FRAME_PADDING.right),
        height: Math.max(GROUP_MIN_SIZE.height, Math.round(bottom - top) + GROUP_FRAME_PADDING.top + GROUP_FRAME_PADDING.bottom),
    };
}

/**
 * 把成员挂到 `groupId` 上。
 *
 * `metadata.groupId` 是成员关系的**唯一**来源：`getGroupMemberNodes` 靠它数成员，
 * `resolveConnectionPairs` 靠它把「对组的连线」展开成「对每个成员的连线」。
 * 已经属于别的组的节点会被搬过来（不复制）—— 搬空的老组自然变成空组，连线时会被拦下并提示。
 */
export function attachNodesToGroup(nodes: CanvasNodeData[], memberIds: Iterable<string>, groupId: string) {
    const wanted = new Set(memberIds);
    return nodes.map((node) => {
        if (!wanted.has(node.id) || !isGroupableNode(node)) return node;
        if (node.metadata?.groupId === groupId) return node;
        return { ...node, metadata: { ...node.metadata, groupId } };
    });
}
