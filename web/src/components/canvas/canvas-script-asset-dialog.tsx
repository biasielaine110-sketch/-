import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { Checkbox, Input, Modal, Tabs } from "antd";
import { FileText, Image as ImageIcon, Link2, Music2, Sparkles, Upload, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { collectScriptAssetPromptCandidates, SCRIPT_ASSET_GENERATABLE_ROLE_IDS, SCRIPT_ASSET_ROLE_IDS, type ScriptAssetRole, type StoryScriptRow } from "@/constant/story-script";
import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * 脚本节点的「添加资产」弹窗：三条路都收敛到「把素材变成脚本节点的上游」。
 *  - 从画布链接：勾选画布上已有的图片 / 视频 / 音频 / 文本节点，确认后补连线；
 *  - 上传文件：选本地图片 / 视频 / 音频，**也可以直接把文件拖进弹窗或粘贴进来**，上传后建节点 + 连线；
 *  - AI 生成：手上没有图时，用分镜表里的资产描述（角色卡 / 场景 / 道具 / 人物站位）当提示词直接生成一张图，
 *    生成完自动建节点、连线，并归到所选分类。**音频不能在这里生成**（这条路走的是生图链路）。
 *
 * 顺带负责**资产分类**（角色 / 场景 / 道具 / 站位图 / 音频）：分类在勾选时就地选，随连线一起写进
 * `metadata.scriptAssetRoles`，铺链路时决定这张素材连到哪些节点（角色按名字逐镜匹配到图片节点，
 * 场景 / 道具 / 站位图逐镜全连图片节点，音频只直连视频节点）。
 *
 * 用 antd Modal 是刻意的：画布的浮层会被自身的 pointerdown 吞掉（见项目备忘），
 * 而 Modal 是独立 portal，不受影响，也省掉自己写「点外部关闭」的活。
 */
export type ScriptAssetCandidate = {
    id: string;
    title: string;
    kind: "image" | "video" | "audio" | "text";
    /** 图片才有的缩略图 */
    previewUrl?: string;
};

/** 一次链接：素材节点 id + 它被分到的类别。 */
export type ScriptAssetLinkSelection = { nodeId: string; role: ScriptAssetRole };

type CanvasScriptAssetDialogProps = {
    open: boolean;
    theme: CanvasTheme;
    candidates: ScriptAssetCandidate[];
    /** 分镜表当前的行：用来抽「按描述生图」的候选提示词（角色卡 / 场景标签）。 */
    rows?: StoryScriptRow[];
    onClose: () => void;
    onLink: (links: ScriptAssetLinkSelection[]) => void;
    onImport: (files: File[], role: ScriptAssetRole) => void;
    /** 用描述直接生成一张资产图：上层负责建节点、连线、写分类并触发生成。 */
    onGenerate?: (role: ScriptAssetRole, prompt: string, title: string) => void;
};

/** 图片 / 视频 / 音频素材可以参与分类；文本节点（剧本）没有「角色 / 场景 / 道具 / 音频」的概念。 */
const isClassifiable = (kind: ScriptAssetCandidate["kind"]) => kind === "image" || kind === "video" || kind === "audio";

/** 上传 / 拖拽 / 粘贴时只认图片、视频、音频文件。 */
const isAssetFile = (file: File) => file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/");

export function CanvasScriptAssetDialog({ open, theme, candidates, rows, onClose, onLink, onImport, onGenerate }: CanvasScriptAssetDialogProps) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    const [roleById, setRoleById] = useState<Record<string, ScriptAssetRole>>({});
    /** 本次「新素材」（上传 / 拖拽 / 粘贴 / 生成）归到哪一类。 */
    const [uploadRole, setUploadRole] = useState<ScriptAssetRole>("character");
    const [genRole, setGenRole] = useState<ScriptAssetRole>("character");
    const [genPrompt, setGenPrompt] = useState("");
    const [genTitle, setGenTitle] = useState("");
    const [dragging, setDragging] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    // 关掉就清空：下次打开不该继承上一次的勾选、分类与草稿。
    useEffect(() => {
        if (open) return;
        setSelected([]);
        setRoleById({});
        setUploadRole("character");
        setGenRole("character");
        setGenPrompt("");
        setGenTitle("");
        setDragging(false);
    }, [open]);

    // 候选集变了（别的节点被删/被连走）时，把已经不存在的勾选摘掉。
    useEffect(() => {
        const valid = new Set(candidates.map((item) => item.id));
        setSelected((prev) => prev.filter((id) => valid.has(id)));
    }, [candidates]);

    /**
     * 粘贴截图直接导入。挂 window 而**不是**弹窗 DOM：antd 的 focus trap 把焦点放在弹窗容器上，
     * 而容器是我这层 div 的**祖先**——事件只向上冒泡，挂在自己身上的 onPaste 收不到。
     * 只处理带文件的粘贴，纯文本粘贴照常落进输入框。
     */
    useEffect(() => {
        if (!open) return;
        const handlePaste = (event: ClipboardEvent) => {
            const media = Array.from(event.clipboardData?.files || []).filter(isAssetFile);
            if (!media.length) return;
            event.preventDefault();
            onImport(media, uploadRole);
            onClose();
        };
        window.addEventListener("paste", handlePaste, true);
        return () => window.removeEventListener("paste", handlePaste, true);
    }, [open, uploadRole, onImport, onClose]);

    /** 分镜表里该类资产的描述候选（角色 = 角色卡；场景 = 场景名 + 场景描述；道具 = 道具名 + 道具描述；站位图 = 人物站位）。 */
    const descriptionCandidates = useMemo(() => collectScriptAssetPromptCandidates(genRole, rows), [genRole, rows]);

    const allSelected = candidates.length > 0 && selected.length === candidates.length;
    const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
    // 默认分类：音频素材自动归「音频」（它只连视频节点），其余新素材默认「角色」（与旧行为一致）。
    const roleOf = (id: string) => roleById[id] || (candidates.some((item) => item.id === id && item.kind === "audio") ? "audio" : "character");

    const kindIcon = (kind: ScriptAssetCandidate["kind"]) =>
        kind === "video" ? (
            <Video className="size-4" />
        ) : kind === "audio" ? (
            <Music2 className="size-4" />
        ) : kind === "text" ? (
            <FileText className="size-4" />
        ) : (
            <ImageIcon className="size-4" />
        );

    const subtleButton = "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition disabled:opacity-35";

    /**
     * 分类胶囊组。刻意**不用 antd Select**：它的下拉是独立 portal，容易被外层的 pointerdown
     * 捕获当成「点外部」而误关（见项目备忘），四个胶囊直接排开最稳。
     */
    const roleChips = (current: ScriptAssetRole, onPick: (role: ScriptAssetRole) => void, ids: ScriptAssetRole[] = SCRIPT_ASSET_ROLE_IDS, disabled = false) => (
        <div className="flex flex-wrap items-center gap-1">
            {ids.map((role) => {
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

    // 拖文件到弹窗任意位置都会按 uploadRole 直接导入。
    const dropZone = {
        onDragOver: (event: ReactDragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (!dragging) setDragging(true);
        },
        onDragLeave: (event: ReactDragEvent) => {
            // 子元素之间移动也会触发 dragleave，指针还在弹窗内就不算离开。
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
        },
        onDrop: (event: ReactDragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            const files = Array.from(event.dataTransfer?.files || []).filter(isAssetFile);
            if (!files.length) return;
            onImport(files, uploadRole);
            onClose();
        },
    };

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
            <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*,audio/*"
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
                style={{
                    borderColor: dragging ? theme.toolbar.activeBg : theme.node.stroke,
                    color: theme.node.text,
                    background: dragging ? `${theme.toolbar.activeBg}14` : `${theme.node.fill}80`,
                }}
                onClick={() => fileRef.current?.click()}
            >
                <Upload className="size-5" />
                {t("canvas.scriptNode.assetChooseFile")}
                <span className="text-[11px] opacity-60">{t("canvas.scriptNode.assetDropHint")}</span>
            </button>
        </div>
    );

    const generateTab = (
        <div className="flex flex-col gap-2.5">
            <div className="text-[12px] opacity-65">{t("canvas.scriptNode.assetGenHint")}</div>
            <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                <span className="opacity-60">{t("canvas.scriptNode.assetRoleLabel")}</span>
                {roleChips(genRole, setGenRole, SCRIPT_ASSET_GENERATABLE_ROLE_IDS)}
            </div>
            {descriptionCandidates.length ? (
                <div className="flex flex-col gap-1.5">
                    <div className="text-[11px] opacity-60">{t("canvas.scriptNode.assetGenFromTable")}</div>
                    <div className="thin-scrollbar flex max-h-[132px] flex-wrap gap-1.5 overflow-auto pr-0.5">
                        {descriptionCandidates.map((item, index) => {
                            const active = genTitle === item.title && genPrompt === item.prompt;
                            return (
                                <span
                                    key={`${index}-${item.title}`}
                                    role="button"
                                    tabIndex={0}
                                    className="max-w-[220px] cursor-pointer truncate rounded-full border px-2.5 py-1 text-[11px] transition"
                                    title={item.prompt}
                                    style={{
                                        borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                                        background: active ? `${theme.toolbar.activeBg}26` : "transparent",
                                        color: active ? theme.toolbar.activeBg : theme.node.text,
                                        opacity: active ? 1 : 0.75,
                                    }}
                                    onClick={() => {
                                        setGenPrompt(item.prompt);
                                        setGenTitle(item.title);
                                    }}
                                >
                                    {item.title}
                                </span>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div className="text-[11px] opacity-50">{t("canvas.scriptNode.assetGenNoCandidate")}</div>
            )}
            <div className="flex flex-col gap-1">
                <span className="text-[11px] opacity-60" style={{ color: theme.node.text }}>
                    {t("canvas.scriptNode.assetGenPromptLabel")}
                </span>
                <Input.TextArea
                    value={genPrompt}
                    onChange={(event) => setGenPrompt(event.target.value)}
                    autoSize={{ minRows: 3, maxRows: 6 }}
                    placeholder={t("canvas.scriptNode.assetGenPromptPlaceholder")}
                />
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-[11px] opacity-60" style={{ color: theme.node.text }}>
                    {t("canvas.scriptNode.assetGenTitleLabel")}
                </span>
                <Input value={genTitle} onChange={(event) => setGenTitle(event.target.value)} placeholder={t("canvas.scriptNode.assetGenTitlePlaceholder")} />
            </div>
            <div className="flex items-center justify-end">
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium text-white transition disabled:opacity-35"
                    style={{ background: theme.toolbar.activeBg }}
                    disabled={!genPrompt.trim()}
                    onClick={() => {
                        const prompt = genPrompt.trim();
                        if (!prompt) return;
                        onGenerate?.(genRole, prompt, genTitle.trim() || prompt.slice(0, 24));
                        onClose();
                    }}
                >
                    <Sparkles className="size-3.5" />
                    {t("canvas.scriptNode.assetGenRun")}
                </button>
            </div>
        </div>
    );

    const tabs = [
        { key: "canvas", label: t("canvas.scriptNode.assetTabCanvas"), children: canvasTab },
        { key: "upload", label: t("canvas.scriptNode.assetTabUpload"), children: uploadTab },
    ];
    if (onGenerate) tabs.push({ key: "generate", label: t("canvas.scriptNode.assetTabGenerate"), children: generateTab });

    return (
        <Modal open={open} onCancel={onClose} title={t("canvas.scriptNode.addAsset")} footer={null} width={560}>
            <div {...dropZone} className="relative">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                    <span className="opacity-60">{t("canvas.scriptNode.assetRoleLabel")}</span>
                    {roleChips(uploadRole, setUploadRole)}
                    <span className="text-[11px] opacity-50">{t("canvas.scriptNode.assetRolePickHint")}</span>
                </div>
                <Tabs items={tabs} />
                {dragging ? (
                    <div
                        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed text-[13px]"
                        style={{ borderColor: theme.toolbar.activeBg, background: `${theme.node.fill}f2`, color: theme.toolbar.activeBg }}
                    >
                        {t("canvas.scriptNode.assetDropActive", { role: t(`canvas.scriptNode.assetRole_${uploadRole}`) })}
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}
