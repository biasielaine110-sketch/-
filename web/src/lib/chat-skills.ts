import i18n from "@/i18n";
import {
    findPackByNamespacedId,
    mapBuiltinArgs,
    namespacedToolName,
    parseNamespacedToolName,
    renderSkillTemplate,
    type LocalSkillPack,
} from "@/lib/chat-skill-pack";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export type ChatSkillTool = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ChatSkillDefinition = {
    id: string;
    /** i18n key under canvas.chat.skills.* — builtin only */
    nameKey?: string;
    descriptionKey?: string;
    name?: string;
    description?: string;
    source: "builtin" | "local";
    systemHint?: string;
    tools: ChatSkillTool[];
    removable?: boolean;
};

export type ChatSkillCanvasContext = {
    chatNodeId: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    updateNodeMetadata?: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    selectNode?: (nodeId: string) => void;
};

const chatText = (key: string, options?: Record<string, unknown>) => i18n.t(`canvas.chat.${key}`, options);

/** Default skill ids enabled on new chat nodes (and when metadata.chatSkillIds is unset). */
export const DEFAULT_CHAT_SKILL_IDS = ["canvas", "utils"] as const;

export function resolveChatSkillIds(skillIds: string[] | undefined | null): string[] {
    return skillIds ?? [...DEFAULT_CHAT_SKILL_IDS];
}

