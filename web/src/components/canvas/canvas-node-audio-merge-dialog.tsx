import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { App, Button, Checkbox, Modal } from "antd";
import { Combine, GripVertical, Music2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatAudioClock, loadAudioBlob, mergeAudioBlobs } from "@/lib/canvas/canvas-audio-tools";
import { proxyMediaUrl } from "@/lib/api-proxy";

export type AudioMergeCandidate = {
    id: string;
    title: string;
    url: string;
    durationMs?: number;
    /** Node has no audio content yet — shown in the grid but skipped when merging. */
    empty?: boolean;
};

type CanvasNodeAudioMergeDialogProps = {
    open: boolean;
    candidates: AudioMergeCandidate[];
    selected: string[];
    // Kept for backward-compat with the caller; the dialog is now a self-contained centered window
    // (no canvas-pick overlay), so these are no longer rendered.
    picking?: boolean;
    onSelectedChange: (selected: string[]) => void;
    onPickingChange?: (picking: boolean) => void;
    onClose: () => void;
    onMerge: (blob: Blob) => Promise<void> | void;
};

export function CanvasNodeAudioMergeDialog({
    open,
    candidates,
    selected,
    onSelectedChange,
    onClose,
    onMerge,
}: CanvasNodeAudioMergeDialogProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const [previewId, setPreviewId] = useState<string | null>(null);
    // Drag-reorder state for the selected grid cards.
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const dragIndexRef = useRef<number | null>(null);

    useEffect(() => {
        if (!open) return;
        setPreviewId(null);
        setBusy(false);
        setProgress(0);
        setDragIndex(null);
        setDropIndex(null);
    }, [open]);

    // Selected candidates, preserving the user's chosen order (selected[] order).
    const ordered = useMemo(() => {
        const selectedSet = new Set(selected);
        return candidates.filter((candidate) => selectedSet.has(candidate.id));
    }, [candidates, selected]);

    const previewUrl = useMemo(() => {
        if (!previewId) return "";
        const candidate = candidates.find((item) => item.id === previewId);
        if (!candidate) return "";
        return candidate.url.startsWith("blob:") || candidate.url.startsWith("data:") ? candidate.url : proxyMediaUrl(candidate.url);
    }, [candidates, previewId]);

    const toggle = (id: string) => {
        onSelectedChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
    };

    const setAll = (checked: boolean) => {
        onSelectedChange(checked ? candidates.map((candidate) => candidate.id) : []);
    };

    const reorder = (fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex) return;
        const next = [...selected];
        const [item] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, item);
        onSelectedChange(next);
    };

    const handleCardDragStart = (event: ReactDragEvent, index: number) => {
        event.dataTransfer.effectAllowed = "move";
        // Private MIME type — never text/plain, so the canvas drop handler can't mistake this
        // for an external text drop (which would spawn a text node + editor dialog).
        event.dataTransfer.setData("application/x-canvas-audio-reorder", String(index));
        dragIndexRef.current = index;
        setDragIndex(index);
        setDropIndex(null);
    };

    const handleCardDragOver = (event: ReactDragEvent, index: number) => {
        if (dragIndexRef.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (dropIndex !== index) setDropIndex(index);
    };

    const handleCardDrop = (event: ReactDragEvent, targetIndex: number) => {
        event.preventDefault();
        event.stopPropagation();
        const rawFrom = dragIndexRef.current ?? Number(event.dataTransfer.getData("application/x-canvas-audio-reorder"));
        dragIndexRef.current = null;
        setDragIndex(null);
        setDropIndex(null);
        if (!Number.isFinite(rawFrom) || rawFrom < 0 || rawFrom >= selected.length || rawFrom === targetIndex) return;
        reorder(rawFrom, targetIndex);
    };

    const handleCardDragEnd = () => {
        dragIndexRef.current = null;
        setDragIndex(null);
        setDropIndex(null);
    };

    const mergeableCount = ordered.filter((candidate) => candidate.url && !candidate.empty).length;

    const runMerge = async () => {
        if (busy) return;
        // Skip empty nodes; only nodes with real audio content participate in the merge.
        const mergeable = ordered.filter((candidate) => candidate.url && !candidate.empty);
        if (mergeable.length < 2) {
            message.warning(t("canvas.audioMerge.needMore"));
            return;
        }
        setBusy(true);
        setProgress(0);
        try {
            const blobs: Blob[] = [];
            for (let i = 0; i < mergeable.length; i++) {
                blobs.push(await loadAudioBlob(mergeable[i].url));
                setProgress(((i + 1) / (mergeable.length + 1)) * 0.5);
            }
            const merged = await mergeAudioBlobs(blobs, (value) => setProgress(0.5 + value * 0.5));
            await onMerge(merged);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.audioMerge.failed"));
        } finally {
            setBusy(false);
            setProgress(0);
        }
    };

    return (
        <Modal title={null} open={open} onCancel={() => { if (!busy) onClose(); }} footer={null} width={760} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="space-y-4" data-canvas-no-zoom data-canvas-shortcuts-ignore>
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.audioMerge.title")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.audioMerge.subtitle")}</p>
                </div>

                {candidates.length ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <Checkbox
                                checked={selected.length === candidates.length}
                                indeterminate={selected.length > 0 && selected.length < candidates.length}
                                onChange={(event) => setAll(event.target.checked)}
                            >
                                <span className="text-sm opacity-70">{t("canvas.audioMerge.selectAll")}</span>
                            </Checkbox>
                            <span className="text-xs opacity-50">{t("canvas.audioMerge.selectedCount", { count: ordered.length })}</span>
                        </div>

                        {/* Grid of selected cards, draggable to reorder */}
                        {ordered.length ? (
                            <div className="grid grid-cols-2 gap-2 rounded-xl border p-3 sm:grid-cols-3">
                                {ordered.map((candidate, index) => {
                                    const isDragging = dragIndex === index;
                                    const isDropTarget = dropIndex === index && dragIndex !== null && dragIndex !== index;
                                    return (
                                        <div
                                            key={candidate.id}
                                            data-audio-merge-card={index}
                                            onDragOver={(event) => handleCardDragOver(event, index)}
                                            onDrop={(event) => handleCardDrop(event, index)}
                                            className={`relative flex flex-col gap-1 rounded-lg border p-2 transition ${isDropTarget ? "ring-2 ring-sky-500" : ""} ${isDragging ? "opacity-40" : ""} ${previewId === candidate.id ? "border-blue-400 bg-blue-50/40" : ""}`}
                                            style={{ borderColor: isDropTarget ? "#0ea5e9" : undefined }}
                                        >
                                            <div className="flex items-center gap-1.5">
                                                <span
                                                    draggable={!busy}
                                                    onDragStart={(event) => handleCardDragStart(event, index)}
                                                    onDragEnd={handleCardDragEnd}
                                                    className="cursor-grab touch-none opacity-45 active:cursor-grabbing"
                                                    title={t("canvas.audioMerge.reorderHint")}
                                                    aria-label={t("canvas.audioMerge.reorderHint")}
                                                >
                                                    <GripVertical className="size-3.5" />
                                                </span>
                                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-black/10 text-[11px] font-semibold opacity-70">{index + 1}</span>
                                                <span className="truncate text-sm font-medium">{candidate.title}</span>
                                            </div>
                                            <div className="flex items-center justify-between gap-1">
                                                <button
                                                    type="button"
                                                    className="min-w-0 flex-1 truncate text-left text-xs opacity-60"
                                                    onClick={() => setPreviewId(candidate.id === previewId ? null : candidate.id)}
                                                >
                                                    {candidate.empty
                                                        ? t("canvas.audioMerge.emptySlot")
                                                        : candidate.durationMs
                                                          ? formatAudioClock((candidate.durationMs || 0) / 1000)
                                                          : ""}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="rounded p-1 opacity-60 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-25"
                                                    disabled={busy}
                                                    onClick={() => toggle(candidate.id)}
                                                    title={t("canvas.audioMerge.selectAll")}
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="rounded-xl border px-4 py-8 text-center text-sm opacity-50">{t("canvas.audioMerge.needMore")}</div>
                        )}

                        {previewUrl ? (
                            <div className="rounded-xl border p-3">
                                <audio key={previewUrl} src={previewUrl} className="w-full" controls preload="metadata" />
                            </div>
                        ) : null}

                        {busy && progress > 0 ? (
                            <div className="flex justify-between text-sm">
                                <span className="opacity-60">{t("canvas.audioMerge.progress")}</span>
                                <span className="font-semibold">{Math.round(progress * 100)}%</span>
                            </div>
                        ) : null}

                        <Button
                            type="primary"
                            size="large"
                            block
                            icon={<Combine className="size-4" />}
                            loading={busy}
                            disabled={mergeableCount < 2}
                            onClick={() => void runMerge()}
                        >
                            {t("canvas.audioMerge.action", { count: mergeableCount })}
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-2 rounded-xl border py-10 text-center">
                        <Music2 className="size-8 opacity-30" />
                        <p className="text-sm opacity-50">{t("canvas.audioMerge.empty")}</p>
                    </div>
                )}
            </div>
        </Modal>
    );
}
