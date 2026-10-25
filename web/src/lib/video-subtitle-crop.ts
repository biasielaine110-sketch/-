/**
 * 底部字幕带裁切 —— 把 H3 烧进画面的硬字幕切掉。
 *
 * 为什么必须在这里做（2026-10-25 排查结论）：
 *  - Fisher 的图里**没有任何字幕/叠字节点**（31 个节点全查过），H3 节点 `MiniMaxH3ReferenceToVideo`
 *    也只收 prompt / 宽高 / 时长 / 参考图，**没有字幕开关**；
 *  - 提示词里那句「不要出现字幕和文字」在静音镜（`- **对白**：无`）上会被整句撤掉（`stripH3SoundNote`），
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
import { forceProxyMediaUrl, proxyMediaUrl } from "@/lib/api-proxy";

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

/** 选一个当前浏览器真的能录的容器（首选 webm，见 `pickVideoRecorderMimes`）。 */
export function pickVideoRecorderMime(): string {
    return pickVideoRecorderMimes()[0] || "";
}

/**
 * 同上，但返回**整条候选链**。
 *
 * ⚠️ **webm 优先，mp4 只当兜底**（2026-10-25 第二次返工，用户「现在生成的视频直接花掉了」）：
 * `canvas.captureStream()` + `MediaRecorder` 这条路上，Chrome 的 **mp4 容器不可靠** ——
 * 它录的是 fragmented mp4，常见结果是花屏/坏帧/拖不动；文件非 0 字节，所以「0 字节就换下一个」
 * 那套判据根本拦不住它。webm（vp9/vp8 + opus）才是这条管线里稳的那个。
 * 剪辑软件（PR/达芬奇/剪映）都吃 webm，真需要 mp4 转一道就行 —— 花屏的 mp4 等于没片子。
 *
 * ⚠️ `isTypeSupported()` 还会撒谎：声称支持某个候选、`start()` 之后一个字节都不吐。
 * 所以调用方要能拿整条链逐个重试，并对产物做一次「能不能真的解码」的体检（`playableRecorded`）。
 */
export function pickVideoRecorderMimes(): string[] {
    const recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    if (!recorder || typeof recorder.isTypeSupported !== "function") return [];
    const candidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
    ];
    const supported: string[] = [];
    for (const mime of candidates) {
        try {
            if (recorder.isTypeSupported(mime)) supported.push(mime);
        } catch {
            // isTypeSupported 在个别内核上会抛，忽略这一个候选。
        }
    }
    return supported;
}

/**
 * 录出来的字节**能不能真的解码**。
 *
 * 只看 `blob.size > 0` 不够：坏掉的 mp4/webm 照样有几百 KB，只是播出来花屏或者只有一帧。
 * 这里把它挂到一个离屏 `<video>` 上等元数据：拿得到宽高、`readyState` 至少到了元数据，
 * 才算「片子还在」。任何一步超时/抛错都判不合格 → 调用方换下一个容器；全都不合格就保留原片
 * （宁可带字幕，也不能给一条花屏的片子）。
 */
