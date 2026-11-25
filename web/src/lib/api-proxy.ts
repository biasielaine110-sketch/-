// Routes cross-origin API/media calls through a same-origin proxy to bypass CORS.
// Dev: Vite middleware at /api-proxy (long timeout ~500s)
// Production: Vercel serverless /api/proxy (Fluid Compute Hobby/Pro default up to ~300s)
//
// Default transport is "proxy" because most relay APIs omit Access-Control-Allow-Origin
// (Ark CORS allow-headers also omit Authorization, so browser Direct usually fails).
// Users can switch to "direct" in preferences when the provider allows CORS.

import { CONFIG_STORE_KEY, buildApiUrl, type ApiTransport } from "@/stores/use-config-store";

/**
 * Hosts that are known to send permissive CORS headers (Access-Control-Allow-Origin: *
 * plus Authorization) AND that are frequently unreachable from the Vercel serverless
 * edge (CN-only providers that rate-limit or block overseas IPs). For these we always
 * POST directly from the browser, bypassing the /api/proxy hop that otherwise 502s.
 */
const DIRECT_CORS_HOSTS = [
    "autodl.art",
    "runninghub.cn",
    // runninghub.ai (海外站). Same API surface as runninghub.cn, verified 2026-10-22 against
    // https://infinite-atelier.pages.dev: OPTIONS /task/openapi/create → 204 with
    // `ACAO: https://infinite-atelier.pages.dev` + `ACAH: authorization,content-type`, and every
    // other endpoint we hit (/task/openapi/upload `ACAO: *`, /outputs, /status, /v2/query,
    // /getJsonApiFormat, /comfy/run) answers with permissive ACAO too.
    // Why it must not go through /api/proxy: task creation posts a JSON body (workflow nodeInfoList
    // / full graph, tens of KB) and the CF-Pages → upstream hop resets the request body, which shows
    // up in the UI as `/api/proxy?target=https://www.runninghub.ai/.../create` failing. Browser-direct
    // skips Cloudflare entirely — same reasoning as runninghub.cn above.
    "runninghub.ai",
    // RunningHub result-file CDN (rh-images/rh-videos *.xiaoyaoyou.com, ByteDance TOS fronted).
    // Verified per-host: sends `Access-Control-Allow-Origin: *` + `Allow-Methods: GET, HEAD`, so a
    // plain media GET passes CORS straight from the browser, while the Vercel edge (overseas)
    // cannot reach this CN-only host and /api/proxy just 502s on it.
    "xiaoyaoyou.com",
    // Tailscale Funnel / Serve public HTTPS (e.g. wb2api.*.ts.net). Verified OPTIONS→204 with
    // ACAO for https://infinite-atelier.pages.dev + Allow-Headers authorization,content-type.
    // Cloudflare Pages /api/proxy often cannot reach Funnel (or gets reset), which surfaces as
    // networkFailed with `/api/proxy?target=…/images/edits` for cn:miora-image-edit etc.
    "ts.net",
    // aicost.me (New API relay). Verified 2026-10-21 against https://infinite-atelier.pages.dev:
    // OPTIONS /v1/images/edits → 204 with `ACAO: *` + `ACAH: *` + `ACAM: GET,POST,PUT,DELETE,OPTIONS`,
    // and the same `ACAO: *` on actual responses (/v1/images/edits 401, /v1/models 401).
    // Why it must not go through /api/proxy: image edits are multipart with reference files, and the
    // CF-Pages → aicost hop is what dies mid-body — Chrome shows
    // `net::ERR_HTTP2_PROTOCOL_ERROR` on `/api/proxy?target=…/v1/images/edits` even for a 700KB body
    // (the local Function relays 6MB fine, so it is that hop, not our code). Browser→aicost direct
    // sidesteps Cloudflare entirely.
    "aicost.me",
    // Do NOT list seetacloud / cpolar / ngrok here: those ComfyUI gateways omit CORS for the
    // canvas origin, so browser-direct fails. They must stay on /api/proxy (+ allow_custom_ports).
];

