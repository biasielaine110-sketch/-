import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";

import i18n from "@/i18n";
import { buildApiUrl, modelOptionName, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { directApiUrl, isLocalNetworkUrl, proxyApiUrl } from "@/lib/api-proxy";
import { assertModelQuotaAvailable, describeQuotaLock, noteModelQuotaFailure } from "@/lib/model-quota-lockout";
import { isTransientRequestError } from "@/lib/transient-request-error";
import { isVideoCreateUrl, recoverVideoTaskFromList, videoListUrlFor } from "@/lib/video-task-recovery";

type RequestOptions = { signal?: AbortSignal };

/**
 * 单次插件请求的上限。
 *
 * 🔴 为什么必须给（2026-11-28）：画布没有全局 axios 超时，而 qf 渠道的请求会被
 * `proxyApiUrl` 升级到公网入口（Tailscale Funnel）。Funnel 半死不活时那条连接是
 * **静默挂起**（既不 resolve 也不 reject）—— 脚本里的 `await request(...)` 于是永不返回，
 * 画布表现成「一直读秒」，比报错还难查。本机 20s（正常是毫秒级）、公网 60s。
 *
 * `blob` / `arraybuffer` 不设上限：那是真的在传字节，掐断只会变成「下载失败」。
 */
const PLUGIN_REQUEST_TIMEOUT_LOCAL_MS = 20_000;
const PLUGIN_REQUEST_TIMEOUT_REMOTE_MS = 60_000;

function pluginTimeoutMs(url: string, responseType?: string): number {
    if (responseType === "blob" || responseType === "arraybuffer") return 0;
    return isLocalNetworkUrl(url) ? PLUGIN_REQUEST_TIMEOUT_LOCAL_MS : PLUGIN_REQUEST_TIMEOUT_REMOTE_MS;
}

/**
 * 脚本里 `poll()` 的预算下限。
 *
 * 🔴 内置视频模板原来写 `timeoutMs: 300000`（5 分钟），是按普通 5s 成片设的。qf 渠道
 * 15s 的 Seedance 2.0 Fast 实测要 **6–10 分钟**，5 分钟的上限会把一个正在正常推进的任务
 * 判死 —— 用户看到「插件轮询超时」，后台半小时后照样把文件写进网关，前端永远拿不到。
 * 主流程（`video.ts` 的 360 × 2.5s）预算本来就是 15 分钟，这里对齐，脚本写得更短也按 15 分钟走。
 * 用户主动取消（`signal`）不受影响，随时能停。
 */
const PLUGIN_POLL_DEFAULT_MS = 300_000;
const PLUGIN_POLL_MIN_MS = 15 * 60 * 1000;

export type PluginHttpOptions = {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    responseType?: "json" | "blob" | "text" | "arraybuffer";
};

export type PluginHttp = {
    url: (path: string) => string;
    post: (path: string, body?: unknown, options?: PluginHttpOptions) => Promise<unknown>;
    get: (path: string, options?: PluginHttpOptions) => Promise<unknown>;
};

export type PluginPollOptions = { intervalMs?: number; timeoutMs?: number };

export type RunPluginArgs = {
    capability: ModelCapability;
    script: string;
    config: AiConfig;
    prompt?: string;
    images?: string[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

function pluginHeaders(extra?: Record<string, string>, hasJsonBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasJsonBody) headers["Content-Type"] = "application/json";
    return { ...headers, ...extra };
}

function pluginUrl(config: AiConfig, path: string) {
    if (/^https?:/i.test(path)) return proxyApiUrl(path, config.apiTransport);
    return proxyApiUrl(buildApiUrl(config.baseUrl, path.startsWith("/") ? path : `/${path}`), config.apiTransport);
}

/**
 * 「请求体在链路上丢了」的识别。
 *
 * 🔴 实况（2026-11-26，qf 渠道 Seedance 2.0 Fast）：6 个视频节点逐个点生成，网关
 * `local-api-requests.jsonl` 里 8 条 `POST /v1/videos` 全是 `body_keys:null`，而
 * `readBody()` 只有在**一个字节都没收到**时才返回 null —— 请求头到了、请求体没到。
 * 这些连接在 16s / 107s / 145s 后被关闭，此后 `readBody` 才拿到空值，于是网关回
 * 400「prompt 不能为空」，用户看到的是「没发到模型」。
 *
 * 所以这个 400 不是提示词的问题，是传输的问题。判据必须同时满足，避免把真正的空提示词
 * 当成链路故障反复重提：
 *   ① 状态码 400/422；
 *   ② **我们确实发了非空 prompt**；
 *   ③ 响应文案点名 prompt 且说它为空（中英都算）。
 *
 * 满足就换一条传输重提一次：直连 → 边缘代理（`/api/proxy` 会先把 body 缓冲再转发，
 * 不会出现「头到了、体没到」）。重提**不会重复扣费**：网关是「body 为空 → 直接 400 返回」，
 * 压根没入队，也没有建任务。绝不因为网络错误/5xx 重提，那种情况任务可能已经建好了。
 */
function sentNonEmptyPrompt(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const prompt = (data as { prompt?: unknown }).prompt;
    return typeof prompt === "string" && prompt.trim().length > 0;
}

function isEmptyBodyRejection(error: unknown, data: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status !== 400 && status !== 422) return false;
    if (!sentNonEmptyPrompt(data)) return false;
    const payload = error.response?.data;
    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    // 网关（quota-flow）新版会明确回 code=body_not_delivered：请求头到了、请求体 EPIPE 丢了。
    // 这个信号比猜文案准得多，先认它。
    const code = (payload as { error?: { code?: unknown } } | null | undefined)?.error?.code;
    if (code === "body_not_delivered") return true;
    if (!/prompt/i.test(text)) return false;
    return /(不能为空|不允许为空|为空|链路上丢失|missing|required|empty)/i.test(text);
}

/**
 * 所有插件请求的唯一出口（`http.get/post` 和脚本里的 `request()` 都走它）：
 * 正常只发一次；命中「body 丢失」才换传输重提一次；**提交没拿到回包**则先去网关的
 * 任务列表把任务查回来（见 `lib/video-task-recovery.ts`）。
 */
async function pluginRequest(config: AiConfig, requestConfig: AxiosRequestConfig & { url: string }, options?: RequestOptions) {
    // 调用方（脚本作者）显式给了 timeout 就尊重它，否则按目标地址补一个，别让挂起的连接拖成无限读秒。
    const timeout = requestConfig.timeout ?? pluginTimeoutMs(String(requestConfig.url || ""), requestConfig.responseType);
    // 记下「这次提交是什么时候开始的」，查回任务时用它把窗口卡死，避免认回上一次的成片。
    const startedAt = Date.now();
    try {
        return await axios.request({ ...requestConfig, timeout, signal: options?.signal });
    } catch (error) {
        /**
         * 「回包在链路上丢了」才去查任务列表。
         *
         * 判据必须严格：**没有任何 response** 且属于可重试类（超时 / 连接重置 / 无回包）。
         * 4xx 是网关给出了明确答复（参数错、鉴权错），5xx 也是答复 —— 这两种情况任务基本没
         * 建起来，再去列表里捞只会捞到别人的任务，反过来把上一次的成片贴到这次的节点上。
         */
        const responseLost = axios.isAxiosError(error) && !error.response && isTransientRequestError(error);
        if (!isEmptyBodyRejection(error, requestConfig.data)) {
            if (responseLost) {
                /**
                 * 🔴 提交阶段的「无回包 / 超时」不等于没提交（2026-11-28 qf 实况）：
                 * 网关日志里 `POST /v1/videos → 200（11s）`、`task-created` 全都在，前端却只收到
                 * 「没有拿到任何回包」—— 响应丢在 Tailscale Funnel 那一跳，任务已经建好了。
                 * 这里先用网关的任务列表把它认回来；认到了就当作提交成功，脚本照常轮询。
                 */
                const recovery = await recoverSubmittedVideoTask(config, { ...requestConfig, url: String(requestConfig.url || "") }, startedAt, options);
                if (recovery.response) return recovery.response;
                if (recovery.lookedUp) (error as { taskLookupMissed?: boolean }).taskLookupMissed = true;
            }
            throw error;
        }
        const direct = String(requestConfig.url || "");
        const proxied = proxyApiUrl(direct, "proxy");
        // 本机/内网网关塞进边缘代理只会 403（边缘到不了本机），这种情况没有第二条路可换。
        if (!proxied || proxied === direct || isLocalNetworkUrl(direct)) throw error;
        console.warn("[model-plugin] 提交体在直连链路上丢失（网关只收到请求头），已改走边缘代理重提一次");
        try {
            return await axios.request({
                ...requestConfig,
                url: proxied,
                timeout: requestConfig.timeout ?? pluginTimeoutMs(proxied, requestConfig.responseType),
                signal: options?.signal,
            });
        } catch (retryError) {
            // 换了传输还是「prompt 为空」→ 确实没送达。给一句准确的话，别让用户以为提示词写错了。
            if (isEmptyBodyRejection(retryError, requestConfig.data)) throw new Error(i18n.t("modelPlugin.submitNotDelivered"));
            throw retryError;
        }
    }
}

/**
 * 提交没拿到回包时，用网关的任务列表把任务认回来。
 *
 * 只对「带 prompt 的 `POST .../v1/videos`」生效：别的接口（ComfyUI 工作流、自建
 * `/v1/media/generations`）没有统一的列表契约，硬猜只会认错任务，所以一律跳过。
 * 认回来时伪造一个 `AxiosResponse` 形状 `{ data: {id, status, ...} }` —— 脚本只读 `.data`
 * （构造出来的任务和真回包同形状，脚本无需任何改动）。
 */
async function recoverSubmittedVideoTask(
    config: AiConfig,
    requestConfig: AxiosRequestConfig & { url: string },
    startedAt: number,
    options?: RequestOptions,
): Promise<{ response: AxiosResponse | null; lookedUp: boolean }> {
    const none = { response: null, lookedUp: false };
    if (String(requestConfig.method || "").toLowerCase() !== "post") return none;
    if (options?.signal?.aborted) return none;
    const body = requestConfig.data;
    if (!body || typeof body !== "object") return none;
    // JSON 和 multipart 两种提交都要能认（有的中转 `/v1/videos` 收表单）。
    const form = typeof FormData !== "undefined" && body instanceof FormData;
    const readField = (name: string) => (form ? String(body.get(name) ?? "") : String((body as Record<string, unknown>)[name] ?? "")).trim();
    const prompt = readField("prompt");
    if (!prompt) return none;
    const createUrl = directApiUrl(String(requestConfig.url || ""));
    if (!isVideoCreateUrl(createUrl)) return none;
    const model = readField("model");

    const { task, lookedUp } = await recoverVideoTaskFromList({
        createUrl,
        // 任务列表走和提交同一条传输（qf：直接走 Funnel 公网入口；普通中转：走 /api/proxy）。
        listUrl: proxyApiUrl(videoListUrlFor(createUrl), config.apiTransport),
        headers: requestConfig.headers as Record<string, string> | undefined,
        model,
        prompt,
        startedAt,
        signal: options?.signal,
    });
    if (!task) return { response: null, lookedUp };
    return {
        response: { data: task, status: 200, statusText: "OK", headers: {}, config: requestConfig } as unknown as AxiosResponse,
        lookedUp: true,
    };
}

function createPluginHttp(config: AiConfig, options?: RequestOptions): PluginHttp {
    const run = async (method: "get" | "post", path: string, body: unknown, opts?: PluginHttpOptions) => {
        const isForm = typeof FormData !== "undefined" && body instanceof FormData;
        const response = await pluginRequest(config, {
            method,
            url: pluginUrl(config, path),
            data: method === "post" ? body : undefined,
            params: opts?.params,
            headers: pluginHeaders({ Authorization: `Bearer ${config.apiKey}`, ...opts?.headers }, method === "post" && !isForm && body !== undefined),
            responseType: opts?.responseType || "json",
        }, options);
        return response.data;
    };
    return {
        url: (path) => pluginUrl(config, path),
        post: (path, body, opts) => run("post", path, body, opts),
        get: (path, opts) => run("get", path, undefined, opts),
    };
}

/** Raw request with no automatic auth header — the script controls method, url, headers, body entirely. */
function createPluginRequest(config: AiConfig, options?: RequestOptions) {
    return async (requestConfig: AxiosRequestConfig & { url: string }) => {
        const response = await pluginRequest(config, { ...requestConfig, url: pluginUrl(config, requestConfig.url) }, options);
        return response.data;
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

/**
 * 脚本里的 `poll(fn, extract, { intervalMs, timeoutMs })`。
 *
 * 🔴 关键行为（2026-11-28 补）：**请求本身抖动不算失败**。
 * 用户截图里的「模型调用脚本执行失败：Network Error」就是这里来的 —— 网关（qf，走 Funnel）
 * 抖了一下，`await request(...)` 抛了个没有回包的 AxiosError，旧代码直接冒泡出 `poll()`，
 * 整个脚本结束、前台报错；而后台 WebView 还在跑，最后把成片写进网关了事。
 *
 * 现在只有两种情况会结束轮询：
 *   · `extract()` 抛错（脚本自己判定任务失败）—— 那是真结论，原样抛；
 *   · 到 deadline —— 抛 `pollTimeout`。
 * `request()` 抛的 5xx / 超时 / 无回包 → 打一行 console.warn，继续下一拍。
 * 4xx（401 / 404 / 400）不吞：重试长不出结果，立刻暴露给用户。
 */
function createPoll(signal?: AbortSignal) {
    return async function poll<T, R>(request: () => Promise<T>, extract: (value: T) => R | null | undefined | false, options?: PluginPollOptions): Promise<R> {
        const intervalMs = options?.intervalMs ?? 2500;
        const timeoutMs = Math.max(options?.timeoutMs ?? PLUGIN_POLL_DEFAULT_MS, PLUGIN_POLL_MIN_MS);
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let value: T;
            try {
                value = await request();
            } catch (error) {
                if (signal?.aborted) throw error;
                if (!isTransientRequestError(error)) throw error;
                console.warn("[model-plugin] 这一轮没问到任务状态（网络抖动），继续轮询：", error instanceof Error ? error.message : String(error));
                if (performance.now() >= deadline) throw new Error(i18n.t("modelPlugin.pollTimeout"));
                await sleep(intervalMs, signal);
                continue;
            }
            // extract 在 try 外面：脚本自己抛的「任务失败」必须原样冒出去，不能被当抖动吞掉。
            const result = extract(value);
            if (result !== null && result !== undefined && result !== false) return result;
            if (performance.now() >= deadline) throw new Error(i18n.t("modelPlugin.pollTimeout"));
            await sleep(intervalMs, signal);
        }
    };
}

/**
 * Run a user-authored model call script as an async function body with flat locals (see PLUGIN_VARIABLES):
 *   prompt / images / messages / params        — request input
 *   model / baseUrl / apiKey / systemPrompt / reasoningEffort     — current channel and text settings
 *   http / request / poll / sleep / signal / onDelta    — request helpers
 * The script must `return` the result; each caller normalizes it to its capability's shape.
 */
export async function runModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    const { config } = args;
    // 今日额度已用完的模型：连脚本都不跑（脚本第一句就是提交，跑了也是白跑一轮）。
    assertModelQuotaAvailable(config, config.model);
    const http = createPluginHttp(config, { signal: args.signal });
    const request = createPluginRequest(config, { signal: args.signal });
    const poll = createPoll(args.signal);
    const runner = new Function(
        "prompt",
        "images",
        "messages",
        "params",
        "model",
        "baseUrl",
        "apiKey",
        "systemPrompt",
        "reasoningEffort",
        "http",
        "request",
        "poll",
        "sleep",
        "signal",
        "onDelta",
        `"use strict"; return (async () => {\n${args.script}\n})();`,
    ) as (...fnArgs: unknown[]) => Promise<T>;
    try {
        return await runner(
            args.prompt || "",
            args.images || [],
            args.messages || [],
            args.params || {},
            modelOptionName(config.model),
            config.baseUrl,
            config.apiKey,
            config.systemPrompt || "",
            config.reasoningEffort,
            http,
            request,
            poll,
            (ms: number) => sleep(ms, args.signal),
            args.signal,
            args.onDelta,
        );
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isCancel(error)) throw error;
        let message = error instanceof Error ? error.message : String(error);
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const bodyMessage =
                typeof error.response?.data === "string"
                    ? error.response.data.slice(0, 240)
                    : error.response?.data && typeof error.response.data === "object"
                      ? String((error.response.data as { msg?: string; message?: string }).msg || (error.response.data as { message?: string }).message || "")
                      : "";
            if (bodyMessage) message = bodyMessage;
            if ((status === 401 || status === 403) && /autodl\.art/i.test(config.baseUrl || "")) {
                message = i18n.t("apiErrors.autodlComfyAuthFailed");
            } else if (status && !bodyMessage) {
                message = `${message} (HTTP ${status})`;
            } else if (!status && !bodyMessage) {
                // 没有 response 时 axios 只会给一句 "Network Error"，用户拿它什么都判断不了。
                // 说清两件事：这是链路没回包；后端可能已经收下了，别急着重复提交。
                // 如果已经查过网关任务列表还是没找到，就可以确定「这次没送达」，文案要更硬气。
                const lookedUp = Boolean((error as { taskLookupMissed?: boolean }).taskLookupMissed);
                message = i18n.t(lookedUp ? "modelPlugin.networkNoResponseUnrecovered" : "modelPlugin.networkNoResponse");
            }
        }
        /**
         * 「今日额度用完」的脚本失败要把这个模型停用到次日 0 点：qf 这类按日发额度的渠道，
         * 额度见底后每点一次就白跑一轮，用户还会以为是自己提示词/画布坏了。原文照留
         * （那才是上游的说法），后面补一句「已暂停 + 几点回来」。
         */
        const quotaLock = noteModelQuotaFailure(config, config.model, message);
        if (quotaLock) message = `${message}\n\n${describeQuotaLock(quotaLock)}`;
        throw new Error(i18n.t("modelPlugin.executionFailed", { message }));
    }
}

