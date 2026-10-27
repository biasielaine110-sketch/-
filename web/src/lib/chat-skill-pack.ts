export type LocalSkillPackAction =
    | { type: "template"; template: string }
    | { type: "static"; result: unknown }
    | { type: "return_args" }
    | { type: "builtin"; builtin: string; argMap?: Record<string, string> };

export type LocalSkillPackTool = {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    action: LocalSkillPackAction;
};

/**
 * pack = 声明式工具包（.json / skill.json）：真的挂 function-calling 工具。
 * doc  = 文档技能（SKILL.md）：没有工具，正文整段当说明塞进 system 提示词。
 * 老数据没有这个字段，一律按 pack 处理。
 */
export type LocalSkillPackKind = "pack" | "doc";

export type LocalSkillPack = {
    id: string;
    name: string;
    description: string;
    version?: string;
    systemHint?: string;
    kind?: LocalSkillPackKind;
    /** 从文件夹导入时读过多少个文件（UI 提示用，不参与运行） */
    fileCount?: number;
    tools: LocalSkillPackTool[];
    installedAt?: number;
    updatedAt?: number;
};

/** 导入侧的统一形状：一个文件 = { path, text }。path 用 `/` 分隔（文件夹导入时含相对路径）。 */
export type SkillSourceFile = { path: string; text: string };

const PACK_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;
const RESERVED_PACK_IDS = new Set(["canvas", "utils"]);
const MAX_TOOLS = 24;
const MAX_JSON_CHARS = 200_000;
const MAX_FILE_CHARS = 200_000;
/** 文档技能的正文要塞进每次请求的 system 提示词，所以单独设一个（比 pack 的 4000 宽）。 */
const MAX_DOC_HINT_CHARS = 8_000;
const MARKDOWN_RE = /\.(md|markdown)$/i;
const READABLE_RE = /\.(md|markdown|txt|json)$/i;
const SKIP_DIR_RE = /(^|\/)(node_modules|\.git|\.next|dist|build|__pycache__|\.venv|\.idea)(\/|$)/i;

export function namespacedToolName(packId: string, toolName: string) {
    return `${sanitizeId(packId)}__${sanitizeId(toolName)}`;
}

export function parseNamespacedToolName(name: string): { packId: string; toolName: string } | null {
    const index = name.indexOf("__");
    if (index <= 0) return null;
    return { packId: name.slice(0, index), toolName: name.slice(index + 2) };
}

export function findPackByNamespacedId(packs: LocalSkillPack[], namespacedPackId: string) {
    return packs.find((pack) => sanitizeId(pack.id) === namespacedPackId);
}

export function parseLocalSkillPackJson(raw: string): LocalSkillPack {
    if (raw.length > MAX_JSON_CHARS) {
        throw new Error("skill pack too large");
    }
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error("invalid JSON");
    }
    return validateLocalSkillPack(data);
}

/**
 * 导入统一入口：一个 `.json` / 一个 `.md` / 一整个文件夹，都走这里。
 *  - 单个文件：`.md` → 文档技能；其余（.json）→ 工具包。
 *  - 多个文件（webkitdirectory 选文件夹，或一次选多个）→ 按文件夹处理。
 */
export function parseSkillSources(files: SkillSourceFile[]): LocalSkillPack {
    const list = files.filter((file) => typeof file?.text === "string" && file.path);
    if (!list.length) throw new Error("没有可读的文件");
    if (list.length === 1) {
        const only = list[0];
        return MARKDOWN_RE.test(only.path) ? parseSkillMarkdown(only.text, only.path) : parseLocalSkillPackJson(only.text);
    }
    return parseSkillFolderFiles(list);
}

/** SKILL.md → 文档技能：frontmatter 取 id/name/description，正文整段当 systemHint。 */
export function parseSkillMarkdown(raw: string, fileName = "SKILL.md"): LocalSkillPack {
    if (String(raw || "").length > MAX_FILE_CHARS) throw new Error("markdown 太大（>200KB）");
    const { data, body } = splitFrontmatter(raw);
    const heading = /^\s{0,3}#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() || "";
    const name = (data.name || data.title || heading || parentFolderName(fileName) || "skill").slice(0, 80);
    const description = (data.description || firstParagraph(body) || name).slice(0, 300);
    return {
        id: normalizePackId(data.id || name),
        name,
        description,
        version: data.version ? String(data.version).slice(0, 32) : undefined,
        systemHint: composeDocHint(body, []),
        kind: "doc",
        tools: [],
    };
}

