use chrono::{Local, TimeZone};
use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::imageops::FilterType;
use image::{AnimationDecoder, DynamicImage, Frame};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::api_files::write_atomic;
use crate::builder::html_utils::escape_html;
use crate::config::ServerConfig;
use crate::media::webp::encode_image_to_webp;
use crate::security::validate_title;

static IMG_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Debug, Clone)]
pub struct KeepOptions {
    /// "single" 或 "merge"
    pub mode: String,
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct KeepSummary {
    pub mode: String,
    pub zip_file: String,
    pub generated_pages: Vec<String>,
    pub processed_images: usize,
}

fn next_unique_ts_stem() -> String {
    let base = Local::now().format("%Y%m%d%H%M%S%3f").to_string();
    let seq = IMG_SEQ.fetch_add(1, Ordering::Relaxed) % 1000;
    if seq == 0 {
        base
    } else {
        format!("{}_{:03}", base, seq)
    }
}

fn find_latest_zip(folder: &Path) -> Result<PathBuf, String> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let rd = fs::read_dir(folder)
        .map_err(|e| format!("读取 Takeout ZIP 目录失败 ({}): {}", folder.display(), e))?;
    for ent in rd.filter_map(|e| e.ok()) {
        let p = ent.path();
        if !p.is_file() {
            continue;
        }
        let is_zip = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.eq_ignore_ascii_case("zip"))
            .unwrap_or(false);
        if !is_zip {
            continue;
        }
        let mtime = ent
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p));
        }
    }
    best.map(|(_, p)| p)
        .ok_or_else(|| format!("目录中没有 .zip 文件: {}", folder.display()))
}

fn zip_signature(zip_path: &Path) -> String {
    match fs::metadata(zip_path) {
        Ok(m) => {
            let mtime_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("{}|{}", m.len(), mtime_ms)
        }
        Err(_) => String::new(),
    }
}

fn ensure_unzipped(zip_path: &Path) -> Result<PathBuf, String> {
    let stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "非法 ZIP 文件名".to_string())?;
    let dest_dir = zip_path.parent().unwrap().join(stem);
    let sig_file = dest_dir.join(".swamp_unzip_sig");
    let expected_sig = zip_signature(zip_path);

    if dest_dir.is_dir() && !expected_sig.is_empty() && sig_file.is_file() {
        if let Ok(saved) = fs::read_to_string(&sig_file) {
            if saved.trim() == expected_sig {
                return Ok(dest_dir);
            }
        }
    }

    if dest_dir.exists() {
        if !sig_file.is_file() {
            return Err(format!(
                "目标解压目录 {} 已存在且缺少 .swamp_unzip_sig 标记（可能非本工具创建），为防止误删已中止",
                dest_dir.display()
            ));
        }
        fs::remove_dir_all(&dest_dir)
            .map_err(|e| format!("清理旧的过期解压目录失败: {}", e))?;
    }

    fs::create_dir_all(&dest_dir).map_err(|e| format!("创建解压目录失败: {}", e))?;
    let file = File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
        let Some(rel_path) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue; // 防 Zip Slip 路径穿越
        };
        let out_path = dest_dir.join(rel_path);
        if entry.is_dir() {
            let _ = fs::create_dir_all(&out_path);
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut out_file =
                File::create(&out_path).map_err(|e| format!("创建解压文件失败: {}", e))?;
            io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("写出解压文件失败: {}", e))?;
        }
    }

    if !expected_sig.is_empty() {
        let _ = write_atomic(&sig_file, &expected_sig, false);
    }

    Ok(dest_dir)
}

fn backup_existing_html_if_needed(cfg: &ServerConfig, out_file: &Path, stamp: &str) -> Result<(), String> {
    if !out_file.is_file() {
        return Ok(());
    }
    let bak_dir = cfg.backup_dir.join(format!("keep2html_{}", stamp));
    fs::create_dir_all(&bak_dir).map_err(|e| format!("创建 Keep 覆盖备份目录失败: {}", e))?;
    if let Some(fname) = out_file.file_name() {
        fs::copy(out_file, bak_dir.join(fname))
            .map_err(|e| format!("备份已有 HTML 失败 ({}): {}", out_file.display(), e))?;
    }
    Ok(())
}

