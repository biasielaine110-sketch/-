/**
 * Serializes native ComfyUI / H3 video jobs (U24, H3-video, U30, U35, U06, U37, …).
 *
 * The pod can only run one heavy H3 graph safely. Parallel `/prompt` submissions cause 502/OOM,
 * and aborting one request can `/interrupt` another. Callers enqueue the full
 * request → download → store → canvas write-back so the next job starts only after the previous
 * clip is on the node.
 */

let nativeVideoJobTail: Promise<void> = Promise.resolve();

export function enqueueNativeComfyVideoJob<T>(job: () => Promise<T>): Promise<T> {
    const run = nativeVideoJobTail.catch(() => undefined).then(job);
    nativeVideoJobTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}
