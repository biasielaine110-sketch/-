import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Clapperboard, Copy, Download, Expand, Grid2x2, Group, Highlighter, Image as ImageIcon, MessageSquareText, Minus, Music2, Play, Plus, Puzzle, RefreshCw, Square, Star, Trash2, Video } from "lucide-react";

import { CanvasDisplayImage, CANVAS_DISPLAY_MAX_EDGE } from "@/lib/canvas/canvas-display-image";
import { CanvasLazyMedia } from "@/lib/canvas/canvas-lazy-media";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { refreshMediaUrl } from "@/services/file-storage";
import { saveBlobAs } from "@/lib/fs/save-blob";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasChatContent } from "./canvas-chat-content";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasTextPromptPicker } from "./canvas-text-prompt-picker";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage, type Position } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useTranslation } from "react-i18next";

import { DEFAULT_CANVAS_FONT_SIZE } from "@/constant/canvas";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";
const CANVAS_NODE_SCROLL_POSITION_KEY = "infinite-atelier:canvas-node-scroll-position";

type CanvasNodeProps = {
    data: CanvasNodeData;
    /** Read current viewport scale without forcing a re-render on every zoom tick. */
    getScale: () => number;
    /** Temporary drag translate; kept out of node state until mouseup. */
    previewOffset?: Position;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    showPanel: boolean;
    showImageInfo: boolean;
    mentionReferences?: CanvasResourceReference[];
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    groupChildCount?: number;
    isGroupDropTarget?: boolean;
    batchExpanded?: boolean;
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (nodeId: string, imageId: string) => void;
    onDuplicateBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onRetryBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDeleteBatchImage?: (nodeId: string, imageId: string | string[]) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onCancelGeneration?: (nodeId: string) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onCreateChat?: (node: CanvasNodeData) => void;
    onExportDocument?: (node: CanvasNodeData) => void;
    onSendChat?: (nodeId: string, text: string, options?: import("@/lib/canvas/canvas-chat-helpers").ChatSendOptions) => void;
    onChatModelChange?: (nodeId: string, model: string) => void;
    onChatImageModelChange?: (nodeId: string, model: string) => void;
    onChatModesChange?: (nodeId: string, options: import("@/lib/canvas/canvas-chat-helpers").ChatSendOptions) => void;
    onChatSkillsChange?: (nodeId: string, skillIds: string[]) => void;
    onDeleteChatMessage?: (nodeId: string, messageId: string) => void;
    onInsertChatImage?: (image: import("@/types/canvas").CanvasAssistantImage) => void;
    onFontSizeChange?: (nodeId: string, fontSize: number) => void;
    onReorderLinkedMedia?: (nodeId: string, orderedNodeIds: string[]) => void;
    onEditText?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData, imageId?: string) => void;
    onAnnotate?: (node: CanvasNodeData) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    onContentChange: (nodeId: string, content: string) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onCancelGeneration?: (nodeId: string) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onCreateChat?: (node: CanvasNodeData) => void;
    onExportDocument?: (node: CanvasNodeData) => void;
    onSendChat?: (nodeId: string, text: string, options?: import("@/lib/canvas/canvas-chat-helpers").ChatSendOptions) => void;
    onChatModelChange?: (nodeId: string, model: string) => void;
    onChatImageModelChange?: (nodeId: string, model: string) => void;
    onChatModesChange?: (nodeId: string, options: import("@/lib/canvas/canvas-chat-helpers").ChatSendOptions) => void;
    onChatSkillsChange?: (nodeId: string, skillIds: string[]) => void;
    onDeleteChatMessage?: (nodeId: string, messageId: string) => void;
    onInsertChatImage?: (image: import("@/types/canvas").CanvasAssistantImage) => void;
    onFontSizeChange?: (nodeId: string, fontSize: number) => void;
    onReorderLinkedMedia?: (nodeId: string, orderedNodeIds: string[]) => void;
    onEditText?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string | string[]) => void;
    onViewBatchImage?: (imageId: string) => void;
    onAnnotate?: (node: CanvasNodeData) => void;
    groupChildCount: number;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    getScale,
    previewOffset,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    showPanel,
    showImageInfo,
    mentionReferences = [],
    renderPanel,
    renderNodeContent,
    groupChildCount = 0,
    isGroupDropTarget = false,
    batchExpanded = false,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResizeStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onTitleChange,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onRetry,
    onCancelGeneration,
    onGenerateImage,
    onCreateChat,
    onExportDocument,
    onSendChat,
    onChatModelChange,
    onChatImageModelChange,
    onChatModesChange,
    onChatSkillsChange,
    onDeleteChatMessage,
    onInsertChatImage,
    onFontSizeChange,
    onReorderLinkedMedia,
    onEditText,
    onViewImage,
    onAnnotate,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const definition = getNodeDefinition(data.type);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title || "");
    const hasImageContent = (data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Annotate) && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isGroup = data.type === CanvasNodeType.Group;
    const batchCount = data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Video ? data.metadata?.images?.length || 0 : 0;
    const isBatchRoot = batchCount > 1;
    // Nodes with the interaction/move toggle ignore content pointer events in move mode and allow interaction in interactive mode.
    // forceInteractive states such as editing stay interactive, as do empty nodes so their upload and generation actions remain usable.
    const supportsInteractionToggle = Boolean(definition?.interactionToggle);
    const forceInteractive = supportsInteractionToggle ? Boolean(definition?.forceInteractive?.(data)) : false;
    const contentInteractive = !supportsInteractionToggle || forceInteractive || !data.metadata?.content ? true : Boolean(data.metadata?.interactive);
    // Transparent nodes such as SVGs blend into the canvas while retaining outlines for selected or related states.
    const transparentBg = Boolean(definition?.transparentBackground);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const imageBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : "transparent";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const nodeContentRef = useRef<HTMLDivElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        setTitleDraft(data.title || "");
    }, [data.title]);

    useEffect(() => {
        if (!isEditingTitle) return;
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
    }, [isEditingTitle]);

    const finishTitleEditing = useCallback(() => {
        const title = titleDraft.trim() || data.title || t("canvas.node.untitled");
        setTitleDraft(title);
        setIsEditingTitle(false);
        if (title !== data.title) onTitleChange(data.id, title);
    }, [data.id, data.title, onTitleChange, t, titleDraft]);

    useEffect(() => {
        const root = nodeContentRef.current;
        if (!root) return;

        const scrollables = Array.from(root.querySelectorAll<HTMLElement>("[data-canvas-scroll-position], [data-canvas-no-zoom]"));
        if (!scrollables.length) return;

        let saved: Record<string, { top: number; left: number }> = {};
        try {
            const stored = window.localStorage.getItem(CANVAS_NODE_SCROLL_POSITION_KEY);
            saved = stored ? (JSON.parse(stored) as Record<string, { top: number; left: number }>) : {};
        } catch {
            saved = {};
        }

        const entries = scrollables.map((element, index) => {
            const localKey = element.dataset.canvasScrollPosition || String(index);
            const key = `${data.id}:${localKey}`;
            const restore = () => {
                const position = saved[key];
                if (!position) return;
                element.scrollTop = Math.min(Math.max(0, position.top), Math.max(0, element.scrollHeight - element.clientHeight));
                element.scrollLeft = Math.min(Math.max(0, position.left), Math.max(0, element.scrollWidth - element.clientWidth));
            };
            const save = () => {
                try {
                    const stored = window.localStorage.getItem(CANVAS_NODE_SCROLL_POSITION_KEY);
                    const positions = stored ? (JSON.parse(stored) as Record<string, { top: number; left: number }>) : {};
                    positions[key] = { top: element.scrollTop, left: element.scrollLeft };
                    window.localStorage.setItem(CANVAS_NODE_SCROLL_POSITION_KEY, JSON.stringify(positions));
                } catch {
                    // Ignore storage failures; scrolling should remain fully functional in private mode.
                }
            };
            restore();
            const frame = window.requestAnimationFrame(restore);
            element.addEventListener("scroll", save, { passive: true });
            return { element, save, frame };
        });

        return () => {
            entries.forEach(({ element, save, frame }) => {
                window.cancelAnimationFrame(frame);
                save();
                element.removeEventListener("scroll", save);
            });
        };
    }, [data.id]);

    useEffect(() => {
        if (!isEditingTitle) return;
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && titleInputRef.current?.contains(target)) return;
            finishTitleEditing();
        };
        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [finishTitleEditing, isEditingTitle]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const scale = getScale() || 1;
            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, getScale, onResize],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd(data.id);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        onResizeStart(data.id);
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video || Boolean(definition?.keepAspectRatio?.(data)),
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            data-node-id={data.id}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${data.position.x + (previewOffset?.x || 0)}px, ${data.position.y + (previewOffset?.y || 0)}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
                willChange: previewOffset ? "transform" : undefined,
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onMouseDownCapture={(event) => onSelectCapture?.(event, data.id)}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            {(isSelected || hovered || isEditingTitle) && (
                <div className="absolute left-3 top-[-28px] z-[65] max-w-[calc(100%-24px)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {isEditingTitle ? (
                        <input
                            ref={titleInputRef}
                            value={titleDraft}
                            maxLength={64}
                            className="h-6 max-w-full border-0 border-b border-dashed bg-transparent px-0 text-left text-xs font-medium outline-none"
                            style={{ borderColor: theme.node.muted, color: theme.node.text }}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onBlur={finishTitleEditing}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") finishTitleEditing();
                                if (event.key === "Escape") {
                                    setTitleDraft(data.title || "");
                                    setIsEditingTitle(false);
                                }
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="block max-w-full truncate border-b border-dashed border-transparent px-0 py-0.5 text-left text-xs font-medium opacity-75 transition hover:border-current hover:opacity-100"
                            style={{ color: theme.node.text }}
                            title={t("canvas.node.renameHint")}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                setIsEditingTitle(true);
                            }}
                        >
                            {data.title || t("canvas.node.untitled")}
                        </button>
                    )}
                </div>
            )}

            <div
                className="relative h-full w-full overflow-visible rounded-3xl border-2"
                style={{
                    background: isGroup ? `${theme.toolbar.panel}66` : hasImageContent || hasVideoContent || transparentBg ? "transparent" : theme.node.fill,
                    borderColor: isGroup
                        ? isGroupDropTarget || isActive
                            ? selectionBlue
                            : theme.node.stroke
                        : hasImageContent
                          ? imageBorderColor
                          : isActive
                            ? selectionBlue
                            : isRelated
                              ? theme.node.muted
                              : transparentBg
                                ? "transparent"
                                : theme.node.stroke,
                    borderStyle: isGroup ? "dashed" : "solid",
                    boxShadow: isGroupDropTarget ? `0 0 0 2px ${selectionBlue}66, inset 0 0 0 999px ${selectionBlue}10` : isActive ? `0 0 0 1px ${selectionBlue}55` : isRelated ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => onMouseDown(event, data.id)}
                onDoubleClick={(event) => {
                    if (data.type === CanvasNodeType.Annotate && hasImageContent) {
                        event.stopPropagation();
                        onAnnotate?.(data);
                        return;
                    }
                    if (data.type === CanvasNodeType.Image && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    if (onEditText) {
                        onEditText(data);
                        return;
                    }
                    setIsEditingContent(true);
                }}
            >
                <div
                    ref={nodeContentRef}
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: isGroup ? "transparent" : hasImageContent || hasVideoContent || transparentBg ? "transparent" : theme.node.fill,
                            pointerEvents: contentInteractive ? undefined : "none",
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        renderNodeContent={renderNodeContent}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onCancelGeneration={onCancelGeneration}
                        onGenerateImage={onGenerateImage}
                        onCreateChat={onCreateChat}
                        onExportDocument={onExportDocument}
                        onSendChat={onSendChat}
                        onChatModelChange={onChatModelChange}
                        onChatImageModelChange={onChatImageModelChange}
                        onChatModesChange={onChatModesChange}
                        onChatSkillsChange={onChatSkillsChange}
                        onDeleteChatMessage={onDeleteChatMessage}
                        onInsertChatImage={onInsertChatImage}
                        onFontSizeChange={onFontSizeChange}
                        onReorderLinkedMedia={onReorderLinkedMedia}
                        onEditText={onEditText}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={(imageId) => onSetBatchPrimary?.(data.id, imageId)}
                        onDuplicateBatchImage={(imageId) => onDuplicateBatchImage?.(data, imageId)}
                        onRetryBatchImage={(imageId) => onRetryBatchImage?.(data, imageId)}
                        onDeleteBatchImage={(imageId) => onDeleteBatchImage?.(data.id, imageId)}
                        onViewBatchImage={(imageId) => onViewImage?.(data, imageId)}
                        onAnnotate={onAnnotate}
                        groupChildCount={groupChildCount}
                    />
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {!isGroup && !hasImageContent && !hasVideoContent && !hasAudioContent ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} />
                ) : null}

                <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
            </div>

            <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "target")} />
            <ConnectionHandleDot
                side="right"
                visible={(definition?.hasSourceHandle ?? true) && data.type !== CanvasNodeType.Config && (hovered || isSelected || isConnecting)}
                onMouseDown={(event) => onConnectStart(event, data.id, "source")}
            />

            {showPanel && !isGroup && renderPanel ? <div className="absolute left-1/2 top-full z-[70] w-[600px] max-w-none -translate-x-1/2 pt-4">{renderPanel(data)}</div> : null}
        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    if (props.node.type === CanvasNodeType.Config && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.node.type === CanvasNodeType.Merge && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.node.type === CanvasNodeType.Chat) return <ChatNodeContent {...props} />;
    if (props.isBatchRoot || ((props.node.type === CanvasNodeType.Image || props.node.type === CanvasNodeType.Video) && (props.node.metadata?.images?.length || 0) > 0)) {
        return props.node.type === CanvasNodeType.Video ? <VideoBatchContent {...props} /> : <ImageNodeContent {...props} />;
    }
    if (props.node.metadata?.status === "loading") return <LoadingContent theme={props.theme} onCancel={props.onCancelGeneration ? () => props.onCancelGeneration?.(props.node.id) : undefined} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;

    const Renderer = nodeContentRenderers[props.node.type as CanvasNodeType];
    if (Renderer) return <Renderer {...props} />;

    return <MissingPluginContent theme={props.theme} type={props.node.type} />;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Annotate]: AnnotateNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Group]: GroupNodeContent,
    [CanvasNodeType.Director]: DirectorNodeContent,
    [CanvasNodeType.Chat]: ChatNodeContent,
    [CanvasNodeType.Merge]: EmptyMergeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function EmptyMergeContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Grid2x2 className="size-7 opacity-35" />
            <span className="text-sm">{t("canvas.mergeNode.empty")}</span>
        </div>
    );
}

