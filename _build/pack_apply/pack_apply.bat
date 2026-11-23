@echo off
chcp 65001 >nul
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%pack_apply.ps1"

if not exist "%PS1%" (
    echo [ERROR] 找不到 %PS1%
    pause
    exit /b 1
)

rem 支持双击打开窗口，或直接把仓库文件/文件夹/AI 返回的 .zip 拖到本图标上
if "%~1"=="" (
    powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
) else (
    powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -DropPaths %*
)
