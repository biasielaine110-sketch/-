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
import { createHash, randomUUID } from "node:crypto";
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

/**
 * 作品身份（carton 专用）。
 *
 * ⚠️ `mochiani_get_work_summary` 现在回的是**嵌套**结构：
 * `{ product, pageId, project: { id, title }, work: { id, title, revision }, ... }`。
 * 键名是光秃秃的 `id` / `title`，不带 `project` / `work` 前缀 —— 所以原来那套
 * 「按键名正则全树找 projectId / workId」**永远命中不了**，于是 workId 空 →
 * 前端报「页面连上了，但读不到作品 ID」→ `/api/params` 409、`/api/plan` 502 全军覆没。
 * 这里先按嵌套结构直取，取不到再退回键名正则（兼容老的扁平返回）。
 */
function readWorkIdentity(summary) {
    const pick = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");
    const projectId = pick(summary?.project?.id) || firstString(summary, RE_PROJECT_ID);
    const workId = pick(summary?.work?.id) || firstString(summary, RE_WORK_ID);
    return {
        projectId,
        workId,
        projectName: pick(summary?.project?.title) || firstString(summary, RE_PROJECT_NAME) || projectId,
        workName: pick(summary?.work?.title) || firstString(summary, RE_WORK_NAME) || workId,
    };
}

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

/**
 * 画布节点的矩形。
 *
 * ⚠️ `x/y` 是**左上角**，不是中心 —— 用 `x + width / 2` 当右边界会算少半个宽度，
 * 宽节点（>720px）直接叠到右边那个身上。实测 MochiAni 原生 grid 排出来是
 * `-1723` 与 `-1295`（宽 380 / 542）：左边缘语义下正好留 48px 缝，中心语义会重叠 33px。
 */
const NODE_FALLBACK_W = 520;
const NODE_FALLBACK_H = 300;

/**
 * 把任意种子串算成**确定性 UUID**（v5 形状）。
 *
 * ⚠️ MochiAni 所有写工具的 `idempotencyKey` schema 都是 `"format": "uuid"`，
 * 传业务串（`atelier-plan-xxx`）会被 MCP 直接挡掉：
 * `MCP error -32602: Input validation error: Invalid arguments for tool …: Invalid uuid at idempotencyKey`。
 * 但我们又需要「同一件事重试/重算都落到同一个 key」—— 所以不能直接 `randomUUID()`，
 * 得从 `jobId + 用途` 这种种子**算**出来。用 sha256 取 32 个十六进制，再按 RFC 4122 摆成
 * `8-4-4-4-12`，第 13 位写版本号 5、第 17 位写 variant 位。
 */
