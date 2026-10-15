/**
 * When queue has pending tasks, bump WorkBuddy automation next_run_at to "now".
 * Run alongside WorkBuddy (optional watchdog): node miora-queue/poke-workbuddy.mjs
 * Or: npm run poke-workbuddy (from web/) after wiring — also called automatically on POST /api/miora/generate.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const queueNew = join(root, "miora-queue", "new");
const dbPath = join(homedir(), ".workbuddy", "workbuddy.db");
const automationId = "8ff621d8-c8cf-4c80-b67a-47266344d1c6";
const intervalMs = Number(process.env.MIORA_POKE_MS || 20_000);

function pendingCount() {
    if (!existsSync(queueNew)) return 0;
    return readdirSync(queueNew).filter((name) => name.endsWith(".json")).length;
}

function poke() {
    if (!existsSync(dbPath)) return { ok: false, error: "no db" };
    const pending = pendingCount();
    if (!pending) return { ok: true, pending: 0, poked: false };
    const now = Date.now();
    const db = new DatabaseSync(dbPath);
    try {
        const row =
            db.prepare("SELECT id, name FROM automations WHERE id = ? AND deleted_at IS NULL").get(automationId) ||
            db
                .prepare(
                    `SELECT id, name FROM automations
                     WHERE deleted_at IS NULL AND (name LIKE '%Miora%队列%' OR prompt LIKE '%miora-queue%')
                     ORDER BY updated_at DESC LIMIT 1`,
                )
                .get();
        if (!row?.id) return { ok: false, pending, error: "automation missing" };
        db.prepare(`UPDATE automations SET status='ACTIVE', next_run_at=?, updated_at=?, deleted_at=NULL WHERE id=?`).run(now, now, row.id);
        db.prepare(
            `INSERT INTO automation_runtime_state (automation_id, last_run_at, last_error, running, running_started_at, running_conversation_id, metadata_json)
             VALUES (?, NULL, NULL, 0, NULL, NULL, NULL)
             ON CONFLICT(automation_id) DO UPDATE SET last_error=NULL, running=0, running_started_at=NULL, running_conversation_id=NULL`,
        ).run(row.id);
        return { ok: true, pending, poked: true, id: row.id, name: row.name, at: now };
    } finally {
        db.close();
    }
}

if (process.argv.includes("--once")) {
    console.log(JSON.stringify(poke()));
    process.exit(0);
}

console.log(`[miora-poke] watching ${queueNew} every ${intervalMs}ms — keep WorkBuddy open`);
setInterval(() => {
    try {
        const result = poke();
        if (result.poked) console.log(`[miora-poke] ${new Date().toLocaleTimeString()} pending=${result.pending} nudged ${result.name}`);
    } catch (error) {
        console.warn("[miora-poke]", error instanceof Error ? error.message : error);
    }
}, intervalMs);
