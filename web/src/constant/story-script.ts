/**
 * 脚本生成器（分镜脚本表）常量层。**预设驱动**：同一套解析 / 导出 / 表格渲染，
 * 换预设即换「系统提示词 + 输出列 + 行操作」。
 *
 * - `classic`（经典·16 列）：移植自剧集画布（dramaclaw）`src/novelvideo/freezone/text_node.py`
 *   的 `FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT` 与 `build_freezone_story_script_task`。
 *   剧集画布那张表有 19 列，其中 `character_image_1` / `character_image_2` / `reference`
 *   三个素材 URL 槽位由后端按角色名回填、`keyframe_index` 只在「视频参考」模式使用。开源
 *   画布没有这套后端回填机制、也没有视频抽帧入口，因此只保留 16 个真正由模型产出、且对
 *   本仓生图 / 生视频链路有用的列。
 *
 * - `storyboard`（视频分镜脚本·11 列）：移植自剧集画布 `agent_catalog/builtins/recipes/
 *   video-storyboard-script.json` 的 `system_prompt`（原文照搬）。
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

/** 经典 16 列（与剧集画布 text_node.py 同源）。 */
export const STORY_SCRIPT_CLASSIC_COLUMNS: StoryScriptColumn[] = [
    { key: "shot_no", label: "镜号", width: 56, numeric: true },
    { key: "duration", label: "时长", width: 60, numeric: true },
    { key: "visual_description", label: "画面描述", width: 210 },
    { key: "character_1", label: "角色1", width: 100 },
    { key: "character_description_1", label: "角色描述1", width: 260 },
    { key: "character_2", label: "角色2", width: 100 },
    { key: "character_description_2", label: "角色描述2", width: 260 },
    { key: "shot", label: "景别", width: 120 },
    { key: "character_action", label: "角色动作", width: 190 },
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

/** 「视频分镜脚本」11 列（列名与顺序严格照 recipe 的【输出格式要求】）。 */
export const STORY_SCRIPT_STORYBOARD_COLUMNS: StoryScriptColumn[] = [
    { key: "shot_no", label: "镜号", width: 56, numeric: true },
    { key: "duration", label: "时长", width: 60, numeric: true },
    { key: "shot", label: "景别", width: 110 },
    { key: "visual_description", label: "画面描述", width: 300 },
    { key: "key_visual", label: "关键视觉", width: 220 },
    { key: "character_action", label: "主体动作", width: 200 },
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
7. Output only structured data matching the schema. Do not wrap with markdown.

## Table style target
- The result should resemble a production storyboard table, not a prose summary.
- \`visual_description\` should describe one clear beat of action or state, usually in one concise sentence.
- \`shot\` should use concise combinations like \`近景 / 特写\`, \`中景 / 仰视\`, \`全景 / 俯视远景\`.
- \`emotion\` should be compact and specific, often 2-3 short phrases joined by \`、\`.
- \`scene_tags\`, \`lighting_mood\`, \`sound\` should all be concrete and film-facing.
- \`character_1\` should prefer a stable role identifier if inferable, such as \`沈昭昭_现代\` or \`沈昭昭_古装\`.
- \`character_description_1\` should prefer bracketed character-card format, e.g. \`[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装……]\`.

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
- The same character must never switch names or appearance between consecutive shots.`;

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
      "shot": "…",
      "character_action": "…",
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
    "输出字段必须覆盖：镜号、时长、画面描述、角色1、角色描述1、角色2、角色描述2、景别、角色动作、情绪、场景标签、光影氛围、音效、对白、分镜提示词、视频运动提示词。",
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
- 表头必须使用下列中文列名，且顺序一致：镜号、时长、景别、画面描述、关键视觉、主体动作、镜头运动、台词/旁白、音效/配乐、转场方式、情绪关键词
- 输出 Markdown 表格；也可以改输出一个 JSON 对象：{"title":"标题","rows":[{…}]}，键名用上表列名对应的英文（shot_no / duration / shot / visual_description / key_visual / character_action / camera_movement / dialogue / sound / transition / emotion）
- 镜号用 1、2、3 这样的整数（不要写 S01）；时长用整数秒（不要写 3.5秒）
- 某一格没有内容时写 \`无\``;

const STORY_SCRIPT_STORYBOARD_COMMON_RULES = [
    "输出必须是一张表格，一镜一行，列名与顺序严格按：镜号、时长、景别、画面描述、关键视觉、主体动作、镜头运动、台词/旁白、音效/配乐、转场方式、情绪关键词。",
    "如果用户给了额外要求，也必须一起遵守。",
    "总时长须与创意大纲一致；景别遵循「远→近→远」呼吸节奏，避免连续 3 个以上相同景别。",
    "镜头运动要静动交替，并写清推/拉/摇/移/跟/升/降/固定/手持以及速度。",
    "画面连贯衔接，无割裂感。",
    "画面描述必须精确具体，包含主体/背景/道具/光线方向/色调氛围，且要精确到可直接作为图片生成 prompt。",
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

/** 铺链路时可挂到某一镜上的素材（只需要 id + 标题）。 */
export type StoryScriptAssetRef = { id: string; title: string };

/**
 * 脚本节点上游「资产」的分类。分类决定铺链路时这张图会连到哪些镜头上：
 *  - character 角色：按分镜里的角色名逐镜匹配（沿用 `matchStoryScriptRowAssets`）；
 *  - scene / prop / blocking 场景 / 道具 / 站位图：与具体某个人物无关，对每一镜都成立，逐镜全连。
 */
export type ScriptAssetRole = "character" | "scene" | "prop" | "blocking";

export const SCRIPT_ASSET_ROLE_IDS: ScriptAssetRole[] = ["character", "scene", "prop", "blocking"];

/** 分类 id 归一化：未知值一律回落到 character（等同旧行为——没分类的素材按角色处理）。 */
export function resolveScriptAssetRole(value: unknown): ScriptAssetRole {
    return SCRIPT_ASSET_ROLE_IDS.includes(value as ScriptAssetRole) ? (value as ScriptAssetRole) : "character";
}

/** 点击分类胶囊时的轮转顺序：角色 → 场景 → 道具 → 站位图 → 角色。 */
export function nextScriptAssetRole(current: unknown): ScriptAssetRole {
    const index = SCRIPT_ASSET_ROLE_IDS.indexOf(resolveScriptAssetRole(current));
    return SCRIPT_ASSET_ROLE_IDS[(index + 1) % SCRIPT_ASSET_ROLE_IDS.length];
}

/** 角色分类之外的素材（场景 / 道具 / 站位图）铺链路时连到每一镜。 */
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
