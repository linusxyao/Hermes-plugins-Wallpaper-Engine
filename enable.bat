@echo off
chcp 65001 >nul
rem ============================================================
rem  Hermes Wallpaper Engine - RE-ENABLE
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

echo [..] 启用：把插件从暂存区搬回原位 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Enable
echo.
pause
