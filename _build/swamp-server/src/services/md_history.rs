use chrono::{DateTime, Duration as ChronoDuration, Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use walkdir::WalkDir;

use crate::api_files::write_atomic;
use crate::builder::minify::sha256_hex;
use crate::config::ServerConfig;
use crate::security::validate_rel_md_path;
use crate::services::log_bus::LogBus;

/// 倒退追踪的历史差异上限：1 个当前落盘版 + 至多 50 个历史倒退版 = 共 51 版
pub const MAX_HISTORY_DELTAS: usize = 50;
/// 外部编辑器（如 VS Code 自动保存）短时间连续落盘合并窗口（秒）
pub const WATCHER_COALESCE_SECS: i64 = 60;

static MD_HIST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeltaHunk {
    pub new_start: usize,
    pub new_len: usize,
    pub old_lines: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MdDelta {
    /// 变更后落盘的新版名 (yymmddhhmmss)
    pub ver: String,
    /// 变更前的旧版名 (yymmddhhmmss)
    pub from_ver: String,
    /// 旧版完整内容的 SHA-256，用于还原一致性校验
    pub old_sha256: String,
    /// 相对于旧版新增的行数
    pub added: usize,
    /// 相对于旧版删除的行数
    pub deleted: usize,
    /// 反向补丁块（将 ver 文本回退为 from_ver 文本）
    pub hunks: Vec<DeltaHunk>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MdHistoryStore {
    pub rel_path: String,
    pub head_ver: String,
    pub head_sha256: String,
    pub head_text: String,
    /// 按时间从新到旧排列：deltas[0] 表示 head_ver -> 上一版
    pub deltas: Vec<MdDelta>,
}

#[derive(Serialize, Clone, Debug)]
pub struct MdVersionMeta {
    pub ver: String,
    pub is_latest: bool,
    pub added: usize,
    pub deleted: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct MdHistoryListing {
    pub rel_path: String,
    pub latest_ver: String,
    pub versions: Vec<MdVersionMeta>,
}

pub fn is_valid_md_ver(ver: &str) -> bool {
    ver.len() == 12
        && ver.bytes().all(|b| b.is_ascii_digit())
        && NaiveDateTime::parse_from_str(ver, "%y%m%d%H%M%S").is_ok()
}

pub fn next_monotonic_ver(prev_ver: &str, now_ver: &str) -> String {
    if now_ver > prev_ver {
        return now_ver.to_string();
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(prev_ver, "%y%m%d%H%M%S") {
        return (dt + ChronoDuration::seconds(1))
            .format("%y%m%d%H%M%S")
            .to_string();
    }
    now_ver.to_string()
}

fn format_now_ver() -> String {
    Local::now().format("%y%m%d%H%M%S").to_string()
}

fn format_mtime_ver(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|st| DateTime::<Local>::from(st).format("%y%m%d%H%M%S").to_string())
        .unwrap_or_else(|_| format_now_ver())
}

fn history_dir(cfg: &ServerConfig) -> PathBuf {
    cfg.build_dir.join("temp").join("md_history")
}

fn history_file_for_rel(cfg: &ServerConfig, norm_rel: &str) -> PathBuf {
    let key = sha256_hex(norm_rel.to_ascii_lowercase().as_bytes());
    history_dir(cfg).join(format!("{}.json", &key[..20]))
}

fn resolve_existing_md(cfg: &ServerConfig, raw_path: &str) -> Result<(String, PathBuf), String> {
    let segs = validate_rel_md_path(raw_path).ok_or_else(|| "非法 Markdown 路径".to_string())?;
    let norm_rel = segs.join("/");
    let mut candidate = cfg.repo_root.clone();
    for seg in &segs {
        candidate.push(seg);
    }
    let canon = fs::canonicalize(&candidate)
        .map_err(|_| format!("找不到 Markdown 文件: {}", norm_rel))?;
    if !canon.is_file() || !canon.starts_with(&cfg.repo_root) {
        return Err(format!("Markdown 路径不存在或越界: {}", norm_rel));
    }
    Ok((norm_rel, canon))
}

fn compute_reverse_delta(
    new_text: &str,
    old_text: &str,
    new_ver: &str,
    old_ver: &str,
    old_sha256: &str,
) -> MdDelta {
    let new_lines: Vec<&str> = new_text.split_inclusive('\n').collect();
    let old_lines: Vec<&str> = old_text.split_inclusive('\n').collect();
    // 以 new_lines 为源、old_lines 为目标计算反向补丁：套用到 new_lines 上可无损还原 old_lines
    let ops = capture_diff_slices(Algorithm::Myers, &new_lines, &old_lines);

    let mut hunks = Vec::new();
    let mut added = 0usize;
    let mut deleted = 0usize;

    for op in ops {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                added += old_len;
                hunks.push(DeltaHunk {
                    new_start: old_index,
                    new_len: old_len,
                    old_lines: Vec::new(),
                });
            }
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => {
                deleted += new_len;
                hunks.push(DeltaHunk {
                    new_start: old_index,
                    new_len: 0,
                    old_lines: old_lines[new_index..new_index + new_len]
                        .iter()
                        .map(|s| (*s).to_string())
                        .collect(),
                });
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                added += old_len;
                deleted += new_len;
                hunks.push(DeltaHunk {
                    new_start: old_index,
                    new_len: old_len,
                    old_lines: old_lines[new_index..new_index + new_len]
                        .iter()
                        .map(|s| (*s).to_string())
                        .collect(),
                });
            }
        }
    }

    MdDelta {
        ver: new_ver.to_string(),
        from_ver: old_ver.to_string(),
        old_sha256: old_sha256.to_string(),
        added,
        deleted,
        hunks,
    }
}

fn apply_reverse_hunks(cur_text: &str, hunks: &[DeltaHunk]) -> Result<String, String> {
    let cur_lines: Vec<&str> = cur_text.split_inclusive('\n').collect();
    let mut out = String::with_capacity(cur_text.len());
    let mut cursor = 0usize;

    for h in hunks {
        if h.new_start < cursor || h.new_start.saturating_add(h.new_len) > cur_lines.len() {
            return Err("Markdown 反向差异块索引越界，历史文件可能已损坏".to_string());
        }
        for line in &cur_lines[cursor..h.new_start] {
            out.push_str(line);
        }
        for line in &h.old_lines {
            out.push_str(line);
        }
        cursor = h.new_start + h.new_len;
    }

    for line in &cur_lines[cursor..] {
        out.push_str(line);
    }
    Ok(out)
}

fn within_coalesce_window(head_ver: &str, now_ver: &str, coalesce_secs: i64) -> bool {
    if coalesce_secs <= 0 {
        return false;
    }
    let (Ok(h_dt), Ok(n_dt)) = (
        NaiveDateTime::parse_from_str(head_ver, "%y%m%d%H%M%S"),
        NaiveDateTime::parse_from_str(now_ver, "%y%m%d%H%M%S"),
    ) else {
        return false;
    };
    let diff = (n_dt - h_dt).num_seconds();
    diff >= 0 && diff <= coalesce_secs
}

/// 返回 Some((from_ver, new_ver, added, deleted, coalesced))
fn apply_update_to_store(
    store: &mut MdHistoryStore,
    new_text: String,
    now_ver: &str,
    coalesce_secs: i64,
) -> Option<(String, String, usize, usize, bool)> {
    let new_sha = sha256_hex(new_text.as_bytes());
    if new_sha == store.head_sha256 {
        return None;
    }

    // 短时间连续自动保存合并到最近一条差异块，防止自动保存刷爆 50 版历史（不吞并首次基线）
    if !store.deltas.is_empty() && within_coalesce_window(&store.head_ver, now_ver, coalesce_secs) {
        if let Ok(prev_base) = apply_reverse_hunks(&store.head_text, &store.deltas[0].hunks) {
            if sha256_hex(prev_base.as_bytes()) == store.deltas[0].old_sha256 {
                let base_ver = store.deltas[0].from_ver.clone();
                let base_sha = store.deltas[0].old_sha256.clone();
                // 若在合并窗口内撤回改动回到上一个版本，直接折叠掉空差异
                if new_sha == base_sha {
                    store.deltas.remove(0);
                    store.head_ver = base_ver.clone();
                    store.head_sha256 = base_sha;
                    store.head_text = prev_base;
                    return Some((base_ver.clone(), base_ver, 0, 0, true));
                }
                let new_ver = next_monotonic_ver(&store.head_ver, now_ver);
                let delta =
                    compute_reverse_delta(&new_text, &prev_base, &new_ver, &base_ver, &base_sha);
                let added = delta.added;
                let deleted = delta.deleted;
                store.deltas[0] = delta;
                store.head_ver = new_ver.clone();
                store.head_sha256 = new_sha;
                store.head_text = new_text;
                return Some((base_ver, new_ver, added, deleted, true));
            }
        }
    }

    let prev_ver = store.head_ver.clone();
    let new_ver = next_monotonic_ver(&prev_ver, now_ver);
    let delta = compute_reverse_delta(
        &new_text,
        &store.head_text,
        &new_ver,
        &prev_ver,
        &store.head_sha256,
    );
    let added = delta.added;
    let deleted = delta.deleted;
    store.deltas.insert(0, delta);
    if store.deltas.len() > MAX_HISTORY_DELTAS {
        store.deltas.truncate(MAX_HISTORY_DELTAS);
    }
    store.head_ver = new_ver.clone();
    store.head_sha256 = new_sha;
    store.head_text = new_text;
    Some((prev_ver, new_ver, added, deleted, false))
}

fn reconstruct_from_store(store: &MdHistoryStore, target_ver: &str) -> Result<String, String> {
    if target_ver == store.head_ver {
        return Ok(store.head_text.clone());
    }
    let mut cur = store.head_text.clone();
    for delta in &store.deltas {
        cur = apply_reverse_hunks(&cur, &delta.hunks)?;
        if delta.from_ver == target_ver {
            let actual_sha = sha256_hex(cur.as_bytes());
            if actual_sha != delta.old_sha256 {
                return Err(format!(
                    "还原版本 {} 校验和不匹配，历史差异链可能已损坏",
                    target_ver
                ));
            }
            return Ok(cur);
        }
    }
    Err(format!("未找到历史版本: {}", target_ver))
}

/// 严格区分 NotFound 与 I/O 占用 / JSON 损坏：
/// - 文件不存在：返回 Ok(None) 允许建基线
/// - I/O 失败（如被杀软占用）：返回 Err 拒绝覆盖保护现有历史
/// - JSON 损坏：若允许修复（写路径）先改名留档为 .corrupt 再返回 Ok(None)，若改名失败则拒绝覆盖
fn load_store_checked(
    hist_path: &Path,
    quarantine_corrupt: bool,
    logs: Option<&LogBus>,
) -> Result<Option<MdHistoryStore>, String> {
    let raw = match fs::read_to_string(hist_path) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "读取历史文件 {} 失败（已拒绝覆盖以保护现有版本）: {}",
                hist_path.display(),
                e
            ));
        }
    };

    match serde_json::from_str::<MdHistoryStore>(&raw) {
        Ok(store) => Ok(Some(store)),
        Err(parse_err) => {
            if !quarantine_corrupt {
                return Err(format!(
                    "历史文件 {} 解析失败（只读查询未改动原文件）: {}",
                    hist_path.display(),
                    parse_err
                ));
            }
            let stamp = format_now_ver();
            let corrupt_name = format!(
                "{}.{}.corrupt",
                hist_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("md_history.json"),
                stamp
            );
            let corrupt_path = hist_path.with_file_name(corrupt_name);
            fs::rename(hist_path, &corrupt_path).map_err(|re| {
                format!(
                    "历史文件损坏 ({}) 且改名备份失败 ({})，已拒绝覆盖",
                    parse_err, re
                )
            })?;
            if let Some(bus) = logs {
                bus.warn(format!(
                    "[md-hist] 历史文件解析失败，已留档至 {} 并重建基线: {}",
                    corrupt_path.display(),
                    parse_err
                ));
            }
            Ok(None)
        }
    }
}

