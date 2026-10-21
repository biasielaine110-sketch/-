import type { TextPromptEntry } from "@/constant/text-prompt-library";

/**
 * 分镜表（脚本节点）的**三套执行方案**。
 *
 * - `builtin`：预设自带的内置 system prompt / 任务书（改造前逐字一致）。
 * - `library`：改用「词库」里的三段提示词 —— 自定义提示词与分镜提示词都填
 *   「分镜表------首帧图和视频提示词」，资产提示词填「资产提取提示词」+「配合最佳拍档生图」。
 * - `x20`：同样走词库，但自定义提示词与分镜提示词换成
 *   「***********火_X20_主图分镜图_简洁版****************************」，资产提示词同上。
 *
 * ⚠️ 默认是 **`x20`**（2026-10-21 用户要求：02 分镜表默认第三套）。但 `resolveScriptSchemeId`
 * **只做归一化**，不承担默认值 —— 默认行为由 `resolveAutoApplyScriptScheme` 判定，组件在挂载后
 * 真的把三段预填进去。若把这里的默认值改成 `x20`，按钮会亮成第三套、而三个输入框还是空的，
 * 生成时照样走内置提示词，界面与行为对不上（这个坑第一版就踩过）。
 *
 * 为什么是「预填进那三个输入框」而不是另开一条注入通道：那三个字段本来就是这个节点的
 * 覆盖入口（`resolveScriptSystemPrompt` / `buildScriptGenerationPromptSections` 都读它们），
 * 预填之后用户可以照常打开弹窗改一两句，改完仍然生效 —— 方案只是「一键填好」，不是封闭开关。
 */
export type ScriptSchemeId = "builtin" | "library" | "x20";

/** 方案切换器的渲染顺序（第一套 → 第三套）。 */
export const SCRIPT_SCHEME_IDS = ["builtin", "library", "x20"] as const satisfies readonly ScriptSchemeId[];

/** 读方案：认不出 / 没设过一律按 `builtin` 渲染，默认值交给自动预填。 */
export function resolveScriptSchemeId(value: unknown): ScriptSchemeId {
    return value === "library" || value === "x20" ? value : "builtin";
}

/** 「从词库预填」的两套方案（第三套不在其中）。 */
export type ScriptLibrarySchemeId = Exclude<ScriptSchemeId, "builtin">;

/**
 * 方案在词库里找的三段提示词（按标题关键词匹配，needle 之间是「且」）。
 *
 * 标题是用户自己起的，写法不统一（`分镜表------首帧图和视频提示词` / `火_X20_主图分镜图_简洁版`），
 * 所以既去符号又只用「最能区分」的词，不锁死全名。
 */
export const SCRIPT_SCHEME_LIBRARY_NEEDLES = {
    /** 第二套 · 分镜表 · 首帧图和视频提示词 —— 同时填「自定义系统提示词」和「分镜提示词」。 */
    shot: ["分镜表", "首帧图和视频"],
    /** 第三套 · 火_X20_主图分镜图_简洁版 —— 同样一段两用。 */
    shotX20: ["主图分镜图", "x20"],
    /** 最佳短剧 · 资产提取提示词（两套方案共用） */
    assetExtract: ["资产提取"],
    /** 配合最佳拍档生图（两套方案共用） */
    assetPartner: ["最佳拍档"],
} as const;

/**
 * 标题归一：去空白 / 各种横线破折号 / 冒号点号 / 下划线 / 装饰星号井号，
 * 让 `分镜表------首帧图` 与 `分镜表-首帧图` 等价、`***火_X20_简洁版***` 与 `火X20简洁版` 等价。
 */
