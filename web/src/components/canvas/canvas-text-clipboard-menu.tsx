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
const EDITABLE_SELECTOR = "textarea,input:not([type='button']):not([type='submit']):not([type='checkbox']):not([type='radio']),[contenteditable='true'],[data-canvas-text-input]";

export function isCanvasTextInteractionTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(`${SELECTABLE_SELECTOR},${EDITABLE_SELECTOR}`));
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
            if (target.closest(".ant-select-dropdown,.ant-picker-dropdown")) return;

            const editable = target.closest(EDITABLE_SELECTOR) as HTMLElement | null;
            const selectable = target.closest(SELECTABLE_SELECTOR) as HTMLElement | null;
            if (!editable && !selectable) return;

            const selectedText = readSelectedText(editable);
            if (!selectedText && !editable) return;

            event.preventDefault();
            event.stopPropagation();
            setMenu({
                x: event.clientX,
                y: event.clientY,
                selectedText,
                editable,
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
            className="fixed z-[1100] min-w-40 overflow-hidden rounded-xl border py-1 shadow-2xl"
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

function readSelectedText(editable: HTMLElement | null) {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        const start = editable.selectionStart ?? 0;
        const end = editable.selectionEnd ?? 0;
        if (end > start) return editable.value.slice(start, end);
    }
    return window.getSelection()?.toString() || "";
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
