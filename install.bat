@echo off
chcp 65001 >nul
rem ============================================================
rem  Hermes Wallpaper Engine - INSTALL / UPGRADE
rem  Just double-click. Needs the built-in Windows PowerShell.
rem  If blocked as "downloaded from the Internet": right-click
rem  the file -> Properties -> Unblock.
rem ============================================================
cd /d "%~dp0"
where powershell >nul 2>nul
if errorlevel 1 (
    echo [X] PowerShell not found.
    pause
    exit /b 1
)

echo [..] 正在安装：定位 Hermes 目录 - 下载/拷贝 - 部署两个半区 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