/**
 * 文件夹 → 技能。识别顺序：
 *  1. `skill.json` / `*.skill.json`（浅的优先）→ 工具包；若包里没 systemHint 且旁边有 SKILL.md，用 SKILL.md 正文补上。
 *  2. `SKILL.md`（浅的优先）→ 文档技能，正文 + 同目录其它 `.md` 按「参考文件」附在后面（总量封顶）。
 *  3. 都没有 → 报错（不猜）。
 */
export function parseSkillFolderFiles(files: SkillSourceFile[]): LocalSkillPack {
    const readable = files
        .map((file) => ({ path: normalizePath(file.path), text: String(file.text ?? "") }))
        .filter((file) => file.path && !SKIP_DIR_RE.test(file.path) && READABLE_RE.test(file.path) && file.text.length <= MAX_FILE_CHARS);
    const jsonFiles = readable.filter((file) => isPackJsonPath(file.path)).sort(byShallowDepth);
    const mdFiles = readable.filter((file) => isSkillMarkdownPath(file.path)).sort(byShallowDepth);

    // 同名深浅冲突时，谁更靠外就用谁（根目录的 SKILL.md 才是正主，examples/ 里的不是）。
    const useJson = Boolean(jsonFiles.length) && (!mdFiles.length || depthOf(jsonFiles[0].path) <= depthOf(mdFiles[0].path));
    if (useJson) {
        const pack = parseLocalSkillPackJson(jsonFiles[0].text);
        const doc = mdFiles[0] ? splitFrontmatter(mdFiles[0].text).body : "";
        return { ...pack, kind: "pack", systemHint: pack.systemHint || (doc ? composeDocHint(doc, []) : undefined), fileCount: files.length };
    }
    if (mdFiles.length) {
        const main = mdFiles[0];
        const { data, body } = splitFrontmatter(main.text);
        const doc = parseSkillMarkdown(main.text, main.path);
        const extras = readable
            .filter((file) => file.path !== main.path && MARKDOWN_RE.test(file.path))
            .sort(byShallowDepth)
            .map((file) => ({ name: file.path, text: splitFrontmatter(file.text).body }));
        return {
            ...doc,
            name: (data.name || data.title || doc.name).slice(0, 80),
            systemHint: composeDocHint(body, extras),
            fileCount: files.length,
        };
    }
    throw new Error("文件夹里既没有 SKILL.md，也没有 skill.json");
}

/** `---\\nkey: value\\n---` 的前置块；没有就整篇当正文。 */
function splitFrontmatter(raw: string): { data: Record<string, string>; body: string } {
    const text = String(raw || "").replace(/^\uFEFF/, "");
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!match) return { data: {}, body: text.trim() };
    const data: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
        const index = line.indexOf(":");
        if (index <= 0) continue;
        const key = line.slice(0, index).trim().toLowerCase();
        let value = line.slice(index + 1).trim();
        if (!key || !value) continue;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        data[key] = value;
    }
    return { data, body: text.slice(match[0].length).trim() };
}

/** 正文 + 参考文件，超长截断（这段要占 system 提示词预算）。 */
function composeDocHint(body: string, extras: Array<{ name: string; text: string }>) {
    const parts = [body.trim()];
    for (const extra of extras) {
        const text = extra.text.trim();
        if (!text) continue;
        parts.push(`## 参考文件：${extra.name}\n${text}`);
    }
    const joined = parts.filter(Boolean).join("\n\n---\n\n");
    if (joined.length <= MAX_DOC_HINT_CHARS) return joined;
    return `${joined.slice(0, MAX_DOC_HINT_CHARS)}\n\n…（内容超长已截断）`;
}

