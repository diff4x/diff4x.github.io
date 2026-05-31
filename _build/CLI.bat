@echo off
cls
chcp 65001 >nul
setlocal enabledelayedexpansion

:: =====================================================
:: [1] 目录层级定位 (纯字符串解析，不触发底层驱动器访问)
:: =====================================================
:: A = 当前脚本所在目录 (自带尾部 \)
set "A=%~dp0"

:: 获取 B, C, D (上一级、再上一级)
for %%I in ("%A%..") do set "B=%%~fI\"
for %%I in ("%B%..") do set "C=%%~fI\"
for %%I in ("%C%..") do set "D=%%~fI\"

:: 统一路径格式（确保结尾带 \）
for %%X in (A B C D) do (
    if not "!%%X:~-1!"=="\" set "%%X=!%%X!\"
)

:: 切换工作目录到 A (加入 >nul 2>&1 吞噬任何驱动器环境映射警告)
cd /d "%A%" >nul 2>&1


:: =====================================================
:: [2] 配置加载
:: =====================================================
set "config_file=%A%config.properties"

:: Java / 工具链路径
set "jre_path="
set "vscode_path="
set "static-web-server_path="
set "esbuild_path="

:: 服务与构建配置
set "root_path="
set "port="
set "log_level="

:: 前端构建路径
set "js_input_dir="
set "js_output_dir="
set "css_input_dir="
set "css_output_dir="

:: 站点信息
set "github_page="

:: 解析配置文件 key=value (加入 usebackq 防止路径带空格报错)
for /f "usebackq tokens=1,* delims==" %%A in ("%config_file%") do (
    if "%%A"=="jre_path" set "jre_path=%%B"
    if "%%A"=="vscode_path" set "vscode_path=%%B"
    if "%%A"=="static-web-server_path" set "static-web-server_path=%%B"
    if "%%A"=="root_path" set "root_path=%%B"
    if "%%A"=="port" set "port=%%B"
    if "%%A"=="log_level" set "log_level=%%B"
    if "%%A"=="esbuild_path" set "esbuild_path=%%B"
    if "%%A"=="js_input_dir" set "js_input_dir=%%B"
    if "%%A"=="js_output_dir" set "js_output_dir=%%B"
    if "%%A"=="css_input_dir" set "css_input_dir=%%B"
    if "%%A"=="css_output_dir" set "css_output_dir=%%B"
    if "%%A"=="github_page" set "github_page=%%B"
)


:: =====================================================
:: [3] 输入路由层（CLI参数 / URL Scheme 入口）
:: =====================================================
set "input_arg=%~1"
if "!input_arg!"=="" goto run_menu

