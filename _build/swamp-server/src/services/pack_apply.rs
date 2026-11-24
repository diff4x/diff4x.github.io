use chrono::Local;
use ignore::gitignore::GitignoreBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::config::{strip_verbatim_prefix, ServerConfig};

const DEFAULT_HIDDEN_DIRS: &[&str] = &[
    "gallery",
    "video",
    "audio",
    "ebook",
    "html",
    "src/third",
    "src/wasm",
    "src/js/data",
    "src/js/source-map",
    "src/css/source-map",
    "_build/temp",
    "_build/woff2_split",
];

const ALWAYS_SHOW_FILES: &[&str] = &[
    "src/third/pdfjs/web/viewer.mjs",
    "src/third/bibi/presets/default.js",
    "_build/swamp.toml",
    "_build/swamp-server/build.bat",
];

const HARD_BLOCKED_PREFIXES: &[&str] = &[
    ".git/",
    "_build/privy/",
    "_build/temp/",
    "_build/secrets/",
    "_build/backup/",
    "node_modules/",
    "_build/swamp-server/target/",
    "_build/rust/target/",
    "_build/rust/swamp-server/target/",
    "_build/rs/target/",
    "_build/rs/swamp-server/target/",
];

#[derive(Serialize, Clone, Debug)]
pub struct PackFileItem {
    pub rel: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PackZipResult {
    pub file_name: String,
    pub full_path: String,
    pub packed_count: usize,
    pub skipped_count: usize,
    pub zip_size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ApplyEntryInfo {
    pub rel: String,
    pub size: u64,
    pub exists: bool,
    pub blocked: bool,
    pub is_secret: bool,
    pub is_skip_doc: bool,
    pub default_checked: bool,
    pub status: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ApplyResult {
    pub overwritten: usize,
    pub created: usize,
    pub backup_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ApplyManifest {
    #[serde(rename = "appliedAt")]
    pub applied_at: String,
    #[serde(rename = "sourceZip")]
    pub source_zip: String,
    pub overwritten: Vec<String>,
    pub created: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct BackupInfo {
    pub name: String,
    pub applied_at: String,
    pub overwritten_count: usize,
    pub created_count: usize,
}

pub fn is_hard_private_rel(rel: &str) -> bool {
    let low = rel.to_ascii_lowercase();
    for pfx in HARD_BLOCKED_PREFIXES {
        if low.starts_with(pfx) {
            return true;
        }
    }
    if low.starts_with("html/__") && low.ends_with(".html") {
        return true;
    }
    if low.starts_with("src/js/data/shadow") {
        return true;
    }
    if low.ends_with("/cilin.txt") || low == "cilin.txt" || low == "protocol.key"
        || low.ends_with("/protocol.key")
        || low == "credentials.json"
        || low.ends_with("/credentials.json")
        || low == "tokens.json"
        || low.ends_with("/tokens.json")
    {
        return true;
    }
    false
}

fn is_default_excluded_pack_file(rel: &str) -> bool {
    static EX_RE: OnceLock<Regex> = OnceLock::new();
    let re = EX_RE.get_or_init(|| {
        Regex::new(r"(?i)^(src/js/[^/]+\.js|src/css/[^/]+\.css|sw\.js|src/js/data/shadow.*|html/__.*\.html|.*\.map|.*\.exe|.*\.dll|.*\.jar|.*\.wasm|.*\.zip|.*\.png|.*\.jpg|.*\.jpeg|.*\.webp|.*\.gif|.*\.mp3|.*\.mp4|.*\.mkv|.*\.pdf|.*\.epub|.*\.woff2?)$").unwrap()
    });
    re.is_match(rel)
}

pub fn resolve_safe_target(repo_root: &Path, raw_entry: &str) -> Option<(String, PathBuf)> {
    let clean = raw_entry.replace('\\', "/").trim().to_string();
    if clean.is_empty() || clean.starts_with('/') {
        return None;
    }
    if clean.len() >= 2 && clean.as_bytes()[1] == b':' {
        return None;
    }
    if clean
        .chars()
        .any(|c| (c as u32) <= 0x1F || (c as u32) == 0x7F || ":*?\"<>|".contains(c))
    {
        return None;
    }
    let mut full = repo_root.to_path_buf();
    let mut segs = Vec::new();
    for seg in clean.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        full.push(seg);
        segs.push(seg);
    }
    if !full.starts_with(repo_root) {
        return None;
    }
    Some((segs.join("/"), full))
}

pub fn load_presets_json(cfg: &ServerConfig) -> Value {
    let (skip_re, presets) = crate::config::read_pack_presets(cfg);
    json!({
        "version": 2,
        "skipApplyDocRegex": skip_re,
        "presets": presets
    })
}

pub fn list_pack_files(cfg: &ServerConfig, include_more_dirs: bool) -> Result<Vec<PackFileItem>, String> {
    let mut gi_builder = GitignoreBuilder::new(&cfg.repo_root);
    if cfg.gitignore_file.is_file() {
        let _ = gi_builder.add(&cfg.gitignore_file);
    }
    let gi = gi_builder.build().ok();

    let always_set: HashSet<&str> = ALWAYS_SHOW_FILES.iter().copied().collect();
    let mut items = Vec::new();

    let walker = WalkDir::new(&cfg.repo_root).into_iter().filter_entry(|e| {
        if e.path() == cfg.repo_root {
            return true;
        }
        let Ok(rel_p) = e.path().strip_prefix(&cfg.repo_root) else {
            return false;
        };
        let rel = rel_p.to_string_lossy().replace('\\', "/");
        if e.file_type().is_dir() {
            let rel_slash = format!("{}/", rel);
            if is_hard_private_rel(&rel_slash) {
                return false;
            }
            if !include_more_dirs {
                for hd in DEFAULT_HIDDEN_DIRS {
                    if rel.eq_ignore_ascii_case(hd) {
                        let has_white = ALWAYS_SHOW_FILES
                            .iter()
                            .any(|wf| wf.to_ascii_lowercase().starts_with(&rel_slash.to_ascii_lowercase()));
                        if !has_white {
                            return false;
                        }
                    }
                }
            }
        }
        true
    });

    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel_p) = entry.path().strip_prefix(&cfg.repo_root) else {
            continue;
        };
        let rel = rel_p.to_string_lossy().replace('\\', "/");
        if is_hard_private_rel(&rel) {
            continue;
        }

        // 用 .gitignore 过滤私有文件（保留 oov_report.txt 方便调优同义词）
        if let Some(ref g) = gi {
            if !rel.eq_ignore_ascii_case("_build/synonyms/oov_report.txt")
                && g.matched_path_or_any_parents(Path::new(&rel), false).is_ignore()
            {
                continue;
            }
        }

        let in_always = always_set.contains(rel.as_str());
        if !include_more_dirs && !in_always {
            let low = rel.to_ascii_lowercase();
            let in_hidden = DEFAULT_HIDDEN_DIRS
                .iter()
                .any(|hd| low.starts_with(&format!("{}/", hd)));
            if in_hidden || is_default_excluded_pack_file(&rel) {
                continue;
            }
        }

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        items.push(PackFileItem { rel, size });
    }

    items.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(items)
}

pub fn list_git_modified(cfg: &ServerConfig) -> Vec<String> {
    let repo_dir = strip_verbatim_prefix(&cfg.repo_root);
    let Ok(out) = Command::new("git")
        .args(["-c", "core.quotepath=false", "status", "--porcelain"])
        .current_dir(&repo_dir)
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = &line[..2];
        if status.contains('D') {
            continue;
        }
        let mut p = line[3..].trim();
        if let Some((_, rhs)) = p.split_once(" -> ") {
            p = rhs.trim();
        }
        let clean = p.trim_matches('"').replace('\\', "/");
        if clean.is_empty() || is_hard_private_rel(&clean) {
            continue;
        }
        if let Some((rel, full)) = resolve_safe_target(&cfg.repo_root, &clean) {
            if full.is_file() {
                list.push(rel);
            }
        }
    }
    list.sort();
    list.dedup();
    list
}

pub fn create_pack_zip(cfg: &ServerConfig, rel_paths: &[String]) -> Result<PackZipResult, String> {
    if rel_paths.is_empty() {
        return Err("请至少勾选一个文件".to_string());
    }
    fs::create_dir_all(&cfg.backup_dir).map_err(|e| format!("创建 backup 目录失败: {}", e))?;

    let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let file_name = format!("ai_pack_{}.zip", stamp);
    let zip_path = cfg.backup_dir.join(&file_name);

    let mut sorted: Vec<String> = rel_paths.to_vec();
    sorted.sort();
    sorted.dedup();

    let mut packed_count = 0usize;
    let mut skipped_count = 0usize;

    {
        let file = File::create(&zip_path).map_err(|e| format!("创建 ZIP 失败: {}", e))?;
        let mut writer = ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        for rel in &sorted {
            let Some((clean_rel, full)) = resolve_safe_target(&cfg.repo_root, rel) else {
                skipped_count += 1;
                continue;
            };
            if is_hard_private_rel(&clean_rel) || !full.is_file() {
                skipped_count += 1;
                continue;
            }
            let bytes = fs::read(&full).map_err(|e| format!("读取 {} 失败: {}", clean_rel, e))?;
            writer
                .start_file(&clean_rel, opts)
                .map_err(|e| format!("写入 ZIP 条目失败: {}", e))?;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("写出 ZIP 数据失败: {}", e))?;
            packed_count += 1;
        }
        writer.finish().map_err(|e| format!("关闭 ZIP 失败: {}", e))?;
    }

