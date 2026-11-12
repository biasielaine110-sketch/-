/**
 * 右键「批量设置视频参数」弹窗：一次改多个视频节点的模型 / 分辨率 / 画面比例（2026-11-13）。
 *
 * 三组控件的默认值都是「保持不变」（空串），所以用户只改其中一项也不会把另外两项重置。
 * 可选档位由调用方按**选区里各节点自己的模型族**算好传进来，这里只负责选。
 */
import { useEffect, useState } from "react";
import { Button, Modal, Select } from "antd";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { VIDEO_BATCH_UNCHANGED, type VideoBatchPatchInput } from "@/lib/canvas/video-batch-settings";

export type CanvasVideoBatchChoice = { value: string; label: string };

export function CanvasVideoBatchDialog({
    open,
    count,
    modelOptions,
    resolutionChoices,
    sizeChoices,
    onClose,
    onApply,
}: {
    open: boolean;
    /** 会被改到的节点数（只算视频节点，且不含正在生成的）。 */
    count: number;
    modelOptions: CanvasVideoBatchChoice[];
    resolutionChoices: CanvasVideoBatchChoice[];
    sizeChoices: CanvasVideoBatchChoice[];
    onClose: () => void;
    onApply: (input: VideoBatchPatchInput) => void;
}) {
    const { t } = useTranslation();
    const [model, setModel] = useState<string>(VIDEO_BATCH_UNCHANGED);
    const [vquality, setVquality] = useState<string>(VIDEO_BATCH_UNCHANGED);
    const [size, setSize] = useState<string>(VIDEO_BATCH_UNCHANGED);

    // 每次打开都从「全都不改」开始：上一次的选择留在弹窗里，用户很容易误以为这次也会应用。
    useEffect(() => {
        if (!open) return;
        setModel(VIDEO_BATCH_UNCHANGED);
        setVquality(VIDEO_BATCH_UNCHANGED);
        setSize(VIDEO_BATCH_UNCHANGED);
    }, [open]);

    const untouched = !model && !vquality && !size;

    return (
        <Modal open={open} onCancel={onClose} footer={null} width={560} centered destroyOnHidden title={t("canvas.videoBatch.title", { count })}>
            <div className="space-y-5 pt-1">
                <p className="text-xs opacity-60">{t("canvas.videoBatch.description")}</p>

                <Field label={t("canvas.videoBatch.model")}>
                    <Select
                        className="w-full"
                        showSearch
                        allowClear
                        value={model || undefined}
                        placeholder={t("canvas.videoBatch.keep")}
                        optionFilterProp="label"
                        options={modelOptions.map((item) => ({ value: item.value, label: item.label }))}
                        onChange={(value) => setModel(value || VIDEO_BATCH_UNCHANGED)}
                    />
                </Field>

                <Field label={t("canvas.videoBatch.resolution")}>
                    <ChoiceRow choices={resolutionChoices} value={vquality} onChange={setVquality} keepLabel={t("canvas.videoBatch.keep")} />
                </Field>

                <Field label={t("canvas.videoBatch.size")}>
                    <ChoiceRow choices={sizeChoices} value={size} onChange={setSize} keepLabel={t("canvas.videoBatch.keep")} />
                </Field>

                <div className="flex items-center justify-between gap-3 border-t pt-4" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                    <span className="text-xs opacity-55">{untouched ? t("canvas.videoBatch.needOne") : t("canvas.videoBatch.applyHint", { count })}</span>
                    <div className="flex gap-2">
                        <Button onClick={onClose}>{t("canvas.videoBatch.cancel")}</Button>
                        <Button type="primary" icon={<Check className="size-4" />} disabled={untouched || count < 1} onClick={() => onApply({ model, vquality, size })}>
                            {t("canvas.videoBatch.apply")}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-xs font-medium opacity-70">{label}</div>
            {children}
        </div>
    );
}

/** 一排可选档位 + 一个显式的「保持不变」。 */
function ChoiceRow({ choices, value, onChange, keepLabel }: { choices: CanvasVideoBatchChoice[]; value: string; onChange: (next: string) => void; keepLabel: string }) {
    if (!choices.length) return <div className="text-xs opacity-50">—</div>;
    return (
        <div className="flex flex-wrap gap-1.5">
            <Pill active={value === VIDEO_BATCH_UNCHANGED} onClick={() => onChange(VIDEO_BATCH_UNCHANGED)}>
                {keepLabel}
            </Pill>
            {choices.map((item) => (
                <Pill key={item.value} active={value === item.value} onClick={() => onChange(item.value)}>
                    {item.label}
                </Pill>
            ))}
        </div>
    );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`h-7 rounded-full border px-3 text-xs transition ${active ? "border-sky-500 bg-sky-500/10 text-sky-600" : "border-black/10 opacity-70 hover:opacity-100"}`}
        >
            {children}
        </button>
    );
}
