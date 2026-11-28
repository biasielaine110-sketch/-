// 「提交没拿到回包」之后，把任务从网关自己的任务列表里查回来。
//
// 🔴 实况（2026-11-28 qf 渠道 Seedance 2.0 Fast）：
//   Quota-Flow 网关日志 `local-api-requests.jsonl` 里写着
//     `POST /v1/videos | 200 | 11094ms`
//   同一秒还有 `task-created` / `queue-head`，之后 `task-stage` 一路在跑；而前台弹的是
//   「请求没有拿到任何回包（多为公网入口抖动或超时）」。也就是说：**任务真的建好了，
//   是响应在 Tailscale Funnel 那一跳丢了**（`funnel-guard.log`：首包 4.1s）。
//
//   后果不只是「说错一句话」：用户看到报错就会再点一次生成 —— 白扣一次额度，还多出
//   一份没人认领的成片。旧代码在这里必死，因为 POST 的返回值就是任务 id，没有 id 就
//   没法轮询，只能放弃。
//
//   其实网关（OpenAI 兼容契约）本来就有 `GET /v1/videos?limit=N` 任务列表，里面带着
//   `id / status / model / prompt(截断 80 字) / created_at / video_url`。够把刚提交的
//   那个任务认回来：认到了就直接进入轮询，前端表现成「慢一点，但没失败」。
//
// 找回的门槛（宁可不接，也绝不接错 —— 接错会把上一次的成片贴到这次的节点上）：
//   ① 只认 `POST .../v1/videos[/generations]`（OpenAI 兼容创建接口）；
//   ② 提示词必须一致（网关截断到 80 字，所以按「短的是长的前缀」比，且前缀够长）；
//   ③ 模型名两边都有时比对；
//   ④ 创建时间落在「本次提交开始前 15 秒 ~ 现在 +30 秒」的窗口内；
//   ⑤ 同一任务不能被两个节点各认一次（`claimed` 记账，进程内去重）。
import axios from "axios";

export type RecoveredVideoTask = Record<string, unknown> & { id: string; status?: string };

/** 网关建任务就在我们发 POST 的那一秒，往前留 15 秒只够容忍时钟偏差，不够「认出上一次提交」。 */
const SINCE_SKEW_MS = 15_000;
/** `until` 往后留 30 秒：网关会在把响应写回来的路上就把任务落库，时间戳通常早于当前时刻。 */
const UNTIL_SKEW_MS = 30_000;
/** 已经认领过的任务 id（只用于消除并发节点抢同一个任务的歧义）。 */
const CLAIM_LIMIT = 200;
const claimedTaskIds = new Set<string>();

/**
 * 查列表的重试节奏（毫秒）。第一次立刻查；后面两次留给网关把任务落库的时间
 * —— 「无回包」常常是连接被重置的瞬间，那时任务可能刚提交、还没进列表。
 */
const RECOVERY_RETRY_DELAYS_MS = [0, 1_500, 3_000] as const;

function claimTask(id: string) {
    claimedTaskIds.add(id);
    while (claimedTaskIds.size > CLAIM_LIMIT) {
        const oldest = claimedTaskIds.values().next().value;
        if (!oldest || oldest === id) break;
        claimedTaskIds.delete(oldest);
    }
}

function collapseText(value: string): string {
    return String(value || "").replace(/\s+/g, " ").trim();
}

/** `/v1/videos` 或 `/v1/videos/generations` 结尾（POST 创建任务的两个常见形状）。 */
export function isVideoCreateUrl(url: string): boolean {
    try {
        const target = new URL(String(url || ""));
        return /\/v1\/videos(?:\/generations)?\/?$/i.test(target.pathname);
    } catch {
        return false;
    }
}

/**
 * 由创建地址推出任务列表地址：同 host、同前缀，只把尾巴换成 `/v1/videos`。
 * 用 POST 自己的地址推（而不是渠道 `baseUrl`），是为了保证「查的」和「提交的」是同一个门。
 */
export function videoListUrlFor(createUrl: string): string {
    try {
        const target = new URL(String(createUrl || ""));
        const pathname = target.pathname.replace(/\/videos(?:\/generations)?\/?$/i, "/videos");
        if (pathname === target.pathname && !/\/videos\/?$/i.test(pathname)) return "";
        target.pathname = pathname;
        target.search = "";
        target.hash = "";
        return target.toString();
    } catch {
        return "";
    }
}