async function playableRecorded(blob: Blob, timeoutMs = 6000): Promise<boolean> {
    if (!blob.size) return false;
    const url = URL.createObjectURL(blob);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.src = url;
    try {
        await waitFor(probe, "loadedmetadata", timeoutMs);
        return Boolean(Math.round(probe.videoWidth || 0)) && Boolean(Math.round(probe.videoHeight || 0));
    } catch {
        return false;
    } finally {
        probe.removeAttribute("src");
        try {
            probe.load();
        } catch {
            /* ignore */
        }
        URL.revokeObjectURL(url);
    }
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
 * 取成片字节。⚠️ 先直连、失败再**强制**走站点代理。
 *
 * RunningHub 的成片在 `*.xiaoyaoyou.com`（TOS）。这个域在 `DIRECT_CORS_HOSTS` 名单里 ——
 * 但那份名单是为「带 Authorization 的 POST」核过的，`proxyMediaUrl` 见到它就会**原样返回直连地址**，
 * 等于没有回退（用户 2026-10-25「还是有字幕」的第二种可能）。所以这里用 `forceProxyMediaUrl`：
 * 它专门为「plain GET 的媒体下载」设计，无条件拼 `/api/proxy?target=…`。
 */
async function fetchVideoBlob(url: string): Promise<Blob> {
    try {
        const direct = await fetch(url);
        if (!direct.ok) throw new Error(`direct HTTP ${direct.status}`);
        return await direct.blob();
    } catch (directError) {
        if (!/^https?:/i.test(url)) throw directError;
        const proxied = forceProxyMediaUrl(url) || proxyMediaUrl(url);
        if (!proxied || proxied === url) throw directError;
        console.info("[video] 直连取成片失败，改走站点代理", directError);
        const viaProxy = await fetch(proxied);
        if (!viaProxy.ok) throw new Error(`proxy HTTP ${viaProxy.status}`);
        return await viaProxy.blob();
    }
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
    // 每一条「静默放弃」都留一句原因：用户下次说「还是有字幕」时，控制台能直接指出卡在哪一步
    // （没录制器 / 取不到字节 / 尺寸读不出来 / 编码抛错），不用再靠猜。
    const bail = (reason: string) => {
        console.info(`[video] 裁字幕带跳过：${reason}`);
        return null;
    };

    if (typeof document === "undefined") return bail("当前环境没有 document");
    // 最多试两个容器：首选容器 0 字节时换下一个重录一次（`isTypeSupported` 会撒谎）。
    const mimes = pickVideoRecorderMimes().slice(0, 2);
    if (!mimes.length) return bail("浏览器不支持 MediaRecorder 录制");

    const ratio = Math.min(0.4, Math.max(0, Number(options?.ratio ?? VIDEO_SUBTITLE_BAND_RATIO) || 0));
    if (ratio <= 0) return bail("裁切比例为 0");

    let objectUrl = "";
    let video: HTMLVideoElement | null = null;
    try {
        const blob = source.blob || (source.url ? await fetchVideoBlob(source.url) : null);
        if (!blob || blob.size === 0) return bail("取不到成片字节（直连与代理都失败）");
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
        if (!width || !targetHeight || targetHeight >= height) return bail(`尺寸读不出来（${width}x${height} → ${targetHeight}）`);

        // 容器候选逐个试：webm 先（稳），mp4 垫底（Chrome 的 fragmented mp4 会花屏）。
        // 每一条都要过 `playableRecorded` 体检 —— 只看字节数不够：坏文件照样几百 KB，
        // 播出来却是花屏/只有一帧（用户 2026-10-25「现在生成的视频直接花掉了」）。
        for (const mime of mimes) {
            const out = await recordBand(video, width, height, targetHeight, mime, options?.timeoutMs || 180000);
            if (out && (await playableRecorded(out))) {
                return { blob: out, mimeType: out.type || mime.split(";")[0] || "video/webm", width, height: targetHeight };
            }
            console.info(`[video] 裁字幕带：容器 ${mime} 的产物不合格${out ? `（${out.size} 字节但解不出来）` : "（没吐字节）"}，换下一个`);
            // 换容器重录前把元素倒回开头（上一轮可能已经播到结尾）。
            try {
                video.pause();
                video.currentTime = 0;
            } catch {
                /* 倒不回去就只能放弃后面这些容器 */
            }
        }
        return bail(`没有可用的录制容器（试过 ${mimes.join(" / ")}）`);
    } catch (error) {
        console.warn("[video] 裁字幕带失败，保持原片", error);
        return null;
    } finally {
        video?.pause();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

/**
 * 每一帧要画的**源矩形与目标矩形**。纯函数，给探针用。
 *
 * ⚠️ `drawImage` 的签名是 `(src, sx, sy, sw, sh, dx, dy, dw, dh)`，第 4 个参数是**源画面要取的高度**。
 * `dfba0e8` 在这里写成了 `sh = height - targetHeight`（720−632 = **88**）—— 那不是「留下的高度」，
 * 而是「被切掉的高度」。等于只取顶部 88 行、纵向拉伸 ~7 倍铺满 632 行：整幅画面糊成一条竖着的拖影，
 * 就是用户 2026-10-25 说的「生成的视频直接花掉了」。
 * 正确写法：取顶部 `targetHeight` 行（= height×(1-ratio)）**原样 1:1** 铺进同高的 canvas，不缩放。
 */
export function subtitleCropDrawRect(width: number, height: number, targetHeight: number) {
    const keep = Math.max(0, Math.min(Math.round(targetHeight) || 0, Math.round(height) || 0));
    return {
        sx: 0,
        sy: 0,
        // 源：顶部 keep 行（切掉底部那一条）。⚠️ 是 keep，不是 height - keep。
        sw: width,
        sh: keep,
        // 目标：铺满 canvas（宽高与源区域一致 → 1:1，不放大不拉伸）
        dx: 0,
        dy: 0,
        dw: width,
        dh: keep,
    };
}

/**
 * 把源元素的上半部分录一遍，返回重编码后的字节。
 *
 * 单独抽出来是为了**换容器重试**（`isTypeSupported` 会撒谎、mp4 会花屏），调用方逐个候选调用它，
 * 并对产物再做一次可解码体检（`playableRecorded`）。
 *
 * 返回 `null` = 这个容器没吐出字节 / 播放或编码抛错（调用方换下一个候选）。
 */
async function recordBand(
    video: HTMLVideoElement,
    width: number,
    height: number,
    targetHeight: number,
    mimeType: string,
    timeoutMs: number,
): Promise<Blob | null> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;

    // 帧率跟着源走，取不到就 30；canvas.captureStream(fps) 会自动按这时钟抓帧。
    const stream = canvas.captureStream(30);
    try {
        // `captureStream()` 在 lib.dom 里没上 HTMLVideoElement（Chrome/Safari 都有），用结构化断言取。
        const capturable = video as HTMLVideoElement & { captureStream?: () => MediaStream };
        const captured = typeof capturable.captureStream === "function" ? capturable.captureStream() : null;
        captured?.getAudioTracks().forEach((track: MediaStreamTrack) => stream.addTrack(track));
    } catch {
        // 拿不到音轨就录无声 —— 画面无字幕优先，音轨下不为例。
    }

    const chunks: BlobPart[] = [];
    // 码率按像素给：6 Mbps 起、12 Mbps 封顶。给低了 1080p 会糊成一块块，看起来同样像「花掉」。
    const bitrate = Math.min(12_000_000, Math.max(6_000_000, Math.round(width * targetHeight * 4)));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    let drawing = true;
    try {
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) chunks.push(event.data);
        };
        const stopped = new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
        });
        recorder.start(250);

        // ⚠️ 几何必须走 `subtitleCropDrawRect`：这里曾经写死 `height - targetHeight`（=88）当源高，
        // 结果只取顶部 88 行、纵向拉伸 7 倍，整片糊成拖影 —— 用户「视频直接花掉了」的真根因。
        const rect = subtitleCropDrawRect(width, height, targetHeight);
        const draw = () => {
            if (!drawing) return;
            try {
                context.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
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
        await waitFor(video, "ended", timeoutMs);
        drawing = false;
        recorder.stop();
        await stopped;

        const out = new Blob(chunks, { type: mimeType.split(";")[0] });
        return out.size ? out : null;
    } catch (error) {
        console.warn(`[video] 裁字幕带（${mimeType}）失败`, error);
        return null;
    } finally {
        drawing = false;
        try {
            if (recorder.state !== "inactive") recorder.stop();
        } catch {
            /* ignore */
        }
        stream.getTracks().forEach((track) => track.stop());
    }
}
