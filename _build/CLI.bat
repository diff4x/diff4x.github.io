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
set "local_config_file=%A%secrets\local.properties"

:: Java / 工具链路径
set "jre_path="
set "vscode_path="
set "katrain_dir="
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
    if "%%A"=="katrain_dir" set "katrain_dir=%%B"
)

if exist "%local_config_file%" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%local_config_file%") do (
        if "%%A"=="jre_path" set "jre_path=%%B"
        if "%%A"=="vscode_path" set "vscode_path=%%B"
        if "%%A"=="katrain_dir" set "katrain_dir=%%B"
        if "%%A"=="static-web-server_path" set "static-web-server_path=%%B"
        if "%%A"=="root_path" set "root_path=%%B"
        if "%%A"=="port" set "port=%%B"
        if "%%A"=="log_level" set "log_level=%%B"
        if "%%A"=="esbuild_path" set "esbuild_path=%%B"
        if "%%A"=="github_page" set "github_page=%%B"
    )
)


:: =====================================================
:: [3] 输入路由层（CLI参数 / URL Scheme 入口）
::
:: 安全约定（重要）:
::   协议 URL 来自浏览器, 属于不可信输入。URL 中的任何文本都不得被拼进
::   cmd 命令行或 PowerShell 命令串; 一律经环境变量交给 protocol_guard.ps1
::   校验, 校验通过后批处理只会接触「动作编号」与 base64（字符集 A-Za-z0-9+/=）。
::   两种入口:
::     a) 推荐: 注册表直接调用 protocol_guard.ps1 -Mode Launch, 校验后以
::        `CLI.bat __proto` 重新进入本脚本（URL 完全不经过 cmd 解析）
::     b) 兼容: 旧注册方式 cmd /c CLI.bat "%1" —— 立即转交 guard 校验
::        （仍有一次 %~1 经过 cmd 解析, 请用菜单 [7] registering-protocol 重新注册以切换到 a）
:: =====================================================
set "guard_ps1=%A%protocol_guard.ps1"
if "%~1"=="__proto" goto proto_route

set "input_arg=%~1"
if "!input_arg!"=="" goto run_menu

:: 判断是否为 URL Scheme（包含 ://）
:: (废弃 pipe 管道，改用纯字符串检查，避免衍生 2 个子 CMD 引发额外的 AutoRun 报错)
if not "!input_arg:://=!"=="!input_arg!" (
    set "CLI_RAW=!input_arg!"
    set "input_arg="
    set "G_OK="
    rem guard 只输出 KEY=VALUE（值仅为数字 / base64）, 末行 OK=1 代表校验通过
    for /f "tokens=1,* delims==" %%K in ('powershell -NoProfile -ExecutionPolicy Bypass -File "!guard_ps1!" -Mode Emit 2^>nul') do set "G_%%K=%%L"
    set "CLI_RAW="
    goto proto_route
)
goto run_menu

:: ------------------------------
:: 路由分发表（G_* 由 protocol_guard.ps1 校验后提供）
:: ------------------------------
:proto_route
if not "!G_OK!"=="1" (
    echo [REJECTED] 非法或不受支持的协议请求, 已拒绝执行.
    pause
    goto end
)
if "!G_ACTION!"=="1" goto case_edit
if "!G_ACTION!"=="2" goto case_bookmark
if "!G_ACTION!"=="3" goto case_explorer
if "!G_ACTION!"=="4" goto run_menu
if "!G_ACTION!"=="5" goto case_overwrite
if "!G_ACTION!"=="6" goto run_gen
if "!G_ACTION!"=="7" goto case_jump_txn_file_line
if "!G_ACTION!"=="8" goto case_go
if "!G_ACTION!"=="9" goto case_overwrite_md
goto end


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
::
:: 以下各动作: G_* 由 protocol_guard.ps1 校验后提供（数字 / base64）。
:: 需要原文时一律经 -Mode Decode 在 PowerShell 内解码, 不把原文拼进命令串。
:: =====================================================
:case_edit
set "jar_path=%A%jar\gen.jar"
set "b64=!G_P_B64!"
set "CLI_DEC_IN=!G_P_B64!"
set "params="
for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -File "!guard_ps1!" -Mode Decode 2^>nul') do set "params=%%A"
if not defined params goto end
set "html_file=%B%html\!params!.html"

