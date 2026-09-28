/**
 * 前端调用生图后端的示例代码（复制到你网站画布即可）。
 * 假设后端跑在 http://localhost:8787
 */

const API_BASE = "http://localhost:8787";

/** 文生图 */
export async function generateImage({ provider, prompt, model, size, count = 1 }) {
  const resp = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, prompt, model, size, count }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "生成失败");
  return data; // { images: ["data:image/...;base64,..."], videos: [] }
}

/** 图生图（参考图） */
export async function editImage({ provider, prompt, model, referenceImages }) {
  const resp = await fetch(`${API_BASE}/api/generate/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, prompt, model, referenceImages }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "生成失败");
  return data;
}

// 用法示例：
// const { images } = await generateImage({
//   provider: "runninghub",
//   prompt: "一只戴帽子的猫，赛博朋克风格",
//   model: "2102725625755820033",
// });
// images.forEach((dataUrl) => {
//   const img = new Image();
//   img.src = dataUrl;
//   document.body.appendChild(img);
// });
