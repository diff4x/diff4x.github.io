use chrono::Local;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

const MAX_LOG_ENTRIES: usize = 800;

#[derive(Clone, Serialize, Debug)]
pub struct LogEntry {
    pub id: u64,
    pub ts: String,
    pub level: String,
    pub msg: String,
}

struct Inner {
    next_id: u64,
    entries: VecDeque<LogEntry>,
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
        if level == "ERROR" {
            eprintln!("[{}] [{}] {}", ts, level, msg_str);
        } else {
            println!("[{}] [{}] {}", ts, level, msg_str);
        }

        if let Ok(mut guard) = self.inner.lock() {
            let id = guard.next_id;
            guard.next_id += 1;
            if guard.entries.len() >= MAX_LOG_ENTRIES {
                guard.entries.pop_front();
            }
            guard.entries.push_back(LogEntry {
                id,
                ts,
                level: level.to_string(),
                msg: msg_str,
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

    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.entries.clear();
        }
    }
}