    if packed_count == 0 {
        let _ = fs::remove_file(&zip_path);
        return Err("没有可打包的有效文件".to_string());
    }

    let zip_size = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    Ok(PackZipResult {
        file_name,
        full_path: strip_verbatim_prefix(&zip_path).to_string_lossy().into_owned(),
        packed_count,
        skipped_count,
        zip_size,
    })
}

pub fn inspect_apply_zip(cfg: &ServerConfig, zip_bytes: &[u8]) -> Result<Vec<ApplyEntryInfo>, String> {
    let presets = load_presets_json(cfg);
    let skip_re_str = presets
        .get("skipApplyDocRegex")
        .and_then(|v| v.as_str())
        .unwrap_or(r"^(APPLY_AND_VERIFY|UPGRADE_.*|PATCH_NOTES|README_PATCH)\.md$");
    let skip_re = Regex::new(&format!("(?i){}", skip_re_str)).ok();

    let mut archive =
        ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("无效的 ZIP 文件: {}", e))?;
    let mut entries = Vec::new();

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
        let raw_name = entry.name().to_string();
        if raw_name.is_empty() || raw_name.ends_with('/') || raw_name.ends_with('\\') {
            continue;
        }

        let Some((rel, full)) = resolve_safe_target(&cfg.repo_root, &raw_name) else {
            entries.push(ApplyEntryInfo {
                rel: raw_name,
                size: entry.size(),
                exists: false,
                blocked: true,
                is_secret: false,
                is_skip_doc: false,
                default_checked: false,
                status: "blocked".to_string(),
            });
            continue;
        };

        let low = rel.to_ascii_lowercase();
        if low.starts_with(".git/") {
            entries.push(ApplyEntryInfo {
                rel,
                size: entry.size(),
                exists: false,
                blocked: true,
                is_secret: true,
                is_skip_doc: false,
                default_checked: false,
                status: "blocked".to_string(),
            });
            continue;
        }

        let exists = full.is_file();
        let is_secret = low.starts_with("_build/privy/") || low.starts_with("_build/secrets/");
        let is_skip_doc = !rel.contains('/')
            && skip_re.as_ref().map(|r| r.is_match(&rel)).unwrap_or(false);
        let default_checked = !is_secret && !is_skip_doc;
        let status = if is_secret {
            "secret"
        } else if is_skip_doc {
            "skip_doc"
        } else if exists {
            "overwrite"
        } else {
            "new"
        };

        entries.push(ApplyEntryInfo {
            rel,
            size: entry.size(),
            exists,
            blocked: false,
            is_secret,
            is_skip_doc,
            default_checked,
            status: status.to_string(),
        });
    }

    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(entries)
}

