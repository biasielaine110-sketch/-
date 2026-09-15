import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[]) {
    if (nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group)) return null;
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    return (
        [...nodes].reverse().find((group) => {
            if (group.type !== CanvasNodeType.Group || movedIds.has(group.id)) return false;
            return movingNodes.some((node) => {
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
            });
        }) || null
    );
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return (
        [...nodes]
            .reverse()
            .find((group) => group.type === CanvasNodeType.Group && group.id !== node.id && centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height)?.id ||
        undefined
    );
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

/** Non-group nodes that belong to a group frame. */
export function getGroupMemberNodes(groupId: string, nodes: CanvasNodeData[]) {
    return nodes.filter((node) => node.type !== CanvasNodeType.Group && node.metadata?.groupId === groupId);
}

function connectionEndpointIds(nodeId: string, nodes: CanvasNodeData[]) {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return [];
    if (node.type !== CanvasNodeType.Group) return [node.id];
    return getGroupMemberNodes(node.id, nodes).map((member) => member.id);
}

/**
 * Resolve one or many from→to pairs. Group endpoints expand to every member node
 * so linking a group links all of its children.
 */
export function resolveConnectionPairs(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    if (firstNodeId === secondNodeId) return [] as Array<{ fromNodeId: string; toNodeId: string }>;
    const firstIds = connectionEndpointIds(firstNodeId, nodes);
    const secondIds = connectionEndpointIds(secondNodeId, nodes);
    if (!firstIds.length || !secondIds.length) return [];

    const pairs: Array<{ fromNodeId: string; toNodeId: string }> = [];
    const seen = new Set<string>();
    for (const firstId of firstIds) {
        for (const secondId of secondIds) {
            if (firstId === secondId) continue;
            const connection = normalizeConnection(firstId, secondId, nodes, firstHandleType);
            if (!connection) continue;
            const key = `${connection.fromNodeId}->${connection.toNodeId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push(connection);
        }
    }
    return pairs;
}

export function canConnectNodes(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    return resolveConnectionPairs(firstNodeId, secondNodeId, nodes, firstHandleType).length > 0;
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Group || second.type === CanvasNodeType.Group) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (first.type === CanvasNodeType.Merge && second.type === CanvasNodeType.Merge) return null;
    // Input handle / keyboard X on the receiver: clicked node outputs into the first node.
    if (firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    // Output handle: first node outputs into the clicked node.
    return { fromNodeId: first.id, toNodeId: second.id };
}