fn save_store(hist_path: &Path, store: &MdHistoryStore) -> Result<(), String> {
    if let Some(parent) = hist_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 md_history 目录失败: {}", e))?;
    }
    let json = serde_json::to_string(store)
        .map_err(|e| format!("序列化 md_history 失败: {}", e))?;
    write_atomic(hist_path, &json, false)
}

fn sync_md_locked(
    cfg: &ServerConfig,
    raw_path: &str,
    coalesce_secs: i64,
    logs: Option<&LogBus>,
) -> Result<(MdHistoryStore, bool), String> {
    let (norm_rel, phys_path) = resolve_existing_md(cfg, raw_path)?;
    let bytes = fs::read(&phys_path)
        .map_err(|e| format!("读取 Markdown 失败 ({}): {}", norm_rel, e))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("{} 非 UTF-8 编码，无法跟踪版本", norm_rel))?;
    let hist_path = history_file_for_rel(cfg, &norm_rel);

    if let Some(mut store) = load_store_checked(&hist_path, true, logs)? {
        let now_ver = format_now_ver();
        if let Some((prev_ver, new_ver, added, deleted, coalesced)) =
            apply_update_to_store(&mut store, text, &now_ver, coalesce_secs)
        {
            save_store(&hist_path, &store)?;
            if let Some(bus) = logs {
                let tag = if coalesced { "，合并" } else { "" };
                bus.info(format!(
                    "[md-hist] 更新 {}: {} -> {} (+{}/-{} 行{}，共 {} 版)",
                    norm_rel,
                    prev_ver,
                    new_ver,
                    added,
                    deleted,
                    tag,
                    store.deltas.len() + 1
                ));
            }
            return Ok((store, true));
        }
        return Ok((store, false));
    }

    let init_ver = format_mtime_ver(&phys_path);
    let init_sha = sha256_hex(text.as_bytes());
    let store = MdHistoryStore {
        rel_path: norm_rel.clone(),
        head_ver: init_ver.clone(),
        head_sha256: init_sha,
        head_text: text,
        deltas: Vec::new(),
    };
    save_store(&hist_path, &store)?;
    if let Some(bus) = logs {
        bus.info(format!(
            "[md-hist] 已建立版本基线: {} ({})",
            norm_rel, init_ver
        ));
    }
    Ok((store, true))
}

