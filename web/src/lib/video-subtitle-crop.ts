/**
 * 底部字幕带裁切 —— 把 H3 烧进画面的硬字幕切掉。
 *
 * 为什么必须在这里做（2026-10-25 排查结论）：
 *  - Fisher 的图里**没有任何字幕/叠字节点**（31 个节点全查过），H3 节点 `MiniMaxH3ReferenceToVideo`
 *    也只收 prompt / 宽高 / 时长 / 参考图，**没有字幕开关**；
 *  - 提示词里那句「不要出现字幕和音乐」在静音镜（`- **对白**：无`）上会被整句撤掉（`stripH3SoundNote`），
 *    可静音镜**照样出字幕** —— 说明这不是提示词喂词，是作者那支 `MysticXXX_MMH3-V1` LoRA
 *    （真人实拍/韩剧味，训练数据带硬字幕）让模型默认把字烧进去，和韩语人声同一个根因；
 *  - 图侧插 `ImageCrop` 也不行：它要精确整数宽高，而实际分辨率由 `ResolutionSelector`
 *    （`megapixels`/`multiple`，且会被我们 patch）动态算出来，`ComfyMathExpression` 的 `values.*`
 *    又是 FLOAT —— 类型/尺寸一旦不匹配就是**整条生成失败**，比带字幕严重得多。
 *
 * 所以走浏览器侧重编码：`<video>` → `canvas`（只画上半部分）→ `MediaRecorder`。
 * ⚠️ 一定是「尽力而为」：任何一步失败都返回 `null`，调用方保持原片 —— 宁可带字幕，不能没片子。
 * ⚠️ 保留音轨（用户 2026-10-25 明确「我需要保持环境音效啊」）：从源元素 `captureStream()` 取音频轨
 *    混进 canvas 流；拿不到就退化成无声裁切，但仍然交出画面。
 */

/** 字幕带默认比例：底部 12%（H3 烧字的典型位置）。 */
export const VIDEO_SUBTITLE_BAND_RATIO = 0.12;

/**
 * 裁掉底部 `ratio` 之后的高度。纯函数，给探针用。
 * - 取偶数：h264/mp4 要求偶数高，奇数会直接编码失败；
 * - `ratio` 夹在 0–0.4：写 1 会把画面裁没；
 * - 源高太小（< 4）返回 0 表示「不要裁」。
 */
export function croppedVideoHeight(height: number, ratio: number = VIDEO_SUBTITLE_BAND_RATIO): number {
    const source = Math.round(Number(height) || 0);
    if (source < 4) return 0;
    const safe = Math.min(0.4, Math.max(0, Number(ratio) || 0));
    const next = Math.floor((source * (1 - safe)) / 2) * 2;
    return next >= 2 ? next : source;
}

/** 选一个当前浏览器真的能录的容器。mp4 优先（体积小、剪辑软件直接吃），再退 webm。 */
export function pickVideoRecorderMime(): string {
    const recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    if (!recorder || typeof recorder.isTypeSupported !== "function") return "";
    const candidates = [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
    ];
    for (const mime of candidates) {
        try {
            if (recorder.isTypeSupported(mime)) return mime;
        } catch {
            // isTypeSupported 在个别内核上会抛，忽略这一个候选。
        }
    }
    return "";
}

export type CroppedVideo = { blob: Blob; mimeType: string; width: number; height: number };

function waitFor(target: EventTarget, event: string, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            target.removeEventListener(event, onDone);
            reject(new Error(`timeout waiting ${event}`));
        }, timeoutMs);
        function onDone() {
            clearTimeout(timer);
            target.removeEventListener(event, onDone);
            resolve();
        }
        target.addEventListener(event, onDone, { once: true });
    });
}

/**
 * 把视频底部 `ratio` 切掉，返回重编码后的 blob。
 *
 * @param source  远端 URL 或已拿到的 blob（二选一）
 * @returns 成功返回新 blob；浏览器不支持 / 跨域取不到字节 / 超时 / 任何异常 → `null`
 */
