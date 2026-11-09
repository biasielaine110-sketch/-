@echo off
setlocal
title Mochiani Canvas Bridge (remote / 常开)
cd /d "%~dp0"

REM 远程模式：桥仍然只监听 127.0.0.1，公网入口由 Tailscale Funnel 反代进来。
REM 令牌从本目录的 remote.env 读（该文件已被 .gitignore 排除，别提交）。

if not exist "%~dp0remote.env" (
    echo [ERROR] 缺 remote.env —— 把 remote.env.example 复制成 remote.env 再填令牌。
    pause
    exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0remote.env") do set "%%a=%%b"

if not defined MOCHIANI_BRIDGE_TOKEN (
    echo [ERROR] remote.env 里没写 MOCHIANI_BRIDGE_TOKEN。
    pause
    exit /b 1
)
if not defined MOCHIANI_BRIDGE_PORT set "MOCHIANI_BRIDGE_PORT=17399"

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [ERROR] 没找到 Node.js。装一个 LTS 版再跑。
    pause
    exit /b 1
)

echo [mochiani-bridge] 远程模式：监听 127.0.0.1:%MOCHIANI_BRIDGE_PORT%，所有 /api/* 都要令牌
echo [mochiani-bridge] 别的电脑在画布节点里填这一行：
echo     https://wb2api.tailb5bc86.ts.net:8443/?token=%MOCHIANI_BRIDGE_TOKEN%
echo.
echo [mochiani-bridge] 这个窗口要一直开着；浏览器里也要一直开着登录状态的 MochiAni 画布。
echo.
"%NODE_EXE%" server.mjs

echo.
echo [mochiani-bridge] 已退出。
pause
