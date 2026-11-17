use regex::Regex;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use lazy_static::lazy_static;
use serde_json::Value;
use similar::{Algorithm, DiffOp, capture_diff_slices};
use js_sys::{Uint32Array, Object};

thread_local! {
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());
    static PATH_INDEX: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
    static COMMENTS: RefCell<Vec<CommentDoc>> = RefCell::new(Vec::new());
    static COMMENT_INDEX: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
}

#[derive(Deserialize)]
pub struct CommentDoc {
    pub path: String,
    pub texts: Vec<String>,
}

#[derive(Serialize)]
pub struct SearchResult<'a> {
    pub title: &'a str,
    pub count: usize,
    pub score: usize,
    #[serde(rename = "type")]
    pub res_type: &'a str,
    pub path: &'a str,
    #[serde(rename = "localOnly")]
    pub local_only: bool,
    // 仅组合搜索使用：至少有一个包含项只靠评论才满足时为 true（普通搜索恒为 false，不序列化）
    #[serde(rename = "viaComment", skip_serializing_if = "is_false")]
    pub via_comment: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

lazy_static! {
    static ref MEDIA_RE: Regex = Regex::new(r#"(?i)([^\s"'<>]+\.(?:jpg|png|webp|gif))|(https?://[^\s"'<>]+)"#).unwrap();
    static ref HEADER_RE: Regex = Regex::new(r"^(#{1,6})\s+(.*)$").unwrap();
}

#[wasm_bindgen]
pub fn format_markdown(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out_lines = Vec::with_capacity(lines.len());

    for line in lines {
        if line.is_empty() {
            out_lines.push(String::from("<span class='lv0 empty-line-fix'>\u{00A0}</span>"));
            continue;
        }

        let processed = MEDIA_RE.replace_all(line, |caps: &regex::Captures| {
            if let Some(img) = caps.get(1) {
                let img_str = img.as_str();
                let src = if !img_str.starts_with("http") && !img_str.contains('/') {
                    format!("../gallery/img/{}", img_str)
                } else {
                    img_str.to_string()
                };
                format!("<img src=\"{}\" style=\"max-height:400px;width:auto;\" title=\"{}\">", src, img_str)
            } else if let Some(url) = caps.get(2) {
                let url_str = url.as_str();
                format!("<a href=\"{}\" target=\"_blank\">{}</a>", url_str, url_str)
            } else {
                String::new()
            }
        });

        if let Some(caps) = HEADER_RE.captures(&processed) {
            let level = caps.get(1).unwrap().as_str().len();
            let content = caps.get(2).unwrap().as_str();
            out_lines.push(format!("<h{}>{}</h{}>", level, content, level));
            continue;
        }

        let space_len = processed.chars().take_while(|c| *c == ' ').count();
        let content = &processed[space_len..];

        if content.trim().is_empty() {
            out_lines.push(String::from("<span class='lv0 empty-line-fix'></span>"));
            continue;
        }
        if content.starts_with("<img") {
            out_lines.push(processed.to_string());
            continue;
        }

        let lv = if space_len >= 16 { 16 }
                 else if space_len >= 12 { 12 }
                 else if space_len >= 8 { 8 }
                 else if space_len >= 4 { 4 }
                 else { 0 };

        if lv > 0 {
            out_lines.push(format!("<span class='lv0 lv{}'>{}</span>", lv, content));
        } else {
            out_lines.push(format!("<span class='lv0'>{}</span>", content));
        }
    }

    out_lines.join("\n")
}

fn install_data(local_vec: Vec<String>) {
    let mut index: HashMap<String, usize> = HashMap::with_capacity(local_vec.len() / 4);
    let mut i = 0usize;
    while i + 3 < local_vec.len() {
        index.insert(local_vec[i + 2].clone(), i);
        i += 4;
    }
    GLOBAL_DATA.with(|data| {
        *data.borrow_mut() = local_vec;
    });
    PATH_INDEX.with(|p| {
        *p.borrow_mut() = index;
    });
}

#[wasm_bindgen]
pub fn set_data(data_val: JsValue) {
    let local_vec: Vec<String> = serde_wasm_bindgen::from_value(data_val).unwrap_or_default();
    install_data(local_vec);
}

#[wasm_bindgen]
pub fn build_flat_data(
    lite_val: JsValue,
    fat_val: JsValue,
    shadow_val: JsValue,
    is_offline: bool,
) -> JsValue {
    let lite: Value = serde_wasm_bindgen::from_value(lite_val).unwrap_or(Value::Null);
    let fat: Value = serde_wasm_bindgen::from_value(fat_val).unwrap_or(Value::Null);
    let shadow: Value = serde_wasm_bindgen::from_value(shadow_val).unwrap_or(Value::Null);

    let results = build_flat_vec(&lite, &fat, &shadow, is_offline);

    serde_wasm_bindgen::to_value(&results).unwrap_or(JsValue::NULL)
}

fn build_flat_vec(lite: &Value, fat: &Value, shadow: &Value, is_offline: bool) -> Vec<String> {
    let mut results: Vec<String> = Vec::new();
    let buckets = [
        ("html", "html/"), ("image", "gallery/"),
        ("video", "video/"), ("audio", "audio/"), ("ebook", "ebook/"),
    ];
    for (bucket, prefix) in buckets.iter() {
        if let Some(root) = lite.get(bucket) {
            flatten_tree_recursive(root, prefix, fat, shadow, is_offline, &mut results);
        }
    }
    results
}

#[derive(Serialize)]
struct BuildOut {
    data: Vec<String>,
    fp: String,
}

fn fnv_feed(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

// 数据指纹：覆盖搜索实际看到的全部文本（含 is_offline 带来的正文差异），供主线程做缓存失效判断
fn data_fingerprint(pool: &[String], is_offline: bool) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    h = fnv_feed(h, &[is_offline as u8]);
    h = fnv_feed(h, &(pool.len() as u64).to_le_bytes());
    for s in pool {
        h = fnv_feed(h, &(s.len() as u64).to_le_bytes());
        h = fnv_feed(h, s.as_bytes());
    }
    format!("{:016x}.{}", h, pool.len())
}

// 回传主线程的瘦身视图：html 正文只保留 "localOnly" 标记（主线程只用它判断私有文档），其余类型原样保留
fn slim_view(pool: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(pool.len());
    let mut i = 0usize;
    while i + 3 < pool.len() {
        let content = &pool[i + 1];
        out.push(pool[i].clone());
        if pool[i + 3] == "html" {
            if content.starts_with("localOnly") {
                out.push(String::from("localOnly"));
            } else {
                out.push(String::new());
            }
        } else {
            out.push(content.clone());
        }
        out.push(pool[i + 2].clone());
        out.push(pool[i + 3].clone());
        i += 4;
    }
    while i < pool.len() {
        out.push(pool[i].clone());
        i += 1;
    }
    out
}

// 构建 + 入库一步完成：不再把整份语料序列化成 JsValue 再反序列化回来，
// 返回值只含瘦身数据和指纹，主线程不再持有全部正文。
#[wasm_bindgen]
pub fn build_and_set_data(
    lite_val: JsValue,
    fat_val: JsValue,
    shadow_val: JsValue,
    is_offline: bool,
) -> JsValue {
    let lite: Value = serde_wasm_bindgen::from_value(lite_val).unwrap_or(Value::Null);
    let fat: Value = serde_wasm_bindgen::from_value(fat_val).unwrap_or(Value::Null);
    let shadow: Value = serde_wasm_bindgen::from_value(shadow_val).unwrap_or(Value::Null);

    let results = build_flat_vec(&lite, &fat, &shadow, is_offline);
    let fp = data_fingerprint(&results, is_offline);
    let slim = slim_view(&results);
    install_data(results);

    serde_wasm_bindgen::to_value(&BuildOut { data: slim, fp }).unwrap_or(JsValue::NULL)
}

fn flatten_tree_recursive(node: &Value, prefix: &str, fat: &Value, shadow: &Value, is_offline: bool, results: &mut Vec<String>) {
    if let Value::Object(map) = node {
        if let Some(Value::Array(f_arr)) = map.get("_f") {
            for f_item in f_arr {
                if let Value::Array(item) = f_item {
                    if item.len() >= 3 {
                        let file_name = item.get(0).and_then(|v| v.as_str()).unwrap_or("");
                        
                        let id = match item.get(1) {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Number(n)) => n.to_string(),
                            _ => String::new(),
                        };
                        
                        let f_type = item.get(2).and_then(|v| v.as_str()).unwrap_or("");
                        let info = item.get(3).and_then(|v| v.as_str()).unwrap_or("");
                        
                        let mut title = file_name.to_string();
                        let path = format!("{}{}", prefix, file_name);
                        let mut val1 = info.to_string();
                        let mut val2 = path.clone();

                        if f_type == "html" {
                            if title.ends_with(".html") {
                                title = title[..title.len()-5].to_string();
                            }
                            if let Some(fat_info) = fat.get(&id).and_then(|v| v.as_str()) {
                                val1 = fat_info.to_string();
                            }
                            if is_offline && val1.starts_with("localOnly") {
                                if let Some(shadow_info) = shadow.get(&id).and_then(|v| v.as_str()) {
                                    val1 = format!("localOnly{}", shadow_info);
                                }
                            }
                            val2 = format!("html/{}", file_name);
                        }
                        
                        results.push(title);
                        results.push(val1);
                        results.push(val2);
                        results.push(f_type.to_string());
                    }
                }
            }
        }
        
        for (k, v) in map {
            if k != "_f" {
                let next_prefix = if k == "_uncategorized" {
                    prefix.to_string()
                } else {
                    format!("{}{}/", prefix, k)
                };
                flatten_tree_recursive(v, &next_prefix, fat, shadow, is_offline, results);
            }
        }
    }
}

