/**
 * Cloudflare Pages (Web Request/Response) port of the canvas WorkBuddy bridge.
 * Configure CANVAS_BRIDGE_TOKEN + Upstash Redis REST env vars for multi-instance state.
 */

const GENERATE_TIMEOUT_MS = 12 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20_000;
const SERVERLESS_MAX_WAIT_MS = 100_000;

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
                projectId: { type: "string" },
                content: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
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
                projectId: { type: "string" },
                imageUrl: { type: "string" },
                prompt: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
            },
            required: ["imageUrl"],
        },
    },
    {
        name: "export_image_data",
        description: "按 storageKey 从当前打开的画布浏览器中导出图片 data URL。",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                storageKey: { type: "string" },
                nodeId: { type: "string" },
            },
            required: ["storageKey"],
        },
    },
    {
        name: "set_canvas_prompt",
        description: "把提示词写到指定画布节点。",
        inputSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string" },
                prompt: { type: "string" },
            },
            required: ["nodeId", "prompt"],
        },
    },
    {
        name: "set_canvas_size",
        description: "按 1k、2k、4k 设置图片节点的画布尺寸。",
        inputSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string" },
                tier: { type: "string", enum: ["1k", "2k", "4k"] },
                aspect: { type: "string" },
            },
            required: ["nodeId", "tier"],
        },
    },
    {
        name: "generate_canvas_node",
        description: "用该节点当前的提示词和尺寸触发生成，并等待画布返回结果。",
        inputSchema: {
            type: "object",
            properties: { nodeId: { type: "string" } },
            required: ["nodeId"],
        },
    },
];

/** @type {{ snapshot: any, commands: any[], waiters: Map<string, any>, results: Map<string, any> }} */
const state = {
    snapshot: null,
    commands: [],
    waiters: new Map(),
    results: new Map(),
};

/**
 * @param {Record<string, string | undefined>} env
 */
function bridgeConfig(env = {}) {
    const accessToken = env.CANVAS_BRIDGE_TOKEN || "";
    const redisUrl = (
        env.KV_REST_API_URL ||
        env.UPSTASH_REDIS_REST_URL ||
        env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
        ""
    ).replace(/\/+$/, "");
    const redisToken =
        env.KV_REST_API_TOKEN ||
        env.UPSTASH_REDIS_REST_TOKEN ||
        env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
        "";
    const storePrefix = env.CANVAS_BRIDGE_STORE_PREFIX || "canvas-bridge";
    return {
        accessToken,
        redisUrl,
        redisToken,
        storePrefix,
        useRedis: Boolean(redisUrl && redisToken),
    };
}

function corsHeaders(request) {
    const origin = request.headers.get("Origin") || "*";
    return {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    };
}

function jsonResponse(request, status, body, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders(request),
            ...extraHeaders,
        },
    });
}

function authorized(request, accessToken) {
    if (!accessToken) return true;
    const auth = request.headers.get("Authorization") || "";
    if (auth === `Bearer ${accessToken}`) return true;
    const url = new URL(request.url);
    return url.searchParams.get("token") === accessToken;
}

function key(prefix, name) {
    return `${prefix}:${name}`;
}

