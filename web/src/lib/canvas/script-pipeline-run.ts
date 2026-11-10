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

/**
 * 一段视频「点完生成」之后到底成没成（2026-11-10 用户第 01 条要求重试，就必须能判结果）。
 *
 * ⚠️ 只能读节点状态：`generateNode()` 的视频分支**自己吞掉了错误**（catch 里只把节点标成
 * error + toast），Promise 永远 resolve。所以「await 完再抛异常」这条路不存在，
 * 判断一律看 `metadata.status`。
 *
 * 返回 `pending` 的情形（既不是成功也不是报错）**不算失败**，绝不能拿去重试：
 *  - 用户中途点了停止 → 状态停在 loading；
 *  - 模型没配好 → `handleGenerateNode` 直接 return，状态还是 idle。
 * 这两种重试一次都是白花钱 / 白弹配置窗。
 */
export type ScriptPipelineVideoOutcome = "ok" | "error" | "pending";

export function readScriptPipelineVideoOutcome(node: Pick<CanvasNodeData, "metadata"> | null | undefined): ScriptPipelineVideoOutcome {
    // 与 `NODE_STATUS_SUCCESS` / `NODE_STATUS_ERROR`（project.tsx）同一套字面量，这里不 import
    // 组件文件，保持 lib 纯净。
    const status = node?.metadata?.status;
    if (status === "error") return "error";
    if (status === "success") return "ok";
    return "pending";
}

/**
 * 某段视频生成失败后，**再生成一次**要用哪个模型（用户 2026-11-10 第 01 条）。
 *
 * 用户原话：「再次使用偏好或者上一次设定选择的生视频模型生成一次，若还是失败即暂停。」
 * 所以候选只有两个来源：
 *  ① `preferred` —— 偏好里配的生视频模型（`resolveModelForCapability(config, undefined, "video")`）；
 *  ② `settingsSelected` —— 上一次设定里选的（反推节点的「生成设置」→ 脚本节点 `scriptVideoModel`
 *     → 铺链路时已写进视频节点 `metadata.model`）。
 *
 * 取第一个**和刚失败那个不同**的（换一条线路才有意义）；两个都等于失败模型时仍返回它 ——
 * 用户要的是「再试一次」，瞬时故障重试同一条也可能过。
 */
export function resolveScriptPipelineRetryModel(input: { preferred?: string; settingsSelected?: string; failed?: string }): string {
    const failed = (input.failed || "").trim();
    const candidates = [input.preferred, input.settingsSelected].map((value) => (value || "").trim()).filter(Boolean);
    return candidates.find((model) => model !== failed) || candidates[0] || "";
}
