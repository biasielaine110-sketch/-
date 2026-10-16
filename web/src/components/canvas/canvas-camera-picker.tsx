import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";
import { Aperture, Camera, ChevronDown, Focus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    CAMERA_APERTURES,
    CAMERA_BODIES,
    CAMERA_FOCAL_LENGTHS_MM,
    CAMERA_LENSES,
    buildCameraSelectionLabel,
    getCameraApertureImage,
    getCameraBodyImage,
    getCameraLensImage,
    hasCameraSelection,
    type CanvasCameraSelection,
} from "@/constant/camera-options";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasCameraPickerPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

type CanvasCameraPickerProps = {
    /** 当前摄像机参数；undefined 表示未设定（用风格模板自带的相机参数）。 */
    value?: CanvasCameraSelection;
    onChange: (selection: CanvasCameraSelection | undefined) => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    placement?: CanvasCameraPickerPlacement;
};

/**
 * 滚轮几何（对齐剧集画布 CameraPickerPopover）：
 * 视口只比一个卡位高一点点，所以视觉上「一列只有一张卡」——上下箭头才是翻页主入口，
 * 这正是剧集画布的手感，不要擅自把视口撑大。
 */
const WHEEL_ITEM_HEIGHT = 88;
const WHEEL_VIEWPORT_HEIGHT = 118;
const WHEEL_HIGHLIGHT_TOP = 15;
const WHEEL_COLUMN_WIDTH = 136;
const PANEL_WIDTH = WHEEL_COLUMN_WIDTH * 4 + 104;
const THUMB_SIZE_SELECTED = 64;
const THUMB_SIZE_IDLE = 48;

const ARROW_CLASS = "flex h-7 w-full items-center justify-center transition disabled:opacity-25";

const stopEvent = (event: { stopPropagation: () => void }) => event.stopPropagation();

