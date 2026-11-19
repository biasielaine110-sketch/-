/**
 * 定时生成本该是「页面开着、到点就跑」。一旦页面关掉，排期就只是一条历史记录。
 *
 * 🔴 为什么要有这个模块（2026-11-19）：
 * 老实现是「过期就补跑」——再次打开项目时，所有 `scheduledAt <= now` 的节点会立刻
 * 一起走生成接口。用户一个画布几百张图，只要历史排期没清干净，打开一次就是几百次
 * 付费调用，体感就是「打开后没的图 / 没的视频全在重新生成」。
 *
 * 现在的口径：
 * - 到点后 `SCHEDULE_LATE_TOLERANCE_MS` 以内打开页面 → 仍然补跑（这是用户期待的“马上”）。
 * - 超过窗口 → 认为那一班车已经开走，**只清掉排期、绝不生成**，并在控制台留痕。
 *
 * 纯函数，无副作用，便于探针锁定行为。
 */

/** 排期到期后允许补跑的容忍窗口：超过就认为错过，不补跑（避免隔夜打开时批量扣费）。 */
export const SCHEDULE_LATE_TOLERANCE_MS = 60_000;

function toEpoch(value: unknown): number {
    const at = Number(value);
    return Number.isFinite(at) && at > 0 ? at : 0;
}

/** 到点、且还在容忍窗口内 → 应该跑。 */
export function isScheduleDueToRun(scheduledAt: unknown, now: number = Date.now()): boolean {
    const at = toEpoch(scheduledAt);
    if (!at) return false;
    if (at > now) return false;
    return now - at <= SCHEDULE_LATE_TOLERANCE_MS;
}

/** 已过期且超出容忍窗口 → 陈旧排期，必须丢弃而不是补跑。 */
export function isStaleSchedule(scheduledAt: unknown, now: number = Date.now()): boolean {
    const at = toEpoch(scheduledAt);
    if (!at) return false;
    return at <= now && now - at > SCHEDULE_LATE_TOLERANCE_MS;
}

type ScheduleCarrier = { id: string; metadata?: { scheduledAt?: number } & Record<string, unknown> };

/**
 * 打开项目时清洗陈旧排期：返回去掉 `scheduledAt` 的节点数组 + 被丢弃的节点 id。
 * 只删这个字段，其它 metadata 原样保留。
 */
export function dropStaleSchedules<T extends ScheduleCarrier>(nodes: T[], now: number = Date.now()): { nodes: T[]; dropped: string[] } {
    const dropped: string[] = [];
    let changed = false;
    const next = nodes.map((node) => {
        if (!isStaleSchedule(node.metadata?.scheduledAt, now)) return node;
        dropped.push(node.id);
        changed = true;
        return { ...node, metadata: { ...node.metadata, scheduledAt: undefined } };
    });
    return { nodes: changed ? next : nodes, dropped };
}
