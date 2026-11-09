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
3. **打开的是某个具体作品**（无限画布 / 漫剧编辑器），不是首页。
   首页 `mochiani-client` 没有生成能力；无限画布走 `canvas_*`，漫剧编辑器走分镜。
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

面板按「视频生成窗口」的样子做：**选模型 → 选渠道 → 调参数 → 写提示词 → 传参考图 → 预检 → 确认生成**。
两条链路按浏览器里打开的是哪种页面自动分流。

### A. 无限画布（`mochiani-canvas`）—— 渠道模型模式走这条

```
GET /api/models                              ← 面板一打开就拉
  ├─ mochiani_canvas_read                   找一个视频节点（没有就临时建一个当探针，不生成）
  └─ mochiani_canvas_model_options          真实模型目录：46 个模型 + 各自渠道 + 参数档位 + 媒体上限

POST /api/plan   {prompt, modelKey, channelId, params, images:[{dataUrl}]}
  ├─ mochiani_canvas_create_nodes           建视频节点
  ├─ mochiani_canvas_locate_node            把面板打开（这一步会偶发超时，忽略）
  ├─ mochiani_canvas_model_controls         轮询到 panelMounted=true，拿 configToken
  ├─ mochiani_canvas_configure_model        model → channel → 每个 parameter，**每步都要重读新 token**
  ├─ mochiani_canvas_upload_and_connect     参考图（本机落盘后导入 + 连线一步到位）
  ├─ mochiani_canvas_set_prompt             或 edit_references（有参考图时必须走这个，见下）
  └─ mochiani_canvas_generation_context     contextToken + estimatedPoints

POST /api/jobs/:id/confirm                   ← 从这一步开始扣灵点
  ├─ mochiani_canvas_generate_node          expectedContext + confirmedByUser=true
  └─ 轮询（默认 15s）
       ├─ mochiani_canvas_generation_operation   state / completionConfirmed
       └─ mochiani_canvas_get_node               取 videoUrl
```

### B. 漫剧编辑器（`carton-editor`）

漫剧编辑器跟无限画布是**两套口径**：那边靠「节点 + 上传参考图」，这边靠「分镜 + 素材库 ID + 配音项」，
而且模型目录也不在 `canvas_model_options` 里、走 `get_generation_settings`。所以桥里单独一层适配。

```
GET /api/models
  └─ mochiani_get_generation_settings        video.available_options → 模型 × 渠道 × 参数
                                             （实测 106 条 / 44 个 model_id，每条带灵点价、成功率、平均时长）

POST /api/plan {prompt, modelKey:"carton:<modelId>", channelId:<supplierId>, params,
                cast:{characters[], scenes[], props[], autoCreate,
                      images:[{kind:"characters"|"scenes"|"props", name, url|dataUrl}]},
                voiceover, generateVoice}
  ├─ mochiani_update_video_generation_config 只有跟编辑器当前配置不一样才切（切换本身不花钱）
  ├─ mochiani_get_asset_matching_context     按名字匹配素材库真实 ID
  ├─ mochiani_create_asset                   库里没有的名字 → 自动新建（角色 / 场景 / 道具）
  ├─ mochiani_upload_asset_images            素材图：按 byName 对齐 assetId 批量上传形象图
  │                                          ⚠️ 只收本机绝对路径 → 桥先落 os.tmpdir()，用完删
  ├─ mochiani_create_shot                    script + characterIds / sceneIds / propIds
  ├─ mochiani_create_voiceover_item          「角色名：台词」逐条写成分镜配音项
  └─ mochiani_preflight_generation           只读预检：模型 / 渠道 / 参考 / 阻塞原因

POST /api/jobs/:id/confirm               ← 从这一步开始扣余额
  ├─ mochiani_generate_voiceovers            勾了「一起生成配音」才走，先于视频
  ├─ mochiani_generate_video                 modelId + supplierId + shotId
  └─ 轮询
       ├─ mochiani_get_shot_media_versions   主视频出来就算完成（优先）
       └─ mochiani_get_generation_task_status 明确 failed 才判失败
```

**两条硬规矩**（都是 MochiAni 那边的，不是我们加的）：

1. 关联了哪个素材，**分镜文案里就必须出现它的完整正式名**，否则页面直接拒写 ——
   所以桥会检查，缺的名字补一行「出场人物：… / 场景：… / 道具：…」，并把补了什么写进 `warnings`。
2. 配音项必须挂在**真实角色 ID** 上（先读 `voiceover.characters`），名字对不上就整条跳过并给出警告，
   不会瞎猜一个 ID 塞进去。

离线校验：`MOCHIANI_BRIDGE_NO_LISTEN=1 node probe-carton-plan.mjs`（不连 MCP、不花钱、不写作品）。

**素材区是可选的，填了以「图块」形态出现**：

