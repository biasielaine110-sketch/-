/**
 * MochiAni ⇄ 开源画布 本机桥
 *
 * 作用：把「画布里输入的一句指令」变成 MochiAni 里的一次视频生成，
 *      再把生成好的视频地址回传给画布落成视频节点。
 *
 * 为什么必须在本机跑：
 *   MochiAni MCP 是 stdio 进程，只能由本机 Node 拉起；画布是浏览器页面，够不着它。
 *
 * 两条生成链（按已连接页面的 siteKind 自动分流）：
 *   mochiani-canvas（无限画布）
 *     canvas_read → canvas_create_nodes
 *     → locate_node + model_controls(等面板挂上拿 configToken)
 *     → configure_model(模型/渠道/参数，每步重读 token)
 *     → upload_and_connect(参考图本机落盘后导入并连线)
 *     → set_prompt → generation_context(拿 contextToken / estimatedPoints)
 *     → generate_node → generation_operation → get_node
 *   carton-editor（漫剧编辑器）
 *     get_work_summary → create_shot → preflight_generation
 *     → generate_video → get_shot_media_versions
 *
 * 面板侧接口：
 *   GET  /api/models   真实模型目录（46 个模型 + 各自渠道/参数/媒体上限）
 *   POST /api/plan     {prompt, pageId, modelKey, channelId, params, images/videos/audios:[{dataUrl}|{url}]}
 *
 * 依赖：本机已安装 mochiani-mcp（npm -g），浏览器已登录 mochiani.com 且页面连上 MCP。
 * 启动：node tools/mochiani-bridge/server.mjs（或 start.bat）
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.MOCHIANI_BRIDGE_PORT || 17399);
const HOST = process.env.MOCHIANI_BRIDGE_HOST || "127.0.0.1";
/**
 * 远程访问令牌。默认空 = 只监听 127.0.0.1、不做鉴权（本机用最省事）。
 *
 * 要把画布装成「别的电脑也能用」的网站形态，就得把桥暴露到公网（Tailscale Funnel /
 * 反代 / 花生壳…）。那时**必须**设一个令牌，否则任何拿到地址的人都能花你的 MochiAni 灵点：
 *   画布节点里填 `https://你的域名/?token=xxxx`，浏览器会带上 `x-mochiani-token` 头。
 */
const TOKEN = String(process.env.MOCHIANI_BRIDGE_TOKEN || "").trim();

const MCP_ROOT =
    process.env.MOCHIANI_MCP_ROOT || path.join(process.env.APPDATA || "", "npm", "node_modules", "mochiani-mcp");
const MCP_DATA_FILE =
    process.env.MOCHIANI_MCP_DATA_FILE || path.join(process.env.LOCALAPPDATA || "", "MochiAni", "MCP", "config.json");
const MCP_URL = process.env.MOCHIANI_MCP_URL || "http://127.0.0.1:17321";
const NODE_EXE = process.env.MOCHIANI_NODE_EXE || process.execPath;

const POLL_MS = Number(process.env.MOCHIANI_POLL_MS || 15000);
const JOB_TIMEOUT_MS = Number(process.env.MOCHIANI_JOB_TIMEOUT_MS || 60 * 60 * 1000);
const PLAN_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------- MCP client

