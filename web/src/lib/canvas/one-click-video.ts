/**
 * 「一键视频」编排用到的纯函数：模型挑选 + 阶段超时。
 *
 * 为什么要单独抽出来：
 *  ① **模型挑选手写在各处会漂**：用户口径是「deepseek-flash(deepseek)」「seedream-5.0-pro（猛蹬）」——
 *     括号里是**渠道名**，不是模型名的一部分。渠道 id 是随机 nanoid，所以只能按
 *     「模型名匹配 + 渠道名提示」去找，绝不能拼 `channel.name === "deepseek"` 这种字符串。
 *  ② **超时裁决需要可测**：一键视频的两个阶段（分镜表 15 分钟 / 生图 35 分钟）超时要「暂停后续流程」
 *     并 abort 在跑的那一条，这类逻辑写在组件里只能靠人肉等十几分钟验证，所以抽成 `withDeadline()` 并配探针。
 */

/** 单阶段最长等待：用户口径「生分镜表最长等待 15 分钟」。分镜表的重试共享同一段预算。 */
export const ONE_CLICK_STAGE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 「一键直接生图」这一段的最长等待：**35 分钟**（用户 2026-11-11 第 01 条：
 * 「一键生图的时长延长到 35 分钟，没生完再暂停」）。
 *
 * 为什么单独一个常量、不复用 `ONE_CLICK_STAGE_TIMEOUT_MS`：
 * 生图是**一批图并发 + 两轮重试 + 托底**，一张慢图就会把整段拖长；分镜表是一次文本请求，
 * 15 分钟已经远超正常耗时。两者共用一个数会让用户为了生图放宽而连带把分镜表的卡死时间也放宽。
 */
export const ONE_CLICK_IMAGE_STAGE_TIMEOUT_MS = 35 * 60 * 1000;

/** 「一键视频」的三个阶段（顺序即执行顺序）。 */
export type OneClickVideoStage = "script" | "image" | "pipeline";

/**
 * 一键视频在某个脚本节点上的运行态（只存在内存里，不落 `metadata`）。
 *
 * ⚠️ 刻意**不写进 metadata**：`running` 一旦落库，刷新页面就会永远停在「进行中」，
 * 用户会以为还在跑（实际上那条 Promise 早就没了）。节点上只需要展示 + 暂停原因。
 */
export type OneClickVideoRun = {
    status: "running" | "paused" | "done";
    stage: OneClickVideoStage;
    message?: string;
};

/** 轮询生成状态的间隔（生图阶段等「全部出图 / 全部报错」）。 */
export const ONE_CLICK_POLL_INTERVAL_MS = 1500;

/** 分镜表失败后的重试模型（用户口径 `deepseek-flash(deepseek)`）。 */
export const ONE_CLICK_SCRIPT_RETRY_MODEL_NAMES = ["deepseek-flash"];

/** 分镜表重试模型的渠道名提示（渠道可改名，所以是「包含」匹配，且只作排序偏好）。 */
export const ONE_CLICK_SCRIPT_RETRY_CHANNEL_HINTS = ["deepseek"];

/** 生图托底模型（用户口径 `seedream-5.0-pro（猛蹬）`）。 */
export const ONE_CLICK_IMAGE_FALLBACK_MODEL_NAMES = ["seedream-5.0-pro"];

/** 生图托底模型的渠道名提示（「猛蹬」是用户给这条渠道起的名字）。 */
export const ONE_CLICK_IMAGE_FALLBACK_CHANNEL_HINTS = ["猛蹬", "mengdeng"];

type OneClickChannelModelLike = {
    name: string;
    capability?: string;
    enabled?: boolean;
};

type OneClickChannelLike = {
    id: string;
    name: string;
    enabled?: boolean;
    models: OneClickChannelModelLike[];
};

export type OneClickModelTarget = {
    channelId: string;
    channelName: string;
    modelName: string;
};

