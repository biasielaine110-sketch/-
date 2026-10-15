// Production CORS bypass for remote API / media fetches.
// Browser calls same-origin /api/proxy?target=<url>; this function fetches server-side.
// Streams the upstream body through (required for SSE chat); do not buffer the full response.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { outboundFetch } from "./outbound-fetch.js";

export const config = {
    api: {
        bodyParser: false,
        responseLimit: false,
    },
    // Fluid Compute: Hobby max 300s, Pro up to 800s. Keep under Hobby max so deploys stay valid.
    maxDuration: 300,
};

// Abort a few seconds before the platform kills the function.
const PROXY_TIMEOUT_MS = 290_000;

// Error responses MUST carry CORS headers too. Without them the browser classifies the
// response as a cross-origin failure and the canvas shows "cannot reach the API server",
// hiding the real cause (proxy → upstream). Mirrors web/functions/_lib/proxy.js.
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
};

/**
 * @param {import('http').ServerResponse} res
 * @param {string} body
 * @param {number} status
 * @param {import('http').IncomingMessage} req
 */
function sendCorsError(res, body, status, req) {
    res.statusCode = status;
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
        res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
        res.end();
        return;
    }

    try {
        const requestUrl = new URL(req.url || "", "http://localhost");
        const target = requestUrl.searchParams.get("target");
        if (!target) {
            sendCorsError(res, "missing target", 400, req);
            return;
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            sendCorsError(res, "invalid target", 400, req);
            return;
        }

        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
            sendCorsError(res, "unsupported protocol", 400, req);
            return;
        }

        const headers = {};
        const skipHeaders = new Set([
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            // Browser identity headers confuse upstream APIs (e.g. AutoDL returns 403).
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
        ]);
        for (const [key, value] of Object.entries(req.headers)) {
            if (!value) continue;
            const lower = key.toLowerCase();
            if (skipHeaders.has(lower)) continue;
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
        }
        headers.host = targetUrl.host;
        // Prefer uncompressed upstream bodies; we strip content-encoding when forwarding.
        headers["accept-encoding"] = "identity";

        const method = req.method || "GET";
        const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await readRequestBody(req) : undefined;

        const upstream = await outboundFetch(targetUrl, {
            method,
            headers,
            body: body ? new Uint8Array(body) : undefined,
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        });

        res.statusCode = upstream.status;
        upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lower)) return;
            res.setHeader(key, value);
        });

        if (!upstream.body) {
            res.end();
            return;
        }

        // Stream through so SSE / long LLM replies are not held until completion.
        const stream = Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (upstream.body));
        await pipeline(stream, res);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = /aborted due to timeout|TimeoutError|timed out/i.test(message);
        if (!res.headersSent) {
            const detail = timedOut
                ? `upstream timed out after ${Math.round(PROXY_TIMEOUT_MS / 1000)}s`
                : `upstream unreachable (${message})`;
            sendCorsError(
                res,
                `proxy error: ${detail}。站点代理没能连上接口服务器：请稍后重试；` +
                    `也可到「配置 → 偏好设置」把「API 请求方式」改为「浏览器直连」。`,
                timedOut ? 504 : 502,
                req,
            );
            return;
        }
        res.destroy(error instanceof Error ? error : undefined);
    }
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer | undefined>}
 */
function readRequestBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
        req.on("error", () => resolve(undefined));
    });
}
