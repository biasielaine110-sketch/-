/**
 * Bridge so WorkBuddy can drive the open canvas over MCP or HTTP.
 * The browser page posts its snapshot, polls commands, executes them, and posts results.
 * Local dev uses process memory. Serverless deployments should configure Vercel KV / Upstash
 * Redis REST env vars so state is shared across function instances.
 */

const GENERATE_TIMEOUT_MS = 12 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20_000;
const SERVERLESS_MAX_WAIT_MS = 280_000;
const ACCESS_TOKEN = process.env.CANVAS_BRIDGE_TOKEN || "";
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const STORE_PREFIX = process.env.CANVAS_BRIDGE_STORE_PREFIX || "canvas-bridge";
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const state = {
    snapshot: null,
    commands: [],
    waiters: new Map(),
    results: new Map(),
};

const TOOLS = [
    {
        name: "list_canvas_nodes",
        description: "列出当前打开的无限画布项目里的节点，包含提示词、尺寸、位置、生成状态。调用其它工具前先用它确认 nodeId。",
        inputSchema: {
            type: "object",
            properties: { projectId: { type: "string", description: "可选。指定后只操作该项目，避免误连其它打开的画布。" } },
            additionalProperties: false,
        },
    },
    {
        name: "create_text_node",
        description: "在当前打开的画布中创建文本节点。适合把 WorkBuddy 的说明、提示词、计划或批注放到画布上。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "可选。目标画布项目 id。" },
                content: { type: "string", description: "文本内容" },
                x: { type: "number", description: "可选。画布坐标 x，不填则放在当前视口中心附近。" },
                y: { type: "number", description: "可选。画布坐标 y，不填则放在当前视口中心附近。" },
            },
            required: ["content"],
        },
    },
    {
        name: "create_image_node",
        description: "在当前打开的画布中创建图片节点。imageUrl 必须是浏览器可访问且可解码的图片 URL。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "可选。目标画布项目 id。" },
                imageUrl: { type: "string", description: "图片 URL" },
                prompt: { type: "string", description: "可选。写入节点的提示词或来源说明。" },
                x: { type: "number", description: "可选。画布坐标 x。" },
                y: { type: "number", description: "可选。画布坐标 y。" },
            },
            required: ["imageUrl"],
        },
    },
    {
        name: "export_image_data",
        description: "按 storageKey 从当前打开的画布浏览器中导出图片 data URL。通常由 /api/canvas-bridge/image 使用。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "可选。目标画布项目 id。" },
                storageKey: { type: "string", description: "图片 storageKey，例如 image:xxx" },
                nodeId: { type: "string", description: "可选。存储缺失时从画布节点显示图兜底读取。" },
            },
            required: ["storageKey"],
        },
    },
    {
        name: "set_canvas_prompt",
        description: "把提示词写到指定画布节点。nodeId 来自 list_canvas_nodes。",
        inputSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "节点 id" },
                prompt: { type: "string", description: "要写入的提示词" },
            },
            required: ["nodeId", "prompt"],
        },
    },
    {
        name: "set_canvas_size",
        description: "按 1k、2k、4k 设置图片节点的画布尺寸。aspect 可用 1:1、16:9、9:16、3:2、2:3、4:3、3:4，省略时保持节点当前比例，没有则用 1:1。",
        inputSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string" },
                tier: { type: "string", enum: ["1k", "2k", "4k"], description: "分辨率档位" },
                aspect: { type: "string", description: "比例，例如 16:9" },
            },
            required: ["nodeId", "tier"],
        },
    },
    {
        name: "generate_canvas_node",
        description: "用该节点当前的提示词和尺寸触发生成，并等待画布返回结果。浏览器里必须开着对应项目。",
        inputSchema: {
            type: "object",
            properties: { nodeId: { type: "string" } },
            required: ["nodeId"],
        },
    },
];

function cors(res, req) {
    const origin = req?.headers?.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
}