async function redis(cfg, command) {
    const response = await fetch(cfg.redisUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${cfg.redisToken}`,
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

function dataUrlToBytes(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const body = match[3] || "";
    if (match[2]) {
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return { mimeType, bytes };
    }
    return { mimeType, bytes: new TextEncoder().encode(decodeURIComponent(body)) };
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

async function readJsonBody(request) {
    const raw = (await request.text()).trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
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

async function setSnapshot(cfg, snapshot) {
    state.snapshot = snapshot;
    if (cfg.useRedis) {
        await redis(cfg, ["SET", key(cfg.storePrefix, "snapshot"), JSON.stringify(snapshot), "EX", 120]);
    }
}

async function getSnapshot(cfg) {
    if (!cfg.useRedis) return state.snapshot;
    return parseJson(await redis(cfg, ["GET", key(cfg.storePrefix, "snapshot")]), null);
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

async function enqueue(cfg, name, args) {
    const command = createCommand(name, args);
    if (cfg.useRedis) {
        await redis(cfg, ["SET", key(cfg.storePrefix, `command:${command.id}`), JSON.stringify(command), "EX", 1800]);
        await redis(cfg, ["RPUSH", key(cfg.storePrefix, "commands"), command.id]);
        return command.id;
    }
    state.commands.push(command);
    state.commands = state.commands.filter((item) => Date.now() - item.createdAt < 30 * 60 * 1000);
    return command.id;
}

async function takePendingCommands(cfg) {
    if (cfg.useRedis) {
        const ids = (await redis(cfg, ["LRANGE", key(cfg.storePrefix, "commands"), 0, 49])) || [];
        if (!ids.length) return [];
        await redis(cfg, ["LTRIM", key(cfg.storePrefix, "commands"), ids.length, -1]);
        const values =
            ids.length === 1
                ? [await redis(cfg, ["GET", key(cfg.storePrefix, `command:${ids[0]}`)])]
                : await redis(cfg, ["MGET", ...ids.map((id) => key(cfg.storePrefix, `command:${id}`))]);
        return (values || [])
            .map((value) => parseJson(value, null))
            .filter(Boolean)
            .map((item) => ({ id: item.id, name: item.name, args: item.args }));
    }
    const pending = state.commands.filter((item) => item.status === "pending");
    for (const item of pending) item.status = "dispatched";
    return pending.map((item) => ({ id: item.id, name: item.name, args: item.args }));
}

async function finishCommand(cfg, id, result) {
    if (cfg.useRedis) {
        await redis(cfg, ["SET", key(cfg.storePrefix, `result:${id}`), JSON.stringify({ ok: result?.ok !== false, ...result }), "EX", 1800]);
        const raw = await redis(cfg, ["GET", key(cfg.storePrefix, `command:${id}`)]);
        const command = parseJson(raw, null);
        if (command) {
            command.status = "done";
            await redis(cfg, ["SET", key(cfg.storePrefix, `command:${id}`), JSON.stringify(command), "EX", 1800]);
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

async function getResult(cfg, id) {
    if (cfg.useRedis) return parseJson(await redis(cfg, ["GET", key(cfg.storePrefix, `result:${id}`)]), null);
    return state.results.get(id) || null;
}

async function waitForResult(cfg, id, timeout) {
    if (!cfg.useRedis) {
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
        const result = await getResult(cfg, id);
        if (result) return { commandId: id, ...result };
        await delay(500);
    }
    return { ok: false, commandId: id, error: "画布没有及时回传结果。可稍后用 /api/canvas-bridge/result?id=... 查询。" };
}

async function callTool(cfg, name, args, options = {}) {
    const snapshot = await getSnapshot(cfg);
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
    const id = await enqueue(cfg, name, args || {});
    if (options.wait === false) return { ok: true, commandId: id, queued: true };
    const timeout = name === "generate_canvas_node" ? GENERATE_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    return waitForResult(cfg, id, timeout);
}

function rpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcp(request, cfg) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (!authorized(request, cfg.accessToken)) {
        return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
    }
    if (request.method === "GET") {
        const snapshot = await getSnapshot(cfg);
        return jsonResponse(request, 200, {
            name: "infinite-atelier",
            connected: Boolean(snapshot),
            projectId: snapshot?.projectId || "",
            updatedAt: snapshot?.updatedAt || 0,
            tools: TOOLS.map((tool) => tool.name),
            store: cfg.useRedis ? "redis" : "memory",
        });
    }
    if (request.method !== "POST") {
        return jsonResponse(request, 405, { error: "method not allowed" });
    }
    const message = await readJsonBody(request);
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        return jsonResponse(request, 400, rpcError(null, -32700, "请求必须是 JSON-RPC 对象"));
    }
    const { id, method, params } = message;
    if (id === undefined || String(method || "").startsWith("notifications/")) {
        return new Response(null, { status: 202, headers: corsHeaders(request) });
    }
    if (method === "initialize") {
        return jsonResponse(
            request,
            200,
            rpcResult(id, {
                protocolVersion: params?.protocolVersion || "2024-11-05",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "infinite-atelier", version: "1.0.0" },
            }),
            { "Mcp-Session-Id": "atelier" },
        );
    }
    if (method === "ping") return jsonResponse(request, 200, rpcResult(id, {}));
    if (method === "tools/list") return jsonResponse(request, 200, rpcResult(id, { tools: TOOLS }));
    if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || params?.args || {};
        try {
            const data = await callTool(cfg, name, args, { wait: params?.wait !== false });
            return jsonResponse(request, 200, rpcResult(id, {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
                isError: data?.ok === false,
            }));
        } catch (error) {
            return jsonResponse(request, 200, rpcResult(id, {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            }));
        }
    }
    return jsonResponse(request, 200, rpcError(id, -32601, `不支持的方法 ${method || ""}`));
}

async function handleCanvasApi(request, cfg, pathname) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method === "POST" && pathname.endsWith("/state")) {
        if (!authorized(request, cfg.accessToken)) return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || !body.projectId) {
            return jsonResponse(request, 400, { ok: false, error: "missing project" });
        }
        await setSnapshot(cfg, {
            projectId: String(body.projectId),
            updatedAt: Date.now(),
            nodes: Array.isArray(body.nodes) ? body.nodes : [],
        });
        return jsonResponse(request, 200, { ok: true, store: cfg.useRedis ? "redis" : "memory" });
    }
    if (request.method === "GET" && pathname.endsWith("/commands")) {
        if (!authorized(request, cfg.accessToken)) return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
        const commands = await takePendingCommands(cfg);
        return jsonResponse(request, 200, { commands });
    }
    if (request.method === "POST" && pathname.endsWith("/commands")) {
        if (!authorized(request, cfg.accessToken)) return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
        const body = await readJsonBody(request);
        const name = body?.name || body?.tool;
        const args = body?.args || body?.arguments || {};
        if (!name) return jsonResponse(request, 400, { ok: false, error: "missing command name" });
        const result = await callTool(cfg, String(name), args, { wait: body?.wait !== false });
        return jsonResponse(request, result?.ok === false ? 400 : 200, result);
    }
    if (request.method === "GET" && pathname.endsWith("/image")) {
        if (!authorized(request, cfg.accessToken)) return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
        const url = new URL(request.url);
        const storageKey = url.searchParams.get("storageKey") || "";
        const projectId = url.searchParams.get("projectId") || "";
        const nodeId = url.searchParams.get("nodeId") || "";
        if (!storageKey) return jsonResponse(request, 400, { ok: false, error: "missing storageKey" });
        const result = await callTool(cfg, "export_image_data", { projectId, storageKey, nodeId });
        if (!result?.ok || !result.dataUrl) {
            return jsonResponse(request, 404, { ok: false, commandId: result?.commandId, error: result?.error || "image not found" });
        }
        const decoded = dataUrlToBytes(result.dataUrl);
        if (!decoded || !decoded.bytes.length) {
            return jsonResponse(request, 500, { ok: false, error: "invalid image data" });
        }
        const ext = extensionForMime(decoded.mimeType);
        const filename = `${safeFilename(nodeId || storageKey, "canvas-image")}.${ext}`;
        return new Response(decoded.bytes, {
            status: 200,
            headers: {
                ...corsHeaders(request),
                "Content-Type": decoded.mimeType,
                "Content-Disposition": `inline; filename="${filename}"`,
            },
        });
    }
    if (request.method === "GET" && pathname.endsWith("/state")) {
        const snapshot = await getSnapshot(cfg);
        return jsonResponse(request, 200, {
            ok: true,
            connected: Boolean(snapshot),
            projectId: snapshot?.projectId || "",
            updatedAt: snapshot?.updatedAt || 0,
            nodes: publicNodes(snapshot),
            store: cfg.useRedis ? "redis" : "memory",
        });
    }
    if (request.method === "GET" && pathname.endsWith("/result")) {
        if (!authorized(request, cfg.accessToken)) return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
        const id = new URL(request.url).searchParams.get("id") || "";
        if (!id) return jsonResponse(request, 400, { ok: false, error: "missing id" });
        const result = await getResult(cfg, id);
        return jsonResponse(request, result ? 200 : 404, result || { ok: false, commandId: id, error: "result not found" });
    }
    if (request.method === "POST" && pathname.endsWith("/result")) {
        if (!authorized(request, cfg.accessToken)) return jsonResponse(request, 401, { ok: false, error: "unauthorized" });
        const body = await readJsonBody(request);
        const done = body?.id ? await finishCommand(cfg, body.id, { ok: body.ok !== false, ...body }) : false;
        return jsonResponse(request, done ? 200 : 404, { ok: Boolean(done) });
    }
    return jsonResponse(request, 404, { ok: false, error: "not found" });
}

/**
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 */
export async function handleCanvasBridgeRequest(request, env = {}) {
    const cfg = bridgeConfig(env);
    const url = new URL(request.url);
    const pathname = url.pathname || "/";
    if (pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname.endsWith("/mcp")) {
        return handleMcp(request, cfg);
    }
    if (pathname.startsWith("/api/canvas-bridge")) {
        return handleCanvasApi(request, cfg, pathname);
    }
    return jsonResponse(request, 404, { ok: false });
}
