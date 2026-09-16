import i18n from "@/i18n";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

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
    /** i18n key under canvas.chat.skills.* */
    nameKey: string;
    descriptionKey: string;
    tools: ChatSkillTool[];
};

export type ChatSkillCanvasContext = {
    chatNodeId: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

const chatText = (key: string, options?: Record<string, unknown>) => i18n.t(`canvas.chat.${key}`, options);

export const CHAT_SKILLS: ChatSkillDefinition[] = [
    {
        id: "canvas",
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
        ],
    },
    {
        id: "utils",
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

export function listChatSkills() {
    return CHAT_SKILLS;
}

export function resolveChatSkillTools(skillIds: string[] | undefined): ChatSkillTool[] {
    if (!skillIds?.length) return [];
    const selected = new Set(skillIds);
    return CHAT_SKILLS.filter((skill) => selected.has(skill.id)).flatMap((skill) => skill.tools);
}

export function chatSkillsSystemHint(skillIds: string[] | undefined) {
    const tools = resolveChatSkillTools(skillIds);
    if (!tools.length) return "";
    const names = tools.map((tool) => tool.function.name).join(", ");
    return chatText("skillsSystemHint", { tools: names });
}

export async function executeChatSkillTool(
    name: string,
    args: Record<string, unknown>,
    context: ChatSkillCanvasContext,
): Promise<string> {
    try {
        switch (name) {
            case "list_canvas_nodes":
                return jsonResult(listCanvasNodes(context, args));
            case "read_node":
                return jsonResult(readNode(context, String(args.node_id || "")));
            case "search_canvas":
                return jsonResult(searchCanvas(context, String(args.query || ""), Number(args.limit)));
            case "get_chat_connections":
                return jsonResult(getChatConnections(context));
            case "get_current_time":
                return jsonResult({
                    iso: new Date().toISOString(),
                    local: new Date().toLocaleString(),
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
            default:
                return jsonResult({ error: chatText("skillsUnknownTool", { name }) });
        }
    } catch (error) {
        return jsonResult({ error: error instanceof Error ? error.message : String(error) });
    }
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
