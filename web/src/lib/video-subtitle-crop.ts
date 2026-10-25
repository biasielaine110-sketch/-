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
 *
 * —— 2026-10-25 第二轮返工（用户「画面还是坏掉的 / 卡住只有一帧 / 播不动」）——
 * 几何改对之后仍然坏，是两个**跟几何无关**的病灶：
 *  1. **只录到一帧**：`<video>` 没挂进 DOM 时，`requestVideoFrameCallback` 可能只回调一次，
 *     画布就停在第一帧。修法 = 把元素挂进 DOM（离屏但保持渲染）+ `setInterval` 兜底驱动，
 *     并用「画了多少帧」当体检指标（`judgeRecording`）。
 *  2. **没有时长**：`MediaRecorder` 写的是未知长度 Segment，**Info 里根本没有 `Duration` 元素**，
 *     浏览器于是报 `duration = Infinity`，画布节点进度条直接禁用（看着就是「播不动」）。
 *     修法 = `patchWebmDuration` 重建 Info 插入时长（见 `lib/webm-duration.ts`）。
 * 另外：录完必须自己验一遍（能播 / 帧数够 / 时长对），不合格就换容器、全不行就保留原片 ——
 * 绝不把一条「只有一帧」的片子交出去。
 */
import { forceProxyMediaUrl, proxyMediaUrl } from "@/lib/api-proxy";
import { patchWebmDuration } from "@/lib/webm-duration";

/** 字幕带默认比例：底部 12%（H3 烧字的典型位置）。 */
export const VIDEO_SUBTITLE_BAND_RATIO = 0.12;

/**
 * 去掉字幕带的三种做法（2026-10-25 用户：「能不能不降低画面精度」）：
 *  - `fill`（默认）：切掉底部那条，再**等比放大铺满原尺寸** —— 输出仍是 720×1280 / 1920×1080，
 *    构图变紧约 14%（左右各切约 7%），分辨率与码率都不降；
 *  - `crop`：只切，文件变矮（720×1126）—— 原构图、无缩放，但尺寸不是标准 9:16；
 *  - `blur`：一个像素都不裁，用上方画面模糊盖住字幕带 —— 构图零损失，代价是底部一条模糊。
 *
 * ⚠️ 三者都必须重编码（裁切本身就要求解码后重画），所以「不降精度」指的是
 * **分辨率不变 + 码率给足**，不是「不压缩」。
 */
export type SubtitleCropMode = "fill" | "crop" | "blur";

/** 面板/存档里的字符串 → 模式；`null` = 关闭去字幕。旧存档的 `"true"` 现在等于 `fill`。 */
export function normalizeSubtitleCropMode(value?: string | null): SubtitleCropMode | null {
    const raw = String(value ?? "")
        .trim()
        .toLowerCase();
    if (!raw || raw === "false" || raw === "off" || raw === "0" || raw === "none") return null;
    if (raw === "crop") return "crop";
    if (raw === "blur") return "blur";
    return "fill";
}

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
 * 录出来的字节**能不能真的播**，以及它自己报的时长是多少。
 *
 * 只看 `blob.size > 0` 不够：坏掉的 mp4/webm 照样有几百 KB，只是播出来花屏或者只有一帧。
 * 这里把它挂到一个离屏 `<video>` 上等元数据：拿得到宽高、`readyState` 至少到了元数据，
 * 才算「片子还在」。任何一步超时/抛错都判不合格 → 调用方换下一个容器；全都不合格就保留原片
 * （宁可带字幕，也不能给一条花屏的片子）。
 *
 * ⚠️ `durationMs` 是**关键体检指标**：`MediaRecorder` 的 webm 没写时长，`duration` 会是 `Infinity`
 * （这里记 0）。画布节点的进度条依赖它，`Infinity` 就等于「播不动」。所以我们在写完后用
 * `patchWebmDuration` 补上真实时长，这里读回来的值顺便当校验（≈ 源片时长才认）。
 */
