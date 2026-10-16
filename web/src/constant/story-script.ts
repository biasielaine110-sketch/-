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
};

export type StoryScriptPreset = {
    id: StoryScriptPresetId;
    columns: StoryScriptColumn[];
    systemPrompt: string;
    /** 行操作列上的复制按钮 */
    rowActions: StoryScriptRowAction[];
    /** 「发送到画布」优先取这一列的内容 */
    insertKey: string;
    /** 任务书构建器 */
    buildTask: (input: { sourceText: string; prompt?: string; characterRefs?: string; segmentSeconds?: unknown }) => string;
    /**
     * 单镜重生成任务书（「重生成本镜」用）：带上上一镜 / 下一镜上下文，要求模型只重写这一镜，
     * 进而保住「人物站位 / 场景 / 道具与上一镜一致」的连续性。
     */
    buildRowTask: (input: StoryScriptRowTaskInput) => string;
    /**
     * 「一键铺链路」用来从一行分镜里抽出图片/视频提示词。不同预设的列语义不同，所以下沉到预设。
     * 缺列时允许兜底拼接，但**不允许返回空串**（调用方靠空串判断这一行铺不出来）。
     */
    buildShotPrompts: (row: StoryScriptRow) => StoryScriptShotPrompts;
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
      "shot_prompt": "…",
      "video_motion_prompt": "…"
    }
  ]
}
\`shot_no\` 和 \`duration\` 必须是整数（不要写 "2-5"、"3秒"）；其余字段一律字符串，缺失时写 \`无\`。`;

const STORY_SCRIPT_COMMON_RULES = [
    "输出字段必须覆盖：镜号、时长、画面描述、角色1、角色描述1、角色2、角色描述2、场景、场景描述、道具、道具描述、景别、角色动作、人物站位、情绪、场景标签、光影氛围、音效、对白、分镜提示词、视频运动提示词。",
    "如果用户给了额外要求，也必须一起遵守。",
    "请严格按照影视制片表格思路输出，不要输出散文摘要。",
    "请让分镜提示词和视频运动提示词都采用括号分段 + 号连接的格式。",
    "缺失对白时写 `无`。",
    "分镜提示词必须像高质量图像生成提示词，视频运动提示词必须像高质量视频运动提示词，而不是简单一句概括。",
];

const STORY_SCRIPT_STYLE_HINT = [
    "参考风格要点：",
    "- 镜号连续递增",
    "- 时长大多 2-5 秒",
    "- 景别写法类似 `近景 / 特写`、`中景 / 仰视`",
    "- 角色描述尽量写成 `[角色ID: ...]` 形式",
    "- 同一个人物在所有行里必须用完全一致的角色名",
    "- 一镜里出现两个角色时，第二个填进角色2 / 角色描述2",
    "- 分镜提示词最好严格按 8 段写：构图、角色卡/主体描述、空间关系、微表情/状态、环境与道具、光影几何、视觉风格、技术参数",
    "- 如果存在角色1，分镜提示词第二段尽量直接使用或轻改角色描述1，不要换成模糊代称",
    "- 分镜提示词中的技术参数段尽量保留，不要省略",
    "- 视频运动提示词最好严格按 6 段写：运镜轨迹、主体动作、环境动态、音效氛围、对白语气、时长",
    "- 视频运动提示词里的主体动作必须是可见物理动作，不要只写情绪变化",
    "- 每一镜都要填「场景 / 场景描述 / 道具 / 道具描述 / 人物站位」，同一场景或同一道具在多镜里必须复用完全一致的名字",
    "- 人物站位要写清谁在画面左侧 / 右侧 / 前景 / 后景、朝向、彼此的远近；除非这一镜人物确实移动，否则保持与上一镜一致",
    "- 人物移动时写清从上一位置到新位置的移动过程，不要让角色在两镜之间凭空换位",
].join("\n");

/**
 * 「视频分镜脚本」system prompt。
 * 前段**原文照搬** recipe 的 `system_prompt`；后段是本仓补的输出约定（见文件头「已知的有意偏离」）。
 */
