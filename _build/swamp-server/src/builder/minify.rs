use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::api_files::write_atomic;
use crate::builder::log_info;
use crate::config::ServerConfig;
use crate::services::log_bus::LogBus;

pub const MINIFIER_VERSION: &str = "swamp-min-v3";

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TokKind {
    Word,
    Prop,
    Num,
    Str,
    Tpl,
    Regex,
    Punct,
}

fn is_ident_start(ch: char) -> bool {
    ch.is_alphabetic() || ch == '_' || ch == '$' || (ch as u32) >= 0x80
}

fn is_ident_part(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$' || (ch as u32) >= 0x80
}

fn is_regex_preceding_keyword(w: &str) -> bool {
    matches!(
        w,
        "return"
            | "case"
            | "throw"
            | "in"
            | "instanceof"
            | "typeof"
            | "void"
            | "delete"
            | "new"
            | "else"
            | "do"
            | "of"
            | "await"
            | "yield"
            | "export"
            | "default"
    )
}

fn is_ctrl_keyword(w: &str) -> bool {
    matches!(w, "if" | "while" | "for" | "with")
}

fn is_safe_drop_nl_after_punct(p: &str) -> bool {
    matches!(
        p,
        ";" | "{"
            | ","
            | "("
            | "["
            | "?"
            | ":"
            | "="
            | "&&"
            | "||"
            | "??"
            | "=>"
            | "*"
            | "%"
            | "&"
            | "|"
            | "^"
            | "<"
            | ">"
            | "<="
            | ">="
            | "=="
            | "!="
            | "==="
            | "!=="
            | "+="
            | "-="
            | "*="
            | "/="
            | "%="
            | "&&="
            | "||="
            | "??="
            | "**"
            | "<<"
            | ">>"
            | ">>>"
            | "?."
            | "${"
    )
}

fn is_safe_drop_nl_after_rbrace_before(kind: TokKind, val: &str) -> bool {
    match kind {
        // 不包含 "while"：防止 `const f = () => {}\nwhile (cond) {}` 去换行后产生 SyntaxError
        TokKind::Word => matches!(val, "else" | "catch" | "finally"),
        TokKind::Punct => matches!(val, "," | ";" | ")" | "]" | "}"),
        _ => false,
    }
}

struct JsMinState {
    out: String,
    prev_kind: Option<TokKind>,
    prev_val: String,
    had_nl: bool,
    after_for_await: bool,
}

impl JsMinState {
    fn new(cap: usize) -> Self {
        Self {
            out: String::with_capacity(cap),
            prev_kind: None,
            prev_val: String::new(),
            had_nl: false,
            after_for_await: false,
        }
    }

    fn regex_allowed(&self) -> bool {
        match self.prev_kind {
            None => true,
            Some(TokKind::Word) => is_regex_preceding_keyword(&self.prev_val),
            Some(TokKind::Prop | TokKind::Num | TokKind::Str | TokKind::Tpl | TokKind::Regex) => {
                false
            }
            Some(TokKind::Punct) => {
                if self.prev_val == ")ctrl" {
                    true
                } else if matches!(self.prev_val.as_str(), "++" | "--") {
                    self.had_nl
                } else {
                    !matches!(self.prev_val.as_str(), ")" | "]")
                }
            }
        }
    }

    fn is_after_dot(&self) -> bool {
        self.prev_kind == Some(TokKind::Punct) && (self.prev_val == "." || self.prev_val == "?.")
    }

    fn is_after_ctrl_keyword(&self) -> bool {
        (self.prev_kind == Some(TokKind::Word) && is_ctrl_keyword(&self.prev_val))
            || self.after_for_await
    }

