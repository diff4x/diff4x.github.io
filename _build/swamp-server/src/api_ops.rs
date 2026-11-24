use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Local;
use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::api_files::write_atomic;
use crate::builder::minify::sha256_hex;
use crate::config::strip_verbatim_prefix;
use crate::security::{validate_title, AppState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
pub struct EditReq {
    pub title: String,
}

#[derive(Deserialize)]
pub struct WatchHtmlQuery {
    pub title: String,
    #[serde(default)]
    pub sig: String,
}

#[derive(Deserialize)]
pub struct CliReq {
    pub cmd: String,
}

#[derive(Deserialize)]
pub struct TxnReq {
    pub line: u32,
}

fn err_resp(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "ok": false, "error": msg.into() }))).into_response()
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(sha256_hex(&bytes))
}

#[cfg(windows)]
mod win_focus {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GetForegroundWindow,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    const ASFW_ANY: u32 = 0xFFFF_FFFF;
    const VK_MENU_U8: u8 = 0x12;

    struct SearchCtx {
        required_lower: String,
        preferred_lower: Option<String>,
        best_match: HWND,
        fallback_match: HWND,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
        if copied <= 0 {
            return 1;
        }
        let title_lower = String::from_utf16_lossy(&buf[..copied as usize]).to_ascii_lowercase();
        let ctx = &mut *(lparam as *mut SearchCtx);
        if !title_lower.contains(&ctx.required_lower) {
            return 1;
        }
        if let Some(ref pref) = ctx.preferred_lower {
            if !pref.is_empty() && title_lower.contains(pref) {
                ctx.best_match = hwnd;
                return 0; // 找到精准匹配，提前结束枚举
            }
        }
        if ctx.fallback_match.is_null() {
            ctx.fallback_match = hwnd;
        }
        1
    }

    pub fn allow_foreground_any() {
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
        }
    }

    pub fn find_window(required_lower: &str, preferred_lower: Option<&str>) -> Option<HWND> {
        let mut ctx = SearchCtx {
            required_lower: required_lower.to_ascii_lowercase(),
            preferred_lower: preferred_lower.map(|s| s.to_ascii_lowercase()),
            best_match: std::ptr::null_mut(),
            fallback_match: std::ptr::null_mut(),
        };
        unsafe {
            EnumWindows(Some(enum_proc), &mut ctx as *mut SearchCtx as LPARAM);
        }
        if !ctx.best_match.is_null() {
            Some(ctx.best_match)
        } else if !ctx.fallback_match.is_null() {
            Some(ctx.fallback_match)
        } else {
            None
        }
    }

    pub fn force_foreground(hwnd: HWND) {
        if hwnd.is_null() {
            return;
        }
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            let fg = GetForegroundWindow();
            if fg == hwnd {
                return;
            }
            let cur_tid = GetCurrentThreadId();
            let fg_tid = if !fg.is_null() {
                GetWindowThreadProcessId(fg, std::ptr::null_mut())
            } else {
                0
            };
            let target_tid = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());

            let attached_fg = fg_tid != 0 && fg_tid != cur_tid && AttachThreadInput(cur_tid, fg_tid, 1) != 0;
            let attached_tgt =
                target_tid != 0 && target_tid != cur_tid && AttachThreadInput(cur_tid, target_tid, 1) != 0;

            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);

            if GetForegroundWindow() != hwnd {
                // Alt 键轻触解除 Windows 前景焦点锁兜底
                keybd_event(VK_MENU_U8, 0, 0, 0);
                keybd_event(VK_MENU_U8, 0, KEYEVENTF_KEYUP, 0);
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }

            if attached_tgt {
                AttachThreadInput(cur_tid, target_tid, 0);
            }
            if attached_fg {
                AttachThreadInput(cur_tid, fg_tid, 0);
            }
        }
    }

    /// 后台轮询匹配目标窗口并强制切换至前台
    pub fn focus_window_async(
        required_substr: &str,
        preferred_substr: Option<String>,
        initial_delay_ms: u64,
        max_attempts: usize,
        interval_ms: u64,
    ) {
        let req = required_substr.to_ascii_lowercase();
        let pref = preferred_substr.map(|s| s.to_ascii_lowercase());
        std::thread::spawn(move || {
            if initial_delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(initial_delay_ms));
            }
            for attempt in 0..max_attempts {
                // 前 2 次优先等精准匹配（如刚切过去的目标文件名），之后允许回退主窗口
                let found = if let Some(ref p) = pref {
                    let mut ctx = SearchCtx {
                        required_lower: req.clone(),
                        preferred_lower: Some(p.clone()),
                        best_match: std::ptr::null_mut(),
                        fallback_match: std::ptr::null_mut(),
                    };
                    unsafe {
                        EnumWindows(Some(enum_proc), &mut ctx as *mut SearchCtx as LPARAM);
                    }
                    if !ctx.best_match.is_null() {
                        Some(ctx.best_match)
                    } else if attempt >= 2 && !ctx.fallback_match.is_null() {
                        Some(ctx.fallback_match)
                    } else {
                        None
                    }
                } else {
                    find_window(&req, None)
                };

                if let Some(hwnd) = found {
                    force_foreground(hwnd);
                    return;
                }
                std::thread::sleep(Duration::from_millis(interval_ms));
            }
        });
    }
}

