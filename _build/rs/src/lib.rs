use regex::Regex;
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use lazy_static::lazy_static;
use serde_json::Value;
use similar::{Algorithm, DiffOp, capture_diff_slices};
use js_sys::{Uint32Array, Object};

thread_local! {
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());
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
    pub snippets: Vec<String>,
    #[serde(rename = "isTolerantMatch")]
    pub is_tolerant_match: bool,
}

#[wasm_bindgen]
pub fn find_content_matches(global_text: &str, keyword: &str, noise_level: usize) -> JsValue {
    let kw_chars: Vec<char> = keyword.chars().filter(|c| !c.is_whitespace()).collect();
    let kw_len = kw_chars.len();

    let empty_result = || {
        let res = Object::new();
        let _ = js_sys::Reflect::set(&res, &JsValue::from_str("count"), &JsValue::from_f64(0.0));
        let _ = js_sys::Reflect::set(&res, &JsValue::from_str("matches"), &Uint32Array::new_with_length(0));
        let _ = js_sys::Reflect::set(&res, &JsValue::from_str("snippets"), &serde_wasm_bindgen::to_value(&Vec::<String>::new()).unwrap());
        let _ = js_sys::Reflect::set(&res, &JsValue::from_str("isTolerantMatch"), &JsValue::from_bool(false));
        res.into()
    };

    if kw_len == 0 || global_text.is_empty() {
        return empty_result();
    }

    let effective_noise = if kw_len > 25 { 0 } else { noise_level };

    let mut utf16_mapping = vec![0; global_text.len() + 1];
    let mut utf16_len = 0;
    for (byte_idx, ch) in global_text.char_indices() {
        utf16_mapping[byte_idx] = utf16_len;
        utf16_len += ch.len_utf16();
    }
    utf16_mapping[global_text.len()] = utf16_len;

    let text_chars: Vec<(usize, usize, char)> = global_text.char_indices().map(|(byte_idx, ch)| {
        (byte_idx, ch.len_utf8(), ch)
    }).collect();

    let text_len = text_chars.len();
    let mut raw_match_data = Vec::new();
    let mut raw_hits_for_snippets = Vec::new();
    let mut i = 0;

    while i < text_len {
        let mut k_idx = 0;
        let mut j = i;
        let mut current_gap = 0;
        let mut _total_noise = 0;
        let mut valid_match = false;
        let mut match_start_byte: Option<usize> = None;
        let mut end_byte = text_chars[i].0;

        while j < text_len && k_idx < kw_len {
            let (byte_idx, char_len, ch) = text_chars[j];
            
            if ch == kw_chars[k_idx] {
                if k_idx == 0 {
                    match_start_byte = Some(byte_idx);
                }
                k_idx += 1;
                current_gap = 0;
                end_byte = byte_idx + char_len;
            } else if !ch.is_whitespace() {
                current_gap += 1;
                _total_noise += 1;
                if current_gap > effective_noise {
                    break;
                }
            }
            j += 1;

            if k_idx == kw_len {
                valid_match = true;
                break;
            }
        }

        if valid_match {
            if let Some(start_byte) = match_start_byte {
                if start_byte != end_byte {
                    let utf16_start = utf16_mapping.get(start_byte).copied().unwrap_or(0);
                    let utf16_end = utf16_mapping.get(end_byte).copied().unwrap_or(utf16_len);

                    raw_match_data.push(utf16_start as u32);
                    raw_match_data.push(utf16_end as u32);
                    raw_match_data.push(_total_noise as u32);

                    raw_hits_for_snippets.push((start_byte, end_byte));
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }

    let count = raw_match_data.len() / 3;
    if count == 0 {
        return empty_result();
    }

    let matches_typed_array = Uint32Array::new_with_length(raw_match_data.len() as u32);
    matches_typed_array.copy_from(&raw_match_data);

    let snippets = extract_snippets_optimized(global_text, &raw_hits_for_snippets);

    let res = Object::new();
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("count"), &JsValue::from_f64(count as f64));
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("matches"), &matches_typed_array);
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("snippets"), &serde_wasm_bindgen::to_value(&snippets).unwrap());
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("isTolerantMatch"), &JsValue::from_bool(effective_noise > 0));

    res.into()
}

fn extract_snippets_optimized(text: &str, hits: &[(usize, usize)]) -> Vec<String> {
    const MAX_SNIPPETS: usize = 30;
    let mut snippets = Vec::new();
    let mut last_match_end = 0usize;

    for &(start, end) in hits {
        if start < last_match_end {
            continue;
        }

        let snippet_start = text[..start]
            .char_indices()
            .rev()
            .nth(20)
            .map(|(i, _)| i)
            .unwrap_or(0);

        let snippet_end = text[end..]
            .char_indices()
            .nth(40)
            .map(|(i, _)| end + i)
            .unwrap_or(text.len());

        snippets.push(format!(
            "...{}...",
            &text[snippet_start..snippet_end]
        ));

        last_match_end = end;

        if snippets.len() >= MAX_SNIPPETS {
            // break;
        }
    }

    snippets
}

