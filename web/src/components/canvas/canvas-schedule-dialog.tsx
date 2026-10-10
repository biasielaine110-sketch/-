import { useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, InputNumber, Modal, Segmented } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

/** Quick delay presets (minutes) shown as chips next to the custom input. */
const QUICK_MINUTES = [5, 10, 30, 60];

type ScheduleMode = "delay" | "at";

/**
 * 定时生成对话框：延时 N 分钟 / 指定时间两档，确认后把 scheduledAt 写回节点，
 * 由画布页面的心跳调度器到点触发一次生成。
 */
export function CanvasScheduleDialog({
    open,
    scheduledAt,
    onClose,
    onSchedule,
    onCancelSchedule,
}: {
    open: boolean;
    scheduledAt?: number;
    onClose: () => void;
    onSchedule: (at: number) => void;
    onCancelSchedule: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [mode, setMode] = useState<ScheduleMode>("delay");
    const [minutes, setMinutes] = useState<number>(5);
    const [at, setAt] = useState<Dayjs | null>(null);

    useEffect(() => {
        if (!open) return;
        setMode("delay");
        setMinutes(5);
        setAt(dayjs().add(10, "minute").second(0));
    }, [open]);

    const preview = useMemo(() => {
        if (mode === "delay") return dayjs().add(Math.max(1, Math.round(minutes || 0)), "minute");
        return at ?? null;
    }, [mode, minutes, at]);

    const canConfirm = mode === "delay" ? Number.isFinite(minutes) && minutes >= 1 : Boolean(at && at.valueOf() > Date.now());

    const confirm = () => {
        const target = mode === "delay" ? dayjs().add(Math.max(1, Math.round(minutes || 0)), "minute") : at;
        if (!target || target.valueOf() <= Date.now()) {
            message.warning(t("canvas.schedule.invalid"));
            return;
        }
        onSchedule(target.valueOf());
        message.success(t("canvas.schedule.done", { time: target.format("MM-DD HH:mm") }));
        onClose();
    };

    const clearSchedule = () => {
        onCancelSchedule();
        message.success(t("canvas.schedule.cleared"));
        onClose();
    };

    return (
        <Modal title={t("canvas.schedule.title")} open={open} onCancel={onClose} footer={null} width={440} centered destroyOnHidden>
            <div className="space-y-4 pt-1">
                <Segmented
                    block
                    value={mode}
                    onChange={(value) => setMode(value as ScheduleMode)}
                    options={[
                        { label: t("canvas.schedule.delayTab"), value: "delay" },
                        { label: t("canvas.schedule.atTab"), value: "at" },
                    ]}
                />
                {mode === "delay" ? (
                    <div className="space-y-3">
                        <div className="text-sm opacity-70">{t("canvas.schedule.delayHint")}</div>
                        <div className="flex flex-wrap items-center gap-2">
                            {QUICK_MINUTES.map((value) => (
                                <Button key={value} size="small" type={minutes === value ? "primary" : "default"} onClick={() => setMinutes(value)}>
                                    {value} {t("canvas.schedule.minutes")}
                                </Button>
                            ))}
                            <InputNumber min={1} max={10080} value={minutes} onChange={(value) => setMinutes(Number(value) || 1)} addonAfter={t("canvas.schedule.minutes")} style={{ width: 150 }} />
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="text-sm opacity-70">{t("canvas.schedule.pickTime")}</div>
                        <DatePicker
                            showTime={{ format: "HH:mm" }}
                            format="YYYY-MM-DD HH:mm"
                            value={at}
                            onChange={(value) => setAt(value)}
                            placeholder={t("canvas.schedule.placeholder")}
                            style={{ width: "100%" }}
                            disabledDate={(current) => Boolean(current && current.startOf("day").isBefore(dayjs().startOf("day")))}
                        />
                    </div>
                )}
                <div className="min-h-4 text-xs opacity-60">{preview ? t("canvas.schedule.current", { time: preview.format("MM-DD HH:mm") }) : ""}</div>
                <div className="flex items-center justify-between gap-2 pt-1">
                    {scheduledAt ? (
                        <Button type="text" danger onClick={clearSchedule}>
                            {t("canvas.promptPanel.scheduleCancel")}
                        </Button>
                    ) : (
                        <span />
                    )}
                    <div className="flex items-center gap-2">
                        <Button onClick={onClose}>{t("canvas.schedule.cancel")}</Button>
                        <Button type="primary" disabled={!canConfirm} onClick={confirm}>
                            {t("canvas.schedule.confirm")}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
