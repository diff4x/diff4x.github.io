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

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::api_files::{write_atomic, write_bytes_atomic};
use crate::config::{strip_verbatim_prefix, ServerConfig};
use crate::security::is_short_name_segment;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_APPLY_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_APPLY_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

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
    pub md_dir: Option<String>,
    pub md_files: Vec<String>,
    pub md_skipped_binary: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct ApplyEntryInfo {
    pub rel: String,
    pub size: u64,
    pub exists: bool,
    pub blocked: bool,
    pub is_secret: bool,
    pub is_dangerous: bool,
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

#[derive(Serialize, Clone, Debug)]
pub struct BackupTreeItem {
    pub rel: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct DownloadTreeItem {
    pub rel: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_zip: bool,
    pub child_count: usize,
}

pub fn is_hard_private_rel(rel: &str) -> bool {
    let low = rel.to_ascii_lowercase();
    if low == ".git" {
        return true;
    }
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

/// 判定补丁条目是否属于构建期/配置期会被执行或影响隐私防线的高危文件
pub fn is_build_or_exec_rel(rel: &str) -> bool {
    let low = rel.replace('\\', "/").to_ascii_lowercase();
    if low == ".gitignore"
        || low == "_build/swamp.toml"
        || low.starts_with(".github/")
        || low.starts_with(".cargo/")
        || low.starts_with("_build/swamp-server/.cargo/")
        || low == "cargo.toml"
        || low.ends_with("/cargo.toml")
        || low == "cargo.lock"
        || low.ends_with("/cargo.lock")
        || low == "build.rs"
        || low.ends_with("/build.rs")
        || low == "build.bat"
        || low.ends_with("/build.bat")
    {
        return true;
    }
    let ext = Path::new(&low)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "bat" | "cmd" | "ps1" | "exe" | "dll" | "msi" | "vbs" | "scr"
    )
}

fn is_default_excluded_pack_file(rel: &str) -> bool {
    static EX_RE: OnceLock<Regex> = OnceLock::new();
    let re = EX_RE.get_or_init(|| {
        Regex::new(r"(?i)^(src/js/[^/]+\.js|src/css/[^/]+\.css|sw\.js|src/js/data/shadow.*|html/__.*\.html|.*\.map|.*\.exe|.*\.dll|.*\.jar|.*\.wasm|.*\.zip|.*\.png|.*\.jpg|.*\.jpeg|.*\.webp|.*\.gif|.*\.mp3|.*\.mp4|.*\.mkv|.*\.pdf|.*\.epub|.*\.woff2?)$").unwrap()
    });
    re.is_match(rel)
}

fn is_windows_reserved_device_name(seg: &str) -> bool {
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn resolve_safe_target(repo_root: &Path, raw_entry: &str) -> Option<(String, PathBuf)> {
    let clean = raw_entry.replace('\\', "/").trim().to_string();
    if clean.is_empty() || clean.starts_with('/') || clean.len() > 1024 {
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
        if seg.ends_with('.') || seg.ends_with(' ') {
            return None;
        }
        if is_short_name_segment(seg) || is_windows_reserved_device_name(seg) {
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

        // 用 .gitignore 过滤私有文件
        if let Some(ref g) = gi {
            if g.matched_path_or_any_parents(Path::new(&rel), false).is_ignore() {
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
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.quotepath=false", "status", "--porcelain"])
        .current_dir(&repo_dir);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(out) = cmd.output() else {
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

fn format_human_size(b: u64) -> String {
    if b < 1024 {
        format!("{} B", b)
    } else if b < 1024 * 1024 {
        format!("{:.1} KB", b as f64 / 1024.0)
    } else {
        format!("{:.2} MB", b as f64 / (1024.0 * 1024.0))
    }
}

fn markdown_lang_for_rel(rel: &str) -> &'static str {
    let fname = rel.rsplit('/').next().unwrap_or(rel);
    if fname.eq_ignore_ascii_case(".gitignore") {
        return "gitignore";
    }
    let ext = Path::new(fname)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "rs" => "rust",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" => "typescript",
        "jsx" => "jsx",
        "html" | "htm" => "html",
        "css" => "css",
        "json" => "json",
        "toml" => "toml",
        "md" | "markdown" => "markdown",
        "bat" | "cmd" => "bat",
        "ps1" => "powershell",
        "sh" => "bash",
        "py" => "python",
        "yml" | "yaml" => "yaml",
        "xml" | "svg" => "xml",
        "sql" => "sql",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "java" => "java",
        "txt" | "properties" | "ini" | "cfg" | "ftl" | "lock" => "text",
        _ => "",
    }
}

pub fn safe_markdown_fence(content: &str) -> String {
    let mut max_run = 0usize;
    let mut cur = 0usize;
    for b in content.bytes() {
        if b == b'`' {
            cur += 1;
            if cur > max_run {
                max_run = cur;
            }
        } else {
            cur = 0;
        }
    }
    "`".repeat(max_run.max(2) + 1)
}

struct MdChunkUnit {
    index_line: String,
    body_block: String,
}

fn format_md_file_block(
    archive_name: &str,
    rel: &str,
    orig_size: u64,
    total_lines: usize,
    chunk_label: Option<(usize, usize, usize, usize)>,
    text: &str,
) -> MdChunkUnit {
    let lang = markdown_lang_for_rel(rel);
    let fence = safe_markdown_fence(text);
    let needs_nl = !text.is_empty() && !text.ends_with('\n');

    let (title_suffix, index_suffix, line_desc) = match chunk_label {
        Some((ci, ct, start_ln, end_ln)) => (
            format!(" (Chunk {}/{}, Lines {}-{})", ci, ct, start_ln, end_ln),
            format!(", Chunk {}/{}, Lines {}-{}", ci, ct, start_ln, end_ln),
            format!("{} (showing lines {}-{})", total_lines, start_ln, end_ln),
        ),
        None => (String::new(), String::new(), total_lines.to_string()),
    };

    let index_line = format!(
        "- `{}` :: `{}` ({}, {} lines{})\n",
        archive_name,
        rel,
        format_human_size(orig_size),
        total_lines,
        index_suffix
    );

    let mut body = String::with_capacity(text.len() + 256);
    body.push_str("\n---\n\n## File: `");
    body.push_str(rel);
    body.push('`');
    body.push_str(&title_suffix);
    body.push_str("\n\n- **Archive:** `");
    body.push_str(archive_name);
    body.push_str("`\n- **Relative Path:** `");
    body.push_str(rel);
    body.push_str("`\n- **Size:** ");
    body.push_str(&orig_size.to_string());
    body.push_str(" bytes (");
    body.push_str(&format_human_size(orig_size));
    body.push_str(") | **Lines:** ");
    body.push_str(&line_desc);
    body.push_str("\n\n");
    body.push_str(&fence);
    body.push_str(lang);
    body.push('\n');
    body.push_str(text);
    if needs_nl {
        body.push('\n');
    }
    body.push_str(&fence);
    body.push('\n');

    MdChunkUnit {
        index_line,
        body_block: body,
    }
}

/// 将已打包条目按单文件字节上限拼接为多份 AI 友好的 Markdown 上下文分卷（纯函数，便于自检）
pub fn render_markdown_bundle_parts(
    archive_name: &str,
    entries: &[(String, Vec<u8>)],
    max_md_bytes: usize,
) -> (Vec<String>, usize) {
    let limit = max_md_bytes.max(10 * 1024);
    let generated_at = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let mut units: Vec<MdChunkUnit> = Vec::new();
    let mut skipped_binary: Vec<(String, u64)> = Vec::new();
    let mut text_file_count = 0usize;

    let part_header_reserve: usize = 900;
    let max_chunk_body = limit.saturating_sub(part_header_reserve + 512).max(4096);

    for (rel, bytes) in entries {
        let size = bytes.len() as u64;
        if bytes.contains(&0) {
            skipped_binary.push((rel.clone(), size));
            continue;
        }
        let Ok(raw_str) = std::str::from_utf8(bytes) else {
            skipped_binary.push((rel.clone(), size));
            continue;
        };
        text_file_count += 1;
        let clean = raw_str.strip_prefix('\u{FEFF}').unwrap_or(raw_str);
        let total_lines = clean.lines().count();

        let single = format_md_file_block(archive_name, rel, size, total_lines, None, clean);
        if single.index_line.len() + single.body_block.len() + part_header_reserve <= limit {
            units.push(single);
            continue;
        }

        // 单文件自身超过单 MD 上限时，按行边界切分为多个完整合法代码块，严格遵守体积上限
        let mut raw_chunks: Vec<(usize, usize, String)> = Vec::new();
        let mut cur_buf = String::new();
        let mut start_ln = 1usize;
        let mut cur_ln = 0usize;

        for line in clean.split_inclusive('\n') {
            cur_ln += 1;
            if !cur_buf.is_empty() && cur_buf.len() + line.len() > max_chunk_body {
                raw_chunks.push((start_ln, cur_ln - 1, std::mem::take(&mut cur_buf)));
                start_ln = cur_ln;
            }
            cur_buf.push_str(line);
        }
        if !cur_buf.is_empty() || raw_chunks.is_empty() {
            raw_chunks.push((start_ln, cur_ln.max(start_ln), cur_buf));
        }

        let ct = raw_chunks.len();
        for (idx, (sln, eln, chunk_text)) in raw_chunks.into_iter().enumerate() {
            units.push(format_md_file_block(
                archive_name,
                rel,
                size,
                total_lines,
                Some((idx + 1, ct, sln, eln)),
                &chunk_text,
            ));
        }
    }

    let skipped_section = if skipped_binary.is_empty() {
        String::new()
    } else {
        let mut s = format!("\n## Skipped / Binary Files ({})\n\n", skipped_binary.len());
        for (rel, sz) in &skipped_binary {
            s.push_str(&format!(
                "- `{}` :: `{}` ({}, Binary / Non-UTF8)\n",
                archive_name,
                rel,
                format_human_size(*sz)
            ));
        }
        s
    };

    let mut grouped: Vec<Vec<MdChunkUnit>> = Vec::new();
    let mut cur_group: Vec<MdChunkUnit> = Vec::new();
    let mut cur_est = part_header_reserve + skipped_section.len();

    for u in units {
        let add_len = u.index_line.len() + u.body_block.len();
        if !cur_group.is_empty() && cur_est + add_len > limit {
            grouped.push(std::mem::take(&mut cur_group));
            cur_est = part_header_reserve;
        }
        cur_est += add_len;
        cur_group.push(u);
    }
    if !cur_group.is_empty() || grouped.is_empty() {
        grouped.push(cur_group);
    }

    let total_parts = grouped.len();
    let mut out_parts = Vec::with_capacity(total_parts);

    for (idx, group) in grouped.into_iter().enumerate() {
        let part_no = idx + 1;
        let mut doc = String::new();
        doc.push_str(&format!(
            "# Codebase Context Bundle (Part {} of {})\n\n",
            part_no, total_parts
        ));
        doc.push_str("> Structured source bundle for AI code audit and analysis.\n");
        doc.push_str("> Relative paths are normalized with forward slashes (/) and scoped by archive name.\n\n");
        doc.push_str(&format!("- **Generated:** {}\n", generated_at));
        doc.push_str(&format!("- **Part:** {} / {}\n", part_no, total_parts));
        doc.push_str(&format!("- **Source Archives:** `{}`\n", archive_name));
        doc.push_str(&format!(
            "- **Entries in This Part:** {} (Total text files: {})\n\n",
            group.len(),
            text_file_count
        ));
        doc.push_str("## File Index (This Part)\n\n");
        for u in &group {
            doc.push_str(&u.index_line);
        }
        if part_no == 1 && !skipped_section.is_empty() {
            doc.push_str(&skipped_section);
        }
        for u in &group {
            doc.push_str(&u.body_block);
        }
        out_parts.push(doc);
    }

    (out_parts, skipped_binary.len())
}

#[allow(dead_code)]
pub fn create_pack_zip(cfg: &ServerConfig, rel_paths: &[String]) -> Result<PackZipResult, String> {
    create_pack_zip_with_options(cfg, rel_paths, false, 200)
}

pub fn create_pack_zip_with_options(
    cfg: &ServerConfig,
    rel_paths: &[String],
    stitch_md: bool,
    max_md_kb: usize,
) -> Result<PackZipResult, String> {
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
    let mut packed_entries: Vec<(String, Vec<u8>)> = Vec::new();

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
            if stitch_md {
                packed_entries.push((clean_rel, bytes));
            }
            packed_count += 1;
        }
        writer.finish().map_err(|e| format!("关闭 ZIP 失败: {}", e))?;
    }

    if packed_count == 0 {
        let _ = fs::remove_file(&zip_path);
        return Err("没有可打包的有效文件".to_string());
    }

    let mut md_dir_out: Option<String> = None;
    let mut md_files: Vec<String> = Vec::new();
    let mut md_skipped_binary = 0usize;

    if stitch_md {
        let max_bytes = max_md_kb.clamp(10, 51200) * 1024;
        let (parts, bin_cnt) = render_markdown_bundle_parts(&file_name, &packed_entries, max_bytes);
        md_skipped_binary = bin_cnt;

        let md_dir = cfg.backup_dir.join(format!("ai_pack_{}_md", stamp));
        fs::create_dir_all(&md_dir).map_err(|e| format!("创建 MD 拼接输出目录失败: {}", e))?;
        for (idx, part_content) in parts.iter().enumerate() {
            let md_name = format!("markdown_part{}.md", idx + 1);
            write_atomic(&md_dir.join(&md_name), part_content, false)?;
            md_files.push(md_name);
        }
        md_dir_out = Some(strip_verbatim_prefix(&md_dir).to_string_lossy().into_owned());
    }

    let zip_size = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    Ok(PackZipResult {
        file_name,
        full_path: strip_verbatim_prefix(&zip_path).to_string_lossy().into_owned(),
        packed_count,
        skipped_count,
        zip_size,
        md_dir: md_dir_out,
        md_files,
        md_skipped_binary,
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
                is_dangerous: false,
                is_skip_doc: false,
                default_checked: false,
                status: "blocked".to_string(),
            });
            continue;
        };

        let is_hard_priv = is_hard_private_rel(&rel);
        if is_hard_priv || entry.size() > MAX_APPLY_ENTRY_BYTES {
            entries.push(ApplyEntryInfo {
                rel,
                size: entry.size(),
                exists: false,
                blocked: true,
                is_secret: is_hard_priv,
                is_dangerous: false,
                is_skip_doc: false,
                default_checked: false,
                status: "blocked".to_string(),
            });
            continue;
        }

        let exists = full.is_file();
        let is_dangerous = is_build_or_exec_rel(&rel);
        let is_skip_doc = !rel.contains('/')
            && skip_re.as_ref().map(|r| r.is_match(&rel)).unwrap_or(false);
        let default_checked = !is_dangerous && !is_skip_doc;
        let status = if is_dangerous {
            "exec_risk"
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
            is_secret: false,
            is_dangerous,
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

    write_bytes_atomic(target_full, final_bytes)
}

struct ManifestGuard {
    backup_dir: Option<PathBuf>,
    source_zip: String,
    overwritten: Vec<String>,
    created: Vec<String>,
    written: bool,
}

impl ManifestGuard {
    fn flush(&mut self) -> Result<(), String> {
        if self.written {
            return Ok(());
        }
        let Some(ref bdir) = self.backup_dir else {
            self.written = true;
            return Ok(());
        };
        if self.overwritten.is_empty() && self.created.is_empty() {
            self.written = true;
            return Ok(());
        }
        let manifest = ApplyManifest {
            applied_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            source_zip: self.source_zip.clone(),
            overwritten: self.overwritten.clone(),
            created: self.created.clone(),
        };
        let mf_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("序列化回滚清单失败: {}", e))?;
        write_atomic(&bdir.join("_manifest.json"), &mf_json, false)?;
        self.written = true;
        Ok(())
    }
}

impl Drop for ManifestGuard {
    fn drop(&mut self) {
        if !self.written {
            let _ = self.flush();
        }
    }
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

    // 第一遍：先全量解压校验（私密禁区 / 单文件上限 / 总解压上限），全部通过前绝不改动磁盘
    let mut staged_items: Vec<(String, PathBuf, Vec<u8>)> = Vec::new();
    let mut seen_lower: HashSet<String> = HashSet::new();
    let mut total_extracted: u64 = 0;

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
        let raw_name = entry.name().to_string();
        if raw_name.is_empty() || raw_name.ends_with('/') || raw_name.ends_with('\\') {
            continue;
        }
        let Some((rel, full)) = resolve_safe_target(&cfg.repo_root, &raw_name) else {
            continue;
        };
        if !selected.contains(&rel) {
            continue;
        }
        if is_hard_private_rel(&rel) {
            return Err(format!("安全策略禁止补丁写入私密或受保护路径: {}", rel));
        }
        let low = rel.to_ascii_lowercase();
        if !seen_lower.insert(low) {
            continue;
        }

        let mut buf = Vec::new();
        entry
            .take(MAX_APPLY_ENTRY_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压 {} 失败: {}", rel, e))?;
        if buf.len() as u64 > MAX_APPLY_ENTRY_BYTES {
            return Err(format!(
                "条目 {} 解压后超过单文件安全上限 ({} MB)，已中止回填（未改动任何文件）",
                rel,
                MAX_APPLY_ENTRY_BYTES / (1024 * 1024)
            ));
        }
        total_extracted = total_extracted.saturating_add(buf.len() as u64);
        if total_extracted > MAX_APPLY_TOTAL_BYTES {
            return Err(format!(
                "本次回填累计解压体积超过安全上限 ({} MB)，已中止回填（未改动任何文件）",
                MAX_APPLY_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        staged_items.push((rel, full, buf));
    }

    if staged_items.is_empty() {
        return Err("补丁包中未匹配到任何可回填的有效条目".to_string());
    }

    let mut backup_name = String::new();
    let mut backup_dir: Option<PathBuf> = None;
    if auto_backup {
        let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        backup_name = format!("ai_apply_{}", stamp);
        let dir = cfg.backup_dir.join(&backup_name);
        fs::create_dir_all(&dir).map_err(|e| format!("创建回滚备份目录失败: {}", e))?;
        backup_dir = Some(dir);
    }

    // 第二遍：受 ManifestGuard 保护逐个备份与原子落盘，即使中途出错也会自动写出 _manifest.json 保证可回滚
    let mut guard = ManifestGuard {
        backup_dir: backup_dir.clone(),
        source_zip: source_name.to_string(),
        overwritten: Vec::new(),
        created: Vec::new(),
        written: false,
    };

    for (rel, full, buf) in &staged_items {
        let exists = full.is_file();
        if exists {
            if let Some(ref bdir) = backup_dir {
                let mut bak_path = bdir.clone();
                for seg in rel.split('/') {
                    bak_path.push(seg);
                }
                if let Some(bp) = bak_path.parent() {
                    fs::create_dir_all(bp).map_err(|e| format!("创建备份父目录失败: {}", e))?;
                }
                fs::copy(full, &bak_path).map_err(|e| format!("备份 {} 失败: {}", rel, e))?;
            }
            write_bytes_with_encoding_guard(full, buf, fix_win_encoding)?;
            guard.overwritten.push(rel.clone());
        } else {
            write_bytes_with_encoding_guard(full, buf, fix_win_encoding)?;
            guard.created.push(rel.clone());
        }
    }

    guard.flush()?;

    Ok(ApplyResult {
        overwritten: guard.overwritten.len(),
        created: guard.created.len(),
        backup_name,
    })
}

pub fn resolve_downloads_dir() -> Option<PathBuf> {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(profile).join("Downloads");
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let p = PathBuf::from(home).join("Downloads");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// 扫描用户 Downloads 目录顶层条目：.zip 置顶且按修改时间倒序排列，便于直接挑选最新补丁或勾选清理
pub fn list_downloads_items() -> (Option<PathBuf>, Vec<DownloadTreeItem>) {
    let Some(dl_dir) = resolve_downloads_dir() else {
        return (None, Vec::new());
    };
    let Ok(rd) = fs::read_dir(&dl_dir) else {
        return (Some(dl_dir), Vec::new());
    };

    let mut rows: Vec<(bool, std::time::SystemTime, DownloadTreeItem)> = Vec::new();
    for ent in rd.filter_map(|e| e.ok()) {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.is_empty() || name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        let path = ent.path();
        let Ok(meta) = ent.metadata() else {
            continue;
        };
        let is_dir = meta.is_dir();
        let is_zip = !is_dir
            && path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("zip"))
                .unwrap_or(false);
        let size = if is_dir { 0 } else { meta.len() };
        let child_count = if is_dir {
            fs::read_dir(&path).map(|r| r.count()).unwrap_or(0)
        } else {
            0
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        rows.push((
            is_zip,
            mtime,
            DownloadTreeItem {
                rel: name,
                size,
                is_dir,
                is_zip,
                child_count,
            },
        ));
    }

    rows.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.rel.cmp(&b.2.rel))
    });

    let items = rows.into_iter().map(|(_, _, it)| it).collect();
    (Some(dl_dir), items)
}

/// 安全清理 Downloads 目录中勾选的顶层文件或文件夹（拒绝路径穿越与符号链接越界）
pub fn delete_downloads_items(rel_names: &[String]) -> Result<(usize, usize, u64), String> {
    if rel_names.is_empty() {
        return Err("未勾选任何待清理条目".to_string());
    }
    let dl_dir = resolve_downloads_dir().ok_or_else(|| "未找到用户 Downloads 目录".to_string())?;
    let canon_dl = fs::canonicalize(&dl_dir)
        .map_err(|e| format!("无法规范化 Downloads 目录: {}", e))?;

    let mut unique: Vec<String> = rel_names
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    unique.sort();
    unique.dedup();

    let mut deleted_files = 0usize;
    let mut deleted_dirs = 0usize;
    let mut freed_bytes = 0u64;

    for name in &unique {
        if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
            continue;
        }
        let Some((_, full)) = resolve_safe_target(&dl_dir, name) else {
            continue;
        };
        let Ok(sym_meta) = fs::symlink_metadata(&full) else {
            continue;
        };
        if sym_meta.file_type().is_symlink() {
            if fs::remove_file(&full).is_ok() {
                deleted_files += 1;
            } else if fs::remove_dir(&full).is_ok() {
                deleted_dirs += 1;
            }
            continue;
        }
        let Ok(canon_target) = fs::canonicalize(&full) else {
            continue;
        };
        if !canon_target.starts_with(&canon_dl) || canon_target == canon_dl {
            continue;
        }
        if canon_target.is_file() {
            let sz = fs::metadata(&canon_target).map(|m| m.len()).unwrap_or(0);
            fs::remove_file(&canon_target)
                .map_err(|e| format!("删除文件 {} 失败: {}", name, e))?;
            deleted_files += 1;
            freed_bytes = freed_bytes.saturating_add(sz);
        } else if canon_target.is_dir() {
            fs::remove_dir_all(&canon_target)
                .map_err(|e| format!("删除目录 {} 失败: {}", name, e))?;
            deleted_dirs += 1;
        }
    }

    Ok((deleted_files, deleted_dirs, freed_bytes))
}

pub fn list_backup_tree_items(cfg: &ServerConfig) -> Vec<BackupTreeItem> {
    let mut items = Vec::new();
    if !cfg.backup_dir.is_dir() {
        return items;
    }

    for entry in WalkDir::new(&cfg.backup_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.path() == cfg.backup_dir {
            continue;
        }
        let Ok(rel_p) = entry.path().strip_prefix(&cfg.backup_dir) else {
            continue;
        };
        let rel = rel_p.to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        if entry.file_type().is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            items.push(BackupTreeItem {
                rel,
                size,
                is_dir: false,
            });
        } else if entry.file_type().is_dir() {
            let is_empty = fs::read_dir(entry.path())
                .map(|mut rd| rd.next().is_none())
                .unwrap_or(false);
            if is_empty {
                items.push(BackupTreeItem {
                    rel,
                    size: 0,
                    is_dir: true,
                });
            }
        }
    }

    items.sort_by(|a, b| a.rel.cmp(&b.rel));
    items
}

/// 安全清理 _build/temp/backup/ 下勾选的文件与空目录，并自动回收因此变空的父目录
pub fn delete_backup_items(
    cfg: &ServerConfig,
    rel_paths: &[String],
) -> Result<(usize, usize, u64), String> {
    if rel_paths.is_empty() {
        return Err("未勾选任何待清理条目".to_string());
    }
    if !cfg.backup_dir.is_dir() {
        return Ok((0, 0, 0));
    }
    let canon_backup = fs::canonicalize(&cfg.backup_dir)
        .map_err(|e| format!("无法规范化 backup 目录: {}", e))?;

    let mut unique: Vec<String> = rel_paths
        .iter()
        .map(|s| s.replace('\\', "/").trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    unique.sort();
    unique.dedup();

    let mut deleted_files = 0usize;
    let mut deleted_dirs = 0usize;
    let mut freed_bytes = 0u64;

    for rel in &unique {
        let Some((_, full)) = resolve_safe_target(&cfg.backup_dir, rel) else {
            continue;
        };
        let Ok(canon_target) = fs::canonicalize(&full) else {
            continue;
        };
        if !canon_target.starts_with(&canon_backup) || canon_target == canon_backup {
            continue;
        }
        if canon_target.is_file() {
            let sz = fs::metadata(&canon_target).map(|m| m.len()).unwrap_or(0);
            fs::remove_file(&canon_target)
                .map_err(|e| format!("删除备份文件 {} 失败: {}", rel, e))?;
            deleted_files += 1;
            freed_bytes = freed_bytes.saturating_add(sz);
        } else if canon_target.is_dir() {
            if fs::remove_dir(&canon_target).is_ok() {
                deleted_dirs += 1;
            }
        }
    }

    // 自底向上清理因删除文件而变空的子目录（绝不删除 backup 根目录本身）
    let mut subdirs: Vec<PathBuf> = WalkDir::new(&canon_backup)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir() && e.path() != canon_backup)
        .map(|e| e.path().to_path_buf())
        .collect();
    subdirs.sort_by(|a, b| b.components().count().cmp(&a.components().count()));
    for dir in subdirs {
        let is_empty = fs::read_dir(&dir)
            .map(|mut rd| rd.next().is_none())
            .unwrap_or(false);
        if is_empty && fs::remove_dir(&dir).is_ok() {
            deleted_dirs += 1;
        }
    }

    Ok((deleted_files, deleted_dirs, freed_bytes))
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
