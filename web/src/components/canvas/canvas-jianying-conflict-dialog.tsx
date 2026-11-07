import { useEffect, useState } from "react";
import { Button, Input, Modal } from "antd";
import { AlertTriangle, LoaderCircle, PencilLine, Replace } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * 「导出到剪映」时草稿**重名**的询问框。
 *
 * 背景：草稿文件夹名现在是 `节点名_MMDD`（例：`约会_1107`），同一天导同一个节点必然同名。
 * 直写路径会先 `removeEntry(recursive)` 再重建 → 默认行为就是**覆盖**，而用户在剪映里
 * 手改过的内容会一起没了。所以这里把选择权交回去：覆盖，还是换个名字导出一份新的。
 *
 * 两种选择都直接落到 `com.lveditor.draft`：
 *  - 覆盖 → 清掉旧文件夹重写（原来的行为）；
 *  - 换名 → 用新名字建一份，旧的那份原样留着。
 *
 * 这个框**只负责问**：校验（这个名字是不是又被占了）由上层拿真实目录句柄来做，
 * 校验失败会把错误文案回传到这里显示，然后用户接着改 —— 不关框。
 */
export type CanvasJianyingConflictDialogProps = {
    open: boolean;
    /** 撞车的那个文件夹名（`节点名_MMDD`）。 */
    folderName: string;
    /** 草稿在剪映里显示的名字（= 节点标题），用在说明文案里。 */
    draftName: string;
    /** 预填的替代名（上层已经确认它没被占用）。 */
    suggestedName: string;
    /** 正在写盘。 */
    submitting: boolean;
    onCancel: () => void;
    /** 用原来的名字覆盖。 */
    onOverwrite: () => void;
    /** 换名字导出：返回 `null` = 已开始写；返回字符串 = 校验失败的提示文案。 */
    onRename: (nextName: string) => Promise<string | null>;
};

export function CanvasJianyingConflictDialog({ open, folderName, draftName, suggestedName, submitting, onCancel, onOverwrite, onRename }: CanvasJianyingConflictDialogProps) {
    const { t } = useTranslation();
    const [value, setValue] = useState("");
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 每次打开（或上层重新算了个建议名）都重置输入框与错误。
    useEffect(() => {
        if (!open) return;
        setValue(suggestedName || `${folderName}-2`);
        setError(null);
        setChecking(false);
    }, [open, suggestedName, folderName]);

    const busy = submitting || checking;

    const submitRename = async () => {
        const next = value.trim();
        if (!next) {
            setError(t("canvas.videoMerge.exportNameRequired"));
            return;
        }
        if (next === folderName) {
            // 名字没改就别绕这一圈了 —— 想覆盖的按钮就在上面
            setError(t("canvas.videoMerge.exportNameUnchanged"));
            return;
        }
        setChecking(true);
        setError(null);
        try {
            const failure = await onRename(next);
            if (failure) setError(failure);
        } finally {
            setChecking(false);
        }
    };

    return (
        <Modal open={open} onCancel={onCancel} title={t("canvas.videoMerge.exportConflictTitle")} footer={null} width={540} destroyOnHidden maskClosable={!busy} closable={!busy}>
            <div className="space-y-3 pt-1 text-[12px] leading-relaxed">
                <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <div>
                        {t("canvas.videoMerge.exportConflictIntro", { folder: folderName })}
                        <div className="mt-0.5 opacity-70">{t("canvas.videoMerge.exportConflictHint", { name: draftName })}</div>
                    </div>
                </div>

                {/* ① 覆盖 */}
                <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--canvas-node-stroke, #d6d3ca)" }}>
                    <div className="font-medium">{t("canvas.videoMerge.exportConflictOverwriteTitle")}</div>
                    <div className="mt-0.5 text-[11px] opacity-55">{t("canvas.videoMerge.exportConflictOverwriteHint", { folder: folderName })}</div>
                    <div className="mt-2">
                        <Button size="small" danger disabled={busy} icon={<Replace className="size-3.5" />} onClick={onOverwrite}>
                            {t("canvas.videoMerge.exportConflictOverwrite")}
                        </Button>
                    </div>
                </div>

                {/* ② 换个名字 */}
                <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--canvas-node-stroke, #d6d3ca)" }}>
                    <div className="font-medium">{t("canvas.videoMerge.exportConflictRenameTitle")}</div>
                    <div className="mt-0.5 text-[11px] opacity-55">{t("canvas.videoMerge.exportConflictRenameHint")}</div>
                    <div className="mt-2 flex items-center gap-2">
                        <Input
                            value={value}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setError(null);
                            }}
                            onPressEnter={() => void submitRename()}
                            disabled={busy}
                            spellCheck={false}
                            placeholder={t("canvas.videoMerge.exportConflictRenamePlaceholder")}
                        />
                        <Button size="small" type="primary" loading={checking || submitting} disabled={busy} icon={<PencilLine className="size-3.5" />} onClick={() => void submitRename()}>
                            {t("canvas.videoMerge.exportConflictRenameAction")}
                        </Button>
                    </div>
                </div>

                {error ? <div className="text-[12px] text-red-500">{error}</div> : null}

                <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="inline-flex items-center gap-1 text-[11px] opacity-45">
                        {busy ? (
                            <>
                                <LoaderCircle className="size-3 animate-spin" />
                                {t("canvas.videoMerge.exportWriting")}
                            </>
                        ) : null}
                    </span>
                    <Button size="small" disabled={busy} onClick={onCancel}>
                        {t("common.cancel")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