    fn emit(&mut self, kind: TokKind, val: &str, raw_text: &str) {
        if let Some(pk) = self.prev_kind {
            let mut emit_nl = false;
            if self.had_nl {
                let pv = if self.prev_val == ")ctrl" {
                    ")"
                } else {
                    self.prev_val.as_str()
                };
                if pk == TokKind::Punct && is_safe_drop_nl_after_punct(pv) {
                    emit_nl = false;
                } else if pk == TokKind::Punct
                    && pv == "}"
                    && is_safe_drop_nl_after_rbrace_before(kind, val)
                {
                    emit_nl = false;
                } else {
                    emit_nl = true;
                }
            }

            if emit_nl {
                self.out.push('\n');
            } else if let (Some(last_ch), Some(first_ch)) =
                (self.out.chars().last(), raw_text.chars().next())
            {
                let need_sp = (is_ident_part(last_ch) && is_ident_part(first_ch))
                    || (pk == TokKind::Word && kind == TokKind::Regex)
                    || (pk == TokKind::Word && first_ch == '#')
                    || (last_ch == '+' && first_ch == '+')
                    || (last_ch == '-' && first_ch == '-')
                    || (last_ch == '!' && raw_text.starts_with("--") && self.out.ends_with("<!"))
                    || (last_ch == '-' && first_ch == '>' && self.out.ends_with("--"))
                    || (last_ch == '/' && (first_ch == '/' || first_ch == '*'))
                    || (pk == TokKind::Num && first_ch == '.');
                if need_sp {
                    self.out.push(' ');
                }
            }
        }
        let next_for_await = self.prev_kind == Some(TokKind::Word)
            && self.prev_val == "for"
            && kind == TokKind::Word
            && val == "await";
        self.out.push_str(raw_text);
        self.prev_kind = Some(kind);
        self.prev_val.clear();
        self.prev_val.push_str(val);
        self.had_nl = false;
        self.after_for_await = next_for_await;
    }
}

fn scan_template_part(chars: &[char], start_i: usize) -> Result<(usize, String, bool), String> {
    let n = chars.len();
    let mut j = start_i;
    let mut buf = String::new();
    while j < n {
        let ch = chars[j];
        if ch == '\\' && j + 1 < n {
            buf.push(ch);
            buf.push(chars[j + 1]);
            j += 2;
            continue;
        }
        if ch == '`' {
            buf.push('`');
            return Ok((j + 1, buf, false));
        }
        if ch == '$' && j + 1 < n && chars[j + 1] == '{' {
            buf.push_str("${");
            return Ok((j + 2, buf, true));
        }
        buf.push(ch);
        j += 1;
    }
    Err(format!("未闭合的模板字面量 (char offset {})", start_i))
}

