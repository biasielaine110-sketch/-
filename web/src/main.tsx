import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AccessGate } from "@/components/layout/access-gate";
import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { router } from "@/router";

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
