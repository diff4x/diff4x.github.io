@echo off
chcp 65001 >nul
setlocal
:: swamp.exe 与 Wasm 一体化构建脚本（先清空继承令牌防止泄漏给 cargo）
set "_SWAMP_HANDOFF_TOKEN=%SWAMP_HANDOFF_TOKEN%"
set "SWAMP_HANDOFF_TOKEN="

for %%I in ("%~dp0.") do set "CRATE_DIR=%%~fI"
for %%I in ("%CRATE_DIR%\..") do set "BUILD_DIR=%%~fI"
for %%I in ("%BUILD_DIR%\..") do set "REPO_DIR=%%~fI"
if defined LOCALAPPDATA (
    set "TARGET_DIR=%LOCALAPPDATA%\swamp-cargo-target"
) else (
    set "TARGET_DIR=%TEMP%\swamp-cargo-target"
)
set "WASM_OUT_DIR=%REPO_DIR%\src\wasm"
cd /d "%CRATE_DIR%" >nul 2>&1

if /i "%~1"=="exe"  goto build_exe_only
if /i "%~1"=="wasm" goto build_wasm_only
if /i "%~1"=="all"  goto build_all

:menu
cls
echo =====================================================
echo   Swamp 构建脚本 (_build\swamp-server)
echo =====================================================
echo   [1] 编译 swamp.exe
echo   [2] 编译 Wasm (src\wasm)
echo   [3] 全部编译
echo   [0] 退出
echo =====================================================
choice /c 1230 /n /m "请选择 [0-3]: "
if errorlevel 4 goto :eof
if errorlevel 3 goto build_all
if errorlevel 2 goto build_wasm_only
if errorlevel 1 goto build_exe_only

:build_exe_only
call :do_build_exe
if errorlevel 1 (
    pause
    exit /b 1
)
call :launch_swamp_exe
call :wait_and_exit
exit /b 0

:build_wasm_only
call :do_build_wasm
if errorlevel 1 (
    pause
    exit /b 1
)
call :wait_and_exit
exit /b 0

:build_all
call :do_build_exe
if errorlevel 1 (
    pause
    exit /b 1
)
call :do_build_wasm
if errorlevel 1 (
    pause
    exit /b 1
)
call :launch_swamp_exe
call :wait_and_exit
exit /b 0


:: --- 启动新版 swamp.exe 并交接会话令牌 ---
:launch_swamp_exe
echo.
echo [exe] 正在启动 _build\swamp.exe
setlocal
if defined _SWAMP_HANDOFF_TOKEN set "SWAMP_HANDOFF_TOKEN=%_SWAMP_HANDOFF_TOKEN%"
set "_SWAMP_HANDOFF_TOKEN="
start "" /D "%BUILD_DIR%" "%BUILD_DIR%\swamp.exe"
endlocal
exit /b 0

:wait_and_exit
echo [done] 完成，3 秒后退出
timeout /t 3 /nobreak >nul 2>&1 || ping -n 4 127.0.0.1 >nul
exit /b 0


:: --- 子过程：编译 _build\swamp.exe ---
:do_build_exe
echo.
echo [exe] 检查 swamp.exe 运行状态
set "WAIT_TRY=0"
:wait_swamp_exit
tasklist /FI "IMAGENAME eq swamp.exe" 2>nul | find /I "swamp.exe" >nul
if errorlevel 1 goto swamp_exited
set /a WAIT_TRY+=1
if %WAIT_TRY% GTR 6 (
    echo [warn] swamp.exe 仍在运行，请先关闭管理窗口再编译
    exit /b 1
)
if %WAIT_TRY%==1 echo [exe] 等待 swamp.exe 退出...
timeout /t 1 /nobreak >nul
goto wait_swamp_exit
:swamp_exited

