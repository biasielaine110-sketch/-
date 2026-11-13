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

/**
 * 批量一键生成里，两个**视频**节点之间至少隔多久（用户 2026-11-13 21:41）。
 *
 * 一次把 5 个 minimax-h3 全发出去，聚算这类渠道会同时排 5 条大任务：画布卡顿、上游也更容易 504。
 * 错开 2 秒后请求仍然是并行的，只是不再同一瞬间砸出去。
 */
export const BATCH_VIDEO_GENERATE_GAP_MS = 2_000;

export type BatchGenerateScheduleEntry = BatchGeneratePlanItem & { delayMs: number };

/**
 * 给每个节点算「相对点击那一刻」的启动延迟。
 *
 * 只有**视频**会推进这口时钟：图片走的接口不同、体积小得多，本身不加延迟（批量出图不该被拖成串行），
 * 但它排在视频后面时仍然要等前一个视频让出的 2 秒（不能抢在视频前面挤同一个瞬间）。
 *  - `[video, video, video]` → 0 / 2000 / 4000
 *  - `[image, image]` → 0 / 0
 *  - `[video, image, video]` → 0 / 2000 / 2000（图片不额外加时，所以第二个视频仍是 2 秒后）
 */
export function planBatchGenerateSchedule(
    items: readonly BatchGeneratePlanItem[],
    gapMs: number = BATCH_VIDEO_GENERATE_GAP_MS,
): BatchGenerateScheduleEntry[] {
    const gap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : 0;
    const entries: BatchGenerateScheduleEntry[] = [];
    let elapsed = 0;
    for (const item of items) {
        entries.push({ ...item, delayMs: elapsed });
        if (item.mode === "video") elapsed += gap;
    }
    return entries;
}