function stableUuid(seed) {
    const hex = createHash("sha256").update(String(seed)).digest("hex");
    const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function nodeRect(node) {
    const x = Number(node?.x || 0);
    const y = Number(node?.y || 0);
    const w = Number(node?.width) || NODE_FALLBACK_W;
    const h = Number(node?.height) || NODE_FALLBACK_H;
    return { id: String(node?.id || ""), kind: String(node?.kind || ""), x, y, w, h, right: x + w, bottom: y + h };
}

/** 两个矩形是不是挨着了（gap 是要求的最小间距）。 */
function rectsOverlap(a, b, gap = 24) {
    return a.x < b.right + gap && b.x < a.right + gap && a.y < b.bottom + gap && b.y < a.bottom + gap;
}

/** 新节点的落点：放在现有节点右侧，避免叠在一起。 */
function nextNodePosition(read) {
    const nodes = (Array.isArray(read?.nodes) ? read.nodes : []).map(nodeRect);
    if (!nodes.length) return { x: 0, y: 0 };
    const right = Math.max(...nodes.map((node) => node.right));
    const avgY = Math.round(nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length);
    return { x: Math.round(right + 360), y: avgY };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------- 画布写操作：等空闲 + 重试

/**
 * 等 MochiAni 页面「闲下来」再动手。
 *
 * 页面把每次画布改动都排进自己的队列：先本地生效、再异步落库，落库本身还会再抬一次
 * revision。所以连着发第二个写操作时，页面经常还在处理前一个，这时它**直接拒绝**，
 * 而且吐回来的是没填模板的 `画布操作未执行：{reason}`（页面侧 bug，看不出真实原因）。
 *
 * 实测（2026-11-10，Wan3.0 全能参考）：新建视频节点后连传 3 张参考图，
 * 前两张必成、第三张必挂；每张之前先等 revision 稳定，三张全过。
 *
 * 判据用「连续两次读到同一个 revision」，比 sleep 固定时长可靠：一张 7MB 图和一张
 * 50KB 图的落库耗时差一个数量级，写死等待要么白等要么还是抢跑。
 */
const CANVAS_IDLE_POLL_MS = 700;
const CANVAS_IDLE_STABLE_HITS = 2;

async function waitCanvasIdle(pageId, origin, { stableFor = CANVAS_IDLE_STABLE_HITS, timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    let hits = 0;
    while (Date.now() < deadline) {
        let revision = "";
        try {
            revision = String((await canvasRead(pageId, origin))?.revision || "");
        } catch {
            revision = "";
        }
        if (revision && revision === last) {
            hits += 1;
            if (hits >= stableFor) return revision;
        } else {
            hits = 0;
            last = revision;
        }
        await sleep(CANVAS_IDLE_POLL_MS);
    }
    return last;
}

/** 页面自己弹回来、等一会儿重发就能过的那些错误。 */
function isCanvasBusyError(error) {
    const text = String(error?.message || error || "");
    if (String(error?.code || "") === "CANVAS_REVISION_CONFLICT") return true;
    return /CANVAS_REVISION_CONFLICT|画布操作未执行/.test(text);
}

/** 把页面那种没填占位符的报错翻译成人话。 */
function describeCanvasError(error) {
    const text = String(error?.message || error || "").trim();
    if (!text) return "未知错误";
    if (/画布操作未执行/.test(text)) {
        return "页面拒绝了这次操作（MochiAni 只回了「画布操作未执行」，没给原因，多半是它自己的队列还没处理完）";
    }
    return text;
}

/**
 * 画布写操作的唯一入口：先等页面空闲 → 现读 revision → 发；被挡就退避重试。
 *
 * ⚠️ 重试沿用**同一个** idempotencyKey：万一上一次其实已经落地，MCP 会按 key 去重，
 *    不会在画布上多出一份。所以这里的 key 在循环外生成一次。
 * ⚠️ expectedRevision 一律用**现读的**，不信调用方传进来的旧值。
 */
async function canvasWrite(pageId, origin, toolName, args, { attempts = 3, job = null, label = "" } = {}) {
    const idempotencyKey = args?.idempotencyKey || randomUUID();
    const base = { ...args, idempotencyKey };
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const revision = await waitCanvasIdle(pageId, origin);
        try {
            return await callTool(toolName, { pageId, origin, ...base, expectedRevision: revision });
        } catch (error) {
            lastError = error;
            if (!isCanvasBusyError(error) || attempt >= attempts) break;
            if (job) pushLog(job, `${label || toolName}：页面还在忙，第 ${attempt} 次被挡，等一会儿重发`);
            await sleep(900 * attempt);
        }
    }
    throw lastError;
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

    // ⚠️ step 必须定义在「切模式」之前：v1 把它写在后面，切模式那句会踩 TDZ
    //    （Cannot access 'step' before initialization），只要用户选了生成模式就整单失败。
    const step = async (payload, label) => {
        await canvasWrite(
            pageId,
            origin,
            "mochiani_canvas_configure_model",
            {
                nodeId,
                expectedConfig: token,
                ...payload,
            },
            { job, label },
        );
        current = await waitPanelControls(pageId, origin, nodeId, 15000);
        token = String(current.configToken || "");
        pushLog(job, label);
    };

    // 0) 先切「生成模式」（视频分类）—— 换模式会把模型/参数整套换掉，
    //    所以必须在换模型之前做，否则刚切好的模型会被模式切换重置。
    const wantedCategory = job.videoCategory;
    const categories = Array.isArray(current.videoCategories) ? current.videoCategories : [];
    if (wantedCategory != null) {
        const hit = categories.find((item) => Number(item.key) === Number(wantedCategory));
        const activeKey = current.activeVideoCategory == null ? null : Number(current.activeVideoCategory);
        if (categories.length && !hit) {
            job.warnings.push(`MochiAni 当前没有「${VIDEO_CATEGORY_LABEL[wantedCategory] || wantedCategory}」这个生成模式，沿用节点现在的模式`);
        } else if (hit && hit.compatible === false) {
            job.warnings.push(`「${hit.label}」在这个节点上不可用（${hit.reason || "当前渠道不支持"}），没有切换`);
        } else if (activeKey !== Number(wantedCategory)) {
            // 面板没回读分类时（页面在后台）categories 是空的，这时也照切 ——
            // 失败只记 warning，别把整单带崩；真正生效与否看页面。
            try {
                await step({ action: "video_category", value: String(wantedCategory) }, `生成模式切到 ${hit?.label || VIDEO_CATEGORY_LABEL[wantedCategory] || wantedCategory}`);
            } catch (error) {
                job.warnings.push(`生成模式没切成功（${error?.message || error}），沿用页面当前模式`);
            }
        }
    }

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
        // 一张图挂不上不该把整单带崩：重试过还是不行就记 warning、继续下一张，
        // 让预检能走完（用户看得到具体缺哪张，而不是一个没头的 502）。
        let receipt = null;
        try {
            receipt = await canvasWrite(
                pageId,
                origin,
                "mochiani_canvas_upload_and_connect",
                { localPath: file, mediaType: kind, targetNodeId: nodeId },
                { job, label: `${label} ${index + 1}` },
            );
        } catch (error) {
            pushLog(job, `${label} ${index + 1} 没能连上：${describeCanvasError(error)}`);
            job.warnings.push(`${label} ${index + 1} 没能连上`);
            continue;
        }
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
 * 发送完之后，把 MochiAni 自己那张画布排一下。
 *
 * 参考素材是 `upload_and_connect` 一张张塞进去的，MochiAni 会把新节点就近丢在视频节点旁边，
 * 一连 9 张就叠成一坨（用户反馈「全都叠在一起了」）。
 *
 * 参考节点走**原生** `canvas_layout`（grid）：它自己知道自己的尺寸，比自己算网格稳。
 * 但原生 grid **只认这一批节点**，完全不管画布上已有的东西 —— 多发送几次，新一批参考图
 * 就会整整齐齐地叠在上一批身上（用户反馈「又形成了叠压」）。所以排完还要过一遍
 * `resolveCanvasOverlaps()`：真叠了就整批挪开。
 *
 * 排布是顺手的事，**失败只记 warning**，绝不能把预检带崩。
 */
async function arrangeCanvasNodes(job, pageId, origin, videoNodeId, refIds) {
    const ids = (Array.isArray(refIds) ? refIds : []).filter((id) => typeof id === "string" && id && id !== videoNodeId);
    if (!ids.length) return;
    try {
        if (ids.length > 1) {
            const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(ids.length))));
            await canvasWrite(
                pageId,
                origin,
                "mochiani_canvas_layout",
                { nodeIds: ids, mode: "grid", columns },
                { job, label: "参考节点排版" },
            );
            pushLog(job, `${ids.length} 个参考节点已排成 ${columns} 列网格`);
        }
        const after = await canvasRead(pageId, origin);
        const nodes = (Array.isArray(after?.nodes) ? after.nodes : []).map(nodeRect);
        const refs = nodes.filter((node) => ids.includes(node.id));
        if (!refs.length) return;
        const right = Math.max(...refs.map((node) => node.right));
        const top = Math.min(...refs.map((node) => node.y));
        await canvasWrite(
            pageId,
            origin,
            "mochiani_canvas_move_nodes",
            { moves: [{ nodeId: videoNodeId, x: Math.round(right + 360), y: Math.round(top) }] },
            { job, label: "挪动视频节点" },
        );
        pushLog(job, "视频节点已挪到参考图右侧");
    } catch (error) {
        job.warnings.push(`自动排布没成功（${error?.message || error}），不影响生成`);
    }
}

/**
 * 这一批新节点（视频节点 + 参考图）跟画布上**已有**内容叠了没有？叠了就整批挪开。
 *
 * 为什么必须做：原生 `canvas_layout` 的 grid 只在这批节点内部排版，锚点不管别的节点，
 * 所以每次发送都往同一个位置糊，几轮下来就叠成一坨。这里改成「先量后挪」：
 *   1. 读全画布，按矩形算我们这批跟别人的交叠；
 *   2. 有交叠 → 把这批**整体平移**到「所有别人的最右边界 + 200」，内部相对位置不动；
 *   3. 再读一遍复核（最多 3 轮）。留复核是因为 x/y 语义万一不是左上角，
 *      第一轮会算少一半宽度，第二轮按实测几何再补 —— 有反馈就不会一直错下去。
 *
 * 排布不参与成败：整段失败只记 warning。
 */
async function resolveCanvasOverlaps(job, pageId, origin, batchIds) {
    const ids = new Set((Array.isArray(batchIds) ? batchIds : []).filter(Boolean));
    if (!ids.size) return;
    for (let round = 1; round <= 3; round += 1) {
        let read = null;
        try {
            read = await canvasRead(pageId, origin);
        } catch (error) {
            job.warnings.push(`叠压检查没读成（${describeCanvasError(error)}），不影响生成`);
            return;
        }
        const nodes = (Array.isArray(read?.nodes) ? read.nodes : []).map(nodeRect);
        const mine = nodes.filter((node) => ids.has(node.id));
        const others = nodes.filter((node) => node.id && !ids.has(node.id));
        if (!mine.length || !others.length) return;

        const crowded = mine.filter((item) => others.some((other) => rectsOverlap(item, other)));
        if (!crowded.length) {
            if (round > 1) pushLog(job, "画布已无叠压");
            return;
        }

        // 整批挪到「别人的最右边界 + 200」，内部相对位置原样保留
        const wall = Math.max(...others.map((node) => node.right));
        const shift = Math.round(wall + 200 - Math.min(...mine.map((node) => node.x)));
        if (!Number.isFinite(shift) || shift <= 0) return;
        try {
            await canvasWrite(
                pageId,
                origin,
                "mochiani_canvas_move_nodes",
                { moves: mine.map((node) => ({ nodeId: node.id, x: Math.round(node.x + shift), y: Math.round(node.y) })) },
                { job, label: "挪开叠压的节点" },
            );
            pushLog(job, `${crowded.length} 个节点和画布上已有内容叠压，整批右移 ${shift}px`);
        } catch (error) {
            job.warnings.push(`叠压没挪开（${describeCanvasError(error)}），不影响生成`);
            return;
        }
    }
}

