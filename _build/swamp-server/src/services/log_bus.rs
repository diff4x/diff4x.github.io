//! 内存环形 + 磁盘持久化日志总线（swamp_runtime.log），支持重启虚线衔接、自动瘦身与 GUI 实时通知。

use chrono::Local;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

const MAX_LOG_ENTRIES: usize = 800;
const COMPACT_THRESHOLD_ENTRIES: usize = 1000;
const COMPACT_THRESHOLD_BYTES: usize = 512 * 1024;
pub const LOG_SEPARATOR_PREFIX: &str = "----------------------------------------";

#[derive(Clone, Serialize, Debug)]
pub struct LogEntry {
    pub id: u64,
    pub ts: String,
    pub level: String,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_line: Option<String>,
}

impl LogEntry {
    pub fn format_plain(&self) -> String {
        if let Some(ref raw) = self.raw_line {
            raw.clone()
        } else {
            format!("[{}] [{}] {}", self.ts, self.level, self.msg)
        }
    }

    pub fn format_crlf(&self) -> String {
        self.format_plain()
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
    }

    pub fn is_separator(&self) -> bool {
        self.raw_line
            .as_deref()
            .map(|s| s.starts_with(LOG_SEPARATOR_PREFIX))
            .unwrap_or(false)
    }
}

fn is_log_entry_header(line: &str) -> bool {
    let b = line.as_bytes();
    // 匹配 "[HH:MM:SS] [INFO]" / "[WARN]" / "[ERROR]"
    b.len() >= 16
        && b[0] == b'['
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3] == b':'
        && b[4].is_ascii_digit()
        && b[5].is_ascii_digit()
        && b[6] == b':'
        && b[7].is_ascii_digit()
        && b[8].is_ascii_digit()
        && b[9] == b']'
        && b[10] == b' '
        && b[11] == b'['
}

/// 将落盘的纯文本日志解析为逻辑日志块（保留多行告警内部顺序，同时正确识别虚线会话分隔符）
pub fn parse_log_blocks(text: &str) -> Vec<String> {
    let clean = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut blocks: Vec<String> = Vec::new();

    for raw_line in clean.lines() {
        let line = raw_line.trim_end_matches('\r');
        if blocks.is_empty() && line.trim().is_empty() {
            continue;
        }
        if line.starts_with(LOG_SEPARATOR_PREFIX) || is_log_entry_header(line) {
            blocks.push(line.to_string());
        } else if let Some(last) = blocks.last_mut() {
            last.push('\n');
            last.push_str(line);
        } else {
            blocks.push(line.to_string());
        }
    }

    while let Some(last) = blocks.last() {
        if last.trim().is_empty() {
            blocks.pop();
        } else {
            break;
        }
    }
    blocks
}

