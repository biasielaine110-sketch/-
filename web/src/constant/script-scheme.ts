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
 *   `### 视频一（10秒）` + `参考生视频，16:9 横屏，时长 10 秒，人物与场景以已给的设定图为准。…` +
 *   `共享环境与光线：` / `时间轴：`（`- 0—3 秒：…`）/ `Negative prompt：`。
 *   ⚠️ 2026-11-06 改口径：这一套走**参考生视频**（用户已给设定图），首句不再是「文生视频」，
 *   并且**整段不写 `角色设定：`** —— 人物外形由参考图决定。
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
 * - `moman`：第七套 · 剧本转分镜15秒（不固定为15秒镜头时长）-魔漫（2026-11-06 用户要求）——
 *   三段来源**各不相同**：自定义系统提示词 ← **词库**同名条目；分镜提示词 ← **技能库**同名 doc 技能正文；
 *   资产提示词仍走词库（各套共用）。见 `buildScriptMomanPrefill`。
 *   这一套的 `视频运动提示词` 是**按时间码分段的 JSON 分镜**里 `prompt` 字段那种形态：
 *   `0.00—1.50：【局部特写，微幅下移】…` 一段一行、覆盖整段时长（见 `STORY_SCRIPT_MOMAN_VIDEO_FORMAT`）；
 *   模型若直接把 storyboard JSON 吐回来，解析侧按 `prompt` 整段填入（`parseMomanStoryboardRows`）。
 * - `mashu`：第八套 · 麻薯------优化镜头，音色，光影空气版（2026-11-06 用户要求）——
 *   与第七套同为「三段来源各不相同」（自定义 ← 词库、分镜 ← 技能库、资产 ← 词库），见 `buildScriptMashuPrefill`。
 *   这一套的 `视频运动提示词` 是**「分镜组」脚本**：`### 【分镜组N】（起—止秒）` + 组级四块
 *   （`【人物年龄与真人声音锚定】` / `【核心静态画面】` / `【全局光影与空气】` / `【导演与场次参考】`）
 *   + 组内逐镜 `镜头 N:` + `持续时间:` + `景别与运镜:` + `场景与配音:`（其下十个 `【…】` 块）
 *   + 每镜一行 `[环境音效(SFX)：…]`（见 `STORY_SCRIPT_MASHU_VIDEO_FORMAT`）。
 *   ⚠️ 这一套**切过去就顺手把「每镜时长」设成 15 秒**（用户 2026-11-06 明确要求）——
 *   一个分镜组正好就是一行 15 秒的成片，组内 2~5 个镜头相加凑满 15 秒。
 *
 * ⚠️ 默认是 **`director`（第四套）**（2026-10-23 用户要求：01 分镜表默认走第四套；词库里没有
 * 影视分镜导演那一条时回落第二套 `library`；都没有则停在内置）。`resolveScriptSchemeId`
 * **只做归一化**，不承担默认值 —— 默认行为由 `resolveAutoApplyScriptScheme` 判定，组件在挂载后
 * 真的把三段预填进去。若把这里的默认值改成 `director`，按钮会亮成第四套、而三个输入框还是空的，
 * 生成时照样走内置提示词，界面与行为对不上（这个坑第一版就踩过）。
 * 第五 / 第六 / 第七 / 第八套同样**只手点、不进自动判定**。
 *
 * 为什么是「预填进那三个输入框」而不是另开一条注入通道：那三个字段本来就是这个节点的
 * 覆盖入口（`resolveScriptSystemPrompt` / `buildScriptGenerationPromptSections` 都读它们），
 * 预填之后用户可以照常打开弹窗改一两句，改完仍然生效 —— 方案只是「一键填好」，不是封闭开关。
 */
export type ScriptSchemeId = "builtin" | "library" | "x20" | "director" | "muse" | "ghost" | "moman" | "mashu";

/** 方案切换器的渲染顺序（第一套 → 第八套）。 */
export const SCRIPT_SCHEME_IDS = ["builtin", "library", "x20", "director", "muse", "ghost", "moman", "mashu"] as const satisfies readonly ScriptSchemeId[];

