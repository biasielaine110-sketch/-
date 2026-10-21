import { Alert, Button, Input, Modal, Segmented } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { channelModelHasApiOverride, normalizeProviderBaseUrl, parseApiKeys, resolveChannelModelApiFormat, type ApiTransport, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

type TransportChoice = "inherit" | ApiTransport;

/** Patch returned by the editor: a field set to `undefined` means "drop the override". */
export type ChannelModelApiPatch = Pick<ChannelModel, "baseUrl" | "apiKey" | "apiKeys" | "apiTransport">;

/**
 * Per-model independent API group ("模型独立 API").
 *
 * Everything here is optional and empty means "follow the channel's unified API", so the modal
 * doubles as the place to see exactly which parts of the channel API this one model overrides.
 */
export function ChannelModelApiEditor({
    open,
    channel,
    model,
    onSave,
    onClose,
}: {
    open: boolean;
    channel: ModelChannel;
    model: ChannelModel | null;
    onSave: (patch: ChannelModelApiPatch) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [baseUrl, setBaseUrl] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [transport, setTransport] = useState<TransportChoice>("inherit");

    useEffect(() => {
        if (!open || !model) return;
        setBaseUrl(model.baseUrl || "");
        setApiKey([model.apiKey || "", ...(model.apiKeys || [])].filter(Boolean).join("\n"));
        setTransport(model.apiTransport === "direct" || model.apiTransport === "proxy" ? model.apiTransport : "inherit");
    }, [open, model]);

    const channelKeyCount = useMemo(() => parseApiKeys([channel.apiKey || "", ...(channel.apiKeys || [])].join("\n")).length, [channel.apiKey, channel.apiKeys]);
    const protocol = model ? resolveChannelModelApiFormat(channel, model) : channel.apiFormat;
    const hasOverride = channelModelHasApiOverride(model || undefined);
    const dirty = Boolean(baseUrl.trim() || apiKey.trim() || transport !== "inherit");
    const baseUrlPlaceholder = channel.baseUrl || "https://api.example.com";
    const transportOptions: Array<{ label: string; value: TransportChoice }> = [
        { label: t("config.modelApi.inherit"), value: "inherit" },
        { label: t("config.preferences.apiTransportDirect"), value: "direct" },
        { label: t("config.preferences.apiTransportProxy"), value: "proxy" },
    ];

    if (!model) return null;

    const save = () => {
        const keys = parseApiKeys(apiKey);
        const trimmedBaseUrl = baseUrl.trim();
        onSave({
            baseUrl: trimmedBaseUrl ? normalizeProviderBaseUrl(trimmedBaseUrl) : undefined,
            apiKey: keys[0] || undefined,
            apiKeys: keys.length > 1 ? keys.slice(1) : undefined,
            apiTransport: transport === "inherit" ? undefined : transport,
        });
        onClose();
    };

    // "恢复统一 API" applies immediately: clearing every override field sends the model back to
    // the channel API without a second Save click.
    const reset = () => {
        onSave({ baseUrl: undefined, apiKey: undefined, apiKeys: undefined, apiTransport: undefined });
        onClose();
    };

    return (
        <Modal
            open={open}
            centered
            width={620}
            onCancel={onClose}
            title={
                <div>
                    <div className="text-base font-semibold">
                        {t("config.modelApi.title")} · <span className="font-mono text-sm">{model.name}</span>
                    </div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modelApi.description")}</div>
                </div>
            }
            footer={
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" danger disabled={!dirty && !hasOverride} onClick={reset}>
                            {t("config.modelApi.followChannel")}
                        </Button>
                        <span className="text-xs text-stone-500">{dirty ? t("config.modelApi.stateOverride") : t("config.modelApi.stateInherit")}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button onClick={onClose}>{t("common.cancel")}</Button>
                        <Button type="primary" onClick={save}>
                            {t("common.save")}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="space-y-4 pt-1">
                <Alert type="info" showIcon message={t("config.modelApi.hint", { channel: channel.name })} />

                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.modelApi.baseUrl")}</span>
                    <Input value={baseUrl} placeholder={baseUrlPlaceholder} onChange={(event) => setBaseUrl(event.target.value)} />
                    <span className="mt-1 block text-xs text-stone-500">
                        {baseUrl.trim() ? t("config.modelApi.baseUrlOwn") : t("config.modelApi.baseUrlInherit", { url: baseUrlPlaceholder })}
                    </span>
                </label>

                <label className="block">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.TextArea
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={t("config.modelApi.apiKeyPlaceholder")}
                        autoSize={{ minRows: 1, maxRows: 6 }}
                    />
                    <span className="mt-1 block text-xs text-stone-500">
                        {apiKey.trim() ? t("config.modelApi.apiKeyOwn", { count: parseApiKeys(apiKey).length }) : t("config.modelApi.apiKeyInherit", { count: channelKeyCount })}
                    </span>
                </label>

                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.modelApi.transport")}</span>
                    <Segmented block value={transport} options={transportOptions} onChange={(value) => setTransport(value as TransportChoice)} />
                    <span className="mt-1 block text-xs text-stone-500">
                        {transport === "inherit"
                            ? channel.apiTransport
                                ? t("config.modelApi.transportInheritChannel", { value: channel.apiTransport === "direct" ? t("config.preferences.apiTransportDirect") : t("config.preferences.apiTransportProxy") })
                                : t("config.modelApi.transportInheritGlobal")
                            : t("config.modelApi.transportOwn")}
                    </span>
                </label>

                <div className="rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-600 dark:border-stone-800 dark:text-stone-300">
                    <div className="font-medium">{t("config.modelApi.summary")}</div>
                    <div className="mt-1 font-mono text-[11px] leading-5 break-all">
                        {t("config.modelApi.summaryProtocol")}: {protocol === "gemini" ? "Gemini" : "OpenAI"}
                    </div>
                    <div className="font-mono text-[11px] leading-5 break-all">
                        {t("config.modelApi.summaryEndpoint")}: {baseUrl.trim() ? normalizeProviderBaseUrl(baseUrl.trim()) : channel.baseUrl || "—"}
                    </div>
                </div>
            </div>
        </Modal>
    );
}