:: 判断是否为 URL Scheme（包含 ://）
:: (废弃 pipe 管道，改用纯字符串检查，避免衍生 2 个子 CMD 引发额外的 AutoRun 报错)
if not "!input_arg:://=!"=="!input_arg!" (

    :: ------------------------------
    :: URL 解码 (外层包裹 2>nul 彻底吞噬子 CMD 的 stderr 报错)
    :: ------------------------------
    (
        for /f "delims=" %%A in ('powershell -NoProfile -nologo -command "[uri]::UnescapeDataString(\"!input_arg!\")"') do (
            set "unescaped_arg=%%A"
        )
    ) 2>nul

    :: ------------------------------
    :: 拆分 header 与 params（以 { 分割）
    :: ------------------------------
    for /f "tokens=1,* delims={" %%i in ("!unescaped_arg!") do (
        set "headers=%%i"
        set "params=%%j"
    )

    :: ------------------------------
    :: 提取 action（协议编号）
    :: ------------------------------
    for /f "tokens=2 delims=/" %%a in ("!headers!") do set "action=%%a"

    :: ------------------------------
    :: 路由分发表
    :: ------------------------------
    if "!action!"=="1" goto case_edit
    if "!action!"=="2" goto case_bookmark
    if "!action!"=="3" goto case_explorer
    if "!action!"=="4" goto run_menu
    if "!action!"=="5" goto case_overwrite
    if "!action!"=="6" goto run_gen
    if "!action!"=="7" goto case_jump_txn_file_line
    goto end
)


:: =====================================================
:: [4] CLI 主菜单
:: =====================================================
:run_menu
cls
echo =============== CLI.bat ================
echo [0] gen
echo [1] new
echo [2] keep2html
echo [3] webp
echo [4] static-web-server
echo [5] push
echo [6] gen_and_push
echo [7] registering-protocol [administrator]
echo [8] simulation [port 9000 + incognito]
echo [9] vpn-heartbeat-tray
echo ========================================

choice /c 0123456789 /n /m "choice [0~9]: "

if errorlevel 10 goto run_vpn_tray
if errorlevel 9 goto run_simulation
if errorlevel 8 goto run_registering-protocol
if errorlevel 7 goto run_gen_push
if errorlevel 6 goto run_add-commit-push
if errorlevel 5 goto run_static-web-server
if errorlevel 4 goto run_webp
if errorlevel 3 goto run_keep2html
if errorlevel 2 goto run_new
if errorlevel 1 goto run_gen


:: =====================================================
:: [5] URL动作：Edit（打开编辑页面）
:: =====================================================
:case_edit
set "jar_path=%A%jar\gen.jar"

:: 去掉末尾 /
if "!params:~-1!"=="/" set "params=!params:~0,-1!"

set "html_file=%B%html\%params%.html"

if not exist "%html_file%" (
    echo File not found: %html_file%
    pause
    goto end
)

:: Base64编码参数
(
    for /f "delims=" %%A in ('powershell -NoProfile -nologo -command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('%params%'))"') do set "b64=%%A"
) 2>nul

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_path%" "stamp" "%b64%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%" "%vscode_path%" "%html_file%"
goto end


:: =====================================================
:: [6] URL动作：Bookmark（收藏逻辑）
:: =====================================================
:case_bookmark
set "jar_path=%A%jar\gen.jar"
set "mess=!params!"

for /f "tokens=1,2,3 delims=}" %%i in ("!mess!") do (
    set "block=%%i"
    set "title=%%j"
    set "href=%%k"
)

if "!href:~-1!"=="/" set "href=!href:~0,-1!"

set "block2=!block!"
set "title2=!title!"
set "href2=!href!"

:: 标题为空时交互输入
if "%title2%"=="%href2%" (
    if "%block2%"=="del" (
        set "psCommand=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('!block2!|!title2!|!href2!'))"
    ) else (
        set /p title3="Enter the title [optional]:"
        set "psCommand=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('!block2!|!title3!|!href2!'))"
    )
) else (
    set "psCommand=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('!block2!|!title2!|!href2!'))"
)

(
    for /f "delims=" %%x in ('powershell -NoProfile -nologo -Command "!psCommand!"') do set "b64=%%x"
) 2>nul

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_path%" "bookmark" "%b64%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"
goto end


:: =====================================================
:: [7] URL动作：Explorer（打开目录）
:: =====================================================
:case_explorer
start "" "d:!params:%%20= !"
goto end


:: =====================================================
:: [8] URL动作：Clipboard Overwrite（剪贴板写入文件）
:: =====================================================
:case_overwrite
set "title=!params!"
if "!title:~-1!"=="/" set "title=!title:~0,-1!"
set "target_file=%B%html\!title!.html"

powershell -NoProfile -nologo -command "Add-Type -AssemblyName System.Windows.Forms; $txt = [System.Windows.Forms.Clipboard]::GetText(); if($txt.Length -gt 0) { [IO.File]::WriteAllText('!target_file!', $txt, [Text.Encoding]::UTF8); [System.Windows.Forms.Clipboard]::Clear(); }" >nul 2>&1

goto run_gen


:: =====================================================
:: URL动作：打开 txn 跳转到指定行
:: =====================================================
:case_jump_txn_file_line
set "line_num=!params!"

if "!line_num:~-1!"=="/" set "line_num=!line_num:~0,-1!"

set "txn_file=%A%txn.txt"
if not exist "!txn_file!" (
    echo [ERROR] 找不到流水文件: !txn_file!
    pause
    goto end
)
start "" "%vscode_path%" -g "!txn_file!:!line_num!"

goto end

:: =====================================================
:: [补充] 自动推送入口
:: =====================================================
:run_gen_push
set "push_after_gen=1"
goto run_gen

:: =====================================================
:: [9] 构建流程（JS/CSS/Font + esbuild增量编译）
:: =====================================================
:run_gen
set "GEN_ERROR=0"

for %%P in ("%esbuild_path%") do set "esbuild_dir=%%~dpP"
set "modtime_list=%esbuild_dir%modtime_list.txt"
set "new_list=%esbuild_dir%new_list.tmp"

if exist "%new_list%" del "%new_list%"

set "JS_MAP_DIR=%js_output_dir%\source-map"
set "CSS_MAP_DIR=%css_output_dir%\source-map"
if not exist "%JS_MAP_DIR%" mkdir "%JS_MAP_DIR%"
if not exist "%CSS_MAP_DIR%" mkdir "%CSS_MAP_DIR%"

:: ---------------- JS 构建 ----------------
for /r "%js_input_dir%" %%F in (*.js) do (
    set "rel=%%~nxF"
    set "file_hash=%%~tF_%%~zF"

    if not "!rel!"=="core-list.js" if not "!rel!"=="sw.js" (

        set "do_build=1"
        if exist "%modtime_list%" (
            findstr /L /x /c:"!rel!|!file_hash!" "%modtime_list%" >nul 2>&1
            if not errorlevel 1 set "do_build=0"
        )

        if !do_build! == 1 (
            echo [JS] Building !rel!
            "%esbuild_path%" "%%F" --outfile="%js_output_dir%\!rel!" --minify --target=es2020 --charset=utf8 --sourcemap
            if errorlevel 1 set "GEN_ERROR=1"

            if exist "%js_output_dir%\!rel!.map" (
                move /y "%js_output_dir%\!rel!.map" "%JS_MAP_DIR%\!rel!.map" >nul
                powershell -nologo -noprofile -command "$p='%js_output_dir%\!rel!'; $c=Get-Content $p -Raw; $c=$c.Replace('sourceMappingURL=source-map/','sourceMappingURL=').Replace('sourceMappingURL=','sourceMappingURL=source-map/'); [IO.File]::WriteAllText($p,$c)"
            )
        ) else (
            echo [JS] Skipped !rel!
        )

        >>"%new_list%" echo !rel!^|!file_hash!
    )
)

:: ---------------- CSS 构建 ----------------
for /r "%css_input_dir%" %%F in (*.css) do (
    set "rel=%%~nxF"
    set "file_hash=%%~tF_%%~zF"

    if not "!rel!"=="font.css" (

        set "do_build=1"
        if exist "%modtime_list%" (
            findstr /L /x /c:"!rel!|!file_hash!" "%modtime_list%" >nul 2>&1
            if not errorlevel 1 set "do_build=0"
        )

        if !do_build! == 1 (
            echo [CSS] Building !rel!
            "%esbuild_path%" "%%F" --outfile="%css_output_dir%\!rel!" --minify --target=es2020 --charset=utf8 --sourcemap
            if errorlevel 1 set "GEN_ERROR=1"

            if exist "%css_output_dir%\!rel!.map" (
                move /y "%css_output_dir%\!rel!.map" "%CSS_MAP_DIR%\!rel!.map" >nul
                powershell -nologo -noprofile -command "$p='%css_output_dir%\!rel!'; $c=Get-Content $p -Raw; $c=$c.Replace('sourceMappingURL=source-map/','sourceMappingURL=').Replace('sourceMappingURL=','sourceMappingURL=source-map/'); [IO.File]::WriteAllText($p,$c)"
            )
        ) else (
            echo [CSS] Skipped !rel!
        )
        >>"%new_list%" echo !rel!^|!file_hash!
    )
)

:: ---------------- font.css 构建 ----------------
set "raw_font_path=%B%src\css\font\font.css"
if exist "!raw_font_path!" (
    for %%F in ("!raw_font_path!") do (
        set "file_hash=%%~tF_%%~zF"
        set "do_build=1"

        if exist "%modtime_list%" (
            findstr /L /x /c:"font.css|!file_hash!" "%modtime_list%" >nul 2>&1
            if not errorlevel 1 set "do_build=0"
        )

        if !do_build! == 1 (
            echo [CSS] Building font.css
            "%esbuild_path%" "%%F" --outfile="%B%src\css\font.css" --minify --target=es2020 --charset=utf8
            if errorlevel 1 set "GEN_ERROR=1"
        ) else (
            echo [CSS] Skipped font.css
        )
        >>"%new_list%" echo font.css^|!file_hash!
    )
)

:: ---------------- JS特殊文件（顺序构建） ----------------
:: core-list.js / sw.js
:: =====================================================
set "jar_gen=%A%jar\gen.jar"
echo [INFO] Running gen.jar to generate latest manifests...

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_gen%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"

:wait_java_gen
tasklist /FI "PID eq %JAVA_PID%" 2>nul | find "%JAVA_PID%" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_java_gen
)

