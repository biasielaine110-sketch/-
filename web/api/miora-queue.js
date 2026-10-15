/**
 * Local-only file queue bridge: canvas ↔ WorkBuddy ImageGen / VideoGen.
 * Writes tasks under miora-queue/new/, serves results from miora-output/.
 * Must not be deployed to serverless (no shared local disk).
 */

import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";

const webDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(webDir, "..", "..");
const QUEUE_NEW = resolve(repoRoot, "miora-queue", "new");
const QUEUE_DONE = resolve(repoRoot, "miora-queue", "done");
const OUTPUT_DIR = resolve(repoRoot, "miora-output");
const REFS_DIR = resolve(OUTPUT_DIR, "refs");
const WORKBUDDY_DB = resolve(homedir(), ".workbuddy", "workbuddy.db");
const WORKBUDDY_AUTOMATION_ID = "8ff621d8-c8cf-4c80-b67a-47266344d1c6";

const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".json": "application/json",
};

let dirsReady = false;

async function ensureDirs() {
    if (dirsReady) return;
    await Promise.all([
        mkdir(QUEUE_NEW, { recursive: true }),
        mkdir(QUEUE_DONE, { recursive: true }),
        mkdir(OUTPUT_DIR, { recursive: true }),
        mkdir(REFS_DIR, { recursive: true }),
    ]);
    dirsReady = true;
}

function cors(res, req) {
    const origin = req.headers?.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
}

function sendJson(req, res, status, body) {
    cors(res, req);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolveBody) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) {
                resolveBody(null);
                return;
            }
            try {
                resolveBody(JSON.parse(raw));
            } catch {
                resolveBody(raw);
            }
        });
        req.on("error", () => resolveBody(null));
    });
}

function sanitizeTaskId(value) {
    const id = String(value || "")
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return id || randomUUID();
}

function isPathInside(parent, child) {
    const rel = relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && resolve(child).startsWith(resolve(parent));
}

function mediaUrlForFile(absPath) {
    const rel = relative(OUTPUT_DIR, absPath).split(sep).join("/");
    return `/api/miora/media?file=${encodeURIComponent(rel)}`;
}

function resolveMediaPath(fileParam) {
    const raw = String(fileParam || "").trim();
    if (!raw) return null;
    // Accept absolute paths under OUTPUT_DIR, or relative paths from OUTPUT_DIR.
    const candidate = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")
        ? resolve(raw)
        : resolve(OUTPUT_DIR, raw.replace(/^[/\\]+/, ""));
    if (!isPathInside(OUTPUT_DIR, candidate) && resolve(candidate) !== resolve(OUTPUT_DIR)) return null;
    if (!existsSync(candidate)) return null;
    return candidate;
}

function dataUrlToBuffer(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) return null;
    return {
        mime: match[1].toLowerCase(),
        buffer: Buffer.from(match[2], "base64"),
    };
}

function extForMime(mime) {
    if (mime.includes("png")) return ".png";
    if (mime.includes("webp")) return ".webp";
    if (mime.includes("gif")) return ".gif";
    if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
    if (mime.includes("mp4")) return ".mp4";
    if (mime.includes("webm")) return ".webm";
    return ".bin";
}

