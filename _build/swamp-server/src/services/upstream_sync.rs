//! 双仓单物理目录骨架同步引擎：临时索引孤儿树合成、双父提交锚定、自动分流推送与上游 PR 无痛拉取。

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::builder::generator::render_index_html_meta;
use crate::config::{is_valid_git_ref_name, strip_verbatim_prefix, ServerConfig};
use crate::services::log_bus::LogBus;
use crate::services::pack_apply::is_private_push_path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const PUBLIC_CILIN_REL: &str = "_build/swamp-server/assets/cilin.txt";
pub(crate) const PREBUILT_PINYIN_JS_REL: &str = "src/js/pinyindata.js";

const INIT_TEMPLATE_PATHS: &[&str] = &[
    ".gitignore",
    "_build/swamp.toml",
    "src/tpl/bookmark.html",
    "html/欢迎使用.html",
    "src/discussion_id_mapper.json",
    "favicon.ico",
];

// --- 数据结构 ---

#[derive(Clone, Debug)]
pub struct PreparedUpstreamSync {
    pub remote: String,
    pub branch: String,
    pub base_commit: String,
    pub new_tree: String,
    pub changed_skeleton_files: Vec<String>,
    pub has_user_changes: bool,
}

#[derive(Clone, Debug)]
pub enum UpstreamSyncPlan {
    Skip,
    NoSkeletonDiff,
    Ready(PreparedUpstreamSync),
}

#[derive(Clone, Debug)]
pub struct InitUpstreamSummary {
    pub remote: String,
    pub branch: String,
    pub upstream_commit: String,
    pub anchor_commit: String,
    pub skeleton_count: usize,
}

#[derive(Clone, Debug)]
pub enum PullUpstreamOutcome {
    UpToDate {
        remote: String,
        branch: String,
    },
    Merged {
        remote: String,
        branch: String,
        upstream_commit: String,
        merged_files: Vec<String>,
        protected_user_files: Vec<String>,
        need_exe: bool,
        need_wasm: bool,
        need_gen: bool,
    },
    Conflicts {
        remote: String,
        branch: String,
        upstream_commit: String,
        conflict_files: Vec<String>,
        protected_user_files: Vec<String>,
    },
}

static TEMP_IDX_SEQ: AtomicU64 = AtomicU64::new(1);

struct TempGitIndex {
    path: PathBuf,
}

impl TempGitIndex {
    fn new() -> Result<Self, String> {
        // 刻意置于系统临时目录（避开 Dropbox / 网盘同步锁抢占）
        let base_dir = std::env::temp_dir();
        fs::create_dir_all(&base_dir)
            .map_err(|e| format!("创建临时索引目录失败: {}", e))?;
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = TEMP_IDX_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = strip_verbatim_prefix(&base_dir.join(format!(
            "swamp_git_idx_{}_{}_{}",
            std::process::id(),
            ms,
            seq
        )));
        let _ = fs::remove_file(&path);
        Ok(Self { path })
    }
}

impl Drop for TempGitIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let mut lock = self.path.as_os_str().to_os_string();
        lock.push(".lock");
        let _ = fs::remove_file(PathBuf::from(lock));
    }
}

// --- 三层路径分类（单一事实源） ---

fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_start_matches('/').to_string()
}

fn has_bad_segments(rel: &str) -> bool {
    if rel.is_empty() {
        return true;
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return true;
        }
    }
    false
}

/// 用户独占层：永不自动推往骨架仓，拉取上游时强制保留用户本地版
pub fn is_user_owned_path(rel: &str) -> bool {
    let norm = normalize_rel(rel);
    if has_bad_segments(&norm) {
        return false;
    }
    let low = norm.to_ascii_lowercase();
    matches!(
        low.as_str(),
        "_build/swamp.toml"
            | "src/tpl/bookmark.html"
            | ".gitignore"
            | "src/discussion_id_mapper.json"
            | "favicon.ico"
    ) || low == "html"
        || low.starts_with("html/")
        || low == "gallery"
        || low.starts_with("gallery/")
        || low == "audio"
        || low.starts_with("audio/")
        || low == "video"
        || low.starts_with("video/")
        || low == "ebook"
        || low.starts_with("ebook/")
}

/// 构建产物层：由 gen / build.bat 产出，不入骨架仓 Git 历史，也不触发混合提交弹窗
pub fn is_generated_artifact_path(rel: &str) -> bool {
    let norm = normalize_rel(rel);
    if has_bad_segments(&norm) {
        return false;
    }
    let low = norm.to_ascii_lowercase();
    if matches!(
        low.as_str(),
        "sw.js" | "src/js/raw/core-list.js" | "gallery/img/idle-list.txt" | "_build/swamp.exe"
    ) || low == "src/js/data"
        || low.starts_with("src/js/data/")
    {
        return true;
    }
    if low == PREBUILT_PINYIN_JS_REL {
        return false;
    }
    if let Some(rest) = low.strip_prefix("src/js/") {
        if rest.ends_with(".js") && !rest.contains('/') {
            return true;
        }
    }
    if let Some(rest) = low.strip_prefix("src/css/") {
        if rest.ends_with(".css") && !rest.contains('/') {
            return true;
        }
    }
    false
}

/// 骨架白名单：允许自动同步到上游骨架仓（diff4x/swamp）的源码与公共资源
pub fn is_skeleton_path(rel: &str) -> bool {
    let norm = normalize_rel(rel);
    if has_bad_segments(&norm) {
        return false;
    }
    let low = norm.to_ascii_lowercase();
    if low == PUBLIC_CILIN_REL {
        return true;
    }
    if is_private_push_path(&low)
        || low.starts_with("_build/swamp-server/target/")
        || is_user_owned_path(&low)
        || is_generated_artifact_path(&low)
    {
        return false;
    }

    matches!(
        low.as_str(),
        "readme.md"
            | "index.html"
            | "license"
            | "license.md"
            | "license.txt"
            | "third_party_licenses.md"
            | "_build/core.toml"
            | "_build/local.toml.example"
            | "src/js/pinyindata.js"
    ) || low.starts_with("_build/swamp-server/")
        || low.starts_with("src/js/raw/")
        || low.starts_with("src/css/raw/")
        || low.starts_with("src/css/font/")
        || low.starts_with("src/css/icon/")
        || low.starts_with("src/css/sound/")
        || (low.starts_with("src/tpl/") && low.ends_with(".html"))
        || low.starts_with("src/third/")
        || low.starts_with("src/wasm/")
        || low.starts_with(".github/")
}

