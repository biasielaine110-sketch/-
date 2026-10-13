/**
 * Serializes native ComfyUI / H3 video jobs on the canvas.
 *
 * Next `/prompt` starts only after the previous job has either written the clip
 * back to the node or failed/canceled. Errors must not block the chain.
 *
 * Also exposes queue order for canvas UI (排队中 2/3 · 生成中 1/3).
 */

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

/** Stable reference between mutations — required by useSyncExternalStore. */
export function getNativeVideoQueueSnapshot() {
    return cachedSnapshot;
}

export function subscribeNativeVideoQueue(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

let jobSeq = 0;

export function enqueueNativeComfyVideoJob<T>(
    job: () => Promise<T>,
    meta: { targetNodeId: string; versionId?: string },
): Promise<T> {
    const id = `nvq_${Date.now().toString(36)}_${(jobSeq += 1).toString(36)}`;
    const entry: InternalJob = {
        id,
        targetNodeId: meta.targetNodeId,
        versionId: meta.versionId,
        phase: "queued",
    };
    jobs = [...jobs, entry];
    notify();

    const run = nativeVideoJobTail.catch(() => undefined).then(async () => {
        const current = jobs.find((item) => item.id === id);
        if (current) current.phase = "running";
        notify();
        try {
            return await job();
        } finally {
            jobs = jobs.filter((item) => item.id !== id);
            notify();
        }
    });

    // Always advance the tail, including on failure/cancel.
    nativeVideoJobTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}