function AnnotateNodeContent({ node, theme, onAnnotate }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const content = node.metadata?.content;
    const annotations = node.metadata?.annotations || [];
    if (!content) {
        return (
            <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center" style={{ color: theme.node.placeholder }}>
                <span className="grid size-11 place-items-center rounded-2xl" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                    <Highlighter className="size-5" />
                </span>
                <span className="text-sm font-semibold" style={{ color: theme.node.text }}>
                    {t("canvas.nodeTypes.annotate")}
                </span>
                <span className="text-xs opacity-55">{t("canvas.annotate.emptyHint")}</span>
            </div>
        );
    }
    return (
        <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
            <CanvasLazyMedia>
                <CanvasDisplayImage
                    src={content}
                    previewSrc={node.metadata?.thumbnailContent}
                    storageKey={node.metadata?.storageKey}
                    previewStorageKey={node.metadata?.thumbnailStorageKey}
                    alt={node.title}
                    maxEdge={CANVAS_DISPLAY_MAX_EDGE}
                    className="pointer-events-none block h-full w-full select-none object-contain"
                />
            </CanvasLazyMedia>
            {annotations.length ? (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                    {annotations.map((item) => {
                        const sw = Math.max(1, item.strokeWidth);
                        const strokeProps = { stroke: item.stroke, strokeWidth: sw, fill: "none" as const, vectorEffect: "non-scaling-stroke" as const };
                        if (item.kind === "rect") return <rect key={item.id} x={item.x} y={item.y} width={item.w} height={item.h} {...strokeProps} />;
                        if (item.kind === "ellipse") return <ellipse key={item.id} cx={item.x + item.w / 2} cy={item.y + item.h / 2} rx={item.w / 2} ry={item.h / 2} {...strokeProps} />;
                        if (item.kind === "arrow") {
                            const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
                            const head = Math.max(0.005, Math.min(0.012, item.strokeWidth * 0.0025));
                            const lx = item.x2 - head * Math.cos(angle - Math.PI / 6);
                            const ly = item.y2 - head * Math.sin(angle - Math.PI / 6);
                            const rx = item.x2 - head * Math.cos(angle + Math.PI / 6);
                            const ry = item.y2 - head * Math.sin(angle + Math.PI / 6);
                            return (
                                <g key={item.id}>
                                    <line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2} {...strokeProps} />
                                    <polyline points={`${lx},${ly} ${item.x2},${item.y2} ${rx},${ry}`} {...strokeProps} />
                                </g>
                            );
                        }
                        return (
                            <text key={item.id} x={item.x} y={item.y} fill={item.color} fontSize={item.fontSize / 700} fontWeight={600}>
                                {item.text}
                            </text>
                        );
                    })}
                </svg>
            ) : null}
            <div className="pointer-events-none absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ background: "rgba(15,23,42,.55)" }}>
                {t("canvas.annotate.badge", { count: annotations.length })}
            </div>
            <button
                type="button"
                className="absolute bottom-2.5 right-2.5 z-30 flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                title={t("canvas.annotate.openTitle")}
                onClick={(event) => {
                    event.stopPropagation();
                    onAnnotate?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <Highlighter className="size-3.5" />
                {t("canvas.annotate.open")}
            </button>
        </div>
    );
}

function ChatNodeContent({ node, theme, mentionReferences, onSendChat, onChatModelChange, onChatImageModelChange, onChatModesChange, onChatSkillsChange, onDeleteChatMessage, onInsertChatImage, onFontSizeChange, onCancelGeneration, onReorderLinkedMedia }: NodeContentRendererProps) {
    // Exclude this chat node itself: its resource text is the latest reply and must not fill the composer.
    const upstreamReferences = mentionReferences.filter((reference) => reference.nodeId !== node.id);
    const connectedTexts = upstreamReferences.filter((reference) => reference.active && reference.kind === "text" && reference.text?.trim()).map((reference) => reference.text!.trim());
    return (
        <CanvasChatContent
            node={node}
            theme={theme}
            connectedTexts={connectedTexts}
            mentionReferences={upstreamReferences}
            onSend={(nodeId, text, options) => onSendChat?.(nodeId, text, options)}
            onStop={onCancelGeneration}
            onModelChange={(nodeId, model) => onChatModelChange?.(nodeId, model)}
            onImageModelChange={(nodeId, model) => onChatImageModelChange?.(nodeId, model)}
            onModesChange={(nodeId, options) => onChatModesChange?.(nodeId, options)}
            onSkillsChange={(nodeId, skillIds) => onChatSkillsChange?.(nodeId, skillIds)}
            onDeleteMessage={onDeleteChatMessage}
            onInsertImage={onInsertChatImage}
            onFontSizeChange={onFontSizeChange}
            onReorderLinkedMedia={onReorderLinkedMedia}
        />
    );
}

function DirectorNodeContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="grid size-11 place-items-center rounded-2xl" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                <Clapperboard className="size-5" />
            </span>
            <span className="text-sm font-semibold" style={{ color: theme.node.text }}>
                {t("canvas.nodeTypes.director")}
            </span>
            <span className="text-xs opacity-55">{t("canvas.director.openHint")}</span>
        </div>
    );
}

