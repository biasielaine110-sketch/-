import { useEffect, useRef, useState } from "react";
import { Checkbox, Modal, Tabs } from "antd";
import { FileText, Image as ImageIcon, Link2, Upload, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SCRIPT_ASSET_ROLE_IDS, type ScriptAssetRole } from "@/constant/story-script";
import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * 脚本节点的「添加资产」弹窗：两条路都收敛到「把素材变成脚本节点的上游」。
 *  - 从画布链接：勾选画布上已有的图片 / 视频 / 文本节点，确认后补连线；
 *  - 上传文件：选本地图片 / 视频，交给上层上传后建节点 + 连线。
 *
 * 顺带负责**资产分类**（角色 / 场景 / 道具 / 站位图）：分类在勾选时就地选，随连线一起写进
 * `metadata.scriptAssetRoles`，铺链路时决定这张图连到哪些镜（角色按名字逐镜匹配，其余逐镜全连）。
 *
 * 用 antd Modal 是刻意的：画布的浮层会被自身的 pointerdown 吞掉（见项目备忘），
 * 而 Modal 是独立 portal，不受影响，也省掉自己写「点外部关闭」的活。
 */
export type ScriptAssetCandidate = {
    id: string;
    title: string;
    kind: "image" | "video" | "text";
    /** 图片才有的缩略图 */
    previewUrl?: string;
};

/** 一次链接：素材节点 id + 它被分到的类别。 */
export type ScriptAssetLinkSelection = { nodeId: string; role: ScriptAssetRole };

type CanvasScriptAssetDialogProps = {
    open: boolean;
    theme: CanvasTheme;
    candidates: ScriptAssetCandidate[];
    onClose: () => void;
    onLink: (links: ScriptAssetLinkSelection[]) => void;
    onImport: (files: File[], role: ScriptAssetRole) => void;
};

/** 只有图片 / 视频素材参与分类；文本节点（剧本）没有「角色 / 场景 / 道具」的概念。 */
const isClassifiable = (kind: ScriptAssetCandidate["kind"]) => kind === "image" || kind === "video";

