# image-api — 独立生图后端

把 **RunningHub** / **OpenAI 兼容** 渠道的生图能力封装成 HTTP 接口，供你的前端网站画布调用。

> 说明：WorkBuddy 本身不提供对外 HTTP 生图 API。这个后端复用了你项目里已验证的调用逻辑（含 RunningHub 多 Key 余额不足自动切换），把 Key 放在**服务端**，前端只通过接口请求，Key 不暴露。

## 快速开始

```bash
cd image-api
npm install          # 仅需 axios
node server.js       # 或 npm start
```

启动后监听 `http://localhost:8787`。

## 配置

编辑 `config.js`：

- `runninghub.apiKeys`：每行一个 Key，第一个为主 Key，其余为备用（余额不足自动切换）。
- `runninghub.defaultWorkflowId`：默认工作流 ID。
- `openai.*`：OpenAI 兼容接口地址、Key、模型。

## 接口

### 文生图

```
POST /api/generate
Content-Type: application/json

{
  "provider": "runninghub",        // 或 "openai"
  "prompt": "一只猫",
  "model": "2102725625755820033",   // 可选：RunningHub 工作流 ID 或 OpenAI 模型名
  "size": "1024x1024",              // 可选：OpenAI 用
  "count": 1                        // 可选
}
```

响应：

```json
{ "images": ["data:image/png;base64,..."], "videos": [] }
```

### 图生图

```
POST /api/generate/edit
Content-Type: application/json

{
  "provider": "runninghub",
  "prompt": "把背景换成星空",
  "model": "2102726433268387841",
  "referenceImages": ["data:image/png;base64,..."]
}
```

## 前端调用

见 `client-example.js`，核心就是 `fetch` 两个接口，拿到 `dataUrl` 数组后填进画布的图片节点即可。

## 安全提醒

- 生产环境请把 `Access-Control-Allow-Origin` 改成你的网站域名（`server.js` 里 `sendJson`），并用 `config.allowedOrigins` 做白名单校验。
- Key 只放在服务端 `config.js`，不要写进前端代码。