/**
 * 整张画布的「整理」：只动**真撞在一起**的节点，把它们挪到不撞的位置。
 *
 * 和 `resolveCanvasOverlaps` 的区别：那个只管我们刚发过去的那一批（发送时自动跑），
 * 这个管全画布（用户手工点「整理」，收拾历史遗留的叠压）。
 *
 * 摆法对人有意义：先试「往撞到的那个节点下面放」（同类节点竖着排好看），
 * 下面也被占了再往右推。只有真被挪过的节点才发 move，别的保持原位不动。
 */
async function tidyCanvasOverlaps(pageId, origin) {
    let moved = 0;
    for (let round = 1; round <= 6; round += 1) {
        const read = await canvasRead(pageId, origin);
        const nodes = (Array.isArray(read?.nodes) ? read.nodes : []).map(nodeRect).filter((node) => node.id);
        // 从左到右、从上到下摆：先到位的先占坑，后来的让路
        const ordered = nodes.slice().sort((a, b) => a.x - b.x || a.y - b.y);
        const placed = [];
        const moves = [];
        for (const node of ordered) {
            let x = node.x;
            let y = node.y;
            let guard = 0;
            while (guard < 60) {
                const self = { ...node, x, y, right: x + node.w, bottom: y + node.h };
                const hits = placed.filter((other) => rectsOverlap(self, other));
                if (!hits.length) break;
                // 先往「撞到的那些节点的最下面」放
                y = Math.max(...hits.map((other) => other.bottom)) + 72;
                const lowered = { ...node, x, y, right: x + node.w, bottom: y + node.h };
                if (!placed.some((other) => rectsOverlap(lowered, other))) break;
                // 还撞：往右推
                x = Math.max(...hits.map((other) => other.right)) + 200;
                guard += 1;
            }
            if (x !== node.x || y !== node.y) {
                moves.push({ nodeId: node.id, x: Math.round(x), y: Math.round(y) });
            }
            placed.push({ ...node, x, y, right: x + node.w, bottom: y + node.h });
        }
        if (!moves.length) return { moved, rounds: round - 1 };
        await canvasWrite(pageId, origin, "mochiani_canvas_move_nodes", { moves }, { label: "整理画布" });
        moved += moves.length;
    }
    return { moved, rounds: 6 };
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
        await canvasWrite(
            pageId,
            origin,
            "mochiani_canvas_edit_references",
            {
                nodeId,
                expectedDocument: refs.documentToken,
                segments: [{ text: job.prompt }, ...kept],
            },
            { job, label: "写提示词（结构化引用）" },
        );
        pushLog(job, "提示词已写进节点（带参考图，走结构化引用）");
        return;
    }

    const before = await callTool("mochiani_canvas_generation_context", { pageId, origin, nodeId });
    await canvasWrite(
        pageId,
        origin,
        "mochiani_canvas_set_prompt",
        {
            nodeId,
            prompt: job.prompt,
            expectedPrompt: before.currentPrompt ?? "",
        },
        { job, label: "写提示词" },
    );
    pushLog(job, "提示词已写进节点");
}

