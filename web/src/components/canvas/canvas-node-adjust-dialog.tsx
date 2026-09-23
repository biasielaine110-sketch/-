import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Slider } from "antd";
import { RotateCcw, SlidersHorizontal, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DEFAULT_IMAGE_ADJUST_PARAMS, type ImageAdjustParams } from "@/lib/canvas/canvas-image-data";

type AdjustKey = keyof ImageAdjustParams;

type AdjustSlider = {
    key: AdjustKey;
    min: number;
    max: number;
    step: number;
    neutral: number;
    mark: number;
};

const SLIDERS: AdjustSlider[] = [
    { key: "saturation", min: 0, max: 200, step: 1, neutral: 100, mark: 100 },
    { key: "contrast", min: 0, max: 200, step: 1, neutral: 100, mark: 100 },
    { key: "exposure", min: 0, max: 200, step: 1, neutral: 100, mark: 100 },
    { key: "glow", min: 0, max: 100, step: 1, neutral: 0, mark: 0 },
];

export function CanvasNodeAdjustDialog({
    dataUrl,
    open,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    onClose: () => void;
    onConfirm: (params: ImageAdjustParams) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const [params, setParams] = useState<ImageAdjustParams>({ ...DEFAULT_IMAGE_ADJUST_PARAMS });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setParams({ ...DEFAULT_IMAGE_ADJUST_PARAMS });
        setBusy(false);
    }, [open, dataUrl]);

    const previewFilter = useMemo(() => {
        const saturation = params.saturation / 100;
        const contrast = params.contrast / 100;
        const exposure = params.exposure / 100;
        return `saturate(${saturation}) contrast(${contrast}) brightness(${exposure})`;
    }, [params.saturation, params.contrast, params.exposure]);

    const isDefault = useMemo(() => {
        return SLIDERS.every((slider) => params[slider.key] === DEFAULT_IMAGE_ADJUST_PARAMS[slider.key]);
    }, [params]);

    const setValue = (key: AdjustKey, value: number) => setParams((current) => ({ ...current, [key]: value }));

    const reset = () => setParams({ ...DEFAULT_IMAGE_ADJUST_PARAMS });

    const apply = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await onConfirm(params);
        } finally {
            setBusy(false);
        }
    };

    const labelFor = (key: AdjustKey) => t(`canvas.editors.adjust${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    const hintFor = (key: AdjustKey) => t(`canvas.editors.adjust${key.charAt(0).toUpperCase()}${key.slice(1)}Hint`);

    return (
        <Modal title={null} open={open} onCancel={() => (!busy ? onClose() : undefined)} footer={null} width={620} centered destroyOnHidden maskClosable={!busy}>
            <div className="space-y-5">
                <div className="flex items-start gap-3">
                    <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-black/5 text-neutral-600">
                        <SlidersHorizontal className="size-5" />
                    </div>
                    <div>
                        <h2 className="text-xl font-semibold">{t("canvas.editors.adjustTitle")}</h2>
                        <p className="mt-1 text-sm opacity-55">{t("canvas.editors.adjustHint")}</p>
                    </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                    {/* Live preview */}
                    <div className="grid min-h-[260px] place-items-center overflow-hidden rounded-xl border bg-[repeating-conic-gradient(#00000008_0%_25%,transparent_0%_50%)] [background-size:16px_16px] p-3">
                        {dataUrl ? (
                            <div className="relative max-h-[320px] w-full">
                                <img
                                    src={dataUrl}
                                    alt=""
                                    className="mx-auto block max-h-[320px] max-w-full rounded-lg object-contain shadow-sm"
                                    style={{ filter: `${previewFilter}${buildGlowFilter(params.glow) ? ` ${buildGlowFilter(params.glow)}` : ""}` }}
                                    draggable={false}
                                />
                            </div>
                        ) : null}
                    </div>

                    {/* Sliders */}
                    <div className="flex flex-col justify-center gap-4">
                        {SLIDERS.map((slider) => (
                            <div key={slider.key}>
                                <div className="mb-1 flex items-center justify-between text-xs">
                                    <span className="font-medium opacity-75">{labelFor(slider.key)}</span>
                                    <span className="tabular-nums opacity-60">{params[slider.key]}</span>
                                </div>
                                <Slider
                                    min={slider.min}
                                    max={slider.max}
                                    step={slider.step}
                                    value={params[slider.key]}
                                    disabled={busy}
                                    marks={{ [slider.mark]: { label: "" } }}
                                    tooltip={{ formatter: (value) => `${value}` }}
                                    onChange={(value) => setValue(slider.key, value)}
                                />
                                <p className="text-[11px] leading-4 opacity-45">{hintFor(slider.key)}</p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                    <Button icon={<RotateCcw className="size-4" />} disabled={busy || isDefault} onClick={reset}>
                        {t("canvas.editors.reset")}
                    </Button>
                    <div className="flex gap-2">
                        <Button disabled={busy} onClick={onClose}>
                            {t("canvas.editors.cancel")}
                        </Button>
                        <Button type="primary" icon={<Wand2 className="size-4" />} loading={busy} onClick={() => void apply()}>
                            {t("canvas.editors.adjustApply")}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function buildGlowFilter(glow: number) {
    if (!glow) return "";
    return `brightness(${(1 + (glow / 100) * 0.35).toFixed(3)})`;
}