fn write_bytes_with_encoding_guard(
    target_full: &Path,
    raw_bytes: &[u8],
    fix_win_encoding: bool,
) -> Result<(), String> {
    if let Some(parent) = target_full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    let ext = target_full
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mut owned: Vec<u8> = Vec::new();
    let final_bytes: &[u8] = if fix_win_encoding && matches!(ext.as_str(), "bat" | "cmd" | "ps1") {
        let stripped = if raw_bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            &raw_bytes[3..]
        } else {
            raw_bytes
        };
        let text = String::from_utf8_lossy(stripped)
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', "\r\n");
        if ext == "ps1" {
            owned.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        owned.extend_from_slice(text.as_bytes());
        &owned
    } else {
        raw_bytes
    };

    let tmp = target_full.with_extension("aisync.tmp");
    fs::write(&tmp, final_bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;
    if let Err(e) = fs::rename(&tmp, target_full) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换目标文件失败 ({}): {}", target_full.display(), e));
    }
    Ok(())
}

pub fn execute_apply_zip(
    cfg: &ServerConfig,
    source_name: &str,
    zip_bytes: &[u8],
    selected_rels: &[String],
    auto_backup: bool,
    fix_win_encoding: bool,
) -> Result<ApplyResult, String> {
    let selected: HashSet<String> = selected_rels
        .iter()
        .map(|s| s.replace('\\', "/").trim().to_string())
        .collect();
    if selected.is_empty() {
        return Err("未选中任何回填条目".to_string());
    }

    let mut archive =
        ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("解析 ZIP 失败: {}", e))?;

    let mut backup_name = String::new();
    let mut backup_dir: Option<PathBuf> = None;
    if auto_backup {
        let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        backup_name = format!("ai_apply_{}", stamp);
        let dir = cfg.backup_dir.join(&backup_name);
        fs::create_dir_all(&dir).map_err(|e| format!("创建回滚备份目录失败: {}", e))?;
        backup_dir = Some(dir);
    }

    let mut overwritten_list = Vec::new();
    let mut created_list = Vec::new();

    // 按条目映射提取选中项
    let mut buf = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
        let raw_name = entry.name().to_string();
        if raw_name.is_empty() || raw_name.ends_with('/') || raw_name.ends_with('\\') {
            continue;
        }
        let Some((rel, full)) = resolve_safe_target(&cfg.repo_root, &raw_name) else {
            continue;
        };
        if rel.to_ascii_lowercase().starts_with(".git/") || !selected.contains(&rel) {
            continue;
        }

        let exists = full.is_file();
        if exists {
            overwritten_list.push(rel.clone());
            if let Some(ref bdir) = backup_dir {
                let mut bak_path = bdir.clone();
                for seg in rel.split('/') {
                    bak_path.push(seg);
                }
                if let Some(bp) = bak_path.parent() {
                    fs::create_dir_all(bp).map_err(|e| format!("创建备份父目录失败: {}", e))?;
                }
                fs::copy(&full, &bak_path).map_err(|e| format!("备份 {} 失败: {}", rel, e))?;
            }
        } else {
            created_list.push(rel.clone());
        }

        buf.clear();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压 {} 失败: {}", rel, e))?;
        write_bytes_with_encoding_guard(&full, &buf, fix_win_encoding)?;
    }

    if let Some(ref bdir) = backup_dir {
        let manifest = ApplyManifest {
            applied_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            source_zip: source_name.to_string(),
            overwritten: overwritten_list.clone(),
            created: created_list.clone(),
        };
        let mf_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("序列化回滚清单失败: {}", e))?;
        fs::write(bdir.join("_manifest.json"), mf_json.as_bytes())
            .map_err(|e| format!("写入 _manifest.json 失败: {}", e))?;
    }

    Ok(ApplyResult {
        overwritten: overwritten_list.len(),
        created: created_list.len(),
        backup_name,
    })
}

