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

const BLOOM_WORDS: usize = 32768; // 256 KB = 2,097,152 bits
const BLOOM_MASK: u64 = (BLOOM_WORDS as u64 * 64) - 1;
const SYN_HL_BIT: usize = 0x100;

struct CorpusBloom {
    bits: Vec<u64>,
    ready: bool,
}

impl CorpusBloom {
    fn new() -> Self {
        Self {
            bits: Vec::new(),
            ready: false,
        }
    }

    #[inline]
    fn hashes(a: char, b: char) -> (u64, u64) {
        let mut x = ((a as u64) << 32) | (b as u64);
        x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        let h1 = x ^ (x >> 31);
        let h2 = h1.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
        (h1, h2)
    }

    #[inline]
    fn insert_pair(&mut self, a: char, b: char) {
        let (h1, h2) = Self::hashes(a, b);
        for k in 0..4u64 {
            let idx = (h1.wrapping_add(k.wrapping_mul(h2)) & BLOOM_MASK) as usize;
            self.bits[idx >> 6] |= 1u64 << (idx & 63);
        }
    }

    #[inline]
    fn has_pair(&self, a: char, b: char) -> bool {
        let (h1, h2) = Self::hashes(a, b);
        for k in 0..4u64 {
            let idx = (h1.wrapping_add(k.wrapping_mul(h2)) & BLOOM_MASK) as usize;
            if (self.bits[idx >> 6] & (1u64 << (idx & 63))) == 0 {
                return false;
            }
        }
        true
    }

    // 与 try_match_at(eff_noise = 0) 严格对齐：允许中间隔至多 1 个非硬断行空白
    fn feed_text(&mut self, text: &str) {
        let mut prev: Option<char> = None;
        let mut ws_run = 0usize;
        for raw in text.chars() {
            let ch = fold_char(raw);
            if is_hard_break(ch) {
                prev = None;
                ws_run = 0;
            } else if ch.is_whitespace() {
                ws_run += 1;
                if ws_run > 1 {
                    prev = None;
                }
            } else {
                if let Some(p) = prev {
                    self.insert_pair(p, ch);
                }
                prev = Some(ch);
                ws_run = 0;
            }
        }
    }

    fn rebuild(&mut self, pool: &[String]) {
        self.bits.clear();
        self.bits.resize(BLOOM_WORDS, 0);
        let mut i = 0usize;
        while i + 3 < pool.len() {
            self.feed_text(&pool[i]);
            let raw = &pool[i + 1];
            let content = raw.strip_prefix("localOnly").unwrap_or(raw.as_str());
            self.feed_text(content);
            let res_type = pool[i + 3].as_str();
            if res_type != "html" && res_type != "image" {
                self.feed_text(strip_type_root(&pool[i + 2]));
            }
            i += 4;
        }
        self.ready = true;
    }

    fn might_match_exact(&self, chars: &[char]) -> bool {
        if !self.ready || chars.len() < 2 {
            return true;
        }
        for w in chars.windows(2) {
            if !self.has_pair(w[0], w[1]) {
                return false;
            }
        }
        true
    }
}

#[wasm_bindgen]
pub fn supports_weighted_keywords() -> bool {
    true
}

thread_local! {
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());
    static PATH_INDEX: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
    static CORPUS_BLOOM: RefCell<CorpusBloom> = RefCell::new(CorpusBloom::new());
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
    CORPUS_BLOOM.with(|b| {
        b.borrow_mut().rebuild(&local_vec);
    });
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
                            let is_private_flag = info.contains("localOnly");
                            if let Some(fat_info) = fat.get(&id).and_then(|v| v.as_str()) {
                                val1 = fat_info.to_string();
                            }
                            if is_private_flag && !val1.starts_with("localOnly") {
                                val1 = format!("localOnly{}", val1);
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

const NOISE_CHARS_PER_UNIT: usize = 2;

#[inline]
fn effective_noise(kw_len: usize, noise_level: usize) -> usize {
    if kw_len > 25 {
        0
    } else {
        noise_level.min(kw_len / NOISE_CHARS_PER_UNIT)
    }
}

#[inline]
fn is_hard_break(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '。' | '！' | '？' | '；' | '!' | '?' | ';')
}

