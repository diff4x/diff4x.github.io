use chrono::Local;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

pub struct StagedSynonymsJs {
    pub out_path: PathBuf,
    pub minified_js: String,
    pub raw_sha: String,
    pub out_sha: String,
    pub total_public_docs: usize,
}

pub struct PreparedSynonyms {
    pub oov_report: String,
    pub staged_js: Option<StagedSynonymsJs>,
}

use crate::api_files::write_atomic;
use crate::builder::{log_info, log_warn};
use crate::builder::minify::{minify_js, sha256_hex};
use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;

pub const SYN_ALGO_VERSION: &str = "cilin-1hop-df-v5.1";
const SYNONYMS_TPL_JS: &str = include_str!("synonyms_tpl.js");

const ASCII_STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "from", "this", "that", "have", "are", "was", "were", "not", "you", "your",
    "but", "all", "can", "had", "her", "one", "our", "out", "day", "get", "has", "him", "his", "how", "its",
    "may", "new", "now", "old", "see", "two", "way", "who", "did", "let", "put", "say", "she", "too", "use",
    "will", "just", "more", "some", "into", "than", "then", "them", "they", "what", "when", "where", "which",
    "while", "would", "there", "their", "about", "could", "other", "these", "first", "after", "never", "still",
    "been", "only", "also", "very", "even", "most", "much", "such", "make", "like", "time", "over", "here",
    "in", "if", "is", "to", "it", "as", "by", "of", "on", "at", "or", "no", "so", "up", "do", "be", "we",
    "he", "me", "my", "an", "us", "am", "ok", "vs", "cd", "rd", "md", "del", "dir", "set", "rem", "cls",
    "http", "https", "www", "com", "org", "net", "html", "htm", "webp", "png", "jpg", "jpeg", "gif", "svg",
    "mp4", "mp3", "m4a", "mkv", "pdf", "epub", "txt", "json", "exe", "dll", "zip", "bin", "cfg", "log",
    "def", "return", "import", "print", "self", "true", "false", "none", "null", "class", "else", "elif",
    "try", "except", "finally", "pass", "break", "continue", "const", "var", "function", "void",
    "int", "char", "str", "float", "bool", "list", "dict", "type", "args", "name", "value", "item",
    "items", "key", "keys", "file", "path", "src", "out", "build", "run", "test", "info", "error",
    "warn", "debug", "config", "default", "index", "main", "init", "start", "stop", "open", "close", "read",
    "write", "load", "save", "add", "pop", "end", "max", "min", "sum", "len", "range", "append", "remove",
    "sort", "sorted", "title", "upper", "lower", "strip", "split", "join", "replace", "format", "echo",
    "setlocal", "exit", "pause", "call", "goto", "exist", "delims", "tokens", "users", "user", "data",
    "window", "mode", "lib", "target", "failed", "install", "using", "used", "each",
];

const CJK_EDGE_STOP_CHARS: &str = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严呀啊呢吧吗嘛哦哇啦呐呗兮矣乎哉焉";

struct CustomGroup {
    c5: String,
    exclusive: bool,
    words: Vec<String>,
}

#[derive(Default)]
struct CustomConfig {
    drop_eq_codes: HashSet<String>,
    prune_words: HashMap<String, HashSet<String>>,
    split_fixes: HashMap<String, Vec<String>>,
    stop_expand: HashSet<String>,
    groups: Vec<CustomGroup>,
    aliases: Vec<(String, Vec<String>)>,
}

struct CilinEntry {
    code7: String,
    rel: char,
    words: Vec<String>,
}

#[derive(Default)]
struct TokenStat {
    display: String,
    df: usize,
    tf: usize,
    case_counts: HashMap<String, usize>,
}

impl TokenStat {
    fn record(&mut self, raw: &str, new_doc: bool) {
        self.tf += 1;
        if new_doc {
            self.df += 1;
        }
        let next = {
            let e = self.case_counts.entry(raw.to_string()).or_insert(0);
            *e += 1;
            *e
        };
        let cur_best = self.case_counts.get(&self.display).copied().unwrap_or(0);
        if self.display.is_empty() || next > cur_best {
            self.display = raw.to_string();
        }
    }
}

