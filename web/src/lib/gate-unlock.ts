/**
 * 口令门禁的「记住 7 天」记录。
 *
 * 配置弹窗 / 独立配置页 / 文本节点词库各自是一道门，用 gateId 区分：
 * 一处通过密码不会顺带放开另一处，但每一处自己都会免密 7 天。
 *
 * 只存「通过的时刻」（毫秒时间戳），不存密码本身；过期判定 = 时刻 + TTL > 现在。
 * 纯前端门禁，清掉 localStorage 就退回需要重新输入。
 */

const STORAGE_KEY = "infinite-canvas:gate-unlock";

/** 免密有效时长：7 天。 */
export const GATE_UNLOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 配置（弹窗 + 独立配置页共用同一道门）。 */
export const CONFIG_GATE_ID = "config";
/** 文本节点词库。 */
export const TEXT_PROMPT_GATE_ID = "text-prompt-library";

type GateUnlockMap = Record<string, number>;

function readAll(): GateUnlockMap {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: GateUnlockMap = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            const stamp = typeof value === "number" ? value : Number(value);
            // 脏数据（NaN / 非正数）直接丢掉，宁可按「未解锁」处理。
            if (Number.isFinite(stamp) && stamp > 0) out[id] = stamp;
        }
        return out;
    } catch {
        // 隐私模式 / 配额满 / JSON 坏了都不该把门禁弄死，按未解锁处理。
        return {};
    }
}

function writeAll(map: GateUnlockMap) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
        // 写不进去就退化成「每次都要输密码」，不影响功能。
    }
}

/** 该门禁是否还在 7 天免密期内。 */
export function isGateUnlocked(gateId: string): boolean {
    const stamp = readAll()[gateId];
    if (!stamp) return false;
    return stamp + GATE_UNLOCK_TTL_MS > Date.now();
}

/** 记录一次通过密码，从现在起免密 7 天。 */
export function markGateUnlocked(gateId: string): void {
    const now = Date.now();
    const map = readAll();
    // 顺手清掉已过期的记录，避免这个 key 越积越多。
    for (const [id, stamp] of Object.entries(map)) {
        if (stamp + GATE_UNLOCK_TTL_MS <= now) delete map[id];
    }
    map[gateId] = now;
    writeAll(map);
}

/** 手动作废（目前只在需要强制重新验证时用）。 */
export function clearGateUnlock(gateId: string): void {
    const map = readAll();
    if (!(gateId in map)) return;
    delete map[gateId];
    writeAll(map);
}

/** 距离下次需要重新输入还有多久（毫秒）；未解锁返回 0。 */
export function gateUnlockRemainingMs(gateId: string): number {
    const stamp = readAll()[gateId];
    if (!stamp) return 0;
    return Math.max(0, stamp + GATE_UNLOCK_TTL_MS - Date.now());
}

/** 免密还剩几天（向上取整，未解锁返回 0）。 */
export function gateUnlockRemainingDays(gateId: string): number {
    const remaining = gateUnlockRemainingMs(gateId);
    return remaining > 0 ? Math.ceil(remaining / (24 * 60 * 60 * 1000)) : 0;
}
