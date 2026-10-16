import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { App } from "antd";
import copy from "copy-to-clipboard";
import { ArrowUpRight, AlignJustify, Copy, FileText, Loader2, Maximize2, Minimize2, PencilLine, Play, Plus, ScrollText, Square, Table2, Trash2, User, Video, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CanvasScriptAssetDialog, type ScriptAssetCandidate, type ScriptAssetLinkSelection } from "@/components/canvas/canvas-script-asset-dialog";
import { CanvasTextEditDialog } from "@/components/canvas/canvas-text-edit-dialog";
import {
    getStoryScriptColumns,
    getStoryScriptPreset,
    nextScriptAssetRole,
    resolveScriptAssetRole,
    resolveStoryScriptMergeMode,
    resolveStoryScriptPresetId,
    resolveStoryScriptSegmentSeconds,
    storyScriptToMarkdown,
    storyScriptToTsv,
    STORY_SCRIPT_MERGE_MODES,
    STORY_SCRIPT_PRESET_IDS,
    STORY_SCRIPT_SEGMENT_SECONDS,
    type ScriptAssetRole,
    type StoryScriptPresetId,
} from "@/constant/story-script";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { defaultConfig, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

/** 素材候选由 project.tsx 计算后传进来，这里只做展示与选择。 */
export type { ScriptAssetCandidate, ScriptAssetLinkSelection };

/**
 * 脚本节点（分镜脚本表）。
 *
 * 与 Chat 节点一样是 hidePanel 节点：内容区自己承担全部交互（模型选择、输出格式预设、剧本
 * 输入、生成/停止、表格查看与编辑、导出），并沿用 chat 内容区的两条画布约定：
 *  1) 外壳 `cursor-move`，内部真实控件用 pointer/mouse 捕获把事件挡在节点拖拽之外；
 *  2) 滚动容器挂原生 wheel stopPropagation + `data-canvas-no-zoom`，否则画布会把滚轮吃掉当缩放。
 *
 * 字号：表格是十几列的宽表（经典预设约 2.6k px），若按 chat 的 20px 会彻底读不了，所以表体
 * 固定 13px、外壳 15px，由画布缩放进退。
 *
 * 输出格式由 `metadata.scriptPreset` 决定（见 constant/story-script.ts）：列定义、系统提示词、
 * 行操作按钮全部按预设分派。切换预设会清空已生成的分镜表（原文与补充要求保留），因为两套预设
 * 的列完全不同，旧行在新表里会全空。**生成链路不变**：`runScriptGeneration` 只是多读一个 preset。
 */

const SCRIPT_FONT_SIZE = 13;
const CHROME_FONT_SIZE = 15;
const TABLE_ACTION_WIDTH = 104;

/**
 * 生成后按「内容多少」自动适配节点窗口尺寸的边界。
 * 高度贴合全部行（不再只露三四行）；宽度贴合表格实际宽度，但封顶——经典预设 16 列约 3.1k px，
 * 若真按宽度撑开节点会宽到没法用，所以超出部分仍靠表体横向滚动（配「全屏」看整表）。
 */
const AUTO_SIZE_MIN_WIDTH = 760;
const AUTO_SIZE_MAX_WIDTH = 2000;
const AUTO_SIZE_MIN_HEIGHT = 460;
const AUTO_SIZE_MAX_HEIGHT = 1600;
const AUTO_SIZE_PADDING_X = 24;

/** 三个「试一试」快捷动作（对应剧集画布 ScriptNode 的 SCRIPT_ACTIONS）：在脚本节点左侧建好对应上游节点并连边。 */
export type ScriptGenAction = "fromScript" | "fromVideoRef" | "fromCharacter";

const SCRIPT_ACTIONS: Array<{ key: ScriptGenAction; labelKey: string; Icon: typeof AlignJustify }> = [
    { key: "fromScript", labelKey: "canvas.scriptNode.actionFromScript", Icon: AlignJustify },
    { key: "fromVideoRef", labelKey: "canvas.scriptNode.actionFromVideoRef", Icon: Video },
    { key: "fromCharacter", labelKey: "canvas.scriptNode.actionFromCharacter", Icon: User },
];

type CanvasScriptNodeContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    isRunning: boolean;
    /** 上游（连线接入）的文本，作为没有手填剧本时的兜底来源。 */
    connectedText: string;
    connectedTextCount: number;
    /** 上游接入的素材引用（图片/视频/文本），用于引用条与生成时的多模态输入。 */
    references?: CanvasResourceReference[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    /**
     * `overrides` 带上当前输入框里的草稿：输入框是本地态、失焦才写回 metadata，
     * 直接把草稿传下去就不会出现「刚打完字立刻点生成、结果用了旧值」。
     */
    onGenerate: (nodeId: string, overrides?: { scriptSource: string; scriptPrompt: string }) => void;
    onStop: (nodeId: string) => void;
    onInsertPrompt?: (nodeId: string, text: string, title: string) => void;
    /** 「试一试」快捷动作：建上游节点并连边。 */
    onScriptAction?: (nodeId: string, action: ScriptGenAction) => void;
    /** 「添加资产」候选：画布上还没连到这个脚本节点的图片 / 视频 / 文本节点。 */
    assetCandidates?: ScriptAssetCandidate[];
    /** 导入本地图片 / 视频：上传建节点并连成上游素材，同时按 role 记下分类。 */
    onImportAssets?: (nodeId: string, files: File[], role: ScriptAssetRole) => void;
    /** 链接画布上已有的节点为上游素材（带分类）。 */
    onLinkAssets?: (nodeId: string, links: ScriptAssetLinkSelection[]) => void;
    /** 已链接素材的分类（节点 id → 分类），用于在引用条上回显 / 切换。 */
    assetRoles?: Record<string, string>;
    /** 切换某张已链接素材的分类（角色 / 场景 / 道具 / 站位图）。 */
    onAssetRoleChange?: (nodeId: string, assetNodeId: string, role: ScriptAssetRole) => void;
    /** 一键铺「分镜 → 图片 → 视频」链路。 */
    onBuildPipeline?: (nodeId: string) => void;
    /** 只给某一行分镜建一个视频节点（预填该镜的视频提示词与时长）。 */
    onBuildShotVideo?: (nodeId: string, rowIndex: number) => void;
    /** 生成后按内容多少自动适配节点窗口尺寸（高贴合行数、宽贴合表格宽并封顶）。 */
    onNodeSizeChange?: (nodeId: string, width: number, height: number) => void;
};

export function CanvasScriptNodeContent({
    node,
    theme,
    isRunning,
    connectedText,
    connectedTextCount,
    references,
    onConfigChange,
    onGenerate,
    onStop,
    onInsertPrompt,
    onScriptAction,
    assetCandidates,
    onImportAssets,
    onLinkAssets,
    assetRoles,
    onAssetRoleChange,
    onBuildPipeline,
    onBuildShotVideo,
    onNodeSizeChange,
}: CanvasScriptNodeContentProps) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const globalConfig = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    const rows = useMemo(() => node.metadata?.scriptRows || [], [node.metadata?.scriptRows]);
    const scriptTitle = node.metadata?.scriptTitle || "";
    const scriptRaw = node.metadata?.scriptRaw || "";
    const scriptStatus = node.metadata?.scriptStatus || "idle";
    const source = node.metadata?.scriptSource || "";
    const extraPrompt = node.metadata?.scriptPrompt || "";
    const connectedTextValue = connectedText.trim();
    const textModel = resolveModelForCapability(globalConfig, node.metadata?.model, "text");

    // 输出格式预设：列定义、行操作都从这里来。
    const presetId = resolveStoryScriptPresetId(node.metadata?.scriptPreset);
    const preset = useMemo(() => getStoryScriptPreset(presetId), [presetId]);
    const columns = preset.columns;
    const tableWidth = useMemo(() => columns.reduce((sum, column) => sum + column.width, 0) + TABLE_ACTION_WIDTH, [columns]);

    const [view, setView] = useState<"source" | "table">(rows.length ? "table" : "source");
    const [editing, setEditing] = useState<{ rowIndex: number; key: string } | null>(null);
    // 剧本原文 / 补充要求走本地草稿，失焦才写回 metadata：每个字都 setNodes 会让整张画布
    // 逐键重渲（文本节点也是靠对话框规避这一点的），生成时再显式把草稿交给上层。
    const [sourceDraft, setSourceDraft] = useState(source);
    const [promptDraft, setPromptDraft] = useState(extraPrompt);
    const bodyRef = useRef<HTMLDivElement>(null);
    // 自动适配窗口尺寸时用来实测内容高度：表体是滚动容器，scrollHeight 会被窗口高度顶住，
    // 所以量 <table> 自身的布局高度（不受滚动影响），chrome 用「外壳高 − 表体可视高」反推。
    const tableRef = useRef<HTMLTableElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    // 从 metadata 恢复「已适配过的内容签名」：节点滚出视口会卸载，回来时若签名已记录就不再
    // 重新适配，免得把用户手动拉伸的尺寸又拽回内容尺寸。
    const lastAutoSizeKeyRef = useRef(node.metadata?.scriptAutoSizeKey || "");
    // 全屏查看：内容区改走 portal 铺满视口（z 值卡在画布 chrome 之上、antd Modal 之下）。
    const [fullscreen, setFullscreen] = useState(false);
    const [assetDialogOpen, setAssetDialogOpen] = useState(false);

    useEffect(() => {
        setSourceDraft(source);
    }, [source]);

    useEffect(() => {
        setPromptDraft(extraPrompt);
    }, [extraPrompt]);

    const canGenerate = Boolean(sourceDraft.trim() || connectedTextValue) && !isRunning;
    const activeReferences = useMemo(() => (references || []).filter((item) => item.active), [references]);
    // 「试一试」只在真·空场景出现（没结果、没连线、没手填），否则会挤占输入区。
    const showTryActions = !rows.length && activeReferences.length === 0 && !sourceDraft.trim();
    // 「添加资产」入口：只要有导入或链接能力就显示（两条都来自上层，缺一个也还有用）。
    const showAssetEntry = Boolean(onImportAssets || onLinkAssets);

    // 无结果时回到输入态；首次生成出结果时自动切到分镜表——否则用户停在「剧本原文」，
    // 既看不到表格，也看不到表格底部的「铺链路」入口。
    useEffect(() => {
        if (!rows.length) {
            setView("source");
            return;
        }
        setView((current) => (current === "source" ? "table" : current));
    }, [rows.length]);

    // 画布在外层对 wheel 做 preventDefault（缩放），节点内滚动必须自己拦下来。
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const stop = (event: WheelEvent) => event.stopPropagation();
        el.addEventListener("wheel", stop, { passive: true });
        return () => el.removeEventListener("wheel", stop);
    }, [view, rows.length, isRunning]);

    // 生成出分镜表之后，按「内容多少」自动适配节点窗口：高 = 全部行高（不用再隔着滚动条数行），
    // 宽 = 表格宽度（封顶，见 AUTO_SIZE_MAX_WIDTH）。只在「内容签名」变化时算一次，
    // 否则每次 setNodes 都会重跑，用户手动拉伸的宽度会被不停拽回去。
    useEffect(() => {
        if (!onNodeSizeChange || fullscreen || view !== "table" || !rows.length) return;
        const table = tableRef.current;
        const body = bodyRef.current;
        const shell = shellRef.current;
        if (!table || !body || !shell) return;
        const contentHeight = table.offsetHeight;
        if (!contentHeight) return;
        // 签名带行数与单元格总字数：增删行、改字都会变，纯切换视图不会。
        const signature = `${presetId}:${columns.length}:${rows.length}:${rows.reduce((sum, row) => sum + columns.reduce((acc, column) => acc + String(row[column.key] ?? "").length, 0), 0)}`;
        if (signature === lastAutoSizeKeyRef.current) return;
        const chromeHeight = Math.max(0, shell.clientHeight - body.clientHeight);
        const width = Math.round(Math.min(AUTO_SIZE_MAX_WIDTH, Math.max(AUTO_SIZE_MIN_WIDTH, tableWidth + AUTO_SIZE_PADDING_X)));
        const height = Math.round(Math.min(AUTO_SIZE_MAX_HEIGHT, Math.max(AUTO_SIZE_MIN_HEIGHT, chromeHeight + contentHeight + 2)));
        lastAutoSizeKeyRef.current = signature;
        onConfigChange(node.id, { scriptAutoSizeKey: signature });
        if (Math.abs(width - node.width) < 8 && Math.abs(height - node.height) < 8) return;
        onNodeSizeChange(node.id, width, height);
    }, [columns, fullscreen, isRunning, node.height, node.id, node.width, onConfigChange, onNodeSizeChange, presetId, rows, tableWidth, view]);

    // 全屏时 Esc 退出；单元格编辑弹窗开着时让 Esc 先归它（否则会连带把全屏也关掉）。
    useEffect(() => {
        if (!fullscreen || editing) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setFullscreen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [editing, fullscreen]);

    const totalDuration = rows.reduce((sum, row) => sum + (Number(row.duration) || 0), 0);

    const patchMetadata = (patch: Partial<CanvasNodeData["metadata"]>) => onConfigChange(node.id, patch);

    const updateRow = (rowIndex: number, key: string, value: string) => {
        const numeric = columns.some((column) => column.key === key && column.numeric);
        const next = rows.map((row, index) => {
            if (index !== rowIndex) return row;
            if (numeric) {
                const parsed = Number(String(value).match(/\d+(\.\d+)?/)?.[0] ?? "");
                const fallback = key === "shot_no" ? index + 1 : Number(row.duration) || 0;
                return { ...row, [key]: Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback };
            }
            return { ...row, [key]: value };
        });
        patchMetadata({ scriptRows: next });
    };

    const deleteRow = (rowIndex: number) => {
        const next = rows
            .filter((_, index) => index !== rowIndex)
            .map((row, index) => ({ ...row, shot_no: index + 1 }));
        patchMetadata({ scriptRows: next });
        message.success(t("canvas.scriptNode.rowDeleted"));
    };

    const toastCopied = () => message.success(t("common.copied"));
    const copyValue = (value: string) => {
        if (!value.trim()) {
            message.warning(t("canvas.scriptNode.nothingToCopy"));
            return;
        }
        copy(value);
        toastCopied();
    };

    const copyMarkdown = () => {
        copyValue(storyScriptToMarkdown(rows, scriptTitle, presetId));
    };

    const clearRows = () => {
        modal.confirm({
            title: t("canvas.scriptNode.clearConfirm"),
            okText: t("canvas.scriptNode.clear"),
            cancelText: t("common.cancel"),
            onOk: () => {
                patchMetadata({ scriptRows: [], scriptTitle: "", scriptRaw: "", scriptStatus: "idle", errorDetails: undefined });
                setView("source");
            },
        });
    };

    // 切预设 = 换一整套列，旧行在新表里会全空，所以有结果时先确认再清空重来。
    const applyPreset = (next: StoryScriptPresetId) => {
        patchMetadata({ scriptPreset: next, scriptRows: [], scriptTitle: "", scriptRaw: "", scriptStatus: "idle", errorDetails: undefined });
        setView("source");
    };
    const switchPreset = (next: StoryScriptPresetId) => {
        if (next === presetId) return;
        if (!rows.length) {
            applyPreset(next);
            return;
        }
        modal.confirm({
            title: t("canvas.scriptNode.presetSwitchConfirm"),
            okText: t("canvas.scriptNode.presetSwitch"),
            cancelText: t("common.cancel"),
            onOk: () => applyPreset(next),
        });
    };

    const stopIfInteractive = (event: ReactMouseEvent | ReactPointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("textarea,input,button,[contenteditable='true'],.ant-select,[data-canvas-text-input],[data-canvas-selectable-text]")) {
            event.stopPropagation();
        }
    };

    const chromeButtonClass = "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 font-medium transition disabled:opacity-35";

    const header = (
        <div
            className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5 pt-2"
            style={{ fontSize: `${CHROME_FONT_SIZE}px` }}
            onMouseDown={stopIfInteractive}
            onPointerDown={stopIfInteractive}
        >
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium opacity-85" style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke }}>
                <ScrollText className="size-4" />
                {t("canvas.scriptNode.title")}
            </span>
            <span className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[12px] opacity-80" style={{ borderColor: theme.node.stroke }} title={t(`canvas.scriptNode.preset_${presetId}_hint`)}>
                {t(`canvas.scriptNode.preset_${presetId}`)}
            </span>
            <div className="min-w-0 flex-1">
                <ModelPicker
                    config={{ ...globalConfig, model: textModel, reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort }}
                    value={textModel}
                    onChange={(model) => patchMetadata({ model })}
                    capability="text"
                    onMissingConfig={() => openConfigDialog(true)}
                    className="max-w-full"
                    fullWidth
                    placeholder={t("canvas.chat.selectTextModel")}
                />
            </div>

            {rows.length ? (
                <>
                    {onBuildPipeline ? (
                        <button
                            type="button"
                            className={chromeButtonClass}
                            style={{ borderColor: theme.node.stroke, background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                onBuildPipeline(node.id);
                            }}
                            title={t("canvas.scriptNode.pipelineHint")}
                        >
                            <Wand2 className="size-3.5" />
                            {t("canvas.scriptNode.pipelineBuild")}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className={chromeButtonClass}
                        style={{ borderColor: theme.node.stroke, background: view === "table" ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`, color: view === "table" ? theme.toolbar.activeText : theme.node.text }}
                        onClick={() => setView("table")}
                        title={t("canvas.scriptNode.viewTable")}
                    >
                        <Table2 className="size-3.5" />
                        {t("canvas.scriptNode.viewTable")}
                    </button>
                    <button
                        type="button"
                        className={chromeButtonClass}
                        style={{ borderColor: theme.node.stroke, background: view === "source" ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`, color: view === "source" ? theme.toolbar.activeText : theme.node.text }}
                        onClick={() => setView("source")}
                        title={t("canvas.scriptNode.editSource")}
                    >
                        <PencilLine className="size-3.5" />
                        {t("canvas.scriptNode.editSource")}
                    </button>
                    <button type="button" className={chromeButtonClass} style={{ borderColor: theme.node.stroke }} onClick={() => copyValue(storyScriptToTsv(rows, scriptTitle, presetId))} title={t("canvas.scriptNode.copyTsv")}>
                        <Copy className="size-3.5" />
                        TSV
                    </button>
                    <button type="button" className={chromeButtonClass} style={{ borderColor: theme.node.stroke }} onClick={copyMarkdown} title={t("canvas.scriptNode.copyMarkdown")}>
                        <FileText className="size-3.5" />
                        MD
                    </button>
                    <button type="button" className={chromeButtonClass} style={{ borderColor: theme.node.stroke }} onClick={clearRows} title={t("canvas.scriptNode.clear")}>
                        <Trash2 className="size-3.5" />
                    </button>
                </>
            ) : null}

            <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border transition"
                style={{ borderColor: theme.node.stroke, background: `${theme.toolbar.panel}aa`, color: theme.node.text }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    setFullscreen((current) => !current);
                }}
                title={fullscreen ? t("canvas.scriptNode.exitFullscreen") : t("canvas.scriptNode.fullscreen")}
            >
                {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>

            {isRunning ? (
                <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium text-white"
                    style={{ background: "#dc2626" }}
                    onClick={() => onStop(node.id)}
                    title={t("canvas.scriptNode.stop")}
                >
                    <Square className="size-3.5 fill-current" />
                    {t("canvas.scriptNode.stop")}
                </button>
            ) : (
                <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium text-white transition disabled:opacity-35"
                    style={{ background: theme.toolbar.activeBg }}
                    disabled={!canGenerate}
                    onClick={() => onGenerate(node.id, { scriptSource: sourceDraft, scriptPrompt: promptDraft })}
                    title={rows.length ? t("canvas.scriptNode.regenerate") : t("canvas.scriptNode.generate")}
                >
                    <Play className="size-3.5" />
                    {rows.length ? t("canvas.scriptNode.regenerate") : t("canvas.scriptNode.generate")}
                </button>
            )}
        </div>
    );

    const errorBanner =
        scriptStatus === "error" && !isRunning && node.metadata?.errorDetails ? (
            <div className="mx-2 mb-1.5 shrink-0 rounded-lg border px-2 py-1.5 text-[12px] leading-snug" style={{ borderColor: "#dc2626", background: "#dc26261a", color: theme.node.text }}>
                <div className="font-medium">{t("canvas.scriptNode.errorTitle")}</div>
                <div className="mt-0.5 opacity-80">{node.metadata.errorDetails}</div>
                {scriptRaw ? (
                    <button type="button" className="mt-1 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]" style={{ borderColor: theme.node.stroke }} onClick={() => copyValue(scriptRaw)}>
                        <Copy className="size-3" />
                        {t("canvas.scriptNode.copyRaw")}
                    </button>
                ) : null}
            </div>
        ) : null;

    const runningPanel = (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
            <div className="flex shrink-0 items-center gap-2 text-[13px] opacity-75" style={{ color: theme.node.text }}>
                <Loader2 className="size-4 animate-spin" />
                {t("canvas.scriptNode.generating")}
            </div>
            <pre className="thin-scrollbar min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border p-2 text-[12px] leading-relaxed opacity-70" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}>
                {scriptRaw || "…"}
            </pre>
        </div>
    );

    // 引用条：编号缩略图 + 资产分类（对应剧集画布 ScriptReferencesRow）。
    //  - 图片 / 视频：胶囊可点，点一下就在「角色 → 场景 → 道具 → 站位图」之间轮转（铺链路时决定这张图连到哪些镜）；
    //  - 文本：只作为剧本原文来源，不参与分类。
    // 用自绘胶囊而不是 antd Select：画布浮层会被自身 pointerdown 吞掉（见项目备忘）。
    const classifiableReferences = activeReferences.filter((reference) => reference.kind === "image" || reference.kind === "video");
    const referencesRow = activeReferences.length ? (
        <div className="flex shrink-0 flex-col gap-0.5">
            {classifiableReferences.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] opacity-60" style={{ color: theme.node.text }}>
                    <span>{t("canvas.scriptNode.assetRoleLabel")}</span>
                    {onAssetRoleChange ? <span className="text-[11px] opacity-90">· {t("canvas.scriptNode.assetRoleHint")}</span> : null}
                </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
                {activeReferences.map((reference, index) => {
                    const preview = reference.kind === "video" ? undefined : reference.previewUrl;
                    const classifiable = reference.kind === "image" || reference.kind === "video";
                    const role = resolveScriptAssetRole(assetRoles?.[reference.nodeId]);
                    const thumb = (
                        <span
                            className="relative flex size-8 items-center justify-center overflow-hidden rounded-md border"
                            style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                        >
                            {preview ? (
                                <img src={preview} alt={reference.title} className="size-full object-cover" />
                            ) : reference.kind === "video" ? (
                                <Video className="size-4" />
                            ) : reference.kind === "text" ? (
                                <span className="text-[11px] font-semibold">T</span>
                            ) : (
                                <FileText className="size-4" />
                            )}
                            <span className="absolute right-0.5 top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-black/45 px-0.5 text-[9px] leading-none text-white">{index + 1}</span>
                        </span>
                    );
                    if (!classifiable || !onAssetRoleChange) {
                        return (
                            <span key={reference.nodeId} className="flex flex-col items-center gap-0.5" title={reference.title}>
                                {thumb}
                            </span>
                        );
                    }
                    return (
                        <button
                            key={reference.nodeId}
                            type="button"
                            className="flex cursor-pointer flex-col items-center gap-0.5 rounded-md transition"
                            style={{ opacity: 0.9 }}
                            title={`${reference.title} · ${t("canvas.scriptNode.assetRoleHint")}`}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                onAssetRoleChange(node.id, reference.nodeId, nextScriptAssetRole(role));
                            }}
                        >
                            {thumb}
                            <span className="text-[10px] leading-none opacity-75">{t(`canvas.scriptNode.assetRole_${role}`)}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    ) : null;

    const tryActions =
        showTryActions && onScriptAction ? (
            <div className="shrink-0">
                <div className="text-[12px] opacity-60" style={{ color: theme.node.text }}>
                    {t("canvas.scriptNode.tryLabel")}
                </div>
                <div className="mt-1 flex flex-col">
                    {SCRIPT_ACTIONS.map((action) => {
                        const Icon = action.Icon;
                        return (
                            <button
                                key={action.key}
                                type="button"
                                className="inline-flex items-center gap-2 self-start rounded-lg px-1.5 py-1.5 text-left text-[13px] transition hover:opacity-100"
                                style={{ color: theme.node.text, opacity: 0.85 }}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onScriptAction(node.id, action.key);
                                }}
                            >
                                <Icon className="size-4 shrink-0" />
                                <span className="truncate">{t(action.labelKey)}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        ) : null;

    // 输出格式预设切换：放在输入区（它只影响「生成什么」，且切换会清空结果回到输入态）。
    const presetSwitcher = (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[12px]" style={{ color: theme.node.text }}>
            <span className="opacity-60">{t("canvas.scriptNode.presetLabel")}</span>
            {STORY_SCRIPT_PRESET_IDS.map((id) => {
                const active = id === presetId;
                return (
                    <button
                        key={id}
                        type="button"
                        className="inline-flex h-6 items-center gap-1 rounded-full border px-2.5 transition"
                        style={{
                            borderColor: theme.node.stroke,
                            background: active ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`,
                            color: active ? theme.toolbar.activeText : theme.node.text,
                            opacity: active ? 1 : 0.7,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            switchPreset(id);
                        }}
                        title={t(`canvas.scriptNode.preset_${id}_hint`)}
                    >
                        {t(`canvas.scriptNode.preset_${id}`)}
                    </button>
                );
            })}
        </div>
    );

    // 「每段时长」：视频模型按 10s / 15s 成片。选 10 / 15 后会在生成任务里要求模型按这个长度规划
    // 连续镜头，铺链路时还可以选「按每段时长」把它们自动合并成一个视频节点。
    const segmentSeconds = resolveStoryScriptSegmentSeconds(node.metadata?.scriptSegmentSeconds);
    const segmentSelector = (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[12px]" style={{ color: theme.node.text }}>
            <span className="opacity-60">{t("canvas.scriptNode.segmentLabel")}</span>
            {STORY_SCRIPT_SEGMENT_SECONDS.map((id) => {
                const active = id === segmentSeconds;
                return (
                    <button
                        key={id}
                        type="button"
                        className="inline-flex h-6 items-center rounded-full border px-2.5 transition"
                        style={{
                            borderColor: theme.node.stroke,
                            background: active ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`,
                            color: active ? theme.toolbar.activeText : theme.node.text,
                            opacity: active ? 1 : 0.7,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            patchMetadata({ scriptSegmentSeconds: id });
                        }}
                        title={t("canvas.scriptNode.segmentHint")}
                    >
                        {t(`canvas.scriptNode.segment_${id}`)}
                    </button>
                );
            })}
        </div>
    );

    const sourcePanel = (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 pb-2">
            {presetSwitcher}
            {segmentSelector}
            <div className="flex shrink-0 items-center gap-2 text-[12px] opacity-60" style={{ color: theme.node.text }}>
                <span>{t("canvas.scriptNode.sourceLabel")}</span>
                {connectedTextCount ? <span>· {t("canvas.scriptNode.connectedHint", { count: connectedTextCount })}</span> : null}
            </div>
            {referencesRow}
            {showAssetEntry ? (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] transition"
                        style={{ borderColor: theme.node.stroke, background: `${theme.toolbar.panel}aa`, color: theme.node.text }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setAssetDialogOpen(true);
                        }}
                        title={t("canvas.scriptNode.addAssetHint")}
                    >
                        <Plus className="size-3.5" />
                        {t("canvas.scriptNode.addAsset")}
                    </button>
                    {assetCandidates?.length ? (
                        <span className="text-[11px] opacity-55" style={{ color: theme.node.text }}>
                            {t("canvas.scriptNode.assetCandidateHint", { count: assetCandidates.length })}
                        </span>
                    ) : null}
                </div>
            ) : null}
            <textarea
                data-canvas-text-input
                data-canvas-no-zoom
                className="thin-scrollbar min-h-0 flex-1 resize-none rounded-xl border px-2 py-1.5 text-[13px] leading-relaxed outline-none"
                style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                value={sourceDraft}
                onChange={(event) => setSourceDraft(event.target.value)}
                onBlur={() => {
                    if (sourceDraft !== source) patchMetadata({ scriptSource: sourceDraft });
                }}
                placeholder={connectedTextValue ? t("canvas.scriptNode.sourcePlaceholderLinked") : t("canvas.scriptNode.sourcePlaceholder")}
            />
            <input
                data-canvas-text-input
                className="shrink-0 rounded-xl border px-2 py-1.5 text-[13px] outline-none"
                style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                onBlur={() => {
                    if (promptDraft !== extraPrompt) patchMetadata({ scriptPrompt: promptDraft });
                }}
                placeholder={t("canvas.scriptNode.promptPlaceholder")}
            />
            {tryActions}
            {rows.length ? (
                <button type="button" className="shrink-0 self-start rounded-full border px-2.5 py-1 text-[12px]" style={{ borderColor: theme.node.stroke }} onClick={() => setView("table")}>
                    <Table2 className="mr-1 inline size-3" />
                    {t("canvas.scriptNode.viewTable")}
                </button>
            ) : null}
        </div>
    );

    // 全屏时表体放宽 + 字号上调：经典预设 16 列约 2.6k px，节点里只能横向滚着看。
    const tableStyle = fullscreen
        ? { width: "100%", minWidth: tableWidth, tableLayout: "fixed" as const, fontSize: "15px", color: theme.node.text }
        : { width: tableWidth, tableLayout: "fixed" as const, fontSize: `${SCRIPT_FONT_SIZE}px`, color: theme.node.text };

    // 「视频分段」：铺链路时把连续镜头合并进同一个视频节点（多个分镜提示词 → 一条视频提示词）。
    // 「按每段时长」需要先在输入区选好 10 秒 / 15 秒，没选就置灰。
    const mergeMode = resolveStoryScriptMergeMode(node.metadata?.scriptMergeMode);
    const mergeSelector = (
        <div className="flex flex-wrap items-center gap-1.5" style={{ color: theme.node.text }}>
            <span className="opacity-60">{t("canvas.scriptNode.mergeLabel")}</span>
            {STORY_SCRIPT_MERGE_MODES.map((id) => {
                const active = id === mergeMode;
                const disabled = id === "duration" && segmentSeconds === "none";
                return (
                    <button
                        key={id}
                        type="button"
                        className="inline-flex h-6 items-center rounded-full border px-2 transition disabled:opacity-35"
                        style={{
                            borderColor: theme.node.stroke,
                            background: active ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`,
                            color: active ? theme.toolbar.activeText : theme.node.text,
                            opacity: disabled ? 0.4 : active ? 1 : 0.7,
                        }}
                        disabled={disabled}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (disabled) return;
                            patchMetadata({ scriptMergeMode: id });
                        }}
                        title={disabled ? t("canvas.scriptNode.mergeDurationDisabled") : t("canvas.scriptNode.mergeHint")}
                    >
                        {t(`canvas.scriptNode.merge_${id}`)}
                    </button>
                );
            })}
        </div>
    );

    const tablePanel = (
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
            <div ref={bodyRef} data-canvas-no-zoom className="thin-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                <table ref={tableRef} className="border-separate border-spacing-0 leading-snug" style={tableStyle}>
                    <colgroup>
                        {columns.map((column) => (
                            <col key={column.key} style={{ width: column.width }} />
                        ))}
                        <col style={{ width: TABLE_ACTION_WIDTH }} />
                    </colgroup>
                    <thead>
                        <tr>
                            {columns.map((column) => (
                                <th
                                    key={column.key}
                                    className={`sticky top-0 z-10 border-b px-2 py-1.5 text-left font-semibold whitespace-nowrap ${column.numeric ? "text-right" : ""}`}
                                    style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}
                                >
                                    {column.label}
                                </th>
                            ))}
                            <th className="sticky top-0 z-10 border-b px-2 py-1.5 text-left font-semibold whitespace-nowrap" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}>
                                {t("canvas.scriptNode.columnActions")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, rowIndex) => (
                            <tr key={`${row.shot_no}-${rowIndex}`} className="align-top">
                                {columns.map((column) => {
                                    const value = String(row[column.key] ?? "");
                                    return (
                                        <td
                                            key={column.key}
                                            data-canvas-selectable-text
                                            className={`cursor-text border-b px-2 py-1.5 ${column.numeric ? "text-right tabular-nums" : ""}`}
                                            style={{ borderColor: theme.node.stroke }}
                                            title={value || t("canvas.scriptNode.noContent")}
                                            onDoubleClick={(event) => {
                                                event.stopPropagation();
                                                setEditing({ rowIndex, key: column.key });
                                            }}
                                        >
                                            {value ? (
                                                <div className="line-clamp-4 whitespace-pre-wrap break-words">{value}</div>
                                            ) : (
                                                <div className="opacity-35">{t("canvas.scriptNode.noContent")}</div>
                                            )}
                                        </td>
                                    );
                                })}
                                <td className="border-b px-1 py-1" style={{ borderColor: theme.node.stroke }}>
                                    <div className="flex items-center gap-1">
                                        {preset.rowActions.map((action) => (
                                            <button
                                                key={action.key}
                                                type="button"
                                                className="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={() => copyValue(String(row[action.key] ?? ""))}
                                                title={t(`canvas.scriptNode.${action.labelKey}`)}
                                            >
                                                <Copy className="size-3" />
                                                {t(`canvas.scriptNode.${action.labelKey}`)}
                                            </button>
                                        ))}
                                        {onInsertPrompt ? (
                                            <button
                                                type="button"
                                                className="inline-flex size-6 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={() =>
                                                    onInsertPrompt(
                                                        node.id,
                                                        String(row[preset.insertKey] ?? "") || String(row.visual_description ?? ""),
                                                        `${t("canvas.scriptNode.shotLabel", { no: row.shot_no })} · ${t(`canvas.scriptNode.${preset.rowActions[0].labelKey}`)}`,
                                                    )
                                                }
                                                title={t("canvas.scriptNode.sendToCanvas")}
                                            >
                                                <ArrowUpRight className="size-3" />
                                            </button>
                                        ) : null}
                                        {onBuildShotVideo ? (
                                            <button
                                                type="button"
                                                className="inline-flex size-6 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={() => onBuildShotVideo(node.id, rowIndex)}
                                                title={t("canvas.scriptNode.buildShotVideoHint")}
                                            >
                                                <Video className="size-3" />
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            className="inline-flex size-6 items-center justify-center rounded-md border transition hover:opacity-100"
                                            style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                            onMouseDown={(event) => event.stopPropagation()}
                                            onPointerDown={(event) => event.stopPropagation()}
                                            onClick={() => deleteRow(rowIndex)}
                                            title={t("canvas.scriptNode.deleteRow")}
                                        >
                                            <Trash2 className="size-3" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="mt-1 flex shrink-0 flex-wrap items-center gap-1.5 text-[12px]" style={{ color: theme.node.text }}>
                <span className="rounded border px-1.5 opacity-90" style={{ borderColor: theme.node.stroke }}>
                    {t(`canvas.scriptNode.preset_${presetId}`)}
                </span>
                <span className="opacity-55">
                    {scriptTitle ? `${scriptTitle} · ` : ""}
                    {t("canvas.scriptNode.shotCount", { count: rows.length })} · {t("canvas.scriptNode.totalDuration", { seconds: totalDuration })}
                </span>
                {mergeSelector}
                {onBuildPipeline ? (
                    <button
                        type="button"
                        className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-medium text-white transition"
                        style={{ background: theme.toolbar.activeBg }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onBuildPipeline(node.id);
                        }}
                        title={t("canvas.scriptNode.pipelineHint")}
                    >
                        <Wand2 className="size-3.5" />
                        {t("canvas.scriptNode.pipelineBuild")}
                    </button>
                ) : null}
            </div>
        </div>
    );

    const editingColumn = editing ? columns.find((column) => column.key === editing.key) : undefined;
    const editingValue = editing ? String(rows[editing.rowIndex]?.[editing.key] ?? "") : "";

    const shell = (
        <div
            ref={shellRef}
            className={`flex h-full w-full flex-col overflow-hidden ${fullscreen ? "" : "cursor-move"}`}
            style={{ color: theme.node.text }}
            onMouseDown={stopIfInteractive}
            onPointerDown={stopIfInteractive}
        >
            {header}
            {errorBanner}
            {isRunning ? runningPanel : view === "table" && rows.length ? tablePanel : sourcePanel}
        </div>
    );

    const assetDialog = showAssetEntry ? (
        <CanvasScriptAssetDialog
            open={assetDialogOpen}
            theme={theme}
            candidates={assetCandidates || []}
            onClose={() => setAssetDialogOpen(false)}
            onLink={(links) => onLinkAssets?.(node.id, links)}
            onImport={(files, role) => onImportAssets?.(node.id, files, role)}
        />
    ) : null;

    return (
        <>
            {fullscreen
                ? createPortal(
                      // z-[500]：压在画布自绘浮层（最高 z-[120]）之上，又留在 antd Modal（1000）之下，
                      // 所以全屏里照样能弹出「添加资产」。
                      <div className="fixed inset-0 z-[500] flex items-center justify-center p-3" style={{ background: "rgba(0, 0, 0, 0.55)" }}>
                          <div
                              className="flex h-full w-full max-w-[1800px] flex-col overflow-hidden rounded-2xl border shadow-2xl"
                              style={{ borderColor: theme.node.stroke, background: theme.node.panel }}
                          >
                              {shell}
                          </div>
                      </div>,
                      document.body,
                  )
                : shell}

            <CanvasTextEditDialog
                open={Boolean(editing)}
                value={editingValue}
                title={editing ? `${t("canvas.scriptNode.shotLabel", { no: rows[editing.rowIndex]?.shot_no ?? editing.rowIndex + 1 })} · ${editingColumn?.label ?? ""}` : ""}
                fontSize={fullscreen ? 16 : 14}
                onClose={() => setEditing(null)}
                onSave={(value) => {
                    if (editing) updateRow(editing.rowIndex, editing.key, value);
                    setEditing(null);
                }}
            />
            {assetDialog}
        </>
    );
}
