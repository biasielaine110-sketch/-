import {
    getStoryScriptAssetColumns,
    isMultiNameAssetColumn,
    normalizeStoryScriptExtraColumns,
    normalizeStoryScriptNameLockMap,
    resolveScriptAssetRole,
    scriptNameLockName,
    splitScriptAssetNames,
    STORY_SCRIPT_MAX_EXTRA_COLUMNS,
    storyScriptCellText,
    type ScriptAssetRole,
    type StoryScriptExtraColumn,
    type StoryScriptNameLockMap,
    type StoryScriptPresetId,
    type StoryScriptRow,
} from "@/constant/story-script";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeMetadata, type CanvasNodeData } from "@/types/canvas";

/**
 * **跨集沿用资产**：把「第一集用到的资产」搬到「第二集」的脚本节点上。
 *
 * 这套画布里没有独立的资产库对象，一张资产就是**画布上的那个图片节点**，脚本节点靠三层映射认它：
 *  ① 上游连线（资产池）→ 铺链路按分类模糊匹配时用；
 *  ② `scriptNameLocks`（资产名 → 图）→ **跨镜、跨集都成立**，这是跨集沿用最关键的一层；
 *  ③ `scriptCellAssets`（`镜号:列` → 图）→ **只对那一镜成立**，第二集镜号从 1 重排，照搬必然错位。
 *
 * 所以沿用 = 「补连线 + 搬名字 + 搬分类 + 搬自建列（+ 可选搬出片参数）」，**绝不搬逐镜挂图**。
 * 搬完之后第二集分镜表里出现「林晚」「客厅」，铺链路就直接连到第一集那张图，不用逐格重新挂。
 */

/** 一张可以被搬到别的脚本节点的素材（图片 / 音频）。 */
export type ScriptAssetInheritAsset = {
    nodeId: string;
    title: string;
    role: ScriptAssetRole;
    kind: "image" | "audio";
    /** 源集锁到这张图的资产名（`林晚` / `客厅`）。空 = 只是躺在资产池里，没锁过名。 */
    names: string[];
    /** 目标脚本节点已经连着它了 —— 不用再补线，但资产名锁可能还是新的。 */
    linked: boolean;
    /** 弹窗里显示用的缩略图（由上层从「引用条」那套预览里补，纯逻辑层不碰资源地址）。 */
    previewUrl?: string;
};

/** 画布上一个「可以当作上一集」的脚本节点。 */
export type ScriptAssetInheritSource = {
    nodeId: string;
    title: string;
    shotCount: number;
    assets: ScriptAssetInheritAsset[];
    extraColumns: StoryScriptExtraColumn[];
    /** 源集有出片参数（生图比例 / 视频模型 / 时长…）可带。 */
    hasOutput: boolean;
};

/** 沿用范围（弹窗里的勾选项）。 */
export type ScriptAssetInheritOptions = {
    /** 把资产图整体搬进资产池（含没锁过名的那些）。 */
    assets: boolean;
    /** 搬「资产名 → 图」的锁 —— 跨集命中的关键。 */
    locks: boolean;
    /** 搬自建资产列（「宠物」「车辆」）。 */
    columns: boolean;
    /** 搬出片参数（生图比例 / 视频模型 / 画质 / 时长 / 分段…）。 */
    output: boolean;
};

/** 默认只开前三项：出片参数是「顺带」，不该在用户没看的情况下改掉第二集的设置。 */
export const SCRIPT_ASSET_INHERIT_DEFAULT_OPTIONS: ScriptAssetInheritOptions = {
    assets: true,
    locks: true,
    columns: true,
    output: false,
};

/**
 * 「沿用出片参数」搬哪些键 —— **白名单**，绝不对整份 metadata 做浅拷贝：
 * 脚本行 / 逐镜挂图 / 资产锁都不在这个名单里，混进来就会把第二集自己的内容顶掉。
 */
export const SCRIPT_ASSET_INHERIT_OUTPUT_KEYS = [
    "scriptImageSize",
    "scriptCellImageModel",
    "scriptVideoModel",
    "scriptVideoSize",
    "scriptVideoQuality",
    "scriptVideoEngine",
    "scriptTotalSeconds",
    "scriptTotalSecondsUnlimited",
    "scriptSegmentSeconds",
    "scriptMergeMode",
    "scriptShotsPerClip",
    "styleTemplateId",
] as const;

