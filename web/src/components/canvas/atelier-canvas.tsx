import React, { useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";
import { blurActiveCanvasTextInput } from "@/components/canvas/canvas-text-clipboard-menu";

type AtelierCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    /** Fired the moment the user starts a manual pan/zoom, before the viewport is committed. */
    onUserInteract?: () => void;
    children: React.ReactNode;
};

export function AtelierCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, onUserInteract, children }: AtelierCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const scaleRef = useRef(viewport.k);
    const viewportLiveRef = useRef(viewport);
    const onViewportChangeRef = useRef(onViewportChange);
    const onUserInteractRef = useRef(onUserInteract);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);
    // Pan offset applied locally during a drag so the parent (and every canvas node) is NOT
    // re-rendered on each pointermove. The final viewport is committed once on pointerup.
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    // Same idea for wheel zoom: mirror the pending viewport into local state so the shell's
    // transform (and the grid) track the gesture instantly, while `children` keeps its element
    // identity — React skips the whole node/connection subtree until the viewport is committed.
    const [liveTransform, setLiveTransform] = useState<ViewportTransform | null>(null);
    const zoomCommitTimerRef = useRef<number | null>(null);

    useEffect(() => {
        scaleRef.current = viewport.k;
        viewportLiveRef.current = viewport;
        // The parent accepted our committed viewport — drop the local mirror.
        setLiveTransform(null);
    }, [viewport]);

    useEffect(() => {
        onViewportChangeRef.current = onViewportChange;
    }, [onViewportChange]);

    useEffect(() => {
        onUserInteractRef.current = onUserInteract;
    }, [onUserInteract]);

    const flushViewport = () => {
        frameRef.current = null;
        const next = nextViewportRef.current;
        if (!next) return;
        nextViewportRef.current = null;
        // Debounce the actual parent commit: a rapid wheel burst re-renders only this shell
        // (children keep their element identity). The parent re-renders nodes exactly once
        // after the gesture settles — the same contract the pan gesture already has.
        if (zoomCommitTimerRef.current) window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = window.setTimeout(() => {
            zoomCommitTimerRef.current = null;
            onViewportChangeRef.current(viewportLiveRef.current);
        }, 160);
    };

    /** Synchronously commit any pending zoom viewport — must run before any world-coordinate
     *  interaction (node click, drop, connection) so the parent never computes positions with
     *  a stale viewport during the debounce window. */
    const flushPendingViewport = () => {
        if (zoomCommitTimerRef.current) {
            window.clearTimeout(zoomCommitTimerRef.current);
            zoomCommitTimerRef.current = null;
        }
        if (nextViewportRef.current || viewportLiveRef.current !== viewport) {
            onViewportChangeRef.current(viewportLiveRef.current);
        }
    };

    const scheduleViewport = (next: ViewportTransform) => {
        nextViewportRef.current = next;
        viewportLiveRef.current = next;
        scaleRef.current = next.k;
        // Instant local mirror — this re-render only touches the shell + grid.
        setLiveTransform(next);
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(flushViewport);
    };

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (zoomCommitTimerRef.current) window.clearTimeout(zoomCommitTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            setIsControlPressed(false);
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        // Text inputs (contentEditable prompt boxes, chat composer, text nodes) scroll their own
        // content on wheel — never let that gesture fall through to canvas zoom.
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown,[contenteditable='true'],[data-canvas-text-input]")) return;

        onUserInteractRef.current?.();
        const current = nextViewportRef.current || viewportLiveRef.current;
        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(current.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - current.x) / current.k;
        const worldY = (mouseY - current.y) / current.k;

        scheduleViewport({
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        // Any pointer interaction needs a world-accurate viewport: commit a pending (debounced)
        // zoom synchronously before hit-testing / node creation runs with it.
        flushPendingViewport();
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-select,.ant-select-dropdown,.ant-picker-dropdown,.ant-dropdown,.ant-modal,.ant-popover")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && isBackgroundClick);

        if (shouldPan) {
            blurActiveCanvasTextInput(event.target);
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onUserInteractRef.current?.();
            // Anchor pan to the live viewport (not the possibly-stale `viewport` prop), so a
            // wheel-zoom that has been scheduled but not yet flushed to the parent cannot cause
            // the canvas to jump back to an old position when the user starts panning right after.
            const live = viewportLiveRef.current;
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: live.x,
                initialY: live.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setPanOffset({ x: 0, y: 0 });
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            // preventDefault blocks the browser's default blur; clear focus explicitly for shortcuts.
            blurActiveCanvasTextInput(event.target);
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            // Local-only offset: re-renders just this canvas shell (transform), not the
            // parent project page nor any node/connection. Keeps panning GPU-composited
            // and avoids the per-frame visibleNodes/visibleConnections re-filter.
            setPanOffset({ x: dx, y: dy });
            viewportLiveRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            const finalViewport = viewportLiveRef.current;
            panState.current.isPanning = false;
            setPanOffset({ x: 0, y: 0 });
            setIsPanning(false);
            document.body.style.cursor = "";
            // Commit the final viewport exactly once; the parent then re-renders nodes once.
            onViewportChangeRef.current(finalViewport);
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent page scroll while zooming the canvas, but allow native scrolling inside
        // node panels marked data-canvas-no-zoom (chat history, text editors, dialogs).
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    // What the shell actually shows: a pending (debounced) zoom transform wins, otherwise the
    // committed viewport plus the live pan offset.
    const displayTransform = liveTransform
        ? { x: liveTransform.x + panOffset.x, y: liveTransform.y + panOffset.y, k: liveTransform.k }
        : { x: viewport.x + panOffset.x, y: viewport.y + panOffset.y, k: viewport.k };
    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
        // Drops create nodes at a world position — commit any pending zoom first.
        flushPendingViewport();
        onDrop?.(event);
    };

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
        >
            <CanvasGrid viewport={displayTransform} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${displayTransform.x}px, ${displayTransform.y}px) scale(${displayTransform.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