pub fn to_halfwidth(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\u{3000}' {
            out.push(' ');
        } else if ('\u{FF01}'..='\u{FF5E}').contains(&ch) {
            if let Some(hw) = char::from_u32(ch as u32 - 0xFEE0) {
                out.push(hw);
            } else {
                out.push(ch);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn escape_template_literal(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
}

fn safe_json_for_js(json: &str) -> String {
    json.replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn df_to_bucket(df: usize, total_docs: usize) -> u8 {
    if df == 0 {
        return 0;
    }
    if df == 1 {
        return 1;
    }
    if df <= 3 {
        return 2;
    }
    if total_docs == 0 {
        return 3;
    }
    let ratio = df as f64 / total_docs as f64;
    if ratio <= 0.08 {
        3
    } else if ratio <= 0.20 {
        4
    } else if ratio <= 0.40 {
        5
    } else {
        6
    }
}

fn load_custom_config_from_str(raw: &str) -> Result<CustomConfig, String> {
    let mut cfg = CustomConfig::default();
    let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(raw).trim();
    if trimmed.is_empty() {
        return Ok(cfg);
    }
    let root: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("解析自定义同义词 JSON 失败: {}", e))?;

    if let Some(arr) = root.get("dropEqCodes").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    cfg.drop_eq_codes.insert(t.to_string());
                }
            }
        }
    }
    if let Some(obj) = root.get("pruneWords").and_then(|v| v.as_object()) {
        for (code, arr) in obj {
            if let Some(list) = arr.as_array() {
                let mut set = HashSet::new();
                for w in list {
                    if let Some(ws) = w.as_str() {
                        let t = to_halfwidth(ws).trim().to_string();
                        if !t.is_empty() {
                            set.insert(t);
                        }
                    }
                }
                if !set.is_empty() {
                    cfg.prune_words.insert(code.clone(), set);
                }
            }
        }
    }
    if let Some(obj) = root.get("splitFixes").and_then(|v| v.as_object()) {
        for (k, arr) in obj {
            if let Some(list) = arr.as_array() {
                let parts: Vec<String> = list
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !parts.is_empty() {
                    cfg.split_fixes.insert(k.clone(), parts);
                }
            }
        }
    }
    if let Some(arr) = root.get("stopExpand").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(s) = v.as_str() {
                let t = to_halfwidth(s).trim().to_lowercase();
                if t.chars().count() >= 2 {
                    cfg.stop_expand.insert(t);
                }
            }
        }
    }
    if let Some(arr) = root.get("groups").and_then(|v| v.as_array()) {
        for g in arr {
            let Some(words_arr) = g.get("words").and_then(|v| v.as_array()) else {
                continue;
            };
            let raw_c5 = g.get("c5").and_then(|v| v.as_str()).unwrap_or("Zz00Z").trim();
            let c5: String = if raw_c5.chars().count() >= 5 {
                raw_c5.chars().take(5).collect()
            } else {
                "Zz00Z".to_string()
            };
            let exclusive = g.get("exclusive").and_then(|v| v.as_bool()).unwrap_or(true);
            let mut words = Vec::new();
            let mut seen = HashSet::new();
            for wn in words_arr {
                if let Some(ws) = wn.as_str() {
                    let w = to_halfwidth(ws).trim().to_string();
                    if w.chars().count() < 2 {
                        continue;
                    }
                    let k = w.to_lowercase();
                    if seen.insert(k) {
                        words.push(w);
                    }
                }
            }
            if words.len() >= 2 {
                cfg.groups.push(CustomGroup {
                    c5,
                    exclusive,
                    words,
                });
            }
        }
    }
    if let Some(obj) = root.get("aliases").and_then(|v| v.as_object()) {
        for (src_raw, arr) in obj {
            let src = to_halfwidth(src_raw).trim().to_string();
            if src.chars().count() < 2 {
                continue;
            }
            let Some(list) = arr.as_array() else {
                continue;
            };
            let sk = src.to_lowercase();
            let mut targets = Vec::new();
            let mut seen = HashSet::new();
            for tn in list {
                if let Some(ts) = tn.as_str() {
                    let tw = to_halfwidth(ts).trim().to_string();
                    if tw.chars().count() < 2 {
                        continue;
                    }
                    let tk = tw.to_lowercase();
                    if tk != sk && seen.insert(tk) {
                        targets.push(tw);
                    }
                }
            }
            if !targets.is_empty() {
                cfg.aliases.push((src, targets));
            }
        }
    }

    Ok(cfg)
}

