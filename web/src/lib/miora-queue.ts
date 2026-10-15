import { nanoid } from "nanoid";

import type { ReferenceImage } from "@/types/image";
import { imageToDataUrl } from "@/services/image-storage";

export type MioraTaskType = "image" | "video";
export type MioraVideoMode = "text" | "frame";

export type MioraSubmitPayload = {
    id?: string;
    type: MioraTaskType;
    prompt: string;
    mode?: MioraVideoMode;
    resolution?: "720P" | "1080P";
    aspectRatio?: string;
    referenceImages?: string[];
};

export type MioraResultPayload = {
    ok: boolean;
    id: string;
    status: "pending" | "done" | "failed";
    files?: string[];
    error?: string;
};

const POLL_INTERVAL_MS = 2500;
/** Cover short-interval WorkBuddy workers + video generation time. */
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

export function isMioraQueueBaseUrl(baseUrl: string) {
    const value = String(baseUrl || "")
        .trim()
        .toLowerCase();
    if (!value) return false;
    if (value.startsWith("miora:")) return true;
    if (value.includes("/api/miora")) return true;
    return false;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

async function readJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
    }
}

export async function probeMioraQueueHealth(signal?: AbortSignal) {
    const response = await fetch("/api/miora/health", { method: "GET", signal });
    if (!response.ok) return { ok: false as const, message: `HTTP ${response.status}` };
    const body = await readJson<{ ok?: boolean; pending?: number }>(response);
    return body?.ok ? ({ ok: true as const, pending: body.pending || 0 }) : { ok: false as const, message: "miora health failed" };
}

export async function uploadMioraReference(image: ReferenceImage, signal?: AbortSignal): Promise<string> {
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl?.startsWith("data:image/")) throw new Error("参考图无法转换为本地文件");
    const response = await fetch("/api/miora/upload-ref", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: `ref-${nanoid(8)}`, dataUrl }),
        signal,
    });
    const body = await readJson<{ ok?: boolean; path?: string; error?: string }>(response);
    if (!response.ok || !body?.ok || !body.path) throw new Error(body?.error || `上传参考图失败 (HTTP ${response.status})`);
    return body.path;
}

export async function submitMioraTask(payload: MioraSubmitPayload, signal?: AbortSignal) {
    const response = await fetch("/api/miora/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            id: payload.id || `task-${nanoid(10)}`,
            type: payload.type,
            prompt: payload.prompt,
            mode: payload.mode || "text",
            resolution: payload.resolution || "1080P",
            aspectRatio: payload.aspectRatio || "16:9",
            referenceImages: payload.referenceImages || [],
        }),
        signal,
    });
    const body = await readJson<{ ok?: boolean; id?: string; error?: string }>(response);
    if (!response.ok || !body?.ok || !body.id) throw new Error(body?.error || `提交 WorkBuddy 任务失败 (HTTP ${response.status})`);
    return body.id;
}

export async function fetchMioraResult(id: string, signal?: AbortSignal): Promise<MioraResultPayload> {
    const response = await fetch(`/api/miora/result/${encodeURIComponent(id)}`, { method: "GET", signal });
    const body = await readJson<MioraResultPayload>(response);
    if (!response.ok || !body?.ok) throw new Error(body?.error || `读取任务结果失败 (HTTP ${response.status})`);
    return body;
}

export async function waitForMioraResult(id: string, options?: { signal?: AbortSignal; timeoutMs?: number }) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    while (true) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const result = await fetchMioraResult(id, options?.signal);
        if (result.status === "done") {
            if (!result.files?.length) throw new Error("WorkBuddy 任务完成但没有产物文件");
            return result;
        }
        if (result.status === "failed") throw new Error(result.error || "WorkBuddy 生成失败");
        if (Date.now() - started > timeoutMs) {
            throw new Error("等待 WorkBuddy 生成超时：请确认本机已打开 WorkBuddy，且队列 worker 正在运行");
        }
        await delay(POLL_INTERVAL_MS, options?.signal);
    }
}

export async function mediaUrlToDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`读取产物失败 (HTTP ${response.status})`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取产物失败"));
        reader.readAsDataURL(blob);
    });
}

export async function mediaUrlToBlob(url: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`读取产物失败 (HTTP ${response.status})`);
    return response.blob();
}

/** Map canvas size / quality settings onto miora task fields. */
export function resolveMioraAspectRatio(size: string) {
    const value = String(size || "").trim().toLowerCase();
    if (!value || value === "auto" || value === "adaptive") return "16:9";
    if (/^\d+:\d+$/.test(value)) return value;
    const match = value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!match) return "16:9";
    const width = Number(match[1]) || 16;
    const height = Number(match[2]) || 9;
    const ratio = width / Math.max(1, height);
    if (Math.abs(ratio - 1) < 0.08) return "1:1";
    if (ratio < 1) return "9:16";
    return "16:9";
}

export function resolveMioraResolution(vquality: string) {
    const value = String(vquality || "").trim().toLowerCase();
    if (value.includes("720") || value === "low" || value === "720p") return "720P" as const;
    return "1080P" as const;
}

/**
 * Submit + wait for WorkBuddy ImageGen / VideoGen via the local file queue.
 * Returns browser-usable media URLs under /api/miora/media.
 */
export async function runMioraGeneration(options: {
    type: MioraTaskType;
    prompt: string;
    references?: ReferenceImage[];
    size?: string;
    vquality?: string;
    signal?: AbortSignal;
}) {
    const prompt = String(options.prompt || "").trim();
    if (!prompt) throw new Error("提示词不能为空");

    const refs = options.references || [];
    const localPaths: string[] = [];
    for (const image of refs.slice(0, options.type === "video" ? 2 : 1)) {
        localPaths.push(await uploadMioraReference(image, options.signal));
    }

    const mode: MioraVideoMode = options.type === "video" && localPaths.length > 0 ? "frame" : "text";
    const id = await submitMioraTask(
        {
            type: options.type,
            prompt,
            mode,
            resolution: resolveMioraResolution(options.vquality || ""),
            aspectRatio: resolveMioraAspectRatio(options.size || ""),
            referenceImages: localPaths,
        },
        options.signal,
    );

    const result = await waitForMioraResult(id, { signal: options.signal });
    return { id, files: result.files || [] };
}
