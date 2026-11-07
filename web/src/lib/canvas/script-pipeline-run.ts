import type { CanvasNodeData } from "@/types/canvas";

/**
 * 「一键铺视频链路并生成」的**纯逻辑**：铺完之后按什么顺序、隔多久逐个点「生成」。
 *
 * 用户原话（2026-11-07 第 3 条）：「将这些视频窗口输入链接到一个视频合并节点上。然后将该组中的
 * 视频节点逐个视频进行生成按钮的执行，执行生成按钮的生成间隔为 2 秒，执行一遍生成按钮后即执行完毕。」
 *
 * 两个口径刻意写在 lib 而不是组件里，因为它们在浏览器里看着都对、错了只有用户能发现：
 *  - **顺序**：按画布上的摆放（先上后下、同一高度再左到右）——“组里的第一个”在用户眼里就是最上面那个；
 *  - **间隔**：2 秒是**两次点击之间**的间隔，不是「等上一个生成完再点下一个」。
 *    视频生成动辄几分钟，等完成再下一个等于串行跑一整天；而 `执行一遍…即执行完毕` 也说明跑完就结束。
 */

/** 相邻两次「点生成」之间的间隔（毫秒）。改这里等于改全局节奏。 */
export const SCRIPT_PIPELINE_GENERATE_INTERVAL_MS = 2000;

export type ScriptPipelineGenerateTarget = {
    nodeId: string;
    /** 这个视频节点自己的提示词（生成时原样回填，免得把画布上的编辑器内容盖掉）。 */
    prompt: string;
    /** 第几个（0 起），只用于提示文案 / 探针。 */
    index: number;
};

/**
 * 排出「点生成」的顺序。
 *
 * 传进来的通常是刚铺出来的 `createdVideoNodes`（本身已是时间线顺序），这里仍然按坐标再排一遍：
 * 用户看到的顺序 = 画面上的顺序，两者万一对不上（合并组把某些节点摆到了别的行高）也不会乱跳。
 */
export function planScriptPipelineGenerateOrder(videoNodes: readonly CanvasNodeData[]): ScriptPipelineGenerateTarget[] {
    return [...videoNodes]
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
        .map((node, index) => ({ nodeId: node.id, prompt: (node.metadata?.prompt || "").trim(), index }));
}
