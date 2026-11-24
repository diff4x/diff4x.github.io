@echo off
chcp 65001 >nul
setlocal
for %%I in ("%~dp0.") do set "CRATE_DIR=%%~fI"
for %%I in ("%CRATE_DIR%\..") do set "BUILD_DIR=%%~fI"
for %%I in ("%BUILD_DIR%\..") do set "REPO_DIR=%%~fI"
set "TARGET_DIR=%BUILD_DIR%\temp\target"
set "WASM_OUT_DIR=%REPO_DIR%\src\wasm"
cd /d "%CRATE_DIR%" >nul 2>&1

if /i "%~1"=="exe"  goto build_exe_only
if /i "%~1"=="wasm" goto build_wasm_only
if /i "%~1"=="all"  goto build_all

:menu
cls
echo =====================================================
echo   Swamp Unified Rust Builder (_build\swamp-server)
echo =====================================================
echo   [1] 编译 swamp.exe (原生伴生服务 + 桌面管理窗)
echo   [2] 编译 Wasm 引擎 (compute_intensive_task_processor)
echo   [3] 全部编译 (swamp.exe + Wasm)
echo   [0] 退出
echo =====================================================
choice /c 1230 /n /m "choice [0~3]: "
if errorlevel 4 goto :eof
if errorlevel 3 goto build_all
if errorlevel 2 goto build_wasm_only
if errorlevel 1 goto build_exe_only

:build_exe_only
call :do_build_exe
pause
goto :eof

:build_wasm_only
call :do_build_wasm
pause
goto :eof

:build_all
call :do_build_exe
if errorlevel 1 (
    pause
    goto :eof
)
call :do_build_wasm
pause
goto :eof

:: -----------------------------------------------------
:: 子过程 1：编译 _build\swamp.exe
:: -----------------------------------------------------
:do_build_exe
echo.
echo [EXE] 检查 swamp.exe 占用状态...
set "WAIT_TRY=0"
:wait_swamp_exit
tasklist /FI "IMAGENAME eq swamp.exe" 2>nul | find /I "swamp.exe" >nul
if errorlevel 1 goto swamp_exited
set /a WAIT_TRY+=1
if %WAIT_TRY% GTR 6 (
    echo [WARN] 检测到 swamp.exe 仍在运行，请先关闭 Swamp 管理窗口再重新编译。
    exit /b 1
)
if %WAIT_TRY%==1 echo [EXE] 等待 swamp.exe 安全退出...
timeout /t 1 /nobreak >nul
goto wait_swamp_exit
:swamp_exited

:: 自动迁移旧路径 cilin.txt 至 _build\swamp-server\assets\cilin.txt（运行期外置只读读取）
if not exist "%CRATE_DIR%\assets\cilin.txt" (
    if exist "%BUILD_DIR%\rust\swamp-server\assets\cilin.txt" (
        if not exist "%CRATE_DIR%\assets" mkdir "%CRATE_DIR%\assets"
        copy /y "%BUILD_DIR%\rust\swamp-server\assets\cilin.txt" "%CRATE_DIR%\assets\cilin.txt" >nul
        echo [INFO] 已自动迁移 _build\rust\swamp-server\assets\cilin.txt 至 assets\cilin.txt
    ) else if exist "%BUILD_DIR%\synonyms\cilin.txt" (
        if not exist "%CRATE_DIR%\assets" mkdir "%CRATE_DIR%\assets"
        copy /y "%BUILD_DIR%\synonyms\cilin.txt" "%CRATE_DIR%\assets\cilin.txt" >nul
        echo [INFO] 已自动迁移 _build\synonyms\cilin.txt 至 assets\cilin.txt
    )
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
set "CARGO_TARGET_DIR=%TARGET_DIR%"
set "RUSTFLAGS="

echo [EXE] cargo build --profile release-exe --bin swamp ...
pushd "%CRATE_DIR%"
cargo build --profile release-exe --bin swamp
if errorlevel 1 (
    popd
    echo [ERROR] swamp.exe 编译失败！
    exit /b 1
)
popd

copy /y "%TARGET_DIR%\release-exe\swamp.exe" "%BUILD_DIR%\swamp.exe" >nul
if errorlevel 1 (
    echo [ERROR] 复制到 _build\swamp.exe 失败！
    exit /b 1
)

"%BUILD_DIR%\swamp.exe" --selftest
if errorlevel 1 (
    echo [ERROR] swamp.exe 自检未通过！
    exit /b 1
)

echo [SUCCESS] 已更新 _build\swamp.exe（target 位于 _build\temp\target）
exit /b 0

:: -----------------------------------------------------
:: 子过程 2：编译 Wasm 并使用 swamp.exe 内置压缩器生成 .min.js
:: -----------------------------------------------------
:do_build_wasm
echo.
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if not exist "%WASM_OUT_DIR%" mkdir "%WASM_OUT_DIR%"
set "CARGO_TARGET_DIR=%TARGET_DIR%"
set "RUSTFLAGS="

echo [WASM] wasm-pack build --target web ...
pushd "%CRATE_DIR%"
call wasm-pack build --target web --out-dir "%WASM_OUT_DIR%" --out-name compute_intensive_task_processor --target-dir "%TARGET_DIR%"
if errorlevel 1 (
    popd
    echo [ERROR] WASM 编译失败！
    exit /b 1
)
popd

set "RAW_WASM_JS=%WASM_OUT_DIR%\compute_intensive_task_processor.js"
set "MIN_WASM_JS=%WASM_OUT_DIR%\compute_intensive_task_processor.min.js"

if exist "%RAW_WASM_JS%" (
    if exist "%BUILD_DIR%\swamp.exe" (
        "%BUILD_DIR%\swamp.exe" minify "%RAW_WASM_JS%" "%MIN_WASM_JS%"
        if errorlevel 1 (
            echo [WARN] 内置 JS 压缩失败，回退直接改名保留胶水脚本。
            move /y "%RAW_WASM_JS%" "%MIN_WASM_JS%" >nul
        ) else (
            del /Q "%RAW_WASM_JS%" 2>nul
        )
    ) else (
        echo [WARN] 未找到 _build\swamp.exe，直接改名保留胶水脚本（建议先选 [1] 编译 swamp.exe）。
        move /y "%RAW_WASM_JS%" "%MIN_WASM_JS%" >nul
    )
)

del /Q "%WASM_OUT_DIR%\*.d.ts" 2>nul
del /Q "%WASM_OUT_DIR%\*.json" 2>nul
del /Q "%WASM_OUT_DIR%\.gitignore" 2>nul

echo [SUCCESS] WASM 已输出至 src\wasm\compute_intensive_task_processor.{min.js,_bg.wasm}
exit /b 0
