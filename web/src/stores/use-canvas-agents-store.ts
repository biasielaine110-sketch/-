import { create } from "zustand";
import { persist } from "zustand/middleware";

import { parseCanvasAgentJson, type CanvasAgentDefinition } from "@/constant/canvas-agents";

type CanvasAgentsStore = {
    /** 用户导入 / 改过的 agent（内置的三个不在这里，见 BUILTIN_CANVAS_AGENTS）。 */
    agents: CanvasAgentDefinition[];
    installFromJson: (raw: string) => CanvasAgentDefinition;
    upsert: (agent: CanvasAgentDefinition) => void;
    uninstall: (agentId: string) => void;
    getAgent: (agentId: string) => CanvasAgentDefinition | undefined;
};

export const useCanvasAgentsStore = create<CanvasAgentsStore>()(
    persist(
        (set, get) => ({
            agents: [],
            installFromJson: (raw) => {
                const agent = parseCanvasAgentJson(raw);
                const next = [...get().agents.filter((item) => item.id !== agent.id), { ...agent, builtin: false }].sort((a, b) =>
                    a.name.localeCompare(b.name, "zh-CN"),
                );
                set({ agents: next });
                return agent;
            },
            upsert: (agent) =>
                set({
                    agents: [...get().agents.filter((item) => item.id !== agent.id), { ...agent, builtin: false }].sort((a, b) =>
                        a.name.localeCompare(b.name, "zh-CN"),
                    ),
                }),
            uninstall: (agentId) => set({ agents: get().agents.filter((item) => item.id !== agentId) }),
            getAgent: (agentId) => get().agents.find((item) => item.id === agentId),
        }),
        { name: "infinite-canvas:canvas_agents" },
    ),
);
