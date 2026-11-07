import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";

/**
 * 列表「小抓手」拖动排序 —— **指针事件手写，不用 HTML5 drag**。
 *
 * 2026-11-07 报障：「小抓手拖动，现在只有图片窗口节点和视频窗口节点管用，AI 对话窗口、配置窗口、
 * 偏好设定、技能、渠道模型等都不起作用」。排查结论：能用的那几处（参考图 chip）本来就是 pointer
 * 手写的，剩下全部走 HTML5 drag，而原生 drag 在这套容器里**拖起即被取消**（拖影一闪、光标回弹、
 * 之后不再响应）：
 *
 *   1. `dragstart` 里 `setState`（拖起高亮）触发一轮重渲染，原生拖拽状态很容易被打断；
 *   2. 上层容器（画布节点 / 缩放容器）在 `pointerdown` 上 `preventDefault` 防选中、防拖节点，
 *      而 pointerdown 被拦后浏览器不再补发兼容 mousedown，原生 `dragstart` 干脆不触发；
 *   3. 弹窗、浮层、`transform: scale()` 容器里表现还不一致，`dragover` 只要有一帧没
 *      `preventDefault` 同样会被取消。
 *
 * 所以改成 pointer 自己接管（和 `canvas-node-prompt-panel.tsx` 参考图 chip 同一套已验证的做法）：
 *  - `pointerdown` 立刻 `preventDefault + stopPropagation`（不让画布把这次按下当拖动节点 / 平移）；
 *  - `pointermove / pointerup / pointercancel` 挂 **window 捕获阶段** —— 指针飘到哪都不丢事件；
 *  - 4px 阈值：手抖不算拖拽；
 *  - 拖拽中间态放 ref，只有「拖着谁 / 悬在谁上」进 state，避免每帧重渲染整张列表。
 *
 * 调用方约定（两步，别漏第二步）：
 * ```tsx
 * const drag = useOrderDrag((fromId, toId) => reorder(fromId, toId));
 * <div>
 *   {items.map((item) => (
 *     <div key={item.id} {...drag.rowProps(item.id)}>
 *       <span {...drag.handleProps(item.id)}><GripVertical /></span>
 *       ...
 *     </div>
 *   ))}
 * </div>
 * ```
 * - `handleProps(key)`：挂到**抓手本身**（只有抓手能起拖，点行内其它地方照旧）；
 * - `rowProps(key)`：挂到**每一行**，只负责打 `data-order-row` 供命中测试；
 * - `draggingId` / `dragOverId` 是字符串键（下标型列表传 `String(index)` 也行）。
 */
const DRAG_THRESHOLD_PX = 4;

type PointerDragState = {
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    /** 命中测试范围：拖动起手时锁定，拖拽中增删行也不会算错。 */
    container: HTMLElement | null;
    rows: HTMLElement[];
    move: ((event: PointerEvent) => void) | null;
    up: ((event: PointerEvent) => void) | null;
    cancel: ((event: PointerEvent) => void) | null;
};

