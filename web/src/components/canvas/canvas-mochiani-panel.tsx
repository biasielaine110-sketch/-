import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Select, Tag } from "antd";
import { CircleAlert, CircleCheck, Clapperboard, Coins, Loader2, PlugZap, RefreshCw, Sparkles } from "lucide-react";

/**
 * 画布里的「MochiAni 生视频」入口。
 *
 * 链路：画布输入指令 → 本机桥（tools/mochiani-bridge，127.0.0.1:17399）
 *      → MochiAni MCP（stdio）→ 在 MochiAni 画布里建视频节点、写提示词、预检费用、生成
 *      → 回传视频地址 → 落成画布视频节点。
 *
 * 花钱的闸门放在这里：`预检` 只读（但会在 MochiAni 画布上建一个空节点），
 * 点 `确认生成` 才开始扣 MochiAni 灵点。
 */

const BRIDGE_STORAGE_KEY = "infinite-atelier:mochiani-bridge";
const DEFAULT_BRIDGE = "http://127.0.0.1:17399";
const POLL_MS = 3000;

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
    work: { pageId: string; origin: string; siteName?: string; projectId?: string; workId?: string; workName?: string };
    preflight: unknown;
    estimate: JobEstimate | null;
    error: string;
    createdAt: string;
    updatedAt: string;
    log: Array<{ at: string; message: string }>;
};

type BridgeHealth = { ok: boolean; mcp?: { connected: boolean; lastError?: string } };

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

type MochianiTarget = MochianiPage & { workId: string };

type MochianiWork = {
    workId?: string;
    nodeCount?: number;
    revision?: string;
    projectId?: string;
    projectName?: string;
    workName?: string;
};

type PointSummary = { total?: string; common?: string; scoped?: string; label?: string };

type Props = {
    /** 由 project.tsx 注入：把视频地址落成画布节点，返回 nodeId */
    onCreateVideo: (videoUrl: string, prompt?: string) => Promise<string>;
};

function readBridgeBase() {
    try {
        return window.localStorage.getItem(BRIDGE_STORAGE_KEY) || DEFAULT_BRIDGE;
    } catch {
        return DEFAULT_BRIDGE;
    }
}

type BridgeBody = Record<string, unknown> & {
    ok?: boolean;
    error?: string;
    job?: MochianiJob;
    kind?: "canvas" | "carton";
    pages?: MochianiPage[];
    target?: MochianiTarget;
    work?: MochianiWork;
    points?: PointSummary | null;
    user?: string;
};

async function bridgeFetch(base: string, path: string, init?: RequestInit): Promise<BridgeBody> {
    const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    const text = await response.text();
    let data: Record<string, unknown> | null = null;
    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        data = null;
    }
    if (!data) throw new Error(text.slice(0, 300) || `桥接返回了非 JSON 内容（HTTP ${response.status}）`);
    return data as BridgeBody;
}

