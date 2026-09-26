import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { ArrowUp, GripVertical, LoaderCircle, Maximize2, Square, WandSparkles } from "lucide-react";
import { App, Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { resolveH3PromptOptimizerEntry } from "@/constant/text-prompt-library";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { useCanvasTextEditDialog } from "./use-canvas-text-edit-dialog";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onContentChange?: (nodeId: string, content: string) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onReorderReferences?: (orderedNodeIds: string[]) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onContentChange, onGenerate, onStop, mentionReferences = [], onReorderReferences, onImageSettingsOpenChange, modeOverride }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const textPrompts = useConfigStore((state) => state.config.textPrompts || []);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [localRunning, setLocalRunning] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const optimizeControllerRef = useRef<AbortController | null>(null);
    const running = isRunning || localRunning;
    const promptPlaceholder = t(`canvas.promptPanel.${mode === "text" && hasTextContent ? "editText" : mode}`);

    // Restore prompts when switching nodes, or when chat skills / external writers bump promptSyncAt.
    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        setLocalRunning(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id, node.metadata?.promptSyncAt]);

    // Leaving the node (or unmounting) cancels an in-flight prompt optimization so its
    // async continuation can never write stale text into another node's composer.
    useEffect(() => {
        optimizeControllerRef.current?.abort();
        setOptimizing(false);
    }, [node.id]);
    useEffect(() => () => optimizeControllerRef.current?.abort(), []);

    // Hand off to parent-controlled running, or drop optimistic state if generation never started.
    useEffect(() => {
        if (isRunning) {
            setLocalRunning(false);
            return;
        }
        if (!localRunning) return;
        const timer = window.setTimeout(() => setLocalRunning(false), 120);
        return () => window.clearTimeout(timer);
    }, [isRunning, localRunning]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const textEdit = useCanvasTextEditDialog({
        value: prompt,
        onChange: updatePrompt,
        title: t("canvas.promptPanel.editorTitle"),
        placeholder: promptPlaceholder,
    });

    const activeReferences = mentionReferences.filter((reference) => reference.active && reference.nodeId !== node.id);

    // HTML5 drag reordering of the reference chips, matching the channel-editor interaction:
    // only the grip handle is draggable, so dragging can never trigger the browser's native
    // image drag ("plus" cursor + zoomed snapshot). Dropping on another chip reorders the
    // upstream connections, which renumbers 图片1/图片2 labels and the API reference order.
    const [dragChipIndex, setDragChipIndex] = useState<number | null>(null);
    const [dropChipIndex, setDropChipIndex] = useState<number | null>(null);
    const dragChipIndexRef = useRef<number | null>(null);

    const handleChipDragStart = (event: ReactDragEvent, index: number) => {
        event.dataTransfer.effectAllowed = "move";
        // Use a private MIME type (NOT text/plain) so the canvas's drop handler never mistakes
        // this reorder drag for an external text drop (which would create a text node + dialog).
        event.dataTransfer.setData("application/x-canvas-reference-reorder", String(index));
        dragChipIndexRef.current = index;
        setDragChipIndex(index);
        setDropChipIndex(null);
    };

    const handleChipDragOver = (event: ReactDragEvent, index: number) => {
        if (dragChipIndexRef.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (dropChipIndex !== index) setDropChipIndex(index);
    };

    const handleChipDrop = (event: ReactDragEvent, targetIndex: number) => {
        event.preventDefault();
        event.stopPropagation();
        const rawFrom = dragChipIndexRef.current ?? Number(event.dataTransfer.getData("application/x-canvas-reference-reorder"));
        dragChipIndexRef.current = null;
        setDragChipIndex(null);
        setDropChipIndex(null);
        if (!onReorderReferences || !Number.isFinite(rawFrom) || rawFrom < 0 || rawFrom >= activeReferences.length || rawFrom === targetIndex) return;
        const next = [...activeReferences];
        const [moved] = next.splice(rawFrom, 1);
        next.splice(targetIndex, 0, moved);
        onReorderReferences(next.map((reference) => reference.nodeId));
    };

    const handleChipDragEnd = () => {
        dragChipIndexRef.current = null;
        setDragChipIndex(null);
        setDropChipIndex(null);
    };

    const connectedTextPrompt = activeReferences
        .filter((reference) => reference.kind === "text" && reference.text?.trim())
        .map((reference) => reference.text!.trim())
        .join("\n\n");
    const canSubmit = Boolean(prompt.trim() || connectedTextPrompt);

    const submit = () => {
        // Pass only the user-typed prompt. Connected text is merged once in buildNodeGenerationContext.
        // Passing connectedTextPrompt here used to duplicate it: once as `prompt`, again as upstreamText.
        const userPrompt = prompt.trim();
        if ((!userPrompt && !connectedTextPrompt) || running) return;
        setLocalRunning(true);
        onGenerate(node.id, mode, userPrompt);
    };

    const handleStop = () => {
        setLocalRunning(false);
        onStop(node.id);
    };

    // Optimize the lower prompt input with the H3 prompt-optimizer instruction from the 词库,
    // and stream the optimized text into the upper content editor (the text node body).
    // Click the button again to cancel.
    const optimizePrompt = async () => {
        if (optimizeControllerRef.current) {
            optimizeControllerRef.current.abort();
            return;
        }
        const original = prompt;
        if (!original.trim()) {
            message.warning(t("canvas.promptPanel.optimizeEmpty"));
            return;
        }
        const controller = new AbortController();
        optimizeControllerRef.current = controller;
        setOptimizing(true);
        let streamed = "";
        const writeContent = (text: string) => {
            if (controller.signal.aborted) return;
            onContentChange?.(node.id, text);
        };
        try {
            const answer = await requestImageQuestion(
                config,
                [
                    { role: "system", content: resolveH3PromptOptimizerEntry(textPrompts).content },
                    { role: "user", content: original },
                ] satisfies AiTextMessage[],
                (text) => {
                    if (controller.signal.aborted) return;
                    streamed = text;
                    writeContent(text);
                },
                { signal: controller.signal },
            );
            if (controller.signal.aborted) return;
            writeContent((answer || streamed).trim() || original);
        } catch (error) {
            if (controller.signal.aborted) {
                writeContent(original);
                return;
            }
            message.error(`${t("canvas.promptPanel.optimizeFailed")}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (optimizeControllerRef.current === controller) optimizeControllerRef.current = null;
            setOptimizing(false);
        }
    };

    return (
        <div
            data-canvas-no-zoom
            className="min-w-0 overflow-hidden rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, width: 600, maxWidth: 600 }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {activeReferences.length ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] opacity-55">{t("canvas.promptPanel.references")}</span>
                    {activeReferences.map((reference, index) => {
                        const isDropTarget = dropChipIndex === index && dragChipIndex !== null && dragChipIndex !== index;
                        return (
                            <span
                                key={reference.id}
                                data-ref-chip={index}
                                className={`inline-flex max-w-44 items-center gap-1 rounded-lg border px-1.5 py-1 text-xs ${isDropTarget ? "ring-2 ring-sky-500" : ""}`}
                                style={{ background: theme.toolbar.itemHover, borderColor: isDropTarget ? "#0ea5e9" : theme.node.stroke, color: theme.node.text }}
                                title={reference.title}
                                onDragOver={onReorderReferences ? (event) => handleChipDragOver(event, index) : undefined}
                                onDrop={onReorderReferences ? (event) => handleChipDrop(event, index) : undefined}
                            >
                                <span
                                    data-ref-chip-handle={index}
                                    draggable={Boolean(onReorderReferences)}
                                    onDragStart={onReorderReferences ? (event) => handleChipDragStart(event, index) : undefined}
                                    onDragEnd={onReorderReferences ? handleChipDragEnd : undefined}
                                    className="cursor-grab touch-none opacity-45 active:cursor-grabbing"
                                    title={t("canvas.promptPanel.reorderHint")}
                                    aria-label={t("canvas.promptPanel.reorderHint")}
                                >
                                    <GripVertical className="size-3" />
                                </span>
                                {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt="" draggable={false} className="size-6 rounded object-cover" /> : null}
                                <span className="truncate font-medium">{reference.label}</span>
                            </span>
                        );
                    })}
                    <span className="text-[11px] opacity-45">{t("canvas.promptPanel.mentionHint")}</span>
                </div>
            ) : null}
            <CanvasPromptChipInput
                value={prompt}
                references={activeReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                onDoubleClick={textEdit.handleDoubleClick}
                className="thin-scrollbar h-40 min-w-0 w-full max-w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={promptPlaceholder}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={textEdit.openEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[200px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[150px] !shrink-0 !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[160px]" />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !max-w-[150px] !shrink-0 !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[160px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[180px] !shrink-0 !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[160px]" />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                            <Tooltip title={t("canvas.promptPanel.optimizePromptTitle")}>
                                <Button
                                    size="small"
                                    type="text"
                                    className="!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"
                                    style={{ background: theme.node.fill, color: theme.node.text }}
                                    icon={optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
                                    onClick={optimizePrompt}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    aria-label={t("canvas.promptPanel.optimizePromptTitle")}
                                >
                                    <span className="truncate">{optimizing ? t("canvas.promptPanel.optimizing") : t("canvas.promptPanel.optimizePrompt")}</span>
                                </Button>
                            </Tooltip>
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={running}
                    disabled={!running && !canSubmit}
                    onClick={() => (running ? handleStop() : submit())}
                    aria-label={t(running ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {running ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            {textEdit.dialog}
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoSteps: node.metadata?.steps || globalConfig.videoSteps || defaultConfig.videoSteps,
        videoRefImageSize: node.metadata?.refImageSize || globalConfig.videoRefImageSize || defaultConfig.videoRefImageSize,
        videoSamplerName: node.metadata?.samplerName || globalConfig.videoSamplerName || defaultConfig.videoSamplerName,
        videoScheduler: node.metadata?.scheduler || globalConfig.videoScheduler || defaultConfig.videoScheduler,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        sunoVersion: node.metadata?.sunoVersion || globalConfig.sunoVersion || defaultConfig.sunoVersion,
        sunoCustom: node.metadata?.sunoCustom || globalConfig.sunoCustom || defaultConfig.sunoCustom,
        sunoInstrumental: node.metadata?.sunoInstrumental || globalConfig.sunoInstrumental || defaultConfig.sunoInstrumental,
        sunoTitle: node.metadata?.sunoTitle || globalConfig.sunoTitle || defaultConfig.sunoTitle,
        sunoStyle: node.metadata?.sunoStyle || globalConfig.sunoStyle || defaultConfig.sunoStyle,
        sunoVocalGender: node.metadata?.sunoVocalGender || globalConfig.sunoVocalGender || defaultConfig.sunoVocalGender,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
        mjVersion: node.metadata?.mjVersion || globalConfig.mjVersion || defaultConfig.mjVersion,
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoSteps") return { steps: value };
    if (key === "videoRefImageSize") return { refImageSize: value };
    if (key === "videoSamplerName") return { samplerName: value };
    if (key === "videoScheduler") return { scheduler: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    return { [key]: value };
}