/// 纯 Rust ES2020 安全 JS 压缩器（完整处理字符串、嵌套模板字面量、正则与除法消歧、BigInt、可选链与 ASI 换行保护）
pub fn minify_js(src: &str) -> Result<String, String> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut i = 0usize;

    let mut st = JsMinState::new(src.len());
    let mut paren_stack: Vec<bool> = Vec::new();
    let mut tpl_stack: Vec<usize> = Vec::new();

    while i < n {
        let ch = chars[i];

        if matches!(
            ch,
            ' ' | '\t' | '\r' | '\n' | '\u{000B}' | '\u{000C}' | '\u{FEFF}'
        ) {
            if ch == '\n' || ch == '\r' {
                st.had_nl = true;
            }
            i += 1;
            continue;
        }

        if ch == '/' && i + 1 < n && chars[i + 1] == '/' {
            i += 2;
            while i < n && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
            st.had_nl = true;
            continue;
        }

        if ch == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' || chars[i] == '\r' {
                    st.had_nl = true;
                }
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }

        if ch == '\'' || ch == '"' {
            let quote = ch;
            let mut j = i + 1;
            let mut closed = false;
            while j < n {
                if chars[j] == '\\' && j + 1 < n {
                    j += 2;
                    continue;
                }
                if chars[j] == quote {
                    j += 1;
                    closed = true;
                    break;
                }
                j += 1;
            }
            if !closed {
                return Err(format!("未闭合的字符串字面量 (char offset {})", i));
            }
            let raw: String = chars[i..j].iter().collect();
            st.emit(TokKind::Str, &raw, &raw);
            i = j;
            continue;
        }

        if ch == '`' {
            let (next_i, part, has_expr) = scan_template_part(&chars, i + 1)?;
            let mut raw = String::with_capacity(part.len() + 1);
            raw.push('`');
            raw.push_str(&part);
            if has_expr {
                st.emit(TokKind::Punct, "${", &raw);
                tpl_stack.push(0);
            } else {
                st.emit(TokKind::Tpl, &raw, &raw);
            }
            i = next_i;
            continue;
        }

        if ch == '}' && tpl_stack.last() == Some(&0) {
            tpl_stack.pop();
            let (next_i, part, has_expr) = scan_template_part(&chars, i + 1)?;
            let mut raw = String::with_capacity(part.len() + 1);
            raw.push('}');
            raw.push_str(&part);
            if has_expr {
                st.emit(TokKind::Punct, "${", &raw);
                tpl_stack.push(0);
            } else {
                st.emit(TokKind::Tpl, &raw, &raw);
            }
            i = next_i;
            continue;
        }

        if ch == '/' && st.regex_allowed() {
            let mut j = i + 1;
            let mut in_cc = false;
            let mut closed = false;
            while j < n {
                let rc = chars[j];
                if rc == '\\' && j + 1 < n {
                    j += 2;
                    continue;
                }
                if rc == '[' {
                    in_cc = true;
                } else if rc == ']' {
                    in_cc = false;
                } else if rc == '/' && !in_cc {
                    j += 1;
                    closed = true;
                    break;
                } else if rc == '\n' || rc == '\r' {
                    return Err(format!("正则字面量内出现非法换行 (char offset {})", i));
                }
                j += 1;
            }
            if !closed {
                return Err(format!("未闭合的正则字面量 (char offset {})", i));
            }
            while j < n && chars[j].is_ascii_alphabetic() {
                j += 1;
            }
            let raw: String = chars[i..j].iter().collect();
            st.emit(TokKind::Regex, &raw, &raw);
            i = j;
            continue;
        }

        if ch == '#' && i + 1 < n && is_ident_start(chars[i + 1]) {
            let mut j = i + 2;
            while j < n && is_ident_part(chars[j]) {
                j += 1;
            }
            let priv_ident: String = chars[i..j].iter().collect();
            st.emit(TokKind::Prop, &priv_ident, &priv_ident);
            i = j;
            continue;
        }

        if is_ident_start(ch) {
            let mut j = i + 1;
            while j < n && is_ident_part(chars[j]) {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect();
            let kind = if st.is_after_dot() {
                TokKind::Prop
            } else {
                TokKind::Word
            };
            st.emit(kind, &word, &word);
            i = j;
            continue;
        }

        if ch.is_ascii_digit() || (ch == '.' && i + 1 < n && chars[i + 1].is_ascii_digit()) {
            let mut j = i;
            if ch == '0' && j + 1 < n && matches!(chars[j + 1], 'x' | 'X' | 'b' | 'B' | 'o' | 'O') {
                j += 2;
                while j < n && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
            } else {
                while j < n && (chars[j].is_ascii_digit() || chars[j] == '_') {
                    j += 1;
                }
                if j < n && chars[j] == '.' {
                    j += 1;
                    while j < n && (chars[j].is_ascii_digit() || chars[j] == '_') {
                        j += 1;
                    }
                }
                if j < n && (chars[j] == 'e' || chars[j] == 'E') {
                    j += 1;
                    if j < n && (chars[j] == '+' || chars[j] == '-') {
                        j += 1;
                    }
                    while j < n && (chars[j].is_ascii_digit() || chars[j] == '_') {
                        j += 1;
                    }
                }
            }
            if j < n && chars[j] == 'n' {
                j += 1;
            }
            let raw: String = chars[i..j].iter().collect();
            st.emit(TokKind::Num, &raw, &raw);
            i = j;
            continue;
        }

        let mut matched: Option<&'static str> = None;
        if i + 4 <= n && chars[i] == '>' && chars[i + 1] == '>' && chars[i + 2] == '>' && chars[i + 3] == '=' {
            matched = Some(">>>=");
        } else if i + 3 <= n {
            let s3: [char; 3] = [chars[i], chars[i + 1], chars[i + 2]];
            matched = match s3 {
                ['=', '=', '='] => Some("==="),
                ['!', '=', '='] => Some("!=="),
                ['>', '>', '>'] => Some(">>>"),
                ['.', '.', '.'] => Some("..."),
                ['*', '*', '='] => Some("**="),
                ['<', '<', '='] => Some("<<="),
                ['>', '>', '='] => Some(">>="),
                ['&', '&', '='] => Some("&&="),
                ['|', '|', '='] => Some("||="),
                ['?', '?', '='] => Some("??="),
                _ => None,
            };
        }
        if matched.is_none() && i + 2 <= n {
            let s2: [char; 2] = [chars[i], chars[i + 1]];
            matched = match s2 {
                ['=', '='] => Some("=="),
                ['!', '='] => Some("!="),
                ['<', '='] => Some("<="),
                ['>', '='] => Some(">="),
                ['&', '&'] => Some("&&"),
                ['|', '|'] => Some("||"),
                ['?', '?'] => Some("??"),
                ['=', '>'] => Some("=>"),
                ['+', '+'] => Some("++"),
                ['-', '-'] => Some("--"),
                ['*', '*'] => Some("**"),
                ['<', '<'] => Some("<<"),
                ['>', '>'] => Some(">>"),
                ['+', '='] => Some("+="),
                ['-', '='] => Some("-="),
                ['*', '='] => Some("*="),
                ['/', '='] => Some("/="),
                ['%', '='] => Some("%="),
                ['&', '='] => Some("&="),
                ['|', '='] => Some("|="),
                ['^', '='] => Some("^="),
                ['?', '.'] if i + 2 >= n || !chars[i + 2].is_ascii_digit() => Some("?."),
                _ => None,
            };
        }

        if let Some(op) = matched {
            st.emit(TokKind::Punct, op, op);
            i += op.len();
            continue;
        }

        match ch {
            '(' => {
                let is_ctrl = st.is_after_ctrl_keyword();
                paren_stack.push(is_ctrl);
                st.emit(TokKind::Punct, "(", "(");
            }
            ')' => {
                let is_ctrl = paren_stack.pop().unwrap_or(false);
                st.emit(TokKind::Punct, if is_ctrl { ")ctrl" } else { ")" }, ")");
            }
            '{' => {
                if let Some(depth) = tpl_stack.last_mut() {
                    *depth += 1;
                }
                st.emit(TokKind::Punct, "{", "{");
            }
            '}' => {
                if let Some(depth) = tpl_stack.last_mut() {
                    if *depth > 0 {
                        *depth -= 1;
                    }
                }
                st.emit(TokKind::Punct, "}", "}");
            }
            other => {
                let mut buf = [0u8; 4];
                let s = other.encode_utf8(&mut buf);
                st.emit(TokKind::Punct, s, s);
            }
        }
        i += 1;
    }

    if !tpl_stack.is_empty() {
        return Err("存在未闭合的模板字面量插值块".to_string());
    }

    Ok(st.out)
}

