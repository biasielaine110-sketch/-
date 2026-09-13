import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasTextPromptPicker } from "./canvas-text-prompt-picker";

type CanvasTextEditDialogProps = {
    open: boolean;
    value: string;
    title?: string;
    placeholder?: string;
    onClose: () => void;
    onSave: (content: string) => void;
};

export function CanvasTextEditDialog({ open, value, title, placeholder, onClose, onSave }: CanvasTextEditDialogProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        if (open) setDraft(value);
    }, [open, value]);

    const handleSave = () => {
        onSave(draft);
        onClose();
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
                    <CanvasTextPromptPicker size="small" className="inline-flex h-7 items-center gap-1 rounded-full border border-stone-200 px-2.5 text-xs font-medium dark:border-stone-700" onSelect={(prompt) => setDraft(prompt.content)} />
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
                    className="font-mono text-sm"
                    data-canvas-shortcuts-ignore
                    data-canvas-text-input
                />
            </Modal>
        </div>,
        document.body,
    );
}
