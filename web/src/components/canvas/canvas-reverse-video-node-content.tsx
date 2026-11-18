import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Input, InputNumber, Modal, Select, Tag } from "antd";
import { CircleAlert, Clapperboard, Cpu, FileText, Images, Layers, Link2, Loader2, SlidersHorizontal, Sparkles, Video, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { DEFAULT_REVERSE_VIDEO_SECONDS, DEFAULT_VIDEO_REVERSE_REQUIREMENT, REVERSE_VIDEO_SECONDS_MAX, VIDEO_REVERSE_MODES, VIDEO_REVERSE_SKILL_OPTIONS, VIDEO_REVERSE_STAGE_OPTIONS, buildDefaultVideoReverseRequirement, describeReverseVideoStages, normalizeReverseVideoTarget, readReverseVideoScript, readReverseVideoSkill, readReverseVideoStages, readReverseVideoTarget, resolveReverseVideoQuality, resolveReverseVideoSize, setReverseVideoStage, type ReverseVideoStages, type VideoReverseMode, type VideoReverseResult, type VideoReverseStageId } from "@/lib/canvas/video-reverse";
import { DEFAULT_EPISODE_SECONDS, EPISODE_SECONDS_MAX, EPISODE_SECONDS_MIN, EPISODE_SPLIT_SKILL_LABEL, SCRIPT_CHARS_PER_SECOND, resolveEpisodeSeconds } from "@/lib/canvas/video-reverse-episodes";
import { asScriptSchemeId, SCRIPT_SCHEME_IDS, type ScriptSchemeId } from "@/constant/script-scheme";
import { SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP, SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_DEFAULT, SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_OPTIONS, normalizeScriptShotsPerClip } from "@/constant/story-script";
import { isMochianiVideoEngine, MOCHIANI_VIDEO_ENGINE } from "@/constant/mochiani-video";
import { getStyleTemplate } from "@/constant/style-templates";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { useConfigStore, useEffectiveConfig, modelOptionLabel, resolveModelForCapability } from "@/stores/use-config-store";
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
 * 结果落文本节点 →（02 / 03）接脚本生成器并跑一键视频。这里只负责「选视频 + 按按钮 + 显示进度」。
 * 进度 / 结果落在 `metadata.reverseVideoRun`：节点滚出视口会被卸载重挂，只放 state 会凭空消失。
 */

export type ReverseVideoOption = {
    id: string;
    title: string;
    url: string;
};

/**
 * 04 的剧本来源之一：**连进反推节点的文本节点**（用户 2026-11-18）。
 *
 * 「这个剧集剧本文本框可手动输入，也可以链接文本节点进行写入」—— 所以两个入口都留着：
 * 手动打字 / 点「写入剧本框」把连线里那几段搬进来（`content` 已经是节点上的正文）。
 */
export type ReverseVideoLinkedText = {
    id: string;
    title: string;
    content: string;
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
    /**
     * 04 的剧本来源：连进本节点的**文本节点**（按连线顺序，`project.tsx` 解析）。
     * 只服务 04 —— 01 / 02 / 03 的输入是视频，文本连线对它们没有意义（也不会被读）。
     */
    linkedTexts?: ReverseVideoLinkedText[];
    /**
     * 反推（看片）的**默认**文本模型（编码值 `channelId::model`，空 = 画布上找不到该模型）。
     * 由 `project.tsx` 解析（`gemini-3.8-flash` · toapis），节点自己只负责显示 / 覆盖：
     * 用户在这里选过 → 写 `metadata.reverseVideoChatModel`；没选过 → 用它兜底。
     * 真正生效的判断在 `project.tsx: runVideoReverse`（`input.chatModel → metadata → 默认 → 偏好`）。
     */
    reverseModelDefault?: string;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    /** 粘贴链接建一个视频节点，返回新节点 id */
    onCreateVideoFromUrl?: (videoUrl: string) => Promise<string>;
    /** 执行一条命令；report 用来把阶段文案打到窗口里 */
    onRun: (
        input: {
            /** 01 / 02 / 03 必传；04 是「文字剧本」输入，不需要视频，这里给空串 */
            videoNodeId: string;
            mode: VideoReverseMode;
            requirement?: string;
            reverseNodeId?: string;
            scriptScheme?: ScriptSchemeId;
            shotsPerClip?: number;
            skillId?: string;
            chatModel?: string;
            /**
             * 02 / 03 自动接着跑哪几步（用户 2026-11-17：生成分镜 / 一键生图 / 一键生视频，默认全勾）。
             * 这里显式带过去（而不是只靠 metadata）是因为「刚在弹窗里取消勾选、立刻点开始」时
             * `patchTarget` 还没落库 —— 同 `scriptScheme` / `chatModel` 那个坑。
             */
            stages?: ReverseVideoStages;
            /**
             * 04 的输入剧本。显式带过去同理：用户粘贴完就点 04，metadata 可能还没写进去。
             */
            script?: string;
            /** 04 的每集时长（秒）。不传 = 按节点 metadata / 默认 120。 */
            episodeSeconds?: number;
        },
        report: (stage: string) => void,
    ) => Promise<VideoReverseResult>;
};

const MODE_ICON: Record<VideoReverseMode, typeof Video> = {
    1: Video,
    2: FileText,
    3: Clapperboard,
    4: Layers,
};

/** 落在窗口里会挡住「拖整个节点」的控件：命中就让事件停在这层。 */
const INTERACTIVE_SELECTOR = "textarea,input,button,[contenteditable],[data-canvas-selectable-text],.ant-select,.ant-btn,.ant-tag,.ant-modal";

/**
 * 「running」超过这个时长就判定为上次被打断（刷新页面会掐断请求，状态位来不及回写）。
 * 必须**大于 02 / 03 一键视频的最长预算（45 分钟）**，否则长任务跑到一半按钮就被解锁，用户能连点两条命令。
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
    linkedTexts,
    reverseModelDefault,
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
    /**
     * 04 的**输入剧本**草稿（用户 2026-11-17：「在执行 04 的时候需要输入剧本到反推视频节点才可执行」）。
     *
     * 落库到 `metadata.reverseVideoScript`（与 `content` 分开：本节点也可能是被生成出来的节点，
     * 混用会被生图 / 生视频流程当成产物）。这里再存一份 state 是因为输入框每敲一个字都写 store
     * 会让整块画布重渲染 —— 用「输入写 state、失焦 / 开跑时落库」这一档，既不掉字也不卡。
     */
    const [scriptDraft, setScriptDraft] = useState(() => readReverseVideoScript(node.metadata));
    /** 换节点（组件实例被复用到别的节点）时把草稿重置成那个节点上存的剧本。 */
    const [draftOwnerId, setDraftOwnerId] = useState(node.id);
    if (draftOwnerId !== node.id) {
        setDraftOwnerId(node.id);
        setScriptDraft(readReverseVideoScript(node.metadata));
    }
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const run = node.metadata?.reverseVideoRun;
    /**
     * 目标视频参数（风格 / 模型 / 秒数 / 比例 / 分辨率，用户 2026-11-09）：
     * 一律用 `readReverseVideoTarget` 归一化后再渲染 —— 老节点没有这个字段，秒数也要有默认 30。
     */
    const target = useMemo(() => readReverseVideoTarget(node.metadata), [node.metadata]);
    /**
     * 反推技能（用户 2026-11-12 第 02 条）：默认「视频反推-分镜提示词」，可在节点上切到「SS视频反推」。
     *
     * 读的时候一律走 `readReverseVideoSkill`：老节点 / 脏值 → 默认那条，所以升级前后**行为不变**。
     * 写的时候只写 id（`reverseVideoSkill`），文案随选项表走，别把中文名存进 metadata。
     */
    const skillOption = useMemo(() => readReverseVideoSkill(node.metadata), [node.metadata]);
    /**
     * 反推模型（用户 2026-11-12 第 05 条「反推视频的那个模型也需要能够选择」）：
     * 「跑反推那个对话节点」用哪个文本模型。
     *
     * 与「生视频模型」是两个独立的键，**不能**复用 `reverseVideoTarget.model`：
     * 前者决定谁来看片反推，后者决定拿什么模型出片；合成一个键就会出现「换反推模型把出片模型改了」。
     *
     * 显示口径与视频模型一致：没选过就显示**实际会用的默认值**（`reverseModelDefault`），
     * metadata 里仍然留空 —— 以后再改默认模型，老节点跟着变。
     */
    const chosenReverseModel = String(node.metadata?.reverseVideoChatModel || "").trim();
    const effectiveReverseModel = chosenReverseModel || reverseModelDefault || "";
    const effectiveReverseModelLabel = effectiveReverseModel ? modelOptionLabel(globalConfig, effectiveReverseModel) : "";
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
     * 「每 2 / 3 个镜头合一个视频」开关（用户 2026-11-11 第 01 条、2026-11-14 加 2 镜档 + 默认开启）：
     * 存在 `reverseVideoTarget.shotsPerClip`（`2` / `3` = 开启、`4` = 显式关闭），02 / 03 建脚本节点时搬进
     * `scriptShotsPerClip`，之后铺链路按这颗的镜数切片。
     * **没写过 = 默认 3 镜开启**（用户 2026-11-14：「默认选择为每 3 镜合一个镜头开启状态」），
     * 所以显示 / 摘要都读 `compactShots`（生效档位），不能用 `normalize` 的原始值（会得到 0 = 两颗都不亮）。
     */
    const shotsChoice = normalizeScriptShotsPerClip(target.shotsPerClip);
    const compactShots = shotsChoice || SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_DEFAULT;
    /**
     * 有效出片参数（用户 2026-11-11 第 02 条）：窗口里没选过时给 16:9 / 720p。
     * 02 / 03 搬给脚本节点的是**同一份**（`project.tsx` 里也调这两个函数），所以摘要写的就是实际会用的。
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
    /**
     * 出片参数摘要（弹窗里给用户确认「按什么出片」用）。
     * 秒数单独拆出来：04 的摘要那行已经写了「每集 N 秒」，再拼一次秒数就会出现两套数字并排
     * （老版本的「每集 120 秒 · 30 秒 · 16:9」正是这么来的）。
     */
    const paramSummary = useMemo(() => {
        const style = target.styleTemplateId ? getStyleTemplate(target.styleTemplateId)?.label || target.styleTemplateId : "无风格";
        // 换了引擎要写在摘要里：02 / 03 的「按这套出片」是用户最后一眼确认，不能还写着普通视频模型。
        const engine = isMochianiVideoEngine(target.videoEngine) ? "MochiAni 生视频" : "";
        // 分段口径也要写：02 / 03 都是「建脚本节点 → 立刻一键视频」，铺出来几个视频窗口取决于这一档。
        // `compactShots` 已经是**生效档位**（默认 3、显式关闭 4），直接写，别再 `|| 4` 兜底。
        const clip = `每 ${compactShots} 镜一个视频`;
        return `${effectiveSize} · ${qualityLabel(effectiveQuality)} · 风格：${style} · ${clip}${engine ? ` · ${engine}` : ""}`;
    }, [compactShots, effectiveQuality, effectiveSize, target.styleTemplateId, target.videoEngine]);
    const targetSummary = `${target.seconds || DEFAULT_REVERSE_VIDEO_SECONDS} 秒 · ${paramSummary}`;
    /**
     * 02 / 03 自动接着跑的**三颗勾**（用户 2026-11-17）：「生成分镜 / 一键生图 / 一键生视频，默认都是勾选的；
     * 不勾生成分镜 → 后面两步一起取消；不勾一键生图 → 一键生视频一起取消；取消勾选即不执行脚本生成器里
     * 对应的那一步」。
     *
     * 读的时候一律走 `readReverseVideoStages`（老节点没这个字段 → 全勾，升级前后行为不变）；
     * 写回走 `setReverseVideoStage`（勾 / 取消的联动**只有这一处**），再整体落 `reverseVideoTarget.autoStages`。
     * 全勾时 `normalizeReverseVideoTarget` 会把键丢掉 —— 缺省即全勾，不必把默认值冻进数据里。
     */
    const stages = useMemo(() => readReverseVideoStages(node.metadata), [node.metadata]);
    /**
     * 04 的「每集时长」与主界面「生成设置 · 秒数」是**同一个值**（用户 2026-11-18 第 8 轮：
     * 「选择的时间秒数跟主界面的时间秒数相通，即主界面写 120，那么弹出窗口也是 120」）。
     *
     * 以前是两个键、两套默认：主界面 = `reverseVideoTarget.seconds`（默认 30，给 02 / 03），
     * 04 弹窗 = `reverseVideoTarget.episodeSeconds`（默认 120）。于是主界面写 120、弹窗还是自己的老值；
     * 更刺眼的是 04 弹窗那行摘要还写着「30 秒 · 16:9 · …」—— 两套数字并排，看着就是没通。
     *
     * 现在：`seconds` 是**唯一来源**（用户显式写过才算，`normalizeReverseVideoTarget` 会给缺省值塞 30，
     * 所以这里读的是 metadata 上的原始值），`episodeSeconds` 只作**同写镜像**保留
     * （老节点 / `runVideoReverseEpisodes` 的兜底读取还在用它）。任何一处改动都走 `applySeconds`，
     * 两边永远同一个数。04 默认仍是 120：**打开 04 弹窗时**若这个键从没写过就落成 120
     * （主界面同步显示 120，见 `handleCommand` 里 mode === 4 那一段）。
     */
    const rawSeconds = String(node.metadata?.reverseVideoTarget?.seconds || "").trim();
    const episodeSeconds = useMemo(
        () => resolveEpisodeSeconds(Number(rawSeconds) || Number(target.episodeSeconds) || DEFAULT_EPISODE_SECONDS),
        [rawSeconds, target.episodeSeconds],
    );
    /**
     * 秒数写回的唯一出口：`seconds`（主界面）+ `episodeSeconds`（04 镜像）一起写。
     * 区间统一按 **04 口径**夹（15～300）：一集至少要一个 15 秒片段，比这更小的秒数对 02 / 03 也没意义。
     */
    const applySeconds = useCallback(
        (value: number | string | null | undefined, fallback: number) => {
            const next = resolveEpisodeSeconds(Number(value) || fallback);
            patchTarget({ seconds: String(next), episodeSeconds: String(next) });
        },
        [patchTarget],
    );
    const commitScript = useCallback(
        (value: string) => {
            setScriptDraft(value);
            onConfigChange(node.id, { reverseVideoScript: value });
        },
        [node.id, onConfigChange],
    );
    /**
     * 04 的剧本还可以**从连线来**（用户 2026-11-18）：「文本节点输入到反推视频节点的时候，
     * 也需要能够直接写入到 04 的剧集剧本文本框内……可手动输入，也可以链接文本节点进行写入」。
     *
     * 两段文本按连线顺序用空行拼起来 —— 与「一集一段」的口径一致（空行本来就是我们切集的天然边界）。
     */
    const linkedScript = useMemo(
        () =>
            (linkedTexts || [])
                .map((item) => String(item.content || "").trim())
                .filter(Boolean)
                .join("\n\n"),
        [linkedTexts],
    );
    const linkedTitles = useMemo(() => (linkedTexts || []).map((item) => String(item.title || "文本节点").trim()).filter(Boolean), [linkedTexts]);
    /**
     * 上一次「由连线自动写进来」的值。
     *
     * 判定口径（刻意做得保守，宁可不覆盖也不吃掉用户手打的内容）：
     *  - 框里是空的 → 自动写入（连上文本节点就能直接跑 04，不用再点一次）；
     *  - 框里的内容 **=== 上次自动写入的内容** → 说明用户没动过，连线里的文字改了/换了就跟着更新；
     *  - 其它情况（用户手打过）→ 一个字都不动，只显示「内容与连线不同」+ 一个写入按钮。
     */
    const autoScriptRef = useRef("");
    useEffect(() => {
        if (draftOwnerId !== node.id) autoScriptRef.current = "";
    }, [draftOwnerId, node.id]);
    useEffect(() => {
        // 组件实例被复用到别的节点时，这一轮 `scriptDraft` 还是**上一个节点**的内容 ——
        // 拿它跟新节点的连线比会误判，直接把上一集的剧本写进这个节点。等换节点那次提交完成再说。
        if (draftOwnerId !== node.id) return;
        if (!linkedScript) return;
        const current = scriptDraft.trim();
        if (!current) {
            autoScriptRef.current = linkedScript;
            commitScript(linkedScript);
            return;
        }
        if (current === autoScriptRef.current.trim() && linkedScript !== autoScriptRef.current) {
            autoScriptRef.current = linkedScript;
            commitScript(linkedScript);
        }
    }, [commitScript, draftOwnerId, linkedScript, node.id, scriptDraft]);
    /** 连线内容与框里内容是否已经一致（按钮文案 / 状态点都看它）。 */
    const linkedApplied = Boolean(linkedScript) && scriptDraft.trim() === linkedScript;
    /** 按连线内容覆盖剧本框；之后连线里的文字再改也会**继续跟随**（重置基准值）。 */
    const applyLinkedScript = useCallback(() => {
        if (!linkedScript) return;
        autoScriptRef.current = linkedScript;
        commitScript(linkedScript);
    }, [commitScript, linkedScript]);
    /** 追加到末尾（已经有手打内容、又想把连线那几段并进来时用）。 */
    const appendLinkedScript = useCallback(() => {
        if (!linkedScript) return;
        const merged = [scriptDraft.trim(), linkedScript].filter(Boolean).join("\n\n");
        commitScript(merged);
    }, [commitScript, linkedScript, scriptDraft]);
    const toggleStage = useCallback(
        (id: VideoReverseStageId, checked: boolean) => {
            patchTarget({ autoStages: setReverseVideoStage(stages, id, checked) });
        },
        [patchTarget, stages],
    );
    /** 02 / 03 弹窗里那行「本次会执行：…」的文案（与真正传给执行器的是同一份级联结果）。 */
    const stagePlanLabel = useMemo(() => describeReverseVideoStages(stages), [stages]);
    /**
     * 02 / 03 弹窗里的「执行方案」选项（用户 2026-11-10）。
     *
     * 为什么必须在**选中之前**就定下来：八套方案对 `视频运动提示词` 的格式约束各不相同
     * （第四套 = 八段标签块、第五套 = 整段 10 秒视频脚本、第六套 = 光影全流程、第七 / 第八套 = 时间码 / 分镜组），
     * 而 02 / 03 都是「建脚本节点 → 立刻一键视频」一气呵成，中间没有地方让用户点方案。
     * 空值 = 不表态，仍按默认判定（第七套 · 魔漫 15 秒分镜优先），与「手点新建脚本节点」完全一致。
     */
    const schemeOptions = useMemo(() => [{ value: "", label: t("canvas.scriptNode.reverseSchemeFollow") }, ...SCRIPT_SCHEME_IDS.map((id) => ({ value: id, label: t(`canvas.scriptNode.scheme_${id}`) }))], [t]);
    /** 当前选中的方案（空 = 默认），只用于文案。 */
    const chosenSchemeLabel = target.scriptScheme ? t(`canvas.scriptNode.scheme_${target.scriptScheme}`) : t("canvas.scriptNode.reverseSchemeFollow");
    /**
     * 02 / 03 要求框的**默认文案**（2026-11-12 口径）。
     *
     * 两次改口径沿革：
     *  ① 2026-11-11 第 02 条：旧默认是「反推该视频**提示词**及文案」→ 要求框里点名要提示词，
     *     模型就把整张分镜提示词表全吐出来，剧本被挤到后面截断（「总给我出一堆没用的注释，剧本生成不完」）。
     *  ② 2026-11-12：只留「同款风格的剧本文案」还不够 —— 模型会把「同款」读成「同一条」，
     *     直接拿原片内容转写成剧本（「感觉像是直接反推了一份给我」）。把「反推类型 → 另写新剧本」写进默认文案。
     *  ③ 2026-11-12 第 04 条：那个「另写新剧本」的口径**只属于 03**。02 改成复刻同款，
     *     默认文案也必须跟着说「复刻」—— 否则框里写「另写新剧本」、提示词跑「复刻」，用户不知道以哪个为准。
     *     所以默认文案按 **mode** 取（`buildDefaultVideoReverseRequirement(mentions, mode)`）。
     *
     * `@图片N` 必须按「连进本节点的参考图」逐张点名：没有参考图时不提（提了模型只会瞎猜一件道具），
     * 有 N 张就写 `@图片1、@图片2…` —— 编号与 `project.tsx: runVideoReverse` 把这批图连进对话节点后
     * `sendChatMessage` 用的 mention 编号同源（`imageReferenceLabel`，按连线顺序、从 1 开始）。
     */
    const requirementDefault = useCallback((mode: 2 | 3) => buildDefaultVideoReverseRequirement((referenceImages || []).map((_, index) => imageReferenceLabel(index)), mode), [referenceImages]);
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
        async (mode: VideoReverseMode, requirement?: string, extra?: { script?: string; episodeSeconds?: number }) => {
            /**
             * 01 / 02 / 03 的前提是「接入了一条视频」；**04 不是** —— 它的输入是文字剧本，
             * 所以门禁只在 1~3 上生效（下面 `attached` 的取值也对应放宽）。
             */
            if (mode !== 4 && !attached) {
                message.warning("先接入视频：把视频节点连到本节点，或点「接入视频」挑一个");
                return;
            }
            patchRun({ status: "running", mode, stage: "准备中…", at: Date.now() });
            try {
                /**
                 * `scriptScheme` / `skillId` / `chatModel` 显式带过去（而不是只靠 patch 落库）：
                 * 节点 metadata 的写入要等一次 React 提交，而 02 / 03 在这**同一次点击里**就要建脚本节点、
                 * 立刻生成 —— 读 `nodesRef` 可能拿到还没刷新的旧值（这个坑 2026-11-09 已经踩过一次）。
                 * `chatModel` 同理：用户刚在下拉里换完模型就点命令，metadata 可能还没写进去。
                 * 04 的剧本 / 每集时长同理（`script` / `episodeSeconds`）。
                 */
                const outcome = await onRun(
                    {
                        videoNodeId: attached?.id || "",
                        mode,
                        requirement,
                        reverseNodeId: node.id,
                        scriptScheme: target.scriptScheme,
                        shotsPerClip: target.shotsPerClip,
                        skillId: skillOption.id,
                        chatModel: effectiveReverseModel || undefined,
                        // 三颗勾只对 02 / 03 / 04 有意义（01 只反推、不碰脚本生成器），01 不带。
                        stages: mode === 1 ? undefined : stages,
                        ...(mode === 4 ? { script: extra?.script ?? scriptDraft, episodeSeconds: extra?.episodeSeconds ?? episodeSeconds } : {}),
                    },
                    (text) => patchRun({ status: "running", mode, stage: text, at: Date.now() }),
                );
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
                if (outcome.ok) message.success(mode === 1 ? "反推完成，结果已写进文本节点" : mode === 4 ? "剧集已拆分并开始执行，进度见各集脚本节点" : "反推 + 一键视频已启动/完成，进度见脚本节点");
                else message.error(outcome.error || "执行失败");
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                patchRun({ status: "error", mode, error: detail, at: Date.now() });
                message.error(detail);
            }
        },
        [attached, effectiveReverseModel, episodeSeconds, message, node.id, onRun, patchRun, scriptDraft, skillOption.id, stages, target.scriptScheme, target.shotsPerClip],
    );

    const handleCommand = useCallback(
        (mode: VideoReverseMode) => {
            if (running) return;
            // 04 的输入是文字剧本（不接视频也行）；01 / 02 / 03 必须先接入视频。
            if (mode !== 4 && !attached) {
                message.warning("先接入视频：把视频节点连到本节点，或点「接入视频」挑一个");
                return;
            }
            if (mode === 1) {
                void runMode(1);
                return;
            }
            if (mode === 4) {
                /**
                 * 04：弹窗与 02 / 03 同构，但**多了「每集时长」**，并且要求先有剧本。
                 * 剧本空着就直接点开弹窗（弹窗里也能填），但点「开始」时必须有内容 ——
                 * 没有剧本就没有东西可拆，跑下去只会白建一个对话节点。
                 */
                setRequirementText("");
                /**
                 * 打开 04 弹窗时把「秒数」落成 120（**只在从没写过时落**）：这样主界面显示的秒数
                 * 与弹窗里的「每集时长」立刻是同一个数，之后谁改都两边一起变（`applySeconds`）。
                 * 老节点若已经存过 `episodeSeconds`（120 之外的数），`episodeSeconds` 取的就是它，不覆盖。
                 */
                if (!String(node.metadata?.reverseVideoTarget?.seconds || "").trim()) applySeconds(DEFAULT_EPISODE_SECONDS, DEFAULT_EPISODE_SECONDS);
                setRequirementMode(4);
                return;
            }
            // 02 / 03：先弹特殊要求。默认文案按 mode 取（02 = 复刻同款 / 03 = 另写同类型新剧本），
            // 两者都自带「参考图当道具 + 只要剧本正文」。
            setRequirementText(requirementDefault(mode));
            setRequirementMode(mode);
        },
        [applySeconds, attached, message, node.metadata, requirementDefault, runMode, running],
    );

    const confirmRequirement = useCallback(() => {
        const mode = requirementMode;
        if (!mode) return;
        if (mode === 4) {
            // 剧本必须非空（用户口径：输入剧本到反推视频节点才可执行）。
            if (!scriptDraft.trim()) {
                message.warning("先在上面填剧本：04 会把这段文字按每集时长拆成多集，没有剧本就没有可拆的内容");
                return;
            }
            setRequirementMode(null);
            void runMode(4, requirementText.trim() || undefined, { script: scriptDraft.trim(), episodeSeconds });
            return;
        }
        setRequirementMode(null);
        void runMode(mode, requirementText.trim());
    }, [episodeSeconds, message, requirementMode, requirementText, runMode, scriptDraft]);

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
                                {attachSource === "connection" ? <div className="mt-0.5 text-[11px] opacity-55">下面 01 / 02 / 03 可用（断开那根线 = 取消接入）</div> : null}
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

                {/* ③ 反推技能（用户 2026-11-12 第 02 条）：默认「视频反推-分镜提示词」，可手动切到「SS视频反推」。
                    01 / 02 / 03 三条命令都用这里选的技能；除技能本身，三条的规则与约束完全不动。
                    ⚠️ 存 id 不存中文名：名字会改，id 是稳定的；旧节点没有这个字段 → 读的时候回落默认那条。 */}
                <div className="rounded-md px-2.5 py-2" style={{ border: softBorder }}>
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <Sparkles size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 font-medium opacity-80">反推技能</span>
                        <span className="shrink-0 text-[10px] opacity-45">01 / 02 / 03 用它</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {VIDEO_REVERSE_SKILL_OPTIONS.map((item) => {
                            const active = item.id === skillOption.id;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition"
                                    style={{
                                        borderColor: active ? theme.toolbar.activeText : theme.node.stroke,
                                        color: active ? theme.toolbar.activeText : theme.node.text,
                                        background: active ? `${theme.toolbar.activeText}14` : "transparent",
                                        opacity: active ? 1 : 0.7,
                                    }}
                                    aria-pressed={active}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (active) return;
                                        onConfigChange(node.id, { reverseVideoSkill: item.id });
                                    }}
                                    title={`${item.label}：${item.hint}${active ? "（当前使用）" : "，点一下切换"}`}
                                >
                                    {item.label}
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed opacity-45">
                        只换「用哪个技能反推」——只输出正文（02 复刻同款 / 03 同类型新故事）、中文、时长与出片参数这些约束一条不变。切换前请确认技能库里装着它，没装会直接报错，不会悄悄换另一个技能跑。04 不受这里影响：它固定用「{EPISODE_SPLIT_SKILL_LABEL}」拆集。
                    </div>
                </div>

                {/* ④ 反推模型（用户 2026-11-12 第 05 条）：「反推视频的那个模型也需要能够选择」。
                    默认 gemini-3.8-flash（toapis 渠道）；不选就不写 metadata，以后改默认老节点跟着换。
                    ⚠️ 与「生成设置」里的视频模型是**两个键**：一个负责看片反推（`reverseVideoChatModel`），
                    一个负责出片（`reverseVideoTarget.model`）—— 合成一个键会出现「换反推模型把出片模型改了」。 */}
                <div className="rounded-md px-2.5 py-2" style={{ border: softBorder }}>
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <Cpu size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 font-medium opacity-80">反推模型</span>
                        <span className="shrink-0 text-[10px] opacity-45">01 / 02 / 03 都用它</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <ModelPicker
                            config={globalConfig}
                            value={effectiveReverseModel || undefined}
                            onChange={(model) => onConfigChange(node.id, { reverseVideoChatModel: model })}
                            capability="text"
                            placeholder="反推模型（默认 gemini-3.8-flash）"
                            onMissingConfig={() => openConfigDialog(true)}
                            className="max-w-[220px]"
                        />
                        {chosenReverseModel ? (
                            <button
                                type="button"
                                className="inline-flex h-6 items-center rounded-full border px-2 text-[11px] transition"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text, opacity: 0.7 }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange(node.id, { reverseVideoChatModel: "" })}
                                title={`清除本节点选的模型，回到默认${reverseModelDefault ? `（${modelOptionLabel(globalConfig, reverseModelDefault)}）` : ""}`}
                            >
                                恢复默认
                            </button>
                        ) : null}
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed opacity-45">
                        只影响「看片反推」这一步（真正跑反推的那个 AI 对话节点），默认 gemini-3.8-flash（toapis 渠道）。生视频用什么模型在下面的「生成设置」里选，两者互不覆盖。
                    </div>
                </div>

                {/* ⑤ 生成设置（用户 2026-11-09）：风格 / 模型 / 秒数 / 比例 / 分辨率 */}
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
                            选它之后 02 / 03 的「一键视频」铺出来的是 MochiAni 窗口，而不是普通视频节点；
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
                        />
                    </div>
                    {/* 第二行：秒数（成片总时长，默认 30；**与 04 的「每集时长」是同一个值**）+ 比例 + 分辨率 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InputNumber
                            size="small"
                            className="!w-[104px]"
                            min={EPISODE_SECONDS_MIN}
                            max={REVERSE_VIDEO_SECONDS_MAX}
                            step={5}
                            precision={0}
                            value={Number(target.seconds) || DEFAULT_REVERSE_VIDEO_SECONDS}
                            addonAfter="秒"
                            onChange={(value) => applySeconds(value, DEFAULT_REVERSE_VIDEO_SECONDS)}
                            aria-label="成片总时长（秒）"
                        />
                        <CanvasSizePicker value={effectiveSize} onChange={(size) => patchTarget({ size })} className="h-6 w-[96px]" />
                        <Select size="small" className="!w-[124px]" value={effectiveQuality} onChange={(quality) => patchTarget({ quality })} options={QUALITY_OPTIONS} popupMatchSelectWidth={false} aria-label="视频分辨率" />
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed opacity-45">
                        秒数 = 成片总时长：02 / 03 写剧本按它规划镜头数与台词量（默认 {DEFAULT_REVERSE_VIDEO_SECONDS} 秒），04 则是「每集时长」（默认 {DEFAULT_EPISODE_SECONDS} 秒）—— <span className="opacity-90">两个位置写的是同一个值，改哪边都一样</span>；生视频用这里的模型 / 比例 / 分辨率 / 风格（默认 16:9 · 720p，模型跟偏好里的视频模型）。
                    </div>
                    {/* 第三行：「每 2 / 3 个镜头合一个视频」开关（用户 2026-11-11 第 01 条，2026-11-14 加 2 镜档 + 默认开启）。
                        两颗同级互斥：点了哪颗，02 / 03 建脚本节点时就把哪档带过去，铺链路（含一键视频）
                        每 N 镜一个视频节点；再点同一颗 = 写 4 = 关闭（交回视频分段档位）。
                        **默认就是「每 3 镜」开启**（用户 2026-11-14），所以打开窗口时 3 那颗天然是亮的。 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP_OPTIONS.map((count) => {
                            const on = compactShots === count;
                            return (
                                <button
                                    key={count}
                                    type="button"
                                    className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition"
                                    style={{
                                        borderColor: on ? theme.toolbar.activeText : theme.node.stroke,
                                        color: on ? theme.toolbar.activeText : theme.node.text,
                                        background: on ? `${theme.toolbar.activeText}14` : "transparent",
                                        opacity: on ? 1 : 0.7,
                                    }}
                                    aria-pressed={on}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={() => patchTarget({ shotsPerClip: on ? SCRIPT_VIDEO_CHAIN_SHOTS_PER_CLIP : count })}
                                    title={
                                        on
                                            ? `已开启：铺链路每 ${count} 个镜头合一个视频节点（再点一次关闭 → 回到视频分段档位）`
                                            : `点击开启：铺链路每 ${count} 个镜头合一个视频节点（现在是每 ${compactShots} 镜一个）`
                                    }
                                >
                                    <Layers size={11} className="shrink-0" />
                                    每 {count} 镜合一个视频{on ? " · 已开" : ""}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* ⑤.5 04 的输入剧本（用户 2026-11-17）：「在执行 04 的时候需要输入剧本到反推视频节点才可执行」。
                    放在命令按钮上方，是因为它只服务 04 —— 01 / 02 / 03 的输入是连线接进来的视频。
                    落 `metadata.reverseVideoScript`（与 `content` 分开存，见 types 里的说明）。 */}
                <div className="rounded-md px-2.5 py-2" style={{ border: softBorder }}>
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <FileText size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 font-medium opacity-80">04 · 剧集剧本</span>
                        <span className="shrink-0 text-[10px] opacity-45">{scriptDraft.trim() ? `${scriptDraft.trim().length} 字` : "未填写"}</span>
                    </div>
                    {/* 连线来源（用户 2026-11-18）：文本节点连进来 → 剧本框直接可写入。
                        框空着会自动写入；手打过的内容一律不覆盖，只留两个按钮自己点。 */}
                    {linkedScript ? (
                        <div className="mt-1.5 rounded px-1.5 py-1" style={{ background: "rgba(99,102,241,0.10)" }}>
                            <div className="flex items-center gap-1 text-[10px] leading-relaxed">
                                <Link2 size={10} className="shrink-0 opacity-70" />
                                <span className="min-w-0 flex-1 truncate opacity-70" title={linkedTitles.join(" / ")}>
                                    已连接文本节点：{linkedTitles.join(" / ")}（{linkedScript.length} 字）
                                </span>
                                <span className="shrink-0" style={{ color: linkedApplied ? "#5eead4" : "#fbbf24" }}>
                                    {linkedApplied ? "已写入" : "未写入"}
                                </span>
                            </div>
                            <div className="mt-1 flex items-center gap-1">
                                <button
                                    type="button"
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={applyLinkedScript}
                                    className="rounded px-1.5 py-0.5 text-[10px] transition"
                                    style={{ border: `1px solid ${theme.node.stroke}`, opacity: linkedApplied ? 0.55 : 1 }}
                                >
                                    {linkedApplied ? "重新写入" : "写入剧本框"}
                                </button>
                                <button
                                    type="button"
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={appendLinkedScript}
                                    className="rounded px-1.5 py-0.5 text-[10px] opacity-70 transition"
                                    style={{ border: `1px solid ${theme.node.stroke}` }}
                                >
                                    追加到末尾
                                </button>
                            </div>
                        </div>
                    ) : null}
                    <Input.TextArea
                        className="!mt-1.5"
                        value={scriptDraft}
                        onChange={(event) => commitScript(event.target.value)}
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        placeholder={`把小说 / 故事 / 剧本正文粘到这里（也可以连一个文本节点后点「写入剧本框」）—— 04 会先用「${EPISODE_SPLIT_SKILL_LABEL}」技能把原文改写成剧本正文，再按每集时长自动切段（一集一个文本节点，纵向排开），最后逐集走分镜 → 生图 → 生视频`}
                        aria-label="04 剧集剧本"
                    />
                    <div className="mt-1 text-[10px] leading-relaxed opacity-45">
                        只有 04 读这段文字（01 / 02 / 03 的输入是连线接进来的视频）。拆出来的多集会共享同名资产图：同一批里上一集已经有的角色 / 场景 / 道具，下一集直接挂同一张图，不会重复生成。
                    </div>
                </div>

                {/* ⑥ 四条命令
                    上面那行小字是 02 / 03 / 04 的**自动执行计划**（用户 2026-11-17 的三颗勾）：
                    不点开弹窗也能一眼看到「这次会跑到哪一步」，取消勾选后这里立刻跟着变。 */}
                <div className="px-1 text-[10px] leading-relaxed opacity-45">02 / 03 / 04 之后自动执行：{stagePlanLabel}（点命令时可在弹窗里取消勾选；取消上游会自动取消下游）</div>
                <div className="flex flex-col gap-1.5">
                    {VIDEO_REVERSE_MODES.map((item) => {
                        const Icon = MODE_ICON[item.mode];
                        /**
                         * 01 / 02 / 03 必须先接入视频；**04 的输入是文字剧本**，没接视频也能点
                         * （它只在剧本为空时由弹窗拦一次）。
                         */
                        const needsVideo = item.mode !== 4;
                        const usable = (Boolean(attached) || !needsVideo) && !running;
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

                {/* ⑦ 进度 / 错误 / 产物 */}
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

            {/* ⑧ 脚注：用的技能 / 模型 */}
            <div className="flex flex-col gap-0.5 text-[11px] leading-relaxed opacity-45">
                <span className="flex items-center gap-1.5">
                    <Sparkles size={11} className="shrink-0" />
                    技能「{skillOption.label}」（01 / 02 / 03，可在上方切换；04 固定用「{EPISODE_SPLIT_SKILL_LABEL}」拆集）；没装会直接报错，不会静默换别的技能硬跑。输出强制简体中文（提示词首尾各钉一次，偶尔跑偏会自动让它原样重写一遍）。
                </span>
                <span className="truncate">反推模型：{effectiveReverseModelLabel || "跟随偏好里的文本模型"}{chosenReverseModel ? "" : "（默认）"}</span>
            </div>

            {/* 特殊要求（02 / 03）+ 04 的剧集拆集设置 */}
            <Modal
                open={requirementMode !== null}
                onCancel={() => setRequirementMode(null)}
                onOk={confirmRequirement}
                okText={requirementMode === 4 ? "开始拆集并执行" : "开始反推"}
                cancelText="取消"
                width={requirementMode === 4 ? 620 : 520}
                title={requirementMode === 4 ? "04 · 剧集批量生成（文字剧本 → 多集）" : requirementMode === 3 ? "03 · 反推视频并生成同类型新剧本及视频" : "02 · 反推视频并复刻同款剧本及视频"}
                destroyOnHidden={false}
            >
                <div className="flex flex-col gap-2 text-sm">
                    {requirementMode === 4 ? (
                        <>
                            <div className="text-xs leading-relaxed opacity-60">
                                这次<span className="font-medium">不接视频</span>：输入是下面这段<span className="font-medium">文字剧本</span>（可手打 / 粘贴，也可以连一个文本节点后点「写入剧本框」）。执行时先用「{EPISODE_SPLIT_SKILL_LABEL}」技能把原文改写成<span className="font-medium">连续剧本正文</span>，<span className="font-medium">拿到对话结果后</span>再按每集 <span className="font-medium">{episodeSeconds} 秒</span>自动切段（约 {Math.round(episodeSeconds * SCRIPT_CHARS_PER_SECOND)} 字 / 集），切出几集就建几个文本节点（纵向排开），每集右边接一个脚本节点，再按勾选逐集跑分镜 / 生图 / 生视频。
                                <span className="mt-1 block opacity-80">
                                    同一批拆出来的多集<span className="font-medium">共享资产图</span>：上一集已经生成（或正在生成）的角色 / 场景 / 道具，下一集直接挂同一张图，不会重复生成；等这一批的图全齐了，才开始铺视频。
                                </span>
                            </div>
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs opacity-70">剧集剧本（必填）</span>
                                    {linkedScript ? (
                                        <button
                                            type="button"
                                            onClick={applyLinkedScript}
                                            className="rounded px-1.5 py-0.5 text-[11px]"
                                            style={{ border: `1px solid ${theme.node.stroke}` }}
                                            title={`用连线里的 ${linkedTitles.join(" / ")} 覆盖剧本框`}
                                        >
                                            从连线文本节点写入（{linkedScript.length} 字）
                                        </button>
                                    ) : null}
                                </div>
                                <Input.TextArea
                                    value={scriptDraft}
                                    onChange={(event) => commitScript(event.target.value)}
                                    rows={8}
                                    placeholder={`把小说 / 故事 / 剧本正文粘到这里（${scriptDraft.trim().length} 字）`}
                                    aria-label="04 剧集剧本"
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs opacity-70">每集时长</span>
                                <InputNumber
                                    size="small"
                                    className="!w-[128px]"
                                    min={EPISODE_SECONDS_MIN}
                                    max={EPISODE_SECONDS_MAX}
                                    step={15}
                                    precision={0}
                                    value={episodeSeconds}
                                    addonAfter="秒"
                                    onChange={(value) => applySeconds(value, DEFAULT_EPISODE_SECONDS)}
                                    aria-label="每集时长（秒）"
                                />
                                <span className="text-[11px] opacity-50">与主界面「生成设置 · 秒数」是同一个值（默认 {DEFAULT_EPISODE_SECONDS} 秒一集）；也就是每集脚本节点的「成片总时长」，改这里会一起改掉分镜表的镜头与台词量。</span>
                            </div>
                            {/* 生成设置（用户 2026-11-18 第 8 轮）：「同时风格，画幅比例，生成视频模型，对话模型，
                                也按照主界面的选择执行」。这四个控件与主界面**写的是同一份 metadata**
                                （`reverseVideoTarget.*` / `reverseVideoChatModel`），所以是真正「相通」而不是各存一份：
                                在这里改，主界面立刻跟着变，反之亦然。 */}
                            <div className="rounded-md px-2 py-1.5" style={{ border: `1px solid ${theme.node.stroke}` }}>
                                <div className="text-[11px] opacity-60">生成设置（与主界面同一份，改哪边都一样）</div>
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                    {/* 对话模型 = 拆集那步用的文本模型（`reverseVideoChatModel`，与生视频模型是两个键）。 */}
                                    <ModelPicker
                                        config={globalConfig}
                                        value={effectiveReverseModel || undefined}
                                        onChange={(model) => onConfigChange(node.id, { reverseVideoChatModel: model })}
                                        capability="text"
                                        placeholder="对话模型（拆集用）"
                                        onMissingConfig={() => openConfigDialog(true)}
                                        className="max-w-[186px]"
                                    />
                                    <CanvasStylePicker
                                        value={target.styleTemplateId}
                                        onChange={(styleTemplateId) => patchTarget({ styleTemplateId: styleTemplateId || "" })}
                                        buttonClassName="!h-7 !max-w-[120px] !shrink-0 !justify-start !rounded-full !px-2.5"
                                        placement="topLeft"
                                    />
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
                                    />
                                    <CanvasSizePicker value={effectiveSize} onChange={(size) => patchTarget({ size })} className="h-6 w-[96px]" />
                                    <Select size="small" className="!w-[112px]" value={effectiveQuality} onChange={(quality) => patchTarget({ quality })} options={QUALITY_OPTIONS} popupMatchSelectWidth={false} aria-label="视频分辨率" />
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="text-xs opacity-60">
                            这段会作为「特殊要求」跟着视频一起发进 AI 对话，可以直接改。
                            {referenceImages?.length ? `连进来的 ${referenceImages.length} 张参考图会一起带进对话，${imageReferenceLabel(0)} 就是第一张（连线顺序）。` : "（本节点还没连参考图，所以默认文案里没有 @图片N。）"}
                            <span className="mt-1 block opacity-80">
                                {requirementMode === 2
                                    ? "这次是「复刻同款」：人物 / 场景 / 事件顺序 / 台词 / 镜头都照这条片来，写成一份可以直接开拍的剧本。"
                                    : "视频只当「同类型的样本」用：要的是另写的一个故事（人物 / 场景 / 情节 / 台词全新），不是把这条片转写成剧本。"}
                            </span>
                        </div>
                    )}
                    {/* 特殊要求：02 / 03 是主输入（默认文案自带创作口径）；04 是可选（拆集时的额外要求）。 */}
                    <div className="flex flex-col gap-1">
                        {requirementMode === 4 ? <span className="text-xs opacity-70">特殊要求（可选：拆集时想额外强调的，比如「每集结尾留钩子」）</span> : null}
                        <Input.TextArea
                            value={requirementText}
                            onChange={(event) => setRequirementText(event.target.value)}
                            rows={requirementMode === 4 ? 2 : 4}
                            placeholder={requirementMode === 4 ? "（可留空）拆集时的额外要求" : requirementDefault(requirementMode === 3 ? 3 : 2)}
                        />
                    </div>
                    <div className="text-[11px] opacity-60">
                        {requirementMode === 4 ? (
                            <>
                                每集：<span className="font-medium">{episodeSeconds} 秒</span>（= 主界面秒数） · 生图 / 生视频参数：<span className="font-medium">{paramSummary}</span>
                            </>
                        ) : (
                            <>
                                本次成片：<span className="font-medium">{targetSummary}</span>
                            </>
                        )}
                    </div>
                    {/* 执行方案（用户 2026-11-10）：分镜表里「视频运动提示词」按哪一套格式出。
                        02 / 03 / 04 的执行流程一样（建脚本节点 → 一键视频），所以方案选择对三者都要显示。 */}
                    {requirementMode === 2 || requirementMode === 3 || requirementMode === 4 ? (
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
                    {/* 三颗勾（用户 2026-11-17）：默认全勾，取消上游自动取消下游。
                        写回走 `setReverseVideoStage`（联动唯一出口），落 `reverseVideoTarget.autoStages`。 */}
                    <div className="flex flex-col gap-1 rounded-md px-2 py-1.5" style={{ border: `1px solid ${theme.node.stroke}` }}>
                        <span className="text-xs opacity-70">自动执行（默认全勾）</span>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            {VIDEO_REVERSE_STAGE_OPTIONS.map((item) => (
                                <Checkbox
                                    key={item.id}
                                    checked={stages[item.id]}
                                    onChange={(event) => toggleStage(item.id, event.target.checked)}
                                    title={item.hint}
                                >
                                    <span className="text-xs">{item.label}</span>
                                </Checkbox>
                            ))}
                        </div>
                        <div className="text-[11px] leading-relaxed opacity-50">取消「生成分镜」→ 生图与生视频一起取消；取消「一键生图」→ 生视频一起取消。取消的那一步在脚本生成器里不会执行（节点照建、剧本照写，之后随时可以在脚本节点上手动点）。</div>
                    </div>
                    {requirementMode === 4 ? (
                        <div className="text-[11px] leading-relaxed opacity-50">
                            {stages.script || stages.image || stages.video
                                ? `确定后先拆集（一集一个文本节点 + 一个脚本节点），再按「${stagePlanLabel}」逐集执行 —— 每集剧本按 ${episodeSeconds} 秒写${stages.script ? `、分镜表按「${chosenSchemeLabel}」的格式出` : ""}${stages.video ? "，等这一批的资产图全齐了才开始铺视频" : ""}。`
                                : `三步都没勾：只拆集、只建空的脚本节点（之后可以在各集脚本节点上手动点生成）。`}
                        </div>
                    ) : (
                        <div className="text-[11px] opacity-50">
                            {stages.script || stages.image || stages.video
                                ? `确定后会接着把文本节点接到脚本生成器，并按「${stagePlanLabel}」执行 —— 剧本按 ${target.seconds || DEFAULT_REVERSE_VIDEO_SECONDS} 秒写${stages.script ? `、分镜表按「${chosenSchemeLabel}」的格式出` : ""}${stages.video ? "，生视频用上面这套参数" : ""}。`
                                : `三步都没勾：只把反推出来的剧本写进文本节点，并接一个空的脚本生成器节点（之后可以在那里手动点生成）。`}
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
}
