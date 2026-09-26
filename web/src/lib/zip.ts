import { AsyncUnzipInflate, Unzip, zipSync, type UnzipFile } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

/**
 * Streaming zip reader. Instead of slurping the whole archive into memory and inflating every entry
 * synchronously (`unzipSync`), this decodes entries one at a time through fflate's `Unzip` and hands
 * each file to `onFile` as soon as it is decompressed. The caller persists each blob (e.g. to
 * IndexedDB) before the next entry is processed, so large canvases — hundreds of MB of video/image —
 * no longer freeze the main thread or spike memory to several times the zip size.
 *
 * The returned promise resolves only after every `onFile` call has settled, so callers can rely on
 * async `onFile` work (like `blob.text()` or `setMediaBlob`) having completed.
 */
export async function readZipStreaming(
    file: Blob,
    onFile: (name: string, blob: Blob) => void | Promise<void>,
    onProgress?: (decodedBytes: number, totalBytes: number) => void,
) {
    const totalBytes = file.size;
    let decodedBytes = 0;

    // Track in-flight consumer work so we can resolve only after every blob has been fully handled.
    const consumerTasks = new Set<Promise<void>>();
    let finishSignal: (() => void) | null = null;
    const drained = new Promise<void>((resolve) => (finishSignal = resolve));

    const unzip = new Unzip();
    unzip.register(AsyncUnzipInflate);

    // Track how many entries are still streaming so we can detect when the archive is fully drained.
    // `onfile` fires once per entry; `ondata(..., final=true)` fires once per entry when its bytes are
    // complete (including zero-byte entries, which emit an immediate final with empty data).
    let openEntries = 0;
    let pushFinished = false;

    const maybeDrain = () => {
        if (pushFinished && openEntries === 0) finishSignal?.();
    };

    unzip.onfile = (info: UnzipFile) => {
        openEntries += 1;
        const chunks: Uint8Array[] = [];
        info.ondata = (err, data, final) => {
            if (err) throw err;
            if (data && data.length) {
                chunks.push(data);
                decodedBytes += data.length;
                onProgress?.(decodedBytes, totalBytes);
            }
            if (final) {
                // `new Blob(chunks)` copies the bytes, so clearing `chunks` afterwards is safe.
                const blob = new Blob(chunks as BlobPart[], { type: "" });
                const task = Promise.resolve(onFile(info.name, blob)).then(() => {
                    chunks.length = 0;
                });
                consumerTasks.add(task);
                task.then(() => consumerTasks.delete(task));
                openEntries -= 1;
                maybeDrain();
            }
        };
        info.start();
    };

    // Feed the archive in slices straight from the underlying stream, so a 600MB file never has to be
    // fully resident as one buffer. Yielding to the event loop between slices keeps the UI responsive
    // and lets progress paint. `unzip.push(chunk, final)` drives both stored and deflated entries.
    const stream = file.stream().getReader();
    let eof = false;
    while (!eof) {
        const { value, done } = await stream.read();
        eof = !!done;
        const chunk = value ? new Uint8Array(await new Blob([value]).arrayBuffer()) : new Uint8Array(0);
        if (chunk.length) unzip.push(chunk, eof);
        else if (eof) unzip.push(new Uint8Array(0), true);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    pushFinished = true;
    maybeDrain();

    await drained;
    while (consumerTasks.size) await Promise.all([...consumerTasks]);
    onProgress?.(decodedBytes, totalBytes);
}

/**
 * Backward-compatible helper: inflate the whole archive into a Map. Kept for small archives and any
 * caller that still needs random access to every entry at once. Large-file callers should prefer
 * {@link readZipStreaming} and persist entries incrementally.
 */
export async function readZip(file: Blob) {
    const entries = new Map<string, Blob>();
    await readZipStreaming(file, (name, blob) => {
        entries.set(name, blob);
    });
    return entries;
}
