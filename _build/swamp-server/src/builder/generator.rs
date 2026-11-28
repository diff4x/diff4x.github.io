//! 站点全量构建核心：参数注入、HTML/媒体扫描、切片与清单生成、Aho-Corasick 全覆盖隐私隔离断言与原子提交。

use aho_corasick::AhoCorasick;
use chrono::Local;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::api_files::{write_atomic, write_bytes_atomic};
use crate::builder::html_utils::{escape_html, extract_anchor_text, extract_body_text, extract_title};
use crate::builder::{log_info, log_warn, synonyms};
use crate::config::{normalize_web_path, strip_verbatim_prefix, ServerConfig};
use crate::services::log_bus::LogBus;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct FileMeta {
    hash: String,
    source: &'static str,
}

struct MediaNode {
    local_only: bool,
    link: String,
    media_type: String,
}

pub(crate) struct PrivateLeakInput {
    pub label: String,
    pub body: String,
    pub allowed_lite_meta: Vec<String>,
}

struct HtmlScanOutcome {
    pending_rewrites: Vec<(PathBuf, String)>,
    rewritten_html_map: HashMap<String, String>,
    pruned_lines: usize,
    image_set: HashSet<String>,
    used_images: HashSet<String>,
}

enum PreparedManifest {
    Updated { version: String, core_list_js: String },
    Unchanged { old_version: Option<String> },
}

struct StagingDirGuard(PathBuf);

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct IgnoreRules {
    gi: Gitignore,
    local_only_exact: HashSet<String>,
    local_only_any_seg: HashSet<String>,
    git_ignored: HashSet<String>,
}

impl IgnoreRules {
    fn is_private_rel(&self, rel_slash: &str, is_dir: bool) -> bool {
        if self.git_ignored.contains(rel_slash) {
            return true;
        }
        if self.local_only_exact.contains(rel_slash) {
            return true;
        }
        for (idx, _) in rel_slash.match_indices('/') {
            if self.local_only_exact.contains(&rel_slash[..idx]) {
                return true;
            }
        }
        for seg in rel_slash.split('/') {
            if !seg.is_empty() && self.local_only_any_seg.contains(seg) {
                return true;
            }
        }
        self.gi
            .matched_path_or_any_parents(Path::new(rel_slash), is_dir)
            .is_ignore()
    }
}

fn join_rel(root: &Path, rel_slash: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in rel_slash.trim_start_matches('/').split('/') {
        if !seg.is_empty() {
            p.push(seg);
        }
    }
    p
}

pub fn run_with_options(
    cfg: &ServerConfig,
    logs: Option<&LogBus>,
    force_synonyms: bool,
) -> Result<Option<String>, String> {
    let prepared_index_html = prepare_index_html_injection(cfg, logs)?;
    let mut rules = load_gitignore_rules(cfg)?;

    let mapper_src = if cfg.discussion_id_mapper.is_file() {
        Some(&cfg.discussion_id_mapper)
    } else if cfg.legacy_cmt_mapper.is_file() {
        Some(&cfg.legacy_cmt_mapper)
    } else {
        None
    };

    let mut cmt_root: Map<String, Value> = if let Some(src_path) = mapper_src {
        let raw = fs::read_to_string(src_path)
            .map_err(|e| format!("读取 discussion_id_mapper.json 失败: {}", e))?;
        let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).trim();
        if trimmed.is_empty() {
            Map::new()
        } else {
            serde_json::from_str::<Value>(trimmed)
                .map_err(|e| format!("解析 discussion_id_mapper.json 失败: {}", e))?
                .as_object()
                .cloned()
                .unwrap_or_default()
        }
    } else {
        Map::new()
    };

    let mut records: Vec<Value> = cmt_root
        .get("records")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut max_id: i64 = 0;
    for r in &records {
        if let Some(id) = r.get("id").and_then(|v| v.as_i64()) {
            if id > max_id {
                max_id = id;
            }
        }
    }

    let mut lite_tree = init_lite_tree();
    let mut core_bundle: BTreeMap<String, String> = BTreeMap::new();
    let mut fat_data_map: BTreeMap<i64, String> = BTreeMap::new();
    let mut shadow_data_map: BTreeMap<i64, String> = BTreeMap::new();
    let mut private_leak_entries: Vec<PrivateLeakInput> = Vec::new();
    let mut public_docs_for_df: BTreeMap<i64, String> = BTreeMap::new();
    let mut private_page_names: BTreeSet<String> = BTreeSet::new();
    let mut current_titles: HashSet<String> = HashSet::new();

    let exclude_patterns: Vec<Regex> = cfg
        .exclude_html_regex
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(|pat| Regex::new(pat).map_err(|e| format!("无效的排除正则 {}: {}", pat, e)))
        .collect::<Result<Vec<_>, _>>()?;

    let html_outcome = process_html_files_and_images(
        cfg,
        &mut rules,
        &exclude_patterns,
        &mut lite_tree,
        &mut core_bundle,
        &mut records,
        &mut current_titles,
        &mut max_id,
        &mut fat_data_map,
        &mut shadow_data_map,
        &mut private_leak_entries,
        &mut public_docs_for_df,
        &mut private_page_names,
        logs,
    )?;

    let pruned_private_recs = prune_deleted_private_records(&mut records, &current_titles);
    if pruned_private_recs > 0 {
        log_info(
            logs,
            format!(
                "[gen] 已从 discussion_id_mapper.json 清理 {} 条已删除的私有页历史记录",
                pruned_private_recs
            ),
        );
    }

    let orphan_ids: Vec<Value> = records
        .iter()
        .filter_map(|r| {
            let t = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if !current_titles.contains(t) {
                r.get("id").cloned()
            } else {
                None
            }
        })
        .collect();
    cmt_root.insert("records".to_string(), Value::Array(records));
    cmt_root.insert("orphanIds".to_string(), Value::Array(orphan_ids));
    let cmt_json = serde_json::to_string(&Value::Object(cmt_root))
        .map_err(|e| format!("序列化 discussion_id_mapper.json 失败: {}", e))?;

    scan_all_medias(cfg, &rules, &mut lite_tree, logs);

    let staging_parent = cfg.backup_dir.parent().unwrap_or(&cfg.build_dir);
    let staging_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging_dir = staging_parent.join(format!("staging_data_{}_{}", std::process::id(), staging_ms));
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("创建构建暂存目录失败 ({}): {}", staging_dir.display(), e))?;
    let _staging_guard = StagingDirGuard(staging_dir.clone());

    let generated_data_files =
        generate_lite_and_fat_data(&lite_tree, &fat_data_map, &staging_dir, cfg.slice_size_bytes)?;
    if !shadow_data_map.is_empty() {
        generate_shadow_data(&shadow_data_map, &staging_dir, cfg.slice_size_bytes)?;
    }

    // 事务暂存同义词：在公私隔离断言通过之前绝不改写正式目录中的 synonyms.js
    let prepared_syn = synonyms::prepare_if_needed(
        cfg,
        &public_docs_for_df,
        &lite_tree,
        force_synonyms,
        logs,
    )?;
    let staged_syn_js = prepared_syn
        .as_ref()
        .and_then(|p| p.staged_js.as_ref())
        .map(|s| s.minified_js.as_str());

    let prepared_manifest = prepare_manifest(
        cfg,
        &rules,
        &exclude_patterns,
        &mut core_bundle,
        &generated_data_files,
        &staging_dir,
        prepared_index_html.as_deref(),
        &html_outcome.rewritten_html_map,
        staged_syn_js,
        &cmt_json,
        logs,
    )?;

    let staged_core_list_js = match &prepared_manifest {
        PreparedManifest::Updated { core_list_js, .. } => Some(core_list_js.as_str()),
        PreparedManifest::Unchanged { .. } => None,
    };

    assert_no_private_leak(
        cfg,
        &rules,
        &staging_dir,
        &private_page_names,
        &shadow_data_map,
        &private_leak_entries,
        &generated_data_files,
        &core_bundle,
        staged_syn_js,
        staged_core_list_js,
        &cmt_json,
        logs,
    )?;

    if let Some(ref syn_out) = prepared_syn {
        synonyms::commit_prepared(cfg, syn_out, logs)?;
    }
    if let Some(ref updated_idx) = prepared_index_html {
        write_atomic(&cfg.index_html, updated_idx, false)?;
    }
    write_atomic(&cfg.discussion_id_mapper, &cmt_json, false)?;
    commit_staging_to_data_dir(&staging_dir, &cfg.data_dir)?;

    let active_build_version = match prepared_manifest {
        PreparedManifest::Updated {
            version,
            core_list_js,
        } => {
            let core_list_path = cfg.js_raw_dir.join("core-list.js");
            if let Some(parent) = core_list_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            write_atomic(&core_list_path, &core_list_js, false)?;
            Some(version)
        }
        PreparedManifest::Unchanged { old_version } => old_version,
    };

    if !html_outcome.pending_rewrites.is_empty() {
        let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_dir = cfg.backup_dir.join(format!("html_{}", stamp));
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("创建备份目录失败: {}", e))?;
        for (src_path, new_content) in &html_outcome.pending_rewrites {
            let fname = src_path.file_name().unwrap();
            fs::copy(src_path, backup_dir.join(fname))
                .map_err(|e| format!("备份源文件失败: {}", e))?;
            write_atomic(src_path, new_content, false)?;
        }
        log_warn(
            logs,
            format!(
                "[gen] 已清理 {} 行失效图片引用（{} 个文件），备份位于 {}",
                html_outcome.pruned_lines,
                html_outcome.pending_rewrites.len(),
                backup_dir.display()
            ),
        );
    }

    generate_idle_image_list(cfg, &html_outcome.image_set, &html_outcome.used_images);

    Ok(active_build_version)
}

