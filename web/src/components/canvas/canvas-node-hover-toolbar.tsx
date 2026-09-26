import { useEffect, useMemo, useState, type ReactNode } from "react";
import { App, Modal, Segmented, Tooltip } from "antd";
import { Clapperboard, Combine, Download, Ellipsis, FolderPlus, Highlighter, Image as ImageIcon, Info, MessageSquare, MessageSquareText, Minus, Music2, Plus, RefreshCw, Scissors, Settings2, Trash2, Type, Upload, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { useCopyText } from "@/hooks/use-copy-text";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import { ImageToolSettingsModal, type ImageToolbarSettingsTool } from "./canvas-image-toolbar-settings-modal";
import { buildImageToolbarTools, defaultImageQuickToolIds, mergeMissingDefaultVisibleTools, normalizeImageQuickToolIds, type ImageQuickToolId } from "./canvas-image-toolbar-tools";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onInfo: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onToggleDialog: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onCreateChat: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onAnnotate: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onPanorama: (node: CanvasNodeData) => void;
    onAdjust: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onScale: (node: CanvasNodeData) => void;
    onResetSize: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
    onOpenVideoTools?: (node: CanvasNodeData) => void;
    onOpenAudioTools?: (node: CanvasNodeData) => void;
    onOpenAudioMerge?: () => void;
};