/// 纯 Rust 安全 CSS 压缩器（保留字符串、url(...)、calc(...) 运算符空格及后代伪类前空格）
pub fn minify_css(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut i = 0usize;
    let mut out = String::with_capacity(src.len());
    let mut pending_space = false;

    while i < n {
        let ch = chars[i];

        if ch == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            if !out.is_empty() {
                pending_space = true;
            }
            continue;
        }

        if ch == '\'' || ch == '"' {
            if pending_space {
                if let Some(last) = out.chars().last() {
                    if !matches!(last, '{' | '}' | ';' | ':' | ',' | '(') {
                        out.push(' ');
                    }
                }
                pending_space = false;
            }
            let q = ch;
            out.push(q);
            i += 1;
            while i < n {
                let c = chars[i];
                out.push(c);
                i += 1;
                if c == '\\' && i < n {
                    out.push(chars[i]);
                    i += 1;
                    continue;
                }
                if c == q {
                    break;
                }
            }
            continue;
        }

        if (ch == 'u' || ch == 'U')
            && i + 4 <= n
            && (chars[i + 1] == 'r' || chars[i + 1] == 'R')
            && (chars[i + 2] == 'l' || chars[i + 2] == 'L')
            && chars[i + 3] == '('
        {
            if pending_space {
                if let Some(last) = out.chars().last() {
                    if !matches!(last, '{' | '}' | ';' | ':' | ',' | '(') {
                        out.push(' ');
                    }
                }
                pending_space = false;
            }
            out.push_str("url(");
            i += 4;
            let mut in_q: Option<char> = None;
            while i < n {
                let c = chars[i];
                out.push(c);
                i += 1;
                if let Some(q) = in_q {
                    if c == '\\' && i < n {
                        out.push(chars[i]);
                        i += 1;
                    } else if c == q {
                        in_q = None;
                    }
                } else if c == '\'' || c == '"' {
                    in_q = Some(c);
                } else if c == ')' {
                    break;
                }
            }
            continue;
        }

        if ch == '\\' && i + 1 < n {
            if pending_space {
                if let Some(last) = out.chars().last() {
                    if !matches!(last, '{' | '}' | ';' | ':' | ',' | '(') {
                        out.push(' ');
                    }
                }
                pending_space = false;
            }
            out.push(ch);
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }

        if ch.is_whitespace() {
            pending_space = true;
            i += 1;
            continue;
        }

        if matches!(ch, '{' | '}' | ';' | ',') {
            if matches!(ch, ';' | '}') && pending_space && out.ends_with(':') {
                // 保留 CSS 空自定义属性值（如 `--foo: ;` 或块尾 `--foo: }`）所需的单个空格
                out.push(' ');
            } else if ch == '}' && out.ends_with(';') && !out.ends_with(": ;") {
                out.pop();
            }
            pending_space = false;
            out.push(ch);
            i += 1;
            continue;
        }

        if pending_space {
            if let Some(last) = out.chars().last() {
                if !matches!(last, '{' | '}' | ';' | ':' | ',' | '(') {
                    out.push(' ');
                }
            }
            pending_space = false;
        }

        out.push(ch);
        i += 1;
    }

    out
}

