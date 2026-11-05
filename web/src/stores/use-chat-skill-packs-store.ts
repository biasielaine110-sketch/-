import { create } from "zustand";
import { persist } from "zustand/middleware";

import { localSkillPackDisplayName, normalizePersistedSkillPacks, normalizePersistedSkillPacksDetailed, parseLocalSkillPackJson, type LocalSkillPack } from "@/lib/chat-skill-pack";

/**
 * 配置导入 / 备份恢复用的技能 id 列表归一化：只收字符串、去空白、去重、限量。
 * 老配置可能混进 null / 数字 / 重复项，直接写进 store 会让排序 rank 与隐藏判定对不上。
 */
export function normalizeChatSkillIdList(value: unknown, limit = 500): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of value) {
        if (typeof raw !== "string") continue;
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
    }
    return ids;
}

type ChatSkillPacksStore = {
    packs: LocalSkillPack[];
    /**
     * 列表里被隐藏的技能 id（内置技能也在这里）。
     * 与词库的 enabled 同口径：**只影响列表显示**，已经勾选该技能的节点照旧生效，
     * 否则用户勾过的技能会静默消失，只剩一个数字对不上。
     */
    hiddenSkillIds: string[];
    /** 隐藏 / 取消隐藏某个技能（只动展示，不动 packs） */
    setSkillHidden: (skillId: string, hidden: boolean) => void;
    /** 用户拖出来的技能顺序（内置 + 本地的 id 混排）；没登记的 id 排在最后，保持各自原序 */
    skillOrder: string[];
    setSkillOrder: (skillIds: string[]) => void;
    /** 配置导入 / 备份恢复：整表替换排序与隐藏；某字段不是数组就跳过（旧版文件没带 → 保留本地） */
    replaceSkillView: (view: { order?: unknown; hiddenIds?: unknown }) => void;
    /** 解析好的技能落库（.json 工具包 / SKILL.md 文档技能 / 文件夹，都在外面解析完再进来） */
    upsert: (pack: LocalSkillPack) => LocalSkillPack;
    installFromJson: (raw: string) => LocalSkillPack;
    /** 配置导入：按 id 合并写入，不删本地已有但文件里没有的技能；返回导入 / 跳过条数 */
    importPacks: (packs: LocalSkillPack[]) => { applied: number; skipped: number };
    /** 全量备份恢复：整表替换 */
    replacePacks: (packs: LocalSkillPack[]) => void;
    /** 只改用户备注名；传空串则清掉备注 */
    setAlias: (packId: string, alias: string) => void;
    uninstall: (packId: string) => void;
    getPack: (packId: string) => LocalSkillPack | undefined;
};

function sortPacks(packs: LocalSkillPack[]) {
    return [...packs].sort((a, b) => localSkillPackDisplayName(a).localeCompare(localSkillPackDisplayName(b), "zh-CN"));
}

export const useChatSkillPacksStore = create<ChatSkillPacksStore>()(
    persist(
        (set, get) => ({
            packs: [],
            hiddenSkillIds: [],
            skillOrder: [],
            setSkillOrder: (skillIds) => {
                const seen = new Set<string>();
                const next: string[] = [];
                for (const raw of skillIds || []) {
                    const id = String(raw || "").trim();
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    next.push(id);
                }
                set({ skillOrder: next });
            },
            setSkillHidden: (skillId, hidden) => {
                const id = String(skillId || "").trim();
                if (!id) return;
                const current = get().hiddenSkillIds || [];
                const exists = current.includes(id);
                if (hidden === exists) return;
                set({ hiddenSkillIds: hidden ? [...current, id] : current.filter((item) => item !== id) });
            },
            replaceSkillView: (view) => {
                const next: Partial<Pick<ChatSkillPacksStore, "skillOrder" | "hiddenSkillIds">> = {};
                // 只认数组：旧版配置 / 备份没有这两个字段时一个字节都不动，保留本地排序与隐藏。
                if (Array.isArray(view?.order)) next.skillOrder = normalizeChatSkillIdList(view.order);
                if (Array.isArray(view?.hiddenIds)) next.hiddenSkillIds = normalizeChatSkillIdList(view.hiddenIds);
                if (Object.keys(next).length) set(next);
            },
            upsert: (pack) => {
                const now = Date.now();
                const existing = get().packs.find((item) => item.id === pack.id);
                const nextAlias = String(pack.alias ?? existing?.alias ?? "")
                    .trim()
                    .slice(0, 80);
                const nextPack: LocalSkillPack = {
                    ...pack,
                    // 重装同一 id 时保留用户备注，除非新包自己带了 alias。
                    ...(nextAlias ? { alias: nextAlias } : { alias: undefined }),
                    installedAt: existing?.installedAt || pack.installedAt || now,
                    updatedAt: now,
                };
                set({
                    packs: sortPacks([...get().packs.filter((item) => item.id !== pack.id), nextPack]),
                });
                return nextPack;
            },
            installFromJson: (raw) => get().upsert(parseLocalSkillPackJson(raw)),
            importPacks: (packs) => {
                const { packs: normalized, skipped } = normalizePersistedSkillPacksDetailed(packs);
                if (!normalized.length) return { applied: 0, skipped };
                const now = Date.now();
                const byId = new Map(get().packs.map((pack) => [pack.id, pack] as const));
                for (const pack of normalized) {
                    const existing = byId.get(pack.id);
                    const alias = String(pack.alias ?? existing?.alias ?? "")
                        .trim()
                        .slice(0, 80);
                    byId.set(pack.id, {
                        ...pack,
                        ...(alias ? { alias } : { alias: undefined }),
                        installedAt: existing?.installedAt || pack.installedAt || now,
                        updatedAt: now,
                    });
                }
                set({ packs: sortPacks(Array.from(byId.values())) });
                return { applied: normalized.length, skipped };
            },
            replacePacks: (packs) => {
                const normalized = normalizePersistedSkillPacks(packs);
                const now = Date.now();
                set({
                    packs: sortPacks(
                        normalized.map((pack) => {
                            const alias = String(pack.alias || "")
                                .trim()
                                .slice(0, 80);
                            return {
                                ...pack,
                                ...(alias ? { alias } : { alias: undefined }),
                                installedAt: pack.installedAt || now,
                                updatedAt: pack.updatedAt || now,
                            };
                        }),
                    ),
                });
            },
            setAlias: (packId, alias) => {
                const nextAlias = String(alias || "")
                    .trim()
                    .slice(0, 80);
                set({
                    packs: sortPacks(
                        get().packs.map((pack) =>
                            pack.id === packId
                                ? {
                                      ...pack,
                                      alias: nextAlias || undefined,
                                      updatedAt: Date.now(),
                                  }
                                : pack,
                        ),
                    ),
                });
            },
            uninstall: (packId) =>
                set({
                    packs: get().packs.filter((item) => item.id !== packId),
                    // 卸载顺带清掉隐藏记录，免得以后重装同 id 时莫名其妙还是隐藏的。
                    hiddenSkillIds: (get().hiddenSkillIds || []).filter((id) => id !== packId),
                }),
            getPack: (packId) => get().packs.find((item) => item.id === packId),
        }),
        { name: "infinite-canvas:chat_skill_packs" },
    ),
);
