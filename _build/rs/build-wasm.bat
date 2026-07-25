@echo off
setlocal

::==============================================================================
:: Build WASM module using wasm-pack (for Rust + Web projects)
::==============================================================================

title Building WASM for Project

set WASM_OUT_DIR=..\..\src\wasm
set TARGET_DIR=D:\_temp\rs_target
set BUILD_ARGS=--target web --out-dir "%WASM_OUT_DIR%" --target-dir "%TARGET_DIR%"

cd /d "%~dp0"

echo.
echo [INFO] Building WASM...
call wasm-pack build %BUILD_ARGS%

if errorlevel 1 (
    echo.
    echo [ERROR] WASM build failed!
    pause
    exit /b 1
)

echo.
echo Cleaning generated files...

del /Q "%WASM_OUT_DIR%\*.d.ts" 2>nul
del /Q "%WASM_OUT_DIR%\*.json" 2>nul
del /Q "%WASM_OUT_DIR%\.gitignore" 2>nul

echo.
echo [SUCCESS] WASM build completed successfully!
pause
