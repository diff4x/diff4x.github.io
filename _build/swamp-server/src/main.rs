#![cfg_attr(windows, windows_subsystem = "windows")]
//! swamp 原生伴生服务与 CLI 主入口（Serve / Sim 路由、本地令牌交接与子命令分发）。

mod api_files;
mod api_ops;
mod builder;
mod config;
mod gui;
mod media;
mod security;
mod services;
mod static_fs;

use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, Notify};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::config::{strip_verbatim_prefix, ServerConfig};
use crate::gui::{run_management_window, WM_APP_LOG, WM_APP_VPN};
use crate::media::keep2html::{run_keep2html, KeepOptions};
use crate::media::webp::{run_webp_batch, WebpOptions};
use crate::security::{
    api_auth_middleware, build_allowed_hosts, build_allowed_origins, build_session_cookie_header,
    generate_token_hex, host_guard_middleware, run_selftest, security_headers_middleware, AppState,
    AuthCodeStore, RunMode, CLIENT_HEADER_NAME, CLIENT_HEADER_VALUE,
};
use crate::services::log_bus::LogBus;
use crate::services::tasks::{spawn_background_monitors, RuntimeStatus};
use crate::services::watcher::spawn_asset_watcher;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

enum SubCommand {
    Serve,
    Sim,
    Gen,
    New {
        title: Option<String>,
        category: Option<String>,
        open_editor: bool,
    },
    Webp {
        max_width: Option<u32>,
        quality: Option<u8>,
        alt_dir: bool,
        update_mapping: bool,
    },
    Keep2Html {
        mode: String,
        tag_name: String,
        category: String,
    },
    Synonyms,
    Bookmark {
        block: String,
        title: String,
        href: String,
    },
    Minify {
        input: PathBuf,
        output: PathBuf,
    },
    InitUpstream,
    PullUpstream,
    SelfTest,
}

struct CliArgs {
    cmd: SubCommand,
    port: Option<u16>,
    root: Option<PathBuf>,
    log_level: Option<String>,
    open_browser: bool,
}

fn attach_parent_console_if_cli() {
    #[cfg(windows)]
    {
        if std::env::args_os().len() > 1 {
            unsafe {
                windows_sys::Win32::System::Console::AttachConsole(
                    windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
                );
            }
        }
    }
}

