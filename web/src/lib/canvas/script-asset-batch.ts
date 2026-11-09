import {
    collectScriptAssetCellTargets,
    collectScriptAssetPromptCandidates,
    normalizeStoryScriptCellAssetMap,
    normalizeStoryScriptNameLockMap,
    resolveStoryScriptImageSize,
    scriptCellAssetIds,
    scriptNameLockIds,
    SCRIPT_ASSET_GENERATABLE_ROLE_IDS,
    setStoryScriptCellAssetIds,
    setStoryScriptNameLock,
    type ScriptAssetRole,
    type StoryScriptExtraColumn,
    type StoryScriptRow,
} from "@/constant/story-script";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 脚本节点「资产图一键批量生成」的纯逻辑：**选哪些** + **摆哪儿**。
 *
 * 两件事都刻意放在 lib 里（不写进组件），因为它们在浏览器里看起来都对、错了只有用户能发现：
 *  - 选哪些：按分类从分镜表汇总去重（角色按名字、场景 / 道具按名字 + 描述），
 *    已经生成过的那条要标出来并默认不勾 —— 否则「再点一次批量」会把已有的图再出一遍；
 *  - 摆哪儿：批量出来的图贴在脚本节点**左侧**排成一片（距脚本左边缘 48px，竖向排在脚本窗口高度里，
 *    塞不下就往左开新的一列，最多 3 列），并且要避开已有的资产图 / 已经铺好的分镜链路，
 *    否则第二次生成会和第一批叠在一起。
 *
 * 资产阵里的节点依然带 `metadata.scriptAssetLane = 脚本节点 id`（字段名沿用旧版，见 types/canvas.ts）：
 * 它既是「这批是本节点生成的」标记，也是「铺链路让位」（存量画布右侧车道）的判据。
 */

export type ScriptAssetBatchItem = {
    /** 勾选状态的稳定键：`分类:标题`。 */
    key: string;
    role: ScriptAssetRole;
    /** 资产名（角色名 / 场景名 / 道具名…），同时作为建出来的图片节点标题。 */
    title: string;
    /** 喂给生图的提示词。 */
    prompt: string;
    /** 已经有同分类同名的素材节点 → 默认不勾（避免重复出图）。 */
    existingNodeIds: string[];
};

/** 已连到脚本节点的素材（用来判断「这个资产已经有图了」）。 */
export type ScriptAssetExistingAsset = { nodeId: string; title: string; role: ScriptAssetRole };

export function scriptAssetBatchKey(role: ScriptAssetRole, title: string) {
    return `${role}:${String(title || "").trim()}`;
}

/**
 * 从分镜表汇总「所有可以一键生成的资产」。
 *
 * - 分类顺序固定为 `SCRIPT_ASSET_GENERATABLE_ROLE_IDS`（角色 → 场景 → 道具 → 人物站位），
 *   同类内保留分镜表里首次出现的顺序：生成的网格顺序与表里读到的顺序一致，看图时好对。
 * - 去重口径 = `collectScriptAssetPromptCandidates`（角色按名字、场景道具按名字 + 描述），
 *   这里只再按「分类 + 标题」兜一层，避免两个分类恰好同名时被当成同一条。
 * - `existing` 用「分类 + 标题」精确匹配（标题就是资产名，生成时我们还会把标题改回来），
 *   对不上就当作没生成过 —— 宁可多勾一条让用户手动取消，也不要静默漏掉一张该出的图。
 */
export function buildScriptAssetBatchItems(rows: readonly StoryScriptRow[] | null | undefined, existing: readonly ScriptAssetExistingAsset[] = []): ScriptAssetBatchItem[] {
    const existingMap = new Map<string, string[]>();
    for (const asset of existing) {
        const key = scriptAssetBatchKey(asset.role, asset.title);
        const list = existingMap.get(key) || [];
        if (asset.nodeId && !list.includes(asset.nodeId)) list.push(asset.nodeId);
        existingMap.set(key, list);
    }
    const seen = new Set<string>();
    const items: ScriptAssetBatchItem[] = [];
    for (const role of SCRIPT_ASSET_GENERATABLE_ROLE_IDS) {
        for (const candidate of collectScriptAssetPromptCandidates(role, rows)) {
            const key = scriptAssetBatchKey(role, candidate.title);
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ key, role, title: candidate.title, prompt: candidate.prompt, existingNodeIds: existingMap.get(key) || [] });
        }
    }
    return items;
}

/** 按分类分组（弹窗按组渲染）。空分类不返回。 */
export function groupScriptAssetBatchItems(items: readonly ScriptAssetBatchItem[]): Array<{ role: ScriptAssetRole; items: ScriptAssetBatchItem[] }> {
    const groups: Array<{ role: ScriptAssetRole; items: ScriptAssetBatchItem[] }> = [];
    for (const role of SCRIPT_ASSET_GENERATABLE_ROLE_IDS) {
        const list = items.filter((item) => item.role === role);
        if (list.length) groups.push({ role, items: list });
    }
    return groups;
}

/**
 * 默认勾选：**没有出过图的**那几条。用户点开弹窗先看到「还缺哪些」，再按类型筛或逐条取消。
 * （全部默认勾选会让「第二次点批量」把已有资产重复生成一遍，白白花钱。）
 */
export function defaultScriptAssetBatchSelection(items: readonly ScriptAssetBatchItem[]) {
    return items.filter((item) => !item.existingNodeIds.length).map((item) => item.key);
}

// ── 「一键直接生图」：不筛不弹窗，全量出图，画幅按分类定 ────────────────────────────

/**
 * 「一键直接生图」会生成的分类 —— **只有角色 / 场景 / 道具**。
 *
 * 用户 2026-11-07：「站位图这一分类的图不要在一键直接生图时进行生成」。
 * 人物站位（`blocking`）是俯视走位示意图，天然不属于「分镜资产定妆图」那一批；
 * 把它混进来既浪费额度，又会让脚本左侧那片资产阵里夹进一堆画风完全不同的示意图。
 * ⚠️ 「一键批量生成」（弹窗）那条**仍然包含**站位图 —— 那边用户可以自己勾，不受这里影响。
 */
export const SCRIPT_ASSET_DIRECT_ROLE_IDS: ScriptAssetRole[] = ["character", "scene", "prop"];

/**
 * 「一键直接生图」**写死的**分类画幅（用户 2026-11-07 强化口径）：
 * **角色 9:16，场景 / 道具 16:9**。
 *
 * 🔴 这里**不接受任何外部覆盖**（曾经收过节点上的 `metadata.scriptImageSize`，结果那份「生图比例」
 * 一旦是 16:9，角色也被整批改成 16:9 —— 用户报障「角色没有按照 9x16 去生」就是它）。
 * 「生图比例」那颗选择器只作用于「添加资产 / 批量生成 / 铺链路」，与这颗「直接生图」按钮无关。
 */
export const SCRIPT_ASSET_DIRECT_SIZE_BY_ROLE: Partial<Record<ScriptAssetRole, string>> = {
    character: "9:16",
    scene: "16:9",
    prop: "16:9",
};

