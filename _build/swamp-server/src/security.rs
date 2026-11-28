//! 本地服务安全守卫：Host 白名单、双阶段静态路径校验、HttpOnly Cookie 五重鉴权与内置自检套件。

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use percent_encoding::percent_decode_str;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;
use crate::services::tasks::RuntimeStatus;

pub const CSP_HEADER_VALUE: &str = "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://giscus.app; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self';";
pub const SESSION_COOKIE_NAME: &str = "swamp_session";
pub const CLIENT_HEADER_NAME: &str = "x-swamp-client";
pub const CLIENT_HEADER_VALUE: &str = "1";
const AUTH_CODE_TTL: Duration = Duration::from_secs(60);
const MAX_AUTH_CODES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunMode {
    Serve,
    Sim,
}

/// 一次性短时引导码池：用于 Open Site / --open 换取 HttpOnly 会话 Cookie，单次消费且 60s 过期
pub struct AuthCodeStore {
    entries: Mutex<Vec<(String, Instant)>>,
}

impl AuthCodeStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }

    pub fn issue(&self) -> Result<String, String> {
        let code = generate_token_hex()?;
        let now = Instant::now();
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|(_, ts)| now.saturating_duration_since(*ts) < AUTH_CODE_TTL);
        while guard.len() >= MAX_AUTH_CODES {
            guard.remove(0);
        }
        guard.push((code.clone(), now));
        Ok(code)
    }

    pub fn consume(&self, raw_code: &str) -> bool {
        let candidate = raw_code.trim().to_ascii_lowercase();
        if candidate.len() != 64 || !candidate.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let now = Instant::now();
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|(_, ts)| now.saturating_duration_since(*ts) < AUTH_CODE_TTL);
        let mut hit_idx: Option<usize> = None;
        for (idx, (stored, _)) in guard.iter().enumerate() {
            if bool::from(stored.as_bytes().ct_eq(candidate.as_bytes())) && hit_idx.is_none() {
                hit_idx = Some(idx);
            }
        }
        if let Some(idx) = hit_idx {
            guard.swap_remove(idx);
            true
        } else {
            false
        }
    }
}

pub struct AppState {
    pub mode: RunMode,
    pub config: ServerConfig,
    pub live_sim_port: AtomicU16,
    pub token: String,
    pub auth_codes: AuthCodeStore,
    pub allowed_origins: Vec<String>,
    pub allowed_hosts: Vec<String>,
    pub verbose: bool,
    pub logs: Arc<LogBus>,
    pub runtime: Arc<RuntimeStatus>,
    pub html_change_tx: tokio::sync::broadcast::Sender<String>,
    pub shutdown_notify: Arc<tokio::sync::Notify>,
    pub shutting_down: AtomicBool,
    pub sim_gitignore: Option<ignore::gitignore::Gitignore>,
    pub rt_handle: tokio::runtime::Handle,
}

impl AppState {
    pub fn current_sim_port(&self) -> u16 {
        let p = self.live_sim_port.load(Ordering::Relaxed);
        if p > 0 { p } else { self.config.sim_port }
    }

    pub fn set_live_sim_port(&self, sim_port: u16) {
        if sim_port > 0 {
            self.live_sim_port.store(sim_port, Ordering::Relaxed);
        }
    }

    pub fn effective_config(&self) -> ServerConfig {
        let mut c = self.config.clone();
        c.sim_port = self.current_sim_port();
        c
    }

    pub fn issue_auth_code(&self) -> Result<String, String> {
        self.auth_codes.issue()
    }

    pub fn consume_auth_code(&self, code: &str) -> bool {
        self.auth_codes.consume(code)
    }
}

pub fn build_session_cookie_header(token: &str) -> String {
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict",
        SESSION_COOKIE_NAME, token
    )
}

pub fn extract_cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == name {
                return Some(v.trim());
            }
        }
    }
    None
}

fn extract_session_cookie_from_headers(headers: &HeaderMap) -> Option<String> {
    for hv in headers.get_all(header::COOKIE) {
        if let Ok(raw) = hv.to_str() {
            if let Some(val) = extract_cookie_value(raw, SESSION_COOKIE_NAME) {
                return Some(val.to_string());
            }
        }
    }
    None
}

pub fn generate_token_hex() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("生成随机令牌失败: {}", e))?;
    let mut hex = String::with_capacity(64);
    for b in buf {
        hex.push_str(&format!("{:02x}", b));
    }
    Ok(hex)
}

pub fn build_allowed_origins(port: u16) -> Vec<String> {
    if port == 80 {
        vec![
            "http://localhost".to_string(),
            "http://127.0.0.1".to_string(),
            "http://localhost:80".to_string(),
            "http://127.0.0.1:80".to_string(),
        ]
    } else {
        vec![
            format!("http://localhost:{}", port),
            format!("http://127.0.0.1:{}", port),
        ]
    }
}

pub fn build_allowed_hosts(port: u16) -> Vec<String> {
    if port == 80 {
        vec![
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "localhost:80".to_string(),
            "127.0.0.1:80".to_string(),
        ]
    } else {
        vec![
            format!("localhost:{}", port),
            format!("127.0.0.1:{}", port),
        ]
    }
}

pub fn validate_host_header(raw_host: &str, allowed_hosts: &[String]) -> bool {
    let h = raw_host.trim().to_ascii_lowercase();
    !h.is_empty() && allowed_hosts.iter().any(|a| a == &h)
}

pub fn is_windows_reserved_device_name(seg: &str) -> bool {
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn is_short_name_segment(seg: &str) -> bool {
    seg.as_bytes()
        .windows(2)
        .any(|w| w[0] == b'~' && w[1].is_ascii_digit())
}

pub fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| (c as u32) <= 0x1F || (c as u32) == 0x7F)
}

/// 静态资源路径守卫（未解码 URL 入口）：单次解码后委托 validate_decoded_static_path
pub fn validate_static_request_path(raw_path: &str, mode: RunMode) -> Option<Vec<String>> {
    if raw_path.is_empty() || raw_path.len() > 2048 || has_control_chars(raw_path) {
        return None;
    }
    if raw_path.contains('\\') {
        return None;
    }

    let decoded = percent_decode_str(raw_path).decode_utf8().ok()?;
    validate_decoded_static_path(&decoded, mode)
}