fn print_usage() {
    println!(
        "swamp v{} - 本地服务、站点构建与管理工具\n\
         \n\
         用法:\n\
           swamp [命令] [选项]           无参数启动时运行本地服务并打开管理窗口\n\
         \n\
         服务模式:\n\
           serve                         启动本地服务与管理窗口（默认）\n\
           sim                           启动线上仿真服务（9000 端口，禁用 /__api、_build、shadow* 与 __ 私有页）\n\
         \n\
         命令行子命令:\n\
           gen                           构建站点（资源压缩、数据切片、同义词、缓存清单与隐私检查）\n\
           new [title] [category]        新建 HTML 页面（加 --open 使用 VS Code 打开）\n\
           webp [maxW] [quality]         批量转换图片为 WebP 并复制文件名到剪贴板\n\
           keep2html [single|merge] ...  将 Google Keep 导出包转换为 HTML 与图片\n\
           synonyms                      重建 synonyms.js、未收录词报告并执行构建\n\
           bookmark <blk> <ttl> <href>   更新 src/tpl/bookmark.html 中的书签\n\
           minify <in> <out>             压缩单个 JS 或 CSS 文件\n\
           init-upstream                 首次初始化上游骨架仓并建立本地双父锚点\n\
           pull-upstream                 拉取上游骨架更新或已合并 PR（保护用户独占文件）\n\
           --selftest                    运行内置自检\n\
         \n\
         选项:\n\
           -p, --port <N>                指定监听端口\n\
           -d, --root <DIR>              指定仓库根目录\n\
           -g, --log-level <LVL>         日志级别 (error | info)\n\
           --open                        自动打开浏览器或编辑器\n\
           --alt-dir / --update-mapping  webp 输出与引用替换开关\n\
           -h, --help                    显示帮助\n\
           -V, --version                 显示版本",
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_cli_args() -> Result<CliArgs, String> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut port = None;
    let mut root = None;
    let mut log_level = None;
    let mut open_flag = false;
    let mut alt_dir = false;
    let mut update_mapping = false;
    let mut selftest = false;
    let mut positionals: Vec<String> = Vec::new();

    let mut i = 0usize;
    while i < raw.len() {
        match raw[i].as_str() {
            "-p" | "--port" => {
                i += 1;
                let v = raw.get(i).ok_or("--port 缺少参数")?;
                port = Some(v.parse::<u16>().map_err(|_| format!("非法端口: {}", v))?);
            }
            "-d" | "--root" => {
                i += 1;
                let v = raw.get(i).ok_or("--root 缺少参数")?;
                root = Some(PathBuf::from(v));
            }
            "-g" | "--log-level" => {
                i += 1;
                let v = raw.get(i).ok_or("--log-level 缺少参数")?;
                log_level = Some(v.clone());
            }
            "--open" => open_flag = true,
            "--alt-dir" => alt_dir = true,
            "--update-mapping" => update_mapping = true,
            "--selftest" => selftest = true,
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("swamp {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other if other.starts_with('-') => {
                return Err(format!("未知选项: {}", other));
            }
            other => positionals.push(other.to_string()),
        }
        i += 1;
    }

    if selftest {
        return Ok(CliArgs {
            cmd: SubCommand::SelfTest,
            port,
            root,
            log_level,
            open_browser: false,
        });
    }

    let cmd = match positionals.first().map(|s| s.as_str()) {
        None | Some("serve") | Some("local") => SubCommand::Serve,
        Some("sim") | Some("simulation") => SubCommand::Sim,
        Some("gen") | Some("build") => SubCommand::Gen,
        Some("synonyms") => SubCommand::Synonyms,
        Some("new") => SubCommand::New {
            title: positionals.get(1).cloned(),
            category: positionals.get(2).cloned(),
            open_editor: open_flag,
        },
        Some("webp") => SubCommand::Webp {
            max_width: positionals.get(1).and_then(|s| s.parse().ok()),
            quality: positionals.get(2).and_then(|s| s.parse().ok()),
            alt_dir,
            update_mapping,
        },
        Some("keep2html") => SubCommand::Keep2Html {
            mode: positionals
                .get(1)
                .cloned()
                .unwrap_or_else(|| "single".to_string()),
            tag_name: positionals.get(2).cloned().unwrap_or_default(),
            category: positionals.get(3).cloned().unwrap_or_default(),
        },
        Some("bookmark") => {
            if positionals.len() < 4 {
                return Err("用法: swamp bookmark <block> <title> <href>".to_string());
            }
            SubCommand::Bookmark {
                block: positionals[1].clone(),
                title: positionals[2].clone(),
                href: positionals[3].clone(),
            }
        }
        Some("minify") => {
            if positionals.len() < 3 {
                return Err("用法: swamp minify <input.js|css> <output.js|css>".to_string());
            }
            SubCommand::Minify {
                input: PathBuf::from(&positionals[1]),
                output: PathBuf::from(&positionals[2]),
            }
        }
        Some("init-upstream") => SubCommand::InitUpstream,
        Some("pull-upstream") => SubCommand::PullUpstream,
        Some(other) => return Err(format!("未知子命令: {}（使用 --help 查看用法）", other)),
    };

    Ok(CliArgs {
        cmd,
        port,
        root,
        log_level,
        open_browser: open_flag,
    })
}

fn prompt_line(label: &str) -> Result<String, String> {
    print!("{}", label);
    let _ = io::stdout().flush();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("读取输入失败: {}", e))?;
    Ok(line.trim().to_string())
}

pub fn open_url_in_browser(url: &str, incognito: bool) {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::path::Path;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        if incognito {
            let mut candidates = vec![
                r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe".to_string(),
            ];
            if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
                candidates.push(format!(r"{}\Google\Chrome\Application\chrome.exe", local_app));
            }
            for chrome in candidates {
                if Path::new(&chrome).is_file() {
                    let mut cmd = Command::new(&chrome);
                    cmd.args(["--incognito", url])
                        .creation_flags(CREATE_NO_WINDOW);
                    if cmd.spawn().is_ok() {
                        return;
                    }
                }
            }
        }

        let op_w: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let url_w: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op_w.as_ptr(),
                url_w.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = incognito;
        let _ = Command::new("open").arg(url).spawn();
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = incognito;
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

async fn api_health() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "mode": "serve",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

async fn api_get_tasks(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let tasks = state.runtime.get_tasks();
    Json(json!({ "ok": true, "tasks": tasks }))
}

#[derive(Deserialize)]
struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn oauth_html_response(body: String) -> Response {
    let mut resp = Html(body).into_response();
    resp.headers_mut().insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';",
        ),
    );
    resp
}

