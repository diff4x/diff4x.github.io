use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::path::Path;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

use crate::security::{validate_static_request_path, AppState, RunMode};

pub async fn handle_static(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    req_headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }

    let segs = match validate_static_request_path(uri.path(), state.mode) {
        Some(s) => s,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let mut candidate = state.config.repo_root.clone();
    for seg in &segs {
        candidate.push(seg);
    }

    let canonical = match tokio::fs::canonicalize(&candidate).await {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    if !canonical.starts_with(&state.config.repo_root) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let meta = match tokio::fs::metadata(&canonical).await {
        Ok(m) if m.is_file() => m,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    let file_len = meta.len();
    let mime = guess_mime(&canonical);
    let cache_ctrl = match state.mode {
        RunMode::Serve => "no-store",
        RunMode::Sim => "no-cache",
    };

    if let Some(range_val) = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(parsed) = parse_single_byte_range(range_val, file_len) {
            match parsed {
                Ok((start, end)) => {
                    let chunk_len = end - start + 1;
                    let builder = Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(
                            header::CONTENT_RANGE,
                            format!("bytes {}-{}/{}", start, end, file_len),
                        )
                        .header(header::CONTENT_LENGTH, chunk_len.to_string())
                        .header(header::CACHE_CONTROL, cache_ctrl);

                    if method == Method::HEAD {
                        return builder.body(Body::empty()).unwrap_or_else(|_| {
                            StatusCode::INTERNAL_SERVER_ERROR.into_response()
                        });
                    }

                    let mut file = match File::open(&canonical).await {
                        Ok(f) => f,
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    };
                    if file.seek(SeekFrom::Start(start)).await.is_err() {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                    let stream = ReaderStream::with_capacity(file.take(chunk_len), 65536);
                    return builder
                        .body(Body::from_stream(stream))
                        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                }
                Err(()) => {
                    return Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{}", file_len))
                        .body(Body::empty())
                        .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response());
                }
            }
        }
    }

    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, file_len.to_string())
        .header(header::CACHE_CONTROL, cache_ctrl);

    if method == Method::HEAD {
        return builder
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let file = match File::open(&canonical).await {
        Ok(f) => f,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let stream = ReaderStream::with_capacity(file, 65536);

    if state.verbose {
        println!("[static] 200 {} ({} bytes)", uri.path(), file_len);
    }

    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 解析 HTTP 单区间 Range 请求头（如 bytes=0-1023 / bytes=500- / bytes=-500）
fn parse_single_byte_range(header_val: &str, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header_val.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // 多段范围回退整文件 200
    }
    if total == 0 {
        return Some(Err(()));
    }
    let (start_str, end_str) = spec.split_once('-')?;
    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 {
            return Some(Err(()));
        }
        let start = total.saturating_sub(suffix);
        return Some(Ok((start, total - 1)));
    }

    let start: u64 = start_str.parse().ok()?;
    if start >= total {
        return Some(Err(()));
    }

    let end = if end_str.is_empty() {
        total - 1
    } else {
        let e: u64 = end_str.parse().ok()?;
        if e < start {
            return Some(Err(()));
        }
        e.min(total - 1)
    };

    Some(Ok((start, end)))
}

fn guess_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("md") | Some("markdown") => "text/markdown; charset=utf-8",
        Some("txt") | Some("log") => "text/plain; charset=utf-8",
        Some("vtt") => "text/vtt; charset=utf-8",
        Some("ftl") => "text/plain; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("aac") => "audio/aac",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("ogv") => "video/ogg",
        Some("pdf") => "application/pdf",
        Some("epub") => "application/epub+zip",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}
