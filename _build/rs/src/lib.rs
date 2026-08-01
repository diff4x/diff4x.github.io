use regex::Regex;
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use lru::LruCache;
use std::num::NonZeroUsize;
use lazy_static::lazy_static;
use serde_json::Value;
use similar::{Algorithm, DiffOp, capture_diff_slices};

// ==========================================
// 1. 全局内存驻留区 & LRU 编译缓存
// ==========================================
const CACHE_CAP: usize = 32;

thread_local! {
    static GLOBAL_DATA: RefCell<Vec<String>> = RefCell::new(Vec::new());

    // 🚀 缓存 Regex 对象（key 里同时编码 noise_level，避免不同宽容度串扰）
    static TOLERANT_CACHE: RefCell<LruCache<String, Regex>> = RefCell::new(LruCache::new(NonZeroUsize::new(CACHE_CAP).unwrap()));
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
    pub noise: usize,
}

// ==========================================
// 4. Content 专属接口 (单页高亮坐标探测)
// ==========================================

#[wasm_bindgen]
pub fn find_content_matches(global_text: &str, keyword: &str, noise_level: usize) -> JsValue {
    if keyword.trim().is_empty() || global_text.is_empty() {
        return serde_wasm_bindgen::to_value(&ContentMatchResult {
            count: 0, matches: vec![], snippets: vec![], is_tolerant_match: false,
        }).unwrap();
    }

    let kw_len = keyword.chars().filter(|c| !c.is_whitespace()).count();
    let tolerant_regex = build_regex(keyword, noise_level);
    
    // 只扫描一次
    let mut hits = Vec::new();
    let mut group_index = 0;
    
    let mut utf16_mapping = vec![0; global_text.len() + 1];
    let mut utf16_len = 0;
    for (byte_idx, ch) in global_text.char_indices() {
        utf16_mapping[byte_idx] = utf16_len;
        utf16_len += ch.len_utf16(); 
    }
    utf16_mapping[global_text.len()] = utf16_len;

    for mat in tolerant_regex.find_iter(global_text) {
        if mat.start() == mat.end() { continue; } 
        
        // 计算当前碎片的杂字数
        let match_chars = mat.as_str().chars().filter(|c| !c.is_whitespace()).count();
        let noise = match_chars.saturating_sub(kw_len);

        let utf16_start = utf16_mapping[mat.start()];
        let utf16_end = utf16_mapping[mat.end()];

        hits.push(MatchPos {
            start: utf16_start,
            end: utf16_end,
            index: group_index,
            noise, // 携带置信度丢给 JS
        });
        group_index += 1;
    }

    let count = hits.len();
    if count == 0 {
        return serde_wasm_bindgen::to_value(&ContentMatchResult {
            count: 0, matches: vec![], snippets: vec![], is_tolerant_match: false,
        }).unwrap();
    }

    let snippets = extract_snippets(global_text, &tolerant_regex);

    serde_wasm_bindgen::to_value(&ContentMatchResult {
        count, matches: hits, snippets, is_tolerant_match: true,
    }).unwrap()
}

// ==========================================
// 5. 内部通用引擎库
// ==========================================

/// 构建宽容正则表达式（字间允许 0-3 个任意字符，兼容换行与两端空格）
/// 🚀 命中 TOLERANT_CACHE 时直接复用已编译对象，避免重复编译正则的开销。
/// 缓存键必须同时携带 noise_level：同一个关键词在不同宽容度下会产出不同的正则，
/// 若只用关键词做键，会出现"用 noise=3 编译好的正则被 noise=1 的请求误用"的串档问题。
fn build_regex(kw: &str, noise_level: usize) -> Regex {
    let cache_key = format!("{}\u{0}{}", noise_level, kw);

    if let Some(cached) = TOLERANT_CACHE.with(|cache| cache.borrow_mut().get(&cache_key).cloned()) {
        return cached;
    }

    let chars: Vec<char> = kw.chars().filter(|c| !c.is_whitespace()).collect();
    let mut regex_str = String::new();
    
    let is_too_long = chars.len() > 25;
    
    for (i, c) in chars.iter().enumerate() {
        regex_str.push_str(&regex::escape(&c.to_string()));
        if i < chars.len() - 1 {
            if is_too_long || noise_level == 0 {
                // 宽容度为0 或 防御超长字符串灾难时：仅允许空白符
                regex_str.push_str(r"\s*");
            } else {
                // 根据下发的 noise_level 动态设置通配区间
                regex_str.push_str(&format!(r"\s*(?:.|\n){{0,{}}}?\s*", noise_level));
            }
        }
    }
    let compiled = Regex::new(&format!("(?i){}", regex_str)).unwrap_or_else(|_| Regex::new("^$").unwrap());

    TOLERANT_CACHE.with(|cache| {
        cache.borrow_mut().put(cache_key, compiled.clone());
    });

    compiled
}

#[wasm_bindgen]
pub fn search(keyword: &str, noise_level: usize) -> JsValue {
    if keyword.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
    }
    let kw_len = keyword.chars().filter(|c| !c.is_whitespace()).count();
    
    let tolerant_regex = build_regex(keyword, noise_level);

    GLOBAL_DATA.with(|data| {
        let pool = data.borrow();
        if pool.is_empty() {
            return serde_wasm_bindgen::to_value(&Vec::<SearchResult>::new()).unwrap();
        }

        // 直接执行合并扫描
        let mut hits = execute_scan(&pool, &tolerant_regex, kw_len);

        // 排序：优先看超高权重的 Score
        hits.sort_by(|a, b| {
            b.score.cmp(&a.score)
                .then(b.count.cmp(&a.count))
                .then(a.title.cmp(&b.title)) 
        });

        serde_wasm_bindgen::to_value(&hits).unwrap()
    })
}

