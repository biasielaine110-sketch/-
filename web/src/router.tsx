import { Suspense, lazy, type ComponentType } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";

/**
 * 二级页面全部按需加载。
 *
 * 画布（`/canvas`、`/canvas/:id`）是主战场，必须**同步**留在首包：拆成异步只会多一次往返。
 * 其余页面（首页 / 素材 / 导演 / 配置 / 404）只在真的切过去时才下载 —— 尤其是「配置」页
 * 静态引了 CodeMirror（编辑器 + JS 语言包），以前它一直躺在首包里，空画布打开也得陪着下。
 */
const AssetsPage = lazy(() => import("@/pages/assets"));
const ConfigPage = lazy(() => import("@/pages/config"));
const DirectorPage = lazy(() => import("@/pages/director"));
const HomePage = lazy(() => import("@/pages/home"));
const NotFound = lazy(() => import("@/pages/not-found"));

/** 懒加载页面的兜底：留一片和画布同色的空场，别闪白屏。 */
function lazyPage(Page: ComponentType) {
    return (
        <Suspense fallback={<div className="h-full min-h-0 w-full bg-background" aria-hidden />}>
            <Page />
        </Suspense>
    );
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: lazyPage(HomePage) },
            { path: "/assets", element: lazyPage(AssetsPage) },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/director", element: lazyPage(DirectorPage) },
            { path: "/config", element: lazyPage(ConfigPage) },
        ],
    },
    { path: "*", element: lazyPage(NotFound) },
]);