#[inline]
fn fold_char(c: char) -> char {
    if c.is_ascii() {
        c.to_ascii_lowercase()
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
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
    let mut space_run = 0usize;
    let mut last = i;

    while j < len && k_idx < kw_len {
        let ch = at(j);
        if ch == kw[k_idx] {
            k_idx += 1;
            current_gap = 0;
            space_run = 0;
            last = j;
        } else if k_idx > 0 && is_hard_break(ch) {
            break;
        } else if ch.is_whitespace() {
            space_run += 1;
            if space_run > 1 {
                current_gap += 1;
                total_noise += 1;
                if current_gap > eff_noise {
                    break;
                }
            }
        } else {
            current_gap += 1;
            total_noise += 1;
            if current_gap > eff_noise {
                break;
            }
        }
        j += 1;
    }

    if k_idx == kw_len {
        Some((last, total_noise))
    } else {
        None
    }
}

fn fill_chars(buf: &mut Vec<(usize, usize, char)>, text: &str) {
    buf.clear();
    buf.extend(text.char_indices().map(|(b, c)| (b, c.len_utf8(), fold_char(c))));
}

#[derive(Deserialize)]
#[serde(untagged)]
enum KeywordIn {
    Plain(String),
    Spec {
        text: String,
        #[serde(default)]
        weight: Option<u16>,
        #[serde(rename = "maxNoise", default)]
        max_noise: Option<usize>,
        #[serde(default)]
        tier: Option<u8>,
    },
}

struct CompiledKw {
    chars: Vec<char>,
    weight_pct: u16,
    max_noise: usize,
    tier: u8, // 0 = 原词, 1 = 自定义/1-hop, 2 = 2-hop
}

fn compile_keywords(raw: Vec<KeywordIn>) -> Vec<CompiledKw> {
    let mut out = Vec::with_capacity(raw.len());
    for (idx, item) in raw.into_iter().enumerate() {
        let (text, weight_pct, max_noise, tier) = match item {
            KeywordIn::Plain(s) => {
                if idx == 0 {
                    (s, 100, usize::MAX, 0)
                } else {
                    (s, 70, usize::MAX, 1)
                }
            }
            KeywordIn::Spec {
                text,
                weight,
                max_noise,
                tier,
            } => {
                let default_tier = if idx == 0 { 0 } else { 1 };
                let t = tier.unwrap_or(default_tier);
                let w = weight.unwrap_or(if t == 0 { 100 } else { 70 }).clamp(10, 100);
                (text, w, max_noise.unwrap_or(usize::MAX), t)
            }
        };
        let chars: Vec<char> = text
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(fold_char)
            .collect();
        if !chars.is_empty() {
            out.push(CompiledKw {
                chars,
                weight_pct,
                max_noise,
                tier,
            });
        }
    }
    out
}

fn parse_keywords(val: JsValue) -> Vec<CompiledKw> {
    let raw: Vec<KeywordIn> = serde_wasm_bindgen::from_value(val).unwrap_or_default();
    compile_keywords(raw)
}

fn filter_kws_by_bloom(kws: &[CompiledKw], noise_level: usize, bloom: &CorpusBloom) -> Vec<usize> {
    let mut active = Vec::with_capacity(kws.len());
    for (idx, kw) in kws.iter().enumerate() {
        let eff = effective_noise(kw.chars.len(), noise_level.min(kw.max_noise));
        if eff == 0
            && !kw.chars.iter().any(|&c| is_hard_break(c))
            && !bloom.might_match_exact(&kw.chars)
        {
            continue;
        }
        active.push(idx);
    }
    active
}

// Hit tuple: (start_byte, end_byte, noise, weight_pct, tier)
type TaggedHit = (usize, usize, usize, u16, u8);

fn merge_tagged_hits(mut all_hits: Vec<TaggedHit>) -> Vec<TaggedHit> {
    all_hits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut merged = Vec::<TaggedHit>::new();
    for hit in all_hits {
        if let Some(last) = merged.last_mut() {
            if hit.0 < last.1 {
                let last_len = last.1 - last.0;
                let hit_len = hit.1 - hit.0;
                let better = (hit.2 < last.2)
                    || (hit.2 == last.2 && hit.4 < last.4)
                    || (hit.2 == last.2 && hit.4 == last.4 && hit.3 > last.3)
                    || (hit.2 == last.2
                        && hit.4 == last.4
                        && hit.3 == last.3
                        && hit_len > last_len);
                if better {
                    *last = hit;
                }
                continue;
            }
        }
        merged.push(hit);
    }
    merged
}

#[inline]
fn collect_one_kw(
    text_chars: &[(usize, usize, char)],
    kw: &CompiledKw,
    noise_level: usize,
    out: &mut Vec<TaggedHit>,
) {
    let kw_len = kw.chars.len();
    if kw_len == 0 {
        return;
    }
    let text_len = text_chars.len();
    let at = |j: usize| text_chars[j].2;
    let eff_noise = effective_noise(kw_len, noise_level.min(kw.max_noise));
    let first = kw.chars[0];

    let mut i = 0usize;
    while i < text_len {
        if text_chars[i].2 != first {
            i += 1;
            continue;
        }
        if let Some((last, noise)) = try_match_at(&at, text_len, i, &kw.chars, eff_noise) {
            let start_byte = text_chars[i].0;
            let end_byte = text_chars[last].0 + text_chars[last].1;
            out.push((start_byte, end_byte, noise, kw.weight_pct, kw.tier));
        }
        i += 1;
    }
}

fn collect_multi_matches_tagged(
    text_chars: &[(usize, usize, char)],
    keywords: &[CompiledKw],
    active_indices: Option<&[usize]>,
    noise_level: usize,
    out: &mut Vec<TaggedHit>,
) {
    match active_indices {
        Some(indices) => {
            for &idx in indices {
                collect_one_kw(text_chars, &keywords[idx], noise_level, out);
            }
        }
        None => {
            for kw in keywords {
                collect_one_kw(text_chars, kw, noise_level, out);
            }
        }
    }
}

fn get_multi_matches_tagged(
    text_chars: &[(usize, usize, char)],
    keywords: &[CompiledKw],
    active_indices: Option<&[usize]>,
    noise_level: usize,
) -> Vec<TaggedHit> {
    let mut all_hits: Vec<TaggedHit> = Vec::new();
    collect_multi_matches_tagged(text_chars, keywords, active_indices, noise_level, &mut all_hits);
    merge_tagged_hits(all_hits)
}

#[inline]
fn pack_hl_noise(noise: usize, tier: u8) -> usize {
    noise.min(0xff) | if tier > 0 { SYN_HL_BIT } else { 0 }
}

fn get_multi_matches(
    text_chars: &[(usize, usize, char)],
    keywords: &[CompiledKw],
    noise_level: usize,
) -> Vec<(usize, usize, usize)> {
    get_multi_matches_tagged(text_chars, keywords, None, noise_level)
        .into_iter()
        .map(|(s, e, n, _, t)| (s, e, pack_hl_noise(n, t)))
        .collect()
}

fn has_any_match(chars: &[char], keywords: &[CompiledKw], noise_level: usize) -> bool {
    let len = chars.len();
    let at = |j: usize| chars[j];
    for kw in keywords {
        let kw_len = kw.chars.len();
        if kw_len == 0 {
            continue;
        }
        let eff_noise = effective_noise(kw_len, noise_level.min(kw.max_noise));
        let first = kw.chars[0];
        for i in 0..len {
            if chars[i] != first {
                continue;
            }
            if try_match_at(&at, len, i, &kw.chars, eff_noise).is_some() {
                return true;
            }
        }
    }
    false
}

const TYPE_ROOT_PREFIXES: [&str; 5] = ["html/", "gallery/", "video/", "audio/", "ebook/"];

#[inline]
fn strip_type_root(path: &str) -> &str {
    for &p in TYPE_ROOT_PREFIXES.iter() {
        if let Some(rest) = path.strip_prefix(p) {
            return rest;
        }
    }
    path
}

const TITLE_HIT_SCORE: usize = 5000;
const TITLE_NOISE_STEP: usize = 500;
const CONTENT_HIT_SCORE: usize = 100;
const CONTENT_NOISE_STEP: usize = 10;
const PATH_HIT_SCORE: usize = 50;
const PATH_NOISE_STEP: usize = 5;

fn weigh_hits(hits: &[TaggedHit], base: usize, step: usize) -> usize {
    let max_penalty = base - base / 10;
    hits.iter()
        .map(|h| {
            let raw = base - (h.2 * step).min(max_penalty);
            (raw * (h.3 as usize)) / 100
        })
        .sum::<usize>()
}

fn scan_docs<'a>(
    pool: &'a [String],
    kws: &[CompiledKw],
    active: &[usize],
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
        let title = pool[i].as_str();

        let mut is_local_only = false;
        let searchable_content: &str = if raw_content.starts_with("localOnly") {
            is_local_only = true;
            &raw_content[9..]
        } else {
            raw_content.as_str()
        };

        fill_chars(&mut title_buf, title);
        let title_m = get_multi_matches_tagged(&title_buf, kws, Some(active), noise);

        fill_chars(&mut content_buf, searchable_content);
        let content_m = get_multi_matches_tagged(&content_buf, kws, Some(active), noise);

        let mut count = title_m.len() + content_m.len();
        let mut score = weigh_hits(&title_m, TITLE_HIT_SCORE, TITLE_NOISE_STEP)
            + weigh_hits(&content_m, CONTENT_HIT_SCORE, CONTENT_NOISE_STEP);

        if count == 0 && res_type.as_str() != "html" && res_type.as_str() != "image" {
            fill_chars(&mut title_buf, strip_type_root(path));
            let path_m = get_multi_matches_tagged(&title_buf, kws, Some(active), noise);
            count = path_m.len();
            score = weigh_hits(&path_m, PATH_HIT_SCORE, PATH_NOISE_STEP);
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

    let active = CORPUS_BLOOM.with(|b| filter_kws_by_bloom(&kws, noise_level, &b.borrow()));
    if active.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
    }

    GLOBAL_DATA.with(|data| {
        let pool = data.borrow();
        let results = scan_docs(&pool, &kws, &active, noise_level, from_doc, to_doc);
        serde_wasm_bindgen::to_value(&results).unwrap()
    })
}