#[derive(Serialize, Clone)]
pub struct DiffLineOp {
    #[serde(rename = "type")]
    pub op_type: &'static str,
    #[serde(rename = "oldIdx", skip_serializing_if = "Option::is_none")]
    pub old_idx: Option<usize>,
    #[serde(rename = "newIdx", skip_serializing_if = "Option::is_none")]
    pub new_idx: Option<usize>,
}

#[wasm_bindgen]
pub fn compute_lcs_diff(old_lines: JsValue, new_lines: JsValue) -> JsValue {
    let old: Vec<String> = match serde_wasm_bindgen::from_value(old_lines) {
        Ok(v) => v,
        Err(_) => return serde_wasm_bindgen::to_value(&Vec::<DiffLineOp>::new()).unwrap(),
    };
    let new: Vec<String> = match serde_wasm_bindgen::from_value(new_lines) {
        Ok(v) => v,
        Err(_) => return serde_wasm_bindgen::to_value(&Vec::<DiffLineOp>::new()).unwrap(),
    };

    let ops = compute_lcs_diff_inner(&old, &new);
    serde_wasm_bindgen::to_value(&ops).unwrap()
}

fn compute_lcs_diff_inner(old_lines: &[String], new_lines: &[String]) -> Vec<DiffLineOp> {
    let n = old_lines.len();
    let m = new_lines.len();
    let mut result = Vec::new();

    let mut start = 0usize;
    while start < n && start < m && old_lines[start] == new_lines[start] {
        start += 1;
    }

    let mut old_end = n as isize - 1;
    let mut new_end = m as isize - 1;
    while old_end >= start as isize
        && new_end >= start as isize
        && old_lines[old_end as usize] == new_lines[new_end as usize]
    {
        old_end -= 1;
        new_end -= 1;
    }

    for i in 0..start {
        result.push(DiffLineOp {
            op_type: "equal",
            old_idx: Some(i),
            new_idx: Some(i),
        });
    }

    let old_mid_end = if old_end < start as isize {
        start
    } else {
        (old_end + 1) as usize
    };
    let new_mid_end = if new_end < start as isize {
        start
    } else {
        (new_end + 1) as usize
    };
    let trimmed_old = &old_lines[start..old_mid_end];
    let trimmed_new = &new_lines[start..new_mid_end];
    let trim_n = trimmed_old.len();
    let trim_m = trimmed_new.len();

    if trim_n > 0 || trim_m > 0 {
        if trim_n.saturating_mul(trim_m) > 25_000_000 {
            for i in 0..trim_n {
                result.push(DiffLineOp {
                    op_type: "delete",
                    old_idx: Some(start + i),
                    new_idx: None,
                });
            }
            for j in 0..trim_m {
                result.push(DiffLineOp {
                    op_type: "insert",
                    old_idx: None,
                    new_idx: Some(start + j),
                });
            }
        } else {
            let diff_ops = capture_diff_slices(Algorithm::Lcs, trimmed_old, trimmed_new);
            expand_diff_ops(&diff_ops, start, &mut result);
        }
    }

    let mut i = (old_end + 1) as usize;
    let mut j = (new_end + 1) as usize;
    while i < n && j < m {
        result.push(DiffLineOp {
            op_type: "equal",
            old_idx: Some(i),
            new_idx: Some(j),
        });
        i += 1;
        j += 1;
    }

    result
}

