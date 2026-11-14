import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Segmented, Tooltip } from "antd";
import { Combine, Download, Film, ImagePlus, LoaderCircle, Pause, Play, Scissors, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import {
    applyMergeClipSourceDuration,
    formatMergeClock,
    locateMergePosition,
    markMergeClipTrimmed,
    mergeClipFollowsSource,
    MIN_MERGE_CLIP_SEC,
    moveMergeClip,
    nextPlayableMergeIndex,
    normalizeMergeClip,
    probeMediaDuration,
    removeMergeClip,
    resetMergeClipToFull,
    resolveMergeCanvasSize,
    resolveMergeSpans,
    roundSeconds,
    totalMergeLengthSec,
    VIDEO_MERGE_ASPECTS,
    type ResolvedVideoMergeClip,
} from "@/lib/canvas/video-merge";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasVideoMergeClip } from "@/types/canvas";

type CanvasVideoMergeNodeContentProps = {
    node: CanvasNodeData;
    clips: ResolvedVideoMergeClip[];
    isExporting: boolean;
    /** 正在本地渲染 mp4（重活，按钮要锁住，别让人连点两遍）。 */
    isRendering: boolean;
    /** 0–1；没在渲染时给 0。 */
    renderProgress: number;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    /** 把素材从时间线移出时，顺手断掉它连进本节点的那根线（时间线 = 连线，两边必须对称）。 */
    onDetachClips?: (nodeId: string, sourceNodeIds: string[]) => void;
    onExport: (nodeId: string) => void;
    onRender: (nodeId: string) => void;
};