/// 严格只读加载：绝不向磁盘写任何文件；若磁盘上存在尚未被 watcher 防抖刷入的新改盘，仅在内存中合成最新视图
fn load_effective_store_readonly(
    cfg: &ServerConfig,
    raw_path: &str,
) -> Result<MdHistoryStore, String> {
    let (norm_rel, phys_path) = resolve_existing_md(cfg, raw_path)?;
    let bytes = fs::read(&phys_path)
        .map_err(|e| format!("读取 Markdown 失败 ({}): {}", norm_rel, e))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("{} 非 UTF-8 编码，无法读取版本", norm_rel))?;
    let hist_path = history_file_for_rel(cfg, &norm_rel);

    let mtime_ver = format_mtime_ver(&phys_path);
    if let Some(mut store) = load_store_checked(&hist_path, false, None)? {
        let _ = apply_update_to_store(&mut store, text, &mtime_ver, 0);
        return Ok(store);
    }

    let init_sha = sha256_hex(text.as_bytes());
    Ok(MdHistoryStore {
        rel_path: norm_rel,
        head_ver: mtime_ver,
        head_sha256: init_sha,
        head_text: text,
        deltas: Vec::new(),
    })
}

/// 显式落盘记录（不合并）：用于站内 Save、补丁回填/回滚与启动扫描
pub fn record_if_changed(
    cfg: &ServerConfig,
    raw_path: &str,
    logs: Option<&LogBus>,
) -> Result<(String, bool), String> {
    record_if_changed_with_coalesce(cfg, raw_path, 0, logs)
}

