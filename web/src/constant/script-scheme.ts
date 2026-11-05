import type { TextPromptEntry } from "@/constant/text-prompt-library";

/**
 * 分镜表（脚本节点）的**六套执行方案**。
 *
 * - `builtin`：预设自带的内置 system prompt / 任务书（改造前逐字一致）。
 * - `library`：改用「词库」里的三段提示词 —— 自定义提示词与分镜提示词都填
 *   「分镜表------首帧图和视频提示词」，资产提示词填「资产提取提示词」+「配合最佳拍档生图」。
 * - `x20`：同样走词库，但自定义提示词与分镜提示词换成
 *   「***********火_X20_主图分镜图_简洁版****************************」，资产提示词同上。
 * - `director`：第四套 · 影视分镜导演 —— 自定义提示词与分镜提示词都填
 *   「***********# Role: 影视分镜导演 ****************************」，资产提示词同上（资产两段各套共用）。
 *   这一套的输出形态与前几套不同（`**主体与动作提示词：**` / `**独立风格提示词：**`、
 *   视频段用 `- **景别／机位：**` 这种字段，冒号在加粗里面），解析侧已按同一套标签认
 *   （见 `story-script.ts` 的 `STORY_SCRIPT_TEMPLATE_KNOWN_LABELS`）。
 * - `muse`：第五套 · muse 长视频（2026-11-05 用户要求）—— 自定义提示词与分镜提示词都填
 *   「---------muse-长视频-------」，资产提示词同上（资产两段各套共用）。
 *   这一套的 `视频运动提示词` 不是八段标签块，而是**整段 10 秒视频脚本**：
 *   `### 视频一（10秒）` + `文生视频，16:9 横屏，时长 10 秒。…` + `角色设定：` /
 *   `共享环境与光线：` / `时间轴：`（`- 0—3 秒：…`）/ `Negative prompt：`。
 *   解析侧为此单独放行了两件事（见 `story-script.ts`）：
 *   ① 小标题 `### 视频一（10秒）` 不再被当「不认识的标题」丢掉；
 *   ② 块里显式写了 `- **视频运动提示词**：` 时以它为准，不再被 `景别` 那几行拼出来的摘要顶掉。
 * - `ghost`：第六套 · 鬼怪-----光影全流程（2026-11-05 用户要求）—— 自定义提示词与分镜提示词
 *   **不来自词库，运行时从画布「技能」库里按标题取那份 doc 技能的正文**（`systemHint`），
 *   资产提示词仍走词库（各套共用）。⚠️ 技能正文**绝不写死在代码里**：用户在画布里改技能内容，
 *   这一套的预填自动跟着变；没装这条技能时三段保持原样，不偷偷回落到别的方案。
 *   这一套的 `视频运动提示词` 是「光影全流程」分镜脚本：`————————————` 分隔 +
 *   `镜头八｜25.00—30.00秒` + 逐时间段 `25.00—26.20秒：` + 结尾 `【全片光影与空气】` /
 *   `【声音】` / `【结束连续性】` 三块（见 `story-script.ts` 的 `STORY_SCRIPT_GHOST_VIDEO_FORMAT`）。
 *
 * ⚠️ 默认是 **`director`（第四套）**（2026-10-23 用户要求：01 分镜表默认走第四套；词库里没有
 * 影视分镜导演那一条时回落第二套 `library`；都没有则停在内置）。`resolveScriptSchemeId`
 * **只做归一化**，不承担默认值 —— 默认行为由 `resolveAutoApplyScriptScheme` 判定，组件在挂载后
 * 真的把三段预填进去。若把这里的默认值改成 `director`，按钮会亮成第四套、而三个输入框还是空的，
 * 生成时照样走内置提示词，界面与行为对不上（这个坑第一版就踩过）。
 * 第五 / 第六套同样**只手点、不进自动判定**。
 *
 * 为什么是「预填进那三个输入框」而不是另开一条注入通道：那三个字段本来就是这个节点的
 * 覆盖入口（`resolveScriptSystemPrompt` / `buildScriptGenerationPromptSections` 都读它们），
 * 预填之后用户可以照常打开弹窗改一两句，改完仍然生效 —— 方案只是「一键填好」，不是封闭开关。
 */
export type ScriptSchemeId = "builtin" | "library" | "x20" | "director" | "muse" | "ghost";

/** 方案切换器的渲染顺序（第一套 → 第六套）。 */
export const SCRIPT_SCHEME_IDS = ["builtin", "library", "x20", "director", "muse", "ghost"] as const satisfies readonly ScriptSchemeId[];

