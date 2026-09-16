import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Checkbox, Input, Modal } from "antd";
import type { InputRef } from "antd/es/input";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { ChevronDown, ChevronUp, Minus, Plus, Replace, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasTextPromptPicker } from "./canvas-text-prompt-picker";

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 48;
const FONT_SIZE_STEP = 2;

type CanvasTextEditDialogProps = {
    open: boolean;
    value: string;
    title?: string;
    placeholder?: string;
    fontSize?: number;
    readOnly?: boolean;
    onFontSizeChange?: (fontSize: number) => void;
    onClose: () => void;
    onSave?: (content: string) => void;
};

type MatchRange = { start: number; end: number };

function collectMatches(text: string, query: string, caseSensitive: boolean): MatchRange[] {
    if (!query) return [];
    const source = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    if (!needle) return [];
    const matches: MatchRange[] = [];
    let from = 0;
    while (from <= source.length) {
        const index = source.indexOf(needle, from);
        if (index < 0) break;
        matches.push({ start: index, end: index + query.length });
        from = index + Math.max(1, needle.length);
    }
    return matches;
}

export function CanvasTextEditDialog({ open, value, title, placeholder, fontSize, readOnly = false, onFontSizeChange, onClose, onSave }: CanvasTextEditDialogProps) {
    const { t } = useTranslation();
    const textAreaRef = useRef<TextAreaRef>(null);
    const findInputRef = useRef<InputRef>(null);
    const replaceInputRef = useRef<InputRef>(null);
    const [draft, setDraft] = useState(value);
    const [localFontSize, setLocalFontSize] = useState(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || 14)));
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const [replaceQuery, setReplaceQuery] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [activeMatch, setActiveMatch] = useState(0);
    const pendingSelectRef = useRef<{ start: number; end: number } | null>(null);
    const resolvedFontSize = onFontSizeChange
        ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || 14))
        : localFontSize;

    const matches = useMemo(() => collectMatches(draft, findQuery, caseSensitive), [caseSensitive, draft, findQuery]);

    useEffect(() => {
        if (open) {
            setDraft(value);
            setLocalFontSize(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize || 14)));
            setFindOpen(false);
            setFindQuery("");
            setReplaceQuery("");
            setCaseSensitive(false);
            setActiveMatch(0);
            pendingSelectRef.current = null;
        }
    }, [open, value, fontSize]);

    useEffect(() => {
        if (!matches.length) {
            setActiveMatch(0);
            return;
        }
        setActiveMatch((current) => Math.min(current, matches.length - 1));
    }, [matches]);

    useEffect(() => {
        const pending = pendingSelectRef.current;
        if (!pending) return;
        pendingSelectRef.current = null;
        const area = textAreaRef.current?.resizableTextArea?.textArea;
        if (!area) return;
        area.focus();
        area.setSelectionRange(pending.start, pending.end);
    }, [draft]);

    const getNativeTextArea = () => textAreaRef.current?.resizableTextArea?.textArea || null;

    const selectMatchByRange = (start: number, end: number) => {
        const area = getNativeTextArea();
        if (!area) return;
        area.focus();
        area.setSelectionRange(start, end);
        const before = draft.slice(0, start);
        const line = before.split("\n").length;
        const lineHeight = Math.round(resolvedFontSize * 1.55);
        area.scrollTop = Math.max(0, (line - 3) * lineHeight);
    };

    const selectMatch = (index: number) => {
        const match = matches[index];
        if (!match) return;
        selectMatchByRange(match.start, match.end);
    };

    const openFindBar = (focusReplace = false) => {
        setFindOpen(true);
        window.setTimeout(() => {
            if (focusReplace) replaceInputRef.current?.focus({ cursor: "all" });
            else findInputRef.current?.focus({ cursor: "all" });
            if (matches.length) selectMatch(activeMatch);
        }, 0);
    };

    const goToMatch = (direction: 1 | -1) => {
        if (!matches.length) return;
        const area = getNativeTextArea();
        const current = matches[activeMatch];
        const alreadyOnCurrent =
            !!area &&
            !!current &&
            area.selectionStart === current.start &&
            area.selectionEnd === current.end;
        if (!alreadyOnCurrent && direction === 1) {
            selectMatch(activeMatch);
            return;
        }
        const next = (activeMatch + direction + matches.length) % matches.length;
        setActiveMatch(next);
        window.setTimeout(() => selectMatch(next), 0);
    };

    const replaceCurrent = () => {
        if (readOnly || !matches.length) return;
        const match = matches[activeMatch] || matches[0];
        if (!match) return;
        const nextDraft = `${draft.slice(0, match.start)}${replaceQuery}${draft.slice(match.end)}`;
        const nextStart = match.start;
        const nextEnd = match.start + replaceQuery.length;
        // Prefer jumping to the next remaining find hit after this replacement.
        const remaining = collectMatches(nextDraft, findQuery, caseSensitive);
        const nextHit = remaining.find((item) => item.start >= nextEnd) || remaining[0];
        if (nextHit) {
            pendingSelectRef.current = nextHit;
            setActiveMatch(remaining.indexOf(nextHit));
        } else {
            pendingSelectRef.current = { start: nextStart, end: nextEnd };
        }
        setDraft(nextDraft);
    };

    const replaceAll = () => {
        if (readOnly || !findQuery || !matches.length) return;
        if (caseSensitive) {
            setDraft(draft.split(findQuery).join(replaceQuery));
            return;
        }
        const source = draft;
        const needle = findQuery.toLowerCase();
        let result = "";
        let from = 0;
        while (from <= source.length) {
            const index = source.toLowerCase().indexOf(needle, from);
            if (index < 0) {
                result += source.slice(from);
                break;
            }
            result += source.slice(from, index) + replaceQuery;
            from = index + findQuery.length;
        }
        setDraft(result);
        setActiveMatch(0);
    };

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

    const handleModalKeyDown = (event: ReactKeyboardEvent) => {
        const key = event.key.toLowerCase();
        const mod = event.ctrlKey || event.metaKey;
        if (mod && key === "f") {
            event.preventDefault();
            event.stopPropagation();
            openFindBar(false);
            return;
        }
        if (mod && key === "h") {
            event.preventDefault();
            event.stopPropagation();
            openFindBar(true);
            return;
        }
        if (key === "escape" && findOpen) {
            event.preventDefault();
            event.stopPropagation();
            setFindOpen(false);
            getNativeTextArea()?.focus();
        }
    };

    const handleFindKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            goToMatch(event.shiftKey ? -1 : 1);
        } else if (event.key === "Escape") {
            event.preventDefault();
            setFindOpen(false);
            getNativeTextArea()?.focus();
        }
    };

    // Portal outside the canvas transform tree so Modal buttons receive clicks correctly.
    return createPortal(
        <div
            data-canvas-shortcuts-ignore
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleModalKeyDown}
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
                        <Button
                            size="small"
                            type={findOpen ? "primary" : "default"}
                            className="!inline-flex !h-7 !items-center !gap-1 !rounded-full !px-2.5 !text-xs"
                            icon={<Search className="size-3.5" />}
                            onClick={() => (findOpen ? setFindOpen(false) : openFindBar(false))}
                        >
                            {t("canvas.textFindReplace.open")}
                        </Button>
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

                {findOpen ? (
                    <div className="mb-3 space-y-2 rounded-xl border border-stone-200 bg-stone-50/80 p-3 dark:border-stone-700 dark:bg-stone-900/40">
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                ref={findInputRef}
                                size="small"
                                allowClear
                                value={findQuery}
                                placeholder={t("canvas.textFindReplace.findPlaceholder")}
                                className="!min-w-[180px] !flex-1"
                                prefix={<Search className="size-3.5 opacity-50" />}
                                onChange={(event) => {
                                    setFindQuery(event.target.value);
                                    setActiveMatch(0);
                                }}
                                onKeyDown={handleFindKeyDown}
                            />
                            <span className="min-w-14 text-center text-xs tabular-nums text-stone-500">
                                {findQuery ? (matches.length ? `${activeMatch + 1}/${matches.length}` : t("canvas.textFindReplace.noMatches")) : "0/0"}
                            </span>
                            <Button size="small" icon={<ChevronUp className="size-3.5" />} disabled={!matches.length} onClick={() => goToMatch(-1)} title={t("canvas.textFindReplace.prev")} />
                            <Button size="small" icon={<ChevronDown className="size-3.5" />} disabled={!matches.length} onClick={() => goToMatch(1)} title={t("canvas.textFindReplace.next")} />
                            <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={() => setFindOpen(false)} title={t("common.close")} />
                        </div>
                        {readOnly ? null : (
                            <div className="flex flex-wrap items-center gap-2">
                                <Input
                                    ref={replaceInputRef}
                                    size="small"
                                    allowClear
                                    value={replaceQuery}
                                    placeholder={t("canvas.textFindReplace.replacePlaceholder")}
                                    className="!min-w-[180px] !flex-1"
                                    prefix={<Replace className="size-3.5 opacity-50" />}
                                    onChange={(event) => setReplaceQuery(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            replaceCurrent();
                                        } else if (event.key === "Escape") {
                                            event.preventDefault();
                                            setFindOpen(false);
                                            getNativeTextArea()?.focus();
                                        }
                                    }}
                                />
                                <Button size="small" disabled={!matches.length} onClick={replaceCurrent}>
                                    {t("canvas.textFindReplace.replace")}
                                </Button>
                                <Button size="small" disabled={!matches.length} onClick={replaceAll}>
                                    {t("canvas.textFindReplace.replaceAll")}
                                </Button>
                            </div>
                        )}
                        <Checkbox checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)}>
                            <span className="text-xs">{t("canvas.textFindReplace.caseSensitive")}</span>
                        </Checkbox>
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
                    onPaste={(event) => event.stopPropagation()}
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
