/**
 * 站点访问门禁（进入画布前先输密码）。
 *
 * 口径（用户 2026-11-08）：
 *  - 打开网站要输密码；**通过一次免密 1 天**，到期再问（不是「一天内每次打开都不用输」，也不是永久）；
 *  - 密码框**不做「小眼睛」显示 / 隐藏**（`Input.Password` 的 `visibilityToggle={false}`，与配置口令一致）。
 *
 * 只存「什么时候放行的」（毫秒时间戳），**不存密码、不存会话令牌**；清掉 localStorage 就退回要重新输。
 *
 * ⚠️ 说清楚它的性质：这是**纯前端门禁**，拦的是「顺手点开链接的人」，不是有心人 ——
 * 密码与判定逻辑都在打包产物里，绕过办法是改 localStorage。真要保密只能上 Cloudflare Access
 * 或服务端校验，那个不是这一层能解决的，别在这里加复杂度假装安全。
 */

/** 放行记录（key 加前缀，避免与画布自己的 localStorage 撞）。 */
export const ACCESS_GATE_STORAGE_KEY = "infinite-canvas:site-access";

/** 免密时长：1 天。 */
export const ACCESS_GATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 站点访问密码。
 *
 * 配置口令（`app-config-modal.tsx` 的 `CONFIG_GATE_PASSWORD`）与它**同源**，改密码只改这里。
 */
export const ACCESS_GATE_PASSWORD = "zhangbiwen123456";

type AccessRecord = { exp: number };

/**
 * 读放行记录。
 *
 * 脏数据（非对象 / `exp` 不是正数 / JSON 坏了 / 隐私模式不让读）一律当「没放行」——
 * 门禁宁可多问一次密码，也不能因为读失败就放人进去。
 */
function readAccessRecord(): AccessRecord | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(ACCESS_GATE_STORAGE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const exp = Number((parsed as { exp?: unknown }).exp);
        if (!Number.isFinite(exp) || exp <= 0) return null;
        return { exp };
    } catch {
        return null;
    }
}

/** 现在是否还在免密期内。 */
export function isAccessGranted(now: number = Date.now()): boolean {
    const record = readAccessRecord();
    if (!record) return false;
    return record.exp > now;
}

/** 记录一次通过密码，从现在起免密 1 天。返回到期时间戳（写不进去也返回，只是下次还得输）。 */
export function grantAccess(now: number = Date.now()): number {
    const exp = now + ACCESS_GATE_TTL_MS;
    if (typeof window === "undefined") return exp;
    try {
        window.localStorage.setItem(ACCESS_GATE_STORAGE_KEY, JSON.stringify({ exp }));
    } catch {
        // 配额满 / 隐私模式：退化成「每次都要输密码」，不影响使用。
    }
    return exp;
}

/** 手动收回放行（调试 / 以后要加「退出」入口时用）。 */
export function revokeAccess(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(ACCESS_GATE_STORAGE_KEY);
    } catch {
        // 忽略：删不掉下次照样要输密码（因为判定读的是 exp，已过期就是过不了）。
    }
}

/** 还剩多久免密（毫秒；没放行 / 已过期 = 0）。 */
export function remainingAccessMs(now: number = Date.now()): number {
    const record = readAccessRecord();
    if (!record) return 0;
    return Math.max(0, record.exp - now);
}

/** 免密到期时间戳（没放行 = 0）。 */
export function accessExpiry(now: number = Date.now()): number {
    const record = readAccessRecord();
    if (!record || record.exp <= now) return 0;
    return record.exp;
}

/**
 * 「上一次免密是什么时候到期的」（已过期才返回，否则 0）。
 *
 * 只用来在锁屏上说一句「上次的免密已于 11-09 12:59 到期」，让用户知道为什么又要输密码；
 * 判定放行**只认 `isAccessGranted()`**，别拿这个函数当门。
 */
export function expiredAccessExpiry(now: number = Date.now()): number {
    const record = readAccessRecord();
    if (!record || record.exp > now) return 0;
    return record.exp;
}

/**
 * 剩余时长的中文描述（`"23 小时 12 分"` / `"48 分"`）。
 *
 * 只做「人话」展示用：到 0 返回空串，调用方自己决定说什么。
 */
export function describeAccessRemaining(ms: number): string {
    const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
    if (totalMinutes <= 0) return "";
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
    if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
    return `${minutes} 分`;
}

/** 到期时间的简短展示（`"11-09 12:59"`，本地时区）。 */
export function formatAccessExpiry(exp: number): string {
    if (!Number.isFinite(exp) || exp <= 0) return "";
    const date = new Date(exp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 输入归一：两端空白不算密码的一部分（手机上很容易粘出尾随空格）。 */
export function normalizeAccessPassword(input: string): string {
    return String(input ?? "").trim();
}

/** 密码对不对（大小写敏感）。 */
export function isAccessPassword(input: string): boolean {
    return normalizeAccessPassword(input) === ACCESS_GATE_PASSWORD;
}