export function useOrderDrag(onReorder: (fromId: string, toId: string) => void) {
    const [draggingId, setDraggingId] = useState("");
    const [dragOverId, setDragOverId] = useState("");
    const dragRef = useRef<PointerDragState | null>(null);
    const overRef = useRef("");
    const onReorderRef = useRef(onReorder);
    // 调用方多半传的是内联箭头函数：用 ref 取最新值，别因为函数换了身份去重挂 window 监听。
    onReorderRef.current = onReorder;

    const setOver = useCallback((next: string) => {
        if (overRef.current === next) return;
        overRef.current = next;
        setDragOverId(next);
    }, []);

    const detach = useCallback((state: PointerDragState | null) => {
        if (!state) return;
        if (state.move) window.removeEventListener("pointermove", state.move, true);
        if (state.up) window.removeEventListener("pointerup", state.up, true);
        if (state.cancel) window.removeEventListener("pointercancel", state.cancel, true);
        state.move = null;
        state.up = null;
        state.cancel = null;
    }, []);

    const reset = useCallback(() => {
        detach(dragRef.current);
        dragRef.current = null;
        overRef.current = "";
        // 拖拽时把整页光标改成抓手，松手必须还回去，否则整个画布一直是「抓取中」。
        document.body.style.cursor = "";
        setDraggingId("");
        setDragOverId("");
    }, [detach]);

    // 列表可能在拖拽中被卸载（弹窗关闭 / 切换 tab）—— 把挂在 window 上的监听摘掉，别泄漏。
    useEffect(
        () => () => {
            detach(dragRef.current);
            dragRef.current = null;
            document.body.style.cursor = "";
        },
        [detach],
    );

    /**
     * 光标 → 落点行。换行布局与普通竖排共用一套判据（和参考图 chip 完全一致）：
     * 先比行（中线以上算「在它前面」），再在行内比左右半边；都没命中就是最后一行。
     */
    const resolveOverRow = (state: PointerDragState, clientX: number, clientY: number) => {
        const rows = state.rows.length ? state.rows : collectRows(state.container);
        let fallback: HTMLElement | null = null;
        for (const row of rows) {
            if (row === document.body) continue;
            const rect = row.getBoundingClientRect();
            if (!rect.width && !rect.height) continue;
            fallback = row;
            if (clientY < rect.top + rect.height / 2) return row;
            if (clientY <= rect.bottom && clientX < rect.left + rect.width / 2) return row;
        }
        return fallback;
    };

    const beginDrag = (event: ReactPointerEvent<HTMLElement>, key: string) => {
        if (event.button !== 0 || dragRef.current) return;
        // 必须拦下来：不拦，画布会把这次 pointerdown 当成「拖节点 / 平移画布」，
        // 弹窗里则可能被 antd 的 focus trap 抢走。
        event.preventDefault();
        event.stopPropagation();

        const handle = event.currentTarget as HTMLElement;
        const row = handle.closest<HTMLElement>("[data-order-row]");
        const container = (row?.parentElement as HTMLElement | null) ?? (handle.parentElement as HTMLElement | null) ?? null;
        const rows = collectRows(container);

        const state: PointerDragState = {
            key,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            container,
            rows,
            move: null,
            up: null,
            cancel: null,
        };

        state.move = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== state.pointerId) return;
            if (!state.moved) {
                const dx = moveEvent.clientX - state.startX;
                const dy = moveEvent.clientY - state.startY;
                // 手抖不算拖拽；真到阈值才进入拖拽态（此时才写 state，避免点一下就整列重渲染）。
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                state.moved = true;
                setDraggingId(state.key);
                document.body.style.cursor = "grabbing";
            }
            moveEvent.preventDefault();
            const overRow = resolveOverRow(state, moveEvent.clientX, moveEvent.clientY);
            const overKey = overRow?.getAttribute("data-order-row") || "";
            setOver(overKey === state.key ? "" : overKey);
        };

        state.up = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== state.pointerId) return;
            const fromKey = state.key;
            const toKey = overRef.current;
            const moved = state.moved;
            reset();
            if (!moved || !toKey || toKey === fromKey) return;
            onReorderRef.current(fromKey, toKey);
        };

        state.cancel = (cancelEvent: PointerEvent) => {
            if (cancelEvent.pointerId !== state.pointerId) return;
            reset();
        };

        dragRef.current = state;
        window.addEventListener("pointermove", state.move, true);
        window.addEventListener("pointerup", state.up, true);
        window.addEventListener("pointercancel", state.cancel, true);
    };

    /** 挂到抓手本身（`<span {...drag.handleProps(item.id)}>`）。 */
    const handleProps = (key: string) => ({
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginDrag(event, key),
        // 抓手不是按钮：按在它上面松开不该被外层当成「点了这一行」（选渠道 / 展开技能）。
        onClick: (event: ReactMouseEvent<HTMLElement>) => {
            event.preventDefault();
            event.stopPropagation();
        },
        // 兜底：万一外层祖先还残留 draggable，别让浏览器原生拖拽抢走手势。
        onDragStart: (event: React.DragEvent<HTMLElement>) => event.preventDefault(),
        draggable: false as const,
        "data-order-handle": key,
        style: { touchAction: "none" as const },
    });

    /** 挂到每一行（`<div {...drag.rowProps(item.id)}>`）：只打命中测试用的标记。 */
    const rowProps = (key: string) => ({
        "data-order-row": key,
    });

    return { draggingId, dragOverId, handleProps, rowProps };
}

/**
 * 命中测试的行集合：优先「同一父容器里的行」，取不到再退回整份文档
 * （有些列表的行被包在分组壳里，父级拿不到全部行）。
 */
function collectRows(container: HTMLElement | null): HTMLElement[] {
    const scoped = container ? Array.from(container.querySelectorAll<HTMLElement>("[data-order-row]")) : [];
    if (scoped.length >= 2) return scoped;
    return Array.from(document.querySelectorAll<HTMLElement>("[data-order-row]"));
}
