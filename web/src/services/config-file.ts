import i18n from "@/i18n";
import { saveBlobAs } from "@/lib/fs/save-blob";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
};

export async function exportAppConfig(projectId?: string | null) {
    const { config } = useConfigStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    await saveBlobAs(blob, "infinite-canvas-config.json", {
        projectId,
        description: "Infinite Atelier Config",
        accept: { "application/json": [".json"] },
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
    useConfigStore.setState({ config: data.config });
}
