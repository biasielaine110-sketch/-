import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Modal } from "antd";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasStylePicker } from "@/components/canvas/canvas-style-picker";
import { CanvasSizePicker } from "@/components/canvas/canvas-size-picker";
import { ModelPicker } from "@/components/model-picker";
import { resolveStoryScriptImageSize } from "@/constant/story-script";
import { defaultScriptAssetBatchSelection, groupScriptAssetBatchItems, type ScriptAssetBatchItem } from "@/lib/canvas/script-asset-batch";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";

/**
 * 脚本节点「一键批量生成资产图」的勾选弹窗。
 *
 * 只干一件事：**让用户说清楚哪些不生成**，然后把这批候选交回上层。
 *  - 顶部：全选 / 全不选 + 按分类一键只选这一类（角色 / 场景 / 道具 / 人物站位）；
 *  - 列表：按分类分组，每条一个勾选框 —— 取消勾选就是「这个不生」；
 *  - 已经出过图的条目标「已有」并默认不勾，避免重复花钱。
 *
 * 与「添加资产」弹窗一样用 antd Modal：画布浮层会被自身的 pointerdown 吞掉（见项目备忘）。
 */
export type CanvasScriptBatchAssetDialogProps = {
    open: boolean;
    theme: CanvasTheme;
    items: ScriptAssetBatchItem[];
    /** 生图比例（空 = 跟随全局），与「添加资产」共用 `metadata.scriptImageSize`。 */
    imageSize?: string;
    onImageSizeChange?: (size: string) => void;
    onCancel: () => void;
    /** 交回本次要生成的资产 + 本次挑的风格 / 比例 / 模型。 */
    onSubmit: (items: ScriptAssetBatchItem[], options: { styleTemplateId?: string; size?: string; model?: string }) => void;
};

