@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: ================= 配置区 =================
:: 1. 输入视频的根目录 (基于当前 vtt 目录寻找)
set "SRC_DIR=..\SpongeBob SquarePants"

:: 2. 字幕集中输出的目标目录 (当前 vtt 目录)
set "OUT_DIR=."

:: 3. ffmpeg 执行文件路径 (🌟 修复：绝对不能有单引号！)
set "FFMPEG=C:\Program Files\ffmpeg-8.1.1-essentials_build\bin\ffmpeg.exe"
:: ==========================================

:: 确保输出目录存在
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

echo [INFO] 准备从 %SRC_DIR% 提取字幕...
echo [INFO] 目标目录: %OUT_DIR%
echo.

:: 🌟 核心逻辑：/r 参数表示递归子目录
for /r "%SRC_DIR%" %%F in (*.mkv) do (
    set "filename=%%~nF"
    echo [正在处理] %%~nxF
    
    :: 执行 ffmpeg 提取字幕
    "%FFMPEG%" -y -i "%%F" -map 0:s:0 "%OUT_DIR%\!filename!.vtt" >nul 2>&1
    
    if errorlevel 1 (
        echo [跳过] %%~nF ^(可能不包含内嵌字幕流^)
    ) else (
        echo [成功] 已导出: !filename!.vtt
    )
)

echo.
echo ==========================================
echo [完成] 所有字幕已提取至 %OUT_DIR%
echo ==========================================
pause