async fn oauth_callback(
    State(state): State<Arc<AppState>>,
    Query(q): Query<OAuthCallbackQuery>,
) -> Response {
    // 严格先校验 state 再取走 pending 会话，防止第三方伪造请求提前中止正在进行的授权并触发冷却
    let q_state = q.state.unwrap_or_default();
    let pending = {
        let Ok(mut guard) = state.runtime.oauth_pending.lock() else {
            return oauth_html_response("<h3>授权状态锁异常，请重试。</h3>".to_string());
        };
        let Some(ref current) = *guard else {
            return oauth_html_response("<h3>当前无待处理的授权会话，可关闭此标签页。</h3>".to_string());
        };
        if q_state.is_empty() || q_state != current.state {
            return (
                StatusCode::FORBIDDEN,
                oauth_html_response("<h3>安全校验失败（state 不匹配），已忽略本次请求。</h3>".to_string()),
            )
                .into_response();
        }
        guard.take()
    };

    let Some(p) = pending else {
        return oauth_html_response("<h3>当前无待处理的授权会话，可关闭此标签页。</h3>".to_string());
    };

    if let Some(err) = q.error {
        let clean_err: String = err
            .chars()
            .map(|c| if matches!(c, '\r' | '\n') { ' ' } else { c })
            .take(200)
            .collect();
        let _ = p.tx.send(Err(clean_err.clone()));
        let safe_err = crate::builder::html_utils::escape_html(&clean_err);
        return oauth_html_response(format!("<h3>授权未完成：{}</h3>", safe_err));
    }

    match q.code {
        Some(code) if !code.is_empty() => {
            let _ = p.tx.send(Ok(code));
            oauth_html_response("<h2 style='font-family:sans-serif;color:#16a34a;padding:24px;'>Google OAuth 授权已完成，可关闭此页面。</h2>".to_string())
        }
        _ => {
            let _ = p.tx.send(Err("回调缺少 code 参数".to_string()));
            oauth_html_response("<h3>授权回调缺少 code 参数。</h3>".to_string())
        }
    }
}

struct RefreshGateState {
    last_denied_at: Option<Instant>,
    last_approved_at: Option<Instant>,
}

static AUTH_REFRESH_GATE: OnceLock<AsyncMutex<RefreshGateState>> = OnceLock::new();

fn auth_refresh_gate() -> &'static AsyncMutex<RefreshGateState> {
    AUTH_REFRESH_GATE.get_or_init(|| {
        AsyncMutex::new(RefreshGateState {
            last_denied_at: None,
            last_approved_at: None,
        })
    })
}

#[derive(Deserialize)]
struct AuthQuery {
    code: Option<String>,
}

fn session_cookie_json_ok(token: &str) -> Response {
    let mut resp = Json(json!({ "ok": true })).into_response();
    let headers = resp.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(cookie_val) = HeaderValue::from_str(&build_session_cookie_header(token)) {
        headers.insert(header::SET_COOKIE, cookie_val);
    }
    resp
}

/// 轻量会话同步页：校验并消费一次性 ?code=... 引导码，下发 HttpOnly; SameSite=Strict 会话 Cookie；
/// 通过 Web Locks API 检测是否已有打开的主页标签页，有则秒关过渡页不重复开窗，无则跳转首页。
async fn auth_handoff(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AuthQuery>,
) -> Response {
    const AUTH_OK_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Swamp 本地会话同步</title>
  <style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f8fafc;color:#334155;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:15px}a{color:#2563eb}</style>
</head>
<body>
  <div id="msg">正在同步本地会话...</div>
  <script>
    (async function () {
      try { localStorage.removeItem('__swamp_local_token__'); } catch (_) {}
      try { history.replaceState(null, '', '/__auth'); } catch (_) {}
      var hasExisting = false;
      try {
        if (navigator.locks && typeof navigator.locks.query === 'function') {
          var st = await navigator.locks.query();
          if (st && Array.isArray(st.held)) {
            hasExisting = st.held.some(function (l) { return l && l.name === 'swamp_main_tab'; });
          }
        }
      } catch (_) {}
      if (hasExisting) {
        document.getElementById('msg').textContent = '本地会话已同步，正在关闭此页面...';
        try { window.close(); } catch (_) {}
        setTimeout(function () { try { window.close(); } catch (_) {} }, 80);
        setTimeout(function () {
          document.getElementById('msg').innerHTML = '本地会话已同步，切回原标签页即可继续使用（<a href="/">或打开主页</a>）。';
        }, 320);
      } else {
        location.replace('/');
      }
    })();
  </script>
</body>
</html>"#;

    const AUTH_ERR_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Swamp 本地会话无效</title>
  <style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f8fafc;color:#334155;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:15px}a{color:#2563eb}</style>
</head>
<body>
  <div>一次性授权链接已使用或已过期，请在 Swamp 管理窗口重新点击 <b>Open Site</b>（<a href="/">返回主页</a>）。</div>
</body>
</html>"#;

    let code_ok = q
        .code
        .as_deref()
        .map(|c| state.consume_auth_code(c))
        .unwrap_or(false);

    if !code_ok {
        let mut resp = (StatusCode::FORBIDDEN, Html(AUTH_ERR_HTML.to_string())).into_response();
        let headers = resp.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
            ),
        );
        return resp;
    }

    let mut resp = Html(AUTH_OK_HTML.to_string()).into_response();
    let headers = resp.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(cookie_val) = HeaderValue::from_str(&build_session_cookie_header(&state.token)) {
        headers.insert(header::SET_COOKIE, cookie_val);
    }
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
        ),
    );
    resp
}

