/** Persist and apply drag-reorderable menu item order in localStorage. */

export function reorderIds<T extends string>(ids: T[], fromId: T, toId: T): T[] {
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return ids;
    const next = [...ids];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function mergeOrderedIds(preferred: string[], defaults: string[]) {
    const allowed = new Set(defaults);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of preferred) {
        if (!allowed.has(id) || seen.has(id)) continue;
        seen.add(id);
        ordered.push(id);
    }
    for (const id of defaults) {
        if (seen.has(id)) continue;
        seen.add(id);
        ordered.push(id);
    }
    return ordered;
}

export function readOrderedIds(storageKey: string, defaults: string[]) {
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return defaults;
        return mergeOrderedIds(
            parsed.filter((id): id is string => typeof id === "string"),
            defaults,
        );
    } catch {
        return defaults;
    }
}

export function writeOrderedIds(storageKey: string, ids: string[]) {
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
        // ignore quota / private-mode failures
    }
}

export function sortByOrder<T extends { id: string }>(items: T[], order: string[]) {
    const index = new Map(order.map((id, i) => [id, i]));
    return [...items].sort((a, b) => (index.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export const NODE_CREATE_MENU_ORDER_KEY = "canvas-node-create-menu-order-v1";
export const IMAGE_CONTEXT_MENU_ORDER_KEY = "canvas-image-context-menu-order-v1";