async function inspectRecorded(blob: Blob, timeoutMs = 8000): Promise<{ playable: boolean; durationMs: number }> {
    if (!blob.size) return { playable: false, durationMs: 0 };
    const url = URL.createObjectURL(blob);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.src = url;
    try {
        await waitFor(probe, "loadedmetadata", timeoutMs);
        const duration = probe.duration;
        return {
            playable: Boolean(Math.round(probe.videoWidth || 0)) && Boolean(Math.round(probe.videoHeight || 0)),
            durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
        };
    } catch {
        return { playable: false, durationMs: 0 };
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
    options?: { ratio?: number; timeoutMs?: number; mode?: SubtitleCropMode },
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
    /** `fill`（默认，输出原尺寸）/ `crop`（输出变矮）/ `blur`（原尺寸 + 模糊盖住字幕带）。 */
    const mode: SubtitleCropMode = options?.mode || "fill";

    let objectUrl = "";
    let video: HTMLVideoElement | null = null;
    /**
     * ⚠️ `<video>` 必须**挂进 DOM 且真的被渲染**（离屏但不能 `display:none`）。
     * 2026-10-25 用户「画面还是坏掉的 / 卡住只有一帧」复查：未渲染的 video 元素上
     * `requestVideoFrameCallback` 可能只回调一次 —— 画布就停在第一帧，录出来是一条「卡住」的片子。
     * 现在还会用 `setInterval` 兜底驱动（见 `recordBand`），两条腿走路。
     */
    const host = typeof document !== "undefined" ? document.createElement("div") : null;
    if (host) {
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1";
    }
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
        if (host && document.body) {
            host.appendChild(video);
            document.body.appendChild(host);
        }
        await waitFor(video, "loadedmetadata", options?.timeoutMs || 20000);
        const width = Math.round(video.videoWidth || 0);
        const height = Math.round(video.videoHeight || 0);
        const targetHeight = croppedVideoHeight(height, ratio);
        if (!width || !targetHeight || targetHeight >= height) return bail(`尺寸读不出来（${width}x${height} → ${targetHeight}）`);
        /** 源片时长：补写 webm 时长要用它，也是「录出来是不是整条」的判据。 */
        const sourceMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : 0;

        // 容器候选逐个试：webm 先（稳），mp4 垫底（Chrome 的 fragmented mp4 会花屏）。
        // 每一条都要过体检 —— 只看字节数不够：坏文件照样几百 KB，播出来却是花屏/只有一帧
        // （用户 2026-10-25「现在生成的视频直接花掉了」）。
        for (const mime of mimes) {
            const recorded = await recordBand(video, width, height, targetHeight, mime, options?.timeoutMs || 180000, mode, sourceMs);
            if (!recorded) {
                console.info(`[video] 裁字幕带：容器 ${mime} 没吐出字节，换下一个`);
            } else {
                const inspected = await inspectRecorded(recorded.blob);
                const verdict = judgeRecording(recorded.frames, inspected, sourceMs);
                if (!verdict.ok) {
                    console.info(`[video] 裁字幕带：容器 ${mime} 的产物不合格（${verdict.reason}），换下一个`);
                } else {
                    // 只有 `crop` 会变矮；`fill` / `blur` 的输出尺寸与原片一致。
                    return { blob: recorded.blob, mimeType: recorded.blob.type || mime.split(";")[0] || "video/webm", width, height: mode === "crop" ? targetHeight : height };
                }
            }
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
        host?.remove();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

/**
 * 录出来的东西到底能不能交出去。
 *
 * 三条判据（任一条不满足 → 换容器，全都不行就保留原片）：
 *  1. `playable`：挂上 `<video>` 能拿到宽高；
 *  2. **帧数**够：`setInterval` 兜底 + rVFC 双驱动下，帧数应该 ≈ 30×秒数。
 *     只有个位数说明录制被掐断/标签页被节流 → 交出去就是「卡住只有一帧」；
 *  3. **时长**对得上：补写 webm 时长后应 ≈ 源片时长。差太多说明时间轴是坏的。
 *
 * ⚠️ 时长读回 0（`Infinity`）时**不直接判死**：那是 webm 没写时长的老问题，
 * 片子本身是好的，Chrome 仍能播（只是拖不动）。这种情况放行并打日志，
 * 因为「没时间轴」总比「带字幕」强；判死会让用户永远拿不到去字幕的片子。
 */
export function judgeRecording(
    frames: number,
    inspected: { playable: boolean; durationMs: number },
    sourceMs: number,
): { ok: boolean; reason?: string } {
    if (!inspected.playable) return { ok: false, reason: "解不出来" };
    if (frames < 6) return { ok: false, reason: `只画了 ${frames} 帧` };
    if (sourceMs > 0) {
        const expected = (sourceMs / 1000) * 30;
        if (frames < expected * 0.35) return { ok: false, reason: `帧数不足 ${frames}/${Math.round(expected)}` };
        if (inspected.durationMs > 0) {
            const drift = Math.abs(inspected.durationMs - sourceMs) / sourceMs;
            if (drift > 0.35) return { ok: false, reason: `时长对不上 ${inspected.durationMs}ms vs 源 ${sourceMs}ms` };
        }
    }
    return { ok: true };
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
 * `fill` 模式的矩形：切掉底部那条之后，**等比**放大铺满原尺寸。
 *
 * ⚠️ 只能等比（scale = height / keep，宽度同比放大、左右对称各切一点），
 * **绝不能只把高度拉回原高** —— 那是纵向拉伸 ~14%，人脸会被拉长，比降精度更难看。
 * 纯函数，给探针用。
 */
export function subtitleFillDrawRect(width: number, height: number, targetHeight: number) {
    const sourceWidth = Math.max(0, Math.round(width) || 0);
    const sourceHeight = Math.max(0, Math.round(height) || 0);
    const keep = Math.max(0, Math.min(Math.round(targetHeight) || 0, sourceHeight));
    const scale = keep > 0 ? sourceHeight / keep : 1;
    const dw = Math.round(sourceWidth * scale);
    return {
        sx: 0,
        sy: 0,
        sw: sourceWidth,
        sh: keep,
        // 左右对称裁掉溢出的那一截（可能为负，drawImage 允许画到画布外）
        dx: Math.round((sourceWidth - dw) / 2),
        dy: 0,
        dw,
        dh: sourceHeight,
    };
}

/**
 * 一帧到底怎么画 —— 三种模式集中在这里。抽成独立函数是为了：探针能直接验几何、
 * 注释能把每种模式的取舍写清楚，而不是散落在录制循环里。
 *
 * ⚠️ `fill` 必须**等比**放大（见 `subtitleFillDrawRect`），只拉高度会把人脸拉长。
 * ⚠️ `blur` 先把整帧 1:1 画上去，再用**上方同宽画面**盖住字幕那一条 —— 字幕像素从头到尾不参与绘制，
 * 所以不会「模糊后还能认出字」。
 */
export function drawSubtitleCropFrame(
    context: CanvasRenderingContext2D,
    video: CanvasImageSource,
    width: number,
    height: number,
    targetHeight: number,
    mode: SubtitleCropMode,
) {
    if (mode === "blur") {
        context.filter = "none";
        context.drawImage(video, 0, 0, width, height);
        const band = Math.max(1, height - targetHeight);
        const bleed = Math.max(6, Math.round(band / 3));
        // ⚠️ 取样区必须**完全落在字幕带上方**：曾写成 `sh = height - srcTop`（972→1280），
        // 把带字幕的那 154 行也圈进取样范围 —— 糊出来的仍是字幕，等于没处理。
        // 现在取「带上方的 band + 2×bleed 行」，1:1 搬到字幕带上（不拉伸）。
        const sh = Math.min(Math.max(0, height - band), band + bleed * 2);
        const sy = Math.max(0, height - band - sh);
        context.filter = `blur(${bleed}px)`;
        // 目标矩形向外扩 bleed：模糊会采样到矩形外，不扩就是一圈黑边。
        context.drawImage(video, 0, sy, width, sh, -bleed, height - band - bleed, width + bleed * 2, sh);
        context.filter = "none";
        return;
    }
    const rect = mode === "crop" ? subtitleCropDrawRect(width, height, targetHeight) : subtitleFillDrawRect(width, height, targetHeight);
    context.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
}

/**
 * 把源元素重画一遍，返回重编码后的字节 + **实际画了多少帧**。
 *
 * 单独抽出来是为了**换容器重试**（`isTypeSupported` 会撒谎、mp4 会花屏），调用方逐个候选调用它，
 * 再按 `judgeRecording` 体检产物（能不能播 / 帧数够不够 / 时长对不对）。
 *
 * 返回 `null` = 这个容器没吐出字节 / 播放或编码抛错（调用方换下一个候选）。
 *
 * ⚠️ 画帧由**两条腿**驱动（2026-10-25 用户「画面还是坏掉的 / 卡住只有一帧」）：
 *  `requestVideoFrameCallback` 跟着源帧率走，但它在**未渲染的 `<video>`** 上可能只回调一次；
 *  所以再加一个 `setInterval` 兜底。两条都调同一个 `paint()`，重复画同一帧无害，
 *  但缺了兜底那条就会录出一条「停在第一帧」的片子。
 */
async function recordBand(
    video: HTMLVideoElement,
    width: number,
    height: number,
    targetHeight: number,
    mimeType: string,
    timeoutMs: number,
    mode: SubtitleCropMode = "fill",
    sourceMs = 0,
): Promise<{ blob: Blob; frames: number } | null> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    // `crop` 会变矮；`fill` / `blur` 输出尺寸与原片一致（用户 2026-10-25 要不降精度）。
    canvas.height = mode === "crop" ? targetHeight : height;
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
    // 码率按像素给：12 Mbps 起、24 Mbps 封顶（≈ 8 bit/px）。
    // 用户 2026-10-25「能不能不降低画面精度」：重编码这一步免不掉（裁切必须解码重画），
    // 但给足码率后 VP9 在这条管线里基本视觉无损。原来是 6 Mbps 封底 / 12 Mbps 封顶，
    // 1080p 会被压出肉眼可见的软化 —— 那才是「精度下降」的主因。
    const bitrate = Math.min(24_000_000, Math.max(12_000_000, Math.round(width * canvas.height * 8)));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    let drawing = true;
    let frames = 0;
    let timer = 0;
    try {
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) chunks.push(event.data);
        };
        const stopped = new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
        });
        recorder.start(250);

        // ⚠️ 几何必须走 `drawSubtitleCropFrame` / `subtitleCropDrawRect`：这里曾经写死
        // `height - targetHeight`（=88）当源高，结果只取顶部 88 行、纵向拉伸 7 倍，整片糊成拖影 ——
        // 用户「视频直接花掉了」的真根因。
        const paint = () => {
            if (!drawing) return;
            try {
                drawSubtitleCropFrame(context, video, width, height, targetHeight, mode);
                frames += 1;
            } catch {
                // 个别帧还没解码好，跳过这一帧。
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
        paint();
        // 兜底驱动：不依赖 rVFC 是否回调（未渲染元素上它可能只来一次）。
        timer = window.setInterval(paint, 33);
        if ("requestVideoFrameCallback" in video) {
            const followFrame = () => {
                if (!drawing) return;
                paint();
                (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(followFrame);
            };
            (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(followFrame);
        }
        await waitFor(video, "ended", timeoutMs);
        drawing = false;
        window.clearInterval(timer);
        timer = 0;
        recorder.stop();
        await stopped;

        const raw = new Blob(chunks, { type: mimeType.split(";")[0] });
        if (!raw.size) return null;
        // ⚠️ webm 补写时长：MediaRecorder 写的是未知长度 Segment + Duration=0，浏览器会把
        // `duration` 报成 Infinity，画布进度条于是禁用（「播不动」）。用源片时长补上。
        // 源片自己是 webm 时 `duration` 也是 Infinity —— 那就拿播完时的 `currentTime` 当真实时长。
        const elapsedMs = Number.isFinite(video.currentTime) && video.currentTime > 0 ? Math.round(video.currentTime * 1000) : 0;
        const blob = mimeType.includes("webm") ? await patchWebmDuration(raw, sourceMs || elapsedMs) : raw;
        return { blob, frames };
    } catch (error) {
        console.warn(`[video] 裁字幕带（${mimeType}）失败`, error);
        return null;
    } finally {
        drawing = false;
        if (timer) window.clearInterval(timer);
        try {
            if (recorder.state !== "inactive") recorder.stop();
        } catch {
            /* ignore */
        }
        stream.getTracks().forEach((track) => track.stop());
    }
}
