export type TextPromptEntry = {
    id: string;
    title: string;
    content: string;
};

/** id / title of the built-in prompt-optimizer entry used by the composer button. */
export const H3_PROMPT_OPTIMIZER_ID = "h3-prompt-optimizer";
export const H3_PROMPT_OPTIMIZER_TITLE = "H3-提示词优化";

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

/** Built-in prompts for text nodes; users can customize the full list in preferences. */
export const defaultTextPrompts: TextPromptEntry[] = [
    h3PromptOptimizerEntry,
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
        result.push({ id, title, content });
    }
    return result;
}
