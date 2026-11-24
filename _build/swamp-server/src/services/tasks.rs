use chrono::{Duration as ChronoDuration, Utc};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
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
struct ClientSecretBlock {
    client_id: String,
    client_secret: String,
    #[serde(default = "default_auth_uri")]
    auth_uri: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
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
struct StoredToken {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_at: i64,
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

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_client_secrets(cfg: &ServerConfig) -> Result<ClientSecretBlock, String> {
    let path = cfg.privy_dir.join("credentials.json");
    if !path.is_file() {
        return Err(format!("找不到 {}", path.display()));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取 credentials.json 失败: {}", e))?;
    let parsed: CredentialsFile =
        serde_json::from_str(&raw).map_err(|e| format!("解析 credentials.json 失败: {}", e))?;
    parsed
        .installed
        .or(parsed.web)
        .ok_or_else(|| "credentials.json 缺少 installed/web 字段".to_string())
}

fn token_file_path(cfg: &ServerConfig) -> PathBuf {
    cfg.privy_dir.join("tokens.json")
}

fn load_stored_token(cfg: &ServerConfig) -> Option<StoredToken> {
    let p = token_file_path(cfg);
    let raw = fs::read_to_string(&p).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_stored_token(cfg: &ServerConfig, tok: &StoredToken) -> Result<(), String> {
    let _ = fs::create_dir_all(&cfg.privy_dir);
    let json = serde_json::to_string_pretty(tok).map_err(|e| format!("序列化 token 失败: {}", e))?;
    write_atomic(&token_file_path(cfg), &json, false)
}

pub fn clear_stored_token(cfg: &ServerConfig) {
    let p = token_file_path(cfg);
    if p.is_file() {
        let _ = fs::remove_file(&p);
    }
}

enum PollErr {
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
) -> Result<StoredToken, PollErr> {
    let form_body = encode_form_pairs(&[
        ("code", code),
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("redirect_uri", redirect_uri),
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

async fn refresh_access_token(
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

async fn run_interactive_oauth(
    cfg: &ServerConfig,
    status: &Arc<RuntimeStatus>,
    client: &reqwest::Client,
    creds: &ClientSecretBlock,
    logs: &Arc<LogBus>,
) -> Result<StoredToken, PollErr> {
    let state_tok = generate_token_hex().map_err(PollErr::Other)?;
    let redirect_uri = format!("http://localhost:{}/__oauth/callback", cfg.port);

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    if let Ok(mut guard) = status.oauth_pending.lock() {
        *guard = Some(PendingOAuth {
            state: state_tok.clone(),
            tx,
        });
    }

    let enc = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}",
        creds.auth_uri,
        enc(&creds.client_id),
        enc(&redirect_uri),
        enc(TASKS_SCOPE),
        enc(&state_tok)
    );

    logs.info("[tasks] 正在打开浏览器进行 Google Tasks OAuth 授权...");
    crate::open_url_in_browser(&auth_url, false);

    let code_res = tokio::time::timeout(Duration::from_secs(AUTH_WAIT_TIMEOUT_SECS), rx).await;
    if let Ok(mut guard) = status.oauth_pending.lock() {
        *guard = None;
    }

    let code = match code_res {
        Ok(Ok(Ok(c))) => c,
        Ok(Ok(Err(e))) => return Err(PollErr::Auth(format!("用户取消或授权失败: {}", e))),
        Ok(Err(_)) => return Err(PollErr::Other("授权等待通道已关闭".to_string())),
        Err(_) => return Err(PollErr::Network("等待浏览器授权超时 (30分钟)".to_string())),
    };

    let tok = exchange_code_for_token(client, creds, &code, &redirect_uri).await?;
    save_stored_token(cfg, &tok).map_err(PollErr::Other)?;
    logs.info("[tasks] Google Tasks 授权成功，凭证已持久化到 privy/tokens.json");
    Ok(tok)
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
    // 1. VPN 心跳监测循环（状态变化时实时通知管理窗口刷新任务栏图标颜色）
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
                let online = match client.get(&cfg_hb.heartbeat_url).send().await {
                    Ok(r) => r.status().as_u16() == 200,
                    Err(_) => false,
                };
                status_hb.vpn_online.store(online, Ordering::Relaxed);
                status_hb.vpn_has_result.store(true, Ordering::Relaxed);
                status_hb.notify_ui_vpn(online);
                tokio::time::sleep(Duration::from_secs(cfg_hb.heartbeat_interval_sec)).await;
            }
        });
    }

    // 2. Google Tasks 轮询与 OAuth 自动刷新循环
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        // 等待首个心跳探测结果（最多 15s）
        tokio::time::sleep(Duration::from_millis(1500)).await;
        for _ in 0..75 {
            if status.vpn_has_result.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        // 若本地已有旧 upcoming_tasks.json，先预热进内存
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
                        // 未配置 credentials.json 时静默等待
                    }
                    Ok(creds) => {
                        let now = unix_now();
                        let mut token_opt = load_stored_token(&cfg);

                        // 如果已过期且有 refresh_token，先自动刷新
                        let mut auth_err: Option<PollErr> = None;
                        if let Some(ref tok) = token_opt {
                            if tok.expires_at <= now && !tok.refresh_token.is_empty() {
                                match refresh_access_token(&client, &creds, &tok.refresh_token).await {
                                    Ok(new_tok) => {
                                        let _ = save_stored_token(&cfg, &new_tok);
                                        token_opt = Some(new_tok);
                                    }
                                    Err(e) => auth_err = Some(e),
                                }
                            }
                        }

                        // 若无可用凭证，在冷却期满后触发交互授权
                        if auth_err.is_none() && token_opt.is_none() {
                            if last_auth_attempt == 0 || (now - last_auth_attempt) >= AUTH_COOLDOWN_SECS {
                                last_auth_attempt = now;
                                match run_interactive_oauth(&cfg, &status, &client, &creds, &logs).await {
                                    Ok(tok) => token_opt = Some(tok),
                                    Err(e) => auth_err = Some(e),
                                }
                            }
                        }

                        let fetch_res = if let Some(err) = auth_err {
                            Err(err)
                        } else if let Some(tok) = token_opt {
                            fetch_upcoming_tasks(&cfg, &client, &tok.access_token).await
                        } else {
                            Ok(status.get_tasks())
                        };

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
                                // 同步落盘 upcoming_tasks.json 保持向下兼容
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
                                    logs.warn(format!("[tasks] 授权失效，清除凭证准备重授: {}", msg));
                                    if let Ok(new_tok) =
                                        run_interactive_oauth(&cfg, &status, &client, &creds, &logs).await
                                    {
                                        if let Ok(tasks) =
                                            fetch_upcoming_tasks(&cfg, &client, &new_tok.access_token).await
                                        {
                                            if let Ok(mut g) = status.tasks.write() {
                                                *g = tasks;
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