for /r "%js_input_dir%" %%F in (core-list.js sw.js) do (
    set "rel=%%~nxF"
    set "file_hash=%%~tF_%%~zF"
    set "do_build=1"
    
    if exist "%modtime_list%" (
        findstr /L /x /c:"!rel!|!file_hash!" "%modtime_list%" >nul 2>&1
        if not errorlevel 1 set "do_build=0"
    )
    
    if !do_build! == 1 (
        echo [JS] Building !rel!
        
        "%esbuild_path%" "%%F" --outfile="%js_output_dir%\!rel!" --minify --target=es2020 --charset=utf8 --sourcemap
        if errorlevel 1 set "GEN_ERROR=1"

        if exist "%js_output_dir%\!rel!.map" (
            move /y "%js_output_dir%\!rel!.map" "%JS_MAP_DIR%\!rel!.map" >nul
        )

        if "!rel!"=="sw.js" (
            move /y "%js_output_dir%\!rel!" "%B%sw.js" >nul
            powershell -nologo -noprofile -command "$p='%B%sw.js'; $c=Get-Content -Path $p -Raw; [IO.File]::WriteAllText($p, ($c -replace 'sourceMappingURL=sw.js.map', 'sourceMappingURL=src/js/source-map/sw.js.map'))"
        ) else (
            powershell -nologo -noprofile -command "$p='%js_output_dir%\!rel!'; $c=Get-Content $p -Raw; $c=$c.Replace('sourceMappingURL=source-map/','sourceMappingURL=').Replace('sourceMappingURL=','sourceMappingURL=source-map/'); [IO.File]::WriteAllText($p,$c)"
        )
    ) else (
        echo [JS] Skipped !rel!
    )
    >>"%new_list%" echo !rel!^|!file_hash!
)

