import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Button, Checkbox, Input } from "antd";
import type { InputRef } from "antd/es/input";
import { ChevronDown, ChevronUp, Replace, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export type TextMatchRange = { start: number; end: number };

export function collectTextMatches(text: string, query: string, caseSensitive: boolean): TextMatchRange[] {
    if (!query) return [];
    const source = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    if (!needle) return [];
    const matches: TextMatchRange[] = [];
    let from = 0;
    while (from <= source.length) {
        const index = source.indexOf(needle, from);
        if (index < 0) break;
        matches.push({ start: index, end: index + query.length });
        from = index + Math.max(1, needle.length);
    }
    return matches;
}

export function replaceAllTextMatches(text: string, query: string, replacement: string, caseSensitive: boolean): string {
    if (!query) return text;
    if (caseSensitive) return text.split(query).join(replacement);
    const needle = query.toLowerCase();
    let result = "";
    let from = 0;
    while (from <= text.length) {
        const index = text.toLowerCase().indexOf(needle, from);
        if (index < 0) {
            result += text.slice(from);
            break;
        }
        result += text.slice(from, index) + replacement;
        from = index + query.length;
    }
    return result;
}

/** Select [start, end) in a textarea or contentEditable, using serialized offsets for chip editors. */
export function selectEditableRange(target: HTMLElement | HTMLTextAreaElement | null | undefined, start: number, end: number) {
    if (!target) return;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        target.focus();
        target.setSelectionRange(start, end);
        const before = target.value.slice(0, start);
        const line = before.split("\n").length;
        const style = window.getComputedStyle(target);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 20;
        target.scrollTop = Math.max(0, (line - 3) * lineHeight);
        return;
    }

    target.focus();
    const range = rangeFromSerializedOffsets(target, start, end);
    if (!range) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const node = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    node?.scrollIntoView({ block: "nearest" });
}

function rangeFromSerializedOffsets(root: HTMLElement, start: number, end: number): Range | null {
    const startPoint = pointFromSerializedOffset(root, start);
    const endPoint = pointFromSerializedOffset(root, end);
    if (!startPoint || !endPoint) return null;
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
}

function pointFromSerializedOffset(root: HTMLElement, targetOffset: number): { node: Node; offset: number } | null {
    let consumed = 0;
    const walk = (nodes: NodeListOf<ChildNode>): { node: Node; offset: number } | null => {
        for (const node of Array.from(nodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || "";
                if (consumed + text.length >= targetOffset) {
                    return { node, offset: Math.max(0, targetOffset - consumed) };
                }
                consumed += text.length;
                continue;
            }
            if (!(node instanceof HTMLElement)) continue;
            const label = node.dataset.refLabel;
            if (label) {
                if (consumed + label.length >= targetOffset) {
                    // Chips are atomic; clamp selection to the chip edges.
                    return { node, offset: targetOffset <= consumed ? 0 : 1 };
                }
                consumed += label.length;
                continue;
            }
            if (node.tagName === "BR") {
                if (consumed + 1 >= targetOffset) return { node, offset: 0 };
                consumed += 1;
                continue;
            }
            const nested = walk(node.childNodes);
            if (nested) return nested;
        }
        return null;
    };
    return walk(root.childNodes) || { node: root, offset: root.childNodes.length };
}

type FindReplaceController = {
    findOpen: boolean;
    setFindOpen: (open: boolean) => void;
    openFindBar: (focusReplace?: boolean) => void;
    handleShortcutKeyDown: (event: ReactKeyboardEvent | KeyboardEvent) => boolean;
    toggle: ReactNode;
    panel: ReactNode;
};

type UseTextFindReplaceOptions = {
    value: string;
    onChange: (next: string) => void;
    getTarget: () => HTMLElement | HTMLTextAreaElement | null;
    readOnly?: boolean;
    /** Reset internal state when this key changes (e.g. dialog open). */
    resetKey?: string | number | boolean;
    className?: string;
    showToggle?: boolean;
};