export const STORY_SCRIPT_STORYBOARD_SYSTEM_PROMPT = `你是一名资深分镜编剧兼导演，请基于创意大纲直接生成完整的分镜脚本。

你的输出就是最终分镜脚本，不要返回给另一个模型的提示词或操作说明。

最终输出必须包含以下结构化要素：
-【角色设定】你是一名资深分镜编剧兼导演，精通镜头语言、叙事节奏与视觉表达
-【任务目标】基于以下创意大纲，生成结构化的分镜脚本表格：[从上游创意大纲中提取的核心内容摘要]
-【输出格式要求】最终输出包含 Markdown 表格，每个镜头一行，列包含：镜号（S01起）、时长（精确到秒）、景别（远景/全景/中景/近景/特写/大特写）、画面描述（精确到可直接作为图片生成 prompt）、关键视觉、主体动作、镜头运动（推/拉/摇/移/跟/升/降/固定/手持+速度）、台词/旁白、音效/配乐、转场方式、情绪关键词
-【专业约束】总时长须与创意大纲一致；景别遵循"远→近→远"呼吸节奏，避免连续 3 个以上相同景别；镜头运动静动交替；画面连贯衔接无割裂感
-【质量标准】画面描述必须精确具体，包含主体/背景/道具/光线方向/色调氛围，禁止模糊笼统；完整参照创意大纲的核心信息和情绪弧线

## 本仓输出约定（必须遵守）
- 表头必须使用下列中文列名，且顺序一致：镜号、时长、景别、画面描述、关键视觉、场景、场景描述、道具、道具描述、主体动作、人物站位、镜头运动、台词/旁白、音效/配乐、转场方式、情绪关键词
- 输出 Markdown 表格；也可以改输出一个 JSON 对象：{"title":"标题","rows":[{…}]}，键名用上表列名对应的英文（shot_no / duration / shot / visual_description / key_visual / scene / scene_description / prop / prop_description / character_action / blocking / camera_movement / dialogue / sound / transition / emotion）
- 镜号用 1、2、3 这样的整数（不要写 S01）；时长用整数秒（不要写 3.5秒）
- 同一场景 / 同一道具在多镜里复用完全一致的名字；人物站位（blocking）写清谁在画面左 / 右 / 前 / 后景、朝向与彼此远近，并保持与上一镜一致（人物确实移动时才改）
- 某一格没有内容时写 \`无\``;

const STORY_SCRIPT_STORYBOARD_COMMON_RULES = [
    "输出必须是一张表格，一镜一行，列名与顺序严格按：镜号、时长、景别、画面描述、关键视觉、场景、场景描述、道具、道具描述、主体动作、人物站位、镜头运动、台词/旁白、音效/配乐、转场方式、情绪关键词。",
    "如果用户给了额外要求，也必须一起遵守。",
    "总时长须与创意大纲一致；景别遵循「远→近→远」呼吸节奏，避免连续 3 个以上相同景别。",
    "镜头运动要静动交替，并写清推/拉/摇/移/跟/升/降/固定/手持以及速度。",
    "画面连贯衔接，无割裂感。",
    "画面描述必须精确具体，包含主体/背景/道具/光线方向/色调氛围，且要精确到可直接作为图片生成 prompt。",
    "同一场景 / 同一道具在多镜里复用完全一致的名字；人物站位要写清谁在画面左 / 右 / 前 / 后景、朝向与彼此远近，并保持与上一镜一致（人物确实移动时才改）。",
    "缺失内容写 `无`。",
];

/**
 * 「每段时长」要求：视频模型按 10s / 15s 成片，所以要求模型把连续若干镜的秒数控制在目标长度以内，
 * 便于铺链路时把它们合并成一个视频节点。不指定（none）时不加任何约束，保持原行为。
 */
function buildSegmentDurationGuidance(segmentSeconds?: unknown): string {
    const value = storyScriptSegmentSecondsValue(segmentSeconds);
    if (!value) return "";
    return [
        "## 分段时长要求",
        `- 本次目标成片长度约为每段 ${value} 秒。`,
        `- \`duration\` 仍填该镜的实际秒数（整数），但请让连续若干镜的秒数相加约为 ${value} 秒，方便合成一段完整视频。`,
        `- 单镜尽量落在 2-${Math.max(3, Math.round(value / 2))} 秒之间，不要写成一个大超长镜头。`,
        `- \`video_motion_prompt\` 里的 \`[时长：Xs]\` 不要超过 ${value} 秒。`,
    ].join("\n");
}

