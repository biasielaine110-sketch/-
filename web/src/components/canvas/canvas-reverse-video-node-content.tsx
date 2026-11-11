import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, InputNumber, Modal, Select, Tag } from "antd";
import { CircleAlert, Clapperboard, FileText, Images, Layers, Link2, Loader2, SlidersHorizontal, Sparkles, Video, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { DEFAULT_REVERSE_VIDEO_SECONDS, DEFAULT_VIDEO_REVERSE_REQUIREMENT, REVERSE_VIDEO_SECONDS_MAX, REVERSE_VIDEO_SECONDS_MIN, VIDEO_REVERSE_MODES, buildDefaultVideoReverseRequirement, normalizeReverseVideoTarget, readReverseVideoTarget, resolveReverseVideoQuality, resolveReverseVideoSize, type VideoReverseMode, type VideoReverseResult } from "@/lib/canvas/video-reverse";
import { asScriptSchemeId, SCRIPT_SCHEME_IDS, type ScriptSchemeId } from "@/constant/script-scheme";
import { SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP, SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT } from "@/constant/story-script";
import { isMochianiVideoEngine, MOCHIANI_VIDEO_ENGINE } from "@/constant/mochiani-video";
import { getStyleTemplate } from "@/constant/style-templates";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { useConfigStore, useEffectiveConfig, resolveModelForCapability } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasReverseVideoTarget } from "@/types/canvas";
import { CanvasSizePicker } from "./canvas-size-picker";
import { CanvasStylePicker } from "./canvas-style-picker";

/**
 * 「反推视频」命令集合**节点**的内容区。
 *
 * 三条命令都建立在同一个前提上：**先接入一条视频**。接入有两条路，都认：
 *  ① 画布连线：视频节点 → 本节点（最自然，`project.tsx` 解析后传 `attachedVideoId` + `attachSource="connection"`）；
 *  ② 窗口里的「接入视频」：选中画布上的视频直接接，或从列表 / 粘贴链接建一个（落在 `metadata.reverseVideoSourceId`）。
 *
 * 没接入时按钮是「看起来禁用」的（`aria-disabled`）——刻意不用真 `disabled`：
 * 真禁用时悬停不出 `title`、点了也没反应，用户只会觉得坏了。
 *
 * 真正的编排在 `project.tsx: runVideoReverse`：建对话节点 → 连视频 → 调技能反推 →
 * 结果落文本节点 →（03）接脚本生成器并跑一键视频。这里只负责「选视频 + 按按钮 + 显示进度」。
 * 进度 / 结果落在 `metadata.reverseVideoRun`：节点滚出视口会被卸载重挂，只放 state 会凭空消失。
 */

export type ReverseVideoOption = {
    id: string;
    title: string;
    url: string;
};

type CanvasReverseVideoNodeContentProps = {
    node: CanvasNodeData;
    /** 画布上所有可用的视频节点 */
    videos: ReverseVideoOption[];
    /** 当前选中的视频节点（点「接入视频」时优先接它） */
    selectedVideoId?: string | null;
    /** 已解析出的接入视频（连线优先，其次手动接入） */
    attachedVideoId?: string | null;
    /** 接入来源，只影响文案：连线接入无法在这里「取消」，得去删那根线 */
    attachSource?: "connection" | "manual" | null;
    /**
     * 除视频以外连进来的参考图（目前只认图片节点）。
     * 02/03 跑一键视频时，**名字对上分镜表里道具**的那几张会被直接挂成道具资产、
     * 并且不再单独生成该道具的资产图（见 `project.tsx: mountReferenceAssetsToScript`）。
     */
    referenceImages?: ReverseVideoOption[];
    /** 反推固定使用的文本模型（展示用，真正生效在 project.tsx） */
    reverseModelLabel?: string;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    /** 粘贴链接建一个视频节点，返回新节点 id */
    onCreateVideoFromUrl?: (videoUrl: string) => Promise<string>;
    /** 执行一条命令；report 用来把阶段文案打到窗口里 */
    onRun: (input: { videoNodeId: string; mode: VideoReverseMode; requirement?: string; reverseNodeId?: string; scriptScheme?: ScriptSchemeId; shotsPerClip?: number }, report: (stage: string) => void) => Promise<VideoReverseResult>;
};