/// 静态资源路径守卫（已解码文件系统相对路径入口，不做二次 URL 解码，避免误杀含字面 `%` 的文件名）
pub fn validate_decoded_static_path(decoded: &str, mode: RunMode) -> Option<Vec<String>> {
    if decoded.is_empty() || decoded.len() > 2048 || has_control_chars(decoded) || decoded.contains('\\') {
        return None;
    }

    // 内部控制面命名空间永不回落到静态文件
    let lower_full = decoded.to_ascii_lowercase();
    if lower_full == "/__api"
        || lower_full.starts_with("/__api/")
        || lower_full == "/__auth"
        || lower_full.starts_with("/__auth/")
        || lower_full == "/__oauth"
        || lower_full.starts_with("/__oauth/")
    {
        return None;
    }

    if decoded == "/" {
        return Some(vec!["index.html".to_string()]);
    }

    let trimmed = decoded.strip_prefix('/')?;
    if trimmed.is_empty() || trimmed.ends_with('/') {
        return None;
    }

    let mut segs = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        // 禁访隐藏文件/目录 (.git / .gitignore / .nojekyll / ...)
        if seg.starts_with('.') {
            return None;
        }
        // 堵住 Windows Win32 尾随点/尾随空格归一化绕过
        if seg.ends_with('.') || seg.ends_with(' ') {
            return None;
        }
        // 堵住 Windows 8.3 短文件名与保留设备名绕过 (_BUILD~1 / CON / NUL)
        if is_short_name_segment(seg) || is_windows_reserved_device_name(seg) {
            return None;
        }
        if seg.contains(':') {
            return None;
        }
        segs.push(seg.to_string());
    }

    if segs.is_empty() {
        return None;
    }

    let lower_joined = segs.join("/").to_ascii_lowercase();

    match mode {
        RunMode::Sim => {
            if segs[0].eq_ignore_ascii_case("_build") {
                return None;
            }
            if lower_joined.starts_with("src/js/data/shadow") {
                return None;
            }
            if lower_joined.starts_with("html/__") && lower_joined.ends_with(".html") {
                return None;
            }
            if lower_joined == "gallery/diary" || lower_joined.starts_with("gallery/diary/") {
                return None;
            }
        }
        RunMode::Serve => {
            // 本地模式下 _build/** 实行默认拒绝 + 精确白名单，仅放行本地工具页必需的两个只读文件
            if segs[0].eq_ignore_ascii_case("_build") {
                const LOCAL_BUILD_ALLOWLIST: &[&str] = &[
                    "_build/privy/txn.txt",
                    "_build/privy/upcoming_tasks.json",
                ];
                if !LOCAL_BUILD_ALLOWLIST.contains(&lower_joined.as_str()) {
                    return None;
                }
            }
        }
    }

    Some(segs)
}

pub fn validate_title(t: &str) -> bool {
    let trimmed = t.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 150 {
        return false;
    }
    if has_control_chars(trimmed) {
        return false;
    }
    if trimmed.starts_with('.') || trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return false;
    }
    const FORBIDDEN: &[char] = &[
        '\\', '/', ':', '*', '?', '"', '<', '>', '|', '%', '!', '^', '$', '`',
        '&', ';', '(', ')',
    ];
    if trimmed.chars().any(|c| FORBIDDEN.contains(&c)) {
        return false;
    }
    if is_short_name_segment(trimmed) {
        return false;
    }
    true
}

pub fn validate_rel_md_path(raw: &str) -> Option<Vec<String>> {
    let rel = raw.trim().trim_start_matches('/');
    if rel.is_empty() || rel.chars().count() > 260 || has_control_chars(rel) {
        return None;
    }
    if rel.contains('\\') || rel.contains(':') {
        return None;
    }
    if !rel.to_ascii_lowercase().ends_with(".md") {
        return None;
    }

    let mut segs = Vec::new();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        if seg.starts_with('.') || seg.ends_with('.') || seg.ends_with(' ') {
            return None;
        }
        if is_short_name_segment(seg) || is_windows_reserved_device_name(seg) {
            return None;
        }
        const FORBIDDEN: &[char] = &['\\', ':', '*', '?', '"', '<', '>', '|'];
        if seg.chars().any(|c| FORBIDDEN.contains(&c)) {
            return None;
        }
        segs.push(seg.to_string());
    }

    if segs.is_empty() {
        return None;
    }
    if segs[0].eq_ignore_ascii_case("_build") || segs[0].eq_ignore_ascii_case(".git") {
        return None;
    }

    Some(segs)
}

pub fn validate_bookmark_block(b: &str) -> bool {
    if b.is_empty()
        || b.len() > 32
        || !b
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return false;
    }
    let low = b.to_ascii_lowercase();
    !matches!(
        low.as_str(),
        "wallpaper-bg"
            | "wallpaper-panel"
            | "b1"
            | "glass-calendar-host"
            | "end_flag"
            | "copyright"
    )
}

pub fn validate_http_url(u: &str) -> bool {
    if u.is_empty() || u.len() > 2000 || has_control_chars(u) {
        return false;
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    !u.chars()
        .any(|c| c.is_whitespace() || c == '<' || c == '>' || c == '"')
}

pub fn validate_bookmark_title(t: &str) -> bool {
    if t.chars().count() > 300 || has_control_chars(t) {
        return false;
    }
    !t.chars().any(|c| c == '<' || c == '>' || c == '|')
}

pub async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    if !headers.contains_key("content-security-policy") {
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(CSP_HEADER_VALUE),
        );
    }
    res
}

/// 全路由 Host 白名单中间件：防止 DNS Rebinding 绕过本地监听读取静态私密资源
pub async fn host_guard_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let host_hdr = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| req.uri().authority().map(|a| a.as_str()));

    let ok = host_hdr
        .map(|h| validate_host_header(h, &state.allowed_hosts))
        .unwrap_or(false);
    if !ok {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "禁止非本机白名单 Host 访问" })),
        )
            .into_response();
    }
    next.run(req).await
}

pub fn verify_api_auth(
    origin: Option<&str>,
    sec_fetch_site: Option<&str>,
    client_hdr: Option<&str>,
    session_token: Option<&str>,
    is_safe_method: bool,
    allowed_origins: &[String],
    expected_token: &str,
) -> Result<(), (StatusCode, &'static str)> {
    match origin.map(|s| s.trim().to_ascii_lowercase()) {
        Some(o) if allowed_origins.contains(&o) => {}
        Some(_) => {
            return Err((StatusCode::FORBIDDEN, "禁止跨源或未授权 Origin 访问本地 API"));
        }
        None if !is_safe_method => {
            return Err((StatusCode::FORBIDDEN, "写接口缺少合法 Origin 头"));
        }
        None => {}
    }

    if let Some(sfs) = sec_fetch_site {
        if !sfs.eq_ignore_ascii_case("same-origin") {
            return Err((StatusCode::FORBIDDEN, "拒绝非同源 Fetch 请求"));
        }
    }

    let client_ok = client_hdr
        .map(|v| v.trim() == CLIENT_HEADER_VALUE)
        .unwrap_or(false);
    if !client_ok {
        return Err((StatusCode::FORBIDDEN, "缺少或非法的 X-Swamp-Client 请求头"));
    }

    let provided = match session_token {
        Some(t) => t.trim(),
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                "缺少本地会话 Cookie，请通过 Swamp 管理窗口点击 Open Site 或允许桌面续签弹窗",
            ));
        }
    };

    let eq: bool = provided.as_bytes().ct_eq(expected_token.as_bytes()).into();
    if !eq {
        return Err((
            StatusCode::UNAUTHORIZED,
            "本地会话已失效（服务可能已重启），请通过 Swamp 管理窗口点击 Open Site 或允许桌面续签弹窗",
        ));
    }

    Ok(())
}

