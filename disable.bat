@echo off
chcp 65001 >nul
rem ============================================================
rem  Hermes Wallpaper Engine - DISABLE (data kept)
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

echo [..] 禁用：把插件搬进 disabled-plugins 暂存区（上传壁纸等数据原样保留）...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Disable
echo.
echo 想恢复：再双击 enable.bat 即可。
echo 注：这是"文件级"禁用；Hermes 设置里的插件开关与此独立、也能达到同样效果。
pause