fn expand_diff_ops(ops: &[DiffOp], offset: usize, out: &mut Vec<DiffLineOp>) {
    for op in ops {
        match *op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for k in 0..len {
                    out.push(DiffLineOp {
                        op_type: "equal",
                        old_idx: Some(offset + old_index + k),
                        new_idx: Some(offset + new_index + k),
                    });
                }
            }
            DiffOp::Delete {
                old_index,
                old_len,
                ..
            } => {
                for k in 0..old_len {
                    out.push(DiffLineOp {
                        op_type: "delete",
                        old_idx: Some(offset + old_index + k),
                        new_idx: None,
                    });
                }
            }
            DiffOp::Insert {
                new_index,
                new_len,
                ..
            } => {
                for k in 0..new_len {
                    out.push(DiffLineOp {
                        op_type: "insert",
                        old_idx: None,
                        new_idx: Some(offset + new_index + k),
                    });
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                for k in 0..old_len {
                    out.push(DiffLineOp {
                        op_type: "delete",
                        old_idx: Some(offset + old_index + k),
                        new_idx: None,
                    });
                }
                for k in 0..new_len {
                    out.push(DiffLineOp {
                        op_type: "insert",
                        old_idx: None,
                        new_idx: Some(offset + new_index + k),
                    });
                }
            }
        }
    }
}

// 噪声上限随关键词长度缩放：每 NOISE_CHARS_PER_UNIT 个字符允许 1 个噪声字符，且不超过用户设置值。
// 例：2 字词最多隔 1 个字，4 字词最多隔 2 个字；> 25 字的长句仍要求完全连续。
const NOISE_CHARS_PER_UNIT: usize = 2;

#[inline]
fn effective_noise(kw_len: usize, noise_level: usize) -> usize {
    if kw_len > 25 {
        0
    } else {
        noise_level.min(kw_len / NOISE_CHARS_PER_UNIT)
    }
}

// 硬边界：匹配开始后遇到换行或句末标点就终止，不允许跨行/跨句凑出一个"命中"。
// 关键词本身包含这些字符时，字符相等的判断在前，不受影响。
#[inline]
fn is_hard_break(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '。' | '！' | '？' | '；' | '!' | '?' | ';')
}

#[inline]
fn try_match_at<F: Fn(usize) -> char>(
    at: &F,
    len: usize,
    i: usize,
    kw: &[char],
    eff_noise: usize,
) -> Option<(usize, usize)> {
    let kw_len = kw.len();
    let mut k_idx = 0usize;
    let mut j = i;
    let mut current_gap = 0usize;
    let mut total_noise = 0usize;
    let mut last = i;

    while j < len && k_idx < kw_len {
        let ch = at(j);
        if ch.to_ascii_lowercase() == kw[k_idx] {
            k_idx += 1;
            current_gap = 0;
            last = j;
        } else if k_idx > 0 && is_hard_break(ch) {
            break;
        } else if !ch.is_whitespace() {
            current_gap += 1;
            total_noise += 1;
            if current_gap > eff_noise {
                break;
            }
        }
        j += 1;
        if k_idx == kw_len {
            break;
        }
    }

    if k_idx == kw_len {
        Some((last, total_noise))
    } else {
        None
    }
}

fn fill_chars(buf: &mut Vec<(usize, usize, char)>, text: &str) {
    buf.clear();
    buf.extend(text.char_indices().map(|(b, c)| (b, c.len_utf8(), c)));
}

fn normalize_keywords(keywords: &[String]) -> Vec<Vec<char>> {
    keywords
        .iter()
        .map(|k| {
            k.chars()
                .filter(|c| !c.is_whitespace())
                .map(|c| c.to_ascii_lowercase())
                .collect::<Vec<char>>()
        })
        .filter(|v| !v.is_empty())
        .collect()
}

fn parse_keywords(val: JsValue) -> Vec<Vec<char>> {
    let keywords: Vec<String> = serde_wasm_bindgen::from_value(val).unwrap_or_default();
    normalize_keywords(&keywords)
}

fn get_multi_matches(
    text_chars: &[(usize, usize, char)],
    keywords: &[Vec<char>],
    noise_level: usize,
) -> Vec<(usize, usize, usize)> {
    let mut all_hits: Vec<(usize, usize, usize)> = Vec::new();
    let text_len = text_chars.len();
    let at = |j: usize| text_chars[j].2;

    for kw_chars in keywords {
        let kw_len = kw_chars.len();
        if kw_len == 0 {
            continue;
        }
        let eff_noise = effective_noise(kw_len, noise_level);
        let first = kw_chars[0];

        let mut i = 0usize;
        while i < text_len {
            if text_chars[i].2.to_ascii_lowercase() != first {
                i += 1;
                continue;
            }
            if let Some((last, noise)) = try_match_at(&at, text_len, i, kw_chars, eff_noise) {
                let start_byte = text_chars[i].0;
                let end_byte = text_chars[last].0 + text_chars[last].1;
                all_hits.push((start_byte, end_byte, noise));
            }
            i += 1;
        }
    }

    all_hits.sort_by_key(|h| h.0);
    let mut merged = Vec::<(usize, usize, usize)>::new();
    for hit in all_hits {
        if let Some(last) = merged.last_mut() {
            if hit.0 < last.1 {
                let last_len = last.1 - last.0;
                let hit_len = hit.1 - hit.0;
                if hit.2 < last.2 || (hit.2 == last.2 && hit_len < last_len) {
                    *last = hit;
                }
                continue;
            }
        }
        merged.push(hit);
    }
    merged
}

