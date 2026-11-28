//! Google Street View Publish API 客户端：PKCE OAuth 授权、三阶段全景图上传与元数据更新。

use chrono::NaiveDateTime;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;
use crate::services::tasks::{
    clear_stored_token_at, load_client_secrets_from, load_stored_token_from, refresh_access_token,
    run_interactive_oauth_for_scope, save_stored_token_to, unix_now, ClientSecretBlock, PollErr,
    RuntimeStatus,
};

const STREET_VIEW_SCOPE: &str = "https://www.googleapis.com/auth/streetviewpublish";
const START_UPLOAD_URL: &str = "https://streetviewpublish.googleapis.com/v1/photo:startUpload";
const CREATE_PHOTO_URL: &str = "https://streetviewpublish.googleapis.com/v1/photo";
const HTTP_TIMEOUT_SECS: u64 = 180;
const MAX_UPLOAD_JPEG_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct UploadPhotoReq {
    pub image_path: PathBuf,
    pub lat: f64,
    pub lng: f64,
    pub heading: Option<f64>,
    pub place_id: String,
    pub date_time: String,
    pub tz_hours: i32,
}

#[derive(Clone, Debug)]
pub struct UpdatePhotoReq {
    pub photo_id: String,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub heading: Option<f64>,
    pub place_id: String,
    pub date_time: String,
    pub tz_hours: i32,
}

// --- 凭据与令牌路径 ---

pub fn resolve_credentials_path(cfg: &ServerConfig) -> Option<PathBuf> {
    let dedicated = cfg.privy_dir.join("streetview_credentials.json");
    if dedicated.is_file() {
        return Some(dedicated);
    }
    let shared = cfg.privy_dir.join("credentials.json");
    if shared.is_file() {
        return Some(shared);
    }
    None
}

pub fn token_path(cfg: &ServerConfig) -> PathBuf {
    cfg.privy_dir.join("streetview_tokens.json")
}

pub fn has_stored_token(cfg: &ServerConfig) -> bool {
    load_stored_token_from(&token_path(cfg))
        .map(|t| !t.access_token.is_empty() || !t.refresh_token.is_empty())
        .unwrap_or(false)
}

pub fn clear_token(cfg: &ServerConfig) {
    clear_stored_token_at(&token_path(cfg));
}

fn load_credentials(cfg: &ServerConfig) -> Result<ClientSecretBlock, String> {
    let path = resolve_credentials_path(cfg).ok_or_else(|| {
        format!(
            "未找到 OAuth 凭据（请放置 {} 或复用 {}）",
            cfg.privy_dir.join("streetview_credentials.json").display(),
            cfg.privy_dir.join("credentials.json").display()
        )
    })?;
    load_client_secrets_from(&path)
}

// --- 参数与域名白名单校验 ---

