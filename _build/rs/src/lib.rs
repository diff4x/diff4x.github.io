use regex::Regex;
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use lru::LruCache;
use std::num::NonZeroUsize;
use aho_corasick::AhoCorasick;

// ==========================================
// 1. 全局内存驻留区 & LRU 编译缓存
// ==========================================
thread_local! {
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());
    
    // 缓存精确匹配的 DFA 状态机
    static EXACT_CACHE: RefCell<LruCache<String, AhoCorasick>> = RefCell::new(LruCache::new(NonZeroUsize::new(32).unwrap()));
    // 缓存宽容匹配的正则对象
    static TOLERANT_CACHE: RefCell<LruCache<String, Regex>> = RefCell::new(LruCache::new(NonZeroUsize::new(32).unwrap()));
}

// ==========================================
// 2. 数据结构定义 (引入 <'a> 生命周期，实现真正的 Zero-Copy)
// ==========================================

#[derive(Serialize)]
pub struct SearchResult<'a> {
    pub title: &'a str,  // 直接借用内存池地址，彻底消灭 clone!
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

/// 返回给 content.js 的页面内探测结果
#[derive(Serialize)]
pub struct ContentMatchResult {
    pub count: usize,
    pub matches: Vec<MatchPos>,
    pub snippets: Vec<String>,
    #[serde(rename = "isTolerantMatch")]
    pub is_tolerant_match: bool,
}

/// 页面内的正则命中坐标 (提供给 JS 的 UTF-16 切割点)
#[derive(Serialize, Clone)]
pub struct MatchPos {
    pub start: usize,
    pub end: usize,
    pub index: usize,
}

// ==========================================
// 3. Worker 专属接口 (数据灌入与全局搜索)
// ==========================================

#[wasm_bindgen]
pub fn set_data(js_array: js_sys::Array) {
    let mut local_vec = Vec::with_capacity(js_array.length() as usize);
    for i in 0..js_array.length() {
        if let Some(s) = js_array.get(i).as_string() {
            local_vec.push(s);
        } else {
            local_vec.push(String::new());
        }
    }
    
    // 一次性写入 Wasm 内存
    GLOBAL_DATA.with(|data| {
        *data.borrow_mut() = local_vec;
    });
}

#[wasm_bindgen]
pub fn search(keyword: &str) -> JsValue {
    if keyword.trim().is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
    }

    let kw = keyword.trim().to_string();

    // 从 LRU 缓存极速提取编译好的状态机和正则
    let ac = EXACT_CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        if let Some(cached) = cache.get(&kw) {
            return cached.clone(); // AhoCorasick 内部采用 Arc，clone 极快
        }
        let built = AhoCorasick::builder().ascii_case_insensitive(true).build(&[&kw]).unwrap();
        cache.put(kw.clone(), built.clone());
        built
    });

    let tolerant_regex = TOLERANT_CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        if let Some(cached) = cache.get(&kw) {
            return cached.clone();
        }
        let built = build_regex(&kw, true);
        cache.put(kw.clone(), built.clone());
        built
    });

    // 关键优化：在借用作用域内直接生成 JSValue，实现极限零拷贝传递
    GLOBAL_DATA.with(|data| {
        let pool = data.borrow();
        if pool.is_empty() {
            return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
        }

        // 第一遍：状态机精准狂飙
        let mut hits = execute_scan_exact(&pool, &ac, &kw);

        // 融合扫描：精确匹配为空，无缝跑宽容匹配
        if hits.is_empty() {
            hits = execute_scan_tolerant(&pool, &tolerant_regex, true);
        }

        hits.sort_by(|a, b| {
            b.score.cmp(&a.score)
                .then(b.count.cmp(&a.count))
                .then(a.title.cmp(&b.title)) 
        });

        serde_wasm_bindgen::to_value(&hits).unwrap()
    })
}