/// `/__api/*` 五重鉴权中间件：Origin 白名单 + Sec-Fetch-Site + X-Swamp-Client + HttpOnly 会话 Cookie 常量时间比对
pub async fn api_auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let headers = req.headers();
    let is_safe_method = *req.method() == Method::GET || *req.method() == Method::HEAD;
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let sfs = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    let client_hdr = headers.get(CLIENT_HEADER_NAME).and_then(|v| v.to_str().ok());
    let session_token = extract_session_cookie_from_headers(headers);

    if let Err((status, msg)) = verify_api_auth(
        origin,
        sfs,
        client_hdr,
        session_token.as_deref(),
        is_safe_method,
        &state.allowed_origins,
        &state.token,
    ) {
        return (status, Json(json!({ "ok": false, "error": msg }))).into_response();
    }

    next.run(req).await
}

/// 内置安全自检套件：`swamp --selftest` 或管理窗口 `selfcheck`
pub fn run_selftest() -> Result<(), String> {
    run_selftest_with_logger(None)
}

pub fn run_selftest_with_logger(logs: Option<&LogBus>) -> Result<(), String> {
    let mut total = 0usize;
    let mut fails = 0usize;
    let mut check = |name: &str, ok: bool| {
        total += 1;
        if ok {
            if let Some(bus) = logs {
                bus.info(format!("PASS  {}", name));
            } else {
                println!("PASS  {}", name);
            }
        } else {
            if let Some(bus) = logs {
                bus.error(format!("FAIL  {}", name));
            } else {
                println!("FAIL  {}", name);
            }
            fails += 1;
        }
    };

    check("serve-root", validate_static_request_path("/", RunMode::Serve).is_some());
    check("serve-readme", validate_static_request_path("/README.md", RunMode::Serve).is_some());
    check("serve-txn-allowed", validate_static_request_path("/_build/privy/txn.txt", RunMode::Serve).is_some());
    check("serve-tasks-allowed", validate_static_request_path("/_build/privy/upcoming_tasks.json", RunMode::Serve).is_some());
    check("serve-block-local-props", validate_static_request_path("/_build/privy/local.properties", RunMode::Serve).is_none());
    check("serve-block-proto-key", validate_static_request_path("/_build/privy/tokens.json", RunMode::Serve).is_none());
    check(
        "serve-block-temp",
        validate_static_request_path("/_build/temp/build_hashes.txt", RunMode::Serve).is_none()
            && validate_static_request_path("/_build/temp/backup/swamp_panic.log", RunMode::Serve)
                .is_none(),
    );
    check("serve-block-8dot3", validate_static_request_path("/_BUILD~1/privy/local.toml", RunMode::Serve).is_none());
    check("serve-block-trailing-dot", validate_static_request_path("/_build/privy/txn.txt.", RunMode::Serve).is_none());
    check("serve-block-trailing-space", validate_static_request_path("/_build/privy/txn.txt%20", RunMode::Serve).is_none());
    check("serve-block-dotgit", validate_static_request_path("/.git/HEAD", RunMode::Serve).is_none());
    check("serve-block-traversal", validate_static_request_path("/html/..%2f_build/config.properties", RunMode::Serve).is_none());
    check("serve-block-api-fallback", validate_static_request_path("/__api/health", RunMode::Serve).is_none());
    check("serve-block-auth-fallback", validate_static_request_path("/__auth", RunMode::Serve).is_none());
    check("sim-block-auth-fallback", validate_static_request_path("/__auth/refresh", RunMode::Sim).is_none());

    check("sim-block-txn", validate_static_request_path("/_build/privy/txn.txt", RunMode::Sim).is_none());
    check("sim-block-shadow", validate_static_request_path("/src/js/data/shadowIndex.js", RunMode::Sim).is_none());
    check("sim-allow-lite", validate_static_request_path("/src/js/data/lite_data.js", RunMode::Sim).is_some());

    check("title-valid", validate_title("变量,函数"));
    check("title-reject-slash", !validate_title("../evil"));
    check("title-reject-amp", !validate_title("a&calc"));
    check("title-reject-semi", !validate_title("a;b"));
    check("title-reject-paren", !validate_title("a(b)"));
    check("md-valid", validate_rel_md_path("/README.md").is_some());
    check("md-reject-traversal", validate_rel_md_path("../secret.md").is_none());
    check("md-reject-build", validate_rel_md_path("_build/notes.md").is_none());
    check("bm-reject-js", !validate_http_url("javascript:alert(1)"));
    check("bm-allow-https", validate_http_url("https://example.com/a?b=1"));

    check(
        "serve-block-swamp-toml",
        validate_static_request_path("/_build/swamp.toml", RunMode::Serve).is_none()
            && validate_static_request_path("/_build/core.toml", RunMode::Serve).is_none()
            && validate_static_request_path("/_build/local.toml.example", RunMode::Serve).is_none(),
    );
    check("serve-block-local-toml", validate_static_request_path("/_build/privy/local.toml", RunMode::Serve).is_none());

    // --- 构建器压缩、HTML 抽取与书签操作自检 ---
    let js_sample = r#"const a = 1; // cmt
const r = /a\/b[\]/]/g;
const s = `hi ${fn(`ok ${1 + ++x}`)}`;
if (a) /re/.test(s);
const t = a ? .5 : 1;
const d = obj.return / 2;"#;
    let js_min = crate::builder::minify::minify_js(js_sample);
    check(
        "minify-js-es2020",
        js_min
            .as_ref()
            .map(|m| {
                !m.contains("cmt")
                    && m.contains(r"/a\/b[\]/]/g")
                    && m.contains("1+ ++x")
                    && m.contains("?.5:1")
                    && m.contains("obj.return/2")
            })
            .unwrap_or(false),
    );

    let js_edge = "let ok = a < ! --b;\ni++\n/re/.test(s);";
    let js_edge_min = crate::builder::minify::minify_js(js_edge);
    check(
        "minify-js-edge-guards",
        js_edge_min
            .as_ref()
            .map(|m| !m.contains("<!--") && m.contains("/re/.test(s)"))
            .unwrap_or(false),
    );

    let css_sample = "/* c */ div :hover { border: 1px/*c*/solid red; width: calc(100% - 30px); color: red; }";
    let css_min = crate::builder::minify::minify_css(css_sample);
    check(
        "minify-css-safe",
        css_min.contains("div :hover{")
            && css_min.contains("border:1px solid red")
            && css_min.contains("calc(100% - 30px)")
            && !css_min.contains("/*"),
    );

    let dummy_root = std::path::Path::new(".");
    check(
        "pack-reject-reserved-name",
        crate::services::pack_apply::resolve_safe_target(dummy_root, "src/CON.txt").is_none(),
    );
    check(
        "pack-reject-trailing-dot",
        crate::services::pack_apply::resolve_safe_target(dummy_root, "src/a.txt.").is_none(),
    );
    check(
        "pack-reject-dotgit-file",
        crate::services::pack_apply::is_hard_private_rel(".git"),
    );

    check(
        "pack-md-fence-escape",
        crate::services::pack_apply::safe_markdown_fence("hello ```rust\ncode\n```") == "````",
    );
    let big_line = "a".repeat(200) + "\n";
    let md_entries = vec![
        ("a.rs".to_string(), big_line.repeat(40).into_bytes()),
        ("b.rs".to_string(), big_line.repeat(40).into_bytes()),
        ("bin.dat".to_string(), vec![0u8, 1, 2, 3]),
    ];
    let (md_parts, bin_skipped) =
        crate::services::pack_apply::render_markdown_bundle_parts("test.zip", &md_entries, 12 * 1024);
    check(
        "pack-md-split-cap",
        md_parts.len() >= 2
            && bin_skipped == 1
            && md_parts.iter().all(|p| p.len() <= 12 * 1024)
            && md_parts[0].contains("Skipped / Binary Files (1)"),
    );

    let sample_log = "[10:00:01] [INFO] first\n[10:00:02] [WARN] multi\n  line2\n---------------------------------------- 2026-11-25 10:15:00 ----------------------------------------\n[10:15:01] [INFO] second\n";
    let parsed_blocks = crate::services::log_bus::parse_log_blocks(sample_log);
    check(
        "log-parse-multiline-blocks",
        parsed_blocks.len() == 4
            && parsed_blocks[1].contains("multi\n  line2")
            && parsed_blocks[2].starts_with(crate::services::log_bus::LOG_SEPARATOR_PREFIX),
    );
    let tmp_bus = LogBus::new(0);
    tmp_bus.info("older");
    tmp_bus.info("newer");
    let (max_id, newest_txt) = tmp_bus.since_newest_first(0);
    let pos_newer = newest_txt.find("newer").unwrap_or(usize::MAX);
    let pos_older = newest_txt.find("older").unwrap_or(0);
    check("log-newest-first-order", max_id == 2 && pos_newer < pos_older);
    let sz_before = tmp_bus.size_bytes();
    tmp_bus.clear();
    check("log-size-bytes-and-clear", sz_before > 0 && tmp_bus.size_bytes() == 0);

    let html_sample = r#"<html><head><title>A &amp; B</title></head><body><span id="anchor">20261123000000-分类</span><pre>Hello <b>World</b></pre><script>var x=1;</script></body></html>"#;
    check(
        "html-title",
        crate::builder::html_utils::extract_title(html_sample) == "A & B",
    );
    check(
        "html-body-strip-anchor",
        crate::builder::html_utils::extract_body_text(html_sample, true) == "Hello World",
    );

    let bm_sample = r#"<div id="a">
   <a href="https://old.example" target="_blank">Old</a>
   <br>
  </div>
  <a id="end_flag" href="1" style="display:none"></a>"#;
    let bm_added = crate::builder::html_utils::apply_bookmark_mutation(
        bm_sample,
        "a",
        "New",
        "https://new.example",
    );
    check(
        "bookmark-add",
        bm_added
            .as_ref()
            .map(|h| h.contains("https://new.example") && !h.contains(r#"href="1""#))
            .unwrap_or(false),
    );
    let bm_del = crate::builder::html_utils::apply_bookmark_mutation(
        bm_sample,
        "del",
        "Old",
        "https://old.example",
    );
    check(
        "bookmark-del",
        bm_del
            .as_ref()
            .map(|h| !h.contains("https://old.example"))
            .unwrap_or(false),
    );

    // --- Host 白名单、路径守卫、压缩边角与 API 鉴权自检 ---
    let hosts_8000 = build_allowed_hosts(8000);
    check("host-guard-allow-localhost", validate_host_header("localhost:8000", &hosts_8000));
    check("host-guard-block-rebinding", !validate_host_header("evil.example:8000", &hosts_8000));
    check("sim-block-private-html", validate_static_request_path("/html/__secret.html", RunMode::Sim).is_none());
    check("serve-block-reserved-device", validate_static_request_path("/src/CON.txt", RunMode::Serve).is_none());
    check("md-reject-reserved-device", validate_rel_md_path("NUL.md").is_none());

    let js_rbrace_while = "const f = () => {}\nwhile (ok) { f(); }";
    let js_rw_min = crate::builder::minify::minify_js(js_rbrace_while);
    check(
        "minify-js-rbrace-while-asi",
        js_rw_min
            .as_ref()
            .map(|m| m.contains("}\nwhile(") && !m.contains("}while("))
            .unwrap_or(false),
    );
    let js_for_await = "async function g(xs){ for await (const x of xs) /ab/.test(x); }";
    let js_fa_min = crate::builder::minify::minify_js(js_for_await);
    check(
        "minify-js-for-await-regex",
        js_fa_min
            .as_ref()
            .map(|m| m.contains("for await(const x of xs)/ab/.test(x)"))
            .unwrap_or(false),
    );
    let js_priv_div = "class A { #return = 4; f() { return this.#return / 2; } }";
    let js_pd_min = crate::builder::minify::minify_js(js_priv_div);
    check(
        "minify-js-private-field-div",
        js_pd_min
            .as_ref()
            .map(|m| m.contains("this.#return/2"))
            .unwrap_or(false),
    );
    let css_custom_empty = ":root { --empty: ; }";
    let css_ce_min = crate::builder::minify::minify_css(css_custom_empty);
    check("minify-css-empty-custom-prop", css_ce_min.contains("--empty: ;"));

    let html_lt_nl = "<body><pre>if (a < b && c > 0)\nline2</pre></body>";
    let body_lt_nl = crate::builder::html_utils::extract_body_text(html_lt_nl, true);
    check(
        "html-body-preserve-lt-and-newlines",
        body_lt_nl == "if (a < b && c > 0)\nline2",
    );

    check(
        "pack-classify-build-exec",
        crate::services::pack_apply::is_build_or_exec_rel("_build/swamp-server/build.bat")
            && crate::services::pack_apply::is_build_or_exec_rel("_build/core.toml")
            && crate::services::pack_apply::is_build_or_exec_rel("_build/swamp.toml")
            && crate::services::pack_apply::is_build_or_exec_rel(".gitignore")
            && !crate::services::pack_apply::is_build_or_exec_rel("src/js/raw/index.js"),
    );
    check(
        "pack-block-privy",
        crate::services::pack_apply::is_hard_private_rel("_build/privy/local.toml"),
    );

    let origs = build_allowed_origins(8000);
    check(
        "api-auth-allow-valid",
        verify_api_auth(
            Some("http://localhost:8000"),
            Some("same-origin"),
            Some("1"),
            Some("deadbeef"),
            false,
            &origs,
            "deadbeef",
        )
        .is_ok(),
    );
    check(
        "api-auth-reject-bad-origin",
        verify_api_auth(
            Some("https://evil.example"),
            Some("same-origin"),
            Some("1"),
            Some("deadbeef"),
            false,
            &origs,
            "deadbeef",
        )
        .is_err(),
    );
    check(
        "api-auth-reject-bad-token",
        verify_api_auth(
            Some("http://localhost:8000"),
            Some("same-origin"),
            Some("1"),
            Some("wrong"),
            false,
            &origs,
            "deadbeef",
        )
        .is_err(),
    );
    check(
        "api-auth-reject-missing-client-hdr",
        verify_api_auth(
            Some("http://localhost:8000"),
            Some("same-origin"),
            None,
            Some("deadbeef"),
            false,
            &origs,
            "deadbeef",
        )
        .is_err()
            && verify_api_auth(
                Some("http://localhost:8000"),
                Some("same-origin"),
                Some("0"),
                Some("deadbeef"),
                false,
                &origs,
                "deadbeef",
            )
            .is_err(),
    );
    check(
        "auth-cookie-parser",
        extract_cookie_value(
            "adult_verified=true; fake_swamp_session=bad; swamp_session=abc123; extra=a=b",
            SESSION_COOKIE_NAME,
        ) == Some("abc123")
            && extract_cookie_value("adult_verified=true; fake_swamp_session=bad", SESSION_COOKIE_NAME)
                .is_none(),
    );
    let tmp_codes = AuthCodeStore::new();
    let issued_code = tmp_codes.issue().ok();
    check(
        "auth-bootstrap-code-single-use",
        issued_code
            .as_deref()
            .map(|c| tmp_codes.consume(c) && !tmp_codes.consume(c) && !tmp_codes.consume("not-a-valid-code"))
            .unwrap_or(false),
    );

    // --- 补丁分级、推送隐私、PKCE、隔离断言与 Markdown 历史自检 ---
    check(
        "static-decoded-allow-literal-percent",
        validate_decoded_static_path("/html/100%20percent%E4%BD.html", RunMode::Serve).is_some(),
    );
    check(
        "pack-classify-nested-cargo-and-scripts",
        crate::services::pack_apply::is_build_or_exec_rel("_build/.cargo/config.toml")
            && crate::services::pack_apply::is_build_or_exec_rel("rust-toolchain.toml")
            && crate::services::pack_apply::is_build_or_exec_rel(".gitattributes")
            && crate::services::pack_apply::is_build_or_exec_rel(".gitmodules")
            && crate::services::pack_apply::is_build_or_exec_rel("scripts/tool.py")
            && crate::services::pack_apply::is_build_or_exec_rel("bad.lnk")
            && crate::services::pack_apply::is_build_or_exec_rel("bad.hta")
            && !crate::services::pack_apply::is_build_or_exec_rel("src/js/raw/side.js"),
    );
    check(
        "push-privacy-path-guard",
        crate::services::pack_apply::is_private_push_path("html/__diary.html")
            && crate::services::pack_apply::is_private_push_path("src/js/data/shadow_data_1.json")
            && crate::services::pack_apply::is_private_push_path("_build/privy/local.toml")
            && !crate::services::pack_apply::is_private_push_path("html/normal.html"),
    );
    check(
        "pkce-rfc7636-vector",
        crate::services::tasks::pkce_challenge_from_verifier(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        ) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    check(
        "pack-manifest-guard-drop-flush",
        crate::services::pack_apply::selftest_manifest_guard_drop(),
    );
    let mut leak_probs = Vec::new();
    let priv_entries = vec![crate::builder::generator::PrivateLeakInput {
        label: "__test.html".to_string(),
        body: "零一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥私密段落尾\n共有名言：实践是检验真理的唯一标准。".to_string(),
        allowed_lite_meta: vec!["__test.html".to_string(), "20261126120000-日记".to_string()],
    }];
    // 仅泄露中间 35 字片段（跨越 24 字非重叠边界，靠 12 字重叠步长必中）
    let mid_35 = "六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥私密段落尾";
    let blobs_leak = vec![(
        "fat_data_1.json".to_string(),
        format!("{{\"1\":\"{}\"}}", mid_35),
    )];
    let blobs_shared = vec![(
        "fat_data_1.json".to_string(),
        "{\"1\":\"共有名言：实践是检验真理的唯一标准。\"}".to_string(),
    )];
    let pub_docs = vec!["共有名言：实践是检验真理的唯一标准。"];
    crate::builder::generator::scan_private_pages_against_blobs(
        &priv_entries,
        &blobs_leak,
        &pub_docs,
        &mut leak_probs,
    );
    let caught_partial = !leak_probs.is_empty();
    leak_probs.clear();
    crate::builder::generator::scan_private_pages_against_blobs(
        &priv_entries,
        &blobs_shared,
        &pub_docs,
        &mut leak_probs,
    );
    let no_false_pos = leak_probs.is_empty();
    check("private-leak-full-coverage-zero-fp", caught_partial && no_false_pos);

    // lite_data.js 纳入扫描：放行已知标题/时间戳元信息，拦截真正泄露的正文
    let lite_meta_only = vec![(
        "lite_data.js".to_string(),
        "window.LITE_DATA={\"html\":{\"日记\":{\"_f\":[[\"__test.html\",1,\"html\",\"20261126120000-日记-localOnly\"]]}}}".to_string(),
    )];
    let lite_body_leak = vec![(
        "lite_data.js".to_string(),
        format!("window.LITE_DATA={{\"leak\":\"{}\"}}", mid_35),
    )];
    leak_probs.clear();
    crate::builder::generator::scan_private_pages_against_blobs(
        &priv_entries,
        &lite_meta_only,
        &pub_docs,
        &mut leak_probs,
    );
    let lite_meta_ok = leak_probs.is_empty();
    leak_probs.clear();
    crate::builder::generator::scan_private_pages_against_blobs(
        &priv_entries,
        &lite_body_leak,
        &pub_docs,
        &mut leak_probs,
    );
    let lite_leak_caught = !leak_probs.is_empty();
    check("private-leak-lite-data-scan", lite_meta_ok && lite_leak_caught);

    check(
        "pack-diff-preview-safe-workspace-ext",
        crate::services::pack_apply::safe_diff_preview_filename("my.code-workspace")
            == "my.code-workspace.txt"
            && crate::services::pack_apply::safe_diff_preview_filename("main.rs") == "main.rs",
    );
    check(
        "sim-block-gallery-diary",
        validate_static_request_path("/gallery/diary/a.webp", RunMode::Sim).is_none(),
    );
    check(
        "sim-block-html-private-prefix",
        validate_static_request_path("/html/__secret.html", RunMode::Sim).is_none(),
    );
    check(
        "pack-block-vscode",
        crate::services::pack_apply::is_hard_private_rel(".vscode/tasks.json")
            && crate::services::pack_apply::is_hard_private_rel(".vscode"),
    );
    let mut custom_priv_gi_b = ignore::gitignore::GitignoreBuilder::new(".");
    let _ = custom_priv_gi_b.add_line(None, "gallery/private_album/");
    let _ = custom_priv_gi_b.add_line(None, "private_videos/");
    let custom_priv_gi = custom_priv_gi_b.build().ok();
    check(
        "push-privacy-generic-and-gitignore",
        crate::services::pack_apply::is_private_push_path("gallery/diary/1.webp")
            && crate::services::pack_apply::is_private_push_path_with_gitignore(
                "gallery/private_album/01.jpg",
                custom_priv_gi.as_ref(),
            )
            && crate::services::pack_apply::is_private_push_path_with_gitignore(
                "private_videos/a.mkv",
                custom_priv_gi.as_ref(),
            )
            && !crate::services::pack_apply::is_private_push_path_with_gitignore(
                "gallery/img/1.webp",
                custom_priv_gi.as_ref(),
            ),
    );
    check(
        "pack-exclude-raw-core-list",
        crate::services::pack_apply::is_default_excluded_pack_file("src/js/raw/core-list.js")
            && !crate::services::pack_apply::is_default_excluded_pack_file("src/js/raw/index.js"),
    );
    check(
        "keep-diary-force-prefix",
        crate::media::keep2html::normalize_keep_html_title("20261127", true) == "__20261127"
            && crate::media::keep2html::normalize_keep_html_title("__20261127", true) == "__20261127"
            && crate::media::keep2html::normalize_keep_html_title("note", false) == "note",
    );
    check(
        "csp-no-external-tool-cdn",
        !CSP_HEADER_VALUE.contains("tailwindcss") && !CSP_HEADER_VALUE.contains("accounts.google.com"),
    );
    check(
        "pack-block-streetview-secrets",
        crate::services::pack_apply::is_hard_private_rel("_build/privy/streetview_tokens.json")
            && crate::services::pack_apply::is_hard_private_rel("streetview_credentials.json"),
    );
    check(
        "streetview-upload-url-guard",
        crate::services::street_view::is_allowed_upload_url(
            "https://streetviewpublish.googleapis.com/media/user/123",
        ) && !crate::services::street_view::is_allowed_upload_url(
            "http://streetviewpublish.googleapis.com/media/1",
        ) && !crate::services::street_view::is_allowed_upload_url("https://evil.example/upload")
            && !crate::services::street_view::is_allowed_upload_url(
                "https://evil@streetviewpublish.googleapis.com/upload",
            ),
    );
    check(
        "streetview-time-and-mask",
        crate::services::street_view::selftest_time_and_update_mask(),
    );
    check(
        "streetview-upload-url-parser-differential",
        !crate::services::street_view::is_allowed_upload_url(
            "https://evil.example?.googleapis.com/upload",
        ) && !crate::services::street_view::is_allowed_upload_url(
            "https://evil.example#.googleapis.com/upload",
        ) && !crate::services::street_view::is_allowed_upload_url(
            r"https://evil.example\.googleapis.com/upload",
        ) && !crate::services::street_view::is_allowed_upload_url("https://.googleapis.com/upload")
            && !crate::services::street_view::is_allowed_upload_url(
                "https://streetviewpublish.googleapis.com:8443/media/1",
            ) && crate::services::street_view::is_allowed_upload_url(
                "https://streetviewpublish.googleapis.com:443/media/1",
            ),
    );
    check(
        "pack-classify-rust-sources",
        crate::services::pack_apply::is_build_or_exec_rel("_build/swamp-server/src/main.rs")
            && crate::services::pack_apply::is_build_or_exec_rel("_build/swamp-server/src/lib.rs")
            && crate::services::pack_apply::is_build_or_exec_rel(
                "_build/swamp-server/src/services/street_view.rs",
            ) && !crate::services::pack_apply::is_build_or_exec_rel("src/js/raw/index.js"),
    );
    check(
        "pack-reject-zip-case-collision",
        crate::services::pack_apply::selftest_zip_reject_case_collision(),
    );
    let md_repo_root = std::path::Path::new("repo_root_dummy");
    check(
        "api-md-canon-path-recheck",
        crate::api_files::validate_canonical_md_target(
            md_repo_root,
            &md_repo_root.join("README.md"),
        ) == Some("README.md".to_string())
            && crate::api_files::validate_canonical_md_target(
                md_repo_root,
                &md_repo_root.join("_build").join("evil.md"),
            )
            .is_none()
            && crate::api_files::validate_canonical_md_target(
                md_repo_root,
                &md_repo_root.join(".git").join("a.md"),
            )
            .is_none()
            && crate::api_files::validate_canonical_md_target(
                md_repo_root,
                std::path::Path::new("outside_root/README.md"),
            )
            .is_none(),
    );

    let mut mock_recs = vec![
        json!({ "id": 1, "title": "public_active" }),
        json!({ "id": 2, "title": "public_deleted" }),
        json!({ "id": 3, "title": "__priv_active" }),
        json!({ "id": 4, "title": "__priv_deleted" }),
    ];
    let cur_titles: std::collections::HashSet<String> = ["public_active", "__priv_active"]
        .into_iter()
        .map(String::from)
        .collect();
    let pruned_cnt =
        crate::builder::generator::prune_deleted_private_records(&mut mock_recs, &cur_titles);
    check(
        "gen-prune-deleted-private-mapper",
        pruned_cnt == 1
            && mock_recs.len() == 3
            && !mock_recs
                .iter()
                .any(|r| r.get("title").and_then(|v| v.as_str()) == Some("__priv_deleted"))
            && mock_recs
                .iter()
                .any(|r| r.get("title").and_then(|v| v.as_str()) == Some("__priv_active"))
            && mock_recs
                .iter()
                .any(|r| r.get("title").and_then(|v| v.as_str()) == Some("public_deleted")),
    );

    let inline_refs = crate::builder::generator::extract_inline_image_refs(
        "说明图 20260101.webp 与 ../gallery/diary/p1.png 和 https://cdn.example/a.png 以及 javascript:x.png",
    );
    check(
        "gen-inline-image-ref-extract",
        inline_refs.len() == 2
            && inline_refs.contains(&"../gallery/img/20260101.webp".to_string())
            && inline_refs.contains(&"../gallery/diary/p1.png".to_string()),
    );

    let short_priv = vec![crate::builder::generator::PrivateLeakInput {
        label: "__short.html".to_string(),
        body: "短甲一\n短乙二\n短丙三\n短丁四\n短戊五\n短己六\n短庚七\n短辛八".to_string(),
        allowed_lite_meta: vec!["__short.html".to_string()],
    }];
    let short_blob = vec![(
        "fat_data_1.json".to_string(),
        r#"{"9":"短甲一\n短乙二\n短丙三\n短丁四\n短戊五\n短己六\n短庚七\n短辛八"}"#.to_string(),
    )];
    let mut short_probs = Vec::new();
    crate::builder::generator::scan_private_pages_against_blobs(
        &short_priv,
        &short_blob,
        &[],
        &mut short_probs,
    );
    check("private-leak-short-lines-merged", !short_probs.is_empty());

    let mut tmp_gi_b = ignore::gitignore::GitignoreBuilder::new(".");
    let _ = tmp_gi_b.add_line(None, "secret_notes/");
    let tmp_gi = tmp_gi_b.build().ok();
    check(
        "push-privacy-gitignore-union",
        crate::services::pack_apply::is_private_push_path_with_gitignore(
            "secret_notes/a.txt",
            tmp_gi.as_ref(),
        ) && !crate::services::pack_apply::is_private_push_path_with_gitignore(
            "html/public.html",
            tmp_gi.as_ref(),
        ),
    );

    let bm_leading_br = r#"<div id="c">
   <a href="https://one.example" target="_blank">One</a>
   <br><a href="https://two.example" target="_blank">Two</a>
  </div>
  <a id="end_flag" href="1" style="display:none"></a>"#;
    let bm_rm_tail = crate::builder::html_utils::apply_bookmark_mutation(
        bm_leading_br,
        "del",
        "Two",
        "https://two.example",
    );
    check(
        "bookmark-block-reserved-and-leading-br",
        !validate_bookmark_block("wallpaper-bg")
            && !validate_bookmark_block("b1")
            && crate::builder::html_utils::apply_bookmark_mutation(
                bm_leading_br,
                "wallpaper-bg",
                "Bad",
                "https://bad.example",
            )
            .is_err()
            && bm_rm_tail
                .as_ref()
                .map(|h| {
                    h.contains("https://one.example")
                        && !h.contains("https://two.example")
                        && !h.contains("<br>")
                })
                .unwrap_or(false),
    );

    let sw_tpl = "importScripts('/src/js/core-list.js?v=__SW_BUILD_VERSION__');\nself.SW_VERSION = '__SW_BUILD_VERSION__';\nconst IS_LOCAL_MODE = self.location.port !== '__SW_SIM_PORT__';\n";
    let sw_rendered = crate::builder::minify::render_sw_source(sw_tpl, "1795999999999", 9123);
    check(
        "sw-template-version-render",
        sw_rendered.contains("core-list.js?v=1795999999999")
            && sw_rendered.contains("self.SW_VERSION = '1795999999999';")
            && !sw_rendered.contains("__SW_BUILD_VERSION__"),
    );
    check(
        "sw-template-sim-port-render",
        sw_rendered.contains("self.location.port !== '9123'")
            && !sw_rendered.contains("__SW_SIM_PORT__"),
    );

    let idx_sample = "<!DOCTYPE html>\n<html lang=\"zh-CN\" data-adult-gate=\"1\">\n<head><title>Old</title></head>\n<body>\n<!-- PARAM-BEGIN -->\n<script></script>\n<!-- PARAM-END -->\n</body></html>";
    let idx_rendered = crate::builder::generator::render_index_html_meta(
        idx_sample,
        "My <Demo> Site",
        false,
        "<script>\n  const site_repo = \"alice/alice.github.io\";\n</script>",
    );
    check(
        "index-site-meta-injection",
        idx_rendered
            .as_deref()
            .map(|h| {
                h.contains("data-adult-gate=\"0\"")
                    && h.contains("<title>My &lt;Demo&gt; Site</title>")
                    && h.contains("const site_repo = \"alice/alice.github.io\";")
            })
            .unwrap_or(false),
    );

    check(
        "config-three-tier-merge",
        crate::config::selftest_three_tier_merge(),
    );
    check(
        "config-upstream-ref-validation",
        crate::config::is_valid_git_ref_name("swamp")
            && crate::config::is_valid_git_ref_name("upstream")
            && crate::config::is_valid_git_ref_name("main")
            && crate::config::is_valid_git_ref_name("feat/sync-v2")
            && !crate::config::is_valid_git_ref_name("")
            && !crate::config::is_valid_git_ref_name("-u")
            && !crate::config::is_valid_git_ref_name("--upload-pack=calc")
            && !crate::config::is_valid_git_ref_name("a..b")
            && !crate::config::is_valid_git_ref_name("bad ref")
            && !crate::config::is_valid_git_ref_name("refs@{0}")
            && !crate::config::is_valid_git_ref_name("branch.lock"),
    );

    check(
        "upstream-skeleton-whitelist",
        crate::services::upstream_sync::is_skeleton_path("README.md")
            && crate::services::upstream_sync::is_skeleton_path("index.html")
            && crate::services::upstream_sync::is_skeleton_path("_build/core.toml")
            && crate::services::upstream_sync::is_skeleton_path("_build/local.toml.example")
            && crate::services::upstream_sync::is_skeleton_path("_build/swamp-server/src/main.rs")
            && crate::services::upstream_sync::is_skeleton_path("_build/swamp-server/assets/cilin.txt")
            && crate::services::upstream_sync::is_skeleton_path("src/js/raw/index.js")
            && crate::services::upstream_sync::is_skeleton_path("src/js/pinyinData.js")
            && crate::services::upstream_sync::is_skeleton_path("src/css/sound/stone2.wav")
            && crate::services::upstream_sync::is_skeleton_path("src/tpl/md_viewer.html")
            && crate::services::upstream_sync::is_skeleton_path(".github/workflows/release.yml")
            && !crate::services::upstream_sync::is_skeleton_path("src/js/raw/core-list.js")
            && !crate::services::upstream_sync::is_skeleton_path("src/tpl/bookmark.html")
            && !crate::services::upstream_sync::is_skeleton_path("_build/swamp.toml")
            && !crate::services::upstream_sync::is_skeleton_path("_build/privy/local.toml")
            && !crate::services::upstream_sync::is_skeleton_path("_build/swamp-server/target/debug/swamp.exe")
            && !crate::services::upstream_sync::is_skeleton_path("html/note.html")
            && !crate::services::upstream_sync::is_skeleton_path("html/__secret.html")
            && !crate::services::upstream_sync::is_skeleton_path("sw.js"),
    );
    check(
        "upstream-user-owned-protection",
        crate::services::upstream_sync::is_user_owned_path("_build/swamp.toml")
            && crate::services::upstream_sync::is_user_owned_path("src/tpl/bookmark.html")
            && crate::services::upstream_sync::is_user_owned_path(".gitignore")
            && crate::services::upstream_sync::is_user_owned_path("src/discussion_id_mapper.json")
            && crate::services::upstream_sync::is_user_owned_path("html/note.html")
            && crate::services::upstream_sync::is_user_owned_path("gallery/img/1.webp")
            && !crate::services::upstream_sync::is_user_owned_path("_build/core.toml")
            && !crate::services::upstream_sync::is_user_owned_path("README.md"),
    );
    check(
        "upstream-artifact-classification",
        crate::services::upstream_sync::is_generated_artifact_path("sw.js")
            && crate::services::upstream_sync::is_generated_artifact_path("src/js/index.js")
            && crate::services::upstream_sync::is_generated_artifact_path("src/css/index.css")
            && crate::services::upstream_sync::is_generated_artifact_path("src/js/data/lite_data.js")
            && crate::services::upstream_sync::is_generated_artifact_path("src/js/raw/core-list.js")
            && crate::services::upstream_sync::is_generated_artifact_path("_build/swamp.exe")
            && !crate::services::upstream_sync::is_generated_artifact_path("src/js/pinyinData.js")
            && !crate::services::upstream_sync::is_generated_artifact_path("src/js/raw/index.js")
            && !crate::services::upstream_sync::is_generated_artifact_path("src/css/raw/index.css"),
    );
    let dirty_idx = "<!DOCTYPE html>\n<html lang=\"zh-CN\" data-adult-gate=\"1\">\n<head><title>Personal Site</title></head>\n<body>\n<!-- PARAM-BEGIN -->\n<script>\n  const github_page = \"alice.github.io\";\n  const site_repo = \"alice/alice.github.io\";\n  const data_repo = \"alice/comments\";\n</script>\n<!-- PARAM-END -->\n</body></html>";
    let clean_idx = crate::services::upstream_sync::sanitize_index_html_for_upstream(dirty_idx);
    check(
        "upstream-index-sanitize",
        clean_idx.contains("data-adult-gate=\"0\"")
            && clean_idx.contains("<title>Digital Swamp</title>")
            && clean_idx.contains("const github_page = \"\";")
            && clean_idx.contains("const site_repo = \"\";")
            && !clean_idx.contains("alice"),
    );

    check(
        "release-version-validation",
        crate::services::release_pack::validate_release_version("v1.0.0")
            && crate::services::release_pack::validate_release_version("1.0.0-rc.1")
            && !crate::services::release_pack::validate_release_version("")
            && !crate::services::release_pack::validate_release_version("-v1")
            && !crate::services::release_pack::validate_release_version("../evil")
            && !crate::services::release_pack::validate_release_version("v1/2"),
    );
    check(
        "release-win64-vs-upgrade-filter",
        crate::services::release_pack::is_release_win64_skeleton_path("_build/swamp-server/assets/cilin.txt")
            && crate::services::release_pack::is_release_win64_skeleton_path("src/js/raw/index.js")
            && crate::services::release_pack::is_release_win64_skeleton_path("src/js/pinyinData.js")
            && !crate::services::release_pack::is_release_win64_skeleton_path("_build/swamp-server/src/main.rs")
            && !crate::services::release_pack::is_release_win64_skeleton_path(".github/workflows/release.yml")
            && !crate::services::release_pack::is_release_win64_skeleton_path("_build/swamp.toml")
            && !crate::services::release_pack::is_release_upgrade_path("_build/swamp-server/assets/cilin.txt")
            && !crate::services::release_pack::is_release_upgrade_path("_build/swamp.exe")
            && crate::services::release_pack::is_release_upgrade_path("_build/core.toml")
            && crate::services::release_pack::is_release_upgrade_path("src/js/pinyinData.js")
            && crate::services::release_pack::is_release_upgrade_path("src/tpl/md_viewer.html")
            && crate::services::release_pack::is_release_upgrade_path("src/wasm/compute_intensive_task_processor_bg.wasm"),
    );
    let sample_upgrade_paths = [
        "README.md",
        "index.html",
        "_build/core.toml",
        "_build/local.toml.example",
        "src/js/raw/index.js",
        "src/css/raw/bookmark.css",
        "src/tpl/md_viewer.html",
        "src/wasm/compute_intensive_task_processor.min.js",
    ];
    check(
        "release-upgrade-zip-apply-compatible",
        sample_upgrade_paths.iter().all(|p| {
            crate::services::release_pack::is_release_upgrade_path(p)
                && !crate::services::pack_apply::is_hard_private_rel(p)
                && !crate::services::upstream_sync::is_user_owned_path(p)
        }),
    );

    let port_sample_a = "[site]\ntitle = \"Demo\"\n\n[server]\nport = 8000\nsim_port = 9000\nlog_level = \"error\"\n";
    let port_upd_a = crate::config::update_toml_server_ports_text(port_sample_a, 8080, 9090);
    let port_sample_b = "[site]\ntitle = \"Demo\"\n\n# === SYNONYMS-CUSTOM-BEGIN ===\n[synonyms]\ncustom_json = '{}'\n# === SYNONYMS-CUSTOM-END ===\n";
    let port_upd_b = crate::config::update_toml_server_ports_text(port_sample_b, 8123, 9123);
    check(
        "config-save-server-ports",
        port_upd_a
            .as_deref()
            .map(|s| s.contains("port = 8080") && s.contains("sim_port = 9090") && s.contains("log_level = \"error\""))
            .unwrap_or(false)
            && port_upd_b
                .as_deref()
                .map(|s| s.contains("[server]\nport = 8123\nsim_port = 9123"))
                .unwrap_or(false)
            && crate::config::update_toml_server_ports_text(port_sample_a, 8080, 8080).is_err()
            && crate::config::update_toml_server_ports_text(port_sample_a, 0, 9000).is_err(),
    );
    check(
        "upstream-third-party-licenses-whitelisted",
        crate::services::upstream_sync::is_skeleton_path("LICENSE")
            && crate::services::upstream_sync::is_skeleton_path("THIRD_PARTY_LICENSES.md")
            && crate::services::release_pack::is_release_win64_skeleton_path("LICENSE")
            && crate::services::release_pack::is_release_win64_skeleton_path("THIRD_PARTY_LICENSES.md")
            && crate::services::release_pack::is_release_upgrade_path("LICENSE")
            && crate::services::release_pack::is_release_upgrade_path("THIRD_PARTY_LICENSES.md"),
    );

    check(
        "upstream-release-tag-validation",
        crate::services::upstream_sync::normalize_release_tag("1.0.1")
            == Ok(("v1.0.1".to_string(), "1.0.1".to_string()))
            && crate::services::upstream_sync::normalize_release_tag("v1.2.3-rc.1")
                == Ok(("v1.2.3-rc.1".to_string(), "1.2.3-rc.1".to_string()))
            && crate::services::upstream_sync::normalize_release_tag("").is_err()
            && crate::services::upstream_sync::normalize_release_tag("v1").is_err()
            && crate::services::upstream_sync::normalize_release_tag("abc").is_err()
            && crate::services::upstream_sync::normalize_release_tag("v../1.0").is_err()
            && crate::services::upstream_sync::normalize_release_tag("-v1.0.0").is_err()
            && crate::services::upstream_sync::is_github_pages_remote_url(
                "https://github.com/alice/alice.github.io.git",
            )
            && crate::services::upstream_sync::is_github_pages_remote_url(
                "git@github.com:alice/alice.github.io.git",
            )
            && !crate::services::upstream_sync::is_github_pages_remote_url(
                "https://github.com/alice/swamp.git",
            ),
    );
    let sample_cargo = "\u{FEFF}[package]\nname = \"swamp\"\nversion = \"1.0.2\"\nedition = \"2021\"\n\n[dependencies]\nserde = \"1\"\n";
    check(
        "upstream-cargo-version-extract",
        crate::services::upstream_sync::extract_cargo_package_version(sample_cargo).as_deref()
            == Some("1.0.2")
            && crate::services::upstream_sync::extract_cargo_package_version("[dependencies]\nserde = \"1\"").is_none(),
    );

    let cargo_sample_u = "[package]\nname = \"swamp\"\nversion = \"1.0.0\"\nedition = \"2021\"\n\n[dependencies]\nfoo = { version = \"1.0.0\" }\n";
    let cargo_upd_ok = crate::services::upstream_sync::update_cargo_toml_version_text(cargo_sample_u, "v1.0.1");
    check(
        "upstream-cargo-version-update",
        cargo_upd_ok
            .as_ref()
            .map(|(txt, ver)| {
                ver == "1.0.1"
                    && txt.contains("version = \"1.0.1\"")
                    && txt.contains("foo = { version = \"1.0.0\" }")
            })
            .unwrap_or(false)
            && crate::services::upstream_sync::update_cargo_toml_version_text(cargo_sample_u, "badver").is_err(),
    );

    if fails > 0 {
        Err(format!("自检未通过: {} 项失败", fails))
    } else {
        if let Some(bus) = logs {
            bus.info(format!("[selfcheck] 通过 {}/{} 项", total, total));
        } else {
            println!("自检通过: {}/{} 项", total, total);
        }
        Ok(())
    }
}