function sendJson(req, res, status, body) {
    cors(res, req);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

function authorized(req) {
    if (!ACCESS_TOKEN) return true;
    const auth = String(req.headers?.authorization || "");
    if (auth === `Bearer ${ACCESS_TOKEN}`) return true;
    const url = new URL(req.url || "/", "http://localhost");
    return url.searchParams.get("token") === ACCESS_TOKEN;
}

function requireAuth(req, res) {
    if (authorized(req)) return true;
    sendJson(req, res, 401, { ok: false, error: "unauthorized" });
    return false;
}

function key(name) {
    return `${STORE_PREFIX}:${name}`;
}

function commandKey(id) {
    return key(`command:${id}`);
}

function resultKey(id) {
    return key(`result:${id}`);
}

async function redis(command) {
    const response = await fetch(REDIS_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${REDIS_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
        throw new Error(data?.error || `Redis REST request failed: ${response.status}`);
    }
    return data?.result;
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataUrlToBuffer(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const body = match[3] || "";
    const buffer = match[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
    return { mimeType, buffer };
}

function safeFilename(value, fallback) {
    const text = String(value || fallback || "image").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
    return text || fallback || "image";
}

function extensionForMime(mimeType) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/svg+xml") return "svg";
    return "png";
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve(raw);
            }
        });
        req.on("error", () => resolve(null));
    });
}

function publicNodes(snapshot = state.snapshot) {
    const nodes = snapshot?.nodes || [];
    return nodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        prompt: node.prompt || "",
        size: node.size || "",
        status: node.status || "idle",
        model: node.model || "",
        canvasName: node.canvasName || node.model || "",
        hasImage: Boolean(node.hasImage),
        imageUrl: node.imageUrl || "",
        thumbnailUrl: node.thumbnailUrl || "",
        storageKey: node.storageKey || "",
        thumbnailStorageKey: node.thumbnailStorageKey || "",
        images: Array.isArray(node.images) ? node.images : [],
        width: node.width || 0,
        height: node.height || 0,
        position: node.position || null,
        error: node.error || "",
    }));
}

async function setSnapshot(snapshot) {
    state.snapshot = snapshot;
    if (USE_REDIS) {
        await redis(["SET", key("snapshot"), JSON.stringify(snapshot), "EX", 120]);
    }
}

async function getSnapshot() {
    if (!USE_REDIS) return state.snapshot;
    return parseJson(await redis(["GET", key("snapshot")]), null);
}

function createCommand(name, args) {
    return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        args: args || {},
        status: "pending",
        createdAt: Date.now(),
    };
}

async function enqueue(name, args) {
    const command = createCommand(name, args);
    if (USE_REDIS) {
        await redis(["SET", commandKey(command.id), JSON.stringify(command), "EX", 1800]);
        await redis(["RPUSH", key("commands"), command.id]);
        return command.id;
    }
    state.commands.push(command);
    state.commands = state.commands.filter((item) => Date.now() - item.createdAt < 30 * 60 * 1000);
    return command.id;
}

async function takePendingCommands() {
    if (USE_REDIS) {
        const ids = (await redis(["LRANGE", key("commands"), 0, 49])) || [];
        if (!ids.length) return [];
        await redis(["LTRIM", key("commands"), ids.length, -1]);
        const values = ids.length === 1 ? [await redis(["GET", commandKey(ids[0])])] : await redis(["MGET", ...ids.map(commandKey)]);
        return (values || []).map((value) => parseJson(value, null)).filter(Boolean).map((item) => ({ id: item.id, name: item.name, args: item.args }));
    }
    const pending = state.commands.filter((item) => item.status === "pending");
    for (const item of pending) item.status = "dispatched";
    return pending.map((item) => ({ id: item.id, name: item.name, args: item.args }));
}

async function finishCommand(id, result) {
    if (USE_REDIS) {
        await redis(["SET", resultKey(id), JSON.stringify({ ok: result?.ok !== false, ...result }), "EX", 1800]);
        const raw = await redis(["GET", commandKey(id)]);
        const command = parseJson(raw, null);
        if (command) {
            command.status = "done";
            await redis(["SET", commandKey(id), JSON.stringify(command), "EX", 1800]);
        }
        return true;
    }
    const command = state.commands.find((item) => item.id === id);
    if (command) command.status = "done";
    state.results.set(id, { ok: result?.ok !== false, ...result });
    const waiter = state.waiters.get(id);
    if (!waiter) return Boolean(command);
    clearTimeout(waiter.timer);
    state.waiters.delete(id);
    waiter.resolve(result);
    return true;
}