/** 这个分类归「一键直接生图」管吗（站位图 / 音频都不管）。 */
export function isScriptAssetDirectRole(role: unknown): boolean {
    return SCRIPT_ASSET_DIRECT_ROLE_IDS.includes(role as ScriptAssetRole);
}

/**
 * 脚本生成器所有生图的**画质保底 = 2K**（用户 2026-11-08 报障）。
 *
 * 现象：没在「生图画质」里选 1k / 2k 时，脚本生成器出来的资产图是 **1K**。
 * 根因：脚本资产生图只写了**比例**（`metadata.size = "9:16"` / `"16:9"`），画质一路回落到
 * 「配置偏好 → quality」。偏好若为空或 `auto`（面板里那颗「自动」），`services/api/image.ts`
 * 的 `resolveSize()` 拿不到基准像素，就走 `DEFAULT_IMAGE_SHORT_SIDE = 1024` = 1K。
 *
 * 所以这里只做一件事：**空 / auto → medium（`QUALITY_BASE.medium` = 2048 = 2K）**；
 * 用户显式选过的档位（low 1K / high 4K …）原样保留，不越权改用户的选择。
 * 返回 `null` = 不用写进节点（继续跟随全局偏好，用户以后调整偏好这批也跟得上）。
 */
export const SCRIPT_ASSET_DEFAULT_IMAGE_QUALITY = "medium";

export function resolveScriptImageQuality(quality: unknown): string | null {
    const value = String(quality ?? "").trim().toLowerCase();
    if (!value || value === "auto") return SCRIPT_ASSET_DEFAULT_IMAGE_QUALITY;
    return null;
}

/**
 * 某一类资产「一键直接生图」时用的画幅 —— 纯查表，没有 override 这条路。
 */
export function resolveScriptAssetDirectSize(role: ScriptAssetRole): string {
    return SCRIPT_ASSET_DIRECT_SIZE_BY_ROLE[role] || "16:9";
}

/**
 * 「一键批量生成 / 单格生成」该用多宽 —— **与「一键直接生图」同一口径**（2026-11-08 第 16 条）。
 *
 * 用户报障：「一键生图和一键批量生图，现在在执行角色生图时，角色出来的排版跟词库里的有差异……
 * 有的角色生图比例不对」。根因是两条路的画幅来源不同：
 *  - 直接生图：`resolveScriptAssetDirectSize()` —— 角色 9:16 硬规则；
 *  - 批量生图：把**同一个** `scriptImageSize` 套给整批，没设时连 `size` 字段都不写
 *    → 节点画成 340×240、请求回落上游默认比例（多半是 1:1 方图）。
 *
 * 现在收敛成：**角色永远是 9:16（任何选择器都改不动）**；场景 / 道具用用户在这颗选择器里选的比例，
 * 没选就是 16:9。这样两条路出来的角色图比例一致，用户也仍然能改场景宫格的比例。
 */
export function resolveScriptAssetSizeForRole(role: ScriptAssetRole, preferred?: unknown): string {
    if (role === "character") return resolveScriptAssetDirectSize("character");
    return resolveStoryScriptImageSize(preferred) || resolveScriptAssetDirectSize(role);
}

/**
 * 「一键直接生图」要生成的那一批：表里全部角色 / 场景 / 道具（按分类顺序、按名字去重）。
 *
 * `existing` 传空数组 = **不筛**（已经出过图的也照生，这是与「一键批量生成」的唯一区别）；
 * 同时把人物站位 / 音频剔掉（见 `SCRIPT_ASSET_DIRECT_ROLE_IDS`）。
 */
export function buildScriptAssetDirectItems(rows?: readonly StoryScriptRow[] | null): ScriptAssetBatchItem[] {
    return buildScriptAssetBatchItems(rows, []).filter((item) => isScriptAssetDirectRole(item.role));
}

// ── 「一键直接生图」的视图版式：从**词库**里按标题捞一段拼到提示词后面 ──────────────────

/**
 * 「一键直接生图」默认要拼上的视图版式（用户 2026-11-08 口径）：
 *  - 角色 → 词库里的「角色视图-------无头9x16竖版排版」
 *  - 场景 → 词库里的「场景视图-----------2x2场景宫格图」
 *
 * 为什么按「标题关键词」匹配、而不是按 id 或标题全等：
 * ① 这两条是**用户自建**的词库条目，id 是随机值，代码里写不出来；
 * ② 用户写标题时横线数量随手打（截图上是 7 个 / 11 个 `-`），全等匹配今天能用、改天就失效。
 * 所以判据是「归一化标题里必须出现哪些词」：角色视图 + 无头 / 场景视图 + 2x2 或宫格。
 * 匹配不到就**不拼**（不报错、不阻塞）—— 用户删了这条词库条目，生图该照常跑。
 */
export const SCRIPT_ASSET_VIEW_TEMPLATE_RULES: Array<{ role: ScriptAssetRole; label: string; canonical: string; groups: string[][] }> = [
    // 第一组放宽到「角色视图 / 角色三视图 / 角色正面视图 / 人物视图」：用户改标题时最容易在这里走样
    // （「角色三视图」不含「角色视图」三个连续字，只按原样匹配就会静默不套版式）。
    // 第二组必须是「无头」——它是这条版式的判据，只写「角色视图不加无头」的条目不算。
    // `canonical` = 用户原话的标题（横线数量随手打，比对前会归一化）：词库里同时留着好几版时，
    // 标题**正好是这一条**的优先（见 `scoreScriptViewTemplateTitle`）。
    {
        role: "character",
        label: "角色视图 · 无头 9:16 竖版排版",
        canonical: "角色视图-------无头9x16竖版排版",
        groups: [["角色视图", "角色三视图", "角色正面视图", "人物视图"], ["无头"]],
    },
    {
        role: "scene",
        label: "场景视图 · 2x2 场景宫格图",
        canonical: "场景视图-----------2x2场景宫格图",
        groups: [["场景视图", "场景三视图", "场景宫格"], ["2x2", "宫格"]],
    },
];