- 名字怎么来：节点上每个素材一个图块，输入名字回车即加一条（`cast.characters/scenes/props` 存的还是换行文本）。
- 图怎么来：只认**画布上连线进来的图片节点**，按节点标题跟名字对（「林晚定妆照」→ 林晚；精确 → 双向包含，标题至少 2 字）。
  对不上就留空占位 —— **不按顺序自动分配**，把 A 的脸挂到 B 身上比没图更糟。
- 不填会怎样：只发提示词，人物/场景/道具交给 MochiAni 按分镜自己解析。
- 按用户要求**不**从提示词里抽「角色锁定描述」写进素材 `description`（`create_asset` 的 `description` 通道留着但默认不启用）。

**读模型目录为空 ≠ 没模型**（`/api/models` 的自愈顺序）：

1. `mochiani_canvas_model_options` 空 → `resetClient()` 掐掉 MCP 连接重读（桥跑久了会捏着旧的页面会话，实测重启桥立刻恢复 44 个模型）；
2. 仍空 → `mochiani_canvas_locate_node` 把节点挪进视口、唤醒生成面板，再读；
3. 仍空 → 报 `MODEL_OPTIONS_EMPTY`；locate 超时 → 报 `PAGE_SUSPENDED`（浏览器把 MochiAni 标签页挂起了，切过去点一下即可）。

**渠道不是模型名的一部分**：同一个模型下挂的是线路池（实测 `Minimax H3` = Tencent / AD【优质】 / AutoDL托管，价格与成功率不同）。
所以面板默认自动选一条、只显示一行灰字，`>1` 条时才给「换渠道」。

最后「放到画布」复用画布的 `createBridgeVideoNode`，把 videoUrl 落成视频节点。

## 参考素材怎么进 MochiAni（图 / 视频 / 音频）

画布页面只能给到**文件字节或一个 URL**（`<input type="file">` 拿到的是 File，不是路径），
而 MochiAni 的导入工具只吃**本机绝对路径**。所以桥里做了三件事：

1. `dataUrl` → 解成 Buffer；纯 `http(s)` 地址 → 桥自己下载（视频几十 MB 时比 base64 省得多）；
   两种都落到 `%TEMP%\mochiani-bridge-refs\`；
2. 调 `mochiani_canvas_upload_and_connect(localPath, mediaType:"image"|"video"|"audio", targetNodeId)`，
   一步完成「导入素材节点 + 按原生端口规则连到视频节点」，再 `get_node` 等
   `media.uploadConfirmed` 为真才放行；
3. 顺序固定 **图 → 视频 → 音频**（原生端口有容量上限，主素材先占位）；端口不兼容时
   MCP 会拒，回执里 `connectionVerified:false` 会如实写进 job.warnings，不假装成功。

画布侧对应的是「连线即参考」：选中 MochiAni 节点按 `X` 再点图片 / 视频 / 音频节点，
素材就以 chip 出现在节点里（图显示缩略图，视频/音频显示类型徽标），`预检` 时随请求发出去。
chip 上的 × 断开的是那根连线（`handleRemoveLinkedMedia`，Config 汇流点上的也算）。

> ⚠️ chip 只有「http(s) 地址」或「data: 内联」才发得出去。`blob:` 是只在本页内存里的
> 临时文件，桥（可能在另一台机器）够不着 —— 这种会在预检前用 toast 明确告诉你没发。

> ⚠️ 连完参考素材后，该节点的提示词就变成**结构化文档**（带 `documentToken` + `references`），
> 此时 `mochiani_canvas_set_prompt` 会被页面拒绝，而且报的是一个没填模板的
> `画布操作未执行：{reason}`（看不出真实原因）。必须改走 `mochiani_canvas_edit_references`。
> 桥里先读 `mochiani_canvas_references` 判断，有引用就自动切过去。

> ⚠️ 模型/渠道切换必须在连参考素材**之前**：MochiAni 不允许带上游连线的节点再切模型。

## 花钱的闸门

- `预检` 不花钱，但它**会**在你的 MochiAni 画布/作品里新增一个空节点或分镜。这是后面生成的对象。
- 只有点 `确认生成（扣 MochiAni 灵点）` 才真的下单，走 MochiAni 原生计费。
- `停止轮询` 只是停本机查询，**不会取消 MochiAni 上的任务、也不会退钱**。
- 超时（1 小时）/ 空结果都不会自动重发 —— 避免重复扣费。去 MochiAni 里确认后再决定。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 桥 + MCP 连接状态 |
| GET | `/api/context?pageId=` | 当前作品 + 已连接页面列表 |
| GET | `/api/account?pageId=` | MochiAni 账户灵点 |
| GET | `/api/models?pageId=&nodeId=` | **真实模型目录**（模型 / 渠道 / 参数 / 媒体上限）+ 面板当前配置 |
| POST | `/api/plan` | `{prompt, pageId?, modelKey?, channelId?, params?, images?, videos?, audios?}` → 建节点 + 切配置 + 导素材 + 预检，返回 job（`stage=ready`）。三个素材数组的元素是 `{url}` 或 `{dataUrl}` |
| POST | `/api/jobs/:id/confirm` | 确认下单，开始轮询 |
| POST | `/api/jobs/:id/cancel` | 停止本机轮询 |
| GET | `/api/jobs` / `/api/jobs/:id` | 任务列表 / 单个任务 |
| POST | `/api/tool` | `{name, args}` 直调任意 MochiAni 工具，排障用 |

### 跨域 / 线上页面

桥对所有来源放开（`Access-Control-Allow-Origin: *`），并且带
`Access-Control-Allow-Private-Network: true`。所以**线上 HTTPS 页面（pages.dev）
也能直接 fetch `http://127.0.0.1:17399`** —— 浏览器把 `127.0.0.1` 当作可信来源，不算混合内容。
前提是桥跑在你自己这台机器上。

