import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { App } from "antd";
import copy from "copy-to-clipboard";
import { Check, Copy, Image as ImageIcon, MessageSquareText, Minus, Plus, SendHorizontal, Square, Trash2, Upload, Video, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CanvasPromptChipInput } from "@/components/canvas/canvas-prompt-chip-input";
import { CanvasTextEditDialog } from "@/components/canvas/canvas-text-edit-dialog";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveChatSendOptions, type ChatSendOptions } from "@/lib/canvas/canvas-chat-helpers";
import { getChatSkillDisplayDescription, getChatSkillDisplayName, listChatSkills, resolveChatSkillIds } from "@/lib/chat-skills";
import { DEFAULT_CANVAS_FONT_SIZE } from "@/constant/canvas";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { defaultConfig, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import type { CanvasAssistantImage, CanvasAssistantMessage, CanvasNodeData } from "@/types/canvas";

const MIN_CHAT_FONT_SIZE = 10;
const MAX_CHAT_FONT_SIZE = 48;
const CHAT_FONT_SIZE_STEP = 2;

type CanvasChatContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    connectedTexts?: string[];
    mentionReferences?: CanvasResourceReference[];
    onSend: (nodeId: string, text: string, options: ChatSendOptions) => void;
    onStop?: (nodeId: string) => void;
    onModelChange: (nodeId: string, model: string) => void;
    onImageModelChange?: (nodeId: string, model: string) => void;
    onModesChange?: (nodeId: string, options: ChatSendOptions) => void;
    onSkillsChange?: (nodeId: string, skillIds: string[]) => void;
    onDeleteMessage?: (nodeId: string, messageId: string) => void;
    onInsertImage?: (image: CanvasAssistantImage) => void;
    onFontSizeChange?: (nodeId: string, fontSize: number) => void;
};

