import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Segmented, Tooltip } from "antd";
import { ArrowLeftRight, Columns2, Grid2x2, ImagePlus, Rows2, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { readFileAsDataUrl } from "@/lib/image-utils";

export type MergeOrientation = "horizontal" | "vertical" | "grid";

export type MergeCandidateImage = {
    id: string;
    title: string;
    dataUrl: string;
    grid?: { row?: number; column?: number; rows?: number; columns?: number; groupId?: string };
    position: { x: number; y: number };
};

export type CanvasImageMergeParams = {
    orientation: MergeOrientation;
    aspectRatio: string | null;
    rows: number;
    columns: number;
    pieces: Array<{ row: number; column: number; dataUrl: string; nodeId?: string; offsetX?: number; offsetY?: number }>;
    sourceNodeIds: string[];
};

const aspectPresets = ["original", "1:1", "4:3", "3:4", "16:9", "9:16"] as const;
const maxGridSize = 12;

export function resolveMergeLayout(count: number, orientation: MergeOrientation): { rows: number; columns: number } {
    const n = Math.max(2, count);
    if (orientation === "horizontal") return { rows: 1, columns: n };
    if (orientation === "vertical") return { rows: n, columns: 1 };
    if (n === 3) return { rows: 1, columns: 3 };
    if (n === 4) return { rows: 2, columns: 2 };
    if (n === 6) return { rows: 2, columns: 3 };
    if (n === 9) return { rows: 3, columns: 3 };
    const columns = Math.ceil(Math.sqrt(n));
    return { rows: Math.ceil(n / columns), columns };
}

type SlotImage = {
    key: string;
    nodeId?: string;
    title: string;
    dataUrl: string;
};

type FocusOffset = { x: number; y: number };

export function CanvasNodeMergeDialog({
    open,
    candidates,
    availableImages = [],
    onClose,
    onConfirm,
}: {
    open: boolean;
    candidates: MergeCandidateImage[];
    /** Extra canvas images that can be linked into empty slots (e.g. opened from blank double-click). */
    availableImages?: MergeCandidateImage[];
    onClose: () => void;
    onConfirm: (params: CanvasImageMergeParams) => void;
}) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [orientation, setOrientation] = useState<MergeOrientation>("grid");
    const [aspectRatio, setAspectRatio] = useState<string>("original");
    const [rows, setRows] = useState(2);
    const [columns, setColumns] = useState(2);
    const [library, setLibrary] = useState<Record<string, SlotImage>>({});
    const [slots, setSlots] = useState<(string | null)[]>([]);
    const [offsets, setOffsets] = useState<Record<string, FocusOffset>>({});
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    const [dragKey, setDragKey] = useState<string | null>(null);
    const [dragFrom, setDragFrom] = useState<"slot" | "pool" | null>(null);
    const [dragSlotIndex, setDragSlotIndex] = useState<number | null>(null);
    const panRef = useRef<{
        key: string;
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
        cellWidth: number;
        cellHeight: number;
    } | null>(null);

    const seedCount = candidates.length;

    useEffect(() => {
        if (!open) return;
        const seed = candidates;
        const nextOrientation: MergeOrientation = seed.length === 3 ? "horizontal" : "grid";
        const layout = resolveMergeLayout(Math.max(2, seed.length || 4), nextOrientation);
        const nextLibrary: Record<string, SlotImage> = {};
        const ingest = (item: MergeCandidateImage) => {
            nextLibrary[item.id] = { key: item.id, nodeId: item.id, title: item.title, dataUrl: item.dataUrl };
        };
        availableImages.forEach(ingest);
        seed.forEach(ingest);
        const nextSlots =
            seed.length >= 2
                ? buildInitialSlots(sortCandidates(seed, nextOrientation), layout.rows, layout.columns, nextOrientation)
                : seed.length === 1
                  ? (() => {
                        const capacity = layout.rows * layout.columns;
                        const next = Array.from({ length: capacity }, () => null as string | null);
                        next[0] = seed[0].id;
                        return next;
                    })()
                  : Array.from({ length: layout.rows * layout.columns }, () => null);
        setOrientation(nextOrientation);
        setAspectRatio("original");
        setRows(layout.rows);
        setColumns(layout.columns);
        setLibrary(nextLibrary);
        setSlots(nextSlots);
        setOffsets({});
        setSelectedIndex(nextSlots.findIndex(Boolean));
        setDragKey(null);
        setDragFrom(null);
        setDragSlotIndex(null);
        panRef.current = null;
    }, [availableImages, candidates, open, seedCount]);

    const filledCount = useMemo(() => slots.filter(Boolean).length, [slots]);
    const usedKeys = useMemo(() => new Set(slots.filter(Boolean) as string[]), [slots]);
    const poolKeys = useMemo(() => Object.keys(library).filter((key) => !usedKeys.has(key)), [library, usedKeys]);

    const previewAspect = useMemo(() => {
        if (aspectRatio !== "original") {
            const [w, h] = aspectRatio.split(":").map(Number);
            if (w > 0 && h > 0) return `${w} / ${h}`;
        }
        return `${columns} / ${rows}`;
    }, [aspectRatio, columns, rows]);

    const applyOrientation = (next: MergeOrientation) => {
        const layout = resolveMergeLayout(Math.max(filledCount || seedCount || 4, 2), next);
        remapSlots(layout.rows, layout.columns);
        setOrientation(next);
        setRows(layout.rows);
        setColumns(layout.columns);
    };

    const remapSlots = (nextRows: number, nextColumns: number) => {
        const capacity = nextRows * nextColumns;
        setSlots((current) => {
            const ordered = current.filter(Boolean) as string[];
            return Array.from({ length: capacity }, (_, index) => ordered[index] || null);
        });
        setSelectedIndex((current) => {
            if (current != null && current < capacity) return current;
            return 0;
        });
    };

    const setLayoutSize = (nextRows: number, nextColumns: number) => {
        const safeRows = clamp(nextRows, 1, maxGridSize);
        const safeColumns = clamp(nextColumns, 1, maxGridSize);
        setOrientation("grid");
        setRows(safeRows);
        setColumns(safeColumns);
        remapSlots(safeRows, safeColumns);
    };

    const swapSlots = (from: number, to: number) => {
        if (from === to) return;
        setSlots((current) => {
            const next = [...current];
            const temp = next[from];
            next[from] = next[to];
            next[to] = temp;
            return next;
        });
        setSelectedIndex(to);
    };

    const placeIntoSlot = (slotIndex: number, key: string) => {
        setSlots((current) => {
            const next = [...current];
            const existingIndex = next.findIndex((item) => item === key);
            if (existingIndex >= 0) {
                next[existingIndex] = next[slotIndex];
            }
            next[slotIndex] = key;
            return next;
        });
        setSelectedIndex(slotIndex);
    };

    const clearSlot = (slotIndex: number) => {
        setSlots((current) => current.map((item, index) => (index === slotIndex ? null : item)));
    };

    const handleDropOnSlot = (slotIndex: number) => {
        if (!dragKey) return;
        if (dragFrom === "slot" && dragSlotIndex != null) swapSlots(dragSlotIndex, slotIndex);
        else placeIntoSlot(slotIndex, dragKey);
        setDragKey(null);
        setDragFrom(null);
        setDragSlotIndex(null);
    };

    const handleReplaceFile = async (file: File | null) => {
        if (!file || selectedIndex == null) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const key = `upload-${nanoid()}`;
            setLibrary((current) => ({ ...current, [key]: { key, title: file.name, dataUrl } }));
            setOffsets((current) => ({ ...current, [key]: { x: 0.5, y: 0.5 } }));
            placeIntoSlot(selectedIndex, key);
        } catch {
            // ignore invalid image
        }
    };

    const beginPan = (event: ReactPointerEvent<HTMLDivElement>, key: string) => {
        if (event.button !== 0 || dragKey) return;
        const cell = event.currentTarget;
        const rect = cell.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        event.preventDefault();
        event.stopPropagation();
        cell.setPointerCapture(event.pointerId);
        const current = offsets[key] || { x: 0.5, y: 0.5 };
        panRef.current = {
            key,
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
        // Dragging the image right reveals left content → focus moves left.
        const nextX = clamp01(pan.originX - (event.clientX - pan.startX) / pan.cellWidth);
        const nextY = clamp01(pan.originY - (event.clientY - pan.startY) / pan.cellHeight);
        setOffsets((current) => ({ ...current, [pan.key]: { x: nextX, y: nextY } }));
    };

    const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    };

    const confirm = () => {
        const pieces = slots
            .map((key, index) => {
                if (!key) return null;
                const image = library[key];
                if (!image) return null;
                const focus = offsets[key] || { x: 0.5, y: 0.5 };
                return {
                    row: Math.floor(index / columns),
                    column: index % columns,
                    dataUrl: image.dataUrl,
                    nodeId: image.nodeId,
                    offsetX: focus.x,
                    offsetY: focus.y,
                };
            })
            .filter(Boolean) as CanvasImageMergeParams["pieces"];

        if (pieces.length < 2) return;

        const sourceNodeIds = Array.from(new Set(pieces.map((piece) => piece.nodeId).filter(Boolean) as string[]));
        onConfirm({
            orientation,
            aspectRatio: aspectRatio === "original" ? null : aspectRatio,
            rows,
            columns,
            pieces,
            sourceNodeIds: sourceNodeIds.length ? sourceNodeIds : candidates.map((item) => item.id),
        });
    };

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={920} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="space-y-5" data-canvas-no-zoom data-canvas-shortcuts-ignore>
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.mergeTitle")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.editors.mergeVisualDescription", { count: Math.max(filledCount, seedCount, Object.keys(library).length) })}</p>
                    <p className="mt-2 text-xs leading-5 opacity-55">{t("canvas.editors.mergeVisualHint")}</p>
                </div>

                <div className="grid gap-6 md:grid-cols-[minmax(280px,1fr)_320px]">
                    <div className="space-y-3 rounded-xl border p-4">
                        <div className="mx-auto w-full max-w-[560px]" style={{ aspectRatio: previewAspect }}>
                            <div className="grid h-full w-full gap-1.5 rounded-lg bg-black/5 p-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
                                {slots.map((key, index) => {
                                    const image = key ? library[key] : null;
                                    const row = Math.floor(index / columns) + 1;
                                    const column = (index % columns) + 1;
                                    const selected = selectedIndex === index;
                                    const focus = key ? offsets[key] || { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.5 };
                                    return (
                                        <div
                                            key={`slot-${index}`}
                                            role="button"
                                            tabIndex={0}
                                            className={`relative overflow-hidden rounded-md border transition ${selected ? "border-sky-500 ring-2 ring-sky-500/40" : "border-black/10 dark:border-white/10"} ${dragKey ? "cursor-copy" : "cursor-pointer"}`}
                                            onClick={() => setSelectedIndex(index)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") setSelectedIndex(index);
                                            }}
                                            onDragOver={(event) => event.preventDefault()}
                                            onDrop={(event) => {
                                                event.preventDefault();
                                                handleDropOnSlot(index);
                                            }}
                                        >
                                            {image ? (
                                                <div
                                                    className="absolute inset-0 touch-none"
                                                    style={{ cursor: panRef.current?.key === image.key ? "grabbing" : "grab" }}
                                                    onPointerDown={(event) => beginPan(event, image.key)}
                                                    onPointerMove={movePan}
                                                    onPointerUp={endPan}
                                                    onPointerCancel={endPan}
                                                >
                                                    <img
                                                        src={image.dataUrl}
                                                        alt={image.title}
                                                        draggable={false}
                                                        className="pointer-events-none h-full w-full select-none object-cover"
                                                        style={{ objectPosition: `${focus.x * 100}% ${focus.y * 100}%` }}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="flex h-full min-h-[72px] w-full flex-col items-center justify-center gap-1 bg-black/[0.03] text-[11px] opacity-50 dark:bg-white/[0.03]">
                                                    <ImagePlus className="size-4" />
                                                    <span>
                                                        {row},{column}
                                                    </span>
                                                </div>
                                            )}
                                            <span
                                                className="absolute left-1 top-1 z-10 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                                                draggable={Boolean(image)}
                                                title={image ? t("canvas.editors.mergeSwapHint") : undefined}
                                                onDragStart={(event: ReactDragEvent<HTMLSpanElement>) => {
                                                    if (!image) return;
                                                    event.stopPropagation();
                                                    setDragKey(image.key);
                                                    setDragFrom("slot");
                                                    setDragSlotIndex(index);
                                                    event.dataTransfer.effectAllowed = "move";
                                                }}
                                                onDragEnd={() => {
                                                    setDragKey(null);
                                                    setDragFrom(null);
                                                    setDragSlotIndex(null);
                                                }}
                                                style={{ cursor: image ? "grab" : "default" }}
                                            >
                                                {row}×{column}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="small" icon={<Upload className="size-3.5" />} disabled={selectedIndex == null} onClick={() => fileInputRef.current?.click()}>
                                {t("canvas.editors.mergeReplace")}
                            </Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} disabled={selectedIndex == null || !slots[selectedIndex || 0]} onClick={() => selectedIndex != null && clearSlot(selectedIndex)}>
                                {t("canvas.editors.mergeClearSlot")}
                            </Button>
                            <Tooltip title={t("canvas.editors.mergePanHint")}>
                                <span className="inline-flex items-center gap-1 text-xs opacity-55">{t("canvas.editors.mergePanHint")}</span>
                            </Tooltip>
                            <Tooltip title={t("canvas.editors.mergeSwapHint")}>
                                <span className="inline-flex items-center gap-1 text-xs opacity-55">
                                    <ArrowLeftRight className="size-3.5" />
                                    {t("canvas.editors.mergeDragHint")}
                                </span>
                            </Tooltip>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium opacity-75">{t("canvas.editors.mergePool")}</div>
                            <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto rounded-lg border border-dashed p-2">
                                {poolKeys.length ? (
                                    poolKeys.map((key) => {
                                        const image = library[key];
                                        if (!image) return null;
                                        return (
                                            <button
                                                key={key}
                                                type="button"
                                                className="relative h-16 w-16 overflow-hidden rounded-md border border-black/10 dark:border-white/10"
                                                title={image.title}
                                                draggable
                                                onDragStart={(event) => {
                                                    setDragKey(key);
                                                    setDragFrom("pool");
                                                    setDragSlotIndex(null);
                                                    event.dataTransfer.effectAllowed = "move";
                                                }}
                                                onDragEnd={() => {
                                                    setDragKey(null);
                                                    setDragFrom(null);
                                                    setDragSlotIndex(null);
                                                }}
                                                onClick={() => {
                                                    if (selectedIndex == null) return;
                                                    placeIntoSlot(selectedIndex, key);
                                                }}
                                            >
                                                <img src={image.dataUrl} alt={image.title} className="h-full w-full object-cover" draggable={false} />
                                            </button>
                                        );
                                    })
                                ) : (
                                    <span className="px-1 py-2 text-xs opacity-45">{t(Object.keys(library).length ? "canvas.editors.mergePoolEmpty" : "canvas.editors.mergePoolNoImages")}</span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4 py-1">
                        <div className="space-y-2">
                            <div className="text-sm font-medium opacity-75">{t("canvas.editors.mergeOrientation")}</div>
                            <div className="grid grid-cols-3 gap-2">
                                <Button type={orientation === "horizontal" ? "primary" : "default"} icon={<Columns2 className="size-4" />} onClick={() => applyOrientation("horizontal")}>
                                    {t("canvas.editors.mergeHorizontal")}
                                </Button>
                                <Button type={orientation === "vertical" ? "primary" : "default"} icon={<Rows2 className="size-4" />} onClick={() => applyOrientation("vertical")}>
                                    {t("canvas.editors.mergeVertical")}
                                </Button>
                                <Button type={orientation === "grid" ? "primary" : "default"} icon={<Grid2x2 className="size-4" />} onClick={() => applyOrientation("grid")}>
                                    {t("canvas.editors.mergeGrid")}
                                </Button>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium opacity-75">{t("canvas.editors.mergeAspect")}</div>
                            <Segmented
                                block
                                size="small"
                                value={aspectRatio}
                                options={aspectPresets.map((value) => ({
                                    value,
                                    label: value === "original" ? t("canvas.editors.originalMode") : value,
                                }))}
                                onChange={(value) => setAspectRatio(String(value))}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <label className="block space-y-1 text-sm">
                                <span className="opacity-75">{t("canvas.editors.rows")}</span>
                                <input type="number" min={1} max={maxGridSize} value={rows} className="w-full rounded-lg border bg-transparent px-3 py-2" onChange={(event) => setLayoutSize(Number(event.target.value) || 1, columns)} />
                            </label>
                            <label className="block space-y-1 text-sm">
                                <span className="opacity-75">{t("canvas.editors.columns")}</span>
                                <input type="number" min={1} max={maxGridSize} value={columns} className="w-full rounded-lg border bg-transparent px-3 py-2" onChange={(event) => setLayoutSize(rows, Number(event.target.value) || 1)} />
                            </label>
                        </div>

                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.gridLayout")}</span>
                                <span className="font-semibold">
                                    {rows} × {columns}
                                </span>
                            </div>
                            <div className="mt-2 flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.mergeFilled")}</span>
                                <span className="font-semibold">{t("canvas.editors.pieces", { count: filledCount })}</span>
                            </div>
                            {selectedIndex != null ? (
                                <div className="mt-2 flex items-center justify-between">
                                    <span className="opacity-60">{t("canvas.editors.mergeSelectedSlot")}</span>
                                    <span className="font-semibold">
                                        {Math.floor(selectedIndex / columns) + 1}×{(selectedIndex % columns) + 1}
                                    </span>
                                </div>
                            ) : null}
                        </div>

                        <div className="flex gap-2">
                            <Button className="flex-1" onClick={onClose}>
                                {t("canvas.editors.cancel")}
                            </Button>
                            <Button type="primary" className="flex-1" disabled={filledCount < 2} icon={<Grid2x2 className="size-4" />} onClick={confirm}>
                                {t("canvas.editors.mergeConfirm")}
                            </Button>
                        </div>
                    </div>
                </div>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0] || null;
                        event.target.value = "";
                        void handleReplaceFile(file);
                    }}
                />
            </div>
        </Modal>
    );
}