export function CanvasScriptBatchAssetDialog({ open, theme, items, imageSize, onImageSizeChange, onCancel, onSubmit }: CanvasScriptBatchAssetDialogProps) {
    const { t } = useTranslation();
    const globalConfig = useConfigStore((state) => state.config);
    const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
    const [styleId, setStyleId] = useState("");
    const [size, setSize] = useState("");
    /** 整批共用的生图模型：默认值 = **配置偏好里的「默认生图模型」**（打开弹窗就填好）。 */
    const [model, setModel] = useState("");
    /**
     * 这一次弹窗里用户有没有**真的动过**模型栏。
     *
     * 动过 → 把这一个模型写进每张图的 `metadata.model`（这一批就定死它）；
     * 没动 → 提交时不写，节点继续走运行时回落，也就是**以后改偏好还能跟着变**。
     * 不加这个标记就只有两种坏选择：写死（改偏好不再跟随）或留空（弹窗里看起来没默认值）。
     */
    const [modelTouched, setModelTouched] = useState(false);
    /** 风格面板展开时先让 Esc 收起面板，而不是一次把弹窗关掉。 */
    const [styleOpen, setStyleOpen] = useState(false);

    const groups = useMemo(() => groupScriptAssetBatchItems(items), [items]);
    const roles = useMemo(() => groups.map((group) => group.role), [groups]);
    const checked = useMemo(() => new Set(checkedKeys), [checkedKeys]);
    const selected = useMemo(() => items.filter((item) => checked.has(item.key)), [checked, items]);

    // 每次打开都重置：默认只勾「还没有图」的那几条，并回到节点存的生图比例。
    useEffect(() => {
        if (!open) {
            setCheckedKeys([]);
            setStyleId("");
            setStyleOpen(false);
            setModel("");
            setModelTouched(false);
            return;
        }
        setCheckedKeys(defaultScriptAssetBatchSelection(items));
        setStyleId("");
        setStyleOpen(false);
        // 模型默认值 = 配置偏好「默认模型 → 默认生图模型」那一项（与偏好面板显示的同一个值）。
        // 打开弹窗就填好它，用户不动就是它；不动时提交不写 `metadata.model`，改偏好以后仍然跟随。
        setModel(resolveModelForCapability(globalConfig, undefined, "image"));
        setModelTouched(false);
        setSize(resolveStoryScriptImageSize(imageSize));
        // items / imageSize 在打开瞬间才是「这一次」的值；开着的时候不跟着外部变化重置，否则会把勾选清掉。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const keysOfRole = (role: string) => items.filter((item) => item.role === role).map((item) => item.key);

    const toggle = (key: string) => setCheckedKeys((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));

    /** 点分类胶囊 = 「只生这一类」（再点同一类取消）。这正是用户说的「按类型批量生哪一个类型」。 */
    const pickRoleOnly = (role: string) => {
        const keys = keysOfRole(role);
        const allChecked = keys.length > 0 && keys.every((key) => checked.has(key));
        setCheckedKeys(allChecked ? [] : keys);
    };

    const toggleGroup = (role: string) => {
        const keys = keysOfRole(role);
        const allChecked = keys.length > 0 && keys.every((key) => checked.has(key));
        setCheckedKeys((prev) => (allChecked ? prev.filter((key) => !keys.includes(key)) : Array.from(new Set([...prev, ...keys]))));
    };

    return (
        <Modal
            open={open}
            onCancel={onCancel}
            title={t("canvas.scriptNode.batchAssetTitle")}
            footer={null}
            width={600}
            centered
            keyboard={!styleOpen}
            // 勾选状态是用户一条条点出来的，点遮罩就关掉会白点一次 —— 只让「取消 / 生成」关窗。
            maskClosable={false}
        >
            <div className="flex flex-col gap-2.5 pt-1">
                <div className="text-[12px] leading-relaxed opacity-70">{t("canvas.scriptNode.batchAssetIntro")}</div>

                {items.length ? (
                    <>
                        {/* 快速选择：全选 / 全不选，再按分类只生一类。 */}
                        <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: theme.node.text }}>
                            <button
                                type="button"
                                className="cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition"
                                style={{ borderColor: theme.node.stroke }}
                                onClick={() => setCheckedKeys(items.map((item) => item.key))}
                            >
                                {t("canvas.scriptNode.batchAssetSelectAll")}
                            </button>
                            <button
                                type="button"
                                className="cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition"
                                style={{ borderColor: theme.node.stroke }}
                                onClick={() => setCheckedKeys([])}
                            >
                                {t("canvas.scriptNode.batchAssetSelectNone")}
                            </button>
                            <span className="mx-1 opacity-30">|</span>
                            {roles.map((role) => {
                                const keys = keysOfRole(role);
                                const active = keys.length > 0 && keys.every((key) => checked.has(key));
                                return (
                                    <button
                                        key={role}
                                        type="button"
                                        className="cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition"
                                        style={{
                                            borderColor: active ? theme.toolbar.activeText : theme.node.stroke,
                                            background: active ? theme.toolbar.activeText : "transparent",
                                            color: active ? theme.toolbar.panel : theme.node.text,
                                        }}
                                        title={t("canvas.scriptNode.batchAssetRoleHint", { role: t(`canvas.scriptNode.assetRole_${role}`) })}
                                        onClick={() => pickRoleOnly(role)}
                                    >
                                        {t(`canvas.scriptNode.assetRole_${role}`)} {items.filter((item) => item.role === role).length}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="thin-scrollbar flex max-h-[360px] flex-col gap-2 overflow-auto pr-0.5">
                            {groups.map((group) => {
                                const keys = group.items.map((item) => item.key);
                                const allChecked = keys.every((key) => checked.has(key));
                                const someChecked = keys.some((key) => checked.has(key));
                                return (
                                    <div key={group.role} className="rounded-lg border px-2.5 py-2" style={{ borderColor: theme.node.stroke }}>
                                        <div className="flex items-center justify-between gap-2 pb-1">
                                            <span className="text-[12px] font-medium" style={{ color: theme.node.text }}>
                                                {t(`canvas.scriptNode.assetRole_${group.role}`)}
                                                <span className="ml-1 opacity-50">
                                                    {keys.filter((key) => checked.has(key)).length}/{keys.length}
                                                </span>
                                            </span>
                                            <button type="button" className="cursor-pointer text-[11px] underline-offset-2 hover:underline" style={{ color: theme.toolbar.activeText, opacity: 0.85 }} onClick={() => toggleGroup(group.role)}>
                                                {allChecked ? t("canvas.scriptNode.batchAssetGroupNone") : t("canvas.scriptNode.batchAssetGroupAll")}
                                            </button>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            {group.items.map((item) => {
                                                const active = checked.has(item.key);
                                                const missing = item.existingNodeIds.length === 0;
                                                return (
                                                    <label
                                                        key={item.key}
                                                        className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 transition"
                                                        style={{ background: active ? `${theme.toolbar.activeText}12` : "transparent", color: theme.node.text }}
                                                        title={item.prompt}
                                                    >
                                                        <Checkbox checked={active} className="mt-0.5 shrink-0" onChange={() => toggle(item.key)} />
                                                        <span className="min-w-0 flex-1 truncate text-[12px]">{item.title}</span>
                                                        <span
                                                            className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
                                                            style={{
                                                                borderColor: missing ? theme.node.stroke : theme.toolbar.activeText,
                                                                color: missing ? theme.node.text : theme.toolbar.activeText,
                                                                opacity: missing ? 0.45 : 0.9,
                                                            }}
                                                        >
                                                            {missing ? t("canvas.scriptNode.batchAssetNew") : t("canvas.scriptNode.batchAssetExisting")}
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* 生图模型：整批共用一个 —— 同一批资产用同一个模型，出图风格才一致。
                            默认值取自「配置偏好 → 默认生图模型」，打开就是它；没动过就不写进节点，
                            以后改偏好还能跟着变（见 `modelTouched`）。 */}
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] opacity-60" style={{ color: theme.node.text }}>
                                {t("canvas.scriptNode.batchAssetModelLabel")}
                                <span className="ml-1.5 opacity-70">· {t("canvas.scriptNode.batchAssetModelHint")}</span>
                            </span>
                            <ModelPicker
                                config={globalConfig}
                                value={resolveModelForCapability(globalConfig, model, "image") || undefined}
                                onChange={(next) => {
                                    setModel(next);
                                    setModelTouched(true);
                                }}
                                capability="image"
                                placeholder={t("canvas.scriptNode.batchAssetModelPlaceholder")}
                                onMissingConfig={() => void 0}
                                fullWidth
                            />
                        </div>

                        {/* 风格 / 比例：整批共用一套，保证一批资产看起来是一套（与「添加资产」同一个落点）。 */}
                        <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                            <span className="text-[11px] opacity-60">{t("canvas.scriptNode.assetGenStyleLabel")}</span>
                            <CanvasStylePicker value={styleId || undefined} onChange={(next) => setStyleId(next || "")} onOpenChange={setStyleOpen} placement="topLeft" />
                            <span className="ml-1 text-[11px] opacity-60">{t("canvas.scriptNode.assetGenSizeLabel")}</span>
                            <CanvasSizePicker
                                value={size || "auto"}
                                className="w-[120px]"
                                onChange={(next) => {
                                    const normalized = resolveStoryScriptImageSize(next);
                                    setSize(normalized);
                                    onImageSizeChange?.(normalized);
                                }}
                            />
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-1">
                            <span className="text-[11px] opacity-60" style={{ color: theme.node.text }}>
                                {t("canvas.scriptNode.batchAssetSelected", { selected: selected.length, total: items.length })}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button size="small" onClick={onCancel}>
                                    {t("common.cancel")}
                                </Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    icon={<Sparkles className="size-3.5" />}
                                    disabled={!selected.length}
                                    onClick={() =>
                                        onSubmit(selected, {
                                            styleTemplateId: styleId || undefined,
                                            size: size || undefined,
                                            // 只有用户真动过模型栏才写进节点；没动过留空 = 继续跟随配置偏好。
                                            model: modelTouched ? model || undefined : undefined,
                                        })
                                    }
                                >
                                    {t("canvas.scriptNode.batchAssetRun", { count: selected.length })}
                                </Button>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="rounded-lg border border-dashed px-3 py-8 text-center text-[12px] opacity-55" style={{ borderColor: theme.node.stroke }}>
                        {t("canvas.scriptNode.batchAssetEmpty")}
                    </div>
                )}
            </div>
        </Modal>
    );
}