fn init_lite_tree() -> Value {
    json!({
        "html": {},
        "image": {},
        "ebook": {},
        "video": {},
        "audio": {}
    })
}

/// 向 index.html 注入站点标题、成人门禁开关（data-adult-gate）与 PARAM 参数块
pub(crate) fn render_index_html_meta(
    html: &str,
    site_title: &str,
    adult_gate: bool,
    script_block: &str,
) -> Option<String> {
    static HTML_OPEN_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static ADULT_ATTR_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static TITLE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

    let begin_tag = "<!-- PARAM-BEGIN -->";
    let end_tag = "<!-- PARAM-END -->";
    let begin = html.find(begin_tag)?;
    let end = html.find(end_tag)?;
    if end <= begin {
        return None;
    }

    let before = &html[..begin + begin_tag.len()];
    let after = &html[end..];
    let mut updated = format!("{}\n{}\n{}", before, script_block, after);

    let gate_val = if adult_gate { "1" } else { "0" };
    let html_re = HTML_OPEN_RE.get_or_init(|| Regex::new(r"(?i)<html\b[^>]*>").unwrap());
    let attr_re = ADULT_ATTR_RE
        .get_or_init(|| Regex::new(r#"(?i)\bdata-adult-gate\s*=\s*["'][^"']*["']"#).unwrap());
    if let Some(m) = html_re.find(&updated) {
        let open_tag = m.as_str();
        let new_tag = if attr_re.is_match(open_tag) {
            attr_re
                .replace(open_tag, format!("data-adult-gate=\"{}\"", gate_val))
                .into_owned()
        } else {
            format!(
                "{} data-adult-gate=\"{}\">",
                &open_tag[..open_tag.len() - 1],
                gate_val
            )
        };
        if new_tag != open_tag {
            updated.replace_range(m.start()..m.end(), &new_tag);
        }
    }

    if !site_title.trim().is_empty() {
        let title_re = TITLE_RE.get_or_init(|| Regex::new(r"(?is)<title>.*?</title>").unwrap());
        let new_title = format!("<title>{}</title>", escape_html(site_title.trim()));
        if let Some(m) = title_re.find(&updated) {
            if m.as_str() != new_title {
                updated.replace_range(m.start()..m.end(), &new_title);
            }
        }
    }

    if updated != html {
        Some(updated)
    } else {
        None
    }
}

fn prepare_index_html_injection(
    cfg: &ServerConfig,
    logs: Option<&LogBus>,
) -> Result<Option<String>, String> {
    if !cfg.index_html.is_file() {
        return Err(format!("找不到 index.html: {}", cfg.index_html.display()));
    }
    let html = fs::read_to_string(&cfg.index_html)
        .map_err(|e| format!("读取 index.html 失败: {}", e))?;
    if !html.contains("<!-- PARAM-BEGIN -->") {
        log_warn(logs, "[gen] index.html 缺少 PARAM-BEGIN 标记，跳过参数注入");
        return Ok(None);
    }
    if !html.contains("<!-- PARAM-END -->") {
        log_warn(logs, "[gen] index.html 缺少 PARAM-END 标记，跳过参数注入");
        return Ok(None);
    }

    let js_str = |s: &str| -> String {
        serde_json::to_string(s)
            .unwrap_or_else(|_| "\"\"".to_string())
            .replace("</", "<\\/")
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029")
    };
    let script_block = format!(
        "<script>\n  const github_page = {};\n  const site_repo = {};\n  const data_repo = {};\n  const data_repo_id = {};\n  const data_category_id = {};\n  const update_interval = {};\n  const update_interval_local = {};\n  const readme_md = {};\n</script>",
        js_str(&cfg.github_page),
        js_str(&cfg.site_repo),
        js_str(&cfg.data_repo),
        js_str(&cfg.data_repo_id),
        js_str(&cfg.data_category_id),
        cfg.update_interval_ms,
        cfg.update_interval_local_ms,
        js_str(&normalize_web_path(&cfg.readme_md))
    );

    Ok(render_index_html_meta(
        &html,
        &cfg.site_title,
        cfg.adult_gate,
        &script_block,
    ))
}

fn load_gitignore_rules(cfg: &ServerConfig) -> Result<IgnoreRules, String> {
    if !cfg.gitignore_file.is_file() {
        return Err(format!(
            "找不到 .gitignore ({})。无法判定私有页，为避免私有正文泄露已拒绝构建。",
            cfg.gitignore_file.display()
        ));
    }

    let mut builder = GitignoreBuilder::new(&cfg.repo_root);
    if let Some(err) = builder.add(&cfg.gitignore_file) {
        return Err(format!("解析 .gitignore 失败: {}", err));
    }
    let gi = builder
        .build()
        .map_err(|e| format!("构建 .gitignore 规则失败: {}", e))?;

    if gi.num_ignores() == 0 && !cfg.allow_empty_gitignore {
        return Err(
            ".gitignore 中没有任何有效规则，无法确认私有页已被隔离（若确认无私有内容可在 swamp.toml 设置 allow_empty_gitignore = true）。"
                .to_string(),
        );
    }

    let mut local_only_exact = HashSet::new();
    let mut local_only_any_seg = HashSet::new();
    let content = fs::read_to_string(&cfg.gitignore_file)
        .map_err(|e| format!("读取 .gitignore 失败: {}", e))?;
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with('!') {
            continue;
        }
        let anchored = t.starts_with('/');
        let cleaned = t.trim_start_matches('/').trim_end_matches('/');
        if !cleaned.is_empty()
            && !cleaned.contains('*')
            && !cleaned.contains('?')
            && !cleaned.contains('[')
        {
            if anchored || cleaned.contains('/') {
                local_only_exact.insert(cleaned.to_string());
            } else {
                local_only_any_seg.insert(cleaned.to_string());
            }
        }
    }

    Ok(IgnoreRules {
        gi,
        local_only_exact,
        local_only_any_seg,
        git_ignored: HashSet::new(),
    })
}

fn query_git_ignored(
    cfg: &ServerConfig,
    rel_paths: &[String],
    logs: Option<&LogBus>,
) -> HashSet<String> {
    let mut out = HashSet::new();
    if rel_paths.is_empty() {
        return out;
    }
    let repo_dir = strip_verbatim_prefix(&cfg.repo_root);
    let mut cmd = Command::new("git");
    cmd.args(["check-ignore", "--no-index", "-z", "--stdin"])
        .current_dir(&repo_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log_warn(
                logs,
                format!(
                    "[gen] 调用 git check-ignore 失败，仅使用内置 .gitignore 规则: {}",
                    e
                ),
            );
            return out;
        }
    };

    let stdin_opt = child.stdin.take();
    let stdout_opt = child.stdout.take();
    let mut stdout_buf = Vec::new();

    // 并发写 stdin 与读 stdout，彻底消除 Windows 4KB 管道缓冲区写满互等死锁
    std::thread::scope(|s| {
        if let Some(stdin) = stdin_opt {
            s.spawn(move || {
                let mut writer = BufWriter::new(stdin);
                for p in rel_paths {
                    if writer.write_all(p.as_bytes()).is_err()
                        || writer.write_all(&[0u8]).is_err()
                    {
                        break;
                    }
                }
                let _ = writer.flush();
            });
        }
        if let Some(mut stdout) = stdout_opt {
            let _ = stdout.read_to_end(&mut stdout_buf);
        }
    });

    match child.wait() {
        Ok(status) if matches!(status.code(), Some(0) | Some(1)) => {
            let text = String::from_utf8_lossy(&stdout_buf);
            for part in text.split('\0') {
                if !part.is_empty() {
                    out.insert(part.to_string());
                }
            }
        }
        Ok(status) => {
            log_warn(
                logs,
                format!(
                    "[gen] git check-ignore 返回异常状态 ({:?})，仅使用内置 .gitignore 规则",
                    status.code()
                ),
            );
        }
        Err(e) => {
            log_warn(logs, format!("[gen] 等待 git check-ignore 失败: {}", e));
        }
    }
    out
}

/// 清理已从磁盘删除的 `__*` 私有页历史映射，避免历史私有标题永久滞留公网 discussion_id_mapper.json
pub(crate) fn prune_deleted_private_records(
    records: &mut Vec<Value>,
    current_titles: &HashSet<String>,
) -> usize {
    let before = records.len();
    records.retain(|r| {
        let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
        current_titles.contains(title) || !title.starts_with("__")
    });
    before.saturating_sub(records.len())
}

/// 提取正文行中的站内图片引用（与 lib.rs::MEDIA_RE 对齐，覆盖独立成行与行内图，跳过 http(s) 与其他协议）
pub(crate) fn extract_inline_image_refs(line: &str) -> Vec<String> {
    static INLINE_IMG_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = INLINE_IMG_RE.get_or_init(|| {
        Regex::new(r#"(?i)([^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif))"#).unwrap()
    });
    let mut out = Vec::new();
    for caps in re.captures_iter(line) {
        let tok = &caps[1];
        let low = tok.to_ascii_lowercase();
        if low.starts_with("http://") || low.starts_with("https://") || tok.contains(':') {
            continue;
        }
        let norm = if !tok.contains('/') && !tok.contains('\\') {
            format!("../gallery/img/{}", tok)
        } else {
            let slash = tok.replace('\\', "/");
            if slash.starts_with("../gallery/") {
                slash
            } else if let Some(rest) = slash.strip_prefix("/gallery/") {
                format!("../gallery/{}", rest)
            } else if let Some(rest) = slash.strip_prefix("gallery/") {
                format!("../gallery/{}", rest)
            } else {
                continue;
            }
        };
        if !out.contains(&norm) {
            out.push(norm);
        }
    }
    out
}

fn is_excluded_html(file_stem: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|re| re.is_match(file_stem))
}

