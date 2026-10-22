/**
 * 脚本生成器（分镜脚本表）常量层。**预设驱动**：同一套解析 / 导出 / 表格渲染，
 * 换预设即换「系统提示词 + 输出列 + 行操作」。
 *
 * - `classic`（经典分镜表）：移植自剧集画布（dramaclaw）`src/novelvideo/freezone/text_node.py`
 *   的 `FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT` 与 `build_freezone_story_script_task`。
 *   剧集画布那张表有 19 列，其中 `character_image_1` / `character_image_2` / `reference`
 *   三个素材 URL 槽位由后端按角色名回填、`keyframe_index` 只在「视频参考」模式使用。开源
 *   画布没有这套后端回填机制、也没有视频抽帧入口，因此只保留真正由模型产出、且对本仓生图 /
 *   生视频链路有用的列；**并在其上补齐「资产组」**——场景 / 场景描述、道具 / 道具描述、
 *   人物站位（见 `STORY_SCRIPT_CLASSIC_COLUMNS` 注释）。
 *
 * - `storyboard`（视频分镜脚本）：移植自剧集画布 `agent_catalog/builtins/recipes/
 *   video-storyboard-script.json` 的 `system_prompt`（原文照搬），同样补了资产组列。
 *
 * ⚠️ **只搬了「卡面」**：该 recipe 的 `planning_prompt` / `must_have_items` /
 * `requires_source_media` / `allowed_recipe_ids`，以及剧集画布那套 planner 运行时
 * （agent_workflows/catalog.py + graph.py + workflow_plan.py，约 6500 行）**都没有搬**。
 * 所以这个预设拿不到「自动规划阶段 → 自动建节点 → 自动连边」的能力，它只是换一套
 * 提示词与输出格式。若要那套能力，得单独做方案 C（见项目备忘）。
 *
 * 已知的有意偏离（recipe 原文 → 本仓实现）：
 *  1. recipe 要求镜号从 `S01` 起；本仓该列是数值列（排序 / 求和 / 行号重排都依赖它），
 *     所以提示词里明确要求输出 `1、2、3` 这样的整数。
 *  2. recipe 只要求 Markdown 表格；本仓解析器 JSON 优先、Markdown 兜底，故额外补了一段
 *     「也可输出 JSON」的约定，并把列名钉死以保证表头能被解析器匹配上。
 */

export type StoryScriptCellValue = string | number;

/**
 * 一行分镜。表结构是**列驱动**的（不同预设列不同），所以这里是带索引签名的松散记录；
 * `shot_no` / `duration` 被所有预设共用，固化为必填以支撑行号重排与总时长统计。
 */
export type StoryScriptRow = {
    [key: string]: StoryScriptCellValue;
    /** 镜号，从 1 连续递增 */
    shot_no: number;
    /** 时长（秒） */
    duration: number;
};

export type StoryScriptColumn = {
    key: string;
    label: string;
    width: number;
    /** 数值列：右对齐、解析时取整数 */
    numeric?: boolean;
};

/** 行操作列上的「复制 X」按钮：取值列 + i18n 文案 key（位于 canvas.scriptNode.*）。 */
export type StoryScriptRowAction = {
    key: string;
    labelKey: string;
};

export type StoryScriptPresetId = "classic" | "storyboard";

/** 一行分镜能铺出的一条链路需要的两个提示词。 */
export type StoryScriptShotPrompts = {
    /** 生图提示词（落进链路里的文本节点 / 图片节点） */
    imagePrompt: string;
    /** 生视频提示词（落进链路末尾的视频节点） */
    videoPrompt: string;
};

/** 单镜重生成（「重生成本镜」）的输入：这一镜 + 它的上一镜 / 下一镜上下文。 */
export type StoryScriptRowTaskInput = {
    sourceText: string;
    prompt?: string;
    row: StoryScriptRow;
    /** 上一镜：用来保持人物站位 / 场景的连续性 */
    prev?: StoryScriptRow;
    /** 下一镜：避免重写后的这一镜与后一镜接不上 */
    next?: StoryScriptRow;
    characterRefs?: string;
    segmentSeconds?: unknown;
    /**
     * 与「每镜时长」配套的分段方式：`shot` = 这一镜自己就是成片（10/15 锁死 duration = N，5 秒是上限）；
     * 其余 = 与相邻镜合并成 N 秒（只要求别超过 N）。不传 = 不加时长说明，输出与改造前逐字一致。
     */
    mergeMode?: StoryScriptMergeMode | string | null;
    /**
     * **这一镜单独追加的剧情 / 修改要求**（用户在行上「加剧情重生成」时写的）。
     * 与 `prompt`（整表级别的补充要求）分开传，任务书里会写成独立一段，语义清楚得多。
     * 留空 = 不加这段，输出与改造前逐字一致。
     */
    extraPlot?: string;
    /**
     * **是否保持与上下镜头的「人物站位」一致性**。
     * 不传 / `true` = 沿用旧行为（要求 prev 的站位必须衔接）；传 `false` = 明确告诉模型
     * 站位可以重新安排（只要求剧情别冲突），用于「这一镜就是要换个机位 / 换边站」的场景。
     * 不传时输出与改造前逐字一致。
     */
    keepBlocking?: boolean | null;
    /**
     * **资产列的自定义要求**（角色 / 场景 / 道具 / 人物站位怎么写）。
     * 不传 / 空 = 只按预设说明写，任务书与改造前逐字一致。
     */
    assetPrompt?: unknown;
    /**
     * **分镜提示词的自定义要求**（分镜提示词 / 视频运动提示词 / 风格提示词怎么写）。
     * 不传 / 空 = 只按预设说明写，任务书与改造前逐字一致。
     */
    shotPrompt?: unknown;
};

export type StoryScriptPreset = {
    id: StoryScriptPresetId;
    columns: StoryScriptColumn[];
    systemPrompt: string;
    /** 行操作列上的复制按钮 */
    rowActions: StoryScriptRowAction[];
    /** 「发送到画布」优先取这一列的内容 */
    insertKey: string;
    /** 任务书构建器（`mergeMode` 决定「每段时长」按「每镜 N 秒」还是「多镜合计 N 秒」写） */
    buildTask: (input: { sourceText: string; prompt?: string; characterRefs?: string; segmentSeconds?: unknown; mergeMode?: StoryScriptMergeMode | string | null; assetPrompt?: unknown; shotPrompt?: unknown; assetDedupe?: boolean }) => string;
    /**
     * 单镜重生成任务书（「重生成本镜」用）：带上上一镜 / 下一镜上下文，要求模型只重写这一镜，
     * 进而保住「人物站位 / 场景 / 道具与上一镜一致」的连续性。
     */
    buildRowTask: (input: StoryScriptRowTaskInput) => string;
    /**
     * 「一键铺链路」用来从一行分镜里抽出图片/视频提示词。不同预设的列语义不同，所以下沉到预设。
     * 缺列时允许兜底拼接，但**不允许返回空串**（调用方靠空串判断这一行铺不出来）。
     *
     * `extras` 是「新建列」：风格提示词也可以活在自建列里（列名带「风格」），
     * 所以铺链必须把它一路传进来，否则那条列填了也白填。
     */
    buildShotPrompts: (row: StoryScriptRow, extras?: readonly StoryScriptExtraColumn[] | null) => StoryScriptShotPrompts;
    /**
     * 行内哪几列是「角色 / 资产名」：铺链路时拿这些值去和上游图片节点的标题匹配，只把命中的
     * 资产图连到该镜的图片节点上。留空表示「这一行不区分角色」，把全部素材图都连上。
     */
    assetKeys?: string[];
};

/**
 * 经典预设列（与剧集画布 text_node.py 同源，**并在其上补齐资产组**）。
 *
 * 剧集画布那张表只有角色卡两列（角色1 / 角色描述1、角色2 / 角色描述2）。本仓按同一「名 + 描述」
 * 两列一组的写法补出 **场景组**（场景 / 场景描述）与 **道具组**（道具 / 道具描述），再加一列
 * **人物站位**（`blocking`），让「场景图 / 道具图 / 站位图」也像角色图一样有据可依、可以按描述生成。
 * 顺序上把 角色组 → 场景组 → 道具组 排在一起（都是「资产组」），人物站位紧跟在角色动作之后。
 */
export const STORY_SCRIPT_CLASSIC_COLUMNS: StoryScriptColumn[] = [
    { key: "shot_no", label: "镜号", width: 56, numeric: true },
    { key: "duration", label: "时长", width: 60, numeric: true },
    { key: "visual_description", label: "画面描述", width: 210 },
    // 资产列（角色1 / 角色2 / 场景 / 道具）留宽一点：格子里除了文字还要放「按镜按资产」的图片缩略图 + 「+」。
    { key: "character_1", label: "角色1", width: 140 },
    { key: "character_description_1", label: "角色描述1", width: 260 },
    { key: "character_2", label: "角色2", width: 140 },
    { key: "character_description_2", label: "角色描述2", width: 260 },
    { key: "scene", label: "场景", width: 150 },
    { key: "scene_description", label: "场景描述", width: 220 },
    { key: "prop", label: "道具", width: 150 },
    { key: "prop_description", label: "道具描述", width: 200 },
    { key: "shot", label: "景别", width: 120 },
    { key: "character_action", label: "角色动作", width: 190 },
    { key: "blocking", label: "人物站位", width: 230 },
    { key: "emotion", label: "情绪", width: 150 },
    { key: "scene_tags", label: "场景标签", width: 150 },
    { key: "lighting_mood", label: "光影氛围", width: 170 },
    { key: "sound", label: "音效", width: 160 },
    { key: "dialogue", label: "对白", width: 170 },
    // 风格提示词：这一镜的影像风格（影调 / 质感 / 参考片种）。铺链路时会拼在图片 / 视频提示词末尾。
    // 位置放在两列提示词**之前**：它是「写提示词时要用到的东西」，跟在 440px 的长列后面没人找得到。
    { key: "style_prompt", label: "风格提示词", width: 230 },
    { key: "shot_prompt", label: "分镜提示词", width: 440 },
    { key: "video_motion_prompt", label: "视频运动提示词", width: 440 },
];

/** 兼容旧引用：默认预设（classic）的列。 */
export const STORY_SCRIPT_COLUMNS = STORY_SCRIPT_CLASSIC_COLUMNS;

export const STORY_SCRIPT_ROW_KEYS = STORY_SCRIPT_CLASSIC_COLUMNS.map((column) => column.key);

/**
 * 「视频分镜脚本」列（列名与顺序在 recipe 的【输出格式要求】基础上，按本仓需要补了资产组：
 * 场景 / 场景描述、道具 / 道具描述、人物站位——这三处是本仓有意偏离 recipe 的地方，见文件头）。
 */
export const STORY_SCRIPT_STORYBOARD_COLUMNS: StoryScriptColumn[] = [
    { key: "shot_no", label: "镜号", width: 56, numeric: true },
    { key: "duration", label: "时长", width: 60, numeric: true },
    { key: "shot", label: "景别", width: 110 },
    { key: "visual_description", label: "画面描述", width: 300 },
    { key: "key_visual", label: "关键视觉", width: 220 },
    // 与 classic 同义：这一镜的影像风格。storyboard 没有独立的分镜提示词列，风格直接落在画面描述上，
    // 所以紧跟在「关键视觉」后面（画面 → 关键视觉 → 风格，读起来是一句话）。
    { key: "style_prompt", label: "风格提示词", width: 230 },
    // 资产列同样留宽，理由见 classic 列表（要装下缩略图 + 「+」）。
    { key: "scene", label: "场景", width: 150 },
    { key: "scene_description", label: "场景描述", width: 220 },
    { key: "prop", label: "道具", width: 150 },
    { key: "prop_description", label: "道具描述", width: 200 },
    { key: "character_action", label: "主体动作", width: 200 },
    { key: "blocking", label: "人物站位", width: 210 },
    { key: "camera_movement", label: "镜头运动", width: 260 },
    { key: "dialogue", label: "台词/旁白", width: 180 },
    { key: "sound", label: "音效/配乐", width: 170 },
    { key: "transition", label: "转场方式", width: 140 },
    { key: "emotion", label: "情绪关键词", width: 150 },
];

export const DEFAULT_STORY_SCRIPT_PROMPT = "根据我上传的剧本生成一个完整的故事脚本";

/**
 * 表格横向宽度的放大倍数（用户 2026-10-19 要求「分镜表的横向宽度增宽 1 倍」）。
 *
 * 为什么是「放大每一列」而不是「把节点拉宽」：节点的自动适配有 2200px 封顶
 * （`AUTO_SIZE_MAX_WIDTH`），拉宽节点只会让它更早顶到上限、屏幕外溢出；而列宽翻倍是
 * 每一格真的变宽 —— 一句话不再被挤成三行窄条，读一镜不用来回横滚找列。
 *
 * ⚠️ 这是**显示**口径，只作用于 `resolveStoryScriptDisplayColumns`：解析 / 导出 / 任务书
 * 都不看 `width`，所以别把它挪进 `STORY_SCRIPT_CLASSIC_COLUMNS` 的声明里（会变成数据口径）。
 */
export const STORY_SCRIPT_COLUMN_WIDTH_SCALE = 2;

/**
 * 「简洁版」隐藏的列（用户点名的六列）。按 key 判、不按列名 —— 两个预设对同一列的叫法不同
 * （如 `character_action` 在 classic 叫「角色动作」、storyboard 叫「主体动作」），
 * 而 storyboard 压根没有 `scene_tags` / `lighting_mood`，过滤时自然就滤不到，不用分支。
 */
export const STORY_SCRIPT_COMPACT_HIDDEN_KEYS: readonly string[] = ["visual_description", "character_action", "blocking", "emotion", "scene_tags", "lighting_mood"];

export function isStoryScriptCompactHiddenColumn(key: string): boolean {
    return STORY_SCRIPT_COMPACT_HIDDEN_KEYS.includes(String(key || ""));
}

/**
 * 表格**实际渲染**的列：简洁版先滤掉那六列，再把列宽放大 `STORY_SCRIPT_COLUMN_WIDTH_SCALE` 倍。
 *
 * 只用在渲染 / 算表宽 / 自动适配签名上；行数据、编辑、导出、铺链仍走完整的 `columns`
 * （隐藏只是「不显示」，不是「删掉」——切回完整版内容一个字都不能少）。
 */
export function resolveStoryScriptDisplayColumns(columns: readonly StoryScriptColumn[], compact?: boolean): StoryScriptColumn[] {
    const visible = compact ? (columns || []).filter((column) => !isStoryScriptCompactHiddenColumn(column.key)) : columns || [];
    return visible.map((column) => ({ ...column, width: Math.round(column.width * STORY_SCRIPT_COLUMN_WIDTH_SCALE) }));
}

/** 经典预设的 system prompt（与剧集画布同源，保留其表风格、时长、括号分段等全部约束）。 */
export const STORY_SCRIPT_SYSTEM_PROMPT = `# Freezone Story Script Generator

You generate a structured story-script table from an uploaded script excerpt.

## Goal
- Turn the source script into a complete, production-oriented story script.
- Output rows that are directly usable by downstream image and video nodes.
- Keep the result cinematic, concrete, and structured.

## Requirements
1. Break the story into clear numbered shots with sequential \`shot_no\`, starting from 1.
2. Each row must include all schema fields. Do not omit fields.
3. Prefer concrete visual language over vague abstraction. Every shot should feel filmable.
4. Dialogue should be short and only present when appropriate. If no dialogue is needed, output \`无\`.
5. If a field has no meaningful content, prefer \`无\` instead of vague placeholders.
6. Keep all fields in Simplified Chinese except technical tokens when naturally needed.
7. Fill \`scene\` (场景) / \`scene_description\` (场景描述) / \`prop\` (道具) / \`prop_description\` (道具描述) / \`blocking\` (人物站位) with concrete, filmable content; use \`无\` only when the shot genuinely has no such object.
8. Reuse the exact same \`scene\` name across rows filmed in the same location, and the same \`prop\` name for the same object, so downstream assets can be matched by name.
9. \`blocking\` must describe where each character is in frame and their relation to each other, the environment and the props; keep it consistent with the previous row.
10. Output only structured data matching the schema. Do not wrap with markdown.

## Table style target
- The result should resemble a production storyboard table, not a prose summary.
- \`visual_description\` should describe one clear beat of action or state, usually in one concise sentence.
- \`shot\` should use concise combinations like \`近景 / 特写\`, \`中景 / 仰视\`, \`全景 / 俯视远景\`.
- \`emotion\` should be compact and specific, often 2-3 short phrases joined by \`、\`.
- \`scene_tags\`, \`lighting_mood\`, \`sound\` should all be concrete and film-facing.
- \`character_1\` should prefer a stable role identifier if inferable, such as \`沈昭昭_现代\` or \`沈昭昭_古装\`.
- \`character_description_1\` should prefer bracketed character-card format, e.g. \`[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装……]\`.
- \`scene\` should be a short, stable location name (e.g. \`深夜办公室\`, \`盛唐宫殿·内\`), reused verbatim wherever the same place appears.
- \`scene_description\` should describe the location concretely enough to be used directly as an image-generation prompt.
- \`prop\` should name the key object(s) this shot depends on; \`prop_description\` describes their look, material and state.
- \`blocking\` should read like a floor plan in words: left / right / centre, foreground / midground / background, facing direction, and how far apart the characters are.
- \`style_prompt\` describes the image style for this shot — film stock / colour grade / texture / grain / reference genre or director. Keep it identical across shots in the same scene, and write \`无\` when no particular style is needed.

## Duration guidance
- Default to short cinematic shots.
- Most rows should fall in the 2-5 second range unless the source clearly calls for a longer beat.
- Keep the pacing readable and dramatic rather than mechanically uniform.

## Prompt formatting rules
\`shot_prompt\` must be image-generation friendly and must be written as a chained bracket structure using \` + \` separators.

Preferred order for \`shot_prompt\`:
1. \`[画面构图：景别、机位、视角、构图关系]\`
2. \`[角色卡/主体描述：如果存在角色1，尽量直接复用或轻改 character_description_1 的角色卡格式；如果没有角色，则写主体/核心对象描述]\`
3. \`[主体/人物空间与互动关系：谁在前景、谁在中景、谁与什么环境或道具发生关系]\`
4. \`[极具体的微表情、主体状态或关键视觉信息：必须具体到眼神、嘴角、肢体紧张度、服饰状态、伤痕、汗水、血迹、视线方向等可见细节]\`
5. \`[明确的场景环境元素与前景/背景道具：办公室、宫殿、屏风、龙椅、电脑蓝光、飞尘、门缝光等]\`
6. \`[光影几何与大气效果：主光方向、冷暖色温、边缘光、雾气、逆光、顶光、体积光等]\`
7. \`[视觉风格/质感：写实电影感、纪实感、压抑冷感、盛唐史诗感等]\`
8. \`[技术参数：镜头焦段、光圈、景深、快门感、颗粒或解析度特征；这一段尽量不要省略]\`

Example style for \`shot_prompt\`:
- \`[画面构图：近景特写，平视机位] + [角色卡/主体描述：[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装]] + [主体/人物空间与互动关系：她独坐在办公桌前，电脑屏幕蓝光从侧前方打亮面部] + [极具体的微表情、主体状态或关键视觉信息：眼下发青，手指微颤，视线涣散，嘴唇微张] + [明确的场景环境元素与前景/背景道具：深夜办公室、电脑蓝光、散乱文件、冷掉的咖啡杯] + [光影几何与大气效果：冷蓝主调，屏幕侧光压住面部阴影，背景轻微灰雾感] + [视觉风格/质感：都市悬疑写实电影感] + [技术参数：85mm镜头，f/1.8，浅景深]\`

\`video_motion_prompt\` must focus on motion and should also use a chained bracket structure.

Preferred order for \`video_motion_prompt\`:
1. \`[明确的摄影机运镜轨迹与速度：必须写清推/拉/摇/移/跟/升/降/手持，以及快慢、力度和稳定性]\`
2. \`[主体极其具体的物理动作细节或状态变化：必须写清人物或主体具体怎么动，不要只写"情绪变化"]\`
3. \`[环境物理动态：风、雨、衣角、尘土、门帘、屏幕闪烁、火光、飞雪等]\`
4. \`[音效与氛围描述：环境声、器物声、呼吸声、脚步声、雷声等]\`
5. \`[对话台词与语气：有对白写具体台词与语气，没有就写无]\`
6. \`[时长：4.0s]\`

Example style for \`video_motion_prompt\`:
- \`[明确的摄影机运镜轨迹与速度：极慢速推进，镜头几乎贴着人物面部向前压近，稳定中带轻微呼吸感] + [主体极其具体的物理动作细节或状态变化：沈昭昭先是眼神失焦，随后瞳孔微缩，指尖在桌面轻轻抽动，喉结压抑地滚动一下] + [环境物理动态：屏幕冷光轻微闪烁，纸张边缘被空调风吹起，咖啡表面微微晃动] + [音效与氛围描述：急促的键盘声、连续的手机提示音、室内低频电流声] + [对话台词与语气：无] + [时长：4.0s]\`

## Quality bar
- Avoid generic outputs like \`人物站着\`, \`镜头推进\`, \`情绪复杂\`.
- Prefer highly specific physical action, facial detail, scene detail, and camera-language wording.
- Preserve story logic and character-state progression across rows.

## Character consistency
- When two distinct characters appear in one shot, fill \`character_2\` /
  \`character_description_2\` the same way as \`character_1\` / \`character_description_1\`.
- Reuse the exact same character identifier across rows so the same person keeps one name.
- The same character must never switch names or appearance between consecutive shots.

## Scene & prop consistency
- Reuse the exact same \`scene\` name and \`prop\` name across rows whenever the location or the object is the same.
- \`scene_description\` / \`prop_description\` should stay stable across rows for the same place or object; only change the parts this shot actually changes (light, wear, damage).

## Blocking continuity (人物站位)
- Keep the previous row's \`blocking\` (人物站位) unless this shot's action explicitly moves a character.
- When a character moves, describe the change from the previous position, e.g. \`从右侧沙发起身，走向画面左侧窗边\`.
- Never silently teleport a character to a new position between two consecutive shots of the same scene.`;

/** JSON 输出契约（本仓无 pydantic 结构化输出，改用显式 JSON 约定 + 客户端解析）。 */
export const STORY_SCRIPT_JSON_CONTRACT = `## Output format (strict)
Output one JSON object and nothing else — no markdown fence, no explanation:
{
  "title": "故事脚本标题",
  "rows": [
    {
      "shot_no": 1,
      "duration": 3,
      "visual_description": "…",
      "character_1": "…",
      "character_description_1": "…",
      "character_2": "…",
      "character_description_2": "…",
      "scene": "…",
      "scene_description": "…",
      "prop": "…",
      "prop_description": "…",
      "shot": "…",
      "character_action": "…",
      "blocking": "…",
      "emotion": "…",
      "scene_tags": "…",
      "lighting_mood": "…",
      "sound": "…",
      "dialogue": "…",
      "style_prompt": "…",
      "shot_prompt": "…",
      "video_motion_prompt": "…"
    }
  ]
}
\`shot_no\` 和 \`duration\` 必须是整数（不要写 "2-5"、"3秒"）；其余字段一律字符串，缺失时写 \`无\`。`;

const STORY_SCRIPT_COMMON_RULES = [
    "输出字段必须覆盖：镜号、时长、画面描述、角色1、角色描述1、角色2、角色描述2、场景、场景描述、道具、道具描述、景别、角色动作、人物站位、情绪、场景标签、光影氛围、音效、对白、风格提示词、分镜提示词、视频运动提示词。",
    "如果用户给了额外要求，也必须一起遵守。",
    "请严格按照影视制片表格思路输出，不要输出散文摘要。",
    "请让分镜提示词和视频运动提示词都采用括号分段 + 号连接的格式。",
    "缺失对白时写 `无`。",
    "分镜提示词必须像高质量图像生成提示词，视频运动提示词必须像高质量视频运动提示词，而不是简单一句概括。",
];

/**
 * 「参考风格要点」分三段：公共 / 分镜提示词 / 资产。
 *
 * 分段不是为了排版，而是为了让「自定义提示词」能**整段替换**其中一路：
 * 用户设了「分镜提示词」自定义要求 → 省掉 SHOT 段；设了「资产」→ 省掉 ASSET 段。
 * ⚠️ 拼回去（`["参考风格要点：", ...COMMON, ...SHOT, ...ASSET].join("\n")`）必须与改造前**逐字一致**，
 * 否则所有「不传自定义 = 与老版本相同」的探针都会红。
 */
