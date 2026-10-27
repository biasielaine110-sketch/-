import { create } from "zustand";
import { persist } from "zustand/middleware";

import { normalizePersistedSkillPacks, parseLocalSkillPackJson, type LocalSkillPack } from "@/lib/chat-skill-pack";

type ChatSkillPacksStore = {
    packs: LocalSkillPack[];
    /** 解析好的技能落库（.json 工具包 / SKILL.md 文档技能 / 文件夹，都在外面解析完再进来） */
    upsert: (pack: LocalSkillPack) => LocalSkillPack;
    installFromJson: (raw: string) => LocalSkillPack;
    /** 配置导入：按 id 合并写入，不删本地已有但文件里没有的技能 */
    importPacks: (packs: LocalSkillPack[]) => number;
    /** 全量备份恢复：整表替换 */
    replacePacks: (packs: LocalSkillPack[]) => void;
    uninstall: (packId: string) => void;
    getPack: (packId: string) => LocalSkillPack | undefined;
};

function sortPacks(packs: LocalSkillPack[]) {
    return [...packs].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export const useChatSkillPacksStore = create<ChatSkillPacksStore>()(
    persist(
        (set, get) => ({
            packs: [],
            upsert: (pack) => {
                const now = Date.now();
                const existing = get().packs.find((item) => item.id === pack.id);
                const nextPack: LocalSkillPack = {
                    ...pack,
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
                const normalized = normalizePersistedSkillPacks(packs);
                if (!normalized.length) return 0;
                const now = Date.now();
                const byId = new Map(get().packs.map((pack) => [pack.id, pack] as const));
                for (const pack of normalized) {
                    const existing = byId.get(pack.id);
                    byId.set(pack.id, {
                        ...pack,
                        installedAt: existing?.installedAt || pack.installedAt || now,
                        updatedAt: now,
                    });
                }
                set({ packs: sortPacks(Array.from(byId.values())) });
                return normalized.length;
            },
            replacePacks: (packs) => {
                const normalized = normalizePersistedSkillPacks(packs);
                const now = Date.now();
                set({
                    packs: sortPacks(
                        normalized.map((pack) => ({
                            ...pack,
                            installedAt: pack.installedAt || now,
                            updatedAt: pack.updatedAt || now,
                        })),
                    ),
                });
            },
            uninstall: (packId) => set({ packs: get().packs.filter((item) => item.id !== packId) }),
            getPack: (packId) => get().packs.find((item) => item.id === packId),
        }),
        { name: "infinite-canvas:chat_skill_packs" },
    ),
);