const sdkDir = path.join(MCP_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(pathToFileURL(path.join(sdkDir, "index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkDir, "stdio.js")).href);

let client = null;
let connecting = null;
const mcpState = { connected: false, lastError: "", lastCheckAt: 0, toolCalls: 0 };

function resetClient(reason) {
    mcpState.connected = false;
    mcpState.lastError = reason || "";
    client = null;
}

async function ensureClient() {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
        const transport = new StdioClientTransport({
            command: NODE_EXE,
            args: [path.join(MCP_ROOT, "dist", "stdio-proxy", "index.js")],
            env: {
                ...process.env,
                MOCHIANI_MCP_URL: MCP_URL,
                MOCHIANI_MCP_PORT: new URL(MCP_URL).port || "17321",
                MOCHIANI_MCP_DATA_FILE: MCP_DATA_FILE,
                MOCHIANI_MCP_USE_STORED_TOKEN: "1",
            },
            stderr: "pipe",
        });
        const next = new Client({ name: "atelier-mochiani-bridge", version: "1.2.0" });
        next.onclose = () => resetClient("MCP 连接已断开");
        await next.connect(transport);
        client = next;
        mcpState.connected = true;
        mcpState.lastError = "";
        return next;
    })();
    try {
        return await connecting;
    } catch (error) {
        resetClient(error?.message || String(error));
        throw error;
    } finally {
        connecting = null;
    }
}

function contentText(res) {
    return (res?.content || [])
        .filter((item) => item && item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
}

function tryJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

class BridgeError extends Error {
    constructor(message, code, payload) {
        super(message);
        this.name = "BridgeError";
        this.code = code || "BRIDGE_ERROR";
        this.payload = payload ?? null;
    }
}

function isTransportError(error) {
    const text = String(error?.message || error || "");
    return /transport|not connected|EPIPE|ECONNRESET|closed|Connection closed|write after end/i.test(text);
}

async function invoke(instance, name, args) {
    const res = await instance.callTool({ name, arguments: args || {} });
    mcpState.toolCalls += 1;
    mcpState.lastCheckAt = Date.now();
    const text = contentText(res);
    const parsed = tryJson(text);
    if (res?.isError) {
        throw new BridgeError(parsed?.message || text || `${name} 调用失败`, parsed?.code || "MCP_TOOL_ERROR", parsed ?? { raw: text });
    }
    return parsed ?? { raw: text };
}

async function callTool(name, args, options = {}) {
    const instance = await ensureClient();
    try {
        return await invoke(instance, name, args);
    } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (options.retry !== false && isTransportError(error)) {
            resetClient(error?.message || String(error));
            const retried = await ensureClient();
            return await invoke(retried, name, args);
        }
        throw error;
    }
}

// ------------------------------------------------------------- value probing

function walk(root, visit, limit = 20000) {
    const stack = [[root, ""]];
    let seen = 0;
    while (stack.length && seen < limit) {
        const [value, key] = stack.pop();
        seen += 1;
        visit(value, key);
        if (value && typeof value === "object") {
            for (const [childKey, child] of Object.entries(value)) stack.push([child, childKey]);
        }
    }
}

function firstString(root, patterns) {
    let found = "";
    walk(root, (value, key) => {
        if (found) return;
        if (typeof value !== "string" && typeof value !== "number") return;
        const text = String(value).trim();
        if (!text) return;
        if (patterns.some((re) => re.test(key))) found = text;
    });
    return found;
}

function collectStrings(root, test) {
    const out = [];
    walk(root, (value) => {
        if (typeof value !== "string") return;
        if (test(value)) out.push(value);
    });
    return [...new Set(out)];
}

function findVideoUrl(root) {
    const candidates = [];
    walk(root, (value, key) => {
        if (typeof value !== "string") return;
        if (!/^https?:\/\//i.test(value)) return;
        const looksFile = /\.(mp4|mov|webm|m3u8)(\?|#|$)/i.test(value);
        const keySaysVideo = /video|mp4|play_?url|main_?url|media_?url|remote/i.test(key);
        if (looksFile) candidates.unshift(value);
        else if (keySaysVideo) candidates.push(value);
    });
    return candidates[0] || "";
}

const RE_PROJECT_ID = [/^project_?id$/i, /^projectid$/i];
const RE_PROJECT_NAME = [/^project_?name$/i, /^project_?title$/i];
const RE_WORK_ID = [/^work_?id$/i, /^workid$/i];
const RE_WORK_NAME = [/^work_?name$/i, /^work_?title$/i];

// ------------------------------------------------------------- page discovery

/**
 * 已连接页面。MochiAni 有三种 siteKind：
 *   mochiani-client（首页，不能生成）
 *   mochiani-canvas（无限画布，走 canvas_* 工具）
 *   carton-editor（漫剧编辑器，走 shot/video 工具）
 *
 * ⚠️ `operations.canGenerate` 只在 carton-editor 上有意义，画布页面恒为 false，
 * 所以不能拿它当唯一判据（曾经因此把「无限画布」误判成不可生成）。
 */
async function listPages() {
    const data = await callTool("mochiani_list_open_pages", {});
    return Array.isArray(data?.pages) ? data.pages : [];
}

function pageKind(page) {
    const kind = String(page?.siteKind || "");
    if (kind === "mochiani-canvas") return "canvas";
    if (kind === "carton-editor") return "carton";
    if (kind === "mochiani-client") return "client";
    return "unknown";
}

function describePage(page) {
    return {
        pageId: page?.pageId || "",
        origin: page?.origin || "",
        siteKind: page?.siteKind || "",
        siteName: page?.siteName || "",
        active: Boolean(page?.active),
        kind: pageKind(page),
        canGenerate: pageKind(page) !== "client" && pageKind(page) !== "unknown",
        workId: firstString(page?.work, RE_WORK_ID),
    };
}

async function readTargetContext(preferredPageId) {
    const pages = await listPages();
    const usable = pages.filter((page) => ["canvas", "carton"].includes(pageKind(page)));
    const pool = usable.length ? usable : pages;
    let page = null;
    if (preferredPageId) page = pool.find((item) => item.pageId === preferredPageId) || null;
    if (!page) page = pool.find((item) => item.active) || pool[0] || null;

    if (!page) {
        throw new BridgeError("MochiAni 一个页面都没连上。请先在浏览器打开 mochiani.com 并保持 MCP 连接。", "NO_MOCHIANI_PAGE", {
            pages: [],
        });
    }
    const kind = pageKind(page);
    if (kind === "client" || kind === "unknown") {
        throw new BridgeError(
            `只看到「${page.siteName || page.siteKind}」，它不能生成。请在 MochiAni 里打开一个作品（无限画布 / 漫剧编辑器）再来。`,
            "MOCHIANI_NO_WORK_PAGE",
            { pages: pages.map(describePage) },
        );
    }
    return { page, pages: pages.map(describePage), kind, pageId: page.pageId, origin: page.origin };
}

// ------------------------------------------------------------ canvas session

async function canvasRead(pageId, origin) {
    return callTool("mochiani_canvas_read", { pageId, origin });
}

/** 新节点的落点：放在现有节点右侧，避免叠在一起。 */
function nextNodePosition(read) {
    const nodes = Array.isArray(read?.nodes) ? read.nodes : [];
    if (!nodes.length) return { x: 0, y: 0 };
    const right = Math.max(...nodes.map((node) => Number(node.x || 0) + Number(node.width || 0) / 2));
    const avgY = nodes.reduce((sum, node) => sum + Number(node.y || 0), 0) / nodes.length;
    return { x: Math.round(right + 360), y: Math.round(avgY) };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 画布里第一个视频节点（模型目录要靠它读，model_options 必须给 nodeId）。 */
function pickVideoNode(read) {
    const nodes = Array.isArray(read?.nodes) ? read.nodes : [];
    return nodes.find((node) => String(node?.kind || "") === "video") || null;
}

/**
 * 从 create_nodes / upload_and_connect 的回执里挑新节点 id。
 * 不同工具用不同键名（affectedIds / createdNodeIds / nodeIds），别只认一个。
 */
function pickNodeId(payload) {
    for (const key of ["affectedIds", "createdNodeIds", "nodeIds", "createdNodeId", "nodeId"]) {
        const value = payload?.[key];
        if (Array.isArray(value) && value.length && typeof value[0] === "string" && value[0]) return value[0];
        if (typeof value === "string" && value) return value;
    }
    const guessed = collectStrings(
        payload,
        (value) => /^(video|image|media|audio|text|music)-[A-Za-z0-9_-]{3,}$/.test(value),
    );
    return guessed[0] || "";
}

/**
 * 等视频节点的生成面板真挂上，拿到 configToken。
 *
 * locate_node 只是把视图挪过去；面板挂没挂上只能看 model_controls.panelMounted。
 * panelMounted=false 时 configure_model 无从下手（它要 expectedConfig），所以这里必须轮询。
 */
async function waitPanelControls(pageId, origin, nodeId, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let located = false;
    let last = null;
    while (Date.now() < deadline) {
        if (!located) {
            located = true;
            // 定位会偶发超时（页面被浏览器节流），但它通常是「慢」而不是「失败」，忽略即可。
            await callTool("mochiani_canvas_locate_node", { pageId, origin, nodeId }).catch(() => null);
        }
        last = await callTool("mochiani_canvas_model_controls", { pageId, origin, nodeId }).catch((error) => ({
            error: error?.message || String(error),
        }));
        if (last?.panelMounted && last?.configToken) return last;
        await sleep(900);
    }
    throw new BridgeError(
        "MochiAni 那个视频节点的生成面板没打开，读不到配置令牌。去 MochiAni 画布点一下该视频节点，再重试。",
        "PANEL_NOT_MOUNTED",
        last,
    );
}

/**
 * 按用户选的「模型 / 渠道 / 参数」改节点配置。
 *
 * 顺序不能乱：
 *   1. 先换模型 —— 换模型会把渠道重置成该模型的默认渠道；
 *   2. 再换渠道；
 *   3. 最后逐个改参数（模型不同，参数键也不同）。
 * 每步都会让 configToken 失效，所以每步之后都要重读 model_controls 拿新 token。
 */
async function applyModelConfig(job, pageId, origin, nodeId, controls) {
    let current = controls;
    let token = String(controls?.configToken || "");
    if (!token) throw new BridgeError("没读到配置令牌，无法切换模型", "NO_CONFIG_TOKEN", controls);

    const step = async (payload, label) => {
        await callTool("mochiani_canvas_configure_model", {
            pageId,
            origin,
            expectedRevision: String(current?.revision || controls?.revision || ""),
            idempotencyKey: randomUUID(),
            nodeId,
            expectedConfig: token,
            ...payload,
        });
        current = await waitPanelControls(pageId, origin, nodeId, 15000);
        token = String(current.configToken || "");
        pushLog(job, label);
    };

    if (job.modelKey && job.modelKey !== String(current.modelKey || "")) {
        await step({ action: "model", value: job.modelKey }, `模型切到 ${job.modelKey}`);
    }
    if (job.channelId && job.channelId !== String(current.channelId || "")) {
        await step({ action: "channel", value: job.channelId }, `渠道切到 ${job.channelId}`);
    }
    for (const [key, value] of Object.entries(job.params || {})) {
        if (value == null || value === "") continue;
        if (String(current.configParams?.[key] ?? "") === String(value)) continue;
        await step({ action: "parameter", parameter: key, value: String(value) }, `参数 ${key}=${value}`);
    }
    return current;
}

const MEDIA_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/ogg": ".ogg",
};

/** 拿不到 content-type 时的兜底后缀 —— 按素材类型给原生端口最认的那个。 */
const KIND_FALLBACK_EXT = { image: ".png", video: ".mp4", audio: ".mp3" };

/** 日志/告警里的人话名字。 */
const KIND_LABEL = { image: "参考图", video: "参考视频", audio: "参考音频" };

function mediaExt(mime, kind) {
    return MEDIA_EXT[String(mime || "").toLowerCase()] || KIND_FALLBACK_EXT[kind] || ".bin";
}

/** 浏览器只能给到 base64（或给一个我们够得着的 URL），MochiAni 的导入工具只认本机绝对路径 —— 所以先落盘。 */
function decodeDataUrl(dataUrl, kind = "image") {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ""));
    if (!match) return null;
    const mime = (match[1] || "").toLowerCase() || (kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png");
    const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    if (!buffer.length) return null;
    return { mime, buffer, ext: mediaExt(mime, kind) };
}

/** 一条参考素材落成临时文件：优先 `dataUrl`（浏览器直传），没有就下载 `url`。 */
async function materializeReference(item, kind, timeoutMs = 180000) {
    const record = typeof item === "string" ? { dataUrl: item } : item || {};
    const dataUrl = String(record.dataUrl || "");
    if (dataUrl.startsWith("data:")) return decodeDataUrl(dataUrl, kind);
    const url = String(record.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return null;
    const mime = String(response.headers.get("content-type") || "").split(";")[0].trim();
    return { mime, buffer, ext: mediaExt(mime, kind) };
}

/** 等素材上传真的完成（节点建出来 ≠ 图已经在 MochiAni 侧可用）。 */
async function waitNodeMedia(pageId, origin, nodeId, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await callTool("mochiani_canvas_get_node", { pageId, origin, nodeId }).catch(() => null);
        const media = last?.media || {};
        if (media.uploadConfirmed === true || media.remoteUrlsPresent === true) return true;
        if (media.uploadError) return false;
        await sleep(1200);
    }
    return false;
}

/**
 * 参考素材：落盘 → upload_and_connect（导入 + 按原生端口规则连线一步到位）。
 * 连完再核一次媒体上传状态，没传完的如实标出来，不假装成功。
 *
 * 图 / 视频 / 音频走同一条路，只有 `mediaType` 不同 —— MCP 那边
 * `mochiani_canvas_upload_and_connect` 支持三种，端口不兼容时它会拒。
 */
async function importReferenceMedia(job, pageId, origin, nodeId, kind) {
    const list = Array.isArray(job[`${kind}s`]) ? job[`${kind}s`] : [];
    const connected = [];
    if (!list.length) return connected;
    const label = KIND_LABEL[kind] || "参考素材";

    const dir = path.join(os.tmpdir(), "mochiani-bridge-refs");
    fs.mkdirSync(dir, { recursive: true });

    for (let index = 0; index < list.length; index += 1) {
        let decoded = null;
        try {
            decoded = await materializeReference(list[index], kind);
        } catch (error) {
            pushLog(job, `${label} ${index + 1} 取不回来：${error?.message || error}`);
            job.warnings.push(`${label} ${index + 1} 下载失败`);
            continue;
        }
        if (!decoded) {
            pushLog(job, `${label} ${index + 1} 既不是可导入的文件、也不是能下载的地址，跳过`);
            job.warnings.push(`${label} ${index + 1} 无法读取`);
            continue;
        }
        const file = path.join(dir, `${job.id}-${kind}-${index + 1}${decoded.ext}`);
        fs.writeFileSync(file, decoded.buffer);
        const read = await canvasRead(pageId, origin);
        const receipt = await callTool("mochiani_canvas_upload_and_connect", {
            pageId,
            origin,
            expectedRevision: read.revision,
            idempotencyKey: randomUUID(),
            localPath: file,
            mediaType: kind,
            targetNodeId: nodeId,
        });
        const mediaNodeId = pickNodeId(receipt);
        if (!mediaNodeId) {
            pushLog(job, `${label} ${index + 1} 没读到节点 ID，可能没导进去`);
            job.warnings.push(`${label} ${index + 1} 导入回执里没有节点 ID`);
            continue;
        }
        if (receipt?.connectionVerified === false) {
            pushLog(job, `${label} ${index + 1} 已导入，但连线未确认（端口可能不兼容）`);
            job.warnings.push(`${label} ${index + 1} 连线未确认`);
        } else {
            pushLog(job, `${label} ${index + 1} 已导入并连上视频节点`);
        }
        const uploaded = await waitNodeMedia(pageId, origin, mediaNodeId);
        if (!uploaded) {
            pushLog(job, `${label} ${index + 1} 上传还没确认，别急着下单`);
            job.warnings.push(`${label} ${index + 1} 上传未确认`);
        }
        connected.push(mediaNodeId);
    }
    return connected;
}

/**
 * 写提示词。
 *
 * ⚠️ 一旦节点连上参考图，提示词在 MochiAni 侧就变成「结构化文档」（有 documentToken + references），
 * 这时 `set_prompt` 会被页面拒绝，而且它吐的错误是没填模板的 `画布操作未执行：{reason}`（页面侧 bug，
 * 看不出真实原因）。所以这里先读 references，有引用就走 `edit_references`，没有才用 `set_prompt`。
 */
async function writeCanvasPrompt(job, pageId, origin, nodeId, fallbackRevision) {
    const refs = await callTool("mochiani_canvas_references", { pageId, origin, nodeId }).catch(() => null);
    const hasReferences = Boolean(refs?.documentToken) && Array.isArray(refs?.references) && refs.references.length > 0;

    if (hasReferences) {
        // 只保留文档里本来就有的引用片段，不新造 chip（连线本身已经让素材参与生成）
        const kept = (Array.isArray(refs.segments) ? refs.segments : [])
            .filter((segment) => segment && typeof segment.referenceId === "string" && segment.referenceId)
            .map((segment) => ({ referenceId: segment.referenceId }));
        await callTool("mochiani_canvas_edit_references", {
            pageId,
            origin,
            expectedRevision: String(refs.revision || fallbackRevision || ""),
            idempotencyKey: randomUUID(),
            nodeId,
            expectedDocument: refs.documentToken,
            segments: [{ text: job.prompt }, ...kept],
        });
        pushLog(job, "提示词已写进节点（带参考图，走结构化引用）");
        return;
    }

    const before = await callTool("mochiani_canvas_generation_context", { pageId, origin, nodeId });
    await callTool("mochiani_canvas_set_prompt", {
        pageId,
        origin,
        expectedRevision: before.revision || fallbackRevision,
        idempotencyKey: randomUUID(),
        nodeId,
        prompt: job.prompt,
        expectedPrompt: before.currentPrompt ?? "",
    });
    pushLog(job, "提示词已写进节点");
}

async function planCanvasJob(job, ctx) {
    const { pageId, origin } = ctx;
    const read = await canvasRead(pageId, origin);
    pushLog(job, `画布版本 ${read?.revision}，现有 ${read?.totalNodes ?? 0} 个节点`);

    const position = nextNodePosition(read);
    const created = await callTool("mochiani_canvas_create_nodes", {
        pageId,
        origin,
        expectedRevision: read.revision,
        idempotencyKey: randomUUID(),
        nodes: [{ kind: "video", x: position.x, y: position.y }],
    });
    const nodeId = pickNodeId(created);
    if (!nodeId) throw new BridgeError("节点已经提交，但没读到节点 ID", "NODE_ID_MISSING", created);
    job.nodeId = nodeId;
    pushLog(job, `已在 MochiAni 画布建好视频节点 ${nodeId}`);

    // 1) 面板 + 模型/渠道/参数（必须在连参考图之前完成：带连线的节点不让切模型）
    let controls = await waitPanelControls(pageId, origin, nodeId);
    if (job.modelKey || job.channelId || Object.keys(job.params || {}).length) {
        controls = await applyModelConfig(job, pageId, origin, nodeId, controls);
    }
    job.modelTarget = {
        modelKey: String(controls?.modelKey || ""),
        channelId: String(controls?.channelId || ""),
        params: controls?.configParams || {},
    };

    // 2) 参考素材：图 → 视频 → 音频（顺序固定，原生端口有容量上限，主素材先占位）
    for (const kind of ["image", "video", "audio"]) {
        const list = job[`${kind}s`];
        if (Array.isArray(list) && list.length) await importReferenceMedia(job, pageId, origin, nodeId, kind);
    }

    // 3) 提示词
    await writeCanvasPrompt(job, pageId, origin, nodeId, created.revision);

    // 4) 回读核验：提示词、模型、渠道三样都必须对上，否则宁可停在预检
    const after = await callTool("mochiani_canvas_generation_context", { pageId, origin, nodeId });
    if (String(after.currentPrompt || "").trim() !== job.prompt) {
        throw new BridgeError("提示词写入后回读不一致，先别下单，去 MochiAni 画布看一眼", "PROMPT_VERIFY_FAILED", after);
    }
    if (job.modelKey && String(after.modelKey || "") !== job.modelKey) {
        throw new BridgeError(
            `模型没切成：要 ${job.modelKey}，节点上实际是 ${after.modelKey || "未知"}`,
            "MODEL_VERIFY_FAILED",
            after,
        );
    }
    if (job.channelId && String(after.channelId || after.modelSupplierId || "") !== job.channelId) {
        pushLog(job, `注意：渠道没切成功（要 ${job.channelId}，实际 ${after.channelId || after.modelSupplierId || "未知"}）`);
        job.warnings.push(`渠道未生效，实际 ${after.channelId || after.modelSupplierId || "未知"}`);
    }

    job.estimate = {
        points: after.estimatedPoints ?? null,
        isEstimate: after.pricingIsEstimate !== false,
        configParams: after.configParams || {},
        labels: after.parameterDisplay?.configParams?.labels || {},
    };
    job.model = { id: after.modelId || "", key: after.modelKey || "", supplierId: after.modelSupplierId || "" };
    pushLog(
        job,
        `预检通过：${describeCost(job.estimate)}${job.estimate.isEstimate ? "（页面预估，非最终扣费）" : ""}`,
    );
    job.stage = "ready";
}

function describeCost(estimate) {
    const labels = estimate?.labels || {};
    const params = Object.entries(labels)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}=${value}`)
        .join(" / ");
    const cost = estimate?.points != null ? `${estimate.points} 灵点` : "费用未知";
    return params ? `${cost}，${params}` : cost;
}

async function confirmCanvasJob(job) {
    const { pageId, origin } = job.work;
    const read = await canvasRead(pageId, origin);
    const ctx = await callTool("mochiani_canvas_generation_context", { pageId, origin, nodeId: job.nodeId });
    if (String(ctx.currentPrompt || "").trim() !== job.prompt) {
        throw new BridgeError("画布上的提示词被改过了，请重新预检", "PROMPT_CHANGED", ctx);
    }
    job.stage = "submitting";
    pushLog(job, "已确认，下发视频生成");
    let receipt;
    try {
        receipt = await callTool("mochiani_canvas_generate_node", {
            pageId,
            origin,
            // 版本用 generation_context 回读到的那个，比前面 canvas_read 的更新
            expectedRevision: String(ctx.revision || read.revision || ""),
            idempotencyKey: randomUUID(),
            nodeId: job.nodeId,
            expectedContext: ctx.contextToken,
            confirmedByUser: true,
        });
    } catch (error) {
        job.stage = "error";
        job.error = error.message;
        pushLog(job, `下发失败：${error.message}`);
        throw error;
    }
    job.operationId = String(receipt?.operationId || "");
    job.receipt = receipt;
    if (!job.operationId) {
        job.stage = "error";
        job.error = "页面已受理，但没返回 operationId，去 MochiAni 画布看节点状态";
        pushLog(job, job.error);
        return job;
    }
    pushLog(job, `已受理，操作 ${job.operationId.slice(0, 8)}`);
    job.stage = "generating";
    startPolling(job);
    return job;
}

async function pollCanvasJob(job) {
    const { pageId, origin } = job.work;
    const op = await callTool("mochiani_canvas_generation_operation", { pageId, origin, operationId: job.operationId });
    const state = String(op?.state || "");
    if (state === "failed") {
        job.stage = "error";
        job.error = String(op?.error || op?.generation?.error || "生成失败");
        pushLog(job, `失败：${job.error}`);
        return "stop";
    }
    const done = op?.completionConfirmed === true || String(op?.generation?.status || "") === "completed";
    if (!done) return "continue";

    const node = await callTool("mochiani_canvas_get_node", { pageId, origin, nodeId: job.nodeId });
    const url = findVideoUrl(node);
    if (!url) {
        pushLog(job, "任务已完成，但节点还没给出视频地址，下一轮再取");
        return "continue";
    }
    job.videoUrl = url;
    job.stage = "done";
    job.error = "";
    pushLog(job, "视频已生成，可以回画布了");
    return "stop";
}

// ------------------------------------------------------- carton 数据适配

/**
 * 漫剧编辑器（carton-editor）跟无限画布是**两套完全不同的口径**：
 *
 * | 想发的东西 | 无限画布 | 漫剧编辑器 |
 * |---|---|---|
 * | 提示词 | 节点 `currentPrompt` | 分镜 `script` |
 * | 人物/场景/道具 | 参考图（上传） | 素材库真 ID（characterIds / sceneIds / propIds） |
 * | 配音 | 音频参考 | 分镜级配音项（characterId + text） |
 * | 模型 | `canvas_model_options` | `get_generation_settings.video.available_options` |
 *
 * 所以这里单独一层适配：模型目录从 generation_settings 拼，素材从素材库按**名字**匹配，
 * 配音按「角色名：台词」解析。别跟 canvas 那套混用。
 */

const CARTON_MODEL_PREFIX = "carton:";

const CARTON_ASSET_LABEL = { character: "出场人物", scene: "场景", prop: "道具", other: "其他素材" };

function readGenerationSettings(pageId, origin) {
    return callTool("mochiani_get_generation_settings", { pageId, origin });
}

function settingsSection(settings, key) {
    const root = settings?.generationSettings || settings || {};
    const section = root[key];
    return section && typeof section === "object" ? section : null;
}

/** `config_options` 里的 value 可能是数字（duration=15）也可能是字符串，面板统一按字符串收。 */
function normalizeConfigOptions(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [key, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        out[key] = list
            .map((item) => {
                if (item == null) return null;
                if (typeof item === "object") {
                    const value = item.value ?? item.val ?? item.id;
                    if (value == null) return null;
                    return { label: String(item.label ?? item.name ?? value), value: String(value) };
                }
                return { label: String(item), value: String(item) };
            })
            .filter(Boolean);
    }
    return out;
}

function mergeConfigOptions(base, extra) {
    const out = { ...base };
    for (const [key, list] of Object.entries(extra || {})) if (!out[key]?.length) out[key] = list;
    return out;
}

/**
 * `video.available_options` → 面板的「模型 → 渠道 → 参数」。
 *
 * ⚠️ 一条 option = 一个 (model_id, supplier_id) 组合，实测 106 条 / 44 个 model_id。
 * 同名不同 id（Minimax H3 = 185/189、Seedance 2.0 = 17/131/183）必须分成两条 ——
 * 它们的渠道池不一样，合并会串号。面板那边会自动给重名的补 `· #id`。
 */
function buildCartonVideoModels(video) {
    const options = Array.isArray(video?.available_options) ? video.available_options : [];
    const models = new Map();
    for (const item of options) {
        const modelId = String(item?.model_id ?? "").trim();
        if (!modelId) continue;
        const modelKey = `${CARTON_MODEL_PREFIX}${modelId}`;
        if (!models.has(modelKey)) {
            models.set(modelKey, {
                modelId,
                modelKey,
                modelName: String(item?.model_name || modelId).trim(),
                kind: "video",
                configInfo: {},
                channels: [],
                mediaLimits: null,
            });
        }
        const entry = models.get(modelKey);
        const configInfo = normalizeConfigOptions(item?.config_options);
        entry.configInfo = mergeConfigOptions(entry.configInfo, configInfo);
        if (item?.is_available === false) continue;
        const supplierId = String(item?.supplier_id ?? "").trim();
        if (!supplierId || entry.channels.some((channel) => channel.id === supplierId)) continue;
        entry.channels.push({
            id: supplierId,
            name: String(item?.supplier_name || supplierId).trim(),
            avgTime: Number(item?.average_time_seconds) || 0,
            successRate: Number(item?.success_rate) || 0,
            price: Number(item?.unit_price) || 0,
            currency: String(item?.currency || ""),
            configInfo,
            defaultParams: normalizeDefaultParams(item?.default_config),
        });
    }

    const limits = video?.limits || {};
    const mediaLimits = {
        image: { required: Number(limits.min_image_num) || 0, max: Number(limits.image_num) || 9 },
        video: { max: Number(limits.video_num) || 0 },
        audio: { max: Number(limits.audio_num) || 0 },
    };
    const list = [...models.values()].filter((item) => item.channels.length);
    for (const item of list) {
        item.mediaLimits = mediaLimits;
        const first = item.channels[0];
        if (first?.defaultParams && Object.keys(first.defaultParams).length) item.defaultParams = first.defaultParams;
    }
    return list;
}

function normalizeDefaultParams(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [key, value] of Object.entries(raw)) {
        if (value == null) continue;
        if (typeof value === "object") continue;
        out[key] = String(value);
    }
    return out;
}

/**
 * 面板回传的参数是字符串，模型那边要的是原类型（duration=15 是数字）。
 * 按候选值反查一次，把类型还原回去；查不到就原样给，让 MochiAni 自己报错。
 */
function coerceCartonParams(params, option) {
    const out = {};
    for (const [key, raw] of Object.entries(params || {})) {
        if (raw == null || raw === "") continue;
        const list = Array.isArray(option?.config_options?.[key]) ? option.config_options[key] : [];
        const hit = list.find((item) => String(item?.value ?? item) === String(raw));
        out[key] = hit ? (hit.value ?? hit) : raw;
    }
    return out;
}

function findCartonOption(video, modelId, supplierId) {
    const options = Array.isArray(video?.available_options) ? video.available_options : [];
    return (
        options.find((item) => String(item?.model_id) === String(modelId) && String(item?.supplier_id) === String(supplierId)) ||
        options.find((item) => String(item?.model_id) === String(modelId)) ||
        null
    );
}

/** 名字 → 素材类别。素材库里几个字段口径不一样，全拼起来一起判。 */
function normalizeAssetKind(token) {
    const text = String(token || "").toLowerCase();
    if (/character|角色|人物|演员|cast/.test(text)) return "character";
    if (/scene|场景|环境|location/.test(text)) return "scene";
    if (/prop|道具|物品|object/.test(text)) return "prop";
    if (/more|other|其他|额外/.test(text)) return "other";
    return "";
}

/**
 * 从 `get_asset_matching_context` 的返回里把素材捞出来。
 *
 * 那个工具的输出结构没写死（角色/场景/道具可能在不同层级、不同键名下），所以按
 * 「有 id + 有 name」认对象，再靠字段名 / 所在键名 / 中文标签判类别。
 */
function collectCartonAssets(root) {
    const out = [];
    const seen = new Set();
    const visit = (value, trail) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const item of value) visit(item, trail);
            return;
        }
        const id = String(value.id ?? value.assetId ?? value.asset_id ?? value.assetID ?? "").trim();
        const name = String(value.name ?? value.assetName ?? value.asset_name ?? value.title ?? "").trim();
        if (id && name && !seen.has(id)) {
            seen.add(id);
            const kind =
                normalizeAssetKind([value.assetType, value.asset_type, value.type, value.kind, value.category, trail].filter(Boolean).join(" ")) ||
                "";
            out.push({ id, name, kind, raw: value });
        }
        for (const [key, child] of Object.entries(value)) visit(child, `${trail} ${key}`);
    };
    visit(root, "");
    return out;
}