// ==========================================
// 4. Content 专属接口 (单页高亮坐标探测)
// ==========================================

#[wasm_bindgen]
pub fn find_content_matches(global_text: &str, keyword: &str) -> JsValue {
    if keyword.trim().is_empty() || global_text.is_empty() {
        return serde_wasm_bindgen::to_value(&ContentMatchResult {
            count: 0,
            matches: vec![],
            snippets: vec![],
            is_tolerant_match: false,
        }).unwrap();
    }

    // ✅ 修复点：在最外层作用域提前构建好两种正则，保证后续都能借用到
    let exact_regex = build_regex(keyword, false);
    let tolerant_regex = build_regex(keyword, true);
    let mut is_tolerant = false;
    
    // 第一遍：精准匹配
    let mut hits = find_hits(global_text, &exact_regex);
    
    // 融合扫描：宽容降级
    if hits.is_empty() {
        hits = find_hits(global_text, &tolerant_regex);
        if !hits.is_empty() {
            is_tolerant = true;
        }
    }

    let count = hits.len();
    if count == 0 {
        return serde_wasm_bindgen::to_value(&ContentMatchResult {
            count: 0,
            matches: vec![],
            snippets: vec![],
            is_tolerant_match: false,
        }).unwrap();
    }

    // 现在 active_re 可以安全地借用外层的正则对象了
    let active_re = if is_tolerant { &tolerant_regex } else { &exact_regex };
    let snippets = extract_snippets(global_text, active_re);

    serde_wasm_bindgen::to_value(&ContentMatchResult {
        count,
        matches: hits,
        snippets,
        is_tolerant_match: is_tolerant,
    }).unwrap()
}

// ==========================================
// 5. 内部通用引擎库
// ==========================================

/// 构建正规或宽容正则表达式
fn build_regex(kw: &str, is_tolerant: bool) -> Regex {
    let escaped = regex::escape(kw.trim());
    
    let pattern = if is_tolerant {
        let chars: Vec<char> = kw.chars().filter(|c| !c.is_whitespace()).collect();
        let mut regex_str = String::new();
        for (i, c) in chars.iter().enumerate() {
            regex_str.push_str(&regex::escape(&c.to_string()));
            if i < chars.len() - 1 {
                // 宽容模式：允许汉字/字母之间穿插 0-3 个任意字符
                regex_str.push_str(r"\s*(?:.|\n){0,3}?\s*");
            }
        }
        regex_str
    } else {
        escaped
    };

    Regex::new(&format!("(?i){}", pattern)).unwrap_or_else(|_| Regex::new("^$").unwrap())
}

/// 精准模式扫描：使用 Aho-Corasick 状态机
fn execute_scan_exact<'a>(pool: &'a [String], ac: &AhoCorasick, kw: &str) -> Vec<SearchResult<'a>> {
    let mut results = Vec::new();
    let weight_title = 50;
    let weight_content = 1;
    // 构建用于切片的伪正则 (AhoCorasick 本身也能切，但为了复用之前的 extract_snippets 逻辑，这里临时生成一个简单的 literal 正则，开销极小)
    let slice_re = Regex::new(&format!("(?i){}", regex::escape(kw))).unwrap();

    for i in (0..pool.len()).step_by(4) {
        if i + 3 >= pool.len() { break; }

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = &pool[i + 3];
        
        let title_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
        let title = &path[title_start..]; // Zero-copy slicing!
        
        let mut is_local_only = false;
        let searchable_content = if raw_content.starts_with("localOnly") {
            is_local_only = true;
            &raw_content[9..] 
        } else {
            raw_content
        };

        let title_hits = ac.find_iter(&title).count();
        let content_hits = ac.find_iter(searchable_content).count();
        let mut count = title_hits + content_hits;
        
        if count == 0 && res_type != &"html" && res_type != &"image" {
            count = ac.find_iter(path).count();
        }

        if count == 0 { continue; }

        let snippets = if content_hits > 0 {
            extract_snippets(searchable_content, &slice_re)
        } else {
            Vec::new()
        };

        results.push(SearchResult {
            title, count, score: (title_hits * weight_title) + (content_hits * weight_content),
            res_type, path, local_only: is_local_only, snippets, is_tolerant_match: false,
        });
    }
    results
}