fn tokenize_cilin_body(body: &str, split_fixes: &HashMap<String, Vec<String>>) -> Vec<String> {
    static TAIL_LATIN_RE: OnceLock<Regex> = OnceLock::new();
    let tail_re = TAIL_LATIN_RE.get_or_init(|| Regex::new(r"^([\u{4e00}-\u{9fff}]+)[a-z\.]$").unwrap());

    let mut out = Vec::new();
    for tok in body.split(|c: char| c.is_whitespace() || c == '\u{3000}') {
        if tok.is_empty() {
            continue;
        }
        if let Some(fixed) = split_fixes.get(tok) {
            out.extend(fixed.iter().cloned());
            continue;
        }
        if tok.contains('…') {
            for p in tok.split('…') {
                if !p.is_empty() {
                    out.push(p.to_string());
                }
            }
            continue;
        }
        if tok.contains('，') {
            for p in tok.split('，') {
                if !p.is_empty() {
                    out.push(p.to_string());
                }
            }
            continue;
        }
        if let Some(caps) = tail_re.captures(tok) {
            out.push(caps[1].to_string());
        } else {
            out.push(tok.to_string());
        }
    }
    out
}

#[inline]
fn has_valid_ascii_boundary(chars: &[char], start: usize, end: usize) -> bool {
    if chars[start].is_ascii_alphanumeric()
        && start > 0
        && chars[start - 1].is_ascii_alphanumeric()
    {
        return false;
    }
    if chars[end - 1].is_ascii_alphanumeric()
        && end < chars.len()
        && chars[end].is_ascii_alphanumeric()
    {
        return false;
    }
    true
}

fn fmm_extract_words(
    lower: &str,
    lexicon: &HashSet<String>,
    max_lex_len: usize,
    mut unmatched_cjk_runs: Option<&mut Vec<String>>,
) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut bounds: Vec<usize> = lower.char_indices().map(|(b, _)| b).collect();
    bounds.push(lower.len());
    let chars: Vec<char> = lower.chars().collect();
    let n = chars.len();

    let mut unmatched = String::new();
    let mut i = 0usize;
    while i < n {
        let mut matched = false;
        let max_l = max_lex_len.min(n - i);
        for l in (2..=max_l).rev() {
            if !has_valid_ascii_boundary(&chars, i, i + l) {
                continue;
            }
            let sub = &lower[bounds[i]..bounds[i + l]];
            if lexicon.contains(sub) {
                seen.insert(sub.to_string());
                if let Some(ref mut runs) = unmatched_cjk_runs {
                    if !unmatched.is_empty() {
                        runs.push(std::mem::take(&mut unmatched));
                    }
                }
                i += l;
                matched = true;
                break;
            }
        }
        if !matched {
            let ch = chars[i];
            if let Some(ref mut runs) = unmatched_cjk_runs {
                if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                    unmatched.push(ch);
                } else if !unmatched.is_empty() {
                    runs.push(std::mem::take(&mut unmatched));
                }
            }
            i += 1;
        }
    }
    if let Some(runs) = unmatched_cjk_runs {
        if !unmatched.is_empty() {
            runs.push(unmatched);
        }
    }
    seen
}

