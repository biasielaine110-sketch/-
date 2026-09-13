import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Segmented } from "antd";
import { Columns2, Grid2x2, ImagePlus, LoaderCircle, Rows2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { resolveMergeLayout, type MergeOrientation } from "@/components/canvas/canvas-node-merge-dialog";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasMergeNodeContentProps = {
    node: CanvasNodeData;
    inputs: NodeGenerationInput[];
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onMerge: (nodeId: string) => void;
};

export function CanvasMergeNodeContent({ node, inputs, isRunning, onConfigChange, onMerge }: CanvasMergeNodeContentProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panRef = useRef<{
        nodeId: string;
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
        cellWidth: number;
        cellHeight: number;
    } | null>(null);

    const imageInputs = useMemo(() => inputs.filter((input) => input.type === "image" && input.image?.dataUrl), [inputs]);
    const inputById = useMemo(() => new Map(imageInputs.map((input) => [input.nodeId, input])), [imageInputs]);
    const orientation = (node.metadata?.mergeOrientation || "grid") as MergeOrientation;
    const rows = Math.max(1, node.metadata?.mergeRows || 2);
    const columns = Math.max(1, node.metadata?.mergeColumns || 2);
    const capacity = rows * columns;
    const offsets = node.metadata?.mergeOffsets || {};

    const slots = useMemo(() => {
        const preferred = (node.metadata?.mergeSlotIds || []).slice(0, capacity);
        const used = new Set<string>();
        const next: Array<string | null> = Array.from({ length: capacity }, (_, index) => {
            const id = preferred[index] || null;
            if (id && inputById.has(id) && !used.has(id)) {
                used.add(id);
                return id;
            }
            return null;
        });
        for (const input of imageInputs) {
            if (used.has(input.nodeId)) continue;
            const empty = next.findIndex((item) => !item);
            if (empty < 0) break;
            next[empty] = input.nodeId;
            used.add(input.nodeId);
        }
        return next;
    }, [capacity, imageInputs, inputById, node.metadata?.mergeSlotIds]);

    const filledCount = slots.filter(Boolean).length;
    const canMerge = filledCount >= 2 && !isRunning;

    const patch = (next: Partial<CanvasNodeMetadata>) => onConfigChange(node.id, next);

    const applyOrientation = (next: MergeOrientation) => {
        const layout = resolveMergeLayout(Math.max(filledCount || imageInputs.length || 4, 2), next);
        const remapped = remapSlotIds(slots, layout.rows * layout.columns);
        patch({ mergeOrientation: next, mergeRows: layout.rows, mergeColumns: layout.columns, mergeSlotIds: remapped });
    };

    const setLayoutSize = (nextRows: number, nextColumns: number) => {
        const safeRows = clamp(nextRows, 1, 12);
        const safeColumns = clamp(nextColumns, 1, 12);
        patch({ mergeOrientation: "grid", mergeRows: safeRows, mergeColumns: safeColumns, mergeSlotIds: remapSlotIds(slots, safeRows * safeColumns) });
    };

    const beginPan = (event: ReactPointerEvent<HTMLDivElement>, sourceId: string) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const current = offsets[sourceId] || { x: 0.5, y: 0.5 };
        panRef.current = {
            nodeId: sourceId,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: current.x,
            originY: current.y,
            cellWidth: rect.width,
            cellHeight: rect.height,
        };
    };

    const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = panRef.current;
        if (!pan || pan.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const nextX = clamp01(pan.originX - (event.clientX - pan.startX) / pan.cellWidth);
        const nextY = clamp01(pan.originY - (event.clientY - pan.startY) / pan.cellHeight);
        patch({ mergeOffsets: { ...offsets, [pan.nodeId]: { x: nextX, y: nextY } } });
    };

    const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    };

    const previewAspect =
        node.metadata?.mergeAspectRatio && node.metadata.mergeAspectRatio !== "original"
            ? node.metadata.mergeAspectRatio.replace(":", " / ")
            : `${columns} / ${rows}`;

    return (
        <div className="flex h-full w-full cursor-move flex-col gap-2 px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} data-canvas-no-zoom onWheel={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 font-semibold">
                    <Grid2x2 className="size-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{t("canvas.nodeTypes.merge")}</span>
                </div>
                <span className="shrink-0 text-[11px] opacity-50">{t("canvas.editors.pieces", { count: filledCount })}</span>
            </div>

            <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <div className="mb-2 grid grid-cols-3 gap-1">
                    <Button size="small" type={orientation === "horizontal" ? "primary" : "default"} icon={<Columns2 className="size-3.5" />} onClick={() => applyOrientation("horizontal")} />
                    <Button size="small" type={orientation === "vertical" ? "primary" : "default"} icon={<Rows2 className="size-3.5" />} onClick={() => applyOrientation("vertical")} />
                    <Button size="small" type={orientation === "grid" ? "primary" : "default"} icon={<Grid2x2 className="size-3.5" />} onClick={() => applyOrientation("grid")} />
                </div>

                <div className="mb-2 grid grid-cols-2 gap-1.5">
                    <label className="flex items-center gap-1 text-[11px] opacity-70">
                        <span>{t("canvas.editors.rows")}</span>
                        <input
                            type="number"
                            min={1}
                            max={12}
                            value={rows}
                            className="w-full rounded-md border bg-transparent px-1.5 py-1"
                            style={{ borderColor: theme.node.stroke }}
                            onChange={(event) => setLayoutSize(Number(event.target.value) || 1, columns)}
                        />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] opacity-70">
                        <span>{t("canvas.editors.columns")}</span>
                        <input
                            type="number"
                            min={1}
                            max={12}
                            value={columns}
                            className="w-full rounded-md border bg-transparent px-1.5 py-1"
                            style={{ borderColor: theme.node.stroke }}
                            onChange={(event) => setLayoutSize(rows, Number(event.target.value) || 1)}
                        />
                    </label>
                </div>

                <div className="mb-2">
                    <Segmented
                        block
                        size="small"
                        value={node.metadata?.mergeAspectRatio || "original"}
                        options={[
                            { value: "original", label: t("canvas.editors.originalMode") },
                            { value: "1:1", label: "1:1" },
                            { value: "16:9", label: "16:9" },
                            { value: "9:16", label: "9:16" },
                        ]}
                        onChange={(value) => patch({ mergeAspectRatio: String(value) === "original" ? null : String(value) })}
                    />
                </div>

                <div className="w-full overflow-hidden rounded-xl border" style={{ aspectRatio: previewAspect, borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <div className="grid h-full w-full gap-1 p-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
                        {slots.map((sourceId, index) => {
                            const input = sourceId ? inputById.get(sourceId) : null;
                            const focus = sourceId ? offsets[sourceId] || { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.5 };
                            const row = Math.floor(index / columns) + 1;
                            const column = (index % columns) + 1;
                            return (
                                <div key={`merge-slot-${index}`} className="relative overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke }}>
                                    {input?.image?.dataUrl ? (
                                        <div
                                            className="absolute inset-0 touch-none"
                                            style={{ cursor: "grab" }}
                                            onPointerDown={(event) => beginPan(event, sourceId!)}
                                            onPointerMove={movePan}
                                            onPointerUp={endPan}
                                            onPointerCancel={endPan}
                                        >
                                            <img
                                                src={input.image.dataUrl}
                                                alt={input.title}
                                                draggable={false}
                                                className="pointer-events-none h-full w-full select-none object-cover"
                                                style={{ objectPosition: `${focus.x * 100}% ${focus.y * 100}%` }}
                                            />
                                        </div>
                                    ) : (
                                        <div className="flex h-full min-h-[48px] w-full flex-col items-center justify-center gap-0.5 text-[10px] opacity-45">
                                            <ImagePlus className="size-3.5" />
                                            <span>
                                                {row}×{column}
                                            </span>
                                        </div>
                                    )}
                                    <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/55 px-1 py-0.5 text-[9px] font-semibold text-white">
                                        {row}×{column}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <p className="mt-2 text-[11px] leading-4 opacity-50">{t("canvas.mergeNode.hint")}</p>

                <Button type="primary" block className="mt-2" disabled={!canMerge} icon={isRunning ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} onClick={() => onMerge(node.id)}>
                    {isRunning ? t("canvas.node.generating") : t("canvas.editors.mergeConfirm")}
                </Button>
            </div>
        </div>
    );
}

function remapSlotIds(slots: Array<string | null>, capacity: number) {
    const ordered = slots.filter(Boolean) as string[];
    return Array.from({ length: capacity }, (_, index) => ordered[index] || null);
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
}
