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
//   unsupported → 权限项读不出来。**不再等于「可以直接连」**（见下面第 3 条）。
//
// 状态在启动时预热一次（`primeLocalNetworkAccess()`），之后同步可读 —— 因为
// `proxyApiUrl()` 这类拼 URL 的函数不能 await。
//
// 🔴 三条血泪判据（2026-11-26 第三次报障「qf 成片无法播放」逼出来的）：
//
// ① **权限名不是唯一的**。Chrome 官方文档写的是 `local-network`，但实现里 loopback 走的是
//    另一个规范名 `loopback-network`，社区代码里还见过 `local-network-access`。旧实现只查
//    `local-network`，名字一对不上就 `query()` 抛 TypeError → 被当成「浏览器不支持」，
//    于是 `canUseLocalNetworkDirectly()` 返回 true → 媒体地址从公网入口**降级**成 loopback
//    → 浏览器其实没授权 → `<video>` 直接 `MEDIA_ELEMENT_ERROR: Network error`。
//    现在三个名字都试，只要有一个 granted 就算 granted。
//
// ② **读不出来 ≠ 没限制**。`unsupported` 现在只表示「权限 API 问不出来」，
//    直连与否还要看 ③ 的真实探测结果。老实现把 `unsupported` 当「随便连」，
//    这在 Firefox 上侥幸成立，在 Chrome 上就是上面那个黑屏。
//
// ③ **权限 API 说 granted 也可能连不上，说 unsupported 也可能连得上**。所以补一层
//    真实可达性探测（`probeLoopbackReachability()`）：发一条请求到目标 origin 的
//    `/v1/health`，能拿到任何响应（含 401 / 404）就算 reachable，网络层被拒 / 超时算 blocked。
//    结果按 origin 缓存并广播，选路函数据此决定「公网入口要不要降回 loopback」。

export type LocalNetworkAccessState = "unknown" | "granted" | "prompt" | "denied" | "unsupported";

/** 本机 origin 的真实可达性（和权限 API 是两条独立证据）。 */
export type LoopbackReachability = "unknown" | "reachable" | "blocked";

/**
 * Chrome 里可能出现的 LNA 权限名。顺序有讲究：
 * `loopback-network` 专管 `127.0.0.1` / `localhost`（我们最关心的一种），先问它；
 * `local-network` 是文档口径；`local-network-access` 是部分实现/草案里的名字。
 */
const LNA_PERMISSION_NAMES = ["loopback-network", "local-network", "local-network-access"] as const;

let state: LocalNetworkAccessState = "unknown";
let primed: Promise<LocalNetworkAccessState> | null = null;
/** 命中的权限名 —— 出问题时好定位（/diag 会一起打出来）。 */
let grantedPermissionName: string | null = null;

type LocalNetworkAccessListener = (next: LocalNetworkAccessState) => void;
const listeners = new Set<LocalNetworkAccessListener>();

/** origin → 可达性。key 统一用 `new URL(...).origin`，含端口。 */
const reachability = new Map<string, LoopbackReachability>();
/**
 * 结论的时效。**「blocked」不能是终身判决**（2026-11-28 第五次报障）。
 *
 * 页面启动那一刻网关可能还没起、Chrome 也可能还没拿到用户手势 —— 那一次探测必然失败。
 * 若把那个 `blocked` 当永久结论，用户把网关打开之后预览和下载仍然一辈子走 45 KB/s 的中继，
 * 表现为「以前一点就放，现在怎么都慢」。45 s 足够「一次操作内别重复探」，又短到能自愈；
 * `reachable` 给 10 分钟，省掉反复探活。
 */
const REACHABILITY_TTL_MS = { reachable: 10 * 60_000, blocked: 45_000 } as const;
const reachabilityAt = new Map<string, number>();
const reachabilityInflight = new Map<string, Promise<LoopbackReachability>>();
type ReachabilityListener = (origin: string, next: LoopbackReachability) => void;
const reachabilityListeners = new Set<ReachabilityListener>();

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

/** 订阅「可达性」变化（探测完成 / 重新探测结果不同）。返回退订函数。 */
export function subscribeLoopbackReachability(listener: ReachabilityListener): () => void {
    reachabilityListeners.add(listener);
    return () => {
        reachabilityListeners.delete(listener);
    };
}

/** 同步读当前状态。`unknown` 表示还没预热完。 */
export function localNetworkAccessState(): LocalNetworkAccessState {
    return state;
}

