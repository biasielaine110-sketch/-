// 临时探针：列出 mochiani-mcp 暴露的全部工具（只读，不生成、不花钱）
import path from "node:path";
import { pathToFileURL } from "node:url";

const MCP_ROOT = "C:\\Users\\zhangbiwen\\AppData\\Roaming\\npm\\node_modules\\mochiani-mcp";
const sdkDir = path.join(MCP_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
const { Client } = await import(pathToFileURL(path.join(sdkDir, "index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkDir, "stdio.js")).href);

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(MCP_ROOT, "dist", "stdio-proxy", "index.js")],
    env: {
        ...process.env,
        MOCHIANI_MCP_URL: "http://127.0.0.1:17321",
        MOCHIANI_MCP_PORT: "17321",
        MOCHIANI_MCP_DATA_FILE: path.join(process.env.LOCALAPPDATA || "", "MochiAni", "MCP", "config.json"),
        MOCHIANI_MCP_USE_STORED_TOKEN: "1",
    },
    stderr: "pipe",
});
const client = new Client({ name: "atelier-tool-probe", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("TOOL_COUNT", tools.length);
for (const tool of tools) {
    const props = Object.keys(tool.inputSchema?.properties || {});
    const required = tool.inputSchema?.required || [];
    console.log(`\n## ${tool.name}`);
    console.log("desc:", String(tool.description || "").replace(/\s+/g, " ").slice(0, 400));
    console.log("args:", props.map((key) => (required.includes(key) ? `${key}*` : key)).join(", "));
}
await client.close();
process.exit(0);
