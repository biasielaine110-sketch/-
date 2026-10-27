import i18n from "@/i18n";
import type { CanvasAgentDefinition } from "@/constant/canvas-agents";
import { resolveCanvasProjectIdFromLocation, saveBlobAs } from "@/lib/fs/save-blob";
import type { LocalSkillPack } from "@/lib/chat-skill-pack";
import { useCanvasAgentsStore } from "@/stores/use-canvas-agents-store";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig | Omit<AiConfig, "textPrompts">;
    /** 用户安装的本地技能（工具包 / 文档技能）；旧版配置文件可能没有该字段 */
    chatSkillPacks?: LocalSkillPack[];
    /** 用户导入的本地 agent；旧版配置文件可能没有该字段 */
    canvasAgents?: CanvasAgentDefinition[];
};

export type ExportAppConfigOptions = {
    projectId?: string | null;
    /** When false, omit the text prompt library from the exported JSON. Default true. */
    includeTextPrompts?: boolean;
    /** When false, omit local chat skill packs. Default true. */
    includeChatSkillPacks?: boolean;
    /** When false, omit local canvas agents. Default true. */
    includeCanvasAgents?: boolean;
};

export async function exportAppConfig(options?: ExportAppConfigOptions) {
    const { config } = useConfigStore.getState();
    const includeTextPrompts = options?.includeTextPrompts !== false;
    const includeChatSkillPacks = options?.includeChatSkillPacks !== false;
    const includeCanvasAgents = options?.includeCanvasAgents !== false;
    const exportConfig = includeTextPrompts
        ? config
        : (() => {
              const { textPrompts: _textPrompts, ...rest } = config;
              return rest;
          })();
    const data: AppConfigFile = {
        app: "infinite-canvas",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: exportConfig,
        ...(includeChatSkillPacks ? { chatSkillPacks: useChatSkillPacksStore.getState().packs } : {}),
        ...(includeCanvasAgents ? { canvasAgents: useCanvasAgentsStore.getState().agents } : {}),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    return saveBlobAs(blob, "infinite-canvas-config.json", {
        projectId: options?.projectId ?? resolveCanvasProjectIdFromLocation(),
    });
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config) throw new Error(i18n.t("config.invalidFile"));
    const current = useConfigStore.getState().config;
    const imported = data.config as Partial<AiConfig>;
    // Configs exported without the library omit textPrompts — keep the local library in that case.
    useConfigStore.setState({
        config: {
            ...current,
            ...imported,
            textPrompts: Array.isArray(imported.textPrompts) ? imported.textPrompts : current.textPrompts,
            imageQuickTools: imported.imageQuickTools || current.imageQuickTools,
            nodeCreateMenuOrder: Array.isArray(imported.nodeCreateMenuOrder) ? imported.nodeCreateMenuOrder : current.nodeCreateMenuOrder,
            imageContextMenuOrder: Array.isArray(imported.imageContextMenuOrder) ? imported.imageContextMenuOrder : current.imageContextMenuOrder,
        } as AiConfig,
    });
    // 旧版配置没有这些字段时保留本地数据；有字段则按 id 合并写入。
    if (Array.isArray(data.chatSkillPacks)) {
        useChatSkillPacksStore.getState().importPacks(data.chatSkillPacks);
    }
    if (Array.isArray(data.canvasAgents)) {
        useCanvasAgentsStore.getState().importAgents(data.canvasAgents);
    }
}
