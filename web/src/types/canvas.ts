export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
    Director = "director",
    Chat = "chat",
    Annotate = "annotate",
    Merge = "merge",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasGridMeta = {
    groupId: string;
    row: number;
    column: number;
    rows: number;
    columns: number;
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey: string;
    /** Optional on-canvas preview; full `content` stays for export/edit. */
    thumbnailContent?: string;
    thumbnailStorageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
    /** Midjourney Imagine parent task id — used for manual Upscale (U1–U4). */
    midjourneyTaskId?: string;
    /** Midjourney tile index 1–4 when this image is a specific Imagine tile. */
    midjourneyIndex?: number;
};

/** Snapshot of an audio node's media fields so trim can be undone. */
export type CanvasAudioSnapshot = {
    content: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
};

export type CanvasAnnotationKind = "rect" | "ellipse" | "arrow" | "text";

export type CanvasAnnotationBase = {
    id: string;
    stroke: string;
    strokeWidth: number;
};

export type CanvasRectAnnotation = CanvasAnnotationBase & {
    kind: "rect";
    x: number;
    y: number;
    w: number;
    h: number;
};

export type CanvasEllipseAnnotation = CanvasAnnotationBase & {
    kind: "ellipse";
    x: number;
    y: number;
    w: number;
    h: number;
};

export type CanvasArrowAnnotation = CanvasAnnotationBase & {
    kind: "arrow";
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

export type CanvasTextAnnotation = CanvasAnnotationBase & {
    kind: "text";
    x: number;
    y: number;
    text: string;
    color: string;
    fontSize: number;
};

export type CanvasAnnotation = CanvasRectAnnotation | CanvasEllipseAnnotation | CanvasArrowAnnotation | CanvasTextAnnotation;

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    /** Bumped when chat skills (or similar) write prompt text so the prompt panel can sync. */
    promptSyncAt?: number;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    mjVersion?: string;
    textCount?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    /** ComfyUI video sampling steps. */
    steps?: string;
    /** MiniMax H3 reference image sizing (match / max). */
    refImageSize?: string;
    /** ComfyUI sampler name. */
    samplerName?: string;
    /** ComfyUI scheduler. */
    scheduler?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    sunoVersion?: string;
    sunoCustom?: string;
    sunoInstrumental?: string;
    sunoTitle?: string;
    sunoStyle?: string;
    sunoVocalGender?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    thumbnailContent?: string;
    thumbnailStorageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    /** Previous audio versions after in-place trim; last entry is the most recent pre-trim snapshot. */
    audioHistory?: CanvasAudioSnapshot[];
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    messages?: CanvasAssistantMessage[];
    chatTextEnabled?: boolean;
    chatImageEnabled?: boolean;
    /** Enabled tool-type skill ids for this chat node (e.g. canvas, utils). */
    chatSkillIds?: string[];
    imageModel?: string;
    annotations?: CanvasAnnotation[];
    grid?: CanvasGridMeta;
    /** Merge node: layout direction. */
    mergeOrientation?: "horizontal" | "vertical" | "grid";
    mergeRows?: number;
    mergeColumns?: number;
    mergeAspectRatio?: string | null;
    /** Ordered source node ids filling merge slots (null = empty). */
    mergeSlotIds?: Array<string | null>;
    /** Cover focus 0..1 keyed by source node id. */
    mergeOffsets?: Record<string, { x: number; y: number }>;
    /** Midjourney Imagine parent task id — enables manual Upscale (U1–U4). */
    midjourneyTaskId?: string;
    /** Midjourney tile index 1–4 when the primary image is a specific Imagine tile. */
    midjourneyIndex?: number;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
    images?: CanvasAssistantImage[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
    /** Keep linking after each successful connect until X/Esc cancels (keyboard X mode). */
    sticky?: boolean;
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