function sortCandidates(candidates: MergeCandidateImage[], orientation: MergeOrientation) {
    return [...candidates].sort((a, b) => {
        const aRow = a.grid?.row;
        const bRow = b.grid?.row;
        const aCol = a.grid?.column;
        const bCol = b.grid?.column;
        if (orientation === "grid" && aRow != null && bRow != null && aCol != null && bCol != null) {
            return aRow === bRow ? aCol - bCol : aRow - bRow;
        }
        if (orientation === "vertical") {
            if (Math.abs(a.position.x - b.position.x) > 8) return a.position.x - b.position.x;
            return a.position.y - b.position.y;
        }
        if (Math.abs(a.position.y - b.position.y) > 8) return a.position.y - b.position.y;
        return a.position.x - b.position.x;
    });
}

function buildInitialSlots(candidates: MergeCandidateImage[], rows: number, columns: number, orientation: MergeOrientation) {
    const capacity = rows * columns;
    const slots: (string | null)[] = Array.from({ length: capacity }, () => null);
    const sorted = sortCandidates(candidates, orientation);

    const canUseGrid =
        orientation === "grid" &&
        sorted.every((item) => item.grid?.row != null && item.grid?.column != null && item.grid?.rows === rows && item.grid?.columns === columns);

    if (canUseGrid) {
        sorted.forEach((item) => {
            const index = item.grid!.row! * columns + item.grid!.column!;
            if (index >= 0 && index < capacity) slots[index] = item.id;
        });
        return slots;
    }

    sorted.slice(0, capacity).forEach((item, index) => {
        slots[index] = item.id;
    });
    return slots;
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
}