export function CanvasCameraPicker({ value, onChange, onOpenChange, buttonClassName, placement = "topLeft" }: CanvasCameraPickerProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const label = buildCameraSelectionLabel(value);
    const active = hasCameraSelection(value);

    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        // 画布会吞掉 pointerdown（拖整节点），所以「点外关闭」必须用捕获阶段自己实现。
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
            onOpenChange?.(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            onOpenChange?.(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [onOpenChange, open]);

    const panel =
        open && buttonRect ? (
            <CameraPickerPortal
                buttonRect={buttonRect}
                panelRef={panelRef}
                placement={placement}
                theme={theme}
                selection={value}
                onConfirm={onChange}
                onClose={() => updateOpen(false)}
            />
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0 shrink-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={<Aperture className="size-3.5" />}
                    onClick={() => updateOpen(!open)}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={active ? label : t("canvas.cameraPicker.title")}
                >
                    <span className="truncate">{active ? label : t("canvas.cameraPicker.short")}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

type WheelItem = { key: string; label: string; imageSrc?: string };
type WheelFallbackKind = "camera" | "lens" | "aperture";

function CameraPickerPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    selection,
    onConfirm,
    onClose,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasCameraPickerPlacement;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    selection?: CanvasCameraSelection;
    onConfirm: (selection: CanvasCameraSelection | undefined) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - PANEL_WIDTH / 2 : alignRight ? buttonRect.right - PANEL_WIDTH : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width: PANEL_WIDTH,
        left: Math.max(margin, Math.min(window.innerWidth - PANEL_WIDTH - margin, left)),
        ...(topPlacement
            ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(340, buttonRect.top - margin * 2) }
            : { top: buttonRect.bottom + gap, maxHeight: Math.max(340, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    // 草稿态：滚轮随便翻，只有点「使用」才写回。与剧集画布一致——打开即给每列一个默认值，
    // 「清除」则整体回到 undefined（= 用风格自带相机参数）。
    const [draftBody, setDraftBody] = useState(() => selection?.cameraBody || CAMERA_BODIES[0]?.id || "");
    const [draftLens, setDraftLens] = useState(() => selection?.lens || CAMERA_LENSES[0]?.id || "");
    const [draftFocal, setDraftFocal] = useState(() => {
        const stored = typeof selection?.focalLengthMm === "number" ? Math.round(selection.focalLengthMm) : null;
        if (stored && CAMERA_FOCAL_LENGTHS_MM.includes(stored)) return stored;
        return CAMERA_FOCAL_LENGTHS_MM.includes(35) ? 35 : CAMERA_FOCAL_LENGTHS_MM[0];
    });
    const [draftAperture, setDraftAperture] = useState(() => selection?.aperture || CAMERA_APERTURES[0] || "");

    const indexOfValue = <T,>(list: T[], match: (item: T) => boolean) => Math.max(0, list.findIndex(match));

    const commit = () => {
        const next: CanvasCameraSelection = {};
        if (draftBody) next.cameraBody = draftBody;
        if (draftLens) next.lens = draftLens;
        if (typeof draftFocal === "number") next.focalLengthMm = draftFocal;
        if (draftAperture) next.aperture = draftAperture;
        onConfirm(Object.keys(next).length ? next : undefined);
        onClose();
    };

    const columns: Array<{
        key: string;
        label: string;
        caption: string;
        variant: "image" | "text";
        fallbackKind: WheelFallbackKind;
        items: WheelItem[];
        selectedIndex: number;
        onSelect: (index: number) => void;
    }> = [
        {
            key: "body",
            label: t("canvas.cameraPicker.body"),
            caption: CAMERA_BODIES.find((item) => item.id === draftBody)?.label || "",
            variant: "image",
            fallbackKind: "camera",
            items: CAMERA_BODIES.map((item) => ({ key: item.id, label: item.label, imageSrc: getCameraBodyImage(item.id, item.label) })),
            selectedIndex: indexOfValue(CAMERA_BODIES, (item) => item.id === draftBody),
            onSelect: (index) => setDraftBody(CAMERA_BODIES[index]?.id || ""),
        },
        {
            key: "lens",
            label: t("canvas.cameraPicker.lens"),
            caption: CAMERA_LENSES.find((item) => item.id === draftLens)?.label || "",
            variant: "image",
            fallbackKind: "lens",
            items: CAMERA_LENSES.map((item) => ({ key: item.id, label: item.label, imageSrc: getCameraLensImage(item.id, item.label) })),
            selectedIndex: indexOfValue(CAMERA_LENSES, (item) => item.id === draftLens),
            onSelect: (index) => setDraftLens(CAMERA_LENSES[index]?.id || ""),
        },
        {
            key: "focal",
            label: t("canvas.cameraPicker.focal"),
            caption: "mm",
            variant: "text",
            fallbackKind: "camera",
            items: CAMERA_FOCAL_LENGTHS_MM.map((mm) => ({ key: String(mm), label: String(mm) })),
            selectedIndex: indexOfValue(CAMERA_FOCAL_LENGTHS_MM, (mm) => mm === draftFocal),
            onSelect: (index) => setDraftFocal(CAMERA_FOCAL_LENGTHS_MM[index]),
        },
        {
            key: "aperture",
            label: t("canvas.cameraPicker.aperture"),
            caption: draftAperture,
            variant: "image",
            fallbackKind: "aperture",
            items: CAMERA_APERTURES.map((value) => ({ key: value, label: value, imageSrc: getCameraApertureImage(value) })),
            selectedIndex: indexOfValue(CAMERA_APERTURES, (value) => value === draftAperture),
            onSelect: (index) => setDraftAperture(CAMERA_APERTURES[index] || ""),
        },
    ];

    return createPortal(
        <div ref={panelRef} className="canvas-camera-picker" style={style} onPointerDown={stopEvent} onMouseDown={stopEvent} onClick={stopEvent}>
            <div className="flex h-11 items-center justify-between px-4">
                <span className="text-[13px] font-medium">{t("canvas.cameraPicker.title")}</span>
                <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md transition hover:opacity-100"
                    style={{ color: theme.node.text, opacity: 0.55 }}
                    onClick={onClose}
                    onPointerDown={stopEvent}
                    onMouseDown={stopEvent}
                    aria-label={t("common.close")}
                >
                    <X className="size-3.5" />
                </button>
            </div>

            <div className="flex items-start justify-center gap-5 px-5 pb-4">
                {columns.map((column) => (
                    <WheelColumn
                        key={column.key}
                        label={column.label}
                        caption={column.caption}
                        variant={column.variant}
                        fallbackKind={column.fallbackKind}
                        items={column.items}
                        selectedIndex={column.selectedIndex}
                        onSelect={column.onSelect}
                        theme={theme}
                    />
                ))}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 pb-4">
                <Button
                    size="small"
                    type="text"
                    className="!h-8 !rounded-full !px-3 !text-[12px]"
                    style={{ color: theme.node.text, opacity: 0.78 }}
                    onClick={() => {
                        onConfirm(undefined);
                        onClose();
                    }}
                >
                    {t("canvas.cameraPicker.clear")}
                </Button>
                <Button size="small" type="primary" className="!h-8 !rounded-full !px-3.5 !text-[13px]" onClick={commit}>
                    {t("canvas.cameraPicker.use")}
                </Button>
            </div>
        </div>,
        document.body,
    );
}

function WheelColumn({
    label,
    caption,
    variant,
    fallbackKind,
    items,
    selectedIndex,
    onSelect,
    theme,
}: {
    label: string;
    caption: string;
    variant: "image" | "text";
    fallbackKind: WheelFallbackKind;
    items: WheelItem[];
    selectedIndex: number;
    onSelect: (index: number) => void;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
}) {
    const { t } = useTranslation();
    const canPrev = selectedIndex > 0;
    const canNext = selectedIndex < items.length - 1;
    const translateY = WHEEL_HIGHLIGHT_TOP - selectedIndex * WHEEL_ITEM_HEIGHT;

    return (
        <div className="flex flex-col items-center" style={{ width: WHEEL_COLUMN_WIDTH }}>
            <button
                type="button"
                disabled={!canPrev}
                onClick={() => canPrev && onSelect(selectedIndex - 1)}
                className={ARROW_CLASS}
                style={{ color: theme.node.text }}
                onPointerDown={stopEvent}
                aria-label={t("canvas.cameraPicker.prev")}
            >
                <ChevronDown className="size-3.5 rotate-180" />
            </button>

            <div className="relative w-full overflow-hidden" style={{ height: WHEEL_VIEWPORT_HEIGHT }}>
                <div
                    className="pointer-events-none absolute inset-x-3 z-20 rounded-xl border"
                    style={{ top: WHEEL_HIGHLIGHT_TOP, height: WHEEL_ITEM_HEIGHT, borderColor: theme.node.stroke, background: `${theme.node.fill}66` }}
                />
                <div className="flex flex-col items-center" style={{ transform: `translateY(${translateY}px)`, transition: "transform 180ms ease" }}>
                    {items.map((item, index) => {
                        const isSelected = index === selectedIndex;
                        return (
                            <button
                                key={item.key}
                                type="button"
                                onClick={() => onSelect(index)}
                                className={
                                    variant === "image"
                                        ? "flex w-full shrink-0 cursor-pointer flex-col items-center justify-center"
                                        : "flex w-full shrink-0 cursor-pointer items-center justify-center"
                                }
                                style={{ height: WHEEL_ITEM_HEIGHT }}
                                onPointerDown={stopEvent}
                                title={item.label}
                            >
                                {variant === "image" ? (
                                    <WheelThumbnail src={item.imageSrc} label={item.label} kind={fallbackKind} isSelected={isSelected} theme={theme} />
                                ) : (
                                    <span
                                        className="font-semibold leading-none tabular-nums"
                                        style={{ color: theme.node.text, fontSize: isSelected ? 30 : 22, opacity: isSelected ? 1 : 0 }}
                                    >
                                        {item.label}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            <button
                type="button"
                disabled={!canNext}
                onClick={() => canNext && onSelect(selectedIndex + 1)}
                className={ARROW_CLASS}
                style={{ color: theme.node.text }}
                onPointerDown={stopEvent}
                aria-label={t("canvas.cameraPicker.next")}
            >
                <ChevronDown className="size-3.5" />
            </button>

            <span className="mt-2 w-full truncate text-center text-[11px] font-medium" style={{ color: theme.node.text, opacity: 0.72 }}>
                {label}
            </span>
            <span className="mt-0.5 w-full truncate text-center text-[11px]" style={{ color: theme.node.text, opacity: 0.45 }}>
                {caption}
            </span>
        </div>
    );
}

/**
 * 缩略图。素材是白底产品图（无 alpha 通道），所以垫一层浅色圆角底，浅/深主题下都成立。
 * 只有选中项可见（剧集画布同款「一列一卡」手感）；图缺失时退回按类型区分的图标。
 */
function WheelThumbnail({
    src,
    label,
    kind,
    isSelected,
    theme,
}: {
    src?: string;
    label: string;
    kind: WheelFallbackKind;
    isSelected: boolean;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
}) {
    const [broken, setBroken] = useState(false);
    const size = isSelected ? THUMB_SIZE_SELECTED : THUMB_SIZE_IDLE;
    const opacity = isSelected ? 1 : 0;

    if (src && !broken) {
        return (
            <span
                className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg transition-opacity duration-100"
                style={{ width: size, height: size, opacity, background: "rgba(255, 255, 255, 0.92)" }}
            >
                <img src={src} alt={label} loading="lazy" onError={() => setBroken(true)} className="size-full object-contain" />
            </span>
        );
    }

    const FallbackIcon = kind === "lens" ? Focus : kind === "aperture" ? Aperture : Camera;
    return (
        <span
            className="flex shrink-0 items-center justify-center rounded-lg transition-opacity duration-100"
            style={{ width: size, height: size, opacity, background: "rgba(127, 119, 221, 0.18)", color: theme.node.text }}
        >
            <FallbackIcon className={isSelected ? "size-5" : "size-4"} />
        </span>
    );
}
