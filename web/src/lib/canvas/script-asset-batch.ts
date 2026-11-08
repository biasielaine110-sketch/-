import {
    collectScriptAssetCellTargets,
    collectScriptAssetPromptCandidates,
    normalizeStoryScriptCellAssetMap,
    normalizeStoryScriptNameLockMap,
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
 *  - 摆哪儿：批量出来的图排在脚本节点**左侧的一列**（距脚本左边缘 300px，上下顺序，列高随脚本窗口
 *    高度自适应），并且要避开已有的资产图 / 已经铺好的分镜链路，否则第二次生成会和第一批叠在一起。
 *
 * 竖列上的节点依然带 `metadata.scriptAssetLane = 脚本节点 id`（字段名沿用旧版，见 types/canvas.ts）：
 * 它既是「这批是本节点生成的」标记，也是「铺链路让位」与「续排」的判据。
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
 * 把它混进来既浪费额度，又会让左侧竖列里夹进一堆画风完全不同的示意图。
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

/** 某一类资产「一键直接生图」时用的画幅 —— 纯查表，没有 override 这条路。 */
export function resolveScriptAssetDirectSize(role: ScriptAssetRole): string {
    return SCRIPT_ASSET_DIRECT_SIZE_BY_ROLE[role] || "16:9";
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
export const SCRIPT_ASSET_VIEW_TEMPLATE_RULES: Array<{ role: ScriptAssetRole; label: string; groups: string[][] }> = [
    { role: "character", label: "角色视图 · 无头 9:16 竖版排版", groups: [["角色视图"], ["无头"]] },
    { role: "scene", label: "场景视图 · 2x2 场景宫格图", groups: [["场景视图"], ["2x2", "宫格"]] },
];

/** 标题归一化：去空格 / 各种横线 / 括号 / 标点，`×` 统一成 `x`，再转小写。 */
export function normalizeScriptViewTemplateTitle(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[×✕✖]/g, "x")
        .replace(/[\s\-—–－_·•.。:：,，、;；/\\|()（）\[\]【】{}"'“”‘’]+/g, "");
}

type ViewTemplatePromptEntry = { title?: string; content?: string; enabled?: boolean };

/**
 * 从词库里捞出这一分类要追加的版式正文；没有 → 空串。
 * 同一个分类命中多条时取**词库顺序第一条**（用户的排序就是优先级），关掉的条目跳过。
 */
export function resolveScriptAssetViewTemplate(role: ScriptAssetRole, textPrompts?: readonly ViewTemplatePromptEntry[] | null): string {
    const rule = SCRIPT_ASSET_VIEW_TEMPLATE_RULES.find((item) => item.role === role);
    if (!rule) return "";
    for (const entry of textPrompts || []) {
        if (entry?.enabled === false) continue;
        const content = String(entry?.content ?? "").trim();
        if (!content) continue;
        const title = normalizeScriptViewTemplateTitle(entry?.title);
        if (!title) continue;
        const hit = rule.groups.every((group) => group.some((keyword) => title.includes(normalizeScriptViewTemplateTitle(keyword))));
        if (hit) return content;
    }
    return "";
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

/** 词库视图版式的追加（等价于 `appendScriptAssetPromptSuffix`，名字保留旧口径）。 */
export function appendScriptAssetViewTemplate(prompt: string, template: string): string {
    return appendScriptAssetPromptSuffix(prompt, template);
}

/**
 * 「一键直接生图」的入口包装：给这一批的提示词按分类补上词库版式。
 *
 * 只作用于**直接生图**这一条路（画幅同样是硬规则那一条）。「一键批量生成」/「单格生成」保持原样 ——
 * 那两条是用户手动挑资产，要不要带版式由他在弹窗里自己决定。
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

// ── 「一键直接生图」的固定尾缀：场景空景 + 画幅收口 ────────────────────────────────

/**
 * 场景资产图的**空景**尾缀（用户 2026-11-08）：
 * 「场景出图时，添加一个后缀，即图片中不要出现人物角色，为场景的空景展示。」
 *
 * 为什么要写进提示词，而不是只靠 `size`：
 *  - 场景图是拿来当**背景/空间参考**的，混进人物会污染后面所有分镜（视频里「场景里多个人」的根源）；
 *  - 生图模型对「否定词」不敏感，所以不只写「不要人物」，还把「要什么」写全（建筑 / 陈设 / 环境 / 光线）。
 */
export const SCRIPT_ASSET_EMPTY_SCENE_SUFFIX =
    "空景要求：画面中不要出现任何人物角色——没有人物、没有人脸、没有背影或剪影、没有人群、没有手部特写，只表现场景本身的建筑、陈设、环境与光线，作为后续分镜的空镜背景。";

/**
 * 画幅收口尾缀：把「9:16 / 16:9」**写成提示词最后一行**。
 *
 * 为什么需要它：`size` 参数只对「认这个字段的模型」有效 —— 有的中转 / 有的模型家族会收下
 * `size` 却按提示词排版（尤其当词库版式里写了别的画幅时，模型会跟着版式走，出方图）。
 * 用户 2026-11-08 报障「角色出图现在出来的是 1x1 的，应该是 9x16」就是这一路。
 *
 * ⚠️ 两个口径必须**同源**：文字里的比例由 `resolveScriptAssetDirectSize()` 推出来，
 * 不许另写一份常量，否则「画幅硬规则」与「提示词里写的画幅」会漂。
 */
export function buildScriptAssetFrameSuffix(role: ScriptAssetRole): string {
    const size = resolveScriptAssetDirectSize(role);
    if (size === "9:16") return "画面比例：9:16 竖版（宽:高 = 9:16），整张图按竖构图排版，不要做成 1:1 方图或横图。";
    if (size === "16:9") return "画面比例：16:9 横版（宽:高 = 16:9），整张图按横构图排版，不要做成 1:1 方图或竖图。";
    return `画面比例：${size}，整张图按这个比例排版。`;
}

/**
 * 「一键直接生图」提示词的**最终整形**（顺序即语义，不能乱）：
 *
 *  1. 资产描述（分镜表里那一格）—— 最前，权重最高；
 *  2. 词库视图版式（角色 / 场景各一条，见 `SCRIPT_ASSET_VIEW_TEMPLATE_RULES`）；
 *  3. 场景 → 空景尾缀（只在场景加，角色 / 道具不加）；
 *  4. 画幅尾缀 —— **永远最后一行**，用来压过前面版式里可能写死的画幅。
 *
 * 每一步都幂等：同一批重算、或用户手动把尾缀粘进提示词后再点，都不会出现两份。
 */
export function applyScriptAssetDirectDecorations(items: readonly ScriptAssetBatchItem[], textPrompts?: readonly ViewTemplatePromptEntry[] | null): ScriptAssetBatchItem[] {
    if (!items.length) return [];
    return applyScriptAssetViewTemplates(items, textPrompts).map((item) => {
        let prompt = item.prompt;
        if (item.role === "scene") prompt = appendScriptAssetPromptSuffix(prompt, SCRIPT_ASSET_EMPTY_SCENE_SUFFIX);
        prompt = appendScriptAssetPromptSuffix(prompt, buildScriptAssetFrameSuffix(item.role));
        return prompt === item.prompt ? item : { ...item, prompt };
    });
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

// ── 排布：脚本节点**左侧**的「资产竖列」─────────────────────────────────────────────

/**
 * 竖列与脚本节点**左边缘**的水平间距。用户口径就一句：「紧挨着脚本窗口的最左侧，
 * 距离脚本窗口大概间隔 300px」。所以是「图右边缘 → 脚本左边缘 = 300px」，不是 300 起算。
 */
export const SCRIPT_ASSET_COLUMN_GAP_X = 300;
/** 竖列里两张图之间的最小间距。 */
export const SCRIPT_ASSET_COLUMN_MIN_GAP = 24;
/** 自适应脚本节点高度时允许的最大间距 —— 再大就散成两截，看着像没排。 */
export const SCRIPT_ASSET_COLUMN_MAX_GAP = 240;
/** 竖列被别的节点占住时，整条往左让开后再留的间距。 */
export const SCRIPT_ASSET_COLUMN_SHIFT_GAP = 48;
/** 一批最多同时提交几张生图（十几张一起打上游容易被限流）。 */
export const SCRIPT_ASSET_LAUNCH_BATCH = 3;

export type ScriptAssetRect = { x: number; y: number; width: number; height: number };

export type ScriptAssetLaneSource = { id: string; position: { x: number; y: number }; width: number; height: number };

/** 两张矩形是否真的重叠（留 1px 容差，避免「刚好贴边」被判成打架）。 */
function rectsOverlap(a: ScriptAssetRect, b: ScriptAssetRect) {
    return a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
}

/**
 * 竖列起点（= 这一列**左边缘**的 x）。
 *
 * 默认在脚本节点左侧 300px 处；**这一竖条已经被别的节点占了就整条往左让**（同 X 区间就算占，
 * 与右侧那版同口径 —— 竖列是整条贯穿的，不按 Y 逐段挑空隙）。
 * 本节点自己的资产图（`scriptAssetLane === 本节点 id`）不算占位 —— 否则第二次生成会把列推得越来越远。
 */
export function resolveScriptAssetColumnX(source: ScriptAssetLaneSource, nodes: readonly CanvasNodeData[], cellWidth: number) {
    const width = Math.max(1, cellWidth);
    let right = source.position.x - SCRIPT_ASSET_COLUMN_GAP_X;
    for (let guard = 0; guard < 32; guard += 1) {
        const left = right - width;
        const blockers = nodes.filter(
            (node) => node.id !== source.id && node.metadata?.scriptAssetLane !== source.id && node.position.x < right - 1 && node.position.x + node.width > left + 1,
        );
        if (!blockers.length) return left;
        right = Math.min(...blockers.map((node) => node.position.x)) - SCRIPT_ASSET_COLUMN_SHIFT_GAP;
    }
    return right - width;
}

/**
 * 把一批资产图排成**一列**（从上到下），列高按脚本节点高度适配。
 *
 * - 间距自适应：`(脚本高 - 整列图高) / 间隔数` 夹进 `[MIN_GAP, MAX_GAP]`。脚本窗口拉高 → 图跟着摊开；
 *   图太多、整列比脚本窗口还高 → 退回 `MIN_GAP` 往下溢出（**不缩图**：用户要看清楚资产）。
 * - 已被占住的格子往下挪（只有一列，没有「换行」这一步），挪完继续按原节奏往下走。
 */
export function planScriptAssetColumn(
    origin: { x: number; y: number },
    sizes: ReadonlyArray<{ width: number; height: number }>,
    occupied: readonly ScriptAssetRect[],
    options?: { gap?: number; span?: number },
): Array<{ x: number; y: number }> {
    if (!sizes.length) return [];
    const minGap = Math.max(0, options?.gap ?? SCRIPT_ASSET_COLUMN_MIN_GAP);
    const cellWidth = Math.max(1, ...sizes.map((size) => size.width));
    const cellHeight = Math.max(1, ...sizes.map((size) => size.height));
    const span = Number(options?.span) || 0;
    let gap = minGap;
    if (span > 0 && sizes.length > 1) {
        const slack = (span - cellHeight * sizes.length) / (sizes.length - 1);
        gap = Math.min(SCRIPT_ASSET_COLUMN_MAX_GAP, Math.max(minGap, Math.round(slack)));
    }
    const placed: Array<{ x: number; y: number }> = [];
    let cursorY = origin.y;
    for (const size of sizes) {
        const x = origin.x + (cellWidth - size.width) / 2;
        let rect: ScriptAssetRect = { x, y: cursorY + (cellHeight - size.height) / 2, width: size.width, height: size.height };
        for (let guard = 0; guard <= occupied.length + 8; guard += 1) {
            const hit = occupied.find((other) => rectsOverlap(other, rect));
            if (!hit) break;
            cursorY = hit.y + hit.height + minGap;
            rect = { x, y: cursorY + (cellHeight - size.height) / 2, width: size.width, height: size.height };
        }
        placed.push({ x: rect.x, y: rect.y });
        cursorY += cellHeight + gap;
    }
    return placed;
}

/** 除脚本节点本身之外，所有节点在画布上的占位（竖列排布的 `occupied`）。 */
export function collectScriptAssetOccupied(nodes: readonly CanvasNodeData[], sourceId: string): ScriptAssetRect[] {
    return nodes.filter((node) => node.id !== sourceId && node.width > 0 && node.height > 0).map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));
}

/**
 * 「一键直接生图」的竖列排布 —— 与 `planScriptAssetColumn` 同一条列（同一个起点、同一套让位规则），
 * 唯一区别：**每张图按自己的真实高度往下摞**，不再塞进统一的方格里居中。
 *
 * 为什么不能直接用 `planScriptAssetColumn`：它假设整批同一个画幅（`cellHeight = max(高)`，
 * 每张在图格里居中）。而「一键直接生图」是角色 9:16 + 场景 / 道具 16:9 混一批，
 * 一张 320×569 的方格里塞一张 320×180 的横图，中间会空出两百多像素的白，一列看着像断成两截。
 * 按真实高度摞起来才是用户要的「跟批量生成一样的排布」：还是一列、还是紧挨脚本左侧、还是避让已有节点。
 */
export function planScriptDirectAssetColumn(
    origin: { x: number; y: number },
    sizes: ReadonlyArray<{ width: number; height: number }>,
    occupied: readonly ScriptAssetRect[],
    options?: { gap?: number; span?: number },
): Array<{ x: number; y: number }> {
    if (!sizes.length) return [];
    const minGap = Math.max(0, options?.gap ?? SCRIPT_ASSET_COLUMN_MIN_GAP);
    const cellWidth = Math.max(1, ...sizes.map((size) => size.width));
    const totalHeight = sizes.reduce((sum, size) => sum + Math.max(1, size.height), 0);
    const span = Number(options?.span) || 0;
    let gap = minGap;
    if (span > 0 && sizes.length > 1) {
        const slack = (span - totalHeight) / (sizes.length - 1);
        gap = Math.min(SCRIPT_ASSET_COLUMN_MAX_GAP, Math.max(minGap, Math.round(slack)));
    }
    const placed: Array<{ x: number; y: number }> = [];
    let cursorY = origin.y;
    for (const size of sizes) {
        const width = Math.max(1, size.width);
        const height = Math.max(1, size.height);
        // 同一列居中：混合画幅时左右边缘不齐，居中最稳（窄的 9:16 不会贴着左边线）。
        const x = origin.x + (cellWidth - width) / 2;
        let y = cursorY;
        for (let guard = 0; guard <= occupied.length + 8; guard += 1) {
            const hit = occupied.find((other) => rectsOverlap(other, { x, y, width, height }));
            if (!hit) break;
            y = hit.y + hit.height + minGap;
        }
        placed.push({ x, y });
        cursorY = y + height + gap;
    }
    return placed;
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
