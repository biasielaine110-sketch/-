/**
 * Local bridge so WorkBuddy can drive the open canvas over MCP.
 * The browser page posts its snapshot and polls commands. One Node process
 * (the Vite dev server) must serve both /mcp and /api/canvas-bridge.
 */

const GENERATE_TIMEOUT_MS = 12 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20_000;

const state = {
    snapshot: null,
    commands: [],
    waiters: new Map(),
};

const TOOLS = [
    {
        name: "list_canvas_nodes",
        description: "列出当前打开的无限画布项目里的节点，包含提示词、尺寸、生成状态。调用其它工具前先用它确认 nodeId。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
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

function publicNodes() {
    const nodes = state.snapshot?.nodes || [];
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
        width: node.width || 0,
        height: node.height || 0,
        error: node.error || "",
    }));
}

function enqueue(name, args) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const command = { id, name, args, status: "pending", createdAt: Date.now() };
    state.commands.push(command);
    state.commands = state.commands.filter((item) => Date.now() - item.createdAt < 30 * 60 * 1000);
    const timeout = name === "generate_canvas_node" ? GENERATE_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            command.status = "timeout";
            state.waiters.delete(id);
            resolve({ ok: false, error: "画布没有响应。请用浏览器打开这个项目页，并保持页面不要关掉。" });
        }, timeout);
        state.waiters.set(id, { resolve, timer });
    });
}

function finishCommand(id, result) {
    const command = state.commands.find((item) => item.id === id);
    if (command) command.status = "done";
    const waiter = state.waiters.get(id);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    state.waiters.delete(id);
    waiter.resolve(result);
    return true;
}

async function callTool(name, args) {
    if (!state.snapshot) {
        return { ok: false, error: "还没有画布连上来。请先在浏览器打开要操作的项目。" };
    }
    if (name === "list_canvas_nodes") {
        return {
            ok: true,
            projectId: state.snapshot.projectId,
            updatedAt: state.snapshot.updatedAt,
            nodes: publicNodes(),
        };
    }
    if (!TOOLS.some((tool) => tool.name === name)) {
        return { ok: false, error: `未知工具 ${name}` };
    }
    return enqueue(name, args || {});
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
    if (req.method === "GET") {
        sendJson(req, res, 200, {
            name: "infinite-atelier",
            connected: Boolean(state.snapshot),
            projectId: state.snapshot?.projectId || "",
            updatedAt: state.snapshot?.updatedAt || 0,
            tools: TOOLS.map((tool) => tool.name),
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
            const data = await callTool(name, args);
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
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !body.projectId) {
            sendJson(req, res, 400, { ok: false, error: "missing project" });
            return;
        }
        state.snapshot = {
            projectId: String(body.projectId),
            updatedAt: Date.now(),
            nodes: Array.isArray(body.nodes) ? body.nodes : [],
        };
        sendJson(req, res, 200, { ok: true });
        return;
    }
    if (req.method === "GET" && pathname.endsWith("/commands")) {
        const pending = state.commands.filter((item) => item.status === "pending");
        for (const item of pending) item.status = "dispatched";
        sendJson(req, res, 200, { commands: pending.map((item) => ({ id: item.id, name: item.name, args: item.args })) });
        return;
    }
    if (req.method === "POST" && pathname.endsWith("/result")) {
        const body = await readBody(req);
        const done = body && finishCommand(body.id, { ok: body.ok !== false, ...body });
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