fn has_any_match(chars: &[char], keywords: &[Vec<char>], noise_level: usize) -> bool {
    let len = chars.len();
    let at = |j: usize| chars[j];
    for kw in keywords {
        let kw_len = kw.len();
        if kw_len == 0 {
            continue;
        }
        let eff_noise = effective_noise(kw_len, noise_level);
        let first = kw[0];
        for i in 0..len {
            if chars[i].to_ascii_lowercase() != first {
                continue;
            }
            if try_match_at(&at, len, i, kw, eff_noise).is_some() {
                return true;
            }
        }
    }
    false
}

const TITLE_HIT_SCORE: usize = 5000;
const TITLE_NOISE_STEP: usize = 500;
const CONTENT_HIT_SCORE: usize = 100;
const CONTENT_NOISE_STEP: usize = 10;

// 每个命中的得分 = base − 噪声惩罚，惩罚封顶 90%：精确命中一定排在模糊命中前面，且任何命中得分都为正
fn weigh_hits(hits: &[(usize, usize, usize)], base: usize, step: usize) -> usize {
    let max_penalty = base - base / 10;
    hits.iter()
        .map(|h| base - (h.2 * step).min(max_penalty))
        .sum::<usize>()
}

fn scan_docs<'a>(
    pool: &'a [String],
    kws: &[Vec<char>],
    noise: usize,
    from_doc: usize,
    to_doc: usize,
) -> Vec<SearchResult<'a>> {
    let mut results: Vec<SearchResult<'a>> = Vec::new();
    let mut title_buf: Vec<(usize, usize, char)> = Vec::new();
    let mut content_buf: Vec<(usize, usize, char)> = Vec::new();

    let doc_total = pool.len() / 4;
    let end_doc = if to_doc < doc_total { to_doc } else { doc_total };
    let mut d = from_doc;

    while d < end_doc {
        let i = d * 4;
        d += 1;

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = &pool[i + 3];

        // 标题用构建阶段已处理好的 pool[i]（html 已去掉 .html 后缀），
        // 不再从 path 截取，否则搜 "ht"/"html" 会命中所有 html 文档的标题
        let title = pool[i].as_str();

        let mut is_local_only = false;
        let searchable_content: &str = if raw_content.starts_with("localOnly") {
            is_local_only = true;
            &raw_content[9..]
        } else {
            raw_content.as_str()
        };

        fill_chars(&mut title_buf, title);
        let title_m = get_multi_matches(&title_buf, kws, noise);

        fill_chars(&mut content_buf, searchable_content);
        let content_m = get_multi_matches(&content_buf, kws, noise);

        let mut count = title_m.len() + content_m.len();
        let score = weigh_hits(&title_m, TITLE_HIT_SCORE, TITLE_NOISE_STEP)
            + weigh_hits(&content_m, CONTENT_HIT_SCORE, CONTENT_NOISE_STEP);

        if count == 0 && res_type.as_str() != "html" && res_type.as_str() != "image" {
            fill_chars(&mut title_buf, path);
            count = get_multi_matches(&title_buf, kws, noise).len();
        }

        if count == 0 {
            continue;
        }

        results.push(SearchResult {
            title,
            count,
            score,
            res_type: res_type.as_str(),
            path: path.as_str(),
            local_only: is_local_only,
            via_comment: false,
        });
    }
    results
}

#[wasm_bindgen]
pub fn doc_count() -> usize {
    GLOBAL_DATA.with(|d| d.borrow().len() / 4)
}

#[wasm_bindgen]
pub fn search_multi_range(
    keywords_val: JsValue,
    noise_level: usize,
    from_doc: usize,
    to_doc: usize,
) -> JsValue {
    let kws = parse_keywords(keywords_val);
    if kws.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
    }

    GLOBAL_DATA.with(|data| {
        let pool = data.borrow();
        let results = scan_docs(&pool, &kws, noise_level, from_doc, to_doc);
        serde_wasm_bindgen::to_value(&results).unwrap()
    })
}

// ---------------------------------------------------------------------------
// 组合搜索（@[表达式]词[]…）：文档级布尔表达式（且 / 或 / 非）
//   - plan = { terms, expr }：terms 是词条表（每个词条自带 noise 和已由主线程展开好的近义关键词），
//     expr 是引用词条的表达式树：{op:"term",term,neg} | {op:"and",args} | {op:"or",args}
//   - 一个词条"命中"某文档 = 标题 / 正文 / 路径（仅非 html、非图片）中出现；
//     正向词条（neg=false）还可以由该文档的任一条评论满足，排除项（neg=true）不看评论
//   - 粒度是"同一文档内"，不要求同句同段
//   - 逐文档惰性求值并备忘：且 / 或 都短路，且的子项里更严的正向词条排前、排除项排最后；
//     判定只要布尔结果（has_match_chars 命中即返回），只对入选的文档再算分
//   - 表达式在"什么都不含的空文档"上成立时拒绝执行（只有排除项会匹配几乎全库）
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct AdsTermIn {
    #[serde(default)]
    noise: usize,
    #[serde(default)]
    keywords: Vec<String>,
}

#[derive(Deserialize)]
struct AdsNodeIn {
    #[serde(default)]
    op: String,
    #[serde(default)]
    term: usize,
    #[serde(default)]
    neg: bool,
    #[serde(default)]
    args: Vec<AdsNodeIn>,
}

#[derive(Deserialize)]
struct AdsPlanIn {
    #[serde(default)]
    terms: Vec<AdsTermIn>,
    expr: AdsNodeIn,
}

struct AdsTerm {
    noise: usize,
    kws: Vec<Vec<char>>,
}

