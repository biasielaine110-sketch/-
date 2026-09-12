import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Segmented } from "antd";
import { Scaling } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IMAGE_DISPLAY_SCALE_PERCENTS, fitNodeSize, nearestDisplayScalePercent, sizeFromDisplayScalePercent } from "@/lib/canvas/canvas-node-size";

export function CanvasNodeScaleDialog({
    open,
    nodeWidth,
    nodeHeight,
    naturalWidth,
    naturalHeight,
    onClose,
    onConfirm,
}: {
    open: boolean;
    nodeWidth: number;
    nodeHeight: number;
    naturalWidth?: number;
    naturalHeight?: number;
    onClose: () => void;
    onConfirm: (percent: number) => void;
}) {
    const { t } = useTranslation();
    const sourceWidth = Math.max(1, naturalWidth || nodeWidth);
    const sourceHeight = Math.max(1, naturalHeight || nodeHeight);
    const base = useMemo(() => fitNodeSize(sourceWidth, sourceHeight), [sourceWidth, sourceHeight]);
    const currentPercent = useMemo(() => nearestDisplayScalePercent(nodeWidth, nodeHeight, sourceWidth, sourceHeight), [nodeWidth, nodeHeight, sourceWidth, sourceHeight]);
    const [percent, setPercent] = useState<number>(currentPercent);
    const output = useMemo(() => sizeFromDisplayScalePercent(sourceWidth, sourceHeight, percent), [sourceWidth, sourceHeight, percent]);

    useEffect(() => {
        if (!open) return;
        setPercent(currentPercent);
    }, [open, currentPercent]);

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={520} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.scaleTitle")}</h2>
                    <p className="mt-1 text-sm opacity-55">{t("canvas.editors.scaleHint")}</p>
                </div>

                <div className="space-y-2">
                    <div className="font-medium opacity-75">{t("canvas.editors.scalePercent")}</div>
                    <Segmented
                        block
                        value={percent}
                        options={IMAGE_DISPLAY_SCALE_PERCENTS.map((value) => ({ label: `${value}%`, value }))}
                        onChange={(value) => setPercent(Number(value))}
                    />
                </div>

                <div className="rounded-xl border px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                        <span className="opacity-60">{t("canvas.editors.scaleCurrent")}</span>
                        <span className="font-semibold">
                            {Math.round(nodeWidth)} × {Math.round(nodeHeight)} · {currentPercent}%
                        </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="opacity-60">{t("canvas.editors.scaleBase")}</span>
                        <span className="font-semibold">
                            {Math.round(base.width)} × {Math.round(base.height)} · 100%
                        </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="opacity-60">{t("canvas.editors.scaleResult")}</span>
                        <span className="font-semibold">
                            {Math.round(output.width)} × {Math.round(output.height)} · {percent}%
                        </span>
                    </div>
                </div>

                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>{t("canvas.editors.cancel")}</Button>
                    <Button type="primary" icon={<Scaling className="size-4" />} onClick={() => onConfirm(percent)}>
                        {t("canvas.editors.scaleApply")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
