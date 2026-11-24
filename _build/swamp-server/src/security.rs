use axum::{
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use percent_encoding::percent_decode_str;
use serde_json::json;
use std::sync::Arc;
use subtle::ConstantTimeEq;

use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;
use crate::services::tasks::RuntimeStatus;

pub const CSP_HEADER_VALUE: &str = "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://giscus.app; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self';";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunMode {
    Serve,
    Sim,
}

pub struct AppState {
    pub mode: RunMode,
    pub config: ServerConfig,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub verbose: bool,
    pub logs: Arc<LogBus>,
    pub runtime: Arc<RuntimeStatus>,
    pub html_change_tx: tokio::sync::broadcast::Sender<String>,
    pub shutdown_notify: Arc<tokio::sync::Notify>,
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

pub fn is_short_name_segment(seg: &str) -> bool {
    seg.as_bytes()
        .windows(2)
        .any(|w| w[0] == b'~' && w[1].is_ascii_digit())
}

pub fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| (c as u32) <= 0x1F || (c as u32) == 0x7F)
}

/// 静态资源路径守卫：拦截路径穿越、隐藏文件、Windows 8.3 短名、尾点/尾空格绕过及 _build / shadow 敏感区
pub fn validate_static_request_path(raw_path: &str, mode: RunMode) -> Option<Vec<String>> {
    if raw_path.is_empty() || raw_path.len() > 2048 || has_control_chars(raw_path) {
        return None;
    }
    if raw_path.contains('\\') {
        return None;
    }

    let decoded = percent_decode_str(raw_path).decode_utf8().ok()?;
    if has_control_chars(&decoded) || decoded.contains('\\') {
        return None;
    }

    // 内部控制面命名空间永不回落到静态文件
    let lower_full = decoded.to_ascii_lowercase();
    if lower_full == "/__api"
        || lower_full.starts_with("/__api/")
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
        // 堵住 Windows 8.3 短文件名绕过 (_BUILD~1 / PROTOC~1.KEY)
        if is_short_name_segment(seg) {
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

/// 校验 HTML 标题合法性
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
    const FORBIDDEN: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|', '%', '!', '^', '$', '`'];
    if trimmed.chars().any(|c| FORBIDDEN.contains(&c)) {
        return false;
    }
    if is_short_name_segment(trimmed) {
        return false;
    }
    true
}

/// 校验仓库内相对 Markdown 路径（如 README.md）
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
        if is_short_name_segment(seg) {
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
    !b.is_empty()
        && b.len() <= 32
        && b.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
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

/// 全站安全响应头中间件
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
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(CSP_HEADER_VALUE),
    );
    res
}

/// `/__api/*` 四重鉴权中间件：Origin 白名单 + Sec-Fetch-Site + 常量时间 Token 比对
pub async fn api_auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let headers = req.headers();

    let is_safe_method = *req.method() == Method::GET || *req.method() == Method::HEAD;
    match headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_ascii_lowercase())
    {
        Some(o) if state.allowed_origins.contains(&o) => {}
        Some(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "禁止跨源或未授权 Origin 访问本地 API" })),
            )
                .into_response();
        }
        None if !is_safe_method => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "写接口缺少合法 Origin 头" })),
            )
                .into_response();
        }
        None => {}
    }

    if let Some(sfs) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if !sfs.eq_ignore_ascii_case("same-origin") {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "拒绝非同源 Fetch 请求" })),
            )
                .into_response();
        }
    }

    let provided = match headers.get("x-swamp-token").and_then(|v| v.to_str().ok()) {
        Some(t) => t.trim(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "ok": false, "error": "缺少 X-Swamp-Token 会话令牌" })),
            )
                .into_response();
        }
    };

    let eq: bool = provided.as_bytes().ct_eq(state.token.as_bytes()).into();
    if !eq {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "会话令牌无效或服务已重启，请通过 Swamp 管理窗口点击 Open Site 重新打开" })),
        )
            .into_response();
    }

    next.run(req).await
}

/// 内置安全自检套件：`swamp --selftest` 或管理窗口 `selfcheck`
pub fn run_selftest() -> Result<(), String> {
    run_selftest_with_logger(None)
}

pub fn run_selftest_with_logger(logs: Option<&LogBus>) -> Result<(), String> {
    let mut fails = 0usize;
    let mut check = |name: &str, ok: bool| {
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
    check("serve-block-temp", validate_static_request_path("/_build/temp/backup/build_hashes.txt", RunMode::Serve).is_none());
    check("serve-block-8dot3", validate_static_request_path("/_BUILD~1/privy/local.toml", RunMode::Serve).is_none());
    check("serve-block-trailing-dot", validate_static_request_path("/_build/privy/txn.txt.", RunMode::Serve).is_none());
    check("serve-block-trailing-space", validate_static_request_path("/_build/privy/txn.txt%20", RunMode::Serve).is_none());
    check("serve-block-dotgit", validate_static_request_path("/.git/HEAD", RunMode::Serve).is_none());
    check("serve-block-traversal", validate_static_request_path("/html/..%2f_build/config.properties", RunMode::Serve).is_none());
    check("serve-block-api-fallback", validate_static_request_path("/__api/health", RunMode::Serve).is_none());

    check("sim-block-txn", validate_static_request_path("/_build/privy/txn.txt", RunMode::Sim).is_none());
    check("sim-block-shadow", validate_static_request_path("/src/js/data/shadowIndex.js", RunMode::Sim).is_none());
    check("sim-allow-lite", validate_static_request_path("/src/js/data/lite_data.js", RunMode::Sim).is_some());

    check("title-valid", validate_title("变量,函数"));
    check("title-reject-slash", !validate_title("../evil"));
    check("md-valid", validate_rel_md_path("/README.md").is_some());
    check("md-reject-traversal", validate_rel_md_path("../secret.md").is_none());
    check("md-reject-build", validate_rel_md_path("_build/notes.md").is_none());
    check("bm-reject-js", !validate_http_url("javascript:alert(1)"));
    check("bm-allow-https", validate_http_url("https://example.com/a?b=1"));

    check("serve-block-swamp-toml", validate_static_request_path("/_build/swamp.toml", RunMode::Serve).is_none());
    check("serve-block-local-toml", validate_static_request_path("/_build/privy/local.toml", RunMode::Serve).is_none());

    // Step A 纯 Rust 构建器自检：JS/CSS 压缩、HTML 抽取、书签原子操作
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

    let css_sample = "/* c */ div :hover { width: calc(100% - 30px); color: red; }";
    let css_min = crate::builder::minify::minify_css(css_sample);
    check(
        "minify-css-safe",
        css_min.contains("div :hover{")
            && css_min.contains("calc(100% - 30px)")
            && !css_min.contains("/*"),
    );

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

    if fails > 0 {
        Err(format!("SelfTest: {} 项失败", fails))
    } else {
        if let Some(bus) = logs {
            bus.info("SelfTest: 全部 31 项通过");
        } else {
            println!("SelfTest: 全部通过");
        }
        Ok(())
    }
}
