import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { LoaderCircle, Minus, Plus, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { insertTextIntoInputElement, readClipboardEventText } from "@/lib/canvas/clipboard-paste";
import { requestH3PromptOptimize } from "@/lib/canvas/h3-prompt-optimize";
import type { AiConfig } from "@/stores/use-config-store";
import { ModelPicker } from "@/components/model-picker";
import { useTextFindReplace } from "./canvas-text-find-replace";
import { CanvasTextPromptPicker } from "./canvas-text-prompt-picker";
import { DEFAULT_CANVAS_FONT_SIZE } from "@/constant/canvas";

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 48;
const FONT_SIZE_STEP = 2;

/**
 * 「h3 提示词优化」入口配置 —— 只有图片 / 视频节点的提示词弹窗才传。
 *
 * `config` 是 **capability=text** 的配置（模型单独选，默认跟 `config.textModel` 走），
 * `systemPrompt` 已经是技能库 / 词库里的正文，弹窗自己不碰技能解析。
 */
export type CanvasTextEditDialogH3Optimize = {
    config: AiConfig;
    systemPrompt: string;
    /** 来源标题（技能名 / 词条名），显示在按钮旁 */
    sourceTitle: string;
    /** 命中技能库还是回落词库 —— 决定提示文案 */
    fromSkill: boolean;
};

type CanvasTextEditDialogProps = {
    open: boolean;
    value: string;
    title?: string;
    placeholder?: string;
    fontSize?: number;
    readOnly?: boolean;
    onFontSizeChange?: (fontSize: number) => void;
    /** 传了才显示「h3 提示词优化」那一行。 */
    h3Optimize?: CanvasTextEditDialogH3Optimize | null;
    onClose: () => void;
    onSave?: (content: string) => void;
};

export function CanvasTextEditDialog({ open, value, title, placeholder, fontSize, readOnly = false, onFontSizeChange, h3Optimize = null, onClose, onSave }: CanvasTextEditDialogProps) {
    const { t } = useTranslation();
    const textAreaRef = useRef<TextAreaRef>(null);
    const draftRef = useRef(value);
    const [draft, setDraft] = useState(value);
    const [localFontSize, setLocalFontSize] = useState(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || DEFAULT_CANVAS_FONT_SIZE)));
    const resolvedFontSize = onFontSizeChange
        ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || DEFAULT_CANVAS_FONT_SIZE))
        : localFontSize;

    // h3 提示词优化：模型可单独选（空 = 用默认文本模型），流式结果直接写进编辑区。
    const [optimizeModel, setOptimizeModel] = useState("");
    const [optimizing, setOptimizing] = useState(false);
    const [optimizeError, setOptimizeError] = useState("");
    const optimizeControllerRef = useRef<AbortController | null>(null);
    const canH3Optimize = Boolean(h3Optimize && h3Optimize.systemPrompt.trim() && !readOnly);

    draftRef.current = draft;

    // 只在「打开瞬间」同步外部 value，避免打开后父级回写冲掉弹窗内粘贴内容。
    useEffect(() => {
        if (!open) return;
        setDraft(value);
        draftRef.current = value;
        setLocalFontSize(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || DEFAULT_CANVAS_FONT_SIZE)));
        setOptimizeError("");
        // eslint-disable-next-line react-hooks/exhaustive-deps -- sync once per open
    }, [open]);

    // 关闭 / 卸载一律掐掉飞行中的请求，避免请求回来后往已经关掉的弹窗里写文本。
    useEffect(() => {
        if (open) return;
        optimizeControllerRef.current?.abort();
        optimizeControllerRef.current = null;
        setOptimizing(false);
    }, [open]);
    useEffect(() => () => optimizeControllerRef.current?.abort(), []);

    const writeDraft = (text: string) => {
        draftRef.current = text;
        setDraft(text);
    };

    const runH3Optimize = async () => {
        if (!h3Optimize || !canH3Optimize) return;
        // 优化中再点 = 停止，并把内容退回优化前的样子。
        if (optimizeControllerRef.current) {
            optimizeControllerRef.current.abort();
            return;
        }
        const original = draftRef.current;
        if (!original.trim()) return;
        const controller = new AbortController();
        optimizeControllerRef.current = controller;
        setOptimizing(true);
        setOptimizeError("");
        const model = optimizeModel.trim() || h3Optimize.config.textModel || h3Optimize.config.model;
        try {
            const answer = await requestH3PromptOptimize(
                { ...h3Optimize.config, model },
                original,
                {
                    systemPrompt: h3Optimize.systemPrompt,
                    signal: controller.signal,
                    onStream: (text) => {
                        if (controller.signal.aborted) return;
                        writeDraft(text);
                    },
                },
            );
            if (controller.signal.aborted) return;
            writeDraft(answer);
        } catch (error) {
            if (controller.signal.aborted) {
                writeDraft(original);
                return;
            }
            setOptimizeError(error instanceof Error ? error.message : String(error));
        } finally {
            if (optimizeControllerRef.current === controller) optimizeControllerRef.current = null;
            setOptimizing(false);
        }
    };

    const findReplace = useTextFindReplace({
        value: draft,
        onChange: setDraft,
        getTarget: () => textAreaRef.current?.resizableTextArea?.textArea || null,
        readOnly,
        resetKey: open,
    });

    const handleSave = () => {
        onSave?.(draft);
        onClose();
    };

    const adjustFontSize = (delta: number) => {
        const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, resolvedFontSize + delta));
        if (next === resolvedFontSize) return;
        if (onFontSizeChange) onFontSizeChange(next);
        else setLocalFontSize(next);
    };

    const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
        // 全程自己写入：不依赖原生插入（受控 TextArea + 画布 window paste 抢事件时更稳）。
        event.preventDefault();
        event.stopPropagation();
        if (readOnly) return;
        const text = readClipboardEventText(event.clipboardData);
        if (!text) return;
        const area = textAreaRef.current?.resizableTextArea?.textArea || event.currentTarget;
        const current = draftRef.current;
        const { next, caret } = insertTextIntoInputElement(area, text, current);
        draftRef.current = next;
        setDraft(next);
        requestAnimationFrame(() => {
            area.focus();
            try {
                area.setSelectionRange(caret, caret);
            } catch {
                // ignore
            }
        });
    };

    return createPortal(
        <div
            data-canvas-shortcuts-ignore
            data-canvas-text-edit-dialog
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onPaste={(event) => {
                // 焦点落在弹窗容器而不是 textarea 时（antd focus trap），仍把文字写进编辑区。
                if (readOnly) return;
                const target = event.target;
                if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
                event.preventDefault();
                event.stopPropagation();
                const text = readClipboardEventText(event.clipboardData);
                if (!text) return;
                const area = textAreaRef.current?.resizableTextArea?.textArea;
                if (!area) {
                    const next = `${draftRef.current}${text}`;
                    draftRef.current = next;
                    setDraft(next);
                    return;
                }
                area.focus();
                const current = draftRef.current;
                const { next, caret } = insertTextIntoInputElement(area, text, current);
                draftRef.current = next;
                setDraft(next);
                requestAnimationFrame(() => {
                    try {
                        area.setSelectionRange(caret, caret);
                    } catch {
                        // ignore
                    }
                });
            }}
            onKeyDown={(event) => findReplace.handleShortcutKeyDown(event)}
        >
            <Modal
                title={title || (readOnly ? t("canvas.chat.viewMessageTitle") : t("canvas.nodeToolbar.editTextTitle"))}
                open={open}
                onCancel={onClose}
                onOk={readOnly ? onClose : handleSave}
                okText={readOnly ? t("common.close") : t("common.save")}
                cancelText={t("common.cancel")}
                centered
                width={readOnly ? 900 : 720}
                zIndex={4000}
                destroyOnHidden
                getContainer={false}
                mask={{ closable: true }}
                afterOpenChange={(visible) => {
                    if (!visible) return;
                    // 打开后强制聚焦编辑区，避免 Ctrl+V 打在 mask/wrap 上。
                    window.setTimeout(() => {
                        const area = textAreaRef.current?.resizableTextArea?.textArea;
                        area?.focus();
                        if (!readOnly && area) {
                            const end = area.value.length;
                            try {
                                area.setSelectionRange(end, end);
                            } catch {
                                // ignore
                            }
                        }
                    }, 0);
                }}
                footer={
                    readOnly
                        ? [
                              <Button key="close" type="primary" onClick={onClose}>
                                  {t("common.close")}
                              </Button>,
                          ]
                        : [
                              <Button key="cancel" onClick={onClose}>
                                  {t("common.cancel")}
                              </Button>,
                              <Button key="save" type="primary" onClick={handleSave}>
                                  {t("common.save")}
                              </Button>,
                          ]
                }
            >
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs text-stone-500">
                        {readOnly ? t("canvas.chat.viewMessageHint") : t("canvas.textPromptLibrary.hint")}
                    </span>
                    <div className="flex items-center gap-2">
                        {findReplace.toggle}
                        <div className="inline-flex items-center gap-0.5 rounded-full border border-stone-200 px-1 py-0.5 dark:border-stone-700">
                            <button
                                type="button"
                                className="grid size-6 place-items-center rounded-full opacity-80 transition hover:opacity-100 disabled:opacity-35"
                                disabled={resolvedFontSize <= MIN_FONT_SIZE}
                                title={t("canvas.nodeToolbar.decreaseFont")}
                                aria-label={t("canvas.nodeToolbar.decreaseFont")}
                                onClick={() => adjustFontSize(-FONT_SIZE_STEP)}
                            >
                                <Minus className="size-3" />
                            </button>
                            <span className="min-w-7 text-center text-[10px] font-medium tabular-nums opacity-70">{resolvedFontSize}</span>
                            <button
                                type="button"
                                className="grid size-6 place-items-center rounded-full opacity-80 transition hover:opacity-100 disabled:opacity-35"
                                disabled={resolvedFontSize >= MAX_FONT_SIZE}
                                title={t("canvas.nodeToolbar.increaseFont")}
                                aria-label={t("canvas.nodeToolbar.increaseFont")}
                                onClick={() => adjustFontSize(FONT_SIZE_STEP)}
                            >
                                <Plus className="size-3" />
                            </button>
                        </div>
                        {readOnly ? null : (
                            <CanvasTextPromptPicker size="small" className="inline-flex h-7 items-center gap-1 rounded-full border border-stone-200 px-2.5 text-xs font-medium dark:border-stone-700" onSelect={(prompt) => setDraft(prompt.content)} />
                        )}
                    </div>
                </div>

                {findReplace.panel ? <div className="mb-3">{findReplace.panel}</div> : null}

                {/* h3 提示词优化：技能正文当 system、当前编辑内容当 user，模型可单独选（默认文本模型）。 */}
                {canH3Optimize && h3Optimize ? (
                    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 px-2 py-1.5 dark:border-stone-700" data-canvas-h3-optimize>
                        <Button
                            size="small"
                            type="primary"
                            ghost
                            className="!h-7 !shrink-0 !rounded-full !px-2.5"
                            icon={optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
                            disabled={!optimizing && !draft.trim()}
                            onClick={runH3Optimize}
                            title={t(h3Optimize.fromSkill ? "canvas.textEditDialog.h3OptimizeTitleSkill" : "canvas.textEditDialog.h3OptimizeTitleLibrary", { title: h3Optimize.sourceTitle })}
                        >
                            <span className="text-xs">{optimizing ? t("canvas.textEditDialog.h3OptimizeStop") : t("canvas.textEditDialog.h3Optimize")}</span>
                        </Button>
                        <span className="shrink-0 text-[11px] text-stone-500">{t("canvas.textEditDialog.h3OptimizeModel")}</span>
                        <ModelPicker
                            config={h3Optimize.config}
                            value={optimizeModel || h3Optimize.config.textModel}
                            onChange={setOptimizeModel}
                            capability="text"
                            className="max-w-[220px]"
                        />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-stone-400">
                            {t(h3Optimize.fromSkill ? "canvas.textEditDialog.h3OptimizeSourceSkill" : "canvas.textEditDialog.h3OptimizeSourceLibrary", { title: h3Optimize.sourceTitle })}
                        </span>
                        {optimizeError ? <span className="max-w-full truncate text-[11px] text-red-500">{optimizeError}</span> : null}
                    </div>
                ) : null}

                <Input.TextArea
                    ref={textAreaRef}
                    value={draft}
                    rows={readOnly ? 22 : 14}
                    autoFocus
                    readOnly={readOnly}
                    placeholder={placeholder || t("canvas.node.editTextPlaceholder")}
                    onChange={readOnly ? undefined : (event) => setDraft(event.target.value)}
                    onCopy={(event) => event.stopPropagation()}
                    onCut={(event) => event.stopPropagation()}
                    onPaste={handlePaste}
                    className={`font-mono ${readOnly ? "cursor-text" : ""}`}
                    style={{ fontSize: `${resolvedFontSize}px`, lineHeight: `${Math.round(resolvedFontSize * 1.55)}px` }}
                    data-canvas-shortcuts-ignore
                    data-canvas-text-input
                />
            </Modal>
        </div>,
        document.body,
    );
}
