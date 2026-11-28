//! 站点构建编排入口与双锁并发控制（GEN_LOCK 单飞构建 -> ASSET_LOCK 互斥热压缩）。

pub mod generator;
pub mod html_utils;
pub mod minify;
pub mod synonyms;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;

static GEN_LOCK: Mutex<()> = Mutex::new(());
static ASSET_LOCK: Mutex<()> = Mutex::new(());
static GEN_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static LAST_GEN_FINISHED_MS: AtomicU64 = AtomicU64::new(0);

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_gen_in_progress() -> bool {
    GEN_IN_PROGRESS.load(Ordering::SeqCst)
}

pub fn is_gen_active_or_recent(cooldown_ms: u64) -> bool {
    if GEN_IN_PROGRESS.load(Ordering::SeqCst) {
        return true;
    }
    let last = LAST_GEN_FINISHED_MS.load(Ordering::SeqCst);
    last > 0 && now_epoch_ms().saturating_sub(last) < cooldown_ms
}

/// 供 File Watcher 热压缩使用：仅非阻塞获取资源锁，避免与 gen 竞态，同时绝不导致手动点 gen 误报“正在运行”
pub fn try_acquire_asset_lock() -> Option<MutexGuard<'static, ()>> {
    if GEN_IN_PROGRESS.load(Ordering::SeqCst) {
        return None;
    }
    match ASSET_LOCK.try_lock() {
        Ok(g) => Some(g),
        Err(TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

struct GenProgressGuard;

impl Drop for GenProgressGuard {
    fn drop(&mut self) {
        LAST_GEN_FINISHED_MS.store(now_epoch_ms(), Ordering::SeqCst);
        GEN_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn log_info(logs: Option<&LogBus>, msg: impl Into<String>) {
    let s = msg.into();
    if let Some(bus) = logs {
        bus.info(s);
    } else {
        println!("{}", s);
    }
}

pub(crate) fn log_warn(logs: Option<&LogBus>, msg: impl Into<String>) {
    let s = msg.into();
    if let Some(bus) = logs {
        bus.warn(s);
    } else {
        println!("{}", s);
    }
}

/// 全量构建管线：`swamp gen`
pub fn run_gen(cfg: &ServerConfig) -> Result<(), String> {
    run_gen_with_options(cfg, None, false)
}

/// 带日志总线的单飞全量构建管线（GUI / HTTP API 调用，防并发覆盖与 Watcher 竞态）
pub fn run_gen_with_logger(cfg: &ServerConfig, logs: Option<&LogBus>) -> Result<(), String> {
    run_gen_with_options(cfg, logs, false)
}

/// 支持强制重建同义词的单飞全量构建管线（避免先单独扫描再 gen 的双重全库扫描）
pub fn run_gen_with_options(
    cfg: &ServerConfig,
    logs: Option<&LogBus>,
    force_synonyms: bool,
) -> Result<(), String> {
    let _lock = match GEN_LOCK.try_lock() {
        Ok(g) => g,
        Err(TryLockError::Poisoned(p)) => p.into_inner(),
        Err(TryLockError::WouldBlock) => {
            return Err("构建任务正在运行，请等待完成后重试".to_string());
        }
    };
    GEN_IN_PROGRESS.store(true, Ordering::SeqCst);
    let _progress_guard = GenProgressGuard;
    // 等待正在进行中的单文件热压缩收尾（毫秒级），随后全程持有 ASSET_LOCK 阻断并发热写
    let _asset_lock = match ASSET_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };

    let t0 = Instant::now();
    log_info(logs, "[gen] 开始构建站点");

    let mut ledger = minify::IncrementalLedger::load(cfg);

    minify::build_phase1_assets(cfg, &mut ledger, logs)?;
    let active_ver = generator::run_with_options(cfg, logs, force_synonyms)?;
    minify::build_phase3_tail(cfg, &mut ledger, active_ver.as_deref(), logs)?;

    ledger.save()?;
    log_info(
        logs,
        format!(
            "[gen] 构建完成，耗时 {:.2}s",
            t0.elapsed().as_secs_f64()
        ),
    );
    Ok(())
}