async function getResult(id) {
    if (USE_REDIS) return parseJson(await redis(["GET", resultKey(id)]), null);
    return state.results.get(id) || null;
}

async function waitForResult(id, timeout) {
    if (!USE_REDIS) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                state.waiters.delete(id);
                resolve({ ok: false, commandId: id, error: "画布没有响应。请用浏览器打开这个项目页，并保持页面不要关掉。" });
            }, timeout);
            state.waiters.set(id, { resolve, timer });
        });
    }
    const started = Date.now();
    const maxWait = Math.min(timeout, SERVERLESS_MAX_WAIT_MS);
    while (Date.now() - started < maxWait) {
        const result = await getResult(id);
        if (result) return { commandId: id, ...result };
        await delay(500);
    }
    return { ok: false, commandId: id, error: "画布没有及时回传结果。可稍后用 /api/canvas-bridge/result?id=... 查询。" };
}

async function callTool(name, args, options = {}) {
    const snapshot = await getSnapshot();
    if (!snapshot) {
        return { ok: false, error: "还没有画布连上来。请先在浏览器打开要操作的项目。" };
    }
    const requestedProjectId = args?.projectId ? String(args.projectId) : "";
    if (requestedProjectId && requestedProjectId !== snapshot.projectId) {
        return { ok: false, error: `当前连上的画布是 ${snapshot.projectId}，不是 ${requestedProjectId}` };
    }
    if (name === "list_canvas_nodes") {
        return {
            ok: true,
            projectId: snapshot.projectId,
            updatedAt: snapshot.updatedAt,
            nodes: publicNodes(snapshot),
        };
    }
    if (!TOOLS.some((tool) => tool.name === name)) {
        return { ok: false, error: `未知工具 ${name}` };
    }
    const id = await enqueue(name, args || {});
    if (options.wait === false) return { ok: true, commandId: id, queued: true };
    const timeout = name === "generate_canvas_node" ? GENERATE_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    return waitForResult(id, timeout);
}

function rpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcp(req, res) {
    cors(res, req);
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (!requireAuth(req, res)) return;
    if (req.method === "GET") {
        const snapshot = await getSnapshot();
        sendJson(req, res, 200, {
            name: "infinite-atelier",
            connected: Boolean(snapshot),
            projectId: snapshot?.projectId || "",
            updatedAt: snapshot?.updatedAt || 0,
            tools: TOOLS.map((tool) => tool.name),
            store: USE_REDIS ? "redis" : "memory",
        });
        return;
    }
    if (req.method !== "POST") {
        sendJson(req, res, 405, { error: "method not allowed" });
        return;
    }
    const message = await readBody(req);
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        sendJson(req, res, 400, rpcError(null, -32700, "请求必须是 JSON-RPC 对象"));
        return;
    }
    const { id, method, params } = message;
    if (id === undefined || String(method || "").startsWith("notifications/")) {
        res.statusCode = 202;
        cors(res, req);
        res.end();
        return;
    }
    if (method === "initialize") {
        res.setHeader("Mcp-Session-Id", "atelier");
        sendJson(req, res, 200, rpcResult(id, {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "infinite-atelier", version: "1.0.0" },
        }));
        return;
    }
    if (method === "ping") {
        sendJson(req, res, 200, rpcResult(id, {}));
        return;
    }
    if (method === "tools/list") {
        sendJson(req, res, 200, rpcResult(id, { tools: TOOLS }));
        return;
    }
    if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || params?.args || {};
        try {
            const data = await callTool(name, args, { wait: params?.wait !== false });
            sendJson(req, res, 200, rpcResult(id, {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
                isError: data?.ok === false,
            }));
        } catch (error) {
            sendJson(req, res, 200, rpcResult(id, {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            }));
        }
        return;
    }
    sendJson(req, res, 200, rpcError(id, -32601, `不支持的方法 ${method || ""}`));
}

