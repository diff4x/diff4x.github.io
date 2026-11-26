use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

use crate::builder::html_utils::update_bookmark;
use crate::security::{validate_rel_md_path, validate_title, AppState};

#[derive(Deserialize)]
pub struct PutHtmlReq {
    pub title: String,
    pub html: String,
}

#[derive(Deserialize)]
pub struct PutMdReq {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct BookmarkReq {
    pub block: String,
    #[serde(default)]
    pub title: String,
    pub href: String,
}

pub fn write_bytes_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "非法文件名".to_string())?;

    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!("{}.{}.{}.swamp.tmp", file_name, std::process::id(), seq);
    let tmp_path = parent.join(tmp_name);

    std::fs::write(&tmp_path, bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;

    let mut last_err = None;
    for delay_ms in [0u64, 25, 60, 120, 200] {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match std::fs::rename(&tmp_path, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retryable = e.kind() == std::io::ErrorKind::PermissionDenied
                    || matches!(e.raw_os_error(), Some(5) | Some(32));
                last_err = Some(e);
                if !retryable {
                    break;
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp_path);
    Err(format!(
        "原子替换目标文件失败: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

pub fn write_atomic(target: &Path, content: &str, with_bom: bool) -> Result<(), String> {
    if !with_bom {
        return write_bytes_atomic(target, content.as_bytes());
    }
    let mut bytes = Vec::with_capacity(content.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(content.as_bytes());
    write_bytes_atomic(target, &bytes)
}

fn err_resp(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "ok": false, "error": msg.into() }))).into_response()
}

pub async fn put_html(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PutHtmlReq>,
) -> Response {
    let _busy = state.runtime.begin_op();
    let title = req.title.trim();
    if !validate_title(title) {
        return err_resp(StatusCode::BAD_REQUEST, "非法页面标题");
    }
    if req.html.trim().is_empty() {
        return err_resp(StatusCode::BAD_REQUEST, "HTML 内容为空，已拒绝写入");
    }

    let candidate = state.config.html_dir.join(format!("{}.html", title));
    let target = match std::fs::canonicalize(&candidate) {
        Ok(p) if p.is_file() && p.starts_with(&state.config.html_dir) => p,
        _ => return err_resp(StatusCode::NOT_FOUND, "目标 HTML 页面不存在"),
    };

    if let Err(e) = write_atomic(&target, &req.html, true) {
        return err_resp(StatusCode::INTERNAL_SERVER_ERROR, e);
    }

    state.logs.info(format!("[api] 已保存双语页: {}.html", title));
    Json(json!({ "ok": true })).into_response()
}

pub async fn put_md(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PutMdReq>,
) -> Response {
    let _busy = state.runtime.begin_op();
    let segs = match validate_rel_md_path(&req.path) {
        Some(s) => s,
        None => return err_resp(StatusCode::BAD_REQUEST, "非法 Markdown 路径"),
    };
    if req.content.trim().is_empty() {
        return err_resp(StatusCode::BAD_REQUEST, "Markdown 内容为空，已拒绝写入");
    }

    let state_bg = state.clone();
    let content = req.content;
    let res = tokio::task::spawn_blocking(move || -> Result<(String, String), (StatusCode, String)> {
        let mut target = state_bg.config.repo_root.clone();
        for seg in &segs {
            target.push(seg);
        }

        let parent = match target.parent().and_then(|p| std::fs::canonicalize(p).ok()) {
            Some(p) if p.is_dir() && p.starts_with(&state_bg.config.repo_root) => p,
            _ => return Err((StatusCode::NOT_FOUND, "目标目录不存在或越界".to_string())),
        };
        let final_target = parent.join(segs.last().unwrap());

        if let Err(e) = write_atomic(&final_target, &content, false) {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
        }

        let rel_joined = segs.join("/");
        let latest_ver = match crate::services::md_history::record_if_changed(
            &state_bg.config,
            &rel_joined,
            Some(&state_bg.logs),
        ) {
            Ok((ver, _)) => ver,
            Err(e) => {
                state_bg
                    .logs
                    .warn(format!("[md-hist] 记录 {} 变更失败: {}", rel_joined, e));
                String::new()
            }
        };
        Ok((rel_joined, latest_ver))
    })
    .await;

    match res {
        Ok(Ok((rel_joined, latest_ver))) => {
            state.logs.info(format!("[api] 已保存文件: {}", rel_joined));
            Json(json!({ "ok": true, "ver": latest_ver })).into_response()
        }
        Ok(Err((code, msg))) => err_resp(code, msg),
        Err(e) => err_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("保存任务异常中止: {}", e),
        ),
    }
}

pub async fn post_bookmark(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BookmarkReq>,
) -> Response {
    let _busy = state.runtime.begin_op();
    if let Err(e) = update_bookmark(&state.config, &req.block, &req.title, &req.href) {
        return err_resp(StatusCode::BAD_REQUEST, e);
    }
    state.logs.info(format!("[api] 已更新书签: block={} href={}", req.block, req.href));
    Json(json!({ "ok": true })).into_response()
}