type InheritOutputKey = (typeof SCRIPT_ASSET_INHERIT_OUTPUT_KEYS)[number];

export type ScriptAssetInheritPlan = {
    /** 要补的连线（`fromNodeId` = 资产图，`toNodeId` = 目标脚本节点）。已连的不会出现。 */
    connections: Array<{ fromNodeId: string; toNodeId: string }>;
    /** 目标节点要合并进去的 metadata 片段（角色分类 / 资产锁 / 自建列 / 出片参数）。 */
    metadata: Partial<CanvasNodeMetadata>;
    /** 真正带过来的资产节点 id（用于提示「已沿用 N 个资产、M 个资产名」）。 */
    assetNodeIds: string[];
    /** 真正写进资产锁的名字。 */
    lockNames: string[];
};

/** 素材节点只认图片 / 音频：视频是成片、文本是剧本，都不是「资产」。 */
function inheritAssetKind(node: CanvasNodeData | undefined): "image" | "audio" | null {
    if (!node) return null;
    if (node.type === CanvasNodeType.Audio) return "audio";
    if (node.type === CanvasNodeType.Image) return "image";
    return null;
}

/**
 * 从源脚本节点收集「可沿用的资产」。
 *
 * 来源取**并集**：上游连线的素材（资产池里看得见的）+ 资产锁里指向的图（可能已经从池子里解开，
 * 但名字还锁着 —— 那种图恰恰是跨集最该带的）。顺序：先按连线上游顺序，再补锁里多出来的。
 */
export function collectScriptAssetInheritAssets(params: {
    source: CanvasNodeData;
    targetId: string;
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
}): ScriptAssetInheritAsset[] {
    const { source, targetId, nodes, connections } = params;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const locks = normalizeStoryScriptNameLockMap(source.metadata?.scriptNameLocks);

    const order: string[] = [];
    const push = (id: string) => {
        if (id && !order.includes(id)) order.push(id);
    };
    for (const connection of connections) if (connection.toNodeId === source.id) push(connection.fromNodeId);
    for (const ids of Object.values(locks)) for (const id of ids) push(id);

    const linkedToTarget = new Set(connections.filter((connection) => connection.toNodeId === targetId).map((connection) => connection.fromNodeId));
    const out: ScriptAssetInheritAsset[] = [];
    for (const id of order) {
        const node = byId.get(id);
        const kind = inheritAssetKind(node);
        if (!node || !kind) continue;
        const names = Object.entries(locks)
            .filter(([, ids]) => ids.includes(id))
            .map(([name]) => name);
        out.push({
            nodeId: id,
            title: node.title || id,
            // 音频没有「角色 / 场景」可言，分类固定成 audio，别让默认值把它当成人。
            role: kind === "audio" ? "audio" : resolveScriptAssetRole(source.metadata?.scriptAssetRoles?.[id]),
            kind,
            names,
            linked: linkedToTarget.has(id),
        });
    }
    return out;
}

/** 源集有没有出片参数可带。 */
function hasInheritOutput(metadata: CanvasNodeMetadata | undefined): boolean {
    if (!metadata) return false;
    return SCRIPT_ASSET_INHERIT_OUTPUT_KEYS.some((key) => metadata[key] !== undefined && metadata[key] !== "");
}

/**
 * 画布上所有「可以当作上一集」的脚本节点（排除目标自己）。
 *
 * 排序按画布位置从左到右、从上到下 —— 正常情况下第一集就在第二集左边，弹窗默认选中的那个
 * 往往就是用户想沿用的那一集，省一次点击。
 */
export function collectScriptInheritSources(params: {
    targetId: string;
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
}): ScriptAssetInheritSource[] {
    const { targetId, nodes, connections } = params;
    return nodes
        .filter((node) => node.type === CanvasNodeType.Script && node.id !== targetId)
        .slice()
        .sort((left, right) => left.position.x - right.position.x || left.position.y - right.position.y)
        .map((node) => ({
            nodeId: node.id,
            title: node.title || node.id,
            shotCount: Array.isArray(node.metadata?.scriptRows) ? node.metadata!.scriptRows!.length : 0,
            assets: collectScriptAssetInheritAssets({ source: node, targetId, nodes, connections }),
            extraColumns: normalizeStoryScriptExtraColumns(node.metadata?.scriptExtraColumns),
            hasOutput: hasInheritOutput(node.metadata),
        }));
}

