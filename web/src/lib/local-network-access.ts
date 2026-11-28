// Chrome 142+ 的 Local Network Access（LNA）授权。
//
// 🔴 为什么必须有这一层（2026-11-26 两轮报障）：
// 公网页面（`*.pages.dev`）访问 `127.0.0.1` / `localhost` 现在要用户明确授权。
// 关键坑是**未授权时 fetch 既不 resolve 也不 reject** —— 请求静默挂起，业务代码只等到超时，
// 画布上就是「一直读秒、生成不出东西」，而且还只在 Chrome 里出现（Firefox / 旧 Edge 无此限制）。
//
// 光把请求改走公网入口（`local-gateway.ts`）只能算绕路：那一跳要过 Tailscale Funnel，
// 中间任何一级反代（常见 `proxy_read_timeout 120s`）都会把慢模型掐成 504，
// 用户看到的就变成「120 秒代理读取超时」。**直连本机才是正路**，所以这里做三档：
//
//   granted     → 直连。零延迟，不需要绕公网。
//   prompt      → 先主动打一次 loopback 把授权气泡顶出来（Chrome 官方推荐的引导方式），
//                 同时按「可能挂起」处理：这一次请求允许走公网入口兜底。
//   denied      → 用户拒绝过。只能走公网入口，并提示去站点设置里改回来。
//   unsupported → 不是 Chromium / 没有这个权限项（Firefox、Safari、旧内核）→ 直连。
//
// 状态在启动时预热一次（`primeLocalNetworkAccess()`），之后同步可读 —— 因为
// `proxyApiUrl()` 这类拼 URL 的函数不能 await。

export type LocalNetworkAccessState = "unknown" | "granted" | "prompt" | "denied" | "unsupported";

let state: LocalNetworkAccessState = "unknown";
let primed: Promise<LocalNetworkAccessState> | null = null;

type LocalNetworkAccessListener = (next: LocalNetworkAccessState) => void;
const listeners = new Set<LocalNetworkAccessListener>();

/**
 * 状态变了就广播 —— 画布上那个「允许直连」提示靠它自动消失/出现，
 * 不需要用户手动刷新。监听器抛错不能影响权限状态机，所以逐个 try。
 */
function commitState(next: LocalNetworkAccessState) {
    if (state === next) return;
    state = next;
    for (const listener of listeners) {
        try {
            listener(next);
        } catch {
            // 监听器自己的问题，不要污染权限判定
        }
    }
}