fn append_line_to_file(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(text.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

struct Inner {
    next_id: u64,
    entries: VecDeque<LogEntry>,
    log_file: Option<PathBuf>,
}

pub struct LogBus {
    inner: Mutex<Inner>,
    notify_hwnd: AtomicIsize,
    notify_msg: u32,
}

impl LogBus {
    pub fn new(notify_msg: u32) -> Self {
        Self {
            inner: Mutex::new(Inner {
                next_id: 1,
                entries: VecDeque::with_capacity(MAX_LOG_ENTRIES),
                log_file: None,
            }),
            notify_hwnd: AtomicIsize::new(0),
            notify_msg,
        }
    }

    /// 创建带落盘与跨会话续接能力的日志总线（写入 _build/temp/swamp_runtime.log）
    pub fn with_file(notify_msg: u32, log_file: PathBuf) -> Self {
        let mut entries = VecDeque::with_capacity(MAX_LOG_ENTRIES);
        let mut next_id = 1u64;

        if log_file.is_file() {
            if let Ok(raw) = fs::read_to_string(&log_file) {
                let raw_len = raw.len();
                let mut blocks = parse_log_blocks(&raw);
                let orig_count = blocks.len();
                if blocks.len() > MAX_LOG_ENTRIES {
                    let drop_n = blocks.len() - MAX_LOG_ENTRIES;
                    blocks.drain(0..drop_n);
                }
                // 超出阈值时自动瘦身落盘文件，防止长期运行无限膨胀
                if orig_count > COMPACT_THRESHOLD_ENTRIES || raw_len > COMPACT_THRESHOLD_BYTES {
                    let compacted = if blocks.is_empty() {
                        String::new()
                    } else {
                        blocks.join("\n") + "\n"
                    };
                    let _ = crate::api_files::write_atomic(&log_file, &compacted, false);
                }
                for blk in blocks {
                    entries.push_back(LogEntry {
                        id: next_id,
                        ts: String::new(),
                        level: String::new(),
                        msg: String::new(),
                        raw_line: Some(blk),
                    });
                    next_id += 1;
                }
            }
        }

        // 若存在上一次运行日志且末尾还不是虚线分隔符，则插入本次启动的虚线分隔行并落盘
        let has_prev = !entries.is_empty();
        let last_is_sep = entries.back().map(|e| e.is_separator()).unwrap_or(false);
        if has_prev && !last_is_sep {
            let sep = format!(
                "{} {} {}",
                LOG_SEPARATOR_PREFIX,
                Local::now().format("%Y-%m-%d %H:%M:%S"),
                LOG_SEPARATOR_PREFIX
            );
            append_line_to_file(&log_file, &sep);
            if entries.len() >= MAX_LOG_ENTRIES {
                entries.pop_front();
            }
            entries.push_back(LogEntry {
                id: next_id,
                ts: String::new(),
                level: String::new(),
                msg: String::new(),
                raw_line: Some(sep),
            });
            next_id += 1;
        }

        Self {
            inner: Mutex::new(Inner {
                next_id,
                entries,
                log_file: Some(log_file),
            }),
            notify_hwnd: AtomicIsize::new(0),
            notify_msg,
        }
    }

    pub fn set_notify_hwnd(&self, hwnd: isize) {
        self.notify_hwnd.store(hwnd, Ordering::SeqCst);
    }

    pub fn push(&self, level: &str, msg: impl Into<String>) {
        let msg_str = msg.into();
        let ts = Local::now().format("%H:%M:%S").to_string();
        let formatted_plain = format!("[{}] [{}] {}", ts, level, msg_str);
        if level == "ERROR" {
            eprintln!("{}", formatted_plain);
        } else {
            println!("{}", formatted_plain);
        }

        if let Ok(mut guard) = self.inner.lock() {
            let id = guard.next_id;
            guard.next_id += 1;
            if let Some(ref path) = guard.log_file {
                append_line_to_file(path, &formatted_plain);
            }
            if guard.entries.len() >= MAX_LOG_ENTRIES {
                guard.entries.pop_front();
            }
            guard.entries.push_back(LogEntry {
                id,
                ts,
                level: level.to_string(),
                msg: msg_str,
                raw_line: None,
            });
        }

        #[cfg(windows)]
        {
            let h = self.notify_hwnd.load(Ordering::SeqCst);
            if h != 0 && self.notify_msg != 0 {
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                        h as windows_sys::Win32::Foundation::HWND,
                        self.notify_msg,
                        0,
                        0,
                    );
                }
            }
        }
    }

    pub fn info(&self, msg: impl Into<String>) {
        self.push("INFO", msg);
    }

    pub fn warn(&self, msg: impl Into<String>) {
        self.push("WARN", msg);
    }

    pub fn error(&self, msg: impl Into<String>) {
        self.push("ERROR", msg);
    }

    #[allow(dead_code)]
    pub fn since(&self, after_id: u64) -> Vec<LogEntry> {
        match self.inner.lock() {
            Ok(guard) => guard
                .entries
                .iter()
                .filter(|e| e.id > after_id)
                .cloned()
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// 返回 id > after_id 的日志文本（按新来居上倒序拼接，CRLF 换行）及最新最大 id
    pub fn since_newest_first(&self, after_id: u64) -> (u64, String) {
        match self.inner.lock() {
            Ok(guard) => {
                let mut max_id = after_id;
                let mut out = String::new();
                for e in guard.entries.iter().rev() {
                    if e.id <= after_id {
                        break;
                    }
                    if e.id > max_id {
                        max_id = e.id;
                    }
                    out.push_str(&e.format_crlf());
                    out.push_str("\r\n");
                }
                (max_id, out)
            }
            Err(_) => (after_id, String::new()),
        }
    }

    /// 返回全部内存日志文本（按新来居上倒序拼接，CRLF 换行）及最新最大 id
    pub fn all_newest_first(&self) -> (u64, String) {
        self.since_newest_first(0)
    }

    /// 返回当前日志总字节数（有落盘文件时直接取磁盘文件体积，否则按内存条目估算）
    pub fn size_bytes(&self) -> u64 {
        if let Ok(guard) = self.inner.lock() {
            if let Some(ref path) = guard.log_file {
                if let Ok(meta) = fs::metadata(path) {
                    return meta.len();
                }
            }
            return guard
                .entries
                .iter()
                .map(|e| (e.format_plain().len() + 1) as u64)
                .sum();
        }
        0
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.entries.clear();
            if let Some(ref path) = guard.log_file {
                let _ = fs::write(path, b"");
            }
        }
    }
}
