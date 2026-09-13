import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal } from "antd";
import { Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasTextPromptPicker } from "./canvas-text-prompt-picker";

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 48;
const FONT_SIZE_STEP = 2;

type CanvasTextEditDialogProps = {
    open: boolean;
    value: string;
    title?: string;
    placeholder?: string;
    fontSize?: number;
    onFontSizeChange?: (fontSize: number) => void;
    onClose: () => void;
    onSave: (content: string) => void;
};

export function CanvasTextEditDialog({ open, value, title, placeholder, fontSize, onFontSizeChange, onClose, onSave }: CanvasTextEditDialogProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(value);
    const resolvedFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || 14));

    useEffect(() => {
        if (open) setDraft(value);
    }, [open, value]);

    const handleSave = () => {
        onSave(draft);
        onClose();
    };

    const adjustFontSize = (delta: number) => {
        if (!onFontSizeChange) return;
        const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, resolvedFontSize + delta));
        if (next === resolvedFontSize) return;
        onFontSizeChange(next);
    };

    // Portal outside the canvas transform tree so Modal buttons receive clicks correctly.
    return createPortal(
        <div
            data-canvas-shortcuts-ignore
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <Modal
                title={title || t("canvas.nodeToolbar.editTextTitle")}
                open={open}
                onCancel={onClose}
                onOk={handleSave}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                centered
                width={720}
                zIndex={4000}
                destroyOnHidden
                getContainer={false}
                mask={{ closable: true }}
                footer={[
                    <Button key="cancel" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>,
                    <Button key="save" type="primary" onClick={handleSave}>
                        {t("common.save")}
                    </Button>,
                ]}
            >
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs text-stone-500">{t("canvas.textPromptLibrary.hint")}</span>
                    <div className="flex items-center gap-2">
                        {onFontSizeChange ? (
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
                        ) : null}
                        <CanvasTextPromptPicker size="small" className="inline-flex h-7 items-center gap-1 rounded-full border border-stone-200 px-2.5 text-xs font-medium dark:border-stone-700" onSelect={(prompt) => setDraft(prompt.content)} />
                    </div>
                </div>
                <Input.TextArea
                    value={draft}
                    rows={14}
                    autoFocus
                    placeholder={placeholder || t("canvas.node.editTextPlaceholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onCopy={(event) => event.stopPropagation()}
                    onCut={(event) => event.stopPropagation()}
                    onPaste={(event) => event.stopPropagation()}
                    className="font-mono"
                    style={{ fontSize: `${resolvedFontSize}px`, lineHeight: `${Math.round(resolvedFontSize * 1.55)}px` }}
                    data-canvas-shortcuts-ignore
                    data-canvas-text-input
                />
            </Modal>
        </div>,
        document.body,
    );
}
