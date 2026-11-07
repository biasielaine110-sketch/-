import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Combine, Download, FolderPlus, GripVertical, Group as GroupIcon, Image as ImageIcon, Info, Maximize2, Plus, Copy, Scissors, Sparkles, Trash2, Unlink2, Video, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import { mergeOrderedIds, reorderIds, sortByOrder } from "@/lib/canvas/menu-order";
import { nodeConversionTarget } from "@/lib/canvas/node-type-conversion";
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
    onMaximizeVideo,
    onSaveAsset,
    onOpenVideoTools,
    onOpenAudioTools,
    onOpenAudioMerge,
    onConvertType,
    batchGenerateCount = 0,
    onBatchGenerate,
    groupCount = 0,
    onGroupSelected,
    h3OptimizeCount = 0,
    onH3OptimizeSelected,
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
    /** Open the video in maximized (fullscreen) view. Video nodes only. */
    onMaximizeVideo?: (node: CanvasNodeData) => void;
    onSaveAsset?: (node: CanvasNodeData) => void;
    onOpenVideoTools?: (node: CanvasNodeData) => void;
    onOpenAudioTools?: (node: CanvasNodeData) => void;
    onOpenAudioMerge?: () => void;
    /** Switch the node's generation type in place (image ↔ video); connections are kept. */
    onConvertType?: (node: CanvasNodeData, targetType: CanvasNodeType) => void;
    /** 选区里可批量生成的节点数（图片 / 视频）。>=2 才在菜单顶部出现「一键生成」。 */
    batchGenerateCount?: number;
    onBatchGenerate?: () => void;
    /** 选区里可成组的节点数（非分组节点）。>=2 才在菜单顶部出现「成组」。 */
    groupCount?: number;
    onGroupSelected?: () => void;
    /** 选区里可做「h3 提示词优化」的节点数（图片 / 视频且提示词非空）。>=1 就出现。 */
    h3OptimizeCount?: number;
    onH3OptimizeSelected?: () => void;
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
    // Image and video nodes are the same generation slot in two flavours, so either can become the
    // other. Other node types have no counterpart and simply never show the entry.
    const convertTarget = node ? nodeConversionTarget(node.type) : null;
    const showBatchGenerate = menu.type === "node" && Boolean(node) && batchGenerateCount > 1 && Boolean(onBatchGenerate);
    const showGroup = menu.type === "node" && Boolean(node) && groupCount > 1 && Boolean(onGroupSelected);
    // h3 提示词优化作用在**选区**上（点一次逐个转格式），所以哪怕只选了 1 个也出现。
    const showH3Optimize = menu.type === "node" && Boolean(node) && h3OptimizeCount > 0 && Boolean(onH3OptimizeSelected);
    const showSelectionActions = showBatchGenerate || showGroup || showH3Optimize;

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
                // Video-only actions: download the file and open it in maximized (fullscreen) view.
                ...(hasVideo && onDownload
                    ? [
                          {
                              id: "download",
                              label: t("common.download"),
                              icon: <Download className="size-4" />,
                              onClick: () => {
                                  onDownload(node);
                                  onClose();
                              },
                          },
                      ]
                    : []),
                ...(hasVideo && onMaximizeVideo
                    ? [
                          {
                              id: "maximize",
                              label: t("canvas.controls.maximize"),
                              icon: <Maximize2 className="size-4" />,
                              onClick: () => {
                                  onMaximizeVideo(node);
                                  onClose();
                              },
                          },
                      ]
                    : []),
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
    }, [hasAudio, hasImage, hasVideo, isAudio, imageHandlers, menu.type, node, onBeforeAction, onClose, onCopyImage, onDelete, onDownload, onDuplicate, onInfo, onMaximizeVideo, onOpenAudioTools, onOpenAudioMerge, onOpenVideoTools, onSaveAsset, quickImageToolIds, t]);

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
            {/* 多选批量动作：作用于**整个选区**而不是「右键的这个节点」，所以跟单节点工具项分开。
                都不能塞进 `orderedTools`（那套会被写进 imageContextMenuOrder 排序配置）。 */}
            {showSelectionActions ? (
                <div className="mb-1 border-b pb-1" style={{ borderColor: theme.toolbar.border }}>
                    {showBatchGenerate ? (
                        <MenuButton
                            icon={<Sparkles className="size-4" />}
                            label={t("canvas.contextMenu.batchGenerate", { count: batchGenerateCount })}
                            onClick={() => {
                                onBeforeAction?.();
                                onBatchGenerate?.();
                                onClose();
                            }}
                        />
                    ) : null}
                    {showGroup ? (
                        <MenuButton
                            icon={<GroupIcon className="size-4" />}
                            label={t("canvas.contextMenu.group", { count: groupCount })}
                            onClick={() => {
                                onGroupSelected?.();
                                onClose();
                            }}
                        />
                    ) : null}
                    {showH3Optimize ? (
                        <MenuButton
                            icon={<WandSparkles className="size-4" />}
                            label={t("canvas.contextMenu.h3Optimize", { count: h3OptimizeCount })}
                            onClick={() => {
                                onBeforeAction?.();
                                onH3OptimizeSelected?.();
                                onClose();
                            }}
                        />
                    ) : null}
                </div>
            ) : null}
            {/* Type conversion is a structural node operation, not a tool: it stays out of the
                reorderable list (and its saved order) and sits above it. */}
            {convertTarget && onConvertType && node ? (
                <div className="mb-1 border-b pb-1" style={{ borderColor: theme.toolbar.border }}>
                    <MenuButton
                        icon={convertTarget === CanvasNodeType.Video ? <Video className="size-4" /> : <ImageIcon className="size-4" />}
                        label={t(convertTarget === CanvasNodeType.Video ? "canvas.controls.convertToVideo" : "canvas.controls.convertToImage")}
                        onClick={() => {
                            // Close an open fullscreen preview first: it is showing the payload of the
                            // type we are about to leave.
                            onBeforeAction?.();
                            onConvertType(node, convertTarget);
                            onClose();
                        }}
                    />
                </div>
            ) : null}
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