fn parse_hex_prefix(file_path: &str) -> u64 {
    let prefix = file_path.split('.').next().unwrap_or("");
    u64::from_str_radix(prefix, 16).unwrap_or(u64::MAX)
}

fn format_ts_from_usec(usec: i64) -> String {
    let millis = usec / 1000;
    Local
        .timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y%m%d%H%M%S")
        .to_string()
}

/// 纯 Rust 压缩单张 Keep 附件（静态图转有损 WebP；多帧 GIF 缩放后保留为纯净 GIF，零外部工具）
fn compress_attachment(
    img_path: &Path,
    out_dir: &Path,
    quality: u8,
    max_width: u32,
) -> Result<String, String> {
    if !img_path.is_file() {
        return Ok(img_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default());
    }
    fs::create_dir_all(out_dir).map_err(|e| format!("创建图片输出目录失败: {}", e))?;

    let is_gif = img_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("gif"))
        .unwrap_or(false);

    let stem = next_unique_ts_stem();

    if is_gif {
        let f = File::open(img_path).map_err(|e| format!("打开 GIF 失败: {}", e))?;
        let decoder =
            GifDecoder::new(BufReader::new(f)).map_err(|e| format!("解码 GIF 失败: {}", e))?;
        let frames = decoder
            .into_frames()
            .collect_frames()
            .map_err(|e| format!("读取 GIF 帧失败: {}", e))?;

        if frames.len() <= 1 {
            // 单帧 GIF 直接转有损 WebP
            let webp_name = format!("{}.webp", stem);
            let dst = out_dir.join(&webp_name);
            encode_image_to_webp(img_path, &dst, max_width, quality)?;
            return Ok(webp_name);
        }

        // 多帧动图 GIF：按 max_width 缩放并输出 .gif（浏览器及 lib.rs MEDIA_RE 原生支持）
        let gif_name = format!("{}.gif", stem);
        let dst = out_dir.join(&gif_name);
        let first_w = frames[0].buffer().width();
        if max_width == 0 || first_w <= max_width {
            fs::copy(img_path, &dst).map_err(|e| format!("复制 GIF 失败: {}", e))?;
            return Ok(gif_name);
        }

        let mut resized_frames = Vec::with_capacity(frames.len());
        for frame in frames {
            let delay = frame.delay();
            let buf = frame.into_buffer();
            let new_h =
                ((buf.height() as u64 * max_width as u64) / buf.width().max(1) as u64).max(1) as u32;
            let dyn_img = DynamicImage::ImageRgba8(buf).resize_exact(
                max_width,
                new_h,
                FilterType::Triangle,
            );
            resized_frames.push(Frame::from_parts(dyn_img.to_rgba8(), 0, 0, delay));
        }

        let out_file = File::create(&dst).map_err(|e| format!("创建 GIF 失败: {}", e))?;
        let mut encoder = GifEncoder::new(out_file);
        let _ = encoder.set_repeat(Repeat::Infinite);
        encoder
            .encode_frames(resized_frames.into_iter())
            .map_err(|e| format!("编码 GIF 失败: {}", e))?;
        return Ok(gif_name);
    }

    let webp_name = format!("{}.webp", stem);
    let dst = out_dir.join(&webp_name);
    encode_image_to_webp(img_path, &dst, max_width, quality)?;
    Ok(webp_name)
}