:: 兼容迁移旧路径 cilin.txt 至 assets\cilin.txt
if not exist "%CRATE_DIR%\assets\cilin.txt" (
    if exist "%BUILD_DIR%\rust\swamp-server\assets\cilin.txt" (
        if not exist "%CRATE_DIR%\assets" mkdir "%CRATE_DIR%\assets"
        copy /y "%BUILD_DIR%\rust\swamp-server\assets\cilin.txt" "%CRATE_DIR%\assets\cilin.txt" >nul
        echo [info] 已复制旧路径 cilin.txt 到 assets\cilin.txt
    ) else if exist "%BUILD_DIR%\synonyms\cilin.txt" (
        if not exist "%CRATE_DIR%\assets" mkdir "%CRATE_DIR%\assets"
        copy /y "%BUILD_DIR%\synonyms\cilin.txt" "%CRATE_DIR%\assets\cilin.txt" >nul
        echo [info] 已复制旧路径 cilin.txt 到 assets\cilin.txt
    )
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
set "CARGO_TARGET_DIR=%TARGET_DIR%"
set "RUSTFLAGS="

echo [exe] 编译 swamp.exe (cargo build --profile release-exe --bin swamp)
pushd "%CRATE_DIR%"
call :run_cargo_build
if errorlevel 1 (
    popd
    echo [error] swamp.exe 编译失败
    exit /b 1
)
popd

call :run_selftest
if errorlevel 1 (
    echo [error] 自检未通过，已停止替换（保留原有 _build\swamp.exe）
    exit /b 1
)

call :copy_with_retry "%TARGET_DIR%\release-exe\swamp.exe" "%BUILD_DIR%\swamp.exe"
if errorlevel 1 (
    echo [error] 复制到 _build\swamp.exe 失败
    exit /b 1
)

echo [ok] 已更新 _build\swamp.exe（target: %TARGET_DIR%）
exit /b 0


:: --- 子过程：编译 Wasm（暂存至本地非同步目录避开网盘抢锁） ---
:do_build_wasm
echo.
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if not exist "%WASM_OUT_DIR%" mkdir "%WASM_OUT_DIR%"
set "WASM_STAGE_DIR=%TARGET_DIR%\wasm-stage"
if exist "%WASM_STAGE_DIR%" rmdir /s /q "%WASM_STAGE_DIR%" 2>nul
mkdir "%WASM_STAGE_DIR%" >nul 2>&1
set "CARGO_TARGET_DIR=%TARGET_DIR%"
set "RUSTFLAGS="

echo [wasm] 编译 Wasm（临时目录: %WASM_STAGE_DIR%）
pushd "%CRATE_DIR%"
call :run_wasm_pack
if errorlevel 1 (
    popd
    echo [error] Wasm 编译失败
    exit /b 1
)
popd

set "STAGE_WASM_BIN=%WASM_STAGE_DIR%\compute_intensive_task_processor_bg.wasm"
set "OUT_WASM_BIN=%WASM_OUT_DIR%\compute_intensive_task_processor_bg.wasm"
set "RAW_WASM_JS=%WASM_STAGE_DIR%\compute_intensive_task_processor.js"
set "MIN_WASM_JS=%WASM_OUT_DIR%\compute_intensive_task_processor.min.js"

if not exist "%STAGE_WASM_BIN%" (
    echo [error] 临时目录中缺少 .wasm 产物
    exit /b 1
)

call :copy_with_retry "%STAGE_WASM_BIN%" "%OUT_WASM_BIN%"
if errorlevel 1 (
    echo [error] 复制 .wasm 到 src\wasm 失败（文件可能被占用）
    exit /b 1
)

if exist "%RAW_WASM_JS%" (
    if exist "%BUILD_DIR%\swamp.exe" (
        call :run_swamp_minify "%RAW_WASM_JS%" "%MIN_WASM_JS%"
        if errorlevel 1 (
            echo [warn] JS 压缩失败，改为直接复制胶水脚本
            call :copy_with_retry "%RAW_WASM_JS%" "%MIN_WASM_JS%"
            if errorlevel 1 (
                echo [error] 复制胶水脚本到 src\wasm 失败
                exit /b 1
            )
        )
    ) else (
        echo [warn] 未找到 _build\swamp.exe，改为直接复制胶水脚本（可先选 [1] 编译）
        call :copy_with_retry "%RAW_WASM_JS%" "%MIN_WASM_JS%"
        if errorlevel 1 (
            echo [error] 复制胶水脚本到 src\wasm 失败
            exit /b 1
        )
    )
) else (
    echo [error] 临时目录中缺少胶水脚本
    exit /b 1
)

rmdir /s /q "%WASM_STAGE_DIR%" 2>nul

echo [ok] 已更新 src\wasm\compute_intensive_task_processor.{min.js,_bg.wasm}
exit /b 0


:: --- 辅助子过程：带重试复制（缓解网盘/杀软瞬时抢锁） ---
:copy_with_retry
setlocal
set "SRC_FILE=%~1"
set "DST_FILE=%~2"
set "COPY_TRY=0"
:copy_retry_loop
copy /y "%SRC_FILE%" "%DST_FILE%" >nul 2>&1
if not errorlevel 1 (
    endlocal
    exit /b 0
)
set /a COPY_TRY+=1
if %COPY_TRY% GEQ 6 (
    endlocal
    exit /b 1
)
echo [warn] 目标文件被占用，第 %COPY_TRY% 次重试复制
timeout /t 1 /nobreak >nul 2>&1 || ping -n 2 127.0.0.1 >nul
goto copy_retry_loop


:: --- 令牌隔离执行子过程（防止 _SWAMP_HANDOFF_TOKEN 泄漏给构建子进程） ---
:run_cargo_build
setlocal
set "_SWAMP_HANDOFF_TOKEN="
set "SWAMP_HANDOFF_TOKEN="
cargo build --profile release-exe --bin swamp
set "RUN_RC=%ERRORLEVEL%"
endlocal & exit /b %RUN_RC%

:run_selftest
setlocal
set "_SWAMP_HANDOFF_TOKEN="
set "SWAMP_HANDOFF_TOKEN="
"%TARGET_DIR%\release-exe\swamp.exe" --selftest
set "RUN_RC=%ERRORLEVEL%"
endlocal & exit /b %RUN_RC%

:run_wasm_pack
setlocal
set "_SWAMP_HANDOFF_TOKEN="
set "SWAMP_HANDOFF_TOKEN="
call wasm-pack build --target web --out-dir "%WASM_STAGE_DIR%" --out-name compute_intensive_task_processor --target-dir "%TARGET_DIR%"
set "RUN_RC=%ERRORLEVEL%"
endlocal & exit /b %RUN_RC%

:run_swamp_minify
setlocal
set "_SWAMP_HANDOFF_TOKEN="
set "SWAMP_HANDOFF_TOKEN="
"%BUILD_DIR%\swamp.exe" minify "%~1" "%~2"
set "RUN_RC=%ERRORLEVEL%"
endlocal & exit /b %RUN_RC%
