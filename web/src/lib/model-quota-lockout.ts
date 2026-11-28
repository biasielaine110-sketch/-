// 「今日额度用完 → 自动停用 → 次日 0 点自动恢复」的单一来源。
//
// 🔴 背景（2026-11-28 用户第 26 条）：qf 渠道（本机 quota-flow 网关，豆包免费额度）
// 的 Seedance 2.0 Fast 每天有免费次数，用完以后网关会把任务判失败并原样回原因
// （`local-api.ts` 的 `QUOTA_FAIL_RE` → `handleQuotaExhausted`，按**北京时间自然日**
// 拉黑账号，0 点自动解封）。问题在画布侧：它不知道这个模型今天已经报废，用户还会继续
// 点生成、批量跑脚本，每条都白跑一轮再弹一次同样的错。
//
// 所以这里做一层「按模型停用」：
//   · 认得出「今日/每天/免费次数用完」这类**会在 0 点自己回来**的文案 → 停用到次日 0 点；
//   · 认不出的（余额不足 / 402 / 欠费）**不停用** —— 那是充值就能好，锁到明天是错的；
//   · 套餐限制（「免费体验套餐不可用于创作」）也**不锁到明天** —— 网关只封它 30 分钟，
//     用户升级订阅立刻就能用，锁一整天反而挡路；
//   · 到期在读的时候惰性判掉（不依赖定时器），另起一个定时器只为让 UI 自动刷新；
//   · 用户可手动「恢复使用」（模型选择器旁的按钮），误锁不至于卡一整天。
//
// 落盘用 localStorage：刷新、跨标签、重开浏览器都还算数。
import axios from "axios";

import i18n from "@/i18n";
import { isLocalNetworkUrl } from "@/lib/api-proxy";
import { publicBaseForLocalGateway } from "@/lib/local-gateway";
import { resolveModelRequestConfig, modelOptionName, type AiConfig } from "@/stores/use-config-store";

const LOCK_STORAGE_KEY = "infinite-atelier:model-quota-lockout:v1";

export type ModelQuotaLock = {
    /** `${baseUrl}\0${model}` —— 同一模型换渠道/换地址就是另一条额度。 */
    key: string;
    model: string;
    baseUrl: string;
    /** 上游原话（截断），用来解释「为什么停用」。 */
    reason: string;
    lockedAt: number;
    /** 到期时间戳（北京时间次日 00:00）。到这里以后自动恢复，不需要用户操作。 */
    until: number;
};

/** 落盘的只有「为什么」和「到什么时候」——模型名/地址由 key 里解出来，避免两份真相。 */
type LockStore = Record<string, { reason: string; lockedAt: number; until: number }>;

const listeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 下一次「额度重置」的时刻。
 *
 * 🔴 必须按**北京时间**算，不能直接 `setHours(24)`：qf 网关是按 `beijingDay()` 划自然日的，
 * 机器时区不是 UTC+8 时（或用户在海外用这台机器）本地 0 点和网关的 0 点不是同一个点，
 * 早恢复会白打一轮、晚恢复会让用户干等。
 */
export function nextQuotaResetAt(now = Date.now()): number {
    const BEIJING_OFFSET_MS = 8 * 3_600_000;
    const shifted = new Date(now + BEIJING_OFFSET_MS);
    // 以 UTC 视图把时间推到「下一个 00:00」，再减回偏移 —— 得到北京时间的次日 0 点。
    shifted.setUTCHours(24, 0, 0, 0);
    return shifted.getTime() - BEIJING_OFFSET_MS;
}

/**
 * 只认「按自然日重置」的额度用尽。
 *
 * 反例（故意不认）：
 *   · `余额不足` / `402` / `insufficient balance` —— 充值即好，不是日额度；
 *   · `剩余时长不足（本次需 10 秒）` —— 这一单太大，不代表账号当天报废（网关注释亦如此）；
 *   · `免费体验套餐不可用于创作` / `可升级正式订阅` —— 升级即好，网关只封 30 分钟。
 */
