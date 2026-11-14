import {
    getStoryScriptAssetColumns,
    isMultiNameAssetColumn,
    normalizeStoryScriptNameLockMap,
    resolveScriptAssetRole,
    scriptAssetColumnRole,
    scriptNameLockName,
    splitScriptAssetNames,
    storyScriptAssetNameSimilarity,
    storyScriptCellText,
    STORY_SCRIPT_ASSET_MATCH_THRESHOLD,
    type ScriptAssetRole,
    type StoryScriptExtraColumn,
    type StoryScriptNameLockMap,
    type StoryScriptPresetId,
    type StoryScriptRow,
} from "@/constant/story-script";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * **预挂资产对齐**：把「已经连到脚本节点的图」按**名字相近**对上分镜表里的资产列，锁成
 * 「资产名 → 图」，从而做到「先备好角色 / 场景图，批量生图时不再二次生成」。
 *
 * 用户原话（2026-11-13）：「把特定的图连到脚本生成器，然后把图片的名字改成剧本对应的资产名字，
 * 这个名字不用跟剧本完全一致，大概相关就行，然后自动链接上到表里，就不二次生成了。」
 *
 * 三个既有事实决定了实现方式（改这块前先读）：
 *  ① 「相近」的口径**已经存在**：`storyScriptAssetNameSimilarity`（去 `P-01` 编号 / 去括号注释 /
 *     去标点空白，双向包含 0.9，其余取 Dice 与 Jaccard 的较大值，≥ 0.5 算同一资产），铺链路的
 *     `matchScriptRowAssetsByRole` 一直在用它 —— 这里必须复用同一个门槛，否则「铺链路认了、
 *     批量生图却还认为没出过图」，用户会看到同一张图既被引用又被重新生成；
 *  ② 表里「这一格挂了哪张图」由 `scriptNameLocks`（名字 → 图，跨镜跨集）与 `scriptCellAssets`
 *     （镜号:列 → 图，只对那一镜）决定，**格子里会显示名字锁落下来的图**。所以对齐只需要写名字锁
 *     —— 不写逐镜挂图，避免第二集 / 调序后镜号错位；
 *  ③ 素材的「分类」在 `scriptAssetRoles`，铺链路按分类分组后才做名字匹配。**标题对上了但分类不对，
 *     等于没对上**（一张图默认是「角色」，而它其实要当「场景」用）。所以对齐顺带把分类修正过来。
 */

/** 一张已经连到脚本节点的图（对齐的输入；只有 id 和标题，标题就是用户改的那个名字）。 */
export type ScriptAssetAlignCandidate = { nodeId: string; title: string };

/** 一张已经连到脚本节点的图，在表里对上了哪一个资产名。 */
export type ScriptAssetAlignMatch = {
    nodeId: string;
    /** 画布上这张图的标题（用户起的名字，不必和表里一致）。 */
    title: string;
    /** 表里命中的资产名（**原样**，用于写锁 —— 锁是按格子原文查的）。 */
    name: string;
    /** 表里命中位置所属的分类（决定铺链路拿它当角色 / 场景 / 道具）。 */
    role: ScriptAssetRole;
    /** 这张图当前的分类（和 `role` 不一致就会被修正）。 */
    currentRole: ScriptAssetRole;
    /** 表里出现了几次（同名的多个镜头 / 多列）。 */
    hits: number;
};

export type ScriptAssetAlignPlan = {
    /** 真写进锁里的那些（含「本来就锁好了」的，便于 UI 报数）。 */
    matches: ScriptAssetAlignMatch[];
    /** 名字对上了、但那个名字已经锁给别的图 → 不覆盖，交回用户决定。 */
    conflicts: Array<{ nodeId: string; title: string; name: string; lockedIds: string[] }>;
    /** 一个名字都没对上的素材（标题太放飞 / 表里没这件资产）。 */
    unmatched: Array<{ nodeId: string; title: string }>;
    /** 要合并进脚本节点 metadata 的补丁：`scriptNameLocks`（+ 必要时 `scriptAssetRoles`）。 */
    metadata: Partial<CanvasNodeMetadata>;
    /** 这次**新写入**的锁数量（不含本来就锁好的）。 */
    newLockCount: number;
    /** 这次被修正分类的素材数量。 */
    roleFixCount: number;
};

/**
 * 「这张素材算不算这个资产」—— 批量生图与对齐共用同一口径。
 *
 * 只看标题与资产名的相似度（**不看分类**）：分类由调用方负责过滤（`resolveScriptAssetExistingNodeIds`
 * 做分类守卫、`matchScriptRowAssetsByRole` 分组）。分开写是为了让「批量生图判定已出图」与
 * 「对齐写锁」永远不会用两套门槛。
 */