export function useTextFindReplace({
    value,
    onChange,
    getTarget,
    readOnly = false,
    resetKey,
    className,
    showToggle = true,
}: UseTextFindReplaceOptions): FindReplaceController {
    const { t } = useTranslation();
    const findInputRef = useRef<InputRef>(null);
    const replaceInputRef = useRef<InputRef>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const [replaceQuery, setReplaceQuery] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [activeMatch, setActiveMatch] = useState(0);
    const pendingSelectRef = useRef<TextMatchRange | null>(null);

    const matches = useMemo(() => collectTextMatches(value, findQuery, caseSensitive), [caseSensitive, findQuery, value]);

    useEffect(() => {
        setFindOpen(false);
        setFindQuery("");
        setReplaceQuery("");
        setCaseSensitive(false);
        setActiveMatch(0);
        pendingSelectRef.current = null;
    }, [resetKey]);

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
        window.setTimeout(() => selectEditableRange(getTarget(), pending.start, pending.end), 0);
    }, [getTarget, value]);

    const selectMatch = (index: number) => {
        const match = matches[index];
        if (!match) return;
        selectEditableRange(getTarget(), match.start, match.end);
    };

    const openFindBar = (focusReplace = false) => {
        setFindOpen(true);
        window.setTimeout(() => {
            if (focusReplace) replaceInputRef.current?.focus({ cursor: "all" });
            else findInputRef.current?.focus({ cursor: "all" });
        }, 0);
    };

    const goToMatch = (direction: 1 | -1) => {
        if (!matches.length) return;
        const target = getTarget();
        const current = matches[activeMatch];
        let alreadyOnCurrent = false;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
            alreadyOnCurrent = !!current && target.selectionStart === current.start && target.selectionEnd === current.end;
        } else if (target && current) {
            const selection = window.getSelection();
            if (selection?.rangeCount) {
                const selected = selection.toString();
                alreadyOnCurrent = selected === value.slice(current.start, current.end);
            }
        }
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
        const nextValue = `${value.slice(0, match.start)}${replaceQuery}${value.slice(match.end)}`;
        const nextEnd = match.start + replaceQuery.length;
        const remaining = collectTextMatches(nextValue, findQuery, caseSensitive);
        const nextHit = remaining.find((item) => item.start >= nextEnd) || remaining[0];
        if (nextHit) {
            pendingSelectRef.current = nextHit;
            setActiveMatch(remaining.indexOf(nextHit));
        } else {
            pendingSelectRef.current = { start: match.start, end: nextEnd };
        }
        onChange(nextValue);
    };

    const replaceAll = () => {
        if (readOnly || !findQuery || !matches.length) return;
        onChange(replaceAllTextMatches(value, findQuery, replaceQuery, caseSensitive));
        setActiveMatch(0);
    };

    const closeFindBar = () => {
        setFindOpen(false);
        getTarget()?.focus();
    };

    const handleShortcutKeyDown = (event: ReactKeyboardEvent | KeyboardEvent) => {
        const key = event.key.toLowerCase();
        const mod = event.ctrlKey || event.metaKey;
        if (mod && key === "f") {
            event.preventDefault();
            event.stopPropagation();
            openFindBar(false);
            return true;
        }
        if (mod && key === "h") {
            event.preventDefault();
            event.stopPropagation();
            openFindBar(true);
            return true;
        }
        if (key === "escape" && findOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeFindBar();
            return true;
        }
        return false;
    };

    const handleFindKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            goToMatch(event.shiftKey ? -1 : 1);
        } else if (event.key === "Escape") {
            event.preventDefault();
            closeFindBar();
        }
    };

    const toggle = showToggle ? (
        <Button
            size="small"
            type={findOpen ? "primary" : "default"}
            className="!inline-flex !h-7 !items-center !gap-1 !rounded-full !px-2.5 !text-xs"
            icon={<Search className="size-3.5" />}
            onClick={() => (findOpen ? setFindOpen(false) : openFindBar(false))}
        >
            {t("canvas.textFindReplace.open")}
        </Button>
    ) : null;

    const panel = findOpen ? (
        <div className={`space-y-2 rounded-xl border border-stone-200 bg-stone-50/80 p-3 dark:border-stone-700 dark:bg-stone-900/40 ${className || ""}`}>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    ref={findInputRef}
                    size="small"
                    allowClear
                    value={findQuery}
                    placeholder={t("canvas.textFindReplace.findPlaceholder")}
                    className="!min-w-[160px] !flex-1"
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
                <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={closeFindBar} title={t("common.close")} />
            </div>
            {readOnly ? null : (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        ref={replaceInputRef}
                        size="small"
                        allowClear
                        value={replaceQuery}
                        placeholder={t("canvas.textFindReplace.replacePlaceholder")}
                        className="!min-w-[160px] !flex-1"
                        prefix={<Replace className="size-3.5 opacity-50" />}
                        onChange={(event) => setReplaceQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                replaceCurrent();
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                closeFindBar();
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
    ) : null;

    return { findOpen, setFindOpen, openFindBar, handleShortcutKeyDown, toggle, panel };
}