export type PluginVariable = { name: string; type: string; desc: string; capabilities?: ModelCapability[] };

/** Documentation surface shown in the script editor. */
export function getPluginVariables(): PluginVariable[] {
    return [
        { name: "prompt", type: "string", desc: i18n.t("modelPlugin.variables.prompt"), capabilities: ["image", "video", "audio"] },
        { name: "images", type: "string[]", desc: i18n.t("modelPlugin.variables.images"), capabilities: ["image", "video"] },
        { name: "messages", type: "{ role, content }[]", desc: i18n.t("modelPlugin.variables.messages"), capabilities: ["text"] },
        { name: "params", type: "object", desc: i18n.t("modelPlugin.variables.params") },
        { name: "model", type: "string", desc: i18n.t("modelPlugin.variables.model") },
        { name: "baseUrl", type: "string", desc: i18n.t("modelPlugin.variables.baseUrl") },
        { name: "apiKey", type: "string", desc: i18n.t("modelPlugin.variables.apiKey") },
        { name: "systemPrompt", type: "string", desc: i18n.t("modelPlugin.variables.systemPrompt") },
        { name: "reasoningEffort", type: '"auto" | "low" | "medium" | "high" | "xhigh"', desc: i18n.t("modelPlugin.variables.reasoningEffort"), capabilities: ["text"] },
        { name: "http", type: "object", desc: i18n.t("modelPlugin.variables.http") },
        { name: "request", type: "function", desc: i18n.t("modelPlugin.variables.request") },
        { name: "poll", type: "function", desc: i18n.t("modelPlugin.variables.poll") },
        { name: "sleep", type: "function", desc: i18n.t("modelPlugin.variables.sleep") },
        { name: "signal", type: "AbortSignal", desc: i18n.t("modelPlugin.variables.signal") },
        { name: "onDelta", type: "function", desc: i18n.t("modelPlugin.variables.onDelta"), capabilities: ["text"] },
    ];
}

