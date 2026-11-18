// 「直连 → 站点代理」这条两跳阶梯，以及「这是不是浏览器网络层故障」的统一判定。
//
// 为什么需要：aicost.me / runninghub.ai / xiaoyaoyou.com 等站点被刻意列进 `api-proxy.ts` 的
// `DIRECT_CORS_HOSTS`，让浏览器直连绕开 Cloudflare 的 `/api/proxy`（那条 hop 会掐断请求体）。
// 代价是直连这一跳跑在**用户本机网络**上：它可能被 HTTP/2 RST、被本机代理/加速器掐断、被墙，
// 此时 axios 只给出一个没有 response 的传输层错误。视频链路早就有这条阶梯
// （`video.ts` 的 `retryAlternateTransport`），生图/音频之前没有 —— 于是同一类故障在生图里
// 只剩一句「无法连接接口服务器」，用户只能跑去改跨域设置，而跨域根本不是原因。
//
// 🔴 只做「直连失败 → 换站点代理再试一次」这一个方向。反方向不自动做：默认 transport 就是
//    proxy，而绝大多数中转站不支持浏览器 CORS，代理失败后换直连只会拿 `corsRequired`
//    盖掉真实的代理侧错误。

import axios from "axios";

import { forceProxyApiUrl } from "@/lib/api-proxy";

/** 站点代理（Vercel / CF Function）会掐掉过大的请求体：超限的 body 别往代理那条跳送。 */
export const PROXY_BODY_SAFE_BYTES = 3_400_000;

export function estimateBodyBytes(body: unknown): number {
    if (typeof body === "string") return body.length;
    if (typeof FormData !== "undefined" && body instanceof FormData) {
        let total = 0;
        body.forEach((value) => {
            if (typeof value === "string") total += value.length;
            else if (typeof Blob !== "undefined" && value instanceof Blob) total += value.size;
        });
        return total;
    }
    try {
        return JSON.stringify(body ?? "").length;
    } catch {
        return 0;
    }
}

/**
 * 本次请求是不是已经挂在站点代理上了。
 *
 * 🔴 两种拼法都要认：dev 是 `/api-proxy?target=`，生产是 `/api/proxy?target=`（见
 * `api-proxy.ts` 的 `buildProxyUrl`）。老写法 `/\/api(?:-)?proxy\?target=/` 只匹配 dev 那条，
 * 线上永远判不出来 —— 于是「代理侧故障」全被当成跨域/网络错误，文案也白写了。
 */
export function isProxiedApiUrl(url: string): boolean {
    return /\/api(?:[/-])?proxy\?target=/i.test(String(url || ""));
}

/**
 * 浏览器网络层故障 = 一个字节的 HTTP 响应都没拿到。
 *
 * axios 把传输层失败一律折成 `ERR_NETWORK`，HTTP/2 复位（`net::ERR_HTTP2_PROTOCOL_ERROR`）、
 * 连接被掐、TLS 掉线、超时也都落在这一类里 —— 这些恰恰是「换另一条通道可能就好了」的情形。
 * 只要拿到了 response（哪怕是 502 / Cloudflare 错误页）就不算，因为那已经有可读的答案。
 */
export function isTransportFailure(error: unknown): boolean {
    if (!axios.isAxiosError(error) || error.response) return false;
    const code = String((error as { code?: string }).code || "");
    if (!code || code === "ERR_NETWORK" || code === "ERR_FAILED") return true;
    if (/^(ECONNABORTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)$/i.test(code)) return true;
    return /ERR_(HTTP2|HTTP3|CONNECTION|QUIC|SSL|TIMED_OUT|EMPTY_RESPONSE|INCOMPLETE_CHUNKED)/i.test(code);
}

/**
 * 先按 `url` 发一次；若这次是「连接直接断了、没有任何响应」，再换站点代理试一次。
 *
 * 这样做的两个理由：
 *   1. 直连那一跳的抖动有时在代理跳上不成立，换一条就过了（aicost.me 的
 *      `/v1/images/generations` 就常这样：浏览器直连被 RST，代理跳却回得出来）。
 *   2. 两跳都失败时，用户看到的是第二次的答案；如果代理跳能给出 Cloudflare 的
 *      `1016 / 52x` 错误页，那比一句裸的 `ERR_HTTP2_PROTOCOL_ERROR` 有用得多。
 *
 * `url` 已经是代理地址时不做任何兜底（否则等于自己重试自己）。
 */
export async function withProxyFallback<T>(url: string, run: (target: string) => Promise<T>, body?: unknown): Promise<T> {
    try {
        return await run(url);
    } catch (error) {
        if (axios.isCancel(error) || !isTransportFailure(error)) throw error;
        if (isProxiedApiUrl(url)) throw error;
        // body 大到代理跳一定会 413/掐流：换了只是把「连不上」换成「请求体过大」。
        if (estimateBodyBytes(body) > PROXY_BODY_SAFE_BYTES) throw error;
        const alternate = forceProxyApiUrl(url);
        if (!alternate || alternate === url) throw error;
        console.warn("[api] direct hop failed at the transport layer; retrying through the site proxy");
        return run(alternate);
    }
}
