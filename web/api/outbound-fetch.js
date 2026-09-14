// Shared Node fetch helper for CORS proxies.
// Local networks (e.g. CN) often need HTTP(S)_PROXY for outbound HTTPS;
// Node/undici fetch ignores those env vars unless a ProxyAgent is attached.

import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

const COMMON_LOCAL_PROXIES = ["http://127.0.0.1:7897", "http://127.0.0.1:7890", "http://127.0.0.1:10809"];
const DIRECT_CONNECT_TIMEOUT_MS = 8_000;

/** @type {string | false | undefined} `false` = already probed, no working proxy */
let cachedProxyUrl;
const directAgent = new Agent({ connect: { timeout: DIRECT_CONNECT_TIMEOUT_MS } });
/** @type {Map<string, import("undici").ProxyAgent>} */
const proxyAgents = new Map();

function envProxyUrl() {
    return (
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.ALL_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy ||
        process.env.all_proxy ||
        ""
    ).trim();
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
        return undiciFetch(url, { ...init, dispatcher: agentForProxy(fromEnv) });
    }

    if (cachedProxyUrl) {
        return undiciFetch(url, { ...init, dispatcher: agentForProxy(cachedProxyUrl) });
    }

    try {
        return await undiciFetch(url, { ...init, dispatcher: directAgent });
    } catch (error) {
        if (cachedProxyUrl === false || !isConnectFailure(error)) {
            throw withProxyHint(error);
        }

        for (const candidate of COMMON_LOCAL_PROXIES) {
            try {
                const response = await undiciFetch(url, { ...init, dispatcher: agentForProxy(candidate) });
                cachedProxyUrl = candidate;
                console.info(`[api-proxy] outbound via local proxy ${candidate}`);
                return response;
            } catch {
                // try next candidate
            }
        }

        cachedProxyUrl = false;
        throw withProxyHint(error);
    }
}

function withProxyHint(error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`${message} (set HTTPS_PROXY=http://127.0.0.1:7897 if you use a local proxy)`);
    wrapped.cause = error instanceof Error ? error.cause || error : error;
    return wrapped;
}
