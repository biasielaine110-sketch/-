import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button, Input } from "antd";
import { Check, Paintbrush } from "lucide-react";
import { useTranslation } from "react-i18next";

import { STYLE_TEMPLATE_CATEGORIES, STYLE_TEMPLATES, getStyleTemplate, type CanvasStyleTemplate } from "@/constant/style-templates";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasStylePickerPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

type CanvasStylePickerProps = {
    /** 选中的风格模板 id；空串/undefined 表示未指定。 */
    value?: string;
    onChange: (styleTemplateId: string | undefined) => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    placement?: CanvasStylePickerPlacement;
};

export function CanvasStylePicker({ value, onChange, onOpenChange, buttonClassName, placement = "topLeft" }: CanvasStylePickerProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const selected = getStyleTemplate(value);

    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
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
            <StylePickerPortal
                buttonRect={buttonRect}
                panelRef={panelRef}
                placement={placement}
                theme={theme}
                selectedId={value}
                onSelect={(styleTemplateId) => {
                    onChange(styleTemplateId);
                    updateOpen(false);
                }}
            />
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0 shrink-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[160px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={<Paintbrush className="size-3.5" />}
                    onClick={() => updateOpen(!open)}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={selected ? selected.label : t("canvas.stylePicker.title")}
                >
                    <span className="truncate">{selected?.label || t("canvas.stylePicker.short")}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function StylePickerPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    selectedId,
    onSelect,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasStylePickerPlacement;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    selectedId?: string;
    onSelect: (styleTemplateId: string | undefined) => void;
}) {
    const { t } = useTranslation();
    const [query, setQuery] = useState("");
    const width = 372;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement
            ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(320, buttonRect.top - margin * 2) }
            : { top: buttonRect.bottom + gap, maxHeight: Math.max(320, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 14,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    const grouped = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        const match = (item: CanvasStyleTemplate) =>
            !keyword || item.label.toLowerCase().includes(keyword) || item.stylePrompt.toLowerCase().includes(keyword) || item.category.toLowerCase().includes(keyword);
        const source = STYLE_TEMPLATES.filter(match);
        const buckets = new Map<string, CanvasStyleTemplate[]>();
        for (const item of source) {
            const list = buckets.get(item.category) || [];
            list.push(item);
            buckets.set(item.category, list);
        }
        const ordered = [...STYLE_TEMPLATE_CATEGORIES, ...buckets.keys()].filter((category, index, all) => all.indexOf(category) === index);
        return ordered.map((category) => ({ category, items: buckets.get(category) || [] })).filter((group) => group.items.length > 0);
    }, [query]);

    const muted = theme.node.text;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-style-picker"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t("canvas.stylePicker.title")}</span>
                {selectedId ? (
                    <Button size="small" type="text" className="!h-7 !rounded-full !px-2 !text-xs" style={{ color: muted, opacity: 0.75 }} onClick={() => onSelect(undefined)}>
                        {t("canvas.stylePicker.clear")}
                    </Button>
                ) : null}
            </div>
            <Input
                size="small"
                allowClear
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("canvas.stylePicker.search")}
                className="mt-2"
            />
            <div className="mt-2 max-h-[360px] overflow-y-auto thin-scrollbar pr-1">
                <button
                    type="button"
                    className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] transition hover:opacity-100"
                    style={{ background: selectedId ? "transparent" : "rgba(127,119,221,0.14)", color: muted }}
                    onClick={() => onSelect(undefined)}
                >
                    <span className="flex size-4 shrink-0 items-center justify-center">{selectedId ? null : <Check className="size-3.5" />}</span>
                    <span className="truncate font-medium">{t("canvas.stylePicker.none")}</span>
                    <span className="ml-auto shrink-0 text-[11px] opacity-50">{t("canvas.stylePicker.noneHint")}</span>
                </button>
                {grouped.map((group) => (
                    <div key={group.category} className="mb-1.5">
                        <div className="px-2 py-1 text-[11px] font-medium opacity-50">{group.category}</div>
                        {group.items.map((item) => {
                            const active = item.id === selectedId;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-black/5"
                                    style={{ background: active ? "rgba(127,119,221,0.16)" : "transparent", color: muted }}
                                    onClick={() => onSelect(item.id)}
                                >
                                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{active ? <Check className="size-3.5" /> : null}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[13px] font-medium">{item.label}</span>
                                        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 opacity-55">{item.stylePrompt}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ))}
                {grouped.length === 0 ? <div className="px-2 py-6 text-center text-xs opacity-50">{t("canvas.stylePicker.empty")}</div> : null}
            </div>
        </div>,
        document.body,
    );
}