/// 支持短时间连续保存合并的记录入口（供 watcher 外部自动保存使用）
pub fn record_if_changed_with_coalesce(
    cfg: &ServerConfig,
    raw_path: &str,
    coalesce_secs: i64,
    logs: Option<&LogBus>,
) -> Result<(String, bool), String> {
    let _guard = match MD_HIST_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let (store, changed) = sync_md_locked(cfg, raw_path, coalesce_secs, logs)?;
    Ok((store.head_ver, changed))
}

/// 只读获取指定 Markdown 的全部追踪版本列表（最新落盘版在最前，最多共 51 版，不写盘）
pub fn list_versions(cfg: &ServerConfig, raw_path: &str) -> Result<MdHistoryListing, String> {
    let _guard = match MD_HIST_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let store = load_effective_store_readonly(cfg, raw_path)?;

    let mut versions = Vec::with_capacity(store.deltas.len() + 1);
    let (head_add, head_del) = store
        .deltas
        .first()
        .map(|d| (d.added, d.deleted))
        .unwrap_or((0, 0));
    versions.push(MdVersionMeta {
        ver: store.head_ver.clone(),
        is_latest: true,
        added: head_add,
        deleted: head_del,
    });

    for (idx, d) in store.deltas.iter().enumerate() {
        let (prev_add, prev_del) = store
            .deltas
            .get(idx + 1)
            .map(|older| (older.added, older.deleted))
            .unwrap_or((0, 0));
        versions.push(MdVersionMeta {
            ver: d.from_ver.clone(),
            is_latest: false,
            added: prev_add,
            deleted: prev_del,
        });
    }

    Ok(MdHistoryListing {
        rel_path: store.rel_path,
        latest_ver: store.head_ver,
        versions,
    })
}

