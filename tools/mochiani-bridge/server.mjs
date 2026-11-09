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
 *   POST /api/plan     {prompt, pageId, modelKey, channelId, params, images:[{dataUrl}]}
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

const IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

/** 浏览器只能给到 base64，MochiAni 的导入工具只认本机绝对路径 —— 所以先落盘。 */
function decodeDataUrl(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ""));
    if (!match) return null;
    const mime = (match[1] || "image/png").toLowerCase();
    const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    if (!buffer.length) return null;
    return { mime, buffer, ext: IMAGE_EXT[mime] || ".png" };
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
 * 参考图：落盘 → upload_and_connect（导入 + 按原生端口规则连线一步到位）。
 * 连完再核一次媒体上传状态，没传完的如实标出来，不假装成功。
 */
async function importReferenceImages(job, pageId, origin, nodeId, position) {
    const images = Array.isArray(job.images) ? job.images : [];
    const connected = [];
    if (!images.length) return connected;

    const dir = path.join(os.tmpdir(), "mochiani-bridge-refs");
    fs.mkdirSync(dir, { recursive: true });

    for (let index = 0; index < images.length; index += 1) {
        const decoded = decodeDataUrl(images[index]?.dataUrl || images[index]);
        if (!decoded) {
            pushLog(job, `第 ${index + 1} 张参考图不是合法图片数据，跳过`);
            continue;
        }
        const file = path.join(dir, `${job.id}-ref-${index + 1}${decoded.ext}`);
        fs.writeFileSync(file, decoded.buffer);
        const read = await canvasRead(pageId, origin);
        const receipt = await callTool("mochiani_canvas_upload_and_connect", {
            pageId,
            origin,
            expectedRevision: read.revision,
            idempotencyKey: randomUUID(),
            localPath: file,
            mediaType: "image",
            targetNodeId: nodeId,
        });
        const imageNodeId = pickNodeId(receipt);
        if (!imageNodeId) {
            pushLog(job, `第 ${index + 1} 张参考图没读到节点 ID，可能没导进去`);
            job.warnings.push(`参考图 ${index + 1} 导入回执里没有节点 ID`);
            continue;
        }
        if (receipt?.connectionVerified === false) {
            pushLog(job, `参考图 ${index + 1} 已导入，但连线未确认（端口可能不兼容）`);
            job.warnings.push(`参考图 ${index + 1} 连线未确认`);
        } else {
            pushLog(job, `参考图 ${index + 1} 已导入并连上视频节点`);
        }
        const uploaded = await waitNodeMedia(pageId, origin, imageNodeId);
        if (!uploaded) {
            pushLog(job, `参考图 ${index + 1} 上传还没确认，别急着下单`);
            job.warnings.push(`参考图 ${index + 1} 上传未确认`);
        }
        connected.push(imageNodeId);
    }
    void position;
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

    // 2) 参考图
    if (Array.isArray(job.images) && job.images.length) {
        await importReferenceImages(job, pageId, origin, nodeId, position);
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

    const created = await callTool("mochiani_create_shot", {
        origin,
        pageId,
        projectId,
        projectName,
        workId,
        workName,
        script: job.prompt,
        idempotencyKey: `atelier-plan-${job.id}`,
    });
    const shotId =
        firstString(created, [/^shot_?id$/i, /^created_?shot_?id$/i]) ||
        collectStrings(created, (v) => /^[A-Za-z0-9_-]{6,}$/.test(v))[0] ||
        "";
    if (!shotId) throw new BridgeError("分镜已提交，但没读到 shotId，去 MochiAni 作品里确认", "SHOT_ID_MISSING", created);
    job.nodeId = shotId;
    pushLog(job, `分镜已创建：${shotId}`);

    let preflight = null;
    let blocked = "";
    try {
        preflight = await callTool("mochiani_preflight_generation", {
            origin,
            pageId,
            projectId,
            projectName,
            workId,
            workName,
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
    job.stage = "submitting";
    pushLog(job, "已确认，下发视频生成");
    const receipt = await callTool("mochiani_generate_video", {
        origin,
        pageId,
        projectId,
        projectName,
        workId,
        workName,
        shotId: job.nodeId,
        count: 1,
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
        // 用户在面板里选的「模型 / 渠道 / 参数 / 参考图」
        modelKey: String(extras.modelKey || "").trim(),
        channelId: String(extras.channelId || "").trim(),
        params: extras.params && typeof extras.params === "object" ? { ...extras.params } : {},
        images: Array.isArray(extras.images) ? extras.images : [],
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
            return { ok: false, error: "模型目录只支持无限画布页面（漫剧编辑器不提供选模型）" };
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
            version: "1.3.0",
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
