import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button, ColorPicker, Input, InputNumber, Modal, Slider, Tooltip } from "antd";
import {
    ArrowUpRight,
    Brush,
    Circle,
    Eraser,
    Maximize2,
    MousePointer2,
    Redo2,
    Square,
    Trash2,
    Type,
    Undo2,
    Upload,
    WandSparkles,
    X,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { readImageMeta } from "@/lib/image-utils";
import type { CanvasAnnotation, CanvasAnnotationKind } from "@/types/canvas";

export type CanvasAnnotateSavePayload = {
    annotations: CanvasAnnotation[];
    bakedDataUrl?: string;
};

export type CanvasAnnotateInpaintPayload = {
    prompt: string;
    maskDataUrl: string;
    annotations: CanvasAnnotation[];
};

type AnnotateTool = "select" | CanvasAnnotationKind | "brush" | "erase";
type Point = { x: number; y: number };
type MaskStroke = { mode: "paint" | "erase"; size: number; points: Point[] };
type DraftShape =
    | { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number }
    | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number }
    | null;

const defaultStroke = "#ef4444";
const defaultTextColor = "#111827";
const defaultStrokeWidth = 3;
const defaultFontSize = 28;
const defaultBrushSize = 56;
const maskFillColor = "rgba(37, 99, 235, .38)";
const presetColors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"];

type Props = {
    dataUrl: string;
    open: boolean;
    initialAnnotations?: CanvasAnnotation[];
    onClose: () => void;
    onSave: (payload: CanvasAnnotateSavePayload) => void;
    onInpaint: (payload: CanvasAnnotateInpaintPayload) => void;
    onAddTextNode: (text: string) => void;
    onReplaceImage?: () => void;
};

