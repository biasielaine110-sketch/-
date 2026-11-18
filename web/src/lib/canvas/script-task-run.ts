/**
 * 脚本节点上「一键生图 / 一键生视频 / 一键视频」的**运行态 + 用户暂停令牌**（用户 2026-11-18）。
 *
 * 用户原话：「脚本生成器，在执行一键生图和一键生视频时，需要点击后再次点击可以暂停，点击后，
 * 即暂停后续的操作。」
 *
 * 所以这三颗按钮都变成 **toggle**：
 *   - 没在跑 → 点一下 = 开始；
 *   - 正在跑 → 点一下 = 请求暂停（不再往下点下一张图 / 下一段视频，也不再重试）；
 *   - 已暂停 → 点一下 = 重新开始。
 *
 * 为什么暂停令牌放在**模块级 Set** 而不是 React state：
 *  ① 所有检查点都在 `await` 之后的同步代码里（生图分批发射的循环、铺链路的 10 秒节拍循环），
 *     state 在闭包里读到的是旧值，`ref` / 模块级变量才是同步可见的；
 *  ② 检查点分散在 `handleDirectGenerateScriptAssets` / `handleBuildScriptPipeline` /
 *     `handleOneClickVideo` 三处，其中前两个是 `useCallback`、依赖数组已经很长，
 *     再塞一个 ref 进去要把依赖链全改一遍 —— 令牌是「瞬时信号」，不需要触发渲染。
 *  ③ 与 `script-pipeline-run.ts` 里的 `lastPipelineGenerateAt`（全局 10 秒节拍）同一套写法，口径一致。
 *
 * ⚠️ 令牌按 `nodeId::kind` 分槽，**不按 nodeId 合并**：
 * 「一键视频」内部会自己去调「一键生图」和「一键铺链路」，如果共用一个槽，
 * 用户点「一键生图」的暂停会把「一键视频」整条流程也掐掉（反之亦然）。
 */

/** 三颗可暂停的按钮：一键生图 / 一键生视频（铺链路并生成） / 一键视频（三步全自动）。 */
export type ScriptTaskKind = "image" | "video" | "oneClick";

export type ScriptTaskRunStatus = "running" | "paused";

/**
 * 一颗按钮的运行态（内存态，不落 `metadata`）。
 *
 * ⚠️ 与 `OneClickVideoRun` 一样**刻意不落库**：落库后刷新页面会永远停在「已暂停」，
 * 用户会以为还在跑（实际上那条 Promise 早没了）。
 */
export type ScriptTaskRun = {
    status: ScriptTaskRunStatus;
    /** 暂停原因 / 当前阶段提示（按钮 `title` 上显示）。 */
    message?: string;
};

/** 令牌槽 / 运行态表的键。 */
export function scriptTaskKey(nodeId: string, kind: ScriptTaskKind): string {
    return `${nodeId}::${kind}`;
}

const pauseTokens = new Set<string>();

/** 请求暂停（可重复调用，幂等）。 */
export function requestScriptTaskPause(nodeId: string, kind: ScriptTaskKind): void {
    if (!nodeId) return;
    pauseTokens.add(scriptTaskKey(nodeId, kind));
}

/**
 * 这一趟是不是被要求停下来了。
 *
 * 所有循环 / 重试前的检查点都调它：命中就**不再往下推进**（已经点出去的请求不强制 abort，
 * 让它自己落定 —— 钱已经付了，强行 abort 反而会在节点上留一个「已取消」的空图）。
 */
export function isScriptTaskPauseRequested(nodeId: string, kind: ScriptTaskKind): boolean {
    return pauseTokens.has(scriptTaskKey(nodeId, kind));
}

/** 清掉令牌：新一趟开始时清（否则上一次的暂停会把这一趟立刻掐掉），跑完 `finally` 里也清。 */
export function clearScriptTaskPause(nodeId: string, kind: ScriptTaskKind): void {
    pauseTokens.delete(scriptTaskKey(nodeId, kind));
}

/** 仅供探针：把令牌表清空（生产代码不要调）。 */
export function resetScriptTaskPauseForTest(): void {
    pauseTokens.clear();
}
