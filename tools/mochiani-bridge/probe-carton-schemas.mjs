/**
 * 列出 MochiAni MCP 工具的 inputSchema（只读、不花钱、不改画布）。
 *
 * 为什么需要它：MochiAni 的 386 个工具**没有对外文档**，唯一权威就是 `listTools()` 回的
 * `inputSchema` —— 参数名、必填项、`format: uuid`、`enum`、`additionalProperties: false`
 * 全在里面。桥报 `MCP error -32602 Input validation error` 时，先跑这个对一遍 schema，
 * 别靠猜（`idempotencyKey` 必须是 uuid 就是这么发现的）。
 *
 * 用法：
 *   node probe-carton-schemas.mjs                       # 默认打印 shot / voiceover / preflight / asset 相关
 *   node probe-carton-schemas.mjs mochiani_create_shot   # 只打印指定工具
 *   node probe-carton-schemas.mjs --names               # 只列名字（配合 grep）
 *   node probe-carton-schemas.mjs --required            # 各工具必填字段速查表
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const MCP_ROOT =
    process.env.MOCHIANI_MCP_ROOT || path.join(process.env.APPDATA || "", "npm", "node_modules", "mochiani-mcp");
const MCP_DATA_FILE =
    process.env.MOCHIANI_MCP_DATA_FILE || path.join(process.env.LOCALAPPDATA || "", "MochiAni", "MCP", "config.json");
const MCP_URL = process.env.MOCHIANI_MCP_URL || "http://127.0.0.1:17321";

const sdkDir = path.join(MCP_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(pathToFileURL(path.join(sdkDir, "index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkDir, "stdio.js")).href);

/**
 * stdio-proxy 需要 4 个环境变量，少一个就报「缺少 MOCHIANI_MCP_TOKEN」。
 * `MOCHIANI_MCP_USE_STORED_TOKEN=1` 是关键：复用 MochiAni 桌面端已经存好的令牌。
 */
const transport = new StdioClientTransport({
    command: process.execPath,
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

const client = new Client({ name: "atelier-schema-probe", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((item) => item.startsWith("--")));
const wanted = argv.filter((item) => !item.startsWith("--"));

if (flags.has("--names")) {
    for (const tool of tools) console.log(tool.name);
    await client.close();
    process.exit(0);
}

const picked = wanted.length
    ? tools.filter((tool) => wanted.includes(tool.name))
    : tools.filter((tool) => /shot|voiceover|preflight|asset|generation_settings/i.test(tool.name));

if (flags.has("--required")) {
    for (const tool of picked) {
        const required = tool.inputSchema?.required || [];
        console.log(`${tool.name.padEnd(44)} ${required.length ? required.join(", ") : "(无)"}`);
    }
    await client.close();
    process.exit(0);
}

console.log(`总工具数: ${tools.length} | 命中: ${picked.length}`);
for (const tool of picked) {
    console.log(`\n==== ${tool.name} ====`);
    if (tool.description) console.log(tool.description.slice(0, 400));
    console.log(JSON.stringify(tool.inputSchema, null, 2));
}

await client.close();
process.exit(0);
