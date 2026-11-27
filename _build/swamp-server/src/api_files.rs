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

/// 对 canonicalize 后的真实目标路径复核 Markdown 安全边界，防止目录或文件符号链接绕过 _build/.git 禁区
pub(crate) fn validate_canonical_md_target(
    repo_root: &Path,
    canonical_target: &Path,
) -> Option<String> {
    let rel = canonical_target.strip_prefix(repo_root).ok()?;
    let rel_slash = rel.to_string_lossy().replace('\\', "/");
    validate_rel_md_path(&rel_slash).map(|segs| segs.join("/"))
}

pub async fn put_html(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PutHtmlReq>,
) -> Response {
    let _busy = state.runtime.begin_op();
    let title = req.title.trim().to_string();
    if !validate_title(&title) {
        return err_resp(StatusCode::BAD_REQUEST, "非法页面标题");
    }
    if req.html.trim().is_empty() {
        return err_resp(StatusCode::BAD_REQUEST, "HTML 内容为空，已拒绝写入");
    }

    let html_dir = state.config.html_dir.clone();
    let title_bg = title.clone();
    let html = req.html;
    let res = tokio::task::spawn_blocking(move || -> Result<(), (StatusCode, String)> {
        let candidate = html_dir.join(format!("{}.html", title_bg));
        let target = match std::fs::canonicalize(&candidate) {
            Ok(p) if p.is_file() && p.starts_with(&html_dir) => p,
            _ => return Err((StatusCode::NOT_FOUND, "目标 HTML 页面不存在".to_string())),
        };
        write_atomic(&target, &html, true).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
    })
    .await;

    match res {
        Ok(Ok(())) => {
            state.logs.info(format!("[api] 已保存双语页: {}.html", title));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(Err((code, msg))) => err_resp(code, msg),
        Err(e) => err_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("保存任务异常中止: {}", e),
        ),
    }
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
        let Some(rel_joined) =
            validate_canonical_md_target(&state_bg.config.repo_root, &final_target)
        else {
            return Err((
                StatusCode::FORBIDDEN,
                "目标 Markdown 路径规范化后非法或越界".to_string(),
            ));
        };
        if final_target.exists() {
            let canon_file = match std::fs::canonicalize(&final_target) {
                Ok(p) if p.is_file() && p.starts_with(&state_bg.config.repo_root) => p,
                _ => {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "目标 Markdown 文件符号链接越界或非普通文件".to_string(),
                    ));
                }
            };
            if validate_canonical_md_target(&state_bg.config.repo_root, &canon_file).is_none() {
                return Err((
                    StatusCode::FORBIDDEN,
                    "目标 Markdown 真实路径受保护，禁止写入".to_string(),
                ));
            }
        }

        if let Err(e) = write_atomic(&final_target, &content, false) {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
        }

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
    let cfg = state.config.clone();
    let block = req.block;
    let title = req.title;
    let href = req.href;
    let block_log = block.clone();
    let href_log = href.clone();
    let res =
        tokio::task::spawn_blocking(move || update_bookmark(&cfg, &block, &title, &href)).await;

    match res {
        Ok(Ok(())) => {
            state
                .logs
                .info(format!("[api] 已更新书签: block={} href={}", block_log, href_log));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(Err(e)) => err_resp(StatusCode::BAD_REQUEST, e),
        Err(e) => err_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("书签更新任务异常中止: {}", e),
        ),
    }
}
