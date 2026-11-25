use chrono::Local;
use image::imageops::FilterType;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::api_files::{write_atomic, write_bytes_atomic};
use crate::config::ServerConfig;

#[derive(Deserialize, Default, Debug, Clone)]
pub struct WebpOptions {
    pub max_width: Option<u32>,
    pub quality: Option<u8>,
    #[serde(default)]
    pub use_alt_output: bool,
    #[serde(default)]
    pub update_img_mapping: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct WebpSummary {
    pub total_images: usize,
    pub success_count: usize,
    pub fail_count: usize,
    pub original_bytes: u64,
    pub webp_bytes: u64,
    pub updated_html_count: usize,
    pub elapsed_ms: u128,
    pub generated_files: Vec<String>,
    pub clipboard_copied: bool,
    pub output_dir: String,
}

/// 将单张静态图（JPG/PNG/静态GIF/WebP）按最大宽度缩放并静态链接 libwebp 有损编码
pub fn encode_image_to_webp(
    src_path: &Path,
    dst_path: &Path,
    max_width: u32,
    quality: u8,
) -> Result<u64, String> {
    let img = image::open(src_path)
        .map_err(|e| format!("读取图片失败 ({}): {}", src_path.display(), e))?;

    let resized = if max_width > 0 && img.width() > max_width {
        let new_h = ((img.height() as u64 * max_width as u64) / img.width().max(1) as u64).max(1) as u32;
        img.resize_exact(max_width, new_h, FilterType::Triangle)
    } else {
        img
    };

    let rgba = resized.to_rgba8();
    let encoder = ::webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
    let encoded = encoder.encode(quality.clamp(1, 100) as f32);
    let bytes: &[u8] = &encoded;

    if let Some(parent) = dst_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {}", e))?;
    }
    write_bytes_atomic(dst_path, bytes)
        .map_err(|e| format!("写入 WebP 失败 ({}): {}", dst_path.display(), e))?;
    Ok(bytes.len() as u64)
}

/// 纯 Rust 取代 WebpConverter.java + cwebp.exe + Swing Clipboard
pub fn run_webp_batch(cfg: &ServerConfig, opts: WebpOptions) -> Result<WebpSummary, String> {
    let t0 = Instant::now();
    let max_width = opts.max_width.unwrap_or(cfg.img_max_width);
    let quality = opts.quality.unwrap_or(cfg.webp_quality).clamp(1, 100);

    let input_dir = cfg.img_input_dir.clone().ok_or_else(|| {
        "未配置 img_input_dir（请在 _build/privy/local.toml 或 local.properties 配置截图输入目录）"
            .to_string()
    })?;
    if !input_dir.is_dir() {
        return Err(format!("截图输入目录不存在: {}", input_dir.display()));
    }

    let output_dir = if opts.use_alt_output {
        cfg.webp_output_dir2.clone().ok_or_else(|| {
            "已选择备用输出目录，但未配置 webp_output_dir2".to_string()
        })?
    } else {
        cfg.webp_output_dir.clone()
    };

    let history_dir = input_dir.join("history");
    fs::create_dir_all(&history_dir).map_err(|e| format!("创建 history 目录失败: {}", e))?;
    fs::create_dir_all(&output_dir).map_err(|e| format!("创建输出目录失败: {}", e))?;

    let mut no: u64 = Local::now()
        .format("%Y%m%d%H%M%S")
        .to_string()
        .parse()
        .unwrap_or(20260101000000);

    let mut entries: Vec<PathBuf> = fs::read_dir(&input_dir)
        .map_err(|e| format!("遍历输入目录失败: {}", e))?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|s| matches!(s.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
                    .unwrap_or(false)
        })
        .collect();
    entries.sort();

    let mut records: HashMap<String, String> = HashMap::new();
    let mut generated_files: Vec<String> = Vec::new();
    let mut total_images = 0usize;
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut original_bytes = 0u64;
    let mut webp_bytes = 0u64;

    for path in entries {
        total_images += 1;
        let orig_name = path.file_name().unwrap().to_string_lossy().to_string();
        if let Ok(m) = fs::metadata(&path) {
            original_bytes += m.len();
        }

        while output_dir.join(format!("{}.webp", no)).exists() {
            no += 1;
        }
        let webp_name = format!("{}.webp", no);
        no += 1;
        let dst_path = output_dir.join(&webp_name);

        match encode_image_to_webp(&path, &dst_path, max_width, quality) {
            Ok(out_sz) => {
                webp_bytes += out_sz;
                records.insert(orig_name.to_ascii_lowercase(), webp_name.clone());
                generated_files.push(webp_name);

                let hist_target = history_dir.join(&orig_name);
                if fs::rename(&path, &hist_target).is_err() {
                    // 跨盘符回退 copy + remove
                    if fs::copy(&path, &hist_target).is_ok() {
                        let _ = fs::remove_file(&path);
                    }
                }
                success_count += 1;
            }
            Err(e) => {
                eprintln!("[webp] 转换失败 ({}): {}", orig_name, e);
                fail_count += 1;
            }
        }
    }

    // 可选：同步替换 HTML 文件中的旧图片引用
    let mut updated_html_count = 0usize;
    if opts.update_img_mapping && !records.is_empty() && cfg.html_dir.is_dir() {
        let exclude_res: Vec<Regex> = cfg
            .exclude_html_regex
            .iter()
            .filter_map(|p| Regex::new(p).ok())
            .collect();

        let compiled_reps: Vec<(Regex, String)> = records
            .iter()
            .filter_map(|(old_name, new_name)| {
                let pat = format!(
                    r"(^|[^A-Za-z0-9_.\-])({})($|[^A-Za-z0-9_.\-])",
                    regex::escape(old_name)
                );
                RegexBuilder::new(&pat)
                    .case_insensitive(true)
                    .build()
                    .ok()
                    .map(|re| (re, new_name.clone()))
            })
            .collect();

        if let Ok(rd) = fs::read_dir(&cfg.html_dir) {
            for ent in rd.filter_map(|e| e.ok()) {
                let hp = ent.path();
                if !hp.is_file() {
                    continue;
                }
                let fname = hp.file_name().unwrap().to_string_lossy().to_string();
                if !fname.to_ascii_lowercase().ends_with(".html") {
                    continue;
                }
                let stem = fname.strip_suffix(".html").unwrap_or(&fname);
                if exclude_res.iter().any(|re| re.is_match(stem)) {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(&hp) {
                    let has_bom = raw.starts_with('\u{FEFF}');
                    let mut text = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).to_string();
                    let mut changed = false;
                    for (re, new_name) in &compiled_reps {
                        if re.is_match(&text) {
                            let rep = format!("${{1}}{}${{3}}", new_name);
                            text = re.replace_all(&text, rep.as_str()).into_owned();
                            changed = true;
                        }
                    }
                    if changed && write_atomic(&hp, &text, has_bom).is_ok() {
                        updated_html_count += 1;
                    }
                }
            }
        }
    }

    // 写入剪贴板（纯 Rust arboard）
    let mut clipboard_copied = false;
    if !generated_files.is_empty() {
        let clip_text = generated_files.join("\n") + "\n";
        if let Ok(mut cb) = arboard::Clipboard::new() {
            if cb.set_text(clip_text).is_ok() {
                clipboard_copied = true;
            }
        }
    }

    Ok(WebpSummary {
        total_images,
        success_count,
        fail_count,
        original_bytes,
        webp_bytes,
        updated_html_count,
        elapsed_ms: t0.elapsed().as_millis(),
        generated_files,
        clipboard_copied,
        output_dir: output_dir.to_string_lossy().into_owned(),
    })
}