export function getPluginReturn(capability: ModelCapability) {
    return i18n.t(`modelPlugin.returns.${capability}`);
}

export type PluginTemplate = { label: string; script: string };

export function getPluginTemplates(): Record<ModelCapability, PluginTemplate[]> {
    return {
    image: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.imageOpenai")}
// ${i18n.t("modelPlugin.templates.availableImage")}
if (images.length === 0) {
  // ${i18n.t("modelPlugin.templates.textToImage")}
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1/images/generations\`,
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` },
    data: { model, prompt, n: params.count, size: params.size, response_format: "b64_json" },
  });
  return (data.data || []).map((item) => item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
}

// ${i18n.t("modelPlugin.templates.imageToImage")}
const form = new FormData();
form.set("model", model);
form.set("prompt", prompt);
form.set("n", String(params.count));
form.set("response_format", "b64_json");
for (const dataUrl of images) {
  form.append("image", await (await fetch(dataUrl)).blob(), "ref.png");
}
const edited = await request({
  method: "post",
  url: \`\${baseUrl}/v1/images/edits\`,
  headers: { Authorization: \`Bearer \${apiKey}\` }, // ${i18n.t("modelPlugin.templates.formDataHeader")}
  data: form,
});
return (edited.data || []).map((item) => item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.imageGemini")}
// ${i18n.t("modelPlugin.templates.availableImageGemini")}
const parts = [{ text: prompt }];
for (const dataUrl of images) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
}
const imageConfig = {};
if (params.size && params.size !== "auto") {
  const ratio = String(params.size).includes("x") ? String(params.size).replace(/[xX]/, ":") : String(params.size);
  imageConfig.aspectRatio = ratio;
}
if (params.quality === "high") imageConfig.imageSize = "4K";
else if (params.quality === "medium" || params.quality === "hd") imageConfig.imageSize = "2K";
else if (params.quality) imageConfig.imageSize = "1K";
const data = await request({
  method: "post",
  url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
  headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, Authorization: \`Bearer \${apiKey}\` },
  data: {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    },
  },
});
            return (data.candidates || [])
  .flatMap((c) => c.content?.parts || [])
  .map((p) => p.inlineData || p.inline_data)
  .filter(Boolean)
  .map((img) => \`data:\${img.mimeType || img.mime_type || "image/png"};base64,\${img.data}\`);`,
        },
        {
            label: i18n.t("modelPlugin.templates.autodlComfy"),
            script: `// ${i18n.t("modelPlugin.templates.imageAutodlComfy")}
// Base URL: https://autodl.art/api/v1
// model = workflow_id；Token 分组选 ComfyUI（令牌管理）
const workflowId = String(model || "").trim();
if (!workflowId) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlWorkflowRequired"))});
const token = String(apiKey || "").replace(/^Bearer\\s+/i, "").trim();
const headers = { Authorization: token, "Content-Type": "application/json" };
const body = { prompt };
if (params.duration != null && params.duration !== "") body.duration = Number(params.duration);
else if (params.seconds != null && params.seconds !== "") body.duration = Number(params.seconds);
if (params.resolution) body.resolution = params.resolution;
else if (params.size) body.resolution = params.size;
const httpImage = images.find((item) => /^https?:\\/\\//i.test(String(item || "")));
if (httpImage) {
  body.image = httpImage;
  body.image_url = httpImage;
}
const submit = await request({
  method: "post",
  url: \`\${baseUrl}/comfyui/comfyui_workflow/\${encodeURIComponent(workflowId)}\`,
  headers,
  data: body,
});
if (submit?.code && !/^success$/i.test(String(submit.code))) {
  throw new Error(submit.msg || submit.message || JSON.stringify(submit));
}
const taskId = submit?.data?.task_id || submit?.task_id;
if (!taskId) throw new Error(submit?.msg || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoTaskId"))});
return await poll(
  () => request({
    method: "get",
    url: \`\${baseUrl}/comfyui/comfyui_workflow/result/\${encodeURIComponent(taskId)}\`,
    headers: { Authorization: token },
  }),
  (state) => {
    const data = state?.data || state || {};
    const status = String(data.status || "");
    if (/^failed|failure$/i.test(status)) throw new Error(state?.msg || data.message || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlTaskFailed"))});
    if (!/^success$/i.test(status)) return null;
    const urls = (Array.isArray(data.results) ? data.results : [])
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        return item.url || item.image_url || item.video_url || item.file_url || "";
      })
      .filter(Boolean);
    if (!urls.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoResults"))});
    return urls;
  },
  { intervalMs: 2000, timeoutMs: 15 * 60 * 1000 },
);`,
        },
        {
            label: i18n.t("modelPlugin.templates.nativeComfyUi"),
            // Paste-ready API workflow skeleton — replace with File → Export Workflow (API).
            script: `{
  "3": {
    "inputs": { "text": "a cat", "clip": ["4", 1] },
    "class_type": "CLIPTextEncode",
    "_meta": { "title": "Positive Prompt" }
  }
}`,
        },
    ],
    video: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.videoOpenai")}