fn extract_filename_hint(args: &[String]) -> Option<String> {
    let raw = args.iter().rev().find(|a| !a.starts_with('-'))?;
    // 兼容 `-g path/to/txn.txt:128` 剥离末尾行号
    let cleaned = match raw.rfind(':') {
        Some(pos) if pos > 2 && raw[pos + 1..].chars().all(|c| c.is_ascii_digit()) => &raw[..pos],
        _ => raw.as_str(),
    };
    Path::new(cleaned)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

pub fn spawn_vscode(vscode_path: &str, args: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_focus::allow_foreground_any();
        let is_exe = vscode_path.to_ascii_lowercase().ends_with(".exe");
        let mut cmd = if is_exe {
            // Code.exe 本身是 GUI 子系统，不加 CREATE_NO_WINDOW 以保留原生前景激活权限
            let mut c = Command::new(vscode_path);
            c.args(args);
            c
        } else {
            let mut c = Command::new("cmd");
            c.arg("/d").arg("/c").arg(vscode_path).args(args);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        cmd.spawn()
            .map_err(|e| format!("拉起 VS Code 失败 ({}): {}", vscode_path, e))?;

        let hint = extract_filename_hint(args);
        win_focus::focus_window_async("visual studio code", hint, 160, 18, 160);
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        Command::new(vscode_path)
            .args(args)
            .spawn()
            .map_err(|e| format!("拉起 VS Code 失败 ({}): {}", vscode_path, e))?;
        Ok(())
    }
}

pub async fn post_edit(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EditReq>,
) -> Response {
    let _busy = state.runtime.begin_op();
    let title = req.title.trim();
    if !validate_title(title) {
        return err_resp(StatusCode::BAD_REQUEST, "非法页面标题");
    }

    let candidate = state.config.html_dir.join(format!("{}.html", title));
    let target = match std::fs::canonicalize(&candidate) {
        Ok(p) if p.is_file() && p.starts_with(&state.config.html_dir) => p,
        _ => return err_resp(StatusCode::NOT_FOUND, "目标 HTML 页面不存在"),
    };

    let ts = Local::now().format("%Y%m%d%H%M%S").to_string();
    match std::fs::read(&target) {
        Ok(raw_bytes) => {
            let has_bom = raw_bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
            let slice = if has_bom { &raw_bytes[3..] } else { &raw_bytes[..] };
            if let Ok(text) = std::str::from_utf8(slice) {
                static ANCHOR_RE: OnceLock<Regex> = OnceLock::new();
                let re = ANCHOR_RE.get_or_init(|| {
                    Regex::new(r#"<span id="anchor">(\d{14})-(.*?)</span>"#).unwrap()
                });
                if re.is_match(text) {
                    let updated = re.replace(text, |caps: &Captures| {
                        format!(r#"<span id="anchor">{}-{}</span>"#, ts, &caps[2])
                    });
                    if let Err(e) = write_atomic(&target, updated.as_ref(), has_bom) {
                        return err_resp(StatusCode::INTERNAL_SERVER_ERROR, e);
                    }
                }
            }
        }
        Err(e) => {
            return err_resp(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("读取目标 HTML 失败: {}", e),
            );
        }
    }

    let sig = file_sha256(&target).unwrap_or_default();
    let clean_target = strip_verbatim_prefix(&target);
    let args = vec![clean_target.to_string_lossy().into_owned()];
    if let Err(e) = spawn_vscode(&state.config.vscode_path, &args) {
        return err_resp(StatusCode::INTERNAL_SERVER_ERROR, e);
    }

    state
        .logs
        .info(format!("[api] 已打开编辑: {}.html（开启保存实时监听）", title));
    Json(json!({ "ok": true, "timestamp": ts, "sig": sig })).into_response()
}

/// GET /__api/ops/watch-html?title=...&sig=...
/// 长轮询监听当前编辑中的 HTML 文件：收到 watcher 变更广播或 2s 兜底检测到 SHA-256 变化立即返回
pub async fn get_watch_html(
    State(state): State<Arc<AppState>>,
    Query(q): Query<WatchHtmlQuery>,
) -> Response {
    let title = q.title.trim();
    if !validate_title(title) {
        return err_resp(StatusCode::BAD_REQUEST, "非法页面标题");
    }

    let candidate = state.config.html_dir.join(format!("{}.html", title));
    let target = match std::fs::canonicalize(&candidate) {
        Ok(p) if p.is_file() && p.starts_with(&state.config.html_dir) => p,
        _ => return err_resp(StatusCode::NOT_FOUND, "目标 HTML 页面不存在"),
    };

    let baseline = q.sig.trim().to_string();
    if let Ok(cur) = file_sha256(&target) {
        if !baseline.is_empty() && cur != baseline {
            return Json(json!({ "ok": true, "changed": true, "sig": cur })).into_response();
        }
    }

    let target_stem_lower = title.to_lowercase();
    let mut rx = state.html_change_tx.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let mut fallback = tokio::time::interval(Duration::from_secs(2));
    fallback.tick().await; // 跳过首次立即触发

    loop {
        tokio::select! {
            _ = state.shutdown_notify.notified() => {
                return Json(json!({ "ok": true, "changed": false, "sig": baseline })).into_response();
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Json(json!({ "ok": true, "changed": false, "sig": baseline })).into_response();
            }
            ev = rx.recv() => {
                let matched = match ev {
                    Ok(changed_stem) => changed_stem == target_stem_lower,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Json(json!({ "ok": true, "changed": false, "sig": baseline })).into_response();
                    }
                };
                if matched {
                    // 等待 120ms 让编辑器彻底刷盘，避免读到半截内容或空保存误刷新
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    if let Ok(new_sig) = file_sha256(&target) {
                        if new_sig != baseline {
                            return Json(json!({ "ok": true, "changed": true, "sig": new_sig })).into_response();
                        }
                    }
                }
            }
            _ = fallback.tick() => {
                if let Ok(new_sig) = file_sha256(&target) {
                    if !baseline.is_empty() && new_sig != baseline {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        let final_sig = file_sha256(&target).unwrap_or(new_sig);
                        return Json(json!({ "ok": true, "changed": true, "sig": final_sig })).into_response();
                    }
                }
            }
        }
    }
}

pub async fn post_explorer(State(state): State<Arc<AppState>>) -> Response {
    let root = strip_verbatim_prefix(&state.config.repo_root);
    let res = {
        #[cfg(windows)]
        {
            win_focus::allow_foreground_any();
            Command::new("explorer.exe").arg(&root).spawn()
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(&root).spawn()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Command::new("xdg-open").arg(&root).spawn()
        }
    };

    match res {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("打开目录失败: {}", e),
        ),
    }
}

pub async fn post_cli(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CliReq>,
) -> Response {
    let mode = req.cmd.trim();
    if mode != "gen" {
        return err_resp(StatusCode::BAD_REQUEST, "仅支持 gen");
    }

    let state_clone = state.clone();
    let res = tokio::task::spawn_blocking(move || {
        let _busy = state_clone.runtime.begin_op();
        state_clone.logs.info("[api] 开始纯 Rust 全量构建...");
        crate::builder::run_gen(&state_clone.config)
    })
    .await;

    match res {
        Ok(Ok(())) => {
            state.logs.info("[api] 纯 Rust 全量构建完成！");
            Json(json!({ "ok": true })).into_response()
        }
        Ok(Err(e)) => {
            state.logs.error(format!("[api] 构建失败: {}", e));
            err_resp(StatusCode::INTERNAL_SERVER_ERROR, e)
        }
        Err(e) => err_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("构建任务异常中止: {}", e),
        ),
    }
}