export function normalizePromptLibraryTitle(value: unknown): string {
    return String(value || "")
        .replace(/[\s\u3000]+/g, "")
        .replace(/[-—_－–—:：·•、,，.。_/／*＊#＃★☆◆◇■□]+/g, "")
        .toLowerCase();
}

/**
 * 从词库里挑一条：先精确相等 → 再「全部 needle 都出现在标题里」→ 最后退一步「任一 needle 命中」。
 * 启用中的条目优先（用户在设置里关掉的词条不该被方案偷偷用上）。
 */
export function resolvePromptLibraryEntry(entries: readonly TextPromptEntry[] | null | undefined, needles: readonly string[]): TextPromptEntry | null {
    const usable = (entries || []).filter((entry) => entry && typeof entry.content === "string" && entry.content.trim());
    if (!usable.length) return null;
    const wanted = needles.map((needle) => normalizePromptLibraryTitle(needle)).filter(Boolean);
    if (!wanted.length) return null;
    const ordered = [...usable].sort((left, right) => Number(right.enabled !== false) - Number(left.enabled !== false));
    const titleOf = (entry: TextPromptEntry) => normalizePromptLibraryTitle(entry.title);

    const exact = ordered.find((entry) => wanted.includes(titleOf(entry)));
    if (exact) return exact;
    const all = ordered.find((entry) => wanted.every((needle) => titleOf(entry).includes(needle)));
    if (all) return all;
    return ordered.find((entry) => wanted.some((needle) => titleOf(entry).includes(needle))) || null;
}

export type ScriptSchemePrefill = {
    /** 这次预填属于哪套方案（`library` / `x20`）。 */
    scheme: ScriptLibrarySchemeId;
    /** 「自定义系统提示词」（整段替换 system prompt） */
    system: string;
    /** 「资产提示词」（任务书里的资产专项要求） */
    asset: string;
    /** 「分镜提示词」（任务书里的分镜专项要求） */
    shot: string;
    /** 实际用到的词条标题，给 toast 显示「填了哪几段」 */
    titles: { system: string; asset: string[]; shot: string };
    /** 词库里没找到的段落（`system` / `asset` / `shot`），对应字段保持原样 */
    missing: Array<"system" | "asset" | "shot">;
};

/**
 * 两套「词库方案」的预填内容。
 *
 * 差异只有一处：自定义提示词 / 分镜提示词取哪一条 —— 第二套取「分镜表 · 首帧图和视频提示词」，
 * 第三套取「火_X20_主图分镜图_简洁版」；资产提示词两套完全一样（资产提取 + 配合最佳拍档生图）。
 *
 * 一段两用是用户明确要求的（自定义提示词与分镜提示词填同一条）；
 * 两段资产提示词用空行拼起来，避免两套要求粘成一句。
 */
export function buildScriptSchemePrefill(entries: readonly TextPromptEntry[] | null | undefined, scheme: ScriptLibrarySchemeId): ScriptSchemePrefill {
    const shotEntry = resolvePromptLibraryEntry(entries, scheme === "x20" ? SCRIPT_SCHEME_LIBRARY_NEEDLES.shotX20 : SCRIPT_SCHEME_LIBRARY_NEEDLES.shot);
    const extractEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.assetExtract);
    const partnerEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.assetPartner);

    const shot = shotEntry?.content?.trim() || "";
    // 两条资产提示词可能被同一个 needle 命中同一条目 —— 去重，别把同一段贴两遍。
    const assetParts = [extractEntry, partnerEntry]
        .filter((entry): entry is TextPromptEntry => Boolean(entry?.content?.trim()))
        .filter((entry, index, list) => list.findIndex((item) => item.content.trim() === entry.content.trim()) === index);

    const result: ScriptSchemePrefill = {
        scheme,
        system: shot,
        shot,
        asset: assetParts.map((entry) => entry.content.trim()).join("\n\n"),
        titles: {
            system: shotEntry?.title || "",
            shot: shotEntry?.title || "",
            asset: assetParts.map((entry) => entry.title),
        },
        missing: [],
    };
    if (!result.system) result.missing.push("system");
    if (!result.asset) result.missing.push("asset");
    if (!result.shot) result.missing.push("shot");
    return result;
}

/** 第二套（分镜表 · 首帧图和视频提示词）的预填。 */
export function buildScriptLibraryPrefill(entries: readonly TextPromptEntry[] | null | undefined): ScriptSchemePrefill {
    return buildScriptSchemePrefill(entries, "library");
}

/** 第三套（火_X20_主图分镜图_简洁版）的预填。 */
export function buildScriptX20Prefill(entries: readonly TextPromptEntry[] | null | undefined): ScriptSchemePrefill {
    return buildScriptSchemePrefill(entries, "x20");
}

/** 有效文本（去空白后非空）—— 只看「有没有人填过」，不关心内容。 */
function hasText(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * 这套方案「真的可用」吗 —— **只看能区分两套的那一段**（自定义提示词 / 分镜提示词）。
 *
 * ⚠️ 资产段不能作为判据：两套方案共用同两条资产词条，只要词库里有资产词条，两套的 `asset`
 * 就都有内容。若把它算进来，「第三套的分镜词条缺失、只剩资产段」会被判成第三套可用 ——
 * 而它填进去的东西与第二套完全一样，等于按钮写着第三套、实际跑第二套。这种只有资产段的
 * 残状态一律判为「不可用」，让判定继续往第二套 / 第一套回落。
 */
function hasSchemePrompt(prefill?: ScriptSchemePrefill | null): boolean {
    if (!prefill) return false;
    return hasText(prefill.system) || hasText(prefill.shot);
}

/**
 * 节点建好（或老节点第一次打开）时该**自动**套用哪套方案 —— 用户 2026-10-21 要求
 * 「02 分镜表默认选择第三套执行方案」，2026-10-19 的第二套退为「第三套词库缺失时的兜底」。
 *
 * 判断放在这里而不是组件里：这是纯逻辑（不依赖 React / 节点对象），可以拿探针把例外钉死；
 * 组件只负责「返回了方案 id 就落一次 patchMetadata」。
 *
 * 四条例外（任一命中就不自动套用）：
 *  1. `scheme` 已有值 —— 用户明确点过某一套，尊重选择（第一套也是合法选择，不是「没选」）；
 *  2. 三段提示词框里已经有人手填过 —— 「手动添加提示词」是用户点名的第三条路，优先级高于默认值；
 *  3. 两套词库方案都一段都取不到（**只认自定义 / 分镜那一段**，见 `hasSchemePrompt`）——
 *     切了等于没切，留在第一套（界面另有提示让他去补词库）；
 *  4. prefill 还没就绪（词库尚未从 store 拿到）—— 先不动，等它到了再判断。
 */
export function resolveAutoApplyScriptScheme(options: {
    scheme?: unknown;
    x20Prefill?: ScriptSchemePrefill | null;
    libraryPrefill?: ScriptSchemePrefill | null;
    customSystemPrompt?: unknown;
    customAssetPrompt?: unknown;
    customShotPrompt?: unknown;
}): ScriptLibrarySchemeId | null {
    if (hasText(options.scheme)) return null;
    if (hasText(options.customSystemPrompt) || hasText(options.customAssetPrompt) || hasText(options.customShotPrompt)) return null;
    if (hasSchemePrompt(options.x20Prefill)) return "x20";
    if (hasSchemePrompt(options.libraryPrefill)) return "library";
    return null;
}