async function handleCanvasApi(req, res, pathname) {
    cors(res, req);
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (req.method === "POST" && pathname.endsWith("/state")) {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !body.projectId) {
            sendJson(req, res, 400, { ok: false, error: "missing project" });
            return;
        }
        await setSnapshot({
            projectId: String(body.projectId),
            updatedAt: Date.now(),
            nodes: Array.isArray(body.nodes) ? body.nodes : [],
        });
        sendJson(req, res, 200, { ok: true, store: USE_REDIS ? "redis" : "memory" });
        return;
    }
    if (req.method === "GET" && pathname.endsWith("/commands")) {
        if (!requireAuth(req, res)) return;
        const commands = await takePendingCommands();
        sendJson(req, res, 200, { commands });
        return;
    }
    if (req.method === "POST" && pathname.endsWith("/commands")) {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const name = body?.name || body?.tool;
        const args = body?.args || body?.arguments || {};
        if (!name) {
            sendJson(req, res, 400, { ok: false, error: "missing command name" });
            return;
        }
        const result = await callTool(String(name), args, { wait: body?.wait !== false });
        sendJson(req, res, result?.ok === false ? 400 : 200, result);
        return;
    }
    if (req.method === "GET" && pathname.endsWith("/image")) {
        if (!requireAuth(req, res)) return;
        const url = new URL(req.url || "/", "http://localhost");
        const storageKey = url.searchParams.get("storageKey") || "";
        const projectId = url.searchParams.get("projectId") || "";
        const nodeId = url.searchParams.get("nodeId") || "";
        if (!storageKey) {
            sendJson(req, res, 400, { ok: false, error: "missing storageKey" });
            return;
        }
        const result = await callTool("export_image_data", { projectId, storageKey, nodeId });
        if (!result?.ok || !result.dataUrl) {
            sendJson(req, res, 404, { ok: false, commandId: result?.commandId, error: result?.error || "image not found" });
            return;
        }
        const decoded = dataUrlToBuffer(result.dataUrl);
        if (!decoded || !decoded.buffer.length) {
            sendJson(req, res, 500, { ok: false, error: "invalid image data" });
            return;
        }
        const ext = extensionForMime(decoded.mimeType);
        const filename = `${safeFilename(nodeId || storageKey, "canvas-image")}.${ext}`;
        cors(res, req);
        res.statusCode = 200;
        res.setHeader("Content-Type", decoded.mimeType);
        res.setHeader("Content-Length", String(decoded.buffer.length));
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
        res.end(decoded.buffer);
        return;
    }
    if (req.method === "GET" && pathname.endsWith("/state")) {
        const snapshot = await getSnapshot();
        sendJson(req, res, 200, {
            ok: true,
            connected: Boolean(snapshot),
            projectId: snapshot?.projectId || "",
            updatedAt: snapshot?.updatedAt || 0,
            nodes: publicNodes(snapshot),
            store: USE_REDIS ? "redis" : "memory",
        });
        return;
    }
    if (req.method === "GET" && pathname.endsWith("/result")) {
        if (!requireAuth(req, res)) return;
        const url = new URL(req.url || "/", "http://localhost");
        const id = url.searchParams.get("id") || "";
        if (!id) {
            sendJson(req, res, 400, { ok: false, error: "missing id" });
            return;
        }
        const result = await getResult(id);
        sendJson(req, res, result ? 200 : 404, result || { ok: false, commandId: id, error: "result not found" });
        return;
    }
    if (req.method === "POST" && pathname.endsWith("/result")) {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const done = body?.id ? await finishCommand(body.id, { ok: body.ok !== false, ...body }) : false;
        sendJson(req, res, done ? 200 : 404, { ok: Boolean(done) });
        return;
    }
    sendJson(req, res, 404, { ok: false, error: "not found" });
}

export async function handleCanvasBridge(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname || "/";
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
        await handleMcp(req, res);
        return;
    }
    if (pathname.startsWith("/api/canvas-bridge")) {
        await handleCanvasApi(req, res, pathname);
        return;
    }
    sendJson(req, res, 404, { ok: false });
}