/** 构建分镜脚本生成任务（classic 对应 dramaclaw 的 build_freezone_story_script_task）。 */
function buildClassicStoryScriptTask({ sourceText, prompt, characterRefs, segmentSeconds }: { sourceText: string; prompt?: string; characterRefs?: string; segmentSeconds?: unknown }): string {
    const parts = ["根据以下上传剧本内容生成一个完整的故事脚本表。", ...STORY_SCRIPT_COMMON_RULES];
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    if (characterRefs && characterRefs.trim()) {
        parts.push(`已提供的角色参考（请在角色1 / 角色2 字段里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    }
    const segmentGuidance = buildSegmentDurationGuidance(segmentSeconds);
    if (segmentGuidance) parts.push(segmentGuidance);
    parts.push(STORY_SCRIPT_STYLE_HINT);
    parts.push(STORY_SCRIPT_JSON_CONTRACT);
    parts.push(`源剧本内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/** 构建「视频分镜脚本」任务。首句即 recipe 的 `planning_prompt` 原文（说明这一节点要产出什么）。 */
function buildStoryboardTask({ sourceText, prompt, characterRefs, segmentSeconds }: { sourceText: string; prompt?: string; characterRefs?: string; segmentSeconds?: unknown }): string {
    const parts = ["根据创意大纲直接生成含镜号、画面、运镜和转场的分镜脚本表格。", ...STORY_SCRIPT_STORYBOARD_COMMON_RULES];
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    if (characterRefs && characterRefs.trim()) {
        parts.push(`已提供的角色参考（请在画面描述 / 关键视觉 / 主体动作里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    }
    const segmentGuidance = buildSegmentDurationGuidance(segmentSeconds);
    if (segmentGuidance) parts.push(segmentGuidance);
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
function buildClassicRowTask({ sourceText, prompt, row, prev, next, characterRefs }: StoryScriptRowTaskInput): string {
    const columns = STORY_SCRIPT_CLASSIC_COLUMNS;
    const parts = [`下面是一张分镜表的第 ${row.shot_no} 镜。请**只重新生成这一镜**（镜号保持 ${row.shot_no} 不变），其余镜头不要输出。`, ...STORY_SCRIPT_COMMON_RULES];
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    const prevText = describeRowForContext(prev, columns);
    if (prevText) parts.push(`上一镜（第 ${prev?.shot_no} 镜，人物站位 / 场景 / 道具必须与它衔接）：\n${prevText}`);
    const nextText = describeRowForContext(next, columns);
    if (nextText) parts.push(`下一镜（第 ${next?.shot_no} 镜，这一镜不要和它冲突）：\n${nextText}`);
    const currentText = describeRowForContext(row, columns);
    if (currentText) parts.push(`这一镜当前的内容（可以全部重写，也可以只修掉不合理或缺失的字段）：\n${currentText}`);
    if (characterRefs && characterRefs.trim()) parts.push(`已提供的角色参考（请在角色1 / 角色2 字段里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    parts.push(STORY_SCRIPT_STYLE_HINT);
    parts.push(STORY_SCRIPT_JSON_CONTRACT);
    parts.push(`只输出这一镜：JSON 的 rows 数组里只放 1 个元素，\`shot_no\` 必须是 ${row.shot_no}。`);
    if (sourceText.trim()) parts.push(`源剧本内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/** 「只重写某一镜」的任务书（视频分镜脚本预设）。 */
function buildStoryboardRowTask({ sourceText, prompt, row, prev, next, characterRefs }: StoryScriptRowTaskInput): string {
    const columns = STORY_SCRIPT_STORYBOARD_COLUMNS;
    const parts = [`下面是一张分镜表的第 ${row.shot_no} 镜。请只重新生成这一镜（镜号保持 ${row.shot_no} 不变），其余镜头不要输出。`, ...STORY_SCRIPT_STORYBOARD_COMMON_RULES];
    if (prompt && prompt.trim()) parts.push(`用户要求：\n${prompt.trim()}`);
    const prevText = describeRowForContext(prev, columns);
    if (prevText) parts.push(`上一镜（第 ${prev?.shot_no} 镜，场景 / 道具 / 人物站位必须与它衔接）：\n${prevText}`);
    const nextText = describeRowForContext(next, columns);
    if (nextText) parts.push(`下一镜（第 ${next?.shot_no} 镜，这一镜不要和它冲突）：\n${nextText}`);
    const currentText = describeRowForContext(row, columns);
    if (currentText) parts.push(`这一镜当前的内容（可以全部重写，也可以只修掉不合理或缺失的字段）：\n${currentText}`);
    if (characterRefs && characterRefs.trim()) parts.push(`已提供的角色参考（请在画面描述 / 关键视觉 / 主体动作里使用完全一致的角色名）：\n${characterRefs.trim()}`);
    parts.push(`只输出这一镜：Markdown 表格只保留表头 + 这 1 行；若用 JSON，rows 里只放 1 个元素，\`shot_no\` 必须是 ${row.shot_no}。`);
    if (sourceText.trim()) parts.push(`创意大纲 / 源内容：\n${sourceText.trim()}`);
    return parts.join("\n\n");
}

/**
 * 经典预设：`shot_prompt` / `video_motion_prompt` 本身已是成段的完整提示词（8 段 / 6 段），
 * 有就直接用；模型偶尔漏列，此时用可见描述兜底拼一条，避免这一行铺不出链路。
 */
function buildClassicShotPrompts(row: StoryScriptRow): StoryScriptShotPrompts {
    return {
        imagePrompt:
            storyScriptCellText(row.shot_prompt) ||
            joinStoryScriptPromptParts([row.visual_description, row.shot, row.emotion, row.scene_tags, row.lighting_mood]),
        videoPrompt:
            storyScriptCellText(row.video_motion_prompt) ||
            joinStoryScriptPromptParts([row.character_action, row.visual_description, row.shot, row.emotion]),
    };
}

/** 视频分镜脚本预设：没有独立的「生成提示词」列，按 recipe 对该列的语义（可直接当 prompt）现拼。 */
function buildStoryboardShotPrompts(row: StoryScriptRow): StoryScriptShotPrompts {
    return {
        imagePrompt: joinStoryScriptPromptParts([row.visual_description, row.key_visual]),
        videoPrompt: joinStoryScriptPromptParts([row.camera_movement, row.character_action, row.visual_description, row.emotion]),
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
export function resolveScriptSystemPrompt(preset?: StoryScriptPresetId | string | null, override?: unknown): string {
    const custom = typeof override === "string" ? override.trim() : "";
    return custom || getStoryScriptSystemPrompt(preset);
}

/** 该节点是否用的是自定义系统提示词（供 UI 打「已自定义」角标）。 */
export function hasScriptSystemPromptOverride(override?: unknown): boolean {
    return typeof override === "string" && override.trim().length > 0;
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

/** 「每段时长」：视频模型按 10s / 15s 成片，这里同时决定生成时的分段要求与铺链路时的自动合并长度。 */
export type StoryScriptSegmentSeconds = "none" | "10" | "15";
export const STORY_SCRIPT_SEGMENT_SECONDS: StoryScriptSegmentSeconds[] = ["none", "10", "15"];

export function resolveStoryScriptSegmentSeconds(value: unknown): StoryScriptSegmentSeconds {
    return STORY_SCRIPT_SEGMENT_SECONDS.includes(value as StoryScriptSegmentSeconds) ? (value as StoryScriptSegmentSeconds) : "none";
}

/** 取「每段时长」的数值；不指定时返回 0。 */
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
 * 默认 13px 时各 `em` 值还原成改造前的像素值（12px → 0.923em 等），视觉零变化。
 */
export const STORY_SCRIPT_FONT_SIZES: number[] = [11, 12, 13, 14, 16, 18, 20];
export const DEFAULT_STORY_SCRIPT_FONT_SIZE = 13;

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
 * 把多个镜头合并成一个视频节点的提示词：逐镜列出（分镜提示词 + 视频运动提示词）。
 *
 * 与 `buildVideoNodePrompt` 的差别：单镜内部按行去重，但**镜与镜之间不去重**——不同镜头合法地
 * 复用同一句动作描述时，去重会丢掉先后顺序。只剩一个镜有内容时等价于 `buildVideoNodePrompt`
 * （不加「多镜头」抬头，也不挂镜号）。
 */
export function buildMergedVideoNodePrompt(shots: Array<{ shotNo?: number; imagePrompt?: unknown; videoPrompt?: unknown }>): string {
    const kept = shots
        .map((shot, index) => ({ no: shot.shotNo || index + 1, body: buildVideoNodePrompt(shot.imagePrompt, shot.videoPrompt) }))
        .filter((item) => Boolean(item.body));
    if (!kept.length) return "";
    if (kept.length === 1) return kept[0].body;
    return [`多镜头连续片段（共 ${kept.length} 镜）：`, ...kept.map((item) => `第${item.no}镜\n${item.body}`)].join("\n\n");
}

/**
 * 一行分镜该连哪些上游素材图。
 * - 预设没有 `assetKeys`（如 storyboard）→ 不区分角色，全部素材图都连；
 * - 有 `assetKeys` → 用这些列的值与素材标题做宽松匹配（去掉空格/下划线/标点后双向包含）；
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
    const normalize = (value: string) => value.replace(/[\s_\-·、,，。.]/g, "").toLowerCase();
    const targets = names.map(normalize).filter(Boolean);
    const matched = assets.filter((asset) => {
        const title = normalize(asset.title);
        if (!title) return false;
        return targets.some((target) => title.includes(target) || target.includes(title));
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

/** `"镜号:列key"` 解回两部分；键非法（镜号不合法 / 列不是资产列）返回 `null`。 */
export function parseScriptCellAssetKey(key: unknown): { shotNo: number; columnKey: string } | null {
    if (typeof key !== "string") return null;
    const index = key.indexOf(":");
    if (index <= 0) return null;
    const no = Number(key.slice(0, index));
    const columnKey = key.slice(index + 1);
    if (!Number.isFinite(no) || no <= 0 || !isScriptAssetColumn(columnKey)) return null;
    return { shotNo: Math.round(no), columnKey };
}

/** 归一化成 map 的键；非法值返回空串（调用方按「没有关联」处理）。 */
function cellAssetMapKey(shotNo: unknown, columnKey: unknown): string {
    const no = Number(shotNo);
    if (!Number.isFinite(no) || no <= 0) return "";
    if (!isScriptAssetColumn(columnKey)) return "";
    return `${Math.round(no)}:${String(columnKey)}`;
}

/** 读某镜某资产列绑定的图片节点 id（容错：值不是数组、或夹了非字符串项，都就地过滤掉）。 */
export function scriptCellAssetIds(map: unknown, shotNo: unknown, columnKey: unknown): string[] {
    const key = cellAssetMapKey(shotNo, columnKey);
    if (!key) return [];
    const value = map && typeof map === "object" ? (map as Record<string, unknown>)[key] : undefined;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

/**
 * 写某镜某资产列绑定的图片节点 id，返回**新的 map**（纯函数，便于探针直接校验）。
 * 传空数组等价于删掉这个键——免得 metadata 里堆一堆空数组。
 */
export function setStoryScriptCellAssetIds(map: unknown, shotNo: unknown, columnKey: unknown, ids: readonly unknown[]): StoryScriptCellAssetMap {
    const next: StoryScriptCellAssetMap = { ...(map && typeof map === "object" ? (map as StoryScriptCellAssetMap) : {}) };
    const key = cellAssetMapKey(shotNo, columnKey);
    if (!key) return next;
    const cleaned = Array.from(new Set(ids.filter((item): item is string => typeof item === "string" && Boolean(item))));
    if (cleaned.length) next[key] = cleaned;
    else delete next[key];
    return next;
}

/** 统一把 map 收成「键是 `镜号:资产列`、值是去重后的非空 id 数组」，顺带丢掉空条目与非法键。 */
export function normalizeStoryScriptCellAssetMap(map: unknown): StoryScriptCellAssetMap {
    const source = map && typeof map === "object" ? (map as Record<string, unknown>) : {};
    const next: StoryScriptCellAssetMap = {};
    for (const [key, value] of Object.entries(source)) {
        const parsed = parseScriptCellAssetKey(key);
        if (!parsed || !Array.isArray(value)) continue;
        const cleaned = Array.from(new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item))));
        if (cleaned.length) next[`${parsed.shotNo}:${parsed.columnKey}`] = cleaned;
    }
    return next;
}

/** 删掉第 `deletedShotNo` 镜之后把键里的镜号整体前移一位（理由同 `shiftStoryScriptRowAssetsAfterDelete`）。 */
export function shiftStoryScriptCellAssetsAfterDelete(map: unknown, deletedShotNo: unknown): StoryScriptCellAssetMap {
    const normalized = normalizeStoryScriptCellAssetMap(map);
    const deleted = Number(deletedShotNo);
    if (!Number.isFinite(deleted) || deleted <= 0) return normalized;
    const next: StoryScriptCellAssetMap = {};
    for (const [key, ids] of Object.entries(normalized)) {
        const parsed = parseScriptCellAssetKey(key);
        if (!parsed || parsed.shotNo === deleted) continue;
        next[`${parsed.shotNo > deleted ? parsed.shotNo - 1 : parsed.shotNo}:${parsed.columnKey}`] = ids;
    }
    return next;
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
): Array<{ columnKey: string; role: ScriptAssetRole; ids: string[] }> {
    const ordered = preset ? getStoryScriptAssetColumns(preset).map((column) => column.key) : Object.keys(SCRIPT_ASSET_COLUMN_SPECS);
    const allowed = new Set(ordered);
    const target = Math.round(Number(shotNo));
    const out: Array<{ columnKey: string; role: ScriptAssetRole; ids: string[] }> = [];
    // 按列序输出（而不是 map 的插入序），这样铺链路连线的先后与表格里从左到右一致。
    for (const columnKey of ordered) {
        if (!allowed.has(columnKey)) continue;
        const ids = scriptCellAssetIds(map, target, columnKey);
        if (!ids.length) continue;
        out.push({ columnKey, role: scriptAssetColumnRole(columnKey) || "character", ids });
    }
    return out;
}

/**
 * 把某一镜「已用单元格图位精准指定过」的资产列的**名字值清空**，返回一行副本。
 *
 * 铺链路时拿它去喂 `matchStoryScriptRowAssets`：例如第 3 镜的「场景」格已经挂了图，
 * 这一镜就只剩「还没指定的角色列」参与资产条匹配，资产条里的场景素材不会再糊到这一镜上。
 */
export function blankFilledAssetColumns(map: unknown, shotNo: unknown, row: StoryScriptRow, preset?: StoryScriptPresetId | string | null): StoryScriptRow {
    const slots = scriptShotCellAssetSlots(map, shotNo, preset);
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
export function syncStoryScriptNameLocks(map: unknown, cells: unknown, rows?: readonly StoryScriptRow[] | null): StoryScriptNameLockMap {
    let next = normalizeStoryScriptNameLockMap(map);
    if (!rows?.length || !cells || typeof cells !== "object" || Array.isArray(cells)) return next;
    const byShot = new Map<number, StoryScriptRow>();
    rows.forEach((row, index) => {
        const shotNo = Math.round(Number(row.shot_no)) || index + 1;
        if (!byShot.has(shotNo)) byShot.set(shotNo, row);
    });
    for (const [key, value] of Object.entries(cells as Record<string, unknown>)) {
        const parsed = parseScriptCellAssetKey(key);
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
): Array<{ columnKey: string; role: ScriptAssetRole; name: string; ids: string[]; source: "cell" | "lock" }> {
    if (!row) return [];
    const out: Array<{ columnKey: string; role: ScriptAssetRole; name: string; ids: string[]; source: "cell" | "lock" }> = [];
    for (const column of getStoryScriptAssetColumns(preset)) {
        const role = scriptAssetColumnRole(column.key) || "character";
        const name = scriptNameLockName(row[column.key]);
        const cellIds = scriptCellAssetIds(cells, shotNo, column.key);
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

/** 某一列是不是资产列（角色1 / 角色2 / 场景 / 道具 / 人物站位）。 */
export function isScriptAssetColumn(key: unknown): boolean {
    return typeof key === "string" && Boolean(SCRIPT_ASSET_COLUMN_SPECS[key]);
}

/** 资产列对应的资产分类；不是资产列（或非字符串）返回 `null`。 */
export function scriptAssetColumnRole(key: unknown): ScriptAssetRole | null {
    return (typeof key === "string" ? SCRIPT_ASSET_COLUMN_SPECS[key]?.role : undefined) ?? null;
}

/** 当前预设下真正存在的资产列（按预设列顺序），供表格渲染图位用。 */
export function getStoryScriptAssetColumns(preset?: StoryScriptPresetId | string | null): StoryScriptColumn[] {
    return getStoryScriptColumns(preset).filter((column) => isScriptAssetColumn(column.key));
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
 * 按「标题 + 描述」去重并保留首次出现顺序（同一角色在多镜里重复出现只留一条）。
 */
export function collectScriptAssetPromptCandidates(role: unknown, rows?: readonly StoryScriptRow[] | null): ScriptAssetPromptCandidate[] {
    const specs = SCRIPT_ASSET_DESCRIPTION_COLUMNS[resolveScriptAssetRole(role)];
    if (!specs.length || !rows?.length) return [];
    const out: ScriptAssetPromptCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        for (const spec of specs) {
            const name = spec.nameKey ? storyScriptCellText(row[spec.nameKey]) : "";
            const text = joinStoryScriptPromptParts(spec.textKeys.map((key) => storyScriptCellText(row[key])));
            const title = name || text.slice(0, 24);
            const prompt = text || name;
            if (!title || !prompt) continue;
            const dedupe = `${title}\u0000${prompt}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
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
export function collectScriptCellPromptCandidate(columnKey: unknown, row?: StoryScriptRow | null): ScriptAssetPromptCandidate | null {
    const spec = typeof columnKey === "string" ? SCRIPT_ASSET_COLUMN_SPECS[columnKey] : undefined;
    if (!spec || !row) return null;
    const name = spec.nameKey ? storyScriptCellText(row[spec.nameKey]) : "";
    const text = joinStoryScriptPromptParts(spec.textKeys.map((key) => storyScriptCellText(row[key])));
    const title = name || text.slice(0, 24);
    const prompt = text || name;
    if (!title || !prompt) return null;
    return { title, prompt };
}

/** 构建分镜脚本生成任务；不传 preset 时保持旧行为（classic）。 */
export function buildStoryScriptTask({
    sourceText,
    prompt,
    characterRefs,
    preset,
    segmentSeconds,
}: {
    sourceText: string;
    prompt?: string;
    characterRefs?: string;
    preset?: StoryScriptPresetId | string | null;
    segmentSeconds?: unknown;
}): string {
    return getStoryScriptPreset(preset).buildTask({ sourceText, prompt, characterRefs, segmentSeconds });
}

/** 构建「只重写某一镜」的任务书；不传 preset 时保持 classic。 */
export function buildStoryScriptRowTask({ preset, ...input }: StoryScriptRowTaskInput & { preset?: StoryScriptPresetId | string | null }): string {
    return getStoryScriptPreset(preset).buildRowTask(input);
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
 * 视频节点最终的提示词 = 分镜提示词（画面/角色/环境）+ 视频运动提示词（运镜/动作/时长）。
 *
 * 生视频时只给运镜段会丢掉画面信息，所以把两段都写进视频节点；按**行**去重（两段可能共享
 * 同一句画面描述，例如经典预设的兜底路径），避免同一句出现两遍。分镜提示词在前、运镜在后。
 */
export function buildVideoNodePrompt(imagePrompt: unknown, videoPrompt: unknown): string {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const part of [storyScriptCellText(imagePrompt), storyScriptCellText(videoPrompt)]) {
        if (!part) continue;
        for (const rawLine of part.split("\n")) {
            const line = rawLine.trim();
            if (!line || seen.has(line)) continue;
            seen.add(line);
            lines.push(line);
        }
    }
    return lines.join("\n");
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