/** 读方案：认不出 / 没设过一律按 `builtin` 渲染，默认值交给自动预填。 */
export function resolveScriptSchemeId(value: unknown): ScriptSchemeId {
    return value === "library" || value === "x20" || value === "director" || value === "muse" || value === "ghost" || value === "moman" || value === "mashu" ? value : "builtin";
}

/**
 * **严格**读方案 id：不在 `SCRIPT_SCHEME_IDS` 里就是 `null`（= 没选），**不**回落 `builtin`。
 *
 * 和 `resolveScriptSchemeId` 的分工：那个是「渲染用」，认不出就当第一套（界面总得亮一个）；
 * 这个是「用户到底点没点过」的判断，必须能区分「空」与「明确选了第一套」——
 * 否则 03 弹窗里没选方案会被当成「用户要内置提示词」，第四套默认就失效了。
 */
export function asScriptSchemeId(value: unknown): ScriptSchemeId | null {
    const id = typeof value === "string" ? value.trim() : "";
    return (SCRIPT_SCHEME_IDS as readonly string[]).includes(id) ? (id as ScriptSchemeId) : null;
}

/**
 * 第 1~6 套方案执行时**默认的「视频分段」= 每 4 镜一段**（用户 2026-11-07 明确要求）。
 *
 * 为什么是「切方案时顺手写一次 metadata」而不是改「视频分段」的默认渲染值：
 * `resolveStoryScriptMergeMode` 只做归一化（脏值 → `shot`），它同时被铺链路、表体预览、
 * 分段时长任务书读，把默认值改在那里会让**所有**老节点（含第 7 / 8 套）一起变成每 4 镜一段。
 * 这里的口径是「这套方案默认这么铺」，所以只在这一套被真正应用时落库，用户之后仍可随手改回单镜。
 *
 * 第 7 / 8 套（`moman` / `mashu`）**不在此列**：
 *  - `moman` 是「按时间码分段」的 JSON 分镜，一行本身的时长就不定长；
 *  - `mashu` 一行就是一个 15 秒分镜组（组内 2~5 个镜头），再叠一层「每 4 镜一段」会把自己的
 *    分段口径顶掉（它切过去只改「每镜时长」，见 `applyScheme` 注释）。
 */
export const SCRIPT_SCHEME_DEFAULT_MERGE_MODE = "4" as const;

/** 这套方案要不要顺手把「视频分段」设成每 4 镜一段（第 7 / 8 套返回 `null` = 不动）。 */
export function resolveSchemeDefaultMergeMode(scheme: unknown): typeof SCRIPT_SCHEME_DEFAULT_MERGE_MODE | null {
    const id = resolveScriptSchemeId(scheme);
    return id === "moman" || id === "mashu" ? null : SCRIPT_SCHEME_DEFAULT_MERGE_MODE;
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
    /**
     * 第七套 · 剧本转分镜15秒（不固定为15秒镜头时长）-魔漫 —— **自定义系统提示词**取这一条；
     * 同一标题的**分镜提示词**来自技能库（见 `SCRIPT_SCHEME_SKILL_NEEDLES.shotMoman`），
     * 两处来源不同是用户 2026-11-06 点名的口径。
     * 归一后标题是 `剧本转分镜15秒不固定为15秒镜头时长魔漫`，两个 needle 都要在。
     */
    shotMoman: ["剧本转分镜", "魔漫"],
    /**
     * 第八套 · 麻薯------优化镜头，音色，光影空气版 —— **自定义系统提示词**取这一条；
     * 同一标题的**分镜提示词**来自技能库（见 `SCRIPT_SCHEME_SKILL_NEEDLES.shotMashu`）。
     * 归一后标题是 `麻薯优化镜头音色光影空气版`，两个 needle 都要在。
     */
    shotMashu: ["麻薯", "光影空气"],
    /** 最佳短剧 · 资产提取提示词（第二 ~ 第八套方案共用） */
    assetExtract: ["资产提取"],
    /** 配合最佳拍档生图（第二 ~ 第八套方案共用） */
    assetPartner: ["最佳拍档"],
} as const;

