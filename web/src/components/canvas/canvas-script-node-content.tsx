import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { App } from "antd";
import copy from "copy-to-clipboard";
import { ArrowUpRight, AlignJustify, Copy, FileText, GripVertical, Image as ImageIcon, Loader2, Lock, Maximize2, Minus, Minimize2, Music2, PencilLine, Play, Plus, RotateCcw, ScrollText, Square, Table2, Trash2, Unlock, User, Video, Wand2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CanvasScriptAssetDialog, isAssetFile, type ScriptAssetCandidate, type ScriptAssetLinkSelection, type ScriptAssetPoolAsset, type ScriptRowAssetMode } from "@/components/canvas/canvas-script-asset-dialog";
import { CanvasTextEditDialog } from "@/components/canvas/canvas-text-edit-dialog";
import {
    collectScriptCellPromptCandidate,
    getStoryScriptColumns,
    getStoryScriptPreset,
    getStoryScriptSystemPrompt,
    hasScriptSystemPromptOverride,
    isScriptAssetColumn,
    nextScriptAssetRole,
    resolveScriptAssetRole,
    resolveStoryScriptFontSize,
    resolveStoryScriptMergeMode,
    resolveStoryScriptPresetId,
    resolveStoryScriptSegmentSeconds,
    scriptCellAssetIds,
    scriptNameLockIds,
    scriptNameLockName,
    scriptRowAssetIds,
    shiftStoryScriptCellAssetsAfterDelete,
    shiftStoryScriptRowAssetsAfterDelete,
    stepStoryScriptFontSize,
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
 * 字号：表格是十几列的宽表（经典预设约 2.6k px），若按 chat 的 20px 会彻底读不了，所以默认基准
 * 13px、工具条 15px（1.154 倍），再由画布缩放进退。基准字号可由顶部「A− / A+」调档
 * （`metadata.scriptFontSize`）：外壳挂基准 px，**其余字号一律写成 em**，所以只改一个值就整体缩放；
 * 默认 13px 时各 em 值恰好还原原先的像素值，视觉零变化。
 *
 * 输出格式由 `metadata.scriptPreset` 决定（见 constant/story-script.ts）：列定义、系统提示词、
 * 行操作按钮全部按预设分派。切换预设会清空已生成的分镜表（原文与补充要求保留），因为两套预设
 * 的列完全不同，旧行在新表里会全空。**生成链路不变**：`runScriptGeneration` 只是多读一个 preset。
 */

/** 顶部工具条字号相对正文基准的倍数（改造前 15px / 13px），跟着基准字号一起缩放。 */
const HEADER_FONT_SCALE = 1.154;
const TABLE_ACTION_WIDTH = 104;
/**
 * 「镜头图」列宽（逐镜图片）。它是**不参与解析 / 导出**的自绘列（预设列定义里没有它），
 * 所以单独声明、并计入 `tableWidth`，让自动适配窗口宽度时把它一起算上。
 */
const ROW_IMAGE_COLUMN_WIDTH = 148;

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
    /**
     * 没有现成素材时，直接用一段描述生成一张资产图：上层会建图片节点、连成上游素材、
     * 写入分类并立刻触发生图。`title` 是建出来的节点标题（角色类靠它做名字匹配）。
     */
    onGenerateAsset?: (nodeId: string, role: ScriptAssetRole, prompt: string, title: string) => void;
    /** 已链接素材的分类（节点 id → 分类），用于在引用条上回显 / 切换。 */
    assetRoles?: Record<string, string>;
    /** 切换某张已链接素材的分类（角色 / 场景 / 道具 / 站位图）。 */
    onAssetRoleChange?: (nodeId: string, assetNodeId: string, role: ScriptAssetRole) => void;
    /** 一键铺「分镜 → 图片 → 视频」链路。 */
    onBuildPipeline?: (nodeId: string) => void;
    /** 只给某一行分镜建一个视频节点（预填该镜的视频提示词与时长）。 */
    onBuildShotVideo?: (nodeId: string, rowIndex: number) => void;
    /** 按镜重生成：只重写这一行的全部列（保留 shot_no），并带上一镜 / 下一镜作为上下文。 */
    onRegenerateShot?: (nodeId: string, rowIndex: number) => void;
    /** 重新生成整表：整张分镜表推倒重来（用于追回缺失的资产 / 列）。 */
    onRegenerateAll?: (nodeId: string) => void;
    /** 逐镜图片：镜号 → 已关联的图片节点 id（存在 metadata.scriptRowAssets，见 constant/story-script.ts）。 */
    rowAssets?: Record<string, string[]>;
    /** 画布上全部图片节点的候选：供「镜头图」列解析缩略图、以及逐镜弹窗里勾选。 */
    imageCandidates?: ScriptAssetCandidate[];
    /** 逐镜关联变更：整组替换这一镜的图片节点 id（传空数组即解绑）。 */
    onRowAssetsChange?: (nodeId: string, shotNo: number, ids: string[]) => void;
    /** 逐镜导入本地图片：建节点并立刻关联到这一镜。 */
    onRowAssetImport?: (nodeId: string, shotNo: number, files: File[]) => void;
    /** 逐镜 AI 生成图片：建节点、关联到这一镜并立刻触发生图。 */
    onRowAssetGenerate?: (nodeId: string, shotNo: number, prompt: string, title: string) => void;
    /**
     * **按镜按资产**挂图：`"镜号:资产列key"`（如 `"3:scene"`）→ 图片节点 id 列表
     * （存在 metadata.scriptCellAssets）。在资产列格子里导入 / 链接 / 生成，铺链路时只连到这一镜的那一个资产。
     */
    cellAssets?: Record<string, string[]>;
    /** 按镜按资产关联变更：整组替换这一格的图片节点 id（传空数组即解绑）。 */
    onCellAssetsChange?: (nodeId: string, shotNo: number, columnKey: string, ids: string[]) => void;
    /** 按镜按资产导入本地图片：建节点并立刻关联到这一格。 */
    onCellAssetImport?: (nodeId: string, shotNo: number, columnKey: string, files: File[]) => void;
    /** 按镜按资产 AI 生成图片：建节点、关联到这一格并立刻触发生图（`model` 是这一格单独挑的生图模型）。 */
    onCellAssetGenerate?: (nodeId: string, shotNo: number, columnKey: string, prompt: string, title: string, model?: string) => void;
    /**
     * **资产池**：已经连到本脚本节点的素材（带分类）。「按镜按资产」弹窗据此多出一个「@ 资产池」tab ——
     * 池里的图点一下就能挂进某一格，不用重新上传，也不用重新连一次上游。
     */
    poolAssets?: ScriptAssetPoolAsset[];
    /** 「按镜按资产」弹窗里默认的生图模型（存 metadata.scriptCellImageModel）。 */
    cellModel?: string;
    /** 资产格子里换了生图模型：落库成节点的默认值。 */
    onCellModelChange?: (nodeId: string, model: string) => void;
    /**
     * **资产锁定**：资产名 → 画布图片节点 id（`metadata.scriptNameLocks`）。
     * 表里凡是出现这个名字的镜头，铺链路时都用这几张图（「张三」→ @图片1、「客厅」→ @图片2）。
     */
    nameLocks?: Record<string, string[]>;
    /** 给某个资产名上锁（`ids` = 这一格当前的图）/ 解锁（`ids` 为空）。 */
    onNameLockChange?: (nodeId: string, name: string, ids: string[]) => void;
    /** 解除本表全部资产锁定。 */
    onClearNameLocks?: (nodeId: string) => void;
    /**
     * **资产池缩略图拖拽换位**：把本节点上游素材的连线按新顺序重排。
     * 顺序会跟随「铺链路」时把资产条素材接到图片 / 视频节点的先后，所以想让某张参考图排在前面就拖它。
     */
    onReorderScriptAssets?: (nodeId: string, orderedNodeIds: string[]) => void;
    /**
     * 资产池缩略图上的「解除链接」：断开这条上游连线，并把这张素材从本表的按格 / 逐镜 / 按名引用里摘干净。
     * 只断线不清引用的话，表里仍会显示一张已经不属于这张表的图，和「删除链接」对不上。
     */
    onRemoveScriptAsset?: (nodeId: string, assetNodeId: string) => void;
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
    onGenerateAsset,
    assetRoles,
    onAssetRoleChange,
    onBuildPipeline,
    onBuildShotVideo,
    onRegenerateShot,
    onRegenerateAll,
    rowAssets,
    imageCandidates,
    onRowAssetsChange,
    onRowAssetImport,
    onRowAssetGenerate,
    cellAssets,
    onCellAssetsChange,
    onCellAssetImport,
    onCellAssetGenerate,
    poolAssets,
    cellModel,
    onCellModelChange,
    nameLocks,
    onNameLockChange,
    onClearNameLocks,
    onReorderScriptAssets,
    onRemoveScriptAsset,
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

    // 内容基准字号（px）。组件内所有字号都写成 em，所以只改这一个值就能整体缩放
    // （档位见 story-script.ts 的 STORY_SCRIPT_FONT_SIZES，避开 13.5px 这种糊字）。
    // 默认 13px 时各 em 值恰好还原改造前的像素值，视觉零变化。
    const baseFontSize = resolveStoryScriptFontSize(node.metadata?.scriptFontSize);
    const smallerFontSize = stepStoryScriptFontSize(baseFontSize, -1);
    const largerFontSize = stepStoryScriptFontSize(baseFontSize, 1);

    // 输出格式预设：列定义、行操作都从这里来。
    const presetId = resolveStoryScriptPresetId(node.metadata?.scriptPreset);
    const preset = useMemo(() => getStoryScriptPreset(presetId), [presetId]);
    const columns = preset.columns;
    // 「镜头图」列挂在 preset 列之前，所以表格实际宽度要把它一起算上（否则自动适配会窄一列）。
    const tableWidth = useMemo(() => columns.reduce((sum, column) => sum + column.width, 0) + TABLE_ACTION_WIDTH + ROW_IMAGE_COLUMN_WIDTH, [columns]);

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
    /** 逐镜「镜头图」弹窗当前瞄准的那一镜（null = 未打开）。 */
    const [rowAssetTarget, setRowAssetTarget] = useState<{ shotNo: number; ids: string[] } | null>(null);
    /** 「按镜按资产」弹窗当前瞄准的那一格（null = 未打开）。 */
    const [cellAssetTarget, setCellAssetTarget] = useState<{ shotNo: number; columnKey: string; label: string; ids: string[] } | null>(null);
    /** 正把文件从系统拖到节点上（显示落区提示）。 */
    const [fileDragging, setFileDragging] = useState(false);
    // 「自定义提示词」弹窗：用一段自己的系统提示词整段替换预设自带的那段（列结构不变）。
    const [systemPromptOpen, setSystemPromptOpen] = useState(false);
    // 是否已自定义：决定 chip 的高亮态与是否显示「恢复预设提示词」。
    const hasCustomSystemPrompt = hasScriptSystemPromptOverride(node.metadata?.scriptSystemPrompt);

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
    // 「添加资产」入口：导入 / 链接 / 生成三条里有一条能用就显示。
    const showAssetEntry = Boolean(onImportAssets || onLinkAssets || onGenerateAsset);
    // 「镜头图」列：逐镜关联图片。导入 / 关联 / 生成三条路有一条能用就显示这一列。
    const showRowImage = Boolean(onRowAssetsChange || onRowAssetImport || onRowAssetGenerate);
    // 「按镜按资产」图位：资产列（角色1 / 场景 / 道具 / 人物站位）格子里的缩略图 + 「+」。
    const showCellAssets = Boolean(onCellAssetsChange || onCellAssetImport || onCellAssetGenerate);
    // 缩略图 / 标题查表（按节点 id）。节点被删后取不到，渲染时会退化成占位图标。
    const imageLookup = useMemo(() => {
        const map = new Map<string, ScriptAssetCandidate>();
        for (const item of imageCandidates || []) map.set(item.id, item);
        return map;
    }, [imageCandidates]);

    // ---- 资产池缩略图：拖拽换位 + 解除链接 ----
    // 拖拽只认「从缩略图本体发起」的 HTML5 drag，且用私有 MIME 类型（不是 text/plain）——
    // 否则画布的落区会把它当成从系统拖进来的文字，凭空建一个文本节点。
    // 缩略图上的 click 仍是「轮转资产分类」：浏览器在真实拖拽结束后不会补发 click，两者不打架。
    const [dragAssetIndex, setDragAssetIndex] = useState<number | null>(null);
    const [dropAssetIndex, setDropAssetIndex] = useState<number | null>(null);
    const dragAssetIndexRef = useRef<number | null>(null);

    const handleAssetDragStart = (event: ReactDragEvent, index: number) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-canvas-script-asset-reorder", String(index));
        dragAssetIndexRef.current = index;
        setDragAssetIndex(index);
        setDropAssetIndex(null);
    };

    const handleAssetDragOver = (event: ReactDragEvent, index: number) => {
        if (dragAssetIndexRef.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (dropAssetIndex !== index) setDropAssetIndex(index);
    };

    const handleAssetDrop = (event: ReactDragEvent, targetIndex: number) => {
        event.preventDefault();
        event.stopPropagation();
        const rawFrom = dragAssetIndexRef.current ?? Number(event.dataTransfer.getData("application/x-canvas-script-asset-reorder"));
        dragAssetIndexRef.current = null;
        setDragAssetIndex(null);
        setDropAssetIndex(null);
        if (!onReorderScriptAssets) return;
        if (!Number.isFinite(rawFrom) || rawFrom < 0 || rawFrom >= activeReferences.length || rawFrom === targetIndex) return;
        const next = [...activeReferences];
        const [moved] = next.splice(rawFrom, 1);
        next.splice(targetIndex, 0, moved);
        onReorderScriptAssets(
            node.id,
            next.map((reference) => reference.nodeId),
        );
    };

    const handleAssetDragEnd = () => {
        dragAssetIndexRef.current = null;
        setDragAssetIndex(null);
        setDropAssetIndex(null);
    };

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
        // 签名带行数、单元格总字数与基准字号：增删行、改字、调字号都会变，纯切换视图不会。
        const signature = `${presetId}:${baseFontSize}:${columns.length}:${rows.length}:${rows.reduce((sum, row) => sum + columns.reduce((acc, column) => acc + String(row[column.key] ?? "").length, 0), 0)}`;
        if (signature === lastAutoSizeKeyRef.current) return;
        const chromeHeight = Math.max(0, shell.clientHeight - body.clientHeight);
        const width = Math.round(Math.min(AUTO_SIZE_MAX_WIDTH, Math.max(AUTO_SIZE_MIN_WIDTH, tableWidth + AUTO_SIZE_PADDING_X)));
        const height = Math.round(Math.min(AUTO_SIZE_MAX_HEIGHT, Math.max(AUTO_SIZE_MIN_HEIGHT, chromeHeight + contentHeight + 2)));
        lastAutoSizeKeyRef.current = signature;
        onConfigChange(node.id, { scriptAutoSizeKey: signature });
        if (Math.abs(width - node.width) < 8 && Math.abs(height - node.height) < 8) return;
        onNodeSizeChange(node.id, width, height);
    }, [baseFontSize, columns, fullscreen, isRunning, node.height, node.id, node.width, onConfigChange, onNodeSizeChange, presetId, rows, tableWidth, view]);

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
        // 镜号会整体前移，逐镜图片的关联键必须跟着挪，否则「第 5 镜的图」会落到新的第 5 镜上。
        const deletedShotNo = rows[rowIndex]?.shot_no ?? rowIndex + 1;
        patchMetadata({
            scriptRows: next,
            scriptRowAssets: shiftStoryScriptRowAssetsAfterDelete(node.metadata?.scriptRowAssets, deletedShotNo),
            // 「按镜按资产」的键里也有镜号，同样要跟着前移。
            scriptCellAssets: shiftStoryScriptCellAssetsAfterDelete(node.metadata?.scriptCellAssets, deletedShotNo),
        });
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

    /**
     * 字号档位开关。分镜表是十几列的宽表，小屏读不动、大屏又太挤，所以给个「A− / 13 / A+」。
     * 用自绘按钮而不是 antd 组件：画布浮层会被自身 pointerdown 吞掉（见项目备忘）。
     * 档位写进 `metadata.scriptFontSize`，外壳的基准 font-size 与全表的 em 字号都跟着走。
     */
    const fontSizeStepper = (
        <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1 py-0.5"
            style={{ borderColor: theme.node.stroke, background: `${theme.toolbar.panel}aa`, color: theme.node.text }}
            title={t("canvas.scriptNode.fontSizeHint")}
        >
            <button
                type="button"
                className="grid size-6 shrink-0 place-items-center rounded-full transition hover:opacity-100 disabled:opacity-30"
                style={{ opacity: 0.8 }}
                disabled={smallerFontSize === null}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    if (smallerFontSize !== null) patchMetadata({ scriptFontSize: smallerFontSize });
                }}
                title={t("canvas.nodeToolbar.decreaseFont")}
                aria-label={t("canvas.nodeToolbar.decreaseFont")}
            >
                <Minus className="size-3.5" />
            </button>
            <span className="min-w-5 text-center text-[0.8em] font-medium tabular-nums opacity-75">{baseFontSize}</span>
            <button
                type="button"
                className="grid size-6 shrink-0 place-items-center rounded-full transition hover:opacity-100 disabled:opacity-30"
                style={{ opacity: 0.8 }}
                disabled={largerFontSize === null}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    if (largerFontSize !== null) patchMetadata({ scriptFontSize: largerFontSize });
                }}
                title={t("canvas.nodeToolbar.increaseFont")}
                aria-label={t("canvas.nodeToolbar.increaseFont")}
            >
                <Plus className="size-3.5" />
            </button>
        </span>
    );

    const header = (
        <div
            className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5 pt-2"
            style={{ fontSize: `${HEADER_FONT_SCALE}em` }}
            onMouseDown={stopIfInteractive}
            onPointerDown={stopIfInteractive}
        >
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium opacity-85" style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke }}>
                <ScrollText className="size-4" />
                {t("canvas.scriptNode.title")}
            </span>
            <span className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[0.8em] opacity-80" style={{ borderColor: theme.node.stroke }} title={t(`canvas.scriptNode.preset_${presetId}_hint`)}>
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

            {fontSizeStepper}

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

    // 字号写在各文本节点上、不写在容器上：里面的「复制原文」按钮是更小的一档（0.846em），
    // 容器若也带 font-size，em 会连乘，按钮会比预期小一圈。
    const errorBanner =
        scriptStatus === "error" && !isRunning && node.metadata?.errorDetails ? (
            <div className="mx-2 mb-1.5 shrink-0 rounded-lg border px-2 py-1.5 leading-snug" style={{ borderColor: "#dc2626", background: "#dc26261a", color: theme.node.text }}>
                <div className="text-[0.923em] font-medium">{t("canvas.scriptNode.errorTitle")}</div>
                <div className="mt-0.5 text-[0.923em] opacity-80">{node.metadata.errorDetails}</div>
                {scriptRaw ? (
                    <button type="button" className="mt-1 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.846em]" style={{ borderColor: theme.node.stroke }} onClick={() => copyValue(scriptRaw)}>
                        <Copy className="size-3" />
                        {t("canvas.scriptNode.copyRaw")}
                    </button>
                ) : null}
            </div>
        ) : null;

    const runningPanel = (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
            <div className="flex shrink-0 items-center gap-2 text-[1em] opacity-75" style={{ color: theme.node.text }}>
                <Loader2 className="size-4 animate-spin" />
                {t("canvas.scriptNode.generating")}
            </div>
            <pre className="thin-scrollbar min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border p-2 text-[0.923em] leading-relaxed opacity-70" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}>
                {scriptRaw || "…"}
            </pre>
        </div>
    );

    // 引用条：编号缩略图 + 资产分类（对应剧集画布 ScriptReferencesRow）。
    //  - 图片 / 视频 / 音频：胶囊可点，点一下就在「角色 → 场景 → 道具 → 站位图 → 音频」之间轮转（铺链路时决定这条素材连到哪些镜）；
    //  - 文本：只作为剧本原文来源，不参与分类。
    // 用自绘胶囊而不是 antd Select：画布浮层会被自身 pointerdown 吞掉（见项目备忘）。
    const classifiableReferences = activeReferences.filter((reference) => reference.kind === "image" || reference.kind === "video" || reference.kind === "audio");
    const referencesRow = activeReferences.length ? (
        <div className="flex shrink-0 flex-col gap-0.5">
            {classifiableReferences.length ? (
                // 同理：容器不挂 font-size，两段文字各挂各的档，避免 em 连乘。
                <div className="flex flex-wrap items-center gap-1.5 opacity-60" style={{ color: theme.node.text }}>
                    <span className="text-[0.923em]">{t("canvas.scriptNode.assetRoleLabel")}</span>
                    {onAssetRoleChange ? <span className="text-[0.846em] opacity-90">· {t("canvas.scriptNode.assetRoleHint")}</span> : null}
                </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
                {activeReferences.map((reference, index) => {
                    const preview = reference.kind === "video" || reference.kind === "audio" ? undefined : reference.previewUrl;
                    const classifiable = reference.kind === "image" || reference.kind === "video" || reference.kind === "audio";
                    const role = resolveScriptAssetRole(assetRoles?.[reference.nodeId]);
                    // 拖拽换位 / 解除链接只在有上层回调时启用（别的节点复用这个内容区时可能没有）。
                    const reorderable = Boolean(onReorderScriptAssets);
                    const isDropTarget = dropAssetIndex === index && dragAssetIndex !== null && dragAssetIndex !== index;
                    const dragProps = reorderable
                        ? {
                              draggable: true,
                              onDragStart: (event: ReactDragEvent) => handleAssetDragStart(event, index),
                              onDragEnd: handleAssetDragEnd,
                          }
                        : {};
                    const thumb = (
                        <span
                            className={`relative flex size-12 items-center justify-center overflow-hidden rounded-md border ${reorderable ? "cursor-grab active:cursor-grabbing" : ""}`}
                            style={{ borderColor: isDropTarget ? "#0ea5e9" : theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                            {...dragProps}
                        >
                            {preview ? (
                                // 图片自带 native drag（拖出来是半透明快照），必须关掉，否则抢走缩略图的拖拽换位。
                                <img src={preview} alt={reference.title} draggable={false} className="size-full object-cover" />
                            ) : reference.kind === "video" ? (
                                <Video className="size-5" />
                            ) : reference.kind === "audio" ? (
                                <Music2 className="size-5" />
                            ) : reference.kind === "text" ? (
                                <span className="text-[0.923em] font-semibold">T</span>
                            ) : (
                                <FileText className="size-5" />
                            )}
                            <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-black/45 px-0.5 text-[0.692em] leading-none text-white">{index + 1}</span>
                            {reorderable ? (
                                // 抓手提示：底部一条细横条，一眼看出「这个能拖」。
                                <span className="pointer-events-none absolute inset-x-0 bottom-0 flex h-3 items-center justify-center bg-black/35 text-white opacity-0 transition group-hover/asset:opacity-100">
                                    <GripVertical className="size-2.5" />
                                </span>
                            ) : null}
                        </span>
                    );
                    return (
                        <span
                            key={reference.nodeId}
                            className={`group/asset relative flex flex-col items-center gap-0.5 rounded-md ${isDropTarget ? "ring-2 ring-sky-500" : ""}`}
                            title={reorderable ? `${reference.title} · ${t("canvas.scriptNode.poolAssetReorderHint")}` : reference.title}
                            onDragOver={reorderable ? (event: ReactDragEvent) => handleAssetDragOver(event, index) : undefined}
                            onDrop={reorderable ? (event: ReactDragEvent) => handleAssetDrop(event, index) : undefined}
                        >
                            {classifiable && onAssetRoleChange ? (
                                <button
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
                                    <span className="text-[0.769em] leading-none opacity-75">{t(`canvas.scriptNode.assetRole_${role}`)}</span>
                                </button>
                            ) : (
                                <span className="flex flex-col items-center gap-0.5">{thumb}</span>
                            )}
                            {onRemoveScriptAsset ? (
                                <button
                                    type="button"
                                    className="absolute -right-1 -top-1 z-10 flex size-4 cursor-pointer items-center justify-center rounded-full border opacity-70 shadow-sm transition hover:scale-110 hover:opacity-100"
                                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onRemoveScriptAsset(node.id, reference.nodeId);
                                    }}
                                    title={t("canvas.scriptNode.poolAssetRemove")}
                                >
                                    <X className="size-2.5" />
                                </button>
                            ) : null}
                        </span>
                    );
                })}
            </div>
        </div>
    ) : null;

    // 「+ 添加资产」按钮：编辑视图与表格视图**都要有**。
    // 表格视图才是用户平时看的地方 —— 之前入口只放在编辑视图里，用户在表格上根本找不到
    // 「导入图片 / 链接图片」，看起来就像「这个表不能加图」。
    const assetEntryRow = showAssetEntry ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[0.923em] transition"
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
                <span className="text-[0.846em] opacity-55" style={{ color: theme.node.text }}>
                    {t("canvas.scriptNode.assetCandidateHint", { count: assetCandidates.length })}
                </span>
            ) : null}
            {/* 资产锁定：一旦有「资产名 → 图片」的锁，就在入口旁边挂一个总开关（点它可一键全解）。 */}
            {Object.keys(nameLocks || {}).length && onClearNameLocks ? (
                <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[0.923em] transition"
                    style={{ borderColor: theme.toolbar.activeBg, color: theme.toolbar.activeBg, background: `${theme.toolbar.activeBg}14` }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        modal.confirm({
                            title: t("canvas.scriptNode.nameLockClearConfirmTitle"),
                            content: t("canvas.scriptNode.nameLockClearConfirmBody"),
                            okText: t("canvas.scriptNode.nameLockClear"),
                            cancelText: t("common.cancel"),
                            onOk: () => {
                                onClearNameLocks(node.id);
                                message.success(t("canvas.scriptNode.nameLockCleared"));
                            },
                        });
                    }}
                    title={t("canvas.scriptNode.nameLockClear")}
                >
                    <Lock className="size-3.5" />
                    {t("canvas.scriptNode.nameLockCount", { count: Object.keys(nameLocks || {}).length })}
                </button>
            ) : null}
        </div>
    ) : null;

    // 表格视图顶部的「引用条 + 资产入口」：已链接的素材缩略图在这里也能看到、也能点分类胶囊轮转。
    const assetToolbar =
        activeReferences.length || assetEntryRow ? (
            <div className="flex shrink-0 flex-col gap-1 pb-1.5">
                {referencesRow}
                {assetEntryRow}
            </div>
        ) : null;

    const tryActions =
        showTryActions && onScriptAction ? (
            <div className="shrink-0">
                <div className="text-[0.923em] opacity-60" style={{ color: theme.node.text }}>
                    {t("canvas.scriptNode.tryLabel")}
                </div>
                <div className="mt-1 flex flex-col">
                    {SCRIPT_ACTIONS.map((action) => {
                        const Icon = action.Icon;
                        return (
                            <button
                                key={action.key}
                                type="button"
                                className="inline-flex items-center gap-2 self-start rounded-lg px-1.5 py-1.5 text-left text-[1em] transition hover:opacity-100"
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
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[0.923em]" style={{ color: theme.node.text }}>
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
            <span className="mx-0.5 h-4 w-px shrink-0" style={{ background: theme.node.stroke, opacity: 0.6 }} />
            <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded-full border px-2.5 transition"
                style={{
                    borderColor: theme.node.stroke,
                    background: hasCustomSystemPrompt ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`,
                    color: hasCustomSystemPrompt ? theme.toolbar.activeText : theme.node.text,
                    opacity: hasCustomSystemPrompt ? 1 : 0.7,
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    setSystemPromptOpen(true);
                }}
                title={t("canvas.scriptNode.customPromptHint")}
            >
                <ScrollText className="size-3.5" />
                {hasCustomSystemPrompt ? t("canvas.scriptNode.customPromptActive") : t("canvas.scriptNode.customPrompt")}
            </button>
            {hasCustomSystemPrompt ? (
                <button
                    type="button"
                    className="inline-flex h-6 items-center rounded-full border px-2.5 transition"
                    style={{ borderColor: theme.node.stroke, background: `${theme.toolbar.panel}aa`, color: theme.node.text, opacity: 0.7 }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        patchMetadata({ scriptSystemPrompt: undefined });
                        message.success(t("canvas.scriptNode.customPromptResetDone"));
                    }}
                    title={t("canvas.scriptNode.customPromptReset")}
                >
                    {t("canvas.scriptNode.customPromptReset")}
                </button>
            ) : null}
        </div>
    );

    // 「每段时长」：视频模型按 10s / 15s 成片。选 10 / 15 后会在生成任务里要求模型按这个长度规划
    // 连续镜头，铺链路时还可以选「按每段时长」把它们自动合并成一个视频节点。
    const segmentSeconds = resolveStoryScriptSegmentSeconds(node.metadata?.scriptSegmentSeconds);
    const segmentSelector = (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[0.923em]" style={{ color: theme.node.text }}>
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
            <div className="flex shrink-0 items-center gap-2 text-[0.923em] opacity-60" style={{ color: theme.node.text }}>
                <span>{t("canvas.scriptNode.sourceLabel")}</span>
                {connectedTextCount ? <span>· {t("canvas.scriptNode.connectedHint", { count: connectedTextCount })}</span> : null}
            </div>
            {referencesRow}
            {assetEntryRow}
            <textarea
                data-canvas-text-input
                data-canvas-no-zoom
                className="thin-scrollbar min-h-0 flex-1 resize-none rounded-xl border px-2 py-1.5 text-[1em] leading-relaxed outline-none"
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
                className="shrink-0 rounded-xl border px-2 py-1.5 text-[1em] outline-none"
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
                <button type="button" className="shrink-0 self-start rounded-full border px-2.5 py-1 text-[0.923em]" style={{ borderColor: theme.node.stroke }} onClick={() => setView("table")}>
                    <Table2 className="mr-1 inline size-3" />
                    {t("canvas.scriptNode.viewTable")}
                </button>
            ) : null}
        </div>
    );

    // 全屏时表体放宽 + 字号上调：经典预设 16 列约 2.6k px，节点里只能横向滚着看。
    const tableStyle = fullscreen
        ? { width: "100%", minWidth: tableWidth, tableLayout: "fixed" as const, fontSize: `${HEADER_FONT_SCALE}em`, color: theme.node.text }
        : { width: tableWidth, tableLayout: "fixed" as const, fontSize: "1em", color: theme.node.text };

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
            {assetToolbar}
            <div ref={bodyRef} data-canvas-no-zoom className="thin-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                <table ref={tableRef} className="border-separate border-spacing-0 leading-snug" style={tableStyle}>
                    <colgroup>
                        {showRowImage ? <col style={{ width: ROW_IMAGE_COLUMN_WIDTH }} /> : null}
                        {columns.map((column) => (
                            <col key={column.key} style={{ width: column.width }} />
                        ))}
                        <col style={{ width: TABLE_ACTION_WIDTH }} />
                    </colgroup>
                    <thead>
                        <tr>
                            {showRowImage ? (
                                <th
                                    className="sticky top-0 z-10 border-b px-2 py-1.5 text-left font-semibold whitespace-nowrap"
                                    style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}
                                    title={t("canvas.scriptNode.rowImageColumnHint")}
                                >
                                    {t("canvas.scriptNode.rowImageColumn")}
                                </th>
                            ) : null}
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
                                {showRowImage ? (
                                    // 「镜头图」：这一镜关联的图片缩略图（点 × 解绑，点 + 打开逐镜弹窗）。
                                    // 它不参与解析 / 导出，只是把「这一镜用哪张图」这条关系画在表里。
                                    <td className="border-b px-1.5 py-1" style={{ borderColor: theme.node.stroke }}>
                                        <div className="flex flex-wrap items-center gap-1">
                                            {scriptRowAssetIds(rowAssets, row.shot_no || rowIndex + 1).map((imageId) => {
                                                const meta = imageLookup.get(imageId);
                                                // 缩略图放大 3×（原 size-9 = 36px → size-27 = 108px）：表里的图太小看不清。
                                                return (
                                                    <span
                                                        key={imageId}
                                                        className="group relative flex size-27 shrink-0 items-center justify-center overflow-hidden rounded-md border"
                                                        style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                                                        title={meta?.title || imageId}
                                                    >
                                                        {meta?.previewUrl ? <img src={meta.previewUrl} alt={meta.title} className="size-full object-cover" /> : <ImageIcon className="size-6" />}
                                                        {onRowAssetsChange ? (
                                                            <button
                                                                type="button"
                                                                className="absolute right-0 top-0 hidden size-6 items-center justify-center rounded-bl-md bg-black/60 text-white group-hover:flex"
                                                                onMouseDown={(event) => event.stopPropagation()}
                                                                onPointerDown={(event) => event.stopPropagation()}
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    onRowAssetsChange(
                                                                        node.id,
                                                                        row.shot_no || rowIndex + 1,
                                                                        scriptRowAssetIds(rowAssets, row.shot_no || rowIndex + 1).filter((id) => id !== imageId),
                                                                    );
                                                                }}
                                                                title={t("canvas.scriptNode.rowImageRemove")}
                                                            >
                                                                <X className="size-3" />
                                                            </button>
                                                        ) : null}
                                                    </span>
                                                );
                                            })}
                                            <button
                                                type="button"
                                                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setRowAssetTarget({ shotNo: row.shot_no || rowIndex + 1, ids: scriptRowAssetIds(rowAssets, row.shot_no || rowIndex + 1) });
                                                }}
                                                title={scriptRowAssetIds(rowAssets, row.shot_no || rowIndex + 1).length ? t("canvas.scriptNode.rowImageEdit") : t("canvas.scriptNode.rowImageAdd")}
                                            >
                                                <Plus className="size-3" />
                                            </button>
                                        </div>
                                    </td>
                                ) : null}
                                {columns.map((column) => {
                                    const value = String(row[column.key] ?? "");
                                    // 「按镜按资产」图位：只挂在资产列（角色1 / 角色2 / 场景 / 道具 / 人物站位）上。
                                    // 这一格的图**只属于这一镜的这一列**，铺链路时也只连到这一镜的图片 / 视频节点。
                                    const cellShotNo = row.shot_no || rowIndex + 1;
                                    // 这一格**自己**挂的图：精准指定，只属于这一镜的这一列。
                                    const cellIds = scriptCellAssetIds(cellAssets, cellShotNo, column.key);
                                    const showCellSlot = showCellAssets && isScriptAssetColumn(column.key);
                                    // 资产锁定：这一格的**资产名**（「张三」「客厅」）一旦被锁到某张图上，
                                    // 表里**别的镜**再出现同一个名字就直接显示同一张图 —— 也就是「同样的资产名
                                    // 只链接一次，就落到所有小格子里」。口径与铺链路的 `scriptShotPreciseAssetRefs`
                                    // 完全一致：**格子图优先、名字锁兜底**（格子自己挂了图就听格子的）。
                                    const cellName = scriptNameLockName(row[column.key]);
                                    const cellLockIds = cellName ? scriptNameLockIds(nameLocks, cellName) : [];
                                    const cellLocked = cellLockIds.length > 0;
                                    const cellFromLock = cellIds.length === 0 && cellLockIds.length > 0;
                                    const cellDisplayIds = cellIds.length ? cellIds : cellLockIds;
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
                                            {showCellSlot ? (
                                                <div className="mt-1 flex flex-wrap items-center gap-1" onDoubleClick={(event) => event.stopPropagation()}>
                                                    {cellDisplayIds.map((imageId) => {
                                                        const meta = imageLookup.get(imageId);
                                                        // 缩略图放大 3×（原 size-7 = 28px → size-21 = 84px）：表里的图太小看不清。
                                                        return (
                                                            <span
                                                                key={imageId}
                                                                className="group relative flex size-21 shrink-0 items-center justify-center overflow-hidden rounded-md border"
                                                                style={{
                                                                    borderColor: cellLocked ? theme.toolbar.activeBg : theme.node.stroke,
                                                                    background: theme.node.fill,
                                                                    color: theme.node.text,
                                                                    // 这个资产名已上锁 → 缩略图描一圈高亮边，一眼看出「已经锁定」。
                                                                    boxShadow: cellLocked ? `0 0 0 1px ${theme.toolbar.activeBg}` : undefined,
                                                                }}
                                                                title={
                                                                    cellFromLock
                                                                        ? t("canvas.scriptNode.cellAssetFromNameLock", { name: cellName })
                                                                        : cellLocked
                                                                          ? t("canvas.scriptNode.nameLockTag", { name: cellName })
                                                                          : meta?.title || imageId
                                                                }
                                                            >
                                                                {meta?.previewUrl ? <img src={meta.previewUrl} alt={meta.title} className="size-full object-cover" /> : <ImageIcon className="size-6" />}
                                                                {cellFromLock ? (
                                                                    // 这一格的图不是「格子自己的链接」，而是同名的资产锁落下来的 —— 挂个小锁标。
                                                                    <span className="absolute left-0 top-0 flex size-5 items-center justify-center rounded-br-md bg-black/55 text-white">
                                                                        <Lock className="size-3" />
                                                                    </span>
                                                                ) : null}
                                                                {cellFromLock ? (
                                                                    // 锁来的图：点 × 是「解开这个资产名的锁」（格子自己没有链接可删）。
                                                                    onNameLockChange ? (
                                                                        <button
                                                                            type="button"
                                                                            className="absolute right-0 top-0 hidden size-6 items-center justify-center rounded-bl-md bg-black/60 text-white group-hover:flex"
                                                                            onMouseDown={(event) => event.stopPropagation()}
                                                                            onPointerDown={(event) => event.stopPropagation()}
                                                                            onClick={(event) => {
                                                                                event.stopPropagation();
                                                                                onNameLockChange(node.id, cellName, []);
                                                                            }}
                                                                            title={t("canvas.scriptNode.nameLockToggleOff", { name: cellName })}
                                                                        >
                                                                            <X className="size-3" />
                                                                        </button>
                                                                    ) : null
                                                                ) : onCellAssetsChange ? (
                                                                    <button
                                                                        type="button"
                                                                        className="absolute right-0 top-0 hidden size-6 items-center justify-center rounded-bl-md bg-black/60 text-white group-hover:flex"
                                                                        onMouseDown={(event) => event.stopPropagation()}
                                                                        onPointerDown={(event) => event.stopPropagation()}
                                                                        onClick={(event) => {
                                                                            event.stopPropagation();
                                                                            onCellAssetsChange(node.id, cellShotNo, column.key, cellIds.filter((id) => id !== imageId));
                                                                        }}
                                                                        title={t("canvas.scriptNode.cellAssetRemove")}
                                                                    >
                                                                        <X className="size-3" />
                                                                    </button>
                                                                ) : null}
                                                            </span>
                                                        );
                                                    })}
                                                    <button
                                                        type="button"
                                                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition hover:opacity-100"
                                                        style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                        onMouseDown={(event) => event.stopPropagation()}
                                                        onPointerDown={(event) => event.stopPropagation()}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            setCellAssetTarget({ shotNo: cellShotNo, columnKey: column.key, label: column.label, ids: cellDisplayIds });
                                                        }}
                                                        title={cellDisplayIds.length ? t("canvas.scriptNode.cellAssetEdit", { label: column.label }) : t("canvas.scriptNode.cellAssetAdd", { label: column.label })}
                                                    >
                                                        <Plus className="size-3" />
                                                    </button>
                                                    {onNameLockChange && cellName ? (
                                                        <button
                                                            type="button"
                                                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition"
                                                            style={{
                                                                borderColor: cellLocked ? theme.toolbar.activeBg : theme.node.stroke,
                                                                background: cellLocked ? `${theme.toolbar.activeBg}1f` : "transparent",
                                                                color: cellLocked ? theme.toolbar.activeBg : theme.node.text,
                                                                opacity: cellLocked ? 1 : 0.75,
                                                            }}
                                                            onMouseDown={(event) => event.stopPropagation()}
                                                            onPointerDown={(event) => event.stopPropagation()}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                // 已锁 → 解锁；未锁 → 把这一格当前的图锁成「这个资产名 → 这几张图」。
                                                                if (cellLocked) {
                                                                    onNameLockChange(node.id, cellName, []);
                                                                    return;
                                                                }
                                                                if (!cellDisplayIds.length) {
                                                                    message.warning(t("canvas.scriptNode.nameLockNeedImage", { name: cellName }));
                                                                    return;
                                                                }
                                                                onNameLockChange(node.id, cellName, cellDisplayIds);
                                                            }}
                                                            title={cellLocked ? t("canvas.scriptNode.nameLockToggleOff", { name: cellName }) : t("canvas.scriptNode.nameLockToggleOn", { name: cellName })}
                                                        >
                                                            {cellLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            ) : null}
                                        </td>
                                    );
                                })}
                                <td className="border-b px-1 py-1" style={{ borderColor: theme.node.stroke }}>
                                    <div className="flex items-center gap-1">
                                        {preset.rowActions.map((action) => (
                                            <button
                                                key={action.key}
                                                type="button"
                                                className="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[0.846em] transition hover:opacity-100"
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
                                        {onRegenerateShot ? (
                                            <button
                                                type="button"
                                                className="inline-flex size-6 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={() => onRegenerateShot(node.id, rowIndex)}
                                                title={t("canvas.scriptNode.regenShot")}
                                            >
                                                <RotateCcw className="size-3" />
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
            <div className="mt-1 flex shrink-0 flex-wrap items-center gap-1.5 text-[0.923em]" style={{ color: theme.node.text }}>
                <span className="rounded border px-1.5 opacity-90" style={{ borderColor: theme.node.stroke }}>
                    {t(`canvas.scriptNode.preset_${presetId}`)}
                </span>
                <span className="opacity-55">
                    {scriptTitle ? `${scriptTitle} · ` : ""}
                    {t("canvas.scriptNode.shotCount", { count: rows.length })} · {t("canvas.scriptNode.totalDuration", { seconds: totalDuration })}
                </span>
                {mergeSelector}
                <div className="ml-auto flex items-center gap-1.5">
                    {onRegenerateAll ? (
                        <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 transition hover:opacity-100"
                            style={{ borderColor: theme.node.stroke, opacity: 0.85 }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                modal.confirm({
                                    title: t("canvas.scriptNode.regenAllConfirm"),
                                    okText: t("canvas.scriptNode.regenAll"),
                                    cancelText: t("common.cancel"),
                                    onOk: () => onRegenerateAll(node.id),
                                });
                            }}
                            title={t("canvas.scriptNode.regenAllHint")}
                        >
                            <RotateCcw className="size-3.5" />
                            {t("canvas.scriptNode.regenAll")}
                        </button>
                    ) : null}
                    {onBuildPipeline ? (
                        <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-medium text-white transition"
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
        </div>
    );

    const editingColumn = editing ? columns.find((column) => column.key === editing.key) : undefined;
    const editingValue = editing ? String(rows[editing.rowIndex]?.[editing.key] ?? "") : "";

    // 直接把文件从系统拖到脚本节点上就能导入素材（省掉「添加资产 → 上传文件 → 选文件」三步）。
    // 只认 OS 拖进来的文件（`dataTransfer.types` 含 "Files"），不会跟节点拖动打架（那是 pointer 事件）。
    // 默认归到「角色」，落进来后用引用条上的胶囊一格格改成场景 / 道具 / 站位图 / 音频。
    const dropZone = onImportAssets
        ? {
              onDragOver: (event: ReactDragEvent<HTMLElement>) => {
                  if (!event.dataTransfer?.types?.includes("Files")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!fileDragging) setFileDragging(true);
              },
              onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setFileDragging(false);
              },
              onDrop: (event: ReactDragEvent<HTMLElement>) => {
                  if (!event.dataTransfer?.types?.includes("Files")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setFileDragging(false);
                  const files = Array.from(event.dataTransfer.files || []).filter(isAssetFile);
                  if (!files.length) return;
                  onImportAssets(node.id, files, "character");
              },
          }
        : {};

    const shell = (
        <div
            ref={shellRef}
            className={`relative flex h-full w-full flex-col overflow-hidden ${fullscreen ? "" : "cursor-move"}`}
            style={{ color: theme.node.text, fontSize: `${baseFontSize}px` }}
            onMouseDown={stopIfInteractive}
            onPointerDown={stopIfInteractive}
            {...dropZone}
        >
            {header}
            {errorBanner}
            {isRunning ? runningPanel : view === "table" && rows.length ? tablePanel : sourcePanel}
            {fileDragging ? (
                <div
                    className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed px-3 text-center text-[0.923em]"
                    style={{ borderColor: theme.toolbar.activeBg, background: `${theme.node.fill}f2`, color: theme.toolbar.activeBg }}
                >
                    {t("canvas.scriptNode.assetDropNode", { role: t("canvas.scriptNode.assetRole_character") })}
                </div>
            ) : null}
        </div>
    );

    const assetDialog = showAssetEntry ? (
        <CanvasScriptAssetDialog
            open={assetDialogOpen}
            theme={theme}
            candidates={assetCandidates || []}
            rows={rows}
            onClose={() => setAssetDialogOpen(false)}
            onLink={(links) => onLinkAssets?.(node.id, links)}
            onImport={(files, role) => onImportAssets?.(node.id, files, role)}
            onGenerate={onGenerateAsset ? (role, prompt, title) => onGenerateAsset(node.id, role, prompt, title) : undefined}
        />
    ) : null;

    // 逐镜「镜头图」弹窗：只给这一镜关联图片。分类 / 按描述生图都不适用，所以走 rowMode。
    // 三条路的回调都直接交给上层（project.tsx 负责建节点并把 id 写回 metadata.scriptRowAssets）。
    const rowAssetDialog = rowAssetTarget ? (
        <CanvasScriptAssetDialog
            open
            theme={theme}
            candidates={imageCandidates || []}
            rows={rows}
            onClose={() => setRowAssetTarget(null)}
            onLink={() => undefined}
            onImport={() => undefined}
            rowMode={{
                no: rowAssetTarget.shotNo,
                selectedIds: rowAssetTarget.ids,
                prompt: preset.buildShotPrompts(rows.find((row) => (row.shot_no || 0) === rowAssetTarget.shotNo) || { shot_no: rowAssetTarget.shotNo, duration: 0 }).imagePrompt,
                title: t("canvas.scriptNode.pipelineImage", { no: rowAssetTarget.shotNo }),
                onLink: (nodeIds) => onRowAssetsChange?.(node.id, rowAssetTarget.shotNo, nodeIds),
                onImport: (files) => onRowAssetImport?.(node.id, rowAssetTarget.shotNo, files),
                onGenerate: onRowAssetGenerate ? (prompt, title) => onRowAssetGenerate(node.id, rowAssetTarget.shotNo, prompt, title) : undefined,
            }}
        />
    ) : null;

    // 「按镜按资产」弹窗：给某一镜的某一个资产列（角色1 / 角色2 / 场景 / 道具 / 人物站位）挂图。
    // 与「镜头图」共用同一个弹窗组件，只是多带了 columnKey / label / candidate —— 生成 tab 的默认
    // 提示词因此收敛到「这一镜这一列」的描述，而不是整表汇总出来的候选。
    const cellAssetDialog = cellAssetTarget ? (
        <CanvasScriptAssetDialog
            open
            theme={theme}
            candidates={imageCandidates || []}
            rows={rows}
            poolAssets={poolAssets}
            onClose={() => setCellAssetTarget(null)}
            onLink={() => undefined}
            onImport={() => undefined}
            rowMode={{
                no: cellAssetTarget.shotNo,
                columnKey: cellAssetTarget.columnKey,
                label: cellAssetTarget.label,
                selectedIds: cellAssetTarget.ids,
                candidate: collectScriptCellPromptCandidate(cellAssetTarget.columnKey, rows.find((row) => (row.shot_no || 0) === cellAssetTarget.shotNo) || null),
                title: t("canvas.scriptNode.cellAssetDialogTitle", { no: cellAssetTarget.shotNo, label: cellAssetTarget.label }),
                model: cellModel,
                onModelChange: (model) => onCellModelChange?.(node.id, model),
                onLink: (nodeIds) => onCellAssetsChange?.(node.id, cellAssetTarget.shotNo, cellAssetTarget.columnKey, nodeIds),
                onImport: (files) => onCellAssetImport?.(node.id, cellAssetTarget.shotNo, cellAssetTarget.columnKey, files),
                onGenerate: onCellAssetGenerate
                    ? (prompt, title, model) => onCellAssetGenerate(node.id, cellAssetTarget.shotNo, cellAssetTarget.columnKey, prompt, title, model)
                    : undefined,
            }}
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
                fontSize={Math.round(baseFontSize * (fullscreen ? 1.23 : 1.08))}
                onClose={() => setEditing(null)}
                onSave={(value) => {
                    if (editing) updateRow(editing.rowIndex, editing.key, value);
                    setEditing(null);
                }}
            />
            {/* 自定义系统提示词：沿用文本编辑弹窗（textarea + 字号 + 提示词库），保存留空即恢复预设默认。 */}
            <CanvasTextEditDialog
                open={systemPromptOpen}
                value={node.metadata?.scriptSystemPrompt || getStoryScriptSystemPrompt(presetId)}
                title={t("canvas.scriptNode.customPromptTitle", { preset: t(`canvas.scriptNode.preset_${presetId}`) })}
                placeholder={t("canvas.scriptNode.customPromptPlaceholder", { count: columns.length })}
                onClose={() => setSystemPromptOpen(false)}
                onSave={(value) => {
                    const trimmed = value.trim();
                    patchMetadata({ scriptSystemPrompt: trimmed ? value : undefined });
                    setSystemPromptOpen(false);
                    if (trimmed) message.success(t("canvas.scriptNode.customPromptSaved", { count: trimmed.length }));
                }}
            />
            {assetDialog}
            {rowAssetDialog}
            {cellAssetDialog}
        </>
    );
}
