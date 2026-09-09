// Routes cross-origin API/media calls through a same-origin proxy to bypass CORS.
// Dev: Vite middleware at /api-proxy
// Production: Vercel serverless function at /api/proxy
// Most relay CDN hosts (中转站) do not send Access-Control-Allow-Origin headers.
export function proxyApiUrl(directUrl: string): string {
    try {
        const target = new URL(directUrl);
        if (typeof window !== "undefined" && target.origin === window.location.origin) return directUrl;
        if (target.protocol !== "http:" && target.protocol !== "https:") return directUrl;
        const path = import.meta.env.DEV ? "/api-proxy" : "/api/proxy";
        return `${path}?target=${encodeURIComponent(directUrl)}`;
    } catch {
        return directUrl;
    }
}