enum AdsNode {
    Term { idx: usize, neg: bool },
    And(Vec<AdsNode>),
    Or(Vec<AdsNode>),
}

struct AdsPlan {
    terms: Vec<AdsTerm>,
    expr: AdsNode,
    // 以正向（非 neg）形式出现的词条下标，用于入选后算分
    positives: Vec<usize>,
}

fn build_ads_node(n: &AdsNodeIn, term_count: usize) -> Option<AdsNode> {
    match n.op.as_str() {
        "term" => {
            if n.term < term_count {
                Some(AdsNode::Term {
                    idx: n.term,
                    neg: n.neg,
                })
            } else {
                None
            }
        }
        "and" | "or" => {
            if n.args.is_empty() {
                return None;
            }
            let mut v: Vec<AdsNode> = Vec::with_capacity(n.args.len());
            for a in &n.args {
                v.push(build_ads_node(a, term_count)?);
            }
            if n.op == "and" {
                Some(AdsNode::And(v))
            } else {
                Some(AdsNode::Or(v))
            }
        }
        _ => None,
    }
}

// 空文档（所有词条都未命中）上表达式是否成立
fn ads_holds_on_empty(n: &AdsNode) -> bool {
    match n {
        AdsNode::Term { neg, .. } => *neg,
        AdsNode::And(v) => v.iter().all(ads_holds_on_empty),
        AdsNode::Or(v) => v.iter().any(ads_holds_on_empty),
    }
}

// "且"的子项求值顺序：正向词条（噪声小、主关键词长的先判）→ 括号 / 或 → 排除项
fn ads_rank(n: &AdsNode, terms: &[AdsTerm]) -> (u8, usize, usize) {
    match n {
        AdsNode::Term { idx, neg } => {
            let t = &terms[*idx];
            (
                if *neg { 2 } else { 0 },
                t.noise,
                usize::MAX - t.kws[0].len(),
            )
        }
        _ => (1, 0, 0),
    }
}

fn ads_optimize(n: &mut AdsNode, terms: &[AdsTerm]) {
    match n {
        AdsNode::And(v) => {
            for c in v.iter_mut() {
                ads_optimize(c, terms);
            }
            v.sort_by_key(|c| ads_rank(c, terms));
        }
        AdsNode::Or(v) => {
            for c in v.iter_mut() {
                ads_optimize(c, terms);
            }
        }
        AdsNode::Term { .. } => {}
    }
}

fn ads_collect_positives(n: &AdsNode, out: &mut Vec<usize>) {
    match n {
        AdsNode::Term { idx, neg } => {
            if !*neg {
                out.push(*idx);
            }
        }
        AdsNode::And(v) | AdsNode::Or(v) => {
            for c in v {
                ads_collect_positives(c, out);
            }
        }
    }
}

// 任一词条没有可用关键词、表达式不合法、或空文档上成立时返回 None（调用方据此返回空结果，
// 绝不能悄悄丢掉一个约束而放大结果集）
fn parse_ads_plan(val: JsValue) -> Option<AdsPlan> {
    let raw: AdsPlanIn = serde_wasm_bindgen::from_value(val).ok()?;
    let mut terms: Vec<AdsTerm> = Vec::with_capacity(raw.terms.len());
    for t in raw.terms {
        let kws = normalize_keywords(&t.keywords);
        if kws.is_empty() {
            return None;
        }
        terms.push(AdsTerm {
            noise: t.noise,
            kws,
        });
    }
    let mut expr = build_ads_node(&raw.expr, terms.len())?;
    if ads_holds_on_empty(&expr) {
        return None;
    }
    ads_optimize(&mut expr, &terms);
    let mut positives: Vec<usize> = Vec::new();
    ads_collect_positives(&expr, &mut positives);
    // 同一个词条可以在表达式里出现多次（如 (a&b)|(!a&c)），算分时每个词条只算一次
    positives.sort_unstable();
    positives.dedup();
    Some(AdsPlan {
        terms,
        expr,
        positives,
    })
}

// 与 has_any_match 同语义，但直接吃 fill_chars 的缓冲，避免为"判定"再转一份 Vec<char>
fn has_match_chars(
    chars: &[(usize, usize, char)],
    keywords: &[Vec<char>],
    noise_level: usize,
) -> bool {
    let len = chars.len();
    if len == 0 {
        return false;
    }
    let at = |j: usize| chars[j].2;
    for kw in keywords {
        let kw_len = kw.len();
        if kw_len == 0 {
            continue;
        }
        let eff_noise = effective_noise(kw_len, noise_level);
        let first = kw[0];
        for i in 0..len {
            if chars[i].2.to_ascii_lowercase() != first {
                continue;
            }
            if try_match_at(&at, len, i, kw, eff_noise).is_some() {
                return true;
            }
        }
    }
    false
}

// 扫描期间复用的缓冲和逐文档备忘（0 = 未算，1 = 否，2 = 是）
struct AdsScratch {
    title_buf: Vec<(usize, usize, char)>,
    content_buf: Vec<(usize, usize, char)>,
    path_buf: Vec<(usize, usize, char)>,
    cm_buf: Vec<(usize, usize, char)>,
    body: Vec<u8>, // 标题 / 正文 / 路径 是否命中
    cmt: Vec<u8>,  // 评论是否命中
}

struct AdsDoc<'a> {
    path: &'a str,
    path_searchable: bool,
    path_ready: bool,
    comments: Option<&'a CommentDoc>,
    // 求值过程中是否有正向词条是"只靠评论"才命中的
    comment_used: bool,
}

