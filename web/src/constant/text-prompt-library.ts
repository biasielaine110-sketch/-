export type TextPromptEntry = {
    id: string;
    title: string;
    content: string;
    /** When false the entry stays in the library but is hidden from the text-node picker. Defaults to true. */
    enabled?: boolean;
};

/** id / title of the built-in prompt-optimizer entry used by the composer button. */
export const H3_PROMPT_OPTIMIZER_ID = "h3-prompt-optimizer";
export const H3_PROMPT_OPTIMIZER_TITLE = "H3-提示词优化";

/** Enabled unless explicitly turned off. Mirrors isChannelModelEnabled (undefined = enabled). */
export function isTextPromptEnabled(entry: Pick<TextPromptEntry, "enabled"> | null | undefined): boolean {
    return entry?.enabled !== false;
}

/** Standalone so the config-store migration and the composer button share one source. */
export const h3PromptOptimizerEntry: TextPromptEntry = {
    id: H3_PROMPT_OPTIMIZER_ID,
    title: H3_PROMPT_OPTIMIZER_TITLE,
    content:
        "你是一名专业的 AI 生图/生视频提示词优化专家。请将用户输入的描述优化为一条高质量的提示词：严格保留用户的核心意图、主体与关键需求不变；补充主体外观与细节、环境场景与构图、光影氛围、镜头视角、艺术风格与质感等维度，使画面信息完整具体；语言精炼自然，可直接使用；不新增与画面无关的要求，不输出任何解释、前缀、引号或多余格式，只输出优化后的提示词本身。",
};

/** Resolve the H3 optimizer instruction: prefer the user's 词库 entry, fall back to the built-in. */
export function resolveH3PromptOptimizerEntry(textPrompts: TextPromptEntry[]): TextPromptEntry {
    const hit = (textPrompts || []).find((item) => item?.id === H3_PROMPT_OPTIMIZER_ID || item?.title?.trim() === H3_PROMPT_OPTIMIZER_TITLE);
    return hit && hit.content.trim() ? hit : h3PromptOptimizerEntry;
}

// ─────────────────────────── 「违规优化」 ───────────────────────────
/**
 * 「违规优化」词条（用户 2026-11-11 第 01 条）。
 *
 * 用户原话：「添加 违规优化 按钮，调用 词库中的 `--------------提示词---违规优化-------------`
 * 的提示词内容，其使用的文本模型跟着偏好里的模型。」
 *
 * 那条词条是**用户自己在词库面板里建的**（`TextPromptEntry` 存 config.textPrompts，
 * 随「导出配置」一起走），代码里没有它的正文 —— 所以这里只认名字，正文恒取用户词库；
 * 用户没建（或被删）时才回落到下面这条内置文案，按钮不会变成一点就报错的死键。
 */
export const VIOLATION_PROMPT_OPTIMIZER_ID = "violation-prompt-optimizer";
/** 用户词库里的标题原样（前后那串横线是用户自己的写法，不改）。 */
export const VIOLATION_PROMPT_OPTIMIZER_TITLE = "--------------提示词---违规优化-------------";

/** 内置兜底：用户词库没有这条时用它。 */
export const violationPromptOptimizerEntry: TextPromptEntry = {
    id: VIOLATION_PROMPT_OPTIMIZER_ID,
    title: VIOLATION_PROMPT_OPTIMIZER_TITLE,
    content:
        "你是资深的平台合规与提示词安全改写专家。请把用户给出的提示词改写成一条可以通过 AI 生图 / 生视频平台内容审核的提示词：在不改变原本意图、主体、动作、构图与镜头语言的前提下，替换或弱化其中可能触发审核的表述（暴力血腥、武器伤害、暴露与性暗示、未成年人相关、恐怖惊悚、违法违禁、真人明星肖像、医疗夸大、政治宗教敏感、仇恨歧视等），改成中性克制的同义表达；去掉平台禁用词、极限词，以及真实品牌 / 商标 / 明星姓名，必要时改成通用描述；不新增与画面无关的要求，不改变画面要讲的事。只输出改写后的提示词本身，不要解释、不要前缀、不要引号、不要分点。",
};

