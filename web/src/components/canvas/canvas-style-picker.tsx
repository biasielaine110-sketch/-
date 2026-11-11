import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button, Input } from "antd";
import { Check, Paintbrush, PencilLine, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    DEFAULT_CUSTOM_STYLE_CATEGORY,
    getAllStyleTemplates,
    getCustomStyleTemplates,
    getStyleTemplate,
    getStyleTemplateCategories,
    isBuiltinStyleTemplate,
    normalizeCustomStyleTemplates,
    normalizePinnedStyleTemplateIds,
    type CanvasStyleTemplate,
} from "@/constant/style-templates";
import { buildStylePickerSections } from "@/lib/canvas/style-picker-sections";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
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

    const customTemplates = useConfigStore((state) => state.config.customStyleTemplates);
    const pinnedIds = useConfigStore((state) => state.config.pinnedStyleTemplateIds);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    /**
     * 编辑态：`null` = 看列表；有值 = 就地切成表单（不弹第二个浮层）。
     *
     * 为什么不弹 antd Modal：面板靠 `pointerdown` 在 window 捕获阶段判「点外面就关」，
     * Modal portal 到 body 会被当成外部点击 → 面板先关、表单跟着消失。
     */
    const [draft, setDraft] = useState<{ id?: string; label: string; category: string; stylePrompt: string } | null>(null);
    const [formError, setFormError] = useState("");
    /**
     * 待确认删除的 id：删除按钮点一次只变红（提示「再点一次删除」），第二次才真删。
     * 为什么不弹 Popconfirm / Modal：它们的 portal 挂在 body 上，会被上面那个「点外面就关」的
     * pointerdown 判成外部点击 → 面板先关、确认框跟着消失，永远点不到「确定」。
     */
    const [pendingRemove, setPendingRemove] = useState("");

    /**
     * 分组 + 置顶（用户 2026-11-11 第 03 条）：
     * **置顶组**在最顶 → **自定义分类**（默认「我的风格」）其次 → 内置分类。
     * 顺序规则全在纯函数 `buildStylePickerSections` 里（可被探针钉住），这里只喂数据。
     * 注意 `customTemplates` 也要进依赖：自定义模板改名 / 改分类后注册表变了，分组得重算。
     */
    const sections = useMemo(
        () =>
            buildStylePickerSections({
                templates: getAllStyleTemplates(),
                categories: getStyleTemplateCategories(),
                customIds: new Set(getCustomStyleTemplates().map((item) => item.id)),
                pinnedIds: normalizePinnedStyleTemplateIds(pinnedIds),
                pinnedTitle: t("canvas.stylePicker.pinnedGroup"),
                keyword: query,
            }),
        [customTemplates, pinnedIds, query, t],
    );

    /**
     * 置顶 / 取消置顶。新置顶的排在最前面（用户点完立刻能在最上面看到它），
     * 取消就从列表里摘掉 —— 摘完它会回到自己的分类里。
     */
    const togglePin = (id: string) => {
        const list = normalizePinnedStyleTemplateIds(pinnedIds);
        const next = list.includes(id) ? list.filter((item) => item !== id) : [id, ...list];
        updateConfig("pinnedStyleTemplateIds", next);
    };

    /** 打开表单：不传 = 新增空表单；传 item = 编辑该条自定义模板。 */
    const openDraft = (item?: CanvasStyleTemplate) => {
        setFormError("");
        setDraft(
            item
                ? { id: item.id, label: item.label, category: item.category, stylePrompt: item.stylePrompt }
                : { label: "", category: DEFAULT_CUSTOM_STYLE_CATEGORY, stylePrompt: "" },
        );
    };

    /** 保存表单：新增（分配 `custom_…` id，并顺手选中它）或改一条自定义模板；内置的永远进不到这里。 */
    const commitDraft = () => {
        if (!draft) return;
        const label = draft.label.trim();
        const stylePrompt = draft.stylePrompt.trim();
        if (!label || !stylePrompt) {
            setFormError(t("canvas.stylePicker.formRequired"));
            return;
        }
        const category = draft.category.trim() || DEFAULT_CUSTOM_STYLE_CATEGORY;
        const list = normalizeCustomStyleTemplates(customTemplates);
        const createdId = draft.id ? "" : `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const next = draft.id
            ? list.map((item) => (item.id === draft.id ? { ...item, label, category, stylePrompt } : item))
            : [...list, { id: createdId, label, category, stylePrompt }];
        updateConfig("customStyleTemplates", next);
        setDraft(null);
        setFormError("");
        // 新建完直接把这条用上（编辑不动当前选择）。父层 onSelect 会顺手收起面板。
        if (createdId) onSelect(createdId);
    };

    /** 删一条自定义模板；正选中它的话顺手清空节点的选择（不留悬空 id）。 */
    const removeTemplate = (id: string) => {
        updateConfig("customStyleTemplates", normalizeCustomStyleTemplates(customTemplates).filter((item) => item.id !== id));
        // 顺手摘掉置顶：留着就是一个永远查不到的 id，导出配置里也会很脏。
        const pinned = normalizePinnedStyleTemplateIds(pinnedIds);
        if (pinned.includes(id)) updateConfig("pinnedStyleTemplateIds", pinned.filter((item) => item !== id));
        if (selectedId === id) onSelect(undefined);
        setPendingRemove("");
    };

    /** 删除按钮：第一次只上膛（变红 + 换提示），第二次才真删。 */
    const handleRemoveClick = (id: string) => {
        if (pendingRemove === id) {
            removeTemplate(id);
            return;
        }
        setPendingRemove(id);
    };

    const muted = theme.node.text;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-style-picker"
            style={style}
            // 面板 portal 到 body，但 React 合成事件仍沿组件树冒回画布容器 → 不拦就会「在面板里滚轮
            // 反而缩放画布」。`data-canvas-no-zoom` 喂给画布的两处 wheel 守卫，stopPropagation 再兜一层。
            data-canvas-no-zoom
            onWheel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t("canvas.stylePicker.title")}</span>
                <span className="flex items-center gap-1">
                    <Button
                        size="small"
                        type="text"
                        className="!h-7 !rounded-full !px-2 !text-xs"
                        style={{ color: muted, opacity: 0.75 }}
                        icon={<Plus className="size-3" />}
                        onClick={() => openDraft()}
                    >
                        {t("canvas.stylePicker.addNew")}
                    </Button>
                    {selectedId ? (
                        <Button size="small" type="text" className="!h-7 !rounded-full !px-2 !text-xs" style={{ color: muted, opacity: 0.75 }} onClick={() => onSelect(undefined)}>
                            {t("canvas.stylePicker.clear")}
                        </Button>
                    ) : null}
                </span>
            </div>
            {draft ? (
                <div className="mt-2 space-y-2">
                    <div className="text-[12px] font-medium opacity-70">{draft.id ? t("canvas.stylePicker.editTitle") : t("canvas.stylePicker.addTitle")}</div>
                    <Input
                        size="small"
                        value={draft.label}
                        maxLength={40}
                        placeholder={t("canvas.stylePicker.fieldLabel")}
                        onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                    />
                    <Input
                        size="small"
                        value={draft.category}
                        maxLength={20}
                        placeholder={t("canvas.stylePicker.fieldCategory")}
                        onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                    />
                    <Input.TextArea
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        value={draft.stylePrompt}
                        placeholder={t("canvas.stylePicker.fieldPrompt")}
                        onChange={(event) => setDraft({ ...draft, stylePrompt: event.target.value })}
                    />
                    {formError ? <div className="text-[11px]" style={{ color: "#e5484d" }}>{formError}</div> : null}
                    <div className="flex items-center justify-end gap-1">
                        <Button
                            size="small"
                            type="text"
                            className="!h-7 !rounded-full !px-2.5 !text-xs"
                            style={{ color: muted, opacity: 0.75 }}
                            onClick={() => {
                                setDraft(null);
                                setFormError("");
                            }}
                        >
                            {t("canvas.stylePicker.cancel")}
                        </Button>
                        <Button size="small" type="primary" className="!h-7 !rounded-full !px-3 !text-xs" onClick={commitDraft}>
                            {t("canvas.stylePicker.save")}
                        </Button>
                    </div>
                </div>
            ) : (
                <>
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
                        {sections.map((section) => (
                            <div key={section.key} className="mb-1.5">
                                <div className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium ${section.pinned ? "opacity-80" : "opacity-50"}`}>
                                    {section.pinned ? <Pin className="size-2.5" /> : null}
                                    <span>{section.title}</span>
                                </div>
                                {section.items.map((item) => {
                                    const active = item.id === selectedId;
                                    const builtin = isBuiltinStyleTemplate(item.id);
                                    const pinned = section.pinned;
                                    return (
                                        <div
                                            key={item.id}
                                            className="flex w-full items-start gap-1 rounded-lg pr-1.5 transition hover:bg-black/5"
                                            style={{ background: active ? "rgba(127,119,221,0.16)" : "transparent", color: muted }}
                                        >
                                            <button type="button" className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left" onClick={() => onSelect(item.id)}>
                                                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{active ? <Check className="size-3.5" /> : null}</span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-[13px] font-medium">{item.label}</span>
                                                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 opacity-55">{item.stylePrompt}</span>
                                                </span>
                                            </button>
                                            <span className="mt-1.5 flex shrink-0 items-center gap-0.5 opacity-60">
                                                {/* 置顶：内置 / 自定义都有（用户 2026-11-11 第 03 条）。 */}
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                                                    style={pinned ? { color: "#7f77dd", opacity: 1 } : { color: muted }}
                                                    title={pinned ? t("canvas.stylePicker.unpin") : t("canvas.stylePicker.pin")}
                                                    icon={pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                                                    onClick={() => togglePin(item.id)}
                                                />
                                                {builtin ? null : (
                                                    <>
                                                        <Button
                                                            size="small"
                                                            type="text"
                                                            className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                                                            style={{ color: muted }}
                                                            title={t("canvas.stylePicker.edit")}
                                                            icon={<PencilLine className="size-3" />}
                                                            onClick={() => openDraft(item)}
                                                        />
                                                        <Button
                                                            size="small"
                                                            type="text"
                                                            className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                                                            style={pendingRemove === item.id ? { color: "#e5484d", opacity: 1 } : { color: muted }}
                                                            title={pendingRemove === item.id ? t("canvas.stylePicker.deleteConfirm") : t("canvas.stylePicker.remove")}
                                                            icon={<Trash2 className="size-3" />}
                                                            onClick={() => handleRemoveClick(item.id)}
                                                        />
                                                    </>
                                                )}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        {sections.length === 0 ? <div className="px-2 py-6 text-center text-xs opacity-50">{t("canvas.stylePicker.empty")}</div> : null}
                        <div className="px-2 pb-1 pt-1.5 text-[10px] leading-3 opacity-40">{t("canvas.stylePicker.builtinLocked")}</div>
                    </div>
                </>
            )}
        </div>,
        document.body,
    );
}
