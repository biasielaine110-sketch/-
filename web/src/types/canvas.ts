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
    VideoMerge = "video-merge",
    ReverseVideo = "reverse-video",
    Mochiani = "mochiani",
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

/**
 * 视频合并节点里的一段素材。
 *
 * 只记「哪个节点 + 取哪一段」，不复制文件：素材始终是画布节点原来的那个 blob，
 * 导出时才按 `inSec`/`outSec` 换成剪映草稿里的微秒区间。
 * 图片没有「入点」概念，它的 `outSec` 就是在时间线上占的时长。
 */
export type CanvasVideoMergeClip = {
    /** 来源节点 id。 */
    nodeId: string;
    kind: "video" | "image";
    /** 落盘用的标题快照 —— 源节点之后改名，不会改掉已排好的时间线。 */
    title: string;
    /** 素材总长（秒）；图片为 0。 */
    durationSec?: number;
    /** 取用区间起点（秒）。 */
    inSec: number;
    /** 取用区间终点（秒）；图片用它的时长。 */
    outSec: number;
};

/**
 * 反推视频节点一次执行的快照（一条命令从点下到跑完）。
 *
 * 只有 `running` / `done` / `error` 三态：反推是**一次性任务**，没有「队列」也没有「取消后继续」，
 * 所以不需要更细的状态机。`chatNodeId` / `textNodeId` / `scriptNodeId` 用来在窗口里回跳产物。
 */
export type CanvasReverseVideoRun = {
    status: "running" | "done" | "error";
    /** 当前阶段文案（「反推中…」「写进文本节点…」），给人看进度用。 */
    stage?: string;
    error?: string;
    /** 01 / 02 / 03 */
    mode?: number;
    chatNodeId?: string;
    textNodeId?: string;
    scriptNodeId?: string;
    /**
     * 最近一次状态更新时间（epoch ms）—— **不是「开始时间」**。
     * 每次阶段推进都刷新它，节点据此判断「running 却很久没动静 = 上次被刷新掐断了」。
     */
    at?: number;
};

/**
 * 「反推视频」节点的目标视频参数：风格 / 模型 / 成片总时长 / 比例 / 分辨率。
 *
 * 全部可选：空 = 跟随全局配置（沿用以前的行为）。字段名刻意与视频节点保持一致
 * （`model` / `size` = 比例 / `quality` = 分辨率 / `styleTemplateId`），铺链路时能**原样**搬过去。
 */
export type CanvasReverseVideoTarget = {
    /** 风格模板 id（`constant/style-templates.ts`）；空 = 不加风格。 */
    styleTemplateId?: string;
    /** 视频模型（`channelId::model`，见 `encodeChannelModel`）；空 = 跟随全局视频模型。 */
    model?: string;
    /** 成片**总**时长（秒，字符串，默认 30）：文案 / 剧本按它来规划镜头与台词量。 */
    seconds?: string;
    /** 视频比例（`16:9` / `9:16` / `1:1` …）；空 = 跟随全局。 */
    size?: string;
    /** 视频分辨率档位（`480` / `720` / `1080` / `2k`）；空 = 跟随全局 / 模型默认。 */
    quality?: string;
};

/**
 * MochiAni 生视频节点：上一次任务快照。
 *
 * 和反推视频同理 —— 节点滚出视口会被裁掉重挂，生成要跑几分钟，
 * 进度只放组件 state 会在回来时凭空消失、用户以为任务丢了。
 */