pub struct IncrementalLedger {
    ledger_path: PathBuf,
    old_hashes: BTreeMap<String, String>,
    new_hashes: BTreeMap<String, String>,
}

impl IncrementalLedger {
    pub fn load(cfg: &ServerConfig) -> Self {
        let ledger_path = cfg.backup_dir.join("build_hashes.txt");
        let mut old_hashes = BTreeMap::new();
        if let Ok(text) = fs::read_to_string(&ledger_path) {
            for line in text.lines() {
                if let Some((k, v)) = line.split_once('|') {
                    old_hashes.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
        }
        Self {
            ledger_path,
            new_hashes: old_hashes.clone(),
            old_hashes,
        }
    }

    pub fn is_up_to_date(&self, key: &str, raw_hash: &str, out_path: &Path) -> Option<String> {
        let saved = self.old_hashes.get(key)?;
        let mut parts = saved.split('|');
        let ver = parts.next()?;
        let saved_raw = parts.next()?;
        let saved_out = parts.next()?;
        if ver != MINIFIER_VERSION || saved_raw != raw_hash {
            return None;
        }
        let out_bytes = fs::read(out_path).ok()?;
        if sha256_hex(&out_bytes) == saved_out {
            Some(saved_out.to_string())
        } else {
            None
        }
    }

    pub fn record(&mut self, key: String, raw_hash: &str, out_hash: &str) {
        self.new_hashes.insert(
            key,
            format!("{}|{}|{}", MINIFIER_VERSION, raw_hash, out_hash),
        );
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.ledger_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建增量账本目录失败: {}", e))?;
        }
        let mut body = String::new();
        for (k, v) in &self.new_hashes {
            body.push_str(k);
            body.push('|');
            body.push_str(v);
            body.push('\n');
        }
        write_atomic(&self.ledger_path, &body, false)
    }
}

struct MinifyJob {
    key: String,
    src_path: PathBuf,
    out_path: PathBuf,
    is_css: bool,
}

fn run_jobs(
    jobs: Vec<MinifyJob>,
    ledger: &mut IncrementalLedger,
    logs: Option<&LogBus>,
) -> Result<(usize, usize), String> {
    let results: Vec<Result<(String, String, String, bool), String>> = jobs
        .into_par_iter()
        .map(|job| {
            let raw_bytes = fs::read(&job.src_path)
                .map_err(|e| format!("读取 {} 失败: {}", job.src_path.display(), e))?;
            let raw_hash = sha256_hex(&raw_bytes);
            if let Some(out_hash) = ledger.is_up_to_date(&job.key, &raw_hash, &job.out_path) {
                return Ok((job.key, raw_hash, out_hash, false));
            }
            let raw_text = String::from_utf8(raw_bytes)
                .map_err(|e| format!("{} 非 UTF-8 编码: {}", job.src_path.display(), e))?;
            let clean = raw_text.strip_prefix('\u{FEFF}').unwrap_or(&raw_text);
            let minified = if job.is_css {
                minify_css(clean)
            } else {
                minify_js(clean)
                    .map_err(|e| format!("JS 压缩失败 ({}): {}", job.key, e))?
            };
            let out_hash = sha256_hex(minified.as_bytes());
            if let Some(parent) = job.out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("创建输出目录失败: {}", e))?;
            }
            write_atomic(&job.out_path, &minified, false)?;
            Ok((job.key, raw_hash, out_hash, true))
        })
        .collect();

    let mut built = 0usize;
    let mut skipped = 0usize;
    for res in results {
        let (key, raw_hash, out_hash, did_build) = res?;
        if did_build {
            built += 1;
            log_info(logs, format!("[minify] 更新 {}", key));
        } else {
            skipped += 1;
        }
        ledger.record(key, &raw_hash, &out_hash);
    }
    Ok((built, skipped))
}

