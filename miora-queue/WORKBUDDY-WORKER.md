# WorkBuddy 队列 Worker（短间隔）

让本机 WorkBuddy 每约 **15 秒** 处理 1 个画布任务，用内置 **ImageGen / VideoGen** 生成，并把结果写回 `miora-output/`。

## 本机已写入的定时任务

已在 `~/.workbuddy/workbuddy.db` 更新（或创建）任务：

| 项 | 值 |
|---|---|
| 名称 | **Miora 画布队列 Worker（短间隔）** |
| 工作目录 | `D:\Ai\脚本\开源画布` |
| 调度（UI） | **每隔 1 小时**（WorkBuddy 官方最短间隔） |
| 状态 | `ACTIVE` |

### 自动化怎么生效（不用每次手点）

WorkBuddy **不能**设 15 秒定时，但可以自动：

1. 画布 `POST /api/miora/generate` 写任务后，会**自动拨动**该定时任务的 `next_run_at = 现在`
2. 本机 WorkBuddy 客户端开着时，会尽快捡起并执行（通常几十秒～几分钟内，取决于客户端调度轮询）
3. 「每隔 1 小时」只是兜底；平时靠「提交即催跑」

可选加强：另开一个终端跑看门狗（队列有任务就反复催）：

```bash
node miora-queue/poke-workbuddy.mjs
```

请打开 WorkBuddy → 左侧 **定时任务**：

1. 找到上述任务，确认开关为开启  
2. 执行频率保存为 **间隔 · 每隔 1 小时 · 长期有效** 即可  
3. 权限选 **完全访问**  
4. 第一次建议点一次 **立即运行** 验证提示词是否正常

## 一次性配置（若任务丢失，可手动重建）

1. 确认仓库根目录：`D:\Ai\脚本\开源画布`
2. 确认目录存在：`miora-queue/new/`、`miora-queue/done/`、`miora-output/`
3. WorkBuddy → **定时任务** → **新建**
4. 名称：`Miora 画布队列 Worker（短间隔）`
5. 工作空间：选本仓库根目录
6. 重复：最短可用间隔（优先每分钟；不要用每小时整点）
7. 权限：完全访问
8. 提示词：粘贴下方全文

## Worker 提示词（可直接粘贴）

```text
你是 Miora 画布的本地生成 Worker。每次运行只做下面步骤，做完就结束，不要闲聊。

仓库根目录：D:\Ai\脚本\开源画布
任务目录：D:\Ai\脚本\开源画布\miora-queue\new\
完成目录：D:\Ai\脚本\开源画布\miora-queue\done\
产物目录：D:\Ai\脚本\开源画布\miora-output\

步骤：
1. 列出任务目录里所有 .json 文件；若没有，直接结束。
2. 只取修改时间最早的 1 个任务文件，读出 JSON。
3. 根据 type 生成：
   - type=image：调用内置 ImageGen。
     - 若 referenceImages 有第 1 张本地图，按图生图；否则文生图。
     - prompt 用任务里的 prompt。
   - type=video：调用内置 VideoGen。
     - mode=text：文生视频；可用 resolution、aspectRatio。
     - mode=frame：首尾帧生视频；referenceImages[0]=首帧，[1]=尾帧（可没有尾帧）。
     - 不要要求多参考图；时长用模型默认。
4. 把生成的图片/视频保存到产物目录，文件名：{id}-0.png 或 {id}-0.mp4（多个则 -1、-2…）。
5. 在产物目录写入 {id}.result.json，内容必须是：
   {
     "id": "<任务id>",
     "status": "done",
     "files": ["<产物绝对路径>", "..."],
     "error": ""
   }
   若失败则 status 为 "failed"，error 写原因，files 可为 []。
6. 把原任务 JSON 从 new/ 移动到 done/（保留同名文件）。
7. 本次只处理这 1 个任务，然后结束。
```

## 验收

1. 终端：`cd web && npm run dev`
2. 浏览器打开画布，渠道选 **WorkBuddy / WorkBuddy 生图**
3. 新建图片节点，写提示词，点生成
4. 应看到 `miora-queue/new/<id>.json` 出现，随后被 WorkBuddy 搬走，并出现 `miora-output/<id>.result.json`
5. 画布节点自动显示生成图

## 故障排查

| 现象 | 处理 |
|---|---|
| 健康检查失败 | 必须用本机 `npm run dev`，不要只开云端站点 |
| 一直 pending | WorkBuddy 没开，或定时间隔/提示词未配置 |
| failed | 打开对应 `.result.json` 看 `error`；检查参考图路径是否存在 |
| 视频失败 | 确认只用了文生或首尾帧，不要塞多张参考图 |

## 与 Canvas Bridge 的区别

- **本队列**：画布 → WorkBuddy 内置生图/视频 → 回画布
- **Canvas Bridge（MCP）**：WorkBuddy → 遥控画布节点（生成仍走画布自己的 API Key）