/** 第六 / 第七 / 第八套在**技能库**（不是词库）里按标题找的那条。 */
export const SCRIPT_SCHEME_SKILL_NEEDLES = {
    /** 第六套：`鬼怪-----光影全流程` */
    shotGhost: ["鬼怪", "光影全流程"],
    /** 第七套：`剧本转分镜15秒（不固定为15秒镜头时长）-魔漫`（填「分镜提示词」） */
    shotMoman: ["剧本转分镜", "魔漫"],
    /** 第八套：`麻薯------优化镜头，音色，光影空气版`（填「分镜提示词」） */
    shotMashu: ["麻薯", "光影空气"],
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
export function resolveSchemeSkillPrompt(
    skills: readonly ScriptSchemeSkillSource[] | null | undefined,
    needles: readonly string[],
): { text: string; title: string } {
    const empty = { text: "", title: "" };
    const wanted = needles.map(normalizePromptLibraryTitle).filter(Boolean);
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

/** 第六套：技能库里的「鬼怪-----光影全流程」。 */
export function resolveGhostSkillPrompt(skills: readonly ScriptSchemeSkillSource[] | null | undefined): { text: string; title: string } {
    return resolveSchemeSkillPrompt(skills, SCRIPT_SCHEME_SKILL_NEEDLES.shotGhost);
}

/** 第七套：技能库里的「剧本转分镜15秒（不固定为15秒镜头时长）-魔漫」，只填「分镜提示词」。 */
export function resolveMomanSkillPrompt(skills: readonly ScriptSchemeSkillSource[] | null | undefined): { text: string; title: string } {
    return resolveSchemeSkillPrompt(skills, SCRIPT_SCHEME_SKILL_NEEDLES.shotMoman);
}

/** 第八套：技能库里的「麻薯------优化镜头，音色，光影空气版」，只填「分镜提示词」。 */
export function resolveMashuSkillPrompt(skills: readonly ScriptSchemeSkillSource[] | null | undefined): { text: string; title: string } {
    return resolveSchemeSkillPrompt(skills, SCRIPT_SCHEME_SKILL_NEEDLES.shotMashu);
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
    // 第七套：自定义系统提示词取词库这一条（分镜提示词另有来源 —— 技能库，见 buildScriptMomanPrefill）。
    if (scheme === "moman") return SCRIPT_SCHEME_LIBRARY_NEEDLES.shotMoman;
    // 第八套：同第七套，自定义系统提示词取词库（分镜提示词来自技能库，见 buildScriptMashuPrefill）。
    if (scheme === "mashu") return SCRIPT_SCHEME_LIBRARY_NEEDLES.shotMashu;
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
 * ⚠️ 第七 / 第八套也不走这里 —— 见 `buildScriptMomanPrefill` / `buildScriptMashuPrefill`
 * （system 与 shot 来源不同，不能被「一段两用」合并）。
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

/**
 * 第七套（剧本转分镜15秒 · 魔漫）的预填 —— **三段来源各不相同**（用户 2026-11-06 点名）：
 *   ① 自定义系统提示词 ← **词库**「剧本转分镜15秒（不固定为15秒镜头时长）-魔漫」；
 *   ② 资产提示词 ← 词库「最佳短剧-资产提取提示词」+「配合最佳拍档生图」（与其它套共用）；
 *   ③ 分镜提示词 ← **技能库**同名 doc 技能的正文（运行时按标题取，代码里不写死）。
 *
 * ⚠️ 别把它改写成「一段两用」（`buildScriptSchemePrefill` 的口径）：这一套的 system 与 shot
 * 是两条不同来源的内容，合并会让技能正文顶掉词库那段 system。
 */
export function buildScriptMomanPrefill(
    entries: readonly TextPromptEntry[] | null | undefined,
    skills: readonly ScriptSchemeSkillSource[] | null | undefined,
): ScriptSchemePrefill {
    const systemEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.shotMoman);
    const skill = resolveMomanSkillPrompt(skills);
    const assetParts = collectAssetParts(entries);
    const result: ScriptSchemePrefill = {
        scheme: "moman",
        system: systemEntry?.content?.trim() || "",
        shot: skill.text,
        asset: assetParts.map((entry) => entry.content.trim()).join("\n\n"),
        titles: {
            system: systemEntry?.title || "",
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

/**
 * 第八套（麻薯 · 优化镜头 / 音色 / 光影空气版）的预填 —— 与第七套同构，**三段来源各不相同**：
 *   ① 自定义系统提示词 ← **词库**「麻薯------优化镜头，音色，光影空气版」；
 *   ② 资产提示词 ← 词库「最佳短剧-资产提取提示词」+「配合最佳拍档生图」（与其它套共用）；
 *   ③ 分镜提示词 ← **技能库**同名 doc 技能的正文（运行时按标题取，代码里不写死）。
 *
 * 与第七套的唯一差别是 needle 不同（麻薯 / 光影空气），所以**不能**直接复用 `buildScriptMomanPrefill`
 * —— 那会拿「剧本转分镜 + 魔漫」去匹配，第八套永远命中不到自己的词条。
 */
export function buildScriptMashuPrefill(
    entries: readonly TextPromptEntry[] | null | undefined,
    skills: readonly ScriptSchemeSkillSource[] | null | undefined,
): ScriptSchemePrefill {
    const systemEntry = resolvePromptLibraryEntry(entries, SCRIPT_SCHEME_LIBRARY_NEEDLES.shotMashu);
    const skill = resolveMashuSkillPrompt(skills);
    const assetParts = collectAssetParts(entries);
    const result: ScriptSchemePrefill = {
        scheme: "mashu",
        system: systemEntry?.content?.trim() || "",
        shot: skill.text,
        asset: assetParts.map((entry) => entry.content.trim()).join("\n\n"),
        titles: {
            system: systemEntry?.title || "",
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

// ── 「跟随词库」：生成时**按此刻的词库**解析三段，而不是读节点上那份快照 ────────────────

/** 三段提示词的字段名（与节点 metadata 一一对应）。 */
export type ScriptPromptField = "system" | "asset" | "shot";

/**
 * 某一段是否被用户**固定**过（在「自定义提示词」弹窗里改成与词库不同的内容并保存）。
 * `true` = 用节点上那份；缺省 / `false` = 跟随词库（用户改词库，下次生成自动用新的）。
 */
export type ScriptPromptPins = Partial<Record<ScriptPromptField, boolean>>;

/** 三段的取值（空串 = 这一段没有内容，由调用方回落到预设内置）。 */
export type ScriptPromptValues = Record<ScriptPromptField, string>;

/**
 * 这套方案**此刻**的预填 —— 第一套没有预填（返回 `null`），其余七套各走各的来源。
 *
 * 与 `buildScriptSchemePrefill` 的区别只是「按 scheme 分发」：
 * 第六 / 第七 / 第八套的三段来源互不相同（自定义 ← 词库、分镜 ← 技能库、资产 ← 词库），
 * 所以必须走各自的 builder，不能一律 `buildScriptSchemePrefill`（那会把 ghost 匹到第二套词条上）。
 */
export function buildScriptSchemePrefillLive(
    scheme: unknown,
    entries: readonly TextPromptEntry[] | null | undefined,
    skills?: readonly ScriptSchemeSkillSource[] | null,
): ScriptSchemePrefill | null {
    const id = resolveScriptSchemeId(scheme);
    if (id === "builtin") return null;
    if (id === "ghost") return buildScriptGhostPrefill(entries, skills);
    if (id === "moman") return buildScriptMomanPrefill(entries, skills);
    if (id === "mashu") return buildScriptMashuPrefill(entries, skills);
    return buildScriptSchemePrefill(entries, id);
}

/**
 * 生成时三段的**实际取值** —— 🔴 默认跟随**实时词库**，只有被固定的那一段才用节点上那份。
 *
 * 为什么需要这一层（用户 2026-11-08 报障）：「词库更新了，脚本生成器生图却适配不上」。
 * 根因不是词库读不到，而是三段提示词在建节点时被**一次性预填进 metadata**，之后生成读的是
 * 那份快照 —— 用户在设置里改了词条，节点上还是老正文，等于「固定化」。
 *
 * 判定顺序（每段独立）：
 *  1. `pins[field] === true` → 用节点上那份（用户明确固定；即使是空串也尊重，= 回落到内置提示词）；
 *  2. 词库这一段有内容 → 用词库里**此刻**的内容；
 *  3. 词库这一段没有 → 保留节点上那份（不因为词条被删就把用户已有的正文清空）。
 *
 * ⚠️ 老节点（改造前建的、metadata 里没有 `pins`）一律按**跟随词库**处理 —— 那正是这次要修的
 * 行为；用户在弹窗里保存过一次与词库不同的内容后就会带上 `pins`，之后不再被覆盖。
 */
export function resolveScriptPromptValues(options: {
    scheme?: unknown;
    textPrompts?: readonly TextPromptEntry[] | null;
    skills?: readonly ScriptSchemeSkillSource[] | null;
    pins?: ScriptPromptPins | null;
    stored?: Partial<Record<ScriptPromptField, unknown>> | null;
}): ScriptPromptValues & { live: ScriptSchemePrefill | null } {
    const live = buildScriptSchemePrefillLive(options.scheme, options.textPrompts, options.skills);
    const stored = options.stored || {};
    const pins = options.pins || {};
    const pick = (field: ScriptPromptField): string => {
        const fromNode = typeof stored[field] === "string" ? String(stored[field]).trim() : "";
        if (pins[field]) return fromNode;
        const fromLibrary = live ? String(live[field] || "").trim() : "";
        return fromLibrary || fromNode;
    };
    return { system: pick("system"), asset: pick("asset"), shot: pick("shot"), live };
}

/**
 * 保存「自定义提示词」时该不该算「固定」—— 内容与**当前生效值**一致就不算（继续跟随词库）。
 *
 * 这样用户点开弹窗、看到词库正文、什么都没改就按保存，不会把「跟随词库」悄悄变成「固定」。
 * 留空同样不算固定：留空 = 取消固定、回到跟随词库（第一套没有词库内容时就是回落到预设内置提示词）。
 */
export function shouldPinScriptPrompt(saved: unknown, effective: string): boolean {
    const value = String(saved ?? "").trim();
    if (!value) return false;
    return value !== String(effective ?? "").trim();
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

/** 「自动套用默认方案 / 用户点名的方案」要落进节点 metadata 的那一份补丁（无可用内容 → `null`）。 */
export type ScriptSchemeSeed = Partial<{
    /**
     * 方案 id。**包含 `builtin`**：03 弹窗里用户可以明确选「第一套 · 内置」，
     * 那也是一次真实选择（写进去之后自动预填就该退让，不许再偷偷换成第四套）。
     */
    scriptScheme: ScriptSchemeId;
    /**
     * 只可能是 `SCRIPT_SCHEME_DEFAULT_MERGE_MODE`（`"4"`）—— 用 `typeof` 取而不是写 `string`：
     * `metadata.scriptMergeMode` 的类型是 `StoryScriptMergeMode`（联合字面量），宽成 `string` 就赋不进去了。
     */
    scriptMergeMode: typeof SCRIPT_SCHEME_DEFAULT_MERGE_MODE;
    /**
     * 第八套（麻薯 · 分镜组）切过去就默认「每镜 15 秒」（与 `applyScheme` 同一口径）：
     * 一行 = 一个 15 秒分镜组，停在默认 5 秒会把整组表演砍掉三分之二。
     */
    scriptSegmentSeconds: "15";
    scriptSystemPrompt: string;
    scriptAssetPrompt: string;
    scriptShotPrompt: string;
}>;

/**
 * 默认方案要写的**整份 metadata 补丁**（方案 + 默认视频分段 + 三段预填）—— 建节点与挂载预填唯一口径。
 *
 * 为什么需要它（用户 2026-11-09 报障：「03 反推出来的分镜表，视频运动提示词不是第四套那套八段格式」）：
 * 方案预填一直只发生在**脚本节点组件挂载之后**（`canvas-script-node-content.tsx` 的自动预填 effect）。
 * 手点新建没问题 —— 用户填完内容再点生成，effect 早跑完了。但 03（反推视频 → 建脚本节点 → 立刻一键视频）
 * 是**同一次点击里**先 `pushNodes` 再 `runScriptGeneration`：React 还没提交渲染、组件还没挂载，
 * 生成就已经读到 `scriptScheme: undefined`（归一成第一套内置提示词），第四套那条
 * 「`video_motion_prompt` 只能是八段标签块」的硬约束（`STORY_SCRIPT_DIRECTOR_VIDEO_FORMAT` +
 * `STORY_SCRIPT_DIRECTOR_VIDEO_SYSTEM_OVERRIDE`）根本没进 system / 任务书；
 * 之后 effect 才把方案补上 —— 表已按内置的「6 段 / `[a] + [b]` 括号链」生成，铺链路却按第四套拼风格行，
 * 两边对不上（用户看到的就是「视频运动提示词格式不太对」）。
 *
 * 所以把「该写什么」收成这一个纯函数：**建节点时**（`runVideoReverse` 的 03）与**挂载时**（组件 effect）
 * 都调它，两处口径永远一致；词库 / 技能库里没有可用内容时返回 `null`，与「手点新建」的回落链完全一样。
 *
 * @param mergeMode 节点上**已经存过**的「视频分段」档位 —— 有值就一个字都不动（用户手点过「单镜」）。
 * @param stored    节点上已有的三段 —— 填过任何一段就说明「手填优先」，自动套用要退让。
 * @param explicit  用户在 03 弹窗里**点了第几套**（2026-11-10）：为真时不再跑默认判定，
 *                  直接照这一套落库（含第一套 —— 明确选内置也是选择）。词库里取不到的那段留空，
 *                  生成时按该预设内置提示词补，与在脚本节点里手点方案完全同一口径。
 */
export function buildScriptSchemeSeed(options: {
    scheme?: unknown;
    explicit?: boolean;
    textPrompts?: readonly TextPromptEntry[] | null;
    skills?: readonly ScriptSchemeSkillSource[] | null;
    mergeMode?: unknown;
    stored?: Partial<Record<ScriptPromptField, unknown>> | null;
}): ScriptSchemeSeed | null {
    // 明确点名的那一套优先；认不出的值（空串 / 脏值）当作「没点名」，继续走默认判定。
    const explicitScheme = options.explicit ? asScriptSchemeId(options.scheme) : null;
    const next: ScriptSchemeId | null =
        explicitScheme ??
        resolveAutoApplyScriptScheme({
            // 脏值（`"whatever"` / 空串）**不能**当「用户选过了」交给默认判定 —— 那会让自动预填永远退让，
            // 界面亮着第一套、词库明明有第四套也不用。归一成「没选」再判。
            scheme: asScriptSchemeId(options.scheme) ?? undefined,
            directorPrefill: buildScriptSchemePrefill(options.textPrompts, "director"),
            x20Prefill: buildScriptSchemePrefill(options.textPrompts, "x20"),
            libraryPrefill: buildScriptSchemePrefill(options.textPrompts, "library"),
            customSystemPrompt: options.stored?.system,
            customAssetPrompt: options.stored?.asset,
            customShotPrompt: options.stored?.shot,
        });
    if (!next) return null;
    const mergeMode = resolveSchemeDefaultMergeMode(next);
    /**
     * 第一套 = 预设自带的内置提示词：**只写方案，三段一个字都不写**。
     * 往里写任何正文都会把内置提示词顶掉（那正好是「点了内置却仍按别套跑」的来源）。
     */
    if (next === "builtin") {
        return { scriptScheme: "builtin", ...(mergeMode && !hasText(options.mergeMode) ? { scriptMergeMode: mergeMode } : {}) };
    }
    const prefill = buildScriptSchemePrefillLive(next, options.textPrompts, options.skills);
    return {
        scriptScheme: next,
        // ⚠️ 只在**用户没设过**时写：老节点可能早就自己选过「单镜」，自动预填不该把它悄悄改掉。
        ...(mergeMode && !hasText(options.mergeMode) ? { scriptMergeMode: mergeMode } : {}),
        ...(next === "mashu" ? { scriptSegmentSeconds: "15" as const } : {}),
        // 空串不写：让那一段保持原值（= 回落到内置提示词），绝不拿空串把用户已有正文清掉。
        ...(prefill?.system ? { scriptSystemPrompt: prefill.system } : {}),
        ...(prefill?.asset ? { scriptAssetPrompt: prefill.asset } : {}),
        ...(prefill?.shot ? { scriptShotPrompt: prefill.shot } : {}),
    };
}