pub fn build_phase1_assets(
    cfg: &ServerConfig,
    ledger: &mut IncrementalLedger,
    logs: Option<&LogBus>,
) -> Result<(), String> {
    let mut jobs = Vec::new();

    if cfg.js_raw_dir.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&cfg.js_raw_dir)
            .map_err(|e| format!("读取 {} 失败: {}", cfg.js_raw_dir.display(), e))?
            .filter_map(|e| e.ok().map(|x| x.path()))
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .map(|s| s.eq_ignore_ascii_case("js"))
                        .unwrap_or(false)
            })
            .collect();
        entries.sort();
        for p in entries {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if matches!(name.as_str(), "core-list.js" | "sw.js" | "synonyms.js") {
                continue;
            }
            jobs.push(MinifyJob {
                key: format!("js/{}", name),
                out_path: cfg.js_out_dir.join(&name),
                src_path: p,
                is_css: false,
            });
        }
    }

    if cfg.css_raw_dir.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&cfg.css_raw_dir)
            .map_err(|e| format!("读取 {} 失败: {}", cfg.css_raw_dir.display(), e))?
            .filter_map(|e| e.ok().map(|x| x.path()))
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .map(|s| s.eq_ignore_ascii_case("css"))
                        .unwrap_or(false)
            })
            .collect();
        entries.sort();
        for p in entries {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("font.css") {
                continue;
            }
            jobs.push(MinifyJob {
                key: format!("css/{}", name),
                out_path: cfg.css_out_dir.join(&name),
                src_path: p,
                is_css: true,
            });
        }
    }

    if cfg.font_raw_css.is_file() {
        jobs.push(MinifyJob {
            key: "css/font.css".to_string(),
            src_path: cfg.font_raw_css.clone(),
            out_path: cfg.font_out_css.clone(),
            is_css: true,
        });
    }

    let active_keys: HashSet<String> = jobs.iter().map(|j| j.key.clone()).collect();
    let stale_keys: Vec<String> = ledger
        .old_hashes
        .keys()
        .filter(|k| {
            !active_keys.contains(k.as_str())
                && ((k.starts_with("js/")
                    && !matches!(k.as_str(), "js/core-list.js" | "js/sw.js" | "js/synonyms.js"))
                    || (k.starts_with("css/") && !k.eq_ignore_ascii_case("css/font.css")))
        })
        .cloned()
        .collect();
    for sk in stale_keys {
        ledger.new_hashes.remove(&sk);
        let orphan = if let Some(name) = sk.strip_prefix("js/") {
            Some(cfg.js_out_dir.join(name))
        } else if let Some(name) = sk.strip_prefix("css/") {
            Some(cfg.css_out_dir.join(name))
        } else {
            None
        };
        if let Some(p) = orphan {
            if p.is_file() && fs::remove_file(&p).is_ok() {
                log_info(logs, format!("[minify] 清理废弃产物: {}", sk));
            }
        }
    }

    let (built, skipped) = run_jobs(jobs, ledger, logs)?;
    log_info(
        logs,
        format!("[minify] 资源压缩完成: 更新 {} 个，跳过 {} 个", built, skipped),
    );
    Ok(())
}