fn build_gallery_image_sets(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    logs: Option<&LogBus>,
) -> (HashSet<String>, HashSet<String>) {
    let mut all_set = HashSet::new();
    let mut public_set = HashSet::new();
    if !cfg.gallery_dir.is_dir() {
        return (all_set, public_set);
    }

    let mut items: Vec<(String, String, bool)> = Vec::new();
    for entry in WalkDir::new(&cfg.gallery_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp") {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(&cfg.gallery_dir) {
            let rel_slash = rel.to_string_lossy().replace('\\', "/");
            let repo_rel = format!("gallery/{}", rel_slash);
            let web_ref = format!("../gallery/{}", rel_slash);
            let is_priv = rules.is_private_rel(&repo_rel, false);
            items.push((repo_rel, web_ref, is_priv));
        }
    }

    let unchecked: Vec<String> = items
        .iter()
        .filter(|(_, _, is_priv)| !*is_priv)
        .map(|(repo_rel, _, _)| repo_rel.clone())
        .collect();
    let git_ignored = query_git_ignored(cfg, &unchecked, logs);

    for (repo_rel, web_ref, is_priv) in items {
        all_set.insert(web_ref.clone());
        if !is_priv && !git_ignored.contains(&repo_rel) {
            public_set.insert(web_ref);
        }
    }
    (all_set, public_set)
}

#[allow(clippy::too_many_arguments)]
fn process_html_files_and_images(
    cfg: &ServerConfig,
    rules: &mut IgnoreRules,
    exclude_patterns: &[Regex],
    lite_tree: &mut Value,
    core_bundle: &mut BTreeMap<String, String>,
    records: &mut Vec<Value>,
    current_titles: &mut HashSet<String>,
    max_id: &mut i64,
    fat_data_map: &mut BTreeMap<i64, String>,
    shadow_data_map: &mut BTreeMap<i64, String>,
    private_leak_entries: &mut Vec<PrivateLeakInput>,
    public_docs_for_df: &mut BTreeMap<i64, String>,
    private_page_names: &mut BTreeSet<String>,
    logs: Option<&LogBus>,
) -> Result<HtmlScanOutcome, String> {
    let (image_set, public_image_set) = build_gallery_image_sets(cfg, rules, logs);
    let mut image_lower_to_actual: HashMap<String, String> = HashMap::with_capacity(image_set.len());
    for img in &image_set {
        image_lower_to_actual.insert(img.to_lowercase(), img.clone());
    }
    let mut public_lower_to_actual: HashMap<String, String> =
        HashMap::with_capacity(public_image_set.len());
    for img in &public_image_set {
        public_lower_to_actual.insert(img.to_lowercase(), img.clone());
    }
    let mut used_images: HashSet<String> = HashSet::new();

    if cfg.prune_missing_images && (!cfg.gallery_dir.is_dir() || image_set.is_empty()) {
        return Err(
            "prune_missing_images=true，但 gallery 目录不存在或无图片，已拒绝清理以防误删。"
                .to_string(),
        );
    }

    let mut html_list: Vec<PathBuf> = fs::read_dir(&cfg.html_dir)
        .map_err(|e| format!("无法列出 html 目录 ({}): {}", cfg.html_dir.display(), e))?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.eq_ignore_ascii_case("html"))
                    .unwrap_or(false)
        })
        .collect();
    html_list.sort();

    if html_list.is_empty() {
        return Err(format!(
            "html 目录中没有任何 .html 文件 ({})，拒绝构建空站点。",
            cfg.html_dir.display()
        ));
    }

    let rel_paths: Vec<String> = html_list
        .iter()
        .map(|p| format!("html/{}", p.file_name().unwrap().to_string_lossy()))
        .collect();
    rules.git_ignored.extend(query_git_ignored(cfg, &rel_paths, logs));

    let full_img_re = Regex::new(r#"(?i)^\s*(\.\./gallery/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp))\s*$"#).unwrap();
    let flat_img_re = Regex::new(r#"(?i)^\s*([^\s"'<>/\\]+\.(?:jpg|jpeg|png|gif|webp))\s*$"#).unwrap();
    let heading_re = Regex::new(r"^(#{1,6})\s+(.*)$").unwrap();
    let anchor_re =
        Regex::new(r#"(?is)<span\b[^>]*\bid\s*=\s*["']anchor["'][^>]*>\s*(\d*)-([^<]+?)\s*</span>"#)
            .unwrap();
    let code_open_re = Regex::new(r"(?i)<code\b").unwrap();
    let code_close_re = Regex::new(r"(?i)</code\s*>").unwrap();

    let mut failures: Vec<String> = Vec::new();
    let mut missing_images: Vec<String> = Vec::new();
    let mut case_mismatches: Vec<String> = Vec::new();
    let mut private_img_refs_in_public: Vec<String> = Vec::new();
    let mut pending_rewrites: Vec<(PathBuf, String)> = Vec::new();
    let mut rewritten_html_map: HashMap<String, String> = HashMap::new();
    let mut seen_titles: HashMap<String, String> = HashMap::new();
    let mut title_mismatches: Vec<String> = Vec::new();
    let mut missing_timestamps: Vec<String> = Vec::new();
    let mut pruned_lines: usize = 0;

    for path in html_list {
        let full_file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let file_stem = Path::new(&full_file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&full_file_name)
            .to_string();
        let rel_html_path = format!("html/{}", full_file_name);

        let is_private = rules.is_private_rel(&rel_html_path, false);
        let is_excluded = is_excluded_html(&file_stem, exclude_patterns);

        if is_private {
            private_page_names.insert(file_stem.clone());
        } else if cfg.private_prefix_check && file_stem.starts_with("__") {
            failures.push(format!(
                "{}: 以 \"__\" 开头却未被 .gitignore 判定为忽略，请检查 .gitignore",
                full_file_name
            ));
            continue;
        }

        let raw_file = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                failures.push(format!("{} -> 读取失败: {}", full_file_name, e));
                continue;
            }
        };
        let has_bom = raw_file.starts_with('\u{FEFF}');
        let clean_raw = raw_file.strip_prefix('\u{FEFF}').unwrap_or(&raw_file);

        let mut kept_lines = Vec::new();
        let mut search_text_buf = String::with_capacity(clean_raw.len());
        let mut file_modified = false;
        let mut in_code_block = false;

        for raw_line in clean_raw.lines() {
            let line = raw_line.trim_end_matches('\r');
            let opens_code = code_open_re.is_match(line);
            let closes_code = code_close_re.is_match(line);
            let skip_img_check = in_code_block || opens_code;
            if opens_code && !closes_code {
                in_code_block = true;
            } else if closes_code {
                in_code_block = false;
            }

            let mut keep_line = true;
            let standalone_img = !skip_img_check
                && (full_img_re.is_match(line) || flat_img_re.is_match(line));
            let line_imgs = if skip_img_check {
                Vec::new()
            } else {
                extract_inline_image_refs(line)
            };

            for img in &line_imgs {
                if !is_private {
                    if public_image_set.contains(img) {
                        used_images.insert(img.clone());
                    } else if let Some(actual) = public_lower_to_actual.get(&img.to_lowercase()) {
                        used_images.insert(actual.clone());
                        case_mismatches.push(format!("{}: {} != {}", file_stem, img, actual));
                    } else if image_set.contains(img) {
                        used_images.insert(img.clone());
                        private_img_refs_in_public.push(format!("{}: {}", file_stem, img));
                    } else if let Some(actual) = image_lower_to_actual.get(&img.to_lowercase()) {
                        used_images.insert(actual.clone());
                        private_img_refs_in_public.push(format!("{}: {} ({})", file_stem, img, actual));
                    } else {
                        missing_images.push(format!("{}: {}", file_stem, img));
                        if cfg.prune_missing_images && standalone_img && keep_line {
                            keep_line = false;
                            pruned_lines += 1;
                        }
                    }
                } else if image_set.contains(img) {
                    used_images.insert(img.clone());
                } else if let Some(actual) = image_lower_to_actual.get(&img.to_lowercase()) {
                    used_images.insert(actual.clone());
                    case_mismatches.push(format!("{}: {} != {}", file_stem, img, actual));
                } else {
                    missing_images.push(format!("{}: {}", file_stem, img));
                    if cfg.prune_missing_images && standalone_img && keep_line {
                        keep_line = false;
                        pruned_lines += 1;
                    }
                }
            }

            if keep_line {
                kept_lines.push(line);
                if let Some(hc) = heading_re.captures(line) {
                    search_text_buf.push_str(&hc[2]);
                } else {
                    search_text_buf.push_str(line);
                }
                search_text_buf.push('\n');
            } else {
                file_modified = true;
            }
        }

        let html_content = format!("{}\n", kept_lines.join("\n"));
        if file_modified {
            let rewritten = if has_bom {
                format!("\u{FEFF}{}", html_content)
            } else {
                html_content.clone()
            };
            rewritten_html_map.insert(format!("/html/{}", full_file_name), rewritten.clone());
            pending_rewrites.push((path.clone(), rewritten));
        }

        if !is_private && !is_excluded {
            core_bundle.insert(format!("/html/{}", full_file_name), html_content.clone());
        }

        let time_stamp = extract_anchor_text(&html_content);
        let parsed_title = extract_title(&html_content);
        if !parsed_title.is_empty() && parsed_title != file_stem {
            title_mismatches.push(format!("{} (<title>=「{}」)", full_file_name, parsed_title));
        }
        let title = if parsed_title.is_empty() {
            file_stem.clone()
        } else {
            parsed_title
        };

        let mut current_record_id: i64 = -1;
        if !title.is_empty() {
            if let Some(prev_file) = seen_titles.insert(title.clone(), full_file_name.clone()) {
                failures.push(format!(
                    "{}: 页面标题「{}」与 {} 重复，会导致索引与评论 ID 冲突",
                    full_file_name, title, prev_file
                ));
                continue;
            }
            current_titles.insert(title.clone());
            let mut found = None;
            for r in records.iter() {
                if r.get("title").and_then(|v| v.as_str()) == Some(title.as_str()) {
                    found = r.get("id").and_then(|v| v.as_i64());
                    break;
                }
            }
            if let Some(id) = found {
                current_record_id = id;
            } else {
                *max_id += 1;
                current_record_id = *max_id;
                records.push(json!({ "id": current_record_id, "title": title }));
            }

            let clean_text = extract_body_text(&search_text_buf, false);

            if !is_private && !is_excluded {
                fat_data_map.insert(current_record_id, clean_text);
                let df_body = extract_body_text(&search_text_buf, true);
                public_docs_for_df.insert(current_record_id, format!("{} {}", title, df_body));
            } else if is_private {
                fat_data_map.insert(current_record_id, "localOnly".to_string());
                shadow_data_map.insert(current_record_id, clean_text);
                // 隔离断言剥离 #anchor 元信息，仅扫描真正私密正文，并记录允许出现在 lite_data.js 中的已知标题/时间戳
                let body_only = extract_body_text(&search_text_buf, true);
                let mut allowed_meta = vec![full_file_name.clone(), file_stem.clone(), title.clone()];
                if !time_stamp.is_empty() {
                    allowed_meta.push(time_stamp.clone());
                }
                private_leak_entries.push(PrivateLeakInput {
                    label: format!("recordId={} ({})", current_record_id, full_file_name),
                    body: body_only,
                    allowed_lite_meta: allowed_meta,
                });
            } else {
                fat_data_map.insert(current_record_id, String::new());
            }
        }

        let virtual_path = if let Some(cap) = anchor_re.captures(&html_content) {
            if cap[1].is_empty() {
                missing_timestamps.push(full_file_name.clone());
            }
            format!("html/{}/{}", cap[2].replace('|', "/"), full_file_name)
        } else {
            format!("html/未分类/{}", full_file_name)
        };

        let final_info = if is_private {
            if time_stamp.is_empty() {
                "localOnly".to_string()
            } else {
                format!("{}-localOnly", time_stamp)
            }
        } else {
            time_stamp
        };

        if let Err(e) = add_path_to_tree(
            lite_tree,
            "html",
            &virtual_path,
            json!(current_record_id),
            "html",
            &final_info,
        ) {
            failures.push(format!("{}: {}", full_file_name, e));
            continue;
        }
    }

    if !failures.is_empty() {
        return Err(format!(
            "有 {} 个页面处理失败，已中止构建:\n  {}",
            failures.len(),
            failures.join("\n  ")
        ));
    }

    if !missing_images.is_empty() {
        let preview: Vec<&str> = missing_images.iter().take(30).map(|s| s.as_str()).collect();
        log_warn(
            logs,
            format!(
                "[gen] 发现 {} 处失效图片引用（{}）:\n  {}",
                missing_images.len(),
                if cfg.prune_missing_images {
                    "将清理"
                } else {
                    "未改动源文件"
                },
                preview.join("\n  ")
            ),
        );
    }
    if !case_mismatches.is_empty() {
        let preview: Vec<&str> = case_mismatches.iter().take(30).map(|s| s.as_str()).collect();
        log_warn(
            logs,
            format!(
                "[gen] 发现 {} 处图片路径大小写不一致（线上将 404）:\n  {}",
                case_mismatches.len(),
                preview.join("\n  ")
            ),
        );
    }
    if !private_img_refs_in_public.is_empty() {
        let preview: Vec<&str> = private_img_refs_in_public
            .iter()
            .take(30)
            .map(|s| s.as_str())
            .collect();
        log_warn(
            logs,
            format!(
                "[gen] 发现 {} 处公开页引用了被 .gitignore 忽略的图片（线上将 404）:\n  {}",
                private_img_refs_in_public.len(),
                preview.join("\n  ")
            ),
        );
    }

    if !title_mismatches.is_empty() {
        let preview: Vec<&str> = title_mismatches.iter().take(20).map(|s| s.as_str()).collect();
        log_warn(
            logs,
            format!(
                "[gen] 发现 {} 个页面的 <title> 与文件名不一致:\n  {}",
                title_mismatches.len(),
                preview.join("\n  ")
            ),
        );
    }
    if !missing_timestamps.is_empty() {
        let preview: Vec<&str> = missing_timestamps.iter().take(20).map(|s| s.as_str()).collect();
        log_warn(
            logs,
            format!(
                "[gen] 发现 {} 个页面的 #anchor 缺少 14 位时间戳:\n  {}",
                missing_timestamps.len(),
                preview.join("\n  ")
            ),
        );
    }

    if !pending_rewrites.is_empty() && pruned_lines > cfg.prune_max_lines {
        return Err(format!(
            "本次将删除 {} 行失效图片引用，超过上限 prune_max_lines={}，已中止未改动源文件。",
            pruned_lines, cfg.prune_max_lines
        ));
    }

    Ok(HtmlScanOutcome {
        pending_rewrites,
        rewritten_html_map,
        pruned_lines,
        image_set,
        used_images,
    })
}