fn escape_pre_body(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

fn resolve_attachment_in_unzip(
    canon_unzip_dir: &Path,
    note_parent_dir: &Path,
    raw_fp: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_fp.trim();
    if trimmed.is_empty() || trimmed.contains("..") || Path::new(trimmed).is_absolute() {
        return Err(format!("检测到非法 Keep 附件路径: {}", raw_fp));
    }
    let candidate = note_parent_dir.join(trimmed);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let canon = fs::canonicalize(&candidate)
        .map_err(|e| format!("规范化 Keep 附件路径失败 ({}): {}", raw_fp, e))?;
    if !canon.starts_with(canon_unzip_dir) {
        return Err(format!("Keep 附件路径越界解压目录，已拒绝读取: {}", raw_fp));
    }
    Ok(canon)
}

fn render_from_template(template: &str, title: &str, ts: &str, category: &str, body: &str) -> String {
    static PRE_RE: OnceLock<Regex> = OnceLock::new();
    let pre_re = PRE_RE.get_or_init(|| Regex::new(r"(?s)<pre>.*?</pre>").unwrap());

    // 默认转义 & / < / >，防止 Keep 笔记原文注入 HTML 或内联脚本，同时保留引号可读性
    let safe_body = escape_pre_body(body);
    let step1 = template
        .replace("<title></title>", &format!("<title>{}</title>", escape_html(title)))
        .replace(
            r#"<span id="anchor"></span>"#,
            &format!(r#"<span id="anchor">{}-{}</span>"#, ts, escape_html(category)),
        );
    // 注意 Regex::replace 中 `$` 有特殊含义，使用 NoExpand 避免笔记正文含 `$1` 被误展开
    pre_re
        .replace(
            &step1,
            regex::NoExpand(&format!("<pre>\n{}\n</pre>", safe_body)),
        )
        .into_owned()
}

/// 纯 Rust 取代 Keep2HtmlConverter.java
pub fn run_keep2html(cfg: &ServerConfig, opts: KeepOptions) -> Result<KeepSummary, String> {
    let keep_folder = cfg.keep_takeout_zip_folder.clone().ok_or_else(|| {
        "未配置 keep_takeout_zip_folder（请在 _build/privy/local.toml 或 local.properties 中设置）"
            .to_string()
    })?;
    if !keep_folder.is_dir() {
        return Err(format!("Takeout ZIP 目录不存在: {}", keep_folder.display()));
    }
    if !cfg.template_html.is_file() {
        return Err(format!("HTML 模板不存在: {}", cfg.template_html.display()));
    }

    let latest_zip = find_latest_zip(&keep_folder)?;
    let unzip_dir = ensure_unzipped(&latest_zip)?;
    let canon_unzip_dir = fs::canonicalize(&unzip_dir).unwrap_or_else(|_| unzip_dir.clone());

    let mut json_files: Vec<PathBuf> = WalkDir::new(&unzip_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    json_files.sort();

    if json_files.is_empty() {
        return Err("解压目录中未找到任何 .json 笔记文件".to_string());
    }

    let template = fs::read_to_string(&cfg.template_html)
        .map_err(|e| format!("读取模板失败: {}", e))?;

    let mut generated_pages = Vec::new();
    let mut processed_images = 0usize;
    let mode = opts.mode.trim().to_ascii_lowercase();
    let run_stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();

    if mode == "single" {
        for jf in &json_files {
            let Ok(raw) = fs::read_to_string(jf) else {
                continue;
            };
            let Ok(root) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let is_archived = root.get("isArchived").and_then(|v| v.as_bool()).unwrap_or(false);
            let is_trashed = root.get("isTrashed").and_then(|v| v.as_bool()).unwrap_or(false);
            if !is_archived || is_trashed {
                continue;
            }

            let mut has_single = false;
            let mut category: Option<String> = None;
            if let Some(labels) = root.get("labels").and_then(|v| v.as_array()) {
                for lbl in labels {
                    if let Some(name) = lbl.get("name").and_then(|v| v.as_str()) {
                        if name == "single" {
                            has_single = true;
                        } else {
                            category = Some(name.to_string());
                        }
                    }
                }
            }
            let Some(cat) = category else {
                continue;
            };
            if !has_single {
                continue;
            }

            let article_title = root
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !validate_title(&article_title) {
                continue;
            }

            let is_diary = cat == "日记";
            let target_img_dir = if is_diary {
                cfg.gallery_dir.join("diary")
            } else {
                cfg.webp_output_dir.clone()
            };

            let ts = format_ts_from_usec(
                root.get("createdTimestampUsec")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            );
            let mut text_content = root
                .get("textContent")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if let Some(atts) = root.get("attachments").and_then(|v| v.as_array()) {
                let mut sorted: Vec<String> = atts
                    .iter()
                    .filter_map(|a| a.get("filePath").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect();
                sorted.sort_by_key(|fp| parse_hex_prefix(fp));

                let parent_dir = jf.parent().unwrap();
                for (i, fp) in sorted.iter().enumerate() {
                    let img_path = resolve_attachment_in_unzip(&canon_unzip_dir, parent_dir, fp)?;
                    let new_name = compress_attachment(
                        &img_path,
                        &target_img_dir,
                        cfg.webp_quality,
                        cfg.img_max_width,
                    )?;
                    processed_images += 1;
                    let replacement = if is_diary {
                        format!("../gallery/diary/{}", new_name)
                    } else {
                        new_name
                    };
                    text_content = text_content.replace(&format!("[[IMG{}]]", i + 1), &replacement);
                }
            }

            let html = render_from_template(&template, &article_title, &ts, &cat, &text_content);
            let out_file = cfg.html_dir.join(format!("{}.html", article_title));
            backup_existing_html_if_needed(cfg, &out_file, &run_stamp)?;
            write_atomic(&out_file, &html, false)?;
            generated_pages.push(format!("{}.html", article_title));
        }
    } else if mode == "merge" {
        let tag_name = opts.tag_name.trim().to_string();
        let category = opts.category.trim().to_string();
        if !validate_title(&tag_name) {
            return Err("多合一模式的标签名（将作为页面标题）不能为空或包含非法字符".to_string());
        }
        if category.is_empty() {
            return Err("多合一模式必须指定分类名".to_string());
        }

        let mut notes: Vec<(i64, PathBuf, Value)> = Vec::new();
        for jf in &json_files {
            let Ok(raw) = fs::read_to_string(jf) else {
                continue;
            };
            let Ok(root) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let is_archived = root.get("isArchived").and_then(|v| v.as_bool()).unwrap_or(false);
            let is_trashed = root.get("isTrashed").and_then(|v| v.as_bool()).unwrap_or(false);
            if !is_archived || is_trashed {
                continue;
            }
            let has_tag = root
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .any(|l| l.get("name").and_then(|v| v.as_str()) == Some(tag_name.as_str()))
                })
                .unwrap_or(false);
            if has_tag {
                let usec = root
                    .get("createdTimestampUsec")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                notes.push((usec, jf.clone(), root));
            }
        }
        if notes.is_empty() {
            return Err(format!("未找到包含标签「{}」的已归档笔记", tag_name));
        }
        notes.sort_by_key(|(usec, _, _)| *usec);

        let mut merged_body = String::new();
        for (_, jf, note) in notes {
            let t = note.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let mut c = note
                .get("textContent")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if let Some(atts) = note.get("attachments").and_then(|v| v.as_array()) {
                let mut sorted: Vec<String> = atts
                    .iter()
                    .filter_map(|a| a.get("filePath").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect();
                sorted.sort_by_key(|fp| parse_hex_prefix(fp));
                let parent_dir = jf.parent().unwrap();
                for (i, fp) in sorted.iter().enumerate() {
                    let img_path = resolve_attachment_in_unzip(&canon_unzip_dir, parent_dir, fp)?;
                    let new_name = compress_attachment(
                        &img_path,
                        &cfg.webp_output_dir,
                        cfg.webp_quality,
                        cfg.img_max_width,
                    )?;
                    processed_images += 1;
                    c = c.replace(&format!("[[IMG{}]]", i + 1), &new_name);
                }
            }
            merged_body.push_str("# ");
            merged_body.push_str(t);
            merged_body.push('\n');
            merged_body.push_str(&c);
            merged_body.push_str("\n\n");
        }

        let ts = Local::now().format("%Y%m%d%H%M%S").to_string();
        let html = render_from_template(&template, &tag_name, &ts, &category, &merged_body);
        let out_file = cfg.html_dir.join(format!("{}.html", tag_name));
        backup_existing_html_if_needed(cfg, &out_file, &run_stamp)?;
        write_atomic(&out_file, &html, false)?;
        generated_pages.push(format!("{}.html", tag_name));
    } else {
        return Err("mode 仅支持 single 或 merge".to_string());
    }

    Ok(KeepSummary {
        mode,
        zip_file: latest_zip
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        generated_pages,
        processed_images,
    })
}
