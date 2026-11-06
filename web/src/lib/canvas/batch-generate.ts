import { buildNodeGenerationInputs } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

/**
 * 多选节点右键「一键生成」的纯逻辑。
 *
 * 判据刻意与两条既有链路对齐，避免「右键批量跑」和「单点跑」结果不一致：
 *  - 生成模式：沿用定时调度器的口径（`metadata.generationMode` 优先，否则按节点类型推断）。
 *  - 可跑性：沿用提示词面板的提交守卫（本地提示词为空时，只要连了上游文本节点仍可跑）。
 *
 * 只覆盖图片 / 视频两类生成槽位 —— 这正是用户说的「多个视频窗口 / 多个图片窗口」。
 * 文本、配置、分组等节点不会被批量生成顶掉（文本节点往往是别的节点的提示词来源，跑一次就被覆盖）。
 */
const BATCH_GENERATE_TYPES: ReadonlySet<string> = new Set<string>([CanvasNodeType.Image, CanvasNodeType.Video]);

export type BatchGeneratePlanItem = {
    nodeId: string;
    mode: CanvasGenerationMode;
    /** 只带用户自己写的提示词；上游文本由 `buildNodeGenerationContext` 在生成时合并一次。 */
    prompt: string;
};

export type BatchGeneratePlan = {
    items: BatchGeneratePlanItem[];
    /** 已经在生成中的（不排队，避免重复扣费）。 */
    skippedRunning: number;
    /** 既没写提示词、也没连上游文本 —— 单点也不会跑，批量里直接跳过。 */
    skippedNoPrompt: number;
    /** 选中的节点类型不参与批量生成（文本 / 配置 / 分组 / 合并 …）。 */
    skippedType: number;
};

export function isBatchGeneratableNode(node: CanvasNodeData | null | undefined): boolean {
    return Boolean(node && BATCH_GENERATE_TYPES.has(node.type));
}

/** 与 `project.tsx` 里定时调度器完全同口径。 */
export function resolveBatchGenerateMode(node: CanvasNodeData): CanvasGenerationMode {
    return node.metadata?.generationMode || (node.type === CanvasNodeType.Video ? "video" : "image");
}

/** 用户手写的提示词（画布上的提示词输入框写的是 `composerContent`，老数据只有 `prompt`）。 */
export function batchGeneratePromptOf(node: CanvasNodeData): string {
    return String(node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim();
}

export function buildBatchGeneratePlan({
    nodes,
    nodeIds,
    connections,
    isGenerating,
}: {
    nodes: readonly CanvasNodeData[];
    nodeIds: ReadonlyArray<string>;
    connections: readonly CanvasConnection[];
    isGenerating?: (nodeId: string) => boolean;
}): BatchGeneratePlan {
    const plan: BatchGeneratePlan = { items: [], skippedRunning: 0, skippedNoPrompt: 0, skippedType: 0 };
    const nodeList = [...nodes];
    const connectionList = [...connections];
    const byId = new Map(nodeList.map((node) => [node.id, node]));
    const seen = new Set<string>();

    for (const nodeId of nodeIds) {
        if (!nodeId || seen.has(nodeId)) continue;
        seen.add(nodeId);
        const node = byId.get(nodeId);
        // 节点已经不在了（选区里残留了已删 id）：不算「跳过」，静默忽略。
        if (!node) continue;
        if (!isBatchGeneratableNode(node)) {
            plan.skippedType += 1;
            continue;
        }
        if (isGenerating?.(nodeId)) {
            plan.skippedRunning += 1;
            continue;
        }
        const prompt = batchGeneratePromptOf(node);
        const hasUpstreamText = buildNodeGenerationInputs(node.id, nodeList, connectionList).some((input) => input.type === "text" && Boolean(String(input.text || "").trim()));
        if (!prompt && !hasUpstreamText) {
            plan.skippedNoPrompt += 1;
            continue;
        }
        plan.items.push({ nodeId: node.id, mode: resolveBatchGenerateMode(node), prompt });
    }

    return plan;
}
