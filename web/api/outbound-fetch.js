// Shared Node fetch helper for CORS proxies.
// Local networks (e.g. CN) often need HTTP(S)_PROXY for outbound HTTPS;
// Node/undici fetch ignores those env vars unless a ProxyAgent is attached.

import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { appendFileSync } from "node:fs";

function diag(msg) {
    try { appendFileSync("proxy-diag.log", `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

const COMMON_LOCAL_PROXIES = ["http://127.0.0.1:7897", "http://127.0.0.1:7890", "http://127.0.0.1:10809"];
const DIRECT_CONNECT_TIMEOUT_MS = 8_000;

/**
 * WorkBuddy (and some other hosts) inject a temporary loopback proxy on a high
 * ephemeral port (e.g. http://127.0.0.1:55657) via HTTP(S)_PROXY. Routing outbound
 * API calls through it is unstable for CN relay providers and drops long SSE streams,
 * producing ERR_CONNECTION_CLOSED / ERR_HTTP2_PING_FAILED on the frontend. Treat any
 * 127.0.0.1 proxy on a port > 10000 as untrusted and ignore it, so outbound requests
 * fall through to direct connect (then to the user's real local proxy 7897).
 */
function isEphemeralLoopbackProxy(proxyUrl) {
    try {
        const u = new URL(proxyUrl);
        if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
        const port = Number(u.port);
        return Number.isFinite(port) && port > 10000;
    } catch {
        return false;
    }
}

/** @type {string | undefined} cached working local proxy; undefined = not yet discovered */
let cachedProxyUrl;
const directAgent = new Agent({ connect: { timeout: DIRECT_CONNECT_TIMEOUT_MS } });
/** @type {Map<string, import("undici").ProxyAgent>} */
const proxyAgents = new Map();

function envProxyUrl() {
    const raw = (
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.ALL_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy ||
        process.env.all_proxy ||
        ""
    ).trim();
    // Ignore host-injected ephemeral loopback proxies (e.g. WorkBuddy's 127.0.0.1:55657):
    // they are unstable for outbound API calls and drop long SSE streams.
    if (raw && isEphemeralLoopbackProxy(raw)) return "";
    return raw;
}

function isConnectFailure(error) {
    const text = `${error instanceof Error ? error.message : String(error)} ${
        error instanceof Error && error.cause instanceof Error ? error.cause.message : ""
    }`;
    return /timeout|fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|Connect|UND_ERR_/i.test(text);
}

function agentForProxy(proxyUrl) {
    let agent = proxyAgents.get(proxyUrl);
    if (!agent || agent.closed) {
        agent = new ProxyAgent(proxyUrl);
        proxyAgents.set(proxyUrl, agent);
    }
    return agent;
}

/**
 * @param {string | URL} url
 * @param {RequestInit} [init]
 */
export async function outboundFetch(url, init = {}) {
    const fromEnv = envProxyUrl();
    if (fromEnv) {
        diag(`using env proxy ${fromEnv} for ${url}`);
        return undiciFetch(url, { ...init, dispatcher: agentForProxy(fromEnv) });
    }

    // A cached proxy can go stale (local proxy restarts, intermittent hangs). On a connect-level
    // failure drop the cache and re-run the full ladder instead of failing the request outright.
    if (cachedProxyUrl) {
        try {
            diag(`using cached proxy ${cachedProxyUrl} for ${url}`);
            return await undiciFetch(url, { ...init, dispatcher: agentForProxy(cachedProxyUrl) });
        } catch (error) {
            if (!isConnectFailure(error)) throw error;
            diag(`cached proxy ${cachedProxyUrl} failed for ${url}, re-probing`);
            console.warn(`[api-proxy] cached proxy ${cachedProxyUrl} unreachable, re-probing outbound paths`);
            cachedProxyUrl = undefined;
        }
    }

    try {
        diag(`direct attempt for ${url}`);
        return await undiciFetch(url, { ...init, dispatcher: directAgent });
    } catch (error) {
        diag(`direct failed for ${url}: ${error instanceof Error ? error.message : String(error)} isConnect=${isConnectFailure(error)}`);
        if (!isConnectFailure(error)) {
            throw withProxyHint(error);
        }

        for (const candidate of COMMON_LOCAL_PROXIES) {
            try {
                diag(`trying proxy ${candidate} for ${url}`);
                const response = await undiciFetch(url, { ...init, dispatcher: agentForProxy(candidate) });
                cachedProxyUrl = candidate;
                diag(`proxy ${candidate} OK for ${url} status=${response.status}`);
                console.info(`[api-proxy] outbound via local proxy ${candidate}`);
                return response;
            } catch (proxyErr) {
                const cause = proxyErr instanceof Error && proxyErr.cause instanceof Error ? proxyErr.cause.message : "";
                diag(`proxy ${candidate} FAILED for ${url}: msg=${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)} cause=${cause.slice(0, 100)}`);
                // try next candidate
            }
        }

        // No local proxy could reach this host. Do not poison the global cache —
        // a different host may still be reachable directly or via the same proxy.
        throw withProxyHint(error);
    }
}

function withProxyHint(error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`${message} (set HTTPS_PROXY=http://127.0.0.1:7897 if you use a local proxy)`);
    wrapped.cause = error instanceof Error ? error.cause || error : error;
    return wrapped;
}
