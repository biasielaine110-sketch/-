import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, App, Modal } from "antd";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { imageExtension } from "@/lib/canvas/canvas-generation-helpers";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { saveBlobAs } from "@/lib/fs/save-blob";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasImagePreviewInfo = {
    title?: string;
    nodeId?: string;
    nodeType?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    mimeType?: string;
    bytes?: number;
    model?: string;
    prompt?: string;
    status?: string;
};

type CanvasImagePreviewModalProps = {
    open: boolean;
    src: string | null | undefined;
    title?: string;
    fileName?: string;
    projectId?: string | null;
    info?: CanvasImagePreviewInfo | null;
    onClose: () => void;
};

const PREVIEW_STAGE_ATTR = "data-canvas-image-preview-stage";

export function CanvasImagePreviewModal({ open, src, title, fileName, projectId, info, onClose }: CanvasImagePreviewModalProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;

    useEffect(() => {
        if (!open) return;
        setZoom(1);
        setOffset({ x: 0, y: 0 });
        setMenu(null);
        setMeasured(null);
    }, [open, src]);

    useEffect(() => {
        if (!open || !src) return;
        let cancelled = false;
        const image = new Image();
        image.onload = () => {
            if (!cancelled) setMeasured({ width: image.naturalWidth, height: image.naturalHeight });
        };
        image.onerror = () => {
            if (!cancelled) setMeasured(null);
        };
        image.src = src;
        return () => {
            cancelled = true;
        };
    }, [open, src]);

    // Capture-phase document listener so zoom works even if Ant Modal mounts asynchronously
    // and so canvas page wheel handlers cannot swallow the event first.
    useEffect(() => {
        if (!open || !src) return;
        const handleWheel = (event: WheelEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest(`[${PREVIEW_STAGE_ATTR}]`)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            setZoom((current) => {
                const next = Math.min(8, Math.max(0.25, current * factor));
                if (next <= 1.01) setOffset({ x: 0, y: 0 });
                return next;
            });
        };
        document.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => document.removeEventListener("wheel", handleWheel, true);
    }, [open, src]);

    useEffect(() => {
        if (!menu) return;
        const close = (event: Event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-canvas-image-preview-menu]")) return;
            setMenu(null);
        };
        const closeNow = () => setMenu(null);
        window.addEventListener("pointerdown", close, true);
        window.addEventListener("blur", closeNow);
        window.addEventListener("resize", closeNow);
        return () => {
            window.removeEventListener("pointerdown", close, true);
            window.removeEventListener("blur", closeNow);
            window.removeEventListener("resize", closeNow);
        };
    }, [menu]);

    const pixelWidth = measured?.width || info?.naturalWidth || 0;
    const pixelHeight = measured?.height || info?.naturalHeight || 0;
    const byteSize = useMemo(() => {
        if (!src) return 0;
        if (typeof info?.bytes === "number" && info.bytes > 0) return info.bytes;
        return getDataUrlByteSize(src);
    }, [info?.bytes, src]);
    const formatLabel = useMemo(() => {
        if (info?.mimeType) return info.mimeType.replace(/^image\//, "").toUpperCase();
        if (!src) return "";
        if (src.startsWith("data:image/")) {
            const match = /^data:image\/([a-z0-9+.-]+)/i.exec(src);
            return (match?.[1] || "IMG").toUpperCase();
        }
        return imageExtension(src).toUpperCase();
    }, [info?.mimeType, src]);

    if (!src) return null;

    const handleContextMenu = (event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
    };

    const handleDownload = () => {
        const name = fileName || `image.${imageExtension(src)}`;
        void saveBlobAs(src, name, { projectId }).then((result) => {
            if (result.method === "draft") {
                message.success(t("canvas.draft.savedToFolder", { name: result.fileName, folder: result.folderName || "" }));
            }
        });
        setMenu(null);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || zoomRef.current <= 1.01) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
        };
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setOffset({
            x: drag.originX + (event.clientX - drag.startX),
            y: drag.originY + (event.clientY - drag.startY),
        });
    };

    const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    };

    const displayTitle = title || info?.title || t("canvas.projectPage.imageDetails");

    return (
        <>
            <Modal
                title={displayTitle}
                open={open}
                centered
                onCancel={onClose}
                footer={null}
                width="min(96vw, 1180px)"
                destroyOnHidden
                styles={{
                    body: {
                        padding: 0,
                        overflow: "hidden",
                    },
                }}
            >
                <div className="grid min-h-[min(78vh,820px)] lg:grid-cols-[minmax(0,1fr)_280px]" data-canvas-no-zoom data-canvas-shortcuts-ignore>
                    <div
                        data-canvas-image-preview-stage=""
                        className="relative flex min-h-[360px] items-center justify-center overflow-hidden bg-black/5 select-none"
                        onContextMenu={handleContextMenu}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        style={{ cursor: zoom > 1.01 ? "grab" : "default" }}
                    >
                        <img
                            src={src}
                            alt={displayTitle}
                            draggable={false}
                            className="max-h-[min(78vh,820px)] max-w-full object-contain will-change-transform"
                            style={{
                                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                                transformOrigin: "center center",
                            }}
                        />
                        <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/90">{Math.round(zoom * 100)}%</div>
                    </div>

                    <aside className="flex flex-col border-t lg:border-l lg:border-t-0" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}>
                        <div className="border-b px-4 py-3 text-sm font-semibold" style={{ borderColor: theme.node.stroke }}>
                            {t("canvas.imagePreview.infoTitle")}
                        </div>
                        <div className="thin-scrollbar flex-1 space-y-3 overflow-auto px-4 py-3 text-sm">
                            <InfoRow label={t("canvas.nodeToolbar.name")} value={info?.title || displayTitle} />
                            {info?.nodeType ? <InfoRow label={t("canvas.nodeToolbar.type")} value={info.nodeType} /> : null}
                            {info?.nodeId ? <InfoRow label="ID" value={info.nodeId} /> : null}
                            <InfoRow label={t("canvas.imagePreview.resolution")} value={pixelWidth && pixelHeight ? `${pixelWidth} × ${pixelHeight} px` : t("canvas.editors.loading")} />
                            {info?.displayWidth && info?.displayHeight ? (
                                <InfoRow label={t("canvas.imagePreview.displaySize")} value={`${Math.round(info.displayWidth)} × ${Math.round(info.displayHeight)}`} />
                            ) : null}
                            {formatLabel ? <InfoRow label={t("canvas.imagePreview.format")} value={formatLabel} /> : null}
                            {byteSize ? <InfoRow label={t("canvas.nodeToolbar.imageSize")} value={formatBytes(byteSize)} /> : null}
                            {info?.model ? <InfoRow label={t("canvas.imagePreview.model")} value={info.model} /> : null}
                            {info?.status ? <InfoRow label={t("canvas.nodeToolbar.status")} value={info.status} /> : null}
                            {info?.prompt ? <InfoRow label={t("canvas.configNode.prompt")} value={info.prompt} /> : null}
                            <InfoRow label={t("canvas.imagePreview.zoom")} value={`${Math.round(zoom * 100)}%`} />
                        </div>
                        <div className="border-t p-3" style={{ borderColor: theme.node.stroke }}>
                            <Button type="primary" block icon={<Download className="size-4" />} onClick={handleDownload}>
                                {t("common.download")}
                            </Button>
                            <div className="mt-2 text-[11px] opacity-50">{t("canvas.imagePreview.hint")}</div>
                        </div>
                    </aside>
                </div>
            </Modal>

            {menu
                ? createPortal(
                      <div
                          data-canvas-image-preview-menu
                          className="fixed z-[5000] min-w-40 overflow-hidden rounded-xl border py-1 shadow-2xl"
                          style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                          onPointerDown={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onContextMenu={(event) => event.preventDefault()}
                      >
                          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" onClick={handleDownload}>
                              <Download className="size-4" />
                              <span>{t("common.download")}</span>
                          </button>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </div>
    );
}
