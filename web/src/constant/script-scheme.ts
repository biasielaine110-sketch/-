import type { TextPromptEntry } from "@/constant/text-prompt-library";

/**
 * 分镜表（脚本节点）的**两套执行方案**。
 *
 * - `builtin`：预设自带的内置 system prompt / 任务书（改造前逐字一致）。
 * - `library`：改用「词库」（设置页的文本节点词库，`config.textPrompts`）里的三段提示词——
 *   自定义系统提示词、资产提示词、分镜提示词各填一段。
 *
 * ⚠️ `builtin` 已经**不是默认值**了（2026-10-19 用户要求：默认走第二套词库）。默认行为由
 * `shouldAutoApplyScriptLibraryScheme` 判定：新建 / 未选过方案的节点会自动预填第二套。
 * `resolveScriptSchemeId` 只做归一化（读的时候认不出就按内置渲染），**不要**把它的默认值改成
 * `library` —— 那样按钮会亮成第二套、而三个输入框还是空的，界面与行为对不上。
 *
 * 为什么是「预填进那三个输入框」而不是另开一条注入通道：那三个字段本来就是这个节点的
 * 覆盖入口（`resolveScriptSystemPrompt` / `buildScriptGenerationPromptSections` 都读它们），
 * 预填之后用户可以照常打开弹窗改一两句，改完仍然生效 —— 方案只是「一键填好」，不是封闭开关。
 */
export type ScriptSchemeId = "builtin" | "library";

export function resolveScriptSchemeId(value: unknown): ScriptSchemeId {
    return value === "library" ? "library" : "builtin";
}

/**
 * 方案二在词库里找的三段提示词（按标题关键词匹配，needle 之间是「且」）。
 *
 * 标题是用户自己起的，写法不统一（`分镜表------首帧图和视频提示词` / `最佳短剧-资产提取提示词`），
 * 所以既去符号又只用「最能区分」的一两个词，不锁死全名。
 */
export const SCRIPT_SCHEME_LIBRARY_NEEDLES = {
    /** 分镜表 · 首帧图和视频提示词 —— 同时填「自定义系统提示词」和「分镜提示词」。 */
    shot: ["分镜表", "首帧图和视频"],
    /** 最佳短剧 · 资产提取提示词 */
    assetExtract: ["资产提取"],
    /** 配合最佳拍档生图 */
    assetPartner: ["最佳拍档"],
} as const;

/** 标题归一：去空白 / 各种横线破折号 / 冒号点号，让 `分镜表------首帧图` 与 `分镜表-首帧图` 等价。 */
export function normalizePromptLibraryTitle(value: unknown): string {
    return String(value || "")
        .replace(/[\s\u3000]/g, "")
        .replace(/[-—_－–—:：·•、,，.。]/g, "")
        .toLowerCase();
}

/**
 * 从词库里挑一条：先精确相等 → 再「全部 needle 都出现在标题里」→ 最后退一步「任一 needle 命中」。
 * 启用中的条目优先（用户在设置里关掉的词条不该被方案二偷偷用上）。
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

export type ScriptLibraryPrefill = {
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

const EMPTY_PREFILL: ScriptLibraryPrefill = {
    system: "",
    asset: "",
    shot: "",
    titles: { system: "", asset: [], shot: "" },
    missing: ["system", "asset", "shot"],
};

/**
 * 方案二的预填内容。
 *
 * 「分镜表 · 首帧图和视频提示词」**一段两用**（用户明确要求：自定义提示词与分镜提示词都填它）；
 * 「资产提示词」= 资产提取提示词 + 配合最佳拍档生图，两段用空行拼起来（避免两套要求粘成一句）。
 */
export function buildScriptLibraryPrefill(entries: readonly TextPromptEntry[] | null | undefined): ScriptLibraryPrefill {
    const shotEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.shot);
    const extractEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.assetExtract);
    const partnerEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.assetPartner);

    const shot = shotEntry?.content?.trim() || "";
    // 两条资产提示词可能被同一个 needle 命中同一条目 —— 去重，别把同一段贴两遍。
    const assetParts = [extractEntry, partnerEntry]
        .filter((entry): entry is TextPromptEntry => Boolean(entry?.content?.trim()))
        .filter((entry, index, list) => list.findIndex((item) => item.content.trim() === entry.content.trim()) === index);

    const result: ScriptLibraryPrefill = {
        ...EMPTY_PREFILL,
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

/** 有效文本（去空白后非空）—— 只看「有没有人填过」，不关心内容。 */
function hasText(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * 是否该**自动**套用第二套（词库）—— 用户 2026-10-19 要求「分镜表生成默认选择第二套词库的方案，
 * 需要调整再自行选择第一套或者手动添加提示词」。
 *
 * 判断放在这里而不是组件里：这是纯逻辑（不依赖 React / 节点对象），可以拿探针把四种例外钉死；
 * 组件只负责「返回 true 就落一次 patchMetadata」。
 *
 * 四条例外（任一命中就不自动套用）：
 *  1. `scheme` 已有值 —— 用户明确点过第一套或第二套，尊重选择（第一套也是合法选择，不是「没选」）；
 *  2. 词库三段一段都取不到 —— 切了等于没切，留在第一套（界面另有提示让他去补词库）；
 *  3. 三个提示词框里已经有人手填过 —— 「手动添加提示词」是用户点名的第三条路，优先级高于默认值；
 *  4. 传空 prefill —— 词库还没加载出来时先不动，等它到了再判断。
 */
export function shouldAutoApplyScriptLibraryScheme(options: {
    scheme?: unknown;
    prefill?: ScriptLibraryPrefill | null;
    customSystemPrompt?: unknown;
    customAssetPrompt?: unknown;
    customShotPrompt?: unknown;
}): boolean {
    if (hasText(options.scheme)) return false;
    const prefill = options.prefill;
    if (!prefill) return false;
    if (!hasText(prefill.system) && !hasText(prefill.asset) && !hasText(prefill.shot)) return false;
    if (hasText(options.customSystemPrompt) || hasText(options.customAssetPrompt) || hasText(options.customShotPrompt)) return false;
    return true;
}