/**
 * 分镜表里出现过的**资产名**（按预设的资产列逐格取，一格多值就拆开）。
 *
 * 自动沿用用它做过滤：只把「这一集真的会用到」的资产锁搬过来 —— 上一集的 12 个角色锁
 * 全灌进第二集，表里一个都没出现的名字就是纯噪音，还会让「已锁定 N 个资产名」这颗开关失真。
 */
export function scriptRowAssetNames(
    rows: readonly StoryScriptRow[] | null | undefined,
    preset: StoryScriptPresetId | string | null | undefined,
    extras?: readonly StoryScriptExtraColumn[] | null,
): string[] {
    const columns = getStoryScriptAssetColumns(preset, extras);
    const names: string[] = [];
    const lower = new Set<string>();
    const push = (value: string) => {
        const name = scriptNameLockName(value);
        if (!name) return;
        const key = name.toLowerCase();
        if (lower.has(key)) return;
        lower.add(key);
        names.push(name);
    };
    for (const row of rows || []) {
        for (const column of columns) {
            const text = storyScriptCellText(row[column.key]);
            if (!text) continue;
            const parts = isMultiNameAssetColumn(column.key, extras) ? splitScriptAssetNames(text) : [text];
            for (const part of parts) push(part);
        }
        // 自建列不在 `getStoryScriptAssetColumns` 之外的可能：它已经把 extras 合进去了。
    }
    return names;
}

/**
 * 算出「把源集的资产搬到目标节点」要做的全部改动。纯函数：不读 store、不建节点。
 *
 * 三条刻意的规则：
 *  ① **不搬逐镜挂图**（`scriptCellAssets` / `scriptRowAssets` / `scriptRowAudios`）——
 *     镜号从 1 重排，搬过去就是错位；
 *  ② 目标节点**已经有同名锁**的不覆盖 —— 用户可能在第二集手工给这个角色换了图，静默顶掉等于丢设置；
 *  ③ 只认**仍然存在**的节点 id —— 上一集的图被删掉了，锁/连线里的脏 id 必须当场过滤，不带进第二集。
 */