#[derive(Deserialize)]
struct AdsTermIn {
    #[serde(default)]
    noise: usize,
    #[serde(default)]
    keywords: Vec<KeywordIn>,
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
    kws: Vec<CompiledKw>,
}

enum AdsNode {
    Term { idx: usize, neg: bool },
    And(Vec<AdsNode>),
    Or(Vec<AdsNode>),
}

struct AdsPlan {
    terms: Vec<AdsTerm>,
    expr: AdsNode,
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

fn ads_holds_on_empty(n: &AdsNode) -> bool {
    match n {
        AdsNode::Term { neg, .. } => *neg,
        AdsNode::And(v) => v.iter().all(ads_holds_on_empty),
        AdsNode::Or(v) => v.iter().any(ads_holds_on_empty),
    }
}

fn ads_rank(n: &AdsNode, terms: &[AdsTerm]) -> (u8, usize, usize) {
    match n {
        AdsNode::Term { idx, neg } => {
            let t = &terms[*idx];
            (
                if *neg { 2 } else { 0 },
                t.noise,
                usize::MAX - t.kws[0].chars.len(),
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

fn parse_ads_plan(val: JsValue) -> Option<AdsPlan> {
    let raw: AdsPlanIn = serde_wasm_bindgen::from_value(val).ok()?;
    let mut terms: Vec<AdsTerm> = Vec::with_capacity(raw.terms.len());
    for t in raw.terms {
        let kws = compile_keywords(t.keywords);
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
    positives.sort_unstable();
    positives.dedup();
    Some(AdsPlan {
        terms,
        expr,
        positives,
    })
}

#[inline]
fn check_one_kw(chars: &[(usize, usize, char)], kw: &CompiledKw, noise_level: usize) -> bool {
    let kw_len = kw.chars.len();
    if kw_len == 0 {
        return false;
    }
    let len = chars.len();
    let at = |j: usize| chars[j].2;
    let eff_noise = effective_noise(kw_len, noise_level.min(kw.max_noise));
    let first = kw.chars[0];
    for i in 0..len {
        if chars[i].2 != first {
            continue;
        }
        if try_match_at(&at, len, i, &kw.chars, eff_noise).is_some() {
            return true;
        }
    }
    false
}

fn has_match_chars(
    chars: &[(usize, usize, char)],
    keywords: &[CompiledKw],
    active_indices: Option<&[usize]>,
    noise_level: usize,
) -> bool {
    if chars.is_empty() {
        return false;
    }
    match active_indices {
        Some(indices) => indices
            .iter()
            .any(|&idx| check_one_kw(chars, &keywords[idx], noise_level)),
        None => keywords
            .iter()
            .any(|kw| check_one_kw(chars, kw, noise_level)),
    }
}

struct AdsScratch {
    title_buf: Vec<(usize, usize, char)>,
    content_buf: Vec<(usize, usize, char)>,
    path_buf: Vec<(usize, usize, char)>,
    cm_buf: Vec<(usize, usize, char)>,
    body: Vec<u8>,
    cmt: Vec<u8>,
}

struct AdsDoc<'a> {
    path: &'a str,
    path_searchable: bool,
    path_ready: bool,
    comments: Option<&'a CommentDoc>,
    comment_used: bool,
}

fn ads_term_hit(
    idx: usize,
    use_comments: bool,
    mark_comment: bool,
    terms: &[AdsTerm],
    active_body: &[Vec<usize>],
    s: &mut AdsScratch,
    doc: &mut AdsDoc,
) -> bool {
    let term = &terms[idx];
    if s.body[idx] == 0 {
        let act = Some(active_body[idx].as_slice());
        let mut hit = has_match_chars(&s.title_buf, &term.kws, act, term.noise)
            || has_match_chars(&s.content_buf, &term.kws, act, term.noise);
        if !hit && doc.path_searchable {
            if !doc.path_ready {
                fill_chars(&mut s.path_buf, strip_type_root(doc.path));
                doc.path_ready = true;
            }
            hit = has_match_chars(&s.path_buf, &term.kws, act, term.noise);
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
                if has_match_chars(&s.cm_buf, &term.kws, None, term.noise) {
                    hit = true;
                    break;
                }
            }
        }
        s.cmt[idx] = if hit { 2 } else { 1 };
    }
    if s.cmt[idx] == 2 {
        if mark_comment {
            doc.comment_used = true;
        }
        return true;
    }
    false
}

fn ads_eval(
    n: &AdsNode,
    use_comments: bool,
    terms: &[AdsTerm],
    active_body: &[Vec<usize>],
    s: &mut AdsScratch,
    doc: &mut AdsDoc,
) -> bool {
    match n {
        AdsNode::Term { idx, neg } => {
            if *neg {
                !ads_term_hit(*idx, use_comments, false, terms, active_body, s, doc)
            } else {
                ads_term_hit(*idx, use_comments, true, terms, active_body, s, doc)
            }
        }
        AdsNode::And(v) => {
            for c in v {
                if !ads_eval(c, use_comments, terms, active_body, s, doc) {
                    return false;
                }
            }
            true
        }
        AdsNode::Or(v) => {
            for c in v {
                if ads_eval(c, use_comments, terms, active_body, s, doc) {
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
    active_body: &[Vec<usize>],
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

        if !ads_eval(&plan.expr, true, &plan.terms, active_body, &mut s, &mut doc) {
            continue;
        }

        let via_comment = doc.comment_used
            && !ads_eval(&plan.expr, false, &plan.terms, active_body, &mut s, &mut doc);

        let mut count = 0usize;
        let mut score = 0usize;
        for &idx in &plan.positives {
            if !ads_term_hit(idx, true, false, &plan.terms, active_body, &mut s, &mut doc) {
                continue;
            }
            let term = &plan.terms[idx];
            let act = Some(active_body[idx].as_slice());
            let tm = get_multi_matches_tagged(&s.title_buf, &term.kws, act, term.noise);
            let cm = get_multi_matches_tagged(&s.content_buf, &term.kws, act, term.noise);
            if !tm.is_empty() || !cm.is_empty() {
                count += tm.len() + cm.len();
                score += weigh_hits(&tm, TITLE_HIT_SCORE, TITLE_NOISE_STEP)
                    + weigh_hits(&cm, CONTENT_HIT_SCORE, CONTENT_NOISE_STEP);
            } else if doc.path_searchable {
                if !doc.path_ready {
                    fill_chars(&mut s.path_buf, strip_type_root(doc.path));
                    doc.path_ready = true;
                }
                let pm = get_multi_matches_tagged(&s.path_buf, &term.kws, act, term.noise);
                if !pm.is_empty() {
                    count += pm.len();
                    score += weigh_hits(&pm, PATH_HIT_SCORE, PATH_NOISE_STEP);
                } else {
                    score += CONTENT_HIT_SCORE;
                }
            } else {
                score += CONTENT_HIT_SCORE;
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

#[wasm_bindgen]
pub fn search_ads_range(plan_val: JsValue, from_doc: usize, to_doc: usize) -> JsValue {
    let plan = match parse_ads_plan(plan_val) {
        Some(p) => p,
        None => return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap(),
    };

    let active_body: Vec<Vec<usize>> = CORPUS_BLOOM.with(|b| {
        let bloom = b.borrow();
        plan.terms
            .iter()
            .map(|t| filter_kws_by_bloom(&t.kws, t.noise, &bloom))
            .collect()
    });

    GLOBAL_DATA.with(|data| {
        COMMENTS.with(|c| {
            COMMENT_INDEX.with(|m| {
                let pool = data.borrow();
                let docs = c.borrow();
                let index = m.borrow();
                let results =
                    scan_docs_ads(&pool, &docs, &index, &plan, &active_body, from_doc, to_doc);
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
                buf.extend(t.chars().map(fold_char));
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
    let more = if items.len() > limit {
        items.len() - limit
    } else {
        0
    };
    if more > 0 {
        items.truncate(limit);
    }
    (items, more)
}

fn extract_snippets_with_terms(
    path: &str,
    terms: &[AdsTerm],
    max_body: usize,
    max_comments: usize,
) -> SnippetsOut {
    let mut out = SnippetsOut {
        body: SnipSection::default(),
        comments: SnipSection::default(),
    };
    if terms.is_empty() {
        return out;
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
            let mut raw_hits: Vec<TaggedHit> = Vec::new();
            for term in terms {
                collect_multi_matches_tagged(&buf, &term.kws, None, term.noise, &mut raw_hits);
            }
            let merged: Vec<(usize, usize, usize)> = merge_tagged_hits(raw_hits)
                .into_iter()
                .map(|(s, e, n, _, t)| (s, e, pack_hl_noise(n, t)))
                .collect();
            out.body.hits = merged.len();
            if !merged.is_empty() {
                let (items, more) =
                    select_snippets(build_snippets(content, &merged, None), max_body);
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
                    let mut raw_hits: Vec<TaggedHit> = Vec::new();
                    for term in terms {
                        collect_multi_matches_tagged(
                            &buf,
                            &term.kws,
                            None,
                            term.noise,
                            &mut raw_hits,
                        );
                    }
                    let merged: Vec<(usize, usize, usize)> = merge_tagged_hits(raw_hits)
                        .into_iter()
                        .map(|(s, e, n, _, t)| (s, e, pack_hl_noise(n, t)))
                        .collect();
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

    out
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
    let terms = if kws.is_empty() {
        Vec::new()
    } else {
        vec![AdsTerm {
            noise: noise_level,
            kws,
        }]
    };
    let out = extract_snippets_with_terms(path, &terms, max_body, max_comments);
    serde_wasm_bindgen::to_value(&out).unwrap()
}

#[wasm_bindgen]
pub fn get_snippets_ads(
    path: &str,
    ads_terms_val: JsValue,
    max_body: usize,
    max_comments: usize,
) -> JsValue {
    let raw_terms: Vec<AdsTermIn> =
        serde_wasm_bindgen::from_value(ads_terms_val).unwrap_or_default();
    let terms: Vec<AdsTerm> = raw_terms
        .into_iter()
        .filter_map(|t| {
            let kws = compile_keywords(t.keywords);
            if kws.is_empty() {
                None
            } else {
                Some(AdsTerm {
                    noise: t.noise,
                    kws,
                })
            }
        })
        .collect();
    let out = extract_snippets_with_terms(path, &terms, max_body, max_comments);
    serde_wasm_bindgen::to_value(&out).unwrap()
}

#[wasm_bindgen]
pub fn find_content_matches_multi(
    global_text: &str,
    keywords_val: JsValue,
    noise_level: usize,
) -> JsValue {
    let kws = parse_keywords(keywords_val);
    let mut raw_match_data: Vec<u32> = Vec::new();

    if !kws.is_empty() && !global_text.is_empty() {
        let mut text_chars: Vec<(usize, usize, char)> = Vec::new();
        fill_chars(&mut text_chars, global_text);

        let matches_list = get_multi_matches(&text_chars, &kws, noise_level);
        raw_match_data.reserve(matches_list.len() * 3);

        let mut cur_byte = 0usize;
        let mut cur_u16 = 0usize;
        for (start_byte, end_byte, noise) in matches_list {
            let start_u16 = if start_byte >= cur_byte {
                cur_u16 + global_text[cur_byte..start_byte].encode_utf16().count()
            } else {
                global_text[..start_byte].encode_utf16().count()
            };
            let end_u16 = start_u16 + global_text[start_byte..end_byte].encode_utf16().count();
            cur_byte = end_byte;
            cur_u16 = end_u16;

            raw_match_data.push(start_u16 as u32);
            raw_match_data.push(end_u16 as u32);
            raw_match_data.push(noise as u32);
        }
    }

    let matches = Uint32Array::new_with_length(raw_match_data.len() as u32);
    matches.copy_from(&raw_match_data);

    let res = Object::new();
    let _ = js_sys::Reflect::set(
        &res,
        &JsValue::from_str("count"),
        &JsValue::from_f64((raw_match_data.len() / 3) as f64),
    );
    let _ = js_sys::Reflect::set(&res, &JsValue::from_str("matches"), &matches);
    res.into()
}