if not exist "!html_file!" (
    echo File not found: !html_file!
    pause
    goto end
)

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_path%" "stamp" "!b64!"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%" "%vscode_path%" "!html_file!"
goto end


:: =====================================================
:: [6] URL动作：Bookmark（收藏逻辑）
:: =====================================================
:case_bookmark
set "jar_path=%A%jar\gen.jar"
set "CLI_BLOCK_B64=!G_BLOCK_B64!"
set "CLI_TITLE_B64=!G_TITLE_B64!"
set "CLI_HREF_B64=!G_HREF_B64!"
set "CLI_TITLE3="

:: 标题为空（即 标题 == 链接）时交互输入; 手输文本只经环境变量进入 PowerShell
if "!G_NEED_TITLE!"=="1" set /p "CLI_TITLE3=Enter the title [optional]:"

set "b64="
for /f "delims=" %%x in ('powershell -NoProfile -ExecutionPolicy Bypass -File "!guard_ps1!" -Mode Compose 2^>nul') do set "b64=%%x"
if not defined b64 (
    echo [ERROR] 书签参数无效, 已放弃.
    pause
    goto end
)

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-jar" "%jar_path%" "bookmark" "!b64!"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"
goto end


:: =====================================================
:: [7] URL动作：Explorer（直接打开当前仓库根目录，无参）
:: =====================================================
:case_explorer
powershell -NoProfile -ExecutionPolicy Bypass -File "!guard_ps1!" -Mode OpenFolder
goto end


:: =====================================================
:: [8] URL动作：Clipboard Overwrite（剪贴板写入 html\<标题>.html，不触发全量构建）
:: =====================================================
:case_overwrite
set "CLI_DEC_IN=!G_P_B64!"
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "!guard_ps1!" -Mode WriteClipboard -Kind html
if errorlevel 1 (
    echo [ERROR] 写入失败.
    pause
)
goto end


:: =====================================================
:: [9] URL动作：Clipboard Overwrite MD（剪贴板覆写仓库内指定 Markdown 文件）
:: =====================================================
:case_overwrite_md
set "CLI_DEC_IN=!G_P_B64!"
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "!guard_ps1!" -Mode WriteClipboard -Kind md
if errorlevel 1 (
    echo [ERROR] 写入失败.
    pause
)
goto end


:: =====================================================
:: URL动作：打开 txn 跳转到指定行
:: =====================================================
:case_jump_txn_file_line
set "line_num=!G_LINE!"
if not defined line_num goto end

set "txn_file=%A%secrets\txn.txt"
if not exist "!txn_file!" (
    echo [ERROR] 找不到流水文件: !txn_file!
    pause
    goto end
)
start "" "%vscode_path%" -g "!txn_file!:!line_num!"

goto end


:: =====================================================
:: URL动作：打开KaTrain
:: =====================================================
:case_go
if not defined katrain_dir (
    echo [ERROR] 未在 _build\secrets\local.properties 配置 katrain_dir！
    pause
    goto end
)
set "KATRAIN_DIR=!katrain_dir!"
powershell -NoProfile -Command "Start-Process -FilePath 'uv' -ArgumentList 'run python -m katrain' -WorkingDirectory $env:KATRAIN_DIR -WindowStyle Hidden"
set "KATRAIN_DIR="
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

    if not "!rel!"=="core-list.js" if not "!rel!"=="sw.js" if not "!rel!"=="synonyms.js" (
        call :CalcFileHash "%%F"

        set "do_build=1"

        set "ONE_ERR=0"
        if exist "%modtime_list%" if exist "%js_output_dir%\!rel!" (
            findstr /L /x /c:"!rel!|!file_hash!" "%modtime_list%" >nul 2>&1
            if not errorlevel 1 set "do_build=0"
        )

        if !do_build! == 1 (
            echo [JS] Building !rel!
            "%esbuild_path%" "%%F" --outfile="%js_output_dir%\!rel!" --minify --target=es2020 --charset=utf8 --sourcemap
            if errorlevel 1 ( set "GEN_ERROR=1" & set "ONE_ERR=1" )

            if exist "%js_output_dir%\!rel!.map" (
                move /y "%js_output_dir%\!rel!.map" "%JS_MAP_DIR%\!rel!.map" >nul
                powershell -nologo -noprofile -command "$p='%js_output_dir%\!rel!'; $c=Get-Content -Path $p -Raw -Encoding UTF8; $c=$c.Replace('sourceMappingURL=source-map/','sourceMappingURL=').Replace('sourceMappingURL=','sourceMappingURL=source-map/'); [IO.File]::WriteAllText($p,$c)"
            )
        ) else (
            echo [JS] Skipped !rel!
        )

        if "!ONE_ERR!"=="0" >>"%new_list%" echo !rel!^|!file_hash!
    )
)