pub fn build_phase3_tail(
    cfg: &ServerConfig,
    ledger: &mut IncrementalLedger,
    logs: Option<&LogBus>,
) -> Result<(), String> {
    let mut jobs = Vec::new();

    let raw_core = cfg.js_raw_dir.join("core-list.js");
    if raw_core.is_file() {
        jobs.push(MinifyJob {
            key: "js/core-list.js".to_string(),
            src_path: raw_core,
            out_path: cfg.js_out_dir.join("core-list.js"),
            is_css: false,
        });
    }

    let raw_sw = cfg.js_raw_dir.join("sw.js");
    if raw_sw.is_file() {
        jobs.push(MinifyJob {
            key: "sw.js".to_string(),
            src_path: raw_sw,
            out_path: cfg.repo_root.join("sw.js"),
            is_css: false,
        });
    }

    let (built, skipped) = run_jobs(jobs, ledger, logs)?;
    log_info(
        logs,
        format!(
            "[minify] 清单与 sw.js 压缩完成: 更新 {} 个，跳过 {} 个",
            built, skipped
        ),
    );
    Ok(())
}


/// 单文件实时热压缩（供 File Watcher 调用，毫秒级完成）
pub fn minify_single_asset(cfg: &ServerConfig, changed_path: &Path) -> Result<Option<String>, String> {
    let canonical = fs::canonicalize(changed_path).unwrap_or_else(|_| changed_path.to_path_buf());
    if !canonical.is_file() {
        return Ok(None);
    }

    let js_raw = fs::canonicalize(&cfg.js_raw_dir).unwrap_or_else(|_| cfg.js_raw_dir.clone());
    let css_raw = fs::canonicalize(&cfg.css_raw_dir).unwrap_or_else(|_| cfg.css_raw_dir.clone());
    let font_raw = fs::canonicalize(&cfg.font_raw_css).unwrap_or_else(|_| cfg.font_raw_css.clone());

    let (out_path, is_css, label) = if canonical == font_raw {
        (cfg.font_out_css.clone(), true, "src/css/font.css".to_string())
    } else if canonical.starts_with(&js_raw) {
        let name = canonical
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if !name.to_ascii_lowercase().ends_with(".js") || name == "core-list.js" || name == "synonyms.js" {
            return Ok(None);
        }
        let target = if name == "sw.js" {
            cfg.repo_root.join("sw.js")
        } else {
            cfg.js_out_dir.join(name)
        };
        let lbl = if name == "sw.js" {
            "sw.js".to_string()
        } else {
            format!("src/js/{}", name)
        };
        (target, false, lbl)
    } else if canonical.starts_with(&css_raw) {
        let name = canonical
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if !name.to_ascii_lowercase().ends_with(".css") || name.eq_ignore_ascii_case("font.css") {
            return Ok(None);
        }
        (cfg.css_out_dir.join(name), true, format!("src/css/{}", name))
    } else {
        return Ok(None);
    };

    let raw_bytes = fs::read(&canonical)
        .map_err(|e| format!("热编译读取 {} 失败: {}", canonical.display(), e))?;
    let raw_text = String::from_utf8(raw_bytes)
        .map_err(|e| format!("{} 非 UTF-8: {}", canonical.display(), e))?;
    let clean = raw_text.strip_prefix('\u{FEFF}').unwrap_or(&raw_text);
    let minified = if is_css {
        minify_css(clean)
    } else {
        minify_js(clean)?
    };
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    write_atomic(&out_path, &minified, false)?;
    Ok(Some(label))
}


