import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { saveAs } from "file-saver";
import { Group, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    isMidjourneyModel,
    modelSupportsNativeChatVideo,
    requestEdit,
    requestGeneration,
    requestImageQuestion,
    requestMidjourneyUpscale,
    resolvePublicChatVideoUrl,
    type AiTextContentPart,
    type AiTextMessage,
    type GeneratedImageResult,
} from "@/services/api/image";
import { chatSkillsSystemHint, executeChatSkillTool, resolveChatSkillIds, resolveChatSkillTools } from "@/lib/chat-skills";
import { buildCanvasAgentSystemPrompt, resolveCanvasAgent } from "@/constant/canvas-agents";
import { useCanvasAgentsStore } from "@/stores/use-canvas-agents-store";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, requestVideoUpscale, storeGeneratedVideo, uploadProviderMediaFile } from "@/services/api/video";
import { defaultConfig, encodeChannelModel, modelOptionLabel, resolveModelForCapability, resolveModelRequestConfig, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { parseComfyApiWorkflow, resolveNativeH3VideoSettingDefaults, shouldUseNativeComfyUi } from "@/lib/comfyui-native";
import { cancelNativeVideoQueueJobsForNodes, enqueueNativeComfyVideoJob, getNativeVideoQueueSnapshot, isSerializedNativeVideoBaseUrl, pickNativeVideoQueueEntryForNode, subscribeNativeVideoQueue } from "@/lib/canvas/native-video-job-queue";
import { uploadImage, imageToDataUrl } from "@/services/image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { subscribeLocalMediaLibraryAccess } from "@/services/local-media-library";
import { nanoid } from "nanoid";
import { captureVideoFrameDataUrl, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, mergeDataUrls, resizeDataUrlByPercent, splitDataUrl, upscaleDataUrl, adjustDataUrl, type ImageAdjustParams } from "@/lib/canvas/canvas-image-data";
import { loadVideoBlob, scaleVideoBlob, VIDEO_SCALE_SHORTCUT_PERCENT } from "@/lib/canvas/canvas-video-tools";
import { fitNodeSize, nodeSizeFromRatio, sizeFromDisplayScalePercent } from "@/lib/canvas/canvas-node-size";
import { App, Button, Modal } from "antd";
import { DEFAULT_CANVAS_FONT_SIZE, NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { buildStylePromptText, composeStyledPrompt, getStyleTemplate } from "@/constant/style-templates";
import { buildCameraSelectionPrompt } from "@/constant/camera-options";
import {
    addScriptNameLockForCell,
    applyGhostVideoScriptOverlay,
    applyMashuVideoScriptOverlay,
    applyMomanVideoScriptOverlay,
    applyMuseVideoScriptOverlay,
    backfillStoryScriptCastNames,
    describeMomanSourceOverlay,
    applyStoryScriptTemplateOverlay,
    applyStoryScriptTemplateOverlayToShot,
    blankPreciseAssetColumns,
    buildMergedVideoNodePrompt,
    buildStoryScriptAssetFillTask,
    buildStoryScriptRowTask,
    buildStoryScriptSchemeFormatHint,
    buildStoryScriptTask,
    buildScriptTotalSecondsBlockFromMetadata,
    buildVideoNodePrompt,
    collectStoryScriptAssetFillTargets,
    countStoryScriptTemplateShots,
    dedupeStoryScriptAssetDescriptions,
    getStoryScriptColumns,
    getStoryScriptColumnsWithExtras,
    getStoryScriptPreset,
    groupStoryScriptRows,
    hasScriptGenerationPrompt,
    hasStoryScriptShotTemplate,
    matchScriptRowAssetsByRole,
    mergeStoryScriptAssetFill,
    normalizeStoryScriptDirectorRows,
    normalizeStoryScriptExtraColumns,
    normalizeStoryScriptGhostRows,
    normalizeStoryScriptMashuRows,
    normalizeStoryScriptMergeGroups,
    normalizeStoryScriptMomanRows,
    normalizeStoryScriptMuseRows,
    orderScriptRefIds,
    parseStoryScriptOutput,
    resolveScriptAssetRole,
    resolveScriptSystemPrompt,
    resolveScriptTotalSeconds,
    resolveStoryScriptMergeMode,
    resolveScriptPipelineMergeEvery,
    SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT,
    resolveStoryScriptPresetId,
    resolveStoryScriptImageSize,
    resolveStoryScriptShotSeconds,
    scriptAssetColumnRole,
    scriptCellAssetIds,
    scriptRowAssetIds,
    scriptRowAudioIds,
    scriptShotPreciseAssetRefs,
    setStoryScriptCellAssetIds,
    setStoryScriptNameLock,
    setStoryScriptRowAssetIds,
    setStoryScriptRowAudioIds,
    setStoryScriptRowNote,
    storyScriptGroupDuration,
    storyScriptToMarkdown,
    stripStoryScriptAssetId,
    syncStoryScriptNameLocks,
    type ScriptAssetRole,
    type ScriptRefLinkKind,
} from "@/constant/story-script";
import { asScriptSchemeId, buildScriptSchemeSeed, resolveScriptPromptValues, resolveScriptSchemeId } from "@/constant/script-scheme";
import { buildMochianiNodeConfig, isMochianiVideoEngine, MOCHIANI_VIDEO_ENGINE, resolveMochianiPreference } from "@/constant/mochiani-video";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasH3OptimizeDialog } from "@/components/canvas/canvas-h3-optimize-dialog";
import { CanvasH3OptimizeProgress } from "@/components/canvas/canvas-h3-optimize-progress";
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
import { CanvasVideoMergeNodeContent } from "@/components/canvas/canvas-video-merge-node-content";
import { CanvasJianyingExportDialog } from "@/components/canvas/canvas-jianying-export-dialog";
import { CanvasJianyingConflictDialog } from "@/components/canvas/canvas-jianying-conflict-dialog";
import { CanvasScriptNodeContent, type ScriptAssetCandidate, type ScriptAssetLinkSelection, type ScriptGenAction } from "@/components/canvas/canvas-script-node-content";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { CanvasNodeMjUpscaleDialog } from "@/components/canvas/canvas-node-mj-upscale-dialog";
import { CanvasNodeScaleDialog } from "@/components/canvas/canvas-node-scale-dialog";
import { CanvasNodeAdjustDialog } from "@/components/canvas/canvas-node-adjust-dialog";
import { CanvasNodeVideoToolsDialog, type VideoToolsFrameResult, type VideoToolsScaleResult, type VideoToolsTrimResult, type VideoToolsUpscaleResult } from "@/components/canvas/canvas-node-video-tools-dialog";
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
import { CanvasTextClipboardMenu, blurActiveCanvasTextInput, isCanvasTextInteractionTarget, isCanvasTextPasteTarget } from "@/components/canvas/canvas-text-clipboard-menu";
import { isImeComposing, keyLower } from "@/lib/keyboard-event";
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
import { CanvasMochianiPanel } from "@/components/canvas/canvas-mochiani-panel";
import { CanvasMochianiNodeContent } from "@/components/canvas/canvas-mochiani-node-content";
import { CanvasReverseVideoNodeContent } from "@/components/canvas/canvas-reverse-video-node-content";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { DirectorPanel } from "@/components/canvas/director-panel";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useGenerationHistoryStore, type GenerationHistoryImage } from "@/stores/canvas/use-generation-history-store";
import { buildNodeMentionReferences, resolveCanvasReferenceImages, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { collectCanvasOccupied, findFreeColumnX, planRightwardChainSlots } from "@/lib/canvas/canvas-free-space";
import { widenLegacyScriptNodes } from "@/lib/canvas/script-node-width";
import { withVideoComplianceSuffix } from "@/lib/canvas/video-compliance-suffix";
import { reorderConnectionsForTargets } from "@/lib/canvas/canvas-reference-order";
import { collectH3OptimizeTargets, type H3OptimizeTarget } from "@/lib/canvas/h3-prompt-optimize";
import { VIDEO_REVERSE_REWRITE_PROMPT, buildVideoReversePrompt, cleanVideoReverseScriptOutput, needsChineseRewrite, pickVideoReverseSkill, readReverseVideoTarget, resolveReverseVideoQuality, resolveReverseVideoSize, type VideoReverseMode, type VideoReverseResult } from "@/lib/canvas/video-reverse";
import { listChatSkills } from "@/lib/chat-skills";
import { isH3OptimizeQueueRunning, startH3OptimizeQueue } from "@/lib/canvas/h3-optimize-runner";
import { buildScriptAssetBindingPrompt, buildScriptAssetLockPrompt, withScriptAssetBinding } from "@/lib/canvas/script-asset-binding";
import {
    applyScriptAssetDirectDecorations,
    buildScriptAssetBatchMounts,
    buildScriptAssetDirectItems,
    buildScriptAssetBatchItems,
    collectScriptAssetOccupied,
    describeScriptAssetAspectMismatch,
    matchScriptAssetReferences,
    mountScriptAssetToCells,
    planScriptAssetGrid,
    resolveScriptAssetDirectSize,
    resolveScriptAssetSizeForRole,
    resolveMissingScriptAssetViewTemplates,
    resolveScriptImageQuality,
    scriptAssetLaneRight,
    SCRIPT_ASSET_LAUNCH_BATCH,
    type ScriptAssetBatchItem,
    type ScriptAssetReference,
} from "@/lib/canvas/script-asset-batch";
import { planScriptPipelineGenerateOrder, readScriptPipelineVideoOutcome, resolveScriptPipelineRetryModel, SCRIPT_PIPELINE_GENERATE_INTERVAL_MS } from "@/lib/canvas/script-pipeline-run";
import {
    ONE_CLICK_IMAGE_FALLBACK_CHANNEL_HINTS,
    ONE_CLICK_IMAGE_FALLBACK_MODEL_NAMES,
    ONE_CLICK_IMAGE_STAGE_TIMEOUT_MS,
    ONE_CLICK_POLL_INTERVAL_MS,
    ONE_CLICK_SCRIPT_RETRY_CHANNEL_HINTS,
    ONE_CLICK_SCRIPT_RETRY_MODEL_NAMES,
    ONE_CLICK_STAGE_TIMEOUT_MS,
    pickOneClickModel,
    withDeadline,
    type OneClickVideoRun,
} from "@/lib/canvas/one-click-video";
import { extractPromptFromReply, type ChatSendOptions } from "@/lib/canvas/canvas-chat-helpers";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { buildJianyingBundle, secondsToMicro, type JianyingDraftClip } from "@/lib/canvas/jianying-draft";
import {
    cleanWindowsPathSegment,
    ensureJianyingWritePermission,
    jianyingDraftFolderExists,
    jianyingDraftFolderName,
    joinDraftPath,
    loadJianyingRootPath,
    looksLikeAbsoluteDraftRoot,
    readStoredJianyingRoot,
    resolveJianyingPlaceholders,
    saveJianyingRootPath,
    storeJianyingRoot,
    suggestAvailableDraftFolderName,
    supportsJianyingDirectWrite,
    writeJianyingDraft,
    type JianyingDraftFile,
} from "@/lib/canvas/jianying-direct";
import { createZip } from "@/lib/zip";
import { captureMergeCover, isVideoMergeSourceNode, mediaExtension, mergeClipFileBase, normalizeMergeClip, probeImageSize, probeVideoMeta, resolveMergeCanvasSize, videoMergeClipFromNode, type ResolvedVideoMergeClip } from "@/lib/canvas/video-merge";
import { canRenderMergedVideo, MERGE_RENDER_EMPTY, MERGE_RENDER_UNSUPPORTED, renderMergedVideo, type MergeRenderClip } from "@/lib/canvas/video-merge-render";
import { buildBatchGeneratePlan, isBatchGeneratableNode } from "@/lib/canvas/batch-generate";
import { attachNodesToGroup, collectGroupMembers, isGroupableNode, resolveGroupFrame } from "@/lib/canvas/canvas-grouping";
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
import { clipboardTextSnapshot, extractClipboardRemoteImage, isPasteableNodeFile, mediaFileFromClipboardText, resolveClipboardMediaKind } from "@/lib/canvas/clipboard-paste";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType } from "@/lib/canvas/node-registry";
import { convertNodeType, convertedNodeKeptMedia, nodeConversionTargets } from "@/lib/canvas/node-type-conversion";
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
    type CanvasVideoMergeClip,
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

/**
 * 剪映直写这一份导出的完整内容 —— 素材已经读成 blob，JSON 还是**占位符版**（写盘时才换成绝对路径）。
 * 存在 ref 里是为了「弹窗要用户粘路径 / 授权目录」这段异步交互期间不丢数据。
 */
type JianyingExportPayload = {
    mergeNodeId: string;
    draftName: string;
    /** 草稿文件夹名（稳定，同一个节点重复导出 = 覆盖）。 */
    folderName: string;
    files: JianyingDraftFile[];
    clipCount: number;
    totalSeconds: number;
    skipped: number;
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

/**
 * 浮层（弹窗 / 下拉 / 选择器）里的 mousedown 是否应该放行给浮层自己处理。
 *
 * React 19 的 portal 事件沿**组件树**冒泡，而不是 DOM 树：节点内部渲染的 antd Modal 会被 portal 到
 * `document.body`，DOM 上早已脱离节点，但 React 事件仍然从弹窗内容一路冒到节点外壳的
 * `onMouseDownCapture` / `onMouseDown`。后果是「在弹窗里点一下 / 拖一下」被当成在拖画布节点——
 * 表现为「弹窗里只能移动窗口、输入框点不了」。这里按目标是否落在浮层容器内统一拦掉。
 */
function isOverlayEventTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(".ant-modal, .ant-drawer, .ant-popover, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-tooltip, .canvas-style-picker, .canvas-h3-optimize-progress"));
}

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

/**
 * 剪贴板 html 里内嵌的图片（`<img src="data:image/...">`）。
 *
 * 从 Word / 飞书 / 语雀 / 多数网页编辑器「复制图片」时，剪贴板里**只有 text/html**，
 * 没有 `kind === "file"` 的项——只看 files 的话这类图片永远贴不进来。
 */
function extractClipboardDataImage(html: string): string {
    if (!html) return "";
    const match = html.match(/<img[^>]+src\s*=\s*["'](data:image\/[^"']+)["']/i);
    return match?.[1] || "";
}

/** 富文本 → 纯文本（没有 `text/plain` 时兜底，别把 HTML 源码整段塞进文本节点）。 */
function clipboardHtmlToText(html: string): string {
    if (!html) return "";
    try {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        return parsed.body?.textContent?.trim() || "";
    } catch {
        return "";
    }
}

