use chrono::Local;
use regex::Regex;
use std::fs;
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

pub fn extract_body_text(html: &str, strip_anchor: bool) -> String {
    static BODY_RE: OnceLock<Regex> = OnceLock::new();
    static SCRIPT_STYLE_RE: OnceLock<Regex> = OnceLock::new();
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

    let ss_re = SCRIPT_STYLE_RE.get_or_init(|| {
        Regex::new(r"(?is)<(script|style)\b[^>]*>.*?</(script|style)>").unwrap()
    });
    slice = ss_re.replace_all(&slice, " ").into_owned();

    let cm_re = COMMENT_RE.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
    slice = cm_re.replace_all(&slice, " ").into_owned();

    let mut stripped = String::with_capacity(slice.len());
    let mut in_tag = false;
    let mut in_quote: Option<char> = None;
    for ch in slice.chars() {
        if in_tag {
            if let Some(q) = in_quote {
                if ch == q {
                    in_quote = None;
                }
            } else if ch == '"' || ch == '\'' {
                in_quote = Some(ch);
            } else if ch == '>' {
                in_tag = false;
                stripped.push(' ');
            }
        } else if ch == '<' {
            in_tag = true;
            in_quote = None;
        } else {
            stripped.push(ch);
        }
    }

    let decoded = decode_html_entities(&stripped);
    let mut collapsed = String::with_capacity(decoded.len());
    let mut prev_ws = true;
    for ch in decoded.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                collapsed.push(' ');
                prev_ws = true;
            }
        } else {
            collapsed.push(ch);
            prev_ws = false;
        }
    }
    if collapsed.ends_with(' ') {
        collapsed.pop();
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

    let with_title = title_re.replace(&tpl, format!("<title>{}</title>", escape_html(title)));
    let final_html = anchor_re.replace(
        &with_title,
        format!(r#"<span id="anchor">{}-{}</span>"#, ts, escape_html(category)),
    );

    write_atomic(&out_path, final_html.as_ref(), false)?;
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
