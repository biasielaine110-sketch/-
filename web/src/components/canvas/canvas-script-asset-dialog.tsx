import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { Checkbox, Input, Modal, Tabs } from "antd";
import { FileText, Image as ImageIcon, Link2, Music2, Sparkles, Upload, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CanvasStylePicker } from "@/components/canvas/canvas-style-picker";
import { collectScriptAssetPromptCandidates, scriptAssetColumnRole, SCRIPT_ASSET_GENERATABLE_ROLE_IDS, SCRIPT_ASSET_ROLE_IDS, type ScriptAssetPromptCandidate, type ScriptAssetRole, type StoryScriptRow } from "@/constant/story-script";
import { resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * 脚本节点的「添加资产」弹窗：三条路都收敛到「把素材变成脚本节点的上游」。
 *  - 从画布链接：勾选画布上已有的图片 / 视频 / 音频 / 文本节点，确认后补连线；
 *  - 上传文件：选本地图片 / 视频 / 音频，**也可以直接把文件拖进弹窗或粘贴进来**，上传后建节点 + 连线；
 *  - AI 生成：手上没有图时，用分镜表里的资产描述（角色卡 / 场景 / 道具 / 人物站位）当提示词直接生成一张图，
 *    生成完自动建节点、连线，并归到所选分类。**还可以挑一个风格提示词**（落成新节点的风格模板，生图时生效）。
 *    **音频不能在这里生成**（这条路走的是生图链路）。
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

/**
 * **资产池**里的一项：已经连到脚本节点的素材（在候选基础上多带一个资产分类）。
 * 「按镜按资产」弹窗的「@ 资产池」tab 用它把池里的图直接挂进某一格（不用重新上传 / 重新连）。
 */
export type ScriptAssetPoolAsset = ScriptAssetCandidate & { role: ScriptAssetRole };

/** 一次链接：素材节点 id + 它被分到的类别。 */
export type ScriptAssetLinkSelection = { nodeId: string; role: ScriptAssetRole };

/**
 * 「逐镜模式」：只给分镜表的**某一行**关联图片（镜头图），不做资产分类。
 * 三条路都收敛到「把这些图片节点作为这一镜的关键帧」，铺链路时连到该镜的图片节点与视频节点。
 */
export type ScriptRowAssetMode = {
    /** 这一镜的镜号（标题与文案用）。 */
    no: number | string;
    /** 打开时预勾选：已经关联到这一镜的图片节点 id。 */
    selectedIds: string[];
    /** 「AI 生成」tab 的预填提示词 / 标题（一般是这一镜的分镜提示词）。 */
    prompt?: string;
    title?: string;
    /**
     * **资产列 key**（`character_1` / `scene` / `prop` / `blocking`）。传了就切到「按镜按资产」模式：
     * 标题写成「第 3 镜 · 场景」，提示文案指向这一格，文案与生成候选都收敛到「这一镜的这一列」。
     */
    columnKey?: string;
    /** 该资产列的显示名（如「场景」「角色1」），仅用于文案。 */
    label?: string;
    /** 「AI 生成」tab 的默认候选（这一镜这一列的名字 + 描述）；没传就回落到 prompt / title。 */
    candidate?: ScriptAssetPromptCandidate | null;
    /** 「AI 生成」tab 里这一格默认用的生图模型（存 metadata.scriptCellImageModel，可随时改）。 */
    model?: string;
    /** 生图模型变更：上层落库成这一格的默认值，下次打开还是它。 */
    onModelChange?: (model: string) => void;
    /**
     * **声音模式**：这一镜只连音频，所以候选只列音频节点、上传只收音频文件、不显示「AI 生成」tab。
     * 文案也整套换成 `rowAudio*`（「第 3 镜 · 声音」），避免出现「为这一镜挑图片」的错位提示。
     */
    audio?: boolean;
    /** 确认：用整组 id 替换这一镜的关联（取消勾选即解绑）。 */
    onLink: (nodeIds: string[]) => void;
    onImport: (files: File[]) => void;
    /** `model` 是本次生成要用的生图模型（不传就跟随节点默认的图片模型）；`styleTemplateId` 是本次生成挑的风格模板。 */
    onGenerate?: (prompt: string, title: string, model?: string, styleTemplateId?: string) => void;
};

type CanvasScriptAssetDialogProps = {
    open: boolean;
    theme: CanvasTheme;
    candidates: ScriptAssetCandidate[];
    /** 分镜表当前的行：用来抽「按描述生图」的候选提示词（角色卡 / 场景标签）。 */
    rows?: StoryScriptRow[];
    onClose: () => void;
    onLink: (links: ScriptAssetLinkSelection[]) => void;
    onImport: (files: File[], role: ScriptAssetRole) => void;
    /** 用描述直接生成一张资产图：上层负责建节点、连线、写分类并触发生成。`styleTemplateId` 会落到新节点的风格上。 */
    onGenerate?: (role: ScriptAssetRole, prompt: string, title: string, styleTemplateId?: string) => void;
    /** **资产池**：已连到脚本节点的素材（带分类）。「按镜按资产」模式下多出一个「@ 资产池」tab。 */
    poolAssets?: ScriptAssetPoolAsset[];
    /** 传了就走「逐镜模式」：只为某一镜关联图片，隐藏分类、勾选即关联。 */
    rowMode?: ScriptRowAssetMode;
};

/** 图片 / 视频 / 音频素材可以参与分类；文本节点（剧本）没有「角色 / 场景 / 道具 / 音频」的概念。 */
const isClassifiable = (kind: ScriptAssetCandidate["kind"]) => kind === "image" || kind === "video" || kind === "audio";

/** 上传 / 拖拽 / 粘贴时只认图片、视频、音频文件。导出给节点本体复用（直接往节点上拖文件）。 */
export const isAssetFile = (file: File) => file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/");

/**
 * 本弹窗这次接受哪些文件：声音模式（`rowMode.audio`）只收音频，其余模式与原来一致。
 *
 * 刻意写成**模块级函数**而不是组件里的 `const`：粘贴 effect 的依赖数组在组件体靠前求值，
 * 引用在其后才声明的 `const` 会踩 TDZ（见项目备忘）。传 `audioOnly` 进来就没有这个先后问题。
 */
const acceptsFile = (file: File, audioOnly: boolean) => (audioOnly ? file.type.startsWith("audio/") : isAssetFile(file));

export function CanvasScriptAssetDialog({ open, theme, candidates, rows, onClose, onLink, onImport, onGenerate, poolAssets, rowMode }: CanvasScriptAssetDialogProps) {
    const { t } = useTranslation();
    const globalConfig = useConfigStore((state) => state.config);
    const [selected, setSelected] = useState<string[]>([]);
    const [roleById, setRoleById] = useState<Record<string, ScriptAssetRole>>({});
    /** 本次「新素材」（上传 / 拖拽 / 粘贴 / 生成）归到哪一类。 */
    const [uploadRole, setUploadRole] = useState<ScriptAssetRole>("character");
    const [genRole, setGenRole] = useState<ScriptAssetRole>("character");
    const [genPrompt, setGenPrompt] = useState("");
    const [genTitle, setGenTitle] = useState("");
    /** 「AI 生成」本次挑的风格模板 id（空 = 不加风格修饰）。落到生成出来的图片节点上，可随时在节点上改。 */
    const [genStyleId, setGenStyleId] = useState("");
    /** 风格选择面板是否展开：展开时先让 Esc 关面板而不是关整个弹窗。 */
    const [genStyleOpen, setGenStyleOpen] = useState(false);
    /** 「按镜按资产」生成时这一格单独挑的生图模型（空 = 跟随节点默认的图片模型）。 */
    const [genModel, setGenModel] = useState("");
    const [dragging, setDragging] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    // 已为「当前打开目标」初始化过草稿的签名：rowMode 每次渲染都是新对象，靠它区分「换了目标」与「重新渲染」。
    const initKeyRef = useRef("");

    // 打开时按模式初始化草稿；关掉就清空，下次打开不继承上一次的勾选与分类。
    useEffect(() => {
        if (!open) {
            initKeyRef.current = "";
            setSelected([]);
            setRoleById({});
            setUploadRole("character");
            setGenRole("character");
            setGenPrompt("");
            setGenTitle("");
            setGenStyleId("");
            setGenStyleOpen(false);
            setGenModel("");
            setDragging(false);
            return;
        }
        const key = rowMode ? `row:${rowMode.no}:${rowMode.columnKey || ""}:${rowMode.selectedIds.join(",")}` : "asset";
        if (initKeyRef.current === key) return;
        initKeyRef.current = key;
        setSelected(rowMode ? rowMode.selectedIds : []);
        setRoleById({});
        setUploadRole("character");
        setGenRole("character");
        // 「按镜按资产」模式优先用这一格自己的候选（第 N 镜的场景描述），没有才回落到整行提示词。
        setGenPrompt(rowMode?.candidate?.prompt || rowMode?.prompt || "");
        setGenTitle(rowMode?.candidate?.title || rowMode?.title || "");
        setGenStyleId("");
        setGenModel(rowMode?.model || "");
        setDragging(false);
    }, [open, rowMode]);

    // 候选集变了（别的节点被删/被连走）时，把已经不存在的勾选摘掉。
    // 内容没变时返回原数组，避免「候选数组每次都是新引用」引发渲染循环。
    useEffect(() => {
        const valid = new Set(candidates.map((item) => item.id));
        setSelected((prev) => {
            const next = prev.filter((id) => valid.has(id));
            return next.length === prev.length ? prev : next;
        });
    }, [candidates]);

    /**
     * 粘贴截图直接导入。挂 window 而**不是**弹窗 DOM：antd 的 focus trap 把焦点放在弹窗容器上，
     * 而容器是我这层 div 的**祖先**——事件只向上冒泡，挂在自己身上的 onPaste 收不到。
     * 只处理带文件的粘贴，纯文本粘贴照常落进输入框。
     */
    useEffect(() => {
        if (!open) return;
        const handlePaste = (event: ClipboardEvent) => {
            const audioOnly = Boolean(rowMode?.audio);
            const media = Array.from(event.clipboardData?.files || []).filter((file) => acceptsFile(file, audioOnly));
            if (!media.length) return;
            event.preventDefault();
            if (rowMode) rowMode.onImport(media);
            else onImport(media, uploadRole);
            onClose();
        };
        window.addEventListener("paste", handlePaste, true);
        return () => window.removeEventListener("paste", handlePaste, true);
    }, [open, uploadRole, onImport, onClose, rowMode]);

    /** 分镜表里该类资产的描述候选（角色 = 角色卡；场景 = 场景名 + 场景描述；道具 = 道具名 + 道具描述；站位图 = 人物站位）。 */
    const descriptionCandidates = useMemo(() => collectScriptAssetPromptCandidates(genRole, rows), [genRole, rows]);
    /** 逐镜模式：只为分镜表的某一行关联图片，不做分类、也不按描述生图。 */
    const isRowMode = Boolean(rowMode);
    /** 声音模式（rowMode 的子形态）：文案与文件过滤都收敛到「音频」。 */
    const isAudioMode = Boolean(rowMode?.audio);
    /** 「按镜按资产」模式：rowMode 带上了资产列，文案与生成候选都收敛到「这一镜的这一格」。 */
    const cellLabel = rowMode?.label || "";
    const isCellMode = Boolean(rowMode?.columnKey && cellLabel);
    /** 文案变量：「第 3 镜」或「第 3 镜 · 场景」。 */
    const targetVars = { no: rowMode?.no ?? "", label: cellLabel };

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
            const files = Array.from(event.dataTransfer?.files || []).filter((file) => acceptsFile(file, isAudioMode));
            if (!files.length) return;
            if (rowMode) rowMode.onImport(files);
            else onImport(files, uploadRole);
            onClose();
        },
    };

    const canvasTab = (
        <div className="flex flex-col gap-2">
            <div className="text-[12px] opacity-65">
                {isAudioMode
                    ? t("canvas.scriptNode.rowAudioPickHint", { no: rowMode?.no ?? "" })
                    : isCellMode
                      ? t("canvas.scriptNode.cellAssetPickHint", targetVars)
                      : isRowMode
                        ? t("canvas.scriptNode.rowImagePickHint", { no: rowMode?.no ?? "" })
                        : t("canvas.scriptNode.assetPickHint")}
            </div>
            {isRowMode ? null : <div className="text-[11px] opacity-55">{t("canvas.scriptNode.assetRolePickHint")}</div>}
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
                                {active && !isRowMode && isClassifiable(item.kind) ? roleChips(roleOf(item.id), (role) => setRoleById((prev) => ({ ...prev, [item.id]: role }))) : null}
                            </div>
                        );
                    })
                ) : (
                    <div className="rounded-lg border border-dashed px-3 py-6 text-center text-[12px] opacity-55" style={{ borderColor: theme.node.stroke }}>
                        {isAudioMode
                            ? t("canvas.scriptNode.rowAudioEmpty")
                            : isRowMode
                              ? t("canvas.scriptNode.rowImageEmpty")
                              : t("canvas.scriptNode.assetEmpty")}
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
                    disabled={!selected.length && !isRowMode}
                    onClick={() => {
                        if (rowMode) rowMode.onLink(selected);
                        else onLink(selected.map((nodeId) => ({ nodeId, role: roleOf(nodeId) })));
                        onClose();
                    }}
                >
                    <Link2 className="size-3.5" />
                    {isRowMode ? t("canvas.scriptNode.rowImageLinkSelected", { count: selected.length }) : t("canvas.scriptNode.assetLinkSelected", { count: selected.length })}
                </button>
            </div>
        </div>
    );

    const uploadTab = (
        <div className="flex flex-col gap-2.5">
            <div className="text-[12px] opacity-65">{isAudioMode ? t("canvas.scriptNode.rowAudioUploadHint") : t("canvas.scriptNode.assetUploadHint")}</div>
            <input
                ref={fileRef}
                type="file"
                // 声音模式只收音频：用户在系统选择器里看不到图片 / 视频，少一次错选。
                accept={isAudioMode ? "audio/*" : "image/*,video/*,audio/*"}
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files || []).filter((file) => acceptsFile(file, isAudioMode));
                    // 先清空 value，否则连续两次选同一个文件不会触发 change。
                    event.target.value = "";
                    if (!files.length) return;
                    // ⚠️ 逐镜模式必须走 `rowMode.onImport`：走外层那个会把音频当成「整表资产」导入，
                    // 结果是文件进来了、这一镜的声音列却还是空的。
                    if (rowMode) rowMode.onImport(files);
                    else onImport(files, uploadRole);
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
            <div className="text-[12px] opacity-65">
                {isCellMode
                    ? t("canvas.scriptNode.cellAssetGenHint", targetVars)
                    : isRowMode
                      ? t("canvas.scriptNode.rowImageGenHint", { no: rowMode?.no ?? "" })
                      : t("canvas.scriptNode.assetGenHint")}
            </div>
            {isRowMode ? null : (
                <>
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
                </>
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
            {/* 风格提示词：选一个风格模板，生成时作为该图的风格修饰，并落到新节点的风格上（节点上还能再改）。 */}
            <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                <span className="text-[11px] opacity-60">{t("canvas.scriptNode.assetGenStyleLabel")}</span>
                <CanvasStylePicker value={genStyleId || undefined} onChange={(next) => setGenStyleId(next || "")} onOpenChange={setGenStyleOpen} placement="topLeft" />
            </div>
            {/* 「按镜按资产」模式：这一格可以单独挑生图模型（同一张表里不同资产用不同模型出图）。 */}
            {isCellMode ? (
                <div className="flex flex-col gap-1">
                    <span className="text-[11px] opacity-60" style={{ color: theme.node.text }}>
                        {t("canvas.scriptNode.cellAssetModelLabel")}
                    </span>
                    <ModelPicker
                        config={globalConfig}
                        value={resolveModelForCapability(globalConfig, genModel || rowMode?.model, "image") || undefined}
                        onChange={(model) => {
                            setGenModel(model);
                            rowMode?.onModelChange?.(model);
                        }}
                        capability="image"
                        placeholder={t("canvas.scriptNode.cellAssetModelPlaceholder")}
                        onMissingConfig={() => void 0}
                        fullWidth
                    />
                </div>
            ) : null}
            <div className="flex items-center justify-end">
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium text-white transition disabled:opacity-35"
                    style={{ background: theme.toolbar.activeBg }}
                    disabled={!genPrompt.trim()}
                    onClick={() => {
                        const prompt = genPrompt.trim();
                        if (!prompt) return;
                        const title = genTitle.trim() || prompt.slice(0, 24);
                        if (rowMode) {
                            const model = resolveModelForCapability(globalConfig, genModel || rowMode.model, "image");
                            rowMode.onGenerate?.(prompt, title, model || undefined, genStyleId || undefined);
                        } else {
                            onGenerate?.(genRole, prompt, title, genStyleId || undefined);
                        }
                        onClose();
                    }}
                >
                    <Sparkles className="size-3.5" />
                    {t("canvas.scriptNode.assetGenRun")}
                </button>
            </div>
        </div>
    );

    /**
     * 「@ 资产池」tab（只在「按镜按资产」模式出现）：罗列**已经连到这个脚本节点**的素材，按当前列的角色优先排列，
     * 点一下就把池里的图挂进这一格 —— 用户不必再去画布上找那张图、也不用重新上传一次。
     * 「全选同类」只挑与这一列角色相同的图（第 3 镜的「场景」格只一键挑场景类）。
     */
    const cellRole = isCellMode ? scriptAssetColumnRole(rowMode?.columnKey) : null;
    const poolList = useMemo(() => {
        const list = poolAssets || [];
        if (!isCellMode) return list;
        // 与当前列同类别的排前面；其余仍然列出（用户可能故意跨类引用），只是弱化显示。
        return [...list].sort((a, b) => Number(b.role === cellRole) - Number(a.role === cellRole));
    }, [cellRole, isCellMode, poolAssets]);

    const poolTab = (
        <div className="flex flex-col gap-2">
            <div className="text-[12px] opacity-65">{t("canvas.scriptNode.cellAssetPoolHint", targetVars)}</div>
            <div className="thin-scrollbar flex max-h-[320px] flex-col gap-1.5 overflow-auto pr-0.5">
                {poolList.length ? (
                    poolList.map((item) => {
                        const active = selected.includes(item.id);
                        const sameRole = item.role === cellRole;
                        return (
                            <div
                                key={item.id}
                                className="flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 transition"
                                style={{
                                    borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                                    background: active ? `${theme.toolbar.activeBg}1f` : "transparent",
                                    color: theme.node.text,
                                    opacity: sameRole ? 1 : 0.55,
                                }}
                                onClick={() => toggle(item.id)}
                            >
                                <Checkbox checked={active} className="pointer-events-none" />
                                <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke }}>
                                    {item.previewUrl ? <img src={item.previewUrl} alt={item.title} className="size-full object-cover" /> : kindIcon(item.kind)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                                <span
                                    className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]"
                                    style={{ borderColor: sameRole ? theme.toolbar.activeBg : theme.node.stroke, color: sameRole ? theme.toolbar.activeBg : theme.node.text }}
                                >
                                    {t(`canvas.scriptNode.assetRole_${item.role}`)}
                                </span>
                            </div>
                        );
                    })
                ) : (
                    <div className="rounded-lg border border-dashed px-3 py-6 text-center text-[12px] opacity-55" style={{ borderColor: theme.node.stroke }}>
                        {t("canvas.scriptNode.cellAssetPoolEmpty")}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    className={subtleButton}
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    disabled={!poolList.some((item) => item.role === cellRole)}
                    onClick={() => setSelected(Array.from(new Set([...selected, ...poolList.filter((item) => item.role === cellRole).map((item) => item.id)])))}
                >
                    {t("canvas.scriptNode.cellAssetPoolSelectRole", { label: cellLabel })}
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium text-white transition disabled:opacity-35"
                    style={{ background: theme.toolbar.activeBg }}
                    disabled={!selected.length}
                    onClick={() => {
                        rowMode?.onLink(selected);
                        onClose();
                    }}
                >
                    <Link2 className="size-3.5" />
                    {t("canvas.scriptNode.cellAssetPoolLink", { count: selected.length })}
                </button>
            </div>
        </div>
    );

    const tabs = [
        { key: "canvas", label: t("canvas.scriptNode.assetTabCanvas"), children: canvasTab },
        { key: "upload", label: t("canvas.scriptNode.assetTabUpload"), children: uploadTab },
    ];
    // 「按镜按资产」模式：把「@ 资产池」放最前面 —— 先把池里的图挂进这一格，是最顺手的入口。
    if (isCellMode) tabs.unshift({ key: "pool", label: t("canvas.scriptNode.cellAssetPoolTab"), children: poolTab });
    const showGenerateTab = isRowMode ? Boolean(rowMode?.onGenerate) : Boolean(onGenerate);
    if (showGenerateTab) tabs.push({ key: "generate", label: t("canvas.scriptNode.assetTabGenerate"), children: generateTab });

    return (
        <Modal
            open={open}
            onCancel={onClose}
            title={
                isAudioMode
                    ? t("canvas.scriptNode.rowAudioDialogTitle", { no: rowMode?.no ?? "" })
                    : isCellMode
                      ? t("canvas.scriptNode.cellAssetDialogTitle", targetVars)
                      : isRowMode
                        ? t("canvas.scriptNode.rowImageDialogTitle", { no: rowMode?.no ?? "" })
                        : t("canvas.scriptNode.addAsset")
            }
            footer={null}
            width={560}
            // 风格面板展开时先让 Esc 收起面板：否则一次 Esc 会把整个弹窗关掉，草稿全丢。
            keyboard={!genStyleOpen}
        >
            <div {...dropZone} className="relative">
                {isRowMode ? (
                    <div className="mb-2 text-[12px] opacity-65" style={{ color: theme.node.text }}>
                        {isAudioMode
                            ? t("canvas.scriptNode.rowAudioHint")
                            : isCellMode
                              ? t("canvas.scriptNode.cellAssetHint", targetVars)
                              : t("canvas.scriptNode.rowImageHint")}
                    </div>
                ) : (
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                        <span className="opacity-60">{t("canvas.scriptNode.assetRoleLabel")}</span>
                        {roleChips(uploadRole, setUploadRole)}
                        <span className="text-[11px] opacity-50">{t("canvas.scriptNode.assetRolePickHint")}</span>
                    </div>
                )}
                <Tabs items={tabs} />
                {dragging ? (
                    <div
                        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed text-[13px]"
                        style={{ borderColor: theme.toolbar.activeBg, background: `${theme.node.fill}f2`, color: theme.toolbar.activeBg }}
                    >
                        {isCellMode
                            ? t("canvas.scriptNode.cellAssetDropActive", targetVars)
                            : isRowMode
                              ? t("canvas.scriptNode.rowImageDropActive", { no: rowMode?.no ?? "" })
                              : t("canvas.scriptNode.assetDropActive", { role: t(`canvas.scriptNode.assetRole_${uploadRole}`) })}
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}