export function CanvasScriptAssetDialog({ open, theme, candidates, onClose, onLink, onImport }: CanvasScriptAssetDialogProps) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    const [roleById, setRoleById] = useState<Record<string, ScriptAssetRole>>({});
    const [uploadRole, setUploadRole] = useState<ScriptAssetRole>("character");
    const fileRef = useRef<HTMLInputElement>(null);

    // 关掉就清空选择：下次打开不该继承上一次的勾选与分类。
    useEffect(() => {
        if (!open) {
            setSelected([]);
            setRoleById({});
            setUploadRole("character");
        }
    }, [open]);

    // 候选集变了（别的节点被删/被连走）时，把已经不存在的勾选摘掉。
    useEffect(() => {
        const valid = new Set(candidates.map((item) => item.id));
        setSelected((prev) => prev.filter((id) => valid.has(id)));
    }, [candidates]);

    const allSelected = candidates.length > 0 && selected.length === candidates.length;
    const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
    const roleOf = (id: string) => roleById[id] || "character";

    const kindIcon = (kind: ScriptAssetCandidate["kind"]) =>
        kind === "video" ? <Video className="size-4" /> : kind === "text" ? <FileText className="size-4" /> : <ImageIcon className="size-4" />;

    const subtleButton = "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition disabled:opacity-35";

    /**
     * 分类胶囊组。刻意**不用 antd Select**：它的下拉是独立 portal，容易被外层的 pointerdown
     * 捕获当成「点外部」而误关（见项目备忘），四个胶囊直接排开最稳。
     */
    const roleChips = (current: ScriptAssetRole, onPick: (role: ScriptAssetRole) => void, disabled = false) => (
        <div className="flex flex-wrap items-center gap-1">
            {SCRIPT_ASSET_ROLE_IDS.map((role) => {
                const active = role === current;
                return (
                    <span
                        key={role}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition"
                        style={{
                            borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                            background: active ? `${theme.toolbar.activeBg}26` : "transparent",
                            color: active ? theme.toolbar.activeBg : theme.node.text,
                            opacity: disabled ? 0.45 : active ? 1 : 0.7,
                        }}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (disabled) return;
                            onPick(role);
                        }}
                    >
                        {t(`canvas.scriptNode.assetRole_${role}`)}
                    </span>
                );
            })}
        </div>
    );

    const canvasTab = (
        <div className="flex flex-col gap-2">
            <div className="text-[12px] opacity-65">{t("canvas.scriptNode.assetPickHint")}</div>
            <div className="text-[11px] opacity-55">{t("canvas.scriptNode.assetRolePickHint")}</div>
            <div className="thin-scrollbar flex max-h-[320px] flex-col gap-1.5 overflow-auto pr-0.5">
                {candidates.length ? (
                    candidates.map((item) => {
                        const active = selected.includes(item.id);
                        return (
                            <div
                                key={item.id}
                                className="flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2 py-1.5 transition"
                                style={{
                                    borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                                    background: active ? `${theme.toolbar.activeBg}1f` : "transparent",
                                    color: theme.node.text,
                                }}
                                onClick={() => toggle(item.id)}
                            >
                                <div className="flex items-center gap-2">
                                    <Checkbox checked={active} className="pointer-events-none" />
                                    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke }}>
                                        {item.previewUrl ? <img src={item.previewUrl} alt={item.title} className="size-full object-cover" /> : kindIcon(item.kind)}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                                </div>
                                {active && isClassifiable(item.kind) ? roleChips(roleOf(item.id), (role) => setRoleById((prev) => ({ ...prev, [item.id]: role }))) : null}
                            </div>
                        );
                    })
                ) : (
                    <div className="rounded-lg border border-dashed px-3 py-6 text-center text-[12px] opacity-55" style={{ borderColor: theme.node.stroke }}>
                        {t("canvas.scriptNode.assetEmpty")}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    className={subtleButton}
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    disabled={!candidates.length}
                    onClick={() => setSelected(allSelected ? [] : candidates.map((item) => item.id))}
                >
                    {allSelected ? t("canvas.scriptNode.assetClear") : t("canvas.scriptNode.assetSelectAll")}
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium text-white transition disabled:opacity-35"
                    style={{ background: theme.toolbar.activeBg }}
                    disabled={!selected.length}
                    onClick={() => {
                        onLink(selected.map((nodeId) => ({ nodeId, role: roleOf(nodeId) })));
                        onClose();
                    }}
                >
                    <Link2 className="size-3.5" />
                    {t("canvas.scriptNode.assetLinkSelected", { count: selected.length })}
                </button>
            </div>
        </div>
    );

    const uploadTab = (
        <div className="flex flex-col gap-2.5">
            <div className="text-[12px] opacity-65">{t("canvas.scriptNode.assetUploadHint")}</div>
            <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                <span className="opacity-60">{t("canvas.scriptNode.assetRoleLabel")}</span>
                {roleChips(uploadRole, setUploadRole)}
            </div>
            <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    // 先清空 value，否则连续两次选同一个文件不会触发 change。
                    event.target.value = "";
                    if (!files.length) return;
                    onImport(files, uploadRole);
                    onClose();
                }}
            />
            <button
                type="button"
                className="inline-flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-10 text-[13px] transition"
                style={{ borderColor: theme.node.stroke, color: theme.node.text, background: `${theme.node.fill}80` }}
                onClick={() => fileRef.current?.click()}
            >
                <Upload className="size-5" />
                {t("canvas.scriptNode.assetChooseFile")}
            </button>
        </div>
    );

    return (
        <Modal open={open} onCancel={onClose} title={t("canvas.scriptNode.addAsset")} footer={null} width={520}>
            <Tabs
                items={[
                    { key: "canvas", label: t("canvas.scriptNode.assetTabCanvas"), children: canvasTab },
                    { key: "upload", label: t("canvas.scriptNode.assetTabUpload"), children: uploadTab },
                ]}
            />
        </Modal>
    );
}