export function buildScriptAssetInheritPlan(params: {
    source: CanvasNodeData;
    target: CanvasNodeData;
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
    /** 用户在弹窗里勾中的资产；`null` / 不传 = 全部。 */
    assetNodeIds?: readonly string[] | null;
    options: ScriptAssetInheritOptions;
    /** 只搬这些名字的锁（自动沿用传「新表里出现的资产名」）；`null` / 不传 = 全搬。 */
    onlyNames?: readonly string[] | null;
}): ScriptAssetInheritPlan {
    const { source, target, nodes, connections, options } = params;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const selection = params.assetNodeIds ? new Set(params.assetNodeIds) : null;
    const onlyNames = params.onlyNames ? new Set(params.onlyNames.map((name) => name.toLowerCase())) : null;

    const picked = (id: string) => Boolean(byId.get(id)) && (!selection || selection.has(id));

    // ── 1. 资产名锁 ────────────────────────────────────────────────────────────
    const sourceLocks = normalizeStoryScriptNameLockMap(source.metadata?.scriptNameLocks);
    const targetLocks = normalizeStoryScriptNameLockMap(target.metadata?.scriptNameLocks);
    const targetLockNames = new Set(Object.keys(targetLocks).map((name) => name.toLowerCase()));
    const locks: StoryScriptNameLockMap = {};
    const carried: string[] = [];
    const pushCarried = (id: string) => {
        if (id && !carried.includes(id)) carried.push(id);
    };
    if (options.locks) {
        for (const [name, ids] of Object.entries(sourceLocks)) {
            if (onlyNames && !onlyNames.has(name.toLowerCase())) continue;
            if (targetLockNames.has(name.toLowerCase())) continue;
            const kept = ids.filter((id) => picked(id) && inheritAssetKind(byId.get(id)));
            if (!kept.length) continue;
            locks[name] = kept;
            for (const id of kept) pushCarried(id);
        }
    }

    // ── 2. 资产图（含没锁过名的那几张）────────────────────────────────────────
    if (options.assets) {
        const poolIds = new Set<string>();
        for (const connection of connections) if (connection.toNodeId === source.id) poolIds.add(connection.fromNodeId);
        for (const ids of Object.values(sourceLocks)) for (const id of ids) poolIds.add(id);
        for (const id of poolIds) {
            if (!picked(id) || !inheritAssetKind(byId.get(id))) continue;
            pushCarried(id);
        }
    }

    // ── 3. 连线（已连的不重复补；顺序沿用收集顺序，铺链路时参考图 chip 的顺序才不会乱）──
    const alreadyLinked = new Set(connections.filter((connection) => connection.toNodeId === target.id).map((connection) => connection.fromNodeId));
    const nextConnections = carried
        .filter((id) => !alreadyLinked.has(id))
        .map((id) => ({ fromNodeId: id, toNodeId: target.id }));

    // ── 4. 分类：带着图就必须带着分类，否则铺链路会把它当成「角色」逐镜全连 ──────
    const roles: Record<string, ScriptAssetRole> = {};
    for (const id of carried) {
        const kind = inheritAssetKind(byId.get(id));
        if (!kind) continue;
        roles[id] = kind === "audio" ? "audio" : resolveScriptAssetRole(source.metadata?.scriptAssetRoles?.[id]);
    }

    // ── 5. 自建资产列：按 key 合并，同 key / 同列名都不重复加，到上限就停 ────────
    const metadata: Partial<CanvasNodeMetadata> = {};
    // 分类 / 锁都是**合并进目标已有的那份**（不是整体替换）：目标上还没被沿用的图不能被顺手抹掉。
    if (Object.keys(roles).length) metadata.scriptAssetRoles = { ...(target.metadata?.scriptAssetRoles || {}), ...roles };
    if (Object.keys(locks).length) metadata.scriptNameLocks = { ...targetLocks, ...locks };
    if (options.columns) {
        const targetExtras = normalizeStoryScriptExtraColumns(target.metadata?.scriptExtraColumns);
        const keys = new Set(targetExtras.map((item) => item.key));
        const labels = new Set(targetExtras.map((item) => item.label.trim()));
        const added: StoryScriptExtraColumn[] = [];
        for (const column of normalizeStoryScriptExtraColumns(source.metadata?.scriptExtraColumns)) {
            if (keys.size >= STORY_SCRIPT_MAX_EXTRA_COLUMNS) break;
            if (keys.has(column.key) || labels.has(column.label.trim())) continue;
            keys.add(column.key);
            labels.add(column.label.trim());
            added.push(column);
        }
        if (added.length) metadata.scriptExtraColumns = [...targetExtras, ...added];
    }

    // ── 6. 出片参数：白名单逐键搬，源集没设的键保持目标原样 ────────────────────
    if (options.output) {
        for (const key of SCRIPT_ASSET_INHERIT_OUTPUT_KEYS) {
            const value = source.metadata?.[key as InheritOutputKey];
            if (value === undefined || value === "") continue;
            (metadata as Record<string, unknown>)[key] = value;
        }
    }

    return {
        connections: nextConnections,
        metadata,
        assetNodeIds: carried,
        lockNames: Object.keys(locks),
    };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 资产关联组（用户 2026-11-18 第 02 条：「多个脚本生成器执行「资产关联」后，他们的资产图
// 共用和共同挂载」）
//
// 沿用讲的是「A → B 单向搬一次」；关联组讲的是「A、B、C 共用同一个资产池」：
//   · 建组时把**全组并集**一次性写进每一台机器（锁 / 分类 / 自建列 / 连线）；
//   · 之后任意一台点「一键生图」，会先把组内其它机器已有的同名锁搬过来
//     （`collectScriptAssetGroupPeers` + 只搬名字锁），所以谁先生成过这个角色，别人就直接挂那一张。
//
// 三条与沿用**刻意相同**的规则：不搬逐镜挂图（镜号会重排）、只认仍然存在的图片节点、
// 同名冲突要有确定赢家（否则两台机器各锁一张，用户看到的还是「没共用」）。
// ════════════════════════════════════════════════════════════════════════════════════════

/** 组内排序：先看 x、再看 y —— 04 的集是**纵向**堆叠的（x 相同），所以同 x 时按 y 升序。 */
export function sortScriptAssetGroupNodes(targets: readonly CanvasNodeData[]): CanvasNodeData[] {
    return targets.slice().sort((left, right) => left.position.x - right.position.x || left.position.y - right.position.y);
}

/** 本节点**自己挂的**关联组 id（没有组 = 空串）。 */
export function scriptAssetGroupIdOf(metadata: CanvasNodeMetadata | undefined): string {
    return String(metadata?.scriptAssetGroup || "").trim();
}

/**
 * 能承载「资产关联组」的节点类型（用户 2026-11-20：
 * 「在文本节点的时候关联，以及反推视频节点关联，都能达到资产关联的效果」）。
 *
 * 为什么只有这三种：
 *  · `Script` —— 真正的资产池（有 `scriptNameLocks`，跨镜 / 跨集唯一可靠的映射）；
 *  · `Text` / `ReverseVideo` —— **纯载体**：自己不存锁、不存资产，只把组 id 顺着连线往下游传，
 *    于是「先做第一集、后面继续做第二集」可以在**拆集之前**就把两批绑进同一个池子，
 *    不必等脚本生成器都建出来再右键关联（那时候用户早批量跑完了）。
 *
 * 其它类型（图片 / 视频 / 分组框 / 对话）不掺和：它们进组没有下游可传，只会让右键菜单到处冒出来。
 */
export const SCRIPT_ASSET_GROUP_CARRIER_TYPES: readonly CanvasNodeType[] = [
    CanvasNodeType.Script,
    CanvasNodeType.Text,
    CanvasNodeType.ReverseVideo,
];

/** 这个节点能不能挂关联组（脚本生成器 / 文本 / 反推视频）。 */
export function isScriptAssetGroupCarrier(node: CanvasNodeData | undefined): boolean {
    return Boolean(node && SCRIPT_ASSET_GROUP_CARRIER_TYPES.includes(node.type as CanvasNodeType));
}

/**
 * 本节点**生效的**组 id：自己挂的优先；自己没挂就顺着**上游**找载体。
 *
 * 为什么要往上游找：载体（文本 / 反推）只是把 id 传下去，脚本生成器可能是
 *   · 04 一次建好的（那时已经写进去了）；
 *   · 也可能是用户后来自己从文本节点「一键视频」建出来的（新节点没有字段）。
 * 只认自己那份字段，第二条路就会漏 —— 用户看到的就是「文本节点关联了，第二集还是在重新生图」。
 * 逐层向上找（脚本 ← 文本 ← 反推）刚好覆盖两条链路，且天然不会跨到隔壁那一集去。
 *
 * @param connections 不传 = 只认自己挂的那份（纯函数探针用）。
 */
export function resolveScriptAssetGroupId(
    node: CanvasNodeData | undefined,
    nodes: readonly CanvasNodeData[] = [],
    connections: readonly CanvasConnection[] = [],
): string {
    if (!node) return "";
    const own = scriptAssetGroupIdOf(node.metadata);
    if (own) return own;
    if (!nodes.length || !connections.length) return "";
    const byId = new Map(nodes.map((item) => [item.id, item]));
    const seen = new Set<string>([node.id]);
    const queue = connections.filter((connection) => connection.toNodeId === node.id).map((connection) => connection.fromNodeId);
    while (queue.length) {
        const id = queue.shift() as string;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const upstream = byId.get(id);
        if (!upstream) continue;
        const groupId = scriptAssetGroupIdOf(upstream.metadata);
        if (groupId) return groupId;
        // 上游也没挂？再往上（文本节点的上游是反推 / 对话 / 另一个文本）。
        for (const connection of connections) if (connection.toNodeId === id) queue.push(connection.fromNodeId);
    }
    return "";
}

/**
 * 同组的**其它**脚本节点（排除自己、排除被删掉的）。
 *
 * 判定用 `resolveScriptAssetGroupId`：自己挂的、或从上游文本 / 反推节点继承来的，
 * 都算同一组 —— 这样「只关联了文本节点」的那一集也能被别人的生图认出来。
 * 没有组时返回空数组：没建组的画布一个字节都不变。
 */
export function collectScriptAssetGroupPeers(
    node: CanvasNodeData | undefined,
    nodes: readonly CanvasNodeData[],
    connections: readonly CanvasConnection[] = [],
): CanvasNodeData[] {
    const groupId = resolveScriptAssetGroupId(node, nodes, connections);
    if (!node || !groupId) return [];
    return sortScriptAssetGroupNodes(
        nodes.filter(
            (item) =>
                item.id !== node.id &&
                item.type === CanvasNodeType.Script &&
                resolveScriptAssetGroupId(item, nodes, connections) === groupId,
        ),
    );
}

export type ScriptAssetSharePlan = {
    groupId: string;
    /** 要补的连线（每台机器一份，已连的不会出现）。 */
    connections: Array<{ fromNodeId: string; toNodeId: string }>;
    /** 每台机器要合并的 metadata 片段。组内**没有成员**时为空。 */
    metadata: Record<string, Partial<CanvasNodeMetadata>>;
    /** 组内并集里仍然存在的资产节点 id。 */
    assetNodeIds: string[];
    /** 写进资产锁的名字（并集）。 */
    lockNames: string[];
    /**
     * 同一个资产名在不同机器上锁了不同图 —— 已按组内顺序（先左后右、先上后下）取**第一个**当赢家。
     * 上层要把这些名字报给用户：静默顶掉等于丢设置。
     */
    conflicts: Array<{ name: string; keptNodeId: string; overriddenNodeIds: string[] }>;
    /** 并集之后仍然缺失（被删掉）的资产名 —— 提示用，"锁着但图没了"。 */
    missingNames: string[];
};

/**
 * 算出「把这一组节点串成共用资产池」要做的全部改动。纯函数：不读 store、不建节点。
 *
 * `targets` 可以是混选（脚本 + 文本 + 反推视频）：
 *  · 脚本生成器之间才搬锁 / 分类 / 自建列 / 连线（只有它存得下这些东西）；
 *  · 文本 / 反推视频只是**载体**，拿到 `scriptAssetGroup` 就够 —— 之后从它们拆出来的脚本
 *    会靠 `resolveScriptAssetGroupId()` 认到同一个组（用户 2026-11-20 的「提前关联」）。
 *
 * @param params.groupId 组 id（由调用方生成；同一批节点写同一个值）
 * @param params.options 默认「资产 + 锁 + 自建列」，**不搬出片参数**（各集可以有自己的时长 / 模型）
 */
export function buildScriptAssetSharePlan(params: {
    targets: readonly CanvasNodeData[];
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
    groupId: string;
    options?: Partial<ScriptAssetInheritOptions>;
}): ScriptAssetSharePlan {
    const options: ScriptAssetInheritOptions = { ...SCRIPT_ASSET_INHERIT_DEFAULT_OPTIONS, ...(params.options || {}) };
    const byId = new Map(params.nodes.map((node) => [node.id, node]));
    const alive = (id: string) => Boolean(byId.get(id)) && Boolean(inheritAssetKind(byId.get(id)));
    const ordered = sortScriptAssetGroupNodes(params.targets.filter(isScriptAssetGroupCarrier));
    /** 只有脚本生成器能存锁 / 分类 / 自建列 / 资产池；载体只吃组 id。 */
    const scriptOrdered = ordered.filter((node) => node.type === CanvasNodeType.Script);

    const plan: ScriptAssetSharePlan = {
        groupId: params.groupId,
        connections: [],
        metadata: {},
        assetNodeIds: [],
        lockNames: [],
        conflicts: [],
        missingNames: [],
    };
    if (ordered.length < 2) return plan;

    // ── 1. 锁的并集：同一名字以组内**第一个**拥有它的机器为准（冲突要能说清是谁赢）──
    const winners = new Map<string, { ids: string[]; nodeId: string }>();
    const missing = new Map<string, string>();
    for (const node of scriptOrdered) {
        const locks = normalizeStoryScriptNameLockMap(node.metadata?.scriptNameLocks);
        for (const [name, ids] of Object.entries(locks)) {
            const kept = ids.filter(alive);
            if (!kept.length) {
                if (!missing.has(name)) missing.set(name, node.id);
                continue;
            }
            if (!winners.has(name)) winners.set(name, { ids: kept, nodeId: node.id });
        }
    }
    plan.lockNames = Array.from(winners.keys());
    plan.missingNames = Array.from(missing.keys());

    // ── 2. 分类的并集：同一张图以第一个给它分类的机器为准 ────────────────────
    const roles: Record<string, ScriptAssetRole> = {};
    for (const node of scriptOrdered) {
        for (const [id, role] of Object.entries(node.metadata?.scriptAssetRoles || {})) {
            if (!alive(id) || roles[id]) continue;
            roles[id] = inheritAssetKind(byId.get(id)) === "audio" ? "audio" : resolveScriptAssetRole(role);
        }
    }

    // ── 3. 资产池：所有机器的上游连线 + 所有锁指向的图 ────────────────────────
    const pool: string[] = [];
    const pushPool = (id: string) => {
        if (id && alive(id) && !pool.includes(id)) pool.push(id);
    };
    for (const node of scriptOrdered) {
        for (const connection of params.connections) if (connection.toNodeId === node.id) pushPool(connection.fromNodeId);
        for (const ids of Object.values(normalizeStoryScriptNameLockMap(node.metadata?.scriptNameLocks))) for (const id of ids) pushPool(id);
    }
    plan.assetNodeIds = pool;
    const poolSet = new Set(pool);

    // ── 4. 自建列的并集（按 key / 列名去重，到上限就停）─────────────────────
    const extrasUnion: StoryScriptExtraColumn[] = [];
    const extraKeys = new Set<string>();
    const extraLabels = new Set<string>();
    for (const node of scriptOrdered) {
        for (const column of normalizeStoryScriptExtraColumns(node.metadata?.scriptExtraColumns)) {
            if (extrasUnion.length >= STORY_SCRIPT_MAX_EXTRA_COLUMNS) break;
            if (extraKeys.has(column.key) || extraLabels.has(column.label.trim())) continue;
            extraKeys.add(column.key);
            extraLabels.add(column.label.trim());
            extrasUnion.push(column);
        }
    }

    // ── 5. 逐机器落 metadata / 连线 ─────────────────────────────────────────
    ordered.forEach((node) => {
        /** 载体只写组 id：它没有锁 / 分类 / 资产池，写了也读不到，只会把 metadata 撑大。 */
        const patch: Partial<CanvasNodeMetadata> = { scriptAssetGroup: params.groupId };
        if (node.type !== CanvasNodeType.Script) {
            plan.metadata[node.id] = patch;
            return;
        }

        const ownLocks = normalizeStoryScriptNameLockMap(node.metadata?.scriptNameLocks);
        const mergedLocks: StoryScriptNameLockMap = { ...ownLocks };
        for (const [name, winner] of winners) {
            const own = mergedLocks[name];
            const same = own && own.filter(alive).length === winner.ids.length && winner.ids.every((id) => own.includes(id));
            if (same) continue;
            if (own && own.length && winner.nodeId !== node.id) {
                const conflict = plan.conflicts.find((item) => item.name === name);
                if (conflict) {
                    if (!conflict.overriddenNodeIds.includes(node.id)) conflict.overriddenNodeIds.push(node.id);
                } else {
                    plan.conflicts.push({ name, keptNodeId: winner.nodeId, overriddenNodeIds: [node.id] });
                }
            }
            mergedLocks[name] = winner.ids;
        }

        if (options.locks && Object.keys(mergedLocks).length) patch.scriptNameLocks = mergedLocks;
        if (options.assets && Object.keys(roles).length) patch.scriptAssetRoles = { ...(node.metadata?.scriptAssetRoles || {}), ...roles };
        if (options.columns && extrasUnion.length) patch.scriptExtraColumns = extrasUnion;
        /**
         * 组内**第一个脚本生成器**当「上一集」：分镜表重生成时的自动沿用（`scriptAssetInheritAuto`）
         * 走的就是这个来源。第一个自己不需要（它没有上游）。
         * 只有脚本生成器能当来源 —— 载体（文本 / 反推）身上没有 `scriptNameLocks`，
         * 记成来源等于让自动沿用空跑一趟。
         */
        const anchor = scriptOrdered[0];
        if (anchor && anchor.id !== node.id) {
            patch.scriptAssetInheritAuto = true;
            patch.scriptAssetInheritSource = anchor.id;
        }
        plan.metadata[node.id] = patch;

        if (!options.assets) return;
        const linked = new Set(params.connections.filter((connection) => connection.toNodeId === node.id).map((connection) => connection.fromNodeId));
        for (const id of poolSet) {
            if (linked.has(id)) continue;
            plan.connections.push({ fromNodeId: id, toNodeId: node.id });
        }
    });

    return plan;
}
