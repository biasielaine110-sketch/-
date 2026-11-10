import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, InputNumber, Modal, Segmented, Slider, Tabs } from "antd";
import { Clapperboard, Film, ImagePlus, Scaling, Scissors, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import {
    extractVideoFrameDataUrl,
    formatVideoClock,
    isVideoUpscalerModel,
    loadVideoBlob,
    scaleVideoBlob,
    trimVideoBlob,
    VIDEO_SCALE_PERCENTAGES,
    VIDEO_UPSCALE_RESOLUTIONS,
    type VideoScalePercentage,
    type VideoUpscaleResolution,
} from "@/lib/canvas/canvas-video-tools";
import { proxyMediaUrl } from "@/lib/api-proxy";
import { findPreferredModelOption, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

export type VideoToolsTab = "trim" | "frame" | "upscale" | "scale";

export type VideoToolsTrimResult = { blob: Blob; startSec: number; endSec: number };
export type VideoToolsFrameResult = { dataUrl: string; timeSec: number };
export type VideoToolsUpscaleResult = { model: string; resolution: VideoUpscaleResolution };
export type VideoToolsScaleResult = { blob: Blob; width: number; height: number; percent: number };

type CanvasNodeVideoToolsDialogProps = {
    open: boolean;
    videoUrl: string;
    /** 节点在 IndexedDB / 本地媒体库里的 key：直链过期或没带 CORS 时靠它拿原片字节。 */
    videoStorageKey?: string;
    config: AiConfig;
    initialTab?: VideoToolsTab;
    onClose: () => void;
    onTrim: (result: VideoToolsTrimResult) => Promise<void> | void;
    onFrame: (result: VideoToolsFrameResult) => Promise<void> | void;
    onUpscale: (result: VideoToolsUpscaleResult, signal?: AbortSignal) => Promise<void> | void;
    onScale: (result: VideoToolsScaleResult) => Promise<void> | void;
    onMissingConfig?: () => void;
};

export function CanvasNodeVideoToolsDialog({ open, videoUrl, videoStorageKey, config, initialTab = "trim", onClose, onTrim, onFrame, onUpscale, onScale, onMissingConfig }: CanvasNodeVideoToolsDialogProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [tab, setTab] = useState<VideoToolsTab>(initialTab);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [range, setRange] = useState<[number, number]>([0, 1]);
    const [frameTime, setFrameTime] = useState(0);
    const [framePreview, setFramePreview] = useState<string | null>(null);
    const [upscaleModel, setUpscaleModel] = useState("");
    const [resolution, setResolution] = useState<VideoUpscaleResolution>("1080p");
    const [scalePercent, setScalePercent] = useState<VideoScalePercentage>(50);
    const [sourceSize, setSourceSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const abortRef = useRef<AbortController | null>(null);

    const previewSrc = useMemo(() => {
        if (!videoUrl) return "";
        return videoUrl.startsWith("blob:") || videoUrl.startsWith("data:") ? videoUrl : proxyMediaUrl(videoUrl);
    }, [videoUrl]);

    const videoModels = useMemo(() => selectableModelsByCapability(config, "video"), [config]);
    const preferredUpscaler = useMemo(() => {
        const fromPreferred = findPreferredModelOption(config.channels, "video", ["zhenzhen-upscaler"]);
        if (fromPreferred) return fromPreferred;
        const match = videoModels.find((model) => isVideoUpscalerModel(model));
        return match || videoModels[0] || "";
    }, [config.channels, videoModels]);

    useEffect(() => {
        if (!open) return;
        setTab(initialTab);
        setBusy(false);
        setProgress(0);
        setFramePreview(null);
        setUpscaleModel(preferredUpscaler);
        setResolution("1080p");
        setScalePercent(50);
        abortRef.current?.abort();
        abortRef.current = null;
    }, [open, initialTab, preferredUpscaler, videoUrl]);

    useEffect(() => {
        if (!open || tab !== "frame") return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void extractVideoFrameDataUrl(previewSrc || videoUrl, frameTime).then((dataUrl) => {
                if (!cancelled) setFramePreview(dataUrl);
            });
        }, 180);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [frameTime, open, previewSrc, tab, videoUrl]);

    const seekTo = (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        const next = Math.min(Math.max(0, time), Math.max(0, (duration || video.duration || 0) - 0.05));
        try {
            video.pause();
            video.currentTime = next;
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
        const video = videoRef.current;
        if (!video) return;
        const nextDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        setDuration(nextDuration);
        setRange([0, nextDuration || 1]);
        setFrameTime(Math.min(0.1, Math.max(0, nextDuration / 10)));
        setCurrentTime(video.currentTime || 0);
        if (video.videoWidth && video.videoHeight) {
            setSourceSize({ width: video.videoWidth, height: video.videoHeight });
        }
    };

    /** 「缩放」页签里显示的目标分辨率（按原尺寸百分比，偶数取整 —— h264 要求）。 */
    const scaleTarget = useMemo(() => {
        const even = (value: number) => {
            const rounded = Math.max(2, Math.round(value));
            return rounded % 2 === 0 ? rounded : rounded - 1;
        };
        if (!sourceSize.width || !sourceSize.height) return "";
        const ratio = scalePercent / 100;
        return `${even(sourceSize.width * ratio)} × ${even(sourceSize.height * ratio)}`;
    }, [scalePercent, sourceSize]);

    const runTrim = async () => {
        if (busy) return;
        const [start, end] = range;
        if (end - start < 0.05) {
            message.warning(t("canvas.videoTools.trimTooShort"));
            return;
        }
        setBusy(true);
        setProgress(0);
        try {
            const source = await loadVideoBlob(videoUrl, videoStorageKey);
            const blob = await trimVideoBlob(source, start, end, setProgress);
            await onTrim({ blob, startSec: start, endSec: end });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.videoTools.trimFailed"));
        } finally {
            setBusy(false);
            setProgress(0);
        }
    };

    const runScale = async () => {
        if (busy) return;
        setBusy(true);
        setProgress(0);
        try {
            const source = await loadVideoBlob(videoUrl, videoStorageKey);
            const result = await scaleVideoBlob(source, scalePercent, setProgress);
            await onScale(result);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.videoTools.scaleFailed"));
        } finally {
            setBusy(false);
            setProgress(0);
        }
    };

    const runFrame = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const dataUrl = framePreview || (await extractVideoFrameDataUrl(previewSrc || videoUrl, frameTime));
            if (!dataUrl) throw new Error(t("canvas.videoTools.frameFailed"));
            await onFrame({ dataUrl, timeSec: frameTime });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.videoTools.frameFailed"));
        } finally {
            setBusy(false);
        }
    };

    const runUpscale = async () => {
        if (busy) return;
        if (!upscaleModel) {
            onMissingConfig?.();
            message.warning(t("canvas.videoTools.upscaleModelRequired"));
            return;
        }
        setBusy(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            await onUpscale({ model: upscaleModel, resolution }, controller.signal);
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                message.error(error instanceof Error ? error.message : t("canvas.videoTools.upscaleFailed"));
            }
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(false);
        }
    };

    const cancelBusy = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setBusy(false);
    };

    return (
        <Modal
            title={null}
            open={open && Boolean(videoUrl)}
            onCancel={() => {
                if (busy) cancelBusy();
                onClose();
            }}
            footer={null}
            width={920}
            centered
            destroyOnHidden
        >
            <div className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.videoTools.title")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.videoTools.subtitle")}</p>
                </div>

                <div className="grid gap-5 md:grid-cols-[minmax(280px,1fr)_340px]">
                    <div className="space-y-3 rounded-xl border p-3">
                        <div className="overflow-hidden rounded-lg bg-black">
                            <video
                                ref={videoRef}
                                src={previewSrc}
                                className="max-h-[360px] w-full object-contain"
                                controls
                                playsInline
                                preload="metadata"
                                onLoadedMetadata={handleLoadedMetadata}
                                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                            />
                        </div>
                        <div className="flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("canvas.videoTools.currentTime")}</span>
                            <span className="font-semibold">{formatVideoClock(currentTime)} / {formatVideoClock(duration)}</span>
                        </div>
                        {tab === "frame" && framePreview ? (
                            <div className="rounded-lg border bg-black/5 p-2">
                                <img src={framePreview} alt="" className="mx-auto max-h-40 rounded object-contain" draggable={false} />
                            </div>
                        ) : null}
                    </div>

                    <div className="space-y-4">
                        <Tabs
                            activeKey={tab}
                            onChange={(key) => setTab(key as VideoToolsTab)}
                            items={[
                                {
                                    key: "trim",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Scissors className="size-3.5" />
                                            {t("canvas.videoTools.tabs.trim")}
                                        </span>
                                    ),
                                    children: (
                                        <div className="space-y-4 pt-1">
                                            <div className="space-y-2">
                                                <div className="text-sm font-medium opacity-75">{t("canvas.videoTools.trimRange")}</div>
                                                <Slider
                                                    range
                                                    min={0}
                                                    max={Math.max(duration, 0.1)}
                                                    step={0.1}
                                                    value={range}
                                                    disabled={!duration || busy}
                                                    onChange={(value) => {
                                                        updateTrimRange(value as [number, number]);
                                                    }}
                                                />
                                                <div className="grid grid-cols-2 gap-2">
                                                    <label className="space-y-1 text-xs opacity-70">
                                                        <span>{t("canvas.videoTools.start")}</span>
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
                                                        <span>{t("canvas.videoTools.end")}</span>
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
                                            </div>
                                            <div className="rounded-xl border px-3 py-2 text-sm">
                                                <div className="flex justify-between">
                                                    <span className="opacity-60">{t("canvas.videoTools.clipDuration")}</span>
                                                    <span className="font-semibold">{formatVideoClock(Math.max(0, range[1] - range[0]))}</span>
                                                </div>
                                                {busy && progress > 0 ? (
                                                    <div className="mt-1 flex justify-between">
                                                        <span className="opacity-60">{t("canvas.videoTools.progress")}</span>
                                                        <span className="font-semibold">{Math.round(progress * 100)}%</span>
                                                    </div>
                                                ) : null}
                                            </div>
                                            <Button type="primary" size="large" block icon={<Film className="size-4" />} loading={busy} disabled={!duration} onClick={() => void runTrim()}>
                                                {t("canvas.videoTools.trimAction")}
                                            </Button>
                                        </div>
                                    ),
                                },
                                {
                                    key: "frame",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <ImagePlus className="size-3.5" />
                                            {t("canvas.videoTools.tabs.frame")}
                                        </span>
                                    ),
                                    children: (
                                        <div className="space-y-4 pt-1">
                                            <div className="space-y-2">
                                                <div className="text-sm font-medium opacity-75">{t("canvas.videoTools.frameTime")}</div>
                                                <Slider
                                                    min={0}
                                                    max={Math.max(duration, 0.1)}
                                                    step={0.1}
                                                    value={frameTime}
                                                    disabled={!duration || busy}
                                                    onChange={(value) => {
                                                        const next = Number(value) || 0;
                                                        setFrameTime(next);
                                                        seekTo(next);
                                                    }}
                                                />
                                                <InputNumber
                                                    className="!w-full"
                                                    min={0}
                                                    max={Math.max(duration, 0)}
                                                    step={0.1}
                                                    value={Number(frameTime.toFixed(1))}
                                                    disabled={!duration || busy}
                                                    onChange={(value) => {
                                                        const next = Math.max(0, Number(value) || 0);
                                                        setFrameTime(next);
                                                        seekTo(next);
                                                    }}
                                                />
                                            </div>
                                            <Button type="primary" size="large" block icon={<ImagePlus className="size-4" />} loading={busy} disabled={!duration} onClick={() => void runFrame()}>
                                                {t("canvas.videoTools.frameAction")}
                                            </Button>
                                        </div>
                                    ),
                                },
                                {
                                    key: "upscale",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Sparkles className="size-3.5" />
                                            {t("canvas.videoTools.tabs.upscale")}
                                        </span>
                                    ),
                                    children: (
                                        <div className="space-y-4 pt-1">
                                            <div className="space-y-2">
                                                <div className="text-sm font-medium opacity-75">{t("canvas.videoTools.upscaleModel")}</div>
                                                <ModelPicker config={config} value={upscaleModel} onChange={setUpscaleModel} capability="video" fullWidth onMissingConfig={onMissingConfig} />
                                            </div>
                                            <div className="space-y-2">
                                                <div className="text-sm font-medium opacity-75">{t("canvas.videoTools.resolution")}</div>
                                                <Segmented
                                                    block
                                                    value={resolution}
                                                    options={VIDEO_UPSCALE_RESOLUTIONS.map((item) => ({ label: item.label, value: item.value }))}
                                                    onChange={(value) => setResolution(value as VideoUpscaleResolution)}
                                                    disabled={busy}
                                                />
                                            </div>
                                            <div className="rounded-xl border px-3 py-2 text-xs leading-5 opacity-70">{t("canvas.videoTools.upscaleHint")}</div>
                                            <div className="flex gap-2">
                                                {busy ? (
                                                    <Button size="large" block onClick={cancelBusy}>
                                                        {t("common.cancel")}
                                                    </Button>
                                                ) : null}
                                                <Button type="primary" size="large" block icon={<Clapperboard className="size-4" />} loading={busy} onClick={() => void runUpscale()}>
                                                    {t("canvas.videoTools.upscaleAction")}
                                                </Button>
                                            </div>
                                        </div>
                                    ),
                                },
                                {
                                    key: "scale",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Scaling className="size-3.5" />
                                            {t("canvas.videoTools.tabs.scale")}
                                        </span>
                                    ),
                                    children: (
                                        <div className="space-y-4 pt-1">
                                            <div className="space-y-2">
                                                <div className="text-sm font-medium opacity-75">{t("canvas.videoTools.scalePercent")}</div>
                                                <Segmented
                                                    block
                                                    value={scalePercent}
                                                    options={VIDEO_SCALE_PERCENTAGES.map((item) => ({ label: `${item}%`, value: item }))}
                                                    onChange={(value) => setScalePercent(value as VideoScalePercentage)}
                                                    disabled={busy}
                                                />
                                                <div className="flex justify-between text-xs opacity-70">
                                                    <span>{t("canvas.videoTools.scaleOutput")}</span>
                                                    <span className="font-semibold">
                                                        {scaleTarget || t("canvas.videoTools.scaleUnknownSize")}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="rounded-xl border px-3 py-2 text-sm">
                                                {busy && progress > 0 ? (
                                                    <div className="flex justify-between">
                                                        <span className="opacity-60">{t("canvas.videoTools.progress")}</span>
                                                        <span className="font-semibold">{Math.round(progress * 100)}%</span>
                                                    </div>
                                                ) : (
                                                    <span className="text-xs leading-5 opacity-70">{t("canvas.videoTools.scaleHint")}</span>
                                                )}
                                            </div>
                                            <Button type="primary" size="large" block icon={<Scaling className="size-4" />} loading={busy} onClick={() => void runScale()}>
                                                {t("canvas.videoTools.scaleAction")}
                                            </Button>
                                        </div>
                                    ),
                                },
                            ]}
                        />
                    </div>
                </div>
            </div>
        </Modal>
    );
}
