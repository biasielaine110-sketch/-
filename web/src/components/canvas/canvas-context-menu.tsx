import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Combine, Download, FolderPlus, GripVertical, Info, Plus, Copy, Scissors, Trash2, Unlink2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import { mergeOrderedIds, reorderIds, sortByOrder } from "@/lib/canvas/menu-order";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "@/types/canvas";
import {
    buildImageToolbarTools,
    defaultImageQuickToolIds,
    normalizeImageQuickToolIds,
    type ImageQuickToolId,
    type ImageToolHandlers,
} from "@/components/canvas/canvas-image-toolbar-tools";

type ContextMenuTool = {
    id: string;
    label: string;
    icon: ReactNode;
    active?: boolean;
    danger?: boolean;
    onClick: () => void;
};

export function CanvasNodeContextMenu({
    menu,
    node,
    imageHandlers,
    elevated = false,
    onClose,
    onBeforeAction,
    onDuplicate,
    onCopyImage,
    onDelete,
    onInfo,
    onDownload,
    onSaveAsset,
    onOpenVideoTools,
    onOpenAudioTools,
    onOpenAudioMerge,
}: {
    menu: ContextMenuState;
    node?: CanvasNodeData | null;
    imageHandlers?: ImageToolHandlers | null;
    /** Raise above fullscreen image preview / Ant Modal layers. */
    elevated?: boolean;
    onClose: () => void;
    /** Runs before any menu action (e.g. close image preview so edit dialogs are visible). */
    onBeforeAction?: () => void;
    onDuplicate: () => void;
    /** Copy the image bitmap to the system clipboard (for pasting outside the canvas). */
    onCopyImage?: () => void;
    onDelete: () => void;
    onInfo?: (node: CanvasNodeData) => void;
    onDownload?: (node: CanvasNodeData) => void;
    onSaveAsset?: (node: CanvasNodeData) => void;
    onOpenVideoTools?: (node: CanvasNodeData) => void;
    onOpenAudioTools?: (node: CanvasNodeData) => void;
    onOpenAudioMerge?: () => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const imageQuickTools = useConfigStore((state) => state.config.imageQuickTools);
    const imageContextMenuOrder = useConfigStore((state) => state.config.imageContextMenuOrder);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const suppressClickRef = useRef(false);
    const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasImage = Boolean(node && node.type === CanvasNodeType.Image && node.metadata?.content);
    const hasVideo = Boolean(node && node.type === CanvasNodeType.Video && node.metadata?.content);
    const hasAudio = Boolean(node && node.type === CanvasNodeType.Audio && node.metadata?.content);
    const isAudio = Boolean(node && node.type === CanvasNodeType.Audio);

    const quickImageToolIds = useMemo(() => {
        const normalized = normalizeImageQuickToolIds(imageQuickTools?.ids || []);
        return normalized.length ? normalized : defaultImageQuickToolIds;
    }, [imageQuickTools?.ids]);

    const tools = useMemo<ContextMenuTool[]>(() => {
        if (menu.type !== "node" || !node) {
            return [
                {
                    id: "delete",
                    label: t(menu.type === "connection" ? "canvas.controls.disconnect" : "canvas.controls.delete"),
                    icon: menu.type === "connection" ? <Unlink2 className="size-4" /> : <Trash2 className="size-4" />,
                    danger: true,
                    onClick: onDelete,
                },
            ];
        }

        if (!hasImage || !imageHandlers) {
            return [
                { id: "duplicate", label: t("canvas.controls.duplicate"), icon: <Plus className="size-4" />, onClick: onDuplicate },
                ...(hasVideo && onOpenVideoTools
                    ? [
                          {
                              id: "videoTools",
                              label: t("canvas.videoTools.open"),
                              icon: <Scissors className="size-4" />,
                              onClick: () => {
                                  onOpenVideoTools(node);
                                  onClose();
                              },
                          },
                      ]
                    : []),
                ...(hasAudio && onOpenAudioTools
                    ? [
                          {
                              id: "audioTools",
                              label: t("canvas.audioTools.open"),
                              icon: <Scissors className="size-4" />,
                              onClick: () => {
                                  onOpenAudioTools(node);
                                  onClose();
                              },
                          },
                      ]
                    : []),
                ...(isAudio && onOpenAudioMerge
                    ? [
                          {
                              id: "audioMerge",
                              label: t("canvas.audioMerge.open"),
                              icon: <Combine className="size-4" />,
                              onClick: () => {
                                  onOpenAudioMerge();
                                  onClose();
                              },
                          },
                      ]
                    : []),
                { id: "delete", label: t("canvas.controls.delete"), icon: <Trash2 className="size-4" />, danger: true, onClick: onDelete },
            ];
        }

        const quickSet = new Set(quickImageToolIds);
        const runAndClose = (action: () => void) => {
            onBeforeAction?.();
            action();
            onClose();
        };

        const imageTools = buildImageToolbarTools(node, imageHandlers)
            .filter((tool) => quickSet.has(tool.id as ImageQuickToolId))
            .map((tool) => ({
                id: tool.id,
                label: tool.label,
                icon: tool.icon,
                active: tool.active,
                onClick: () => runAndClose(tool.onClick),
            }));

        return [
            ...(onInfo && quickSet.has("info")
                ? [
                      {
                          id: "info",
                          label: t("canvas.nodeToolbar.info"),
                          icon: <Info className="size-4" />,
                          onClick: () => runAndClose(() => onInfo(node)),
                      },
                  ]
                : []),
            ...(onDownload && quickSet.has("download")
                ? [
                      {
                          id: "download",
                          label: t("common.download"),
                          icon: <Download className="size-4" />,
                          onClick: () => runAndClose(() => onDownload(node)),
                      },
                  ]
                : []),
            ...(onSaveAsset && quickSet.has("saveAsset")
                ? [
                      {
                          id: "saveAsset",
                          label: t("canvas.nodeToolbar.saveAsset"),
                          icon: <FolderPlus className="size-4" />,
                          onClick: () => runAndClose(() => onSaveAsset(node)),
                      },
                  ]
                : []),
            ...imageTools,
            ...(onCopyImage
                ? [
                      {
                          id: "copy",
                          label: t("common.copy"),
                          icon: <Copy className="size-4" />,
                          onClick: () => runAndClose(onCopyImage),
                      },
                  ]
                : []),
            {
                id: "duplicate",
                label: t("canvas.controls.duplicateNode"),
                icon: <Plus className="size-4" />,
                onClick: () => runAndClose(onDuplicate),
            },
            {
                id: "delete",
                label: t("canvas.controls.delete"),
                icon: <Trash2 className="size-4" />,
                danger: true,
                onClick: () => runAndClose(onDelete),
            },
        ];
    }, [hasAudio, hasImage, hasVideo, isAudio, imageHandlers, menu.type, node, onBeforeAction, onClose, onCopyImage, onDelete, onDownload, onDuplicate, onInfo, onOpenAudioTools, onOpenAudioMerge, onOpenVideoTools, onSaveAsset, quickImageToolIds, t]);

    const menuOrder = useMemo(() => mergeOrderedIds(imageContextMenuOrder || [], tools.map((tool) => tool.id)), [imageContextMenuOrder, tools]);
    const orderedTools = useMemo(() => sortByOrder(tools, menuOrder), [menuOrder, tools]);
    const canReorder = hasImage && menu.type === "node" && orderedTools.length > 1;

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-canvas-node-context-menu],.ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close, true);
        return () => window.removeEventListener("pointerdown", close, true);
    }, [onClose]);

    useEffect(
        () => () => {
            if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
        },
        [],
    );

    const armClickSuppress = () => {
        suppressClickRef.current = true;
        if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = setTimeout(() => {
            suppressClickRef.current = false;
            suppressTimerRef.current = null;
        }, 250);
    };

    const persistOrder = (nextOrder: string[]) => {
        updateConfig("imageContextMenuOrder", nextOrder);
        const quickSet = new Set(quickImageToolIds);
        const nextQuick = nextOrder.filter((id): id is ImageQuickToolId => quickSet.has(id as ImageQuickToolId));
        for (const id of quickImageToolIds) {
            if (!nextQuick.includes(id)) nextQuick.push(id);
        }
        updateConfig("imageQuickTools", { ids: nextQuick, showLabels: Boolean(imageQuickTools?.showLabels) });
    };

    const clearDrag = () => {
        setDraggingId(null);
        setDragOverId(null);
    };

    const menuNode = (
        <div
            data-canvas-node-context-menu
            className={`fixed max-h-[min(70vh,520px)] min-w-52 overflow-y-auto rounded-xl border py-1 shadow-2xl thin-scrollbar ${elevated ? "z-[5100]" : "z-[80]"}`}
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            {canReorder ? (
                <div className="px-3 pb-1 pt-1.5 text-[10px] opacity-45">{t("canvas.contextMenu.reorderHint")}</div>
            ) : null}
            {orderedTools.map((tool) => (
                <div
                    key={tool.id}
                    className={`flex items-stretch ${draggingId === tool.id ? "opacity-45" : ""} ${dragOverId === tool.id && draggingId && draggingId !== tool.id ? "bg-sky-500/10" : ""}`}
                    onDragOver={(event) => {
                        if (!canReorder || !draggingId) return;
                        event.preventDefault();
                        setDragOverId(tool.id);
                    }}
                    onDrop={(event) => {
                        if (!canReorder || !draggingId) return;
                        event.preventDefault();
                        event.stopPropagation();
                        armClickSuppress();
                        persistOrder(reorderIds(menuOrder, draggingId, tool.id));
                        clearDrag();
                    }}
                >
                    {canReorder ? (
                        <span
                            draggable
                            className="inline-flex shrink-0 cursor-grab items-center self-stretch px-2 opacity-45 transition hover:opacity-90 active:cursor-grabbing"
                            title={t("canvas.contextMenu.dragHandle")}
                            aria-label={t("canvas.contextMenu.dragHandle")}
                            onPointerDown={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                            onDragStart={(event) => {
                                event.stopPropagation();
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", tool.id);
                                setDraggingId(tool.id);
                            }}
                            onDragEnd={() => {
                                armClickSuppress();
                                clearDrag();
                            }}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                        >
                            <GripVertical className="size-3.5" />
                        </span>
                    ) : null}
                    <MenuButton
                        icon={tool.icon}
                        label={tool.label}
                        active={tool.active}
                        danger={tool.danger}
                        onClick={() => {
                            if (draggingId || suppressClickRef.current) return;
                            tool.onClick();
                        }}
                    />
                </div>
            ))}
        </div>
    );

    if (elevated && typeof document !== "undefined") {
        return createPortal(menuNode, document.body);
    }

    return menuNode;
}

function MenuButton({ icon, label, onClick, danger = false, active = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; active?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button
            type="button"
            className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80 [&_svg]:size-4 ${active ? "opacity-100" : ""}`}
            style={{ color: danger ? "#f87171" : theme.node.text, background: active ? `${theme.node.fill}` : undefined }}
            onClick={onClick}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
