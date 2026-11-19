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

const CORPUS_BLOOM_WORDS: usize = 131072; // 1 MB = 8,388,608 bits
const COMMENT_BLOOM_WORDS: usize = 32768; // 256 KB = 2,097,152 bits
const SYN_HL_TIER_SHIFT: usize = 8;

struct CorpusBloom {
    bits: Vec<u64>,
    mask: u64,
    words: usize,
    ready: bool,
}

impl CorpusBloom {
    fn new(words: usize) -> Self {
        Self {
            bits: Vec::new(),
            mask: (words as u64 * 64) - 1,
            words,
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
            let idx = (h1.wrapping_add(k.wrapping_mul(h2)) & self.mask) as usize;
            self.bits[idx >> 6] |= 1u64 << (idx & 63);
        }
    }

    #[inline]
    fn has_pair(&self, a: char, b: char) -> bool {
        let (h1, h2) = Self::hashes(a, b);
        for k in 0..4u64 {
            let idx = (h1.wrapping_add(k.wrapping_mul(h2)) & self.mask) as usize;
            if (self.bits[idx >> 6] & (1u64 << (idx & 63))) == 0 {
                return false;
            }
        }
        true
    }

    // 与 try_match_at(eff_noise = 0) 严格对齐：允许中间隔至多 1 个非硬断行空白
    fn feed_chars(&mut self, chars: &[char]) {
        let mut prev: Option<char> = None;
        let mut ws_run = 0usize;
        for &ch in chars {
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

    fn rebuild_from_docs(&mut self, docs: &[IndexedDoc]) {
        self.bits.clear();
        self.bits.resize(self.words, 0);
        for d in docs {
            self.feed_chars(&d.title_chars);
            self.feed_chars(&d.content_chars);
            if !d.path_chars.is_empty() {
                self.feed_chars(&d.path_chars);
            }
        }
        self.ready = true;
    }

    fn rebuild_from_comments(&mut self, docs: &[IndexedCommentDoc]) {
        self.bits.clear();
        self.bits.resize(self.words, 0);
        for d in docs {
            for chars in &d.texts_chars {
                if !chars.is_empty() {
                    self.feed_chars(chars);
                }
            }
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

struct DocFilter {
    uni_bits: Vec<u64>,
    uni_mask: u64,
    bi_bits: Vec<u64>,
    bi_mask: u64,
}

impl DocFilter {
    fn empty() -> Self {
        Self {
            uni_bits: Vec::new(),
            uni_mask: 0,
            bi_bits: Vec::new(),
            bi_mask: 0,
        }
    }

    #[inline]
    fn hash_uni(c: char) -> (u64, u64) {
        let mut x = (c as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        let h1 = x ^ (x >> 27);
        let h2 = h1.wrapping_mul(0x94d0_49bb_1331_11eb) | 1;
        (h1, h2)
    }

    fn from_folded(chars: &[char]) -> Self {
        let n = chars.len();
        if n == 0 {
            return Self::empty();
        }
        let (uni_words, bi_words) = if n <= 64 {
            (4usize, 4usize)
        } else if n <= 512 {
            (16, 16)
        } else if n <= 4096 {
            (32, 64)
        } else {
            (64, 256)
        };
        let mut f = Self {
            uni_bits: vec![0u64; uni_words],
            uni_mask: (uni_words as u64 * 64) - 1,
            bi_bits: vec![0u64; bi_words],
            bi_mask: (bi_words as u64 * 64) - 1,
        };
        let mut prev: Option<char> = None;
        let mut ws_run = 0usize;
        for &ch in chars {
            if is_hard_break(ch) {
                prev = None;
                ws_run = 0;
            } else if ch.is_whitespace() {
                ws_run += 1;
                if ws_run > 1 {
                    prev = None;
                }
            } else {
                let (u1, u2) = Self::hash_uni(ch);
                for k in 0..2u64 {
                    let idx = (u1.wrapping_add(k.wrapping_mul(u2)) & f.uni_mask) as usize;
                    f.uni_bits[idx >> 6] |= 1u64 << (idx & 63);
                }
                if let Some(p) = prev {
                    let (b1, b2) = CorpusBloom::hashes(p, ch);
                    for k in 0..2u64 {
                        let idx = (b1.wrapping_add(k.wrapping_mul(b2)) & f.bi_mask) as usize;
                        f.bi_bits[idx >> 6] |= 1u64 << (idx & 63);
                    }
                }
                prev = Some(ch);
                ws_run = 0;
            }
        }
        f
    }

    #[inline]
    fn might_match(&self, kw_chars: &[char], eff_noise: usize, has_hard_break: bool) -> bool {
        if self.uni_bits.is_empty() || kw_chars.is_empty() {
            return false;
        }
        for &ch in kw_chars {
            if is_hard_break(ch) {
                continue;
            }
            let (u1, u2) = Self::hash_uni(ch);
            for k in 0..2u64 {
                let idx = (u1.wrapping_add(k.wrapping_mul(u2)) & self.uni_mask) as usize;
                if (self.uni_bits[idx >> 6] & (1u64 << (idx & 63))) == 0 {
                    return false;
                }
            }
        }
        if eff_noise == 0 && kw_chars.len() >= 2 && !has_hard_break {
            for w in kw_chars.windows(2) {
                let (b1, b2) = CorpusBloom::hashes(w[0], w[1]);
                for k in 0..2u64 {
                    let idx = (b1.wrapping_add(k.wrapping_mul(b2)) & self.bi_mask) as usize;
                    if (self.bi_bits[idx >> 6] & (1u64 << (idx & 63))) == 0 {
                        return false;
                    }
                }
            }
        }
        true
    }
}

struct IndexedDoc {
    title_chars: Vec<char>,
    content_chars: Vec<char>,
    path_chars: Vec<char>,
    title_filter: DocFilter,
    content_filter: DocFilter,
    path_filter: DocFilter,
    is_local_only: bool,
}

struct IndexedCommentDoc {
    texts_chars: Vec<Vec<char>>,
    filters: Vec<DocFilter>,
}

struct PatternEntry {
    kw_idx: usize,
    eff_noise: usize,
    has_hard_break: bool,
}

struct ScanPlan {
    entries: Vec<PatternEntry>,
    first_mask: [u64; 4],
    by_first: HashMap<char, Vec<usize>>,
}

impl ScanPlan {
    fn build(kws: &[CompiledKw], active: &[usize], noise_level: usize) -> Self {
        let mut entries = Vec::with_capacity(active.len());
        let mut first_mask = [0u64; 4];
        let mut by_first: HashMap<char, Vec<usize>> = HashMap::new();
        for &kw_idx in active {
            let kw = &kws[kw_idx];
            if kw.chars.is_empty() {
                continue;
            }
            let eff_noise = effective_noise(kw.chars.len(), noise_level.min(kw.max_noise));
            let has_hard_break = kw.chars.iter().any(|&c| is_hard_break(c));
            let e_idx = entries.len();
            entries.push(PatternEntry {
                kw_idx,
                eff_noise,
                has_hard_break,
            });
            let first = kw.chars[0];
            let (h, _) = DocFilter::hash_uni(first);
            let bit = (h & 255) as usize;
            first_mask[bit >> 6] |= 1u64 << (bit & 63);
            by_first.entry(first).or_default().push(e_idx);
        }
        Self {
            entries,
            first_mask,
            by_first,
        }
    }

    #[inline]
    fn first_might_hit(&self, ch: char) -> bool {
        let (h, _) = DocFilter::hash_uni(ch);
        let bit = (h & 255) as usize;
        (self.first_mask[bit >> 6] & (1u64 << (bit & 63))) != 0
    }
}

#[wasm_bindgen]
pub fn supports_weighted_keywords() -> bool {
    true
}

#[wasm_bindgen]
pub fn bloom_might_match(text: &str) -> bool {
    let chars: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(fold_char)
        .collect();
    if chars.len() < 2 || chars.iter().any(|&c| is_hard_break(c)) {
        return true;
    }
    CORPUS_BLOOM.with(|cb| {
        let corpus = cb.borrow();
        COMMENT_BLOOM.with(|mb| {
            let comments = mb.borrow();
            if !corpus.ready && !comments.ready {
                return true;
            }
            (corpus.ready && corpus.might_match_exact(&chars))
                || (comments.ready && comments.might_match_exact(&chars))
        })
    })
}

struct PreparedSearch {
    kws: Vec<CompiledKw>,
    plan: ScanPlan,
}

struct PreparedAds {
    plan: AdsPlan,
    body_plans: Vec<ScanPlan>,
    cmt_plans: Vec<ScanPlan>,
}

thread_local! {
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());
    static INDEXED_DOCS: RefCell<Vec<IndexedDoc>> = RefCell::new(Vec::new());
    static PATH_INDEX: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
    static CORPUS_BLOOM: RefCell<CorpusBloom> = RefCell::new(CorpusBloom::new(CORPUS_BLOOM_WORDS));
    static COMMENTS: RefCell<Vec<CommentDoc>> = RefCell::new(Vec::new());
    static INDEXED_COMMENTS: RefCell<Vec<IndexedCommentDoc>> = RefCell::new(Vec::new());
    static COMMENT_INDEX: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
    static COMMENT_BLOOM: RefCell<CorpusBloom> = RefCell::new(CorpusBloom::new(COMMENT_BLOOM_WORDS));
    static PREPARED_SEARCH: RefCell<Option<PreparedSearch>> = RefCell::new(None);
    static PREPARED_ADS: RefCell<Option<PreparedAds>> = RefCell::new(None);
    static PREPARED_COMMENT: RefCell<Option<PreparedSearch>> = RefCell::new(None);
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

#[inline]
fn fold_str_to_chars(s: &str) -> Vec<char> {
    s.chars().map(fold_char).collect()
}

fn install_data(local_vec: Vec<String>) {
    let doc_cap = local_vec.len() / 4;
    let mut index: HashMap<String, usize> = HashMap::with_capacity(doc_cap);
    let mut indexed_docs: Vec<IndexedDoc> = Vec::with_capacity(doc_cap);
    let mut i = 0usize;
    while i + 3 < local_vec.len() {
        let title = &local_vec[i];
        let raw_content = &local_vec[i + 1];
        let path = &local_vec[i + 2];
        let res_type = local_vec[i + 3].as_str();
        index.insert(path.clone(), i);

        let (is_local_only, searchable_content) = match raw_content.strip_prefix("localOnly") {
            Some(rest) => (true, rest),
            None => (false, raw_content.as_str()),
        };

        let title_chars = fold_str_to_chars(title);
        let content_chars = fold_str_to_chars(searchable_content);
        let path_chars = if res_type != "html" && res_type != "image" {
            fold_str_to_chars(strip_type_root(path))
        } else {
            Vec::new()
        };
        let title_filter = DocFilter::from_folded(&title_chars);
        let content_filter = DocFilter::from_folded(&content_chars);
        let path_filter = DocFilter::from_folded(&path_chars);

        indexed_docs.push(IndexedDoc {
            title_chars,
            content_chars,
            path_chars,
            title_filter,
            content_filter,
            path_filter,
            is_local_only,
        });
        i += 4;
    }
    CORPUS_BLOOM.with(|b| {
        b.borrow_mut().rebuild_from_docs(&indexed_docs);
    });
    GLOBAL_DATA.with(|data| {
        *data.borrow_mut() = local_vec;
    });
    INDEXED_DOCS.with(|d| {
        *d.borrow_mut() = indexed_docs;
    });
    PATH_INDEX.with(|p| {
        *p.borrow_mut() = index;
    });
    PREPARED_SEARCH.with(|p| {
        *p.borrow_mut() = None;
    });
    PREPARED_ADS.with(|p| {
        *p.borrow_mut() = None;
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
    let c = match c {
        '\u{3000}' => ' ',
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        _ => c,
    };
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
                // 统一区间裁决优先级：tier(原词 > 1-hop > 双槽) > noise > weight > 覆盖长度
                let better = (hit.4 < last.4)
                    || (hit.4 == last.4 && hit.2 < last.2)
                    || (hit.4 == last.4 && hit.2 == last.2 && hit.3 > last.3)
                    || (hit.4 == last.4
                        && hit.2 == last.2
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
    noise.min(0xff) | ((tier.min(3) as usize) << SYN_HL_TIER_SHIFT)
}

// 供 content.js 使用：低 10 位完全兼容既有高亮样式，高 8 位透传 weight 供 ADS 合并裁决
#[inline]
fn pack_hl_meta(noise: usize, tier: u8, weight: u16) -> usize {
    pack_hl_noise(noise, tier) | (((weight.min(100) as usize) & 0xff) << 16)
}

fn get_multi_matches(
    text_chars: &[(usize, usize, char)],
    keywords: &[CompiledKw],
    noise_level: usize,
) -> Vec<(usize, usize, usize)> {
    get_multi_matches_tagged(text_chars, keywords, None, noise_level)
        .into_iter()
        .map(|(s, e, n, w, t)| (s, e, pack_hl_meta(n, t, w)))
        .collect()
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

// 精确命中优先保底（按最小噪值阶梯奖励） + 合理化 tier>=1 同义词计分封顶 + 次线性词频饱和
const EXACT_DOC_BONUS: usize = 10_000;
const TITLE_SYN_CAP: usize = 4_500;
const CONTENT_SYN_CAP: usize = 450;
const PATH_SYN_CAP: usize = 120;

#[inline]
fn min_opt(a: Option<usize>, b: Option<usize>) -> Option<usize> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

#[inline]
fn tier0_doc_bonus(min_tier0_noise: Option<usize>) -> usize {
    match min_tier0_noise {
        Some(0) => EXACT_DOC_BONUS,
        Some(1) => 3_000,
        Some(2) => 2_200,
        Some(3) => 1_500,
        Some(4) => 900,
        Some(_) => 500,
        None => 0,
    }
}

#[inline]
fn try_match_at_slice(chars: &[char], i: usize, kw: &[char], eff_noise: usize) -> Option<(usize, usize)> {
    let at = |j: usize| chars[j];
    try_match_at(&at, chars.len(), i, kw, eff_noise)
}

fn collect_plan_matches_fast(
    chars: &[char],
    filter: &DocFilter,
    kws: &[CompiledKw],
    plan: &ScanPlan,
    out: &mut Vec<TaggedHit>,
) {
    if chars.is_empty() || plan.entries.is_empty() {
        return;
    }
    let mut mask_u64 = 0u64;
    let mut survivors_vec: Vec<bool> = Vec::new();
    let use_u64 = plan.entries.len() <= 64;
    let mut count = 0usize;
    let mut only_idx = 0usize;

    if !use_u64 {
        survivors_vec.resize(plan.entries.len(), false);
    }
    for (ei, e) in plan.entries.iter().enumerate() {
        if filter.might_match(&kws[e.kw_idx].chars, e.eff_noise, e.has_hard_break) {
            if use_u64 {
                mask_u64 |= 1u64 << ei;
            } else {
                survivors_vec[ei] = true;
            }
            only_idx = ei;
            count += 1;
        }
    }
    if count == 0 {
        return;
    }
    if count == 1 {
        let e = &plan.entries[only_idx];
        let kw = &kws[e.kw_idx];
        let first = kw.chars[0];
        for i in 0..chars.len() {
            if chars[i] != first {
                continue;
            }
            if let Some((last, noise)) = try_match_at_slice(chars, i, &kw.chars, e.eff_noise) {
                out.push((i, last + 1, noise, kw.weight_pct, kw.tier));
            }
        }
        return;
    }
    for i in 0..chars.len() {
        let ch = chars[i];
        if !plan.first_might_hit(ch) {
            continue;
        }
        if let Some(bucket) = plan.by_first.get(&ch) {
            for &ei in bucket {
                let alive = if use_u64 {
                    (mask_u64 & (1u64 << ei)) != 0
                } else {
                    survivors_vec[ei]
                };
                if !alive {
                    continue;
                }
                let e = &plan.entries[ei];
                let kw = &kws[e.kw_idx];
                if let Some((last, noise)) = try_match_at_slice(chars, i, &kw.chars, e.eff_noise) {
                    out.push((i, last + 1, noise, kw.weight_pct, kw.tier));
                }
            }
        }
    }
}

fn has_plan_match_fast(
    chars: &[char],
    filter: &DocFilter,
    kws: &[CompiledKw],
    plan: &ScanPlan,
) -> bool {
    if chars.is_empty() || plan.entries.is_empty() {
        return false;
    }
    for e in &plan.entries {
        let kw = &kws[e.kw_idx];
        if !filter.might_match(&kw.chars, e.eff_noise, e.has_hard_break) {
            continue;
        }
        let first = kw.chars[0];
        for i in 0..chars.len() {
            if chars[i] != first {
                continue;
            }
            if try_match_at_slice(chars, i, &kw.chars, e.eff_noise).is_some() {
                return true;
            }
        }
    }
    false
}

fn weigh_section_hits(
    hits: &[TaggedHit],
    base: usize,
    step: usize,
    syn_cap: usize,
    sat_k: usize,
) -> (usize, Option<usize>) {
    if hits.is_empty() {
        return (0, None);
    }
    let max_penalty = base - base / 10;
    let mut exact_vals: Vec<usize> = Vec::new();
    let mut syn_vals: Vec<usize> = Vec::new();
    let mut min_t0_noise: Option<usize> = None;

    for h in hits {
        let raw = base - (h.2 * step).min(max_penalty);
        let val = (raw * (h.3 as usize)) / 100;
        if h.4 == 0 {
            exact_vals.push(val);
            min_t0_noise = min_opt(min_t0_noise, Some(h.2));
        } else {
            syn_vals.push(val);
        }
    }

    exact_vals.sort_unstable_by(|a, b| b.cmp(a));
    syn_vals.sort_unstable_by(|a, b| b.cmp(a));

    let exact_score: usize = exact_vals
        .iter()
        .enumerate()
        .map(|(idx, &v)| (v * sat_k) / (sat_k + idx))
        .sum();
    let syn_raw: usize = syn_vals
        .iter()
        .enumerate()
        .map(|(idx, &v)| (v * sat_k) / (sat_k + idx))
        .sum();
    let syn_score = syn_raw.min(syn_cap);

    (exact_score + syn_score, min_t0_noise)
}

fn scan_docs<'a>(
    pool: &'a [String],
    indexed: &[IndexedDoc],
    kws: &[CompiledKw],
    scan_plan: &ScanPlan,
    from_doc: usize,
    to_doc: usize,
) -> Vec<SearchResult<'a>> {
    let mut results: Vec<SearchResult<'a>> = Vec::new();
    let mut raw_hits: Vec<TaggedHit> = Vec::new();

    let doc_total = (pool.len() / 4).min(indexed.len());
    let end_doc = if to_doc < doc_total { to_doc } else { doc_total };
    let mut d = from_doc;

    while d < end_doc {
        let i = d * 4;
        let idoc = &indexed[d];
        d += 1;

        raw_hits.clear();
        collect_plan_matches_fast(&idoc.title_chars, &idoc.title_filter, kws, scan_plan, &mut raw_hits);
        let title_m = if raw_hits.is_empty() {
            Vec::new()
        } else {
            merge_tagged_hits(std::mem::take(&mut raw_hits))
        };

        raw_hits.clear();
        collect_plan_matches_fast(&idoc.content_chars, &idoc.content_filter, kws, scan_plan, &mut raw_hits);
        let content_m = if raw_hits.is_empty() {
            Vec::new()
        } else {
            merge_tagged_hits(std::mem::take(&mut raw_hits))
        };

        let mut count = title_m.len() + content_m.len();
        let (ts, t_t0) =
            weigh_section_hits(&title_m, TITLE_HIT_SCORE, TITLE_NOISE_STEP, TITLE_SYN_CAP, 1);
        let (cs, c_t0) = weigh_section_hits(
            &content_m,
            CONTENT_HIT_SCORE,
            CONTENT_NOISE_STEP,
            CONTENT_SYN_CAP,
            4,
        );
        let mut score = ts + cs;
        let mut best_t0 = min_opt(t_t0, c_t0);

        if count == 0 && !idoc.path_chars.is_empty() {
            raw_hits.clear();
            collect_plan_matches_fast(&idoc.path_chars, &idoc.path_filter, kws, scan_plan, &mut raw_hits);
            if !raw_hits.is_empty() {
                let path_m = merge_tagged_hits(std::mem::take(&mut raw_hits));
                count = path_m.len();
                let (ps, p_t0) =
                    weigh_section_hits(&path_m, PATH_HIT_SCORE, PATH_NOISE_STEP, PATH_SYN_CAP, 1);
                score = ps;
                best_t0 = p_t0;
            }
        }

        if count == 0 {
            continue;
        }
        score += tier0_doc_bonus(best_t0);

        results.push(SearchResult {
            title: pool[i].as_str(),
            count,
            score,
            res_type: pool[i + 3].as_str(),
            path: pool[i + 2].as_str(),
            local_only: idoc.is_local_only,
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
pub fn prepare_search(keywords_val: JsValue, noise_level: usize) -> bool {
    let kws = parse_keywords(keywords_val);
    if kws.is_empty() {
        PREPARED_SEARCH.with(|p| *p.borrow_mut() = None);
        return false;
    }
    let active = CORPUS_BLOOM.with(|b| filter_kws_by_bloom(&kws, noise_level, &b.borrow()));
    if active.is_empty() {
        PREPARED_SEARCH.with(|p| *p.borrow_mut() = None);
        return false;
    }
    let plan = ScanPlan::build(&kws, &active, noise_level);
    PREPARED_SEARCH.with(|p| {
        *p.borrow_mut() = Some(PreparedSearch { kws, plan });
    });
    true
}

#[wasm_bindgen]
pub fn scan_prepared_range(from_doc: usize, to_doc: usize) -> JsValue {
    PREPARED_SEARCH.with(|ps| {
        let ps_ref = ps.borrow();
        match ps_ref.as_ref() {
            Some(prep) => GLOBAL_DATA.with(|data| {
                INDEXED_DOCS.with(|idocs| {
                    let pool = data.borrow();
                    let indexed = idocs.borrow();
                    let results = scan_docs(&pool, &indexed, &prep.kws, &prep.plan, from_doc, to_doc);
                    serde_wasm_bindgen::to_value(&results).unwrap()
                })
            }),
            None => serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap(),
        }
    })
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
    let scan_plan = ScanPlan::build(&kws, &active, noise_level);

    GLOBAL_DATA.with(|data| {
        INDEXED_DOCS.with(|idocs| {
            let pool = data.borrow();
            let indexed = idocs.borrow();
            let results = scan_docs(&pool, &indexed, &kws, &scan_plan, from_doc, to_doc);
            serde_wasm_bindgen::to_value(&results).unwrap()
        })
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

struct AdsScratch {
    body: Vec<u8>,
    cmt: Vec<u8>,
}

struct AdsDoc<'a> {
    idoc: &'a IndexedDoc,
    comments: Option<&'a IndexedCommentDoc>,
    comment_used: bool,
}

fn ads_term_hit(
    idx: usize,
    use_comments: bool,
    mark_comment: bool,
    terms: &[AdsTerm],
    body_plans: &[ScanPlan],
    cmt_plans: &[ScanPlan],
    s: &mut AdsScratch,
    doc: &mut AdsDoc,
) -> bool {
    let term = &terms[idx];
    let bplan = &body_plans[idx];
    // s.body[idx]: 0=未检, 1=未命中, 2=标题命中, 3=仅正文命中, 4=仅路径命中
    if s.body[idx] == 0 {
        if has_plan_match_fast(&doc.idoc.title_chars, &doc.idoc.title_filter, &term.kws, bplan) {
            s.body[idx] = 2;
        } else if has_plan_match_fast(&doc.idoc.content_chars, &doc.idoc.content_filter, &term.kws, bplan) {
            s.body[idx] = 3;
        } else if !doc.idoc.path_chars.is_empty()
            && has_plan_match_fast(&doc.idoc.path_chars, &doc.idoc.path_filter, &term.kws, bplan)
        {
            s.body[idx] = 4;
        } else {
            s.body[idx] = 1;
        }
    }
    if s.body[idx] >= 2 {
        return true;
    }
    if !use_comments {
        return false;
    }
    if s.cmt[idx] == 0 {
        let mut hit = false;
        let cplan = &cmt_plans[idx];
        if !cplan.entries.is_empty() {
            if let Some(cd) = doc.comments {
                for (chars, filter) in cd.texts_chars.iter().zip(cd.filters.iter()) {
                    if chars.is_empty() {
                        continue;
                    }
                    if has_plan_match_fast(chars, filter, &term.kws, cplan) {
                        hit = true;
                        break;
                    }
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
    body_plans: &[ScanPlan],
    cmt_plans: &[ScanPlan],
    s: &mut AdsScratch,
    doc: &mut AdsDoc,
) -> bool {
    match n {
        AdsNode::Term { idx, neg } => {
            if *neg {
                !ads_term_hit(*idx, use_comments, false, terms, body_plans, cmt_plans, s, doc)
            } else {
                ads_term_hit(*idx, use_comments, true, terms, body_plans, cmt_plans, s, doc)
            }
        }
        AdsNode::And(v) => {
            for c in v {
                if !ads_eval(c, use_comments, terms, body_plans, cmt_plans, s, doc) {
                    return false;
                }
            }
            true
        }
        AdsNode::Or(v) => {
            for c in v {
                if ads_eval(c, use_comments, terms, body_plans, cmt_plans, s, doc) {
                    return true;
                }
            }
            false
        }
    }
}

fn build_ads_scan_plans(plan: &AdsPlan) -> (Vec<ScanPlan>, Vec<ScanPlan>) {
    let body_plans: Vec<ScanPlan> = CORPUS_BLOOM.with(|b| {
        let bloom = b.borrow();
        plan.terms
            .iter()
            .map(|t| {
                let active = filter_kws_by_bloom(&t.kws, t.noise, &bloom);
                ScanPlan::build(&t.kws, &active, t.noise)
            })
            .collect()
    });
    let cmt_plans: Vec<ScanPlan> = COMMENT_BLOOM.with(|b| {
        let bloom = b.borrow();
        plan.terms
            .iter()
            .map(|t| {
                let active = filter_kws_by_bloom(&t.kws, t.noise, &bloom);
                ScanPlan::build(&t.kws, &active, t.noise)
            })
            .collect()
    });
    (body_plans, cmt_plans)
}

fn scan_docs_ads<'a>(
    pool: &'a [String],
    indexed: &[IndexedDoc],
    indexed_comments: &[IndexedCommentDoc],
    comment_index: &HashMap<String, usize>,
    plan: &AdsPlan,
    body_plans: &[ScanPlan],
    cmt_plans: &[ScanPlan],
    from_doc: usize,
    to_doc: usize,
) -> Vec<SearchResult<'a>> {
    let mut results: Vec<SearchResult<'a>> = Vec::new();
    let term_count = plan.terms.len();
    let mut s = AdsScratch {
        body: vec![0u8; term_count],
        cmt: vec![0u8; term_count],
    };

    let doc_total = (pool.len() / 4).min(indexed.len());
    let end_doc = if to_doc < doc_total { to_doc } else { doc_total };
    let mut d = from_doc;

    while d < end_doc {
        let i = d * 4;
        let idoc = &indexed[d];
        d += 1;

        let path = pool[i + 2].as_str();
        let res_type = pool[i + 3].as_str();
        let title = pool[i].as_str();

        for x in s.body.iter_mut() {
            *x = 0;
        }
        for x in s.cmt.iter_mut() {
            *x = 0;
        }

        let mut doc = AdsDoc {
            idoc,
            comments: comment_index
                .get(path)
                .and_then(|&ci| indexed_comments.get(ci)),
            comment_used: false,
        };

        if !ads_eval(&plan.expr, true, &plan.terms, body_plans, cmt_plans, &mut s, &mut doc) {
            continue;
        }

        let via_comment = doc.comment_used
            && !ads_eval(&plan.expr, false, &plan.terms, body_plans, cmt_plans, &mut s, &mut doc);

        // 汇总全部正向词项命中后统一做跨词项区间去重，消除重复计分
        let mut raw_title_hits: Vec<TaggedHit> = Vec::new();
        let mut raw_content_hits: Vec<TaggedHit> = Vec::new();
        let mut raw_path_hits: Vec<TaggedHit> = Vec::new();
        let mut comment_only_terms = 0usize;

        for &idx in &plan.positives {
            if !ads_term_hit(idx, true, false, &plan.terms, body_plans, cmt_plans, &mut s, &mut doc) {
                continue;
            }
            let body_state = s.body[idx];
            if body_state == 1 {
                comment_only_terms += 1;
                continue;
            }
            let term = &plan.terms[idx];
            let bplan = &body_plans[idx];
            if body_state == 4 {
                let before = raw_path_hits.len();
                collect_plan_matches_fast(
                    &idoc.path_chars,
                    &idoc.path_filter,
                    &term.kws,
                    bplan,
                    &mut raw_path_hits,
                );
                if raw_path_hits.len() == before {
                    comment_only_terms += 1;
                }
            } else {
                if body_state == 2 {
                    collect_plan_matches_fast(
                        &idoc.title_chars,
                        &idoc.title_filter,
                        &term.kws,
                        bplan,
                        &mut raw_title_hits,
                    );
                }
                collect_plan_matches_fast(
                    &idoc.content_chars,
                    &idoc.content_filter,
                    &term.kws,
                    bplan,
                    &mut raw_content_hits,
                );
            }
        }

        let merged_title = merge_tagged_hits(raw_title_hits);
        let merged_content = merge_tagged_hits(raw_content_hits);
        let merged_path = merge_tagged_hits(raw_path_hits);

        let count = merged_title.len() + merged_content.len() + merged_path.len();
        let (ts, t_t0) =
            weigh_section_hits(&merged_title, TITLE_HIT_SCORE, TITLE_NOISE_STEP, TITLE_SYN_CAP, 1);
        let (cs, c_t0) = weigh_section_hits(
            &merged_content,
            CONTENT_HIT_SCORE,
            CONTENT_NOISE_STEP,
            CONTENT_SYN_CAP,
            4,
        );
        let (ps, p_t0) =
            weigh_section_hits(&merged_path, PATH_HIT_SCORE, PATH_NOISE_STEP, PATH_SYN_CAP, 1);
        let best_t0 = min_opt(min_opt(t_t0, c_t0), p_t0);
        let score = ts + cs + ps + comment_only_terms * CONTENT_HIT_SCORE + tier0_doc_bonus(best_t0);

        results.push(SearchResult {
            title,
            count,
            score,
            res_type,
            path,
            local_only: idoc.is_local_only,
            via_comment,
        });
    }
    results
}

#[wasm_bindgen]
pub fn prepare_ads_search(plan_val: JsValue) -> bool {
    let plan = match parse_ads_plan(plan_val) {
        Some(p) => p,
        None => {
            PREPARED_ADS.with(|p| *p.borrow_mut() = None);
            return false;
        }
    };
    let (body_plans, cmt_plans) = build_ads_scan_plans(&plan);
    PREPARED_ADS.with(|p| {
        *p.borrow_mut() = Some(PreparedAds {
            plan,
            body_plans,
            cmt_plans,
        });
    });
    true
}

#[wasm_bindgen]
pub fn scan_prepared_ads_range(from_doc: usize, to_doc: usize) -> JsValue {
    PREPARED_ADS.with(|pa| {
        let pa_ref = pa.borrow();
        match pa_ref.as_ref() {
            Some(prep) => GLOBAL_DATA.with(|data| {
                INDEXED_DOCS.with(|idocs| {
                    INDEXED_COMMENTS.with(|ic| {
                        COMMENT_INDEX.with(|m| {
                            let pool = data.borrow();
                            let indexed = idocs.borrow();
                            let ic_docs = ic.borrow();
                            let index = m.borrow();
                            let results = scan_docs_ads(
                                &pool,
                                &indexed,
                                &ic_docs,
                                &index,
                                &prep.plan,
                                &prep.body_plans,
                                &prep.cmt_plans,
                                from_doc,
                                to_doc,
                            );
                            serde_wasm_bindgen::to_value(&results).unwrap()
                        })
                    })
                })
            }),
            None => serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap(),
        }
    })
}

#[wasm_bindgen]
pub fn search_ads_range(plan_val: JsValue, from_doc: usize, to_doc: usize) -> JsValue {
    let plan = match parse_ads_plan(plan_val) {
        Some(p) => p,
        None => return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap(),
    };

    let (body_plans, cmt_plans) = build_ads_scan_plans(&plan);

    GLOBAL_DATA.with(|data| {
        INDEXED_DOCS.with(|idocs| {
            INDEXED_COMMENTS.with(|ic| {
                COMMENT_INDEX.with(|m| {
                    let pool = data.borrow();
                    let indexed = idocs.borrow();
                    let ic_docs = ic.borrow();
                    let index = m.borrow();
                    let results = scan_docs_ads(
                        &pool,
                        &indexed,
                        &ic_docs,
                        &index,
                        &plan,
                        &body_plans,
                        &cmt_plans,
                        from_doc,
                        to_doc,
                    );
                    serde_wasm_bindgen::to_value(&results).unwrap()
                })
            })
        })
    })
}

#[wasm_bindgen]
pub fn set_comments(val: JsValue) {
    let docs: Vec<CommentDoc> = serde_wasm_bindgen::from_value(val).unwrap_or_default();
    let mut index: HashMap<String, usize> = HashMap::with_capacity(docs.len());
    let mut indexed_comments: Vec<IndexedCommentDoc> = Vec::with_capacity(docs.len());
    for (i, d) in docs.iter().enumerate() {
        index.insert(d.path.clone(), i);
        let mut texts_chars = Vec::with_capacity(d.texts.len());
        let mut filters = Vec::with_capacity(d.texts.len());
        for t in &d.texts {
            let chars = if t.is_empty() {
                Vec::new()
            } else {
                fold_str_to_chars(t)
            };
            let filter = DocFilter::from_folded(&chars);
            texts_chars.push(chars);
            filters.push(filter);
        }
        indexed_comments.push(IndexedCommentDoc {
            texts_chars,
            filters,
        });
    }
    COMMENT_BLOOM.with(|b| {
        b.borrow_mut().rebuild_from_comments(&indexed_comments);
    });
    COMMENTS.with(|c| {
        *c.borrow_mut() = docs;
    });
    INDEXED_COMMENTS.with(|ic| {
        *ic.borrow_mut() = indexed_comments;
    });
    COMMENT_INDEX.with(|m| {
        *m.borrow_mut() = index;
    });
    PREPARED_COMMENT.with(|p| {
        *p.borrow_mut() = None;
    });
    PREPARED_ADS.with(|p| {
        *p.borrow_mut() = None;
    });
}

#[derive(Serialize)]
struct CommentHit<'a> {
    path: &'a str,
    count: usize,
    score: usize,
}

fn scan_comments_slice<'a>(
    docs: &'a [CommentDoc],
    indexed_comments: &[IndexedCommentDoc],
    kws: &[CompiledKw],
    scan_plan: &ScanPlan,
    from_doc: usize,
    to_doc: usize,
) -> Vec<CommentHit<'a>> {
    let total = docs.len().min(indexed_comments.len());
    let end_doc = to_doc.min(total);
    let mut raw_hits: Vec<TaggedHit> = Vec::new();
    let mut hits: Vec<CommentHit<'a>> = Vec::new();

    for idx in from_doc.min(end_doc)..end_doc {
        let d = &docs[idx];
        let ic = &indexed_comments[idx];
        let mut matched_comments = 0usize;
        let mut all_hits: Vec<TaggedHit> = Vec::new();
        for (chars, filter) in ic.texts_chars.iter().zip(ic.filters.iter()) {
            if chars.is_empty() {
                continue;
            }
            raw_hits.clear();
            collect_plan_matches_fast(chars, filter, kws, scan_plan, &mut raw_hits);
            if !raw_hits.is_empty() {
                let cm = merge_tagged_hits(std::mem::take(&mut raw_hits));
                matched_comments += 1;
                all_hits.extend(cm);
            }
        }
        if matched_comments > 0 {
            let (base_score, c_t0) = weigh_section_hits(
                &all_hits,
                CONTENT_HIT_SCORE,
                CONTENT_NOISE_STEP,
                CONTENT_SYN_CAP,
                4,
            );
            let score = base_score + tier0_doc_bonus(c_t0);
            hits.push(CommentHit {
                path: d.path.as_str(),
                count: matched_comments,
                score,
            });
        }
    }
    hits
}

#[wasm_bindgen]
pub fn comment_doc_count() -> usize {
    COMMENTS.with(|c| c.borrow().len())
}

#[wasm_bindgen]
pub fn prepare_comment_search(keywords_val: JsValue, noise_level: usize) -> bool {
    let kws = parse_keywords(keywords_val);
    if kws.is_empty() {
        PREPARED_COMMENT.with(|p| *p.borrow_mut() = None);
        return false;
    }
    let active = COMMENT_BLOOM.with(|b| filter_kws_by_bloom(&kws, noise_level, &b.borrow()));
    if active.is_empty() {
        PREPARED_COMMENT.with(|p| *p.borrow_mut() = None);
        return false;
    }
    let plan = ScanPlan::build(&kws, &active, noise_level);
    PREPARED_COMMENT.with(|p| {
        *p.borrow_mut() = Some(PreparedSearch { kws, plan });
    });
    true
}

#[wasm_bindgen]
pub fn scan_prepared_comments_range(from_doc: usize, to_doc: usize) -> JsValue {
    PREPARED_COMMENT.with(|pc| {
        let pc_ref = pc.borrow();
        match pc_ref.as_ref() {
            Some(prep) => COMMENTS.with(|c| {
                INDEXED_COMMENTS.with(|ic| {
                    let docs = c.borrow();
                    let ic_docs = ic.borrow();
                    let hits = scan_comments_slice(
                        &docs,
                        &ic_docs,
                        &prep.kws,
                        &prep.plan,
                        from_doc,
                        to_doc,
                    );
                    serde_wasm_bindgen::to_value(&hits).unwrap()
                })
            }),
            None => serde_wasm_bindgen::to_value(&Vec::<CommentHit>::new()).unwrap(),
        }
    })
}

#[wasm_bindgen]
pub fn search_comments(keywords_val: JsValue, noise_level: usize) -> JsValue {
    let kws = parse_keywords(keywords_val);
    if kws.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<CommentHit>::new()).unwrap();
    }
    let active = COMMENT_BLOOM.with(|b| filter_kws_by_bloom(&kws, noise_level, &b.borrow()));
    if active.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<CommentHit>::new()).unwrap();
    }
    let scan_plan = ScanPlan::build(&kws, &active, noise_level);

    COMMENTS.with(|c| {
        INDEXED_COMMENTS.with(|ic| {
            let docs = c.borrow();
            let ic_docs = ic.borrow();
            let mut hits = scan_comments_slice(&docs, &ic_docs, &kws, &scan_plan, 0, docs.len());
            hits.sort_by(|a, b| {
                b.score
                    .cmp(&a.score)
                    .then(b.count.cmp(&a.count))
                    .then(a.path.cmp(&b.path))
            });
            serde_wasm_bindgen::to_value(&hits).unwrap()
        })
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