#[wasm_bindgen]
pub fn search(keyword: &str, noise_level: usize) -> JsValue {
    if keyword.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
    }
    
    let kw_chars: Vec<char> = keyword.chars().filter(|c| !c.is_whitespace()).collect();
    let kw_len = kw_chars.len();
    if kw_len == 0 {
        return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
    }

    let effective_noise = if kw_len > 25 { 0 } else { noise_level };

    GLOBAL_DATA.with(|data| {
        let pool = data.borrow();
        if pool.is_empty() {
            return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
        }

        let mut hits = execute_scan(&pool, &kw_chars, effective_noise, kw_len);

        hits.sort_by(|a, b| {
            b.score.cmp(&a.score)
                .then(b.count.cmp(&a.count))
                .then(a.title.cmp(&b.title)) 
        });

        serde_wasm_bindgen::to_value(&hits).unwrap()
    })
}

fn count_sliding_matches(text: &str, kw_chars: &[char], noise_level: usize) -> (usize, usize, Vec<(usize, usize)>) {
    let kw_len = kw_chars.len();
    if kw_len == 0 || text.is_empty() {
        return (0, 0, vec![]);
    }

    let text_chars: Vec<(usize, usize, char)> = text.char_indices().map(|(byte_idx, ch)| {
        (byte_idx, ch.len_utf8(), ch)
    }).collect();

    let text_len = text_chars.len();
    let mut count = 0;
    let mut raw_hits = Vec::new();
    let mut i = 0;

    while i < text_len {
        let mut k_idx = 0;
        let mut j = i;
        let mut current_gap = 0;
        let mut _total_noise = 0;
        let mut valid_match = false;
        let mut match_start_byte: Option<usize> = None;
        let mut end_byte = text_chars[i].0;

        while j < text_len && k_idx < kw_len {
            let (byte_idx, char_len, ch) = text_chars[j];
            
            if ch == kw_chars[k_idx] {
                if k_idx == 0 {
                    match_start_byte = Some(byte_idx);
                }
                k_idx += 1;
                current_gap = 0;
                end_byte = byte_idx + char_len;
            } else if !ch.is_whitespace() {
                current_gap += 1;
                _total_noise += 1;
                if current_gap > noise_level {
                    break;
                }
            }
            j += 1;

            if k_idx == kw_len {
                valid_match = true;
                break;
            }
        }

        if valid_match {
            if let Some(start_byte) = match_start_byte {
                if start_byte != end_byte {
                    count += 1;
                    raw_hits.push((start_byte, end_byte));
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }

    (count, kw_len, raw_hits)
}

fn execute_scan<'a>(pool: &'a [String], kw_chars: &[char], noise_level: usize, _kw_len: usize) -> Vec<SearchResult<'a>> {
    let mut results = Vec::new();

    for i in (0..pool.len()).step_by(4) {
        if i + 3 >= pool.len() { break; }

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = &pool[i + 3];
        
        let title_start = path.rfind('/').map(|idx| idx + 1).unwrap_or(0);
        let title = &path[title_start..]; 
        
        let mut is_local_only = false;
        let searchable_content = if raw_content.starts_with("localOnly") {
            is_local_only = true;
            &raw_content[9..] 
        } else {
            raw_content
        };

        let mut count = 0;
        let mut score = 0;

        let (title_count, _, _title_hits) = count_sliding_matches(title, kw_chars, noise_level);
        if title_count > 0 {
            count += title_count;
            score += 5000; 
        }

        let (content_count, _, content_hits) = count_sliding_matches(searchable_content, kw_chars, noise_level);
        if content_count > 0 {
            count += content_count;
            score += content_count * 100;
        }

        if count == 0 && res_type != &"html" && res_type != &"image" {
            let (path_count, _, _) = count_sliding_matches(path, kw_chars, noise_level);
            count = path_count;
        }

        if count == 0 { continue; }

        let snippets = if content_count > 0 {
            extract_snippets_optimized(searchable_content, &content_hits)
        } else {
            Vec::new()
        };

        results.push(SearchResult {
            title, count, score,
            res_type, path, local_only: is_local_only, snippets, is_tolerant_match: noise_level > 0,
        });
    }
    results
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

#[wasm_bindgen]
pub fn set_data(data_val: JsValue) {
    let local_vec: Vec<String> = serde_wasm_bindgen::from_value(data_val).unwrap_or_default();
    GLOBAL_DATA.with(|data| {
        *data.borrow_mut() = local_vec;
    });
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

    let mut results: Vec<String> = Vec::new();
    let buckets = [
        ("html", "html/"), ("image", "gallery/"),
        ("video", "video/"), ("audio", "audio/"), ("ebook", "ebook/"),
    ];
    for (bucket, prefix) in buckets.iter() {
        if let Some(root) = lite.get(bucket) {
            flatten_tree_recursive(root, prefix, bucket, &fat, &shadow, is_offline, &mut results);
        }
    }

    serde_wasm_bindgen::to_value(&results).unwrap_or(JsValue::NULL)
}

fn flatten_tree_recursive(node: &Value, prefix: &str, bucket: &str, fat: &Value, shadow: &Value, is_offline: bool, results: &mut Vec<String>) {
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
                flatten_tree_recursive(v, &next_prefix, bucket, fat, shadow, is_offline, results);
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