function GroupNodeContent({ node, theme, groupChildCount }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none flex h-full w-full flex-col p-4">
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: theme.node.text }}>
                <span className="grid size-8 place-items-center rounded-xl" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                    <Group className="size-4" />
                </span>
                <span>{t("canvas.node.group")}</span>
                <span className="ml-auto rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: theme.node.fill, color: theme.node.muted }}>
                    {t("canvas.node.nodeCount", { count: groupChildCount })}
                </span>
            </div>
            <div className="mt-3 flex-1 rounded-2xl border border-dashed" style={{ borderColor: theme.node.stroke, background: `${theme.node.fill}55` }} />
        </div>
    );
}

function LoadingContent({ theme, onCancel }: Pick<NodeContentRendererProps, "theme"> & { onCancel?: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span>
            {onCancel ? (
                <button
                    type="button"
                    className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onCancel();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Square className="size-3 fill-current" />
                    {t("canvas.node.cancel")}
                </button>
            ) : null}
        </div>
    );
}

function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    const { t } = useTranslation();
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="text-xs leading-5 text-red-300">{node.metadata?.errorDetails || t("canvas.node.failed")}</div>
            <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
        </div>
    );
}

function MissingPluginContent({ theme, type }: Pick<NodeContentRendererProps, "theme"> & { type: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Puzzle className="size-7 opacity-40" />
            <span className="text-sm">{t("canvas.node.missingPlugin")}</span>
            <span className="text-[11px] opacity-70">{t("canvas.node.missingPluginDescription", { type })}</span>
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStopEditing, onGenerateImage, onCreateChat, onExportDocument, onEditText, onFontSizeChange }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const fontSize = Math.max(10, Math.min(48, node.metadata?.fontSize || DEFAULT_CANVAS_FONT_SIZE));
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    const actionButtonStyle = { background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke, color: theme.node.text };
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const restoredScrollNodeRef = useRef<string | null>(null);
    const SCROLL_KEY = "infinite-atelier:canvas-text-scroll-position";

    // Restore the text node's scroll position once, on first mount. Nodes outside
    // the visible viewport are culled by the canvas and remounted on return, and
    // reopening the canvas remounts every node from scratch — so the position must
    // live outside React state.
    useEffect(() => {
        if (restoredScrollNodeRef.current === node.id) return;
        restoredScrollNodeRef.current = node.id;
        const el = scrollRef.current || textareaRef.current;
        if (!el) return;
        let savedTop = 0;
        try {
            const stored = window.localStorage.getItem(SCROLL_KEY);
            const positions = stored ? (JSON.parse(stored) as Record<string, number>) : {};
            savedTop = Number.isFinite(positions[node.id]) ? Math.max(0, positions[node.id]) : 0;
        } catch {
            savedTop = 0;
        }
        const restore = () => {
            el.scrollTop = Math.min(savedTop, Math.max(0, el.scrollHeight - el.clientHeight));
        };
        restore();
        const frame = window.requestAnimationFrame(restore);
        return () => window.cancelAnimationFrame(frame);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    // Save the scroll position as the user scrolls the active text surface. This
    // effect rebinds whenever editing toggles, because the scrollable element swaps
    // between the textarea (editing) and the read-only div.
    useEffect(() => {
        const el = isEditingContent ? textareaRef.current : scrollRef.current;
        if (!el) return;
        const save = () => {
            try {
                const stored = window.localStorage.getItem(SCROLL_KEY);
                const positions = stored ? (JSON.parse(stored) as Record<string, number>) : {};
                positions[node.id] = el.scrollTop;
                window.localStorage.setItem(SCROLL_KEY, JSON.stringify(positions));
            } catch {
                // Ignore storage failures; scrolling should remain fully functional in private mode.
            }
        };
        el.addEventListener("scroll", save, { passive: true });
        return () => {
            save();
            el.removeEventListener("scroll", save);
        };
    }, [node.id, isEditingContent, textareaRef]);

    const adjustFontSize = (delta: number) => {
        if (!onFontSizeChange) return;
        const next = Math.max(10, Math.min(48, fontSize + delta));
        if (next === fontSize) return;
        onFontSizeChange(node.id, next);
    };

    // Align with Chat: chrome/empty areas drag the node; only real text widgets block bubbling.
    const stopIfInteractive = (event: React.MouseEvent | React.PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("[data-canvas-text-input],textarea,button,input,[contenteditable='true']")) {
            event.stopPropagation();
        }
    };

    return (
        <div className="relative flex h-full w-full cursor-move flex-col overflow-hidden" onMouseDown={stopIfInteractive} onPointerDown={stopIfInteractive}>
            <div className="relative z-20 flex shrink-0 flex-wrap items-center justify-end gap-1.5 px-3 pb-2 pt-2">
                {onFontSizeChange ? (
                    <div className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full border px-1 backdrop-blur-md" style={actionButtonStyle}>
                        <button
                            type="button"
                            className="grid size-6 place-items-center rounded-full opacity-85 transition hover:opacity-100 disabled:opacity-35"
                            disabled={fontSize <= 10}
                            title={t("canvas.nodeToolbar.decreaseFont")}
                            aria-label={t("canvas.nodeToolbar.decreaseFont")}
                            onClick={(event) => {
                                event.stopPropagation();
                                adjustFontSize(-2);
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <Minus className="size-3" />
                        </button>
                        <span className="min-w-7 text-center text-[10px] font-medium tabular-nums opacity-70">{fontSize}</span>
                        <button
                            type="button"
                            className="grid size-6 place-items-center rounded-full opacity-85 transition hover:opacity-100 disabled:opacity-35"
                            disabled={fontSize >= 48}
                            title={t("canvas.nodeToolbar.increaseFont")}
                            aria-label={t("canvas.nodeToolbar.increaseFont")}
                            onClick={(event) => {
                                event.stopPropagation();
                                adjustFontSize(2);
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <Plus className="size-3" />
                        </button>
                    </div>
                ) : null}
                <CanvasTextPromptPicker
                    buttonStyle={actionButtonStyle}
                    className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                    onSelect={(prompt) => onContentChange(node.id, prompt.content)}
                />
                <button
                    type="button"
                    className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100 disabled:opacity-35"
                    style={actionButtonStyle}
                    disabled={!((node.metadata?.content || node.metadata?.prompt || "").trim())}
                    onClick={(event) => {
                        event.stopPropagation();
                        onExportDocument?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("canvas.nodeToolbar.exportDocumentTitle")}
                    aria-label={t("canvas.nodeToolbar.exportDocument")}
                >
                    <Download className="size-3.5 shrink-0" />
                    {t("canvas.nodeToolbar.exportDocument")}
                </button>
                <button
                    type="button"
                    className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                    style={actionButtonStyle}
                    onClick={(event) => {
                        event.stopPropagation();
                        onCreateChat?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("canvas.node.createChatTitle")}
                    aria-label={t("canvas.node.createChat")}
                >
                    <MessageSquareText className="size-3.5 shrink-0" />
                    {t("canvas.node.createChat")}
                </button>
                <button
                    type="button"
                    className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                    style={actionButtonStyle}
                    onClick={(event) => {
                        event.stopPropagation();
                        onGenerateImage?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t("canvas.node.generateImage")}
                    aria-label={t("canvas.node.generateImage")}
                >
                    <ImageIcon className="size-3.5 shrink-0" />
                    {t("canvas.node.generate")}
                </button>
            </div>
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar block min-h-0 w-full flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent pl-4 pr-4 pt-0 pb-4 m-0 font-mono outline-none select-text appearance-none"
                    style={textStyle}
                    value={node.metadata?.content || ""}
                    references={mentionReferences}
                    highlightLabels={false}
                    data-canvas-no-zoom
                    data-canvas-text-input
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        onEditText?.(node);
                        onStopEditing();
                    }}
                />
            ) : (
                <div ref={scrollRef} data-canvas-no-zoom className="min-h-0 flex-1 overflow-y-auto" onWheel={(event) => event.stopPropagation()}>
                    <div
                        data-canvas-selectable-text
                        className="block w-full cursor-text select-text whitespace-pre-wrap break-words bg-transparent pl-4 pr-4 pt-0 pb-4 font-mono"
                        style={textStyle}
                    >
                        {node.metadata?.content || <span style={{ color: theme.node.placeholder }}>{t("canvas.node.editText")}</span>}
                    </div>
                </div>
            )}
        </div>
    );
}

function VideoBatchContent(props: NodeContentRendererProps) {
    return (
        <ImageContent
            node={props.node}
            batchExpanded={props.batchExpanded}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onDuplicateBatchImage={props.onDuplicateBatchImage}
            onRetryBatchImage={props.onRetryBatchImage}
            onDeleteBatchImage={props.onDeleteBatchImage}
            onViewBatchImage={props.onViewBatchImage}
        />
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && !props.isBatchRoot && !(props.node.metadata?.images?.length || 0)) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            batchExpanded={props.batchExpanded}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onDuplicateBatchImage={props.onDuplicateBatchImage}
            onRetryBatchImage={props.onRetryBatchImage}
            onDeleteBatchImage={props.onDeleteBatchImage}
            onViewBatchImage={props.onViewBatchImage}
            onCancelGeneration={props.onCancelGeneration}
        />
    );
}

function EmptyImageContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
        </div>
    );
}

function CanvasNodeVideoPlayer({ src, posterSrc, storageKey }: { src: string; posterSrc?: string; storageKey?: string }) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [activated, setActivated] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [playableSrc, setPlayableSrc] = useState(src);
    const retriesRef = useRef(0);

    useEffect(() => {
        setPlayableSrc(src);
        retriesRef.current = 0;
    }, [src, storageKey]);

    // A dead blob: URL (revoked mid-session / failed hydration) leaves a plain <video> black
    // forever. Rebuild a fresh object URL from the stored blob and retry a few times.
    const handleVideoError = () => {
        if (!storageKey || retriesRef.current >= 2) return;
        retriesRef.current += 1;
        void refreshMediaUrl(storageKey).then((next) => {
            if (next && next !== playableSrc) setPlayableSrc(next);
        });
    };

    useEffect(() => {
        setActivated(false);
        setPlaying(false);
    }, [playableSrc]);

    useEffect(() => {
        if (!activated) return;
        const video = videoRef.current;
        if (!video) return;
        void video
            .play()
            .then(() => setPlaying(true))
            .catch(() => setPlaying(false));
    }, [activated]);

    const stopShell = (event: React.SyntheticEvent) => {
        event.stopPropagation();
    };

    const handlePlayClick = (event: React.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        if (!activated) {
            setActivated(true);
            return;
        }
        const video = videoRef.current;
        if (!video) return;
        void video
            .play()
            .then(() => setPlaying(true))
            .catch(() => setPlaying(false));
    };

    const handleFullscreen = (event: React.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        const video = videoRef.current;
        if (!video) return;
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
            return;
        }
        const anyVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
        if (typeof video.requestFullscreen === "function") {
            void video.requestFullscreen().catch(() => {});
        } else if (typeof anyVideo.webkitEnterFullscreen === "function") {
            anyVideo.webkitEnterFullscreen();
        }
    };

    const handleDownload = (event: React.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        void saveBlobAs(playableSrc, "canvas-video.mp4");
    };

    return (
        <div
            className="relative h-full w-full overflow-hidden"
            onMouseDown={(event) => {
                // 只在点击自定义叠加按钮（全屏/下载，已用 stopShell 单独处理）时阻止冒泡；
                // 点住视频画面空白处要允许事件冒泡到节点容器，才能正常拖动节点。
                if (event.target instanceof Element && event.target.closest("[data-video-action]")) {
                    event.stopPropagation();
                }
            }}
            onPointerDown={(event) => {
                if (event.target instanceof Element && event.target.closest("[data-video-action]")) {
                    event.stopPropagation();
                }
            }}
        >
            {activated ? (
                <video
                    ref={videoRef}
                    src={playableSrc}
                    poster={posterSrc || undefined}
                    className="h-full w-full rounded-[18px] bg-black object-contain"
                    playsInline
                    preload="metadata"
                    controls
                    data-canvas-no-zoom
                    onError={handleVideoError}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                />
            ) : posterSrc ? (
                <img src={posterSrc} alt="" draggable={false} className="pointer-events-none h-full w-full rounded-[18px] bg-black object-contain" />
            ) : (
                <div className="h-full w-full rounded-[18px] bg-black" aria-hidden />
            )}
            {!activated ? (
                <button
                    type="button"
                    className="absolute left-1/2 top-1/2 z-20 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-[0_10px_28px_rgba(0,0,0,.35)] backdrop-blur-md transition hover:scale-[1.04] hover:bg-black/65"
                    title={t("canvas.controls.play")}
                    aria-label={t("canvas.controls.play")}
                    onMouseDown={stopShell}
                    onPointerDown={stopShell}
                    onClick={handlePlayClick}
                >
                    <Play className="size-6 translate-x-[1px] fill-current" />
                </button>
            ) : null}
            {activated ? (
                <div
                    data-video-action
                    className="absolute right-2 top-2 z-30 flex items-center gap-1.5"
                    onMouseDown={stopShell}
                    onPointerDown={stopShell}
                    onClick={stopShell}
                >
                    <button
                        type="button"
                        className="grid size-8 place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-[0_6px_18px_rgba(0,0,0,.35)] backdrop-blur-md transition hover:scale-[1.05] hover:bg-black/65"
                        title={t("common.download")}
                        aria-label={t("common.download")}
                        onClick={handleDownload}
                    >
                        <Download className="size-4" />
                    </button>
                    <button
                        type="button"
                        className="grid size-8 place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-[0_6px_18px_rgba(0,0,0,.35)] backdrop-blur-md transition hover:scale-[1.05] hover:bg-black/65"
                        title={t("canvas.controls.fullscreen")}
                        aria-label={t("canvas.controls.fullscreen")}
                        onClick={handleFullscreen}
                    >
                        <Expand className="size-4" />
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function VideoNodeContent({ node, theme, onDeleteBatchImage }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyVideo")}</span>
            </div>
        );
    return (
        <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
            <CanvasLazyMedia>
                <CanvasNodeVideoPlayer src={node.metadata.content} posterSrc={node.metadata?.thumbnailContent} storageKey={node.metadata?.storageKey} />
            </CanvasLazyMedia>
            <button
                type="button"
                className="absolute right-2.5 top-2.5 z-30 grid size-8 place-items-center rounded-full border shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                title={t("common.delete")}
                aria-label={t("common.delete")}
                onClick={(event) => {
                    event.stopPropagation();
                    onDeleteBatchImage?.(node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id || "__primary__");
                }}
            >
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyAudio")}</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{t("canvas.node.audio")}</span>
            </div>
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({
    node,
    batchExpanded,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onViewBatchImage,
    onCancelGeneration,
}: {
    node: CanvasNodeData;
    batchExpanded: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string | string[]) => void;
    onViewBatchImage?: (imageId: string) => void;
    onCancelGeneration?: (nodeId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const isVideo = node.type === CanvasNodeType.Video;
    const images = node.metadata?.images || [];
    const batchCount = images.length;
    const isBatchRoot = batchCount > 1;
    const primaryImageId = node.metadata?.primaryImageId || images[0]?.id;
    const primaryImage = images.find((image) => image.id === primaryImageId);
    const primaryContent = primaryImage?.content || node.metadata?.content;
    const primaryThumb = primaryImage?.thumbnailContent || node.metadata?.thumbnailContent;
    // After refresh, full blob may fail to hydrate while thumb still resolves — prefer any visible source.
    const displaySrc = primaryContent || primaryThumb || "";
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const isGenerating = node.metadata?.status === "loading" || images.some((image) => image.status === "loading");
    const canCancel = Boolean(onCancelGeneration) && isGenerating;

    useEffect(() => {
        if (!batchExpanded) setSelectedIds(new Set());
    }, [batchExpanded]);

    const toggleSelected = (imageId: string) => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(imageId)) next.delete(imageId);
            else next.add(imageId);
            return next;
        });
    };

    const deleteSelected = () => {
        if (!selectedIds.size) return;
        onDeleteBatchImage?.([...selectedIds]);
        setSelectedIds(new Set());
    };

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded
                ? images
                      .filter((image) => image.id !== primaryImageId)
                      .map((image, index) => (
                          <ExpandedImageCard
                              key={image.id}
                              node={node}
                              image={image}
                              index={index}
                              isVideo={isVideo}
                              selected={selectedIds.has(image.id)}
                              onToggleSelect={() => toggleSelected(image.id)}
                              onView={() => onViewBatchImage?.(image.id)}
                              onSetPrimary={() => onSetBatchPrimary?.(image.id)}
                              onDuplicate={() => onDuplicateBatchImage?.(image.id)}
                              onRetry={() => onRetryBatchImage?.(image.id)}
                              onDelete={() => onDeleteBatchImage?.(image.id)}
                              onCancel={onCancelGeneration ? () => onCancelGeneration(node.id) : undefined}
                          />
                      ))
                : null}
            <div className="relative h-full w-full overflow-hidden rounded-3xl">
                {displaySrc ? (
                    isVideo ? (
                        <CanvasLazyMedia>
                            <CanvasNodeVideoPlayer src={displaySrc} posterSrc={primaryThumb} storageKey={primaryImage?.storageKey || node.metadata?.storageKey} />
                        </CanvasLazyMedia>
                    ) : (
                        <>
                            <CanvasLazyMedia>
                                <CanvasDisplayImage
                                    src={displaySrc}
                                    previewSrc={primaryThumb}
                                    storageKey={primaryImage?.storageKey || node.metadata?.storageKey}
                                    previewStorageKey={primaryImage?.thumbnailStorageKey || node.metadata?.thumbnailStorageKey}
                                    alt={node.title}
                                    maxEdge={CANVAS_DISPLAY_MAX_EDGE}
                                    onDragStart={(event) => event.preventDefault()}
                                    className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                                />
                            </CanvasLazyMedia>
                            {(node.metadata?.annotations?.length || 0) > 0 ? (
                                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                                    {node.metadata!.annotations!.map((item) => {
                                        const sw = Math.max(1, item.strokeWidth);
                                        const strokeProps = { stroke: item.stroke, strokeWidth: sw, fill: "none" as const, vectorEffect: "non-scaling-stroke" as const };
                                        if (item.kind === "rect") return <rect key={item.id} x={item.x} y={item.y} width={item.w} height={item.h} {...strokeProps} />;
                                        if (item.kind === "ellipse") return <ellipse key={item.id} cx={item.x + item.w / 2} cy={item.y + item.h / 2} rx={item.w / 2} ry={item.h / 2} {...strokeProps} />;
                                        if (item.kind === "arrow") {
                                            const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
                                            const head = Math.max(0.005, Math.min(0.012, item.strokeWidth * 0.0025));
                                            const lx = item.x2 - head * Math.cos(angle - Math.PI / 6);
                                            const ly = item.y2 - head * Math.sin(angle - Math.PI / 6);
                                            const rx = item.x2 - head * Math.cos(angle + Math.PI / 6);
                                            const ry = item.y2 - head * Math.sin(angle + Math.PI / 6);
                                            return (
                                                <g key={item.id}>
                                                    <line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2} {...strokeProps} />
                                                    <polyline points={`${lx},${ly} ${item.x2},${item.y2} ${rx},${ry}`} {...strokeProps} />
                                                </g>
                                            );
                                        }
                                        return (
                                            <text key={item.id} x={item.x} y={item.y} fill={item.color} fontSize={item.fontSize / 700} fontWeight={600}>
                                                {item.text}
                                            </text>
                                        );
                                    })}
                                </svg>
                            ) : null}
                        </>
                    )
                ) : (
                    <ImageSlotStatus
                        image={
                            primaryImage || {
                                id: "__missing__",
                                status: node.metadata?.status === "loading" ? "loading" : "error",
                                content: "",
                                storageKey: "",
                                naturalWidth: 0,
                                naturalHeight: 0,
                                bytes: 0,
                                mimeType: "",
                                errorDetails: node.metadata?.errorDetails,
                            }
                        }
                        onCancel={canCancel ? () => onCancelGeneration?.(node.id) : undefined}
                    />
                )}
            </div>
            {canCancel && displaySrc ? (
                <button
                    type="button"
                    className="absolute bottom-2.5 left-1/2 z-40 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onCancelGeneration?.(node.id);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Square className="size-3 fill-current" />
                    {t("canvas.node.cancel")}
                </button>
            ) : null}
            {primaryImage?.status === "error" ? <BatchImageFailureActions placement="left" onRetry={() => onRetryBatchImage?.(primaryImage.id)} onDelete={() => onDeleteBatchImage?.(primaryImage.id)} /> : null}
            {displaySrc && primaryImage?.status !== "error" ? (
                <button
                    type="button"
                    className={`absolute z-30 grid size-8 place-items-center rounded-full border shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02] ${isVideo ? "right-2.5 top-2.5" : "bottom-2.5 left-2.5"}`}
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    onClick={(event) => {
                        event.stopPropagation();
                        // Batch slot id when present; otherwise clear the node's sole media payload.
                        onDeleteBatchImage?.(primaryImage?.id || "__primary__");
                    }}
                >
                    <Trash2 className="size-3.5" />
                </button>
            ) : null}
            {batchExpanded && selectedIds.size > 0 ? (
                <button
                    type="button"
                    className="absolute bottom-2.5 left-1/2 z-40 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    onClick={(event) => (event.stopPropagation(), deleteSelected())}
                >
                    <Trash2 className="size-3.5" />
                    {t("canvas.node.deleteSelected", { count: selectedIds.size })}
                </button>
            ) : null}
            {isBatchRoot ? (
                <button
                    type="button"
                    className={`absolute top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02] ${isVideo && displaySrc && primaryImage?.status !== "error" ? "right-12" : "right-2.5"}`}
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.batchExpanded") : t("canvas.node.batchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t(isVideo ? "canvas.controls.videos" : "canvas.controls.images", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedImageCard({
    node,
    image,
    index,
    isVideo,
    selected,
    onToggleSelect,
    onView,
    onSetPrimary,
    onDuplicate,
    onRetry,
    onDelete,
    onCancel,
}: {
    node: CanvasNodeData;
    image: CanvasNodeImage;
    index: number;
    isVideo: boolean;
    selected: boolean;
    onToggleSelect: () => void;
    onView: () => void;
    onSetPrimary: () => void;
    onDuplicate: () => void;
    onRetry: () => void;
    onDelete: () => void;
    onCancel?: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const count = node.metadata?.images?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = column * (node.width + 18);
    const y = (row - rows + 1) * (node.height + 18);

    return (
        <div
            className="absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.18)]"
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: theme.node.panel,
                    borderColor: selected ? selectionBlue : theme.node.stroke,
                    boxShadow: selected ? `0 0 0 2px ${selectionBlue}` : undefined,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                if (!(image.content || image.thumbnailContent) || (event.target instanceof Element && event.target.closest("button"))) return;
                event.stopPropagation();
                onView();
            }}
        >
            {image.content || image.thumbnailContent ? (
                isVideo ? (
                    <CanvasLazyMedia className="h-full w-full">
                        <CanvasNodeVideoPlayer src={image.content || image.thumbnailContent || ""} posterSrc={image.thumbnailContent} storageKey={image.storageKey} />
                    </CanvasLazyMedia>
                ) : (
                    <CanvasLazyMedia className="h-full w-full">
                        <CanvasDisplayImage
                            src={image.content || image.thumbnailContent || ""}
                            previewSrc={image.thumbnailContent}
                            storageKey={image.storageKey}
                            previewStorageKey={image.thumbnailStorageKey}
                            alt={node.title}
                            maxEdge={CANVAS_DISPLAY_MAX_EDGE}
                            className="pointer-events-none h-full w-full select-none object-contain"
                        />
                    </CanvasLazyMedia>
                )
            ) : (
                <ImageSlotStatus image={image} onCancel={onCancel} />
            )}
            {image.content || image.thumbnailContent ? (
                <div className="absolute inset-x-2 top-2 z-30 flex items-center gap-1">
                    <button
                        type="button"
                        className="grid size-8 shrink-0 place-items-center rounded-lg border shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: selected ? selectionBlue : theme.toolbar.panel, borderColor: selected ? selectionBlue : theme.toolbar.border, color: selected ? "#fff" : theme.toolbar.activeText }}
                        title={t("canvas.node.selectVersion")}
                        aria-label={t("canvas.node.selectVersion")}
                        onClick={(event) => (event.stopPropagation(), onToggleSelect())}
                    >
                        <span className="text-sm font-bold leading-none">{selected ? "✓" : ""}</span>
                    </button>
                    <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("canvas.node.createCopy")}
                        onClick={(event) => (event.stopPropagation(), onDuplicate())}
                    >
                        <Copy className="size-3 shrink-0" />
                        <span className="truncate">{t("canvas.node.createCopy")}</span>
                    </button>
                    <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t(isVideo ? "canvas.node.setPrimaryVideo" : "canvas.node.setPrimary")}
                        onClick={(event) => (event.stopPropagation(), onSetPrimary())}
                    >
                        <Star className="size-3 shrink-0" style={{ color: selectionBlue }} />
                        <span className="truncate">{t(isVideo ? "canvas.node.setPrimaryVideo" : "canvas.node.setPrimary")}</span>
                    </button>
                    <button
                        type="button"
                        className="grid size-8 shrink-0 place-items-center rounded-lg border shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                        onClick={(event) => (event.stopPropagation(), onDelete())}
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ) : null}
            {image.status === "error" ? <BatchImageFailureActions placement="right" onRetry={onRetry} onDelete={onDelete} /> : null}
        </div>
    );
}

