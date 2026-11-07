import { useEffect, useState } from "react";
import { Button, Input, Modal } from "antd";
import { AlertTriangle, Check, FolderOpen, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    JIANYING_DRAFT_ROOT_HINT,
    joinDraftPath,
    loadJianyingRootPath,
    looksLikeAbsoluteDraftRoot,
    pickJianyingDraftRoot,
    saveJianyingRootPath,
} from "@/lib/canvas/jianying-direct";

/**
 * 「导出到剪映」的直写设置弹窗。
 *
 * 只干一件事：**问一次**草稿目录是哪儿，然后把这个结果交给上层去落盘。
 *  - 文件夹靠 `showDirectoryPicker` 授权（浏览器只给句柄，拿不到路径）；
 *  - 路径靠用户粘一次（剪映里能看到，我们猜不出用户名）。
 *
 * 两个都拿到后存起来（句柄进 IndexedDB、路径进 localStorage），下次导出不再弹这个框。
 * 想回到「下载 zip + install.bat」老路时，底部还留了「还是下载压缩包」。
 */
export type CanvasJianyingExportDialogProps = {
    open: boolean;
    /** 这次要写的草稿名（= 合并节点标题），用于显示与文件夹命名。 */
    draftName: string;
    clipCount: number;
    totalSeconds: number;
    /** 正在写盘（禁用按钮 + loading）。 */
    submitting: boolean;
    onCancel: () => void;
    /** 退回「打包下载 zip」。 */
    onUsePackage: () => void;
    onSubmit: (target: { handle: FileSystemDirectoryHandle; rootPath: string }) => void;
};

export function CanvasJianyingExportDialog({ open, draftName, clipCount, totalSeconds, submitting, onCancel, onUsePackage, onSubmit }: CanvasJianyingExportDialogProps) {
    const { t } = useTranslation();
    const [rootPath, setRootPath] = useState("");
    const [picked, setPicked] = useState<FileSystemDirectoryHandle | null>(null);
    const [picking, setPicking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 每次打开都重新读一遍：用户可能刚在别处改过路径 / 授权已被浏览器清掉。
    useEffect(() => {
        if (!open) return;
        setRootPath(loadJianyingRootPath());
        setPicked(null);
        setError(null);
    }, [open]);

    const pickFolder = async () => {
        setPicking(true);
        setError(null);
        try {
            const handle = await pickJianyingDraftRoot();
            if (!handle) return;
            setPicked(handle);
            // 选了 `com.lveditor.draft` 就顺手把路径框里缺的尾段补上 —— 用户常常是「选了目录但没粘路径」，
            // 这时我们仍然不知道盘符，只能提示；补全只针对「已经粘了一半」的情况（结尾不是 com.lveditor.draft）。
            if (handle.name === "com.lveditor.draft" && rootPath.trim() && !/com\.lveditor\.draft[\\/]?$/i.test(rootPath.trim())) {
                setRootPath((current) => joinDraftPath(current, "com.lveditor.draft"));
            }
        } catch (pickError) {
            setError(pickError instanceof Error && pickError.message === "unsupported-file-system-access" ? t("canvas.videoMerge.exportUnsupported") : t("canvas.videoMerge.exportPickFailed"));
        } finally {
            setPicking(false);
        }
    };

    const submit = () => {
        const trimmed = rootPath.trim().replace(/[\\/]+$/, "");
        if (!looksLikeAbsoluteDraftRoot(trimmed)) {
            setError(t("canvas.videoMerge.exportRootPathInvalid"));
            return;
        }
        if (!picked) {
            setError(t("canvas.videoMerge.exportPickFolderNeed"));
            return;
        }
        saveJianyingRootPath(trimmed);
        onSubmit({ handle: picked, rootPath: trimmed });
    };

    return (
        <Modal open={open} onCancel={onCancel} title={t("canvas.videoMerge.exportDialogTitle")} footer={null} width={560} destroyOnHidden maskClosable={!submitting}>
            <div className="space-y-3 pt-1 text-[12px] leading-relaxed">
                <p className="opacity-70">{t("canvas.videoMerge.exportDialogIntro")}</p>

                <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--canvas-node-stroke, #d6d3ca)" }}>
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium">{t("canvas.videoMerge.exportRootPathLabel")}</span>
                        <span className="text-[11px] opacity-45">
                            {t("canvas.videoMerge.exportTimelineSummary", { clips: clipCount, seconds: Math.round(totalSeconds) })}
                        </span>
                    </div>
                    <Input
                        value={rootPath}
                        onChange={(event) => {
                            setRootPath(event.target.value);
                            setError(null);
                        }}
                        onPressEnter={submit}
                        disabled={submitting}
                        placeholder={JIANYING_DRAFT_ROOT_HINT}
                        spellCheck={false}
                    />
                    <div className="mt-1.5 text-[11px] opacity-55">{t("canvas.videoMerge.exportRootPathHint", { hint: JIANYING_DRAFT_ROOT_HINT })}</div>
                </div>

                <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--canvas-node-stroke, #d6d3ca)" }}>
                    <div className="font-medium">{t("canvas.videoMerge.exportPickFolderLabel")}</div>
                    <div className="mt-1.5 flex items-center gap-2">
                        <Button size="small" disabled={submitting || picking} icon={picking ? <LoaderCircle className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />} onClick={pickFolder}>
                            {t("canvas.videoMerge.exportPickFolder")}
                        </Button>
                        {picked ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                                <Check className="size-3.5" />
                                {t("canvas.videoMerge.exportPickFolderDone", { name: picked.name })}
                            </span>
                        ) : (
                            <span className="text-[11px] opacity-45">{t("canvas.videoMerge.exportPickFolderNone")}</span>
                        )}
                    </div>
                    <div className="mt-1.5 text-[11px] opacity-55">{t("canvas.videoMerge.exportPickFolderHint")}</div>
                    {picked && picked.name !== "com.lveditor.draft" ? (
                        <div className="mt-1.5 flex items-start gap-1 text-[11px] text-amber-600">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                            {t("canvas.videoMerge.exportFolderMismatch")}
                        </div>
                    ) : null}
                </div>

                {error ? <div className="text-[12px] text-red-500">{error}</div> : null}

                <div className="text-[11px] opacity-45">{t("canvas.videoMerge.exportOverwriteHint", { name: draftName })}</div>

                <div className="flex items-center justify-between gap-2 pt-1">
                    <Button type="text" size="small" disabled={submitting} onClick={onUsePackage}>
                        {t("canvas.videoMerge.exportUsePackage")}
                    </Button>
                    <div className="flex items-center gap-2">
                        <Button size="small" disabled={submitting} onClick={onCancel}>
                            {t("common.cancel")}
                        </Button>
                        <Button size="small" type="primary" loading={submitting} onClick={submit}>
                            {submitting ? t("canvas.videoMerge.exportWriting") : t("canvas.videoMerge.exportWrite")}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