const MODE_ICON: Record<VideoReverseMode, typeof Video> = {
    1: Video,
    2: FileText,
    3: Clapperboard,
};

/** 落在窗口里会挡住「拖整个节点」的控件：命中就让事件停在这层。 */
const INTERACTIVE_SELECTOR = "textarea,input,button,[contenteditable],[data-canvas-selectable-text],.ant-select,.ant-btn,.ant-tag,.ant-modal";

/**
 * 「running」超过这个时长就判定为上次被打断（刷新页面会掐断请求，状态位来不及回写）。
 * 必须**大于 03 一键视频的最长预算（45 分钟）**，否则长任务跑到一半按钮就被解锁，用户能连点两条命令。
 */
const STALE_RUN_MS = 60 * 60_000;

/**
 * 分辨率档位。与视频节点参数面板同一套值（`video-settings-panel.tsx` 里的 `vquality`）。
 *
 * 用户 2026-11-11 第 02 条：「分辨率也是优先 720p」——所以控件上就显示 720p（不是空着写
 * 「跟随全局」），`metadata.quality` 仍然是空的，等于「按默认 720p 走」。去掉空档是因为
 * 一旦控件 value 恒为有效档位，留一个永远选不中的「跟随全局」只会让人以为坏了。
 */
const QUALITY_OPTIONS = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
    { value: "2k", label: "2K" },
];

const qualityLabel = (value: string | undefined) => QUALITY_OPTIONS.find((item) => item.value === (value || ""))?.label || "720p";

