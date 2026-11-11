import { resolveViolationPromptOptimizerEntry, type TextPromptEntry } from "@/constant/text-prompt-library";

/**
 * 「违规优化」的 instruction 来源。
 *
 * 与 h3 提示词优化（技能优先）不同：这条**只认词库** —— 用户 2026-11-11 点名的口径就是
 * 「调用词库中的 `--------------提示词---违规优化-------------` 的提示词内容」。
 * 词库缺这条时回落内置兜底文案（`constant/text-prompt-library.ts`），按钮不会变死键。
 *
 * 请求本身复用 `lib/canvas/h3-prompt-optimize.ts`（消息组装 / 空输入 / 失败退回原文）
 * 和 `h3-optimize-runner.ts`（后台队列）—— 两条优化共用同一个队列，天然互斥，
 * 不会出现「h3 在转这个节点时违规优化又写一遍」。
 */
export type ViolationOptimizeSystemPrompt = {
    /** 要发给模型的 system 正文 */
    text: string;
    /** 词条标题（UI 上显示「取自词库「…」」） */
    title: string;
    /** true = 命中用户词库；false = 用了内置兜底 */
    fromLibrary: boolean;
};

export function resolveViolationOptimizeSystemPrompt(textPrompts: readonly TextPromptEntry[] | null | undefined): ViolationOptimizeSystemPrompt {
    const { entry, fromLibrary } = resolveViolationPromptOptimizerEntry((textPrompts || []) as TextPromptEntry[]);
    return {
        text: String(entry?.content || "").trim(),
        title: String(entry?.title || "").trim(),
        fromLibrary,
    };
}