fn ads_term_hit(
    idx: usize,
    use_comments: bool,
    terms: &[AdsTerm],
    s: &mut AdsScratch,
    doc: &mut AdsDoc,
) -> bool {
    let term = &terms[idx];
    if s.body[idx] == 0 {
        let mut hit = has_match_chars(&s.title_buf, &term.kws, term.noise)
            || has_match_chars(&s.content_buf, &term.kws, term.noise);
        // 与普通搜索一致：html / 图片只看标题和正文，其余媒体类型还看路径
        if !hit && doc.path_searchable {
            if !doc.path_ready {
                fill_chars(&mut s.path_buf, doc.path);
                doc.path_ready = true;
            }
            hit = has_match_chars(&s.path_buf, &term.kws, term.noise);
        }
        s.body[idx] = if hit { 2 } else { 1 };
    }
    if s.body[idx] == 2 {
        return true;
    }
    if !use_comments {
        return false;
    }
    if s.cmt[idx] == 0 {
        let mut hit = false;
        if let Some(cd) = doc.comments {
            for t in cd.texts.iter() {
                if t.is_empty() {
                    continue;
                }
                fill_chars(&mut s.cm_buf, t);
                if has_match_chars(&s.cm_buf, &term.kws, term.noise) {
                    hit = true;
                    break;
                }
            }
        }
        s.cmt[idx] = if hit { 2 } else { 1 };
    }
    if s.cmt[idx] == 2 {
        doc.comment_used = true;
        return true;
    }
    false
}

// use_comments 只对正向词条生效；排除项永远只看标题 / 正文 / 路径
fn ads_eval(
    n: &AdsNode,
    use_comments: bool,
    terms: &[AdsTerm],
    s: &mut AdsScratch,
    doc: &mut AdsDoc,
) -> bool {
    match n {
        AdsNode::Term { idx, neg } => {
            if *neg {
                !ads_term_hit(*idx, false, terms, s, doc)
            } else {
                ads_term_hit(*idx, use_comments, terms, s, doc)
            }
        }
        AdsNode::And(v) => {
            for c in v {
                if !ads_eval(c, use_comments, terms, s, doc) {
                    return false;
                }
            }
            true
        }
        AdsNode::Or(v) => {
            for c in v {
                if ads_eval(c, use_comments, terms, s, doc) {
                    return true;
                }
            }
            false
        }
    }
}

fn scan_docs_ads<'a>(
    pool: &'a [String],
    comments: &[CommentDoc],
    comment_index: &HashMap<String, usize>,
    plan: &AdsPlan,
    from_doc: usize,
    to_doc: usize,
) -> Vec<SearchResult<'a>> {
    let mut results: Vec<SearchResult<'a>> = Vec::new();
    let term_count = plan.terms.len();
    let mut s = AdsScratch {
        title_buf: Vec::new(),
        content_buf: Vec::new(),
        path_buf: Vec::new(),
        cm_buf: Vec::new(),
        body: vec![0u8; term_count],
        cmt: vec![0u8; term_count],
    };

    let doc_total = pool.len() / 4;
    let end_doc = if to_doc < doc_total { to_doc } else { doc_total };
    let mut d = from_doc;

    while d < end_doc {
        let i = d * 4;
        d += 1;

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = pool[i + 3].as_str();
        let title = pool[i].as_str();

        let mut is_local_only = false;
        let searchable_content: &str = if raw_content.starts_with("localOnly") {
            is_local_only = true;
            &raw_content[9..]
        } else {
            raw_content.as_str()
        };

        fill_chars(&mut s.title_buf, title);
        fill_chars(&mut s.content_buf, searchable_content);
        for x in s.body.iter_mut() {
            *x = 0;
        }
        for x in s.cmt.iter_mut() {
            *x = 0;
        }

        let mut doc = AdsDoc {
            path: path.as_str(),
            path_searchable: res_type != "html" && res_type != "image",
            path_ready: false,
            comments: comment_index
                .get(path.as_str())
                .and_then(|&ci| comments.get(ci)),
            comment_used: false,
        };

        if !ads_eval(&plan.expr, true, &plan.terms, &mut s, &mut doc) {
            continue;
        }
        // 只有求值时真的用到了"只靠评论命中"的词条，才需要复核：
        // 不看评论时仍成立 → 不算 viaComment；不成立 → 这篇文档是靠评论才入选的
        let via_comment =
            doc.comment_used && !ads_eval(&plan.expr, false, &plan.terms, &mut s, &mut doc);

        // 只对入选的文档算分：各正向词条的标题 / 正文得分之和；
        // 没命中标题 / 正文、但靠路径或评论命中的词条给一份保底分；没命中的（"或"的其它分支）不计分
        let mut count = 0usize;
        let mut score = 0usize;
        for &idx in &plan.positives {
            let term = &plan.terms[idx];
            let tm = get_multi_matches(&s.title_buf, &term.kws, term.noise);
            let cm = get_multi_matches(&s.content_buf, &term.kws, term.noise);
            if tm.is_empty() && cm.is_empty() {
                if ads_term_hit(idx, true, &plan.terms, &mut s, &mut doc) {
                    score += CONTENT_HIT_SCORE;
                }
            } else {
                count += tm.len() + cm.len();
                score += weigh_hits(&tm, TITLE_HIT_SCORE, TITLE_NOISE_STEP)
                    + weigh_hits(&cm, CONTENT_HIT_SCORE, CONTENT_NOISE_STEP);
            }
        }

        results.push(SearchResult {
            title,
            count,
            score,
            res_type,
            path: path.as_str(),
            local_only: is_local_only,
            via_comment,
        });
    }
    results
}

// plan: { terms: [{ noise, keywords[] }], expr: 表达式树 }，见上方说明
#[wasm_bindgen]
pub fn search_ads_range(plan_val: JsValue, from_doc: usize, to_doc: usize) -> JsValue {
    let plan = match parse_ads_plan(plan_val) {
        Some(p) => p,
        None => return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap(),
    };

    GLOBAL_DATA.with(|data| {
        COMMENTS.with(|c| {
            COMMENT_INDEX.with(|m| {
                let pool = data.borrow();
                let docs = c.borrow();
                let index = m.borrow();
                let results = scan_docs_ads(&pool, &docs, &index, &plan, from_doc, to_doc);
                serde_wasm_bindgen::to_value(&results).unwrap()
            })
        })
    })
}