pub fn list_apply_backups(cfg: &ServerConfig) -> Vec<BackupInfo> {
    let mut list = Vec::new();
    if !cfg.backup_dir.is_dir() {
        return list;
    }
    let Ok(rd) = fs::read_dir(&cfg.backup_dir) else {
        return list;
    };
    for ent in rd.filter_map(|e| e.ok()) {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.starts_with("ai_apply_") {
            continue;
        }
        let mf_path = p.join("_manifest.json");
        if let Ok(raw) = fs::read_to_string(&mf_path) {
            if let Ok(mf) = serde_json::from_str::<ApplyManifest>(&raw) {
                list.push(BackupInfo {
                    name,
                    applied_at: mf.applied_at,
                    overwritten_count: mf.overwritten.len(),
                    created_count: mf.created.len(),
                });
            }
        }
    }
    list.sort_by(|a, b| b.name.cmp(&a.name));
    list
}

pub fn rollback_apply_backup(cfg: &ServerConfig, backup_name: &str) -> Result<(usize, usize), String> {
    if !backup_name.starts_with("ai_apply_")
        || backup_name.contains('/')
        || backup_name.contains('\\')
        || backup_name.contains("..")
    {
        return Err("非法备份目录名".to_string());
    }
    let chosen_dir = cfg.backup_dir.join(backup_name);
    let mf_path = chosen_dir.join("_manifest.json");
    if !mf_path.is_file() {
        return Err("备份目录缺少 _manifest.json，无法回滚".to_string());
    }
    let raw = fs::read_to_string(&mf_path).map_err(|e| format!("读取 _manifest.json 失败: {}", e))?;
    let mf: ApplyManifest =
        serde_json::from_str(&raw).map_err(|e| format!("解析 _manifest.json 失败: {}", e))?;

    let mut restored = 0usize;
    let mut removed = 0usize;

    for rel in &mf.overwritten {
        let Some((clean, full)) = resolve_safe_target(&cfg.repo_root, rel) else {
            continue;
        };
        let mut src_bak = chosen_dir.clone();
        for seg in clean.split('/') {
            src_bak.push(seg);
        }
        if src_bak.is_file() {
            if let Some(p) = full.parent() {
                let _ = fs::create_dir_all(p);
            }
            fs::copy(&src_bak, &full).map_err(|e| format!("还原 {} 失败: {}", clean, e))?;
            restored += 1;
        }
    }

    for rel in &mf.created {
        let Some((_, full)) = resolve_safe_target(&cfg.repo_root, rel) else {
            continue;
        };
        if full.is_file() {
            let _ = fs::remove_file(&full);
            removed += 1;
        }
    }

    Ok((restored, removed))
}
