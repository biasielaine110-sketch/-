import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { insertTextIntoInputElement, readClipboardEventText } from "@/lib/canvas/clipboard-paste";
import { useTextFindReplace } from "./canvas-text-find-replace";
import { CanvasTextPromptPicker } from "./canvas-text-prompt-picker";
import { DEFAULT_CANVAS_FONT_SIZE } from "@/constant/canvas";

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 48;
const FONT_SIZE_STEP = 2;

type CanvasTextEditDialogProps = {
    open: boolean;
    value: string;
    title?: string;
    placeholder?: string;
    fontSize?: number;
    readOnly?: boolean;
    onFontSizeChange?: (fontSize: number) => void;
    onClose: () => void;
    onSave?: (content: string) => void;
};

export function CanvasTextEditDialog({ open, value, title, placeholder, fontSize, readOnly = false, onFontSizeChange, onClose, onSave }: CanvasTextEditDialogProps) {
    const { t } = useTranslation();
    const textAreaRef = useRef<TextAreaRef>(null);
    const draftRef = useRef(value);
    const [draft, setDraft] = useState(value);
    const [localFontSize, setLocalFontSize] = useState(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || DEFAULT_CANVAS_FONT_SIZE)));
    const resolvedFontSize = onFontSizeChange
        ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || DEFAULT_CANVAS_FONT_SIZE))
        : localFontSize;

    draftRef.current = draft;

    // 只在「打开瞬间」同步外部 value，避免打开后父级回写冲掉弹窗内粘贴内容。
    useEffect(() => {
        if (!open) return;
        setDraft(value);
        draftRef.current = value;
        setLocalFontSize(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || DEFAULT_CANVAS_FONT_SIZE)));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- sync once per open
    }, [open]);

    const findReplace = useTextFindReplace({
        value: draft,
        onChange: setDraft,
        getTarget: () => textAreaRef.current?.resizableTextArea?.textArea || null,
        readOnly,
        resetKey: open,
    });

    const handleSave = () => {
        onSave?.(draft);
        onClose();
    };

    const adjustFontSize = (delta: number) => {
        const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, resolvedFontSize + delta));
        if (next === resolvedFontSize) return;
        if (onFontSizeChange) onFontSizeChange(next);
        else setLocalFontSize(next);
    };

    const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
        // 全程自己写入：不依赖原生插入（受控 TextArea + 画布 window paste 抢事件时更稳）。
        event.preventDefault();
        event.stopPropagation();
        if (readOnly) return;
        const text = readClipboardEventText(event.clipboardData);
        if (!text) return;
        const area = textAreaRef.current?.resizableTextArea?.textArea || event.currentTarget;
        const current = draftRef.current;
        const { next, caret } = insertTextIntoInputElement(area, text, current);
        draftRef.current = next;
        setDraft(next);
        requestAnimationFrame(() => {
            area.focus();
            try {
                area.setSelectionRange(caret, caret);
            } catch {
                // ignore
            }
        });
    };

    return createPortal(
        <div
            data-canvas-shortcuts-ignore
            data-canvas-text-edit-dialog
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onPaste={(event) => {
                // 焦点落在弹窗容器而不是 textarea 时（antd focus trap），仍把文字写进编辑区。
                if (readOnly) return;
                const target = event.target;
                if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
                event.preventDefault();
                event.stopPropagation();
                const text = readClipboardEventText(event.clipboardData);
                if (!text) return;
                const area = textAreaRef.current?.resizableTextArea?.textArea;
                if (!area) {
                    const next = `${draftRef.current}${text}`;
                    draftRef.current = next;
                    setDraft(next);
                    return;
                }
                area.focus();
                const current = draftRef.current;
                const { next, caret } = insertTextIntoInputElement(area, text, current);
                draftRef.current = next;
                setDraft(next);
                requestAnimationFrame(() => {
                    try {
                        area.setSelectionRange(caret, caret);
                    } catch {
                        // ignore
                    }
                });
            }}
            onKeyDown={(event) => findReplace.handleShortcutKeyDown(event)}
        >
            <Modal
                title={title || (readOnly ? t("canvas.chat.viewMessageTitle") : t("canvas.nodeToolbar.editTextTitle"))}
                open={open}
                onCancel={onClose}
                onOk={readOnly ? onClose : handleSave}
                okText={readOnly ? t("common.close") : t("common.save")}
                cancelText={t("common.cancel")}
                centered
                width={readOnly ? 900 : 720}
                zIndex={4000}
                destroyOnHidden
                getContainer={false}
                mask={{ closable: true }}
                afterOpenChange={(visible) => {
                    if (!visible) return;
                    // 打开后强制聚焦编辑区，避免 Ctrl+V 打在 mask/wrap 上。
                    window.setTimeout(() => {
                        const area = textAreaRef.current?.resizableTextArea?.textArea;
                        area?.focus();
                        if (!readOnly && area) {
                            const end = area.value.length;
                            try {
                                area.setSelectionRange(end, end);
                            } catch {
                                // ignore
                            }
                        }
                    }, 0);
                }}
                footer={
                    readOnly
                        ? [
                              <Button key="close" type="primary" onClick={onClose}>
                                  {t("common.close")}
                              </Button>,
                          ]
                        : [
                              <Button key="cancel" onClick={onClose}>
                                  {t("common.cancel")}
                              </Button>,
                              <Button key="save" type="primary" onClick={handleSave}>
                                  {t("common.save")}
                              </Button>,
                          ]
                }
            >
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs text-stone-500">
                        {readOnly ? t("canvas.chat.viewMessageHint") : t("canvas.textPromptLibrary.hint")}
                    </span>
                    <div className="flex items-center gap-2">
                        {findReplace.toggle}
                        <div className="inline-flex items-center gap-0.5 rounded-full border border-stone-200 px-1 py-0.5 dark:border-stone-700">
                            <button
                                type="button"
                                className="grid size-6 place-items-center rounded-full opacity-80 transition hover:opacity-100 disabled:opacity-35"
                                disabled={resolvedFontSize <= MIN_FONT_SIZE}
                                title={t("canvas.nodeToolbar.decreaseFont")}
                                aria-label={t("canvas.nodeToolbar.decreaseFont")}
                                onClick={() => adjustFontSize(-FONT_SIZE_STEP)}
                            >
                                <Minus className="size-3" />
                            </button>
                            <span className="min-w-7 text-center text-[10px] font-medium tabular-nums opacity-70">{resolvedFontSize}</span>
                            <button
                                type="button"
                                className="grid size-6 place-items-center rounded-full opacity-80 transition hover:opacity-100 disabled:opacity-35"
                                disabled={resolvedFontSize >= MAX_FONT_SIZE}
                                title={t("canvas.nodeToolbar.increaseFont")}
                                aria-label={t("canvas.nodeToolbar.increaseFont")}
                                onClick={() => adjustFontSize(FONT_SIZE_STEP)}
                            >
                                <Plus className="size-3" />
                            </button>
                        </div>
                        {readOnly ? null : (
                            <CanvasTextPromptPicker size="small" className="inline-flex h-7 items-center gap-1 rounded-full border border-stone-200 px-2.5 text-xs font-medium dark:border-stone-700" onSelect={(prompt) => setDraft(prompt.content)} />
                        )}
                    </div>
                </div>

                {findReplace.panel ? <div className="mb-3">{findReplace.panel}</div> : null}

                <Input.TextArea
                    ref={textAreaRef}
                    value={draft}
                    rows={readOnly ? 22 : 14}
                    autoFocus
                    readOnly={readOnly}
                    placeholder={placeholder || t("canvas.node.editTextPlaceholder")}
                    onChange={readOnly ? undefined : (event) => setDraft(event.target.value)}
                    onCopy={(event) => event.stopPropagation()}
                    onCut={(event) => event.stopPropagation()}
                    onPaste={handlePaste}
                    className={`font-mono ${readOnly ? "cursor-text" : ""}`}
                    style={{ fontSize: `${resolvedFontSize}px`, lineHeight: `${Math.round(resolvedFontSize * 1.55)}px` }}
                    data-canvas-shortcuts-ignore
                    data-canvas-text-input
                />
            </Modal>
        </div>,
        document.body,
    );
}
