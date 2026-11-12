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
    isJusuanhubKeyFailoverStatus,
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

export interface JusuanhubKeyFailoverOptions {
    signal?: AbortSignal;
    /** 每个 Key 自己的 429 重试次数（含首次）。多 Key 时默认 1：时间花在换账户上更划算。 */
    perKeyAttempts?: number;
    /** 每个 Key 自己的 429 等待预算。多 Key 时默认 0（不等待，直接换下一个）。 */
    perKeyDeadlineMs?: number;
    /**
     * 「所有 Key 都被 429 挡回来」时的兜底：回到第一个 Key 做一次带退避的长等。
     * 这是单 Key 的旧行为 —— 多 Key 不该比单 Key 更容易失败（都排满时还是得等位）。
     */
    finalRetry?: { maxAttempts?: number; deadlineMs?: number };
    onKeyFailover?: (info: { fromKey: string; toKey: string; status: number }) => void;
}

/**
 * 多 Key 排队试：随机顺序（`orderJusuanhubApiKeys` 洗好的列表），
 * 一个 Key 撞上「账户级」失败（401/402/403/429）就换下一个，直到成功或全部试完。
 *
 * 两条容易写错的地方：
 *  ① **缩略每一个 Key 的 429 预算**。单 Key 时那 30s/90s 的长等是为了「等队列腾位」；
 *     有备用 Key 时把 90 秒耗在一个排满的账户上毫无意义 —— 先花 1 秒试试别的账户。
 *     所以多 Key 时 `perKeyAttempts` 默认 1（不重试，失败就换），全部试完才走 `finalRetry` 长等。
 *  ② **Idempotency-Key 由调用方在环外生成一次**，换 Key 也复用它。每个账户的幂等空间独立，
 *     复用不会串单，反而能挡住「同一个逻辑提交被重复建单」。
 */
export async function runWithJusuanhubKeyFailover<T>(
    keys: readonly string[],
    run: (apiKey: string) => Promise<T>,
    options: JusuanhubKeyFailoverOptions = {},
): Promise<T> {
    const list = keys.map((key) => String(key || "").trim()).filter(Boolean);
    if (!list.length) throw new Error("Jusuanhub hub: no API key configured");
    const multi = list.length > 1;
    let lastError: unknown;
    for (let index = 0; index < list.length; index += 1) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            return await runWithJusuanhubRetry(() => run(list[index]), {
                signal: options.signal,
                maxAttempts: multi ? options.perKeyAttempts ?? 1 : options.perKeyAttempts,
                deadlineMs: multi ? options.perKeyDeadlineMs ?? 0 : options.perKeyDeadlineMs,
            });
        } catch (error) {
            if (axios.isCancel(error) || options.signal?.aborted) throw error;
            lastError = error;
            const status = axios.isAxiosError(error) ? Number(error.response?.status) || 0 : 0;
            if (!isJusuanhubKeyFailoverStatus(status)) throw error;
            if (index < list.length - 1) options.onKeyFailover?.({ fromKey: list[index], toKey: list[index + 1], status });
        }
    }
    // 全部 Key 都被账户级问题挡住。429 = 都排满了 → 回到第一个 Key 做一次长等（旧行为）；
    // 401/402/403 → 换谁都没用，直接把最后一个真实错误抛上去。
    const status = axios.isAxiosError(lastError) ? Number(lastError.response?.status) || 0 : 0;
    if (multi && status === 429) {
        return runWithJusuanhubRetry(() => run(list[0]), {
            signal: options.signal,
            maxAttempts: options.finalRetry?.maxAttempts,
            deadlineMs: options.finalRetry?.deadlineMs,
        });
    }
    throw lastError;
}

function sleep(ms: number, signal?: AbortSignal) {    return new Promise<void>((resolve, reject) => {
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
