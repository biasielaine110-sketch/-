import { Button, Drawer, Input, Segmented, Select, Space, Switch } from "antd";
import { GripVertical, ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState, type DragEvent as ReactDragEvent } from "react";
import { useTranslation } from "react-i18next";

import { HealthDot } from "@/components/model-picker";
import { encodeChannelModel, defaultBaseUrlForApiFormat, defaultConfig, guessCapability, isChannelModelEnabled, normalizeChannelModels, resolveChannelModelApiFormat, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { getModelHealth, modelHealthKey, subscribeModelHealth } from "@/services/api/model-health";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [draggingModelName, setDraggingModelName] = useState<string | null>(null);
    const [dragOverModelName, setDragOverModelName] = useState<string | null>(null);
    const [, bumpHealth] = useState(0);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) {
            setDraft(channel);
            setDraggingModelName(null);
            setDragOverModelName(null);
        }
    }, [open, channel]);

    useEffect(() => subscribeModelHealth(() => bumpHealth((value) => value + 1)), []);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        const selected = new Set(names);
        // Keep the current order for models that remain selected, then append newly added ones.
        const kept = draft.models.filter((model) => selected.has(model.name));
        const keptNames = new Set(kept.map((model) => model.name));
        const added = names
            .filter((name) => !keptNames.has(name))
            .map((name) => map.get(name) || { name, capability: guessCapability(name), apiFormat: draft.apiFormat });
        setModels([...kept, ...added]);
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setModelApiFormat = (name: string, apiFormat: ApiCallFormat) => setModels(draft.models.map((model) => (model.name === name ? { ...model, apiFormat } : model)));
    const setModelEnabled = (name: string, enabled: boolean) =>
        setModels(draft.models.map((model) => (model.name === name ? { ...model, enabled: enabled ? undefined : false } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));
    const enabledCount = draft.models.filter((model) => isChannelModelEnabled(model)).length;

    const clearModelDrag = () => {
        setDraggingModelName(null);
        setDragOverModelName(null);
    };

    const handleModelDragStart = (event: ReactDragEvent, name: string) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", name);
        setDraggingModelName(name);
    };

    const handleModelDragOver = (event: ReactDragEvent, name: string) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dragOverModelName !== name) setDragOverModelName(name);
    };

    const handleModelDrop = (event: ReactDragEvent, targetName: string) => {
        event.preventDefault();
        const sourceName = draggingModelName || event.dataTransfer.getData("text/plain");
        clearModelDrag();
        if (!sourceName || sourceName === targetName) return;
        const fromIndex = draft.models.findIndex((model) => model.name === sourceName);
        const toIndex = draft.models.findIndex((model) => model.name === targetName);
        if (fromIndex < 0 || toIndex < 0) return;
        const next = [...draft.models];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        setModels(next);
    };

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={720}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.defaultProtocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                    <span className="mt-1 block text-xs text-stone-500">{t("config.channelEditor.defaultProtocolHint")}</span>
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                    <span className="mt-1 block text-xs text-stone-500">{t("config.channelEditor.baseUrlHint")}</span>
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length, enabled: enabledCount })}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.reorderHint")}</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    {t("config.channelEditor.selectModels")}
                </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => {
                        const enabled = isChannelModelEnabled(model);
                        return (
                        <div
                            key={model.name}
                            onDragOver={(event) => handleModelDragOver(event, model.name)}
                            onDrop={(event) => handleModelDrop(event, model.name)}
                            className={`flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-stone-50 dark:hover:bg-stone-900/40 ${
                                draggingModelName === model.name ? "opacity-50" : ""
                            } ${!enabled ? "opacity-50" : ""} ${dragOverModelName === model.name && draggingModelName !== model.name ? "bg-sky-50 ring-1 ring-sky-400 dark:bg-sky-950/40 dark:ring-sky-500" : ""}`}
                        >
                            <span
                                draggable
                                onDragStart={(event) => handleModelDragStart(event, model.name)}
                                onDragEnd={clearModelDrag}
                                className="inline-flex shrink-0 cursor-grab touch-none text-stone-400 active:cursor-grabbing"
                                title={t("config.channelEditor.dragHandle")}
                                aria-label={t("config.channelEditor.dragHandle")}
                            >
                                <GripVertical className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                <span className="inline-flex max-w-full items-center gap-2">
                                    <ChannelModelHealth draft={draft} model={model} />
                                    <span className={`truncate ${enabled ? "" : "line-through text-stone-400"}`}>{model.name}</span>
                                </span>
                            </span>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                                <Switch
                                    size="small"
                                    checked={enabled}
                                    onChange={(checked) => setModelEnabled(model.name, checked)}
                                    checkedChildren={t("config.channelEditor.enabled")}
                                    unCheckedChildren={t("config.channelEditor.disabled")}
                                    title={enabled ? t("config.channelEditor.disableTitle") : t("config.channelEditor.enableTitle")}
                                />
                                <Select
                                    size="small"
                                    className="w-[7.5rem]"
                                    value={resolveChannelModelApiFormat(draft, model)}
                                    options={apiFormatOptions}
                                    onChange={(value) => setModelApiFormat(model.name, value)}
                                />
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                    {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                </Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                        </div>
                        );
                    })
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}

function ChannelModelHealth({ draft, model }: { draft: ModelChannel; model: ChannelModel }) {
    const configLike = { ...defaultConfig, channels: [draft], baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiFormat: draft.apiFormat };
    const health = getModelHealth(modelHealthKey(configLike, encodeChannelModel(draft.id, model.name), model.capability));
    return <HealthDot status={health.status} message={health.message} />;
}