const STAGE_LABEL: Record<JobStage, string> = {
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

export function CanvasMochianiPanel({ onCreateVideo }: Props) {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [bridgeBase, setBridgeBase] = useState(readBridgeBase);
    const [health, setHealth] = useState<BridgeHealth | null>(null);
    const [healthError, setHealthError] = useState("");
    const [pages, setPages] = useState<MochianiPage[]>([]);
    const [target, setTarget] = useState<MochianiTarget | null>(null);
    const [work, setWork] = useState<MochianiWork | null>(null);
    const [points, setPoints] = useState<PointSummary | null>(null);
    const [accountUser, setAccountUser] = useState("");
    const [pageId, setPageId] = useState("");
    const [contextError, setContextError] = useState("");
    const [loadingContext, setLoadingContext] = useState(false);
    const [prompt, setPrompt] = useState("");
    const [job, setJob] = useState<MochianiJob | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [placedNodeId, setPlacedNodeId] = useState("");
    const pollingRef = useRef<number | null>(null);

    const stopPolling = useCallback(() => {
        if (pollingRef.current !== null) {
            window.clearInterval(pollingRef.current);
            pollingRef.current = null;
        }
    }, []);

    const refreshContext = useCallback(
        async (nextPageId?: string) => {
            setLoadingContext(true);
            try {
                const query = nextPageId ? `?pageId=${encodeURIComponent(nextPageId)}` : "";
                const data = await bridgeFetch(bridgeBase, `/api/context${query}`);
                setPages(Array.isArray(data.pages) ? data.pages : []);
                if (data.ok && data.target) {
                    setTarget(data.target);
                    setWork(data.work || null);
                    setPageId(data.target.pageId);
                    setContextError("");
                    const acc = await bridgeFetch(bridgeBase, `/api/account${query}`).catch(() => null);
                    if (acc?.ok) {
                        setPoints(acc.points || null);
                        setAccountUser(acc.user || "");
                    } else {
                        setPoints(null);
                        setAccountUser("");
                    }
                } else {
                    setTarget(null);
                    setWork(null);
                    setPoints(null);
                    setContextError(data.error || "读不到当前页面");
                }
            } catch (err) {
                setTarget(null);
                setWork(null);
                setPages([]);
                setContextError(err instanceof Error ? err.message : String(err));
            } finally {
                setLoadingContext(false);
            }
        },
        [bridgeBase],
    );

    const checkHealth = useCallback(async () => {
        try {
            const data = (await bridgeFetch(bridgeBase, "/health")) as BridgeHealth;
            setHealth(data);
            setHealthError("");
            return true;
        } catch (err) {
            setHealth(null);
            setHealthError(err instanceof Error ? `${err.message}｜先在本机跑 tools/mochiani-bridge（端口 17399）` : "连不上本机桥");
            return false;
        }
    }, [bridgeBase]);

    useEffect(() => {
        if (!open) return;
        void (async () => {
            const healthy = await checkHealth();
            if (healthy) await refreshContext();
        })();
        const timer = window.setInterval(() => void checkHealth(), 15000);
        return () => window.clearInterval(timer);
    }, [open, checkHealth, refreshContext]);

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

    const runPlan = async () => {
        const text = prompt.trim();
        if (!text) {
            message.warning("先写一句指令");
            return;
        }
        setBusy("plan");
        setError("");
        setPlacedNodeId("");
        try {
            const data = await bridgeFetch(bridgeBase, "/api/plan", {
                method: "POST",
                body: JSON.stringify({ prompt: text, pageId: pageId || undefined }),
            });
            if (data.job) {
                setJob(data.job);
                if (!data.ok) setError(data.error || "预检没有通过");
            } else {
                setError(data.error || "预检失败");
            }
            void refreshContext(pageId || undefined);
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
    };

    const changeBridge = (value: string) => {
        const next = value.trim() || DEFAULT_BRIDGE;
        setBridgeBase(next);
        try {
            window.localStorage.setItem(BRIDGE_STORAGE_KEY, next);
        } catch {
            // localStorage 不可用就算了
        }
    };

    const connected = Boolean(health?.ok && health?.mcp?.connected);
    const usablePages = useMemo(() => pages.filter((item) => item.canGenerate), [pages]);
    const balance = Number(points?.total ?? NaN);
    const estimatePoints = job?.estimate?.points ?? null;
    const notEnoughPoints = Number.isFinite(balance) && estimatePoints != null && balance < estimatePoints;
    const stageColor = useMemo(() => {
        if (jobStage === "done") return "success";
        if (jobStage === "error" || jobStage === "blocked") return "error";
        if (jobStage === "generating" || jobStage === "submitting" || jobStage === "planning") return "processing";
        return "default";
    }, [jobStage]);

    const targetLabel = target
        ? target.kind === "carton" && work?.workName
            ? `${KIND_LABEL.carton} · ${work.workName}`
            : `${KIND_LABEL[target.kind] || target.siteName}${
                  target.kind === "canvas" && work?.nodeCount != null ? ` · ${work.nodeCount} 个节点` : ""
              }`
        : "";

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title="MochiAni 生视频：写一句指令，用 MochiAni 灵点生成并落回画布"
                className="absolute bottom-24 right-6 z-30 flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium shadow-lg transition hover:brightness-110"
                style={{ background: "rgba(24,24,27,0.92)", borderColor: "rgba(255,255,255,0.16)", color: "#fafafa", backdropFilter: "blur(8px)" }}
            >
                <Clapperboard size={15} />
                MochiAni
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: connected ? "#22c55e" : "#71717a" }} />
            </button>

            <Modal
                open={open}
                onCancel={() => setOpen(false)}
                footer={null}
                width={580}
                destroyOnHidden={false}
                title={
                    <span className="flex items-center gap-2">
                        <Clapperboard size={16} /> MochiAni 生视频
                    </span>
                }
            >
                <div className="flex flex-col gap-3 text-sm">
                    <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                        <div className="flex items-center gap-1.5">
                            <PlugZap size={13} style={{ color: connected ? "#22c55e" : "#f59e0b" }} />
                            <span className="opacity-70">本机桥</span>
                            <Input
                                size="small"
                                value={bridgeBase}
                                onChange={(event) => setBridgeBase(event.target.value)}
                                onBlur={(event) => changeBridge(event.target.value)}
                                style={{ width: 178 }}
                            />
                        </div>
                        <div className="flex items-center gap-1.5 text-xs">
                            {healthError ? (
                                <span className="flex items-center gap-1" style={{ color: "#f87171" }}>
                                    <CircleAlert size={12} /> 连不上
                                </span>
                            ) : connected ? (
                                <span className="flex items-center gap-1" style={{ color: "#4ade80" }}>
                                    <CircleCheck size={12} /> MCP 已连接
                                </span>
                            ) : (
                                <span className="flex items-center gap-1 opacity-60">
                                    <Loader2 size={12} className="animate-spin" /> 检查中
                                </span>
                            )}
                        </div>
                    </div>

                    {healthError ? (
                        <div className="rounded-md px-2 py-1.5 text-xs leading-relaxed" style={{ background: "rgba(248,113,113,0.12)", color: "#fca5a5" }}>
                            {healthError}
                        </div>
                    ) : null}

                    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                        <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs opacity-60">生成目标</span>
                            <button
                                type="button"
                                onClick={() => void refreshContext(pageId || undefined)}
                                className="flex items-center gap-1 text-xs opacity-60 transition hover:opacity-100"
                                disabled={loadingContext}
                            >
                                {loadingContext ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} 刷新
                            </button>
                        </div>
                        {target ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                    {targetLabel}
                                </Tag>
                                {usablePages.length > 1 ? (
                                    <Select
                                        size="small"
                                        value={pageId}
                                        style={{ minWidth: 200 }}
                                        options={usablePages.map((item) => ({
                                            value: item.pageId,
                                            label: `${KIND_LABEL[item.kind] || item.siteName} · ${item.origin}`,
                                        }))}
                                        onChange={(value) => {
                                            setPageId(value);
                                            void refreshContext(value);
                                        }}
                                    />
                                ) : null}
                                <span className="flex items-center gap-1 opacity-70">
                                    <Coins size={11} />
                                    {points?.total != null ? `${points.label || "灵点"} ${points.total}` : "余额未读到"}
                                    {accountUser ? `（${accountUser}）` : ""}
                                </span>
                            </div>
                        ) : (
                            <div className="text-xs leading-relaxed" style={{ color: "#fbbf24" }}>
                                {contextError || "还没读到页面"}
                                <div className="mt-1 opacity-70">
                                    先在浏览器打开 mochiani.com 的无限画布或漫剧编辑器，再点右上角刷新连接。
                                </div>
                                {pages.length ? (
                                    <div className="mt-1 opacity-50">
                                        已连接：{pages.map((item) => `${KIND_LABEL[item.kind] || item.siteName}${item.canGenerate ? "" : "（不可生成）"}`).join("、")}
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="mb-1 text-xs opacity-60">
                            指令（会在 MochiAni 那边新建一个视频节点，提示词就是这段文字）
                        </div>
                        <Input.TextArea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            rows={4}
                            placeholder="例：一个穿雨衣的女孩在深夜便利店门口抬头看雨，霓虹反光，缓慢推镜"
                            disabled={Boolean(job) && ["planning", "submitting", "generating", "ready"].includes(jobStage)}
                        />
                    </div>

                    {job ? (
                        <div className="rounded-md border px-3 py-2" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                <Tag color={stageColor} style={{ marginInlineEnd: 0 }}>
                                    {STAGE_LABEL[job.stage] || job.stage}
                                </Tag>
                                {job.estimate?.points != null ? (
                                    <span className="flex items-center gap-1 opacity-80">
                                        <Coins size={11} />
                                        预估 {job.estimate.points} 灵点
                                        {job.estimate.isEstimate ? "（页面预估，非最终扣费）" : ""}
                                    </span>
                                ) : null}
                                {job.estimate?.labels && Object.keys(job.estimate.labels).length ? (
                                    <span className="opacity-50">{Object.values(job.estimate.labels).join(" / ")}</span>
                                ) : null}
                            </div>
                            {notEnoughPoints ? (
                                <div className="mt-1 text-xs" style={{ color: "#fbbf24" }}>
                                    余额 {points?.total} 灵点，不够这次预估的 {estimatePoints} 灵点 —— 下单会被 MochiAni 拒掉（「余额不足」），先去充值。
                                </div>
                            ) : null}
                            {job.log.length ? (
                                <div className="mt-1.5 max-h-24 overflow-auto text-[11px] leading-relaxed opacity-60">
                                    {job.log.slice(-6).map((item, index) => (
                                        <div key={`${item.at}-${index}`}>· {item.message}</div>
                                    ))}
                                </div>
                            ) : null}
                            {job.error ? (
                                <div className="mt-1.5 text-xs" style={{ color: "#fca5a5" }}>
                                    {job.error}
                                </div>
                            ) : null}
                            {job.videoUrl ? <video src={job.videoUrl} controls className="mt-2 w-full rounded" style={{ maxHeight: 230, background: "#000" }} /> : null}
                        </div>
                    ) : null}

                    {error ? (
                        <div className="rounded-md px-2 py-1.5 text-xs" style={{ background: "rgba(248,113,113,0.12)", color: "#fca5a5" }}>
                            {error}
                        </div>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                        {job && ["done", "error", "cancelled"].includes(jobStage) ? <Button onClick={resetJob}>新建任务</Button> : null}
                        {job && ["generating", "submitting"].includes(jobStage) ? (
                            <Button danger loading={busy === "cancel"} onClick={() => void runCancel()}>
                                停止轮询
                            </Button>
                        ) : null}
                        {!job || ["error", "cancelled"].includes(jobStage) ? (
                            <Button type="primary" icon={<Sparkles size={14} />} loading={busy === "plan"} onClick={() => void runPlan()} disabled={!connected || !target}>
                                预检（不花钱）
                            </Button>
                        ) : null}
                        {job && jobStage === "ready" ? (
                            <Button type="primary" danger loading={busy === "confirm"} onClick={() => void runConfirm()}>
                                确认生成（扣 MochiAni 灵点）
                            </Button>
                        ) : null}
                        {jobStage === "done" && job?.videoUrl ? (
                            <Button type="primary" loading={busy === "place"} onClick={() => void placeOnCanvas()} disabled={Boolean(placedNodeId)}>
                                {placedNodeId ? "已放到画布" : "放到画布"}
                            </Button>
                        ) : null}
                    </div>
                </div>
            </Modal>
        </>
    );
}