#[allow(clippy::too_many_arguments)]
fn scan_document_for_df_and_oov(
    raw_text: &str,
    lexicon: &HashSet<String>,
    max_lex_len: usize,
    ascii_stops: &HashSet<&'static str>,
    cjk_edge_stops: &HashSet<char>,
    df_map: &mut HashMap<String, usize>,
    ascii_oov: &mut HashMap<String, TokenStat>,
    cjk_oov: &mut HashMap<String, TokenStat>,
) {
    static URL_RE: OnceLock<Regex> = OnceLock::new();
    static ASCII_TOK_RE: OnceLock<Regex> = OnceLock::new();
    static SHORT_AN_RE: OnceLock<Regex> = OnceLock::new();

    let norm = to_halfwidth(raw_text);
    let lower = norm.to_lowercase();

    let mut unmatched_runs = Vec::new();
    let seen_lex = fmm_extract_words(&lower, lexicon, max_lex_len, Some(&mut unmatched_runs));
    for w in seen_lex {
        *df_map.entry(w).or_insert(0) += 1;
    }

    let url_re = URL_RE.get_or_init(|| Regex::new(r"https?://\S+").unwrap());
    let ascii_re = ASCII_TOK_RE.get_or_init(|| Regex::new(r"[A-Za-z][A-Za-z0-9_+#-]{1,23}").unwrap());
    let short_an = SHORT_AN_RE.get_or_init(|| Regex::new(r"^[a-z]\d+$").unwrap());

    let no_url = url_re.replace_all(&norm, " ");
    let bytes = no_url.as_bytes();
    let mut seen_ascii = HashSet::new();
    for m in ascii_re.find_iter(&no_url) {
        if m.start() > 0 && (bytes[m.start() - 1].is_ascii_alphanumeric() || bytes[m.start() - 1] == b'_') {
            continue;
        }
        if m.end() < bytes.len() && (bytes[m.end()].is_ascii_alphanumeric() || bytes[m.end()] == b'_') {
            continue;
        }
        let tok = m.as_str();
        let tl = tok.to_ascii_lowercase();
        if lexicon.contains(&tl) || ascii_stops.contains(tl.as_str()) || short_an.is_match(&tl) {
            continue;
        }
        if tok.len() == 2 && !tok.bytes().all(|b| b.is_ascii_uppercase()) {
            continue;
        }
        let is_new = seen_ascii.insert(tl.clone());
        ascii_oov.entry(tl).or_default().record(tok, is_new);
    }

    let mut seen_cjk = HashSet::new();
    for run in unmatched_runs {
        let rc: Vec<char> = run.chars().collect();
        let rlen = rc.len();
        if rlen < 2 {
            continue;
        }
        let max_gram = 4.min(rlen);
        for l in 2..=max_gram {
            for start in 0..=(rlen - l) {
                if cjk_edge_stops.contains(&rc[start]) || cjk_edge_stops.contains(&rc[start + l - 1]) {
                    continue;
                }
                let gram: String = rc[start..start + l].iter().collect();
                if lexicon.contains(&gram) {
                    continue;
                }
                let is_new = seen_cjk.insert(gram.clone());
                cjk_oov.entry(gram.clone()).or_default().record(&gram, is_new);
            }
        }
    }
}

fn collect_public_media_titles(node: &Value, out: &mut Vec<String>) {
    let Some(map) = node.as_object() else {
        return;
    };
    if let Some(arr) = map.get("_f").and_then(|v| v.as_array()) {
        for item in arr {
            let Some(lst) = item.as_array() else {
                continue;
            };
            let file_name = lst.first().and_then(|v| v.as_str()).unwrap_or("");
            let info = lst.get(3).and_then(|v| v.as_str()).unwrap_or("");
            if file_name.is_empty() || info.contains("localOnly") {
                continue;
            }
            let title = match file_name.rfind('.') {
                Some(dot) if dot > 0 => &file_name[..dot],
                _ => file_name,
            };
            if title.chars().count() >= 2 {
                out.push(title.to_string());
            }
        }
    }
    for (k, v) in map {
        if k != "_f" {
            collect_public_media_titles(v, out);
        }
    }
}

pub fn read_oov_report(cfg: &ServerConfig) -> String {
    if cfg.oov_report_file.is_file() {
        if let Ok(s) = fs::read_to_string(&cfg.oov_report_file) {
            return s;
        }
    }
    "（尚未生成新词雷达报告，请先执行一次「gen」或点击「重建 synonyms.js」）".to_string()
}

fn load_cilin_text(cfg: &ServerConfig) -> Result<Option<String>, String> {
    for path in [&cfg.cilin_file, &cfg.legacy_cilin_file] {
        if path.is_file() {
            let raw = fs::read_to_string(path)
                .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
            if !raw.trim().is_empty() {
                return Ok(Some(raw));
            }
        }
    }
    Ok(None)
}