#[wasm_bindgen]
pub fn set_comments(val: JsValue) {
    let docs: Vec<CommentDoc> = serde_wasm_bindgen::from_value(val).unwrap_or_default();
    let mut index: HashMap<String, usize> = HashMap::with_capacity(docs.len());
    for (i, d) in docs.iter().enumerate() {
        index.insert(d.path.clone(), i);
    }
    COMMENTS.with(|c| {
        *c.borrow_mut() = docs;
    });
    COMMENT_INDEX.with(|m| {
        *m.borrow_mut() = index;
    });
}

#[derive(Serialize)]
struct CommentHit<'a> {
    path: &'a str,
    count: usize,
}

#[wasm_bindgen]
pub fn search_comments(keywords_val: JsValue, noise_level: usize) -> JsValue {
    let kws = parse_keywords(keywords_val);
    if kws.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<CommentHit>::new()).unwrap();
    }

    COMMENTS.with(|c| {
        let docs = c.borrow();
        let mut buf: Vec<char> = Vec::new();
        let mut hits: Vec<CommentHit> = Vec::new();

        for d in docs.iter() {
            let mut n = 0usize;
            for t in d.texts.iter() {
                if t.is_empty() {
                    continue;
                }
                buf.clear();
                buf.extend(t.chars());
                if has_any_match(&buf, &kws, noise_level) {
                    n += 1;
                }
            }
            if n > 0 {
                hits.push(CommentHit {
                    path: d.path.as_str(),
                    count: n,
                });
            }
        }

        hits.sort_by(|a, b| b.count.cmp(&a.count).then(a.path.cmp(&b.path)));
        serde_wasm_bindgen::to_value(&hits).unwrap()
    })
}

const SNIP_BEFORE: usize = 20;
const SNIP_AFTER: usize = 40;
const SNIP_MAX_CHARS: usize = 140;

#[derive(Serialize)]
pub struct SnipOut {
    pub t: String,
    pub h: Vec<[u32; 3]>,
    pub n: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<u32>,
}

#[derive(Serialize, Default)]
pub struct SnipSection {
    pub hits: usize,
    pub docs: usize,
    pub more: usize,
    pub items: Vec<SnipOut>,
}

#[derive(Serialize)]
pub struct SnippetsOut {
    pub body: SnipSection,
    pub comments: SnipSection,
}

struct SnipGroup {
    ws: usize,
    we: usize,
    hits: Vec<(usize, usize, usize)>,
}

fn build_snippets(text: &str, hits: &[(usize, usize, usize)], comment: Option<u32>) -> Vec<SnipOut> {
    let mut groups: Vec<SnipGroup> = Vec::new();

    for &(start, end, noise) in hits {
        let ws = text[..start]
            .char_indices()
            .rev()
            .nth(SNIP_BEFORE)
            .map(|(i, _)| i)
            .unwrap_or(0);
        let we = text[end..]
            .char_indices()
            .nth(SNIP_AFTER)
            .map(|(i, _)| end + i)
            .unwrap_or(text.len());

        let merge = match groups.last() {
            Some(g) if ws <= g.we => {
                let new_we = if we > g.we { we } else { g.we };
                text[g.ws..new_we].chars().take(SNIP_MAX_CHARS + 1).count() <= SNIP_MAX_CHARS
            }
            _ => false,
        };

        if merge {
            if let Some(g) = groups.last_mut() {
                if we > g.we {
                    g.we = we;
                }
                g.hits.push((start, end, noise));
            }
        } else {
            groups.push(SnipGroup {
                ws,
                we,
                hits: vec![(start, end, noise)],
            });
        }
    }

    let mut out: Vec<SnipOut> = Vec::with_capacity(groups.len());
    for g in groups {
        let prefix = g.ws > 0;
        let suffix = g.we < text.len();

        let mut t = String::with_capacity(g.we - g.ws + 6);
        if prefix {
            t.push_str("...");
        }
        t.push_str(&text[g.ws..g.we]);
        if suffix {
            t.push_str("...");
        }

        let base: usize = if prefix { 3 } else { 0 };
        let mut h: Vec<[u32; 3]> = Vec::with_capacity(g.hits.len());
        let mut min_noise = u32::MAX;
        for &(s, e, n) in &g.hits {
            let s16 = base + text[g.ws..s].encode_utf16().count();
            let e16 = s16 + text[s..e].encode_utf16().count();
            h.push([s16 as u32, e16 as u32, n as u32]);
            if (n as u32) < min_noise {
                min_noise = n as u32;
            }
        }

        out.push(SnipOut {
            t,
            h,
            n: min_noise,
            c: comment,
        });
    }
    out
}

fn select_snippets(mut items: Vec<SnipOut>, limit: usize) -> (Vec<SnipOut>, usize) {
    items.sort_by_key(|s| s.n);
    let more = if items.len() > limit { items.len() - limit } else { 0 };
    if more > 0 {
        items.truncate(limit);
    }
    (items, more)
}

#[wasm_bindgen]
pub fn get_snippets(
    path: &str,
    keywords_val: JsValue,
    noise_level: usize,
    max_body: usize,
    max_comments: usize,
) -> JsValue {
    let kws = parse_keywords(keywords_val);
    let mut out = SnippetsOut {
        body: SnipSection::default(),
        comments: SnipSection::default(),
    };
    if kws.is_empty() {
        return serde_wasm_bindgen::to_value(&out).unwrap();
    }
    let key: &str = path.strip_prefix("../").unwrap_or(path);

    let doc_i: Option<usize> = PATH_INDEX.with(|p| p.borrow().get(key).copied());
    if let Some(i) = doc_i {
        GLOBAL_DATA.with(|data| {
            let pool = data.borrow();
            if i + 3 >= pool.len() {
                return;
            }
            let raw = &pool[i + 1];
            let content: &str = if raw.starts_with("localOnly") {
                &raw[9..]
            } else {
                raw.as_str()
            };
            let mut buf: Vec<(usize, usize, char)> = Vec::new();
            fill_chars(&mut buf, content);
            let merged = get_multi_matches(&buf, &kws, noise_level);
            out.body.hits = merged.len();
            if !merged.is_empty() {
                let (items, more) = select_snippets(build_snippets(content, &merged, None), max_body);
                out.body.items = items;
                out.body.more = more;
            }
        });
    }

    let cm_i: Option<usize> = COMMENT_INDEX.with(|m| m.borrow().get(key).copied());
    if let Some(di) = cm_i {
        COMMENTS.with(|c| {
            let docs = c.borrow();
            if let Some(doc) = docs.get(di) {
                let mut all: Vec<SnipOut> = Vec::new();
                let mut buf: Vec<(usize, usize, char)> = Vec::new();
                for (idx, text) in doc.texts.iter().enumerate() {
                    if text.is_empty() {
                        continue;
                    }
                    fill_chars(&mut buf, text);
                    let merged = get_multi_matches(&buf, &kws, noise_level);
                    if merged.is_empty() {
                        continue;
                    }
                    out.comments.docs += 1;
                    out.comments.hits += merged.len();
                    all.extend(build_snippets(text, &merged, Some(idx as u32)));
                }
                let (items, more) = select_snippets(all, max_comments);
                out.comments.items = items;
                out.comments.more = more;
            }
        });
    }

    serde_wasm_bindgen::to_value(&out).unwrap()
}

