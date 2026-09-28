/**
 * RunningHub 渠道调用（简化版，逻辑与本项目 web/src/lib/runninghub-workflow.ts 一致）。
 * 支持：多 Key 余额不足自动切换、上传参考图、提交任务、轮询结果。
 */
import axios from "axios";

const TASK_API_PREFIX = "/task/openapi";
const STATUS_DONE = "SUCCESS";

function originOf(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function errText(error) {
  const data = error?.response?.data;
  if (data && typeof data === "object") {
    if (data.msg) return data.msg;
    if (data.message) return data.message;
    if (data.error) return typeof data.error === "string" ? data.error : data.error.message;
  }
  return error?.message || String(error || "unknown error");
}

function isBalanceMessage(message) {
  return /NOT_ENOUGH_BALANCE|INSUFFICIENT_BALANCE|NO_ENOUGH_BALANCE|BALANCE_NOT_ENOUGH|NOT_ENOUGH_POINTS|INSUFFICIENT_POINTS|余额不足|额度不足/i.test(message);
}

function isAuthMessage(message) {
  return /APIKEY_UNAUTHORIZED|APIKEY_UNSUPPORTED_FREE_USER|TOKEN_INVALID|APIKEY_USER_NOT_FOUND|CORPAPIKEY_INVALID|401|403/i.test(message);
}

/** 上传参考图，返回该 Key 账号下的 fileName。 */
async function uploadImage(origin, apiKey, dataUrl, filename, signal) {
  const form = new FormData();
  const blob = dataUrlToBlob(dataUrl);
  form.append("apiKey", apiKey);
  form.append("file", blob, filename);
  const resp = await axios.post(`${origin}${TASK_API_PREFIX}/upload`, form, {
    headers: { "Content-Type": "multipart/form-data" },
    signal,
  });
  const data = resp.data?.data || resp.data;
  return data?.fileName || data?.file || data?.url || null;
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = /data:(.*?);base64/.exec(head)?.[1] || "image/png";
  const bin = Buffer.from(body, "base64");
  return new Blob([bin], { type: mime });
}

/** 获取工作流节点信息（nodeInfo）。 */
async function fetchWorkflow(origin, apiKey, workflowId, signal) {
  const resp = await axios.post(
    `${origin}${TASK_API_PREFIX}/webapp/info`,
    { apiKey, workflowId },
    { signal },
  );
  const data = resp.data?.data || resp.data;
  const nodeInfo = Array.isArray(data) ? data : data?.nodeInfoList || data?.nodeInfo || [];
  return nodeInfo;
}

/**
 * 根据 nodeInfo 构建要提交的 override 列表。
 * 简化版：把节点里与 prompt / 图片 / 尺寸相关的字段做成可覆盖项。
 */
function buildNodeInfoList(nodeInfo, prompt, uploadedFiles) {
  const overrides = [];
  const textNodes = (Array.isArray(nodeInfo) ? nodeInfo : []).filter((n) =>
    /text|prompt|string|value|caption|positive/i.test(n?.classType || n?.class_type || n?.fieldName || ""),
  );
  // 只取文本类节点，用 prompt 覆盖第一个文本输入
  const textNode = textNodes[0];
  if (textNode) {
    overrides.push({
      nodeId: textNode.nodeId || textNode.id,
      fieldName: "text",
      fieldValue: prompt,
    });
  }
  return overrides;
}

/** 提交任务。 */
async function submitTask(origin, apiKey, workflowId, nodeInfoList, signal) {
  const resp = await axios.post(
    `${origin}${TASK_API_PREFIX}/create`,
    { apiKey, workflowId, nodeInfoList },
    { signal },
  );
  const data = resp.data?.data || resp.data;
  return data?.taskId || data?.taskIdList?.[0] || null;
}

/** 轮询任务结果，返回 { images, videos }（dataUrl 数组）。 */
async function pollTask(origin, apiKey, taskId, signal) {
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    await sleep(2000);
    const resp = await axios.post(
      `${origin}${TASK_API_PREFIX}/outputs`,
      { apiKey, taskId },
      { signal },
    );
    const data = resp.data?.data || resp.data;
    const status = data?.status;
    if (status === "FAILED" || status === "ERROR") {
      throw new Error(data?.failedReason || data?.msg || "task failed");
    }
    if (status === STATUS_DONE) {
      const images = Array.isArray(data?.images) ? data.images.map((u) => toDataUrl(u)) : [];
      const videos = Array.isArray(data?.videos) ? data.videos.map((u) => u) : [];
      return { images, videos };
    }
  }
}

async function toDataUrl(url) {
  if (typeof url === "string" && url.startsWith("data:")) return url;
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  const mime = resp.headers["content-type"] || "image/png";
  const base64 = Buffer.from(resp.data).toString("base64");
  return `data:${mime};base64,${base64}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 运行一次 RunningHub 任务（文生图/图生图）。
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string[]} args.apiKeys  按顺序尝试的 Key 列表
 * @param {string} args.workflowId
 * @param {string} args.prompt
 * @param {string[]} args.referenceDataUrls  参考图（图生图时传入）
 */
export async function runRunningHubImages({ baseUrl, apiKeys, workflowId, prompt, referenceDataUrls = [], signal }) {
  const origin = originOf(baseUrl);
  if (!origin || !workflowId) throw new Error("无效的 RunningHub 地址或工作流 ID");

  const keys = (apiKeys || []).map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) throw new Error("未配置 RunningHub API Key");

  let lastBalanceError = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const isLast = i === keys.length - 1;
    try {
      const nodeInfo = await fetchWorkflow(origin, apiKey, workflowId, signal);

      // 上传参考图（绑定当前 Key 账号，切换 Key 时需重新上传）
      const uploaded = [];
      for (let j = 0; j < referenceDataUrls.length; j++) {
        uploaded.push(await uploadImage(origin, apiKey, referenceDataUrls[j], `ref-${j + 1}.png`, signal));
      }

      const nodeInfoList = buildNodeInfoList(nodeInfo, prompt, uploaded);
      const taskId = await submitTask(origin, apiKey, workflowId, nodeInfoList, signal);
      if (!taskId) throw new Error("任务提交失败：未返回 taskId");

      return await pollTask(origin, apiKey, taskId, signal);
    } catch (error) {
      if (error?.name === "AbortError" || axios.isCancel(error)) throw error;
      const message = errText(error);
      if (isBalanceMessage(message)) {
        // 余额不足：记录并切换到下一个 Key
        lastBalanceError = new Error(`RunningHub 余额不足（已尝试 ${i + 1}/${keys.length} 个 Key）`);
        if (!isLast) continue;
        throw lastBalanceError;
      }
      // 鉴权失败：当前 Key 不可用，直接抛错（不自动切换，避免误判）
      if (isAuthMessage(message)) {
        throw new Error(`RunningHub 鉴权失败：${message}`);
      }
      throw new Error(message);
    }
  }

  throw lastBalanceError || new Error("RunningHub 生成失败");
}
