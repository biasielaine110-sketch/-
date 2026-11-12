/**
 * 聚算 Hub 的 429 重试环。
 *
 * 为什么单独一层而不是塞进 `jusuanhub-media.ts`：那个文件是**纯逻辑**（探针直接喂 JSON、
 * 不碰 axios），重试要读 `error.response.headers`，属于收发层。放这里两边共用。
 *
 * 三条硬约束（改之前先想清楚）：
 *  ① **Idempotency-Key 由调用方生成一次**，环里只重发同一个 body/headers。
 *     每次重试换新 key 就有重复建单的风险 —— 两条都进队 = 白烧一次额度。
 *  ② **只重 429**（`isJusuanhubRetryableStatus`）。401/403/400 重试再多次也不会变。
 *  ③ 必须响应 `signal`：用户点了取消就立刻停，别在后台偷偷等 24 秒。
 */
import axios from "axios";
import {
    JUSUANHUB_RETRY_MAX_ATTEMPTS,
    isJusuanhubRetryableStatus,
    readJusuanhubRetryAfterMs,
    resolveJusuanhubRetryDelayMs,
} from "./jusuanhub-media";

export interface JusuanhubRetryInfo {
    /** 1 起：这是第几次失败（第 1 次失败后才会重试）。 */
    attempt: number;
    status: number;
    waitMs: number;
}

export interface JusuanhubRetryOptions {
    signal?: AbortSignal;
    /** 总尝试次数（含首次）。默认 4，即首次 + 3 次重试。 */
    maxAttempts?: number;
    /**
     * 整条重试的**总时间预算**（毫秒）。到点就放弃，把真实 429 抛出去。
     * 为什么要这个：账户是「排队 10 条 / 同时跑 4 条」（unitsPerJob 8 与 6），一条视频约 2 分钟，
     * 排队满了之后 429 会持续很久 —— 只靠次数上限会让等待时间随退避指数膨胀到不可控。
     */
    deadlineMs?: number;
    /** 退避基数，默认 `JUSUANHUB_RETRY_BASE_DELAY_MS`。只有探针该改它（传 1 即毫秒级跑完）。 */
    baseDelayMs?: number;
    onRetry?: (info: JusuanhubRetryInfo) => void;
}

export async function runWithJusuanhubRetry<T>(run: () => Promise<T>, options: JusuanhubRetryOptions = {}): Promise<T> {
    const configured = Math.floor(Number(options.maxAttempts));
    const maxAttempts = Number.isFinite(configured) && configured > 0 ? configured : JUSUANHUB_RETRY_MAX_ATTEMPTS;
    const startedAt = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            return await run();
        } catch (error) {
            lastError = error;
            // 用户主动取消 / 请求被 abort：不是限流，直接抛。
            if (axios.isCancel(error) || options.signal?.aborted) throw error;
            const isAxios = axios.isAxiosError(error);
            const status = isAxios ? Number(error.response?.status) || 0 : 0;
            if (!isJusuanhubRetryableStatus(status) || attempt >= maxAttempts) break;
            const waitMs = resolveJusuanhubRetryDelayMs(
                attempt - 1,
                readJusuanhubRetryAfterMs(isAxios ? error.response?.headers : undefined),
                options.baseDelayMs,
            );
            // 总预算不够这一次等待了就别等：白等 24 秒再抛同一个 429 比立刻报错更糟。
            if (Number.isFinite(options.deadlineMs) && Date.now() + waitMs - startedAt > Number(options.deadlineMs)) break;
            options.onRetry?.({ attempt, status, waitMs });
            await sleep(waitMs, options.signal);
        }
    }
    // 把最后一次的真实错误抛出去（上层会把它翻成 `rateLimited` 文案），别包一层假错误。
    throw lastError;
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, Math.max(0, ms));
        function onAbort() {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
