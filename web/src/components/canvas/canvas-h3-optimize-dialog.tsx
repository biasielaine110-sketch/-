import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Modal } from "antd";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { requestH3PromptOptimize, resolveH3OptimizeSystemPrompt, type H3OptimizeTarget } from "@/lib/canvas/h3-prompt-optimize";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type TargetStatus = "pending" | "running" | "done" | "failed";

type CanvasH3OptimizeDialogProps = {
    open: boolean;
    /** 选区里可优化的目标（图片 / 视频节点，提示词非空），按画布顺序 */
    targets: H3OptimizeTarget[];
    /** capability=text 的配置；模型默认取 `config.textModel` */
    config: AiConfig;
    /** 每转完一段（含流式中间态）就回写一次，节点上能实时看到变化 */
    onApply: (target: H3OptimizeTarget, text: string) => void;
    onClose: () => void;
};

/**
 * 多选节点右键 →「h3 提示词优化」的弹窗。
 *
 * 先在这里选模型（默认默认文本模型），再**逐个**跑：前一个跑完才发下一个，
 * 每个节点各自带着自己的提示词，不会把 A 的内容写到 B 上（写回字段由
 * `H3OptimizeTarget.field` 决定，和提示词面板同口径）。
 *
 * instruction 自己解析（技能库「转Minih3-视频提示词」优先 → 词库兜底），
 * 这样 project.tsx 不必为了这条技能去订阅技能库 / 词库。
 */
export function CanvasH3OptimizeDialog({ open, targets, config, onApply, onClose }: CanvasH3OptimizeDialogProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const skillPacks = useChatSkillPacksStore((state) => state.packs);
    const textPrompts = useConfigStore((state) => state.config.textPrompts || []);
    const source = useMemo(() => resolveH3OptimizeSystemPrompt(skillPacks, textPrompts), [skillPacks, textPrompts]);
    const [model, setModel] = useState("");
    const [running, setRunning] = useState(false);
    const [statusById, setStatusById] = useState<Record<string, TargetStatus>>({});
    const abortRef = useRef<AbortController | null>(null);

    const reset = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setRunning(false);
        setStatusById({});
    }, []);

    // 关掉 / 卸载就掐掉队列，避免关窗后还有节点在后台被改写。
    useEffect(() => {
        if (open) {
            setStatusById({});
            return;
        }
        abortRef.current?.abort();
        abortRef.current = null;
        setRunning(false);
    }, [open]);
    useEffect(() => () => abortRef.current?.abort(), []);

    const stop = () => {
        abortRef.current?.abort();
    };

    const start = async () => {
        if (running) {
            stop();
            return;
        }
        if (!targets.length) return;
        if (!source.text.trim()) {
            message.warning(t("canvas.h3Optimize.missingInstruction"));
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        setStatusById(Object.fromEntries(targets.map((target) => [target.id, "pending" as TargetStatus])));
        const requestConfig: AiConfig = { ...config, model: model.trim() || config.textModel || config.model };
        let done = 0;
        let failed = 0;
        for (const target of targets) {
            if (controller.signal.aborted) break;
            setStatusById((prev) => ({ ...prev, [target.id]: "running" }));
            try {
                const answer = await requestH3PromptOptimize(requestConfig, target.text, {
                    systemPrompt: source.text,
                    signal: controller.signal,
                    onStream: (text) => {
                        if (controller.signal.aborted) return;
                        onApply(target, text);
                    },
                });
                if (controller.signal.aborted) break;
                onApply(target, answer);
                done += 1;
                setStatusById((prev) => ({ ...prev, [target.id]: "done" }));
            } catch {
                if (controller.signal.aborted) break;
                failed += 1;
                setStatusById((prev) => ({ ...prev, [target.id]: "failed" }));
            }
        }
        abortRef.current = null;
        setRunning(false);
        if (controller.signal.aborted) {
            message.info(t("canvas.h3Optimize.cancelled", { count: done }));
            return;
        }
        if (failed > 0) message.warning(t("canvas.h3Optimize.doneWithFailed", { count: done, failed }));
        else message.success(t("canvas.h3Optimize.done", { count: done }));
        if (failed === 0) onClose();
    };

    const statusLabel = (status: TargetStatus | undefined) => {
        if (status === "running") return t("canvas.h3Optimize.statusRunning");
        if (status === "done") return t("canvas.h3Optimize.statusDone");
        if (status === "failed") return t("canvas.h3Optimize.statusFailed");
        return t("canvas.h3Optimize.statusPending");
    };

    return (
        <Modal
            open={open}
            centered
            width={560}
            zIndex={4200}
            destroyOnHidden
            title={t("canvas.h3Optimize.title")}
            onCancel={() => {
                reset();
                onClose();
            }}
            footer={[
                <Button
                    key="cancel"
                    onClick={() => {
                        reset();
                        onClose();
                    }}
                >
                    {t("common.cancel")}
                </Button>,
                <Button key="run" type="primary" disabled={!targets.length} onClick={() => void start()}>
                    {running ? t("canvas.h3Optimize.stop") : t("canvas.h3Optimize.start")}
                </Button>,
            ]}
        >
            <div className="space-y-3">
                <p className="text-xs text-stone-500">
                    {t(source.source === "skill" ? "canvas.h3Optimize.hintSkill" : "canvas.h3Optimize.hintLibrary", { count: targets.length, title: source.title })}
                </p>
                <div className={`flex items-center gap-2 ${running ? "pointer-events-none opacity-60" : ""}`}>
                    <span className="shrink-0 text-xs text-stone-500">{t("canvas.h3Optimize.model")}</span>
                    <ModelPicker config={config} value={model || config.textModel} onChange={setModel} capability="text" className="min-w-0 flex-1" />
                </div>
                <ul className="thin-scrollbar max-h-64 space-y-1 overflow-y-auto rounded-xl border border-stone-200 p-2 text-xs dark:border-stone-700">
                    {targets.map((target, index) => {
                        const status = statusById[target.id];
                        return (
                            <li key={target.id} className="flex items-center gap-2">
                                <span className="w-5 shrink-0 text-right tabular-nums opacity-50">{index + 1}</span>
                                <span className="min-w-0 flex-1 truncate">{target.title}</span>
                                <span className={`shrink-0 tabular-nums ${status === "failed" ? "text-red-500" : "opacity-60"}`}>
                                    {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                                    {status && status !== "running" ? statusLabel(status) : null}
                                </span>
                            </li>
                        );
                    })}
                    {!targets.length ? <li className="px-1 py-2 opacity-60">{t("canvas.h3Optimize.empty")}</li> : null}
                </ul>
                {running ? (
                    <p className="flex items-center gap-1.5 text-xs text-stone-500">
                        <WandSparkles className="size-3.5" />
                        {t("canvas.h3Optimize.runningHint")}
                    </p>
                ) : null}
            </div>
        </Modal>
    );
}