fn generate_idle_image_list(
    cfg: &ServerConfig,
    image_set: &HashSet<String>,
    used_images: &HashSet<String>,
) {
    let mut idle: Vec<String> = image_set
        .iter()
        .filter(|p| !used_images.contains(*p) && p.starts_with("../gallery/img/"))
        .map(|p| p.trim_start_matches("../gallery/img/").to_string())
        .collect();
    let img_dir = cfg.gallery_dir.join("img");
    let idle_path = img_dir.join("idle-list.txt");

    if !idle.is_empty() {
        idle.sort();
        let _ = fs::create_dir_all(&img_dir);
        let _ = write_atomic(&idle_path, &(idle.join("\n") + "\n"), false);
    } else if idle_path.is_file() {
        let _ = fs::remove_file(&idle_path);
    }
}

fn scan_all_medias(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    lite_tree: &mut Value,
    logs: Option<&LogBus>,
) {
    let gallery_exts: HashSet<&str> = ["jpg", "jpeg", "png", "webp", "gif"].into_iter().collect();
    let audio_exts: HashSet<&str> = ["mp3", "wav", "flac", "m4a"].into_iter().collect();
    let video_exts: HashSet<&str> = [
        "mp4", "avi", "mov", "wmv", "mkv", "flv", "webm", "ogg", "ogv", "3gp",
    ]
    .into_iter()
    .collect();
    let ebook_exts: HashSet<&str> = ["epub", "pdf", "mobi", "txt"].into_iter().collect();

    let mut visited_dirs: HashSet<PathBuf> = HashSet::new();
    let mut gallery_nodes = Vec::new();
    scan_media_dir(
        &cfg.gallery_dir,
        "gallery/",
        &gallery_exts,
        "image",
        rules,
        &cfg.gallery_exclude_dirs,
        false,
        &mut visited_dirs,
        &mut gallery_nodes,
    );
    let mut audio_nodes = Vec::new();
    scan_media_dir(
        &cfg.audio_dir,
        "audio/",
        &audio_exts,
        "audio",
        rules,
        &cfg.audio_exclude_dirs,
        false,
        &mut visited_dirs,
        &mut audio_nodes,
    );
    let mut video_nodes = Vec::new();
    scan_media_dir(
        &cfg.video_dir,
        "video/",
        &video_exts,
        "video",
        rules,
        &cfg.video_exclude_dirs,
        false,
        &mut visited_dirs,
        &mut video_nodes,
    );
    let mut ebook_nodes = Vec::new();
    scan_media_dir(
        &cfg.ebook_dir,
        "ebook/",
        &ebook_exts,
        "ebook",
        rules,
        &cfg.ebook_exclude_dirs,
        false,
        &mut visited_dirs,
        &mut ebook_nodes,
    );

    // 仅对尚未被 IgnoreRules 判定为私有的媒体路径执行 git check-ignore 二次复核，提速且保守取并集
    let unchecked_media_paths: Vec<String> = gallery_nodes
        .iter()
        .chain(audio_nodes.iter())
        .chain(video_nodes.iter())
        .chain(ebook_nodes.iter())
        .filter(|n| !n.local_only)
        .map(|n| n.link.clone())
        .collect();
    let git_ignored_media = query_git_ignored(cfg, &unchecked_media_paths, logs);

    for (bucket, list) in [
        ("image", gallery_nodes),
        ("audio", audio_nodes),
        ("video", video_nodes),
        ("ebook", ebook_nodes),
    ] {
        for node in list {
            let is_local = node.local_only || git_ignored_media.contains(&node.link);
            let info = if is_local { "localOnly" } else { "" };
            if let Err(e) = add_path_to_tree(
                lite_tree,
                bucket,
                &node.link,
                json!(-1),
                &node.media_type,
                info,
            ) {
                log_warn(logs, format!("[gen] 跳过异常媒体路径 {}: {}", node.link, e));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_media_dir(
    dir: &Path,
    base_path: &str,
    valid_exts: &HashSet<&str>,
    media_type: &str,
    rules: &IgnoreRules,
    exclude_dirs: &[String],
    parent_local_only: bool,
    visited_dirs: &mut HashSet<PathBuf>,
    out: &mut Vec<MediaNode>,
) {
    if !dir.is_dir() {
        return;
    }
    let canon_dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !visited_dirs.insert(canon_dir) {
        return; // 防符号链接 / junction 循环递归
    }
    let mut entries: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok().map(|x| x.path())).collect(),
        Err(_) => return,
    };
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for path in entries {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && exclude_dirs.iter().any(|ex| ex == &name) {
            continue;
        }
        let rel_path = format!("{}{}", base_path, name);
        let is_local = parent_local_only || rules.is_private_rel(&rel_path, is_dir);

        if is_dir {
            scan_media_dir(
                &path,
                &format!("{}{}/", base_path, name),
                valid_exts,
                media_type,
                rules,
                exclude_dirs,
                is_local,
                visited_dirs,
                out,
            );
        } else if path.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if valid_exts.contains(ext.as_str()) {
                let final_type = if media_type == "ebook" {
                    ext
                } else {
                    media_type.to_string()
                };
                out.push(MediaNode {
                    local_only: is_local,
                    link: rel_path,
                    media_type: final_type,
                });
            }
        }
    }
}

fn add_path_to_tree(
    lite_tree: &mut Value,
    bucket: &str,
    path: &str,
    record_id: Value,
    item_type: &str,
    info: &str,
) -> Result<(), String> {
    let clean = match bucket {
        "html" => path.strip_prefix("html/").unwrap_or(path),
        "image" => path.strip_prefix("gallery/").unwrap_or(path),
        "video" => path.strip_prefix("video/").unwrap_or(path),
        "audio" => path.strip_prefix("audio/").unwrap_or(path),
        "ebook" => path.strip_prefix("ebook/").unwrap_or(path),
        _ => path,
    };
    let mut parts: Vec<&str> = clean.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Ok(());
    }
    if parts.len() == 1 {
        parts.insert(0, "_uncategorized");
    }

    let mut cur = lite_tree
        .get_mut(bucket)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("内部目录树缺少 bucket: {}", bucket))?;
    for dir_seg in &parts[..parts.len() - 1] {
        if matches!(*dir_seg, "_f" | "__proto__" | "constructor" | "prototype") {
            return Err(format!("分类或目录名不能使用保留标识符「{}」", dir_seg));
        }
        cur = cur
            .entry((*dir_seg).to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| format!("目录节点「{}」与保留结构冲突", dir_seg))?;
    }
    let files = cur
        .entry("_f".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "目录节点 _f 非数组类型".to_string())?;
    let file_name = *parts.last().unwrap();
    files.push(json!([file_name, record_id, item_type, info]));
    Ok(())
}