fn collect_ads_matches(
    buf: &[(usize, usize, char)],
    terms: &[AdsTerm],
) -> Vec<(usize, usize, usize)> {
    let mut all_hits: Vec<(usize, usize, usize)> = Vec::new();
    for term in terms {
        all_hits.extend(get_multi_matches(buf, &term.kws, term.noise));
    }
    all_hits.sort_by_key(|h| h.0);
    let mut merged = Vec::<(usize, usize, usize)>::new();
    for hit in all_hits {
        if let Some(last) = merged.last_mut() {
            if hit.0 < last.1 {
                let last_len = last.1 - last.0;
                let hit_len = hit.1 - hit.0;
                if hit.2 < last.2 || (hit.2 == last.2 && hit_len < last_len) {
                    *last = hit;
                }
                continue;
            }
        }
        merged.push(hit);
    }
    merged
}

#[wasm_bindgen]
pub fn get_ads_snippets(
    path: &str,
    terms_val: JsValue,
    max_body: usize,
    max_comments: usize,
) -> JsValue {
    let raw_terms: Vec<AdsTermIn> = serde_wasm_bindgen::from_value(terms_val).unwrap_or_default();
    let mut terms: Vec<AdsTerm> = Vec::with_capacity(raw_terms.len());
    for t in raw_terms {
        let kws = normalize_keywords(&t.keywords);
        if !kws.is_empty() {
            terms.push(AdsTerm { noise: t.noise, kws });
        }
    }

    let mut out = SnippetsOut {
        body: SnipSection::default(),
        comments: SnipSection::default(),
    };
    if terms.is_empty() {
        return serde_wasm_bindgen::to_value(&out).unwrap();
    }
    let key: &str = path.strip_prefix("../").unwrap_or(path);

    let doc_i: Option<usize> = PATH_INDEX.with(|p| p.borrow().get(key).copied());
    if let Some(i) = doc_i {
        GLOBAL_DATA.with(|data| {
            let pool = data.borrow();
            if i + 3 >= pool.len() {
                return;
            }
            let raw = &pool[i + 1];
            let content: &str = if raw.starts_with("localOnly") {
                &raw[9..]
            } else {
                raw.as_str()
            };
            let mut buf: Vec<(usize, usize, char)> = Vec::new();
            fill_chars(&mut buf, content);
            let merged = collect_ads_matches(&buf, &terms);
            out.body.hits = merged.len();
            if !merged.is_empty() {
                let (items, more) = select_snippets(build_snippets(content, &merged, None), max_body);
                out.body.items = items;
                out.body.more = more;
            }
        });
    }

    let cm_i: Option<usize> = COMMENT_INDEX.with(|m| m.borrow().get(key).copied());
    if let Some(di) = cm_i {
        COMMENTS.with(|c| {
            let docs = c.borrow();
            if let Some(doc) = docs.get(di) {
                let mut all: Vec<SnipOut> = Vec::new();
                let mut buf: Vec<(usize, usize, char)> = Vec::new();
                for (idx, text) in doc.texts.iter().enumerate() {
                    if text.is_empty() {
                        continue;
                    }
                    fill_chars(&mut buf, text);
                    let merged = collect_ads_matches(&buf, &terms);
                    if merged.is_empty() {
                        continue;
                    }
                    out.comments.docs += 1;
                    out.comments.hits += merged.len();
                    all.extend(build_snippets(text, &merged, Some(idx as u32)));
                }
                let (items, more) = select_snippets(all, max_comments);
                out.comments.items = items;
                out.comments.more = more;
            }
        });
    }

    serde_wasm_bindgen::to_value(&out).unwrap()
}

#[wasm_bindgen]
pub fn find_content_matches_multi(global_text: &str, keywords_val: JsValue, noise_level: usize) -> JsValue {
    let kws = parse_keywords(keywords_val);
    let mut raw_match_data: Vec<u32> = Vec::new();

    if !kws.is_empty() && !global_text.is_empty() {
        let mut utf16_mapping = vec![0usize; global_text.len() + 1];
        let mut utf16_len = 0usize;
        for (byte_idx, ch) in global_text.char_indices() {
            utf16_mapping[byte_idx] = utf16_len;
            utf16_len += ch.len_utf16();
        }
        utf16_mapping[global_text.len()] = utf16_len;

        let mut text_chars: Vec<(usize, usize, char)> = Vec::new();
        fill_chars(&mut text_chars, global_text);

        for (start_byte, end_byte, noise) in get_multi_matches(&text_chars, &kws, noise_level) {
            raw_match_data.push(utf16_mapping.get(start_byte).copied().unwrap_or(0) as u32);
            raw_match_data.push(utf16_mapping.get(end_byte).copied().unwrap_or(utf16_len) as u32);
            raw_match_data.push(noise as u32);
        }
    }

    let matches = Uint32Array::new_with_length(raw_match_data.len() as u32);
    matches.copy_from(&raw_match_data);

    let res = Object::new();
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("count"), &JsValue::from_f64((raw_match_data.len() / 3) as f64));
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("matches"), &matches);
    res.into()
}