/// 401 自动续签兜底端点：严格校核同源 Origin + Sec-Fetch-Site + X-Swamp-Client + JSON Content-Type，
/// 单飞弹出本机 Win32 物理确认框（拒绝后 10s 冷却防轰炸），确认后仅通过 Set-Cookie 下发 HttpOnly 会话 Cookie。
async fn api_auth_refresh(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_ascii_lowercase())
        .map(|o| state.allowed_origins.contains(&o))
        .unwrap_or(false);
    if !origin_ok {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "禁止未授权 Origin 请求会话续签" })),
        )
            .into_response();
    }

    if let Some(sfs) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if !sfs.eq_ignore_ascii_case("same-origin") {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "拒绝非同源续签请求" })),
            )
                .into_response();
        }
    }

    let client_ok = headers
        .get(CLIENT_HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim() == CLIENT_HEADER_VALUE)
        .unwrap_or(false);
    if !client_ok {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "缺少或非法的 X-Swamp-Client 请求头" })),
        )
            .into_response();
    }

    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false);
    if !is_json {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "续签请求必须使用 application/json" })),
        )
            .into_response();
    }

    let Ok(mut gate) = auth_refresh_gate().try_lock() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "ok": false, "error": "已有桌面续签确认弹窗等待处理，请先完成当前确认" })),
        )
            .into_response();
    };
    if let Some(approved_at) = gate.last_approved_at {
        if approved_at.elapsed() < Duration::from_secs(3) {
            return session_cookie_json_ok(&state.token);
        }
    }
    if let Some(denied_at) = gate.last_denied_at {
        if denied_at.elapsed() < Duration::from_secs(10) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "刚刚已拒绝授权，请 10 秒后再试或点击 Swamp 管理窗口 Open Site" })),
            )
                .into_response();
        }
    }

    #[cfg(windows)]
    {
        let port = state.config.port;
        let allowed = tokio::task::spawn_blocking(move || {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_YESNO};

            const MB_ICONQUESTION: u32 = 0x0000_0020;
            const MB_SETFOREGROUND: u32 = 0x0001_0000;
            const MB_TOPMOST: u32 = 0x0004_0000;

            let msg = format!(
                "本地页面 (localhost:{}) 请求更新本地会话授权。\n\n如为本人正在执行保存或编辑操作，请选择“是”放行；否则选择“否”。",
                port
            );
            let mw: Vec<u16> = OsStr::new(&msg).encode_wide().chain(Some(0)).collect();
            let tw: Vec<u16> = OsStr::new("更新本地会话确认")
                .encode_wide()
                .chain(Some(0))
                .collect();
            unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    mw.as_ptr(),
                    tw.as_ptr(),
                    MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND,
                ) == IDYES
            }
        })
        .await
        .unwrap_or(false);

        if allowed {
            gate.last_approved_at = Some(Instant::now());
            gate.last_denied_at = None;
            state.logs.info("[auth] 已放行本地页面的会话续签请求");
            return session_cookie_json_ok(&state.token);
        } else {
            gate.last_denied_at = Some(Instant::now());
            state.logs.warn("[auth] 已拒绝本地页面的会话续签请求");
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "已拒绝本地会话续签请求" })),
            )
                .into_response();
        }
    }

    #[cfg(not(windows))]
    {
        gate.last_denied_at = Some(Instant::now());
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "请重新启动服务并通过 Open Site 打开首页" })),
        )
            .into_response()
    }
}