fn clear_dir_contents(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败 ({}): {}", dir.display(), e))?;
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("遍历目录项失败: {}", e))?;
        let p = entry.path();
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("删除子目录失败: {}", e))?;
        } else {
            fs::remove_file(&p).map_err(|e| format!("删除旧文件失败: {}", e))?;
        }
    }
    Ok(())
}

fn write_sliced_json(
    data_map: &BTreeMap<i64, String>,
    out_dir: &Path,
    prefix: &str,
    slice_size: usize,
) -> Result<Vec<String>, String> {
    let mut file_names = Vec::new();
    let mut file_index: usize = 1;
    let mut current_size: usize = 0;
    let mut buf = String::from("{");
    let mut first = true;

    for (k, v) in data_map {
        let val_json = serde_json::to_string(v).map_err(|e| format!("JSON 序列化失败: {}", e))?;
        let elem = format!("\"{}\":{}", k, val_json);
        let est_size = elem.len();

        if current_size + est_size > slice_size && !first {
            buf.push('}');
            let fname = format!("{}{}.json", prefix, file_index);
            write_atomic(&out_dir.join(&fname), &buf, false)?;
            file_names.push(fname);

            file_index += 1;
            buf.clear();
            buf.push('{');
            current_size = 0;
            first = true;
        }
        if !first {
            buf.push(',');
        }
        buf.push_str(&elem);
        current_size += est_size;
        first = false;
    }

    buf.push('}');
    let fname = format!("{}{}.json", prefix, file_index);
    write_atomic(&out_dir.join(&fname), &buf, false)?;
    file_names.push(fname);
    Ok(file_names)
}

fn generate_lite_and_fat_data(
    lite_tree: &Value,
    fat_data_map: &BTreeMap<i64, String>,
    data_dir: &Path,
    slice_size: usize,
) -> Result<Vec<String>, String> {
    clear_dir_contents(data_dir)?;

    let lite_json = serde_json::to_string(lite_tree)
        .map_err(|e| format!("序列化 lite_data.js 失败: {}", e))?;
    let lite_content = format!("window.LITE_DATA = {};", lite_json);
    write_atomic(&data_dir.join("lite_data.js"), &lite_content, false)?;

    let mut files = vec!["lite_data.js".to_string()];
    let fat_files = write_sliced_json(fat_data_map, data_dir, "fat_data_", slice_size)?;
    files.extend(fat_files);
    Ok(files)
}

fn generate_shadow_data(
    shadow_data_map: &BTreeMap<i64, String>,
    data_dir: &Path,
    slice_size: usize,
) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("创建 dataDir 失败: {}", e))?;
    let shadow_files = write_sliced_json(shadow_data_map, data_dir, "shadow_data_", slice_size)?;
    let idx_json = serde_json::to_string(&shadow_files)
        .map_err(|e| format!("序列化 shadowIndex.js 失败: {}", e))?;
    write_atomic(
        &data_dir.join("shadowIndex.js"),
        &format!("window.shadowIndex = {};", idx_json),
        false,
    )
}

fn calc_crc32_hex(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path)
        .map_err(|e| format!("读取文件计算 CRC32 失败 ({}): {}", path.display(), e))?;
    Ok(format!("{:x}", crc32fast::hash(&bytes)))
}

fn compile_glob_set(patterns: &[String]) -> Result<GlobSet, String> {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let norm = normalize_web_path(p);
        if norm.is_empty() || norm == "/" {
            continue;
        }
        let g = GlobBuilder::new(&norm)
            .literal_separator(true)
            .build()
            .map_err(|e| format!("非法 Glob 规则 {}: {}", p, e))?;
        b.add(g);
    }
    b.build().map_err(|e| format!("构建 GlobSet 失败: {}", e))
}

fn validate_public_repo_file(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    web_path: &str,
) -> Result<(String, PathBuf), String> {
    let trimmed = web_path.trim().replace('\\', "/");
    let rel = trimmed.trim_start_matches('/');
    if rel.is_empty() || rel.contains(':') {
        return Err(format!("非法 precache 路径: {}", web_path));
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.') {
            return Err(format!("禁止 precache 路径穿越或隐藏路径: {}", web_path));
        }
    }
    let phys = join_rel(&cfg.repo_root, rel);
    let canon = fs::canonicalize(&phys)
        .map_err(|_| format!("precache 文件不存在: {}", web_path))?;
    if !canon.is_file() || !canon.starts_with(&cfg.repo_root) {
        return Err(format!("precache 路径越界仓库根目录: {}", web_path));
    }
    let canon_rel = canon
        .strip_prefix(&cfg.repo_root)
        .map_err(|_| format!("无法计算 precache 相对路径: {}", web_path))?
        .to_string_lossy()
        .replace('\\', "/");
    if canon_rel.to_ascii_lowercase().starts_with("_build/")
        || crate::services::pack_apply::is_hard_private_rel(&canon_rel)
        || rules.is_private_rel(&canon_rel, false)
    {
        return Err(format!(
            "禁止将私有或 _build 路径加入公开 precache 清单: /{}",
            canon_rel
        ));
    }
    Ok((format!("/{}", canon_rel), canon))
}