const headers = { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` };
const ratio = params.ratio || "16:9";
const seconds = String(params.seconds || "5");
const task = await request({
  method: "post",
  url: \`\${baseUrl}/v1/videos\`,
  headers,
  data: {
    model,
    prompt,
    seconds,
    duration: seconds,
    ratio,
    aspect_ratio: ratio,
    size: ratio,
    resolution: params.resolution || "720p",
  },
});
return await poll(
  () => request({ method: "get", url: \`\${baseUrl}/v1/videos/\${task.id}\`, headers }),
  (state) => state.status === "completed" ? { url: state.video_url || state.url } : null,
  { intervalMs: 2500, timeoutMs: 15 * 60 * 1000 }, // 15 分钟：长片 + 慢网关（qf 15s 成片实测 6–10 分钟）
);`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.videoGemini")}
// ${i18n.t("modelPlugin.templates.availableVideoGemini")}
const headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey };
const instance = { prompt };
const first = images[0] && images[0].match(/^data:([^;]+);base64,(.*)$/);
if (first) instance.image = { bytesBase64Encoded: first[2], mimeType: first[1] };
const op = await request({
  method: "post",
  url: \`\${baseUrl}/v1beta/models/\${model}:predictLongRunning\`,
  headers,
  data: { instances: [instance], parameters: { aspectRatio: params.ratio || "16:9" } },
});
return await poll(
  () => request({ method: "get", url: \`\${baseUrl}/v1beta/\${op.name}\`, headers }),
  (state) => {
    if (!state.done) return null;
    const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiNoVideoUri"))});
    return { url: uri.includes("key=") ? uri : \`\${uri}\${uri.includes("?") ? "&" : "?"}key=\${apiKey}\` };
  },
  { intervalMs: 5000, timeoutMs: 15 * 60 * 1000 },
);`,
        },
        {
            label: i18n.t("modelPlugin.templates.autodlComfy"),
            script: `// ${i18n.t("modelPlugin.templates.videoAutodlComfy")}
// Base URL: https://autodl.art/api/v1
// model = workflow_id；Token 分组选 ComfyUI
const workflowId = String(model || "").trim();
if (!workflowId) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlWorkflowRequired"))});
const token = String(apiKey || "").replace(/^Bearer\\s+/i, "").trim();
const headers = { Authorization: token, "Content-Type": "application/json" };
const body = { prompt };
if (params.duration != null && params.duration !== "") body.duration = Math.round(Number(params.duration));
else if (params.seconds != null && params.seconds !== "") body.duration = Math.round(Number(params.seconds));
if (params.resolution) body.resolution = params.resolution;
else if (params.size) body.resolution = params.size;
images.slice(0, 9).forEach((item, index) => {
  const url = String(item || "").trim();
  if (!url) return;
  body[\`ref_image_\${index}\`] = url;
  if (index === 0 && /^https?:\\/\\//i.test(url)) {
    body.image = url;
    body.image_url = url;
  }
});
const audios = Array.isArray(params.audios) ? params.audios : [];
audios.slice(0, 3).forEach((item, index) => {
  const url = String(item || "").trim();
  if (url) body[\`ref_audio_\${index}\`] = url;
});
if (!body.ref_audio_0 && /z09\\d*|image[_-]?audio|audio[_-]?to[_-]?video|(?:^|[_-])zm(?:[_-]|$)/i.test(workflowId)) {
  body.ref_audio_0 = "https://codewithgpu.ks3-cn-beijing.ksyuncs.com/comfyui_api/blank/blank.wav";
}
const submit = await request({
  method: "post",
  url: \`\${baseUrl}/comfyui/comfyui_workflow/\${encodeURIComponent(workflowId)}\`,
  headers,
  data: body,
});
if (submit?.code && !/^success$/i.test(String(submit.code))) {
  throw new Error(submit.msg || submit.message || JSON.stringify(submit));
}
const taskId = submit?.data?.task_id || submit?.task_id;
if (!taskId) throw new Error(submit?.msg || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoTaskId"))});
const urls = await poll(
  () => request({
    method: "get",
    url: \`\${baseUrl}/comfyui/comfyui_workflow/result/\${encodeURIComponent(taskId)}\`,
    headers: { Authorization: token },
  }),
  (state) => {
    const data = state?.data || state || {};
    const status = String(data.status || "");
    if (/^failed|failure$/i.test(status)) throw new Error(state?.msg || data.message || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlTaskFailed"))});
    if (!/^success|completed$/i.test(status)) return null;
    const list = (Array.isArray(data.results) ? data.results : [])
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        return item.url || item.video_url || item.image_url || item.file_url || "";
      })
      .filter(Boolean);
    if (!list.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoResults"))});
    return list;
  },
  { intervalMs: 2000, timeoutMs: 20 * 60 * 1000 },
);
return { url: urls[0] };`,
        },
        {
            label: i18n.t("modelPlugin.templates.autodlH3Z0903"),
            script: `// ${i18n.t("modelPlugin.templates.videoAutodlH3Z0903")}
// Base URL: https://autodl.art/api/v1
// 仅绑定模型名 minimax_h3_z0903；Token 分组选 ComfyUI
const workflowId = "minimax_h3_z0903";
const token = String(apiKey || "").replace(/^Bearer\\s+/i, "").trim();
const headers = { Authorization: token, "Content-Type": "application/json" };
const BLANK_AUDIO = "https://codewithgpu.ks3-cn-beijing.ksyuncs.com/comfyui_api/blank/blank.wav";
const RESOLUTION_MAP = {
  "480p竖": "480p竖(480*864)",
  "480p横": "480p横(864*480)",
  "768p竖": "768p竖(768*1376)",
  "768p横": "768p横(1376*768)",
  "1080p竖": "1088p竖(1088*1920)",
  "1080p横": "1088p横(1920*1088)",
  "1088p竖": "1088p竖(1088*1920)",
  "1088p横": "1088p横(1920*1088)",
  "1440p竖": "1440p竖(1440*2560)",
  "1440p横": "1440p横(2560*1440)",
  "480p竖(480*864)": "480p竖(480*864)",
  "480p横(864*480)": "480p横(864*480)",
  "768p竖(768*1376)": "768p竖(768*1376)",
  "768p横(1376*768)": "768p横(1376*768)",
  "1088p竖(1088*1920)": "1088p竖(1088*1920)",
  "1088p横(1920*1088)": "1088p横(1920*1088)",
  "1440p竖(1440*2560)": "1440p竖(1440*2560)",
  "1440p横(2560*1440)": "1440p横(2560*1440)",
};
function mapResolution(value) {
  const raw = String(value || "").trim();
  if (RESOLUTION_MAP[raw]) return RESOLUTION_MAP[raw];
  const lower = raw.toLowerCase();
  const orient = /横|landscape|16\\s*:\\s*9/i.test(raw) ? "横" : /1\\s*:\\s*1|\\(1:1\\)/i.test(raw) ? "竖" : "竖";
  if (/1440|2k/i.test(lower)) return orient === "横" ? "1440p横(2560*1440)" : "1440p竖(1440*2560)";
  if (/1088|1080|fhd/i.test(lower)) return orient === "横" ? "1088p横(1920*1088)" : "1088p竖(1088*1920)";
  if (/480/i.test(lower)) return orient === "横" ? "480p横(864*480)" : "480p竖(480*864)";
  return orient === "横" ? "768p横(1376*768)" : "768p竖(768*1376)";
}
const duration = Math.min(15, Math.max(1, Math.round(Number(params.duration ?? params.seconds ?? 5) || 5)));
const resolution = mapResolution(params.resolution || params.size || "768p竖");
const body = { prompt, duration, resolution };
images.slice(0, 6).forEach((item, index) => {
  const url = String(item || "").trim();
  if (!url) return;
  body[\`ref_image_\${index}\`] = url;
  if (index === 0 && /^https?:\\/\\//i.test(url)) {
    body.image = url;
    body.image_url = url;
  }
});
const audios = Array.isArray(params.audios) ? params.audios : [];
const audio0 = String(audios[0] || params.ref_audio_0 || params.audio || "").trim();
body.ref_audio_0 = audio0 || BLANK_AUDIO;
[1, 2].forEach((index) => {
  const url = String(audios[index] || "").trim();
  if (url) body[\`ref_audio_\${index}\`] = url;
});
const submit = await request({
  method: "post",
  url: \`\${baseUrl}/comfyui/comfyui_workflow/\${encodeURIComponent(workflowId)}\`,
  headers,
  data: body,
});
if (submit?.code && !/^success$/i.test(String(submit.code))) {
  throw new Error(submit.msg || submit.message || JSON.stringify(submit));
}
const taskId = submit?.data?.task_id || submit?.task_id;
if (!taskId) throw new Error(submit?.msg || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoTaskId"))});
const urls = await poll(
  () => request({
    method: "get",
    url: \`\${baseUrl}/comfyui/comfyui_workflow/result/\${encodeURIComponent(taskId)}\`,
    headers: { Authorization: token },
  }),
  (state) => {
    const data = state?.data || state || {};
    const status = String(data.status || "");
    if (/^failed|failure$/i.test(status)) throw new Error(state?.msg || data.message || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlTaskFailed"))});
    if (!/^success|completed$/i.test(status)) return null;
    const list = (Array.isArray(data.results) ? data.results : [])
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        return item.url || item.video_url || item.image_url || item.file_url || "";
      })
      .filter(Boolean);
    if (!list.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoResults"))});
    return list;
  },
  { intervalMs: 2000, timeoutMs: 20 * 60 * 1000 },
);
return { url: urls[0] };`,
        },
        {
            label: i18n.t("modelPlugin.templates.nativeComfyUi"),
            script: `{
  "3": {
    "inputs": { "text": "a cinematic shot", "clip": ["4", 1] },
    "class_type": "CLIPTextEncode",
    "_meta": { "title": "Positive Prompt" }
  }
}`,
        },
    ],
    audio: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.audioOpenai")}
