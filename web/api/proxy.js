// Production CORS bypass for remote API / media fetches.
// Browser calls same-origin /api/proxy?target=<url>; this function fetches server-side.
// Streams the upstream body through (required for SSE chat); do not buffer the full response.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
        res.end();
        return;
    }

    try {
        const requestUrl = new URL(req.url || "", "http://localhost");
        const target = requestUrl.searchParams.get("target");
        if (!target) {
            res.statusCode = 400;
            res.end("missing target");
            return;
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            res.statusCode = 400;
            res.end("invalid target");
            return;
        }

        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
            res.statusCode = 400;
            res.end("unsupported protocol");
            return;
        }

        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!value) continue;
            const lower = key.toLowerCase();
            if (["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(lower)) continue;
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
        }
        headers.host = targetUrl.host;

        const method = req.method || "GET";
        const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await readRequestBody(req) : undefined;

        const upstream = await fetch(targetUrl, {
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
            res.statusCode = 502;
            res.end(timedOut ? `proxy error: upstream timed out after ${Math.round(PROXY_TIMEOUT_MS / 1000)}s` : `proxy error: ${message}`);
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
