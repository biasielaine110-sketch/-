import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Select, Tag, Upload } from "antd";
import {
    CircleAlert,
    CircleCheck,
    Clapperboard,
    Coins,
    ImagePlus,
    Loader2,
    PlugZap,
    RefreshCw,
    Sparkles,
    Wrench,
    X,
} from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

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
    imageCount: number;
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
    configInfo?: Record<string, ParamOption[]>;
};

type ModelOption = {
    modelId: string;
    modelKey: string;
    modelName: string;
    configInfo?: Record<string, ParamOption[]>;
    mediaLimits?: { image?: { required?: number; max?: number }; video?: { max?: number }; audio?: { max?: number } };
    channels?: ModelChannel[];
};

type RefImage = { uid: string; name: string; dataUrl: string };

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
    panel?: { modelKey?: string; channelId?: string; configParams?: Record<string, string> } | null;
};

type Props = {
    node: CanvasNodeData;
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

export function CanvasMochianiNodeContent({ node, onCreateVideo, onConfigChange }: Props) {
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

    const [prompt, setPrompt] = useState(node.metadata?.mochianiPrompt || "");
    const [refImages, setRefImages] = useState<RefImage[]>([]);
    const [job, setJob] = useState<MochianiJob | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [placedNodeId, setPlacedNodeId] = useState("");

    const pollingRef = useRef<number | null>(null);
    const lastSnapshotRef = useRef("");
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
                setTarget(data.target);
                setWork(data.work || null);
                setContextError("");
                const acc = await bridgeFetch(bridgeBase, "/api/account").catch(() => null);
                setPoints(acc?.ok ? acc.points || null : null);
                setAccountUser(acc?.ok ? acc.user || "" : "");
            } else {
                setTarget(null);
                setWork(null);
                setPoints(null);
                setContextError(data.error || "读不到当前页面");
            }
        } catch (err) {
            setTarget(null);
            setWork(null);
            setContextError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingContext(false);
        }
    }, [bridgeBase]);

    const loadModels = useCallback(
        async (preferred?: { modelKey?: string; channelId?: string; params?: Record<string, string> }) => {
            setModelsLoading(true);
            try {
                const data = await bridgeFetch(bridgeBase, "/api/models");
                if (!data.ok) {
                    setModels([]);
                    setModelsError(data.error || "读不到模型目录");
                    return;
                }
                const list = Array.isArray(data.models) ? data.models : [];
                setModels(list);
                setModelsError("");
                const preferKey = preferred?.modelKey || data.panel?.modelKey || "";
                const nextModel = list.find((item) => item.modelKey === preferKey) || list[0];
                if (!nextModel) return;
                const preferChannel = preferred?.channelId || data.panel?.channelId || "";
                const nextChannel = nextModel.channels?.find((item) => item.id === preferChannel) || nextModel.channels?.[0];
                const nextParams =
                    preferred?.params && Object.keys(preferred.params).length
                        ? { ...preferred.params }
                        : preferKey === nextModel.modelKey && data.panel?.configParams && Object.keys(data.panel.configParams).length
                          ? { ...data.panel.configParams }
                          : defaultParams(nextModel, nextChannel);
                setModelKey(nextModel.modelKey);
                setChannelId(nextChannel?.id || "");
                setParams(nextParams);
                patchMetadata({ mochianiConfig: { modelKey: nextModel.modelKey, channelId: nextChannel?.id || "", params: nextParams } });
            } catch (err) {
                setModels([]);
                setModelsError(err instanceof Error ? err.message : String(err));
            } finally {
                setModelsLoading(false);
            }
        },
        [bridgeBase, patchMetadata],
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

    const modelOptions = useMemo(() => {
        const counter = new Map<string, number>();
        for (const item of models) counter.set(item.modelName, (counter.get(item.modelName) || 0) + 1);
        return models.map((item) => ({
            value: item.modelKey,
            label: (counter.get(item.modelName) || 0) > 1 ? `${item.modelName} · #${item.modelId}` : item.modelName,
        }));
    }, [models]);

    const changeModel = (value: string) => {
        const next = models.find((item) => item.modelKey === value) || null;
        const nextChannel = next?.channels?.[0];
        const nextParams = defaultParams(next ?? { modelId: "", modelKey: "", modelName: "" }, nextChannel);
        setModelKey(value);
        setChannelId(nextChannel?.id || "");
        setParams(nextParams);
        patchMetadata({ mochianiConfig: { modelKey: value, channelId: nextChannel?.id || "", params: nextParams } });
        const nextMax = next?.mediaLimits?.image?.max ?? 9;
        setRefImages((prev) => prev.slice(0, nextMax));
    };

    const changeChannel = (value: string) => {
        const next = selectedModel?.channels?.find((item) => item.id === value);
        setChannelId(value);
        if (!next) {
            patchMetadata({ mochianiConfig: { modelKey, channelId: value, params } });
            return;
        }
        const nextParams = defaultParams(selectedModel as ModelOption, next);
        setParams(nextParams);
        patchMetadata({ mochianiConfig: { modelKey, channelId: value, params: nextParams } });
    };

    const changeParam = (key: string, value: string) => {
        const nextParams = { ...params, [key]: value };
        setParams(nextParams);
        patchMetadata({ mochianiConfig: { modelKey, channelId, params: nextParams } });
    };

    const addImages = async (files: File[]) => {
        if (!files.length) return;
        const room = Math.max(0, imageLimit - refImages.length);
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

    const runPlan = async () => {
        const text = prompt.trim();
        if (!text) {
            message.warning("先写提示词");
            return;
        }
        if (imageRequired && refImages.length < imageRequired) {
            message.warning(`这个模型至少要 ${imageRequired} 张参考图`);
            return;
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
                    images: refImages.map((item) => ({ dataUrl: item.dataUrl })),
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
                            onClick={() => void loadModels({ modelKey, channelId, params })}
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
                        <Select
                            size="small"
                            placeholder="选择渠道"
                            value={channelId || undefined}
                            style={{ width: "100%" }}
                            options={(selectedModel?.channels || []).map((item) => ({
                                value: item.id,
                                label: `${item.name}${item.avgTime ? ` · ${item.avgTime}s` : ""}`,
                            }))}
                            onChange={changeChannel}
                            disabled={locked || !selectedModel}
                        />
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
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* ④ 提示词 */}
                <Input.TextArea
                    value={prompt}
                    onChange={(event) => {
                        setPrompt(event.target.value);
                        patchMetadata({ mochianiPrompt: event.target.value });
                    }}
                    rows={3}
                    placeholder="例：一个穿雨衣的女孩在深夜便利店门口抬头看雨，霓虹反光，缓慢推镜"
                    disabled={locked}
                />

                {/* ⑤ 参考图 */}
                <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="opacity-55">参考图（可选）</span>
                        <span className="opacity-35">
                            {refImages.length}/{imageLimit}
                        </span>
                    </div>
                    <div className="flex flex-wrap items-start gap-1.5">
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
                        {refImages.length < imageLimit && !locked ? (
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
                </div>

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
                        type="primary"
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
