//! 后台 VPN 网络心跳监测与 Google Tasks OAuth 2.0 (PKCE) 定时同步服务。

use chrono::{Duration as ChronoDuration, Utc};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{oneshot, Notify};

use crate::api_files::write_atomic;
use crate::config::ServerConfig;
use crate::security::generate_token_hex;
use crate::services::log_bus::LogBus;

const NET_FAIL_LOG_THRESHOLD: usize = 3;
const AUTH_COOLDOWN_SECS: i64 = 4 * 60 * 60;
const AUTH_WAIT_TIMEOUT_SECS: u64 = 30 * 60;
const TASKS_SCOPE: &str = "https://www.googleapis.com/auth/tasks.readonly";

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct UpcomingTask {
    #[serde(rename = "listId")]
    pub list_id: String,
    #[serde(rename = "listTitle")]
    pub list_title: String,
    pub id: String,
    pub title: String,
    pub notes: Option<String>,
    pub due: Option<String>,
    pub status: Option<String>,
    pub updated: Option<String>,
    #[serde(rename = "webViewLink")]
    pub web_view_link: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct ClientSecretBlock {
    pub(crate) client_id: String,
    pub(crate) client_secret: String,
    #[serde(default = "default_auth_uri")]
    pub(crate) auth_uri: String,
    #[serde(default = "default_token_uri")]
    pub(crate) token_uri: String,
}

fn default_auth_uri() -> String {
    "https://accounts.google.com/o/oauth2/auth".to_string()
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

#[derive(Deserialize, Debug)]
struct CredentialsFile {
    installed: Option<ClientSecretBlock>,
    web: Option<ClientSecretBlock>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct StoredToken {
    pub(crate) access_token: String,
    #[serde(default)]
    pub(crate) refresh_token: String,
    pub(crate) expires_at: i64,
}

pub struct PendingOAuth {
    pub state: String,
    pub tx: oneshot::Sender<Result<String, String>>,
}

pub struct BusyGuard<'a> {
    counter: &'a AtomicUsize,
}

impl<'a> Drop for BusyGuard<'a> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct RuntimeStatus {
    pub vpn_has_result: AtomicBool,
    pub vpn_online: AtomicBool,
    pub tasks: RwLock<Vec<UpcomingTask>>,
    pub last_tasks_sync: RwLock<String>,
    pub oauth_pending: Mutex<Option<PendingOAuth>>,
    pub reauth_notify: Notify,
    pub busy_ops: AtomicUsize,
    pub ui_hwnd: AtomicIsize,
    pub vpn_msg: u32,
}

impl RuntimeStatus {
    pub fn new(vpn_msg: u32) -> Self {
        Self {
            vpn_has_result: AtomicBool::new(false),
            vpn_online: AtomicBool::new(true), // fail-open until first check
            tasks: RwLock::new(Vec::new()),
            last_tasks_sync: RwLock::new(String::new()),
            oauth_pending: Mutex::new(None),
            reauth_notify: Notify::new(),
            busy_ops: AtomicUsize::new(0),
            ui_hwnd: AtomicIsize::new(0),
            vpn_msg,
        }
    }

    pub fn set_ui_hwnd(&self, hwnd: isize) {
        self.ui_hwnd.store(hwnd, Ordering::SeqCst);
    }

    pub fn begin_op(&self) -> BusyGuard<'_> {
        self.busy_ops.fetch_add(1, Ordering::SeqCst);
        BusyGuard {
            counter: &self.busy_ops,
        }
    }

    pub fn active_ops(&self) -> usize {
        self.busy_ops.load(Ordering::SeqCst)
    }

    pub fn notify_ui_vpn(&self, online: bool) {
        #[cfg(windows)]
        {
            let h = self.ui_hwnd.load(Ordering::SeqCst);
            if h != 0 && self.vpn_msg != 0 {
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                        h as windows_sys::Win32::Foundation::HWND,
                        self.vpn_msg,
                        if online { 1 } else { 0 },
                        0,
                    );
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = online;
        }
    }

    pub fn is_online(&self) -> bool {
        if !self.vpn_has_result.load(Ordering::Relaxed) {
            return true;
        }
        self.vpn_online.load(Ordering::Relaxed)
    }

    pub fn get_tasks(&self) -> Vec<UpcomingTask> {
        self.tasks.read().map(|g| g.clone()).unwrap_or_default()
    }
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_allowed_google_oauth_url(raw: &str) -> bool {
    let Some(rest) = raw.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        host.as_str(),
        "accounts.google.com" | "oauth2.googleapis.com" | "www.googleapis.com"
    )
}

fn base64url_no_pad(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((input.len() * 4 + 2) / 3);
    let mut i = 0usize;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < input.len() {
            out.push(TABLE[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < input.len() {
            out.push(TABLE[(b2 & 0x3F) as usize] as char);
        }
        i += 3;
    }
    out
}

pub(crate) fn pkce_challenge_from_verifier(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64url_no_pad(&digest)
}

fn generate_pkce_pair() -> Result<(String, String), String> {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| format!("生成 PKCE 随机串失败: {}", e))?;
    let verifier = base64url_no_pad(&raw);
    let challenge = pkce_challenge_from_verifier(&verifier);
    Ok((verifier, challenge))
}

pub(crate) fn load_client_secrets_from(path: &Path) -> Result<ClientSecretBlock, String> {
    if !path.is_file() {
        return Err(format!("找不到 {}", path.display()));
    }
    let fname = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("credentials.json");
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {}", fname, e))?;
    let parsed: CredentialsFile =
        serde_json::from_str(&raw).map_err(|e| format!("解析 {} 失败: {}", fname, e))?;
    let block = parsed
        .installed
        .or(parsed.web)
        .ok_or_else(|| format!("{} 缺少 installed/web 字段", fname))?;
    if !is_allowed_google_oauth_url(&block.auth_uri)
        || !is_allowed_google_oauth_url(&block.token_uri)
    {
        return Err(format!(
            "{} 中的 auth_uri 或 token_uri 不在 Google HTTPS 白名单域名内",
            fname
        ));
    }
    Ok(block)
}

fn load_client_secrets(cfg: &ServerConfig) -> Result<ClientSecretBlock, String> {
    load_client_secrets_from(&cfg.privy_dir.join("credentials.json"))
}

fn token_file_path(cfg: &ServerConfig) -> PathBuf {
    cfg.privy_dir.join("tokens.json")
}

pub(crate) fn load_stored_token_from(path: &Path) -> Option<StoredToken> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn save_stored_token_to(path: &Path, tok: &StoredToken) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(tok).map_err(|e| format!("序列化 token 失败: {}", e))?;
    write_atomic(path, &json, false)
}

pub(crate) fn clear_stored_token_at(path: &Path) {
    if path.is_file() {
        let _ = fs::remove_file(path);
    }
}

fn load_stored_token(cfg: &ServerConfig) -> Option<StoredToken> {
    load_stored_token_from(&token_file_path(cfg))
}

fn save_stored_token(cfg: &ServerConfig, tok: &StoredToken) -> Result<(), String> {
    save_stored_token_to(&token_file_path(cfg), tok)
}

pub fn clear_stored_token(cfg: &ServerConfig) {
    clear_stored_token_at(&token_file_path(cfg));
}

pub(crate) enum PollErr {
    Network(String),
    Auth(String),
    Other(String),
}

fn encode_form_pairs(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                utf8_percent_encode(k, NON_ALPHANUMERIC),
                utf8_percent_encode(v, NON_ALPHANUMERIC)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

async fn exchange_code_for_token(
    client: &reqwest::Client,
    creds: &ClientSecretBlock,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<StoredToken, PollErr> {
    let form_body = encode_form_pairs(&[
        ("code", code),
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
        ("grant_type", "authorization_code"),
    ]);
    let resp = client
        .post(&creds.token_uri)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .map_err(|e| PollErr::Network(e.to_string()))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if status.as_u16() == 400 || status.as_u16() == 401 {
            return Err(PollErr::Auth(format!("HTTP {}: {}", status, body)));
        }
        return Err(PollErr::Other(format!("HTTP {}: {}", status, body)));
    }
    let val: Value = serde_json::from_str(&body).map_err(|e| PollErr::Other(e.to_string()))?;
    let access_token = val
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let refresh_token = val
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let expires_in = val.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    if access_token.is_empty() {
        return Err(PollErr::Other("令牌响应缺少 access_token".to_string()));
    }
    Ok(StoredToken {
        access_token,
        refresh_token,
        expires_at: unix_now() + expires_in - 60,
    })
}

pub(crate) async fn refresh_access_token(
    client: &reqwest::Client,
    creds: &ClientSecretBlock,
    refresh_token: &str,
) -> Result<StoredToken, PollErr> {
    let form_body = encode_form_pairs(&[
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ]);
    let resp = client
        .post(&creds.token_uri)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .map_err(|e| PollErr::Network(e.to_string()))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if status.as_u16() == 400 || status.as_u16() == 401 {
            return Err(PollErr::Auth(format!("HTTP {}: {}", status, body)));
        }
        return Err(PollErr::Other(format!("HTTP {}: {}", status, body)));
    }
    let val: Value = serde_json::from_str(&body).map_err(|e| PollErr::Other(e.to_string()))?;
    let access_token = val
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let new_refresh = val
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| refresh_token.to_string());
    let expires_in = val.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    if access_token.is_empty() {
        return Err(PollErr::Other("刷新响应缺少 access_token".to_string()));
    }
    Ok(StoredToken {
        access_token,
        refresh_token: new_refresh,
        expires_at: unix_now() + expires_in - 60,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_interactive_oauth_for_scope(
    cfg: &ServerConfig,
    status: &Arc<RuntimeStatus>,
    client: &reqwest::Client,
    creds: &ClientSecretBlock,
    scope: &str,
    token_path: &Path,
    log_tag: &str,
    logs: &Arc<LogBus>,
) -> Result<StoredToken, PollErr> {
    let state_tok = generate_token_hex().map_err(PollErr::Other)?;
    let (code_verifier, code_challenge) = generate_pkce_pair().map_err(PollErr::Other)?;
    let redirect_uri = format!("http://localhost:{}/__oauth/callback", cfg.port);

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    {
        let mut guard = status
            .oauth_pending
            .lock()
            .map_err(|_| PollErr::Other("授权状态锁异常".to_string()))?;
        if guard.is_some() {
            return Err(PollErr::Other(
                "已有另一项 Google OAuth 授权正在等待浏览器回调，请先完成当前授权".to_string(),
            ));
        }
        *guard = Some(PendingOAuth {
            state: state_tok.clone(),
            tx,
        });
    }

    let enc = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256&state={}",
        creds.auth_uri,
        enc(&creds.client_id),
        enc(&redirect_uri),
        enc(scope),
        enc(&code_challenge),
        enc(&state_tok)
    );

    logs.info(format!("[{}] 已打开浏览器进行 Google OAuth 授权", log_tag));
    crate::open_url_in_browser(&auth_url, false);

    let code_res = tokio::time::timeout(Duration::from_secs(AUTH_WAIT_TIMEOUT_SECS), rx).await;
    if let Ok(mut guard) = status.oauth_pending.lock() {
        if guard.as_ref().map(|p| p.state.as_str()) == Some(state_tok.as_str()) {
            *guard = None;
        }
    }

    let code = match code_res {
        Ok(Ok(Ok(c))) => c,
        Ok(Ok(Err(e))) => return Err(PollErr::Auth(format!("用户取消或授权失败: {}", e))),
        Ok(Err(_)) => return Err(PollErr::Other("授权等待通道已关闭".to_string())),
        Err(_) => return Err(PollErr::Network("等待浏览器授权超时 (30分钟)".to_string())),
    };

    let tok = exchange_code_for_token(client, creds, &code, &redirect_uri, &code_verifier).await?;
    save_stored_token_to(token_path, &tok).map_err(PollErr::Other)?;
    let tok_name = token_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("tokens.json");
    logs.info(format!(
        "[{}] Google OAuth 授权完成，凭证已保存到 privy/{}",
        log_tag, tok_name
    ));
    Ok(tok)
}

async fn run_interactive_oauth(
    cfg: &ServerConfig,
    status: &Arc<RuntimeStatus>,
    client: &reqwest::Client,
    creds: &ClientSecretBlock,
    logs: &Arc<LogBus>,
) -> Result<StoredToken, PollErr> {
    run_interactive_oauth_for_scope(
        cfg,
        status,
        client,
        creds,
        TASKS_SCOPE,
        &token_file_path(cfg),
        "tasks",
        logs,
    )
    .await
}

async fn fetch_upcoming_tasks(
    cfg: &ServerConfig,
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Vec<UpcomingTask>, PollErr> {
    let due_min = "1970-01-01T00:00:00.000Z";
    let due_max = (Utc::now() + ChronoDuration::days(cfg.due_within_days))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let lists_resp = client
        .get("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| PollErr::Network(e.to_string()))?;

    let lists_status = lists_resp.status();
    if lists_status.as_u16() == 401 {
        return Err(PollErr::Auth("TaskLists API 返回 401".to_string()));
    }
    if !lists_status.is_success() {
        return Err(PollErr::Other(format!("TaskLists API HTTP {}", lists_status)));
    }
    let lists_json: Value = lists_resp
        .json()
        .await
        .map_err(|e| PollErr::Other(e.to_string()))?;

    let mut result = Vec::new();
    let Some(lists) = lists_json.get("items").and_then(|v| v.as_array()) else {
        return Ok(result);
    };

    for list in lists {
        let list_id = list.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let list_title = list.get("title").and_then(|v| v.as_str()).unwrap_or("");
        if list_id.is_empty() {
            continue;
        }

        let mut page_token: Option<String> = None;
        loop {
            let mut pairs: Vec<(&str, &str)> = vec![
                ("showCompleted", "false"),
                ("showHidden", "false"),
                ("dueMin", due_min),
                ("dueMax", due_max.as_str()),
                ("maxResults", "100"),
            ];
            if let Some(ref pt) = page_token {
                pairs.push(("pageToken", pt.as_str()));
            }
            let qs = encode_form_pairs(&pairs);
            let url = format!(
                "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks?{}",
                utf8_percent_encode(list_id, NON_ALPHANUMERIC),
                qs
            );

            let resp = client
                .get(&url)
                .bearer_auth(access_token)
                .send()
                .await
                .map_err(|e| PollErr::Network(e.to_string()))?;

            let st = resp.status();
            if st.as_u16() == 401 {
                return Err(PollErr::Auth("Tasks API 返回 401".to_string()));
            }
            if !st.is_success() {
                return Err(PollErr::Other(format!("Tasks API HTTP {}", st)));
            }
            let page_json: Value = resp
                .json()
                .await
                .map_err(|e| PollErr::Other(e.to_string()))?;

            if let Some(items) = page_json.get("items").and_then(|v| v.as_array()) {
                for t in items {
                    result.push(UpcomingTask {
                        list_id: list_id.to_string(),
                        list_title: list_title.to_string(),
                        id: t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        title: t.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        notes: t.get("notes").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        due: t.get("due").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        status: t.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        updated: t.get("updated").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        web_view_link: t
                            .get("webViewLink")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    });
                }
            }

            page_token = page_json
                .get("nextPageToken")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if page_token.is_none() {
                break;
            }
        }
    }

    Ok(result)
}

/// 启动后台 VPN 心跳 + Google Tasks 轮询协程
pub fn spawn_background_monitors(
    cfg: ServerConfig,
    status: Arc<RuntimeStatus>,
    logs: Arc<LogBus>,
) {
    {
        let cfg_hb = cfg.clone();
        let status_hb = status.clone();
        tokio::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
            {
                Ok(c) => c,
                Err(_) => return,
            };

            loop {
                let online = match client.head(&cfg_hb.heartbeat_url).send().await {
                    Ok(r) if r.status().as_u16() == 405 => {
                        match client.get(&cfg_hb.heartbeat_url).send().await {
                            Ok(r2) => r2.status().as_u16() < 400,
                            Err(_) => false,
                        }
                    }
                    Ok(r) => r.status().as_u16() < 400,
                    Err(_) => false,
                };
                status_hb.vpn_online.store(online, Ordering::Relaxed);
                status_hb.vpn_has_result.store(true, Ordering::Relaxed);
                status_hb.notify_ui_vpn(online);
                tokio::time::sleep(Duration::from_secs(cfg_hb.heartbeat_interval_sec)).await;
            }
        });
    }

    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        tokio::time::sleep(Duration::from_millis(1500)).await;
        for _ in 0..75 {
            if status.vpn_has_result.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let json_path = cfg.privy_dir.join("upcoming_tasks.json");
        if let Ok(raw) = fs::read_to_string(&json_path) {
            if let Ok(list) = serde_json::from_str::<Vec<UpcomingTask>>(&raw) {
                if let Ok(mut g) = status.tasks.write() {
                    *g = list;
                }
            }
        }

        let mut last_auth_attempt: i64 = 0;
        let mut net_fail_count: usize = 0;
        let mut net_fail_logged = false;
        let mut auth_fail_logged = false;
        let mut last_other_sig = String::new();

        loop {
            if status.is_online() {
                match load_client_secrets(&cfg) {
                    Err(_) => {
                    }
                    Ok(creds) => {
                        let now = unix_now();
                        let mut token_opt = load_stored_token(&cfg);

                        let mut auth_err: Option<PollErr> = None;
                        let mut refreshed_this_cycle = false;
                        if let Some(ref tok) = token_opt {
                            if tok.expires_at <= now && !tok.refresh_token.is_empty() {
                                refreshed_this_cycle = true;
                                match refresh_access_token(&client, &creds, &tok.refresh_token).await {
                                    Ok(new_tok) => {
                                        let _ = save_stored_token(&cfg, &new_tok);
                                        token_opt = Some(new_tok);
                                    }
                                    Err(e) => auth_err = Some(e),
                                }
                            }
                        }

                        if auth_err.is_none() && token_opt.is_none() {
                            if last_auth_attempt == 0 || (now - last_auth_attempt) >= AUTH_COOLDOWN_SECS {
                                last_auth_attempt = now;
                                match run_interactive_oauth(&cfg, &status, &client, &creds, &logs).await {
                                    Ok(tok) => token_opt = Some(tok),
                                    Err(e) => auth_err = Some(e),
                                }
                            }
                        }

                        let mut fetch_res = if let Some(err) = auth_err {
                            Err(err)
                        } else if let Some(ref tok) = token_opt {
                            fetch_upcoming_tasks(&cfg, &client, &tok.access_token).await
                        } else {
                            Ok(status.get_tasks())
                        };

                        // 遇到 API 401 时优先用现有 refresh_token 刷新一次并重试，不直接清空有效 refresh_token
                        if matches!(fetch_res, Err(PollErr::Auth(_))) && !refreshed_this_cycle {
                            if let Some(ref tok) = token_opt {
                                if !tok.refresh_token.is_empty() {
                                    match refresh_access_token(&client, &creds, &tok.refresh_token).await {
                                        Ok(new_tok) => {
                                            let _ = save_stored_token(&cfg, &new_tok);
                                            fetch_res = fetch_upcoming_tasks(&cfg, &client, &new_tok.access_token).await;
                                        }
                                        Err(e) => fetch_res = Err(e),
                                    }
                                }
                            }
                        }

                        match fetch_res {
                            Ok(tasks) => {
                                net_fail_count = 0;
                                net_fail_logged = false;
                                auth_fail_logged = false;
                                last_other_sig.clear();

                                if let Ok(mut g) = status.tasks.write() {
                                    *g = tasks.clone();
                                }
                                if let Ok(mut g) = status.last_tasks_sync.write() {
                                    *g = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                                }
                                if let Ok(pretty) = serde_json::to_string_pretty(&tasks) {
                                    let _ = fs::create_dir_all(&cfg.privy_dir);
                                    let _ = write_atomic(&json_path, &pretty, false);
                                }
                            }
                            Err(PollErr::Network(msg)) => {
                                if status.is_online() {
                                    net_fail_count += 1;
                                    if net_fail_count >= NET_FAIL_LOG_THRESHOLD && !net_fail_logged {
                                        net_fail_logged = true;
                                        logs.warn(format!(
                                            "[tasks] 连续 {} 次网络失败（心跳显示正常）: {}",
                                            net_fail_count, msg
                                        ));
                                    }
                                } else {
                                    net_fail_count = 0;
                                }
                            }
                            Err(PollErr::Auth(msg)) => {
                                clear_stored_token(&cfg);
                                let now2 = unix_now();
                                if last_auth_attempt == 0 || (now2 - last_auth_attempt) >= AUTH_COOLDOWN_SECS {
                                    last_auth_attempt = now2;
                                    logs.warn(format!("[tasks] 授权已失效，清除旧凭证并重新授权: {}", msg));
                                    if let Ok(new_tok) =
                                        run_interactive_oauth(&cfg, &status, &client, &creds, &logs).await
                                    {
                                        if let Ok(tasks) =
                                            fetch_upcoming_tasks(&cfg, &client, &new_tok.access_token).await
                                        {
                                            if let Ok(mut g) = status.tasks.write() {
                                                *g = tasks.clone();
                                            }
                                            if let Ok(mut g) = status.last_tasks_sync.write() {
                                                *g = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                                            }
                                            if let Ok(pretty) = serde_json::to_string_pretty(&tasks) {
                                                let _ = fs::create_dir_all(&cfg.privy_dir);
                                                let _ = write_atomic(&json_path, &pretty, false);
                                            }
                                        }
                                    }
                                } else if !auth_fail_logged {
                                    auth_fail_logged = true;
                                    logs.warn(format!("[tasks] 授权失效（冷却中）: {}", msg));
                                }
                            }
                            Err(PollErr::Other(msg)) => {
                                if msg != last_other_sig {
                                    last_other_sig = msg.clone();
                                    logs.error(format!("[tasks] 拉取失败: {}", msg));
                                }
                            }
                        }
                    }
                }
            } else {
                net_fail_count = 0;
            }

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(cfg.tasks_poll_interval_sec)) => {}
                _ = status.reauth_notify.notified() => {
                    last_auth_attempt = 0;
                    clear_stored_token(&cfg);
                }
            }
        }
    });
}