### 别的电脑也想用（远程 / 当网站使）

要并发，先认清一件事：**桥必须和「浏览器里登录着 MochiAni 的那个页面」在同一台机器上**
（MCP 的 daemon 在 `127.0.0.1:17321`，页面只往本机注册）。所以有两种形态：

**A. 每台电脑各自跑桥（最省事，推荐）**

前端照旧用 pages.dev / 任意地址，每台电脑装一份：

1. `npm i -g mochiani-mcp` + 跑一次它的 setup（登录 MochiAni，页面点「刷新连接」）
2. 拷走 `tools/mochiani-bridge/`，双击 `start.bat`
3. 节点里保持默认 `http://127.0.0.1:17399`

**B. 一台常开的机器当「服务器」，其它电脑只开网页**（本机就是这么跑的）

机器 A 上跑桥 + 一个登录着 MochiAni 的浏览器窗口（别关）。桥**不用绑 0.0.0.0**：
Tailscale Funnel 在同机反代 `127.0.0.1:17399`，所以只加令牌、不动监听地址更安全。

```bash
# 1) 令牌放 tools/mochiani-bridge/remote.env（已在 .gitignore 里，别提交）
#    MOCHIANI_BRIDGE_TOKEN=mochi…（模板见 remote.env.example）
# 2) 双击 start-remote.bat —— 它读 remote.env、带令牌启动，并把可填的地址打在窗口里
# 3) 给桥一个固定 HTTPS 入口（只用一次，配置会留着）
tailscale funnel --bg --https=8443 17399
```

本机现在的固定地址（画布节点里「本机桥」直接填这一整行）：

```
https://wb2api.tailb5bc86.ts.net:8443/?token=mochia6262f1472a18dc7fe55c9c5
```

> 8443 是 Funnel 允许的端口之一；443 已经被本机别的服务（`/`、`/qf`）占着，
> 所以桥单独走 8443，互不影响。`tailscale funnel status` 能同时看到两条映射。

`?token=` 会被前端剥出来改成 `x-mochiani-token` 请求头（不留在 URL 里，折叠显示时打码成 `token=***`）。
桥这侧：`/health` 永远放行（画布要能区分「桥没开」和「令牌不对」），其它 `/api/*` 一律验令牌，
401 时画布会直接提示「地址要带 ?token=」。

注意：
- A 机的浏览器窗口必须保持登录态 + 停在无限画布/作品页；机器休眠 = 全挂。
- 桥和浏览器要一起活着：重启后先开浏览器登录，再双击 `start-remote.bat`。
- 灵点是**机器 A 那个账号**的余额，所有电脑共用。
- 公网暴露时别用 `ry` 之类弱令牌；这个桥没有任何限流，拿到令牌 = 能花你的灵点。
- 换令牌：改 `remote.env` → 重启桥 → 各机器节点里把新地址粘一遍（存在 localStorage 里，不会自动更新）。


## 排障

| 现象 | 原因 |
| --- | --- |
| 面板显示「连不上」 | 桥没启动，或端口不是 17399 |
| `MOCHIANI_NO_WORK_PAGE` / 提示「只看到首页」 | 浏览器在 MochiAni 首页，进一个作品页 |
| `NO_MOCHIANI_PAGE` | 浏览器页面没连上 MCP，去页面点「刷新连接」 |
| `NO_ACTIVE_WORK` | 页面连上了但读不到作品 ID，确认在作品编辑页 |
| 面板里 `MCP 已连接` 但预检按钮灰 | 还没读到作品，先点「刷新」 |
| `PANEL_NOT_MOUNTED` | 视频节点的生成面板没打开；去 MochiAni 画布点一下那个视频节点再重试 |
| `画布操作未执行：{reason}` | MochiAni 侧没填模板的错误。**连了参考图还调 `set_prompt` 就会这样**，要走 `edit_references` |
| `MODEL_VERIFY_FAILED` | 模型没切成，节点上的实际模型和选的不一致；去 MochiAni 看一眼再预检 |
| 渠道没生效（warning） | 该渠道对这个模型不可用，换一个渠道 |
| 生成一直「生成中」 | 去 MochiAni 里看节点状态；别重复下单 |
| 余额不足 | 预检能过，`确认生成` 会被 MochiAni 拒；先充值 |
