import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Select, Switch, Tag, Upload } from "antd";
import type { SelectProps } from "antd";
import {
    CircleAlert,
    CircleCheck,
    Clapperboard,
    Coins,
    Film,
    ImagePlus,
    Loader2,
    Music4,
    PlugZap,
    RefreshCw,
    Sparkles,
    Unlink,
    Wrench,
    X,
} from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { buildStylePromptText, composeStyledPrompt, getStyleTemplate } from "@/constant/style-templates";
import { imageToDataUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodePromptPanel } from "./canvas-node-prompt-panel";

/**
 * 「MochiAni 生视频」**节点**的内容区 —— 整个视频生成窗口就是画布上的一个节点。
 *
 * 为什么不做成弹窗：弹窗带遮罩，盖住画布之后就没法平移 / 缩放 / 点别的节点了。
 * 做成节点以后它跟别的节点一样可以拖、可以缩、可以只开一半在视口里。
 *
 * 链路：本节点表单 → 本机桥（tools/mochiani-bridge，127.0.0.1:17399）
 *      → MochiAni MCP（stdio）→ 在 MochiAni 画布里建视频节点、切模型/渠道、导参考图并连线、
 *        写提示词、预检费用 → 生成 → 回传视频地址 → 落成画布视频节点。
 *
 * ⚠️ 节点滚出视口会被裁掉重挂，而生成要跑几分钟：任务快照写进 `metadata.mochianiRun`，
 *    重挂时按 id 回桥里把状态捞回来（同 `canvas-reverse-video-node-content.tsx` 的做法）。
 */

const BRIDGE_STORAGE_KEY = "infinite-atelier:mochiani-bridge";
const DEFAULT_BRIDGE = "http://127.0.0.1:17399";
const POLL_MS = 3000;
/** 单张参考图上限：桥那边要 base64 过一遍 JSON，太大容易把请求撑爆。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const INTERACTIVE_SELECTOR = "textarea,input,button,[contenteditable],[data-canvas-selectable-text],.ant-select,.ant-btn,.ant-tag";

type JobStage = "planning" | "ready" | "blocked" | "submitting" | "generating" | "done" | "error" | "cancelled";

type JobEstimate = {
    points: number | null;
    isEstimate: boolean;
    configParams: Record<string, string>;
    labels: Record<string, string>;
};

type MochianiJob = {
    id: string;
    kind: "canvas" | "carton";
    stage: JobStage;
    prompt: string;
    nodeId: string;
    taskId: string;
    operationId: string;
    videoUrl: string;
    work: { pageId: string; origin: string; siteName?: string };
    estimate: JobEstimate | null;
    model: { id?: string; key?: string; supplierId?: string } | null;
    modelTarget: { modelKey?: string; channelId?: string; params?: Record<string, string> } | null;
    /** 视频生成模式（11=全能参考）；桥会回传实际生效的那个。 */
    videoCategory?: number | null;
    videoCategoryLabel?: string;
    imageCount: number;
    videoCount?: number;
    audioCount?: number;
    /** 漫剧编辑器：关联上的素材（含新建的）、真正发出去的分镜文案、写进分镜的配音条数。 */
    cast?: { characters?: string[]; scenes?: string[]; props?: string[]; created?: string[] } | null;
    script?: string;
    voiceCount?: number;
    voiceItems?: Array<{ characterName?: string; text?: string }>;
    warnings: string[];
    error: string;
    createdAt: string;
    updatedAt: string;
    log: Array<{ at: string; message: string }>;
};

type MochianiPage = {
    pageId: string;
    origin: string;
    siteKind: string;
    siteName: string;
    active: boolean;
    kind: "canvas" | "carton" | "client" | "unknown";
    canGenerate: boolean;
    workId: string;
};

type PointSummary = { total?: string; common?: string; scoped?: string; label?: string };

type ParamOption = { label: string; value: string; priceRatio?: number };

type ModelChannel = {
    id: string;
    name: string;
    avgRatio?: number;
    avgTime?: number;
    successRate?: number;
    price?: number;
    configInfo?: Record<string, ParamOption[]>;
    /** 漫剧编辑器给的 default_config（canvas 页面没有这项）。 */
    defaultParams?: Record<string, string>;
};

type ModelOption = {
    modelId: string;
    modelKey: string;
    modelName: string;
    configInfo?: Record<string, ParamOption[]>;
    mediaLimits?: { image?: { required?: number; max?: number }; video?: { max?: number }; audio?: { max?: number } };
    channels?: ModelChannel[];
    defaultParams?: Record<string, string>;
    /**
     * 视频「生成模式」= MochiAni 的 `specific_type`（漫剧编辑器的模型目录会带）。
     * 11=全能参考 / 3=多参考图 / 1=首尾帧 / 9=文生视频 / 0=智能参考 / 4=首帧。
     */
    specificType?: number | null;
};

/** 生成模式中文名 —— 与 MochiAni 前端自己的映射表一致。 */
const VIDEO_CATEGORY_LABEL: Record<number, string> = {
    0: "智能参考",
    1: "首尾帧",
    3: "多参考图",
    4: "首帧",
    9: "文生视频",
    11: "全能参考",
    12: "合规资产",
};

/** 默认生成模式：全能参考（MochiAni 原生视频面板默认也是它）。 */
const DEFAULT_VIDEO_CATEGORY = 11;

/**
 * 兜底候选表 —— 页面没回读到分类时用。
 *
 * ⚠️ 画布口径下分类只能从 `model_controls.videoCategories` 回读，而那个接口**要求面板真的挂在视口里**
 * （`panelMounted=false` 时只返 pageId/revision，模型目录干脆没有 `specificType`）。
 * 之前这里两边都读不到就 `[]`，结果「生成模式」下拉根本不渲染 —— 用户看不到任何东西。
 * 固定表照 MochiAni 自己的映射来，全能参考排第一，和默认值对齐。
 */
const FALLBACK_VIDEO_CATEGORIES = [11, 3, 0, 1, 4, 9, 12].map((key) => ({
    key,
    label: VIDEO_CATEGORY_LABEL[key] || `分类 ${key}`,
    compatible: true,
    modelCount: 0,
}));

type RefImage = { uid: string; name: string; dataUrl: string };

/**
 * 模型分类 —— MochiAni 的 `model_options` 把生图 / 生视频（还有音频）全摊在同一张表里，
 * 几十个模型平铺在一个下拉里根本没法选。这里按「能拿到的线索」归组，优先级：
 *
 *  ① **显式字段**：`kind` / `type` / `mediaType` / `modelType` / `category` / `outputType` /
 *     `nodeKind` / `taskType`，以及数组形态的 `capabilities` / `tags` / `outputTypes`；
 *  ② 字段有值、但枚举没见过 → **原样拿它当分组名**（宁可多出一组「xxx」，也别把认不出来的
 *     全塞进「其他」—— 那等于没分）；
 *  ③ 一个线索都没有 → 按模型名 / key 关键词猜。
 *
 * ⚠️ 别写成「前 N 个是视频」这种位置假设：MochiAni 那边的目录顺序随时会变。
 */
const MODEL_KIND_LABEL = { video: "生视频", image: "生图", audio: "音频", text: "文本", other: "其他" } as const;
type ModelKind = keyof typeof MODEL_KIND_LABEL;

const MODEL_KIND_ORDER: Record<ModelKind, number> = { video: 0, image: 1, audio: 2, text: 3, other: 9 };

const MODEL_KIND_FIELDS = ["kind", "type", "mediaType", "modelType", "category", "outputType", "nodeKind", "taskType", "subType", "mode", "typeName"];
const MODEL_KIND_LIST_FIELDS = ["capabilities", "tags", "types", "outputTypes"];

const VIDEO_NAME_HINTS = /(seedance|kling|veo|sora|hailuo|minimax|vidu|runway|pika|luma|wan2|wanx|hunyuan|cogvideo|ltx|skyreels|kandinsky|framepack|mochi|t2v|i2v|v2v|video|可灵|即梦|海螺|混元|万相|视频)/i;
const IMAGE_NAME_HINTS = /(image|dall|flux|midjourney|^mj|sdxl|sd3|stable|diffusion|banana|seedream|imagen|recraft|ideogram|kolors|hidream|gpt-4o|生图|图像|图片)/i;

