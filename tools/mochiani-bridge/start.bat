@echo off
setlocal
title MochiAni Canvas Bridge
cd /d "%~dp0"

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

echo [mochiani-bridge] 启动中，监听 http://127.0.0.1:17399
echo [mochiani-bridge] 保持这个窗口开着；关掉窗口 = 画布就用不了了。
echo.
"%NODE_EXE%" server.mjs

echo.
echo [mochiani-bridge] 已退出。
pause
