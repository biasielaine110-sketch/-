import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { isMidjourneyModel, requestEdit, requestGeneration, requestImageQuestion, requestMidjourneyUpscale, type AiTextMessage, type GeneratedImageResult } from "@/services/api/image";
import { chatSkillsSystemHint, executeChatSkillTool, resolveChatSkillIds, resolveChatSkillTools } from "@/lib/chat-skills";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, requestVideoUpscale, storeGeneratedVideo, uploadProviderMediaFile } from "@/services/api/video";
import { defaultConfig, modelOptionLabel, resolveModelForCapability, resolveModelRequestConfig, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { parseComfyApiWorkflow, resolveNativeH3VideoSettingDefaults, shouldUseNativeComfyUi } from "@/lib/comfyui-native";
import {
    cancelNativeVideoQueueJobsForNodes,
    enqueueNativeComfyVideoJob,
    getNativeVideoQueueSnapshot,
    pickNativeVideoQueueEntryForNode,
    subscribeNativeVideoQueue,
} from "@/lib/canvas/native-video-job-queue";
import { uploadImage, imageToDataUrl } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { subscribeLocalMediaLibraryAccess } from "@/services/local-media-library";
import { nanoid } from "nanoid";
import { captureVideoFrameDataUrl, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, mergeDataUrls, resizeDataUrlByPercent, splitDataUrl, upscaleDataUrl, adjustDataUrl, type ImageAdjustParams } from "@/lib/canvas/canvas-image-data";
import { loadVideoBlob } from "@/lib/canvas/canvas-video-tools";
import { fitNodeSize, nodeSizeFromRatio, sizeFromDisplayScalePercent } from "@/lib/canvas/canvas-node-size";
import { App, Button, Modal } from "antd";
import { DEFAULT_CANVAS_FONT_SIZE, NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { buildStylePromptText, getStyleTemplate, mergeStyleAndCameraPrompt } from "@/constant/style-templates";
import { buildCameraSelectionPrompt } from "@/constant/camera-options";
import { addScriptNameLockForCell, blankPreciseAssetColumns, buildMergedVideoNodePrompt, buildStoryScriptRowTask, buildStoryScriptTask, buildVideoNodePrompt, getStoryScriptPreset, groupStoryScriptRows, matchStoryScriptRowAssets, parseStoryScriptOutput, resolveScriptAssetRole, resolveScriptSystemPrompt, resolveStoryScriptPresetId, scriptAssetColumnRole, scriptCellAssetIds, scriptRowAssetIds, scriptShotPreciseAssetRefs, setStoryScriptCellAssetIds, setStoryScriptNameLock, setStoryScriptRowAssetIds, storyScriptGroupDuration, storyScriptToMarkdown, stripStoryScriptAssetId, syncStoryScriptNameLocks, type ScriptAssetRole } from "@/constant/story-script";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import type { ImageToolHandlers } from "@/components/canvas/canvas-image-toolbar-tools";
import { useCopyText } from "@/hooks/use-copy-text";
import { saveBlobAs } from "@/lib/fs/save-blob";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodePanoramaDialog, type PanoramaCapturePayload } from "@/components/canvas/canvas-node-panorama-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeAnnotateDialog, type CanvasAnnotateInpaintPayload, type CanvasAnnotateSavePayload } from "@/components/canvas/canvas-node-annotate-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasMergeNodeContent } from "@/components/canvas/canvas-merge-node-content";
import { CanvasScriptNodeContent, type ScriptAssetCandidate, type ScriptAssetLinkSelection, type ScriptGenAction } from "@/components/canvas/canvas-script-node-content";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { CanvasNodeMjUpscaleDialog } from "@/components/canvas/canvas-node-mj-upscale-dialog";
import { CanvasNodeScaleDialog } from "@/components/canvas/canvas-node-scale-dialog";
import { CanvasNodeAdjustDialog } from "@/components/canvas/canvas-node-adjust-dialog";
import { CanvasNodeVideoToolsDialog, type VideoToolsFrameResult, type VideoToolsTrimResult, type VideoToolsUpscaleResult } from "@/components/canvas/canvas-node-video-tools-dialog";
import { CanvasNodeAudioToolsDialog, type AudioToolsTrimResult } from "@/components/canvas/canvas-node-audio-tools-dialog";
import { CanvasNodeAudioMergeDialog, type AudioMergeCandidate } from "@/components/canvas/canvas-node-audio-merge-dialog";
import { CanvasImagePreviewModal } from "@/components/canvas/canvas-image-preview-modal";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { AtelierCanvas } from "@/components/canvas/atelier-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode, getCanvasMediaToggle } from "@/components/canvas/canvas-node";
import { CanvasDraftSaveDialog } from "@/components/canvas/canvas-draft-save-dialog";
import { CanvasTextEditDialog } from "@/components/canvas/canvas-text-edit-dialog";
import { CanvasTextClipboardMenu, blurActiveCanvasTextInput, isCanvasTextInteractionTarget } from "@/components/canvas/canvas-text-clipboard-menu";
import { isImeComposing } from "@/lib/keyboard-event";
import {
    getCanvasDraftMeta,
    overwriteCanvasDraft,
    pickCanvasDraftDirectory,
    pickCanvasDraftFile,
    safeDraftFileName,
    saveCanvasDraftFallbackDownload,
    saveCanvasDraftToDirectory,
    saveCanvasDraftToHandle,
    supportsDirectoryPicker,
    supportsFileSystemAccess,
    type CanvasDraftMeta,
} from "@/lib/canvas/canvas-draft";
import { startCanvasWorkbuddyBridge } from "@/lib/canvas/canvas-workbuddy-bridge";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { DirectorPanel } from "@/components/canvas/director-panel";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useGenerationHistoryStore, type GenerationHistoryImage } from "@/stores/canvas/use-generation-history-store";
import { buildNodeMentionReferences, resolveCanvasReferenceImages, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { ChatSendOptions } from "@/lib/canvas/canvas-chat-helpers";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, canvasNodeImageFromUpload, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, getGroupMemberNodes, normalizeConnection, resolveConnectionPairs, canConnectNodes, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    applyHydratedMedia,
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    hydrateCanvasMediaDeferred,
    backfillCanvasImageThumbnails,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    videoExtension,
} from "@/lib/canvas/canvas-generation-helpers";
import { buildDocxBlob, buildMarkdownBlob, isDocumentFile, readDocumentAsText, type TextExportFormat } from "@/lib/canvas/document-text";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType } from "@/lib/canvas/node-registry";
import { convertNodeType, convertedNodeKeptMedia, nodeConversionTarget } from "@/lib/canvas/node-type-conversion";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasMediaLibraryNotice } from "@/components/canvas/canvas-media-library-notice";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAnnotation,
    type CanvasAssistantImage,
    type CanvasAssistantMessage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    /** Unique per submit — allows several native-video jobs to stay tracked without aborting peers. */
    jobId: string;
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_ANNOTATIONS: CanvasAnnotation[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
/** Soft cap so same-panel re-generations do not grow without bound. */
const MAX_IMAGE_NODE_HISTORY = 24;

/** Remap edges for copied nodes, keeping links to uncopied neighbors (AâB becomes A'âB). */
function cloneConnectionsForCopiedNodes(connections: CanvasConnection[], idMap: Map<string, string>, stamp = Date.now()): CanvasConnection[] {
    if (!idMap.size) return [];
    const seen = new Set<string>();
    const next: CanvasConnection[] = [];
    connections.forEach((connection, index) => {
        const fromCopied = idMap.has(connection.fromNodeId);
        const toCopied = idMap.has(connection.toNodeId);
        if (!fromCopied && !toCopied) return;
        const fromNodeId = idMap.get(connection.fromNodeId) ?? connection.fromNodeId;
        const toNodeId = idMap.get(connection.toNodeId) ?? connection.toNodeId;
        if (fromNodeId === toNodeId) return;
        const key = `${fromNodeId}\0${toNodeId}`;
        if (seen.has(key)) return;
        seen.add(key);
        next.push({
            id: `conn-${stamp}-${index}-${Math.random().toString(36).slice(2, 7)}`,
            fromNodeId,
            toNodeId,
        });
    });
    return next;
}

function collectSuccessfulImageHistory(node: CanvasNodeData | undefined): CanvasNodeImage[] {
    if (!node) return [];
    const listed = (node.metadata?.images || []).filter((image) => Boolean(image.content) && image.status !== NODE_STATUS_LOADING);
    if (listed.length) return listed;
    if (!node.metadata?.content) return [];
    return [
        {
            id: node.metadata.primaryImageId || `legacy-${node.id}`,
            status: NODE_STATUS_SUCCESS,
            content: node.metadata.content,
            storageKey: node.metadata.storageKey || "",
            naturalWidth: node.metadata.naturalWidth || 0,
            naturalHeight: node.metadata.naturalHeight || 0,
            bytes: node.metadata.bytes || 0,
            mimeType: node.metadata.mimeType || "",
        },
    ];
}

/** Resolve original media pixel size from primary image / metadata / cached DOM image. */
function resolveNodeMediaNaturalSize(node: CanvasNodeData): { width: number; height: number } | null {
    const primary = node.metadata?.images?.find((image) => image.id === node.metadata?.primaryImageId) || node.metadata?.images?.[0];
    const content = primary?.content || node.metadata?.content || node.metadata?.thumbnailContent || "";
    let width = Number(primary?.naturalWidth || node.metadata?.naturalWidth || 0);
    let height = Number(primary?.naturalHeight || node.metadata?.naturalHeight || 0);

    if ((!width || !height) && content) {
        try {
            const probe = new Image();
            probe.src = content;
            if (probe.complete && probe.naturalWidth > 0 && probe.naturalHeight > 0) {
                width = probe.naturalWidth;
                height = probe.naturalHeight;
            }
        } catch {
            // Ignore probe failures; fall through.
        }
    }

    // Last resort: keep current frame aspect so free-resize / corner-scale can still snap back to a fit box.
    if ((!width || !height) && node.width > 0 && node.height > 0) {
        width = node.width;
        height = node.height;
    }

    if (!(width > 0 && height > 0)) return null;
    return { width, height };
}

function defaultFitSizeForNode(node: CanvasNodeData, natural: { width: number; height: number }) {
    if (node.type === CanvasNodeType.Video) {
        return fitNodeSize(natural.width, natural.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
    }
    return sizeFromDisplayScalePercent(natural.width, natural.height, 100);
}

/** Browsers often only accept image/png in ClipboardItem — re-encode other formats. */
async function ensureClipboardImageBlob(blob: Blob) {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
        bitmap.close();
        return new Blob([blob], { type: "image/png" });
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return png || new Blob([blob], { type: "image/png" });
}

async function uploadGeneratedImage(image: Pick<GeneratedImageResult, "dataUrl" | "fallbackUrls">) {
    const candidates = [...new Set([image.dataUrl, ...(image.fallbackUrls || [])].filter(Boolean))];
    let lastError: unknown;
    for (const candidate of candidates) {
        try {
            return await uploadImage(candidate);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Image could not be loaded");
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <AtelierCanvasPage />;
}

function AtelierCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const projectId = params.id || "";
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        isAltCopyDrag: boolean;
        copySpawned: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        isAltCopyDrag: false,
        copySpawned: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    /** Bumped whenever generationRequestsRef changes so isNodeGenerating can re-render. */
    const [generationEpoch, setGenerationEpoch] = useState(0);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    /** Nodes whose generation panel the user dismissed by clicking empty canvas space while they were generating. */
    const [dismissedGeneratingNodeIds, setDismissedGeneratingNodeIds] = useState<Set<string>>(new Set());
    const directorPanelNode = nodes.find((node) => node.id === dialogNodeId && node.type === CanvasNodeType.Director);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [annotateNodeId, setAnnotateNodeId] = useState<string | null>(null);
    const [textEditNodeId, setTextEditNodeId] = useState<string | null>(null);
    const [draftDialogOpen, setDraftDialogOpen] = useState(false);
    const [draftSaving, setDraftSaving] = useState(false);
    const [draftMeta, setDraftMeta] = useState<CanvasDraftMeta | null>(null);
    const [draftPickerHandle, setDraftPickerHandle] = useState<FileSystemFileHandle | null>(null);
    const [draftPickerDirectory, setDraftPickerDirectory] = useState<FileSystemDirectoryHandle | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [mjUpscaleNodeId, setMjUpscaleNodeId] = useState<string | null>(null);
    const [scaleNodeId, setScaleNodeId] = useState<string | null>(null);
    const [adjustNodeId, setAdjustNodeId] = useState<string | null>(null);
    const [videoToolsNodeId, setVideoToolsNodeId] = useState<string | null>(null);
    const [audioToolsNodeId, setAudioToolsNodeId] = useState<string | null>(null);
    const [audioMergeOpen, setAudioMergeOpen] = useState(false);
    const [audioMergeSelected, setAudioMergeSelected] = useState<string[]>([]);
    const [audioMergePicking, setAudioMergePicking] = useState(false);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [panoramaNodeId, setPanoramaNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedImageNodeIds, setExpandedImageNodeIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [dragPreview, setDragPreview] = useState<{ dx: number; dy: number; ids: string[] } | null>(null);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const chatSessionsRef = useRef(chatSessions);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const hoveredNodeIdRef = useRef(hoveredNodeId);
    const toolbarNodeIdRef = useRef(toolbarNodeId);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const audioMergePickingRef = useRef(false);
    const audioMergeSelectedRef = useRef<string[]>([]);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    /** Keyed by jobId (not targetNodeId) so queued native-video submits do not abort the running job. */
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    /** True when this video config hits a native ComfyUI / H3 graph (must be serialized). */
    const isNativeComfyVideoConfig = useCallback((config: AiConfig) => {
        const model = config.model || config.videoModel || "";
        const request = resolveModelRequestConfig(config, model);
        const script = resolveModelScript(config, model);
        return shouldUseNativeComfyUi(request.baseUrl, model, script) || Boolean(parseComfyApiWorkflow(script));
    }, []);
    const mouseWorldRef = useRef<Position | null>(null);
    const draftMetaRef = useRef<CanvasDraftMeta | null>(null);
    const draftSavingRef = useRef(false);
    const DRAFT_AUTO_SAVE_MS = 10 * 60 * 1000;

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback(
        (
            targetNodeId: string,
            originNodeId: string,
            runningId = originNodeId,
            controller = new AbortController(),
            options?: { replaceTarget?: boolean },
        ) => {
            // Default replaceTarget=true keeps prior behaviour (re-generate aborts the same target).
            // Native H3 video FIFO passes replaceTarget=false so queueing the next clip does not
            // abort()/interrupt the job that is still running on the pod.
            const replaceTarget = options?.replaceTarget !== false;
            if (replaceTarget) {
                for (const [jobId, request] of [...generationRequestsRef.current]) {
                    if (request.targetNodeId === targetNodeId && request.controller !== controller) {
                        request.controller.abort();
                        generationRequestsRef.current.delete(jobId);
                    }
                }
            }
            const jobId = nanoid(10);
            generationRequestsRef.current.set(jobId, {
                jobId,
                targetNodeId,
                originNodeId,
                runningNodeId: runningId,
                controller,
            });
            setGenerationEpoch((value) => value + 1);
            return controller;
        },
        [],
    );

    const finishGenerationRequest = useCallback((_targetNodeId: string, controller: AbortController) => {
        for (const [jobId, request] of [...generationRequestsRef.current]) {
            if (request.controller === controller) {
                generationRequestsRef.current.delete(jobId);
                setGenerationEpoch((value) => value + 1);
                return;
            }
        }
    }, []);

    const stopGenerationForNode = useCallback(
        (nodeId: string) => {
            const affectedNodeIds = new Set<string>([nodeId]);
            const runningIdsToClear = new Set<string>();
            for (const [jobId, request] of [...generationRequestsRef.current]) {
                if (request.runningNodeId !== nodeId && request.originNodeId !== nodeId && request.targetNodeId !== nodeId) continue;
                request.controller.abort();
                generationRequestsRef.current.delete(jobId);
                affectedNodeIds.add(request.targetNodeId);
                affectedNodeIds.add(request.originNodeId);
                runningIdsToClear.add(request.runningNodeId);
            }
            // Drop FIFO entries immediately so remaining badges re-number (2/3 → 1/2).
            cancelNativeVideoQueueJobsForNodes(affectedNodeIds);
            setRunningNodeId((current) => (current && (current === nodeId || runningIdsToClear.has(current) || affectedNodeIds.has(current)) ? null : current));
            setGenerationEpoch((value) => value + 1);
            setNodes((prev) =>
                prev.map((node) =>
                    affectedNodeIds.has(node.id) &&
                    (node.metadata?.status === NODE_STATUS_LOADING ||
                        node.metadata?.images?.some((image) => image.status === NODE_STATUS_LOADING) ||
                        node.metadata?.nativeVideoQueuePosition != null)
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: node.metadata?.status === NODE_STATUS_LOADING ? NODE_STATUS_IDLE : node.metadata?.status,
                                  errorDetails: undefined,
                                  nativeVideoQueuePosition: undefined,
                                  nativeVideoQueueTotal: undefined,
                                  nativeVideoQueuePhase: undefined,
                                  images: node.metadata.images?.map((image) =>
                                      image.status === NODE_STATUS_LOADING
                                          ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") }
                                          : image,
                                  ),
                              },
                          }
                        : node,
                ),
            );
        },
        [t],
    );

    const isNodeGenerating = useCallback(
        (nodeId: string) => {
            if (runningNodeId === nodeId) return true;
            for (const request of generationRequestsRef.current.values()) {
                if (request.runningNodeId === nodeId || request.originNodeId === nodeId || request.targetNodeId === nodeId) return true;
            }
            return false;
        },
        [generationEpoch, runningNodeId],
    );

    // Once a dismissed node stops generating, drop it from the dismissal set so a future
    // generation for the same node opens its panel again.
    useEffect(() => {
        setDismissedGeneratingNodeIds((prev) => {
            if (!prev.size) return prev;
            const stillGenerating = new Set<string>();
            generationRequestsRef.current.forEach((request) => {
                stillGenerating.add(request.runningNodeId);
                stillGenerating.add(request.originNodeId);
                stillGenerating.add(request.targetNodeId);
            });
            if (runningNodeId) stillGenerating.add(runningNodeId);
            const filtered = new Set([...prev].filter((id) => stillGenerating.has(id)));
            return filtered.size === prev.size ? prev : filtered;
        });
    }, [generationEpoch, runningNodeId]);

    // Mirror native-video FIFO order onto node metadata (live store is primary for badges).
    useEffect(() => {
        const syncQueueLabels = () => {
            const snap = getNativeVideoQueueSnapshot();
            const nodeIds = new Set(snap.map((job) => job.targetNodeId));
            setNodes((prev) => {
                let changed = false;
                const next = prev.map((node) => {
                    const job = nodeIds.has(node.id) ? pickNativeVideoQueueEntryForNode(snap, node.id) : undefined;
                    const prevPos = node.metadata?.nativeVideoQueuePosition;
                    const prevTotal = node.metadata?.nativeVideoQueueTotal;
                    const prevPhase = node.metadata?.nativeVideoQueuePhase;
                    if (!job) {
                        if (prevPos == null && prevTotal == null && !prevPhase) return node;
                        changed = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                nativeVideoQueuePosition: undefined,
                                nativeVideoQueueTotal: undefined,
                                nativeVideoQueuePhase: undefined,
                            },
                        };
                    }
                    if (prevPos === job.position && prevTotal === job.total && prevPhase === job.phase) return node;
                    changed = true;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            nativeVideoQueuePosition: job.position,
                            nativeVideoQueueTotal: job.total,
                            nativeVideoQueuePhase: job.phase,
                        },
                    };
                });
                return changed ? next : prev;
            });
        };
        syncQueueLabels();
        return subscribeNativeVideoQueue(syncQueueLabels);
    }, []);

    const isNodeGeneratingRef = useRef(isNodeGenerating);
    useEffect(() => {
        isNodeGeneratingRef.current = isNodeGenerating;
    }, [isNodeGenerating]);

    // 定时生成调度器：每秒扫描带 scheduledAt 的节点，到点后走与手动点击完全相同的生成入口。
    // 页面关闭会暂停；再次打开时已过期但未执行的排期会立刻补跑。
    const scheduleClaimRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const timer = window.setInterval(() => {
            const now = Date.now();
            const due = nodesRef.current.filter((node) => typeof node.metadata?.scheduledAt === "number" && (node.metadata.scheduledAt as number) <= now);
            if (!due.length) return;
            for (const node of due) {
                if (scheduleClaimRef.current.has(node.id)) continue;
                if (isNodeGeneratingRef.current(node.id)) continue;
                scheduleClaimRef.current.add(node.id);
                window.setTimeout(() => scheduleClaimRef.current.delete(node.id), 120_000);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, scheduledAt: undefined } } : item)));
                const mode: CanvasNodeGenerationMode = node.metadata?.generationMode || (node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image");
                const prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
                void generateNodeRef.current?.(node.id, mode, prompt);
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            navigate("/canvas", { replace: true });
            return;
        }

        const thumbAbort = new AbortController();
        const restore = async () => {
            // Fast hydrate: primary media only âdo not block first paint on every history blob.
            const restoredNodes = (await hydrateCanvasImages(resetInterruptedGeneration(project.nodes), { mode: "fast" })).map((node) =>
                node.type === CanvasNodeType.Chat && (node.height === 520 || node.height === 1040 || node.width === 420)
                    ? { ...node, width: 840, height: 1387 }
                    : node.type === CanvasNodeType.Text && node.height === 240
                      ? { ...node, height: 480 }
                      : node,
            );
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(project.chatSessions || []);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: project.chatSessions || [],
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);

            // Background: chat image refs + remaining video/image history versions.
            void (async () => {
                if (thumbAbort.signal.aborted) return;
                const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
                if (thumbAbort.signal.aborted) return;
                setChatSessions(restoredSessions);
                if (lastHistoryRef.current) {
                    lastHistoryRef.current = { ...lastHistoryRef.current, chatSessions: restoredSessions };
                }

                const fullNodes = await hydrateCanvasMediaDeferred(restoredNodes, thumbAbort.signal);
                if (thumbAbort.signal.aborted) return;
                setNodes((prev) => {
                    const byId = new Map(fullNodes.map((node) => [node.id, node]));
                    return prev.map((node) => {
                        const next = byId.get(node.id);
                        if (!next?.metadata?.images?.length) return node;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                content: next.metadata?.content || node.metadata?.content,
                                storageKey: next.metadata?.storageKey || node.metadata?.storageKey,
                                images: next.metadata?.images,
                            },
                        };
                    });
                });
            })();

            // Legacy projects: generate missing thumbnails in the background without blocking the canvas.
            void backfillCanvasImageThumbnails(
                restoredNodes,
                (nodeId, patch) => {
                    if (thumbAbort.signal.aborted) return;
                    setNodes((prev) =>
                        prev.map((node) => {
                            if (node.id !== nodeId) return node;
                            // Skip if the user already has a newer thumbnail or cleared the media.
                            if (!node.metadata?.storageKey && !(node.metadata?.images || []).length) return node;
                            const images = patch.images
                                ? (node.metadata?.images || []).map((image) => {
                                      const next = patch.images?.find((item) => item.id === image.id);
                                      if (!next || image.thumbnailStorageKey) return image;
                                      return { ...image, thumbnailContent: next.thumbnailContent, thumbnailStorageKey: next.thumbnailStorageKey };
                                  })
                                : node.metadata?.images;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    ...(node.metadata?.thumbnailStorageKey
                                        ? {}
                                        : {
                                              thumbnailContent: patch.thumbnailContent ?? node.metadata?.thumbnailContent,
                                              thumbnailStorageKey: patch.thumbnailStorageKey ?? node.metadata?.thumbnailStorageKey,
                                          }),
                                    ...(images ? { images } : {}),
                                },
                            };
                        }),
                    );
                },
                thumbAbort.signal,
            );
        };
        void restore();
        return () => thumbAbort.abort();
    }, [hydrated, navigate, openProject, projectId]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useEffect(() => {
        draftMetaRef.current = draftMeta;
    }, [draftMeta]);

    useEffect(() => {
        draftSavingRef.current = draftSaving;
    }, [draftSaving]);

    useEffect(() => {
        let cancelled = false;
        setDraftMeta(null);
        setDraftPickerHandle(null);
        setDraftDialogOpen(false);
        if (!projectId) return;
        void getCanvasDraftMeta(projectId).then((meta) => {
            if (!cancelled) setDraftMeta(meta);
        });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        chatSessionsRef.current = chatSessions;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        hoveredNodeIdRef.current = hoveredNodeId;
        toolbarNodeIdRef.current = toolbarNodeId;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, chatSessions, connections, selectedNodeIds, hoveredNodeId, toolbarNodeId, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    /**
     * Re-resolve media that was unreadable while the bound local folder had no permission.
     * Runs on every successful (re-)authorization so the canvas recovers without a page reload —
     * media fields only, so the viewport, undo history, and in-progress edits are left untouched.
     */
    const rehydrateLocalMedia = useCallback(async () => {
        const currentNodes = nodesRef.current;
        if (currentNodes.length) {
            const restored = await hydrateCanvasImages(currentNodes, { mode: "fast" });
            setNodes((prev) => applyHydratedMedia(prev, restored));
        }
        const sessions = chatSessionsRef.current;
        if (!sessions.length) return;
        const restoredSessions = await hydrateAssistantImages(sessions);
        setChatSessions(restoredSessions);
        if (lastHistoryRef.current) {
            lastHistoryRef.current = { ...lastHistoryRef.current, chatSessions: restoredSessions };
        }
    }, []);

    useEffect(() => subscribeLocalMediaLibraryAccess(() => void rehydrateLocalMedia()), [rehydrateLocalMedia]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const getCreateNodePosition = useCallback(() => mouseWorldRef.current || getCanvasCenter(), [getCanvasCenter]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const nodesSnapshot = nodesRef.current;
            const pairs = resolveConnectionPairs(current.nodeId, targetNodeId, nodesSnapshot, current.handleType);
            if (!pairs.length) {
                const anchor = nodesSnapshot.find((node) => node.id === current.nodeId);
                const target = nodesSnapshot.find((node) => node.id === targetNodeId);
                const emptyGroup =
                    (anchor?.type === CanvasNodeType.Group && getGroupMemberNodes(anchor.id, nodesSnapshot).length === 0) ||
                    (target?.type === CanvasNodeType.Group && getGroupMemberNodes(target.id, nodesSnapshot).length === 0);
                message.warning(t(emptyGroup ? "canvas.projectPage.emptyGroupConnection" : "canvas.projectPage.configConnection"));
                return;
            }

            setConnections((prev) => {
                const existing = new Set(prev.map((conn) => `${conn.fromNodeId}->${conn.toNodeId}`));
                const additions = pairs
                    .filter((pair) => !existing.has(`${pair.fromNodeId}->${pair.toNodeId}`))
                    .map((pair) => ({ id: nanoid(), fromNodeId: pair.fromNodeId, toNodeId: pair.toNodeId }));
                return additions.length ? [...prev, ...additions] : prev;
            });

            // Annotate âImage: load the first linked image into the annotate node.
            for (const { fromNodeId, toNodeId } of pairs) {
                const fromNode = nodesSnapshot.find((node) => node.id === fromNodeId);
                const toNode = nodesSnapshot.find((node) => node.id === toNodeId);
                const annotateTarget = toNode?.type === CanvasNodeType.Annotate ? toNode : fromNode?.type === CanvasNodeType.Annotate ? fromNode : null;
                const imageSource = annotateTarget ? (annotateTarget.id === toNodeId ? fromNode : toNode) : null;
                const sourceMeta = imageSource?.metadata;
                const canLoadIntoAnnotate =
                    annotateTarget &&
                    imageSource &&
                    imageSource.id !== annotateTarget.id &&
                    (imageSource.type === CanvasNodeType.Image || imageSource.type === CanvasNodeType.Annotate) &&
                    Boolean(sourceMeta?.content);
                if (!canLoadIntoAnnotate || !sourceMeta) continue;

                const primary = sourceMeta.images?.find((image) => image.id === (sourceMeta.primaryImageId || sourceMeta.images?.[0]?.id) && image.content);
                const content = primary?.content || sourceMeta.content;
                const storageKey = primary?.storageKey || sourceMeta.storageKey;
                const thumbnailContent = primary?.thumbnailContent || sourceMeta.thumbnailContent;
                const thumbnailStorageKey = primary?.thumbnailStorageKey || sourceMeta.thumbnailStorageKey;
                const naturalWidth = primary?.naturalWidth || sourceMeta.naturalWidth || imageSource.width;
                const naturalHeight = primary?.naturalHeight || sourceMeta.naturalHeight || imageSource.height;
                const bytes = primary?.bytes || sourceMeta.bytes || 0;
                const mimeType = primary?.mimeType || sourceMeta.mimeType || "image/png";
                const size = fitNodeSize(
                    naturalWidth || annotateTarget.width,
                    naturalHeight || annotateTarget.height,
                    Math.max(annotateTarget.width, 320),
                    Math.max(annotateTarget.height, 240),
                );
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === annotateTarget.id
                            ? {
                                  ...node,
                                  position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                                  ...size,
                                  metadata: {
                                      ...node.metadata,
                                      content,
                                      storageKey,
                                      thumbnailContent,
                                      thumbnailStorageKey,
                                      naturalWidth,
                                      naturalHeight,
                                      bytes,
                                      mimeType,
                                      status: NODE_STATUS_SUCCESS,
                                      errorDetails: undefined,
                                      annotations: content === node.metadata?.content ? node.metadata?.annotations || [] : [],
                                  },
                              }
                            : node,
                    ),
                );
                break;
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Merge, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Merge) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current].reverse().forEach((node) => {
                const anchor = getConnectionTargetAnchor(node, current);
                const dx = world.x - anchor.x;
                const dy = world.y - anchor.y;
                const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                isNearNode = true;
                if (node.id === current.nodeId || !canConnectNodes(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                if (priority < bestPriority) {
                    bestNodeId = node.id;
                    bestPriority = priority;
                }
            });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    // Nodes that recently left the viewport stay mounted for a short grace period. Without it,
    // small back-and-forth pans/zooms repeatedly mount/unmount edge nodes, which re-decodes
    // their images/videos every time — the main "many images feel laggy" culprit.
    const visibleNodesGraceRef = useRef<Map<string, number>>(new Map());
    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        const GRACE_MS = 2000;
        const now = Date.now();
        const history = visibleNodesGraceRef.current;
        const inView = new Set<string>();
        const result = nodes.filter((node) => {
            const inViewport = node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom;
            if (inViewport) {
                inView.add(node.id);
                return true;
            }
            const lastSeen = history.get(node.id);
            return Boolean(lastSeen && now - lastSeen < GRACE_MS);
        });
        const nextHistory = new Map<string, number>();
        for (const id of inView) nextHistory.set(id, now);
        for (const [id, ts] of history) {
            if (!inView.has(id) && now - ts < GRACE_MS) nextHistory.set(id, ts);
        }
        visibleNodesGraceRef.current = nextHistory;
        return result;
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const visibleConnections = useMemo(() => {
        const padding = 320;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;
        const nodeMap = new Map(nodes.map((node) => [node.id, node]));

        return connections.filter((connection) => {
            const from = nodeMap.get(connection.fromNodeId);
            const to = nodeMap.get(connection.toNodeId);
            if (!from || !to) return false;
            const left = Math.min(from.position.x, to.position.x);
            const top = Math.min(from.position.y, to.position.y);
            const right = Math.max(from.position.x + from.width, to.position.x + to.width);
            const bottom = Math.max(from.position.y + from.height, to.position.y + to.height);
            return right > viewLeft && left < viewRight && bottom > viewTop && top < viewBottom;
        });
    }, [connections, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const getViewportScale = useCallback(() => viewportRef.current.k || 1, []);
    const dragPreviewIdSet = useMemo(() => (dragPreview ? new Set(dragPreview.ids) : null), [dragPreview]);
    const withDragPreview = useCallback(
        (node: CanvasNodeData | undefined) => {
            if (!node || !dragPreview || !dragPreviewIdSet?.has(node.id)) return node;
            return { ...node, position: { x: node.position.x + dragPreview.dx, y: node.position.y + dragPreview.dy } };
        },
        [dragPreview, dragPreviewIdSet],
    );
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const annotateNode = annotateNodeId ? nodeById.get(annotateNodeId) || null : null;
    const textEditNode = textEditNodeId ? nodeById.get(textEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const mjUpscaleNode = mjUpscaleNodeId ? nodeById.get(mjUpscaleNodeId) || null : null;
    const scaleNode = scaleNodeId ? nodeById.get(scaleNodeId) || null : null;
    const adjustNode = adjustNodeId ? nodeById.get(adjustNodeId) || null : null;
    const videoToolsNode = videoToolsNodeId ? nodeById.get(videoToolsNodeId) || null : null;
    const audioToolsNode = audioToolsNodeId ? nodeById.get(audioToolsNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const panoramaNode = panoramaNodeId ? nodeById.get(panoramaNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewContent = previewImageId ? previewNode?.metadata?.images?.find((image) => image.id === previewImageId)?.content : previewNode?.metadata?.content;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    // Lazy per-node generation inputs (only Config/Merge nodes need them). Eager building
    // invalidates `renderNodePanel`/`renderNodeContentPanel` on every node/connection edit and
    // forces all nodes to re-render; compute on demand instead.
    const configInputsCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[]; map: Map<string, NodeGenerationInput[]> } | null>(null);
    const getConfigInputs = useCallback((nodeId: string) => {
        const cache = configInputsCacheRef.current;
        if (!cache || cache.nodes !== nodes || cache.connections !== connections) {
            configInputsCacheRef.current = { nodes, connections, map: new Map() };
        }
        const current = configInputsCacheRef.current!;
        const hit = current.map.get(nodeId);
        if (hit) return hit;
        const node = nodeById.get(nodeId);
        if (!node || (node.type !== CanvasNodeType.Config && node.type !== CanvasNodeType.Merge)) return [];
        const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
        current.map.set(nodeId, inputs);
        return inputs;
    }, [connections, nodeById, nodes]);
    // Lazy, per-node mention references. Building this eagerly for every node is O(N²) over
    // connections and nodes, and the map's reference changing on any node/connection edit
    // invalidates `renderNodePanel` and forces EVERY node to re-render. Compute on demand and
    // cache per node, invalidating only when nodes/connections actually change.
    const mentionCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[]; map: Map<string, ReturnType<typeof buildNodeMentionReferences>> } | null>(null);
    const getMentionReferences = useCallback((nodeId: string) => {
        const cache = mentionCacheRef.current;
        if (!cache || cache.nodes !== nodes || cache.connections !== connections) {
            mentionCacheRef.current = { nodes, connections, map: new Map() };
        }
        const current = mentionCacheRef.current!;
        const hit = current.map.get(nodeId);
        if (hit) return hit;
        const node = nodeById.get(nodeId);
        if (!node) return EMPTY_REFERENCES;
        const refs = buildNodeMentionReferences(node, nodes, connections);
        current.map.set(nodeId, refs);
        return refs;
    }, [connections, nodeById, nodes]);
    // 脚本节点：上游（连线接入）的文本，是「剧本原文」没手填时的兜底来源。与上面两个缓存同理，
    // 按节点懒计算，避免每次节点/连线变动把整张画布重算一遍。
    const scriptSourceCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[]; map: Map<string, { text: string; count: number }> } | null>(null);
    const getScriptSource = useCallback(
        (nodeId: string) => {
            const cache = scriptSourceCacheRef.current;
            if (!cache || cache.nodes !== nodes || cache.connections !== connections) {
                scriptSourceCacheRef.current = { nodes, connections, map: new Map() };
            }
            const current = scriptSourceCacheRef.current!;
            const hit = current.map.get(nodeId);
            if (hit) return hit;
            const texts = buildNodeGenerationInputs(nodeId, nodes, connections)
                .filter((input) => input.type === "text" && Boolean(input.text?.trim()))
                .map((input) => (input.text || "").trim());
            const value = { text: texts.join("\n\n"), count: texts.length };
            current.map.set(nodeId, value);
            return value;
        },
        [connections, nodes],
    );
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCreateNodePosition();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : type === CanvasNodeType.Chat
                      ? {
                            model: resolveModelForCapability(effectiveConfig, effectiveConfig.textModel, "text"),
                            imageModel: resolveModelForCapability(effectiveConfig, effectiveConfig.imageModel, "image"),
                            chatTextEnabled: true,
                            chatImageEnabled: false,
                            status: NODE_STATUS_IDLE,
                            messages: [],
                        }
                      : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel ? false : definition?.useBuiltinPanel ? true : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group && type !== CanvasNodeType.Chat && type !== CanvasNodeType.Merge;
            if (wantsPanel) setDialogNodeId(newNode.id);
            return newNode.id;
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, effectiveConfig.textModel, getCreateNodePosition],
    );

    const createBridgeTextNode = useCallback(
        (content: string, position?: Position) => {
            const nodeId = createNode(CanvasNodeType.Text, position);
            const patch = { content, prompt: content, composerContent: content, promptSyncAt: Date.now() };
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node)));
            nodesRef.current = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node));
            return nodeId;
        },
        [createNode],
    );

    const createBridgeImageNode = useCallback(
        async (imageUrl: string, prompt?: string, position?: Position) => {
            const uploaded = await uploadImage(imageUrl);
            const nodeId = createNode(CanvasNodeType.Image, position);
            const patch = {
                ...imageMetadata(uploaded),
                ...(prompt ? { prompt, composerContent: prompt, promptSyncAt: Date.now() } : {}),
            };
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node)));
            nodesRef.current = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node));
            return nodeId;
        },
        [createNode],
    );

    const createMergeNode = useCallback(
        (position?: Position, sourceImageIds?: string[]) => {
            const mergeId = createNode(CanvasNodeType.Merge, position);
            const sources =
                sourceImageIds ||
                nodesRef.current.filter((node) => selectedNodeIds.has(node.id) && node.type === CanvasNodeType.Image && node.metadata?.content).map((node) => node.id);
            if (sources.length) {
                const layoutCount = Math.max(4, sources.length);
                const columns = Math.ceil(Math.sqrt(layoutCount));
                const rows = Math.ceil(layoutCount / columns);
                const slotIds = Array.from({ length: rows * columns }, (_, index) => sources[index] || null);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === mergeId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      mergeOrientation: "grid",
                                      mergeRows: rows,
                                      mergeColumns: columns,
                                      mergeSlotIds: slotIds,
                                  },
                              }
                            : node,
                    ),
                );
                setConnections((prev) => [...prev, ...sources.map((fromNodeId) => ({ id: nanoid(), fromNodeId, toNodeId: mergeId }))]);
            }
            return mergeId;
        },
        [createNode, selectedNodeIds],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAnnotateNodeId((current) => (current && allIds.has(current) ? null : current));
            setTextEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPanoramaNodeId((current) => (current && allIds.has(current) ? null : current));
            setAdjustNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedImageNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    // Reorder the connections feeding a chat node so its "linked media" thumbnails, mention labels
    // (图1/图2) and the API reference_images order all follow the user's drag order. Only the
    // incoming image/video connections are reordered; every other connection keeps its position.
    const handleReorderLinkedMedia = useCallback((nodeId: string, orderedNodeIds: string[]) => {
        const order = new Map(orderedNodeIds.map((id, index) => [id, index]));
        setConnections((prev) => {
            const incoming = prev.filter((conn) => conn.toNodeId === nodeId && order.has(conn.fromNodeId));
            if (incoming.length !== order.size) return prev;
            incoming.sort((a, b) => (order.get(a.fromNodeId)! - order.get(b.fromNodeId)!));
            const incomingIds = new Set(incoming.map((conn) => conn.id));
            let pointer = 0;
            const next = prev.map((conn) => {
                if (conn.toNodeId !== nodeId || !incomingIds.has(conn.id)) return conn;
                const replacement = incoming[pointer++];
                return replacement;
            });
            return next;
        });
    }, []);

    // Detach one reference chip from a panel. A reference can be wired straight into the node, or
    // into a shared Config hub that feeds it — drop whichever connection actually carries that
    // media so the chip disappears without hand-dragging the wire off the node.
    const handleRemoveLinkedMedia = useCallback((nodeId: string, referenceNodeId: string) => {
        setConnections((prev) => {
            const targetIds = new Set<string>([nodeId]);
            prev.forEach((conn) => {
                if (conn.fromNodeId !== nodeId) return;
                if (nodesRef.current.find((node) => node.id === conn.toNodeId)?.type === CanvasNodeType.Config) targetIds.add(conn.toNodeId);
            });
            const next = prev.filter((conn) => !(conn.fromNodeId === referenceNodeId && targetIds.has(conn.toNodeId)));
            return next.length === prev.length ? prev : next;
        });
    }, []);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        // Keep pan-tool blank clicks consistent with the pointer path: also collapse panels still generating.
        const generatingIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            generatingIds.add(request.runningNodeId);
            generatingIds.add(request.originNodeId);
            generatingIds.add(request.targetNodeId);
        });
        if (generatingIds.size) setDismissedGeneratingNodeIds((prev) => new Set([...prev, ...generatingIds]));
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAnnotateNodeId(null);
        setTextEditNodeId(null);
        setAngleNodeId(null);
        setPanoramaNodeId(null);
        setAdjustNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };
        const nextConnections = cloneConnectionsForCopiedNodes(connectionsRef.current, new Map([[nodeId, id]]));

        setNodes((prev) => [...prev, next]);
        if (nextConnections.length) {
            setConnections((prev) => {
                const keys = new Set(prev.map((connection) => `${connection.fromNodeId}\0${connection.toNodeId}`));
                return [...prev, ...nextConnections.filter((connection) => !keys.has(`${connection.fromNodeId}\0${connection.toNodeId}`))];
            });
        }
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    // Image and video nodes are the same generation slot in two flavours, so either can become the
    // other. The node is rewritten in place rather than recreated: its id survives, and with it every
    // connection, group membership, merge slot and mention label. The payload of the type being left
    // is parked in metadata (see lib/canvas/node-type-conversion) instead of dropped, so converting
    // back brings the previous media and knobs with it and the asset cleanup keeps the file.
    const convertNodeTypeById = useCallback(
        (nodeId: string, targetType: CanvasNodeType) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node || nodeConversionTarget(node.type) !== targetType) return;
            // Generation writes its result back into the node by id; switching the type underneath it
            // would land image bytes on a video node (and vice versa).
            if (isNodeGenerating(nodeId)) {
                message.warning(t("canvas.controls.convertBusy"));
                return;
            }
            const converted = convertNodeType(node, targetType);
            if (converted === node) return;
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? converted : item)));
            if (convertedNodeKeptMedia(converted, node.type as CanvasNodeType)) message.info(t("canvas.controls.convertKeptMedia"));
        },
        [isNodeGenerating, t],
    );

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            // Keep internal edges and edges to unselected neighbors so paste can reattach them.
            connections: connectionsRef.current
                .filter((connection) => selectedIds.has(connection.fromNodeId) || selectedIds.has(connection.toNodeId))
                .map((connection) => ({ ...connection })),
        };
    }, []);

    const copyNodeImageToClipboard = useCallback(async (nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) {
            message.warning(t("canvas.shortcut.copyImageNeedSelect"));
            return;
        }
        try {
            const primary = node.metadata.images?.find((image) => image.id === (node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id) && image.content) || null;
            const dataUrl = await imageToDataUrl({
                url: primary?.content || node.metadata.content,
                storageKey: primary?.storageKey || node.metadata.storageKey,
            });
            const sourceBlob = await (await fetch(dataUrl)).blob();
            const clipboardBlob = await ensureClipboardImageBlob(sourceBlob);
            await navigator.clipboard.write([new ClipboardItem({ [clipboardBlob.type]: clipboardBlob })]);
            message.success(t("canvas.shortcut.copyImageDone"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.shortcut.copyImageFailed"));
        }
    }, [message, t]);

    /** C: spawn a new media node that only carries the selected image/video content. */
    const duplicateSelectedMediaAsNode = useCallback(() => {
        if (selectedNodeIdsRef.current.size !== 1) {
            message.warning(t("canvas.shortcut.copyImageNeedSelect"));
            return;
        }
        const nodeId = Array.from(selectedNodeIdsRef.current)[0];
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Annotate && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) {
            message.warning(t("canvas.shortcut.copyImageNeedSelect"));
            return;
        }

        const metadata = node.metadata;
        const primary = metadata.images?.find((image) => image.id === (metadata.primaryImageId || metadata.images?.[0]?.id) && image.content) || null;
        const content = primary?.content || metadata.content;
        const storageKey = primary?.storageKey || metadata.storageKey;
        const thumbnailContent = primary?.thumbnailContent || metadata.thumbnailContent;
        const thumbnailStorageKey = primary?.thumbnailStorageKey || metadata.thumbnailStorageKey;
        const naturalWidth = primary?.naturalWidth || metadata.naturalWidth || node.width;
        const naturalHeight = primary?.naturalHeight || metadata.naturalHeight || node.height;
        const bytes = primary?.bytes || metadata.bytes || 0;
        const isAudio = node.type === CanvasNodeType.Audio;
        const isVideo = node.type === CanvasNodeType.Video;
        const mimeType = primary?.mimeType || metadata.mimeType || (isVideo ? "video/mp4" : isAudio ? "audio/mpeg" : "image/png");
        const size = isAudio
            ? { width: node.width, height: node.height }
            : isVideo
              ? fitNodeSize(naturalWidth || node.width, naturalHeight || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT)
              : fitNodeSize(naturalWidth || node.width, naturalHeight || node.height, Math.max(node.width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width), Math.max(node.height, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height));
        const id = `${isVideo ? CanvasNodeType.Video : isAudio ? CanvasNodeType.Audio : CanvasNodeType.Image}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const copy: CanvasNodeData = {
            id,
            type: isVideo ? CanvasNodeType.Video : isAudio ? CanvasNodeType.Audio : CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width + 48, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content,
                storageKey,
                thumbnailContent,
                thumbnailStorageKey,
                naturalWidth,
                naturalHeight,
                bytes,
                mimeType,
                status: NODE_STATUS_SUCCESS,
                durationMs: isVideo || isAudio ? metadata.durationMs : undefined,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
        message.success(t("canvas.shortcut.copyImageNodeDone"));
    }, [message, t]);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const remappedIds = new Set(idMap.values());
        const existingIds = new Set(nodesRef.current.map((node) => node.id));
        const nextConnections = cloneConnectionsForCopiedNodes(clipboard.connections, idMap).filter(
            (connection) =>
                (remappedIds.has(connection.fromNodeId) || existingIds.has(connection.fromNodeId)) &&
                (remappedIds.has(connection.toNodeId) || existingIds.has(connection.toNodeId)),
        );

        setNodes((prev) => [...prev, ...pastedNodes]);
        if (nextConnections.length) {
            setConnections((prev) => {
                const keys = new Set(prev.map((connection) => `${connection.fromNodeId}\0${connection.toNodeId}`));
                return [...prev, ...nextConnections.filter((connection) => !keys.has(`${connection.fromNodeId}\0${connection.toNodeId}`))];
            });
        }
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.85) / node.width, (size.height * 0.85) / node.height), 0.05), 5);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const cancelFocusAnimation = useCallback(() => {
        if (focusAnimRef.current) {
            cancelAnimationFrame(focusAnimRef.current);
            focusAnimRef.current = null;
        }
    }, []);

    const handleViewportChange = useCallback(
        (next: ViewportTransform) => {
            // A manual pan/zoom cancels any in-flight focus animation so the two competing
            // setViewport loops cannot make the viewport jump.
            cancelFocusAnimation();
            setViewport(next);
            setContextMenu(null);
        },
        [cancelFocusAnimation],
    );

    const handleUserInteract = useCallback(() => {
        // Cancel focus animation the instant the user starts panning/zooming — before the
        // viewport is committed — so a running focus tween cannot keep overwriting the pan anchor.
        cancelFocusAnimation();
    }, [cancelFocusAnimation]);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, t]);

    const buildLiveProjectSnapshot = useCallback(() => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return null;
        return {
            ...project,
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            updatedAt: new Date().toISOString(),
        };
    }, [projectId]);

    const overwriteBoundDraft = useCallback(
        async (quiet = false) => {
            const project = buildLiveProjectSnapshot();
            if (!project) {
                if (!quiet) message.error(t("canvas.projectPage.notFound"));
                return false;
            }
            if (draftSavingRef.current) return false;
            setDraftSaving(true);
            const hide = quiet ? null : message.loading(t("canvas.draft.saving"), 0);
            try {
                const meta = await overwriteCanvasDraft(project);
                if (!meta) {
                    // Autosave must never download a new file; ask the user to rebind when they save manually.
                    if (!quiet) setDraftDialogOpen(true);
                    else setDraftMeta((current) => (current ? { ...current, hasHandle: false } : current));
                    return false;
                }
                setDraftMeta(meta);
                if (!quiet) message.success(t("canvas.draft.saved", { name: meta.fileName }));
                return true;
            } catch (error) {
                console.error(error);
                const code = error instanceof Error ? error.message : "";
                if (quiet) {
                    setDraftMeta((current) => (current ? { ...current, hasHandle: false } : current));
                    return false;
                }
                if (code === "FILE_PERMISSION_DENIED") {
                    message.warning(t("canvas.draft.permissionDenied"));
                    setDraftDialogOpen(true);
                } else {
                    message.error(error instanceof Error ? error.message : t("canvas.draft.saveFailed"));
                    setDraftDialogOpen(true);
                }
                return false;
            } finally {
                hide?.();
                setDraftSaving(false);
            }
        },
        [buildLiveProjectSnapshot, message, t],
    );

    const handleDraftPickPath = useCallback(
        async (draftName: string) => {
            try {
                if (supportsDirectoryPicker()) {
                    const directory = await pickCanvasDraftDirectory();
                    setDraftPickerDirectory(directory);
                    setDraftPickerHandle(null);
                    return;
                }
                const handle = await pickCanvasDraftFile(draftName || currentProject?.title || t("canvas.project.untitled"));
                setDraftPickerHandle(handle);
                setDraftPickerDirectory(null);
            } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") return;
                console.error(error);
                message.error(t("canvas.draft.pickFailed"));
            }
        },
        [currentProject?.title, message, t],
    );

    const handleDraftConfirm = useCallback(
        async (draftName: string) => {
            const project = buildLiveProjectSnapshot();
            if (!project) {
                message.error(t("canvas.projectPage.notFound"));
                return;
            }
            if (draftSavingRef.current) return;
            setDraftSaving(true);
            const hide = message.loading(t("canvas.draft.saving"), 0);
            try {
                let meta: CanvasDraftMeta;
                if (supportsDirectoryPicker() || draftPickerDirectory) {
                    const directory = draftPickerDirectory || (await pickCanvasDraftDirectory());
                    meta = await saveCanvasDraftToDirectory(project, directory, draftName || project.title);
                    setDraftPickerDirectory(directory);
                    setDraftPickerHandle(null);
                } else if (supportsFileSystemAccess()) {
                    const handle = draftPickerHandle || (await pickCanvasDraftFile(draftName || project.title));
                    meta = await saveCanvasDraftToHandle(project, handle);
                    setDraftPickerHandle(handle);
                } else {
                    meta = await saveCanvasDraftFallbackDownload(project, draftName || project.title);
                }
                setDraftMeta(meta);
                setDraftDialogOpen(false);
                message.success(t("canvas.draft.bound", { name: meta.folderName ? `${meta.folderName}/${meta.fileName}` : meta.fileName }));
            } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") return;
                console.error(error);
                const code = error instanceof Error ? error.message : "";
                if (code === "FILE_SYSTEM_ACCESS_UNSUPPORTED") {
                    try {
                        const meta = await saveCanvasDraftFallbackDownload(project, draftName || project.title);
                        setDraftMeta(meta);
                        setDraftDialogOpen(false);
                        message.success(t("canvas.draft.boundFallback", { name: meta.fileName }));
                        return;
                    } catch (fallbackError) {
                        console.error(fallbackError);
                    }
                }
                if (code === "FILE_PERMISSION_DENIED") message.warning(t("canvas.draft.permissionDenied"));
                else message.error(error instanceof Error ? error.message : t("canvas.draft.saveFailed"));
            } finally {
                hide();
                setDraftSaving(false);
            }
        },
        [buildLiveProjectSnapshot, draftPickerDirectory, draftPickerHandle, message, t],
    );

    const handleDraftShortcut = useCallback(async () => {
        if (draftMetaRef.current) {
            await overwriteBoundDraft(false);
            return;
        }
        setDraftDialogOpen(true);
    }, [overwriteBoundDraft]);

    useEffect(() => {
        if (!projectLoaded || !draftMeta?.hasHandle) return;
        const timer = window.setInterval(() => {
            if (!draftMetaRef.current?.hasHandle || draftSavingRef.current) return;
            void overwriteBoundDraft(true).then((ok) => {
                if (ok) message.success(t("canvas.draft.autoSaved"));
            });
        }, DRAFT_AUTO_SAVE_MS);
        return () => window.clearInterval(timer);
    }, [DRAFT_AUTO_SAVE_MS, draftMeta?.hasHandle, message, overwriteBoundDraft, projectLoaded, t]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            // Clicking empty canvas space also collapses generation panels that are still running,
            // so the prompt editor does not stay open during generation.
            const generatingIds = new Set<string>();
            generationRequestsRef.current.forEach((request) => {
                generatingIds.add(request.runningNodeId);
                generatingIds.add(request.originNodeId);
                generatingIds.add(request.targetNodeId);
            });
            if (generatingIds.size) setDismissedGeneratingNodeIds((prev) => new Set([...prev, ...generatingIds]));
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            // Sticky X linking stays active until X/Esc âblank-canvas clicks do not cancel it.
            if (connectingParamsRef.current?.sticky) {
                const anchorId = connectingParamsRef.current.nodeId;
                setSelectedNodeIds(new Set([anchorId]));
                setToolbarNodeId(anchorId);
                setSelectedConnectionId(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);

    // Toggle an audio node into/out of the merge selection while "pick" mode is active.
    const toggleAudioMergePick = useCallback((nodeId: string) => {
        setAudioMergeSelected((prev) => {
            const next = prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId];
            audioMergeSelectedRef.current = next;
            return next;
        });
    }, []);

    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            // Audio-merge "pick" mode: clicking an audio node toggles it in/out of the merge list,
            // instead of performing normal canvas selection.
            if (audioMergePickingRef.current) {
                const clicked = nodesRef.current.find((node) => node.id === nodeId);
                if (clicked?.type === CanvasNodeType.Audio) {
                    event.preventDefault();
                    toggleAudioMergePick(nodeId);
                    pendingSelectionRef.current = null;
                    return;
                }
            }
            // Keep Alt+drag from focusing the browser menu bar (Windows).
            if (event.altKey) event.preventDefault();
            blurActiveCanvasTextInput(event.target);
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const currentConnection = connectingParamsRef.current;
            // Sticky X mode: keep the anchor node selected and link every clicked peer until X/Esc.
            // Shift+click a group member expands to the whole group (same as clicking the group frame).
            if (currentConnection?.sticky) {
                if (currentConnection.nodeId !== nodeId) {
                    let targetId = nodeId;
                    if (event.shiftKey) {
                        const clicked = nodesRef.current.find((node) => node.id === nodeId);
                        const groupId = clicked?.type === CanvasNodeType.Group ? clicked.id : clicked?.metadata?.groupId;
                        if (groupId) targetId = groupId;
                    }
                    connectNodes(currentConnection, targetId);
                }
                const keep = new Set([currentConnection.nodeId]);
                setSelectedNodeIds(keep);
                setToolbarNodeId(currentConnection.nodeId);
                pendingSelectionRef.current = keep;
                return;
            }
            if (currentConnection && currentConnection.nodeId !== nodeId) {
                connectNodes(currentConnection, nodeId);
                setConnecting(null);
                setPendingConnectionCreate(null);
            }
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [connectNodes, selectNodeByEvent, setConnecting, toggleAudioMergePick],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // Audio-merge "pick" mode: a click on an audio node only toggles it in the merge list and
        // must never start a node drag.
        if (audioMergePickingRef.current) {
            const clicked = nodesRef.current.find((node) => node.id === nodeId);
            if (clicked?.type === CanvasNodeType.Audio) {
                pendingSelectionRef.current = null;
                return;
            }
        }
        // While sticky-linking, clicks only create edges âdo not start a drag on the clicked peer.
        if (connectingParamsRef.current?.sticky) {
            pendingSelectionRef.current = null;
            return;
        }
        // Windows: Alt+click otherwise focuses the browser menu bar and can cancel the drag.
        if (event.altKey) event.preventDefault();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            isAltCopyDrag: event.altKey,
            copySpawned: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, [selectNodeByEvent]);

    const spawnAltCopyDragNodes = useCallback(() => {
        const sourceIds = new Set(dragRef.current.initialSelectedNodes.map((item) => item.id));
        if (!sourceIds.size) return false;

        const sources = nodesRef.current.filter((node) => sourceIds.has(node.id));
        if (!sources.length) return false;

        const idMap = new Map<string, string>();
        const stamped = Date.now();
        const clones = sources.map((node, index) => {
            const id = `${node.type}-${stamped}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = clones.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            const remapped = idMap.get(groupId);
            return remapped ? { ...node, metadata: { ...node.metadata, groupId: remapped } } : node;
        });

        const nextConnections = cloneConnectionsForCopiedNodes(connectionsRef.current, idMap, stamped);

        // Must update React state (not only nodesRef): layout sync overwrites nodesRef from state,
        // and drag-preview only paints nodes present in state.
        nodesRef.current = [...nodesRef.current, ...pastedNodes];
        setNodes((prev) => {
            const ids = new Set(prev.map((node) => node.id));
            const missing = pastedNodes.filter((node) => !ids.has(node.id));
            return missing.length ? [...prev, ...missing] : prev;
        });
        if (nextConnections.length) {
            const keys = new Set(connectionsRef.current.map((connection) => `${connection.fromNodeId}\0${connection.toNodeId}`));
            const uniqueConnections = nextConnections.filter((connection) => !keys.has(`${connection.fromNodeId}\0${connection.toNodeId}`));
            if (uniqueConnections.length) {
                connectionsRef.current = [...connectionsRef.current, ...uniqueConnections];
                setConnections((prev) => [...prev, ...uniqueConnections]);
            }
        }
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
        dragRef.current.initialSelectedNodes = pastedNodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y }));
        dragRef.current.copySpawned = true;
        return true;
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasAltCopy = dragRef.current.isAltCopyDrag;
        const copySpawned = dragRef.current.copySpawned;
        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1 && !(wasAltCopy && copySpawned);
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDragPreview(null);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null && (!wasAltCopy || copySpawned)) {
            const movedIds = new Set(initialPositions.map((item) => item.id));
            setNodes((prev) => {
                const ids = new Set(prev.map((node) => node.id));
                const missing = nodesRef.current.filter((node) => movedIds.has(node.id) && !ids.has(node.id));
                const base = missing.length ? [...prev, ...missing] : prev;
                const moved = base.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.isAltCopyDrag = false;
        dragRef.current.copySpawned = false;
        dragRef.current.initialSelectedNodes = [];
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
                setDismissedGeneratingNodeIds((prev) => (prev.has(clickedNodeId) ? new Set([...prev].filter((id) => id !== clickedNodeId)) : prev));
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const nextWorld = screenToCanvas(event.clientX, event.clientY);
            mouseWorldRef.current = nextWorld;
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                // Alt+drag: keep originals still until the copy is spawned past the move threshold.
                if (dragRef.current.isAltCopyDrag && !dragRef.current.copySpawned) {
                    if (!dragRef.current.hasMoved) return;
                    if (!spawnAltCopyDragNodes()) return;
                }

                const initialPositions = dragRef.current.initialSelectedNodes;
                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);

                // Preview drag with transform offset only âcommit positions once on mouseup.
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    const ids = dragRef.current.initialSelectedNodes.map((item) => item.id);
                    setDragPreview({ dx, dy, ids });
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(nextWorld);
            }
        },
        [getConnectionDropTarget, screenToCanvas, spawnAltCopyDragNodes],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current.forEach((node) => {
                const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                if (intersects) nextSelected.add(node.id);
            });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            // Only update selection when the set actually changed; a marquee that slides over the
            // same nodes would otherwise re-render every node on each pointermove.
            const prevSelected = selectedNodeIdsRef.current;
            const changed = nextSelected.size !== prevSelected.size || Array.from(nextSelected).some((id) => !prevSelected.has(id));
            if (changed) setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                // Sticky X mode already links on mousedown capture; mouseup must not clear or re-link.
                if (currentConnection.sticky) return;
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createDocumentTextNode = useCallback(
        async (file: File, position: Position) => {
            try {
                const content = await readDocumentAsText(file);
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const node = {
                    ...createCanvasNode(CanvasNodeType.Text, position, { content, status: NODE_STATUS_SUCCESS, fontSize: DEFAULT_CANVAS_FONT_SIZE }),
                    title: file.name.replace(/\.[^.]+$/, "").slice(0, 48) || file.name,
                    position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                };
                setNodes((prev) => [...prev, node]);
                setSelectedNodeIds(new Set([node.id]));
                setSelectedConnectionId(null);
                setDialogNodeId(node.id);
                return true;
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.projectPage.documentReadFailed"));
                return false;
            }
        },
        [message, t],
    );

    const applyDocumentToTextNode = useCallback(
        async (nodeId: string, file: File) => {
            try {
                const content = await readDocumentAsText(file);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId
                            ? {
                                  ...node,
                                  type: CanvasNodeType.Text,
                                  title: file.name.replace(/\.[^.]+$/, "").slice(0, 48) || file.name,
                                  metadata: { ...node.metadata, content, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                              }
                            : node,
                    ),
                );
                setSelectedNodeIds(new Set([nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(nodeId);
                return true;
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.projectPage.documentReadFailed"));
                return false;
            }
        },
        [message, t],
    );

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteClipboardImageFile = useCallback(
        (file: File, position: Position = getCreateNodePosition()) => {
            if (!file.type.startsWith("image/")) return false;
            void createImageFileNode(file, position);
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return true;
        },
        [createImageFileNode, getCreateNodePosition, message, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            pasteClipboardImageFile(file);
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createTextNodeFromClipboard, message, pasteClipboardImageFile, t]);

    const resetSelectedNodesToOriginalSize = useCallback((explicitIds?: Iterable<string>) => {
        const selectedIds = new Set(explicitIds || selectedNodeIdsRef.current);
        if (!selectedIds.size) {
            const fallbackId = toolbarNodeIdRef.current || hoveredNodeIdRef.current;
            if (fallbackId) selectedIds.add(fallbackId);
        }
        if (!selectedIds.size) {
            message.warning(t("canvas.shortcut.selectNodeToResetSize"));
            return;
        }

        const eligible = nodesRef.current.filter((node) => {
            if (!selectedIds.has(node.id)) return false;
            if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Annotate) return false;
            return Boolean(resolveNodeMediaNaturalSize(node));
        });

        if (!eligible.length) {
            message.warning(t("canvas.shortcut.resetSizeNeedMedia"));
            return;
        }

        const eligibleIds = new Set(eligible.map((node) => node.id));
        setNodes((prev) =>
            prev.map((node) => {
                if (!eligibleIds.has(node.id)) return node;
                const natural = resolveNodeMediaNaturalSize(node);
                if (!natural) return node;
                const size = defaultFitSizeForNode(node, natural);
                const nextWidth = Math.max(1, Math.round(size.width));
                const nextHeight = Math.max(1, Math.round(size.height));
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                return {
                    ...node,
                    width: nextWidth,
                    height: nextHeight,
                    position: { x: centerX - nextWidth / 2, y: centerY - nextHeight / 2 },
                    metadata: {
                        ...node.metadata,
                        freeResize: false,
                        naturalWidth: node.metadata?.naturalWidth || natural.width,
                        naturalHeight: node.metadata?.naturalHeight || natural.height,
                    },
                };
            }),
        );
        message.success(t("canvas.shortcut.restoreSizeDone", { count: eligible.length }));
    }, [message, t]);

    // Backquote shortcut: put the selected node window(s) back to the size they were created
    // with. Media nodes are filled into a per-type default box the moment their content
    // arrives — every generation path funnels through fitNodeSize(natural, NODE_DEFAULT_SIZE
    // ...) — so restoring "the initial size" means restoring that very same box. The 640×640
    // "100% display" box used by the media scale menu is deliberately NOT reused here: it makes
    // an image window jump to a size the user never saw (that is what the "." shortcut and the
    // image toolbar "original size" action do). Every non-media node falls back to its registry
    // default size. Windows keep their centre and the free-resize lock is restored.
    const resetSelectedNodesWindowSize = useCallback((explicitIds?: Iterable<string>) => {
        const selectedIds = new Set(explicitIds || selectedNodeIdsRef.current);
        if (!selectedIds.size) {
            const fallbackId = toolbarNodeIdRef.current || hoveredNodeIdRef.current;
            if (fallbackId) selectedIds.add(fallbackId);
        }
        if (!selectedIds.size) {
            message.warning(t("canvas.shortcut.selectNodeToResetWindow"));
            return;
        }

        const targetSizeFor = (node: CanvasNodeData) => {
            const spec = getNodeSpec(node.type);
            if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Annotate) {
                const natural = resolveNodeMediaNaturalSize(node);
                if (natural && natural.width > 0 && natural.height > 0) {
                    if (node.type === CanvasNodeType.Video) return fitNodeSize(natural.width, natural.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    return fitNodeSize(natural.width, natural.height, spec.width, spec.height);
                }
            }
            return { width: spec.width, height: spec.height };
        };

        const eligible = nodesRef.current.filter((node) => {
            if (!selectedIds.has(node.id)) return false;
            // A group is a container region, not a window: shrinking it would strand its children.
            if (node.type === CanvasNodeType.Group) return false;
            const target = targetSizeFor(node);
            const sizeChanged = Math.abs(target.width - node.width) >= 1 || Math.abs(target.height - node.height) >= 1;
            return sizeChanged || Boolean(node.metadata?.freeResize);
        });

        if (!eligible.length) {
            message.info(t("canvas.shortcut.resetWindowAlready"));
            return;
        }

        const eligibleIds = new Set(eligible.map((node) => node.id));
        setNodes((prev) =>
            prev.map((node) => {
                if (!eligibleIds.has(node.id)) return node;
                const target = targetSizeFor(node);
                const nextWidth = Math.max(1, Math.round(target.width));
                const nextHeight = Math.max(1, Math.round(target.height));
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                return {
                    ...node,
                    width: nextWidth,
                    height: nextHeight,
                    position: { x: centerX - nextWidth / 2, y: centerY - nextHeight / 2 },
                    metadata: { ...node.metadata, freeResize: false },
                };
            }),
        );
        message.success(t("canvas.shortcut.resetWindowDone", { count: eligible.length }));
    }, [message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            // Let native copy/paste/select work inside text fields and edit dialogs.
            // Do not treat data-canvas-no-zoom as a shortcut blocker (videos/prompt chrome use it only to disable wheel zoom).
            if (
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement ||
                event.target instanceof HTMLSelectElement ||
                target?.closest("[contenteditable],[data-canvas-text-input],[data-canvas-shortcuts-ignore],.ant-modal,.ant-input,.ant-input-textarea")
            ) {
                return;
            }

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            // "." is the media-only "100% display box" reset shared with the image toolbar
            // ("original size"): it re-fits media into fitNodeSize(natural, 640, 640).
            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === ".") {
                event.preventDefault();
                resetSelectedNodesToOriginalSize();
                return;
            }

            // "`" (and Backquote on layouts where key is remapped) restores the selected node
            // window(s) to the size they were created with (per-type default box for media,
            // registry default for everything else). "." stays separate: it is the media-only
            // "100% display box" action shared with the image toolbar.
            if (!isModifierShortcut && !event.altKey && !event.shiftKey && (event.key === "`" || event.code === "Backquote")) {
                event.preventDefault();
                resetSelectedNodesWindowSize();
                return;
            }

            if (isModifierShortcut && (key === "c" || key === "v" || key === "x" || key === "a") && isCanvasTextInteractionTarget(event.target)) return;
            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "s") {
                event.preventDefault();
                void handleDraftShortcut();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.altKey && !isModifierShortcut && !event.shiftKey && key === "q") {
                event.preventDefault();
                if (selectedNodeIdsRef.current.size) deleteNodes(new Set(selectedNodeIdsRef.current));
                else if (selectedConnectionId) deleteConnection(selectedConnectionId);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "q") {
                event.preventDefault();
                createNode(CanvasNodeType.Chat);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "e") {
                event.preventDefault();
                createNode(CanvasNodeType.Text);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "w") {
                event.preventDefault();
                createNode(CanvasNodeType.Image);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "r") {
                event.preventDefault();
                createNode(CanvasNodeType.Video);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "t") {
                event.preventDefault();
                createNode(CanvasNodeType.Audio);
                return;
            }

            // Z = 脚本生成器（分镜脚本节点）。Ctrl/Cmd+Z 是撤销，上面已提前 return，不会冲突。
            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "z") {
                event.preventDefault();
                createNode(CanvasNodeType.Script);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "f") {
                event.preventDefault();
                if (selectedNodeIdsRef.current.size !== 1) {
                    message.warning(t("canvas.shortcut.selectNodeToFocus"));
                    return;
                }
                focusNode(Array.from(selectedNodeIdsRef.current)[0]);
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "c") {
                event.preventDefault();
                duplicateSelectedMediaAsNode();
                return;
            }

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "x") {
                event.preventDefault();
                if (connectingParamsRef.current) {
                    setConnecting(null);
                    setPendingConnectionCreate(null);
                    message.info(t("canvas.shortcut.connectCanceled"));
                    return;
                }
                if (selectedNodeIdsRef.current.size !== 1) {
                    message.warning(t("canvas.shortcut.selectNodeToConnect"));
                    return;
                }
                const outputNodeId = Array.from(selectedNodeIdsRef.current)[0];
                const outputNode = nodesRef.current.find((node) => node.id === outputNodeId);
                if (!outputNode) {
                    message.warning(t("canvas.shortcut.selectNodeToConnect"));
                    return;
                }
                // Sticky X: selected node stays the receiver; click many providers until X/Esc.
                // 脚本节点**不走特例**：X 选中脚本节点后逐个点其他节点，即可把它们连进脚本节点 ——
                // 连进来的素材就成了「整表资产池」，这正是「按 X 拾取节点加入资产池」。
                // 想用弹窗添加资产，请点节点里的「+ 添加资产」按钮（节点内容区的 assetEntryRow）。
                setMouseWorld({ x: outputNode.position.x, y: outputNode.position.y + outputNode.height / 2 });
                setConnecting({ nodeId: outputNodeId, handleType: "target", sticky: true });
                setSelectedNodeIds(new Set([outputNodeId]));
                setToolbarNodeId(outputNodeId);
                setSelectedConnectionId(null);
                setPendingConnectionCreate(null);
                message.info(t("canvas.shortcut.connectHint"));
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setAnnotateNodeId(null);
                setPanoramaNodeId(null);
                setAdjustNodeId(null);
                setTextEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, createNode, deleteConnection, deleteNodes, duplicateSelectedMediaAsNode, focusNode, handleDraftShortcut, message, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, resetSelectedNodesToOriginalSize, resetSelectedNodesWindowSize, selectedConnectionId, setConnecting, t, undoCanvas]);

    // Space toggles the active media node (an activated video, or a single-selected audio). This
    // runs in the capture phase so it can consume the event before the canvas pan listener (also
    // on window, bubble phase) turns Space into a pan. No active media → the event falls through
    // and Space pans as usual.
    useEffect(() => {
        const handleMediaSpace = (event: KeyboardEvent) => {
            if (event.code !== "Space" || event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target instanceof Element ? event.target : null;
            if (
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement ||
                event.target instanceof HTMLSelectElement ||
                target?.closest("[contenteditable],[data-canvas-text-input],[data-canvas-shortcuts-ignore],.ant-modal,.ant-input,.ant-input-textarea")
            ) {
                return;
            }
            const selectedId = selectedNodeIdsRef.current.size === 1 ? Array.from(selectedNodeIdsRef.current)[0] : null;
            const activeMedia = selectedId ? getCanvasMediaToggle(selectedId) : null;
            // A video still showing its poster registers no `toggle`, so Space stays canvas-pan.
            if (!activeMedia?.toggle) return;
            event.preventDefault();
            event.stopPropagation();
            activeMedia.toggle();
        };
        window.addEventListener("keydown", handleMediaSpace, true);
        return () => window.removeEventListener("keydown", handleMediaSpace, true);
    }, []);

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement ||
                event.target instanceof HTMLSelectElement ||
                target?.closest("[contenteditable],[data-canvas-text-input],[data-canvas-shortcuts-ignore],.ant-modal,.ant-input,.ant-input-textarea")
            ) {
                return;
            }

            const items = Array.from(event.clipboardData?.items || []);
            const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
            const imageFile = imageItem?.getAsFile();
            if (!imageFile) return;

            event.preventDefault();
            const file = imageFile.name ? imageFile : new File([imageFile], "clipboard-image.png", { type: imageFile.type || "image/png" });
            pasteClipboardImageFile(file);
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [pasteClipboardImageFile]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
    }, []);
    const handleNodeResizeEnd = useCallback(() => {
        setIsNodeResizing(false);
        // Corner-resize often leaves focus inside the prompt panel; blur so G/F shortcuts work right after.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[data-canvas-shortcuts-ignore],[contenteditable],[data-canvas-text-input]")) {
            active.blur();
        }
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const scaleImageNodeDisplay = useCallback(
        async (node: CanvasNodeData, percent: number, options?: { silent?: boolean }) => {
            if (!node.metadata?.content) {
                if (!options?.silent) message.warning(t("canvas.shortcut.scaleNeedMedia"));
                return false;
            }
            if (percent >= 100) {
                if (!options?.silent) {
                    message.info(t("canvas.editors.scaleAlreadyFull"));
                    setScaleNodeId(null);
                }
                return false;
            }
            try {
                const sourceDataUrl = await imageToDataUrl({
                    url: node.metadata.content,
                    storageKey: node.metadata.storageKey,
                });
                const resized = await resizeDataUrlByPercent(sourceDataUrl, percent);
                if (!resized.changed) {
                    if (!options?.silent) {
                        message.info(t("canvas.editors.scaleAlreadyFull"));
                        setScaleNodeId(null);
                    }
                    return false;
                }
                const uploaded = await uploadImage(resized.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height);
                const centerX = node.position.x + node.width / 2;
                const centerY = node.position.y + node.height / 2;
                setNodes((prev) => {
                    const next = prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const primaryId = item.metadata?.primaryImageId;
                        const images = item.metadata?.images?.map((image) =>
                            image.id === primaryId || (!primaryId && image.content === item.metadata?.content)
                                ? {
                                      ...image,
                                      content: uploaded.url,
                                      storageKey: uploaded.storageKey,
                                      naturalWidth: uploaded.width,
                                      naturalHeight: uploaded.height,
                                      bytes: uploaded.bytes,
                                      mimeType: uploaded.mimeType || image.mimeType,
                                      thumbnailContent: undefined,
                                      thumbnailStorageKey: undefined,
                                  }
                                : image,
                        );
                        return {
                            ...item,
                            width: size.width,
                            height: size.height,
                            position: { x: centerX - size.width / 2, y: centerY - size.height / 2 },
                            metadata: {
                                ...item.metadata,
                                ...imageMetadata(uploaded),
                                freeResize: false,
                                images,
                                primaryImageId: primaryId || item.metadata?.primaryImageId,
                                prompt: item.metadata?.prompt,
                                status: NODE_STATUS_SUCCESS,
                                errorDetails: undefined,
                            },
                        };
                    });
                    nodesRef.current = next;
                    return next;
                });
                if (!options?.silent) {
                    setScaleNodeId(null);
                    message.success(t("canvas.projectPage.scaleApplied", { percent, width: uploaded.width, height: uploaded.height }));
                }
                return true;
            } catch (error) {
                if (options?.silent) throw error;
                message.error(error instanceof Error ? error.message : t("canvas.editors.scaleFailed"));
                return false;
            }
        },
        [message, t],
    );

    /** G: one-shot 99% pixel downscale and overwrite selected image/annotate nodes. */
    const downscaleSelectedImagesTo99 = useCallback(async () => {
        const selectedIds = new Set(selectedNodeIdsRef.current);
        if (!selectedIds.size) {
            const fallbackId = toolbarNodeIdRef.current || hoveredNodeIdRef.current;
            if (fallbackId) selectedIds.add(fallbackId);
        }
        if (!selectedIds.size) {
            message.warning(t("canvas.shortcut.selectNodeToResetSize"));
            return;
        }

        const eligible = nodesRef.current.filter(
            (node) =>
                selectedIds.has(node.id) &&
                (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Annotate) &&
                Boolean(node.metadata?.content),
        );
        if (!eligible.length) {
            message.warning(t("canvas.shortcut.scaleNeedMedia"));
            return;
        }

        let successCount = 0;
        let lastError: unknown;
        for (const node of eligible) {
            const latest = nodesRef.current.find((item) => item.id === node.id) || node;
            try {
                const ok = await scaleImageNodeDisplay(latest, 99, { silent: true });
                if (ok) successCount += 1;
            } catch (error) {
                lastError = error;
            }
        }

        if (successCount) {
            message.success(t("canvas.shortcut.resetSizeDone", { count: successCount }));
            return;
        }
        if (lastError) {
            message.error(lastError instanceof Error ? lastError.message : t("canvas.editors.scaleFailed"));
            return;
        }
        message.info(t("canvas.editors.scaleAlreadyFull"));
    }, [message, scaleImageNodeDisplay, t]);

    // Capture-phase G: 99% pixel downscale overwrite (IME-safe KeyG).
    useEffect(() => {
        const handleDownscaleShortcut = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            if (event.code !== "KeyG" && event.key.toLowerCase() !== "g") return;
            if (isImeComposing(event)) return;

            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
            if (target instanceof HTMLElement && target.isContentEditable) return;
            if (target instanceof Element && target.closest(".ant-modal")) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            blurActiveCanvasTextInput();
            void downscaleSelectedImagesTo99();
        };

        window.addEventListener("keydown", handleDownscaleShortcut, true);
        return () => window.removeEventListener("keydown", handleDownscaleShortcut, true);
    }, [downscaleSelectedImagesTo99]);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedImageNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, imageId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const image = node.metadata?.images?.find((item) => item.id === imageId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        thumbnailContent: image.thumbnailContent,
                        thumbnailStorageKey: image.thumbnailStorageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const isVideo = node.type === CanvasNodeType.Video;
        const size = isVideo
            ? fitNodeSize(image.naturalWidth || node.width, image.naturalHeight || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT)
            : fitNodeSize(image.naturalWidth, image.naturalHeight, Math.max(node.width, node.height), Math.max(node.width, node.height));
        const copy: CanvasNodeData = {
            id,
            type: isVideo ? CanvasNodeType.Video : CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                thumbnailContent: image.thumbnailContent,
                thumbnailStorageKey: image.thumbnailStorageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
                seconds: node.metadata?.seconds,
                vquality: node.metadata?.vquality,
                generateAudio: node.metadata?.generateAudio,
                watermark: node.metadata?.watermark,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback(
        (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== nodeId) return node;
                    const basePatch = patch || {};
                    let nextPatch = basePatch;
                    // Switching video model → snap to that family's default resolution/audio mode.
                    // Manual vquality / audioMode edits after that stay until the next model switch
                    // (explicit values in the same patch win over the family default).
                    if (typeof basePatch.model === "string" && basePatch.model) {
                        const mode =
                            node.metadata?.generationMode ||
                            (node.type === CanvasNodeType.Video
                                ? "video"
                                : node.type === CanvasNodeType.Audio
                                  ? "audio"
                                  : node.type === CanvasNodeType.Text
                                    ? "text"
                                    : "image");
                        if (mode === "video" || node.type === CanvasNodeType.Video) {
                            const defaults = resolveNativeH3VideoSettingDefaults(
                                basePatch.model,
                                resolveModelScript(effectiveConfig, basePatch.model),
                            );
                            nextPatch = {
                                ...basePatch,
                                ...(defaults.vquality && basePatch.vquality === undefined ? { vquality: defaults.vquality } : {}),
                                ...(defaults.videoAudioMode && basePatch.audioMode === undefined
                                    ? { audioMode: defaults.videoAudioMode }
                                    : {}),
                            };
                        }
                    }
                    return applyNodeConfigPatch(node, nextPatch);
                }),
            );
        },
        [effectiveConfig],
    );

    const downloadNodeImage = useCallback(
        async (node: CanvasNodeData, options?: { textFormat?: TextExportFormat }) => {
            try {
                if (node.type === CanvasNodeType.Text) {
                    const content = (node.metadata?.content || node.metadata?.prompt || "").trim();
                    if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                    const rawName = (node.title || t("canvas.projectPage.canvasText")).trim() || "document";
                    const safeName = rawName.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 48) || "document";
                    // Word is the default: the node's markdown is turned into real headings/lists, so
                    // the .docx opens formatted rather than showing raw "#" and "**" markers.
                    // Markdown is kept verbatim for people who want the source.
                    const format: TextExportFormat = options?.textFormat ?? "docx";
                    const blob = format === "md" ? buildMarkdownBlob(content) : buildDocxBlob(content, { title: rawName });
                    const result = await saveBlobAs(blob, `${safeName}.${format === "md" ? "md" : "docx"}`, { projectId });
                    if (result.method === "draft") {
                        message.success(t("canvas.draft.savedToFolder", { name: result.fileName, folder: result.folderName || "" }));
                    } else {
                        message.success(t("canvas.nodeToolbar.exportDocumentDone", { name: result.fileName }));
                        if (draftMeta && !draftMeta.hasDirectory) message.warning(t("canvas.draft.rebindForFolderSave"));
                    }
                    return;
                }
                if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Annotate && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
                // mp4 for a WebM/Audio payload would be a container the bytes do not have, so ask the
                // mime: save-blob re-types the blob after the extension it is given.
                const extension = node.type === CanvasNodeType.Video ? videoExtension(node.metadata.mimeType) : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content);
                const result = await saveBlobAs(node.metadata.content, `canvas-${node.type}-${node.id}.${extension}`, { projectId });
                if (result.method === "draft") {
                    message.success(t("canvas.draft.savedToFolder", { name: result.fileName, folder: result.folderName || "" }));
                } else if (result.method === "download" && draftMeta && !draftMeta.hasDirectory) {
                    message.warning(t("canvas.draft.rebindForFolderSave"));
                }
            } catch (error) {
                // A dead blob URL, a lost folder permission or a CORS-blocked remote URL used to
                // escape as an unhandled rejection and the click appeared to do nothing.
                message.error(`${t("common.downloadFailed")}: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        [draftMeta, message, projectId, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(
                    CanvasNodeType.Text,
                    { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY },
                    { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: DEFAULT_CANVAS_FONT_SIZE },
                ),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const adjustImageNode = useCallback(async (node: CanvasNodeData, params: ImageAdjustParams) => {
        if (!node.metadata?.content) return;
        const adjusted = await adjustDataUrl(node.metadata.content, params);
        const image = await uploadImage(adjusted);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Adjusted Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setAdjustNodeId(null);
    }, []);

    const openVideoTools = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning(t("canvas.node.emptyVideo"));
            return;
        }
        setVideoToolsNodeId(node.id);
    }, [message, t]);

    const openAudioTools = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning(t("canvas.node.emptyAudio"));
            return;
        }
        setAudioToolsNodeId(node.id);
    }, [message, t]);

    const createAdjacentVideoNode = useCallback(async (source: CanvasNodeData, videoFile: Awaited<ReturnType<typeof storeGeneratedVideo>>, title: string) => {
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const width = Math.min(Math.max(spec.width, source.width), 640);
        const height = videoFile.width && videoFile.height ? width * (videoFile.height / videoFile.width) : spec.height;
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Video,
            title,
            position: { x: source.position.x + source.width + 96, y: source.position.y },
            width,
            height,
            metadata: {
                ...videoMetadata(videoFile),
                prompt: source.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: source.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setVideoToolsNodeId(null);
        return childId;
    }, []);

    // Extra outputs one generation run produced (e.g. RunningHub storyboard workflows return every
    // frame at once): upload each and drop standalone image nodes to the right of the anchor node,
    // connected to it so the lineage stays visible. One failed upload skips only its own frame.
    const spawnExtraImageNodes = useCallback(async (baseNodeId: string, dataUrls: string[], meta?: { prompt?: string; model?: string }) => {
        if (!dataUrls.length) return;
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        let stackOffsetY = 0;
        for (const dataUrl of dataUrls) {
            try {
                const uploaded = await uploadGeneratedImage({ dataUrl });
                const imageSize = fitNodeSize(uploaded.width, uploaded.height, spec.width, spec.height);
                const item = canvasNodeImageFromUpload(nanoid(), uploaded);
                const nodeId = nanoid();
                const anchor = nodesRef.current.find((node) => node.id === baseNodeId);
                // Compute anchor fallbacks without re-narrowing `anchor` inside a ternary false branch
                // (this TS version types the narrowed-undefined optional chain as `never`).
                const anchorX = (anchor?.position.x ?? 0) + (anchor ? anchor.width + 96 : 0);
                const anchorY = anchor?.position.y ?? 0;
                const position = { x: anchorX, y: anchorY + stackOffsetY };
                stackOffsetY += imageSize.height + 48;
                const extra: CanvasNodeData = {
                    id: nodeId,
                    type: CanvasNodeType.Image,
                    title: (meta?.prompt || "").slice(0, 32) || "Storyboard",
                    position,
                    width: imageSize.width,
                    height: imageSize.height,
                    metadata: {
                        ...(meta?.prompt ? { prompt: meta.prompt } : {}),
                        ...(meta?.model ? { model: meta.model } : {}),
                        ...imageMetadata(uploaded),
                        images: [item],
                        primaryImageId: item.id,
                    },
                };
                setNodes((prev) => [...prev, extra]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: baseNodeId, toNodeId: nodeId }]);
            } catch {
                // Skip this frame only; keep placing the rest.
            }
        }
    }, []);

    // Videos a multi-output image workflow produced alongside the frames (e.g. RunningHub
    // storyboard): store each and drop standalone video nodes below the anchor node, connected
    // to it. One failed download skips only its own video.
    const spawnExtraVideoNodes = useCallback(async (baseNodeId: string, videoUrls: string[], meta?: { prompt?: string; model?: string }) => {
        if (!videoUrls.length) return;
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        let stackOffsetY = 0;
        for (const url of videoUrls) {
            try {
                const uploaded = await storeGeneratedVideo({ url, mimeType: "video/mp4" });
                const videoSize = fitNodeSize(uploaded.width || spec.width, uploaded.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const versionId = nanoid();
                const version: CanvasNodeImage = {
                    id: versionId,
                    status: NODE_STATUS_SUCCESS,
                    content: uploaded.url,
                    storageKey: uploaded.storageKey || "",
                    naturalWidth: uploaded.width || 0,
                    naturalHeight: uploaded.height || 0,
                    bytes: uploaded.bytes || 0,
                    mimeType: uploaded.mimeType || "video/mp4",
                };
                const nodeId = nanoid();
                const anchor = nodesRef.current.find((node) => node.id === baseNodeId);
                const anchorX = anchor?.position.x ?? 0;
                const anchorY = (anchor?.position.y ?? 0) + (anchor ? anchor.height + 96 : 0);
                const position = { x: anchorX, y: anchorY + stackOffsetY };
                stackOffsetY += videoSize.height + 48;
                const extra: CanvasNodeData = {
                    id: nodeId,
                    type: CanvasNodeType.Video,
                    title: (meta?.prompt || "").slice(0, 32) || "Video",
                    position,
                    width: videoSize.width,
                    height: videoSize.height,
                    metadata: {
                        ...(meta?.prompt ? { prompt: meta.prompt } : {}),
                        ...(meta?.model ? { model: meta.model } : {}),
                        ...videoMetadata(uploaded),
                        images: [version],
                        primaryImageId: versionId,
                    },
                };
                setNodes((prev) => [...prev, extra]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: baseNodeId, toNodeId: nodeId }]);
            } catch {
                // Skip this video only; keep placing the rest.
            }
        }
    }, []);

    const handleVideoTrim = useCallback(
        async (result: VideoToolsTrimResult) => {
            const source = videoToolsNode;
            if (!source) return;
            const stored = await storeGeneratedVideo({ blob: result.blob, mimeType: "video/mp4" });
            await createAdjacentVideoNode(source, stored, t("canvas.videoTools.trimSuccess"));
            message.success(t("canvas.videoTools.trimSuccess"));
        },
        [createAdjacentVideoNode, message, t, videoToolsNode],
    );

    const handleAudioTrim = useCallback(
        async (result: AudioToolsTrimResult) => {
            const source = audioToolsNode;
            if (!source?.metadata?.content) return;
            const format = result.blob.type.includes("wav") ? "wav" : "mp3";
            const stored = await storeGeneratedAudio(result.blob, format);
            const previous = {
                content: source.metadata.content,
                storageKey: source.metadata.storageKey,
                mimeType: source.metadata.mimeType,
                bytes: source.metadata.bytes,
                durationMs: source.metadata.durationMs,
            };
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== source.id) return node;
                    const history = [...(node.metadata?.audioHistory || []), previous].slice(-8);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            ...audioMetadata(stored),
                            audioHistory: history,
                            errorDetails: undefined,
                        },
                    };
                }),
            );
            message.success(t("canvas.audioTools.trimSuccess"));
        },
        [audioToolsNode, message, t],
    );

    const handleAudioRestore = useCallback(() => {
        const source = audioToolsNode;
        if (!source) return;
        const history = source.metadata?.audioHistory || [];
        const previous = history[history.length - 1];
        if (!previous?.content) {
            message.warning(t("canvas.audioTools.restoreEmpty"));
            return;
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== source.id) return node;
                const nextHistory = history.slice(0, -1);
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        content: previous.content,
                        storageKey: previous.storageKey,
                        mimeType: previous.mimeType,
                        bytes: previous.bytes,
                        durationMs: previous.durationMs,
                        audioHistory: nextHistory.length ? nextHistory : undefined,
                        status: NODE_STATUS_SUCCESS,
                        errorDetails: undefined,
                    },
                };
            }),
        );
        message.success(t("canvas.audioTools.restoreSuccess"));
    }, [audioToolsNode, message, t]);

    const audioMergeCandidates = useMemo<AudioMergeCandidate[]>(
        () =>
            nodes
                // Empty audio nodes are listed too (marked "empty") so users can still open the
                // dialog and pick nodes; nodes without content are skipped at merge time.
                .filter((node) => node.type === CanvasNodeType.Audio)
                .map((node) => ({
                    id: node.id,
                    title: node.metadata?.content ? node.title || t("canvas.nodeTypes.audio") : `${node.title || t("canvas.nodeTypes.audio")}（空）`,
                    url: node.metadata?.content || "",
                    durationMs: node.metadata?.durationMs,
                    empty: !node.metadata?.content,
                })),
        [nodes, t],
    );

    const openAudioMerge = useCallback(() => {
        if (audioMergeCandidates.length < 2) {
            message.warning(t("canvas.audioMerge.notEnough"));
            return;
        }
        // Pre-select the currently selected audio nodes when possible; otherwise select all.
        const preSelected = audioMergeCandidates
            .filter((candidate) => selectedNodeIdsRef.current.has(candidate.id))
            .map((candidate) => candidate.id);
        const initial = preSelected.length >= 2 ? preSelected : audioMergeCandidates.map((candidate) => candidate.id);
        setAudioMergeSelected(initial);
        audioMergeSelectedRef.current = initial;
        setAudioMergePicking(false);
        audioMergePickingRef.current = false;
        setAudioMergeOpen(true);
    }, [audioMergeCandidates, message, t]);

    const handleAudioMerge = useCallback(
        async (blob: Blob) => {
            const format = blob.type.includes("wav") ? "wav" : "mp3";
            const stored = await storeGeneratedAudio(blob, format);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Audio,
                title: t("canvas.audioMerge.resultTitle"),
                position: { x: 0, y: 0 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(stored),
            };
            setNodes((prev) => [...prev, child]);
            setSelectedNodeIds(new Set([childId]));
            setAudioMergeOpen(false);
            setAudioMergePicking(false);
            audioMergePickingRef.current = false;
            message.success(t("canvas.audioMerge.success"));
        },
        [message, t],
    );

    const handleVideoFrame = useCallback(
        async (result: VideoToolsFrameResult) => {
            const source = videoToolsNode;
            if (!source) return;
            const image = await uploadImage(result.dataUrl);
            const width = Math.min(source.width, Math.max(220, image.width));
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: t("canvas.videoTools.frameSuccess"),
                position: { x: source.position.x + source.width + 96, y: source.position.y },
                width,
                height: width * (image.height / image.width),
                metadata: {
                    ...imageMetadata(image),
                    prompt: source.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: source.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setVideoToolsNodeId(null);
            message.success(t("canvas.videoTools.frameSuccess"));
        },
        [message, t, videoToolsNode],
    );

    const handleVideoUpscale = useCallback(
        async (result: VideoToolsUpscaleResult, signal?: AbortSignal) => {
            const source = videoToolsNode;
            if (!source?.metadata?.content) return;
            const blob = await loadVideoBlob(source.metadata.content);
            const upscaleConfig = { ...effectiveConfig, model: result.model, videoModel: result.model };
            const publicUrl = /^https?:\/\//i.test(source.metadata.content)
                ? source.metadata.content
                : await uploadProviderMediaFile(upscaleConfig, blob, "source.mp4", { signal });
            const generated = await requestVideoUpscale(upscaleConfig, { videoUrl: publicUrl, resolution: result.resolution, signal });
            const stored = await storeGeneratedVideo(generated);
            await createAdjacentVideoNode(source, stored, t("canvas.videoTools.upscaleSuccess"));
            message.success(t("canvas.videoTools.upscaleSuccess"));
        },
        [createAdjacentVideoNode, effectiveConfig, message, t, videoToolsNode],
    );

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const groupId = nanoid();
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                            grid: {
                                groupId,
                                row: piece.row,
                                column: piece.column,
                                rows: params.rows,
                                columns: params.columns,
                            },
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    const runMergeNode = useCallback(
        async (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node || node.type !== CanvasNodeType.Merge) return;
            const inputs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current).filter((input) => input.type === "image" && input.image?.dataUrl);
            if (inputs.length < 2) {
                message.warning(t("canvas.projectPage.mergeNeedImages"));
                return;
            }
            const rows = Math.max(1, node.metadata?.mergeRows || 2);
            const columns = Math.max(1, node.metadata?.mergeColumns || 2);
            const capacity = rows * columns;
            const preferred = (node.metadata?.mergeSlotIds || []).slice(0, capacity);
            const used = new Set<string>();
            const slots: Array<string | null> = Array.from({ length: capacity }, (_, index) => {
                const id = preferred[index] || null;
                if (id && inputs.some((input) => input.nodeId === id) && !used.has(id)) {
                    used.add(id);
                    return id;
                }
                return null;
            });
            for (const input of inputs) {
                if (used.has(input.nodeId)) continue;
                const empty = slots.findIndex((item) => !item);
                if (empty < 0) break;
                slots[empty] = input.nodeId;
                used.add(input.nodeId);
            }
            const inputById = new Map(inputs.map((input) => [input.nodeId, input]));
            const offsets = node.metadata?.mergeOffsets || {};
            const pieces = slots
                .map((sourceId, index) => {
                    if (!sourceId) return null;
                    const input = inputById.get(sourceId);
                    if (!input?.image?.dataUrl) return null;
                    const focus = offsets[sourceId] || { x: 0.5, y: 0.5 };
                    return {
                        row: Math.floor(index / columns),
                        column: index % columns,
                        dataUrl: input.image.dataUrl,
                        offsetX: focus.x,
                        offsetY: focus.y,
                    };
                })
                .filter(Boolean) as Array<{ row: number; column: number; dataUrl: string; offsetX: number; offsetY: number }>;
            if (pieces.length < 2) {
                message.warning(t("canvas.projectPage.mergeNeedImages"));
                return;
            }

            setRunningNodeId(nodeId);
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            try {
                const merged = await mergeDataUrls({
                    rows,
                    columns,
                    pieces,
                    aspectRatio: node.metadata?.mergeAspectRatio || null,
                });
                const uploaded = await uploadImage(merged);
                const size = fitNodeSize(uploaded.width, uploaded.height);
                const childId = nanoid();
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: t("canvas.projectPage.mergeResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: {
                        ...imageMetadata(uploaded),
                    },
                };
                const sourceIds = pieces
                    .map((_, index) => slots[index])
                    .filter((id): id is string => Boolean(id));
                setNodes((prev) => [...prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item)), child]);
                setConnections((prev) => [...prev, ...sourceIds.map((fromNodeId) => ({ id: nanoid(), fromNodeId, toNodeId: childId }))]);
                setSelectedNodeIds(new Set([childId]));
                setSelectedConnectionId(null);
                message.success(t("canvas.projectPage.mergeSuccess", { count: pieces.length }));
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.mergeFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                setRunningNodeId(null);
            }
        },
        [message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = t("canvas.projectPage.maskPrompt", { prompt: userPrompt });
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadGeneratedImage(image);
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const saveAnnotateNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasAnnotateSavePayload) => {
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  annotations: payload.annotations,
                              },
                          }
                        : item,
                ),
            );
            if (!payload.bakedDataUrl) {
                setAnnotateNodeId(null);
                message.success(t("canvas.projectPage.annotateSaved"));
                return;
            }
            const uploaded = await uploadImage(payload.bakedDataUrl);
            const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
            const childId = nanoid();
            setNodes((prev) => [
                ...prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, annotations: payload.annotations } } : item)),
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: t("canvas.projectPage.annotateBaked"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: { ...imageMetadata(uploaded), prompt: node.metadata?.prompt },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setAnnotateNodeId(null);
            message.success(t("canvas.projectPage.annotateBakedSuccess"));
        },
        [message, t],
    );

    const inpaintAnnotateNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasAnnotateInpaintPayload) => {
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, annotations: payload.annotations } } : item)));
            setAnnotateNodeId(null);
            await maskEditImageNode(node, { prompt: payload.prompt, maskDataUrl: payload.maskDataUrl });
        },
        [maskEditImageNode],
    );

    const addTextNodeFromAnnotate = useCallback(
        (node: CanvasNodeData, text: string) => {
            const textNode = createCanvasNode(CanvasNodeType.Text, {
                x: node.position.x + node.width + 96 + getNodeSpec(CanvasNodeType.Text).width / 2,
                y: node.position.y + getNodeSpec(CanvasNodeType.Text).height / 2,
            }, { content: text, status: "idle", fontSize: DEFAULT_CANVAS_FONT_SIZE });
            setNodes((prev) => [...prev, textNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: textNode.id }]);
            setSelectedNodeIds(new Set([textNode.id]));
            message.success(t("canvas.projectPage.annotateTextNodeAdded"));
        },
        [message, t],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, []);

    const openImageUpscale = useCallback((node: CanvasNodeData) => {
        const primary = node.metadata?.primaryImageId ? node.metadata.images?.find((image) => image.id === node.metadata?.primaryImageId) : undefined;
        const taskId = node.metadata?.midjourneyTaskId || primary?.midjourneyTaskId || node.metadata?.images?.find((image) => image.midjourneyTaskId)?.midjourneyTaskId;
        if (taskId) {
            setMjUpscaleNodeId(node.id);
            return;
        }
        setUpscaleNodeId(node.id);
    }, []);

    const midjourneyUpscaleImageNode = useCallback(
        async (node: CanvasNodeData, index: number) => {
            const primary = node.metadata?.primaryImageId ? node.metadata.images?.find((image) => image.id === node.metadata?.primaryImageId) : undefined;
            const taskId = node.metadata?.midjourneyTaskId || primary?.midjourneyTaskId || node.metadata?.images?.find((image) => image.midjourneyTaskId)?.midjourneyTaskId;
            if (!taskId) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            setMjUpscaleNodeId(null);
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: `Upscale U${index}`,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: node.metadata?.prompt, status: NODE_STATUS_LOADING, model: generationConfig.model },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestMidjourneyUpscale(generationConfig, taskId, index, { signal: controller.signal }).then((items) => items[0]);
                if (!image?.dataUrl) throw new Error(t("canvas.projectPage.generationFailed"));
                const uploaded = await uploadGeneratedImage(image);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  ...size,
                                  position: {
                                      x: node.position.x + node.width + 96,
                                      y: node.position.y + node.height / 2 - size.height / 2,
                                  },
                                  metadata: {
                                      ...item.metadata,
                                      ...imageMetadata(uploaded),
                                      prompt: node.metadata?.prompt,
                                      model: generationConfig.model,
                                      status: NODE_STATUS_SUCCESS,
                                      errorDetails: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                message.success(t("canvas.projectPage.mjUpscaleSuccess", { index }));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
                message.error(errorDetails);
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    undefined,
                    { signal: controller.signal },
                ).then((items) => items[0]);
                const uploaded = await uploadGeneratedImage(image);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, openConfigDialog, startGenerationRequest, t],
    );

    const capturePanoramaShot = useCallback(
        async (node: CanvasNodeData, payload: PanoramaCapturePayload) => {
            const uploaded = await uploadImage(payload.dataUrl);
            const size = fitNodeSize(uploaded.width, uploaded.height, Math.max(node.width, 420), Math.max(node.height, 240));
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: payload.label,
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: size.width,
                height: size.height,
                metadata: {
                    ...imageMetadata(uploaded),
                    prompt: node.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            message.success(t("canvas.projectPage.panoramaCaptured"));
        },
        [message, t],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        const next = Math.max(10, Math.min(48, Math.round(fontSize)));
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize: next } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f) || isDocumentFile(f));
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const STAGGER = 40; // Offset between multiple imported files.

            const createByFile = (file: File, position: Position) => {
                if (isDocumentFile(file)) void createDocumentTextNode(file, position);
                else if (isAudioFile(file)) void createAudioFileNode(file, position);
                else if (file.type.startsWith("video/")) void createVideoFileNode(file, position);
                else void createImageFileNode(file, position);
            };

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;
                const targetNode = nodesRef.current.find((node) => node.id === target.nodeId);

                if (isDocumentFile(first)) {
                    if (targetNode?.type === CanvasNodeType.Text) await applyDocumentToTextNode(target.nodeId, first);
                    else await createDocumentTextNode(first, basePosition);
                } else if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    const keepAnnotate = targetNode?.type === CanvasNodeType.Annotate;
                    setNodes((prev) =>
                        prev.map((node) => {
                            if (node.id !== target.nodeId) return node;
                            return {
                                ...node,
                                type: keepAnnotate ? CanvasNodeType.Annotate : CanvasNodeType.Image,
                                title: first.name,
                                width: s.width,
                                height: s.height,
                                metadata: {
                                    ...node.metadata,
                                    ...imageMetadata(image),
                                    errorDetails: undefined,
                                    freeResize: false,
                                    images: undefined,
                                    generationType: undefined,
                                    model: undefined,
                                    size: undefined,
                                    quality: undefined,
                                    count: undefined,
                                    references: undefined,
                                    primaryImageId: undefined,
                                    annotations: keepAnnotate ? node.metadata?.annotations || [] : undefined,
                                },
                            };
                        }),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    if (keepAnnotate) setAnnotateNodeId(target.nodeId);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    createByFile(rest[i], { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER });
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    createByFile(files[i], { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER });
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [applyDocumentToTextNode, createAudioFileNode, createDocumentTextNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter((item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item) || isDocumentFile(item));
            if (!files.length) {
                const plainText = event.dataTransfer.getData("text/plain")?.trim();
                if (plainText) {
                    const pos = screenToCanvas(event.clientX, event.clientY);
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                    const node = {
                        ...createCanvasNode(CanvasNodeType.Text, pos, { content: plainText, status: NODE_STATUS_SUCCESS, fontSize: DEFAULT_CANVAS_FONT_SIZE }),
                        title: plainText.slice(0, 32) || t("canvas.projectPage.clipboardText"),
                        position: { x: pos.x - spec.width / 2, y: pos.y - spec.height / 2 },
                    };
                    setNodes((prev) => [...prev, node]);
                    setSelectedNodeIds(new Set([node.id]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(node.id);
                }
                return;
            }

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isDocumentFile(f)) void createDocumentTextNode(f, pos);
                else if (isAudioFile(f)) void createAudioFileNode(f, pos);
                else if (f.type.startsWith("video/")) void createVideoFileNode(f, pos);
                else void createImageFileNode(f, pos);
            }
        },
        [createAudioFileNode, createDocumentTextNode, createImageFileNode, createVideoFileNode, screenToCanvas, t],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const handleCanvasContextMenu = useCallback(
        (event: ReactMouseEvent) => {
            if (isCanvasTextInteractionTarget(event.target)) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
            event.preventDefault();
            setContextMenu(null);
            setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
        },
        [screenToCanvas],
    );

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    // Upstream image nodes become references; without them this is text-to-image.
                    const upstreamNodes = connectionsRef.current
                        .filter((conn) => conn.toNodeId === nodeId)
                        .map((conn) => nodesRef.current.find((node) => node.id === conn.fromNodeId))
                        .filter((node): node is CanvasNodeData => Boolean(node));
                    const refs = upstreamNodes.flatMap((up) =>
                        typeof up.metadata?.content === "string" && up.metadata.content && up.type !== sourceNode.type
                            ? [{ id: up.id, name: `${up.title || up.id}.png`, type: up.metadata.mimeType || "image/png", dataUrl: up.metadata.content, storageKey: up.metadata.storageKey }]
                            : [],
                    );
                    const items = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, fullPrompt, refs, undefined, { signal: controller.signal })
                        : await requestGeneration({ ...generationConfig, count: "1" }, fullPrompt, { signal: controller.signal });
                    if (items[0]?.videoUrls?.length) {
                        // The request produced a clip and no image (the H3 four-view card's previews
                        // and the 氛围感短视频 graph's only output both come back this way): leave the
                        // node content as-is, mark the round done and spawn the video instead.
                        setNodes((prev) =>
                            prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                        );
                        void spawnExtraVideoNodes(nodeId, items[0].videoUrls, { prompt: scene, model: generationConfig.model });
                        setDialogNodeId(null);
                    } else {
                        const uploaded = await uploadGeneratedImage(items[0]);
                        setNodes((prev) =>
                            prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                        );
                        if (items.length > 1) {
                            void spawnExtraImageNodes(nodeId, items.slice(1).map((item) => item.dataUrl), { prompt: scene, model: generationConfig.model });
                        }
                        if (items[0]?.extraVideos?.length) {
                            void spawnExtraVideoNodes(nodeId, items[0].extraVideos, { prompt: scene, model: generationConfig.model });
                        }
                        setDialogNodeId(null);
                    }
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                    setRunningNodeId((current) => (current === nodeId ? null : current));
                }
                return;
            }

            setRunningNodeId(nodeId);
            // Native H3 video FIFO: do not abort an in-flight job when another submit is queued.
            const nativeVideoSerial = mode === "video" && isNativeComfyVideoConfig(generationConfig);
            const runController = startGenerationRequest(
                nodeId,
                nodeId,
                nodeId,
                new AbortController(),
                nativeVideoSerial ? { replaceTarget: false } : undefined,
            );
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            // 风格模板 + 摄像机：仅生图模式生效。
            // 设定了摄像机 → 用摄像机的（merge 会剥掉风格里自带的相机/镜头段再拼上摄像机段）；
            // 未设定摄像机 → 用选定风格里自带的相机参数；两者都为空 → 保持原提示词不变。
            const styleTemplate = mode === "image" ? getStyleTemplate(sourceNode?.metadata?.styleTemplateId) : undefined;
            const stylePromptText = styleTemplate ? buildStylePromptText(styleTemplate) : "";
            const cameraPrompt = mode === "image" ? buildCameraSelectionPrompt(sourceNode?.metadata?.cameraSelection) : "";
            const modelPrompt =
                stylePromptText || cameraPrompt ? mergeStyleAndCameraPrompt(stylePromptText, cameraPrompt) || effectivePrompt : effectivePrompt;
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus)
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    // Image nodes always write back into themselves so the same panel can re-run
                    // without chaining a new node off the previous result.
                    const writeImageToSelf = isImageNode;
                    // Only upstream connected images count as references ânever this node's own result
                    // or nodes previously generated from this panel.
                    const selfStorageKey = sourceNode?.metadata?.storageKey;
                    const selfContent = sourceNode?.metadata?.content;
                    const generatedChildIds = new Set(connectionsRef.current.filter((connection) => connection.fromNodeId === nodeId).map((connection) => connection.toNodeId));
                    let referenceImages = generationContext.referenceImages.filter(
                        (ref) => ref.id !== nodeId && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.dataUrl !== selfContent,
                    );
                    if (isImageNode && sourceNode?.metadata?.content && !referenceImages.length && sourceNode.metadata.generationType === "edit") {
                        // Upstream may have been disconnected; reuse original edit refs but still exclude self.
                        const savedRefs = (await resolveMetadataReferences(sourceNode.metadata)) || [];
                        referenceImages = savedRefs.filter((ref) => ref.storageKey !== selfStorageKey && ref.dataUrl !== selfContent);
                    }
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = writeImageToSelf ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    const previousImages = writeImageToSelf ? collectSuccessfulImageHistory(sourceNode) : [];
                    const appendImageHistory = writeImageToSelf && previousImages.length > 0;
                    const retainedImages =
                        appendImageHistory && previousImages.length + count > MAX_IMAGE_NODE_HISTORY
                            ? previousImages.slice(Math.max(0, previousImages.length - (MAX_IMAGE_NODE_HISTORY - count)))
                            : previousImages;
                    const loadingImages: CanvasNodeImage[] = imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }));
                    const nextImages = appendImageHistory ? [...retainedImages, ...loadingImages] : loadingImages;
                    const retainedPrimaryId = appendImageHistory ? sourceNode?.metadata?.primaryImageId || retainedImages[0]?.id : undefined;
                    const retainedPrimary = retainedPrimaryId ? retainedImages.find((image) => image.id === retainedPrimaryId) || retainedImages[0] : undefined;
                    pendingChildIds = [rootId];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: writeImageToSelf ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: writeImageToSelf ? parentPosition.y : parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: writeImageToSelf ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: writeImageToSelf ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            images: nextImages,
                            ...(appendImageHistory && retainedPrimary
                                ? {
                                      content: retainedPrimary.content,
                                      storageKey: retainedPrimary.storageKey,
                                      naturalWidth: retainedPrimary.naturalWidth,
                                      naturalHeight: retainedPrimary.naturalHeight,
                                      bytes: retainedPrimary.bytes,
                                      mimeType: retainedPrimary.mimeType,
                                      primaryImageId: retainedPrimary.id,
                                  }
                                : {}),
                            ...generationMetadata,
                        },
                    };

                    if (appendImageHistory) {
                        // Keep prior versions folded so the user can expand and switch later.
                        setExpandedImageNodeIds((current) => {
                            if (!current.has(nodeId)) return current;
                            const next = new Set(current);
                            next.delete(nodeId);
                            return next;
                        });
                    }

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : writeImageToSelf
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: appendImageHistory
                                                ? {
                                                      ...node.metadata,
                                                      ...rootNode.metadata,
                                                      content: retainedPrimary?.content || node.metadata?.content,
                                                      storageKey: retainedPrimary?.storageKey || node.metadata?.storageKey,
                                                      primaryImageId: retainedPrimary?.id || node.metadata?.primaryImageId,
                                                      images: nextImages,
                                                      errorDetails: undefined,
                                                  }
                                                : { ...node.metadata, ...rootNode.metadata, content: undefined, storageKey: undefined, primaryImageId: undefined, errorDetails: undefined },
                                        }
                                      : {
                                            ...node,
                                            type: CanvasNodeType.Text,
                                            title: prompt.slice(0, 32) || "Prompt",
                                            width: parentConfig.width,
                                            height: parentConfig.height,
                                            metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: DEFAULT_CANVAS_FONT_SIZE, errorDetails: undefined },
                                        }
                                : node,
                        ),
                        ...(writeImageToSelf ? [] : [rootNode]),
                    ]);
                    if (!writeImageToSelf) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    const succeededImages: GenerationHistoryImage[] = [];
                    const newImageIdSet = new Set(imageIds);
                    const applyGeneratedSlot = async (
                        imageId: string,
                        image: GeneratedImageResult,
                    ) => {
                        const uploaded = await uploadGeneratedImage(image);
                        const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                        const item = canvasNodeImageFromUpload(imageId, uploaded, {
                            midjourneyTaskId: image.midjourneyTaskId,
                            midjourneyIndex: image.midjourneyIndex,
                        });
                        setNodes((prev) =>
                            prev.map((node) => {
                                if (node.id !== rootId) return node;
                                const images = node.metadata?.images?.map((current) => (current.id === imageId ? item : current)) || [];
                                // New round results become primary so the latest fill is shown; older versions stay in the folded batch.
                                const promoteNew = newImageIdSet.has(imageId);
                                if (!promoteNew && node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                return {
                                    ...node,
                                    position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                    ...imageSize,
                                    metadata: {
                                        ...node.metadata,
                                        content: item.content,
                                        storageKey: item.storageKey,
                                        thumbnailContent: item.thumbnailContent,
                                        thumbnailStorageKey: item.thumbnailStorageKey,
                                        naturalWidth: item.naturalWidth,
                                        naturalHeight: item.naturalHeight,
                                        bytes: item.bytes,
                                        mimeType: item.mimeType,
                                        midjourneyTaskId: item.midjourneyTaskId,
                                        midjourneyIndex: item.midjourneyIndex,
                                        images,
                                        primaryImageId: imageId,
                                        status: NODE_STATUS_SUCCESS,
                                    },
                                };
                            }),
                        );
                        hasSuccess = true;
                        succeededImages.push({ storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes });
                        if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                    };
                    const markSlotError = (imageId: string, errorDetails: string) => {
                        if (!firstError) firstError = errorDetails;
                        hasFailure = true;
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === rootId
                                    ? {
                                          ...node,
                                          metadata: {
                                              ...node.metadata,
                                              images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                          },
                                      }
                                    : node,
                            ),
                        );
                    };
                    const useMidjourneyBatch = isMidjourneyModel(generationConfig.model || "") && !referenceImages.length;
                    if (useMidjourneyBatch) {
                        try {
                            const items = await requestGeneration({ ...generationConfig, count: String(count) }, modelPrompt, { signal: controller.signal });
                            const pairCount = Math.min(imageIds.length, items.length);
                            if (items.length < imageIds.length) {
                                const keepIds = new Set(imageIds.slice(0, pairCount));
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === rootId
                                            ? {
                                                  ...node,
                                                  metadata: {
                                                      ...node.metadata,
                                                      images: node.metadata?.images?.filter((image) => !newImageIdSet.has(image.id) || keepIds.has(image.id)),
                                                  },
                                              }
                                            : node,
                                    ),
                                );
                            }
                            await Promise.all(
                                imageIds.slice(0, pairCount).map(async (imageId, index) => {
                                    try {
                                        await applyGeneratedSlot(imageId, items[index]);
                                    } catch (error) {
                                        if (isGenerationCanceled(error)) return;
                                        markSlotError(imageId, error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                                    }
                                }),
                            );
                            if (!pairCount) {
                                hasFailure = true;
                                if (!firstError) firstError = t("canvas.projectPage.generationFailed");
                            }
                        } catch (error) {
                            if (!isGenerationCanceled(error)) {
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === rootId
                                            ? {
                                                  ...node,
                                                  metadata: {
                                                      ...node.metadata,
                                                      images: node.metadata?.images?.map((image) =>
                                                          newImageIdSet.has(image.id) ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image,
                                                      ),
                                                  },
                                              }
                                            : node,
                                    ),
                                );
                            }
                        }
                    } else {
                        await Promise.all(
                            imageIds.map(async (imageId) => {
                                try {
                                    const items = referenceImages.length
                                        ? await requestEdit({ ...generationConfig, count: "1" }, modelPrompt, referenceImages, undefined, { signal: controller.signal })
                                        : await requestGeneration({ ...generationConfig, count: "1" }, modelPrompt, { signal: controller.signal });
                                    if (items[0]?.videoUrls?.length) {
                                        // The request produced a clip and no image: the slot has
                                        // nothing to fill — park it as done (not an error) and spawn
                                        // the video node instead.
                                        hasSuccess = true;
                                        setNodes((prev) =>
                                            prev.map((node) =>
                                                node.id === rootId
                                                    ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((current) => (current.id === imageId ? { ...current, status: NODE_STATUS_SUCCESS } : current)) } }
                                                    : node,
                                            ),
                                        );
                                        void spawnExtraVideoNodes(rootId, items[0].videoUrls, { prompt: effectivePrompt, model: generationConfig.model });
                                    } else {
                                        await applyGeneratedSlot(imageId, items[0]);
                                        // Storyboard-style workflows return every frame regardless of the count
                                        // param; place the leftovers instead of silently dropping them.
                                        if (items.length > 1) {
                                            void spawnExtraImageNodes(rootId, items.slice(1).map((item) => item.dataUrl), { prompt: effectivePrompt, model: generationConfig.model });
                                        }
                                        if (items[0]?.extraVideos?.length) {
                                            void spawnExtraVideoNodes(rootId, items[0].extraVideos, { prompt: effectivePrompt, model: generationConfig.model });
                                        }
                                    }
                                } catch (error) {
                                    if (isGenerationCanceled(error)) return;
                                    markSlotError(imageId, error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                                }
                            }),
                        );
                    }
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (succeededImages.length) {
                        useGenerationHistoryStore.getState().addRecord({
                            prompt: effectivePrompt,
                            model: generationConfig.model || "",
                            images: succeededImages,
                            successCount: succeededImages.length,
                            failCount: count - succeededImages.length,
                        });
                    }
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? {
                                        ...node,
                                        metadata: {
                                            ...node.metadata,
                                            // Keep prior versions visible if this round failed entirely.
                                            status: hasSuccess || appendImageHistory ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                            errorDetails: hasSuccess || appendImageHistory ? undefined : t("canvas.projectPage.allFailed"),
                                        },
                                    }
                                  : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isVideoNode = sourceNode?.type === CanvasNodeType.Video;
                    // Same panel re-generate: write back into the video node; never use its own result as a reference.
                    const writeVideoToSelf = isVideoNode;
                    const selfStorageKey = sourceNode?.metadata?.storageKey;
                    const selfContent = sourceNode?.metadata?.content;
                    const generatedChildIds = new Set(connectionsRef.current.filter((connection) => connection.fromNodeId === nodeId).map((connection) => connection.toNodeId));
                    const referenceImages = generationContext.referenceImages.filter(
                        (ref) => ref.id !== nodeId && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.dataUrl !== selfContent,
                    );
                    const videoId = writeVideoToSelf ? nodeId : nanoid();
                    const versionId = nanoid();
                    const previousVideos = writeVideoToSelf ? collectSuccessfulImageHistory(sourceNode) : [];
                    const appendVideoHistory = writeVideoToSelf && previousVideos.length > 0;
                    const retainedVideos =
                        appendVideoHistory && previousVideos.length + 1 > MAX_IMAGE_NODE_HISTORY
                            ? previousVideos.slice(Math.max(0, previousVideos.length - (MAX_IMAGE_NODE_HISTORY - 1)))
                            : previousVideos;
                    const loadingVideo: CanvasNodeImage = { id: versionId, status: NODE_STATUS_LOADING, content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" };
                    const nextImages = appendVideoHistory ? [...retainedVideos, loadingVideo] : [loadingVideo];
                    const retainedPrimaryId = appendVideoHistory ? sourceNode?.metadata?.primaryImageId || retainedVideos[0]?.id : undefined;
                    const retainedPrimary = retainedPrimaryId ? retainedVideos.find((image) => image.id === retainedPrimaryId) || retainedVideos[0] : undefined;
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: writeVideoToSelf && sourceNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: writeVideoToSelf && sourceNode ? sourceNode.width : spec.width,
                        height: writeVideoToSelf && sourceNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls({ ...generationContext, referenceImages }),
                            images: nextImages,
                            ...(appendVideoHistory && retainedPrimary
                                ? {
                                      content: retainedPrimary.content,
                                      storageKey: retainedPrimary.storageKey,
                                      naturalWidth: retainedPrimary.naturalWidth,
                                      naturalHeight: retainedPrimary.naturalHeight,
                                      bytes: retainedPrimary.bytes,
                                      mimeType: retainedPrimary.mimeType,
                                      primaryImageId: retainedPrimary.id,
                                  }
                                : { content: undefined, storageKey: undefined, primaryImageId: undefined }),
                        },
                    };
                    pendingChildIds = [videoId];
                    if (appendVideoHistory) {
                        setExpandedImageNodeIds((current) => {
                            if (!current.has(nodeId)) return current;
                            const next = new Set(current);
                            next.delete(nodeId);
                            return next;
                        });
                    }
                    setNodes((prev) =>
                        writeVideoToSelf
                            ? prev.map((node) =>
                                  node.id === nodeId
                                      ? {
                                            ...node,
                                            ...videoNode,
                                            metadata: appendVideoHistory
                                                ? {
                                                      ...node.metadata,
                                                      ...videoNode.metadata,
                                                      content: retainedPrimary?.content || node.metadata?.content,
                                                      storageKey: retainedPrimary?.storageKey || node.metadata?.storageKey,
                                                      primaryImageId: retainedPrimary?.id || node.metadata?.primaryImageId,
                                                      images: nextImages,
                                                      errorDetails: undefined,
                                                  }
                                                : { ...node.metadata, ...videoNode.metadata, content: undefined, storageKey: undefined, primaryImageId: undefined, errorDetails: undefined },
                                        }
                                      : node,
                              )
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!writeVideoToSelf) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    setDialogNodeId(nodeId);
                    // Own AbortController per child clip; replaceTarget=false so queueing the next
                    // native job never abort()/interrupt the one still running on the pod.
                    const controller =
                        videoId === nodeId
                            ? runController
                            : startGenerationRequest(
                                  videoId,
                                  nodeId,
                                  nodeId,
                                  new AbortController(),
                                  nativeVideoSerial ? { replaceTarget: false } : undefined,
                              );
                    const runNativeVideoJob = async () => {
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const videoResult = await requestVideoGeneration(generationConfig, effectivePrompt, referenceImages, {
                            signal: controller.signal,
                            referenceAudios: generationContext.referenceAudios || [],
                        });
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const video = await storeGeneratedVideo(videoResult);
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        const meta = videoMetadata(video);
                        const version: CanvasNodeImage = {
                            id: versionId,
                            status: NODE_STATUS_SUCCESS,
                            content: meta.content || "",
                            storageKey: meta.storageKey || "",
                            naturalWidth: meta.naturalWidth || 0,
                            naturalHeight: meta.naturalHeight || 0,
                            bytes: meta.bytes || 0,
                            mimeType: meta.mimeType || "video/mp4",
                        };
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...meta,
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls({ ...generationContext, referenceImages }),
                                              images: (node.metadata?.images || []).map((image) => (image.id === versionId ? version : image)),
                                              primaryImageId: versionId,
                                              errorDetails: undefined,
                                          },
                                      }
                                    : node,
                            ),
                        );
                        if (videoResult.extraImages?.length) {
                            void spawnExtraImageNodes(videoId, videoResult.extraImages, { prompt: effectivePrompt, model: generationConfig.model });
                        }
                    };
                    try {
                        // Native H3: only start the next /prompt after this job writes back or fails.
                        // Success and error both release the FIFO (tail always advances) so a failure
                        // cannot stall later queued generates. replaceTarget:false + no blind
                        // /interrupt keep the running job from being killed when more are queued.
                        if (isNativeComfyVideoConfig(generationConfig)) {
                            await enqueueNativeComfyVideoJob(runNativeVideoJob, {
                                targetNodeId: videoId,
                                versionId,
                                signal: controller.signal,
                            });
                        } else {
                            await runNativeVideoJob();
                        }
                    } catch (error) {
                        if (!isGenerationCanceled(error)) {
                            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === videoId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  status: appendVideoHistory ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                                  errorDetails: appendVideoHistory ? undefined : errorDetails,
                                                  images: (node.metadata?.images || []).map((image) => (image.id === versionId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                              },
                                          }
                                        : node,
                                ),
                            );
                            message.error(errorDetails);
                        }
                    } finally {
                        if (videoId !== nodeId) finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isAudioNode = sourceNode?.type === CanvasNodeType.Audio;
                    // Same panel re-generate: write back into the audio node; never use its own result as a reference.
                    const writeAudioToSelf = isAudioNode;
                    const selfStorageKey = sourceNode?.metadata?.storageKey;
                    const selfContent = sourceNode?.metadata?.content;
                    const generatedChildIds = new Set(connectionsRef.current.filter((connection) => connection.fromNodeId === nodeId).map((connection) => connection.toNodeId));
                    const referenceAudios = (generationContext.referenceAudios || []).filter(
                        (ref) => ref.id !== nodeId && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.url !== selfContent,
                    );
                    const audioId = writeAudioToSelf ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: writeAudioToSelf && sourceNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: writeAudioToSelf && sourceNode ? sourceNode.width : spec.width,
                        height: writeAudioToSelf && sourceNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            ...buildAudioGenerationMetadata(generationConfig),
                            references: generationReferenceUrls({ referenceImages: [], referenceVideos: [], referenceAudios }),
                            // Keep previous playback until the new clip arrives when rewriting self.
                            ...(writeAudioToSelf && sourceNode?.metadata?.content
                                ? {
                                      content: sourceNode.metadata.content,
                                      storageKey: sourceNode.metadata.storageKey,
                                      mimeType: sourceNode.metadata.mimeType,
                                      bytes: sourceNode.metadata.bytes,
                                      durationMs: sourceNode.metadata.durationMs,
                                  }
                                : {}),
                        },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        writeAudioToSelf
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode, metadata: { ...node.metadata, ...audioNode.metadata, errorDetails: undefined } } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!writeAudioToSelf) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = audioId === nodeId ? runController : startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await storeGeneratedAudio(
                            await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal, referenceAudios }),
                            generationConfig.audioFormat,
                        );
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig), references: generationReferenceUrls({ referenceImages: [], referenceVideos: [], referenceAudios }), status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                    } catch (error) {
                        if (!isGenerationCanceled(error)) {
                            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === audioId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  status: writeAudioToSelf && node.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                                  errorDetails: writeAudioToSelf && node.metadata?.content ? undefined : errorDetails,
                                              },
                                          }
                                        : node,
                                ),
                            );
                            message.error(errorDetails);
                        }
                    } finally {
                        if (audioId !== nodeId) finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = getGenerationCount(String(sourceNode?.metadata?.textCount || 1));
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode || textCount > 1 ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (childIds.length) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: DEFAULT_CANVAS_FONT_SIZE, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(
                            generationConfig,
                            buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                            },
                            { signal: controller.signal },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) return;
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Text,
                                      title: prompt.slice(0, 32) || "Generated Text",
                                      metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, status: NODE_STATUS_SUCCESS },
                                  }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNativeComfyVideoConfig, message, openConfigDialog, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    useEffect(() => {
        if (!projectLoaded || !projectId) return;
        return startCanvasWorkbuddyBridge({
            projectId,
            getNodes: () => nodesRef.current,
            createTextNode: createBridgeTextNode,
            createImageNode: createBridgeImageNode,
            setPrompt: (nodeId, prompt) => {
                handleConfigNodeChange(nodeId, { prompt, composerContent: prompt, promptSyncAt: Date.now() });
                nodesRef.current = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt, composerContent: prompt } } : node));
            },
            setSize: (nodeId, size) => {
                handleConfigNodeChange(nodeId, { size });
                nodesRef.current = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, size } } : node));
            },
            generate: (nodeId, mode, prompt) => generateNodeRef.current?.(nodeId, mode, prompt) || Promise.resolve(),
        });
    }, [createBridgeImageNode, createBridgeTextNode, handleConfigNodeChange, projectId, projectLoaded]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const resolvedRetryRefs =
                hasSavedImageMetadata && savedImageMetadata
                    ? await resolveMetadataReferences(savedImageMetadata)
                    : useReferenceImages
                      ? context?.referenceImages || []
                      : [];
            const retryImages = (resolvedRetryRefs || []).filter(
                (ref) => ref.id !== node.id && ref.storageKey !== node.metadata?.storageKey && ref.dataUrl !== node.metadata?.content,
            );
            if (useReferenceImages && !retryImages.length) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"),
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)),
                                  },
                              }
                            : item,
                    ),
                );
                return;
            }

            setRunningNodeId(node.id);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  status: NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                                  images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined } : image)),
                              },
                          }
                        : item,
                ),
            );
            const nativeVideoSerial = node.type === CanvasNodeType.Video && isNativeComfyVideoConfig(generationConfig);
            const controller = startGenerationRequest(
                node.id,
                sourceNode.id,
                node.id,
                new AbortController(),
                nativeVideoSerial ? { replaceTarget: false } : undefined,
            );

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const runRetryVideoJob = async () => {
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const videoResult = await requestVideoGeneration(generationConfig, prompt, retryImages, {
                            signal: controller.signal,
                            referenceAudios: context?.referenceAudios || [],
                        });
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const video = await storeGeneratedVideo(videoResult);
                        const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        const meta = videoMetadata(video);
                        const retryVideo: CanvasNodeImage = {
                            id: imageId || node.metadata?.primaryImageId || nanoid(),
                            status: NODE_STATUS_SUCCESS,
                            content: meta.content || "",
                            storageKey: meta.storageKey || "",
                            naturalWidth: meta.naturalWidth || 0,
                            naturalHeight: meta.naturalHeight || 0,
                            bytes: meta.bytes || 0,
                            mimeType: meta.mimeType || "video/mp4",
                        };
                        setNodes((prev) =>
                            prev.map((item) => {
                                if (item.id !== node.id) return item;
                                const makePrimary = !imageId || !item.metadata?.content || item.metadata?.primaryImageId === retryVideo.id;
                                const images = item.metadata?.images?.some((current) => current.id === retryVideo.id)
                                    ? item.metadata.images.map((current) => (current.id === retryVideo.id ? retryVideo : current))
                                    : item.metadata?.images?.length
                                      ? [...item.metadata.images, retryVideo]
                                      : [retryVideo];
                                return {
                                    ...item,
                                    ...(makePrimary
                                        ? {
                                              width: videoSize.width,
                                              height: videoSize.height,
                                              position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                          }
                                        : {}),
                                    metadata: {
                                        ...item.metadata,
                                        ...(makePrimary ? meta : { status: NODE_STATUS_SUCCESS }),
                                        prompt,
                                        model: generationConfig.model,
                                        size: generationConfig.size,
                                        seconds: generationConfig.videoSeconds,
                                        vquality: generationConfig.vquality,
                                        generateAudio: generationConfig.videoGenerateAudio,
                                        watermark: generationConfig.videoWatermark,
                                        images,
                                        primaryImageId: makePrimary ? retryVideo.id : item.metadata?.primaryImageId,
                                        errorDetails: undefined,
                                    },
                                };
                            }),
                        );
                        if (videoResult.extraImages?.length) {
                            void spawnExtraImageNodes(node.id, videoResult.extraImages, { prompt, model: generationConfig.model });
                        }
                    };
                    if (isNativeComfyVideoConfig(generationConfig)) {
                        await enqueueNativeComfyVideoJob(runRetryVideoJob, {
                            targetNodeId: node.id,
                            versionId: imageId,
                            signal: controller.signal,
                        });
                    } else {
                        await runRetryVideoJob();
                    }
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    try {
                        const selfStorageKey = node.metadata?.storageKey;
                        const selfContent = node.metadata?.content;
                        const generatedChildIds = new Set(connectionsRef.current.filter((connection) => connection.fromNodeId === node.id).map((connection) => connection.toNodeId));
                        const referenceAudios = (context?.referenceAudios || []).filter(
                            (ref) => ref.id !== node.id && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.url !== selfContent,
                        );
                        const audio = await storeGeneratedAudio(
                            await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal, referenceAudios }),
                            generationConfig.audioFormat,
                        );
                        setNodes((prev) =>
                            prev.map((item) =>
                                item.id === node.id
                                    ? {
                                          ...item,
                                          metadata: {
                                              ...item.metadata,
                                              ...audioMetadata(audio),
                                              prompt,
                                              ...buildAudioGenerationMetadata(generationConfig),
                                              references: generationReferenceUrls({ referenceImages: [], referenceVideos: [], referenceAudios }),
                                              status: NODE_STATUS_SUCCESS,
                                              errorDetails: undefined,
                                          },
                                      }
                                    : item,
                            ),
                        );
                    } catch (error) {
                        if (!isGenerationCanceled(error)) {
                            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                            setNodes((prev) =>
                                prev.map((item) =>
                                    item.id === node.id
                                        ? {
                                              ...item,
                                              metadata: {
                                                  ...item.metadata,
                                                  status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                                  errorDetails: item.metadata?.content ? undefined : errorDetails,
                                              },
                                          }
                                        : item,
                                ),
                            );
                            message.error(errorDetails);
                        }
                    }
                    return;
                }

                const retryItems = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, undefined, { signal: controller.signal })
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal });
                if (retryItems[0]?.videoUrls?.length) {
                    // The request produced a clip and no image: nothing to fill the image slot
                    // with — mark the round done and spawn the video node instead.
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } }
                                : item,
                        ),
                    );
                    void spawnExtraVideoNodes(node.id, retryItems[0].videoUrls, { prompt, model: generationConfig.model });
                    return;
                }
                const image = retryItems[0];
                const uploadedImage = await uploadGeneratedImage(image);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage = canvasNodeImageFromUpload(imageId || node.metadata?.primaryImageId || nanoid(), uploadedImage);
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize =
                            imageId && item.metadata?.freeResize
                                ? { width: item.width, height: item.height }
                                : imageId
                                  ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge)
                                  : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary
                                ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) }
                                : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                            },
                        };
                    }),
                );
                if (retryItems.length > 1) {
                    void spawnExtraImageNodes(node.id, retryItems.slice(1).map((item) => item.dataUrl), { prompt, model: generationConfig.model });
                }
                if (retryItems[0]?.extraVideos?.length) {
                    void spawnExtraVideoNodes(node.id, retryItems[0].extraVideos, { prompt, model: generationConfig.model });
                }
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : errorDetails,
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNativeComfyVideoConfig, message, openConfigDialog, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string | string[]) => {
        const removeIds = new Set(Array.isArray(imageId) ? imageId : [imageId]);
        if (!removeIds.size) return;
        const node = nodesRef.current.find((item) => item.id === nodeId);
        const remaining = (node?.metadata?.images || []).filter((image) => !removeIds.has(image.id));
        if (remaining.length <= 1) setExpandedImageNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = (item.metadata?.images || []).filter((image) => !removeIds.has(image.id));
                if (!images.length) {
                    // Also covers single-media nodes that only store content on metadata (no images[]).
                    return {
                        ...item,
                        metadata: {
                            ...item.metadata,
                            images: undefined,
                            count: undefined,
                            primaryImageId: undefined,
                            content: undefined,
                            storageKey: undefined,
                            thumbnailContent: undefined,
                            thumbnailStorageKey: undefined,
                            naturalWidth: undefined,
                            naturalHeight: undefined,
                            bytes: undefined,
                            mimeType: undefined,
                            durationMs: undefined,
                            status: NODE_STATUS_IDLE,
                            errorDetails: undefined,
                        },
                    };
                }
                const currentPrimaryId = item.metadata?.primaryImageId || images[0]?.id;
                const primaryRemoved = !images.some((image) => image.id === currentPrimaryId);
                const nextPrimary = primaryRemoved ? images.find((image) => image.content) || images[0] : images.find((image) => image.id === currentPrimaryId) || images[0];
                if (!primaryRemoved && nextPrimary.id === item.metadata?.primaryImageId) {
                    return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: nextPrimary.id } };
                }
                const edge = Math.max(item.width, item.height);
                const size =
                    item.metadata?.freeResize || !nextPrimary.naturalWidth || !nextPrimary.naturalHeight
                        ? { width: item.width, height: item.height }
                        : item.type === CanvasNodeType.Video
                          ? fitNodeSize(nextPrimary.naturalWidth, nextPrimary.naturalHeight, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT)
                          : fitNodeSize(nextPrimary.naturalWidth, nextPrimary.naturalHeight, edge, edge);
                return {
                    ...item,
                    position: { x: item.position.x + item.width / 2 - size.width / 2, y: item.position.y + item.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...item.metadata,
                        images,
                        count: images.length,
                        primaryImageId: nextPrimary.id,
                        content: nextPrimary.content || undefined,
                        storageKey: nextPrimary.storageKey || undefined,
                        thumbnailContent: nextPrimary.thumbnailContent || undefined,
                        thumbnailStorageKey: nextPrimary.thumbnailStorageKey || undefined,
                        naturalWidth: nextPrimary.naturalWidth || undefined,
                        naturalHeight: nextPrimary.naturalHeight || undefined,
                        bytes: nextPrimary.bytes || undefined,
                        mimeType: nextPrimary.mimeType || undefined,
                        status: nextPrimary.content ? NODE_STATUS_SUCCESS : nextPrimary.status === NODE_STATUS_ERROR ? NODE_STATUS_ERROR : item.metadata?.status,
                        errorDetails: nextPrimary.errorDetails,
                    },
                };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const createChatFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const context = (sourceNode.metadata?.content || sourceNode.metadata?.prompt || "").trim();
            const chatNode = createCanvasNode(
                CanvasNodeType.Chat,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + getNodeSpec(CanvasNodeType.Chat).width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    status: NODE_STATUS_IDLE,
                    messages: [],
                    chatTextEnabled: true,
                    chatImageEnabled: false,
                    model: resolveModelForCapability(effectiveConfig, effectiveConfig.textModel, "text"),
                    imageModel: resolveModelForCapability(effectiveConfig, effectiveConfig.imageModel, "image"),
                    content: context,
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: chatNode.id };
            const nextNodes = [...nodesRef.current, chatNode];
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([chatNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.textModel],
    );

    const sendChatMessage = useCallback(
        async (nodeId: string, text: string, options: ChatSendOptions = { text: true, image: false }) => {
            const { text: runText, image: runImage, linkedMedia = [] } = options;
            if (!runText && !runImage) return;

            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Chat) return;
            if (sourceNode.metadata?.status === NODE_STATUS_LOADING) return;

            const linkedContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, ""));
            const linkedText = linkedContext.prompt.trim() || (sourceNode.metadata?.content || "").trim();
            const typedText = text.trim();
            // Media pinned in the composer (the "linked images" chips) that may not be wired as a connection
            // or spelled out in the prompt — these must still reach image generation, e.g. Seedream reference images.
            const composerLinkedImages = linkedMedia.length ? await resolveCanvasReferenceImages(linkedMedia, nodesRef.current) : [];
            const hasLinkedMedia = (linkedContext.imageCount || 0) > 0 || (linkedContext.videoCount || 0) > 0 || composerLinkedImages.length > 0;
            const userText = typedText || linkedText || (hasLinkedMedia ? t("canvas.chat.defaultMediaPrompt") : "");
            if (!userText) return;

            const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text: userText };
            const assistantId = nanoid();
            const assistantMessage: CanvasAssistantMessage = { id: assistantId, role: "assistant", text: "" };
            const previousMessages = sourceNode.metadata?.messages || [];
            const nextMessages = [...previousMessages, userMessage, assistantMessage];

            const rollbackMessages = () => {
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id !== nodeId) return node;
                        return { ...node, metadata: { ...node.metadata, messages: previousMessages, status: NODE_STATUS_IDLE, errorDetails: undefined } };
                    }),
                );
            };

            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  messages: nextMessages,
                                  chatTextEnabled: runText,
                                  chatImageEnabled: runImage,
                                  status: NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                              },
                          }
                        : node,
                ),
            );

            const textNode = { ...sourceNode, metadata: { ...sourceNode.metadata, generationMode: "text" as const } };
            const imageModel = resolveModelForCapability(effectiveConfig, sourceNode.metadata?.imageModel, "image");
            const imageNode = { ...sourceNode, metadata: { ...sourceNode.metadata, model: imageModel, generationMode: "image" as const } };
            const textConfig = runText ? buildGenerationConfig(effectiveConfig, textNode, "text") : null;
            const imageConfig = runImage ? buildGenerationConfig(effectiveConfig, imageNode, "image") : null;

            if (runText && textConfig && !isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                rollbackMessages();
                return;
            }
            if (runImage && imageConfig && !isAiConfigReady(imageConfig, imageConfig.model)) {
                openConfigDialog(true);
                rollbackMessages();
                return;
            }

            const controller = new AbortController();
            setRunningNodeId(nodeId);
            startGenerationRequest(nodeId, nodeId, nodeId, controller);

            const updateAssistantMessage = (patch: Partial<CanvasAssistantMessage>) => {
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id !== nodeId) return node;
                        const messages = (node.metadata?.messages || []).map((message) => {
                            if (message.id !== assistantId) return message;
                            const next = { ...message };
                            if (patch.text !== undefined) next.text = patch.text;
                            if (patch.images !== undefined) next.images = patch.images;
                            if (patch.role !== undefined) next.role = patch.role;
                            return next;
                        });
                        return { ...node, metadata: { ...node.metadata, messages, status: NODE_STATUS_LOADING } };
                    }),
                );
            };

            const runTextTask = async () => {
                const historyMessages: AiTextMessage[] = previousMessages
                    .filter((message) => message.role === "user" || message.role === "assistant")
                    .map((message) => ({ role: message.role as "user" | "assistant", content: message.text }));

                const mentionRefs = buildNodeMentionReferences(sourceNode, nodesRef.current, connectionsRef.current).filter((reference) => reference.active);
                const mentionedImages = mentionRefs.filter((reference) => reference.kind === "image" && userText.includes(reference.label));
                const mentionedVideos = mentionRefs.filter((reference) => reference.kind === "video" && userText.includes(reference.label));
                const linkedImages = linkedContext.referenceImages || [];
                const linkedVideos = linkedContext.referenceVideos || [];
                const resolvedMentionImages = mentionedImages.length ? await resolveCanvasReferenceImages(mentionedImages, nodesRef.current) : [];

                const videoSources = [
                    ...linkedVideos.map((video) => ({ id: video.id, title: video.name || video.id, url: video.url })),
                    ...mentionedVideos
                        .map((reference) => {
                            const videoNode = nodesRef.current.find((item) => item.id === reference.nodeId);
                            return videoNode?.metadata?.content ? { id: reference.nodeId, title: reference.title, url: videoNode.metadata.content } : null;
                        })
                        .filter((item): item is { id: string; title: string; url: string } => Boolean(item)),
                ];
                const uniqueVideos = Array.from(new Map(videoSources.map((item) => [item.id, item])).values());
                const videoFrames = (
                    await Promise.all(
                        uniqueVideos.map(async (video) => {
                            const frame = await captureVideoFrameDataUrl(video.url);
                            if (!frame) return null;
                            return {
                                id: `video-frame:${video.id}`,
                                name: `${video.title}.jpg`,
                                type: "image/jpeg",
                                dataUrl: frame,
                            } satisfies ReferenceImage;
                        }),
                    )
                ).filter((item): item is ReferenceImage => Boolean(item));

                const referenceImages = Array.from(
                    new Map(
                        [...linkedImages, ...resolvedMentionImages, ...videoFrames]
                            .filter((image) => Boolean(image?.dataUrl))
                            .map((image) => [image.id || image.dataUrl, image]),
                    ).values(),
                );

                const videoNote = uniqueVideos.length
                    ? `\n\n${t("canvas.chat.linkedVideoNote", { count: uniqueVideos.length, titles: uniqueVideos.map((item) => item.title).join("ã") })}`
                    : "";
                const promptText = `${userText}${videoNote}`;
                const userContent: AiTextMessage["content"] = referenceImages.length
                    ? [{ type: "text" as const, text: promptText }, ...referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                    : promptText;

                const requestMessages: AiTextMessage[] = [
                    ...(typedText && linkedText && typedText !== linkedText ? [{ role: "system" as const, content: `${t("canvas.chat.contextLabel")}:\n${linkedText}` }] : []),
                    ...historyMessages,
                    { role: "user", content: userContent },
                ];
                const skillIds = resolveChatSkillIds(sourceNode.metadata?.chatSkillIds);
                const skillTools = resolveChatSkillTools(skillIds);
                const skillsHint = chatSkillsSystemHint(skillIds);
                const messagesWithSkills: AiTextMessage[] = skillsHint
                    ? [{ role: "system", content: skillsHint }, ...requestMessages]
                    : requestMessages;
                const answer = await requestImageQuestion(
                    textConfig!,
                    messagesWithSkills,
                    (streamed) => updateAssistantMessage({ text: streamed }),
                    {
                        signal: controller.signal,
                        ...(skillTools.length
                            ? {
                                  tools: skillTools,
                                  executeTool: (name, args) =>
                                      executeChatSkillTool(name, args, {
                                          chatNodeId: nodeId,
                                          nodes: nodesRef.current,
                                          connections: connectionsRef.current,
                                          updateNodeMetadata: (targetId, patch) => {
                                              setNodes((prev) => {
                                                  const next = prev.map((node) => (node.id === targetId ? applyNodeConfigPatch(node, patch) : node));
                                                  nodesRef.current = next;
                                                  return next;
                                              });
                                          },
                                          selectNode: (targetId) => {
                                              setSelectedNodeIds(new Set([targetId]));
                                              setDialogNodeId(targetId);
                                          },
                                      }),
                                  onToolStart: (name) => updateAssistantMessage({ text: t("canvas.chat.skillsUsing", { name }) }),
                              }
                            : {}),
                    },
                );
                updateAssistantMessage({ text: answer });
                return answer;
            };

            const runImageTask = async () => {
                const imageContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, userText));
                const mentionRefs = buildNodeMentionReferences(sourceNode, nodesRef.current, connectionsRef.current).filter((reference) => reference.active);
                const mentionedImages = mentionRefs.filter((reference) => reference.kind === "image" && userText.includes(reference.label));
                const mentionedVideos = mentionRefs.filter((reference) => reference.kind === "video" && userText.includes(reference.label));
                const resolvedMentions = mentionedImages.length ? await resolveCanvasReferenceImages(mentionedImages, nodesRef.current) : [];
                const videoSources = [
                    ...(imageContext.referenceVideos || []).map((video) => ({ id: video.id, title: video.name || video.id, url: video.url })),
                    ...mentionedVideos
                        .map((reference) => {
                            const videoNode = nodesRef.current.find((item) => item.id === reference.nodeId);
                            return videoNode?.metadata?.content ? { id: reference.nodeId, title: reference.title, url: videoNode.metadata.content } : null;
                        })
                        .filter((item): item is { id: string; title: string; url: string } => Boolean(item)),
                ];
                const uniqueVideos = Array.from(new Map(videoSources.map((item) => [item.id, item])).values());
                const videoFrames = (
                    await Promise.all(
                        uniqueVideos.map(async (video) => {
                            const frame = await captureVideoFrameDataUrl(video.url);
                            if (!frame) return null;
                            return { id: `video-frame:${video.id}`, name: `${video.title}.jpg`, type: "image/jpeg", dataUrl: frame } satisfies ReferenceImage;
                        }),
                    )
                ).filter((item): item is ReferenceImage => Boolean(item));
                const referenceImages = Array.from(
                    new Map(
                        [...composerLinkedImages, ...(resolvedMentions.length ? resolvedMentions : imageContext.referenceImages), ...videoFrames]
                            .filter((image) => Boolean(image?.dataUrl))
                            .map((image) => [image.id || image.dataUrl, image]),
                    ).values(),
                );
                const results = referenceImages.length
                    ? await requestEdit({ ...imageConfig!, count: "1" }, imageContext.prompt || userText, referenceImages, undefined, { signal: controller.signal })
                    : await requestGeneration({ ...imageConfig!, count: "1" }, imageContext.prompt || userText, { signal: controller.signal });
                const uploadedImages = await Promise.all(results.map(async (item) => uploadGeneratedImage(item)));
                const chatImages = uploadedImages.map((uploaded, index) => ({
                    id: `${assistantId}-${index}`,
                    dataUrl: uploaded.url,
                    storageKey: uploaded.storageKey,
                    prompt: userText,
                }));
                updateAssistantMessage(
                    runText
                        ? { images: chatImages }
                        : {
                              text: t("canvas.chat.generatedImageResult", { count: chatImages.length }),
                              images: chatImages,
                          },
                );
                return chatImages;
            };

            try {
                const [textResult, imageResult] = await Promise.allSettled([
                    runText ? runTextTask() : Promise.resolve(null),
                    runImage ? runImageTask() : Promise.resolve(null),
                ]);

                if (controller.signal.aborted) return;

                const errors: string[] = [];
                if (textResult.status === "rejected") {
                    const reason = textResult.reason;
                    if (!isGenerationCanceled(reason)) errors.push(reason instanceof Error ? reason.message : String(reason));
                }
                if (imageResult.status === "rejected") {
                    const reason = imageResult.reason;
                    if (!isGenerationCanceled(reason)) errors.push(reason instanceof Error ? reason.message : String(reason));
                }

                if (controller.signal.aborted) return;

                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id !== nodeId) return node;
                        const currentAssistant = (node.metadata?.messages || []).find((message) => message.id === assistantId);
                        const hasText = Boolean(currentAssistant?.text?.trim());
                        const hasImages = Boolean(currentAssistant?.images?.length);
                        const allFailed = errors.length > 0 && !hasText && !hasImages;

                        if (allFailed) {
                            const messages = (node.metadata?.messages || []).map((message) =>
                                message.id === assistantId ? { ...message, role: "error" as const, text: errors.join("\n") } : message,
                            );
                            return { ...node, metadata: { ...node.metadata, messages, status: NODE_STATUS_ERROR, errorDetails: errors.join("\n") } };
                        }

                        let nextText = currentAssistant?.text || "";
                        if (errors.length) {
                            const note = t("canvas.chat.partialError", { error: errors.join("\n") });
                            nextText = nextText ? `${nextText}\n\n${note}` : note;
                        }

                        const messages = (node.metadata?.messages || []).map((message) =>
                            message.id === assistantId ? { ...message, text: nextText || message.text, role: "assistant" as const } : message,
                        );
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                messages,
                                status: NODE_STATUS_SUCCESS,
                                errorDetails: errors.length ? errors.join("\n") : undefined,
                            },
                        };
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error) || controller.signal.aborted) return;
                const errorDetails = error instanceof Error ? error.message : String(error);
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id !== nodeId) return node;
                        const messages = (node.metadata?.messages || []).map((message) => (message.id === assistantId ? { ...message, role: "error" as const, text: errorDetails } : message));
                        return { ...node, metadata: { ...node.metadata, messages, status: NODE_STATUS_ERROR, errorDetails } };
                    }),
                );
            } finally {
                finishGenerationRequest(nodeId, controller);
                setRunningNodeId((current) => (current === nodeId ? null : current));
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, openConfigDialog, startGenerationRequest, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadGeneratedImage(image);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, []);
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        if (isCanvasTextInteractionTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);
    // Right-click "最大化显示" on a video node. The player owns the <video> element, so we ask it
    // through the media registry (keyed by node id). This also works before activation: the player
    // renders the element first, then goes fullscreen.
    const handleMaximizeVideo = useCallback((node: CanvasNodeData) => {
        getCanvasMediaToggle(node.id)?.maximize?.();
    }, []);

    const contextMenuNode = useMemo(() => {
        if (!contextMenu || contextMenu.type !== "node") return null;
        return nodes.find((node) => node.id === contextMenu.nodeId) || null;
    }, [contextMenu, nodes]);

    const imageContextHandlers = useMemo<ImageToolHandlers>(
        () => ({
            onUpload: (node) => handleUploadRequest(node.id),
            onToggleFreeResize: (node) => toggleNodeFreeResize(node.id),
            onScale: (node) => setScaleNodeId(node.id),
            onResetSize: (node) => resetSelectedNodesToOriginalSize([node.id]),
            onMaskEdit: (node) => setMaskEditNodeId(node.id),
            onAnnotate: (node) => {
                if (!node.metadata?.content) {
                    handleUploadRequest(node.id);
                    return;
                }
                setAnnotateNodeId(node.id);
            },
            onCrop: (node) => setCropNodeId(node.id),
            onSplit: (node) => setSplitNodeId(node.id),
            onUpscale: openImageUpscale,
            onSuperResolve: (node) => setSuperResolveNodeId(node.id),
            onAngle: (node) => setAngleNodeId(node.id),
            onPanorama: (node) => setPanoramaNodeId(node.id),
            onAdjust: (node) => setAdjustNodeId(node.id),
            onViewImage: handleNodeViewImage,
            onCopyPrompt: (node) => {
                const prompt = node.metadata?.prompt?.trim();
                if (!prompt) {
                    message.warning(t("canvas.nodeToolbar.noPrompt"));
                    return;
                }
                copyText(prompt, t("common.promptCopied"));
            },
            onReversePrompt: createImageReversePromptNodes,
        }),
        [copyText, createImageReversePromptNodes, handleNodeViewImage, handleUploadRequest, message, openImageUpscale, resetSelectedNodesToOriginalSize, t, toggleNodeFreeResize],
    );

    // Stable callback references for CanvasNode props. Inline arrow functions here would be
    // recreated on every parent render and defeat CanvasNode's React.memo, re-rendering every
    // node on every interaction (a major source of lag on dense canvases).
    const handleChatModelChange = useCallback((nodeId: string, model: string) => handleConfigNodeChange(nodeId, { model }), [handleConfigNodeChange]);
    const handleChatImageModelChange = useCallback((nodeId: string, model: string) => handleConfigNodeChange(nodeId, { imageModel: model }), [handleConfigNodeChange]);
    const handleChatModesChange = useCallback(
        (nodeId: string, options: { text: boolean; image: boolean }) => handleConfigNodeChange(nodeId, { chatTextEnabled: options.text, chatImageEnabled: options.image }),
        [handleConfigNodeChange],
    );
    const handleChatSkillsChange = useCallback((nodeId: string, skillIds: string[]) => handleConfigNodeChange(nodeId, { chatSkillIds: skillIds }), [handleConfigNodeChange]);
    const handleDeleteChatMessage = useCallback(
        (nodeId: string, messageId: string) => {
            const target = nodesRef.current.find((node) => node.id === nodeId);
            const deleted = target?.metadata?.messages?.find((message) => message.id === messageId);
            if (target?.metadata?.status === NODE_STATUS_LOADING && deleted?.role === "assistant") {
                stopGenerationForNode(nodeId);
            }
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== nodeId) return node;
                    const messages = (node.metadata?.messages || []).filter((message) => message.id !== messageId);
                    const clearLoading = node.metadata?.status === NODE_STATUS_LOADING && deleted?.role === "assistant";
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            messages,
                            ...(clearLoading ? { status: NODE_STATUS_IDLE, errorDetails: undefined } : {}),
                        },
                    };
                }),
            );
        },
        [stopGenerationForNode],
    );
    const handleInsertChatImage = useCallback((image: CanvasAssistantImage) => void insertAssistantImage(image), [insertAssistantImage]);
    const handleEditText = useCallback((node: CanvasNodeData) => setTextEditNodeId(node.id), []);
    const handleAnnotate = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) {
                handleUploadRequest(node.id);
                return;
            }
            setAnnotateNodeId(node.id);
        },
        [handleUploadRequest],
    );

    const handleNodeSchedule = useCallback((nodeId: string, at: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scheduledAt: at } } : node)));
    }, []);

    const handleCancelNodeSchedule = useCallback((nodeId: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scheduledAt: undefined } } : node)));
    }, []);

    // 脚本生成：走文本模型通道（与 Chat 节点同一条 requestImageQuestion），把分镜表 system prompt +
    // 结构化任务发给模型，边流边把原始文本写进 scriptRaw，结束后解析成 scriptRows。
    const runScriptGeneration = useCallback(
        async (nodeId: string, overrides?: { scriptSource?: string; scriptPrompt?: string }) => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Script) return;
            if (isNodeGenerating(nodeId)) return;
            const manualSource = (overrides?.scriptSource ?? sourceNode.metadata?.scriptSource ?? "").trim();
            // 输出格式预设：决定系统提示词、任务书措辞与解析用的列定义（见 constant/story-script.ts）。
            const presetId = resolveStoryScriptPresetId(sourceNode.metadata?.scriptPreset);
            // 每段时长（不指定 / 10s / 15s）：写进任务书，要求模型按这个长度规划连续镜头。
            const segmentSeconds = sourceNode.metadata?.scriptSegmentSeconds;
            const context = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, "");
            const sourceText = manualSource || context.prompt.trim();
            // 连线上游的「角色」图片（「角色生成分镜脚本」建出来的角色图）作为角色参考，名字取节点标题，
            // 与分镜表里的角色字段对齐；只有图片、没有剧本正文时也允许生成。
            // 场景 / 道具 / 站位图同样作为多模态输入喂给模型，但**不写进角色参考名单**，免得模型把
            // 「办公室」当成一个人物。
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(sourceNode.metadata?.scriptAssetRoles?.[assetNodeId]);
            const characterRefs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current)
                .filter((input) => input.type === "image" && assetRoleOf(input.nodeId) === "character")
                .map((input) => input.title.trim())
                .filter(Boolean)
                .join("、");
            if (!sourceText && !context.referenceImages.length) {
                message.warning(t("canvas.scriptNode.sourceRequired"));
                return;
            }
            const task = buildStoryScriptTask({ sourceText, prompt: overrides?.scriptPrompt ?? sourceNode.metadata?.scriptPrompt, characterRefs, preset: presetId, segmentSeconds });
            const textNode = { ...sourceNode, metadata: { ...sourceNode.metadata, generationMode: "text" as const } };
            const textConfig = buildGenerationConfig(effectiveConfig, textNode, "text");
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const controller = new AbortController();
            startGenerationRequest(nodeId, nodeId, nodeId, controller);
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "loading", scriptRaw: "", errorDetails: undefined } } : node)));
            try {
                // 连线参考图作为多模态输入喂给视觉模型；hydrate 会把画布资源转成可发送的 dataUrl。
                const hydrated = context.referenceImages.length ? await hydrateNodeGenerationContext(context) : context;
                const userContent: AiTextMessage["content"] = hydrated.referenceImages.length
                    ? [{ type: "text" as const, text: task }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                    : task;
                const answer = await requestImageQuestion(
                    textConfig,
                    [
                        { role: "system", content: resolveScriptSystemPrompt(presetId, sourceNode.metadata?.scriptSystemPrompt) },
                        { role: "user", content: userContent },
                    ],
                    (streamed) => setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptRaw: streamed } } : node))),
                    { signal: controller.signal },
                );
                if (controller.signal.aborted) return;
                const parsed = parseStoryScriptOutput(answer, presetId);
                if (!parsed.ok) {
                    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: parsed.error, scriptRaw: answer } } : node)));
                    message.error(t("canvas.scriptNode.parseFailed"));
                    return;
                }
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId
                            ? {
                                  ...node,
                                  title: parsed.title || node.title,
                                  metadata: { ...node.metadata, scriptStatus: "success", scriptRows: parsed.rows, scriptTitle: parsed.title, scriptRaw: answer, errorDetails: undefined },
                              }
                            : node,
                    ),
                );
                message.success(t("canvas.scriptNode.generated", { count: parsed.rows.length }));
            } catch (error) {
                if (controller.signal.aborted) return;
                const detail = error instanceof Error ? error.message : String(error);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: detail } } : node)));
                message.error(detail);
            } finally {
                finishGenerationRequest(nodeId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNodeGenerating, message, openConfigDialog, startGenerationRequest, t],
    );

    const handleStopScriptGeneration = useCallback(
        (nodeId: string) => {
            stopGenerationForNode(nodeId);
            setNodes((prev) => prev.map((node) => (node.id === nodeId && node.metadata?.scriptStatus === "loading" ? { ...node, metadata: { ...node.metadata, scriptStatus: "idle" } } : node)));
        },
        [stopGenerationForNode],
    );

    // 按镜重生成（「重生成本镜」）：只重写这一行的全部列（保留镜号与行位置），并把「上一镜 / 下一镜」
    // 作为上下文喂进去——尽量保持场景、道具与人物站位的连续性。文本渠道与整表生成完全一致，
    // 只是任务书换成「只输出这一镜」（buildStoryScriptRowTask）。
    const runScriptShotGeneration = useCallback(
        async (nodeId: string, rowIndex: number) => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Script) return;
            if (isNodeGenerating(nodeId)) return;
            const rows = sourceNode.metadata?.scriptRows || [];
            const row = rows[rowIndex];
            if (!row) return;
            const presetId = resolveStoryScriptPresetId(sourceNode.metadata?.scriptPreset);
            const segmentSeconds = sourceNode.metadata?.scriptSegmentSeconds;
            const context = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, "");
            const sourceText = (sourceNode.metadata?.scriptSource || "").trim() || context.prompt.trim();
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(sourceNode.metadata?.scriptAssetRoles?.[assetNodeId]);
            const characterRefs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current)
                .filter((input) => input.type === "image" && assetRoleOf(input.nodeId) === "character")
                .map((input) => input.title.trim())
                .filter(Boolean)
                .join("、");
            const task = buildStoryScriptRowTask({
                preset: presetId,
                sourceText,
                prompt: sourceNode.metadata?.scriptPrompt,
                row,
                prev: rowIndex > 0 ? rows[rowIndex - 1] : undefined,
                next: rowIndex < rows.length - 1 ? rows[rowIndex + 1] : undefined,
                characterRefs,
                segmentSeconds,
            });
            const textNode = { ...sourceNode, metadata: { ...sourceNode.metadata, generationMode: "text" as const } };
            const textConfig = buildGenerationConfig(effectiveConfig, textNode, "text");
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const controller = new AbortController();
            startGenerationRequest(nodeId, nodeId, nodeId, controller);
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "loading", errorDetails: undefined } } : node)));
            try {
                const hydrated = context.referenceImages.length ? await hydrateNodeGenerationContext(context) : context;
                const userContent: AiTextMessage["content"] = hydrated.referenceImages.length
                    ? [{ type: "text" as const, text: task }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                    : task;
                const answer = await requestImageQuestion(
                    textConfig,
                    [
                        { role: "system", content: resolveScriptSystemPrompt(presetId, sourceNode.metadata?.scriptSystemPrompt) },
                        { role: "user", content: userContent },
                    ],
                    () => {},
                    { signal: controller.signal },
                );
                if (controller.signal.aborted) return;
                const parsed = parseStoryScriptOutput(answer, presetId);
                if (!parsed.ok || !parsed.rows.length) {
                    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: parsed.ok ? "模型未返回这一镜" : parsed.error } } : node)));
                    message.error(t("canvas.scriptNode.parseFailed"));
                    return;
                }
                // 行位置与镜号以原表为准；重写结果只覆盖这一行的各列内容。
                const nextRows = rows.map((item, index) => (index === rowIndex ? { ...parsed.rows[0], shot_no: item.shot_no || index + 1 } : item));
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId
                            ? { ...node, metadata: { ...node.metadata, scriptStatus: "success", scriptRows: nextRows, scriptRaw: storyScriptToMarkdown(nextRows, node.metadata?.scriptTitle, presetId), errorDetails: undefined } }
                            : node,
                    ),
                );
                message.success(t("canvas.scriptNode.regenShotDone", { no: row.shot_no || rowIndex + 1 }));
            } catch (error) {
                if (controller.signal.aborted) return;
                const detail = error instanceof Error ? error.message : String(error);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: detail } } : node)));
                message.error(detail);
            } finally {
                finishGenerationRequest(nodeId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNodeGenerating, message, openConfigDialog, startGenerationRequest, t],
    );

    // 整表重生成（「重新生成整表」）：等价于再点一次生成，用于追回缺失的资产 / 列。UI 已先做过确认。
    const handleRegenerateScriptAll = useCallback((nodeId: string) => void runScriptGeneration(nodeId), [runScriptGeneration]);

    // 把某一镜的分镜提示词落成画布上的文本节点，方便直接接进生图链路。
    const handleInsertShotPrompt = useCallback((nodeId: string, text: string, title: string) => {
        if (!text.trim()) return;
        const source = nodesRef.current.find((item) => item.id === nodeId);
        if (!source) return;
        const node = createCanvasNode(CanvasNodeType.Text, { x: source.position.x + source.width + 48, y: source.position.y });
        setNodes((prev) => [...prev, { ...node, title, metadata: { ...node.metadata, content: text, prompt: text } }]);
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
    }, []);

    // 「试一试」快捷动作：在脚本节点左侧建好对应上游节点并连边（对标剧集画布 ScriptNode.handlePickAction）。
    // - 剧本生成分镜脚本     → 1 个文本节点（剧本）
    // - 视频参考生成分镜脚本 → 1 个视频节点
    // - 角色生成分镜脚本     → 2 个图片节点（角色 1 / 角色 2，垂直堆叠）
    const handleScriptAction = useCallback(
        (nodeId: string, action: ScriptGenAction) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source) return;
            const gapX = 48;
            const gapY = 24;
            const build = (type: CanvasNodeType, title: string) => ({ ...createCanvasNode(type, { x: 0, y: 0 }), title });
            const seeds: CanvasNodeData[] =
                action === "fromVideoRef"
                    ? [build(CanvasNodeType.Video, t("canvas.scriptNode.spawnVideoRef"))]
                    : action === "fromCharacter"
                      ? [build(CanvasNodeType.Image, t("canvas.scriptNode.spawnCharacter", { index: 1 })), build(CanvasNodeType.Image, t("canvas.scriptNode.spawnCharacter", { index: 2 }))]
                      : [build(CanvasNodeType.Text, t("canvas.scriptNode.spawnScreenplay"))];
            if (!seeds.length) return;
            const { width, height } = seeds[0];
            const totalHeight = height * seeds.length + gapY * (seeds.length - 1);
            const baseX = source.position.x - width - gapX;
            const startY = source.position.y + (source.height - totalHeight) / 2;
            const placed = seeds.map((node, index) => ({ ...node, position: { x: baseX, y: startY + index * (height + gapY) } }));
            setNodes((prev) => [...prev, ...placed]);
            setConnections((prev) => [...prev, ...placed.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: nodeId }))]);
            setSelectedNodeIds(new Set(placed.map((node) => node.id)));
            setSelectedConnectionId(null);
        },
        [t],
    );

    // 脚本节点「添加资产」的候选：画布上能当参考用的节点（图片 / 视频 / 音频 / 文本），排除自己与已经连上去的上游。
    // 与 getConfigInputs / getMentionReferences 同理做按节点懒缓存，避免每次节点变动都全量重算一遍。
    const scriptAssetCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[]; map: Map<string, ScriptAssetCandidate[]> } | null>(null);
    const getScriptAssetCandidates = useCallback(
        (nodeId: string) => {
            const cache = scriptAssetCacheRef.current;
            if (!cache || cache.nodes !== nodes || cache.connections !== connections) {
                scriptAssetCacheRef.current = { nodes, connections, map: new Map() };
            }
            const current = scriptAssetCacheRef.current!;
            const hit = current.map.get(nodeId);
            if (hit) return hit;
            const linked = new Set(connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId));
            const candidates = nodes
                .filter((node) => node.id !== nodeId && !linked.has(node.id))
                .flatMap((node): ScriptAssetCandidate[] => {
                    if (node.type === CanvasNodeType.Image && node.metadata?.content) {
                        return [{ id: node.id, title: node.title, kind: "image", previewUrl: node.metadata.thumbnailContent || node.metadata.content }];
                    }
                    if (node.type === CanvasNodeType.Video && node.metadata?.content) return [{ id: node.id, title: node.title, kind: "video" }];
                    if (node.type === CanvasNodeType.Audio && (node.metadata?.content || node.metadata?.storageKey)) return [{ id: node.id, title: node.title, kind: "audio" }];
                    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return [{ id: node.id, title: node.title, kind: "text" }];
                    return [];
                });
            current.map.set(nodeId, candidates);
            return candidates;
        },
        [connections, nodes],
    );

    // 画布上**全部**图片节点（含已经连成脚本节点上游的那些）：逐镜「镜头图」用它做勾选列表与
    // 缩略图查表——镜头图与整表资产不同，它不需要「排除已连线」，所以不能复用上面那个按节点过滤的缓存。
    // 同样按 nodes 懒缓存，保证同一批 nodes 下数组引用稳定（逐镜弹窗靠引用判重，否则会渲染循环）。
    const scriptImageCacheRef = useRef<{ nodes: CanvasNodeData[]; list: ScriptAssetCandidate[] } | null>(null);
    const getScriptImageCandidates = useCallback(() => {
        const cache = scriptImageCacheRef.current;
        if (cache && cache.nodes === nodes) return cache.list;
        const list = nodes
            .filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content))
            .map((node): ScriptAssetCandidate => ({ id: node.id, title: node.title, kind: "image", previewUrl: node.metadata?.thumbnailContent || node.metadata?.content }));
        scriptImageCacheRef.current = { nodes, list };
        return list;
    }, [nodes]);

    // 把新素材摆在脚本节点左侧竖排，并连成它的上游素材（图片会因此成为后续生图的参考图）。
    // `connect = false` 给「逐镜镜头图」用：那些图只按镜关联、不做脚本节点的上游连线——否则会被
    // 当成整表共享的资产，铺链路时被每一镜都连一遍。
    const attachScriptAssets = useCallback((source: CanvasNodeData, items: Array<{ node: CanvasNodeData; width: number; height: number }>, connect = true) => {
        if (!items.length) return [] as CanvasNodeData[];
        const gap = 24;
        const totalHeight = items.reduce((sum, item) => sum + item.height, 0) + gap * (items.length - 1);
        let cursorY = source.position.y + (source.height - totalHeight) / 2;
        const placed = items.map((item) => {
            const next: CanvasNodeData = { ...item.node, width: item.width, height: item.height, position: { x: source.position.x - item.width - 48, y: cursorY } };
            cursorY += item.height + gap;
            return next;
        });
        setNodes((prev) => [...prev, ...placed]);
        if (connect) setConnections((prev) => [...prev, ...placed.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: source.id }))]);
        setSelectedNodeIds(new Set(placed.map((node) => node.id)));
        setSelectedConnectionId(null);
        return placed;
    }, []);

    // 本地文件 → 画布节点（图片 / 视频 / 音频）。抽出来给「脚本节点资产」与「逐镜镜头图」两条路复用，
    // 两者的差别只在「摆哪儿、连不连、记到哪」。返回项已带好宽高。
    const buildAssetItems = useCallback(
        async (files: File[]): Promise<Array<{ node: CanvasNodeData; width: number; height: number }>> => {
            const media = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/") || isAudioFile(file));
            if (!media.length) {
                message.warning(t("canvas.scriptNode.assetUnsupported"));
                return [];
            }
            const items: Array<{ node: CanvasNodeData; width: number; height: number }> = [];
            for (const file of media) {
                try {
                    if (isAudioFile(file)) {
                        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                        const audio = await uploadMediaFile(file, "audio");
                        const node = createCanvasNode(CanvasNodeType.Audio, { x: 0, y: 0 }, { ...audioMetadata(audio), prompt: file.name });
                        items.push({ node: { ...node, title: file.name || t("canvas.scriptNode.assetAudioTitle") }, width: spec.width, height: spec.height });
                    } else if (file.type.startsWith("video/")) {
                        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                        const video = await uploadMediaFile(file, "video");
                        const node = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { ...videoMetadata(video), prompt: file.name });
                        items.push({ node: { ...node, title: file.name || t("canvas.scriptNode.assetVideoTitle") }, width: video.width || spec.width, height: video.height || spec.height });
                    } else {
                        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                        const image = await uploadImage(file);
                        const size = fitNodeSize(image.width, image.height, spec.width, spec.height);
                        const node = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { ...imageMetadata(image), prompt: file.name });
                        items.push({ node: { ...node, title: file.name || t("canvas.scriptNode.assetImageTitle") }, width: size.width, height: size.height });
                    }
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("canvas.scriptNode.assetImportFailed"));
                }
            }
            return items;
        },
        [message, t],
    );

    // 导入本地图片 / 视频 / 音频到脚本节点：上传后建节点并自动连成上游素材，并按弹窗里选的分类落库。
    const handleImportScriptAssets = useCallback(
        async (nodeId: string, files: File[], role: ScriptAssetRole = "character") => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || !files.length) return;
            const items = await buildAssetItems(files);
            const placed = attachScriptAssets(source, items);
            if (placed.length) {
                // 音频节点一律归「音频」（它只连视频节点），其余按弹窗里选的分类（默认「角色」）。
                // 这里直接内联（而不是调 mergeScriptAssetRoles）——那个 helper 声明在本回调之后，
                // 放进依赖数组会在渲染期触发 TDZ。
                const roles: Record<string, ScriptAssetRole> = Object.fromEntries(placed.map((node) => [node.id, node.type === CanvasNodeType.Audio ? "audio" : role]));
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptAssetRoles: { ...(node.metadata?.scriptAssetRoles || {}), ...roles } } } : node)));
                message.success(t("canvas.scriptNode.assetImported", { count: placed.length }));
            }
        },
        [attachScriptAssets, buildAssetItems, message, t],
    );

    // 把「节点 id → 分类」写进 metadata.scriptAssetRoles：铺链路时据此决定素材连到哪些镜
    // （角色逐镜按名字匹配，场景 / 道具 / 站位图逐镜全连）。
    const mergeScriptAssetRoles = useCallback((nodeId: string, roles: Record<string, ScriptAssetRole>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptAssetRoles: { ...(node.metadata?.scriptAssetRoles || {}), ...roles } } } : node)));
    }, []);

    // 切换某张已链接素材的分类（脚本节点引用条上点分类胶囊时触发）。
    const handleAssetRoleChange = useCallback(
        (nodeId: string, assetNodeId: string, role: ScriptAssetRole) => {
            mergeScriptAssetRoles(nodeId, { [assetNodeId]: role });
        },
        [mergeScriptAssetRoles],
    );

    // 链接画布上已有节点为脚本节点的上游素材（等价于在画布上拖线，但不用离开脚本节点）。
    const handleLinkScriptAssets = useCallback(
        (nodeId: string, links: ScriptAssetLinkSelection[]) => {
            if (!links.length) return;
            setConnections((prev) => {
                const existing = new Set(prev.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId));
                const added = links.filter((link) => link.nodeId !== nodeId && !existing.has(link.nodeId)).map((link) => ({ id: nanoid(), fromNodeId: link.nodeId, toNodeId: nodeId }));
                return added.length ? [...prev, ...added] : prev;
            });
            mergeScriptAssetRoles(nodeId, Object.fromEntries(links.map((link) => [link.nodeId, link.role])));
            message.success(t("canvas.scriptNode.assetLinked", { count: links.length }));
        },
        [mergeScriptAssetRoles, message, t],
    );

    // 一键铺链路：每一镜铺出「文本（分镜提示词）→ 图片」两个节点，「视频」则按分段方式（单镜 / 每 N 镜 /
    // 按每段时长）合并——同一段里的多个关键帧会一起喂给那一个视频节点，多镜的提示词合成一条视频提示词。
    // 上游素材按分类连线：角色按分镜里的角色名逐镜匹配（名字一个都没对上时按「全连」兜底），场景 / 道具 /
    // 站位图对每一镜都成立。视频节点默认带上该段的运镜提示词（含分镜提示词）与总时长。
    /**
     * 铺完节点后把视角挪过去：否则节点落在脚本节点右侧屏幕外，用户会以为「点了没反应」。
     * - fit：把整组缩放进视口（单节点 / 少量节点）
     * - center：保持当前缩放，只把左上角那一片挪进视口（铺几十镜时整组太大，fit 会缩成蚂蚁）
     */
    const revealNodes = useCallback(
        (targets: CanvasNodeData[], mode: "fit" | "center" = "fit") => {
            if (!targets.length) return;
            const left = Math.min(...targets.map((item) => item.position.x));
            const top = Math.min(...targets.map((item) => item.position.y));
            const right = Math.max(...targets.map((item) => item.position.x + item.width));
            const bottom = Math.max(...targets.map((item) => item.position.y + item.height));
            const groupWidth = Math.max(1, right - left);
            const groupHeight = Math.max(1, bottom - top);
            const padding = 96;
            const k =
                mode === "fit"
                    ? Math.min(Math.max(Math.min((size.width - padding * 2) / groupWidth, (size.height - padding * 2) / groupHeight), 0.05), 1.2)
                    : Math.min(Math.max(viewportRef.current.k, 0.4), 1.2);
            const centerX = mode === "fit" ? left + groupWidth / 2 : left + Math.min(groupWidth, size.width / k) / 2;
            const centerY = mode === "fit" ? top + groupHeight / 2 : top + Math.min(groupHeight, size.height / k) / 2;
            cancelFocusAnimation();
            setViewport({ x: size.width / 2 - centerX * k, y: size.height / 2 - centerY * k, k });
        },
        [cancelFocusAnimation, size.height, size.width],
    );

    // AI 生成资产：手上没有图（或干脆想让 AI 出）时，用分镜表里的资产描述当提示词直接生成一张图。
    // 与「上传素材」走同一条路径——建图片节点 → 连成脚本节点上游 → 写上分类 → 立刻触发生成；
    // 图片节点会把结果写回自身，所以用户看到的就是「这张资产正在生成」。
    const handleGenerateScriptAsset = useCallback(
        (nodeId: string, role: ScriptAssetRole, prompt: string, title: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const scene = prompt.trim();
            if (!source || !scene) return;
            const assetTitle = title.trim() || scene.slice(0, 24);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const node = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { prompt: scene, status: NODE_STATUS_IDLE });
            const placed = attachScriptAssets(source, [{ node: { ...node, title: assetTitle }, width: spec.width, height: spec.height }]);
            const created = placed[0];
            if (!created) return;
            // 分类写进脚本节点（内联：mergeScriptAssetRoles 声明在本回调之后，进依赖数组会 TDZ）。
            const withRole = (item: CanvasNodeData) =>
                item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptAssetRoles: { ...(item.metadata?.scriptAssetRoles || {}), [created.id]: role } } } : item;
            // 必须立刻同步 nodesRef：attachScriptAssets 只改 state，而紧接着的触发生成会读 nodesRef
            // 判断「这是不是一个图片节点（结果写回自身）」——不同步就会在旁边多长出一个空节点。
            nodesRef.current = [...nodesRef.current, created].map(withRole);
            setNodes((prev) => prev.map(withRole));
            revealNodes([created], "center");
            message.success(t("canvas.scriptNode.assetGenerating", { title: assetTitle }));
            // 生图会把图片节点标题改写成「提示词前 32 字」，资产节点要留住用户给的名字，生成结束后改回来。
            void Promise.resolve(generateNodeRef.current?.(created.id, "image", scene)).finally(() => {
                setNodes((prev) => prev.map((item) => (item.id === created.id && item.title !== assetTitle ? { ...item, title: assetTitle } : item)));
            });
        },
        [attachScriptAssets, message, revealNodes, t],
    );

    // ---- 逐镜「镜头图」（metadata.scriptRowAssets）----
    // 与上面那套「整表资产」并列、但语义不同：资产是整表共享的参考图（按分类逐镜分派），镜头图是
    // **按镜指定**的成片关键帧，铺链路时只连到这一镜的图片节点、并随该分组合并进视频节点。
    // 三条路（导入 / 链接 / 生成）都写回同一张 map；这些图**不连**脚本节点，否则会被当成整表资产。

    /** 逐镜关联整体替换（弹窗确认、或缩略图上的 × 解绑）。 */
    const handleRowAssetsChange = useCallback((nodeId: string, shotNo: number, ids: string[]) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptRowAssets: setStoryScriptRowAssetIds(item.metadata?.scriptRowAssets, shotNo, ids) } } : item)));
    }, []);

    /** 把新节点追加关联到某一镜（保留这一镜已有的图）。 */
    const appendRowAssets = useCallback((nodeId: string, shotNo: number, ids: string[]) => {
        if (!ids.length) return;
        setNodes((prev) =>
            prev.map((item) =>
                item.id === nodeId
                    ? { ...item, metadata: { ...item.metadata, scriptRowAssets: setStoryScriptRowAssetIds(item.metadata?.scriptRowAssets, shotNo, [...scriptRowAssetIds(item.metadata?.scriptRowAssets, shotNo), ...ids]) } }
                    : item,
            ),
        );
    }, []);

    /**
     * 把逐镜图片（「镜头图」与「按镜按资产」图位，两者落点一致）摆在脚本节点**下方**横向排开（不连线）。
     * 刻意不复用 `attachScriptAssets`：它的落点是节点左侧，正好是「整表资产」的地盘，两类图会叠在一起。
     * 起始 x 按「这张表已经关联过多少张逐镜图」右移，连着导入几批也不会原地重叠。
     */
    const placeRowAssetNodes = useCallback((source: CanvasNodeData, items: Array<{ node: CanvasNodeData; width: number; height: number }>) => {
        if (!items.length) return [] as CanvasNodeData[];
        const gap = 24;
        const countMap = (map?: Record<string, string[]>) => Object.values(map || {}).reduce((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0);
        const laid = countMap(source.metadata?.scriptRowAssets) + countMap(source.metadata?.scriptCellAssets);
        let cursorX = source.position.x + laid * (NODE_DEFAULT_SIZE[CanvasNodeType.Image].width + gap);
        const baseY = source.position.y + source.height + 48;
        const placed = items.map((item) => {
            const next: CanvasNodeData = { ...item.node, width: item.width, height: item.height, position: { x: cursorX, y: baseY } };
            cursorX += item.width + gap;
            return next;
        });
        setNodes((prev) => [...prev, ...placed]);
        setSelectedNodeIds(new Set(placed.map((node) => node.id)));
        setSelectedConnectionId(null);
        return placed;
    }, []);

    /** 逐镜导入本地图片：建节点并立刻关联到这一镜（只收图片，视频 / 音频会被挡下并提示）。 */
    const handleRowAssetImport = useCallback(
        async (nodeId: string, shotNo: number, files: File[]) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || !files.length) return;
            const items = await buildAssetItems(files);
            const images = items.filter((item) => item.node.type === CanvasNodeType.Image);
            if (!images.length) {
                if (items.length) message.warning(t("canvas.scriptNode.rowImageOnlyImages"));
                return;
            }
            const placed = placeRowAssetNodes(source, images);
            if (!placed.length) return;
            appendRowAssets(nodeId, shotNo, placed.map((node) => node.id));
            revealNodes(placed, "center");
            message.success(t("canvas.scriptNode.rowImageImported", { count: placed.length, no: shotNo }));
        },
        [appendRowAssets, buildAssetItems, message, placeRowAssetNodes, revealNodes, t],
    );

    /** 逐镜 AI 生成图片：建图片节点、关联到这一镜并立刻触发生图。 */
    const handleRowAssetGenerate = useCallback(
        (nodeId: string, shotNo: number, prompt: string, title: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const scene = prompt.trim();
            if (!source || !scene) return;
            const assetTitle = title.trim() || scene.slice(0, 24);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const node = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { prompt: scene, status: NODE_STATUS_IDLE });
            const placed = placeRowAssetNodes(source, [{ node: { ...node, title: assetTitle }, width: spec.width, height: spec.height }]);
            const created = placed[0];
            if (!created) return;
            // 立刻同步 nodesRef：紧接着的触发生成会读 nodesRef 判断「这是不是一个图片节点（结果写回自身）」。
            nodesRef.current = [...nodesRef.current, created];
            appendRowAssets(nodeId, shotNo, [created.id]);
            revealNodes([created], "center");
            message.success(t("canvas.scriptNode.rowImageGenerating", { no: shotNo }));
            void Promise.resolve(generateNodeRef.current?.(created.id, "image", scene)).finally(() => {
                setNodes((prev) => prev.map((item) => (item.id === created.id && item.title !== assetTitle ? { ...item, title: assetTitle } : item)));
            });
        },
        [appendRowAssets, message, placeRowAssetNodes, revealNodes, t],
    );

    // ---- 按镜按资产图位（metadata.scriptCellAssets）----
    // 与「镜头图」共用落位与生成链路，差别只在键多带一个资产列：「第 3 镜 · 场景」格里加的图只属于
    // 第 3 镜的场景，铺链路时也只连到第 3 镜的图片 / 视频节点，并顶掉资产条对同一镜同一分类的分派。

    /** 资产列的显示名（「场景」「角色1」），只给提示文案用；取不到就回落列 key。 */
    const cellAssetColumnLabel = useCallback((source: CanvasNodeData, columnKey: string) => {
        const preset = getStoryScriptPreset(resolveStoryScriptPresetId(source.metadata?.scriptPreset));
        return preset.columns.find((column) => column.key === columnKey)?.label || columnKey;
    }, []);

    /** 资产格子里换的生图模型：落库成节点的默认值（下次打开这一格还是它）。 */
    const handleCellModelChange = useCallback((nodeId: string, model: string) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptCellImageModel: model || undefined } } : item)));
    }, []);

    /**
     * 按镜按资产整体替换（弹窗确认、或缩略图上的 × 解绑）。
     *
     * 顺带做**资产锁定**：把这一格刚链接好的图按**资产名**记进 `scriptNameLocks`
     * （「张三」→ @图片1、「客厅」→ @图片2），于是分镜表里别的镜再出现这个名字时也认同一张图。
     * 解绑（`ids` 为空）**不动锁** —— 锁只能靠格子上的 🔒 显式解除，免得一次误删就把锁定丢掉。
     */
    const handleCellAssetsChange = useCallback((nodeId: string, shotNo: number, columnKey: string, ids: string[]) => {
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const row = (item.metadata?.scriptRows || []).find((candidate, index) => (Number(candidate.shot_no) || index + 1) === shotNo);
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        scriptCellAssets: setStoryScriptCellAssetIds(item.metadata?.scriptCellAssets, shotNo, columnKey, ids),
                        scriptNameLocks: ids.length ? setStoryScriptNameLock(item.metadata?.scriptNameLocks, row?.[columnKey], ids) : item.metadata?.scriptNameLocks,
                    },
                };
            }),
        );
    }, []);

    /** 把新节点追加关联到某一格（保留这一格已有的图），并把新图**并进**同名资产锁。 */
    const appendCellAssets = useCallback((nodeId: string, shotNo: number, columnKey: string, ids: string[]) => {
        if (!ids.length) return;
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const row = (item.metadata?.scriptRows || []).find((candidate, index) => (Number(candidate.shot_no) || index + 1) === shotNo);
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        scriptCellAssets: setStoryScriptCellAssetIds(item.metadata?.scriptCellAssets, shotNo, columnKey, [...scriptCellAssetIds(item.metadata?.scriptCellAssets, shotNo, columnKey), ...ids]),
                        scriptNameLocks: addScriptNameLockForCell(item.metadata?.scriptNameLocks, row, columnKey, ids),
                    },
                };
            }),
        );
    }, []);

    /** 表里给某个资产名「上锁 / 解锁」：锁上就记下这一格当前的图，解开（`ids` 为空）就删掉这条锁。 */
    const handleNameLockChange = useCallback((nodeId: string, name: string, ids: string[]) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptNameLocks: setStoryScriptNameLock(item.metadata?.scriptNameLocks, name, ids) } } : item)));
    }, []);

    /** 解除这个分镜表的全部资产锁定（格子里的图片链接本身保留）。 */
    const handleClearNameLocks = useCallback((nodeId: string) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptNameLocks: undefined } } : item)));
    }, []);

    // ---- 资产池缩略图：拖拽换位 + 解除链接 ----

    /**
     * 资产池缩略图拖拽换位：把连到本节点的上游素材**连线顺序**按新顺序重排。
     *
     * 与 chat 节点那条 `handleReorderLinkedMedia` 的区别：这里**不做「条数必须相等」的校验** ——
     * 分镜表的引用条里可能有被停用的素材 / 走 Config 汇流进来的素材，严格校验会导致一拖就静默失效。
     * 认得的按新顺序落位，认不得的原封不动。
     */
    const handleReorderScriptAssets = useCallback((nodeId: string, orderedNodeIds: string[]) => {
        const order = new Map(orderedNodeIds.map((id, index) => [id, index]));
        if (order.size < 2) return;
        setConnections((prev) => {
            const incoming = prev.filter((conn) => conn.toNodeId === nodeId && order.has(conn.fromNodeId));
            if (incoming.length < 2) return prev;
            incoming.sort((a, b) => order.get(a.fromNodeId)! - order.get(b.fromNodeId)!);
            const incomingIds = new Set(incoming.map((conn) => conn.id));
            let pointer = 0;
            return prev.map((conn) => (conn.toNodeId === nodeId && incomingIds.has(conn.id) ? incoming[pointer++] : conn));
        });
    }, []);

    /**
     * 资产池缩略图上的「解除链接」：断掉上游连线，并把这张素材从**本表的所有引用**里摘干净
     * （按格 `scriptCellAssets` / 逐镜 `scriptRowAssets` / 按名 `scriptNameLocks` / 分类 `scriptAssetRoles`）。
     *
     * 只断线不清引用的话，表里还会继续显示一张「已经不属于这张表」的图，跟用户点「删除链接」的预期对不上。
     */
    const handleScriptAssetRemove = useCallback(
        (nodeId: string, assetNodeId: string) => {
            handleRemoveLinkedMedia(nodeId, assetNodeId);
            setNodes((prev) =>
                prev.map((item) => {
                    if (item.id !== nodeId) return item;
                    const roles = item.metadata?.scriptAssetRoles;
                    // 只在真要删时才复制，否则原引用透传（避免无意义的对象变更加热画布重渲）。
                    const nextRoles = roles && roles[assetNodeId] ? { ...roles } : roles;
                    if (nextRoles && nextRoles !== roles) delete nextRoles[assetNodeId];
                    return {
                        ...item,
                        metadata: {
                            ...item.metadata,
                            scriptCellAssets: stripStoryScriptAssetId(item.metadata?.scriptCellAssets, assetNodeId),
                            scriptRowAssets: stripStoryScriptAssetId(item.metadata?.scriptRowAssets, assetNodeId),
                            scriptNameLocks: stripStoryScriptAssetId(item.metadata?.scriptNameLocks, assetNodeId),
                            scriptAssetRoles: nextRoles,
                        },
                    };
                }),
            );
        },
        [handleRemoveLinkedMedia],
    );

    /** 按镜按资产导入本地图片：建节点并立刻关联到这一格（只收图片，视频 / 音频会被挡下并提示）。 */
    const handleCellAssetImport = useCallback(
        async (nodeId: string, shotNo: number, columnKey: string, files: File[]) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || !files.length) return;
            const items = await buildAssetItems(files);
            const images = items.filter((item) => item.node.type === CanvasNodeType.Image);
            if (!images.length) {
                if (items.length) message.warning(t("canvas.scriptNode.cellAssetOnlyImages"));
                return;
            }
            const placed = placeRowAssetNodes(source, images);
            if (!placed.length) return;
            appendCellAssets(nodeId, shotNo, columnKey, placed.map((node) => node.id));
            revealNodes(placed, "center");
            message.success(t("canvas.scriptNode.cellAssetImported", { count: placed.length, no: shotNo, label: cellAssetColumnLabel(source, columnKey) }));
        },
        [appendCellAssets, buildAssetItems, cellAssetColumnLabel, message, placeRowAssetNodes, revealNodes, t],
    );

    /**
     * 按镜按资产 AI 生成图片：建图片节点、关联到这一格并立刻触发生图。
     *
     * 生成的图**同时进整表资产池**：① 连成脚本节点的上游资产、② 按这一列的角色写进 `scriptAssetRoles` ——
     * 于是它出现在引用条与「@ 资产池」里，铺链路时也按该分类参与分派；同时仍记进 `scriptCellAssets`，
     * 保证这一镜这一格是「精准指定」的那一份（精准优先、资产条兜底）。
     *
     * `model` 是这一格单独挑的生图模型：写到新建图片节点的 `metadata.model` 上（生图链路优先用它），
     * 同时落库成脚本节点的 `scriptCellImageModel`，下次打开这一格还是这个模型。
     */
    const handleCellAssetGenerate = useCallback(
        (nodeId: string, shotNo: number, columnKey: string, prompt: string, title: string, model?: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const scene = prompt.trim();
            if (!source || !scene) return;
            const assetTitle = title.trim() || scene.slice(0, 24);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const node = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { prompt: scene, status: NODE_STATUS_IDLE, ...(model ? { model } : {}) });
            const placed = placeRowAssetNodes(source, [{ node: { ...node, title: assetTitle }, width: spec.width, height: spec.height }]);
            const created = placed[0];
            if (!created) return;
            // 立刻同步 nodesRef / connectionsRef：紧接着的触发生成会读 nodesRef 判断「这是不是一个图片节点（结果写回自身）」，
            // 铺链路则从 connectionsRef 里认「哪些是整表资产」。
            nodesRef.current = [...nodesRef.current, created];
            const connection: CanvasConnection = { id: nanoid(), fromNodeId: created.id, toNodeId: nodeId };
            connectionsRef.current = [...connectionsRef.current, connection];
            setConnections((prev) => [...prev, connection]);
            const role = scriptAssetColumnRole(columnKey) || "character";
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === nodeId
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  scriptAssetRoles: { ...(item.metadata?.scriptAssetRoles || {}), [created.id]: role },
                                  ...(model ? { scriptCellImageModel: model } : {}),
                              },
                          }
                        : item,
                ),
            );
            appendCellAssets(nodeId, shotNo, columnKey, [created.id]);
            revealNodes([created], "center");
            message.success(t("canvas.scriptNode.cellAssetGenerating", { no: shotNo, label: cellAssetColumnLabel(source, columnKey) }));
            void Promise.resolve(generateNodeRef.current?.(created.id, "image", scene)).finally(() => {
                setNodes((prev) => prev.map((item) => (item.id === created.id && item.title !== assetTitle ? { ...item, title: assetTitle } : item)));
            });
        },
        [appendCellAssets, cellAssetColumnLabel, message, placeRowAssetNodes, revealNodes, t],
    );

    const handleBuildScriptPipeline = useCallback(
        (nodeId: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || source.type !== CanvasNodeType.Script) return;
            const rows = source.metadata?.scriptRows || [];
            if (!rows.length) return;
            const presetId = resolveStoryScriptPresetId(source.metadata?.scriptPreset);
            const preset = getStoryScriptPreset(presetId);
            const segmentSeconds = source.metadata?.scriptSegmentSeconds;
            // **资产锁定**：一键铺链先把「分镜表里已经链接好的图片」按资产名锁成 名字 → 图片
            // （「张三」→ @图片1、「客厅」→ @图片2），再按这张锁表逐镜分派：表里凡是出现同名的地方
            // 都用同一张图。已有锁保留（并集），不会因为没有格子链接就被抹掉。
            const nameLocks = syncStoryScriptNameLocks(source.metadata?.scriptNameLocks, source.metadata?.scriptCellAssets, rows);
            // 现存节点 id：过滤掉已被删、但还留在 metadata.scriptRowAssets 里的镜头图，免得连出悬空线。
            const existingNodeIds = new Set(nodesRef.current.map((node) => node.id));
            // 上游图片节点 = 角色 / 场景 / 道具 / 站位图素材。分类决定它连到哪些镜：
            //   角色 → 按分镜里的角色名逐镜匹配；场景 / 道具 / 站位图 → 每一镜都连。
            // 音频素材单独拎出来：它不能参与生图，只连到视频节点（每段视频都连）。
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(source.metadata?.scriptAssetRoles?.[assetNodeId]);
            const upstreamNodes = Array.from(new Set(connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId)))
                .map((id) => nodesRef.current.find((node) => node.id === id))
                .filter((node): node is CanvasNodeData => Boolean(node));
            const upstreamAssets = upstreamNodes
                .filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content))
                .map((node) => ({ id: node.id, title: node.title, role: assetRoleOf(node.id) }));
            const characterRefs = upstreamAssets.filter((asset) => asset.role === "character");
            const globalRefs = upstreamAssets.filter((asset) => asset.role !== "character");
            const audioRefs = upstreamNodes
                .filter((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey))
                .map((node) => ({ id: node.id, title: node.title }));

            const textWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Text].width;
            // 文本节点默认 480 高，铺链路时压到 240：否则每一镜的横向三件套会占掉整屏。
            const textHeight = 240;
            const imageWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Image].width;
            const imageHeight = NODE_DEFAULT_SIZE[CanvasNodeType.Image].height;
            const videoWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Video].width;
            const videoHeight = NODE_DEFAULT_SIZE[CanvasNodeType.Video].height;
            const gapX = 48;
            const gapY = 72;
            const rowHeight = Math.max(textHeight, imageHeight, videoHeight);
            const baseX = source.position.x + source.width + 64;
            const baseY = source.position.y;
            const imageX = baseX + textWidth + gapX;
            const videoX = imageX + imageWidth + gapX;

            // 先摘掉「一行连图片提示词都凑不出来」的空行，再按分段方式切组——否则空行会把合并的镜数算歪。
            const renderable = rows
                .map((row, index) => ({ row, index, prompts: preset.buildShotPrompts(row) }))
                .filter((item) => Boolean(item.prompts.imagePrompt));
            if (!renderable.length) {
                message.warning(t("canvas.scriptNode.pipelineEmpty"));
                return;
            }
            // 分段方式（单镜 / 每 N 镜 / 按每段时长）决定「几个镜共用一个视频节点」。
            const groups = groupStoryScriptRows(
                renderable.map((item) => item.row),
                source.metadata?.scriptMergeMode,
                segmentSeconds,
            );

            const created: CanvasNodeData[] = [];
            const createdConnections: CanvasConnection[] = [];
            let assetLinkCount = 0;
            let cursor = 0;
            for (const group of groups) {
                const members = renderable.slice(cursor, cursor + group.rows.length);
                cursor += group.rows.length;
                const first = members[0];
                const last = members[members.length - 1];
                const topRow = baseY + first.index * (rowHeight + gapY);
                const bottomRow = baseY + last.index * (rowHeight + gapY) + rowHeight;
                const centeredY = (rowY: number, height: number) => rowY + (rowHeight - height) / 2;

                // 每一镜仍然各自保留「文本 → 图片」（关键帧按镜给），只有视频节点才合并（运镜按段给）。
                const imageNodes: CanvasNodeData[] = [];
                // 这一段视频用到的全部资产：角色按各镜角色名匹配，场景 / 道具 / 站位图每镜都算。
                // 汇总后直接连到视频节点 —— 生成的「视频生成窗口」里就能看到并引用这些资产图。
                const groupAssetIds = new Set<string>();
                for (const member of members) {
                    const rowY = baseY + member.index * (rowHeight + gapY);
                    const shotNo = member.row.shot_no || member.index + 1;
                    const textNode: CanvasNodeData = {
                        ...createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: member.prompts.imagePrompt, prompt: member.prompts.imagePrompt, status: NODE_STATUS_IDLE }),
                        title: t("canvas.scriptNode.pipelineText", { no: shotNo }),
                        width: textWidth,
                        height: textHeight,
                        position: { x: baseX, y: centeredY(rowY, textHeight) },
                    };
                    const imageNode: CanvasNodeData = {
                        ...createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { prompt: member.prompts.imagePrompt, status: NODE_STATUS_IDLE }),
                        title: t("canvas.scriptNode.pipelineImage", { no: shotNo }),
                        width: imageWidth,
                        height: imageHeight,
                        position: { x: imageX, y: centeredY(rowY, imageHeight) },
                    };
                    created.push(textNode, imageNode);
                    createdConnections.push({ id: nanoid(), fromNodeId: textNode.id, toNodeId: imageNode.id });
                    imageNodes.push(imageNode);
                    // 「按镜按资产」图位 + **资产锁定**：这一镜每一格该用哪张图 —— 格子图优先、资产锁兜底。
                    // 锁是按**资产名**记的，所以别的镜里出现同名（还是「张三」）时也认同一张 @图片。
                    const preciseRefs = scriptShotPreciseAssetRefs(source.metadata?.scriptCellAssets, nameLocks, shotNo, member.row, presetId);
                    const coveredRoles = new Set(preciseRefs.map((ref) => ref.role));
                    // 同一张图可能同时被「图位」「资产锁」「资产条」「镜头图」命中，连线去重，
                    // 免得画布上出现两条并行同源线（以前靠 coveredRoles 间接避开，现在直接去重更稳）。
                    const linkedIntoImage = new Set<string>();
                    for (const ref of preciseRefs) {
                        for (const preciseId of ref.ids) {
                            if (!existingNodeIds.has(preciseId) || linkedIntoImage.has(preciseId)) continue;
                            linkedIntoImage.add(preciseId);
                            createdConnections.push({ id: nanoid(), fromNodeId: preciseId, toNodeId: imageNode.id });
                            groupAssetIds.add(preciseId);
                            assetLinkCount += 1;
                        }
                    }
                    // 角色素材按名字匹配到这一镜；场景 / 道具 / 站位图对每一镜都成立，直接一起连上。
                    // 但「已经被图位 / 资产锁精准指定过」的那一路让位：角色列留空的不再参与名字匹配
                    // （`blankPreciseAssetColumns`），场景 / 道具 / 站位按 coveredRoles 跳过——精准优先、资产条兜底。
                    const barRow = blankPreciseAssetColumns(member.row, preciseRefs);
                    const barAssets = [
                        ...matchStoryScriptRowAssets(presetId, barRow, characterRefs),
                        ...globalRefs.filter((asset) => !coveredRoles.has(asset.role)),
                    ];
                    for (const asset of barAssets) {
                        if (linkedIntoImage.has(asset.id)) continue;
                        linkedIntoImage.add(asset.id);
                        createdConnections.push({ id: nanoid(), fromNodeId: asset.id, toNodeId: imageNode.id });
                        groupAssetIds.add(asset.id);
                        assetLinkCount += 1;
                    }
                    // 这一镜自己的「镜头图」：只连到**这一镜**的图片节点；同时进 groupAssetIds，
                    // 于是下面会把它们一并连到该段的视频节点——即「按镜头把图片连到图片节点和视频节点」。
                    for (const rowAssetId of scriptRowAssetIds(source.metadata?.scriptRowAssets, shotNo)) {
                        if (!existingNodeIds.has(rowAssetId) || linkedIntoImage.has(rowAssetId)) continue;
                        linkedIntoImage.add(rowAssetId);
                        createdConnections.push({ id: nanoid(), fromNodeId: rowAssetId, toNodeId: imageNode.id });
                        groupAssetIds.add(rowAssetId);
                        assetLinkCount += 1;
                    }
                }

                const merged = members.length > 1;
                const shotNoFrom = first.row.shot_no || first.index + 1;
                const shotNoTo = last.row.shot_no || last.index + 1;
                const shots = members.map((member) => ({
                    shotNo: member.row.shot_no || member.index + 1,
                    imagePrompt: member.prompts.imagePrompt,
                    videoPrompt: member.prompts.videoPrompt,
                }));
                const videoPrompt = merged
                    ? buildMergedVideoNodePrompt(shots)
                    : buildVideoNodePrompt(shots[0].imagePrompt, shots[0].videoPrompt) || shots[0].imagePrompt;
                const seconds = Math.min(20, storyScriptGroupDuration({ rows: members.map((member) => member.row) }));
                const videoNode: CanvasNodeData = {
                    ...createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { prompt: videoPrompt, status: NODE_STATUS_IDLE, ...(seconds ? { seconds: String(seconds) } : {}) }),
                    title: merged
                        ? t("canvas.scriptNode.pipelineVideoRange", { from: shotNoFrom, to: shotNoTo, count: members.length })
                        : t("canvas.scriptNode.pipelineVideo", { no: shotNoFrom }),
                    width: videoWidth,
                    height: videoHeight,
                    position: { x: videoX, y: topRow + (bottomRow - topRow - videoHeight) / 2 },
                };
                created.push(videoNode);
                // 这一段里的每个关键帧都喂给同一个视频节点 → 多镜合成一段连续视频。
                for (const imageNode of imageNodes) createdConnections.push({ id: nanoid(), fromNodeId: imageNode.id, toNodeId: videoNode.id });
                // 资产图也直接连到视频节点：视频生成窗口本身就是「已链接资产图片」的状态。
                // 脚本节点没连任何资产时 groupAssetIds 为空，这里自然一条都不加。
                for (const assetId of groupAssetIds) {
                    createdConnections.push({ id: nanoid(), fromNodeId: assetId, toNodeId: videoNode.id });
                    assetLinkCount += 1;
                }
                // 音频素材（背景音乐 / 配音）只连视频节点，每段视频都连上，用户可在视频窗口里换成该段要用的音轨。
                for (const audio of audioRefs) {
                    createdConnections.push({ id: nanoid(), fromNodeId: audio.id, toNodeId: videoNode.id });
                    assetLinkCount += 1;
                }
            }

            const shotCount = renderable.length;
            const videoCount = groups.length;
            modal.confirm({
                title: t("canvas.scriptNode.pipelineConfirmTitle"),
                content: t("canvas.scriptNode.pipelineConfirmBody", { shots: shotCount, nodes: created.length, videos: videoCount, links: assetLinkCount }),
                okText: t("canvas.scriptNode.pipelineBuild"),
                cancelText: t("common.cancel"),
                onOk: () => {
                    // 铺链的同时把「资产名 → 图片」锁表落库，表上就能看到这些名字已经锁定。
                    const nextLocks = Object.keys(nameLocks).length ? nameLocks : undefined;
                    const patchLocks = (item: CanvasNodeData) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptNameLocks: nextLocks } } : item);
                    nodesRef.current = [...nodesRef.current.map(patchLocks), ...created];
                    setNodes((prev) => [...prev.map(patchLocks), ...created]);
                    setConnections((prev) => [...prev, ...createdConnections]);
                    setSelectedNodeIds(new Set(created.map((node) => node.id)));
                    setSelectedConnectionId(null);
                    revealNodes(created, "center");
                    message.success(t("canvas.scriptNode.pipelineBuilt", { shots: shotCount, videos: videoCount }));
                },
            });
        },
        [message, modal, t, revealNodes],
    );

    /** 只给某一行分镜建一个视频节点（预填该镜视频提示词 / 时长，并把命中的角色素材 + 全局素材连上）。 */
    const handleBuildShotVideo = useCallback(
        (nodeId: string, rowIndex: number) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || source.type !== CanvasNodeType.Script) return;
            const rows = source.metadata?.scriptRows || [];
            const row = rows[rowIndex];
            if (!row) return;
            const presetId = resolveStoryScriptPresetId(source.metadata?.scriptPreset);
            const preset = getStoryScriptPreset(presetId);
            const prompts = preset.buildShotPrompts(row);
            const shotNo = row.shot_no || rowIndex + 1;
            const seconds = Math.min(20, Math.max(1, Math.round(Number(row.duration) || 0)));
            const videoWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Video].width;
            const videoHeight = NODE_DEFAULT_SIZE[CanvasNodeType.Video].height;
            const videoNode: CanvasNodeData = {
                ...createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, {
                    prompt: buildVideoNodePrompt(prompts.imagePrompt, prompts.videoPrompt) || prompts.imagePrompt,
                    status: NODE_STATUS_IDLE,
                    ...(seconds ? { seconds: String(seconds) } : {}),
                }),
                title: t("canvas.scriptNode.pipelineVideo", { no: shotNo }),
                width: videoWidth,
                height: videoHeight,
                position: { x: source.position.x + source.width + 64, y: source.position.y + (source.height - videoHeight) / 2 },
            };
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(source.metadata?.scriptAssetRoles?.[assetNodeId]);
            const upstreamNodes = Array.from(new Set(connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId)))
                .map((id) => nodesRef.current.find((node) => node.id === id))
                .filter((node): node is CanvasNodeData => Boolean(node));
            const upstreamAssets = upstreamNodes
                .filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content))
                .map((node) => ({ id: node.id, title: node.title, role: assetRoleOf(node.id) }));
            // 「按镜按资产」图位 + **资产锁定**：这一镜每一格该用哪张图（格子图优先、按资产名的锁兜底）；
            // 它们精准指定过的那几个分类，让资产条不再对同一镜重复分派。
            const nameLocks = syncStoryScriptNameLocks(source.metadata?.scriptNameLocks, source.metadata?.scriptCellAssets, rows);
            const preciseRefs = scriptShotPreciseAssetRefs(source.metadata?.scriptCellAssets, nameLocks, shotNo, row, presetId);
            const coveredRoles = new Set(preciseRefs.map((ref) => ref.role));
            const cellAssetRefs = preciseRefs.flatMap((ref) => ref.ids).filter((id) => nodesRef.current.some((node) => node.id === id));
            // 角色按这一镜的角色名匹配（已被图位 / 锁定过的角色列不再参与），场景 / 道具 / 站位图无条件连上。
            const barRow = blankPreciseAssetColumns(row, preciseRefs);
            const assets = [
                ...matchStoryScriptRowAssets(presetId, barRow, upstreamAssets.filter((asset) => asset.role === "character")),
                ...upstreamAssets.filter((asset) => asset.role !== "character" && !coveredRoles.has(asset.role)),
            ];
            // 音频素材只连视频节点（不参与生图），与整条铺链路一致。
            const audioRefs = upstreamNodes.filter((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey));
            // 这一镜自己的「镜头图」也直连视频节点；已删掉的图片节点直接跳过。
            const rowAssetRefs = scriptRowAssetIds(source.metadata?.scriptRowAssets, shotNo).filter((id) => nodesRef.current.some((node) => node.id === id));
            // 去重：同一张图可能同时是「图位 / 锁的图」和「镜头图」，别连出两条并行线。
            const linkIds = Array.from(new Set([...assets.map((asset) => asset.id), ...audioRefs.map((asset) => asset.id), ...rowAssetRefs, ...cellAssetRefs]));
            const links = linkIds.map((id) => ({ id: nanoid(), fromNodeId: id, toNodeId: videoNode.id }));
            nodesRef.current = [...nodesRef.current, videoNode];
            setNodes((prev) => [...prev, videoNode]);
            if (links.length) setConnections((prev) => [...prev, ...links]);
            setSelectedNodeIds(new Set([videoNode.id]));
            setSelectedConnectionId(null);
            revealNodes([videoNode], "fit");
            message.success(t("canvas.scriptNode.buildShotVideoDone", { no: shotNo }));
        },
        [message, t, revealNodes],
    );

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            panelNode.type === CanvasNodeType.Director ? null : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={getConfigInputs(panelNode.id)}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    isRunning={isNodeGenerating(panelNode.id)}
                    mentionReferences={getMentionReferences(panelNode.id)}
                    onReorderReferences={(orderedNodeIds) => handleReorderLinkedMedia(panelNode.id, orderedNodeIds)}
                    onRemoveReference={(referenceNodeId) => handleRemoveLinkedMedia(panelNode.id, referenceNodeId)}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onContentChange={handleNodeContentChange}
                    onGenerate={handleGenerateNode}
                    onStop={stopGenerationForNode}
                    scheduledAt={panelNode.metadata?.scheduledAt}
                    onSchedule={(at) => handleNodeSchedule(panelNode.id, at)}
                    onCancelSchedule={() => handleCancelNodeSchedule(panelNode.id)}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [getConfigInputs, getMentionReferences, handleCancelNodeSchedule, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, handleNodeSchedule, handleRemoveLinkedMedia, handleReorderLinkedMedia, isNodeGenerating, stopGenerationForNode],
    );

    const handleDirectorExport = useCallback(
        (directorNodeId: string) => async (kind: "image" | "video", blob: Blob) => {
            const director = nodesRef.current.find((node) => node.id === directorNodeId);
            const base = director?.position || getCanvasCenter();
            const offset = { x: base.x + (director?.width || 340) + 32, y: base.y };
            const node = createCanvasNode(kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, offset);
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            try {
                if (kind === "image") {
                    const image = await uploadImage(blob);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, width: image.width, height: image.height, metadata: { ...item.metadata, ...imageMetadata(image) } } : item)));
                } else {
                    const video = await uploadMediaFile(blob, "director");
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, width: video.width || 420, height: video.height || 236, metadata: { ...item.metadata, ...videoMetadata(video) } } : item)));
                }
            } catch {
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: "error" } } : item)));
            }
        },
        [getCanvasCenter],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => {
            if (contentNode.type === CanvasNodeType.Script) {
                const scriptSource = getScriptSource(contentNode.id);
                const scriptReferences = getMentionReferences(contentNode.id);
                // 「@ 资产池」的数据源：**已经连到本节点**的图片素材（带分类）。分镜表的资产格子里可以
                // 直接把池里的图挂进某一格，不必再去画布上找那张图、也不用重新上传一次。
                const scriptPoolAssets = scriptReferences
                    .filter((reference) => reference.kind === "image" && reference.active)
                    .map((reference) => ({
                        id: reference.nodeId,
                        title: reference.title,
                        kind: "image" as const,
                        previewUrl: reference.previewUrl,
                        role: resolveScriptAssetRole(contentNode.metadata?.scriptAssetRoles?.[reference.nodeId]),
                    }));
                return (
                    <CanvasScriptNodeContent
                        node={contentNode}
                        theme={theme}
                        isRunning={isNodeGenerating(contentNode.id)}
                        connectedText={scriptSource.text}
                        connectedTextCount={scriptSource.count}
                        onConfigChange={handleConfigNodeChange}
                        onGenerate={(nodeId, overrides) => void runScriptGeneration(nodeId, overrides)}
                        onStop={handleStopScriptGeneration}
                        onInsertPrompt={handleInsertShotPrompt}
                        references={scriptReferences}
                        onScriptAction={handleScriptAction}
                        assetCandidates={getScriptAssetCandidates(contentNode.id)}
                        onImportAssets={(nodeId, files, role) => void handleImportScriptAssets(nodeId, files, role)}
                        onGenerateAsset={handleGenerateScriptAsset}
                        onLinkAssets={handleLinkScriptAssets}
                        assetRoles={contentNode.metadata?.scriptAssetRoles}
                        onAssetRoleChange={handleAssetRoleChange}
                        rowAssets={contentNode.metadata?.scriptRowAssets}
                        imageCandidates={getScriptImageCandidates()}
                        onRowAssetsChange={handleRowAssetsChange}
                        onRowAssetImport={(nodeId, shotNo, files) => void handleRowAssetImport(nodeId, shotNo, files)}
                        onRowAssetGenerate={handleRowAssetGenerate}
                        cellAssets={contentNode.metadata?.scriptCellAssets}
                        onCellAssetsChange={handleCellAssetsChange}
                        onCellAssetImport={(nodeId, shotNo, columnKey, files) => void handleCellAssetImport(nodeId, shotNo, columnKey, files)}
                        onCellAssetGenerate={handleCellAssetGenerate}
                        poolAssets={scriptPoolAssets}
                        cellModel={contentNode.metadata?.scriptCellImageModel}
                        onCellModelChange={handleCellModelChange}
                        nameLocks={contentNode.metadata?.scriptNameLocks}
                        onNameLockChange={handleNameLockChange}
                        onClearNameLocks={handleClearNameLocks}
                        onReorderScriptAssets={handleReorderScriptAssets}
                        onRemoveScriptAsset={handleScriptAssetRemove}
                        onBuildPipeline={handleBuildScriptPipeline}
                        onBuildShotVideo={handleBuildShotVideo}
                        onRegenerateShot={(nodeId, rowIndex) => void runScriptShotGeneration(nodeId, rowIndex)}
                        onRegenerateAll={handleRegenerateScriptAll}
                        onNodeSizeChange={(nodeId, width, height) => {
                            // 脚本节点按内容自动适配时从左上角扩张：内容变多就向右下长，
                            // 不会因为「居中缩放」把自己挪到左侧素材节点上面去。
                            setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, width, height } : item)));
                        }}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.Merge) {
                return (
                    <CanvasMergeNodeContent
                        node={contentNode}
                        inputs={getConfigInputs(contentNode.id)}
                        isRunning={isNodeGenerating(contentNode.id)}
                        onConfigChange={handleConfigNodeChange}
                        onMerge={(nodeId) => void runMergeNode(nodeId)}
                        onNodeSizeChange={(nodeId, width, height) => {
                            setNodes((prev) =>
                                prev.map((item) =>
                                    item.id === nodeId
                                        ? {
                                              ...item,
                                              width,
                                              height,
                                              position: {
                                                  x: item.position.x + item.width / 2 - width / 2,
                                                  y: item.position.y + item.height / 2 - height / 2,
                                              },
                                          }
                                        : item,
                                ),
                            );
                        }}
                    />
                );
            }
            return (
                <CanvasConfigNodePanel
                    node={contentNode}
                    isRunning={isNodeGenerating(contentNode.id)}
                    inputSummary={getInputSummary(getConfigInputs(contentNode.id))}
                    onConfigChange={handleConfigNodeChange}
                    onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                    onStop={stopGenerationForNode}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    }}
                />
            );
        },
        [getConfigInputs, getMentionReferences, getScriptAssetCandidates, getScriptImageCandidates, getScriptSource, handleAssetRoleChange, handleBuildScriptPipeline, handleBuildShotVideo, handleCellAssetGenerate, handleCellAssetImport, handleCellAssetsChange, handleCellModelChange, handleClearNameLocks, handleConfigNodeChange, handleGenerateNode, handleGenerateScriptAsset, handleImportScriptAssets, handleInsertShotPrompt, handleLinkScriptAssets, handleNameLockChange, handleRegenerateScriptAll, handleRowAssetGenerate, handleRowAssetImport, handleRowAssetsChange, handleScriptAction, handleStopScriptGeneration, isNodeGenerating, runMergeNode, runScriptGeneration, runScriptShotGeneration, stopGenerationForNode, theme],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => navigate("/")}
                    onProjects={() => navigate("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onExportProject={exportCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                />

                <CanvasMediaLibraryNotice />

                <AtelierCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={handleViewportChange}
                    onUserInteract={handleUserInteract}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={handleCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {visibleConnections.map((connection) => {
                            const from = withDragPreview(nodeById.get(connection.fromNodeId));
                            const to = withDragPreview(nodeById.get(connection.toNodeId));
                            if (!from || !to) return null;

                            return (
                                <ConnectionPath
                                    key={connection.id}
                                    connection={connection}
                                    from={from}
                                    to={to}
                                    active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                    selected={selectedConnectionId === connection.id}
                                    onSelect={() => {
                                        setSelectedConnectionId(connection.id);
                                        setSelectedNodeIds(new Set());
                                        setContextMenu(null);
                                    }}
                                    onContextMenu={(event) => {
                                        setSelectedConnectionId(connection.id);
                                        setSelectedNodeIds(new Set());
                                        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                    }}
                                    onDelete={() => deleteConnection(connection.id)}
                                />
                            );
                        })}
                        {connectingParams ? <ActiveConnectionPath node={withDragPreview(nodeById.get(connectingParams.nodeId))} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? withDragPreview(nodeById.get(connectionTargetNodeId)) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            getScale={getViewportScale}
                            previewOffset={dragPreviewIdSet?.has(node.id) && dragPreview ? { x: dragPreview.dx, y: dragPreview.dy } : undefined}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            showPanel={!isNodeResizing && !selectionBox && !getNodeDefinition(node.type)?.hidePanel && (dialogNodeId === node.id || (isNodeGenerating(node.id) && !dismissedGeneratingNodeIds.has(node.id)))}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedImageNodeIds.has(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={getMentionReferences(node.id)}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onCancelGeneration={stopGenerationForNode}
                            onGenerateImage={generateImageFromTextNode}
                            onCreateChat={createChatFromTextNode}
                            onExportDocument={downloadNodeImage}
                            onSendChat={sendChatMessage}
                            onChatModelChange={handleChatModelChange}
                            onChatImageModelChange={handleChatImageModelChange}
                            onChatModesChange={handleChatModesChange}
                            onChatSkillsChange={handleChatSkillsChange}
                            onDeleteChatMessage={handleDeleteChatMessage}
                            onInsertChatImage={handleInsertChatImage}
                            onFontSizeChange={handleFontSizeChange}
                            onReorderLinkedMedia={handleReorderLinkedMedia}
                            onEditText={handleEditText}
                            onViewImage={handleNodeViewImage}
                            onAnnotate={handleAnnotate}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                if (type === CanvasNodeType.Merge) createMergeNode(nodeCreatePosition);
                                else createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </AtelierCanvas>

                {directorPanelNode ? <DirectorPanel nodeId={directorPanelNode.id} open onClose={() => setDialogNodeId(null)} onExport={handleDirectorExport(directorPanelNode.id)} /> : null}

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedImageNodeIds.has(toolbarNode?.id || "") ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || DEFAULT_CANVAS_FONT_SIZE) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(48, (node.metadata?.fontSize || DEFAULT_CANVAS_FONT_SIZE) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onCreateChat={createChatFromTextNode}
                    onEditText={(node) => setTextEditNodeId(node.id)}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onAnnotate={(node) => {
                        if (!node.metadata?.content) {
                            handleUploadRequest(node.id);
                            return;
                        }
                        setAnnotateNodeId(node.id);
                    }}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={openImageUpscale}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onPanorama={(node) => setPanoramaNodeId(node.id)}
                    onAdjust={(node) => setAdjustNodeId(node.id)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onScale={(node) => setScaleNodeId(node.id)}
                    onResetSize={(node) => resetSelectedNodesToOriginalSize([node.id])}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                    onOpenVideoTools={openVideoTools}
                    onOpenAudioTools={openAudioTools}
                    onOpenAudioMerge={openAudioMerge}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canvasTool={canvasTool}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddChat={() => createNode(CanvasNodeType.Chat)}
                    onAddAnnotate={() => createNode(CanvasNodeType.Annotate)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onAddMerge={() => createMergeNode()}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                    onAddDirector={() => createNode(CanvasNodeType.Director)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        node={contextMenuNode}
                        imageHandlers={imageContextHandlers}
                        elevated={Boolean(previewContent)}
                        onClose={() => setContextMenu(null)}
                        onBeforeAction={
                            previewContent
                                ? () => {
                                      setPreviewNodeId(null);
                                      setPreviewImageId(null);
                                  }
                                : undefined
                        }
                        onInfo={(node) => setInfoNodeId(node.id)}
                        onDownload={downloadNodeImage}
                        onMaximizeVideo={handleMaximizeVideo}
                        onSaveAsset={(node) => void saveNodeAsset(node)}
                        onOpenVideoTools={openVideoTools}
                        onOpenAudioTools={openAudioTools}
                        onOpenAudioMerge={openAudioMerge}
                        onConvertType={(node, targetType) => {
                            convertNodeTypeById(node.id, targetType);
                            setContextMenu(null);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onCopyImage={() => {
                            if (contextMenu.type !== "node") return;
                            void copyNodeImageToClipboard(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav,text/*,.txt,.md,.markdown,.csv,.json,.docx,.pdf,.rtf,.html,.xml,.yaml,.yml" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {annotateNode?.metadata?.content ? (
                    <CanvasNodeAnnotateDialog
                        dataUrl={annotateNode.metadata.content}
                        open={Boolean(annotateNode)}
                        initialAnnotations={annotateNode.metadata.annotations || EMPTY_ANNOTATIONS}
                        onClose={() => setAnnotateNodeId(null)}
                        onSave={(payload) => void saveAnnotateNode(annotateNode, payload)}
                        onInpaint={(payload) => void inpaintAnnotateNode(annotateNode, payload)}
                        onAddTextNode={(text) => addTextNodeFromAnnotate(annotateNode, text)}
                        onReplaceImage={() => handleUploadRequest(annotateNode.id)}
                    />
                ) : null}

                <CanvasTextEditDialog
                    open={Boolean(textEditNode)}
                    value={textEditNode?.metadata?.content || ""}
                    fontSize={textEditNode?.metadata?.fontSize || DEFAULT_CANVAS_FONT_SIZE}
                    onFontSizeChange={(fontSize) => {
                        if (!textEditNode) return;
                        handleFontSizeChange(textEditNode.id, fontSize);
                    }}
                    onClose={() => setTextEditNodeId(null)}
                    onSave={(content) => {
                        if (!textEditNode) return;
                        handleNodeContentChange(textEditNode.id, content);
                    }}
                />

                <CanvasDraftSaveDialog
                    open={draftDialogOpen}
                    defaultName={draftMeta?.fileName?.replace(/\.zip$/i, "") || currentProject?.title || t("canvas.project.untitled")}
                    selectedFileName={
                        draftPickerDirectory
                            ? `${draftPickerDirectory.name}/${safeDraftFileName(draftMeta?.fileName?.replace(/\.zip$/i, "") || currentProject?.title || t("canvas.project.untitled"))}`
                            : draftPickerHandle?.name || (draftMeta?.folderName ? `${draftMeta.folderName}/${draftMeta.fileName}` : draftMeta?.fileName)
                    }
                    saving={draftSaving}
                    onClose={() => {
                        if (draftSaving) return;
                        setDraftDialogOpen(false);
                    }}
                    onPickPath={handleDraftPickPath}
                    onConfirm={handleDraftConfirm}
                />

                <CanvasTextClipboardMenu />

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                {videoToolsNode?.metadata?.content ? (
                    <CanvasNodeVideoToolsDialog
                        open={Boolean(videoToolsNode)}
                        videoUrl={videoToolsNode.metadata.content}
                        config={effectiveConfig}
                        onClose={() => setVideoToolsNodeId(null)}
                        onTrim={handleVideoTrim}
                        onFrame={handleVideoFrame}
                        onUpscale={handleVideoUpscale}
                        onMissingConfig={() => openConfigDialog(true)}
                    />
                ) : null}

                {audioToolsNode?.metadata?.content ? (
                    <CanvasNodeAudioToolsDialog
                        open={Boolean(audioToolsNode)}
                        audioUrl={audioToolsNode.metadata.content}
                        canRestore={Boolean(audioToolsNode.metadata.audioHistory?.length)}
                        onClose={() => setAudioToolsNodeId(null)}
                        onTrim={handleAudioTrim}
                        onRestore={handleAudioRestore}
                    />
                ) : null}

                <CanvasNodeAudioMergeDialog
                    open={audioMergeOpen}
                    candidates={audioMergeCandidates}
                    selected={audioMergeSelected}
                    picking={audioMergePicking}
                    onSelectedChange={(next) => {
                        setAudioMergeSelected(next);
                        audioMergeSelectedRef.current = next;
                    }}
                    onPickingChange={(next) => {
                        setAudioMergePicking(next);
                        audioMergePickingRef.current = next;
                    }}
                    onClose={() => {
                        setAudioMergeOpen(false);
                        setAudioMergePicking(false);
                        audioMergePickingRef.current = false;
                    }}
                    onMerge={handleAudioMerge}
                />

                {mjUpscaleNode ? (
                    <CanvasNodeMjUpscaleDialog
                        open={Boolean(mjUpscaleNode)}
                        previewUrl={mjUpscaleNode.metadata?.content}
                        defaultIndex={
                            mjUpscaleNode.metadata?.midjourneyIndex ||
                            mjUpscaleNode.metadata?.images?.find((image) => image.id === mjUpscaleNode.metadata?.primaryImageId)?.midjourneyIndex ||
                            1
                        }
                        onClose={() => setMjUpscaleNodeId(null)}
                        onConfirm={(index) => void midjourneyUpscaleImageNode(mjUpscaleNode, index)}
                    />
                ) : null}

                {scaleNode ? (
                    <CanvasNodeScaleDialog
                        open={Boolean(scaleNode)}
                        naturalWidth={resolveNodeMediaNaturalSize(scaleNode)?.width || scaleNode.metadata?.naturalWidth}
                        naturalHeight={resolveNodeMediaNaturalSize(scaleNode)?.height || scaleNode.metadata?.naturalHeight}
                        bytes={scaleNode.metadata?.bytes}
                        onClose={() => setScaleNodeId(null)}
                        onConfirm={(percent) => {
                            void scaleImageNodeDisplay(scaleNode, percent);
                        }}
                    />
                ) : null}

                {adjustNode?.metadata?.content ? (
                    <CanvasNodeAdjustDialog
                        dataUrl={adjustNode.metadata.content}
                        open={Boolean(adjustNode)}
                        onClose={() => setAdjustNodeId(null)}
                        onConfirm={(params) => void adjustImageNode(adjustNode!, params)}
                    />
                ) : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {panoramaNode?.metadata?.content ? (
                    <CanvasNodePanoramaDialog
                        dataUrl={panoramaNode.metadata.content}
                        open={Boolean(panoramaNode)}
                        onClose={() => setPanoramaNodeId(null)}
                        onCapture={(payload) => void capturePanoramaShot(panoramaNode, payload)}
                    />
                ) : null}

                <CanvasImagePreviewModal
                    open={Boolean(previewContent)}
                    src={previewContent}
                    title={previewNode?.title || t("canvas.projectPage.imageDetails")}
                    projectId={projectId}
                    fileName={
                        previewContent
                            ? `canvas-${previewNode?.type || "image"}-${previewNode?.id || "preview"}.${imageExtension(previewContent)}`
                            : undefined
                    }
                    info={
                        previewNode
                            ? (() => {
                                  const batchImage = previewImageId ? previewNode.metadata?.images?.find((image) => image.id === previewImageId) : null;
                                  return {
                                      title: previewNode.title,
                                      nodeId: previewNode.id,
                                      nodeType: previewNode.type,
                                      naturalWidth: batchImage?.naturalWidth || previewNode.metadata?.naturalWidth,
                                      naturalHeight: batchImage?.naturalHeight || previewNode.metadata?.naturalHeight,
                                      displayWidth: previewNode.width,
                                      displayHeight: previewNode.height,
                                      mimeType: batchImage?.mimeType || previewNode.metadata?.mimeType,
                                      bytes: batchImage?.bytes || previewNode.metadata?.bytes,
                                      model: modelOptionLabel(config, previewNode.metadata?.model || previewNode.metadata?.imageModel || "") || previewNode.metadata?.model || previewNode.metadata?.imageModel,
                                      prompt: previewNode.metadata?.prompt,
                                      status: batchImage?.status || previewNode.metadata?.status,
                                  };
                              })()
                            : null
                    }
                    onNodeContextMenu={(event) => {
                        if (!previewNode) return;
                        setSelectedNodeIds(new Set([previewNode.id]));
                        setSelectedConnectionId(null);
                        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: previewNode.id });
                    }}
                    onClose={() => {
                        setPreviewNodeId(null);
                        setPreviewImageId(null);
                        setContextMenu(null);
                    }}
                />

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
        </main>
    );
}