if exist "%new_list%" (
    move /y "%new_list%" "%modtime_list%" >nul
)

if "!push_after_gen!"=="1" (
    if "!GEN_ERROR!"=="1" (
        goto end
    ) else (
        goto run_add-commit-push
    )
)

goto end

:: =====================================================
:: [10] 新建页面（new html）
:: =====================================================
:run_new
set "jar_new=%A%jar\gen.jar"

:run_new_t
set /p title=title:
if "%title%"=="" (
    echo need title!
    goto run_new_t
)

if exist "%B%html\%title%.html" (
    echo title existed!
    goto run_new_t
)

:run_new_c
set /p category=category:
if "%category%"=="" (
    echo need category!
    goto run_new_c
)

(
    for /f "delims=" %%A in ('powershell -NoProfile -nologo -command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('%title%'))"') do set "b64_title=%%A"
    for /f "delims=" %%A in ('powershell -NoProfile -nologo -command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('%category%'))"') do set "b64_category=%%A"
) 2>nul

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_new%" "new" "%b64_title%" "%b64_category%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%" "%vscode_path%" "%B%html\%title%.html"
goto end


:: =====================================================
:: [11] keep2html 转换逻辑
:: =====================================================
:run_keep2html
set "jar_keep2html=%A%jar\gen.jar"
choice /c 120 /n /m "1=single, 2=merge, 0=esc"

if errorlevel 3 goto end
if errorlevel 2 goto case_merge
if errorlevel 1 goto case_single

:case_merge
:case_merge_t
set /p keep_tag=keep_tag:
if "%keep_tag%"=="" (
    echo need keep_tag!
    goto case_merge_t
)

:case_merge_c
set /p html_category=html_category:
if "%html_category%"=="" (
    echo need html_category!
    goto case_merge_c
)

(
    for /f "delims=" %%A in ('powershell -NoProfile -nologo -command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('%keep_tag%'))"') do set "b64_keep_tag=%%A"
    for /f "delims=" %%A in ('powershell -NoProfile -nologo -command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('%html_category%'))"') do set "b64_html_category=%%A"
) 2>nul

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_keep2html%" "keep2html" "%b64_keep_tag%" "%b64_html_category%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"
goto end

:case_single
call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_keep2html%" "keep2html"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"
goto end


:: =====================================================
:: [12] WebP 图片处理
:: =====================================================
:run_webp
set "jar_webp=%A%jar\gen.jar"

set /p resized_max_width=Resized max width[default-800]:
if "%resized_max_width%"=="" set resized_max_width=800

set /p webp_quality=WebP quality[default-80]:
if "%webp_quality%"=="" set webp_quality=80

set /p update_img_mapping=update img mapping[default-0]:
if "%update_img_mapping%"=="" set update_img_mapping=0

set /p change_output_dir=change to webpOutputDir2[default-0]:
if "%change_output_dir%"=="" set change_output_dir=0

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_webp%" "webp" "%resized_max_width%" "%webp_quality%" "%change_output_dir%" "%update_img_mapping%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"
goto end


:: =====================================================
:: [13] 静态服务器启动
:: =====================================================
:run_static-web-server
start "Local" /min "%static-web-server_path%" -d "%root_path%" -p "%port%" -g "%log_level%"
start "" "http://localhost:%port%"
goto end


