use chrono::Local;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use crate::api_files::write_atomic;
use crate::builder::html_utils::{extract_anchor_text, extract_body_text, extract_title};
use crate::builder::synonyms;
use crate::config::{normalize_web_path, strip_verbatim_prefix, ServerConfig};

struct FileMeta {
    hash: String,
    source: &'static str,
}

struct MediaNode {
    local_only: bool,
    link: String,
    media_type: String,
}

struct IgnoreRules {
    gi: Gitignore,
    local_only_raw: HashSet<String>,
    git_ignored_html: HashSet<String>,
}

impl IgnoreRules {
    fn is_private_rel(&self, rel_slash: &str, is_dir: bool) -> bool {
        if self.git_ignored_html.contains(rel_slash) {
            return true;
        }
        if self.local_only_raw.contains(rel_slash) {
            return true;
        }
        if let Some(name) = rel_slash.rsplit('/').next() {
            if self.local_only_raw.contains(name) {
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

pub fn run(cfg: &ServerConfig) -> Result<Option<String>, String> {
    inject_script_to_index_html(cfg)?;
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
    let mut public_docs_for_df: BTreeMap<i64, String> = BTreeMap::new();
    let mut private_page_names: BTreeSet<String> = BTreeSet::new();
    let mut current_titles: HashSet<String> = HashSet::new();

    let exclude_patterns: Vec<Regex> = cfg
        .exclude_html_regex
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(|pat| Regex::new(pat).map_err(|e| format!("无效的排除正则 {}: {}", pat, e)))
        .collect::<Result<Vec<_>, _>>()?;

    process_html_files_and_images(
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
        &mut public_docs_for_df,
        &mut private_page_names,
    )?;

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
    write_atomic(&cfg.discussion_id_mapper, &cmt_json, false)?;

    scan_all_medias(cfg, &rules, &mut lite_tree);

    let generated_data_files =
        generate_lite_and_fat_data(&lite_tree, &fat_data_map, &cfg.data_dir, cfg.slice_size_bytes)?;
    if !shadow_data_map.is_empty() {
        generate_shadow_data(&shadow_data_map, &cfg.data_dir, cfg.slice_size_bytes)?;
    }

    synonyms::build_if_needed(cfg, &public_docs_for_df, &lite_tree)?;

    let new_build_version = generate_manifest(
        cfg,
        &rules,
        &exclude_patterns,
        &mut core_bundle,
        &generated_data_files,
    )?;

    if let Some(ref ver) = new_build_version {
        update_sw_version(cfg, ver)?;
    }

    assert_no_private_leak(
        cfg,
        &private_page_names,
        &shadow_data_map,
        &generated_data_files,
        &core_bundle,
    )?;

    Ok(new_build_version)
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

fn inject_script_to_index_html(cfg: &ServerConfig) -> Result<(), String> {
    if !cfg.index_html.is_file() {
        return Err(format!("找不到 index.html: {}", cfg.index_html.display()));
    }
    let html = fs::read_to_string(&cfg.index_html)
        .map_err(|e| format!("读取 index.html 失败: {}", e))?;
    let begin_tag = "<!-- PARAM-BEGIN -->";
    let end_tag = "<!-- PARAM-END -->";

    let Some(begin) = html.find(begin_tag) else {
        println!("[Generator] 未在 index.html 中找到 PARAM-BEGIN，跳过注入。");
        return Ok(());
    };
    let Some(end) = html.find(end_tag) else {
        println!("[Generator] 未在 index.html 中找到 PARAM-END，跳过注入。");
        return Ok(());
    };
    if end <= begin {
        return Ok(());
    }

    let script_block = format!(
        "<script>\n  const github_page = \"{}\";\n  const data_repo = \"{}\";\n  const data_repo_id = \"{}\";\n  const data_category_id = \"{}\";\n  const update_interval = {};\n  const update_interval_local = {};\n  const readme_md = \"{}\";\n</script>",
        cfg.github_page,
        cfg.data_repo,
        cfg.data_repo_id,
        cfg.data_category_id,
        cfg.update_interval_ms,
        cfg.update_interval_local_ms,
        normalize_web_path(&cfg.readme_md)
    );

    let before = &html[..begin + begin_tag.len()];
    let after = &html[end..];
    let updated = format!("{}\n{}\n{}", before, script_block, after);
    if updated != html {
        write_atomic(&cfg.index_html, &updated, false)?;
    }
    Ok(())
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

    let mut local_only_raw = HashSet::new();
    let content = fs::read_to_string(&cfg.gitignore_file)
        .map_err(|e| format!("读取 .gitignore 失败: {}", e))?;
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with('!') {
            continue;
        }
        let cleaned = t.trim_start_matches('/').trim_end_matches('/');
        if !cleaned.is_empty() && !cleaned.contains('*') && !cleaned.contains('?') {
            local_only_raw.insert(cleaned.to_string());
        }
    }

    Ok(IgnoreRules {
        gi,
        local_only_raw,
        git_ignored_html: HashSet::new(),
    })
}

fn query_git_ignored(cfg: &ServerConfig, rel_paths: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    if rel_paths.is_empty() {
        return out;
    }
    let repo_dir = strip_verbatim_prefix(&cfg.repo_root);
    let child_res = Command::new("git")
        .args(["check-ignore", "--no-index", "-z", "--stdin"])
        .current_dir(&repo_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();

    let Ok(mut child) = child_res else {
        return out;
    };

    if let Some(mut stdin) = child.stdin.take() {
        for p in rel_paths {
            let _ = stdin.write_all(p.as_bytes());
            let _ = stdin.write_all(&[0u8]);
        }
    }

    if let Ok(output) = child.wait_with_output() {
        if matches!(output.status.code(), Some(0) | Some(1)) {
            let text = String::from_utf8_lossy(&output.stdout);
            for part in text.split('\0') {
                if !part.is_empty() {
                    out.insert(part.to_string());
                }
            }
        }
    }
    out
}

fn is_excluded_html(file_stem: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|re| re.is_match(file_stem))
}

fn build_gallery_image_set(cfg: &ServerConfig) -> HashSet<String> {
    let mut set = HashSet::new();
    if !cfg.gallery_dir.is_dir() {
        return set;
    }
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
            set.insert(format!("../gallery/{}", rel_slash));
        }
    }
    set
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
    public_docs_for_df: &mut BTreeMap<i64, String>,
    private_page_names: &mut BTreeSet<String>,
) -> Result<(), String> {
    let image_set = build_gallery_image_set(cfg);
    let mut image_lower_to_actual: HashMap<String, String> = HashMap::with_capacity(image_set.len());
    for img in &image_set {
        image_lower_to_actual.insert(img.to_lowercase(), img.clone());
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
    rules.git_ignored_html = query_git_ignored(cfg, &rel_paths);

    let full_img_re = Regex::new(r#"(?i)^\s*(\.\./gallery/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp))\s*$"#).unwrap();
    let flat_img_re = Regex::new(r#"(?i)^\s*([^\s"'<>/\\]+\.(?:jpg|jpeg|png|gif|webp))\s*$"#).unwrap();
    let heading_re = Regex::new(r"^(#{1,6})\s+(.*)$").unwrap();
    let anchor_re = Regex::new(r#"<span id="anchor">(\d+)-(.+)</span>"#).unwrap();

    let mut failures: Vec<String> = Vec::new();
    let mut missing_images: Vec<String> = Vec::new();
    let mut case_mismatches: Vec<String> = Vec::new();
    let mut pending_rewrites: Vec<(PathBuf, String)> = Vec::new();
    let mut pruned_lines: usize = 0;

    for path in html_list {
        let full_file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let file_stem = full_file_name
            .strip_suffix(".html")
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

        for raw_line in clean_raw.lines() {
            let line = raw_line.trim_end_matches('\r');
            let mut keep_line = true;
            let img_ref = if let Some(c) = full_img_re.captures(line) {
                Some(c[1].to_string())
            } else if let Some(c) = flat_img_re.captures(line) {
                Some(format!("../gallery/img/{}", &c[1]))
            } else {
                None
            };

            if let Some(ref img) = img_ref {
                if image_set.contains(img) {
                    used_images.insert(img.clone());
                } else if let Some(actual) = image_lower_to_actual.get(&img.to_lowercase()) {
                    used_images.insert(actual.clone());
                    case_mismatches.push(format!("{}: {} != {}", file_stem, img, actual));
                } else {
                    missing_images.push(format!("{}: {}", file_stem, img));
                    if cfg.prune_missing_images {
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
            pending_rewrites.push((path.clone(), rewritten));
        }

        if !is_private && !is_excluded {
            core_bundle.insert(format!("/html/{}", full_file_name), html_content.clone());
        }

        let time_stamp = extract_anchor_text(&html_content);
        let parsed_title = extract_title(&html_content);
        let title = if parsed_title.is_empty() {
            file_stem.clone()
        } else {
            parsed_title
        };

        let mut current_record_id: i64 = -1;
        if !title.is_empty() {
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

            let raw_search_body = extract_body_text(&search_text_buf, false);
            let clean_text = raw_search_body
                .replace("${", "&#36;{")
                .replace('`', "&#715;");

            if !is_private && !is_excluded {
                fat_data_map.insert(current_record_id, clean_text);
                let df_body = extract_body_text(&search_text_buf, true);
                public_docs_for_df.insert(current_record_id, format!("{} {}", title, df_body));
            } else if is_private {
                fat_data_map.insert(current_record_id, "localOnly".to_string());
                shadow_data_map.insert(current_record_id, clean_text);
            } else {
                fat_data_map.insert(current_record_id, String::new());
            }
        }

        let virtual_path = if let Some(cap) = anchor_re.captures(&html_content) {
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

        add_path_to_tree(
            lite_tree,
            "html",
            &virtual_path,
            json!(current_record_id),
            "html",
            &final_info,
        );
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
        println!(
            "[WARN] 发现 {} 处失效图片引用（{}）:\n  {}",
            missing_images.len(),
            if cfg.prune_missing_images {
                "将清理"
            } else {
                "未改动源文件"
            },
            preview.join("\n  ")
        );
    }
    if !case_mismatches.is_empty() {
        let preview: Vec<&str> = case_mismatches.iter().take(30).map(|s| s.as_str()).collect();
        println!(
            "[WARN] 发现 {} 处图片引用大小写不一致（线上 GitHub Pages 会 404）:\n  {}",
            case_mismatches.len(),
            preview.join("\n  ")
        );
    }

    if !pending_rewrites.is_empty() {
        if pruned_lines > cfg.prune_max_lines {
            return Err(format!(
                "本次将删除 {} 行失效图片引用，超过上限 prune_max_lines={}，已中止未改动源文件。",
                pruned_lines, cfg.prune_max_lines
            ));
        }
        let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_dir = cfg.backup_dir.join(format!("html_{}", stamp));
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("创建备份目录失败: {}", e))?;
        for (src_path, new_content) in &pending_rewrites {
            let fname = src_path.file_name().unwrap();
            fs::copy(src_path, backup_dir.join(fname))
                .map_err(|e| format!("备份源文件失败: {}", e))?;
            write_atomic(src_path, new_content, false)?;
        }
        println!(
            "[WARN] 已清理 {} 行失效图片引用（{} 个文件），原文件已备份到 {}",
            pruned_lines,
            pending_rewrites.len(),
            backup_dir.display()
        );
    }

    generate_idle_image_list(cfg, &image_set, &used_images);
    Ok(())
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

fn scan_all_medias(cfg: &ServerConfig, rules: &IgnoreRules, lite_tree: &mut Value) {
    let gallery_exts: HashSet<&str> = ["jpg", "jpeg", "png", "webp", "gif"].into_iter().collect();
    let audio_exts: HashSet<&str> = ["mp3", "wav", "flac", "m4a"].into_iter().collect();
    let video_exts: HashSet<&str> = [
        "mp4", "avi", "mov", "wmv", "mkv", "flv", "webm", "ogg", "ogv", "3gp",
    ]
    .into_iter()
    .collect();
    let ebook_exts: HashSet<&str> = ["epub", "pdf", "mobi", "txt"].into_iter().collect();

    let mut gallery_nodes = Vec::new();
    scan_media_dir(
        &cfg.gallery_dir,
        "gallery/",
        &gallery_exts,
        "image",
        rules,
        &cfg.gallery_exclude_dirs,
        false,
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
        &mut ebook_nodes,
    );

    for (bucket, list) in [
        ("image", gallery_nodes),
        ("audio", audio_nodes),
        ("video", video_nodes),
        ("ebook", ebook_nodes),
    ] {
        for node in list {
            let info = if node.local_only { "localOnly" } else { "" };
            add_path_to_tree(lite_tree, bucket, &node.link, json!(-1), &node.media_type, info);
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
    out: &mut Vec<MediaNode>,
) {
    if !dir.is_dir() {
        return;
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
) {
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
        return;
    }
    if parts.len() == 1 {
        parts.insert(0, "_uncategorized");
    }

    let mut cur = lite_tree.get_mut(bucket).and_then(|v| v.as_object_mut()).unwrap();
    for dir_seg in &parts[..parts.len() - 1] {
        cur = cur
            .entry((*dir_seg).to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .unwrap();
    }
    let files = cur
        .entry("_f".to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .unwrap();
    let file_name = *parts.last().unwrap();
    files.push(json!([file_name, record_id, item_type, info]));
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

fn resolve_precache_paths(cfg: &ServerConfig) -> Result<Vec<(String, PathBuf)>, String> {
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
    let mut missing_explicit: Vec<String> = Vec::new();

    if include_root_slash {
        let idx = cfg.repo_root.join("index.html");
        if !idx.is_file() {
            missing_explicit.push("/".to_string());
        } else {
            resolved.insert("/".to_string(), idx);
        }
    }

    for web_path in explicit_paths {
        if exclude_set.is_match(&web_path) {
            continue;
        }
        let phys = join_rel(&cfg.repo_root, &web_path);
        if !phys.is_file() {
            missing_explicit.push(web_path);
        } else {
            resolved.insert(web_path, phys);
        }
    }

    if !missing_explicit.is_empty() {
        return Err(format!(
            "precache 显式清单中有文件不存在:\n  {}",
            missing_explicit.join("\n  ")
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
            let web_path = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
            if include_set.is_match(&web_path) && !exclude_set.is_match(&web_path) {
                resolved.insert(web_path, entry.path().to_path_buf());
            }
        }
    }

    Ok(resolved.into_iter().collect())
}

fn generate_manifest(
    cfg: &ServerConfig,
    rules: &IgnoreRules,
    exclude_patterns: &[Regex],
    core_bundle: &mut BTreeMap<String, String>,
    generated_data_files: &[String],
) -> Result<Option<String>, String> {
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
        let stem = fname.strip_suffix(".html").unwrap_or(&fname);
        let rel = format!("html/{}", fname);
        if !rules.is_private_rel(&rel, false) {
            let hash = calc_crc32_hex(&p)?;
            let src = if is_excluded_html(stem, exclude_patterns) {
                "no_cache"
            } else {
                "core-bundle.json"
            };
            sw_manifest.insert(format!("/html/{}", fname), FileMeta { hash, source: src });
        }
    }

    for df in generated_data_files {
        let p = cfg.data_dir.join(df);
        let hash = calc_crc32_hex(&p)?;
        sw_manifest.insert(
            format!("/src/js/data/{}", df),
            FileMeta {
                hash,
                source: "standalone",
            },
        );
    }

    let precache_files = resolve_precache_paths(cfg)?;
    for (web_path, phys) in precache_files {
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

    let readme_web = normalize_web_path(&cfg.readme_md);
    if !readme_web.is_empty() && !sw_manifest.contains_key(&readme_web) {
        let phys = join_rel(&cfg.repo_root, &readme_web);
        if phys.is_file() {
            let hash = calc_crc32_hex(&phys)?;
            if let Ok(text) = fs::read_to_string(&phys) {
                core_bundle.insert(readme_web.clone(), text);
                sw_manifest.insert(
                    readme_web,
                    FileMeta {
                        hash,
                        source: "core-bundle.json",
                    },
                );
            } else {
                sw_manifest.insert(
                    readme_web,
                    FileMeta {
                        hash,
                        source: "standalone",
                    },
                );
            }
        }
    }

    let bundle_json = serde_json::to_string(core_bundle)
        .map_err(|e| format!("序列化 core-bundle.json 失败: {}", e))?;
    write_atomic(&cfg.data_dir.join("core-bundle.json"), &bundle_json, false)?;

    let core_list_path = cfg.js_raw_dir.join("core-list.js");
    let mut old_version: Option<String> = None;
    let mut old_hashes: HashMap<String, String> = HashMap::new();

    if core_list_path.is_file() {
        if let Ok(old_content) = fs::read_to_string(&core_list_path) {
            let ver_re = Regex::new(r"const BUILD_VERSION = '(\d+)';").unwrap();
            if let Some(c) = ver_re.captures(&old_content) {
                old_version = Some(c[1].to_string());
            }
            let tpl_re = Regex::new(r"`([^`]+)`").unwrap();
            if let Some(c) = tpl_re.captures(&old_content) {
                for group in c[1].split(';') {
                    if let Some((dir, files_str)) = group.split_once('|') {
                        for item in files_str.split('*') {
                            let mut parts = item.split(':');
                            if let (Some(n), Some(h)) = (parts.next(), parts.next()) {
                                old_hashes.insert(format!("{}{}", dir, n), h.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let mut has_changed = old_version.is_none() || old_hashes.len() != sw_manifest.len();
    if !has_changed {
        for (k, meta) in &sw_manifest {
            if old_hashes.get(k).map(|s| s.as_str()) != Some(meta.hash.as_str()) {
                has_changed = true;
                break;
            }
        }
    }

    if !has_changed {
        println!(
            "[Phase 2] 清单哈希无变化（{} 项），沿用旧 BUILD_VERSION。",
            sw_manifest.len()
        );
        return Ok(None);
    }

    let build_version = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();

    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (full_path, meta) in &sw_manifest {
        let last_slash = full_path.rfind('/').unwrap_or(0);
        let dir = full_path[..=last_slash].to_string();
        let name = &full_path[last_slash + 1..];
        let flag = match meta.source {
            "core-bundle.json" => "1",
            "no_cache" => "2",
            _ => "0",
        };
        grouped
            .entry(dir)
            .or_default()
            .push(format!("{}:{}:{}", name, meta.hash, flag));
    }

    let dir_strings: Vec<String> = grouped
        .into_iter()
        .map(|(d, items)| format!("{}|{}", d, items.join("*")))
        .collect();
    let data_idx_json = serde_json::to_string(generated_data_files).unwrap();

    let core_list_js = format!(
        "const BUILD_VERSION = '{}';\nconst FILE_MANIFEST = {{}};\n`{}`.split(';').forEach(g => {{ if(!g)return; let [d, f] = g.split('|'); f.split('*').forEach(i => {{ let [n, h, s] = i.split(':'); let src = 'standalone'; if(s === '1') src = 'core-bundle.json'; else if(s === '2') src = 'no_cache'; FILE_MANIFEST[d+n] = {{ hash: h, source: src }}; }}); }});\nconst allFilesToCache = Object.keys(FILE_MANIFEST).filter(p => !p.includes('/src/js/data/fat_data_') && FILE_MANIFEST[p].source !== 'no_cache');\n\nif (typeof window !== 'undefined') {{ window.dataIndex = {}; }}\n",
        build_version,
        dir_strings.join(";"),
        data_idx_json
    );

    if let Some(parent) = core_list_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    write_atomic(&core_list_path, &core_list_js, false)?;

    println!(
        "[Phase 2] 已生成新清单 BUILD_VERSION={} ({} 项)",
        build_version,
        sw_manifest.len()
    );
    Ok(Some(build_version))
}

fn update_sw_version(cfg: &ServerConfig, build_version: &str) -> Result<(), String> {
    let sw_path = cfg.js_raw_dir.join("sw.js");
    if !sw_path.is_file() {
        return Err(format!("找不到 {}, 无法写入 SW 版本号", sw_path.display()));
    }
    let raw = fs::read_to_string(&sw_path)
        .map_err(|e| format!("读取 raw/sw.js 失败: {}", e))?;
    let use_crlf = raw.contains("\r\n");
    let mut found_ver = false;
    let mut out_lines: Vec<String> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("self.SW_VERSION") {
            out_lines.push(format!("self.SW_VERSION = '{}';", build_version));
            found_ver = true;
        } else if trimmed.starts_with("importScripts") && trimmed.contains("core-list.js") {
            out_lines.push(format!(
                "importScripts('/src/js/core-list.js?v={}');",
                build_version
            ));
        } else {
            out_lines.push(line.trim_end_matches('\r').to_string());
        }
    }
    if !found_ver {
        out_lines.insert(0, format!("self.SW_VERSION = '{}';", build_version));
    }
    let sep = if use_crlf { "\r\n" } else { "\n" };
    let mut final_str = out_lines.join(sep);
    final_str.push_str(sep);
    write_atomic(&sw_path, &final_str, false)
}

fn assert_no_private_leak(
    cfg: &ServerConfig,
    private_page_names: &BTreeSet<String>,
    shadow_data_map: &BTreeMap<i64, String>,
    generated_data_files: &[String],
    core_bundle: &BTreeMap<String, String>,
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
        let p = cfg.data_dir.join(f);
        if p.is_file() {
            let txt = fs::read_to_string(&p)
                .map_err(|e| format!("隔离检查读取 {} 失败: {}", f, e))?;
            blobs.push((f.clone(), txt));
        }
    }
    let bundle_path = cfg.data_dir.join("core-bundle.json");
    if bundle_path.is_file() {
        let txt = fs::read_to_string(&bundle_path)
            .map_err(|e| format!("隔离检查读取 core-bundle.json 失败: {}", e))?;
        blobs.push(("core-bundle.json".to_string(), txt));
    }
    let syn_path = cfg.js_out_dir.join("synonyms.js");
    if syn_path.is_file() {
        let txt = fs::read_to_string(&syn_path)
            .map_err(|e| format!("隔离检查读取 synonyms.js 失败: {}", e))?;
        blobs.push(("synonyms.js".to_string(), txt));
    }

    for (rec_id, text) in shadow_data_map {
        let chars: Vec<char> = text.chars().collect();
        let n = chars.len();
        if n < 200 {
            continue;
        }
        let s1: String = chars[n / 4..n / 4 + 40].iter().collect();
        let s2: String = chars[n / 2..n / 2 + 40].iter().collect();
        let s3: String = chars[n * 3 / 4..n * 3 / 4 + 40].iter().collect();
        for (blob_name, blob_text) in &blobs {
            if blob_text.contains(&s1) && blob_text.contains(&s2) && blob_text.contains(&s3) {
                problems.push(format!(
                    "公网产物 {} 含有私有页 (recordId={}) 的正文片段",
                    blob_name, rec_id
                ));
            }
        }
    }

    if !problems.is_empty() {
        return Err(format!(
            "公私隔离断言失败，已中止构建（请勿提交或推送）:\n  {}",
            problems.join("\n  ")
        ));
    }
    println!(
        "[Phase 2] 公私隔离断言通过（{} 个私有页均未泄露至公网产物）",
        private_page_names.len()
    );
    Ok(())
}
