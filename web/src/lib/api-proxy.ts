// Routes cross-origin API/media calls through a same-origin proxy to bypass CORS.
// Dev: Vite middleware at /api-proxy (long timeout)
// Production: Vercel serverless /api/proxy (Hobby capped ~60s — too short for many LLM chats)
//
// Default API transport is "direct" so browser talks to the provider without the
// Vercel duration cap. Use "proxy" only when the provider blocks CORS.
// Remote media always goes through the proxy (canvas / tainted-image safety).

import { CONFIG_STORE_KEY, type ApiTransport } from "@/stores/use-config-store";

export function resolveApiTransport(): ApiTransport {
    try {
        if (typeof window === "undefined") return "direct";
        const raw = window.localStorage.getItem(CONFIG_STORE_KEY);
        if (!raw) return "direct";
        const parsed = JSON.parse(raw) as { state?: { config?: { apiTransport?: string } } };
        const mode = parsed?.state?.config?.apiTransport;
        if (mode === "proxy" || mode === "direct") return mode;
    } catch {
        // ignore corrupt storage
    }
    return "direct";
}

export function proxyApiUrl(directUrl: string): string {
    try {
        const target = new URL(directUrl);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return directUrl;
        if (target.protocol !== "http:" && target.protocol !== "https:") return directUrl;
        if (resolveApiTransport() === "direct") return directUrl;
        return buildProxyUrl(directUrl);
    } catch {
        return directUrl;
    }
}

/** Always proxy remote media — independent of API transport setting. */
export function proxyMediaUrl(directUrl: string): string {
    try {
        const target = new URL(directUrl);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return directUrl;
        if (target.protocol !== "http:" && target.protocol !== "https:") return directUrl;
        return buildProxyUrl(directUrl);
    } catch {
        return directUrl;
    }
}

function buildProxyUrl(directUrl: string) {
    const path = import.meta.env.DEV ? "/api-proxy" : "/api/proxy";
    return `${path}?target=${encodeURIComponent(directUrl)}`;
}
