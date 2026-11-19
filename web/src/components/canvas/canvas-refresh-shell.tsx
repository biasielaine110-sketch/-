import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** 正常情况骨架屏只闪一下；超过这两个时间还没进画布，就必须给用户信息与出口。 */
const SLOW_HINT_DELAY_MS = 4_000;
const STUCK_HINT_DELAY_MS = 15_000;

export function CanvasRefreshShell() {
    const { t } = useTranslation();
    const [stage, setStage] = useState<"silent" | "slow" | "stuck">("silent");

    useEffect(() => {
        const slow = window.setTimeout(() => setStage("slow"), SLOW_HINT_DELAY_MS);
        const stuck = window.setTimeout(() => setStage("stuck"), STUCK_HINT_DELAY_MS);
        return () => {
            window.clearTimeout(slow);
            window.clearTimeout(stuck);
        };
    }, []);

    return (
        <main className="relative h-full min-h-0 overflow-hidden bg-background text-foreground">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                    backgroundSize: "28px 28px",
                }}
            />

            {/* 之前这里是一整块没有任何文字的骨架：一旦项目恢复卡住，用户看到的就是「整块画布全灰、什么都没有」，
                无从判断是加载慢还是坏了。4 秒后给状态，15 秒后给出口。 */}
            {stage !== "silent" ? (
                <div
                    className="absolute left-1/2 top-1/2 z-50 flex w-[420px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 rounded-xl border px-5 py-4 text-center text-xs shadow-lg"
                    style={{ background: "var(--background)", borderColor: "var(--border)" }}
                >
                    <span className="opacity-70">{stage === "slow" ? t("canvas.refreshShell.loading") : t("canvas.refreshShell.stuck")}</span>
                    {stage === "stuck" ? (
                        <button
                            type="button"
                            className="rounded-md border px-3 py-1 text-xs font-semibold transition hover:opacity-80"
                            style={{ borderColor: "var(--border)" }}
                            onClick={() => window.location.reload()}
                        >
                            {t("canvas.refreshShell.reload")}
                        </button>
                    ) : null}
                </div>
            ) : null}

            <div className="absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-24 left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-5 left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}
