// Routes cross-origin API/media calls through a same-origin proxy to bypass CORS.
// Dev: Vite middleware at /api-proxy (long timeout ~500s)
// Production: Vercel serverless /api/proxy (Fluid Compute Hobby/Pro default up to ~300s)
//
// Default transport is "proxy" because most relay APIs omit Access-Control-Allow-Origin
// (Ark CORS allow-headers also omit Authorization, so browser Direct usually fails).
// Users can switch to "direct" in preferences when the provider allows CORS.

import { CONFIG_STORE_KEY, type ApiTransport } from "@/stores/use-config-store";

/**
 * Hosts that are known to send permissive CORS headers (Access-Control-Allow-Origin: *
 * plus Authorization) AND that are frequently unreachable from the Vercel serverless
 * edge (CN-only providers that rate-limit or block overseas IPs). For these we always
 * POST directly from the browser, bypassing the /api/proxy hop that otherwise 502s.
 */
const DIRECT_CORS_HOSTS = [
    "autodl.art",
    "runninghub.cn",
];

function isDirectCorsHost(origin: string): boolean {
    const host = origin.replace(/:\d+$/, "").toLowerCase();
    return DIRECT_CORS_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function resolveApiTransport(): ApiTransport {
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

export function proxyApiUrl(directUrl: string): string {
    const normalized = normalizeProxyTarget(directUrl);
    try {
        const target = new URL(normalized);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return normalized;
        if (target.protocol !== "http:" && target.protocol !== "https:") return normalized;
        if (resolveApiTransport() === "direct") return normalized;
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
        // CORS-open CN hosts are unreachable from the serverless edge — go direct.
        if (isDirectCorsHost(target.host)) return normalized;
        return buildProxyUrl(normalized);
    } catch {
        return normalized;
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
