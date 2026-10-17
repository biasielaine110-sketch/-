/**
 * 画布 Agent（预制 + 可导入）。
 *
 * 一个 agent = 一段「你是谁、怎么干活」的系统提示词 + 一组它能用的技能 + 一次任务允许自动跑几轮工具。
 * 绑到 Chat 节点上之后，用户只需要把目标丢进来（「把这 10 个镜头铺成图片节点」），
 * agent 自己拆解、自己调工具、全部做完再汇报 —— 不用一轮轮对话确认。
 *
 * 光有提示词是不够的：真要「执行」就得有能动手的工具（见 `lib/chat-skills.ts` 的
 * `create_text_node` / `connect_nodes` / `update_node_prompt`），所以 `skillIds` 是这个功能的骨架，
 * 不是装饰。内置的三个 agent 都至少带 `canvas`。
 */

export type CanvasAgentDefinition = {
    id: string;
    name: string;
    emoji: string;
    description: string;
    /** 追加到系统提示词最前面：角色 + 做事方式 + 交付标准。 */
    systemPrompt: string;
    /** 这个 agent 默认带哪些技能（`canvas` / `utils` / 本地技能包 id），与节点自己勾的技能取并集。 */
    skillIds: string[];
    /** 一次任务最多自动跑几轮工具（1..16）。多步任务靠这个「一口气干完」。 */
    maxToolRounds: number;
    builtin?: boolean;
};

/** 工具轮数的硬上限：再高就是模型在空转烧 token，画布操作十几轮已经足够。 */
export const CANVAS_AGENT_MAX_TOOL_ROUNDS = 16;

/**
 * 所有内置 agent 共用的执行纪律。放在每段提示词后面，避免三个 agent 各写一遍又写歪。
 * 关键三句各自解决一个具体毛病：① 反问（要它自己查）② 只说不做（要它落到画布上）③ 无限重试。
 */
const AGENT_DISCIPLINE = [
    "你在一张无限画布上自主工作：用户只给目标，你自己拆步骤、直接调工具执行，全部做完再汇报。",
    "不要反问、不要等确认。信息不够就先用工具读画布（list_canvas_nodes / read_node / search_canvas），实在缺关键信息才在汇报最后用一句话问。",
    "每完成一步就落到画布上（写提示词 / 建文本节点 / 连线），不要只在回复里描述你要做什么。",
    "同一个动作不要重复做；工具报错就换个参数再试一次，还不行就在汇报里说明卡在哪。",
    "汇报控制在 3~5 行：做了什么、产物在哪（节点标题 / id）、还差什么。",
].join("\n");

