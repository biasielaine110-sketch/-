import { useEffect, useState } from "react";
import { Button, Input, Modal, Typography } from "antd";
import { FolderOpen, Save } from "lucide-react";
import { useTranslation } from "react-i18next";

import { safeDraftFileName, supportsFileSystemAccess } from "@/lib/canvas/canvas-draft";

type CanvasDraftSaveDialogProps = {
    open: boolean;
    defaultName: string;
    selectedFileName?: string;
    saving?: boolean;
    onClose: () => void;
    onPickPath: (draftName: string) => void | Promise<void>;
    onConfirm: (draftName: string) => void | Promise<void>;
};

export function CanvasDraftSaveDialog({ open, defaultName, selectedFileName, saving, onClose, onPickPath, onConfirm }: CanvasDraftSaveDialogProps) {
    const { t } = useTranslation();
    const [draftName, setDraftName] = useState(defaultName);
    const canUseFs = supportsFileSystemAccess();

    useEffect(() => {
        if (open) setDraftName(defaultName);
    }, [defaultName, open]);

    const normalizedName = safeDraftFileName(draftName);

    return (
        <Modal
            title={t("canvas.draft.title")}
            open={open}
            onCancel={onClose}
            footer={null}
            centered
            width={480}
            destroyOnHidden
            data-canvas-shortcuts-ignore
        >
            <div className="space-y-4" data-canvas-shortcuts-ignore>
                <Typography.Paragraph type="secondary" className="!mb-0 text-sm">
                    {t("canvas.draft.description")}
                </Typography.Paragraph>

                <div className="space-y-1.5">
                    <div className="text-xs font-medium opacity-70">{t("canvas.draft.nameLabel")}</div>
                    <Input
                        value={draftName}
                        placeholder={t("canvas.draft.namePlaceholder")}
                        onChange={(event) => setDraftName(event.target.value)}
                        onPressEnter={() => {
                            if (!saving && draftName.trim()) void onConfirm(draftName);
                        }}
                        autoFocus
                        data-canvas-text-input
                    />
                    <div className="text-[11px] opacity-50">{t("canvas.draft.filePreview", { name: normalizedName })}</div>
                </div>

                <div className="space-y-1.5">
                    <div className="text-xs font-medium opacity-70">{t("canvas.draft.pathLabel")}</div>
                    {canUseFs ? (
                        <div className="flex items-center gap-2">
                            <Button icon={<FolderOpen className="size-4" />} onClick={() => void onPickPath(draftName)} disabled={saving || !draftName.trim()}>
                                {t("canvas.draft.pickPath")}
                            </Button>
                            <span className="min-w-0 truncate text-xs opacity-70">{selectedFileName || t("canvas.draft.pathUnset")}</span>
                        </div>
                    ) : (
                        <Typography.Text type="secondary" className="text-xs">
                            {t("canvas.draft.fallbackHint")}
                        </Typography.Text>
                    )}
                </div>

                <Typography.Text type="secondary" className="block text-xs">
                    {t("canvas.draft.autoSaveHint")}
                </Typography.Text>

                <div className="flex justify-end gap-2 pt-1">
                    <Button onClick={onClose} disabled={saving}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        type="primary"
                        icon={<Save className="size-4" />}
                        loading={saving}
                        disabled={!draftName.trim() || (canUseFs && !selectedFileName)}
                        onClick={() => void onConfirm(draftName)}
                    >
                        {t("canvas.draft.save")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
