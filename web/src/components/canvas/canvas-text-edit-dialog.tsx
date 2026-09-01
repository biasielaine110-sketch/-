import { useEffect, useState } from "react";
import { Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

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

    return (
        <Modal
            title={title || t("canvas.nodeToolbar.editTextTitle")}
            open={open}
            onCancel={onClose}
            onOk={() => {
                onSave(draft);
                onClose();
            }}
            okText={t("common.save")}
            cancelText={t("common.cancel")}
            centered
            width={720}
            destroyOnHidden
        >
            <Input.TextArea
                value={draft}
                rows={14}
                autoFocus
                placeholder={placeholder || t("canvas.node.editTextPlaceholder")}
                onChange={(event) => setDraft(event.target.value)}
                className="font-mono text-sm"
                data-canvas-shortcuts-ignore
                data-canvas-text-input
            />
        </Modal>
    );
}