/// 只读沿反向差异链倒退还原指定 yymmddhhmmss 版本的完整 Markdown 文本（不写盘）
pub fn get_version_content(
    cfg: &ServerConfig,
    raw_path: &str,
    target_ver: &str,
) -> Result<String, String> {
    let ver = target_ver.trim();
    if !is_valid_md_ver(ver) {
        return Err(format!("非法版本号格式（需为 12 位 yymmddhhmmss）: {}", target_ver));
    }
    let _guard = match MD_HIST_LOCK.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let store = load_effective_store_readonly(cfg, raw_path)?;
    reconstruct_from_store(&store, ver)
}

/// 服务启动时扫描仓库内受跟踪的 Markdown 文件：首次建基线，离线期间发生变更则自动补记版本
pub fn scan_and_sync_all_md(cfg: &ServerConfig, logs: Option<&LogBus>) -> usize {
    let mut synced = 0usize;
    let walker = WalkDir::new(&cfg.repo_root).into_iter().filter_entry(|e| {
        if e.path() == cfg.repo_root {
            return true;
        }
        if e.file_type().is_dir() {
            // 任意层级的隐藏目录、node_modules、target 一律跳过
            let dir_name = e.file_name().to_string_lossy();
            if dir_name.starts_with('.')
                || dir_name.eq_ignore_ascii_case("node_modules")
                || dir_name.eq_ignore_ascii_case("target")
            {
                return false;
            }
            if let Ok(rel) = e.path().strip_prefix(&cfg.repo_root) {
                let low = rel.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                if matches!(
                    low.as_str(),
                    "_build"
                        | "gallery"
                        | "audio"
                        | "video"
                        | "ebook"
                        | "html"
                        | "src/third"
                        | "src/wasm"
                        | "src/js/data"
                ) {
                    return false;
                }
            }
        }
        true
    });

    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let is_md = entry
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&cfg.repo_root) else {
            continue;
        };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        if validate_rel_md_path(&rel_s).is_none() {
            continue;
        }
        if let Ok((_, changed)) = record_if_changed(cfg, &rel_s, logs) {
            if changed {
                synced += 1;
            }
        }
    }
    synced
}

