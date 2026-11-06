import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Segmented, Tooltip } from "antd";
import { Combine, Crosshair, Download, Film, ImagePlus, LoaderCircle, Scissors, Trash2, X } from "lucide-react";
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
    isPicking: boolean;
    isExporting: boolean;
    onTogglePicking: (nodeId: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onExport: (nodeId: string) => void;
};

export function CanvasVideoMergeNodeContent({ node, clips, isPicking, isExporting, onTogglePicking, onConfigChange, onExport }: CanvasVideoMergeNodeContentProps) {
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

    const rawClips = node.metadata?.videoMergeClips || [];
    const totalSeconds = useMemo(() => totalMergeLengthSec(rawClips), [rawClips]);
    const safeIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, clips.length - 1));
    const selected = clips[safeIndex];

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

    // 换选中片段时把预览挪到它的入点，避免每次都要手动拖。
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !selected || selected.clip.kind !== "video") return;
        const target = Math.max(0, selected.clip.inSec);
        if (Math.abs(video.currentTime - target) < 0.05) return;
        try {
            video.currentTime = target;
        } catch {
            // 元数据还没加载完，浏览器会自己忽略 —— 下一次点选会再对一次。
        }
    }, [safeIndex, selected]);

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
        setSelectedIndex(Math.max(0, Math.min(safeIndex, next.length - 1)));
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
                <div className="flex items-center gap-1.5">
                    <Button size="small" type={isPicking ? "primary" : "default"} icon={<Crosshair className="size-3.5" />} onClick={() => onTogglePicking(node.id)} className="flex-1">
                        {isPicking ? t("canvas.videoMerge.pickingOn") : t("canvas.videoMerge.pickingOff")}
                    </Button>
                    <Tooltip title={t("canvas.videoMerge.clear")}>
                        <Button size="small" icon={<X className="size-3.5" />} disabled={!clips.length} onClick={() => commitClips([])} />
                    </Tooltip>
                </div>

                {isPicking ? <div className="rounded-md px-2 py-1 text-[11px] leading-4 opacity-70" style={{ background: theme.node.fill }}>{t("canvas.videoMerge.pickingHint")}</div> : null}

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
                                        {safeIndex + 1}. {selected.clip.title}
                                    </span>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <Tooltip title={t("canvas.videoMerge.remove")}>
                                            <button type="button" className="rounded p-1 opacity-60 hover:bg-red-500/10 hover:text-red-500" onClick={removeSelected}>
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>

                                <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-black/25">
                                    {selected.clip.kind === "video" && selected.url ? (
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

                                {selected.clip.kind === "video" ? (
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

                <Button
                    type="primary"
                    block
                    disabled={!canExport || isExporting}
                    icon={isExporting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                    onClick={() => onExport(node.id)}
                >
                    {isExporting ? t("canvas.videoMerge.exporting") : t("canvas.videoMerge.export")}
                </Button>
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