export type OneClickModelSeek = {
    /** 候选模型名（按优先级排列，精确匹配优先；找不到时再按「包含」宽松匹配）。 */
    names: string[];
    /** 渠道名提示（按优先级排列）。命中的渠道优先，但不强制——渠道改名后仍能按模型名找到。 */
    channelHints?: string[];
    /** 期望能力（`text` / `image`）。只用来在同名模型里挑更合适的那个，不做硬过滤。 */
    capability?: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

const isChannelOpen = (channel: OneClickChannelLike) => channel.enabled !== false;
const isModelOpen = (model: OneClickChannelModelLike) => model.enabled !== false;

/** 模型名匹配：精确 > 忽略大小写相等 > 包含（`seedream-5.0-pro` 命中 `doubao-seedream-5.0-pro`）。 */
function modelNameScore(modelName: string, wanted: string) {
    if (modelName === wanted) return 3;
    const left = normalize(modelName);
    const right = normalize(wanted);
    if (!right) return 0;
    if (left === right) return 2;
    if (left.includes(right) || right.includes(left)) return 1;
    return 0;
}

/**
 * 在渠道表里找一个「模型名 + 渠道名」都最贴合的目标。
 *
 * 排序口径（与用户写法的直觉一致）：
 *  1. 渠道名命中提示 **且** 模型名命中 → 最优先（`deepseek-flash(deepseek)` 就是这个意图）；
 *  2. 只命中模型名 → 次选（渠道改名 / 换渠道也能跑起来）；
 *  3. 同一档里，期望能力匹配的排前面；
 *  4. 再按 `names` / `channelHints` 里给的先后顺序。
 *
 * 找不到就返回 `null` —— 调用方据此**暂停流程**并提示，绝不静默换一个模型顶上。
 */
export function pickOneClickModel(channels: OneClickChannelLike[], seek: OneClickModelSeek): OneClickModelTarget | null {
    const names = seek.names.map((name) => name.trim()).filter(Boolean);
    if (!names.length) return null;
    const hints = (seek.channelHints || []).map(normalize).filter(Boolean);
    const usable = (channels || []).filter((channel) => channel && Array.isArray(channel.models) && isChannelOpen(channel));
    type Candidate = { target: OneClickModelTarget; channelByHint: boolean; capabilityHit: boolean; nameRank: number; hintRank: number };
    const candidates: Candidate[] = [];
    for (const channel of usable) {
        const channelName = normalize(channel.name || "");
        const hintRank = hints.findIndex((hint) => channelName.includes(hint));
        for (const model of channel.models) {
            if (!model || !isModelOpen(model)) continue;
            const nameRank = names.findIndex((wanted) => modelNameScore(model.name || "", wanted) > 0);
            if (nameRank < 0) continue;
            candidates.push({
                target: { channelId: channel.id, channelName: channel.name, modelName: model.name },
                channelByHint: hintRank >= 0,
                capabilityHit: seek.capability ? model.capability === seek.capability : true,
                nameRank,
                hintRank: hintRank < 0 ? Number.MAX_SAFE_INTEGER : hintRank,
            });
        }
    }
    if (!candidates.length) return null;
    candidates.sort(
        (left, right) =>
            Number(right.channelByHint) - Number(left.channelByHint) ||
            Number(right.capabilityHit) - Number(left.capabilityHit) ||
            left.nameRank - right.nameRank ||
            left.hintRank - right.hintRank,
    );
    return candidates[0].target;
}

export type OneClickDeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true; value: undefined };

/**
 * 给一段异步工作套上「到点即裁决」：到点先跑 `onTimeout`（调用方用它在里面 abort），再返回 `timedOut`。
 *
 * ⚠️ 关键点：**超时后必须把原来那条请求 abort 掉**，否则它会继续跑、稍后把 `scriptStatus` 写成 success，
 * 用户看到「已暂停」但表又被填上了。`onTimeout` 抛出也不影响裁决结果（一律按超时处理）。
 */
export function withDeadline<T>(work: Promise<T>, deadlineAt: number, onTimeout?: () => void, now: () => number = Date.now, setTimer = setTimeout, clearTimer = clearTimeout): Promise<OneClickDeadlineResult<T>> {
    return new Promise<OneClickDeadlineResult<T>>((resolve) => {
        let settled = false;
        const delay = Math.max(0, deadlineAt - now());
        const timer = setTimer(() => {
            if (settled) return;
            settled = true;
            try {
                onTimeout?.();
            } catch {
                // 超时回调自身的异常不能把「已暂停」变成未捕获拒绝。
            }
            resolve({ timedOut: true, value: undefined });
        }, delay);
        const finish = (value: T) => {
            if (settled) return;
            settled = true;
            clearTimer(timer as unknown as number);
            resolve({ timedOut: false, value });
        };
        work.then(finish, () => finish(undefined as unknown as T));
    });
}

/** 剩余时间（毫秒），永不为负。用于把同一个阶段预算依次分给「首发 / 重试 / 托底」。 */
export function remainingMs(deadlineAt: number, now: () => number = Date.now) {
    return Math.max(0, deadlineAt - now());
}
