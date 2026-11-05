import i18n from "@/i18n";
import type { CanvasAgentDefinition } from "@/constant/canvas-agents";
import {
    buildChatSkillSnapshot,
    resolveImportedChatSkillView,
    type ExportedChatSkill,
} from "@/lib/chat-skills";
import { resolveCanvasProjectIdFromLocation, saveBlobAs, type SaveBlobResult } from "@/lib/fs/save-blob";
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
    /**
     * 技能列表的完整快照（内置 + 本地，顺序 = AI 对话窗口里渲染的顺序，隐藏项也在，标 hidden）。
     * 旧版文件没有该字段；有了它，即使排序 / 隐藏两个数组缺失或只有半截，也能原样还原。
     */
    chatSkills?: ExportedChatSkill[];
    /**
     * 技能列表的用户排序（内置 + 本地 id 混排，**全量**）。旧版配置文件可能没有该字段。
     * 这是「视图偏好」而不是技能本体，所以与 chatSkillPacks 分开写，互不牵连。
     */
    chatSkillOrder?: string[];
    /** 技能列表里被隐藏的 id（内置技能也在里面）；旧版配置文件可能没有该字段。 */
    chatSkillHiddenIds?: string[];
    /** 用户导入的本地 agent；旧版配置文件可能没有该字段 */
    canvasAgents?: CanvasAgentDefinition[];
};

export type ExportAppConfigOptions = {
    projectId?: string | null;
    /** When false, omit the text prompt library from the exported JSON. Default true. */
    includeTextPrompts?: boolean;
    /** When false, omit local canvas agents. Default true. */
    includeCanvasAgents?: boolean;
};

/**
 * 导出结果 = 文件落盘信息 + 本次带走的技能条数。
 *
 * 带上条数是为了让 toast 能写「含 N 个技能、排序 N 项、隐藏 M 项」：用户在另一台机器导入前
 * 就能确认这份文件到底有没有把技能、排序、显隐都带出来，不用打开 JSON 数。
 */
export type ExportAppConfigResult = SaveBlobResult & {
    /** 快照里的技能总数（内置 + 本地） */
    skillCount: number;
    /** 真正写进文件的本地技能本体个数 */
    skillPackCount: number;
    skillOrderCount: number;
    skillHiddenCount: number;
    /** 技能本体（chatSkillPacks）恒随配置导出；保留字段只为兼容旧调用方 */
    includesChatSkillPacks: boolean;
};

/**
 * 导入结果：技能本体 + 视图条数。
 * `-1` 表示文件里根本没有该字段（旧版导出 / 手工改过的文件）——此时本地设置**保持原样**。
 */
export type ImportAppConfigResult = {
    skillCount: number;
    skillPackCount: number;
    skillPackSkipped: number;
    skillOrderCount: number;
    skillHiddenCount: number;
};

export async function exportAppConfig(options?: ExportAppConfigOptions): Promise<ExportAppConfigResult> {
    const { config } = useConfigStore.getState();
    const includeTextPrompts = options?.includeTextPrompts !== false;
    const includeCanvasAgents = options?.includeCanvasAgents !== false;
    const exportConfig = includeTextPrompts
        ? config
        : (() => {
              const { textPrompts: _textPrompts, ...rest } = config;
              return rest;
          })();
    const skillState = useChatSkillPacksStore.getState();
    // 技能三件套（清单 / 排序 / 显隐）**无条件**导出，且排序写成全量：
    //  - 清单让文件自带「这台机器上都有哪些技能」，导入端不依赖两个 id 数组；
    //  - 全量排序保证另一台机器渲染顺序一致（半截排序会把没登记的技能甩到末尾）；
    //  - 技能本体也不再挂开关 —— 用户要的是「配置里的技能全带走」，少一个都算漏。
    const snapshot = buildChatSkillSnapshot();
    const data: AppConfigFile = {
        app: "infinite-canvas",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: exportConfig,
        chatSkills: snapshot.skills,
        chatSkillOrder: snapshot.order,
        chatSkillHiddenIds: snapshot.hiddenIds,
        chatSkillPacks: skillState.packs,
        ...(includeCanvasAgents ? { canvasAgents: useCanvasAgentsStore.getState().agents } : {}),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const saved = await saveBlobAs(blob, "infinite-canvas-config.json", {
        projectId: options?.projectId ?? resolveCanvasProjectIdFromLocation(),
    });
    return {
        ...saved,
        skillCount: snapshot.skills.length,
        skillPackCount: skillState.packs.length,
        skillOrderCount: snapshot.order.length,
        skillHiddenCount: snapshot.hiddenIds.length,
        includesChatSkillPacks: true,
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
    // ① 技能本体：按 id 合并写入，本地已有但文件里没有的保留；坏条目计数上报，不再静默吞掉。
    let skillPackCount = 0;
    let skillPackSkipped = 0;
    if (Array.isArray(data.chatSkillPacks)) {
        const report = useChatSkillPacksStore.getState().importPacks(data.chatSkillPacks);
        skillPackCount = report.applied;
        skillPackSkipped = report.skipped;
    }
    // ② 排序 / 显隐：优先显式 id 字段，缺失就退回技能清单快照；两者都没有 → 一个字节都不动。
    const view = resolveImportedChatSkillView({
        chatSkills: data.chatSkills,
        chatSkillOrder: data.chatSkillOrder,
        chatSkillHiddenIds: data.chatSkillHiddenIds,
    });
    if (view.order !== undefined || view.hiddenIds !== undefined) {
        useChatSkillPacksStore.getState().replaceSkillView({ order: view.order, hiddenIds: view.hiddenIds });
    }
    if (Array.isArray(data.canvasAgents)) {
        useCanvasAgentsStore.getState().importAgents(data.canvasAgents);
    }
    return {
        // 旧版文件没有清单快照，就用技能本体的条数当「文件里有几个技能」。
        skillCount: view.skillCount || (Array.isArray(data.chatSkillPacks) ? data.chatSkillPacks.length : 0),
        skillPackCount,
        skillPackSkipped,
        skillOrderCount: view.order !== undefined ? view.order.length : -1,
        skillHiddenCount: view.hiddenIds !== undefined ? view.hiddenIds.length : -1,
    };
}
