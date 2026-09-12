import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { App } from "antd";
import copy from "copy-to-clipboard";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type TextClipboardMenuState = {
    x: number;
    y: number;
    selectedText: string;
    editable: HTMLElement | null;
};

const SELECTABLE_SELECTOR = "[data-canvas-selectable-text]";
const EDITABLE_SELECTOR = "textarea,input:not([type='button']):not([type='submit']):not([type='checkbox']):not([type='radio']),[contenteditable],[contenteditable='true'],[data-canvas-text-input],.ant-input,.ant-input-textarea";
const FOCUS_SAFE_SELECTOR = ".ant-select,.ant-select-dropdown,.ant-picker,.ant-picker-dropdown,.ant-dropdown,.ant-modal,.ant-popover,[role='listbox'],[role='option']";

export function isCanvasTextInteractionTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(`${SELECTABLE_SELECTOR},${EDITABLE_SELECTOR},[data-canvas-shortcuts-ignore]`));
}

function isFocusSafeTarget(target: EventTarget | null | undefined) {
    return target instanceof Element && Boolean(target.closest(FOCUS_SAFE_SELECTOR));
}

/** Blur canvas text fields so shortcuts are not typed into a stale focused input. */
export function blurActiveCanvasTextInput(exceptTarget?: EventTarget | null) {
    // Blurring during mousedown on Select/option cancels the click and blocks model switching.
    if (isFocusSafeTarget(exceptTarget)) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!active.matches(EDITABLE_SELECTOR) && !active.isContentEditable) return;
    if (exceptTarget instanceof Node && (active === exceptTarget || active.contains(exceptTarget))) return;
    active.blur();
}

export function CanvasTextClipboardMenu() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [menu, setMenu] = useState<TextClipboardMenuState | null>(null);

    useEffect(() => {
        const handleContextMenu = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest(".ant-select-dropdown,.ant-picker-dropdown,[data-canvas-text-clipboard-menu],[data-canvas-image-preview-menu]")) return;

            const editable = target.closest(EDITABLE_SELECTOR) as HTMLElement | null;
            const selectable = target.closest(SELECTABLE_SELECTOR) as HTMLElement | null;
            // Also treat Ant Design textareas / modal inputs as editable hosts.
            const antEditable = target.closest(".ant-input,.ant-input-textarea,.ant-modal textarea,.ant-modal input") as HTMLElement | null;
            const resolvedEditable = editable || (antEditable instanceof HTMLTextAreaElement || antEditable instanceof HTMLInputElement ? antEditable : antEditable?.querySelector?.("textarea,input") || null);
            if (!resolvedEditable && !selectable) return;

            // Capture selection immediately — some browsers clear it during contextmenu.
            const selectedText = readSelectedText(resolvedEditable instanceof HTMLElement ? resolvedEditable : null, selectable);
            if (!selectedText && !resolvedEditable) return;

            event.preventDefault();
            event.stopPropagation();
            setMenu({
                x: event.clientX,
                y: event.clientY,
                selectedText,
                editable: resolvedEditable instanceof HTMLElement ? resolvedEditable : null,
            });
        };

        const close = (event: Event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-canvas-text-clipboard-menu]")) return;
            setMenu(null);
        };
        const closeNow = () => setMenu(null);

        document.addEventListener("contextmenu", handleContextMenu, true);
        window.addEventListener("pointerdown", close, true);
        window.addEventListener("blur", closeNow);
        window.addEventListener("resize", closeNow);
        return () => {
            document.removeEventListener("contextmenu", handleContextMenu, true);
            window.removeEventListener("pointerdown", close, true);
            window.removeEventListener("blur", closeNow);
            window.removeEventListener("resize", closeNow);
        };
    }, []);

    const handleCopy = useCallback(() => {
        if (!menu?.selectedText) return;
        copy(menu.selectedText);
        message.success(t("common.copied"));
        setMenu(null);
    }, [menu, message, t]);

    const handlePaste = useCallback(async () => {
        if (!menu?.editable) return;
        try {
            const text = await navigator.clipboard.readText();
            if (!text) {
                message.warning(t("canvas.textClipboard.emptyClipboard"));
                setMenu(null);
                return;
            }
            insertTextIntoEditable(menu.editable, text);
            setMenu(null);
        } catch {
            message.error(t("canvas.textClipboard.pasteFailed"));
            setMenu(null);
        }
    }, [menu, message, t]);

    if (!menu) return null;

    return createPortal(
        <div
            data-canvas-text-clipboard-menu
            className="fixed z-[5000] min-w-40 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            {menu.selectedText ? <MenuButton icon={<Copy className="size-4" />} label={t("common.copy")} onClick={handleCopy} /> : null}
            {menu.editable ? <MenuButton icon={<ClipboardPaste className="size-4" />} label={t("common.paste")} onClick={() => void handlePaste()} /> : null}
        </div>,
        document.body,
    );
}

function MenuButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}

function readSelectedText(editable: HTMLElement | null, selectable?: HTMLElement | null) {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        const start = editable.selectionStart ?? 0;
        const end = editable.selectionEnd ?? 0;
        if (end > start) return editable.value.slice(start, end);
    }

    const selection = window.getSelection();
    const selected = selection?.toString() || "";
    if (!selected || !selection || selection.rangeCount === 0) return "";

    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    const scope = editable || selectable;
    if (!scope) return selected;
    if ((anchor && scope.contains(anchor)) || (focus && scope.contains(focus))) return selected;
    return "";
}

function insertTextIntoEditable(editable: HTMLElement, text: string) {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        const start = editable.selectionStart ?? editable.value.length;
        const end = editable.selectionEnd ?? editable.value.length;
        const next = `${editable.value.slice(0, start)}${text}${editable.value.slice(end)}`;
        const prototype = editable instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor?.set?.call(editable, next);
        editable.dispatchEvent(new Event("input", { bubbles: true }));
        const caret = start + text.length;
        editable.focus();
        editable.setSelectionRange(caret, caret);
        return;
    }

    editable.focus();
    if (document.execCommand("insertText", false, text)) {
        editable.dispatchEvent(new Event("input", { bubbles: true }));
        return;
    }

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editable.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    } else {
        editable.append(document.createTextNode(text));
    }
    editable.dispatchEvent(new Event("input", { bubbles: true }));
}
