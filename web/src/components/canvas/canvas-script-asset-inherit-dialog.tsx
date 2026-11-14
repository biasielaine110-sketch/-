import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Modal } from "antd";
import { CopyPlus, Link2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ScriptAssetRole } from "@/constant/story-script";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { SCRIPT_ASSET_INHERIT_DEFAULT_OPTIONS, type ScriptAssetInheritOptions, type ScriptAssetInheritSource } from "@/lib/canvas/script-asset-inherit";

/**
 * 脚本节点「沿用资产」弹窗：把**上一集**的资产（图 + 资产名锁 + 自建列 + 可选出片参数）搬到本集。
 *
 * 为什么不自动「全带」：一套剧里第二集常常只留主角、换掉配角 / 场景。全带的结果是资产池里
 * 躺着一堆这一集根本不会用到的图，铺链路按分类模糊匹配时反而更容易连错。所以：
 *  - 先选「从哪一集沿用」（画布上其它脚本节点，按位置从左到右 = 大概率第一集排最前）；
 *  - 再逐张勾资产（默认全勾，已经连到本集的标「已连接」、仍可勾 —— 那张图的名字锁可能还是新的）；
 *  - 三档范围（资产图 / 资产名锁 / 自建列）默认全开，出片参数默认关（不该静默改掉第二集的设置）。
 *
 * 用 antd Modal 是刻意的：画布浮层会被自身的 pointerdown 吞掉（见项目备忘）。
 */
export type CanvasScriptAssetInheritDialogProps = {
    open: boolean;
    theme: CanvasTheme;
    /** 画布上其它脚本节点（已经算好各自可沿用的资产）。 */
    sources: ScriptAssetInheritSource[];
    /** 当前节点记着的来源（上次选的 / 自动沿用的那一集）。 */
    defaultSourceId?: string;
    /** 自动沿用开关当前值。 */
    auto: boolean;
    onCancel: () => void;
    onConfirm: (payload: { sourceId: string; assetNodeIds: string[]; options: ScriptAssetInheritOptions; auto: boolean }) => void;
};

/** 资产分类的展示顺序（与资产池、铺链路的连线段位一致）。 */
const ROLE_ORDER: ScriptAssetRole[] = ["character", "scene", "prop", "blocking", "audio"];

