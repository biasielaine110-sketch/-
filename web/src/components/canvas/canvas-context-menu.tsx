import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, Combine, Download, FolderPlus, GripVertical, Group as GroupIcon, Image as ImageIcon, Info, Maximize2, Plus, Copy, Scissors, Settings2, Sparkles, Trash2, Unlink2, Video, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useOrderDrag } from "@/hooks/use-order-drag";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import { mergeOrderedIds, reorderIds, sortByOrder } from "@/lib/canvas/menu-order";
import { nodeConversionTargets } from "@/lib/canvas/node-type-conversion";
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

/** 「转换为 XX 节点」的文案键 —— 一个源类型可能有好几个目标。 */
const CONVERT_LABEL_KEYS: Partial<Record<string, string>> = {
    [CanvasNodeType.Image]: "canvas.controls.convertToImage",
    [CanvasNodeType.Video]: "canvas.controls.convertToVideo",
    [CanvasNodeType.Mochiani]: "canvas.controls.convertToMochiani",
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
    videoBatchCount = 0,
    onVideoBatchSettings,
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
    /** 选区里可批量改视频参数的节点数（视频节点、且不在生成中）。>=2 才在菜单顶部出现。 */
    videoBatchCount?: number;
    onVideoBatchSettings?: () => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const imageQuickTools = useConfigStore((state) => state.config.imageQuickTools);
    const imageContextMenuOrder = useConfigStore((state) => state.config.imageContextMenuOrder);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const hasImage = Boolean(node && node.type === CanvasNodeType.Image && node.metadata?.content);
    const hasVideo = Boolean(node && node.type === CanvasNodeType.Video && node.metadata?.content);
    const hasAudio = Boolean(node && node.type === CanvasNodeType.Audio && node.metadata?.content);
    const isAudio = Boolean(node && node.type === CanvasNodeType.Audio);
    // Image and video nodes are the same generation slot in two flavours; a video node can also
    // become a MochiAni node (same prompt + same incoming references, work goes to the bridge).
    // Other node types have no target and simply never show the entry.
    const convertTargets = node ? nodeConversionTargets(node.type) : [];
    const showBatchGenerate = menu.type === "node" && Boolean(node) && batchGenerateCount > 1 && Boolean(onBatchGenerate);
    const showGroup = menu.type === "node" && Boolean(node) && groupCount > 1 && Boolean(onGroupSelected);
    // h3 提示词优化作用在**选区**上（点一次逐个转格式），所以哪怕只选了 1 个也出现。
    const showH3Optimize = menu.type === "node" && Boolean(node) && h3OptimizeCount > 0 && Boolean(onH3OptimizeSelected);
    // 批量改视频参数作用在选区里的**视频节点**上：>=2 才叫批量（1 个直接用节点自己的设置面板）。
    const showVideoBatch = menu.type === "node" && Boolean(node) && videoBatchCount > 1 && Boolean(onVideoBatchSettings);
    const showSelectionActions = showBatchGenerate || showGroup || showH3Optimize || showVideoBatch;

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

    const persistOrder = (nextOrder: string[]) => {
        updateConfig("imageContextMenuOrder", nextOrder);
        const quickSet = new Set(quickImageToolIds);
        const nextQuick = nextOrder.filter((id): id is ImageQuickToolId => quickSet.has(id as ImageQuickToolId));
        for (const id of quickImageToolIds) {
            if (!nextQuick.includes(id)) nextQuick.push(id);
        }
        updateConfig("imageQuickTools", { ids: nextQuick, showLabels: Boolean(imageQuickTools?.showLabels) });
    };

    // 排序走指针事件（`useOrderDrag`）：HTML5 drag 一 setState 就被 React 重渲染打断，
    // 菜单还是 `position: fixed` 浮层，原生 drag 更容易被浏览器取消。
    const toolDrag = useOrderDrag((fromId, toId) => persistOrder(reorderIds(menuOrder, fromId, toId)));

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
                    {/* 批量设置视频参数：只对选区里的视频节点生效（弹窗里可一次改模型 / 分辨率 / 比例）。
                        放在「一键生成」之后、「成组」之前 —— 它属于生成参数，不是结构操作。 */}
                    {showVideoBatch ? (
                        <MenuButton
                            icon={<Settings2 className="size-4" />}
                            label={t("canvas.contextMenu.videoBatch", { count: videoBatchCount })}
                            onClick={() => {
                                onBeforeAction?.();
                                onVideoBatchSettings?.();
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
                reorderable list (and its saved order) and sits above it. A video node has two
                targets (图像 / MochiAni), so this renders one item per target in declared order. */}
            {convertTargets.length && onConvertType && node ? (
                <div className="mb-1 border-b pb-1" style={{ borderColor: theme.toolbar.border }}>
                    {convertTargets.map((target) => (
                        <MenuButton
                            key={target}
                            icon={
                                target === CanvasNodeType.Video ? (
                                    <Video className="size-4" />
                                ) : target === CanvasNodeType.Mochiani ? (
                                    <Clapperboard className="size-4" />
                                ) : (
                                    <ImageIcon className="size-4" />
                                )
                            }
                            label={t(CONVERT_LABEL_KEYS[target] || "canvas.controls.convertToImage")}
                            onClick={() => {
                                // Close an open fullscreen preview first: it is showing the payload of the
                                // type we are about to leave.
                                onBeforeAction?.();
                                onConvertType(node, target);
                                onClose();
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {canReorder ? (
                <div className="px-3 pb-1 pt-1.5 text-[10px] opacity-45">{t("canvas.contextMenu.reorderHint")}</div>
            ) : null}
            {orderedTools.map((tool) => {
                const dragging = toolDrag.draggingId === tool.id;
                const isDropTarget = toolDrag.dragOverId === tool.id && Boolean(toolDrag.draggingId);
                return (
                <div
                    key={tool.id}
                    {...toolDrag.rowProps(tool.id)}
                    className={`flex items-stretch ${dragging ? "opacity-45" : ""} ${isDropTarget ? "bg-sky-500/10" : ""}`}
                >
                    {canReorder ? (
                        <span
                            className="inline-flex shrink-0 cursor-grab items-center self-stretch px-2 opacity-45 transition hover:opacity-90 active:cursor-grabbing"
                            title={t("canvas.contextMenu.dragHandle")}
                            aria-label={t("canvas.contextMenu.dragHandle")}
                            {...toolDrag.handleProps(tool.id)}
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
                            if (toolDrag.draggingId) return;
                            tool.onClick();
                        }}
                    />
                </div>
                );
            })}
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
