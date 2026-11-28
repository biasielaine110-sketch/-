import { useCallback, useEffect, useState } from "react";

import { App } from "antd";
import { Cable, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { localNetworkIsRelayed, primeLocalNetworkAccess, requestLocalNetworkAccess, subscribeLocalNetworkAccess } from "@/lib/local-network-access";

const DISMISS_KEY = "canvas-local-network-notice-dismissed";

/**
 * 公网页面直连本机被 Chrome 拦下时的提示。
 *
 * 为什么需要它（2026-11-26 实测）：LNA 没授权时，成片只能绕公网中继 ——
 * 同一份 1,852,855 B 的文件 loopback 0.035 s、公网中继 3.9–8.1 s。慢的不是网络，
 * 是「浏览器不让直连」，而用户完全没有可点的入口：`primeLocalNetworkAccess()` 在启动时
 * 没有用户激活，Chrome 通常不弹气泡。所以这里给一个按钮，在 click 手势里重新触发授权。
 *
 * 只在真的被降级时出现（`localNetworkIsRelayed()`：prompt / denied），
 * granted / unsupported 一律不打扰。关掉后本会话不再弹（sessionStorage）。
 */
export function CanvasLocalNetworkNotice() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [relayed, setRelayed] = useState(() => localNetworkIsRelayed());
    const [dismissed, setDismissed] = useState(() => {
        try {
            return sessionStorage.getItem(DISMISS_KEY) === "1";
        } catch {
            return false;
        }
    });
    const [checking, setChecking] = useState(false);

    useEffect(() => subscribeLocalNetworkAccess(() => setRelayed(localNetworkIsRelayed())), []);

    useEffect(() => {
        void primeLocalNetworkAccess().then(() => setRelayed(localNetworkIsRelayed()));
    }, []);

    const handleRequest = useCallback(async () => {
        setChecking(true);
        try {
            const next = await requestLocalNetworkAccess();
            if (next === "granted") {
                setRelayed(false);
                message.success({
                    content: (
                        <span className="flex items-center gap-2">
                            {t("canvas.localNetworkGrantedReload")}
                            <button
                                type="button"
                                onClick={() => window.location.reload()}
                                className="rounded-md bg-emerald-500 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
                            >
                                {t("canvas.localNetworkReload")}
                            </button>
                        </span>
                    ),
                    duration: 30,
                });
                return;
            }
            setRelayed(localNetworkIsRelayed());
            message.warning({ content: t("canvas.localNetworkStillBlocked"), duration: 15 });
        } finally {
            setChecking(false);
        }
    }, [message, t]);

    const handleDismiss = useCallback(() => {
        setDismissed(true);
        try {
            sessionStorage.setItem(DISMISS_KEY, "1");
        } catch {
            // 隐私模式禁用 sessionStorage：本会话忽略即可
        }
    }, []);

    if (!relayed || dismissed) return null;

    return (
        <div className="pointer-events-auto absolute left-1/2 top-20 z-40 flex w-[min(620px,calc(100%-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border border-amber-300 bg-amber-50/95 px-3 py-2.5 text-amber-900 shadow-lg backdrop-blur dark:border-amber-500/40 dark:bg-amber-950/90 dark:text-amber-100">
            <Cable className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t("canvas.localNetworkTitle")}</div>
                <div className="mt-0.5 text-xs leading-relaxed opacity-90">{t("canvas.localNetworkDescription")}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                <button
                    type="button"
                    disabled={checking}
                    onClick={() => void handleRequest()}
                    className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-60"
                >
                    {checking ? t("canvas.localNetworkGranting") : t("canvas.localNetworkGrant")}
                </button>
                <button type="button" title={t("canvas.localNetworkDismiss")} aria-label={t("canvas.localNetworkDismiss")} onClick={handleDismiss} className="rounded-md p-1 opacity-70 transition-opacity hover:opacity-100">
                    <X className="size-3.5" />
                </button>
            </div>
        </div>
    );
}