pub(crate) fn is_allowed_upload_url(raw: &str) -> bool {
    if raw.is_empty()
        || raw
            .chars()
            .any(|c| c.is_whitespace() || (c as u32) <= 0x1F || (c as u32) == 0x7F)
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.port_or_known_default() != Some(443) {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "streetviewpublish.googleapis.com" {
        return true;
    }
    if let Some(sub) = host_lower.strip_suffix(".googleapis.com") {
        return !sub.is_empty()
            && !sub.starts_with('.')
            && !sub.ends_with('.')
            && !sub.contains("..");
    }
    false
}

pub(crate) fn validate_lat_lng(lat: f64, lng: f64) -> Result<(), String> {
    if !lat.is_finite() || !(-90.0..=90.0).contains(&lat) {
        return Err("纬度必须为 -90 到 90 之间的有效数字".to_string());
    }
    if !lng.is_finite() || !(-180.0..=180.0).contains(&lng) {
        return Err("经度必须为 -180 到 180 之间的有效数字".to_string());
    }
    Ok(())
}

pub(crate) fn validate_heading(h: f64) -> Result<(), String> {
    if !h.is_finite() || !(0.0..=360.0).contains(&h) {
        return Err("相机朝向 (Heading) 必须为 0 到 360 之间的有效数字".to_string());
    }
    Ok(())
}

#[inline]
fn normalize_heading(h: f64) -> f64 {
    if h == 360.0 {
        0.0
    } else {
        h
    }
}

fn truncate_err_body(body: &str) -> String {
    const LIMIT: usize = 512;
    let trimmed = body.trim();
    if trimmed.chars().count() <= LIMIT {
        trimmed.to_string()
    } else {
        let head: String = trimmed.chars().take(LIMIT).collect();
        format!("{}...(truncated)", head)
    }
}

pub(crate) fn parse_capture_time_unix(dt_str: &str, tz_hours: i32) -> Result<Option<i64>, String> {
    let trimmed = dt_str.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !(-12..=12).contains(&tz_hours) {
        return Err(format!("非法时区偏移: UTC{:+}", tz_hours));
    }
    let norm = trimmed.replace('T', " ").replace('/', "-");
    let naive = NaiveDateTime::parse_from_str(&norm, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(&norm, "%Y-%m-%d %H:%M"))
        .map_err(|_| format!("拍摄时间格式错误（需为 YYYY-MM-DD HH:MM）: {}", trimmed))?;
    Ok(Some(naive.and_utc().timestamp() - (tz_hours as i64) * 3600))
}

pub(crate) fn build_update_payload_and_mask(
    req: &UpdatePhotoReq,
) -> Result<(Value, Vec<&'static str>), String> {
    let mut mask: Vec<&'static str> = Vec::new();
    let mut pose = Map::new();
    let mut root = Map::new();

    match (req.lat, req.lng) {
        (Some(lat), Some(lng)) => {
            validate_lat_lng(lat, lng)?;
            pose.insert(
                "latLngPair".to_string(),
                json!({ "latitude": lat, "longitude": lng }),
            );
            mask.push("pose.latLngPair");
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err("更新坐标必须同时填写纬度和经度".to_string());
        }
        (None, None) => {}
    }

    if let Some(h) = req.heading {
        validate_heading(h)?;
        pose.insert("heading".to_string(), json!(normalize_heading(h)));
        mask.push("pose.heading");
    }

    if !pose.is_empty() {
        root.insert("pose".to_string(), Value::Object(pose));
    }

    let pid = req.place_id.trim();
    if !pid.is_empty() {
        root.insert("places".to_string(), json!([{ "placeId": pid }]));
        mask.push("places");
    }

    if let Some(ts) = parse_capture_time_unix(&req.date_time, req.tz_hours)? {
        root.insert(
            "captureTime".to_string(),
            json!({ "seconds": ts.to_string() }),
        );
        mask.push("captureTime");
    }

    if mask.is_empty() {
        return Err("请至少填写一项需要更新的元数据字段".to_string());
    }

    Ok((Value::Object(root), mask))
}

fn poll_err_to_string(err: PollErr) -> String {
    match err {
        PollErr::Network(s) => format!("网络错误: {}", s),
        PollErr::Auth(s) => format!("授权失效: {}", s),
        PollErr::Other(s) => s,
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

async fn get_valid_access_token(
    cfg: &ServerConfig,
    client: &reqwest::Client,
    force_refresh: bool,
) -> Result<(String, bool), String> {
    let tok_path = token_path(cfg);
    let tok_path_rd = tok_path.clone();
    let stored = tokio::task::spawn_blocking(move || load_stored_token_from(&tok_path_rd))
        .await
        .map_err(|e| format!("读取令牌任务异常: {}", e))?
        .ok_or_else(|| "尚未授权街景发布权限，请先点击「登录授权」".to_string())?;
    let need_refresh =
        force_refresh || stored.expires_at <= unix_now() || stored.access_token.is_empty();
    if !need_refresh {
        return Ok((stored.access_token, false));
    }
    if stored.refresh_token.is_empty() {
        return Err("街景访问令牌已过期且无刷新令牌，请点击「登录授权」重新授权".to_string());
    }
    let cfg_creds = cfg.clone();
    let creds = tokio::task::spawn_blocking(move || load_credentials(&cfg_creds))
        .await
        .map_err(|e| format!("读取凭据任务异常: {}", e))??;
    let new_tok = match refresh_access_token(client, &creds, &stored.refresh_token).await {
        Ok(tok) => tok,
        Err(e) => {
            if matches!(e, PollErr::Auth(_)) {
                let tok_path_clr = tok_path.clone();
                let _ = tokio::task::spawn_blocking(move || clear_stored_token_at(&tok_path_clr))
                    .await;
            }
            return Err(poll_err_to_string(e));
        }
    };
    let tok_path_wr = tok_path.clone();
    let tok_to_save = new_tok.clone();
    tokio::task::spawn_blocking(move || save_stored_token_to(&tok_path_wr, &tok_to_save))
        .await
        .map_err(|e| format!("保存令牌任务异常: {}", e))??;
    Ok((new_tok.access_token, true))
}

// --- OAuth 交互授权、三阶段上传与元数据更新 ---

pub async fn authorize_interactive(
    cfg: &ServerConfig,
    runtime: &Arc<RuntimeStatus>,
    logs: &Arc<LogBus>,
) -> Result<(), String> {
    let cfg_creds = cfg.clone();
    let creds = tokio::task::spawn_blocking(move || load_credentials(&cfg_creds))
        .await
        .map_err(|e| format!("读取凭据任务异常: {}", e))??;
    let client = build_http_client()?;
    let tok_path = token_path(cfg);
    run_interactive_oauth_for_scope(
        cfg,
        runtime,
        &client,
        &creds,
        STREET_VIEW_SCOPE,
        &tok_path,
        "streetview",
        logs,
    )
    .await
    .map(|_| ())
    .map_err(poll_err_to_string)
}

pub async fn upload_photo(
    cfg: &ServerConfig,
    logs: &Arc<LogBus>,
    req: UploadPhotoReq,
) -> Result<String, String> {
    validate_lat_lng(req.lat, req.lng)?;
    if let Some(h) = req.heading {
        validate_heading(h)?;
    }
    let capture_time = parse_capture_time_unix(&req.date_time, req.tz_hours)?;

    let meta = tokio::fs::metadata(&req.image_path)
        .await
        .map_err(|_| format!("找不到图片文件: {}", req.image_path.display()))?;
    if !meta.is_file() {
        return Err(format!("目标路径不是文件: {}", req.image_path.display()));
    }
    if meta.len() > MAX_UPLOAD_JPEG_BYTES {
        return Err(format!(
            "全景图体积超过安全上限 ({} MB)",
            MAX_UPLOAD_JPEG_BYTES / (1024 * 1024)
        ));
    }
    let img_bytes = tokio::fs::read(&req.image_path)
        .await
        .map_err(|e| format!("读取图片失败 ({}): {}", req.image_path.display(), e))?;
    if img_bytes.len() < 4 || !img_bytes.starts_with(&[0xFF, 0xD8]) {
        return Err("Google Street View Publish API 仅支持有效的 JPEG (.jpg/.jpeg) 全景图".to_string());
    }
    let size_mb = img_bytes.len() as f64 / (1024.0 * 1024.0);
    logs.info(format!(
        "[streetview] 开始发布流程: {} ({:.2} MB)",
        req.image_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("photo.jpg"),
        size_mb
    ));

    let client = build_http_client()?;
    let (mut access_token, mut refreshed) = get_valid_access_token(cfg, &client, false).await?;

    // 阶段 1/3：申请临时上传链接（401 时静默刷新一次重试）
    logs.info("[streetview] 阶段 1/3: 申请临时上传链接");
    let upload_url = loop {
        let resp = client
            .post(START_UPLOAD_URL)
            .bearer_auth(&access_token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("{}")
            .send()
            .await
            .map_err(|e| format!("阶段 1 请求失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 401 && !refreshed {
            let (new_tok, _) = get_valid_access_token(cfg, &client, true).await?;
            access_token = new_tok;
            refreshed = true;
            continue;
        }
        if !status.is_success() {
            return Err(format!(
                "阶段 1 失败 (HTTP {}): {}",
                status,
                truncate_err_body(&body)
            ));
        }
        let val: Value =
            serde_json::from_str(&body).map_err(|e| format!("解析阶段 1 响应失败: {}", e))?;
        let url = val
            .get("uploadUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !is_allowed_upload_url(&url) {
            return Err("阶段 1 返回的 uploadUrl 不在 Google HTTPS 白名单域名内".to_string());
        }
        break url;
    };

    // 阶段 2/3：传输 JPEG 字节流
    logs.info("[streetview] 阶段 2/3: 传输全景图字节流");
    let up_resp = client
        .post(&upload_url)
        .bearer_auth(&access_token)
        .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
        .header("X-Goog-Upload-Protocol", "raw")
        .header("X-Goog-Upload-Content-Length", img_bytes.len().to_string())
        .body(img_bytes)
        .send()
        .await
        .map_err(|e| format!("阶段 2 传输失败: {}", e))?;
    let up_status = up_resp.status();
    if !up_status.is_success() {
        let err_body = up_resp.text().await.unwrap_or_default();
        return Err(format!(
            "阶段 2 失败 (HTTP {}): {}",
            up_status,
            truncate_err_body(&err_body)
        ));
    }

    // 阶段 3/3：绑定坐标、朝向、地点与拍摄时间（慢网传图后若遇 401，静默刷新一次重试）
    logs.info("[streetview] 阶段 3/3: 绑定地理坐标与元数据");
    let mut pose = Map::new();
    pose.insert(
        "latLngPair".to_string(),
        json!({ "latitude": req.lat, "longitude": req.lng }),
    );
    if let Some(h) = req.heading {
        pose.insert("heading".to_string(), json!(normalize_heading(h)));
    }
    let mut payload = Map::new();
    payload.insert("uploadReference".to_string(), json!({ "uploadUrl": upload_url }));
    payload.insert("pose".to_string(), Value::Object(pose));
    if let Some(ts) = capture_time {
        payload.insert(
            "captureTime".to_string(),
            json!({ "seconds": ts.to_string() }),
        );
    }
    let pid = req.place_id.trim();
    if !pid.is_empty() {
        payload.insert("places".to_string(), json!([{ "placeId": pid }]));
    }
    let payload_val = Value::Object(payload);

    let mut stage3_retried = false;
    let create_body = loop {
        let create_resp = client
            .post(CREATE_PHOTO_URL)
            .bearer_auth(&access_token)
            .json(&payload_val)
            .send()
            .await
            .map_err(|e| format!("阶段 3 请求失败: {}", e))?;
        let create_status = create_resp.status();
        let body = create_resp.text().await.unwrap_or_default();
        if create_status.as_u16() == 401 && !stage3_retried {
            let (new_tok, _) = get_valid_access_token(cfg, &client, true).await?;
            access_token = new_tok;
            stage3_retried = true;
            continue;
        }
        if !create_status.is_success() {
            return Err(format!(
                "阶段 3 失败 (HTTP {}): {}",
                create_status,
                truncate_err_body(&body)
            ));
        }
        break body;
    };
    let result: Value = serde_json::from_str(&create_body)
        .map_err(|e| format!("解析阶段 3 响应失败: {}", e))?;
    let photo_id = result
        .get("photoId")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    logs.info(format!("[streetview] 发布成功! Photo ID: {}", photo_id));
    Ok(photo_id)
}

pub async fn update_photo_metadata(
    cfg: &ServerConfig,
    logs: &Arc<LogBus>,
    req: UpdatePhotoReq,
) -> Result<(), String> {
    let photo_id = req.photo_id.trim();
    if photo_id.is_empty() {
        return Err("必须填写目标 Photo ID".to_string());
    }
    let (payload, mask) = build_update_payload_and_mask(&req)?;
    let mask_str = mask.join(",");
    let url = format!(
        "{}/{}?updateMask={}",
        CREATE_PHOTO_URL,
        utf8_percent_encode(photo_id, NON_ALPHANUMERIC),
        mask_str
    );

    logs.info(format!(
        "[streetview] 发送元数据更新: Photo ID={} | updateMask={}",
        photo_id, mask_str
    ));

    let client = build_http_client()?;
    let (mut access_token, mut refreshed) = get_valid_access_token(cfg, &client, false).await?;

    loop {
        let resp = client
            .put(&url)
            .bearer_auth(&access_token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("元数据更新请求失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 401 && !refreshed {
            let (new_tok, _) = get_valid_access_token(cfg, &client, true).await?;
            access_token = new_tok;
            refreshed = true;
            continue;
        }
        if !status.is_success() {
            return Err(format!(
                "元数据更新失败 (HTTP {}): {}",
                status,
                truncate_err_body(&body)
            ));
        }
        break;
    }

    logs.info(format!("[streetview] 元数据更新成功: {}", photo_id));
    Ok(())
}

pub(crate) fn selftest_time_and_update_mask() -> bool {
    let t_cn = parse_capture_time_unix("2026-11-27 12:00", 8) == Ok(Some(1795752000));
    let t_us = parse_capture_time_unix("2026-11-27T12:00:00", -5) == Ok(Some(1795798800));
    let t_empty = parse_capture_time_unix("", 8) == Ok(None);
    let t_bad = parse_capture_time_unix("not-a-date", 8).is_err();

    let half_coord = UpdatePhotoReq {
        photo_id: "p1".to_string(),
        lat: Some(22.39),
        lng: None,
        heading: None,
        place_id: String::new(),
        date_time: String::new(),
        tz_hours: 8,
    };
    let half_err = build_update_payload_and_mask(&half_coord).is_err();

    let empty_req = UpdatePhotoReq {
        photo_id: "p1".to_string(),
        lat: None,
        lng: None,
        heading: None,
        place_id: String::new(),
        date_time: String::new(),
        tz_hours: 8,
    };
    let empty_err = build_update_payload_and_mask(&empty_req).is_err();

    let valid_req = UpdatePhotoReq {
        photo_id: "p1".to_string(),
        lat: Some(22.39),
        lng: Some(113.37),
        heading: Some(360.0),
        place_id: "ChIJtest".to_string(),
        date_time: "2026-11-27 12:00".to_string(),
        tz_hours: 8,
    };
    let valid_ok = match build_update_payload_and_mask(&valid_req) {
        Ok((val, mask)) => {
            mask == vec!["pose.latLngPair", "pose.heading", "places", "captureTime"]
                && val["pose"]["heading"] == 0.0
                && val["captureTime"]["seconds"] == "1795752000"
                && val["places"][0]["placeId"] == "ChIJtest"
        }
        Err(_) => false,
    };

    t_cn && t_us && t_empty && t_bad && half_err && empty_err && valid_ok
}
