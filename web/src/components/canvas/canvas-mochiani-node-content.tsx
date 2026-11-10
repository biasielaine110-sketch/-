import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Select, Switch, Tag, Upload } from "antd";
import type { SelectProps } from "antd";
import {
    CircleAlert,
    CircleCheck,
    Clapperboard,
    Coins,
    ExternalLink,
    Film,
    ImagePlus,
    LayoutGrid,
    Loader2,
    Music4,
    Play,
    PlugZap,
    RefreshCw,
    Sparkles,
    Unlink,
    Video,
    Wrench,
    X,
} from "lucide-react";

import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { shrinkImageDataUrl, shrinkImageDataUrls } from "@/lib/canvas/mochiani-payload";
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
    /** 桥 1.6.8+：预检丢到后台跑了，`job.stage` 会停在 `planning`，靠轮询拿结果。 */
    pending?: boolean;
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
        modelId?: string;
        channelId?: string;
        configParams?: Record<string, string>;
        /**
         * 节点当前模型/渠道的**完整**参数候选（`model_controls.editableParameters`）。
         *
         * 🔴 为什么 `configInfo` 不够：画幅（`model_size`）挂在**模型**的 `modelSize` 串上，
         * 由 MochiAni 前端临时合进参数表，`configInfo` 里根本没有这一项 —— 只看 `configInfo`
         * 时 `Seedance2.0 fast` / `Wan3.0` 阿里云线路的画幅选择器会整个消失。
         */
        editableParameters?: Record<string, ParamOption[]>;
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
    /**
     * 产物落到画布：建一个视频节点并返回它的 id。
     *
     * 第三个参数是**宿主节点 id**（= 本 MochiAni 窗口）：画布会把媒体引用**也镜像到宿主节点**上，
     * 于是「脚本链路里连到合并节点的那根线」能直接读到这段视频（用户 2026-11-10 第 01 条）。
     */
    onCreateVideo: (videoUrl: string, prompt?: string, options?: { hostNodeId?: string }) => Promise<string>;
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

const LOCAL_BRIDGE_ORIGIN = "http://127.0.0.1:17399";
/** 本机桥探测结果缓存：60s 内不重复探（一次发送里有十几个请求，别每次都探）。 */
const localBridgeProbe = new Map<string, { ok: boolean; at: number }>();

function isLocalOrigin(origin: string) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i.test(origin);
}

function pageServedLocally() {
    try {
        const host = window.location.hostname;
        return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    } catch {
        return false;
    }
}

/**
 * 页面自己就跑在本机时，直连本机桥，别绕公网域名。
 *
 * 为什么值得专门做一层：桥和网页在同一台机器上，但地址栏里填的是
 * `https://xxx.ts.net:8443`（为了别的设备也能用）—— 于是每次请求都从本机出网、
 * 走 Tailscale 中转再回到本机。实测上传 14.77MB 参考图用了 **240 秒**
 * （≈60KB/s，正是中转速度），换成 loopback 是几十毫秒。
 *
 * 只在「页面在 127.0.0.1 上」且「配置的地址不是本机」时才探一次；探不通就老实走原地址，
 * 所以对真正的远程用法零影响。
 */
async function resolveBridgeOrigin(origin: string, token: string) {
    if (isLocalOrigin(origin) || !pageServedLocally()) return origin;
    const cached = localBridgeProbe.get(origin);
    if (cached && Date.now() - cached.at < 60_000) return cached.ok ? LOCAL_BRIDGE_ORIGIN : origin;
    let ok = false;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(`${LOCAL_BRIDGE_ORIGIN}/health`, {
            signal: controller.signal,
            headers: token ? { "x-mochiani-token": token } : {},
        });
        clearTimeout(timer);
        ok = response.ok;
    } catch {
        ok = false;
    }
    localBridgeProbe.set(origin, { ok, at: Date.now() });
    return ok ? LOCAL_BRIDGE_ORIGIN : origin;
}

