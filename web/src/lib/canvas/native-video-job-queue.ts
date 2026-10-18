/**
 * Serializes native ComfyUI / H3 video jobs on the canvas.
 *
 * Next `/prompt` starts only after the previous job has either written the clip
 * back to the node or failed/canceled. Errors must not block the chain.
 *
 * Also exposes queue order for canvas UI (排队中 2/3 · 生成中 1/3).
 * Cancel/abort removes the entry immediately so totals shrink right away.
 *
 * Scope: only the one rented H3 pod below is serialized. The FIFO is a property of *that machine*
 * (one job at a time or it OOMs), not of the model class — RunningHub / Metaso / other pods must
 * submit immediately even when the model name is identical, and a queued job on this pod must not
 * hold up anything else.
 */

/** 公司h3 渠道的 AutoDL 机器：同一时刻只能跑一个 H3 任务。 */
const SERIALIZED_VIDEO_HOSTS = new Set(["u1209428-7915ffc1db59.westd.seetacloud.com"]);

/**
 * True only for the host that has to be serialized.
 *
 * Keyed on the exact hostname rather than the channel label: the constraint belongs to the pod, so
 * a renamed channel — or a second channel pointing at the same pod — is still serialized, while a
 * different pod with the same models is not.
 */
export function isSerializedNativeVideoBaseUrl(baseUrl: string) {
    const raw = String(baseUrl || "").trim().toLowerCase();
    if (!raw) return false;
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    const authority = withoutScheme.split(/[/?#]/)[0];
    const host = (authority.split("@").pop() || "").split(":")[0];
    return SERIALIZED_VIDEO_HOSTS.has(host);
}


export type NativeVideoQueueEntry = {
    id: string;
    targetNodeId: string;
    versionId?: string;
    phase: "queued" | "running";
    /** 1-based position in the current FIFO. */
    position: number;
    total: number;
};

type InternalJob = {
    id: string;
    targetNodeId: string;
    versionId?: string;
    phase: "queued" | "running";
};

let nativeVideoJobTail: Promise<void> = Promise.resolve();
let jobs: InternalJob[] = [];
let cachedSnapshot: NativeVideoQueueEntry[] = [];
const listeners = new Set<() => void>();

function rebuildSnapshot() {
    const total = jobs.length;
    cachedSnapshot = jobs.map((job, index) => ({
        id: job.id,
        targetNodeId: job.targetNodeId,
        versionId: job.versionId,
        phase: job.phase,
        position: index + 1,
        total,
    }));
}

function notify() {
    rebuildSnapshot();
    for (const listener of listeners) listener();
}

function removeJob(id: string) {
    const next = jobs.filter((item) => item.id !== id);
    if (next.length === jobs.length) return false;
    jobs = next;
    notify();
    return true;
}

/** Stable reference between mutations — required by useSyncExternalStore. */
export function getNativeVideoQueueSnapshot() {
    return cachedSnapshot;
}

/**
 * Prefer the running job for a node; otherwise the earliest queued one.
 * Multiple generates on the same node share one badge (1/3, 2/3, …).
 */
export function pickNativeVideoQueueEntryForNode(
    snapshot: NativeVideoQueueEntry[],
    targetNodeId: string,
): NativeVideoQueueEntry | undefined {
    const mine = snapshot.filter((job) => job.targetNodeId === targetNodeId);
    if (!mine.length) return undefined;
    return mine.find((job) => job.phase === "running") || mine[0];
}

export function subscribeNativeVideoQueue(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Drop waiting/running FIFO entries for a canvas node (e.g. user hit Cancel). */
export function cancelNativeVideoQueueJobsForNode(targetNodeId: string) {
    const next = jobs.filter((item) => item.targetNodeId !== targetNodeId);
    if (next.length === jobs.length) return;
    jobs = next;
    notify();
}

/** Drop FIFO entries for any of the given canvas nodes. */
export function cancelNativeVideoQueueJobsForNodes(targetNodeIds: Iterable<string>) {
    const ids = targetNodeIds instanceof Set ? targetNodeIds : new Set(targetNodeIds);
    if (!ids.size) return;
    const next = jobs.filter((item) => !ids.has(item.targetNodeId));
    if (next.length === jobs.length) return;
    jobs = next;
    notify();
}

let jobSeq = 0;

export function enqueueNativeComfyVideoJob<T>(
    job: () => Promise<T>,
    meta: { targetNodeId: string; versionId?: string; signal?: AbortSignal },
): Promise<T> {
    const id = `nvq_${Date.now().toString(36)}_${(jobSeq += 1).toString(36)}`;
    const entry: InternalJob = {
        id,
        targetNodeId: meta.targetNodeId,
        versionId: meta.versionId,
        phase: "queued",
    };

    if (meta.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    jobs = [...jobs, entry];
    notify();

    const onAbort = () => {
        removeJob(id);
    };
    meta.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may have fired between the early check and addEventListener.
    if (meta.signal?.aborted) {
        removeJob(id);
        return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    const run = nativeVideoJobTail.catch(() => undefined).then(async () => {
        // Canceled while waiting: entry already gone — skip without running.
        if (!jobs.some((item) => item.id === id) || meta.signal?.aborted) {
            removeJob(id);
            throw new DOMException("Aborted", "AbortError");
        }
        const current = jobs.find((item) => item.id === id);
        if (current) current.phase = "running";
        notify();
        try {
            return await job();
        } finally {
            meta.signal?.removeEventListener("abort", onAbort);
            removeJob(id);
        }
    });

    // Always advance the tail, including on failure/cancel.
    nativeVideoJobTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}