:: ---------------- CSS 构建 ----------------
for /r "%css_input_dir%" %%F in (*.css) do (
    set "rel=%%~nxF"

    if not "!rel!"=="font.css" (
        call :CalcFileHash "%%F"

        set "do_build=1"

        set "ONE_ERR=0"
        if exist "%modtime_list%" if exist "%css_output_dir%\!rel!" (
            findstr /L /x /c:"!rel!|!file_hash!" "%modtime_list%" >nul 2>&1
            if not errorlevel 1 set "do_build=0"
        )

        if !do_build! == 1 (
            echo [CSS] Building !rel!
            "%esbuild_path%" "%%F" --outfile="%css_output_dir%\!rel!" --minify --target=es2020 --charset=utf8 --sourcemap
            if errorlevel 1 ( set "GEN_ERROR=1" & set "ONE_ERR=1" )

            if exist "%css_output_dir%\!rel!.map" (
                move /y "%css_output_dir%\!rel!.map" "%CSS_MAP_DIR%\!rel!.map" >nul
                powershell -nologo -noprofile -command "$p='%css_output_dir%\!rel!'; $c=Get-Content -Path $p -Raw -Encoding UTF8; $c=$c.Replace('sourceMappingURL=source-map/','sourceMappingURL=').Replace('sourceMappingURL=','sourceMappingURL=source-map/'); [IO.File]::WriteAllText($p,$c)"
            )
        ) else (
            echo [CSS] Skipped !rel!
        )
        if "!ONE_ERR!"=="0" >>"%new_list%" echo !rel!^|!file_hash!
    )
)

:: ---------------- font.css 构建 ----------------
set "raw_font_path=%B%src\css\font\font.css"
if exist "!raw_font_path!" (
    for %%F in ("!raw_font_path!") do (
        call :CalcFileHash "%%F"
        set "do_build=1"
        set "ONE_ERR=0"

        if exist "%modtime_list%" if exist "%B%src\css\font.css" (
            findstr /L /x /c:"font.css|!file_hash!" "%modtime_list%" >nul 2>&1
            if not errorlevel 1 set "do_build=0"
        )

        if !do_build! == 1 (
            echo [CSS] Building font.css
            "%esbuild_path%" "%%F" --outfile="%B%src\css\font.css" --minify --target=es2020 --charset=utf8
            if errorlevel 1 ( set "GEN_ERROR=1" & set "ONE_ERR=1" )
        ) else (
            echo [CSS] Skipped font.css
        )
        if "!ONE_ERR!"=="0" >>"%new_list%" echo font.css^|!file_hash!
    )
)

:: ---------------- JS特殊文件（顺序构建） ----------------
:: core-list.js / sw.js
:: =====================================================
set "jar_gen=%A%jar\gen.jar"
echo [INFO] Running gen.jar to generate latest manifests...
:: gen.jar 通过 -Dgen.status 指定的文件汇报结果（OK / FAIL: ...）; 这里只能靠 PID 轮询等待, 拿不到退出码
set "GEN_STATUS=%TEMP%\diff4x_gen_status.txt"
if exist "%GEN_STATUS%" del /f /q "%GEN_STATUS%" >nul 2>&1

call :RunJavaAndGetPID "-Dfile.encoding=UTF-8" "-Dgen.status=%GEN_STATUS%" "-jar" "%jar_gen%"
start "" wscript.exe "%A%jar\log_watch.vbs" "%JAVA_PID%"

:wait_java_gen
tasklist /FI "PID eq %JAVA_PID%" 2>nul | find "%JAVA_PID%" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_java_gen
)

