import { useEffect, useState } from "react";
import { Button, Modal, Segmented } from "antd";
import { useTranslation } from "react-i18next";

const indices = [1, 2, 3, 4] as const;

export function CanvasNodeMjUpscaleDialog({
    open,
    previewUrl,
    defaultIndex = 1,
    onClose,
    onConfirm,
}: {
    open: boolean;
    previewUrl?: string;
    defaultIndex?: number;
    onClose: () => void;
    onConfirm: (index: number) => void;
}) {
    const { t } = useTranslation();
    const [index, setIndex] = useState(1);

    useEffect(() => {
        if (!open) return;
        setIndex(Math.max(1, Math.min(4, Math.floor(defaultIndex) || 1)));
    }, [open, defaultIndex]);

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={520} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.mjUpscaleTitle")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.editors.mjUpscaleHint")}</p>
                </div>
                {previewUrl ? (
                    <div className="grid min-h-[220px] place-items-center rounded-xl border bg-black/5 p-3">
                        <img src={previewUrl} alt="" className="max-h-[260px] max-w-full rounded-lg object-contain" draggable={false} />
                    </div>
                ) : null}
                <div className="space-y-2">
                    <div className="font-medium opacity-75">{t("canvas.editors.mjUpscaleIndex")}</div>
                    <Segmented block value={index} options={indices.map((value) => ({ label: `U${value}`, value }))} onChange={(value) => setIndex(Number(value))} />
                </div>
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={() => onConfirm(index)}>
                        {t("canvas.editors.mjUpscaleConfirm", { index })}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