fn resolve_precache_paths(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
) -> Result<Vec<(String, PathBuf)>, String> {
    let exclude_set = compile_glob_set(&cfg.precache_exclude)?;
    let mut glob_patterns = Vec::new();
    let mut explicit_paths = Vec::new();
    let mut include_root_slash = false;

    for raw in &cfg.precache_include {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        if p == "/" {
            include_root_slash = true;
            continue;
        }
        let norm = normalize_web_path(p);
        if norm.contains('*') || norm.contains('?') || norm.contains('[') {
            glob_patterns.push(norm);
        } else {
            explicit_paths.push(norm);
        }
    }

    let mut resolved: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut bad_explicit: Vec<String> = Vec::new();

    if include_root_slash {
        let idx = cfg.repo_root.join("index.html");
        if !idx.is_file() {
            bad_explicit.push("/ (index.html 不存在)".to_string());
        } else {
            resolved.insert("/".to_string(), idx);
        }
    }

    for web_path in explicit_paths {
        if exclude_set.is_match(&web_path) {
            continue;
        }
        match validate_public_repo_file(cfg, rules, &web_path) {
            Ok((canon_web, canon_phys)) => {
                resolved.insert(canon_web, canon_phys);
            }
            Err(e) => bad_explicit.push(e),
        }
    }

    if !bad_explicit.is_empty() {
        return Err(format!(
            "precache 显式清单校验失败:\n  {}",
            bad_explicit.join("\n  ")
        ));
    }

    if !glob_patterns.is_empty() {
        let include_set = compile_glob_set(&glob_patterns)?;
        for entry in WalkDir::new(&cfg.repo_root)
            .into_iter()
            .filter_entry(|e| {
                let p = e.path();
                if p == cfg.repo_root {
                    return true;
                }
                if let Ok(rel) = p.strip_prefix(&cfg.repo_root) {
                    let s = rel.to_string_lossy().replace('\\', "/");
                    if matches!(
                        s.as_str(),
                        ".git"
                            | "_build"
                            | "html"
                            | "gallery"
                            | "audio"
                            | "video"
                            | "ebook"
                            | "src/js/raw"
                            | "src/css/raw"
                            | "src/js/source-map"
                            | "src/css/source-map"
                            | "src/js/data"
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
            let Ok(rel) = entry.path().strip_prefix(&cfg.repo_root) else {
                continue;
            };
            let rel_slash = rel.to_string_lossy().replace('\\', "/");
            if crate::services::pack_apply::is_hard_private_rel(&rel_slash)
                || rules.is_private_rel(&rel_slash, false)
            {
                continue;
            }
            let web_path = format!("/{}", rel_slash);
            if include_set.is_match(&web_path) && !exclude_set.is_match(&web_path) {
                if let Ok(canon) = fs::canonicalize(entry.path()) {
                    if canon.starts_with(&cfg.repo_root) {
                        resolved.insert(web_path, canon);
                    }
                }
            }
        }
    }

    Ok(resolved.into_iter().collect())
}

fn parse_old_core_list(old_content: &str) -> (Option<String>, HashMap<String, (String, &'static str)>) {
    let mut old_version = None;
    let mut old_entries: HashMap<String, (String, &'static str)> = HashMap::new();

    let ver_re = Regex::new(r"const BUILD_VERSION = '(\d+)';").unwrap();
    if let Some(c) = ver_re.captures(old_content) {
        old_version = Some(c[1].to_string());
    }

    const JSON_PREFIX: &str = "const __SWAMP_MANIFEST_GROUPS__ = ";
    if let Some(pos) = old_content.find(JSON_PREFIX) {
        let rest = &old_content[pos + JSON_PREFIX.len()..];
        if let Some(json_str) = rest.lines().next().and_then(|l| l.trim().strip_suffix(';')) {
            if let Ok(parsed) = serde_json::from_str::<BTreeMap<String, Vec<(String, String, u8)>>>(json_str) {
                for (dir, items) in parsed {
                    for (name, hash, flag) in items {
                        let src = match flag {
                            1 => "core-bundle.json",
                            2 => "no_cache",
                            _ => "standalone",
                        };
                        old_entries.insert(format!("{}{}", dir, name), (hash, src));
                    }
                }
                return (old_version, old_entries);
            }
        }
    }

    let tpl_re = Regex::new(r"`([^`]+)`").unwrap();
    if let Some(c) = tpl_re.captures(old_content) {
        for group in c[1].split(';') {
            if let Some((dir, files_str)) = group.split_once('|') {
                for item in files_str.split('*') {
                    let mut parts = item.split(':');
                    if let (Some(n), Some(h)) = (parts.next(), parts.next()) {
                        let src = match parts.next() {
                            Some("1") => "core-bundle.json",
                            Some("2") => "no_cache",
                            _ => "standalone",
                        };
                        old_entries.insert(format!("{}{}", dir, n), (h.to_string(), src));
                    }
                }
            }
        }
    }

    (old_version, old_entries)
}

#[allow(clippy::too_many_arguments)]
fn prepare_manifest(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    exclude_patterns: &[Regex],
    core_bundle: &mut BTreeMap<String, String>,
    generated_data_files: &[String],
    staging_dir: &Path,
    prepared_index_html: Option<&str>,
    rewritten_html_map: &HashMap<String, String>,
    staged_synonyms_js: Option<&str>,
    staged_cmt_json: &str,
    logs: Option<&LogBus>,
) -> Result<PreparedManifest, String> {
    let mut sw_manifest: BTreeMap<String, FileMeta> = BTreeMap::new();

    let mut html_entries: Vec<PathBuf> = fs::read_dir(&cfg.html_dir)
        .map_err(|e| format!("读取 html 目录失败: {}", e))?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.eq_ignore_ascii_case("html"))
                    .unwrap_or(false)
        })
        .collect();
    html_entries.sort();

    for p in html_entries {
        let fname = p.file_name().unwrap().to_string_lossy().to_string();
        let stem = Path::new(&fname)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&fname);
        let rel = format!("html/{}", fname);
        if !rules.is_private_rel(&rel, false) {
            let web_key = format!("/html/{}", fname);
            let hash = if let Some(rewritten) = rewritten_html_map.get(&web_key) {
                format!("{:x}", crc32fast::hash(rewritten.as_bytes()))
            } else {
                calc_crc32_hex(&p)?
            };
            let src = if is_excluded_html(stem, exclude_patterns) {
                "no_cache"
            } else {
                "core-bundle.json"
            };
            sw_manifest.insert(web_key, FileMeta { hash, source: src });
        }
    }

    for df in generated_data_files {
        let p = staging_dir.join(df);
        let hash = calc_crc32_hex(&p)?;
        sw_manifest.insert(
            format!("/src/js/data/{}", df),
            FileMeta {
                hash,
                source: "standalone",
            },
        );
    }

    let precache_files = resolve_precache_paths(cfg, rules)?;
    for (web_path, phys) in precache_files {
        if (web_path == "/" || web_path == "/index.html") && prepared_index_html.is_some() {
            let new_idx = prepared_index_html.unwrap();
            let hash = format!("{:x}", crc32fast::hash(new_idx.as_bytes()));
            core_bundle.insert(web_path.clone(), new_idx.to_string());
            sw_manifest.insert(
                web_path,
                FileMeta {
                    hash,
                    source: "core-bundle.json",
                },
            );
            continue;
        }
        if web_path == "/src/discussion_id_mapper.json" {
            let hash = format!("{:x}", crc32fast::hash(staged_cmt_json.as_bytes()));
            core_bundle.insert(web_path.clone(), staged_cmt_json.to_string());
            sw_manifest.insert(
                web_path,
                FileMeta {
                    hash,
                    source: "core-bundle.json",
                },
            );
            continue;
        }
        if web_path == "/src/js/synonyms.js" {
            if let Some(syn_js) = staged_synonyms_js {
                let hash = format!("{:x}", crc32fast::hash(syn_js.as_bytes()));
                sw_manifest.insert(
                    web_path,
                    FileMeta {
                        hash,
                        source: "standalone",
                    },
                );
                continue;
            }
        }
        let hash = calc_crc32_hex(&phys)?;
        let is_bundleable = web_path == "/"
            || web_path.ends_with(".html")
            || web_path.ends_with(".css")
            || web_path.ends_with(".json")
            || web_path.ends_with(".md");
        if is_bundleable {
            if let Ok(text) = fs::read_to_string(&phys) {
                core_bundle.insert(web_path.clone(), text);
                sw_manifest.insert(
                    web_path,
                    FileMeta {
                        hash,
                        source: "core-bundle.json",
                    },
                );
                continue;
            }
        }
        sw_manifest.insert(
            web_path,
            FileMeta {
                hash,
                source: "standalone",
            },
        );
    }

    // 若首次生成 synonyms.js（磁盘上尚未落盘，因此未被 Glob 扫描到），主动补入清单
    if let Some(syn_js) = staged_synonyms_js {
        sw_manifest.entry("/src/js/synonyms.js".to_string()).or_insert_with(|| FileMeta {
            hash: format!("{:x}", crc32fast::hash(syn_js.as_bytes())),
            source: "standalone",
        });
    }

    let readme_web = normalize_web_path(&cfg.readme_md);
    if !readme_web.is_empty() && !sw_manifest.contains_key(&readme_web) {
        let (canon_web, phys) = validate_public_repo_file(cfg, rules, &readme_web)?;
        let hash = calc_crc32_hex(&phys)?;
        if let Ok(text) = fs::read_to_string(&phys) {
            core_bundle.insert(canon_web.clone(), text);
            sw_manifest.insert(
                canon_web,
                FileMeta {
                    hash,
                    source: "core-bundle.json",
                },
            );
        } else {
            sw_manifest.insert(
                canon_web,
                FileMeta {
                    hash,
                    source: "standalone",
                },
            );
        }
    }

    let bundle_json = serde_json::to_string(core_bundle)
        .map_err(|e| format!("序列化 core-bundle.json 失败: {}", e))?;
    write_atomic(&staging_dir.join("core-bundle.json"), &bundle_json, false)?;

    let core_list_path = cfg.js_raw_dir.join("core-list.js");
    let (old_version, old_entries) = if core_list_path.is_file() {
        fs::read_to_string(&core_list_path)
            .map(|s| parse_old_core_list(&s))
            .unwrap_or_else(|_| (None, HashMap::new()))
    } else {
        (None, HashMap::new())
    };

    let mut has_changed = old_version.is_none() || old_entries.len() != sw_manifest.len();
    if !has_changed {
        for (k, meta) in &sw_manifest {
            match old_entries.get(k) {
                Some((old_h, old_s)) if old_h == &meta.hash && *old_s == meta.source => {}
                _ => {
                    has_changed = true;
                    break;
                }
            }
        }
    }

    if !has_changed {
        log_info(
            logs,
            format!(
                "[gen] 缓存清单无变化（{} 项），沿用当前版本",
                sw_manifest.len()
            ),
        );
        return Ok(PreparedManifest::Unchanged { old_version });
    }

    let build_version = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();

    let mut grouped: BTreeMap<String, Vec<(&str, &str, u8)>> = BTreeMap::new();
    for (full_path, meta) in &sw_manifest {
        let last_slash = full_path.rfind('/').unwrap_or(0);
        let dir = full_path[..=last_slash].to_string();
        let name = &full_path[last_slash + 1..];
        let flag: u8 = match meta.source {
            "core-bundle.json" => 1,
            "no_cache" => 2,
            _ => 0,
        };
        grouped
            .entry(dir)
            .or_default()
            .push((name, meta.hash.as_str(), flag));
    }

    let groups_json = serde_json::to_string(&grouped)
        .map_err(|e| format!("序列化清单分组失败: {}", e))?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let data_idx_json = serde_json::to_string(generated_data_files).unwrap();

    let core_list_js = format!(
        "const BUILD_VERSION = '{}';\nconst FILE_MANIFEST = {{}};\nconst __SWAMP_MANIFEST_GROUPS__ = {};\nObject.entries(__SWAMP_MANIFEST_GROUPS__).forEach(([d, f]) => {{ f.forEach(([n, h, s]) => {{ let src = 'standalone'; if (s === 1) src = 'core-bundle.json'; else if (s === 2) src = 'no_cache'; FILE_MANIFEST[d + n] = {{ hash: h, source: src }}; }}); }});\nconst allFilesToCache = Object.keys(FILE_MANIFEST).filter(p => !p.includes('/src/js/data/fat_data_') && FILE_MANIFEST[p].source !== 'no_cache');\n\nif (typeof window !== 'undefined') {{ window.dataIndex = {}; }}\n",
        build_version,
        groups_json,
        data_idx_json
    );

    log_info(
        logs,
        format!(
            "[gen] 已更新缓存清单: 版本 {} ({} 项)",
            build_version,
            sw_manifest.len()
        ),
    );
    Ok(PreparedManifest::Updated {
        version: build_version,
        core_list_js,
    })
}

/// 逐文件原子覆盖提交：先将全部暂存文件通过 write_bytes_atomic 覆盖到 data_dir，全部成功后再清理废弃旧文件
fn commit_staging_to_data_dir(staging_dir: &Path, data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|e| format!("创建 data 目录失败 ({}): {}", data_dir.display(), e))?;

    let mut entries: Vec<PathBuf> = fs::read_dir(staging_dir)
        .map_err(|e| format!("读取构建暂存目录失败: {}", e))?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| p.is_file())
        .collect();
    entries.sort();

    let mut written_names: HashSet<String> = HashSet::with_capacity(entries.len());
    for src in entries {
        let fname = src.file_name().unwrap().to_string_lossy().to_string();
        let bytes = fs::read(&src)
            .map_err(|e| format!("读取暂存数据产物 {} 失败: {}", fname, e))?;
        write_bytes_atomic(&data_dir.join(&fname), &bytes)
            .map_err(|e| format!("原子提交数据产物 {} 失败: {}", fname, e))?;
        written_names.insert(fname);
    }

    if let Ok(rd) = fs::read_dir(data_dir) {
        for ent in rd.filter_map(|e| e.ok()) {
            let p = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if p.is_file() && !written_names.contains(&name) && !name.ends_with(".swamp.tmp") {
                let _ = fs::remove_file(&p);
            }
        }
    }
    Ok(())
}