/**
 * 标题归一化：把横线 / 空格 / 全角符号全部抹掉再看。
 * 用户那条是 `--------------提示词---违规优化-------------`，手改几个横线也要能命中。
 */
function normalizePromptTitle(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 取「违规优化」指令：**词库优先**（用户点名要用词库那条），没有才回落内置。
 *
 * 匹配三档（宽 → 窄）：id 完全相同 → 标题归一化后完全相同 → 标题里含「违规优化」。
 * 第三档是防用户把横线数量 / 「提示词」几个字改了；只认「违规优化」这个独有词，
 * 不会误抓别的词条（比如「H3-提示词优化」）。
 */
export function resolveViolationPromptOptimizerEntry(textPrompts: TextPromptEntry[] | null | undefined): { entry: TextPromptEntry; fromLibrary: boolean } {
    const list = (textPrompts || []).filter((item) => item && String(item.content || "").trim());
    const wantedTitle = normalizePromptTitle(VIOLATION_PROMPT_OPTIMIZER_TITLE);
    const byId = list.find((item) => String(item.id || "").trim() === VIOLATION_PROMPT_OPTIMIZER_ID);
    const byTitle = byId || list.find((item) => normalizePromptTitle(item.title) === wantedTitle);
    const byKeyword = byTitle || list.find((item) => normalizePromptTitle(item.title).includes("违规优化"));
    if (byKeyword) return { entry: byKeyword, fromLibrary: true };
    return { entry: violationPromptOptimizerEntry, fromLibrary: false };
}

/** Built-in prompts for text nodes; users can customize the full list in preferences. */
export const defaultTextPrompts: TextPromptEntry[] = [
    h3PromptOptimizerEntry,
    // 「违规优化」的内置兜底也进默认库：用户想改措辞可以直接在偏好 → 词库里编辑；
    // 他自己另建一条同名 / 含「违规优化」的词条时，上面的解析函数优先用他的那条。
    violationPromptOptimizerEntry,
    {
        id: "product-hero",
        title: "产品主图",
        content:
            "一张高端商业产品主视觉，主体产品位于画面中央偏下，三分之四视角，柔光与轮廓硬光塑造清晰边缘，干净中性摄影棚背景，材质纹理真实，85mm 商业摄影镜头，画面简洁现代，不出现文字与水印。",
    },
    {
        id: "portrait-editorial",
        title: "编辑肖像",
        content:
            "编辑杂志风人物肖像，人物靠近大面积窗户，柔和自然光从侧前方进入，皮肤纹理真实，神态平静，服装剪裁简洁，背景低饱和轻微虚化，50mm 镜头眼睛精准对焦，不做过度磨皮，不出现文字与水印。",
    },
    {
        id: "cinema-scene",
        title: "电影场景",
        content:
            "电影宽画幅叙事镜头，前中后景层次分明，体积光与氛围雾气，电影级调色，真实材质与环境细节，景深自然，情绪强烈但克制，不出现文字、水印与 logo。",
    },
    {
        id: "style-transfer",
        title: "风格迁移",
        content:
            "保持参考图主体结构与构图，转换为目标艺术风格，光影与材质符合新风格，细节清晰，色彩和谐，不要改变主体身份与关键姿态，不出现文字与水印。",
    },
    {
        id: "ui-mock",
        title: "界面示意",
        content:
            "现代移动端 App 界面高保真示意，清晰信息层级，留白充足，字体可读，组件对齐，柔和阴影，浅色简洁背景，不要真实手机外框文字水印。",
    },
];

export function normalizeTextPrompts(value: unknown): TextPromptEntry[] {
    if (!Array.isArray(value)) return defaultTextPrompts.map((item) => ({ ...item }));
    const result: TextPromptEntry[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Partial<TextPromptEntry>;
        const title = String(entry.title || "").trim();
        const content = String(entry.content || "").trim();
        if (!title || !content) continue;
        const id = String(entry.id || "").trim() || `prompt-${result.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const normalized: TextPromptEntry = { id, title, content };
        // Preserve the disabled flag; undefined means enabled (matches the channel-model convention).
        if (entry.enabled === false) normalized.enabled = false;
        result.push(normalized);
    }
    return result;
}
