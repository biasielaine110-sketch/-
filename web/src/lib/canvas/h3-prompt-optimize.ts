import { resolveSchemeSkillPrompt, type ScriptSchemeSkillSource } from "@/constant/script-scheme";
import { resolveH3PromptOptimizerEntry, type TextPromptEntry } from "@/constant/text-prompt-library";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 「h3 提示词优化」的**唯一**入口。
 *
 * 三处入口共用这里（图片 / 视频节点提示词面板的放大弹窗、双击最大化的文本编辑弹窗、
 * 多选节点右键的批量优化），所以「用哪条 instruction」「写回哪个字段」「怎么调模型」
 * 都只在这里定义一次 —— 任何一处改口径，三处一起变。
 */

/**
 * 技能库里那条 instruction 的标题 needle。
 *
 * 只认 `minih3`（`转Minih3-视频提示词` 归一后是 `转minih3视频提示词`，命中最严格的那一级）。
 * 刻意**不加**「视频提示词」——那是通用词，会把别人家的「通用视频提示词大全」抓来当 h3 格式转换器。
 */
export const MINIH3_VIDEO_SKILL_NEEDLES = ["minih3"] as const;

/** 没命中技能时给 UI 兜底显示的名字（不代表它存在）。 */
export const MINIH3_VIDEO_SKILL_TITLE = "转Minih3-视频提示词";

export type H3OptimizePromptSource = {
    /** 真正要发给模型的 system 正文 */
    text: string;
    /** 命中的技能 / 词条标题，给 UI 显示「取自 …」 */
    title: string;
    /** `skill` = 技能库命中；`library` = 回落词库「H3-提示词优化」；`none` = 两边都没有 */
    source: "skill" | "library" | "none";
};

/**
 * 取「转Minih3-视频提示词」技能的正文当 system prompt。
 *
 * 技能库优先（用户 2026-11-06 点名的口径）；没装这条技能时**回落到词库**的
 * 「H3-提示词优化」，这样按钮不会变成一点就报错的死键 —— 但 `source` 会如实标成
 * `library`，UI 能直接告诉用户「现在用的不是技能」。
 */
export function resolveH3OptimizeSystemPrompt(
    skills: readonly ScriptSchemeSkillSource[] | null | undefined,
    textPrompts: readonly TextPromptEntry[] | null | undefined,
): H3OptimizePromptSource {
    const skill = resolveSchemeSkillPrompt(skills, MINIH3_VIDEO_SKILL_NEEDLES);
    if (skill.text) {
        return { text: skill.text, title: skill.title || MINIH3_VIDEO_SKILL_TITLE, source: "skill" };
    }
    const fallback = resolveH3PromptOptimizerEntry((textPrompts || []) as TextPromptEntry[]);
    const text = String(fallback?.content || "").trim();
    if (!text) return { text: "", title: "", source: "none" };
    return { text, title: String(fallback?.title || "").trim(), source: "library" };
}

/** 组消息：有 system 就两条，没有就只发 user（不塞空 system）。 */
export function buildH3OptimizeMessages(systemPrompt: string, prompt: string): AiTextMessage[] {
    const user = String(prompt ?? "").trim();
    const system = String(systemPrompt ?? "").trim();
    return system
        ? [
              { role: "system", content: system },
              { role: "user", content: user },
          ]
        : [{ role: "user", content: user }];
}

export type H3OptimizeRequestOptions = {
    /** 技能 / 词条正文 */
    systemPrompt: string;
    signal?: AbortSignal;
    /** 流式增量（已经是累计文本），宿主拿它实时写进输入框 */
    onStream?: (text: string) => void;
};

/**
 * 跑一次优化：system = 技能正文，user = 原始提示词，走上文本模型那条链路。
 *
 * 空输入直接返回空串（调用方自己决定要不要提示）；模型没吐内容时退回原文，
 * 避免「点了优化，内容反而被清空」。
 */
export async function requestH3PromptOptimize(config: AiConfig, prompt: string, options: H3OptimizeRequestOptions): Promise<string> {
    const original = String(prompt ?? "");
    const trimmed = original.trim();
    if (!trimmed) return "";
    let streamed = "";
    const answer = await requestImageQuestion(
        config,
        buildH3OptimizeMessages(options.systemPrompt, trimmed),
        (text) => {
            if (options.signal?.aborted) return;
            streamed = text;
            options.onStream?.(text);
        },
        { signal: options.signal },
    );
    return String(answer || streamed || "").trim() || trimmed;
}

/** 能优化的节点类型：图片 / 视频（同一个生成槽位的两种形态）。 */
export function isH3OptimizableNode(node: CanvasNodeData | null | undefined): boolean {
    return Boolean(node && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video));
}

/**
 * 写回哪个字段 —— 与 `canvas-node-prompt-panel` 的 `updatePrompt` **同口径**：
 * 「已经在编辑已有内容」（文本节点有正文 / 图片节点有图）时写 `composerContent`，否则写 `prompt`。
 * 两边不一致的话，右键批量优化会把内容写到用户看不见的那个字段里。
 */
export function resolveNodePromptField(node: CanvasNodeData): "prompt" | "composerContent" {
    const hasText = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImage = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    return hasText || hasImage ? "composerContent" : "prompt";
}

/** 读提示词正文（与提示词面板的初值同口径）。 */
export function readNodePromptText(node: CanvasNodeData): string {
    return String(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
}

export type H3OptimizeTarget = {
    id: string;
    /** 节点标题，批量进度列表里显示 */
    title: string;
    /** 写回字段 */
    field: "prompt" | "composerContent";
    /** 当前提示词正文（优化前） */
    text: string;
};

/**
 * 从选区里挑出可优化的目标：图片 / 视频节点、且提示词非空。
 *
 * 顺序按 `nodes`（画布里的节点顺序）遍历而不是按选区 Set 的顺序 —— Set 的插入顺序
 * 会随点选/框选手势变化，批量执行的先后也就跟着抖；按画布顺序才稳定可预期。
 */
export function collectH3OptimizeTargets(nodes: readonly CanvasNodeData[] | null | undefined, nodeIds: readonly string[] | null | undefined): H3OptimizeTarget[] {
    const wanted = new Set(nodeIds || []);
    if (!wanted.size) return [];
    const targets: H3OptimizeTarget[] = [];
    for (const node of nodes || []) {
        if (!wanted.has(node.id) || !isH3OptimizableNode(node)) continue;
        const text = readNodePromptText(node);
        if (!text.trim()) continue;
        targets.push({ id: node.id, title: String(node.title || node.id), field: resolveNodePromptField(node), text });
    }
    return targets;
}