fn json_inner_escaped(s: &str) -> String {
    let quoted = serde_json::to_string(s).unwrap_or_default();
    if quoted.len() >= 2 {
        quoted[1..quoted.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 基于 Aho-Corasick 自动机的单遍全覆盖泄露检测：
/// - 24 字窗口 + 12 字重叠步长：保证任意 >= 35 字的局部泄露 100% 被至少一个完整窗口命中；
/// - 全部私有页所有窗口合并为单个 AhoCorasick，每个公网产物仅线性扫描一次；
/// - 命中后惰性复核独立磁盘公开语料（以及对 lite_data.js 排除该页已知标题/文件名/时间戳元信息），零误报。
pub(crate) fn scan_private_pages_against_blobs(
    entries: &[PrivateLeakInput],
    blobs: &[(String, String)],
    public_corpus: &[&str],
    problems: &mut Vec<String>,
) {
    const WIN: usize = 24;
    const STEP: usize = 12;

    struct ChunkMeta {
        entry_idx: usize,
        raw: String,
        char_len: usize,
    }

    let mut chunks: Vec<ChunkMeta> = Vec::new();
    for (entry_idx, entry) in entries.iter().enumerate() {
        let trimmed = entry.body.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut seen: HashSet<String> = HashSet::new();
        fn push_chunk(
            chunks: &mut Vec<ChunkMeta>,
            seen: &mut HashSet<String>,
            entry_idx: usize,
            s: String,
        ) {
            let non_ws = s.chars().filter(|c| !c.is_whitespace()).count();
            if non_ws >= 4 && seen.insert(s.clone()) {
                let char_len = s.chars().count();
                chunks.push(ChunkMeta {
                    entry_idx,
                    raw: s,
                    char_len,
                });
            }
        }

        fn push_sliding(
            chunks: &mut Vec<ChunkMeta>,
            seen: &mut HashSet<String>,
            entry_idx: usize,
            lc: &[char],
        ) {
            let n = lc.len();
            if n <= WIN {
                if lc.iter().filter(|c| !c.is_whitespace()).count() >= 6 {
                    push_chunk(chunks, seen, entry_idx, lc.iter().collect());
                }
                return;
            }
            let mut pos = 0usize;
            while pos + WIN <= n {
                push_chunk(chunks, seen, entry_idx, lc[pos..pos + WIN].iter().collect());
                pos += STEP;
            }
            if pos < n {
                push_chunk(chunks, seen, entry_idx, lc[n - WIN..n].iter().collect());
            }
        }

        let total_chars = trimmed.chars().count();
        if total_chars <= WIN {
            push_chunk(&mut chunks, &mut seen, entry_idx, trimmed.to_string());
        } else {
            let mut short_buf: Vec<char> = Vec::new();
            for raw_line in trimmed.lines() {
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                let lc: Vec<char> = line.chars().collect();
                let n = lc.len();
                let non_ws = lc.iter().filter(|c| !c.is_whitespace()).count();
                if n <= WIN && non_ws < 6 {
                    if !short_buf.is_empty() {
                        short_buf.push('\n');
                    }
                    short_buf.extend_from_slice(&lc);
                    continue;
                }
                if !short_buf.is_empty() {
                    push_sliding(&mut chunks, &mut seen, entry_idx, &short_buf);
                    short_buf.clear();
                }
                push_sliding(&mut chunks, &mut seen, entry_idx, &lc);
            }
            if !short_buf.is_empty() {
                push_sliding(&mut chunks, &mut seen, entry_idx, &short_buf);
            }
            if seen.is_empty() {
                let all_c: Vec<char> = trimmed.chars().collect();
                push_chunk(
                    &mut chunks,
                    &mut seen,
                    entry_idx,
                    all_c[..all_c.len().min(WIN)].iter().collect(),
                );
            }
        }
    }

    if chunks.is_empty() {
        return;
    }

    let mut patterns: Vec<String> = Vec::with_capacity(chunks.len() * 2);
    let mut pat_to_chunk: Vec<usize> = Vec::with_capacity(chunks.len() * 2);
    for (ci, cm) in chunks.iter().enumerate() {
        patterns.push(cm.raw.clone());
        pat_to_chunk.push(ci);
        let esc = json_inner_escaped(&cm.raw);
        if esc != cm.raw {
            patterns.push(esc);
            pat_to_chunk.push(ci);
        }
    }

    let Ok(ac) = AhoCorasick::new(&patterns) else {
        problems.push("构造 Aho-Corasick 隔离扫描自动机失败".to_string());
        return;
    };

    // 惰性缓存每个私有片段是否出现在公开原文中，避免对共享短语重复扫描公开语料
    let mut in_public_cache: Vec<Option<bool>> = vec![None; chunks.len()];

    for (blob_name, blob_text) in blobs {
        let is_syn = blob_name.starts_with("synonyms.js");
        let is_lite = blob_name == "lite_data.js" || blob_name == "discussion_id_mapper.json";
        let min_len_for_blob = if is_syn { WIN } else { 4 };
        let mut reported_entries: HashSet<usize> = HashSet::new();

        let Ok(iter) = ac.try_find_overlapping_iter(blob_text) else {
            continue;
        };
        for mat in iter {
            let ci = pat_to_chunk[mat.pattern().as_usize()];
            let cm = &chunks[ci];
            if cm.char_len < min_len_for_blob || reported_entries.contains(&cm.entry_idx) {
                continue;
            }
            if is_lite {
                let allowed = &entries[cm.entry_idx].allowed_lite_meta;
                if allowed.iter().any(|m| !m.is_empty() && m.contains(cm.raw.as_str())) {
                    continue;
                }
            }
            let is_public = match in_public_cache[ci] {
                Some(b) => b,
                None => {
                    let hit = public_corpus
                        .iter()
                        .any(|pub_doc| pub_doc.contains(cm.raw.as_str()));
                    in_public_cache[ci] = Some(hit);
                    hit
                }
            };
            if !is_public {
                reported_entries.insert(cm.entry_idx);
                problems.push(format!(
                    "公网产物 {} 含有私有页 ({}) 的独占正文片段",
                    blob_name, entries[cm.entry_idx].label
                ));
            }
        }
    }
}

/// 独立从磁盘读取全部公开 HTML 正文与公开说明文档，作为隔离断言排除集（绝不复用待检构建流水线产物）
fn load_independent_public_corpus_from_disk(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    private_page_names: &BTreeSet<String>,
) -> Vec<String> {
    let mut docs = Vec::new();
    if let Ok(rd) = fs::read_dir(&cfg.html_dir) {
        for ent in rd.filter_map(|e| e.ok()) {
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            let is_html = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("html"))
                .unwrap_or(false);
            if !is_html {
                continue;
            }
            let fname = p.file_name().unwrap().to_string_lossy().to_string();
            let stem = Path::new(&fname)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&fname);
            let rel = format!("html/{}", fname);
            if stem.starts_with("__")
                || private_page_names.contains(stem)
                || rules.is_private_rel(&rel, false)
            {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&p) {
                let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
                docs.push(extract_body_text(clean, false));
                docs.push(clean.to_string());
            }
        }
    }
    let readme_phys = join_rel(&cfg.repo_root, &normalize_web_path(&cfg.readme_md));
    if readme_phys.is_file() {
        if let Ok(raw) = fs::read_to_string(&readme_phys) {
            docs.push(raw);
        }
    }
    docs
}

#[allow(clippy::too_many_arguments)]
fn assert_no_private_leak(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    staging_dir: &Path,
    private_page_names: &BTreeSet<String>,
    shadow_data_map: &BTreeMap<i64, String>,
    private_leak_entries: &[PrivateLeakInput],
    generated_data_files: &[String],
    core_bundle: &BTreeMap<String, String>,
    staged_synonyms_js: Option<&str>,
    staged_core_list_js: Option<&str>,
    staged_cmt_json: &str,
    logs: Option<&LogBus>,
) -> Result<(), String> {
    if private_page_names.is_empty() {
        return Ok(());
    }
    let mut problems: Vec<String> = Vec::new();
    for name in private_page_names {
        let key = format!("/html/{}.html", name);
        if core_bundle.contains_key(&key) {
            problems.push(format!("core-bundle.json 含有私有页: {}", name));
        }
    }

    let mut blobs: Vec<(String, String)> = Vec::new();
    for f in generated_data_files {
        let p = staging_dir.join(f);
        if p.is_file() {
            let txt = fs::read_to_string(&p)
                .map_err(|e| format!("隔离检查读取 {} 失败: {}", f, e))?;
            if f.starts_with("fat_data_") && f.ends_with(".json") {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&txt) {
                    for rec_id in shadow_data_map.keys() {
                        if let Some(val) = map.get(&rec_id.to_string()) {
                            if val.as_str() != Some("localOnly") {
                                problems.push(format!(
                                    "公网切片 {} 中私有页 recordId={} 的值非 localOnly 占位符",
                                    f, rec_id
                                ));
                            }
                        }
                    }
                }
            }
            blobs.push((f.clone(), txt));
        }
    }
    let bundle_path = staging_dir.join("core-bundle.json");
    if bundle_path.is_file() {
        let txt = fs::read_to_string(&bundle_path)
            .map_err(|e| format!("隔离检查读取 core-bundle.json 失败: {}", e))?;
        blobs.push(("core-bundle.json".to_string(), txt));
    }
    if let Some(syn_js) = staged_synonyms_js {
        blobs.push(("synonyms.js (staged)".to_string(), syn_js.to_string()));
    } else {
        let syn_path = cfg.js_out_dir.join("synonyms.js");
        if syn_path.is_file() {
            let txt = fs::read_to_string(&syn_path)
                .map_err(|e| format!("隔离检查读取 synonyms.js 失败: {}", e))?;
            blobs.push(("synonyms.js".to_string(), txt));
        }
    }
    if let Some(core_list) = staged_core_list_js {
        blobs.push(("core-list.js (staged)".to_string(), core_list.to_string()));
    }
    blobs.push((
        "discussion_id_mapper.json".to_string(),
        staged_cmt_json.to_string(),
    ));

    let disk_public_docs =
        load_independent_public_corpus_from_disk(cfg, rules, private_page_names);
    let public_refs: Vec<&str> = disk_public_docs.iter().map(|d| d.as_str()).collect();

    scan_private_pages_against_blobs(private_leak_entries, &blobs, &public_refs, &mut problems);

    if !problems.is_empty() {
        return Err(format!(
            "隐私检查未通过，已停止构建（未改动正式目录）:\n  {}",
            problems.join("\n  ")
        ));
    }
    log_info(
        logs,
        format!(
            "[gen] 隐私检查通过（{} 个私有页未进入公网产物）",
            private_page_names.len()
        ),
    );
    Ok(())
}

