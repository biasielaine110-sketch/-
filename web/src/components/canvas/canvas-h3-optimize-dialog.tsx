import { useEffect, useMemo, useState } from "react";
import { App, Button, Modal } from "antd";
import { ScrollText, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { CHANGAN_FORMAT_SYSTEM } from "@/lib/canvas/changan-prompt-format";
import { resolveH3OptimizeSystemPrompt, type H3OptimizeTarget } from "@/lib/canvas/h3-prompt-optimize";
import { useChatSkillPacksStore } from "@/stores/use-chat-skill-packs-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type CanvasH3OptimizeDialogProps = {
    open: boolean;
    /**
     * 弹窗模式：
     *  - `h3`（缺省）= 多选右键的「h3 提示词优化」，instruction 从技能库 / 词库解析、模型可单独选；
     *  - `changan` = 多选右键的「《长安异闻录》格式」（用户 2026-11-23 晚间第 03 条），
     *    instruction **内置**（`CHANGAN_FORMAT_SYSTEM`，13 章节模板）、模型**恒跟偏好里的文本模型**
     *    （不给选，与单节点弹窗里那条同口径）；「【资产锁定】」块不参与转换。
     */
    mode?: "h3" | "changan";
    /** 选区里可优化的目标（图片 / 视频节点，提示词非空），按画布顺序 */
    targets: H3OptimizeTarget[];
    /** capability=text 的配置；模型默认取 `config.textModel` */
    config: AiConfig;
    /**
     * 点「开始」：把这次选的模型 + 已解析好的 instruction 交出去。
     *
     * **弹窗自己不再跑队列**（用户 2026-11-07：「选择模型执行后…不要一直挂着，我无法操作别的内容了」）。
     * 上层拿到参数会立刻关窗、把任务丢进 `lib/canvas/h3-optimize-runner.ts` 的后台队列，
     * 由右下角的 `CanvasH3OptimizeProgress` 显示进度 / 提供停止。
     */
    onStart: (options: { model: string; systemPrompt: string }) => void;
    onClose: () => void;
};

/**
 * 多选节点右键 →「h3 提示词优化 /《长安异闻录》格式」的弹窗。
 *
 * 只干两件事：**确认要转哪些** + **（h3 模式）选模型**。点开始就关窗，
 * 后面的串行转换在后台进行，画布可以照常操作。
 *
 * h3 模式的 instruction 自己解析（技能库「转Minih3-视频提示词」优先 → 词库兜底），
 * 这样 project.tsx 不必为了这条技能去订阅技能库 / 词库。
 */
export function CanvasH3OptimizeDialog({ open, mode = "h3", targets, config, onStart, onClose }: CanvasH3OptimizeDialogProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const isChangan = mode === "changan";
    const skillPacks = useChatSkillPacksStore((state) => state.packs);
    const textPrompts = useConfigStore((state) => state.config.textPrompts || []);
    const h3Source = useMemo(() => resolveH3OptimizeSystemPrompt(skillPacks, textPrompts), [skillPacks, textPrompts]);
    // changan 的指令内置（用户点名的固定模板），不走技能库也不走词库
    const source = isChangan ? { text: CHANGAN_FORMAT_SYSTEM, title: "", source: "skill" as const } : h3Source;
    const [model, setModel] = useState("");

    // 每次打开都把模型重置成「默认文本模型」，避免上一次挑的模型被顺延到另一批节点上。
    useEffect(() => {
        if (!open) return;
        setModel(config.textModel || config.model || "");
    }, [open, config.model, config.textModel]);

    const start = () => {
        if (!targets.length) return;
        if (!source.text.trim()) {
            message.warning(t("canvas.h3Optimize.missingInstruction"));
            return;
        }
        onStart({ model: model.trim(), systemPrompt: source.text });
    };

    return (
        <Modal
            open={open}
            centered
            width={560}
            zIndex={4200}
            destroyOnHidden
            title={t(isChangan ? "canvas.changanFormat.title" : "canvas.h3Optimize.title")}
            onCancel={onClose}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    {t("common.cancel")}
                </Button>,
                <Button
                    key="run"
                    type="primary"
                    icon={isChangan ? <ScrollText className="size-3.5" /> : <WandSparkles className="size-3.5" />}
                    disabled={!targets.length}
                    onClick={start}
                >
                    {t(isChangan ? "canvas.changanFormat.start" : "canvas.h3Optimize.start")}
                </Button>,
            ]}
        >
            <div className="space-y-3">
                <p className="text-xs text-stone-500">
                    {isChangan ? (
                        t("canvas.changanFormat.hint", { count: targets.length })
                    ) : (
                        t(source.source === "skill" ? "canvas.h3Optimize.hintSkill" : "canvas.h3Optimize.hintLibrary", { count: targets.length, title: source.title })
                    )}
                </p>
                {/* changan：模型不给选（恒跟偏好里的文本模型），只读展示 —— 与单节点弹窗那条同口径。 */}
                {isChangan ? (
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 text-xs text-stone-500">{t("canvas.textEditDialog.changanFormatModel")}</span>
                        <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-stone-600 dark:text-stone-300">
                            {config.textModel || config.model || t("canvas.textEditDialog.changanFormatModelEmpty")}
                        </span>
                    </div>
                ) : (
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 text-xs text-stone-500">{t("canvas.h3Optimize.model")}</span>
                        <ModelPicker config={config} value={model || config.textModel} onChange={setModel} capability="text" className="min-w-0 flex-1" />
                    </div>
                )}
                <ul className="thin-scrollbar max-h-64 space-y-1 overflow-y-auto rounded-xl border border-stone-200 p-2 text-xs dark:border-stone-700">
                    {targets.map((target, index) => (
                        <li key={target.id} className="flex items-center gap-2">
                            <span className="w-5 shrink-0 text-right tabular-nums opacity-50">{index + 1}</span>
                            <span className="min-w-0 flex-1 truncate">{target.title}</span>
                        </li>
                    ))}
                    {!targets.length ? <li className="px-1 py-2 opacity-60">{t(isChangan ? "canvas.changanFormat.empty" : "canvas.h3Optimize.empty")}</li> : null}
                </ul>
                <p className="text-xs text-stone-500">{t(isChangan ? "canvas.changanFormat.backgroundHint" : "canvas.h3Optimize.backgroundHint")}</p>
            </div>
        </Modal>
    );
}