/** 描述兜底：第一段非标题、非列表、非代码块的正文。 */
function firstParagraph(body: string) {
    const buffer: string[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            if (buffer.length) break;
            continue;
        }
        if (/^#{1,6}\s/.test(line) || /^[-*+]\s/.test(line) || line.startsWith("```") || line.startsWith("---")) {
            if (buffer.length) break;
            continue;
        }
        buffer.push(line);
        if (buffer.join(" ").length > 140) break;
    }
    return buffer.join(" ").slice(0, 200);
}

/**
 * 名字 → 合法 id。中文名 slug 出来是空的，就退回 `skill_<hash36>`：
 * 稳定（同一份 md 反复导入会覆盖同一个，不会堆出一串），也满足 PACK_ID_RE。
 */
function normalizePackId(candidate: string) {
    const slug = String(candidate || "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[_-]+|[_-]+$/g, "")
        .slice(0, 60);
    if (PACK_ID_RE.test(slug) && !RESERVED_PACK_IDS.has(slug)) return slug;
    return `skill_${hash36(String(candidate || "doc"))}`;
}

function hash36(value: string) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
    return hash.toString(36);
}

function normalizePath(path: string) {
    return String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "");
}

function baseName(path: string) {
    const parts = normalizePath(path).split("/");
    return parts[parts.length - 1] || "";
}

function parentFolderName(path: string) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : "";
}

function depthOf(path: string) {
    return normalizePath(path).split("/").filter(Boolean).length;
}

function byShallowDepth(a: { path: string }, b: { path: string }) {
    return depthOf(a.path) - depthOf(b.path);
}

function isPackJsonPath(path: string) {
    const base = baseName(path).toLowerCase();
    return base === "skill.json" || base.endsWith(".skill.json");
}

function isSkillMarkdownPath(path: string) {
    return baseName(path).toLowerCase() === "skill.md";
}

export function validateLocalSkillPack(data: unknown): LocalSkillPack {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("skill pack must be an object");
    }
    const pack = data as Record<string, unknown>;
    const id = String(pack.id || "").trim();
    const name = String(pack.name || "").trim();
    const description = String(pack.description || "").trim();
    if (!PACK_ID_RE.test(id)) throw new Error("invalid id (use letters/numbers/_/-)");
    if (RESERVED_PACK_IDS.has(id)) throw new Error(`id "${id}" is reserved`);
    if (!name) throw new Error("name is required");
    if (!description) throw new Error("description is required");

    const toolsRaw = pack.tools;
    if (!Array.isArray(toolsRaw) || !toolsRaw.length) throw new Error("tools must be a non-empty array");
    if (toolsRaw.length > MAX_TOOLS) throw new Error(`at most ${MAX_TOOLS} tools`);

    const tools: LocalSkillPackTool[] = toolsRaw.map((item, index) => validateTool(item, index));
    const names = new Set<string>();
    for (const tool of tools) {
        if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
        names.add(tool.name);
    }

    return {
        id,
        name,
        description,
        version: pack.version ? String(pack.version).slice(0, 32) : undefined,
        systemHint: pack.systemHint ? String(pack.systemHint).slice(0, 4000) : undefined,
        kind: "pack",
        tools,
    };
}

/**
 * 配置 / 备份往返用：同时接受工具包（非空 tools）与文档技能（kind=doc / 空 tools）。
 * 比 validateLocalSkillPack 宽松，用于已落库数据的再导入，而不是安装新 .json。
 */
