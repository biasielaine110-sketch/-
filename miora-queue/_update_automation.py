# -*- coding: utf-8 -*-
"""Update existing WorkBuddy miora-queue automation to short interval + latest prompt."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

DB = Path(r"C:\Users\zhangbiwen\.workbuddy\workbuddy.db")
REPO = Path(r"D:\Ai\脚本\开源画布")
AUTOMATION_ID = "8ff621d8-c8cf-4c80-b67a-47266344d1c6"
# WorkBuddy UI officially exposes hourly intervals; MINUTELY is the shortest practical RRULE.
# 1 minute ≈ short-interval for canvas UX (not hourly).
RRULE = "FREQ=MINUTELY;INTERVAL=1"

PROMPT = f"""你是 Miora 画布的本地生成 Worker。每次运行只做下面步骤，做完就结束，不要闲聊。

仓库根目录：{REPO}
任务目录：{REPO / "miora-queue" / "new"}
完成目录：{REPO / "miora-queue" / "done"}
产物目录：{REPO / "miora-output"}

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
4. 把生成的图片/视频保存到产物目录，文件名：{{id}}-0.png 或 {{id}}-0.mp4（多个则 -1、-2…）。
5. 在产物目录写入 {{id}}.result.json，内容必须是：
   {{
     "id": "<任务id>",
     "status": "done",
     "files": ["<产物绝对路径>", "..."],
     "error": ""
   }}
   若失败则 status 为 "failed"，error 写原因，files 可为 []。
6. 把原任务 JSON 从 new/ 移动到 done/（保留同名文件）。
7. 本次只处理这 1 个任务，然后结束。
"""


def main() -> None:
    now_ms = int(time.time() * 1000)
    next_run = now_ms + 20_000  # ~20s later so WorkBuddy picks it up soon
    cwds = json.dumps([str(REPO)], ensure_ascii=False)

    # Ensure queue dirs exist
    for p in (REPO / "miora-queue" / "new", REPO / "miora-queue" / "done", REPO / "miora-output"):
        p.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    row = cur.execute("SELECT id, name, rrule, status FROM automations WHERE id=?", (AUTOMATION_ID,)).fetchone()
    if not row:
        # create new if missing
        new_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO automations (
                id, name, prompt, status, schedule_type, next_run_at, last_run_at,
                cwds, rrule, scheduled_at, valid_from, valid_until,
                model_id, model_is_thinking, skills_json,
                push_to_wechat, push_to_wecom_bot, wecom_bot_source,
                owner_user_id, owner_status, owner_source,
                expert_id, expert_marketplace, connector_ids_json,
                permission_mode, created_at, updated_at, deleted_at, context_window
            ) VALUES (
                ?, ?, ?, 'ACTIVE', 'recurring', ?, NULL,
                ?, ?, NULL, NULL, NULL,
                'deepseek-v4-pro', 0, '[]',
                0, 0, NULL,
                NULL, 'legacy_unassigned', NULL,
                NULL, NULL, '[]',
                'full_access', ?, ?, NULL, NULL
            )
            """,
            (new_id, "Miora 画布队列 Worker（短间隔）", PROMPT, next_run, cwds, RRULE, now_ms, now_ms),
        )
        automation_id = new_id
        action = "created"
    else:
        cur.execute(
            """
            UPDATE automations
            SET name = ?,
                prompt = ?,
                status = 'ACTIVE',
                schedule_type = 'recurring',
                rrule = ?,
                cwds = ?,
                next_run_at = ?,
                permission_mode = COALESCE(permission_mode, 'full_access'),
                updated_at = ?,
                deleted_at = NULL
            WHERE id = ?
            """,
            (
                "Miora 画布队列 Worker（短间隔）",
                PROMPT,
                RRULE,
                cwds,
                next_run,
                now_ms,
                AUTOMATION_ID,
            ),
        )
        automation_id = AUTOMATION_ID
        action = "updated"

    # Clear stuck runtime error so next tick can run
    cur.execute(
        """
        INSERT INTO automation_runtime_state (automation_id, last_run_at, last_error, running, running_started_at, running_conversation_id, metadata_json)
        VALUES (?, NULL, NULL, 0, NULL, NULL, NULL)
        ON CONFLICT(automation_id) DO UPDATE SET
            last_error = NULL,
            running = 0,
            running_started_at = NULL,
            running_conversation_id = NULL
        """,
        (automation_id,),
    )

    con.commit()

    verify = cur.execute(
        "SELECT id, name, status, rrule, next_run_at, cwds, substr(prompt,1,80) AS prompt_head FROM automations WHERE id=?",
        (automation_id,),
    ).fetchone()
    con.close()

    out = {
        "ok": True,
        "action": action,
        "id": automation_id,
        "name": verify["name"],
        "status": verify["status"],
        "rrule": verify["rrule"],
        "next_run_at": verify["next_run_at"],
        "cwds": verify["cwds"],
        "prompt_head": verify["prompt_head"],
        "note": "WorkBuddy 官方 UI 最短常为按小时；已改为每分钟 RRULE。若客户端不认 MINUTELY，请在定时任务里改成最短可用间隔并点立即运行。",
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