function BatchImageFailureActions({ placement, onRetry, onDelete }: { placement: "left" | "right"; onRetry: () => void; onDelete: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    return (
        <div className={`absolute top-3 z-30 flex items-center gap-1.5 ${placement === "left" ? "left-3" : "right-3"}`}>
            <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => (event.stopPropagation(), onRetry())}
            >
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
            <button
                type="button"
                className="grid size-8 place-items-center rounded-lg border shadow-sm transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => (event.stopPropagation(), onDelete())}
                aria-label={t("common.delete")}
                title={t("common.delete")}
            >
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}

function ImageSlotStatus({ image, onCancel }: { image?: CanvasNodeImage; onCancel?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const isLoading = image?.status === "loading";
    const failed = image?.status === "error" || (!isLoading && !image?.content && !image?.thumbnailContent);
    const message = failed
        ? image?.errorDetails || (image?.status === "error" ? t("canvas.node.failed") : t("canvas.generation.mediaMissing"))
        : t("canvas.node.generating");
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? (
                <span className="text-xs leading-5">{message}</span>
            ) : (
                <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            )}
            {!failed ? <span className="text-[10px] tracking-[0.2em]">{message}</span> : null}
            {isLoading && onCancel ? (
                <button
                    type="button"
                    className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onCancel();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Square className="size-3 fill-current" />
                    {t("canvas.node.cancel")}
                </button>
            ) : null}
        </div>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

function BatchFrame({ batchCount, batchExpanded, children }: { batchCount: number; batchExpanded: boolean; children: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div className="group/batch relative h-full w-full overflow-visible">
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 3) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_10px_24px_rgba(68,64,60,.12)] transition-all duration-300 group-hover/batch:translate-x-1"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded ? 0 : 1,
                                transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}