/** 读方案：认不出 / 没设过一律按 `builtin` 渲染，默认值交给自动预填。 */
export function resolveScriptSchemeId(value: unknown): ScriptSchemeId {
    return value === "library" || value === "x20" || value === "director" || value === "muse" || value === "ghost" ? value : "builtin";
}

/** 「有预填内容」的几套方案（第一套不在其中）。 */
export type ScriptLibrarySchemeId = Exclude<ScriptSchemeId, "builtin">;

/**
 * 方案在词库里找的三段提示词（按标题关键词匹配，needle 之间是「且」）。
 *
 * 标题是用户自己起的，写法不统一（`分镜表------首帧图和视频提示词` / `火_X20_主图分镜图_简洁版` /
 * `***********# Role: 影视分镜导演 ****************************`），
 * 所以既去符号又只用「最能区分」的词，不锁死全名。
 */
export const SCRIPT_SCHEME_LIBRARY_NEEDLES = {
    /** 第二套 · 分镜表 · 首帧图和视频提示词 —— 同时填「自定义系统提示词」和「分镜提示词」。 */
    shot: ["分镜表", "首帧图和视频"],
    /** 第三套 · 火_X20_主图分镜图_简洁版 —— 同样一段两用。 */
    shotX20: ["主图分镜图", "x20"],
    /**
     * 第四套 · 影视分镜导演 —— 同样一段两用。
     * 用户那条的标题是 `***********# Role: 影视分镜导演 ****************************`，
     * 归一后是 `role影视分镜导演`，所以只认「影视分镜导演」这五个字，`role` 有没有都行。
     */
    shotDirector: ["影视分镜导演"],
    /**
     * 第五套 · muse-长视频 —— 同样一段两用。
     * 用户那条的标题是 `---------muse-长视频-------`，归一后 `muse长视频`。
     * 两个 needle 是为了**优先**命中「muse + 长视频」那一条（`muse` 单独太泛，词库里可能还有别的 muse 条目）；
     * 和别的方案一样，`resolvePromptLibraryEntry` 最后有一层「任一 needle 命中」兜底 ——
     * 词库里只剩 `muse-短视频` 这种条目时仍会被用上，总比切过去是空的好。
     */
    shotMuse: ["muse", "长视频"],
    /** 最佳短剧 · 资产提取提示词（第二 / 三 / 四 / 五 / 六套方案共用） */
    assetExtract: ["资产提取"],
    /** 配合最佳拍档生图（第二 / 三 / 四 / 五 / 六套方案共用） */
    assetPartner: ["最佳拍档"],
} as const;

/** 第六套在**技能库**（不是词库）里按标题找的那条：`鬼怪-----光影全流程`。 */
export const SCRIPT_SCHEME_SKILL_NEEDLES = {
    shotGhost: ["鬼怪", "光影全流程"],
} as const;

/**
 * 标题归一：去空白 / 各种横线破折号 / 冒号点号 / 下划线 / 装饰星号井号 / 全角竖线，
 * 让 `分镜表------首帧图` 与 `分镜表-首帧图` 等价、`***火_X20_简洁版***` 与 `火X20简洁版` 等价、
 * `***********# Role: 影视分镜导演 ***` 与 `role影视分镜导演` 等价、
 * `鬼怪-----光影全流程` 与 `鬼怪光影全流程` 等价。
 */
