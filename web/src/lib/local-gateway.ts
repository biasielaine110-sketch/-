// 「本机网关 → 公网入口」映射的**单一来源**。
//
// 🔴 为什么需要在 API 层也做这件事（2026-11-26 用户报障）：线上画布是
// `https://….pages.dev`，渠道 baseUrl 却常配成 `http://127.0.0.1:17800`（本机 quota-flow）。
// 以前只把**媒体地址**换成公开地址（`media-portable.ts` 的 `preferPublicMediaUrl`），
// 而**提交请求本身**仍然直连 loopback。Chrome 142 起默认启用 Local Network Access（LNA）：
// 公网来源的页面访问 127.0.0.1 / localhost 必须用户明确授权，提示很轻、容易被顺走，
// 一旦拒绝就是**静默挂起**——业务代码只看到超时，画布上表现成「一直在读秒、生成不出东西」。
// 同一份配置在 Firefox / 旧版 Edge 上照常跑，所以现象看起来像「Chrome 坏了」。
//
// 老的 PNA 那套 `Access-Control-Allow-Private-Network` 预检已被 LNA 整体替换，
// 网关继续回那个头也没用——**唯一可靠的路是不发 loopback 请求**。
//
// 因此：页面跑在公网时，本机网关的 API / 媒体地址一律先换成它的公网入口；
// 页面自己就跑在本机（dev / 本地部署）时保持直连——那条路最快。
//
// 这个模块**零依赖**（只用 URL），供 `api-proxy.ts` / `media-portable.ts` 共用，
// 避免 `use-config-store → media-portable → api-proxy → use-config-store` 的循环。
//
// 🔴 换 tailnet 域名 / 换网关端口只改这张表。`host` 匹配含端口的 host，
// `local` 是反查（公网入口不通时回退直连）用的本机根。

import { shouldDetourLocalNetwork } from "@/lib/local-network-access";

type LocalGatewayEntry = {
    /** 本机 host（含端口），用于识别。 */
    host: RegExp;
    /** 公网 API 根，已含 Funnel 的路径前缀。 */
    base: string;
    /** 本机 API 根，`downgradePublicGatewayUrl` 用它反查。 */
    local: string;
};

const LOCAL_GATEWAY_PUBLIC_BASES: ReadonlyArray<LocalGatewayEntry> = [
    {
        host: /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):17800$/i,
        base: "https://wb2api.tailb5bc86.ts.net/qf",
        local: "http://127.0.0.1:17800",
    },
];

function parse(raw: string): URL | null {
    const value = String(raw || "").trim();
    if (!/^https?:\/\//i.test(value)) return null;
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

/** 页面自己就在本机/内网 → 直连最快，不该为了「线上」绕公网。 */
function pageRunsLocally(): boolean {
    if (typeof window === "undefined") return false;
    try {
        const host = window.location.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (!host) return false;
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
        if (host === "::1" || host === "0.0.0.0") return true;
        if (/^127\./.test(host)) return true;
        if (/^10\./.test(host)) return true;
        if (/^192\.168\./.test(host)) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
        if (host.endsWith(".lan") || host.endsWith(".ts.net")) return true;
    } catch {
        // 拿不到 location → 按线上处理。
    }
    return false;
}

function entryForLocalHost(host: string): LocalGatewayEntry | null {
    const normalized = String(host || "").toLowerCase();
    return LOCAL_GATEWAY_PUBLIC_BASES.find((item) => item.host.test(normalized)) || null;
}

/** 这个本机网关地址对应的公网 API 根（如 `https://…/qf`）；不认识就返回空。 */
export function publicBaseForLocalGateway(url: string): string {
    const target = parse(url);
    if (!target) return "";
    return entryForLocalHost(target.host)?.base || "";
}

/**
 * 把本机网关 URL 换成公网入口，**保留路径与查询串**：
 * `http://127.0.0.1:17800/v1/images/generations` → `https://…/qf/v1/images/generations`。
 *
 * 页面本身跑在本机时原样返回。不认识的端口原样返回（绝不猜）。
 */
export function upgradeLocalGatewayUrl(url: string): string {
    const raw = String(url || "").trim();
    const target = parse(raw);
    if (!target) return raw;
    if (pageRunsLocally()) return raw;
    // 🔴 只有在 Chrome 明确拒绝了本地网络访问时才绕公网：那一跳要过 Funnel，
    // 中间反代常把慢模型掐成 504（用户看到「120 秒代理读取超时」）。
    // 授权正常（granted / 未知 / 非 Chromium）时一律直连本机 —— 最快，也最不容易坏。
    if (!shouldDetourLocalNetwork()) return raw;
    const entry = entryForLocalHost(target.host);
    if (!entry) return raw;
    const suffix = target.pathname === "/" ? "" : target.pathname.replace(/\/+$/, "");
    const next = `${entry.base.replace(/\/+$/, "")}${suffix}${target.search}`;
    return next === raw ? raw : next;
}

/**
 * 反向：把公网入口地址还原成本机地址，供「公网入口不通时回退直连」使用。
 * 不是这张表里的公网地址就返回空。
 */
export function downgradePublicGatewayUrl(url: string): string {
    const target = parse(url);
    if (!target) return "";
    const head = `${target.protocol}//${target.host}${target.pathname}`;
    for (const entry of LOCAL_GATEWAY_PUBLIC_BASES) {
        let base: URL;
        try {
            base = new URL(entry.base);
        } catch {
            continue;
        }
        const root = `${base.protocol}//${base.host}${base.pathname.replace(/\/+$/, "")}`;
        if (head !== root && !head.startsWith(`${root}/`)) continue;
        const rest = head.slice(root.length);
        return `${entry.local.replace(/\/+$/, "")}${rest}${target.search}`;
    }
    return "";
}

/** 这个地址是不是本表的公网入口（回退逻辑据此判断要不要降级）。 */
export function isLocalGatewayPublicUrl(url: string): boolean {
    const target = parse(url);
    if (!target) return false;
    const head = `${target.protocol}//${target.host}${target.pathname}`;
    return LOCAL_GATEWAY_PUBLIC_BASES.some((entry) => {
        try {
            const base = new URL(entry.base);
            const root = `${base.protocol}//${base.host}${base.pathname.replace(/\/+$/, "")}`;
            return head === root || head.startsWith(`${root}/`);
        } catch {
            return false;
        }
    });
}
