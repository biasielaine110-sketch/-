import { Input, Modal } from "antd";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { ACCESS_GATE_PASSWORD } from "@/lib/access-gate";
import { markGateUnlocked } from "@/lib/gate-unlock";

/**
 * 口令弹窗**单独一个模块**。
 *
 * 它原来和 `AppConfigModal` 住在同一个 1400 行文件里，而画布的「提示词库」面板要静态引它 →
 * 整个配置面板（含 CodeMirror、渠道编辑、技能/Agent/备份 tab）就被拽进首包，
 * 空画布打开也得陪着一起下载解析。拆出来以后画布只带这个十几行的小弹窗。
 */
export function ConfigPasswordModal({
    open,
    onCancel,
    onUnlock,
    title,
    hint,
    gateId,
}: {
    open: boolean;
    onCancel: () => void;
    onUnlock: () => void;
    title?: string;
    hint?: string;
    /** 传了就记住这次通过：7 天内同一道门不再询问（见 lib/gate-unlock）。 */
    gateId?: string;
}) {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");
    const [wrong, setWrong] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) {
            setPassword("");
            setWrong(false);
            return;
        }
        const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
        return () => window.clearTimeout(timer);
    }, [open]);

    const submit = () => {
        if (password === ACCESS_GATE_PASSWORD) {
            setWrong(false);
            // 记住这次通过，7 天内同一道门不再弹密码（只记时间戳，不记密码）。
            if (gateId) markGateUnlocked(gateId);
            onUnlock();
            return;
        }
        setWrong(true);
        setPassword("");
        inputRef.current?.focus();
    };

    const onFormSubmit = (event: FormEvent) => {
        event.preventDefault();
        submit();
    };

    return (
        <Modal title={title || t("config.passwordTitle")} open={open} centered destroyOnHidden onCancel={onCancel} okText={t("config.passwordConfirm")} cancelText={t("common.cancel")} onOk={submit}>
            <form className="space-y-2 pt-1" onSubmit={onFormSubmit}>
                <div className="text-xs text-stone-500">{hint || t("config.passwordHint")}</div>
                <Input.Password
                    ref={inputRef as never}
                    value={password}
                    status={wrong ? "error" : undefined}
                    placeholder={t("config.passwordPlaceholder")}
                    autoComplete="current-password"
                    visibilityToggle={false}
                    onChange={(event) => {
                        setPassword(event.target.value);
                        if (wrong) setWrong(false);
                    }}
                    onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            submit();
                        }
                    }}
                />
                {wrong ? <div className="text-xs text-red-500">{t("config.passwordWrong")}</div> : null}
                {gateId ? <div className="text-xs text-stone-400 dark:text-stone-500">{t("config.passwordRemember")}</div> : null}
            </form>
        </Modal>
    );
}
