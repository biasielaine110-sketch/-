import { useState, type DragEvent } from "react";

/**
 * 列表行的 HTML5 拖拽排序（技能列表 / 配置里的技能管理共用）。
 *
 * 为什么不用 pointer 事件：技能面板长在画布节点里，画布会吞掉冒泡的 pointerdown
 * （平移 / 拖节点），pointer 版重排会被抢走手势。这里和对话节点里媒体、mention chip 的重排
 * 走同一个路子：只有手柄 `draggable`，整行不 draggable，拖到图片上也不会触发浏览器原生拖拽。
 */
export function useOrderDrag(onReorder: (fromId: string, toId: string) => void, mime = "application/x-list-order") {
    const [draggingId, setDraggingId] = useState("");
    const [dragOverId, setDragOverId] = useState("");

    const clear = () => {
        setDraggingId("");
        setDragOverId("");
    };

    const handleProps = (id: string) => ({
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(mime, id);
            setDraggingId(id);
        },
        onDragEnd: clear,
    });

    const rowProps = (id: string) => ({
        onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!draggingId) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            if (dragOverId !== id) setDragOverId(id);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
            event.preventDefault();
            event.stopPropagation();
            const fromId = event.dataTransfer.getData(mime) || draggingId;
            clear();
            if (fromId && fromId !== id) onReorder(fromId, id);
        },
    });

    return { draggingId, dragOverId, handleProps, rowProps };
}