const DAILY_QUOTA_RE = new RegExp(
    [
        // 今日/每天 + 次数/额度 + 用完（豆包：「今日视频生成免费次数用完了，你明天再来找我吧」）
        "(今日|今天|当天|每日|每天)[^。\\n]{0,16}(次数|额度|配额|用量)[^。\\n]{0,10}(用完|用尽|耗尽|不足)",
        // 裸的「免费次数用完 / 次数已用完 / 额度用尽」（网关 QUOTA_FAIL_RE 同款，且这些确实按日重置）
        "(免费)?(次数|额度|配额)[^。\\n]{0,8}(用完|用尽|耗尽)",
        "明天再来",
        // 英文
        "daily (limit|quota)[^。\\n]{0,24}(reached|exceeded|exhausted)",
        "free (credits?|quota|uses?)[^。\\n]{0,24}(used up|exhausted|run out|reached)",
        "quota (exceeded|exhausted)",
    ].join("|"),
    "i",
);

export function isDailyQuotaMessage(message: string): boolean {
    const text = String(message || "").trim();
    if (!text) return false;
    return DAILY_QUOTA_RE.test(text);
}

/** 这条渠道是不是「本机网关」（qf / WorkBuddy2API 这类按日发额度的）。给文案用，不参与判定。 */
export function isLocalGatewayChannel(baseUrl: string): boolean {
    if (!baseUrl) return false;
    return isLocalNetworkUrl(baseUrl) || Boolean(publicBaseForLocalGateway(baseUrl));
}

function readStore(): LockStore {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(LOCK_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        return parsed as LockStore;
    } catch {
        return {};
    }
}

function writeStore(store: LockStore) {
    if (typeof window === "undefined") return;
    try {
        if (Object.keys(store).length) window.localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(store));
        else window.localStorage.removeItem(LOCK_STORAGE_KEY);
    } catch {
        // 存不进去也不该让生成流程崩：退化成「这次会话内有效」。
    }
}

function emit() {
    scheduleExpiry();
    listeners.forEach((listener) => listener());
}

/** 到期就自然消失；顺手把刷新定时器挪到「最近一条到期时间」。 */
function purgeExpired(store: LockStore, now = Date.now()): { store: LockStore; changed: boolean } {
    let changed = false;
    for (const [key, entry] of Object.entries(store)) {
        if (!entry || typeof entry.until !== "number" || entry.until <= now) {
            delete store[key];
            changed = true;
        }
    }
    return { store, changed };
}

function scheduleExpiry() {
    if (typeof window === "undefined" || typeof setTimeout === "undefined") return;
    if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
    const now = Date.now();
    const next = Object.values(readStore())
        .map((entry) => entry?.until || 0)
        .filter((until) => until > now)
        .sort((a, b) => a - b)[0];
    if (!next) return;
    // setTimeout 的上限是 2^31-1 ms（约 24.8 天），一天完全够；再夹一个 1s 下限防抖。
    expiryTimer = setTimeout(
        () => {
            const { changed } = purgeExpired(readStore());
            if (changed) writeStore(readStore());
            emit();
        },
        Math.max(1_000, next - now),
    );
}

export function quotaLockKey(config: AiConfig, encodedModel: string): { key: string; model: string; baseUrl: string } {
    let baseUrl = String(config?.baseUrl || "");
    let model = modelOptionName(String(encodedModel || ""));
    try {
        const request = resolveModelRequestConfig(config, encodedModel);
        baseUrl = String(request.baseUrl || baseUrl);
        model = String(request.model || model);
    } catch {
        // 🔴 这里的定位是「记账」，不是「校验配置」：`resolveModelRequestConfig` 需要完整的
        // `channels[].models`，而有些调用方（测试桩、只带 baseUrl 的桥接对象）给不出。
        // 一旦它在提交前抛出去，整个生成流程会因为一条额度记录而失败 —— 得不偿失。
        // 退回「全局 baseUrl + 模型名」这条更粗的 key，停用照样生效。
    }
    const normalizedBase = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
    const normalizedModel = model.trim();
    return { key: `${normalizedBase}\u0000${normalizedModel}`, model: normalizedModel, baseUrl: normalizedBase };
}

export function getQuotaLock(config: AiConfig, encodedModel: string): ModelQuotaLock | null {
    const { key, model, baseUrl } = quotaLockKey(config, encodedModel);
    if (!model) return null;
    const store = readStore();
    const entry = store[key];
    if (!entry) return null;
    if (!entry.until || entry.until <= Date.now()) {
        delete store[key];
        writeStore(store);
        return null;
    }
    return { key, model, baseUrl, ...entry };
}