async function planCanvasJob(job, ctx) {
    const { pageId, origin } = ctx;
    const read = await canvasRead(pageId, origin);
    pushLog(job, `画布版本 ${read?.revision}，现有 ${read?.totalNodes ?? 0} 个节点`);

    const position = nextNodePosition(read);
    const created = await canvasWrite(
        pageId,
        origin,
        "mochiani_canvas_create_nodes",
        { nodes: [{ kind: "video", x: position.x, y: position.y }] },
        { job, label: "新建视频节点" },
    );
    const nodeId = pickNodeId(created);
    if (!nodeId) throw new BridgeError("节点已经提交，但没读到节点 ID", "NODE_ID_MISSING", created);
    job.nodeId = nodeId;
    pushLog(job, `已在 MochiAni 画布建好视频节点 ${nodeId}`);

    // 1) 面板 + 模型/渠道/参数（必须在连参考图之前完成：带连线的节点不让切模型）
    let controls = await waitPanelControls(pageId, origin, nodeId);
    if (job.modelKey || job.channelId || Object.keys(job.params || {}).length || job.videoCategory != null) {
        controls = await applyModelConfig(job, pageId, origin, nodeId, controls);
    }
    if (job.videoCategory != null) {
        const active = controls?.activeVideoCategory;
        if (active != null && Number(active) !== Number(job.videoCategory)) {
            job.warnings.push(
                `生成模式没切成功：要 ${VIDEO_CATEGORY_LABEL[job.videoCategory] || job.videoCategory}，节点上是 ${VIDEO_CATEGORY_LABEL[Number(active)] || active}`,
            );
        }
    }
    job.modelTarget = {
        modelKey: String(controls?.modelKey || ""),
        channelId: String(controls?.channelId || ""),
        params: controls?.configParams || {},
    };

    // 2) 参考素材：图 → 视频 → 音频（顺序固定，原生端口有容量上限，主素材先占位）
    const refNodeIds = [];
    for (const kind of ["image", "video", "audio"]) {
        const list = job[`${kind}s`];
        if (Array.isArray(list) && list.length) {
            const connected = await importReferenceMedia(job, pageId, origin, nodeId, kind);
            refNodeIds.push(...connected);
        }
    }

    // 2.5) 排一下 MochiAni 画布：参考图网格，视频节点挪到右侧（失败只告警）
    await arrangeCanvasNodes(job, pageId, origin, nodeId, refNodeIds);

    // 2.6) 多发送几次会跟上一批叠在一起：真叠了就把这一整批挪到空白处（失败只告警）
    await resolveCanvasOverlaps(job, pageId, origin, [nodeId, ...refNodeIds]);

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

/**
 * 视频「生成模式」= MochiAni 的 `specific_type`（视频分类），不是模型参数。
 *
 * 来源：MochiAni 前端自己的映射表（`{0:智能参考,1:首尾帧,3:多参考图,4:首帧,9:文生视频,11:全能参考,12:合规资产}`），
 * 它的视频面板默认就是「取第一个 specific_type=11（全能参考）的模型」——
 * 所以我们这边默认也走 11，跟原生一致。
 *
 * ⚠️ 各模式能吃什么素材完全不同：11/3/0 收图+视频+音频，1（首尾帧）只收 2 张图，9（文生视频）不收素材。
 */
const VIDEO_CATEGORY_LABEL = {
    0: "智能参考",
    1: "首尾帧",
    3: "多参考图",
    4: "首帧",
    9: "文生视频",
    11: "全能参考",
    12: "合规资产",
};

/** 默认生成模式：全能参考（MochiAni 原生视频面板的默认值）。 */
const DEFAULT_VIDEO_CATEGORY = 11;

/** 一条模型候选上的分类字段 —— 页面侧几种写法都兜住，别因为换了个 key 就整块失效。 */
function readVideoCategory(item) {
    const raw = item?.specific_type ?? item?.specificType ?? item?.model_specific_type;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

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
                /** 视频分类（11=全能参考）—— 前端按它做「生成模式」筛选与默认选中。 */
                specificType: readVideoCategory(item),
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
 * 从分镜文案里读出「哪张图是谁」。
 *
 * 两种真实写法都要认：
 *
 * 1. 连接词在前：`@图片1 为男主，图片2 为女主` → 整段是给桥看的声明，进分镜前整条摘掉。
 * 2. 名字在前 + 冒号：`@图片1 女模：女模人物参考，锁定面容…`（脚本生成器「资产锁定」那种）
 *    → 只摘掉 `@图片1` 这个标记，`女模：女模人物参考…` 留在文案里
 *    （名字留着正好满足 MochiAni「关联素材名必须出现在文案里」的硬规矩）。
 *
 * 画布连进来的参考图顺序就是 `job.images` 的顺序（`图片1` = 第 1 张），解析结果
 * `[{ marker, index, kind, name }]` 由 planCartonJob 建素材 + 传素材图。
 *
 * **不写连接词、后面也不跟冒号的，一律不解析** —— 否则「参考图片1 和图片2」会被读成素材名。
 */
const CARTON_IMAGE_MARKER =
    /@?图片\s*([0-9]{1,2})\s*(?:(?:作为|当作|为|是|＝|=|→|->|:|：)\s*([^\s，,。；;、：:!！?？"'（）()\[\]【】]{1,20})|([^\s：:，,。；;、]{1,20})\s*(?=[：:]))/gu;
/** 名字里带类别前缀时顺带定类型：`图片2 为场景咖啡馆`。 */
const CARTON_NAME_KIND_HINT = [
    { prefix: "角色", kind: "character" },
    { prefix: "人物", kind: "character" },
    { prefix: "场景", kind: "scene" },
    { prefix: "道具", kind: "prop" },
];

/**
 * 按**词尾**猜素材类型（只在用户没写类别前缀时兜底）。
 *
 * 为什么值得猜：`@图片2 白色得皮包：…` 默认当角色建，包里那张图就会挂成「角色」——
 * 图是能挂上，但素材库分类就乱了、分镜里也会按角色绑。猜错的代价只是类型不同，图照样挂上，
 * 所以这里用「宁窄勿宽」的词尾表，别拿它当语义理解。
 */
const CARTON_PROP_SUFFIX = [
    "包", "袋", "鞋", "靴", "帽", "裙", "裤", "衣", "外套", "手套", "围巾",
    "眼镜", "墨镜", "手机", "手表", "项链", "耳环", "手链", "戒指", "发夹",
    "车", "桌", "椅", "床", "沙发", "灯", "杯", "瓶", "伞", "枪", "刀", "剑",
    "盒", "箱", "扇", "钟", "镜", "书本", "画框", "花瓶",
];
const CARTON_SCENE_SUFFIX = [
    "室", "厅", "房", "街", "楼", "店", "馆", "场", "园", "山", "海", "林",
    "桥", "站", "廊", "阳台", "天台", "院", "巷", "教室", "办公室", "厨房",
    "卧室", "走廊", "客厅", "洗手间",
];

function guessAssetKindByName(name) {
    const key = String(name || "").trim();
    if (!key) return "character";
    if (CARTON_PROP_SUFFIX.some((suffix) => key.endsWith(suffix))) return "prop";
    if (CARTON_SCENE_SUFFIX.some((suffix) => key.endsWith(suffix))) return "scene";
    return "character";
}

function parseImageBindings(prompt, imageCount) {
    const out = [];
    const seen = new Set();
    const text = String(prompt || "");
    for (const match of text.matchAll(CARTON_IMAGE_MARKER)) {
        const index = Number(match[1]) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= imageCount) continue;
        // 组 2 = 连接词在前的写法；组 3 = 「名字 + 冒号」的写法
        let name = String(match[2] || match[3] || "").trim();
        if (!name) continue;
        let kind = match[2] ? "character" : guessAssetKindByName(name);
        let typed = false;
        for (const hint of CARTON_NAME_KIND_HINT) {
            if (name.startsWith(hint.prefix) && name.length > hint.prefix.length) {
                kind = hint.kind;
                name = name.slice(hint.prefix.length).trim();
                typed = true;
                break;
            }
        }
        if (!typed) {
            // `图片2 为场景 咖啡馆`：类别词被空格隔开单独成词时，名字在它后面
            const hint = CARTON_NAME_KIND_HINT.find((item) => item.prefix === name);
            if (hint) {
                const rest = text.slice(match.index + match[0].length);
                const next = /^\s*[:：]?\s*([^\s，,。；;、：:!！?？"'（）()\[\]【】]{1,20})/.exec(rest);
                if (next) {
                    kind = hint.kind;
                    name = next[1].trim();
                }
            }
        }
        // `图片1 为男主（林晚）`：括号里是备注，素材名只用前面的「男主」
        name = name.replace(/[（(][^（）()]*[）)]$/, "").trim();
        if (!name) continue;
        const key = `${kind}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ marker: `图片${match[1]}`, index, kind, name });
    }
    return out;
}

/**
 * 「图片节点标题 = 素材名」这条**零填写**路径。
 *
 * 前端把连线进来的每张图连同**节点标题**和它在 `job.images` 里的下标一起塞进 `cast.images`，
 * `kind` 标成 `"auto"`。这里翻成素材绑定（类型按名字词尾猜）。
 *
 * 标题是「图片1 / 屏幕截图 / image_2」这种没语义的**直接跳过** ——
 * 凭空建一堆叫「图片1」的素材，比不挂图更糟。
 */
const CARTON_PLACEHOLDER_TITLE =
    /^(?:图片|图像|参考图|截图|屏幕截图|未命名|image|img|photo|screenshot|untitled|ref)[\s_#.-]*\d*$/i;

function collectAutoImageBindings(castImages) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(castImages) ? castImages : []) {
        if (String(entry?.kind || "") !== "auto") continue;
        const name = String(entry?.name || "").trim();
        if (!name || CARTON_PLACEHOLDER_TITLE.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
            name,
            kind: guessAssetKindByName(name),
            index: Number.isInteger(entry?.index) ? entry.index : -1,
            entry,
        });
    }
    return out;
}

/**
 * 只数「文案点了哪几张图」（1 起），用来发现「写了 @图片3 但只连了 1 张图」这种静默丢失。
 */
function readImageMarkerIndices(prompt) {
    const out = [];
    for (const match of String(prompt || "").matchAll(CARTON_IMAGE_MARKER)) out.push(Number(match[1]));
    return out;
}

/**
 * 把「`@图片1 为男主`」这类**只给桥看**的指图声明从分镜文案里摘掉。
 *
 * 不摘的话这行会原样进 MochiAni 的分镜文案，被视频模型当成画面内容（"图片1"、"为"）。
 * 摘掉之后素材正式名可能就不在文案里了 —— 这没关系，`composeCartonScript()`
 * 会按 MochiAni 的硬要求补一行「出场人物：男主、女主」。
 */
function stripImageBindingMarkers(prompt) {
    return String(prompt || "")
        // 连接词写法整条摘掉；「名字：描述」写法只摘 `@图片N` 标记，名字留在文案里
        .replace(CARTON_IMAGE_MARKER, (_match, _num, _connected, colonName) => (colonName ? colonName : ""))
        .replace(/[，,、；;](?:[ \t]*[，,、；;])+/g, "，")
        .replace(/^[ \t]*[，,、；;。.][ \t]*/gm, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * 把前端给的图（`dataUrl` 或 `http(s)` 地址）落成本机临时文件。
 *
 * 为什么必须落盘：MochiAni 的 `mochiani_upload_asset_images` 只收**本机绝对路径**，
 * 不认 URL、更不认 base64。画布上的图通常是图床/R2 的公网地址，桥所在机器能直接下载。
 */
const CAST_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const CAST_IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };

async function materializeReferenceImage(entry, sink) {
    const dir = path.join(os.tmpdir(), "mochiani-bridge-images");
    await fs.promises.mkdir(dir, { recursive: true });

    const write = async (buffer, mime) => {
        if (!buffer?.length) throw new Error("图是空的");
        if (buffer.length > CAST_IMAGE_MAX_BYTES) throw new Error(`图超过 ${CAST_IMAGE_MAX_BYTES / 1024 / 1024}MB`);
        const ext = CAST_IMAGE_EXT[String(mime || "").toLowerCase()] || "png";
        const file = path.join(dir, `${randomUUID()}.${ext}`);
        await fs.promises.writeFile(file, buffer);
        sink.push(file);
        return file;
    };

    const dataUrl = String(entry?.dataUrl || "");
    if (dataUrl.startsWith("data:")) {
        const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
        if (!match) throw new Error("dataUrl 格式不对");
        const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
        return write(buffer, match[1] || "image/png");
    }

    const url = String(entry?.url || "");
    if (/^https?:\/\//i.test(url)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        return write(buffer, response.headers.get("content-type") || "image/png");
    }
    throw new Error("既没有 dataUrl 也没有 http 地址");
}

/**
 * 从 `mochiani_create_asset` 的回执里读素材 ID。
 *
 * 回执形状没在文档里写死，直接字段之外再探一层嵌套（`{asset:{id}}` / `{data:{assetId}}`），
 * 否则「素材建出来了、图没挂上」会变成最难查的一类静默失败。
 */
function readAssetId(payload) {
    const direct = firstString(payload, [/^asset_?id$/i, /^created_?asset_?id$/i, /^id$/i]);
    if (direct) return direct;
    for (const key of ["asset", "created", "data", "result"]) {
        const nested = payload?.[key];
        if (!nested || typeof nested !== "object") continue;
        const id = firstString(nested, [/^asset_?id$/i, /^id$/i]);
        if (id) return id;
    }
    return "";
}

/**
 * 素材名 → 真实 ID。库里没有的按用户选择自动新建（`mochiani_create_asset`）。
 * 返回三类 ID 数组 + 新建/匹配的日志行。
 */
async function resolveCartonAssets({ pageId, origin, projectId, projectName, workId, workName }, groupNames, options = {}) {
    const outcome = {
        ids: { character: [], scene: [], prop: [], other: [] },
        resolvedNames: { character: [], scene: [], prop: [], other: [] },
        /** 名字 → 真实素材 ID（匹配到别名/新建都记），上传素材图时按它对齐。 */
        byName: { character: {}, scene: {}, prop: {}, other: {} },
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
                // 原名和命中名都记一份：用户填「林晚」、库里叫「林晚_正式」，图也得挂得上。
                outcome.byName[bucket][name] = hit.id;
                outcome.byName[bucket][hit.name] = hit.id;
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
                    idempotencyKey: stableUuid(`asset:${workId}:${kind}:${name}`),
                });
                const newId = readAssetId(created);
                if (!newId) throw new Error("新建成功但没读到素材 ID");
                outcome.ids[kind].push(newId);
                outcome.resolvedNames[kind].push(name);
                outcome.byName[kind][name] = newId;
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
    const { projectId, workId, projectName, workName } = readWorkIdentity(summary);
    if (!projectId || !workId) {
        throw new BridgeError("页面连上了，但读不到作品 ID。请确认当前页是某个作品的编辑页。", "NO_ACTIVE_WORK", summary);
    }
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
    let option = wantedModelId ? findCartonOption(video, wantedModelId, job.channelId) : null;

    /**
     * 生成模式（视频分类）在漫剧编辑器里**是模型自带的**，不是单独的开关 ——
     * 「全能参考」= 挑一个 `specific_type=11` 的模型。所以没指定模型时按模式挑第一个可用的，
     * 指定了但不是那个模式就如实告警（不偷偷换成别的模型）。
     */
    const wantedCategory = job.videoCategory == null ? null : Number(job.videoCategory);
    if (!option && wantedCategory != null) {
        const options = Array.isArray(video?.available_options) ? video.available_options : [];
        const hit = options.find((item) => readVideoCategory(item) === wantedCategory && item?.is_available !== false);
        if (hit) {
            option = hit;
            pushLog(job, `生成模式「${VIDEO_CATEGORY_LABEL[wantedCategory] || wantedCategory}」→ 选模型 ${hit.model_name || hit.model_id}`);
        } else {
            job.warnings.push(`漫剧编辑器里没有「${VIDEO_CATEGORY_LABEL[wantedCategory] || wantedCategory}」模式可用的模型，沿用当前模型`);
        }
    }
    if (option && wantedCategory != null) {
        const actual = readVideoCategory(option);
        if (actual != null && actual !== wantedCategory) {
            job.warnings.push(
                `你选的模型属于「${VIDEO_CATEGORY_LABEL[actual] || actual}」模式，不是「${VIDEO_CATEGORY_LABEL[wantedCategory] || wantedCategory}」；以模型为准`,
            );
        }
    }
    const modelId = String(option?.model_id || job.modelKey.replace(CARTON_MODEL_PREFIX, "") || video?.model_id || "");
    const supplierId = String(option?.supplier_id || job.channelId || video?.supplier_id || "");
    const selectedConfig = { ...(video?.selected_config || {}), ...coerceCartonParams(job.params, option) };
    job.modelTarget = { modelKey: modelId ? `${CARTON_MODEL_PREFIX}${modelId}` : "", channelId: supplierId, params: selectedConfig };
    job.model = { id: modelId, key: String(option?.model_name || video?.model_name || ""), supplierId };

    const configChanged =
        String(video?.model_id || "") !== modelId ||
        String(video?.supplier_id || "") !== supplierId ||
        Object.entries(coerceCartonParams(job.params, option)).some(([key, value]) => String(video?.selected_config?.[key]) !== String(value));
    // 只有真的切了才把 modelId / supplierId 显式带给 generate_video ——
    // 没切就让它沿用编辑器当前配置，别让 MochiAni 以为我们在「未经用户要求改配置」。
    job.modelSwitched = configChanged;
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
                idempotencyKey: stableUuid(`vcfg:${job.id}`),
            });
            pushLog(job, `视频配置已切到 ${option?.model_name || modelId} / ${option?.supplier_name || supplierId}`);
        } catch (error) {
            job.warnings.push(`切模型失败，仍按当前配置走：${error.message}`);
            pushLog(job, `切模型失败（继续用当前配置）：${error.message}`);
        }
    }

    // 2) 人物 / 场景 / 道具 —— 名字匹配真实 ID，缺的自动新建
    const cast = job.cast || {};
    const castImages = Array.isArray(cast.images) ? cast.images : [];
    /**
     * 文案里指名的图（`@图片1 为男主`）并进素材清单一起解析 ——
     * 用户只写文案、不填「出场素材」是最常见的情况，不并进来的话图就落不到任何素材上。
     */
    const bindings = parseImageBindings(job.prompt, Array.isArray(job.images) ? job.images.length : 0);
    /**
     * 静默丢失是本功能最容易踩的坑：写 `@图片3 为路人` 但只连了 2 张图时，
     * 图根本不会上传，用户却只看到「文字过去了、图没过去」。这里主动告警。
     */
    const imageTotal = Array.isArray(job.images) ? job.images.length : 0;
    const outOfRange = [...new Set(readImageMarkerIndices(job.prompt))].filter((n) => n > imageTotal);
    if (outOfRange.length) {
        const list = outOfRange.map((n) => `图片${n}`).join("、");
        job.warnings.push(`文案里的 ${list} 没有对应参考图（只连了 ${imageTotal} 张），这几张图不会上传`);
    }
    /** 零填写路径：连线图片的**节点标题就是素材名**（`kind:"auto"`，见 collectAutoImageBindings）。 */
    const autoBindings = collectAutoImageBindings(castImages);
    const groups = {
        character: [...(cast.characters || [])],
        scene: [...(cast.scenes || [])],
        prop: [...(cast.props || [])],
    };
    for (const binding of bindings) {
        if (!groups[binding.kind].includes(binding.name)) groups[binding.kind].push(binding.name);
        pushLog(job, `文案指定：${binding.marker} → ${CARTON_ASSET_LABEL[binding.kind]}「${binding.name}」`);
    }
    for (const binding of autoBindings) {
        if (groups[binding.kind].includes(binding.name)) continue;
        groups[binding.kind].push(binding.name);
        pushLog(job, `图片标题：${binding.name} → ${CARTON_ASSET_LABEL[binding.kind]}`);
    }
    /**
     * 连了图却一个素材名都拿不到 —— 这是「图静默丢失」最常见的形态，必须说出来。
     * 两种情况：图片节点标题是「图片1」这种没语义的；文案里也没写「@图片1 为名字」。
     */
    const namedAny = bindings.length + autoBindings.length > 0;
    const castFilled = groups.character.length + groups.scene.length + groups.prop.length > 0;
    if (imageTotal > 0 && !namedAny && !castFilled) {
        job.warnings.push(
            `连了 ${imageTotal} 张图，但没有任何素材名：把图片节点标题改成角色/场景/道具名，或在文案里写「@图片1 为名字」`,
        );
    }
    const resolved = await resolveCartonAssets(workRef, groups, { autoCreate: cast.autoCreate !== false });
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

    /**
     * 2.5) 素材图 —— 三个来源，上传前合并去重（优先级从高到低）：
     *  a) 节点「图块」里按名字对上的（`cast.images`，kind = characters/scenes/props）；
     *  b) 文案里点名的图（`@图片1 为男主` → `job.images[0]`，1.6.5 起）；
     *  c) 连线图片的**节点标题就是素材名**（`kind:"auto"`，1.6.7 起，零填写）。
     *
     * 图只补形象，不参与分镜文案；一张传失败不影响出片，只记 warning。
     * 顺序必须在素材解析之后（要真 ID）、上传完再建分镜（MochiAni 建分镜时就要用到素材现图）。
     */
    const uploads = [];
    const tempFiles = [];
    const queueUpload = (assetType, name, entry, label) => {
        const assetId = String(resolved.byName?.[assetType]?.[name] || "");
        if (!assetId) {
            job.warnings.push(`${label}「${name}」没对上素材 ID，跳过`);
            return;
        }
        uploads.push({ assetType, assetId, name, entry, label });
    };
    const typeOfKind = { characters: "character", scenes: "scene", props: "prop" };
    for (const entry of castImages) {
        const assetType = typeOfKind[String(entry?.kind || "")];
        const name = String(entry?.name || "").trim();
        if (!assetType || !name) continue;
        queueUpload(assetType, name, entry, "素材图");
    }
    for (const binding of bindings) {
        const entry = job.images[binding.index];
        if (!entry) continue;
        queueUpload(binding.kind, binding.name, entry, `${binding.marker} 素材图`);
    }
    // 文案点名过的下标不再走标题路径（同一张图不挂两个素材）
    const claimedIndices = new Set(bindings.map((binding) => binding.index));
    for (const binding of autoBindings) {
        if (claimedIndices.has(binding.index)) continue;
        queueUpload(binding.kind, binding.name, binding.entry, `图片「${binding.name}」`);
    }
    if (uploads.length) {
        // 同一个素材只传一张：显式挂的图排前面，文案指名的图不覆盖它
        const seenAssets = new Set();
        const items = [];
        let skipped = 0;
        for (const upload of uploads) {
            const key = `${upload.assetType}:${upload.assetId}`;
            if (seenAssets.has(key)) {
                skipped += 1;
                continue;
            }
            try {
                const localPath = await materializeReferenceImage(upload.entry, tempFiles);
                seenAssets.add(key);
                items.push({ assetType: upload.assetType, assetId: upload.assetId, localPath });
            } catch (error) {
                job.warnings.push(`${upload.label}「${upload.name}」没传：${error.message}`);
            }
        }
        if (skipped) pushLog(job, `${skipped} 张图对应同一素材，只传了第一张`);
        if (items.length) {
            try {
                await callTool("mochiani_upload_asset_images", { ...workRef, items });
                pushLog(job, `素材图已上传 ${items.length} 张（人物/场景/道具的形象图）`);
            } catch (error) {
                /**
                 * 整批失败时逐张重试：一批里有一张坏图（素材被删、图超大）会连坐整批，
                 * 而用户要的是「尽量多挂上」，所以降级成单张重试，只把真失败的那张记 warning。
                 */
                let okCount = 0;
                const failures = [];
                for (const item of items) {
                    try {
                        await callTool("mochiani_upload_asset_images", { ...workRef, items: [item] });
                        okCount += 1;
                    } catch (itemError) {
                        failures.push(itemError.message);
                    }
                }
                if (okCount) pushLog(job, `素材图逐张重试后成功 ${okCount}/${items.length} 张`);
                if (failures.length) {
                    job.warnings.push(`素材图上传失败 ${failures.length} 张（仍按文字素材继续）：${failures[0]}`);
                }
                if (!okCount && !failures.length) job.warnings.push(`素材图上传失败：${error.message}`);
            }
        }
        for (const file of tempFiles) fs.promises.rm(file, { force: true }).catch(() => {});
    }

    // 3) 分镜文案：素材正式名必须出现在文案里，缺的补一行
    //    指图声明（`@图片1 为男主`）是给桥看的，不能原样进分镜文案
    const script = composeCartonScript(bindings.length ? stripImageBindingMarkers(job.prompt) : job.prompt, {
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
        idempotencyKey: stableUuid(`plan:${job.id}`),
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
                // `text` 的 schema 上限是 200 字，超了会被 MCP 挡回来
                const spoken = line.text.length > 200 ? line.text.slice(0, 200) : line.text;
                if (spoken !== line.text) job.warnings.push(`配音「${line.characterName}」超过 200 字，已截断`);
                const saved = await callTool("mochiani_create_voiceover_item", {
                    ...workRef,
                    shotId,
                    characterId,
                    text: spoken,
                    idempotencyKey: stableUuid(`vo:${job.id}:${items.length}`),
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
            /**
             * ⚠️ `items` 的每一项是 `{ shotId, itemIds }`（`itemIds` 是**数组**），
             * 不是 `{ itemId, characterId, text }` —— 后者会被 schema 的
             * `additionalProperties: false` 直接挡回来（报 Invalid arguments）。
             */
            const itemIds = voiceItems.map((item) => item.itemId).filter(Boolean);
            const receipt = await callTool("mochiani_generate_voiceovers", {
                ...workRef,
                shotIds: [job.nodeId],
                mode: "all",
                ...(itemIds.length ? { items: [{ shotId: job.nodeId, itemIds }] } : {}),
                idempotencyKey: stableUuid(`vogen:${job.id}`),
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
        ...(job.modelSwitched
            ? {
                  modelId: job.model?.id || undefined,
                  supplierId: job.model?.supplierId || undefined,
                  userExplicitlyRequestedModelOrChannelChange: true,
                  userRequest: `开源画布节点指定：${job.model?.key || job.model?.id || ""}`,
              }
            : {}),
        idempotencyKey: stableUuid(`gen:${job.id}`),
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
        videoCategory: job.videoCategory ?? null,
        videoCategoryLabel: job.videoCategory == null ? "" : VIDEO_CATEGORY_LABEL[job.videoCategory] || "",
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
        /**
         * 视频生成模式（MochiAni 的 `specific_type`）：11=全能参考。
         * 空 = 不干预，沿用编辑器/节点当前模式。
         */
        videoCategory: extras.videoCategory == null || extras.videoCategory === "" ? null : Number(extras.videoCategory),
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
        job.error = describeCanvasError(error);
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

/** `model_options` 的数组可能叫 options / list / models，取第一个有内容的；都没有就是空。 */
function readOptionList(payload) {
    for (const candidate of [payload?.options, payload?.list, payload?.models]) {
        if (Array.isArray(candidate) && candidate.length) return candidate;
    }
    return [];
}

/**
 * `model_controls.editableParameters` → `{ 参数键: [{label,value,priceRatio}] }`。
 *
 * 🔴 这是**唯一**能拿到完整参数表的地方。MochiAni 的画幅（`model_size`）挂在**模型**的
 * `modelSize` 逗号串上，由它前端在 `configInfo` 缺这一项时临时合进去；而 `model_options`
 * 和渠道 `configInfo` 里都没有这一项 —— 所以只看 `configInfo` 的画幅选择器会凭空消失
 * （`Seedance2.0 fast` 的 AL 线路、`Wan3.0` 的阿里云线路全是这种情况）。
 */
function readParamOptions(controls) {
    const out = {};
    const list = Array.isArray(controls?.editableParameters) ? controls.editableParameters : [];
    for (const item of list) {
        const key = String(item?.key || "").trim();
        const options = Array.isArray(item?.options) ? item.options : [];
        if (!key || !options.length) continue;
        const normalized = options
            .map((option) => {
                const value = String(option?.value ?? option?.label ?? "").trim();
                const label = String(option?.label ?? option?.value ?? "").trim() || value;
                return { label, value, priceRatio: Number(option?.priceRatio) || 1 };
            })
            .filter((option) => option.value);
        if (normalized.length) out[key] = normalized;
    }
    return out;
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
            /**
             * 「生成模式」候选：优先用设置里直接给的 `video_categories`（原生面板口径），
             * 没有就从模型目录里实际出现的分类倒推 —— 没出现的模式不给，免得选了没模型。
             */
            const nativeCategories = Array.isArray(video?.video_categories) ? video.video_categories : [];
            const categoryKeys = [...new Set(models.map((item) => item.specificType).filter((value) => value != null))].sort((a, b) => a - b);
            const videoCategories = nativeCategories.length
                ? nativeCategories.map((item) => ({
                      key: Number(item?.key ?? item?.value ?? item?.specific_type),
                      label: String(item?.label || VIDEO_CATEGORY_LABEL[Number(item?.key ?? item?.value)] || ""),
                      compatible: item?.compatible !== false,
                      reason: String(item?.reason || ""),
                  }))
                : categoryKeys.map((key) => ({
                      key,
                      label: VIDEO_CATEGORY_LABEL[key] || `分类 ${key}`,
                      compatible: true,
                      modelCount: models.filter((item) => item.specificType === key).length,
                  }));
            const currentCategory =
                video?.active_video_category != null
                    ? Number(video.active_video_category)
                    : (videoCategories.find((item) => item.key === models.find((m) => m.modelKey === currentModelKey)?.specificType)?.key ?? null);
            return {
                ok: true,
                kind: "carton",
                models,
                videoCategories,
                activeVideoCategory: currentCategory,
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

        // ⚠️ MochiAni 的 model_options 是从「已挂载的生成面板」里读的，不是现成的接口。
        // 节点在视口外（画布做了虚拟化）或页面被浏览器挂起时，panelMounted=false、
        // options=[] —— 这时**不是没有模型**。按 MCP 自己的建议先 locate_node 把节点
        // 挪进视口、唤醒面板，再重读一次；还是空就明确报错，别让面板安静地留个空下拉。
        let options = await callTool("mochiani_canvas_model_options", { pageId, origin, nodeId });
        let controls = await callTool("mochiani_canvas_model_controls", { pageId, origin, nodeId }).catch(() => null);

        /**
         * 空目录 ≠ 没模型。实测最常见的两种情况：
         *  ① 桥跑久了，MCP 侧还捏着旧的页面会话 —— 节点 id 对得上，读出来却是空数组。
         *     （重启桥立刻恢复 44 个模型，所以这是**会话陈旧**，不是页面本身的问题。）
         *  ② 视频节点在视口外 / 页面被浏览器挂起，生成面板没挂载。
         * 所以先掐掉 MCP 连接重连一次（不重启进程），还空再去 locate 唤醒面板。
         */
        let wokePanel = false;
        let reconnected = false;
        if (!readOptionList(options).length) {
            resetClient("模型目录为空，掐掉 MCP 连接重读一次");
            reconnected = true;
            try {
                options = await callTool("mochiani_canvas_model_options", { pageId, origin, nodeId });
                controls = await callTool("mochiani_canvas_model_controls", { pageId, origin, nodeId }).catch(() => null);
            } catch {
                // 重连也读不到就往下走 locate，别在这里抛 —— 报错文案要能同时覆盖两种情况。
            }
        }
        if (!readOptionList(options).length) {
            wokePanel = true;
            try {
                await callTool("mochiani_canvas_locate_node", { pageId, origin, nodeId });
            } catch (error) {
                // locate 需要页面回执。超时 = 浏览器把 MochiAni 那个标签页挂起了（冻结的后台页
                // 不跑 JS），纯读还能拿到缓存，所以只有这一步会超时。
                if (/超时|timeout|暂停|suspend/i.test(String(error?.message || ""))) {
                    return {
                        ok: false,
                        code: "PAGE_SUSPENDED",
                        error: "MochiAni 页面被浏览器挂起了，模型目录读不到。切到那个标签页点一下（或刷新）再点「重新读取」。",
                        nodeId,
                        probeCreated,
                    };
                }
                throw error;
            }
            await sleep(400);
            options = await callTool("mochiani_canvas_model_options", { pageId, origin, nodeId });
            controls = await callTool("mochiani_canvas_model_controls", { pageId, origin, nodeId }).catch(() => null);
        }
        const models = readOptionList(options);
        if (!models.length) {
            return {
                ok: false,
                code: "MODEL_OPTIONS_EMPTY",
                error: reconnected
                    ? "MochiAni 的模型目录读出来是空的（已自动重连 + 定位节点重试过）。去 MochiAni 页面看一眼那个视频节点的模型/渠道还在不在，然后点「重新读取」。"
                    : "MochiAni 读到了生成面板，但模型目录是空的：去看一眼那个视频节点当前的模型/渠道还在不在。",
                nodeId,
                probeCreated,
                revision: String(options?.revision || read.revision || ""),
            };
        }
        return {
            ok: true,
            nodeId,
            probeCreated,
            wokePanel,
            reconnected,
            revision: String(options?.revision || read.revision || ""),
            models,
            panel: controls?.panelMounted
                ? {
                      modelKey: controls.modelKey,
                      modelId: String(controls.modelId || ""),
                      channelId: String(controls.channelId || ""),
                      configParams: controls.configParams || {},
                      /** 节点当前模型/渠道的**完整**参数候选（含 `configInfo` 里没有的画幅）。 */
                      editableParameters: readParamOptions(controls),
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

/** 参数探测按节点排队：并发 `configure_model` 会互相踩 revision / configToken。 */
const paramQueues = new Map();
function serializeByNode(nodeId, task) {
    const previous = paramQueues.get(nodeId) || Promise.resolve();
    const next = previous.then(task, task);
    paramQueues.set(
        nodeId,
        next.catch(() => null),
    );
    return next;
}

/**
 * 按「用户选的模型 / 渠道 / 生成模式」回读节点上真实的参数表。
 *
 * 🔴 为什么非要多打这一趟：`configInfo` 只管渠道级参数，**画幅不在里面**（见 `readParamOptions`）。
 * 完整参数表只存在于 `model_controls.editableParameters`，而它描述的是「节点当前那套模型/渠道」——
 * 所以想查「用户选的这套」有什么参数，只能先把节点切过去再读回来。
 *
 * 顺序照 `applyModelConfig`：生成模式 → 模型 → 渠道（换模式会把模型整套重置）。
 * 每一步都容错：切不动只记 warning，仍然把当前参数表返给面板，别让选择器整个空掉。
 */
async function handleParams(query) {
    try {
        const ctx = await readTargetContext(query.pageId || "");
        if (ctx.kind !== "canvas") {
            return {
                ok: false,
                code: "NOT_CANVAS",
                error: "只有无限画布这条链路需要参数探测（漫剧编辑器的参数在模型目录的 configInfo 里）",
            };
        }
        const { pageId, origin } = ctx;
        const read = await canvasRead(pageId, origin);
        const existing = pickVideoNode(read);
        let nodeId = String(query.nodeId || "").trim() || String(existing?.id || "");
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
        if (!nodeId) return { ok: false, code: "NO_VIDEO_NODE", error: "画布上没有视频节点，临时建一个也没成功" };

        return await serializeByNode(nodeId, async () => {
            let controls = await waitPanelControls(pageId, origin, nodeId, 20000);
            const applied = [];
            const warnings = [];
            const step = async (payload, label) => {
                try {
                    await callTool("mochiani_canvas_configure_model", {
                        pageId,
                        origin,
                        expectedRevision: String(controls?.revision || ""),
                        idempotencyKey: randomUUID(),
                        nodeId,
                        expectedConfig: String(controls?.configToken || ""),
                        ...payload,
                    });
                    controls = await waitPanelControls(pageId, origin, nodeId, 15000);
                    applied.push(label);
                } catch (error) {
                    warnings.push(`${label}没成功（${error?.message || error}）`);
                }
            };

            const wantedCategory = query.videoCategory == null || query.videoCategory === "" ? null : Number(query.videoCategory);
            if (wantedCategory != null && String(controls.activeVideoCategory ?? "") !== String(wantedCategory)) {
                const hit = (controls.videoCategories || []).find((item) => Number(item.key) === wantedCategory);
                if (hit && hit.compatible === false) {
                    warnings.push(`「${hit.label}」当前不可用（${hit.reason || "渠道不支持"}），沿用原模式`);
                } else {
                    await step({ action: "video_category", value: String(wantedCategory) }, `生成模式切到 ${hit?.label || wantedCategory}`);
                }
            }

            const wantedModel = String(query.modelKey || "").trim();
            if (wantedModel && wantedModel !== String(controls.modelKey || "")) {
                await step({ action: "model", value: wantedModel }, `模型切到 ${wantedModel}`);
            }

            const wantedChannel = String(query.channelId || "").trim();
            if (wantedChannel && wantedChannel !== String(controls.channelId || "")) {
                await step({ action: "channel", value: wantedChannel }, `渠道切到 ${wantedChannel}`);
            }

            return {
                ok: true,
                nodeId,
                probeCreated,
                modelKey: String(controls.modelKey || ""),
                modelId: String(controls.modelId || ""),
                channelId: String(controls.channelId || ""),
                activeVideoCategory: controls.activeVideoCategory ?? null,
                params: controls.configParams || {},
                options: readParamOptions(controls),
                categories: controls.videoCategories || [],
                applied,
                warnings,
            };
        });
    } catch (error) {
        return { ok: false, code: error?.code || "PARAMS_FAILED", error: error?.message || String(error) };
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
            version: "1.6.7",
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
                const identity = readWorkIdentity(summary);
                body.work = {
                    projectId: identity.projectId,
                    projectName: identity.projectName,
                    workId: identity.workId,
                    workName: identity.workName,
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

    if (req.method === "GET" && pathname === "/api/params") {
        const body = await handleParams({
            pageId: url.searchParams.get("pageId") || "",
            nodeId: url.searchParams.get("nodeId") || "",
            modelKey: url.searchParams.get("modelKey") || "",
            channelId: url.searchParams.get("channelId") || "",
            videoCategory: url.searchParams.get("videoCategory"),
        });
        send(res, body.ok ? 200 : 409, body);
        return;
    }

    // 整理画布：把撞在一起的节点挪开（发送时只自动检查「刚发的这一批」，历史遗留靠这个收拾）
    if (req.method === "POST" && pathname === "/api/tidy") {
        const body = await readBody(req);
        try {
            const ctx = await readTargetContext(body.pageId ? String(body.pageId) : "");
            if (ctx.kind !== "canvas") {
                send(res, 409, { ok: false, error: "只有「无限画布」能整理节点排版，漫剧编辑器不走这套" });
                return;
            }
            const result = await tidyCanvasOverlaps(ctx.pageId, ctx.origin);
            send(res, 200, { ok: true, pageId: ctx.pageId, moved: result.moved, rounds: result.rounds });
        } catch (error) {
            send(res, 502, { ok: false, code: error.code || "TIDY_FAILED", error: describeCanvasError(error), detail: error.payload ?? null });
        }
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
                // 视频生成模式（11=全能参考）；不传就沿用页面当前模式
                videoCategory: body.videoCategory,
                // 漫剧编辑器：出场素材（名字数组）+ 配音台词 + 是否一起生成配音
                cast: body.cast,
                voiceover: body.voiceover,
                generateVoice: body.generateVoice,
            });
            send(res, 200, { ok: true, job: publicJob(job) });
        } catch (error) {
            send(res, 502, { ok: false, code: error.code || "PLAN_FAILED", error: describeCanvasError(error), detail: error.payload ?? null });
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
    collectAutoImageBindings,
    collectVoiceCharacters,
    composeCartonScript,
    coerceCartonParams,
    guessAssetKindByName,
    matchCartonAsset,
    parseImageBindings,
    parseVoiceLines,
    readImageMarkerIndices,
    normalizeConfigOptions,
    readParamOptions,
    readWorkIdentity,
    stableUuid,
    stripImageBindingMarkers,
};
