import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { App, Modal } from "antd";
import copy from "copy-to-clipboard";
import { ArrowDown, ArrowUp, ArrowUpRight, AlignJustify, Copy, FileText, GripVertical, Image as ImageIcon, Loader2, Lock, Maximize2, Minus, Minimize2, Music2, PencilLine, Play, Plus, RotateCcw, ScrollText, Sparkles, Square, Table2, Trash2, Unlock, User, Video, Wand2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CanvasScriptAssetDialog, isAssetFile, type ScriptAssetCandidate, type ScriptAssetLinkSelection, type ScriptAssetPoolAsset, type ScriptRowAssetMode } from "@/components/canvas/canvas-script-asset-dialog";
import { CanvasTextEditDialog } from "@/components/canvas/canvas-text-edit-dialog";
import { buildScriptSchemePrefill, resolveAutoApplyScriptScheme, resolveScriptSchemeId, SCRIPT_SCHEME_IDS, type ScriptSchemeId, type ScriptSchemePrefill } from "@/constant/script-scheme";
import {
    collectScriptCellPromptCandidate,
    collectStoryScriptAssetFillTargets,
    countStoryScriptTemplateShots,
    dropStoryScriptCellAssetColumn,
    dropStoryScriptRowColumn,
    getStoryScriptColumns,
    getStoryScriptColumnsWithExtras,
    getStoryScriptPreset,
    getStoryScriptSystemPrompt,
    groupStoryScriptRows,
    hasScriptGenerationPrompt,
    hasScriptSystemPromptOverride,
    isScriptAssetColumn,
    nextScriptAssetRole,
    nextStoryScriptExtraColumnKey,
    normalizeStoryScriptExtraColumns,
    remapStoryScriptCellAssets,
    remapStoryScriptRowAssets,
    remapStoryScriptRowAudios,
    remapStoryScriptRowNotes,
    reorderStoryScriptRows,
    resolveScriptAssetRole,
    resolveStoryScriptDisplayColumns,
    resolveStoryScriptFontSize,
    resolveStoryScriptMergeMode,
    resolveStoryScriptPresetId,
    resolveStoryScriptSegmentSeconds,
    scriptCellAssetIds,
    scriptNameLockIds,
    scriptNameLockName,
    scriptRowAssetIds,
    scriptRowAudioIds,
    SCRIPT_EXTRA_COLUMN_ROLE_IDS,
    shiftStoryScriptCellAssetsAfterDelete,
    shiftStoryScriptRowAssetsAfterDelete,
    shiftStoryScriptRowAudiosAfterDelete,
    stepStoryScriptFontSize,
    STORY_SCRIPT_MAX_EXTRA_COLUMNS,
    storyScriptExtraColumnsToColumns,
    storyScriptGroupDuration,
    storyScriptRowNote,
    storyScriptToMarkdown,
    storyScriptToTsv,
    STORY_SCRIPT_MERGE_MODES,
    STORY_SCRIPT_PRESET_IDS,
    STORY_SCRIPT_SEGMENT_SECONDS,
    type ScriptAssetRole,
    type StoryScriptExtraColumn,
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
 * 字号：表格是十几列的宽表（经典预设约 2.9k px），基准字号**默认 15px**（20px 时整表太占地方，
 * 用户 2026-10-17 要求降到 15），工具条 23px（1.154 倍），再由画布缩放进退。基准字号可由顶部「A− / A+」调档
 * （`metadata.scriptFontSize`）：外壳挂基准 px，**其余字号一律写成 em**，所以只改一个值就整体缩放。
 *
 * 表格内容默认**完整显示**（不做 line-clamp 截断，见 `showFullText`），但单格正文超过 6 行后
 * 收进**格内滚动**（`TABLE_CELL_MAX_LINES`）：行高由这一行最高的格子决定，长提示词一旦整段铺开，
 * 旁边短内容的格子就全变成留白 —— 这是用户第十五轮反馈「镜头之间间距太大」的根因。
 * 嫌占地方仍可在底部切到「精简」（4 行 + 悬停看全文）。
 *
 * 输出格式由 `metadata.scriptPreset` 决定（见 constant/story-script.ts）：列定义、系统提示词、
 * 行操作按钮全部按预设分派。切换预设会清空已生成的分镜表（原文与补充要求保留），因为两套预设
 * 的列完全不同，旧行在新表里会全空。**生成链路不变**：`runScriptGeneration` 只是多读一个 preset。
 */

/** 顶部工具条字号相对正文基准的倍数（改造前 15px / 13px），跟着基准字号一起缩放。 */
const HEADER_FONT_SCALE = 1.154;
/**
 * 操作列：复制 / 送画布 / 建视频 / 重生成 / 补资产 / 改剧情 / 上移下移 / 删除。
 *
 * 2026-10-17（第十五轮）：这一列改成**右侧吸附**（`sticky right-0`）——经典预设整表约 4.2k px，
 * 操作列在最右边，不吸附就得一路横向拖到底才够得到「补资产 / 重生成」，用户因此只看得见底部的
 * 「整表补齐」。列宽同时 132 → 160、按钮收到 20px，所有按钮两行内排完，不再把每行撑高。
 */
const TABLE_ACTION_WIDTH = 160;
/** 勾选列（批量重生成 / 批量铺视频）的宽度：只有一个圆形勾选按钮。 */
const TABLE_SELECT_WIDTH = 34;
/**
 * 「声音」列宽度。放在**镜号之后**（表宽 4.2k px，最左边只有前几列可见）：
 * 声音是「这一镜配什么音」的最基本信息，跟镜号贴在一起才不用横向滚动就能看到 / 点开。
 * 一格能横排两个音频胶囊（图标 + 截断的名字），再多就换行。
 */
const TABLE_AUDIO_WIDTH = 210;
/**
 * 「镜头图」列已于 2026-10-17 按用户要求从表里移除（`ROW_IMAGE_COLUMN_WIDTH` 同时删除）。
 * `metadata.scriptRowAssets`（逐镜图片）与铺链路对它的处理**都还在**——只是表里不再有这一列入口；
 * 以后要恢复，把 colgroup / thead / tbody 三段各补回来即可（旧的弹窗与回调也还留在本文件里）。
 */

/**
 * 生成后按「内容多少」自动适配节点窗口尺寸的边界。
 * 高度贴合全部行（不再只露三四行）；宽度贴合表格实际宽度，但封顶——经典预设 16 列约 2.9k px，
 * 若真按宽度撑开节点会宽到没法用，所以超出部分仍靠表体横向滚动（配「全屏」看整表）。
 *
 * 高度上限 3200（第十五轮按用户要求「分镜表的长度比现在长 1 倍」从 1600 翻上来）：
 * 配合同轮的行高收紧（格内长文最多 6 行、超出格内滚动），同一窗口能看到的镜头数约翻倍，
 * 二十镜以上的长表也能一次铺开。
 */
const AUTO_SIZE_MIN_WIDTH = 760;
const AUTO_SIZE_MAX_WIDTH = 2200;
const AUTO_SIZE_MIN_HEIGHT = 460;
const AUTO_SIZE_MAX_HEIGHT = 3200;
const AUTO_SIZE_PADDING_X = 24;
/**
 * 单元格正文最多显示几行。行高由「这一行最高的那一格」决定：经典预设的「分镜提示词 /
 * 视频运动提示词」有 440px 宽、动辄三四百字，完整显示会把整行撑到 300px 起 —— 旁边短内容的
 * 格子就剩一大片留白，也就是用户说的「镜头与镜头之间间距太大」。超过这个行数后改成**格内滚动**：
 * 内容一个字不少（悬停有全文 title、双击仍是完整的编辑弹窗），但行高不再被它绑架。
 */
const TABLE_CELL_MAX_LINES = 6;

/**
 * 分镜表表体的滚动位置（横向为主，纵向顺手一起记）。
 *
 * 为什么必须自己记：节点**离开视口就被画布裁剪卸载**（`project.tsx` 的 `visibleNodes`），
 * `bodyRef` 连同它的 `scrollLeft` 一起消失，回来时是全新的 DOM，浏览器只能给 0 ——
 * 用户看到的就是「滑到第 8 列，切走再切回来，又回到最左边」。表宽 2.6k~4.2k px，
 * 每次都要重新横着找列，非常难用。
 *
 * 为什么不用 metadata：滚动是每帧都可能发生的事，逐帧 `onConfigChange` 会让整张画布重渲。
 * 这里跟文本节点 / 通用节点保持同一套做法 —— 落 localStorage，按节点 id 分键。
 */
const SCRIPT_TABLE_SCROLL_KEY = "infinite-atelier:script-table-scroll";

type ScriptTableScrollPosition = { left: number; top: number };

function readScriptTableScroll(nodeId: string): ScriptTableScrollPosition | null {
    try {
        const stored = window.localStorage.getItem(SCRIPT_TABLE_SCROLL_KEY);
        if (!stored) return null;
        const positions = JSON.parse(stored) as Record<string, ScriptTableScrollPosition | undefined>;
        const position = positions[nodeId];
        if (!position) return null;
        const left = Number(position.left);
        const top = Number(position.top);
        if (!Number.isFinite(left) && !Number.isFinite(top)) return null;
        return { left: Number.isFinite(left) ? Math.max(0, left) : 0, top: Number.isFinite(top) ? Math.max(0, top) : 0 };
    } catch {
        return null;
    }
}

function writeScriptTableScroll(nodeId: string, position: ScriptTableScrollPosition) {
    try {
        const stored = window.localStorage.getItem(SCRIPT_TABLE_SCROLL_KEY);
        const positions = stored ? (JSON.parse(stored) as Record<string, ScriptTableScrollPosition>) : {};
        positions[nodeId] = position;
        window.localStorage.setItem(SCRIPT_TABLE_SCROLL_KEY, JSON.stringify(positions));
    } catch {
        // 隐私模式 / 配额满：滚动照常可用，只是记不住位置。
    }
}

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
     * 写入分类并立刻触发生图。`title` 是建出来的节点标题（角色类靠它做名字匹配），
     * `styleTemplateId` 是本次挑的风格模板（落成新节点的风格）。
     */
    onGenerateAsset?: (nodeId: string, role: ScriptAssetRole, prompt: string, title: string, styleTemplateId?: string) => void;
    /** 已链接素材的分类（节点 id → 分类），用于在引用条上回显 / 切换。 */
    assetRoles?: Record<string, string>;
    /** 切换某张已链接素材的分类（角色 / 场景 / 道具 / 站位图）。 */
    onAssetRoleChange?: (nodeId: string, assetNodeId: string, role: ScriptAssetRole) => void;
    /** 一键铺「分镜 → 图片 → 视频」链路。 */
    onBuildPipeline?: (nodeId: string) => void;
    /** 只给某一行分镜建一个视频节点（预填该镜的视频提示词与时长）。 */
    onBuildShotVideo?: (nodeId: string, rowIndex: number) => void;
    /** 勾选多镜后批量建视频节点（每镜一个节点，自带该镜的提示词 / 时长 / 素材连线）。 */
    onBuildShotVideos?: (nodeId: string, rowIndexes: number[]) => void;
    /** 按镜重生成：只重写这一行的全部列（保留 shot_no），并带上一镜 / 下一镜作为上下文。 */
    onRegenerateShot?: (nodeId: string, rowIndex: number) => void;
    /**
     * 批量 / 带要求地重生成：一次重写多镜（串行），`extraPlot` 只作用于这批镜，
     * `keepBlocking === false` 表示这一批镜的人物站位可以重新安排（不必和上下镜一致）。
     */
    onRegenerateRows?: (nodeId: string, rowIndexes: number[], options?: { extraPlot?: string; keepBlocking?: boolean }) => void;
    /** 二次识别补缺失资产：只补这一镜**空着**的资产列，已有内容一个字都不改（append-only）。 */
    onFillShotAssets?: (nodeId: string, rowIndex: number) => void;
    /**
     * 整表补齐资产：把**所有还有缺列**的镜头逐条串行补一遍（跳过不缺的行，一条汇总提示）。
     * 漏资产往往不是单镜的问题，逐镜点太累，所以给一个整表入口。
     */
    onFillAllShotAssets?: (nodeId: string) => void;
    /** 逐镜备注（`metadata.scriptRowNotes`：镜号 → 用户给这一镜追加的剧情 / 修改要求）。 */
    rowNotes?: Record<string, string>;
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
    /** 逐镜 AI 生成图片：建节点、关联到这一镜并立刻触发生图（`styleTemplateId` 是本次挑的风格模板）。 */
    onRowAssetGenerate?: (nodeId: string, shotNo: number, prompt: string, title: string, styleTemplateId?: string) => void;
    /**
     * **逐镜声音**：镜号 → 已关联的音频节点 id（存在 `metadata.scriptRowAudios`）。
     * 表里「声音」列链接 / 导入的音频，铺链路时**只直连这一镜（或该分段）的视频节点** —— 只连视频，不参与生图。
     */
    rowAudios?: Record<string, string[]>;
    /** 画布上全部音频节点的候选：供「声音」列解析名字、以及弹窗里勾选链接。 */
    audioCandidates?: ScriptAssetCandidate[];
    /** 逐镜声音关联变更：整组替换这一镜的音频节点 id（传空数组即解绑）。 */
    onRowAudiosChange?: (nodeId: string, shotNo: number, ids: string[]) => void;
    /**
     * 逐镜导入本地音频：建音频节点并立刻关联到这一镜。
     * 返回新建的音频节点 id —— 弹窗据此把它们并入勾选并**保持打开**，方便一镜连挂好几条。
     */
    onRowAudioImport?: (nodeId: string, shotNo: number, files: File[]) => void | Promise<string[] | void>;
    /**
     * **按镜按资产**挂图：`"镜号:资产列key"`（如 `"3:scene"`）→ 图片节点 id 列表
     * （存在 metadata.scriptCellAssets）。在资产列格子里导入 / 链接 / 生成，铺链路时只连到这一镜的那一个资产。
     */
    cellAssets?: Record<string, string[]>;
    /** 按镜按资产关联变更：整组替换这一格的图片节点 id（传空数组即解绑）。 */
    onCellAssetsChange?: (nodeId: string, shotNo: number, columnKey: string, ids: string[]) => void;
    /** 按镜按资产导入本地图片：建节点并立刻关联到这一格。 */
    onCellAssetImport?: (nodeId: string, shotNo: number, columnKey: string, files: File[]) => void;
    /** 按镜按资产 AI 生成图片：建节点、关联到这一格并立刻触发生图（`model` 是这一格单独挑的生图模型，`styleTemplateId` 是本次挑的风格模板）。 */
    onCellAssetGenerate?: (nodeId: string, shotNo: number, columnKey: string, prompt: string, title: string, model?: string, styleTemplateId?: string) => void;
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
    onBuildShotVideos,
    onRegenerateShot,
    onRegenerateRows,
    onFillShotAssets,
    onFillAllShotAssets,
    rowNotes,
    onRegenerateAll,
    rowAssets,
    imageCandidates,
    onRowAssetsChange,
    onRowAssetImport,
    onRowAssetGenerate,
    rowAudios,
    audioCandidates,
    onRowAudiosChange,
    onRowAudioImport,
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
    // 默认档是 20px（用户要求默认可读），要更密就点顶部 A−。
    const baseFontSize = resolveStoryScriptFontSize(node.metadata?.scriptFontSize);
    const smallerFontSize = stepStoryScriptFontSize(baseFontSize, -1);
    const largerFontSize = stepStoryScriptFontSize(baseFontSize, 1);

    // 输出格式预设：列定义、行操作都从这里来。
    const presetId = resolveStoryScriptPresetId(node.metadata?.scriptPreset);
    const preset = useMemo(() => getStoryScriptPreset(presetId), [presetId]);
    /**
     * 「三套执行方案」：`builtin` = 预设自带的内置提示词；`library` = 词库（分镜表 · 首帧图和视频提示词）；
     * `x20` = 词库（火_X20_主图分镜图_简洁版）—— **默认就是第三套**，见 `resolveAutoApplyScriptScheme`。
     *
     * 为什么只预填、不另开注入通道：三个字段本来就是节点级覆盖入口，预填完用户还能照常点开改；
     * 而且切换方案**绝不碰 `scriptSource`** —— 用户单独设定的分镜表识别内容（那套 `- **首帧图片提示词**：`
     * 模版）必须被方案原样继承（这正是用户 02 的要求）。
     */
    const schemeId = resolveScriptSchemeId(node.metadata?.scriptScheme);
    const x20Prefill = useMemo(() => buildScriptSchemePrefill(globalConfig?.textPrompts, "x20"), [globalConfig?.textPrompts]);
    const libraryPrefill = useMemo(() => buildScriptSchemePrefill(globalConfig?.textPrompts, "library"), [globalConfig?.textPrompts]);
    /** 当前方案对应的预填（第一套没有预填）。 */
    const schemePrefill: ScriptSchemePrefill | null = schemeId === "x20" ? x20Prefill : schemeId === "library" ? libraryPrefill : null;
    /**
     * 手动追加的资产列（用户自建：「宠物」「车辆」…）。行为与内置资产列一致 ——
     * 格子里能挂图、能上锁，铺链路时按 `role` 连进这一镜的图片节点。
     */
    const extraColumns = useMemo(() => normalizeStoryScriptExtraColumns(node.metadata?.scriptExtraColumns), [node.metadata?.scriptExtraColumns]);
    // 表格实际渲染的列 = 预设列 + 自建资产列（解析 / 导出仍只按预设列走，自建列是用户手填的）。
    const columns = useMemo(() => getStoryScriptColumnsWithExtras(presetId, extraColumns), [presetId, extraColumns]);
    /**
     * 「简洁版」：只隐藏六列（画面描述 / 角色动作 / 人物站位 / 情绪 / 场景标签 / 光影氛围），
     * **不删数据** —— 行里那几个字段照旧，切回完整版立刻回来。
     *
     * 默认就是简洁版（2026-10-21 用户：03 分镜表默认选择简洁版显示），所以 `undefined` 按「开」算；
     * 只有用户显式切成完整版时才会存 `false`（三态语义，别退回 `=== true`）。
     *
     * 存 metadata 而不是组件 state：节点滚出视口会被卸载，state 一丢用户切过的简洁版就变回完整版
     * （这个坑在计时起点上踩过，见项目备忘）。
     */
    const compactColumns = node.metadata?.scriptCompactColumns !== false;
    /**
     * 渲染用的列：简洁版过滤 + 列宽放大（`STORY_SCRIPT_COLUMN_WIDTH_SCALE`，用户要求横向宽度增宽 1 倍）。
     * ⚠️ 只有**渲染 / 表宽 / 自动适配签名**走它；行编辑、导出、铺链、任务书仍用完整的 `columns`。
     */
    const displayColumns = useMemo(() => resolveStoryScriptDisplayColumns(columns, compactColumns), [columns, compactColumns]);
    // 勾选列只在「支持批量操作」时出现（没接线就完全不占宽度）。
    const showRowSelect = Boolean(onRegenerateRows || onBuildShotVideos);
    // 「声音」列：逐镜挂台词配音 / 音效。接线了才出现（旧调用点不受影响）。
    const showRowAudios = Boolean(onRowAudiosChange || onRowAudioImport);
    // 勾选列挂在 preset 列之前，所以表格实际宽度要把它一起算上（否则自动适配会窄）。
    const tableWidth = useMemo(
        () =>
            displayColumns.reduce((sum, column) => sum + column.width, 0) +
            TABLE_ACTION_WIDTH +
            (showRowSelect ? TABLE_SELECT_WIDTH : 0) +
            (showRowAudios ? TABLE_AUDIO_WIDTH : 0),
        [displayColumns, showRowSelect, showRowAudios],
    );

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
    /** 「声音」列弹窗当前瞄准的那一镜（null = 未打开）。 */
    const [rowAudioTarget, setRowAudioTarget] = useState<{ shotNo: number; ids: string[] } | null>(null);
    /** 正把文件从系统拖到节点上（显示落区提示）。 */
    const [fileDragging, setFileDragging] = useState(false);
    // 「自定义提示词」弹窗：三种用途共用一个文本编辑弹窗（见下方 dialog）：
    //  - system：整段替换系统提示词（= 换一个生成器）；
    //  - asset / shot：只往任务书里加一段专项要求，各管一组列（见 story-script.ts 的 *PromptSection）。
    const [customPromptKind, setCustomPromptKind] = useState<"system" | "asset" | "shot" | null>(null);
    // 是否已自定义：决定 chip 的高亮态与是否显示「恢复预设提示词」。
    const hasCustomSystemPrompt = hasScriptSystemPromptOverride(node.metadata?.scriptSystemPrompt);
    /** 「资产提示词」是否已设（角色 / 场景 / 道具 / 人物站位怎么写）。 */
    const hasCustomAssetPrompt = hasScriptGenerationPrompt(node.metadata?.scriptAssetPrompt);
    /** 「分镜提示词」是否已设（分镜提示词 / 视频运动提示词 / 风格提示词怎么写）。 */
    const hasCustomShotPrompt = hasScriptGenerationPrompt(node.metadata?.scriptShotPrompt);
    /**
     * 勾选的行（存 rowIndex，不是镜号）。只服务于「批量重生成 / 批量铺视频」。
     * 任何会改变行顺序或行数的操作（调序 / 删行 / 重新生成整表）都会把它清空——
     * 索引一变，勾选就指到别人身上了，清空比错位安全。
     */
    const [selectedRows, setSelectedRows] = useState<Set<number>>(() => new Set());
    /** 「加剧情 / 批量重生成」弹窗：瞄准的行索引（空 = 未打开）。 */
    const [rowEditTarget, setRowEditTarget] = useState<number[] | null>(null);
    const [rowPlotDraft, setRowPlotDraft] = useState("");
    /** 是否要求这批镜与上下镜保持人物站位一致（默认开 = 改造前的行为）。 */
    const [rowKeepBlocking, setRowKeepBlocking] = useState(true);
    /**
     * 单元格是否完整显示。默认 `true`（用户要求：不用拖滑条也要看全内容），
     * 切到 `false` 时退回「4 行 + 悬停看全文」，用来把很长的提示词列压扁。
     */
    const [showFullText, setShowFullText] = useState(true);
    /** 「添加资产列」弹窗：列名草稿 + 分类（默认场景 = 对每一镜都成立，最不容易「只连到一镜」）。 */
    const [addColumnOpen, setAddColumnOpen] = useState(false);
    const [addColumnLabel, setAddColumnLabel] = useState("");
    const [addColumnRole, setAddColumnRole] = useState<ScriptAssetRole>("scene");

    useEffect(() => {
        setSourceDraft(source);
    }, [source]);

    useEffect(() => {
        setPromptDraft(extraPrompt);
    }, [extraPrompt]);

    const canGenerate = Boolean(sourceDraft.trim() || connectedTextValue) && !isRunning;
    /**
     * 源内容里认到的「逐镜模版」块数（`- **首帧图片提示词**：…` 那种）。
     * >0 就说明「分镜提示词 / 视频运动提示词 / 风格提示词」会按模版原文填进去。
     * 以前这个判断完全不可见：三列为空时用户只能猜是「没认出来」还是「模型没生成」。
     */
    const templateShots = useMemo(() => countStoryScriptTemplateShots(sourceDraft), [sourceDraft]);
    const activeReferences = useMemo(() => (references || []).filter((item) => item.active), [references]);
    // 「试一试」只在真·空场景出现（没结果、没连线、没手填），否则会挤占输入区。
    const showTryActions = !rows.length && activeReferences.length === 0 && !sourceDraft.trim();
    // 「添加资产」入口：导入 / 链接 / 生成三条里有一条能用就显示。
    const showAssetEntry = Boolean(onImportAssets || onLinkAssets || onGenerateAsset);
    // 「镜头图」列已从表里移除（见文件头常量处的说明），所以这里不再判断是否显示它。
    // 「按镜按资产」图位：资产列（角色1 / 场景 / 道具 / 人物站位 + 自建资产列）格子里的缩略图 + 「+」。
    const showCellAssets = Boolean(onCellAssetsChange || onCellAssetImport || onCellAssetGenerate);
    /**
     * 每一镜「缺哪些资产」（整组都空才算缺）。三处共用这一份：
     *  - 行内「补资产」按钮（这一镜真有缺列才出现）；
     *  - 底部「补齐全部资产」按钮（计数 + 可点性）；
     *  - 批量补齐时决定跳过哪些行（空数组的行不发请求）。
     */
    const rowAssetFillTargets = useMemo(
        () => rows.map((row) => collectStoryScriptAssetFillTargets(presetId, row, extraColumns)),
        [rows, presetId, extraColumns],
    );
    const missingAssetRowCount = useMemo(() => rowAssetFillTargets.filter((targets) => targets.length).length, [rowAssetFillTargets]);
    // 缩略图 / 标题查表（按节点 id）。节点被删后取不到，渲染时会退化成占位图标。
    const imageLookup = useMemo(() => {
        const map = new Map<string, ScriptAssetCandidate>();
        for (const item of imageCandidates || []) map.set(item.id, item);
        return map;
    }, [imageCandidates]);
    /** 音频节点查表（声音列的胶囊要显示文件名；顺带过滤掉已经不在画布上的 id）。 */
    const audioLookup = useMemo(() => {
        const map = new Map<string, ScriptAssetCandidate>();
        for (const item of audioCandidates || []) map.set(item.id, item);
        return map;
    }, [audioCandidates]);
    /**
     * 声音试听：整张表共用一个 `<audio>` 元素，同一时刻只播一条（点另一条会自动停掉上一条）。
     * 音频节点的 `content` 就是可播放的 URL（本地 blob 或远端 CDN 地址）。
     */
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
    const toggleAudioPreview = (audioId: string, url: string) => {
        const current = audioPlayerRef.current;
        if (playingAudioId === audioId) {
            current?.pause();
            setPlayingAudioId(null);
            return;
        }
        if (!url) return;
        // 用局部常量收口：直接读 `ref.current` 的话 TS 的 null 收窄会被「ref 可能被改」打断。
        const player = current || new Audio();
        if (!current) {
            audioPlayerRef.current = player;
            player.addEventListener("ended", () => setPlayingAudioId(null));
        }
        if (player.src !== url) player.src = url;
        void player.play().then(
            () => setPlayingAudioId(audioId),
            () => setPlayingAudioId(null),
        );
    };

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
    // `fullscreen` 也得进依赖：进出全屏时 `shell` 会被 portal 挪走，表体是**新的 DOM**，
    // 不重绑就只在窗口里生效、全屏时滚轮又变回缩放画布。
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const stop = (event: WheelEvent) => event.stopPropagation();
        el.addEventListener("wheel", stop, { passive: true });
        return () => el.removeEventListener("wheel", stop);
    }, [fullscreen, view, rows.length, isRunning]);

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
        // 签名带行数、单元格总字数、基准字号与「完整/精简」：增删行、改字、调字号、切显示都会变，纯切换视图不会。
        // 前缀 `v2` 是「版式版本」：行高压缩 / 移除镜头图列之后，老节点存下的签名不再命中，会重新适配一次。
        // `v3`（第十五轮）：格内长文封顶 8 行 + 操作列吸附，行高整体变了，同样强制重适配一次。
        // `v4`（本轮）：新增「声音」列（+210px），宽度变了，老节点也要重算一次。
        // `v5`：列宽整体放大一倍 + 「简洁版」隐藏六列，表宽变化很大 → 老节点强制重适配一次。
        const signature = `v5:${presetId}:${baseFontSize}:${showFullText ? "full" : "compact"}:${compactColumns ? "slim" : "wide"}:${displayColumns.length}:${tableWidth}:${showRowAudios ? 1 : 0}:${rows.length}:${rows.reduce((sum, row) => sum + columns.reduce((acc, column) => acc + String(row[column.key] ?? "").length, 0), 0)}`;
        if (signature === lastAutoSizeKeyRef.current) return;
        const chromeHeight = Math.max(0, shell.clientHeight - body.clientHeight);
        const width = Math.round(Math.min(AUTO_SIZE_MAX_WIDTH, Math.max(AUTO_SIZE_MIN_WIDTH, tableWidth + AUTO_SIZE_PADDING_X)));
        const height = Math.round(Math.min(AUTO_SIZE_MAX_HEIGHT, Math.max(AUTO_SIZE_MIN_HEIGHT, chromeHeight + contentHeight + 2)));
        lastAutoSizeKeyRef.current = signature;
        onConfigChange(node.id, { scriptAutoSizeKey: signature });
        if (Math.abs(width - node.width) < 8 && Math.abs(height - node.height) < 8) return;
        onNodeSizeChange(node.id, width, height);
    }, [baseFontSize, columns, compactColumns, displayColumns, fullscreen, isRunning, node.height, node.id, node.width, onConfigChange, onNodeSizeChange, presetId, rows, showFullText, tableWidth, view]);

    /**
     * 表体的滚动位置：卸载 / 重挂之后不许归位。
     *
     * 触发点有四个，看起来像四种问题，成因是同一个 —— **表体 DOM 被重建了**，浏览器只能给 0：
     *  ① 节点滚出视口被画布裁剪卸载（`project.tsx` 的 `visibleNodes`），再滚回来；
     *  ② 进 / 出「全屏」：`shell` 被 `createPortal` 挪到 body 下，元素是新的；
     *  ③ 「剧本原文 ↔ 分镜表」来回切；
     *  ④ 重新生成期间表体换成运行面板，结束后再挂回来。
     * 表宽 2.6k~4.2k px，横向滚到第 8 列再切走就等于白找一次，所以位置必须记下来。
     *
     * 为什么退出 `canvas-node.tsx` 的通用机制（`data-canvas-scroll-managed="self"`）：
     * 那套按「DOM 里的第几个滚动容器」当 key，而本节点里滚动容器会随视图 / 引用条增减变化，
     * 索引一漂就把别的位置套到表体上（或者干脆套不上）。这里用节点 id 当 key，稳定。
     */
    useEffect(() => {
        if (view !== "table" || !rows.length || isRunning) return;
        const el = bodyRef.current;
        if (!el) return;

        const saved = readScriptTableScroll(node.id);
        let cancelled = false;
        // 自己写 scrollLeft 也会派发 scroll 事件：不挡掉就会把「被布局夹小的值」当成用户的
        // 操作再存一遍，下次真的回不去了。
        let applying = false;
        const apply = () => {
            if (cancelled || !saved) return;
            applying = true;
            el.scrollLeft = Math.min(saved.left, Math.max(0, el.scrollWidth - el.clientWidth));
            el.scrollTop = Math.min(saved.top, Math.max(0, el.scrollHeight - el.clientHeight));
            window.requestAnimationFrame(() => {
                applying = false;
            });
        };

        // 连补几帧：上面「自动适配尺寸」的 effect 会在这之后改节点宽高，宽度一变可滚动范围跟着变，
        // 浏览器会把 scrollLeft 夹回去 —— 只在第一帧写等于白写。再挂一个 240ms 的兜底
        // （单元格缩略图解码完可能又让表宽变了一点）。
        apply();
        let frames = 0;
        let frame = window.requestAnimationFrame(function step() {
            apply();
            frames += 1;
            if (frames < 4) frame = window.requestAnimationFrame(step);
        });
        const timer = window.setTimeout(apply, 240);

        const save = () => {
            if (applying) return;
            writeScriptTableScroll(node.id, { left: el.scrollLeft, top: el.scrollTop });
        };
        el.addEventListener("scroll", save, { passive: true });

        return () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timer);
            el.removeEventListener("scroll", save);
            // 卸载那一刻最后再写一次：最后一小段滚动可能还没落库。
            writeScriptTableScroll(node.id, { left: el.scrollLeft, top: el.scrollTop });
        };
    }, [fullscreen, isRunning, node.id, rows.length, tableWidth, view]);

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

    /**
     * 「第二套（分镜表 · 首帧图和视频提示词）是默认方案」——用户 2026-10-23 的要求
     * （2026-10-21 的「默认第三套」已作废，第三套降为「第二套词库缺失时的兜底」，切换权交回用户）。
     *
     * 为什么靠挂载后**自动预填一次**，而不是把 `resolveScriptSchemeId` 的默认值改掉：
     * 那个函数只做归一化。默认值一改，按钮会亮成第二套、可三个输入框还是空的，生成时照样走
     * 内置提示词 —— 界面与行为对不上，比不默认更糟。唯一正确的落点是「挂载后真的把三段填进去」。
     *
     * 判断条件（已选方案 / 手填过 / 两套词库都空 / prefill 未就绪 → 不动）收在
     * `resolveAutoApplyScriptScheme` 里，探针能钉住；这里只管落库。
     * 老节点不再迁移：10-19 那版写进 metadata 的 `library` 正好就是现在的默认。
     */
    const schemeAutoAppliedRef = useRef(false);
    useEffect(() => {
        if (schemeAutoAppliedRef.current) return;
        const next = resolveAutoApplyScriptScheme({
            scheme: node.metadata?.scriptScheme,
            x20Prefill,
            libraryPrefill,
            customSystemPrompt: node.metadata?.scriptSystemPrompt,
            customAssetPrompt: node.metadata?.scriptAssetPrompt,
            customShotPrompt: node.metadata?.scriptShotPrompt,
        });
        if (!next) return;
        schemeAutoAppliedRef.current = true;
        const prefill = next === "x20" ? x20Prefill : libraryPrefill;
        patchMetadata({
            scriptScheme: next,
            ...(prefill.system ? { scriptSystemPrompt: prefill.system } : {}),
            ...(prefill.asset ? { scriptAssetPrompt: prefill.asset } : {}),
            ...(prefill.shot ? { scriptShotPrompt: prefill.shot } : {}),
        });
        // patchMetadata 每次渲染都是新函数；真正的闸门是 next 与 ref，重复执行最多「看一眼就退出」。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [libraryPrefill, x20Prefill, node.metadata?.scriptAssetPrompt, node.metadata?.scriptScheme, node.metadata?.scriptShotPrompt, node.metadata?.scriptSystemPrompt]);

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
            scriptCellAssets: shiftStoryScriptCellAssetsAfterDelete(node.metadata?.scriptCellAssets, deletedShotNo, extraColumns),
            // 逐镜声音同理：不移的话「第 5 镜的配音」会挂到删行后顶上来的新第 5 镜身上。
            scriptRowAudios: shiftStoryScriptRowAudiosAfterDelete(node.metadata?.scriptRowAudios, deletedShotNo),
        });
        setSelectedRows(new Set());
        message.success(t("canvas.scriptNode.rowDeleted"));
    };

    /**
     * 调序：把这一镜往上 / 往下挪一格，镜号跟着重排成 1..N。
     *
     * 三张按镜号存的表（逐镜图 / 按镜按资产 / 逐镜备注）**必须一起挪**，否则图会挂到隔壁镜头上；
     * `reorderStoryScriptRows` 返回的 mapping 就是干这个的。
     */
    const moveRow = (rowIndex: number, delta: number) => {
        const target = rowIndex + delta;
        if (target < 0 || target >= rows.length) return;
        const { rows: nextRows, mapping } = reorderStoryScriptRows(rows, rowIndex, target);
        patchMetadata({
            scriptRows: nextRows,
            scriptRowAssets: remapStoryScriptRowAssets(node.metadata?.scriptRowAssets, mapping),
            scriptCellAssets: remapStoryScriptCellAssets(node.metadata?.scriptCellAssets, mapping, extraColumns),
            scriptRowAudios: remapStoryScriptRowAudios(node.metadata?.scriptRowAudios, mapping),
            scriptRowNotes: remapStoryScriptRowNotes(node.metadata?.scriptRowNotes, mapping),
        });
        // 勾选按 rowIndex 存，顺序一变就指到别人身上了 —— 清空。
        setSelectedRows(new Set());
    };

    const toggleRowSelected = (rowIndex: number) => {
        setSelectedRows((current) => {
            const next = new Set(current);
            if (next.has(rowIndex)) next.delete(rowIndex);
            else next.add(rowIndex);
            return next;
        });
    };

    const toggleAllRows = () => {
        setSelectedRows((current) => (current.size === rows.length ? new Set() : new Set(rows.map((_, index) => index))));
    };

    /** 打开「加剧情 / 重生成」弹窗：单镜（行按钮）或整批（勾选后底部按钮）都走这里。 */
    const openRowEdit = (indexes: number[]) => {
        const valid = indexes.filter((index) => index >= 0 && index < rows.length);
        if (!valid.length) return;
        // 单镜时把上次给这一镜写的剧情带出来（改一行字重跑一遍，不用重打）。
        const only = valid.length === 1 ? rows[valid[0]] : undefined;
        setRowPlotDraft(only ? storyScriptRowNote(node.metadata?.scriptRowNotes, only.shot_no || valid[0] + 1) : "");
        setRowKeepBlocking(true);
        setRowEditTarget(valid);
    };

    const submitRowEdit = () => {
        if (!rowEditTarget?.length) return;
        onRegenerateRows?.(node.id, rowEditTarget, { extraPlot: rowPlotDraft.trim() || undefined, keepBlocking: rowKeepBlocking });
        setRowEditTarget(null);
        setSelectedRows(new Set());
    };

    /**
     * 「添加资产列」：自建一列（例「宠物」），行为与内置资产列一致 ——
     * 格子里能挂图位、能上资产锁，铺链路时按 `role` 连进这一镜的图片节点。
     *
     * key 用 `extra_<n>` 且**永久不变**（改列名只改 `label`），这样列名改了图位不会丢。
     */
    const submitAddColumn = () => {
        const label = addColumnLabel.trim();
        if (!label) {
            message.warning(t("canvas.scriptNode.extraColumnNeedName"));
            return;
        }
        if (extraColumns.length >= STORY_SCRIPT_MAX_EXTRA_COLUMNS) {
            message.warning(t("canvas.scriptNode.extraColumnLimit", { count: STORY_SCRIPT_MAX_EXTRA_COLUMNS }));
            return;
        }
        if (extraColumns.some((item) => item.label === label)) {
            message.warning(t("canvas.scriptNode.extraColumnExists", { label }));
            return;
        }
        const next: StoryScriptExtraColumn[] = [...extraColumns, { key: nextStoryScriptExtraColumnKey(extraColumns), label, role: addColumnRole }];
        patchMetadata({ scriptExtraColumns: next });
        setAddColumnOpen(false);
        setAddColumnLabel("");
        setAddColumnRole("scene");
    };

    /** 删除自建资产列：连这一列的行文本 + 图位一起清掉（只删表头会留下野数据）。 */
    const removeExtraColumn = (column: { key: string; label: string }) => {
        modal.confirm({
            title: t("canvas.scriptNode.extraColumnRemoveConfirm", { label: column.label }),
            okText: t("canvas.scriptNode.extraColumnRemove"),
            cancelText: t("common.cancel"),
            onOk: () => {
                patchMetadata({
                    scriptExtraColumns: extraColumns.filter((item) => item.key !== column.key),
                    scriptRows: dropStoryScriptRowColumn(rows, column.key),
                    // 传「删之前的 extraColumns」：要删的这一列此刻还必须算合法列，否则它的图位早被当归一化野键丢掉了。
                    scriptCellAssets: dropStoryScriptCellAssetColumn(node.metadata?.scriptCellAssets, column.key, extraColumns),
                });
            },
        });
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
                setSelectedRows(new Set());
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

    /** 方案 toast 里「缺了哪一段」的中文名。 */
    const schemePartLabel = (part: "system" | "asset" | "shot") => t(`canvas.scriptNode.schemePart_${part}`);

    /**
     * 真正落地方案切换。
     *
     * - 第二 / 第三套 = 把词库里的三段提示词一键填进那三个输入框（填完用户仍可打开弹窗改一两句）。
     *   词库里**没找到**的段落保持原样，不清空 —— 用户可能只想要其中一段。
     * - 切回第一套 = 还原成「切到词库方案之前」的样子（走 `scriptLibraryBackup`，没设过就清空）。
     * - 三套都**不动** `scriptSource` / `scriptRows`：前者是用户单独设定的分镜表识别内容（02 要继承），
     *   后者是已有结果 —— 换方案只影响下一次生成，没必要清空。
     */
    const applyScheme = (next: ScriptSchemeId) => {
        if (next === "builtin") {
            const backup = node.metadata?.scriptLibraryBackup;
            patchMetadata({
                scriptScheme: "builtin",
                scriptLibraryBackup: undefined,
                scriptSystemPrompt: backup?.system,
                scriptAssetPrompt: backup?.asset,
                scriptShotPrompt: backup?.shot,
            });
            message.success(t("canvas.scriptNode.schemeBuiltinApplied"));
            return;
        }
        const prefill = next === "x20" ? x20Prefill : libraryPrefill;
        // 判据只看「自定义 / 分镜」那一段：资产段两套共用，只剩资产段时切过去填的东西与另一套一模一样，
        // 按钮写着第三套、实际跑第二套 —— 比切不动更难懂。这种情况直接提示去补词库。
        if (!prefill.system && !prefill.shot) {
            message.error(t(next === "x20" ? "canvas.scriptNode.schemeEmptyX20" : "canvas.scriptNode.schemeEmptyLibrary"));
            return;
        }
        patchMetadata({
            scriptScheme: next,
            // 只在**离开第一套**时备份：第二套 ↔ 第三套互换时若再备份，存进去的会是刚被另一套预填的文案，
            // 用户真正手写的那份就永久丢了。
            ...(schemeId === "builtin"
                ? {
                      scriptLibraryBackup: {
                          system: node.metadata?.scriptSystemPrompt,
                          asset: node.metadata?.scriptAssetPrompt,
                          shot: node.metadata?.scriptShotPrompt,
                      },
                  }
                : {}),
            ...(prefill.system ? { scriptSystemPrompt: prefill.system } : {}),
            ...(prefill.asset ? { scriptAssetPrompt: prefill.asset } : {}),
            ...(prefill.shot ? { scriptShotPrompt: prefill.shot } : {}),
        });
        if (prefill.missing.length) {
            message.warning(
                t(next === "x20" ? "canvas.scriptNode.schemeX20Partial" : "canvas.scriptNode.schemeLibraryPartial", {
                    names: prefill.missing.map(schemePartLabel).join(" / "),
                }),
            );
        } else {
            message.success(t(next === "x20" ? "canvas.scriptNode.schemeX20Applied" : "canvas.scriptNode.schemeLibraryApplied"));
        }
    };

    const switchScheme = (next: ScriptSchemeId) => {
        if (next === schemeId) {
            // 再点当前方案 = 按当前词库重新预填（用户刚在设置里改了词条时用得上）；第一套没得刷新。
            if (next !== "builtin") applyScheme(next);
            return;
        }
        // 切回第一套会把词库方案填进去的三段提示词撤掉 —— 手动改过就确认一下，别默默丢内容。
        if (next === "builtin" && (hasCustomSystemPrompt || hasCustomAssetPrompt || hasCustomShotPrompt)) {
            modal.confirm({
                title: t("canvas.scriptNode.schemeSwitchBackConfirm"),
                okText: t("canvas.scriptNode.schemeSwitchBack"),
                cancelText: t("common.cancel"),
                onOk: () => applyScheme(next),
            });
            return;
        }
        applyScheme(next);
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

    // 「执行方案」总开关：第一套 = 预设自带的内置提示词；第二套 = 词库（分镜表 · 首帧图和视频提示词）；
    // 第三套 = 词库（火_X20_主图分镜图_简洁版）—— **默认是第二套，换哪套由用户自己点**。
    // 放在预设切换行**之前**——预设决定「出哪些列」，方案决定「用哪套提示词」，后者层次更高。
    const schemeSelector = (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[0.923em]" style={{ color: theme.node.text }}>
            <span className="opacity-60">{t("canvas.scriptNode.schemeLabel")}</span>
            {SCRIPT_SCHEME_IDS.map((id) => {
                const active = id === schemeId;
                return (
                    <button
                        key={id}
                        type="button"
                        className="inline-flex h-6 items-center rounded-full border px-2.5 transition"
                        style={{
                            borderColor: active ? theme.toolbar.activeText : theme.node.stroke,
                            // 选中态必须实心：`activeBg` 是浅米色，和未选中的半透明底几乎没差别，
                            // 看起来像「没点上」（这坑在时长 pill 上踩过）。
                            background: active ? theme.toolbar.activeText : `${theme.toolbar.panel}aa`,
                            color: active ? theme.node.panel : theme.node.text,
                            opacity: active ? 1 : 0.7,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            switchScheme(id);
                        }}
                        title={t(`canvas.scriptNode.scheme_${id}_hint`)}
                    >
                        {t(`canvas.scriptNode.scheme_${id}`)}
                    </button>
                );
            })}
            {/* 词库方案在词库里没找全时给个显式提示，否则用户会以为「点了没反应」（内容其实是原样保留的）。 */}
            {schemePrefill && schemePrefill.missing.length ? (
                <span className="opacity-60" title={t("canvas.scriptNode.schemeLibraryMissingHint")}>
                    {t("canvas.scriptNode.schemeLibraryMissing", { count: schemePrefill.missing.length })}
                </span>
            ) : null}
            {/* 默认是第二套；两套词库都取不到「自定义 / 分镜」那一段时自动切不动，必须说清楚
                「为什么还亮着第一套」，否则看着像功能失效。判据只认那一段 —— 资产段两套共用，
                只有资产词条时切过去也等于没切（见 `resolveAutoApplyScriptScheme`）。 */}
            {!node.metadata?.scriptScheme && !x20Prefill.system && !x20Prefill.shot && !libraryPrefill.system && !libraryPrefill.shot ? (
                <span className="opacity-60">{t("canvas.scriptNode.schemeX20DefaultOff")}</span>
            ) : null}
        </div>
    );

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
                    setCustomPromptKind("system");
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
            <span className="mx-0.5 h-4 w-px shrink-0" style={{ background: theme.node.stroke, opacity: 0.6 }} />
            {/* 「资产」/「分镜提示词」：两路互不干扰的专项要求（用户原话「资产的生成和分镜提示词的生成
                使用不同的提示词来控制」）。已自定义时用实心底 + 深字 —— 浅色 activeBg 在一排描边胶囊里
                读起来像禁用（这个坑在时长 pill 上踩过）。 */}
            {[
                { kind: "asset" as const, active: hasCustomAssetPrompt, label: t("canvas.scriptNode.assetPromptChip"), hint: t("canvas.scriptNode.assetPromptHint") },
                { kind: "shot" as const, active: hasCustomShotPrompt, label: t("canvas.scriptNode.shotPromptChip"), hint: t("canvas.scriptNode.shotPromptHint") },
            ].map((item) => (
                <button
                    key={item.kind}
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded-full border px-2.5 transition"
                    style={{
                        borderColor: item.active ? theme.toolbar.activeText : theme.node.stroke,
                        background: item.active ? theme.toolbar.activeText : `${theme.toolbar.panel}aa`,
                        color: item.active ? theme.node.panel : theme.node.text,
                        opacity: item.active ? 1 : 0.7,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        setCustomPromptKind(item.kind);
                    }}
                    title={item.hint}
                >
                    <Wand2 className="size-3.5" />
                    {item.label}
                </button>
            ))}
        </div>
    );

    // 「每镜时长」：5 秒（默认，**上限**：每镜不超过 5 秒）/ 10 秒 / 15 秒（**锁定**：每镜就是它）/ 不限制。
    //
    // 选了之后「铺链」怎么切，由旁边的「视频分段」决定：
    // - 单镜（默认）：**每一镜就是一整段**（用户原话「每个镜头不超过 5 秒，也能选 10 / 15」），
    //   铺链时 10/15 直接锁定成片秒数，5 秒按表里时长取、超出压到 5；
    // - 按每段时长：连续几镜合并凑够 N 秒；
    // - 每 2 / 3 镜：N 镜合成一段。
    //
    // ⚠️ 这里**不自动改「视频分段」**。早先版本一选 10/15 就强切到「按每段时长」，
    // 结果想要「每镜 10 秒」的人反而拿到「3+3+4 合成一段 10 秒」——镜头被合并掉了。
    const segmentSeconds = resolveStoryScriptSegmentSeconds(node.metadata?.scriptSegmentSeconds);
    const mergeMode = resolveStoryScriptMergeMode(node.metadata?.scriptMergeMode);
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
                            borderColor: active ? theme.toolbar.activeText : theme.node.stroke,
                            // 选中态必须实心：activeBg 是浅米色，和未选中的半透明底几乎没差别，
                            // 用户会以为「没点上 / 点了没反应」（这坑在其它 pill 上踩过好几次）。
                            background: active ? theme.toolbar.activeText : `${theme.toolbar.panel}aa`,
                            color: active ? theme.node.panel : theme.node.text,
                            opacity: active ? 1 : 0.7,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (id === "none") {
                                // 取消分段时，分段方式若停在「按每段时长」会变成「选中但不可用」，一起退回单镜。
                                patchMetadata({ scriptSegmentSeconds: id, ...(mergeMode === "duration" ? { scriptMergeMode: "shot" } : {}) });
                                return;
                            }
                            // 只改时长，分段方式留给用户自己选（单镜 = 每镜 N 秒，按每段时长 = 合并凑 N 秒）。
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
            {schemeSelector}
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
            {templateShots ? (
                <div
                    className="shrink-0 rounded-lg border px-2 py-1 text-[0.923em] leading-snug"
                    style={{ borderColor: "#16a34a66", background: "#16a34a14", color: theme.node.text }}
                >
                    {t("canvas.scriptNode.templateDetected", { count: templateShots })}
                    {/* 02：词库方案（第二 / 第三套）**继承**这段识别内容（只有提示词被换掉，模版本身一个字不动）。 */}
                    {schemeId !== "builtin" ? ` ${t("canvas.scriptNode.schemeTemplateInherited")}` : ""}
                </div>
            ) : sourceDraft.trim() ? (
                // 反向证据：贴了内容却没认出模版 → 三列由模型生成（用户就不用再猜「是没认出来吗」）。
                <div className="shrink-0 px-1 text-[0.846em] leading-snug opacity-45" style={{ color: theme.node.text }}>
                    {t("canvas.scriptNode.templateMissed")}
                </div>
            ) : null}
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
    // 「按每段时长」要有目标时长才能凑，选「不限制」时置灰。
    // 顺便把「按当前设置会切成几段、每段多长」算出来直接显示 —— 这是「选了之后到底有没有生效」
    // 唯一看得见的证据（表格里没有任何字段会因为选 5 / 10 秒而变化）。
    //
    // 单镜模式也要显示（「每镜 5 秒以内 · 共 20 段」/「每镜 10 秒 · 共 20 段」）：以前这里只在
    // 「按每段时长」时才算，于是选了档位 + 单镜的用户屏幕上什么都没变，看起来就像设置没生效。
    const segmentPreview = useMemo(() => {
        if (segmentSeconds === "none" || !rows.length) return "";
        if (mergeMode === "shot") {
            // 5 秒是「上限」（默认档），10 / 15 是「锁定」，两种文案不能混。
            const capped = Number(segmentSeconds) < 10;
            return t(capped ? "canvas.scriptNode.segmentPreviewShotCap" : "canvas.scriptNode.segmentPreviewShot", {
                seconds: segmentSeconds,
                count: rows.length,
            });
        }
        const groups = groupStoryScriptRows(rows, mergeMode, segmentSeconds);
        if (!groups.length) return "";
        if (mergeMode === "duration") {
            return t("canvas.scriptNode.segmentPreview", {
                seconds: segmentSeconds,
                count: groups.length,
                lengths: groups.map((group) => storyScriptGroupDuration(group)).join(" / "),
            });
        }
        return t("canvas.scriptNode.segmentPreviewMerge", { shots: mergeMode, count: groups.length });
    }, [mergeMode, rows, segmentSeconds, t]);
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
                            borderColor: active ? theme.toolbar.activeText : theme.node.stroke,
                            background: active ? theme.toolbar.activeText : `${theme.toolbar.panel}aa`,
                            color: active ? theme.node.panel : theme.node.text,
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
            {segmentPreview ? (
                <span
                    className="whitespace-nowrap rounded border px-1.5"
                    style={{ borderColor: theme.toolbar.activeText, color: theme.toolbar.activeText }}
                    title={
                        mergeMode === "shot"
                            ? t(Number(segmentSeconds) < 10 ? "canvas.scriptNode.segmentPreviewShotCapHint" : "canvas.scriptNode.segmentPreviewShotHint", { seconds: segmentSeconds })
                            : t("canvas.scriptNode.segmentPreviewHint")
                    }
                >
                    {segmentPreview}
                </span>
            ) : null}
        </div>
    );

    /**
     * 「声音」列的一格：这一镜已链接的音频（文件名 + 试听 + 解绑）+ 「+」。
     *
     * 与「按镜按资产」图位同一套交互口径（`×` 解绑、`+` 开弹窗），区别只是内容是音频：
     * 胶囊左边是播放/停止（免得为了确认「这段配音对不对」还要把节点拖出来听），右边是解绑。
     * 播放器整表共用一个（`audioPlayerRef`），点另一条会自动换掉上一条。
     */
    const renderAudioCell = (shotNo: number) => {
        const ids = scriptRowAudioIds(rowAudios, shotNo);
        // 已经不在画布上（被删）的音频不再显示 —— 铺链路也会按 existingNodeIds 滤掉，两处口径一致。
        const visibleIds = ids.filter((id) => !audioCandidates || audioLookup.has(id));
        return (
            <td className="border-b px-2 py-0.5 align-top" style={{ borderColor: theme.node.stroke }}>
                <div className="flex flex-col gap-0.5" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                    {visibleIds.map((audioId) => {
                        const meta = audioLookup.get(audioId);
                        const url = meta?.previewUrl || "";
                        const playing = playingAudioId === audioId;
                        return (
                            <span
                                key={audioId}
                                className="group relative flex h-6 w-full min-w-0 items-center gap-1 rounded-md border pl-0.5 pr-1"
                                style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                                title={meta?.title || audioId}
                            >
                                <button
                                    type="button"
                                    className="inline-flex size-5 shrink-0 items-center justify-center rounded transition hover:opacity-100"
                                    style={{ opacity: url ? 0.85 : 0.3 }}
                                    disabled={!url}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        toggleAudioPreview(audioId, url);
                                    }}
                                    title={playing ? t("canvas.scriptNode.rowAudioStop") : t("canvas.scriptNode.rowAudioPlay")}
                                >
                                    {playing ? <Square className="size-2.5" /> : <Play className="size-2.5" />}
                                </button>
                                <Music2 className="size-3 shrink-0 opacity-60" />
                                <span className="min-w-0 flex-1 truncate text-[0.846em]">{meta?.title || audioId}</span>
                                {onRowAudiosChange ? (
                                    <button
                                        type="button"
                                        className="hidden size-4 shrink-0 items-center justify-center rounded bg-black/50 text-white group-hover:flex"
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onRowAudiosChange(node.id, shotNo, ids.filter((id) => id !== audioId));
                                        }}
                                        title={t("canvas.scriptNode.rowAudioRemove")}
                                    >
                                        <X className="size-2.5" />
                                    </button>
                                ) : null}
                            </span>
                        );
                    })}
                    <button
                        type="button"
                        className="inline-flex h-6 w-full items-center justify-center gap-1 rounded-md border text-[0.846em] transition hover:opacity-100"
                        style={{ borderColor: theme.node.stroke, opacity: 0.8, color: theme.node.text }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setRowAudioTarget({ shotNo, ids });
                        }}
                        // 这一格是**复数**的：文案永远表达「再挂一条」，绝不写「改声音」——
                        // 否则会让人以为点进去是把已有那条换掉，而不是追加。
                        title={visibleIds.length ? t("canvas.scriptNode.rowAudioAddMore", { no: shotNo, count: visibleIds.length }) : t("canvas.scriptNode.rowAudioAdd", { no: shotNo })}
                    >
                        {visibleIds.length ? <Plus className="size-3" /> : <Music2 className="size-3" />}
                        {visibleIds.length ? t("canvas.scriptNode.rowAudioAddMoreShort", { count: visibleIds.length }) : t("canvas.scriptNode.rowAudioAddShort")}
                    </button>
                </div>
            </td>
        );
    };

    const tablePanel = (
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
            {assetToolbar}
            {/* `data-canvas-scroll-managed="self"`：滚动位置由本组件自己记（见上面的 effect），
                让 canvas-node 的通用机制跳过它 —— 那套按 DOM 索引当 key，表体会漂。 */}
            <div
                ref={bodyRef}
                data-canvas-no-zoom
                data-canvas-scroll-managed="self"
                className="script-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border"
                style={{ borderColor: theme.node.stroke, background: theme.node.panel }}
            >
                <table ref={tableRef} className="border-separate border-spacing-0 leading-tight" style={tableStyle}>
                    <colgroup>
                        {showRowSelect ? <col style={{ width: TABLE_SELECT_WIDTH }} /> : null}
                        {displayColumns.map((column) => (
                            <Fragment key={column.key}>
                                <col style={{ width: column.width }} />
                                {/* 「声音」列紧跟在镜号之后：镜号 + 这一镜配什么音，是同一层信息。 */}
                                {showRowAudios && column.key === "shot_no" ? <col style={{ width: TABLE_AUDIO_WIDTH }} /> : null}
                            </Fragment>
                        ))}
                        <col style={{ width: TABLE_ACTION_WIDTH }} />
                    </colgroup>
                    <thead>
                        <tr>
                            {showRowSelect ? (
                                <th className="sticky top-0 z-10 border-b px-1 py-1" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}>
                                    <button
                                        type="button"
                                        className="inline-flex size-5 items-center justify-center rounded-md border text-[0.7em] transition"
                                        style={{
                                            borderColor: selectedRows.size && selectedRows.size === rows.length ? theme.toolbar.activeBg : theme.node.stroke,
                                            background: selectedRows.size && selectedRows.size === rows.length ? theme.toolbar.activeBg : "transparent",
                                            color: selectedRows.size && selectedRows.size === rows.length ? theme.toolbar.activeText : theme.node.text,
                                        }}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            toggleAllRows();
                                        }}
                                        title={selectedRows.size === rows.length ? t("canvas.scriptNode.selectNone") : t("canvas.scriptNode.selectAll")}
                                    >
                                        {selectedRows.size && selectedRows.size === rows.length ? "✓" : ""}
                                    </button>
                                </th>
                            ) : null}
                            {displayColumns.map((column) => {
                                // 自建资产列的表头多一个「×」：删列（连带清掉行文本与图位，先确认）。
                                const extra = extraColumns.find((item) => item.key === column.key);
                                return (
                                    <Fragment key={column.key}>
                                        <th
                                            className={`sticky top-0 z-10 border-b px-2 py-1 text-left font-semibold whitespace-nowrap ${column.numeric ? "text-right" : ""}`}
                                            style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}
                                            title={extra ? t("canvas.scriptNode.extraColumnHint", { role: t(`canvas.scriptNode.assetRole_${extra.role}`) }) : undefined}
                                        >
                                            <span className="inline-flex items-center gap-1">
                                                {column.label}
                                                {extra ? (
                                                    <button
                                                        type="button"
                                                        className="inline-flex size-4 items-center justify-center rounded border opacity-60 transition hover:opacity-100"
                                                        style={{ borderColor: theme.node.stroke }}
                                                        onMouseDown={(event) => event.stopPropagation()}
                                                        onPointerDown={(event) => event.stopPropagation()}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            removeExtraColumn(extra);
                                                        }}
                                                        title={t("canvas.scriptNode.extraColumnRemove")}
                                                    >
                                                        <X className="size-2.5" />
                                                    </button>
                                                ) : null}
                                            </span>
                                        </th>
                                        {showRowAudios && column.key === "shot_no" ? (
                                            <th
                                                className="sticky top-0 z-10 border-b px-2 py-1 text-left font-semibold whitespace-nowrap"
                                                style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}
                                                title={t("canvas.scriptNode.rowAudioColumnHint")}
                                            >
                                                <span className="inline-flex items-center gap-1">
                                                    <Music2 className="size-3" />
                                                    {t("canvas.scriptNode.rowAudioColumn")}
                                                </span>
                                            </th>
                                        ) : null}
                                    </Fragment>
                                );
                            })}
                            <th className="sticky right-0 top-0 z-30 border-b border-l px-2 py-1 text-left font-semibold whitespace-nowrap" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}>
                                {t("canvas.scriptNode.columnActions")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, rowIndex) => (
                            <tr key={`${row.shot_no}-${rowIndex}`} className="align-top">
                                {showRowSelect ? (
                                    <td className="border-b px-1 py-1.5" style={{ borderColor: theme.node.stroke }}>
                                        <button
                                            type="button"
                                            className="inline-flex size-5 items-center justify-center rounded-md border text-[0.7em] transition"
                                            style={{
                                                borderColor: selectedRows.has(rowIndex) ? theme.toolbar.activeBg : theme.node.stroke,
                                                background: selectedRows.has(rowIndex) ? theme.toolbar.activeBg : "transparent",
                                                color: selectedRows.has(rowIndex) ? theme.toolbar.activeText : theme.node.text,
                                                opacity: selectedRows.has(rowIndex) ? 1 : 0.6,
                                            }}
                                            onMouseDown={(event) => event.stopPropagation()}
                                            onPointerDown={(event) => event.stopPropagation()}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleRowSelected(rowIndex);
                                            }}
                                            title={t("canvas.scriptNode.selectRow")}
                                        >
                                            {selectedRows.has(rowIndex) ? "✓" : ""}
                                        </button>
                                    </td>
                                ) : null}
                                {displayColumns.map((column) => {
                                    const value = String(row[column.key] ?? "");
                                    // 「按镜按资产」图位：挂在资产列（角色1 / 角色2 / 场景 / 道具 / 人物站位 **+ 自建资产列**）上。
                                    // 这一格的图**只属于这一镜的这一列**，铺链路时也只连到这一镜的图片 / 视频节点。
                                    const cellShotNo = row.shot_no || rowIndex + 1;
                                    // 这一格**自己**挂的图：精准指定，只属于这一镜的这一列。
                                    const cellIds = scriptCellAssetIds(cellAssets, cellShotNo, column.key, extraColumns);
                                    const showCellSlot = showCellAssets && isScriptAssetColumn(column.key, extraColumns);
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
                                        <Fragment key={column.key}>
                                            <td
                                                data-canvas-selectable-text
                                                className={`cursor-text border-b px-2 py-0.5 ${column.numeric ? "text-right tabular-nums" : ""}`}
                                                style={{ borderColor: theme.node.stroke }}
                                                title={value || t("canvas.scriptNode.noContent")}
                                                onDoubleClick={(event) => {
                                                    event.stopPropagation();
                                                    setEditing({ rowIndex, key: column.key });
                                                }}
                                            >
                                            {value ? (
                                                // 默认**完整显示**（不截断），但超过 6 行后收进格内滚动：行高由这一行
                                                // 最高的格子决定，长提示词一完整展开就会把整行撑到 300px 起，
                                                // 旁边短内容的格子全变成留白（用户反馈的「镜头之间间距太大」）。
                                                // 内容一个字没少：悬停有全文 title，双击仍是完整的编辑弹窗。
                                                <div
                                                    className={`whitespace-pre-wrap break-words ${showFullText ? "thin-scrollbar overflow-y-auto" : "line-clamp-4"}`}
                                                    style={showFullText ? { maxHeight: `${(TABLE_CELL_MAX_LINES * 1.25).toFixed(2)}em` } : undefined}
                                                >
                                                    {value}
                                                </div>
                                            ) : (
                                                <div className="opacity-35">{t("canvas.scriptNode.noContent")}</div>
                                            )}
                                            {showCellSlot ? (
                                                <div className="mt-0.5 flex flex-wrap items-center gap-1" onDoubleClick={(event) => event.stopPropagation()}>
                                                    {cellDisplayIds.map((imageId) => {
                                                        const meta = imageLookup.get(imageId);
                                                        // 缩略图 56px（原 84px）：行高按用户要求压掉约 1/3，图也一起收一号，
                                                        // 否则资产列会把整行撑到 84px 起。表里仍能看清是谁。
                                                        return (
                                                            <span
                                                                key={imageId}
                                                                className="group relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border"
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
                                            {/* 「声音」列紧跟在镜号之后（与 colgroup / thead 同序）。 */}
                                            {showRowAudios && column.key === "shot_no" ? renderAudioCell(cellShotNo) : null}
                                        </Fragment>
                                    );
                                })}
                                {/* 右侧吸附：整表 4.2k px 宽，操作列不吸附就得横向拖到底才够得到。 */}
                                <td className="sticky right-0 z-10 border-b border-l px-1 py-1" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                    <div className="flex flex-wrap items-center gap-0.5">
                                        {/* 复制类动作改成纯图标：带文字的按钮一行只放得下一个，两行复制按钮
                                            就够把每行撑高 50px（用户反馈的「镜头之间间距太大」有一半来自这里）。 */}
                                        {preset.rowActions.map((action) => (
                                            <button
                                                key={action.key}
                                                type="button"
                                                className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={() => copyValue(String(row[action.key] ?? ""))}
                                                title={t(`canvas.scriptNode.${action.labelKey}`)}
                                            >
                                                <Copy className="size-3" />
                                            </button>
                                        ))}
                                        {onInsertPrompt ? (
                                            <button
                                                type="button"
                                                className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100"
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
                                                className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100"
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
                                                className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={() => onRegenerateShot(node.id, rowIndex)}
                                                title={t("canvas.scriptNode.regenShot")}
                                            >
                                                <RotateCcw className="size-3" />
                                            </button>
                                        ) : null}
                                        {/* 加剧情 / 带要求重生成：只改这一镜，可关掉「与上下镜站位一致」。 */}
                                        {onRegenerateRows ? (
                                            <button
                                                type="button"
                                                className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100"
                                                style={{ borderColor: storyScriptRowNote(rowNotes, row.shot_no || rowIndex + 1) ? theme.toolbar.activeBg : theme.node.stroke, opacity: 0.86 }}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    openRowEdit([rowIndex]);
                                                }}
                                                title={
                                                    storyScriptRowNote(rowNotes, row.shot_no || rowIndex + 1)
                                                        ? `${t("canvas.scriptNode.rowEditNote", { note: storyScriptRowNote(rowNotes, row.shot_no || rowIndex + 1) })}`
                                                        : t("canvas.scriptNode.rowEdit")
                                                }
                                            >
                                                <Wand2 className="size-3" />
                                            </button>
                                        ) : null}
                                        {/*
                                         * 单镜补齐资产：**只补这一镜**空着的资产列（不再只靠「整表补齐」）。
                                         *
                                         * 两个刻意的相反做法（上一版是「没缺列就整颗按钮消失」+ 主色描边）：
                                         * ① **常驻显示**：缺列才点亮，资产齐了变成禁用态并提示「没有缺失的资产列」。
                                         *    之前整颗消失，用户只会觉得「按钮一直是灰的 / 坏的」，根本分不清能不能点。
                                         * ② **点亮态用实心**：操作列十几个描边小图标，描边按钮在这张表里读不出「可点」；
                                         *    实心（深底浅字）在两种主题下都是全表最显眼的一颗。
                                         */}
                                        {onFillShotAssets ? (
                                            <button
                                                type="button"
                                                className="inline-flex h-5 items-center gap-0.5 rounded-md border px-1 text-[0.769em] font-medium transition disabled:cursor-not-allowed disabled:opacity-30"
                                                style={
                                                    rowAssetFillTargets[rowIndex]?.length
                                                        ? { borderColor: theme.toolbar.activeText, background: theme.toolbar.activeText, color: theme.node.panel }
                                                        : { borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }
                                                }
                                                disabled={!rowAssetFillTargets[rowIndex]?.length}
                                                onMouseDown={(event) => event.stopPropagation()}
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    if (!rowAssetFillTargets[rowIndex]?.length) return;
                                                    onFillShotAssets(node.id, rowIndex);
                                                }}
                                                title={
                                                    rowAssetFillTargets[rowIndex]?.length
                                                        ? t("canvas.scriptNode.assetFillHint", {
                                                              labels: rowAssetFillTargets[rowIndex].map((target) => target.label).join(" / "),
                                                          })
                                                        : t("canvas.scriptNode.assetFillNothing")
                                                }
                                            >
                                                <Sparkles className="size-3" />
                                                {t("canvas.scriptNode.assetFillShot")}
                                            </button>
                                        ) : null}
                                        {rows.length > 1 ? (
                                            <>
                                                <button
                                                    type="button"
                                                    className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100 disabled:opacity-30"
                                                    style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                    disabled={rowIndex === 0}
                                                    onMouseDown={(event) => event.stopPropagation()}
                                                    onPointerDown={(event) => event.stopPropagation()}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        moveRow(rowIndex, -1);
                                                    }}
                                                    title={t("canvas.scriptNode.moveRowUp")}
                                                >
                                                    <ArrowUp className="size-3" />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100 disabled:opacity-30"
                                                    style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                                                    disabled={rowIndex === rows.length - 1}
                                                    onMouseDown={(event) => event.stopPropagation()}
                                                    onPointerDown={(event) => event.stopPropagation()}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        moveRow(rowIndex, 1);
                                                    }}
                                                    title={t("canvas.scriptNode.moveRowDown")}
                                                >
                                                    <ArrowDown className="size-3" />
                                                </button>
                                            </>
                                        ) : null}
                                        <button
                                            type="button"
                                            className="inline-flex size-5 items-center justify-center rounded-md border transition hover:opacity-100"
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
            {/*
             * 分镜表操作条。
             *
             * DOM 上仍是表体的兄弟节点（放在最后），但用 `order-first` 排到最前面 => **视觉上就是表格右上角**。
             * 以前这排按钮在表格左下角，翻到表尾才看得见，用户一直找不到「添加资产列 / 整表补齐」；
             * 换位置比新加按钮更管用，所以内容一个字没改，只动了容器。
             */}
            <div className="order-first mb-1 flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-[0.923em]" style={{ color: theme.node.text }}>
                <span className="rounded border px-1.5 opacity-90" style={{ borderColor: theme.node.stroke }}>
                    {t(`canvas.scriptNode.preset_${presetId}`)}
                </span>
                <span className="opacity-55">
                    {scriptTitle ? `${scriptTitle} · ` : ""}
                    {t("canvas.scriptNode.shotCount", { count: rows.length })} · {t("canvas.scriptNode.totalDuration", { seconds: totalDuration })}
                </span>
                {/* 执行方案也放到表体操作条：看表时想「换套提示词再重生成」不用切回输入视图。
                    与「每镜时长 / 视频分段」并排，都属于「怎么生成」的那一组。 */}
                {schemeSelector}
                {/* 每镜时长也放到表体操作条：用户看分镜表时就能直接改，不用切回「输入」视图再找。
                    与「视频分段」并排：选单镜 → 每镜一段（10/15 锁定成片秒数、5 秒是上限）；
                    选「按每段时长」→ 连续几镜凑够 N 秒。 */}
                {segmentSelector}
                {mergeSelector}
                {/* 手动添加资产列（「宠物」「车辆」…）：自建列的行为与内置资产列一致，铺链路会按分类把图连进图片节点。
                    常驻显示、到上限才禁用 —— 之前到 8 列直接消失，看起来像「这个功能没了 / 加不上」。 */}
                <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded-full border px-2 font-medium transition disabled:cursor-not-allowed disabled:opacity-30"
                    style={{ borderColor: theme.toolbar.activeText, color: theme.toolbar.activeText, background: `${theme.toolbar.activeText}14` }}
                    disabled={extraColumns.length >= STORY_SCRIPT_MAX_EXTRA_COLUMNS}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        if (extraColumns.length >= STORY_SCRIPT_MAX_EXTRA_COLUMNS) return;
                        setAddColumnLabel("");
                        setAddColumnRole("scene");
                        setAddColumnOpen(true);
                    }}
                    title={
                        extraColumns.length >= STORY_SCRIPT_MAX_EXTRA_COLUMNS
                            ? t("canvas.scriptNode.extraColumnLimit", { count: STORY_SCRIPT_MAX_EXTRA_COLUMNS })
                            : t("canvas.scriptNode.extraColumnAddHint")
                    }
                >
                    <Plus className="size-3" />
                    {t("canvas.scriptNode.extraColumnAdd")}
                </button>
                {/* 整表补齐资产：还有缺列时才出现（数量就是「还有几镜缺资产」）。 */}
                {onFillAllShotAssets && missingAssetRowCount ? (
                    <button
                        type="button"
                        className="inline-flex h-6 items-center gap-1 rounded-full border px-2 transition hover:opacity-100"
                        style={{ borderColor: theme.node.stroke, opacity: 0.9 }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onFillAllShotAssets(node.id);
                        }}
                        title={t("canvas.scriptNode.assetFillAllHint", { count: missingAssetRowCount })}
                    >
                        <Sparkles className="size-3" />
                        {t("canvas.scriptNode.assetFillAll", { count: missingAssetRowCount })}
                    </button>
                ) : null}
                {/* 简洁版 / 完整版：一键隐藏「画面描述 / 角色动作 / 人物站位 / 情绪 / 场景标签 / 光影氛围」六列。
                    与右边「完整显示 / 精简」不是一回事：那个是压单格行数，这个是直接少几列。
                    只影响显示（行数据一个字不删），且状态写进 metadata —— 节点被卸载回来仍是用户选的那一档。 */}
                <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded-full border px-2 transition"
                    style={{
                        borderColor: compactColumns ? theme.toolbar.activeText : theme.node.stroke,
                        // 选中态实心：`activeBg` 是浅米色，一排描边胶囊里会被读成「禁用」。
                        background: compactColumns ? theme.toolbar.activeText : "transparent",
                        color: compactColumns ? theme.node.panel : theme.node.text,
                        opacity: compactColumns ? 1 : 0.75,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        // 默认是简洁版（`undefined` 也按开算），所以这里必须写**显式 false** 才能真正关掉；
                        // 三态语义：undefined = 默认（简洁）、true = 简洁、false = 完整版。
                        patchMetadata({ scriptCompactColumns: compactColumns ? false : true });
                    }}
                    title={compactColumns ? t("canvas.scriptNode.compactColumnsRestoreHint") : t("canvas.scriptNode.compactColumnsHint")}
                >
                    <AlignJustify className="size-3" />
                    {compactColumns ? t("canvas.scriptNode.compactColumnsRestore") : t("canvas.scriptNode.compactColumns")}
                </button>
                {/* 完整显示 / 精简：默认完整（不用拖滑条就能看全每格内容），太长时再切精简。 */}
                <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded-full border px-2 transition"
                    style={{
                        borderColor: theme.node.stroke,
                        background: showFullText ? `${theme.toolbar.activeBg}1f` : "transparent",
                        color: showFullText ? theme.toolbar.activeBg : theme.node.text,
                        opacity: showFullText ? 1 : 0.75,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        setShowFullText((current) => !current);
                    }}
                    title={showFullText ? t("canvas.scriptNode.cellFullOnHint") : t("canvas.scriptNode.cellFullOffHint")}
                >
                    {showFullText ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
                    {showFullText ? t("canvas.scriptNode.cellFull") : t("canvas.scriptNode.cellCompact")}
                </button>
                {/* 批量条：勾了行才出现，避免平时占地方。 */}
                {showRowSelect && selectedRows.size ? (
                    <span className="inline-flex items-center gap-1">
                        <span className="rounded border px-1.5 opacity-90" style={{ borderColor: theme.toolbar.activeBg, color: theme.toolbar.activeBg }}>
                            {t("canvas.scriptNode.selectedCount", { count: selectedRows.size })}
                        </span>
                        {onRegenerateRows ? (
                            <button
                                type="button"
                                className="inline-flex h-6 items-center gap-1 rounded-full border px-2 transition"
                                style={{ borderColor: theme.node.stroke }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    openRowEdit(Array.from(selectedRows));
                                }}
                                title={t("canvas.scriptNode.regenSelectedHint")}
                            >
                                <Wand2 className="size-3" />
                                {t("canvas.scriptNode.regenSelected")}
                            </button>
                        ) : null}
                        {onBuildShotVideos ? (
                            <button
                                type="button"
                                className="inline-flex h-6 items-center gap-1 rounded-full border px-2 transition"
                                style={{ borderColor: theme.node.stroke }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onBuildShotVideos(node.id, Array.from(selectedRows));
                                    setSelectedRows(new Set());
                                }}
                                title={t("canvas.scriptNode.buildSelectedVideosHint")}
                            >
                                <Video className="size-3" />
                                {t("canvas.scriptNode.buildSelectedVideos")}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="inline-flex size-6 items-center justify-center rounded-full border transition"
                            style={{ borderColor: theme.node.stroke, opacity: 0.8 }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                setSelectedRows(new Set());
                            }}
                            title={t("canvas.scriptNode.selectNone")}
                        >
                            <X className="size-3" />
                        </button>
                    </span>
                ) : null}
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
            onGenerate={onGenerateAsset ? (role, prompt, title, styleTemplateId) => onGenerateAsset(node.id, role, prompt, title, styleTemplateId) : undefined}
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
                prompt: preset.buildShotPrompts(rows.find((row) => (row.shot_no || 0) === rowAssetTarget.shotNo) || { shot_no: rowAssetTarget.shotNo, duration: 0 }, extraColumns).imagePrompt,
                title: t("canvas.scriptNode.pipelineImage", { no: rowAssetTarget.shotNo }),
                onLink: (nodeIds) => onRowAssetsChange?.(node.id, rowAssetTarget.shotNo, nodeIds),
                onImport: (files) => onRowAssetImport?.(node.id, rowAssetTarget.shotNo, files),
                onGenerate: onRowAssetGenerate ? (prompt, title, _model, styleTemplateId) => onRowAssetGenerate(node.id, rowAssetTarget.shotNo, prompt, title, styleTemplateId) : undefined,
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
                candidate: collectScriptCellPromptCandidate(cellAssetTarget.columnKey, rows.find((row) => (row.shot_no || 0) === cellAssetTarget.shotNo) || null, extraColumns),
                title: t("canvas.scriptNode.cellAssetDialogTitle", { no: cellAssetTarget.shotNo, label: cellAssetTarget.label }),
                model: cellModel,
                onModelChange: (model) => onCellModelChange?.(node.id, model),
                onLink: (nodeIds) => onCellAssetsChange?.(node.id, cellAssetTarget.shotNo, cellAssetTarget.columnKey, nodeIds),
                onImport: (files) => onCellAssetImport?.(node.id, cellAssetTarget.shotNo, cellAssetTarget.columnKey, files),
                onGenerate: onCellAssetGenerate
                    ? (prompt, title, model, styleTemplateId) => onCellAssetGenerate(node.id, cellAssetTarget.shotNo, cellAssetTarget.columnKey, prompt, title, model, styleTemplateId)
                    : undefined,
            }}
        />
    ) : null;

    // 「声音」列弹窗：只给这一镜挂音频（台词配音 / 音效）。候选只列音频节点、上传只收音频文件，
    // 也不显示「AI 生成」tab —— 声音没有「按描述生成」这回事。三条路都写回 metadata.scriptRowAudios。
    const rowAudioDialog = rowAudioTarget ? (
        <CanvasScriptAssetDialog
            open
            theme={theme}
            candidates={audioCandidates || []}
            rows={rows}
            onClose={() => setRowAudioTarget(null)}
            onLink={() => undefined}
            onImport={() => undefined}
            rowMode={{
                no: rowAudioTarget.shotNo,
                selectedIds: rowAudioTarget.ids,
                audio: true,
                onLink: (nodeIds) => onRowAudiosChange?.(node.id, rowAudioTarget.shotNo, nodeIds),
                onImport: (files) => onRowAudioImport?.(node.id, rowAudioTarget.shotNo, files),
            }}
        />
    ) : null;

    // 「加剧情 / 批量重生成」弹窗：一段只作用于这批镜的剧情 / 要求 + 一个「保持站位一致」开关。
    // 用 antd Modal（portal 到 body，不受画布 pointerdown 吞事件影响）；里面只放 textarea 与自绘 chip，
    // 不放 antd Select / Dropdown 这类自带浮层的控件（画布上容易被全局 pointerdown 判成「点外部」）。
    const rowEditIndexes = rowEditTarget || [];
    const rowEditShots = rowEditIndexes.map((index) => rows[index]?.shot_no || index + 1);
    const rowEditDialog = onRegenerateRows ? (
        <Modal
            open={Boolean(rowEditIndexes.length)}
            title={
                rowEditIndexes.length > 1
                    ? t("canvas.scriptNode.rowEditTitleBatch", { count: rowEditIndexes.length, shots: rowEditShots.join("、") })
                    : t("canvas.scriptNode.rowEditTitle", { no: rowEditShots[0] ?? "" })
            }
            okText={t("canvas.scriptNode.rowEditRun")}
            cancelText={t("common.cancel")}
            width={580}
            onOk={submitRowEdit}
            onCancel={() => setRowEditTarget(null)}
        >
            <div className="flex flex-col gap-3 text-[14px]">
                <div className="opacity-70">{t("canvas.scriptNode.rowEditHint")}</div>
                <textarea
                    className="thin-scrollbar min-h-32 w-full resize-y rounded-lg border p-2 leading-relaxed outline-none"
                    style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                    value={rowPlotDraft}
                    placeholder={t("canvas.scriptNode.rowEditPlaceholder")}
                    onChange={(event) => setRowPlotDraft(event.target.value)}
                />
                {/* 站位一致性：默认「保持一致」（沿用老行为），关掉就允许这一镜重新安排人物站位。 */}
                <button
                    type="button"
                    className="inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] transition"
                    style={{
                        borderColor: rowKeepBlocking ? theme.toolbar.activeBg : theme.node.stroke,
                        background: rowKeepBlocking ? `${theme.toolbar.activeBg}1f` : "transparent",
                        color: rowKeepBlocking ? theme.toolbar.activeBg : theme.node.text,
                    }}
                    onClick={() => setRowKeepBlocking((current) => !current)}
                    title={t("canvas.scriptNode.rowEditBlockingHint")}
                >
                    {rowKeepBlocking ? "✓" : "○"} {t("canvas.scriptNode.rowEditBlocking")}
                </button>
                {rowEditIndexes.length > 1 ? <div className="text-[12px] opacity-60">{t("canvas.scriptNode.rowEditBatchNote")}</div> : null}
            </div>
        </Modal>
    ) : null;

    // 「添加资产列」弹窗：列名 + 分类。自建列和内置资产列一样，铺链路时按分类把图连进图片节点。
    const addColumnDialog = (
        <Modal
            open={addColumnOpen}
            title={t("canvas.scriptNode.extraColumnTitle")}
            okText={t("canvas.scriptNode.extraColumnAdd")}
            cancelText={t("common.cancel")}
            width={480}
            onOk={submitAddColumn}
            onCancel={() => setAddColumnOpen(false)}
        >
            <div className="flex flex-col gap-3 text-[14px]">
                <div className="opacity-70">{t("canvas.scriptNode.extraColumnHint2")}</div>
                <input
                    className="h-9 w-full rounded-lg border px-2 outline-none"
                    style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                    value={addColumnLabel}
                    placeholder={t("canvas.scriptNode.extraColumnPlaceholder")}
                    onChange={(event) => setAddColumnLabel(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") submitAddColumn();
                    }}
                />
                <div className="flex flex-col gap-1.5">
                    <span className="opacity-70">{t("canvas.scriptNode.extraColumnRole")}</span>
                    <div className="flex flex-wrap gap-1.5">
                        {SCRIPT_EXTRA_COLUMN_ROLE_IDS.map((role) => {
                            const active = role === addColumnRole;
                            return (
                                <button
                                    key={role}
                                    type="button"
                                    className="inline-flex h-7 items-center rounded-full border px-2.5 transition"
                                    style={{
                                        borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                                        background: active ? `${theme.toolbar.activeBg}1f` : "transparent",
                                        color: active ? theme.toolbar.activeBg : theme.node.text,
                                    }}
                                    onClick={() => setAddColumnRole(role)}
                                    title={t("canvas.scriptNode.extraColumnRoleHint")}
                                >
                                    {t(`canvas.scriptNode.assetRole_${role}`)}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        </Modal>
    );

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
            {/* 自定义提示词：三种用途共用这个文本编辑弹窗（textarea + 字号 + 提示词库），保存留空即恢复预设。
                - system：整段替换系统提示词（换生成器）；
                - asset / shot：只加一段任务书专项要求（各管一组列，互不影响）。 */}
            <CanvasTextEditDialog
                open={customPromptKind !== null}
                value={
                    customPromptKind === "asset"
                        ? node.metadata?.scriptAssetPrompt || ""
                        : customPromptKind === "shot"
                          ? node.metadata?.scriptShotPrompt || ""
                          : node.metadata?.scriptSystemPrompt || getStoryScriptSystemPrompt(presetId)
                }
                title={
                    customPromptKind === "asset"
                        ? t("canvas.scriptNode.assetPromptTitle")
                        : customPromptKind === "shot"
                          ? t("canvas.scriptNode.shotPromptTitle")
                          : t("canvas.scriptNode.customPromptTitle", { preset: t(`canvas.scriptNode.preset_${presetId}`) })
                }
                placeholder={
                    customPromptKind === "asset"
                        ? t("canvas.scriptNode.assetPromptPlaceholder")
                        : customPromptKind === "shot"
                          ? t("canvas.scriptNode.shotPromptPlaceholder")
                          : t("canvas.scriptNode.customPromptPlaceholder", { count: columns.length })
                }
                onClose={() => setCustomPromptKind(null)}
                onSave={(value) => {
                    const kind = customPromptKind;
                    if (!kind) return;
                    const trimmed = value.trim();
                    // 留空 = 恢复预设（与「自定义系统提示词」同一口径），不是存一个空字符串。
                    if (kind === "system") patchMetadata({ scriptSystemPrompt: trimmed ? value : undefined });
                    else if (kind === "asset") patchMetadata({ scriptAssetPrompt: trimmed ? value : undefined });
                    else patchMetadata({ scriptShotPrompt: trimmed ? value : undefined });
                    setCustomPromptKind(null);
                    if (trimmed) message.success(t(kind === "system" ? "canvas.scriptNode.customPromptSaved" : "canvas.scriptNode.promptOverrideSaved", { count: trimmed.length }));
                    else message.success(t("canvas.scriptNode.promptOverrideCleared"));
                }}
            />
            {/* 旧的自定义提示词弹窗已合并到上面这一个（按 customPromptKind 分三种）。 */}
            {assetDialog}
            {rowAssetDialog}
            {cellAssetDialog}
            {rowAudioDialog}
            {rowEditDialog}
            {addColumnDialog}
        </>
    );
}
