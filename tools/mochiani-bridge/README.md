# MochiAni ⇄ 开源画布 本机桥

给画布装一条「输入指令 → 用我自己的 MochiAni 余额生视频 → 视频回到画布」的通路。

- 画布侧入口：画布右下角 `MochiAni` 悬浮按钮 → 面板
  （组件：`web/src/components/canvas/canvas-mochiani-panel.tsx`）
- 本机桥：本目录 `server.mjs`，监听 `http://127.0.0.1:17399`
- 下游：本机已安装的 `mochiani-mcp`（stdio 代理 → MochiAni MCP daemon `127.0.0.1:17321`）

## 为什么必须有个本机桥

MochiAni MCP 是 **stdio 进程**，只有本机 Node 能拉起来；画布是跑在浏览器里的 SPA，够不着它。
所以中间放一个 127.0.0.1 的 HTTP 服务：画布 `fetch` 它，它替画布去调 MCP。

## 前置条件（缺一不可）

1. 本机已 `npm i -g mochiani-mcp` 并跑过 `mochiani-mcp-setup`（配置在
   `%LOCALAPPDATA%\MochiAni\MCP\config.json`）。
2. **浏览器里已登录 mochiani.com**，并且页面上的 MCP 处于「已连接」状态。
3. **打开的是某个具体作品**（漫剧编辑器 / 画布），不是首页。
   MochiAni 的生成能力绑在「作品 → 分镜」上；首页 `operations.canGenerate=false`，生成不了。
   在首页点一下「刷新连接」之后进入作品页，让页面重新注册给 MCP。
4. 画布本身在开着（`npm run dev` 或线上页面），并且项目页已经打开。

## 启动

```bat
tools\mochiani-bridge\start.bat
```

或者：

```bash
node tools/mochiani-bridge/server.mjs
```

窗口保持开着。桥一停，画布里的 MochiAni 按钮就变红。

环境变量（都可选）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MOCHIANI_BRIDGE_PORT` | `17399` | 桥的端口，改了画布面板里的「本机桥」地址也要改 |
| `MOCHIANI_MCP_ROOT` | `%APPDATA%\npm\node_modules\mochiani-mcp` | mochiani-mcp 安装目录 |
| `MOCHIANI_POLL_MS` | `15000` | 生成状态轮询间隔 |
| `MOCHIANI_JOB_TIMEOUT_MS` | `3600000` | 单个任务等待上限（1 小时） |

## 一次生成发生了什么

```
画布面板「预检」  POST /api/plan
  ├─ mochiani_list_open_pages            挑出 canGenerate 的页面
  ├─ mochiani_get_work_summary           读 projectId / workId
  ├─ mochiani_create_shot                把你的指令作为新分镜文案写进去
  └─ mochiani_preflight_generation       只读预检：模型 / 渠道 / 参考 / 阻塞原因

画布面板「确认生成」POST /api/jobs/:id/confirm     ← 从这一步开始扣余额
  ├─ mochiani_generate_video             下发分镜视频生成
  └─ 轮询（默认 15s）
       ├─ mochiani_get_shot_media_versions   主视频出来就算完成（优先）
       └─ mochiani_get_generation_task_status 明确 failed 才判失败

画布面板「放到画布」
  └─ 复用画布桥的 createBridgeVideoNode，把 videoUrl 落成视频节点
```

## 花钱的闸门

- `预检` 不花钱，但它**会**在你的 MochiAni 作品里新增一个分镜（文案 = 指令）。这是后面生成的对象。
- 只有点 `确认生成（扣 MochiAni 余额）` 才真的下单，用的是 MochiAni 账户余额，走 MochiAni 原生计费。
- `停止轮询` 只是停本机查询，**不会取消 MochiAni 上的任务、也不会退钱**。
- 超时（1 小时）/ 空结果都不会自动重发 —— 避免重复扣费。去 MochiAni 作品里确认后再决定。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 桥 + MCP 连接状态 |
| GET | `/api/context?pageId=` | 当前作品（`projectId/workId`）+ 已连接页面列表 |
| POST | `/api/plan` | `{prompt, pageId?}` → 建分镜 + 预检，返回 job（`stage=ready`） |
| POST | `/api/jobs/:id/confirm` | 确认下单，开始轮询 |
| POST | `/api/jobs/:id/cancel` | 停止本机轮询 |
| GET | `/api/jobs` / `/api/jobs/:id` | 任务列表 / 单个任务 |
| POST | `/api/tool` | `{name, args}` 直调任意 MochiAni 工具，排障用 |

## 排障

| 现象 | 原因 |
| --- | --- |
| 面板显示「连不上」 | 桥没启动，或端口不是 17399 |
| `MOCHIANI_NO_WORK_PAGE` / 提示「只看到首页」 | 浏览器在 MochiAni 首页，进一个作品页 |
| `NO_MOCHIANI_PAGE` | 浏览器页面没连上 MCP，去页面点「刷新连接」 |
| `NO_ACTIVE_WORK` | 页面连上了但读不到作品 ID，确认在作品编辑页 |
| 面板里 `MCP 已连接` 但预检按钮灰 | 还没读到作品，先点「刷新」 |
| 生成一直「生成中」 | 去 MochiAni 作品里看分镜状态；别重复下单 |