export function normalizePersistedSkillPack(data: unknown): LocalSkillPack {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("skill pack must be an object");
    }
    const pack = data as Record<string, unknown>;
    const toolsRaw = pack.tools;
    const isDoc = pack.kind === "doc" || (Array.isArray(toolsRaw) && toolsRaw.length === 0);
    if (!isDoc) {
        const validated = validateLocalSkillPack(data);
        return {
            ...validated,
            fileCount: typeof pack.fileCount === "number" ? pack.fileCount : undefined,
            installedAt: typeof pack.installedAt === "number" ? pack.installedAt : undefined,
            updatedAt: typeof pack.updatedAt === "number" ? pack.updatedAt : undefined,
        };
    }

    const id = String(pack.id || "").trim();
    const name = String(pack.name || "").trim();
    const description = String(pack.description || name || "").trim();
    if (!PACK_ID_RE.test(id)) throw new Error("invalid id (use letters/numbers/_/-)");
    if (RESERVED_PACK_IDS.has(id)) throw new Error(`id "${id}" is reserved`);
    if (!name) throw new Error("name is required");

    return {
        id,
        name,
        description: description || name,
        version: pack.version ? String(pack.version).slice(0, 32) : undefined,
        systemHint: pack.systemHint ? String(pack.systemHint).slice(0, MAX_DOC_HINT_CHARS) : undefined,
        kind: "doc",
        fileCount: typeof pack.fileCount === "number" ? pack.fileCount : undefined,
        tools: [],
        installedAt: typeof pack.installedAt === "number" ? pack.installedAt : undefined,
        updatedAt: typeof pack.updatedAt === "number" ? pack.updatedAt : undefined,
    };
}

export function normalizePersistedSkillPacks(raw: unknown): LocalSkillPack[] {
    if (!Array.isArray(raw)) return [];
    const packs: LocalSkillPack[] = [];
    for (const item of raw) {
        try {
            packs.push(normalizePersistedSkillPack(item));
        } catch {
            // skip corrupt entries so one bad pack does not block the whole import
        }
    }
    return packs;
}

export function renderSkillTemplate(template: string, args: Record<string, unknown>) {
    return template.replace(/\{\{\s*([\w.]+)(?:\|([^}]*))?\s*\}\}/g, (_match, key: string, fallback?: string) => {
        const value = lookupArg(args, key);
        if (value == null || value === "") return fallback ?? "";
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
        try {
            return JSON.stringify(value);
        } catch {
            return fallback ?? "";
        }
    });
}

export function mapBuiltinArgs(args: Record<string, unknown>, argMap?: Record<string, string>) {
    if (!argMap || !Object.keys(argMap).length) return args;
    const mapped: Record<string, unknown> = {};
    for (const [targetKey, sourceKey] of Object.entries(argMap)) {
        mapped[targetKey] = lookupArg(args, sourceKey);
    }
    return mapped;
}

function validateTool(item: unknown, index: number): LocalSkillPackTool {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`tools[${index}] must be an object`);
    }
    const tool = item as Record<string, unknown>;
    const name = String(tool.name || "").trim();
    const description = String(tool.description || "").trim();
    if (!TOOL_NAME_RE.test(name)) throw new Error(`tools[${index}].name is invalid`);
    if (!description) throw new Error(`tools[${index}].description is required`);
    const parameters =
        tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
            ? (tool.parameters as Record<string, unknown>)
            : { type: "object", properties: {}, additionalProperties: false };
    return {
        name,
        description: description.slice(0, 500),
        parameters,
        action: validateAction(tool.action, index),
    };
}

function validateAction(action: unknown, index: number): LocalSkillPackAction {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
        throw new Error(`tools[${index}].action is required`);
    }
    const raw = action as Record<string, unknown>;
    const type = String(raw.type || "").trim();
    if (type === "template") {
        const template = String(raw.template || "");
        if (!template.trim()) throw new Error(`tools[${index}].action.template is required`);
        return { type: "template", template: template.slice(0, 8000) };
    }
    if (type === "static") {
        return { type: "static", result: raw.result ?? null };
    }
    if (type === "return_args") {
        return { type: "return_args" };
    }
    if (type === "builtin") {
        const builtin = String(raw.builtin || "").trim();
        if (!builtin) throw new Error(`tools[${index}].action.builtin is required`);
        const argMap =
            raw.argMap && typeof raw.argMap === "object" && !Array.isArray(raw.argMap)
                ? Object.fromEntries(Object.entries(raw.argMap as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
                : undefined;
        return { type: "builtin", builtin, argMap };
    }
    throw new Error(`tools[${index}].action.type must be template|static|return_args|builtin`);
}

function lookupArg(args: Record<string, unknown>, key: string) {
    if (!key.includes(".")) return args[key];
    let current: unknown = args;
    for (const part of key.split(".")) {
        if (!current || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function sanitizeId(value: string) {
    return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
