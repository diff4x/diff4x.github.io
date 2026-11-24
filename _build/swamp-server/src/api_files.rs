use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

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

pub fn write_atomic(target: &Path, content: &str, with_bom: bool) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "非法文件名".to_string())?;

    let tmp_name = format!("{}.{}.swamp.tmp", file_name, std::process::id());
    let tmp_path = parent.join(tmp_name);

    let mut bytes = Vec::with_capacity(content.len() + if with_bom { 3 } else { 0 });
    if with_bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(content.as_bytes());

    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;
    if let Err(e) = std::fs::rename(&tmp_path, target) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("原子替换目标文件失败: {}", e));
    }
    Ok(())
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

    state.logs.info(format!("[api] 已固化双语页: {}.html", title));
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

    let mut target = state.config.repo_root.clone();
    for seg in &segs {
        target.push(seg);
    }

    let parent = match target.parent().and_then(|p| std::fs::canonicalize(p).ok()) {
        Some(p) if p.is_dir() && p.starts_with(&state.config.repo_root) => p,
        _ => return err_resp(StatusCode::NOT_FOUND, "目标目录不存在或越界"),
    };
    let final_target = parent.join(segs.last().unwrap());

    if let Err(e) = write_atomic(&final_target, &req.content, false) {
        return err_resp(StatusCode::INTERNAL_SERVER_ERROR, e);
    }

    state.logs.info(format!("[api] 已固化 Markdown: {}", segs.join("/")));
    Json(json!({ "ok": true })).into_response()
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
