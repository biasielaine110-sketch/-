/**
 * 生图 HTTP 服务入口。
 *
 * 接口：
 *   POST /api/generate         文生图
 *   POST /api/generate/edit    图生图（参考图）
 *
 * 请求体（JSON）：
 *   {
 *     "provider": "runninghub" | "openai",   // 渠道
 *     "prompt": "一只猫",
 *     "model": "2102725625755820033",        // 可选，RunningHub 工作流 ID / OpenAI 模型名
 *     "size": "1024x1024",                    // 可选，OpenAI 用
 *     "count": 1,                             // 可选，数量
 *     "referenceImages": ["data:image/..."],  // 可选，图生图参考图
 *   }
 *
 * 响应（JSON）：
 *   { "images": ["data:image/png;base64,..."], "videos": [] }
 */
import http from "node:http";
import { config } from "./config.js";
import { runRunningHubImages } from "./runninghub.js";
import { runOpenAiImages } from "./openai.js";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function handleGenerate(body, abortController) {
  const provider = String(body?.provider || "").toLowerCase();
  const prompt = String(body?.prompt || "").trim();
  if (!prompt) throw new Error("缺少 prompt");
  const referenceImages = Array.isArray(body?.referenceImages) ? body.referenceImages.filter(Boolean) : [];

  if (provider === "runninghub") {
    const workflowId = String(body?.model || config.runninghub.defaultWorkflowId || "").trim();
    return runRunningHubImages({
      baseUrl: config.runninghub.baseUrl,
      apiKeys: config.runninghub.apiKeys,
      workflowId,
      prompt,
      referenceDataUrls: referenceImages,
      signal: abortController.signal,
    });
  }

  if (provider === "openai") {
    const result = await runOpenAiImages({
      baseUrl: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      model: String(body?.model || config.openai.model || "").trim(),
      prompt,
      count: body?.count,
      size: body?.size,
      signal: abortController.signal,
    });
    return { images: result, videos: [] };
  }

  throw new Error("不支持的 provider，可选：runninghub / openai");
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    sendJson(res, 200, { ok: true, service: "image-api", providers: ["runninghub", "openai"] });
    return;
  }

  if (req.method === "POST" && (req.url === "/api/generate" || req.url === "/api/generate/edit")) {
    const abortController = new AbortController();
    // 客户端断开时中止下游请求
    req.on("close", () => abortController.abort());
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const result = await handleGenerate(body, abortController);
      sendJson(res, 200, result);
    } catch (error) {
      const message = error?.message || String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(config.port, () => {
  console.log(`[image-api] 生图后端已启动： http://localhost:${config.port}`);
  console.log(`[image-api] 渠道：runninghub, openai`);
});
