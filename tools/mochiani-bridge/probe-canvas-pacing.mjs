/**
 * 探针：验证「连续画布写操作要等页面空闲」这条坑，以及 `canvasWrite()` 的修复是否生效。
 *
 * 用法（桥要先起来，地址/token 用 env 覆盖）：
 *   node probe-canvas-pacing.mjs --node <现有视频节点id> a.png b.png c.png
 *   node probe-canvas-pacing.mjs a.png b.png c.png            # 自己建一个测试视频节点
 *
 * 不加 `--paced` 就是**裸连**（复现用）：不做空闲等待、不重试 —— 第 3 张应该挂，
 * 挂出来的错误就是页面那个没填占位符的 `画布操作未执行：{reason}`。
 * 加 `--paced` 走修复后的姿势：每张之前等 revision 稳定、失败退避重试 —— 应该全过。
 *
 * ⚠️ 这个探针会**真在 MochiAni 画布上建节点、真上传**。跑完记得自己收拾。
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.MOCHIANI_BRIDGE_URL || "http://127.0.0.1:17399";
const TOKEN = process.env.MOCHIANI_BRIDGE_TOKEN || "";
const PAGE_ID = process.env.MOCHIANI_PAGE_ID || "";
const ORIGIN = process.env.MOCHIANI_ORIGIN || "https://canvas.mochiani.com";

const argv = process.argv.slice(2);
const paced = argv.includes("--paced");
let nodeId = "";
const files = [];
for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--node") nodeId = argv[++i] || "";
    else if (!argv[i].startsWith("--")) files.push(argv[i]);
}
if (!files.length) {
    console.error("给几张本地图片路径：node probe-canvas-pacing.mjs [--paced] [--node <id>] a.png b.png ...");
    process.exit(1);
}
if (!PAGE_ID) {
    console.error("缺 MOCHIANI_PAGE_ID（也可以先跑 GET /api/context 拿）");
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tool(name, args) {
    const response = await fetch(`${BASE}/api/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-mochiani-token": TOKEN } : {}) },
        body: JSON.stringify({ name, args }),
    });
    return response.json();
}

async function read() {
    const out = await tool("mochiani_canvas_read", { pageId: PAGE_ID, origin: ORIGIN });
    if (!out.ok) throw new Error(`read 失败：${JSON.stringify(out).slice(0, 200)}`);
    return out.data;
}

/** 连续两次读到同一个 revision = 页面闲了。 */
async function waitIdle(stableFor = 2, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    let hits = 0;
    while (Date.now() < deadline) {
        const revision = String((await read()).revision || "");
        if (revision && revision === last) {
            hits += 1;
            if (hits >= stableFor) return revision;
        } else {
            hits = 0;
            last = revision;
        }
        await sleep(700);
    }
    return last;
}

if (!nodeId) {
    const before = await read();
    const nodes = before.nodes || [];
    const right = nodes.length ? Math.max(...nodes.map((n) => Number(n.x || 0) + Number(n.width || 0) / 2)) : 0;
    const created = await tool("mochiani_canvas_create_nodes", {
        pageId: PAGE_ID,
        origin: ORIGIN,
        expectedRevision: before.revision,
        idempotencyKey: randomUUID(),
        nodes: [{ kind: "video", x: Math.round(right + 360), y: 0 }],
    });
    nodeId = (created?.data?.affectedIds || [])[0] || "";
}
console.log(`节点 ${nodeId}，${paced ? "等空闲 + 重试" : "裸连"}，共 ${files.length} 张`);
if (!nodeId) process.exit(1);

for (let i = 0; i < files.length; i += 1) {
    const attempts = paced ? 3 : 1;
    let ok = false;
    for (let attempt = 1; attempt <= attempts && !ok; attempt += 1) {
        const revision = paced ? await waitIdle() : (await read()).revision;
        const started = Date.now();
        const out = await tool("mochiani_canvas_upload_and_connect", {
            pageId: PAGE_ID,
            origin: ORIGIN,
            expectedRevision: revision,
            idempotencyKey: randomUUID(),
            localPath: files[i],
            mediaType: "image",
            targetNodeId: nodeId,
        });
        const cost = ((Date.now() - started) / 1000).toFixed(2);
        console.log(`  第 ${i + 1} 张 try${attempt} (${cost}s, rev=${revision}) ->`, JSON.stringify(out).slice(0, 180));
        if (out.ok) ok = true;
        else await sleep(900 * attempt);
    }
    if (!ok) {
        console.log(`第 ${i + 1} 张最终失败，停在这里`);
        break;
    }
}
