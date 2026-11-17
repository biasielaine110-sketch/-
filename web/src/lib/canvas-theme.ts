export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: "#f4f2ed",
            dot: "rgba(68,64,60,.28)",
            line: "rgba(68,64,60,.12)",
            selectionStroke: "#1c1917",
            selectionFill: "rgba(28,25,23,.06)",
        },
        node: {
            label: "#57534e",
            fill: "#e7e5df",
            panel: "#fbfaf7",
            stroke: "#d6d3ca",
            activeStroke: "#1c1917",
            placeholder: "#8a8479",
            text: "#292524",
            muted: "#78716c",
            faint: "#a8a29e",
        },
        toolbar: {
            panel: "rgba(251,250,247,.96)",
            border: "#d6d3ca",
            item: "#57534e",
            itemHover: "#e7e5df",
            activeBg: "#e7e5df",
            activeText: "#292524",
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#fafaf9",
            selectionFill: "rgba(250,250,249,.10)",
        },
        node: {
            label: "#d6d3d1",
            fill: "#292524",
            panel: "#1f1d1a",
            stroke: "#44403c",
            activeStroke: "#fafaf9",
            placeholder: "#a8a29e",
            text: "#f5f5f4",
            muted: "#d6d3d1",
            faint: "#78716c",
        },
        toolbar: {
            panel: "rgba(31,29,26,.96)",
            border: "#44403c",
            item: "#d6d3d1",
            itemHover: "#292524",
            activeBg: "#3a3631",
            activeText: "#f5f5f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];

/**
 * 给主题色**安全地**叠一层透明度。
 *
 * 🔴 别再用 `` `${theme.toolbar.panel}aa` `` 这种字符串拼接（用户 2026-11-17 报障：
 * 「脚本生成器在不同方案按钮切换时，按钮的显示会有问题」）。
 *
 * `toolbar.panel` 是 `rgba(31,29,26,.96)` —— 拼出来是 `rgba(31,29,26,.96)aa`，**非法 CSS**。
 * 浏览器的行为是「静默丢弃这条声明」，而 React 更新内联样式是逐条 `style.xxx = value`，
 * 于是元素**保留它上一次的合法背景**：被点过的方案按钮留着上次选中时的亮底（`activeText`），
 * 文字颜色却已经切成未选中的亮色 → 亮字压在亮底上，看起来就是一排「空的灰按钮」。
 * 从没被点过的按钮没有历史背景，所以只有它们是正常的。这也解释了「只有切换时才出问题」。
 *
 * 支持 `#rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba()`：hex 走 8 位 hex，函数式改第 4 个参数。
 * 认不出的值原样返回（宁可没有半透明，也不要写出非法声明）。
 */
export function withAlpha(color: string | null | undefined, alpha: number): string {
    const raw = String(color ?? "").trim();
    if (!raw) return "transparent";
    const ratio = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
    const alphaHex = Math.round(ratio * 255)
        .toString(16)
        .padStart(2, "0");
    const hex = /^#([0-9a-f]{3,8})$/i.exec(raw);
    if (hex) {
        let body = hex[1];
        // #rgb / #rgba 先展开成 6 / 8 位
        if (body.length === 3 || body.length === 4) {
            body = body
                .split("")
                .map((char) => char + char)
                .join("");
        }
        if (body.length === 6) return `#${body}${alphaHex}`;
        if (body.length === 8) return `#${body.slice(0, 6)}${alphaHex}`;
        return raw;
    }
    const fn = /^rgba?\(([^)]+)\)$/i.exec(raw);
    if (fn) {
        const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
        if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${ratio})`;
        return raw;
    }
    return raw;
}
