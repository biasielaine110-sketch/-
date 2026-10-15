# AI 生成队列协议（前端画布 ↔ WorkBuddy）

前端画布通过**本地文件队列**把生图/生视频交给本机 WorkBuddy 的内置 ImageGen / VideoGen，产物落回固定目录后再回填画布。

> **无需 API Key。** 视频能力限制：仅「文生视频」或「首帧(+尾帧)生视频」，不支持多参考图；时长由模型自定。
>
> **仅本机可用：** 必须用 `npm run dev`（或 `vite preview`）跑画布，并同时打开 WorkBuddy。云端部署读不到本机磁盘。

## 用法（最终流程）

1. 本机启动画布：`cd web && npm run dev`（默认端口 3000）
2. 本机打开 WorkBuddy，按 `WORKBUDDY-WORKER.md` 配置短间隔自动化
3. 画布渠道里选 **WorkBuddy → ImageGen / VideoGen**（配置里已预置，免 Key）
4. 节点点生成 → 任务写入 `miora-queue/new/` → WorkBuddy 生成 → 结果进 `miora-output/` → 画布自动回填

## 目录约定

| 目录 | 用途 |
|---|---|
| `miora-queue/new/` | 前端写入**新任务**（一个 JSON 一个任务） |
| `miora-queue/done/` | 处理完后任务文件移到这里留档 |
| `miora-output/` | 生成产物 + `<id>.result.json` |

## 任务文件格式

```json
{
  "id": "shot-03",
  "type": "image",
  "prompt": "一只戴帽子的猫，赛博朋克风格",
  "mode": "text",
  "resolution": "1080P",
  "aspectRatio": "16:9",
  "referenceImages": []
}
```

- `type`: `"image"` | `"video"`
- `mode`（视频）: `"text"` 文生视频 / `"frame"` 首尾帧；`referenceImages[0]`=首帧，`[1]`=尾帧
- 图片若带参考图：`referenceImages[0]` 为图生图输入（本地绝对路径）

## 结果文件格式

`miora-output/<任务id>.result.json`：

```json
{
  "id": "shot-03",
  "status": "done",
  "files": ["D:\\Ai\\脚本\\开源画布\\miora-output\\shot-03-0.png"],
  "error": ""
}
```

失败时：`"status": "failed"`，`error` 写明原因，`files` 可为空。

## 触发频率（自动化）

WorkBuddy 官方定时最短多为 **每小时**。画布提交任务时会自动把该定时任务的 `next_run_at` 拨到「现在」，催本机 WorkBuddy 尽快跑（需客户端保持打开）。每次最多处理 **1** 个任务。

可选：`node miora-queue/poke-workbuddy.mjs` 作为看门狗。详见 `WORKBUDDY-WORKER.md`。

## HTTP API（Vite 本机中间件）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/miora/health` | 健康检查 |
| POST | `/api/miora/generate` | 写任务到 `new/` |
| GET | `/api/miora/result/:id` | 轮询结果 |
| POST | `/api/miora/upload-ref` | 参考图落盘，返回本机绝对路径 |
| GET | `/api/miora/media?file=` | 读取 `miora-output` 内产物 |
| POST | `/api/miora/ack` | 可选：把任务从 `new/` 移到 `done/` |

浏览器不能直接写磁盘；画布通过以上 API 由 Vite 代理读写。

## WorkBuddy 侧

见同目录 [`WORKBUDDY-WORKER.md`](./WORKBUDDY-WORKER.md)。