/** `created_at` 三种写法都见得到：毫秒数、秒数、ISO 字符串。统一换成毫秒。 */
export function parseTaskCreatedAt(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === "string") {
        const text = value.trim();
        if (!text) return 0;
        const numeric = Number(text);
        if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

/** 提示词是否同一段：网关列表里存的是 `prompt.slice(0, 80)`，所以按前缀比。 */
export function samePromptText(candidate: string, submitted: string): boolean {
    const a = collapseText(candidate);
    const b = collapseText(submitted);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    // 前缀太短（「一只猫」）容易把别人的任务认成自己的，宁可不认。
    return shorter.length >= 12 && longer.startsWith(shorter);
}

function readTaskList(payload: unknown): Array<Record<string, unknown>> {
    const raw = payload as { data?: unknown; items?: unknown; videos?: unknown } | null | undefined;
    const list = Array.isArray(payload)
        ? payload
        : Array.isArray(raw?.data)
          ? (raw?.data as unknown[])
          : Array.isArray(raw?.items)
            ? (raw?.items as unknown[])
            : Array.isArray(raw?.videos)
              ? (raw?.videos as unknown[])
              : [];
    return list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

export type PickRecoveredArgs = {
    model?: string;
    prompt: string;
    startedAt: number;
    now?: number;
    claimedIds?: Iterable<string>;
};

/**
 * 在任务列表里认回「刚刚这次提交」。
 * 找不到返回 null（调用方保留原始报错，并据此告诉用户「确实没送达」）。
 */
export function pickRecoveredVideoTask(items: Array<Record<string, unknown>>, args: PickRecoveredArgs): RecoveredVideoTask | null {
    const now = args.now ?? Date.now();
    const since = args.startedAt - SINCE_SKEW_MS;
    const until = now + UNTIL_SKEW_MS;
    const claimed = args.claimedIds instanceof Set ? args.claimedIds : new Set(args.claimedIds || []);
    const model = collapseText(args.model || "").toLowerCase();

    const candidates = items.filter((item) => {
        const id = String(item.id ?? item.task_id ?? "").trim();
        if (!id || claimed.has(id)) return false;
        const createdAt = parseTaskCreatedAt(item.created_at ?? item.createdAt ?? item.created);
        if (!createdAt || createdAt < since || createdAt > until) return false;
        const itemModel = collapseText(String(item.model ?? "")).toLowerCase();
        if (model && itemModel && itemModel !== model) return false;
        return samePromptText(String(item.prompt ?? ""), args.prompt);
    });
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
        const left = parseTaskCreatedAt(a.created_at ?? a.createdAt ?? a.created);
        const right = parseTaskCreatedAt(b.created_at ?? b.createdAt ?? b.created);
        return right - left;
    });
    const picked = candidates[0];
    const id = String(picked.id ?? picked.task_id).trim();
    if (!id) return null;
    return { ...picked, id, recovered: true };
}

export type RecoverVideoTaskArgs = {
    /** 提交时用的地址（直连形态），只用来确认这是 `/v1/videos` 创建接口。 */
    createUrl: string;
    /** 实际取任务列表的地址（可能已经换成公网入口 / 同源代理）。默认由 createUrl 推出。 */
    listUrl?: string;
    headers?: Record<string, string>;
    model?: string;
    prompt?: string;
    startedAt: number;
    signal?: AbortSignal;
    now?: number;
    /** 测试注入点：返回任务列表的原始 JSON。 */
    send?: (url: string, params: Record<string, unknown>) => Promise<unknown>;
};

export type RecoverVideoTaskResult = {
    task: RecoveredVideoTask | null;
    /** 是否真的查过任务列表 —— 决定了上层文案能不能说「查过也没有」。 */
    lookedUp: boolean;
};

/**
 * 提交没拿到回包时调用：从任务列表把这次提交认回来。
 * 只做一次、不重试（这一跳本来就抖，再抖一次也白搭，反而拖慢报错）。
 */
export async function recoverVideoTaskFromList(args: RecoverVideoTaskArgs): Promise<RecoverVideoTaskResult> {
    const prompt = collapseText(args.prompt || "");
    // 没有提示词就没有可靠的对齐依据 —— 靠时间猜会认错任务。
    if (!prompt || !isVideoCreateUrl(args.createUrl)) return { task: null, lookedUp: false };
    if (args.signal?.aborted) return { task: null, lookedUp: false };

    const listUrl = args.listUrl || videoListUrlFor(args.createUrl);
    if (!listUrl) return { task: null, lookedUp: false };

    // 用 `axios.request`（而不是 `axios.get`）取列表：全仓只在这一个底层函数上打桩，
    // 探针才能真实串起「POST 失败 → 查列表 → 接管任务」的整条链。
    const send =
        args.send ??
        ((url: string, params: Record<string, unknown>) =>
            axios
                .request({ method: "get", url, params, headers: args.headers, timeout: 20_000, signal: args.signal })
                .then((response) => response.data));

    /**
     * 「无回包」往往发生在**连接被重置**的瞬间，这时网关可能还在建任务（qf 的 POST 要 11 秒）。
     * 所以第一次没查到不算数，隔 1.5s / 3s 再各看一眼；一旦认到就立刻返回。
     * 只有「列表本身取不到」才立刻收手（这一跳已经断了，再问三次只是把报错拖长 45 秒）。
     */
    let lookedUp = false;
    for (const delay of RECOVERY_RETRY_DELAYS_MS) {
        if (delay) await pause(delay, args.signal);
        if (args.signal?.aborted) return { task: null, lookedUp };
        let payload: unknown;
        try {
            payload = await send(listUrl, { limit: 20 });
            lookedUp = true;
        } catch (error) {
            console.warn("[video] 提交没拿到回包，任务列表也取不到，无法把任务查回来：", error instanceof Error ? error.message : String(error));
            return { task: null, lookedUp };
        }

        const task = pickRecoveredVideoTask(readTaskList(payload), {
            model: args.model,
            prompt,
            startedAt: args.startedAt,
            now: args.now,
            claimedIds: claimedTaskIds,
        });
        if (task) {
            claimTask(task.id);
            console.warn(`[video] 提交没拿到回包，已从任务列表把任务查回来：${task.id}（${String(task.status ?? "unknown")}）`);
            return { task, lookedUp: true };
        }
    }

    console.warn("[video] 提交没拿到回包，任务列表里也没有对得上的任务 —— 这次确实没送达网关");
    return { task: null, lookedUp };
}

function pause(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/** 只给探针用：清空认领记录，避免多次用例互相影响。 */
export function __resetRecoveredVideoTasksForProbe() {
    claimedTaskIds.clear();
}
