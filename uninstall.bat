@echo off
chcp 65001 >nul
rem ============================================================
rem  Hermes Wallpaper Engine - UNINSTALL
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

echo 即将删除插件目录（含你上传过的壁纸 uploads 与缓存）。
choice /c YN /m 确认卸载?
if errorlevel 2 (
    echo 已取消。
    pause
    exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
echo.
pause