/// 将 index.html 脱敏为中性骨架默认参数（永不携带个人标题、域名、评论仓与成人门禁开关）
pub fn sanitize_index_html_for_upstream(html: &str) -> String {
    const NEUTRAL_PARAM: &str = "<script>\n  const github_page = \"\";\n  const site_repo = \"\";\n  const data_repo = \"\";\n  const data_repo_id = \"\";\n  const data_category_id = \"\";\n  const update_interval = 10000;\n  const update_interval_local = 2000;\n  const readme_md = \"/README.md\";\n  const sim_port = \"9000\";\n</script>";
    render_index_html_meta(html, "Digital Swamp", false, NEUTRAL_PARAM)
        .unwrap_or_else(|| html.to_string())
}

// --- 中性开箱样板（仅用于 init-upstream 初始化骨架仓） ---

pub(crate) fn neutral_gitignore() -> &'static str {
    "# 通用隐私与本地临时文件隔离规则（Swamp 骨架默认）\n\
     html/__*.html\n\
     gallery/diary/\n\
     src/js/data/shadow*\n\
     _build/temp/\n\
     _build/privy/\n\
     _build/swamp.exe\n"
}

pub(crate) fn neutral_swamp_toml() -> &'static str {
    "# _build/swamp.toml —— 个人站点覆写配置（用户独占层，升级骨架时不覆盖）\r\n\
     # 公共引擎默认规则位于 _build/core.toml；本机私有路径请参考 _build/local.toml.example 写入 _build/privy/local.toml\r\n\
     \r\n\
     [site]\r\n\
     title = \"Digital Swamp\"\r\n\
     github_page = \"\"\r\n\
     site_repo = \"\"\r\n\
     adult_gate = false\r\n\
     readme_md = \"/README.md\"\r\n\
     \r\n\
     [giscus]\r\n\
     repo = \"\"\r\n\
     repo_id = \"\"\r\n\
     category_id = \"\"\r\n\
     \r\n\
     [build.media_exclude]\r\n\
     gallery = [\"img\"]\r\n\
     video = []\r\n\
     audio = []\r\n\
     ebook = []\r\n\
     \r\n\
     [upstream]\r\n\
     remote = \"upstream\"\r\n\
     branch = \"main\"\r\n\
     auto_push = false\r\n\
     \r\n\
     # === SYNONYMS-CUSTOM-BEGIN ===\r\n\
     [synonyms]\r\n\
     custom_json = '''\r\n\
     {\r\n\
       \"aliases\": {},\r\n\
       \"dropEqCodes\": [],\r\n\
       \"groups\": [],\r\n\
       \"pruneWords\": {},\r\n\
       \"splitFixes\": {},\r\n\
       \"stopExpand\": []\r\n\
     }\r\n\
     '''\r\n\
     # === SYNONYMS-CUSTOM-END ===\r\n"
}

pub(crate) fn neutral_bookmark_html() -> &'static str {
    r##"<!doctype html>
<html>
 <head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="../css/font.css">
  <script>
    if (window.top === window.self) {
        window.location.href = location.origin;
    } else if (window.parent !== window.top) {
        window.top.location.href = location.origin;
    }
  </script>
  <link rel="stylesheet" href="../css/bookmark.css">
 </head>
 <body>
  <div id="wallpaper-bg"></div>
  <div id="c">
   <a href="https://github.com/diff4x/swamp" target="_blank">Swamp 项目主页</a>
   <br>
  </div>
  <div id="b">
   <a href="txn_parser.html" target="_blank">txn_parser</a>
   <br>
  </div>
  <div id="a">
   <a href="go_board.html" target="_blank">⚪ go_board</a>
   <br id="katrain-br" style="display:none"><a id="katrain-link" href="#katrain" style="display:none">⚫ KaTrain</a>
   <br><a href="https://github.com/diff4x/swamp" target="_blank">❓ README</a>
  </div>
  <div id="del"></div><a id="end_flag" href="0" style="display:none"></a>
  <footer id="copyright">
   Powered by Swamp
  </footer>
  <script src="../js/bookmark.js"></script>
 </body>
</html>
"##
}

pub(crate) fn neutral_welcome_html() -> &'static str {
    r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>欢迎使用</title>
  <link rel="stylesheet" href="../src/css/content.css">
</head>
<body>
  <span id="anchor">20260101000000-指南</span>
<pre>
# 欢迎使用 Swamp

这是初始化自带的示例笔记，确认站点构建、目录渲染、全文搜索与离线缓存均正常工作后，可以随时删除或替换为你自己的文章。

## 快速开始

1. 编辑 _build/swamp.toml，填入你的站点标题、github_page 域名与可选的 Giscus 评论配置。
2. 如需本地联动 VS Code、WebP 转换或 Keep 导入，复制 _build/local.toml.example 为 _build/privy/local.toml 并填写本机路径。
3. 在 swamp.exe 控制台的「常规」页点击新建页面开始写作，点击 gen 构建并预览。
4. 私有笔记以双下划线开头（例如 html/__日记.html），不会被构建进公网产物。
</pre>
  <script src="../src/js/content.js"></script>
</body>
</html>
"##
}

// --- Git 底层命令辅助 ---

fn log_info(logs: Option<&LogBus>, msg: impl Into<String>) {
    let s = msg.into();
    if let Some(bus) = logs {
        bus.info(s);
    } else {
        println!("{}", s);
    }
}