fn is_valid_token_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn take_handoff_token_from_env() -> Option<String> {
    let raw = std::env::var("SWAMP_HANDOFF_TOKEN").ok();
    // 立即从当前进程环境块抹除，杜绝泄露给后续派生的任何子进程
    std::env::remove_var("SWAMP_HANDOFF_TOKEN");
    raw.map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| is_valid_token_hex(s))
}

fn build_router(mode: RunMode, state: Arc<AppState>) -> Router {
    match mode {
        RunMode::Serve => {
            let api_router = Router::new()
                .route("/health", get(api_health))
                .route("/tasks", get(api_get_tasks))
                .route("/files/html", put(api_files::put_html))
                .route("/files/md", put(api_files::put_md))
                .route("/bookmarks", post(api_files::post_bookmark))
                .route("/ops/edit", post(api_ops::post_edit))
                .route("/ops/watch-html", get(api_ops::get_watch_html))
                .route("/ops/explorer", post(api_ops::post_explorer))
                .route("/ops/cli", post(api_ops::post_cli))
                .route("/ops/txn", post(api_ops::post_txn))
                .route("/ops/katrain", post(api_ops::post_katrain))
                .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    api_auth_middleware,
                ));

            Router::new()
                .route("/__auth", get(auth_handoff))
                .route("/__auth/refresh", post(api_auth_refresh))
                .route("/__oauth/callback", get(oauth_callback))
                .nest("/__api", api_router)
                .fallback(static_fs::handle_static)
                .layer(middleware::from_fn(security_headers_middleware))
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    host_guard_middleware,
                ))
                .with_state(state)
        }
        RunMode::Sim => Router::new()
            .fallback(static_fs::handle_static)
            .layer(middleware::from_fn(security_headers_middleware))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                host_guard_middleware,
            ))
            .with_state(state),
    }
}

fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let log_dir = dir.join("temp").join("backup");
                let _ = std::fs::create_dir_all(&log_dir);
                let msg = format!(
                    "[{}] PANIC: {}\n",
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                    info
                );
                let _ = std::fs::write(log_dir.join("swamp_panic.log"), msg);
            }
        }
    }));
}

