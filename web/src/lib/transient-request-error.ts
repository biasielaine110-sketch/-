// 「这一轮没问到」的唯一判据（视频主流程与模型脚本执行层共用）。
//
// 🔴 为什么必须有这个判据（2026-11-28 qf 渠道 Seedance 2.0 Fast 实测两连击）：
//  qf 网关跑在用户机器上（`http://127.0.0.1:17800`），画布要够着它只有一条路 ——
//  Tailscale Funnel 公网入口（`lib/local-gateway.ts` 里的映射表）。而 Funnel 这一跳
//  `funnel-guard.log` 里反复记着「能通但极慢 / TCP 没建立」：一次 15s 成片要盯 6–10 分钟
//  的轮询，中间断一两拍是**常态**，不是异常。
//
//  旧逻辑把任何一次查询异常都当终局错误抛出，于是：
//    · 主流程 `pollOpenAIVideoTask` → 节点变黑框、拿不到 URL（后台其实生成了）；
//    · 脚本层 `createPoll` → 直接报「模型调用脚本执行失败：Network Error」。
//  两者症状不同、根因一模一样：**抖动被判成了死亡**。
//
// 判据：
//   · 4xx（401 鉴权 / 404 任务已过期 / 400 参数）→ 重试也长不出结果，立刻暴露；
//   · 5xx / 超时 / 连接被重置 / 压根没有回包 → 「这轮没问到」，值得再问一次；
//   · 取消（用户主动 abort / axios cancel）→ 原样抛出，不算抖动。
//
// 注意 iOS 上 Chrome 断网时偶尔抛 `new Error("Network Error")`（不是 AxiosError），
// 那种情况我们不猜 —— 宁可暴露，也别把一个真错误藏成「继续等」。
import axios from "axios";

export function isTransientRequestError(error: unknown): boolean {
    if (axios.isCancel(error)) return false;
    if (error instanceof DOMException && error.name === "AbortError") return false;
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (typeof status === "number") return status >= 500;
    // 没有 response：DNS / TCP / TLS / 代理断链 / 我们自己的 timeout —— 都值得再问一次。
    return true;
}