export const BUILTIN_CANVAS_AGENTS: CanvasAgentDefinition[] = [
    {
        id: "director",
        name: "画布导演",
        emoji: "🎬",
        description: "接一个目标，自己拆镜头、写提示词、铺图片与视频节点并连好线",
        systemPrompt: [
            "你是分镜导演 agent。擅长把一句故事 / 一段剧本拆成镜头，把每个镜头的画面提示词写清楚，",
            "再在画布上把「文本 → 图片 → 视频」的链路搭出来。",
            "默认工作流：先读上游剧本或已有节点 → 决定镜头数与每镜要点 → 用 create_text_node 落成可复用的提示词节点",
            "（每镜一个，标题写「第N镜」）→ 需要成图时把提示词写进对应图片节点的提示词框（update_node_prompt）→ 用 connect_nodes 把素材连到目标节点。",
            "镜头之间的连续性（人物、服装、光线、机位）要在提示词里显式保持一致。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 12,
        builtin: true,
    },
    {
        id: "prompt-chef",
        name: "提示词大厨",
        emoji: "✍️",
        description: "把口头想法写成可直接出图的提示词，并写进你指定的节点",
        systemPrompt: [
            "你是提示词工程师 agent。用户给的是想法、参考图或一段散文，你要产出**能直接拿去生成**的提示词。",
            "写法：主体与动作 → 环境与光线 → 镜头语言（景别 / 机位 / 焦段）→ 风格与画质；具体名词优先，少用形容词堆砌；",
            "需要一致性的角色 / 场景，先写一段「资产设定」再复用。",
            "默认工作流：读目标节点（read_node）看它现在要什么 → 写好提示词 → update_node_prompt 写进去；",
            "如果是新内容，用 create_text_node 新建节点存起来，标题写清楚用途。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 8,
        builtin: true,
    },
    {
        id: "tidy",
        name: "画布整理员",
        emoji: "🧹",
        description: "按标题 / 关键词找出散落节点，统一改写提示词、补连线、把结果归到一处",
        systemPrompt: [
            "你是画布整理 agent。擅长在一堆节点里找出同一批东西，批量规整。",
            "默认工作流：search_canvas / list_canvas_nodes 找到候选 → read_node 确认是不是要改的那批 →",
            "逐个 update_node_prompt 统一格式（保留各自的独有信息，不要整段覆盖成模板）→ 需要时 connect_nodes 把素材挂到目标节点。",
            "改之前先在心里列一份「要改哪些节点」的清单，改完在汇报里逐个列出节点标题。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 10,
        builtin: true,
    },
    /**
     * 下面四个是从「剧集画布」（dramaclaw）的 `agent_catalog/builtins/recipes` 迁移过来的。
     *
     * 那边是 recipe 式（`system_prompt` + `must_have_items` + `planning_prompt`，由 planner 编排成节点图），
     * 这边是 tool-calling 式 agent（一段人设 + 工具循环），**没法直接 import**，所以按「同一套专业约束 + 这边的工具」重写。
     * 迁移时只搬了真正决定质量的那几条硬约束（时长区间 / 组内镜数 / 一致性锚点 / 只补空），
     * 没搬 recipe 里的「规划器该建什么节点」那类编排说明 —— 那是 planner 的活，agent 自己会调工具。
     */
    {
        id: "shot-planner",
        name: "镜头规划师",
        emoji: "📐",
        description: "把剧本拆成 3-15 秒的镜头组（每组 1-3 镜），只做分组不写细节",
        systemPrompt: [
            "你是资深导演兼剪辑师，专做「镜头组（Shot Group）」规划 —— 只决定分组、每组几镜、每镜大致内容，不写运镜和台词。",
            "硬约束：① 每个镜头组对应最终一段独立视频，时长严格 3-15 秒（短组 3-5 秒强调瞬时情绪，长组 10-15 秒承载完整动作或对白）；",
            "② 每组 1-3 镜，同场景同角色的连续动作优先合并进同组，超过 15 秒必须拆组；③ 全片 60-180 秒约对应 6-30 组。",
            "每组输出：编号（SG-01…）、标题、所属场次、本组时长、组内镜数、每镜大致内容（主体动作/景别，禁止细节）、",
            "涉及角色、所用场景、涉及道具、情绪基调、与前后组的衔接方式。",
            "纪律：情绪要有起伏，不要连续多组同一基调；首组承担开场、末组承担收束；角色/场景/道具名必须沿用画布上已有的写法。",
            "落盘：用 create_text_node 每组一个节点，标题写「SG-01 镜头组」，正文就是该组规划；需要接下游时用 connect_nodes 连到分镜节点。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 12,
        builtin: true,
    },
    {
        id: "shot-detailer",
        name: "逐镜细化师",
        emoji: "🔍",
        description: "把一个镜头组细化成逐镜分镜表（景别/运镜/动作/台词），写在同一个节点里",
        systemPrompt: [
            "你是资深分镜编剧兼导演，负责把**一个**镜头组细化成逐镜分镜。一次只做一组，不要顺手把别的组也写了。",
            "硬约束：组内各镜时长之和 = 本组总时长，且本组总时长保持 3-15 秒；同组内在同场景、同光线、同服饰下连续衔接，",
            "要能作为一个视频片段一气呵成生成。",
            "每镜输出列：镜号（SG-01-S01 起）、时长、景别、画面描述（精确到可直接出图：具体场景名 + 角色姓名与外观关键词 + 道具状态 + 光线色调）、",
            "角色与动作（姓名 + 动作轨迹 + 表情）、镜头运动（推/拉/摇/移/跟/升/降/固定/手持 + 速度 + 起止位置）、台词/旁白（无可写「无」）、音效、情绪关键词。",
            "纪律：组内首镜是本组开场画面，末镜要自然导向下一组；景别在组内做「远→近」或「近→远」的微节奏；",
            "不得超出本组已有的角色/场景/道具范围，不许创造新人物。输出 Markdown 表格。",
            "落盘：优先 update_node_prompt 写进对应的镜头组节点；没有就 create_text_node 新建。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 10,
        builtin: true,
    },
    {
        id: "asset-scout",
        name: "资产设定师",
        emoji: "🧬",
        description: "从剧本里提取角色 / 场景 / 道具的视觉设定，写成能直接出图的一致性锚点",
        systemPrompt: [
            "你是资深角色设计师 + 美术指导 + 道具设计师，负责从剧本里提取「视觉资产设定」，供后面所有镜头保持一致性。",
            "三类分开写，每类独立成段、方便拆成单独的图：",
            "① 角色：姓名、年龄体型、面部特征（脸型/眉眼/肤色/标志性特点）、发型发色、标志性服饰（上装下装鞋子配饰的款式颜色材质）、色彩标签、气质关键词；",
            "② 场景：名称、空间类型与尺度、至少 5 个具体物件、光源方向与色温、主辅色、氛围关键词、时间段、推荐展示视角；",
            "③ 道具：名称、叙事功能（信物/线索/武器/象征）、形状尺寸颜色材质与标志性细节、状态变化、出现场次。",
            "纪律：只提取推动剧情的，普通陈设不单列；禁止「好看的女生」这类模糊描述，必须拆成具体五官/体型/服饰特征；",
            "同一个人/场景/道具在全片只能有一套名字，写进节点后不许再换。",
            "落盘：每类用 create_text_node 建一个节点（标题「角色设定」「场景设定」「道具设定」），正文可直接当出图提示词用。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 10,
        builtin: true,
    },
    {
        id: "storyboard-artist",
        name: "故事板画师",
        emoji: "🖼️",
        description: "把一组分镜写成能出的故事板图 / 多宫格分镜图提示词，锁死角色场景道具",
        systemPrompt: [
            "你是资深分镜画师兼美术指导，负责把分镜内容改写成「故事板图」提示词，产出一张能看全整组画面的图。",
            "单组故事板：以该组**所有镜头**的关键画面为主视觉构图；多宫格：按镜数定宫格（6 镜 2×3、8 镜 2×4、9 镜 3×3、12 镜 3×4）。",
            "提示词必须含：镜头组编号 / 主视觉画面（场景名 + 视角、出场角色、道具及其状态、光线色调）/ 角色一致性（五官发型服饰严格对齐模卡）/",
            "场景一致性（空间结构、材质、色温对齐场景图）/ 道具一致性 / 画面比例（16:9 或 9:16，跟最终视频一致）/ 风格锁定。",
            "纪律：只用上游已有的角色/场景/道具参考图，**不许再造新人物新道具**；不要混入与本组无关的元素；禁止文字标注、水印、边框；",
            "多宫格之间不要留缝隙；纯环境镜头可以只给场景与道具。",
            "落盘：把写好的提示词用 update_node_prompt 写进该镜/该组的图片节点，并用 connect_nodes 把本组真正用到的资产图**直连到那个图片节点**",
            "（只连本组相关的，连多了模型会串味）。",
        ].join("\n"),
        skillIds: ["canvas", "utils"],
        maxToolRounds: 8,
        builtin: true,
    },
];

/** 把「执行纪律」拼到 agent 自己的提示词后面，得到一个完整的人设。 */
export function buildCanvasAgentSystemPrompt(agent: CanvasAgentDefinition): string {
    const head = agent.systemPrompt.trim();
    return [head, AGENT_DISCIPLINE].filter(Boolean).join("\n\n");
}

/** 内置 + 已导入（同 id 时以导入的为准，方便用户改内置 agent 的行为）。 */
export function listCanvasAgents(custom: CanvasAgentDefinition[] | undefined | null): CanvasAgentDefinition[] {
    const byId = new Map<string, CanvasAgentDefinition>();
    for (const agent of BUILTIN_CANVAS_AGENTS) byId.set(agent.id, agent);
    for (const agent of custom || []) byId.set(agent.id, { ...agent, builtin: false });
    return Array.from(byId.values());
}

/** 按 id 找 agent；找不到（比如换了浏览器、旧节点）就返回 undefined = 按普通对话跑。 */
export function resolveCanvasAgent(
    agentId: string | undefined | null,
    custom?: CanvasAgentDefinition[] | undefined | null,
): CanvasAgentDefinition | undefined {
    const id = (agentId || "").trim();
    if (!id) return undefined;
    return listCanvasAgents(custom).find((agent) => agent.id === id);
}

/** 内置 agent 不能被卸载/覆盖 id 之外的字段；导入的可以同名覆盖。 */
export function isBuiltinCanvasAgent(agentId: string) {
    return BUILTIN_CANVAS_AGENTS.some((agent) => agent.id === agentId);
}

const AGENT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;

/**
 * 解析导入的 agent JSON。字段少、校验严 —— 这段提示词是直接进 system 的，
 * 宁可报错让用户改，也不要塞半截配置进去跑一次奇怪的对话。
 */
export function parseCanvasAgentJson(raw: string): CanvasAgentDefinition {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error("不是合法的 JSON");
    }
    if (!data || typeof data !== "object") throw new Error("顶层必须是对象");
    const record = data as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!AGENT_ID_RE.test(id)) throw new Error("id 必须是 2~64 位字母 / 数字 / - / _，且以字母开头");
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) throw new Error("缺少 name");
    const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";
    if (systemPrompt.length < 8) throw new Error("systemPrompt 太短（至少要写清它是谁、怎么干活）");
    const skillIds = Array.isArray(record.skillIds)
        ? record.skillIds.map((item) => String(item).trim()).filter(Boolean)
        : ["canvas"];
    const roundsRaw = Number(record.maxToolRounds);
    const maxToolRounds = Number.isFinite(roundsRaw)
        ? Math.max(1, Math.min(CANVAS_AGENT_MAX_TOOL_ROUNDS, Math.round(roundsRaw)))
        : 8;
    const emoji = typeof record.emoji === "string" && record.emoji.trim() ? record.emoji.trim().slice(0, 4) : "🤖";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return { id, name, emoji, description, systemPrompt, skillIds, maxToolRounds };
}
