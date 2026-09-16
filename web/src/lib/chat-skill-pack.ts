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

export type LocalSkillPack = {
    id: string;
    name: string;
    description: string;
    version?: string;
    systemHint?: string;
    tools: LocalSkillPackTool[];
    installedAt?: number;
    updatedAt?: number;
};

const PACK_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;
const RESERVED_PACK_IDS = new Set(["canvas", "utils"]);
const MAX_TOOLS = 24;
const MAX_JSON_CHARS = 200_000;

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
        tools,
    };
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
