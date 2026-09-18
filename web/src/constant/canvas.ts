import i18n from "@/i18n";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { getNodeSpec as getRegistryNodeSpec } from "@/lib/canvas/node-registry";
import { DEFAULT_CHAT_SKILL_IDS } from "@/lib/chat-skills";

/** Default font size for text nodes on the canvas. */
export const DEFAULT_CANVAS_FONT_SIZE = 16;
/** Default font size for the chat node UI and message body. */
export const DEFAULT_CHAT_FONT_SIZE = 20;

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.image"); } },
    [CanvasNodeType.Text]: { width: 340, height: 480, get title() { return i18n.t("canvas.nodeTypes.text"); } },
    [CanvasNodeType.Config]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.config"); } },
    [CanvasNodeType.Video]: { width: 420, height: 236, get title() { return i18n.t("canvas.nodeTypes.video"); } },
    [CanvasNodeType.Audio]: { width: 340, height: 120, get title() { return i18n.t("canvas.nodeTypes.audio"); } },
    [CanvasNodeType.Group]: { width: 760, height: 480, get title() { return i18n.t("canvas.nodeTypes.group"); } },
    [CanvasNodeType.Director]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.director"); } },
    [CanvasNodeType.Chat]: { width: 840, height: 1387, get title() { return i18n.t("canvas.nodeTypes.chat"); } },
    [CanvasNodeType.Annotate]: { width: 420, height: 320, get title() { return i18n.t("canvas.nodeTypes.annotate"); } },
    [CanvasNodeType.Merge]: { width: 480, height: 420, get title() { return i18n.t("canvas.nodeTypes.merge"); } },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Image].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        width: 340, height: 480, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Text].title; },
        metadata: { content: "", status: "idle", fontSize: DEFAULT_CANVAS_FONT_SIZE },
    },
    [CanvasNodeType.Config]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Config].title; },
        metadata: { content: "", status: "idle", generationMode: "image" },
    },
    [CanvasNodeType.Video]: {
        width: 420, height: 236, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Video].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        width: 340, height: 120, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Audio].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Group]: {
        width: 760, height: 480, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Group].title; },
        metadata: { status: "idle" },
    },
    [CanvasNodeType.Director]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Director].title; },
        metadata: { status: "idle" },
    },
    [CanvasNodeType.Chat]: {
        width: 840, height: 1387, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Chat].title; },
        metadata: { status: "idle", messages: [], fontSize: DEFAULT_CHAT_FONT_SIZE, chatSkillIds: [...DEFAULT_CHAT_SKILL_IDS] },
    },
    [CanvasNodeType.Annotate]: {
        width: 420, height: 320, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Annotate].title; },
        metadata: { content: "", status: "idle", annotations: [] },
    },
    [CanvasNodeType.Merge]: {
        width: 480, height: 420, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Merge].title; },
        metadata: { status: "idle", mergeOrientation: "grid", mergeRows: 2, mergeColumns: 2, mergeAspectRatio: null, mergeSlotIds: [null, null, null, null], mergeOffsets: {} },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

// Return built-in specs directly and resolve plugin types from the registry.
export function getNodeSpec(type: string) {
    if ((Object.values(CanvasNodeType) as string[]).includes(type)) return NODE_SPECS[type as CanvasNodeType];
    const spec = getRegistryNodeSpec(type);
    return { width: spec.width, height: spec.height, title: spec.title, metadata: spec.metadata };
}
