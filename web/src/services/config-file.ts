import i18n from "@/i18n";
import type { CanvasAgentDefinition } from "@/constant/canvas-agents";
import { resolveCanvasProjectIdFromLocation, saveBlobAs, type SaveBlobResult } from "@/lib/fs/save-blob";
import type { LocalSkillPack } from "@/lib/chat-skill-pack";
import { useCanvasAgentsStore } from "@/stores/use-canvas-agents-store";
import { normalizeChatSkillIdList, useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig | Omit<AiConfig, "textPrompts">;
    /** 用户安装的本地技能（工具包 / 文档技能）；旧版配置文件可能没有该字段 */
    chatSkillPacks?: LocalSkillPack[];
    /**
     * 技能列表的用户排序（内置 + 本地 id 混排）；旧版配置文件可能没有该字段。
     * 这是「视图偏好」而不是技能本体，所以**不受 includeChatSkillPacks 影响**：不导技能包时也照常写。
     */
    chatSkillOrder?: string[];
    /** 技能列表里被隐藏的 id（内置技能也在里面）；旧版配置文件可能没有该字段。同上，随配置一起走。 */
    chatSkillHiddenIds?: string[];
    /** 用户导入的本地 agent；旧版配置文件可能没有该字段 */
    canvasAgents?: CanvasAgentDefinition[];
};

export type ExportAppConfigOptions = {
    projectId?: string | null;
    /** When false, omit the text prompt library from the exported JSON. Default true. */
    includeTextPrompts?: boolean;
    /** When false, omit local chat skill packs. Default true. 排序与显示隐藏不受此开关影响。 */
    includeChatSkillPacks?: boolean;
    /** When false, omit local canvas agents. Default true. */
    includeCanvasAgents?: boolean;
};

/**
 * 导出结果 = 文件落盘信息 + 本次带走的技能视图条数。
 *
 * 带上条数是为了让 toast 能写「含技能排序 N 项、显示隐藏 M 项」：用户在另一台机器导入前
 * 就能确认这份文件到底有没有把排序 / 隐藏带出来，不必再打开 JSON 里找 `chatSkillOrder`。
 */
export type ExportAppConfigResult = SaveBlobResult & {
    skillOrderCount: number;
    skillHiddenCount: number;
    /** 是否连技能本体（chatSkillPacks）一起写进了文件 */
    includesChatSkillPacks: boolean;
};

/**
 * 导入结果：两个条数。
 * `-1` 表示文件里根本没有该字段（旧版导出 / 手工改过的文件）——此时本地排序与隐藏**保持原样**。
 */
export type ImportAppConfigResult = {
    skillOrderCount: number;
    skillHiddenCount: number;
};

export async function exportAppConfig(options?: ExportAppConfigOptions): Promise<ExportAppConfigResult> {
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
    const skillState = useChatSkillPacksStore.getState();
    // 排序 / 显示隐藏无条件导出：它们是「这个人的使用习惯」，与是否携带技能正文无关。
    // 放进 includeChatSkillPacks 分支里会导致关掉「本地技能」后，另一台机器上的顺序与隐藏全丢。
    const chatSkillOrder = normalizeChatSkillIdList(skillState.skillOrder);
    const chatSkillHiddenIds = normalizeChatSkillIdList(skillState.hiddenSkillIds);
    const data: AppConfigFile = {
        app: "infinite-canvas",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: exportConfig,
        chatSkillOrder,
        chatSkillHiddenIds,
        ...(includeChatSkillPacks ? { chatSkillPacks: skillState.packs } : {}),
        ...(includeCanvasAgents ? { canvasAgents: useCanvasAgentsStore.getState().agents } : {}),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const saved = await saveBlobAs(blob, "infinite-canvas-config.json", {
        projectId: options?.projectId ?? resolveCanvasProjectIdFromLocation(),
    });
    return {
        ...saved,
        skillOrderCount: chatSkillOrder.length,
        skillHiddenCount: chatSkillHiddenIds.length,
        includesChatSkillPacks: includeChatSkillPacks,
    };
}

export async function importAppConfig(file: File): Promise<ImportAppConfigResult> {
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
    // 排序 / 显示隐藏逐字段判断：文件里只有其中一个字段时，另一个保持本地原样。
    // 旧版文件两个都没有 → 一个字节都不动，也不会把本地排序洗成空。
    const hasOrder = Array.isArray(data.chatSkillOrder);
    const hasHidden = Array.isArray(data.chatSkillHiddenIds);
    const orderIds = hasOrder ? normalizeChatSkillIdList(data.chatSkillOrder) : [];
    const hiddenIds = hasHidden ? normalizeChatSkillIdList(data.chatSkillHiddenIds) : [];
    if (hasOrder || hasHidden) {
        useChatSkillPacksStore.getState().replaceSkillView({
            order: hasOrder ? orderIds : undefined,
            hiddenIds: hasHidden ? hiddenIds : undefined,
        });
    }
    if (Array.isArray(data.canvasAgents)) {
        useCanvasAgentsStore.getState().importAgents(data.canvasAgents);
    }
    return {
        skillOrderCount: hasOrder ? orderIds.length : -1,
        skillHiddenCount: hasHidden ? hiddenIds.length : -1,
    };
}
