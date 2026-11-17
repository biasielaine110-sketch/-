/**
 * 右键「批量设置图片参数」弹窗：一次改多个图片节点的模型 / 画幅比例 / 分辨率 / 风格
 * （2026-11-16 用户要求：「选择多个图片节点，也需要能够像视频节点一样可以右键弹出批量编辑按钮，
 * 这几个图片的使用模型，画幅比例，分辨率等。以及风格选择」）。
 *
 * 所有控件的默认值都是「保持不变」（空串），所以用户只改其中一项也不会把另外几项重置。
 *
 * 档位与节点自己的设置面板**同一份来源**：
 *  - 画幅 / 分辨率 = `imageAspectOptions` / `imageQualityOptions`（`components/image-settings-panel.tsx`）；
 *  - 风格 = `getAllStyleTemplates()`（内置 + 自定义，分类分组）。
 *
 * 🔴 图片侧不做「换模型就换档位」：`ImageSettingsPanel` 本身就不随模型改档（muse 也只是多一行
 * 提示语），批量里如果按模型把档位筛掉，会出现「面板里能选、批量里选不到」的分裂。
 * 视频那边要联动是因为各家 workflow 的分辨率白名单真的不一样。
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Select } from "antd";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { imageAspectOptions, imageQualityOptions } from "@/components/image-settings-panel";
import { getAllStyleTemplates, getStyleTemplateCategories } from "@/constant/style-templates";
import { IMAGE_BATCH_STYLE_CLEAR, IMAGE_BATCH_UNCHANGED, type ImageBatchPatchInput } from "@/lib/canvas/image-batch-settings";

export type CanvasImageBatchChoice = { value: string; label: string };

export function CanvasImageBatchDialog({
    open,
    count,
    modelOptions,
    onClose,
    onApply,
}: {
    open: boolean;
    /** 会被改到的节点数（只算图片节点，且不含正在生成的）。 */
    count: number;
    modelOptions: CanvasImageBatchChoice[];
    onClose: () => void;
    onApply: (input: ImageBatchPatchInput) => void;
}) {
    const { t } = useTranslation();
    const [model, setModel] = useState<string>(IMAGE_BATCH_UNCHANGED);
    const [size, setSize] = useState<string>(IMAGE_BATCH_UNCHANGED);
    const [quality, setQuality] = useState<string>(IMAGE_BATCH_UNCHANGED);
    const [styleTemplateId, setStyleTemplateId] = useState<string>(IMAGE_BATCH_UNCHANGED);

    // 每次打开都从「全都不改」开始：上一次的选择留在弹窗里，用户很容易误以为这次也会应用。
    useEffect(() => {
        if (!open) return;
        setModel(IMAGE_BATCH_UNCHANGED);
        setSize(IMAGE_BATCH_UNCHANGED);
        setQuality(IMAGE_BATCH_UNCHANGED);
        setStyleTemplateId(IMAGE_BATCH_UNCHANGED);
    }, [open]);

    /**
     * 画幅 / 分辨率档位：直接把设置面板那一份搬过来（`value` 已经是写进 `metadata.size` 的形式，
     * 例如 2K 档是 `2048x2048` 而不是 `1:1-2k`）。
     */
    const sizeChoices = useMemo<CanvasImageBatchChoice[]>(() => imageAspectOptions.map((item) => ({ value: item.value, label: item.label })), []);
    const qualityChoices = useMemo<CanvasImageBatchChoice[]>(() => imageQualityOptions.map((item) => ({ value: item.value, label: item.label })), []);

    /**
     * 风格下拉：分类分组（与风格面板同一套分类顺序），最上面一行是显式的「不使用风格」
     * （放在最前面 —— 它是最常用的一项，用户批量清理时不用翻到底）。
     * 内联 `getAllStyleTemplates()` 而不是从外面传：它是同步读注册表的纯函数，自定义模板增删后
     * 每次开弹窗都能拿到最新的，没有「父层 memo 住旧列表」的问题。
     */
    const styleOptions = useMemo(() => {
        const groups = getStyleTemplateCategories();
        const templates = getAllStyleTemplates();
        const clearOption = { value: IMAGE_BATCH_STYLE_CLEAR, label: t("canvas.imageBatch.styleNone") };
        const grouped = groups
            .map((category) => {
                const items = templates.filter((item) => item.category === category).map((item) => ({ value: item.id, label: item.label }));
                return items.length ? { label: category, options: items } : null;
            })
            .filter((group): group is { label: string; options: Array<{ value: string; label: string }> } => Boolean(group));
        // 分类表里没登记的（理论上不该有，自定义模板会自动进「我的风格」）别丢掉：另开一组兜底。
        const known = new Set(groups);
        const orphans = templates
            .filter((item) => !known.has(item.category))
            .map((item) => ({ value: item.id, label: item.category ? `${item.category} · ${item.label}` : item.label }));
        return [clearOption, ...(orphans.length ? [{ label: t("canvas.imageBatch.styleOther"), options: orphans }] : []), ...grouped];
    }, [t]);

    const untouched = !model && !size && !quality && !styleTemplateId;

    return (
        <Modal open={open} onCancel={onClose} footer={null} width={560} centered destroyOnHidden title={t("canvas.imageBatch.title", { count })}>
            <div className="space-y-5 pt-1">
                <p className="text-xs opacity-60">{t("canvas.imageBatch.description")}</p>

                <Field label={t("canvas.imageBatch.model")}>
                    <Select
                        className="w-full"
                        showSearch
                        allowClear
                        value={model || undefined}
                        placeholder={t("canvas.imageBatch.keep")}
                        optionFilterProp="label"
                        options={modelOptions.map((item) => ({ value: item.value, label: item.label }))}
                        onChange={(value) => setModel(value || IMAGE_BATCH_UNCHANGED)}
                    />
                </Field>

                <Field label={t("canvas.imageBatch.size")}>
                    <ChoiceRow choices={sizeChoices} value={size} onChange={setSize} keepLabel={t("canvas.imageBatch.keep")} />
                </Field>

                <Field label={t("canvas.imageBatch.quality")}>
                    <ChoiceRow choices={qualityChoices} value={quality} onChange={setQuality} keepLabel={t("canvas.imageBatch.keep")} />
                </Field>

                <Field label={t("canvas.imageBatch.style")} hint={t("canvas.imageBatch.styleHint")}>
                    <Select
                        className="w-full"
                        showSearch
                        allowClear
                        value={styleTemplateId || undefined}
                        placeholder={t("canvas.imageBatch.keep")}
                        options={styleOptions}
                        // 分组行（有子 options）永远保留，只按叶子 label 过滤 —— 否则搜索时整组会消失。
                        filterOption={(input, option) => {
                            if (!option || !("value" in option) || !option.value) return true;
                            return String(option.label ?? "").toLowerCase().includes(input.trim().toLowerCase());
                        }}
                        onChange={(value) => setStyleTemplateId(value || IMAGE_BATCH_UNCHANGED)}
                    />
                </Field>

                <div className="flex items-center justify-between gap-3 border-t pt-4" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                    <span className="text-xs opacity-55">{untouched ? t("canvas.imageBatch.needOne") : t("canvas.imageBatch.applyHint", { count })}</span>
                    <div className="flex gap-2">
                        <Button onClick={onClose}>{t("canvas.imageBatch.cancel")}</Button>
                        <Button type="primary" icon={<Check className="size-4" />} disabled={untouched || count < 1} onClick={() => onApply({ model, size, quality, styleTemplateId })}>
                            {t("canvas.imageBatch.apply")}
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
function ChoiceRow({ choices, value, onChange, keepLabel }: { choices: CanvasImageBatchChoice[]; value: string; onChange: (next: string) => void; keepLabel: string }) {
    if (!choices.length) return <div className="text-xs opacity-50">—</div>;
    return (
        <div className="flex flex-wrap gap-1.5">
            <Pill active={value === IMAGE_BATCH_UNCHANGED} onClick={() => onChange(IMAGE_BATCH_UNCHANGED)}>
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
