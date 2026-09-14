// Routes cross-origin API/media calls through a same-origin proxy to bypass CORS.
// Dev: Vite middleware at /api-proxy (long timeout ~500s)
// Production: Vercel serverless /api/proxy (Fluid Compute Hobby/Pro default up to ~300s)
//
// Default transport is "proxy" because most relay APIs omit Access-Control-Allow-Origin
// (Ark CORS allow-headers also omit Authorization, so browser Direct usually fails).
// Users can switch to "direct" in preferences when the provider allows CORS.

import { CONFIG_STORE_KEY, type ApiTransport } from "@/stores/use-config-store";

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