fn main() {
    install_panic_logger();
    attach_parent_console_if_cli();

    let cli = match parse_cli_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[swamp] {}", e);
            std::process::exit(2);
        }
    };

    if matches!(cli.cmd, SubCommand::SelfTest) {
        if let Err(e) = run_selftest() {
            eprintln!("[swamp] {}", e);
            std::process::exit(1);
        }
        return;
    }

    if let SubCommand::Minify { input, output } = cli.cmd {
        let raw = match std::fs::read_to_string(&input) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[swamp minify] 读取 {} 失败: {}", input.display(), e);
                std::process::exit(1);
            }
        };
        let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
        let is_css = input
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("css"))
            .unwrap_or(false);
        let minified = if is_css {
            builder::minify::minify_css(clean)
        } else {
            match builder::minify::minify_js(clean) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[swamp minify] 压缩失败: {}", e);
                    std::process::exit(1);
                }
            }
        };
        if let Err(e) = api_files::write_atomic(&output, &minified, false) {
            eprintln!("[swamp minify] 写出 {} 失败: {}", output.display(), e);
            std::process::exit(1);
        }
        println!("[swamp minify] {} -> {} ({} B)", input.display(), output.display(), minified.len());
        return;
    }

    let is_sim = matches!(cli.cmd, SubCommand::Sim);
    let cfg = match ServerConfig::load(cli.root, cli.port, cli.log_level, is_sim) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[swamp] 配置加载失败: {}", e);
            std::process::exit(1);
        }
    };

    match cli.cmd {
        SubCommand::Gen => {
            if let Err(e) = builder::run_gen(&cfg) {
                eprintln!("[swamp gen] 构建失败: {}", e);
                std::process::exit(1);
            }
            return;
        }
        SubCommand::Synonyms => {
            if let Err(e) = builder::run_gen_with_options(&cfg, None, true) {
                eprintln!("[swamp synonyms] 强制重建同义词与全量构建失败: {}", e);
                std::process::exit(1);
            }
            return;
        }
        SubCommand::Bookmark { block, title, href } => {
            if let Err(e) = builder::html_utils::update_bookmark(&cfg, &block, &title, &href) {
                eprintln!("[swamp bookmark] 失败: {}", e);
                std::process::exit(1);
            }
            println!("[swamp bookmark] 已更新 bookmark.html");
            return;
        }
        SubCommand::New {
            title,
            category,
            open_editor,
        } => {
            let final_title = match title {
                Some(t) if !t.trim().is_empty() => t.trim().to_string(),
                _ => loop {
                    match prompt_line("title: ") {
                        Ok(t) if t.is_empty() => println!("need title!"),
                        Ok(t) if cfg.html_dir.join(format!("{}.html", t)).exists() => {
                            println!("title existed!");
                        }
                        Ok(t) => break t,
                        Err(e) => {
                            eprintln!("{}", e);
                            std::process::exit(1);
                        }
                    }
                },
            };
            let final_cat = match category {
                Some(c) if !c.trim().is_empty() => c.trim().to_string(),
                _ => loop {
                    match prompt_line("category: ") {
                        Ok(c) if c.is_empty() => println!("need category!"),
                        Ok(c) => break c,
                        Err(e) => {
                            eprintln!("{}", e);
                            std::process::exit(1);
                        }
                    }
                },
            };
            match builder::html_utils::create_new_html(&cfg, &final_title, &final_cat) {
                Ok(created_path) => {
                    let clean = strip_verbatim_prefix(&created_path);
                    println!("[swamp new] 已创建 {}", clean.display());
                    if open_editor {
                        let args = vec![clean.to_string_lossy().into_owned()];
                        if let Err(e) = api_ops::spawn_vscode(&cfg.vscode_path, &args) {
                            eprintln!("[swamp new] {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[swamp new] 创建失败: {}", e);
                    std::process::exit(1);
                }
            }
            return;
        }
        SubCommand::Webp {
            max_width,
            quality,
            alt_dir,
            update_mapping,
        } => {
            match run_webp_batch(
                &cfg,
                WebpOptions {
                    max_width,
                    quality,
                    use_alt_output: alt_dir,
                    update_img_mapping: update_mapping,
                },
            ) {
                Ok(s) => {
                    println!(
                        "[swamp webp] 完成: 成功 {}/{} | {:.2}MB -> {:.2}MB | 更新HTML: {} | 剪贴板: {} | {}ms",
                        s.success_count,
                        s.total_images,
                        s.original_bytes as f64 / 1048576.0,
                        s.webp_bytes as f64 / 1048576.0,
                        s.updated_html_count,
                        if s.clipboard_copied { "已复制" } else { "未复制" },
                        s.elapsed_ms
                    );
                }
                Err(e) => {
                    eprintln!("[swamp webp] 失败: {}", e);
                    std::process::exit(1);
                }
            }
            return;
        }
        SubCommand::Keep2Html {
            mode,
            tag_name,
            category,
        } => {
            match run_keep2html(
                &cfg,
                KeepOptions {
                    mode,
                    tag_name,
                    category,
                },
            ) {
                Ok(s) => {
                    println!(
                        "[swamp keep2html] 完成 ({}): 生成 {} 篇, 图片 {} 张",
                        s.zip_file,
                        s.generated_pages.len(),
                        s.processed_images
                    );
                }
                Err(e) => {
                    eprintln!("[swamp keep2html] 失败: {}", e);
                    std::process::exit(1);
                }
            }
            return;
        }
        SubCommand::InitUpstream => {
            match services::upstream_sync::init_upstream(&cfg, None) {
                Ok(s) => {
                    println!(
                        "[swamp init-upstream] 成功: 远端 {}/{} = {}, 本地锚点 = {}, 骨架文件 {} 个",
                        s.remote, s.branch, s.upstream_commit, s.anchor_commit, s.skeleton_count
                    );
                }
                Err(e) => {
                    eprintln!("[swamp init-upstream] 失败: {}", e);
                    std::process::exit(1);
                }
            }
            return;
        }
        SubCommand::PullUpstream => {
            match services::upstream_sync::pull_upstream(&cfg, None) {
                Ok(services::upstream_sync::PullUpstreamOutcome::UpToDate { remote, branch }) => {
                    println!("[swamp pull-upstream] 已与 {}/{} 保持最新", remote, branch);
                }
                Ok(services::upstream_sync::PullUpstreamOutcome::Merged {
                    remote,
                    branch,
                    merged_files,
                    protected_user_files,
                    need_exe,
                    need_wasm,
                    need_gen,
                    ..
                }) => {
                    println!(
                        "[swamp pull-upstream] 合并完成 ({}/{}): 更新 {} 个文件，保护 {} 个用户文件",
                        remote,
                        branch,
                        merged_files.len(),
                        protected_user_files.len()
                    );
                    if need_wasm {
                        println!("  -> 涉及 lib.rs，请运行 build.bat 选 [2] 或 [3] 重编 Wasm 后执行 gen");
                    } else if need_exe {
                        println!("  -> 涉及 Rust 源码，请运行 build.bat 选 [1] 重编 swamp.exe");
                    }
                    if need_gen {
                        println!("  -> 涉及前端/配置，请运行 swamp gen 刷新构建产物");
                    }
                }
                Ok(services::upstream_sync::PullUpstreamOutcome::Conflicts {
                    conflict_files, ..
                }) => {
                    eprintln!(
                        "[swamp pull-upstream] 合并存在骨架代码冲突，请手动解决后 git commit:\n  {}",
                        conflict_files.join("\n  ")
                    );
                    std::process::exit(2);
                }
                Err(e) => {
                    eprintln!("[swamp pull-upstream] 失败: {}", e);
                    std::process::exit(1);
                }
            }
            return;
        }
        SubCommand::Serve => {
            run_server_mode(cfg, RunMode::Serve, cli.open_browser);
        }
        SubCommand::Sim => {
            run_server_mode(cfg, RunMode::Sim, cli.open_browser);
        }
        SubCommand::SelfTest | SubCommand::Minify { .. } => {}
    }
}

/// 一次性静默迁移：将旧版留在 _build/temp/backup/ 下的三个构建状态文件挪至 _build/temp/
fn migrate_legacy_temp_files(cfg: &ServerConfig, logs: &LogBus) {
    let pairs = [
        ("build_hashes.txt", &cfg.build_hashes_file),
        ("oov_report.txt", &cfg.oov_report_file),
        ("synonyms.sha256", &cfg.synonyms_sha_file),
    ];
    for (name, dest) in pairs {
        let old = cfg.backup_dir.join(name);
        if !old.is_file() || dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let moved = std::fs::rename(&old, dest).is_ok()
            || (std::fs::copy(&old, dest).is_ok() && std::fs::remove_file(&old).is_ok());
        if moved {
            logs.info(format!("[startup] 已迁移 {} -> _build/temp/{}", name, name));
        }
    }
}

fn run_server_mode(cfg: ServerConfig, mode: RunMode, open_browser: bool) {
    let is_sim = mode == RunMode::Sim;

    let (token, inherited_token) = if is_sim {
        // sim 模式也顺手清掉可能残留的环境变量
        std::env::remove_var("SWAMP_HANDOFF_TOKEN");
        (String::new(), false)
    } else if let Some(handoff_tok) = take_handoff_token_from_env() {
        (handoff_tok, true)
    } else {
        match generate_token_hex() {
            Ok(t) => (t, false),
            Err(e) => {
                eprintln!("[swamp] {}", e);
                std::process::exit(1);
            }
        }
    };

    let (log_msg, vpn_msg) = if cfg!(windows) {
        (WM_APP_LOG, WM_APP_VPN)
    } else {
        (0, 0)
    };

    let logs = if is_sim {
        Arc::new(LogBus::new(log_msg))
    } else {
        let log_file = cfg.build_dir.join("temp").join("swamp_runtime.log");
        Arc::new(LogBus::with_file(log_msg, log_file))
    };
    let runtime = Arc::new(RuntimeStatus::new(vpn_msg));
    let shutdown_notify = Arc::new(Notify::new());
    let (html_change_tx, _) = tokio::sync::broadcast::channel::<String>(64);

    let port = cfg.port;
    let verbose = cfg.log_level == "info" || cfg.log_level == "debug";
    let allowed_origins = build_allowed_origins(port);
    let allowed_hosts = build_allowed_hosts(port);
    let sim_gitignore = if is_sim && cfg.gitignore_file.is_file() {
        let mut b = ignore::gitignore::GitignoreBuilder::new(&cfg.repo_root);
        if b.add(&cfg.gitignore_file).is_none() {
            b.build().ok()
        } else {
            None
        }
    } else {
        None
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("创建 Tokio 运行时失败");

    let state = Arc::new(AppState {
        mode,
        config: cfg.clone(),
        token: token.clone(),
        auth_codes: AuthCodeStore::new(),
        allowed_origins,
        allowed_hosts,
        verbose,
        logs: logs.clone(),
        runtime: runtime.clone(),
        html_change_tx: html_change_tx.clone(),
        shutdown_notify: shutdown_notify.clone(),
        shutting_down: AtomicBool::new(false),
        sim_gitignore,
        rt_handle: rt.handle().clone(),
    });

    let (ready_tx, ready_rx) = std_mpsc::channel::<Result<(), String>>();

    let state_bg = state.clone();
    let cfg_bg = cfg.clone();
    let logs_bg = logs.clone();
    let runtime_bg = runtime.clone();
    let shutdown_bg = shutdown_notify.clone();

    let server_handle = std::thread::spawn(move || {
        rt.block_on(async move {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            let listener = match TcpListener::bind(addr).await {
                Ok(l) => {
                    let _ = ready_tx.send(Ok(()));
                    l
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("绑定 {} 失败: {}", addr, e)));
                    return;
                }
            };

            let mode_label = if is_sim { "sim" } else { "serve" };
            logs_bg.info(format!(
                "[swamp] mode={} addr=http://{} root={}",
                mode_label,
                addr,
                strip_verbatim_prefix(&cfg_bg.repo_root).display()
            ));
            if inherited_token {
                logs_bg.info("[auth] 已沿用上一进程的会话令牌");
            }

            if !is_sim {
                migrate_legacy_temp_files(&cfg_bg, &logs_bg);
                match crate::builder::minify::sync_raw_assets_on_startup(&cfg_bg) {
                    Ok(n) if n > 0 => {
                        logs_bg.info(format!("[startup] 启动时同步压缩了 {} 个前端文件", n));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        logs_bg.warn(format!("[startup] 启动同步前端文件失败: {}", e));
                    }
                }
                let _ = std::fs::remove_dir_all(cfg_bg.build_dir.join("temp").join("diff_preview"));
                spawn_asset_watcher(cfg_bg.clone(), logs_bg.clone(), state_bg.html_change_tx.clone());
                spawn_background_monitors(cfg_bg.clone(), runtime_bg, logs_bg.clone());
            }

            let state_for_shutdown = state_bg.clone();
            let app = build_router(mode, state_bg);

            let shutdown_fut = async move {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {
                        state_for_shutdown.shutting_down.store(true, Ordering::SeqCst);
                        shutdown_bg.notify_waiters();
                    }
                    _ = shutdown_bg.notified() => {
                        state_for_shutdown.shutting_down.store(true, Ordering::SeqCst);
                    }
                }
            };

            if let Err(e) = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown_fut)
                .await
            {
                logs_bg.error(format!("[swamp] 服务运行异常: {}", e));
            }
        });
        rt.shutdown_timeout(std::time::Duration::from_millis(500));
    });

    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            #[cfg(windows)]
            {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    MessageBoxW, MB_ICONERROR, MB_OK,
                };
                let mw: Vec<u16> = OsStr::new(&format!(
                    "无法启动服务：\n{}\n\n请检查端口是否被占用，或是否已运行另一个 swamp.exe。",
                    e
                ))
                .encode_wide()
                .chain(Some(0))
                .collect();
                let tw: Vec<u16> = OsStr::new("启动失败")
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                unsafe {
                    MessageBoxW(
                        std::ptr::null_mut(),
                        mw.as_ptr(),
                        tw.as_ptr(),
                        MB_OK | MB_ICONERROR,
                    );
                }
            }
            eprintln!("[swamp] {}", e);
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("[swamp] 服务线程意外退出");
            std::process::exit(1);
        }
    }

    if open_browser {
        let url = match mode {
            RunMode::Serve => match state.issue_auth_code() {
                Ok(code) => format!("http://localhost:{}/__auth?code={}", port, code),
                Err(_) => format!("http://localhost:{}", port),
            },
            RunMode::Sim => format!("http://localhost:{}", port),
        };
        open_url_in_browser(&url, is_sim);
    }

    #[cfg(windows)]
    let handoff_build = if !is_sim {
        run_management_window(state, shutdown_notify)
    } else {
        None
    };

    let _ = server_handle.join();

    // 直到管理窗口销毁、后台任务归零、HTTP 服务与运行时全部彻底退出后，再接力拉起 build.bat
    #[cfg(windows)]
    if let Some((crate_dir, build_bat)) = handoff_build {
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(0xFFFF_FFFF);
        }
        let _ = Command::new("cmd.exe")
            .arg("/d")
            .arg("/c")
            .arg(&build_bat)
            .current_dir(&crate_dir)
            .env("SWAMP_HANDOFF_TOKEN", &token)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn();
    }
}
