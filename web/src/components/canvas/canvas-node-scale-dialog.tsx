import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Segmented } from "antd";
import { Scaling } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IMAGE_DISPLAY_SCALE_PERCENTS } from "@/lib/canvas/canvas-node-size";

export function CanvasNodeScaleDialog({
    open,
    naturalWidth,
    naturalHeight,
    bytes,
    onClose,
    onConfirm,
}: {
    open: boolean;
    naturalWidth?: number;
    naturalHeight?: number;
    bytes?: number;
    onClose: () => void;
    onConfirm: (percent: number) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const sourceWidth = Math.max(1, naturalWidth || 1);
    const sourceHeight = Math.max(1, naturalHeight || 1);
    const [percent, setPercent] = useState(50);
    const [busy, setBusy] = useState(false);
    const output = useMemo(
        () => ({
            width: Math.max(1, Math.round(sourceWidth * (percent / 100))),
            height: Math.max(1, Math.round(sourceHeight * (percent / 100))),
        }),
        [percent, sourceHeight, sourceWidth],
    );
    const estimatedBytes = useMemo(() => {
        if (!(bytes && bytes > 0) || percent >= 100) return bytes || 0;
        // Rough area-based estimate; JPEG re-encode usually shrinks further.
        return Math.max(1, Math.round(bytes * (percent / 100) * (percent / 100) * 0.85));
    }, [bytes, percent]);

    useEffect(() => {
        if (!open) return;
        setPercent(50);
        setBusy(false);
    }, [open, sourceWidth, sourceHeight]);

    const apply = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await onConfirm(percent);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={null} open={open} onCancel={() => (!busy ? onClose() : undefined)} footer={null} width={520} centered destroyOnHidden maskClosable={!busy}>
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
                        disabled={busy}
                        options={IMAGE_DISPLAY_SCALE_PERCENTS.map((value) => ({ label: `${value}%`, value }))}
                        onChange={(value) => setPercent(Number(value))}
                    />
                </div>

                <div className="rounded-xl border px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                        <span className="opacity-60">{t("canvas.editors.scaleCurrent")}</span>
                        <span className="font-semibold">
                            {Math.round(sourceWidth)} × {Math.round(sourceHeight)}
                            {bytes ? ` · ${formatBytes(bytes)}` : ""}
                        </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="opacity-60">{t("canvas.editors.scaleResult")}</span>
                        <span className="font-semibold">
                            {output.width} × {output.height}
                            {estimatedBytes ? ` · ≈${formatBytes(estimatedBytes)}` : ""} · {percent}%
                        </span>
                    </div>
                </div>

                <div className="flex justify-end gap-2">
                    <Button disabled={busy} onClick={onClose}>
                        {t("canvas.editors.cancel")}
                    </Button>
                    <Button type="primary" icon={<Scaling className="size-4" />} loading={busy} disabled={percent >= 100} onClick={() => void apply()}>
                        {t("canvas.editors.scaleApply")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function formatBytes(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}