async function bridgeFetch(base: string, path: string, init?: RequestInit): Promise<BridgeBody> {
    const { origin, token } = parseBridgeAddress(base);
    const target = await resolveBridgeOrigin(origin, token);
    const response = await fetch(`${target}${path}`, {
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

/**
 * 画布模式下 MochiAni 节点的**默认档位**（用户指定）。
 *
 * 只在这个节点还没存过配置时生效 —— 用户一旦自己选过模型 / 渠道 / 参数，就以存的为准，
 * 否则每次节点滚出视口重挂都会把人的选择冲回默认值。
 *
 * 渠道默认按「原厂线路」挑：Seedance 系是 `AL`，Wan 系是 `阿里云`（见 `pickPreferredChannel`）。
 * ⚠️ 这两条线路的 `configInfo` 里都**没有画幅参数**（画幅挂在模型的 `modelSize` 上），
 * 所以画幅必须靠 `/api/params` 回读 `editableParameters`，不能只看 `configInfo`。
 */
const PREFERRED_MODEL_NAME = "seedance2.0fast";
/** 默认渠道名（按优先级）：Seedance 系 `AL`，Wan 系 `阿里云`。 */
const PREFERRED_CHANNEL_NAMES = ["al", "阿里云"];
const PREFERRED_PARAM_VALUES: Record<string, string> = { resolution: "480p", duration: "15" };
/** 画幅默认 9:16（竖屏）。只有模型/渠道真的提供画幅参数时才写进去。 */
const DEFAULT_ASPECT_RATIO = "9:16";
/** 画幅参数在各家的键名：Muse 系 `model_size`，Seedance / HaiLuo 系 `lable1`。 */
const ASPECT_RATIO_KEYS = ["model_size", "lable1", "aspect_ratio", "ratio", "size_ratio"] as const;

/** 比较用：忽略大小写和空格（`Seedance2.0 fast` / `seedance 2.0 fast` 视为同一个）。 */
function squash(value: unknown) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/\s+/g, "");
}

/** 候选里按「值或标签」大小写不敏感地找真实 value（AL 渠道写 `480P`，别的渠道写 `480p`）。 */
function matchOptionValue(options: ParamOption[] | undefined, wanted: string) {
    if (!Array.isArray(options) || !options.length) return "";
    const target = squash(wanted);
    return options.find((item) => squash(item.value) === target || squash(item.label) === target)?.value || "";
}

/** 参数源：渠道自己的 configInfo 优先（同模型不同渠道可调项不一样），没有就退回模型的。 */
function paramSourceOf(model?: ModelOption | null, channel?: ModelChannel | null) {
    const channelConfig = channel?.configInfo;
    if (channelConfig && Object.keys(channelConfig).length) return channelConfig;
    return model?.configInfo || {};
}

/** 这个参数源里哪个键是画幅（没有就空串 = 这个渠道不给画幅）。 */
function aspectRatioKeyOf(source: Record<string, unknown>) {
    return ASPECT_RATIO_KEYS.find((key) => key in source) || "";
}

/**
 * 一组参数候选里的「用户偏好值」：分辨率 480p / 时长 15s / 画幅 9:16。
 *
 * 只在候选里真的有这一项时才写 —— 渠道不提供就不塞，免得给 MochiAni 发一个它不认的键。
 */
function preferredFromOptions(options: Record<string, ParamOption[]>, aspectRatio = DEFAULT_ASPECT_RATIO) {
    const out: Record<string, string> = {};
    for (const [key, wanted] of Object.entries(PREFERRED_PARAM_VALUES)) {
        const hit = matchOptionValue(options[key], wanted);
        if (hit) out[key] = hit;
    }
    const ratioKey = aspectRatioKeyOf(options);
    const ratio = ratioKey ? matchOptionValue(options[ratioKey], aspectRatio) : "";
    if (ratioKey && ratio) out[ratioKey] = ratio;
    return out;
}

/**
 * 默认档位：先走 `defaultParams`，再把用户指定的分辨率 / 时长 / 画幅压上去。
 *
 * 为什么不能直接用 `defaultParams`：画布那边的兜底是「时长取最短」（15 个候选里取 4s），
 * 而这里要的是 15s；分辨率同理，默认要 480p 而不是列表第一个。
 */
function preferredParams(model: ModelOption, channel?: ModelChannel, aspectRatio = DEFAULT_ASPECT_RATIO) {
    return { ...defaultParams(model, channel), ...preferredFromOptions(paramSourceOf(model, channel), aspectRatio) };
}

/**
 * 只挑出「画幅」那一项。
 *
 * 换模型 / 换渠道时用它把用户已经选过的画幅带过去 —— 否则每次切线路都被
 * `preferredParams` 重置回默认 9:16，用户以为自己选丢了。
 */
function aspectOnly(source: Record<string, string>) {
    const out: Record<string, string> = {};
    for (const key of ASPECT_RATIO_KEYS) {
        if (source[key]) out[key] = source[key];
    }
    return out;
}

/**
 * 把一份参数值对齐到「权威参数候选」上。
 *
 * 用于 `/api/params` 回读之后：用户已经选过、且新候选里仍然合法的值原样保留；
 * 不合法 / 缺失的按偏好补（480p / 15s / 9:16），再不行取第一个候选。
 * 候选里没有的键直接丢掉 —— 留着会让 `configure_model` 发一个该模型不认的参数。
 */
function alignToOptions(current: Record<string, string>, options: Record<string, ParamOption[]>, aspectRatio = DEFAULT_ASPECT_RATIO) {
    const preferred = preferredFromOptions(options, aspectRatio);
    const out: Record<string, string> = {};
    for (const [key, list] of Object.entries(options)) {
        if (!list.length) continue;
        const value = current[key];
        const stillValid = value && list.some((item) => item.value === value);
        out[key] = stillValid ? value : preferred[key] || list[0]?.value || "";
    }
    return out;
}

/** 名字里恰好就是 `Seedance2.0 fast`（排除 `... fast vip` 之类）的那个；再优先「带 AL 渠道」的。 */
function pickPreferredModel(list: ModelOption[]) {
    const named = list.filter((item) => squash(item.modelName) === PREFERRED_MODEL_NAME);
    if (!named.length) return null;
    return named.find((item) => (item.channels || []).some((channel) => squash(channel.name) === PREFERRED_CHANNEL_NAMES[0])) || named[0];
}

/**
 * 模型下拉里要**标绿**的「常用模型」。
 *
 * ⚠️ 按名字归一化后**精确**匹配，不用 `includes` —— 否则 `Seedance2.0 fast vip` 会跟着绿。
 */
const RECOMMENDED_MODEL_NAMES = ["seedance2.0fast", "wan3.0"] as const;

/** 标绿用的颜色：深色底提亮绿，浅色底压深绿，两边都得读得清。 */
const RECOMMENDED_MODEL_COLOR = { dark: "#4ade80", light: "#15803d" } as const;

/**
 * 算出该标绿的 `modelKey` 集合。
 *
 * 🔴 同名不同 id 在 MochiAni 里是常态（`Seedance2.0 fast` = 90/130，`wan3.0` = 187/191），
 * 而且**渠道池不一样**：90 才有 AL，130 只有火山引擎；187/191 都有阿里云（187 线路更多）。
 * 全标绿等于让用户随便挑一个，挑到 #130 就没有画幅了 —— 所以每个名字只标**该选的那一个**：
 * 先按「有没有原厂线路（AL / 阿里云）」筛，再取渠道最多的，最后按 id 小的。
 */
function recommendedModelKeys(list: ModelOption[]) {
    const keys = new Set<string>();
    for (const name of RECOMMENDED_MODEL_NAMES) {
        const sameName = list.filter((item) => squash(item.modelName) === name);
        if (!sameName.length) continue;
        const wantedChannel = name === "seedance2.0fast" ? PREFERRED_CHANNEL_NAMES[0] : "阿里云";
        const withChannel = sameName.filter((item) => (item.channels || []).some((channel) => squash(channel.name) === squash(wantedChannel)));
        const pool = withChannel.length ? withChannel : sameName;
        const best = [...pool].sort(
            (a, b) => (b.channels?.length || 0) - (a.channels?.length || 0) || Number(a.modelId) - Number(b.modelId),
        )[0];
        if (best) keys.add(best.modelKey);
    }
    return keys;
}

/**
 * 默认渠道：优先原厂线路 —— `AL`（Seedance 系）→ `阿里云`（Wan 系）→ 名字最短的阿里云线路 → 第一条。
 *
 * ⚠️ 不能用 `/al$/` 这种后缀匹配去凑「阿里云」：中文线路名一个都命中不了，
 * 结果 Wan3.0 会落到渠道列表第一条（可能是 `阿里云（2k定制版）` 这种加价线路）。
 */
function pickPreferredChannel(model?: ModelOption | null) {
    const channels = model?.channels || [];
    if (!channels.length) return null;
    for (const wanted of PREFERRED_CHANNEL_NAMES) {
        const exact = channels.find((channel) => squash(channel.name) === squash(wanted));
        if (exact) return exact;
    }
    const seedanceStyle = channels.find((channel) => /(^|-)al$/.test(squash(channel.name)));
    if (seedanceStyle) return seedanceStyle;
    const aliCloud = channels
        .filter((channel) => String(channel.name || "").includes("阿里云"))
        .sort((a, b) => String(a.name).length - String(b.name).length);
    return aliCloud[0] || channels[0];
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
    // 已经是 dataUrl 的图也要减重（粘贴进来的图就是这个形态）
    if (url.startsWith("data:")) return { dataUrl: kind === "image" ? await shrinkImageDataUrl(url) : url };

    try {
        if (kind === "image") {
            // 空 content（本地库迁移过）也交给它：会按 storageKey / 页面上的 <img> 找回原图。
            const dataUrl = await imageToDataUrl({ url, nodeId: reference.nodeId });
            if (!dataUrl.startsWith("data:image/")) return null;
            /**
             * 本地图只能内联成 base64 发给桥：原图 3~5MB → base64 4.9MB → 三张 14.7MB，
             * 实测一次「发送」光把请求体送进桥就要 240 秒。长边压到 1280、JPEG 0.86 后
             * 单张落到 200KB 量级，体积小一个数量级，模型那边观感几乎无差。
             */
            return { dataUrl: await shrinkImageDataUrl(dataUrl) };
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

/**
 * 「一键生成」：预检通过后要**自动**接着点确认的那些任务 id。
 *
 * 为什么放模块级而不是 state：画布节点滚出视口就被裁掉重挂，而预检要跑十几秒到几分钟。
 * 挂掉的这一段时间里预检照样在桥那边跑完，重挂时 `metadata.mochianiRun` 会把 job 捞回来 ——
 * 如果「还没确认」这个意图只存在组件 state 里，那一下就没了，用户回来只看到一个停在
 * 「待确认」的任务，还得自己再点一下。放模块级就能跨重挂活下来。
 * （整页刷新会丢，这是可接受的：那种情况下用户看到的就是「待确认」，点一下就行。）
 */
const autoConfirmJobIds = new Set<string>();

/** 等待时长 → `03:07`。 */
function formatWaitTime(seconds: number) {
    const total = Math.max(0, Math.floor(seconds));
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

export function CanvasMochianiNodeContent({ node, references, onDetachReference, onReorderReferences, onPreviewReference, onCreateVideo, onConfigChange }: Props) {
    const { message } = App.useApp();
    const themeMode = useThemeStore((state) => state.theme);
    const theme = canvasThemes[themeMode];

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
    const [tidying, setTidying] = useState(false);

    const [models, setModels] = useState<ModelOption[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState("");
    const [modelKey, setModelKey] = useState(node.metadata?.mochianiConfig?.modelKey || "");
    const [channelId, setChannelId] = useState(node.metadata?.mochianiConfig?.channelId || "");
    const [params, setParams] = useState<Record<string, string>>(node.metadata?.mochianiConfig?.params || {});
    /**
     * `/api/params` 回读回来的「权威参数候选」，按 `modelKey|channelId` 缓存。
     *
     * 🔴 为什么不能只用 `configInfo`：画幅（`model_size`）挂在**模型**的 `modelSize` 串上，
     * MochiAni 前端在 `configInfo` 缺这一项时临时合进参数表 —— 桥只读 `configInfo`，
     * 于是 `Seedance2.0 fast` 的 AL 线路、`Wan3.0` 的阿里云线路全都**没有画幅下拉**。
     * 完整参数表只有 `model_controls.editableParameters` 有，由桥的 `/api/params` 回读。
     */
    const [paramOptions, setParamOptions] = useState<Record<string, Record<string, ParamOption[]>>>({});
    const [paramsProbing, setParamsProbing] = useState(false);
    /** `params` 的实时镜像 —— 异步回读回来时要拿最新的值去对齐（闭包里的 `params` 会过期）。 */
    const paramsRef = useRef<Record<string, string>>(node.metadata?.mochianiConfig?.params || {});
    /** `paramOptions` 的镜像：`loadModels` 里要读缓存对齐，又不能把缓存塞进依赖（会把回调整片重建）。 */
    const paramOptionsRef = useRef<Record<string, Record<string, ParamOption[]>>>({});
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
    /**
     * 画幅偏好（默认 9:16）。
     *
     * ——不做成一个「假开关」：模型/渠道真的提供画幅参数（`model_size` / `lable1`）时，它会写进
     * `params`，那一行是通用参数下拉，用户在那里改；不提供时（比如 AL 渠道）只显示一句提示，
     * 因为**没有参数可设**，画幅由首张参考图 / 模型默认决定。存下来是为了换了渠道能自动带上。
     */
    const [aspectRatio, setAspectRatio] = useState<string>(() => node.metadata?.mochianiConfig?.aspectRatio || DEFAULT_ASPECT_RATIO);
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
    /**
     * 锁住的目标页类型。`carton`（漫剧编辑器）不吃「面板参数回读」也不吃画布排版 ——
     * 参数在模型目录的 configInfo 里，节点排版没有画布节点这一说。用它挡掉那两类请求，
     * 免得每切一次模型就往控制台糊一条 409。
     */
    const targetKindRef = useRef<"canvas" | "carton" | "">("");
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
                targetKindRef.current = data.target.kind === "carton" ? "carton" : "canvas";
                setTarget(data.target);
                setWork(data.work || null);
                setContextError("");
                const acc = await bridgeFetch(bridgeBase, "/api/account").catch(() => null);
                setPoints(acc?.ok ? acc.points || null : null);
                setAccountUser(acc?.ok ? acc.user || "" : "");
            } else {
                targetPageRef.current = "";
                targetKindRef.current = "";
                setTarget(null);
                setWork(null);
                setPoints(null);
                setContextError(data.error || "读不到当前页面");
            }
        } catch (err) {
            targetPageRef.current = "";
            targetKindRef.current = "";
            setTarget(null);
            setWork(null);
            setContextError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingContext(false);
        }
    }, [bridgeBase]);

    /**
     * 整理画布：把 MochiAni 那边**撞在一起**的节点挪开。
     *
     * 发送时的自动摆布只管「刚发过去的这一批」，历史遗留的叠压得靠这个手动收。
     * 只挪真撞上的节点，别的保持原位。
     */
    const runTidy = useCallback(async () => {
        setTidying(true);
        try {
            const data = await bridgeFetch(bridgeBase, "/api/tidy", {
                method: "POST",
                body: JSON.stringify({ pageId: targetPageRef.current || undefined }),
            });
            if (!data.ok) {
                message.warning(data.error || "整理没成功");
                return;
            }
            const moved = Number(data.moved) || 0;
            message.success(moved ? `整理好了：挪开 ${moved} 个叠压节点` : "画布没有叠压，不用整理");
            void refreshContext();
        } catch (err) {
            message.warning(err instanceof Error ? err.message : String(err));
        } finally {
            setTidying(false);
        }
    }, [bridgeBase, refreshContext]);

    /** `params` / 参数缓存一变就同步镜像，供异步回读对齐时用。 */
    useEffect(() => {
        paramsRef.current = params;
        paramOptionsRef.current = paramOptions;
    }, [params, paramOptions]);

    /**
     * 向桥要「这套模型 / 渠道」真实的可调参数（含 `configInfo` 里没有的画幅）。
     *
     * 只影响面板自己的下拉与默认值；失败（页面挂起 / 面板没挂上）就静默退回 `configInfo`，
     * 不能因为读不到参数就把整个选择区变空。
     */
    const probeParams = useCallback(
        async (next: { modelKey?: string; channelId?: string; videoCategory: number | null }) => {
            const requestedModel = String(next.modelKey || "");
            const requestedChannel = String(next.channelId || "");
            // 什么都没指定就没得问（切生成模式时只给 videoCategory，那是合法的）
            if (!requestedModel && next.videoCategory == null) return;
            /**
             * 漫剧编辑器**没有**「视频节点面板」这东西：参数全在模型目录的 `configInfo` 里，
             * 桥的 `/api/params` 对它一律回 409 `NOT_CANVAS`。原本这里照打不误，每切一次模型
             * 就往控制台糊一条 409（一次发送能刷四五条）—— 这里直接不问了。
             */
            if (targetKindRef.current === "carton") return;
            /**
             * 命中缓存就直接本地对齐，不再打桥。
             *
             * 桥这一趟是**真去改 MochiAni 那个视频节点**的模型/渠道（画幅只能这么读），
             * 画布上有好几个节点时每个都问一遍会把对面节点来回切 —— 能复用就复用。
             */
            const cacheKey = requestedModel ? `${requestedModel}|${requestedChannel}` : "";
            const cachedOptions = cacheKey ? paramOptionsRef.current[cacheKey] : undefined;
            if (cachedOptions && Object.keys(cachedOptions).length) {
                const cachedAligned = alignToOptions(paramsRef.current, cachedOptions, aspectRatio);
                if (JSON.stringify(cachedAligned) !== JSON.stringify(paramsRef.current)) {
                    paramsRef.current = cachedAligned;
                    setParams(cachedAligned);
                    saveConfig({ modelKey: requestedModel, channelId: requestedChannel, params: cachedAligned });
                }
                return;
            }
            const query = new URLSearchParams();
            const pinnedPage = targetPageRef.current;
            if (pinnedPage) query.set("pageId", pinnedPage);
            if (requestedModel) query.set("modelKey", requestedModel);
            if (requestedChannel) query.set("channelId", requestedChannel);
            if (next.videoCategory != null) query.set("videoCategory", String(next.videoCategory));
            setParamsProbing(true);
            try {
                const data = await bridgeFetch(bridgeBase, `/api/params?${query.toString()}`);
                if (!data?.ok || !data.options) return;
                const options = data.options as Record<string, ParamOption[]>;
                if (!Object.keys(options).length) return;
                // 桥可能没切成功（仍停在原组合）—— 一律以它回传的「真实落点」为准。
                const settledModel = String(data.modelKey || requestedModel);
                const settledChannel = String(data.channelId ?? requestedChannel ?? "");
                if (settledModel) {
                    setParamOptions((prev) => ({ ...prev, [`${settledModel}|${settledChannel}`]: options }));
                }
                /*
                 * 没强指定模型（就是「换生成模式」那条路）时，以页面真实切到的模型 / 渠道为准 ——
                 * MochiAni 的模式和模型是绑定的，强行把旧模型按回去只会跟模式打架。
                 */
                if (!requestedModel && settledModel) setModelKey(settledModel);
                if (!requestedChannel && settledChannel) setChannelId(settledChannel);
                const aligned = alignToOptions(paramsRef.current, options, aspectRatio);
                paramsRef.current = aligned;
                setParams(aligned);
                if (settledModel) saveConfig({ modelKey: settledModel, channelId: settledChannel, params: aligned });
                if (data.activeVideoCategory != null && Number(data.activeVideoCategory) !== next.videoCategory) {
                    setVideoCategory(Number(data.activeVideoCategory));
                }
            } catch {
                // 读不到参数不算错：面板继续用 configInfo 那套（只是没有画幅）
            } finally {
                setParamsProbing(false);
            }
        },
        [bridgeBase, aspectRatio, saveConfig],
    );

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
                /**
                 * 顺手把「节点当前那套」的完整参数表存进缓存（`/api/models` 已经带回来了）。
                 * 命中就不用再问一次 `/api/params` —— 而且这是**唯一**带画幅的免费来源。
                 */
                const panelOptions = data.panel?.editableParameters;
                if (data.panel?.modelKey && panelOptions && Object.keys(panelOptions).length) {
                    const panelKey = `${data.panel.modelKey}|${data.panel.channelId || ""}`;
                    setParamOptions((prev) => ({ ...prev, [panelKey]: panelOptions }));
                }
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
                /**
                 * ⚠️ 画布模式下 `panel` 是「MochiAni 自己画布上那个视频节点」的现状（桥拿它读模型目录），
                 * **不是**我们的偏好。要是把它当成默认值，用户指定的「2.0 fast / AL」永远被对面节点的
                 * 现状带跑 —— 所以只有「漫剧编辑器给了 current」或者「节点自己存过配置」时才跟随。
                 */
                const adoptPanel = Boolean(savedModelKey) || Boolean(data.current?.modelKey);
                // 没有偏好时的默认模型：Seedance2.0 fast（用户指定）。再往下一级才是「生成模式那一类」。
                const preferredModel = adoptPanel ? null : pickPreferredModel(list);
                const nextModel =
                    (savedModelKey ? list.find((item) => item.modelKey === savedModelKey) : undefined) ||
                    preferredModel ||
                    (hasSpecificType && savedCategory != null ? list.find((item) => item.specificType === savedCategory) : undefined) ||
                    (adoptPanel ? list.find((item) => item.modelKey === preferKey) : undefined) ||
                    list.find((item) => modelKindInfo(item).key === "video") ||
                    list[0];
                if (!nextModel) return;
                if (hasSpecificType && savedCategory != null && nextModel.specificType != null && nextModel.specificType !== savedCategory) {
                    // 存过的模型不属于所选模式：以模型为准，别偷偷换。
                    setVideoCategory(nextModel.specificType);
                }
                const preferChannel = preferred?.channelId || data.current?.channelId || (adoptPanel ? data.panel?.channelId || "" : "");
                // 渠道没偏好时落到「AL」（用户指定的默认渠道），而不是死板的第一个。
                const nextChannel = nextModel.channels?.find((item) => item.id === preferChannel) || pickPreferredChannel(nextModel) || nextModel.channels?.[0];
                const baseParams =
                    preferred?.params && Object.keys(preferred.params).length
                        ? { ...preferred.params }
                        : adoptPanel && preferKey === nextModel.modelKey && data.current?.params && Object.keys(data.current.params).length
                          ? { ...data.current.params }
                          : adoptPanel && preferKey === nextModel.modelKey && data.panel?.configParams && Object.keys(data.panel.configParams).length
                            ? { ...data.panel.configParams }
                            : preferredParams(nextModel, nextChannel || undefined, aspectRatio);
                /** 有缓存就当场对齐（把 `configInfo` 缺的画幅补上）；没缓存先用 `configInfo` 那套顶着。 */
                const cached = paramOptionsRef.current[`${nextModel.modelKey}|${nextChannel?.id || ""}`];
                const nextParams = cached ? alignToOptions(baseParams, cached, aspectRatio) : baseParams;
                setModelKey(nextModel.modelKey);
                setChannelId(nextChannel?.id || "");
                paramsRef.current = nextParams;
                setParams(nextParams);
                saveConfig({
                    modelKey: nextModel.modelKey,
                    channelId: nextChannel?.id || "",
                    params: nextParams,
                    ...(hasSpecificType && savedCategory != null && nextModel.specificType != null ? { videoCategory: nextModel.specificType } : {}),
                });
                /**
                 * 参数表以桥回读的为准 —— `configInfo` 里没有画幅（`Seedance2.0 fast` 的 AL 线路、
                 * `Wan3.0` 的阿里云线路都这样），不问一遍就永远少一个下拉。不阻塞首屏。
                 */
                void probeParams({
                    modelKey: nextModel.modelKey,
                    channelId: nextChannel?.id || "",
                    videoCategory: typeof savedCategory === "number" ? savedCategory : null,
                });
            } catch (err) {
                setModels([]);
                setModelsError(err instanceof Error ? err.message : String(err));
            } finally {
                setModelsLoading(false);
            }
        },
        [bridgeBase, saveConfig, videoCategory, aspectRatio, probeParams],
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

    /**
     * 参数选项：桥回读的**权威表**优先（只有它带画幅），其次渠道 `configInfo`，最后模型 `configInfo`。
     *
     * ⚠️ 别把顺序倒过来：`configInfo` 少了画幅这一类「挂在模型上」的参数，
     * 让它优先就等于把画幅下拉永久藏掉（这正是 `2.0fast` 丢画幅的老 bug）。
     */
    const paramSource = useMemo(() => {
        const probed = paramOptions[`${modelKey}|${channelId}`];
        if (probed && Object.keys(probed).length) return probed;
        const channelConfig = selectedChannel?.configInfo;
        if (channelConfig && Object.keys(channelConfig).length) return channelConfig;
        return selectedModel?.configInfo || {};
    }, [paramOptions, modelKey, channelId, selectedChannel, selectedModel]);

    /** 这套参数里哪个键是画幅；空串 = 当前渠道不给画幅（比如 `Seedance2.0 fast` 的 AL 线路）。 */
    const aspectRatioKey = useMemo(() => aspectRatioKeyOf(paramSource), [paramSource]);

    const imageLimit = selectedModel?.mediaLimits?.image?.max ?? 9;
    const imageRequired = selectedModel?.mediaLimits?.image?.required ?? 0;
    /**
     * 视频 / 音频上限。`null` = 模型压根没上报（未知，不拦）；`0` = 明确不支持（不发）。
     *
     * 🔴 以前 `?? 0` 把两者混成一个 0，而 `pick` 又把 0 当「不限」—— 结果不支持参考视频的模型
     * 也会把视频硬塞进去，白传一遍再被 MochiAni 的端口拒掉。
     */
    const videoLimit = typeof selectedModel?.mediaLimits?.video?.max === "number" ? selectedModel.mediaLimits.video.max : null;
    const audioLimit = typeof selectedModel?.mediaLimits?.audio?.max === "number" ? selectedModel.mediaLimits.audio.max : null;

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
        const kindLabel = { image: "参考图", video: "参考视频", audio: "参考音频" } as const;
        const pick = async (list: CanvasResourceReference[], limit: number | null, kind: "image" | "video" | "audio") => {
            const out: Array<{ url?: string; dataUrl?: string }> = [];
            // 明确 0 = 这个模型/渠道不吃这种素材；null = 没上报，当未知照发。
            if (limit === 0) {
                for (const reference of list) unusable.push(`${reference.title || reference.label}：当前模型不支持${kindLabel[kind]}，没发`);
                return out;
            }
            /**
             * 本地图（`blob:`）发之前必须先读成 dataUrl，一张几 MB —— 以前 `for + await` 串行，
             * 连 9 张就得排队读 9 遍。这里并发读，再**按原顺序**拼（顺序 = 文案里 `@图片N` 的下标）。
             */
            const resolved = await Promise.all(
                list.map(async (reference) => ({
                    reference,
                    entry: await toReferencePayload(reference, kind).catch(() => null),
                })),
            );
            for (const { reference, entry } of resolved) {
                if (!entry) {
                    unusable.push(`${reference.title || reference.label} 读不出来（本地缓存已失效），重新上传一次`);
                    continue;
                }
                if (limit != null && limit > 0 && out.length >= limit) {
                    unusable.push(`${reference.title || reference.label} 超过上限，没发`);
                    continue;
                }
                out.push(entry);
            }
            return out;
        };
        const images = await pick(linkedByKind.image, imageLimit, "image");
        // 面板里直接上传的参考图也是本地 dataUrl，跟连线图一样要先减重（并发压，顺序不变）
        const shrunkRefs = await shrinkImageDataUrls(refImages.map((item) => item.dataUrl));
        refImages.forEach((item, index) => {
            if (imageLimit > 0 && images.length >= imageLimit) {
                unusable.push(`${item.name} 超过参考图上限，没发`);
                return;
            }
            images.push({ dataUrl: shrunkRefs[index] || item.dataUrl });
        });
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
     * - 同名不同 id 的模型仍带 `#id` 后缀（MochiAni 确实有这种）；
     * - 常用的那两个（Seedance2.0 fast / wan3.0）标绿，几十个模型里一眼能挑到。
     */
    const recommendedKeys = useMemo(() => recommendedModelKeys(models), [models]);
    const recommendedColor = RECOMMENDED_MODEL_COLOR[themeMode] || RECOMMENDED_MODEL_COLOR.dark;

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
        // 换模型也守「默认渠道 = 原厂线路」：有 AL 走 AL，Wan 系走阿里云，都没有才落第一条。
        const nextChannel = pickPreferredChannel(next) || next?.channels?.[0];
        const cached = paramOptions[`${value}|${nextChannel?.id || ""}`];
        const baseParams = next ? { ...preferredParams(next, nextChannel || undefined, aspectRatio), ...aspectOnly(params) } : {};
        const nextParams = cached ? alignToOptions(baseParams, cached, aspectRatio) : baseParams;
        setModelKey(value);
        setChannelId(nextChannel?.id || "");
        paramsRef.current = nextParams;
        setParams(nextParams);
        saveConfig({ modelKey: value, channelId: nextChannel?.id || "", params: nextParams });
        const nextMax = next?.mediaLimits?.image?.max ?? 9;
        setRefImages((prev) => prev.slice(0, nextMax));
        void probeParams({ modelKey: value, channelId: nextChannel?.id || "", videoCategory });
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
            /*
             * 画布模式下「生成模式」是独立开关，但它跟模型是绑定的：切模式会让页面自己换模型。
             * 所以这里**不指定模型/渠道**，让桥切完模式后把真实落点回传，面板跟着走
             * （强行把旧模型按回去只会跟模式打架）。
             */
            void probeParams({ videoCategory: value });
            return;
        }
        const hit = models.find((item) => item.specificType === value);
        if (!hit) {
            saveConfig({ videoCategory: value });
            return;
        }
        const nextChannel = pickPreferredChannel(hit) || hit.channels?.[0];
        const cached = paramOptions[`${hit.modelKey}|${nextChannel?.id || ""}`];
        const baseParams = preferredParams(hit, nextChannel || undefined, aspectRatio);
        const nextParams = cached ? alignToOptions(baseParams, cached, aspectRatio) : baseParams;
        setModelKey(hit.modelKey);
        setChannelId(nextChannel?.id || "");
        paramsRef.current = nextParams;
        setParams(nextParams);
        saveConfig({ videoCategory: value, modelKey: hit.modelKey, channelId: nextChannel?.id || "", params: nextParams });
        void probeParams({ modelKey: hit.modelKey, channelId: nextChannel?.id || "", videoCategory: value });
    };

    const changeChannel = (value: string) => {
        const next = selectedModel?.channels?.find((item) => item.id === value);
        setChannelId(value);
        if (!next || !selectedModel) {
            saveConfig({ modelKey, channelId: value, params });
            return;
        }
        const cached = paramOptions[`${modelKey}|${value}`];
        const baseParams = { ...preferredParams(selectedModel, next, aspectRatio), ...aspectOnly(params) };
        const nextParams = cached ? alignToOptions(baseParams, cached, aspectRatio) : baseParams;
        paramsRef.current = nextParams;
        setParams(nextParams);
        saveConfig({ modelKey, channelId: value, params: nextParams });
        void probeParams({ modelKey, channelId: value, videoCategory });
    };

    const changeParam = (key: string, value: string) => {
        const nextParams = { ...params, [key]: value };
        setParams(nextParams);
        // 画幅参数被手动改过 → 记住这份偏好，之后换到同样带画幅参数的渠道能自动带上。
        if ((ASPECT_RATIO_KEYS as readonly string[]).includes(key)) {
            setAspectRatio(value);
            saveConfig({ modelKey, channelId, params: nextParams, aspectRatio: value });
            return;
        }
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
     * 预检。`promptOverride` 由提示词面板的主按钮（文案「生成」）传进来，避免 state 落后一帧。
     *
     * 风格模板与视频节点同一条路：`composeStyledPrompt` 只在**发出去的那一版**提示词尾部追加，
     * metadata 里存的仍是干净正文（幂等，重复预检不会叠第二遍）。
     *
     * `options.autoConfirm` = 一键生成：把这次任务的 id 挂进 `autoConfirmJobIds`，
     * 等它走到 `ready` 时下面的 effect 会自动调确认生成。返回值 = 预检有没有真的发出去。
     */
    const runPlan = async (promptOverride?: string, options?: { autoConfirm?: boolean }) => {
        const base = (promptOverride ?? prompt).trim();
        if (!base) {
            message.warning("先写提示词");
            return false;
        }
        if (!healthOk || !target) {
            message.warning("先连上本机桥并读到 MochiAni 页面（点右上角「刷新」）");
            return false;
        }
        // 桥 1.6.8 起预检是「先回任务、后台算」，期间再点会排第二个预检（白建一遍素材）。
        if (job?.stage === "planning") {
            message.warning("上一次预检还在跑，进度看下面的日志（每 3 秒刷一次）");
            return false;
        }
        const styleTemplate = getStyleTemplate(node.metadata?.styleTemplateId);
        const text = composeStyledPrompt(base, styleTemplate ? buildStylePromptText(styleTemplate) : "", "");
        const media = await collectMediaPayload();
        // 漫剧编辑器的参考素材来自作品素材库（人物/场景/道具），不走上传，别拿 imageRequired 拦它。
        if (!isCarton && imageRequired && media.images.length < imageRequired) {
            message.warning(`这个模型至少要 ${imageRequired} 张参考图（现在 ${media.images.length} 张）`);
            return false;
        }
        if (media.unusable.length) message.warning(media.unusable.slice(0, 2).join("；"));
        /**
         * 一起发给桥的图，两种来源：
         *  a) 面板「出场素材」里填了名字 + 画布上有同名图片（`kind` = characters/scenes/props）；
         *  b) 连线进来的图片**节点标题就是素材名**（`kind: "auto"`，零填写 —— 标题是「图片1」这种没语义的会被桥丢掉）。
         * 桥在素材建好 / 匹配到真 ID 之后按 assetId 上传。
         */
        const castImages: Array<{ kind: string; name: string; index?: number; url?: string; dataUrl?: string }> = [];
        if (isCarton) {
            for (const field of CARTON_CAST_FIELDS) {
                for (const name of castNames(field.key)) {
                    const reference = matchCastImage(name);
                    const payload = reference ? await toReferencePayload(reference, "image") : null;
                    if (payload) castImages.push({ kind: field.key, name, ...payload });
                }
            }
            // `media.images` 的前 N 个就是连线图片（顺序与 linkedByKind.image 一致），后面才是手动上传的图
            for (let index = 0; index < media.images.length; index += 1) {
                const reference = linkedByKind.image[index];
                if (!reference) break;
                const title = String(reference.title || reference.label || "").trim();
                if (!title) continue;
                if (castImages.some((item) => item.name === title)) continue;
                castImages.push({ kind: "auto", name: title, index, ...media.images[index] });
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
                if (options?.autoConfirm) autoConfirmJobIds.add(data.job.id);
                // 后台预检：job.stage = "planning"，下面的轮询会把日志一点点补上。
                if (data.pending) message.info("预检已开始，进度在下面日志里（建素材 / 传图比较慢）");
                if (!data.ok) setError(data.error || "预检没有通过");
            } else {
                setError(data.error || "预检失败");
                return false;
            }
            void refreshContext();
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return false;
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

    /**
     * 一键生成 = 预检 + 确认生成。
     *
     * 三个入口共用它：提示词面板的主按钮（文案「生成」）、底部操作行的「生成」、
     * 以及「已预检过」时的二次点击。已经预检过（`ready`）就**不再重复预检**（预检会在
     * MochiAni 里白建一遍素材、白传一遍图），直接确认；其余情况先预检，成功后交给
     * `autoConfirmJobIds` 的半截 effect 自动确认。
     *
     * ⚠️ 不在这里判余额：确认那一步桥会拒，且 `notEnoughPoints` 的提示已经挂在确认前，
     *    两处都判会变成「点了没反应」。
     */
    const handleGenerate = async (promptOverride?: string) => {
        if (job && ["submitting", "generating"].includes(jobStage)) {
            message.info("已经在生成了，别重复下单");
            return;
        }
        if (job && job.stage === "ready") {
            await runConfirm();
            return;
        }
        await runPlan(promptOverride, { autoConfirm: true });
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
            const nodeId = await onCreateVideo(job.videoUrl, job.prompt, { hostNodeId: node.id });
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

    /**
     * 一键生成的第 2 段：预检一走到 `ready` 就自动确认。
     *
     * 只认 `autoConfirmJobIds` 里登记过的任务 —— 手动点「预检（不花钱）」的任何一步都不会
     * 自动扣灵点。余额不够就把意图撤掉并提示，绝不让用户以为「点了就生成」结果静默失败。
     */
    useEffect(() => {
        if (!job) return;
        if (!autoConfirmJobIds.has(job.id)) return;
        if (job.stage === "ready") {
            autoConfirmJobIds.delete(job.id);
            if (notEnoughPoints) {
                message.warning(`余额 ${points?.total ?? "?"} 灵点，不够预估的 ${estimatePoints} 灵点 —— 先充值`);
                return;
            }
            void runConfirm();
            return;
        }
        if (["blocked", "error", "cancelled", "done"].includes(job.stage)) autoConfirmJobIds.delete(job.id);
        // `runConfirm` 每次渲染都是新函数，塞进依赖等于每 3 秒轮询都重跑一次；靠 job 变化驱动就够了
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [job, notEnoughPoints]);

    /** 预览区空态：没片子的时候显示「在跑什么 / 该点什么」。 */
    const waitSeconds = useElapsedSeconds(["planning", "submitting", "generating"].includes(jobStage), node.id);
    const previewHint = (() => {
        if (jobStage === "planning") {
            return { icon: <Loader2 size={18} className="animate-spin opacity-60" />, text: `预检中 · 已等 ${formatWaitTime(waitSeconds)}`, color: theme.node.placeholder };
        }
        if (jobStage === "submitting") {
            return { icon: <Loader2 size={18} className="animate-spin opacity-60" />, text: `已下发，等 MochiAni 接单 · 已等 ${formatWaitTime(waitSeconds)}`, color: theme.node.placeholder };
        }
        if (jobStage === "generating") {
            return { icon: <Loader2 size={18} className="animate-spin opacity-60" />, text: `生成中 · 已等 ${formatWaitTime(waitSeconds)}`, color: theme.node.placeholder };
        }
        if (jobStage === "ready") {
            return {
                icon: <Play size={18} style={{ color: "#4ade80" }} />,
                text: `预检通过${estimatePoints != null ? ` · 预估 ${estimatePoints} 灵点` : ""}，点「生成」开始`,
                color: theme.node.placeholder,
            };
        }
        if (jobStage === "blocked") return { icon: <CircleAlert size={18} style={{ color: "#fbbf24" }} />, text: "预检没通过 —— 原因看下面的任务状态", color: "#fbbf24" };
        if (jobStage === "error") return { icon: <CircleAlert size={18} style={{ color: "#f87171" }} />, text: "这次没成 —— 原因看下面的任务状态", color: "#f87171" };
        if (jobStage === "cancelled") return { icon: <Video size={18} className="opacity-40" />, text: "已停止，可以重新生成一版", color: theme.node.placeholder };
        return { icon: <Video size={18} className="opacity-40" />, text: "生成完成后在这里预览（也能「放到画布」变成视频节点）", color: theme.node.placeholder };
    })();
    const jobVideoUrl = job?.videoUrl || "";
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
                {/* 漫剧编辑器没有「画布节点」这回事，「整理」只在无限画布下出现 */}
                {isCarton ? null : (
                    <button
                        type="button"
                        onClick={() => {
                            if (!healthOk) {
                                message.warning("本机桥还没连上，先点「刷新」确认桥在跑");
                                return;
                            }
                            void runTidy();
                        }}
                        className="flex items-center gap-1 text-[11px] transition hover:opacity-100"
                        style={{
                            opacity: tidying || !healthOk ? 0.35 : 0.6,
                            cursor: tidying || !healthOk ? "not-allowed" : "pointer",
                        }}
                        aria-disabled={tidying || !healthOk}
                        title="把 MochiAni 画布上撞在一起的节点挪开（只动真叠压的）"
                    >
                        {tidying ? <Loader2 size={11} className="animate-spin" /> : <LayoutGrid size={11} />} 整理
                    </button>
                )}
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

            {/* ①.5 视频预览：跟视频节点的内容区一个意思 —— 成片直接在这个窗口里看，
                   不必先「放到画布」；没片子时留一块空态，顺手把「现在在跑什么」写清楚。 */}
            <div className="relative shrink-0 overflow-hidden rounded-md" style={jobVideoUrl ? { border: softBorder, background: "#000" } : undefined}>
                {jobVideoUrl ? (
                    <>
                        <video
                            key={jobVideoUrl}
                            src={jobVideoUrl}
                            controls
                            playsInline
                            preload="metadata"
                            className="block w-full"
                            style={{ maxHeight: 300, background: "#000" }}
                            data-canvas-no-zoom
                        />
                        <a
                            href={jobVideoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/85 backdrop-blur transition hover:text-white"
                            title="在新标签页打开原片（可另存 / 可拿到别的工具里用）"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <ExternalLink size={10} /> 原片
                        </a>
                    </>
                ) : (
                    <div
                        className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 text-center"
                        style={{ borderColor: theme.node.stroke, minHeight: 84, color: previewHint.color }}
                    >
                        {previewHint.icon}
                        <span className="text-[11px] leading-snug opacity-80">{previewHint.text}</span>
                    </div>
                )}
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
                            /* 常用模型标绿：`label` 保持纯字符串（搜索靠它），只在渲染那层套颜色。 */
                            optionRender={(option) => {
                                const text = String(option.label ?? "");
                                return recommendedKeys.has(String(option.value)) ? (
                                    <span style={{ color: recommendedColor }}>{text}</span>
                                ) : (
                                    <>{text}</>
                                );
                            }}
                            labelRender={({ label, value }) =>
                                recommendedKeys.has(String(value)) ? <span style={{ color: recommendedColor }}>{label}</span> : <>{label}</>
                            }
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
                        {/* 画幅：渠道不给画幅参数时**不放假下拉**，只把当前偏好说清楚。
                            注意「有没有画幅」以桥回读的权威参数表为准 —— `configInfo` 里没有不代表模型没有
                            （`2.0fast` / `Wan3.0` 的画幅挂在模型的 `modelSize` 上），所以回读期间不下结论。 */}
                        {selectedModel && !aspectRatioKey && !isCarton ? (
                            <div className="text-[10px] opacity-45" title="这条渠道没有画幅参数，比例由首张参考图（或模型默认）决定">
                                {paramsProbing ? "正在读取这条线路的参数…" : `画幅 ${aspectRatio} · 当前渠道没有画幅参数，比例跟首张参考图走`}
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
                                <div className="text-[10px] leading-snug opacity-40">
                                    这里不用填也行：把连进来的图片节点标题改成角色/场景/道具名，桥会按标题自动建素材并挂图；
                                    或在提示词里写「@图片1 为男主」。
                                </div>
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
                                不填就只发提示词，出场人物 / 场景 / 道具交给 MochiAni 按分镜自己解析；
                                连线图片的节点标题是角色/场景/道具名时，桥按标题自动建素材并挂图。
                            </div>
                        )}
                    </div>
                ) : null}

                {/* ④ 提示词 —— 直接复用视频节点的提示词面板（内嵌形态）：
                       @ 引用 chip（图 / 视频 / 音频 / 文案）+ 风格模板 + 主按钮＝生成（预检 → 自动确认）。
                       与视频窗口的唯一差别是这里没有模型/参数行（模型目录来自桥）和排期。 */}
                <div className="rounded-md px-1.5 py-1.5" style={{ border: softBorder }}>
                    <CanvasNodePromptPanel
                        embedded
                        hideModelRow
                        hideSchedule
                        allowSubmitWhileRunning={false}
                        generateLabel="生成"
                        modeOverride="video"
                        node={node}
                        isRunning={panelRunning}
                        mentionReferences={references || []}
                        onPromptChange={handlePromptChange}
                        onConfigChange={(nodeId, patch) => onConfigChange(nodeId, patch as Partial<CanvasNodeMetadata>)}
                        onGenerate={(_nodeId, _mode, text) => void handleGenerate(text)}
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
                {jobStage === "planning" ? (
                    <Button size="small" type="primary" loading disabled>
                        预检中…
                    </Button>
                ) : null}
                {/* 「生成」= 预检 + 确认生成一键走完；已经预检过就直接确认，不再重跑预检。 */}
                {!job || ["error", "cancelled", "blocked"].includes(jobStage) ? (
                    <>
                        <Button
                            size="small"
                            icon={<Sparkles size={13} />}
                            loading={busy === "plan"}
                            onClick={() => void runPlan()}
                            disabled={!healthOk || !target}
                            title="只做预检：连页面、建素材、算预估灵点，不花钱"
                        >
                            预检（不花钱）
                        </Button>
                        <Button
                            size="small"
                            type="primary"
                            icon={<Play size={13} />}
                            loading={busy === "plan" || busy === "confirm"}
                            onClick={() => void handleGenerate()}
                            disabled={!healthOk || !target}
                            title="预检通过后自动确认生成（会扣灵点）"
                        >
                            生成
                        </Button>
                    </>
                ) : null}
                {job && jobStage === "ready" ? (
                    <Button
                        size="small"
                        type="primary"
                        danger
                        icon={<Play size={13} />}
                        loading={busy === "confirm"}
                        onClick={() => void handleGenerate()}
                        title="确认生成（扣灵点）"
                    >
                        生成（扣灵点）
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
