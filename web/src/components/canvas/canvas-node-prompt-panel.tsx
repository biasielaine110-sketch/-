import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { ArrowUp, Clock, GripVertical, LoaderCircle, Maximize2, Square, WandSparkles, X } from "lucide-react";
import { App, Button, Tooltip } from "antd";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { defaultConfig, resolveModelForCapability, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { resolveH3PromptOptimizerEntry } from "@/constant/text-prompt-library";
import { resolveNativeH3VideoSettingDefaults } from "@/lib/comfyui-native";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatDuration } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasStylePicker } from "./canvas-style-picker";
import { CanvasCameraPicker } from "./canvas-camera-picker";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { useCanvasTextEditDialog } from "./use-canvas-text-edit-dialog";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasScheduleDialog } from "./canvas-schedule-dialog";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { moveIndex, resolveReorderTargetIndex } from "@/lib/canvas/canvas-reference-order";

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
    onRemoveReference?: (referenceNodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    /** 排期生成时间（epoch ms）。设置后到点由画布调度器自动触发一次生成。 */
    scheduledAt?: number;
    /** 设定/更新排期时间。 */
    onSchedule?: (at: number) => void;
    /** 取消当前排期。 */
    onCancelSchedule?: () => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onContentChange, onGenerate, onStop, mentionReferences = [], onReorderReferences, onRemoveReference, onImageSettingsOpenChange, scheduledAt, onSchedule, onCancelSchedule, modeOverride }: CanvasNodePromptPanelProps) {
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
    const [scheduleOpen, setScheduleOpen] = useState(false);
    const optimizeControllerRef = useRef<AbortController | null>(null);
    const running = isRunning || localRunning;
    const elapsed = useElapsedSeconds(running, node.id);
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

    // HTML5 drag reordering of the reference chips, matching the channel-editor interaction.
    // 整块 chip 都可拖（不再只留手柄）：用户会直接按住缩略图拖，只有手柄可拖时按住图片
    // 完全没反应 —— 就是「拖动卡住」的报障。图片自身 `draggable={false}`，所以不会触发
    // 浏览器原生图片拖拽（"plus" 光标 + 放大快照）。Drop 后重排上游连线顺序，
    // 从而重新编号 图片1/图片2 并改变 API 的 reference_images 顺序。
    //
    // 落点由**整排容器**统一判定，不绑在单个 chip 上：拖到两张 chip 之间的空隙、或者拖到行尾
    // 空白处松手，以前没有任何元素接 drop（事件冒到画布 → 什么都不发生），看起来就像「拖不动」。
    // 现在按光标位置算插入位（0 = 插到最前，n = 插到最后），并在缝隙里画一条竖线。
    const CHIP_REORDER_MIME = "application/x-canvas-reference-reorder";
    const [dragChipIndex, setDragChipIndex] = useState<number | null>(null);
    const [dropSlot, setDropSlot] = useState<number | null>(null);
    // dragover / drop 里读 ref：dragstart 与紧随其后的 dragover 可能在同一帧，state 未必已刷新。
    const dragChipRef = useRef<number | null>(null);
    const chipRowRef = useRef<HTMLDivElement | null>(null);

    /** 光标 → 插入位。换行布局下先比行（中线以上算「在这一行之前」），再比左右半边。 */
    const resolveDropSlot = (clientX: number, clientY: number) => {
        const row = chipRowRef.current;
        if (!row) return activeReferences.length;
        const chips = Array.from(row.querySelectorAll<HTMLElement>("[data-ref-chip]"));
        for (let index = 0; index < chips.length; index += 1) {
            const rect = chips[index].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return index;
            if (clientY <= rect.bottom && clientX < rect.left + rect.width / 2) return index;
        }
        return chips.length;
    };

    const handleChipDragStart = (event: ReactDragEvent, index: number) => {
        event.dataTransfer.effectAllowed = "move";
        // Use a private MIME type (NOT text/plain) so the canvas's drop handler never mistakes
        // this reorder drag for an external text drop (which would create a text node + dialog).
        event.dataTransfer.setData(CHIP_REORDER_MIME, String(index));
        dragChipRef.current = index;
        setDragChipIndex(index);
        setDropSlot(index);
    };

    const handleChipRowDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (dragChipRef.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const slot = resolveDropSlot(event.clientX, event.clientY);
        if (slot !== dropSlot) setDropSlot(slot);
    };

    const handleChipRowDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        const from = dragChipRef.current;
        if (from === null) return;
        event.preventDefault();
        event.stopPropagation();
        const slot = resolveDropSlot(event.clientX, event.clientY);
        dragChipRef.current = null;
        setDragChipIndex(null);
        setDropSlot(null);
        if (!onReorderReferences) return;
        const to = resolveReorderTargetIndex(from, slot, activeReferences.length);
        if (to < 0) return;
        onReorderReferences(moveIndex(activeReferences, from, to).map((reference) => reference.nodeId));
    };

    const handleChipDragEnd = () => {
        dragChipRef.current = null;
        setDragChipIndex(null);
        setDropSlot(null);
    };

    const connectedTextPrompt = activeReferences
        .filter((reference) => reference.kind === "text" && reference.text?.trim())
        .map((reference) => reference.text!.trim())
        .join("\n\n");
    const canSubmit = Boolean(prompt.trim() || connectedTextPrompt);

    // Native H3 video: allow another submit while one is running — canvas FIFO queues it.
    // Other modes still block until the current run finishes (button becomes Stop).
    const allowQueueWhileRunning = mode === "video";

    // 已有排期时，发送不再直接生成——避免「刚设好排期就被立刻跑掉」。要马上跑请用「立即生成」。
    const submit = () => {
        // Pass only the user-typed prompt. Connected text is merged once in buildNodeGenerationContext.
        // Passing connectedTextPrompt here used to duplicate it: once as `prompt`, again as upstreamText.
        const userPrompt = prompt.trim();
        if ((!userPrompt && !connectedTextPrompt) || (running && !allowQueueWhileRunning)) return;
        if (scheduledAt) {
            message.info(t("canvas.schedule.pendingHint", { time: dayjs(scheduledAt).format("MM-DD HH:mm") }));
            return;
        }
        setLocalRunning(true);
        onGenerate(node.id, mode, userPrompt);
    };

    // 显式「立即生成」：清掉当前排期后马上生成一次。
    const generateNow = () => {
        const userPrompt = prompt.trim();
        if ((!userPrompt && !connectedTextPrompt) || (running && !allowQueueWhileRunning)) return;
        if (scheduledAt) onCancelSchedule?.();
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
                <div
                    ref={chipRowRef}
                    className="mb-2 flex flex-wrap items-center gap-1.5"
                    onDragOver={onReorderReferences ? handleChipRowDragOver : undefined}
                    onDrop={onReorderReferences ? handleChipRowDrop : undefined}
                    onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                        setDropSlot(null);
                    }}
                >
                    <span className="text-[11px] opacity-55">{t("canvas.promptPanel.references")}</span>
                    {activeReferences.map((reference, index) => {
                        const isDragging = dragChipIndex === index;
                        return (
                            <Fragment key={reference.id}>
                                {dropSlot === index && dragChipIndex !== null ? (
                                    <span data-ref-drop-marker={index} className="h-6 w-0.5 shrink-0 rounded-full bg-sky-500" aria-hidden />
                                ) : null}
                                <span
                                    data-ref-chip={index}
                                    // 整块 chip 都能拖（不只是那个 3px 的小抓手）：用户会直接按住缩略图拖，
                                    // 以前只有抓手 draggable，按住图片拖完全没反应 —— 就是报障的「拖动卡住」。
                                    // 图片自身 draggable={false}，所以不会触发浏览器原生图片拖拽。
                                    draggable={Boolean(onReorderReferences)}
                                    onDragStart={onReorderReferences ? (event) => handleChipDragStart(event, index) : undefined}
                                    onDragEnd={onReorderReferences ? handleChipDragEnd : undefined}
                                    className={`relative mr-1 inline-flex max-w-44 items-center gap-1 rounded-lg border px-1.5 py-1 text-xs transition-opacity ${isDragging ? "opacity-40" : ""} ${onReorderReferences ? "cursor-grab active:cursor-grabbing" : ""}`}
                                    style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.text }}
                                    title={reference.title}
                                >
                                    <span
                                        data-ref-chip-handle={index}
                                        className="pointer-events-none opacity-45"
                                        title={t("canvas.promptPanel.reorderHint")}
                                        aria-label={t("canvas.promptPanel.reorderHint")}
                                    >
                                        <GripVertical className="size-3" />
                                    </span>
                                    {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt="" draggable={false} className="size-6 rounded object-cover" /> : null}
                                    <span className="truncate font-medium">{reference.label}</span>
                                    {onRemoveReference ? (
                                        <button
                                            type="button"
                                            data-canvas-shortcuts-ignore
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                onRemoveReference(reference.nodeId);
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                            className="absolute -right-1 -top-1 z-10 flex size-4 cursor-pointer items-center justify-center rounded-full border shadow-sm transition-transform hover:scale-110"
                                            style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                            title={t("canvas.promptPanel.removeReference")}
                                            aria-label={t("canvas.promptPanel.removeReference")}
                                        >
                                            <X className="size-2.5" />
                                        </button>
                                    ) : null}
                                </span>
                            </Fragment>
                        );
                    })}
                    {dropSlot === activeReferences.length && dragChipIndex !== null ? <span data-ref-drop-marker="end" className="h-6 w-0.5 shrink-0 rounded-full bg-sky-500" aria-hidden /> : null}
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
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : key === "videoSeconds" ? { seconds: value } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                            <CanvasStylePicker
                                value={node.metadata?.styleTemplateId}
                                onChange={(styleTemplateId) => onConfigChange(node.id, { styleTemplateId })}
                                buttonClassName="!h-10 !max-w-[140px] !shrink-0 !justify-start !rounded-full !px-3"
                                placement="topLeft"
                            />
                            <CanvasCameraPicker
                                value={node.metadata?.cameraSelection}
                                onChange={(cameraSelection) => onConfigChange(node.id, { cameraSelection })}
                                buttonClassName="!h-10 !max-w-[170px] !shrink-0 !justify-start !rounded-full !px-3"
                                placement="topLeft"
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
                <div className="flex shrink-0 items-center gap-1.5">
                    {scheduledAt ? (
                        <>
                            {/* 已排期：发送不再直接生成——「立即生成」才是马上跑，主按钮改为打开排期面板（改时间/取消）。 */}
                            <Button
                                type="text"
                                size="small"
                                className="!h-10 !rounded-full !px-2.5"
                                style={{ color: theme.node.text }}
                                disabled={running}
                                onClick={generateNow}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                                <span className="text-xs font-medium">{t("canvas.schedule.generateNow")}</span>
                            </Button>
                            <Tooltip title={t("canvas.schedule.current", { time: dayjs(scheduledAt).format("MM-DD HH:mm") })}>
                                <Button
                                    type="primary"
                                    className="!h-10 shrink-0 !rounded-full !px-3"
                                    danger={running}
                                    onClick={() => (running ? handleStop() : setScheduleOpen(true))}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    aria-label={t("canvas.promptPanel.schedule")}
                                >
                                    <span className="flex items-center gap-1.5">
                                        <Clock className="size-4" />
                                        <span className="text-xs font-medium">{dayjs(scheduledAt).format("MM-DD HH:mm")}</span>
                                    </span>
                                </Button>
                            </Tooltip>
                        </>
                    ) : (
                        <>
                            <Tooltip title={t("canvas.promptPanel.schedule")}>
                                <span className="shrink-0">
                                    <Button
                                        type="text"
                                        size="small"
                                        className="!h-10 !w-10 !min-w-10 !rounded-full !p-0"
                                        style={{ color: theme.node.text }}
                                        disabled={running}
                                        onClick={() => setScheduleOpen(true)}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        icon={<Clock className="size-4" />}
                                        aria-label={t("canvas.promptPanel.schedule")}
                                    />
                                </span>
                            </Tooltip>
                            {running && allowQueueWhileRunning ? (
                                <>
                                    <Button
                                        type="primary"
                                        className="!h-10 !min-w-12 shrink-0 !rounded-full !px-3"
                                        disabled={!canSubmit}
                                        onClick={submit}
                                        aria-label={t("canvas.promptPanel.generate")}
                                    >
                                        <ArrowUp className="size-4" />
                                    </Button>
                                    <Button
                                        type="primary"
                                        danger
                                        className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                                        onClick={handleStop}
                                        aria-label={t("canvas.promptPanel.stopGeneration")}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            <LoaderCircle className="size-4 animate-spin" />
                                            <Square className="size-3.5 fill-current" />
                                            <span className="text-xs font-medium">
                                                {t("canvas.promptPanel.stop")}
                                                <span className="ml-1 opacity-80">{formatDuration(elapsed * 1000)}</span>
                                            </span>
                                        </span>
                                    </Button>
                                </>
                            ) : (
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
                                                <span className="text-xs font-medium">
                                                    {t("canvas.promptPanel.stop")}
                                                    <span className="ml-1 opacity-80">{formatDuration(elapsed * 1000)}</span>
                                                </span>
                                            </>
                                        ) : (
                                            <ArrowUp className="size-4" />
                                        )}
                                    </span>
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </div>
            {onSchedule ? (
                <CanvasScheduleDialog
                    open={scheduleOpen}
                    scheduledAt={scheduledAt}
                    onClose={() => setScheduleOpen(false)}
                    onSchedule={onSchedule}
                    onCancelSchedule={() => onCancelSchedule?.()}
                />
            ) : null}
            {textEdit.dialog}
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const model = resolveModelForCapability(globalConfig, node.metadata?.model, mode);
    const nativeVideoDefaults =
        mode === "video" ? resolveNativeH3VideoSettingDefaults(model, resolveModelScript(globalConfig, model)) : {};
    return {
        ...globalConfig,
        model,
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        videoResolution: node.metadata?.videoResolution || globalConfig.videoResolution || "",
        vquality: node.metadata?.vquality || nativeVideoDefaults.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoCropSubtitles: node.metadata?.cropSubtitles || globalConfig.videoCropSubtitles || defaultConfig.videoCropSubtitles,
        videoSteps: node.metadata?.steps || globalConfig.videoSteps || defaultConfig.videoSteps,
        videoRefImageSize: node.metadata?.refImageSize || globalConfig.videoRefImageSize || defaultConfig.videoRefImageSize,
        videoSamplerName: node.metadata?.samplerName || globalConfig.videoSamplerName || defaultConfig.videoSamplerName,
        videoScheduler: node.metadata?.scheduler || globalConfig.videoScheduler || defaultConfig.videoScheduler,
        videoSeedMode: node.metadata?.seedMode || globalConfig.videoSeedMode || defaultConfig.videoSeedMode,
        videoSeed: node.metadata?.seed || globalConfig.videoSeed || defaultConfig.videoSeed,
        videoAudioMode:
            node.metadata?.audioMode ||
            nativeVideoDefaults.videoAudioMode ||
            globalConfig.videoAudioMode ||
            defaultConfig.videoAudioMode,
        videoFisherMode: node.metadata?.fisherMode || globalConfig.videoFisherMode || defaultConfig.videoFisherMode,
        videoFisherLoraStrength: node.metadata?.fisherLoraStrength || globalConfig.videoFisherLoraStrength || defaultConfig.videoFisherLoraStrength,
        videoFisherStyleFields: node.metadata?.fisherStyleFields || globalConfig.videoFisherStyleFields || defaultConfig.videoFisherStyleFields,
        videoRhInstanceType: node.metadata?.rhInstanceType || globalConfig.videoRhInstanceType || defaultConfig.videoRhInstanceType,
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
        // The 味型 pills write straight into node metadata, so it has to be read back here —
        // without this the picker re-rendered from the global default and every click looked dead.
        mjFlavor: node.metadata?.mjFlavor || globalConfig.mjFlavor || defaultConfig.mjFlavor,
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoCropSubtitles") return { cropSubtitles: value };
    if (key === "videoSteps") return { steps: value };
    if (key === "videoRefImageSize") return { refImageSize: value };
    if (key === "videoSamplerName") return { samplerName: value };
    if (key === "videoScheduler") return { scheduler: value };
    if (key === "videoSeedMode") return { seedMode: value };
    if (key === "videoSeed") return { seed: value };
    if (key === "videoAudioMode") return { audioMode: value };
    if (key === "videoFisherMode") return { fisherMode: value };
    if (key === "videoFisherLoraStrength") return { fisherLoraStrength: value };
    if (key === "videoFisherStyleFields") return { fisherStyleFields: value };
    if (key === "videoRhInstanceType") return { rhInstanceType: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    return { [key]: value };
}