const BUILTIN_CHAT_SKILLS: ChatSkillDefinition[] = [
    {
        id: "canvas",
        source: "builtin",
        nameKey: "skillCanvas",
        descriptionKey: "skillCanvasDesc",
        tools: [
            {
                type: "function",
                function: {
                    name: "list_canvas_nodes",
                    description: "List nodes on the current canvas. Optionally filter by type (image, text, video, audio, chat, group, etc.).",
                    parameters: {
                        type: "object",
                        properties: {
                            type: { type: "string", description: "Optional node type filter" },
                            limit: { type: "number", description: "Max nodes to return (default 40)" },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "read_node",
                    description: "Read a canvas node's title, type, status, and text/prompt content by node id.",
                    parameters: {
                        type: "object",
                        properties: {
                            node_id: { type: "string", description: "Canvas node id" },
                        },
                        required: ["node_id"],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "search_canvas",
                    description: "Search canvas nodes by title, prompt, or text content.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Search keyword" },
                            limit: { type: "number", description: "Max matches (default 20)" },
                        },
                        required: ["query"],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "get_chat_connections",
                    description: "List nodes connected to the current chat node (upstream/downstream context).",
                    parameters: {
                        type: "object",
                        properties: {},
                        additionalProperties: false,
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "update_node_prompt",
                    description:
                        "Write text into a canvas node's prompt/input box (video, image, audio, config composer) or text-node body. Use when the user asks to put a prompt into a node. Prefer connected video/image nodes from get_chat_connections when the target is ambiguous.",
                    parameters: {
                        type: "object",
                        properties: {
                            node_id: { type: "string", description: "Target canvas node id" },
                            prompt: { type: "string", description: "Full prompt/text to write into the node" },
                            mode: {
                                type: "string",
                                description: "replace (default) or append to existing text",
                                enum: ["replace", "append"],
                            },
                        },
                        required: ["node_id", "prompt"],
                        additionalProperties: false,
                    },
                },
            },
        ],
    },
    {
        id: "utils",
        source: "builtin",
        nameKey: "skillUtils",
        descriptionKey: "skillUtilsDesc",
        tools: [
            {
                type: "function",
                function: {
                    name: "get_current_time",
                    description: "Return the current local date-time and timezone.",
                    parameters: {
                        type: "object",
                        properties: {},
                        additionalProperties: false,
                    },
                },
            },
        ],
    },
];

/** @deprecated use listChatSkills(); kept for callers expecting a constant array of builtins */
export const CHAT_SKILLS = BUILTIN_CHAT_SKILLS;

function localPackToDefinition(pack: LocalSkillPack): ChatSkillDefinition {
    return {
        id: pack.id,
        source: "local",
        name: pack.name,
        description: pack.description,
        systemHint: pack.systemHint,
        removable: true,
        tools: pack.tools.map((tool) => ({
            type: "function" as const,
            function: {
                name: namespacedToolName(pack.id, tool.name),
                description: `[${pack.name}] ${tool.description}`,
                parameters: tool.parameters || { type: "object", properties: {}, additionalProperties: false },
            },
        })),
    };
}

export function listChatSkills(): ChatSkillDefinition[] {
    const packs = useChatSkillPacksStore.getState().packs;
    return [...BUILTIN_CHAT_SKILLS, ...packs.map(localPackToDefinition)];
}

export function resolveChatSkillTools(skillIds: string[] | undefined): ChatSkillTool[] {
    const selected = new Set(resolveChatSkillIds(skillIds));
    return listChatSkills()
        .filter((skill) => selected.has(skill.id))
        .flatMap((skill) => skill.tools);
}

export function chatSkillsSystemHint(skillIds: string[] | undefined) {
    const selected = new Set(resolveChatSkillIds(skillIds));
    const skills = listChatSkills().filter((skill) => selected.has(skill.id));
    const tools = skills.flatMap((skill) => skill.tools);
    if (!tools.length) return "";
    const names = tools.map((tool) => tool.function.name).join(", ");
    const packHints = skills
        .filter((skill) => skill.source === "local" && skill.systemHint)
        .map((skill) => `- ${skill.name || skill.id}: ${skill.systemHint}`)
        .join("\n");
    const base = chatText("skillsSystemHint", { tools: names });
    return packHints ? `${base}\n\n${chatText("skillsLocalPackHints")}\n${packHints}` : base;
}

export function getChatSkillDisplayName(skill: ChatSkillDefinition) {
    if (skill.name) return skill.name;
    if (skill.nameKey) return chatText(skill.nameKey);
    return skill.id;
}

export function getChatSkillDisplayDescription(skill: ChatSkillDefinition) {
    if (skill.description) return skill.description;
    if (skill.descriptionKey) return chatText(skill.descriptionKey);
    return "";
}

export async function executeChatSkillTool(
    name: string,
    args: Record<string, unknown>,
    context: ChatSkillCanvasContext,
): Promise<string> {
    try {
        const builtinResult = await executeBuiltinTool(name, args, context);
        if (builtinResult !== null) return builtinResult;

        const localResult = await executeLocalPackTool(name, args, context);
        if (localResult !== null) return localResult;

        return jsonResult({ error: chatText("skillsUnknownTool", { name }) });
    } catch (error) {
        return jsonResult({ error: error instanceof Error ? error.message : String(error) });
    }
}

async function executeBuiltinTool(name: string, args: Record<string, unknown>, context: ChatSkillCanvasContext): Promise<string | null> {
    switch (name) {
        case "list_canvas_nodes":
            return jsonResult(listCanvasNodes(context, args));
        case "read_node":
            return jsonResult(readNode(context, String(args.node_id || "")));
        case "search_canvas":
            return jsonResult(searchCanvas(context, String(args.query || ""), Number(args.limit)));
        case "get_chat_connections":
            return jsonResult(getChatConnections(context));
        case "update_node_prompt":
            return jsonResult(updateNodePrompt(context, String(args.node_id || ""), String(args.prompt ?? ""), String(args.mode || "replace")));
        case "get_current_time":
            return jsonResult({
                iso: new Date().toISOString(),
                local: new Date().toLocaleString(),
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
        default:
            return null;
    }
}

async function executeLocalPackTool(name: string, args: Record<string, unknown>, context: ChatSkillCanvasContext): Promise<string | null> {
    const parsed = parseNamespacedToolName(name);
    if (!parsed) return null;
    const pack = findPackByNamespacedId(useChatSkillPacksStore.getState().packs, parsed.packId);
    if (!pack) return jsonResult({ error: chatText("skillsPackNotFound", { id: parsed.packId }) });
    const tool = pack.tools.find((item) => sanitizeToolMatch(item.name) === parsed.toolName);
    if (!tool) return jsonResult({ error: chatText("skillsUnknownTool", { name }) });

    const action = tool.action;
    if (action.type === "template") {
        return jsonResult({
            ok: true,
            packId: pack.id,
            tool: tool.name,
            text: renderSkillTemplate(action.template, args),
        });
    }
    if (action.type === "static") {
        return jsonResult({ ok: true, packId: pack.id, tool: tool.name, result: action.result });
    }
    if (action.type === "return_args") {
        return jsonResult({ ok: true, packId: pack.id, tool: tool.name, args });
    }
    if (action.type === "builtin") {
        const mapped = mapBuiltinArgs(args, action.argMap);
        const result = await executeBuiltinTool(action.builtin, mapped, context);
        if (result === null) return jsonResult({ error: chatText("skillsUnknownTool", { name: action.builtin }) });
        return result;
    }
    return jsonResult({ error: chatText("skillsUnknownTool", { name }) });
}

function jsonResult(value: unknown) {
    return JSON.stringify(value, null, 2);
}

function listCanvasNodes(context: ChatSkillCanvasContext, args: Record<string, unknown>) {
    const typeFilter = String(args.type || "")
        .trim()
        .toLowerCase();
    const limit = clampLimit(args.limit, 40);
    const nodes = context.nodes
        .filter((node) => !typeFilter || String(node.type).toLowerCase() === typeFilter)
        .slice(0, limit)
        .map((node) => summarizeNode(node, false));
    return { count: nodes.length, nodes };
}

function readNode(context: ChatSkillCanvasContext, nodeId: string) {
    const node = context.nodes.find((item) => item.id === nodeId);
    if (!node) return { error: chatText("skillsNodeNotFound", { id: nodeId }) };
    return summarizeNode(node, true);
}

function searchCanvas(context: ChatSkillCanvasContext, query: string, limitArg: number) {
    const needle = query.trim().toLowerCase();
    if (!needle) return { count: 0, nodes: [] };
    const limit = clampLimit(limitArg, 20);
    const nodes = context.nodes
        .filter((node) => {
            const haystack = [node.title, node.metadata?.content, node.metadata?.prompt, node.metadata?.composerContent]
                .filter(Boolean)
                .join("\n")
                .toLowerCase();
            return haystack.includes(needle);
        })
        .slice(0, limit)
        .map((node) => summarizeNode(node, false));
    return { count: nodes.length, query, nodes };
}

function getChatConnections(context: ChatSkillCanvasContext) {
    const chatId = context.chatNodeId;
    const upstreamIds = context.connections.filter((item) => item.toNodeId === chatId).map((item) => item.fromNodeId);
    const downstreamIds = context.connections.filter((item) => item.fromNodeId === chatId).map((item) => item.toNodeId);
    const byId = new Map(context.nodes.map((node) => [node.id, node]));
    return {
        chatNodeId: chatId,
        upstream: upstreamIds.map((id) => summarizeNode(byId.get(id), false)).filter(Boolean),
        downstream: downstreamIds.map((id) => summarizeNode(byId.get(id), false)).filter(Boolean),
    };
}

function updateNodePrompt(context: ChatSkillCanvasContext, nodeId: string, prompt: string, modeRaw: string) {
    if (!context.updateNodeMetadata) {
        return { error: chatText("skillsWriteUnavailable") };
    }
    const node = context.nodes.find((item) => item.id === nodeId);
    if (!node) return { error: chatText("skillsNodeNotFound", { id: nodeId }) };
    if (node.type === CanvasNodeType.Chat || node.type === CanvasNodeType.Group) {
        return { error: chatText("skillsWriteUnsupportedType", { type: node.type }) };
    }

    const mode = modeRaw.trim().toLowerCase() === "append" ? "append" : "replace";
    const existing =
        node.type === CanvasNodeType.Text
            ? node.metadata?.content || node.metadata?.prompt || node.metadata?.composerContent || ""
            : node.metadata?.composerContent || node.metadata?.prompt || node.metadata?.content || "";
    const nextText = mode === "append" ? `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${prompt}` : prompt;
    const stamp = Date.now();

    if (node.type === CanvasNodeType.Text) {
        context.updateNodeMetadata(nodeId, {
            content: nextText,
            prompt: nextText,
            composerContent: nextText,
            promptSyncAt: stamp,
        });
    } else {
        context.updateNodeMetadata(nodeId, {
            prompt: nextText,
            composerContent: nextText,
            promptSyncAt: stamp,
        });
    }

    context.selectNode?.(nodeId);

    return {
        ok: true,
        node_id: nodeId,
        type: node.type,
        title: node.title,
        mode,
        promptLength: nextText.length,
        promptPreview: nextText.slice(0, 240),
    };
}

function summarizeNode(node: CanvasNodeData | undefined, includeContent: boolean) {
    if (!node) return null;
    const text = (node.metadata?.content || node.metadata?.prompt || node.metadata?.composerContent || "").trim();
    return {
        id: node.id,
        type: node.type,
        title: node.title,
        status: node.metadata?.status || "idle",
        hasMedia: Boolean(node.metadata?.content || node.metadata?.storageKey),
        messageCount: node.metadata?.messages?.length || 0,
        ...(includeContent
            ? {
                  contentPreview: text.slice(0, 4000),
                  contentLength: text.length,
                  prompt: (node.metadata?.prompt || "").slice(0, 2000),
                  composerContent: (node.metadata?.composerContent || "").slice(0, 2000),
              }
            : {
                  contentPreview: text ? text.slice(0, 160) : "",
              }),
    };
}

function clampLimit(value: unknown, fallback: number) {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(100, numeric);
}

function sanitizeToolMatch(value: string) {
    return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