// 改造 execute_scan 引入动态计分
fn execute_scan<'a>(pool: &'a [String], re: &Regex, kw_len: usize) -> Vec<SearchResult<'a>> {
    let mut results = Vec::new();

    for i in (0..pool.len()).step_by(4) {
        if i + 3 >= pool.len() { break; }

        let raw_content = &pool[i + 1];
        let path = &pool[i + 2];
        let res_type = &pool[i + 3];
        
        let title_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
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

        // 标题命中计分 (断层权重)
        for mat in re.find_iter(title) {
            count += 1;
            let match_chars = mat.as_str().chars().filter(|c| !c.is_whitespace()).count();
            let noise = match_chars.saturating_sub(kw_len);
            score += if noise == 0 { 5000 } else { 500 - noise * 50 };
        }

        // 正文命中计分
        let mut content_hits = 0;
        for mat in re.find_iter(searchable_content) {
            count += 1;
            content_hits += 1;
            let match_chars = mat.as_str().chars().filter(|c| !c.is_whitespace()).count();
            let noise = match_chars.saturating_sub(kw_len);
            score += if noise == 0 { 100 } else { 10 - noise };
        }
        
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
            title, count, score,
            res_type, path, local_only: is_local_only, snippets, is_tolerant_match: true,
        });
    }
    results
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
            // 修复：此前写成 "\n\u{00A0}"，字符串内嵌了一个 '\n'。
            // out_lines 最终会被 join("\n") 拼接成一整段字符串，再由 JS 侧
            // .split('\n') 还原成"每行一个元素"的数组，供 Diff 引擎按下标对齐。
            // 只要某一行是空行，这里就会多产出一个 '\n'，导致 join 后的字符串
            // 比"每个逻辑行一个元素"多出一行——JS 侧 split('\n') 得到的数组长度
            // 就会比原始 Markdown 的行数多 1（此后每再遇到一个空行,继续 +1，
            // 偏移量会不断累积）。这样 oldHtmlLines[op.oldIdx] / newHtmlLines[op.newIdx]
            // 取到的其实是被这个偏移"错位"后的内容，Diff 高亮显示的行经常是错的、
            // 空的，或者干脆整段错位，看起来就像"增删部分没有正确显示/着色"。
            // 修复方式：确保空行也只产出"单独一行"的输出，不再内嵌换行符。
            out_lines.push(String::from("<span class='lv0 empty-line-fix'>\u{00A0}</span>"));
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
// 改造后的 Wasm 内存接收口
// 签名变更为 JsValue，直接在内存边界映射 JS 数组，消灭反序列化开销
// ==========================================
#[wasm_bindgen]
pub fn set_data(data_val: JsValue) {
    let local_vec: Vec<String> = serde_wasm_bindgen::from_value(data_val).unwrap_or_default();
    GLOBAL_DATA.with(|data| {
        *data.borrow_mut() = local_vec;
    });
}

// ==========================================
// 改造后的数据拼装引擎
// 直接接收 JS 对象句柄，返回装配好的 JS 数组对象
// ==========================================
#[wasm_bindgen]
pub fn build_flat_data(
    lite_val: JsValue,
    fat_val: JsValue,
    shadow_val: JsValue,
    is_offline: bool,
) -> JsValue {
    // 跨越 Wasm 边界，零拷贝映射为 Rust 的 serde_json::Value
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

    // 抛弃 rmp_serde 二进制打包，直接返回 JS 数组对象给 Worker
    serde_wasm_bindgen::to_value(&results).unwrap_or(JsValue::NULL)
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

// ==========================================
// LCS 逐行对比算法 (similar crate, 对齐 JS computeLCSDiff 输出形状)
// ==========================================

/// 单条 diff 操作，与 JS 侧 { type, oldIdx?, newIdx? } 对齐
#[derive(Serialize, Clone)]
pub struct DiffLineOp {
    #[serde(rename = "type")]
    pub op_type: &'static str,
    #[serde(rename = "oldIdx", skip_serializing_if = "Option::is_none")]
    pub old_idx: Option<usize>,
    #[serde(rename = "newIdx", skip_serializing_if = "Option::is_none")]
    pub new_idx: Option<usize>,
}

/// 对两行数组做 LCS 逐行 diff，返回与 JS computeLCSDiff 相同形状的操作列表。
/// - equal: 两边都有 oldIdx / newIdx
/// - delete: 只有 oldIdx
/// - insert: 只有 newIdx
///
/// 内部使用 similar 的 LCS 算法，并带与 JS 相同的前缀/后缀剪枝 + 超大区间降级。
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

    // 前缀剪枝
    let mut start = 0usize;
    while start < n && start < m && old_lines[start] == new_lines[start] {
        start += 1;
    }

    // 后缀剪枝
    let mut old_end = n as isize - 1;
    let mut new_end = m as isize - 1;
    while old_end >= start as isize
        && new_end >= start as isize
        && old_lines[old_end as usize] == new_lines[new_end as usize]
    {
        old_end -= 1;
        new_end -= 1;
    }

    // 公共前缀 → equal
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
        // 与 JS 相同：超大区间降级为纯 delete + insert
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
            // 使用 similar 的 LCS 算法
            let diff_ops = capture_diff_slices(Algorithm::Lcs, trimmed_old, trimmed_new);
            expand_diff_ops(&diff_ops, start, &mut result);
        }
    }

    // 公共后缀 → equal
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

/// 把 similar 的 range-based DiffOp 展开成与 JS 一致的逐行操作
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
                // LCS 通常不会产生 Replace，但为安全起见仍展开为 delete + insert
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