fn render_oov_report(
    total_public_docs: usize,
    ascii_oov: &HashMap<String, TokenStat>,
    cjk_oov: &HashMap<String, TokenStat>,
) -> String {

    let min_df = if total_public_docs >= 50 { 2 } else { 1 };
    let min_tf = if total_public_docs >= 50 { 3 } else { 2 };

    let mut asc_list: Vec<&TokenStat> = ascii_oov
        .values()
        .filter(|s| s.df >= min_df && s.tf >= min_tf)
        .collect();
    asc_list.sort_by(|a, b| {
        b.df.cmp(&a.df)
            .then_with(|| b.tf.cmp(&a.tf))
            .then_with(|| a.display.to_ascii_lowercase().cmp(&b.display.to_ascii_lowercase()))
    });

    let mut cjk_raw: Vec<&TokenStat> = cjk_oov
        .values()
        .filter(|s| s.df >= min_df && s.tf >= min_tf)
        .collect();
    cjk_raw.sort_by(|a, b| {
        b.df.cmp(&a.df)
            .then_with(|| b.tf.cmp(&a.tf))
            .then_with(|| b.display.chars().count().cmp(&a.display.chars().count()))
    });

    let mut cjk_filtered: Vec<&TokenStat> = Vec::new();
    for cand in cjk_raw {
        let cand_len = cand.display.chars().count();
        let absorbed = cjk_filtered.iter().any(|kept| {
            kept.display.chars().count() > cand_len
                && kept.display.contains(&cand.display)
                && (kept.tf as f64) >= (cand.tf as f64) * 0.7
        });
        if !absorbed {
            cjk_filtered.push(cand);
            if cjk_filtered.len() >= 80 {
                break;
            }
        }
    }

    let now = Local::now().format("%Y-%m-%d %H:%M:%S");
    let mut sb = String::new();
    sb.push_str("# 本地新词雷达报告 (oov_report.txt) — 仅本地参考，请勿提交或发布\n");
    sb.push_str(&format!(
        "# 生成时间: {} | 公开统计文档数: {} | 筛选阈值: DF >= {}, TF >= {}\n",
        now, total_public_docs, min_df, min_tf
    ));
    sb.push_str("# 用法: 挑出值得扩展的高频词，直接在左侧编辑区补入 groups 或 aliases 并保存重建即可。\n\n");

    sb.push_str("== [1] 高频未收录英文/技术术语 Top 60 ==\n");
    let asc_limit = 60.min(asc_list.len());
    for (idx, s) in asc_list.iter().take(asc_limit).enumerate() {
        sb.push_str(&format!(
            "{:2}. {:<24} DF={:<4} TF={}\n",
            idx + 1,
            s.display,
            s.df,
            s.tf
        ));
    }
    if asc_limit == 0 {
        sb.push_str("(暂无达到阈值的候选词)\n");
    }

    sb.push_str("\n== [2] 高频未收录中文候选词 Top 60 ==\n");
    let cjk_limit = 60.min(cjk_filtered.len());
    for (idx, s) in cjk_filtered.iter().take(cjk_limit).enumerate() {
        sb.push_str(&format!(
            "{:2}. {:<10} DF={:<4} TF={}\n",
            idx + 1,
            s.display,
            s.df,
            s.tf
        ));
    }
    if cjk_limit == 0 {
        sb.push_str("(暂无达到阈值的候选词)\n");
    }

    sb
}