export type CanvasMochianiRun = {
    id: string;
    stage: string;
    nodeId?: string;
    videoUrl?: string;
    prompt?: string;
    error?: string;
    /** 预估灵点 */
    points?: number | null;
    modelKey?: string;
    channelId?: string;
    /** 最近一次状态更新时间（epoch ms） */
    at?: number;
    log?: Array<{ at: string; message: string }>;
    warnings?: string[];
};

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
     * 脚本生成器：上面三段提示词里**被固定住**的段（用户 2026-11-08 口径）。
     *
     * 🔴 默认（缺省）= **跟随词库**：生成脚本时按此刻的词库重新解析，用户改了词条下次生成就是新的，
     * 不再读上面那三个字段里的旧快照（改造前就是这样「固定化」，词库更新对不上）。
     * 只有用户在「自定义提示词」弹窗里保存了**与词库不同**的内容，那一段才会带上 `true` 变成固定，
     * 之后词库再变也不覆盖它。见 `constant/script-scheme.ts` 的 `resolveScriptPromptValues`。
     */
    scriptPromptPins?: import("@/constant/script-scheme").ScriptPromptPins;
    /**
     * 脚本生成器：**执行方案**（六套）。`builtin` = 只用预设自带的内置提示词，三个自定义字段留空；
     * `library` = 从词库预填三段（自定义 ←「分镜表------首帧图和视频提示词」/ 资产 ←「资产提取」+「最佳拍档」/
     * 分镜 ← 同自定义）；`x20` = 自定义与分镜都换「火_X20_主图分镜图_简洁版」，资产同上；
     * `director` = 换成「影视分镜导演」；`muse` = 换成「muse-长视频」（视频运动提示词整段 10 秒脚本）；
     * `ghost` = 自定义与分镜**运行时从画布技能库**取「鬼怪-----光影全流程」的 doc 技能正文（不写死文本），
     * 资产仍走词库；视频运动提示词按「———— + 镜头N｜起—止秒 + 逐时间段 +【全片光影与空气】/【声音】/【结束连续性】」整段识别。
     * **默认自动套用 `director`**（词库缺词时回落 `library`，都没有则留在 `builtin`），见
     * constant/script-scheme.ts 的 `resolveAutoApplyScriptScheme`；`muse` / `ghost` 只手点、不参与默认判定。
     * 预填只是写入那三个字段，之后照常可改 —— 方案不封闭。
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
    /**
     * 脚本生成器：**AI 生图的比例**（`9:16` / `16:9` / `1:1` …，空 = 跟随全局配置）。
     * 三处都读它：「添加资产」「镜头图」「按镜按资产」弹窗的默认值，以及一键铺链路建出来的图片节点。
     */
    scriptImageSize?: string;
    /**
     * 脚本生成器：**成片总时长（秒）**。来自反推节点的「秒数」（默认 30）。
     * 只影响**写剧本**：任务书末尾追加一段「总时长 N 秒」硬要求（镜数按「每 15 秒 4 镜」的节律、
     * 各镜 `duration` 之和落在 N 秒附近、台词量按能念完的字数）。不填 = 与以前完全一致。
     */
    scriptTotalSeconds?: number;
    /**
     * 脚本生成器：铺链路时给**视频节点**用的模型（`channelId::model`）。
     * 不填 = 视频节点跟随全局（老行为）。来源：反推节点上选的「视频模型」。
     */
    scriptVideoModel?: string;
    /**
     * 脚本生成器：铺链路时给**视频节点**用的比例（`16:9` / `9:16` …）。
     * 与 `scriptImageSize`（关键帧的比例）分开存：反推节点上选的比例要同时喂给两者，
     * 但手工改关键帧比例时不该把视频比例一起改掉。
     */
    scriptVideoSize?: string;
    /** 脚本生成器：铺链路时给**视频节点**用的分辨率档位（写进节点的 `vquality`）。 */
    scriptVideoQuality?: string;
    /**
     * 脚本生成器：这张图片是**本节点「一键批量生成」出来的资产图**（值 = 脚本节点 id）。
     *
     * 只有两个用途，别拿它当业务分类：
     *  ① 同一批资产图排在同一条「车道」上（脚本节点右侧的整齐网格），续排时靠它认出自己那批；
     *  ② 「一键铺链路」把三列起点让到车道右侧，避免资产图与分镜链路两批节点叠在一起。
     * 真正的分类仍然只认 `scriptAssetRoles`。
     */
    scriptAssetLane?: string;
    /**
     * 脚本生成器：**反推节点连进来的参考图挂到了哪些资产格**（键 = `分类:资产名`，与
     * `scriptAssetBatchKey` 同一口径）。
     *
     * 为什么必须落库：挂载发生在「一键视频」的 ①.5 步，而**之后**任何一次「批量生成资产图」
     * （含脚本节点上那颗按钮、或第二次跑一键视频）都会重新算一遍要生成哪些资产 ——
     * 不记住这份清单，用户连进来的产品图就会被一张新生成的图顶掉（用户 2026-11-09 报障：
     * 「还是重新生了图，也没用我链接进去的道具图」）。
     * 每次 03 带参考图跑一遍就整份覆盖；03 不带参考图跑（= 用户把图删了）就写成空数组。
     */
    scriptReferenceAssetKeys?: string[];
    /** 脚本生成器：每段目标时长（none / 10 / 15），同时用于生成时的分段要求与铺链路的自动合并。 */
    scriptSegmentSeconds?: import("@/constant/story-script").StoryScriptSegmentSeconds;
    /** 脚本生成器：铺链路时每个视频节点合并几镜（shot / 2 / 3 / duration）。 */
    scriptMergeMode?: import("@/constant/story-script").StoryScriptMergeMode;
    /**
     * 脚本生成器：**手动合并组**（每组是一串连续的行下标，≥2 行）。分镜表里勾几行点「合并为一镜」
     * 就写进这里；一键铺链路时组内多镜合成**一个**视频节点，优先于 `scriptMergeMode` 的档位。
     * 口径见 `constant/story-script.ts: normalizeStoryScriptMergeGroups`（不连续会补齐、组不许重叠）。
     */
    scriptMergeGroups?: number[][];
    /**
     * 脚本生成器：已经按这份内容自动适配过窗口尺寸的「内容签名」。
     * 节点滚出视口会卸载、回来时重新自动适配会覆盖用户手动拉伸的尺寸，故把它存进 metadata。
     */
    scriptAutoSizeKey?: string;
    /**
     * 脚本生成器：内容基准字号（px，档位见 STORY_SCRIPT_FONT_SIZES，默认 18）。
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
    /** RunningHub 机器档位：`default`(Standard) | `plus` | `ultra`。 */
    rhInstanceType?: string;
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
    /** 视频合并节点：数组顺序 = 时间线顺序。 */
    videoMergeClips?: CanvasVideoMergeClip[];
    /** 视频合并：画幅（null / "original" = 跟随第一段素材）。 */
    videoMergeAspect?: string | null;
    /** 视频合并：这条视频是哪个合并节点渲染出来的（溯源用，不影响播放）。 */
    videoMergeFrom?: string;
    /**
     * 反推视频节点：**手动接入**的视频节点 id。
     * 正常接入走画布连线（视频节点 → 本节点），只有用户在窗口里从列表 / 粘贴链接挑的时候才写这里。
     * 连线和这里都有值时**连线优先**（连线是用户当下看得见的那个关系）。
     */
    reverseVideoSourceId?: string;
    /**
     * 反推视频节点：**目标视频参数**（用户 2026-11-09 口径：窗口里要先选好风格 / 模型 / 秒数 / 比例 / 分辨率）。
     *
     * 两处用：
     *  ① `seconds` = **成片总时长**，02/03 写文案 / 03 生剧本时按它规划镜头数与台词量（默认 30 秒）；
     *  ② 03 跑「一键视频」时，风格 / 模型 / 比例 / 分辨率会**落到它建出来的脚本节点上**，再被铺链路
     *     写进每一个视频节点（见 `project.tsx: runVideoReverse` / `handleBuildScriptPipeline`）。
     *
     * ⚠️ 单独一个对象而不是散在 metadata 顶层：这些是「**目标值**」，语义与视频节点自己生成用的
     * `model` / `size` / `vquality` 不同（本节点自己并不生成任何东西），混在一起迟早被别的逻辑读错。
     */
    reverseVideoTarget?: CanvasReverseVideoTarget;
    /**
     * 反推视频节点：上一次执行的结果快照。
     * 节点滚出视口会被裁掉重挂，进度只放组件 state 会在回来时凭空消失，所以落到 metadata。
     */
    reverseVideoRun?: CanvasReverseVideoRun;
    /** MochiAni 生视频节点：上一次任务快照（理由同 reverseVideoRun）。 */
    mochianiRun?: CanvasMochianiRun;
    /** MochiAni 生视频节点：窗口里填的提示词（滚出视口重挂后要还在）。 */
    mochianiPrompt?: string;
    /**
     * MochiAni 生视频节点：选中的模型 / 渠道 / 参数，以及漫剧编辑器的「出场素材 + 配音」。
     *
     * `cast` 存的是**名字**不是 ID —— 名字是用户写的，ID 只在桥那边按作品素材库现解析，
     * 换个作品还能用同一份节点。`voiceover` 就是「角色名：台词」的原文。
     */
    mochianiConfig?: {
        modelKey?: string;
        channelId?: string;
        params?: Record<string, string>;
        cast?: { characters?: string; scenes?: string; props?: string };
        voiceover?: string;
        generateVoice?: boolean;
    };
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