export function normalizePromptLibraryTitle(value: unknown): string {
    return String(value || "")
        .replace(/[\s\u3000]+/g, "")
        .replace(/[-—_－–—:：·•、,，.。_/／*＊#＃★☆◆◇■□｜|]+/g, "")
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

/**
 * 第六套的技能来源 —— 结构化类型，故意只声明用得到的几个字段：
 * `LocalSkillPack`（`@/lib/chat-skill-pack`）天然兼容，这样常量文件不必 import
 * zustand store / i18n，探针在 headless 下也能直接喂假数据。
 *
 * doc 技能（SKILL.md 导入）的整篇规程就存在 `systemHint`；工具包也可能带一句
 * `systemHint`，但那种不是「光影全流程」正文，所以匹配按标题 needle 优先。
 */
export type ScriptSchemeSkillSource = {
    id?: string;
    name?: string;
    alias?: string;
    systemHint?: string;
};

/**
 * 运行时从画布技能库按标题取「鬼怪-----光影全流程」的正文 —— **不写入任何提示词全文**。
 *
 * 三级命中与词库同口径（exact → 全部 needle → 任一 needle），并按「别名 / 名字 / id」
 * 一起归一后比对：用户给技能改了备注名（alias）也能找到。找不到就返回空，
 * 让三个字段保持原样（绝不偷偷拿第二套词库的内容顶上）。
 */
export function resolveGhostSkillPrompt(skills: readonly ScriptSchemeSkillSource[] | null | undefined): { text: string; title: string } {
    const empty = { text: "", title: "" };
    const wanted = SCRIPT_SCHEME_SKILL_NEEDLES.shotGhost.map(normalizePromptLibraryTitle).filter(Boolean);
    const usable = (skills || []).filter((item) => item && typeof item.systemHint === "string" && item.systemHint.trim());
    if (!usable.length || !wanted.length) return empty;
    const labelOf = (item: ScriptSchemeSkillSource) => normalizePromptLibraryTitle(`${item.alias || ""}${item.name || ""}${item.id || ""}`);
    const exact = usable.find((item) => wanted.includes(labelOf(item)));
    const all = exact || usable.find((item) => wanted.every((needle) => labelOf(item).includes(needle)));
    const hit = all || usable.find((item) => wanted.some((needle) => labelOf(item).includes(needle)));
    if (!hit) return empty;
    return {
        text: String(hit.systemHint || "").trim(),
        title: String(hit.alias || hit.name || hit.id || "").trim(),
    };
}

export type ScriptSchemePrefill = {
    /** 这次预填属于哪套方案（`library` / `x20` / `director` / `muse` / `ghost`）。 */
    scheme: ScriptLibrarySchemeId;
    /** 「自定义系统提示词」（整段替换 system prompt） */
    system: string;
    /** 「资产提示词」（任务书里的资产专项要求） */
    asset: string;
    /** 「分镜提示词」（任务书里的分镜专项要求） */
    shot: string;
    /** 实际用到的词条 / 技能标题，给 toast 显示「填了哪几段」 */
    titles: { system: string; asset: string[]; shot: string };
    /** 没找到的段落（`system` / `asset` / `shot`），对应字段保持原样 */
    missing: Array<"system" | "asset" | "shot">;
};

/** 每套方案取「自定义 / 分镜」那一段用的 needle（互不串味）。 */
function shotNeedlesOf(scheme: ScriptLibrarySchemeId): readonly string[] {
    if (scheme === "x20") return SCRIPT_SCHEME_LIBRARY_NEEDLES.shotX20;
    if (scheme === "director") return SCRIPT_SCHEME_LIBRARY_NEEDLES.shotDirector;
    if (scheme === "muse") return SCRIPT_SCHEME_LIBRARY_NEEDLES.shotMuse;
    // 第六套的自定义 / 分镜来自**技能**不是词库 —— 返回空 needle，误调也绝不会串到第二套词条。
    if (scheme === "ghost") return [];
    return SCRIPT_SCHEME_LIBRARY_NEEDLES.shot;
}

/** 两条资产提示词拼起来（去重，避免同一 needle 命中同一条贴两遍）。 */
function collectAssetParts(entries: readonly TextPromptEntry[] | null | undefined): TextPromptEntry[] {
    const extractEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.assetExtract);
    const partnerEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.assetPartner);
    return [extractEntry, partnerEntry]
        .filter((entry): entry is TextPromptEntry => Boolean(entry?.content?.trim()))
        .filter((entry, index, list) => list.findIndex((item) => item.content.trim() === entry.content.trim()) === index);
}

/**
 * 各套「词库方案」的预填内容。
 *
 * 差异只有一处：自定义提示词 / 分镜提示词取哪一条 —— 第二套取「分镜表 · 首帧图和视频提示词」，
 * 第三套取「火_X20_主图分镜图_简洁版」，第四套取「影视分镜导演」，第五套取「muse-长视频」；
 * 资产提示词各套完全一样（资产提取 + 配合最佳拍档生图）。
 * ⚠️ 第六套不走这里 —— 见 `buildScriptGhostPrefill`（来源是技能，不是词库）。
 *
 * 一段两用是用户明确要求的（自定义提示词与分镜提示词填同一条）；
 * 两段资产提示词用空行拼起来，避免两套要求粘成一句。
 */
export function buildScriptSchemePrefill(entries: readonly TextPromptEntry[] | null | undefined, scheme: ScriptLibrarySchemeId): ScriptSchemePrefill {
    const shotEntry = resolvePromptLibraryEntry(entries, shotNeedlesOf(scheme));
    const assetParts = collectAssetParts(entries);

    const shot = shotEntry?.content?.trim() || "";
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

/**
 * 第六套（鬼怪 · 光影全流程）的预填：自定义 / 分镜 ← 画布技能库那条 doc 技能的正文，
 * 资产 ← 词库两条（与各套共用）。技能没装 / 没正文时只报 missing，不回落。
 */
export function buildScriptGhostPrefill(
    entries: readonly TextPromptEntry[] | null | undefined,
    skills: readonly ScriptSchemeSkillSource[] | null | undefined,
): ScriptSchemePrefill {
    const skill = resolveGhostSkillPrompt(skills);
    const assetParts = collectAssetParts(entries);
    const result: ScriptSchemePrefill = {
        scheme: "ghost",
        system: skill.text,
        shot: skill.text,
        asset: assetParts.map((entry) => entry.content.trim()).join("\n\n"),
        titles: {
            system: skill.title,
            shot: skill.title,
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

/** 第四套（影视分镜导演）的预填。 */
export function buildScriptDirectorPrefill(entries: readonly TextPromptEntry[] | null | undefined): ScriptSchemePrefill {
    return buildScriptSchemePrefill(entries, "director");
}

/** 第五套（muse-长视频）的预填。 */
export function buildScriptMusePrefill(entries: readonly TextPromptEntry[] | null | undefined): ScriptSchemePrefill {
    return buildScriptSchemePrefill(entries, "muse");
}

/** 有效文本（去空白后非空）—— 只看「有没有人填过」，不关心内容。 */
function hasText(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * 这套方案「真的可用」吗 —— **只看能区分各套的那一段**（自定义提示词 / 分镜提示词）。
 *
 * ⚠️ 资产段不能作为判据：几套方案共用同两条资产词条，只要词库里有资产词条，各套的 `asset`
 * 就都有内容。若把它算进来，「第四套的分镜词条缺失、只剩资产段」会被判成第四套可用 ——
 * 而它填进去的东西与第二套完全一样，等于按钮写着第四套、实际跑第二套。这种只有资产段的
 * 残状态一律判为「不可用」，让判定继续往下一套 / 第一套回落。
 */
function hasSchemePrompt(prefill?: ScriptSchemePrefill | null): boolean {
    if (!prefill) return false;
    return hasText(prefill.system) || hasText(prefill.shot);
}

/**
 * 节点建好（或老节点第一次打开）时该**自动**套用哪套方案 —— 用户 2026-10-23 要求
 * 「01 分镜表默认使用第四套执行方案（影视分镜导演），要换由用户自己选」。
 *
 * 默认优先级：**第四套 `director` → 第二套 `library` → 不预填（留在第一套内置）**。
 * 第四套排在最前是用户点名的默认；回落第二套只发生在「词库里没有影视分镜导演那一条」时
 * —— 那不是「换了方案」，而是「这套根本没有词可用」，停在第一套会让明明能用词库的用户
 * 白白退回内置提示词。
 *
 * ⚠️ **选定的方案内部不做跨方案回落**（2026-10-23 用户追加口径）：某一套在词库里缺内容时
 * 该段直接用**第一套内置提示词**（= 字段留空，见 `resolveScriptSystemPrompt` /
 * `buildScriptGenerationPromptSections`），绝不把该套的某一段偷偷换成另一套的句子。
 *
 * 判断放在这里而不是组件里：这是纯逻辑（不依赖 React / 节点对象），可以拿探针把例外钉死；
 * 组件只负责「返回了方案 id 就落一次 patchMetadata」。
 *
 * 四条例外（任一命中就不自动套用）：
 *  1. `scheme` 已有值 —— 用户明确点过某一套，尊重选择（第一套也是合法选择，不是「没选」）；
 *  2. 三段提示词框里已经有人手填过 —— 「手动添加提示词」是用户点名的第三条路，优先级高于默认值；
 *  3. 几套在词库里都缺「自定义 / 分镜」那一段（见 `hasSchemePrompt`）—— 没有可预填的内容，
 *     留在第一套（界面另提示去补词库）；
 *  4. prefill 还没就绪（词库尚未从 store 拿到）—— 先不动，等它到了再判断。
 *
 * 注意：**没有「老节点迁移」**。10-19 那版把 `library` 写进 metadata 的节点，仍是合法的第二套，
 * 不必也不能再迁到别的方案（那会把用户看到/用着的方案偷偷换掉）。
 */
export function resolveAutoApplyScriptScheme(options: {
    scheme?: unknown;
    directorPrefill?: ScriptSchemePrefill | null;
    x20Prefill?: ScriptSchemePrefill | null;
    libraryPrefill?: ScriptSchemePrefill | null;
    customSystemPrompt?: unknown;
    customAssetPrompt?: unknown;
    customShotPrompt?: unknown;
}): ScriptLibrarySchemeId | null {
    if (hasText(options.scheme)) return null;
    if (hasText(options.customSystemPrompt) || hasText(options.customAssetPrompt) || hasText(options.customShotPrompt)) return null;
    // 第四套（影视分镜导演）是当前默认；词库里没这条才退第二套。第五 / 六套只手点，不参与。
    if (hasSchemePrompt(options.directorPrefill)) return "director";
    if (hasSchemePrompt(options.libraryPrefill)) return "library";
    return null;
}