/** `data:image/...` → File（图片节点要走 `createImageFileNode`，它只收 File）。 */
function dataUrlToClipboardFile(dataUrl: string): File | null {
    if (!/^data:image\//i.test(dataUrl)) return null;
    try {
        const [head, payload] = dataUrl.split(",");
        if (!payload) return null;
        const mime = head.match(/^data:([^;,]+)/i)?.[1] || "image/png";
        const extension = mime.split("/")[1]?.split(";")[0]?.replace(/\+.*$/, "") || "png";
        if (/;base64$/i.test(head)) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return new File([bytes], `clipboard-image.${extension}`, { type: mime });
        }
        return new File([decodeURIComponent(payload)], `clipboard-image.${extension}`, { type: mime });
    } catch {
        return null;
    }
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
    /** 最近一次 Ctrl+C 写进系统剪贴板的那段文字 + 时间，用来区分内部复制和外部内容。 */
    const clipboardFingerprintRef = useRef<{ text: string; at: number } | null>(null);
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
    /**
     * 画布技能库：第六 / 第七 / 第八套方案的分镜提示词正文从这里取（不是词库）。
     * 生成脚本时必须和节点组件用**同一份**实时来源，否则「改了技能内容、生成还是老的」。
     */
    const chatSkillPacks = useChatSkillPacksStore((state) => state.packs);
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
    /** 正在打包剪映工程包的节点 id —— 只用来把按钮换成 loading。 */
    const [videoMergeExportingNodeId, setVideoMergeExportingNodeId] = useState<string | null>(null);
    /**
     * 剪映草稿「直写」：待落盘的这一份导出内容（素材已读成 blob）。
     * 弹窗是异步的（用户要先粘路径、选目录），所以数据先攒在这里，用户确认后继续写。
     */
    const jianyingPendingRef = useRef<JianyingExportPayload | null>(null);
    /** 这次要写到哪儿（目录句柄 + 绝对路径）：重名弹窗里点「覆盖 / 换名」后还要拿它落盘。 */
    const jianyingTargetRef = useRef<{ handle: FileSystemDirectoryHandle; rootPath: string } | null>(null);
    /** 重名弹窗：撞车的文件夹名 + 预填的替代名。非空 = 弹窗打开。 */
    const [jianyingConflict, setJianyingConflict] = useState<{ folderName: string; draftName: string; suggestedName: string } | null>(null);
    /** 弹窗里要显示的那几个数（渲染期读 ref 不响应，单独存一份 state）。 */
    const [jianyingDialogMeta, setJianyingDialogMeta] = useState<{ draftName: string; folderName: string; clipCount: number; totalSeconds: number } | null>(null);
    const [jianyingDialogOpen, setJianyingDialogOpen] = useState(false);
    const [jianyingWriting, setJianyingWriting] = useState(false);
    /** 正在本地渲染合并 mp4 的节点 id + 进度（0–1）。 */
    const [videoMergeRenderingNodeId, setVideoMergeRenderingNodeId] = useState<string | null>(null);
    const [videoMergeRenderProgress, setVideoMergeRenderProgress] = useState(0);
    /** 视频合并节点里用到的素材 id → 可直接播放的 url（blob 失效后由 storageKey 重建）。 */
    const [videoMergeMediaUrls, setVideoMergeMediaUrls] = useState<Record<string, string>>({});
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
    /**
     * True only when the job must wait in the FIFO. The queue belongs to the 公司h3 pod, not to the
     * model: the same model on another channel (RunningHub / Metaso / a different pod) submits
     * right away, and its own submits do not replace each other's target either.
     */
    const isQueuedVideoConfig = useCallback(
        (config: AiConfig) => {
            if (!isNativeComfyVideoConfig(config)) return false;
            const model = config.model || config.videoModel || "";
            return isSerializedNativeVideoBaseUrl(resolveModelRequestConfig(config, model).baseUrl);
        },
        [isNativeComfyVideoConfig],
    );
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

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController(), options?: { replaceTarget?: boolean }) => {
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
    }, []);

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
                    affectedNodeIds.has(node.id) && (node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.images?.some((image) => image.status === NODE_STATUS_LOADING) || node.metadata?.nativeVideoQueuePosition != null)
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: node.metadata?.status === NODE_STATUS_LOADING ? NODE_STATUS_IDLE : node.metadata?.status,
                                  errorDetails: undefined,
                                  nativeVideoQueuePosition: undefined,
                                  nativeVideoQueueTotal: undefined,
                                  nativeVideoQueuePhase: undefined,
                                  images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
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
            // `widenLegacyScriptNodes`：老画布里的脚本节点还停在旧默认宽 760（配置态挤成三行），
            // 一次性加宽到 1520；有下游紧贴右侧时不动，避免盖住铺链路出来的视频节点。
            const restoredNodes = widenLegacyScriptNodes(
                (await hydrateCanvasImages(resetInterruptedGeneration(project.nodes), { mode: "fast" })).map((node) =>
                    node.type === CanvasNodeType.Chat && (node.height === 520 || node.height === 1040 || node.width === 420) ? { ...node, width: 840, height: 1387 } : node.type === CanvasNodeType.Text && node.height === 240 ? { ...node, height: 480 } : node,
                ),
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

    /**
     * 粘贴用的落点。
     *
     * `mouseWorldRef` 由**window 级** mousemove 更新，所以指针停在右侧面板 / 工具栏上时，
     * 它记的是「侧栏那一列对应的世界坐标」——直接在粘贴时用它，节点会落在可视区外面，
     * 用户看到的现象就是「粘贴了但什么都没有」。这里把落点夹回画布可视范围，超出就用视口中心。
     */
    const getPastePosition = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const world = mouseWorldRef.current;
        if (rect && world) {
            const topLeft = screenToCanvas(rect.left, rect.top);
            const bottomRight = screenToCanvas(rect.right, rect.bottom);
            if (world.x >= topLeft.x && world.x <= bottomRight.x && world.y >= topLeft.y && world.y <= bottomRight.y) return world;
        }
        return getCanvasCenter();
    }, [getCanvasCenter, screenToCanvas]);

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
                const emptyGroup = (anchor?.type === CanvasNodeType.Group && getGroupMemberNodes(anchor.id, nodesSnapshot).length === 0) || (target?.type === CanvasNodeType.Group && getGroupMemberNodes(target.id, nodesSnapshot).length === 0);
                message.warning(t(emptyGroup ? "canvas.projectPage.emptyGroupConnection" : "canvas.projectPage.configConnection"));
                return;
            }

            setConnections((prev) => {
                const existing = new Set(prev.map((conn) => `${conn.fromNodeId}->${conn.toNodeId}`));
                const additions = pairs.filter((pair) => !existing.has(`${pair.fromNodeId}->${pair.toNodeId}`)).map((pair) => ({ id: nanoid(), fromNodeId: pair.fromNodeId, toNodeId: pair.toNodeId }));
                return additions.length ? [...prev, ...additions] : prev;
            });

            /**
             * 连线即拾取：把视频 / 图片接进视频合并节点，就直接进它的时间线。
             *
             * 这是「选中合并节点按 X，再逐个点素材节点」那条路的落点 —— 保留 X 的批量拾取手感，
             * 又不用再额外点一次「拾取画布素材」。反向（从时间线移出）在 `deleteConnection` /
             * 节点内「移出时间线」里做，两边对称才不会出现「有线但没段 / 有段但没线」。
             */
            const clipAdds = pairs.flatMap((pair) => {
                const target = nodesSnapshot.find((node) => node.id === pair.toNodeId);
                const source = nodesSnapshot.find((node) => node.id === pair.fromNodeId);
                if (target?.type !== CanvasNodeType.VideoMerge || !source || !isVideoMergeSourceNode(source)) return [];
                return [{ mergeId: target.id, source }];
            });
            if (clipAdds.length) {
                setNodes((prev) =>
                    prev.map((node) => {
                        const adds = clipAdds.filter((item) => item.mergeId === node.id);
                        if (!adds.length) return node;
                        const clips = node.metadata?.videoMergeClips || [];
                        const known = new Set(clips.map((clip) => clip.nodeId));
                        const appended = [...clips];
                        for (const { source } of adds) {
                            if (known.has(source.id)) continue;
                            const created = videoMergeClipFromNode(source);
                            if (!created) continue;
                            known.add(source.id);
                            appended.push(created);
                        }
                        return appended.length === clips.length ? node : { ...node, metadata: { ...node.metadata, videoMergeClips: appended } };
                    }),
                );
            }

            // Annotate âImage: load the first linked image into the annotate node.
            for (const { fromNodeId, toNodeId } of pairs) {
                const fromNode = nodesSnapshot.find((node) => node.id === fromNodeId);
                const toNode = nodesSnapshot.find((node) => node.id === toNodeId);
                const annotateTarget = toNode?.type === CanvasNodeType.Annotate ? toNode : fromNode?.type === CanvasNodeType.Annotate ? fromNode : null;
                const imageSource = annotateTarget ? (annotateTarget.id === toNodeId ? fromNode : toNode) : null;
                const sourceMeta = imageSource?.metadata;
                const canLoadIntoAnnotate = annotateTarget && imageSource && imageSource.id !== annotateTarget.id && (imageSource.type === CanvasNodeType.Image || imageSource.type === CanvasNodeType.Annotate) && Boolean(sourceMeta?.content);
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
                const size = fitNodeSize(naturalWidth || annotateTarget.width, naturalHeight || annotateTarget.height, Math.max(annotateTarget.width, 320), Math.max(annotateTarget.height, 240));
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
    const getConfigInputs = useCallback(
        (nodeId: string) => {
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
        },
        [connections, nodeById, nodes],
    );
    // Lazy, per-node mention references. Building this eagerly for every node is O(N²) over
    // connections and nodes, and the map's reference changing on any node/connection edit
    // invalidates `renderNodePanel` and forces EVERY node to re-render. Compute on demand and
    // cache per node, invalidating only when nodes/connections actually change.
    const mentionCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[]; map: Map<string, ReturnType<typeof buildNodeMentionReferences>> } | null>(null);
    const getMentionReferences = useCallback(
        (nodeId: string) => {
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
        },
        [connections, nodeById, nodes],
    );
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
    /**
     * 反推视频节点：解析「接入的视频」+ 「连进来的参考图」。
     * 连线优先 —— 用户当下看得见的那根线比他 N 天前从列表里挑的记录更可信；
     * 没有连线才回落到 `metadata.reverseVideoSourceId`（手动接入）。两者都失效就是没接入。
     *
     * 参考图（`references`）只认**连线**：02/03 跑一键视频时，名字对上道具的会在分镜表出来后
     * 直接挂成道具资产（`mountReferenceAssetsToScript`），所以这里要把它显示出来，
     * 用户才知道「我连的这张产品图被认到了」。
     */
    type ReverseVideoSource = {
        videoId: string;
        source: "connection" | "manual";
        references: Array<{ id: string; title: string; url: string }>;
    };
    const reverseVideoSourceCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: CanvasConnection[]; map: Map<string, ReverseVideoSource | null> } | null>(null);
    const getReverseVideoSource = useCallback(
        (nodeId: string) => {
            const cache = reverseVideoSourceCacheRef.current;
            if (!cache || cache.nodes !== nodes || cache.connections !== connections) {
                reverseVideoSourceCacheRef.current = { nodes, connections, map: new Map() };
            }
            const current = reverseVideoSourceCacheRef.current!;
            const hit = current.map.get(nodeId);
            if (hit !== undefined) return hit;
            const isUsableVideo = (id: string) => {
                const candidate = nodeById.get(id);
                return candidate?.type === CanvasNodeType.Video && Boolean(candidate.metadata?.content);
            };
            const edge = connections.find((connection) => connection.toNodeId === nodeId && isUsableVideo(connection.fromNodeId));
            const manualId = nodeById.get(nodeId)?.metadata?.reverseVideoSourceId || "";
            // 参考图：连进本节点的图片节点（去重、按连线顺序 = 用户连接顺序）。
            const references: ReverseVideoSource["references"] = [];
            for (const connection of connections) {
                if (connection.toNodeId !== nodeId) continue;
                const candidate = nodeById.get(connection.fromNodeId);
                if (candidate?.type !== CanvasNodeType.Image || !candidate.metadata?.content) continue;
                if (references.some((item) => item.id === candidate.id)) continue;
                references.push({ id: candidate.id, title: candidate.title || "参考图", url: candidate.metadata.content });
            }
            const resolved: ReverseVideoSource | null = edge
                ? { videoId: edge.fromNodeId, source: "connection", references }
                : manualId && isUsableVideo(manualId)
                  ? { videoId: manualId, source: "manual", references }
                  : null;
            current.map.set(nodeId, resolved);
            return resolved;
        },
        [connections, nodeById, nodes],
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
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.useBuiltinPanel
                  ? true
                  : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group && type !== CanvasNodeType.Chat && type !== CanvasNodeType.Merge;
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

    const createBridgeVideoNode = useCallback(
        async (videoUrl: string, prompt?: string, position?: Position, hostNodeId?: string) => {
            const nodeId = createNode(CanvasNodeType.Video, position);
            /**
             * MochiAni 回来的是它自己 CDN 上的临时地址（`tencentcloud.mochiani.com/temporary/…`），
             * 过一阵就失效。先落到本机媒体库（objectURL + storageKey），画布上的节点才是
             * 能导出、能被「视频合并」吃、重启后还在的；下载失败（跨域被拦）才退回远程地址。
             */
            let content = videoUrl;
            let mediaFields: { storageKey?: string; bytes?: number; mimeType?: string; durationMs?: number } = {};
            if (/^https?:\/\//i.test(videoUrl)) {
                try {
                    const media = await uploadMediaFile(videoUrl, "video");
                    content = media.url;
                    mediaFields = {
                        storageKey: media.storageKey,
                        bytes: media.bytes,
                        mimeType: media.mimeType,
                        durationMs: media.durationMs,
                    };
                } catch {
                    // 拿不回来就先用远程地址播，至少能看、能手动另存。
                }
            }
            const patch = {
                content,
                status: NODE_STATUS_SUCCESS,
                ...mediaFields,
                ...(prompt ? { prompt, composerContent: prompt, promptSyncAt: Date.now() } : {}),
            };
            /**
             * MochiAni 节点**自己也留一份媒体引用**（用户 2026-11-10 第 01 条：输出照旧接进视频合并节点）。
             *
             * 为什么不能只靠刚落画布的那个视频节点：脚本链路里的合并节点连的是 **MochiAni 窗口本身**
             * （铺链路时建的），而 MochiAni 的产物以前只落成旁边一个新视频节点、跟那条连线无关 ——
             * 于是合并节点永远「缺素材」。把 media 字段镜像到宿主节点上，时间线就能直接读到这段视频。
             *
             * ⚠️ 只写媒体字段，**不写 `status` / 提示词**：宿主节点的状态与提示词归它自己的面板管，
             * 这两样一改，节点会显示成「成功」而丢掉运行快照。
             */
            const hostPatch = hostNodeId
                ? { content, ...mediaFields }
                : null;
            const applyPatch = (node: CanvasNodeData): CanvasNodeData => {
                if (node.id === nodeId) return { ...node, metadata: { ...node.metadata, ...patch } };
                if (hostPatch && node.id === hostNodeId) return { ...node, metadata: { ...node.metadata, ...hostPatch } };
                return node;
            };
            setNodes((prev) => prev.map(applyPatch));
            nodesRef.current = nodesRef.current.map(applyPatch);
            return nodeId;
        },
        [createNode],
    );

    const createMergeNode = useCallback(
        (position?: Position, sourceImageIds?: string[]) => {
            const mergeId = createNode(CanvasNodeType.Merge, position);
            const sources = sourceImageIds || nodesRef.current.filter((node) => selectedNodeIds.has(node.id) && node.type === CanvasNodeType.Image && node.metadata?.content).map((node) => node.id);
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
                    // 合并节点的时间线跟着连线走：源节点被删 = 线也没了，时间线上那段一起收掉，
                    // 否则会留下一条永远连不回来的「源节点已删除」幽灵行。
                    const clips = node.metadata?.videoMergeClips;
                    const pruned = clips?.some((clip) => allIds.has(clip.nodeId)) ? { ...node, metadata: { ...node.metadata, videoMergeClips: clips.filter((clip) => !allIds.has(clip.nodeId)) } } : node;
                    const groupId = pruned.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...pruned, metadata: { ...pruned.metadata, groupId: undefined } };
                    return pruned;
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
        // 「连线即拾取」的反向：断开连进合并节点的线，等于把那段素材从时间线移出。
        const removed = connectionsRef.current.find((conn) => conn.id === connectionId);
        if (removed) {
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== removed.toNodeId) return node;
                    const clips = node.metadata?.videoMergeClips;
                    if (!clips?.some((clip) => clip.nodeId === removed.fromNodeId)) return node;
                    return { ...node, metadata: { ...node.metadata, videoMergeClips: clips.filter((clip) => clip.nodeId !== removed.fromNodeId) } };
                }),
            );
        }
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    // Reorder the connections feeding a node so its "linked media" thumbnails, mention labels
    // (图1/图2) and the API reference_images order all follow the user's drag order.
    //
    // 两条已经踩过的坑，都表现为「拖了没反应 / 像卡住」：
    // 1. 旧实现要求「命中条数 === 新顺序条数」，chip 里只要少一条（上游图还没出结果、素材被停用）
    //    就直接 `return prev`，静默失效。现在命中几条就排几条，认不得的原封不动。
    // 2. 参考图可能不是直连本节点，而是挂在**本节点所接的 Config 汇流点**上（`getMentionResourceNodes`
    //    在直连为空时会回落到 hub）。只认直连时 `incoming.length` 恒为 0，同样静默失效。
    const handleReorderLinkedMedia = useCallback((nodeId: string, orderedNodeIds: string[]) => {
        setConnections((prev) => {
            const hubIds = prev.filter((conn) => conn.fromNodeId === nodeId && nodesRef.current.some((node) => node.id === conn.toNodeId && node.type === CanvasNodeType.Config)).map((conn) => conn.toNodeId);
            return reorderConnectionsForTargets(prev, [nodeId, ...new Set(hubIds)], orderedNodeIds) ?? prev;
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
            if (!node || !nodeConversionTargets(node.type).includes(targetType)) return;
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
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) || selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };

        // 同步把「这段剪贴板是画布自己的」这个事实写进系统剪贴板：粘贴时用它区分内部复制与外部内容。
        // 失败（iframe / 未授权）不影响内部 Ctrl+V —— `clipboardFingerprintRef.at` 还有一段宽限窗口。
        const snapshot = clipboardTextSnapshot(copiedNodes);
        clipboardFingerprintRef.current = { text: snapshot, at: Date.now() };
        void navigator.clipboard?.writeText(snapshot).catch(() => {
            // 写入失败时不清空指纹：宽限窗口内的粘贴仍按内部复制处理。
        });
    }, []);

    const copyNodeImageToClipboard = useCallback(
        async (nodeId: string) => {
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
        },
        [message, t],
    );

    /**
     * C: 复制创建选中节点的内容。
     *
     * - 图 / 视频 / 音频（已出片）：新建一个**只带素材内容**的同类节点（旧行为，保持）；
     * - 其余所有类型（文本 / 脚本 / 配置 / 合并 / 对话 / 分组 / 标注…）：整节点克隆。文本带正文、
     *   脚本带整张分镜表、配置带模型与提示词；分组会把组内子节点一起复制并重挂 groupId。
     */
    const duplicateSelectedMediaAsNode = useCallback(() => {
        if (selectedNodeIdsRef.current.size !== 1) {
            message.warning(t("canvas.shortcut.copyNodeNeedSelect"));
            return;
        }
        const nodeId = Array.from(selectedNodeIdsRef.current)[0];
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node) return;

        // 只有「纯素材」三类走快捷复制：只有它们的内容能完整塞进一个新节点。
        // 标注（Annotate）虽然也带图，但笔画存在别的字段里，走素材分支会把标注丢干净 → 归到整节点克隆。
        const isMediaType = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
        // 非媒体节点（以及还没生成内容的媒体节点）：整节点克隆 —— 任何类型都能复制出一份。
        if (!isMediaType || !node.metadata?.content) {
            const stamp = Date.now();
            const members = node.type === CanvasNodeType.Group ? nodesRef.current.filter((item) => item.id === node.id || item.metadata?.groupId === node.id) : [node];
            const idMap = new Map<string, string>();
            const clones = members.map((item, index) => {
                const id = `${item.type}-${stamp}-${index}-${Math.random().toString(36).slice(2, 7)}`;
                idMap.set(item.id, id);
                return {
                    ...item,
                    id,
                    title: item.title.endsWith(" Copy") ? item.title : `${item.title} Copy`,
                    position: { ...item.position },
                    // 深拷贝：脚本节点的 rows / 图位表都是嵌套对象，浅拷贝会让副本和原件共用同一份数据。
                    metadata: item.metadata ? (JSON.parse(JSON.stringify(item.metadata)) as CanvasNodeData["metadata"]) : undefined,
                };
            });
            const dx = node.width + 48;
            const placed = clones.map((item) => {
                const groupId = item.metadata?.groupId;
                const remapped = groupId ? idMap.get(groupId) : undefined;
                return {
                    ...item,
                    position: { x: item.position.x + dx, y: item.position.y },
                    metadata: remapped ? { ...item.metadata, groupId: remapped } : item.metadata,
                };
            });
            setNodes((prev) => [...prev, ...placed]);
            nodesRef.current = [...nodesRef.current, ...placed];
            setSelectedNodeIds(new Set(placed.map((item) => item.id)));
            setSelectedConnectionId(null);
            message.success(t("canvas.shortcut.copyImageNodeDone"));
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
        nodesRef.current = [...nodesRef.current, copy];
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
            (connection) => (remappedIds.has(connection.fromNodeId) || existingIds.has(connection.fromNodeId)) && (remappedIds.has(connection.toNodeId) || existingIds.has(connection.toNodeId)),
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

    /**
     * 时间线的「已解析视图」：clip 只是元数据，真要显示 / 导出还得回头找源节点的 URL。
     *
     * URL 优先取 `metadata.content`（视频节点本来就靠它渲染）；被导出 / 草稿往返洗掉 blob URL 的
     * 节点只剩 `storageKey`，那条路要走异步 `resolveMediaUrl`，结果缓存在 `videoMergeMediaUrls` 里
     * —— 别在 render 里 await。
     */
    const videoMergeResolvedByNodeId = useMemo(() => {
        const map = new Map<string, ResolvedVideoMergeClip[]>();
        for (const node of nodes) {
            if (node.type !== CanvasNodeType.VideoMerge) continue;
            const clips = node.metadata?.videoMergeClips || [];
            map.set(
                node.id,
                clips.map((clip) => {
                    const source = nodeById.get(clip.nodeId);
                    const url = String(source?.metadata?.content || "") || videoMergeMediaUrls[clip.nodeId] || "";
                    return {
                        clip,
                        url,
                        storageKey: source?.metadata?.storageKey,
                        // 节点尺寸是缩放后的显示尺寸，但视频/图片节点保持比例，拿它定画幅够用。
                        width: source?.width,
                        height: source?.height,
                        missing: !source || !isVideoMergeSourceNode(source) || (!url && !source.metadata?.storageKey),
                    };
                }),
            );
        }
        return map;
    }, [nodeById, nodes, videoMergeMediaUrls]);

    // 只补「有 storageKey 但没有 URL」那部分；同一个 key 试过一次就不再试，避免拖节点时刷屏。
    const videoMergeUrlAttemptsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const pending: { nodeId: string; storageKey: string }[] = [];
        for (const node of nodes) {
            if (node.type !== CanvasNodeType.VideoMerge) continue;
            for (const clip of node.metadata?.videoMergeClips || []) {
                const source = nodeById.get(clip.nodeId);
                const storageKey = source?.metadata?.storageKey;
                if (!storageKey || source?.metadata?.content) continue;
                const attemptKey = `${clip.nodeId}:${storageKey}`;
                if (videoMergeUrlAttemptsRef.current.has(attemptKey)) continue;
                videoMergeUrlAttemptsRef.current.add(attemptKey);
                pending.push({ nodeId: clip.nodeId, storageKey });
            }
        }
        if (!pending.length) return;
        let cancelled = false;
        void Promise.all(pending.map(async (item) => ({ nodeId: item.nodeId, url: await resolveMediaUrl(item.storageKey, "") }))).then((results) => {
            if (cancelled) return;
            const usable = results.filter((item) => item.url);
            if (!usable.length) return;
            setVideoMergeMediaUrls((prev) => {
                const next = { ...prev };
                for (const item of usable) next[item.nodeId] = item.url;
                return next;
            });
        });
        return () => {
            cancelled = true;
        };
    }, [nodeById, nodes]);

    /**
     * 时间线 → 连线 的反向收口（节点内「移出时间线 / 清空时间线」用）。
     *
     * 时间线是显式列表、连线是它的镜像：节点里删了段，对应的线也得断，
     * 否则会留下「线还连着、段没了」的半截状态 —— 再想加回来还得先手动断线。
     */
    const handleDetachVideoMergeClips = useCallback((mergeNodeId: string, sourceNodeIds: string[]) => {
        if (!sourceNodeIds.length) return;
        const dropped = new Set(sourceNodeIds);
        setConnections((prev) => prev.filter((conn) => !(conn.toNodeId === mergeNodeId && dropped.has(conn.fromNodeId))));
    }, []);

    /**
     * 把攒好的剪映导出内容打成 zip 下载。
     *
     * 这是**兜底**那条路：浏览器不支持目录授权（Firefox / Safari）、或用户在配置弹窗里
     * 主动点「还是下载压缩包」。包内仍带 install.bat，双击即可装入剪映。
     */
    const packageJianyingPayload = useCallback(
        async (payload: JianyingExportPayload) => {
            const zip = await createZip(payload.files.map((file) => ({ name: file.name, data: file.data as BlobPart })));
            const safeName = payload.draftName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "jianying-draft";
            saveAs(zip, `${safeName}_剪映草稿.zip`);
            message.success(t("canvas.videoMerge.exportSuccess"));
        },
        [message, t],
    );

    /**
     * 直写剪映草稿目录：占位符换成绝对路径 → 清掉同名旧草稿 → 逐文件落盘。
     *
     * 落盘前把 `install.bat` / `README.txt` 剔掉 —— 那两个文件只服务「下载 zip 再双击」那条路，
     * 写进草稿目录只是脏东西（剪映不读，但用户点开文件夹会困惑）。
     */
    const writeJianyingPayload = useCallback(
        async (payload: JianyingExportPayload, target: { handle: FileSystemDirectoryHandle; rootPath: string }) => {
            const draftDir = joinDraftPath(target.rootPath, payload.folderName);
            const hide = message.loading(t("canvas.videoMerge.exportWriting"), 0);
            setJianyingWriting(true);
            try {
                // 授权句柄与路径一起记住：下次导出就不用再问（路径是给 JSON 用的，句柄是给写盘用的）
                saveJianyingRootPath(target.rootPath);
                await storeJianyingRoot(target.handle);
                const files = payload.files
                    .filter((file) => file.name !== "install.bat" && file.name !== "README.txt")
                    .map((file) => (file.name.endsWith(".json") && typeof file.data === "string" ? { name: file.name, data: resolveJianyingPlaceholders(file.data, draftDir, target.rootPath) } : file));
                await writeJianyingDraft(target.handle, payload.folderName, files);
                jianyingPendingRef.current = null;
                jianyingTargetRef.current = null;
                setJianyingConflict(null);
                setJianyingDialogMeta(null);
                setJianyingDialogOpen(false);
                hide();
                message.success(t("canvas.videoMerge.exportDirectSuccess", { folder: payload.folderName }));
            } catch (error) {
                hide();
                message.error(t("canvas.videoMerge.exportDirectFailed", { message: error instanceof Error ? error.message : String(error) }));
            } finally {
                setJianyingWriting(false);
            }
        },
        [message, t],
    );

    /**
     * 直写之前的**重名闸门**：先探一下草稿目录里是不是已经有同名文件夹。
     *
     *  - 没有 → 直接写（常见路径：当天第一次导出，或换了一天）。
     *  - 有 → 弹重名框，让用户选「覆盖」还是「换个名字」；两个按钮的回调见下面两个 handler。
     *
     * 为什么不在 `writeJianyingPayload` 里做：那个函数是「确定要写了」之后的事，
     * 而这里要在写之前把选择权交给用户（覆盖会丢用户在剪映里手改的内容）。
     */
    const startJianyingDirectWrite = useCallback(
        async (payload: JianyingExportPayload, target: { handle: FileSystemDirectoryHandle; rootPath: string }) => {
            jianyingTargetRef.current = target;
            const exists = await jianyingDraftFolderExists(target.handle, payload.folderName);
            if (!exists) {
                await writeJianyingPayload(payload, target);
                return;
            }
            // 预填一个没被占用的替代名，用户想换名时基本点一下就完事。
            const suggestedName = await suggestAvailableDraftFolderName(target.handle, payload.folderName);
            setJianyingDialogOpen(false);
            setJianyingConflict({ folderName: payload.folderName, draftName: payload.draftName, suggestedName });
        },
        [writeJianyingPayload],
    );

    /** 重名框里选「覆盖」：沿用原文件夹名，`writeJianyingDraft` 会先递归删掉再重建。 */
    const handleJianyingConflictOverwrite = useCallback(() => {
        const payload = jianyingPendingRef.current;
        const target = jianyingTargetRef.current;
        // 框先不关：写盘期间它继续显示 loading，成功后由 `writeJianyingPayload` 收掉。
        if (payload && target) void writeJianyingPayload(payload, target);
    }, [writeJianyingPayload]);

    /**
     * 重名框里选「换名」：再校验一次（用户可能手打了一个同样被占用的名字），
     * 通过才改 `payload.folderName` 落盘。返回 `null` 表示已开始写，返回字符串是给框里显示的错误。
     */
    const handleJianyingConflictRename = useCallback(
        async (nextName: string) => {
            const payload = jianyingPendingRef.current;
            const target = jianyingTargetRef.current;
            if (!payload || !target) return t("canvas.videoMerge.exportFailed");
            const cleaned = cleanWindowsPathSegment(nextName).slice(0, 40);
            if (!cleaned) return t("canvas.videoMerge.exportNameRequired");
            if (await jianyingDraftFolderExists(target.handle, cleaned)) return t("canvas.videoMerge.exportNameTaken", { name: cleaned });
            payload.folderName = cleaned;
            await writeJianyingPayload(payload, target);
            return null;
        },
        [t, writeJianyingPayload],
    );

    /**
     * 一键导出剪映草稿包。
     *
     * 产物是一个 zip：`draft_content.json` + `draft_meta_info.json` + `materials/` + `install.bat`。
     * 浏览器拿不到用户磁盘的绝对路径，所以 JSON 里先写 `__DRAFT_DIR__` 占位符，由 `install.bat`
     * 在本机替换成真实路径再交给剪映。素材原样打包、**不重新编码** —— 裁剪只写进 in/out 区间。
     */
    const handleVideoMergeExport = useCallback(
        async (mergeNodeId: string) => {
            const mergeNode = nodesRef.current.find((node) => node.id === mergeNodeId);
            const clips = mergeNode?.metadata?.videoMergeClips || [];
            if (!mergeNode || !clips.length) {
                message.warning(t("canvas.videoMerge.exportEmpty"));
                return;
            }
            setVideoMergeExportingNodeId(mergeNodeId);
            const hide = message.loading(t("canvas.videoMerge.exporting"), 0);
            const createdUrls: string[] = [];
            try {
                const sources = new Map(nodesRef.current.map((node) => [node.id, node]));
                const files: JianyingDraftFile[] = [];
                const draftClips: JianyingDraftClip[] = [];
                const clipSizes: { width?: number; height?: number }[] = [];
                let skipped = 0;
                let coverBlob: Blob | null = null;
                let coverAttempts = 0;

                for (let index = 0; index < clips.length; index += 1) {
                    const clip = clips[index];
                    const source = sources.get(clip.nodeId);
                    if (!source || !isVideoMergeSourceNode(source)) {
                        skipped += 1;
                        continue;
                    }
                    const storageKey = source.metadata?.storageKey;
                    const url = String(source.metadata?.content || "") || (storageKey ? await resolveMediaUrl(storageKey, "") : "");
                    const stored = storageKey ? await getMediaBlob(storageKey) : null;
                    const blob =
                        stored ??
                        (url
                            ? await fetch(url)
                                  .then((response) => response.blob())
                                  .catch(() => null)
                            : null);
                    if (!blob) {
                        skipped += 1;
                        continue;
                    }
                    // 探测（时长 / 像素尺寸 / 封面）都要一个能播放的地址；没有就给 blob 临时开一个。
                    const probeUrl = url || URL.createObjectURL(blob);
                    if (probeUrl !== url) createdUrls.push(probeUrl);
                    if (!coverBlob && coverAttempts < 2) {
                        coverAttempts += 1;
                        coverBlob = await captureMergeCover(probeUrl, clip.kind);
                    }

                    let sourceDurationSec = 0;
                    let width = Math.max(2, Math.round(Number(source.width) || 1920));
                    let height = Math.max(2, Math.round(Number(source.height) || 1080));
                    if (clip.kind === "video") {
                        const meta = await probeVideoMeta(probeUrl);
                        sourceDurationSec = meta.durationSec || Number(clip.durationSec) || 0;
                        if (meta.width > 0 && meta.height > 0) {
                            width = meta.width;
                            height = meta.height;
                        }
                    } else {
                        const size = await probeImageSize(blob, { width, height });
                        width = size.width;
                        height = size.height;
                    }

                    const trimmed = normalizeMergeClip({ ...clip, durationSec: sourceDurationSec || clip.durationSec });
                    const inUs = secondsToMicro(trimmed.inSec);
                    const outUs = secondsToMicro(trimmed.outSec);
                    if (outUs - inUs < 1000) {
                        skipped += 1;
                        continue;
                    }
                    // 标题以源节点为准：拾取时抄的那份可能已经过时（用户改过节点名）。
                    const fileName = `${mergeClipFileBase(source.title || clip.title, index, clip.kind)}.${mediaExtension(blob.type, clip.kind)}`;
                    files.push({ name: `materials/${fileName}`, data: blob });
                    draftClips.push({
                        fileName,
                        kind: clip.kind,
                        // 图片的「源时长」就是它在时间线上占的长度；视频必须给全片长度，否则剪映会截断。
                        sourceDurationUs: clip.kind === "video" ? secondsToMicro(sourceDurationSec || trimmed.outSec) : outUs - inUs,
                        inUs,
                        outUs,
                        width,
                        height,
                        hasAudio: clip.kind === "video",
                    });
                    clipSizes.push({ width, height });
                }

                if (!draftClips.length) {
                    message.error(t("canvas.videoMerge.exportEmpty"));
                    return;
                }

                const draftName = String(mergeNode.title || t("canvas.nodeTypes.videoMerge")).trim() || "canvas-draft";
                const canvasSize = resolveMergeCanvasSize(mergeNode.metadata?.videoMergeAspect, clipSizes);
                const bundle = buildJianyingBundle({
                    name: draftName,
                    canvasWidth: canvasSize.width,
                    canvasHeight: canvasSize.height,
                    clips: draftClips,
                    coverFileName: coverBlob ? "draft_cover.jpg" : undefined,
                });
                if (coverBlob) files.push({ name: "draft_cover.jpg", data: coverBlob });
                files.push({ name: "draft_content.json", data: JSON.stringify(bundle.draftContent, null, 2) });
                files.push({ name: "draft_meta_info.json", data: JSON.stringify(bundle.draftMetaInfo, null, 2) });
                // install.bat 必须是纯 ASCII：UTF-8 BOM / 中文在不带 BOM 的 cmd 里会乱码成语法错误。
                files.push({ name: "install.bat", data: bundle.installScript });
                files.push({ name: "README.txt", data: `\ufeff${bundle.readme}` });

                // 草稿文件夹名 = 节点名 + 日期（`约会_1107`）：同一天重复导出是覆盖，换一天是新草稿。
                const folderName = jianyingDraftFolderName(draftName);
                // 攒成一份 payload：直写与「下载压缩包」都要它（弹窗要用户粘路径 / 授权时先放 ref 里）。
                const payload: JianyingExportPayload = {
                    mergeNodeId,
                    draftName,
                    folderName,
                    files,
                    clipCount: draftClips.length,
                    totalSeconds: bundle.totalSeconds,
                    skipped,
                };
                jianyingPendingRef.current = payload;
                hide();
                if (skipped > 0) message.warning(t("canvas.videoMerge.exportMissing", { count: skipped }));
                // ① 浏览器不支持目录授权（Firefox / Safari）→ 直接退回压缩包，并说明原因
                if (!supportsJianyingDirectWrite()) {
                    message.info(t("canvas.videoMerge.exportUnsupported"));
                    await packageJianyingPayload(payload);
                    return;
                }
                // ② 已经配置过「草稿路径 + 目录授权」→ 一键直写，不再弹窗。
                // ⚠️ 这里先 `queryPermission`（不弹系统框）再决定写不写：授权还在就直接写；
                // 授权过期才弹配置框，让用户在**新手势**里重新选目录（requestPermission 需要用户手势）。
                const storedHandle = await readStoredJianyingRoot();
                const storedPath = loadJianyingRootPath();
                if (storedHandle && looksLikeAbsoluteDraftRoot(storedPath)) {
                    const granted = await ensureJianyingWritePermission(storedHandle);
                    if (granted) {
                        await startJianyingDirectWrite(payload, { handle: storedHandle, rootPath: storedPath.trim().replace(/[\\/]+$/, "") });
                        return;
                    }
                }
                // ③ 首次 / 授权失效 → 弹窗里粘一次草稿路径、选一次草稿文件夹
                setJianyingDialogMeta({ draftName, folderName, clipCount: draftClips.length, totalSeconds: bundle.totalSeconds });
                setJianyingDialogOpen(true);
            } catch (error) {
                hide();
                message.error(error instanceof Error ? error.message : t("canvas.videoMerge.exportFailed"));
            } finally {
                for (const url of createdUrls) URL.revokeObjectURL(url);
                setVideoMergeExportingNodeId((current) => (current === mergeNodeId ? null : current));
            }
        },
        [message, packageJianyingPayload, startJianyingDirectWrite, t],
    );

    /**
     * 视频合并 → 真渲染成一条 mp4，并落成画布上的新视频节点。
     *
     * 与「导出到剪映」是**两条不同的路**：导出只写 in/out 元数据、不重编码（剪映自己解）；
     * 这条要能在画布里直接播放、被别的节点引用，所以必须真编码一次（H.264 + AAC）。
     * 素材取法与导出一致：`storageKey` 优先（blob URL 刷新即失效），退回节点上的 `content`。
     */
    const handleVideoMergeRender = useCallback(
        async (mergeNodeId: string) => {
            const mergeNode = nodesRef.current.find((node) => node.id === mergeNodeId);
            const clips = mergeNode?.metadata?.videoMergeClips || [];
            if (!mergeNode || !clips.length) {
                message.warning(t("canvas.videoMerge.renderEmpty"));
                return;
            }
            if (!canRenderMergedVideo()) {
                message.error(t("canvas.videoMerge.renderUnsupported"));
                return;
            }
            setVideoMergeRenderingNodeId(mergeNodeId);
            setVideoMergeRenderProgress(0);
            const hide = message.loading(t("canvas.videoMerge.rendering"), 0);
            const createdUrls: string[] = [];
            try {
                const sources = new Map(nodesRef.current.map((node) => [node.id, node]));
                const renderClips: MergeRenderClip[] = [];
                const clipSizes: { width?: number; height?: number }[] = [];
                let skipped = 0;

                for (const clip of clips) {
                    const source = sources.get(clip.nodeId);
                    if (!source || !isVideoMergeSourceNode(source)) {
                        skipped += 1;
                        continue;
                    }
                    const storageKey = source.metadata?.storageKey;
                    const url = String(source.metadata?.content || "") || (storageKey ? await resolveMediaUrl(storageKey, "") : "");
                    const stored = storageKey ? await getMediaBlob(storageKey) : null;
                    const blob =
                        stored ??
                        (url
                            ? await fetch(url)
                                  .then((response) => response.blob())
                                  .catch(() => null)
                            : null);
                    if (!blob) {
                        skipped += 1;
                        continue;
                    }
                    // 画布尺寸要真实像素：original 画幅跟随第一段，所以顺手探一次。
                    if (clip.kind === "video") {
                        const probeUrl = url || URL.createObjectURL(blob);
                        if (probeUrl !== url) createdUrls.push(probeUrl);
                        const meta = await probeVideoMeta(probeUrl);
                        clipSizes.push({ width: meta.width || source.width, height: meta.height || source.height });
                    } else {
                        const size = await probeImageSize(blob, { width: source.width, height: source.height });
                        clipSizes.push(size);
                    }
                    renderClips.push({ kind: clip.kind, blob, inSec: clip.inSec, outSec: clip.outSec, title: source.title || clip.title });
                }

                if (!renderClips.length) {
                    // 提前 return 也要把 loading 关掉，否则「渲染中」会一直挂在屏幕上。
                    hide();
                    message.error(t("canvas.videoMerge.renderEmpty"));
                    return;
                }

                const canvasSize = resolveMergeCanvasSize(mergeNode.metadata?.videoMergeAspect, clipSizes);
                const rendered = await renderMergedVideo({
                    clips: renderClips,
                    width: canvasSize.width,
                    height: canvasSize.height,
                    onProgress: (value) => setVideoMergeRenderProgress(value),
                });
                const video = await storeGeneratedVideo({ blob: rendered.blob });
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const size = fitNodeSize(video.width || rendered.width, video.height || rendered.height, spec.width, spec.height);
                const childId = nanoid();
                const title = `${mergeNode.title || t("canvas.nodeTypes.videoMerge")} ${t("canvas.videoMerge.mergedSuffix")}`;
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Video,
                    title,
                    // 放合并节点正下方：它右边一般已经排满被拾取的素材节点。
                    position: { x: mergeNode.position.x, y: mergeNode.position.y + mergeNode.height + 96 },
                    width: size.width,
                    height: size.height,
                    metadata: { ...videoMetadata(video), videoMergeFrom: mergeNodeId },
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: mergeNodeId, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                hide();
                if (skipped > 0) message.warning(t("canvas.videoMerge.exportMissing", { count: skipped }));
                message.success(t("canvas.videoMerge.renderSuccess"));
            } catch (error) {
                hide();
                const code = error instanceof Error ? error.message : "";
                if (code === MERGE_RENDER_UNSUPPORTED) message.error(t("canvas.videoMerge.renderUnsupported"));
                else if (code === MERGE_RENDER_EMPTY) message.error(t("canvas.videoMerge.renderEmpty"));
                else message.error(error instanceof Error ? error.message : t("canvas.videoMerge.renderFailed"));
            } finally {
                for (const url of createdUrls) URL.revokeObjectURL(url);
                setVideoMergeRenderingNodeId((current) => (current === mergeNodeId ? null : current));
                setVideoMergeRenderProgress(0);
            }
        },
        [t],
    );

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
            // 弹窗 / 浮层内的按下不参与画布选中，也不该抢走浮层里输入框的焦点。
            if (isOverlayEventTarget(event.target)) return;
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
            // 视频合并不再有「拾取模式」：素材靠连线进来（选中合并节点按 X，再点素材节点）。
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

    const handleNodeMouseDown = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            event.stopPropagation();
            // 弹窗 / 浮层内的按下不能开始拖节点：portal 事件沿组件树冒泡，弹窗挂在节点子树里时会误触。
            if (isOverlayEventTarget(event.target)) return;
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
        },
        [selectNodeByEvent],
    );

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
        (file: File, position: Position = getPastePosition()) => {
            if (!file.type.startsWith("image/")) return false;
            // 以前是 `void createImageFileNode(...)` + 立刻弹「已添加」：解码 / 落库一失败，
            // 用户只看到成功提示、画布上什么也没有 —— 这就是「粘贴不上」最迷惑的一种。
            void (async () => {
                try {
                    await createImageFileNode(file, position);
                    message.success(t("canvas.projectPage.clipboardImageAdded"));
                } catch (error) {
                    console.error("[canvas] clipboard image failed", error);
                    message.error(t("canvas.projectPage.clipboardImageFailed"));
                }
            })();
            return true;
        },
        [createImageFileNode, getPastePosition, message, t],
    );

    /**
     * 一批文件 → 节点（按类型分流：文档 / 音频 / 视频 / 图片），拖拽与粘贴共用。
     * 多个文件按 40px 阶梯错开，避免精确叠在同一处。
     */
    const createNodesFromFiles = useCallback(
        (files: File[], basePosition: Position) => {
            const STAGGER = 40;
            files.forEach((file, index) => {
                const position = { x: basePosition.x + index * STAGGER, y: basePosition.y + index * STAGGER };
                const kind = resolveClipboardMediaKind(file);
                if (kind === "document") void createDocumentTextNode(file, position);
                else if (kind === "audio") void createAudioFileNode(file, position);
                else if (kind === "video") void createVideoFileNode(file, position);
                else
                    void createImageFileNode(file, position).catch((error) => {
                        console.error("[canvas] file node failed", error);
                        message.error(t("canvas.projectPage.clipboardImageFailed"));
                    });
            });
        },
        [createAudioFileNode, createDocumentTextNode, createImageFileNode, createVideoFileNode, message, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard?.read) return;
        try {
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
        } catch (error) {
            // `clipboard.read()` 在 Firefox 没实现、在 iframe / 未授权时抛 NotAllowedError。
            // 这里只当兜底，失败不该静默：至少让用户知道该用 Ctrl+V 或拖拽。
            console.warn("[canvas] async clipboard read failed", error);
            message.warning(t("canvas.projectPage.clipboardReadBlocked"));
        }
    }, [createTextNodeFromClipboard, message, pasteClipboardImageFile, t]);

    /**
     * 剪贴板 html 里只有远程图地址时，把图抓回来落成图片节点。
     *
     * 走 `imageToDataUrl`（内部已有代理兜底），比 `fetch` 直连更能过掉没给 CORS 的站点；
     * 抓不下来就明确报错，别让用户对着空白画布猜。
     */
    const pasteRemoteImage = useCallback(
        async (url: string, position: Position = getPastePosition()) => {
            try {
                const dataUrl = await imageToDataUrl({ url });
                const file = dataUrlToClipboardFile(dataUrl);
                if (!file) throw new Error(t("canvas.projectPage.clipboardImageFailed"));
                await createImageFileNode(file, position);
                message.success(t("canvas.projectPage.clipboardImageAdded"));
            } catch (error) {
                console.warn("[canvas] clipboard remote image failed", url, error);
                message.error(t("canvas.projectPage.clipboardImageFailed"));
            }
        },
        [createImageFileNode, getPastePosition, message, t],
    );

    const resetSelectedNodesToOriginalSize = useCallback(
        (explicitIds?: Iterable<string>) => {
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
        },
        [message, t],
    );

    // Backquote shortcut: put the selected node window(s) back to the size they were created
    // with. Media nodes are filled into a per-type default box the moment their content
    // arrives — every generation path funnels through fitNodeSize(natural, NODE_DEFAULT_SIZE
    // ...) — so restoring "the initial size" means restoring that very same box. The 640×640
    // "100% display" box used by the media scale menu is deliberately NOT reused here: it makes
    // an image window jump to a size the user never saw (that is what the "." shortcut and the
    // image toolbar "original size" action do). Every non-media node falls back to its registry
    // default size. Windows keep their centre and the free-resize lock is restored.
    const resetSelectedNodesWindowSize = useCallback(
        (explicitIds?: Iterable<string>) => {
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
        },
        [message, t],
    );

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

            const key = keyLower(event);
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
                // **绝不在这里 `preventDefault()`**：一旦拦掉，原生 paste 事件就不触发，只剩
                // `navigator.clipboard.read()` 一条路（Firefox 没实现、iframe / 未授权直接
                // NotAllowedError），外部图片和文字就「总粘贴不上」。
                // 内部节点粘贴现在由 window paste 监听按「剪贴板指纹」判断（见 copySelectedNodes
                // 写指纹 + handlePaste 第 2 步），所以这里只让位、什么都不做。
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

            // V = 反推视频节点。Ctrl/Cmd+V 是粘贴，上面已提前 return，不会冲突。
            // 注意：视频合并节点的「往时间线加素材」已让位给 B（见下方），V 不再兼职。
            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "v") {
                event.preventDefault();
                createNode(CanvasNodeType.ReverseVideo);
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

            /**
             * 起一条 sticky 连线：选中的节点当锚点，之后连点其他节点即可逐个接上。
             * X（通用连线）与 B（视频合并拾取）共用这一份，别各写一遍 —— 两处的锚点方向
             * （分组按 source、其余按 target）必须完全一致，复制一份迟早走偏。
             */
            const beginPickConnect = () => {
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
                // Sticky: selected node stays the receiver; click many providers until the key/Esc again.
                // 脚本节点**不走特例**：选中脚本节点后逐个点其他节点，即可把它们连进脚本节点 ——
                // 连进来的素材就成了「整表资产池」，这正是「拾取节点加入资产池」。
                // 想用弹窗添加资产，请点节点里的「+ 添加资产」按钮（节点内容区的 assetEntryRow）。
                //
                // ⚠️ 分组是唯一例外：它是**一捆素材**，键打在组上时用户想的是「把这组接到我刚点的节点」，
                // 所以按 source 起线（组 → 点到的节点），展开后就是 每个成员 → 目标。
                // 想反过来（把某个源推给组里每个成员），拖手柄连组即可，不用快捷键。
                const anchorHandleType = outputNode.type === CanvasNodeType.Group ? "source" : "target";
                setMouseWorld({ x: anchorHandleType === "source" ? outputNode.position.x + outputNode.width : outputNode.position.x, y: outputNode.position.y + outputNode.height / 2 });
                setConnecting({ nodeId: outputNodeId, handleType: anchorHandleType, sticky: true });
                setSelectedNodeIds(new Set([outputNodeId]));
                setToolbarNodeId(outputNodeId);
                setSelectedConnectionId(null);
                setPendingConnectionCreate(null);
                message.info(t("canvas.shortcut.connectHint"));
            };

            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "x") {
                event.preventDefault();
                if (connectingParamsRef.current) {
                    setConnecting(null);
                    setPendingConnectionCreate(null);
                    message.info(t("canvas.shortcut.connectCanceled"));
                    return;
                }
                beginPickConnect();
                return;
            }

            // B = 「往时间线里加素材」的专属键：只对**选中的单个视频合并节点**生效，
            // 其他情况一律让位（连 preventDefault 都不做），免得占掉别处的 B。
            // 方向与 X 一致（合并节点是 target，点到的素材是 source），所以复用同一份起线动作。
            // （V 已改为「新建反推视频节点」，所以这里迁到 B。）
            if (!isModifierShortcut && !event.altKey && !event.shiftKey && key === "b") {
                if (connectingParamsRef.current) {
                    event.preventDefault();
                    setConnecting(null);
                    setPendingConnectionCreate(null);
                    message.info(t("canvas.shortcut.connectCanceled"));
                    return;
                }
                const singleId = selectedNodeIdsRef.current.size === 1 ? Array.from(selectedNodeIdsRef.current)[0] : null;
                const singleNode = singleId ? nodesRef.current.find((node) => node.id === singleId) : null;
                if (singleNode?.type !== CanvasNodeType.VideoMerge) return;
                event.preventDefault();
                beginPickConnect();
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
    }, [
        copySelectedNodes,
        createNode,
        deleteConnection,
        deleteNodes,
        duplicateSelectedMediaAsNode,
        focusNode,
        handleDraftShortcut,
        message,
        pasteCopiedNodes,
        pasteSystemClipboard,
        redoCanvas,
        resetSelectedNodesToOriginalSize,
        resetSelectedNodesWindowSize,
        selectedConnectionId,
        setConnecting,
        t,
        undoCanvas,
    ]);

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
        /**
         * **外部内容进画布的唯一可靠通道**：原生 paste 事件 + `event.clipboardData`。
         *
         * 它是同步的、不弹权限、Firefox / Safari / iframe 里都能用；而 `navigator.clipboard.read()`
         * 在 Firefox 根本没实现、在 iframe 或「拒绝了剪贴板权限」时抛 `NotAllowedError` ——
         * 之前 Ctrl+V 被 `preventDefault()` 干掉后只剩那条路，于是图片和文字「总粘贴不上」。
         *
         * 这里按 图片文件 → 内嵌 data: 图片 → 纯文本 的顺序消费；都没命中才退回异步 API。
         */
        const handlePaste = (event: ClipboardEvent) => {
            // 生图/生视频提示词、最大化编辑弹窗里粘贴时，绝不能被画布「落成文本节点」抢走。
            // 同时检查 event.target 与 document.activeElement（弹窗 focus trap 下 target 偶发不准）。
            if (isCanvasTextPasteTarget(event.target) || isCanvasTextPasteTarget(document.activeElement)) {
                return;
            }
            // 编辑弹窗 portal 可能挂在 body，再扫一遍 DOM 标记兜底。
            if (document.querySelector("[data-canvas-text-edit-dialog] .ant-modal-root, [data-canvas-text-edit-dialog]")) {
                const active = document.activeElement;
                if (active instanceof Element && active.closest("[data-canvas-text-edit-dialog],.ant-modal-root,.ant-modal-wrap")) {
                    return;
                }
            }

            const data = event.clipboardData;
            if (!data) {
                void pasteSystemClipboard();
                return;
            }

            const position = getPastePosition();

            // 1) 文件类：截图 / 从资源管理器复制 / 网页右键「复制图片」都会走到这里（Word、飞书不一定，见第 2 步）。
            const itemFiles = Array.from(data.items || [])
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
            const dropped = Array.from(data.files || []);
            const candidates = dropped.length ? dropped : itemFiles;
            const files = candidates.filter(isPasteableNodeFile);
            if (files.length) {
                event.preventDefault();
                // 剪贴板里的图常常没有文件名（`File.name === ""`），补一个，否则节点标题会是空白。
                const named = files.map((file, index) => {
                    if (file.name) return file;
                    const extension = file.type.split("/")[1]?.split(";")[0] || "bin";
                    return new File([file], `clipboard-${Date.now()}-${index + 1}.${extension}`, { type: file.type || "application/octet-stream" });
                });
                createNodesFromFiles(named, position);
                return;
            }

            const plain = data.getData("text/plain") || "";
            const html = data.getData("text/html");
            const plainText = plain.trim();
            /**
             * 剪贴板里同时带正文和一张图时（网页 / Word / 飞书复制整段），正文才是用户要的东西：
             * 只有「没有正文」或「正文就是这个图片地址」才把图单独落成节点，否则落到第 5 步当文本。
             * 少了这个判断，复制一段带插图的文章会只贴出一张图，看起来就是「文字没识别上」。
             */
            const onlyImageSource = (src: string) => !plainText || plainText === src;

            // 2) 画布内部复制：只有确认「剪贴板里这段文字是我们写的」才当成节点复制，否则一律当外部内容。
            //    以前这一步在 keydown 里无条件抢占，导致复制过节点之后所有外部粘贴都失效。
            const fingerprint = clipboardFingerprintRef.current;
            const internalNodes = Boolean(clipboardRef.current?.nodes.length);
            if (internalNodes) {
                const ownText = Boolean(fingerprint) && plain.trim() === fingerprint?.text.trim();
                // 刚按完 Ctrl+C（writeText 可能还没落地 / 被拒），且剪贴板里没有可用的外部内容。
                const justCopied = Boolean(fingerprint) && Date.now() - (fingerprint?.at || 0) < 800;
                if (ownText || (!plain.trim() && !html)) {
                    event.preventDefault();
                    pasteCopiedNodes();
                    return;
                }
                if (justCopied && !plain.trim()) {
                    event.preventDefault();
                    pasteCopiedNodes();
                    return;
                }
            }

            // 3) html 里内嵌的 data: 图（Word / 飞书 / 语雀 / 网页编辑器）。
            const embeddedImage = extractClipboardDataImage(html);
            if (embeddedImage && onlyImageSource(embeddedImage)) {
                const embeddedFile = dataUrlToClipboardFile(embeddedImage);
                if (embeddedFile) {
                    event.preventDefault();
                    pasteClipboardImageFile(embeddedFile, position);
                    return;
                }
            }

            // 4) html 里的远程图地址：剪贴板既没有 file 项、src 也不是 data:（网页正文最常见的形状）。
            const remoteImage = extractClipboardRemoteImage(html);
            if (remoteImage && onlyImageSource(remoteImage)) {
                event.preventDefault();
                void pasteRemoteImage(remoteImage, position);
                return;
            }

            // 5) 文本 / 富文本。纯文本本身就是 data: 媒体时按媒体节点落，别塞成一段 base64 文字。
            const text = plain.trim() ? plain : clipboardHtmlToText(html);
            const mediaFile = mediaFileFromClipboardText(text.trim());
            if (mediaFile) {
                event.preventDefault();
                createNodesFromFiles([mediaFile], position);
                return;
            }
            if (createTextNodeFromClipboard(text)) {
                event.preventDefault();
                message.success(t("canvas.projectPage.clipboardTextAdded"));
                return;
            }

            // 6) clipboardData 里什么都没有（部分内嵌 WebView / 扩展）：先试内部节点，再退回异步 Clipboard API。
            if (pasteCopiedNodes()) {
                event.preventDefault();
                return;
            }
            if (!plain && !html) void pasteSystemClipboard();
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [createNodesFromFiles, createTextNodeFromClipboard, getPastePosition, message, pasteClipboardImageFile, pasteCopiedNodes, pasteRemoteImage, pasteSystemClipboard, t]);

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

    /**
     * G（图片分支）：一次性把选中的图片 / 标注节点降到 99% 并覆盖。
     *
     * `options.silentIfEmpty`：G 现在还要顺带处理视频 —— 只选了视频时不该再弹
     * 「选中的节点没有可缩放的图片」，所以「选空 / 没图片」这两种情况静默返回 0；
     * 真的动了图（成功 / 已是原尺寸 / 出错）照旧给提示。
     * 返回成功张数（外层要合并两条分支的结果）。
     */
    const downscaleSelectedImagesTo99 = useCallback(async (options?: { silentIfEmpty?: boolean }) => {
        const selectedIds = new Set(selectedNodeIdsRef.current);
        if (!selectedIds.size) {
            const fallbackId = toolbarNodeIdRef.current || hoveredNodeIdRef.current;
            if (fallbackId) selectedIds.add(fallbackId);
        }
        if (!selectedIds.size) {
            if (!options?.silentIfEmpty) message.warning(t("canvas.shortcut.selectNodeToResetSize"));
            return 0;
        }

        const eligible = nodesRef.current.filter((node) => selectedIds.has(node.id) && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Annotate) && Boolean(node.metadata?.content));
        if (!eligible.length) {
            if (!options?.silentIfEmpty) message.warning(t("canvas.shortcut.scaleNeedMedia"));
            return 0;
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
            return successCount;
        }
        if (lastError) {
            message.error(lastError instanceof Error ? lastError.message : t("canvas.editors.scaleFailed"));
            return 0;
        }
        message.info(t("canvas.editors.scaleAlreadyFull"));
        return 0;
    }, [message, scaleImageNodeDisplay, t]);

    // Capture-phase G 的键盘监听放在下面（`scaleSelectedVideosTo60` 之后）：视频分支要用的
    // `storeVideoToolResult` / `createAdjacentVideoNode` 在本文件更靠后的位置定义，
    // 提前挂依赖会踩 TDZ（渲染期就报 ReferenceError）。

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
                        const mode = node.metadata?.generationMode || (node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : node.type === CanvasNodeType.Text ? "text" : "image");
                        if (mode === "video" || node.type === CanvasNodeType.Video) {
                            const defaults = resolveNativeH3VideoSettingDefaults(basePatch.model, resolveModelScript(effectiveConfig, basePatch.model));
                            nextPatch = {
                                ...basePatch,
                                ...(defaults.vquality && basePatch.vquality === undefined ? { vquality: defaults.vquality } : {}),
                                ...(defaults.videoAudioMode && basePatch.audioMode === undefined ? { audioMode: defaults.videoAudioMode } : {}),
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
                    const safeName =
                        rawName
                            .replace(/[\\/:*?"<>|]+/g, "_")
                            .replace(/\s+/g, " ")
                            .trim()
                            .slice(0, 48) || "document";
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

    const openVideoTools = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) {
                message.warning(t("canvas.node.emptyVideo"));
                return;
            }
            setVideoToolsNodeId(node.id);
        },
        [message, t],
    );

    const openAudioTools = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) {
                message.warning(t("canvas.node.emptyAudio"));
                return;
            }
            setAudioToolsNodeId(node.id);
        },
        [message, t],
    );

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

    /**
     * 视频工具产物落盘。IndexedDB 配额满时**不能让整单失败**（本地文件夹还有副本时
     * `persistMediaBlob` 自己会吞掉，但延迟镜像那条路会把配额错抛出来），所以这里兜一层：
     * 退回内存 objectURL，节点照常出现，只是刷新后这一版会丢。
     */
    const storeVideoToolResult = useCallback(
        async (blob: Blob) => {
            try {
                return await storeGeneratedVideo({ blob, mimeType: "video/mp4" });
            } catch (error) {
                const url = URL.createObjectURL(blob);
                message.warning(`本地存储写入失败，这一版只在内存里（刷新会丢）：${error instanceof Error ? error.message : String(error)}`);
                return { url, storageKey: "", bytes: blob.size, mimeType: "video/mp4" };
            }
        },
        [message],
    );

    const handleVideoTrim = useCallback(
        async (result: VideoToolsTrimResult) => {
            const source = videoToolsNode;
            if (!source) return;
            const stored = await storeVideoToolResult(result.blob);
            await createAdjacentVideoNode(source, stored, t("canvas.videoTools.trimSuccess"));
            message.success(t("canvas.videoTools.trimSuccess"));
        },
        [createAdjacentVideoNode, message, storeVideoToolResult, t, videoToolsNode],
    );

    /** 按原尺寸百分比缩放：同样落一个相邻视频节点，标题带百分比，便于一眼看出是哪一版。 */
    const handleVideoScale = useCallback(
        async (result: VideoToolsScaleResult) => {
            const source = videoToolsNode;
            if (!source) return;
            const stored = await storeVideoToolResult(result.blob);
            const title = `${t("canvas.videoTools.tabs.scale")} ${result.percent}%`;
            await createAdjacentVideoNode(source, stored, title);
            message.success(t("canvas.videoTools.scaleSuccess"));
        },
        [createAdjacentVideoNode, message, storeVideoToolResult, t, videoToolsNode],
    );

    /** G 快捷键防重入：视频缩放要重编码、几秒钟跑不完，连按不该叠出两批产物。 */
    const scaleShortcutRunningRef = useRef(false);

    /**
     * G（视频分支）：把选中的视频直接缩放到 **60%**（用户 2026-11-11 第 02 条：
     * 「对画布中的视频按 g，可直接执行将其视频大小缩放之百分之 60 的命令」）。
     *
     * 走的是「视频工具 → 缩放」那条同一条链路（`loadVideoBlob` → `scaleVideoBlob` → 存盘 →
     * 落一个相邻视频节点），只是**跳过弹窗**直接按 60% 跑；产物是**新节点**，原视频不动。
     * 🔴 读字节只能走 `loadVideoBlob(url, storageKey)`：远程直链多半没有 CORS，`fetch` 拿不到。
     *
     * 没选中视频时静默返回 0（外层已经判过一次「有没有素材」）；一旦真的动手就自己汇报
     * 进度 / 成功 / 失败 —— 重编码要几秒，不给反馈会让人以为按坏了。
     */
    const scaleSelectedVideosTo60 = useCallback(async () => {
        const selectedIds = new Set(selectedNodeIdsRef.current);
        if (!selectedIds.size) {
            const fallbackId = toolbarNodeIdRef.current || hoveredNodeIdRef.current;
            if (fallbackId) selectedIds.add(fallbackId);
        }
        if (!selectedIds.size) return 0;

        const eligible = nodesRef.current.filter((node) => selectedIds.has(node.id) && node.type === CanvasNodeType.Video && Boolean(node.metadata?.content));
        if (!eligible.length) return 0;

        let successCount = 0;
        let lastError: unknown;
        const notice = message.loading({ content: t("canvas.shortcut.scaleVideoRunning"), duration: 0 });
        try {
            for (const node of eligible) {
                const latest = nodesRef.current.find((item) => item.id === node.id) || node;
                try {
                    const blob = await loadVideoBlob(latest.metadata?.content || "", latest.metadata?.storageKey);
                    const scaled = await scaleVideoBlob(blob, VIDEO_SCALE_SHORTCUT_PERCENT);
                    const stored = await storeVideoToolResult(scaled.blob);
                    await createAdjacentVideoNode(latest, stored, `${t("canvas.videoTools.tabs.scale")} ${scaled.percent}%`);
                    successCount += 1;
                } catch (error) {
                    lastError = error;
                }
            }
        } finally {
            notice();
        }

        if (successCount) message.success(t("canvas.shortcut.scaleVideosDone", { count: successCount }));
        else message.error(lastError instanceof Error ? lastError.message : t("canvas.editors.scaleFailed"));
        return successCount;
    }, [createAdjacentVideoNode, message, storeVideoToolResult, t]);

    /**
     * G 的**总入口**：图片 → 99% 覆盖（原方案，一个字没改）；视频 → 60%（新节点）。
     *
     * 两条分支各自汇报：同时选中图片和视频时两条都跑（各弹一句）；只选了视频时
     * 图片分支用 `silentIfEmpty` 闭嘴，不会冒出「没有可缩放的图片」的误报。
     */
    const handleScaleShortcut = useCallback(async () => {
        const selectedIds = new Set(selectedNodeIdsRef.current);
        if (!selectedIds.size) {
            const fallbackId = toolbarNodeIdRef.current || hoveredNodeIdRef.current;
            if (fallbackId) selectedIds.add(fallbackId);
        }
        if (!selectedIds.size) {
            message.warning(t("canvas.shortcut.selectNodeToResetSize"));
            return;
        }
        const selected = nodesRef.current.filter((node) => selectedIds.has(node.id));
        const hasVideo = selected.some((node) => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content));
        const hasImage = selected.some((node) => (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Annotate) && Boolean(node.metadata?.content));
        if (!hasVideo && !hasImage) {
            message.warning(t("canvas.shortcut.scaleNeedMedia"));
            return;
        }
        scaleShortcutRunningRef.current = true;
        try {
            await downscaleSelectedImagesTo99({ silentIfEmpty: hasVideo });
            if (hasVideo) await scaleSelectedVideosTo60();
        } finally {
            scaleShortcutRunningRef.current = false;
        }
    }, [downscaleSelectedImagesTo99, message, scaleSelectedVideosTo60, t]);

    // Capture-phase G（IME-safe KeyG）：图片 99% 覆盖 / 视频 60% 缩放。
    useEffect(() => {
        const handleScaleShortcutKeyDown = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            if (event.code !== "KeyG" && keyLower(event) !== "g") return;
            if (isImeComposing(event)) return;

            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
            if (target instanceof HTMLElement && target.isContentEditable) return;
            if (target instanceof Element && target.closest(".ant-modal")) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            // 视频缩放要重编码，可能跑几秒：连按不该叠出两批任务。
            if (scaleShortcutRunningRef.current) return;
            blurActiveCanvasTextInput();
            void handleScaleShortcut();
        };

        window.addEventListener("keydown", handleScaleShortcutKeyDown, true);
        return () => window.removeEventListener("keydown", handleScaleShortcutKeyDown, true);
    }, [handleScaleShortcut]);

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
        const preSelected = audioMergeCandidates.filter((candidate) => selectedNodeIdsRef.current.has(candidate.id)).map((candidate) => candidate.id);
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
            const publicUrl = /^https?:\/\//i.test(source.metadata.content) ? source.metadata.content : await uploadProviderMediaFile(upscaleConfig, blob, "source.mp4", { signal });
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
                const sourceIds = pieces.map((_, index) => slots[index]).filter((id): id is string => Boolean(id));
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
            const textNode = createCanvasNode(
                CanvasNodeType.Text,
                {
                    x: node.position.x + node.width + 96 + getNodeSpec(CanvasNodeType.Text).width / 2,
                    y: node.position.y + getNodeSpec(CanvasNodeType.Text).height / 2,
                },
                { content: text, status: "idle", fontSize: DEFAULT_CANVAS_FONT_SIZE },
            );
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

            // 与粘贴共用同一套分流规则（文档 / 音频 / 视频 / 图片 + 40px 阶梯）。
            createNodesFromFiles(files, screenToCanvas(event.clientX, event.clientY));
        },
        [createNodesFromFiles, screenToCanvas, t],
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
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                        void spawnExtraVideoNodes(nodeId, items[0].videoUrls, { prompt: scene, model: generationConfig.model });
                        setDialogNodeId(null);
                    } else {
                        const uploaded = await uploadGeneratedImage(items[0]);
                        setNodes((prev) =>
                            prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                        );
                        if (items.length > 1) {
                            void spawnExtraImageNodes(
                                nodeId,
                                items.slice(1).map((item) => item.dataUrl),
                                { prompt: scene, model: generationConfig.model },
                            );
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
            // 公司h3 pod FIFO: do not abort an in-flight job when another submit is queued.
            const queuedVideoSerial = mode === "video" && isQueuedVideoConfig(generationConfig);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId, new AbortController(), queuedVideoSerial ? { replaceTarget: false } : undefined);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            // 风格模板：图片 + 视频都生效（用户 2026-11-08 第 04 条「视频窗口添加图片节点的风格模板」）。
            // 摄像机只有图片节点有这个控件，视频传空串。
            // 合成方式见 `composeStyledPrompt`：本体在前、修饰在后（只设了修饰时也不能把本体丢掉）。
            const styleTemplateApplies = mode === "image" || mode === "video";
            const styleTemplate = styleTemplateApplies ? getStyleTemplate(sourceNode?.metadata?.styleTemplateId) : undefined;
            const stylePromptText = styleTemplate ? buildStylePromptText(styleTemplate) : "";
            const cameraPrompt = mode === "image" ? buildCameraSelectionPrompt(sourceNode?.metadata?.cameraSelection) : "";
            const modelPrompt = composeStyledPrompt(effectivePrompt, stylePromptText, cameraPrompt);
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
                    let referenceImages = generationContext.referenceImages.filter((ref) => ref.id !== nodeId && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.dataUrl !== selfContent);
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
                    const retainedImages = appendImageHistory && previousImages.length + count > MAX_IMAGE_NODE_HISTORY ? previousImages.slice(Math.max(0, previousImages.length - (MAX_IMAGE_NODE_HISTORY - count))) : previousImages;
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
                    // 出图后画幅自检收口（用户 2026-11-08 第 07 条外挂）：只记一次，最后汇总成一条提示。
                    // 为什么在这里而不在生图请求里：`size` 有没有被上游听见**只有返回的像素能证明**。
                    const aspectMismatches: string[] = [];
                    const newImageIdSet = new Set(imageIds);
                    const applyGeneratedSlot = async (imageId: string, image: GeneratedImageResult) => {
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
                        // 画幅没按要求的来（偏差 > 12%）→ 收集，末尾统一提示一次：这说明这家模型/中转
                        // 不吃 `size`，光靠提示词也只是尽量掰，换模型才是真解。
                        const aspectMismatch = describeScriptAssetAspectMismatch(generationConfig.size, uploaded.width, uploaded.height);
                        if (aspectMismatch) aspectMismatches.push(aspectMismatch);
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
                                                      images: node.metadata?.images?.map((image) => (newImageIdSet.has(image.id) ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
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
                                                node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((current) => (current.id === imageId ? { ...current, status: NODE_STATUS_SUCCESS } : current)) } } : node,
                                            ),
                                        );
                                        void spawnExtraVideoNodes(rootId, items[0].videoUrls, { prompt: effectivePrompt, model: generationConfig.model });
                                    } else {
                                        await applyGeneratedSlot(imageId, items[0]);
                                        // Storyboard-style workflows return every frame regardless of the count
                                        // param; place the leftovers instead of silently dropping them.
                                        if (items.length > 1) {
                                            void spawnExtraImageNodes(
                                                rootId,
                                                items.slice(1).map((item) => item.dataUrl),
                                                { prompt: effectivePrompt, model: generationConfig.model },
                                            );
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
                    if (aspectMismatches.length) {
                        message.warning(
                            t("canvas.projectPage.imageAspectMismatch", {
                                requested: generationConfig.size,
                                actual: aspectMismatches[0],
                                count: aspectMismatches.length,
                                model: generationConfig.model || "-",
                            }),
                            6,
                        );
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
                    const referenceImages = generationContext.referenceImages.filter((ref) => ref.id !== nodeId && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.dataUrl !== selfContent);
                    const videoId = writeVideoToSelf ? nodeId : nanoid();
                    const versionId = nanoid();
                    const previousVideos = writeVideoToSelf ? collectSuccessfulImageHistory(sourceNode) : [];
                    const appendVideoHistory = writeVideoToSelf && previousVideos.length > 0;
                    const retainedVideos = appendVideoHistory && previousVideos.length + 1 > MAX_IMAGE_NODE_HISTORY ? previousVideos.slice(Math.max(0, previousVideos.length - (MAX_IMAGE_NODE_HISTORY - 1))) : previousVideos;
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
                    const controller = videoId === nodeId ? runController : startGenerationRequest(videoId, nodeId, nodeId, new AbortController(), queuedVideoSerial ? { replaceTarget: false } : undefined);
                    const runNativeVideoJob = async () => {
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        // 视频也吃节点上的「风格模板」（`modelPrompt` = 本体 + 风格段；文本/音频模式下两者相等）。
                        const videoResult = await requestVideoGeneration(generationConfig, modelPrompt, referenceImages, {
                            signal: controller.signal,
                            referenceAudios: generationContext.referenceAudios || [],
                            // A clip wired into the video node is a real reference (not just a frame):
                            // the RunningHub 文武双全 graph maps it onto `ref_videos.ref_video_0`.
                            referenceVideos: generationContext.referenceVideos || [],
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
                        if (isQueuedVideoConfig(generationConfig)) {
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
                    const referenceAudios = (generationContext.referenceAudios || []).filter((ref) => ref.id !== nodeId && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.url !== selfContent);
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
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal, referenceAudios }), generationConfig.audioFormat);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === audioId
                                    ? {
                                          ...node,
                                          metadata: {
                                              ...node.metadata,
                                              ...audioMetadata(audio),
                                              prompt: effectivePrompt,
                                              ...buildAudioGenerationMetadata(generationConfig),
                                              references: generationReferenceUrls({ referenceImages: [], referenceVideos: [], referenceAudios }),
                                              status: NODE_STATUS_SUCCESS,
                                              errorDetails: undefined,
                                          },
                                      }
                                    : node,
                            ),
                        );
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
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isQueuedVideoConfig, message, openConfigDialog, startGenerationRequest, t],
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
            createVideoNode: createBridgeVideoNode,
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
    }, [createBridgeImageNode, createBridgeTextNode, createBridgeVideoNode, handleConfigNodeChange, projectId, projectLoaded]);

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
            /**
             * 重试也要吃节点上的「风格模板」（图片是重跑这张图、视频是重跑这段片子，出片口径必须和首次一致）。
             * 写回 metadata 的仍是干净的 `prompt`，`modelPrompt` 只进请求；`composeStyledPrompt` 幂等，
             * 老节点的 `savedImageMetadata.prompt` 里若已经带了风格段也不会叠第二遍。
             */
            const retryStyleId = node.metadata?.styleTemplateId || sourceNode.metadata?.styleTemplateId;
            const retryStyleTemplate = getStyleTemplate(retryStyleId);
            const retryPrompt =
                node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video
                    ? composeStyledPrompt(
                          prompt,
                          retryStyleTemplate ? buildStylePromptText(retryStyleTemplate) : "",
                          node.type === CanvasNodeType.Image ? buildCameraSelectionPrompt(node.metadata?.cameraSelection || sourceNode.metadata?.cameraSelection) : "",
                      )
                    : prompt;
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const resolvedRetryRefs = hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? context?.referenceImages || [] : [];
            const retryImages = (resolvedRetryRefs || []).filter((ref) => ref.id !== node.id && ref.storageKey !== node.metadata?.storageKey && ref.dataUrl !== node.metadata?.content);
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
            const queuedVideoSerial = node.type === CanvasNodeType.Video && isQueuedVideoConfig(generationConfig);
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id, new AbortController(), queuedVideoSerial ? { replaceTarget: false } : undefined);

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
                        const videoResult = await requestVideoGeneration(generationConfig, retryPrompt, retryImages, {
                            signal: controller.signal,
                            referenceAudios: context?.referenceAudios || [],
                            referenceVideos: context?.referenceVideos || [],
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
                    if (isQueuedVideoConfig(generationConfig)) {
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
                        const referenceAudios = (context?.referenceAudios || []).filter((ref) => ref.id !== node.id && !generatedChildIds.has(ref.id) && ref.storageKey !== selfStorageKey && ref.url !== selfContent);
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal, referenceAudios }), generationConfig.audioFormat);
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

                const retryItems = useReferenceImages ? await requestEdit(generationConfig, retryPrompt, retryImages, undefined, { signal: controller.signal }) : await requestGeneration(generationConfig, retryPrompt, { signal: controller.signal });
                if (retryItems[0]?.videoUrls?.length) {
                    // The request produced a clip and no image: nothing to fill the image slot
                    // with — mark the round done and spawn the video node instead.
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item)));
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
                    void spawnExtraImageNodes(
                        node.id,
                        retryItems.slice(1).map((item) => item.dataUrl),
                        { prompt, model: generationConfig.model },
                    );
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
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isQueuedVideoConfig, message, openConfigDialog, startGenerationRequest, t],
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
        /**
         * 返回值 = 这次对话的**回复正文**（拿不到就是空串）。
         * 「反推视频」这类编排要拿它去建文本节点，所以不能只靠 `metadata.messages` 回读 ——
         * 状态更新是异步的，`await` 回来时 `nodesRef` 未必已经有那条 assistant 消息。
         */
        async (nodeId: string, text: string, options: ChatSendOptions = { text: true, image: false }): Promise<string> => {
            const { text: runText, image: runImage, linkedMedia = [] } = options;
            if (!runText && !runImage) return "";

            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Chat) return "";
            if (sourceNode.metadata?.status === NODE_STATUS_LOADING) return "";

            const linkedContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, ""));
            const linkedText = linkedContext.prompt.trim() || (sourceNode.metadata?.content || "").trim();
            const typedText = text.trim();
            // Media pinned in the composer (the "linked images" chips) that may not be wired as a connection
            // or spelled out in the prompt — these must still reach image generation, e.g. Seedream reference images.
            const composerLinkedImages = linkedMedia.length ? await resolveCanvasReferenceImages(linkedMedia, nodesRef.current) : [];
            const hasLinkedMedia = (linkedContext.imageCount || 0) > 0 || (linkedContext.videoCount || 0) > 0 || composerLinkedImages.length > 0;
            const userText = typedText || linkedText || (hasLinkedMedia ? t("canvas.chat.defaultMediaPrompt") : "");
            if (!userText) return "";

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
                return "";
            }
            if (runImage && imageConfig && !isAiConfigReady(imageConfig, imageConfig.model)) {
                openConfigDialog(true);
                rollbackMessages();
                return "";
            }

            const controller = new AbortController();
            setRunningNodeId(nodeId);
            startGenerationRequest(nodeId, nodeId, nodeId, controller);

            /**
             * 「Agent 写词 + 出图」：对话与生图都开、且节点上开了这个开关时，两路从并行改成串行 ——
             * 先跑 agent / 文本模型，把它的产物当作生图提示词。默认关闭，行为与以前完全一致。
             */
            const imageUsesAgentPrompt = runText && runImage && Boolean(sourceNode.metadata?.chatImageUseAgentPrompt);
            /**
             * agent 在这次发送里真正写到画布上的提示词（update_node_prompt 的正文 / 新建文本节点的正文）。
             * 它比 agent 回复的「汇报」更接近要出图的那段词，所以优先用它。
             */
            let agentWrittenPrompt = "";

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
                const historyMessages: AiTextMessage[] = previousMessages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ role: message.role as "user" | "assistant", content: message.text }));

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
                const nativeChatVideo = modelSupportsNativeChatVideo(textConfig);
                const videoParts: Extract<AiTextContentPart, { type: "video_url" }>[] = [];
                let videoFrames: ReferenceImage[] = [];
                if (uniqueVideos.length) {
                    if (nativeChatVideo) {
                        // 支持 video_url 的模型：原样传视频（本地 blob 先转成临时公开 URL）。
                        for (const video of uniqueVideos) {
                            try {
                                const url = await resolvePublicChatVideoUrl(video.url, controller.signal);
                                if (url) videoParts.push({ type: "video_url", video_url: { url } });
                            } catch {
                                // 单个视频上传失败时退回抽帧，不拖垮整次对话。
                                const frame = await captureVideoFrameDataUrl(video.url);
                                if (frame) {
                                    videoFrames.push({
                                        id: `video-frame:${video.id}`,
                                        name: `${video.title}.jpg`,
                                        type: "image/jpeg",
                                        dataUrl: frame,
                                    });
                                }
                            }
                        }
                    } else {
                        videoFrames = (
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
                    }
                }

                /**
                 * 去重键：同一张图会从两条路同时进来 ——
                 *  ① 连线：`readReferenceImage` 给的 `id` 是**裸 nodeId**；
                 *  ② `@图片N` 的 mention 解析：`resolveCanvasReferenceImages` 给的 `id` 是 `canvas:nodeId`。
                 * 两个 id 前缀不同，直接拿 `id` 当键就会让同一张图被发**两遍**（白烧 token，
                 * 模型还会以为给了两张参考图 —— 反推 02/03 现在正是「参考图连线 + 文案里点名 @图片1」同时成立，
                 * 一定会撞上）。所以先剥掉 `canvas:` 前缀再比，都没有 id 才退化成比 dataUrl。
                 */
                const referenceImageKey = (image: ReferenceImage) => String(image.id || "").replace(/^canvas:/, "") || image.dataUrl;
                const referenceImages = Array.from(new Map([...linkedImages, ...resolvedMentionImages, ...videoFrames].filter((image) => Boolean(image?.dataUrl)).map((image) => [referenceImageKey(image), image])).values());

                const videoTitles = uniqueVideos.map((item) => item.title).join("、");
                const videoNote = uniqueVideos.length
                    ? `\n\n${videoParts.length ? t("canvas.chat.linkedVideoNativeNote", { count: videoParts.length, titles: videoTitles }) : t("canvas.chat.linkedVideoNote", { count: uniqueVideos.length, titles: videoTitles })}`
                    : "";
                const promptText = `${userText}${videoNote}`;
                const mediaParts: AiTextContentPart[] = [...referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } })), ...videoParts];
                const userContent: AiTextMessage["content"] = mediaParts.length ? [{ type: "text" as const, text: promptText }, ...mediaParts] : promptText;

                const requestMessages: AiTextMessage[] = [
                    ...(typedText && linkedText && typedText !== linkedText ? [{ role: "system" as const, content: `${t("canvas.chat.contextLabel")}:\n${linkedText}` }] : []),
                    ...historyMessages,
                    { role: "user", content: userContent },
                ];
                /**
                 * Agent：绑定了 agent 的 Chat 节点不再只是「聊天」，而是一次发送就把整套技能跑完。
                 *  - 提示词：agent 的人设（含自主执行纪律）+ 技能说明，都放在 system 里；
                 *  - 技能：节点自己勾的 **∪** agent 自带的（并集，不会把用户勾的吞掉）；
                 *  - 轮数：agent 自己的 maxToolRounds（普通对话仍是默认 6 轮），多步任务才跑得完。
                 */
                const agent = resolveCanvasAgent(sourceNode.metadata?.agentId, useCanvasAgentsStore.getState().agents);
                const nodeSkillIds = resolveChatSkillIds(sourceNode.metadata?.chatSkillIds);
                const skillIds = agent ? Array.from(new Set([...nodeSkillIds, ...agent.skillIds])) : nodeSkillIds;
                const skillTools = resolveChatSkillTools(skillIds);
                const skillsHint = chatSkillsSystemHint(skillIds);
                const agentHint = agent ? buildCanvasAgentSystemPrompt(agent) : "";
                const messagesWithSkills: AiTextMessage[] = [...(agentHint ? [{ role: "system" as const, content: agentHint }] : []), ...(skillsHint ? [{ role: "system" as const, content: skillsHint }] : []), ...requestMessages];
                // agent 建的文本节点按顺序往下排，避免全叠在同一个点上。
                let agentCreatedNodes = 0;
                const answer = await requestImageQuestion(textConfig!, messagesWithSkills, (streamed) => updateAssistantMessage({ text: streamed }), {
                    signal: controller.signal,
                    ...(agent ? { maxToolRounds: agent.maxToolRounds } : {}),
                    ...(skillTools.length
                        ? {
                              tools: skillTools,
                              executeTool: (name, args) =>
                                  executeChatSkillTool(name, args, {
                                      chatNodeId: nodeId,
                                      nodes: nodesRef.current,
                                      connections: connectionsRef.current,
                                      updateNodeMetadata: (targetId, patch) => {
                                          // 记住 agent 写过的提示词，「写词出图」开关用它当生图提示词。
                                          const written = typeof patch.prompt === "string" ? patch.prompt.trim() : "";
                                          if (written) agentWrittenPrompt = written;
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
                                      /**
                                       * 让 agent 真能在画布上留下东西（而不只是改提示词）。
                                       * 这里**不能**用上面的 `createNode`：它只 setNodes 不同步 nodesRef，
                                       * 同一轮里紧接着的 connect_nodes 会找不到刚建的节点。
                                       */
                                      createTextNode: ({ title, text }) => {
                                          // 新建文本节点也是 agent 的产物：它就是「写好的词」，同样算进生图提示词候选。
                                          const written = (text || "").trim();
                                          if (written) agentWrittenPrompt = written;
                                          const anchor = nodesRef.current.find((item) => item.id === nodeId) || sourceNode;
                                          const index = agentCreatedNodes++;
                                          const created = createCanvasNode(
                                              CanvasNodeType.Text,
                                              { x: anchor.position.x + anchor.width + 200, y: anchor.position.y + 80 + index * 90 },
                                              { content: text, prompt: text, composerContent: text, promptSyncAt: Date.now() },
                                          );
                                          const next = [...nodesRef.current, title ? { ...created, title } : created];
                                          nodesRef.current = next;
                                          setNodes(next);
                                          return created.id;
                                      },
                                      connectNodes: (fromNodeId, toNodeId) => {
                                          const pairs = resolveConnectionPairs(fromNodeId, toNodeId, nodesRef.current, "source");
                                          if (!pairs.length) return false;
                                          const existing = new Set(connectionsRef.current.map((conn) => `${conn.fromNodeId}->${conn.toNodeId}`));
                                          const additions = pairs.filter((pair) => !existing.has(`${pair.fromNodeId}->${pair.toNodeId}`)).map((pair) => ({ id: nanoid(), ...pair }));
                                          if (!additions.length) return true;
                                          const next = [...connectionsRef.current, ...additions];
                                          connectionsRef.current = next;
                                          setConnections(next);
                                          return true;
                                      },
                                  }),
                              onToolStart: (name) => updateAssistantMessage({ text: t("canvas.chat.skillsUsing", { name }) }),
                          }
                        : {}),
                });
                updateAssistantMessage({ text: answer });
                return answer;
            };

            /** promptOverride：写词出图时传 agent 写好的提示词；不传就是原来的「用户原话 + 上游文本」。 */
            const runImageTask = async (promptOverride?: string) => {
                const imagePrompt = (promptOverride || "").trim() || userText;
                const imageContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, imagePrompt));
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
                    new Map([...composerLinkedImages, ...(resolvedMentions.length ? resolvedMentions : imageContext.referenceImages), ...videoFrames].filter((image) => Boolean(image?.dataUrl)).map((image) => [image.id || image.dataUrl, image])).values(),
                );
                const finalPrompt = imageContext.prompt || imagePrompt;
                const results = referenceImages.length
                    ? await requestEdit({ ...imageConfig!, count: "1" }, finalPrompt, referenceImages, undefined, { signal: controller.signal })
                    : await requestGeneration({ ...imageConfig!, count: "1" }, finalPrompt, { signal: controller.signal });
                const uploadedImages = await Promise.all(results.map(async (item) => uploadGeneratedImage(item)));
                const chatImages = uploadedImages.map((uploaded, index) => ({
                    id: `${assistantId}-${index}`,
                    dataUrl: uploaded.url,
                    storageKey: uploaded.storageKey,
                    prompt: finalPrompt,
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

            /** 把单个任务包成 allSettled 的形状，串行模式复用下面同一段收尾逻辑（不重复写错误合并）。 */
            const settleTask = <T,>(task: Promise<T>): Promise<PromiseSettledResult<T>> =>
                task.then(
                    (value) => ({ status: "fulfilled" as const, value }),
                    (reason: unknown) => ({ status: "rejected" as const, reason }),
                );

            try {
                // 写词出图：必须等文字/agent 那一路跑完，才知道要拿哪段提示词去出图。
                const settled = imageUsesAgentPrompt
                    ? await (async () => {
                          const textResult = await settleTask(runText ? runTextTask() : Promise.resolve(null));
                          if (controller.signal.aborted) return null;
                          // 优先用 agent 写进节点的词；它没写节点就退一步用回复正文（剥掉围栏/前缀）。
                          // 两者都拿不到时 runImageTask 会回落到用户原话 —— 出图绝不能拿到空提示词。
                          const promptForImage = agentWrittenPrompt.trim() || extractPromptFromReply(textResult.status === "fulfilled" ? textResult.value : "");
                          // agent 那一路失败也不挡出图。
                          const imageResult = await settleTask(runImage ? runImageTask(promptForImage) : Promise.resolve(null));
                          return [textResult, imageResult] as const;
                      })()
                    : await Promise.allSettled([runText ? runTextTask() : Promise.resolve(null), runImage ? runImageTask() : Promise.resolve(null)]);
                if (!settled) return "";
                const [textResult, imageResult] = settled;

                // 「反推视频」要拿这段正文去建文本节点：这里是唯一可靠的取词点（runTextTask 的返回值）。
                const textAnswer = textResult.status === "fulfilled" ? String(textResult.value || "").trim() : "";

                if (controller.signal.aborted) return "";

                const errors: string[] = [];
                if (textResult.status === "rejected") {
                    const reason = textResult.reason;
                    if (!isGenerationCanceled(reason)) errors.push(reason instanceof Error ? reason.message : String(reason));
                }
                if (imageResult.status === "rejected") {
                    const reason = imageResult.reason;
                    if (!isGenerationCanceled(reason)) errors.push(reason instanceof Error ? reason.message : String(reason));
                }

                if (controller.signal.aborted) return "";

                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id !== nodeId) return node;
                        const currentAssistant = (node.metadata?.messages || []).find((message) => message.id === assistantId);
                        const hasText = Boolean(currentAssistant?.text?.trim());
                        const hasImages = Boolean(currentAssistant?.images?.length);
                        const allFailed = errors.length > 0 && !hasText && !hasImages;

                        if (allFailed) {
                            const messages = (node.metadata?.messages || []).map((message) => (message.id === assistantId ? { ...message, role: "error" as const, text: errors.join("\n") } : message));
                            return { ...node, metadata: { ...node.metadata, messages, status: NODE_STATUS_ERROR, errorDetails: errors.join("\n") } };
                        }

                        let nextText = currentAssistant?.text || "";
                        if (errors.length) {
                            const note = t("canvas.chat.partialError", { error: errors.join("\n") });
                            nextText = nextText ? `${nextText}\n\n${note}` : note;
                        }

                        const messages = (node.metadata?.messages || []).map((message) => (message.id === assistantId ? { ...message, text: nextText || message.text, role: "assistant" as const } : message));
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
                return textAnswer;
            } catch (error) {
                if (isGenerationCanceled(error) || controller.signal.aborted) return "";
                const errorDetails = error instanceof Error ? error.message : String(error);
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id !== nodeId) return node;
                        const messages = (node.metadata?.messages || []).map((message) => (message.id === assistantId ? { ...message, role: "error" as const, text: errorDetails } : message));
                        return { ...node, metadata: { ...node.metadata, messages, status: NODE_STATUS_ERROR, errorDetails } };
                    }),
                );
                return "";
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
        // 右键落在**已选中**的一员上时保留整个选区（多选后右键要能出「一键生成」）；
        // 落在选区外则按常规塌缩成这一个节点。用 ref 读，避免把选区状态塞进 CanvasNode 的 props。
        const current = selectedNodeIdsRef.current;
        if (current.size <= 1 || !current.has(nodeId)) {
            setSelectedNodeIds(new Set([nodeId]));
        }
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

    /** 右键菜单顶部「h3 提示词优化」作用的节点：选区里的图片 / 视频节点，且提示词非空。 */
    const [h3OptimizeOpen, setH3OptimizeOpen] = useState(false);
    /**
     * 打开弹窗时**冻结**一份目标列表。
     *
     * 不能直接用 `h3OptimizeTargets`：点菜单项会先开弹窗、再 `setContextMenu(null)`，
     * 而 targets 的 memo 以 contextMenu 为前提，菜单一关就变空数组 → 弹窗里「0 个节点」。
     * 冻结之后也顺带免疫「优化过程中节点被改写、列表跟着抖」。
     */
    const [h3OptimizeSnapshot, setH3OptimizeSnapshot] = useState<H3OptimizeTarget[]>([]);
    const h3OptimizeTargets = useMemo(() => {
        if (!contextMenu || contextMenu.type !== "node") return [];
        return collectH3OptimizeTargets(nodes, Array.from(selectedNodeIds));
    }, [contextMenu, nodes, selectedNodeIds]);
    const openH3Optimize = useCallback(() => {
        // 同一时间只允许一个后台队列：两批并行会互相覆盖同一批节点的提示词。
        if (isH3OptimizeQueueRunning()) {
            message.warning(t("canvas.h3Optimize.busy"));
            return;
        }
        setH3OptimizeSnapshot(h3OptimizeTargets);
        setH3OptimizeOpen(true);
    }, [h3OptimizeTargets, message, t]);
    /** 批量优化的文本模型配置（模型本身在弹窗里单独选，默认跟默认文本模型走）。 */
    const h3OptimizeConfig = useMemo(() => buildGenerationConfig(effectiveConfig, undefined, "text"), [effectiveConfig]);
    /**
     * 逐个把优化结果写回节点。
     *
     * 字段与提示词面板同口径（`prompt` / `composerContent`），并且**必须** bump `promptSyncAt` ——
     * 面板里那份提示词是局部 state，只认这个时间戳才会重新同步；不 bump 就会出现
     * 「节点里已经转成 h3 了、面板还显示旧文本」。
     */
    const handleH3OptimizeApply = useCallback(
        (target: H3OptimizeTarget, text: string) => {
            if (target.field === "composerContent") handleConfigNodeChange(target.id, { composerContent: text, promptSyncAt: Date.now() });
            else handleConfigNodeChange(target.id, { prompt: text, promptSyncAt: Date.now() });
        },
        [handleConfigNodeChange],
    );

    /**
     * 弹窗点「开始」→ 关窗 + 丢进**后台队列**（`lib/canvas/h3-optimize-runner.ts`）。
     *
     * 用户 2026-11-07 报障：「选择模型执行后…不要一直挂着，我无法操作别的内容了」。
     * 所以这里**不 await 阻止关窗**：先把弹窗关掉，队列自己串行跑、边跑边写回节点，
     * 进度和「停止」在右下角 `CanvasH3OptimizeProgress`。
     */
    const runH3OptimizeBatch = useCallback(
        (options: { model: string; systemPrompt: string }) => {
            const targets = h3OptimizeSnapshot;
            setH3OptimizeOpen(false);
            if (!targets.length) return;
            const config: AiConfig = { ...h3OptimizeConfig, model: options.model.trim() || h3OptimizeConfig.textModel || h3OptimizeConfig.model };
            void startH3OptimizeQueue({ jobs: targets, config, systemPrompt: options.systemPrompt, onApply: handleH3OptimizeApply }).then((result) => {
                if (!result.started) {
                    if (result.reason === "busy") message.warning(t("canvas.h3Optimize.busy"));
                    return;
                }
                if (result.cancelled) message.info(t("canvas.h3Optimize.cancelled", { count: result.done }));
                else if (result.failed > 0) message.warning(t("canvas.h3Optimize.doneWithFailed", { count: result.done, failed: result.failed }));
                else message.success(t("canvas.h3Optimize.done", { count: result.done }));
            });
        },
        [handleH3OptimizeApply, h3OptimizeConfig, h3OptimizeSnapshot, message, t],
    );

    /** 右键菜单顶部「一键生成」作用的节点：选区里至少 2 个图片 / 视频节点才算数。 */
    const batchGenerateNodeIds = useMemo(() => {
        if (!contextMenu || contextMenu.type !== "node" || selectedNodeIds.size < 2) return [];
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const ids = Array.from(selectedNodeIds).filter((id) => isBatchGeneratableNode(byId.get(id)));
        return ids.length >= 2 ? ids : [];
    }, [contextMenu, nodes, selectedNodeIds]);

    /**
     * 批量生成：把选区里的图片 / 视频节点一次性丢进生成队列。
     *
     * 刻意复用 `handleGenerateNode`（而不是另写一条请求链路），这样提示词上游合并、风格 / 摄像机修饰、
     * 排队与中止、状态回写全都与单点生成一模一样；每个节点各自持一个 abort controller，互不影响。
     */
    const handleBatchGenerate = useCallback(
        (nodeIds: string[]) => {
            const plan = buildBatchGeneratePlan({
                nodes: nodesRef.current,
                nodeIds,
                connections: connectionsRef.current,
                isGenerating: isNodeGenerating,
            });
            if (!plan.items.length) {
                message.warning(t("canvas.contextMenu.batchGenerateEmpty"));
                return;
            }
            for (const item of plan.items) void handleGenerateNode(item.nodeId, item.mode, item.prompt);
            message.success(t("canvas.contextMenu.batchGenerateStarted", { count: plan.items.length }));
            const skipped = plan.skippedRunning + plan.skippedNoPrompt + plan.skippedType;
            if (skipped > 0) message.info(t("canvas.contextMenu.batchGenerateSkipped", { count: skipped }));
        },
        [handleGenerateNode, isNodeGenerating, message, t],
    );

    /** 右键菜单顶部「成组」作用的节点：选区里至少 2 个**非分组**节点（图片 + 文本混选也算）。 */
    const groupableNodeIds = useMemo(() => {
        if (!contextMenu || contextMenu.type !== "node" || selectedNodeIds.size < 2) return [];
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const ids = Array.from(selectedNodeIds).filter((id) => {
            const node = byId.get(id);
            return Boolean(node && isGroupableNode(node));
        });
        return ids.length >= 2 ? ids : [];
    }, [contextMenu, nodes, selectedNodeIds]);

    /**
     * 把选区打成一个分组框。
     *
     * 只做两件事：按包围盒摆一个框 + 给成员挂 `metadata.groupId`，**成员位置一个都不动**
     * （成组不该打乱用户排好的版）。组本身和普通节点一样能连线：连它 = 连它里面的每一个成员
     * （`resolveConnectionPairs` 会把组端点展开成全体成员），所以下游一次就能取到组里的
     * 全部图片和文本；成员自己的连线照旧，单独取某一个不受影响。
     */
    const handleGroupSelected = useCallback(
        (nodeIds: string[]) => {
            const members = collectGroupMembers(nodesRef.current, nodeIds);
            const frame = resolveGroupFrame(members);
            if (!frame || members.length < 2) {
                message.warning(t("canvas.contextMenu.groupEmpty"));
                return;
            }
            // 工厂收的是**中心点**、且用默认尺寸；这里必须整份覆盖成包围盒算出来的左上角 + 真实尺寸。
            const groupNode: CanvasNodeData = {
                ...createCanvasNode(CanvasNodeType.Group, { x: 0, y: 0 }),
                position: frame.position,
                width: frame.width,
                height: frame.height,
            };
            const memberIds = new Set(members.map((member) => member.id));
            // 组框要**垫在成员下面**（数组靠前 = 渲染靠后）：追加到末尾会让半透明的组框盖在成员上方，
            // 成员看着发灰。插到第一个成员的位置，成员就整个露在框上，框的空白区照样能拖。
            setNodes((prev) => {
                const next = attachNodesToGroup(prev, memberIds, groupNode.id);
                const firstMemberIndex = next.findIndex((node) => memberIds.has(node.id));
                next.splice(firstMemberIndex < 0 ? next.length : firstMemberIndex, 0, groupNode);
                return next;
            });
            // 成组后选中这个组：紧接着按 X 就能把它连到下游，一步取到整组内容。
            setSelectedNodeIds(new Set([groupNode.id]));
            setSelectedConnectionId(null);
            message.success(t("canvas.contextMenu.groupCreated", { count: members.length }));
        },
        [message, t],
    );

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
    const handleChatModesChange = useCallback((nodeId: string, options: { text: boolean; image: boolean }) => handleConfigNodeChange(nodeId, { chatTextEnabled: options.text, chatImageEnabled: options.image }), [handleConfigNodeChange]);
    // 「Agent 写词 + 出图」：写 false 也要落盘（关掉是一种明确状态），所以不能用 undefined 省略。
    const handleChatImageUseAgentPromptChange = useCallback((nodeId: string, enabled: boolean) => handleConfigNodeChange(nodeId, { chatImageUseAgentPrompt: enabled }), [handleConfigNodeChange]);
    const handleChatSkillsChange = useCallback((nodeId: string, skillIds: string[]) => handleConfigNodeChange(nodeId, { chatSkillIds: skillIds }), [handleConfigNodeChange]);
    // 解绑时写 undefined 会被 patch 忽略，所以显式落成空串再在读取侧当「无 agent」处理。
    const handleChatAgentChange = useCallback((nodeId: string, agentId: string | undefined) => handleConfigNodeChange(nodeId, { agentId: agentId || "" }), [handleConfigNodeChange]);
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

    /**
     * 分镜表一次生成的结局。`ok=false` 时 `error` 是给用户看的原因；
     * `cancelled` = 用户点了停止 / 被超时 abort / 前置条件不满足（不算「报错」，不该触发换模型重试）。
     */
    type ScriptGenerationOutcome = { ok: boolean; cancelled?: boolean; error?: string; rows?: number };

    // 脚本生成：走文本模型通道（与 Chat 节点同一条 requestImageQuestion），把分镜表 system prompt +
    // 结构化任务发给模型，边流边把原始文本写进 scriptRaw，结束后解析成 scriptRows。
    /**
     * 脚本节点三段的**实际取值**：一律按**此刻**的词库 / 技能库重新解析（用户 2026-11-08 报障）。
     *
     * 改造前这里直接读 `sourceNode.metadata?.scriptSystemPrompt / scriptAssetPrompt / scriptShotPrompt`，
     * 那三个字段是「节点建好时从词库预填进去的快照」—— 用户在设置里改了词条，节点上还是老正文，
     * 生成出来的角色 / 场景描述全是老口径，即用户说的「固定化」。
     *
     * 现在只有用户在「自定义提示词」弹窗里存过**与词库不同**的内容（`scriptPromptPins`）才用节点那份，
     * 其余一律跟随实时词库（判定细节见 `resolveScriptPromptValues`）。
     * ⚠️ 所有脚本生成入口（整表生成 / 单镜重生成 / 补资产描述）都必须经过这一个函数，别再各读各的 metadata。
     */
    const resolveScriptPromptsOf = useCallback(
        (sourceNode: CanvasNodeData) =>
            resolveScriptPromptValues({
                scheme: sourceNode.metadata?.scriptScheme,
                textPrompts: effectiveConfig.textPrompts,
                skills: chatSkillPacks,
                pins: sourceNode.metadata?.scriptPromptPins,
                stored: {
                    system: sourceNode.metadata?.scriptSystemPrompt,
                    asset: sourceNode.metadata?.scriptAssetPrompt,
                    shot: sourceNode.metadata?.scriptShotPrompt,
                },
            }),
        [chatSkillPacks, effectiveConfig.textPrompts],
    );

    const runScriptGeneration = useCallback(
        async (nodeId: string, overrides?: { scriptSource?: string; scriptPrompt?: string; model?: string }): Promise<ScriptGenerationOutcome> => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Script) return { ok: false, cancelled: true };
            if (isNodeGenerating(nodeId)) return { ok: false, cancelled: true };
            // 三段提示词按**此刻**的词库解析（不再读节点上的旧快照，见 `resolveScriptPromptsOf`）。
            const scriptPrompts = resolveScriptPromptsOf(sourceNode);
            const manualSource = (overrides?.scriptSource ?? sourceNode.metadata?.scriptSource ?? "").trim();
            // 输出格式预设：决定系统提示词、任务书措辞与解析用的列定义（见 constant/story-script.ts）。
            const presetId = resolveStoryScriptPresetId(sourceNode.metadata?.scriptPreset);
            // 每镜时长（5 秒上限 / 10 / 15 秒锁定 / 不限制）：写进任务书，要求模型按这个长度规划镜头。
            // 口径由「视频分段」决定：单镜 = 每镜自己就是 N 秒成片；合并 = 连续几镜合计 N 秒。
            const segmentSeconds = sourceNode.metadata?.scriptSegmentSeconds;
            const mergeMode = resolveStoryScriptMergeMode(sourceNode.metadata?.scriptMergeMode);
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
                return { ok: false, cancelled: true };
            }
            const task = buildStoryScriptTask({
                sourceText,
                prompt: overrides?.scriptPrompt ?? sourceNode.metadata?.scriptPrompt,
                characterRefs,
                preset: presetId,
                segmentSeconds,
                mergeMode,
                // 两路专项自定义要求：资产一套、分镜提示词一套（用户要求分开控制，互不影响）。
                assetPrompt: scriptPrompts.asset,
                shotPrompt: scriptPrompts.shot,
                // 同名资产只在首现镜写全描述 → 输出变短，整表生成更快。
                assetDedupe: true,
            });
            /**
             * 方案 = 第四套（影视分镜导演）时，任务书**末尾**再压一段「`video_motion_prompt` 只能是八段标签块」；
             * 第五套（muse 长视频）压「只能是一整段 10 秒视频脚本」；第六套（鬼怪光影全流程）压
             * 「只能是 `———— 镜头N｜起—止秒` 整段光影脚本」。这三套的 system 来自用户词库 / 技能库，
             * 只说清楚了图像段怎么写、没说这一列放什么；而任务书里还带着第一套的 6 段 / `[时长：Xs]`
             * —— 两头一夹，模型就把八行标签块塞进视频列。任务书末尾 + system 末尾双挂，只挂一处压不住。
             */
            const wholeSchemeId = resolveScriptSchemeId(sourceNode.metadata?.scriptScheme);
            const directorScheme = wholeSchemeId === "director";
            const museScheme = wholeSchemeId === "muse";
            const ghostScheme = wholeSchemeId === "ghost";
            /** 第七套（魔漫 15 秒分镜）：视频列是按时间码分段的 `0.00—1.50：【景别，运镜】…`。 */
            const momanScheme = wholeSchemeId === "moman";
            /** 第八套（麻薯 · 分镜组）：视频列是 `### 【分镜组N】（0—15秒）` + 组级四块 + 组内逐镜块。 */
            const mashuScheme = wholeSchemeId === "mashu";
            const directorFormatHint = buildStoryScriptSchemeFormatHint(sourceNode.metadata?.scriptScheme);
            /**
             * 「成片总时长」（用户 2026-11-09 / 2026-11-11 第 01 条）：反推节点上选的秒数会落到
             * `scriptTotalSeconds`；脚本节点「输入」视图也能直接改同一个键。这里把它压成任务书末尾的
             * 一段硬要求 —— 镜数与台词量都按这个数字来，不再按模型的「一条短片」惯性铺 1 分钟。
             *
             * **没设也照样有默认 30 秒**（`buildScriptTotalSecondsBlockFromMetadata` 内部走
             * `resolveScriptTotalSeconds`）：界面上明明写着 30 秒，就不能让后端当「没限制」处理，
             * 否则又是「设置没生效」。只有用户显式点了「不限制」才返回空串。
             */
            const totalSecondsBlock = buildScriptTotalSecondsBlockFromMetadata(sourceNode.metadata);
            const scriptTask = [directorFormatHint ? `${task}\n\n${directorFormatHint}` : task, totalSecondsBlock].filter(Boolean).join("\n\n");
            /**
             * 用户贴进来的「模版」有两种位置，两种都要「照抄结构」而不是拆成括号链：
             *  ① 源内容本身就是逐镜标签块（`- **首帧图片提示词**：…`）；
             *  ② 「分镜提示词自定义要求」里直接写了一整套字段清单 / 长段范文。
             * 这两种情形都必须把预设 system prompt 里的「8 段 / 6 段 / `[a] + [b]` 链式」**显式作废**——
             * 只在任务书里写「以上不适用」压不住（模型对 system prompt 的服从度更高）。
             */
            const scriptSystemPrompt = resolveScriptSystemPrompt(presetId, scriptPrompts.system, {
                verbatimTemplate: hasStoryScriptShotTemplate(sourceText),
                customShotFormat: hasScriptGenerationPrompt(scriptPrompts.shot),
                // 三套方案通用：第二 / 第三套的 system 是用户词库文本，只能靠这段追加去重规则。
                assetDedupe: true,
                // 第四套：压上「video_motion_prompt 只能是八段标签块」（见 STORY_SCRIPT_DIRECTOR_VIDEO_FORMAT）。
                directorScheme,
                // 第五套：压上「video_motion_prompt 只能是一整段长视频脚本」（见 STORY_SCRIPT_MUSE_VIDEO_FORMAT）。
                museScheme,
                // 第六套：压上「只能是 `———— 镜头N｜起—止秒` 整段光影脚本」（见 STORY_SCRIPT_GHOST_VIDEO_FORMAT）。
                ghostScheme,
                // 第七套：压上「只能是 `0.00—1.50：【景别，运镜】…` 时间码分段」（见 STORY_SCRIPT_MOMAN_VIDEO_FORMAT）。
                momanScheme,
                // 第八套：压上「只能是 `### 【分镜组N】（起—止秒）` + 组级四块 + 组内逐镜块」（见 STORY_SCRIPT_MASHU_VIDEO_FORMAT）。
                mashuScheme,
            });
            const textNode = { ...sourceNode, metadata: { ...sourceNode.metadata, generationMode: "text" as const } };
            const baseTextConfig = buildGenerationConfig(effectiveConfig, textNode, "text");
            /**
             * `overrides.model` = 「一键视频」在分镜表报错后用指定模型（`deepseek-flash(deepseek)`）重跑一次。
             * 只覆盖 `model`：渠道 / baseUrl / apiKey 仍走 `resolveModelRequestConfig` 的统一咽喉，
             * 绝不在这里按「渠道名」手拼。
             */
            const textConfig = overrides?.model ? { ...baseTextConfig, model: overrides.model } : baseTextConfig;
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return { ok: false, cancelled: true };
            }
            const controller = new AbortController();
            startGenerationRequest(nodeId, nodeId, nodeId, controller);
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "loading", scriptRaw: "", errorDetails: undefined } } : node)));
            try {
                // 连线参考图作为多模态输入喂给视觉模型；hydrate 会把画布资源转成可发送的 dataUrl。
                const hydrated = context.referenceImages.length ? await hydrateNodeGenerationContext(context) : context;
                const userContent: AiTextMessage["content"] = hydrated.referenceImages.length
                    ? [{ type: "text" as const, text: scriptTask }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                    : scriptTask;
                const answer = await requestImageQuestion(
                    textConfig,
                    [
                        { role: "system", content: scriptSystemPrompt },
                        { role: "user", content: userContent },
                    ],
                    (streamed) => setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptRaw: streamed } } : node))),
                    { signal: controller.signal },
                );
                if (controller.signal.aborted) return { ok: false, cancelled: true };
                let parsed = parseStoryScriptOutput(answer, presetId);
                let lastAnswer = answer;
                /**
                 * 模型反问而不是出表（`{ rows: [], clarification: "…" }`）时**自动重试一次**。
                 * 2026-11-05 实样：源稿 31 镜、任务书却硬写「必须 19 行」，模型判定冲突 →
                 * 每点一次都弹同一句「生成失败」。根因（模版误判 / 镜号重复）已在任务书侧修掉，
                 * 这里再加一层「压死反问」的保险：第二遍直接在末尾命令它按源稿出表。
                 */
                if (!parsed.ok && parsed.needsClarification) {
                    const retryTask = `${scriptTask}\n\n⚠️ 不要再反问、不要再要求确认：直接按源内容的实际镜头输出完整表格（JSON 的 \`rows\` 数组，\`shot_no\` 从 1 起连续递增），把这一句疑问写进 \`title\` 尾部。`;
                    const retryContent: AiTextMessage["content"] = hydrated.referenceImages.length
                        ? [{ type: "text" as const, text: retryTask }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                        : retryTask;
                    const retried = await requestImageQuestion(
                        textConfig,
                        [
                            { role: "system", content: scriptSystemPrompt },
                            { role: "user", content: retryContent },
                        ],
                        (streamed) => setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptRaw: streamed } } : node))),
                        { signal: controller.signal },
                    );
                    if (controller.signal.aborted) return { ok: false, cancelled: true };
                    lastAnswer = retried;
                    parsed = parseStoryScriptOutput(retried, presetId);
                }
                if (!parsed.ok) {
                    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: parsed.error, scriptRaw: lastAnswer } } : node)));
                    message.error(t("canvas.scriptNode.parseFailed"));
                    return { ok: false, error: parsed.error || t("canvas.scriptNode.parseFailed") };
                }
                /**
                 * 源内容是「逐镜标签模版」时，三列提示词以**模版原文**为准（模型照搬的执行率不是 100%，
                 * 而用户要的是贴什么填什么）。资产描述类列不在覆盖范围内 —— 仍由模型按「资产部分自定义要求」
                 * 生成，这样「三列照搬」就不会把资产提示词一起打空。没识别到模版时原样返回。
                 */
                const parsedRows = applyStoryScriptTemplateOverlay(parsed.rows, sourceText, presetId);
                /**
                 * 资产描述去重兜底：system 里已经要求「同名资产只在首现镜写全」，但模型不一定 100% 服从
                 * （第二 / 第三套方案尤其如此）。这里再按名字归一化清一遍重复描述 —— 名字列不动，
                 * 所以图位 / 资产锁 / 铺链路不受影响；描述为空的行，表格会给「（同第 N 镜）」占位，
                 * 逐格「AI 生成」也会回填首现镜的描述（`findStoryScriptAssetDescription`）。幂等。
                 */
                /**
                 * 出场角色兜底（用户 2026-11-08 第 15 条）：「5 人一起合拍，分镜表只认说话的那 2 个人」。
                 *
                 * 提示词侧已经写了硬规则（`STORY_SCRIPT_CAST_COMPLETENESS_HINT` + system 里的
                 * `## Character consistency`），但模型仍会漏 —— 这里用一条**不会瞎编**的确定性规则补：
                 * 只要这个人的名字在**本镜自己的画面描述 / 分镜提示词 / 动作 / 站位**里字面出现过
                 * （`dialogue` 不算：「苏晚呢？」提到的人不一定在画里），而角色列里没有他，就补进去。
                 * 顺带把「场景列为空」的镜头沿用上一个镜头的场景名（同场次连续镜头不该丢场景）。
                 *
                 * 第 17 条起把**源剧本自己的段头**也喂进去（`sourceText`）：
                 * `【场景】…/【人物】…/【道具】…` 是作者写死的这一段 15 秒的资产清单 —— 这一段拆成 3 镜，
                 * 每镜都得有这些人 / 这个场景 / 这些道具，不再靠模型「记不记得」。
                 */
                const castRows = backfillStoryScriptCastNames(parsedRows, presetId, { sourceText });
                const dedupedRows = dedupeStoryScriptAssetDescriptions(castRows.rows, presetId);
                /**
                 * 第四套方案：把 `video_motion_prompt` 确定性收敛成八段标签块。
                 * 模版在场时上面那层覆盖已经给了逐字原文（本函数幂等，合规就一个字都不动）；
                 * 模版不在场（用户只贴剧本）时，模型经常把图像段塞进视频列 → 这里按行内各列重新组装，
                 * 保证表格里看到的永远是 `- **时长：**…` 那种八行块，而不是「像拼出来的」一段话。
                 *
                 * 第五套（muse）：反过来 —— 这一列的**唯一合法形态是整段长视频脚本**
                 * （`### 视频一（10秒）` + 参考生视频 / 共享环境与光线 / 时间轴 / Negative prompt；
                 * 这一套是参考生视频、已给设定图，所以没有 `角色设定：` 段）。
                 * 模型不听话时吐了八段标签块，就在这里按语义槽重组成整段脚本。
                 * 第六套（ghost）：这一列要 `———— 镜头N｜起—止秒` 的整段光影脚本 —— 源内容里
                 * 贴了用户那份全片分镜时按镜号整段填入；没有就保留模型按格式段生成的内容。
                 * 三套互斥：第四套要标签块、第五 / 六套要整段，绝不能同时跑。
                 */
                const finalRows = directorScheme
                    ? normalizeStoryScriptDirectorRows(dedupedRows, presetId)
                    : museScheme
                      ? normalizeStoryScriptMuseRows(applyMuseVideoScriptOverlay(dedupedRows, sourceText, presetId), presetId)
                      : ghostScheme
                        ? normalizeStoryScriptGhostRows(applyGhostVideoScriptOverlay(dedupedRows, sourceText, presetId), presetId)
                        : momanScheme
                          ? normalizeStoryScriptMomanRows(applyMomanVideoScriptOverlay(dedupedRows, sourceText, presetId), presetId)
                          : mashuScheme
                            ? normalizeStoryScriptMashuRows(applyMashuVideoScriptOverlay(dedupedRows, sourceText, presetId), presetId)
                            : dedupedRows;
                /**
                 * 把「认没认出模版」这件事**明说出来**：以前三列为空时用户只能猜
                 * （「是没识别到，还是模型没生成？」），日志和 UI 都没有证据。
                 */
                const templateShots = countStoryScriptTemplateShots(sourceText);
                /**
                 * 落库这段抽成具名函数，是为了**顺手同步 `nodesRef`**：
                 * `nodesRef` 只在 `useLayoutEffect` 里跟 `nodes` 对齐，而「一键视频」拿到
                 * `runScriptGeneration()` 的返回值后**立刻**就要读分镜表行数去开生图 ——
                 * 那一刻 React 很可能还没提交最后一次 `setNodes`，读到的是上一版（甚至是空的 0 行），
                 * 于是整条自动化会在「分镜表是空的」上误暂停。与其它建节点的地方同一口径：先写 ref 再 setState。
                 */
                const applyGeneratedRows = (node: CanvasNodeData): CanvasNodeData => {
                    if (node.id !== nodeId) return node;
                    // 整表重生成会把行整体换掉，但**自建资产列是用户手填的**（模型不知道这几列）：
                    // 按镜号把旧值回填回来，别让一次「重新生成整表」把「宠物 / 车辆」全抹掉。
                    const extraKeys = normalizeStoryScriptExtraColumns(node.metadata?.scriptExtraColumns).map((item) => item.key);
                    const previousRows = node.metadata?.scriptRows || [];
                    const rowsWithExtras = extraKeys.length
                        ? finalRows.map((row, index) => {
                              const previous = previousRows.find((item, position) => (Number(item.shot_no) || position + 1) === (Number(row.shot_no) || index + 1));
                              if (!previous) return row;
                              const next = { ...row };
                              for (const key of extraKeys) {
                                  const kept = previous[key];
                                  if (kept !== undefined) next[key] = kept;
                              }
                              return next;
                          })
                        : finalRows;
                    return {
                        ...node,
                        title: parsed.title || node.title,
                        metadata: { ...node.metadata, scriptStatus: "success", scriptRows: rowsWithExtras, scriptTitle: parsed.title, scriptRaw: answer, errorDetails: undefined },
                    };
                };
                nodesRef.current = nodesRef.current.map(applyGeneratedRows);
                setNodes((prev) => prev.map(applyGeneratedRows));
                message.success(t("canvas.scriptNode.generated", { count: parsedRows.length }));
                /**
                 * 「补了几镜的出场角色 / 场景 / 道具」也要明说（2026-11-08 第 15/17 条）：补人是有可能补错的
                 * 判断（模型没写全、我们按剧本段头与画面文字补的），用户得知道有这回事才能顺手复核。
                 * ⚠️ 触发条件带上 `propFilled`：段头【道具】被补进表格同样是「模型漏了资产」，只判 `filled`
                 * 时「人齐了但道具全空」这种最常见的漏法一声不响。场景沿用属常规兜底（几乎每次都发生），
                 * 不单独弹窗，只在文案里报个数。
                 */
                if (castRows.filled > 0 || castRows.propFilled > 0) {
                    message.info(
                        t("canvas.scriptNode.castBackfilled", {
                            count: castRows.filled,
                            scene: castRows.sceneFilled,
                            prop: castRows.propFilled,
                        }),
                    );
                }
                /**
                 * 第七套：「源稿覆盖」这件事要**明说**。前六次报障里有一半是「其实没识别到源稿」
                 * ——覆盖层静默返回原表，视频列留着模型自编的一段（形态一样、时间码不一样），
                 * 用户只能看到结果不对，不知道是没识别到还是识别错了。
                 */
                if (momanScheme) {
                    const momanInfo = describeMomanSourceOverlay(sourceText);
                    if (momanInfo.kind === "none") {
                        message.warning(t("canvas.scriptNode.momanSourceMissing"));
                    } else if (momanInfo.records < finalRows.length) {
                        message.info(
                            t("canvas.scriptNode.momanSourcePartial", {
                                count: momanInfo.records,
                                total: finalRows.length,
                                rest: finalRows.length - momanInfo.records,
                            }),
                        );
                    } else {
                        message.info(t("canvas.scriptNode.momanSourceApplied", { count: momanInfo.records }));
                    }
                }
                if (templateShots) {
                    message.info(t("canvas.scriptNode.templateApplied", { count: templateShots }));
                    /**
                     * 镜数对不上要**当场说**（用户 03：「镜头数量请识别这个内容下的，即为 9 个镜头」）。
                     * 任务书里已经把镜数写死了，但模型仍可能少吐 / 多吐；这时覆盖层只能按顺序盖前 N 块，
                     * 用户看到的却是「明明有 9 镜，表里只有 7 行」却不知道为什么。给个可操作的提示。
                     */
                    if (parsedRows.length !== templateShots) {
                        message.warning(t("canvas.scriptNode.templateShotCountMismatch", { expected: templateShots, actual: parsedRows.length }));
                    }
                }
                // 成功：把行数一起交出去，编排层据此判断「分镜表真的出来了」再往下走生图。
                return { ok: true, rows: finalRows.length };
            } catch (error) {
                if (controller.signal.aborted) return { ok: false, cancelled: true };
                const detail = error instanceof Error ? error.message : String(error);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: detail } } : node)));
                message.error(detail);
                return { ok: false, error: detail };
            } finally {
                finishGenerationRequest(nodeId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNodeGenerating, message, openConfigDialog, resolveScriptPromptsOf, startGenerationRequest, t],
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
    //
    // 支持三件事（用户诉求）：
    //  1) **批量**：一次传多个行号，逐镜串行重写（串行才能让后一镜看到前一镜刚改完的站位）；
    //  2) **单独加剧情**：`options.extraPlot` 只作用在这一批镜上，任务书里是独立一段；
    //  3) **站位一致性开关**：`options.keepBlocking === false` 时明确允许人物站位重排。
    const runScriptShotGeneration = useCallback(
        async (nodeId: string, rowIndexes: number | number[], options?: { extraPlot?: string; keepBlocking?: boolean }) => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Script) return;
            if (isNodeGenerating(nodeId)) return;
            // 三段提示词按**此刻**的词库解析（与整表生成同一口径，见 `resolveScriptPromptsOf`）。
            const scriptPrompts = resolveScriptPromptsOf(sourceNode);
            const sourceRows = sourceNode.metadata?.scriptRows || [];
            const indexes = (Array.isArray(rowIndexes) ? rowIndexes : [rowIndexes])
                .filter((index) => Number.isInteger(index) && index >= 0 && index < sourceRows.length)
                .filter((index, position, list) => list.indexOf(index) === position)
                .sort((left, right) => left - right);
            if (!indexes.length) return;
            const presetId = resolveStoryScriptPresetId(sourceNode.metadata?.scriptPreset);
            /**
             * 手动追加的资产列（「宠物」「车辆」…）：模型不知道这几列，重写这一镜时**按原值回填**，
             * 否则一次重生成就会把用户手填的资产名抹掉（自建列的图位还在，但格子空了）。
             */
            const scriptExtraKeys = normalizeStoryScriptExtraColumns(sourceNode.metadata?.scriptExtraColumns).map((item) => item.key);
            const segmentSeconds = sourceNode.metadata?.scriptSegmentSeconds;
            // 与整表生成同一口径：单镜 = 这一镜就是 N 秒成片，重写时 duration 必须锁成 N。
            const mergeMode = resolveStoryScriptMergeMode(sourceNode.metadata?.scriptMergeMode);
            const context = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, "");
            const sourceText = (sourceNode.metadata?.scriptSource || "").trim() || context.prompt.trim();
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(sourceNode.metadata?.scriptAssetRoles?.[assetNodeId]);
            const characterRefs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current)
                .filter((input) => input.type === "image" && assetRoleOf(input.nodeId) === "character")
                .map((input) => input.title.trim())
                .filter(Boolean)
                .join("、");
            /**
             * 与整表生成同一口径：第四套（影视分镜导演）的 `video_motion_prompt` 只能是八段标签块，
             * 第五套（muse 长视频）只能是一整段 10 秒视频脚本，第六套（鬼怪光影全流程）只能是
             * `———— 镜头N｜起—止秒` 整段光影脚本。
             * 单镜重跑也必须挂 —— 只挂整表的话，用户点一次「重新生成这一镜」格式就退回图像段。
             */
            const schemeId = resolveScriptSchemeId(sourceNode.metadata?.scriptScheme);
            const directorScheme = schemeId === "director";
            const museScheme = schemeId === "muse";
            const ghostScheme = schemeId === "ghost";
            /** 第七套（魔漫）：单镜的 `video_motion_prompt` 也是 `0.00—1.50：【景别，运镜】…` 时间码分段。 */
            const momanScheme = schemeId === "moman";
            /** 第八套（麻薯）：单镜的 `video_motion_prompt` 是 `### 【分镜组N】（0—15秒）` + 组内逐镜块。 */
            const mashuScheme = schemeId === "mashu";
            const directorFormatHint = buildStoryScriptSchemeFormatHint(sourceNode.metadata?.scriptScheme);
            const extraPlot = (options?.extraPlot || "").trim();
            // 默认保持站位一致（= 改造前的行为）；只有显式传 false 才放开。
            const keepBlocking = options?.keepBlocking !== false;
            const textNode = { ...sourceNode, metadata: { ...sourceNode.metadata, generationMode: "text" as const } };
            const textConfig = buildGenerationConfig(effectiveConfig, textNode, "text");
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const controller = new AbortController();
            startGenerationRequest(nodeId, nodeId, nodeId, controller);
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "loading", errorDetails: undefined } } : node)));
            const batch = indexes.length > 1;
            try {
                const hydrated = context.referenceImages.length ? await hydrateNodeGenerationContext(context) : context;
                // 与整表生成同一口径：模版 / 自定义分镜提示词在场 → system prompt 侧作废链式写法。
                const systemPrompt = resolveScriptSystemPrompt(presetId, scriptPrompts.system, {
                    verbatimTemplate: hasStoryScriptShotTemplate(sourceText),
                    customShotFormat: hasScriptGenerationPrompt(scriptPrompts.shot),
                    // 单镜重生成：覆盖段要说「只要这一镜」，否则会和「一模版一块」自相矛盾。
                    singleShot: true,
                    // 与整表生成同一口径：同名资产只在首现镜写全描述。
                    assetDedupe: true,
                    // 与整表生成同一口径：第四套的视频列只能是八段标签块。
                    directorScheme,
                    // 与整表生成同一口径：第五套的视频列只能是一整段长视频脚本。
                    museScheme,
                    // 与整表生成同一口径：第六套的视频列只能是 `———— 镜头N｜起—止秒` 整段光影脚本。
                    ghostScheme,
                    // 与整表生成同一口径：第七套的视频列只能是 `0.00—1.50：【景别，运镜】…` 时间码分段。
                    momanScheme,
                    // 与整表生成同一口径：第八套的视频列只能是 `### 【分镜组N】（0—15秒）` 分镜组脚本。
                    mashuScheme,
                });
                // 逐镜串行：每改完一镜就写回，下一镜的 prev / next 读到的就是刚改完的版本。
                let workingRows = [...sourceRows];
                let done = 0;
                let lastError = "";
                for (const rowIndex of indexes) {
                    if (controller.signal.aborted) return;
                    const row = workingRows[rowIndex];
                    if (!row) continue;
                    const task = buildStoryScriptRowTask({
                        preset: presetId,
                        sourceText,
                        prompt: sourceNode.metadata?.scriptPrompt,
                        row,
                        prev: rowIndex > 0 ? workingRows[rowIndex - 1] : undefined,
                        next: rowIndex < workingRows.length - 1 ? workingRows[rowIndex + 1] : undefined,
                        characterRefs,
                        segmentSeconds,
                        mergeMode,
                        extraPlot: extraPlot || undefined,
                        keepBlocking,
                        assetPrompt: scriptPrompts.asset,
                        shotPrompt: scriptPrompts.shot,
                    });
                    // 第四套：单镜任务书末尾同样压「video_motion_prompt 只能是八段标签块」。
                    const rowTask = directorFormatHint ? `${task}\n\n${directorFormatHint}` : task;
                    const userContent: AiTextMessage["content"] = hydrated.referenceImages.length
                        ? [{ type: "text" as const, text: rowTask }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                        : rowTask;
                    let answer = await requestImageQuestion(
                        textConfig,
                        [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userContent },
                        ],
                        () => {},
                        { signal: controller.signal },
                    );
                    if (controller.signal.aborted) return;
                    let parsed = parseStoryScriptOutput(answer, presetId);
                    // 模型反问而不是出表 → 压死一次「直接按内容写这一镜」，与整表路径同口径。
                    if (!parsed.ok && parsed.needsClarification) {
                        const retryTask = `${rowTask}\n\n⚠️ 不要再反问、不要再要求确认：直接按下面的内容写这一镜（JSON \`rows\` 里只放 1 个元素）。`;
                        const retryContent: AiTextMessage["content"] = hydrated.referenceImages.length
                            ? [{ type: "text" as const, text: retryTask }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                            : retryTask;
                        answer = await requestImageQuestion(
                            textConfig,
                            [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: retryContent },
                            ],
                            () => {},
                            { signal: controller.signal },
                        );
                        if (controller.signal.aborted) return;
                        parsed = parseStoryScriptOutput(answer, presetId);
                    }
                    if (!parsed.ok || !parsed.rows.length) {
                        lastError = parsed.ok ? "模型未返回这一镜" : parsed.error;
                        // 批量里某一镜失败不该把整批带崩 —— 记下错误，继续下一镜。
                        if (!batch) {
                            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: lastError } } : node)));
                            message.error(t("canvas.scriptNode.parseFailed"));
                            return;
                        }
                        continue;
                    }
                    // 行位置与镜号以原表为准；重写结果只覆盖这一行的各列内容。
                    const shotNo = row.shot_no || rowIndex + 1;
                    /**
                     * 模版覆盖（与整表生成同一口径）：源内容是逐镜模版时，这一镜的三列提示词 / 资产名 /
                     * 时长仍以模版原文为准 —— 只按镜号精确匹配，模版里没有这一镜就不动。
                     * 少了这一步，用户点一次「重生成这一镜」，视频运动提示词就退回模型自己写的图像段
                     * （2026-10-24 用户反馈：「第 4 套的视频运动提示词还是这样」）。
                     */
                    const rewritten: typeof row = applyStoryScriptTemplateOverlayToShot({ ...parsed.rows[0], shot_no: shotNo }, sourceText, presetId);
                    // 自建资产列按原值回填（见上面 scriptExtraKeys 的说明）。
                    for (const extraKey of scriptExtraKeys) {
                        const kept = row[extraKey];
                        if (kept !== undefined) rewritten[extraKey] = kept;
                    }
                    workingRows = workingRows.map((item, index) => (index === rowIndex ? rewritten : item));
                    /**
                     * 第四套：把这一镜的 `video_motion_prompt` 收敛成八段标签块（时间码按整表累加算，
                     * 所以要看整张表）。**只替换刚重写的那一行** —— 其它行是用户已经在用的内容，不碰。
                     */
                    if (directorScheme) {
                        const normalizedRows = normalizeStoryScriptDirectorRows(workingRows, presetId);
                        workingRows = workingRows.map((item, index) => (index === rowIndex ? normalizedRows[index] : item));
                    }
                    /**
                     * 第五套：反过来 —— 这一列要的是**整段长视频脚本**；模型吐了八段标签块就重组成整段。
                     * 与第四套互斥，同样只替换刚重写的那一行。
                     */
                    if (museScheme) {
                        const overlaid = applyMuseVideoScriptOverlay(workingRows, sourceText, presetId);
                        const normalizedRows = normalizeStoryScriptMuseRows(overlaid, presetId);
                        workingRows = workingRows.map((item, index) => (index === rowIndex ? normalizedRows[index] : item));
                    }
                    /**
                     * 第六套：这一列的合法形态是 `———— 镜头N｜起—止秒` 整段光影脚本 ——
                     * 源内容里有就按镜号整段填进来，同样只替换刚重写的那一行。
                     */
                    if (ghostScheme) {
                        const overlaid = applyGhostVideoScriptOverlay(workingRows, sourceText, presetId);
                        const normalizedRows = normalizeStoryScriptGhostRows(overlaid, presetId);
                        workingRows = workingRows.map((item, index) => (index === rowIndex ? normalizedRows[index] : item));
                    }
                    /**
                     * 第七套（魔漫）：源内容里贴了 storyboard JSON 时，这一列按 `prompt` **逐字照搬**
                     * （模型自己另编的那段形态对、内容错）；随后再收敛成时间码分段 ——
                     * 压成一行 / 塞了整格 JSON / 写错到分镜列，都在 normalize 里处理。
                     * 同样只替换刚重写的那一行。
                     */
                    if (momanScheme) {
                        const overlaid = applyMomanVideoScriptOverlay(workingRows, sourceText, presetId);
                        const normalizedRows = normalizeStoryScriptMomanRows(overlaid, presetId);
                        workingRows = workingRows.map((item, index) => (index === rowIndex ? normalizedRows[index] : item));
                    }
                    /**
                     * 第八套（麻薯 · 分镜组）：这一列的合法形态是 `### 【分镜组N】（0—15秒）` + 组级四块 +
                     * 组内逐镜块。压成一行 / 塞了整格 JSON / 写错到分镜列都在这里收敛。
                     */
                    if (mashuScheme) {
                        /**
                         * 与整表路径**同一个组合**（`applyMashuVideoScriptOverlay` → `normalizeStoryScriptMashuRows`）：
                         * 源内容里贴了整套分镜组时，按镜号整段回填这一行 —— 单镜重写时模型最容易只写一句概括
                         * （用户 2026-11-11 第 02 条：「有几个镜头的视频运动提示词是空的，或者内容很少」），
                         * 而源稿里明明有现成的完整分镜组。以前这里只跑 normalize（没有 overlay），
                         * 于是整表重生成能补上、单镜重生成补不上。
                         */
                        const overlaid = applyMashuVideoScriptOverlay(workingRows, sourceText, presetId);
                        const normalizedRows = normalizeStoryScriptMashuRows(overlaid, presetId);
                        workingRows = workingRows.map((item, index) => (index === rowIndex ? normalizedRows[index] : item));
                    }
                    // 单镜重写常把「后面几镜」的描述又写全了（模型看不到整表已经去重过）——
                    // 这里再跑一遍幂等去重，保证「首现镜写全、其余留空」在单镜改动后依然成立。
                    // 出场角色同口径兜底（单镜重写最容易只留说话的人；段头名单一并喂进去）。
                    workingRows = dedupeStoryScriptAssetDescriptions(backfillStoryScriptCastNames(workingRows, presetId, { sourceText }).rows, presetId);
                    done += 1;
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "loading", scriptRows: workingRows, scriptRaw: storyScriptToMarkdown(workingRows, node.metadata?.scriptTitle, presetId) } } : node)),
                    );
                }
                if (!done) {
                    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: lastError || t("canvas.scriptNode.regenFailed") } } : node)));
                    message.error(lastError || t("canvas.scriptNode.regenFailed"));
                    return;
                }
                // 「加剧情重生成」的剧情顺手记到这一镜上（`metadata.scriptRowNotes`）：表里能看到这一镜
                // 是按什么要求改的，下次再点重生成还能沿用 / 微调，不用重新打一遍。
                let nextNotes = sourceNode.metadata?.scriptRowNotes;
                if (extraPlot) {
                    for (const rowIndex of indexes) nextNotes = setStoryScriptRowNote(nextNotes, sourceRows[rowIndex]?.shot_no ?? rowIndex + 1, extraPlot);
                }
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      scriptStatus: "success",
                                      scriptRows: workingRows,
                                      scriptRaw: storyScriptToMarkdown(workingRows, node.metadata?.scriptTitle, presetId),
                                      ...(nextNotes ? { scriptRowNotes: nextNotes } : {}),
                                      errorDetails: lastError || undefined,
                                  },
                              }
                            : node,
                    ),
                );
                if (batch) message.success(t("canvas.scriptNode.regenRowsDone", { count: done }));
                else message.success(t("canvas.scriptNode.regenShotDone", { no: sourceRows[indexes[0]]?.shot_no || indexes[0] + 1 }));
                if (batch && lastError) message.warning(t("canvas.scriptNode.regenRowsPartial", { count: done }));
            } catch (error) {
                if (controller.signal.aborted) return;
                const detail = error instanceof Error ? error.message : String(error);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, scriptStatus: "error", errorDetails: detail } } : node)));
                message.error(detail);
            } finally {
                finishGenerationRequest(nodeId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNodeGenerating, message, openConfigDialog, resolveScriptPromptsOf, startGenerationRequest, t],
    );

    // 二次识别「补缺失资产」：只让模型补**空着的资产列**，已有内容一个字都不改
    //（见 buildStoryScriptAssetFillTask / mergeStoryScriptAssetFill）。用户已满意的画面 / 提示词不会被顺手重写。
    //
    // 单镜（行内 Sparkles）和整表（底部「补齐资产」）走**同一个入口**：传数组就逐镜串行补，
    // 每补完一镜立刻写回（中途失败已完成的不会丢），单镜失败不中断整批，最后只弹一条汇总提示。
    const runScriptAssetFill = useCallback(
        async (nodeId: string, rowIndexes: number | number[]) => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Script) return;
            if (isNodeGenerating(nodeId)) return;
            // 补资产描述用的两段也按**此刻**的词库解析（同 `resolveScriptPromptsOf`），
            // 否则词库改了「资产提取 / 最佳拍档」这两条，补出来的角色 / 场景还是老口径。
            const scriptPrompts = resolveScriptPromptsOf(sourceNode);
            const rows = sourceNode.metadata?.scriptRows || [];
            const indexes = (Array.isArray(rowIndexes) ? rowIndexes : [rowIndexes])
                .filter((index) => Number.isInteger(index) && index >= 0 && index < rows.length)
                .filter((index, position, list) => list.indexOf(index) === position)
                .sort((left, right) => left - right);
            if (!indexes.length) return;
            const presetId = resolveStoryScriptPresetId(sourceNode.metadata?.scriptPreset);
            // 自建资产列也参与「补资产」（任务书里按列名让模型补这一格）。
            const extras = normalizeStoryScriptExtraColumns(sourceNode.metadata?.scriptExtraColumns);
            const columns = getStoryScriptColumnsWithExtras(presetId, extras);
            const batch = indexes.length > 1;
            // 整表补齐时大部分镜可能是完整的 —— 只对真缺列的镜发请求（省时间也省额度）。
            const pending = indexes.filter((index) => collectStoryScriptAssetFillTargets(presetId, rows[index], extras).length);
            if (!pending.length) {
                message.info(t("canvas.scriptNode.assetFillNothing"));
                return;
            }
            const context = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, "");
            const sourceText = (sourceNode.metadata?.scriptSource || "").trim() || context.prompt.trim();
            const textNode = { ...sourceNode, metadata: { ...sourceNode.metadata, generationMode: "text" as const } };
            const textConfig = buildGenerationConfig(effectiveConfig, textNode, "text");
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const controller = new AbortController();
            startGenerationRequest(nodeId, nodeId, nodeId, controller);
            let workingRows = [...rows];
            let filledRowCount = 0;
            let filledColumnCount = 0;
            let lastError = "";
            try {
                const hydrated = context.referenceImages.length ? await hydrateNodeGenerationContext(context) : context;
                const writeRows = (nextRows: typeof workingRows) => {
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId
                                ? {
                                      ...node,
                                      metadata: {
                                          ...node.metadata,
                                          scriptRows: nextRows,
                                          scriptRaw: storyScriptToMarkdown(nextRows, node.metadata?.scriptTitle, presetId),
                                          errorDetails: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                };
                for (const rowIndex of pending) {
                    if (controller.signal.aborted) return;
                    const row = workingRows[rowIndex];
                    if (!row) continue;
                    // 每镜都重新算一次 targets：上一镜的补写不会影响这一镜，但这样可以跳过被并发改空的情况。
                    const targets = collectStoryScriptAssetFillTargets(presetId, row, extras);
                    if (!targets.length) continue;
                    try {
                        const task = buildStoryScriptAssetFillTask({ preset: presetId, sourceText, row, targets, extras, assetPrompt: scriptPrompts.asset });
                        const userContent: AiTextMessage["content"] = hydrated.referenceImages.length
                            ? [{ type: "text" as const, text: task }, ...hydrated.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
                            : task;
                        const answer = await requestImageQuestion(
                            textConfig,
                            [
                                { role: "system", content: resolveScriptSystemPrompt(presetId, scriptPrompts.system) },
                                { role: "user", content: userContent },
                            ],
                            () => {},
                            { signal: controller.signal },
                        );
                        if (controller.signal.aborted) return;
                        const parsed = parseStoryScriptOutput(answer, presetId);
                        // 补资产的回答是「单个对象 / 单行 JSON」——解析器照样能认（裸对象也算一行）。
                        const patch = parsed.ok ? parsed.rows[0] : undefined;
                        const merged = mergeStoryScriptAssetFill(row, patch, columns);
                        const filledKeys = Object.keys(merged).filter((key) => columns.some((column) => column.key === key) && String(merged[key] ?? "") !== String(row[key] ?? ""));
                        if (!filledKeys.length) continue;
                        workingRows = workingRows.map((item, index) => (index === rowIndex ? merged : item));
                        filledRowCount += 1;
                        filledColumnCount += filledKeys.length;
                        writeRows(workingRows);
                    } catch (error) {
                        if (controller.signal.aborted) return;
                        lastError = error instanceof Error ? error.message : String(error);
                    }
                }
                if (!filledRowCount) {
                    message.warning(lastError || t("canvas.scriptNode.assetFillNothing"));
                    return;
                }
                if (batch) message.success(t("canvas.scriptNode.assetFillAllDone", { rows: filledRowCount, count: filledColumnCount }));
                else message.success(t("canvas.scriptNode.assetFillDone", { count: filledColumnCount }));
                if (lastError) message.warning(t("canvas.scriptNode.assetFillPartialNote"));
            } catch (error) {
                if (controller.signal.aborted) return;
                const detail = error instanceof Error ? error.message : String(error);
                message.error(detail);
            } finally {
                finishGenerationRequest(nodeId, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, isNodeGenerating, message, openConfigDialog, resolveScriptPromptsOf, startGenerationRequest, t],
    );

    /** 整表补齐资产：把还有缺列的镜头一次补完（逐镜串行，跳过不缺的）。 */
    const runScriptAssetFillAll = useCallback(
        (nodeId: string) => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            if (!sourceNode || sourceNode.type !== CanvasNodeType.Script) return;
            const rows = sourceNode.metadata?.scriptRows || [];
            const presetId = resolveStoryScriptPresetId(sourceNode.metadata?.scriptPreset);
            const extras = normalizeStoryScriptExtraColumns(sourceNode.metadata?.scriptExtraColumns);
            const indexes = rows.map((row, index) => (collectStoryScriptAssetFillTargets(presetId, row, extras).length ? index : -1)).filter((index) => index >= 0);
            if (!indexes.length) {
                message.info(t("canvas.scriptNode.assetFillNothing"));
                return;
            }
            void runScriptAssetFill(nodeId, indexes);
        },
        [message, runScriptAssetFill, t],
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

    // 画布上**全部**音频节点：分镜表「声音」列用它显示文件名，弹窗里也用它做勾选列表。
    // `previewUrl` 塞的是音频本身的可播放地址（表里的试听按钮直接用它，见内容组件的 `toggleAudioPreview`）。
    // 不按「有没有 content」过滤：节点刚建好还没上传完时也要能在表里看到名字。
    const scriptAudioCacheRef = useRef<{ nodes: CanvasNodeData[]; list: ScriptAssetCandidate[] } | null>(null);
    const getScriptAudioCandidates = useCallback(() => {
        const cache = scriptAudioCacheRef.current;
        if (cache && cache.nodes === nodes) return cache.list;
        const list = nodes.filter((node) => node.type === CanvasNodeType.Audio).map((node): ScriptAssetCandidate => ({ id: node.id, title: node.title, kind: "audio", previewUrl: node.metadata?.content || undefined }));
        scriptAudioCacheRef.current = { nodes, list };
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
            const k = mode === "fit" ? Math.min(Math.max(Math.min((size.width - padding * 2) / groupWidth, (size.height - padding * 2) / groupHeight), 0.05), 1.2) : Math.min(Math.max(viewportRef.current.k, 0.4), 1.2);
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
        (nodeId: string, role: ScriptAssetRole, prompt: string, title: string, styleTemplateId?: string, size?: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const scene = prompt.trim();
            if (!source || !scene) return;
            const assetTitle = title.trim() || scene.slice(0, 24);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            // 生图比例（弹窗里选的 9:16 / 16:9…）：写进 `metadata.size`（生图链路读它），
            // 同时把节点画成对应画幅 —— 否则画布上还是正方形，用户看不出自己选的比例生效了。
            const imageSize = resolveStoryScriptImageSize(size) || resolveStoryScriptImageSize(source.metadata?.scriptImageSize);
            const dims = nodeSizeFromRatio(imageSize, spec.width, spec.height) || { width: spec.width, height: spec.height };
            // 弹窗里挑的风格直接落到新图片节点上；**没挑就跟随脚本节点上那档**（用户 2026-11-08 第 04 条）。
            // 生图链路读的是节点自己的 metadata.styleTemplateId，之后在节点上的风格选择器里还能改。
            const nodeStyleTemplateId = styleTemplateId || source.metadata?.styleTemplateId;
            // 画质：全局没选具体档位（空 / auto）时**按 2K 出**，避免掉回 1K（见 `resolveScriptImageQuality`）。
            const qualityFallback = resolveScriptImageQuality(effectiveConfig.quality);
            const node = createCanvasNode(
                CanvasNodeType.Image,
                { x: 0, y: 0 },
                { prompt: scene, status: NODE_STATUS_IDLE, ...(imageSize ? { size: imageSize } : {}), ...(qualityFallback ? { quality: qualityFallback } : {}), ...(nodeStyleTemplateId ? { styleTemplateId: nodeStyleTemplateId } : {}) },
            );
            const placed = attachScriptAssets(source, [{ node: { ...node, title: assetTitle }, width: dims.width, height: dims.height }]);
            const created = placed[0];
            if (!created) return;
            // 分类写进脚本节点（内联：mergeScriptAssetRoles 声明在本回调之后，进依赖数组会 TDZ）。
            const withRole = (item: CanvasNodeData) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptAssetRoles: { ...(item.metadata?.scriptAssetRoles || {}), [created.id]: role } } } : item);
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

    /**
     * 一键批量生成资产图：把弹窗里勾好的角色 / 场景 / 道具一次铺成图片节点，再逐张触发生图。
     *
     * 只有四点和单张不同，且都用 `lib/canvas/script-asset-batch.ts` 的口径，别在组件里另算：
     *  ① **摆位**：贴脚本节点**左侧**排成一片（右边缘距脚本左边缘 48px，竖向排在脚本窗口高度里、
     *     塞不下往左开新列，最多 3 列，整块以脚本窗口垂直中线为中心）—— 用户 2026-11-08 口径：
     *     「紧挨着左侧边框，最多间隔一个图片窗口节点的间距」，不再是一列往脚本下方拖长尾；
     *  ② **模型**：默认取「配置偏好 → 默认模型 → 默认生图模型」；只有用户在弹窗里改过模型栏才写进
     *     每张图的 `metadata.model`（没改就不写 = 继续跟随偏好，以后改偏好这批也跟得上）；
     *  ③ **挂载**：每张图直接写回它那条资产出现过的**每一格**（`scriptCellAssets`）并按资产名上锁
     *     （`scriptNameLocks`）—— 用户原话「批量生成的图也需要直接挂载到具体的资产上」；
     *  ④ **提交**：一批可能十几张，按 `SCRIPT_ASSET_LAUNCH_BATCH` 分批，不一次打满上游。
     *
     * 🔴 2026-11-08 第 16 条：**版式与画幅跟「一键直接生图」完全同一条公式**
     * （`applyScriptAssetDirectDecorations` + `resolveScriptAssetSizeForRole`）。以前这一条路既不加
     * 词库视图版式、又把同一个 `scriptImageSize` 套给整批（角色因此可能是 16:9 甚至方图），
     * 用户看到的「有的有头有的无头、比例不对」就是这两条路的差异造成的。
     */
    const handleBatchGenerateScriptAssets = useCallback(
        (nodeId: string, items: ScriptAssetBatchItem[], options?: { styleTemplateId?: string; size?: string; model?: string }) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const raw = items.filter((item) => item.title.trim() && item.prompt.trim());
            if (!source || !raw.length) return;
            // 画幅：角色 9:16 硬规则；场景 / 道具用弹窗里选的比例（没选 = 16:9）。见 `resolveScriptAssetSizeForRole`。
            const preferredSize = options?.size || source.metadata?.scriptImageSize;
            const resolveSize = (role: ScriptAssetRole) => resolveScriptAssetSizeForRole(role, preferredSize);
            const wanted = applyScriptAssetDirectDecorations(raw, effectiveConfig.textPrompts, resolveSize);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            // 画质保底：全局没选具体档位（空 / auto）时这一批按 2K 出（见 `resolveScriptImageQuality`）。
            const batchQualityFallback = resolveScriptImageQuality(effectiveConfig.quality);
            // 逐张按**自己的**画幅算格子：角色竖版、场景横版混在同一片资产阵里，不再硬塞成一个统一方格。
            const planned = wanted.map((item) => {
                const imageSize = resolveSize(item.role);
                const dims = nodeSizeFromRatio(imageSize, spec.width, spec.height) || { width: spec.width, height: spec.height };
                return { item, imageSize, width: Math.round(dims.width), height: Math.round(dims.height) };
            });
            // 资产阵：贴脚本左边框（48px）、竖向排在脚本窗口高度里、塞不下往左开新列（最多 3 列），
            // 整块以脚本窗口垂直中线为中心 —— 所以不会再出现「一排图甩到脚本下方」或「图飘在一条街外」。
            const layout = planScriptAssetGrid({
                source: { id: source.id, position: source.position, width: source.width, height: source.height },
                sizes: planned.map((cell) => ({ width: cell.width, height: cell.height })),
                occupied: collectScriptAssetOccupied(nodesRef.current, source.id),
            });
            const slots = layout.slots;
            if (!slots.length) {
                message.warning(t("canvas.scriptNode.batchAssetNoRoom"));
                return;
            }
            const created = planned.slice(0, slots.length).map((cell, index) => {
                // 风格：弹窗里挑的优先，没挑就跟随脚本节点上那档（2026-11-08 第 04 条）。
                const batchStyleTemplateId = options?.styleTemplateId || source.metadata?.styleTemplateId;
                const node = createCanvasNode(
                    CanvasNodeType.Image,
                    { x: 0, y: 0 },
                    {
                        prompt: cell.item.prompt,
                        status: NODE_STATUS_IDLE,
                        ...(cell.imageSize ? { size: cell.imageSize } : {}),
                        // 画质：全局没选具体档位（空 / auto）时按 2K 出（见 `resolveScriptImageQuality`）。
                        ...(batchQualityFallback ? { quality: batchQualityFallback } : {}),
                        // 弹窗里挑的模型：`buildGenerationConfig` 读的就是 `metadata.model`，
                        // 所以这一批（以及之后在这个节点上点重生成）都走同一个模型。
                        ...(options?.model ? { model: options.model } : {}),
                        ...(batchStyleTemplateId ? { styleTemplateId: batchStyleTemplateId } : {}),
                        // 资产阵标记：铺链路据此给老画布右侧资产图让位（本批新增的图不再据它在左侧续排，
                        // 新一批会整块让到左边另起一片，见 lib 的 planScriptAssetGrid）。
                        scriptAssetLane: source.id,
                    },
                );
                return { ...node, title: cell.item.title, width: cell.width, height: cell.height, position: slots[index] };
            });
            // 分类写进脚本节点（内联：mergeScriptAssetRoles 声明在本回调之后，进依赖数组会 TDZ）。
            const roles: Record<string, ScriptAssetRole> = Object.fromEntries(created.map((node, index) => [node.id, planned[index].item.role]));
            /**
             * **挂到具体资产上**（用户 2026-11-07 第 4 条）。
             *
             * 只连一根线到脚本节点是不够的：表里的资产格还是空的、铺链路时也认不出
             * 「这张图就是张三」。所以每张图都要写回它那条资产出现过的**每一格**：
             *  - `scriptCellAssets`（`镜号:资产列` → 追加）：表里立刻显示出这张图，铺链按「精准指定」连；
             *  - `scriptNameLocks`（资产名 → 并集）：同名在别的镜再次出现时认同一张图。
             * 口径与单格生成（`appendCellAssets`）完全一致，都走 lib 的 `mountScriptAssetToCells`。
             */
            const mountExtras = normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns);
            const mountTargets = buildScriptAssetBatchMounts(source.metadata?.scriptRows);
            let mountedCells = source.metadata?.scriptCellAssets;
            let mountedLocks = source.metadata?.scriptNameLocks;
            created.forEach((node, index) => {
                const item = wanted[index];
                if (!item) return;
                const mounted = mountScriptAssetToCells({ cells: mountedCells, locks: mountedLocks, mounts: mountTargets[item.key] || [], nodeId: node.id, extras: mountExtras });
                mountedCells = mounted.cells;
                mountedLocks = mounted.locks;
            });
            const withRoles = (item: CanvasNodeData) =>
                item.id === nodeId
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              scriptAssetRoles: { ...(item.metadata?.scriptAssetRoles || {}), ...roles },
                              scriptCellAssets: mountedCells,
                              scriptNameLocks: mountedLocks,
                          },
                      }
                    : item;
            setNodes((prev) => [...prev.map(withRoles), ...created]);
            setConnections((prev) => [...prev, ...created.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: nodeId }))]);
            // 必须立刻同步 nodesRef：紧接着的触发生成会读它判断「这是不是一个图片节点」（结果写回自身）。
            nodesRef.current = [...nodesRef.current.map(withRoles), ...created];
            setSelectedNodeIds(new Set(created.map((node) => node.id)));
            setSelectedConnectionId(null);
            revealNodes(created, "center");
            message.success(t("canvas.scriptNode.batchAssetStarted", { count: created.length }));
            if (created.length < wanted.length) message.info(t("canvas.scriptNode.batchAssetSkipped", { count: wanted.length - created.length }));

            void (async () => {
                for (let index = 0; index < created.length; index += SCRIPT_ASSET_LAUNCH_BATCH) {
                    const chunk = created.slice(index, index + SCRIPT_ASSET_LAUNCH_BATCH);
                    await Promise.all(
                        chunk.map((node, offset) => {
                            const prompt = wanted[index + offset].prompt;
                            // 生图会把标题改写成「提示词前 32 字」，资产节点要留住资产名，生成结束后改回来。
                            return Promise.resolve(generateNodeRef.current?.(node.id, "image", prompt)).finally(() => {
                                setNodes((prev) => prev.map((item) => (item.id === node.id && item.title !== node.title ? { ...item, title: node.title } : item)));
                            });
                        }),
                    );
                }
            })();
        },
        [message, revealNodes, t],
    );

    /**
     * 「一键直接生图」：**不弹窗、不筛选**，把分镜表里的角色 / 场景 / 道具全部铺成图片节点并立刻开生。
     *
     * 用户 2026-11-07 口径：「在一键铺视频链路并生成按钮的左边，添加一键直接生图按钮，直接将分镜表中的
     * 相关图进行生成，使用偏好的默认生图模型进行全部生图，并按照一键批量生成按钮出来的图片窗口排布的位置
     * 进行排放并链接到分镜表对应的位置。跟一键批量生成的区分是一键直接生图是直接全生图，不进行筛选哪些生
     * 哪些不生。生图的比例角色默认选 9x16，场景和道具选 16x9。」
     *
     * 所以与 `handleBatchGenerateScriptAssets` 只有两处不同，其余（资产阵摆位 / 挂格 / 分批提交）**完全共用**：
     *  ① **选谁**：`buildScriptAssetDirectItems(rows)` —— 内部 `existing` 传空数组，已经出过图的也算在内，
     *     不做「已有就跳过」的筛选（这正是和「一键批量生成」的区别）；同时**剔除人物站位图**
     *     （用户 2026-11-07：「站位图这一分类的图不要在一键直接生图时进行生成」）；
     *  ② **画幅**：逐条按分类**写死**（角色 9:16、场景 / 道具 16:9），见 `resolveScriptAssetDirectSize`；
     *     🔴 **不接受节点「生图比例」覆盖** —— 曾经收过 `metadata.scriptImageSize`，那份选择器一旦是 16:9，
     *     角色也被整批改成 16:9，用户报障「角色没有按照 9x16 去生」就是它。那颗选择器只管
     *     「添加资产 / 一键批量生成 / 铺链路」，与这颗按钮无关。
     * 模型**不写** `metadata.model` ⇒ 走运行时回落 = 「配置偏好里的默认生图模型」，以后改偏好这批也跟得上。
     */
    const handleDirectGenerateScriptAssets = useCallback(
        /**
         * @param options.model 「一键视频」用：本批资产图**固定用这个模型**（写进节点 `metadata.model`）。
         *                    不传 = 留空，走运行时回落「配置偏好 → 默认生图模型」（手动点这颗按钮的老口径）。
         * @param options.skipAssetKeys 这一批**不要生成**的资产键（`分类:标题`）。给「一键视频」用：
         *                    反推节点上连进来的产品参考图已经直接挂到道具格了（见 `matchScriptAssetReferences`），
         *                    再生成一张同名道具图就是白花钱、而且会和真产品图抢资产锁。
         * @returns 本批新建的图片节点。**同步返回**（生成在后台跑），「一键视频」据此等结果 / 挑失败的重试。
         */
        (nodeId: string, options?: { model?: string; skipAssetKeys?: readonly string[] }): { created: CanvasNodeData[] } => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source) return { created: [] };
            /**
             * 跳过表 = 本次调用方点名的键 ∪ **节点上落库的「参考图已挂载」键**。
             *
             * 后者是 2026-11-09 报障的修法：用户把产品图连到反推节点、一键视频挂上了、道具也不再单独生图，
             * 但他**再点一次「批量生成资产图」**（或第二次跑一键视频时 03 没把参考图传下来）时，
             * 这个函数只认调用方传进来的 `skipAssetKeys`，于是给那件道具重新生了一张图、
             * 还把挂好的产品图从格子里顶掉。清单落库之后，任何一轮批量生图都绕不开它。
             */
            const skipKeys = new Set([
                ...(options?.skipAssetKeys || []).map((key) => String(key || "")),
                ...(source.metadata?.scriptReferenceAssetKeys || []).map((key) => String(key || "")),
            ].filter(Boolean));
            // 不筛「已出过图」是这里唯一的产品口径；站位图在 buildScriptAssetDirectItems 里就剔掉了。
            // 再按分类补上**词库里的视图版式**（用户 2026-11-08：角色 →「无头 9x16 竖版排版」、
            // 场景 →「2x2 场景宫格图」），以及**场景 / 道具的空景尾缀**与**画幅的首尾声明**（画幅开头
            // 一句、最后一行再钉一次，见 `applyScriptAssetDirectDecorations` 的顺序说明）。这里就地改 prompt，
            // 所以「节点上显示的提示词」与「真正发给生图模型的提示词」是同一份（下面 `cell.item.prompt` 两处读的都是它）。
            // ⚠️ `skipAssetKeys` 必须在**整形之前**过滤：键是 `分类:标题`，与整形无关，早过滤少算一批提示词。
            const wanted = applyScriptAssetDirectDecorations(
                buildScriptAssetDirectItems(source.metadata?.scriptRows)
                    .filter((item) => !skipKeys.has(item.key))
                    .filter((item) => item.title.trim() && item.prompt.trim()),
                effectiveConfig.textPrompts,
            );
            if (!wanted.length) {
                message.warning(t("canvas.scriptNode.directAssetEmpty"));
                return { created: [] };
            }
            /**
             * 「有没有调用词库里那条版式」以前只能靠猜：匹配不上是**静默跳过**的。
             * 现在没命中就明说一句（只提示、不阻塞），用户一眼能分辨「没挂上」和「挂上了但模型没听」。
             */
            const missingViews = resolveMissingScriptAssetViewTemplates(wanted, effectiveConfig.textPrompts);
            if (missingViews.length) message.info(t("canvas.scriptNode.viewTemplateMissing", { names: missingViews.join(" / ") }));
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            // 画质保底：全局没选具体档位（空 / auto）时「一键直接生图」这一批按 2K 出
            // —— 只写比例的节点会一路回落到 `DEFAULT_IMAGE_SHORT_SIDE` 的 1K（见 `resolveScriptImageQuality`）。
            const directQualityFallback = resolveScriptImageQuality(effectiveConfig.quality);
            const planned = wanted.map((item) => {
                // ⚠️ 只传分类，没有第二个参数：比例是硬规则，任何节点字段都不许改它。
                const imageSize = resolveScriptAssetDirectSize(item.role);
                const dims = nodeSizeFromRatio(imageSize, spec.width, spec.height) || { width: spec.width, height: spec.height };
                return { item, imageSize, width: Math.round(dims.width), height: Math.round(dims.height) };
            });
            // 混合画幅（角色 9:16 / 场景道具 16:9）走同一个资产阵：每张按自己的真实宽高落在格子中央，
            // 不再塞进统一方格，也不再「从脚本顶边一路往下摞」。
            const layout = planScriptAssetGrid({
                source: { id: source.id, position: source.position, width: source.width, height: source.height },
                sizes: planned.map((cell) => ({ width: cell.width, height: cell.height })),
                occupied: collectScriptAssetOccupied(nodesRef.current, source.id),
            });
            const slots = layout.slots;
            if (!slots.length) {
                message.warning(t("canvas.scriptNode.batchAssetNoRoom"));
                return { created: [] };
            }
            const created = planned.slice(0, slots.length).map((cell, index) => {
                const node = createCanvasNode(
                    CanvasNodeType.Image,
                    { x: 0, y: 0 },
                    {
                        prompt: cell.item.prompt,
                        status: NODE_STATUS_IDLE,
                        ...(cell.imageSize ? { size: cell.imageSize } : {}),
                        // 画质：全局没选具体档位（空 / auto）时按 2K 出（见 `resolveScriptImageQuality`）。
                        ...(directQualityFallback ? { quality: directQualityFallback } : {}),
                        // 风格模板：直接生图没有弹窗，统一跟随脚本节点上那档（2026-11-08 第 04 条）。
                        ...(source.metadata?.styleTemplateId ? { styleTemplateId: source.metadata.styleTemplateId } : {}),
                        // ⚠️ 默认**不写** `model`：留空 = 生成时回落「配置偏好 → 默认生图模型」。
                        // 只有「一键视频」显式指定模型时才写（它要按模型分轮次重试 / 托底）。
                        ...(options?.model ? { model: options.model } : {}),
                        scriptAssetLane: source.id,
                    },
                );
                return { ...node, title: cell.item.title, width: cell.width, height: cell.height, position: slots[index] };
            });
            const roles: Record<string, ScriptAssetRole> = Object.fromEntries(created.map((node, index) => [node.id, planned[index].item.role]));
            const mountExtras = normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns);
            const mountTargets = buildScriptAssetBatchMounts(source.metadata?.scriptRows);
            let mountedCells = source.metadata?.scriptCellAssets;
            let mountedLocks = source.metadata?.scriptNameLocks;
            created.forEach((node, index) => {
                const cell = planned[index];
                if (!cell) return;
                const mounted = mountScriptAssetToCells({ cells: mountedCells, locks: mountedLocks, mounts: mountTargets[cell.item.key] || [], nodeId: node.id, extras: mountExtras });
                mountedCells = mounted.cells;
                mountedLocks = mounted.locks;
            });
            const withRoles = (item: CanvasNodeData) =>
                item.id === nodeId
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              scriptAssetRoles: { ...(item.metadata?.scriptAssetRoles || {}), ...roles },
                              scriptCellAssets: mountedCells,
                              scriptNameLocks: mountedLocks,
                          },
                      }
                    : item;
            setNodes((prev) => [...prev.map(withRoles), ...created]);
            setConnections((prev) => [...prev, ...created.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: nodeId }))]);
            // 紧接着的触发生成要读 nodesRef 判断「这是不是一个图片节点」（结果写回自身），必须先同步。
            nodesRef.current = [...nodesRef.current.map(withRoles), ...created];
            setSelectedNodeIds(new Set(created.map((node) => node.id)));
            setSelectedConnectionId(null);
            revealNodes(created, "center");
            message.success(t("canvas.scriptNode.directAssetStarted", { count: created.length }));
            if (created.length < wanted.length) message.info(t("canvas.scriptNode.batchAssetSkipped", { count: wanted.length - created.length }));

            void (async () => {
                for (let index = 0; index < created.length; index += SCRIPT_ASSET_LAUNCH_BATCH) {
                    const chunk = created.slice(index, index + SCRIPT_ASSET_LAUNCH_BATCH);
                    await Promise.all(
                        chunk.map((node, offset) => {
                            const prompt = planned[index + offset].item.prompt;
                            // 生图会把标题改写成「提示词前 32 字」，资产节点要留住资产名，生成结束后改回来。
                            return Promise.resolve(generateNodeRef.current?.(node.id, "image", prompt)).finally(() => {
                                setNodes((prev) => prev.map((item) => (item.id === node.id && item.title !== node.title ? { ...item, title: node.title } : item)));
                            });
                        }),
                    );
                }
            })();
            return { created };
        },
        [effectiveConfig.quality, effectiveConfig.textPrompts, message, revealNodes, t],
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
                item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptRowAssets: setStoryScriptRowAssetIds(item.metadata?.scriptRowAssets, shotNo, [...scriptRowAssetIds(item.metadata?.scriptRowAssets, shotNo), ...ids]) } } : item,
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
        const laid = countMap(source.metadata?.scriptRowAssets) + countMap(source.metadata?.scriptCellAssets) + countMap(source.metadata?.scriptRowAudios);
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
            appendRowAssets(
                nodeId,
                shotNo,
                placed.map((node) => node.id),
            );
            revealNodes(placed, "center");
            message.success(t("canvas.scriptNode.rowImageImported", { count: placed.length, no: shotNo }));
        },
        [appendRowAssets, buildAssetItems, message, placeRowAssetNodes, revealNodes, t],
    );

    /** 逐镜 AI 生成图片：建图片节点、关联到这一镜并立刻触发生图（`size` 是弹窗里选的生图比例）。 */
    const handleRowAssetGenerate = useCallback(
        (nodeId: string, shotNo: number, prompt: string, title: string, styleTemplateId?: string, size?: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const scene = prompt.trim();
            if (!source || !scene) return;
            const assetTitle = title.trim() || scene.slice(0, 24);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const imageSize = resolveStoryScriptImageSize(size) || resolveStoryScriptImageSize(source.metadata?.scriptImageSize);
            const dims = nodeSizeFromRatio(imageSize, spec.width, spec.height) || { width: spec.width, height: spec.height };
            // 风格：弹窗里挑的优先，没挑就跟随脚本节点上那档。
            const rowStyleTemplateId = styleTemplateId || source.metadata?.styleTemplateId;
            // 画质：全局没选具体档位（空 / auto）时按 2K 出（见 `resolveScriptImageQuality`）。
            const rowQualityFallback = resolveScriptImageQuality(effectiveConfig.quality);
            const node = createCanvasNode(
                CanvasNodeType.Image,
                { x: 0, y: 0 },
                { prompt: scene, status: NODE_STATUS_IDLE, ...(imageSize ? { size: imageSize } : {}), ...(rowQualityFallback ? { quality: rowQualityFallback } : {}), ...(rowStyleTemplateId ? { styleTemplateId: rowStyleTemplateId } : {}) },
            );
            const placed = placeRowAssetNodes(source, [{ node: { ...node, title: assetTitle }, width: dims.width, height: dims.height }]);
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
        [appendRowAssets, effectiveConfig.quality, message, placeRowAssetNodes, revealNodes, t],
    );

    // ---- 逐镜声音（metadata.scriptRowAudios）----
    // 与「逐镜图片」并列的一张关联表（同样以镜号为键），但语义完全不同：声音**只连视频节点**，
    // 不参与生图，所以它既不进资产池、也不进图片绑定提示词。铺链路时只连「这一镜（或该分段）的视频节点」。
    // 与「整表音频资产」的分工：整表音频 = 每段都连（BGM / 全局旁白）；逐镜声音 = 只连这一镜（台词配音 / 音效）。

    /** 逐镜声音整体替换（弹窗确认、或胶囊上的 × 解绑）。 */
    const handleRowAudiosChange = useCallback((nodeId: string, shotNo: number, ids: string[]) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptRowAudios: setStoryScriptRowAudioIds(item.metadata?.scriptRowAudios, shotNo, ids) } } : item)));
    }, []);

    /** 把新导入的音频追加关联到某一镜（保留这一镜已有的声音）。 */
    const appendRowAudios = useCallback((nodeId: string, shotNo: number, ids: string[]) => {
        if (!ids.length) return;
        setNodes((prev) =>
            prev.map((item) =>
                item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptRowAudios: setStoryScriptRowAudioIds(item.metadata?.scriptRowAudios, shotNo, [...scriptRowAudioIds(item.metadata?.scriptRowAudios, shotNo), ...ids]) } } : item,
            ),
        );
    }, []);

    /**
     * 逐镜导入本地音频：建音频节点、落位并立刻关联到这一镜（只收音频，其余挡下并提示）。
     * 返回新建节点的 id：弹窗拿它把新音频并入当前勾选、并保持在打开状态 —— 一格挂多条不用反复开窗。
     */
    const handleRowAudioImport = useCallback(
        async (nodeId: string, shotNo: number, files: File[]): Promise<string[]> => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || !files.length) return [];
            const items = await buildAssetItems(files);
            const audios = items.filter((item) => item.node.type === CanvasNodeType.Audio);
            if (!audios.length) {
                if (items.length) message.warning(t("canvas.scriptNode.rowAudioOnlyAudio"));
                return [];
            }
            const placed = placeRowAssetNodes(source, audios);
            if (!placed.length) return [];
            const ids = placed.map((node) => node.id);
            appendRowAudios(nodeId, shotNo, ids);
            revealNodes(placed, "center");
            // 提示里带上「这一镜现在共几条」：一次选多个文件、或反复追加时，用户才看得出是累积而不是替换。
            const total = scriptRowAudioIds(source.metadata?.scriptRowAudios, shotNo).length + placed.length;
            message.success(t("canvas.scriptNode.rowAudioImported", { count: placed.length, no: shotNo, total }));
            return ids;
        },
        [appendRowAudios, buildAssetItems, message, placeRowAssetNodes, revealNodes, t],
    );

    // ---- 按镜按资产图位（metadata.scriptCellAssets）----
    // 与「镜头图」共用落位与生成链路，差别只在键多带一个资产列：「第 3 镜 · 场景」格里加的图只属于
    // 第 3 镜的场景，铺链路时也只连到第 3 镜的图片 / 视频节点，并顶掉资产条对同一镜同一分类的分派。

    /** 资产列的显示名（「场景」「角色1」/ 自建列的列名），只给提示文案用；取不到就回落列 key。 */
    const cellAssetColumnLabel = useCallback((source: CanvasNodeData, columnKey: string) => {
        const presetId = resolveStoryScriptPresetId(source.metadata?.scriptPreset);
        // 自建资产列不在预设列里，所以要把两张列表拼起来查（否则提示里会显示 `extra_1`）。
        const extras = normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns);
        return getStoryScriptColumnsWithExtras(presetId, extras).find((column) => column.key === columnKey)?.label || columnKey;
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
                // 自建资产列的图位也要能写进去（`extra_*` 只有在 extras 里声明过才算合法列）。
                const extras = normalizeStoryScriptExtraColumns(item.metadata?.scriptExtraColumns);
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        scriptCellAssets: setStoryScriptCellAssetIds(item.metadata?.scriptCellAssets, shotNo, columnKey, ids, extras),
                        // 走统一入口而不是 `setStoryScriptNameLock(row[columnKey], ids)`：
                        // 一格多名时那一串名字当一个 key 写进去，就是一条永远命中不了的**假资产锁**，
                        // 并且会把整格图锁到「川晓遥、宁宁、明明」这个并不存在的资产上（用户 2026-11-09 第 01 条）。
                        scriptNameLocks: ids.length ? addScriptNameLockForCell(item.metadata?.scriptNameLocks, row, columnKey, ids, extras) : item.metadata?.scriptNameLocks,
                    },
                };
            }),
        );
    }, []);

    /**
     * 把新节点追加关联到某一格（保留这一格已有的图），并把新图**并进**同名资产锁。
     *
     * @param name 这张新图**属于格内哪一个名字**（单格生成时就是那一格的资产标题）。
     *             一格多名（`川晓遥、宁宁、明明`）生成出来的必须给 —— 生成的是「某一个人的定妆图」，
     *             只该锁给那个人；不传就退化成「整格广播」（那是**手动挂图**的语义：
     *             `handleCellAssetsChange` 不传，因为用户往这一格里挂图＝这张图是这一格的资产）。
     *             旧实现连自动生成也一律广播，于是 3 个角色互相锁着别人的图
     *             （用户 2026-11-09 第 01 条报障）。
     */
    const appendCellAssets = useCallback((nodeId: string, shotNo: number, columnKey: string, ids: string[], name?: string) => {
        if (!ids.length) return;
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const row = (item.metadata?.scriptRows || []).find((candidate, index) => (Number(candidate.shot_no) || index + 1) === shotNo);
                const extras = normalizeStoryScriptExtraColumns(item.metadata?.scriptExtraColumns);
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        scriptCellAssets: setStoryScriptCellAssetIds(item.metadata?.scriptCellAssets, shotNo, columnKey, [...scriptCellAssetIds(item.metadata?.scriptCellAssets, shotNo, columnKey, extras), ...ids], extras),
                        scriptNameLocks: addScriptNameLockForCell(item.metadata?.scriptNameLocks, row, columnKey, ids, extras, name),
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
                            // 逐镜声音也在这条链上：删掉音频链接后，表里「声音」列不该还留着它。
                            scriptRowAudios: stripStoryScriptAssetId(item.metadata?.scriptRowAudios, assetNodeId),
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
            appendCellAssets(
                nodeId,
                shotNo,
                columnKey,
                placed.map((node) => node.id),
            );
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
        (nodeId: string, shotNo: number, columnKey: string, prompt: string, title: string, model?: string, styleTemplateId?: string, size?: string) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            const scene = prompt.trim();
            if (!source || !scene) return;
            const assetTitle = title.trim() || scene.slice(0, 24);
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const imageSize = resolveStoryScriptImageSize(size) || resolveStoryScriptImageSize(source.metadata?.scriptImageSize);
            const dims = nodeSizeFromRatio(imageSize, spec.width, spec.height) || { width: spec.width, height: spec.height };
            // 风格：这一格单独挑的优先，没挑就跟随脚本节点上那档。
            const cellStyleTemplateId = styleTemplateId || source.metadata?.styleTemplateId;
            // 画质：全局没选具体档位（空 / auto）时按 2K 出（见 `resolveScriptImageQuality`）。
            const cellQualityFallback = resolveScriptImageQuality(effectiveConfig.quality);
            const node = createCanvasNode(
                CanvasNodeType.Image,
                { x: 0, y: 0 },
                {
                    prompt: scene,
                    status: NODE_STATUS_IDLE,
                    ...(imageSize ? { size: imageSize } : {}),
                    ...(cellQualityFallback ? { quality: cellQualityFallback } : {}),
                    ...(model ? { model } : {}),
                    ...(cellStyleTemplateId ? { styleTemplateId: cellStyleTemplateId } : {}),
                },
            );
            const placed = placeRowAssetNodes(source, [{ node: { ...node, title: assetTitle }, width: dims.width, height: dims.height }]);
            const created = placed[0];
            if (!created) return;
            // 立刻同步 nodesRef / connectionsRef：紧接着的触发生成会读 nodesRef 判断「这是不是一个图片节点（结果写回自身）」，
            // 铺链路则从 connectionsRef 里认「哪些是整表资产」。
            nodesRef.current = [...nodesRef.current, created];
            const connection: CanvasConnection = { id: nanoid(), fromNodeId: created.id, toNodeId: nodeId };
            connectionsRef.current = [...connectionsRef.current, connection];
            setConnections((prev) => [...prev, connection]);
            const role = scriptAssetColumnRole(columnKey, normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns)) || "character";
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
            appendCellAssets(nodeId, shotNo, columnKey, [created.id], assetTitle);
            revealNodes([created], "center");
            message.success(t("canvas.scriptNode.cellAssetGenerating", { no: shotNo, label: cellAssetColumnLabel(source, columnKey) }));
            void Promise.resolve(generateNodeRef.current?.(created.id, "image", scene)).finally(() => {
                setNodes((prev) => prev.map((item) => (item.id === created.id && item.title !== assetTitle ? { ...item, title: assetTitle } : item)));
            });
        },
        [appendCellAssets, cellAssetColumnLabel, message, placeRowAssetNodes, revealNodes, t],
    );

    const handleBuildScriptPipeline = useCallback(
        /**
         * @param rowIndexes 「选择铺链路」传勾选的行下标：只铺这一段，且这一段合成**一个**视频节点。
         *                   不传 = 整表一键铺链路（与以前逐字节一致）。
         * @param options.videoOnly 简洁版「只铺视频」：**跳过文本 / 图片节点**，只按分段把视频节点窗口铺出来，
         *                   视频节点照旧带该段的提示词、时长，以及资产图 / 音频的直接连线。
         *                   用户原话：「一键铺链路，需要有一个简洁版的按钮，即只铺视频节点窗口」。
         * @param options.group 铺完把视频节点**打成一个组**（用户 2026-11-07 第 3 条）。
         * @param options.autoGenerate 铺完对这组视频节点**逐个执行生成**，每两个之间间隔
         *                   `SCRIPT_PIPELINE_GENERATE_INTERVAL_MS`；跑一遍即结束（不等生成完成）。
         * @param options.skipConfirm 不弹确认窗、直接铺（只给「一键视频」用：那条流程已经有总确认）。
         * @param options.mergeEvery 强制「每 N 镜合并成 1 段」，**无视**「视频分段」档位与手动合并组。
         *                   只给「一键铺视频链路」用（用户 2026-11-09 第 02 条：固定每 4 镜合并为 1 镜）。
         * @param options.onVideoPause 某段视频「换模型再生成一次」仍失败 → 判定暂停时回调（带原因文案）。
         *                   只给「一键视频」用：那条流程要把暂停原因写到脚本节点的运行态上。
         */
        (nodeId: string, rowIndexes?: number[], options?: { videoOnly?: boolean; group?: boolean; autoGenerate?: boolean; skipConfirm?: boolean; mergeEvery?: number; onVideoPause?: (message: string) => void }) => {
            const videoOnly = Boolean(options?.videoOnly);
            const groupVideos = Boolean(options?.group);
            const autoGenerate = Boolean(options?.autoGenerate);
            /**
             * 「每几镜合一个视频节点」：
             *  - 脚本节点打开了「每 3 镜合一个视频」（`scriptShotsPerClip === 3`，用户 2026-11-11 第 01 条）
             *    → 一律 3 镜切片，**优先于**分段档位、手动合并组，以及「一键铺视频链路」写死的 4；
             *  - 没开 → 原行为：`options.mergeEvery`（= 视频链那 4）优先，其次走「视频分段」档位。
             * （读的是下面那个 `source`，所以这段必须放在它之后。）
             */
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || source.type !== CanvasNodeType.Script) return;
            const mergeEvery = resolveScriptPipelineMergeEvery(source.metadata, options?.mergeEvery);
            /**
             * 调用方**显式**要求「每 N 镜一段」= 点的是「一键铺视频链路」那颗按钮。
             * 与上面的 `mergeEvery` 分开：3 镜开关虽然是同一种固定切片，但它只改**怎么切**，
             * 不该把「一键铺链路 / 只铺视频」的确认窗标题和按钮文案也改成「一键铺视频链路」。
             */
            const chainMergeEvery = Math.max(0, Math.round(Number(options?.mergeEvery) || 0));
            const rows = source.metadata?.scriptRows || [];
            if (!rows.length) return;
            const presetId = resolveStoryScriptPresetId(source.metadata?.scriptPreset);
            const preset = getStoryScriptPreset(presetId);
            // 手动追加的资产列（「宠物」「车辆」…）：它们的图位也要参与铺链路，所以一路带到 refs 里。
            const scriptExtras = normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns);
            const segmentSeconds = source.metadata?.scriptSegmentSeconds;
            const mergeMode = resolveStoryScriptMergeMode(source.metadata?.scriptMergeMode);
            // **资产锁定**：一键铺链先把「分镜表里已经链接好的图片」按资产名锁成 名字 → 图片
            // （「张三」→ @图片1、「客厅」→ @图片2），再按这张锁表逐镜分派：表里凡是出现同名的地方
            // 都用同一张图。已有锁保留（并集），不会因为没有格子链接就被抹掉。
            const nameLocks = syncStoryScriptNameLocks(source.metadata?.scriptNameLocks, source.metadata?.scriptCellAssets, rows, scriptExtras);
            // 「资产名」查表：表里的资产名优先（名字锁就是按资产名记的），查不到就交给绑定拼装回落图片节点标题。
            const assetNameOf = (assetNodeId: string) => {
                const locks = source.metadata?.scriptNameLocks;
                for (const [name, ids] of Object.entries(locks || {})) {
                    if (Array.isArray(ids) && ids.includes(assetNodeId)) return name;
                }
                return undefined;
            };
            // 现存节点 id：过滤掉已被删、但还留在 metadata.scriptRowAssets 里的镜头图，免得连出悬空线。
            const existingNodeIds = new Set(nodesRef.current.map((node) => node.id));
            // 上游图片节点 = 角色 / 场景 / 道具 / 站位图素材。分类决定它连到哪些镜：
            //   角色 → 按分镜里的角色名逐镜匹配；场景 / 道具 / 站位图 → 每一镜都连。
            // 音频素材单独拎出来：它不能参与生图，只连到视频节点（每段视频都连）。
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(source.metadata?.scriptAssetRoles?.[assetNodeId]);
            // 资产文案的两种写法（用户 2026-10-27 第 02 条）：
            //   第四套（影视分镜导演）→ 多行「资产锁定」块：`@图片1：李曼人物参考，锁定面容、发型、服装、体型。`
            //   其余三套 → 老的单行 `资产绑定：李曼@图片1、林舟@图片2`，一个字节不动。
            const directorScheme = resolveScriptSchemeId(source.metadata?.scriptScheme) === "director";
            const assetBindingOf = directorScheme ? buildScriptAssetLockPrompt : buildScriptAssetBindingPrompt;
            const upstreamNodes = Array.from(new Set(connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId)))
                .map((id) => nodesRef.current.find((node) => node.id === id))
                .filter((node): node is CanvasNodeData => Boolean(node));
            const upstreamAssets = upstreamNodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)).map((node) => ({ id: node.id, title: node.title, role: assetRoleOf(node.id) }));
            // ⚠️ 这里**不再**分「角色 / 全局」两拨：所有素材都交给 `matchScriptRowAssetsByRole` 按分类逐镜匹配。
            // 老实现把场景 / 道具 / 站位无条件连到每一镜，一张表十几个资产 → 每个视频节点挂十几张图（用户报障）。
            const audioRefs = upstreamNodes.filter((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey)).map((node) => ({ id: node.id, title: node.title }));

            const textWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Text].width;
            // 文本节点默认 480 高，铺链路时压到 240：否则每一镜的横向三件套会占掉整屏。
            const textHeight = 240;
            // **生图比例**：脚本节点上存着一档（`metadata.scriptImageSize`，9:16 / 16:9 …）。
            // 铺出来的图片节点按这个画幅建、并把比例写进 `metadata.size` —— 于是「逐节点点生成」
            // 也是同一个画幅，不用再一个个改。空 = 跟随全局配置，沿用默认方形。
            const scriptImageSize = resolveStoryScriptImageSize(source.metadata?.scriptImageSize);
            // **风格模板**：脚本节点上选的那档（用户 2026-11-08 第 04 条「脚本生成器里也要图片节点那套风格模板」）。
            // 铺出来的图片节点**和视频节点**都直接带上它 —— 生图 / 生视频链路读的都是节点自己的
            // `metadata.styleTemplateId`，所以「铺完再点生成」和「铺完自动生成」都会吃到同一份风格；
            // 铺完想换风格，改节点自己那颗风格按钮即可（不会回写脚本节点）。
            // ⚠️ 视频节点以前不继承（2026-11-08 第 05 条用户要求补上：脚本里选的风格要同时落到生图与生视频窗口）。
            const scriptStyleTemplateId = source.metadata?.styleTemplateId;
            const scriptStyle = scriptStyleTemplateId ? { styleTemplateId: scriptStyleTemplateId } : {};
            // **生图画质**：全局没选具体档位（空 / auto）时铺出来的镜头图也按 2K 出
            // —— 只写比例的节点会回落到 1K（见 `resolveScriptImageQuality`）。
            const scriptImageQuality = resolveScriptImageQuality(effectiveConfig.quality);
            const scriptImageMeta = scriptImageQuality ? { quality: scriptImageQuality } : {};
            /**
             * **视频节点的模型 / 比例 / 分辨率**（用户 2026-11-09：反推节点窗口里选好，一键视频就按这套出片）。
             *
             * 三个值都从脚本节点上读（`scriptVideoModel` / `scriptVideoSize` / `scriptVideoQuality`），
             * 由 `runVideoReverse` 在 03 建脚本节点时从反推节点的 `reverseVideoTarget` 搬过来。
             * 空 = 与改造前完全一致（视频节点不写这三个键，取全局偏好）。
             *
             * ⚠️ 只写进节点的 metadata，**不在这里改节点窗口尺寸**：视频节点是 420×236，按 9:16 折算会变成
             * 133 宽 —— 提示词面板直接没法用。窗口保持默认，画幅由 `metadata.size` 决定。
             */
            const scriptVideoModel = String(source.metadata?.scriptVideoModel || "").trim();
            const scriptVideoSize = resolveStoryScriptImageSize(source.metadata?.scriptVideoSize);
            const scriptVideoQuality = String(source.metadata?.scriptVideoQuality || "").trim();
            /**
             * **生视频引擎**（用户 2026-11-10 第 01 条）：脚本节点上选了「MochiAni 生视频节点」时，
             * 这一段铺出来的是 MochiAni 窗口（`CanvasNodeType.Mochiani`），而不是普通视频节点。
             * 提示词 / 参考图 / 风格 / 音频 / 合并连线全部走同一套逻辑（下游只认「有内容的视频源」），
             * 差别只有三点：① 节点类型；② 模型 / 渠道 / 参数从**偏好里的 MochiAni 配置**预填，
             * 不再写 `scriptVideoModel`；③ 窗口尺寸换成 560×820（MochiAni 的面板一屏放得下）。
             */
            const useMochianiVideo = isMochianiVideoEngine(source.metadata?.scriptVideoEngine);
            const mochianiPreference = useMochianiVideo ? resolveMochianiPreference(effectiveConfig) : null;
            const scriptVideoMeta = {
                ...(scriptVideoModel && !useMochianiVideo ? { model: scriptVideoModel } : {}),
                ...(scriptVideoSize ? { size: scriptVideoSize } : {}),
                ...(scriptVideoQuality ? { vquality: scriptVideoQuality } : {}),
            };
            const imageSpec = nodeSizeFromRatio(scriptImageSize, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const imageWidth = imageSpec.width;
            const imageHeight = imageSpec.height;
            const videoNodeType = useMochianiVideo ? CanvasNodeType.Mochiani : CanvasNodeType.Video;
            const videoSpec = NODE_DEFAULT_SIZE[videoNodeType];
            const videoWidth = videoSpec.width;
            const videoHeight = videoSpec.height;
            const gapX = 48;
            const gapY = 72;
            const rowHeight = Math.max(textHeight, imageHeight, videoHeight);
            // 脚本节点右侧可能已经排了一整条「资产图车道」（一键批量生成出来的角色 / 场景 / 道具）。
            // 让开它，否则分镜链路会正好盖在资产图上；没有资产图时与改造前逐像素一致。
            const assetLaneRight = scriptAssetLaneRight(nodesRef.current, source.id);
            const desiredBaseX = Math.max(source.position.x + source.width + 64, (assetLaneRight ?? 0) + gapX);
            /**
             * 再往外让一层（用户 2026-11-09）：「创建出来的窗口都堆在一起」。
             *
             * 锚点永远是这个脚本节点，所以同一个脚本节点铺第二次、或右侧已经躺着上一轮铺出来的
             * 视频 / 合并窗口时，新的一整列会精确压在旧的上面。整条车道（文本 / 图片 / 视频三列）
             * 当成一个矩形，走 `findFreeColumnX` 往右找第一块空地 —— 没占位时 x 完全不变。
             */
            const laneWidth = videoOnly ? videoWidth : textWidth + gapX + imageWidth + gapX + videoWidth;
            const laneHeight = Math.max(rowHeight, rows.length * (rowHeight + gapY) - gapY);
            const baseY = source.position.y;
            const baseX = findFreeColumnX({
                desiredX: desiredBaseX,
                width: laneWidth,
                top: baseY,
                height: laneHeight,
                occupied: collectCanvasOccupied(nodesRef.current, [source.id]),
                gap: gapX,
            });
            const imageX = baseX + textWidth + gapX;
            // 简洁版（只铺视频）没有文本 / 图片两列，视频节点直接贴着脚本节点排 —— 否则空出来的两列
            // 会让整片视频窗口离节点很远，看上去像「没铺出来」。
            const videoX = videoOnly ? baseX : imageX + imageWidth + gapX;

            // 先摘掉「一行连图片提示词都凑不出来」的空行，再按分段方式切组——否则空行会把合并的镜数算歪。
            // `scriptExtras` 必须传进去：风格提示词也可能活在自建列（列名带「风格」）里。
            // 第四套：末尾追加的风格行写成 `- **视觉风格：**…`。
            // `dropVideoStyle`：脚本节点**选了风格模板**时，视频段的提示词不带风格行
            //（用户 2026-11-08 第 06 条：视频窗口里不填「视觉风格：…」，风格改由模板在生成时拼）。
            // 没选模板时照旧带上，否则视频就一点风格信息都没有了。图片提示词两边都不动。
            const dropScriptVideoStyle = Boolean(scriptStyleTemplateId);
            const allRenderable = rows.map((row, index) => ({ row, index, prompts: preset.buildShotPrompts(row, scriptExtras, { directorScheme, dropVideoStyle: dropScriptVideoStyle }) })).filter((item) => Boolean(item.prompts.imagePrompt));
            /**
             * 「选择铺链路」：只铺勾选的那一段，**且这一段合成一个视频节点**（用户 2026-11-06 要求）。
             *
             * 勾的行可能不连续（第 2、4 镜），而「合成一段视频」本身要求连续 —— 按首尾补齐
             * （与「合并为一镜」同口径），否则中间那一镜会被跳过、视频内容也接不上。
             * ⚠️ 这里的下标是**原始行下标**（和 `metadata.scriptMergeGroups` 同一套坐标系），
             * 不是 `allRenderable` 里的位置 —— 下面一律用 `item.index` 比较。
             */
            const picked = (rowIndexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < rows.length);
            const selection = picked.length ? (normalizeStoryScriptMergeGroups([picked], rows.length)[0] ?? [Math.min(...picked)]) : undefined;
            const renderable = selection ? allRenderable.filter((item) => item.index >= selection[0] && item.index <= selection[selection.length - 1]) : allRenderable;
            if (!renderable.length) {
                message.warning(t("canvas.scriptNode.pipelineEmpty"));
                return;
            }
            // 分段方式（单镜 / 每 N 镜 / 按每段时长）决定「几个镜共用一个视频节点」。
            // **手动合并组**（用户在表里勾几行点「合并为一镜」）优先于档位：
            // 它存的是**原始行下标**，而 `renderable` 已经剔掉空行、下标不再对应 —— 先按
            // 「原始下标 → renderable 位置」换算一次，否则删过空行之后会合并到错位的镜上。
            const renderableSlot = new Map<number, number>();
            renderable.forEach((item, slot) => renderableSlot.set(item.index, slot));
            const manualMergeGroups = selection
                ? // 选择铺链路：选中的这一段**整体**成一段，不理表里原有的手动合并组 ——
                  // 点这个按钮要的就是「一段视频」，勾了 3 镜却铺出 2 段是错的。
                  renderable.length > 1
                    ? [[...Array.from({ length: renderable.length }, (_, slot) => slot)]]
                    : []
                : (source.metadata?.scriptMergeGroups || []).map((span) => (Array.isArray(span) ? span.map((index) => renderableSlot.get(index)).filter((slot): slot is number => slot !== undefined) : [])).filter((span) => span.length >= 2);
            const groups: ReturnType<typeof groupStoryScriptRows> =
                mergeEvery > 0
                    ? // 「一键铺视频链路」：**固定每 mergeEvery 镜一段**，不看分段档位、也不看手动合并组
                      // （用户 2026-11-09 第 02 条：「仍然使用每 4 镜合并为 1 镜输出的原则」）。
                      Array.from({ length: Math.ceil(renderable.length / mergeEvery) }, (_, index) => ({
                          rows: renderable.slice(index * mergeEvery, index * mergeEvery + mergeEvery).map((item) => item.row),
                      }))
                    : groupStoryScriptRows(
                          renderable.map((item) => item.row),
                          mergeMode,
                          segmentSeconds,
                          manualMergeGroups,
                      );

            const created: CanvasNodeData[] = [];
            /** 这一批铺出来的视频节点（顺序 = 时间线顺序），末尾要一起接进一个视频合并节点。 */
            const createdVideoNodes: CanvasNodeData[] = [];
            const createdConnections: CanvasConnection[] = [];
            let assetLinkCount = 0;
            let cursor = 0;
            // 简洁版：没有文本 / 图片节点要对齐表格行，视频节点按 0,1,2… 紧凑竖排，
            // 不再沿用「第 N 镜 × 行高」的展开方式（否则 10 镜会拉开一整屏空白）。
            let packIndex = 0;
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
                // 这一段视频用到的全部资产：角色按各镜角色名匹配，场景 / 道具 / 站位**也按各镜自己的列**匹配
                // （2026-11-08 第 13 条：不再整类全连）。汇总后直接连到视频节点 —— 生成的「视频生成窗口」
                // 里就能看到并引用这些资产图。
                const groupAssetIds = new Set<string>();
                // 每张参考图属于哪一档（角色 / 场景 / 道具 / 站位 / 镜头图）：写连线前按它排序，
                // 于是视频节点的参考图顺序恒为「角色 → 场景 → 道具 → 特效/站位 → 镜头图」
                //（顺序 = 输入框里 chip 的顺序，见 `orderScriptRefIds`）。
                const groupAssetKinds = new Map<string, ScriptRefLinkKind>();
                // 这一段里各镜自己的声音（表里「声音」列）：与 `groupAssetIds` 分开存 —— 音频只连视频节点，
                // 既要跳过图片节点，也不能混进「资产绑定」提示词（那是给图片编号用的）。
                const groupAudioIds = new Set<string>();
                for (const member of members) {
                    const rowY = baseY + member.index * (rowHeight + gapY);
                    const shotNo = member.row.shot_no || member.index + 1;
                    /**
                     * 简洁版（只铺视频）：这一镜**不建**「文本 → 图片」两个节点，所以 `imageNode` 保持 `null`；
                     * 下面所有「连进图片节点」的动作统一走 `linkToImage()`（没有图片节点时只跳过连线）。
                     * 资产仍然完整收集进 `groupAssetIds` —— 铺出来的视频窗口里照样能看到全部参考图。
                     */
                    let imageNode: CanvasNodeData | null = null;
                    if (!videoOnly) {
                        const textNode: CanvasNodeData = {
                            ...createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: member.prompts.imagePrompt, prompt: member.prompts.imagePrompt, status: NODE_STATUS_IDLE }),
                            title: t("canvas.scriptNode.pipelineText", { no: shotNo }),
                            width: textWidth,
                            height: textHeight,
                            position: { x: baseX, y: centeredY(rowY, textHeight) },
                        };
                        imageNode = {
                            ...createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { prompt: member.prompts.imagePrompt, status: NODE_STATUS_IDLE, ...(scriptImageSize ? { size: scriptImageSize } : {}), ...scriptImageMeta, ...scriptStyle }),
                            title: t("canvas.scriptNode.pipelineImage", { no: shotNo }),
                            width: imageWidth,
                            height: imageHeight,
                            position: { x: imageX, y: centeredY(rowY, imageHeight) },
                        };
                        created.push(textNode, imageNode);
                        createdConnections.push({ id: nanoid(), fromNodeId: textNode.id, toNodeId: imageNode.id });
                        imageNodes.push(imageNode);
                    }
                    // `const` 收口：闭包里用 `imageNode` 会让 TS 丢掉 `null` 收窄，而这里只需要一个「有就用的 id」。
                    const imageTargetId = imageNode?.id;
                    const linkToImage = (fromNodeId: string) => {
                        if (!imageTargetId) return;
                        createdConnections.push({ id: nanoid(), fromNodeId, toNodeId: imageTargetId });
                        assetLinkCount += 1;
                    };
                    // 「按镜按资产」图位 + **资产锁定**：这一镜每一格该用哪张图 —— 格子图优先、资产锁兜底。
                    // 锁是按**资产名**记的，所以别的镜里出现同名（还是「张三」）时也认同一张 @图片。
                    const preciseRefs = scriptShotPreciseAssetRefs(source.metadata?.scriptCellAssets, nameLocks, shotNo, member.row, presetId, scriptExtras);
                    // 同一张图可能同时被「图位」「资产锁」「资产条」「镜头图」命中，连线去重，
                    // 免得画布上出现两条并行同源线。
                    const linkedIntoImage = new Set<string>();
                    for (const ref of preciseRefs) {
                        for (const preciseId of ref.ids) {
                            if (!existingNodeIds.has(preciseId) || linkedIntoImage.has(preciseId)) continue;
                            linkedIntoImage.add(preciseId);
                            linkToImage(preciseId);
                            groupAssetIds.add(preciseId);
                            groupAssetKinds.set(preciseId, ref.role);
                        }
                    }
                    // 角色 / 场景 / 道具 / 站位**各自按这一镜自己的名字**匹配（2026-11-08 第 13 条）：
                    // 以前「场景 / 道具 / 站位无条件每镜全连」→ 16 张图挂到一个镜头用不上的视频节点上。
                    // 现在只连这一镜真的写到的那几个；已被图位 / 资产锁精准指定过的列由
                    // `blankPreciseAssetColumns` + `coveredColumns` 让位 —— 精准优先、资产条兜底。
                    const barRow = blankPreciseAssetColumns(member.row, preciseRefs);
                    const barAssets = matchScriptRowAssetsByRole(barRow, upstreamAssets, {
                        preset: presetId,
                        extras: scriptExtras,
                        coveredColumns: new Set(preciseRefs.map((ref) => ref.columnKey)),
                    });
                    for (const asset of barAssets) {
                        if (linkedIntoImage.has(asset.id)) continue;
                        linkedIntoImage.add(asset.id);
                        linkToImage(asset.id);
                        groupAssetIds.add(asset.id);
                        groupAssetKinds.set(asset.id, resolveScriptAssetRole(asset.role));
                    }
                    // 这一镜自己的「镜头图」：只连到**这一镜**的图片节点；同时进 groupAssetIds，
                    // 于是下面会把它们一并连到该段的视频节点——即「按镜头把图片连到图片节点和视频节点」。
                    for (const rowAssetId of scriptRowAssetIds(source.metadata?.scriptRowAssets, shotNo)) {
                        if (!existingNodeIds.has(rowAssetId) || linkedIntoImage.has(rowAssetId)) continue;
                        linkedIntoImage.add(rowAssetId);
                        linkToImage(rowAssetId);
                        groupAssetIds.add(rowAssetId);
                        // 镜头图不是「资产」，排在资产之后（档位 `shot`）。
                        groupAssetKinds.set(rowAssetId, "shot");
                    }
                    // 资产文案：第四套写多行「资产锁定」块（`@图片1：李曼人物参考，锁定…`），
                    // 其余三套写单行「资产名@图片N」。两种都在输入框里能看到每张参考图是什么资产，
                    // 且 `@图片N` 会渲染成缩略图 chip。
                    // `linkedIntoImage` 是 Set、保序，正好就是刚才写连线的顺序（= 编号顺序），对得上输入框里的 chip。
                    // 简洁版没有图片节点：这段整段跳过，资产文案只落在视频节点上（见下面的 `videoBinding`）。
                    if (imageNode) {
                        const imageBinding = assetBindingOf(Array.from(linkedIntoImage), nodesRef.current, assetNameOf, assetRoleOf);
                        imageNode.metadata = { ...imageNode.metadata, prompt: withScriptAssetBinding(imageNode.metadata?.prompt, imageBinding) };
                    }
                    // 这一镜在表里「声音」列挂的音频：只属于这一镜，等下直连本组的视频节点。
                    for (const audioId of scriptRowAudioIds(source.metadata?.scriptRowAudios, shotNo)) {
                        if (existingNodeIds.has(audioId)) groupAudioIds.add(audioId);
                    }
                }

                const merged = members.length > 1;
                const shotNoFrom = first.row.shot_no || first.index + 1;
                const shotNoTo = last.row.shot_no || last.index + 1;
                const shots = members.map((member) => ({
                    shotNo: member.row.shot_no || member.index + 1,
                    // ⚠️ 只带视频段：视频节点不再拼分镜提示词（用户 2026-10-19 要求）。
                    // 分镜提示词已经在本镜的文本 / 图片节点上，视频节点拿的是它的关键帧首帧。
                    videoPrompt: member.prompts.videoPrompt,
                }));
                /**
                 * 参考图**连线顺序**（用户 2026-11-08 第 13 条）：角色 → 场景 → 道具 → 站位/特效 → 镜头图。
                 * 多个镜合成一个视频节点时，先把这几个镜涉及的角色都排上，再场景、再道具 —— 与「哪一镜写的」
                 * 无关，只按档位。⚠️ 这个顺序同时决定：① 写连线的先后；② 输入框里 chip 的先后（chip 顺序 =
                 * 上游连线数组顺序）；③ 「资产绑定 / 资产锁定」文案里 `@图片N` 的编号。三处必须同源。
                 */
                const orderedGroupAssetIds = orderScriptRefIds([...groupAssetIds], (assetId) => groupAssetKinds.get(assetId));
                // 视频节点的资产文案（第四套=资产锁定块，其余=资产绑定行）：本段所有资产图都是直连视频节点的，
                // 顺序与写连线时一致 —— orderedGroupAssetIds → 音频（音频只连视频、但不进「图片资产」文案，拼装时按 kind 过滤掉）。
                const videoBinding = assetBindingOf([...orderedGroupAssetIds, ...audioRefs.map((asset) => asset.id)], nodesRef.current, assetNameOf, assetRoleOf);
                const baseVideoPrompt = merged ? buildMergedVideoNodePrompt(shots) : buildVideoNodePrompt(shots[0].videoPrompt);
                // 合规后缀（用户 2026-11-11 第 02 条）必须**最后**拼：资产绑定块在前、禁止项 / 强制声明收尾。
                const videoPrompt = withVideoComplianceSuffix(withScriptAssetBinding(baseVideoPrompt, videoBinding));
                // 单镜模式：10/15 秒 = 锁定成片秒数（不抄表里旧值，否则「选了 10 秒铺出来还是 3 秒」）；
                // 5 秒 = 上限（表里更短就按表里）。合并模式仍按本段各镜 duration 累加。
                // ⚠️ 判据是 `merged`（本段真的有多镜）而**不是**档位：手动合并组在「单镜」档位下也是多镜，
                // 只看档位会把 3 镜合一的视频切成「第一镜的 5 秒」，画面却是三段连续动作。
                const seconds = !merged && mergeMode === "shot" ? resolveStoryScriptShotSeconds(first.row.duration, segmentSeconds) : Math.min(20, storyScriptGroupDuration({ rows: members.map((member) => member.row) }));
                const videoNode: CanvasNodeData = {
                    // 视频节点同样继承脚本节点选的风格模板（用户 2026-11-08 第 05 条）：铺完点生成时
                    // `composeStyledPrompt` 会把它拼到提示词尾部；窗口里的风格按钮显示同一档，可随时改。
                    // `scriptVideoMeta` = 反推节点上选的模型 / 比例 / 分辨率（用户 2026-11-09），
                    // 三个键为空时对象为空 → 与改造前逐字节一致。
                    //
                    // 选的是 MochiAni 引擎时改走下面那个分支：类型换成 `Mochiani`，提示词双写
                    // （`prompt` + `mochianiPrompt`，与节点窗口的手写逻辑同口径），模型 / 渠道 / 参数
                    // 从偏好预填 —— 用户在节点里改过一次就只影响那一个节点，不回写偏好。
                    ...(useMochianiVideo && mochianiPreference
                        ? createCanvasNode(CanvasNodeType.Mochiani, { x: 0, y: 0 }, {
                              prompt: videoPrompt,
                              mochianiPrompt: videoPrompt,
                              status: NODE_STATUS_IDLE,
                              ...scriptStyle,
                              mochianiConfig: buildMochianiNodeConfig(mochianiPreference, { aspectRatio: scriptVideoSize }),
                          })
                        : createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { prompt: videoPrompt, status: NODE_STATUS_IDLE, ...(seconds ? { seconds: String(seconds) } : {}), ...scriptStyle, ...scriptVideoMeta })),
                    title: merged ? t("canvas.scriptNode.pipelineVideoRange", { from: shotNoFrom, to: shotNoTo, count: members.length }) : t("canvas.scriptNode.pipelineVideo", { no: shotNoFrom }),
                    width: videoWidth,
                    height: videoHeight,
                    // 简洁版：紧凑竖排（第 0、1、2… 段），不按表格行高铺开 —— 没有图片节点要对齐，
                    // 按行高展开只会得到一长串带大段空白的窗口。
                    position: videoOnly ? { x: videoX, y: baseY + packIndex * (videoHeight + gapY) } : { x: videoX, y: topRow + (bottomRow - topRow - videoHeight) / 2 },
                };
                if (videoOnly) packIndex += 1;
                created.push(videoNode);
                createdVideoNodes.push(videoNode);
                // 这一段里的每个关键帧都喂给同一个视频节点 → 多镜合成一段连续视频。
                for (const imageNode of imageNodes) createdConnections.push({ id: nanoid(), fromNodeId: imageNode.id, toNodeId: videoNode.id });
                // 资产图也直接连到视频节点：视频生成窗口本身就是「已链接资产图片」的状态。
                // 脚本节点没连任何资产时 groupAssetIds 为空，这里自然一条都不加。
                // ⚠️ 一定要用排好序的 `orderedGroupAssetIds`（不是原始 Set）：参考图顺序就是连线顺序。
                for (const assetId of orderedGroupAssetIds) {
                    createdConnections.push({ id: nanoid(), fromNodeId: assetId, toNodeId: videoNode.id });
                    assetLinkCount += 1;
                }
                // 音频素材（背景音乐 / 配音）只连视频节点，每段视频都连上，用户可在视频窗口里换成该段要用的音轨。
                for (const audio of audioRefs) {
                    createdConnections.push({ id: nanoid(), fromNodeId: audio.id, toNodeId: videoNode.id });
                    assetLinkCount += 1;
                }
                // 表里「声音」列按镜挂的音频：同样只连视频节点，但**只连这一段**（合并模式时同段各镜的都会连上，
                // 于是这一段视频能看到它们全部；用户可在视频窗口里挑一条）。
                for (const audioId of groupAudioIds) {
                    // 已经是整表音频的就别连第二条：同一条线连两次会让视频窗口里出现两个同名音轨。
                    if (audioRefs.some((asset) => asset.id === audioId)) continue;
                    createdConnections.push({ id: nanoid(), fromNodeId: audioId, toNodeId: videoNode.id });
                    assetLinkCount += 1;
                }
            }

            /**
             * 把这一批视频节点**一起接进一个「视频合并」节点**（用户 2026-11-07 第 02 条）。
             *
             * 铺完链路不用再手动一个个连线：合并节点里已经按铺出的顺序排好时间线，
             * 生成完直接就能「导出到剪映」。
             *  - ⚠️ **只有一段视频也建、也连**（用户 2026-11-08 第 10 条报障）：
             *    原实现判 `>= 2`，于是「只铺出一个视频节点」时下游什么都没有，用户还得手动接一条线。
             *    现在的口径是「铺出来的每个视频节点都要有下游」——1 段照样建合并节点（标题写「1 段」，
             *    之后手动拖进第二段也直接可用）。判据只看「至少有一段」，别再加回 `>= 2`；
             *  - 时间线 `outSec` 先按该段视频节点请求的秒数占位 —— 生成前还没有真实时长，
             *    合并节点会把这些段标成「缺失」，生成后自然有内容；
             *  - 位置放在这一列视频节点的右侧、竖直居中，与链路之间留 `gapX`。
             */
            let mergeNode: CanvasNodeData | null = null;
            if (createdVideoNodes.length >= 1) {
                const mergeSpec = NODE_DEFAULT_SIZE[CanvasNodeType.VideoMerge];
                const rightmost = Math.max(...createdVideoNodes.map((node) => node.position.x + node.width));
                const top = Math.min(...createdVideoNodes.map((node) => node.position.y));
                const bottom = Math.max(...createdVideoNodes.map((node) => node.position.y + node.height));
                const clips: CanvasVideoMergeClip[] = createdVideoNodes.map((node) => ({
                    nodeId: node.id,
                    kind: "video",
                    title: node.title || node.id,
                    durationSec: undefined,
                    inSec: 0,
                    outSec: Number(node.metadata?.seconds) || 5,
                }));
                mergeNode = {
                    ...createCanvasNode(CanvasNodeType.VideoMerge, { x: 0, y: 0 }, { status: NODE_STATUS_IDLE, videoMergeClips: clips }),
                    title: t("canvas.scriptNode.pipelineMergeTitle", { count: createdVideoNodes.length }),
                    width: mergeSpec.width,
                    height: mergeSpec.height,
                    position: { x: rightmost + gapX, y: top + (bottom - top - mergeSpec.height) / 2 },
                };
                created.push(mergeNode);
                for (const node of createdVideoNodes) createdConnections.push({ id: nanoid(), fromNodeId: node.id, toNodeId: mergeNode.id });
            }
            /**
             * 把这一批视频节点**打成一个组**（用户 2026-11-07 第 3 条：「创建视频窗口并将这些窗口打组」）。
             *
             * 只框视频节点，不框合并节点 —— 合并节点是下游产物，圈进来会让「整组接进去」变成自环。
             * 组框和右键成组（`handleGroupSelected`）同一套口径：包围盒 + 留白，成员位置一个都不动。
             */
            let groupNode: CanvasNodeData | null = null;
            if (groupVideos && createdVideoNodes.length >= 2) {
                const frame = resolveGroupFrame(createdVideoNodes);
                if (frame) {
                    groupNode = {
                        ...createCanvasNode(CanvasNodeType.Group, { x: 0, y: 0 }),
                        title: t("canvas.scriptNode.pipelineVideoGroupTitle", { count: createdVideoNodes.length }),
                        position: frame.position,
                        width: frame.width,
                        height: frame.height,
                    };
                }
            }
            const groupMemberIds = new Set(createdVideoNodes.map((node) => node.id));
            /**
             * 组框要**垫在成员下面**（数组靠前 = 渲染靠后），否则半透明的框会盖在视频窗口上方、把它们压灰。
             * 与右键成组同一个处理：插到第一个成员的位置。
             */
            const applyGroup = (base: CanvasNodeData[]) => {
                if (!groupNode) return base;
                const next = attachNodesToGroup(base, groupMemberIds, groupNode.id);
                const firstMemberIndex = next.findIndex((node) => groupMemberIds.has(node.id));
                next.splice(firstMemberIndex < 0 ? next.length : firstMemberIndex, 0, groupNode);
                return next;
            };

            const shotCount = renderable.length;
            const videoCount = groups.length;
            // 确认文案四档：整表 / 选择 / 简洁版（含选择）/ 一键视频链路（固定每 N 镜一段）。
            const confirmTitleKey =
                chainMergeEvery > 0
                    ? "canvas.scriptNode.pipelineVideoChainConfirmTitle"
                    : videoOnly
                      ? selection
                          ? "canvas.scriptNode.pipelineVideoOnlySelectedConfirmTitle"
                          : "canvas.scriptNode.pipelineVideoOnlyConfirmTitle"
                      : selection
                        ? "canvas.scriptNode.pipelineSelectedConfirmTitle"
                        : "canvas.scriptNode.pipelineConfirmTitle";
            const confirmBodyKey =
                chainMergeEvery > 0
                    ? "canvas.scriptNode.pipelineVideoChainConfirmBody"
                    : videoOnly
                      ? selection
                          ? "canvas.scriptNode.pipelineVideoOnlySelectedConfirmBody"
                          : "canvas.scriptNode.pipelineVideoOnlyConfirmBody"
                      : selection
                        ? "canvas.scriptNode.pipelineSelectedConfirmBody"
                        : "canvas.scriptNode.pipelineConfirmBody";
            /**
             * 真正「铺链路（+ 逐个生成）」的那段。手动点按钮时它挂在 `modal.confirm` 的 `onOk` 上，
             * **行为一个字节不变**；「一键视频」走 `options.skipConfirm` 直接执行 ——
             * 那条流程前面已经有一次总确认，再弹一次会把自动化卡死在弹窗上。
             */
            const runPipeline = () => {
                // 铺链的同时把「资产名 → 图片」锁表落库，表上就能看到这些名字已经锁定。
                const nextLocks = Object.keys(nameLocks).length ? nameLocks : undefined;
                /**
                 * 「选择铺链路」顺手把这一段记成手动合并组：表上立刻出现 `⛓ 2/3` 徽标，
                 * 之后再点「一键铺链路」仍是同一段 —— 免得两条路径给出两种结果。
                 * 已有组与这一段重叠的整组丢掉（后来的覆盖前面的，与 `mergeSelectedRows` 同口径）。
                 */
                const nextMergeGroups =
                    selection && selection.length >= 2 && mergeEvery === 0
                        ? normalizeStoryScriptMergeGroups([...(source.metadata?.scriptMergeGroups || []).filter((span) => !span.some((index) => selection.includes(index))), selection], rows.length)
                        : undefined;
                const patchLocks = (item: CanvasNodeData) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, scriptNameLocks: nextLocks, ...(nextMergeGroups ? { scriptMergeGroups: nextMergeGroups } : {}) } } : item);
                nodesRef.current = applyGroup([...nodesRef.current.map(patchLocks), ...created]);
                setNodes((prev) => applyGroup([...prev.map(patchLocks), ...created]));
                setConnections((prev) => [...prev, ...createdConnections]);
                setSelectedNodeIds(new Set(created.map((node) => node.id)));
                setSelectedConnectionId(null);
                revealNodes(created, "center");
                message.success(
                    t(chainMergeEvery > 0 ? "canvas.scriptNode.pipelineVideoChainBuilt" : videoOnly ? "canvas.scriptNode.pipelineVideoOnlyBuilt" : "canvas.scriptNode.pipelineBuilt", {
                        shots: shotCount,
                        videos: videoCount,
                        count: mergeEvery,
                    }),
                );
                /**
                 * 逐个执行「生成」按钮（用户 2026-11-07 第 3 条）。
                 *
                 * ⚠️ **不等生成完成**：`generateNodeRef.current()` 返回的 Promise 要到整段视频出片
                 * （几分钟、含轮询）才 resolve；await 它就成了「等上一个出完再点下一个」，与
                 * 「生成间隔 2 秒 / 跑一遍就结束」完全不符。所以只 fire 不 await，间隔由 setTimeout 控。
                 * ⚠️ 顺序按画布摆放（上→下），见 `planScriptPipelineGenerateOrder`。
                 */
                if (autoGenerate) {
                    /**
                     * MochiAni 引擎**不代跑生成**（用户 2026-11-10 第 01 条只说「铺出 MochiAni 窗口」）。
                     *
                     * 原因不是偷懒：MochiAni 的执行是「预检 → 确认 → 落画布」三步，中间要认页面上下文、
                     * 账户余额与当前任务，一次只能驱动一个页面任务；而 `generateNodeRef` 是普通视频节点的
                     * 直连生成器（`mode: "video"`），对它无能为力。硬串成自动点击只会得到一串报错。
                     * 所以铺完只提示下一步在哪点，绝不假装已经跑起来了。
                     */
                    if (useMochianiVideo) {
                        message.info(t("canvas.scriptNode.pipelineMochianiBuilt", { count: createdVideoNodes.length }));
                    } else {
                            const targets = planScriptPipelineGenerateOrder(createdVideoNodes);
                            if (targets.length) {
                            message.info(
                                t("canvas.scriptNode.pipelineVideoGenerateStarted", {
                                    count: targets.length,
                                    seconds: SCRIPT_PIPELINE_GENERATE_INTERVAL_MS / 1000,
                                }),
                            );
                            /**
                             * **某段视频生成失败 → 换模型再生成一次；仍失败 → 暂停后续**（用户 2026-11-10 第 01 条）。
                             *
                             * 用户原话：「生成失败的视频再次使用偏好或者上一次设定选择的生视频模型生成一次，
                             * 若还是失败即暂停。」→ 候选模型只有两个：偏好里的视频模型、上一次「生成设置」里
                             * 选的（`scriptVideoModel`，铺链路时已写进每个视频节点的 `metadata.model`）。
                             *
                             * 🔴 两条老口径不能被「顺手改成串行」破坏：
                             *  ① 2 秒间隔是**两次点生成之间**，不是「等上一段出完再点下一段」（见 `script-pipeline-run.ts`）；
                             *  ② 视频分支自己吞掉异常（Promise 永远 resolve），成败只能读节点 `metadata.status`。
                             * 所以「发射」与「监督」拆开：for 循环保持 2 秒节奏只负责点生成，
                             * 每一发的等待 / 重试 / 暂停判定放在 `supervise()` 里并行跑。
                             */
                            const preferredVideoModel = resolveModelForCapability(effectiveConfig, undefined, "video");
                            const settingsVideoModel = scriptVideoModel;
                            // 一旦判定「暂停」，后面还没点的段就不再点了（已经在跑的等它自己落定）。
                            let pipelinePaused = false;
                            /** 换模型只能走 `metadata.model`（`buildGenerationConfig` 只认它），顺带把状态复位成 idle。 */
                            const patchVideoNodeModel = (targetNodeId: string, model: string) => {
                                const patch = (item: CanvasNodeData): CanvasNodeData =>
                                    item.id === targetNodeId
                                        ? { ...item, metadata: { ...item.metadata, ...(model ? { model } : {}), status: NODE_STATUS_IDLE, errorDetails: undefined } }
                                        : item;
                                nodesRef.current = nodesRef.current.map(patch);
                                setNodes((prev) => prev.map(patch));
                            };
                            const fireVideoGenerate = (target: { nodeId: string; prompt: string }) =>
                                Promise.resolve(generateNodeRef.current?.(target.nodeId, "video", target.prompt)).catch(() => undefined);
                            const videoNodeOf = (targetNodeId: string) => nodesRef.current.find((item) => item.id === targetNodeId);
                            const pauseVideoPipeline = (target: { nodeId: string; index: number }, triedLabels: string) => {
                                pipelinePaused = true;
                                const detail = t("canvas.scriptNode.pipelineVideoPaused", {
                                    shot: target.index + 1,
                                    models: triedLabels,
                                    error: videoNodeOf(target.nodeId)?.metadata?.errorDetails || t("canvas.projectPage.generationFailed"),
                                });
                                message.error(detail);
                                options?.onVideoPause?.(detail);
                            };
                            const superviseVideo = async (target: { nodeId: string; prompt: string; index: number }) => {
                                await fireVideoGenerate(target);
                                if (readScriptPipelineVideoOutcome(videoNodeOf(target.nodeId)) !== "error") return;
                                const failedModel = String(videoNodeOf(target.nodeId)?.metadata?.model || "");
                                const retryModel = resolveScriptPipelineRetryModel({ preferred: preferredVideoModel, settingsSelected: settingsVideoModel, failed: failedModel });
                                const triedLabels = [failedModel, retryModel].filter(Boolean).map((model) => modelOptionLabel(effectiveConfig, model));
                                message.warning(
                                    t("canvas.scriptNode.pipelineVideoRetry", {
                                        shot: target.index + 1,
                                        model: retryModel ? modelOptionLabel(effectiveConfig, retryModel) : t("canvas.scriptNode.oneClickScriptModelUnknown"),
                                    }),
                                );
                                patchVideoNodeModel(target.nodeId, retryModel || failedModel);
                                await fireVideoGenerate(target);
                                if (readScriptPipelineVideoOutcome(videoNodeOf(target.nodeId)) !== "error") return;
                                pauseVideoPipeline(target, triedLabels.join(" → "));
                            };
                            void (async () => {
                                const jobs: Promise<void>[] = [];
                                for (const target of targets) {
                                    if (target.index > 0) await new Promise((resolve) => setTimeout(resolve, SCRIPT_PIPELINE_GENERATE_INTERVAL_MS));
                                    if (pipelinePaused) break;
                                    jobs.push(superviseVideo(target));
                                }
                                await Promise.all(jobs);
                            })();
                        }
                    }
                }
            };
            if (options?.skipConfirm) {
                runPipeline();
                return;
            }
            modal.confirm({
                title: t(confirmTitleKey, { count: mergeEvery }),
                content: (
                    <div>
                        <div>{t(confirmBodyKey, { shots: shotCount, nodes: created.length, videos: videoCount, links: assetLinkCount, count: mergeEvery })}</div>
                        {mergeNode ? <div className="mt-1.5 opacity-70">{t("canvas.scriptNode.pipelineMergeHint", { count: createdVideoNodes.length })}</div> : null}
                        {groupNode ? <div className="mt-1.5 opacity-70">{t("canvas.scriptNode.pipelineVideoGroupHint", { count: createdVideoNodes.length })}</div> : null}
                        {autoGenerate && createdVideoNodes.length ? (
                            <div className="mt-1.5 opacity-70">{t("canvas.scriptNode.pipelineVideoGenerateHint", { count: createdVideoNodes.length, seconds: SCRIPT_PIPELINE_GENERATE_INTERVAL_MS / 1000 })}</div>
                        ) : null}
                    </div>
                ),
                okText: t(autoGenerate ? "canvas.scriptNode.pipelineVideoGenerate" : mergeEvery > 0 ? "canvas.scriptNode.pipelineVideoChain" : videoOnly ? "canvas.scriptNode.pipelineVideoOnly" : "canvas.scriptNode.pipelineBuild"),
                cancelText: t("common.cancel"),
                onOk: runPipeline,
            });
        },
        [effectiveConfig, message, modal, t, revealNodes],
    );

    /**
     * 「一键视频」编排（用户 2026-11-08 第 02 条）：
     *
     *  ① 生成分镜表 → ② 一键直接生图 → ③ 一键铺视频链路并生成
     *
     * 三条规则（都是用户口述，逐条落成代码，不要「优化」掉）：
     *  - 分镜表**报错**时用 `deepseek-flash(deepseek)` 再生成一次；仍报错 → **暂停**后续流程。
     *  - 分镜表最长等 **15 分钟**；到点既没报错也没成功 → **暂停**（并 abort 在跑的那一条）。
     *  - 生图里**角色 / 场景**报错 → 先用「配置偏好生图模型」重跑一次 → 仍报错 → 换
     *    `seedream-5.0-pro（猛蹬）` 对**报错的那几张**托底一次 → 仍失败 → **暂停**。
     *  - 生图最长等 **35 分钟**（用户 2026-11-11 第 01 条：一批图并发 + 两轮重试，15 分钟不够）；超时 → **暂停**。
     *
     * 「暂停」= 不再往下走 + 在节点按钮上标出暂停原因（`oneClickVideoRuns`，内存态）。
     * 已经铺出来的图片 / 视频节点一律**保留**：用户看得到失败在哪几张，手动补比清空更有用。
     */
    const [oneClickVideoRuns, setOneClickVideoRuns] = useState<Record<string, OneClickVideoRun>>({});
    /** 防连点：`useState` 更新是异步的，双击会在同一帧里进两次。 */
    const oneClickVideoRunningRef = useRef<Set<string>>(new Set());

    const patchOneClickVideoRun = useCallback((nodeId: string, run: OneClickVideoRun) => {
        setOneClickVideoRuns((prev) => ({ ...prev, [nodeId]: run }));
    }, []);

    /**
     * 「参考图直接当资产」：把反推节点上连进来的产品图挂到分镜表的道具格（用户 2026-11-09 口径）。
     *
     * 为什么要有这一步：用户拍/画好的产品图已经在手上了，再让模型照着分镜表描述生一张「差不多的口红」
     * 既是白花钱，也会让真产品在视频里走形。所以：
     *  ① 按名字把参考图对齐到表里的道具（`matchScriptAssetReferences`，只认道具）；
     *  ② 名字对不上时**兜底认成主角道具**：按「这件道具在表里出现几镜」从多到少挂上去 ——
     *     用户连这张图的意思就是「片子围着它拍」（用户 2026-11-09 口径：「优先把这个道具图作为
     *     分镜表中出现频率最高的道具资产」）。`via` 会标出是名字命中还是兜底认的；
     *  ③ 对齐上的 → 走 `mountScriptAssetToCells` 直接挂进那一格（`scriptCellAssets` 精准指定 +
     *     `scriptNameLocks` 按名兜底 + `scriptAssetRoles` 标成道具），铺链路时这一镜的视频节点就直连这张图；
     *  ④ 顺手把参考图连到脚本节点 —— 与「一键直接生图」出来的资产图同一个位置，用户看得出它是本表素材。
     * 返回命中资产的键（`分类:标题`），调用方把它交给 `handleDirectGenerateScriptAssets`
     * 的 `skipAssetKeys`，于是**已经挂上的产品不再生图**（这是「已经用了这个道具」的关键一步）。
     *
     * ⚠️ 表里一件道具都没有（或全被占满）才**什么都不做**：不挂、也不跳过生成。
     */
    const mountReferenceAssetsToScript = useCallback((scriptNodeId: string, references: readonly ScriptAssetReference[]) => {
        const source = nodesRef.current.find((item) => item.id === scriptNodeId);
        const unmatchedAll: ScriptAssetReference[] = [];
        if (!source) return { matched: [] as Array<{ nodeId: string; title: string; via: "name" | "hero" }>, skipAssetKeys: [] as string[], unmatched: unmatchedAll };
        const rows = source.metadata?.scriptRows;
        const { matches, unmatched } = references.length ? matchScriptAssetReferences(rows, references) : { matches: [], unmatched: [] as ScriptAssetReference[] };
        unmatchedAll.push(...unmatched);
        const skipAssetKeys = matches.map((match) => match.key);
        if (!matches.length) {
            /**
             * 一张都没挂上（含「这次根本没传参考图」）也要把上一次的挂载清单**清掉**：
             * 那份清单是「这些道具不许再生图」的唯一依据，留着会让用户把参考图删了以后
             * 那件道具永远不出图（改了剧本也照样不出）。
             */
            if (source.metadata?.scriptReferenceAssetKeys?.length) {
                const clear = (item: CanvasNodeData): CanvasNodeData => (item.id === scriptNodeId ? { ...item, metadata: { ...item.metadata, scriptReferenceAssetKeys: [] } } : item);
                nodesRef.current = nodesRef.current.map(clear);
                setNodes((prev) => prev.map(clear));
            }
            return { matched: [] as Array<{ nodeId: string; title: string; via: "name" | "hero" }>, skipAssetKeys: [] as string[], unmatched: unmatchedAll };
        }
        const extras = normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns);
        let cells = source.metadata?.scriptCellAssets;
        let locks = source.metadata?.scriptNameLocks;
        const roles: Record<string, ScriptAssetRole> = {};
        const mounted: Array<{ nodeId: string; title: string; via: "name" | "hero" }> = [];
        for (const match of matches) {
            // 表里查不到格位（名字被道具上限截掉之类）：跳过生成就够，不硬写一个空挂载。
            if (match.mounts.length) {
                const next = mountScriptAssetToCells({ cells, locks, mounts: match.mounts, nodeId: match.reference.nodeId, extras });
                cells = next.cells;
                locks = next.locks;
                mounted.push({ nodeId: match.reference.nodeId, title: match.title, via: match.via || "name" });
            }
            // 角色标记必须写：铺链路拼「资产绑定」文案时靠它认分类，缺了会被 `resolveScriptAssetRole`
            // 兜成「角色」，提示词里就会写成「XX人物参考」。
            roles[match.reference.nodeId] = match.role;
        }
        const patch = (item: CanvasNodeData): CanvasNodeData =>
            item.id === scriptNodeId
                ? {
                      ...item,
                      metadata: {
                          ...item.metadata,
                          scriptCellAssets: cells,
                          scriptNameLocks: locks,
                          scriptAssetRoles: { ...(item.metadata?.scriptAssetRoles || {}), ...roles },
                          // 落库：之后任何一轮「批量生成资产图」都靠它跳过这些道具（见 metadata 注释）。
                          scriptReferenceAssetKeys: skipAssetKeys,
                      },
                  }
                : item;
        // state 与 ref 同时写：紧接着的 `handleDirectGenerateScriptAssets` / 铺链路读的都是 ref。
        nodesRef.current = nodesRef.current.map(patch);
        setNodes((prev) => prev.map(patch));
        const existing = new Set(connectionsRef.current.map((conn) => `${conn.fromNodeId}->${conn.toNodeId}`));
        const additions = matches
            .map((match) => match.reference.nodeId)
            .filter((nodeId) => Boolean(nodeId) && !existing.has(`${nodeId}->${scriptNodeId}`))
            .map((nodeId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: scriptNodeId }));
        if (additions.length) {
            connectionsRef.current = [...connectionsRef.current, ...additions];
            setConnections((prev) => [...prev, ...additions]);
        }
        return { matched: mounted, skipAssetKeys, unmatched: unmatchedAll };
    }, []);

    const handleOneClickVideo = useCallback(
        /**
         * @param options.referenceAssets 反推节点上连进来的参考图（只有 03 会传）：分镜表出来后先按名字
         *        把它们挂到道具格，并把命中的道具从「一键直接生图」那一批里剔掉 —— 见
         *        `mountReferenceAssetsToScript`。不传 = 与以前完全一致。
         */
        async (nodeId: string, options?: { referenceAssets?: readonly ScriptAssetReference[] }) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || source.type !== CanvasNodeType.Script) return;
            if (oneClickVideoRunningRef.current.has(nodeId)) return;
            if (isNodeGenerating(nodeId)) {
                message.warning(t("canvas.scriptNode.oneClickBusy"));
                return;
            }
            oneClickVideoRunningRef.current.add(nodeId);

            const notify = (stage: OneClickVideoRun["stage"], key: string, params?: Record<string, string | number>) => patchOneClickVideoRun(nodeId, { status: "running", stage, message: t(key, params) });
            /** 暂停：按钮上留一行原因 + 一条 error 提示，然后结束整个流程。 */
            const pauseWith = (stage: OneClickVideoRun["stage"], text: string) => {
                patchOneClickVideoRun(nodeId, { status: "paused", stage, message: text });
                message.error(text);
            };
            /** 模型名 → 画布内部编码（`channelId::model`）；找不到就返回空串（调用方据此暂停）。 */
            const seekModel = (seek: Parameters<typeof pickOneClickModel>[1]) => {
                const target = pickOneClickModel(effectiveConfig.channels, seek);
                return target ? encodeChannelModel(target.channelId, target.modelName) : "";
            };
            /** 节点当前是否「还在跑」：`isNodeGenerating` 看请求表（同步注册，最可靠），状态位兜底。 */
            const isNodePending = (id: string) => {
                const node = nodesRef.current.find((item) => item.id === id);
                return isNodeGenerating(id) || node?.metadata?.status === NODE_STATUS_LOADING;
            };
            /** 等到这一批**全部落定**（成功或失败）或到点；到点先把还在跑的 abort 掉。 */
            const waitSettled = async (ids: string[], deadlineAt: number): Promise<"settled" | "timeout"> => {
                while (true) {
                    const pending = ids.filter(isNodePending);
                    if (!pending.length) return "settled";
                    if (Date.now() >= deadlineAt) {
                        pending.forEach((id) => stopGenerationForNode(id));
                        return "timeout";
                    }
                    await new Promise((resolve) => setTimeout(resolve, ONE_CLICK_POLL_INTERVAL_MS));
                }
            };
            /** 这一批里**没出图**的（宽口径：不是 success 或没有内容，都算失败）。 */
            const failedOf = (ids: string[]) =>
                ids.filter((id) => {
                    const node = nodesRef.current.find((item) => item.id === id);
                    return node?.metadata?.status !== NODE_STATUS_SUCCESS || !node.metadata?.content;
                });
            /**
             * 换模型再跑一批：模型只能通过 `metadata.model` 传下去（`buildGenerationConfig` 只认它），
             * 所以先把模型写进节点、同步 `nodesRef`，再一个个 fire。
             */
            const retryBatch = async (ids: string[], model: string, deadlineAt: number) => {
                const patch = (item: CanvasNodeData): CanvasNodeData => (ids.includes(item.id) ? { ...item, metadata: { ...item.metadata, ...(model ? { model } : {}), status: NODE_STATUS_IDLE, errorDetails: undefined } } : item);
                nodesRef.current = nodesRef.current.map(patch);
                setNodes((prev) => prev.map(patch));
                for (let index = 0; index < ids.length; index += SCRIPT_ASSET_LAUNCH_BATCH) {
                    for (const id of ids.slice(index, index + SCRIPT_ASSET_LAUNCH_BATCH)) {
                        const prompt = nodesRef.current.find((item) => item.id === id)?.metadata?.prompt || "";
                        if (!prompt.trim()) continue;
                        void Promise.resolve(generateNodeRef.current?.(id, "image", prompt)).catch(() => undefined);
                    }
                }
                return waitSettled(ids, deadlineAt);
            };

            try {
                // ---- ① 生成分镜表（报错 → deepseek-flash 重试一次；15 分钟封顶，重试共用这段预算）----
                const scriptDeadline = Date.now() + ONE_CLICK_STAGE_TIMEOUT_MS;
                const stopScript = () => handleStopScriptGeneration(nodeId);
                notify("script", "canvas.scriptNode.oneClickStageScript");
                /**
                 * 失败提示要**点名试过哪几个模型**（用户 2026-11-09：报错只看到「HTTP 402 / 500」，
                 * 分不清是哪条渠道挂了 —— 他手上两条文本渠道一条 402（没钱）一条 500（对方服务端故障））。
                 * 标签走 `modelOptionLabel`，会带上渠道名，用户才知道该去改哪个。
                 */
                const scriptTriedModels: string[] = [];
                const noteScriptModel = (model?: string) => {
                    const label = model ? modelOptionLabel(effectiveConfig, model) : "";
                    const text = label || t("canvas.scriptNode.oneClickScriptModelUnknown");
                    if (!scriptTriedModels.includes(text)) scriptTriedModels.push(text);
                };
                noteScriptModel(
                    nodesRef.current.find((item) => item.id === nodeId)?.metadata?.model || effectiveConfig.textModel || "",
                );
                const firstPass = await withDeadline(runScriptGeneration(nodeId), scriptDeadline, stopScript);
                if (firstPass.timedOut) {
                    pauseWith("script", t("canvas.scriptNode.oneClickScriptTimeout"));
                    return;
                }
                let outcome = firstPass.value;
                if (!outcome?.ok && !outcome?.cancelled) {
                    const retryModel = seekModel({
                        names: ONE_CLICK_SCRIPT_RETRY_MODEL_NAMES,
                        channelHints: ONE_CLICK_SCRIPT_RETRY_CHANNEL_HINTS,
                        capability: "text",
                    });
                    if (!retryModel) {
                        pauseWith("script", t("canvas.scriptNode.oneClickScriptRetryMissing"));
                        return;
                    }
                    noteScriptModel(retryModel);
                    notify("script", "canvas.scriptNode.oneClickScriptRetry", { model: modelOptionLabel(effectiveConfig, retryModel) });
                    const retryPass = await withDeadline(runScriptGeneration(nodeId, { model: retryModel }), scriptDeadline, stopScript);
                    if (retryPass.timedOut) {
                        pauseWith("script", t("canvas.scriptNode.oneClickScriptTimeout"));
                        return;
                    }
                    outcome = retryPass.value;
                }
                if (!outcome?.ok) {
                    if (outcome?.cancelled) {
                        // 用户自己点了停止 / 前置条件不满足：不算报错，别弹「失败」。
                        patchOneClickVideoRun(nodeId, { status: "paused", stage: "script", message: t("canvas.scriptNode.oneClickStopped") });
                        return;
                    }
                    pauseWith(
                        "script",
                        t("canvas.scriptNode.oneClickScriptFailed", {
                            models: scriptTriedModels.join(" → ") || t("canvas.scriptNode.oneClickScriptModelUnknown"),
                            error: outcome?.error || t("canvas.scriptNode.parseFailed"),
                        }),
                    );
                    return;
                }
                // 行数以 `runScriptGeneration` 的返回值为准（它同时已把新表同步进 `nodesRef`）。
                const rowCount = outcome.rows ?? nodesRef.current.find((item) => item.id === nodeId)?.metadata?.scriptRows?.length ?? 0;
                if (!rowCount) {
                    pauseWith("script", t("canvas.scriptNode.oneClickScriptEmpty"));
                    return;
                }

                // ---- ①.5 参考图（产品）直接挂成道具资产，并把这些道具剔出下一步的生图清单 ----
                // 必须排在这里：分镜表刚出来（stage ①）才有「道具名」可对齐；而 stage ② 要读挂载结果 + 跳过表。
                /**
                 * 参考图挂载结果分两种说法：名字对上的照旧提示；**兜底认的主角道具**单独提示一句 ——
                 * 自动认的东西必须让用户看得见，否则他只会疑惑「这张图凭什么挂到这件道具上」。
                 */
                let skipAssetKeys: string[] = [];
                /**
                 * ⚠️ 判的是「传没传这个字段」，不是「有没有图」：
                 * 03 永远会传（可能是空数组），空数组意味着**用户把参考图删了** → 要把上一次落库的
                 * `scriptReferenceAssetKeys` 清掉，否则那件道具会永远不再生图。手动点脚本节点的
                 * 「一键视频」不传（undefined）→ 不动这份清单，只沿用。
                 */
                if (options?.referenceAssets) {
                    const result = mountReferenceAssetsToScript(nodeId, options.referenceAssets);
                    skipAssetKeys = result.skipAssetKeys;
                    const named = result.matched.filter((item) => item.via !== "hero").map((item) => item.title);
                    const heroes = result.matched.filter((item) => item.via === "hero").map((item) => item.title);
                    if (named.length) message.success(t("canvas.scriptNode.oneClickReferenceMounted", { names: named.join("、") }));
                    if (heroes.length) message.info(t("canvas.scriptNode.oneClickReferenceHeroMounted", { names: heroes.join("、") }));
                    /**
                     * 没挂上的必须**说出来**：以前这里是静默的，用户只会看到「道具图又生了一张」，
                     * 完全不知道是名字没对上、还是表里压根没有道具格（2026-11-09 报障）。
                     */
                    const missed = result.unmatched.map((item) => item.title).filter(Boolean);
                    if (missed.length) message.warning(t("canvas.scriptNode.oneClickReferenceUnmounted", { names: missed.join("、") }));
                }

                // ---- ② 一键直接生图（偏好模型重试一次 → seedream-5.0-pro 托底一次；**35 分钟**封顶）----
                const imageDeadline = Date.now() + ONE_CLICK_IMAGE_STAGE_TIMEOUT_MS;
                notify("image", "canvas.scriptNode.oneClickStageImage");
                const launched = handleDirectGenerateScriptAssets(nodeId, { skipAssetKeys });
                const imageIds = launched.created.map((node) => node.id);
                if (!imageIds.length) {
                    // 表里没有可生成的资产 / 画布排不下：不算失败，直接进第三步（铺链路仍然有意义）。
                    message.info(t("canvas.scriptNode.oneClickImageSkipped"));
                } else {
                    if ((await waitSettled(imageIds, imageDeadline)) === "timeout") {
                        pauseWith("image", t("canvas.scriptNode.oneClickImageTimeout", { count: imageIds.length }));
                        return;
                    }
                    let failed = failedOf(imageIds);
                    if (failed.length) {
                        const preferredModel = resolveModelForCapability(effectiveConfig, undefined, "image");
                        notify("image", "canvas.scriptNode.oneClickImageRetry", {
                            count: failed.length,
                            model: modelOptionLabel(effectiveConfig, preferredModel),
                        });
                        // 偏好模型可能是空串（用户没配 imageModel）：空 = 保持节点原样，仍算「再跑一次」。
                        if ((await retryBatch(failed, preferredModel, imageDeadline)) === "timeout") {
                            pauseWith("image", t("canvas.scriptNode.oneClickImageTimeout", { count: failed.length }));
                            return;
                        }
                        failed = failedOf(failed);
                    }
                    if (failed.length) {
                        const fallbackModel = seekModel({
                            names: ONE_CLICK_IMAGE_FALLBACK_MODEL_NAMES,
                            channelHints: ONE_CLICK_IMAGE_FALLBACK_CHANNEL_HINTS,
                            capability: "image",
                        });
                        if (!fallbackModel) {
                            pauseWith("image", t("canvas.scriptNode.oneClickImageFallbackMissing", { count: failed.length }));
                            return;
                        }
                        notify("image", "canvas.scriptNode.oneClickImageFallback", {
                            count: failed.length,
                            model: modelOptionLabel(effectiveConfig, fallbackModel),
                        });
                        if ((await retryBatch(failed, fallbackModel, imageDeadline)) === "timeout") {
                            pauseWith("image", t("canvas.scriptNode.oneClickImageTimeout", { count: failed.length }));
                            return;
                        }
                        failed = failedOf(failed);
                    }
                    if (failed.length) {
                        pauseWith("image", t("canvas.scriptNode.oneClickImageFailed", { count: failed.length }));
                        return;
                    }
                }

                // ---- ③ 一键铺视频链路并生成（不再弹确认：本条流程前面已经确认过）----
                notify("pipeline", "canvas.scriptNode.oneClickStagePipeline");
                /**
                 * 铺链路是 fire-and-forget（2 秒一段点下去就返回），所以这里不能 await；
                 * 「某段换模型重试仍失败 → 暂停」的消息由 `onVideoPause` 回到这条运行态上
                 * （晚于下面的 done 覆盖，于是按钮最后显示的是红色暂停原因，而不是「已完成」）。
                 */
                handleBuildScriptPipeline(nodeId, undefined, {
                    videoOnly: true,
                    group: true,
                    autoGenerate: true,
                    skipConfirm: true,
                    onVideoPause: (detail) => patchOneClickVideoRun(nodeId, { status: "paused", stage: "pipeline", message: detail }),
                });
                patchOneClickVideoRun(nodeId, { status: "done", stage: "pipeline", message: t("canvas.scriptNode.oneClickDone") });
                message.success(t("canvas.scriptNode.oneClickDone"));
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                pauseWith("script", t("canvas.scriptNode.oneClickError", { error: detail }));
            } finally {
                oneClickVideoRunningRef.current.delete(nodeId);
            }
        },
        [effectiveConfig, handleBuildScriptPipeline, handleDirectGenerateScriptAssets, handleStopScriptGeneration, isNodeGenerating, message, mountReferenceAssetsToScript, patchOneClickVideoRun, resolveModelForCapability, runScriptGeneration, stopGenerationForNode, t],
    );

    /**
     * 反推固定用 `gemini-3.8-flash`（toapis 渠道）—— 用户口径：「执行反推命令时默认选它」。
     *
     * 走 `pickOneClickModel` 而不是直接拼 `encodeChannelModel`：渠道可能改名、模型可能挂在别的渠道上，
     * 按「模型名 + 渠道名提示」找比写死 id 稳（和「一键视频」挑模型同一套口径）。
     * 找不到（渠道被禁用 / 模型被删）就返回空串，调用方回落到偏好里的文本模型 ——
     * 硬塞一个画布上不存在的 model 只会换来一次 400。
     */
    const reverseVideoModel = useMemo(() => {
        const target = pickOneClickModel(effectiveConfig.channels, { names: ["gemini-3.8-flash"], channelHints: ["toapis"], capability: "text" });
        return target ? encodeChannelModel(target.channelId, target.modelName) : "";
    }, [effectiveConfig.channels]);
    const reverseVideoModelLabel = useMemo(() => (reverseVideoModel ? modelOptionLabel(effectiveConfig, reverseVideoModel) : ""), [effectiveConfig, reverseVideoModel]);

    /**
     * 「反推视频」三条命令的编排（节点 `CanvasReverseVideoNodeContent` → 这里）。
     *
     * 统一骨架：
     *  ① 建一个 AI 对话节点，把**接入的视频从左侧连进去** —— 模型能看到的视频输入只认连线，
     *     光在提示词里写一句链接对本地视频毫无意义（`sendChatMessage` 会把连线视频转成 video_url 或抽帧）。
     *  ② 这个对话节点上只勾「视频反推-分镜提示词」一个技能：反推是一次性任务，多勾会把输出带偏。
     *  ③ 技能挑不到就**直接报错返回**，绝不静默换成「不带技能硬跑」——那样模型自由发挥，用户还以为反推过了。
     *  ④ 回复正文落成文本节点（内容三件套一起写：`content` / `prompt` / `composerContent`）。
     *  ⑤ 只有 03 才继续：文本节点 → 脚本生成器 → `handleOneClickVideo`（一键视频）。
     */
    const runVideoReverse = useCallback(
        async (input: { videoNodeId: string; mode: VideoReverseMode; requirement?: string; reverseNodeId?: string; scriptScheme?: string; shotsPerClip?: number }, report: (stage: string) => void = () => undefined): Promise<VideoReverseResult> => {
            const videoNode = nodesRef.current.find((item) => item.id === input.videoNodeId);
            if (!videoNode || videoNode.type !== CanvasNodeType.Video || !videoNode.metadata?.content) {
                return { ok: false, error: "接入的视频节点已经不在了，请重新接入一次" };
            }
            /**
             * 反推节点上**除视频以外**连进来的参考图（图节点）—— 用户 2026-11-09 口径：
             * 「链接了参考图和视频再去执行 02/03 时，若参考图是产品，需要把该产品道具在一键视频时
             * 直接挂到具体的产品道具中」。这里只负责**收集**，是不是产品 / 挂哪一格由
             * `mountReferenceAssetsToScript` 在分镜表出来之后按名字判断。
             */
            const referenceAssets: ScriptAssetReference[] = [];
            if (input.reverseNodeId) {
                for (const connection of connectionsRef.current) {
                    if (connection.toNodeId !== input.reverseNodeId) continue;
                    const node = nodesRef.current.find((item) => item.id === connection.fromNodeId);
                    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) continue;
                    if (referenceAssets.some((item) => item.nodeId === node.id)) continue;
                    referenceAssets.push({ nodeId: node.id, title: node.title || "", prompt: node.metadata?.prompt || "" });
                }
            }
            const skill = pickVideoReverseSkill(listChatSkills());
            if (!skill) {
                return { ok: false, error: "技能库里没找到「视频反推-分镜提示词」：先在 AI 对话节点的技能列表里确认它已经装好" };
            }
            /**
             * 节点窗口里选好的**目标视频参数**（风格 / 模型 / 总时长 / 比例 / 分辨率，用户 2026-11-09）。
             *
             * 读的是「反推节点自己」的 metadata（`input.reverseNodeId`）——它跟视频节点没关系，别拿错。
             * 节点不在（老画布 / 探针直接调函数）就给一份归一化后的默认值（秒数 30、其余跟随全局）。
             */
            const reverseNode = input.reverseNodeId ? nodesRef.current.find((item) => item.id === input.reverseNodeId) : undefined;
            const target = readReverseVideoTarget(reverseNode?.metadata);

            const videoUrl = videoNode.metadata.content;
            const gap = 120;
            /**
             * 落位（用户 2026-11-09）：「创建出来的窗口都堆在同一个点上」。
             *
             * 以前三件套按 `视频节点.right + 间距` 依次排 —— 锚点永远是这个视频节点，
             * 同一个视频跑两次，两条链的坐标一模一样，第二次就精确盖在第一次上；
             * 视频节点右侧本来就有别的窗口时，第一条链也就直接压上去了。
             * 现在统一走 `planRightwardChainSlots`：从视频节点右侧开始**往右找空地**，
             * 不压任何已有窗口、也不在原点附近打转。三个尺寸要一起算，所以 spec 先取好。
             */
            const chainSlots = planRightwardChainSlots({
                source: { position: videoNode.position, width: videoNode.width, height: videoNode.height },
                sizes: [NODE_DEFAULT_SIZE[CanvasNodeType.Chat], NODE_DEFAULT_SIZE[CanvasNodeType.Text], NODE_DEFAULT_SIZE[CanvasNodeType.Script]],
                occupied: collectCanvasOccupied(nodesRef.current),
                gap,
            });
            const [chatSlot, textSlot, scriptSlot] = chainSlots;
            /**
             * 一次落盘（state + nodesRef 同时写）。
             * ⚠️ 必须同步 `nodesRef`：`handleOneClickVideo` / `runScriptGeneration` 全都读 ref，
             * 只 `setNodes` 的话同一次点击里后续步骤根本看不到刚建的节点。
             */
            const pushNodes = (created: CanvasNodeData[], pairs: Array<{ fromNodeId: string; toNodeId: string }> = []) => {
                const nodesNext = [...nodesRef.current, ...created];
                const existing = new Set(connectionsRef.current.map((conn) => `${conn.fromNodeId}->${conn.toNodeId}`));
                const additions = pairs.filter((pair) => !existing.has(`${pair.fromNodeId}->${pair.toNodeId}`)).map((pair) => ({ id: nanoid(), ...pair }));
                const connectionsNext = [...connectionsRef.current, ...additions];
                nodesRef.current = nodesNext;
                connectionsRef.current = connectionsNext;
                setNodes(nodesNext);
                setConnections(connectionsNext);
                setSelectedNodeIds(new Set(created.map((node) => node.id)));
                setSelectedConnectionId(null);
            };

            // ① 对话节点（视频从左侧连入）
            report("创建 AI 对话节点…");
            const chatNode = createCanvasNode(
                CanvasNodeType.Chat,
                chatSlot,
                {
                    status: NODE_STATUS_IDLE,
                    messages: [],
                    chatTextEnabled: true,
                    chatImageEnabled: false,
                    // 反推固定走 gemini-3.8-flash（toapis 渠道）；该模型不可用时才回落到偏好里的文本模型。
                    model: reverseVideoModel || resolveModelForCapability(effectiveConfig, effectiveConfig.textModel, "text"),
                    imageModel: resolveModelForCapability(effectiveConfig, effectiveConfig.imageModel, "image"),
                    chatSkillIds: [skill.id],
                },
            );
            /**
             * 视频必连：模型只看得到**连线传入**的内容。
             *
             * 02 / 03 再把连进反推节点的参考图**一起连进这个对话节点**（用户 2026-11-09 口径：
             * 「要求框里写 @图片1 当文案中的道具」）。为什么非连不可：`sendChatMessage` 认的
             * mention 是 `buildNodeMentionReferences`（= 连在**对话节点**上的资源，按连线顺序编号），
             * 只在文字里写 `@图片1` 而图没连上，模型拿到的是一个指不到任何图片的标签 ——
             * 而这里逐张 `push` 的顺序与 `referenceAssets`（= 反推节点上的连线顺序）一致，
             * `@图片1` 才对得上用户看到的第一张。
             *
             * 01 不连：01 是纯反推，没有 `@图片N` 可引用，多塞几张参考图只会干扰它对原视频的判断。
             */
            const chatPairs = resolveConnectionPairs(videoNode.id, chatNode.id, [...nodesRef.current, chatNode], "source");
            if (input.mode !== 1) {
                for (const asset of referenceAssets) {
                    const imageNode = nodesRef.current.find((item) => item.id === asset.nodeId);
                    if (!imageNode) continue;
                    chatPairs.push(...resolveConnectionPairs(imageNode.id, chatNode.id, [...nodesRef.current, chatNode], "source"));
                }
            }
            pushNodes([chatNode], chatPairs);

            // ② 把视频链接 + 要求发进对话，等它把反推结果说完
            report("把视频链接发进对话，反推中…");
            let body = (await sendChatMessage(chatNode.id, buildVideoReversePrompt({ videoUrl, mode: input.mode, requirement: input.requirement, targetSeconds: target.seconds }), { text: true, image: false })).trim();
            /**
             * 语言兜底（用户 2026-11-09：「强化执行反推节点任务时，输出的文案文本内容必须为中文」）。
             *
             * 提示词里那条硬要求已经首尾各钉了一次，但用户装的技能包正文若是整篇英文（模板 + 示例 + 字段名），
             * 模型仍会照抄。所以这里做**确定性**收口：只有整篇明显不是中文时（`needsChineseRewrite`：
             * 汉字数 < 英文词数的一半，且英文词 ≥ 20）才多打一轮「只换语言、不动内容」的重写。
             * 重写失败 / 返回空就**沿用第一份** —— 绝不因为这一轮把已经跑通的任务判失败。
             */
            if (body && needsChineseRewrite(body)) {
                report("输出不是中文，正在让模型原样改写成中文…");
                const rewritten = (await sendChatMessage(chatNode.id, VIDEO_REVERSE_REWRITE_PROMPT, { text: true, image: false })).trim();
                if (rewritten) body = rewritten;
            }
            /**
             * 02 / 03 的**确定性清洗**（用户 2026-11-11 第 02 条：「总给我出一堆没用的注释内容，
             * 导致我想要的同类型剧本都生成不完」）。
             *
             * 提示词里已经把「只输出剧本正文」写了两遍，但模型仍会在开头寒暄、结尾加「注：…」，
             * 甚至把整段包进 ``` 代码块 —— 文本节点会原样显示，03 还要拿它喂脚本生成器。这里统一收口：
             * 只剥「整体代码块包裹 / 开头客套 / 结尾后记」三类，**绝不删正文**（判据见
             * `cleanVideoReverseScriptOutput`）。
             * ⚠️ **01 不清洗**：01 的输出就是分镜提示词表，「说明 / 注意」是它的正常内容。
             */
            if (body && input.mode !== 1) body = cleanVideoReverseScriptOutput(body);
            if (!body) {
                return {
                    ok: false,
                    error: "对话没有返回文本：检查文本模型是否已配置、技能「视频反推-分镜提示词」是否可用（也可能被手动停止了）",
                    chatNodeId: chatNode.id,
                };
            }

            // ③ 结果落文本节点
            report("把反推结果写进文本节点…");
            const textNode = {
                ...createCanvasNode(
                    CanvasNodeType.Text,
                    textSlot,
                    {
                        content: body,
                        prompt: body,
                        composerContent: body,
                        promptSyncAt: Date.now(),
                        status: NODE_STATUS_SUCCESS,
                        fontSize: DEFAULT_CANVAS_FONT_SIZE,
                    },
                ),
                title: input.mode === 1 ? "反推分镜提示词" : "同款文案",
            };
            pushNodes([textNode]);

            if (input.mode !== 3) return { ok: true, chatNodeId: chatNode.id, textNodeId: textNode.id };

            // ④ 03：文本节点 → 脚本生成器（新节点，右接），然后一键视频
            report("创建脚本生成器节点并接上文案…");
            /**
             * 脚本节点**一建出来就带上目标参数**（用户 2026-11-09）：
             *  - `scriptTotalSeconds`：写剧本时按这个秒数规划镜数与台词量；
             *  - `scriptVideoModel` / `scriptVideoSize` / `scriptVideoQuality`：铺链路时写进每个视频节点；
             *  - `styleTemplateId`：脚本节点本来就有的风格字段，铺链路时同时落到关键帧图片和视频节点上；
             *  - `scriptImageSize` 也写同一个比例：关键帧必须和成片同画幅，否则视频模型要裁切。
             *
             * 比例 / 分辨率**恒写**（用户 2026-11-11 第 02 条：「比例默认 16:9，分辨率优先 720p」）：
             * 窗口里没选过时 `resolveReverseVideoSize / resolveReverseVideoQuality` 给的就是默认值，
             * 与窗口里显示的、设置摘要里写的是同一份 —— 三处不同步的话用户会以为改成默认没生效。
             * 模型仍只在用户**明确选过**时才写（`target.model` 空 = 动态跟随偏好里的视频模型，
             * 写死反而会让之后改偏好不再生效）。
             */
            const scriptTargetMeta: Partial<CanvasNodeData["metadata"]> = {
                ...(target.styleTemplateId ? { styleTemplateId: target.styleTemplateId } : {}),
                /**
                 * **恒写**（用户 2026-11-11 第 02 条：「反推窗口设了时长，执行 03 要能同步到脚本生成器的分镜时长」）：
                 * 窗口里没改过 → 按默认 30 秒写进去。以前是「target.seconds 有值才写」，于是同一次
                 * 「设了 30 秒 → 03」在脚本节点上看到的是**空**（界面靠 resolve 补成 30），
                 * 一旦以后默认值改动，两边就会分叉。写死成解析后的有效值，脚本节点打开就看得见。
                 */
                scriptTotalSeconds: resolveScriptTotalSeconds({ scriptTotalSeconds: target.seconds }),
                scriptImageSize: resolveReverseVideoSize(target),
                scriptVideoSize: resolveReverseVideoSize(target),
                scriptVideoQuality: resolveReverseVideoQuality(target),
                ...(target.model ? { scriptVideoModel: target.model } : {}),
                // 02 里选了「MochiAni 生视频节点」→ 03 建脚本节点时记住引擎，铺链路时才知道建哪种窗口
                // （用户 2026-11-10 第 02 条：「同上，后续在脚本生成器执行生视频时，也铺的是该节点」）。
                ...(isMochianiVideoEngine(target.videoEngine) ? { scriptVideoEngine: MOCHIANI_VIDEO_ENGINE } : {}),
                // 「每 3 个镜头合一个视频」（用户 2026-11-11 第 01 条）：反推节点上开了就带过来，
                // 于是 03 紧接着跑的一键视频 / 之后手点铺链路都是 3 镜一个视频节点。
                // 取 `input.shotsPerClip` 优先：开关刚点完 metadata 还没提交时也能生效（同 scriptScheme 那个坑）。
                ...(Number(input.shotsPerClip ?? target.shotsPerClip) === SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT ? { scriptShotsPerClip: SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT } : {}),
            };
            /**
             * 🔴 执行方案必须**建节点时就写进去**（用户 2026-11-09 报障：「03 出来的视频运动提示词
             * 不是第四套那套八段格式」）。
             *
             * 手点新建的脚本节点靠组件挂载后的自动预填拿到方案；但 03 是**同一次点击里**先建节点、
             * 紧接着 `handleOneClickVideo` → `runScriptGeneration` —— React 还没提交渲染，组件还没挂载，
             * 生成就已经读到 `scriptScheme: undefined`（= 第一套内置提示词），第四套的
             * `video_motion_prompt` 八段硬约束（`STORY_SCRIPT_DIRECTOR_VIDEO_FORMAT`）压根没进 system / 任务书；
             * 等 effect 把方案补上时表已经按内置的括号链格式生成完了，铺链路又按第四套拼风格行 —— 两头对不上。
             *
             * 这里用与组件**同一个纯函数**（`buildScriptSchemeSeed`）算好整份补丁，建节点时一次落库，
             * 生成立刻就能读到。词库 / 技能库里取不到内容时它是 `null`，行为与改造前一致（停在第一套）。
             *
             * 用户在 03 弹窗里**点了第几套**（2026-11-10）时走 `explicit` 分支：不再跑默认判定，
             * 直接照那一套写方案 + 预填三段（第一套 = 只写方案、三段留空 = 内置提示词）。
             * 取值优先用本次调用的入参（弹窗刚改、metadata 还没提交时也生效），其次用节点上存的选择。
             */
            const chosenScheme = asScriptSchemeId(input.scriptScheme) ?? asScriptSchemeId(target.scriptScheme);
            const scriptSchemeSeed = buildScriptSchemeSeed({ scheme: chosenScheme || undefined, explicit: Boolean(chosenScheme), textPrompts: effectiveConfig.textPrompts, skills: chatSkillPacks }) || {};
            const scriptNode = createCanvasNode(CanvasNodeType.Script, scriptSlot, { status: NODE_STATUS_IDLE, scriptSource: "", scriptPrompt: "", scriptRows: [], ...scriptSchemeSeed, ...scriptTargetMeta });
            pushNodes([scriptNode], resolveConnectionPairs(textNode.id, scriptNode.id, [...nodesRef.current, scriptNode], "source"));

            report(referenceAssets.length ? `执行一键视频（参考图 ${referenceAssets.length} 张会先按名字挂到道具格，最长约 45 分钟）…` : "执行一键视频（进度见脚本节点，最长约 45 分钟）…");
            await handleOneClickVideo(scriptNode.id, { referenceAssets });
            return { ok: true, chatNodeId: chatNode.id, textNodeId: textNode.id, scriptNodeId: scriptNode.id };
        },
        [chatSkillPacks, effectiveConfig.imageModel, effectiveConfig.textModel, effectiveConfig.textPrompts, handleOneClickVideo, resolveModelForCapability, reverseVideoModel, sendChatMessage],
    );

    /** 「反推视频」节点里可选的目标：画布上所有有内容的视频节点。 */
    const videoReverseOptions = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content)).map((node) => ({ id: node.id, title: node.title || "视频", url: node.metadata?.content || "" })), [nodes]);
    /** 当前选中的视频节点：节点里「接入视频」优先接它，少一步选择。 */
    const videoReverseSelectedId = useMemo(() => {
        for (const nodeId of selectedNodeIds) {
            const node = nodes.find((item) => item.id === nodeId);
            if (node?.type === CanvasNodeType.Video && node.metadata?.content) return node.id;
        }
        return null;
    }, [nodes, selectedNodeIds]);

    /** 只给某一行分镜建一个视频节点（预填该镜视频提示词 / 时长，并把命中的角色素材 + 全局素材连上）。 */
    const handleBuildShotVideo = useCallback(
        (nodeId: string, rowIndex: number, options?: { stackIndex?: number; silent?: boolean }) => {
            const source = nodesRef.current.find((item) => item.id === nodeId);
            if (!source || source.type !== CanvasNodeType.Script) return;
            const rows = source.metadata?.scriptRows || [];
            const row = rows[rowIndex];
            if (!row) return;
            const presetId = resolveStoryScriptPresetId(source.metadata?.scriptPreset);
            const preset = getStoryScriptPreset(presetId);
            const directorScheme = resolveScriptSchemeId(source.metadata?.scriptScheme) === "director";
            // 与「一键铺链」同口径：风格提示词可能来自自建列（列名带「风格」），所以 extras 必须一起传。
            // `dropVideoStyle` 同理：脚本节点选了风格模板 → 这个视频节点的提示词不带「视觉风格：…」那一行。
            const shotExtras = normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns);
            const prompts = preset.buildShotPrompts(row, shotExtras, { directorScheme, dropVideoStyle: Boolean(source.metadata?.styleTemplateId) });
            const shotNo = row.shot_no || rowIndex + 1;
            // 与「一键铺链」同口径：单镜时长档位（10/15 锁定、5 是上限、none 按表里）。
            const seconds = resolveStoryScriptShotSeconds(row.duration, source.metadata?.scriptSegmentSeconds);
            // 与「一键铺链路」同口径：脚本节点选了 MochiAni 引擎，逐镜建出来的也是 MochiAni 窗口
            // （用户 2026-11-10 第 01 条 —— 「后续的铺视频链路」包含单镜 / 多选铺视频这两条入口）。
            const shotUseMochiani = isMochianiVideoEngine(source.metadata?.scriptVideoEngine);
            const shotMochianiPreference = shotUseMochiani ? resolveMochianiPreference(effectiveConfig) : null;
            const shotVideoType = shotUseMochiani ? CanvasNodeType.Mochiani : CanvasNodeType.Video;
            const videoWidth = NODE_DEFAULT_SIZE[shotVideoType].width;
            const videoHeight = NODE_DEFAULT_SIZE[shotVideoType].height;
            // 与「一键铺链路」同口径：视频节点只放视频段，不再拼分镜提示词（用户 2026-10-19 要求）；
            // 也不再拿 imagePrompt 兜底 —— 那一兜就是把分镜提示词整段灌进视频节点。
            const videoPrompt = buildVideoNodePrompt(prompts.videoPrompt);
            const videoNode: CanvasNodeData = {
                ...(shotUseMochiani && shotMochianiPreference
                    ? createCanvasNode(CanvasNodeType.Mochiani, { x: 0, y: 0 }, {
                          prompt: videoPrompt,
                          mochianiPrompt: videoPrompt,
                          status: NODE_STATUS_IDLE,
                          // 与「一键铺链路」同口径：单行建出来的窗口也默认继承脚本节点的风格模板
                          ...(source.metadata?.styleTemplateId ? { styleTemplateId: source.metadata.styleTemplateId } : {}),
                          mochianiConfig: buildMochianiNodeConfig(shotMochianiPreference, { aspectRatio: resolveStoryScriptImageSize(source.metadata?.scriptVideoSize) }),
                      })
                    : createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, {
                          prompt: videoPrompt,
                          status: NODE_STATUS_IDLE,
                          ...(seconds ? { seconds: String(seconds) } : {}),
                          // 与「一键铺链路」同口径：单行建出来的视频节点也默认继承脚本节点的风格模板
                          // （2026-11-08 第 05 条：脚本里选了风格，生图与生视频窗口都默认跟着走）。
                          ...(source.metadata?.styleTemplateId ? { styleTemplateId: source.metadata.styleTemplateId } : {}),
                      })),
                title: t("canvas.scriptNode.pipelineVideo", { no: shotNo }),
                width: videoWidth,
                height: videoHeight,
                // 批量铺视频时按序往下错开，否则 N 个节点会精确叠在同一处。
                position: { x: source.position.x + source.width + 64, y: source.position.y + (source.height - videoHeight) / 2 + (options?.stackIndex || 0) * (videoHeight + 40) },
            };
            const assetRoleOf = (assetNodeId: string) => resolveScriptAssetRole(source.metadata?.scriptAssetRoles?.[assetNodeId]);
            const upstreamNodes = Array.from(new Set(connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId)))
                .map((id) => nodesRef.current.find((node) => node.id === id))
                .filter((node): node is CanvasNodeData => Boolean(node));
            const upstreamAssets = upstreamNodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)).map((node) => ({ id: node.id, title: node.title, role: assetRoleOf(node.id) }));
            // 「按镜按资产」图位 + **资产锁定**：这一镜每一格该用哪张图（格子图优先、按资产名的锁兜底）；
            // 它们精准指定过的那几个分类，让资产条不再对同一镜重复分派。
            const nameLocks = syncStoryScriptNameLocks(source.metadata?.scriptNameLocks, source.metadata?.scriptCellAssets, rows, shotExtras);
            // 「资产名」查表：与整条铺链路同口径 —— 表里的资产名优先，查不到回落到图片节点标题。
            const assetNameOf = (assetNodeId: string) => {
                const locks = source.metadata?.scriptNameLocks;
                for (const [name, ids] of Object.entries(locks || {})) {
                    if (Array.isArray(ids) && ids.includes(assetNodeId)) return name;
                }
                return undefined;
            };
            // 第四套用多行「资产锁定」块，其余三套保持老的单行「资产绑定」（与整条铺链路同口径）。
            const assetBindingOf = directorScheme ? buildScriptAssetLockPrompt : buildScriptAssetBindingPrompt;
            const preciseRefs = scriptShotPreciseAssetRefs(source.metadata?.scriptCellAssets, nameLocks, shotNo, row, presetId, shotExtras);
            const cellAssetRefs = preciseRefs.flatMap((ref) => ref.ids).filter((id) => nodesRef.current.some((node) => node.id === id));
            // 与整条铺链路同口径（2026-11-08 第 13 条）：角色 / 场景 / 道具 / 站位都**按这一镜自己的列**匹配，
            // 不再「场景 / 道具 / 站位无条件全连」——否则一镜搭上整张表的十几张资产图。
            const barRow = blankPreciseAssetColumns(row, preciseRefs);
            const assets = matchScriptRowAssetsByRole(barRow, upstreamAssets, {
                preset: presetId,
                extras: shotExtras,
                coveredColumns: new Set(preciseRefs.map((ref) => ref.columnKey)),
            });
            // 音频素材只连视频节点（不参与生图），与整条铺链路一致。
            const audioRefs = upstreamNodes.filter((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey));
            // 这一镜自己的「镜头图」也直连视频节点；已删掉的图片节点直接跳过。
            const rowAssetRefs = scriptRowAssetIds(source.metadata?.scriptRowAssets, shotNo).filter((id) => nodesRef.current.some((node) => node.id === id));
            // 这一镜在表里「声音」列挂的音频：只连视频节点（同口径：已删的跳过）。
            const rowAudioRefs = scriptRowAudioIds(source.metadata?.scriptRowAudios, shotNo).filter((id) => nodesRef.current.some((node) => node.id === id));
            // 去重：同一张图可能同时是「图位 / 锁的图」和「镜头图」，别连出两条并行线。
            const linkIds = Array.from(new Set([...assets.map((asset) => asset.id), ...audioRefs.map((asset) => asset.id), ...rowAudioRefs, ...rowAssetRefs, ...cellAssetRefs]));
            // 连线顺序（2026-11-08 第 13 条）：角色 → 场景 → 道具 → 站位/特效 → 镜头图 → 音频。
            // 顺序 = 视频节点输入框里 chip 的顺序 = `@图片N` 的编号，所以必须在建 line / 拼文案之前排好。
            const linkKinds = new Map<string, ScriptRefLinkKind>();
            for (const ref of preciseRefs) for (const id of ref.ids) linkKinds.set(id, ref.role);
            for (const asset of assets) linkKinds.set(asset.id, resolveScriptAssetRole(asset.role));
            for (const id of rowAssetRefs) linkKinds.set(id, "shot");
            for (const asset of audioRefs) linkKinds.set(asset.id, "other");
            for (const id of rowAudioRefs) linkKinds.set(id, "other");
            const orderedLinkIds = orderScriptRefIds(linkIds, (id) => linkKinds.get(id));
            const links = orderedLinkIds.map((id) => ({ id: nanoid(), fromNodeId: id, toNodeId: videoNode.id }));
            // 资产文案：本镜连进视频节点的图片资产 → 第四套写多行「资产锁定」块、其余三套写「资产名@图片N」
            //（编号顺序 = orderedLinkIds 顺序 = 实际写连线的顺序，与视频节点输入框里的 chip 对得上）。
            const videoBinding = assetBindingOf(orderedLinkIds, nodesRef.current, assetNameOf, assetRoleOf);
            // 合规后缀（用户 2026-11-11 第 02 条）：与一键铺链路同口径，拼在资产绑定之后（= 最后）。
            // MochiAni 节点的 `mochianiPrompt` 是双写过来的初值，这里一起换掉，否则窗口里显示的还是旧版。
            const boundShotPrompt = withVideoComplianceSuffix(withScriptAssetBinding(videoNode.metadata?.prompt, videoBinding));
            videoNode.metadata = {
                ...videoNode.metadata,
                prompt: boundShotPrompt,
                ...(videoNode.metadata?.mochianiPrompt ? { mochianiPrompt: boundShotPrompt } : {}),
            };
            nodesRef.current = [...nodesRef.current, videoNode];
            setNodes((prev) => [...prev, videoNode]);
            if (links.length) setConnections((prev) => [...prev, ...links]);
            setSelectedNodeIds(new Set([videoNode.id]));
            setSelectedConnectionId(null);
            revealNodes([videoNode], "fit");
            if (!options?.silent) message.success(t("canvas.scriptNode.buildShotVideoDone", { no: shotNo }));
        },
        [effectiveConfig, message, t, revealNodes],
    );

    /**
     * 勾选多镜后「铺视频」：逐镜建视频节点（每个节点自带该镜的提示词、时长与素材连线）。
     * 单镜的版本会自己 reveal，批量铺时不能每建一个就把视野拽一次，所以只 reveal 最后一个。
     */
    const handleBuildShotVideos = useCallback(
        (nodeId: string, rowIndexes: number[]) => {
            const unique = Array.from(new Set(rowIndexes)).filter((index) => Number.isInteger(index) && index >= 0);
            if (!unique.length) return;
            unique.forEach((rowIndex, order) => handleBuildShotVideo(nodeId, rowIndex, { stackIndex: order, silent: true }));
            message.success(t("canvas.scriptNode.buildShotVideosDone", { count: unique.length }));
        },
        [handleBuildShotVideo, message, t],
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
                    onPreviewReference={(referenceNodeId) => {
                        // 双击参考图 chip → 走画布统一的全屏预览弹窗（带分辨率 / 模型 / 提示词 / 下载）。
                        const reference = nodesRef.current.find((item) => item.id === referenceNodeId);
                        if (reference) handleNodeViewImage(reference);
                    }}
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
        [
            getConfigInputs,
            getMentionReferences,
            handleCancelNodeSchedule,
            handleConfigNodeChange,
            handleGenerateNode,
            handleNodePromptChange,
            handleNodeSchedule,
            handleNodeViewImage,
            handleRemoveLinkedMedia,
            handleReorderLinkedMedia,
            isNodeGenerating,
            stopGenerationForNode,
        ],
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
                        oneClickVideo={oneClickVideoRuns[contentNode.id]}
                        onOneClickVideo={(nodeId) => void handleOneClickVideo(nodeId)}
                        onInsertPrompt={handleInsertShotPrompt}
                        references={scriptReferences}
                        onScriptAction={handleScriptAction}
                        assetCandidates={getScriptAssetCandidates(contentNode.id)}
                        onImportAssets={(nodeId, files, role) => void handleImportScriptAssets(nodeId, files, role)}
                        onGenerateAsset={handleGenerateScriptAsset}
                        onBatchGenerateAssets={handleBatchGenerateScriptAssets}
                        onDirectGenerateAssets={handleDirectGenerateScriptAssets}
                        onLinkAssets={handleLinkScriptAssets}
                        assetRoles={contentNode.metadata?.scriptAssetRoles}
                        onAssetRoleChange={handleAssetRoleChange}
                        rowAssets={contentNode.metadata?.scriptRowAssets}
                        imageCandidates={getScriptImageCandidates()}
                        onRowAssetsChange={handleRowAssetsChange}
                        onRowAssetImport={(nodeId, shotNo, files) => void handleRowAssetImport(nodeId, shotNo, files)}
                        onRowAssetGenerate={handleRowAssetGenerate}
                        rowAudios={contentNode.metadata?.scriptRowAudios}
                        audioCandidates={getScriptAudioCandidates()}
                        onRowAudiosChange={handleRowAudiosChange}
                        onRowAudioImport={(nodeId, shotNo, files) => handleRowAudioImport(nodeId, shotNo, files)}
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
                        onBuildShotVideos={handleBuildShotVideos}
                        onRegenerateShot={(nodeId, rowIndex) => void runScriptShotGeneration(nodeId, rowIndex)}
                        onRegenerateRows={(nodeId, rowIndexes, options) => void runScriptShotGeneration(nodeId, rowIndexes, options)}
                        onFillShotAssets={(nodeId, rowIndex) => void runScriptAssetFill(nodeId, rowIndex)}
                        onFillAllShotAssets={runScriptAssetFillAll}
                        rowNotes={contentNode.metadata?.scriptRowNotes}
                        onRegenerateAll={handleRegenerateScriptAll}
                        onNodeSizeChange={(nodeId, width, height) => {
                            // 脚本节点按内容自动适配时从左上角扩张：内容变多就向右下长，
                            // 不会因为「居中缩放」把自己挪到左侧素材节点上面去。
                            setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, width, height } : item)));
                        }}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.ReverseVideo) {
                const reverseSource = getReverseVideoSource(contentNode.id);
                return (
                    <CanvasReverseVideoNodeContent
                        node={contentNode}
                        videos={videoReverseOptions}
                        selectedVideoId={videoReverseSelectedId}
                        attachedVideoId={reverseSource?.videoId || null}
                        attachSource={reverseSource?.source || null}
                        referenceImages={reverseSource?.references || []}
                        reverseModelLabel={reverseVideoModelLabel}
                        onConfigChange={handleConfigNodeChange}
                        onCreateVideoFromUrl={createBridgeVideoNode}
                        onRun={runVideoReverse}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.Mochiani) {
                return (
                    <CanvasMochianiNodeContent
                        node={contentNode}
                        references={getMentionReferences(contentNode.id)}
                        onDetachReference={(sourceNodeId) => handleRemoveLinkedMedia(contentNode.id, sourceNodeId)}
                        onReorderReferences={(orderedNodeIds) => handleReorderLinkedMedia(contentNode.id, orderedNodeIds)}
                        onPreviewReference={(referenceNodeId) => {
                            // 双击参考图 chip → 画布统一的全屏预览（与视频节点的提示词面板一致）。
                            const reference = nodesRef.current.find((item) => item.id === referenceNodeId);
                            if (reference) handleNodeViewImage(reference);
                        }}
                        onCreateVideo={(videoUrl, prompt, options) => createBridgeVideoNode(videoUrl, prompt, undefined, options?.hostNodeId)}
                        onConfigChange={handleConfigNodeChange}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.VideoMerge) {
                return (
                    <CanvasVideoMergeNodeContent
                        node={contentNode}
                        clips={videoMergeResolvedByNodeId.get(contentNode.id) || []}
                        isExporting={videoMergeExportingNodeId === contentNode.id}
                        isRendering={videoMergeRenderingNodeId === contentNode.id}
                        renderProgress={videoMergeRenderingNodeId === contentNode.id ? videoMergeRenderProgress : 0}
                        onConfigChange={handleConfigNodeChange}
                        onDetachClips={handleDetachVideoMergeClips}
                        onExport={(nodeId) => void handleVideoMergeExport(nodeId)}
                        onRender={(nodeId) => void handleVideoMergeRender(nodeId)}
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
        [
            createBridgeVideoNode,
            getConfigInputs,
            getMentionReferences,
            getReverseVideoSource,
            getScriptAssetCandidates,
            getScriptAudioCandidates,
            getScriptImageCandidates,
            getScriptSource,
            handleAssetRoleChange,
            handleBatchGenerateScriptAssets,
            handleDirectGenerateScriptAssets,
            handleBuildScriptPipeline,
            handleBuildShotVideo,
            handleCellAssetGenerate,
            handleCellAssetImport,
            handleCellAssetsChange,
            handleCellModelChange,
            handleClearNameLocks,
            handleConfigNodeChange,
            handleGenerateNode,
            handleGenerateScriptAsset,
            handleImportScriptAssets,
            handleInsertShotPrompt,
            handleLinkScriptAssets,
            handleNameLockChange,
            handleRegenerateScriptAll,
            handleRemoveLinkedMedia,
            handleReorderLinkedMedia,
            handleNodeViewImage,
            handleRowAssetGenerate,
            handleRowAudioImport,
            handleRowAudiosChange,
            handleRowAssetImport,
            handleRowAssetsChange,
            handleScriptAction,
            handleStopScriptGeneration,
            handleDetachVideoMergeClips,
            handleVideoMergeExport,
            handleVideoMergeRender,
            isNodeGenerating,
            reverseVideoModelLabel,
            runMergeNode,
            runScriptGeneration,
            runScriptShotGeneration,
            runVideoReverse,
            stopGenerationForNode,
            theme,
            videoMergeExportingNodeId,
            videoMergeRenderProgress,
            videoMergeRenderingNodeId,
            videoMergeResolvedByNodeId,
            videoReverseOptions,
            videoReverseSelectedId,
        ],
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
                        {connectingParams ? (
                            <ActiveConnectionPath
                                node={withDragPreview(nodeById.get(connectingParams.nodeId))}
                                handle={connectingParams}
                                mouseWorld={mouseWorld}
                                target={connectionTargetNodeId ? withDragPreview(nodeById.get(connectionTargetNodeId)) : undefined}
                            />
                        ) : null}
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
                            onChatImageUseAgentPromptChange={handleChatImageUseAgentPromptChange}
                            onChatSkillsChange={handleChatSkillsChange}
                            onChatAgentChange={handleChatAgentChange}
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
                        batchGenerateCount={batchGenerateNodeIds.length}
                        onBatchGenerate={() => handleBatchGenerate(batchGenerateNodeIds)}
                        groupCount={groupableNodeIds.length}
                        onGroupSelected={() => handleGroupSelected(groupableNodeIds)}
                        h3OptimizeCount={h3OptimizeTargets.length}
                        onH3OptimizeSelected={openH3Optimize}
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

                {h3OptimizeOpen ? <CanvasH3OptimizeDialog open targets={h3OptimizeSnapshot} config={h3OptimizeConfig} onStart={runH3OptimizeBatch} onClose={() => setH3OptimizeOpen(false)} /> : null}

                {/* 后台队列的进度 / 停止入口：弹窗关掉以后仍然显示，不挡画布操作。 */}
                <CanvasH3OptimizeProgress />

                {/* MochiAni 生视频：点右下角 = 在画布上新建一个「MochiAni 生视频」节点（不再是遮罩弹窗）。
                    内容区在 renderNodeContentPanel 里渲染，走本机桥 tools/mochiani-bridge → MochiAni MCP → 视频回画布。 */}
                <CanvasMochianiPanel onCreateNode={() => createNode(CanvasNodeType.Mochiani, getCanvasCenter())} />

                {/* 反推视频不再是右下角浮层：它已经做成可右键创建的内置节点（CanvasNodeType.ReverseVideo），
                    内容区在 renderNodeContentPanel 里渲染。 */}

                <input
                    ref={imageInputRef}
                    type="file"
                    multiple
                    accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav,text/*,.txt,.md,.markdown,.csv,.json,.docx,.pdf,.rtf,.html,.xml,.yaml,.yml"
                    className="hidden"
                    onChange={handleImageInputChange}
                />

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
                        videoStorageKey={videoToolsNode.metadata.storageKey}
                        config={effectiveConfig}
                        onClose={() => setVideoToolsNodeId(null)}
                        onTrim={handleVideoTrim}
                        onFrame={handleVideoFrame}
                        onUpscale={handleVideoUpscale}
                        onScale={handleVideoScale}
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
                        defaultIndex={mjUpscaleNode.metadata?.midjourneyIndex || mjUpscaleNode.metadata?.images?.find((image) => image.id === mjUpscaleNode.metadata?.primaryImageId)?.midjourneyIndex || 1}
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

                {adjustNode?.metadata?.content ? <CanvasNodeAdjustDialog dataUrl={adjustNode.metadata.content} open={Boolean(adjustNode)} onClose={() => setAdjustNodeId(null)} onConfirm={(params) => void adjustImageNode(adjustNode!, params)} /> : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {panoramaNode?.metadata?.content ? (
                    <CanvasNodePanoramaDialog dataUrl={panoramaNode.metadata.content} open={Boolean(panoramaNode)} onClose={() => setPanoramaNodeId(null)} onCapture={(payload) => void capturePanoramaShot(panoramaNode, payload)} />
                ) : null}

                {/* 剪映直写：首次 / 授权失效时才打开（粘一次草稿路径 + 选一次草稿文件夹）。 */}
                <CanvasJianyingExportDialog
                    open={jianyingDialogOpen}
                    draftName={jianyingDialogMeta?.draftName || ""}
                    folderName={jianyingDialogMeta?.folderName || ""}
                    clipCount={jianyingDialogMeta?.clipCount || 0}
                    totalSeconds={jianyingDialogMeta?.totalSeconds || 0}
                    submitting={jianyingWriting}
                    onCancel={() => {
                        jianyingPendingRef.current = null;
                        jianyingTargetRef.current = null;
                        setJianyingDialogMeta(null);
                        setJianyingDialogOpen(false);
                    }}
                    onUsePackage={() => {
                        const pending = jianyingPendingRef.current;
                        jianyingPendingRef.current = null;
                        jianyingTargetRef.current = null;
                        setJianyingDialogMeta(null);
                        setJianyingDialogOpen(false);
                        if (pending) void packageJianyingPayload(pending);
                    }}
                    onSubmit={(target) => {
                        const pending = jianyingPendingRef.current;
                        if (!pending) return;
                        // 选完目录不等于能直接写：先过「重名闸门」，撞名会转去重名弹窗。
                        void startJianyingDirectWrite(pending, target);
                    }}
                />

                {/* 剪映直写：草稿目录里已经有同名文件夹（`节点名_MMDD`）→ 问覆盖还是换名。 */}
                <CanvasJianyingConflictDialog
                    open={Boolean(jianyingConflict)}
                    folderName={jianyingConflict?.folderName || ""}
                    draftName={jianyingConflict?.draftName || ""}
                    suggestedName={jianyingConflict?.suggestedName || ""}
                    submitting={jianyingWriting}
                    onCancel={() => {
                        jianyingPendingRef.current = null;
                        jianyingTargetRef.current = null;
                        setJianyingConflict(null);
                        setJianyingDialogMeta(null);
                    }}
                    onOverwrite={handleJianyingConflictOverwrite}
                    onRename={handleJianyingConflictRename}
                />

                <CanvasImagePreviewModal
                    open={Boolean(previewContent)}
                    src={previewContent}
                    title={previewNode?.title || t("canvas.projectPage.imageDetails")}
                    projectId={projectId}
                    fileName={previewContent ? `canvas-${previewNode?.type || "image"}-${previewNode?.id || "preview"}.${imageExtension(previewContent)}` : undefined}
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