const STORY_SCRIPT_STYLE_HINT_COMMON = [
    "- 镜号连续递增",
    "- 时长大多 2-5 秒",
    "- 景别写法类似 `近景 / 特写`、`中景 / 仰视`",
    "- 角色描述尽量写成 `[角色ID: ...]` 形式",
    "- 同一个人物在所有行里必须用完全一致的角色名",
    "- 一镜里出现两个角色时，第二个填进角色2 / 角色描述2",
];

const STORY_SCRIPT_STYLE_HINT_SHOT = [
    "- 分镜提示词最好严格按 8 段写：构图、角色卡/主体描述、空间关系、微表情/状态、环境与道具、光影几何、视觉风格、技术参数",
    "- 如果存在角色1，分镜提示词第二段尽量直接使用或轻改角色描述1，不要换成模糊代称",
    "- 分镜提示词中的技术参数段尽量保留，不要省略",
    "- 视频运动提示词最好严格按 6 段写：运镜轨迹、主体动作、环境动态、音效氛围、对白语气、时长",
    "- 视频运动提示词里的主体动作必须是可见物理动作，不要只写情绪变化",
    "- 风格提示词写这一镜的影像风格（影调、质感、颗粒、参考片种/导演），同一场戏保持一致；不需要时写 `无`",
];

const STORY_SCRIPT_STYLE_HINT_ASSET = [
    "- 每一镜都要填「场景 / 场景描述 / 道具 / 道具描述 / 人物站位」，同一场景或同一道具在多镜里必须复用完全一致的名字",
    "- 人物站位要写清谁在画面左侧 / 右侧 / 前景 / 后景、朝向、彼此的远近；除非这一镜人物确实移动，否则保持与上一镜一致",
    "- 人物移动时写清从上一位置到新位置的移动过程，不要让角色在两镜之间凭空换位",
];

const STORY_SCRIPT_STYLE_HINT = ["参考风格要点：", ...STORY_SCRIPT_STYLE_HINT_COMMON, ...STORY_SCRIPT_STYLE_HINT_SHOT, ...STORY_SCRIPT_STYLE_HINT_ASSET].join("\n");

/**
 * 「视频分镜脚本」system prompt。
 * 前段**原文照搬** recipe 的 `system_prompt`；后段是本仓补的输出约定（见文件头「已知的有意偏离」）。
 */
export const STORY_SCRIPT_STORYBOARD_SYSTEM_PROMPT = `你是一名资深分镜编剧兼导演，请基于创意大纲直接生成完整的分镜脚本。

你的输出就是最终分镜脚本，不要返回给另一个模型的提示词或操作说明。

最终输出必须包含以下结构化要素：
-【角色设定】你是一名资深分镜编剧兼导演，精通镜头语言、叙事节奏与视觉表达
-【任务目标】基于以下创意大纲，生成结构化的分镜脚本表格：[从上游创意大纲中提取的核心内容摘要]
-【输出格式要求】最终输出包含 Markdown 表格，每个镜头一行，列包含：镜号（S01起）、时长（精确到秒）、景别（远景/全景/中景/近景/特写/大特写）、画面描述（精确到可直接作为图片生成 prompt）、关键视觉、风格提示词、主体动作、镜头运动（推/拉/摇/移/跟/升/降/固定/手持+速度）、台词/旁白、音效/配乐、转场方式、情绪关键词
-【专业约束】总时长须与创意大纲一致；景别遵循"远→近→远"呼吸节奏，避免连续 3 个以上相同景别；镜头运动静动交替；画面连贯衔接无割裂感
-【质量标准】画面描述必须精确具体，包含主体/背景/道具/光线方向/色调氛围，禁止模糊笼统；完整参照创意大纲的核心信息和情绪弧线

## 本仓输出约定（必须遵守）
- 表头必须使用下列中文列名，且顺序一致：镜号、时长、景别、画面描述、关键视觉、风格提示词、场景、场景描述、道具、道具描述、主体动作、人物站位、镜头运动、台词/旁白、音效/配乐、转场方式、情绪关键词
- 输出 Markdown 表格；也可以改输出一个 JSON 对象：{"title":"标题","rows":[{…}]}，键名用上表列名对应的英文（shot_no / duration / shot / visual_description / key_visual / style_prompt / scene / scene_description / prop / prop_description / character_action / blocking / camera_movement / dialogue / sound / transition / emotion）
- 镜号用 1、2、3 这样的整数（不要写 S01）；时长用整数秒（不要写 3.5秒）
- 同一场景 / 同一道具在多镜里复用完全一致的名字；人物站位（blocking）写清谁在画面左 / 右 / 前 / 后景、朝向与彼此远近，并保持与上一镜一致（人物确实移动时才改）
- 某一格没有内容时写 \`无\``;

const STORY_SCRIPT_STORYBOARD_COMMON_RULES = [
    "输出必须是一张表格，一镜一行，列名与顺序严格按：镜号、时长、景别、画面描述、关键视觉、风格提示词、场景、场景描述、道具、道具描述、主体动作、人物站位、镜头运动、台词/旁白、音效/配乐、转场方式、情绪关键词。",
    "如果用户给了额外要求，也必须一起遵守。",
    "总时长须与创意大纲一致；景别遵循「远→近→远」呼吸节奏，避免连续 3 个以上相同景别。",
    "镜头运动要静动交替，并写清推/拉/摇/移/跟/升/降/固定/手持以及速度。",
    "画面连贯衔接，无割裂感。",
    "画面描述必须精确具体，包含主体/背景/道具/光线方向/色调氛围，且要精确到可直接作为图片生成 prompt。",
    "同一场景 / 同一道具在多镜里复用完全一致的名字；人物站位要写清谁在画面左 / 右 / 前 / 后景、朝向与彼此远近，并保持与上一镜一致（人物确实移动时才改）。",
    "风格提示词写这一镜的影像风格（影调、质感、颗粒、参考片种/导演），同一场戏保持一致；不需要时写 `无`。",
    "缺失内容写 `无`。",
];

/**
 * 单镜模式下一镜的成片秒数（铺链 / 单镜建视频都走这里）。
 * - `10` / `15` = **锁定**：用户选了就生效，不管表格里 `duration` 写了几秒；
 * - `5` = **上限**：表里更短就按表里，超过 5 秒压到 5 秒（默认档的语义是「不超过」）；
 * - `none` = 完全按表里（1~20 秒）。
 */
export function resolveStoryScriptShotSeconds(duration: unknown, segmentSeconds?: unknown): number {
    const target = storyScriptSegmentSecondsValue(segmentSeconds);
    const own = Math.max(1, Math.round(Number(duration) || 0));
    if (target >= 10) return Math.min(20, target);
    if (target > 0) return Math.min(target, Math.max(1, Math.min(20, own)));
    return Math.min(20, own);
}

/**
 * 「每镜 / 每段时长」要求。三种口径，取决于「视频分段」怎么设：
 * - `shot`：**一镜就是一段成片** → 10/15 锁死 `duration` = N；5 秒是上限（≤N）；
 * - `duration` / `2` / `3`：若干镜合并成一段 → 连续几镜的秒数之和凑到 N；
 * - 不传 `mergeMode`（老调用 / 探针）：保持「合计约 N 秒」的老文案，与改造前逐字一致。
 * 不指定（none）时不加任何约束，保持原行为。
 */
function buildSegmentDurationGuidance(segmentSeconds?: unknown, mergeMode?: StoryScriptMergeMode | string | null): string {
    const value = storyScriptSegmentSecondsValue(segmentSeconds);
    if (!value) return "";
    const maxShot = Math.max(3, Math.round(value / 2));
    const mode = mergeMode === undefined || mergeMode === null ? null : resolveStoryScriptMergeMode(mergeMode);
    if (mode === "shot") {
        // 10 / 15 是「锁定」，5 是「上限」——用户对 5 秒的原话是「每镜头不超过 5 秒」。
        if (value < 10) {
            return [
                "## 每镜时长要求",
                `- 每一镜就是一整段成片，单镜 \`duration\` **不要超过 ${value} 秒**（按内容需要写 2~${value} 秒的整数）。`,
                `- 铺链时每一镜直接按它自己的 \`duration\` 出片，所以**不要写超过 ${value} 秒的长镜头**。`,
                `- \`video_motion_prompt\` 里的 \`[时长：Xs]\` 不要超过 ${value} 秒。`,
            ].join("\n");
        }
        return [
            "## 每镜时长要求",
            `- 本次成片按每段 ${value} 秒：**每一镜就是一整段成片**，所以 \`duration\` 必须填 ${value}（每镜都是 ${value} 秒）。`,
            `- 一镜之内要有一个连续的运镜 / 动作把 ${value} 秒填满（起幅 → 过程 → 落幅），不要拆成一堆 2~3 秒的短镜，也不要靠重复动作凑时长。`,
            `- \`video_motion_prompt\` 里的 \`[时长：Xs]\` 写 ${value} 秒。`,
            `- 镜头内部时间线要写清（例如 0-${Math.round(value / 3)}s / ${Math.round(value / 3)}-${Math.round((value * 2) / 3)}s / 尾段），方便视频模型一次成片。`,
        ].join("\n");
    }
    if (mode === "2" || mode === "3") {
        const perSegment = mode === "2" ? 2 : 3;
        return [
            "## 分段时长要求",
            `- 本次目标成片长度约为每段 ${value} 秒（视频模型基本只能按 ${value} 秒出片）。`,
            `- 每 ${perSegment} 镜会合并成一段，因此请让**连续 ${perSegment} 镜的秒数相加正好等于 ${value} 秒**（约每镜 ${Math.max(1, Math.round(value / perSegment))} 秒）。`,
            `- \`duration\` 填该镜的实际秒数（整数），不要写成一个大超长镜头。`,
            `- \`video_motion_prompt\` 里的 \`[时长：Xs]\` 不要超过 ${value} 秒。`,
        ].join("\n");
    }
    return [
        "## 分段时长要求",
        `- 本次目标成片长度约为每段 ${value} 秒（视频模型基本只能按 ${value} 秒出片，长短都算废片）。`,
        `- \`duration\` 仍填该镜的实际秒数（整数），但请让**连续若干镜的秒数相加正好等于 ${value} 秒**：例如 ${value} 秒可以写成 3+3+4、4+6、5+5，或一镜到底直接 ${value} 秒。`,
        `- 单镜尽量落在 2-${maxShot} 秒之间，不要写成一个大超长镜头，也不要让某一段凑不满 ${value} 秒。`,
        `- \`video_motion_prompt\` 里的 \`[时长：Xs]\` 不要超过 ${value} 秒。`,
    ].join("\n");
}

/**
 * 单镜重生成时的时长约束（一行说明，挂在行任务书里）。
 * `shot` 模式下 10/15 必须锁死 N 秒（这一镜自己就是成片）、5 秒是上限；其余模式只要求「别超过 N 秒」。
 */
function buildRowDurationHint(segmentSeconds?: unknown, mergeMode?: StoryScriptMergeMode | string | null): string {
    const value = storyScriptSegmentSecondsValue(segmentSeconds);
    if (!value) return "";
    const mode = mergeMode === undefined || mergeMode === null ? null : resolveStoryScriptMergeMode(mergeMode);
    if (mode === "shot") {
        if (value < 10) {
            return `本镜时长要求：这一镜就是一整段成片，\`duration\` **不要超过 ${value} 秒**（2~${value} 秒的整数）。`;
        }
        return `本镜时长要求：\`duration\` 必须填 ${value} —— 这一镜就是一整段 ${value} 秒的成片，镜头内部要有完整的起幅 / 过程 / 落幅，不要写成 2~3 秒的碎片。`;
    }
    if (mode === null) return "";
    return `本镜时长要求：这一段目标成片 ${value} 秒，这一镜的 \`duration\` 控制在 ${value} 秒以内，给相邻镜留出合并空间。`;
}

/**
 * 源内容本身就是「逐镜标签块」模版时的额外要求：**三列原文搬运**，不许模型改写 / 压缩。
 *
 * ⚠️ 这段的**作用域必须收窄到三列**（`shot_prompt` / `video_motion_prompt` / `style_prompt`）。
 * 第一版写成了「必须原文搬运、不要重写、源内容没给的列按原规则自己补」且**排在资产 / 分镜两段
 * 自定义要求之后**，结果模型把「照搬」当成最高指令：模版里没有的资产列（角色描述 / 场景描述 /
 * 道具描述 / 人物站位）直接留空，连用户填在「资产部分自定义要求」里的写法也一起失效
 * （用户反馈：「现在连资产的提示词都识别不到了，生出的完全是默认提示词模版」）。
 * 现在拆成两层：
 *  1. 本段只交代「这三列从模版照搬」，并明说**其余列（尤其资产列）照常按规则生成、必须填满**；
 *  2. 本段在任务书里**排在两段自定义要求之前**，那两段仍然最后说话。
 * 只有在 `hasStoryScriptShotTemplate(sourceText)` 为真时才拼进去 —— 否则任务书与改造前逐字一致。
 */
const STORY_SCRIPT_TEMPLATE_HINT = [
    "## 源内容已经是逐镜提示词模版（照模版填表，不要重新创作）",
    "源内容每一镜都是 `- **字段名**：内容` 的标签块。",
    "`shot_no` 取 `镜头编号` 末尾数字（`场次01—镜头009` 就是 9），`duration` 取 `镜头时长` 的秒数（`3 秒` → `3`）。",
    "下面这些列的内容模版里**已经写好了**，照搬即可：",
    "- `shot_prompt` ← `首帧图片提示词`：整段原文（含末尾的负面句），**不要**改写成 `[…] + […]` 的 8 段式，也不要压缩 / 合并 / 重排。",
    "- `video_motion_prompt` ← 这一镜里**除** `镜头编号 / 镜头时长 / 所属场景 / 出场人物 / 风格 / 首帧图片提示词 / 镜头叙事作用 / 出场人物资产 / 调用场景资产 / 调用道具资产` 之外的**每一行原样抄进去**（景别、摄影机参数、构图方式、画面内容、人物动作与表演、运镜方式、台词与声音、负面 …），一行一个「标签：内容」，保持模版里的原顺序；**不要**合并，**不要**改写成 `[…] + […]` 或 6 段式。",
    "- `style_prompt` ← `风格提示词` / `视觉风格` 之类的字段；源内容没有这类字段时写 `无`，不要自己编。",
    "- `character_1` ← `出场人物资产`、`scene` ← `调用场景资产`、`prop` ← `调用道具资产`：**去掉 `P-01` / `S-01` / `D-01` 这类编号，只留资产名**",
    "  （`P-01 苏晚（同镜头 001 造型；中近景）` → `苏晚`）；括号内与括号后的文字写进对应的**描述列**",
    "  （`character_description_1` / `scene_description` / `prop_description`）。资产名要与画布素材标题尽量一致，但**不必逐字相同**（意思相近即可），",
    "  绝对不要换成一个模版里没出现的资产。",
    "⚠️ 上面这些列以外的列必须照常生成、每一镜都要填满",
    "（角色2 / 角色描述2 / 人物站位 / 景别 / 画面描述 / 角色动作 / 情绪 / 场景标签 / 光影氛围 / 音效 / 对白 等），",
    "模版里没有这些字段**不代表可以留空**，也不要因为要「照搬」就跳过它们。",
    "- 资产**描述**列（角色描述 / 场景描述 / 道具描述 / 人物站位）的写法以「资产部分自定义要求」为准；",
    "  但**镜数 / 镜号 / 时长 / 资产名**（谁出场、哪个场景、哪个道具）一律以模版为准，自定义要求不能改这几样。",
    "- 本情形下，「分镜提示词按 8 段写 / 视频运动提示词按 6 段写」「括号分段 + 号连接」这类通用写法要求**一律不适用**（照模版原文即可）。",
    "- 输出仍然只给契约 JSON（`rows` 数组），不要把标签块原样贴回来",
].join("\n");

/**
 * 模版的「镜数 + 镜号 + 时长」清单（动态生成，逐个镜号写死）。
 *
 * 用户 2026-10-19 第 03 条：「我使用分镜提示词后，镜头数量请识别这个内容下的，即为 9 个镜头。」
 * 只写「行数必须一致」不够 —— 模型不知道模版到底几镜。这里把 9 个镜号逐个列出来，
 * 让「输出 9 行、镜号 1..9」变成可核对的事实而不是模型的自觉。没有模版时返回空串。
 */
function buildTemplateShotPlanHint(sourceText: string, onlyShotNo?: number): string {
    const blocks = splitStoryScriptTemplateBlocks(String(sourceText || ""));
    if (!blocks.length) return "";
    const shotNos = blocks.map((block, index) => {
        const shotField = block.fields.find((field) => /^(镜头编号|镜号)$/.test(normalizeTemplateLabel(field.label)));
        const no = trailingNumber(shotField?.value || block.heading || "");
        return no || index + 1;
    });
    if (onlyShotNo) {
        return [
            "## 本次只重生成一镜（模版共 N 镜）",
            `源模版共 **${blocks.length} 个镜头**，本次只重写第 **${onlyShotNo}** 镜：`,
            `\`rows\` 里只放 1 个元素，\`shot_no\` 必须是 ${onlyShotNo}；不要输出其它镜头。`,
        ].join("\n");
    }
    return [
        "## 本次镜数 / 镜号（照源模版，不许增删）",
        `源模版共 **${blocks.length} 个镜头**，所以 \`rows\` 必须正好 ${blocks.length} 个元素，`,
        `\`shot_no\` 依次为：${shotNos.join("、")}（不要重新编号、不要合并镜头、不要补镜头）。`,
        "每一镜的 `duration` 照该镜 `镜头时长` 的秒数填写。",
    ].join("\n");
}

/**
 * 系统提示词侧的「本次输入覆盖」段：源内容自带逐镜模版时**追加**在 system prompt 末尾。
 *
 * 为什么任务书里写了还不够：预设 system prompt 的「Prompt formatting rules」把 `shot_prompt` 的
 * **8 段链式结构**、`video_motion_prompt` 的 **6 段链式结构**、以及 `[a] + [b] + …` 的连接方式
 * 写成了硬约束，还配了两条完整示例；`STORY_SCRIPT_COMMON_RULES` 里也有一句「采用括号分段 + 号连接的格式」。
 * 模型对 system prompt 的服从度远高于任务书末段的嘱咐，于是照样吐 `（…）+（…）`（用户反馈的原话：
 * 「不要拆解成下面这样」）。所以模版在场时必须**显式作废**这几条，而不是只靠任务书里一句「不适用」。
 * 不拼时会话内容与改造前逐字一致。
 */
function buildTemplateSystemOverride(singleShot?: boolean): string {
    return [
        "## Override for this input: the source already contains a per-shot prompt template",
        "",
        "The uploaded source is already written shot by shot as `- **field**: value` blocks.",
        "For this run the formatting rules above are **void**: ignore the chained bracket structure (`[a] + [b] + …`),",
        "the 8-part order for `shot_prompt`, the 6-part order for `video_motion_prompt`, and their examples.",
        "",
        "- `shot_prompt`: copy the `首帧图片提示词` value **verbatim** — every sentence, including the trailing negative list. No rewriting, no shortening, no re-ordering, no bracket chaining.",
        "- `video_motion_prompt`: copy **every other line of that shot's block verbatim**, one `label: value` per line, keeping the block's original order (景别 / 摄影机参数 / 构图方式 / 画面内容 / 人物动作与表演 / 运镜方式 / 台词与声音 / 负面 …). Do not merge lines and do not chain them with `+`.",
        "- `style_prompt`: use the block's style field if present, otherwise `无`. Never invent one.",
        "- Asset routing: `character_1` ← `出场人物资产`, `scene` ← `调用场景资产`, `prop` ← `调用道具资产`.",
        "  Strip the `P-01` / `S-01` / `D-01` style code and keep only the asset name (`P-01 苏晚（…）` → `苏晚`);",
        "  put the parenthetical / trailing text into the matching description column (`character_description_1` /",
        "  `scene_description` / `prop_description`). Asset names only have to be close to the canvas asset titles —",
        "  never swap in an asset the template does not mention.",
        "- `shot_no` ← the trailing number of `镜头编号`; `duration` ← the seconds in `镜头时长` (`3 秒` → `3`).",
        // 整表生成要「一模版一块」，单镜重生成只要那一镜 —— 两个模式不能共用同一句。
        singleShot
            ? "- The task asks for **one shot only**: emit exactly 1 row, and its `shot_no` must be that shot's number."
            : "- Emit **exactly one row per template block** — same count, same shot numbers, no merging, no extra shots.",
        "- Every other column (blocking, emotion, sound …) is generated normally per the rules above and must not be left empty.",
        "",
        "Output must still be the schema JSON object.",
    ].join("\n");
}

/**
 * 系统提示词侧的「用户自定义提示词格式」覆盖段：节点里填了「分镜提示词自定义要求」时追加。
 *
 * 用户原话：「当使用了我的分镜提示词的提示词模版后……完全提取复制该段模版内容……不要拆解成下面这样，
 * （固定机位，全景平视，35mm）+（苏晚右手将奶茶杯抬至胸前……）」。他们贴进自定义框的往往就是一整套
 * 字段清单（景别 / 摄影机参数 / 构图方式 / 画面内容 / 人物动作与表演 / 运镜方式 / 台词与声音 / 负面）
 * 或一整段长范文（「最高画质，杰作，超精细，16:9 电影画幅……」），要的是**照着这段写**；
 * 而预设 system prompt 里的「8 段 / 6 段 / `[a] + [b]` 链式」会把它压成括号链。
 * 自定义要求虽然声明了「优先于上文」，但模型对 system prompt 的服从度更高，所以必须在这里**显式作废**。
 * 不拼时会话内容与改造前逐字一致。
 */
const STORY_SCRIPT_CUSTOM_SHOT_SYSTEM_OVERRIDE = [
    "## Override for this input: the user supplied a custom prompt specification",
    "",
    "The task below contains a `分镜提示词自定义要求` section written by the user. That section defines the",
    "required structure and wording of `shot_prompt` / `video_motion_prompt` / `style_prompt`.",
    "For this run the formatting rules above are **void**: ignore the chained bracket structure (`[a] + [b] + …`),",
    "the 8-part order for `shot_prompt`, the 6-part order for `video_motion_prompt`, and all of their examples.",
    "",
    "- If the specification enumerates fields (e.g. 景别 / 摄影机参数 / 构图方式 / 画面内容 / 人物动作与表演 /",
    "  运镜方式 / 台词与声音 / 负面), emit **one `label: value` line per field, in the user's order** —",
    "  never merge two fields into one `(...) + (...)` chain.",
    "- If it gives a long sample paragraph (e.g. a fixed quality string followed by a scene description), keep that",
    "  paragraph's **fixed wording verbatim** (质量串 / 画幅串 / 负面串 / 标点照抄) and only replace the",
    "  shot-specific parts with this shot's content. Do not compress it into brackets.",
    "- Never shorten, summarise, re-order or re-bracket the specification.",
    "- Routing: if the section gives two separate specifications (one for 分镜提示词, one for 视频运动提示词), fill each into",
    "  its own column. If it gives only one unlabeled one: a field list (景别 / 摄影机参数 / 构图方式 / 画面内容 /",
    "  人物动作与表演 / 运镜方式 / 台词与声音 / 负面) belongs to `video_motion_prompt`; a long prose paragraph",
    "  (quality string + scene + negatives) belongs to `shot_prompt`.",
    "- Every other column is still generated normally per the rules above.",
    "",
    "Output must still be the schema JSON object.",
].join("\n");

