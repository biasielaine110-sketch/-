import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AccessGate } from "@/components/layout/access-gate";
import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { primeLocalNetworkAccess } from "@/lib/local-network-access";
import { router } from "@/router";

// Chrome 142+ 的本地网络授权：启动时预热一次。
// `prompt` 状态下会主动打一条 loopback 请求，把「允许访问本地网络」的气泡顶出来 ——
// 否则请求会静默挂起，画布上就是「一直读秒」（见 lib/local-network-access.ts）。
void primeLocalNetworkAccess();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            {/* 整站门禁：没过密码连 router 都不挂载（1 天免密，见 lib/access-gate.ts）。 */}
            <AccessGate>
                <RouterProvider router={router} />
            </AccessGate>
        </AppProviders>
    </React.StrictMode>,
);