export function CanvasNodeAnnotateDialog({ dataUrl, open, initialAnnotations = [], onClose, onSave, onInpaint, onAddTextNode, onReplaceImage }: Props) {
    const { t } = useTranslation();
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [tool, setTool] = useState<AnnotateTool>("rect");
    const [annotations, setAnnotations] = useState<CanvasAnnotation[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [strokeColor, setStrokeColor] = useState(defaultStroke);
    const [textColor, setTextColor] = useState(defaultTextColor);
    const [strokeWidth, setStrokeWidth] = useState(defaultStrokeWidth);
    const [fontSize, setFontSize] = useState(defaultFontSize);
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState("");
    const [textDraft, setTextDraft] = useState("");
    const [draft, setDraft] = useState<DraftShape>(null);
    const [history, setHistory] = useState<CanvasAnnotation[][]>([]);
    const [redo, setRedo] = useState<CanvasAnnotation[][]>([]);
    const [maskHistorySize, setMaskHistorySize] = useState(0);
    const [maskRedoSize, setMaskRedoSize] = useState(0);

    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; stroke: MaskStroke | null; start?: Point }>({ active: false, stroke: null });
    const draftRef = useRef<DraftShape>(null);
    const annotationsRef = useRef<CanvasAnnotation[]>([]);
    const maskHistoryRef = useRef<MaskStroke[]>([]);
    const maskRedoRef = useRef<MaskStroke[]>([]);
    const viewport = useImageEditorViewport(image, open);

    const selected = useMemo(() => annotations.find((item) => item.id === selectedId) || null, [annotations, selectedId]);
    const isBrushTool = tool === "brush" || tool === "erase";
    annotationsRef.current = annotations;

    useEffect(() => {
        if (!open) return;
        setTool("rect");
        setAnnotations(initialAnnotations);
        setSelectedId(null);
        setStrokeColor(defaultStroke);
        setTextColor(defaultTextColor);
        setStrokeWidth(defaultStrokeWidth);
        setFontSize(defaultFontSize);
        setBrushSize(defaultBrushSize);
        setPrompt("");
        setError("");
        setTextDraft("");
        draftRef.current = null;
        setDraft(null);
        setHistory([]);
        setRedo([]);
        setMaskHistorySize(0);
        setMaskRedoSize(0);
        maskHistoryRef.current = [];
        maskRedoRef.current = [];
        drawingRef.current = { active: false, stroke: null };
        void readImageMeta(dataUrl).then(setImage);
        // Only reset when the dialog opens or the image changes — not when parent re-renders with a new [] reference.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    useEffect(() => {
        if (!selected) return;
        setStrokeColor(selected.stroke);
        setStrokeWidth(selected.strokeWidth);
        if (selected.kind === "text") {
            setTextColor(selected.color);
            setFontSize(selected.fontSize);
            setTextDraft(selected.text);
        }
    }, [selected]);

    const pushHistory = useCallback((next: CanvasAnnotation[]) => {
        setHistory((current) => [...current.slice(-40), annotationsRef.current]);
        setRedo([]);
        setAnnotations(next);
    }, []);

    const setDraftShape = (next: DraftShape) => {
        draftRef.current = next;
        setDraft(next);
    };

    const updateSelectedStyle = (patch: Partial<CanvasAnnotation>) => {
        if (!selectedId) return;
        pushHistory(
            annotationsRef.current.map((item) => {
                if (item.id !== selectedId) return item;
                if (item.kind === "text") {
                    return {
                        ...item,
                        stroke: ("stroke" in patch && typeof patch.stroke === "string" ? patch.stroke : item.stroke),
                        strokeWidth: ("strokeWidth" in patch && typeof patch.strokeWidth === "number" ? patch.strokeWidth : item.strokeWidth),
                        color: ("color" in patch && typeof patch.color === "string" ? patch.color : item.color),
                        fontSize: ("fontSize" in patch && typeof patch.fontSize === "number" ? patch.fontSize : item.fontSize),
                        text: ("text" in patch && typeof patch.text === "string" ? patch.text : item.text),
                    };
                }
                return {
                    ...item,
                    stroke: ("stroke" in patch && typeof patch.stroke === "string" ? patch.stroke : item.stroke),
                    strokeWidth: ("strokeWidth" in patch && typeof patch.strokeWidth === "number" ? patch.strokeWidth : item.strokeWidth),
                } as CanvasAnnotation;
            }),
        );
    };

    const undoAnnotations = () => {
        const previous = history.at(-1);
        if (!previous) return;
        setHistory((current) => current.slice(0, -1));
        setRedo((current) => [...current, annotations]);
        setAnnotations(previous);
        setSelectedId(null);
    };

    const redoAnnotations = () => {
        const next = redo.at(-1);
        if (!next) return;
        setRedo((current) => current.slice(0, -1));
        setHistory((current) => [...current, annotations]);
        setAnnotations(next);
        setSelectedId(null);
    };

    const replayMask = useCallback(() => {
        const mask = maskCanvasRef.current;
        const preview = previewCanvasRef.current;
        if (!mask || !preview || !image) return;
        clearCanvas(mask);
        clearCanvas(preview);
        const maskCtx = mask.getContext("2d", { willReadFrequently: true });
        const previewCtx = preview.getContext("2d");
        if (!maskCtx || !previewCtx) return;
        maskHistoryRef.current.forEach((stroke) => {
            configureStrokeContext(maskCtx, stroke);
            configurePreviewStrokeContext(previewCtx, stroke);
            stroke.points.forEach((point, index) => {
                const previous = stroke.points[index - 1] || point;
                drawMaskStroke(maskCtx, previous, point, stroke.size);
                drawMaskStroke(previewCtx, previous, point, stroke.size);
            });
        });
    }, [image]);

    const undoMask = () => {
        const stroke = maskHistoryRef.current.pop();
        if (!stroke) return;
        maskRedoRef.current.push(stroke);
        setMaskHistorySize(maskHistoryRef.current.length);
        setMaskRedoSize(maskRedoRef.current.length);
        replayMask();
    };

    const redoMask = () => {
        const stroke = maskRedoRef.current.pop();
        if (!stroke) return;
        maskHistoryRef.current.push(stroke);
        setMaskHistorySize(maskHistoryRef.current.length);
        setMaskRedoSize(maskRedoRef.current.length);
        replayMask();
    };

    const resetMask = () => {
        maskHistoryRef.current = [];
        maskRedoRef.current = [];
        setMaskHistorySize(0);
        setMaskRedoSize(0);
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    };

    const toNorm = (clientX: number, clientY: number) => {
        const stage = viewport.stageRef.current;
        if (!stage || !image) return null;
        const rect = stage.getBoundingClientRect();
        return {
            x: clamp01((clientX - rect.left) / Math.max(1, rect.width)),
            y: clamp01((clientY - rect.top) / Math.max(1, rect.height)),
        };
    };

    const startShape = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (viewport.spacePressed || event.button === 1) return;
        if (isBrushTool) return;
        if (event.button !== 0) return;
        const point = toNorm(event.clientX, event.clientY);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, stroke: null, start: point };
        if (tool === "select") {
            setSelectedId(hitTest(annotationsRef.current, point));
            return;
        }
        if (tool === "text") {
            const text = textDraft.trim() || t("canvas.editors.annotateDefaultText");
            const item: CanvasAnnotation = {
                id: nanoid(),
                kind: "text",
                x: point.x,
                y: point.y,
                text,
                color: textColor,
                fontSize,
                stroke: strokeColor,
                strokeWidth,
            };
            pushHistory([...annotationsRef.current, item]);
            setSelectedId(item.id);
            setTool("select");
            return;
        }
        if (tool === "arrow") setDraftShape({ kind: "arrow", x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        else setDraftShape({ kind: tool, x: point.x, y: point.y, w: 0, h: 0 });
    };

    const moveShape = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (!drawingRef.current.active || !drawingRef.current.start || isBrushTool) return;
        const point = toNorm(event.clientX, event.clientY);
        if (!point) return;
        const start = drawingRef.current.start;
        if (tool === "arrow") {
            setDraftShape({ kind: "arrow", x1: start.x, y1: start.y, x2: point.x, y2: point.y });
            return;
        }
        if (tool === "rect" || tool === "ellipse") {
            setDraftShape({
                kind: tool,
                x: Math.min(start.x, point.x),
                y: Math.min(start.y, point.y),
                w: Math.abs(point.x - start.x),
                h: Math.abs(point.y - start.y),
            });
        }
    };

    const endShape = () => {
        const current = draftRef.current;
        draftRef.current = null;
        drawingRef.current = { active: false, stroke: null };
        setDraft(null);
        if (!current) return;
        if (current.kind === "arrow") {
            if (Math.hypot(current.x2 - current.x1, current.y2 - current.y1) < 0.01) return;
            const item: CanvasAnnotation = { id: nanoid(), ...current, stroke: strokeColor, strokeWidth };
            pushHistory([...annotationsRef.current, item]);
            setSelectedId(item.id);
            return;
        }
        if (current.w < 0.008 || current.h < 0.008) return;
        const item: CanvasAnnotation = { id: nanoid(), ...current, stroke: strokeColor, strokeWidth };
        pushHistory([...annotationsRef.current, item]);
        setSelectedId(item.id);
    };

    const startBrush = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!isBrushTool || viewport.spacePressed || event.button === 1) return;
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const stroke: MaskStroke = { mode: tool === "erase" ? "erase" : "paint", size: brushSize, points: [point] };
        drawingRef.current = { active: true, stroke };
        const maskCtx = maskCanvasRef.current?.getContext("2d", { willReadFrequently: true });
        const previewCtx = previewCanvasRef.current?.getContext("2d");
        if (!maskCtx || !previewCtx) return;
        configureStrokeContext(maskCtx, stroke);
        configurePreviewStrokeContext(previewCtx, stroke);
        drawMaskStroke(maskCtx, point, point, stroke.size);
        drawMaskStroke(previewCtx, point, point, stroke.size);
    };

    const moveBrush = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const stroke = drawingRef.current.stroke;
        if (!drawingRef.current.active || !stroke) return;
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const last = stroke.points.at(-1) || point;
        const maskCtx = maskCanvasRef.current?.getContext("2d", { willReadFrequently: true });
        const previewCtx = previewCanvasRef.current?.getContext("2d");
        if (!maskCtx || !previewCtx) return;
        configureStrokeContext(maskCtx, stroke);
        configurePreviewStrokeContext(previewCtx, stroke);
        drawMaskStroke(maskCtx, last, point, stroke.size);
        drawMaskStroke(previewCtx, last, point, stroke.size);
        stroke.points.push(point);
    };

    const endBrush = () => {
        const stroke = drawingRef.current.stroke;
        drawingRef.current = { active: false, stroke: null };
        if (!stroke || stroke.points.length === 0) return;
        maskHistoryRef.current.push(stroke);
        maskRedoRef.current = [];
        setMaskHistorySize(maskHistoryRef.current.length);
        setMaskRedoSize(0);
        setError("");
    };

    const deleteSelected = () => {
        if (!selectedId) return;
        pushHistory(annotationsRef.current.filter((item) => item.id !== selectedId));
        setSelectedId(null);
    };

    const handleSave = async (bake: boolean) => {
        const current = annotationsRef.current;
        if (!bake) {
            onSave({ annotations: current });
            return;
        }
        if (!image) return;
        // Bake shapes onto a new image so the canvas gets a concrete marked-image copy.
        const bakedDataUrl = await bakeAnnotations(dataUrl, image, current);
        onSave({ annotations: current, bakedDataUrl });
    };

    const handleInpaint = () => {
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError(t("canvas.editors.maskPromptRequired"));
        if (!canvas || !canvasHasPaint(canvas)) return setError(t("canvas.editors.maskRequired"));
        onInpaint({ prompt: nextPrompt, maskDataUrl: buildEditMask(canvas), annotations: annotationsRef.current });
    };

    const handleAddTextNode = () => {
        const text = (selected?.kind === "text" ? selected.text : textDraft).trim() || t("canvas.editors.annotateDefaultText");
        onAddTextNode(text);
    };

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            const mod = event.ctrlKey || event.metaKey;
            if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) {
                event.preventDefault();
                if (isBrushTool) undoMask();
                else undoAnnotations();
            }
            if (mod && ((event.key.toLowerCase() === "z" && event.shiftKey) || event.key.toLowerCase() === "y")) {
                event.preventDefault();
                if (isBrushTool) redoMask();
                else redoAnnotations();
            }
            if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
                event.preventDefault();
                deleteSelected();
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, isBrushTool, selectedId, history, redo, annotations]);

    const overlayItems = draft ? [...annotations, draftAsAnnotation(draft, strokeColor, strokeWidth)] : annotations;

    return (
        <Modal
            open={open && Boolean(dataUrl)}
            onCancel={onClose}
            footer={null}
            width="min(96vw, 1280px)"
            centered
            destroyOnHidden
            title={null}
            transitionName=""
            maskTransitionName=""
            styles={{ body: { padding: 16 } }}
            zIndex={4000}
            maskClosable
        >
            <div className="space-y-4" data-canvas-no-zoom data-canvas-shortcuts-ignore onMouseDown={(event) => event.stopPropagation()}>
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="mr-2 text-lg font-semibold">{t("canvas.editors.annotateTitle")}</h2>
                    <ToolButton active={tool === "select"} icon={<MousePointer2 className="size-4" />} label={t("canvas.editors.annotateSelect")} onClick={() => setTool("select")} />
                    <ToolButton active={tool === "rect"} icon={<Square className="size-4" />} label={t("canvas.editors.annotateRect")} onClick={() => setTool("rect")} />
                    <ToolButton active={tool === "ellipse"} icon={<Circle className="size-4" />} label={t("canvas.editors.annotateEllipse")} onClick={() => setTool("ellipse")} />
                    <ToolButton active={tool === "arrow"} icon={<ArrowUpRight className="size-4" />} label={t("canvas.editors.annotateArrow")} onClick={() => setTool("arrow")} />
                    <ToolButton active={tool === "text"} icon={<Type className="size-4" />} label={t("canvas.editors.annotateText")} onClick={() => setTool("text")} />
                    <ToolButton active={tool === "brush"} icon={<Brush className="size-4" />} label={t("canvas.editors.brush")} onClick={() => setTool("brush")} />
                    <ToolButton active={tool === "erase"} icon={<Eraser className="size-4" />} label={t("canvas.editors.erase")} onClick={() => setTool("erase")} />
                    <div className="mx-1 h-6 w-px bg-black/10 dark:bg-white/10" />
                    <Tooltip title={t("canvas.editors.undoMaskTitle")}>
                        <Button type="text" icon={<Undo2 className="size-4" />} disabled={isBrushTool ? !maskHistorySize : !history.length} onClick={isBrushTool ? undoMask : undoAnnotations} />
                    </Tooltip>
                    <Tooltip title={t("canvas.editors.redoMaskTitle")}>
                        <Button type="text" icon={<Redo2 className="size-4" />} disabled={isBrushTool ? !maskRedoSize : !redo.length} onClick={isBrushTool ? redoMask : redoAnnotations} />
                    </Tooltip>
                    <Tooltip title={t("canvas.editors.zoomOut")}>
                        <Button type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} onClick={viewport.zoomOut} />
                    </Tooltip>
                    <button type="button" className="min-w-14 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                        {Math.round(viewport.zoom * 100)}%
                    </button>
                    <Tooltip title={t("canvas.editors.zoomIn")}>
                        <Button type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} onClick={viewport.zoomIn} />
                    </Tooltip>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        {onReplaceImage ? (
                            <Button icon={<Upload className="size-4" />} onClick={onReplaceImage}>
                                {t("canvas.editors.annotateReplace")}
                            </Button>
                        ) : null}
                        <Button icon={<Type className="size-4" />} onClick={handleAddTextNode}>
                            {t("canvas.editors.annotateAddTextNode")}
                        </Button>
                        <Button icon={<X className="size-4" />} onClick={onClose}>
                            {t("canvas.editors.cancel")}
                        </Button>
                        <Button onClick={() => void handleSave(false)}>{t("canvas.editors.annotateSaveOnly")}</Button>
                        <Button type="primary" icon={<Maximize2 className="size-4" />} onClick={() => void handleSave(true)}>
                            {t("canvas.editors.annotateConfirm")}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(360px,1fr)_300px]">
                    <div
                        ref={viewport.viewportRef}
                        {...viewport.panHandlers}
                        className={`relative h-[min(68vh,720px)] min-h-[360px] overflow-hidden rounded-xl border border-black/10 bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.03] ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                    >
                        <div className="relative" style={viewport.contentStyle}>
                            <div ref={viewport.stageRef} className="absolute isolate overflow-hidden rounded-lg select-none" style={viewport.stageStyle}>
                                {image ? (
                                    <div className="absolute left-0 top-0" style={viewport.mediaStyle}>
                                        <img src={dataUrl} alt="" className="absolute inset-0 block h-full w-full object-contain" draggable={false} />
                                        <svg
                                            className={`absolute inset-0 z-10 h-full w-full ${isBrushTool ? "pointer-events-none" : "cursor-crosshair touch-none"}`}
                                            viewBox="0 0 1 1"
                                            preserveAspectRatio="none"
                                            onPointerDown={startShape}
                                            onPointerMove={moveShape}
                                            onPointerUp={endShape}
                                            onPointerCancel={endShape}
                                        >
                                            {overlayItems.map((item) => (
                                                <AnnotationShape key={item.id} item={item} selected={item.id === selectedId} />
                                            ))}
                                        </svg>
                                        <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                        <canvas
                                            ref={previewCanvasRef}
                                            width={image.width}
                                            height={image.height}
                                            className={`absolute inset-0 z-20 h-full w-full touch-none ${isBrushTool ? "cursor-crosshair" : "pointer-events-none"}`}
                                            onPointerDown={startBrush}
                                            onPointerMove={moveBrush}
                                            onPointerUp={endBrush}
                                            onPointerCancel={endBrush}
                                        />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <div className="flex min-h-[360px] flex-col gap-3 overflow-y-auto rounded-xl border border-black/10 p-3 dark:border-white/10">
                        <div className="text-sm opacity-60">{image ? `${image.width} × ${image.height}px` : t("canvas.editors.loading")}</div>
                        <div className="text-xs leading-5 opacity-55">{t("canvas.editors.annotateHint")}</div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium">{t("canvas.editors.annotateStrokeColor")}</div>
                            <div className="flex flex-wrap items-center gap-2">
                                <ColorPicker value={strokeColor} onChange={(_, hex) => { setStrokeColor(hex); updateSelectedStyle({ stroke: hex }); }} size="small" />
                                {presetColors.map((color) => (
                                    <button key={color} type="button" className="size-6 rounded-full border border-black/10 dark:border-white/20" style={{ background: color }} onClick={() => { setStrokeColor(color); updateSelectedStyle({ stroke: color }); }} />
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium">{t("canvas.editors.annotateFontColor")}</div>
                            <div className="flex flex-wrap items-center gap-2">
                                <ColorPicker value={textColor} onChange={(_, hex) => { setTextColor(hex); updateSelectedStyle({ color: hex }); }} size="small" />
                                {presetColors.map((color) => (
                                    <button key={`text-${color}`} type="button" className="size-6 rounded-full border border-black/10 dark:border-white/20" style={{ background: color }} onClick={() => { setTextColor(color); updateSelectedStyle({ color }); }} />
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1 text-xs">
                                <span className="opacity-70">{t("canvas.editors.annotateStrokeWidth")}</span>
                                <InputNumber className="!w-full" min={1} max={24} value={strokeWidth} onChange={(value) => { const next = Number(value) || 1; setStrokeWidth(next); updateSelectedStyle({ strokeWidth: next }); }} />
                            </label>
                            <label className="space-y-1 text-xs">
                                <span className="opacity-70">{t("canvas.editors.annotateFontSize")}</span>
                                <InputNumber className="!w-full" min={12} max={96} value={fontSize} onChange={(value) => { const next = Number(value) || 12; setFontSize(next); updateSelectedStyle({ fontSize: next }); }} />
                            </label>
                        </div>

                        <div className="space-y-1">
                            <div className="text-sm font-medium">{t("canvas.editors.annotateTextContent")}</div>
                            <Input.TextArea
                                rows={3}
                                value={selected?.kind === "text" ? selected.text : textDraft}
                                placeholder={t("canvas.editors.annotateTextPlaceholder")}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setTextDraft(value);
                                    if (selected?.kind === "text") updateSelectedStyle({ text: value });
                                }}
                            />
                        </div>

                        {isBrushTool ? (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium opacity-75">{t("canvas.editors.brushSize")}</span>
                                    <span className="font-semibold">{brushSize}px</span>
                                </div>
                                <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                                <Button onClick={resetMask}>{t("canvas.editors.reset")}</Button>
                            </div>
                        ) : null}

                        <div className="space-y-2">
                            <div className="text-sm font-medium opacity-75">{t("canvas.editors.editInstructions")}</div>
                            <Input.TextArea
                                rows={4}
                                value={prompt}
                                status={error && !prompt.trim() ? "error" : undefined}
                                placeholder={t("canvas.editors.maskPlaceholder")}
                                onChange={(event) => {
                                    setPrompt(event.target.value);
                                    setError("");
                                }}
                            />
                            {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                            <Button type="primary" block icon={<WandSparkles className="size-4" />} onClick={handleInpaint}>
                                {t("canvas.editors.annotateInpaint")}
                            </Button>
                        </div>

                        <Button danger icon={<Trash2 className="size-4" />} disabled={!selectedId} onClick={deleteSelected}>
                            {t("canvas.editors.annotateDelete")}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function ToolButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
    return (
        <Tooltip title={label}>
            <Button type={active ? "primary" : "default"} icon={icon} onClick={onClick} aria-label={label} />
        </Tooltip>
    );
}

function AnnotationShape({ item, selected }: { item: CanvasAnnotation; selected: boolean }) {
    // Coordinates are normalized to viewBox 0..1. With non-scaling-stroke, strokeWidth is in CSS pixels
    // (the stored annotation value), not viewBox units — dividing by 400 made marks invisible.
    const width = Math.max(1, item.strokeWidth);
    const highlight = selected ? { strokeDasharray: "6 4" } : {};
    if (item.kind === "rect") {
        return <rect x={item.x} y={item.y} width={item.w} height={item.h} fill="none" stroke={item.stroke} strokeWidth={width} vectorEffect="non-scaling-stroke" {...highlight} />;
    }
    if (item.kind === "ellipse") {
        return <ellipse cx={item.x + item.w / 2} cy={item.y + item.h / 2} rx={item.w / 2} ry={item.h / 2} fill="none" stroke={item.stroke} strokeWidth={width} vectorEffect="non-scaling-stroke" {...highlight} />;
    }
    if (item.kind === "arrow") {
        const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
        const head = arrowHeadNorm(item.strokeWidth);
        const left = { x: item.x2 - head * Math.cos(angle - Math.PI / 6), y: item.y2 - head * Math.sin(angle - Math.PI / 6) };
        const right = { x: item.x2 - head * Math.cos(angle + Math.PI / 6), y: item.y2 - head * Math.sin(angle + Math.PI / 6) };
        // vectorEffect is not inherited — must be set on each stroked child, otherwise
        // strokeWidth is interpreted in viewBox units (0..1) and the arrow looks huge.
        const strokeProps = { stroke: item.stroke, strokeWidth: width, fill: "none" as const, vectorEffect: "non-scaling-stroke" as const, ...highlight };
        return (
            <g>
                <line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2} {...strokeProps} />
                <polyline points={`${left.x},${left.y} ${item.x2},${item.y2} ${right.x},${right.y}`} {...strokeProps} />
            </g>
        );
    }
    return (
        <text x={item.x} y={item.y} fill={item.color} fontSize={Math.max(0.02, item.fontSize / 800)} fontWeight={600} style={{ userSelect: "none" }}>
            {item.text}
        </text>
    );
}

/** Arrowhead length in normalized 0..1 coords (~0.8% of side at default stroke). */
function arrowHeadNorm(strokeWidth: number) {
    return Math.max(0.005, Math.min(0.012, strokeWidth * 0.0025));
}

function draftAsAnnotation(draft: Exclude<DraftShape, null>, stroke: string, strokeWidth: number): CanvasAnnotation {
    if (draft.kind === "arrow") return { id: "draft", ...draft, stroke, strokeWidth };
    return { id: "draft", ...draft, stroke, strokeWidth };
}

function hitTest(annotations: CanvasAnnotation[], point: Point) {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
        const item = annotations[index];
        if (item.kind === "text") {
            if (Math.abs(item.x - point.x) < 0.08 && Math.abs(item.y - point.y) < 0.05) return item.id;
            continue;
        }
        if (item.kind === "arrow") {
            const distance = pointToSegmentDistance(point, { x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
            if (distance < 0.02) return item.id;
            continue;
        }
        if (point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h) return item.id;
    }
    return null;
}

function pointToSegmentDistance(point: Point, a: Point, b: Point) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = clamp01(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

async function bakeAnnotations(dataUrl: string, size: { width: number; height: number }, annotations: CanvasAnnotation[]) {
    const image = await loadHtmlImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(image, 0, 0, size.width, size.height);
    annotations.forEach((item) => {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = item.strokeWidth;
        if (item.kind === "rect") {
            ctx.strokeRect(item.x * size.width, item.y * size.height, item.w * size.width, item.h * size.height);
            return;
        }
        if (item.kind === "ellipse") {
            ctx.beginPath();
            ctx.ellipse((item.x + item.w / 2) * size.width, (item.y + item.h / 2) * size.height, (item.w / 2) * size.width, (item.h / 2) * size.height, 0, 0, Math.PI * 2);
            ctx.stroke();
            return;
        }
        if (item.kind === "arrow") {
            const x1 = item.x1 * size.width;
            const y1 = item.y1 * size.height;
            const x2 = item.x2 * size.width;
            const y2 = item.y2 * size.height;
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const head = arrowHeadNorm(item.strokeWidth) * Math.min(size.width, size.height);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
            ctx.stroke();
            return;
        }
        ctx.fillStyle = item.color;
        ctx.font = `600 ${item.fontSize}px sans-serif`;
        ctx.fillText(item.text, item.x * size.width, item.y * size.height);
    });
    return canvas.toDataURL("image/png");
}

function loadHtmlImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image load failed"));
        image.src = src;
    });
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function configureStrokeContext(context: CanvasRenderingContext2D, stroke: MaskStroke) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.size;
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    context.strokeStyle = "#ffffff";
    context.fillStyle = "#ffffff";
}

function configurePreviewStrokeContext(context: CanvasRenderingContext2D, stroke: MaskStroke) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.size;
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    context.strokeStyle = maskFillColor;
    context.fillStyle = maskFillColor;
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
    context.fill();
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 8) return true;
    }
    return false;
}

function buildEditMask(source: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) return source.toDataURL("image/png");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(source, 0, 0);
    return canvas.toDataURL("image/png");
}

function clamp01(value: number) {
    return Math.min(1, Math.max(0, value));
}
