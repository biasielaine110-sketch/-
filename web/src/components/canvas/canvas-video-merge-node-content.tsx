import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Segmented, Tooltip } from "antd";
import { Combine, Download, Film, ImagePlus, ListVideo, LoaderCircle, Scissors, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import {
    formatMergeClock,
    MIN_MERGE_CLIP_SEC,
    moveMergeClip,
    normalizeMergeClip,
    probeMediaDuration,
    removeMergeClip,
    resolveMergeCanvasSize,
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
     * 「整条显示」：按时间线顺序把每段的首尾接起来演一遍，用来确认拼接效果。
     * 关掉就回到单条预览（原来的行为）。
     */
    const [playAll, setPlayAll] = useState(false);
    const [playIndex, setPlayIndex] = useState(0);

    const rawClips = node.metadata?.videoMergeClips || [];
    const totalSeconds = useMemo(() => totalMergeLengthSec(rawClips), [rawClips]);
    const safeIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, clips.length - 1));
    const selected = clips[safeIndex];

    // ── 整条显示 ────────────────────────────────────────────────────────────────
    // 只跳「能播」的段：源被删掉的段在时间线上留着占位，但它没法演。
    const playIndexSafe = Math.min(Math.max(0, playIndex), Math.max(0, clips.length - 1));
    const playClip = clips[playIndexSafe];
    const playLengthSec = playClip ? Math.max(MIN_MERGE_CLIP_SEC, playClip.clip.outSec - playClip.clip.inSec) : 0;

    const gotoPlayClip = (index: number) => {
        let next = index;
        while (next < clips.length && (!clips[next].url || clips[next].missing)) next += 1;
        if (next >= clips.length) return false;
        setPlayIndex(next);
        return true;
    };

    const togglePlayAll = () => {
        if (playAll) {
            setPlayAll(false);
            return;
        }
        // 从头开始演整条 —— 用户点这个就是要看「拼起来长什么样」。
        const first = clips.findIndex((item) => Boolean(item.url) && !item.missing);
        setPlayIndex(Math.max(0, first));
        setPlayAll(true);
    };

    /** 一段演完 → 下一段；已经是最后一段就停在尾帧，不自动循环。 */
    const advancePlay = (element?: HTMLVideoElement | null) => {
        element?.pause();
        if (!gotoPlayClip(playIndexSafe + 1) && element) {
            try {
                element.currentTime = Math.max(0, playClip?.clip.outSec || 0);
            } catch {
                // 有些容器 seek 到片尾会抛，忽略即可。
            }
        }
    };

    // 时长探测只做一轮：`durationSec` 一旦回填，key 就不再命中，不会循环。
    const probeKey = clips
        .filter((item) => item.clip.kind === "video" && !item.clip.durationSec && item.url)
        .map((item) => item.clip.nodeId)
        .join("|");

    useEffect(() => {
        if (!probeKey) return;
        const targets = clips.filter((item) => item.clip.kind === "video" && !item.clip.durationSec && item.url);
        let cancelled = false;
        void Promise.all(targets.map(async (item) => ({ nodeId: item.clip.nodeId, seconds: await probeMediaDuration(item.url) }))).then((results) => {
            if (cancelled) return;
            const known = results.filter((item) => item.seconds > 0);
            if (!known.length) return;
            const next = rawClips.map((clip) => {
                const hit = known.find((item) => item.nodeId === clip.nodeId);
                if (!hit) return clip;
                return normalizeMergeClip({ ...clip, durationSec: roundSeconds(hit.seconds), outSec: clip.outSec <= 1 ? roundSeconds(hit.seconds) : clip.outSec });
            });
            onConfigChange(node.id, { videoMergeClips: next });
        });
        return () => {
            cancelled = true;
        };
    }, [probeKey, clips, rawClips, node.id, onConfigChange]);

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

    // 整条播放里的图片段没有 ended 事件，用定时器按「停留时长」推进。
    useEffect(() => {
        if (!playAll || !playClip || playClip.clip.kind !== "image") return;
        const timer = window.setTimeout(() => advancePlay(), Math.max(0.1, playLengthSec) * 1000);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playAll, playIndexSafe, playLengthSec, playClip?.clip.kind]);

    const patch = (next: Partial<CanvasNodeMetadata>) => onConfigChange(node.id, next);

    const commitClips = (next: CanvasVideoMergeClip[]) => {
        patch({ videoMergeClips: next.map(normalizeMergeClip) });
    };

    const updateSelected = (updater: (clip: CanvasVideoMergeClip) => CanvasVideoMergeClip) => {
        if (!selected) return;
        const next = rawClips.map((clip, index) => (index === safeIndex ? updater(clip) : clip));
        commitClips(next);
    };

    const removeSelected = () => {
        if (!selected) return;
        const next = removeMergeClip(rawClips, safeIndex);
        commitClips(next);
        onDetachClips?.(node.id, [selected.clip.nodeId]);
        setSelectedIndex(Math.max(0, Math.min(safeIndex, next.length - 1)));
    };

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
                                        className={`relative min-w-0 flex-1 cursor-grab overflow-hidden rounded-md border px-1 py-0.5 text-[10px] leading-tight transition ${dragging && dragFrom === index ? "opacity-40" : ""}`}
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
                                        {item.missing ? <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-red-500" /> : null}
                                    </div>
                                );
                            })}
                        </div>

                        {selected ? (
                            <div className="flex min-h-0 flex-1 flex-col gap-1.5 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="truncate text-[11px] font-medium">
                                        {playAll ? t("canvas.videoMerge.playAllSegment", { index: playIndexSafe + 1, count: clips.length }) : `${safeIndex + 1}. ${selected.clip.title}`}
                                    </span>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <Tooltip title={playAll ? t("canvas.videoMerge.playSingle") : t("canvas.videoMerge.playAll")}>
                                            <Button
                                                size="small"
                                                type={playAll ? "primary" : "text"}
                                                icon={<ListVideo className="size-3.5" />}
                                                className="!h-6 !px-1.5 !text-[10px]"
                                                onClick={togglePlayAll}
                                            >
                                                {playAll ? t("canvas.videoMerge.playSingle") : t("canvas.videoMerge.playAll")}
                                            </Button>
                                        </Tooltip>
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
                                                    /* 换段就换 key：旧的立刻卸载停声，新的自己从入点开始 */
                                                    key={`play-all-${playIndexSafe}-${playClip.clip.nodeId}`}
                                                    src={playClip.url}
                                                    className="h-full w-full object-contain"
                                                    controls
                                                    playsInline
                                                    preload="auto"
                                                    onLoadedMetadata={(event) => {
                                                        const video = event.currentTarget;
                                                        try {
                                                            video.currentTime = Math.max(0, playClip.clip.inSec);
                                                        } catch {
                                                            // 容器不支持 seek 就算了，从头播也能看个大概。
                                                        }
                                                        void video.play().catch(() => undefined);
                                                    }}
                                                    onTimeUpdate={(event) => {
                                                        const video = event.currentTarget;
                                                        // 出点判定要用 media 时间，不是时间线时间。
                                                        if (video.currentTime < Math.max(0, playClip.clip.outSec) - 0.03) return;
                                                        advancePlay(video);
                                                    }}
                                                    onEnded={(event) => advancePlay(event.currentTarget)}
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
                                    <div className="text-[11px] leading-4 opacity-55">{t("canvas.videoMerge.playAllHint")}</div>
                                ) : selected.clip.kind === "video" ? (
                                    <div className="flex flex-wrap items-center gap-1 text-[11px]">
                                        <TimeField
                                            label={t("canvas.videoMerge.inPoint")}
                                            value={selected.clip.inSec}
                                            onCommit={(value) => updateSelected((clip) => ({ ...clip, inSec: value }))}
                                        />
                                        <TimeField
                                            label={t("canvas.videoMerge.outPoint")}
                                            value={selected.clip.outSec}
                                            onCommit={(value) => updateSelected((clip) => ({ ...clip, outSec: value }))}
                                        />
                                        <Button size="small" icon={<Scissors className="size-3" />} onClick={() => {
                                            const current = videoRef.current?.currentTime;
                                            if (typeof current !== "number" || !Number.isFinite(current)) return;
                                            updateSelected((clip) => ({ ...clip, inSec: roundSeconds(Math.min(current, clip.outSec - MIN_MERGE_CLIP_SEC)) }));
                                        }}>
                                            {t("canvas.videoMerge.setIn")}
                                        </Button>
                                        <Button size="small" onClick={() => {
                                            const current = videoRef.current?.currentTime;
                                            if (typeof current !== "number" || !Number.isFinite(current)) return;
                                            updateSelected((clip) => ({ ...clip, outSec: roundSeconds(Math.max(current, clip.inSec + MIN_MERGE_CLIP_SEC)) }));
                                        }}>
                                            {t("canvas.videoMerge.setOut")}
                                        </Button>
                                        <Button size="small" type="text" onClick={() => updateSelected((clip) => ({ ...clip, inSec: 0, outSec: clip.durationSec || clip.outSec }))}>
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