/** 精确 → 去空格 → 包含（取最长的那个），都命中不了返回 null。 */
function matchCartonAsset(name, assets) {
    const target = String(name || "").trim();
    if (!target) return null;
    const exact = assets.find((item) => item.name === target);
    if (exact) return exact;
    const loose = assets.find((item) => item.name.replace(/\s+/g, "") === target.replace(/\s+/g, ""));
    if (loose) return loose;
    const partial = assets
        .filter((item) => item.name.length >= 2 && (item.name.includes(target) || target.includes(item.name)))
        .sort((a, b) => b.name.length - a.name.length)[0];
    return partial || null;
}

function splitNames(text) {    return String(text || "")
        .split(/[\n,，、;；|]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * 配音只能挂到「读取配音设置返回的真实角色」上，所以先从 `voiceover` 段里捞角色。
 * 返回 [{id, name}]；捞不到就退回素材库里的角色（resolveCartonAssets 的 voiceCandidates）。
 */
function collectVoiceCharacters(settings) {
    const voiceover = settingsSection(settings, "voiceover");
    const out = [];
    const seen = new Set();
    const visit = (value, trail) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const item of value) visit(item, trail);
            return;
        }
        const id = String(value.characterId ?? value.character_id ?? value.id ?? "").trim();
        const name = String(value.characterName ?? value.character_name ?? value.name ?? "").trim();
        if (id && name && /character|角色|voice/i.test(`${trail} ${Object.keys(value).join(" ")}`) && !seen.has(id)) {
            seen.add(id);
            out.push({ id, name });
        }
        for (const [key, child] of Object.entries(value)) visit(child, `${trail} ${key}`);
    };
    visit(voiceover, "voiceover");
    return out;
}