:: =====================================================
:: [14] Git add/commit/push
:: =====================================================
:run_add-commit-push
setlocal

:INPUT_MSG
set "msg="
set /p msg=msg:
if "%msg%"=="" (
    echo need commit! [q to exit]
    goto INPUT_MSG
)

if /i "%msg%"=="q" (
    endlocal
    goto end
)

git add -A
git commit -m "%msg%"
git push

if errorlevel 1 (
    echo [ERROR] push failed!
) else (
    echo [SUCCESS] push success!
)

endlocal
pause
goto end


:: =====================================================
:: [15] 注册 URL Protocol（管理员权限）
:: =====================================================
:run_registering-protocol
net session >nul 2>&1
if errorlevel 1 (
    echo This script requires administrator privileges.
    pause
    goto end
)

:: 安全锁 1: 防止配置文件未配置导致变量为空
if "%github_page%"=="" (
    echo [ERROR] github_page is empty in config.properties!
    pause
    goto end
)

:: 安全锁 2: 自动剥离 http:// 或 https://，防止生成非法的协议名
set "clean_url=%github_page:https://=%"
set "clean_url=%clean_url:http://=%"

for /f "tokens=1 delims=." %%a in ("%clean_url%") do set "protocol_name=%%a"
set "protocol_bat=%A%CLI.bat"

echo Registering protocol '%protocol_name%' directly to registry...

reg add "HKCR\%protocol_name%" /ve /d "%protocol_name% Protocol" /f >nul
reg add "HKCR\%protocol_name%" /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCR\%protocol_name%\shell\open\command" /ve /d "cmd.exe /d /c \"\"%protocol_bat%\" \"%%1\"\"" /f >nul

if errorlevel 1 (
    echo [ERROR] Failed to register protocol.
) else (
    echo [SUCCESS] Protocol registered successfully!
)
goto end


:: =====================================================
:: [16] 模拟环境（9000 + Chrome incognito）
:: =====================================================
:run_simulation
echo Starting Simulation Environment on port 9000...
start "Simulation" /min "%static-web-server_path%" -d "%root_path%" -p "9000" -g "info"
start chrome --incognito "http://localhost:9000"
goto end


:: =====================================================
:: [17] VPN tray 启动
:: =====================================================
:run_vpn_tray
set "jar=%A%jar\gen.jar"
start "" /b "%jre_path%" -Dfile.encoding=UTF-8 -jar "%jar%" tray
goto end


:: =====================================================
:: [18] Java 启动器（获取 PID）- 探针诊断版
:: =====================================================
:RunJavaAndGetPID
setlocal enabledelayedexpansion

set "FULL_ARGS="
:loop_args
if "%~1"=="" goto end_args
set "FULL_ARGS=!FULL_ARGS! %1"
shift
goto loop_args
:end_args

set "SAFE_ARGS=!FULL_ARGS:'=''!"

set "PS_FILE=%TEMP%\run_java_debug_%RANDOM%.ps1"
(
    echo $ErrorActionPreference = 'Stop'
    echo $exe = '!jre_path!'.Trim(^)
    echo $argsStr = '!SAFE_ARGS!'.Trim(^)
    
    echo try {
    echo     $psi = New-Object System.Diagnostics.ProcessStartInfo
    echo     $psi.FileName = $exe
    echo     $psi.Arguments = $argsStr
    echo     $psi.UseShellExecute = $false
    echo     $psi.CreateNoWindow = $true
    echo     $p = [System.Diagnostics.Process]::Start($psi^)
    echo     Write-Output $p.Id
    echo } catch {
    echo     Write-Host ""
    echo     Write-Host "[致命错误] Java 进程启动失败！" -ForegroundColor Red
    echo     Write-Host "目标程序: $exe" -ForegroundColor Yellow
    echo     Write-Host "完整参数: $argsStr" -ForegroundColor Yellow
    echo     Write-Host "底层报错: $($_.Exception.Message)" -ForegroundColor Red
    echo     Write-Host ""
    echo }
) > "!PS_FILE!"

set "PID_RESULT="
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -file "!PS_FILE!"') do (
    set "PID_RESULT=%%i"
)

if "!PID_RESULT!"=="" (
    echo.
    echo [脚本暂停] 进程未能启动。请查看上方出现的红字 / 黄字报错信息！
    pause
    del "!PS_FILE!" >nul 2>nul
    exit
)

del "!PS_FILE!" >nul 2>nul
endlocal & set "JAVA_PID=%PID_RESULT%"
exit /b


:: =====================================================
:: [END]
:: =====================================================
:end
@REM pause
exit