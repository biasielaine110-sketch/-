import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, InputNumber, Modal, Slider } from "antd";
import { Music2, RotateCcw, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatAudioClock, loadAudioBlob, trimAudioBlob } from "@/lib/canvas/canvas-audio-tools";
import { proxyMediaUrl } from "@/lib/api-proxy";

export type AudioToolsTrimResult = { blob: Blob; startSec: number; endSec: number };

type CanvasNodeAudioToolsDialogProps = {
    open: boolean;
    audioUrl: string;
    canRestore?: boolean;
    onClose: () => void;
    onTrim: (result: AudioToolsTrimResult) => Promise<void> | void;
    onRestore?: () => void;
};

export function CanvasNodeAudioToolsDialog({ open, audioUrl, canRestore = false, onClose, onTrim, onRestore }: CanvasNodeAudioToolsDialogProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const audioRef = useRef<HTMLAudioElement>(null);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [range, setRange] = useState<[number, number]>([0, 1]);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    const previewSrc = useMemo(() => {
        if (!audioUrl) return "";
        return audioUrl.startsWith("blob:") || audioUrl.startsWith("data:") ? audioUrl : proxyMediaUrl(audioUrl);
    }, [audioUrl]);

    useEffect(() => {
        if (!open) return;
        setBusy(false);
        setProgress(0);
        setCurrentTime(0);
        setDuration(0);
        setRange([0, 1]);
    }, [open, audioUrl]);

    const seekTo = (time: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        const next = Math.min(Math.max(0, time), Math.max(0, (duration || audio.duration || 0) - 0.05));
        try {
            audio.pause();
            audio.currentTime = next;
            setCurrentTime(next);
        } catch {
            // ignore seek errors on unfinished metadata
        }
    };

    const updateTrimRange = (next: [number, number], preferEnd = false) => {
        const prev = range;
        const startChanged = Math.abs(next[0] - prev[0]) > 0.001;
        const endChanged = Math.abs(next[1] - prev[1]) > 0.001;
        setRange(next);
        if (preferEnd || (endChanged && !startChanged)) seekTo(next[1]);
        else if (startChanged) seekTo(next[0]);
        else seekTo(preferEnd ? next[1] : next[0]);
    };

    const handleLoadedMetadata = () => {
        const audio = audioRef.current;
        if (!audio) return;
        const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        setDuration(nextDuration);
        setRange([0, nextDuration || 1]);
        setCurrentTime(audio.currentTime || 0);
    };

    const runTrim = async () => {
        if (busy) return;
        const [start, end] = range;
        if (end - start < 0.05) {
            message.warning(t("canvas.audioTools.trimTooShort"));
            return;
        }
        setBusy(true);
        setProgress(0);
        try {
            const source = await loadAudioBlob(audioUrl);
            const blob = await trimAudioBlob(source, start, end, setProgress);
            await onTrim({ blob, startSec: start, endSec: end });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.audioTools.trimFailed"));
        } finally {
            setBusy(false);
            setProgress(0);
        }
    };

    return (
        <Modal
            title={null}
            open={open && Boolean(audioUrl)}
            onCancel={() => {
                if (!busy) onClose();
            }}
            footer={null}
            width={640}
            centered
            destroyOnHidden
            maskClosable={!busy}
        >
            <div className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.audioTools.title")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.audioTools.subtitle")}</p>
                </div>

                <div className="space-y-3 rounded-xl border p-3">
                    <audio
                        key={previewSrc}
                        ref={audioRef}
                        src={previewSrc}
                        className="w-full"
                        controls
                        preload="metadata"
                        onLoadedMetadata={handleLoadedMetadata}
                        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    />
                    <div className="flex items-center justify-between text-sm">
                        <span className="opacity-60">{t("canvas.audioTools.currentTime")}</span>
                        <span className="font-semibold">
                            {formatAudioClock(currentTime)} / {formatAudioClock(duration)}
                        </span>
                    </div>
                </div>

                <div className="space-y-4 rounded-xl border p-3">
                    <div className="inline-flex items-center gap-1.5 text-sm font-medium opacity-80">
                        <Scissors className="size-3.5" />
                        {t("canvas.audioTools.trimRange")}
                    </div>
                    <Slider
                        range
                        min={0}
                        max={Math.max(duration, 0.1)}
                        step={0.1}
                        value={range}
                        disabled={!duration || busy}
                        onChange={(value) => updateTrimRange(value as [number, number])}
                    />
                    <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1 text-xs opacity-70">
                            <span>{t("canvas.audioTools.start")}</span>
                            <InputNumber
                                className="!w-full"
                                min={0}
                                max={range[1]}
                                step={0.1}
                                value={Number(range[0].toFixed(1))}
                                disabled={!duration || busy}
                                onChange={(value) => {
                                    const start = Math.max(0, Number(value) || 0);
                                    updateTrimRange([start, Math.max(start + 0.1, range[1])], false);
                                }}
                            />
                        </label>
                        <label className="space-y-1 text-xs opacity-70">
                            <span>{t("canvas.audioTools.end")}</span>
                            <InputNumber
                                className="!w-full"
                                min={range[0]}
                                max={Math.max(duration, range[0] + 0.1)}
                                step={0.1}
                                value={Number(range[1].toFixed(1))}
                                disabled={!duration || busy}
                                onChange={(value) => {
                                    const end = Math.max(range[0] + 0.1, Number(value) || 0);
                                    updateTrimRange([range[0], end], true);
                                }}
                            />
                        </label>
                    </div>
                    <div className="rounded-xl border px-3 py-2 text-sm">
                        <div className="flex justify-between">
                            <span className="opacity-60">{t("canvas.audioTools.clipDuration")}</span>
                            <span className="font-semibold">{formatAudioClock(Math.max(0, range[1] - range[0]))}</span>
                        </div>
                        {busy && progress > 0 ? (
                            <div className="mt-1 flex justify-between">
                                <span className="opacity-60">{t("canvas.audioTools.progress")}</span>
                                <span className="font-semibold">{Math.round(progress * 100)}%</span>
                            </div>
                        ) : null}
                    </div>
                    <div className="flex flex-col gap-2">
                        <Button type="primary" size="large" block icon={<Music2 className="size-4" />} loading={busy} disabled={!duration} onClick={() => void runTrim()}>
                            {t("canvas.audioTools.trimAction")}
                        </Button>
                        {canRestore ? (
                            <Button size="large" block icon={<RotateCcw className="size-4" />} disabled={busy} onClick={() => onRestore?.()}>
                                {t("canvas.audioTools.restoreAction")}
                            </Button>
                        ) : null}
                    </div>
                </div>
            </div>
        </Modal>
    );
}
