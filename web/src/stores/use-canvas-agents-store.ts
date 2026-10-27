import { create } from "zustand";
import { persist } from "zustand/middleware";

import { normalizePersistedCanvasAgents, parseCanvasAgentJson, type CanvasAgentDefinition } from "@/constant/canvas-agents";

type CanvasAgentsStore = {
    /** 用户导入 / 改过的 agent（内置的不在这里，见 BUILTIN_CANVAS_AGENTS）。 */
    agents: CanvasAgentDefinition[];
    installFromJson: (raw: string) => CanvasAgentDefinition;
    upsert: (agent: CanvasAgentDefinition) => CanvasAgentDefinition;
    /** 配置导入：按 id 合并写入，不删本地已有但文件里没有的 agent */
    importAgents: (agents: CanvasAgentDefinition[]) => number;
    /** 全量备份恢复：整表替换 */
    replaceAgents: (agents: CanvasAgentDefinition[]) => void;
    uninstall: (agentId: string) => void;
    getAgent: (agentId: string) => CanvasAgentDefinition | undefined;
};

function sortAgents(agents: CanvasAgentDefinition[]) {
    return [...agents].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export const useCanvasAgentsStore = create<CanvasAgentsStore>()(
    persist(
        (set, get) => ({
            agents: [],
            installFromJson: (raw) => get().upsert(parseCanvasAgentJson(raw)),
            upsert: (agent) => {
                const next: CanvasAgentDefinition = { ...agent, builtin: false };
                set({
                    agents: sortAgents([...get().agents.filter((item) => item.id !== next.id), next]),
                });
                return next;
            },
            importAgents: (agents) => {
                const normalized = normalizePersistedCanvasAgents(agents);
                if (!normalized.length) return 0;
                const byId = new Map(get().agents.map((agent) => [agent.id, agent] as const));
                for (const agent of normalized) {
                    byId.set(agent.id, { ...agent, builtin: false });
                }
                set({ agents: sortAgents(Array.from(byId.values())) });
                return normalized.length;
            },
            replaceAgents: (agents) => {
                set({
                    agents: sortAgents(normalizePersistedCanvasAgents(agents).map((agent) => ({ ...agent, builtin: false }))),
                });
            },
            uninstall: (agentId) => set({ agents: get().agents.filter((item) => item.id !== agentId) }),
            getAgent: (agentId) => get().agents.find((item) => item.id === agentId),
        }),
        { name: "infinite-canvas:canvas_agents" },
    ),
);