export function isSameScriptAssetByName(left: unknown, right: unknown): boolean {
    const a = scriptNameLockName(left);
    const b = scriptNameLockName(right);
    if (!a || !b) return false;
    return storyScriptAssetNameSimilarity(a, b) >= STORY_SCRIPT_ASSET_MATCH_THRESHOLD;
}

/** 从画布状态里捞出「连到本节点的图片」—— 对齐的唯一素材来源（视频是成片、文本是剧本，都不算）。 */
export function collectScriptAssetAlignCandidates(params: {
    scriptNodeId: string;
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
}): ScriptAssetAlignCandidate[] {
    const { scriptNodeId, nodes, connections } = params;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const out: ScriptAssetAlignCandidate[] = [];
    const seen = new Set<string>();
    for (const connection of connections) {
        if (connection.toNodeId !== scriptNodeId) continue;
        const node = byId.get(connection.fromNodeId);
        if (!node || node.type !== CanvasNodeType.Image) continue;
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        out.push({ nodeId: node.id, title: node.title || "" });
    }
    return out;
}

/**
 * 批量生图用：给定候选（分类 + 资产名），返回「已经有图了」的节点 id。
 *
 * 两级判定：
 *  - 名字相近（`isSameScriptAssetByName`）→ 用户把图改名成「林晚 定妆（正面）」也算「林晚」有图；
 *  - **分类守卫**：素材在 `scriptAssetRoles` 里明确分类过时，分类必须一致 ——
 *    否则一张角色图「林晚」会把场景「林晚的卧室」也算成已有图（包含关系 0.9），那一镜就少一张场景。
 *    没分类（默认落在 character）的素材只按名字认：用户刚拖进来的图还没来得及分类，
 *    不能因此跳过它。
 */
export function resolveScriptAssetExistingNodeIds(
    role: ScriptAssetRole,
    title: string,
    existing: readonly { nodeId: string; title: string; role?: ScriptAssetRole | string | null }[],
): string[] {
    const target = resolveScriptAssetRole(role);
    const ids: string[] = [];
    for (const asset of existing) {
        if (!asset?.nodeId) continue;
        if (!isSameScriptAssetByName(asset.title, title)) continue;
        if (asset.role && resolveScriptAssetRole(asset.role) !== target) continue;
        if (!ids.includes(asset.nodeId)) ids.push(asset.nodeId);
    }
    return ids;
}

type AlignSlot = { name: string; role: ScriptAssetRole; order: number };

/**
 * 算出「把已连素材按名字对齐到表里并上锁」的完整计划。纯函数：不读 store、不建节点。
 *
 * 匹配是**分档**的（同档再按重叠长度、再按表里出现次序）：完全同名 > 一方包含另一方 > 模糊相似。
 * 分档不是为了好看，是为了挡住两类误判：
 *  - 一张角色图 `林晚` 与场景 `林晚的卧室`（包含关系 0.9）→ 素材一旦在某档命中，后续只接受**同分类**
 *    的名字，于是它不会被塞进场景格；
 *  - 素材名 `卧室` 同时像两个场景（`林晚的卧室` / `老宅卧室`）→ 非「完全同名」的档只取**一条**，
 *    不会一张图占两个场景。完全同名可以命中多条（同名角色在十几镜出现，本来就是同一张图）。
 *
 * @param rows 当前分镜表（对齐以**表里真实存在的资产名**为准；表里没写的名字不会凭空建锁）。
 */