type ToolbarTool = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    onKeep,
    onLeave,
    onInfo,
    onDecreaseFont,
    onIncreaseFont,
    onToggleDialog,
    onGenerateImage,
    onCreateChat,
    onEditText,
    onUpload,
    onDownload,
    onSaveAsset,
    onMaskEdit,
    onAnnotate,
    onCrop,
    onSplit,
    onUpscale,
    onSuperResolve,
    onAngle,
    onPanorama,
    onAdjust,
    onViewImage,
    onReversePrompt,
    onRetry,
    onToggleFreeResize,
    onScale,
    onResetSize,
    onDelete,
    onOpenVideoTools,
    onOpenAudioTools,
    onOpenAudioMerge,
}: CanvasNodeHoverToolbarProps) {
    const imageQuickTools = useConfigStore((state) => state.config.imageQuickTools);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const quickImageToolIds = useMemo(() => {
        const normalized = normalizeImageQuickToolIds(imageQuickTools?.ids || []);
        return mergeMissingDefaultVisibleTools(normalized.length ? normalized : defaultImageQuickToolIds);
    }, [imageQuickTools?.ids]);
    const showImageToolLabels = Boolean(imageQuickTools?.showLabels);
    const [draftImageToolIds, setDraftImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [draftShowImageToolLabels, setDraftShowImageToolLabels] = useState(false);
    const [imageToolSettingsOpen, setImageToolSettingsOpen] = useState(false);
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();

    useEffect(() => {
        setImageToolSettingsOpen(false);
    }, [node?.id]);

    if (!node) return null;

    const activeNode = node;
    const left = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const top = viewport.y + node.position.y * viewport.k - 9;
    const isImage = node.type === CanvasNodeType.Image;
    const isAnnotate = node.type === CanvasNodeType.Annotate;
    const isVideo = node.type === CanvasNodeType.Video;
    const isAudio = node.type === CanvasNodeType.Audio;
    const hasImage = (isImage || isAnnotate) && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const hasAudio = isAudio && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text;
    const isChat = node.type === CanvasNodeType.Chat;
    const isConfig = node.type === CanvasNodeType.Config;
    const canRetry = node.metadata?.status === "error";
    const quickImageToolIdSet = new Set(quickImageToolIds);
    const copyImagePrompt = (target: CanvasNodeData) => {
        const prompt = target.metadata?.prompt?.trim();
        if (!prompt) {
            message.warning(t("canvas.nodeToolbar.noPrompt"));
            return;
        }
        copyText(prompt, t("common.promptCopied"));
    };
    const imageTools = buildImageToolbarTools(node, { onUpload, onToggleFreeResize, onScale, onResetSize, onMaskEdit, onAnnotate, onCrop, onSplit, onUpscale, onSuperResolve, onAngle, onPanorama, onAdjust, onViewImage, onCopyPrompt: copyImagePrompt, onReversePrompt });

    function openImageToolSettings() {
        onKeep(activeNode.id);
        setDraftImageToolIds(quickImageToolIds);
        setDraftShowImageToolLabels(showImageToolLabels);
        setImageToolSettingsOpen(true);
    }

    const baseToolbarTools: ToolbarTool[] = [
        { id: "info", title: t("canvas.nodeToolbar.infoTitle"), label: t("canvas.nodeToolbar.info"), icon: <Info className="size-[10px]" />, onClick: () => onInfo(node) },
        { id: "delete", title: t("canvas.nodeToolbar.removeTitle"), label: t("common.delete"), icon: <Trash2 className="size-[10px]" />, onClick: () => onDelete(node), danger: true },
    ];
    const nodeToolbarTools: ToolbarTool[] = [
        ...(canRetry ? [{ id: "retry", title: t("canvas.nodeToolbar.retryTitle"), label: t("canvas.node.retry"), icon: <RefreshCw className="size-[10px]" />, onClick: () => onRetry(node) }] : []),
        ...(hasImage || hasVideo || isText ? [{ id: "saveAsset", title: t("common.addToAssets"), label: t("canvas.nodeToolbar.saveAsset"), icon: <FolderPlus className="size-[10px]" />, onClick: () => onSaveAsset(node) }] : []),
        ...(hasImage || hasVideo || hasAudio ? [{ id: "download", title: t(hasAudio ? "canvas.nodeToolbar.downloadAudio" : hasVideo ? "canvas.nodeToolbar.downloadVideo" : "canvas.nodeToolbar.downloadImage"), label: t("common.download"), icon: <Download className="size-[10px]" />, onClick: () => onDownload(node) }] : []),
        ...(isText ? [{ id: "exportDocument", title: t("canvas.nodeToolbar.exportDocumentTitle"), label: t("canvas.nodeToolbar.exportDocument"), icon: <Download className="size-[10px]" />, onClick: () => onDownload(node) }] : []),
        ...(isVideo ? [{ id: "edit", title: t("common.edit"), label: t("common.edit"), icon: <MessageSquare className="size-[10px]" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isText ? [{ id: "editText", title: t("canvas.nodeToolbar.editTextTitle"), label: t("canvas.nodeToolbar.editText"), icon: <Type className="size-[10px]" />, onClick: () => onEditText(node) }] : []),
        ...(isText ? [{ id: "createChat", title: t("canvas.node.createChatTitle"), label: t("canvas.node.createChat"), icon: <MessageSquareText className="size-[10px]" />, onClick: () => onCreateChat(node) }] : []),
        ...(isText ? [{ id: "generateImage", title: t("canvas.node.generateImage"), label: t("canvas.node.generate"), icon: <ImageIcon className="size-[10px]" />, onClick: () => onGenerateImage(node) }] : []),
        ...(isConfig ? [{ id: "config", title: t("canvas.configNode.title"), label: t("canvas.configNode.title"), icon: <Settings2 className="size-[10px]" />, onClick: () => onToggleDialog(node) }] : []),
        ...(node.type === CanvasNodeType.Director ? [{ id: "director", title: t("canvas.director.title"), label: t("canvas.director.title"), icon: <Clapperboard className="size-[10px]" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isAnnotate && hasImage ? [{ id: "annotate", title: t("canvas.annotate.openTitle"), label: t("canvas.annotate.open"), icon: <Highlighter className="size-[10px]" />, onClick: () => onAnnotate(node) }] : []),
        ...(isText || isChat ? [{ id: "decreaseFont", title: t("canvas.nodeToolbar.decreaseFont"), label: t("canvas.nodeToolbar.zoomOut"), icon: <Minus className="size-[10px]" />, onClick: () => onDecreaseFont(node) }] : []),
        ...(isText || isChat ? [{ id: "increaseFont", title: t("canvas.nodeToolbar.increaseFont"), label: t("canvas.nodeToolbar.zoomIn"), icon: <Plus className="size-[10px]" />, onClick: () => onIncreaseFont(node) }] : []),
        ...((isImage || isAnnotate) && !hasImage ? [{ id: "uploadImage", title: t("canvas.nodeToolbar.uploadImage"), label: t("canvas.nodeToolbar.uploadImage"), icon: <Upload className="size-[10px]" />, onClick: () => onUpload(node) }] : []),
        ...(isAnnotate && hasImage ? [{ id: "replaceImage", title: t("canvas.editors.annotateReplace"), label: t("canvas.editors.annotateReplace"), icon: <Upload className="size-[10px]" />, onClick: () => onUpload(node) }] : []),
        ...(isVideo ? [{ id: "uploadVideo", title: t(hasVideo ? "canvas.nodeToolbar.replaceVideo" : "canvas.nodeToolbar.uploadVideo"), label: t(hasVideo ? "canvas.nodeToolbar.replaceVideo" : "canvas.nodeToolbar.uploadVideo"), icon: <Video className="size-[10px]" />, onClick: () => onUpload(node) }] : []),
        ...(hasVideo && onOpenVideoTools ? [{ id: "videoTools", title: t("canvas.videoTools.openTitle"), label: t("canvas.videoTools.open"), icon: <Scissors className="size-[10px]" />, onClick: () => onOpenVideoTools(node) }] : []),
        ...(isAudio ? [{ id: "uploadAudio", title: t(hasAudio ? "canvas.nodeToolbar.replaceAudio" : "canvas.nodeToolbar.uploadAudio"), label: t(hasAudio ? "canvas.nodeToolbar.replaceAudio" : "canvas.nodeToolbar.uploadAudio"), icon: <Music2 className="size-[10px]" />, onClick: () => onUpload(node) }] : []),
        ...(hasAudio && onOpenAudioTools ? [{ id: "audioTools", title: t("canvas.audioTools.openTitle"), label: t("canvas.audioTools.open"), icon: <Scissors className="size-[10px]" />, onClick: () => onOpenAudioTools(node) }] : []),
        ...(isAudio && onOpenAudioMerge ? [{ id: "audioMerge", title: t("canvas.audioMerge.openTitle"), label: t("canvas.audioMerge.open"), icon: <Combine className="size-[10px]" />, onClick: () => onOpenAudioMerge() }] : []),
        ...(hasImage && isImage ? imageTools.map((tool) => ({ id: tool.id, title: tool.title, label: tool.label, icon: tool.icon, active: tool.active, onClick: tool.onClick })) : []),
    ];
    // Keep deletion available even when an older saved quick-tool configuration hid it.
    const toolbarTools = (() => {
        const tools = hasImage && isImage ? [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => tool.id === "delete" || quickImageToolIdSet.has(tool.id as ImageQuickToolId)) : [...baseToolbarTools, ...nodeToolbarTools];
        if (!(hasImage && isImage)) return tools;
        const order = new Map(quickImageToolIds.map((id, index) => [id, index]));
        return [...tools].sort((a, b) => {
            const ai = order.has(a.id as ImageQuickToolId) ? order.get(a.id as ImageQuickToolId)! : Number.MAX_SAFE_INTEGER - (a.id === "delete" ? 0 : 1);
            const bi = order.has(b.id as ImageQuickToolId) ? order.get(b.id as ImageQuickToolId)! : Number.MAX_SAFE_INTEGER - (b.id === "delete" ? 0 : 1);
            return ai - bi;
        });
    })();
    const selectableImageToolbarTools = [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => tool.id !== "retry") as ImageToolbarSettingsTool[];

    const closeImageToolSettings = () => {
        setImageToolSettingsOpen(false);
        onLeave();
    };

    const setDraftImageToolVisible = (id: ImageQuickToolId, visible: boolean) => {
        setDraftImageToolIds((current) => {
            const selected = new Set(current);
            if (visible) selected.add(id);
            else selected.delete(id);
            return selectableImageToolbarTools.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
        });
    };

    const saveImageToolSettings = () => {
        updateConfig("imageQuickTools", { ids: draftImageToolIds, showLabels: draftShowImageToolLabels });
        closeImageToolSettings();
    };

    return (
        <>
            <div
                className={`absolute z-[70] flex -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[12px] border border-white/15 bg-neutral-700/55 text-white/90 shadow-[0_4px_14px_rgba(15,23,42,.18)] backdrop-blur-md ${
                    isChat ? "h-10 rounded-2xl text-base" : "h-[31px] text-[10px]"
                }`}
                style={{ left, top }}
                onMouseEnter={() => onKeep(node.id)}
                onMouseLeave={() => {
                    if (!imageToolSettingsOpen) onLeave();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                {toolbarTools.map((tool) => (
                    <ToolbarAction key={tool.id} {...tool} showLabel={isImage ? showImageToolLabels : true} large={isChat} />
                ))}
                {hasImage && isImage ? <ToolbarAction id="more" title={t("canvas.imageTools.configure")} label={t("canvas.imageTools.more")} icon={<Ellipsis className="size-[10px]" />} active={imageToolSettingsOpen} onClick={openImageToolSettings} showLabel={showImageToolLabels} /> : null}
            </div>
            {hasImage && isImage ? (
                <ImageToolSettingsModal
                    open={imageToolSettingsOpen}
                    tools={selectableImageToolbarTools}
                    selectedIds={draftImageToolIds}
                    showLabels={draftShowImageToolLabels}
                    onToggle={setDraftImageToolVisible}
                    onShowLabelsChange={setDraftShowImageToolLabels}
                    onCancel={closeImageToolSettings}
                    onSave={saveImageToolSettings}
                />
            ) : null}
        </>
    );
}

export function CanvasNodeInfoModal({ node, open, onClose }: { node: CanvasNodeData | null; open: boolean; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const [view, setView] = useState<"info" | "json">("info");
    const imageBytes = node?.type === CanvasNodeType.Image && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const batchCount = node?.type === CanvasNodeType.Image ? node.metadata?.images?.length || 0 : 0;
    const json = useMemo(() => {
        if (!node) return "";
        return JSON.stringify(
            node,
            (key, value) => {
                if (key === "content" && typeof value === "string" && value.startsWith("data:image/")) {
                    return "[base64 image]";
                }
                return value;
            },
            2,
        );
    }, [node]);

    useEffect(() => {
        if (open) setView("info");
    }, [node?.id, open]);

    const title = (
        <div className="flex items-center justify-between gap-4 pr-12">
            <span>{t("canvas.nodeToolbar.nodeInfo")}</span>
            <Segmented
                size="small"
                value={view}
                onChange={(value) => setView(value as "info" | "json")}
                options={[
                    { label: t("canvas.nodeToolbar.info"), value: "info" },
                    { label: "JSON", value: "json" },
                ]}
            />
        </div>
    );

    return (
        <Modal className="canvas-node-info-modal" title={title} open={open && Boolean(node)} centered footer={null} onCancel={onClose}>
            {node ? (
                <div className="h-[56vh] min-h-[360px] select-text text-sm" data-canvas-shortcuts-ignore>
                    {view === "info" ? (
                        <div className="thin-scrollbar h-full space-y-3 overflow-auto pr-1">
                            <InfoRow label="ID" value={node.id} />
                            <InfoRow label={t("canvas.nodeToolbar.name")} value={node.title || t("canvas.node.untitled")} />
                            <InfoRow label={t("canvas.nodeToolbar.type")} value={node.type === CanvasNodeType.Group ? t("canvas.node.group") : node.type === CanvasNodeType.Config ? t("canvas.configNode.title") : [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(node.type as CanvasNodeType) ? t(`assets.kinds.${node.type}`) : getNodeDefinition(node.type)?.title || node.type} />
                            <InfoRow label={t("canvas.nodeToolbar.size")} value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                            <InfoRow label={t("canvas.nodeToolbar.position")} value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                            <InfoRow label={t("canvas.nodeToolbar.status")} value={node.metadata?.status || "idle"} />
                            {batchCount > 1 ? <InfoRow label={t("canvas.nodeToolbar.imageGroup")} value={t("canvas.configNode.images", { count: batchCount })} /> : null}
                            {node.metadata?.prompt ? <InfoRow label={t("canvas.configNode.prompt")} value={node.metadata.prompt} /> : null}
                            {imageBytes ? <InfoRow label={t("canvas.nodeToolbar.imageSize")} value={formatBytes(imageBytes)} /> : null}
                            {node.metadata?.errorDetails ? (
                                <div className="rounded-lg border p-3 text-red-400" style={{ borderColor: theme.node.stroke }}>
                                    {node.metadata.errorDetails}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <pre className="thin-scrollbar h-full overflow-auto rounded-lg border p-3 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}>
                            {json}
                        </pre>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}

function ToolbarAction({ title, label, icon, onClick, showLabel, active = false, danger = false, large = false }: ToolbarTool & { showLabel: boolean; large?: boolean }) {
    const hasText = showLabel && Boolean(label);
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2} color="rgba(64,64,64,.92)" styles={{ root: { color: "#f5f5f5", boxShadow: "0 4px 12px rgba(15,23,42,.2)", fontSize: large ? 16 : 14, fontWeight: 500 } }}>
            <button type="button" className={`group relative flex items-center whitespace-nowrap px-[3px] ${large ? "h-10" : "h-[31px]"} ${danger ? "text-[#f87171]" : ""}`} onClick={onClick} aria-label={title}>
                <span className={`flex items-center ${large ? "h-8" : "h-[23px]"} ${hasText ? (large ? "gap-2 px-2.5" : "gap-1.5 px-2") : large ? "justify-center px-2" : "justify-center px-1.5"} rounded-md transition group-hover:bg-white/15 ${active ? "bg-white/20" : ""}`}>
                    {icon}
                    {hasText ? <span>{label}</span> : null}
                </span>
            </button>
        </Tooltip>
    );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </div>
    );
}