:: 构建失败即停: 不再压缩、不提交、不推送, 产物保持上一次状态
findstr /b /c:"OK" "%GEN_STATUS%" >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] gen.jar 构建失败, 已中止后续压缩与推送。详情见日志窗口 / gen_status:
    if exist "%GEN_STATUS%" type "%GEN_STATUS%"
    set "GEN_ERROR=1"
    pause
    goto end
)

for /r "%js_input_dir%" %%F in (core-list.js sw.js) do (
    set "rel=%%~nxF"
    call :CalcFileHash "%%F"
    set "do_build=1"
    set "ONE_ERR=0"
    set "target_out=%js_output_dir%\!rel!"
    if "!rel!"=="sw.js" set "target_out=%B%sw.js"

    if exist "%modtime_list%" if exist "!target_out!" (
        findstr /L /x /c:"!rel!|!file_hash!" "%modtime_list%" >nul 2>&1
        if not errorlevel 1 set "do_build=0"
    )
    
    if !do_build! == 1 (
        echo [JS] Building !rel!
        
        "%esbuild_path%" "%%F" --outfile="%js_output_dir%\!rel!" --minify --target=es2020 --charset=utf8 --sourcemap
        if errorlevel 1 ( set "GEN_ERROR=1" & set "ONE_ERR=1" )

        if exist "%js_output_dir%\!rel!.map" (
            move /y "%js_output_dir%\!rel!.map" "%JS_MAP_DIR%\!rel!.map" >nul
        )

        if "!rel!"=="sw.js" (
            move /y "%js_output_dir%\!rel!" "%B%sw.js" >nul
            powershell -nologo -noprofile -command "$p='%B%sw.js'; $c=Get-Content -Path $p -Raw -Encoding UTF8; [IO.File]::WriteAllText($p, ($c -replace 'sourceMappingURL=sw.js.map', 'sourceMappingURL=src/js/source-map/sw.js.map'))"
        ) else (
            powershell -nologo -noprofile -command "$p='%js_output_dir%\!rel!'; $c=Get-Content -Path $p -Raw -Encoding UTF8; $c=$c.Replace('sourceMappingURL=source-map/','sourceMappingURL=').Replace('sourceMappingURL=','sourceMappingURL=source-map/'); [IO.File]::WriteAllText($p,$c)"
        )
    ) else (
        echo [JS] Skipped !rel!
    )
    if "!ONE_ERR!"=="0" >>"%new_list%" echo !rel!^|!file_hash!
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
set "PROTO_KEY="
for /f "delims=" %%K in ('powershell -NoProfile -ExecutionPolicy Bypass -File "!guard_ps1!" -Mode EnsureKey -Rotate') do set "PROTO_KEY=%%K"
if not defined PROTO_KEY (
    echo [ERROR] 初始化本地协议密钥失败！
    pause
    goto end
)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort %port% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
start "Local" /min "%static-web-server_path%" -w "%A%server\sws.toml" --host 127.0.0.1 -d "%root_path%" -p "%port%" -g "%log_level%"
start "" "http://localhost:%port%/#__diff4x_key=!PROTO_KEY!"
set "PROTO_KEY="
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
set "protocol_guard=%A%protocol_guard.ps1"
set "ps_exe=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%protocol_guard%" (
    echo [ERROR] protocol_guard.ps1 not found: %protocol_guard%
    pause
    goto end
)
:: URL 直接交给 PowerShell 的 argv（不经过 cmd 解析），由 guard 校验后再回调 CLI.bat __proto
reg add "HKCR\%protocol_name%\shell\open\command" /ve /d "\"%ps_exe%\" -NoProfile -ExecutionPolicy Bypass -File \"%protocol_guard%\" -Mode Launch \"%%1\"" /f >nul

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
powershell -NoProfile -Command "Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
start "Simulation" /min "%static-web-server_path%" -w "%A%server\sws-sim.toml" --host 127.0.0.1 -d "%root_path%" -p "9000" -g "info"
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

:: =====================================================
:: 子程序：计算文件 SHA-256 哈希（替代分钟精度时间戳）
:: =====================================================
:CalcFileHash
set "file_hash="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "%~1" SHA256 2^>nul') do (
    if not defined file_hash set "file_hash=%%H"
)
if not defined file_hash (
    for %%I in ("%~1") do set "file_hash=%%~tI_%%~zI"
)
set "file_hash=!file_hash: =!"
goto :eof
