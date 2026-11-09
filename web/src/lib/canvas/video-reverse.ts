/**
 * 「反推视频」命令集合的纯逻辑：挑技能 + 拼提示词。
 *
 * 为什么单独抽出来：
 *  ① 技能是**用户自己装的**（本地技能包 / 文档技能），id 是 nanoid，名字还可能被备注名覆盖，
 *     所以只能按「名字像不像」去挑，且**挑不到必须硬失败**——静默不带技能跑，模型会自由发挥，用户还以为反推过了。
 *  ② 三个命令只有「要不要特殊要求 / 要不要接着跑一键视频」的差别，提示词口径写在一处才不会漂。
 */

/** 三条命令。数字即用户看到的 01 / 02 / 03。 */
export type VideoReverseMode = 1 | 2 | 3;

export type VideoReverseResult = {
    ok: boolean;
    error?: string;
    chatNodeId?: string;
    textNodeId?: string;
    scriptNodeId?: string;
};

/** 反推用的技能名（按优先级）。用户口径是「视频反推-分镜提示词」。 */
export const VIDEO_REVERSE_SKILL_HINTS = ["视频反推-分镜提示词", "视频反推分镜提示词", "视频反推", "分镜提示词"] as const;

/** 02 / 03 要求框的默认文案（用户口径：自动写入「反推视频并生成同款风格文案」）。 */
export const DEFAULT_VIDEO_REVERSE_REQUIREMENT = "反推视频并生成同款风格文案";

export const VIDEO_REVERSE_MODES = [
    {
        mode: 1 as const,
        no: "01",
        label: "反推视频",
        hint: "视频链接发进 AI 对话 → 用「视频反推-分镜提示词」反推 → 结果写进文本节点",
    },
    {
        mode: 2 as const,
        no: "02",
        label: "反推视频生成同款文案",
        hint: "同 01，先弹窗填特殊要求（默认「反推视频并生成同款风格文案」），输出同款文案",
    },
    {
        mode: 3 as const,
        no: "03",
        label: "反推视频生成同款文案及视频",
        hint: "同 02，再把文本节点接到脚本生成器并执行「一键视频」",
    },
] as const;

export type VideoReverseSkillLike = {
    id: string;
    /** 技能原名 */
    name?: string;
    /** 用户备注名（展示优先） */
    alias?: string;
};

/** 归一化技能名：去掉分隔符 / 括号 / 空白，统一小写，避免「视频反推 - 分镜提示词」这种写法匹配不上。 */
export function normalizeSkillLabel(raw: string | undefined | null) {
    return String(raw || "")
        .toLowerCase()
        .replace(/[\s\-_—–·•/\\（）()【】[\]]+/g, "");
}

/**
 * 在技能库里挑「视频反推-分镜提示词」。
 *
 * 排序：完全同名（2 分）> 名字互相包含（1 分）；同分时按 `hints` 里的先后。
 * 一个都命中不了就返回 `null`——调用方据此告诉用户「技能没装」，绝不静默跑。
 */
export function pickVideoReverseSkill(skills: readonly VideoReverseSkillLike[], hints: readonly string[] = VIDEO_REVERSE_SKILL_HINTS): { id: string; name: string } | null {
    const wanted = hints.map((hint) => normalizeSkillLabel(hint)).filter(Boolean);
    if (!wanted.length) return null;
    let best: { id: string; name: string; rank: number; score: number } | null = null;
    for (const skill of skills || []) {
        if (!skill?.id) continue;
        const labels = [skill.alias, skill.name].map((value) => normalizeSkillLabel(value)).filter((label) => label.length >= 2);
        if (!labels.length) continue;
        for (let rank = 0; rank < wanted.length; rank++) {
            const target = wanted[rank];
            for (const label of labels) {
                const score = label === target ? 2 : label.includes(target) || target.includes(label) ? 1 : 0;
                if (!score) continue;
                const better = !best || score > best.score || (score === best.score && rank < best.rank);
                if (better) {
                    best = { id: skill.id, name: String(skill.alias || skill.name || skill.id), rank, score };
                }
            }
        }
    }
    return best ? { id: best.id, name: best.name } : null;
}

export type VideoReversePromptInput = {
    /** 接入的视频地址（画布视频节点 `metadata.content`） */
    videoUrl?: string;
    mode: VideoReverseMode;
    /** 02 / 03 的特殊要求 */
    requirement?: string;
};

const isRemoteUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * 三条命令（01 / 02 / 03）**共用**一句输出语言硬要求：全文简体中文。
 *
 * 为什么必须写死：模型会跟着视频本身的语言 / 技能模板里的英文示例走，明明是中文需求，反推出来却是
 * 一整段英文分镜提示词，或者中文里夹着英文的「镜头描述」。这条不是「建议」而是硬要求，且三条命令
 * 只留一份文案 —— 三处各写一句必然漂。
 * 专有名词放行（品牌、模型名、影片名），否则「Seedance」这类词会被硬翻成看不懂的中文。
 */
export const VIDEO_REVERSE_LANGUAGE_RULE = "输出语言：全文必须使用简体中文（专有名词 / 品牌 / 模型名可保留原文），不要出现英文句子、英文段落或中英混排的说明。";


/**
 * 发给 AI 对话窗口的那句话。
 *
 * ⚠️ 视频本身是**通过连线**进对话的（`sendChatMessage` 会把它当视频输入：原生 video_url，或抽帧成图片），
 * 文本里的「视频链接」只是给用户和模型一个可读的引用；本地 `blob:` 地址模型打不开，
 * 所以要显式说明「看连线传入的内容」，别让模型去 fetch 一个它拿不到的链接。
 */
export function buildVideoReversePrompt({ videoUrl, mode, requirement }: VideoReversePromptInput): string {
    const lines: string[] = [];
    lines.push(mode === 1 ? "请用「视频反推-分镜提示词」技能反推我接入的这条视频，输出可以直接拿去用的分镜提示词。" : "请用「视频反推-分镜提示词」技能反推我接入的这条视频，并在反推结果的基础上，写一份同款风格的文案。");
    const extra = (requirement || "").trim();
    if (mode !== 1 && extra) lines.push(`特殊要求：${extra}`);
    const url = (videoUrl || "").trim();
    if (isRemoteUrl(url)) lines.push(`视频链接：${url}`);
    else lines.push("视频已通过画布连线接入（本地/临时地址，模型打不开链接），请按连线传入的视频内容反推。");
    lines.push(VIDEO_REVERSE_LANGUAGE_RULE);
    lines.push("只输出结果正文，不要解释你的分析过程，也不要写与结果无关的寒暄。");
    return lines.join("\n");
}
