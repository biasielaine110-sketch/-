import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Clock, GripVertical, LoaderCircle, Maximize2, Square, WandSparkles, X } from "lucide-react";
import { App, Button, Tooltip } from "antd";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { defaultConfig, resolveModelForCapability, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { resolveH3OptimizeSystemPrompt, resolveNodePromptField } from "@/lib/canvas/h3-prompt-optimize";
import { resolveViolationOptimizeSystemPrompt } from "@/lib/canvas/violation-prompt-optimize";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
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

/** 参考图 chip 的拖拽会话（pointer 手写拖拽，见组件内注释）。 */
type ChipDragState = {
    index: number;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    move: ((event: PointerEvent) => void) | null;
    up: ((event: PointerEvent) => void) | null;
    cancel: (() => void) | null;
};

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
    /** 双击参考图 chip：交给画布打开全屏预览（复用图片节点的详情弹窗，可缩放/下载）。 */
    onPreviewReference?: (referenceNodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    /** 排期生成时间（epoch ms）。设置后到点由画布调度器自动触发一次生成。 */
    scheduledAt?: number;
    /** 设定/更新排期时间。 */
    onSchedule?: (at: number) => void;
    /** 取消当前排期。 */
    onCancelSchedule?: () => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
    /**
     * 内嵌模式：去掉浮层的固定宽度 / 边框 / 阴影，铺满父容器。
     * MochiAni 节点把这个面板**装进节点内容区**（不再是盖在画布上的浮窗）。
     */
    embedded?: boolean;
    /**
     * 藏掉「模型 + 参数」这一行（只留风格 / 镜头）。
     * MochiAni 的模型和参数来自桥那边的 `/api/models`，本地渠道的 ModelPicker 在这里是无效控件。
     */
    hideModelRow?: boolean;
    /** 藏掉排期入口：MochiAni 那条链路没有排期调度器，留着就是个点了没反应的按钮。 */
    hideSchedule?: boolean;
    /**
     * 运行中是否还允许再点一次提交（原生 H3 视频节点会排队）。
     * 不给就沿用老规则「只有视频模式能排队」；MochiAni 桥不排队，传 false 只剩「停止」。
     */
    allowSubmitWhileRunning?: boolean;
    /** 覆盖主按钮文案（默认「生成」；纯图标按钮会用它当 aria-label）。 */
    generateLabel?: string;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onContentChange, onGenerate, onStop, mentionReferences = [], onReorderReferences, onRemoveReference, onPreviewReference, onImageSettingsOpenChange, scheduledAt, onSchedule, onCancelSchedule, modeOverride, embedded, hideModelRow, hideSchedule, allowSubmitWhileRunning, generateLabel }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const textPrompts = useConfigStore((state) => state.config.textPrompts || []);
    const skillPacks = useChatSkillPacksStore((state) => state.packs);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);

    // 「h3 提示词优化」的 instruction：技能库「转Minih3-视频提示词」优先，没装才回落词库。
    // 图片 / 视频节点的**放大编辑弹窗**里也要有这颗按钮，所以两条入口共用这一份解析结果。
    const h3PromptSource = useMemo(() => resolveH3OptimizeSystemPrompt(skillPacks, textPrompts), [skillPacks, textPrompts]);
    // 「违规优化」的 instruction：只认词库那条「--------------提示词---违规优化-------------」，
    // 用户没建时用内置兜底（用户 2026-11-11 第 01 条）。
    const violationPromptSource = useMemo(() => resolveViolationOptimizeSystemPrompt(textPrompts), [textPrompts]);
    const h3TextConfig = useMemo(() => buildGenerationConfig(globalConfig, node, "text"), [globalConfig, node]);
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
    // 主按钮文案：默认走词库的「生成」，内嵌方（MochiAni 的「预检」）可以整条覆盖。
    const submitLabel = generateLabel ?? t("canvas.promptPanel.generate");

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

    /**
     * 放大编辑弹窗里的「h3 提示词优化」配置。
     *
     * `job` + `applyOptimized` 是关键：请求跑在 `h3-optimize-runner` 的**后台队列**里，
     * 弹窗关掉以后仍然按 `field` 把结果写回这个节点（`updatePrompt` 同时会更新面板的本地 state），
     * 所以用户不用盯着弹窗等。
     */
    const h3OptimizeOption =
        mode === "image" || mode === "video"
            ? {
                  config: h3TextConfig,
                  systemPrompt: h3PromptSource.text,
                  sourceTitle: h3PromptSource.title,
                  fromSkill: h3PromptSource.source === "skill",
                  job: { id: node.id, title: String(node.title || node.id), field: resolveNodePromptField(node) },
                  applyOptimized: updatePrompt,
              }
            : null;

    /**
     * 放大编辑弹窗里的「违规优化」配置。
     *
     * 与 h3 那条同构（同样靠 `job` + `applyOptimized` 在关窗后写回），差别只有两个：
     * instruction 来自**词库**而不是技能，模型**不给选**（恒跟偏好里的文本模型）。
     */
    const violationOptimizeOption =
        mode === "image" || mode === "video"
            ? {
                  config: h3TextConfig,
                  systemPrompt: violationPromptSource.text,
                  sourceTitle: violationPromptSource.title,
                  fromLibrary: violationPromptSource.fromLibrary,
                  job: { id: node.id, title: String(node.title || node.id), field: resolveNodePromptField(node) },
                  applyOptimized: updatePrompt,
              }
            : null;

    /**
     * 放大编辑弹窗里的「编辑提示词」配置（用户 2026-11-11 第 01 条）。
     *
     * 模型**恒跟偏好里的文本模型**：`h3TextConfig.model` 是按 capability=text 解析的，
     * 但节点自己存过 `metadata.model`（生图 / 生视频模型）时可能把它顶掉，所以这里
     * 显式把 `model` 覆回 `textModel` —— 用户点名的就是「跟着偏好里的模型」。
     *
     * 指令不在这里：内置在 `lib/canvas/edit-prompt.ts`（弹窗里直接用）。
     */
    const promptEditModel = String(h3TextConfig.textModel || h3TextConfig.model || "").trim();
    const promptEditOption =
        mode === "image" || mode === "video"
            ? {
                  config: { ...h3TextConfig, model: promptEditModel || h3TextConfig.model },
                  modelName: promptEditModel,
                  job: { id: node.id, title: String(node.title || node.id), field: resolveNodePromptField(node) },
                  applyOptimized: updatePrompt,
              }
            : null;

    const textEdit = useCanvasTextEditDialog({
        value: prompt,
        onChange: updatePrompt,
        title: t("canvas.promptPanel.editorTitle"),
        placeholder: promptPlaceholder,
        h3Optimize: h3OptimizeOption,
        violationOptimize: violationOptimizeOption,
        promptEdit: promptEditOption,
    });

    const activeReferences = mentionReferences.filter((reference) => reference.active && reference.nodeId !== node.id);

    // 参考图 chip 的拖拽排序 —— **指针事件手写，不用 HTML5 drag**。
    //
    // 为什么换掉 HTML5 drag：这排 chip 长在画布节点里，外层是 `transform: scale()` 的缩放容器。
    // 浏览器原生 drag 在这个环境里非常脆 —— 只要 `dragstart` 之后被拖元素被 React 重渲染碰到一点点
    // （class 变更、兄弟节点插入），或者 `dragover` 有一帧没被 preventDefault，浏览器就会**直接取消
    // 这次拖拽**：拖影一闪、光标回弹、之后拖到手柄上再怎么拖都不响应 —— 就是「拖动完卡住」。
    // 现在改成 pointer 自己接管：pointerdown 拦住（不让画布拿去拖节点），move/up 挂到 window
    // 的**捕获阶段**，指针飘到哪里都不会丢事件，也不存在「浏览器中途取消」这条路径。
    //
    // 拖拽状态（起点下标 / 是否已越过阈值）放 ref，只有「插入位」和「正在拖第几张」进 state，
    // 避免每一次 mousemove 都重渲染整个面板。
    const [dragChipIndex, setDragChipIndex] = useState<number | null>(null);
    const [dropSlot, setDropSlot] = useState<number | null>(null);
    const dragChipRef = useRef<ChipDragState | null>(null);
    const dropSlotRef = useRef<number | null>(null);
    const chipRowRef = useRef<HTMLDivElement | null>(null);

    // 双击参考图 chip = 放大预览。
    //
    // 为什么不用 `onDoubleClick`：`pointerdown` 里为了不让画布把这次按下当成「拖节点 / 平移画布」，
    // 已经 `preventDefault()` 过了 —— 浏览器因此不会补发兼容鼠标事件（mousedown/mouseup/click/dblclick），
    // 原生双击在这排 chip 上根本不会触发。所以双击判定自己做：
    // 同一个 chip、两次按下间隔 ≤ 320ms、位移 ≤ 6px（手抖不算换位置）。
    const CHIP_DOUBLE_TAP_MS = 320;
    const lastChipTapRef = useRef<{ index: number; time: number; x: number; y: number } | null>(null);

    // 面板可能在拖拽中被卸载（取消选中 / 重新生成）—— 把挂在 window 上的监听摘掉，别泄漏。
    useEffect(
        () => () => {
            const state = dragChipRef.current;
            if (!state) return;
            if (state.move) window.removeEventListener("pointermove", state.move, true);
            if (state.up) window.removeEventListener("pointerup", state.up, true);
            if (state.cancel) window.removeEventListener("pointercancel", state.cancel, true);
            dragChipRef.current = null;
            document.body.style.cursor = "";
        },
        [],
    );

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

    /** 光标是否还在这排 chip 附近（松手处飘到画布上就算放弃，别把「拖走」当成「拖到最后」）。 */
    const isInsideChipRow = (clientX: number, clientY: number) => {
        const row = chipRowRef.current;
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        const pad = 28;
        return clientX >= rect.left - pad && clientX <= rect.right + pad && clientY >= rect.top - pad && clientY <= rect.bottom + pad;
    };

    const setDropSlotBoth = (slot: number | null) => {
        dropSlotRef.current = slot;
        setDropSlot(slot);
    };

    /** 只有「有图的图片参考」才有放大预览（视频 / 音频 / 纯文本 chip 不接）。 */
    const canPreviewReference = (reference: CanvasResourceReference | undefined) =>
        Boolean(onPreviewReference && reference && reference.kind === "image" && reference.previewUrl);

    const previewReference = (reference: CanvasResourceReference | undefined) => {
        if (!canPreviewReference(reference)) return;
        onPreviewReference?.(reference!.nodeId);
    };

    const handleChipPointerDown = (event: React.PointerEvent<HTMLSpanElement>, index: number) => {
        if (!onReorderReferences || event.button !== 0 || dragChipRef.current) return;
        // 必须拦下来：不然画布把这次 pointerdown 当「拖节点 / 平移画布」。
        event.preventDefault();
        event.stopPropagation();

        // 双击 → 放大预览（判定见 `CHIP_DOUBLE_TAP_MS` 附近注释）。第二下不再开始拖拽，
        // 不然「双击预览」会先被记成一次原地拖动。
        const reference = activeReferences[index];
        const now = Date.now();
        const lastTap = lastChipTapRef.current;
        const isDoubleTap =
            canPreviewReference(reference) &&
            Boolean(lastTap) &&
            lastTap!.index === index &&
            now - lastTap!.time <= CHIP_DOUBLE_TAP_MS &&
            Math.hypot(event.clientX - lastTap!.x, event.clientY - lastTap!.y) <= 6;
        lastChipTapRef.current = { index, time: now, x: event.clientX, y: event.clientY };
        if (isDoubleTap) {
            lastChipTapRef.current = null;
            previewReference(reference);
            return;
        }

        const reorder = onReorderReferences;
        const state: ChipDragState = {
            index,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            move: null,
            up: null,
            cancel: null,
        };
        const detach = () => {
            if (state.move) window.removeEventListener("pointermove", state.move, true);
            if (state.up) window.removeEventListener("pointerup", state.up, true);
            if (state.cancel) window.removeEventListener("pointercancel", state.cancel, true);
        };
        const end = () => {
            detach();
            dragChipRef.current = null;
            setDragChipIndex(null);
            setDropSlotBoth(null);
            if (document.body.style.cursor === "grabbing") document.body.style.cursor = "";
        };

        state.move = (native) => {
            if (native.pointerId !== state.pointerId) return;
            native.preventDefault();
            if (!state.moved) {
                // 4px 阈值：手抖不算拖拽，避免「点一下就换了位置」。
                if (Math.hypot(native.clientX - state.startX, native.clientY - state.startY) < 4) return;
                state.moved = true;
                // 真的拖起来了 → 上一记点击作废，免得「拖完马上点一下」被读成双击。
                lastChipTapRef.current = null;
                setDragChipIndex(state.index);
                setDropSlotBoth(state.index);
                document.body.style.cursor = "grabbing";
            }
            if (!isInsideChipRow(native.clientX, native.clientY)) {
                if (dropSlotRef.current !== null) setDropSlotBoth(null);
                return;
            }
            const slot = resolveDropSlot(native.clientX, native.clientY);
            if (slot !== dropSlotRef.current) setDropSlotBoth(slot);
        };

        state.up = (native) => {
            if (native.pointerId !== state.pointerId) return;
            const droppedInside = isInsideChipRow(native.clientX, native.clientY);
            const slot = state.moved && droppedInside ? resolveDropSlot(native.clientX, native.clientY) : state.index;
            const moved = state.moved;
            end();
            if (!moved || !droppedInside) return;
            const to = resolveReorderTargetIndex(index, slot, activeReferences.length);
            if (to < 0) return;
            reorder(moveIndex(activeReferences, index, to).map((reference) => reference.nodeId));
        };

        state.cancel = () => end();

        dragChipRef.current = state;
        // 监听挂在 window 的**捕获阶段**：指针飘出面板、甚至落到画布上都不会丢事件，
        // 画布也没机会把 move/up 吞掉。这是「拖到一半卡死」最根本的兜底。
        window.addEventListener("pointermove", state.move, true);
        window.addEventListener("pointerup", state.up, true);
        window.addEventListener("pointercancel", state.cancel, true);
    };

    const connectedTextPrompt = activeReferences
        .filter((reference) => reference.kind === "text" && reference.text?.trim())
        .map((reference) => reference.text!.trim())
        .join("\n\n");
    const canSubmit = Boolean(prompt.trim() || connectedTextPrompt);

    // Native H3 video: allow another submit while one is running — canvas FIFO queues it.
    // Other modes still block until the current run finishes (button becomes Stop).
    const allowQueueWhileRunning = allowSubmitWhileRunning ?? mode === "video";

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
                    { role: "system", content: h3PromptSource.text },
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
            className={
                // 内嵌形态**不写 `h-full`**：宿主（MochiAni 节点）把它放在一个高度 auto 的滚动列里，
                // `h-full` 会被解析成「整个滚动区的高度」，把面板抻成一整屏。高度交给内容自己撑。
                embedded
                    ? "flex w-full min-w-0 flex-col overflow-hidden"
                    : "min-w-0 overflow-hidden rounded-2xl border p-3 shadow-2xl backdrop-blur"
            }
            style={
                embedded
                    ? { color: theme.node.text }
                    : { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, width: 600, maxWidth: 600 }
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {activeReferences.length ? (
                <div ref={chipRowRef} className="mb-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] opacity-55">{t("canvas.promptPanel.references")}</span>
                    {activeReferences.map((reference, index) => {
                        const isDragging = dragChipIndex === index;
                        const canPreview = canPreviewReference(reference);
                        return (
                            <Fragment key={reference.id}>
                                {dropSlot === index && dragChipIndex !== null ? (
                                    <span data-ref-drop-marker={index} className="h-6 w-0.5 shrink-0 rounded-full bg-sky-500" aria-hidden />
                                ) : null}
                                <span
                                    data-ref-chip={index}
                                    // 整块 chip（抓手 / 缩略图 / 标签）都能拖 —— 指针事件由自己接管，
                                    // 不再依赖浏览器原生 drag。见上面 `handleChipPointerDown` 的注释。
                                    onPointerDown={onReorderReferences ? (event) => handleChipPointerDown(event, index) : undefined}
                                    // 兜底：没有拖拽回调时 pointerdown 不会 preventDefault，原生双击照常触发。
                                    onDoubleClick={canPreview ? () => previewReference(reference) : undefined}
                                    className={`relative mr-1 inline-flex max-w-44 touch-none select-none items-center gap-1 rounded-lg border px-1.5 py-1 text-xs transition-opacity ${isDragging ? "opacity-40" : ""} ${onReorderReferences ? "cursor-grab active:cursor-grabbing" : ""}`}
                                    style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.text }}
                                    title={canPreview ? `${reference.title} · ${t("canvas.promptPanel.previewHint")}` : reference.title}
                                >
                                    <span
                                        data-ref-chip-handle={index}
                                        className="pointer-events-none opacity-45"
                                        title={t("canvas.promptPanel.reorderHint")}
                                        aria-label={t("canvas.promptPanel.reorderHint")}
                                    >
                                        <GripVertical className="size-3" />
                                    </span>
                                    {reference.kind === "image" && reference.previewUrl ? (
                                        <span className="group/ref relative inline-flex shrink-0">
                                            <img src={reference.previewUrl} alt="" draggable={false} className="size-6 rounded object-cover" />
                                            {canPreview ? (
                                                // 悬停时缩略图右下角浮出「放大」角标，提示这里可以双击。
                                                <Maximize2 className="pointer-events-none absolute -bottom-1 -right-1 size-2.5 rounded-sm bg-black/60 p-px text-white opacity-0 transition-opacity group-hover/ref:opacity-100" />
                                            ) : null}
                                        </span>
                                    ) : null}
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
                className={`thin-scrollbar min-w-0 w-full max-w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none ${embedded ? "min-h-24 flex-1" : "h-40"}`}
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
                            {/* hideModelRow：模型和参数由调用方自己给（MochiAni 节点的模型目录来自桥，
                                本地渠道的 ModelPicker 在那儿选了也不生效）。风格 / 镜头照旧保留。 */}
                            {hideModelRow ? null : (
                                <>
                                    <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[160px]" />
                                    <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !max-w-[150px] !shrink-0 !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                                </>
                            )}
                            {/* 视频窗口的风格模板：控件与内容跟图片节点完全一致（用户 2026-11-08 第 04 条），
                                同样落在 `metadata.styleTemplateId`，生成时由 `composeStyledPrompt` 追加到提示词尾部。 */}
                            <CanvasStylePicker
                                value={node.metadata?.styleTemplateId}
                                onChange={(styleTemplateId) => onConfigChange(node.id, { styleTemplateId })}
                                buttonClassName="!h-10 !max-w-[140px] !shrink-0 !justify-start !rounded-full !px-3"
                                placement="topLeft"
                            />
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
                    {scheduledAt && !hideSchedule ? (
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
                            {/* hideSchedule：没有排期调度器的宿主（MochiAni 节点）不显示这颗点了没反应的按钮。 */}
                            {hideSchedule ? null : (
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
                            )}
                            {running && allowQueueWhileRunning ? (
                                <>
                                    <Button
                                        type="primary"
                                        className="!h-10 !min-w-12 shrink-0 !rounded-full !px-3"
                                        disabled={!canSubmit}
                                        onClick={submit}
                                        aria-label={submitLabel}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            <ArrowUp className="size-4" />
                                            {generateLabel ? <span className="text-xs font-medium">{generateLabel}</span> : null}
                                        </span>
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
                                    aria-label={running ? t("canvas.promptPanel.stopGeneration") : submitLabel}
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
                                            <>
                                                <ArrowUp className="size-4" />
                                                {generateLabel ? <span className="text-xs font-medium">{generateLabel}</span> : null}
                                            </>
                                        )}
                                    </span>
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </div>
            {onSchedule && !hideSchedule ? (
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