async function handleGenerate(req, res, body) {
    await ensureDirs();
    const type = body?.type === "video" ? "video" : "image";
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) {
        sendJson(req, res, 400, { ok: false, error: "prompt required" });
        return;
    }
    const id = sanitizeTaskId(body?.id);
    const mode = body?.mode === "frame" ? "frame" : "text";
    const resolution = String(body?.resolution || "1080P").toUpperCase() === "720P" ? "720P" : "1080P";
    const aspectRatio = String(body?.aspectRatio || "16:9").trim() || "16:9";
    const referenceImages = Array.isArray(body?.referenceImages)
        ? body.referenceImages.map((item) => String(item || "").trim()).filter(Boolean)
        : [];

    const task = {
        id,
        type,
        prompt,
        mode,
        resolution,
        aspectRatio,
        referenceImages,
        createdAt: new Date().toISOString(),
    };

    const taskPath = join(QUEUE_NEW, `${id}.json`);
    if (existsSync(taskPath) || existsSync(join(QUEUE_DONE, `${id}.json`))) {
        sendJson(req, res, 409, { ok: false, error: `task id already exists: ${id}` });
        return;
    }
    await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    // WorkBuddy UI 最短间隔通常是 1 小时；提交任务时把 next_run_at 拨到「现在」，
    // 催本机已开启的定时任务尽快跑，实现近似事件触发的自动化。
    const poke = pokeWorkbuddyAutomation();
    sendJson(req, res, 200, { ok: true, id, workbuddy: poke });
}

/**
 * Nudge the local WorkBuddy automation scheduler so a pending queue job is picked up
 * without waiting for the next hourly tick. Requires WorkBuddy desktop to be running.
 */