pub(crate) fn selftest_reverse_delta_roundtrip() -> bool {
    let samples = [
        "# Title\nline 1\nline 2\nline 3",
        "# Title\nline 1\nline 2 modified\nline 2.5\nline 3\n",
        "# Title v2\r\nline 1\r\nline 3\r\n",
        "",
        "single line without trailing newline",
    ];
    let mut store = MdHistoryStore {
        rel_path: "README.md".to_string(),
        head_ver: "261126100000".to_string(),
        head_sha256: sha256_hex(samples[0].as_bytes()),
        head_text: samples[0].to_string(),
        deltas: Vec::new(),
    };
    let mut vers = vec![("261126100000".to_string(), samples[0])];
    for (idx, text) in samples.iter().enumerate().skip(1) {
        let now_ver = format!("26112610000{}", idx);
        let Some((_, new_ver, _, _, _)) =
            apply_update_to_store(&mut store, (*text).to_string(), &now_ver, 0)
        else {
            return false;
        };
        vers.push((new_ver, *text));
    }
    for (ver, expected) in &vers {
        match reconstruct_from_store(&store, ver) {
            Ok(actual) if actual == *expected => {}
            _ => return false,
        }
    }
    true
}

pub(crate) fn selftest_evict_over_50() -> bool {
    let mut store = MdHistoryStore {
        rel_path: "README.md".to_string(),
        head_ver: "261126120000".to_string(),
        head_sha256: sha256_hex(b"v0\n"),
        head_text: "v0\n".to_string(),
        deltas: Vec::new(),
    };
    let mut recorded: Vec<(String, String)> = vec![("261126120000".to_string(), "v0\n".to_string())];
    for step in 1..=55usize {
        let body = format!("v{}\nline-{}\n", step, step);
        let Some((_, new_ver, _, _, _)) =
            apply_update_to_store(&mut store, body.clone(), "261126120000", 0)
        else {
            return false;
        };
        recorded.push((new_ver, body));
    }
    if store.deltas.len() != MAX_HISTORY_DELTAS {
        return false;
    }
    if reconstruct_from_store(&store, &recorded[0].0).is_ok()
        || reconstruct_from_store(&store, &recorded[4].0).is_ok()
    {
        return false;
    }
    for (ver, expected) in &recorded[5..] {
        match reconstruct_from_store(&store, ver) {
            Ok(actual) if actual == *expected => {}
            _ => return false,
        }
    }
    true
}

pub(crate) fn selftest_coalesce_within_window() -> bool {
    let mut store = MdHistoryStore {
        rel_path: "README.md".to_string(),
        head_ver: "261126100000".to_string(),
        head_sha256: sha256_hex(b"base\n"),
        head_text: "base\n".to_string(),
        deltas: Vec::new(),
    };
    // 第一次修改：不合并进基线，形成 1 条差异
    let r1 = apply_update_to_store(&mut store, "edit1\n".to_string(), "261126100500", 60);
    if !matches!(r1, Some((_, _, _, _, false))) || store.deltas.len() != 1 {
        return false;
    }
    // 20 秒内二次自动保存：合并进 deltas[0]，总差异数保持 1，基线仍可精准还原
    let r2 = apply_update_to_store(&mut store, "edit2\n".to_string(), "261126100520", 60);
    if !matches!(r2, Some((_, _, _, _, true))) || store.deltas.len() != 1 {
        return false;
    }
    if reconstruct_from_store(&store, "261126100000").as_deref() != Ok("base\n") {
        return false;
    }
    // 超出 60 秒窗口后再改：新增第 2 条差异
    let r3 = apply_update_to_store(&mut store, "edit3\n".to_string(), "261126100800", 60);
    matches!(r3, Some((_, _, _, _, false)))
        && store.deltas.len() == 2
        && reconstruct_from_store(&store, "261126100520").as_deref() == Ok("edit2\n")
}

pub(crate) fn selftest_corrupt_store_preserved() -> bool {
    let dir = std::env::temp_dir().join(format!("swamp_selftest_mdh_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let hist = dir.join("broken.json");
    if fs::write(&hist, b"{not valid json").is_err() {
        let _ = fs::remove_dir_all(&dir);
        return false;
    }
    // 只读模式应报错且不改名
    let ro_err = load_store_checked(&hist, false, None).is_err() && hist.is_file();
    // 写路径修复模式应留档为 .corrupt 并返回 Ok(None)
    let rw_ok = matches!(load_store_checked(&hist, true, None), Ok(None)) && !hist.is_file();
    let has_corrupt = fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().ends_with(".corrupt"))
        })
        .unwrap_or(false);
    let _ = fs::remove_dir_all(&dir);
    ro_err && rw_ok && has_corrupt
}
