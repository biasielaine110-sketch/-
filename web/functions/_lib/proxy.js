/** Edge-compatible CORS proxy for Cloudflare Pages Functions. */

const PROXY_TIMEOUT_MS = 110_000;

const SKIP_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "accept-encoding",
    "origin",
    "referer",
    "cookie",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
]);

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleProxy(request) {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
                "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
            },
        });
    }

    try {
        const requestUrl = new URL(request.url);
        const target = requestUrl.searchParams.get("target");
        if (!target) return new Response("missing target", { status: 400 });

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            return new Response("invalid target", { status: 400 });
        }

        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
            return new Response("unsupported protocol", { status: 400 });
        }

        const headers = new Headers();
        for (const [key, value] of request.headers.entries()) {
            if (SKIP_HEADERS.has(key.toLowerCase())) continue;
            headers.set(key, value);
        }
        headers.set("host", targetUrl.host);
        headers.set("accept-encoding", "identity");

        const method = request.method || "GET";
        const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
        const body = hasBody ? await request.arrayBuffer() : undefined;

        const upstream = await fetch(targetUrl, {
            method,
            headers,
            body: body && body.byteLength ? body : undefined,
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
            redirect: "follow",
        });

        const outHeaders = new Headers();
        upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lower)) return;
            outHeaders.set(key, value);
        });
        outHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: outHeaders,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = /aborted due to timeout|TimeoutError|timed out/i.test(message);
        return new Response(
            timedOut
                ? `proxy error: upstream timed out after ${Math.round(PROXY_TIMEOUT_MS / 1000)}s`
                : `proxy error: ${message}`,
            { status: 502 },
        );
    }
}
