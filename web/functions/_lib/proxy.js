/** Edge-compatible CORS proxy for Cloudflare Pages Functions. */

const PROXY_TIMEOUT_MS = 110_000;
const UPLOAD_BUFFER_MAX = 8_000_000;

// Keep content-length for multipart uploads to ComfyUI/nginx.
const SKIP_HEADERS = new Set([
    "host",
    "connection",
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
 * @param {string} pathname
 * @param {string | null} contentType
 * @param {string | null} contentLength
 */
function shouldBufferBody(pathname, contentType, contentLength) {
    const len = Number(contentLength || 0);
    if (Number.isFinite(len) && len > UPLOAD_BUFFER_MAX) return false;
    if (/\/upload(\/|$)/i.test(pathname)) return true;
    if ((contentType || "").toLowerCase().includes("multipart/form-data")) return true;
    if (Number.isFinite(len) && len > 0 && len <= UPLOAD_BUFFER_MAX) return true;
    return false;
}

/**
 * @param {string} target
 * @param {RequestInit} init
 * @param {number} attempts
 */
async function fetchWithRetry(target, init, attempts = 3) {
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await fetch(target, init);
        } catch (error) {
            lastError = error;
            if (i >= attempts - 1) break;
            await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        }
    }
    throw lastError;
}

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
        const contentType = request.headers.get("content-type");
        const contentLength = request.headers.get("content-length");
        const bufferUpload =
            hasBody && shouldBufferBody(targetUrl.pathname, contentType, contentLength);

        /** @type {RequestInit} */
        const init = {
            method,
            headers,
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
            redirect: "follow",
        };

        if (hasBody) {
            if (bufferUpload) {
                // Buffer ComfyUI /upload/image (and similar). Streaming multipart to :8443 through
                // Cloudflare often yields HTTP 522 even when a buffered POST succeeds.
                const buffered = await request.arrayBuffer();
                init.body = buffered.byteLength ? buffered : undefined;
                if (buffered.byteLength) headers.set("content-length", String(buffered.byteLength));
            } else {
                init.body = request.body;
            }
        }

        const upstream = await fetchWithRetry(targetUrl.toString(), init, bufferUpload ? 3 : 1);

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
        const timedOut = /aborted due to timeout|TimeoutError|timed out|network|connect/i.test(message);
        return new Response(
            timedOut
                ? `proxy error: upstream unreachable (${message}). For seetacloud :8443, enable ComfyUI CORS (--enable-cors-header) and switch the app to 浏览器直连, or retry when the pod is idle.`
                : `proxy error: ${message}`,
            { status: 502 },
        );
    }
}