/** 从模型条目里抠出「描述它是什么模态」的原始字符串（没有就空串）。 */
function readModelKindToken(item: ModelOption): string {
    const record = item as unknown as Record<string, unknown>;
    for (const field of MODEL_KIND_FIELDS) {
        const raw = record[field];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
    for (const field of MODEL_KIND_LIST_FIELDS) {
        const raw = record[field];
        if (Array.isArray(raw)) {
            const joined = raw.filter((value): value is string => typeof value === "string").join(" ");
            if (joined.trim()) return joined.trim();
        }
    }
    return "";
}

function normalizeModelKind(token: string): ModelKind {
    const value = token.toLowerCase();
    if (/(^|[^a-z])(video|t2v|i2v|v2v|movie)([^a-z]|$)/.test(value) || /视频/.test(value)) return "video";
    if (/(^|[^a-z])(image|img|t2i|i2i|picture|photo)([^a-z]|$)/.test(value) || /图|绘画/.test(value)) return "image";
    if (/(^|[^a-z])(audio|music|tts|voice|sound)([^a-z]|$)/.test(value) || /音频|音乐|语音/.test(value)) return "audio";
    if (/(^|[^a-z])(text|llm|chat)([^a-z]|$)/.test(value) || /文本|对话/.test(value)) return "text";
    return "other";
}

/** 分组信息：`key` 用来合并同组，`label` 是下拉里的分组标题，`order` 决定组之间的先后。 */
function modelKindInfo(item: ModelOption): { key: string; label: string; order: number } {
    const token = readModelKindToken(item);
    if (token) {
        const kind = normalizeModelKind(token);
        // 认不出来的枚举：原样当分组名，别丢线索。
        if (kind === "other") return { key: `raw:${token.toLowerCase()}`, label: token, order: 5 };
        return { key: kind, label: MODEL_KIND_LABEL[kind], order: MODEL_KIND_ORDER[kind] };
    }
    const name = `${item.modelName || ""} ${item.modelKey || ""} ${item.modelId || ""}`;
    // 名字里明写「视频 / video / i2v / t2v」的一定是视频模型（含「图生视频」「image-to-video」这类），
    // 先判掉它，别让 `image` 这个关键词把图生视频误判成生图模型。
    if (/(视频|video|i2v|t2v|v2v)/i.test(name)) return { key: "video", label: MODEL_KIND_LABEL.video, order: MODEL_KIND_ORDER.video };
    if (IMAGE_NAME_HINTS.test(name)) return { key: "image", label: MODEL_KIND_LABEL.image, order: MODEL_KIND_ORDER.image };
    if (VIDEO_NAME_HINTS.test(name)) return { key: "video", label: MODEL_KIND_LABEL.video, order: MODEL_KIND_ORDER.video };
    return { key: "other", label: MODEL_KIND_LABEL.other, order: MODEL_KIND_ORDER.other };
}

type BridgeBody = Record<string, unknown> & {
    ok?: boolean;
    error?: string;
    job?: MochianiJob;
    pages?: MochianiPage[];
    target?: MochianiPage;
    work?: { workId?: string; nodeCount?: number };
    points?: PointSummary | null;
    user?: string;
    models?: ModelOption[];
    /** 漫剧编辑器：桥回传的「编辑器当前用的模型 / 渠道 / 参数」。 */
    current?: { modelKey?: string; channelId?: string; params?: Record<string, string> };
    panel?: {
        modelKey?: string;
        channelId?: string;
        configParams?: Record<string, string>;
        /** 画布节点生成面板的真实「生成模式」候选（11=全能参考）。 */
        videoCategories?: Array<{ key: number; label: string; compatible?: boolean; reason?: string; modelCount?: number }>;
        activeVideoCategory?: number | null;
    } | null;
    /** 漫剧编辑器：从模型目录倒推出的「生成模式」候选。 */
    videoCategories?: Array<{ key: number; label: string; compatible?: boolean; reason?: string; modelCount?: number }>;
    activeVideoCategory?: number | null;
};

type Props = {
    node: CanvasNodeData;
    /** 连进本节点的素材（`X 拾取` / 拖线）—— 图 / 视频 / 音频都会当成参考素材发给 MochiAni。 */
    references?: CanvasResourceReference[];
    /** 点素材 chip 上的 × 时断开那根线（素材从参考里移除）。 */
    onDetachReference?: (sourceNodeId: string) => void;
    /** 拖动提示词上方那排 chip 改顺序（与视频节点同一套 pointer 拖拽）。 */
    onReorderReferences?: (orderedNodeIds: string[]) => void;
    /** 双击参考图 chip → 画布的全屏预览。 */
    onPreviewReference?: (referenceNodeId: string) => void;
    onCreateVideo: (videoUrl: string, prompt?: string) => Promise<string>;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
};

const STAGE_LABEL: Record<string, string> = {
    planning: "预检中",
    ready: "待确认",
    blocked: "预检未通过",
    submitting: "下发中",
    generating: "生成中",
    done: "已完成",
    error: "失败",
    cancelled: "已停止",
};

const KIND_LABEL: Record<string, string> = { canvas: "无限画布", carton: "漫剧编辑器", client: "首页", unknown: "未知页面" };

const PARAM_LABEL: Record<string, string> = {
    duration: "时长",
    model_size: "画幅",
    resolution: "分辨率",
    generate_audio: "生成音频",
    audio_str: "音频",
    video_str: "视频参考",
    prompt_extend: "提示词扩写",
    prompt_extend_str: "提示词扩写",
    enable_thinking: "深度思考",
    shot_type: "镜头类型",
    with_lip_audio: "对口型",
    max_worker: "并发",
    model: "模型档位",
    algo_type: "算法",
    target_resolution: "目标分辨率",
    lable1: "档位",
};

function paramLabel(key: string) {
    return PARAM_LABEL[key] || key;
}

function readBridgeBase() {
    try {
        return window.localStorage.getItem(BRIDGE_STORAGE_KEY) || DEFAULT_BRIDGE;
    } catch {
        return DEFAULT_BRIDGE;
    }
}

/**
 * 桥地址允许写成 `https://xxx.ts.net/?token=abc`（远程模式）。
 * 解析出真正要请求的 origin + 令牌；令牌走 `x-mochiani-token` 头，不留在 URL 上
 * （留在 URL 上会被日志/截图带出去）。
 */
function parseBridgeAddress(base: string) {
    const raw = String(base || "").trim() || DEFAULT_BRIDGE;
    let token = "";
    let origin = raw;
    try {
        const parsed = new URL(raw);
        token = parsed.searchParams.get("token") || "";
        parsed.search = "";
        parsed.hash = "";
        origin = parsed.toString();
    } catch {
        const [head, query] = raw.split("?");
        const match = /(?:^|&)token=([^&]+)/.exec(query || "");
        token = match ? decodeURIComponent(match[1]) : "";
        origin = head;
    }
    return { origin: origin.replace(/\/+$/, ""), token: token.trim() };
}

async function bridgeFetch(base: string, path: string, init?: RequestInit): Promise<BridgeBody> {
    const { origin, token } = parseBridgeAddress(base);
    const response = await fetch(`${origin}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { "x-mochiani-token": token } : {}),
            ...(init?.headers || {}),
        },
    });
    const text = await response.text();
    let data: Record<string, unknown> | null = null;
    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        data = null;
    }
    if (!data) {
        if (response.status === 401) throw new Error("本机桥开了访问令牌：地址要写成 https://你的域名/?token=你的令牌");
        throw new Error(text.slice(0, 300) || `桥接返回了非 JSON 内容（HTTP ${response.status}）`);
    }
    return data as BridgeBody;
}

/** 时长默认取最短（列表降序，取最后一个），其余参数取第一个。 */
function defaultParams(model: ModelOption, channel?: ModelChannel) {
    const source = channel?.configInfo && Object.keys(channel.configInfo).length ? channel.configInfo : model.configInfo || {};
    const out: Record<string, string> = {};
    for (const [key, options] of Object.entries(source)) {
        if (!Array.isArray(options) || !options.length) continue;
        out[key] = key === "duration" ? options[options.length - 1].value : options[0].value;
    }
    // 漫剧编辑器的候选里带 MochiAni 自己的 default_config（15s / 2K / 16:9），
    // 有就按它的来 —— 别拿「最短时长」当默认，那是给无限画布兜底的猜法。
    const presets = channel?.defaultParams || model.defaultParams;
    for (const [key, value] of Object.entries(presets || {})) {
        if (value == null || value === "") continue;
        if (Object.keys(source).length && !(key in source)) continue;
        out[key] = String(value);
    }
    return out;
}

function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}

/** 桥收得下的单条素材上限（base64 会再胖 1/3，别把桥的内存撑爆）。 */
const REFERENCE_PAYLOAD_MAX_BYTES = {
    image: 32 * 1024 * 1024,
    video: 400 * 1024 * 1024,
    audio: 64 * 1024 * 1024,
} as const;

function readBlobAsDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取素材失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 连进来的素材节点 → 桥能收的一条参考素材（http 地址让桥自己下载，data: 直接传）。
 *
 * ⚠️ 这里以前只认 `http(s)://` 和 `data:`，其它一律当「本页临时文件」丢掉。
 * 但本地上传 / 粘贴进来的图，`metadata.content` 存的是 `uploadImage()` 给的
 * **objectURL（`blob:`）** —— 结果就是画布上明明有图、线也连了，节点里一张都发不出去
 * （只在 toast 里留一句「只是本页临时文件」）。现在 blob: 先就地读成 dataUrl 再发：
 * 图走 `imageToDataUrl`（还能兜住 IndexedDB 已迁移、只剩 storageKey / 页面上那张 <img> 的情况），
 * 视频 / 音频直接 fetch blob 读。
 */
async function toReferencePayload(reference: CanvasResourceReference, kind: "image" | "video" | "audio") {
    const url = String(reference.previewUrl || "").trim();
    if (/^https?:\/\//i.test(url)) return { url };
    if (url.startsWith("data:")) return { dataUrl: url };

    try {
        if (kind === "image") {
            // 空 content（本地库迁移过）也交给它：会按 storageKey / 页面上的 <img> 找回原图。
            const dataUrl = await imageToDataUrl({ url, nodeId: reference.nodeId });
            return dataUrl.startsWith("data:image/") ? { dataUrl } : null;
        }
        if (!/^blob:/i.test(url)) return null;
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.size || blob.size > REFERENCE_PAYLOAD_MAX_BYTES[kind]) return null;
        return { dataUrl: await readBlobAsDataUrl(blob) };
    } catch {
        // blob 已释放 / 存储读不到 —— 如实返回 null，让调用方提示用户重传。
        return null;
    }
}

/** 「每行一个名字」→ 名字数组（也容忍逗号 / 顿号 / 分号分隔）。 */
function splitInputLines(text?: string) {
    return String(text || "")
        .split(/[\n,，、;；]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/** 漫剧编辑器的三个素材输入区（顺序 = 分镜里关联的顺序）。 */
const CARTON_CAST_FIELDS = [
    { key: "characters", label: "出场人物", placeholder: "林晚\n陆沉" },
    { key: "scenes", label: "场景", placeholder: "老宅客厅" },
    { key: "props", label: "道具", placeholder: "铜钥匙" },
] as const;

const MEDIA_KIND_META = {
    image: { label: "图", icon: ImagePlus, color: "#60a5fa" },
    video: { label: "视频", icon: Film, color: "#a78bfa" },
    audio: { label: "音频", icon: Music4, color: "#34d399" },
} as const;

type MediaKind = keyof typeof MEDIA_KIND_META;

export function CanvasMochianiNodeContent({ node, references, onDetachReference, onReorderReferences, onPreviewReference, onCreateVideo, onConfigChange }: Props) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    const [bridgeBase, setBridgeBase] = useState(readBridgeBase);
    const [bridgeEditing, setBridgeEditing] = useState(false);
    const [healthOk, setHealthOk] = useState(false);
    const [healthError, setHealthError] = useState("");

    const [target, setTarget] = useState<MochianiPage | null>(null);
    const [work, setWork] = useState<{ workId?: string; nodeCount?: number } | null>(null);
    const [points, setPoints] = useState<PointSummary | null>(null);
    const [accountUser, setAccountUser] = useState("");
    const [contextError, setContextError] = useState("");
    const [loadingContext, setLoadingContext] = useState(false);

    const [models, setModels] = useState<ModelOption[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState("");
    const [modelKey, setModelKey] = useState(node.metadata?.mochianiConfig?.modelKey || "");
    const [channelId, setChannelId] = useState(node.metadata?.mochianiConfig?.channelId || "");
    const [params, setParams] = useState<Record<string, string>>(node.metadata?.mochianiConfig?.params || {});
    /**
     * 视频「生成模式」（MochiAni 的 `specific_type`）。
     *
     * 默认 **11 = 全能参考** —— MochiAni 自己的视频面板就是「取第一个全能参考模型」，
     * 这里保持一致。只有页面真的给了分类候选（或者模型的 `specificType` 读得到）才显示这个选择器；
     * 老页面读不到分类就当没这回事，不硬塞。
     */
    const [videoCategory, setVideoCategory] = useState<number | null>(() => {
        const saved = node.metadata?.mochianiConfig?.videoCategory;
        return typeof saved === "number" ? saved : DEFAULT_VIDEO_CATEGORY;
    });
    /** 页面回传的真实生成模式候选（canvas 来自面板，carton 来自模型目录倒推）。 */
    const [categoryOptions, setCategoryOptions] = useState<Array<{ key: number; label: string; compatible?: boolean; reason?: string; modelCount?: number }>>(
        [],
    );
    /**
     * 渠道选择器是否展开。
     *
     * 同一个模型下面的渠道只是「供应商池」，模型名本身已经区分开了（同一模型有多个 id 的会在
     * 模型下拉里带 `#id`），所以默认**自动选一个**、不给用户看一堆渠道；只有真需要换线路时
     * 才点「换」展开。
     */
    const [channelPickerOpen, setChannelPickerOpen] = useState(false);
    /**
     * 漫剧编辑器的「出场素材 / 配音」是否展开。
     *
     * 这块**可填可不填**：不填就让 MochiAni 自己按分镜文案解析。已经填过内容的默认展开，
     * 免得用户以为自己的素材被清掉了。
     */
    const [castOpen, setCastOpen] = useState(() => {
        const saved = node.metadata?.mochianiConfig;
        return Boolean(saved?.cast?.characters || saved?.cast?.scenes || saved?.cast?.props || saved?.voiceover);
    });

    // 提示词由嵌入的 `CanvasNodePromptPanel` 维护（它写 `metadata.prompt`），
    // 这里再把同一份文本镜像到 `mochianiPrompt`（预检读它，同时兼容老数据）。
    const prompt = node.metadata?.mochianiPrompt ?? node.metadata?.prompt ?? "";
    const [refImages, setRefImages] = useState<RefImage[]>([]);
    const [job, setJob] = useState<MochianiJob | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [placedNodeId, setPlacedNodeId] = useState("");

    const pollingRef = useRef<number | null>(null);
    const lastSnapshotRef = useRef("");
    /**
     * 已锁定的页面 id。
     *
     * 桥的 `/api/*` 不传 pageId 时会自己挑「当前活动页」—— 同一个人同时开着无限画布和漫剧编辑器时，
     * 节点锁着 A 页却去 B 页拿模型目录，会拿到完全另一套模型。所以读上下文时记下它，之后处处带上。
     */
    const targetPageRef = useRef("");
    const restoredRef = useRef(false);

    const stopPolling = useCallback(() => {
        if (pollingRef.current !== null) {
            window.clearInterval(pollingRef.current);
            pollingRef.current = null;
        }
    }, []);

    /** 任务快照落 metadata：节点被裁掉重挂后还能把进度捞回来。 */
    const persistRun = useCallback(
        (next: MochianiJob | null) => {
            const snapshot = next
                ? {
                      id: next.id,
                      stage: next.stage,
                      nodeId: next.nodeId,
                      videoUrl: next.videoUrl,
                      prompt: next.prompt,
                      error: next.error,
                      points: next.estimate?.points ?? null,
                      modelKey: next.modelTarget?.modelKey,
                      channelId: next.modelTarget?.channelId,
                      at: Date.now(),
                      warnings: next.warnings || [],
                      log: next.log.slice(-8),
                  }
                : undefined;
            const signature = JSON.stringify(snapshot?.stage || "") + "|" + JSON.stringify(snapshot?.videoUrl || "") + "|" + String(snapshot?.log?.length || 0) + "|" + JSON.stringify(snapshot?.error || "");
            if (signature === lastSnapshotRef.current) return;
            lastSnapshotRef.current = signature;
            onConfigChange(node.id, { mochianiRun: snapshot });
        },
        [node.id, onConfigChange],
    );

    const patchMetadata = useCallback(
        (patch: Partial<CanvasNodeMetadata>) => {
            onConfigChange(node.id, patch);
        },
        [node.id, onConfigChange],
    );

    /**
     * `mochianiConfig` 的写回。
     *
     * ⚠️ `applyNodeConfigPatch` 是**浅合并** metadata —— 直接 `patchMetadata({ mochianiConfig: {...} })`
     * 会把漫剧编辑器的 cast / voiceover 一起抹掉（切个模型就把人物清空）。所以这里永远
     * 用「旧值 + 补丁」拼完整的对象再写。
     */
    const saveConfig = useCallback(
        (patch: Partial<NonNullable<CanvasNodeMetadata["mochianiConfig"]>>) => {
            const current = node.metadata?.mochianiConfig || {};
            patchMetadata({ mochianiConfig: { ...current, ...patch } });
        },
        [node.metadata?.mochianiConfig, patchMetadata],
    );

    /** 提示词面板的写回：两处都写，面板靠 `prompt` 回填，预检靠 `mochianiPrompt`。 */
    const handlePromptChange = useCallback(
        (_nodeId: string, value: string) => {
            patchMetadata({ prompt: value, mochianiPrompt: value });
        },
        [patchMetadata],
    );

    /**
     * 老节点只有 `mochianiPrompt`（做节点之前那版留下的），而面板按 `composerContent ?? prompt` 回填。
     * 补写一份 `prompt` 并 bump `promptSyncAt` —— 面板的同步 effect 只认 node.id / promptSyncAt。
     */
    useEffect(() => {
        const legacy = node.metadata?.mochianiPrompt;
        if (!legacy || node.metadata?.prompt === legacy) return;
        patchMetadata({ prompt: legacy, promptSyncAt: Date.now() });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const checkHealth = useCallback(async () => {
        try {
            const data = await bridgeFetch(bridgeBase, "/health");
            const needsToken = Boolean(data.authRequired) && !parseBridgeAddress(bridgeBase).token;
            if (needsToken) {
                setHealthOk(false);
                setHealthError("桥开了访问令牌：地址要写成 https://你的域名/?token=你的令牌");
                return false;
            }
            setHealthOk(true);
            setHealthError("");
            return true;
        } catch (err) {
            setHealthOk(false);
            setHealthError(err instanceof Error ? err.message : "连不上本机桥");
            return false;
        }
    }, [bridgeBase]);

    const refreshContext = useCallback(async () => {
        setLoadingContext(true);
        try {
            const data = await bridgeFetch(bridgeBase, "/api/context");
            if (data.ok && data.target) {
                targetPageRef.current = String(data.target.pageId || "");
                setTarget(data.target);
                setWork(data.work || null);
                setContextError("");
                const acc = await bridgeFetch(bridgeBase, "/api/account").catch(() => null);
                setPoints(acc?.ok ? acc.points || null : null);
                setAccountUser(acc?.ok ? acc.user || "" : "");
            } else {
                targetPageRef.current = "";
                setTarget(null);
                setWork(null);
                setPoints(null);
                setContextError(data.error || "读不到当前页面");
            }
        } catch (err) {
            targetPageRef.current = "";
            setTarget(null);
            setWork(null);
            setContextError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingContext(false);
        }
    }, [bridgeBase]);

    const loadModels = useCallback(
        async (preferred?: { modelKey?: string; channelId?: string; params?: Record<string, string>; videoCategory?: number | null }) => {
            setModelsLoading(true);
            try {
                // 带上锁定过的 pageId：桥不传就会自己挑活动页，双开页面时容易串到另一个页面。
                const pinnedPage = targetPageRef.current;
                const data = await bridgeFetch(bridgeBase, `/api/models${pinnedPage ? `?pageId=${encodeURIComponent(pinnedPage)}` : ""}`);
                if (!data.ok) {
                    setModels([]);
                    setModelsError(data.error || "读不到模型目录");
                    return;
                }
                const list = Array.isArray(data.models) ? data.models : [];
                setModels(list);
                setModelsError("");
                // 生成模式候选：画布来自生成面板，漫剧编辑器来自模型目录倒推。
                const categories = data.videoCategories?.length ? data.videoCategories : data.panel?.videoCategories || [];
                setCategoryOptions(categories);
                const savedCategory =
                    typeof preferred?.videoCategory === "number" ? preferred.videoCategory : videoCategory;
                /** 模型目录里到底有没有分类字段 —— 没有就别用分类挑模型（挑不出来）。 */
                const hasSpecificType = list.some((item) => typeof item.specificType === "number");

                // 漫剧编辑器的目录是「模型 × 渠道」，桥会把它当前的配置一起给回来；
                // 用户没存过偏好时优先落到「编辑里正在用的那套」，而不是列表第一个。
                const savedModelKey = preferred?.modelKey || "";
                const preferKey = savedModelKey || data.current?.modelKey || data.panel?.modelKey || "";
                // 没偏好时别直接取第一个：目录里混着生图模型，默认落到生视频那一组更合理。
                // 目录带 specificType 时，再优先落到用户选的「生成模式」（默认全能参考）那一类。
                const nextModel =
                    (savedModelKey ? list.find((item) => item.modelKey === savedModelKey) : undefined) ||
                    (hasSpecificType && savedCategory != null ? list.find((item) => item.specificType === savedCategory) : undefined) ||
                    list.find((item) => item.modelKey === preferKey) ||
                    list.find((item) => modelKindInfo(item).key === "video") ||
                    list[0];
                if (!nextModel) return;
                if (hasSpecificType && savedCategory != null && nextModel.specificType != null && nextModel.specificType !== savedCategory) {
                    // 存过的模型不属于所选模式：以模型为准，别偷偷换。
                    setVideoCategory(nextModel.specificType);
                }
                const preferChannel = preferred?.channelId || data.current?.channelId || data.panel?.channelId || "";
                const nextChannel = nextModel.channels?.find((item) => item.id === preferChannel) || nextModel.channels?.[0];
                const nextParams =
                    preferred?.params && Object.keys(preferred.params).length
                        ? { ...preferred.params }
                        : preferKey === nextModel.modelKey && data.current?.params && Object.keys(data.current.params).length
                          ? { ...data.current.params }
                          : preferKey === nextModel.modelKey && data.panel?.configParams && Object.keys(data.panel.configParams).length
                            ? { ...data.panel.configParams }
                            : defaultParams(nextModel, nextChannel);
                setModelKey(nextModel.modelKey);
                setChannelId(nextChannel?.id || "");
                setParams(nextParams);
                saveConfig({
                    modelKey: nextModel.modelKey,
                    channelId: nextChannel?.id || "",
                    params: nextParams,
                    ...(hasSpecificType && savedCategory != null && nextModel.specificType != null ? { videoCategory: nextModel.specificType } : {}),
                });
            } catch (err) {
                setModels([]);
                setModelsError(err instanceof Error ? err.message : String(err));
            } finally {
                setModelsLoading(false);
            }
        },
        [bridgeBase, saveConfig, videoCategory],
    );

    // 挂载：连桥 → 读页面 / 余额 / 模型目录 → 恢复上次任务
    useEffect(() => {
        void (async () => {
            const healthy = await checkHealth();
            if (!healthy) return;
            await refreshContext();
            await loadModels(node.metadata?.mochianiConfig);
            const saved = node.metadata?.mochianiRun;
            if (!saved?.id || restoredRef.current) return;
            restoredRef.current = true;
            try {
                const data = await bridgeFetch(bridgeBase, `/api/jobs/${encodeURIComponent(saved.id)}`);
                if (data.job) setJob(data.job);
            } catch {
                // 桥没开就先算了，用户点刷新还能再连
            }
        })();
        // 只在节点挂载时跑一次；bridgeBase 变了走下面的重连按钮
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => stopPolling(), [stopPolling]);

    const activeJobId = job?.id || "";
    const jobStage = job?.stage || "";
    const shouldPoll = Boolean(activeJobId) && ["planning", "submitting", "generating"].includes(jobStage);

    useEffect(() => {
        stopPolling();
        if (!shouldPoll || !activeJobId) return;
        const tick = async () => {
            try {
                const data = await bridgeFetch(bridgeBase, `/api/jobs/${encodeURIComponent(activeJobId)}`);
                if (data.job) setJob(data.job);
            } catch {
                // 轮询失败不打断，下一轮再来
            }
        };
        pollingRef.current = window.setInterval(() => void tick(), POLL_MS);
        return () => stopPolling();
    }, [activeJobId, shouldPoll, bridgeBase, stopPolling]);

    useEffect(() => {
        persistRun(job);
    }, [job, persistRun]);

    const selectedModel = useMemo(() => models.find((item) => item.modelKey === modelKey) || null, [models, modelKey]);
    const selectedChannel = useMemo(
        () => selectedModel?.channels?.find((item) => item.id === channelId) || null,
        [selectedModel, channelId],
    );

    /** 参数选项以渠道为准（不同渠道的可调项不一样），没有就退回模型自己的。 */
    const paramSource = useMemo(() => {
        const channelConfig = selectedChannel?.configInfo;
        if (channelConfig && Object.keys(channelConfig).length) return channelConfig;
        return selectedModel?.configInfo || {};
    }, [selectedChannel, selectedModel]);

    const imageLimit = selectedModel?.mediaLimits?.image?.max ?? 9;
    const imageRequired = selectedModel?.mediaLimits?.image?.required ?? 0;
    /** 视频 / 音频上限：模型没声明（0）就不拦，交给 MochiAni 侧的原生端口去拒。 */
    const videoLimit = selectedModel?.mediaLimits?.video?.max ?? 0;
    const audioLimit = selectedModel?.mediaLimits?.audio?.max ?? 0;

    /**
     * 当前目标是漫剧编辑器吗？
     *
     * 两个页面的口径完全不同：画布是「节点 + 上传参考图」，漫剧编辑器是「分镜 + 素材库 ID + 配音」。
     * 所以这里挂几个只在 carton 下出现的输入区，画布那边一个字都不改。
     */
    const isCarton = target?.kind === "carton";
    const cast = node.metadata?.mochianiConfig?.cast;
    const voiceoverText = node.metadata?.mochianiConfig?.voiceover || "";
    const generateVoice = node.metadata?.mochianiConfig?.generateVoice !== false;

    /**
     * 连进本节点的素材（`X 拾取` 或直接拖线连进来）。
     *
     * ⚠️ 这一层以前完全没有 —— 节点只认「手动上传」的图，`X 拾取` 连进来的图 / 视频 / 音频
     *    在画布上有线、在这节点里看不见，自然也不会发给 MochiAni。所以「连线即参考」这件事
     *    必须在这里落地：连线 → chip → 预检时上传。
     */
    const linkedMedia = useMemo(
        () => (references || []).filter((item) => item.kind === "image" || item.kind === "video" || item.kind === "audio"),
        [references],
    );
    const linkedByKind = useMemo(() => {
        const bucket: Record<MediaKind, CanvasResourceReference[]> = { image: [], video: [], audio: [] };
        for (const item of linkedMedia) bucket[item.kind as MediaKind].push(item);
        return bucket;
    }, [linkedMedia]);

    /** 组装给桥的参考素材：连线的优先（用户刚连的那根线更可信），手动上传的补在后面。 */
    const collectMediaPayload = useCallback(async () => {
        const unusable: string[] = [];
        const pick = async (list: CanvasResourceReference[], limit: number, kind: "image" | "video" | "audio") => {
            const out: Array<{ url?: string; dataUrl?: string }> = [];
            for (const reference of list) {
                if (limit > 0 && out.length >= limit) {
                    unusable.push(`${reference.title || reference.label} 超过上限，没发`);
                    continue;
                }
                const entry = await toReferencePayload(reference, kind);
                if (!entry) {
                    unusable.push(`${reference.title || reference.label} 读不出来（本地缓存已失效），重新上传一次`);
                    continue;
                }
                out.push(entry);
            }
            return out;
        };
        const images = await pick(linkedByKind.image, imageLimit, "image");
        for (const item of refImages) {
            if (imageLimit > 0 && images.length >= imageLimit) {
                unusable.push(`${item.name} 超过参考图上限，没发`);
                continue;
            }
            images.push({ dataUrl: item.dataUrl });
        }
        return {
            images,
            videos: await pick(linkedByKind.video, videoLimit, "video"),
            audios: await pick(linkedByKind.audio, audioLimit, "audio"),
            unusable,
        };
    }, [audioLimit, imageLimit, linkedByKind, refImages, videoLimit]);

    /**
     * 选了「生成模式」且模型目录带分类时，模型下拉只留这一类的模型 ——
     * 全能参考和多参考图能吃的素材完全不一样，混在一起选必然选错。
     * 目录不带分类（画布那边的 model_options 就没有）时不过滤，保持原样。
     */
    const hasModelCategory = useMemo(() => models.some((item) => typeof item.specificType === "number"), [models]);
    const visibleModels = useMemo(() => {
        if (!hasModelCategory || videoCategory == null) return models;
        const hit = models.filter((item) => item.specificType === videoCategory);
        // 这一类一个都没有时别把下拉清空，退回全量并告警。
        return hit.length ? hit : models;
    }, [hasModelCategory, models, videoCategory]);

    /**
     * 下拉选项：按模态分组（生视频 / 生图 / 音频 / 文本 / 其他）。
     *
     * - 只有一组时**不加组标题**（多一行灰字纯噪音）；
     * - 组标题带数量，方便一眼看出「视频多少个、图多少个」；
     * - 同名不同 id 的模型仍带 `#id` 后缀（MochiAni 确实有这种）。
     */
    const modelOptions = useMemo<NonNullable<SelectProps["options"]>>(() => {
        const counter = new Map<string, number>();
        for (const item of visibleModels) counter.set(item.modelName, (counter.get(item.modelName) || 0) + 1);

        const groups = new Map<string, { order: number; label: string; items: { value: string; label: string }[] }>();
        for (const item of visibleModels) {
            const info = modelKindInfo(item);
            const group = groups.get(info.key) || { order: info.order, label: info.label, items: [] };
            group.items.push({
                value: item.modelKey,
                label: (counter.get(item.modelName) || 0) > 1 ? `${item.modelName} · #${item.modelId}` : item.modelName,
            });
            groups.set(info.key, group);
        }

        const ordered = Array.from(groups.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
        if (ordered.length <= 1) return ordered[0]?.items || [];
        return ordered.map((group) => ({ label: `${group.label}（${group.items.length}）`, options: group.items }));
    }, [visibleModels]);

    /**
     * 「生成模式」下拉候选。
     *
     * 优先用页面给的真实候选（画布面板的 `videoCategories` 带 compatible），
     * 漫剧编辑器没有面板分类就从模型的 `specificType` 倒推。
     * 🔴 两边都读不到（画布面板没挂载 / 页面在后台）时**必须退回固定表** ——
     *    以前这里给空数组，等于把整个下拉藏起来，用户只会觉得「根本没做」。
     */
    const usingFallbackCategories = !categoryOptions.length && !hasModelCategory;
    const categorySelectOptions = useMemo(() => {
        const source = categoryOptions.length
            ? categoryOptions
            : hasModelCategory
              ? [...new Set(models.map((item) => item.specificType).filter((value): value is number => typeof value === "number"))]
                    .sort((a, b) => a - b)
                    .map((key) => ({
                        key,
                        label: VIDEO_CATEGORY_LABEL[key] || `分类 ${key}`,
                        compatible: true,
                        modelCount: models.filter((item) => item.specificType === key).length,
                    }))
              : FALLBACK_VIDEO_CATEGORIES;
        return source.map((item) => ({
            value: item.key,
            label: `${item.label}${item.modelCount ? ` · ${item.modelCount}` : ""}`,
            disabled: item.compatible === false,
        }));
    }, [categoryOptions, hasModelCategory, models]);

    /** 选中模型的分组 —— 在「生视频」节点上选到生图模型基本是选错了，给一句轻提示。 */
    const selectedModelGroup = selectedModel ? modelKindInfo(selectedModel).key : "";
    const selectedModelIsImage = selectedModelGroup === "image";

    /** 每组多少个（下拉里已有组标题，这里给一眼总量：共 46 个 · 生视频 30 · 生图 16）。 */
    const modelKindSummary = useMemo(() => {
        const counts = new Map<string, { label: string; order: number; count: number }>();
        for (const item of models) {
            const info = modelKindInfo(item);
            const hit = counts.get(info.key) || { label: info.label, order: info.order, count: 0 };
            hit.count += 1;
            counts.set(info.key, hit);
        }
        return Array.from(counts.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    }, [models]);

    const changeModel = (value: string) => {
        const next = models.find((item) => item.modelKey === value) || null;
        const nextChannel = next?.channels?.[0];
        const nextParams = defaultParams(next ?? { modelId: "", modelKey: "", modelName: "" }, nextChannel);
        setModelKey(value);
        setChannelId(nextChannel?.id || "");
        setParams(nextParams);
        saveConfig({ modelKey: value, channelId: nextChannel?.id || "", params: nextParams });
        const nextMax = next?.mediaLimits?.image?.max ?? 9;
        setRefImages((prev) => prev.slice(0, nextMax));
    };

    /**
     * 换「生成模式」。
     *
     * 漫剧编辑器里模式是模型自带的 → 直接落到该类模式的第一个模型（参数一起换成它的默认值）；
     * 画布那边模式是独立开关（桥会调原生 `video_category`），模型不用动。
     */
    const changeVideoCategory = (value: number) => {
        setVideoCategory(value);
        if (!hasModelCategory) {
            saveConfig({ videoCategory: value });
            return;
        }
        const hit = models.find((item) => item.specificType === value);
        if (!hit) {
            saveConfig({ videoCategory: value });
            return;
        }
        const nextChannel = hit.channels?.[0];
        const nextParams = defaultParams(hit, nextChannel);
        setModelKey(hit.modelKey);
        setChannelId(nextChannel?.id || "");
        setParams(nextParams);
        saveConfig({ videoCategory: value, modelKey: hit.modelKey, channelId: nextChannel?.id || "", params: nextParams });
    };

    const changeChannel = (value: string) => {
        const next = selectedModel?.channels?.find((item) => item.id === value);
        setChannelId(value);
        if (!next) {
            saveConfig({ modelKey, channelId: value, params });
            return;
        }
        const nextParams = defaultParams(selectedModel as ModelOption, next);
        setParams(nextParams);
        saveConfig({ modelKey, channelId: value, params: nextParams });
    };

    const changeParam = (key: string, value: string) => {
        const nextParams = { ...params, [key]: value };
        setParams(nextParams);
        saveConfig({ modelKey, channelId, params: nextParams });
    };

    /** 漫剧编辑器的「出场素材 / 配音」—— 存进 metadata，节点滚出视口重挂也不丢。 */
    const changeCast = (kind: "characters" | "scenes" | "props", value: string) => {
        const current = node.metadata?.mochianiConfig?.cast || {};
        saveConfig({ cast: { ...current, [kind]: value } });
    };

    /**
     * 给某个名字找一张「它的图」。
     *
     * 规则：拿画布上**连线进来的图片**按节点标题对名字（「林晚定妆照」→ 林晚）。
     * 不猜内容、不看提示词描述 —— 标题对不上就是没图，宁缺勿错（把 A 的脸挂到 B 身上比没图更糟）。
     */
    const matchCastImage = useCallback(
        (name: string) => {
            const key = name.trim();
            if (!key) return null;
            for (const item of linkedByKind.image) {
                const title = String(item.title || item.label || "").trim();
                if (!title) continue;
                if (title === key) return item;
                if (title.length >= 2 && (title.includes(key) || key.includes(title))) return item;
            }
            return null;
        },
        [linkedByKind.image],
    );

    const castNames = useCallback((kind: "characters" | "scenes" | "props") => splitInputLines(cast?.[kind]), [cast]);

    const addCastName = (kind: "characters" | "scenes" | "props", raw: string) => {
        const name = raw.trim();
        if (!name) return;
        const names = castNames(kind);
        if (names.includes(name)) return;
        changeCast(kind, [...names, name].join("\n"));
    };

    const removeCastName = (kind: "characters" | "scenes" | "props", name: string) => {
        changeCast(kind, castNames(kind).filter((item) => item !== name).join("\n"));
    };

    const addImages = async (files: File[]) => {
        if (!files.length) return;
        const room = Math.max(0, imageLimit - refImages.length - linkedByKind.image.length);
        if (!room) {
            message.warning(`这个模型最多 ${imageLimit} 张参考图`);
            return;
        }
        const accepted: RefImage[] = [];
        for (const file of files.slice(0, room)) {
            if (file.size > MAX_IMAGE_BYTES) {
                message.warning(`${file.name} 超过 12MB，先压一下`);
                continue;
            }
            try {
                accepted.push({ uid: `${Date.now()}-${accepted.length}`, name: file.name, dataUrl: await readFileAsDataUrl(file) });
            } catch {
                message.warning(`${file.name} 读取失败`);
            }
        }
        if (accepted.length) setRefImages((prev) => [...prev, ...accepted].slice(0, imageLimit));
    };

    /**
     * 预检。`promptOverride` 由提示词面板的主按钮（文案「预检」）传进来，避免 state 落后一帧。
     *
     * 风格模板与视频节点同一条路：`composeStyledPrompt` 只在**发出去的那一版**提示词尾部追加，
     * metadata 里存的仍是干净正文（幂等，重复预检不会叠第二遍）。
     */
    const runPlan = async (promptOverride?: string) => {
        const base = (promptOverride ?? prompt).trim();
        if (!base) {
            message.warning("先写提示词");
            return;
        }
        if (!healthOk || !target) {
            message.warning("先连上本机桥并读到 MochiAni 页面（点右上角「刷新」）");
            return;
        }
        const styleTemplate = getStyleTemplate(node.metadata?.styleTemplateId);
        const text = composeStyledPrompt(base, styleTemplate ? buildStylePromptText(styleTemplate) : "", "");
        const media = await collectMediaPayload();
        // 漫剧编辑器的参考素材来自作品素材库（人物/场景/道具），不走上传，别拿 imageRequired 拦它。
        if (!isCarton && imageRequired && media.images.length < imageRequired) {
            message.warning(`这个模型至少要 ${imageRequired} 张参考图（现在 ${media.images.length} 张）`);
            return;
        }
        if (media.unusable.length) message.warning(media.unusable.slice(0, 2).join("；"));
        /** 图块上挂到的图一起发：桥在素材建好 / 匹配到真 ID 之后按 assetId 上传。没图的素材只发名字。 */
        const castImages: Array<{ kind: string; name: string; url?: string; dataUrl?: string }> = [];
        if (isCarton) {
            for (const field of CARTON_CAST_FIELDS) {
                for (const name of castNames(field.key)) {
                    const reference = matchCastImage(name);
                    const payload = reference ? await toReferencePayload(reference, "image") : null;
                    if (payload) castImages.push({ kind: field.key, name, ...payload });
                }
            }
        }
        setBusy("plan");
        setError("");
        setPlacedNodeId("");
        try {
            const data = await bridgeFetch(bridgeBase, "/api/plan", {
                method: "POST",
                body: JSON.stringify({
                    prompt: text,
                    pageId: target?.pageId,
                    modelKey: modelKey || undefined,
                    channelId: channelId || undefined,
                    params,
                    // 生成模式（11=全能参考）：空 = 不干预，沿用页面当前模式
                    videoCategory: videoCategory ?? undefined,
                    images: media.images,
                    videos: media.videos,
                    audios: media.audios,
                    // 漫剧编辑器专有：出场素材按行拆成名字数组，配音把原文交给桥去逐行解析
                    ...(isCarton
                        ? {
                              cast: {
                                  characters: splitInputLines(cast?.characters),
                                  scenes: splitInputLines(cast?.scenes),
                                  props: splitInputLines(cast?.props),
                                  autoCreate: true,
                                  images: castImages,
                              },
                              voiceover: voiceoverText || "",
                              generateVoice,
                          }
                        : {}),
                }),
            });
            if (data.job) {
                setJob(data.job);
                if (!data.ok) setError(data.error || "预检没有通过");
            } else {
                setError(data.error || "预检失败");
            }
            void refreshContext();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("");
        }
    };

    const runConfirm = async () => {
        if (!job) return;
        setBusy("confirm");
        setError("");
        try {
            const data = await bridgeFetch(bridgeBase, `/api/jobs/${encodeURIComponent(job.id)}/confirm`, { method: "POST", body: "{}" });
            if (data.job) setJob(data.job);
            if (!data.ok) setError(data.error || "下发失败");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("");
        }
    };

    const runCancel = async () => {
        if (!job) return;
        setBusy("cancel");
        try {
            const data = await bridgeFetch(bridgeBase, `/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST", body: "{}" });
            if (data.job) setJob(data.job);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("");
        }
    };

    const placeOnCanvas = async () => {
        if (!job?.videoUrl) return;
        setBusy("place");
        try {
            const nodeId = await onCreateVideo(job.videoUrl, job.prompt);
            setPlacedNodeId(nodeId);
            message.success("视频已经落到画布上了");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("");
        }
    };

    const resetJob = () => {
        stopPolling();
        setJob(null);
        setError("");
        setPlacedNodeId("");
        lastSnapshotRef.current = "";
        onConfigChange(node.id, { mochianiRun: undefined });
    };

    const changeBridge = (value: string) => {
        const next = value.trim() || DEFAULT_BRIDGE;
        setBridgeBase(next);
        try {
            window.localStorage.setItem(BRIDGE_STORAGE_KEY, next);
        } catch {
            // localStorage 不可用就算了
        }
        setBridgeEditing(false);
        void (async () => {
            const healthy = await checkHealth();
            if (healthy) {
                await refreshContext();
                await loadModels({ modelKey, channelId, params });
            }
        })();
    };

    /** 只挡「真实控件」的按下：不挡的话点一下输入框就变成拖整个节点。 */
    const stopDragOnInteractive = useCallback((event: React.SyntheticEvent) => {
        const element = event.target as HTMLElement | null;
        if (element?.closest?.(INTERACTIVE_SELECTOR)) event.stopPropagation();
    }, []);

    const balance = Number(points?.total ?? NaN);
    const estimatePoints = job?.estimate?.points ?? null;
    const notEnoughPoints = Number.isFinite(balance) && estimatePoints != null && balance < estimatePoints;
    const locked = Boolean(job) && ["planning", "submitting", "generating", "ready"].includes(jobStage);
    /** 提示词面板的「运行中」：预检请求在飞 / 任务在跑，主按钮变成「停止」。 */
    const panelRunning = busy === "plan" || ["planning", "submitting", "generating"].includes(jobStage);
    const stageColor = jobStage === "done" ? "success" : jobStage === "error" || jobStage === "blocked" ? "error" : jobStage ? "processing" : "default";

    const workLabel = target
        ? `${KIND_LABEL[target.kind] || target.siteName}${target.kind === "canvas" && work?.nodeCount != null ? ` · ${work.nodeCount} 节点` : ""}`
        : "";

    const softBorder = `1px solid ${theme.node.stroke}`;

    return (
        <div
            className="flex h-full w-full flex-col gap-2 p-3 text-[13px]"
            style={{ color: theme.node.text, cursor: "default" }}
            onMouseDown={stopDragOnInteractive}
            onPointerDown={stopDragOnInteractive}
        >
            {/* ① 表头：连接状态 + 生成目标 + 余额 */}
            <div className="flex items-center gap-2">
                <Clapperboard size={14} className="shrink-0" style={{ color: "#f472b6" }} />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold opacity-80">MochiAni 生视频</span>
                <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: healthError ? "#f87171" : healthOk ? "#22c55e" : "#71717a" }}
                    title={healthError || (healthOk ? "本机桥已连接" : "检查中")}
                />
                <button
                    type="button"
                    onClick={() => void (async () => {
                        const healthy = await checkHealth();
                        if (healthy) {
                            await refreshContext();
                            await loadModels({ modelKey, channelId, params });
                        }
                    })()}
                    className="flex items-center gap-1 text-[11px] opacity-60 transition hover:opacity-100"
                    disabled={loadingContext}
                >
                    {loadingContext ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} 刷新
                </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5" data-canvas-no-zoom>
                {/* ② 连接 / 目标 */}
                <div className="rounded-md px-2 py-1.5 text-[11px]" style={{ border: softBorder }}>
                    {healthError ? (
                        <div className="flex items-start gap-1.5" style={{ color: "#f87171" }}>
                            <CircleAlert size={12} className="mt-0.5 shrink-0" />
                            <span className="min-w-0 break-all">连不上本机桥：{healthError}</span>
                        </div>
                    ) : null}
                    {target ? (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="flex items-center gap-1" style={{ color: "#4ade80" }}>
                                <CircleCheck size={11} /> {workLabel}
                            </span>
                            <span className="flex items-center gap-1 opacity-70">
                                <Coins size={11} />
                                {points?.total != null ? `${points.label || "灵点"} ${points.total}` : "余额未读到"}
                                {accountUser ? `（${accountUser}）` : ""}
                            </span>
                        </div>
                    ) : healthError ? null : (
                        <div style={{ color: "#fbbf24" }}>
                            {contextError || "还没读到 MochiAni 页面"}
                            <div className="mt-0.5 opacity-70">先在浏览器打开 mochiani.com 的无限画布，再点「刷新」。</div>
                        </div>
                    )}
                    {bridgeEditing ? (
                        <div className="mt-1.5 flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                                <PlugZap size={11} className="shrink-0 opacity-60" />
                                <Input
                                    size="small"
                                    autoFocus
                                    defaultValue={bridgeBase}
                                    onBlur={(event) => changeBridge(event.target.value)}
                                    onPressEnter={(event) => changeBridge((event.target as HTMLInputElement).value)}
                                    placeholder={DEFAULT_BRIDGE}
                                />
                            </div>
                            <div className="text-[10px] leading-snug opacity-45">
                                填「跑 tools/mochiani-bridge 的那个进程」的地址，不是网页地址。本机用 127.0.0.1:17399；别的电脑要用就填桥所在机器的公网地址（如 https://xxx.ts.net/?token=你的令牌）。
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setBridgeEditing(true)}
                            className="mt-1 flex items-center gap-1 text-[10px] opacity-40 transition hover:opacity-80"
                            title="本机桥地址：必须指向跑 tools/mochiani-bridge 的那个进程，不是你的网站地址"
                        >
                            <Wrench size={10} /> 本机桥 {bridgeBase.replace(/([?&]token=)[^&]+/i, "$1***")}
                        </button>
                    )}
                </div>

                {/* ③ 模型 / 渠道 / 参数 */}
                <div className="rounded-md px-2 py-1.5" style={{ border: softBorder }}>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="opacity-60">模型 / 渠道</span>
                        <button
                            type="button"
                            onClick={() => void loadModels({ modelKey, channelId, params, videoCategory })}
                            className="flex items-center gap-1 opacity-50 transition hover:opacity-100"
                            disabled={modelsLoading}
                        >
                            {modelsLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} 重新读取
                        </button>
                    </div>
                    {modelsError ? (
                        <div className="mb-1 text-[11px]" style={{ color: "#fbbf24" }}>
                            {modelsError}
                        </div>
                    ) : null}
                    <div className="flex flex-col gap-1.5">
                        {categorySelectOptions.length ? (
                            <div className="flex items-center gap-1.5">
                                <span className="shrink-0 text-[10px] opacity-45">生成模式</span>
                                <Select
                                    size="small"
                                    style={{ flex: 1, minWidth: 0 }}
                                    value={videoCategory ?? undefined}
                                    options={categorySelectOptions}
                                    onChange={changeVideoCategory}
                                    disabled={locked || modelsLoading}
                                />
                            </div>
                        ) : null}
                        {usingFallbackCategories ? (
                            <div className="text-[10px] opacity-40">
                                没读到面板分类（MochiAni 那个标签页在后台时不回读），按固定表列出；生成时会按这里选的值切。
                            </div>
                        ) : null}
                        <Select
                            size="small"
                            showSearch
                            optionFilterProp="label"
                            placeholder={modelsLoading ? "读取中…" : "选择模型"}
                            value={modelKey || undefined}
                            style={{ width: "100%" }}
                            options={modelOptions}
                            onChange={changeModel}
                            disabled={locked || modelsLoading || !models.length}
                        />
                        {models.length ? (
                            <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] opacity-45">
                                <span>共 {models.length} 个</span>
                                {modelKindSummary.map((group) => (
                                    <span key={group.label}>
                                        · {group.label} {group.count}
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        {models.length > 1 && modelKindSummary.length === 1 && modelKindSummary[0].label === MODEL_KIND_LABEL.other ? (
                            <div className="text-[10px] opacity-45">模型目录没带模态字段，暂时分不出生图 / 生视频（仍可搜索选择）。</div>
                        ) : null}
                        {selectedModelIsImage ? (
                            <div className="text-[10px]" style={{ color: "#fbbf24" }}>
                                选中的是生图模型，这个节点是拿来生视频的 —— 可能出不来视频。
                            </div>
                        ) : null}
                        {hasModelCategory && videoCategory != null && selectedModel?.specificType != null && selectedModel.specificType !== videoCategory ? (
                            <div className="text-[10px]" style={{ color: "#fbbf24" }}>
                                当前模型属于「{VIDEO_CATEGORY_LABEL[selectedModel.specificType] || selectedModel.specificType}」模式，
                                不是「{VIDEO_CATEGORY_LABEL[videoCategory] || videoCategory}」—— 以模型为准。
                            </div>
                        ) : null}
                        {/* 渠道：默认自动。同一个模型下的一堆渠道只是供应商池，模型名已经区分开了，
                            全都摆出来纯噪音。只在用户主动点「换」时才展开，选完再收回去。 */}
                        {selectedModel ? (
                            channelPickerOpen && (selectedModel.channels?.length || 0) > 1 ? (
                                <div className="flex items-center gap-1">
                                    <Select
                                        size="small"
                                        placeholder="选择渠道"
                                        value={channelId || undefined}
                                        style={{ flex: 1, minWidth: 0 }}
                                        options={(selectedModel.channels || []).map((item) => ({
                                            value: item.id,
                                            label: `${item.name}${item.avgTime ? ` · ${item.avgTime}s` : ""}`,
                                        }))}
                                        onChange={(value) => {
                                            changeChannel(value);
                                            setChannelPickerOpen(false);
                                        }}
                                        disabled={locked}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setChannelPickerOpen(false)}
                                        className="shrink-0 text-[10px] opacity-45 transition hover:opacity-80"
                                    >
                                        收起
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center justify-between gap-2 text-[10px]">
                                    <span className="min-w-0 truncate opacity-45">
                                        渠道 {selectedChannel ? selectedChannel.name : "自动"}
                                        {selectedChannel?.avgTime ? ` · ${selectedChannel.avgTime}s` : ""}
                                    </span>
                                    {!locked && (selectedModel.channels?.length || 0) > 1 ? (
                                        <button
                                            type="button"
                                            onClick={() => setChannelPickerOpen(true)}
                                            className="shrink-0 opacity-45 transition hover:opacity-90"
                                            title={`这个模型有 ${selectedModel.channels?.length} 条渠道，默认自动选一条`}
                                        >
                                            换渠道
                                        </button>
                                    ) : null}
                                </div>
                            )
                        ) : null}
                        {Object.keys(paramSource).length ? (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                {Object.entries(paramSource).map(([key, options]) => (
                                    <label key={key} className="flex items-center gap-1 text-[11px]">
                                        <span className="opacity-55">{paramLabel(key)}</span>
                                        <Select
                                            size="small"
                                            value={params[key] ?? options[0]?.value}
                                            style={{ minWidth: 78 }}
                                            options={options.map((item) => ({ value: item.value, label: item.label }))}
                                            onChange={(value) => changeParam(key, value)}
                                            disabled={locked}
                                            popupMatchSelectWidth={false}
                                        />
                                    </label>
                                ))}
                            </div>
                        ) : null}
                        {selectedModel ? (
                            <div className="text-[10px] opacity-45">
                                参考图{imageRequired ? ` 至少 ${imageRequired} 张 /` : ""} 最多 {imageLimit} 张
                                {videoLimit ? ` · 视频最多 ${videoLimit} 个` : ""}
                                {audioLimit ? ` · 音频最多 ${audioLimit} 个` : ""}
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* ③.5 漫剧编辑器专有：出场素材 / 配音
                      两套口径别混：无限画布是「节点 + 上传参考图」，漫剧编辑器是「分镜 + 素材库 ID + 配音项」。
                      这里只负责收**名字**，真实 ID 由桥按当前作品的素材库现解析（换个作品同一份节点还能用）。

                      这块**可填可不填**：不填就让 MochiAni 按分镜文案自己解析。填了以「图块」形态出现 ——
                      图来自画布上连线进来的图片节点，按节点标题跟名字对上（「林晚定妆照」→ 林晚）；
                      对不上就留空，绝不乱挂（把 A 的脸挂到 B 身上比没图更糟）。 */}
                {isCarton ? (
                    <div className="rounded-md px-2 py-1.5" style={{ border: softBorder }}>
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="flex min-w-0 items-center gap-1">
                                <Clapperboard size={11} className="shrink-0 opacity-60" />
                                <span className="truncate opacity-60">出场素材 / 配音</span>
                                <span className="shrink-0 opacity-30">可选</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => setCastOpen((prev) => !prev)}
                                className="shrink-0 text-[10px] opacity-45 transition hover:opacity-90"
                            >
                                {castOpen ? "收起" : "填写"}
                            </button>
                        </div>
                        {castOpen ? (
                            <div className="mt-1.5 flex flex-col gap-2">
                                {CARTON_CAST_FIELDS.map((field) => {
                                    const names = castNames(field.key);
                                    return (
                                        <div key={field.key}>
                                            <div className="mb-1 flex items-center justify-between text-[10px]">
                                                <span className="opacity-45">{field.label}</span>
                                                <span className="opacity-25">{names.length ? `${names.length} 个` : "空"}</span>
                                            </div>
                                            <div className="flex flex-wrap items-start gap-1.5">
                                                {names.map((name) => {
                                                    const image = matchCastImage(name);
                                                    const thumb = image ? String(image.previewUrl || "") : "";
                                                    return (
                                                        <div key={name} className="group relative w-[52px]">
                                                            <div
                                                                className="relative h-[52px] w-[52px] overflow-hidden rounded"
                                                                style={{ border: softBorder }}
                                                                title={
                                                                    image
                                                                        ? `用图：${image.title || image.label}`
                                                                        : "没找到同名图片 —— 把画布上的图片节点改名成这个角色的名字（例如「林晚定妆照」）再连进来，就会自动挂上"
                                                                }
                                                            >
                                                                {thumb ? (
                                                                    <img src={thumb} alt={name} className="h-full w-full object-cover" />
                                                                ) : (
                                                                    <div className="flex h-full w-full items-center justify-center opacity-20">
                                                                        <ImagePlus size={14} />
                                                                    </div>
                                                                )}
                                                                {!locked ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => removeCastName(field.key, name)}
                                                                        className="absolute right-0 top-0 rounded bg-black/70 p-0.5 opacity-0 transition group-hover:opacity-100"
                                                                        title="从素材里移除这个名字（不会断线）"
                                                                    >
                                                                        <X size={9} color="#fff" />
                                                                    </button>
                                                                ) : null}
                                                            </div>
                                                            <div className="mt-0.5 truncate text-center text-[9px] opacity-60" title={name}>
                                                                {name}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                                <Input
                                                    size="small"
                                                    placeholder="+ 名字"
                                                    disabled={locked}
                                                    style={{ width: 74 }}
                                                    onPressEnter={(event) => {
                                                        const input = event.target as HTMLInputElement;
                                                        addCastName(field.key, input.value);
                                                        input.value = "";
                                                    }}
                                                    onBlur={(event) => {
                                                        const input = event.target as HTMLInputElement;
                                                        if (!input.value.trim()) return;
                                                        addCastName(field.key, input.value);
                                                        input.value = "";
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                                <label className="flex flex-col gap-0.5">
                                    <span className="text-[10px] opacity-45">配音（角色名：台词，一行一条）</span>
                                    <Input.TextArea
                                        size="small"
                                        autoSize={{ minRows: 1, maxRows: 6 }}
                                        value={voiceoverText}
                                        placeholder={"林晚：这门我从来没开过。\n陆沉：那你现在开。"}
                                        onChange={(event) => saveConfig({ voiceover: event.target.value })}
                                        disabled={locked}
                                    />
                                </label>
                                <label className="flex items-center justify-between text-[11px]">
                                    <span className="opacity-55">确认时一起生成配音</span>
                                    <Switch
                                        size="small"
                                        checked={generateVoice}
                                        onChange={(checked) => saveConfig({ generateVoice: checked })}
                                        disabled={locked}
                                    />
                                </label>
                            </div>
                        ) : (
                            <div className="mt-1 text-[10px] leading-snug opacity-40">
                                不填就只发提示词，出场人物 / 场景 / 道具交给 MochiAni 按分镜自己解析。
                            </div>
                        )}
                    </div>
                ) : null}

                {/* ④ 提示词 —— 直接复用视频节点的提示词面板（内嵌形态）：
                       @ 引用 chip（图 / 视频 / 音频 / 文案）+ 风格模板 + 主按钮＝预检。
                       与视频窗口的唯一差别是这里没有模型/参数行（模型目录来自桥）和排期。 */}
                <div className="rounded-md px-1.5 py-1.5" style={{ border: softBorder }}>
                    <CanvasNodePromptPanel
                        embedded
                        hideModelRow
                        hideSchedule
                        allowSubmitWhileRunning={false}
                        generateLabel="预检"
                        modeOverride="video"
                        node={node}
                        isRunning={panelRunning}
                        mentionReferences={references || []}
                        onPromptChange={handlePromptChange}
                        onConfigChange={(nodeId, patch) => onConfigChange(nodeId, patch as Partial<CanvasNodeMetadata>)}
                        onGenerate={(_nodeId, _mode, text) => void runPlan(text)}
                        onStop={() => void runCancel()}
                        onReorderReferences={onReorderReferences}
                        onRemoveReference={onDetachReference}
                        onPreviewReference={onPreviewReference}
                    />
                </div>

                {/* ⑤ 参考素材：连线接入的图 / 视频 / 音频 + 手动加的图
                      漫剧编辑器的参考走「作品素材库」（上面那三个输入区），上传的图它不认，所以那边不显示这块。 */}
                {isCarton ? null : (
                    <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="opacity-55">参考素材</span>
                        <span className="opacity-35">
                            图 {linkedByKind.image.length + refImages.length}/{imageLimit}
                            {linkedByKind.video.length ? ` · 视频 ${linkedByKind.video.length}${videoLimit ? `/${videoLimit}` : ""}` : ""}
                            {linkedByKind.audio.length ? ` · 音频 ${linkedByKind.audio.length}${audioLimit ? `/${audioLimit}` : ""}` : ""}
                        </span>
                    </div>
                    <div className="flex flex-wrap items-start gap-1.5">
                        {linkedMedia.map((reference) => {
                            const meta = MEDIA_KIND_META[reference.kind as MediaKind];
                            const Icon = meta.icon;
                            const showThumb = reference.kind === "image" && Boolean(reference.previewUrl);
                            return (
                                <div
                                    key={reference.id}
                                    className="group relative flex h-14 w-14 flex-col items-center justify-center overflow-hidden rounded text-[9px]"
                                    style={{ border: softBorder, color: meta.color }}
                                    title={`${reference.title}（连线接入 · ${meta.label}）`}
                                >
                                    {showThumb ? (
                                        <img src={reference.previewUrl} alt={reference.title} className="h-full w-full object-cover" />
                                    ) : (
                                        <>
                                            <Icon size={16} />
                                            <span className="mt-0.5 max-w-full truncate px-0.5 opacity-80">{reference.title}</span>
                                        </>
                                    )}
                                    {!locked && onDetachReference ? (
                                        <button
                                            type="button"
                                            onClick={() => onDetachReference(reference.nodeId)}
                                            className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 opacity-0 transition group-hover:opacity-100"
                                            title="断开这根线（不再当参考素材）"
                                        >
                                            <Unlink size={10} color="#fff" />
                                        </button>
                                    ) : null}
                                </div>
                            );
                        })}
                        {refImages.map((item) => (
                            <div key={item.uid} className="group relative h-14 w-14 overflow-hidden rounded" style={{ border: softBorder }}>
                                <img src={item.dataUrl} alt={item.name} className="h-full w-full object-cover" />
                                {!locked ? (
                                    <button
                                        type="button"
                                        onClick={() => setRefImages((prev) => prev.filter((it) => it.uid !== item.uid))}
                                        className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 opacity-0 transition group-hover:opacity-100"
                                        title="移除"
                                    >
                                        <X size={10} color="#fff" />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                        {refImages.length + linkedByKind.image.length < imageLimit && !locked ? (
                            <Upload
                                accept="image/*"
                                multiple
                                showUploadList={false}
                                beforeUpload={(file) => {
                                    void addImages([file as unknown as File]);
                                    return false;
                                }}
                            >
                                <div
                                    className="flex h-14 w-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded border border-dashed text-[10px] opacity-55 transition hover:opacity-100"
                                    style={{ borderColor: theme.node.stroke }}
                                >
                                    <ImagePlus size={14} />
                                    加图
                                </div>
                            </Upload>
                        ) : null}
                    </div>
                    {!linkedMedia.length ? (
                        <div className="mt-1 text-[10px] leading-snug opacity-40">
                            选中本节点按 X，再点图片 / 视频 / 音频节点 —— 连进来的素材会出现在这里，预检时一起传进 MochiAni 当参考。
                        </div>
                    ) : null}
                    </div>
                )}

                {/* ⑥ 任务状态 */}
                {job ? (
                    <div className="rounded-md px-2 py-1.5" style={{ border: softBorder }}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                            <Tag color={stageColor} style={{ marginInlineEnd: 0 }}>
                                {STAGE_LABEL[job.stage] || job.stage}
                            </Tag>
                            {job.estimate?.points != null ? (
                                <span className="flex items-center gap-1 opacity-80">
                                    <Coins size={10} /> 预估 {job.estimate.points} 灵点
                                </span>
                            ) : null}
                            {job.estimate?.labels && Object.keys(job.estimate.labels).length ? (
                                <span className="opacity-45">{Object.values(job.estimate.labels).join(" / ")}</span>
                            ) : null}
                            {job.imageCount ? <span className="opacity-45">参考图 {job.imageCount} 张</span> : null}
                            {job.videoCount ? <span className="opacity-45">参考视频 {job.videoCount} 个</span> : null}
                            {job.audioCount ? <span className="opacity-45">参考音频 {job.audioCount} 个</span> : null}
                            {job.cast?.characters?.length ? <span className="opacity-45">人物 {job.cast.characters.length}</span> : null}
                            {job.cast?.scenes?.length ? <span className="opacity-45">场景 {job.cast.scenes.length}</span> : null}
                            {job.cast?.props?.length ? <span className="opacity-45">道具 {job.cast.props.length}</span> : null}
                            {job.voiceCount ? <span className="opacity-45">配音 {job.voiceCount} 条</span> : null}
                        </div>
                        {notEnoughPoints ? (
                            <div className="mt-1 text-[11px]" style={{ color: "#fbbf24" }}>
                                余额 {points?.total} 灵点，不够预估的 {estimatePoints} 灵点 —— 会被 MochiAni 拒（余额不足），先充值。
                            </div>
                        ) : null}
                        {job.warnings?.length ? (
                            <div className="mt-1 text-[11px]" style={{ color: "#fbbf24" }}>
                                {job.warnings.map((item, index) => (
                                    <div key={`${item}-${index}`}>· {item}</div>
                                ))}
                            </div>
                        ) : null}
                        {job.log.length ? (
                            <div className="mt-1 max-h-20 overflow-auto text-[10px] leading-relaxed opacity-55" data-canvas-no-zoom>
                                {job.log.slice(-5).map((item, index) => (
                                    <div key={`${item.at}-${index}`}>· {item.message}</div>
                                ))}
                            </div>
                        ) : null}
                        {job.error ? (
                            <div className="mt-1 text-[11px]" style={{ color: "#fca5a5" }}>
                                {job.error}
                            </div>
                        ) : null}
                        {job.videoUrl ? <video src={job.videoUrl} controls className="mt-1.5 w-full rounded" style={{ maxHeight: 180, background: "#000" }} /> : null}
                    </div>
                ) : null}

                {error ? (
                    <div className="rounded-md px-2 py-1 text-[11px]" style={{ background: "rgba(248,113,113,0.12)", color: "#fca5a5" }}>
                        {error}
                    </div>
                ) : null}
            </div>

            {/* ⑦ 操作 */}
            <div className="flex flex-wrap items-center justify-end gap-1.5 pt-0.5">
                {job && ["done", "error", "cancelled"].includes(jobStage) ? <Button size="small" onClick={resetJob}>新建任务</Button> : null}
                {job && jobStage === "ready" ? <Button size="small" onClick={resetJob}>改配置</Button> : null}
                {job && ["generating", "submitting"].includes(jobStage) ? (
                    <Button size="small" danger loading={busy === "cancel"} onClick={() => void runCancel()}>
                        停止轮询
                    </Button>
                ) : null}
                {!job || ["error", "cancelled"].includes(jobStage) ? (
                    <Button
                        size="small"
                        icon={<Sparkles size={13} />}
                        loading={busy === "plan"}
                        onClick={() => void runPlan()}
                        disabled={!healthOk || !target}
                    >
                        预检（不花钱）
                    </Button>
                ) : null}
                {job && jobStage === "ready" ? (
                    <Button size="small" type="primary" danger loading={busy === "confirm"} onClick={() => void runConfirm()}>
                        确认生成（扣灵点）
                    </Button>
                ) : null}
                {jobStage === "done" && job?.videoUrl ? (
                    <Button size="small" type="primary" loading={busy === "place"} onClick={() => void placeOnCanvas()} disabled={Boolean(placedNodeId)}>
                        {placedNodeId ? "已放到画布" : "放到画布"}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
