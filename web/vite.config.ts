import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { outboundFetch } from "./api/outbound-fetch.js";
import { handleCanvasBridge } from "./api/canvas-bridge.js";

const webDir = dirname(fileURLToPath(import.meta.url));

/** undici/Node wrap the real failure (DNS, refused, reset, abort) in `cause` — surface it. */
function describeError(error: unknown): string {
    const base = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return cause && !base.includes(cause) ? `${base} (${cause})` : base;
}

// Transient stream/network errors must not take down the whole dev server (an unhandled
// Readable 'error' event crashes Node). Only swallow these known-benign categories; real
// bugs still propagate through the outer catch / crash normally.
const BENIGN_STREAM_ERROR = /timeout|abort|ECONNRESET|EPIPE|premature close|fetch failed|UND_ERR/i;
process.on("uncaughtException", (error) => {
    if (BENIGN_STREAM_ERROR.test(`${error.message} ${error.name}`)) {
        console.warn(`[api-proxy] ignored transient error: ${describeError(error)}`);
        return;
    }
    console.error("[api-proxy] fatal uncaught exception:", error);
    process.exit(1);
});

// Dev-server forward proxy for CORS-blocked API targets (relay/中转 API providers usually
// do not send CORS headers). Frontend calls /api-proxy?target=<full api url>; this middleware
// forwards the request server-side and streams the response back, bypassing browser CORS.
function apiProxyPlugin(): Plugin {
    return {
        name: "canvas-api-proxy",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use("/api-proxy", (req, res, next) => {
                void (async () => {
                    try {
                        const url = new URL(req.url || "", "http://localhost");
                        const target = url.searchParams.get("target");
                        if (!target) {
                            res.statusCode = 400;
                            res.end("missing target");
                            return;
                        }
                        const targetUrl = new URL(target);
                        const headers: Record<string, string> = {};
                        const skipHeaders = new Set([
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
                            "sec-ch-ua",
                            "sec-ch-ua-mobile",
                            "sec-ch-ua-platform",
                        ]);
                        for (const [key, value] of Object.entries(req.headers)) {
                            if (!value || skipHeaders.has(key.toLowerCase())) continue;
                            headers[key] = Array.isArray(value) ? value.join(", ") : value;
                        }
                        headers.host = targetUrl.host;
                        // Ask upstream for plain bodies. Stripping content-encoding while
                        // still receiving gzip bytes makes JSON clients see binary garbage.
                        headers["accept-encoding"] = "identity";
                        const body = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await readRequestBody(req) : undefined;
                        const upstream = await outboundFetch(targetUrl, {
                            method: req.method,
                            headers,
                            body: body ? new Uint8Array(body) : undefined,
                            signal: AbortSignal.timeout(500_000),
                        });
                        if (upstream.status >= 400) {
                            const errorText = await upstream.clone().text().catch(() => "");
                            const bodyPreview = body ? Buffer.from(body).toString("utf8").slice(0, 800) : "";
                            console.warn(
                                `[api-proxy] ${upstream.status} ${targetUrl.href}\nrequest: ${bodyPreview}\nresponse: ${errorText.slice(0, 800)}`,
                            );
                        }
                        res.statusCode = upstream.status;
                        upstream.headers.forEach((value, key) => {
                            if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) res.setHeader(key, value);
                        });
                        if (upstream.body) {
                            const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
                            // pipeline forwards/handles stream errors (unlike bare pipe(), whose
                            // unhandled 'error' event kills the whole dev server process).
                            try {
                                await pipeline(stream, res);
                            } catch (streamError) {
                                console.warn(`[api-proxy] stream aborted: ${describeError(streamError)}`);
                                res.destroy();
                            }
                        } else {
                            res.end();
                        }
                    } catch (error) {
                        // undici's bare "fetch failed" hides the real reason (DNS / refused / reset)
                        // in `cause` — surface it so a 502 here is diagnosable.
                        const detail = describeError(error);
                        console.warn(`[api-proxy] outbound failed: ${detail}`);
                        if (res.headersSent) {
                            res.destroy();
                            return;
                        }
                        res.statusCode = 502;
                        res.end(`proxy error: ${detail}`);
                    }
                })();
            });
        },
    };
}

function canvasBridgePlugin(): Plugin {
    const handler = (req: IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => {
        const pathname = (req.url || "").split("?")[0];
        if (pathname !== "/mcp" && !pathname.startsWith("/api/canvas-bridge")) {
            next();
            return;
        }
        void handleCanvasBridge(req, res).catch((error: unknown) => {
            if (res.headersSent) return;
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
        });
    };
    return {
        name: "canvas-workbuddy-bridge",
        configureServer(server) {
            server.middlewares.stack.unshift({ route: "", handle: handler });
        },
        configurePreviewServer(server) {
            server.middlewares.stack.unshift({ route: "", handle: handler });
        },
    };
}

function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolveBody) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolveBody(chunks.length ? Buffer.concat(chunks) : undefined));
        req.on("error", () => resolveBody(undefined));
    });
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), apiProxyPlugin(), canvasBridgePlugin()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
});
