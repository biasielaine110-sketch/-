import { create } from "zustand";
import { persist } from "zustand/middleware";

import { parseLocalSkillPackJson, type LocalSkillPack } from "@/lib/chat-skill-pack";

type ChatSkillPacksStore = {
    packs: LocalSkillPack[];
    installFromJson: (raw: string) => LocalSkillPack;
    uninstall: (packId: string) => void;
    getPack: (packId: string) => LocalSkillPack | undefined;
};

export const useChatSkillPacksStore = create<ChatSkillPacksStore>()(
    persist(
        (set, get) => ({
            packs: [],
            installFromJson: (raw) => {
                const pack = parseLocalSkillPackJson(raw);
                const now = Date.now();
                const existing = get().packs.find((item) => item.id === pack.id);
                const nextPack: LocalSkillPack = {
                    ...pack,
                    installedAt: existing?.installedAt || now,
                    updatedAt: now,
                };
                set({
                    packs: [...get().packs.filter((item) => item.id !== pack.id), nextPack].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
                });
                return nextPack;
            },
            uninstall: (packId) => set({ packs: get().packs.filter((item) => item.id !== packId) }),
            getPack: (packId) => get().packs.find((item) => item.id === packId),
        }),
        { name: "infinite-canvas:chat_skill_packs" },
    ),
);