/// 供独立 push 前调用：直接对磁盘上现存公网产物复核一遍公私隔离断言
pub fn verify_public_outputs_clean(
    cfg: &ServerConfig,
    logs: Option<&LogBus>,
) -> Result<(), String> {
    let mut rules = load_gitignore_rules(cfg)?;
    if !cfg.html_dir.is_dir() {
        return Ok(());
    }
    let html_files: Vec<PathBuf> = fs::read_dir(&cfg.html_dir)
        .map_err(|e| format!("隔离复核读取 html 目录失败: {}", e))?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("html"))
                    .unwrap_or(false)
        })
        .collect();

    let rel_paths: Vec<String> = html_files
        .iter()
        .map(|p| format!("html/{}", p.file_name().unwrap().to_string_lossy()))
        .collect();
    rules
        .git_ignored
        .extend(query_git_ignored(cfg, &rel_paths, logs));

    let mut private_entries: Vec<PrivateLeakInput> = Vec::new();
    let mut private_names: BTreeSet<String> = BTreeSet::new();
    let mut public_bodies: Vec<String> = Vec::new();
    for p in html_files {
        let fname = p.file_name().unwrap().to_string_lossy().to_string();
        let stem = Path::new(&fname)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&fname)
            .to_string();
        let rel = format!("html/{}", fname);
        if rules.is_private_rel(&rel, false) || stem.starts_with("__") {
            private_names.insert(stem.clone());
            if let Ok(raw) = fs::read_to_string(&p) {
                let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
                let body = extract_body_text(clean, true);
                let parsed_title = extract_title(clean);
                let anchor = extract_anchor_text(clean);
                let mut allowed = vec![fname.clone(), stem];
                if !parsed_title.is_empty() {
                    allowed.push(parsed_title);
                }
                if !anchor.is_empty() {
                    allowed.push(anchor);
                }
                private_entries.push(PrivateLeakInput {
                    label: fname,
                    body,
                    allowed_lite_meta: allowed,
                });
            }
        } else if let Ok(raw) = fs::read_to_string(&p) {
            let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
            public_bodies.push(extract_body_text(clean, false));
            public_bodies.push(clean.to_string());
        }
    }

    let readme_phys = join_rel(&cfg.repo_root, &normalize_web_path(&cfg.readme_md));
    if readme_phys.is_file() {
        if let Ok(raw) = fs::read_to_string(&readme_phys) {
            public_bodies.push(raw);
        }
    }

    if private_names.is_empty() {
        return Ok(());
    }

    let mut problems: Vec<String> = Vec::new();
    let mut blobs: Vec<(String, String)> = Vec::new();

    if cfg.data_dir.is_dir() {
        if let Ok(rd) = fs::read_dir(&cfg.data_dir) {
            for ent in rd.filter_map(|e| e.ok()) {
                let p = ent.path();
                if !p.is_file() {
                    continue;
                }
                let name = ent.file_name().to_string_lossy().to_string();
                if name.starts_with("shadow") {
                    continue;
                }
                if name == "core-bundle.json"
                    || name == "lite_data.js"
                    || (name.starts_with("fat_data_") && name.ends_with(".json"))
                {
                    if let Ok(txt) = fs::read_to_string(&p) {
                        if name == "core-bundle.json" {
                            for pn in &private_names {
                                let key = format!("\"/html/{}.html\"", pn);
                                if txt.contains(&key) {
                                    problems.push(format!("core-bundle.json 含有私有页: {}", pn));
                                }
                            }
                        }
                        blobs.push((name, txt));
                    }
                }
            }
        }
    }
    for (label, path) in [
        ("synonyms.js", cfg.js_out_dir.join("synonyms.js")),
        ("core-list.js", cfg.js_out_dir.join("core-list.js")),
        ("discussion_id_mapper.json", cfg.discussion_id_mapper.clone()),
    ] {
        if path.is_file() {
            if let Ok(txt) = fs::read_to_string(&path) {
                blobs.push((label.to_string(), txt));
            }
        }
    }

    let public_refs: Vec<&str> = public_bodies.iter().map(|s| s.as_str()).collect();
    scan_private_pages_against_blobs(&private_entries, &blobs, &public_refs, &mut problems);

    if !problems.is_empty() {
        return Err(format!(
            "推送前隐私检查未通过，已取消推送:\n  {}",
            problems.join("\n  ")
        ));
    }
    Ok(())
}