fn git_cmd(root: &Path, idx: Option<&TempGitIndex>) -> Command {
    let mut c = Command::new("git");
    c.current_dir(root);
    if let Some(t) = idx {
        c.env("GIT_INDEX_FILE", &t.path);
    }
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn git_stdout(root: &Path, idx: Option<&TempGitIndex>, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(root, idx)
        .args(args)
        .output()
        .map_err(|e| format!("启动 git {} 失败: {}", args.first().copied().unwrap_or(""), e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} 失败: {}", args.join(" "), detail));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_stdout_bytes(
    root: &Path,
    idx: Option<&TempGitIndex>,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    let out = git_cmd(root, idx)
        .args(args)
        .output()
        .map_err(|e| format!("启动 git {} 失败: {}", args.first().copied().unwrap_or(""), e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git {} 失败: {}", args.join(" "), stderr));
    }
    Ok(out.stdout)
}

fn git_status_ok(root: &Path, idx: Option<&TempGitIndex>, args: &[&str]) -> bool {
    git_cmd(root, idx)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn git_hash_object_bytes(root: &Path, bytes: &[u8]) -> Result<String, String> {
    let mut child = git_cmd(root, None)
        .args(["hash-object", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 git hash-object 失败: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(bytes)
            .map_err(|e| format!("写入 git hash-object 失败: {}", e))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 git hash-object 失败: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "git hash-object 失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 通过单次 `git update-index -z --index-info` 批量写入全部索引条目，彻底消除循环改写锁竞态并提速数十倍
fn git_index_write_entries(
    root: &Path,
    idx: &TempGitIndex,
    entries: &BTreeMap<String, (String, String)>,
) -> Result<(), String> {
    let mut payload = Vec::with_capacity(entries.len() * 80);
    for (rel_path, (mode, blob_sha)) in entries {
        payload.extend_from_slice(mode.as_bytes());
        payload.extend_from_slice(b" blob ");
        payload.extend_from_slice(blob_sha.as_bytes());
        payload.push(b'\t');
        payload.extend_from_slice(rel_path.as_bytes());
        payload.push(0);
    }

    let mut child = git_cmd(root, Some(idx))
        .args(["update-index", "-z", "--index-info"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 git update-index --index-info 失败: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&payload)
            .map_err(|e| format!("写入 git update-index --index-info 失败: {}", e))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 git update-index --index-info 失败: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git update-index -z --index-info 失败: {}", detail));
    }
    Ok(())
}

fn parse_ls_tree_entries(raw: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for rec in raw.split('\0') {
        if rec.is_empty() {
            continue;
        }
        let Some((meta, path)) = rec.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = meta.split_whitespace().collect();
        if parts.len() >= 3 && parts[1] == "blob" {
            out.push((parts[0].to_string(), parts[2].to_string(), path.to_string()));
        }
    }
    out
}

fn parse_ls_files_stage_entries(raw: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for rec in raw.split('\0') {
        if rec.is_empty() {
            continue;
        }
        let Some((meta, path)) = rec.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = meta.split_whitespace().collect();
        if parts.len() >= 3 && parts[2] == "0" && parts[0] != "160000" {
            out.push((parts[0].to_string(), parts[1].to_string(), path.to_string()));
        }
    }
    out
}

fn git_tree_ls_paths(root: &Path, tree_sha: &str) -> Result<Vec<String>, String> {
    let raw = git_stdout(
        root,
        None,
        &["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "-z", tree_sha],
    )?;
    Ok(raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect())
}

fn git_diff_tree_paths(
    root: &Path,
    old_tree: &str,
    new_tree: &str,
) -> Result<Vec<String>, String> {
    let raw = git_stdout(
        root,
        None,
        &[
            "-c",
            "core.quotepath=false",
            "diff-tree",
            "-r",
            "--name-only",
            "-z",
            old_tree,
            new_tree,
        ],
    )?;
    let mut paths: Vec<String> = raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// 全树隐私与白名单二次断言：数学级阻断任何个人内容或私密路径进入骨架仓
fn assert_upstream_tree_safe(
    root: &Path,
    new_tree: &str,
    base_tree: Option<&str>,
) -> Result<(), String> {
    let all_paths = git_tree_ls_paths(root, new_tree)?;
    let init_set: HashSet<String> = INIT_TEMPLATE_PATHS
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    let base_set: HashSet<String> = match base_tree {
        Some(bt) => git_tree_ls_paths(root, bt)?
            .into_iter()
            .map(|s| s.to_ascii_lowercase())
            .collect(),
        None => HashSet::new(),
    };

    let mut violations = Vec::new();
    for p in &all_paths {
        let low = normalize_rel(p).to_ascii_lowercase();
        if low != PUBLIC_CILIN_REL && is_private_push_path(&low) {
            violations.push(format!("私有路径: {}", p));
            continue;
        }
        if !is_skeleton_path(p) && !init_set.contains(&low) && !base_set.contains(&low) {
            violations.push(format!("非骨架白名单路径: {}", p));
        }
    }

    if let Some(bt) = base_tree {
        for changed in git_diff_tree_paths(root, bt, new_tree)? {
            if !is_skeleton_path(&changed) {
                violations.push(format!("非法变更非骨架路径: {}", changed));
            }
        }
    }

    if !violations.is_empty() {
        return Err(format!(
            "上游骨架树安全校验未通过，已熔断同步:\n  {}",
            violations.join("\n  ")
        ));
    }
    Ok(())
}

fn validate_upstream_cfg(cfg: &ServerConfig) -> Result<(String, String), String> {
    let remote = cfg.upstream.remote.trim().to_string();
    let branch = cfg.upstream.branch.trim().to_string();
    if !is_valid_git_ref_name(&remote) || !is_valid_git_ref_name(&branch) {
        return Err(format!(
            "非法 [upstream] 配置: remote='{}', branch='{}'",
            remote, branch
        ));
    }
    Ok((remote, branch))
}

fn sanitize_index_blob_sha(root: &Path, blob_sha: &str) -> Result<String, String> {
    let raw_bytes = git_stdout_bytes(root, None, &["cat-file", "blob", blob_sha])?;
    let raw_text = String::from_utf8(raw_bytes)
        .map_err(|e| format!("index.html 非 UTF-8 编码: {}", e))?;
    let clean = sanitize_index_html_for_upstream(&raw_text);
    git_hash_object_bytes(root, clean.as_bytes())
}

// --- 核心业务 1：首次初始化上游骨架仓并锚定双父提交 ---

pub fn init_upstream(
    cfg: &ServerConfig,
    logs: Option<&LogBus>,
) -> Result<InitUpstreamSummary, String> {
    let (remote, branch) = validate_upstream_cfg(cfg)?;
    let root = strip_verbatim_prefix(&cfg.repo_root);

    if !git_status_ok(&root, None, &["remote", "get-url", &remote]) {
        return Err(format!(
            "未配置 Git 远端 '{}'，请先运行: git remote add {} <骨架仓库URL>",
            remote, remote
        ));
    }

    let porcelain = git_stdout(&root, None, &["status", "--porcelain"])?;
    if !porcelain.trim().is_empty() {
        return Err("当前工作区存在未提交改动，请先提交后再执行 init-upstream".to_string());
    }

    let remote_heads = git_stdout(&root, None, &["ls-remote", "--heads", &remote, &branch])?;
    if !remote_heads.trim().is_empty() {
        return Err(format!(
            "远端 {}/{} 已存在提交历史，为防覆盖已中止初始化",
            remote, branch
        ));
    }

    let head_sha = git_stdout(&root, None, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let head_tree = git_stdout(&root, None, &["rev-parse", "HEAD^{tree}"])?
        .trim()
        .to_string();

    let ls_raw = git_stdout(
        &root,
        None,
        &["-c", "core.quotepath=false", "ls-tree", "-r", "-z", "HEAD"],
    )?;
    let head_entries = parse_ls_tree_entries(&ls_raw);

    let mut entries: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut skeleton_count = 0usize;
    let mut favicon_entry: Option<(String, String)> = None;

    for (mode, sha, path) in &head_entries {
        let low = normalize_rel(path).to_ascii_lowercase();
        if low == "favicon.ico" {
            favicon_entry = Some((mode.clone(), sha.clone()));
            continue;
        }
        if !is_skeleton_path(path) {
            continue;
        }
        if low == "index.html" {
            let clean_sha = sanitize_index_blob_sha(&root, sha)?;
            entries.insert("index.html".to_string(), (mode.clone(), clean_sha));
        } else {
            entries.insert(path.clone(), (mode.clone(), sha.clone()));
        }
        skeleton_count += 1;
    }

    if skeleton_count == 0 {
        return Err("未在当前仓库找到任何骨架文件，无法初始化".to_string());
    }

    // 写入中性开箱样板种子
    let seeds: [(&str, &[u8]); 5] = [
        (".gitignore", neutral_gitignore().as_bytes()),
        ("_build/swamp.toml", neutral_swamp_toml().as_bytes()),
        ("src/tpl/bookmark.html", neutral_bookmark_html().as_bytes()),
        ("html/欢迎使用.html", neutral_welcome_html().as_bytes()),
        (
            "src/discussion_id_mapper.json",
            b"{\"records\":[],\"orphanIds\":[]}\n",
        ),
    ];
    for (rel, bytes) in seeds {
        let sha = git_hash_object_bytes(&root, bytes)?;
        entries.insert(rel.to_string(), ("100644".to_string(), sha));
    }
    if let Some((mode, sha)) = favicon_entry {
        entries.insert("favicon.ico".to_string(), (mode, sha));
    }

    let tmp_idx = TempGitIndex::new()?;
    git_index_write_entries(&root, &tmp_idx, &entries)?;
    let s0_tree = git_stdout(&root, Some(&tmp_idx), &["write-tree"])?
        .trim()
        .to_string();
    assert_upstream_tree_safe(&root, &s0_tree, None)?;

    let s0_commit = git_stdout(
        &root,
        None,
        &[
            "commit-tree",
            &s0_tree,
            "-m",
            "chore: initialize Swamp skeleton",
        ],
    )?
    .trim()
    .to_string();

    log_info(
        logs,
        format!(
            "[upstream] 正在推送初始骨架提交 {} ({} 个骨架文件) -> {}/{}",
            &s0_commit[..s0_commit.len().min(8)],
            skeleton_count,
            remote,
            branch
        ),
    );
    let refspec = format!("{}:refs/heads/{}", s0_commit, branch);
    let _ = git_stdout(&root, None, &["push", &remote, &refspec])?;
    let _ = git_stdout(&root, None, &["fetch", &remote, &branch])?;

    let anchor_msg = format!("chore: anchor upstream skeleton ({}/{})", remote, branch);
    let anchor_commit = git_stdout(
        &root,
        None,
        &[
            "commit-tree",
            &head_tree,
            "-p",
            &head_sha,
            "-p",
            &s0_commit,
            "-m",
            &anchor_msg,
        ],
    )?
    .trim()
    .to_string();
    let _ = git_stdout(
        &root,
        None,
        &[
            "update-ref",
            "-m",
            "swamp init-upstream",
            "HEAD",
            &anchor_commit,
            &head_sha,
        ],
    )?;

    log_info(
        logs,
        format!(
            "[upstream] 初始化完成: 上游 {}，本地锚点 {}（下次 push 即可同步 origin）",
            &s0_commit[..s0_commit.len().min(8)],
            &anchor_commit[..anchor_commit.len().min(8)]
        ),
    );

    Ok(InitUpstreamSummary {
        remote,
        branch,
        upstream_commit: s0_commit,
        anchor_commit,
        skeleton_count,
    })
}

// --- 核心业务 2：push 时自动分流骨架同步与双父本地提交 ---

fn index_html_skeleton_changed_in_staging(root: &Path) -> bool {
    let head_bytes = match git_stdout_bytes(root, None, &["show", "HEAD:index.html"]) {
        Ok(b) => b,
        Err(_) => return true,
    };
    let staged_bytes = match git_stdout_bytes(root, None, &["show", ":index.html"]) {
        Ok(b) => b,
        Err(_) => return true,
    };
    let Ok(head_s) = String::from_utf8(head_bytes) else {
        return true;
    };
    let Ok(staged_s) = String::from_utf8(staged_bytes) else {
        return true;
    };
    sanitize_index_html_for_upstream(&head_s) != sanitize_index_html_for_upstream(&staged_s)
}

pub fn prepare_upstream_sync(
    cfg: &ServerConfig,
    staged_paths: &[String],
    logs: Option<&LogBus>,
) -> Result<UpstreamSyncPlan, String> {
    if !cfg.upstream.auto_push {
        return Ok(UpstreamSyncPlan::Skip);
    }

    let skeleton_staged: Vec<&String> = staged_paths
        .iter()
        .filter(|p| is_skeleton_path(p))
        .collect();
    if skeleton_staged.is_empty() {
        return Ok(UpstreamSyncPlan::Skip);
    }

    let root = strip_verbatim_prefix(&cfg.repo_root);
    // 若仅命中 index.html 且脱敏后与 HEAD 无差异（纯站点参数变更），免 fetch 直接跳过
    if skeleton_staged.len() == 1
        && normalize_rel(skeleton_staged[0]).eq_ignore_ascii_case("index.html")
        && !index_html_skeleton_changed_in_staging(&root)
    {
        return Ok(UpstreamSyncPlan::NoSkeletonDiff);
    }

    let (remote, branch) = validate_upstream_cfg(cfg)?;
    if !git_status_ok(&root, None, &["remote", "get-url", &remote]) {
        log_info(
            logs,
            format!("[upstream] 未配置远端 '{}'，跳过骨架自动同步", remote),
        );
        return Ok(UpstreamSyncPlan::Skip);
    }

    log_info(
        logs,
        format!("[upstream] 检测到骨架变更，正在检查 {}/{} 状态...", remote, branch),
    );
    let _ = git_stdout(&root, None, &["fetch", &remote, &branch])?;

    let remote_ref = format!("refs/remotes/{}/{}", remote, branch);
    let base_commit = git_stdout(&root, None, &["rev-parse", "--verify", &remote_ref])
        .map_err(|_| {
            format!(
                "远端 {}/{} 尚未初始化，请先运行 `swamp init-upstream` 建立初始锚点",
                remote, branch
            )
        })?
        .trim()
        .to_string();

    if !git_status_ok(&root, None, &["merge-base", "--is-ancestor", &base_commit, "HEAD"]) {
        return Err(format!(
            "上游 {}/{} 存在尚未拉取的新提交（如已合并的 PR），请先点击「拉取上游」同步后再推送，防止覆盖他人贡献",
            remote, branch
        ));
    }

    let base_tree = git_stdout(&root, None, &["rev-parse", &format!("{}^{{tree}}", base_commit)])?
        .trim()
        .to_string();

    // 在内存中合成上游新树：保留上游基底中的所有非骨架样板文件 + 替换为本地最新骨架文件
    let mut entries: BTreeMap<String, (String, String)> = BTreeMap::new();
    let base_ls_raw = git_stdout(
        &root,
        None,
        &["-c", "core.quotepath=false", "ls-tree", "-r", "-z", &base_tree],
    )?;
    for (mode, sha, path) in parse_ls_tree_entries(&base_ls_raw) {
        if !is_skeleton_path(&path) {
            entries.insert(path, (mode, sha));
        }
    }

    let staged_all_raw = git_stdout(
        &root,
        None,
        &["-c", "core.quotepath=false", "ls-files", "-s", "-z"],
    )?;
    for (mode, sha, path) in parse_ls_files_stage_entries(&staged_all_raw) {
        if !is_skeleton_path(&path) {
            continue;
        }
        if normalize_rel(&path).eq_ignore_ascii_case("index.html") {
            let clean_sha = sanitize_index_blob_sha(&root, &sha)?;
            entries.insert("index.html".to_string(), (mode, clean_sha));
        } else {
            entries.insert(path, (mode, sha));
        }
    }

    let tmp_idx = TempGitIndex::new()?;
    git_index_write_entries(&root, &tmp_idx, &entries)?;
    let new_tree = git_stdout(&root, Some(&tmp_idx), &["write-tree"])?
        .trim()
        .to_string();

    if new_tree == base_tree {
        return Ok(UpstreamSyncPlan::NoSkeletonDiff);
    }

    assert_upstream_tree_safe(&root, &new_tree, Some(&base_tree))?;
    let changed_skeleton_files = git_diff_tree_paths(&root, &base_tree, &new_tree)?;
    let has_user_changes = staged_paths.iter().any(|p| is_user_owned_path(p));

    Ok(UpstreamSyncPlan::Ready(PreparedUpstreamSync {
        remote,
        branch,
        base_commit,
        new_tree,
        changed_skeleton_files,
        has_user_changes,
    }))
}

pub fn push_upstream_commit(
    cfg: &ServerConfig,
    plan: &PreparedUpstreamSync,
    upstream_msg: &str,
    logs: Option<&LogBus>,
) -> Result<String, String> {
    let msg = upstream_msg.trim();
    if msg.is_empty() {
        return Err("上游骨架 Commit 说明不能为空".to_string());
    }
    let root = strip_verbatim_prefix(&cfg.repo_root);
    let new_commit = git_stdout(
        &root,
        None,
        &[
            "commit-tree",
            &plan.new_tree,
            "-p",
            &plan.base_commit,
            "-m",
            msg,
        ],
    )?
    .trim()
    .to_string();

    let refspec = format!("{}:refs/heads/{}", new_commit, plan.branch);
    let _ = git_stdout(&root, None, &["push", &plan.remote, &refspec])?;

    let tracking_ref = format!("refs/remotes/{}/{}", plan.remote, plan.branch);
    let _ = git_stdout(&root, None, &["update-ref", &tracking_ref, &new_commit]);

    log_info(
        logs,
        format!(
            "[upstream] 已同步 {} 个骨架文件 -> {}/{} ({}): {}",
            plan.changed_skeleton_files.len(),
            plan.remote,
            plan.branch,
            &new_commit[..new_commit.len().min(8)],
            msg
        ),
    );
    Ok(new_commit)
}

/// 将当前暂存区写成带有第二父提交（上游骨架提交）的本地提交，保持 merge-base 精确对齐
pub fn commit_local_staged_with_second_parent(
    root: &Path,
    commit_msg: &str,
    second_parent: &str,
) -> Result<String, String> {
    let head_sha = git_stdout(root, None, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let local_tree = git_stdout(root, None, &["write-tree"])?
        .trim()
        .to_string();
    let new_head = git_stdout(
        root,
        None,
        &[
            "commit-tree",
            &local_tree,
            "-p",
            &head_sha,
            "-p",
            second_parent,
            "-m",
            commit_msg,
        ],
    )?
    .trim()
    .to_string();
    let reflog_msg = format!("commit: {}", commit_msg.lines().next().unwrap_or("sync"));
    let _ = git_stdout(
        root,
        None,
        &["update-ref", "-m", &reflog_msg, "HEAD", &new_head, &head_sha],
    )?;
    Ok(new_head)
}

// --- 核心业务 3：拉取上游 PR / 骨架更新并强保护用户独占文件 ---

pub fn pull_upstream(
    cfg: &ServerConfig,
    logs: Option<&LogBus>,
) -> Result<PullUpstreamOutcome, String> {
    let (remote, branch) = validate_upstream_cfg(cfg)?;
    let root = strip_verbatim_prefix(&cfg.repo_root);

    if !git_status_ok(&root, None, &["remote", "get-url", &remote]) {
        return Err(format!(
            "未配置 Git 远端 '{}'，请先运行: git remote add {} <骨架仓库URL>",
            remote, remote
        ));
    }

    let porcelain = git_stdout(&root, None, &["status", "--porcelain"])?;
    if !porcelain.trim().is_empty() {
        return Err("工作区存在未提交改动，请先提交或清理后再拉取上游".to_string());
    }

    log_info(
        logs,
        format!("[upstream] 正在从 {}/{} 拉取最新骨架...", remote, branch),
    );
    let _ = git_stdout(&root, None, &["fetch", &remote, &branch])?;

    let remote_ref = format!("refs/remotes/{}/{}", remote, branch);
    let upstream_commit = git_stdout(&root, None, &["rev-parse", "--verify", &remote_ref])
        .map_err(|_| format!("未找到远端分支 {}/{}", remote, branch))?
        .trim()
        .to_string();

    if git_status_ok(&root, None, &["merge-base", "--is-ancestor", &upstream_commit, "HEAD"]) {
        log_info(
            logs,
            format!("[upstream] 本地已包含 {}/{} 全部最新提交，无需合并", remote, branch),
        );
        return Ok(PullUpstreamOutcome::UpToDate { remote, branch });
    }

    let merge_out = git_cmd(&root, None)
        .args(["merge", "--no-ff", "--no-commit", &upstream_commit])
        .output()
        .map_err(|e| format!("启动 git merge 失败: {}", e))?;

    if !merge_out.status.success() {
        let stderr = String::from_utf8_lossy(&merge_out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&merge_out.stdout).trim().to_string();
        if stderr.to_ascii_lowercase().contains("unrelated histories") {
            return Err(format!(
                "本地与 {}/{} 无共同祖先历史；如为首次接入，请先运行 `swamp init-upstream` 或手动建立锚点",
                remote, branch
            ));
        }
        let unmerged_check = git_stdout(
            &root,
            None,
            &["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=U", "-z"],
        )
        .unwrap_or_default();
        if unmerged_check.trim().is_empty() && !stdout.contains("CONFLICT") {
            let _ = git_cmd(&root, None).args(["merge", "--abort"]).status();
            return Err(format!("git merge 失败: {} {}", stdout, stderr));
        }
    }

    // 强制保护用户独占层：还原任何被上游触碰或冲突的个人文件，剔除上游新增的示例内容
    let mut touched_set: HashSet<String> = HashSet::new();
    for args in [
        &["-c", "core.quotepath=false", "diff", "--name-only", "-z", "HEAD"][..],
        &["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"][..],
        &["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=U", "-z"][..],
    ] {
        if let Ok(raw) = git_stdout(&root, None, args) {
            for p in raw.split('\0').filter(|s| !s.is_empty()) {
                touched_set.insert(p.replace('\\', "/"));
            }
        }
    }

    let mut protected_user_files: Vec<String> = Vec::new();
    let mut touched_sorted: Vec<String> = touched_set.into_iter().collect();
    touched_sorted.sort();

    for rel in touched_sorted {
        if !is_user_owned_path(&rel) {
            continue;
        }
        let head_spec = format!("HEAD:{}", rel);
        if git_status_ok(&root, None, &["cat-file", "-e", &head_spec]) {
            let _ = git_stdout(&root, None, &["checkout", "HEAD", "--", &rel])?;
        } else {
            let _ = git_cmd(&root, None)
                .args(["rm", "-f", "--ignore-unmatch", "--", &rel])
                .status();
            let phys = root.join(&rel);
            if phys.is_file() {
                let _ = fs::remove_file(&phys);
            }
        }
        protected_user_files.push(rel);
    }

    if !protected_user_files.is_empty() {
        log_info(
            logs,
            format!(
                "[upstream] 已自动保护 {} 个用户独占文件不被覆盖: {}",
                protected_user_files.len(),
                protected_user_files.join(", ")
            ),
        );
    }

    let conflict_raw = git_stdout(
        &root,
        None,
        &["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=U", "-z"],
    )?;
    let mut conflict_files: Vec<String> = conflict_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect();
    conflict_files.sort();
    conflict_files.dedup();

    if !conflict_files.is_empty() {
        return Ok(PullUpstreamOutcome::Conflicts {
            remote,
            branch,
            upstream_commit,
            conflict_files,
            protected_user_files,
        });
    }

    let merged_raw = git_stdout(
        &root,
        None,
        &["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"],
    )?;
    let mut merged_files: Vec<String> = merged_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect();
    merged_files.sort();
    merged_files.dedup();

    let short_sha = &upstream_commit[..upstream_commit.len().min(8)];
    let merge_msg = format!("merge: pull upstream {}/{} ({})", remote, branch, short_sha);
    let _ = git_stdout(&root, None, &["commit", "-m", &merge_msg])?;

    let mut need_wasm = false;
    let mut need_exe = false;
    let mut need_gen = false;
    for f in &merged_files {
        let low = normalize_rel(f).to_ascii_lowercase();
        if low == "_build/swamp-server/src/lib.rs" {
            need_wasm = true;
            need_gen = true;
        } else if low.starts_with("_build/swamp-server/") && low != PUBLIC_CILIN_REL {
            need_exe = true;
        } else if low.starts_with("src/")
            || low == "index.html"
            || low == "_build/core.toml"
            || low == "readme.md"
        {
            need_gen = true;
        }
    }

    Ok(PullUpstreamOutcome::Merged {
        remote,
        branch,
        upstream_commit,
        merged_files,
        protected_user_files,
        need_exe,
        need_wasm,
        need_gen,
    })
}

// --- 核心业务 4：安全发版打标（仅对上游骨架仓 remote/branch 打 Tag，杜绝误推个人 HEAD） ---

#[derive(Clone, Debug)]
pub struct TagUpstreamSummary {
    pub remote: String,
    pub branch: String,
    pub tag: String,
    pub target_commit: String,
    pub pushed: bool,
}

/// 规范化并校验发版 Tag（接受 `1.0.1` 或 `v1.0.1`，返回 `("v1.0.1", "1.0.1")`）
pub fn normalize_release_tag(raw: &str) -> Result<(String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("版本号不能为空".to_string());
    }
    let ver = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if ver.is_empty() || !ver.as_bytes()[0].is_ascii_digit() || !ver.contains('.') {
        return Err(format!(
            "非法语义版本号 '{}'（示例: v1.0.1 或 1.0.1）",
            raw
        ));
    }
    if !crate::services::release_pack::validate_release_version(ver) {
        return Err(format!("非法版本号字符: '{}'", raw));
    }
    let tag = format!("v{}", ver);
    if !is_valid_git_ref_name(&tag) {
        return Err(format!("非法 Git Tag 名称: '{}'", tag));
    }
    Ok((tag, ver.to_string()))
}

/// 从 Cargo.toml 文本精确解析 `[package].version`
pub fn extract_cargo_package_version(raw: &str) -> Option<String> {
    let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let val: toml::Value = toml::from_str(clean).ok()?;
    val.get("package")?
        .get("version")?
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}


/// 读取本地 `_build/swamp-server/Cargo.toml` 中的 `[package].version`
pub fn read_local_cargo_version(cfg: &ServerConfig) -> Option<String> {
    let path = cfg.build_dir.join("swamp-server").join("Cargo.toml");
    let raw = fs::read_to_string(path).ok()?;
    extract_cargo_package_version(&raw)
}

/// 在 Cargo.toml 文本中精准更新 `[package]` 段的 `version` 字段，保留注释、格式与原换行风格并做 TOML 校验
pub fn update_cargo_toml_version_text(raw: &str, raw_ver: &str) -> Result<(String, String), String> {
    let (_tag, ver) = normalize_release_tag(raw_ver)?;
    let use_crlf = raw.contains("\r\n");
    let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(raw).replace("\r\n", "\n");
    let mut lines: Vec<String> = clean.lines().map(|l| l.to_string()).collect();

    let mut in_package = false;
    let mut updated = false;

    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            let sec = trimmed.split('#').next().unwrap_or("").trim();
            in_package = sec == "[package]";
            continue;
        }
        if !in_package || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((lhs, _rhs)) = trimmed.split_once('=') {
            if lhs.trim() == "version" {
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                *line = format!("{}version = \"{}\"", indent, ver);
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err("未在 Cargo.toml 的 [package] 段找到 version 字段".to_string());
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }

    let parsed_ver = extract_cargo_package_version(&out)
        .ok_or_else(|| "写回前 Cargo.toml TOML 校验失败，已中止保存".to_string())?;
    if parsed_ver != ver {
        return Err("写回前 Cargo.toml 版本号校验不一致，已中止保存".to_string());
    }

    let final_txt = if use_crlf {
        out.replace('\n', "\r\n")
    } else {
        out
    };
    Ok((final_txt, ver))
}

/// 原子写回本地 `_build/swamp-server/Cargo.toml` 的 `[package].version`
pub fn save_local_cargo_version(cfg: &ServerConfig, raw_ver: &str) -> Result<String, String> {
    let path = cfg.build_dir.join("swamp-server").join("Cargo.toml");
    if !path.is_file() {
        return Err("未找到 _build/swamp-server/Cargo.toml（仅源码开发环境支持修改版本号）".to_string());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("读取 Cargo.toml 失败: {}", e))?;
    let (updated, ver) = update_cargo_toml_version_text(&raw, raw_ver)?;
    crate::api_files::write_atomic(&path, &updated, false)?;
    Ok(ver)
}

/// 识别 GitHub Pages 站点仓地址（安全底线：禁止将骨架发版 Tag 推往 `*.github.io` 个人站）
pub fn is_github_pages_remote_url(url: &str) -> bool {
    url.trim().to_ascii_lowercase().contains(".github.io")
}

/// 安全给上游骨架仓 `<remote>/<branch>` 打发版 Tag 并推送（强制核对 Cargo.toml 版本与树隐私，绝不指向本地 HEAD）
pub fn tag_upstream_release(
    cfg: &ServerConfig,
    version_override: Option<&str>,
    dry_run: bool,
    logs: Option<&LogBus>,
) -> Result<TagUpstreamSummary, String> {
    let (remote, branch) = validate_upstream_cfg(cfg)?;
    let root = strip_verbatim_prefix(&cfg.repo_root);

    let remote_url = git_stdout(&root, None, &["remote", "get-url", &remote])
        .map_err(|_| {
            format!(
                "未配置 Git 远端 '{}'，请先运行: git remote add {} <骨架仓库URL>",
                remote, remote
            )
        })?
        .trim()
        .to_string();
    if is_github_pages_remote_url(&remote_url) {
        return Err(format!(
            "安全拦截：远端 '{}' 指向 GitHub Pages 仓库 ({})，禁止向个人站点仓推送骨架发版 Tag",
            remote, remote_url
        ));
    }

    let local_cargo_path = cfg.build_dir.join("swamp-server").join("Cargo.toml");
    let local_cargo_raw = fs::read_to_string(&local_cargo_path)
        .map_err(|e| format!("读取本地 Cargo.toml 失败: {}", e))?;
    let local_ver = extract_cargo_package_version(&local_cargo_raw)
        .ok_or_else(|| "无法从本地 _build/swamp-server/Cargo.toml 解析 [package].version".to_string())?;

    let (tag, ver) = match version_override.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(raw) => normalize_release_tag(raw)?,
        None => normalize_release_tag(&local_ver)?,
    };

    if local_ver != ver {
        return Err(format!(
            "本地 Cargo.toml 版本 ({}) 与目标发版 Tag ({}) 不一致，请先更新 _build/swamp-server/Cargo.toml 并同步到上游",
            local_ver, tag
        ));
    }

    if env!("CARGO_PKG_VERSION") != ver {
        log_info(
            logs,
            format!(
                "[tag] 提示：当前运行的 swamp.exe 编译版本为 {}，与目标版本 {} 不同（CI 将按上游源码重新编译）",
                env!("CARGO_PKG_VERSION"),
                ver
            ),
        );
    }

    log_info(
        logs,
        format!("[tag] 正在拉取 {}/{} 最新引用以校验发版目标...", remote, branch),
    );
    let _ = git_stdout(&root, None, &["fetch", &remote, &branch])?;

    let remote_ref = format!("refs/remotes/{}/{}", remote, branch);
    let target_commit = git_stdout(&root, None, &["rev-parse", "--verify", &remote_ref])
        .map_err(|_| format!("未找到远端分支 {}/{}，请确认已完成 init-upstream", remote, branch))?
        .trim()
        .to_string();

    // 核对远端骨架仓目标提交中的 Cargo.toml 版本号，确保新版本确实已推送到上游骨架仓
    let remote_cargo_spec = format!("{}:_build/swamp-server/Cargo.toml", target_commit);
    let remote_cargo_raw = git_stdout(&root, None, &["show", &remote_cargo_spec])
        .map_err(|e| format!("读取远端 {}/{} 中的 Cargo.toml 失败: {}", remote, branch, e))?;
    let remote_ver = extract_cargo_package_version(&remote_cargo_raw)
        .ok_or_else(|| format!("无法解析远端 {}/{} 中的 Cargo.toml 版本号", remote, branch))?;
    if remote_ver != ver {
        return Err(format!(
            "远端 {}/{} 中的 Cargo.toml 版本为 {}，与目标标签 {} 不一致；请先在控制台执行 push 将新版本同步到上游后再运行 swamp tag",
            remote, branch, remote_ver, tag
        ));
    }

    // 二次隐私兜底：确认远端目标树不包含任何私密路径
    let target_tree = git_stdout(&root, None, &["rev-parse", &format!("{}^{{tree}}", target_commit)])?
        .trim()
        .to_string();
    let target_paths = git_tree_ls_paths(&root, &target_tree)?;
    let priv_hits: Vec<String> = target_paths
        .into_iter()
        .filter(|p| {
            let low = normalize_rel(p).to_ascii_lowercase();
            low != PUBLIC_CILIN_REL && is_private_push_path(&low)
        })
        .collect();
    if !priv_hits.is_empty() {
        return Err(format!(
            "安全拦截：远端目标提交包含私密路径，已中止打标:\n  {}",
            priv_hits.join("\n  ")
        ));
    }

    // 检查远端与本地是否已存在同名 Tag
    let tag_ref = format!("refs/tags/{}", tag);
    let remote_tag = git_stdout(&root, None, &["ls-remote", "--tags", &remote, &tag_ref])?;
    if !remote_tag.trim().is_empty() {
        return Err(format!("远端 '{}' 已存在标签 {}，请递增版本号后再发布", remote, tag));
    }
    if git_status_ok(&root, None, &["rev-parse", "--verify", "--quiet", &tag_ref]) {
        return Err(format!(
            "本地已存在标签 {}，如为旧残留请先手动确认并执行 git tag -d {}",
            tag, tag
        ));
    }

    if dry_run {
        log_info(
            logs,
            format!(
                "[tag] 预检通过 (dry-run): 将对 {}/{} ({}) 打标 {} 并推送至 {}",
                remote,
                branch,
                &target_commit[..target_commit.len().min(8)],
                tag,
                remote
            ),
        );
        return Ok(TagUpstreamSummary {
            remote,
            branch,
            tag,
            target_commit,
            pushed: false,
        });
    }

    let tag_msg = format!("Release {}", tag);
    let _ = git_stdout(&root, None, &["tag", "-a", &tag, &target_commit, "-m", &tag_msg])?;

    let push_spec = format!("{}:{}", tag_ref, tag_ref);
    if let Err(e) = git_stdout(&root, None, &["push", &remote, &push_spec]) {
        let _ = git_stdout(&root, None, &["tag", "-d", &tag]);
        return Err(format!("推送标签 {} 到 {} 失败（已回滚本地标签）: {}", tag, remote, e));
    }

    log_info(
        logs,
        format!(
            "[tag] 已安全推送标签 {} -> {}/{} ({})",
            tag,
            remote,
            branch,
            &target_commit[..target_commit.len().min(8)]
        ),
    );

    Ok(TagUpstreamSummary {
        remote,
        branch,
        tag,
        target_commit,
        pushed: true,
    })
}