pub fn prepare_if_needed(
    cfg: &ServerConfig,
    public_docs_for_df: &BTreeMap<i64, String>,
    lite_data_tree: &Value,
    force: bool,
    logs: Option<&LogBus>,
) -> Result<Option<PreparedSynonyms>, String> {
    let Some(raw_cilin) = load_cilin_text(cfg)? else {
        log_warn(
            logs,
            format!(
                "[Synonyms] 未找到 {}，跳过 synonyms.js 自动生成。",
                cfg.cilin_file.display()
            ),
        );
        return Ok(None);
    };

    let custom_raw = crate::config::read_synonyms_custom_json(cfg);
    let custom = load_custom_config_from_str(&custom_raw)?;

    let mut blocked_from_cilin_eq = custom.stop_expand.clone();
    for g in &custom.groups {
        if g.exclusive {
            for w in &g.words {
                blocked_from_cilin_eq.insert(w.to_lowercase());
            }
        }
    }

    let mut cilin_entries: Vec<CilinEntry> = Vec::with_capacity(17000);
    let mut demoted_by_c5: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut lexicon: HashSet<String> = HashSet::with_capacity(80000);
    let mut max_lex_len: usize = 2;

    for raw_line in raw_cilin.strip_prefix('\u{FEFF}').unwrap_or(&raw_cilin).lines() {
        let line = raw_line.trim();
        let line_chars: Vec<char> = line.chars().collect();
        if line_chars.len() < 9 {
            continue;
        }
        let code7: String = line_chars[0..7].iter().collect();
        let rel = line_chars[7];
        if rel != '=' && rel != '#' && rel != '@' {
            continue;
        }
        let body: String = line_chars[8..].iter().collect();
        let body = body.trim();
        if body.is_empty() {
            continue;
        }

        let raw_tokens = tokenize_cilin_body(body, &custom.split_fixes);
        let prune_set = custom.prune_words.get(&code7);
        let mut words = Vec::with_capacity(raw_tokens.len());
        let mut seen = HashSet::new();

        for tok in raw_tokens {
            let norm = to_halfwidth(&tok).trim().to_string();
            if norm.chars().count() < 2 {
                continue;
            }
            if prune_set.map(|s| s.contains(&norm)).unwrap_or(false) {
                continue;
            }
            let k = norm.to_lowercase();
            if !seen.insert(k.clone()) {
                continue;
            }
            if rel == '=' && blocked_from_cilin_eq.contains(&k) {
                let c5: String = code7.chars().take(5).collect();
                demoted_by_c5.entry(c5).or_default().push(norm);
                continue;
            }
            words.push(norm);
        }

        if words.is_empty() {
            continue;
        }
        let mut out_rel = rel;
        if rel == '=' && (custom.drop_eq_codes.contains(&code7) || words.len() < 2) {
            out_rel = '@';
        }
        for w in &words {
            let k = w.to_lowercase();
            let clen = k.chars().count();
            if clen > max_lex_len && clen <= 12 {
                max_lex_len = clen;
            }
            lexicon.insert(k);
        }
        cilin_entries.push(CilinEntry {
            code7,
            rel: out_rel,
            words,
        });
    }

    for (c5, ws) in demoted_by_c5 {
        let mut dedup = Vec::new();
        let mut seen = HashSet::new();
        for w in ws {
            let k = w.to_lowercase();
            if seen.insert(k.clone()) {
                let clen = k.chars().count();
                if clen > max_lex_len && clen <= 12 {
                    max_lex_len = clen;
                }
                lexicon.insert(k);
                dedup.push(w);
            }
        }
        if !dedup.is_empty() {
            cilin_entries.push(CilinEntry {
                code7: format!("{}99", c5),
                rel: '@',
                words: dedup,
            });
        }
    }

    for g in &custom.groups {
        for w in &g.words {
            let k = w.to_lowercase();
            let clen = k.chars().count();
            if clen > max_lex_len && clen <= 12 {
                max_lex_len = clen;
            }
            lexicon.insert(k);
        }
    }
    for (src, targets) in &custom.aliases {
        let sk = src.to_lowercase();
        let sclen = sk.chars().count();
        if sclen > max_lex_len && sclen <= 12 {
            max_lex_len = sclen;
        }
        lexicon.insert(sk);
        for tw in targets {
            let tk = tw.to_lowercase();
            let tclen = tk.chars().count();
            if tclen > max_lex_len && tclen <= 12 {
                max_lex_len = tclen;
            }
            lexicon.insert(tk);
        }
    }

    let ascii_stops: HashSet<&'static str> = ASCII_STOP_WORDS.iter().copied().collect();
    let cjk_edge_stops: HashSet<char> = CJK_EDGE_STOP_CHARS.chars().collect();
    let mut df_map: HashMap<String, usize> = HashMap::with_capacity(16384);
    let mut ascii_oov: HashMap<String, TokenStat> = HashMap::new();
    let mut cjk_oov: HashMap<String, TokenStat> = HashMap::new();
    let mut total_public_docs = 0usize;

    for raw_text in public_docs_for_df.values() {
        if raw_text.trim().is_empty() {
            continue;
        }
        total_public_docs += 1;
        scan_document_for_df_and_oov(
            raw_text,
            &lexicon,
            max_lex_len,
            &ascii_stops,
            &cjk_edge_stops,
            &mut df_map,
            &mut ascii_oov,
            &mut cjk_oov,
        );
    }

    let mut public_media_titles = Vec::new();
    for bucket in ["image", "audio", "video", "ebook"] {
        if let Some(branch) = lite_data_tree.get(bucket) {
            collect_public_media_titles(branch, &mut public_media_titles);
        }
    }
    for media_title in public_media_titles {
        let lower = to_halfwidth(&media_title).to_lowercase();
        let hits = fmm_extract_words(&lower, &lexicon, max_lex_len, None);
        for w in hits {
            df_map.entry(w).or_insert(1);
        }
    }

    let oov_report = render_oov_report(total_public_docs, &ascii_oov, &cjk_oov);

    let mut cilin_raw = String::with_capacity(900 * 1024);
    for (idx, entry) in cilin_entries.iter().enumerate() {
        if idx > 0 {
            cilin_raw.push('\n');
        }
        cilin_raw.push_str(&entry.code7);
        cilin_raw.push(entry.rel);
        cilin_raw.push('|');
        for (j, w) in entry.words.iter().enumerate() {
            if j > 0 {
                cilin_raw.push(' ');
            }
            let df = df_map.get(&w.to_lowercase()).copied().unwrap_or(0);
            let bucket = df_to_bucket(df, total_public_docs);
            cilin_raw.push_str(&escape_template_literal(w));
            if bucket > 0 {
                cilin_raw.push(':');
                cilin_raw.push((b'0' + bucket) as char);
            }
        }
    }

    let groups_out: Vec<Value> = custom
        .groups
        .iter()
        .map(|g| json!({ "c5": g.c5, "words": g.words }))
        .collect();
    let mut aliases_obj = serde_json::Map::new();
    for (k, v) in &custom.aliases {
        aliases_obj.insert(k.clone(), json!(v));
    }

    let version_json = serde_json::to_string(SYN_ALGO_VERSION).unwrap();
    let groups_json = safe_json_for_js(&serde_json::to_string(&groups_out).unwrap());
    let aliases_json = safe_json_for_js(&serde_json::to_string(&Value::Object(aliases_obj)).unwrap());

    let raw_js = SYNONYMS_TPL_JS
        .replace("__SYN_ALGO_VERSION__", &version_json)
        .replace("__CUSTOM_SYNONYM_GROUPS__", &groups_json)
        .replace("__CUSTOM_ONEWAY_ALIASES__", &aliases_json)
        .replace("__CILIN_RAW_DATA__", &cilin_raw);

    let raw_sha = sha256_hex(raw_js.as_bytes());
    let out_path = cfg.js_out_dir.join("synonyms.js");
    let sha_state_file = &cfg.synonyms_sha_file;

    if !force && out_path.is_file() && sha_state_file.is_file() {
        if let Ok(saved) = fs::read_to_string(sha_state_file) {
            if let Some((saved_raw, saved_out)) = saved.trim().split_once('|') {
                if saved_raw == raw_sha {
                    if let Ok(cur_out_bytes) = fs::read(&out_path) {
                        if sha256_hex(&cur_out_bytes) == saved_out {
                            return Ok(Some(PreparedSynonyms {
                                oov_report,
                                staged_js: None,
                            }));
                        }
                    }
                }
            }
        }
    }

    let minified_js = minify_js(&raw_js)
        .map_err(|e| format!("synonyms.js 内置 JS 压缩失败，已中止写出: {}", e))?;
    let out_sha = sha256_hex(minified_js.as_bytes());

    Ok(Some(PreparedSynonyms {
        oov_report,
        staged_js: Some(StagedSynonymsJs {
            out_path,
            minified_js,
            raw_sha,
            out_sha,
            total_public_docs,
        }),
    }))
}

pub fn commit_prepared(
    cfg: &ServerConfig,
    prepared: &PreparedSynonyms,
    logs: Option<&LogBus>,
) -> Result<bool, String> {
    if let Some(parent) = cfg.oov_report_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = write_atomic(&cfg.oov_report_file, &prepared.oov_report, false);

    let Some(ref staged) = prepared.staged_js else {
        return Ok(false);
    };

    if let Some(parent) = staged.out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 synonyms.js 目录失败: {}", e))?;
    }
    write_atomic(&staged.out_path, &staged.minified_js, false)?;

    if let Some(p) = cfg.synonyms_sha_file.parent() {
        let _ = fs::create_dir_all(p);
    }
    let _ = write_atomic(
        &cfg.synonyms_sha_file,
        &format!("{}|{}", staged.raw_sha, staged.out_sha),
        false,
    );

    log_info(
        logs,
        format!(
            "[Synonyms] 已生成 {} ({} bytes, 公开文档 {})",
            staged.out_path.display(),
            staged.minified_js.len(),
            staged.total_public_docs
        ),
    );
    Ok(true)
}

