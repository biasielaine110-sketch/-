import { requestH3PromptOptimize, type H3OptimizeTarget } from "@/lib/canvas/h3-prompt-optimize";
import { extractOptimizedPromptSection } from "@/lib/canvas/optimize-prompt-output";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * h3 提示词优化的**后台队列**（module 单例，不挂在任何组件上）。
 *
 * 为什么要有它（用户 2026-11-07 报障）：
 * 「点击 h3 提示词优化按钮，选择模型执行后，即进行后台进行执行，不要一直挂着，我无法操作别的内容了。」
 *
 * 以前两条入口都把 `await requestH3PromptOptimize(...)` 写在弹窗组件里：
 *  - 弹窗是 antd Modal，跑着的时候整块画布被遮罩挡住，啥也点不了；
 *  - 关掉弹窗（或组件卸载）就 `abort()`，等于**必须干等**。
 * 把队列搬到这里以后：弹窗点「开始」→ 立刻关窗 → 队列自己跑、边跑边写回节点，
 * 右下角用 `CanvasH3OptimizeProgress` 显示进度并可随时停止。
 *
 * 铁律：
 *  - **不 import React**（纯 TS），否则 lib 层会和 UI 生命周期纠缠；
 *  - 队列是**串行**的（前一个出完再发下一个），天然限制并发；
 *  - 同一时间只允许一个队列（`running` 时再启动返回 `busy`），否则两批会互相覆盖同一批节点。
 */

/**
 * 这一次跑的是哪条优化。
 *
 * 两条优化（`h3` = 转 h3 提示词、`violation` = 违规优化）**共用这一个队列**：
 * 同一时间只跑一批，天然互斥，不会两条流水同时写同一个节点。
 * 但编辑器里的按钮要能分辨「在跑的是我这条还是隔壁那条」（同一个节点两种按钮，
 * 只看 `currentId` 会两边一起显示「停止」），所以连同 kind 一起广播出去。
 */
export type H3OptimizeKind = "h3" | "violation";

export type H3OptimizeQueueState = {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    /** 正在跑的是哪条优化（idle 时为空串） */
    currentKind: H3OptimizeKind | "";
    /** 正在跑的节点 id / 标题（进度卡显示） */
    currentId: string;
    currentTitle: string;
    /** 当前这一条的流式正文（单节点弹窗可据此实时预览） */
    currentText: string;
    /** 当前这一条失败时的错误文案（成功后清空）；进度卡 / 弹窗据此提示原因 */
    currentError: string;
};

export type H3OptimizeQueueResult =
    | { started: false; reason: "busy" | "empty" }
    | { started: true; total: number; done: number; failed: number; cancelled: boolean };

export type H3OptimizeQueueOptions = {
    jobs: H3OptimizeTarget[];
    /** 已带好 `model` 的文本配置 */
    config: AiConfig;
    systemPrompt: string;
    /** 这一批是谁发起的（默认 h3）；只影响 UI 分辨，不影响执行 */
    kind?: H3OptimizeKind;
    /** 每转出一点（含流式中间态）就回写一次；由上层决定写节点哪个字段 */
    onApply: (target: H3OptimizeTarget, text: string) => void;
};

const IDLE_STATE: H3OptimizeQueueState = {
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    currentKind: "",
    currentId: "",
    currentTitle: "",
    currentText: "",
    currentError: "",
};

let state: H3OptimizeQueueState = IDLE_STATE;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((listener) => listener());
}

function patch(next: Partial<H3OptimizeQueueState>) {
    state = { ...state, ...next };
    emit();
}

export function subscribeH3OptimizeQueue(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** `useSyncExternalStore` 的 getSnapshot：state 只在变化时换引用，所以可以直接返回。 */
export function getH3OptimizeQueueState(): H3OptimizeQueueState {
    return state;
}

export function isH3OptimizeQueueRunning() {
    return state.running;
}

/** 停止：当前这一条会中断，队列不再往下走（已转完的节点保持已写入的内容）。 */
export function stopH3OptimizeQueue() {
    controller?.abort();
}

export async function startH3OptimizeQueue(options: H3OptimizeQueueOptions): Promise<H3OptimizeQueueResult> {
    if (state.running) return { started: false, reason: "busy" };
    const jobs = options.jobs.filter((job) => job.text.trim());
    if (!jobs.length) return { started: false, reason: "empty" };

    const jobController = new AbortController();
    controller = jobController;
    const kind: H3OptimizeKind = options.kind || "h3";
    patch({ running: true, total: jobs.length, done: 0, failed: 0, currentKind: kind, currentId: "", currentTitle: "", currentText: "", currentError: "" });

    let done = 0;
    let failed = 0;
    for (const job of jobs) {
        if (jobController.signal.aborted) break;
        patch({ currentKind: kind, currentId: job.id, currentTitle: job.title, currentText: "", currentError: "" });
        try {
            const answer = await requestH3PromptOptimize(options.config, job.text, {
                systemPrompt: options.systemPrompt,
                signal: jobController.signal,
                onStream: (text) => {
                    if (jobController.signal.aborted) return;
                    patch({ currentText: text });
                    // 流式阶段只有「已经出现『优化后完整提示词』那一节」才回写节点：
                    // 模型先输出风险分析、后给提示词时，中途停止不会把分析文字留在输入框里。
                    const picked = extractOptimizedPromptSection(text);
                    if (picked.found) options.onApply(job, picked.text);
                },
            });
            if (jobController.signal.aborted) break;
            options.onApply(job, answer);
            done += 1;
        } catch (error) {
            if (jobController.signal.aborted) break;
            failed += 1;
            patch({ currentError: error instanceof Error ? error.message : String(error) });
        }
        patch({ done, failed });
    }

    const cancelled = jobController.signal.aborted;
    controller = null;
    patch({ ...IDLE_STATE, total: jobs.length, done, failed });
    return { started: true, total: jobs.length, done, failed, cancelled };
}
