import { useRef, type ReactNode } from "react";
import { Input } from "antd";
import type { TextAreaProps, TextAreaRef } from "antd/es/input/TextArea";
import { useTranslation } from "react-i18next";

import { insertTextIntoInputElement, readClipboardEventText } from "@/lib/canvas/clipboard-paste";
import { useTextFindReplace } from "./canvas-text-find-replace";
import { useCanvasTextEditDialog } from "./use-canvas-text-edit-dialog";

type CanvasFindReplaceTextAreaProps = Omit<TextAreaProps, "value" | "onChange"> & {
    value?: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    resetKey?: string | number | boolean;
    toolbarExtra?: ReactNode;
    hideFindToggle?: boolean;
    /** Opens the shared fullscreen text editor on double-click (default true). */
    enableDoubleClickEdit?: boolean;
    editDialogTitle?: string;
};

/** Ant Design TextArea with find/replace and double-click popup text editor. */
export function CanvasFindReplaceTextArea({
    value = "",
    onChange,
    readOnly = false,
    resetKey,
    toolbarExtra,
    hideFindToggle = false,
    enableDoubleClickEdit = true,
    editDialogTitle,
    className,
    placeholder,
    ...textAreaProps
}: CanvasFindReplaceTextAreaProps) {
    const { t } = useTranslation();
    const textAreaRef = useRef<TextAreaRef>(null);
    const findReplace = useTextFindReplace({
        value,
        onChange: (next) => onChange?.(next),
        getTarget: () => textAreaRef.current?.resizableTextArea?.textArea || null,
        readOnly,
        resetKey,
        showToggle: !hideFindToggle,
    });
    const textEdit = useCanvasTextEditDialog({
        value,
        onChange,
        title: editDialogTitle || t("canvas.nodeToolbar.editTextTitle"),
        placeholder: typeof placeholder === "string" ? placeholder : undefined,
        readOnly,
    });

    return (
        <div className="space-y-2" onKeyDown={(event) => findReplace.handleShortcutKeyDown(event)}>
            {findReplace.toggle || toolbarExtra ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {toolbarExtra}
                    {findReplace.toggle}
                </div>
            ) : null}
            {findReplace.panel}
            <Input.TextArea
                {...textAreaProps}
                ref={textAreaRef}
                value={value}
                readOnly={readOnly}
                placeholder={placeholder}
                className={className}
                onChange={readOnly ? undefined : (event) => onChange?.(event.target.value)}
                onDoubleClick={enableDoubleClickEdit ? textEdit.handleDoubleClick : textAreaProps.onDoubleClick}
                onPaste={(event) => {
                    textAreaProps.onPaste?.(event);
                    if (event.defaultPrevented || readOnly) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const text = readClipboardEventText(event.clipboardData);
                    if (!text) return;
                    const area = textAreaRef.current?.resizableTextArea?.textArea || event.currentTarget;
                    const { next, caret } = insertTextIntoInputElement(area, text, value);
                    onChange?.(next);
                    requestAnimationFrame(() => {
                        area.focus();
                        try {
                            area.setSelectionRange(caret, caret);
                        } catch {
                            // ignore
                        }
                    });
                }}
                data-canvas-shortcuts-ignore
                data-canvas-text-input
            />
            {enableDoubleClickEdit ? textEdit.dialog : null}
        </div>
    );
}
