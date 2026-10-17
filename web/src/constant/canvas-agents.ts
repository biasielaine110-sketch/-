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