/// 服务启动时自动增量同步压缩过期的 raw JS/CSS（未改动文件毫秒跳过，避免未跑 gen 时加载旧脚本）
pub fn sync_raw_assets_on_startup(cfg: &ServerConfig) -> Result<usize, String> {
    let mut ledger = IncrementalLedger::load(cfg);
    let mut jobs = Vec::new();

    if cfg.js_raw_dir.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&cfg.js_raw_dir)
            .map_err(|e| format!("读取 {} 失败: {}", cfg.js_raw_dir.display(), e))?
            .filter_map(|e| e.ok().map(|x| x.path()))
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .map(|s| s.eq_ignore_ascii_case("js"))
                        .unwrap_or(false)
            })
            .collect();
        entries.sort();
        for p in entries {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if matches!(name.as_str(), "core-list.js" | "synonyms.js") {
                continue;
            }
            let out_path = if name == "sw.js" {
                cfg.repo_root.join("sw.js")
            } else {
                cfg.js_out_dir.join(&name)
            };
            let key = if name == "sw.js" {
                "sw.js".to_string()
            } else {
                format!("js/{}", name)
            };
            jobs.push(MinifyJob {
                key,
                src_path: p,
                out_path,
                is_css: false,
            });
        }
    }

    if cfg.css_raw_dir.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&cfg.css_raw_dir)
            .map_err(|e| format!("读取 {} 失败: {}", cfg.css_raw_dir.display(), e))?
            .filter_map(|e| e.ok().map(|x| x.path()))
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .map(|s| s.eq_ignore_ascii_case("css"))
                        .unwrap_or(false)
            })
            .collect();
        entries.sort();
        for p in entries {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("font.css") {
                continue;
            }
            jobs.push(MinifyJob {
                key: format!("css/{}", name),
                out_path: cfg.css_out_dir.join(&name),
                src_path: p,
                is_css: true,
            });
        }
    }

    if cfg.font_raw_css.is_file() {
        jobs.push(MinifyJob {
            key: "css/font.css".to_string(),
            src_path: cfg.font_raw_css.clone(),
            out_path: cfg.font_out_css.clone(),
            is_css: true,
        });
    }

    let (built, _skipped) = run_jobs(jobs, &mut ledger, None)?;
    if built > 0 {
        ledger.save()?;
    }
    Ok(built)
}