/** 订阅状态变化（授权气泡被点、用户去设置里改回来都会触发）。返回退订函数。 */
export function subscribeLocalNetworkAccess(listener: LocalNetworkAccessListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** 同步读当前状态。`unknown` 表示还没预热完。 */
export function localNetworkAccessState(): LocalNetworkAccessState {
    return state;
}

/**
 * 仅供探针：直接落到某个状态，跳过浏览器权限查询。
 *
 * 生产代码不要调 —— 真实状态只能由 `primeLocalNetworkAccess()` 从 Permissions API 读。
 * 探针需要覆盖 denied / granted / prompt / unsupported 四个分支，而 node 里没有
 * `navigator.permissions`，只能从这里注入。
 */
export function __setLocalNetworkAccessStateForProbe(next: LocalNetworkAccessState) {
    primed = Promise.resolve(next);
    commitState(next);
}

/**
 * 是否应该把本机网关地址改走公网入口。
 *
 * 只有**明确被拒**（denied）时才绕公网。`prompt` 不绕：那时 Chrome 会弹气泡，
 * 用户允许后就该直连（最快）；同时 `prime` 阶段已经主动触发过提示，不会无限静默。
 */
export function shouldDetourLocalNetwork(): boolean {
    return state === "denied";
}

/**
 * 现在能不能放心地直连 loopback（给「媒体地址怎么选」用，必须同步）。
 *
 * 🔴 为什么媒体要单开一条判据（2026-11-26 用户报障「qf 成片读取和下载非常缓慢」）：
 * `preferPublicMediaUrl()` 以前只要页面不在本机，就把 `127.0.0.1:17800/v1/files/x.mp4`
 * 无条件换成 Tailscale Funnel 的公开入口。实测同一份 1,852,855 B 的成片：
 *
 *   loopback  http://127.0.0.1:17800/v1/files/x.mp4   → 0.010 s（≈185 MB/s）
 *   Funnel    https://…/qf/v1/files/x.mp4             → 40.9 s（≈45 KB/s）
 *
 * 也就是说：**授权正常的 Chrome 反而被我们自己降速了 4000 倍**。Funnel 是 DERP 中继，
 * 单连接实测只有 ~45 KB/s（四路并发聚合 ~130 KB/s），画布一次挂十几个节点就是几十秒黑屏。
 *
 * 判据只认两种「确定能直连」的状态：
 *   granted     → 用户已授权公网页面访问本机。
 *   unsupported → 非 Chromium（Firefox / Safari / 旧内核），本来就没有这道闸门。
 *
 * `unknown`（预热还没回来）与 `prompt`（气泡还没被处理）继续走公开入口：
 * 那两种状态下直接打 loopback 可能**静默挂起**，宁可慢也不能让 `<video>` 卡死。
 */
export function canUseLocalNetworkDirectly(): boolean {
    return state === "granted" || state === "unsupported";
}

/** 媒体是不是正被「降级」到公网中继 —— 只用于给用户提示，不参与选路。 */
export function localNetworkIsRelayed(): boolean {
    return state === "prompt" || state === "denied";
}

function queryDescriptor(name: string): PermissionDescriptor {
    return { name } as unknown as PermissionDescriptor;
}

async function readPermission(): Promise<LocalNetworkAccessState | null> {
    try {
        if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
        const status = await navigator.permissions.query(queryDescriptor("local-network"));
        status.onchange = () => {
            const next = status.state as LocalNetworkAccessState;
            if (next === "granted" || next === "prompt" || next === "denied") commitState(next);
        };
        const value = status.state as LocalNetworkAccessState;
        return value === "granted" || value === "prompt" || value === "denied" ? value : "prompt";
    } catch {
        // 不认这个权限名（Firefox / Safari / 老内核）→ 按「没有限制」处理。
        return null;
    }
}

/**
 * 预热：读一次权限状态；`prompt` 时主动发一条 loopback 请求把授权气泡顶出来。
 *
 * 这条探针请求本身可能一直挂着（等用户点气泡），所以给 6 秒上限 —— 气泡已经弹出，
 * 挂不挂都不影响后续判断。请求失败（401 / CORS / 超时）都正常，这里只看权限有没有变。
 */
export async function primeLocalNetworkAccess(): Promise<LocalNetworkAccessState> {
    if (primed) return primed;
    primed = (async () => {
        const initial = await readPermission();
        if (initial === null) {
            commitState("unsupported");
            return state;
        }
        commitState(initial);
        if (initial !== "prompt") return state;

        // 页面自己就在本机时不需要授权（同源 / 已是 loopback），别去打扰用户。
        try {
            const host = window.location.hostname.toLowerCase();
            if (/^(127\.|localhost$|0\.0\.0\.0$|\[?::1\]?$)/.test(host) || host.endsWith(".localhost")) {
                commitState("granted");
                return state;
            }
        } catch {
            // ignore
        }

        try {
            let signal: AbortSignal | undefined;
            try {
                signal = AbortSignal.timeout(6000);
            } catch {
                signal = undefined;
            }
            await fetch("http://127.0.0.1:17800/v1/models", {
                mode: "cors",
                cache: "no-store",
                signal,
            });
        } catch {
            // 401 / 403 / CORS / 超时都无所谓：目的是让 Chrome 把授权气泡显示出来。
        }
        const after = await readPermission();
        if (after) commitState(after);
        return state;
    })();
    return primed;
}

/**
 * 在**用户手势**里主动重试一次授权（画布上那个「允许直连」按钮调它）。
 *
 * 为什么必须有这个入口：`primeLocalNetworkAccess()` 在页面启动时跑，那一刻没有用户激活，
 * Chrome 常常**不弹** LNA 气泡，用户就卡在「一直读秒 / 走公网中继」里，不知道去哪点。
 * 从 click 里发一次 loopback 请求，气泡才会出现；点完「允许」后 Permissions API 的
 * `onchange` 会把状态推回 `granted`，播放器/下载入口下一次取址就会回到直连。
 *
 * 返回重试后的状态。`granted` 说明搞定；`prompt` 说明气泡弹出但还没点；
 * `denied` 说明被拒（只能去站点设置里改）。
 */
export async function requestLocalNetworkAccess(): Promise<LocalNetworkAccessState> {
    const before = await readPermission();
    if (before === null) {
        commitState("unsupported");
        return state;
    }
    commitState(before);
    if (state === "granted" || state === "unsupported") return state;

    try {
        let signal: AbortSignal | undefined;
        try {
            signal = AbortSignal.timeout(30_000);
        } catch {
            signal = undefined;
        }
        // 探 /v1/health：不落业务、不需要额度，只为了让浏览器把授权气泡顶出来。
        await fetch("http://127.0.0.1:17800/v1/health", {
            mode: "cors",
            cache: "no-store",
            signal,
        });
    } catch {
        // 气泡还没点 / 被拒 / 网关没起，都以 Permissions API 的结果为准。
    }

    const after = await readPermission();
    if (after) commitState(after);
    return state;
}