/**
 * 本机 / 内网地址（loopback、RFC1918、link-local、`.local`）。
 *
 * 🔴 站点代理 `/api/proxy` 跑在 Cloudflare 边缘，**永远到不了用户自己的机器**：
 * `http://127.0.0.1:17800/v1/files/x.mp4` 在边缘只会被 SSRF 规则挡成 403。
 * 所以「本机网关返回的成片地址」必须由**浏览器直连**读取（HTTPS 页面访问
 * `http://127.0.0.1` 属于 loopback 豁免，Chrome 不会按混合内容拦）。
 *
 * 用户 2026-11-25 第 04 条：qf 渠道（本机 quota-flow 网关 :17800）生成的视频
 * 既播不了也下载不了，控制台就是「直连 ERR_CONNECTION_REFUSED + /api/proxy 403」两条。
 */
export function isLocalNetworkHost(host: string): boolean {
    const name = String(host || "")
        .toLowerCase()
        .replace(/:\d+$/, "")
        .replace(/^\[/, "")
        .replace(/\]$/, "");
    if (!name) return false;
    if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
    if (name === "::1" || name === "0.0.0.0" || name === "::") return true;
    if (/^127\./.test(name)) return true;
    if (/^10\./.test(name)) return true;
    if (/^192\.168\./.test(name)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
    // link-local（含云厂商 metadata 地址段）——同样只有本机浏览器能到。
    if (/^169\.254\./.test(name)) return true;
    return false;
}

/** 同上，入参是完整 URL。解析失败按「不是内网」处理，保持旧行为。 */
export function isLocalNetworkUrl(url: string): boolean {
    try {
        if (!url) return false;
        const target = new URL(normalizeProxyTarget(url), typeof window !== "undefined" ? window.location.origin : "http://localhost");
        return isLocalNetworkHost(target.host);
    } catch {
        return false;
    }
}

function isDirectCorsHost(origin: string): boolean {
    const host = origin.replace(/:\d+$/, "").toLowerCase();
    return DIRECT_CORS_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * True when `url` points at a host we deliberately keep browser-direct because it sends
 * permissive CORS headers. A request to such a host that dies with no response is therefore
 * NOT a cross-origin block — the host is down (dead tunnel, TLS failure, DNS). Callers use this
 * to avoid telling users to "fix CORS" when the real cause is an unreachable endpoint.
 */
export function isKnownDirectCorsUrl(url: string): boolean {
    try {
        if (!url) return false;
        const target = new URL(normalizeProxyTarget(url), typeof window !== "undefined" ? window.location.origin : "http://localhost");
        if (target.protocol !== "http:" && target.protocol !== "https:") return false;
        return isDirectCorsHost(target.host);
    } catch {
        return false;
    }
}

/**
 * Resolve API transport. Optional `override` comes from a channel's `apiTransport`
 * (via resolveModelRequestConfig); when omitted, fall back to global Preferences.
 */
export function resolveApiTransport(override?: ApiTransport | null): ApiTransport {
    if (override === "direct" || override === "proxy") return override;
    try {
        if (typeof window === "undefined") return "proxy";
        const raw = window.localStorage.getItem(CONFIG_STORE_KEY);
        if (!raw) return "proxy";
        const parsed = JSON.parse(raw) as { state?: { config?: { apiTransport?: string } } };
        const mode = parsed?.state?.config?.apiTransport;
        if (mode === "proxy" || mode === "direct") return mode;
    } catch {
        // ignore corrupt storage
    }
    return "proxy";
}

export function proxyApiUrl(directUrl: string, transport?: ApiTransport | null): string {
    const normalized = normalizeProxyTarget(directUrl);
    try {
        const target = new URL(normalized);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return normalized;
        if (target.protocol !== "http:" && target.protocol !== "https:") return normalized;
        if (resolveApiTransport(transport) === "direct") return normalized;
        // CORS-open CN hosts are unreachable from the serverless edge — go direct.
        if (isDirectCorsHost(target.host)) return normalized;
        return buildProxyUrl(normalized);
    } catch {
        return normalized;
    }
}

/** Always proxy remote media — independent of API transport setting. */
export function proxyMediaUrl(directUrl: string): string {
    const normalized = normalizeProxyTarget(directUrl);
    try {
        const target = new URL(normalized);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return normalized;
        if (target.protocol !== "http:" && target.protocol !== "https:") return normalized;
        // 本机/内网地址：边缘代理打不到，硬塞进去只会得到 403。必须浏览器直连。
        if (isLocalNetworkHost(target.host)) return normalized;
        // CORS-open CN hosts are unreachable from the serverless edge — go direct.
        if (isDirectCorsHost(target.host)) return normalized;
        return buildProxyUrl(normalized);
    } catch {
        return normalized;
    }
}

/**
 * Build the same-origin media proxy URL unconditionally, ignoring the "known CORS-open host"
 * shortcut above. That list describes API POSTs that carry an Authorization header; a media
 * download is a plain GET, so the shortcut is no evidence the GET will pass CORS. Returns "" when
 * the proxy cannot help at all (same-origin / non-http scheme), letting callers keep the original
 * error instead of retrying against a URL that is guaranteed not to work.
 */
export function forceProxyMediaUrl(directUrl: string): string {
    const normalized = normalizeProxyTarget(directUrl);
    try {
        const target = new URL(normalized);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return "";
        if (target.protocol !== "http:" && target.protocol !== "https:") return "";
        // 本机网关：交给 /api/proxy 只会换来一个 403，还盖掉真正的原因（网关没起来）。
        // 返回 "" 让调用方保留原始错误 / 直接落到本地副本兜底。
        if (isLocalNetworkHost(target.host)) return "";
        return buildProxyUrl(normalized);
    } catch {
        return "";
    }
}

/**
 * 🔴 把「上游眼里的本机地址」换成**当前渠道的公开地址**。
 *
 * quota-flow 这类跑在用户机器上的网关，回给上游的成片地址永远是它自己的视角：
 * `http://127.0.0.1:17800/v1/files/<id>.mp4`。这个地址**只对网关所在那台机器有效**：
 *  - 浏览器开在另一台设备 / 另一个上下文 → `ERR_CONNECTION_REFUSED`（2026-11-25 第 05 条贴的就是这条）；
 *  - 站点代理 `/api/proxy` 跑在 Cloudflare 边缘 → 403，永远到不了用户自己的机器。
 *
 * 同一份字节其实**经渠道的公开域名就能取到**（qf 实测：`https://wb2api.*.ts.net/qf/v1/files/<id>.mp4`
 * 与本机直连拿到完全相同的字节数）。所以这里按 baseUrl 的版本根重拼：
 * `baseUrl(/qf)` + `/v1` + `/files/<id>.mp4`。
 *
 * 只改 `/v1/...` 形状的路径 —— ComfyUI 的 `/view?filename=…`、各类 `/outputs/…` 不在 OpenAI
 * 兼容契约里，硬拼 `baseUrl/v1/...` 只会造出一个不存在的地址，宁可原样返回。
 *
 * 渠道 baseUrl 自己也是本机地址时（用户就配了 `http://127.0.0.1:17800`）没有更公开的地址可换，
 * 同样原样返回，避免把可用地址改成不可用地址。
 */
export function rewriteLocalMediaUrl(url: string, baseUrl?: string | null): string {
    const raw = String(url || "").trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return raw;
    if (!isLocalNetworkUrl(raw)) return raw;
    const base = String(baseUrl || "").trim();
    if (!base || !/^https?:\/\//i.test(base)) return raw;
    // 渠道本身也在本机：换成它只会得到同一个地址（或缺版本根），直接放弃改写。
    if (isLocalNetworkUrl(base)) return raw;
    try {
        const target = new URL(normalizeProxyTarget(raw));
        // 只认 OpenAI 兼容的文件路径（本机网关回报的一律是 `/v1/files/...`）。
        if (!/^\/v1\//i.test(target.pathname)) return raw;
        const relative = `${target.pathname.replace(/^\/v1(?=\/)/i, "")}${target.search}`;
        const next = buildApiUrl(base, relative);
        return next && next !== raw ? next : raw;
    } catch {
        return raw;
    }
}

/**
 * Build a proxied URL for an API POST unconditionally — the alternate rung of a transport ladder.
 *
 * `proxyApiUrl` already returns the direct URL for `DIRECT_CORS_HOSTS` entries, which is right most
 * of the time but leaves no second chance: a relay whose edge resets the connection mid-request
 * (`net::ERR_HTTP2_PROTOCOL_ERROR` in Chrome, seen on aicost.me `/v1/videos`) fails outright even
 * when the proxy hop would still return a readable Cloudflare error page. Callers use this to retry
 * once and then report *that* answer instead of a bare protocol error. Returns "" when the proxy
 * cannot help at all (same-origin / non-http scheme / loopback or RFC1918 host).
 */
export function forceProxyApiUrl(directUrl: string): string {
    const normalized = normalizeProxyTarget(directUrl);
    try {
        const target = new URL(normalized);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return "";
        if (target.protocol !== "http:" && target.protocol !== "https:") return "";
        // 本机 / 内网地址：直连失败时代理也够不着（边缘节点在云端），换一跳只会换个错误。
        if (isEdgeUnreachableHost(target.hostname)) return "";
        return buildProxyUrl(normalized);
    } catch {
        return "";
    }
}

/** Loopback / RFC1918 主机：Cloudflare 边缘永远访问不到，走代理等于换个报错。 */
function isEdgeUnreachableHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) return false;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1" || host === "0.0.0.0") return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host.endsWith(".local") || host.endsWith(".lan")) return true;
    return false;
}

/**
 * True when the URL points at a tunnel host (Tailscale Funnel/Serve `*.ts.net`). Only these deserve
 * the "check Tailscale login / funnel status" advice — telling an ordinary relay user to debug a
 * funnel they never set up just wastes their time.
 */
export function isTunnelCorsUrl(url: string): boolean {
    try {
        const target = new URL(normalizeProxyTarget(String(url || "")), typeof window !== "undefined" ? window.location.origin : "http://localhost");
        const host = target.host.replace(/:\d+$/, "").toLowerCase();
        return host === "ts.net" || host.endsWith(".ts.net");
    } catch {
        return false;
    }
}

function buildProxyUrl(directUrl: string) {
    const target = normalizeProxyTarget(directUrl);
    const path = import.meta.env.DEV ? "/api-proxy" : "/api/proxy";
    return `${path}?target=${encodeURIComponent(target)}`;
}

function normalizeProxyTarget(url: string): string {
    const value = String(url || "").trim();
    if (!value) return value;

    const proxied = readProxyTarget(value);
    const target = proxied || value;
    return trimTrailingProxyUrl(target);
}

function readProxyTarget(url: string): string {
    try {
        const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
        if (!isProxyPath(parsed.pathname)) return "";
        return parsed.searchParams.get("target") || "";
    } catch {
        return "";
    }
}

function isProxyPath(pathname: string) {
    return pathname === "/api/proxy" || pathname === "/api-proxy";
}

function trimTrailingProxyUrl(url: string): string {
    const firstProxy = findProxyUrlStart(url);
    if (firstProxy === -1) return url;
    return url.slice(0, firstProxy).trim();
}

function findProxyUrlStart(url: string) {
    const markers = ["http://", "https://", "/api/proxy?target=", "/api-proxy?target="];
    let best = -1;
    for (const marker of markers) {
        const index = url.indexOf(marker, 1);
        if (index !== -1 && (best === -1 || index < best) && isProxyUrlFragment(url.slice(index))) best = index;
    }
    return best;
}

function isProxyUrlFragment(fragment: string) {
    try {
        const parsed = new URL(fragment, typeof window !== "undefined" ? window.location.origin : "http://localhost");
        return isProxyPath(parsed.pathname) && parsed.searchParams.has("target");
    } catch {
        return false;
    }
}
