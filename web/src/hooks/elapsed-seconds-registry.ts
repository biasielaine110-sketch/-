/**
 * Start-time registry behind {@link useElapsedSeconds}.
 *
 * Canvas nodes are unmounted whenever they leave the viewport, so the elapsed counter
 * must keep its origin outside React state: one timestamp per key (node id), shared by
 * every mount of that node within the page session. Anything older than MAX_ENTRY_AGE_MS
 * is treated as stale so a leftover entry from a job that was cancelled while the node
 * was off-screen cannot inflate the next run's counter.
 */
const MAX_ENTRY_AGE_MS = 6 * 60 * 60 * 1000;
const PRUNE_THRESHOLD = 64;
const startTimes = new Map<string, number>();

function isFresh(startedAt: number | undefined, now: number): startedAt is number {
    return startedAt != null && now - startedAt < MAX_ENTRY_AGE_MS;
}

/** First call for a key records `now`; later calls reuse it so a remount resumes, not restarts. */
export function beginElapsed(key: string, now: number = Date.now()): number {
    const existing = startTimes.get(key);
    if (isFresh(existing, now)) return existing;
    startTimes.set(key, now);
    if (startTimes.size > PRUNE_THRESHOLD) {
        for (const [entryKey, startedAt] of startTimes) {
            if (!isFresh(startedAt, now)) startTimes.delete(entryKey);
        }
    }
    return now;
}

/** Drops the origin so the next active run starts from zero. */
export function clearElapsed(key: string): void {
    startTimes.delete(key);
}

export function elapsedSecondsSince(startedAt: number, now: number = Date.now()): number {
    return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** Test/debug helper. */
export function resetElapsedRegistry(): void {
    startTimes.clear();
}

export const MAX_ELAPSED_ENTRY_AGE_MS = MAX_ENTRY_AGE_MS;