/// 宽容模式扫描：使用原生 Regex
fn execute_scan_tolerant<'a>(pool: &'a [String], re: &Regex, is_tolerant: bool) -> Vec<SearchResult<'a>> {
    let mut results = Vec::new();
    let weight_title = 50;
    let weight_content = 1;

    for i in (0..pool.len()).step_by(4) {
        if i + 3 >= pool.len() { break; }

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = &pool[i + 3];
        
        let title_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
        let title = &path[title_start..]; // Zero-copy slicing!
        
        let mut is_local_only = false;
        let searchable_content = if raw_content.starts_with("localOnly") {
            is_local_only = true;
            &raw_content[9..] 
        } else {
            raw_content
        };

        let title_hits = re.find_iter(&title).count();
        let content_hits = re.find_iter(searchable_content).count();
        let mut count = title_hits + content_hits;
        
        if count == 0 && res_type != &"html" && res_type != &"image" {
            count = re.find_iter(path).count();
        }

        if count == 0 { continue; }

        let snippets = if content_hits > 0 {
            extract_snippets(searchable_content, re)
        } else {
            Vec::new()
        };

        results.push(SearchResult {
            title, count, score: (title_hits * weight_title) + (content_hits * weight_content),
            res_type, path, local_only: is_local_only, snippets, is_tolerant_match: is_tolerant,
        });
    }
    results
}

/// 针对 content.js 的单页精准坐标扫描（附带 UTF8 -> UTF16 转换防偏移）
fn find_hits(text: &str, re: &Regex) -> Vec<MatchPos> {
    let mut hits = Vec::new();
    let mut group_index = 0;
    
    // 安全构建索引映射（Byte index -> UTF-16 length）
    let mut utf16_mapping = vec![0; text.len() + 1];
    let mut utf16_len = 0;
    for (byte_idx, ch) in text.char_indices() {
        utf16_mapping[byte_idx] = utf16_len;
        utf16_len += ch.len_utf16(); 
    }
    utf16_mapping[text.len()] = utf16_len;

    for mat in re.find_iter(text) {
        if mat.start() == mat.end() { continue; } 
        
        // 关键：返回给 JS 的永远是转化后的 UTF-16 坐标
        let utf16_start = utf16_mapping[mat.start()];
        let utf16_end = utf16_mapping[mat.end()];

        hits.push(MatchPos {
            start: utf16_start,
            end: utf16_end,
            index: group_index,
        });
        group_index += 1;
    }
    hits
}

/// 针对 content.js 的切片生成器
fn extract_snippets(text: &str, re: &Regex) -> Vec<String> {
    let mut snippets = Vec::new();
    let mut last_end = 0;

    // 不再限制摘要数量，处理所有匹配项
    for mat in re.find_iter(text) {
        // 防止匹配项过于密集，导致切片重叠
        if mat.start() < last_end {
            continue;
        }

        // 安全的 UTF-8 字符边界截取
        // 前后各取 20 和 40 个字符
        let start = text[..mat.start()]
            .char_indices()
            .rev()
            .nth(20)
            .map(|(i, _)| i)
            .unwrap_or(0);

        let end = text[mat.end()..]
            .char_indices()
            .nth(40)
            .map(|(i, _)| mat.end() + i)
            .unwrap_or(text.len());

        snippets.push(format!(
            "...{}...",
            &text[start..end]
        ));

        last_end = end;
    }

    snippets
}


use lazy_static::lazy_static;
use serde_json::Value;

