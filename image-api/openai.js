/**
 * OpenAI 兼容渠道调用（/v1/images/generations）。
 * 支持方舟、豆包等任意 OpenAI 格式生图服务。
 */
import axios from "axios";

function normalizeBaseUrl(baseUrl) {
  let raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return raw;
  if (/\/v1\/?$/.test(raw)) return raw;
  return `${raw}/v1`;
}

export async function runOpenAiImages({ baseUrl, apiKey, model, prompt, count = 1, size, signal }) {
  if (!baseUrl) throw new Error("未配置 OpenAI 兼容接口地址");
  if (!apiKey) throw new Error("未配置 OpenAI 兼容 API Key");
  if (!model) throw new Error("未配置模型名称");

  const url = `${normalizeBaseUrl(baseUrl)}/images/generations`;
  const body = {
    model,
    prompt,
    n: Math.max(1, Math.min(10, Number(count) || 1)),
  };
  if (size) body.size = size;

  const resp = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  const data = resp.data?.data || resp.data;
  if (Array.isArray(data)) {
    return data
      .map((item) => item.url || item.b64_json || null)
      .filter(Boolean)
      .map((u) => (u.startsWith("data:") ? u : null))
      .filter(Boolean);
  }
  throw new Error("OpenAI 兼容接口未返回图片数据");
}
