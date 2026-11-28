//! 开箱即用 Release 打包器：在系统临时目录构建干净成品包（win64.zip）、纯骨架升级包（upgrade.zip）、独立 exe 与 SHA256SUMS.txt。

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::api_files::write_atomic;
use crate::builder::minify::sha256_hex;
use crate::config::{strip_verbatim_prefix, ServerConfig};
use crate::services::pack_apply::{is_hard_private_rel, is_private_push_path, resolve_downloads_dir};
use crate::services::upstream_sync::{
    is_skeleton_path, is_user_owned_path, neutral_bookmark_html, neutral_gitignore,
    neutral_swamp_toml, neutral_welcome_html, sanitize_index_html_for_upstream, PUBLIC_CILIN_REL,
};

#[derive(Clone, Debug)]
pub struct ReleasePackResult {
    pub version: String,
    pub out_dir: PathBuf,
    pub win64_zip: PathBuf,
    pub win64_size: u64,
    pub win64_entries: usize,
    pub upgrade_zip: PathBuf,
    pub upgrade_size: u64,
    pub upgrade_entries: usize,
    pub standalone_exe: PathBuf,
    pub sums_file: PathBuf,
}

struct TempDirGuard {
    dir: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, String> {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // 刻意置于系统临时目录（仓库 .git 之外），避免 stage 内运行 gen 时被外层 .gitignore 误判忽略
        let dir = strip_verbatim_prefix(
            &std::env::temp_dir().join(format!("{}_{}_{}", prefix, std::process::id(), ms)),
        );
        fs::create_dir_all(&dir).map_err(|e| format!("创建临时打包目录失败: {}", e))?;
        Ok(Self { dir })
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_start_matches('/').to_string()
}

/// 校验 Release 版本号（如 v1.0.0 / 1.0.0-rc.1），拒绝路径穿越与非法文件名字符
pub fn validate_release_version(raw: &str) -> bool {
    let v = raw.trim();
    if v.is_empty() || v.len() > 64 {
        return false;
    }
    let first = v.as_bytes()[0];
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    if v.contains("..") {
        return false;
    }
    v.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// 判断源码路径是否应进入 win64 开箱成品包（仅含运行时骨架与基础词林，不含 Rust 源码与 CI 配置）
pub fn is_release_win64_skeleton_path(rel: &str) -> bool {
    let norm = normalize_rel(rel);
    if !is_skeleton_path(&norm) {
        return false;
    }
    let low = norm.to_ascii_lowercase();
    if low == PUBLIC_CILIN_REL {
        return true;
    }
    if low.starts_with("_build/swamp-server/") || low.starts_with(".github/") {
        return false;
    }
    true
}

/// 判断源码路径是否应进入 upgrade 增量升级包（兼容「回填补丁」页一键无痛升级，绝不覆盖用户独占文件）
pub fn is_release_upgrade_path(rel: &str) -> bool {
    let norm = normalize_rel(rel);
    if !is_skeleton_path(&norm) {
        return false;
    }
    let low = norm.to_ascii_lowercase();
    if is_hard_private_rel(&low) || is_user_owned_path(&low) {
        return false;
    }
    if low.starts_with("_build/swamp-server/") || low.starts_with(".github/") {
        return false;
    }
    if low == "_build/swamp.exe" {
        return false;
    }
    true
}

fn resolve_release_exe(cfg: &ServerConfig) -> Result<PathBuf, String> {
    let built_exe = cfg.build_dir.join("swamp.exe");
    if built_exe.is_file() {
        return Ok(built_exe);
    }
    if let Ok(cur) = std::env::current_exe() {
        if cur.is_file() {
            return Ok(cur);
        }
    }
    Err(format!(
        "未找到可打包的 swamp.exe ({})，请先编译原生可执行文件",
        built_exe.display()
    ))
}

fn resolve_release_out_dir(explicit: Option<PathBuf>, version: &str) -> Result<PathBuf, String> {
    let dir = match explicit {
        Some(p) => p,
        None => {
            let dl = resolve_downloads_dir()
                .ok_or_else(|| "未找到系统下载目录，请通过 --out-dir 指定输出目录".to_string())?;
            dl.join(format!("swamp-release-{}", version))
        }
    };
    fs::create_dir_all(&dir).map_err(|e| format!("创建发布输出目录失败: {}", e))?;
    Ok(strip_verbatim_prefix(&dir))
}

fn collect_repo_files(repo_root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out = Vec::new();
    for entry in WalkDir::new(repo_root)
        .into_iter()
        .filter_entry(|e| {
            let p = e.path();
            if p == repo_root {
                return true;
            }
            let Ok(rel) = p.strip_prefix(repo_root) else {
                return false;
            };
            let rel_s = rel.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
            if e.file_type().is_dir() {
                if matches!(
                    rel_s.as_str(),
                    ".git"
                        | ".vscode"
                        | "node_modules"
                        | "html"
                        | "gallery"
                        | "audio"
                        | "video"
                        | "ebook"
                        | "src/js/data"
                        | "_build/privy"
                        | "_build/temp"
                        | "_build/swamp-server/target"
                ) {
                    return false;
                }
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(repo_root) else {
            continue;
        };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        out.push((rel_s, entry.path().to_path_buf()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn copy_file_to(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 ({}): {}", parent.display(), e))?;
    }
    fs::copy(src, dst)
        .map_err(|e| format!("复制 {} -> {} 失败: {}", src.display(), dst.display(), e))?;
    Ok(())
}

fn write_stage_text(dst: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 ({}): {}", parent.display(), e))?;
    }
    write_atomic(dst, content, false)
        .map_err(|e| format!("写入 {} 失败: {}", dst.display(), e))
}

fn build_upgrade_notes(version: &str) -> String {
    format!(
        "# Swamp {} 增量升级说明\n\n\
         本压缩包仅包含引擎前端源码、Wasm 模块与 `_build/core.toml`，**不会覆盖**你的 `_build/swamp.toml`、`src/tpl/bookmark.html`、`.gitignore` 与任何个人文章/媒体。\n\n\
         ## 纯 ZIP 用户升级步骤\n\n\
         1. 在旧版 `swamp.exe` 控制台的「回填补丁」页加载本压缩包，双击审阅 `_build/core.toml` Diff 后点击回填。\n\
         2. 如本版本同时更新了原生服务端，右键托盘图标 `Exit` 退出旧版 `swamp.exe`，用同版本的 `swamp-{}.exe` 覆盖 `_build/swamp.exe` 并重新启动。\n\
         3. 启动后在「常规」页点击 **`gen`** 重新压缩前端产物并注入你的站点配置。\n",
        version, version
    )
}

fn verify_staged_win64_tree(stage_root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let required = [
        "index.html",
        "sw.js",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_LICENSES.md",
        ".gitignore",
        "_build/core.toml",
        "_build/swamp.toml",
        "_build/local.toml.example",
        "_build/swamp.exe",
        "src/js/index.js",
        "src/js/pinyinData.js",
        "src/js/core-list.js",
        "src/js/data/lite_data.js",
        "src/js/data/core-bundle.json",
        "src/wasm/compute_intensive_task_processor.min.js",
        "src/wasm/compute_intensive_task_processor_bg.wasm",
        "src/discussion_id_mapper.json",
        "html/欢迎使用.html",
    ];
    for req in required {
        if !stage_root.join(req).is_file() {
            return Err(format!("成品暂存目录缺少必需产物: {}", req));
        }
    }

    let mut files = Vec::new();
    let mut violations = Vec::new();
    for entry in WalkDir::new(stage_root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(stage_root) else {
            continue;
        };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        let low = rel_s.to_ascii_lowercase();
        if low != PUBLIC_CILIN_REL && is_private_push_path(&low) {
            violations.push(rel_s);
            continue;
        }
        files.push((rel_s, entry.path().to_path_buf()));
    }
    if !violations.is_empty() {
        return Err(format!(
            "成品包隐私校验未通过，已中止打包:\n  {}",
            violations.join("\n  ")
        ));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn write_zip_from_entries(
    zip_path: &Path,
    entries: &[(String, Vec<u8>)],
    empty_dirs: &[String],
) -> Result<u64, String> {
    let file = File::create(zip_path)
        .map_err(|e| format!("创建 ZIP ({}) 失败: {}", zip_path.display(), e))?;
    let mut writer = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for dir in empty_dirs {
        let norm = if dir.ends_with('/') {
            dir.clone()
        } else {
            format!("{}/", dir)
        };
        writer
            .add_directory(&norm, opts)
            .map_err(|e| format!("写入 ZIP 目录 {} 失败: {}", norm, e))?;
    }

    for (arc_name, bytes) in entries {
        writer
            .start_file(arc_name, opts)
            .map_err(|e| format!("写入 ZIP 条目 {} 失败: {}", arc_name, e))?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("写出 ZIP 数据 {} 失败: {}", arc_name, e))?;
    }

    writer
        .finish()
        .map_err(|e| format!("关闭 ZIP ({}) 失败: {}", zip_path.display(), e))?;
    Ok(fs::metadata(zip_path).map(|m| m.len()).unwrap_or(0))
}

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    Ok(sha256_hex(&bytes))
}

/// 一键构建开箱即用 Release 产物（win64.zip + upgrade.zip + swamp-{ver}.exe + SHA256SUMS.txt）
pub fn build_release_bundle(
    cfg: &ServerConfig,
    version_override: Option<&str>,
    out_dir_override: Option<PathBuf>,
) -> Result<ReleasePackResult, String> {
    let version = version_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("v{}", env!("CARGO_PKG_VERSION")));
    if !validate_release_version(&version) {
        return Err(format!(
            "非法 Release 版本号 '{}'（仅允许字母、数字与 . _ -，且不能以符号开头）",
            version
        ));
    }

    let exe_src = resolve_release_exe(cfg)?;
    let out_dir = resolve_release_out_dir(out_dir_override, &version)?;
    let repo_root = strip_verbatim_prefix(&cfg.repo_root);
    let repo_files = collect_repo_files(&repo_root)?;

    // 1. 准备独立系统临时目录，装配干净骨架 + 中性开箱样板
    let stage = TempDirGuard::new("swamp_release_stage")?;
    let mut upgrade_map: BTreeMap<String, Vec<u8>> = BTreeMap::new();

    for (rel, full) in &repo_files {
        let low = rel.to_ascii_lowercase();
        let in_win64 = is_release_win64_skeleton_path(rel);
        let in_upgrade = is_release_upgrade_path(rel);
        if !in_win64 && !in_upgrade {
            continue;
        }
        if low == "index.html" {
            let raw = fs::read_to_string(full)
                .map_err(|e| format!("读取 index.html 失败: {}", e))?;
            let clean = sanitize_index_html_for_upstream(&raw);
            if in_win64 {
                write_stage_text(&stage.dir.join("index.html"), &clean)?;
            }
            if in_upgrade {
                upgrade_map.insert("index.html".to_string(), clean.into_bytes());
            }
        } else {
            if in_win64 {
                copy_file_to(full, &stage.dir.join(rel))?;
            }
            if in_upgrade {
                let bytes = fs::read(full)
                    .map_err(|e| format!("读取 {} 失败: {}", rel, e))?;
                upgrade_map.insert(rel.clone(), bytes);
            }
        }
    }

    let favicon = repo_root.join("favicon.ico");
    if favicon.is_file() {
        copy_file_to(&favicon, &stage.dir.join("favicon.ico"))?;
    }

    copy_file_to(&exe_src, &stage.dir.join("_build").join("swamp.exe"))?;

    // 写入中性开箱样板（自动补建 html/ 等父目录，避免 os error 3）
    write_stage_text(&stage.dir.join(".gitignore"), neutral_gitignore())?;
    write_stage_text(
        &stage.dir.join("_build").join("swamp.toml"),
        neutral_swamp_toml(),
    )?;
    write_stage_text(
        &stage.dir.join("src").join("tpl").join("bookmark.html"),
        neutral_bookmark_html(),
    )?;
    write_stage_text(
        &stage.dir.join("html").join("欢迎使用.html"),
        neutral_welcome_html(),
    )?;
    write_stage_text(
        &stage.dir.join("src").join("discussion_id_mapper.json"),
        "{\"records\":[],\"orphanIds\":[]}\n",
    )?;
    fs::create_dir_all(stage.dir.join("gallery").join("img"))
        .map_err(|e| format!("创建示例图库目录失败: {}", e))?;

    // 2. 在隔离暂存目录现场跑一遍完整 gen，确保解压即开箱可用
    let stage_cfg = ServerConfig::load(Some(stage.dir.clone()), None, None, false)?;
    crate::builder::run_gen(&stage_cfg)?;

    // 清理 gen 在暂存目录产生的 _build/temp 临时文件
    let stage_temp = stage.dir.join("_build").join("temp");
    if stage_temp.exists() {
        let _ = fs::remove_dir_all(&stage_temp);
    }

    // 3. 校验并写出 swamp-{version}-win64.zip
    let staged_files = verify_staged_win64_tree(&stage.dir)?;
    let top_dir = format!("swamp-{}-win64", version);
    let mut win64_entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(staged_files.len());
    for (rel, full) in &staged_files {
        let bytes = fs::read(full)
            .map_err(|e| format!("读取暂存文件 {} 失败: {}", rel, e))?;
        win64_entries.push((format!("{}/{}", top_dir, rel), bytes));
    }
    let win64_name = format!("swamp-{}-win64.zip", version);
    let win64_zip = out_dir.join(&win64_name);
    let win64_size = write_zip_from_entries(
        &win64_zip,
        &win64_entries,
        &[format!("{}/gallery/img/", top_dir)],
    )?;

    // 4. 写出 swamp-{version}-upgrade.zip（无顶层目录，可直接拖进「回填补丁」页一键升级）
    upgrade_map.insert(
        "UPGRADE_NOTES.md".to_string(),
        build_upgrade_notes(&version).into_bytes(),
    );
    let upgrade_entries: Vec<(String, Vec<u8>)> = upgrade_map.into_iter().collect();
    let upgrade_name = format!("swamp-{}-upgrade.zip", version);
    let upgrade_zip = out_dir.join(&upgrade_name);
    let upgrade_size = write_zip_from_entries(&upgrade_zip, &upgrade_entries, &[])?;

    // 5. 复制独立 swamp-{version}.exe 并生成 SHA256SUMS.txt
    let standalone_name = format!("swamp-{}.exe", version);
    let standalone_exe = out_dir.join(&standalone_name);
    copy_file_to(&exe_src, &standalone_exe)?;

    let sums_body = format!(
        "{}  {}\n{}  {}\n{}  {}\n",
        file_sha256_hex(&win64_zip)?,
        win64_name,
        file_sha256_hex(&upgrade_zip)?,
        upgrade_name,
        file_sha256_hex(&standalone_exe)?,
        standalone_name,
    );
    let sums_file = out_dir.join("SHA256SUMS.txt");
    write_stage_text(&sums_file, &sums_body)?;

    Ok(ReleasePackResult {
        version,
        out_dir,
        win64_zip,
        win64_size,
        win64_entries: win64_entries.len(),
        upgrade_zip,
        upgrade_size,
        upgrade_entries: upgrade_entries.len(),
        standalone_exe,
        sums_file,
    })
}
