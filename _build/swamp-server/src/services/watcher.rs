//! 本地文件监听器：驱动 raw JS/CSS 300 ms 热压缩与 HTML 保存广播重载。

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::builder::minify::minify_single_asset;
use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;

/// 启动文件监听器：
/// 1. 监控 src/js/raw、src/css/raw、src/css/font，改动后 300ms 防抖自动热压缩；
/// 2. 监控 html/ 目录，VS Code 落盘保存后实时广播文件名，驱动浏览器自动重载当前页。
pub fn spawn_asset_watcher(
    cfg: ServerConfig,
    logs: Arc<LogBus>,
    html_change_tx: broadcast::Sender<String>,
) {
    std::thread::Builder::new()
        .name("swamp-watcher".to_string())
        .spawn(move || {
            let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
            let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
                Ok(w) => w,
                Err(e) => {
                    logs.warn(format!("[watcher] 初始化文件监听失败: {}", e));
                    return;
                }
            };

            let mut watched_assets = false;
            if cfg.watch_assets {
                for dir in [&cfg.js_raw_dir, &cfg.css_raw_dir] {
                    if dir.is_dir() && watcher.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                        watched_assets = true;
                    }
                }
                if let Some(font_dir) = cfg.font_raw_css.parent() {
                    if font_dir.is_dir()
                        && watcher.watch(font_dir, RecursiveMode::NonRecursive).is_ok()
                    {
                        watched_assets = true;
                    }
                }
            }

            let watched_html = cfg.html_dir.is_dir()
                && watcher
                    .watch(&cfg.html_dir, RecursiveMode::NonRecursive)
                    .is_ok();

            if !watched_assets && !watched_html {
                return;
            }
            let mut parts = Vec::new();
            if watched_assets {
                parts.push("前端资源压缩");
            }
            if watched_html {
                parts.push("html 自动刷新");
            }
            logs.info(format!("[watcher] 已启动文件监听: {}", parts.join(" + ")));

            let canonical_html_dir =
                std::fs::canonicalize(&cfg.html_dir).unwrap_or_else(|_| cfg.html_dir.clone());
            let mut pending: HashSet<PathBuf> = HashSet::new();
            let mut last_event_at: Option<Instant> = None;

            loop {
                match rx.recv_timeout(Duration::from_millis(120)) {
                    Ok(Ok(event)) => {
                        let interesting = matches!(
                            event.kind,
                            EventKind::Modify(_) | EventKind::Create(_)
                        );
                        if interesting {
                            for p in event.paths {
                                if !p.is_file() {
                                    continue;
                                }
                                let is_html_target = p
                                    .extension()
                                    .and_then(|e| e.to_str())
                                    .map(|s| s.eq_ignore_ascii_case("html"))
                                    .unwrap_or(false);
                                if watched_html && is_html_target {
                                    let canon_p =
                                        std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
                                    if canon_p.starts_with(&canonical_html_dir) {
                                        if let Some(stem) =
                                            canon_p.file_stem().and_then(|s| s.to_str())
                                        {
                                            let _ = html_change_tx.send(stem.to_lowercase());
                                        }
                                        continue;
                                    }
                                }
                                if watched_assets {
                                    let is_gen_managed_tail = p
                                        .file_name()
                                        .and_then(|s| s.to_str())
                                        .map(|n| {
                                            n.eq_ignore_ascii_case("sw.js")
                                                || n.eq_ignore_ascii_case("core-list.js")
                                        })
                                        .unwrap_or(false);
                                    if is_gen_managed_tail && crate::builder::is_gen_active_or_recent(1500) {
                                        continue;
                                    }
                                    pending.insert(p);
                                    last_event_at = Some(Instant::now());
                                }
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        logs.warn(format!("[watcher] 监听事件异常: {}", e));
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if let Some(t) = last_event_at {
                    if crate::builder::is_gen_in_progress() {
                        // gen 运行期间暂缓消费但不清空队列，避免丢失 Phase 2/3 期间用户保存的改动
                        if !pending.is_empty() {
                            last_event_at = Some(Instant::now());
                        }
                    } else if t.elapsed() >= Duration::from_millis(300) && !pending.is_empty() {
                        let batch: Vec<PathBuf> = pending.drain().collect();
                        last_event_at = None;
                        for (idx, path) in batch.iter().enumerate() {
                            let Some(_asset_lock) = crate::builder::try_acquire_asset_lock() else {
                                for rem in &batch[idx..] {
                                    pending.insert(rem.clone());
                                }
                                last_event_at = Some(Instant::now());
                                break;
                            };
                            if crate::builder::is_gen_in_progress() {
                                for rem in &batch[idx..] {
                                    pending.insert(rem.clone());
                                }
                                last_event_at = Some(Instant::now());
                                break;
                            }
                            match minify_single_asset(&cfg, path) {
                                Ok(Some(label)) => {
                                    logs.info(format!("[watcher] 已压缩 -> {}", label));
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    logs.error(format!("[watcher] 压缩失败: {}", e));
                                }
                            }
                        }
                    }
                }

            }
        })
        .ok();
}
