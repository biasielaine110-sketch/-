import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Select, Tooltip } from "antd";
import type { DefaultOptionType } from "antd/es/select";
import { Cpu, ListChecks, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { cn } from "@/lib/utils";
import { ensureModelHealth, ensureModelsHealth, getModelHealth, modelHealthKey, subscribeModelHealth, type ModelHealthStatus } from "@/services/api/model-health";
import { modelOptionLabel, modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

const MODEL_PICKER_POPUP_MIN_WIDTH = 420;

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [bulkChecking, setBulkChecking] = useState(false);
    const [, bump] = useState(0);
    const models = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const healthCapability = capability || "text";
    const current = value || undefined;
    const autoHealth = healthCapability === "image" || healthCapability === "video";

    useEffect(() => subscribeModelHealth(() => bump((value) => value + 1)), []);

    useEffect(() => {
        if (!autoHealth || !current || current === "__empty__") return;
        const controller = new AbortController();
        // Selected model always jumps ahead of any in-progress bulk check.
        void ensureModelHealth(config, current, healthCapability, { priority: true, signal: controller.signal });
        return () => controller.abort();
    }, [autoHealth, config, current, healthCapability]);

    const selectOptions = useMemo<DefaultOptionType[]>(
        () =>
            models.length
                ? models.map((model) => ({
                      value: model,
                      label: <ModelLabel config={config} model={model} capability={healthCapability} />,
                      title: modelOptionLabel(config, model),
                  }))
                : [
                      {
                          value: "__empty__",
                          label: emptyModelLabel(config, capability),
                          title: emptyModelLabel(config, capability),
                          disabled: true,
                      },
                  ],
        [bump, capability, config, healthCapability, models],
    );
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");
    const currentHealth = current && current !== "__empty__" ? getModelHealth(modelHealthKey(config, current, healthCapability)) : { status: "idle" as const };
    const canCheck = Boolean(current && current !== "__empty__");
    const checking = currentHealth.status === "checking";
    const anyChecking = bulkChecking || models.some((model) => getModelHealth(modelHealthKey(config, model, healthCapability)).status === "checking");

    const checkCurrent = () => {
        if (!canCheck || !current) return;
        void ensureModelHealth(config, current, healthCapability, { force: true, priority: true });
    };

    const checkAll = () => {
        if (!models.length || bulkChecking) return;
        setBulkChecking(true);
        void ensureModelsHealth(config, models, healthCapability, { force: true })
            .catch(() => undefined)
            .finally(() => setBulkChecking(false));
        // Re-assert selected model at the front of the queue after bulk enqueue.
        if (current && current !== "__empty__") {
            void ensureModelHealth(config, current, healthCapability, { priority: true });
        }
    };

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <div className={cn("flex min-w-0 max-w-full items-center gap-1", fullWidth && "w-full")} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className={cn("min-w-0 overflow-hidden", fullWidth ? "w-full flex-1" : "w-auto", className)}>
                <Select
                    open={open}
                    value={current}
                    placeholder={pickerPlaceholder}
                    className={cn("canvas-composer-model-picker h-8 w-full min-w-0 max-w-full [&_.ant-select-selector]:!rounded-full [&_.ant-select-selector]:!px-3")}
                    popupMatchSelectWidth={MODEL_PICKER_POPUP_MIN_WIDTH}
                    options={selectOptions}
                    optionLabelProp="title"
                    getPopupContainer={() => document.body}
                    classNames={{ popup: { root: "canvas-model-picker-dropdown" } }}
                    styles={{ popup: { root: { minWidth: MODEL_PICKER_POPUP_MIN_WIDTH } } }}
                    popupRender={(menu) => (
                        <div
                            data-canvas-no-zoom
                            data-canvas-shortcuts-ignore
                            className="w-full"
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                        >
                            {menu}
                        </div>
                    )}
                    onOpenChange={(nextOpen) => {
                        if (nextOpen && !models.length && config.channelMode === "local") onMissingConfig?.();
                        if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                        setOpen(nextOpen);
                    }}
                    onSelect={(model) => {
                        if (model && model !== "__empty__") onChange(String(model));
                    }}
                    onChange={(model) => {
                        if (model && model !== "__empty__") onChange(String(model));
                    }}
                    labelRender={(props) => {
                        const model = String(props.value || current || "");
                        const titleText = model && model !== "__empty__" ? modelOptionLabel(config, model) : "";
                        const fallback = typeof props.label === "string" || typeof props.label === "number" ? String(props.label) : pickerPlaceholder;
                        const text: ReactNode = titleText || fallback;
                        return (
                            <span className="flex min-w-0 items-center gap-2">
                                <HealthDot
                                    status={model && model !== "__empty__" ? currentHealth.status : "idle"}
                                    message={currentHealth.status === "fail" ? currentHealth.message : undefined}
                                    idleHint={autoHealth ? t("settingsPanels.model.healthIdleAuto") : t("settingsPanels.model.healthIdleManual")}
                                />
                                <ModelIcon model={model} />
                                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{text}</span>
                            </span>
                        );
                    }}
                />
            </div>
            {autoHealth ? (
                <Tooltip title={t("settingsPanels.model.healthCheckAll")}>
                    <button
                        type="button"
                        aria-label={t("settingsPanels.model.healthCheckAll")}
                        disabled={!models.length || bulkChecking}
                        onClick={(event) => {
                            event.stopPropagation();
                            checkAll();
                        }}
                        className={cn(
                            "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800",
                            anyChecking && "text-amber-500",
                        )}
                    >
                        <ListChecks className={cn("size-3.5", anyChecking && "animate-pulse")} />
                    </button>
                </Tooltip>
            ) : null}
            <Tooltip title={autoHealth ? t("settingsPanels.model.healthRecheck") : t("settingsPanels.model.healthCheck")}>
                <button
                    type="button"
                    aria-label={autoHealth ? t("settingsPanels.model.healthRecheck") : t("settingsPanels.model.healthCheck")}
                    disabled={!canCheck || checking}
                    onClick={(event) => {
                        event.stopPropagation();
                        checkCurrent();
                    }}
                    className={cn(
                        "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800",
                        checking && "text-amber-500",
                    )}
                >
                    <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
                </button>
            </Tooltip>
        </div>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model, capability }: { config: AiConfig; model: string; capability: ModelCapability }) {
    const health = getModelHealth(modelHealthKey(config, model, capability));
    return (
        <span className="flex w-full min-w-0 items-center gap-2">
            <HealthDot status={health.status} message={health.message} />
            <ModelIcon model={model} />
            <span className="min-w-0 flex-1 whitespace-nowrap" title={modelOptionName(model)}>{modelOptionLabel(config, model)}</span>
        </span>
    );
}

export function HealthDot({ status, message, idleHint }: { status: ModelHealthStatus; message?: string; idleHint?: string }) {
    const { t } = useTranslation();
    const title =
        status === "ok"
            ? t("settingsPanels.model.healthOk")
            : status === "fail"
              ? message || t("settingsPanels.model.healthFail")
              : status === "checking"
                ? t("settingsPanels.model.healthChecking")
                : idleHint || t("settingsPanels.model.healthIdle");
    return (
        <Tooltip title={title}>
            <span
                aria-label={title}
                className={cn(
                    "inline-block size-2 shrink-0 rounded-full",
                    status === "ok" && "bg-emerald-500",
                    status === "fail" && "bg-rose-500",
                    status === "checking" && "animate-pulse bg-amber-400",
                    status === "idle" && "bg-stone-300 dark:bg-stone-600",
                )}
            />
        </Tooltip>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm")) return "/icons/glm.svg";
    return "";
}