return await request({
  method: "post",
  url: \`\${baseUrl}/v1/audio/speech\`,
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` },
  responseType: "blob",
  data: { model, input: prompt, voice: params.voice, response_format: params.format, speed: Number(params.speed) },
});`,
        },
        {
            label: i18n.t("modelPlugin.templates.volcOpenSpeech"),
            script: `// ${i18n.t("modelPlugin.templates.audioVolcOpenSpeech")}
const root = String(baseUrl || "").replace(/\\/+$/, "").replace(/\\/api\\/v3\\/plan\\/tts\\//i, "/api/v3/tts/");
const url = /tts\\/unidirectional/i.test(root)
  ? root
  : /\\/api\\/v3$/i.test(root)
    ? \`\${root}/tts/unidirectional\`
    : root.includes("openspeech.bytedance.com")
      ? \`\${root}/api/v3/tts/unidirectional\`
      : "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const resourceId = /^seed-(tts|icl)/i.test(String(model || "")) ? model : "seed-tts-2.0";
const speaker = String(params.instructions || "").trim() || "zh_female_vv_uranus_bigtts";
const format = params.format === "opus" ? "ogg_opus" : params.format === "pcm" ? "pcm" : "mp3";
const speechRate = Math.max(-50, Math.min(100, Math.round((Number(params.speed) - 1) * 50)));
const text = await request({
  method: "post",
  url,
  headers: {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Request-Id": crypto.randomUUID(),
  },
  responseType: "text",
  data: {
    user: { uid: "infinite-atelier" },
    req_params: {
      text: prompt,
      speaker,
      audio_params: { format, sample_rate: 24000, speech_rate: speechRate },
    },
  },
});
const chunks = [];
let depth = 0, start = -1, raw = String(text || "");
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "{") { if (!depth) start = i; depth++; continue; }
  if (raw[i] !== "}" || !depth) continue;
  depth--;
  if (depth || start < 0) continue;
  const item = JSON.parse(raw.slice(start, i + 1));
  start = -1;
  if (item.code && item.code !== 0 && !item.data) throw new Error(item.message || item.msg || "TTS failed");
  if (item.data) chunks.push(item.data);
}
if (!chunks.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiNoAudio"))});
return { data: chunks.join("") };`,
        },
        {
            label: i18n.t("modelPlugin.templates.autodlComfy"),
            script: `// ${i18n.t("modelPlugin.templates.audioAutodlComfy")}
// Base URL: https://autodl.art/api/v1
// model = workflow_id（如 indextts2-v1）；Token 分组选 ComfyUI
// indextts2-v1: prompt_text + prompt_simple（参考音色，需公网 URL）
const workflowId = String(model || "").trim();
if (!workflowId) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlWorkflowRequired"))});
const token = String(apiKey || "").replace(/^Bearer\\s+/i, "").trim();
const headers = { Authorization: token, "Content-Type": "application/json" };
const speaker = String(params.prompt_simple || params.audio || params.audio_url || params.voice || "").trim();
if (!speaker) throw new Error(${JSON.stringify(i18n.t("apiErrors.autodlIndexTtsRefRequired"))});
const body = {
  prompt_text: prompt,
  prompt_simple: speaker,
  emo_control_method: "与音色参考音频相同",
  emo_random: false,
};
if (params.emo_ref_audio) {
  body.emo_ref_audio = params.emo_ref_audio;
  body.emo_control_method = "使用情感参考音频";
}
const submit = await request({
  method: "post",
  url: \`\${baseUrl}/comfyui/comfyui_workflow/\${encodeURIComponent(workflowId)}\`,
  headers,
  data: body,
});
if (submit?.code && !/^success$/i.test(String(submit.code))) {
  throw new Error(submit.msg || submit.message || JSON.stringify(submit));
}
const taskId = submit?.data?.task_id || submit?.task_id;
if (!taskId) throw new Error(submit?.msg || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoTaskId"))});
const url = await poll(
  () => request({
    method: "get",
    url: \`\${baseUrl}/comfyui/comfyui_workflow/result/\${encodeURIComponent(taskId)}\`,
    headers: { Authorization: token },
  }),
  (state) => {
    const data = state?.data || state || {};
    const status = String(data.status || "");
    if (/^failed|failure$/i.test(status)) throw new Error(state?.msg || data.message || ${JSON.stringify(i18n.t("modelPlugin.templates.autodlTaskFailed"))});
    if (!/^success|completed$/i.test(status)) return null;
    const list = (Array.isArray(data.results) ? data.results : [])
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        return item.url || item.audio_url || item.file_url || "";
      })
      .filter(Boolean);
    if (!list.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.autodlNoResults"))});
    return list[0];
  },
  { intervalMs: 2000, timeoutMs: 15 * 60 * 1000 },
);
return { url };`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.audioGemini")}
// ${i18n.t("modelPlugin.templates.availableAudioGemini")}
const data = await request({
  method: "post",
  url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
  headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  data: {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voice } } },
    },
  },
});
const audio = data.candidates?.[0]?.content?.parts?.map((p) => p.inlineData || p.inline_data).find(Boolean);
if (!audio?.data) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiNoAudio"))});
return { data: audio.data };`,
        },
    ],
    text: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.textOpenai")}
const data = await request({
  method: "post",
  url: \`\${baseUrl}/v1/responses\`,
  headers: { "Content-Type": "application/json", Authorization: \`Bearer \${apiKey}\` },
  data: {
    model,
    input: messages,
    ...(reasoningEffort === "auto" ? {} : { reasoning: { effort: reasoningEffort } }),
  },
});
const text = data.output_text
  || (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || "").join("")
  || "";
onDelta(text);
return text;`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.textGemini")}
// ${i18n.t("modelPlugin.templates.availableTextGemini")}
const contents = messages
  .filter((m) => m.role !== "system")
  .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
const data = await request({
  method: "post",
  url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
  headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  data: { contents, ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}) },
});
const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
onDelta(text);
return text;`,
        },
    ],
    };
}

/** Normalize whatever an image script returns into the app's generated-image shape. */
export function normalizePluginImages(result: unknown): string[] {
    const items = Array.isArray(result) ? result : [result];
    const urls = items
        .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
                const record = item as Record<string, unknown>;
                if (typeof record.dataUrl === "string") return record.dataUrl;
                if (typeof record.url === "string") return record.url;
                if (typeof record.b64_json === "string") return `data:image/png;base64,${record.b64_json}`;
            }
            return "";
        })
        .filter(Boolean);
    if (!urls.length) throw new Error(i18n.t("modelPlugin.noImages"));
    return urls;
}