export async function cropVideoBottomBand(
    source: { url?: string; blob?: Blob },
    options?: { ratio?: number; timeoutMs?: number },
): Promise<CroppedVideo | null> {
    if (typeof document === "undefined") return null;
    const mimeType = pickVideoRecorderMime();
    if (!mimeType) return null;

    const ratio = Math.min(0.4, Math.max(0, Number(options?.ratio ?? VIDEO_SUBTITLE_BAND_RATIO) || 0));
    if (ratio <= 0) return null;

    let objectUrl = "";
    let video: HTMLVideoElement | null = null;
    let recorder: MediaRecorder | null = null;
    try {
        const blob = source.blob || (source.url ? await (await fetch(source.url)).blob() : null);
        if (!blob || blob.size === 0) return null;
        objectUrl = URL.createObjectURL(blob);

        video = document.createElement("video");
        video.src = objectUrl;
        video.playsInline = true;
        // ⚠️ 不能设 muted：muted 的元素不产出音频样本，captureStream() 拿到的音轨会是静音的。
        // 用 volume=0 让它不吵到用户（音量是输出端属性，不影响被捕获的轨道）。
        video.muted = false;
        video.volume = 0;
        video.preload = "auto";
        video.crossOrigin = null;
        await waitFor(video, "loadedmetadata", options?.timeoutMs || 20000);
        const width = Math.round(video.videoWidth || 0);
        const height = Math.round(video.videoHeight || 0);
        const targetHeight = croppedVideoHeight(height, ratio);
        if (!width || !targetHeight || targetHeight >= height) return null;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = targetHeight;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return null;

        // 帧率跟着源走，取不到就 30；canvas.captureStream(fps) 会自动按这时钟抓帧。
        const fps = 30;
        const stream = canvas.captureStream(fps);
        try {
            // `captureStream()` 在 lib.dom 里没上 HTMLVideoElement（Chrome/Safari 都有），用结构化断言取。
            const capturable = video as HTMLVideoElement & { captureStream?: () => MediaStream };
            const captured = typeof capturable.captureStream === "function" ? capturable.captureStream() : null;
            captured?.getAudioTracks().forEach((track: MediaStreamTrack) => stream.addTrack(track));
        } catch {
            // 拿不到音轨就录无声 —— 画面无字幕优先，音轨下不为例。
        }

        const chunks: BlobPart[] = [];
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) chunks.push(event.data);
        };
        const stopped = new Promise<void>((resolve) => {
            recorder!.onstop = () => resolve();
        });
        recorder.start(250);

        // 逐帧只画上半部分：源 (0,0,width,height-targetHeight) → 目标铺满整个 canvas。
        let drawing = true;
        const draw = () => {
            if (!drawing || !video) return;
            try {
                context.drawImage(video, 0, 0, width, height - targetHeight, 0, 0, width, targetHeight);
            } catch {
                // 个别帧还没解码好，跳过这一帧。
            }
            if ("requestVideoFrameCallback" in video) {
                (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(draw);
            } else {
                requestAnimationFrame(draw);
            }
        };

        // 自动播放策略：带声音的元素在个别浏览器会被拦，拦了就退成静音再播一次 ——
        // 宁可这条片子丢了音轨，也不能因为播不动而让整次裁切失败（失败就退回带字幕的原片）。
        try {
            await video.play();
        } catch {
            video.muted = true;
            await video.play();
        }
        draw();
        await waitFor(video, "ended", options?.timeoutMs || 180000);
        drawing = false;
        recorder.stop();
        await stopped;
        stream.getTracks().forEach((track) => track.stop());

        const out = new Blob(chunks, { type: mimeType.split(";")[0] });
        if (!out.size) return null;
        return { blob: out, mimeType: out.type || "video/webm", width, height: targetHeight };
    } catch (error) {
        console.warn("[video] 裁字幕带失败，保持原片", error);
        return null;
    } finally {
        try {
            recorder?.state !== "inactive" && recorder?.stop();
        } catch {
            /* ignore */
        }
        video?.pause();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}
