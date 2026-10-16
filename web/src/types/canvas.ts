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
    Script = "script",
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
    /** 定时生成：到点（epoch ms）后自动触发一次生成；生成开始后清空。 */
    scheduledAt?: number;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    /** 生图风格模板 id（见 constant/style-templates.ts）；文本会追加进生图提示词。 */
    styleTemplateId?: string;
    /** 生图摄像机参数（见 constant/camera-options.ts）；设定后会覆盖风格模板里自带的相机描述。 */
    cameraSelection?: import("@/constant/camera-options").CanvasCameraSelection;
    /** 脚本生成器：源剧本内容。 */
    scriptSource?: string;
    /** 脚本生成器：用户补充要求。 */
    scriptPrompt?: string;
    /** 脚本生成器：结构化分镜表（见 constant/story-script.ts）。 */
    scriptRows?: import("@/constant/story-script").StoryScriptRow[];
    /** 脚本生成器：输出预设（classic / storyboard），决定系统提示词与输出列。 */
    scriptPreset?: import("@/constant/story-script").StoryScriptPresetId;
    /** 脚本生成器：上游资产分类（节点 id → 角色/场景/道具/站位图），决定铺链路时素材连到哪些镜。 */
    scriptAssetRoles?: Record<string, import("@/constant/story-script").ScriptAssetRole>;
    /** 脚本生成器：每段目标时长（none / 10 / 15），同时用于生成时的分段要求与铺链路的自动合并。 */
    scriptSegmentSeconds?: import("@/constant/story-script").StoryScriptSegmentSeconds;
    /** 脚本生成器：铺链路时每个视频节点合并几镜（shot / 2 / 3 / duration）。 */
    scriptMergeMode?: import("@/constant/story-script").StoryScriptMergeMode;
    /**
     * 脚本生成器：已经按这份内容自动适配过窗口尺寸的「内容签名」。
     * 节点滚出视口会卸载、回来时重新自动适配会覆盖用户手动拉伸的尺寸，故把它存进 metadata。
     */
    scriptAutoSizeKey?: string;
    /** 脚本生成器：生成的脚本标题。 */
    scriptTitle?: string;
    /** 脚本生成器：解析失败时保留的原始返回，供用户查看/复制。 */
    scriptRaw?: string;
    /** 脚本生成器：生成状态（独立于 status，避免与画布的 loading/error 语义打架）。 */
    scriptStatus?: "idle" | "loading" | "success" | "error";
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    mjVersion?: string;
    textCount?: number;
    seconds?: string;
    /** MiniMax H3 story video resolution (ResolutionSelector megapixels); empty = workflow default. */
    videoResolution?: string;
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
    /** U30/U35 seed mode: `random` | `fixed`. */
    seedMode?: string;
    /** Fixed seed when `seedMode` is `fixed`. */
    seed?: string;
    /** DualClock audio strategy: `reference_only` | `lock_source`. */
    audioMode?: string;
    /** Work-Fisher RH pipeline mode: `video` | `character` | `scene` | `multiview`. */
    fisherMode?: string;
    /** Native H3 client FIFO: 1-based queue position while waiting/running. */
    nativeVideoQueuePosition?: number;
    /** Native H3 client FIFO: total jobs in the canvas queue. */
    nativeVideoQueueTotal?: number;
    /** Native H3 client FIFO phase. */
    nativeVideoQueuePhase?: "queued" | "running";
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
    /** Media + knobs parked by a node type conversion, keyed by the type they belong to. */
    convertedMedia?: Partial<Record<CanvasNodeType, CanvasNodeConvertedSnapshot>>;
};

/**
 * Everything a node type owns exclusively, parked here when the node is converted to the other
 * generation type (image ↔ video) and restored when it converts back. Keeping the payload means
 * converting is lossless: the parked `storageKey` is still scanned by the asset cleanup, so the
 * file survives, and a convert-and-convert-back returns the node exactly as it was.
 */
export type CanvasNodeConvertedSnapshot = {
    /** Media payload. */
    content?: string;
    storageKey?: string;
    thumbnailContent?: string;
    thumbnailStorageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    midjourneyTaskId?: string;
    midjourneyIndex?: number;
    /** Generation knobs that only ever applied to the parked type. */
    model?: string;
    size?: string;
    quality?: string;
    count?: number;
    background?: string;
    mjVersion?: string;
    generationType?: CanvasImageGenerationType;
    freeResize?: boolean;
    seconds?: string;
    videoResolution?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    steps?: string;
    refImageSize?: string;
    samplerName?: string;
    scheduler?: string;
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