/** 「角色名：台词」逐行解析；没有冒号的行算旁白（characterId 留空）。 */
function parseVoiceLines(text) {
    const out = [];
    for (const line of String(text || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
        if (match) out.push({ characterName: match[1].trim(), text: match[2].trim() });
        else out.push({ characterName: "", text: trimmed });
    }
    return out.filter((item) => item.text);
}

/**
 * MochiAni 的硬规矩：**关联了哪个素材，分镜文案里就必须出现它的完整正式名**，
 * 否则页面直接拒写。所以缺的名字要补进去，并且告诉用户补了什么。
 */
function composeCartonScript(prompt, groups) {
    const missing = new Map();
    for (const [kind, names] of Object.entries(groups)) {
        for (const name of names) {
            if (!name) continue;
            if (String(prompt).includes(name)) continue;
            if (!missing.has(kind)) missing.set(kind, []);
            if (!missing.get(kind).includes(name)) missing.get(kind).push(name);
        }
    }
    if (!missing.size) return { script: prompt, added: [] };
    const lines = [...missing.entries()].map(([kind, names]) => `${CARTON_ASSET_LABEL[kind] || "素材"}：${names.join("、")}`);
    return {
        script: `${prompt}\n\n${lines.join("\n")}`,
        added: [...missing.values()].flat(),
    };
}

/**
 * 素材名 → 真实 ID。库里没有的按用户选择自动新建（`mochiani_create_asset`）。
 * 返回三类 ID 数组 + 新建/匹配的日志行。
 */
async function resolveCartonAssets({ pageId, origin, projectId, projectName, workId, workName }, groupNames, options = {}) {
    const outcome = {
        ids: { character: [], scene: [], prop: [], other: [] },
        resolvedNames: { character: [], scene: [], prop: [], other: [] },
        created: [],
        missing: [],
        notes: [],
        // 配音兜底用：素材库里的角色也算候选（配音设置里没配角色时靠它）
        voiceCandidates: [],
    };
    const wanted = Object.entries(groupNames).filter(([, names]) => names.length);
    if (!wanted.length) return outcome;

    let assets = [];
    try {
        const context = await callTool("mochiani_get_asset_matching_context", { pageId, origin });
        assets = collectCartonAssets(context);
    } catch (error) {
        outcome.notes.push(`素材库没读到（${error.message}），先按新建处理`);
    }
    outcome.voiceCandidates = assets.filter((item) => item.kind === "character").map((item) => ({ id: item.id, name: item.name }));

    for (const [kind, names] of wanted) {
        for (const name of names) {
            const hit = matchCartonAsset(name, assets);
            if (hit) {
                const bucket = hit.kind || kind;
                if (!outcome.ids[bucket].includes(hit.id)) {
                    outcome.ids[bucket].push(hit.id);
                    outcome.resolvedNames[bucket].push(hit.name);
                }
                if (hit.name !== name) outcome.notes.push(`「${name}」匹配到素材「${hit.name}」`);
                continue;
            }
            if (options.autoCreate === false) {
                outcome.missing.push(name);
                continue;
            }
            try {
                const created = await callTool("mochiani_create_asset", {
                    origin,
                    pageId,
                    projectId,
                    projectName,
                    workId,
                    workName,
                    assetType: kind === "other" ? "other" : kind,
                    name,
                    description: options.descriptions?.[name] || "",
                    idempotencyKey: `atelier-asset-${workId}-${kind}-${name}`,
                });
                const newId = firstString(created, [/^asset_?id$/i, /^created_?asset_?id$/i, /^id$/i]);
                if (!newId) throw new Error("新建成功但没读到素材 ID");
                outcome.ids[kind].push(newId);
                outcome.resolvedNames[kind].push(name);
                outcome.created.push(`${CARTON_ASSET_LABEL[kind]}「${name}」`);
                assets.push({ id: newId, name, kind });
            } catch (error) {
                outcome.missing.push(`${name}（${error.message}）`);
            }
        }
    }
    return outcome;
}

// ------------------------------------------------------------ carton session

async function planCartonJob(job, ctx) {
    const { pageId, origin } = ctx;
    const summary = await callTool("mochiani_get_work_summary", { pageId, origin });
    const projectId = firstString(summary, RE_PROJECT_ID);
    const workId = firstString(summary, RE_WORK_ID);
    if (!projectId || !workId) {
        throw new BridgeError("页面连上了，但读不到作品 ID。请确认当前页是某个作品的编辑页。", "NO_ACTIVE_WORK", summary);
    }
    const projectName = firstString(summary, RE_PROJECT_NAME) || projectId;
    const workName = firstString(summary, RE_WORK_NAME) || workId;
    job.work.projectId = projectId;
    job.work.projectName = projectName;
    job.work.workId = workId;
    job.work.workName = workName;
    pushLog(job, `作品：${workName} / 项目：${projectName}`);

    const workRef = { pageId, origin, projectId, projectName, workId, workName };

    // 1) 视频模型 / 渠道 / 参数 —— 只有跟当前配置不一样才切（切换本身不下发任务）
    const settings = await readGenerationSettings(pageId, origin);
    const video = settingsSection(settings, "video");
    const wantedModelId = job.modelKey.startsWith(CARTON_MODEL_PREFIX) ? job.modelKey.slice(CARTON_MODEL_PREFIX.length) : "";
    const option = wantedModelId ? findCartonOption(video, wantedModelId, job.channelId) : null;
    const modelId = String(option?.model_id || job.modelKey.replace(CARTON_MODEL_PREFIX, "") || video?.model_id || "");
    const supplierId = String(option?.supplier_id || job.channelId || video?.supplier_id || "");
    const selectedConfig = { ...(video?.selected_config || {}), ...coerceCartonParams(job.params, option) };
    job.modelTarget = { modelKey: modelId ? `${CARTON_MODEL_PREFIX}${modelId}` : "", channelId: supplierId, params: selectedConfig };
    job.model = { id: modelId, key: String(video?.model_name || option?.model_name || ""), supplierId };

    const configChanged =
        String(video?.model_id || "") !== modelId ||
        String(video?.supplier_id || "") !== supplierId ||
        Object.entries(coerceCartonParams(job.params, option)).some(([key, value]) => String(video?.selected_config?.[key]) !== String(value));
    if (configChanged && modelId && supplierId) {
        try {
            await callTool("mochiani_update_video_generation_config", {
                ...workRef,
                modelId,
                supplierId,
                selectedConfig,
                expectedConfig: video?.selected_config || {},
                userExplicitlyRequestedModelOrChannelChange: true,
                userRequest: `开源画布节点指定：${option?.model_name || modelId} / ${option?.supplier_name || supplierId}`,
                idempotencyKey: `atelier-vcfg-${job.id}`,
            });
            pushLog(job, `视频配置已切到 ${option?.model_name || modelId} / ${option?.supplier_name || supplierId}`);
        } catch (error) {
            job.warnings.push(`切模型失败，仍按当前配置走：${error.message}`);
            pushLog(job, `切模型失败（继续用当前配置）：${error.message}`);
        }
    }

    // 2) 人物 / 场景 / 道具 —— 名字匹配真实 ID，缺的自动新建
    const cast = job.cast || {};
    const resolved = await resolveCartonAssets(workRef, {
        character: cast.characters || [],
        scene: cast.scenes || [],
        prop: cast.props || [],
    }, { autoCreate: cast.autoCreate !== false });
    for (const line of resolved.notes) pushLog(job, line);
    if (resolved.created.length) pushLog(job, `新建素材：${resolved.created.join("、")}`);
    if (resolved.missing.length) job.warnings.push(`这些素材没关联上：${resolved.missing.join("、")}`);
    job.cast = {
        characters: resolved.resolvedNames.character,
        scenes: resolved.resolvedNames.scene,
        props: resolved.resolvedNames.prop,
        created: resolved.created,
    };
    if (resolved.ids.character.length || resolved.ids.scene.length || resolved.ids.prop.length) {
        pushLog(
            job,
            `关联素材：人物 ${resolved.ids.character.length} · 场景 ${resolved.ids.scene.length} · 道具 ${resolved.ids.prop.length}`,
        );
    }

    // 3) 分镜文案：素材正式名必须出现在文案里，缺的补一行
    const script = composeCartonScript(job.prompt, {
        character: resolved.resolvedNames.character,
        scene: resolved.resolvedNames.scene,
        prop: resolved.resolvedNames.prop,
    });
    if (script.added.length) {
        pushLog(job, `文案里补了素材名：${script.added.join("、")}`);
        job.warnings.push(`自动补了素材名（MochiAni 要求）：${script.added.join("、")}`);
    }
    job.script = script.script;

    const created = await callTool("mochiani_create_shot", {
        ...workRef,
        script: script.script,
        characterIds: resolved.ids.character.length ? resolved.ids.character : undefined,
        sceneIds: resolved.ids.scene.length ? resolved.ids.scene : undefined,
        propIds: resolved.ids.prop.length ? resolved.ids.prop : undefined,
        idempotencyKey: `atelier-plan-${job.id}`,
    });
    const shotId =
        firstString(created, [/^shot_?id$/i, /^created_?shot_?id$/i]) ||
        collectStrings(created, (v) => /^[A-Za-z0-9_-]{6,}$/.test(v))[0] ||
        "";
    if (!shotId) throw new BridgeError("分镜已提交，但没读到 shotId，去 MochiAni 作品里确认", "SHOT_ID_MISSING", created);
    job.nodeId = shotId;
    pushLog(job, `分镜已创建：${shotId}`);

    // 4) 配音 —— 「角色名：台词」逐条写成分镜配音项（这里只写不进，生成放在确认之后）
    const lines = parseVoiceLines(job.voiceoverText || "");
    if (lines.length) {
        const voiceCharacters = collectVoiceCharacters(settings);
        const pool = voiceCharacters.length ? voiceCharacters : resolved.voiceCandidates || [];
        const byName = new Map(pool.map((item) => [item.name, item.id]));
        const items = [];
        for (const line of lines) {
            const characterId = line.characterName ? byName.get(line.characterName) || "" : "";
            if (line.characterName && !characterId) {
                job.warnings.push(`配音「${line.characterName}」没匹配到角色，这条跳过`);
                continue;
            }
            if (!characterId) {
                job.warnings.push(`配音「${line.text.slice(0, 12)}…」没写角色名，MochiAni 要求必须指定角色，跳过`);
                continue;
            }
            try {
                const saved = await callTool("mochiani_create_voiceover_item", {
                    ...workRef,
                    shotId,
                    characterId,
                    text: line.text,
                    idempotencyKey: `atelier-vo-${job.id}-${items.length}`,
                });
                const itemId = firstString(saved, [/^item_?id$/i, /^voiceover_?item_?id$/i, /^id$/i]);
                items.push({ itemId, characterId, characterName: line.characterName, text: line.text });
            } catch (error) {
                job.warnings.push(`配音写入失败（${line.characterName}）：${error.message}`);
            }
        }
        job.voiceItems = items;
        if (items.length) pushLog(job, `配音已写入 ${items.length} 条${job.generateVoice ? "，确认后一起生成" : "（不生成音频）"}`);
    }

    let preflight = null;
    let blocked = "";
    try {
        preflight = await callTool("mochiani_preflight_generation", {
            ...workRef,
            taskType: "video",
            shotIds: [shotId],
        });
    } catch (error) {
        preflight = error.payload ?? { message: error.message };
        blocked = error.message;
        pushLog(job, `预检提示：${error.message}`);
    }
    job.preflight = preflight;
    job.stage = blocked ? "blocked" : "ready";
    if (blocked) job.error = blocked;
    else pushLog(job, "预检通过，等待确认后再花钱生成");
}

async function confirmCartonJob(job) {
    const { origin, pageId, projectId, projectName, workId, workName } = job.work;
    const workRef = { origin, pageId, projectId, projectName, workId, workName };
    job.stage = "submitting";

    // 配音先走：视频生成时会按「分镜现有配音」决定要不要补样音，顺序反了就得再生成一次。
    const voiceItems = Array.isArray(job.voiceItems) ? job.voiceItems : [];
    if (job.generateVoice && voiceItems.length) {
        pushLog(job, `先下发 ${voiceItems.length} 条配音`);
        try {
            const receipt = await callTool("mochiani_generate_voiceovers", {
                ...workRef,
                shotIds: [job.nodeId],
                mode: "all",
                items: voiceItems.map((item) => ({ itemId: item.itemId, characterId: item.characterId, text: item.text })),
                idempotencyKey: `atelier-vo-gen-${job.id}`,
            });
            job.voiceReceipt = receipt;
            pushLog(job, "配音已受理（音频在 MochiAni 里出）");
        } catch (error) {
            job.warnings.push(`配音生成失败（视频照常下发）：${error.message}`);
            pushLog(job, `配音生成失败，继续视频：${error.message}`);
        }
    }

    pushLog(job, "已确认，下发视频生成");
    const receipt = await callTool("mochiani_generate_video", {
        ...workRef,
        shotId: job.nodeId,
        count: 1,
        modelId: job.model?.id || undefined,
        supplierId: job.model?.supplierId || undefined,
        idempotencyKey: `atelier-gen-${job.id}`,
    });
    job.receipt = receipt;
    job.taskId = firstString(receipt, [/^task_?uuid$/i, /^task_?id$/i]) || "";
    pushLog(job, job.taskId ? `已受理，任务 ${job.taskId}` : "已受理，改为看分镜媒体");
    job.stage = "generating";
    startPolling(job);
    return job;
}

async function pollCartonJob(job) {
    const { origin, pageId, projectId, projectName, workId, workName } = job.work;
    const versions = await callTool("mochiani_get_shot_media_versions", {
        origin,
        pageId,
        projectId,
        projectName,
        workId,
        workName,
        shotIds: [job.nodeId],
    }).catch(() => null);
    const url = versions ? findVideoUrl(versions) : "";
    if (url) {
        job.videoUrl = url;
        job.stage = "done";
        job.error = "";
        pushLog(job, "视频已生成，可以回画布了");
        return "stop";
    }
    if (job.taskId) {
        const status = await callTool("mochiani_get_generation_task_status", {
            origin,
            pageId,
            workId,
            mediaType: "video",
            status: "all",
            taskIds: [job.taskId],
            limit: 5,
        }).catch(() => null);
        const failed = status ? collectStrings(status, (v) => /^(failed|failure|cancelled|canceled|rejected)$/i.test(v)).length > 0 : false;
        if (failed) {
            job.stage = "error";
            job.error = "MochiAni 侧标记这个任务失败了，先去作品里看报错，别直接重发";
            job.preflight = status;
            pushLog(job, job.error);
            return "stop";
        }
    }
    return "continue";
}

// -------------------------------------------------------------------- job queue

const jobs = new Map();
const timers = new Map();

function nowIso() {
    return new Date().toISOString();
}

function pushLog(job, message) {
    job.log.push({ at: nowIso(), message: String(message || "") });
    if (job.log.length > 120) job.log.splice(0, job.log.length - 120);
    job.updatedAt = nowIso();
}

function publicJob(job) {
    return {
        id: job.id,
        kind: job.kind,
        stage: job.stage,
        prompt: job.prompt,
        nodeId: job.nodeId,
        taskId: job.taskId,
        operationId: job.operationId,
        videoUrl: job.videoUrl,
        work: job.work,
        preflight: job.preflight,
        estimate: job.estimate,
        model: job.model,
        modelTarget: job.modelTarget || null,
        imageCount: Array.isArray(job.images) ? job.images.length : 0,
        videoCount: Array.isArray(job.videos) ? job.videos.length : 0,
        audioCount: Array.isArray(job.audios) ? job.audios.length : 0,
        // carton 专有：关联上的素材、写进去的配音、以及补过名字之后真正发出去的分镜文案
        cast: job.cast || null,
        script: job.script || "",
        voiceCount: Array.isArray(job.voiceItems) ? job.voiceItems.length : 0,
        voiceItems: Array.isArray(job.voiceItems)
            ? job.voiceItems.map((item) => ({ characterName: item.characterName, text: item.text }))
            : [],
        warnings: job.warnings || [],
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        log: job.log.slice(-30),
    };
}

function createJob(kind, prompt, page, extras = {}) {
    const id = `mj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const job = {
        id,
        kind,
        prompt,
        stage: "planning",
        nodeId: "",
        taskId: "",
        operationId: "",
        videoUrl: "",
        work: { pageId: page.pageId, origin: page.origin, siteName: page.siteName || page.siteKind },
        preflight: null,
        estimate: null,
        model: null,
        modelTarget: null,
        // 用户在面板里选的「模型 / 渠道 / 参数 / 参考素材（图 / 视频 / 音频）」
        modelKey: String(extras.modelKey || "").trim(),
        channelId: String(extras.channelId || "").trim(),
        params: extras.params && typeof extras.params === "object" ? { ...extras.params } : {},
        images: Array.isArray(extras.images) ? extras.images : [],
        videos: Array.isArray(extras.videos) ? extras.videos : [],
        audios: Array.isArray(extras.audios) ? extras.audios : [],
        // carton（漫剧编辑器）专有：出场素材 / 配音 / 是否一起生成配音
        cast: extras.cast && typeof extras.cast === "object" ? extras.cast : null,
        voiceoverText: String(extras.voiceover || ""),
        generateVoice: extras.generateVoice !== false,
        script: "",
        voiceItems: [],
        warnings: [],
        receipt: null,
        error: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        log: [],
        planExpiresAt: Date.now() + PLAN_TTL_MS,
    };
    jobs.set(id, job);
    return job;
}

function pruneJobs() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id, job] of jobs) {
        if (job.stage === "generating") continue;
        if (new Date(job.updatedAt).getTime() < cutoff) {
            jobs.delete(id);
            const timer = timers.get(id);
            if (timer) clearInterval(timer);
            timers.delete(id);
        }
    }
}

async function planJob(prompt, preferredPageId, extras = {}) {
    if (!String(prompt || "").trim()) throw new BridgeError("指令不能为空", "EMPTY_PROMPT");
    const ctx = await readTargetContext(preferredPageId);
    const job = createJob(ctx.kind, String(prompt).trim(), ctx.page, extras);
    pushLog(job, `目标：${ctx.page.siteName || ctx.page.siteKind}（${ctx.kind === "canvas" ? "无限画布" : "漫剧编辑器"}）`);
    try {
        if (ctx.kind === "canvas") await planCanvasJob(job, ctx);
        else await planCartonJob(job, ctx);
        return job;
    } catch (error) {
        job.stage = "error";
        job.error = error?.message || String(error);
        pushLog(job, job.error);
        throw error;
    }
}

async function confirmJob(job) {
    if (job.stage === "generating" || job.stage === "done") return job;
    if (job.stage !== "ready") throw new BridgeError(`当前状态是「${job.stage}」，不能下发`, "JOB_NOT_READY");
    job.error = "";
    return job.kind === "canvas" ? confirmCanvasJob(job) : confirmCartonJob(job);
}

function startPolling(job) {
    stopPolling(job.id);
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let busy = false;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try {
            if (Date.now() > deadline) {
                job.stage = "error";
                job.error = "等待超时（1 小时）。视频可能还在 MochiAni 里跑，别重复下单。";
                pushLog(job, job.error);
                stopPolling(job.id);
                return;
            }
            const verdict = job.kind === "canvas" ? await pollCanvasJob(job) : await pollCartonJob(job);
            if (verdict === "stop") stopPolling(job.id);
        } catch (error) {
            pushLog(job, `轮询出错（继续等）：${error?.message || String(error)}`);
        } finally {
            busy = false;
        }
    };
    timers.set(job.id, setInterval(() => void tick(), POLL_MS));
    void tick();
}

function stopPolling(id) {
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
}

function cancelJob(job) {
    stopPolling(job.id);
    job.stage = "cancelled";
    pushLog(job, "已停止本机轮询。MochiAni 那边的任务不会因此取消，也不会退点。");
    return job;
}

// ------------------------------------------------------------------ http glue

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Mochiani-Token");
    res.setHeader("Access-Control-Max-Age", "86400");
}

function send(res, status, body) {
    cors(res);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve({});
            }
        });
        req.on("error", () => resolve({}));
    });
}

async function handleAccount(query) {
    try {
        const ctx = await readTargetContext(query.pageId || "");
        if (ctx.kind !== "canvas") return { ok: false, error: "余额读取只支持无限画布页面" };
        const data = await callTool("mochiani_canvas_account_context", { pageId: ctx.pageId, origin: ctx.origin });
        return {
            ok: true,
            user: data?.user?.nickname || "",
            points: data?.user?.pointSummary || null,
            source: data?.source || "",
        };
    } catch (error) {
        return { ok: false, code: error.code || "ACCOUNT_FAILED", error: error.message };
    }
}

/**
 * 真实模型目录 —— 面板要像「视频生成窗口」那样先选模型/渠道，就必须读 MochiAni 自己的
 * model_options，不能凭模型名猜（46 个模型里有同名不同 id 的）。
 *
 * model_options 只认 nodeId：画布上没有视频节点时临时建一个当探针（不生成、不花钱），
 * 面板后续把 nodeId 回传给 /api/plan 就能直接复用，不会留一堆空节点。
 */
async function handleModels(query) {
    try {
        const ctx = await readTargetContext(query.pageId || "");
        if (ctx.kind !== "canvas") {
            // 漫剧编辑器没有 `model_options`，模型目录从 generation_settings 的
            // `video.available_options` 拼（一条 = 模型 × 渠道，带 MochiAni 自己的参数与指标）。
            const settings = await readGenerationSettings(ctx.pageId, ctx.origin);
            const video = settingsSection(settings, "video");
            const models = buildCartonVideoModels(video);
            if (!models.length) {
                return { ok: false, code: "NO_CARTON_MODELS", error: "读到了漫剧编辑器，但视频模型目录是空的（去编辑器里看一眼当前模型）" };
            }
            const currentModelKey = video?.model_id ? `${CARTON_MODEL_PREFIX}${video.model_id}` : "";
            return {
                ok: true,
                kind: "carton",
                models,
                current: {
                    modelKey: currentModelKey,
                    channelId: String(video?.supplier_id || ""),
                    params: normalizeDefaultParams(video?.selected_config),
                },
                work: {
                    projectId: String(settings?.project?.id || ""),
                    projectName: String(settings?.project?.title || ""),
                    workId: String(settings?.work?.id || ""),
                    workName: String(settings?.work?.title || ""),
                },
            };
        }
        const { pageId, origin } = ctx;
        const read = await canvasRead(pageId, origin);
        const existing = pickVideoNode(read);
        let nodeId = String(query.nodeId || "") || String(existing?.id || "");
        let probeCreated = false;
        if (!nodeId) {
            const position = nextNodePosition(read);
            const created = await callTool("mochiani_canvas_create_nodes", {
                pageId,
                origin,
                expectedRevision: read.revision,
                idempotencyKey: randomUUID(),
                nodes: [{ kind: "video", x: position.x, y: position.y }],
            });
            nodeId = pickNodeId(created);
            probeCreated = Boolean(nodeId);
        }
        if (!nodeId) return { ok: false, error: "画布上没有视频节点，临时建一个也没成功" };

        const options = await callTool("mochiani_canvas_model_options", { pageId, origin, nodeId });
        const controls = await callTool("mochiani_canvas_model_controls", { pageId, origin, nodeId }).catch(() => null);
        return {
            ok: true,
            nodeId,
            probeCreated,
            revision: String(options?.revision || read.revision || ""),
            models: Array.isArray(options?.options) ? options.options : [],
            panel: controls?.panelMounted
                ? {
                      modelKey: controls.modelKey,
                      channelId: String(controls.channelId || ""),
                      configParams: controls.configParams || {},
                      videoCategories: controls.videoCategories || [],
                      activeVideoCategory: controls.activeVideoCategory ?? null,
                      channelAvailability: controls.channelAvailability || [],
                  }
                : null,
        };
    } catch (error) {
        return { ok: false, code: error.code || "MODELS_FAILED", error: error.message };
    }
}

/** 令牌可以走 `x-mochiani-token` 头、`Authorization: Bearer`，或 `?token=`（方便直接贴 URL）。 */
function readRequestToken(req, url) {
    const header = String(req.headers["x-mochiani-token"] || "").trim();
    if (header) return header;
    const auth = String(req.headers["authorization"] || "").trim();
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
    return String(url.searchParams.get("token") || "").trim();
}

async function handle(req, res) {
    if (req.method === "OPTIONS") {
        cors(res);
        res.statusCode = 204;
        res.end();
        return;
    }
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const isHealth = req.method === "GET" && (pathname === "/" || pathname === "/health");

    // 设了令牌就除了 /health 全要验：健康检查留在外面，画布那边才能区分
    // 「桥没开」和「桥开着但令牌不对」。
    if (TOKEN && !isHealth && readRequestToken(req, url) !== TOKEN) {
        send(res, 401, {
            ok: false,
            code: "UNAUTHORIZED",
            error: "本机桥开启了访问令牌：地址里要带 ?token=…（或在节点里直接填 https://你的域名/?token=你的令牌）",
        });
        return;
    }

    if (isHealth) {
        pruneJobs();
        send(res, 200, {
            ok: true,
            service: "mochiani-canvas-bridge",
            version: "1.5.0",
            mcp: { ...mcpState, root: MCP_ROOT, url: MCP_URL },
            pollMs: POLL_MS,
            jobs: jobs.size,
            authRequired: Boolean(TOKEN),
            hint: TOKEN ? "远程模式：地址需带 ?token=…" : "画布侧默认连 http://127.0.0.1:17399",
        });
        return;
    }

    if (req.method === "GET" && pathname === "/api/context") {
        try {
            const ctx = await readTargetContext(url.searchParams.get("pageId") || "");
            const body = { ok: true, kind: ctx.kind, pages: ctx.pages, target: describePage(ctx.page) };
            if (ctx.kind === "canvas") {
                const read = await canvasRead(ctx.pageId, ctx.origin);
                body.work = { workId: read?.workId || "", nodeCount: read?.totalNodes ?? 0, revision: read?.revision || "" };
            } else {
                const summary = await callTool("mochiani_get_work_summary", { pageId: ctx.pageId, origin: ctx.origin });
                body.work = {
                    projectId: firstString(summary, RE_PROJECT_ID),
                    projectName: firstString(summary, RE_PROJECT_NAME),
                    workId: firstString(summary, RE_WORK_ID),
                    workName: firstString(summary, RE_WORK_NAME),
                };
            }
            send(res, 200, body);
        } catch (error) {
            let pages = [];
            try {
                pages = (await listPages()).map(describePage);
            } catch {
                pages = [];
            }
            send(res, 409, { ok: false, code: error.code || "CONTEXT_FAILED", error: error.message, detail: error.payload ?? null, pages });
        }
        return;
    }

    if (req.method === "GET" && pathname === "/api/account") {
        send(res, 200, await handleAccount({ pageId: url.searchParams.get("pageId") || "" }));
        return;
    }

    if (req.method === "GET" && pathname === "/api/models") {
        const body = await handleModels({
            pageId: url.searchParams.get("pageId") || "",
            nodeId: url.searchParams.get("nodeId") || "",
        });
        send(res, body.ok ? 200 : 409, body);
        return;
    }

    if (req.method === "POST" && pathname === "/api/plan") {
        const body = await readBody(req);
        try {
            const job = await planJob(body.prompt, body.pageId ? String(body.pageId) : "", {
                modelKey: body.modelKey,
                channelId: body.channelId,
                params: body.params,
                images: body.images,
                videos: body.videos,
                audios: body.audios,
                // 漫剧编辑器：出场素材（名字数组）+ 配音台词 + 是否一起生成配音
                cast: body.cast,
                voiceover: body.voiceover,
                generateVoice: body.generateVoice,
            });
            send(res, 200, { ok: true, job: publicJob(job) });
        } catch (error) {
            send(res, 502, { ok: false, code: error.code || "PLAN_FAILED", error: error.message, detail: error.payload ?? null });
        }
        return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(\/confirm|\/cancel)?$/);
    if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) {
            send(res, 404, { ok: false, error: "没有这个任务" });
            return;
        }
        if (jobMatch[2] === "/confirm" && req.method === "POST") {
            try {
                const done = await confirmJob(job);
                send(res, 200, { ok: true, job: publicJob(done) });
            } catch (error) {
                send(res, 502, { ok: false, code: error.code || "CONFIRM_FAILED", error: error.message, detail: error.payload ?? null, job: publicJob(job) });
            }
            return;
        }
        if (jobMatch[2] === "/cancel" && req.method === "POST") {
            send(res, 200, { ok: true, job: publicJob(cancelJob(job)) });
            return;
        }
        if (!jobMatch[2] && req.method === "GET") {
            send(res, 200, { ok: true, job: publicJob(job) });
            return;
        }
        send(res, 405, { ok: false, error: "method not allowed" });
        return;
    }

    if (req.method === "GET" && pathname === "/api/jobs") {
        pruneJobs();
        const list = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(publicJob);
        send(res, 200, { ok: true, jobs: list });
        return;
    }

    // 调试用：直调任意 MochiAni 工具（仅本机监听）。
    if (req.method === "POST" && pathname === "/api/tool") {
        const body = await readBody(req);
        if (!body?.name) {
            send(res, 400, { ok: false, error: "缺 name" });
            return;
        }
        try {
            const data = await callTool(String(body.name), body.args || {});
            send(res, 200, { ok: true, data });
        } catch (error) {
            send(res, 200, { ok: false, code: error.code || "TOOL_ERROR", error: error.message, detail: error.payload ?? null });
        }
        return;
    }

    send(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => send(res, 500, { ok: false, error: error?.message || String(error) }));
});

/**
 * 探针模式：`MOCHIANI_BRIDGE_NO_LISTEN=1` 时只把函数加载进来、不起监听也不连 MCP，
 * 供 `probe-*.mjs` 直接 import 纯函数做离线校验（例如 carton 的模型/素材解析）。
 */
if (process.env.MOCHIANI_BRIDGE_NO_LISTEN === "1") {
    console.log("[mochiani-bridge] probe 模式：不监听端口");
} else {
    server.listen(PORT, HOST, () => {
        console.log(`[mochiani-bridge] listening http://${HOST}:${PORT}`);
        console.log(`[mochiani-bridge] MCP root: ${MCP_ROOT}`);
        console.log(
            TOKEN
                ? "[mochiani-bridge] 远程模式：已启用访问令牌（画布地址要带 ?token=…）"
                : "[mochiani-bridge] 本机模式：无鉴权。若要暴露到公网，请设置 MOCHIANI_BRIDGE_TOKEN",
        );
        if (process.env.MOCHIANI_BRIDGE_LAZY === "1") {
            // 部署形态（服务器上先起桥、MochiAni 后登录）用：不在启动时就抢 MCP 会话。
            console.log("[mochiani-bridge] lazy 模式：等第一次调用接口时再连 MCP");
            return;
        }
        ensureClient()
            .then(() => console.log("[mochiani-bridge] MCP connected"))
            .catch((error) => console.warn("[mochiani-bridge] MCP connect failed:", error?.message || error));
    });
}

export {
    buildCartonVideoModels,
    collectCartonAssets,
    collectVoiceCharacters,
    composeCartonScript,
    coerceCartonParams,
    matchCartonAsset,
    parseVoiceLines,
    normalizeConfigOptions,
};
