import { App, Button, Checkbox, Form, Input, Modal, Segmented, Select, Tabs } from "antd";
import { Download, FileUp, GripVertical, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { ModelPicker } from "@/components/model-picker";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { exportAppBackup, importAppBackup } from "@/services/backup-restore";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { defaultTextPrompts } from "@/constant/text-prompt-library";
import {
    channelProtocolSummary,
    createModelChannel,
    findPreferredModelOption,
    modelOptionsFromChannels,
    normalizeModelOptionValue,
    selectableModelsByCapability,
    useConfigStore,
    type AiConfig,
    type ApiCallFormat,
    type ApiTransport,
    type ConfigTabKey,
    type ModelCapability,
    type ModelChannel,
    type TextPromptEntry,
} from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];

export function AppConfigPanel({ showDoneButton = false, initialTab = "channels" }: { showDoneButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [draggingChannelId, setDraggingChannelId] = useState("");
    const [dragOverChannelId, setDragOverChannelId] = useState("");
    const [exportOpen, setExportOpen] = useState(false);
    const [exportIncludeTextPrompts, setExportIncludeTextPrompts] = useState(true);
    const [exporting, setExporting] = useState(false);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    useEffect(() => setActiveTab(initialTab), [initialTab]);

    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(t(shouldPromptContinue ? "config.savedContinue" : "config.saved"));
        clearPromptContinue();
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file);
            message.success(t("config.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.importFailed"));
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const confirmExportConfig = async () => {
        setExporting(true);
        try {
            const result = await exportAppConfig({ includeTextPrompts: exportIncludeTextPrompts });
            message.success(
                result.method === "draft"
                    ? t("config.exportedToFolder", { name: result.fileName, folder: result.folderName || "" })
                    : t("config.exported"),
            );
            setExportOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.exportFailed"));
        } finally {
            setExporting(false);
        }
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const addChannel = () => {
        const channel = createModelChannel({ name: t("config.channels.numberedName", { count: config.channels.length + 1 }) });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => (item.id === channel.id ? channel : item)));
    };

    const reorderChannels = (fromId: string, toId: string) => {
        if (!fromId || !toId || fromId === toId) return;
        const fromIndex = config.channels.findIndex((channel) => channel.id === fromId);
        const toIndex = config.channels.findIndex((channel) => channel.id === toId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
        const next = [...config.channels];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        updateChannels(next);
    };

    const handleChannelDragStart = (event: ReactDragEvent<HTMLElement>, channelId: string) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", channelId);
        setDraggingChannelId(channelId);
    };

    const handleChannelDragOver = (event: ReactDragEvent<HTMLElement>, channelId: string) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dragOverChannelId !== channelId) setDragOverChannelId(channelId);
    };

    const handleChannelDrop = (event: ReactDragEvent<HTMLElement>, channelId: string) => {
        event.preventDefault();
        const fromId = event.dataTransfer.getData("text/plain") || draggingChannelId;
        reorderChannels(fromId, channelId);
        setDraggingChannelId("");
        setDragOverChannelId("");
    };

    const clearChannelDrag = () => {
        setDraggingChannelId("");
        setDragOverChannelId("");
    };

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3 dark:border-stone-800">
                <div className="text-xs text-stone-500">{t("config.fileSecurity")}</div>
                <div className="flex gap-2">
                    <Button icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                        {t("config.import")}
                    </Button>
                    <Button
                        icon={<Download className="size-4" />}
                        onClick={() => {
                            setExportIncludeTextPrompts(true);
                            setExportOpen(true);
                        }}
                    >
                        {t("config.export")}
                    </Button>
                    <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                </div>
            </div>
            <Modal
                title={t("config.exportTitle")}
                open={exportOpen}
                onCancel={() => !exporting && setExportOpen(false)}
                onOk={() => void confirmExportConfig()}
                okText={t("config.exportConfirm")}
                cancelText={t("common.cancel")}
                confirmLoading={exporting}
                destroyOnHidden
            >
                <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">{t("config.exportDescription")}</p>
                <Checkbox checked={exportIncludeTextPrompts} onChange={(event) => setExportIncludeTextPrompts(event.target.checked)}>
                    {t("config.exportIncludeTextPrompts")}
                </Checkbox>
            </Modal>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as ConfigTabKey)}
                items={[
                    {
                        key: "channels",
                        label: t("config.tabs.channels"),
                        children: (
                            <div>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-xs text-stone-500">
                                        <div>{t("config.channels.description")}</div>
                                        <div className="mt-1">{t("config.channels.reorderHint")}</div>
                                    </div>
                                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                        {t("config.channels.add")}
                                    </Button>
                                </div>
                                <div className="space-y-2">
                                    {config.channels.map((channel) => (
                                        <div
                                            key={channel.id}
                                            onDragOver={(event) => handleChannelDragOver(event, channel.id)}
                                            onDrop={(event) => handleChannelDrop(event, channel.id)}
                                            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-3 transition-colors dark:border-stone-800 ${
                                                draggingChannelId === channel.id ? "opacity-50" : ""
                                            } ${dragOverChannelId === channel.id && draggingChannelId !== channel.id ? "border-sky-400 bg-sky-50 dark:border-sky-500 dark:bg-sky-950/40" : "border-stone-200"}`}
                                        >
                                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                                <span
                                                    draggable
                                                    onDragStart={(event) => handleChannelDragStart(event, channel.id)}
                                                    onDragEnd={clearChannelDrag}
                                                    className="inline-flex shrink-0 cursor-grab touch-none text-stone-400 active:cursor-grabbing"
                                                    title={t("config.channels.dragHandle")}
                                                    aria-label={t("config.channels.dragHandle")}
                                                >
                                                    <GripVertical className="size-4" />
                                                </span>
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</div>
                                                    <div className="mt-1 truncate text-xs text-stone-500">
                                                        {channelProtocolLabel(channel, t)} · {t("config.channels.modelCount", { count: channel.models.length })} · {channel.baseUrl || t("config.channels.missingUrl")}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 gap-2">
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                    {t("common.edit")}
                                                </Button>
                                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "preferences",
                        label: t("config.tabs.preferences"),
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                                <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                        </Form.Item>
                                    ))}
                                </div>
                                <Form.Item label={t("config.preferences.apiTransport")} extra={t("config.preferences.apiTransportDescription")} className="mb-6">
                                    <Segmented
                                        block
                                        value={config.apiTransport || "proxy"}
                                        options={[
                                            { label: t("config.preferences.apiTransportProxy"), value: "proxy" },
                                            { label: t("config.preferences.apiTransportDirect"), value: "direct" },
                                        ]}
                                        onChange={(value) => updateConfig("apiTransport", value as ApiTransport)}
                                    />
                                </Form.Item>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.audioVoice")} className="mb-4">
                                        <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.audioFormat")} className="mb-4">
                                        <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.audioSpeed")} className="mb-4">
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
                                    </Form.Item>
                                </div>
                                <Form.Item label={t("config.preferences.audioInstructions")} className="mb-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label={t("config.preferences.systemPrompt")} className="mb-6">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                                <TextPromptLibraryPreferences prompts={config.textPrompts || []} onChange={(textPrompts) => updateConfig("textPrompts", textPrompts)} />
                            </Form>
                        ),
                    },
                    {
                        key: "backup",
                        label: t("config.tabs.backup"),
                        children: <ConfigBackupTab />,
                    },
                ]}
            />
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={finishConfig}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
        </>
    );
}
export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modalDescription")}</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            destroyOnHidden
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    if (options.includes(normalized)) return normalized;
    if (capability === "text") {
        const preferred = findPreferredModelOption(config.channels, "text", ["deepseek-flash"]);
        if (preferred && options.includes(preferred)) return preferred;
    }
    return options[0] || "";
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return "Gemini";
    return "OpenAI";
}

function channelProtocolLabel(channel: ModelChannel, t: (key: string) => string) {
    const summary = channelProtocolSummary(channel);
    if (summary === "mixed") return t("config.channels.mixedProtocol");
    return apiFormatLabel(summary);
}

function TextPromptLibraryPreferences({ prompts, onChange }: { prompts: TextPromptEntry[]; onChange: (prompts: TextPromptEntry[]) => void }) {
    const { t } = useTranslation();
    const [draggingPromptId, setDraggingPromptId] = useState("");
    const [dragOverPromptId, setDragOverPromptId] = useState("");

    const updatePrompt = (id: string, patch: Partial<TextPromptEntry>) => {
        onChange(prompts.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const addPrompt = () => {
        onChange([
            ...prompts,
            {
                id: nanoid(8),
                title: t("config.preferences.textPromptNewTitle"),
                content: "",
            },
        ]);
    };

    const removePrompt = (id: string) => onChange(prompts.filter((item) => item.id !== id));

    const resetDefaults = () => onChange(defaultTextPrompts.map((item) => ({ ...item })));

    const movePrompt = (from: number, to: number) => {
        if (to < 0 || to >= prompts.length || from === to) return;
        const next = [...prompts];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        onChange(next);
    };

    const reorderPrompts = (fromId: string, toId: string) => {
        if (!fromId || !toId || fromId === toId) return;
        const fromIndex = prompts.findIndex((item) => item.id === fromId);
        const toIndex = prompts.findIndex((item) => item.id === toId);
        movePrompt(fromIndex, toIndex);
    };

    const handlePromptDragStart = (event: ReactDragEvent<HTMLElement>, promptId: string) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", promptId);
        setDraggingPromptId(promptId);
    };

    const handlePromptDragOver = (event: ReactDragEvent<HTMLElement>, promptId: string) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dragOverPromptId !== promptId) setDragOverPromptId(promptId);
    };

    const handlePromptDrop = (event: ReactDragEvent<HTMLElement>, promptId: string) => {
        event.preventDefault();
        const fromId = event.dataTransfer.getData("text/plain") || draggingPromptId;
        reorderPrompts(fromId, promptId);
        setDraggingPromptId("");
        setDragOverPromptId("");
    };

    const clearPromptDrag = () => {
        setDraggingPromptId("");
        setDragOverPromptId("");
    };

    return (
        <div className="mb-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.preferences.textPromptLibrary")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.preferences.textPromptLibraryDescription")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.preferences.textPromptReorderHint")}</div>
                </div>
                <div className="flex gap-2">
                    <Button size="small" onClick={resetDefaults}>
                        {t("config.preferences.textPromptReset")}
                    </Button>
                    <Button size="small" type="primary" icon={<Plus className="size-3.5" />} onClick={addPrompt}>
                        {t("config.preferences.textPromptAdd")}
                    </Button>
                </div>
            </div>
            <div className="space-y-3">
                {prompts.length ? (
                    prompts.map((prompt, index) => (
                        <div
                            key={prompt.id}
                            onDragOver={(event) => handlePromptDragOver(event, prompt.id)}
                            onDrop={(event) => handlePromptDrop(event, prompt.id)}
                            className={`rounded-lg border p-3 transition-colors dark:border-stone-800 ${
                                draggingPromptId === prompt.id ? "opacity-50" : ""
                            } ${
                                dragOverPromptId === prompt.id && draggingPromptId !== prompt.id
                                    ? "border-sky-400 bg-sky-50 dark:border-sky-500 dark:bg-sky-950/40"
                                    : "border-stone-200"
                            }`}
                        >
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <span
                                    draggable
                                    onDragStart={(event) => handlePromptDragStart(event, prompt.id)}
                                    onDragEnd={clearPromptDrag}
                                    className="inline-flex shrink-0 cursor-grab touch-none text-stone-400 active:cursor-grabbing"
                                    title={t("config.preferences.textPromptDragHandle")}
                                    aria-label={t("config.preferences.textPromptDragHandle")}
                                >
                                    <GripVertical className="size-4" />
                                </span>
                                <span className="w-6 shrink-0 text-center text-xs text-stone-400 tabular-nums">{index + 1}</span>
                                <Input
                                    className="min-w-0 flex-1"
                                    value={prompt.title}
                                    placeholder={t("config.preferences.textPromptTitlePlaceholder")}
                                    onChange={(event) => updatePrompt(prompt.id, { title: event.target.value })}
                                />
                                <Button size="small" disabled={index === 0} title={t("config.preferences.textPromptMoveTop")} onClick={() => movePrompt(index, 0)}>
                                    ⇈
                                </Button>
                                <Button size="small" disabled={index === 0} title={t("config.preferences.textPromptMoveUp")} onClick={() => movePrompt(index, index - 1)}>
                                    ↑
                                </Button>
                                <Button size="small" disabled={index === prompts.length - 1} title={t("config.preferences.textPromptMoveDown")} onClick={() => movePrompt(index, index + 1)}>
                                    ↓
                                </Button>
                                <Button
                                    size="small"
                                    disabled={index === prompts.length - 1}
                                    title={t("config.preferences.textPromptMoveBottom")}
                                    onClick={() => movePrompt(index, prompts.length - 1)}
                                >
                                    ⇊
                                </Button>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => removePrompt(prompt.id)} />
                            </div>
                            <Input.TextArea
                                rows={3}
                                value={prompt.content}
                                placeholder={t("config.preferences.textPromptContentPlaceholder")}
                                onChange={(event) => updatePrompt(prompt.id, { content: event.target.value })}
                            />
                        </div>
                    ))
                ) : (
                    <div className="rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-500 dark:border-stone-800">{t("config.preferences.textPromptEmpty")}</div>
                )}
            </div>
        </div>
    );
}

function ConfigBackupTab() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);

    const handleBackup = async () => {
        try {
            await exportAppBackup();
            message.success(t("config.backup.exported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.backup.exportFailed"));
        }
    };

    const handleImport = async (file?: File) => {
        if (!file) return;
        try {
            modal.confirm({
                title: t("config.backup.importTitle"),
                content: t("config.backup.importDescription"),
                okText: t("common.restore"),
                cancelText: t("common.cancel"),
                okButtonProps: { danger: true },
                onOk: async () => {
                    try {
                        await importAppBackup(file);
                        message.success(t("config.backup.imported"));
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : t("config.backup.importFailed"));
                    }
                },
            });
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-1 text-sm font-semibold">{t("config.backup.title")}</div>
            <div className="mb-3 text-xs text-stone-500">{t("config.backup.description")}</div>
            <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Download className="size-4" />} onClick={() => void handleBackup()}>
                    {t("config.backup.export")}
                </Button>
                <Button icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                    {t("config.backup.import")}
                </Button>
            </div>
            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void handleImport(event.target.files?.[0])} />
        </section>
    );
}