/** 构建分镜脚本生成任务（classic 对应 dramaclaw 的 build_freezone_story_script_task）。 */
function buildClassicStoryScriptTask({ sourceText, prompt, characterRefs, segmentSeconds, mergeMode, assetPrompt, shotPrompt, assetDedupe }: { sourceText: string; prompt?: string; characterRefs?: string; segmentSeconds?: unknown; mergeMode?: StoryScriptMergeMode | string | null; assetPrompt?: unknown; shotPrompt?: unknown; assetDedupe?: boolean }): string {
    /**
     * 源内容自带逐镜模版 → 把公共规则里「分镜提示词和视频运动提示词都采用括号分段 + 号连接的格式」
     * 这一条**整条摘掉**。留着它，模型会照样吐 `（…）+（…）`（用户原话「不要拆解成下面这样」）——
     * 这句在规则清单里，比任务书后段的嘱咐更靠前也更强硬。没模版时规则逐字不变。
     */
    const templateSource = hasStoryScriptShotTemplate(sourceText);
    // 「分镜提示词自定义要求」在场时同理：用户给的是一套自己的格式，公共规则里那句「括号分段 + 号连接」
    // 与它直接冲突，留着就还是会被模型当成硬要求执行（见 STORY_SCRIPT_CUSTOM_SHOT_SYSTEM_OVERRIDE）。
    const customShotPrompt = hasScriptGenerationPrompt(shotPrompt);
    const commonRules = templateSource || customShotPrompt ? STORY_SCRIPT_COMMON_RULES.filter((rule) => !rule.includes("括号分段")) : STORY_SCRIPT_COMMON_RULES;
    const parts = ["根据以下上传剧本内容生成一个完整的故事脚本表。", ...commonRules];
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    if (characterRefs && characterRefs.trim()) {
        parts.push(`已提供的角色参考（请在角色1 / 角色2 字段里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    }
    const segmentGuidance = buildSegmentDurationGuidance(segmentSeconds, mergeMode);
    if (segmentGuidance) parts.push(segmentGuidance);
    // 设了专项自定义要求 → 把预设里对应的那几行**整段省掉**，免得两套说法互相打架。
    // 没设时直接用常量，保证与改造前逐字节一致。
    const hasAssetCustom = hasScriptGenerationPrompt(assetPrompt);
    const hasShotCustom = hasScriptGenerationPrompt(shotPrompt);
    parts.push(
        hasAssetCustom || hasShotCustom
            ? ["参考风格要点：", ...STORY_SCRIPT_STYLE_HINT_COMMON, ...(hasShotCustom ? [] : STORY_SCRIPT_STYLE_HINT_SHOT), ...(hasAssetCustom ? [] : STORY_SCRIPT_STYLE_HINT_ASSET)].join("\n")
            : STORY_SCRIPT_STYLE_HINT,
    );
    // 源内容自带逐镜模版 → 交代「三列照搬」。位置刻意夹在「参考风格要点」之后、两段自定义要求之前：
    // ① 通用 8 段/6 段写法不能压过模版原文；② 资产 / 分镜两段自定义要求本身声明了「优先于上文」，
    //    而模型对越靠后的指令越服从 —— 上一版把它放在最末，结果「照搬」压过了用户的资产要求，资产列全空。
    // 没有模版时这段逐字不出现，老任务书不变。
    if (templateSource) parts.push(STORY_SCRIPT_TEMPLATE_HINT, buildTemplateShotPlanHint(sourceText));
    parts.push(...buildScriptGenerationPromptSections({ assetPrompt, shotPrompt }));
    // 资产描述去重：紧贴 JSON 契约之前（模型对越靠后的指令越服从），与 system 里那段是同一份文本。
    if (assetDedupe) parts.push(STORY_SCRIPT_ASSET_DEDUPE_SYSTEM_OVERRIDE);
    parts.push(STORY_SCRIPT_JSON_CONTRACT);
    parts.push(`源剧本内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/** 构建「视频分镜脚本」任务。首句即 recipe 的 `planning_prompt` 原文（说明这一节点要产出什么）。 */
function buildStoryboardTask({ sourceText, prompt, characterRefs, segmentSeconds, mergeMode, assetPrompt, shotPrompt, assetDedupe }: { sourceText: string; prompt?: string; characterRefs?: string; segmentSeconds?: unknown; mergeMode?: StoryScriptMergeMode | string | null; assetPrompt?: unknown; shotPrompt?: unknown; assetDedupe?: boolean }): string {
    const parts = ["根据创意大纲直接生成含镜号、画面、运镜和转场的分镜脚本表格。", ...STORY_SCRIPT_STORYBOARD_COMMON_RULES];
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    if (characterRefs && characterRefs.trim()) {
        parts.push(`已提供的角色参考（请在画面描述 / 关键视觉 / 主体动作里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    }
    const segmentGuidance = buildSegmentDurationGuidance(segmentSeconds, mergeMode);
    if (segmentGuidance) parts.push(segmentGuidance);
    // 逐镜模版同样夹在专项要求之前（理由同 classic）。
    if (hasStoryScriptShotTemplate(sourceText)) parts.push(STORY_SCRIPT_TEMPLATE_HINT, buildTemplateShotPlanHint(sourceText));
    // storyboard 的规则全在 system prompt 里，没有可整段替换的「参考风格要点」，所以只追加专项要求。
    parts.push(...buildScriptGenerationPromptSections({ assetPrompt, shotPrompt }));
    if (assetDedupe) parts.push(STORY_SCRIPT_ASSET_DEDUPE_SYSTEM_OVERRIDE);
    parts.push(`创意大纲 / 源内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/**
 * 把一镜压成「中文列名：值」的多行文本，作为单镜重生成时的上下文。
 * 只取文字列、空值写「无」，避免把整张表原样塞回任务书。
 */
function describeRowForContext(row: StoryScriptRow | undefined, columns: StoryScriptColumn[]): string {
    if (!row) return "";
    return columns
        .filter((column) => !column.numeric)
        .map((column) => `${column.label}：${storyScriptCellText(row[column.key]) || "无"}`)
        .join("\n");
}

/**
 * 「只重写某一镜」的任务书（经典预设）。带上上一镜 / 下一镜上下文，重点要求：
 * 人物站位、场景、道具与前后镜保持一致——这正是「重生成本镜」追回资产描述的关键。
 */
function buildClassicRowTask({ sourceText, prompt, row, prev, next, characterRefs, extraPlot, keepBlocking, segmentSeconds, mergeMode, assetPrompt, shotPrompt }: StoryScriptRowTaskInput): string {
    const columns = STORY_SCRIPT_CLASSIC_COLUMNS;
    const templateSource = hasStoryScriptShotTemplate(sourceText);
    // 同整表任务书：模版或自定义分镜提示词在场 → 摘掉「括号分段 + 号连接」这条。
    const commonRules = templateSource || hasScriptGenerationPrompt(shotPrompt) ? STORY_SCRIPT_COMMON_RULES.filter((rule) => !rule.includes("括号分段")) : STORY_SCRIPT_COMMON_RULES;
    const parts = [`下面是一张分镜表的第 ${row.shot_no} 镜。请**只重新生成这一镜**（镜号保持 ${row.shot_no} 不变），其余镜头不要输出。`, ...commonRules];
    // 时长是硬约束，放前面：单镜模式下这一镜自己就是成片，模型最容易在这里写成 2~3 秒碎片。
    const durationHint = buildRowDurationHint(segmentSeconds, mergeMode);
    if (durationHint) parts.push(durationHint);
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    if (extraPlot && extraPlot.trim()) parts.push(`这一镜要追加 / 修改的剧情（只改这一镜，其余镜头不要跟着改）：\n${extraPlot.trim()}`);
    const prevText = describeRowForContext(prev, columns);
    if (prevText) {
        parts.push(
            keepBlocking === false
                ? `上一镜（第 ${prev?.shot_no} 镜，剧情要能接上，但**人物站位可以重新安排**，不必与它保持一致）：\n${prevText}`
                : `上一镜（第 ${prev?.shot_no} 镜，人物站位 / 场景 / 道具必须与它衔接）：\n${prevText}`,
        );
    }
    const nextText = describeRowForContext(next, columns);
    if (nextText) parts.push(`下一镜（第 ${next?.shot_no} 镜，这一镜不要和它冲突）：\n${nextText}`);
    const currentText = describeRowForContext(row, columns);
    if (currentText) parts.push(`这一镜当前的内容（可以全部重写，也可以只修掉不合理或缺失的字段）：\n${currentText}`);
    if (characterRefs && characterRefs.trim()) parts.push(`已提供的角色参考（请在角色1 / 角色2 字段里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    // 逐镜模版同样夹在专项要求之前（理由同整表任务书）。
    if (hasStoryScriptShotTemplate(sourceText)) parts.push(STORY_SCRIPT_TEMPLATE_HINT, buildTemplateShotPlanHint(sourceText, row.shot_no));
    /**
     * 「参考风格要点」必须排在专项要求**之前**（老版本排在其后，是个坑）：
     * 它里面写着「分镜提示词按 8 段写 / 视频运动提示词按 6 段写」，与用户自定义格式直接冲突；
     * 排在自定义要求后面，模型会把它当成更晚、更强的一条，于是照样吐 `（…）+（…）`。
     * 与整表任务书同一口径：设了自定义要求 → 对应那几行整段省掉。
     */
    const hasAssetCustom = hasScriptGenerationPrompt(assetPrompt);
    const hasShotCustom = hasScriptGenerationPrompt(shotPrompt);
    parts.push(
        hasAssetCustom || hasShotCustom
            ? ["参考风格要点：", ...STORY_SCRIPT_STYLE_HINT_COMMON, ...(hasShotCustom ? [] : STORY_SCRIPT_STYLE_HINT_SHOT), ...(hasAssetCustom ? [] : STORY_SCRIPT_STYLE_HINT_ASSET)].join("\n")
            : STORY_SCRIPT_STYLE_HINT,
    );
    // 专项要求比「参考风格要点」更具体，放在它后面（越靠后越优先）。
    parts.push(...buildScriptGenerationPromptSections({ assetPrompt, shotPrompt }));
    parts.push(STORY_SCRIPT_JSON_CONTRACT);
    parts.push(`只输出这一镜：JSON 的 rows 数组里只放 1 个元素，\`shot_no\` 必须是 ${row.shot_no}。`);
    if (sourceText.trim()) parts.push(`源剧本内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/** 「只重写某一镜」的任务书（视频分镜脚本预设）。 */
function buildStoryboardRowTask({ sourceText, prompt, row, prev, next, characterRefs, extraPlot, keepBlocking, segmentSeconds, mergeMode, assetPrompt, shotPrompt }: StoryScriptRowTaskInput): string {
    const columns = STORY_SCRIPT_STORYBOARD_COLUMNS;
    const parts = [`下面是一张分镜表的第 ${row.shot_no} 镜。请只重新生成这一镜（镜号保持 ${row.shot_no} 不变），其余镜头不要输出。`, ...STORY_SCRIPT_STORYBOARD_COMMON_RULES];
    // 同 classic：单镜模式下「这一镜 = 一整段成片」，时长必须在重写时就锁死。
    const durationHint = buildRowDurationHint(segmentSeconds, mergeMode);
    if (durationHint) parts.push(durationHint);
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    if (extraPlot && extraPlot.trim()) parts.push(`这一镜要追加 / 修改的剧情（只改这一镜，其余镜头不要跟着改）：\n${extraPlot.trim()}`);
    const prevText = describeRowForContext(prev, columns);
    if (prevText) {
        parts.push(
            keepBlocking === false
                ? `上一镜（第 ${prev?.shot_no} 镜，剧情要能接上，但**人物站位可以重新安排**，不必与它保持一致）：\n${prevText}`
                : `上一镜（第 ${prev?.shot_no} 镜，场景 / 道具 / 人物站位必须与它衔接）：\n${prevText}`,
        );
    }
    const nextText = describeRowForContext(next, columns);
    if (nextText) parts.push(`下一镜（第 ${next?.shot_no} 镜，这一镜不要和它冲突）：\n${nextText}`);
    const currentText = describeRowForContext(row, columns);
    if (currentText) parts.push(`这一镜当前的内容（可以全部重写，也可以只修掉不合理或缺失的字段）：\n${currentText}`);
    if (characterRefs && characterRefs.trim()) parts.push(`已提供的角色参考（请在画面描述 / 关键视觉 / 主体动作里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    // 与整表生成同口径：两路专项要求各管一摊（资产 / 画面与提示词写法）。
    parts.push(...buildScriptGenerationPromptSections({ assetPrompt, shotPrompt }));
    parts.push(`只输出这一镜：Markdown 表格只保留表头 + 这 1 行；若用 JSON，rows 里只放 1 个元素，\`shot_no\` 必须是 ${row.shot_no}。`);
    if (sourceText.trim()) parts.push(`创意大纲 / 源内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/**
 * 把这一镜的「风格提示词」拼进图片 / 视频提示词。
 *
 * 为什么是「追加在末尾」而不是塞进分镜提示词的第 7 段：分镜提示词由模型生成、用户可能手改，
 * 去改它的内部结构风险太大；追加一行最直观，用户在图片节点的输入框里一眼能看到风格是什么。
 * 三个不写的情况：风格为空 / 风格是 `无` / 提示词里本来就含这段文字（避免重复两遍）。
 * 只认字符串：这一列是自由文本，数字 / 对象出现在这里只能是模型的脏数据，拼成「视觉风格：123」纯属污染。
 */
export function withStoryScriptStyle(prompt: string, style?: unknown): string {
    const base = (prompt || "").trim();
    const styleText = typeof style === "string" ? storyScriptCellText(style) : "";
    if (!styleText) return base;
    if (!base) return `视觉风格：${styleText}`;
    if (base.includes(styleText)) return base;
    return `${base}\n视觉风格：${styleText}`;
}

/**
 * 这一镜该用的风格提示词。
 *
 * 预设自带的 `style_prompt` 列优先；用户用「新建列」把风格单独拎出去时（列名如「场景风格」「风格提示词」），
 * 自建列里第一个非空值兜底 —— 否则一键铺链明明看得到那一列，却不会把它带进图片 / 视频节点。
 */
export function resolveStoryScriptStyleText(row: StoryScriptRow, extras?: readonly StoryScriptExtraColumn[] | null): string {
    const own = typeof row.style_prompt === "string" ? storyScriptCellText(row.style_prompt) : "";
    if (own) return own;
    for (const column of extras || []) {
        if (!/风格/.test(String(column.label || ""))) continue;
        const value = storyScriptCellText(row[column.key]);
        if (value) return value;
    }
    return "";
}

/**
 * 经典预设：`shot_prompt` / `video_motion_prompt` 本身已是成段的完整提示词（8 段 / 6 段），
 * 有就直接用；模型偶尔漏列，此时用可见描述兜底拼一条，避免这一行铺不出链路。
 * 两条提示词最后都拼上「风格提示词」列（见 `withStoryScriptStyle`）。
 */
function buildClassicShotPrompts(row: StoryScriptRow, extras?: readonly StoryScriptExtraColumn[] | null): StoryScriptShotPrompts {
    const imagePrompt =
        storyScriptCellText(row.shot_prompt) ||
        joinStoryScriptPromptParts([row.visual_description, row.shot, row.emotion, row.scene_tags, row.lighting_mood]);
    const videoPrompt =
        storyScriptCellText(row.video_motion_prompt) ||
        joinStoryScriptPromptParts([row.character_action, row.visual_description, row.shot, row.emotion]);
    const style = resolveStoryScriptStyleText(row, extras);
    return {
        imagePrompt: withStoryScriptStyle(imagePrompt, style),
        videoPrompt: withStoryScriptStyle(videoPrompt, style),
    };
}

/** 视频分镜脚本预设：没有独立的「生成提示词」列，按 recipe 对该列的语义（可直接当 prompt）现拼。 */
function buildStoryboardShotPrompts(row: StoryScriptRow, extras?: readonly StoryScriptExtraColumn[] | null): StoryScriptShotPrompts {
    const style = resolveStoryScriptStyleText(row, extras);
    return {
        imagePrompt: withStoryScriptStyle(joinStoryScriptPromptParts([row.visual_description, row.key_visual]), style),
        videoPrompt: withStoryScriptStyle(joinStoryScriptPromptParts([row.camera_movement, row.character_action, row.visual_description, row.emotion]), style),
    };
}

export const STORY_SCRIPT_PRESETS: Record<StoryScriptPresetId, StoryScriptPreset> = {
    classic: {
        id: "classic",
        columns: STORY_SCRIPT_CLASSIC_COLUMNS,
        systemPrompt: STORY_SCRIPT_SYSTEM_PROMPT,
        rowActions: [
            { key: "shot_prompt", labelKey: "copyShotPrompt" },
            { key: "video_motion_prompt", labelKey: "copyMotionPrompt" },
        ],
        insertKey: "shot_prompt",
        buildTask: buildClassicStoryScriptTask,
        buildRowTask: buildClassicRowTask,
        buildShotPrompts: buildClassicShotPrompts,
        assetKeys: ["character_1", "character_2"],
    },
    storyboard: {
        id: "storyboard",
        columns: STORY_SCRIPT_STORYBOARD_COLUMNS,
        systemPrompt: STORY_SCRIPT_STORYBOARD_SYSTEM_PROMPT,
        rowActions: [
            { key: "visual_description", labelKey: "copyVisualPrompt" },
            { key: "camera_movement", labelKey: "copyCameraMovement" },
        ],
        insertKey: "visual_description",
        buildTask: buildStoryboardTask,
        buildRowTask: buildStoryboardRowTask,
        buildShotPrompts: buildStoryboardShotPrompts,
        // storyboard 没有角色列（recipe 把它放在「主体动作」里），所以不做名字匹配 → 全部素材图都连。
    },
};

export const STORY_SCRIPT_PRESET_IDS: StoryScriptPresetId[] = ["classic", "storyboard"];

/** 归一化预设 id：未知值一律回落到 classic。 */
export function resolveStoryScriptPresetId(value: unknown): StoryScriptPresetId {
    return value === "storyboard" ? "storyboard" : "classic";
}

export function getStoryScriptPreset(preset?: StoryScriptPresetId | string | null): StoryScriptPreset {
    return STORY_SCRIPT_PRESETS[resolveStoryScriptPresetId(preset)];
}

export function getStoryScriptColumns(preset?: StoryScriptPresetId | string | null): StoryScriptColumn[] {
    return getStoryScriptPreset(preset).columns;
}

export function getStoryScriptSystemPrompt(preset?: StoryScriptPresetId | string | null): string {
    return getStoryScriptPreset(preset).systemPrompt;
}

/**
 * 实际发给模型的系统提示词：**节点级自定义覆盖优先**，为空（或纯空白）时回落到预设自带的那段。
 *
 * 这就是「换一个生成器」的挂点——用户在脚本节点的「自定义提示词」里粘一段别的提示词，
 * 不改代码就能换掉生成策略；列定义 / 解析 / 导出仍按预设走，所以覆盖不会破坏表格结构。
 * 返回值一定是非空字符串（预设本身保证非空），调用方无需再判空。
 */
export function resolveScriptSystemPrompt(
    preset?: StoryScriptPresetId | string | null,
    override?: unknown,
    options?: {
        /** 源内容自带逐镜标签模版 → 作废「8 段 / 6 段 / 括号+号链式」。 */
        verbatimTemplate?: boolean;
        /** 节点里填了「分镜提示词自定义要求」→ 以用户那套格式为准，同样作废链式写法。 */
        customShotFormat?: boolean;
        /** 本次只重生成一镜（单镜任务书）→ 覆盖段改成「只要这一镜」，不能说「一模版一块」。 */
        singleShot?: boolean;
        /**
         * 资产描述去重（同名资产只在首现镜写全，后面几镜留空）→ 追加 `STORY_SCRIPT_ASSET_DEDUPE_SYSTEM_OVERRIDE`。
         * 单独一个开关，是因为第二 / 第三套的 system 是用户词库里的文本，没法改原文，只能往后追加。
         */
        assetDedupe?: boolean;
    },
): string {
    const custom = typeof override === "string" ? override.trim() : "";
    const base = custom || getStoryScriptSystemPrompt(preset);
    // 这两种情形都必须显式作废预设里的链式写法（见两个 *_SYSTEM_OVERRIDE 的注释）：
    // 模型对 system prompt 的服从度高于任务书末段的「以上不适用」，只改任务书压不住。
    const extra: string[] = [];
    if (options?.verbatimTemplate) extra.push(buildTemplateSystemOverride(options?.singleShot));
    if (options?.customShotFormat) extra.push(STORY_SCRIPT_CUSTOM_SHOT_SYSTEM_OVERRIDE);
    // 去重段放最后：它要压过前面（含用户词库）关于「每镜都写全资产描述」的说明。
    if (options?.assetDedupe) extra.push(STORY_SCRIPT_ASSET_DEDUPE_SYSTEM_OVERRIDE);
    // 都没有时返回字符串与改造前逐字一致（探针守着老调用点）。
    return extra.length ? `${base}\n\n${extra.join("\n\n")}` : base;
}

/** 该节点是否用的是自定义系统提示词（供 UI 打「已自定义」角标）。 */
export function hasScriptSystemPromptOverride(override?: unknown): boolean {
    return typeof override === "string" && override.trim().length > 0;
}

/**
 * 「资产提示词」/「分镜提示词」两路节点级自定义要求。
 *
 * 用户原话：「需要能够将资产的生成和分镜提示词的生成使用不同的提示词来控制，进行分镜表中资产和
 * 分镜提示词的生成」。与 `scriptSystemPrompt`（**整段替换** system prompt，换一个生成器）不同，
 * 这两个是**任务书里的两段专项要求**，各自只作用于自己那一组列：
 *   - 资产：角色1 / 角色描述1 / 角色2 / 角色描述2 / 场景 / 场景描述 / 道具 / 道具描述 / 人物站位；
 *   - 分镜提示词：分镜提示词 / 视频运动提示词 / 风格提示词（storyboard 预设则是画面描述 / 关键视觉 /
 *     主体动作 / 镜头运动这类可见描述）。
 *
 * 都为空时任务书与改造前**逐字一致**（探针守着）——所以老节点、老调用点零行为变化。
 */
export function hasScriptGenerationPrompt(value?: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

/** 「资产」专项要求块；空 → 空串（由调用方 filter 掉）。 */
export function buildScriptAssetPromptSection(override?: unknown): string {
    const text = typeof override === "string" ? override.trim() : "";
    if (!text) return "";
    return [
        "## 资产部分自定义要求（角色 / 场景 / 道具 / 人物站位）",
        "- 以下要求**优先于**上文所有与资产相关的说明（字段内容、命名、写法格式都算）；有冲突时以本段为准。",
        "- 本段只影响资产类列（角色与角色描述、场景与场景描述、道具与道具描述、人物站位）；当前预设里没有的列直接忽略，其余列仍按上文要求输出。",
        text,
    ].join("\n");
}

/** 「分镜提示词」专项要求块；空 → 空串。 */
export function buildScriptShotPromptSection(override?: unknown): string {
    const text = typeof override === "string" ? override.trim() : "";
    if (!text) return "";
    return [
        "## 分镜提示词自定义要求（分镜提示词 / 视频运动提示词 / 风格提示词）",
        "- 以下要求**优先于**上文所有与提示词写法相关的说明（段落结构、括号分段、技术参数等）；有冲突时以本段为准。",
        "- 本段只影响与画面 / 运镜 / 提示词写法相关的列（分镜提示词、视频运动提示词、风格提示词，以及画面描述、关键视觉、主体动作、镜头运动这类可见描述）；其余列仍按上文要求输出。",
        // 用户贴进来的常常就是「模版」本身（字段清单或长段范文），要的是照抄结构而不是归纳成括号链。
        "- 如果本段给的是**模版**（字段清单、固定句式、长段范文），就按它**逐行原样照写**：字段名、字段顺序、固定文字（质量串 / 画幅串 / 负面串 / 标点）一律保留，只把与该镜有关的占位内容换成本镜内容；**不要**合并字段，**不要**改写成 `（…）+（…）` 或 8 段 / 6 段链式，**不要**压缩、概括、调序。",
        "- 落列口径：本段若分别给了「分镜提示词」和「视频运动提示词」两套写法，就各自填进对应列，不要混在一起；只给一套且没点名列时 —— `景别 / 摄影机参数 / 构图方式 / 画面内容 / 人物动作与表演 / 运镜方式 / 台词与声音 / 负面` 这一组字段清单归**视频运动提示词**，整段「画质 + 场景 + 负面」式的长范文归**分镜提示词**。",
        text,
    ].join("\n");
}

/** 两段专项要求按「资产 → 分镜提示词」顺序拼成数组（空的自动跳过），任务书直接 spread。 */
export function buildScriptGenerationPromptSections({ assetPrompt, shotPrompt }: { assetPrompt?: unknown; shotPrompt?: unknown }): string[] {
    return [buildScriptAssetPromptSection(assetPrompt), buildScriptShotPromptSection(shotPrompt)].filter((section) => section.length > 0);
}

/** 铺链路时可挂到某一镜上的素材（只需要 id + 标题）。 */
export type StoryScriptAssetRef = { id: string; title: string };

/**
 * 脚本节点上游「资产」的分类。分类决定铺链路时这张素材会连到哪些节点：
 *  - character 角色：按分镜里的角色名逐镜匹配（沿用 `matchStoryScriptRowAssets`），连到图片节点；
 *  - scene / prop / blocking 场景 / 道具 / 站位图：与具体某个人物无关，对每一镜都成立，逐镜全连（图片节点）；
 *  - audio 音频：不是画面素材，铺链路时**只直连视频节点**（音频是成片的一部分，塞给图片节点没意义）。
 */
export type ScriptAssetRole = "character" | "scene" | "prop" | "blocking" | "audio";

export const SCRIPT_ASSET_ROLE_IDS: ScriptAssetRole[] = ["character", "scene", "prop", "blocking", "audio"];

/**
 * 「AI 生成」tab 能生成的分类：那个 tab 走的是**生图**链路（`handleGenerateScriptAsset` → 图片节点），
 * 生成不了音频，所以把 audio 排除——音频只能走「从画布链接」或「上传文件」。
 */
export const SCRIPT_ASSET_GENERATABLE_ROLE_IDS: ScriptAssetRole[] = ["character", "scene", "prop", "blocking"];

/** 音频素材铺链路时只直连视频节点（画面素材才连图片节点）。 */
export function isAudioScriptAssetRole(role: unknown): boolean {
    return resolveScriptAssetRole(role) === "audio";
}

/** 分类 id 归一化：未知值一律回落到 character（等同旧行为——没分类的素材按角色处理）。 */
export function resolveScriptAssetRole(value: unknown): ScriptAssetRole {
    return SCRIPT_ASSET_ROLE_IDS.includes(value as ScriptAssetRole) ? (value as ScriptAssetRole) : "character";
}

/** 点击分类胶囊时的轮转顺序：角色 → 场景 → 道具 → 站位图 → 音频 → 角色。 */
export function nextScriptAssetRole(current: unknown): ScriptAssetRole {
    const index = SCRIPT_ASSET_ROLE_IDS.indexOf(resolveScriptAssetRole(current));
    return SCRIPT_ASSET_ROLE_IDS[(index + 1) % SCRIPT_ASSET_ROLE_IDS.length];
}

/** 角色分类之外的素材（场景 / 道具 / 站位图 / 音频）铺链路时对每一镜都成立（音频只连视频节点）。 */
export function isGlobalScriptAssetRole(role: ScriptAssetRole): boolean {
    return role !== "character";
}

/**
 * 「每镜时长」档位（5 / 10 / 15 / 不限制）：同时决定生成时的时长要求与铺链路的成片秒数。
 * 5 是**上限**（默认）、10 / 15 是**锁定**，口径见 `resolveStoryScriptShotSeconds`。
 */
export type StoryScriptSegmentSeconds = "none" | "5" | "10" | "15";
/**
 * 「每镜时长」档位。**默认 5 秒**（用户拍板：「默认状态是每镜头不超过 5 秒，也可以选 10 / 15」）。
 * - `5`：**上限**——每镜写 2~5 秒都行，不许超；
 * - `10` / `15`：**锁定**——每镜就是 10 / 15 秒（用户明确要「每个镜头 10 秒」）；
 * - `none`：不限制，完全按表格 `duration`（逃生口，别再塞回默认）。
 */
export const STORY_SCRIPT_SEGMENT_SECONDS: StoryScriptSegmentSeconds[] = ["5", "10", "15", "none"];
export const DEFAULT_STORY_SCRIPT_SEGMENT_SECONDS: StoryScriptSegmentSeconds = "5";

export function resolveStoryScriptSegmentSeconds(value: unknown): StoryScriptSegmentSeconds {
    return STORY_SCRIPT_SEGMENT_SECONDS.includes(value as StoryScriptSegmentSeconds) ? (value as StoryScriptSegmentSeconds) : DEFAULT_STORY_SCRIPT_SEGMENT_SECONDS;
}

/** 取「每镜时长」的数值；`none`（不限制）返回 0。 */
export function storyScriptSegmentSecondsValue(value: unknown): number {
    const id = resolveStoryScriptSegmentSeconds(value);
    return id === "none" ? 0 : Number(id);
}

/** 铺链路时的视频分段方式：单镜 / 每 N 镜合并 / 按每段时长自动合并。 */
export type StoryScriptMergeMode = "shot" | "2" | "3" | "duration";
export const STORY_SCRIPT_MERGE_MODES: StoryScriptMergeMode[] = ["shot", "2", "3", "duration"];

export function resolveStoryScriptMergeMode(value: unknown): StoryScriptMergeMode {
    return STORY_SCRIPT_MERGE_MODES.includes(value as StoryScriptMergeMode) ? (value as StoryScriptMergeMode) : "shot";
}

/**
 * 脚本节点内容的基准字号（px）：分镜表是十几列的宽表，小屏/大屏、远看/近看的诉求差很多，
 * 所以给一个可调档位（步进式，避免出现 13.5px 这种糊字）。
 *
 * 组件里除基准字号外**全部用 `em`**，所以改这一个值即可整体缩放；
 * 各 `em` 值是按 13px 那套像素值定的比例（12px → 0.923em 等），所以任何档位都只是等比缩放。
 *
 * 默认档 **15px**（用户两轮要求：先「默认可读」定 20，再「整体太占地方」降到 15）。
 * 觉得小可以点顶部 `A+`，档位会存进 `metadata.scriptFontSize`，只影响这一个脚本节点。
 */
export const STORY_SCRIPT_FONT_SIZES: number[] = [11, 12, 13, 14, 15, 16, 18, 20];
export const DEFAULT_STORY_SCRIPT_FONT_SIZE = 15;

export function resolveStoryScriptFontSize(value: unknown): number {
    const size = Math.round(Number(value));
    if (!Number.isFinite(size) || size <= 0) return DEFAULT_STORY_SCRIPT_FONT_SIZE;
    // 落到最近的档位：手写 15 之类的值时也能收敛到合法档，避免 em 基准漂移。
    return STORY_SCRIPT_FONT_SIZES.reduce((best, current) => (Math.abs(current - size) < Math.abs(best - size) ? current : best), DEFAULT_STORY_SCRIPT_FONT_SIZE);
}

/** 上一档 / 下一档（到头返回 null，调用方据此置灰按钮）。 */
export function stepStoryScriptFontSize(value: unknown, delta: number): number | null {
    const current = resolveStoryScriptFontSize(value);
    const index = STORY_SCRIPT_FONT_SIZES.indexOf(current);
    const next = index + (delta > 0 ? 1 : -1);
    if (next < 0 || next >= STORY_SCRIPT_FONT_SIZES.length) return null;
    return STORY_SCRIPT_FONT_SIZES[next];
}

/** 一段连续镜头 = 铺链路时的一个视频节点。 */
export type StoryScriptRowGroup = { rows: StoryScriptRow[] };

/**
 * 把分镜行切成一段一段，**每个分组铺出一个视频节点**。
 * - `shot`：一镜一段；
 * - `2` / `3`：连续 2 / 3 镜一段；
 * - `duration`：按每段目标时长累加，凑够目标就切段（第一镜就超长时也单独成段；没设时长则退回单镜）。
 */
export function groupStoryScriptRows(
    rows: StoryScriptRow[],
    mode?: StoryScriptMergeMode | string | null,
    segmentSeconds?: unknown,
): StoryScriptRowGroup[] {
    const resolved = resolveStoryScriptMergeMode(mode);
    const target = storyScriptSegmentSecondsValue(segmentSeconds);
    if (resolved === "duration" && target > 0) {
        const groups: StoryScriptRowGroup[] = [];
        let current: StoryScriptRow[] = [];
        let acc = 0;
        for (const row of rows) {
            current.push(row);
            acc += Math.max(1, Math.round(Number(row.duration) || 0));
            if (acc >= target) {
                groups.push({ rows: current });
                current = [];
                acc = 0;
            }
        }
        if (current.length) groups.push({ rows: current });
        return groups;
    }
    const size = resolved === "2" ? 2 : resolved === "3" ? 3 : 1;
    const groups: StoryScriptRowGroup[] = [];
    for (let index = 0; index < rows.length; index += size) groups.push({ rows: rows.slice(index, index + size) });
    return groups;
}

/** 一段里的总时长（秒）：各镜 duration 之和，至少 1 秒。 */
export function storyScriptGroupDuration(group: StoryScriptRowGroup): number {
    return Math.max(1, Math.round(group.rows.reduce((sum, row) => sum + Math.max(1, Math.round(Number(row.duration) || 0)), 0)));
}

/**
 * 把多个镜头合并成一个视频节点的提示词：逐镜列出**视频段**（视频运动提示词 / 镜头运动 …）。
 *
 * 这个函数与「单镜」走的是同一条来源（`buildShotPrompts().videoPrompt`），差别只在排版：
 * 多镜时按「第N镜」分块列出，且**镜与镜之间不做去重**——不同镜头合法地复用同一句动作描述时，
 * 去重会丢掉先后顺序。只剩一个镜有内容时等价于 `buildVideoNodePrompt`（不加抬头，也不挂镜号）。
 *
 * ⚠️ 这里**不再收 `imagePrompt`**（2026-10-19 用户要求：铺链路出的视频节点里不要塞分镜表中的
 * 「分镜提示词」）。分镜提示词已经在本镜的文本节点 / 图片节点上，关键帧就是按它生成的；视频节点
 * 再抄一遍，只会让长段画面描述把运镜指令淹掉，模型反而抓不到「怎么动」。
 */
export function buildMergedVideoNodePrompt(shots: Array<{ shotNo?: number; videoPrompt?: unknown }>): string {
    const kept = shots
        .map((shot, index) => ({ no: shot.shotNo || index + 1, body: buildVideoNodePrompt(shot.videoPrompt) }))
        .filter((item) => Boolean(item.body));
    if (!kept.length) return "";
    if (kept.length === 1) return kept[0].body;
    const merged = [`多镜头连续片段（共 ${kept.length} 镜）：`, ...kept.map((item) => `第${item.no}镜\n${item.body}`)].join("\n\n");
    // 同一场戏各镜的风格提示词通常一模一样：逐镜重复 N 遍只会把提示词撑长、稀释画面描述。同文只留一条。
    return dedupeStoryScriptStyleLines(merged);
}

/** 合并后的视频提示词里，重复的「视觉风格：…」只保留第一次出现的那条。 */
function dedupeStoryScriptStyleLines(text: string): string {
    const seen = new Set<string>();
    return text
        .split("\n")
        .filter((line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("视觉风格：")) return true;
            if (seen.has(trimmed)) return false;
            seen.add(trimmed);
            return true;
        })
        .join("\n");
}

/** 资产编号前缀：`P-01` / `S-01` / `D-01`（与模版解析共用同一套写法）。 */
const STORY_SCRIPT_ASSET_CODE_PREFIX = /^[A-Za-z]{1,3}\s*[-_－]?\s*\d{1,4}\s*[:：.、]?\s*/;

/**
 * 资产名归一化：去 `P-01` 编号、去括号注释、去空白与标点。
 *
 * 用户原话：「可以进行相近识别，资产命名类似的就可以，不用把资产名锁太死」。
 * 模版里写 `S-01 奶茶店门外人行道（阴天午后，主光上方偏左…）`，画布素材标题可能只叫
 * 「奶茶店门口」——归一化之后再算相似度，才不会因为多了编号 / 注释 / 几个字就掉链。
 */
function normalizeScriptAssetMatchText(value: string): string {
    return String(value || "")
        .replace(STORY_SCRIPT_ASSET_CODE_PREFIX, "")
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(/[\s_\-－·、,，。.：:；;/\\|"'“”‘’「」『』【】\[\]（）()]/g, "")
        .toLowerCase();
}

/** 字符二元组（中文按字切，英文数字按字切都够用）。 */
function scriptAssetBigrams(text: string): string[] {
    const chars = Array.from(text);
    if (chars.length <= 2) return [text];
    const out: string[] = [];
    for (let index = 0; index < chars.length - 1; index += 1) out.push(chars[index] + chars[index + 1]);
    return out;
}

/**
 * 资产名相似度（0~1）：完全相同 1、双向包含 0.9、其余取「二元组 Dice」与「字符集合 Jaccard」的较大值。
 *
 * 为什么两个指标都要：`奶茶店门外人行道` vs `奶茶店门口` 靠 Dice 命中（0.55），
 * `苏晚` vs `苏小晚` 靠 Jaccard 命中（0.67）—— 单用任何一个都会漏一类「明显是同一个资产」的名字。
 */
export function storyScriptAssetNameSimilarity(left: string, right: string): number {
    const a = normalizeScriptAssetMatchText(left);
    const b = normalizeScriptAssetMatchText(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.9;
    const leftBigrams = scriptAssetBigrams(a);
    const rightBigrams = scriptAssetBigrams(b);
    const rightCount = new Map<string, number>();
    for (const item of rightBigrams) rightCount.set(item, (rightCount.get(item) || 0) + 1);
    let overlap = 0;
    for (const item of leftBigrams) {
        const count = rightCount.get(item) || 0;
        if (count > 0) {
            overlap += 1;
            rightCount.set(item, count - 1);
        }
    }
    const dice = (2 * overlap) / (leftBigrams.length + rightBigrams.length);
    const leftSet = new Set(Array.from(a));
    const rightSet = new Set(Array.from(b));
    let shared = 0;
    for (const char of leftSet) if (rightSet.has(char)) shared += 1;
    const jaccard = shared / (leftSet.size + rightSet.size - shared);
    return Math.max(dice, jaccard);
}

/** 判定「算同一个资产」的相似度门槛。0.5 = 一半字符二元组重合，够宽松又不会把苏晚对上苏晴。 */
export const STORY_SCRIPT_ASSET_MATCH_THRESHOLD = 0.5;

/**
 * 一行分镜该连哪些上游素材图。
 * - 预设没有 `assetKeys`（如 storyboard）→ 不区分角色，全部素材图都连；
 * - 有 `assetKeys` → 用这些列的值与素材标题做**相近匹配**（编号 / 括号注释 / 标点先归一，
 *   再按 `storyScriptAssetNameSimilarity` 算相似度，≥ 0.5 就算同一个资产）；
 * - 这一镜的资产列全是「无」→ 不连（纯环境镜头不该被塞进角色图）；
 * - 有名字但一个都没对上（模型可能改写了角色名）→ 退回全部连，宁可多连也不要漏角色。
 */
export function matchStoryScriptRowAssets(
    preset: StoryScriptPresetId | string | null | undefined,
    row: StoryScriptRow,
    assets: StoryScriptAssetRef[],
): StoryScriptAssetRef[] {
    if (!assets.length) return [];
    const keys = getStoryScriptPreset(preset).assetKeys;
    if (!keys?.length) return assets;
    const names = keys.map((key) => storyScriptCellText(row[key])).filter(Boolean);
    if (!names.length) return [];
    const matched = assets.filter((asset) => {
        const title = normalizeScriptAssetMatchText(asset.title);
        if (!title) return false;
        return names.some((name) => storyScriptAssetNameSimilarity(name, asset.title) >= STORY_SCRIPT_ASSET_MATCH_THRESHOLD);
    });
    return matched.length ? matched : assets;
}

/**
 * **逐镜图片**：镜号 → 画布上图片节点 id 的列表。存在脚本节点的 `metadata.scriptRowAssets`。
 *
 * 与 `metadata.scriptAssetRoles`（脚本节点级：这张素材属于哪一类，供铺链路时按类分派）刻意分开：
 *  - 「资产」是**整表共享**的参考图（角色卡 / 场景 / 道具 / 站位图），铺链路时对每一镜都成立；
 *  - 「镜头图」是**按镜指定**的成片关键帧 —— 用户在分镜表某一行的「镜头图」列里直接导入 / 链接 /
 *    生成，铺链路时只连到**这一镜**的图片节点（并随该分组合并进视频节点）。
 *
 * 用镜号（而不是数组下标）做键：镜号是表里对用户可见、且能跨会话稳定复现的标识。删行会让镜号
 * 整体前移，所以另配 `shiftStoryScriptRowAssetsAfterDelete` 在删行时把键一起挪。
 */
export type StoryScriptRowAssetMap = Record<string, string[]>;

/** 镜号归一化成 map 的键；非法值返回空串（调用方按「没有关联」处理）。 */
function rowAssetMapKey(shotNo: unknown): string {
    const no = Number(shotNo);
    return Number.isFinite(no) && no > 0 ? String(Math.round(no)) : "";
}

/** 读某一镜关联的图片节点 id（容错：值不是数组、或夹了非字符串项，都就地过滤掉）。 */
export function scriptRowAssetIds(map: unknown, shotNo: unknown): string[] {
    const key = rowAssetMapKey(shotNo);
    if (!key) return [];
    const value = map && typeof map === "object" ? (map as Record<string, unknown>)[key] : undefined;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

/**
 * 写某一镜关联的图片节点 id，返回**新的 map**（纯函数，便于探针直接校验）。
 * 传空数组等价于删掉这一镜的键 —— 免得 metadata 里堆一堆空数组，也便于「全部取消关联」后归一化。
 */
export function setStoryScriptRowAssetIds(map: unknown, shotNo: unknown, ids: readonly unknown[]): StoryScriptRowAssetMap {
    const next: StoryScriptRowAssetMap = { ...(map && typeof map === "object" ? (map as StoryScriptRowAssetMap) : {}) };
    const key = rowAssetMapKey(shotNo);
    if (!key) return next;
    const cleaned = Array.from(new Set(ids.filter((item): item is string => typeof item === "string" && Boolean(item))));
    if (cleaned.length) next[key] = cleaned;
    else delete next[key];
    return next;
}

/** 统一把 map 收成「键是正整数字符串、值是去重后的非空 id 数组」，顺带丢掉空条目与非法键。 */
export function normalizeStoryScriptRowAssetMap(map: unknown): StoryScriptRowAssetMap {
    const source = map && typeof map === "object" ? (map as Record<string, unknown>) : {};
    const next: StoryScriptRowAssetMap = {};
    for (const [key, value] of Object.entries(source)) {
        if (!rowAssetMapKey(key) || !Array.isArray(value)) continue;
        const cleaned = Array.from(new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item))));
        if (cleaned.length) next[String(Math.round(Number(key)))] = cleaned;
    }
    return next;
}

/**
 * 删掉第 `deletedShotNo` 镜（表里会被重排镜号）之后，把关联整体前移一位，
 * 否则「第 5 镜」的图会留在键 5 上、而键 5 现在已经变成了原来的第 6 镜。
 */
export function shiftStoryScriptRowAssetsAfterDelete(map: unknown, deletedShotNo: unknown): StoryScriptRowAssetMap {
    const normalized = normalizeStoryScriptRowAssetMap(map);
    const deleted = Number(deletedShotNo);
    if (!Number.isFinite(deleted) || deleted <= 0) return normalized;
    const next: StoryScriptRowAssetMap = {};
    for (const [key, ids] of Object.entries(normalized)) {
        const no = Number(key);
        if (no === deleted) continue;
        next[String(no > deleted ? no - 1 : no)] = ids;
    }
    return next;
}

/**
 * **逐镜声音**：镜号 → 画布上音频节点 id 的列表。存在脚本节点的 `metadata.scriptRowAudios`。
 *
 * 与「整表音频资产」(`scriptAssetRoles` 里分类为 `audio` 的那些) 互补：
 *  - 整表音频：每段视频都连同一条音轨（BGM / 全局旁白）；
 *  - 逐镜声音：只连**这一镜**所在的视频节点（这一镜的台词配音 / 音效），分段合并时同段各镜的声音都会连上。
 *
 * 结构与 `StoryScriptRowAssetMap` 完全一致（键 = 镜号、值 = 有序去重的节点 id），所以直接复用它的
 * 归一化 / 删行位移 / 调序 remap 实现；下面四个薄封装只是给「声音」一个说得出意图的入口名。
 */
export type StoryScriptRowAudioMap = StoryScriptRowAssetMap;

/** 读某一镜关联的音频节点 id（与 `scriptRowAssetIds` 同口径，容错过滤非法项）。 */
export function scriptRowAudioIds(map: unknown, shotNo: unknown): string[] {
    return scriptRowAssetIds(map, shotNo);
}

/** 写某一镜关联的音频节点 id（纯函数；传空数组 = 删掉这一镜的键）。 */
export function setStoryScriptRowAudioIds(map: unknown, shotNo: unknown, ids: readonly unknown[]): StoryScriptRowAudioMap {
    return setStoryScriptRowAssetIds(map, shotNo, ids);
}

/** 删掉第 N 镜后把声音关联整体前移一位（否则「第 5 镜的配音」会留在旧的第 5 镜上）。 */
export function shiftStoryScriptRowAudiosAfterDelete(map: unknown, deletedShotNo: unknown): StoryScriptRowAudioMap {
    return shiftStoryScriptRowAssetsAfterDelete(map, deletedShotNo);
}

/** 调序后按旧镜号 → 新镜号的映射重排声音关联。 */
export function remapStoryScriptRowAudios(map: unknown, mapping: Map<number, number>): StoryScriptRowAudioMap {
    return remapStoryScriptRowAssets(map, mapping);
}

/**
 * **按镜按资产挂图**：`"镜号:资产列key"`（如 `"3:scene"`）→ 画布上图片节点 id 的列表。
 * 存在脚本节点的 `metadata.scriptCellAssets`。
 *
 * 与另外两张表的分工（三者互不覆盖，各管一段）：
 *  - `metadata.scriptAssetRoles`：**整表共享**的素材（角色卡 / 场景 / 道具 / 站位图 / 音频），铺链路时按分类逐镜分派；
 *  - `metadata.scriptRowAssets`：**这一镜**的成片关键帧（「镜头图」列），不区分资产；
 *  - `metadata.scriptCellAssets`：**这一镜 + 这一个资产列**的图 —— 用户在「第 3 镜的场景格」里加的图，
 *    就只连到第 3 镜的图片 / 视频节点，并且**顶掉**资产条对「第 3 镜的场景」的分派（精准优先）。
 *
 * 键里带列名（而不是只带镜号），所以「同一镜的角色图和场景图」能各归各位；镜号同理用可见、可复现的数字。
 * 删行会把镜号整体前移，配 `shiftStoryScriptCellAssetsAfterDelete` 把键一起挪。
 */
export type StoryScriptCellAssetMap = Record<string, string[]>;

/**
 * `"镜号:列key"` 解回两部分；键非法（镜号不合法 / 列不是资产列）返回 `null`。
 *
 * ⚠️ `extras` **必须由调用方一路传下来**：自建资产列（`extra_1`…）只有在「这张表确实声明了这一列」
 * 时才算合法列。少传一处，这一列的图位就会被当成野键丢掉 —— 表现为「格子里的图看着在、铺链路却拿不到」。
 */
export function parseScriptCellAssetKey(
    key: unknown,
    extras?: readonly StoryScriptExtraColumn[] | null,
): { shotNo: number; columnKey: string } | null {
    if (typeof key !== "string") return null;
    const index = key.indexOf(":");
    if (index <= 0) return null;
    const no = Number(key.slice(0, index));
    const columnKey = key.slice(index + 1);
    if (!Number.isFinite(no) || no <= 0 || !isScriptAssetColumn(columnKey, extras)) return null;
    return { shotNo: Math.round(no), columnKey };
}

/** 归一化成 map 的键；非法值返回空串（调用方按「没有关联」处理）。 */
function cellAssetMapKey(shotNo: unknown, columnKey: unknown, extras?: readonly StoryScriptExtraColumn[] | null): string {
    const no = Number(shotNo);
    if (!Number.isFinite(no) || no <= 0) return "";
    if (!isScriptAssetColumn(columnKey, extras)) return "";
    return `${Math.round(no)}:${String(columnKey)}`;
}

/** 读某镜某资产列绑定的图片节点 id（容错：值不是数组、或夹了非字符串项，都就地过滤掉）。 */
export function scriptCellAssetIds(
    map: unknown,
    shotNo: unknown,
    columnKey: unknown,
    extras?: readonly StoryScriptExtraColumn[] | null,
): string[] {
    const key = cellAssetMapKey(shotNo, columnKey, extras);
    if (!key) return [];
    const value = map && typeof map === "object" ? (map as Record<string, unknown>)[key] : undefined;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

/**
 * 写某镜某资产列绑定的图片节点 id，返回**新的 map**（纯函数，便于探针直接校验）。
 * 传空数组等价于删掉这个键——免得 metadata 里堆一堆空数组。
 */
export function setStoryScriptCellAssetIds(
    map: unknown,
    shotNo: unknown,
    columnKey: unknown,
    ids: readonly unknown[],
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptCellAssetMap {
    const next: StoryScriptCellAssetMap = { ...(map && typeof map === "object" ? (map as StoryScriptCellAssetMap) : {}) };
    const key = cellAssetMapKey(shotNo, columnKey, extras);
    if (!key) return next;
    const cleaned = Array.from(new Set(ids.filter((item): item is string => typeof item === "string" && Boolean(item))));
    if (cleaned.length) next[key] = cleaned;
    else delete next[key];
    return next;
}

/** 统一把 map 收成「键是 `镜号:资产列`、值是去重后的非空 id 数组」，顺带丢掉空条目与非法键。 */
export function normalizeStoryScriptCellAssetMap(
    map: unknown,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptCellAssetMap {
    const source = map && typeof map === "object" ? (map as Record<string, unknown>) : {};
    const next: StoryScriptCellAssetMap = {};
    for (const [key, value] of Object.entries(source)) {
        const parsed = parseScriptCellAssetKey(key, extras);
        if (!parsed || !Array.isArray(value)) continue;
        const cleaned = Array.from(new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item))));
        if (cleaned.length) next[`${parsed.shotNo}:${parsed.columnKey}`] = cleaned;
    }
    return next;
}

/** 删掉第 `deletedShotNo` 镜之后把键里的镜号整体前移一位（理由同 `shiftStoryScriptRowAssetsAfterDelete`）。 */
export function shiftStoryScriptCellAssetsAfterDelete(
    map: unknown,
    deletedShotNo: unknown,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptCellAssetMap {
    const normalized = normalizeStoryScriptCellAssetMap(map, extras);
    const deleted = Number(deletedShotNo);
    if (!Number.isFinite(deleted) || deleted <= 0) return normalized;
    const next: StoryScriptCellAssetMap = {};
    for (const [key, ids] of Object.entries(normalized)) {
        const parsed = parseScriptCellAssetKey(key, extras);
        if (!parsed || parsed.shotNo === deleted) continue;
        next[`${parsed.shotNo > deleted ? parsed.shotNo - 1 : parsed.shotNo}:${parsed.columnKey}`] = ids;
    }
    return next;
}

/**
 * 删掉某一列之后：把图位表里 `镜号:该列` 的条目全部丢弃（**自建资产列被移除时用**）。
 * 不清理的话，这一列的图位会以野键形式永久留在 metadata 里，以后新建同号列还会「继承」旧图。
 */
export function dropStoryScriptCellAssetColumn(
    map: unknown,
    columnKey: unknown,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptCellAssetMap {
    const normalized = normalizeStoryScriptCellAssetMap(map, extras);
    const key = typeof columnKey === "string" ? columnKey : "";
    if (!key) return normalized;
    const next: StoryScriptCellAssetMap = {};
    for (const [entryKey, ids] of Object.entries(normalized)) {
        const parsed = parseScriptCellAssetKey(entryKey, extras);
        if (!parsed || parsed.columnKey === key) continue;
        next[entryKey] = ids;
    }
    return next;
}

/** 删掉某一列之后：把每一行里这一列的文本一并清掉（与 `dropStoryScriptCellAssetColumn` 配套）。 */
export function dropStoryScriptRowColumn(rows: readonly StoryScriptRow[] | null | undefined, columnKey: unknown): StoryScriptRow[] {
    const key = typeof columnKey === "string" ? columnKey : "";
    if (!key) return [...(rows || [])];
    return (rows || []).map((row) => {
        if (!(key in row)) return row;
        const next: StoryScriptRow = { ...row };
        delete next[key];
        return next;
    });
}

/**
 * 某一镜在哪些资产列上挂了图（按预设列序，只返回非空项）。
 *
 * 铺链路用它做两件事：① 把这些图直连到该镜的图片 / 视频节点；② 收集 `role` 作为
 * 「这一镜已经精准指定过的分类」，让资产条不再对同类素材重复分派（精准优先、资产条兜底）。
 *
 * `preset` 传了才校验「这一列在当前预设里存在」；不传则只校验它是不是资产列。
 */
export function scriptShotCellAssetSlots(
    map: unknown,
    shotNo: unknown,
    preset?: StoryScriptPresetId | string | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
): Array<{ columnKey: string; role: ScriptAssetRole; ids: string[] }> {
    const ordered = preset
        ? getStoryScriptAssetColumns(preset, extras).map((column) => column.key)
        : [...Object.keys(SCRIPT_ASSET_COLUMN_SPECS), ...(extras || []).map((item) => item.key)];
    const allowed = new Set(ordered);
    const target = Math.round(Number(shotNo));
    const out: Array<{ columnKey: string; role: ScriptAssetRole; ids: string[] }> = [];
    // 按列序输出（而不是 map 的插入序），这样铺链路连线的先后与表格里从左到右一致。
    for (const columnKey of ordered) {
        if (!allowed.has(columnKey)) continue;
        const ids = scriptCellAssetIds(map, target, columnKey, extras);
        if (!ids.length) continue;
        out.push({ columnKey, role: scriptAssetColumnRole(columnKey, extras) || "character", ids });
    }
    return out;
}

/**
 * 把某一镜「已用单元格图位精准指定过」的资产列的**名字值清空**，返回一行副本。
 *
 * 铺链路时拿它去喂 `matchStoryScriptRowAssets`：例如第 3 镜的「场景」格已经挂了图，
 * 这一镜就只剩「还没指定的角色列」参与资产条匹配，资产条里的场景素材不会再糊到这一镜上。
 */
export function blankFilledAssetColumns(
    map: unknown,
    shotNo: unknown,
    row: StoryScriptRow,
    preset?: StoryScriptPresetId | string | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptRow {
    const slots = scriptShotCellAssetSlots(map, shotNo, preset, extras);
    if (!slots.length) return row;
    const next: StoryScriptRow = { ...row };
    for (const slot of slots) {
        // 角色卡的名字列就是它自己；场景 / 道具同理。站位（blocking）本身既当名字又当描述，一并清掉。
        if (!(slot.columnKey in next)) continue;
        next[slot.columnKey] = "";
    }
    return next;
}

/**
 * **资产锁定**：资产名 → 画布图片节点 id 列表。存在脚本节点的 `metadata.scriptNameLocks`。
 *
 * 为什么要有它：`metadata.scriptCellAssets`（按镜按资产挂图）是「**第 3 镜**的场景用这张图」，
 * 只对那一镜成立；可分镜表里同一个资产名（「张三」「客厅」）会在很多镜里反复出现。
 * 用户手动把图片挂进某一格之后，这个「名字 ↔ 图片」的对应关系应该被**锁定**下来：
 *   - 表里凡是出现「张三」的地方，铺链路时都连同一张 @图片1；
 *   - 出现「客厅」的地方都连 @图片2。
 *
 * 锁按**资产名**索引（不按镜号、也不按分类），所以换一镜、换一列、换一个同名的角色格都照样命中。
 * 归一化后的空串 / 「无」/「-」这类占位不算资产名，不会建锁。
 */
export type StoryScriptNameLockMap = Record<string, string[]>;

/** 资产名归一化：去首尾空白 + 折叠内部空白 + 去全角空格；空 / 占位符 / 非字符串 → 空串（不建锁）。 */
export function scriptNameLockName(value: unknown): string {
    // 只认字符串：数字（镜号 1/2/3、时长 3）和 null / undefined 都算不上资产名，别让它们建出 `{ "3": [...] }` 这种脏锁。
    if (typeof value !== "string") return "";
    const text = storyScriptCellText(value).replace(/[\s\u3000]+/g, " ").trim();
    if (!text) return "";
    const lower = text.toLowerCase();
    if (["无", "-", "—", "/", "\\", "n/a", "na", "none", "null", "空"].includes(lower)) return "";
    return text;
}

/** 读某个资产名锁定的图片 id（没有 / 非法 → 空数组）。名字大小写不敏感（兼容手写数据）。 */
export function scriptNameLockIds(map: unknown, name: unknown): string[] {
    const label = scriptNameLockName(name);
    if (!label || !map || typeof map !== "object" || Array.isArray(map)) return [];
    const record = map as Record<string, unknown>;
    const lower = label.toLowerCase();
    for (const [rawKey, value] of Object.entries(record)) {
        const key = scriptNameLockName(rawKey);
        if (key !== label && key.toLowerCase() !== lower) continue;
        if (!Array.isArray(value)) return [];
        return Array.from(new Set(value.filter((id): id is string => typeof id === "string" && Boolean(id))));
    }
    return [];
}

/** 归一化整张锁表：丢非法键 / 非数组值并去重；同名（归一化后一致）的键合并。 */
export function normalizeStoryScriptNameLockMap(map: unknown): StoryScriptNameLockMap {
    if (!map || typeof map !== "object" || Array.isArray(map)) return {};
    const out: StoryScriptNameLockMap = {};
    for (const [rawKey, value] of Object.entries(map as Record<string, unknown>)) {
        const name = scriptNameLockName(rawKey);
        if (!name || !Array.isArray(value)) continue;
        const ids = value.filter((id): id is string => typeof id === "string" && Boolean(id));
        if (!ids.length) continue;
        const merged = [...(out[name] || []), ...ids];
        out[name] = Array.from(new Set(merged));
    }
    return out;
}

/** 写锁：`ids` 为空 = 解锁（删键）；纯函数。同名（忽略大小写）的旧键会先被清掉，不会留下隐形锁。 */
export function setStoryScriptNameLock(map: unknown, name: unknown, ids: readonly unknown[]): StoryScriptNameLockMap {
    const label = scriptNameLockName(name);
    const normalized = normalizeStoryScriptNameLockMap(map);
    if (!label) return normalized;
    const lower = label.toLowerCase();
    const next: StoryScriptNameLockMap = {};
    for (const [key, value] of Object.entries(normalized)) {
        if (key === label || key.toLowerCase() === lower) continue;
        next[key] = value;
    }
    const clean = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && Boolean(id))));
    if (clean.length) next[label] = clean;
    return next;
}

/**
 * 把某一格（这一镜这一资产列）刚链接好的图**并进**它的资产名锁里。
 * 同名多镜取并集（不丢图）；这一列的名字是空 / 「无」→ 原样返回（没有可锁的名字）。
 */
export function addScriptNameLockForCell(
    map: unknown,
    row: StoryScriptRow | undefined | null,
    columnKey: unknown,
    ids: readonly unknown[],
): StoryScriptNameLockMap {
    const normalized = normalizeStoryScriptNameLockMap(map);
    // 只有资产列才配锁（镜号 / 时长这类列的值不是资产名）。口径与 `parseScriptCellAssetKey` / `cellAssetMapKey` 一致。
    if (typeof columnKey !== "string" || !isScriptAssetColumn(columnKey)) return normalized;
    const label = scriptNameLockName(row ? row[columnKey] : "");
    if (!label || !ids.length) return normalized;
    return setStoryScriptNameLock(normalized, label, [...scriptNameLockIds(normalized, label), ...ids]);
}

/**
 * **一键铺链入口**：拿整张表**当前所有格子链接**重建锁表 ——
 * 「将分镜表已经链接好的图片锁成：资产名 → 图片」。已有锁保留（并集），不会因为没有格子链接而被抹掉。
 */
export function syncStoryScriptNameLocks(
    map: unknown,
    cells: unknown,
    rows?: readonly StoryScriptRow[] | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptNameLockMap {
    let next = normalizeStoryScriptNameLockMap(map);
    if (!rows?.length || !cells || typeof cells !== "object" || Array.isArray(cells)) return next;
    const byShot = new Map<number, StoryScriptRow>();
    rows.forEach((row, index) => {
        const shotNo = Math.round(Number(row.shot_no)) || index + 1;
        if (!byShot.has(shotNo)) byShot.set(shotNo, row);
    });
    for (const [key, value] of Object.entries(cells as Record<string, unknown>)) {
        const parsed = parseScriptCellAssetKey(key, extras);
        if (!parsed || !Array.isArray(value)) continue;
        const row = byShot.get(parsed.shotNo);
        if (!row) continue;
        next = addScriptNameLockForCell(next, row, parsed.columnKey, value);
    }
    return next;
}

/**
 * 一条「这张参考图 = 什么资产」的绑定：一键铺链时写进**图片 / 视频节点提示词**（用户要求「链接的图片
 * 资产要在图片和视频的文本输入框里锁定，即张三锁定@图片1」）。
 *
 * 只负责「这一镜的参考图各自是什么资产」这件事本身（去重 + 名字回落），文案与编号留给调用方 ——
 * 编号必须由 `lib/canvas/canvas-resource-references.ts` 的 `labelResourceNodeIds` 按连线顺序算，
 * 才能和提示词输入框里渲染出的 chip 标签逐字对上。
 */
export type ScriptAssetBindingEntry = {
    /** 画布图片节点 id。 */
    nodeId: string;
    /** 表里的资产名（「张三」「客厅」）；拿不到时回落 `title`。 */
    name?: unknown;
    /** 图片节点的标题（用户建资产时填的，通常就是资产名）。 */
    title?: unknown;
    /** 资产分类（`scriptAssetRoles` / 资产列）；镜头图没有分类 → 传 undefined。 */
    role?: unknown;
};

export type ScriptAssetBinding = {
    nodeId: string;
    name: string;
    role: ScriptAssetRole | null;
};

/**
 * 把「这一镜用到的参考图」收成一份**去重 + 有名字**的绑定清单。
 *
 * - **去重保先**：同一张图可能既是「格子图 / 名字锁的图」、又是「资产条按名匹配」、还是「镜头图」，
 *   先出现的（更具体的来源）赢；调用方按「精准 → 资产条 → 镜头图」的顺序喂进来即可。
 * - **名字回落**：表里的资产名优先（「张三」），否则用图片节点标题；**两者都为空就整条丢掉** ——
 *   写「图片1=」这种空绑定只会污染提示词。
 * - `role` 只认合法分类值，其它（含 undefined）→ `null`（例如镜头图）。
 */
export function collectScriptAssetBindings(entries: ReadonlyArray<ScriptAssetBindingEntry>): ScriptAssetBinding[] {
    const out: ScriptAssetBinding[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const nodeId = typeof entry.nodeId === "string" ? entry.nodeId.trim() : "";
        if (!nodeId || seen.has(nodeId)) continue;
        const name = scriptNameLockName(entry.name) || scriptNameLockName(entry.title);
        if (!name) continue;
        seen.add(nodeId);
        const role = typeof entry.role === "string" && (SCRIPT_ASSET_ROLE_IDS as readonly string[]).includes(entry.role) ? (entry.role as ScriptAssetRole) : null;
        out.push({ nodeId, name, role });
    }
    return out;
}

/**
 * 从分镜表的三张「键 → 图片节点 id[]」表里**摘掉**某一个画布素材 —— 资产池缩略图上的「解除链接」用。
 *
 * `scriptCellAssets` / `scriptRowAssets` / `scriptNameLocks` 结构完全一致（键 → id 数组），所以一个
 * 函数通吃：值数组里删掉这个 id，删空的键连键一起丢掉。**没有任何改动时原样返回入参**（含
 * `undefined` / `null`），上层据此判断 no-op，也不会因为无意义的 metadata 变更把整张画布重渲。
 */
export function stripStoryScriptAssetId<T extends Record<string, string[]>>(map: T | undefined | null, assetNodeId: unknown): T | undefined {
    const id = typeof assetNodeId === "string" ? assetNodeId.trim() : "";
    if (!id) return map ?? undefined;
    const source = (map && typeof map === "object" && !Array.isArray(map) ? map : {}) as Record<string, unknown>;
    let changed = false;
    const next: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(source)) {
        if (!Array.isArray(value)) continue;
        const ids = value.filter((item): item is string => typeof item === "string" && item !== id);
        if (ids.length !== value.length) changed = true;
        if (ids.length) next[key] = ids;
    }
    return (changed ? next : map) as T | undefined;
}

/**
 * 这一镜「已经被精准指定过」的资产格 —— **格子图优先、资产锁兜底**。铺链路的「精准优先、资产条兜底」
 * 就建立在这上面：
 *  1. 这一镜这一格自己挂了图（`scriptCellAssets`）→ 用这一格的图（`source: "cell"`）；
 *  2. 没挂，但这一格的名字在资产锁里（「张三」锁了 @图片1）→ 用锁定的图，**跨镜生效**（`source: "lock"`）；
 *  3. 都没有 → 这一格不参与，交给资产条按分类兜底（`coveredRoles` 里不会有它的分类）。
 *
 * 输出顺序 = 预设列序（连线先后与表格从左到右一致）。
 */
export function scriptShotPreciseAssetRefs(
    cells: unknown,
    locks: unknown,
    shotNo: unknown,
    row: StoryScriptRow | undefined | null,
    preset?: StoryScriptPresetId | string | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
): Array<{ columnKey: string; role: ScriptAssetRole; name: string; ids: string[]; source: "cell" | "lock" }> {
    if (!row) return [];
    const out: Array<{ columnKey: string; role: ScriptAssetRole; name: string; ids: string[]; source: "cell" | "lock" }> = [];
    for (const column of getStoryScriptAssetColumns(preset, extras)) {
        const role = scriptAssetColumnRole(column.key, extras) || "character";
        const name = scriptNameLockName(row[column.key]);
        const cellIds = scriptCellAssetIds(cells, shotNo, column.key, extras);
        if (cellIds.length) {
            out.push({ columnKey: column.key, role, name, ids: cellIds, source: "cell" });
            continue;
        }
        const lockedIds = name ? scriptNameLockIds(locks, name) : [];
        if (lockedIds.length) out.push({ columnKey: column.key, role, name, ids: lockedIds, source: "lock" });
    }
    return out;
}

/** 把「已被精准指定过」的资产列名清空，喂给 `matchStoryScriptRowAssets`（角色条不再对同类重复分派）。 */
export function blankPreciseAssetColumns(row: StoryScriptRow, refs: ReadonlyArray<{ columnKey: string }>): StoryScriptRow {
    if (!refs.length) return row;
    const next: StoryScriptRow = { ...row };
    for (const ref of refs) if (ref.columnKey in next) next[ref.columnKey] = "";
    return next;
}

/**
 * 资产对话框「按描述生图」的候选：`title` 同时作为建出来的图片节点标题
 * （铺链路时角色类素材靠标题做名字匹配，所以角色候选的 title 必须就是角色名），
 * `prompt` 是喂给生图的提示词。
 */
export type ScriptAssetPromptCandidate = {
    title: string;
    prompt: string;
};

/**
 * **资产列**：分镜表里哪几列是「资产槽位」，以及每一列对应哪一类资产。
 *
 * 这是「按镜按资产挂图」（`metadata.scriptCellAssets`）的唯一口径——表格里那一列的图位、「AI 生成」
 * 默认填的候选提示词、铺链路时这张图算哪一类，全部由它决定。
 *
 * - `character_1` / `character_2` → 角色卡（名字列 + 角色描述列）；
 * - `scene` → 场景（名字列 + 场景描述；老分镜表没有这两列时退回「场景标签 + 光影氛围」）；
 * - `prop` → 道具（名字列 + 道具描述）；
 * - `blocking` → 人物站位（只有描述，没有单独的名字列）；
 * - **音频没有对应的表列**（它不是一个字段），所以不在这张表里，也不会有图位。
 *
 * 预设没有的列自然不会出现图位：storyboard 没有角色列，就只有场景 / 道具 / 站位三个图位。
 */
const SCRIPT_ASSET_COLUMN_SPECS: Record<string, { role: ScriptAssetRole; nameKey?: string; textKeys: string[] }> = {
    character_1: { role: "character", nameKey: "character_1", textKeys: ["character_description_1"] },
    character_2: { role: "character", nameKey: "character_2", textKeys: ["character_description_2"] },
    scene: { role: "scene", nameKey: "scene", textKeys: ["scene_description", "scene_tags", "lighting_mood"] },
    prop: { role: "prop", nameKey: "prop", textKeys: ["prop_description"] },
    blocking: { role: "blocking", textKeys: ["blocking"] },
};

/**
 * **手动追加的资产列**（用户要求：「需要能够手动添加资产列，并连接进图片」）。
 *
 * 预设的列是固定的（角色1 / 角色2 / 场景 / 道具 / 人物站位），但一个片子可能还要「宠物」「车辆」
 * 「产品」这类资产。做法是让用户自建一列，**行为与内置资产列完全一致**：
 *   - 格子里能放文字（资产名 / 描述二合一）→ 能挂图位（导入 / 链接 / 生成 / 资产锁）；
 *   - 铺链路时按 `role` 分类把图连进该镜的图片节点（`scriptShotPreciseAssetRefs` 认它）。
 *
 * key 固定 `extra_<数字>`（不跟随列名，改列名不会丢图位）；真正的列名在 `label`。
 */
export type StoryScriptExtraColumn = {
    /** 列 key（`extra_1`…），与行数据 / 图位表（`shot:key`）同键，**一旦建好不再变**。 */
    key: string;
    /** 列名（用户填的，例：「宠物」）。 */
    label: string;
    /** 铺链路时按哪个分类连图（角色会被名字匹配，其余对每一镜都成立）。 */
    role: ScriptAssetRole;
};

/** 自建资产列 key 前缀（`isScriptAssetColumn` 靠它 + extras 双重确认，避免野键被当成资产列）。 */
const EXTRA_COLUMN_KEY_PATTERN = /^extra_[a-z0-9_]{1,24}$/;
/** 自建资产列允许的分类：音频没有表列（它不是字段），所以不给选。 */
export const SCRIPT_EXTRA_COLUMN_ROLE_IDS: ScriptAssetRole[] = ["character", "scene", "prop", "blocking"];
/** 一张表最多几列自建资产列（再多表就宽到没法看了）。 */
export const STORY_SCRIPT_MAX_EXTRA_COLUMNS = 8;
/** 自建资产列默认宽度：和内置资产列（140~150）齐平，够放 56px 缩略图 + 「+」。 */
const EXTRA_COLUMN_WIDTH = 150;

/** 归一化自建资产列：丢非法项、去重 key、分类收敛到允许集合，超过上限截断。 */
export function normalizeStoryScriptExtraColumns(value: unknown): StoryScriptExtraColumn[] {
    if (!Array.isArray(value)) return [];
    const out: StoryScriptExtraColumn[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const key = typeof record.key === "string" ? record.key.trim() : "";
        if (!EXTRA_COLUMN_KEY_PATTERN.test(key) || seen.has(key)) continue;
        const label = typeof record.label === "string" ? record.label.trim() : "";
        if (!label) continue;
        const role = SCRIPT_EXTRA_COLUMN_ROLE_IDS.includes(record.role as ScriptAssetRole) ? (record.role as ScriptAssetRole) : "scene";
        seen.add(key);
        out.push({ key, label, role });
        if (out.length >= STORY_SCRIPT_MAX_EXTRA_COLUMNS) break;
    }
    return out;
}

/** 下一个可用的自建资产列 key（`extra_1`、`extra_2`…；删过列也不会复用旧号，避免图位串到新列）。 */
export function nextStoryScriptExtraColumnKey(extras: readonly StoryScriptExtraColumn[] | null | undefined): string {
    let max = 0;
    for (const item of extras || []) {
        const matched = /^extra_(\d+)$/.exec(item.key);
        if (matched) max = Math.max(max, Number(matched[1]));
    }
    return `extra_${max + 1}`;
}

/** 自建资产列 → 表格列定义（追加在预设列之后）。 */
export function storyScriptExtraColumnsToColumns(extras: readonly StoryScriptExtraColumn[] | null | undefined): StoryScriptColumn[] {
    return (extras || []).map((item) => ({ key: item.key, label: item.label, width: EXTRA_COLUMN_WIDTH }));
}

/** 预设列 + 自建资产列 = 表格实际渲染的列（导出 / 解析仍只按预设列走，自建列是用户手填的）。 */
export function getStoryScriptColumnsWithExtras(
    preset?: StoryScriptPresetId | string | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptColumn[] {
    const base = getStoryScriptColumns(preset);
    const extraColumns = storyScriptExtraColumnsToColumns(extras);
    return extraColumns.length ? [...base, ...extraColumns] : base;
}

/** 某一列是不是资产列（角色1 / 角色2 / 场景 / 道具 / 人物站位 + 用户自建列）。 */
export function isScriptAssetColumn(key: unknown, extras?: readonly StoryScriptExtraColumn[] | null): boolean {
    if (typeof key !== "string") return false;
    if (SCRIPT_ASSET_COLUMN_SPECS[key]) return true;
    return Boolean(extras?.some((item) => item.key === key));
}

/** 资产列对应的资产分类；不是资产列（或非字符串）返回 `null`。自建列读它自己的 `role`。 */
export function scriptAssetColumnRole(key: unknown, extras?: readonly StoryScriptExtraColumn[] | null): ScriptAssetRole | null {
    if (typeof key !== "string") return null;
    const spec = SCRIPT_ASSET_COLUMN_SPECS[key];
    if (spec) return spec.role;
    return extras?.find((item) => item.key === key)?.role ?? null;
}

/** 当前预设下真正存在的资产列（按预设列顺序 + 自建列），供表格渲染图位、铺链路按列序连线用。 */
export function getStoryScriptAssetColumns(
    preset?: StoryScriptPresetId | string | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptColumn[] {
    const presetColumns = getStoryScriptColumns(preset).filter((column) => isScriptAssetColumn(column.key));
    const extraColumns = storyScriptExtraColumnsToColumns(extras).filter((column) => isScriptAssetColumn(column.key, extras));
    return [...presetColumns, ...extraColumns];
}

/**
 * 每个分类能从分镜表里取到的「描述」列（由 `SCRIPT_ASSET_COLUMN_SPECS` 派生，改列只改上面一处）。
 * - `character`：两张角色卡（角色1/角色描述1、角色2/角色描述2）；
 * - `scene`：场景（名字，充当标题）+ 场景描述（提示词）；
 * - `prop`：道具（名字）+ 道具描述；
 * - `blocking`：人物站位（只有描述，没有单独的名字列）；
 * - `audio`：不参与「按描述生成」（生成 tab 走的是生图链路），故为空数组。
 *   （storyboard 预设没有角色列时，取值自然为空串，无需按预设分支。）
 */
const SCRIPT_ASSET_DESCRIPTION_COLUMNS: Record<ScriptAssetRole, Array<{ nameKey?: string; textKeys: string[] }>> = (() => {
    const out: Record<ScriptAssetRole, Array<{ nameKey?: string; textKeys: string[] }>> = { character: [], scene: [], prop: [], blocking: [], audio: [] };
    for (const spec of Object.values(SCRIPT_ASSET_COLUMN_SPECS)) out[spec.role].push({ nameKey: spec.nameKey, textKeys: spec.textKeys });
    return out;
})();

/**
 * 从分镜表里抽某一类资产的描述候选，供资产对话框一键填入生图提示词。
 * 按「标题」去重并保留首次出现顺序（同一角色在多镜里重复出现只留一条）。
 *
 * ⚠️ 资产描述「只在首现镜写全」之后，后面几镜这一格是空的 —— 这里**按名字去重而不是按
 * 「名字 + 描述」**，否则同一个角色会冒出「名字 / 完整描述」和「名字 / 只有名字」两条候选，
 * 而且顺序靠后的那条描述还是残缺的。万一先出现的是空描述（手改过的表），后来补上的描述会覆盖回去。
 */
export function collectScriptAssetPromptCandidates(role: unknown, rows?: readonly StoryScriptRow[] | null): ScriptAssetPromptCandidate[] {
    const specs = SCRIPT_ASSET_DESCRIPTION_COLUMNS[resolveScriptAssetRole(role)];
    if (!specs.length || !rows?.length) return [];
    const out: ScriptAssetPromptCandidate[] = [];
    const seen = new Map<string, number>();
    for (const row of rows) {
        for (const spec of specs) {
            const name = spec.nameKey ? storyScriptCellText(row[spec.nameKey]) : "";
            const text = joinStoryScriptPromptParts(spec.textKeys.map((key) => storyScriptCellText(row[key])));
            const title = name || text.slice(0, 24);
            const prompt = text || name;
            if (!title || !prompt) continue;
            const existing = seen.get(title);
            if (existing !== undefined) {
                // 已经有这一条了：只在「之前只剩名字、这次有真描述」时升级，别把完整描述换掉。
                if (out[existing].prompt === name && hasMeaningfulAssetDescription(text)) out[existing] = { title, prompt };
                continue;
            }
            seen.set(title, out.length);
            out.push({ title, prompt });
        }
    }
    return out;
}

/**
 * 某一镜某一资产列的生成候选：拿**这一行**的这一列（名字）+ 配对描述列当提示词。
 *
 * 与 `collectScriptAssetPromptCandidates`（按分类跨全表汇总、去重）的差别：这里只取一镜一列，
 * 所以「第 3 镜的场景」生成出来的提示词就是第 3 镜那一条，不会串到别的镜头去。
 * 该列在预设里不存在、或这一行这一列本来就是 `无` → 返回 `null`（调用方按「没有可填的候选」处理）。
 */
export function collectScriptCellPromptCandidate(
    columnKey: unknown,
    row?: StoryScriptRow | null,
    extras?: readonly StoryScriptExtraColumn[] | null,
    rows?: readonly StoryScriptRow[] | null,
): ScriptAssetPromptCandidate | null {
    if (typeof columnKey !== "string" || !row) return null;
    // 自建资产列：这一格本身就是「名字 + 描述」二合一，所以名字和提示词都取同一个格子的文字。
    const extra = extras?.find((item) => item.key === columnKey);
    const spec = extra ? { role: extra.role, nameKey: columnKey, textKeys: [columnKey] } : SCRIPT_ASSET_COLUMN_SPECS[columnKey];
    if (!spec) return null;
    const name = spec.nameKey ? storyScriptCellText(row[spec.nameKey]) : "";
    const text = joinStoryScriptPromptParts(spec.textKeys.map((key) => storyScriptCellText(row[key])));
    // 「资产描述只在首现镜写全」之后，后面几镜这一格是空的 —— 直接拿名字当提示词去生图，
    // 出来的角色会走样。这里回填**全表首现镜**的描述（见 `findStoryScriptAssetDescription`）。
    const inherited = !text && !extra && spec.nameKey ? findStoryScriptAssetDescription(rows, spec, name, row) : "";
    const title = name || text.slice(0, 24);
    const prompt = text || inherited || name;
    if (!title || !prompt) return null;
    return { title, prompt };
}

/**
 * 「同名资产的描述只在首现镜写全，后面几镜留空」—— 用户 2026-10-23 的提速诉求。
 *
 * 三处共用同一套口径，缺一处就会露馅：
 *  1. **提示词侧**：`STORY_SCRIPT_ASSET_DEDUPE_SYSTEM_OVERRIDE` 追加进 system，让模型别重复写
 *     （这才是真省时间的那一步：输出短了，生成就快）；
 *  2. **解析后归一化** `dedupeStoryScriptAssetDescriptions`：模型不听话时兜底，把重复描述清空
 *     （幂等，反复跑结果一样）；
 *  3. **显示占位** `buildStoryScriptAssetDescriptionHints` + **单格回填**
 *     `findStoryScriptAssetDescription`：表格看着不漏、逐格「AI 生成」还能拿到首现镜的描述。
 *
 * ⚠️ 只动**描述列**，名字列（角色1 / 角色2 / 场景 / 道具）永远每镜必填 ——
 * 图位、资产锁、铺链路全靠名字匹配（`matchStoryScriptRowAssets` / `scriptShotPreciseAssetRefs`）。
 */
function scriptAssetDescriptionSpecs(preset?: StoryScriptPresetId | string | null) {
    const columns = new Set(getStoryScriptPreset(preset).columns.map((column) => column.key));
    return Object.entries(SCRIPT_ASSET_COLUMN_SPECS)
        .filter(([, spec]) => Boolean(spec.nameKey) && columns.has(String(spec.nameKey)))
        .map(([columnKey, spec]) => ({ columnKey, nameKey: String(spec.nameKey), textKeys: spec.textKeys }));
}

/** 描述「写了东西」——空串与「无」都算没写（`无` 是「这一镜没有这个资产」，不该当首现镜的描述）。 */
function hasMeaningfulAssetDescription(value: string): boolean {
    const text = value.trim();
    return Boolean(text) && text !== "无";
}

function readStoryScriptAssetDescription(row: StoryScriptRow, textKeys: readonly string[]): string {
    return joinStoryScriptPromptParts(textKeys.map((key) => storyScriptCellText(row[key]))).trim();
}

/** 找同名的「首现描述」：优先这一镜之前（按镜号），没有再退到全表（顺序反了也能救回来）。 */
export function findStoryScriptAssetDescription(
    rows: readonly StoryScriptRow[] | null | undefined,
    spec: { nameKey?: string; textKeys: readonly string[] },
    name: string,
    current?: StoryScriptRow | null,
): string {
    const wanted = normalizeScriptAssetMatchText(name);
    const nameKey = spec.nameKey;
    if (!wanted || !nameKey) return "";
    const currentShot = Number(current?.shot_no) || 0;
    const matches = (rows || [])
        .filter((row) => row && normalizeScriptAssetMatchText(storyScriptCellText(row[nameKey])) === wanted)
        .sort((left, right) => (Number(left.shot_no) || 0) - (Number(right.shot_no) || 0));
    const earlier = currentShot ? matches.filter((row) => (Number(row.shot_no) || 0) < currentShot) : matches;
    for (const row of [...earlier, ...matches]) {
        const text = readStoryScriptAssetDescription(row, spec.textKeys);
        if (hasMeaningfulAssetDescription(text)) return text;
    }
    return "";
}

/**
 * 解析后归一化：同一个资产名在前面的镜头已经写过描述 → 这一镜的描述列清空。
 *
 * 幂等；只有真的改了才返回新数组（其余情况原样返回，避免无意义的重渲染 / 重存）。
 * 自建资产列不参与（它是「名字 + 描述」二合一，清空就丢了名字）。
 */
export function dedupeStoryScriptAssetDescriptions(
    rows: readonly StoryScriptRow[] | null | undefined,
    preset?: StoryScriptPresetId | string | null,
): StoryScriptRow[] {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length < 2) return list as StoryScriptRow[];
    const specs = scriptAssetDescriptionSpecs(preset);
    if (!specs.length) return list as StoryScriptRow[];
    /** `列key\u0000归一化名字` → 首现镜号 */
    const firstSeen = new Map<string, number>();
    let changed = false;
    const next = list.map((row, index) => {
        const shotNo = Number(row.shot_no) || index + 1;
        let copy: StoryScriptRow | null = null;
        for (const spec of specs) {
            const name = storyScriptCellText(row[spec.nameKey]);
            const normalized = normalizeScriptAssetMatchText(name);
            if (!normalized) continue;
            const key = `${spec.columnKey}\u0000${normalized}`;
            const text = readStoryScriptAssetDescription(row, spec.textKeys);
            const meaningful = hasMeaningfulAssetDescription(text);
            if (!firstSeen.has(key)) {
                if (meaningful) firstSeen.set(key, shotNo);
                continue;
            }
            if (!meaningful) continue;
            // 只复制一次：同一行可能有好几列都要清空（角色描述1 + 场景描述…）。
            const target: StoryScriptRow = copy ?? { ...row };
            for (const textKey of spec.textKeys) target[textKey] = "";
            copy = target;
            changed = true;
        }
        return copy || row;
    });
    return changed ? next : (list as StoryScriptRow[]);
}

/**
 * 表格占位用：`镜号:描述列key` → 首现镜号。只对**当前为空、且前面（或全表）已经有描述**的格子给提示。
 * 纯显示口径，不改数据；空描述本身仍然是空（导出 / 下游看到的是空，不是「（同第 3 镜）」）。
 *
 * ⚠️ key 用**描述列**（`character_description_1` / `scene_description`…）而不是资产名列 ——
 * 占位是画在空着的描述格里的，名字列每镜都有内容，永远用不上。
 */
export function buildStoryScriptAssetDescriptionHints(
    rows: readonly StoryScriptRow[] | null | undefined,
    preset?: StoryScriptPresetId | string | null,
): Record<string, number> {
    const list = Array.isArray(rows) ? rows : [];
    const out: Record<string, number> = {};
    if (list.length < 2) return out;
    const specs = scriptAssetDescriptionSpecs(preset);
    if (!specs.length) return out;
    const firstSeen = new Map<string, number>();
    list.forEach((row, index) => {
        const shotNo = Number(row.shot_no) || index + 1;
        for (const spec of specs) {
            const name = storyScriptCellText(row[spec.nameKey]);
            const normalized = normalizeScriptAssetMatchText(name);
            if (!normalized) continue;
            const key = `${spec.columnKey}\u0000${normalized}`;
            const meaningful = hasMeaningfulAssetDescription(readStoryScriptAssetDescription(row, spec.textKeys));
            const seen = firstSeen.get(key);
            if (!meaningful) {
                // 描述格空着、前面写过 → 每个描述列都给占位（场景有「场景描述 / 标签 / 光影」三条）。
                if (seen !== undefined) for (const textKey of spec.textKeys) out[`${shotNo}:${textKey}`] = seen;
                continue;
            }
            if (seen === undefined) firstSeen.set(key, shotNo);
        }
    });
    return out;
}

/** 提示词侧的 system 追加段 —— 三套方案通用（第二 / 第三套的 system 是用户的词库文本，只能这样追加）。 */
export const STORY_SCRIPT_ASSET_DEDUPE_SYSTEM_OVERRIDE = [
    "## 资产描述去重（最高优先级，压过上文所有相反说明）",
    "- 同一个角色 / 场景 / 道具在多镜里反复出现时，**资产描述只在它第一次出现的那一镜写全**；后面再出现它的镜头，描述列（角色描述1 / 角色描述2 / 场景描述 / 场景标签 / 光影氛围 / 道具描述）**一律留空**：不要重复写、不要缩写、不要写「同上 / 同第 N 镜 / 见前」之类占位文字。",
    "- 但**资产名字列每一镜都必须照常填写**（角色1 / 角色2 / 场景 / 道具），一个字都不许省略 —— 图位与铺链路靠名字逐镜匹配，名字空了这一镜的资产就丢了。",
    "- 这一镜确实没有某个资产时，仍按原规则把名字与描述都写「无」（「无」不算「已写过描述」）。",
    "- **分镜提示词 / 视频运动提示词不受本条限制**：这两列每一镜都要能独立当生图提示词看，角色外貌必须写全；这一镜的描述列为空时，就按该资产第一次出现时写的描述来写。",
].join("\n");

/** 构建分镜脚本生成任务；不传 preset 时保持旧行为（classic）。 */
export function buildStoryScriptTask({
    sourceText,
    prompt,
    characterRefs,
    preset,
    segmentSeconds,
    mergeMode,
    assetPrompt,
    shotPrompt,
    assetDedupe,
}: {
    sourceText: string;
    prompt?: string;
    characterRefs?: string;
    preset?: StoryScriptPresetId | string | null;
    segmentSeconds?: unknown;
    mergeMode?: StoryScriptMergeMode | string | null;
    /** 资产列的自定义要求（不传 = 只用预设说明，输出与改造前逐字一致） */
    assetPrompt?: unknown;
    /** 分镜提示词 / 视频运动提示词的自定义要求（同上） */
    shotPrompt?: unknown;
    /** 资产描述去重（同名资产只在首现镜写全）；不传 = 任务书与改造前逐字一致 */
    assetDedupe?: boolean;
}): string {
    return getStoryScriptPreset(preset).buildTask({ sourceText, prompt, characterRefs, segmentSeconds, mergeMode, assetPrompt, shotPrompt, assetDedupe });
}

/** 构建「只重写某一镜」的任务书；不传 preset 时保持 classic。 */
export function buildStoryScriptRowTask({ preset, ...input }: StoryScriptRowTaskInput & { preset?: StoryScriptPresetId | string | null }): string {
    return getStoryScriptPreset(preset).buildRowTask(input);
}

// ---------------------------------------------------------------------------
// 分镜表「改」相关的纯函数：调序、逐镜/批量重生成、二次识别补资产、逐镜备注
// ---------------------------------------------------------------------------

/**
 * 调序：把第 `fromIndex` 行挪到 `toIndex`，并把 `shot_no` 重排成 1..N（顺序变了镜号也得跟着变）。
 *
 * 返回 `mapping`（**旧镜号 → 新镜号**）：逐镜图（`scriptRowAssets`）、按镜按资产（`scriptCellAssets`）、
 * 逐镜备注（`scriptRowNotes`）都是按镜号存的，不跟着挪就会出现「第 3 镜的图挂到别人身上」。
 */
export function reorderStoryScriptRows(
    rows: readonly StoryScriptRow[],
    fromIndex: number,
    toIndex: number,
): { rows: StoryScriptRow[]; mapping: Map<number, number> } {
    const list = rows.map((row, index) => ({ row, shotNo: Number(row.shot_no) || index + 1 }));
    const mapping = new Map<number, number>();
    if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length || fromIndex === toIndex) {
        list.forEach((entry, index) => mapping.set(entry.shotNo, index + 1));
        return { rows: rows.map((row) => ({ ...row })), mapping };
    }
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    const next = list.map((entry, index) => {
        mapping.set(entry.shotNo, index + 1);
        return { ...entry.row, shot_no: index + 1 };
    });
    return { rows: next, mapping };
}

/** 把「镜号 → 数组」的键按 mapping 挪位置；没在 mapping 里的旧键原样保留（宁可留着也别丢数据）。 */
function remapShotNumberKeys<T>(map: unknown, mapping: Map<number, number>, parse: (key: string) => { shotNo: number; rest: string } | null, build: (shotNo: number, rest: string) => string): Record<string, T> {
    const out: Record<string, T> = {};
    if (!map || typeof map !== "object" || Array.isArray(map)) return out;
    for (const [key, value] of Object.entries(map as Record<string, T>)) {
        const parsed = parse(key);
        if (!parsed) continue;
        const nextShotNo = mapping.get(parsed.shotNo) ?? parsed.shotNo;
        out[build(nextShotNo, parsed.rest)] = value;
    }
    return out;
}

/** 逐镜图（`metadata.scriptRowAssets`）跟着镜号一起挪。 */
export function remapStoryScriptRowAssets(map: unknown, mapping: Map<number, number>): StoryScriptRowAssetMap {
    const normalized = normalizeStoryScriptRowAssetMap(map);
    return remapShotNumberKeys<StoryScriptRowAssetMap[string]>(
        normalized,
        mapping,
        (key) => {
            const shotNo = Number(key);
            return Number.isFinite(shotNo) && shotNo > 0 ? { shotNo, rest: "" } : null;
        },
        (shotNo) => String(shotNo),
    );
}

/** 按镜按资产（`metadata.scriptCellAssets`）跟着镜号一起挪，列 key 不动。 */
export function remapStoryScriptCellAssets(
    map: unknown,
    mapping: Map<number, number>,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptCellAssetMap {
    const normalized = normalizeStoryScriptCellAssetMap(map, extras);
    return remapShotNumberKeys<StoryScriptCellAssetMap[string]>(
        normalized,
        mapping,
        (key) => {
            const parsed = parseScriptCellAssetKey(key, extras);
            return parsed ? { shotNo: parsed.shotNo, rest: parsed.columnKey } : null;
        },
        (shotNo, rest) => `${shotNo}:${rest}`,
    );
}

/** 逐镜备注（`metadata.scriptRowNotes`）跟着镜号一起挪。 */
export function remapStoryScriptRowNotes(map: unknown, mapping: Map<number, number>): Record<string, string> {
    return remapShotNumberKeys<string>(
        normalizeStoryScriptRowNoteMap(map),
        mapping,
        (key) => {
            const shotNo = Number(key);
            return Number.isFinite(shotNo) && shotNo > 0 ? { shotNo, rest: "" } : null;
        },
        (shotNo) => String(shotNo),
    );
}

/** 统一收成「键是正整数字符串、值是非空字符串」，丢掉空备注。 */
export function normalizeStoryScriptRowNoteMap(map: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!map || typeof map !== "object" || Array.isArray(map)) return out;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
        const shotNo = Number(key);
        if (!Number.isFinite(shotNo) || shotNo <= 0) continue;
        if (typeof value !== "string") continue;
        const note = value.trim();
        if (!note) continue;
        out[String(shotNo)] = note;
    }
    return out;
}

/** 读某一镜的备注（没有 / 非法 → 空串）。 */
export function storyScriptRowNote(map: unknown, shotNo: unknown): string {
    const key = Number(shotNo);
    if (!Number.isFinite(key) || key <= 0) return "";
    const normalized = normalizeStoryScriptRowNoteMap(map);
    return normalized[String(key)] || "";
}

/** 写某一镜的备注，返回**新的 map**；传空 = 删掉这一镜的备注。 */
export function setStoryScriptRowNote(map: unknown, shotNo: unknown, note: string | null | undefined): Record<string, string> {
    const next = normalizeStoryScriptRowNoteMap(map);
    const key = Number(shotNo);
    if (!Number.isFinite(key) || key <= 0) return next;
    const text = typeof note === "string" ? note.trim() : "";
    if (text) next[String(key)] = text;
    else delete next[String(key)];
    return next;
}

/** 二次识别「补资产」的一个目标：资产列 + 它在当前预设下的描述列。 */
export type StoryScriptAssetFillTarget = {
    /** 资产列 key（`character_1` / `scene` / `prop` / `blocking`…） */
    key: string;
    /** 列名（角色1 / 场景…），写进任务书用 */
    label: string;
    role: ScriptAssetRole;
    /** 同组、且在当前预设里真实存在的描述列 key */
    textKeys: string[];
};

/**
 * 这一行**缺哪些资产**：以资产列为锚（角色1 / 角色2 / 场景 / 道具 / 人物站位），
 * 「整组都空」才算缺失 —— 名字列或任意一条描述列有内容，就认为这一组已经统计过了。
 *
 * 表里写成 `无` 的值按空处理（`storyScriptCellText` 口径），所以模型偷懒写「无」的格子也会被认成缺失。
 */
export function collectStoryScriptAssetFillTargets(
    preset: StoryScriptPresetId | string | null | undefined,
    row: StoryScriptRow | null | undefined,
    extras?: readonly StoryScriptExtraColumn[] | null,
): StoryScriptAssetFillTarget[] {
    if (!row) return [];
    const columns = getStoryScriptColumnsWithExtras(preset, extras);
    const byKey = new Map(columns.map((column) => [column.key, column]));
    const targets: StoryScriptAssetFillTarget[] = [];
    for (const [key, spec] of Object.entries(SCRIPT_ASSET_COLUMN_SPECS)) {
        if (!byKey.has(key)) continue;
        const textKeys = spec.textKeys.filter((textKey) => byKey.has(textKey));
        const groupKeys = [key, ...textKeys];
        if (groupKeys.some((groupKey) => storyScriptCellText(row[groupKey]))) continue;
        targets.push({ key, label: byKey.get(key)?.label || key, role: spec.role, textKeys });
    }
    // 自建资产列：只占一列（名字 + 描述二合一），空着就算缺失。
    for (const extra of extras || []) {
        if (!byKey.has(extra.key)) continue;
        if (storyScriptCellText(row[extra.key])) continue;
        targets.push({ key: extra.key, label: byKey.get(extra.key)?.label || extra.key, role: extra.role, textKeys: [] });
    }
    return targets;
}

/**
 * 「二次识别，只补缺失的资产」的任务书。
 *
 * 与整镜重生成（`buildRowTask`）的区别：**只允许补空**——已有内容的列一个字都不许动，
 * 输出也只要那几个缺失字段。这样用户已经满意的画面描述 / 提示词不会被模型顺手改掉。
 */
export function buildStoryScriptAssetFillTask({
    preset,
    sourceText,
    row,
    targets,
    extras,
    assetPrompt,
}: {
    preset?: StoryScriptPresetId | string | null;
    sourceText: string;
    row: StoryScriptRow;
    targets: StoryScriptAssetFillTarget[];
    extras?: readonly StoryScriptExtraColumn[] | null;
    /** 「资产提示词」：补资产也算资产生成，同样吃这套自定义要求（不传 = 老行为） */
    assetPrompt?: unknown;
}): string {
    const columns = getStoryScriptColumnsWithExtras(preset, extras);
    const keySet = new Set(columns.map((column) => column.key));
    const wanted = targets.flatMap((target) => [target.key, ...target.textKeys].filter((key) => keySet.has(key)));
    const wantedLabels = targets
        .map((target) => `${target.label}${target.textKeys.length ? `（${target.textKeys.map((textKey) => columns.find((column) => column.key === textKey)?.label || textKey).join(" / ")}）` : ""}`)
        .join("、");
    const parts = [
        `下面是一张分镜表的第 ${row.shot_no} 镜。这一镜的**部分资产还没有统计出来**，请只补齐这些资产：${wantedLabels}。`,
        "## 硬性要求\n1. 只输出下面列出的字段，其它字段一律不要输出；\n2. 这一镜已经写好的内容（画面 / 动作 / 提示词等）一个字都不要改，也不要重复输出；\n3. 确实没有的资产就写 `无`，不要编造无关内容；\n4. 资产名要与表里其它镜头已有的写法保持一致：同一个场景 / 道具用同一个名字，同一个角色用同一套名字；\n5. 输出单个 JSON 对象（不要 markdown 代码块、不要解释、不要前后缀）。",
        `输出字段（只允许这些键）：\n${wanted.map((key) => `- \`${key}\`（${columns.find((column) => column.key === key)?.label || key}）`).join("\n")}`,
        `JSON 形状示例：${JSON.stringify(Object.fromEntries(wanted.map((key) => [key, ""])))}`,
        buildScriptAssetPromptSection(assetPrompt),
        `这一镜当前的内容：\n${describeRowForContext(row, columns) || "（整行几乎都是空的）"}`,
    ].filter((part) => part.length > 0);
    // 上一镜只作为「名字 / 站位要能接上」的参考，不要求重写。
    if (sourceText.trim()) parts.push(`源剧本内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/**
 * 把「补资产」结果并回原行：**只写空列**。
 *
 * 用户原话：「当镜的已出的其他内容不进行修改，只追加缺失的资产」——所以这里对已有内容的列
 * 一律跳过（哪怕模型硬塞了新值），模型写 `无` 的也不落库（免得格子从空变成「无」看不出差别）。
 */
export function mergeStoryScriptAssetFill(
    row: StoryScriptRow,
    patch: unknown,
    columns: StoryScriptColumn[] = STORY_SCRIPT_CLASSIC_COLUMNS,
): StoryScriptRow {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return row;
    const byKey = new Map(columns.map((column) => [column.key, column]));
    const next: StoryScriptRow = { ...row };
    for (const [rawKey, rawValue] of Object.entries(patch as Record<string, unknown>)) {
        const column = byKey.get(rawKey);
        // 只认当前预设里存在、且不是数字列（镜号 / 时长不许被补资产改掉）。
        if (!column || column.numeric) continue;
        if (storyScriptCellText(next[rawKey])) continue;
        const value = toText(rawValue).trim();
        if (!storyScriptCellText(value)) continue;
        next[rawKey] = value;
    }
    return next;
}

function stripCodeFence(text: string): string {
    const trimmed = text.trim();
    const fence = trimmed.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
    return fence ? fence[1].trim() : trimmed;
}

/**
 * 读一个单元格当文本用：模型按约定把「没有内容」写成 `无`（以及 `无。` / `None` 之类变体），
 * 这些值对提示词没意义，统一折算成空串，交给调用方按「缺列」处理。
 */
export function storyScriptCellText(value: unknown): string {
    const text = toText(value);
    if (!text) return "";
    return /^(无|没有|none|null|n\/a)[。.！!]?$/i.test(text) ? "" : text;
}

/** 把若干段提示词拼起来：丢掉空段、去掉重复段，用换行连接。 */
export function joinStoryScriptPromptParts(parts: unknown[]): string {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const part of parts) {
        const text = storyScriptCellText(part);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        kept.push(text);
    }
    return kept.join("\n");
}

/**
 * 视频节点最终的提示词 = **视频段**（视频运动提示词 / 镜头运动），**不拼分镜提示词**。
 *
 * 2026-10-19 用户明确要求：「一键铺链路创建出的视频节点中不需要添加分镜表中的分镜提示词」。
 * 原因是口径本来就不该重复——分镜提示词是「这一镜长什么样」，已经写进本镜的文本节点、并拿来
 * 生成关键帧图片了；视频节点拿到的是这张关键帧（首帧），再灌一遍整段画面描述只会稀释运镜与
 * 动作指令（长提示词里模型最容易丢掉的就是「怎么动」）。
 *
 * 所以视频节点的提示词来源收敛成一处：`buildShotPrompts().videoPrompt`。
 * 预设自己的兜底仍然有效（经典预设缺 `video_motion_prompt` 时用 角色动作 + 画面描述 … 拼一段），
 * 那是「运镜列缺失时的兜底」，不是把分镜提示词整段搬过来。
 */
export function buildVideoNodePrompt(videoPrompt: unknown): string {
    return storyScriptCellText(videoPrompt);
}

function toText(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(toText).filter(Boolean).join("、");
    if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(toText).filter(Boolean).join("、");
    return "";
}

function toInt(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
    const match = String(value ?? "").match(/\d+(\.\d+)?/);
    if (!match) return fallback;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

/** 按列定义把模型返回的一行规范化为 StoryScriptRow（列驱动，未知列一律丢弃）。 */
export function normalizeStoryScriptRow(raw: unknown, index: number, columns: StoryScriptColumn[] = STORY_SCRIPT_CLASSIC_COLUMNS): StoryScriptRow {
    const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const row = { shot_no: index + 1, duration: 0 } as StoryScriptRow;
    for (const column of columns) {
        // 键名优先英文 key；模型若按中文列名给键，也一并接住。
        const rawValue = source[column.key] !== undefined ? source[column.key] : source[column.label];
        if (column.numeric) {
            row[column.key] = toInt(rawValue, column.key === "shot_no" ? index + 1 : 3);
        } else {
            row[column.key] = toText(rawValue);
        }
    }
    // 时长缺失时给个 3 秒兜底（toInt 已处理 "2-5" / "3秒" 这类写法）。
    if (columns.some((column) => column.key === "duration") && !Number(row.duration)) row.duration = 3;
    if (!row.shot_no) row.shot_no = index + 1;
    return row;
}

export type StoryScriptParseResult = { ok: true; title: string; rows: StoryScriptRow[] } | { ok: false; error: string };

/**
 * 从上往下扫一遍，取出所有「顶层完整 JSON 值」（对象 / 数组）。
 * 字符串里的括号不计入深度 —— 于是 JSONL（多个顶层对象顺序拼接）能逐个被抠出来，
 * 而 `{ "rows": [...] }` 只会被当成一个整体（里面的行仍是它的子节点，不会被重复切出来）。
 */
function extractTopLevelJsonValues(text: string): unknown[] {
    const values: unknown[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{" || char === "[") {
            if (depth === 0) start = index;
            depth += 1;
            continue;
        }
        if (char === "}" || char === "]") {
            if (depth === 0) continue;
            depth -= 1;
            if (depth === 0 && start >= 0) {
                const slice = text.slice(start, index + 1);
                start = -1;
                try {
                    values.push(JSON.parse(slice));
                } catch {
                    // 片段本身不合法（夹了注释 / 被截断）就丢掉，继续往后扫
                }
            }
        }
    }
    return values;
}

/**
 * 把抠出来的顶层 JSON 值摊平成行。模型不爱守契约，这里容忍四种常见形态：
 *  - 契约对象 `{ title, rows: [...] }`（也可能把数组塞进 shots / storyboard / data 等任意字段）；
 *  - 裸对象序列（JSONL / 逐行 JSON / 前后裹说明文字）；
 *  - 单个裸对象 —— 单镜重生成时最常见；
 *  - 镜号做键的字典 `{ "1": {...}, "2": {...} }`。
 * 只有「整段 JSON.parse 失败」时才会走到这里，正常契约不走这条路。
 */
function collectStoryScriptRows(values: unknown[], columns: StoryScriptColumn[]): { title: string; rows: StoryScriptRow[] } {
    const rows: StoryScriptRow[] = [];
    const isRowLike = (record: Record<string, unknown>) => columns.some((column) => record[column.key] !== undefined || record[column.label] !== undefined);
    const addRow = (record: Record<string, unknown>) => {
        rows.push(normalizeStoryScriptRow(record, rows.length, columns));
    };
    const consume = (item: unknown) => {
        if (Array.isArray(item)) {
            item.forEach(consume);
            return;
        }
        if (!item || typeof item !== "object") return;
        const record = item as Record<string, unknown>;
        if (Array.isArray(record.rows)) {
            record.rows.forEach(consume);
            return;
        }
        if (isRowLike(record)) {
            addRow(record);
            return;
        }
        // 不是一行、也没有 rows：整表可能被塞在某个数组字段里（shots / storyboard / data …）
        const arrayValues = Object.values(record).filter((value) => Array.isArray(value)) as unknown[][];
        if (arrayValues.length) {
            arrayValues.forEach((list) => list.forEach(consume));
            return;
        }
        // 剩下的对象值：镜号字典，或再包一层的容器
        const objectValues = Object.values(record).filter((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown>[];
        if (objectValues.length) {
            objectValues.forEach(consume);
            return;
        }
        // 真正兜底：整段只有标量属性，就当它是一行
        if (Object.values(record).some((value) => value === null || typeof value !== "object")) addRow(record);
    };

    let title = "";
    for (const value of values) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const record = value as Record<string, unknown>;
            // 标题只从「非行」的容器上取，免得某一行恰好有 title 列时被误当成表名
            if (!title && !isRowLike(record) && typeof record.title === "string") title = record.title.trim();
        }
        consume(value);
    }
    return { title, rows };
}

/** 从模型输出里解析分镜表：JSON 优先，失败时退回 markdown 表格。列定义由 preset 决定。 */
export function parseStoryScriptOutput(text: string, preset?: StoryScriptPresetId | string | null): StoryScriptParseResult {
    const columns = getStoryScriptColumns(preset);
    const raw = stripCodeFence(String(text || ""));
    if (!raw.trim()) return { ok: false, error: "模型返回为空" };

    // 从模型返回里抠 JSON：先按整段解析（纯 JSON、或根为数组），失败再退到「第一个 { 到最后一个 }」
    // 的区间切片（应对前后裹了说明文字的常见情形）。
    const jsonCandidates = [raw];
    const objStart = raw.indexOf("{");
    const objEnd = raw.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) jsonCandidates.push(raw.slice(objStart, objEnd + 1));
    for (const candidate of jsonCandidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (!parsed || typeof parsed !== "object") continue;
            const record = parsed as Record<string, unknown>;
            const list = Array.isArray(record.rows) ? record.rows : Array.isArray(parsed) ? (parsed as unknown[]) : [];
            const rows = list.map((item, index) => normalizeStoryScriptRow(item, index, columns));
            if (rows.length) return { ok: true, title: toText(record.title), rows };
        } catch {
            // 试下一个候选；都失败就落到下面的表格兜底
        }
    }

    // 结构性兜底：模型常按「一行一个 JSON 对象」逐行输出，或干脆只吐一个裸对象（单镜重生成）。
    // 这类文本整体不是合法 JSON，严格解析会整段崩掉 —— 于是把顶层 JSON 值逐个抠出来再摊平成行。
    const topLevelValues = extractTopLevelJsonValues(raw);
    if (topLevelValues.length) {
        const collected = collectStoryScriptRows(topLevelValues, columns);
        if (collected.rows.length) return { ok: true, title: collected.title, rows: collected.rows };
    }

    const tableRows = parseMarkdownTable(raw, columns);
    if (tableRows.length) return { ok: true, title: "", rows: tableRows };

    // 最后才试「用户自有模版」的逐镜标签块（`- **首帧图片提示词**：…`）。
    // 放在表格之后是刻意的：模型真吐了表格就还走表格，老行为不变。
    const templateRows = parseStoryScriptTemplateRows(raw, columns);
    if (templateRows.length) return { ok: true, title: "", rows: templateRows };

    return { ok: false, error: "无法解析为分镜表结构（既不是 JSON，也不是 Markdown 表格）" };
}

/** 兜底：解析 markdown / 管道分隔表格。按列名匹配表头，匹配不到时按顺序落在已知列上。 */
function parseMarkdownTable(text: string, columns: StoryScriptColumn[]): StoryScriptRow[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes("|"));
    if (lines.length < 2) return [];

    const splitCells = (line: string) =>
        line
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());

    const header = splitCells(lines[0]);
    if (!header.length) return [];
    const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === "");
    const labelToKey = new Map(columns.map((column) => [column.label, column.key]));
    // 表格里可能把「台词/旁白」写成「台词·旁白」等变体，统一把分隔符抹掉再比。
    const looseLabel = (cell: string) => cell.replace(/\s|\*|`/g, "").replace(/[／·、,，]/g, "/");
    const looseLabelToKey = new Map(columns.map((column) => [looseLabel(column.label), column.key]));
    const cleanCell = (cell: string) => cell.replace(/\s|\*|`/g, "");
    // 首行只要有任意一格能对上列名/key 就当成表头；否则视为无表头管道表，整段都是数据。
    const hasHeaderRow = header.some((cell) => {
        const clean = cleanCell(cell);
        return labelToKey.has(clean) || columns.some((column) => column.key === clean);
    });
    const indexToKey = new Map<number, string>();
    if (hasHeaderRow) {
        header.forEach((cell, index) => {
            const clean = cleanCell(cell);
            const direct = columns.find((column) => column.key === clean)?.key;
            const mapped = labelToKey.get(clean) ?? looseLabelToKey.get(looseLabel(cell));
            const key = direct || mapped || (columns[index] ? columns[index].key : undefined);
            if (key) indexToKey.set(index, key);
        });
    } else {
        columns.forEach((column, index) => indexToKey.set(index, column.key));
    }

    const rows: StoryScriptRow[] = [];
    for (const line of hasHeaderRow ? lines.slice(1) : lines) {
        const cells = splitCells(line);
        if (!cells.length || isSeparator(cells)) continue;
        const record: Record<string, unknown> = {};
        cells.forEach((cell, index) => {
            const key = indexToKey.get(index);
            if (key) record[key] = cell;
        });
        if (!Object.keys(record).length) continue;
        rows.push(normalizeStoryScriptRow(record, rows.length, columns));
    }
    return rows;
}

/** 导出 TSV（含表头），方便直接粘进 Excel / 表格工具。 */
export function storyScriptToTsv(rows: StoryScriptRow[], title?: string, preset?: StoryScriptPresetId | string | null): string {
    const columns = getStoryScriptColumns(preset);
    const header = columns.map((column) => column.label).join("\t");
    const body = rows.map((row) => columns.map((column) => String(row[column.key] ?? "").replace(/[\t\r\n]+/g, " ")).join("\t"));
    // 标题（若有）单独占一行，不要多留空行 —— 多一行空行会在 Excel 里落成一段空行。
    return (title ? [title, header, ...body] : [header, ...body]).join("\n");
}

/** 复制 Markdown 表格（列由 preset 决定）。 */
export function storyScriptToMarkdown(rows: StoryScriptRow[], title?: string, preset?: StoryScriptPresetId | string | null): string {
    const columns = getStoryScriptColumns(preset);
    const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
    const separator = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map((row) => `| ${columns.map((column) => String(row[column.key] ?? "").replace(/[\r\n|]+/g, " ")).join(" | ")} |`);
    return [title ? `### ${title}` : "", header, separator, ...body].filter(Boolean).join("\n");
}

/* ───────────────────────── 逐镜「标签块」模版 ───────────────────────── */

/**
 * 用户自带的逐镜提示词模版长这样（一镜一块）：
 *
 * ```
 * ## 场次02—镜头005
 * - **镜头编号**：场次02—镜头005
 * - **镜头时长**：3 秒｜时间码 00:15—00:18
 * - **景别**：中景
 * - **首帧图片提示词**：调用 FS-02。16:9。……
 * - **Seedance 2.0 视频提示词**：Seedance 2.0，时长 3 秒，……
 * ```
 *
 * 这类块要能被「认出来」并落到三列上：
 * - `首帧图片提示词` → `shot_prompt`（分镜提示词）
 * - 景别 / 摄影机参数 / 构图方式 / 画面内容 / 人物动作与表演 / 运镜方式 / 台词与声音 → `video_motion_prompt`
 * - 风格类字段（风格提示词 / 视觉风格 …）→ `style_prompt`
 *
 * 用户 2026-10-22 又给了一种写法（第三套方案 · 火X20 的输出）：标签不带加粗、也不带冒号，
 * 而是**整行一个方括号标签**，景别 / 机位写在**标题后面的方括号**里：
 *
 * ```
 * #### 镜头 01：[全景 / 贴地机位低角度仰拍]
 * 【静帧提示词】
 * 正午烈日下的城市柏油马路。30岁疲惫中国男人（林舟）……
 * ```
 *
 * 两种都要认（`【静帧提示词】` 那个方括号里的标签，就是字段名）。
 *
 * ⚠️ **只在识别到这种块时生效**：普通剧本、契约 JSON、Markdown 表格全走原来的路，一个字节都不变。
 * 语法上靠「`**加粗标签**：值` 且至少有两个标签、且含一个锚点标签」来认，普通剧本里不会出现这种写法。
 */
type StoryScriptTemplateField = { label: string; value: string; bracket?: boolean };
type StoryScriptTemplateBlock = { heading: string; fields: StoryScriptTemplateField[] };

/**
 * 行首可选的列表符号：`-` / `*` / `•` / `+`，也容忍 `1.` `1、` `1)` `（1）` 这类有序列表
 * （从 Word / 飞书 / 大纲工具里粘出来的模版经常带序号，缺了这一项就整段认不出来）。
 */
const STORY_SCRIPT_TEMPLATE_BULLET = String.raw`(?:[-*•+]|\d+[.、)）]|（\d+）)`;
const STORY_SCRIPT_TEMPLATE_BOLD_LINE = new RegExp(String.raw`^\s*` + STORY_SCRIPT_TEMPLATE_BULLET + String.raw`?\s*\*\*(.+?)\*\*\s*[：:]\s*(.*)$`);
const STORY_SCRIPT_TEMPLATE_PLAIN_LINE = new RegExp(String.raw`^\s*` + STORY_SCRIPT_TEMPLATE_BULLET + String.raw`\s*([^：:*\n]{2,14}?)\s*[：:]\s*(.*)$`);
const STORY_SCRIPT_TEMPLATE_HEADING = /^\s*#{1,6}\s*(.+?)\s*$/;
/**
 * 整行一个方括号标签（第三套方案 · 火X20 的写法）：`【静帧提示词】` / `【视频提示词】`，
 * 冒号可有可无，值可以和标签同行。
 *
 * ⚠️ 只认**已知标签**（见 `STORY_SCRIPT_TEMPLATE_KNOWN_LABELS`）—— `【空镜】`、`【转场：黑场】`
 * 这种「给模型看的批注」在输出里很常见，一律当正文续行，不能当字段名，否则正文会被切碎。
 */
const STORY_SCRIPT_TEMPLATE_BRACKET_LINE = /^\s*【\s*([^】\n]{1,16}?)\s*】\s*[：:]?\s*(.*)$/;

/** 标签归一：去空白 / 星号 / 顿号 / 斜杠 / 括号，让「人物动作与表演」和「人物动作」能对上。 */
function normalizeTemplateLabel(label: string): string {
    return String(label || "")
        .replace(/[\s*`]/g, "")
        .replace(/[与和及／/、,，:：()（）　]/g, "");
}

/** 视频运动提示词按这个顺序拼（用户指定，不是文档里的出现顺序）。 */
const STORY_SCRIPT_TEMPLATE_MOTION_LABELS = ["景别", "摄影机参数", "构图方式", "画面内容", "人物动作与表演", "运镜方式", "台词与声音"];

/** 不加粗的 `- 标签：值` 只认这些标签，否则 `16:9。` 这种值会被误当成新字段。 */
const STORY_SCRIPT_TEMPLATE_KNOWN_LABELS = new Set(
    [
        "镜头编号", "镜号", "镜头", "所属场景", "场景", "出场人物", "人物", "角色",
        "镜头时长", "时长", "景别", "摄影机参数", "摄像机参数", "构图方式", "构图",
        "画面内容", "画面描述", "人物动作与表演", "人物动作", "主体动作", "表演",
        "运镜方式", "镜头运动", "运镜", "台词与声音", "台词", "音效", "声音", "台词旁白", "音效配乐",
        "镜头叙事作用", "叙事作用", "首帧图片提示词", "图片提示词", "首帧提示词", "分镜提示词",
        // 第三套方案（火X20）的写法：`【静帧提示词】` 下面接整段画面提示词，`【视频提示词】` 接视频段。
        "静帧提示词", "画面提示词", "首帧图提示词", "分镜图提示词", "视频提示词",
        "视频运动提示词", "风格提示词", "视觉风格", "画面风格", "影像风格", "风格",
        // 机位（`[全景 / 贴地机位低角度仰拍]` 里的后半段，单独成行时也要能认）
        "机位", "拍摄机位", "摄影机机位", "摄像机机位",
        "负面", "负面提示词", "转场方式", "转场",
        // 资产调用行（用户模版把「这一镜用哪些资产」单独列出来，名字带 P-01 / S-01 / D-01 这类编号）
        "出场人物资产", "出场人物资产1", "出场人物资产2", "人物资产", "角色资产", "出场角色资产",
        "出场人物2资产", "第二人物资产",
        "调用场景资产", "场景资产", "使用场景资产", "调用场景",
        "调用道具资产", "道具资产", "使用道具资产", "调用道具",
    ].map(normalizeTemplateLabel),
);

/** 锚点标签：没有其中一个就不算「模版块」（防止把普通剧本里的几行加粗当成分镜）。 */
const STORY_SCRIPT_TEMPLATE_ANCHORS = new Set(
    ["镜头编号", "镜号", "首帧图片提示词", "图片提示词", "分镜提示词", "静帧提示词", "画面提示词", "画面内容", "镜头时长", "景别", "人物动作与表演", "运镜方式"].map(normalizeTemplateLabel),
);

function isTemplateAnchor(label: string): boolean {
    const normalized = normalizeTemplateLabel(label);
    if (STORY_SCRIPT_TEMPLATE_ANCHORS.has(normalized)) return true;
    // `Seedance 2.0 视频提示词` 这类带前缀的写法：以「视频提示词」结尾就认。
    return /视频提示词$/.test(normalized) && !/运动提示词$/.test(normalized);
}

/** 取末尾一段数字（`场次02—镜头005` → 5）；没有则 0。 */
function trailingNumber(value: string): number {
    const matches = String(value || "").match(/\d+/g);
    return matches?.length ? Number(matches[matches.length - 1]) : 0;
}

/** 常见景别（用在标题方括号摘要是「景别 / 机位」两段式的时候，先把景别摘出来）。 */
const STORY_SCRIPT_TEMPLATE_SHOT_SIZE = /^(?:大远景|远景|大全景|全景|小全景|中全景|中景|中近景|近景|特写|大特写|微距|空镜|中远景|半身景|全身景)$/;

/**
 * 标题里的「镜号 + 方括号摘要」—— 第三套方案（火X20）的标题长这样：
 *
 * ```
 * #### 镜头 01：[全景 / 贴地机位低角度仰拍]
 * ```
 *
 * 返回 `{ shotNo: 1, shotSize: "全景", camera: "贴地机位低角度仰拍" }`。
 *
 * ⚠️ 镜号只从**方括号之前**那截取：整行跑 `trailingNumber` 会被摘要里的数字抢走
 * （`[全景 / 24mm 广角]` 会变成「第 24 镜」）。
 */
function parseTemplateHeading(heading: string): { shotNo: number; shotSize: string; camera: string } {
    const text = String(heading || "").trim();
    const bracket = /[\[［【(（]([^\]］】)）]+)[\]］】)）]/.exec(text);
    if (!bracket) return { shotNo: trailingNumber(text), shotSize: "", camera: "" };
    const bracketText = bracket[1].trim();
    // `[00:12—00:15]` / `[3 秒]` 这类是时间码 / 时长，不是景别机位摘要 —— 别塞进景别里。
    if (/^[\d\s:：\-—~～.秒sS]+$/.test(bracketText)) {
        return { shotNo: trailingNumber(text.slice(0, bracket.index)), shotSize: "", camera: "" };
    }
    const segments = bracketText
        .split(/[/／|｜、，,;；]+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
    const sizeIndex = segments.findIndex((segment) => STORY_SCRIPT_TEMPLATE_SHOT_SIZE.test(segment));
    const shotSize = sizeIndex >= 0 ? segments.splice(sizeIndex, 1)[0] : "";
    return { shotNo: trailingNumber(text.slice(0, bracket.index)), shotSize, camera: segments.join(" / ") };
}

/**
 * 标题行里「顺手拖出来的字段」。
 *
 * 模型（尤其第三套方案 · 火X20）经常把标签**贴在标题同一行**：
 *
 * ```
 * #### 镜头 01：[全景 / 贴地机位低角度仰拍]【静帧提示词】正午烈日下的城市柏油马路。30岁……
 * ### 镜头 01：[中景] **首帧图片提示词**：电影级写实摄影质感，2.39:1 宽银幕……
 * ```
 *
 * 老实现把这整行当标题 `continue` 掉 —— 块里一个字段都没有，也就达不到「≥2 字段 /
 * 单字段强锚点」的门槛，整块被丢掉，用户看到的就是「第三套 / 第二套的分镜提示词没识别到」。
 *
 * 返回 `{ heading, fields }`：`heading` 只留镜号 + 方括号摘要（给 `parseTemplateHeading`），
 * `fields` 是拖在后面的那些字段（后续行照旧并进最后一个字段的 `value`）。
 * 一行里可能不止一个字段（`【静帧提示词】A【视频提示词】B`），所以要按标签逐个切。
 */
function splitTemplateHeadingInlineFields(text: string): { heading: string; fields: StoryScriptTemplateField[] } {
    const trimmed = String(text || "").trim();
    const knownLabel = (label: string) => STORY_SCRIPT_TEMPLATE_KNOWN_LABELS.has(normalizeTemplateLabel(label));

    /** 从一段文字里找「下一个已知标签」的起始位置（`【标签】` / `**标签**` 都认）。 */
    const nextLabelIndex = (value: string): number => {
        const bracketRe = /【\s*([^】\n]{1,16}?)\s*】/g;
        let match: RegExpExecArray | null;
        while ((match = bracketRe.exec(value))) {
            if (match.index > 0 && knownLabel(match[1])) return match.index;
        }
        const boldRe = /\*\*([^*\n]{1,20}?)\*\*/g;
        while ((match = boldRe.exec(value))) {
            if (match.index > 0 && knownLabel(match[1])) return match.index;
        }
        return -1;
    };

    // 标题结束的位置 = 第一个已知标签的起点（`[全景 / 机位]` 这种摘要不是标签，跳过）。
    const firstBracket = /【\s*([^】\n]{1,16}?)\s*】/.exec(trimmed);
    const bracketStart = firstBracket && firstBracket.index > 0 && knownLabel(firstBracket[1]) ? firstBracket.index : -1;
    let boldStart = -1;
    const boldRe = /\*\*([^*\n]{1,20}?)\*\*/g;
    let boldMatch: RegExpExecArray | null;
    while ((boldMatch = boldRe.exec(trimmed)) && boldStart < 0) {
        if (boldMatch.index > 0 && knownLabel(boldMatch[1])) boldStart = boldMatch.index;
    }
    const candidates = [bracketStart, boldStart].filter((index) => index > 0);
    if (!candidates.length) return { heading: trimmed, fields: [] };
    const start = Math.min(...candidates);

    const fields: StoryScriptTemplateField[] = [];
    let rest = trimmed.slice(start);
    // 上限只是防「一段超长正文里反复出现标签」把这里拖成 O(n²)，正常一行最多两个字段。
    for (let guard = 0; rest && guard < 6; guard += 1) {
        const bracket = rest.match(/^【\s*([^】\n]{1,16}?)\s*】\s*[：:]?\s*([\s\S]*)$/);
        if (bracket && knownLabel(bracket[1])) {
            const cut = nextLabelIndex(bracket[2]);
            fields.push({ label: bracket[1].trim(), value: (cut > 0 ? bracket[2].slice(0, cut) : bracket[2]).trim(), bracket: true });
            rest = cut > 0 ? bracket[2].slice(cut) : "";
            continue;
        }
        const bold = rest.match(/^\s*(?:[-*•+]\s*)?\*\*([^*\n]{1,20}?)\*\*\s*[：:]?\s*([\s\S]*)$/);
        if (bold && knownLabel(bold[1])) {
            const cut = nextLabelIndex(bold[2]);
            fields.push({ label: bold[1].trim(), value: (cut > 0 ? bold[2].slice(0, cut) : bold[2]).trim(), bracket: false });
            rest = cut > 0 ? bold[2].slice(cut) : "";
            continue;
        }
        break;
    }
    if (!fields.length) return { heading: trimmed, fields: [] };
    return { heading: trimmed.slice(0, start).trim(), fields };
}

/**
 * 只有一个字段也算模版的「强锚点」。
 *
 * 用户 03 给的模版就是每镜只有一行 `- **首帧图片提示词**：` 起头、正文全在下面几行 ——
 * 这种块字段数是 1，老门槛（≥2 字段）会整块丢掉，表现就是「我贴了模版，但三列还是模型自己写的」。
 * 只放这几个一看就是分镜模版的标签，普通剧本里的单行加粗（`**注意**：…`）不会被误判。
 */
const STORY_SCRIPT_TEMPLATE_SOLO_ANCHORS = new Set(
    ["首帧图片提示词", "图片提示词", "首帧提示词", "分镜提示词", "视频提示词", "静帧提示词", "画面提示词", "首帧图提示词", "分镜图提示词"].map(normalizeTemplateLabel),
);

function isSingleFieldTemplateBlock(block: StoryScriptTemplateBlock): boolean {
    if (block.fields.length !== 1) return false;
    const only = block.fields[0];
    return Boolean(only && STORY_SCRIPT_TEMPLATE_SOLO_ANCHORS.has(normalizeTemplateLabel(only.label)) && only.value.trim());
}

/**
 * 把文本切成「一镜一块」。开新块的三种情况：镜号标题行、块内第二次出现 `镜头编号`、以及块外的首个字段。
 * 字段内的续行（换行 / 缩进）并进上一个字段。
 */
function splitStoryScriptTemplateBlocks(raw: string): StoryScriptTemplateBlock[] {
    const blocks: StoryScriptTemplateBlock[] = [];
    let current: StoryScriptTemplateBlock | null = null;
    let lastField: StoryScriptTemplateField | null = null;

    const flush = () => {
        // 少于两个字段、或没有任何锚点标签 → 不是模版块，直接丢掉。
        // 例外：单字段的强锚点块（`- **首帧图片提示词**：` + 整段正文）也要认。
        if (current && current.fields.some((field) => isTemplateAnchor(field.label)) && (current.fields.length >= 2 || isSingleFieldTemplateBlock(current))) {
            blocks.push(current);
        }
        current = null;
        lastField = null;
    };

    /** 开一个新块：`headingText` 里若拖着字段（`镜头 01：[全景]【静帧提示词】…`）一并进块。 */
    const startBlock = (headingText: string) => {
        const inline = splitTemplateHeadingInlineFields(headingText);
        flush();
        const block: StoryScriptTemplateBlock = { heading: inline.heading, fields: [] };
        current = block;
        for (const field of inline.fields) {
            block.fields.push(field);
            // 续行并进**最后一个**字段：`【静帧提示词】A【视频提示词】B` 之后的行属于视频段。
            lastField = field;
        }
    };
    /** 这一行是不是「镜号标题」（`镜头 02` / `场次02—镜头005` / `第 3 镜`）；不是就当正文续行。 */
    const looksLikeShotHeading = (text: string) => /场次|镜头|镜号|第\s*\d+\s*镜|\bshot\b|\bscene\b/i.test(text);

    for (const rawLine of String(raw || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        // `---` / `***` 水平分隔线：既不是字段也不是正文，跳过（模型常在镜与镜之间加一条）。
        if (/^[-*_]{3,}$/.test(line)) continue;

        const heading = line.match(STORY_SCRIPT_TEMPLATE_HEADING);
        if (heading) {
            const text = heading[1].trim();
            // 只把「场次 / 镜头」这类镜号标题当块边界，其它小标题忽略（别把一块拆成两块）。
            if (looksLikeShotHeading(text)) startBlock(text);
            continue;
        }

        /**
         * 不加 `#` 的镜号标题，两种写法都要当块边界，否则这一行会被当成**上一镜的续行**
         * 塞进提示词末尾（`…参考《白日焰火》。\n**镜头 02：中景**`，正文被污染）：
         *  - `**镜头 02：中景**` / `**镜头 02：中景**：`（加粗成一行，冒号在加粗里或在外）
         *  - `镜头 02：中景`（裸标题，必须是「镜号 + 数字」才认，否则 `镜头缓慢横移…` 这种正文会被切走）
         */
        const shotHeadingOnly =
            /^\s*(?:[-*•+]\s*)?\*\*([^*\n]{1,24}?)\*\*\s*[：:]?\s*$/.exec(line)?.[1] ??
            (/^(?:镜头|场次|镜号|第)\s*[0-9０-９一二三四五六七八九十]{1,3}\s*[：:]/.test(line) ? line : "");
        if (shotHeadingOnly && looksLikeShotHeading(shotHeadingOnly) && !STORY_SCRIPT_TEMPLATE_KNOWN_LABELS.has(normalizeTemplateLabel(shotHeadingOnly))) {
            startBlock(shotHeadingOnly);
            continue;
        }

        const bold = line.match(STORY_SCRIPT_TEMPLATE_BOLD_LINE);
        // 整行方括号标签（`【静帧提示词】`）：只认已知标签，不认识的当正文续行（见正则上的注释）。
        const bracket = bold ? null : line.match(STORY_SCRIPT_TEMPLATE_BRACKET_LINE);
        const plain = bold || bracket ? null : line.match(STORY_SCRIPT_TEMPLATE_PLAIN_LINE);
        const matched = bold
            ? { label: bold[1].trim(), value: bold[2].trim(), bracket: false }
            : bracket && STORY_SCRIPT_TEMPLATE_KNOWN_LABELS.has(normalizeTemplateLabel(bracket[1]))
              ? { label: bracket[1].trim(), value: bracket[2].trim(), bracket: true }
              : plain && STORY_SCRIPT_TEMPLATE_KNOWN_LABELS.has(normalizeTemplateLabel(plain[1]))
                ? { label: plain[1].trim(), value: plain[2].trim(), bracket: false }
                : null;

        // `**镜头 02：中景**：`（加粗、无值、标签也不是已知字段）：仍按标题处理，别建成一个空字段 ——
        // 建了空字段，后面几行提示词就全并进它，整镜内容静默消失。
        if (matched && !matched.value && looksLikeShotHeading(matched.label) && !STORY_SCRIPT_TEMPLATE_KNOWN_LABELS.has(normalizeTemplateLabel(matched.label))) {
            startBlock(matched.label);
            continue;
        }

        if (matched) {
            // 没有标题行时，第二次出现「镜头编号」就是新的一镜。
            const isShotNo = /^(镜头编号|镜号)$/.test(normalizeTemplateLabel(matched.label));
            if (isShotNo && current && current.fields.some((field) => /^(镜头编号|镜号)$/.test(normalizeTemplateLabel(field.label)))) {
                flush();
            } else if (
                // 单字段模版（每镜只有一行 `- **首帧图片提示词**：`）：同一锚点第二次出现就是下一镜。
                // 不加这条，整段 10 镜会被并成一块，`fields` 去重后只剩第一镜的提示词。
                STORY_SCRIPT_TEMPLATE_SOLO_ANCHORS.has(normalizeTemplateLabel(matched.label)) &&
                current?.fields.some((field) => normalizeTemplateLabel(field.label) === normalizeTemplateLabel(matched.label))
            ) {
                flush();
            }
            if (!current) current = { heading: "", fields: [] };
            lastField = { label: matched.label, value: matched.value, bracket: matched.bracket };
            current.fields.push(lastField);
            continue;
        }

        if (lastField) lastField.value = `${lastField.value}\n${line}`.trim();
    }
    flush();
    return blocks;
}

/**
 * 资产编号前缀：`P-01` / `S-01` / `D-01` / `C_2` 这类（用户模版里的资产 ID）。匹配不到就原样返回。
 */
const STORY_SCRIPT_TEMPLATE_ASSET_CODE = /^[A-Za-z]{1,3}\s*[-_－]?\s*\d{1,4}\s*[:：.、]?\s*/;

/**
 * 把一行「资产调用」拆成「名字 + 描述」：
 *   `P-01 苏晚（同镜头 001 造型；中近景）`           → 苏晚 / 同镜头 001 造型；中近景
 *   `D-01 蜜桃乌龙茶（两杯），苏晚持有，杯壁有指痕`   → 蜜桃乌龙茶 / 两杯，苏晚持有，杯壁有指痕
 *   `S-01 奶茶店门外人行道`                         → 奶茶店门外人行道 / （空）
 *
 * 名字列必须干净（不带 `P-01` 编号、不带括号里的注释）——它是拿去和画布素材标题做匹配的键，
 * 留着编号反而匹配不上（用户原话：「不用把资产名锁太死」）。描述列则要保留括号内**和**括号后的全部内容。
 */
function splitTemplateAssetValue(value: string): { name: string; description: string } {
    const raw = String(value || "").trim();
    if (!raw) return { name: "", description: "" };
    const body = raw.replace(STORY_SCRIPT_TEMPLATE_ASSET_CODE, "").trim();
    const open = body.search(/[（(]/);
    if (open < 0) {
        // 没有括号：第一个逗号 / 分号前是名字，剩下是描述（「蜜桃乌龙茶，两杯，苏晚持有」这种写法）。
        const cut = body.search(/[，,；;]/);
        if (cut < 0) return { name: body, description: "" };
        return { name: body.slice(0, cut).trim() || body, description: body.slice(cut + 1).trim() };
    }
    const name = body.slice(0, open).trim().replace(/[，,、；;]$/, "");
    const tail = body.slice(open).trim();
    const close = tail.search(/[）)]/);
    const inner = close < 0 ? tail.replace(/^[（(]/, "") : tail.slice(1, close);
    const after = close < 0 ? "" : tail.slice(close + 1).replace(/^[，,、；;\s]+/, "").trim();
    const description = [inner.trim(), after].filter(Boolean).join("，");
    return { name: name || body, description };
}

/** 模板块 → 分镜行。列映射只落在**当前预设真有这一列**的字段上。 */
function parseStoryScriptTemplateRows(text: string, columns: StoryScriptColumn[]): StoryScriptRow[] {
    const blocks = splitStoryScriptTemplateBlocks(text);
    if (!blocks.length) return [];
    const hasColumn = (key: string) => columns.some((column) => column.key === key);
    const rows: StoryScriptRow[] = [];

    for (const block of blocks) {
        const fields = new Map<string, string>();
        for (const field of block.fields) {
            const key = normalizeTemplateLabel(field.label);
            if (!fields.has(key) && field.value) fields.set(key, field.value);
        }
        const pick = (...labels: string[]) => {
            for (const label of labels) {
                const value = fields.get(normalizeTemplateLabel(label));
                if (value) return value;
            }
            return "";
        };
        // `Seedance 2.0 视频提示词` 这类带前缀的：字段名结尾是「视频提示词」但又不是「视频运动提示词」。
        const videoPromptField = Array.from(fields.entries()).find(([key]) => /视频.*提示词$/.test(key) && !/运动提示词$/.test(key))?.[1] || "";

        const record: Record<string, unknown> = {};
        const headingInfo = parseTemplateHeading(block.heading);
        /**
         * 标题方括号里的摘要（`[全景 / 贴地机位低角度仰拍]`）当作「景别 / 机位」的后备字段。
         * 块里真的写了 `- **景别**：` / `【机位】` 时以块内为准（这里只在没有时补）。
         */
        if (headingInfo.shotSize) {
            const key = normalizeTemplateLabel("景别");
            if (!fields.has(key)) fields.set(key, headingInfo.shotSize);
        }
        if (headingInfo.camera) {
            const key = normalizeTemplateLabel("机位");
            if (!fields.has(key)) fields.set(key, headingInfo.camera);
        }
        const shotNo = trailingNumber(pick("镜头编号", "镜号")) || headingInfo.shotNo;
        if (shotNo) record.shot_no = shotNo;
        const duration = /^\d+/.exec(pick("镜头时长", "时长"))?.[0];
        if (duration) record.duration = Number(duration);

        // 能直接对上列名的字段（先填列，视频运动提示词那边还会再拼一遍，互不影响）。
        const direct: Array<[string[], string]> = [
            [["所属场景", "场景"], "scene"],
            [["出场人物", "人物", "角色"], "character_1"],
            [["景别"], "shot"],
            [["画面内容", "画面描述"], "visual_description"],
            [["人物动作与表演", "人物动作", "主体动作"], "character_action"],
            [["运镜方式", "镜头运动", "机位"], "camera_movement"],
            [["转场方式", "转场"], "transition"],
        ];
        for (const [labels, key] of direct) {
            if (!hasColumn(key)) continue;
            const value = pick(...labels);
            if (value) record[key] = value;
        }
        /**
         * classic 预设**没有**「镜头运动」列。标题方括号里的机位（`[全景 / 贴地机位低角度仰拍]`）
         * 不能就这么丢掉 —— 并到景别里显示（`全景｜贴地机位低角度仰拍`），否则「完整填入」是一句空话。
         *
         * ⚠️ 只并**标题摘要**里的机位：老模版那种独立 `运镜方式：固定机位…` 是完整句子，
         * 无差别 pick 进来会既挤又串味（第一版就是那么写的，直接把老探针打红了）。
         */
        if (!hasColumn("camera_movement") && hasColumn("shot") && headingInfo.camera) {
            if (record.shot) record.shot = `${record.shot}｜${headingInfo.camera}`;
        }
        const dialogue = pick("台词与声音", "台词", "台词旁白");
        if (dialogue) {
            if (hasColumn("sound")) record.sound = dialogue;
            // 「无台词；鞋底轻擦声…」这类：对白列写「无台词」，声音列留全段。
            if (hasColumn("dialogue")) record.dialogue = /^无台词/.test(dialogue) ? "无台词" : dialogue;
        }

        /**
         * 资产调用行 → 资产列。用户 2026-10-19 明确要求：
         * 「每个镜头使用的资产请识别这个内容下的：`出场人物资产` / `调用场景资产` / `调用道具资产`」。
         * 名字列（角色1 / 场景 / 道具）以模版为准 —— 这是「这一镜用哪张资产图」的唯一依据；
         * 描述列只在模版确实给了括号内容时才有值，覆盖层那边还会再判一次「模型没写才补」。
         */
        const assetFields: Array<[string[], string, string]> = [
            [["出场人物资产", "出场人物资产1", "人物资产", "角色资产", "出场角色资产"], "character_1", "character_description_1"],
            [["出场人物资产2", "出场人物2资产", "第二人物资产"], "character_2", "character_description_2"],
            [["调用场景资产", "场景资产", "使用场景资产", "调用场景"], "scene", "scene_description"],
            [["调用道具资产", "道具资产", "使用道具资产", "调用道具"], "prop", "prop_description"],
        ];
        for (const [labels, nameKey, descriptionKey] of assetFields) {
            if (!hasColumn(nameKey)) continue;
            const split = splitTemplateAssetValue(pick(...labels));
            if (!split.name) continue;
            record[nameKey] = split.name;
            if (split.description && hasColumn(descriptionKey)) record[descriptionKey] = split.description;
        }

        // 分镜提示词 = 首帧图片提示词（storyboard 没有这一列时退到画面描述 —— 那边生图就看画面描述）。
        // `静帧提示词` / `画面提示词` 是第三套方案（火X20）的叫法，同一个位置。
        const firstFrame = pick("首帧图片提示词", "图片提示词", "首帧提示词", "静帧提示词", "画面提示词", "首帧图提示词", "分镜图提示词", "分镜提示词");
        if (firstFrame) {
            if (hasColumn("shot_prompt")) record.shot_prompt = firstFrame;
            else if (hasColumn("visual_description")) record.visual_description = firstFrame;
        }

        const style = pick("风格提示词", "视觉风格", "画面风格", "影像风格", "风格");
        if (style && hasColumn("style_prompt")) record.style_prompt = style;

        if (hasColumn("video_motion_prompt")) {
            const motionLines = STORY_SCRIPT_TEMPLATE_MOTION_LABELS.map((label) => {
                const value = pick(label);
                return value ? `${label}：${value}` : "";
            }).filter(Boolean);
            /**
             * 第三套方案（火X20）是**显式分段**的：`【视频提示词】` 那一段就是视频提示词全文，
             * 不能被上面按标签拼出来的「景别：…」顶掉（景别来自标题摘要，只是个摘要）。
             * 老模版（加粗标签）没有这种分段，仍按标签拼 —— 老行为一个字不改。
             */
            const bracketVideoPrompt =
                block.fields.find(
                    (field) =>
                        field.bracket &&
                        /视频.*提示词$/.test(normalizeTemplateLabel(field.label)) &&
                        !/运动提示词$/.test(normalizeTemplateLabel(field.label)) &&
                        field.value.trim(),
                )?.value || "";
            const motion = bracketVideoPrompt || (motionLines.length ? motionLines.join("\n") : pick("视频运动提示词") || videoPromptField);
            if (motion) record.video_motion_prompt = motion;
        }

        if (!Object.keys(record).length) continue;
        rows.push(normalizeStoryScriptRow(record, rows.length, columns));
    }
    return rows;
}

/**
 * 这段文本是不是「逐镜标签块」模版（任务书靠它决定要不要加「原文搬运」要求）。
 * 只认块级命中，不认零星几行 —— 普通剧本不会出现 `- **首帧图片提示词**：…` 这种写法。
 */
export function hasStoryScriptShotTemplate(text: string): boolean {
    return splitStoryScriptTemplateBlocks(String(text || "")).length > 0;
}

/**
 * 源内容里识别到的逐镜模版块数（0 = 没识别到）。
 * UI 用它显示「已识别 N 块」——用户最需要知道的就是「到底认没认出来」，
 * 以前这一步全靠猜（「是没识别到，还是模型没生成？」）。
 */
export function countStoryScriptTemplateShots(text: string): number {
    return splitStoryScriptTemplateBlocks(String(text || "")).length;
}

/**
 * 模版里**以模版为准**的列（模型写了也覆盖）：
 *  - 三列提示词（照抄）；
 *  - 资产**名字**列（角色1 / 角色2 / 场景 / 道具）—— 模版的 `出场人物资产` / `调用场景资产` /
 *    `调用道具资产` 就是「这一镜用哪张资产」的唯一依据，模型改写名字会导致铺链路连错图。
 * 资产**描述**列刻意不在里面（模版给的括号注释通常比「资产部分自定义要求」生成的短），只在模型没写时才补。
 */
const STORY_SCRIPT_TEMPLATE_FORCE_KEYS = new Set(["shot_prompt", "video_motion_prompt", "style_prompt", "character_1", "character_2", "scene", "prop"]);

/**
 * 把源模版的提示词 / 资产 / 时长**确定性地**盖到模型产出的行上。
 *
 * 为什么要这一步（任务书里已经要求「照搬」了）：模型对「照搬」的执行率不是 100%，而用户要的是
 * 「我贴什么就填什么」。这里兜底：
 *  - `shot_prompt` / `video_motion_prompt` / `style_prompt`：模版有值就**以模版为准**（覆盖模型）；
 *  - 资产名字列（角色1 / 角色2 / 场景 / 道具）：同上，以模版为准（用户 03/04 的明确要求）；
 *  - `duration`：模版写了 `镜头时长` 就以模版为准（用户原话：「镜头的时长请识别这个内容下的，即为 3 秒」）；
 *  - 其余列（景别 / 画面描述 / 角色动作 / 运镜 / 音效 / 资产描述列…）：**只补空**，模型写了的不覆盖；
 *  - `shot_no` 刻意不覆盖：图位表（`scriptRowAssets`）以镜号为键，事后改号会让已有图位错位。
 * 没识别到模版 → 原样返回（同一个数组引用），老流程零变化。
 */
export function applyStoryScriptTemplateOverlay(
    rows: StoryScriptRow[],
    sourceText: string,
    preset?: StoryScriptPresetId | string | null,
): StoryScriptRow[] {
    if (!rows?.length) return rows;
    const columns = getStoryScriptColumns(preset);
    const templateRows = parseStoryScriptTemplateRows(String(sourceText || ""), columns);
    if (!templateRows.length) return rows;
    const byShot = new Map<number, StoryScriptRow>();
    for (const row of templateRows) {
        const shot = Number(row.shot_no) || 0;
        if (shot && !byShot.has(shot)) byShot.set(shot, row);
    }
    /**
     * 镜号一个都对不上（模型自己从 1 重新编号，最常见）→ **按顺序对齐**。
     * 只看「行数是否相等」是不够的：模版 12 块、模型只吐了 8 行时也该把前 8 块对上去，
     * 以前这种情形整层静默不做，用户看到的就是「三列还是空的」。
     */
    const anyShotMatch = rows.some((row, index) => byShot.has(Number(row.shot_no) || index + 1));
    return rows.map((row, index) => {
        const shot = Number(row.shot_no) || index + 1;
        const patch = anyShotMatch ? byShot.get(shot) : templateRows[index];
        if (!patch) return row;
        const next: StoryScriptRow = { ...row };
        const templateDuration = Number(patch.duration);
        if (Number.isFinite(templateDuration) && templateDuration > 0) next.duration = templateDuration;
        for (const column of columns) {
            const key = column.key;
            if (column.numeric || key === "shot_no") continue;
            const value = storyScriptCellText(patch[key]);
            if (!value) continue;
            if (STORY_SCRIPT_TEMPLATE_FORCE_KEYS.has(key) || !storyScriptCellText(next[key])) next[key] = value;
        }
        return next;
    });
}

