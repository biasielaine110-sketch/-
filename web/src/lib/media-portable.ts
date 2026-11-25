import { isLocalNetworkUrl, rewriteLocalMediaUrl } from "@/lib/api-proxy";
import { resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

/**
 * 旧节点里的「本机网关成片地址」还能救回来的候选地址。
 *
 * 🔴 背景（用户 2026-11-25 第 05 条）：qf 渠道（本机 quota-flow 网关 `127.0.0.1:17800`）生成的成片，
 * 被节点原样存成了 `http://127.0.0.1:17800/v1/files/<id>.mp4`。这个地址只对「网关所在那台机器的
 * 那个进程」有效，页面一换设备 / 网关一重启就是 `ERR_CONNECTION_REFUSED`，而同一份字节经渠道公开
 * 域名（Tailscale Funnel）是能完整取到的。
 *
 * 新生成的成片已经在解析阶段改写成公开地址（见 `services/api/video.ts` 的 `videoResultFromUrl`），
 * 这个函数只服务**存量节点**：播放失败 / 下载失败时按当前配置把 `127.0.0.1` 版地址重拼出公开版，
 * 逐个试过去。取不到就老实报错，不猜、不静默改写节点数据。
 *
 * 候选顺序：节点自己记录的模型所在渠道 → 配置里的全部渠道（去重）。
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