export function CanvasVideoMergeNodeContent({ node, clips, isExporting, isRendering, renderProgress, onConfigChange, onDetachClips, onExport, onRender }: CanvasVideoMergeNodeContentProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<number | null>(null);
    const dragOverRef = useRef<number | null>(null);
    const dragStateRef = useRef<{ from: number; startX: number; startY: number; active: boolean } | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    /**
     * 「整条显示」= 把时间线上所有段当成**一条片子**播：一个播放头、一个总时长，
     * 某段走到出点就静默接到下一段（不换回"单条"、不回到 0:00），进度条横跨整条。
     * 关掉回到单条预览（拖入出点那套）。
     */
    const [playAll, setPlayAll] = useState(false);
    const [playIndex, setPlayIndex] = useState(0);
    /** 整条时间线上的播放头（秒，跨段累计，不是某一段的 currentTime）。 */
    const [playheadSec, setPlayheadSec] = useState(0);
    const [playPaused, setPlayPaused] = useState(false);
    const playheadRef = useRef(0);
    const playStageRef = useRef<HTMLVideoElement | null>(null);
    /**
     * 换段时要把新媒体元素 seek 到「段内偏移」而不是入点 —— 点了进度条中间就必须从那儿接。
     * 用 nodeId 认领，避免 key 重挂后把上一条的值用到新段上。
     */
    const pendingSeekRef = useRef<{ nodeId: string; atSec: number } | null>(null);

    const rawClips = node.metadata?.videoMergeClips || [];
    const totalSeconds = useMemo(() => totalMergeLengthSec(rawClips), [rawClips]);
    const safeIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, clips.length - 1));
    const selected = clips[safeIndex];

    // ── 整条显示 ────────────────────────────────────────────────────────────────
    // 段区间只算一份：进度条宽度、播放头位置、点哪跳哪全走它，三处各算一套必然跑偏。
    const { spans, totalSec: playTotalSec } = useMemo(() => resolveMergeSpans(rawClips), [rawClips]);
    const playIndexSafe = Math.min(Math.max(0, playIndex), Math.max(0, clips.length - 1));
    const playClip = clips[playIndexSafe];
    const playSpan = spans[playIndexSafe];

    /** 播放头写两处：state 给渲染，ref 给定时器 / 事件回调读最新值（不进依赖，免得反复重启）。 */
    const setHead = (sec: number) => {
        const clamped = Math.max(0, Math.min(playTotalSec, Number(sec) || 0));
        playheadRef.current = clamped;
        setPlayheadSec(clamped);
    };

    /** 切到第 index 段（自动跳过不能播的占位段），段内从 offsetSec 接着演。 */
    const gotoPlayClip = (index: number, offsetSec = 0) => {
        const next = nextPlayableMergeIndex(clips, index);
        if (next < 0) return false;
        const target = clips[next];
        pendingSeekRef.current = { nodeId: target.clip.nodeId, atSec: Math.max(0, target.clip.inSec + offsetSec) };
        setPlayIndex(next);
        // 时间线条上的高亮跟着播放头走：播到第几段就亮哪一块。
        setSelectedIndex(next);
        return true;
    };

    /** 进入整条：从第一段能播的段起，播放头归零。已经在整条时再点一次 = 从头重播。 */
    const startPlayAll = () => {
        const first = nextPlayableMergeIndex(clips, 0);
        const index = Math.max(0, first);
        pendingSeekRef.current = null;
        setPlayIndex(index);
        setSelectedIndex(index);
        setHead(spans[index]?.startSec ?? 0);
        setPlayPaused(false);
        setPlayAll(true);
    };

    const stopPlayAll = () => {
        setPlayAll(false);
        setPlayPaused(false);
    };

    /**
     * 一段演完 → 下一段接着走；已经是最后一段就停在尾帧（不自动循环）。
     * 刻意**不 pause 旧元素**：换 key 会直接卸载它，多一次 pause 只是白白多一帧重排。
     */
    const advancePlay = () => {
        if (gotoPlayClip(playIndexSafe + 1)) return;
        playStageRef.current?.pause();
        setPlayPaused(true);
        setHead(playTotalSec);
    };

    const togglePlayback = () => {
        const video = playStageRef.current;
        if (playPaused) {
            // 已经播到整条尾巴了：再按播放就是「重看一遍」，不是傻站在最后 0.1 秒。
            if (playheadRef.current >= playTotalSec - 0.05) {
                startPlayAll();
                return;
            }
            setPlayPaused(false);
            if (video) void video.play().catch(() => undefined);
            return;
        }
        setPlayPaused(true);
        video?.pause();
    };

    /** 点 / 拖整条进度条：换算成「第几段 + 段内偏移」，视频就地 seek，图片靠重挂接上。 */
    const seekMerged = (sec: number) => {
        const located = locateMergePosition(spans, playTotalSec, sec);
        const target = clips[located.index];
        if (!target) return;
        if (!target.url || target.missing) {
            // 落在占位段上：跳到它后面第一段能播的起点，别让播放头卡死在灰段里。
            const next = nextPlayableMergeIndex(clips, located.index);
            if (next < 0) return;
            pendingSeekRef.current = { nodeId: clips[next].clip.nodeId, atSec: clips[next].clip.inSec };
            setPlayIndex(next);
            setSelectedIndex(next);
            setHead(spans[next]?.startSec ?? 0);
            return;
        }
        setHead((spans[located.index]?.startSec ?? 0) + located.offsetSec);
        const mediaSec = Math.max(0, target.clip.inSec + located.offsetSec);
        if (located.index === playIndexSafe && playStageRef.current) {
            try {
                playStageRef.current.currentTime = Math.min(mediaSec, Math.max(0, target.clip.outSec));
            } catch {
                // 元数据还没好时会抛，忽略：下一帧 timeupdate 会把播放头再对一次。
            }
            return;
        }
        pendingSeekRef.current = { nodeId: target.clip.nodeId, atSec: mediaSec };
        setPlayIndex(located.index);
        setSelectedIndex(located.index);
    };

    /**
     * 时长探测：「这一段跟随源片」就测一次真实时长（用户 2026-11-14：
     * 「视频合并的每段的时间以拾取视频的实际时长为准，即拾取的视频为几秒那么视频合并的段落时长就是几秒」）。
     *
     * key 带上 `storageKey` / url 尾巴：**源视频重新生成后必须重测**，只按 nodeId 拼 key 会一直停在旧值。
     * 回填写回 `durationSec + inSec:0 + outSec`：铺链路建的段一开始是「请求秒数」占位（比如 5s），
     * 真实片子 10s 的话这里会把它拉齐 —— 这正是用户要的口径。
     * `changed` 守卫很关键：写回后会触发一轮重渲染（`rawClips` 引用变了），没有它就会「探测 → 写 → 再探测」转圈。
     */
    const probeTargets = clips.filter((item) => item.clip.kind === "video" && item.url && mergeClipFollowsSource(item.clip));
    const probeKey = probeTargets.map((item) => `${item.clip.nodeId}:${item.storageKey || item.url.slice(-24)}`).join("|");

    useEffect(() => {
        if (!probeKey) return;
        let cancelled = false;
        void Promise.all(probeTargets.map(async (item) => ({ nodeId: item.clip.nodeId, seconds: await probeMediaDuration(item.url) }))).then((results) => {
            if (cancelled) return;
            const known = results.filter((item) => item.seconds > 0);
            if (!known.length) return;
            let changed = false;
            const next = rawClips.map((clip) => {
                const hit = known.find((item) => item.nodeId === clip.nodeId);
                if (!hit) return clip;
                const synced = applyMergeClipSourceDuration(clip, hit.seconds);
                if (synced === clip) return clip;
                const sameDuration = Math.abs((Number(synced.durationSec) || 0) - (Number(clip.durationSec) || 0)) < 0.02;
                const sameRange = Math.abs(synced.outSec - clip.outSec) < 0.02 && synced.inSec === clip.inSec;
                if (sameDuration && sameRange && synced.autoDuration === clip.autoDuration) return clip;
                changed = true;
                return synced;
            });
            if (!changed) return;
            onConfigChange(node.id, { videoMergeClips: next });
        });
        return () => {
            cancelled = true;
        };
        // `probeTargets` 每次渲染都是新数组，进依赖会让 effect 每帧空跑；key 已经包含全部身份信息。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [probeKey, rawClips, node.id, onConfigChange]);

    // 换选中片段时把预览挪到它的入点，避免每次都要手动拖。（整条播放时由视频元素自己接管定位）
    useEffect(() => {
        if (playAll) return;
        const video = videoRef.current;
        if (!video || !selected || selected.clip.kind !== "video") return;
        const target = Math.max(0, selected.clip.inSec);
        if (Math.abs(video.currentTime - target) < 0.05) return;
        try {
            video.currentTime = target;
        } catch {
            // 元数据还没加载完，浏览器会自己忽略 —— 下一次点选会再对一次。
        }
    }, [safeIndex, selected, playAll]);

    // 整条播放里的图片段没有 ended 事件：按「段内剩余停留时长」走，顺便把播放头匀速推出去。
    useEffect(() => {
        if (!playAll || playPaused || !playClip || playClip.clip.kind !== "image" || !playSpan) return;
        const span = playSpan;
        const fromSec = Math.min(Math.max(span.startSec, playheadRef.current), span.startSec + span.lengthSec);
        const startedAt = performance.now();
        const timer = window.setInterval(() => {
            const current = Math.min(span.startSec + span.lengthSec, fromSec + (performance.now() - startedAt) / 1000);
            playheadRef.current = current;
            setPlayheadSec(current);
            if (current >= span.startSec + span.lengthSec - 0.001) advancePlay();
        }, 80);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playAll, playPaused, playIndexSafe, playSpan?.startSec, playSpan?.lengthSec, playClip?.clip.kind, playClip?.clip.nodeId]);

    const patch = (next: Partial<CanvasNodeMetadata>) => onConfigChange(node.id, next);

    const commitClips = (next: CanvasVideoMergeClip[]) => {
        patch({ videoMergeClips: next.map(normalizeMergeClip) });
    };

    const updateSelected = (updater: (clip: CanvasVideoMergeClip) => CanvasVideoMergeClip) => {
        if (!selected) return;
        const next = rawClips.map((clip, index) => (index === safeIndex ? updater(clip) : clip));
        commitClips(next);
    };

    /**
     * 时间线条上某一段右上角的叉号：移出这一段 + 顺手断掉它那根线。
     *
     * 以前只能「去画布上把连线删掉」才算移出，可时间线块很小、线又常常压在别的线下面，
     * 用户实际上找不到删除入口。两条路必须都走通，而且**永远是同一件事**
     * （时间线 = 连线，见上：只删段不断线会留下「线还在、段没了」的幽灵态）。
     */
    const removeClipAt = (index: number) => {
        const target = clips[index];
        if (!target) return;
        const next = removeMergeClip(rawClips, index);
        commitClips(next);
        onDetachClips?.(node.id, [target.clip.nodeId]);
        setSelectedIndex(Math.max(0, Math.min(index, next.length - 1)));
    };

    /** 头部垃圾桶 = 删当前选中那一段：走同一条移除路径，别养出第二套写法。 */
    const removeSelected = () => removeClipAt(safeIndex);

    /** 清空时间线 = 把这节点进来的线全断掉，否则线还在、段没了，谁也说不清哪个才算数。 */
    const clearClips = () => {
        const ids = rawClips.map((clip) => clip.nodeId);
        commitClips([]);
        if (ids.length) onDetachClips?.(node.id, ids);
    };

    const resolveBlockIndexAt = (clientX: number) => {
        const strip = stripRef.current;
        if (!strip) return null;
        const blocks = Array.from(strip.querySelectorAll<HTMLElement>("[data-video-merge-block]"));
        if (!blocks.length) return null;
        for (let index = 0; index < blocks.length; index += 1) {
            const rect = blocks[index].getBoundingClientRect();
            if (clientX < rect.left + rect.width / 2) return index;
        }
        return blocks.length - 1;
    };

    /**
     * 时间线块的拖动换位。
     *
     * 刻意**不用 HTML5 drag**：块长在 `transform: scale()` 的缩放容器里，原生 drag 极易被浏览器
     * 中途取消（拖影一闪、光标回弹），之后整排都不再响应。这里用 pointer 事件 + 窗口捕获，
     * 4px 阈值判「真的在拖」，落点按每个块的中线算。
     */
    const handleBlockPointerDown = (event: React.PointerEvent<HTMLDivElement>, index: number) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(index);
        if (playAll) {
            // 整条播放时点某一块 = 从这一段入点重新接上，别让播放头留在上一段。
            pendingSeekRef.current = null;
            setPlayIndex(index);
            setHead(spans[index]?.startSec ?? 0);
            setPlayPaused(false);
        }
        dragStateRef.current = { from: index, startX: event.clientX, startY: event.clientY, active: false };
        const handleMove = (moveEvent: PointerEvent) => {
            const state = dragStateRef.current;
            if (!state) return;
            if (!state.active) {
                if (Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY) < 4) return;
                state.active = true;
                setDragging(true);
                setDragFrom(state.from);
            }
            const over = resolveBlockIndexAt(moveEvent.clientX);
            dragOverRef.current = over;
            setDragOver(over);
        };
        const finish = () => {
            window.removeEventListener("pointermove", handleMove, true);
            window.removeEventListener("pointerup", finish, true);
            window.removeEventListener("pointercancel", finish, true);
            const state = dragStateRef.current;
            const over = dragOverRef.current;
            dragStateRef.current = null;
            dragOverRef.current = null;
            setDragging(false);
            setDragFrom(null);
            setDragOver(null);
            if (!state?.active || over === null || over === state.from) return;
            commitClips(moveMergeClip(rawClips, state.from, over));
            setSelectedIndex(over);
        };
        window.addEventListener("pointermove", handleMove, true);
        window.addEventListener("pointerup", finish, true);
        window.addEventListener("pointercancel", finish, true);
    };

    const canvasSize = resolveMergeCanvasSize(node.metadata?.videoMergeAspect, clips.map((item) => ({ width: item.width, height: item.height })));
    const canExport = clips.some((item) => !item.missing);

    return (
        <div className="flex h-full w-full cursor-move flex-col gap-2 px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} data-canvas-no-zoom onWheel={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 font-semibold">
                    <Combine className="size-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{t("canvas.nodeTypes.videoMerge")}</span>
                </div>
                <span className="shrink-0 text-[11px] opacity-50">
                    {t("canvas.videoMerge.summary", { count: clips.length, duration: formatMergeClock(totalSeconds) })}
                </span>
            </div>

            <div className="flex min-h-0 flex-1 cursor-default flex-col gap-2" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-between gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[11px] opacity-55" title={t("canvas.videoMerge.pickViaConnect")}>
                        {t("canvas.videoMerge.pickViaConnect")}
                    </span>
                    <Tooltip title={t("canvas.videoMerge.clear")}>
                        <Button size="small" icon={<X className="size-3.5" />} disabled={!clips.length} onClick={clearClips} />
                    </Tooltip>
                </div>

                {clips.length ? (
                    <>
                        <div ref={stripRef} className="relative flex h-14 items-stretch gap-0.5 overflow-hidden rounded-lg border p-1" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                            {clips.map((item, index) => {
                                const length = Math.max(MIN_MERGE_CLIP_SEC, item.clip.outSec - item.clip.inSec);
                                const isActive = index === safeIndex;
                                const showDropMarker = dragging && dragOver === index && dragFrom !== index;
                                return (
                                    <div
                                        key={`${item.clip.nodeId}-${index}`}
                                        data-video-merge-block
                                        onPointerDown={(event) => handleBlockPointerDown(event, index)}
                                        className={`group relative min-w-0 flex-1 cursor-grab overflow-hidden rounded-md border px-1 py-0.5 text-[10px] leading-tight transition ${dragging && dragFrom === index ? "opacity-40" : ""}`}
                                        style={{
                                            flexGrow: Math.max(0.6, length),
                                            flexBasis: 0,
                                            borderColor: isActive ? "#0ea5e9" : theme.node.stroke,
                                            borderWidth: isActive ? 1.5 : 0.5,
                                            background: isActive ? "rgba(14,165,233,0.10)" : "transparent",
                                        }}
                                        title={`${index + 1}. ${item.clip.title} · ${formatMergeClock(length)}`}
                                    >
                                        {showDropMarker ? <span className="absolute inset-y-0 -left-px w-0.5 rounded" style={{ background: "#0ea5e9" }} /> : null}
                                        <span className="block truncate font-semibold opacity-80">{index + 1}</span>
                                        <span className="block truncate opacity-55">{formatMergeClock(length)}</span>
                                        {/* 失效标记挪到右下角：右上角让给删除叉号（两者叠在一起会误点） */}
                                        {item.missing ? <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-red-500" /> : null}
                                        {/* 单条删除：每段自带叉号，不必再去画布上找那根线 */}
                                        <button
                                            type="button"
                                            data-video-merge-remove={index}
                                            title={t("canvas.videoMerge.removeClip")}
                                            aria-label={t("canvas.videoMerge.removeClip")}
                                            /* 只 stopPropagation、**不 preventDefault**：pointerdown 一旦 preventDefault，
                                               浏览器就不再补发兼容鼠标事件，onClick 永远不来（参考图 chip 双击踩过同一个坑）。 */
                                            onPointerDown={(event) => event.stopPropagation()}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                removeClipAt(index);
                                            }}
                                            className={`absolute right-0 top-0 z-10 flex size-3.5 cursor-pointer items-center justify-center rounded-bl bg-black/60 text-white transition-opacity hover:bg-red-500 ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                        >
                                            <X className="size-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        {selected ? (
                            <div className="flex min-h-0 flex-1 flex-col gap-1.5 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="truncate text-[11px] font-medium">
                                        {playAll ? `${t("canvas.videoMerge.playAll")} · ${formatMergeClock(playTotalSec)}` : `${safeIndex + 1}. ${selected.clip.title}`}
                                    </span>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {/* 用双选而不是单按钮：单按钮上写「单条显示」时，用户会以为当前就是单条模式 */}
                                        <Segmented
                                            size="small"
                                            value={playAll ? "all" : "single"}
                                            options={[
                                                { value: "single", label: t("canvas.videoMerge.playSingle") },
                                                { value: "all", label: t("canvas.videoMerge.playAll") },
                                            ]}
                                            onChange={(value) => {
                                                if (String(value) === "all") startPlayAll();
                                                else stopPlayAll();
                                            }}
                                        />
                                        <Tooltip title={t("canvas.videoMerge.remove")}>
                                            <button type="button" className="rounded p-1 opacity-60 hover:bg-red-500/10 hover:text-red-500" onClick={removeSelected}>
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>

                                <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black/25">
                                    {playAll ? (
                                        playClip?.url ? (
                                            playClip.clip.kind === "video" ? (
                                                <video
                                                    /* 换段就换 key：旧的立刻卸载停声，新的从「段内偏移」接着演 */
                                                    key={`play-all-${playIndexSafe}-${playClip.clip.nodeId}`}
                                                    ref={playStageRef}
                                                    src={playClip.url}
                                                    className="h-full w-full object-contain"
                                                    playsInline
                                                    preload="auto"
                                                    /* 整条模式**不挂原生 controls**：它显示的是「这一段」的进度和时长，
                                                       正是让人以为还在单条播放的根源。进度交给下面那条贯通条。 */
                                                    onLoadedMetadata={(event) => {
                                                        const video = event.currentTarget;
                                                        const pending = pendingSeekRef.current;
                                                        const seekTo = pending && pending.nodeId === playClip.clip.nodeId ? pending.atSec : playClip.clip.inSec;
                                                        pendingSeekRef.current = null;
                                                        try {
                                                            video.currentTime = Math.max(0, seekTo);
                                                        } catch {
                                                            // 容器不支持 seek 就算了，从 0 开始也能看个大概。
                                                        }
                                                        if (!playPaused) void video.play().catch(() => undefined);
                                                    }}
                                                    onTimeUpdate={(event) => {
                                                        const video = event.currentTarget;
                                                        // 出点判定必须用 media 时间；播放头则用「段起点 + 段内已过」的累计时间。
                                                        setHead((playSpan?.startSec ?? 0) + Math.max(0, video.currentTime - playClip.clip.inSec));
                                                        if (video.currentTime < Math.max(0, playClip.clip.outSec) - 0.04) return;
                                                        advancePlay();
                                                    }}
                                                    onEnded={() => advancePlay()}
                                                />
                                            ) : (
                                                <img src={playClip.url} alt={playClip.clip.title} className="h-full w-full object-contain" />
                                            )
                                        ) : (
                                            <div className="flex h-full w-full items-center justify-center gap-1 text-[11px] opacity-50">
                                                <Film className="size-4" />
                                                {t("canvas.videoMerge.missingSource")}
                                            </div>
                                        )
                                    ) : selected.clip.kind === "video" && selected.url ? (
                                        <video ref={videoRef} key={`${selected.clip.nodeId}-preview`} src={selected.url} className="h-full w-full object-contain" controls playsInline preload="metadata" />
                                    ) : selected.url ? (
                                        <img src={selected.url} alt={selected.clip.title} className="h-full w-full object-contain" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center gap-1 text-[11px] opacity-50">
                                            <Film className="size-4" />
                                            {t("canvas.videoMerge.missingSource")}
                                        </div>
                                    )}
                                </div>

                                {playAll ? (
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                type="button"
                                                className="flex size-5 shrink-0 items-center justify-center rounded opacity-75 hover:opacity-100"
                                                title={playPaused ? t("canvas.videoMerge.play") : t("canvas.videoMerge.pause")}
                                                onClick={togglePlayback}
                                                onPointerDown={(event) => event.stopPropagation()}
                                            >
                                                {playPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                                            </button>
                                            <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-70">
                                                {formatMergeClock(playheadSec)} / {formatMergeClock(playTotalSec)}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-right text-[10px] opacity-45">{t("canvas.videoMerge.playAllHint")}</span>
                                        </div>
                                        {/* 贯通进度条：整条 = 一条，段与段只在这里按真实长度首尾相接 */}
                                        <div
                                            data-video-merge-playhead-bar
                                            className="relative h-4 w-full cursor-pointer select-none"
                                            onPointerDown={(event) => {
                                                if (event.button !== 0) return;
                                                event.preventDefault();
                                                event.stopPropagation();
                                                const bar = event.currentTarget;
                                                const seekFromX = (clientX: number) => {
                                                    const rect = bar.getBoundingClientRect();
                                                    if (rect.width <= 0 || playTotalSec <= 0) return;
                                                    seekMerged(((clientX - rect.left) / rect.width) * playTotalSec);
                                                };
                                                seekFromX(event.clientX);
                                                const handleMove = (moveEvent: PointerEvent) => seekFromX(moveEvent.clientX);
                                                const finish = () => {
                                                    window.removeEventListener("pointermove", handleMove, true);
                                                    window.removeEventListener("pointerup", finish, true);
                                                    window.removeEventListener("pointercancel", finish, true);
                                                };
                                                window.addEventListener("pointermove", handleMove, true);
                                                window.addEventListener("pointerup", finish, true);
                                                window.addEventListener("pointercancel", finish, true);
                                            }}
                                        >
                                            <div className="absolute inset-x-0 top-1/2 flex h-1.5 -translate-y-1/2 overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                                                {spans.map((span) => (
                                                    <span
                                                        key={`span-${span.index}`}
                                                        className="h-full border-r border-black/20 last:border-r-0"
                                                        style={{
                                                            flexGrow: span.lengthSec,
                                                            flexBasis: 0,
                                                            background: span.index === playIndexSafe ? "#0ea5e9" : "rgba(127,127,127,0.45)",
                                                        }}
                                                    />
                                                ))}
                                            </div>
                                            <span
                                                className="pointer-events-none absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-1 ring-black/40"
                                                style={{ left: `${playTotalSec > 0 ? Math.min(100, Math.max(0, (playheadSec / playTotalSec) * 100)) : 0}%` }}
                                            />
                                        </div>
                                    </div>
                                ) : selected.clip.kind === "video" ? (
                                    <div className="flex flex-wrap items-center gap-1 text-[11px]">
                                        {/* 手动改入 / 出点一律打 `autoDuration: false`（用户 2026-11-14：段长默认跟随源片，
                                            但用户裁过的不能被下一次探测回写拉回整段）。「整段」按钮反过来恢复跟随。 */}
                                        <TimeField
                                            label={t("canvas.videoMerge.inPoint")}
                                            value={selected.clip.inSec}
                                            onCommit={(value) => updateSelected((clip) => markMergeClipTrimmed({ ...clip, inSec: value }))}
                                        />
                                        <TimeField
                                            label={t("canvas.videoMerge.outPoint")}
                                            value={selected.clip.outSec}
                                            onCommit={(value) => updateSelected((clip) => markMergeClipTrimmed({ ...clip, outSec: value }))}
                                        />
                                        <Button size="small" icon={<Scissors className="size-3" />} onClick={() => {
                                            const current = videoRef.current?.currentTime;
                                            if (typeof current !== "number" || !Number.isFinite(current)) return;
                                            updateSelected((clip) => markMergeClipTrimmed({ ...clip, inSec: roundSeconds(Math.min(current, clip.outSec - MIN_MERGE_CLIP_SEC)) }));
                                        }}>
                                            {t("canvas.videoMerge.setIn")}
                                        </Button>
                                        <Button size="small" onClick={() => {
                                            const current = videoRef.current?.currentTime;
                                            if (typeof current !== "number" || !Number.isFinite(current)) return;
                                            updateSelected((clip) => markMergeClipTrimmed({ ...clip, outSec: roundSeconds(Math.max(current, clip.inSec + MIN_MERGE_CLIP_SEC)) }));
                                        }}>
                                            {t("canvas.videoMerge.setOut")}
                                        </Button>
                                        <Button size="small" type="text" onClick={() => updateSelected((clip) => resetMergeClipToFull(clip))}>
                                            {t("canvas.videoMerge.fullClip")}
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-1 text-[11px]">
                                        <TimeField label={t("canvas.videoMerge.hold")} value={selected.clip.outSec} onCommit={(value) => updateSelected((clip) => ({ ...clip, inSec: 0, outSec: value }))} />
                                        {[2, 3, 5].map((seconds) => (
                                            <Button key={seconds} size="small" type="text" onClick={() => updateSelected((clip) => ({ ...clip, inSec: 0, outSec: seconds }))}>
                                                {seconds}s
                                            </Button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border px-4 text-center text-[11px] opacity-55" style={{ borderColor: theme.node.stroke }}>
                        <ImagePlus className="size-6 opacity-60" />
                        <span>{t("canvas.videoMerge.empty")}</span>
                    </div>
                )}

                <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[11px] opacity-50">{t("canvas.videoMerge.canvas")}</span>
                    <Segmented
                        size="small"
                        block
                        value={String(node.metadata?.videoMergeAspect || "original")}
                        options={VIDEO_MERGE_ASPECTS.map((value) => ({ value, label: value === "original" ? t("canvas.videoMerge.original") : value }))}
                        onChange={(value) => patch({ videoMergeAspect: String(value) === "original" ? null : String(value) })}
                    />
                    <span className="shrink-0 text-[10px] opacity-40">
                        {canvasSize.width}×{canvasSize.height}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <Button
                        type="primary"
                        block
                        className="flex-1"
                        disabled={!canExport || isRendering || isExporting}
                        icon={isRendering ? <LoaderCircle className="size-3.5 animate-spin" /> : <Combine className="size-3.5" />}
                        onClick={() => onRender(node.id)}
                    >
                        {isRendering ? `${t("canvas.videoMerge.rendering")} ${Math.round(Math.min(1, Math.max(0, renderProgress)) * 100)}%` : t("canvas.videoMerge.render")}
                    </Button>
                    <Button
                        block
                        className="flex-1"
                        disabled={!canExport || isExporting || isRendering}
                        icon={isExporting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                        onClick={() => onExport(node.id)}
                    >
                        {isExporting ? t("canvas.videoMerge.exporting") : t("canvas.videoMerge.export")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
    const [draft, setDraft] = useState(String(roundSeconds(value)));
    useEffect(() => {
        setDraft(String(roundSeconds(value)));
    }, [value]);
    const commit = () => {
        const parsed = Number(draft);
        if (!Number.isFinite(parsed)) {
            setDraft(String(roundSeconds(value)));
            return;
        }
        onCommit(parsed);
    };
    return (
        <label className="flex items-center gap-1">
            <span className="shrink-0 opacity-55">{label}</span>
            <input
                type="number"
                step={0.1}
                min={0}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onPointerDown={(event) => event.stopPropagation()}
                className="w-14 rounded border bg-transparent px-1 py-0.5 text-[11px]"
                style={{ borderColor: "rgba(127,127,127,0.35)" }}
            />
        </label>
    );
}