function pokeWorkbuddyAutomation() {
    try {
        if (!existsSync(WORKBUDDY_DB)) {
            return { ok: false, error: "workbuddy.db not found" };
        }
        const now = Date.now();
        const db = new DatabaseSync(WORKBUDDY_DB);
        try {
            const byId = db.prepare("SELECT id, name, status FROM automations WHERE id = ? AND deleted_at IS NULL").get(WORKBUDDY_AUTOMATION_ID);
            const row =
                byId ||
                db
                    .prepare(
                        `SELECT id, name, status FROM automations
                         WHERE deleted_at IS NULL
                           AND (name LIKE '%Miora%队列%' OR name LIKE '%画布队列%' OR prompt LIKE '%miora-queue%')
                         ORDER BY updated_at DESC LIMIT 1`,
                    )
                    .get();
            if (!row?.id) {
                return { ok: false, error: "automation not found — open WorkBuddy 定时任务 and keep the worker enabled" };
            }
            db.prepare(
                `UPDATE automations
                 SET status = 'ACTIVE',
                     next_run_at = ?,
                     updated_at = ?,
                     deleted_at = NULL
                 WHERE id = ?`,
            ).run(now, now, row.id);
            db.prepare(
                `INSERT INTO automation_runtime_state (automation_id, last_run_at, last_error, running, running_started_at, running_conversation_id, metadata_json)
                 VALUES (?, NULL, NULL, 0, NULL, NULL, NULL)
                 ON CONFLICT(automation_id) DO UPDATE SET
                   last_error = NULL,
                   running = 0,
                   running_started_at = NULL,
                   running_conversation_id = NULL`,
            ).run(row.id);
            return { ok: true, automationId: row.id, name: row.name, nextRunAt: now };
        } finally {
            db.close();
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function handleResult(req, res, id) {
    await ensureDirs();
    const taskId = sanitizeTaskId(id);
    const resultPath = join(OUTPUT_DIR, `${taskId}.result.json`);
    if (!existsSync(resultPath)) {
        const pending = existsSync(join(QUEUE_NEW, `${taskId}.json`)) || existsSync(join(QUEUE_DONE, `${taskId}.json`));
        sendJson(req, res, 200, { ok: true, id: taskId, status: pending ? "pending" : "pending" });
        return;
    }
    try {
        const raw = JSON.parse(await readFile(resultPath, "utf8"));
        const status = raw?.status === "failed" ? "failed" : raw?.status === "done" ? "done" : "pending";
        const files = Array.isArray(raw?.files)
            ? raw.files
                  .map((item) => String(item || "").trim())
                  .filter(Boolean)
                  .map((abs) => {
                      const resolved = resolveMediaPath(abs) || (/^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith("/") ? null : resolveMediaPath(abs));
                      if (resolved) return mediaUrlForFile(resolved);
                      // Already a relative media URL or relative path under output.
                      if (abs.startsWith("/api/miora/media")) return abs;
                      const underOutput = resolveMediaPath(abs);
                      return underOutput ? mediaUrlForFile(underOutput) : abs;
                  })
            : [];
        sendJson(req, res, 200, {
            ok: true,
            id: taskId,
            status,
            files,
            error: String(raw?.error || ""),
        });
    } catch (error) {
        sendJson(req, res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}

async function handleUploadRef(req, res, body) {
    await ensureDirs();
    const parsed = dataUrlToBuffer(body?.dataUrl || body?.data || "");
    if (!parsed) {
        sendJson(req, res, 400, { ok: false, error: "dataUrl (base64) required" });
        return;
    }
    const id = sanitizeTaskId(body?.id || `ref-${Date.now()}`);
    const ext = extForMime(parsed.mime);
    const filePath = join(REFS_DIR, `${id}${ext}`);
    await writeFile(filePath, parsed.buffer);
    sendJson(req, res, 200, { ok: true, path: filePath, url: mediaUrlForFile(filePath) });
}

async function handleMedia(req, res, fileParam) {
    await ensureDirs();
    const filePath = resolveMediaPath(fileParam);
    if (!filePath) {
        sendJson(req, res, 404, { ok: false, error: "file not found" });
        return;
    }
    const ext = extname(filePath).toLowerCase();
    cors(res, req);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_BY_EXT[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    createReadStream(filePath).pipe(res);
}

async function handleHealth(req, res) {
    await ensureDirs();
    let pending = 0;
    try {
        pending = (await readdir(QUEUE_NEW)).filter((name) => name.endsWith(".json")).length;
    } catch {
        pending = 0;
    }
    sendJson(req, res, 200, {
        ok: true,
        repoRoot,
        queueNew: QUEUE_NEW,
        queueDone: QUEUE_DONE,
        outputDir: OUTPUT_DIR,
        pending,
        pollHintSeconds: 15,
    });
}

/** Move oldest pending task to done/ after worker writes result — optional helper for workers. */
async function handleAck(req, res, body) {
    await ensureDirs();
    const id = sanitizeTaskId(body?.id);
    const from = join(QUEUE_NEW, `${id}.json`);
    const to = join(QUEUE_DONE, `${id}.json`);
    if (!existsSync(from)) {
        sendJson(req, res, 404, { ok: false, error: "task not in new/" });
        return;
    }
    await rename(from, to);
    sendJson(req, res, 200, { ok: true, id });
}

export async function handleMioraQueue(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
        cors(res, req);
        res.statusCode = 204;
        res.end();
        return;
    }

    try {
        if (pathname === "/api/miora/health" && req.method === "GET") {
            await handleHealth(req, res);
            return;
        }
        if (pathname === "/api/miora/generate" && req.method === "POST") {
            const body = await readBody(req);
            await handleGenerate(req, res, body && typeof body === "object" ? body : {});
            return;
        }
        if (pathname === "/api/miora/upload-ref" && req.method === "POST") {
            const body = await readBody(req);
            await handleUploadRef(req, res, body && typeof body === "object" ? body : {});
            return;
        }
        if (pathname === "/api/miora/ack" && req.method === "POST") {
            const body = await readBody(req);
            await handleAck(req, res, body && typeof body === "object" ? body : {});
            return;
        }
        if (pathname === "/api/miora/media" && req.method === "GET") {
            await handleMedia(req, res, url.searchParams.get("file"));
            return;
        }
        const resultMatch = pathname.match(/^\/api\/miora\/result\/([^/]+)$/);
        if (resultMatch && req.method === "GET") {
            await handleResult(req, res, decodeURIComponent(resultMatch[1]));
            return;
        }
        if (pathname === "/api/miora/result" && req.method === "GET") {
            await handleResult(req, res, url.searchParams.get("id") || "");
            return;
        }

        sendJson(req, res, 404, { ok: false, error: `unknown route: ${pathname}` });
    } catch (error) {
        if (res.headersSent) return;
        sendJson(req, res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
