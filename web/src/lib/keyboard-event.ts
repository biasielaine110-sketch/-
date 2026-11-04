type NativeKeyboardEventLike = {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
};

type KeyboardEventLike = NativeKeyboardEventLike & {
    key?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    nativeEvent?: NativeKeyboardEventLike;
};

export function isImeComposing(event: KeyboardEventLike) {
    const nativeEvent = event.nativeEvent;
    return Boolean(event.isComposing || nativeEvent?.isComposing || event.keyCode === 229 || event.which === 229 || nativeEvent?.keyCode === 229 || nativeEvent?.which === 229);
}

/**
 * `event.key?.toLowerCase()` 的安全版。
 *
 * 真实 keydown 一定带 key，但页面里还有代码用 `dispatchEvent(new Event("keydown"))`、
 * 或者 `new KeyboardEvent("keydown", { code: "KeyG" })` 这类**合成事件**驱动快捷键。
 * 这类事件 `key` 是 undefined，而 `code !== "KeyG" && event.key.toLowerCase()` 的短路顺序
 * 恰好会走到 toLowerCase，于是整页抛
 * `Uncaught TypeError: Cannot read properties of undefined (reading 'toLowerCase')`。
 * 全局 capture 监听器里一旦抛错，同一个事件上排在后面的快捷键就全被吞掉。
 */
export function keyLower(event: KeyboardEventLike) {
    return typeof event.key === "string" ? event.key.toLowerCase() : "";
}

export function isPlainEnterKey(event: KeyboardEventLike) {
    return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !isImeComposing(event);
}
