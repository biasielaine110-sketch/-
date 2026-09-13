import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
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
    onNodeSizeChange?: (nodeId: string, width: number, height: number) => void;
};

const CHROME_HEIGHT = 196;
const PREVIEW_MAX_WIDTH = 560;
const PREVIEW_MAX_HEIGHT = 480;
const PREVIEW_MIN_WIDTH = 240;
const NODE_MIN_WIDTH = 360;
const NODE_MAX_WIDTH = 720;
const NODE_MIN_HEIGHT = 360;
const NODE_MAX_HEIGHT = 920;

export function CanvasMergeNodeContent({ node, inputs, isRunning, onConfigChange, onMerge, onNodeSizeChange }: CanvasMergeNodeContentProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [naturalSizes, setNaturalSizes] = useState<Record<string, { width: number; height: number }>>({});
    const [dragSlotIndex, setDragSlotIndex] = useState<number | null>(null);
    const [dropSlotIndex, setDropSlotIndex] = useState<number | null>(null);
    const lastAutoSizeRef = useRef({ width: 0, height: 0 });

    const imageInputs = useMemo(() => inputs.filter((input) => input.type === "image" && input.image?.dataUrl), [inputs]);
    const inputById = useMemo(() => new Map(imageInputs.map((input) => [input.nodeId, input])), [imageInputs]);
    const orientation = (node.metadata?.mergeOrientation || "grid") as MergeOrientation;
    const rows = Math.max(1, node.metadata?.mergeRows || 2);
    const columns = Math.max(1, node.metadata?.mergeColumns || 2);
    const capacity = rows * columns;

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

    useEffect(() => {
        let cancelled = false;
        const missing = imageInputs.filter((input) => input.image?.dataUrl && !naturalSizes[input.nodeId]);
        if (!missing.length) return;
        void Promise.all(
            missing.map(
                (input) =>
                    new Promise<{ id: string; width: number; height: number }>((resolve) => {
                        const image = new Image();
                        image.onload = () => resolve({ id: input.nodeId, width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
                        image.onerror = () => resolve({ id: input.nodeId, width: 1, height: 1 });
                        image.src = input.image!.dataUrl;
                    }),
            ),
        ).then((results) => {
            if (cancelled) return;
            setNaturalSizes((current) => {
                const next = { ...current };
                results.forEach((item) => {
                    next[item.id] = { width: item.width, height: item.height };
                });
                return next;
            });
        });
        return () => {
            cancelled = true;
        };
    }, [imageInputs, naturalSizes]);

    const cellAspect = useMemo(() => {
        const sized = slots.map((id) => (id ? naturalSizes[id] : null)).filter((item): item is { width: number; height: number } => Boolean(item && item.width > 0 && item.height > 0));
        if (!sized.length) return 1;
        const maxW = Math.max(...sized.map((item) => item.width));
        const maxH = Math.max(...sized.map((item) => item.height));
        return maxW / Math.max(1, maxH);
    }, [naturalSizes, slots]);

    const previewAspectValue = useMemo(() => {
        if (node.metadata?.mergeAspectRatio && node.metadata.mergeAspectRatio !== "original") {
            const [w, h] = node.metadata.mergeAspectRatio.split(":").map(Number);
            if (w > 0 && h > 0) return w / h;
        }
        return (columns * cellAspect) / Math.max(1, rows);
    }, [cellAspect, columns, node.metadata?.mergeAspectRatio, rows]);

    useEffect(() => {
        if (!onNodeSizeChange) return;
        let previewWidth = Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, node.width - 24));
        let previewHeight = previewWidth / Math.max(0.2, previewAspectValue);
        if (previewHeight > PREVIEW_MAX_HEIGHT) {
            previewHeight = PREVIEW_MAX_HEIGHT;
            previewWidth = previewHeight * previewAspectValue;
        }
        if (previewWidth < PREVIEW_MIN_WIDTH) {
            previewWidth = PREVIEW_MIN_WIDTH;
            previewHeight = previewWidth / Math.max(0.2, previewAspectValue);
        }
        const nextWidth = Math.round(clamp(previewWidth + 24, NODE_MIN_WIDTH, NODE_MAX_WIDTH));
        const nextHeight = Math.round(clamp(previewHeight + CHROME_HEIGHT, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT));
        if (Math.abs(nextWidth - lastAutoSizeRef.current.width) < 10 && Math.abs(nextHeight - lastAutoSizeRef.current.height) < 10) return;
        if (Math.abs(nextWidth - node.width) < 10 && Math.abs(nextHeight - node.height) < 10) {
            lastAutoSizeRef.current = { width: nextWidth, height: nextHeight };
            return;
        }
        lastAutoSizeRef.current = { width: nextWidth, height: nextHeight };
        onNodeSizeChange(node.id, nextWidth, nextHeight);
    }, [node.height, node.id, node.width, onNodeSizeChange, previewAspectValue, filledCount, rows, columns]);

    const patch = (next: Partial<CanvasNodeMetadata>) => onConfigChange(node.id, next);

    const persistSlots = (nextSlots: Array<string | null>) => {
        patch({ mergeSlotIds: nextSlots });
    };

    const applyOrientation = (next: MergeOrientation) => {
        const layout = resolveMergeLayout(Math.max(filledCount || imageInputs.length || 4, 2), next);
        patch({ mergeOrientation: next, mergeRows: layout.rows, mergeColumns: layout.columns, mergeSlotIds: remapSlotIds(slots, layout.rows * layout.columns) });
    };

    const setLayoutSize = (nextRows: number, nextColumns: number) => {
        const safeRows = clamp(nextRows, 1, 12);
        const safeColumns = clamp(nextColumns, 1, 12);
        const remapped = remapSlotIds(slots, safeRows * safeColumns);
        patch({ mergeOrientation: "grid", mergeRows: safeRows, mergeColumns: safeColumns, mergeSlotIds: remapped });
    };

    const swapSlots = (from: number, to: number) => {
        if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return;
        const next = [...slots];
        const temp = next[from];
        next[from] = next[to];
        next[to] = temp;
        persistSlots(next);
    };

    const handleDragStart = (event: ReactDragEvent<HTMLDivElement>, index: number, sourceId: string) => {
        event.stopPropagation();
        setDragSlotIndex(index);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/merge-slot", String(index));
        event.dataTransfer.setData("text/merge-source", sourceId);
    };

    const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, index: number) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropSlotIndex !== index) setDropSlotIndex(index);
    };

    const handleDrop = (event: ReactDragEvent<HTMLDivElement>, index: number) => {
        event.preventDefault();
        event.stopPropagation();
        const from = Number(event.dataTransfer.getData("text/merge-slot"));
        if (Number.isFinite(from)) swapSlots(from, index);
        setDragSlotIndex(null);
        setDropSlotIndex(null);
    };

    const handleDragEnd = () => {
        setDragSlotIndex(null);
        setDropSlotIndex(null);
    };

    const previewAspectCss =
        node.metadata?.mergeAspectRatio && node.metadata.mergeAspectRatio !== "original"
            ? node.metadata.mergeAspectRatio.replace(":", " / ")
            : `${previewAspectValue}`;

    return (
        <div className="flex h-full w-full cursor-move flex-col gap-2 px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} data-canvas-no-zoom onWheel={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 font-semibold">
                    <Grid2x2 className="size-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{t("canvas.nodeTypes.merge")}</span>
                </div>
                <span className="shrink-0 text-[11px] opacity-50">{t("canvas.editors.pieces", { count: filledCount })}</span>
            </div>

            <div className="flex min-h-0 flex-1 cursor-default flex-col" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
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

                <div className="min-h-0 w-full flex-1 overflow-hidden rounded-xl border" style={{ aspectRatio: previewAspectCss, borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <div className="grid h-full w-full gap-1 p-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
                        {slots.map((sourceId, index) => {
                            const input = sourceId ? inputById.get(sourceId) : null;
                            const row = Math.floor(index / columns) + 1;
                            const column = (index % columns) + 1;
                            const isDragging = dragSlotIndex === index;
                            const isDropTarget = dropSlotIndex === index && dragSlotIndex != null && dragSlotIndex !== index;
                            return (
                                <div
                                    key={`merge-slot-${index}`}
                                    className={`relative overflow-hidden rounded-md border transition ${isDropTarget ? "ring-2 ring-sky-500" : ""} ${isDragging ? "opacity-55" : ""}`}
                                    style={{ borderColor: isDropTarget ? "#0ea5e9" : theme.node.stroke }}
                                    onDragOver={(event) => handleDragOver(event, index)}
                                    onDragLeave={() => {
                                        if (dropSlotIndex === index) setDropSlotIndex(null);
                                    }}
                                    onDrop={(event) => handleDrop(event, index)}
                                >
                                    {input?.image?.dataUrl ? (
                                        <div
                                            className="absolute inset-0"
                                            style={{ cursor: "grab" }}
                                            draggable
                                            onDragStart={(event) => handleDragStart(event, index, sourceId!)}
                                            onDragEnd={handleDragEnd}
                                        >
                                            <img src={input.image.dataUrl} alt={input.title} draggable={false} className="pointer-events-none h-full w-full select-none object-contain" />
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
    return Math.max(min, Math.min(max, value));
}