pub async fn post_txn(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TxnReq>,
) -> Response {
    if req.line == 0 || req.line > 9_999_999 {
        return err_resp(StatusCode::BAD_REQUEST, "非法行号");
    }

    let txn_path = state.config.privy_dir.join("txn.txt");
    if !txn_path.is_file() {
        return err_resp(StatusCode::NOT_FOUND, "找不到 _build/privy/txn.txt");
    }

    let clean_txn = strip_verbatim_prefix(&txn_path);
    let target_arg = format!("{}:{}", clean_txn.to_string_lossy(), req.line);
    let args = vec!["-g".to_string(), target_arg];

    if let Err(e) = spawn_vscode(&state.config.vscode_path, &args) {
        return err_resp(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    Json(json!({ "ok": true })).into_response()
}

pub async fn post_katrain(State(state): State<Arc<AppState>>) -> Response {
    #[cfg(windows)]
    {
        // 若 KaTrain 已打开，直接切至前台，不重复启动多实例
        if let Some(hwnd) = win_focus::find_window("katrain", None) {
            win_focus::force_foreground(hwnd);
            return Json(json!({ "ok": true, "focused": true })).into_response();
        }
    }

    let dir_str = state.config.katrain_dir.trim();
    if dir_str.is_empty() {
        return err_resp(
            StatusCode::BAD_REQUEST,
            "未在 _build/privy/local.toml 或 local.properties 配置 katrain_dir",
        );
    }
    let dir = Path::new(dir_str);
    if !dir.is_dir() {
        return err_resp(
            StatusCode::NOT_FOUND,
            format!("katrain_dir 目录不存在: {}", dir_str),
        );
    }

    #[cfg(windows)]
    win_focus::allow_foreground_any();

    let mut cmd = Command::new("uv");
    cmd.args(["run", "python", "-m", "katrain"])
        .current_dir(dir);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(_) => {
            #[cfg(windows)]
            win_focus::focus_window_async("katrain", None, 400, 40, 300);
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => err_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("启动 KaTrain 失败: {}", e),
        ),
    }
}
