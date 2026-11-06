/**
 * 参考图 chip 的拖拽排序：纯逻辑（不碰 React / DOM），方便单测与探针。
 *
 * 背景：提示词输入框上方那排 chip 的顺序**不是**存在节点上的字段，而是「上游连线的数组顺序
 * → `getContextResourceNodes` 按连线顺序取资源 → `labelResourceNodes` 依次编号」推出来的。
 * 所以「拖动换位」本质是重排 `connections` 数组里那几条命中的连线。
 *
 * 两个已经踩过的坑：
 * 1. **条数必须严格相等**的校验会让一拖就静默失效 —— chip 里可能少一条（上游图还没出结果、
 *    被停用的素材），也可能多一条（同一资源既直连又走 Config 汇流）。命中几条就排几条。
 * 2. chip 的来源有两层拓扑：**直连本节点**，或**连到本节点所接的 Config 汇流点**。只认直连时，
 *    汇流场景下 `incoming.length` 恒为 0、永远 `return prev`，表现就是「拖了完全没反应」。
 */

type OrderedConnection = { id: string; fromNodeId: string; toNodeId: string };

/**
 * 按新顺序重排 `toNodeId === targetNodeId` 且 `fromNodeId` 在顺序表里的那几条连线。
 *
 * - 命中 < 2 条 → 返回 `null`（没有任何可排的，调用方应继续试下一个落点）。
 * - 已经在目标顺序 → 返回 `null`（避免制造新数组、触发无意义的画布重渲与撤销记录）。
 * - 认不得的连线（不在顺序表里）**原地不动**，只替换命中槽位的内容。
 */
export function reorderConnectionsForTarget<T extends OrderedConnection>(
    connections: T[],
    targetNodeId: string,
    orderedFromNodeIds: readonly string[],
): T[] | null {
    const order = new Map(orderedFromNodeIds.map((id, index) => [id, index]));
    if (order.size < 2) return null;

    const incoming = connections.filter((conn) => conn.toNodeId === targetNodeId && order.has(conn.fromNodeId));
    if (incoming.length < 2) return null;

    const sorted = [...incoming].sort((a, b) => order.get(a.fromNodeId)! - order.get(b.fromNodeId)!);
    if (sorted.every((conn, index) => conn === incoming[index])) return null;

    const hitIds = new Set(incoming.map((conn) => conn.id));
    let pointer = 0;
    return connections.map((conn) => (conn.toNodeId === targetNodeId && hitIds.has(conn.id) ? sorted[pointer++] : conn));
}

/**
 * 依次尝试多个落点（先是本节点直连，再是 Config 汇流点），第一个排得动的就生效。
 * 全都排不动 → 返回 `null`。
 */
export function reorderConnectionsForTargets<T extends OrderedConnection>(
    connections: T[],
    targetNodeIds: readonly string[],
    orderedFromNodeIds: readonly string[],
): T[] | null {
    for (const targetNodeId of targetNodeIds) {
        const next = reorderConnectionsForTarget(connections, targetNodeId, orderedFromNodeIds);
        if (next) return next;
    }
    return null;
}

/**
 * 「插入位」→「最终下标」。
 *
 * 拖拽时用插入位描述落点（0 = 插到第一张前面，n = 插到最后），比「落到第几张上」更好理解：
 * 拖到空隙里松手也算数。被拖的那张在插入位自身的位置上不产生位移，所以插到后面要回退一位。
 */
export function resolveReorderTargetIndex(fromIndex: number, insertIndex: number, length: number): number {
    if (!Number.isFinite(fromIndex) || !Number.isFinite(insertIndex)) return -1;
    const size = Math.max(0, length);
    if (fromIndex < 0 || fromIndex >= size) return -1;
    const slot = Math.min(size, Math.max(0, insertIndex));
    const target = fromIndex < slot ? slot - 1 : slot;
    if (target < 0 || target >= size || target === fromIndex) return -1;
    return target;
}

/** 把 `fromIndex` 挪到 `toIndex`，返回新数组（不改原数组）。越界时原样返回副本。 */
export function moveIndex<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
    const next = [...items];
    if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length || fromIndex === toIndex) return next;
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
}
