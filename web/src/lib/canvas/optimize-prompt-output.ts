/**
 * 优化结果的**取用口径**：只留「优化后完整提示词」那一节。
 *
 * 为什么需要它（用户 2026-11-11）：
 * 「优化提示词后，只填入【优化后完整提示词】（可直接复制使用）这一部分中的内容。」
 *
 * 词库里那条「违规优化」的提示词是让模型输出一份**报告**的（风险分析 + 改写说明 +
 * 最后才是可用的提示词），整段回填进输入框 = 用户还得自己挑一段复制。这里把
 * 「报告 → 那一段」的裁剪收敛成一个纯函数，三条入口（单节点弹窗 / 批量 / 面板放大弹窗）
 * 共用；拿不到这一节时**原样返回**，绝不把用户的提示词裁没。
 */

/** 章节标题里的关键词（用户词库那条的输出格式）。 */
const HEADING_KEYWORD = "优化后完整提示词";

/** 规范化一行，用于判定它是不是（或是不是邻居）章节标题。 */
function normalizeLine(line: string): string {
    let value = line.trim();
    value = value.replace(/^#{1,6}\s*/u, "");
    value = value.replace(/^[*_]{1,3}\s*/u, "");
    value = value.replace(/^[>•·-]\s*/u, "");
    value = value.replace(/\s*[*_]{1,3}$/u, "");
    return value.trim();
}

/** 去掉标题里那些「（可直接复制使用）：」之类的说明尾巴，剩下的才是正文首行。 */
function stripHeadingTail(rest: string): string {
    let value = rest.trim();
    // 【优化后完整提示词】 的收尾括号
    value = value.replace(/^】/u, "").trim();
    // （可直接复制使用）/ (可直接复制使用) / 【可直接复制使用】
    value = value.replace(/^[（(【][^）)】]*[）)】]/u, "").trim();
    // 「：」「，」「如下」
    value = value.replace(/^(?:如下(?:所示)?)?\s*[:：,，、。]+\s*/u, "").trim();
    value = value.replace(/^[*_]{1,3}\s*/u, "").trim();
    return value;
}

/**
 * 这一行是不是「优化后完整提示词」的章节标题。
 * 返回 `null` 表示不是；返回 `{ rest }` 时 `rest` 是标题行剩下的正文（通常为空）。
 */
function matchHeading(line: string): { rest: string } | null {
    const plain = normalizeLine(line);
    if (!plain) return null;
    // 去掉前面的序号：「二、」「2.」「三 」
    const withoutOrdinal = plain.replace(/^(?:[一二三四五六七八九十]+|\d{1,2})\s*[、.．)]?\s*/u, "");
    const candidates = [plain, withoutOrdinal];
    for (const candidate of candidates) {
        const bare = candidate.replace(/^【\s*/u, "");
        if (!bare.startsWith(HEADING_KEYWORD)) continue;
        const rest = bare.slice(HEADING_KEYWORD.length);
        // 「优化后完整提示词表」这类不算
        if (/^[\p{L}\p{N}]/u.test(rest)) continue;
        return { rest };
    }
    return null;
}

/**
 * 报告里「非正文」的章节词：风险 / 说明 / 备注 …… 出现这些词的小标题才算下一节。
 *
 * 为什么不「见到【…】就当下一节」：视频提示词本身就用 `【镜头 1】` 分镜、
 * 铺链路还会在末尾追加 `【禁止项】` / `【强制声明】`，一律当边界会把正文剪掉大半。
 */
const REPORT_SECTION_LABEL = /(风险|违规|问题|分析|说明|解释|释义|备注|注|建议|提示|注意|总结|修改|改动|替换|理由|依据|对照|其他|附录|结论|原文|输入)/u;

/** 粗体小标题 `**【xxx】**` / 纯文本小标题 `【xxx】` 里的标签。 */
function bracketLabel(line: string): string | null {
    const bracket = line.trim().match(/^[*_\s]*【([^】\n]{1,40})】/u);
    if (bracket) return bracket[1];
    const bold = line.trim().match(/^\*\*([^*\n]{1,40})\*\*/u);
    if (bold) return bold[1].replace(/^【|】$/gu, "");
    return null;
}

/** 章节的结束标记：下一个 markdown 标题 / 报告类小标题 / 分隔线。 */
function isSectionBoundary(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^#{1,6}\s+\S/u.test(trimmed)) return true;
    if (/^-{3,}$|^\*{3,}$|^_{3,}$/u.test(trimmed)) return true;
    const label = bracketLabel(trimmed);
    if (label) {
        // 🔴 只认「报告类」小标题，`【镜头 1】` / `【禁止项】` / `【强制声明】` 属于正文
        if (REPORT_SECTION_LABEL.test(label) && !matchHeading(trimmed)) return true;
    }
    return false;
}

/** 去掉包住整段的三反引号代码块。 */
function stripCodeFence(lines: string[]): string[] {
    if (lines.length < 2) return lines;
    if (!lines[0].trim().startsWith("```")) return lines;
    const lastIndex = lines.length - 1;
    if (!lines[lastIndex].trim().startsWith("```")) return lines;
    return lines.slice(1, lastIndex);
}

export type OptimizedPromptSection = {
    /** 是否真的找到了这一节（找不到时 `text` 是原文，调用方可以安心直接用） */
    found: boolean;
    /** 裁剪后的正文（`found` 为 false 时等于原输入的 trim 结果） */
    text: string;
};

/**
 * 从模型的整段回答里取出「优化后完整提示词」这一节。
 *
 * - 找不到这一节 → `{ found: false, text: 原文 }`（模型没按格式输出时不做任何破坏）；
 * - 找到但正文是空的 → 同样当没找到（避免把输入框清空）；
 * - 多个同名标题 → 取第一个有正文的。
 */
export function extractOptimizedPromptSection(raw: string): OptimizedPromptSection {
    const original = String(raw ?? "");
    const fallbackText = original.trim();
    if (!fallbackText) return { found: false, text: "" };
    if (!fallbackText.includes(HEADING_KEYWORD)) return { found: false, text: fallbackText };

    const lines = original.replace(/\r\n?/gu, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const heading = matchHeading(lines[index]);
        if (!heading) continue;

        const body: string[] = [];
        const firstLine = stripHeadingTail(heading.rest);
        if (firstLine) body.push(firstLine);
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            if (isSectionBoundary(lines[cursor])) break;
            body.push(lines[cursor]);
        }

        const trimmed = stripCodeFence(body).join("\n").replace(/^\s+|\s+$/gu, "");
        if (trimmed) return { found: true, text: trimmed };
    }
    return { found: false, text: fallbackText };
}

/** 便利版：只关心最终要写回的那段文本。 */
export function pickOptimizedPromptText(raw: string): string {
    return extractOptimizedPromptSection(raw).text;
}