export function CanvasReverseVideoNodeContent({
    node,
    videos,
    selectedVideoId,
    attachedVideoId,
    attachSource,
    referenceImages,
    reverseModelLabel,
    onConfigChange,
    onCreateVideoFromUrl,
    onRun,
}: CanvasReverseVideoNodeContentProps) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [urlDraft, setUrlDraft] = useState("");
    const [creating, setCreating] = useState(false);
    const [requirementMode, setRequirementMode] = useState<VideoReverseMode | null>(null);
    const [requirementText, setRequirementText] = useState(DEFAULT_VIDEO_REVERSE_REQUIREMENT);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const run = node.metadata?.reverseVideoRun;
    /**
     * 目标视频参数（风格 / 模型 / 秒数 / 比例 / 分辨率，用户 2026-11-09）：
     * 一律用 `readReverseVideoTarget` 归一化后再渲染 —— 老节点没有这个字段，秒数也要有默认 30。
     */
    const target = useMemo(() => readReverseVideoTarget(node.metadata), [node.metadata]);
    /**
     * 写回：**整体覆盖** `reverseVideoTarget`（`applyNodeConfigPatch` 是浅合并，只 patch 一个键会把其它几个抹掉）。
     * `normalizeReverseVideoTarget` 顺手把空串键删掉 = 「跟随全局」，同时把秒数夹到合法区间。
     */
    const patchTarget = useCallback(
        (patch: Partial<CanvasReverseVideoTarget>) => {
            onConfigChange(node.id, { reverseVideoTarget: normalizeReverseVideoTarget({ ...target, ...patch }) });
        },
        [node.id, onConfigChange, target],
    );
    /**
     * 「每 3 个镜头合一个视频」开关（用户 2026-11-11 第 01 条）：存在 `reverseVideoTarget.shotsPerClip`，
     * 03 建脚本节点时搬进 `scriptShotsPerClip`，之后铺链路按 3 镜切片。
     */
    const compactShots = target.shotsPerClip === SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT;
    /**
     * 有效出片参数（用户 2026-11-11 第 02 条）：窗口里没选过时给 16:9 / 720p。
     * 03 搬给脚本节点的是**同一份**（`project.tsx` 里也调这两个函数），所以摘要写的就是实际会用的。
     */
    const effectiveSize = resolveReverseVideoSize(target);
    const effectiveQuality = resolveReverseVideoQuality(target);
    /**
     * 视频模型：没选过 = 跟随偏好里的视频模型 —— 这里把它解析出来**显示**出来（而不是留一行
     * 「跟随全局」），用户一眼能看到这次会用哪个模型；只要不手动改，metadata 里仍然是空的，
     * 偏好改了它也跟着改。
     */
    const preferredVideoModel = useMemo(() => resolveModelForCapability(globalConfig, globalConfig.videoModel, "video"), [globalConfig]);
    const effectiveVideoModel = target.model || preferredVideoModel;
    /** 设置摘要（弹窗里给用户确认「按什么出片」用）。 */
    const targetSummary = useMemo(() => {
        const style = target.styleTemplateId ? getStyleTemplate(target.styleTemplateId)?.label || target.styleTemplateId : "无风格";
        // 换了引擎要写在摘要里：03 的「按这套出片」是用户最后一眼确认，不能还写着普通视频模型。
        const engine = isMochianiVideoEngine(target.videoEngine) ? "MochiAni 生视频" : "";
        // 分段口径也要写：03 是「建脚本节点 → 立刻一键视频」，铺出来几个视频窗口取决于这一档。
        const clip = target.shotsPerClip === SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT ? `每 ${SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT} 镜一个视频` : `每 ${SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP} 镜一个视频`;
        return `${target.seconds || DEFAULT_REVERSE_VIDEO_SECONDS} 秒 · ${effectiveSize} · ${qualityLabel(effectiveQuality)} · 风格：${style} · ${clip}${engine ? ` · ${engine}` : ""}`;
    }, [target]);
    /**
     * 03 弹窗里的「执行方案」选项（用户 2026-11-10）。
     *
     * 为什么必须在**选中之前**就定下来：八套方案对 `视频运动提示词` 的格式约束各不相同
     * （第四套 = 八段标签块、第五套 = 整段 10 秒视频脚本、第六套 = 光影全流程、第七 / 第八套 = 时间码 / 分镜组），
     * 而 03 是「建脚本节点 → 立刻一键视频」一气呵成，中间没有地方让用户点方案。
     * 空值 = 不表态，仍按默认判定（第四套 · 影视分镜导演优先），与「手点新建脚本节点」完全一致。
     */
    const schemeOptions = useMemo(() => [{ value: "", label: t("canvas.scriptNode.reverseSchemeFollow") }, ...SCRIPT_SCHEME_IDS.map((id) => ({ value: id, label: t(`canvas.scriptNode.scheme_${id}`) }))], [t]);
    /** 当前选中的方案（空 = 默认），只用于文案。 */
    const chosenSchemeLabel = target.scriptScheme ? t(`canvas.scriptNode.scheme_${target.scriptScheme}`) : t("canvas.scriptNode.reverseSchemeFollow");
    /**
     * 02 / 03 要求框的**默认文案**（用户 2026-11-09 口径）：
     * 「根据我提供的视频反推该视频提示词及文案，同时使用 @图片1 作为文案中的道具，重新输出一份类似的剧本文案。」
     *
     * `@图片N` 必须按「连进本节点的参考图」逐张点名：没有参考图时不提（提了模型只会瞎猜一件道具），
     * 有 N 张就写 `@图片1、@图片2…` —— 编号与 `project.tsx: runVideoReverse` 把这批图连进对话节点后
     * `sendChatMessage` 用的 mention 编号同源（`imageReferenceLabel`，按连线顺序、从 1 开始）。
     */
    const requirementDefault = useCallback(() => buildDefaultVideoReverseRequirement((referenceImages || []).map((_, index) => imageReferenceLabel(index))), [referenceImages]);
    const attached = useMemo(() => videos.find((item) => item.id === attachedVideoId) || null, [attachedVideoId, videos]);
    const selectedVideo = useMemo(() => videos.find((item) => item.id === selectedVideoId) || null, [selectedVideoId, videos]);
    /** 状态位是 running 但已经很久没更新 = 上次被刷新 / 关页面掐断了，别把按钮永久锁死。 */
    const staleRun = run?.status === "running" && Date.now() - (run.at || 0) > STALE_RUN_MS;
    const running = run?.status === "running" && !staleRun;

    // 节点内滚动：画布的 wheel 会当缩放拦掉，必须自己在原生事件上停下（React onWheel 不够）。
    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const stop = (event: WheelEvent) => event.stopPropagation();
        element.addEventListener("wheel", stop, { passive: true });
        return () => element.removeEventListener("wheel", stop);
    }, []);

    /** 只挡「真实控件」的按下：不挡的话点一下输入框就变成拖整个节点。 */
    const stopDragOnInteractive = useCallback((event: React.SyntheticEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.(INTERACTIVE_SELECTOR)) event.stopPropagation();
    }, []);

    const patchRun = useCallback(
        (next: NonNullable<CanvasNodeMetadata["reverseVideoRun"]>) => {
            onConfigChange(node.id, { reverseVideoRun: next });
        },
        [node.id, onConfigChange],
    );

    const attach = useCallback(
        (videoId: string) => {
            setPickerOpen(false);
            // 换了素材就把上一次的进度 / 产物记录清掉：那是上一条视频的结果，留着只会误导。
            onConfigChange(node.id, { reverseVideoSourceId: videoId, reverseVideoRun: undefined });
        },
        [node.id, onConfigChange],
    );

    /** 「接入视频」：画布上选中了视频就直接接；没选中就打开选择框，别让用户多跳一步。 */
    const handleAttachClick = useCallback(() => {
        if (selectedVideo && selectedVideo.id !== attachedVideoId) {
            attach(selectedVideo.id);
            message.success(`已接入「${selectedVideo.title || "视频"}」`);
            return;
        }
        setPickerOpen((prev) => !prev);
    }, [attach, attachedVideoId, message, selectedVideo]);

    const handleCreateFromUrl = useCallback(async () => {
        const url = urlDraft.trim();
        if (!url) return;
        if (!onCreateVideoFromUrl) {
            message.error("当前环境不支持按链接建视频节点，请先把视频上传到画布");
            return;
        }
        setCreating(true);
        try {
            const nodeId = await onCreateVideoFromUrl(url);
            attach(nodeId);
            setUrlDraft("");
            message.success("视频节点已建好并接入");
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setCreating(false);
        }
    }, [attach, message, onCreateVideoFromUrl, urlDraft]);

    const runMode = useCallback(
        async (mode: VideoReverseMode, requirement?: string) => {
            if (!attached) {
                message.warning("先接入视频：把视频节点连到本节点，或点「接入视频」挑一个");
                return;
            }
            patchRun({ status: "running", mode, stage: "准备中…", at: Date.now() });
            try {
                /**
                 * `scriptScheme` 显式带过去（而不是只靠 `patchTarget` 落库）：
                 * 节点 metadata 的写入要等一次 React 提交，而 03 在**同一次点击里**就要建脚本节点、
                 * 立刻生成 —— 读 `nodesRef` 可能拿到还没刷新的旧值（这个坑 2026-11-09 已经踩过一次）。
                 */
                const outcome = await onRun({ videoNodeId: attached.id, mode, requirement, reverseNodeId: node.id, scriptScheme: target.scriptScheme, shotsPerClip: target.shotsPerClip }, (text) => patchRun({ status: "running", mode, stage: text, at: Date.now() }));
                patchRun({
                    status: outcome.ok ? "done" : "error",
                    mode,
                    stage: outcome.ok ? "已完成" : undefined,
                    error: outcome.ok ? undefined : outcome.error || "执行失败",
                    chatNodeId: outcome.chatNodeId,
                    textNodeId: outcome.textNodeId,
                    scriptNodeId: outcome.scriptNodeId,
                    at: Date.now(),
                });
                if (outcome.ok) message.success(mode === 3 ? "反推 + 一键视频已启动/完成，进度见脚本节点" : "反推完成，结果已写进文本节点");
                else message.error(outcome.error || "执行失败");
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                patchRun({ status: "error", mode, error: detail, at: Date.now() });
                message.error(detail);
            }
        },
        [attached, message, node.id, onRun, patchRun, target.scriptScheme, target.shotsPerClip],
    );

    const handleCommand = useCallback(
        (mode: VideoReverseMode) => {
            if (!attached) {
                message.warning("先接入视频：把视频节点连到本节点，或点「接入视频」挑一个");
                return;
            }
            if (running) return;
            if (mode === 1) {
                void runMode(1);
                return;
            }
            // 02 / 03：先弹特殊要求，默认已经把「反推视频 + 用参考图当道具 + 重新输出文案」写好。
            setRequirementText(requirementDefault());
            setRequirementMode(mode);
        },
        [attached, message, requirementDefault, runMode, running],
    );

    const confirmRequirement = useCallback(() => {
        const mode = requirementMode;
        setRequirementMode(null);
        if (!mode) return;
        void runMode(mode, requirementText.trim());
    }, [requirementMode, requirementText, runMode]);

    const softBorder = `1px solid ${theme.node.stroke}`;

    return (
        <div className="flex h-full w-full flex-col gap-2 p-3 text-[13px]" style={{ color: theme.node.text, cursor: "default" }} onMouseDown={stopDragOnInteractive} onPointerDown={stopDragOnInteractive}>
            {/* ① 表头 + 接入视频 */}
            <div className="flex items-center gap-2">
                <Wand2 size={14} style={{ color: "#a78bfa" }} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold opacity-80">反推视频 · 命令集合</span>
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: attached ? "#22c55e" : "#71717a" }} />
                <Button size="small" icon={<Link2 size={12} />} onClick={handleAttachClick} loading={creating}>
                    {attached ? "换一个" : "接入视频"}
                </Button>
            </div>

            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5" data-canvas-no-zoom>
                {/* ② 接入状态 */}
                <div className="rounded-md px-2.5 py-2" style={{ border: softBorder }}>
                    {attached ? (
                        <div className="flex items-center gap-2.5">
                            <video src={attached.url} muted playsInline preload="metadata" className="h-14 w-24 shrink-0 rounded object-cover" style={{ background: "#000" }} />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                    <span className="min-w-0 truncate text-xs font-medium">{attached.title || "视频"}</span>
                                    <Tag style={{ marginInlineEnd: 0 }} color={attachSource === "connection" ? "blue" : "default"}>
                                        {attachSource === "connection" ? "连线接入" : "手动接入"}
                                    </Tag>
                                </div>
                                <div className="mt-0.5 truncate text-[11px] opacity-45">{attached.url}</div>
                                {attachSource === "connection" ? <div className="mt-0.5 text-[11px] opacity-55">下面三条命令可用（断开那根线 = 取消接入）</div> : null}
                            </div>
                        </div>
                    ) : (
                        <div className="text-[11px] leading-relaxed" style={{ color: "#f59e0b" }}>
                            还没接入视频：把画布上的视频节点连到本节点左侧，或点右上角「接入视频」从列表里挑 / 粘贴链接。
                            <div className="mt-1 opacity-60">{videos.length ? `画布上可选的视频：${videos.length} 个` : "画布上还没有视频节点"}</div>
                        </div>
                    )}

                    {pickerOpen ? (
                        <div className="mt-2 flex flex-col gap-2 rounded-md px-2 py-2" style={{ border: softBorder }}>
                            <div className="max-h-40 overflow-auto">
                                {videos.length ? (
                                    videos.map((item) => (
                                        <button key={item.id} type="button" onClick={() => attach(item.id)} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs transition hover:bg-white/10">
                                            <Video size={12} className="shrink-0 opacity-60" />
                                            <span className="min-w-0 flex-1 truncate">{item.title || "视频"}</span>
                                            <span className="shrink-0 opacity-40">{item.id.slice(0, 6)}</span>
                                        </button>
                                    ))
                                ) : (
                                    <div className="px-1 py-1 text-[11px] opacity-50">画布上没有视频节点，先拖一个视频进来，或在下面粘贴链接</div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <Input size="small" value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} onPressEnter={() => void handleCreateFromUrl()} placeholder="粘贴视频链接（http/https），自动建一个视频节点" />
                                <Button size="small" onClick={() => void handleCreateFromUrl()} loading={creating} disabled={!urlDraft.trim()}>
                                    建节点并接入
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {/* 参考图（连进来的图片节点）：02 / 03 会一起带进对话（`@图片N`），并按其名字把对得上的挂到分镜表道具格 */}
                    {referenceImages?.length ? (
                        <div className="mt-2 rounded-md px-2 py-1.5" style={{ border: softBorder }}>
                            <div className="flex items-start gap-1.5 text-[11px] leading-relaxed opacity-70">
                                <Images size={11} className="mt-0.5 shrink-0" />
                                <span className="min-w-0 flex-1">
                                    参考图 {referenceImages.length} 张：执行 02 / 03 时会一起带进 AI 对话（{referenceImages.map((_, index) => imageReferenceLabel(index)).slice(0, 3).join("、")}
                                    {referenceImages.length > 3 ? "…" : ""}，按连线顺序），其中名字对上分镜表「道具」的那几张会直接挂成道具素材，并且不再生成该道具的资产图。
                                </span>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {referenceImages.map((item) => (
                                    <img key={item.id} src={item.url} alt={item.title} title={item.title} className="h-10 w-10 rounded object-cover" style={{ background: "#000" }} />
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* ③ 生成设置（用户 2026-11-09）：风格 / 模型 / 秒数 / 比例 / 分辨率 */}
                <div className="rounded-md px-2.5 py-2" style={{ border: softBorder }}>
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <SlidersHorizontal size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 font-medium opacity-80">生成设置</span>
                        <span className="shrink-0 text-[10px] opacity-45">02 / 03 按这套走</span>
                    </div>
                    {/* 第一行：风格 + 视频模型（控件与视频节点的提示词面板同一套） */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <CanvasStylePicker value={target.styleTemplateId} onChange={(styleTemplateId) => patchTarget({ styleTemplateId: styleTemplateId || "" })} buttonClassName="!h-7 !max-w-[132px] !shrink-0 !justify-start !rounded-full !px-2.5" placement="topLeft" />
                        {/* 视频模型：最后一项「MochiAni 生视频节点」= 换引擎（用户 2026-11-10 第 02 条）。
                            选它之后 03 的「一键视频」铺出来的是 MochiAni 窗口，而不是普通视频节点；
                            两个选择分开存（`model` / `videoEngine`），来回切不互相冲掉。 */}
                        <ModelPicker
                            config={globalConfig}
                            value={isMochianiVideoEngine(target.videoEngine) ? MOCHIANI_VIDEO_ENGINE : effectiveVideoModel}
                            onChange={(model) => {
                                if (isMochianiVideoEngine(model)) patchTarget({ videoEngine: MOCHIANI_VIDEO_ENGINE });
                                else patchTarget({ videoEngine: undefined, model });
                            }}
                            capability="video"
                            placeholder="视频模型（跟随偏好）"
                            onMissingConfig={() => openConfigDialog(true)}
                            className="max-w-[168px]"
                            extraOptions={[{ value: MOCHIANI_VIDEO_ENGINE, label: "MochiAni 生视频节点", title: "铺链路时改成 MochiAni 生视频窗口（模型/渠道取偏好里的 MochiAni 配置）" }]}
                        />                    </div>
                    {/* 第二行：秒数（成片总时长，默认 30）+ 比例 + 分辨率 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InputNumber
                            size="small"
                            className="!w-[104px]"
                            min={REVERSE_VIDEO_SECONDS_MIN}
                            max={REVERSE_VIDEO_SECONDS_MAX}
                            step={5}
                            precision={0}
                            value={Number(target.seconds) || DEFAULT_REVERSE_VIDEO_SECONDS}
                            addonAfter="秒"
                            onChange={(value) => patchTarget({ seconds: String(value ?? DEFAULT_REVERSE_VIDEO_SECONDS) })}
                            aria-label="成片总时长（秒）"
                        />
                        <CanvasSizePicker value={effectiveSize} onChange={(size) => patchTarget({ size })} className="h-6 w-[96px]" />
                        <Select size="small" className="!w-[124px]" value={effectiveQuality} onChange={(quality) => patchTarget({ quality })} options={QUALITY_OPTIONS} popupMatchSelectWidth={false} aria-label="视频分辨率" />
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed opacity-45">
                        秒数 = 成片总时长：02 写文案、03 生剧本都按它规划镜头数与台词量（默认 {DEFAULT_REVERSE_VIDEO_SECONDS} 秒）；生视频用这里的模型 / 比例 / 分辨率 / 风格（默认 16:9 · 720p，模型跟偏好里的视频模型）。
                    </div>
                    {/* 第三行：「每 3 个镜头合一个视频」开关（用户 2026-11-11 第 01 条）。
                        打开后 03 建脚本节点时带过去，铺链路（含一键视频）每 3 镜一个视频节点；关掉回到默认 4 镜。 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button
                            type="button"
                            className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition"
                            style={{
                                borderColor: compactShots ? theme.toolbar.activeText : theme.node.stroke,
                                color: compactShots ? theme.toolbar.activeText : theme.node.text,
                                background: compactShots ? `${theme.toolbar.activeText}14` : "transparent",
                                opacity: compactShots ? 1 : 0.7,
                            }}
                            aria-pressed={compactShots}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => patchTarget({ shotsPerClip: compactShots ? undefined : SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT })}
                            title={
                                compactShots
                                    ? `已开启：铺链路每 ${SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT} 个镜头合一个视频节点（再点一次关闭）`
                                    : `打开后铺链路每 ${SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT} 个镜头合一个视频节点（默认每 ${SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP} 镜一个）`
                            }
                        >
                            <Layers size={11} className="shrink-0" />
                            每 {SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_COMPACT} 镜合一个视频{compactShots ? " · 已开" : ""}
                        </button>
                    </div>
                </div>

                {/* ④ 三条命令 */}
                <div className="flex flex-col gap-1.5">
                    {VIDEO_REVERSE_MODES.map((item) => {
                        const Icon = MODE_ICON[item.mode];
                        const usable = Boolean(attached) && !running;
                        const isBusy = running && run?.mode === item.mode;
                        return (
                            <button
                                key={item.mode}
                                type="button"
                                onClick={() => handleCommand(item.mode)}
                                aria-disabled={!usable}
                                title={usable ? item.hint : "先接入视频"}
                                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition"
                                style={{
                                    border: `1px solid ${usable ? theme.node.stroke : "transparent"}`,
                                    background: usable ? theme.toolbar.activeBg : "transparent",
                                    opacity: usable ? 1 : 0.45,
                                    cursor: usable ? "pointer" : "not-allowed",
                                }}
                            >
                                <span className="mt-0.5 shrink-0 text-[11px] font-semibold tracking-wider opacity-70">{item.no}</span>
                                <Icon size={14} className="mt-0.5 shrink-0" style={{ color: usable ? "#a5b4fc" : "#71717a" }} />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-xs font-medium">{item.label}</span>
                                        {isBusy ? <Loader2 size={11} className="animate-spin" /> : null}
                                    </span>
                                    <span className="mt-0.5 block text-[11px] leading-relaxed opacity-55">{item.hint}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* ⑤ 进度 / 错误 / 产物 */}
                {run?.status === "running" && run.stage ? (
                    <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]" style={{ background: "rgba(99,102,241,0.14)", color: "#c7d2fe" }}>
                        <Loader2 size={12} className="animate-spin shrink-0" />
                        <span className="min-w-0 flex-1">{run.stage}</span>
                    </div>
                ) : null}

                {staleRun ? <div className="rounded-md px-2 py-1.5 text-[11px]" style={{ background: "rgba(250,204,21,0.14)", color: "#fbbf24" }}>上一次运行已经超时（刷新页面会掐断请求），可以直接重跑。</div> : null}

                {run?.status === "done" && !run.error ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {run.chatNodeId ? (
                            <Tag color="default" style={{ marginInlineEnd: 0 }}>
                                对话节点
                            </Tag>
                        ) : null}
                        {run.textNodeId ? (
                            <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                文本节点
                            </Tag>
                        ) : null}
                        {run.scriptNodeId ? (
                            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                                脚本节点 + 一键视频
                            </Tag>
                        ) : null}
                        {run.stage && !run.chatNodeId ? <span className="opacity-50">{run.stage}</span> : null}
                    </div>
                ) : null}

                {run?.status === "error" && run.error ? (
                    <div className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-relaxed" style={{ background: "rgba(248,113,113,0.14)", color: "#fca5a5" }}>
                        <CircleAlert size={12} className="mt-0.5 shrink-0" />
                        <span className="min-w-0 flex-1">{run.error}</span>
                    </div>
                ) : null}
            </div>

            {/* ⑥ 脚注：用的技能 / 模型 */}
            <div className="flex flex-col gap-0.5 text-[11px] leading-relaxed opacity-45">
                <span className="flex items-center gap-1.5">
                    <Sparkles size={11} className="shrink-0" />
                    技能「视频反推-分镜提示词」；没装会直接报错，不会静默换别的模型硬跑。输出强制简体中文（提示词首尾各钉一次，偶尔跑偏会自动让它原样重写一遍）。
                </span>
                {reverseModelLabel ? <span className="truncate">反推模型：{reverseModelLabel}</span> : null}
            </div>

            {/* 特殊要求（02 / 03） */}
            <Modal
                open={requirementMode !== null}
                onCancel={() => setRequirementMode(null)}
                onOk={confirmRequirement}
                okText="开始反推"
                cancelText="取消"
                width={520}
                title={requirementMode === 3 ? "03 · 反推视频并生成同款风格文案及视频" : "02 · 反推视频并生成同款风格文案"}
                destroyOnHidden={false}
            >
                <div className="flex flex-col gap-2 text-sm">
                    <div className="text-xs opacity-60">
                        这段会作为「特殊要求」跟着视频一起发进 AI 对话，可以直接改。
                        {referenceImages?.length ? `连进来的 ${referenceImages.length} 张参考图会一起带进对话，${imageReferenceLabel(0)} 就是第一张（连线顺序）。` : "（本节点还没连参考图，所以默认文案里没有 @图片N。）"}
                    </div>
                    <Input.TextArea value={requirementText} onChange={(event) => setRequirementText(event.target.value)} rows={4} placeholder={DEFAULT_VIDEO_REVERSE_REQUIREMENT} />
                    <div className="text-[11px] opacity-60">
                        本次成片：<span className="font-medium">{targetSummary}</span>
                    </div>
                    {/* 03 的执行方案（用户 2026-11-10）：分镜表里「视频运动提示词」按哪一套格式出。 */}
                    {requirementMode === 3 ? (
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                                <span className="text-xs opacity-70">{t("canvas.scriptNode.reverseSchemeLabel")}</span>
                                <Select
                                    size="small"
                                    className="!w-[236px]"
                                    value={target.scriptScheme || ""}
                                    onChange={(value) => patchTarget({ scriptScheme: asScriptSchemeId(value) ?? undefined })}
                                    options={schemeOptions}
                                    popupMatchSelectWidth={false}
                                    aria-label={t("canvas.scriptNode.reverseSchemeLabel")}
                                />
                            </div>
                            <div className="text-[11px] leading-relaxed opacity-50">{t("canvas.scriptNode.reverseSchemeHint")}</div>
                        </div>
                    ) : null}
                    {requirementMode === 3 ? <div className="text-[11px] opacity-50">确定后会接着把文本节点接到脚本生成器，并执行一键视频 —— 剧本按 {target.seconds || DEFAULT_REVERSE_VIDEO_SECONDS} 秒写、分镜表按「{chosenSchemeLabel}」的格式出，生视频用上面这套参数。</div> : null}
                </div>
            </Modal>
        </div>
    );
}
