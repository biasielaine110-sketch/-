import { extractOptimizedPromptSection } from "@/lib/canvas/optimize-prompt-output";

/**
 * 「编辑提示词」—— 按用户的一句话反馈做**增量改写**（用户 2026-11-11 第 01 条）。
 *
 * 与前两条优化的区别（这点必须记牢，否则会被当成第三条「优化」再实现一遍）：
 *  - h3 优化：把任意文本**重写成** h3 视频提示词格式，结构由技能决定；
 *  - 违规优化：把文本**重写成**能过审的版本，结构可以变；
 *  - 编辑提示词：**结构一个字都不许动**，只把用户点名的那几处字句改掉。
 *
 * 所以指令是**内置**的（不走技能库 / 词库：用户要的是「照我说的改」，不是「按某套模板重写」），
 * 模型恒跟偏好里的文本模型（由调用方传入 `config.textModel`）。
 */

/**
 * system 指令。刻意写得极硬：
 *  - 结构锁定（段落 / 行数 / 编号 / 标签 / 占位符 / 术语 / 标点）；
 *  - 只改点名处（不润色、不精简、不扩写）；
 *  - 禁止一切解释与客套（用户原话：「不要增加多余的注解备注等内容」）。
 *
 * ⚠️ 模型偶尔还是会加「好的，以下是修改后的提示词：」，所以调用方还要过一遍
 * `finalizeEditedPrompt` —— 指令是第一道闸，代码清洗是第二道。
 */
export const EDIT_PROMPT_SYSTEM = [
    "你是一个提示词修改器。用户会给你【原提示词】和【修改意见】，你只按修改意见修改原提示词，然后输出修改后的完整提示词。",
    "",
    "硬性规则：",
    "1. 保持原文本架构完全不变：段落数量与顺序、换行、缩进、编号、标题、方括号标签（如【镜头 1】【角色】【禁止项】）、占位符（如 @图片1、{{name}}）、英文术语、标点风格，都必须保留。",
    "2. 只改与修改意见直接相关的字句。意见没有提到的内容一个字都不要动：不润色、不精简、不扩写、不重排、不统一术语。",
    "3. 不得新增原文没有的段落、小节、标题、标签、要求或元信息。",
    "4. 不得输出任何解释、说明、注释、备注、清单、修改说明、对比、总结、开场白（如「好的」「以下是修改后的提示词」）或代码围栏。",
    "5. 第一行就是修改后的提示词正文，最后一行也是正文，首尾不要加任何装饰。",
    "6. 如果修改意见无法执行、或与提示词无关，原样输出【原提示词】。",
].join("\n");

/** 拼 user 消息：先给原文，再给意见，最后一句再次强调只输出正文。 */
export function buildEditPromptUserMessage(prompt: string, feedback: string): string {
    const original = String(prompt ?? "").trim();
    const advice = String(feedback ?? "").trim();
    const parts = ["【原提示词】", original];
    if (advice) parts.push("", "【修改意见】", advice);
    parts.push("", "只输出修改后的完整提示词正文，不要任何说明或前后缀。");
    return parts.join("\n");
}

/** 去掉包住整段的三反引号代码块（模型违反指令时最常见的一层包装）。 */
function stripFence(text: string): string {
    const lines = text.replace(/\r\n?/gu, "\n").split("\n");
    if (lines.length < 2) return text;
    if (!lines[0].trim().startsWith("```")) return text;
    const last = lines.length - 1;
    if (!lines[last].trim().startsWith("```")) return text;
    return lines.slice(1, last).join("\n");
}

/** 客套 / 说明式开场白：「好的，以下是修改后的提示词：」「已按你的要求修改如下：」 */
const PREAMBLE_LINE = /^(好的|好|当然|没问题|可以|明白|收到|以下是|这是|下面是|修改后|已按|根据你的|按照你的|我已)/u;
/** 需要「像说明句」才算前言：带冒号或提到提示词 / 修改 / 如下。 */
const PREAMBLE_HINT = /(：|:|如下|提示词|修改|改写|调整)/u;
/** 尾部注释行：「以上」「如需…」「备注：」「注：」「（注：…）」 */
const TAIL_NOTE = /^(以上|如需|如果需要|如果需要调整|希望|说明|备注|注[:：]|提示[:：]|（注|\(注)/u;

/**
 * 清洗「编辑提示词」的输出。
 *
 * 三道：
 *  1. 模型若自己套了「【优化后完整提示词】」这种标题（少数会），先按既有口径取那一节；
 *  2. 剥掉包住整段的代码围栏；
 *  3. 剥掉**首部客套行 / 尾部注释行**——但只剥「原文里本来没有的行」（`original` 用来查重），
 *     否则会把用户原文自己的「备注：…」删掉，那就违背「保持原架构」了。
 *
 * 只动首尾、最多各 2 行，中间正文一律不碰。
 */
export function finalizeEditedPrompt(raw: string, original = ""): string {
    const section = extractOptimizedPromptSection(raw);
    let text = String(section.text || "").trim();
    if (!text) return "";
    text = stripFence(text).trim();
    if (!text) return String(section.text || "").trim();

    const originalLines = new Set(
        String(original ?? "")
            .replace(/\r\n?/gu, "\n")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
    );

    const lines = text.replace(/\r\n?/gu, "\n").split("\n");

    // ① 首部：最多 2 行，且必须是「客套 + 说明感」且原文里没有的
    let head = 0;
    let removedHead = 0;
    while (head < lines.length - 1 && removedHead < 2) {
        const line = lines[head].trim();
        if (!line) {
            head += 1;
            continue;
        }
        if (originalLines.has(line)) break;
        if (!PREAMBLE_LINE.test(line) || !PREAMBLE_HINT.test(line)) break;
        head += 1;
        removedHead += 1;
    }

    // ② 尾部：最多 2 行，同样只剥原文里没有的注释行
    let end = lines.length;
    let removedTail = 0;
    while (end > head + 1 && removedTail < 2) {
        const line = lines[end - 1].trim();
        if (!line) {
            end -= 1;
            continue;
        }
        if (line.length > 120) break;
        if (originalLines.has(line)) break;
        if (!TAIL_NOTE.test(line)) break;
        end -= 1;
        removedTail += 1;
    }

    const body = lines.slice(head, end).join("\n").replace(/^\s+|\s+$/gu, "");
    return body || text;
}