/** 命中的权限名（`/diag` 用）。 */
export function localNetworkPermissionName(): string | null {
    return grantedPermissionName;
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
 * 仅供探针：注入可达性结论，跳过真实网络请求。`null` 表示清空回到 unknown。
 */
export function __setLoopbackReachabilityForProbe(url: string, next: LoopbackReachability | null) {
    const key = originKey(url);
    if (!key) return;
    if (next === null) {
        reachability.delete(key);
        reachabilityAt.delete(key);
    } else {
        reachability.set(key, next);
        reachabilityAt.set(key, Date.now());
    }
}

/**
 * 仅供探针：把某个 origin 的探测结论「做旧」，用来验证 TTL 自愈（`blocked` 不许定终身）。
 */
export function __expireLoopbackReachabilityForProbe(url: string) {
    const key = originKey(url);
    if (!key) return;
    if (reachability.has(key)) reachabilityAt.set(key, 0);
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

function originKey(url: string): string {
    try {
        return new URL(String(url || "")).origin.toLowerCase();
    } catch {
        return "";
    }
}

/** 读某个地址楼层的可达性结论（同步）。过期的结论按「没探过」处理，逼调用方重探。 */
export function loopbackReachability(url: string): LoopbackReachability {
    const key = originKey(url);
    if (!key) return "unknown";
    const value = reachability.get(key);
    if (!value || value === "unknown") return "unknown";
    const at = reachabilityAt.get(key) || 0;
    if (Date.now() - at > REACHABILITY_TTL_MS[value]) {
        reachability.delete(key);
        reachabilityAt.delete(key);
        return "unknown";
    }
    return value;
}

/**
 * 等一次真实探测的结论，最多等 `budgetMs`（拿不到就回 `unknown`，由调用方保守处理）。
 *
 * 🔴 为什么需要这个（2026-11-28 第五次报障）：「首帧必须同步出地址」这条约束让播放器只能在
 * 探测还没回来时先给公网入口 —— 而那一跳只有 45–260 KB/s，一个 1.8 MB 成片要几十秒。
 * 用户体感就是「以前一点就放，现在要读秒」。先花几百毫秒把「这台机器的 loopback 通不通」
 * 问清楚，比直接掉进中继划算得多（800 ms vs 40 s）。
 */
export async function awaitLoopbackReachability(url: string, budgetMs = 800): Promise<LoopbackReachability> {
    const cached = loopbackReachability(url);
    if (cached !== "unknown") return cached;
    if (!originKey(url)) return "unknown";
    const probe = probeLoopbackReachability(url, Math.max(300, budgetMs));
    const budget = new Promise<LoopbackReachability>((resolve) => {
        setTimeout(() => resolve("unknown"), Math.max(300, budgetMs));
    });
    return Promise.race([probe, budget]);
}

/**
 * 真实探测一次 loopback 可达性。
 *
 * 判定口径：**只要能拿到 HTTP 响应就算通**（401 / 403 / 404 都算），因为我们要确认的是
 * 「浏览器把请求发出去了」，不是「业务成功」。所以：
 *   fetch resolve（哪怕 status 4xx / 5xx，甚至 opaque response） → reachable
 *   fetch reject（TypeError 网络层被拒 / AbortError 挂起超时）      → blocked
 *
 * 🔴 必须用 `mode: "no-cors"`。本机网关只在自家 `pages.dev` origin 开了 CORS？未必 ——
 * qf 网关对 `/v1/files/*` 是给 `<video>` 用的（no-cors 就能拉），没带
 * `Access-Control-Allow-Origin`。用 cors 模式探测会因为我们拿不到头而 reject，
 * 把「其实完全能播放」误判成 blocked。opaque response 在这里就是最好的信号。
 *
 * `127.0.0.1` 属于 potentially-trustworthy origin，https 页面请求它不会被 mixed content 拦，
 * 所以这条探测在线上页面也能跑。
 */
export function probeLoopbackReachability(
    url: string,
    timeoutMs = 2500,
): Promise<LoopbackReachability> {
    const key = originKey(url);
    if (!key) return Promise.resolve("unknown");
    const inflight = reachabilityInflight.get(key);
    if (inflight) return inflight;

    const run = (async (): Promise<LoopbackReachability> => {
        let next: LoopbackReachability = "blocked";
        try {
            if (typeof fetch !== "function") return "unknown";
            let signal: AbortSignal | undefined;
            try {
                signal = AbortSignal.timeout(timeoutMs);
            } catch {
                signal = undefined;
            }
            await fetch(`${key}/v1/health`, {
                method: "GET",
                mode: "no-cors",
                cache: "no-store",
                credentials: "omit",
                signal,
            });
            next = "reachable";
        } catch {
            next = "blocked";
        }
        const prev = reachability.get(key);
        reachability.set(key, next);
        reachabilityAt.set(key, Date.now());
        if (prev !== next) {
            for (const listener of reachabilityListeners) {
                try {
                    listener(key, next);
                } catch {
                    // 同上：监听器自己的问题
                }
            }
        }
        return next;
    })();

    reachabilityInflight.set(key, run);
    void run.finally(() => {
        // 只清自己这一次，别把后来者的 in-flight 抹掉。
        if (reachabilityInflight.get(key) === run) reachabilityInflight.delete(key);
    });
    return run;
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
 * 判定顺序（2026-11-28 起）：**权限只是第一层，真实可达性才是最终一票**：
 *
 *   granted                        → 直连（权限已明确，直接给最快的那条）。
 *   其它一切状态（prompt / denied / unsupported / unknown）
 *                                  → 看真实探测：reachable 直连、blocked 绝不直连、
 *                                    还没探过就发起一次探测并按「不直连」保守处理。
 *
 * 🔴 `prompt` 不再一票否决：Chrome 对 LNA 这几个人造权限名经常恒回 `prompt`，
 * 一票否决等于把「其实完全通的用户」永久按进中继（第五条报障的真因）。
 *
 * 传入 `url` 是目标本机地址（`http://127.0.0.1:17800/...`）；不传就看不了探测结论，
 * 只按权限判（`granted` 才 true）。这样「公网入口要不要降回 loopback」这种需要落到
 * 具体 origin 的决定，可以稳稳拿到探测这一票。
 */
export function canUseLocalNetworkDirectly(url?: string): boolean {
    if (state === "granted") return true;
    if (!url) return false;
    /**
     * 🔴 真实探测对**所有**权限态都是第一票（2026-11-28 第五次报障）。
     *
     * 旧实现只让 `unsupported` 去看探测结论，`prompt` 直接判「不许直连」。可 Chrome 里
     * `navigator.permissions.query()` 对 LNA 这几个人造权限名经常恒回 `prompt`
     * （甚至会因为查询本身不是用户手势而永远不弹气泡），于是**请求其实完全通、我们却把
     * 每一条成片都赶进了 45–260 KB/s 的 Funnel 中继** —— 用户的原话就是
     * 「以前生成完一点就放，现在到底什么情况」。
     *
     * 判据翻过来的理由和 `unsupported` 那条一样：**拿到响应就是硬证据**。
     * 探测是 no-cors 打到同一个 origin 的 `/v1/health`（网关免鉴权），能回来就说明
     * 浏览器放行了这个 loopback origin，`<video>` / `fetch` 打同一个 origin 必然也放行。
     * 反过来探到 blocked 就绝不打 —— 那才是 `MEDIA_ELEMENT_ERROR: Network error` 的根因。
     * 权限状态变化时 `watchPermissionStatus.onchange` 会清掉探测结论，不会留下陈旧判断。
     */
    const reach = loopbackReachability(url);
    if (reach === "reachable") return true;
    if (reach === "blocked") return false;
    // 还没探过（或结论已过期）：这次保守走公网，同时把探测排出去，下一次取址就能拿到结论。
    void probeLoopbackReachability(url);
    return false;
}

/** 媒体是不是正被「降级」到公网中继 —— 只用于给用户提示，不参与选路。 */
export function localNetworkIsRelayed(): boolean {
    return state === "prompt" || state === "denied";
}

/**
 * 有没有某个本机 origin 被**探明打不通**。
 *
 * 🔴 为什么要这一条（2026-11-28 第四次报障的收尾）：权限名全都问不出来时状态是
 * `unsupported`，`localNetworkIsRelayed()` 返回 false —— 提示条不出现，用户就永远
 * 没有「允许直连」的入口，只能一直走中继变慢。这一条让那种情况也能提示。
 * `granted` 时一律 false（已经明确授权了，不再打扰）。
 */
export function anyLoopbackBlocked(): boolean {
    if (state === "granted") return false;
    for (const key of Array.from(reachability.keys())) {
        // 走 `loopbackReachability()` 才能顺手清掉过期结论（blocked 只有 45 s 寿命）。
        if (loopbackReachability(key) === "blocked") return true;
    }
    return false;
}

function queryDescriptor(name: string): PermissionDescriptor {
    return { name } as unknown as PermissionDescriptor;
}

function watchPermissionStatus(status: PermissionStatus) {
    status.onchange = () => {
        const next = status.state;
        // 授权状态变了 → 之前探到的可达性结论就过期了，清掉重探（连时间戳一起清）。
        reachability.clear();
        reachabilityAt.clear();
        if (next === "granted") {
            commitState("granted");
            return;
        }
        if (next === "prompt" || next === "denied") {
            commitState(next);
            return;
        }
        void readPermission().then((value) => {
            if (value) commitState(value);
        });
    };
}

/**
 * 读权限状态，**逐个尝试所有可能的权限名**。
 *
 * 返回 `null` 只表示「所有权限名都问不出来」——那才可能是真的不支持。
 * 🔴 只要有一个名字能被 `query()` 认出来，就不再是 unsupported，
 * 哪怕它返回 prompt（说明这个浏览器确实有这道闸门）。
 */
async function readPermission(): Promise<LocalNetworkAccessState | null> {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
    let sawSupportedName = false;
    let sawPrompt = false;
    let sawDenied = false;

    for (const name of LNA_PERMISSION_NAMES) {
        try {
            const status = await navigator.permissions.query(queryDescriptor(name));
            sawSupportedName = true;
            watchPermissionStatus(status);
            const value = status.state;
            if (value === "granted") {
                // 只要有一个名字已授权就够了 —— 别再被别的名字的 prompt 拉回去。
                grantedPermissionName = name;
                return "granted";
            }
            if (value === "denied") sawDenied = true;
            if (value === "prompt") sawPrompt = true;
        } catch {
            // 这个名字不认识：继续试下一个，绝不能直接当成「浏览器不支持」。
        }
    }

    if (sawPrompt) return "prompt";
    if (sawDenied) return "denied";
    if (sawSupportedName) return "prompt";
    return null;
}

/** 页面自己就在本机时不需要授权（同源 / 已是 loopback），别去打扰用户。 */
function pageIsOnLocalNetwork(): boolean {
    try {
        const host = window.location.hostname.toLowerCase();
        return (
            /^(127\.|localhost$|0\.0\.0\.0$|\[?::1\]?$)/.test(host) || host.endsWith(".localhost")
        );
    } catch {
        return false;
    }
}

/**
 * 预热：读一次权限状态；`prompt` 时主动发一条 loopback 请求把授权气泡顶出来，
 * 最后无论权限怎么说，都探一次真实可达性（那是 `unsupported` 分支唯一的判据）。
 *
 * 这条探针请求本身可能一直挂着（等用户点气泡），所以给 6 秒上限 —— 气泡已经弹出，
 * 挂不挂都不影响后续判断。请求失败（401 / CORS / 超时）都正常，这里只看权限有没有变。
 */
export async function primeLocalNetworkAccess(): Promise<LocalNetworkAccessState> {
    if (primed) return primed;
    primed = (async () => {
        const initial = await readPermission();
        commitState(initial === null ? "unsupported" : initial);

        if (pageIsOnLocalNetwork()) {
            // 页面本身就在本机：同源直连，不存在 LNA 闸门，也不必走公网。
            commitState("granted");
            return state;
        }

        if (state === "prompt") {
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
        }

        // 不管权限是什么，都探一次 —— unsupported 时要靠它决定能不能直连。
        // granted 也探：否则「权限给了但网关没起」会把所有节点降级成必然失败的首帧。
        void probeLoopbackReachability("http://127.0.0.1:17800").then((reach) => {
            /**
             * 🔴 启动那一刻的探测失败**不代表** loopback 打不通（2026-11-28 第五次报障的最后一环）：
             * 页面刚加载时还没有用户手势，Chrome 既不会弹 LNA 气泡，也可能直接把这条
             * local-network 请求掐掉。若把这次 blocked 当结论，用户第一次播视频就是几十秒中继，
             * 体感「以前一点就放，现在怎么都慢」。
             *
             * 于是挂一个**一次性** pointerdown：用户第一次点画面时清掉结论、重探一次。
             * 那时已经有手势，探测结论才是真的 —— 通了，播放器和下载的下一跳立刻回到 loopback。
             */
            if (reach !== "blocked" || typeof window === "undefined") return;
            const retry = () => {
                const key = originKey("http://127.0.0.1:17800");
                reachability.delete(key);
                reachabilityAt.delete(key);
                void probeLoopbackReachability("http://127.0.0.1:17800");
            };
            window.addEventListener("pointerdown", retry, { once: true, passive: true });
        });
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
    commitState(before === null ? "unsupported" : before);
    if (state === "granted") return state;

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
        // 气泡还没点 / 被拒 / 网关没起，都以 Permissions API + 真实探测的结果为准。
    }

    const after = await readPermission();
    if (after) commitState(after);
    // 用户点完「允许」后必须重新探一次：之前缓存的多半是 blocked。
    reachability.delete(originKey("http://127.0.0.1:17800"));
    reachabilityAt.delete(originKey("http://127.0.0.1:17800"));
    await probeLoopbackReachability("http://127.0.0.1:17800");
    return state;
}
