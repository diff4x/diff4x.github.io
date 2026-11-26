use chrono::Local;
use regex::{NoExpand, Regex};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::api_files::write_atomic;
use crate::config::ServerConfig;
use crate::security::{validate_bookmark_block, validate_bookmark_title, validate_http_url, validate_title};

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

pub fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut i = 0usize;

    while i < n {
        if bytes[i] == b'&' {
            if let Some(semi_rel) = bytes[i + 1..n.min(i + 14)].iter().position(|&b| b == b';') {
                let entity = &s[i + 1..i + 1 + semi_rel];
                let decoded: Option<char> = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    e if e.starts_with("#x") || e.starts_with("#X") => {
                        u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)
                    }
                    e if e.starts_with('#') => {
                        e[1..].parse::<u32>().ok().and_then(char::from_u32)
                    }
                    _ => None,
                };
                if let Some(ch) = decoded {
                    out.push(ch);
                    i += semi_rel + 2;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn extract_title(html: &str) -> String {
    static TITLE_RE: OnceLock<Regex> = OnceLock::new();
    let re = TITLE_RE.get_or_init(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").unwrap());
    re.captures(html)
        .map(|c| decode_html_entities(c[1].trim()))
        .unwrap_or_default()
}

pub fn extract_anchor_text(html: &str) -> String {
    static ANCHOR_EL_RE: OnceLock<Regex> = OnceLock::new();
    let re = ANCHOR_EL_RE.get_or_init(|| {
        Regex::new(r#"(?is)<span\b[^>]*\bid\s*=\s*["']anchor["'][^>]*>(.*?)</span>"#).unwrap()
    });
    re.captures(html)
        .map(|c| decode_html_entities(c[1].trim()))
        .unwrap_or_default()
}

fn is_block_tag_name(raw_tag: &str) -> bool {
    let trimmed = raw_tag.trim_start_matches('/').trim_start();
    let name_len = trimmed
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric())
        .count();
    let name = &trimmed[..name_len];
    name.eq_ignore_ascii_case("br")
        || name.eq_ignore_ascii_case("p")
        || name.eq_ignore_ascii_case("div")
        || name.eq_ignore_ascii_case("li")
        || name.eq_ignore_ascii_case("tr")
        || name.eq_ignore_ascii_case("pre")
        || name.eq_ignore_ascii_case("blockquote")
        || name.eq_ignore_ascii_case("hr")
        || name.eq_ignore_ascii_case("section")
        || name.eq_ignore_ascii_case("article")
        || name.eq_ignore_ascii_case("table")
        || name.eq_ignore_ascii_case("ul")
        || name.eq_ignore_ascii_case("ol")
        || name.eq_ignore_ascii_case("dt")
        || name.eq_ignore_ascii_case("dd")
        || name.eq_ignore_ascii_case("h1")
        || name.eq_ignore_ascii_case("h2")
        || name.eq_ignore_ascii_case("h3")
        || name.eq_ignore_ascii_case("h4")
        || name.eq_ignore_ascii_case("h5")
        || name.eq_ignore_ascii_case("h6")
}

pub fn extract_body_text(html: &str, strip_anchor: bool) -> String {
    static BODY_RE: OnceLock<Regex> = OnceLock::new();
    static SCRIPT_RE: OnceLock<Regex> = OnceLock::new();
    static STYLE_RE: OnceLock<Regex> = OnceLock::new();
    static COMMENT_RE: OnceLock<Regex> = OnceLock::new();
    static ANCHOR_SPAN_RE: OnceLock<Regex> = OnceLock::new();

    let body_re = BODY_RE.get_or_init(|| Regex::new(r"(?is)<body\b[^>]*>(.*?)</body>").unwrap());
    let mut slice = body_re
        .captures(html)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| html.to_string());

    if strip_anchor {
        let a_re = ANCHOR_SPAN_RE.get_or_init(|| {
            Regex::new(r#"(?is)<span\b[^>]*\bid\s*=\s*["']anchor["'][^>]*>.*?</span>"#).unwrap()
        });
        slice = a_re.replace(&slice, " ").into_owned();
    }

    let sc_re = SCRIPT_RE.get_or_init(|| Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap());
    slice = sc_re.replace_all(&slice, " ").into_owned();

    let st_re = STYLE_RE.get_or_init(|| Regex::new(r"(?is)<style\b[^>]*>.*?</style>").unwrap());
    slice = st_re.replace_all(&slice, " ").into_owned();

    let cm_re = COMMENT_RE.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
    slice = cm_re.replace_all(&slice, " ").into_owned();

    // 仅对合法 HTML 标签起始（<[A-Za-z/!?]）且在后续存在闭合 '>' 的片段做剥离，避免吞掉正文中的 `a < b`
    let bytes = slice.as_bytes();
    let n = bytes.len();
    let mut stripped = String::with_capacity(n);
    let mut i = 0usize;
    while i < n {
        if bytes[i] == b'<' && i + 1 < n {
            let next_b = bytes[i + 1];
            let valid_tag_start =
                next_b.is_ascii_alphabetic() || matches!(next_b, b'/' | b'!' | b'?');
            if valid_tag_start {
                let mut j = i + 2;
                let mut in_quote: Option<u8> = None;
                let mut found_end = None;
                while j < n {
                    let b = bytes[j];
                    if let Some(q) = in_quote {
                        if b == q {
                            in_quote = None;
                        }
                    } else if b == b'"' || b == b'\'' {
                        in_quote = Some(b);
                    } else if b == b'>' {
                        found_end = Some(j);
                        break;
                    }
                    j += 1;
                }
                if let Some(end_idx) = found_end {
                    let tag_inner = &slice[i + 1..end_idx];
                    if is_block_tag_name(tag_inner) {
                        stripped.push('\n');
                    } else {
                        stripped.push(' ');
                    }
                    i = end_idx + 1;
                    continue;
                }
            }
        }
        let ch = slice[i..].chars().next().unwrap();
        stripped.push(ch);
        i += ch.len_utf8();
    }

    // 保留换行硬边界（与 lib.rs is_hard_break 和 content.js 页内搜索对齐），仅折叠行内空白并去除空行
    let decoded = decode_html_entities(&stripped);
    let mut collapsed = String::with_capacity(decoded.len());
    for raw_line in decoded.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let mut line_buf = String::new();
        let mut prev_ws = true;
        for ch in raw_line.chars() {
            if ch.is_whitespace() {
                if !prev_ws {
                    line_buf.push(' ');
                    prev_ws = true;
                }
            } else {
                line_buf.push(ch);
                prev_ws = false;
            }
        }
        if line_buf.ends_with(' ') {
            line_buf.pop();
        }
        if !line_buf.is_empty() {
            if !collapsed.is_empty() {
                collapsed.push('\n');
            }
            collapsed.push_str(&line_buf);
        }
    }
    collapsed
}

pub fn create_new_html(cfg: &ServerConfig, title: &str, category: &str) -> Result<PathBuf, String> {
    let title = title.trim();
    let category = category.trim();
    if !validate_title(title) {
        return Err(format!("非法标题: {}", title));
    }
    if category.is_empty() || category.contains('<') || category.contains('>') {
        return Err(format!("非法分类: {}", category));
    }
    if !cfg.html_dir.is_dir() {
        return Err(format!("HTML 目录不存在: {}", cfg.html_dir.display()));
    }
    if !cfg.template_html.is_file() {
        return Err(format!("模板文件不存在: {}", cfg.template_html.display()));
    }

    let out_path = cfg.html_dir.join(format!("{}.html", title));
    if out_path.exists() {
        return Err(format!("目标文件已存在: {}", out_path.display()));
    }

    let tpl = fs::read_to_string(&cfg.template_html)
        .map_err(|e| format!("读取模板失败: {}", e))?;
    let ts = Local::now().format("%Y%m%d%H%M%S").to_string();

    static TITLE_TAG_RE: OnceLock<Regex> = OnceLock::new();
    static ANCHOR_TAG_RE: OnceLock<Regex> = OnceLock::new();
    let title_re = TITLE_TAG_RE.get_or_init(|| Regex::new(r"(?is)<title\b[^>]*>.*?</title>").unwrap());
    let anchor_re = ANCHOR_TAG_RE.get_or_init(|| {
        Regex::new(r#"(?is)<span\b[^>]*\bid\s*=\s*["']anchor["'][^>]*>.*?</span>"#).unwrap()
    });

    if !anchor_re.is_match(&tpl) {
        return Err("模板中未找到 <span id=\"anchor\"> 标签".to_string());
    }

    let title_rep = format!("<title>{}</title>", escape_html(title));
    let with_title = title_re.replace(&tpl, NoExpand(&title_rep));
    let anchor_rep = format!(r#"<span id="anchor">{}-{}</span>"#, ts, escape_html(category));
    let final_html = anchor_re.replace(&with_title, NoExpand(&anchor_rep));

    // 使用 create_new(true) 原子排他创建，消除 exists() 到落盘间的竞态覆盖
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&out_path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("目标文件已存在: {}", out_path.display())
            } else {
                format!("创建新页面失败: {}", e)
            }
        })?;
    if let Err(e) = f.write_all(final_html.as_bytes()) {
        drop(f);
        let _ = fs::remove_file(&out_path);
        return Err(format!("写入新页面失败: {}", e));
    }
    Ok(out_path)
}

pub fn update_bookmark(
    cfg: &ServerConfig,
    block_id: &str,
    raw_title: &str,
    raw_href: &str,
) -> Result<(), String> {
    let block = block_id.trim();
    let href = raw_href.trim();
    let title = if raw_title.trim().is_empty() {
        href
    } else {
        raw_title.trim()
    };

    if !validate_bookmark_block(block) {
        return Err("非法书签区块 ID".to_string());
    }
    if !validate_http_url(href) {
        return Err("仅允许 http:// 或 https:// 链接".to_string());
    }
    if !validate_bookmark_title(title) {
        return Err("非法书签标题".to_string());
    }

    let raw_html = fs::read_to_string(&cfg.bookmark_html)
        .map_err(|e| format!("读取 bookmark.html 失败: {}", e))?;
    let has_bom = raw_html.starts_with('\u{FEFF}');
    let src = raw_html.strip_prefix('\u{FEFF}').unwrap_or(&raw_html);
    let updated = apply_bookmark_mutation(src, block, title, href)?;
    write_atomic(&cfg.bookmark_html, &updated, has_bom)
}

pub fn apply_bookmark_mutation(
    html: &str,
    block_id: &str,
    title: &str,
    href: &str,
) -> Result<String, String> {
    static ANCHOR_RE: OnceLock<Regex> = OnceLock::new();
    static END_FLAG_RE: OnceLock<Regex> = OnceLock::new();

    let a_re = ANCHOR_RE.get_or_init(|| {
        Regex::new(r#"(?is)[ \t]*<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>.*?</a>(?:[ \t]*\r?\n?[ \t]*<br\s*/?>)?"#).unwrap()
    });

    let mut cleaned = String::with_capacity(html.len());
    let mut last = 0usize;
    for cap in a_re.captures_iter(html) {
        let m = cap.get(0).unwrap();
        let full = m.as_str();
        if full.contains("id=\"end_flag\"") || full.contains("id='end_flag'") {
            continue;
        }
        let existing_href = decode_html_entities(cap[1].trim());
        if existing_href == href {
            cleaned.push_str(&html[last..m.start()]);
            let mut next_pos = m.end();
            if html[next_pos..].starts_with("\r\n") {
                next_pos += 2;
            } else if html[next_pos..].starts_with('\n') {
                next_pos += 1;
            }
            last = next_pos;
        }
    }
    cleaned.push_str(&html[last..]);

    let mut result = cleaned;
    if block_id != "del" {
        let div_pat = format!(r#"(?i)<div\b[^>]*\bid\s*=\s*["']{}["'][^>]*>"#, regex::escape(block_id));
        let div_re = Regex::new(&div_pat).map_err(|e| format!("正则错误: {}", e))?;
        let m = div_re
            .find(&result)
            .ok_or_else(|| format!("未在 bookmark.html 中找到区块 id=\"{}\"", block_id))?;

        let new_entry = format!(
            "\n   <a href=\"{}\" target=\"_blank\">{}</a>\n   <br>",
            escape_html(href),
            escape_html(title)
        );
        result.insert_str(m.end(), &new_entry);
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let end_re = END_FLAG_RE.get_or_init(|| {
        Regex::new(r#"(?i)(<a\b[^>]*\bid\s*=\s*["']end_flag["'][^>]*\bhref\s*=\s*["'])[^"']*(["'])"#).unwrap()
    });
    if !end_re.is_match(&result) {
        return Err("未在 bookmark.html 中找到 #end_flag 标记".to_string());
    }
    let final_html = end_re.replace(&result, format!("${{1}}{}${{2}}", now_ms));
    Ok(final_html.into_owned())
}
