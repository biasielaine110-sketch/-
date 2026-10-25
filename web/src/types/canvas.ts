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
    /**
     * 脚本生成器：节点级自定义系统提示词。非空时**整段替换**预设自带的 systemPrompt
     * （见 constant/story-script.ts 的 resolveScriptSystemPrompt），这样不改代码就能换一个
     * 「生成器」；列定义仍跟预设走。
     */
    scriptSystemPrompt?: string;
    /**
     * 脚本生成器：**资产部分的自定义要求**（角色 / 场景 / 道具 / 人物站位这些列怎么写）。
     * 与 `scriptSystemPrompt`（整段换系统提示词）不同，它只往任务书里加一段「资产专项要求」，
     * 且优先生效于预设里与之冲突的说明；空 = 只用预设（输出与改造前逐字一致）。
     */
    scriptAssetPrompt?: string;
    /**
     * 脚本生成器：**分镜提示词部分的自定义要求**（分镜提示词 / 视频运动提示词 / 风格提示词怎么写）。
     * 与 `scriptAssetPrompt` 平行、互不影响 —— 用户要「资产的生成和分镜提示词的生成用不同的提示词控制」。
     */
    scriptShotPrompt?: string;
    /**
     * 脚本生成器：**执行方案**（三套）。`builtin` = 只用预设自带的内置提示词，三个自定义字段留空；
     * `library` = 从词库预填三段（自定义 ←「分镜表------首帧图和视频提示词」/ 资产 ←「资产提取」+「最佳拍档」/
     * 分镜 ← 同自定义）；`x20` = 自定义与分镜都换「火_X20_主图分镜图_简洁版」，资产同上。
     * **默认自动套用 `x20`**（词库缺词时回落 `library`），见 constant/script-scheme.ts 的
     * `resolveAutoApplyScriptScheme`。预填只是写入那三个字段，之后照常可改 —— 方案不封闭。
     */
    scriptScheme?: import("@/constant/script-scheme").ScriptSchemeId;
    /**
     * 从词库方案切回第一套时暂存的三段提示词：切回去（或再切回来）直接恢复，
     * 不用为了「对比两套效果」反复重填。只在**离开第一套**时写入。
     */
    scriptLibraryBackup?: { system?: string; asset?: string; shot?: string };
    /** 脚本生成器：结构化分镜表（见 constant/story-script.ts）。 */
    scriptRows?: import("@/constant/story-script").StoryScriptRow[];
    /** 脚本生成器：输出预设（classic / storyboard），决定系统提示词与输出列。 */
    scriptPreset?: import("@/constant/story-script").StoryScriptPresetId;
    /** 脚本生成器：上游资产分类（节点 id → 角色/场景/道具/站位图），决定铺链路时素材连到哪些镜。 */
    scriptAssetRoles?: Record<string, import("@/constant/story-script").ScriptAssetRole>;
    /**
     * 脚本生成器：**逐镜图片**关联（镜号 → 画布图片节点 id 列表）。在分镜表「镜头图」列里直接
     * 导入 / 链接 / 生成，铺链路时只连到这一镜的图片节点，并随该分组合并进视频节点。
     */
    scriptRowAssets?: import("@/constant/story-script").StoryScriptRowAssetMap;
    /**
     * 脚本生成器：**逐镜声音**关联（镜号 → 画布音频节点 id 列表）。分镜表「声音」列里链接 / 导入，
     * 铺链路时只直连到这一镜（或该分段）的视频节点 —— 只连视频，不参与生图。
     */
    scriptRowAudios?: import("@/constant/story-script").StoryScriptRowAudioMap;
    /**
     * 脚本生成器：**逐镜备注**（镜号 → 用户给这一镜追加的剧情 / 修改要求）。
     *
     * 「给某一镜单独加剧情再重生成」时写进来：表里能看出这一镜是按什么要求改的，
     * 下次再点重生成还能沿用 / 微调；调序与删行时镜号键会跟着一起挪。
     */
    scriptRowNotes?: Record<string, string>;
    /**
     * 脚本生成器：**按镜按资产**挂图（`"镜号:资产列key"` → 画布图片节点 id 列表）。在分镜表的
     * 「角色1 / 角色2 / 场景 / 道具 / 人物站位」格子里直接导入 / 链接 / 生成，铺链路时只连到
     * **这一镜的那一个资产**（并顶掉资产条对同一镜同一分类的分派）。
     */
    scriptCellAssets?: import("@/constant/story-script").StoryScriptCellAssetMap;
    /**
     * 脚本生成器：**资产锁定**（资产名 → 画布图片节点 id 列表）。把「分镜表里已经链接好的图片」
     * 按**资产名**锁死（例：`张三` → @图片1、`客厅` → @图片2），铺链路时表里凡是出现这个名字的
     * 地方都用同一张图。来源：格子链接时自动并入 + 一键铺链时按全表链接重建。
     */
    scriptNameLocks?: import("@/constant/story-script").StoryScriptNameLockMap;
    /**
     * 脚本生成器：**手动追加的资产列**（例：「宠物」「车辆」）。自建列的行为与内置资产列一致 ——
     * 格子里能放文字、能挂图位、能上资产锁，铺链路时按 `role` 把图连进该镜的图片节点。
     * key 固定 `extra_<n>`（改列名不丢图位），见 constant/story-script.ts 的 `StoryScriptExtraColumn`。
     */
    scriptExtraColumns?: import("@/constant/story-script").StoryScriptExtraColumn[];
    /**
     * 脚本生成器：在资产格子里**单独挑的生图模型**（不填就跟随节点的默认图片模型）。
     * 只作为「格子生图弹窗」的默认值：每次生成都会把选中的模型写到新建的那张图片节点上。
     */
    scriptCellImageModel?: string;
    /** 脚本生成器：每段目标时长（none / 10 / 15），同时用于生成时的分段要求与铺链路的自动合并。 */
    scriptSegmentSeconds?: import("@/constant/story-script").StoryScriptSegmentSeconds;
    /** 脚本生成器：铺链路时每个视频节点合并几镜（shot / 2 / 3 / duration）。 */
    scriptMergeMode?: import("@/constant/story-script").StoryScriptMergeMode;
    /**
     * 脚本生成器：已经按这份内容自动适配过窗口尺寸的「内容签名」。
     * 节点滚出视口会卸载、回来时重新自动适配会覆盖用户手动拉伸的尺寸，故把它存进 metadata。
     */
    scriptAutoSizeKey?: string;
    /**
     * 脚本生成器：内容基准字号（px，档位见 STORY_SCRIPT_FONT_SIZES，默认 13）。
     * 组件里除外壳挂的这个 px 值外一律用 em，所以只改它就能整体缩放分镜表与各类文字。
     */
    scriptFontSize?: number;
    /**
     * 脚本生成器：分镜表「简洁版」——隐藏画面描述 / 角色动作 / 人物站位 / 情绪 / 场景标签 / 光影氛围六列。
     * **默认就是简洁版**（2026-10-21 用户要求），所以 `undefined` / `true` 都按简洁渲染，
     * 只有显式切到完整版时才存 `false`。只影响显示，行数据不删。
     */
    scriptCompactColumns?: boolean;
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
    /** 生成后自动切掉画面底部字幕带（H3/Fisher 会把字幕烧进画面，图上没有可关的开关）。 */
    cropSubtitles?: string;
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
    /** Work-Fisher 风格 LoRA（279）权重：`0` = 关（默认），去掉韩语人声/硬字幕/自编台词。 */
    fisherLoraStrength?: string;
    /** Work-Fisher 是否提交 `视觉风格：…` 的值：`on` = 提交（只丢字段名），其余 = 整行不发。 */
    fisherStyleFields?: string;
    /** MJ 风格 V2.0 LoRA 味型：`strong` | `standard` | `light` | `off`. */
    mjFlavor?: string;
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
    /**
     * 「Agent 写词 + 出图」开关（只在 chatTextEnabled && chatImageEnabled 时生效）。
     * 打开后先跑文字/agent 那一路，把它写到节点上的提示词（agent 用 update_node_prompt /
     * create_text_node 落的正文，或它回复的正文）当作生图提示词，而不是拿用户原话去生图。
     * 代价是两路从并行变串行；语义上「先想清楚再画」，所以默认关闭。
     */
    chatImageUseAgentPrompt?: boolean;
    /** Enabled tool-type skill ids for this chat node (e.g. canvas, utils). */
    chatSkillIds?: string[];
    /**
     * 绑定的 agent id（见 constant/canvas-agents.ts）。绑上之后这个 Chat 节点按 agent 的人设与技能跑：
     * 一次发送就让 agent 自己拆步骤、连调工具、干完再汇报，不用一轮轮喂指令。
     */
    agentId?: string;
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
    cropSubtitles?: string;
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