export function CanvasChatContent({
    node,
    theme,
    connectedTexts = [],
    mentionReferences = [],
    onSend,
    onStop,
    onModelChange,
    onImageModelChange,
    onModesChange,
    onSkillsChange,
    onDeleteMessage,
    onInsertImage,
    onFontSizeChange,
}: CanvasChatContentProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const globalConfig = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const installedPacks = useChatSkillPacksStore((state) => state.packs);
    const installFromJson = useChatSkillPacksStore((state) => state.installFromJson);
    const uninstallPack = useChatSkillPacksStore((state) => state.uninstall);
    const skillPackInputRef = useRef<HTMLInputElement>(null);
    const [draft, setDraft] = useState("");
    const [draftEditorOpen, setDraftEditorOpen] = useState(false);
    const [previewMessageId, setPreviewMessageId] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const syncedConnectedRef = useRef("");
    const messages = (node.metadata?.messages || []) as CanvasAssistantMessage[];
    const loading = node.metadata?.status === "loading";
    const sendOptions = resolveChatSendOptions(node.metadata);
    const textEnabled = sendOptions.text;
    const imageEnabled = sendOptions.image;
    const enabledSkillIds = resolveChatSkillIds(node.metadata?.chatSkillIds);
    const skills = useMemo(() => listChatSkills(), [installedPacks]);
    const [skillsOpen, setSkillsOpen] = useState(false);
    const connectedText = useMemo(
        () =>
            connectedTexts
                .map((item) => item.trim())
                .filter(Boolean)
                .join("\n\n"),
        [connectedTexts],
    );
    const seededContent = (node.metadata?.content || "").trim();
    const contextText = connectedText || seededContent;
    const activeReferences = mentionReferences.filter((reference) => reference.active);
    const linkedMedia = useMemo(() => activeReferences.filter((reference) => reference.kind === "image" || reference.kind === "video"), [activeReferences]);
    const textModel = resolveModelForCapability(globalConfig, node.metadata?.model, "text");
    const imageModel = resolveModelForCapability(globalConfig, node.metadata?.imageModel, "image");
    const canSend = Boolean(draft.trim() || contextText || linkedMedia.length) && !loading && (textEnabled || imageEnabled);
    const fontSize = Math.max(MIN_CHAT_FONT_SIZE, Math.min(MAX_CHAT_FONT_SIZE, node.metadata?.fontSize || DEFAULT_CANVAS_FONT_SIZE));
    const bodyTextStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.55)}px` } as const;
    const metaTextStyle = { fontSize: `${Math.max(10, Math.round(fontSize * 0.75))}px` } as const;
    const previewMessage = previewMessageId ? messages.find((message) => message.id === previewMessageId) || null : null;
    const previewText = (previewMessage?.text || "").trim();
    const previewTitle = previewMessage
        ? previewMessage.role === "user"
            ? t("canvas.chat.viewUserMessageTitle")
            : previewMessage.role === "error"
              ? t("common.error")
              : t("canvas.chat.viewReplyTitle")
        : t("canvas.chat.viewMessageTitle");

    const adjustFontSize = (delta: number) => {
        const next = Math.max(MIN_CHAT_FONT_SIZE, Math.min(MAX_CHAT_FONT_SIZE, fontSize + delta));
        if (next === fontSize) return;
        onFontSizeChange?.(node.id, next);
    };

    const placeholder = useMemo(() => {
        if (textEnabled && imageEnabled) return t("canvas.chat.placeholderBoth");
        if (imageEnabled) return t("canvas.chat.placeholderImage");
        if (contextText) return t("canvas.chat.placeholderLinked");
        return t("canvas.chat.placeholder");
    }, [contextText, imageEnabled, t, textEnabled]);

    useEffect(() => {
        const previous = syncedConnectedRef.current;
        const currentDraft = draft.trim();
        if (!currentDraft || currentDraft === previous) {
            setDraft(connectedText);
        }
        syncedConnectedRef.current = connectedText;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectedText]);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        list.scrollTop = list.scrollHeight;
    }, [messages, loading, contextText]);

    // Canvas container preventDefaults wheel (for zoom). Stop it on the list target
    // so overflow scrolling works — same pattern as text-node textarea.
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const handleWheel = (event: WheelEvent) => {
            event.stopPropagation();
        };
        list.addEventListener("wheel", handleWheel, { passive: true });
        return () => list.removeEventListener("wheel", handleWheel);
    }, []);

    const submit = () => {
        const text = draft.trim() || contextText;
        if ((!text && !linkedMedia.length) || loading || (!textEnabled && !imageEnabled)) return;
        setDraft("");
        onSend(node.id, text, sendOptions);
    };

    const toggleText = () => {
        const next: ChatSendOptions = { text: !textEnabled, image: imageEnabled };
        if (!next.text && !next.image) next.image = true;
        onModesChange?.(node.id, next);
        if (next.text && !textEnabled) {
            const nextModel = resolveModelForCapability(globalConfig, undefined, "text");
            if (nextModel) onModelChange(node.id, nextModel);
        }
    };

    const toggleImage = () => {
        const next: ChatSendOptions = { text: textEnabled, image: !imageEnabled };
        if (!next.text && !next.image) next.text = true;
        onModesChange?.(node.id, next);
        if (next.image && !imageEnabled) {
            const nextModel = resolveModelForCapability(globalConfig, undefined, "image");
            if (nextModel) onImageModelChange?.(node.id, nextModel);
        }
    };

    const toggleSkill = (skillId: string) => {
        const selected = new Set(enabledSkillIds);
        if (selected.has(skillId)) selected.delete(skillId);
        else selected.add(skillId);
        onSkillsChange?.(node.id, Array.from(selected));
    };

    const importSkillPack = async (file: File | null) => {
        if (!file) return;
        try {
            const raw = await file.text();
            const pack = installFromJson(raw);
            if (!enabledSkillIds.includes(pack.id)) {
                onSkillsChange?.(node.id, [...enabledSkillIds, pack.id]);
            }
            message.success(t("canvas.chat.skillsPackInstalled", { name: pack.name }));
        } catch (error) {
            message.error(t("canvas.chat.skillsPackInstallFailed", { error: error instanceof Error ? error.message : String(error) }));
        } finally {
            if (skillPackInputRef.current) skillPackInputRef.current.value = "";
        }
    };

    const removeSkillPack = (skillId: string) => {
        uninstallPack(skillId);
        onSkillsChange?.(
            node.id,
            enabledSkillIds.filter((id) => id !== skillId),
        );
        message.success(t("canvas.chat.skillsPackRemoved"));
    };

    const stopIfInteractive = (event: ReactMouseEvent | ReactPointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("[data-canvas-selectable-text],[data-canvas-text-input],textarea,button,input,[contenteditable='true'],.ant-select")) {
            event.stopPropagation();
        }
    };

    const sendLabel = textEnabled && imageEnabled ? t("canvas.chat.sendBoth") : imageEnabled ? t("canvas.chat.generateImage") : t("canvas.chat.send");

    const headerRows = (textEnabled ? 1 : 0) + (imageEnabled ? 1 : 0);

    return (
        <div className={`flex h-full w-full cursor-move flex-col overflow-hidden ${headerRows > 1 ? "pt-[4.75rem]" : "pt-10"}`} style={{ color: theme.node.text }}>
            <div className="absolute inset-x-2 top-2 z-20 flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium opacity-80" style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke }}>
                        <MessageSquareText className="size-3.5" />
                        {t("canvas.chat.title")}
                    </div>
                    {textEnabled ? (
                        <div className="min-w-0 flex-1 cursor-auto" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                            <ModelPicker
                                config={{ ...globalConfig, model: textModel, reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort }}
                                value={textModel}
                                onChange={(model) => onModelChange(node.id, model)}
                                capability="text"
                                onMissingConfig={() => openConfigDialog(true)}
                                className="max-w-full"
                                fullWidth
                                placeholder={t("canvas.chat.selectTextModel")}
                            />
                        </div>
                    ) : null}
                </div>
                {imageEnabled ? (
                    <div className="cursor-auto" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                        <ModelPicker
                            config={{ ...globalConfig, model: imageModel }}
                            value={imageModel}
                            onChange={(model) => onImageModelChange?.(node.id, model)}
                            capability="image"
                            onMissingConfig={() => openConfigDialog(true)}
                            className="max-w-full"
                            fullWidth
                            placeholder={t("canvas.chat.selectImageModel")}
                        />
                    </div>
                ) : null}
            </div>

            <div
                ref={listRef}
                data-canvas-no-zoom
                className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 pb-2 pt-1"
                onWheel={(event) => event.stopPropagation()}
                onMouseDown={stopIfInteractive}
                onPointerDown={stopIfInteractive}
            >
                {contextText || linkedMedia.length ? (
                    <div className="space-y-2 rounded-xl border px-3 py-2 leading-relaxed opacity-80" style={{ ...bodyTextStyle, background: theme.node.panel, borderColor: theme.node.stroke }}>
                        {contextText ? (
                            <div data-canvas-selectable-text className="cursor-text select-text">
                                <div className="mb-1 font-semibold uppercase opacity-50" style={metaTextStyle}>{t("canvas.chat.linkedInputLabel")}</div>
                                <div className="line-clamp-4 whitespace-pre-wrap break-words">{contextText}</div>
                            </div>
                        ) : null}
                        {linkedMedia.length ? (
                            <div>
                                <div className="mb-1.5 text-[10px] font-semibold uppercase opacity-50">{t("canvas.chat.linkedMediaLabel")}</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {linkedMedia.map((reference) => (
                                        <div key={reference.id} className="relative h-14 w-14 overflow-hidden rounded-lg border" style={{ borderColor: theme.node.stroke }} title={reference.title}>
                                            {reference.kind === "image" && reference.previewUrl ? (
                                                <img src={reference.previewUrl} alt={reference.title} className="h-full w-full object-cover" />
                                            ) : reference.kind === "video" && reference.previewUrl ? (
                                                <video src={reference.previewUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center opacity-50">{reference.kind === "video" ? <Video className="size-4" /> : <ImageIcon className="size-4" />}</div>
                                            )}
                                            {reference.kind === "video" ? (
                                                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 text-[9px] text-white">
                                                    <Video className="inline size-2.5" />
                                                </span>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {messages.length === 0 ? (
                    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-4 text-center opacity-55" style={bodyTextStyle}>
                        <MessageSquareText className="size-6 opacity-40" />
                        <span>{contextText || linkedMedia.length ? t("canvas.chat.emptyWithLinked") : t("canvas.chat.empty")}</span>
                    </div>
                ) : (
                    messages.map((message) => (
                        <ChatBubble
                            key={message.id}
                            message={message}
                            theme={theme}
                            fontSize={fontSize}
                            onInsertImage={onInsertImage}
                            onMaximize={() => setPreviewMessageId(message.id)}
                            onDelete={() => {
                                if (previewMessageId === message.id) setPreviewMessageId(null);
                                onDeleteMessage?.(node.id, message.id);
                            }}
                        />
                    ))
                )}
            </div>

            <div className="shrink-0 cursor-auto border-t p-2" style={{ borderColor: theme.node.stroke }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                {activeReferences.length ? (
                    <div className="mb-1.5 flex flex-wrap items-center gap-1">
                        <span className="text-[10px] opacity-50">{t("canvas.chat.mentionHint")}</span>
                        {activeReferences.slice(0, 6).map((reference) => (
                            <span key={reference.id} className="inline-flex max-w-28 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]" style={{ borderColor: theme.node.stroke, background: theme.node.panel }} title={reference.title}>
                                {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt="" className="size-4 rounded object-cover" /> : null}
                                {reference.kind === "video" ? <Video className="size-3.5 opacity-70" /> : null}
                                <span className="truncate">{reference.label}</span>
                            </span>
                        ))}
                    </div>
                ) : null}

                <div className="mb-1.5 flex flex-wrap items-center gap-1">
                    <ModeToggle active={textEnabled} label={t("canvas.chat.modeText")} icon={<MessageSquareText className="size-3.5" />} theme={theme} onClick={toggleText} />
                    <ModeToggle active={imageEnabled} label={t("canvas.chat.modeImage")} icon={<ImageIcon className="size-3.5" />} theme={theme} onClick={toggleImage} />
                    {textEnabled ? (
                        <div className="relative">
                            <ModeToggle
                                active={enabledSkillIds.length > 0 || skillsOpen}
                                label={enabledSkillIds.length ? `${t("canvas.chat.skills")} ${enabledSkillIds.length}` : t("canvas.chat.skills")}
                                icon={<Wrench className="size-3.5" />}
                                theme={theme}
                                onClick={() => setSkillsOpen((open) => !open)}
                            />
                            {skillsOpen ? (
                                <div
                                    className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-xl border p-2 shadow-lg"
                                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                >
                                    <div className="mb-1.5 flex items-center justify-between gap-2">
                                        <div className="text-[10px] font-semibold uppercase opacity-55">{t("canvas.chat.skillsTitle")}</div>
                                        <button
                                            type="button"
                                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] opacity-80 transition hover:opacity-100"
                                            style={{ borderColor: theme.node.stroke }}
                                            onClick={() => skillPackInputRef.current?.click()}
                                            title={t("canvas.chat.skillsImportHint")}
                                        >
                                            <Upload className="size-3" />
                                            {t("canvas.chat.skillsImport")}
                                        </button>
                                        <input
                                            ref={skillPackInputRef}
                                            type="file"
                                            accept="application/json,.json,.skill.json"
                                            className="hidden"
                                            onChange={(event) => void importSkillPack(event.target.files?.[0] || null)}
                                        />
                                    </div>
                                    <div className="mb-1.5 text-[10px] leading-snug opacity-50">{t("canvas.chat.skillsImportHint")}</div>
                                    <div className="max-h-64 space-y-1 overflow-y-auto">
                                        {skills.map((skill) => {
                                            const active = enabledSkillIds.includes(skill.id);
                                            const skillName = getChatSkillDisplayName(skill);
                                            const skillDesc = getChatSkillDisplayDescription(skill);
                                            return (
                                                <div
                                                    key={skill.id}
                                                    className="flex w-full items-start gap-2 rounded-lg border px-2 py-1.5"
                                                    style={{
                                                        borderColor: active ? theme.toolbar.activeBg : theme.node.stroke,
                                                        background: active ? `${theme.toolbar.activeBg}22` : "transparent",
                                                    }}
                                                >
                                                    <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => toggleSkill(skill.id)} title={skillDesc}>
                                                        <span
                                                            className="mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px]"
                                                            style={{ borderColor: active ? theme.toolbar.activeBg : theme.node.stroke, background: active ? theme.toolbar.activeBg : "transparent", color: active ? "#fff" : theme.node.text }}
                                                        >
                                                            {active ? <Check className="size-2.5" /> : null}
                                                        </span>
                                                        <span className="min-w-0">
                                                            <span className="block text-[11px] font-medium">
                                                                {skillName}
                                                                {skill.source === "local" ? <span className="ml-1 text-[9px] font-normal opacity-50">{t("canvas.chat.skillsLocalBadge")}</span> : null}
                                                            </span>
                                                            <span className="block text-[10px] opacity-60">{skillDesc}</span>
                                                        </span>
                                                    </button>
                                                    {skill.removable ? (
                                                        <button
                                                            type="button"
                                                            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md opacity-55 transition hover:opacity-100"
                                                            style={{ color: theme.node.text }}
                                                            title={t("canvas.chat.skillsUninstall")}
                                                            aria-label={t("canvas.chat.skillsUninstall")}
                                                            onClick={() => removeSkillPack(skill.id)}
                                                        >
                                                            <Trash2 className="size-3" />
                                                        </button>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                    {onFontSizeChange ? (
                        <div className="ml-auto inline-flex items-center gap-0.5 rounded-full border px-1 py-0.5" style={{ borderColor: theme.node.stroke, background: `${theme.toolbar.panel}aa` }}>
                            <button
                                type="button"
                                className="grid size-6 place-items-center rounded-full opacity-80 transition hover:opacity-100 disabled:opacity-35"
                                style={{ color: theme.node.text }}
                                disabled={fontSize <= MIN_CHAT_FONT_SIZE}
                                title={t("canvas.nodeToolbar.decreaseFont")}
                                aria-label={t("canvas.nodeToolbar.decreaseFont")}
                                onClick={() => adjustFontSize(-CHAT_FONT_SIZE_STEP)}
                            >
                                <Minus className="size-3" />
                            </button>
                            <span className="min-w-7 text-center text-[10px] font-medium tabular-nums opacity-70" style={{ color: theme.node.text }}>
                                {fontSize}
                            </span>
                            <button
                                type="button"
                                className="grid size-6 place-items-center rounded-full opacity-80 transition hover:opacity-100 disabled:opacity-35"
                                style={{ color: theme.node.text }}
                                disabled={fontSize >= MAX_CHAT_FONT_SIZE}
                                title={t("canvas.nodeToolbar.increaseFont")}
                                aria-label={t("canvas.nodeToolbar.increaseFont")}
                                onClick={() => adjustFontSize(CHAT_FONT_SIZE_STEP)}
                            >
                                <Plus className="size-3" />
                            </button>
                        </div>
                    ) : null}
                </div>

                <div className="flex items-end gap-2 rounded-2xl border px-2 py-1.5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                    <div
                        className="min-w-0 flex-1"
                        onDoubleClick={(event) => {
                            event.stopPropagation();
                            setDraftEditorOpen(true);
                        }}
                    >
                        <CanvasPromptChipInput
                            value={draft}
                            references={mentionReferences}
                            onChange={setDraft}
                            onSubmit={submit}
                            className="thin-scrollbar max-h-[288px] min-h-[132px] w-full cursor-text overflow-y-auto px-1 py-1 outline-none"
                            style={{ ...bodyTextStyle, color: theme.node.text, background: "transparent" }}
                            placeholder={placeholder}
                        />
                    </div>
                    <button
                        type="button"
                        disabled={loading ? !onStop : !canSend}
                        className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 transition disabled:opacity-35"
                        style={{ background: loading ? "#dc2626" : theme.toolbar.activeBg, color: "#fff", minWidth: loading ? 64 : 32 }}
                        onClick={() => (loading ? onStop?.(node.id) : submit())}
                        aria-label={loading ? t("canvas.chat.stop") : sendLabel}
                        title={loading ? t("canvas.chat.stop") : sendLabel}
                    >
                        {loading ? (
                            <>
                                <Square className="size-3 fill-current" />
                                <span className="text-[11px] font-medium">{t("canvas.chat.stop")}</span>
                            </>
                        ) : textEnabled && imageEnabled ? (
                            <SendHorizontal className="size-4" />
                        ) : imageEnabled ? (
                            <ImageIcon className="size-4" />
                        ) : (
                            <SendHorizontal className="size-4" />
                        )}
                    </button>
                </div>
            </div>

            <CanvasTextEditDialog
                open={draftEditorOpen}
                value={draft}
                title={t("canvas.chat.editMessageTitle")}
                placeholder={placeholder}
                fontSize={fontSize}
                onFontSizeChange={(next) => onFontSizeChange?.(node.id, next)}
                onClose={() => setDraftEditorOpen(false)}
                onSave={setDraft}
            />

            <CanvasTextEditDialog
                open={Boolean(previewMessage && previewText)}
                value={previewMessage?.text || ""}
                title={previewTitle}
                fontSize={Math.max(fontSize, 16)}
                readOnly
                onClose={() => setPreviewMessageId(null)}
            />
        </div>
    );
}

function ModeToggle({ active, label, icon, theme, onClick }: { active: boolean; label: string; icon: ReactNode; theme: CanvasTheme; onClick: () => void }) {
    return (
        <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition"
            style={{
                background: active ? theme.toolbar.activeBg : `${theme.toolbar.panel}aa`,
                color: active ? theme.toolbar.activeText : theme.node.text,
                borderColor: active ? "transparent" : theme.node.stroke,
                opacity: active ? 1 : 0.75,
            }}
            onClick={onClick}
        >
            {icon}
            {label}
        </button>
    );
}

function ChatBubble({
    message,
    theme,
    fontSize,
    onInsertImage,
    onMaximize,
    onDelete,
}: {
    message: CanvasAssistantMessage;
    theme: CanvasTheme;
    fontSize: number;
    onInsertImage?: (image: CanvasAssistantImage) => void;
    onMaximize: () => void;
    onDelete?: () => void;
}) {
    const { t } = useTranslation();
    const { message: toast } = App.useApp();
    const [copied, setCopied] = useState(false);
    const isUser = message.role === "user";
    const isError = message.role === "error";
    const images = message.images || [];
    const text = (message.text || "").trim();
    const bodyStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.55)}px` };
    const metaStyle = { fontSize: `${Math.max(10, Math.round(fontSize * 0.75))}px` };
    const canDelete = Boolean(onDelete);

    const handleCopy = (event: ReactMouseEvent | ReactPointerEvent) => {
        event.stopPropagation();
        event.preventDefault();
        if (!text) return;
        copy(text);
        setCopied(true);
        toast.success(t("common.copied"));
        window.setTimeout(() => setCopied(false), 1500);
    };

    const handleDelete = (event: ReactMouseEvent | ReactPointerEvent) => {
        event.stopPropagation();
        event.preventDefault();
        onDelete?.();
    };

    const openPreview = (event: ReactMouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        if (!text) return;
        onMaximize();
    };

    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div
                data-canvas-selectable-text
                className="relative max-w-[92%] cursor-text select-text rounded-2xl px-3 py-2 leading-relaxed whitespace-pre-wrap break-words"
                style={{
                    ...bodyStyle,
                    background: isError ? `${theme.node.activeStroke}22` : isUser ? theme.toolbar.activeBg : theme.node.panel,
                    color: isError ? theme.node.activeStroke : theme.node.text,
                    border: `1px solid ${isUser ? "transparent" : theme.node.stroke}`,
                }}
                title={text ? t("canvas.chat.doubleClickMaximize") : undefined}
                onDoubleClick={openPreview}
            >
                <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="font-semibold uppercase opacity-50" style={metaStyle}>{isUser ? t("canvas.chat.you") : isError ? t("common.error") : t("canvas.chat.assistant")}</div>
                    {canDelete ? (
                        <button
                            type="button"
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-55 transition hover:opacity-100"
                            style={{ color: theme.node.text, background: `${theme.node.fill}99` }}
                            title={t("canvas.chat.deleteMessage")}
                            aria-label={t("canvas.chat.deleteMessage")}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleDelete}
                            onDoubleClick={(event) => event.stopPropagation()}
                        >
                            <Trash2 className="size-3" />
                        </button>
                    ) : null}
                </div>
                {text ? <div>{message.text}</div> : message.role === "assistant" && !images.length ? "…" : null}
                {images.length ? (
                    <div
                        className={`mt-2 grid gap-2 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
                        onDoubleClick={(event) => event.stopPropagation()}
                    >
                        {images.map((image) => (
                            <div key={image.id} className="overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }}>
                                <img src={image.dataUrl} alt={image.prompt || t("canvas.chat.generatedImage")} className="block max-h-56 w-full object-contain" draggable={false} />
                                {onInsertImage ? (
                                    <button
                                        type="button"
                                        className="flex w-full items-center justify-center gap-1 border-t px-2 py-1.5 text-[10px] font-medium opacity-80 transition hover:opacity-100"
                                        style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onInsertImage(image);
                                        }}
                                    >
                                        <ImageIcon className="size-3" />
                                        {t("canvas.chat.insertToCanvas")}
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                {text ? (
                    <div className={`mt-2 flex ${isUser ? "justify-end" : "justify-start"} border-t pt-1.5`} style={{ borderColor: `${theme.node.stroke}66` }}>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium opacity-70 transition hover:opacity-100"
                            style={{ color: theme.node.text, background: `${theme.node.fill}99` }}
                            title={t("canvas.chat.copyReply")}
                            aria-label={t("canvas.chat.copyReply")}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleCopy}
                            onDoubleClick={(event) => event.stopPropagation()}
                        >
                            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                            {copied ? t("common.copied") : t("canvas.chat.copyReply")}
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