export function planScriptAssetAlignment(params: {
    scriptNode: CanvasNodeData;
    candidates: readonly ScriptAssetAlignCandidate[];
    rows: readonly StoryScriptRow[] | null | undefined;
    preset: StoryScriptPresetId | string | null | undefined;
    extras?: readonly StoryScriptExtraColumn[] | null;
}): ScriptAssetAlignPlan {
    const { scriptNode, candidates, rows, preset, extras } = params;
    const empty: ScriptAssetAlignPlan = { matches: [], conflicts: [], unmatched: [], metadata: {}, newLockCount: 0, roleFixCount: 0 };
    const alive = (candidates || []).filter((item) => item?.nodeId && scriptNameLockName(item.title));
    if (!alive.length || !rows?.length) return empty;

    const locks = normalizeStoryScriptNameLockMap(scriptNode.metadata?.scriptNameLocks);
    const roleMap: Record<string, ScriptAssetRole> = { ...(scriptNode.metadata?.scriptAssetRoles || {}) };

    // ① 表里每一个资产格的名字，按列序 / 行序展开（一格多值就拆开，与铺链路同一口径）。
    const columns = getStoryScriptAssetColumns(preset, extras);
    const slots: AlignSlot[] = [];
    for (const column of columns) {
        const role = scriptAssetColumnRole(column.key, extras);
        if (!role || role === "audio") continue;
        for (const row of rows) {
            const text = storyScriptCellText(row?.[column.key]);
            if (!text) continue;
            const names = isMultiNameAssetColumn(column.key, extras) ? splitScriptAssetNames(text) : [text];
            for (const raw of names) {
                const name = scriptNameLockName(raw);
                if (!name) continue;
                slots.push({ name, role, order: slots.length });
            }
        }
    }
    if (!slots.length) return empty;

    type Hit = { slot: AlignSlot; score: number; overlap: number };
    const matches: ScriptAssetAlignMatch[] = [];
    const conflicts: ScriptAssetAlignPlan["conflicts"] = [];
    const unmatched: ScriptAssetAlignPlan["unmatched"] = [];
    const nextLocks: StoryScriptNameLockMap = { ...locks };
    let newLockCount = 0;
    let roleFixCount = 0;

    for (const candidate of alive) {
        // 用户在画布上明确改过分类时，只跟**同分类**的格子对 —— 尊重人的判断。
        const declared = roleMap[candidate.nodeId] ? resolveScriptAssetRole(roleMap[candidate.nodeId]) : null;
        const hits: Hit[] = [];
        for (const slot of slots) {
            if (declared && slot.role !== declared) continue;
            const score = storyScriptAssetNameSimilarity(candidate.title, slot.name);
            if (score < STORY_SCRIPT_ASSET_MATCH_THRESHOLD) continue;
            // 重叠长度只用来在同档里挑「更像的那一件」（`口红` 同时像 `口红` / `口红膏` 时选后者）。
            const overlap = Math.max(scriptNameLockName(candidate.title).length, slot.name.length);
            hits.push({ slot, score, overlap });
        }
        if (!hits.length) {
            unmatched.push({ nodeId: candidate.nodeId, title: candidate.title });
            continue;
        }
        // ② 分档：完全同名（1）→ 包含（0.9）→ 模糊（0.5~0.9）。同档取重叠最长的那一条，再同则取表里先出现的。
        const exact = hits.filter((hit) => hit.score >= 1);
        let kept: Hit[];
        if (exact.length) {
            kept = exact;
        } else {
            const best = hits.slice().sort((left, right) => right.score - left.score || right.overlap - left.overlap || left.slot.order - right.slot.order)[0];
            kept = [best];
        }
        // ③ 分类收口：只保留与「第一条命中的分类」相同的那些名字（挡住 `林晚` 挤进 `林晚的卧室`）。
        const role = kept[0].slot.role;
        kept = kept.filter((hit) => hit.slot.role === role);

        const currentRole = resolveScriptAssetRole(roleMap[candidate.nodeId]);
        if (currentRole !== role) {
            roleMap[candidate.nodeId] = role;
            roleFixCount += 1;
        }
        const names = Array.from(new Set(kept.map((hit) => hit.slot.name)));
        let applied = false;
        for (const name of names) {
            const lockedIds = locks[name] || [];
            // 这个名字已经锁给**别的**图 → 不覆盖（用户手动挑过的图优先），只报冲突。
            if (lockedIds.length && !lockedIds.includes(candidate.nodeId)) {
                conflicts.push({ nodeId: candidate.nodeId, title: candidate.title, name, lockedIds: [...lockedIds] });
                continue;
            }
            if (!lockedIds.includes(candidate.nodeId)) {
                nextLocks[name] = [...(nextLocks[name] || []), candidate.nodeId];
                newLockCount += 1;
            }
            applied = true;
        }
        if (applied) {
            matches.push({
                nodeId: candidate.nodeId,
                title: candidate.title,
                name: names[0],
                role,
                currentRole,
                hits: kept.length,
            });
        }
    }

    const metadata: Partial<CanvasNodeMetadata> = {};
    if (newLockCount) metadata.scriptNameLocks = nextLocks;
    if (roleFixCount) metadata.scriptAssetRoles = roleMap;
    return { matches, conflicts, unmatched, metadata, newLockCount, roleFixCount };
}

/**
 * 生成分镜表 / 连线 / 改名之后要不要动手：只有「确实有新东西」才写。
 * 单独抽出来是为了让探针钉住「跑两次结果一样、第二次不写」这个幂等性 ——
 * 它同时也保证了节点里的自动对齐 effect 不会自激（写一次之后 `newLockCount` 归零）。
 */
export function shouldApplyScriptAssetAlignment(plan: ScriptAssetAlignPlan): boolean {
    return plan.newLockCount > 0 || plan.roleFixCount > 0;
}
