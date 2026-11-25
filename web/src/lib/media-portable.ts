import { isLocalNetworkUrl, rewriteLocalMediaUrl } from "@/lib/api-proxy";
import { resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

/**
 * 已知「本机网关 → 公网入口」映射（用户 2026-11-25 第 06 条）。
 *
 * 为什么需要这张表：`portableMediaUrls` 原本只从**渠道配置**里推公开地址，可 qf 渠道的
 * `baseUrl` 本身就是 `http://127.0.0.1:17800`（本机 quota-flow / WorkBuddy2API 网关）——
 * `rewriteLocalMediaUrl` 对「base 也在本机」直接放弃改写，于是候选表恒空，
 * 浏览器一遇到 loopback 连不上就只剩 `ERR_CONNECTION_REFUSED`，而同一份字节经 Tailscale
 * Funnel 完全能取到（实测 1,444,676 B / `video/mp4`）。
 *
 * `base` 只要写到「API 根」即可：`rewriteLocalMediaUrl` 会剥掉源地址的 `/v1`，
 * 再由 `buildApiUrl` 把 `/v1` 补回去（`.../qf` → `.../qf/v1/files/<id>.mp4`）。
 *
 * 🔴 换 tailnet 域名 / 换网关端口时改这里。匹配的是 `host`（含端口）。
 */
const LOCAL_GATEWAY_PUBLIC_BASES: ReadonlyArray<{ host: RegExp; base: string }> = [
    { host: /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):17800$/i, base: "https://wb2api.tailb5bc86.ts.net/qf" },
];

/** 这个本机地址属于哪个已知网关 → 它的公网 API 根（没有则空数组）。 */
function publicBasesForLocalHost(url: string): string[] {
    try {
        const host = new URL(url).host.toLowerCase();
        return LOCAL_GATEWAY_PUBLIC_BASES.filter((entry) => entry.host.test(host)).map((entry) => entry.base);
    } catch {
        return [];
    }
}

/**
 * 旧节点里的「本机网关成片地址」还能救回来的候选地址。
 *
 * 🔴 背景（用户 2026-11-25 第 05 条）：qf 渠道（本机 quota-flow 网关 `127.0.0.1:17800`）生成的成片，
 * 被节点原样存成了 `http://127.0.0.1:17800/v1/files/<id>.mp4`。这个地址只对「网关所在那台机器的
 * 那个进程」有效，页面一换设备 / 网关一重启 / 浏览器把 loopback 也走了代理，就是
 * `ERR_CONNECTION_REFUSED`，而同一份字节经渠道公开域名（Tailscale Funnel）是能完整取到的。
 *
 * 新生成的成片已经在解析阶段改写成公开地址（见 `services/api/video.ts` 的 `videoResultFromUrl`），
 * 这个函数只服务**存量节点**：播放失败 / 下载失败时按当前配置把 `127.0.0.1` 版地址重拼出公开版，
 * 逐个试过去。取不到就老实报错，不猜、不静默改写节点数据。
 *
 * 候选顺序：① 内置的「本机网关 → 公网入口」映射（渠道 baseUrl 也是本机时唯一的线索）→
 * ② 节点自己记录的模型所在渠道 → ③ 配置里的全部渠道（去重）。
 * 都改写不出不同地址时返回空数组，调用方保持原有行为。
 */
export function portableMediaUrls(url: string, model?: string | null): string[] {
    const raw = String(url || "").trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return [];
    // 只有本机/内网地址才需要换；公网地址原样就能用，别多造一跳。
    if (!isLocalNetworkUrl(raw)) return [];
    const bases: string[] = [];
    const addBase = (value?: string | null) => {
        const base = String(value || "").trim();
        if (!base || !/^https?:\/\//i.test(base)) return;
        if (!bases.includes(base)) bases.push(base);
    };
    // ① 已知网关映射放最前：它不依赖用户怎么配渠道，命中就是最可能正确的那个。
    for (const base of publicBasesForLocalHost(raw)) addBase(base);
    try {
        const config = useConfigStore.getState().config;
        if (config) {
            // 节点自己选的模型优先：它指向的渠道才是这条成片真正的出处。
            if (model) addBase(resolveModelRequestConfig(config, String(model)).baseUrl);
            for (const channel of config.channels || []) addBase(channel.baseUrl);
        }
    } catch {
        // 配置还没初始化（首屏早期）：只剩显式入参可用，安全退回原地址。
    }
    const out: string[] = [];
    for (const base of bases) {
        const next = rewriteLocalMediaUrl(raw, base);
        if (next && next !== raw && !out.includes(next)) out.push(next);
    }
    return out;
}

/**
 * 播放器 / 缩略图该用的地址：**页面在公网上时，本机网关地址一律先换成公开地址**。
 *
 * 🔴 为什么不能等 `onError` 再换（2026-11-26 实况）：线上画布是 `https://….pages.dev`，
 * 而节点里存的是 `http://127.0.0.1:17800/v1/files/<id>.mp4`。这条 loopback 请求在浏览器里
 * 直接 `ERR_CONNECTION_REFUSED`（网关可能根本没起、或被代理软件接管、或用户不在这台机器上），
 * 但 `<video>` 首帧就已经把请求发出去了 —— 控制台一屏红字，用户看到的是「全坏了」。
 * 等到 `error` 回调再换地址只是补救，第一跳的噪音和延迟都已经发生。
 *
 * 所以把「该用哪条地址」提前到**取 src 的那一刻**：能推出公开地址就直接用它，
 * 推不出来（不认识这个端口 / 已经是公网地址）就原样返回，绝不猜。
 *
 * 🔴 这里**只认内置的「本机网关 → 公网入口」映射**，不走 `portableMediaUrls` 那条
 * 「拿渠道 baseUrl 去拼」的路。因为后者对任何本机地址都会拼一个候选出来（默认配置里就有
 * `https://api.openai.com`），把本机端口瞎换成别的域名，首帧就变成一次莫名其妙的失败请求，
 * 而且原地址再也没机会被试 —— 首帧必须宁可不换，也不能换成错的。
 * 兜底试错留给 `portableMediaUrls`：那时候失败了可以往下一个候选走。
 *
 * 页面自己就跑在本机（`http://127.0.0.1:5173` 之类的 dev / 本地部署）时保持直连：
 * 那条路最快，也不该为了「线上」牺牲本地开发体验。
 */
export function preferPublicMediaUrl(url: string): string {
    const raw = String(url || "").trim();
    if (!raw || !isLocalNetworkUrl(raw)) return raw;
    try {
        if (typeof window !== "undefined" && isLocalNetworkUrl(window.location.origin)) return raw;
    } catch {
        // 拿不到 location（SSR / 测试环境）→ 按线上处理，宁可走公网也别打 loopback。
    }
    for (const base of publicBasesForLocalHost(raw)) {
        const next = rewriteLocalMediaUrl(raw, base);
        if (next && next !== raw) return next;
    }
    return raw;
}
