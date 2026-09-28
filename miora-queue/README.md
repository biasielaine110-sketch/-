# AI 生成队列协议（前端 ↔ WorkBuddy 自动化）

前端画布通过**文件**把生图/生视频需求交给 WorkBuddy 定时自动化任务，产物落回固定目录。

> Worker 说明：当前使用 WorkBuddy 内置的 ImageGen（生图）和 VideoGen（生视频），**无需任何 API Key**。视频能力有限制：仅支持「文生视频」或「首帧(+尾帧)生视频」，不支持多参考图；时长不可指定（模型自定）。

## 目录约定

| 目录 | 用途 |
|---|---|
| `miora-queue/new/` | 前端写入**新任务**的地方（JSON 文件，一个任务一个文件） |
| `miora-queue/done/` | 自动化处理完后，把任务文件**移动**到这里留档 |
| `miora-output/` | 生成产物（图片/视频）落盘目录，前端来轮询读取 |

## 任务文件格式（JSON）

前端往 `miora-queue/new/` 写一个 `.json` 文件，文件名 = 任务 id（如 `shot-03.json`）：

```json
{
  "id": "shot-03",
  "type": "image",              // "image" = 生图；"video" = 生视频
  "prompt": "一只戴帽子的猫，赛博朋克风格",
  "mode": "text",               // video 用："text"(文生视频) / "frame"(首尾帧生视频)
  "resolution": "1080P",        // video 用：720P / 1080P
  "aspectRatio": "16:9",        // video 用（仅 mode=text）：16:9 / 9:16 / 1:1
  "referenceImages": []         // 可选：本地图片路径数组
                                //   image: [0] 作为图生图输入
                                //   video mode=frame: [0]=首帧, [1]=尾帧
}
```

## 结果文件格式

自动化每处理完一个任务，在 `miora-output/` 下生成 `<任务id>.result.json`：

```json
{
  "id": "shot-03",
  "status": "done",              // done / failed
  "files": ["D:\\Ai\\脚本\\开源画布\\miora-output\\shot-03-0.png"],
  "error": ""
}
```

前端轮询 `miora-output/`，按 `id` 找到自己任务的结果文件即可拿到产物。

## 触发频率

自动化任务**每小时整点**运行一次，每次最多处理 1 个任务。任务提交后最多等 1 小时才会被拾取（生视频另需 1-3 分钟生成）。

## 前端对接

浏览器前端不能直接写本地磁盘，需由你的网站后端代理写任务文件 + 读结果文件。见 `miora-queue/README.md` 里的完整示例（POST /api/miora/generate 写任务、GET /api/miora/result/:id 读结果）。