export function CanvasScriptAssetInheritDialog({ open, theme, sources, defaultSourceId, auto, onCancel, onConfirm }: CanvasScriptAssetInheritDialogProps) {
    const { t } = useTranslation();
    const [sourceId, setSourceId] = useState("");
    const [pickedIds, setPickedIds] = useState<string[]>([]);
    const [options, setOptions] = useState<ScriptAssetInheritOptions>(SCRIPT_ASSET_INHERIT_DEFAULT_OPTIONS);
    const [autoInherit, setAutoInherit] = useState(false);

    const source = useMemo(() => sources.find((item) => item.nodeId === sourceId) || null, [sourceId, sources]);
    const picked = useMemo(() => new Set(pickedIds), [pickedIds]);

    // 每次打开都重置草稿：来源优先用节点上记着的那个（还在画布上才算数），否则取最左边的脚本节点。
    useEffect(() => {
        if (!open) return;
        const preferred = sources.find((item) => item.nodeId === defaultSourceId) || sources[0] || null;
        setSourceId(preferred?.nodeId || "");
        setPickedIds(preferred ? preferred.assets.filter((asset) => !asset.linked || asset.names.length).map((asset) => asset.nodeId) : []);
        setOptions(SCRIPT_ASSET_INHERIT_DEFAULT_OPTIONS);
        setAutoInherit(Boolean(auto));
        // 只在「打开」这一瞬间取一次；开着的时候 sources 变化（比如别处删了节点）不该清掉勾选。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const pickSource = (next: ScriptAssetInheritSource) => {
        setSourceId(next.nodeId);
        setPickedIds(next.assets.filter((asset) => !asset.linked || asset.names.length).map((asset) => asset.nodeId));
    };

    const groups = useMemo(() => {
        const list = source?.assets || [];
        return ROLE_ORDER.map((role) => ({ role, items: list.filter((item) => item.role === role) })).filter((group) => group.items.length);
    }, [source]);

    const toggle = (nodeId: string) => setPickedIds((prev) => (prev.includes(nodeId) ? prev.filter((item) => item !== nodeId) : [...prev, nodeId]));
    const toggleGroup = (role: ScriptAssetRole) => {
        const ids = (source?.assets || []).filter((item) => item.role === role).map((item) => item.nodeId);
        const all = ids.length > 0 && ids.every((id) => picked.has(id));
        setPickedIds((prev) => (all ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))));
    };

    const flip = (key: keyof ScriptAssetInheritOptions) => setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

    /** 三档范围的按钮：选中态才显示对勾，未选态留空位，切换时不跳字。 */
    const optionChip = (key: keyof ScriptAssetInheritOptions, label: string, hint: string, disabled = false) => {
        const active = options[key];
        return (
            <button
                type="button"
                key={key}
                disabled={disabled}
                className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-35"
                style={{
                    borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                    background: active ? `${theme.toolbar.activeBg}14` : "transparent",
                    color: theme.node.text,
                }}
                onClick={() => flip(key)}
                title={hint}
            >
                <span
                    className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded border text-[10px] leading-none"
                    style={{ borderColor: active ? theme.toolbar.activeBg : theme.node.stroke, background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.panel : undefined }}
                >
                    {active ? "✓" : ""}
                </span>
                <span className="flex min-w-0 flex-col">
                    <span className="text-[12px] font-medium">{label}</span>
                    <span className="text-[11px] leading-snug opacity-60">{hint}</span>
                </span>
            </button>
        );
    };

    const totalLocks = (source?.assets || []).reduce((sum, asset) => sum + asset.names.length, 0);
    const canConfirm = Boolean(source) && (options.columns || options.output || pickedIds.length > 0);

    return (
        <Modal
            open={open}
            onCancel={onCancel}
            title={t("canvas.scriptNode.inheritTitle")}
            footer={null}
            width={640}
            centered
            maskClosable={false}
        >
            <div className="flex flex-col gap-2.5 pt-1">
                <div className="text-[12px] leading-relaxed opacity-70">{t("canvas.scriptNode.inheritIntro")}</div>

                {sources.length ? (
                    <>
                        {/* ① 从哪一集沿用 */}
                        <div className="flex flex-col gap-1">
                            <div className="text-[11px] font-medium opacity-60">{t("canvas.scriptNode.inheritSourceLabel")}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {sources.map((item) => {
                                    const active = item.nodeId === sourceId;
                                    return (
                                        <button
                                            key={item.nodeId}
                                            type="button"
                                            className="flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition"
                                            style={{
                                                borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                                                background: active ? `${theme.toolbar.activeBg}1f` : "transparent",
                                                color: active ? theme.toolbar.activeBg : theme.node.text,
                                            }}
                                            onClick={() => pickSource(item)}
                                        >
                                            <CopyPlus className="size-3" />
                                            <span className="max-w-40 truncate">{item.title}</span>
                                            <span className="opacity-60">
                                                {t("canvas.scriptNode.inheritSourceMeta", { shots: item.shotCount, assets: item.assets.length })}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* ② 沿用什么 */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {optionChip("assets", t("canvas.scriptNode.inheritOptAssets"), t("canvas.scriptNode.inheritOptAssetsHint"))}
                            {optionChip("locks", t("canvas.scriptNode.inheritOptLocks"), t("canvas.scriptNode.inheritOptLocksHint", { count: totalLocks }))}
                            {optionChip("columns", t("canvas.scriptNode.inheritOptColumns"), t("canvas.scriptNode.inheritOptColumnsHint", { count: source?.extraColumns.length || 0 }), !(source?.extraColumns.length))}
                            {optionChip("output", t("canvas.scriptNode.inheritOptOutput"), t("canvas.scriptNode.inheritOptOutputHint"), !source?.hasOutput)}
                        </div>

                        {/* ③ 逐张挑资产 */}
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium opacity-60">{t("canvas.scriptNode.inheritAssetsLabel", { count: pickedIds.length, total: source?.assets.length || 0 })}</span>
                                <span className="flex items-center gap-1.5 text-[11px]">
                                    <button type="button" className="cursor-pointer rounded-full border px-2 py-0.5 transition" style={{ borderColor: theme.node.stroke }} onClick={() => setPickedIds((source?.assets || []).map((asset) => asset.nodeId))}>
                                        {t("canvas.scriptNode.inheritSelectAll")}
                                    </button>
                                    <button type="button" className="cursor-pointer rounded-full border px-2 py-0.5 transition" style={{ borderColor: theme.node.stroke }} onClick={() => setPickedIds([])}>
                                        {t("canvas.scriptNode.inheritSelectNone")}
                                    </button>
                                </span>
                            </div>
                            <div className="max-h-56 overflow-y-auto rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
                                {groups.length ? (
                                    groups.map((group) => (
                                        <div key={group.role} className="mb-1.5 last:mb-0">
                                            <button
                                                type="button"
                                                className="mb-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition"
                                                style={{ background: `${theme.toolbar.activeBg}14`, color: theme.toolbar.activeBg }}
                                                onClick={() => toggleGroup(group.role)}
                                                title={t("canvas.scriptNode.inheritGroupToggle")}
                                            >
                                                {t(`canvas.scriptNode.assetRole_${group.role}`)}
                                                <span className="opacity-60">{group.items.length}</span>
                                            </button>
                                            <div className="flex flex-col gap-0.5">
                                                {group.items.map((asset) => {
                                                    const active = picked.has(asset.nodeId);
                                                    return (
                                                        <label
                                                            key={asset.nodeId}
                                                            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12px] transition hover:bg-black/5"
                                                            style={{ color: theme.node.text }}
                                                        >
                                                            <Checkbox checked={active} onChange={() => toggle(asset.nodeId)} />
                                                            {asset.previewUrl ? (
                                                                <img src={asset.previewUrl} alt="" className="size-7 shrink-0 rounded object-cover" style={{ border: `1px solid ${theme.node.stroke}` }} />
                                                            ) : (
                                                                <span className="flex size-7 shrink-0 items-center justify-center rounded opacity-40" style={{ border: `1px dashed ${theme.node.stroke}` }}>
                                                                    <Link2 className="size-3" />
                                                                </span>
                                                            )}
                                                            <span className="max-w-48 truncate">{asset.title}</span>
                                                            {asset.names.length ? (
                                                                <span className="truncate rounded px-1 text-[10px]" style={{ background: `${theme.toolbar.activeBg}14`, color: theme.toolbar.activeBg }} title={asset.names.join("、")}>
                                                                    {asset.names.join("、")}
                                                                </span>
                                                            ) : null}
                                                            {asset.linked ? <span className="ml-auto shrink-0 text-[10px] opacity-50">{t("canvas.scriptNode.inheritAssetLinked")}</span> : null}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="py-3 text-center text-[12px] opacity-55">{t("canvas.scriptNode.inheritAssetsEmpty")}</div>
                                )}
                            </div>
                        </div>

                        {/* ④ 自动沿用 */}
                        <label className="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5" style={{ borderColor: autoInherit ? theme.toolbar.activeBg : theme.node.stroke }}>
                            <Checkbox checked={autoInherit} onChange={(event) => setAutoInherit(event.target.checked)} />
                            <span className="flex flex-col">
                                <span className="text-[12px] font-medium">{t("canvas.scriptNode.inheritAuto")}</span>
                                <span className="text-[11px] leading-snug opacity-60">{t("canvas.scriptNode.inheritAutoHint")}</span>
                            </span>
                        </label>

                        <div className="flex items-center justify-end gap-2 pt-1">
                            <Button onClick={onCancel}>{t("common.cancel")}</Button>
                            <Button
                                type="primary"
                                disabled={!canConfirm}
                                onClick={() => {
                                    if (!source) return;
                                    onConfirm({ sourceId: source.nodeId, assetNodeIds: options.assets ? pickedIds : [], options, auto: autoInherit });
                                }}
                            >
                                {t("canvas.scriptNode.inheritConfirm")}
                            </Button>
                        </div>
                    </>
                ) : (
                    <div className="flex flex-col items-center gap-1 py-6 text-[12px] opacity-60">
                        <Loader2 className="size-4 animate-spin opacity-40" />
                        {t("canvas.scriptNode.inheritNoSource")}
                    </div>
                )}
            </div>
        </Modal>
    );
}
