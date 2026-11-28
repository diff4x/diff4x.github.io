//! 双仓单物理目录骨架同步引擎：临时索引孤儿树合成、双父提交锚定、自动分流推送与上游 PR 无痛拉取。

use std::collections::HashSet;
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

const PUBLIC_CILIN_REL: &str = "_build/swamp-server/assets/cilin.txt";

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
    Skip(String),
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

struct TempGitIndex {
    path: PathBuf,
}

impl TempGitIndex {
    fn new(temp_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(temp_dir)
            .map_err(|e| format!("创建临时索引目录失败: {}", e))?;
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = strip_verbatim_prefix(&temp_dir.join(format!(
            "git_upstream_idx_{}_{}",
            std::process::id(),
            ms
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
            | "_build/core.toml"
            | "_build/local.toml.example"
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
    const NEUTRAL_PARAM: &str = "<script>\n  const github_page = \"\";\n  const site_repo = \"\";\n  const data_repo = \"\";\n  const data_repo_id = \"\";\n  const data_category_id = \"\";\n  const update_interval = 10000;\n  const update_interval_local = 2000;\n  const readme_md = \"/README.md\";\n</script>";
    render_index_html_meta(html, "Digital Swamp", false, NEUTRAL_PARAM)
        .unwrap_or_else(|| html.to_string())
}

// --- 中性开箱样板（仅用于 init-upstream 初始化骨架仓） ---

fn neutral_gitignore() -> &'static str {
    "# 通用隐私与本地临时文件隔离规则（Swamp 骨架默认）\n\
     html/__*.html\n\
     gallery/diary/\n\
     src/js/data/shadow*\n\
     _build/temp/\n\
     _build/privy/\n\
     _build/swamp.exe\n"
}

fn neutral_swamp_toml() -> &'static str {
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

fn neutral_bookmark_html() -> &'static str {
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
  <header id="site-intro">
   <h1>Digital Swamp</h1>
   <p>纯静态个人知识库与多媒体离线阅读站（可在 src/tpl/bookmark.html 自定义本段简介与链接）</p>
  </header>
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

fn neutral_welcome_html() -> &'static str {
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

fn git_index_put_blob(
    root: &Path,
    idx: &TempGitIndex,
    mode: &str,
    blob_sha: &str,
    rel_path: &str,
) -> Result<(), String> {
    let spec = format!("{},{},{}", mode, blob_sha, rel_path);
    let _ = git_stdout(root, Some(idx), &["update-index", "--add", "--cacheinfo", &spec])?;
    Ok(())
}

fn git_index_remove(root: &Path, idx: &TempGitIndex, rel_path: &str) -> Result<(), String> {
    let _ = git_stdout(root, Some(idx), &["update-index", "--force-remove", "--", rel_path])?;
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
        if parts.len() >= 3 && parts[2] == "0" {
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

fn sanitize_and_put_index_html(
    root: &Path,
    idx: &TempGitIndex,
    mode: &str,
    blob_sha: &str,
) -> Result<(), String> {
    let raw_bytes = git_stdout_bytes(root, None, &["cat-file", "blob", blob_sha])?;
    let raw_text = String::from_utf8(raw_bytes)
        .map_err(|e| format!("index.html 非 UTF-8 编码: {}", e))?;
    let clean = sanitize_index_html_for_upstream(&raw_text);
    let sanitized_sha = git_hash_object_bytes(root, clean.as_bytes())?;
    git_index_put_blob(root, idx, mode, &sanitized_sha, "index.html")
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

    let tmp_idx = TempGitIndex::new(&cfg.temp_dir)?;
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
            sanitize_and_put_index_html(&root, &tmp_idx, mode, sha)?;
        } else {
            git_index_put_blob(&root, &tmp_idx, mode, sha, path)?;
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
        git_index_put_blob(&root, &tmp_idx, "100644", &sha, rel)?;
    }
    if let Some((mode, sha)) = favicon_entry {
        git_index_put_blob(&root, &tmp_idx, &mode, &sha, "favicon.ico")?;
    }

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
        return Ok(UpstreamSyncPlan::Skip("auto_push 未启用".to_string()));
    }

    let skeleton_staged: Vec<&String> = staged_paths
        .iter()
        .filter(|p| is_skeleton_path(p))
        .collect();
    if skeleton_staged.is_empty() {
        return Ok(UpstreamSyncPlan::Skip("本次提交不含骨架改动".to_string()));
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
        return Ok(UpstreamSyncPlan::Skip(format!(
            "未配置远端 '{}'，跳过骨架自动同步",
            remote
        )));
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

    let tmp_idx = TempGitIndex::new(&cfg.temp_dir)?;
    let _ = git_stdout(&root, Some(&tmp_idx), &["read-tree", &base_commit])?;

    // 先清理临时索引里旧的骨架条目，以精确同步删除动作
    let base_paths = git_tree_ls_paths(&root, &base_tree)?;
    for bp in &base_paths {
        if is_skeleton_path(bp) {
            git_index_remove(&root, &tmp_idx, bp)?;
        }
    }

    // 用当前本地主索引（包含刚 git add 的最新改动）回填所有骨架文件
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
            sanitize_and_put_index_html(&root, &tmp_idx, &mode, &sha)?;
        } else {
            git_index_put_blob(&root, &tmp_idx, &mode, &sha, &path)?;
        }
    }

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
