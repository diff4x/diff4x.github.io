use regex::Regex;
use serde::{Serialize};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

// ==========================================
// 1. 全局内存驻留区 (杜绝 Worker 的大数组重复拷贝)
// ==========================================
thread_local! {
    // 静态持有全局数据，格式保持 JS 传过来的平铺数组: [title, info, path, type, ...]
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());
}

// ==========================================
// 2. 数据结构定义
// ==========================================

/// 返回给 worker.js 的搜索结果
#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub count: usize,
    pub score: usize,
    #[serde(rename = "type")]
    pub res_type: String,
    pub path: String,
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

    let exact_regex = build_regex(keyword, false);
    let tolerant_regex = build_regex(keyword, true);

    let results = GLOBAL_DATA.with(|data| {
        let pool = data.borrow();
        if pool.is_empty() {
            return Vec::new();
        }

        // 第一遍：精准匹配
        let mut hits = execute_scan(&pool, &exact_regex, false);

        // 融合扫描：精确匹配为空，直接无缝跑宽容匹配
        if hits.is_empty() {
            hits = execute_scan(&pool, &tolerant_regex, true);
        }

        // Rust 原生极速多条件排序
        hits.sort_by(|a, b| {
            b.score.cmp(&a.score)
                .then(b.count.cmp(&a.count))
                .then(a.title.cmp(&b.title)) // 字典序兜底
        });

        hits
    });

    serde_wasm_bindgen::to_value(&results).unwrap()
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

/// 针对 worker.js 的全局扫描逻辑
fn execute_scan(pool: &[String], re: &Regex, is_tolerant: bool) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let weight_title = 50;
    let weight_content = 1;

    for i in (0..pool.len()).step_by(4) {
        if i + 3 >= pool.len() { break; }

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = &pool[i + 3];
        let title = path.split('/').last().unwrap_or("").to_string();
        
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
        
        if count == 0 && res_type != "html" && res_type != "image" {
            count = re.find_iter(path).count();
        }

        if count == 0 {
            continue;
        }

        let score = (title_hits * weight_title) + (content_hits * weight_content);

        let snippets = if content_hits > 0 {
            extract_snippets(searchable_content, re)
        } else {
            Vec::new()
        };

        results.push(SearchResult {
            title,
            count,
            score,
            res_type: res_type.clone(),
            path: path.clone(),
            local_only: is_local_only,
            snippets,
            is_tolerant_match: is_tolerant,
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

// ==========================================
// 6. 可选扩展：Markdown 格式化
// ==========================================
#[wasm_bindgen]
pub fn format_markdown_line(line: &str) -> String {
    // 在这里用 Rust 高速执行正则替换
    // 返回 `<span class='lv0'>...</span>` 字符串
    String::from(line)
}