/** 标题归一化：去空格 / 各种横线 / 括号 / 标点，`×` 统一成 `x`，全角数字与字母转半角，再转小写。 */
export function normalizeScriptViewTemplateTitle(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[×✕✖]/g, "x")
        // 全角 `９ｘ１６` / `２×２` 很常见（中文输入法下打出来的），不转半角就永远匹配不上。
        .replace(/[０-９ａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
        .replace(/[～〜]/g, "~")
        .replace(/[\s\-—–－_·•.。~:：,，、;；/\\|()（）\[\]【】{}"'“”‘’]+/g, "");
}

type ViewTemplatePromptEntry = { title?: string; content?: string; enabled?: boolean };

/**
 * 一个标题对某条规则的「像不像」打分：`-1` = 不命中，分越高越该被选中。
 *
 * 为什么不再「命中即返回第一条」（用户 2026-11-09 报障：「感觉现在是乱的」）：
 * 这两条版式是用户自建的，词库里很容易同时留着好几版（草稿 / 正式 / 改过标题的旧版），
 * 而它们的标题**全都**满足判据。老实现按词库顺序取第一条 —— 于是「用的是哪一条」取决于
 * 列表排序（拖动一下顺序、复制一条再改，出图版式就换了），表现上就是「时好时坏、乱」。
 *
 * 打分口径（都可测、且单一命中时结果与老实现完全一致）：
 *  ① 归一化标题**正好等于**规则里的 `canonical`（用户原话那条）→ +100，稳赢；
 *  ② 每组取第一个命中的关键词，越靠前越具体（`角色视图` 比 `人物视图` 更贴），分越高；
 *  ③ 仍并列 → 保持词库顺序（先来的赢），不引入随机性。
 */
export function scoreScriptViewTemplateTitle(rule: { canonical: string; groups: string[][] }, title: unknown): number {
    const normalized = normalizeScriptViewTemplateTitle(title);
    if (!normalized) return -1;
    let score = 0;
    for (const group of rule.groups) {
        const index = group.findIndex((keyword) => {
            const key = normalizeScriptViewTemplateTitle(keyword);
            return Boolean(key) && normalized.includes(key);
        });
        if (index < 0) return -1;
        score += group.length - index;
    }
    if (normalized === normalizeScriptViewTemplateTitle(rule.canonical)) score += 100;
    return score;
}

/**
 * 从词库里捞出这一分类要追加的版式正文；没有 → 空串。
 * 命中的多条里取**分数最高**的那条（见 `scoreScriptViewTemplateTitle`），并列取词库顺序第一条。
 * 关掉的条目直接跳过（不能让一条停用的好标题把后面的顶掉）。
 */
export function resolveScriptAssetViewTemplate(role: ScriptAssetRole, textPrompts?: readonly ViewTemplatePromptEntry[] | null): string {
    const rule = SCRIPT_ASSET_VIEW_TEMPLATE_RULES.find((item) => item.role === role);
    if (!rule) return "";
    let best = "";
    let bestScore = 0;
    for (const entry of textPrompts || []) {
        if (entry?.enabled === false) continue;
        const content = String(entry?.content ?? "").trim();
        if (!content) continue;
        const score = scoreScriptViewTemplateTitle(rule, entry?.title);
        // 严格大于：同分保留先出现的那条（词库顺序就是用户排序）。
        if (score > bestScore) {
            bestScore = score;
            best = content;
        }
    }
    return best;
}

/**
 * 这一批里**该套版式却没套上**的分类（返回规则标签，如「角色视图 · 无头 9:16 竖版排版」）。
 *
 * 为什么要有它：词库匹配不上时按设计是**静默不拼**（不阻塞生图），可用户看到的就是
 * 「这张角色图怎么没按版式排」—— 而且没有任何线索。用户 2026-11-09 直接问
 * 「一键生图到底有没有调用词库里那条角色视图」，所以把「没命中」变成一句能在界面上看到的提示：
 * 调不调用、命中没命中，一眼就知道，不用再猜。
 *
 * 只在**这一批真有这个分类**时才算（表里没角色就不必提醒角色版式）。
 */
export function resolveMissingScriptAssetViewTemplates(items: readonly ScriptAssetBatchItem[], textPrompts?: readonly ViewTemplatePromptEntry[] | null): string[] {
    const missing: string[] = [];
    const roles = new Set(items.map((item) => item.role));
    for (const rule of SCRIPT_ASSET_VIEW_TEMPLATE_RULES) {
        if (!roles.has(rule.role)) continue;
        if (resolveScriptAssetViewTemplate(rule.role, textPrompts)) continue;
        missing.push(rule.label);
    }
    return missing;
}

/**
 * 把一段后缀追加到资产提示词后面。
 * ⚠️ 幂等：正文里已经含这段（用户自己粘过、或同一批被重算一次）就不再拼第二遍。
 */
export function appendScriptAssetPromptSuffix(prompt: string, suffix: string): string {
    const body = String(prompt ?? "").trim();
    const tail = String(suffix ?? "").trim();
    if (!tail) return body;
    if (!body) return tail;
    if (body.includes(tail)) return body;
    return `${body}\n\n${tail}`;
}

/**
 * 往前缀位置插一段（画幅声明那种「必须最先被读到」的句子）。
 *
 * 不能拿 `appendScriptAssetPromptSuffix` 反着传：那函数判幂等的是「正文是否已含尾缀」，
 * 反过来传就变成「前缀是否含整段提示词」，永远不成立 → 重复点击会叠两份前缀。
 */
export function prependScriptAssetPromptPrefix(prompt: string, prefix: string): string {
    const body = String(prompt ?? "").trim();
    const head = String(prefix ?? "").trim();
    if (!head) return body;
    if (!body) return head;
    if (body.includes(head)) return body;
    return `${head}\n\n${body}`;
}

/** 词库视图版式的追加（等价于 `appendScriptAssetPromptSuffix`，名字保留旧口径）。 */
export function appendScriptAssetViewTemplate(prompt: string, template: string): string {
    return appendScriptAssetPromptSuffix(prompt, template);
}

/**
 * 给这一批的提示词按分类补上词库版式（只补版式，不带画幅声明 / 空景）。
 *
 * ⚠️ 2026-11-08 第 16 条之后**两条生图路都走它**：以前只有「一键直接生图」套版式、「一键批量生成」
 * 不套，同一批角色图就会一半有版式一半没有（用户报障「有的有头有的无头、有的排版不对」）。
 * 真实入口是 `applyScriptAssetDirectDecorations`（版式 + 空景 + 画幅首尾），这个函数只单独用得上
 * 在「只想追加版式、不要画幅句」的场景。
 */
export function applyScriptAssetViewTemplates(items: readonly ScriptAssetBatchItem[], textPrompts?: readonly ViewTemplatePromptEntry[] | null): ScriptAssetBatchItem[] {
    if (!items.length || !textPrompts?.length) return items.slice();
    return items.map((item) => {
        const template = resolveScriptAssetViewTemplate(item.role, textPrompts);
        if (!template) return item;
        const prompt = appendScriptAssetPromptSuffix(item.prompt, template);
        return prompt === item.prompt ? item : { ...item, prompt };
    });
}

// ── 「一键直接生图」的固定尾缀：空景 + 画幅收口 ────────────────────────────────────

/**
 * 空景尾缀作用在**哪些分类**（用户 2026-11-08 两条口径合并）：
 *  - 场景：「场景出图时，添加一个后缀，即图片中不要出现人物角色，为场景的空景展示」；
 *  - 道具：「道具出图时，需要添加一个后缀，即图片中不要出现人物角色，为道具的空景展示」。
 *
 * 角色不加（角色图当然要有人）；站位图 / 音频不在「一键直接生图」这一批里。
 */
export const SCRIPT_ASSET_EMPTY_PLATE_ROLES: ScriptAssetRole[] = ["scene", "prop"];

/**
 * 场景 / 道具资产图的**空景**尾缀：
 * 「图片中不要出现人物角色，为空景展示」。
 *
 * 为什么要写进提示词，而不是只靠 `size`：
 *  - 这两类是拿来当**背景 / 陈设参考**的，混进人物会污染后面所有分镜（视频里「场景里多个人」的根源）；
 *  - 生图模型对「否定词」不敏感，所以不只写「不要人物」，还把「要什么」写全（建筑 / 陈设 / 道具 / 环境 / 光线）。
 *
 * 场景与道具**各写一份**：场景要的是「看得见空间」，道具要的是「这一件东西的完整形态与材质」，
 * 合成一句会两头都不准（道具图里写「建筑、陈设」会把画面拉去拍环境）。
 */
export const SCRIPT_ASSET_EMPTY_SCENE_SUFFIX =
    "空景要求：画面中不要出现任何人物角色——没有人物、没有人脸、没有背影或剪影、没有人群、没有手部特写，只表现建筑、陈设、环境与光线本身，作为后续分镜的空景素材。";

export const SCRIPT_ASSET_EMPTY_PROP_SUFFIX =
    "空景要求：画面中不要出现任何人物角色——没有人物、没有人手、没有人脸、没有背影或剪影，只表现这件道具本身的完整形态、材质细节与它所处的陈设、环境光线，作为后续分镜的道具空景素材。";

/** 这个分类要不要加空景尾缀。 */
export function usesScriptAssetEmptyPlate(role: ScriptAssetRole): boolean {
    return SCRIPT_ASSET_EMPTY_PLATE_ROLES.includes(role);
}

/** 按分类取那一句空景尾缀（角色 = 空串，不加）。 */
export function resolveScriptAssetEmptyPlateSuffix(role: ScriptAssetRole): string {
    if (role === "scene") return SCRIPT_ASSET_EMPTY_SCENE_SUFFIX;
    if (role === "prop") return SCRIPT_ASSET_EMPTY_PROP_SUFFIX;
    return "";
}

/** 各种比例对应的「版式说明」（只用于**提示词里的文字**，不影响请求参数）。 */
const SCRIPT_ASSET_FRAME_WORDING: Record<string, { orientation: string; pixels: string; wrong: string }> = {
    "9:16": { orientation: "竖版", pixels: "如 1080×1920", wrong: "1:1 方图或横图" },
    "3:4": { orientation: "竖版", pixels: "如 1200×1600", wrong: "1:1 方图或横图" },
    "2:3": { orientation: "竖版", pixels: "如 1024×1536", wrong: "1:1 方图或横图" },
    "16:9": { orientation: "横版", pixels: "如 1920×1080", wrong: "1:1 方图或竖图" },
    "4:3": { orientation: "横版", pixels: "如 1600×1200", wrong: "1:1 方图或竖图" },
    "3:2": { orientation: "横版", pixels: "如 1536×1024", wrong: "1:1 方图或竖图" },
    "1:1": { orientation: "方形", pixels: "如 1024×1024", wrong: "横图或竖图" },
};

/**
 * 画幅收口：把「9:16 / 16:9」**写在提示词的最前面和最末尾各一次**。
 *
 * 为什么需要它：`size` 参数只对「认这个字段的模型」有效 —— 有的中转 / 有的模型家族会收下
 * `size` 却按提示词排版（尤其当词库版式里写了别的画幅时，模型会跟着版式走，出方图）。
 * 用户 2026-11-08 连续两次报障「角色出图现在出来的是 1x1 的，应该是 9x16」就是这一路。
 *
 * 首尾各一次不是「啰嗦」：模型对长提示词的注意力集中在**开头和结尾**，用户自建的词库版式
 * （「无头9x16竖版排版」）恰好落在中间；只压末尾时有版式会赢。
 *
 * ⚠️ 两个口径必须**同源**：文字里的比例和请求里的 `size` 是**同一个** `size` 参数（两条生图路都从
 * `resolveScriptAssetSizeForRole` / `resolveScriptAssetDirectSize` 取，别处不许再拼一份比例常量），
 * 否则「画幅硬规则」与「提示词里写的画幅」会漂。
 */
function scriptAssetFrameSpec(role: ScriptAssetRole, size?: string): { ratio: string; orientation: string; pixels: string; wrong: string } {
    const ratio = String(size || resolveScriptAssetDirectSize(role)).trim() || resolveScriptAssetDirectSize(role);
    const wording = SCRIPT_ASSET_FRAME_WORDING[ratio];
    if (wording) return { ratio, ...wording };
    return { ratio, orientation: "", pixels: "", wrong: "别的比例" };
}

/** 提示词**最前面**的画幅声明（短一行，先立规矩）。`size` 不传 = 按分类的硬规则画幅。 */
export function buildScriptAssetFramePrefix(role: ScriptAssetRole, size?: string): string {
    const spec = scriptAssetFrameSpec(role, size);
    return spec.pixels
        ? `【画幅】${spec.ratio} ${spec.orientation}（${spec.pixels}），整张图是${spec.orientation === "竖版" ? "竖的长图" : spec.orientation === "方形" ? "方形图" : "横的长图"}，不要做成 ${spec.wrong}。`
        : `【画幅】${spec.ratio}，整张图按这个比例排版，不要做成 ${spec.wrong}。`;
}

/** 提示词**最后一行**的画幅收口（上面的版式 / 空景可能把画幅说岔了，这里再钉一次）。 */
export function buildScriptAssetFrameSuffix(role: ScriptAssetRole, size?: string): string {
    const spec = scriptAssetFrameSpec(role, size);
    return spec.pixels
        ? `画面比例：${spec.ratio} ${spec.orientation}（宽:高 = ${spec.ratio}），整张图按${spec.orientation === "竖版" ? "竖" : spec.orientation === "方形" ? "方" : "横"}构图排版，不要做成 ${spec.wrong}。`
        : `画面比例：${spec.ratio}，整张图按这个比例排版。`;
}

/**
 * 资产图提示词的**最终整形**（顺序即语义，不能乱）：
 *
 *  1. 画幅声明（短前缀，先把画幅立在最前面）；
 *  2. 资产描述（分镜表里那一格）；
 *  3. 词库视图版式（角色 / 场景各一条，见 `SCRIPT_ASSET_VIEW_TEMPLATE_RULES`）；
 *  4. 场景 / 道具 → 空景尾缀（`SCRIPT_ASSET_EMPTY_PLATE_ROLES`）；
 *  5. 画幅收口 —— **永远最后一行**，压过前面版式里可能写死的画幅。
 *
 * 每一步都幂等：同一批重算、或用户手动把尾缀粘进提示词后再点，都不会出现两份。
 *
 * @param resolveSize 这一批怎么定画幅；默认 =「一键直接生图」的硬规则（角色 9:16、场景/道具 16:9）。
 *                    「一键批量生成」传 `resolveScriptAssetSizeForRole` 的柯里化版本 —— 两条路**必须**共用
 *                    这一份整形逻辑，否则用户看到的还是「一键生图有版式、批量生图没版式」（2026-11-08 第 16 条）。
 */
export function applyScriptAssetDirectDecorations(
    items: readonly ScriptAssetBatchItem[],
    textPrompts?: readonly ViewTemplatePromptEntry[] | null,
    resolveSize: (role: ScriptAssetRole) => string = resolveScriptAssetDirectSize,
): ScriptAssetBatchItem[] {
    if (!items.length) return [];
    return applyScriptAssetViewTemplates(items, textPrompts).map((item) => {
        const size = resolveSize(item.role);
        let prompt = prependScriptAssetPromptPrefix(item.prompt, buildScriptAssetFramePrefix(item.role, size));
        const plate = resolveScriptAssetEmptyPlateSuffix(item.role);
        if (plate) prompt = appendScriptAssetPromptSuffix(prompt, plate);
        prompt = appendScriptAssetPromptSuffix(prompt, buildScriptAssetFrameSuffix(item.role, size));
        return prompt === item.prompt ? item : { ...item, prompt };
    });
}

/**
 * 出图之后的自检：这一张有没有按要求的画幅出来？
 *
 * 为什么要它：`size` 是否被上游听见，**只有出图后的像素能证明**。用户 2026-11-08 连续两次报
 * 「角色出图是 1x1」，而我们这边请求里确实带着 9:16 —— 没有这条提示，用户只看到一张方图、
 * 我们也拿不到「是哪家模型没听 size」。所以：只要偏差超过 12%，就在画布上提示一次
 * （**只提示，不重跑**：重跑要花钱，而且换不换模型是用户的判断）。
 *
 * @returns 实际比例文案（如 "1:1"）；比例吻合 / 参数不全 → 空串。
 */
export function describeScriptAssetAspectMismatch(requestedSize: unknown, naturalWidth: unknown, naturalHeight: unknown): string {
    const wanted = String(requestedSize ?? "").trim();
    const width = Number(naturalWidth);
    const height = Number(naturalHeight);
    if (!wanted || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
    const match = wanted.match(/^(\d+)\s*[:x×]\s*(\d+)$/i);
    if (!match) return "";
    const target = Number(match[1]) / Math.max(1, Number(match[2]));
    const actual = width / height;
    if (!Number.isFinite(target) || target <= 0) return "";
    if (Math.abs(actual - target) / target <= 0.12) return "";
    return `${Math.round(actual * 100) / 100}:1（${Math.round(width)}×${Math.round(height)}）`;
}


// ── 挂载：批量生成的图要落到「具体的资产」上 ──────────────────────────────────────

/**
 * 一条资产在表里的落点（哪一镜、哪一列）。
 *
 * 批量生成出来的一批图，如果只连到脚本节点，它们只是「一堆上游素材」——
 * 表里的资产格还是空的、铺链路时也认不出「这张图就是张三」。用户要的是
 * **直接挂到具体的资产上**（2026-11-07 第 4 条），所以每个名字都要落回它出现过的每一格。
 */
export type ScriptAssetBatchMount = { shotNo: number; columnKey: string; name: string };

/**
 * 按「分类 + 标题」排出这一批资产各自要挂到哪些格位。
 *
 * 键与 `buildScriptAssetBatchItems` 的 `item.key` 完全一致（`分类:标题`），
 * 标题口径也一致（`collectScriptAssetCellTargets` 与 `collectScriptAssetPromptCandidates` 同源），
 * 所以「弹窗里勾了哪一条」就能精确映射到「这张图要挂哪几格」。
 */
export function buildScriptAssetBatchMounts(rows?: readonly StoryScriptRow[] | null): Record<string, ScriptAssetBatchMount[]> {
    const out: Record<string, ScriptAssetBatchMount[]> = {};
    for (const role of SCRIPT_ASSET_GENERATABLE_ROLE_IDS) {
        for (const target of collectScriptAssetCellTargets(role, rows)) {
            const key = scriptAssetBatchKey(role, target.title);
            const list = out[key] || (out[key] = []);
            // 同一镜同一列只挂一次（同名列在 extras 里重复声明之类的脏数据）。
            if (list.some((slot) => slot.shotNo === target.shotNo && slot.columnKey === target.columnKey)) continue;
            list.push({ shotNo: target.shotNo, columnKey: target.columnKey, name: target.name });
        }
    }
    return out;
}

/**
 * 把一张刚生成的图挂到若干格位，返回**新的** `scriptCellAssets` / `scriptNameLocks`。
 *
 * 与单格生成（`appendCellAssets`）同一口径，两处都写：
 *  - `scriptCellAssets` 按「镜号:资产列」**追加**（保留这一格原本挂着的图，不覆盖）——
 *    表里这一格立刻显示新图，铺链路时按「精准指定」连到该镜；
 *  - `scriptNameLocks` 按**资产名**并集 —— 同名在多镜出现时，整张表所有同名格都认同一张图。
 *    ⚠️ `name` 为空（人物站位 / 自建列没有名字列）时不写锁：锁的键是「资产名」，
 *    拿描述前 24 字当名字去锁，永远不会命中任何一格，只会让锁表变脏。
 */
export function mountScriptAssetToCells(input: {
    cells: unknown;
    locks: unknown;
    mounts: readonly ScriptAssetBatchMount[];
    nodeId: string;
    extras?: readonly StoryScriptExtraColumn[] | null;
}): { cells: ReturnType<typeof setStoryScriptCellAssetIds>; locks: ReturnType<typeof normalizeStoryScriptNameLockMap> } {
    const { nodeId, mounts, extras } = input;
    // 先归一化：入参来自 metadata（`unknown`），而且脏键 / 空数组要顺手清掉，否则后面的追加会跟脏数据混在一起。
    let cells = normalizeStoryScriptCellAssetMap(input.cells, extras);
    const lockAdds = new Map<string, string[]>();
    for (const mount of mounts) {
        cells = setStoryScriptCellAssetIds(cells, mount.shotNo, mount.columnKey, [...scriptCellAssetIds(cells, mount.shotNo, mount.columnKey, extras), nodeId], extras);
        if (!mount.name) continue;
        lockAdds.set(mount.name, [...(lockAdds.get(mount.name) || []), nodeId]);
    }
    let locks = normalizeStoryScriptNameLockMap(input.locks);
    for (const [name, ids] of lockAdds) locks = setStoryScriptNameLock(locks, name, [...scriptNameLockIds(locks, name), ...ids]);
    return { cells, locks };
}

// ── 参考图直接挂载：反推节点上连进来的「产品图」不用再生，直接挂成道具资产 ──────────────────

/**
 * 参与「参考图直接挂载」的分类 —— 目前**只认道具**（用户 2026-11-09 口径：
 * 「若参考图是产品则需要将该产品道具在执行一键视频时直接挂载到具体的产品道具中」）。
 *
 * 为什么不连角色 / 场景一起认：反推节点上连的参考图，用户心里那张「产品图」是**替代资产图**用的；
 * 角色 / 场景有自己的定妆版式与空景要求（见 `SCRIPT_ASSET_VIEW_TEMPLATE_RULES` /
 * `SCRIPT_ASSET_EMPTY_PLATE_ROLES`），拿一张随手拍的产品图去顶，出图口径会歪。
 * 要放开就在这一个数组里加，匹配 / 挂载 / 跳过生成三条路自动跟着变。
 */
export const SCRIPT_ASSET_REFERENCE_ROLE_IDS: ScriptAssetRole[] = ["prop"];

/** 反推节点上连进来的参考图（`title` 是图片节点标题，用来和分镜表里的资产名对齐）。 */
export type ScriptAssetReference = { nodeId: string; title: string; prompt?: string };

/** 一条命中的参考图 → 分镜表里的具体资产。 */
export type ScriptAssetReferenceMatch = {
    reference: ScriptAssetReference;
    role: ScriptAssetRole;
    /** 命中的资产名（= 分镜表那一格的名字 / 标题，也就是 `item.title`）。 */
    title: string;
    /** `分类:标题`，与 `buildScriptAssetBatchItems` / `buildScriptAssetBatchMounts` 同一个键。 */
    key: string;
    mounts: ScriptAssetBatchMount[];
    /**
     * 这条是怎么认上的：
     *  - `name`：名字对上（`口红产品图` → `口红`）；
     *  - `hero`：名字对不上，按「表里出现镜数最多」兜底认成主角道具（用户 2026-11-09 口径）。
     * 调用方据此给用户一句不同的提示 —— 自动认的要让人看得见，别以为是名字对上了。
     */
    via?: "name" | "hero";
};

/**
 * 名字归一化（**只用于匹配参考图**）：小写 → 去掉图片扩展名 → 去掉空白 / 标点 / 括号 / 连接符。
 *
 * 与 `normalizeScriptViewTemplateTitle` 分开写：那边要把 `×` 转成 `x`（为了认「无头9x16」这种标题），
 * 这边不转，否则 `口红×2` 会变成 `口红x2` 反而更匹配不上 `口红`。
 */
export function normalizeScriptAssetReferenceName(value: unknown): string {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/\.(png|jpe?g|webp|gif|bmp|avif)$/i, "")
        .replace(/[\s\-—–－_·•.。:：,，、;；/\\|()（）\[\]【】{}"'“”‘’]+/g, "");
}

/** 一个参考图能被拿去匹配的文本：标题优先，标题太泛（`图片` / 空）时再看提示词。 */
function scriptAssetReferenceTexts(reference: ScriptAssetReference): string[] {
    const title = normalizeScriptAssetReferenceName(reference.title);
    // 标题就是资产名的情况（脚本资产生成出来的图 / 用户手动改名）—— 最可靠，只看标题。
    if (title && title !== "图片" && title !== "image" && title.length >= 2) return [title];
    const prompt = normalizeScriptAssetReferenceName(reference.prompt);
    // 提示词只在「短」的时候才当名字用：资产描述是短句，场景 / 镜头提示词是长段落，
    // 长文里顺带提到某个道具名不算「这就是那张产品图」。
    return prompt && prompt.length <= 120 ? [title, prompt].filter(Boolean) : [title].filter(Boolean);
}

export type ScriptAssetReferenceMatchOptions = {
    /**
     * 名字对不上的参考图，是否兜底认成「主角道具」（用户 2026-11-09 口径：
     * 「优先将我提供的这个道具图作为分镜表中**出现频率最高**的道具资产链接到道具资产表格中，
     * 注意链接了之后生成资产图时就别生成这个道具资产了」）。默认 **开**。
     *
     * 关掉它 = 回到「名字对不上就什么都不做」的老行为（探针里用得到）。
     */
    heroPropFallback?: boolean;
};

/**
 * 把「反推节点上连进来的参考图」对齐到分镜表里的资产，并算出每张图要挂到哪些格。
 *
 * 两段判定：
 *  ① **按名字**（主路）：参考图名字里包含资产名（或反过来包含），取命中最长的那条 ——
 *     `口红产品图` 同时含 `口红` 与 `口红膏` 时命中 `口红膏`（更具体的那件）。
 *     一张资产只认第一张参考图（先连的优先）。
 *  ② **主角道具兜底**（`heroPropFallback`，默认开）：名字完全对不上的图，按「表里出现镜数」从多到少
 *     挂到还没被占用的道具上。理由：用户既然在反推节点上连了这张图，它就是这条片子的主角道具，
 *     剧本本来就是围着它写的 —— 名字对不上（`产品图.png` / `IMG_2031` / 表里叫 `复古怀表` 而图叫 `老怀表`）
 *     是常态，静默不挂等于让用户白给一张图、还多花一次资产图的钱。
 *     ⚠️ 明显是「已占用资产的第二张图」（名字里含那件资产名，如 `口红实物图` vs 已挂的 `口红`）**不参与兜底** ——
 *     否则会挤掉另一件道具的资产图。挂上之后调用方把它塞进 `skipAssetKeys`，该道具就不再生成资产图。
 *
 * @returns `matches`：按参考图顺序，每条带好 `mounts`（`buildScriptAssetBatchMounts` 的同一份格位）
 *          与 `via`（`name` = 名字命中 / `hero` = 兜底认的主角道具）；
 *          `unmatched`：没对上、也没兜底成的参考图（**不阻塞**流程，只是不参与挂载）。
 */
export function matchScriptAssetReferences(
    rows: readonly StoryScriptRow[] | null | undefined,
    references: readonly ScriptAssetReference[] | null | undefined,
    roles: readonly ScriptAssetRole[] = SCRIPT_ASSET_REFERENCE_ROLE_IDS,
    options: ScriptAssetReferenceMatchOptions = {},
): { matches: ScriptAssetReferenceMatch[]; unmatched: ScriptAssetReference[] } {
    const refs = (references || []).filter((item) => Boolean(item?.nodeId));
    if (!refs.length || !rows?.length) return { matches: [], unmatched: refs };
    const candidates: Array<{ role: ScriptAssetRole; title: string; key: string; norm: string }> = [];
    for (const role of roles) {
        for (const item of collectScriptAssetPromptCandidates(role, rows)) {
            const norm = normalizeScriptAssetReferenceName(item.title);
            // 单字名字（「刀」「碗」）太容易误命中，直接不参与参考图匹配 —— 那种还是老实生图。
            if (norm.length < 2) continue;
            candidates.push({ role, title: item.title, key: scriptAssetBatchKey(role, item.title), norm });
        }
    }
    if (!candidates.length) return { matches: [], unmatched: refs };
    const mountsByKey = buildScriptAssetBatchMounts(rows);
    const claimed = new Set<string>();
    /** 已被认领的资产名（归一化）—— 用来识别「同一件道具的第二张图」，别把它兜底到别的道具上。 */
    const claimedNorms: string[] = [];
    const matches: ScriptAssetReferenceMatch[] = [];
    const unmatched: ScriptAssetReference[] = [];
    for (const reference of refs) {
        const texts = scriptAssetReferenceTexts(reference);
        /**
         * 三档命中，取最高档、同档取名字最长的：
         *  3 = 完全相同（`口红` ↔ `口红`）；
         *  2 = 参考图标题里含资产名（`口红产品图` → `口红`，最常见的一档）；
         *  1 = 资产名里含参考图标题（表里写 `口红膏`、用户只写 `口红`）—— 兜底，档位最低。
         * ⚠️ 档位必须分开：只按「双向包含 + 最长」选，表里同时有 `口红` / `口红膏` 时
         * 一张叫 `口红` 的产品图会被判成 `口红膏`（探针 `reference-picks-longest` 那条的场景反过来）。
         */
        let best: (typeof candidates)[number] | null = null;
        let bestTier = 0;
        for (const candidate of candidates) {
            if (claimed.has(candidate.key)) continue;
            let tier = 0;
            for (const text of texts) {
                if (text === candidate.norm) tier = Math.max(tier, 3);
                else if (text.includes(candidate.norm)) tier = Math.max(tier, 2);
                else if (candidate.norm.includes(text)) tier = Math.max(tier, 1);
            }
            if (!tier) continue;
            if (!best || tier > bestTier || (tier === bestTier && candidate.norm.length > best.norm.length)) {
                best = candidate;
                bestTier = tier;
            }
        }
        if (!best) {
            unmatched.push(reference);
            continue;
        }
        claimed.add(best.key);
        claimedNorms.push(best.norm);
        matches.push({ reference, role: best.role, title: best.title, key: best.key, mounts: mountsByKey[best.key] || [], via: "name" });
    }

    /**
     * ② 主角道具兜底。排序口径必须与「道具资产表」看得到的频率一致：`mountsByKey[key].length`
     * = 这件道具在表里占了几格（道具是一镜一格，所以就是**出现在几镜**）。
     * 只在「道具」上兜底 —— 角色 / 场景有定妆版式与空景要求，拿一张随手拍的产品图去顶会歪。
     */
    const heroFallback = options.heroPropFallback !== false;
    if (heroFallback && unmatched.length) {
        const ranked = candidates
            .filter((candidate) => candidate.role === "prop" && !claimed.has(candidate.key))
            .map((candidate) => ({ ...candidate, shots: mountsByKey[candidate.key]?.length || 0 }))
            .filter((candidate) => candidate.shots > 0)
            // 出现镜数多的优先；同频次取名字更长的（更具体的那件），与名字命中的同档口径一致。
            .sort((left, right) => right.shots - left.shots || right.norm.length - left.norm.length);
        if (ranked.length) {
            const leftovers = unmatched.slice();
            unmatched.length = 0;
            for (const reference of leftovers) {
                const texts = scriptAssetReferenceTexts(reference);
                // 已认领道具的第二张图（`口红实物图` vs 已挂的 `口红`）：退回去当 unmatched，
                // 不能挤掉别的道具的资产图。
                const duplicateOfClaimed = texts.some((text) => claimedNorms.some((norm) => text === norm || text.includes(norm) || norm.includes(text)));
                if (duplicateOfClaimed) {
                    unmatched.push(reference);
                    continue;
                }
                const next = ranked.find((candidate) => !claimed.has(candidate.key));
                if (!next) {
                    unmatched.push(reference);
                    continue;
                }
                claimed.add(next.key);
                claimedNorms.push(next.norm);
                matches.push({ reference, role: next.role, title: next.title, key: next.key, mounts: mountsByKey[next.key] || [], via: "hero" });
            }
        }
    }
    return { matches, unmatched };
}

// ── 排布：脚本节点**左侧**的「资产图阵」─────────────────────────────────────────────

/**
 * 资产图**右边缘** ↔ 脚本节点**左边缘**的水平间距（用户 2026-11-08 改口径）。
 *
 * 旧口径是 300px。问题在于资产图本身很小：`nodeSizeFromRatio("9:16", 340, 240)` 出来的竖版角色图只有
 * **135×240**，300px 的空档比节点还宽一倍多 —— 画面上就是「图飘在左边一条街以外」。
 * 现在收成 48，与单张「添加资产」（`attachScriptAssets` 里那颗 48）同源：贴边、只留一口气。
 */
export const SCRIPT_ASSET_COLUMN_GAP_X = 48;
/** 资产阵里两张图之间的最小间距（同列上下 / 相邻两列左右）。 */
export const SCRIPT_ASSET_COLUMN_MIN_GAP = 24;
/** 行间距自适应时允许的最大间距 —— 再大就散成两截，看着像没排。 */
export const SCRIPT_ASSET_COLUMN_MAX_GAP = 240;
/** 整块被别的节点占住时，往左让开后再留的间距。 */
export const SCRIPT_ASSET_COLUMN_SHIFT_GAP = 48;
/**
 * 资产阵最多排几列（用户 2026-11-08：「紧挨着脚本左侧、不要往下方拖」）。
 *
 * 排法：**竖向先塞满脚本窗口高度，塞不下就往左开新列**，列数封顶 3。
 * 于是三五张资产全部落在脚本窗口左边那一片里，不会有节点被甩到下方几百像素外；
 * 批次再大也只是往下多排一行，不会把画布横向拉到天边。
 */
export const SCRIPT_ASSET_GRID_MAX_COLUMNS = 3;
/**
 * 一批最多**同时**提交几张生图（十几张全打上游容易被限流）。
 *
 * 2026-11-08 口径：**并行 5 张**。原来是 3，用户报障「一键生图现在是一次最多执行 3 张，
 * 我需要增加一键生图的并行数到 5 张」。
 *
 * 三处共用这一个数（改这里就全改，别在调用点写死）：
 *  - `handleBatchGenerateScriptAssets`（一键批量生图）：按它切片 + `Promise.all` 等这一批回来再下一批；
 *  - `handleDirectGenerateScriptAssets`（一键直接生图）：同上；
 *  - 一键视频里的 `retryBatch`（换模型重跑）。
 * ⚠️ 上游有并发/限流就会 429/503，调到 5 是用户实测口径；再往上要用户点头。
 */
export const SCRIPT_ASSET_LAUNCH_BATCH = 5;

export type ScriptAssetRect = { x: number; y: number; width: number; height: number };

export type ScriptAssetLaneSource = { id: string; position: { x: number; y: number }; width: number; height: number };

/** 两张矩形是否真的重叠（留 1px 容差，避免「刚好贴边」被判成打架）。 */
function rectsOverlap(a: ScriptAssetRect, b: ScriptAssetRect) {
    return a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
}

/** 除脚本节点本身之外，所有节点在画布上的占位（资产阵排布的 `occupied`）。 */
export function collectScriptAssetOccupied(nodes: readonly CanvasNodeData[], sourceId: string): ScriptAssetRect[] {
    return nodes.filter((node) => node.id !== sourceId && node.width > 0 && node.height > 0).map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));
}

export type ScriptAssetGridSlot = { x: number; y: number; width: number; height: number };

export type ScriptAssetGridLayout = {
    /** 与入参 `sizes` **一一对应**（同下标 = 同一张图），顺序 = 资产顺序。 */
    slots: ScriptAssetGridSlot[];
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    gapX: number;
    gapY: number;
    /** 整块的外接矩形（让位判断、探针都看它）。 */
    block: ScriptAssetRect;
};

/**
 * 脚本节点**左侧**的资产图阵：贴边、竖向排、塞不下往左开新列。
 *
 * 用户 2026-11-08 报障两条，这里的每一行都是为它们服务的：
 *  ① 「离得太远」→ 右边缘距脚本左边缘只有 `gapX`（48），不是旧的 300；
 *  ② 「有节点被创建到下方」→ 旧实现从脚本**顶边**开始一直往下摞，一列十几张就拖出一条几百像素的长尾。
 *     现在先按脚本窗口高度算「一列能站几行」（`fitRows`），站不下的往**左**开新列（封顶
 *     `SCRIPT_ASSET_GRID_MAX_COLUMNS`），整块再以脚本窗口**垂直中线**为中心摆好 ——
 *     于是所有资产都落在脚本左边那一片，而不是甩到它下面去。
 *
 * 排布方向：第 0 列在最**右**（贴着脚本），往下走完再往左一列。资产顺序是「角色 → 场景 → 道具」，
 * 把第一张放最近，用户一眼就能对上「这张是主角」。
 *
 * 让位：整块（含间距）与已有节点重叠时**整块往左挪** `gapX`（不是逐格往下推）。
 * 逐格往下推是旧实现「第二次生成又往下一截」的根源 —— 块级让位才能保证「再来一批 = 旁边再来一片」。
 * ⚠️ 这里**不再排除**本节点自己的资产图（`scriptAssetLane === 本节点 id`）：新的一批就该让到左边去，
 * 与上一批并列，而不是把上一批当空气、直接盖上去。
 */
export function planScriptAssetGrid(input: {
    source: ScriptAssetLaneSource;
    sizes: ReadonlyArray<{ width: number; height: number }>;
    occupied?: readonly ScriptAssetRect[];
    options?: { maxColumns?: number; gapX?: number; gapY?: number };
}): ScriptAssetGridLayout {
    const sizes = input.sizes;
    const gapX = Math.max(0, input.options?.gapX ?? SCRIPT_ASSET_COLUMN_GAP_X);
    const minGapY = Math.max(0, input.options?.gapY ?? SCRIPT_ASSET_COLUMN_MIN_GAP);
    const occupied = input.occupied || [];
    const originX = input.source.position.x;
    const originY = input.source.position.y;
    const span = Math.max(0, Number(input.source.height) || 0);
    if (!sizes.length) {
        return { slots: [], columns: 0, rows: 0, cellWidth: 0, cellHeight: 0, gapX, gapY: minGapY, block: { x: originX, y: originY, width: 0, height: 0 } };
    }
    const cellWidth = Math.max(1, ...sizes.map((size) => Math.max(1, Number(size.width) || 1)));
    const cellHeight = Math.max(1, ...sizes.map((size) => Math.max(1, Number(size.height) || 1)));
    const maxColumns = Math.min(sizes.length, Math.max(1, Math.round(input.options?.maxColumns ?? SCRIPT_ASSET_GRID_MAX_COLUMNS)));
    // 一列能站几行：脚本窗口越高站得越多（不知道高度时按 1 行算 → 一行一张，横向摊开）。
    const fitRows = span > 0 ? Math.max(1, Math.floor((span + minGapY) / (cellHeight + minGapY))) : 1;
    // 先按「塞满脚本高度」定列数，再被 `maxColumns` 封顶；封顶后只能往下多排几行。
    const columns = Math.min(maxColumns, Math.max(1, Math.ceil(sizes.length / fitRows)));
    const rows = Math.ceil(sizes.length / columns);
    // 行间距：整块比脚本窗口矮时按比例摊开（夹在 [MIN, MAX]）；塞不下就退回最小间距。
    const gapY = rows > 1 && span > 0 ? Math.min(SCRIPT_ASSET_COLUMN_MAX_GAP, Math.max(minGapY, Math.round((span - rows * cellHeight) / (rows - 1)))) : minGapY;
    // 每列按自己最宽的那张算宽（混合画幅时，135 宽的竖版图不该被 340 的横版撑出一大片空白）。
    const columnWidths = Array.from({ length: columns }, (_, column) => {
        const slice = sizes.slice(column * rows, (column + 1) * rows);
        return Math.max(1, ...slice.map((size) => Math.max(1, Number(size.width) || 1)));
    });
    const blockWidth = columnWidths.reduce((sum, width) => sum + width, 0) + (columns - 1) * gapX;
    const blockHeight = rows * cellHeight + (rows - 1) * gapY;
    // 竖向以脚本窗口中线为中心（块比窗口高时上下对称溢出，不会全甩到下方）。
    const top = span > 0 ? originY + (span - blockHeight) / 2 : originY;
    let right = originX - gapX;
    let block: ScriptAssetRect = { x: right - blockWidth, y: top, width: blockWidth, height: blockHeight };
    for (let guard = 0; guard < 32; guard += 1) {
        const hits = occupied.filter((other) => rectsOverlap(other, block));
        if (!hits.length) break;
        right = Math.min(...hits.map((other) => other.x)) - SCRIPT_ASSET_COLUMN_SHIFT_GAP;
        block = { ...block, x: right - blockWidth };
    }
    const slots: ScriptAssetGridSlot[] = [];
    let columnRight = right;
    for (let column = 0; column < columns; column += 1) {
        const columnWidth = columnWidths[column];
        const columnLeft = columnRight - columnWidth;
        sizes.slice(column * rows, (column + 1) * rows).forEach((size, rowIndex) => {
            const width = Math.max(1, Number(size.width) || 1);
            const height = Math.max(1, Number(size.height) || 1);
            slots.push({
                x: columnLeft + (columnWidth - width) / 2,
                y: top + rowIndex * (cellHeight + gapY) + (cellHeight - height) / 2,
                width,
                height,
            });
        });
        columnRight = columnLeft - gapX;
    }
    return { slots, columns, rows, cellWidth, cellHeight, gapX, gapY, block };
}

/**
 * 老版「右侧车道」的右边界 —— **只为已铺好的老画布保留**。
 *
 * 2026-11-07 起资产图改摆**左侧竖列**，新生成的节点不会出现在右边；但存量画布上还躺着
 * 按老规则排在右边的资产图，一键铺链路仍要让开它们，否则分镜链会正好盖在图上。
 * 没有右侧资产图时返回 `null`，调用方据此保持原来的三列起点（与改造前逐像素一致）。
 */
export function scriptAssetLaneRight(nodes: readonly CanvasNodeData[], scriptNodeId: string) {
    const lane = nodes.filter((node) => node.metadata?.scriptAssetLane === scriptNodeId);
    if (!lane.length) return null;
    return Math.max(...lane.map((node) => node.position.x + node.width));
}
