/**
 * 右键「批量设置视频参数」弹窗：一次改多个视频节点的模型 / 分辨率 / 画面比例（2026-11-13）。
 *
 * 三组控件的默认值都是「保持不变」（空串），所以用户只改其中一项也不会把另外两项重置。
 *
 * 档位有两个来源：
 *  - 没选模型时 = 调用方按**选区里各节点自己的模型族**算好的并集（混选时至少能看到一部分节点支持的档位）；
 *  - 选了模型时 = 用 `choicesForModel` 按**这个模型**重算（用户点名要求：「选了不同模型，要把它相关的
 *    分辨率规则一起带过来」）。切换模型后，上一个模型才有的档位会被自动退回「保持不变」，
 *    否则会出现「模型是聚算的、分辨率还挂着 relay 的 2K」这种提交时被静默收掉的组合。
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Select } from "antd";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { VIDEO_BATCH_UNCHANGED, type VideoBatchPatchInput } from "@/lib/canvas/video-batch-settings";

export type CanvasVideoBatchChoice = { value: string; label: string };

/** 某个模型下可选的档位；返回 `null` 表示「这个模型没有专属规则，沿用并集」。 */
export type CanvasVideoBatchChoicesForModel = (model: string) => { resolutions: CanvasVideoBatchChoice[]; sizes: CanvasVideoBatchChoice[] } | null;

export function CanvasVideoBatchDialog({
    open,
    count,
    modelOptions,
    resolutionChoices,
    sizeChoices,
    choicesForModel,
    onClose,
    onApply,
}: {
    open: boolean;
    /** 会被改到的节点数（只算视频节点，且不含正在生成的）。 */
    count: number;
    modelOptions: CanvasVideoBatchChoice[];
    resolutionChoices: CanvasVideoBatchChoice[];
    sizeChoices: CanvasVideoBatchChoice[];
    /** 选了模型后按该模型族重算档位（用户 2026-11-13 的第 2 条要求）。 */
    choicesForModel?: CanvasVideoBatchChoicesForModel;
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

    /** 选中模型后的专属档位；没选模型 / 该模型没有专属规则时退回调用方给的并集。 */
    const followed = useMemo(() => (model ? choicesForModel?.(model) ?? null : null), [choicesForModel, model]);
    const resolutions = followed?.resolutions.length ? followed.resolutions : resolutionChoices;
    const sizes = followed?.sizes.length ? followed.sizes : sizeChoices;

    /**
     * 换模型后把「新模型根本没有的档位」退回「保持不变」。
     *
     * 依赖用拼出来的字符串而不是数组本身：调用方每次渲染都可能给出新数组，
     * 直接依赖数组会让这个 effect 每帧跑一次（虽然 setState 同值会 bail，但没必要）。
     */
    const resolutionKey = resolutions.map((item) => item.value).join("|");
    const sizeKey = sizes.map((item) => item.value).join("|");
    useEffect(() => {
        const allowed = resolutionKey ? new Set(resolutionKey.split("|")) : new Set<string>();
        setVquality((prev) => (prev && !allowed.has(prev) ? VIDEO_BATCH_UNCHANGED : prev));
    }, [resolutionKey]);
    useEffect(() => {
        const allowed = sizeKey ? new Set(sizeKey.split("|")) : new Set<string>();
        setSize((prev) => (prev && !allowed.has(prev) ? VIDEO_BATCH_UNCHANGED : prev));
    }, [sizeKey]);

    const untouched = !model && !vquality && !size;
    const followLabel = model ? modelOptions.find((item) => item.value === model)?.label || model : "";

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

                <Field label={t("canvas.videoBatch.resolution")} hint={followLabel ? t("canvas.videoBatch.followModel", { model: followLabel }) : undefined}>
                    <ChoiceRow choices={resolutions} value={vquality} onChange={setVquality} keepLabel={t("canvas.videoBatch.keep")} />
                </Field>

                <Field label={t("canvas.videoBatch.size")}>
                    <ChoiceRow choices={sizes} value={size} onChange={setSize} keepLabel={t("canvas.videoBatch.keep")} />
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
                <div className="text-xs font-medium opacity-70">{label}</div>
                {hint ? <div className="text-[11px] text-sky-600 opacity-80">{hint}</div> : null}
            </div>
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
