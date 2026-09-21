import { useCallback, useEffect, useState } from "react";

import { App } from "antd";
import { HardDrive, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getLocalMediaLibraryMeta, isLocalMediaLibraryPermissionLost, requestLocalMediaLibraryAccess } from "@/services/local-media-library";

/**
 * A bound local folder loses its `readwrite` permission when the browser restarts, which makes every
 * image and video stored there unreadable — the canvas then looks like it silently dropped the media.
 *
 * `requestPermission()` only works from a user gesture, so this cannot be fixed silently: surface the
 * state once per session and let the user restore access with one click.
 */
export function CanvasMediaLibraryNotice() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [folderName, setFolderName] = useState("");
    const [dismissed, setDismissed] = useState(false);
    const [granting, setGranting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [meta, permissionLost] = await Promise.all([getLocalMediaLibraryMeta(), isLocalMediaLibraryPermissionLost()]);
            if (cancelled) return;
            setFolderName(permissionLost && meta?.hasDirectory ? meta.folderName || "" : "");
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const handleGrant = useCallback(async () => {
        setGranting(true);
        try {
            const allowed = await requestLocalMediaLibraryAccess();
            if (!allowed) {
                void message.warning(t("config.mediaLibrary.noticeDenied"));
                return;
            }
            setFolderName("");
            void message.success(t("config.mediaLibrary.noticeGranted"));
        } finally {
            setGranting(false);
        }
    }, [message, t]);

    if (!folderName || dismissed) return null;

    return (
        <div className="pointer-events-auto absolute left-1/2 top-20 z-40 flex w-[min(560px,calc(100%-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border border-amber-300 bg-amber-50/95 px-3 py-2.5 text-amber-900 shadow-lg backdrop-blur dark:border-amber-500/40 dark:bg-amber-950/90 dark:text-amber-100">
            <HardDrive className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t("config.mediaLibrary.noticeTitle")}</div>
                <div className="mt-0.5 text-xs leading-relaxed opacity-90">{t("config.mediaLibrary.noticeDescription", { name: folderName })}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                <button
                    type="button"
                    disabled={granting}
                    onClick={() => void handleGrant()}
                    className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-60"
                >
                    {t("config.mediaLibrary.noticeGrant")}
                </button>
                <button type="button" title={t("config.mediaLibrary.noticeDismiss")} aria-label={t("config.mediaLibrary.noticeDismiss")} onClick={() => setDismissed(true)} className="rounded-md p-1 opacity-70 transition-opacity hover:opacity-100">
                    <X className="size-3.5" />
                </button>
            </div>
        </div>
    );
}