export function listQuotaLocks(): ModelQuotaLock[] {
    const store = readStore();
    const { changed } = purgeExpired(store);
    if (changed) writeStore(store);
    return Object.entries(store)
        .filter(([, entry]) => entry && entry.until > Date.now())
        .map(([key, entry]) => {
            const [baseUrl = "", model = ""] = key.split("\u0000");
            return { key, baseUrl, model, ...entry };
        })
        .sort((a, b) => a.until - b.until);
}

export function subscribeQuotaLocks(listener: () => void): () => void {
    listeners.add(listener);
    scheduleExpiry();
    return () => {
        listeners.delete(listener);
    };
}

/** 记一条「今日额度用完」。已经是停用状态就不重置计时（免得每失败一次就往后推）。 */
export function lockModelQuota(config: AiConfig, encodedModel: string, reason: string): ModelQuotaLock | null {
    const { key, model, baseUrl } = quotaLockKey(config, encodedModel);
    if (!model) return null;
    const store = readStore();
    purgeExpired(store);
    const existing = store[key];
    if (existing && existing.until > Date.now()) return { key, model, baseUrl, ...existing };
    const entry = {
        reason: String(reason || "").slice(0, 300),
        lockedAt: Date.now(),
        until: nextQuotaResetAt(),
    };
    store[key] = entry;
    writeStore(store);
    emit();
    console.warn("[quota-lockout] 今日额度用完，已停用该模型到", new Date(entry.until).toLocaleString(), "|", model, "|", entry.reason);
    return { key, model, baseUrl, ...entry };
}

export function clearQuotaLock(config: AiConfig, encodedModel: string): void {
    const { key } = quotaLockKey(config, encodedModel);
    const store = readStore();
    if (!store[key]) return;
    delete store[key];
    writeStore(store);
    emit();
    console.info("[quota-lockout] 已手动恢复该模型的使用");
}

/** 失败文案命中「今日额度用完」才停用；返回停用记录（调用方可以据此改写错误文案）。 */
export function noteModelQuotaFailure(config: AiConfig, encodedModel: string, message: string): ModelQuotaLock | null {
    if (!isDailyQuotaMessage(message)) return null;
    return lockModelQuota(config, encodedModel, message);
}

export function formatQuotaRemaining(until: number, now = Date.now()): string {
    const ms = Math.max(0, until - now);
    const totalMinutes = Math.ceil(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return i18n.t("modelQuota.remainingMinutes", { minutes });
    return i18n.t("modelQuota.remainingHours", { hours, minutes });
}

/** 停用中的话给一句能照着做的话：为什么停、什么时候自己好、想现在用怎么办。 */
export function describeQuotaLock(lock: ModelQuotaLock): string {
    return i18n.t("modelQuota.locked", {
        model: modelOptionName(lock.model),
        remaining: formatQuotaRemaining(lock.until),
        time: new Date(lock.until).toLocaleString(),
    });
}

/**
 * 提交前的闸门：停用期间**不发请求**，直接把原因和时间告诉用户。
 * 注意只该拦「提交」，正在跑的任务轮询不能被它拦（那会把一条快好的任务打成失败）。
 */
export function assertModelQuotaAvailable(config: AiConfig, encodedModel: string): void {
    const lock = getQuotaLock(config, encodedModel);
    if (!lock) return;
    throw new Error(describeQuotaLock(lock));
}

/**
 * 提交前闸门 + 失败记账，一次包装搞定：
 *   · 停用中 → 直接抛，不发请求（省一次白跑，也不给上游添堵）；
 *   · 内层抛错且文案是「今日额度用完」→ 停用到次日 0 点，并在原文后面补一句「已暂停，几点回来」。
 *
 * 🔴 取消必须原样抛：`DOMException("AbortError")` / `axios.CanceledError` 一旦被包成新 Error，
 * 上层 `isGenerationCanceled()` 就认不出来，用户点了「停止」反而会看到一条红色报错。
 */
export async function withModelQuotaGuard<T>(config: AiConfig, encodedModel: string, run: () => Promise<T>): Promise<T> {
    assertModelQuotaAvailable(config, encodedModel);
    try {
        return await run();
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isCancel(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const lock = noteModelQuotaFailure(config, encodedModel, message);
        if (!lock) throw error;
        const wrapped = new Error(`${message}\n\n${describeQuotaLock(lock)}`);
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
    }
}
