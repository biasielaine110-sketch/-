import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import {
    expiredAccessExpiry,
    formatAccessExpiry,
    grantAccess,
    isAccessGranted,
    isAccessPassword,
} from "@/lib/access-gate";

/**
 * 整站门禁：没过密码就只渲染这一屏，**画布与路由都不挂载**（数据 / 请求一个都不会发出去）。
 *
 * 三处细节容易漏：
 *  ① **免密 1 天**：判定只看 `localStorage` 里的到期时间戳，不靠「本次会话」——
 *    关掉标签页再打开仍然是免密的，到期才问；
 *  ② **页面开着也会过期**：光在挂载时判一次不够，标签页挂一整夜再点会一直放行 →
 *    定时器（60 秒）+ `visibilitychange` 各判一次，过期立刻退回锁屏；
 *  ③ **不要小眼睛**：`visibilityToggle={false}`（用户口径），输错就清空并重新聚焦。
 */
export function AccessGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [granted, setGranted] = useState(() => isAccessGranted());
    const [password, setPassword] = useState("");
    const [wrong, setWrong] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!granted) return;
        const check = () => {
            if (!isAccessGranted()) setGranted(false);
        };
        const timer = window.setInterval(check, 60_000);
        document.addEventListener("visibilitychange", check);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", check);
        };
    }, [granted]);

    useEffect(() => {
        if (!granted) inputRef.current?.focus();
    }, [granted]);

    // 已经放行：不再渲染任何门禁 UI，直接把整棵树交出去。
    if (granted) return <>{children}</>;

    const submit = (event?: FormEvent) => {
        event?.preventDefault();
        if (!password.trim()) return;
        if (isAccessPassword(password)) {
            grantAccess();
            setPassword("");
            setWrong(false);
            setGranted(true);
            return;
        }
        setWrong(true);
        setPassword("");
        inputRef.current?.focus();
    };

    const expiredAt = expiredAccessExpiry();

    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-stone-100 px-6 dark:bg-stone-950">
            <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-7 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                <div className="text-lg font-semibold text-stone-900 dark:text-stone-100">{t("accessGate.title")}</div>
                <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("accessGate.hint")}</div>
                <form className="mt-5" onSubmit={submit}>
                    <Input.Password
                        ref={inputRef as never}
                        size="large"
                        value={password}
                        status={wrong ? "error" : undefined}
                        placeholder={t("accessGate.placeholder")}
                        autoComplete="current-password"
                        visibilityToggle={false}
                        onChange={(event) => {
                            setPassword(event.target.value);
                            if (wrong) setWrong(false);
                        }}
                    />
                    {wrong ? <div className="mt-2 text-xs text-red-500">{t("accessGate.wrong")}</div> : null}
                    <Button type="primary" size="large" htmlType="submit" block className="mt-4" disabled={!password.trim()}>
                        {t("accessGate.submit")}
                    </Button>
                </form>
                <div className="mt-4 text-[11px] leading-4 text-stone-400 dark:text-stone-500">{t("accessGate.remember")}</div>
                {expiredAt > 0 ? (
                    <div className="mt-1 text-[11px] leading-4 text-stone-400 dark:text-stone-500">
                        {t("accessGate.expiredAt", { expiry: formatAccessExpiry(expiredAt) })}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
