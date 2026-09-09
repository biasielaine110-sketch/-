import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal } from "antd";
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
        </div>,
        document.body,
    );
}
