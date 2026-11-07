import { useSyncExternalStore } from "react";
import { Button } from "antd";
import { Square, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getH3OptimizeQueueState, stopH3OptimizeQueue, subscribeH3OptimizeQueue } from "@/lib/canvas/h3-optimize-runner";

/**
 * h3 提示词优化的**后台进度卡**（右下角浮层，只在队列跑着的时候出现）。
 *
 * 队列本体在 `lib/canvas/h3-optimize-runner.ts`，不依赖任何组件 —— 所以弹窗关掉、
 * 甚至点在别的节点上，这一批照样往下跑；这里只是给用户一个「还剩多少 / 当前是谁 / 能停」的入口。
 *
 * 类名 `canvas-h3-optimize-progress` 已进 `isOverlayEventTarget()` 白名单，
 * 否则点「停止」会先被画布吞掉（当成取消选中 / 开始框选）。
 */
export function CanvasH3OptimizeProgress() {
    const { t } = useTranslation();
    const state = useSyncExternalStore(subscribeH3OptimizeQueue, getH3OptimizeQueueState);
    if (!state.running) return null;
    return (
        <div
            className="canvas-h3-optimize-progress pointer-events-auto fixed bottom-6 right-6 z-[4200] flex max-w-[92vw] items-center gap-2 rounded-full border border-stone-200 bg-white/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur sm:max-w-[420px] dark:border-stone-700 dark:bg-stone-900/95"
            data-canvas-shortcuts-ignore
            data-canvas-no-zoom
        >
            <WandSparkles className="size-3.5 shrink-0 animate-pulse text-amber-500" />
            <span className="shrink-0 font-medium tabular-nums">{t("canvas.h3Optimize.progress", { done: state.done, total: state.total })}</span>
            <span className="min-w-0 flex-1 truncate opacity-60" title={state.currentTitle}>
                {state.currentTitle}
            </span>
            <Button size="small" type="text" className="!h-6 shrink-0 !px-1.5" icon={<Square className="size-2.5" />} onClick={stopH3OptimizeQueue}>
                {t("canvas.h3Optimize.stop")}
            </Button>
        </div>
    );
}