// ==========================================
// 目标 1：Markdown 极速格式化引擎 (外包 content.js 的 format)
// 利用 lazy_static 全局缓存正则，避免在遍历大文本时重复编译 (优化点 3.b)
// ==========================================
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
            out_lines.push(String::from("\n\u{00A0}"));
            continue;
        }

        // 1. 媒体与链接替换
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

        // 2. 标题 H1-H6 替换
        if let Some(caps) = HEADER_RE.captures(&processed) {
            let level = caps.get(1).unwrap().as_str().len();
            let content = caps.get(2).unwrap().as_str();
            out_lines.push(format!("<h{}>{}</h{}>", level, content, level));
            continue;
        }

        // 3. 缩进层级解析 (直接算空格，完全消灭 JS 的正则开销)
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

// ==========================================
// 目标 2：数据增量 Diff 与树结构扁平化 (外包 index.js 的 flattenTree)
// ==========================================
#[wasm_bindgen]
pub fn build_flat_data(lite_json: &str, fat_json: &str, shadow_json: &str, is_offline: bool) -> js_sys::Array {
    // 采用跨界传 JSON String，再在 Rust 侧安全反序列化的策略，比深拷贝巨大 JsValue 快得多
    let lite: Value = serde_json::from_str(lite_json).unwrap_or(Value::Null);
    let fat: Value = serde_json::from_str(fat_json).unwrap_or(Value::Null);
    let shadow: Value = serde_json::from_str(shadow_json).unwrap_or(Value::Null);

    let mut results = Vec::new();
    let buckets = [
        ("html", "html/"), ("image", "gallery/"), 
        ("video", "video/"), ("audio", "audio/"), ("ebook", "ebook/")
    ];

    for (bucket, prefix) in buckets.iter() {
        if let Some(root) = lite.get(bucket) {
            flatten_tree_recursive(root, prefix, bucket, &fat, &shadow, is_offline, &mut results);
        }
    }
    
    // 生成标准的平铺数组返回给 JS，供 worker 初始化或直接使用
    let js_array = js_sys::Array::new_with_length(results.len() as u32);
    for (i, s) in results.into_iter().enumerate() {
        js_array.set(i as u32, JsValue::from_str(&s));
    }
    js_array
}

fn flatten_tree_recursive(node: &Value, prefix: &str, bucket: &str, fat: &Value, shadow: &Value, is_offline: bool, results: &mut Vec<String>) {
    if let Value::Object(map) = node {
        // 提取并压平 _f 文件节点
        if let Some(Value::Array(f_arr)) = map.get("_f") {
            for f_item in f_arr {
                if let Value::Array(item) = f_item {
                    // ✅ 修复 1：放宽到长度 >= 3，包容没有 info 的节点
                    if item.len() >= 3 {
                        let file_name = item.get(0).and_then(|v| v.as_str()).unwrap_or("");
                        
                        // ✅ 修复 2：兼容 ID 是 Number 的情况，一律转为 String
                        let id = match item.get(1) {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Number(n)) => n.to_string(),
                            _ => String::new(),
                        };
                        
                        let f_type = item.get(2).and_then(|v| v.as_str()).unwrap_or("");
                        // 第 4 个元素作为 info，拿不到就默认为空
                        let info = item.get(3).and_then(|v| v.as_str()).unwrap_or("");
                        
                        let mut title = file_name.to_string();
                        let path = format!("{}{}", prefix, file_name);
                        let mut val1 = info.to_string();
                        let mut val2 = path.clone();

                        if f_type == "html" {
                            if title.ends_with(".html") {
                                title = title[..title.len()-5].to_string();
                            }
                            // 用解析好的准确 id 查阅 fat 字典
                            if let Some(fat_info) = fat.get(&id).and_then(|v| v.as_str()) {
                                val1 = fat_info.to_string();
                            }
                            // Shadow 降级覆盖逻辑
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
        
        // 递归遍历子目录 (保持不变)
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