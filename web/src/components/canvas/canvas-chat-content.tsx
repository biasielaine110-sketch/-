import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Image as ImageIcon, LoaderCircle, MessageSquareText, SendHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CanvasPromptChipInput } from "@/components/canvas/canvas-prompt-chip-input";
import { CanvasTextEditDialog } from "@/components/canvas/canvas-text-edit-dialog";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveChatSendOptions, type ChatSendOptions } from "@/lib/canvas/canvas-chat-helpers";
import { defaultConfig, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import type { CanvasAssistantImage, CanvasAssistantMessage, CanvasNodeData } from "@/types/canvas";

type CanvasChatContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    connectedTexts?: string[];
    mentionReferences?: CanvasResourceReference[];
    onSend: (nodeId: string, text: string, options: ChatSendOptions) => void;
    onModelChange: (nodeId: string, model: string) => void;
    onImageModelChange?: (nodeId: string, model: string) => void;
    onModesChange?: (nodeId: string, options: ChatSendOptions) => void;
    onInsertImage?: (image: CanvasAssistantImage) => void;
};

export function CanvasChatContent({
    node,
    theme,
    connectedTexts = [],
    mentionReferences = [],
    onSend,
    onModelChange,
    onImageModelChange,
    onModesChange,
    onInsertImage,
}: CanvasChatContentProps) {
    const { t } = useTranslation();
    const globalConfig = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [draft, setDraft] = useState("");
    const [draftEditorOpen, setDraftEditorOpen] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const syncedConnectedRef = useRef("");
    const messages = (node.metadata?.messages || []) as CanvasAssistantMessage[];
    const loading = node.metadata?.status === "loading";
    const sendOptions = resolveChatSendOptions(node.metadata);
    const textEnabled = sendOptions.text;
    const imageEnabled = sendOptions.image;
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
    const textModel = resolveModelForCapability(globalConfig, node.metadata?.model, "text");
    const imageModel = resolveModelForCapability(globalConfig, node.metadata?.imageModel, "image");
    const canSend = Boolean(draft.trim() || contextText) && !loading && (textEnabled || imageEnabled);
    const activeReferences = mentionReferences.filter((reference) => reference.active);

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

    const submit = () => {
        const text = draft.trim() || contextText;
        if (!text || loading || (!textEnabled && !imageEnabled)) return;
        if (draft.trim()) setDraft("");
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
                className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2 pt-1"
                onWheel={(event) => event.stopPropagation()}
                onMouseDown={stopIfInteractive}
                onPointerDown={stopIfInteractive}
            >
                {contextText ? (
                    <div
                        data-canvas-selectable-text
                        className="cursor-text select-text rounded-xl border px-3 py-2 text-[11px] leading-relaxed opacity-80"
                        style={{ background: theme.node.panel, borderColor: theme.node.stroke }}
                    >
                        <div className="mb-1 text-[10px] font-semibold uppercase opacity-50">{t("canvas.chat.linkedInputLabel")}</div>
                        <div className="line-clamp-4 whitespace-pre-wrap break-words">{contextText}</div>
                    </div>
                ) : null}

                {messages.length === 0 ? (
                    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-xs opacity-55">
                        <MessageSquareText className="size-6 opacity-40" />
                        <span>{contextText ? t("canvas.chat.emptyWithLinked") : t("canvas.chat.empty")}</span>
                    </div>
                ) : (
                    messages.map((message) => <ChatBubble key={message.id} message={message} theme={theme} onInsertImage={onInsertImage} />)
                )}
            </div>

            <div className="shrink-0 cursor-auto border-t p-2" style={{ borderColor: theme.node.stroke }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                {activeReferences.length ? (
                    <div className="mb-1.5 flex flex-wrap items-center gap-1">
                        <span className="text-[10px] opacity-50">{t("canvas.chat.mentionHint")}</span>
                        {activeReferences.slice(0, 6).map((reference) => (
                            <span key={reference.id} className="inline-flex max-w-28 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]" style={{ borderColor: theme.node.stroke, background: theme.node.panel }} title={reference.title}>
                                {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt="" className="size-4 rounded object-cover" /> : null}
                                <span className="truncate">{reference.label}</span>
                            </span>
                        ))}
                    </div>
                ) : null}

                <div className="mb-1.5 flex items-center gap-1">
                    <ModeToggle active={textEnabled} label={t("canvas.chat.modeText")} icon={<MessageSquareText className="size-3.5" />} theme={theme} onClick={toggleText} />
                    <ModeToggle active={imageEnabled} label={t("canvas.chat.modeImage")} icon={<ImageIcon className="size-3.5" />} theme={theme} onClick={toggleImage} />
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
                            className="thin-scrollbar max-h-24 min-h-[44px] w-full cursor-text overflow-y-auto px-1 py-1 text-xs leading-5 outline-none"
                            style={{ color: theme.node.text, background: "transparent" }}
                            placeholder={placeholder}
                        />
                    </div>
                    <button
                        type="button"
                        disabled={!canSend}
                        className="grid size-8 shrink-0 place-items-center rounded-full transition disabled:opacity-35"
                        style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                        onClick={submit}
                        aria-label={sendLabel}
                        title={sendLabel}
                    >
                        {loading ? <LoaderCircle className="size-4 animate-spin" /> : textEnabled && imageEnabled ? <SendHorizontal className="size-4" /> : imageEnabled ? <ImageIcon className="size-4" /> : <SendHorizontal className="size-4" />}
                    </button>
                </div>
            </div>

            <CanvasTextEditDialog
                open={draftEditorOpen}
                value={draft}
                title={t("canvas.chat.editMessageTitle")}
                placeholder={placeholder}
                onClose={() => setDraftEditorOpen(false)}
                onSave={setDraft}
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

function ChatBubble({ message, theme, onInsertImage }: { message: CanvasAssistantMessage; theme: CanvasTheme; onInsertImage?: (image: CanvasAssistantImage) => void }) {
    const { t } = useTranslation();
    const isUser = message.role === "user";
    const isError = message.role === "error";
    const images = message.images || [];
    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div
                data-canvas-selectable-text
                className="max-w-[92%] cursor-text select-text rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words"
                style={{
                    background: isError ? `${theme.node.activeStroke}22` : isUser ? theme.toolbar.activeBg : theme.node.panel,
                    color: isError ? theme.node.activeStroke : theme.node.text,
                    border: `1px solid ${isUser ? "transparent" : theme.node.stroke}`,
                }}
            >
                <div className="mb-1 text-[10px] font-semibold uppercase opacity-50">{isUser ? t("canvas.chat.you") : isError ? t("common.error") : t("canvas.chat.assistant")}</div>
                {message.text ? <div>{message.text}</div> : message.role === "assistant" && !images.length ? "…" : null}
                {images.length ? (
                    <div className={`mt-2 grid gap-2 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
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
            </div>
        </div>
    );
}
