#![cfg(windows)]

use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateBitmap, CreateFontW, CreateSolidBrush, FillRect, FrameRect, GetSysColorBrush,
    GetTextExtentPoint32W, RedrawWindow, SelectObject, SetBkColor, SetBkMode, SetTextColor,
    TextOutW, COLOR_3DFACE, DEFAULT_CHARSET, FW_NORMAL, HBRUSH, HDC, HFONT, RDW_ALLCHILDREN,
    RDW_ERASE, RDW_INVALIDATE, RDW_UPDATENOW,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::UI::Controls::{
    InitCommonControlsEx, ImageList_Add, ImageList_Create, ImageList_Destroy, HIMAGELIST,
    ICC_TAB_CLASSES, ICC_TREEVIEW_CLASSES, ILC_COLOR32, ILC_MASK, INITCOMMONCONTROLSEX, NMHDR,
    NMTVKEYDOWN, NM_CLICK, NM_DBLCLK, TCIF_TEXT, TCITEMW, TCM_GETCURSEL, TCM_INSERTITEMW,
    TCN_SELCHANGE, TVE_EXPAND, TVGN_CHILD, TVGN_NEXT, TVHITTESTINFO, TVHT_ONITEMSTATEICON,
    TVIF_PARAM, TVIF_STATE, TVIF_TEXT, TVINSERTSTRUCTW, TVIS_STATEIMAGEMASK, TVITEMW, TVI_LAST,
    TVI_ROOT, TVM_DELETEITEM, TVM_EXPAND, TVM_GETITEMW, TVM_GETNEXTITEM, TVM_HITTEST,
    TVM_INSERTITEMW, TVM_SETIMAGELIST, TVM_SETITEMW, TVN_KEYDOWN, TVSIL_STATE,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::Shell::{DragAcceptFiles, DragFinish, DragQueryFileW, HDROP};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateIconIndirect, CreateWindowExW, DefWindowProcW, DestroyIcon,
    DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos, GetMessageW, GetWindowLongPtrW,
    GetWindowTextLengthW, GetWindowTextW, LoadCursorW, MessageBoxW, MoveWindow, PostMessageW,
    PostQuitMessage, RegisterClassW, SendMessageW, SetWindowLongPtrW, SetWindowPos,
    SetWindowTextW, ShowWindow, TranslateMessage, BS_AUTOCHECKBOX as RAW_BS_AUTOCHECKBOX,
    BS_GROUPBOX as RAW_BS_GROUPBOX, BS_PUSHBUTTON as RAW_BS_PUSHBUTTON,
    CBS_DROPDOWNLIST as RAW_CBS_DROPDOWNLIST, CREATESTRUCTW, ES_AUTOHSCROLL as RAW_ES_AUTOHSCROLL,
    ES_AUTOVSCROLL as RAW_ES_AUTOVSCROLL, ES_MULTILINE as RAW_ES_MULTILINE,
    ES_READONLY as RAW_ES_READONLY, GWLP_USERDATA, GWLP_WNDPROC, HICON, HMENU, HWND_BOTTOM,
    ICONINFO, ICON_BIG, ICON_SMALL, IDC_ARROW, IDYES, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK,
    MB_YESNO, MINMAXINFO, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, WM_APP,
    WM_CLOSE, WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_DESTROY, WM_DROPFILES, WM_ERASEBKGND,
    WM_GETMINMAXINFO, WM_NOTIFY, WM_SETFONT, WM_SETICON, WM_SIZE, WNDCLASSW, WS_CHILD,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_CLIENTEDGE, WS_HSCROLL, WS_OVERLAPPEDWINDOW,
    WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};

// 统一将控件样式与标准消息常量对齐为 u32（windows-sys 0.59 中部分 BS_*/ES_*/CBS_* 定义为 i32）
const BS_AUTOCHECKBOX: u32 = RAW_BS_AUTOCHECKBOX as u32;
const BS_GROUPBOX: u32 = RAW_BS_GROUPBOX as u32;
const BS_PUSHBUTTON: u32 = RAW_BS_PUSHBUTTON as u32;
const CBS_DROPDOWNLIST: u32 = RAW_CBS_DROPDOWNLIST as u32;
const ES_AUTOHSCROLL: u32 = RAW_ES_AUTOHSCROLL as u32;
const ES_AUTOVSCROLL: u32 = RAW_ES_AUTOVSCROLL as u32;
const ES_MULTILINE: u32 = RAW_ES_MULTILINE as u32;
const ES_READONLY: u32 = RAW_ES_READONLY as u32;

const TVS_HASBUTTONS: u32 = 0x0001;
const TVS_HASLINES: u32 = 0x0002;
const TVS_LINESATROOT: u32 = 0x0004;
const TVS_SHOWSELALWAYS: u32 = 0x0020;
const TCM_SETCURSEL: u32 = 0x130C;
const ES_WANTRETURN: u32 = 0x1000;
const CBN_SELCHANGE: u16 = 1;
const EM_SETLIMITTEXT: u32 = 0x00C5;
const WM_DPICHANGED: u32 = 0x02E0;
const WM_DRAWITEM: u32 = 0x002B;
const BS_OWNERDRAW: u32 = 0x0000_000B;
const BM_SETSTYLE: u32 = 0x00F4;
const ODS_SELECTED: u32 = 0x0001;
const ODS_FOCUS: u32 = 0x0010;
const GDI_TRANSPARENT: i32 = 1;
const GDI_OPAQUE: i32 = 2;
const CLEARTYPE_QUALITY: u32 = 5;
const RO_EDIT_BG_RGB: u32 = 0x00FF_FFFF;
// Win32 COLORREF 为 0x00BBGGRR
const BTN_RED_BG_RGB: u32 = 0x0026_26DC;
const BTN_RED_PRESSED_RGB: u32 = 0x001C_1CB9;
const BTN_RED_BORDER_RGB: u32 = 0x001B_1B99;
const BTN_RED_TEXT_RGB: u32 = 0x00FF_FFFF;
const LOG_RED_THRESHOLD_KB: u64 = 100;

#[repr(C)]
struct DrawItemStruct {
    ctl_type: u32,
    ctl_id: u32,
    item_id: u32,
    item_action: u32,
    item_state: u32,
    hwnd_item: HWND,
    hdc: HDC,
    rc_item: RECT,
    item_data: usize,
}

use crate::api_ops::spawn_vscode;
use crate::builder::html_utils::create_new_html;
use crate::config::{strip_verbatim_prefix, ServerConfig};
use crate::media::keep2html::{run_keep2html, KeepOptions};
use crate::media::webp::{run_webp_batch, WebpOptions};
use crate::security::{run_selftest_with_logger, AppState};
use crate::services::log_bus::LogBus;
use crate::services::pack_apply::{
    self, ApplyEntryInfo, BackupInfo, BackupTreeItem, DownloadTreeItem, PackFileItem,
};

pub const WM_APP_LOG: u32 = WM_APP + 1;
pub const WM_APP_VPN: u32 = WM_APP + 2;
const WM_APP_PACK_TREE: u32 = WM_APP + 3;
const WM_APP_APPLY_TREE: u32 = WM_APP + 4;
const WM_APP_BACKUPS: u32 = WM_APP + 5;
const WM_APP_SYN_DATA: u32 = WM_APP + 6;
const WM_APP_CLEAR_NEW_TITLE: u32 = WM_APP + 7;
const WM_APP_EXIT_AND_BUILD: u32 = WM_APP + 8;
const WM_APP_BACKUP_TREE: u32 = WM_APP + 9;
const WM_APP_DOWNLOADS_TREE: u32 = WM_APP + 10;

const BM_GETCHECK: u32 = 0x00F0;
const BM_SETCHECK: u32 = 0x00F1;
const BST_CHECKED: usize = 1;
const BST_UNCHECKED: usize = 0;

const CB_ADDSTRING: u32 = 0x0143;
const CB_RESETCONTENT: u32 = 0x014B;
const CB_SETCURSEL: u32 = 0x014E;
const CB_GETCURSEL: u32 = 0x0147;

const EM_SETSEL: u32 = 0x00B1;
const EM_SCROLLCARET: u32 = 0x00B7;
const EM_REPLACESEL: u32 = 0x00C2;

// Control IDs
const IDC_TAB: u16 = 100;
const IDC_LBL_LOG: u16 = 101;
const IDC_BTN_CLEAR_LOG: u16 = 102;
const IDC_EDIT_LOG: u16 = 103;

// Tab 0: 常规
const IDC_GRP_OPS: u16 = 200;
const IDC_BTN_OPEN_SITE: u16 = 201;
const IDC_BTN_GEN: u16 = 202;
const IDC_BTN_GEN_PUSH: u16 = 203;
const IDC_BTN_PUSH: u16 = 204;
const IDC_BTN_SIM: u16 = 205;
const IDC_BTN_SELFCHECK: u16 = 206;
const IDC_BTN_ROOT: u16 = 207;
const IDC_LBL_COMMIT: u16 = 208;
const IDC_EDIT_COMMIT: u16 = 209;
const IDC_BTN_REAUTH: u16 = 210;

const IDC_GRP_NEW: u16 = 220;
const IDC_LBL_NEW_TITLE: u16 = 221;
const IDC_EDIT_NEW_TITLE: u16 = 222;
const IDC_LBL_NEW_CAT: u16 = 223;
const IDC_EDIT_NEW_CAT: u16 = 224;
const IDC_CHK_NEW_OPEN: u16 = 225;
const IDC_BTN_NEW: u16 = 226;

const IDC_GRP_WEBP: u16 = 230;
const IDC_LBL_WEBP_W: u16 = 231;
const IDC_EDIT_WEBP_W: u16 = 232;
const IDC_LBL_WEBP_Q: u16 = 233;
const IDC_EDIT_WEBP_Q: u16 = 234;
const IDC_CHK_WEBP_ALT: u16 = 235;
const IDC_CHK_WEBP_MAP: u16 = 236;
const IDC_BTN_WEBP: u16 = 237;

const IDC_GRP_KEEP: u16 = 240;
const IDC_LBL_KEEP_MODE: u16 = 241;
const IDC_CMB_KEEP_MODE: u16 = 242;
const IDC_LBL_KEEP_TAG: u16 = 243;
const IDC_EDIT_KEEP_TAG: u16 = 244;
const IDC_LBL_KEEP_CAT: u16 = 245;
const IDC_EDIT_KEEP_CAT: u16 = 246;
const IDC_BTN_KEEP: u16 = 247;

// Tab 1: 打包协作 (Pack)
const IDC_LBL_PACK_PRESET: u16 = 301;
const IDC_CMB_PACK_PRESET: u16 = 302;
const IDC_BTN_PRESET_ONLY: u16 = 303;
const IDC_BTN_PRESET_ADD: u16 = 304;
const IDC_BTN_GIT_MOD: u16 = 305;
const IDC_CHK_PACK_MORE: u16 = 306;
const IDC_LBL_PACK_FILTER: u16 = 307;
const IDC_EDIT_PACK_FILTER: u16 = 308;
const IDC_BTN_PACK_CLEAR: u16 = 309;
const IDC_BTN_PACK_REFRESH: u16 = 310;
const IDC_BTN_PACK_ZIP: u16 = 311;
const IDC_TV_PACK: u16 = 312;
const IDC_LBL_PACK_STATUS: u16 = 313;
const IDC_LBL_PRESET_NAME: u16 = 314;
const IDC_EDIT_PRESET_NAME: u16 = 315;
const IDC_BTN_PRESET_SAVE: u16 = 316;
const IDC_BTN_PRESET_DEL: u16 = 317;
const IDC_CHK_PACK_MD: u16 = 318;
const IDC_LBL_PACK_MD_MAX: u16 = 319;
const IDC_EDIT_PACK_MD_MAX: u16 = 320;
const IDC_LBL_PACK_MD_UNIT: u16 = 321;

// Tab 2: 回填补丁 (Apply)
const IDC_BTN_APPLY_BROWSE: u16 = 401;
const IDC_CHK_APPLY_BAK: u16 = 402;
const IDC_CHK_APPLY_ENC: u16 = 403;
const IDC_BTN_APPLY_EXEC: u16 = 404;
const IDC_LBL_ROLLBACK: u16 = 405;
const IDC_CMB_ROLLBACK: u16 = 406;
const IDC_BTN_ROLLBACK: u16 = 407;
const IDC_BTN_BAK_REFRESH: u16 = 408;
const IDC_TV_APPLY: u16 = 409;
const IDC_LBL_APPLY_STATUS: u16 = 410;
const IDC_CHK_APPLY_BUILD: u16 = 411;
const IDC_LBL_APPLY_TREE: u16 = 412;
const IDC_LBL_BACKUP_TREE: u16 = 413;
const IDC_TV_BACKUP: u16 = 414;
const IDC_LBL_BACKUP_STATUS: u16 = 415;
const IDC_BTN_BACKUP_OPEN: u16 = 416;
const IDC_BTN_BACKUP_DEL: u16 = 417;
const IDC_LBL_DL_TREE: u16 = 418;
const IDC_TV_DOWNLOADS: u16 = 419;
const IDC_LBL_DL_STATUS: u16 = 420;
const IDC_BTN_DL_OPEN: u16 = 421;
const IDC_BTN_DL_DEL: u16 = 422;

// Tab 3: 同义词 (Synonyms)
const IDC_BTN_SYN_SAVE: u16 = 501;
const IDC_BTN_SYN_REBUILD: u16 = 502;
const IDC_BTN_SYN_IMPORT: u16 = 503;
const IDC_BTN_OOV_REFRESH: u16 = 504;
const IDC_LBL_SYN_CUSTOM: u16 = 505;
const IDC_EDIT_SYN_CUSTOM: u16 = 506;
const IDC_LBL_OOV_REPORT: u16 = 507;
const IDC_EDIT_OOV_REPORT: u16 = 508;

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

fn format_bytes(b: u64) -> String {
    if b < 1024 {
        format!("{} B", b)
    } else if b < 1048576 {
        format!("{:.1} KB", b as f64 / 1024.0)
    } else {
        format!("{:.2} MB", b as f64 / 1048576.0)
    }
}

#[inline]
fn sc(px: i32, dpi: u32) -> i32 {
    (px * dpi as i32 + 48) / 96
}

unsafe fn enable_dpi_awareness() {
    let u32_w = to_wide("user32.dll");
    let hmod = GetModuleHandleW(u32_w.as_ptr());
    if hmod.is_null() {
        return;
    }
    // 优先启用 Per-Monitor Aware V2 (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4)
    if let Some(p) = GetProcAddress(hmod, b"SetProcessDpiAwarenessContext\0".as_ptr()) {
        let f: unsafe extern "system" fn(isize) -> i32 = std::mem::transmute(p);
        if f(-4isize) != 0 {
            return;
        }
    }
    if let Some(p) = GetProcAddress(hmod, b"SetProcessDPIAware\0".as_ptr()) {
        let f: unsafe extern "system" fn() -> i32 = std::mem::transmute(p);
        f();
    }
}

unsafe fn query_dpi(hwnd: HWND) -> u32 {
    let u32_w = to_wide("user32.dll");
    let hmod = GetModuleHandleW(u32_w.as_ptr());
    if !hmod.is_null() {
        if !hwnd.is_null() {
            if let Some(p) = GetProcAddress(hmod, b"GetDpiForWindow\0".as_ptr()) {
                let f: unsafe extern "system" fn(HWND) -> u32 = std::mem::transmute(p);
                let d = f(hwnd);
                if d >= 72 {
                    return d;
                }
            }
        }
        if let Some(p) = GetProcAddress(hmod, b"GetDpiForSystem\0".as_ptr()) {
            let f: unsafe extern "system" fn() -> u32 = std::mem::transmute(p);
            let d = f();
            if d >= 72 {
                return d;
            }
        }
    }
    96
}

unsafe fn create_scaled_fonts(dpi: u32) -> (HFONT, HFONT) {
    let ui_h = -sc(13, dpi);
    let mono_h = -sc(13, dpi);
    let font_ui_name = to_wide("Microsoft YaHei UI");
    let font_ui = CreateFontW(
        ui_h,
        0,
        0,
        0,
        FW_NORMAL as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        CLEARTYPE_QUALITY,
        0,
        font_ui_name.as_ptr(),
    );

    let font_mono_name = to_wide("Consolas");
    let font_mono = CreateFontW(
        mono_h,
        0,
        0,
        0,
        FW_NORMAL as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        CLEARTYPE_QUALITY,
        0,
        font_mono_name.as_ptr(),
    );
    (font_ui, font_mono)
}

unsafe fn get_window_text_string(hwnd: HWND) -> String {
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
    if copied <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..copied as usize])
}

unsafe fn set_window_text(hwnd: HWND, text: &str) {
    let w = to_wide(text);
    SetWindowTextW(hwnd, w.as_ptr());
}

unsafe fn is_checked(hwnd: HWND) -> bool {
    SendMessageW(hwnd, BM_GETCHECK, 0, 0) as usize == BST_CHECKED
}

unsafe fn set_checked(hwnd: HWND, checked: bool) {
    SendMessageW(
        hwnd,
        BM_SETCHECK,
        if checked { BST_CHECKED } else { BST_UNCHECKED },
        0,
    );
}

unsafe fn build_orb_hicon(size: i32, green: bool) -> HICON {
    let s = size as usize;
    let mut bgra = vec![0u8; s * s * 4];
    let mask_stride = ((s + 15) / 16) * 2;
    let mut mask = vec![0xFFu8; mask_stride * s];

    let center = (size as f32 - 1.0) / 2.0;
    let radius = center - 0.8;
    let (r0, g0, b0) = if green { (130.0, 255.0, 140.0) } else { (255.0, 130.0, 130.0) };
    let (r1, g1, b1) = if green { (16.0, 150.0, 55.0) } else { (185.0, 24.0, 24.0) };

    for y in 0..s {
        for x in 0..s {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= radius {
                let t = ((x + y) as f32 / (2.0 * size as f32)).clamp(0.0, 1.0);
                let mut r = r0 + (r1 - r0) * t;
                let mut g = g0 + (g1 - g0) * t;
                let mut b = b0 + (b1 - b0) * t;
                if dist > radius - 1.2 {
                    // 经典深色外描边
                    r *= 0.45;
                    g *= 0.45;
                    b *= 0.45;
                }
                let idx = (y * s + x) * 4;
                bgra[idx] = b as u8;
                bgra[idx + 1] = g as u8;
                bgra[idx + 2] = r as u8;
                bgra[idx + 3] = 255;

                // mask bit 0 = opaque
                let byte_idx = y * mask_stride + (x / 8);
                let bit_mask = !(1u8 << (7 - (x % 8)));
                mask[byte_idx] &= bit_mask;
            }
        }
    }

    let hbm_color = CreateBitmap(size, size, 1, 32, bgra.as_ptr() as *const _);
    let hbm_mask = CreateBitmap(size, size, 1, 1, mask.as_ptr() as *const _);
    let ii = ICONINFO {
        fIcon: 1,
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: hbm_mask,
        hbmColor: hbm_color,
    };
    let hicon = CreateIconIndirect(&ii);
    if !hbm_color.is_null() {
        windows_sys::Win32::Graphics::Gdi::DeleteObject(hbm_color);
    }
    if !hbm_mask.is_null() {
        windows_sys::Win32::Graphics::Gdi::DeleteObject(hbm_mask);
    }
    hicon
}

unsafe fn build_tristate_imagelist(dpi: u32) -> HIMAGELIST {
    let sz = sc(16, dpi).clamp(16, 32) as usize;
    let mask_stride = ((sz + 15) / 16) * 2;
    let pad = (sz / 8).max(2);
    let inner_end = sz - pad;
    let stroke = (sz / 16).max(1);

    let himl = ImageList_Create(sz as i32, sz as i32, ILC_COLOR32 | ILC_MASK, 4, 0);
    // 0: 占位透明, 1: 未选 (经典白底灰框), 2: 全选 (蓝底白勾), 3: 部分选中 (浅蓝底蓝横杠)
    for mode in 0..4 {
        let mut bgra = vec![0u8; sz * sz * 4];
        let mut mask = vec![0xFFu8; mask_stride * sz];
        if mode >= 1 {
            for y in pad..inner_end {
                for x in pad..inner_end {
                    let is_border = x < pad + stroke
                        || x >= inner_end - stroke
                        || y < pad + stroke
                        || y >= inner_end - stroke;
                    let (r, g, b) = if is_border {
                        match mode {
                            1 => (105, 105, 105),
                            _ => (0, 102, 204),
                        }
                    } else {
                        match mode {
                            1 => (255, 255, 255),
                            2 => (0, 120, 215),
                            _ => (224, 240, 255),
                        }
                    };
                    let idx = (y * sz + x) * 4;
                    bgra[idx] = b;
                    bgra[idx + 1] = g;
                    bgra[idx + 2] = r;
                    bgra[idx + 3] = 255;

                    let byte_idx = y * mask_stride + (x / 8);
                    mask[byte_idx] &= !(1u8 << (7 - (x % 8)));
                }
            }
            if mode == 2 {
                // 按尺寸自适应比例绘制白色对勾
                let pts = [(4, 8), (5, 9), (6, 10), (7, 9), (8, 8), (9, 7), (10, 6), (11, 5)];
                for (ux, uy) in pts {
                    let px0 = (ux * sz) / 16;
                    let py0 = (uy * sz) / 16;
                    for dx in 0..stroke {
                        for dy in 0..=(stroke) {
                            let px = (px0 + dx).min(inner_end - 1);
                            let py = (py0 + dy).min(inner_end - 1);
                            let idx = (py * sz + px) * 4;
                            bgra[idx] = 255;
                            bgra[idx + 1] = 255;
                            bgra[idx + 2] = 255;
                        }
                    }
                }
            } else if mode == 3 {
                let x0 = (5 * sz) / 16;
                let x1 = (11 * sz) / 16;
                let y0 = (7 * sz) / 16;
                let y1 = ((9 * sz) / 16).max(y0 + stroke + 1);
                for x in x0..x1 {
                    for y in y0..y1 {
                        let idx = (y * sz + x) * 4;
                        bgra[idx] = 215;
                        bgra[idx + 1] = 120;
                        bgra[idx + 2] = 0;
                    }
                }
            }
        }
        let hbm_c = CreateBitmap(sz as i32, sz as i32, 1, 32, bgra.as_ptr() as *const _);
        let hbm_m = CreateBitmap(sz as i32, sz as i32, 1, 1, mask.as_ptr() as *const _);
        ImageList_Add(himl, hbm_c, hbm_m);
        if !hbm_c.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(hbm_c);
        }
        if !hbm_m.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(hbm_m);
        }
    }
    himl
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TreeKind {
    Pack,
    Apply,
    Backup,
    Downloads,
}

struct TreeNodeData {
    rel: String,
    is_file: bool,
    blocked: bool,
}

/// 跨线程安全邮箱：由 Arc 托管，彻底消除后台线程访问 GuiData 裸指针的 UAF 风险，并统一托管 sim 子进程生命周期
struct GuiMailbox {
    hwnd: AtomicIsize,
    pack_result: Mutex<Option<(Vec<PackFileItem>, Value)>>,
    apply_result: Mutex<Option<(String, Vec<u8>, Vec<ApplyEntryInfo>)>>,
    backups: Mutex<Option<Vec<BackupInfo>>>,
    backup_tree: Mutex<Option<Vec<BackupTreeItem>>>,
    downloads_tree: Mutex<Option<(Option<PathBuf>, Vec<DownloadTreeItem>)>>,
    syn_data: Mutex<Option<(Option<String>, String)>>,
    sim_child: Mutex<Option<Child>>,
    pending_build_handoff: Mutex<Option<(PathBuf, PathBuf)>>,
}

impl GuiMailbox {
    fn new() -> Self {
        Self {
            hwnd: AtomicIsize::new(0),
            pack_result: Mutex::new(None),
            apply_result: Mutex::new(None),
            backups: Mutex::new(None),
            backup_tree: Mutex::new(None),
            downloads_tree: Mutex::new(None),
            syn_data: Mutex::new(None),
            sim_child: Mutex::new(None),
            pending_build_handoff: Mutex::new(None),
        }
    }

    fn set_hwnd(&self, hwnd: HWND) {
        self.hwnd.store(hwnd as isize, Ordering::SeqCst);
    }

    fn clear_hwnd(&self) {
        self.hwnd.store(0, Ordering::SeqCst);
    }

    fn post(&self, msg: u32, wparam: WPARAM, lparam: LPARAM) {
        let h = self.hwnd.load(Ordering::SeqCst);
        if h != 0 {
            unsafe {
                PostMessageW(h as HWND, msg, wparam, lparam);
            }
        }
    }

    fn kill_sim_child(&self) {
        if let Ok(mut slot) = self.sim_child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

struct GuiData {
    state: Arc<AppState>,
    shutdown_notify: Arc<Notify>,
    dpi: u32,
    font_ui: HFONT,
    font_mono: HFONT,
    edit_ro_brush: HBRUSH,
    btn_red_brush: HBRUSH,
    btn_red_pressed_brush: HBRUSH,
    btn_red_border_brush: HBRUSH,
    icon_green_big: HICON,
    icon_green_small: HICON,
    icon_red_big: HICON,
    icon_red_small: HICON,
    himl_pack: HIMAGELIST,
    himl_apply: HIMAGELIST,
    himl_backup: HIMAGELIST,
    himl_downloads: HIMAGELIST,

    hwnd_main: HWND,
    hwnd_tab: HWND,
    hwnd_lbl_log: HWND,
    hwnd_btn_clear_log: HWND,
    hwnd_edit_log: HWND,

    // Tab 0 controls
    tab0_ctrls: Vec<HWND>,
    hwnd_grp_ops: HWND,
    hwnd_btn_open_site: HWND,
    hwnd_btn_gen: HWND,
    hwnd_btn_gen_push: HWND,
    hwnd_btn_push: HWND,
    hwnd_btn_sim: HWND,
    hwnd_btn_selfcheck: HWND,
    hwnd_btn_root: HWND,
    hwnd_lbl_commit: HWND,
    hwnd_edit_commit: HWND,
    hwnd_btn_reauth: HWND,

    hwnd_grp_new: HWND,
    hwnd_lbl_new_title: HWND,
    hwnd_edit_new_title: HWND,
    hwnd_lbl_new_cat_h: HWND,
    hwnd_edit_new_cat: HWND,
    hwnd_chk_new_open: HWND,
    hwnd_btn_new: HWND,

    hwnd_grp_webp: HWND,
    hwnd_lbl_webp_w: HWND,
    hwnd_edit_webp_w: HWND,
    hwnd_lbl_webp_q: HWND,
    hwnd_edit_webp_q: HWND,
    hwnd_chk_webp_alt: HWND,
    hwnd_chk_webp_map: HWND,
    hwnd_btn_webp: HWND,

    hwnd_grp_keep: HWND,
    hwnd_lbl_keep_mode: HWND,
    hwnd_cmb_keep_mode: HWND,
    hwnd_lbl_keep_tag: HWND,
    hwnd_edit_keep_tag: HWND,
    hwnd_lbl_keep_cat: HWND,
    hwnd_edit_keep_cat: HWND,
    hwnd_btn_keep: HWND,

    // Tab 1 (Pack) controls
    tab1_ctrls: Vec<HWND>,
    hwnd_lbl_pack_preset: HWND,
    hwnd_cmb_pack_preset: HWND,
    hwnd_btn_preset_only: HWND,
    hwnd_btn_preset_add: HWND,
    hwnd_btn_git_mod: HWND,
    hwnd_chk_pack_more: HWND,
    hwnd_lbl_pack_filter: HWND,
    hwnd_edit_pack_filter: HWND,
    hwnd_btn_pack_clear: HWND,
    hwnd_btn_pack_refresh: HWND,
    hwnd_btn_pack_zip: HWND,
    hwnd_lbl_preset_name: HWND,
    hwnd_edit_preset_name: HWND,
    hwnd_btn_preset_save: HWND,
    hwnd_btn_preset_del: HWND,
    hwnd_chk_pack_md: HWND,
    hwnd_lbl_pack_md_max: HWND,
    hwnd_edit_pack_md_max: HWND,
    hwnd_lbl_pack_md_unit: HWND,
    hwnd_tv_pack: HWND,
    hwnd_lbl_pack_status: HWND,

    // Tab 2 (Apply) controls
    tab2_ctrls: Vec<HWND>,
    hwnd_btn_apply_browse: HWND,
    hwnd_chk_apply_bak: HWND,
    hwnd_chk_apply_enc: HWND,
    hwnd_chk_apply_build: HWND,
    hwnd_btn_apply_exec: HWND,
    hwnd_lbl_rollback: HWND,
    hwnd_cmb_rollback: HWND,
    hwnd_btn_rollback: HWND,
    hwnd_btn_bak_refresh: HWND,
    hwnd_btn_dl_open: HWND,
    hwnd_btn_dl_del: HWND,
    hwnd_btn_backup_open: HWND,
    hwnd_btn_backup_del: HWND,
    hwnd_lbl_dl_tree: HWND,
    hwnd_lbl_apply_tree: HWND,
    hwnd_lbl_backup_tree: HWND,
    hwnd_tv_downloads: HWND,
    hwnd_tv_apply: HWND,
    hwnd_tv_backup: HWND,
    hwnd_lbl_dl_status: HWND,
    hwnd_lbl_apply_status: HWND,
    hwnd_lbl_backup_status: HWND,

    // Tab 3 (Synonyms & OOV) controls
    tab3_ctrls: Vec<HWND>,
    hwnd_btn_syn_save: HWND,
    hwnd_btn_syn_rebuild: HWND,
    hwnd_btn_syn_import: HWND,
    hwnd_btn_oov_refresh: HWND,
    hwnd_lbl_syn_custom: HWND,
    hwnd_edit_syn_custom: HWND,
    hwnd_lbl_oov_report: HWND,
    hwnd_edit_oov_report: HWND,

    // Data state
    last_log_id: u64,
    log_size_kb: Option<u64>,
    log_btn_red: bool,
    last_vpn_online: Option<bool>,
    pack_all_files: Vec<PackFileItem>,
    pack_checked: HashSet<String>,
    pack_skip_regex: String,
    pack_presets: Vec<Value>,
    pack_nodes: HashMap<isize, TreeNodeData>,

    apply_zip_name: String,
    apply_zip_bytes: Vec<u8>,
    apply_entries: Vec<ApplyEntryInfo>,
    apply_checked: HashSet<String>,
    apply_nodes: HashMap<isize, TreeNodeData>,
    backups: Vec<BackupInfo>,
    backup_items: Vec<BackupTreeItem>,
    backup_checked: HashSet<String>,
    backup_nodes: HashMap<isize, TreeNodeData>,
    downloads_dir: Option<PathBuf>,
    downloads_items: Vec<DownloadTreeItem>,
    downloads_checked: HashSet<String>,
    downloads_nodes: HashMap<isize, TreeNodeData>,

    mailbox: Arc<GuiMailbox>,
    handoff_build: Option<(PathBuf, PathBuf)>,
    closing: bool,
}

unsafe fn create_ctrl(
    class_name: &str,
    text: &str,
    style: u32,
    ex_style: u32,
    id: u16,
    parent: HWND,
    hinst: windows_sys::Win32::Foundation::HINSTANCE,
    font: HFONT,
) -> HWND {
    let cls_w = to_wide(class_name);
    let txt_w = to_wide(text);
    let h = CreateWindowExW(
        ex_style,
        cls_w.as_ptr(),
        txt_w.as_ptr(),
        WS_CHILD | WS_CLIPSIBLINGS | style,
        0,
        0,
        10,
        10,
        parent,
        id as usize as HMENU,
        hinst,
        std::ptr::null(),
    );
    if !h.is_null() && !font.is_null() {
        SendMessageW(h, WM_SETFONT, font as usize, 1);
    }
    h
}

static ORIG_GROUPBOX_PROC: AtomicIsize = AtomicIsize::new(0);

/// Win32 BS_GROUPBOX 默认不擦除内部背景，在父窗启用 WS_CLIPCHILDREN 且 Tab 沉底时会残留其它标签页画面；
/// 配合 WS_CLIPSIBLINGS（自动裁掉上层交互控件）在 WM_ERASEBKGND 中主动填充 COLOR_3DFACE，彻底消除残影。
unsafe extern "system" fn groupbox_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_ERASEBKGND {
        let hdc = wparam as HDC;
        let mut rc: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut rc);
        FillRect(hdc, &rc, GetSysColorBrush(COLOR_3DFACE));
        return 1;
    }
    let orig = ORIG_GROUPBOX_PROC.load(Ordering::Relaxed);
    if orig != 0 {
        let f: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
            std::mem::transmute(orig as usize);
        CallWindowProcW(Some(f), hwnd, msg, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

unsafe fn subclass_groupbox(hwnd: HWND) {
    if hwnd.is_null() {
        return;
    }
    let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, groupbox_proc as *const () as usize as isize);
    if prev != 0 {
        let _ = ORIG_GROUPBOX_PROC.compare_exchange(
            0,
            prev,
            Ordering::SeqCst,
            Ordering::Relaxed,
        );
    }
}

pub fn run_management_window(
    state: Arc<AppState>,
    shutdown_notify: Arc<Notify>,
) -> Option<(PathBuf, PathBuf)> {
    unsafe {
        enable_dpi_awareness();
        let dpi = query_dpi(std::ptr::null_mut());

        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_TAB_CLASSES | ICC_TREEVIEW_CLASSES,
        };
        InitCommonControlsEx(&icc);

        let hinst = GetModuleHandleW(std::ptr::null());
        let class_name = to_wide("SwampClassicAdminWnd");

        let icon_green_big = build_orb_hicon(sc(32, dpi), true);
        let icon_green_small = build_orb_hicon(sc(16, dpi), true);
        let icon_red_big = build_orb_hicon(sc(32, dpi), false);
        let icon_red_small = build_orb_hicon(sc(16, dpi), false);
        let bg_brush = GetSysColorBrush(COLOR_3DFACE);
        let edit_ro_brush = CreateSolidBrush(RO_EDIT_BG_RGB);
        let btn_red_brush = CreateSolidBrush(BTN_RED_BG_RGB);
        let btn_red_pressed_brush = CreateSolidBrush(BTN_RED_PRESSED_RGB);
        let btn_red_border_brush = CreateSolidBrush(BTN_RED_BORDER_RGB);

        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: icon_red_big,
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: bg_brush,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc);

        let (font_ui, font_mono) = create_scaled_fonts(dpi);

        let gui = Box::new(GuiData {
            state: state.clone(),
            shutdown_notify,
            dpi,
            font_ui,
            font_mono,
            edit_ro_brush,
            btn_red_brush,
            btn_red_pressed_brush,
            btn_red_border_brush,
            icon_green_big,
            icon_green_small,
            icon_red_big,
            icon_red_small,
            himl_pack: build_tristate_imagelist(dpi),
            himl_apply: build_tristate_imagelist(dpi),
            himl_backup: build_tristate_imagelist(dpi),
            himl_downloads: build_tristate_imagelist(dpi),
            hwnd_main: std::ptr::null_mut(),
            hwnd_tab: std::ptr::null_mut(),
            hwnd_lbl_log: std::ptr::null_mut(),
            hwnd_btn_clear_log: std::ptr::null_mut(),
            hwnd_edit_log: std::ptr::null_mut(),
            tab0_ctrls: Vec::new(),
            hwnd_grp_ops: std::ptr::null_mut(),
            hwnd_btn_open_site: std::ptr::null_mut(),
            hwnd_btn_gen: std::ptr::null_mut(),
            hwnd_btn_gen_push: std::ptr::null_mut(),
            hwnd_btn_push: std::ptr::null_mut(),
            hwnd_btn_sim: std::ptr::null_mut(),
            hwnd_btn_selfcheck: std::ptr::null_mut(),
            hwnd_btn_root: std::ptr::null_mut(),
            hwnd_lbl_commit: std::ptr::null_mut(),
            hwnd_edit_commit: std::ptr::null_mut(),
            hwnd_btn_reauth: std::ptr::null_mut(),
            hwnd_grp_new: std::ptr::null_mut(),
            hwnd_lbl_new_title: std::ptr::null_mut(),
            hwnd_edit_new_title: std::ptr::null_mut(),
            hwnd_lbl_new_cat_h: std::ptr::null_mut(),
            hwnd_edit_new_cat: std::ptr::null_mut(),
            hwnd_chk_new_open: std::ptr::null_mut(),
            hwnd_btn_new: std::ptr::null_mut(),
            hwnd_grp_webp: std::ptr::null_mut(),
            hwnd_lbl_webp_w: std::ptr::null_mut(),
            hwnd_edit_webp_w: std::ptr::null_mut(),
            hwnd_lbl_webp_q: std::ptr::null_mut(),
            hwnd_edit_webp_q: std::ptr::null_mut(),
            hwnd_chk_webp_alt: std::ptr::null_mut(),
            hwnd_chk_webp_map: std::ptr::null_mut(),
            hwnd_btn_webp: std::ptr::null_mut(),
            hwnd_grp_keep: std::ptr::null_mut(),
            hwnd_lbl_keep_mode: std::ptr::null_mut(),
            hwnd_cmb_keep_mode: std::ptr::null_mut(),
            hwnd_lbl_keep_tag: std::ptr::null_mut(),
            hwnd_edit_keep_tag: std::ptr::null_mut(),
            hwnd_lbl_keep_cat: std::ptr::null_mut(),
            hwnd_edit_keep_cat: std::ptr::null_mut(),
            hwnd_btn_keep: std::ptr::null_mut(),
            tab1_ctrls: Vec::new(),
            hwnd_lbl_pack_preset: std::ptr::null_mut(),
            hwnd_cmb_pack_preset: std::ptr::null_mut(),
            hwnd_btn_preset_only: std::ptr::null_mut(),
            hwnd_btn_preset_add: std::ptr::null_mut(),
            hwnd_btn_git_mod: std::ptr::null_mut(),
            hwnd_chk_pack_more: std::ptr::null_mut(),
            hwnd_lbl_pack_filter: std::ptr::null_mut(),
            hwnd_edit_pack_filter: std::ptr::null_mut(),
            hwnd_btn_pack_clear: std::ptr::null_mut(),
            hwnd_btn_pack_refresh: std::ptr::null_mut(),
            hwnd_btn_pack_zip: std::ptr::null_mut(),
            hwnd_lbl_preset_name: std::ptr::null_mut(),
            hwnd_edit_preset_name: std::ptr::null_mut(),
            hwnd_btn_preset_save: std::ptr::null_mut(),
            hwnd_btn_preset_del: std::ptr::null_mut(),
            hwnd_chk_pack_md: std::ptr::null_mut(),
            hwnd_lbl_pack_md_max: std::ptr::null_mut(),
            hwnd_edit_pack_md_max: std::ptr::null_mut(),
            hwnd_lbl_pack_md_unit: std::ptr::null_mut(),
            hwnd_tv_pack: std::ptr::null_mut(),
            hwnd_lbl_pack_status: std::ptr::null_mut(),
            tab2_ctrls: Vec::new(),
            hwnd_btn_apply_browse: std::ptr::null_mut(),
            hwnd_chk_apply_bak: std::ptr::null_mut(),
            hwnd_chk_apply_enc: std::ptr::null_mut(),
            hwnd_chk_apply_build: std::ptr::null_mut(),
            hwnd_btn_apply_exec: std::ptr::null_mut(),
            hwnd_lbl_rollback: std::ptr::null_mut(),
            hwnd_cmb_rollback: std::ptr::null_mut(),
            hwnd_btn_rollback: std::ptr::null_mut(),
            hwnd_btn_bak_refresh: std::ptr::null_mut(),
            hwnd_btn_dl_open: std::ptr::null_mut(),
            hwnd_btn_dl_del: std::ptr::null_mut(),
            hwnd_btn_backup_open: std::ptr::null_mut(),
            hwnd_btn_backup_del: std::ptr::null_mut(),
            hwnd_lbl_dl_tree: std::ptr::null_mut(),
            hwnd_lbl_apply_tree: std::ptr::null_mut(),
            hwnd_lbl_backup_tree: std::ptr::null_mut(),
            hwnd_tv_downloads: std::ptr::null_mut(),
            hwnd_tv_apply: std::ptr::null_mut(),
            hwnd_tv_backup: std::ptr::null_mut(),
            hwnd_lbl_dl_status: std::ptr::null_mut(),
            hwnd_lbl_apply_status: std::ptr::null_mut(),
            hwnd_lbl_backup_status: std::ptr::null_mut(),
            tab3_ctrls: Vec::new(),
            hwnd_btn_syn_save: std::ptr::null_mut(),
            hwnd_btn_syn_rebuild: std::ptr::null_mut(),
            hwnd_btn_syn_import: std::ptr::null_mut(),
            hwnd_btn_oov_refresh: std::ptr::null_mut(),
            hwnd_lbl_syn_custom: std::ptr::null_mut(),
            hwnd_edit_syn_custom: std::ptr::null_mut(),
            hwnd_lbl_oov_report: std::ptr::null_mut(),
            hwnd_edit_oov_report: std::ptr::null_mut(),
            last_log_id: 0,
            log_size_kb: None,
            log_btn_red: false,
            last_vpn_online: None,
            pack_all_files: Vec::new(),
            pack_checked: HashSet::new(),
            pack_skip_regex: crate::config::DEFAULT_SKIP_APPLY_REGEX.to_string(),
            pack_presets: Vec::new(),
            pack_nodes: HashMap::new(),
            apply_zip_name: String::new(),
            apply_zip_bytes: Vec::new(),
            apply_entries: Vec::new(),
            apply_checked: HashSet::new(),
            apply_nodes: HashMap::new(),
            backups: Vec::new(),
            backup_items: Vec::new(),
            backup_checked: HashSet::new(),
            backup_nodes: HashMap::new(),
            downloads_dir: None,
            downloads_items: Vec::new(),
            downloads_checked: HashSet::new(),
            downloads_nodes: HashMap::new(),
            mailbox: Arc::new(GuiMailbox::new()),
            handoff_build: None,
            closing: false,
        });

        let title_w = to_wide(&format!(
            "Swamp 管理控制台 [VPN: 探测中] - http://localhost:{}",
            state.config.port
        ));

        let gui_ptr = Box::into_raw(gui);
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title_w.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            sc(120, dpi),
            sc(80, dpi),
            sc(960, dpi),
            sc(700, dpi),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinst,
            gui_ptr as *const _,
        );

        if hwnd.is_null() {
            drop(Box::from_raw(gui_ptr));
            return None;
        }

        state.logs.set_notify_hwnd(hwnd as isize);
        state.runtime.set_ui_hwnd(hwnd as isize);

        ShowWindow(hwnd, SW_SHOW);
        PostMessageW(hwnd, WM_APP_LOG, 0, 0);
        if state.runtime.vpn_has_result.load(Ordering::Relaxed) {
            let online = state.runtime.vpn_online.load(Ordering::Relaxed);
            PostMessageW(hwnd, WM_APP_VPN, if online { 1 } else { 0 }, 0);
        }

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        state.logs.set_notify_hwnd(0);
        state.runtime.set_ui_hwnd(0);

        let mut box_gui = Box::from_raw(gui_ptr);
        let handoff_build = box_gui.handoff_build.take();
        if !box_gui.font_ui.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(box_gui.font_ui);
        }
        if !box_gui.font_mono.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(box_gui.font_mono);
        }
        if !box_gui.edit_ro_brush.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(box_gui.edit_ro_brush);
        }
        if !box_gui.btn_red_brush.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(box_gui.btn_red_brush);
        }
        if !box_gui.btn_red_pressed_brush.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(box_gui.btn_red_pressed_brush);
        }
        if !box_gui.btn_red_border_brush.is_null() {
            windows_sys::Win32::Graphics::Gdi::DeleteObject(box_gui.btn_red_border_brush);
        }
        if !box_gui.icon_green_big.is_null() {
            DestroyIcon(box_gui.icon_green_big);
        }
        if !box_gui.icon_green_small.is_null() {
            DestroyIcon(box_gui.icon_green_small);
        }
        if !box_gui.icon_red_big.is_null() {
            DestroyIcon(box_gui.icon_red_big);
        }
        if !box_gui.icon_red_small.is_null() {
            DestroyIcon(box_gui.icon_red_small);
        }
        if box_gui.himl_pack != 0 {
            ImageList_Destroy(box_gui.himl_pack);
        }
        if box_gui.himl_apply != 0 {
            ImageList_Destroy(box_gui.himl_apply);
        }
        if box_gui.himl_backup != 0 {
            ImageList_Destroy(box_gui.himl_backup);
        }
        if box_gui.himl_downloads != 0 {
            ImageList_Destroy(box_gui.himl_downloads);
        }
        handoff_build
    }
}

unsafe fn build_all_controls(g: &mut GuiData, hwnd: HWND) {
    let hinst = GetModuleHandleW(std::ptr::null());
    let f = g.font_ui;
    let fm = g.font_mono;

    g.hwnd_tab = create_ctrl(
        "SysTabControl32",
        "",
        WS_VISIBLE | WS_TABSTOP,
        0,
        IDC_TAB,
        hwnd,
        hinst,
        f,
    );
    for (idx, label) in [
        " 常规 ",
        " 打包协作 ",
        " 回填补丁 ",
        " 同义词 ",
    ]
    .iter()
    .enumerate()
    {
        let mut w = to_wide(label);
        let item = TCITEMW {
            mask: TCIF_TEXT,
            dwState: 0,
            dwStateMask: 0,
            pszText: w.as_mut_ptr(),
            cchTextMax: 0,
            iImage: -1,
            lParam: 0,
        };
        SendMessageW(
            g.hwnd_tab,
            TCM_INSERTITEMW,
            idx,
            &item as *const _ as LPARAM,
        );
    }

    // Bottom Live Log (always visible)
    g.hwnd_lbl_log = create_ctrl(
        "STATIC",
        "实时运行日志 [0 KB]:",
        WS_VISIBLE,
        0,
        IDC_LBL_LOG,
        hwnd,
        hinst,
        f,
    );
    g.hwnd_btn_clear_log = create_ctrl(
        "BUTTON",
        "清空日志",
        WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
        0,
        IDC_BTN_CLEAR_LOG,
        hwnd,
        hinst,
        f,
    );
    g.hwnd_edit_log = create_ctrl(
        "EDIT",
        "",
        WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
        WS_EX_CLIENTEDGE,
        IDC_EDIT_LOG,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_edit_log, EM_SETLIMITTEXT, 512 * 1024, 0);

    // ================= TAB 0: 常规 =================
    g.hwnd_grp_ops = create_ctrl("BUTTON", "构建", BS_GROUPBOX, 0, IDC_GRP_OPS, hwnd, hinst, f);
    g.hwnd_btn_gen_push = create_ctrl("BUTTON", "gen + push", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_GEN_PUSH, hwnd, hinst, f);
    g.hwnd_btn_push = create_ctrl("BUTTON", "push", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PUSH, hwnd, hinst, f);
    g.hwnd_btn_gen = create_ctrl("BUTTON", "gen", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_GEN, hwnd, hinst, f);
    g.hwnd_btn_root = create_ctrl("BUTTON", "root/", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_ROOT, hwnd, hinst, f);
    g.hwnd_btn_selfcheck = create_ctrl("BUTTON", "selfcheck", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_SELFCHECK, hwnd, hinst, f);
    g.hwnd_btn_sim = create_ctrl("BUTTON", "simulator (9000)", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_SIM, hwnd, hinst, f);
    g.hwnd_btn_open_site = create_ctrl("BUTTON", "Open Site", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_OPEN_SITE, hwnd, hinst, f);
    g.hwnd_lbl_commit = create_ctrl("STATIC", "Commit:", 0, 0, IDC_LBL_COMMIT, hwnd, hinst, f);
    g.hwnd_edit_commit = create_ctrl("EDIT", "update", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_COMMIT, hwnd, hinst, f);
    g.hwnd_btn_reauth = create_ctrl("BUTTON", "Google Tasks 授权", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_REAUTH, hwnd, hinst, f);

    g.hwnd_grp_new = create_ctrl("BUTTON", "新建 HTML 页面", BS_GROUPBOX, 0, IDC_GRP_NEW, hwnd, hinst, f);
    g.hwnd_lbl_new_title = create_ctrl("STATIC", "标题:", 0, 0, IDC_LBL_NEW_TITLE, hwnd, hinst, f);
    g.hwnd_edit_new_title = create_ctrl("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_NEW_TITLE, hwnd, hinst, f);
    g.hwnd_lbl_new_cat_h = create_ctrl("STATIC", "分类链:", 0, 0, IDC_LBL_NEW_CAT, hwnd, hinst, f);
    g.hwnd_edit_new_cat = create_ctrl("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_NEW_CAT, hwnd, hinst, f);
    g.hwnd_chk_new_open = create_ctrl("BUTTON", "创建后用 VS Code 打开", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_NEW_OPEN, hwnd, hinst, f);
    set_checked(g.hwnd_chk_new_open, true);
    g.hwnd_btn_new = create_ctrl("BUTTON", "创建页面", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_NEW, hwnd, hinst, f);

    g.hwnd_grp_webp = create_ctrl("BUTTON", "批量转 WebP", BS_GROUPBOX, 0, IDC_GRP_WEBP, hwnd, hinst, f);
    g.hwnd_lbl_webp_w = create_ctrl("STATIC", "最大宽度:", 0, 0, IDC_LBL_WEBP_W, hwnd, hinst, f);
    g.hwnd_edit_webp_w = create_ctrl(
        "EDIT",
        &g.state.config.img_max_width.to_string(),
        WS_TABSTOP | ES_AUTOHSCROLL,
        WS_EX_CLIENTEDGE,
        IDC_EDIT_WEBP_W,
        hwnd,
        hinst,
        f,
    );
    g.hwnd_lbl_webp_q = create_ctrl("STATIC", "质量(1-100):", 0, 0, IDC_LBL_WEBP_Q, hwnd, hinst, f);
    g.hwnd_edit_webp_q = create_ctrl(
        "EDIT",
        &g.state.config.webp_quality.to_string(),
        WS_TABSTOP | ES_AUTOHSCROLL,
        WS_EX_CLIENTEDGE,
        IDC_EDIT_WEBP_Q,
        hwnd,
        hinst,
        f,
    );
    g.hwnd_chk_webp_alt = create_ctrl("BUTTON", "备用输出目录", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_WEBP_ALT, hwnd, hinst, f);
    g.hwnd_chk_webp_map = create_ctrl("BUTTON", "替换 HTML 引用", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_WEBP_MAP, hwnd, hinst, f);
    g.hwnd_btn_webp = create_ctrl("BUTTON", "批量转 WebP", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_WEBP, hwnd, hinst, f);

    g.hwnd_grp_keep = create_ctrl("BUTTON", "Google Keep 笔记转 HTML", BS_GROUPBOX, 0, IDC_GRP_KEEP, hwnd, hinst, f);
    g.hwnd_lbl_keep_mode = create_ctrl("STATIC", "模式:", 0, 0, IDC_LBL_KEEP_MODE, hwnd, hinst, f);
    g.hwnd_cmb_keep_mode = create_ctrl("COMBOBOX", "", WS_TABSTOP | CBS_DROPDOWNLIST, 0, IDC_CMB_KEEP_MODE, hwnd, hinst, f);
    for m in ["单篇转换 (single)", "多合一转换 (merge)"] {
        let w = to_wide(m);
        SendMessageW(g.hwnd_cmb_keep_mode, CB_ADDSTRING, 0, w.as_ptr() as LPARAM);
    }
    SendMessageW(g.hwnd_cmb_keep_mode, CB_SETCURSEL, 0, 0);
    g.hwnd_lbl_keep_tag = create_ctrl("STATIC", "合并标签:", 0, 0, IDC_LBL_KEEP_TAG, hwnd, hinst, f);
    g.hwnd_edit_keep_tag = create_ctrl("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_KEEP_TAG, hwnd, hinst, f);
    g.hwnd_lbl_keep_cat = create_ctrl("STATIC", "合并分类:", 0, 0, IDC_LBL_KEEP_CAT, hwnd, hinst, f);
    g.hwnd_edit_keep_cat = create_ctrl("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_KEEP_CAT, hwnd, hinst, f);
    g.hwnd_btn_keep = create_ctrl("BUTTON", "执行 Keep2Html", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_KEEP, hwnd, hinst, f);

    g.tab0_ctrls = vec![
        g.hwnd_grp_ops,
        g.hwnd_btn_gen_push,
        g.hwnd_btn_push,
        g.hwnd_btn_gen,
        g.hwnd_btn_root,
        g.hwnd_btn_selfcheck,
        g.hwnd_btn_sim,
        g.hwnd_btn_open_site,
        g.hwnd_lbl_commit,
        g.hwnd_edit_commit,
        g.hwnd_btn_reauth,
        g.hwnd_grp_new,
        g.hwnd_lbl_new_title,
        g.hwnd_edit_new_title,
        g.hwnd_lbl_new_cat_h,
        g.hwnd_edit_new_cat,
        g.hwnd_chk_new_open,
        g.hwnd_btn_new,
        g.hwnd_grp_webp,
        g.hwnd_lbl_webp_w,
        g.hwnd_edit_webp_w,
        g.hwnd_lbl_webp_q,
        g.hwnd_edit_webp_q,
        g.hwnd_chk_webp_alt,
        g.hwnd_chk_webp_map,
        g.hwnd_btn_webp,
        g.hwnd_grp_keep,
        g.hwnd_lbl_keep_mode,
        g.hwnd_cmb_keep_mode,
        g.hwnd_lbl_keep_tag,
        g.hwnd_edit_keep_tag,
        g.hwnd_lbl_keep_cat,
        g.hwnd_edit_keep_cat,
        g.hwnd_btn_keep,
    ];

    // ================= TAB 1: 打包 (Pack) =================
    g.hwnd_lbl_pack_preset = create_ctrl("STATIC", "预设:", 0, 0, IDC_LBL_PACK_PRESET, hwnd, hinst, f);
    g.hwnd_cmb_pack_preset = create_ctrl("COMBOBOX", "", WS_TABSTOP | CBS_DROPDOWNLIST, 0, IDC_CMB_PACK_PRESET, hwnd, hinst, f);
    g.hwnd_btn_preset_only = create_ctrl("BUTTON", "仅选预设", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PRESET_ONLY, hwnd, hinst, f);
    g.hwnd_btn_preset_add = create_ctrl("BUTTON", "累加预设", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PRESET_ADD, hwnd, hinst, f);
    g.hwnd_btn_git_mod = create_ctrl("BUTTON", "勾选Git改动", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_GIT_MOD, hwnd, hinst, f);
    g.hwnd_chk_pack_more = create_ctrl("BUTTON", "更多目录", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_PACK_MORE, hwnd, hinst, f);
    g.hwnd_lbl_pack_filter = create_ctrl("STATIC", "筛选:", 0, 0, IDC_LBL_PACK_FILTER, hwnd, hinst, f);
    g.hwnd_edit_pack_filter = create_ctrl("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_PACK_FILTER, hwnd, hinst, f);
    g.hwnd_btn_pack_clear = create_ctrl("BUTTON", "清空已选", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PACK_CLEAR, hwnd, hinst, f);
    g.hwnd_btn_pack_refresh = create_ctrl("BUTTON", "刷新", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PACK_REFRESH, hwnd, hinst, f);
    g.hwnd_btn_pack_zip = create_ctrl("BUTTON", "按原层级打包 ZIP", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PACK_ZIP, hwnd, hinst, f);
    g.hwnd_tv_pack = create_ctrl(
        "SysTreeView32",
        "",
        WS_TABSTOP | TVS_HASBUTTONS | TVS_HASLINES | TVS_LINESATROOT | TVS_SHOWSELALWAYS,
        WS_EX_CLIENTEDGE,
        IDC_TV_PACK,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_tv_pack, TVM_SETIMAGELIST, TVSIL_STATE as WPARAM, g.himl_pack as LPARAM);
    g.hwnd_lbl_preset_name = create_ctrl("STATIC", "预设名:", 0, 0, IDC_LBL_PRESET_NAME, hwnd, hinst, f);
    g.hwnd_edit_preset_name = create_ctrl("EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_PRESET_NAME, hwnd, hinst, f);
    g.hwnd_btn_preset_save = create_ctrl("BUTTON", "保存当前为预设", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PRESET_SAVE, hwnd, hinst, f);
    g.hwnd_btn_preset_del = create_ctrl("BUTTON", "删除预设", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_PRESET_DEL, hwnd, hinst, f);
    g.hwnd_chk_pack_md = create_ctrl("BUTTON", "拼接 MD", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_PACK_MD, hwnd, hinst, f);
    g.hwnd_lbl_pack_md_max = create_ctrl("STATIC", "单MD上限:", 0, 0, IDC_LBL_PACK_MD_MAX, hwnd, hinst, f);
    g.hwnd_edit_pack_md_max = create_ctrl("EDIT", "200", WS_TABSTOP | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, IDC_EDIT_PACK_MD_MAX, hwnd, hinst, f);
    EnableWindow(g.hwnd_edit_pack_md_max, 0);
    g.hwnd_lbl_pack_md_unit = create_ctrl("STATIC", "KB", 0, 0, IDC_LBL_PACK_MD_UNIT, hwnd, hinst, f);
    g.hwnd_lbl_pack_status = create_ctrl("STATIC", "已选 0 个文件 (0 B)", 0, 0, IDC_LBL_PACK_STATUS, hwnd, hinst, f);

    g.tab1_ctrls = vec![
        g.hwnd_lbl_pack_preset,
        g.hwnd_cmb_pack_preset,
        g.hwnd_btn_preset_only,
        g.hwnd_btn_preset_add,
        g.hwnd_btn_git_mod,
        g.hwnd_chk_pack_more,
        g.hwnd_lbl_preset_name,
        g.hwnd_edit_preset_name,
        g.hwnd_btn_preset_save,
        g.hwnd_btn_preset_del,
        g.hwnd_chk_pack_md,
        g.hwnd_lbl_pack_md_max,
        g.hwnd_edit_pack_md_max,
        g.hwnd_lbl_pack_md_unit,
        g.hwnd_lbl_pack_filter,
        g.hwnd_edit_pack_filter,
        g.hwnd_btn_pack_clear,
        g.hwnd_btn_pack_refresh,
        g.hwnd_btn_pack_zip,
        g.hwnd_tv_pack,
        g.hwnd_lbl_pack_status,
    ];

    // ================= TAB 2: 回填补丁 (Apply) =================
    g.hwnd_btn_apply_browse = create_ctrl("BUTTON", "选择补丁 ZIP...", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_APPLY_BROWSE, hwnd, hinst, f);
    g.hwnd_chk_apply_bak = create_ctrl("BUTTON", "覆盖前备份", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_APPLY_BAK, hwnd, hinst, f);
    set_checked(g.hwnd_chk_apply_bak, true);
    g.hwnd_chk_apply_enc = create_ctrl("BUTTON", "守卫bat/ps1编码", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_APPLY_ENC, hwnd, hinst, f);
    set_checked(g.hwnd_chk_apply_enc, true);
    g.hwnd_chk_apply_build = create_ctrl("BUTTON", "回填后拉起 build.bat 并退出", WS_TABSTOP | BS_AUTOCHECKBOX, 0, IDC_CHK_APPLY_BUILD, hwnd, hinst, f);
    g.hwnd_btn_apply_exec = create_ctrl("BUTTON", "一键回填选中", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_APPLY_EXEC, hwnd, hinst, f);
    EnableWindow(g.hwnd_btn_apply_exec, 0);

    g.hwnd_lbl_rollback = create_ctrl("STATIC", "回滚快照:", 0, 0, IDC_LBL_ROLLBACK, hwnd, hinst, f);
    g.hwnd_cmb_rollback = create_ctrl("COMBOBOX", "", WS_TABSTOP | CBS_DROPDOWNLIST, 0, IDC_CMB_ROLLBACK, hwnd, hinst, f);
    g.hwnd_btn_rollback = create_ctrl("BUTTON", "从备份回滚", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_ROLLBACK, hwnd, hinst, f);
    g.hwnd_btn_bak_refresh = create_ctrl("BUTTON", "刷新全部", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_BAK_REFRESH, hwnd, hinst, f);

    g.hwnd_lbl_dl_tree = create_ctrl("STATIC", "Downloads (双击.zip加载):", 0, 0, IDC_LBL_DL_TREE, hwnd, hinst, f);
    g.hwnd_btn_dl_open = create_ctrl("BUTTON", "打开", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_DL_OPEN, hwnd, hinst, f);
    g.hwnd_btn_dl_del = create_ctrl("BUTTON", "清理", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_DL_DEL, hwnd, hinst, f);
    EnableWindow(g.hwnd_btn_dl_del, 0);

    g.hwnd_lbl_apply_tree = create_ctrl("STATIC", "补丁预览 (双击左栏或拖入 .zip):", 0, 0, IDC_LBL_APPLY_TREE, hwnd, hinst, f);

    g.hwnd_lbl_backup_tree = create_ctrl("STATIC", "backup 目录树:", 0, 0, IDC_LBL_BACKUP_TREE, hwnd, hinst, f);
    g.hwnd_btn_backup_open = create_ctrl("BUTTON", "打开", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_BACKUP_OPEN, hwnd, hinst, f);
    g.hwnd_btn_backup_del = create_ctrl("BUTTON", "清理", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_BACKUP_DEL, hwnd, hinst, f);
    EnableWindow(g.hwnd_btn_backup_del, 0);

    g.hwnd_tv_downloads = create_ctrl(
        "SysTreeView32",
        "",
        WS_TABSTOP | TVS_HASBUTTONS | TVS_HASLINES | TVS_LINESATROOT | TVS_SHOWSELALWAYS,
        WS_EX_CLIENTEDGE,
        IDC_TV_DOWNLOADS,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_tv_downloads, TVM_SETIMAGELIST, TVSIL_STATE as WPARAM, g.himl_downloads as LPARAM);

    g.hwnd_tv_apply = create_ctrl(
        "SysTreeView32",
        "",
        WS_TABSTOP | TVS_HASBUTTONS | TVS_HASLINES | TVS_LINESATROOT | TVS_SHOWSELALWAYS,
        WS_EX_CLIENTEDGE,
        IDC_TV_APPLY,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_tv_apply, TVM_SETIMAGELIST, TVSIL_STATE as WPARAM, g.himl_apply as LPARAM);

    g.hwnd_tv_backup = create_ctrl(
        "SysTreeView32",
        "",
        WS_TABSTOP | TVS_HASBUTTONS | TVS_HASLINES | TVS_LINESATROOT | TVS_SHOWSELALWAYS,
        WS_EX_CLIENTEDGE,
        IDC_TV_BACKUP,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_tv_backup, TVM_SETIMAGELIST, TVSIL_STATE as WPARAM, g.himl_backup as LPARAM);

    g.hwnd_lbl_dl_status = create_ctrl(
        "STATIC",
        "正在扫描 Downloads...",
        0,
        0,
        IDC_LBL_DL_STATUS,
        hwnd,
        hinst,
        f,
    );
    g.hwnd_lbl_apply_status = create_ctrl(
        "STATIC",
        "双击左侧 .zip 或拖入 .zip 到窗口任意位置",
        0,
        0,
        IDC_LBL_APPLY_STATUS,
        hwnd,
        hinst,
        f,
    );
    g.hwnd_lbl_backup_status = create_ctrl(
        "STATIC",
        "正在扫描 backup...",
        0,
        0,
        IDC_LBL_BACKUP_STATUS,
        hwnd,
        hinst,
        f,
    );

    g.tab2_ctrls = vec![
        g.hwnd_btn_apply_browse,
        g.hwnd_chk_apply_bak,
        g.hwnd_chk_apply_enc,
        g.hwnd_chk_apply_build,
        g.hwnd_btn_apply_exec,
        g.hwnd_lbl_rollback,
        g.hwnd_cmb_rollback,
        g.hwnd_btn_rollback,
        g.hwnd_btn_bak_refresh,
        g.hwnd_lbl_dl_tree,
        g.hwnd_btn_dl_open,
        g.hwnd_btn_dl_del,
        g.hwnd_lbl_apply_tree,
        g.hwnd_lbl_backup_tree,
        g.hwnd_btn_backup_open,
        g.hwnd_btn_backup_del,
        g.hwnd_tv_downloads,
        g.hwnd_tv_apply,
        g.hwnd_tv_backup,
        g.hwnd_lbl_dl_status,
        g.hwnd_lbl_apply_status,
        g.hwnd_lbl_backup_status,
    ];

    // ================= TAB 3: 同义词 (Synonyms) =================
    g.hwnd_btn_syn_save = create_ctrl("BUTTON", "保存到 swamp.toml", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_SYN_SAVE, hwnd, hinst, f);
    g.hwnd_btn_syn_rebuild = create_ctrl("BUTTON", "重建 synonyms.js + gen", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_SYN_REBUILD, hwnd, hinst, f);
    g.hwnd_btn_syn_import = create_ctrl("BUTTON", "导入旧 JSON...", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_SYN_IMPORT, hwnd, hinst, f);
    g.hwnd_btn_oov_refresh = create_ctrl("BUTTON", "刷新 OOV 报告", WS_TABSTOP | BS_PUSHBUTTON, 0, IDC_BTN_OOV_REFRESH, hwnd, hinst, f);
    g.hwnd_lbl_syn_custom = create_ctrl("STATIC", "自定义同义词 (synonyms_custom，存入 swamp.toml):", 0, 0, IDC_LBL_SYN_CUSTOM, hwnd, hinst, f);
    g.hwnd_edit_syn_custom = create_ctrl(
        "EDIT",
        "",
        WS_TABSTOP | WS_VSCROLL | WS_HSCROLL | ES_MULTILINE | ES_AUTOVSCROLL | ES_AUTOHSCROLL | ES_WANTRETURN,
        WS_EX_CLIENTEDGE,
        IDC_EDIT_SYN_CUSTOM,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_edit_syn_custom, EM_SETLIMITTEXT, 2 * 1024 * 1024, 0);
    g.hwnd_lbl_oov_report = create_ctrl("STATIC", "本地新词雷达 (oov_report，构建后自动刷新):", 0, 0, IDC_LBL_OOV_REPORT, hwnd, hinst, f);
    g.hwnd_edit_oov_report = create_ctrl(
        "EDIT",
        "",
        WS_VSCROLL | WS_HSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | ES_AUTOHSCROLL,
        WS_EX_CLIENTEDGE,
        IDC_EDIT_OOV_REPORT,
        hwnd,
        hinst,
        fm,
    );
    SendMessageW(g.hwnd_edit_oov_report, EM_SETLIMITTEXT, 2 * 1024 * 1024, 0);

    g.tab3_ctrls = vec![
        g.hwnd_btn_syn_save,
        g.hwnd_btn_syn_rebuild,
        g.hwnd_btn_syn_import,
        g.hwnd_btn_oov_refresh,
        g.hwnd_lbl_syn_custom,
        g.hwnd_edit_syn_custom,
        g.hwnd_lbl_oov_report,
        g.hwnd_edit_oov_report,
    ];

    // 修复窗口缩放空白与切页残影：
    // 1) 为 4 个 BS_GROUPBOX 挂载 WM_ERASEBKGND 擦底，并配合 WS_CLIPSIBLINGS 自动裁开上层交互控件；
    // 2) 将 GroupBox 与 SysTabControl32 依次沉底，确保绘制顺序严格为 Tab 背景 -> GroupBox -> 交互控件。
    for grp in [g.hwnd_grp_ops, g.hwnd_grp_new, g.hwnd_grp_webp, g.hwnd_grp_keep] {
        subclass_groupbox(grp);
        SetWindowPos(
            grp,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
    SetWindowPos(
        g.hwnd_tab,
        HWND_BOTTOM,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );

    switch_tab(g, 0);
}

unsafe fn switch_tab(g: &GuiData, idx: i32) {
    let tabs: [(i32, &[HWND]); 4] = [
        (0, &g.tab0_ctrls),
        (1, &g.tab1_ctrls),
        (2, &g.tab2_ctrls),
        (3, &g.tab3_ctrls),
    ];
    // 先隐藏非目标标签页，再显示目标标签页，避免切页瞬间两页控件同时可见
    for (ti, ctrls) in tabs {
        if ti != idx {
            for &h in ctrls {
                ShowWindow(h, SW_HIDE);
            }
        }
    }
    for (ti, ctrls) in tabs {
        if ti == idx {
            for &h in ctrls {
                ShowWindow(h, SW_SHOW);
            }
        }
    }
    if !g.hwnd_main.is_null() {
        RedrawWindow(
            g.hwnd_main,
            std::ptr::null(),
            std::ptr::null_mut(),
            RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW,
        );
    }
}

unsafe fn apply_fonts_to_all_controls(g: &GuiData) {
    let f = g.font_ui as usize;
    let fm = g.font_mono as usize;
    for h in [g.hwnd_tab, g.hwnd_lbl_log, g.hwnd_btn_clear_log] {
        if !h.is_null() {
            SendMessageW(h, WM_SETFONT, f, 1);
        }
    }
    if !g.hwnd_edit_log.is_null() {
        SendMessageW(g.hwnd_edit_log, WM_SETFONT, fm, 1);
    }
    for &h in g
        .tab0_ctrls
        .iter()
        .chain(g.tab1_ctrls.iter())
        .chain(g.tab2_ctrls.iter())
        .chain(g.tab3_ctrls.iter())
    {
        if h.is_null() {
            continue;
        }
        let use_mono = h == g.hwnd_tv_pack
            || h == g.hwnd_tv_downloads
            || h == g.hwnd_tv_apply
            || h == g.hwnd_tv_backup
            || h == g.hwnd_edit_syn_custom
            || h == g.hwnd_edit_oov_report;
        SendMessageW(h, WM_SETFONT, if use_mono { fm } else { f }, 1);
    }
}

unsafe fn layout_controls(g: &GuiData, hwnd: HWND) {
    let d = g.dpi;
    let s = |v: i32| sc(v, d);

    let mut rc: RECT = std::mem::zeroed();
    GetClientRect(hwnd, &mut rc);
    let w = (rc.right - rc.left).max(s(780));
    let h = (rc.bottom - rc.top).max(s(540));

    let pad = s(10);
    let log_h = s(185);
    let log_top = h - pad - log_h;
    let log_hdr_y = log_top - s(25);

    MoveWindow(g.hwnd_lbl_log, pad, log_hdr_y + s(3), (w - pad * 2 - s(90)).max(s(220)), s(20), 1);
    MoveWindow(g.hwnd_btn_clear_log, w - pad - s(78), log_hdr_y, s(78), s(22), 1);
    MoveWindow(g.hwnd_edit_log, pad, log_top, w - pad * 2, log_h, 1);

    let tab_h = (log_hdr_y - pad - s(6)).max(s(270));
    MoveWindow(g.hwnd_tab, pad, pad, w - pad * 2, tab_h, 1);

    let inner_x = pad + s(10);
    let inner_y = pad + s(32);
    let inner_w = w - (pad + s(10)) * 2;
    let inner_h = tab_h - s(40);

    // --- Tab 0 Layout ---
    let mut y = inner_y;
    MoveWindow(g.hwnd_grp_ops, inner_x, y, inner_w, s(84), 1);
    let mut bx = inner_x + s(12);
    let by1 = y + s(22);
    let ops_btn_width = |h: HWND| -> Option<i32> {
        if h == g.hwnd_btn_open_site {
            Some(86)
        } else if h == g.hwnd_btn_gen {
            Some(64)
        } else if h == g.hwnd_btn_gen_push {
            Some(94)
        } else if h == g.hwnd_btn_push {
            Some(64)
        } else if h == g.hwnd_btn_sim {
            Some(118)
        } else if h == g.hwnd_btn_selfcheck {
            Some(80)
        } else if h == g.hwnd_btn_root {
            Some(64)
        } else {
            None
        }
    };
    for &btn in &g.tab0_ctrls {
        if let Some(bw) = ops_btn_width(btn) {
            let sbw = s(bw);
            MoveWindow(btn, bx, by1, sbw, s(25), 1);
            bx += sbw + s(6);
        }
    }
    let by2 = y + s(53);
    MoveWindow(g.hwnd_lbl_commit, inner_x + s(12), by2 + s(3), s(94), s(20), 1);
    let reauth_w = s(138);
    let commit_w = (inner_w - s(12) - s(96) - s(10) - reauth_w - s(12)).max(s(160));
    MoveWindow(g.hwnd_edit_commit, inner_x + s(108), by2, commit_w, s(23), 1);
    MoveWindow(g.hwnd_btn_reauth, inner_x + inner_w - s(12) - reauth_w, by2 - s(1), reauth_w, s(24), 1);

    y += s(90);
    MoveWindow(g.hwnd_grp_new, inner_x, y, inner_w, s(56), 1);
    let ny = y + s(22);
    MoveWindow(g.hwnd_lbl_new_title, inner_x + s(12), ny + s(3), s(38), s(20), 1);
    MoveWindow(g.hwnd_edit_new_title, inner_x + s(52), ny, s(210), s(23), 1);
    MoveWindow(g.hwnd_lbl_new_cat_h, inner_x + s(272), ny + s(3), s(48), s(20), 1);
    MoveWindow(g.hwnd_edit_new_cat, inner_x + s(322), ny, s(190), s(23), 1);
    MoveWindow(g.hwnd_chk_new_open, inner_x + s(522), ny + s(2), s(166), s(20), 1);
    MoveWindow(g.hwnd_btn_new, inner_x + inner_w - s(124), ny - s(1), s(112), s(25), 1);

    y += s(62);
    MoveWindow(g.hwnd_grp_webp, inner_x, y, inner_w, s(56), 1);
    let wy = y + s(22);
    MoveWindow(g.hwnd_lbl_webp_w, inner_x + s(12), wy + s(3), s(64), s(20), 1);
    MoveWindow(g.hwnd_edit_webp_w, inner_x + s(78), wy, s(58), s(23), 1);
    MoveWindow(g.hwnd_lbl_webp_q, inner_x + s(146), wy + s(3), s(74), s(20), 1);
    MoveWindow(g.hwnd_edit_webp_q, inner_x + s(222), wy, s(48), s(23), 1);
    MoveWindow(g.hwnd_chk_webp_alt, inner_x + s(282), wy + s(2), s(116), s(20), 1);
    MoveWindow(g.hwnd_chk_webp_map, inner_x + s(404), wy + s(2), s(130), s(20), 1);
    MoveWindow(g.hwnd_btn_webp, inner_x + inner_w - s(124), wy - s(1), s(112), s(25), 1);

    y += s(62);
    MoveWindow(g.hwnd_grp_keep, inner_x, y, inner_w, s(56), 1);
    let ky = y + s(22);
    MoveWindow(g.hwnd_lbl_keep_mode, inner_x + s(12), ky + s(3), s(38), s(20), 1);
    MoveWindow(g.hwnd_cmb_keep_mode, inner_x + s(52), ky - s(1), s(152), s(120), 1);
    MoveWindow(g.hwnd_lbl_keep_tag, inner_x + s(214), ky + s(3), s(60), s(20), 1);
    MoveWindow(g.hwnd_edit_keep_tag, inner_x + s(276), ky, s(140), s(23), 1);
    MoveWindow(g.hwnd_lbl_keep_cat, inner_x + s(426), ky + s(3), s(60), s(20), 1);
    MoveWindow(g.hwnd_edit_keep_cat, inner_x + s(488), ky, s(140), s(23), 1);
    MoveWindow(g.hwnd_btn_keep, inner_x + inner_w - s(124), ky - s(1), s(112), s(25), 1);

    // --- Tab 1 (Pack) Layout ---
    MoveWindow(g.hwnd_lbl_pack_preset, inner_x, inner_y + s(4), s(38), s(20), 1);
    MoveWindow(g.hwnd_cmb_pack_preset, inner_x + s(40), inner_y, s(260), s(200), 1);
    MoveWindow(g.hwnd_btn_preset_only, inner_x + s(306), inner_y, s(74), s(24), 1);
    MoveWindow(g.hwnd_btn_preset_add, inner_x + s(386), inner_y, s(74), s(24), 1);
    MoveWindow(g.hwnd_btn_git_mod, inner_x + s(466), inner_y, s(92), s(24), 1);
    MoveWindow(g.hwnd_chk_pack_more, inner_x + s(566), inner_y + s(2), s(96), s(20), 1);

    let p_row2 = inner_y + s(30);
    MoveWindow(g.hwnd_lbl_preset_name, inner_x, p_row2 + s(4), s(52), s(20), 1);
    let psave_w = s(112);
    let pdel_w = s(68);
    let md_chk_w = s(78);
    let md_lbl_w = s(68);
    let md_edit_w = s(52);
    let md_unit_w = s(24);
    let md_group_w = md_chk_w + md_lbl_w + md_edit_w + md_unit_w + s(14);
    let pname_w = (inner_w - s(54) - psave_w - pdel_w - md_group_w - s(24))
        .max(s(120))
        .min(s(300));
    MoveWindow(g.hwnd_edit_preset_name, inner_x + s(54), p_row2, pname_w, s(23), 1);
    MoveWindow(g.hwnd_btn_preset_save, inner_x + s(54) + pname_w + s(6), p_row2 - s(1), psave_w, s(24), 1);
    MoveWindow(g.hwnd_btn_preset_del, inner_x + s(54) + pname_w + psave_w + s(12), p_row2 - s(1), pdel_w, s(24), 1);

    let md_x = inner_x + inner_w - md_group_w;
    MoveWindow(g.hwnd_chk_pack_md, md_x, p_row2 + s(2), md_chk_w, s(20), 1);
    MoveWindow(g.hwnd_lbl_pack_md_max, md_x + md_chk_w + s(4), p_row2 + s(4), md_lbl_w, s(20), 1);
    MoveWindow(g.hwnd_edit_pack_md_max, md_x + md_chk_w + md_lbl_w + s(6), p_row2, md_edit_w, s(23), 1);
    MoveWindow(g.hwnd_lbl_pack_md_unit, md_x + md_chk_w + md_lbl_w + md_edit_w + s(10), p_row2 + s(4), md_unit_w, s(20), 1);

    let p_row3 = p_row2 + s(30);
    MoveWindow(g.hwnd_lbl_pack_filter, inner_x, p_row3 + s(4), s(38), s(20), 1);
    let zip_btn_w = s(138);
    let clr_w = s(72);
    let ref_w = s(56);
    let flt_w = (inner_w - s(40) - clr_w - ref_w - zip_btn_w - s(24)).max(s(140));
    MoveWindow(g.hwnd_edit_pack_filter, inner_x + s(40), p_row3, flt_w, s(23), 1);
    MoveWindow(g.hwnd_btn_pack_clear, inner_x + s(40) + flt_w + s(6), p_row3 - s(1), clr_w, s(24), 1);
    MoveWindow(g.hwnd_btn_pack_refresh, inner_x + s(40) + flt_w + clr_w + s(12), p_row3 - s(1), ref_w, s(24), 1);
    MoveWindow(g.hwnd_btn_pack_zip, inner_x + inner_w - zip_btn_w, p_row3 - s(1), zip_btn_w, s(24), 1);

    let tv1_top = p_row3 + s(29);
    let tv1_h = (inner_h - s(89) - s(22)).max(s(90));
    MoveWindow(g.hwnd_tv_pack, inner_x, tv1_top, inner_w, tv1_h, 1);
    MoveWindow(g.hwnd_lbl_pack_status, inner_x, tv1_top + tv1_h + s(4), inner_w, s(19), 1);

    // --- Tab 2 (Apply) Layout ---
    MoveWindow(g.hwnd_btn_apply_browse, inner_x, inner_y, s(118), s(25), 1);
    MoveWindow(g.hwnd_chk_apply_bak, inner_x + s(124), inner_y + s(3), s(92), s(20), 1);
    MoveWindow(g.hwnd_chk_apply_enc, inner_x + s(220), inner_y + s(3), s(126), s(20), 1);
    MoveWindow(g.hwnd_chk_apply_build, inner_x + s(350), inner_y + s(3), s(202), s(20), 1);
    MoveWindow(g.hwnd_btn_apply_exec, inner_x + inner_w - s(126), inner_y, s(126), s(25), 1);

    let a_row2 = inner_y + s(30);
    let rb_btn_w = s(86);
    let rb_ref_w = s(78);
    let cmb_w = (inner_w - s(68) - rb_btn_w - rb_ref_w - s(20))
        .max(s(180))
        .min(s(420));
    MoveWindow(g.hwnd_lbl_rollback, inner_x, a_row2 + s(4), s(64), s(20), 1);
    MoveWindow(g.hwnd_cmb_rollback, inner_x + s(68), a_row2, cmb_w, s(180), 1);
    MoveWindow(g.hwnd_btn_rollback, inner_x + s(68) + cmb_w + s(6), a_row2 - s(1), rb_btn_w, s(24), 1);
    MoveWindow(g.hwnd_btn_bak_refresh, inner_x + s(68) + cmb_w + rb_btn_w + s(12), a_row2 - s(1), rb_ref_w, s(24), 1);

    let a_hdr_y = a_row2 + s(29);
    let tv2_top = a_hdr_y + s(23);
    let tv2_h = (inner_h - s(83) - s(22)).max(s(90));
    let a_gap = s(8);
    let avail_w = (inner_w - a_gap * 2).max(s(300));
    let col1_w = (avail_w * 32) / 100;
    let col2_w = (avail_w * 36) / 100;
    let col3_w = avail_w - col1_w - col2_w;
    let col1_x = inner_x;
    let col2_x = col1_x + col1_w + a_gap;
    let col3_x = col2_x + col2_w + a_gap;
    let mini_btn_w = s(44);
    let mini_gap = s(4);

    // Col 1: Downloads 目录树
    let dl_lbl_w = (col1_w - mini_btn_w * 2 - mini_gap * 2).max(s(60));
    MoveWindow(g.hwnd_lbl_dl_tree, col1_x, a_hdr_y + s(3), dl_lbl_w, s(18), 1);
    MoveWindow(g.hwnd_btn_dl_open, col1_x + col1_w - mini_btn_w * 2 - mini_gap, a_hdr_y, mini_btn_w, s(21), 1);
    MoveWindow(g.hwnd_btn_dl_del, col1_x + col1_w - mini_btn_w, a_hdr_y, mini_btn_w, s(21), 1);
    MoveWindow(g.hwnd_tv_downloads, col1_x, tv2_top, col1_w, tv2_h, 1);
    MoveWindow(g.hwnd_lbl_dl_status, col1_x, tv2_top + tv2_h + s(4), col1_w, s(19), 1);

    // Col 2: 补丁预览树
    MoveWindow(g.hwnd_lbl_apply_tree, col2_x, a_hdr_y + s(3), col2_w, s(18), 1);
    MoveWindow(g.hwnd_tv_apply, col2_x, tv2_top, col2_w, tv2_h, 1);
    MoveWindow(g.hwnd_lbl_apply_status, col2_x, tv2_top + tv2_h + s(4), col2_w, s(19), 1);

    // Col 3: backup 目录树
    let bak_lbl_w = (col3_w - mini_btn_w * 2 - mini_gap * 2).max(s(60));
    MoveWindow(g.hwnd_lbl_backup_tree, col3_x, a_hdr_y + s(3), bak_lbl_w, s(18), 1);
    MoveWindow(g.hwnd_btn_backup_open, col3_x + col3_w - mini_btn_w * 2 - mini_gap, a_hdr_y, mini_btn_w, s(21), 1);
    MoveWindow(g.hwnd_btn_backup_del, col3_x + col3_w - mini_btn_w, a_hdr_y, mini_btn_w, s(21), 1);
    MoveWindow(g.hwnd_tv_backup, col3_x, tv2_top, col3_w, tv2_h, 1);
    MoveWindow(g.hwnd_lbl_backup_status, col3_x, tv2_top + tv2_h + s(4), col3_w, s(19), 1);

    // --- Tab 3 (Synonyms & OOV) Layout ---
    MoveWindow(g.hwnd_btn_syn_save, inner_x, inner_y, s(134), s(25), 1);
    MoveWindow(g.hwnd_btn_syn_rebuild, inner_x + s(140), inner_y, s(162), s(25), 1);
    MoveWindow(g.hwnd_btn_syn_import, inner_x + s(308), inner_y, s(114), s(25), 1);
    MoveWindow(g.hwnd_btn_oov_refresh, inner_x + inner_w - s(116), inner_y, s(116), s(25), 1);

    let syn_lbl_y = inner_y + s(31);
    let syn_edit_y = syn_lbl_y + s(20);
    let syn_edit_h = (inner_h - s(53)).max(s(120));
    let half_gap = s(10);
    let left_w = (inner_w - half_gap) / 2;
    let right_x = inner_x + left_w + half_gap;
    let right_w = inner_w - left_w - half_gap;

    MoveWindow(g.hwnd_lbl_syn_custom, inner_x, syn_lbl_y, left_w, s(19), 1);
    MoveWindow(g.hwnd_edit_syn_custom, inner_x, syn_edit_y, left_w, syn_edit_h, 1);
    MoveWindow(g.hwnd_lbl_oov_report, right_x, syn_lbl_y, right_w, s(19), 1);
    MoveWindow(g.hwnd_edit_oov_report, right_x, syn_edit_y, right_w, syn_edit_h, 1);

    // 缩放后原子触发全窗口及子控件重绘，确保 Tab 背景不会覆盖内容区
    RedrawWindow(
        hwnd,
        std::ptr::null(),
        std::ptr::null_mut(),
        RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN,
    );
}

unsafe fn update_log_header_and_button(g: &mut GuiData) {
    let kb = g.state.logs.size_bytes() / 1024;
    if g.log_size_kb != Some(kb) {
        g.log_size_kb = Some(kb);
        let label = format!(
            "实时运行日志 [{} KB]:",
            kb
        );
        set_window_text(g.hwnd_lbl_log, &label);
    }
    let should_red = kb > LOG_RED_THRESHOLD_KB;
    if g.log_btn_red != should_red {
        g.log_btn_red = should_red;
        let style = if should_red {
            BS_OWNERDRAW
        } else {
            BS_PUSHBUTTON
        };
        SendMessageW(g.hwnd_btn_clear_log, BM_SETSTYLE, style as WPARAM, 1);
        RedrawWindow(
            g.hwnd_btn_clear_log,
            std::ptr::null(),
            std::ptr::null_mut(),
            RDW_INVALIDATE | RDW_ERASE,
        );
    }
}

unsafe fn draw_red_clear_log_button(g: &GuiData, dis: &DrawItemStruct) {
    let hdc = dis.hdc;
    let rc = dis.rc_item;
    let pressed = (dis.item_state & ODS_SELECTED) != 0;
    let focused = (dis.item_state & ODS_FOCUS) != 0;

    let bg = if pressed {
        g.btn_red_pressed_brush
    } else {
        g.btn_red_brush
    };
    FillRect(hdc, &rc, bg);
    FrameRect(hdc, &rc, g.btn_red_border_brush);

    if focused {
        let focus_rc = RECT {
            left: rc.left + 2,
            top: rc.top + 2,
            right: rc.right - 2,
            bottom: rc.bottom - 2,
        };
        FrameRect(hdc, &focus_rc, g.edit_ro_brush);
    }

    let old_font = SelectObject(hdc, g.font_ui as _);
    SetBkMode(hdc, GDI_TRANSPARENT);
    SetTextColor(hdc, BTN_RED_TEXT_RGB);

    let label_w = to_wide("清空日志");
    let text_len = (label_w.len().saturating_sub(1)) as i32;
    let mut sz: SIZE = std::mem::zeroed();
    GetTextExtentPoint32W(hdc, label_w.as_ptr(), text_len, &mut sz);
    let shift = if pressed { 1 } else { 0 };
    let tx = rc.left + ((rc.right - rc.left) - sz.cx) / 2 + shift;
    let ty = rc.top + ((rc.bottom - rc.top) - sz.cy) / 2 + shift;
    TextOutW(hdc, tx, ty, label_w.as_ptr(), text_len);

    SelectObject(hdc, old_font);
}

unsafe fn drain_logs_to_edit(g: &mut GuiData) {
    let (new_max_id, chunk) = g.state.logs.since_newest_first(g.last_log_id);
    if !chunk.is_empty() {
        let is_initial = g.last_log_id == 0;
        g.last_log_id = g.last_log_id.max(new_max_id);

        let cur_len = GetWindowTextLengthW(g.hwnd_edit_log);
        if is_initial || cur_len == 0 {
            set_window_text(g.hwnd_edit_log, &chunk);
        } else if cur_len > 160_000 {
            // 超长时直接按内存环形缓冲重绘（新来居上），防界面卡顿
            let (all_id, full_text) = g.state.logs.all_newest_first();
            g.last_log_id = g.last_log_id.max(all_id);
            set_window_text(g.hwnd_edit_log, &full_text);
        } else {
            // 新来居上：插到第 0 偏移处
            let w = to_wide(&chunk);
            SendMessageW(g.hwnd_edit_log, EM_SETSEL, 0, 0);
            SendMessageW(g.hwnd_edit_log, EM_REPLACESEL, 0, w.as_ptr() as LPARAM);
        }
        SendMessageW(g.hwnd_edit_log, EM_SETSEL, 0, 0);
        SendMessageW(g.hwnd_edit_log, EM_SCROLLCARET, 0, 0);
    }
    update_log_header_and_button(g);
}

unsafe fn update_vpn_indicator(g: &mut GuiData, hwnd: HWND, online: bool) {
    if g.last_vpn_online == Some(online) {
        return;
    }
    g.last_vpn_online = Some(online);
    let (big, small, label) = if online {
        (g.icon_green_big, g.icon_green_small, "Online")
    } else {
        (g.icon_red_big, g.icon_red_small, "Offline")
    };
    SendMessageW(hwnd, WM_SETICON, ICON_BIG as WPARAM, big as LPARAM);
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL as WPARAM, small as LPARAM);
    let title = format!(
        "Swamp 管理控制台 [VPN: {}] - http://localhost:{}",
        label, g.state.config.port
    );
    set_window_text(hwnd, &title);
}

// =========================================================================
// TreeView Tri-State Helper
// =========================================================================
unsafe fn tv_set_state_img(tv: HWND, hitem: isize, img_idx: usize) {
    let mut tvi: TVITEMW = std::mem::zeroed();
    tvi.mask = TVIF_STATE;
    tvi.hItem = hitem;
    tvi.stateMask = TVIS_STATEIMAGEMASK;
    tvi.state = (img_idx as u32) << 12;
    SendMessageW(tv, TVM_SETITEMW, 0, &tvi as *const _ as LPARAM);
}

unsafe fn tv_get_state_img(tv: HWND, hitem: isize) -> usize {
    let mut tvi: TVITEMW = std::mem::zeroed();
    tvi.mask = TVIF_STATE;
    tvi.hItem = hitem;
    tvi.stateMask = TVIS_STATEIMAGEMASK;
    SendMessageW(tv, TVM_GETITEMW, 0, &mut tvi as *mut _ as LPARAM);
    ((tvi.state & TVIS_STATEIMAGEMASK) >> 12) as usize
}

unsafe fn tv_insert_item(
    tv: HWND,
    parent: isize,
    text: &str,
    state_img: usize,
    expand: bool,
) -> isize {
    let mut w = to_wide(text);
    let mut tvis: TVINSERTSTRUCTW = std::mem::zeroed();
    tvis.hParent = parent;
    tvis.hInsertAfter = TVI_LAST;
    tvis.Anonymous.item.mask = TVIF_TEXT | TVIF_STATE | TVIF_PARAM;
    tvis.Anonymous.item.pszText = w.as_mut_ptr();
    tvis.Anonymous.item.stateMask = TVIS_STATEIMAGEMASK;
    tvis.Anonymous.item.state = (state_img as u32) << 12;
    let h = SendMessageW(tv, TVM_INSERTITEMW, 0, &tvis as *const _ as LPARAM);
    if expand && h != 0 {
        SendMessageW(tv, TVM_EXPAND, TVE_EXPAND as WPARAM, h);
    }
    h
}

unsafe fn sync_subtree_down(
    tv: HWND,
    hitem: isize,
    target_img: usize,
    nodes: &HashMap<isize, TreeNodeData>,
    checked_set: &mut HashSet<String>,
) {
    if let Some(info) = nodes.get(&hitem) {
        if info.blocked {
            return;
        }
        if info.is_file {
            tv_set_state_img(tv, hitem, target_img);
            if target_img == 2 {
                checked_set.insert(info.rel.clone());
            } else {
                checked_set.remove(&info.rel);
            }
            return;
        }
    }

    let mut child = SendMessageW(tv, TVM_GETNEXTITEM, TVGN_CHILD as WPARAM, hitem);
    while child != 0 {
        sync_subtree_down(tv, child, target_img, nodes, checked_set);
        child = SendMessageW(tv, TVM_GETNEXTITEM, TVGN_NEXT as WPARAM, child);
    }
    let agg = compute_folder_state(tv, hitem, nodes);
    tv_set_state_img(tv, hitem, agg);
}

unsafe fn compute_folder_state(
    tv: HWND,
    dir_item: isize,
    nodes: &HashMap<isize, TreeNodeData>,
) -> usize {
    let mut has_checked = false;
    let mut has_unchecked = false;
    let mut has_partial = false;

    let mut child = SendMessageW(tv, TVM_GETNEXTITEM, TVGN_CHILD as WPARAM, dir_item);
    while child != 0 {
        let blocked = nodes.get(&child).map(|n| n.blocked).unwrap_or(false);
        if !blocked {
            match tv_get_state_img(tv, child) {
                2 => has_checked = true,
                3 => has_partial = true,
                _ => has_unchecked = true,
            }
        }
        child = SendMessageW(tv, TVM_GETNEXTITEM, TVGN_NEXT as WPARAM, child);
    }

    if has_partial || (has_checked && has_unchecked) {
        3
    } else if has_checked {
        2
    } else {
        1
    }
}

unsafe fn sync_ancestors_up(
    tv: HWND,
    mut item: isize,
    nodes: &HashMap<isize, TreeNodeData>,
) {
    // TVGN_PARENT = 3
    loop {
        let parent = SendMessageW(tv, TVM_GETNEXTITEM, 3, item);
        if parent == 0 {
            break;
        }
        let agg = compute_folder_state(tv, parent, nodes);
        tv_set_state_img(tv, parent, agg);
        item = parent;
    }
}

unsafe fn sync_all_folders_bottom_up(
    tv: HWND,
    parent: isize,
    nodes: &HashMap<isize, TreeNodeData>,
) -> usize {
    let mut child = SendMessageW(tv, TVM_GETNEXTITEM, TVGN_CHILD as WPARAM, parent);
    while child != 0 {
        let is_dir = nodes.get(&child).map(|n| !n.is_file).unwrap_or(false);
        if is_dir {
            let st = sync_all_folders_bottom_up(tv, child, nodes);
            tv_set_state_img(tv, child, st);
        }
        child = SendMessageW(tv, TVM_GETNEXTITEM, TVGN_NEXT as WPARAM, child);
    }
    if parent != TVI_ROOT {
        compute_folder_state(tv, parent, nodes)
    } else {
        1
    }
}

unsafe fn rebuild_pack_tree(g: &mut GuiData) {
    SendMessageW(g.hwnd_tv_pack, TVM_DELETEITEM, 0, TVI_ROOT);
    g.pack_nodes.clear();

    let kw = get_window_text_string(g.hwnd_edit_pack_filter)
        .trim()
        .to_ascii_lowercase();
    let expand_all = !kw.is_empty();

    let mut dir_handles: BTreeMap<String, isize> = BTreeMap::new();
    for item in &g.pack_all_files {
        if !kw.is_empty() && !item.rel.to_ascii_lowercase().contains(&kw) {
            continue;
        }
        let parts: Vec<&str> = item.rel.split('/').collect();
        let mut parent_h = TVI_ROOT;
        let mut acc = String::new();

        for (depth, &seg) in parts[..parts.len() - 1].iter().enumerate() {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if let Some(&existing) = dir_handles.get(&acc) {
                parent_h = existing;
            } else {
                let h = tv_insert_item(
                    g.hwnd_tv_pack,
                    parent_h,
                    seg,
                    1,
                    expand_all || depth == 0,
                );
                dir_handles.insert(acc.clone(), h);
                g.pack_nodes.insert(
                    h,
                    TreeNodeData {
                        rel: acc.clone(),
                        is_file: false,
                        blocked: false,
                    },
                );
                parent_h = h;
            }
        }

        let fname = parts.last().copied().unwrap_or("");
        let label = format!("{}  ({})", fname, format_bytes(item.size));
        let checked = g.pack_checked.contains(&item.rel);
        let h = tv_insert_item(
            g.hwnd_tv_pack,
            parent_h,
            &label,
            if checked { 2 } else { 1 },
            false,
        );
        g.pack_nodes.insert(
            h,
            TreeNodeData {
                rel: item.rel.clone(),
                is_file: true,
                blocked: false,
            },
        );
    }

    sync_all_folders_bottom_up(g.hwnd_tv_pack, TVI_ROOT, &g.pack_nodes);
    update_pack_status_label(g);
}

unsafe fn update_pack_status_label(g: &GuiData) {
    let mut cnt = 0usize;
    let mut total = 0u64;
    for f in &g.pack_all_files {
        if g.pack_checked.contains(&f.rel) {
            cnt += 1;
            total += f.size;
        }
    }
    let msg = format!(
        "已选 {} 个文件 ({})  |  候选总数 {} 个",
        cnt,
        format_bytes(total),
        g.pack_all_files.len()
    );
    set_window_text(g.hwnd_lbl_pack_status, &msg);
}

unsafe fn rebuild_apply_tree(g: &mut GuiData) {
    SendMessageW(g.hwnd_tv_apply, TVM_DELETEITEM, 0, TVI_ROOT);
    g.apply_nodes.clear();

    let mut dir_handles: BTreeMap<String, isize> = BTreeMap::new();
    for entry in &g.apply_entries {
        let parts: Vec<&str> = entry.rel.split('/').collect();
        let mut parent_h = TVI_ROOT;
        let mut acc = String::new();

        for &seg in &parts[..parts.len() - 1] {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if let Some(&existing) = dir_handles.get(&acc) {
                parent_h = existing;
            } else {
                let h = tv_insert_item(g.hwnd_tv_apply, parent_h, seg, 1, true);
                dir_handles.insert(acc.clone(), h);
                g.apply_nodes.insert(
                    h,
                    TreeNodeData {
                        rel: acc.clone(),
                        is_file: false,
                        blocked: false,
                    },
                );
                parent_h = h;
            }
        }

        let fname = parts.last().copied().unwrap_or("");
        let tag = match entry.status.as_str() {
            "overwrite" => "[覆盖] ",
            "new" => "[新增] ",
            "exec_risk" => "[高危/构建] ",
            "skip_doc" => "[说明-跳过] ",
            "secret" => "[敏感] ",
            "blocked" => "[禁止] ",
            _ => "",
        };
        let label = format!("{}{}  ({})", tag, fname, format_bytes(entry.size));
        let state_img = if entry.blocked {
            0
        } else if g.apply_checked.contains(&entry.rel) {
            2
        } else {
            1
        };
        let h = tv_insert_item(g.hwnd_tv_apply, parent_h, &label, state_img, false);
        g.apply_nodes.insert(
            h,
            TreeNodeData {
                rel: entry.rel.clone(),
                is_file: true,
                blocked: entry.blocked,
            },
        );
    }

    sync_all_folders_bottom_up(g.hwnd_tv_apply, TVI_ROOT, &g.apply_nodes);
    update_apply_status_label(g);
}

unsafe fn update_apply_status_label(g: &GuiData) {
    if g.apply_entries.is_empty() {
        set_window_text(
            g.hwnd_lbl_apply_status,
            "点击「选择补丁 ZIP...」或直接将 .zip 文件拖放到窗口任意位置",
        );
        EnableWindow(g.hwnd_btn_apply_exec, 0);
        return;
    }
    let mut ov = 0usize;
    let mut nw = 0usize;
    let mut danger = 0usize;
    for e in &g.apply_entries {
        if e.blocked || !g.apply_checked.contains(&e.rel) {
            continue;
        }
        if e.is_dangerous {
            danger += 1;
        }
        if e.exists {
            ov += 1;
        } else {
            nw += 1;
        }
    }
    let sel = ov + nw;
    let msg = format!(
        "[{}] 共 {} 项 | 已选 {} 项（覆盖 {}，新增 {}{}）",
        g.apply_zip_name,
        g.apply_entries.len(),
        sel,
        ov,
        nw,
        if danger > 0 {
            format!("，含高危构建 {}", danger)
        } else {
            String::new()
        }
    );
    set_window_text(g.hwnd_lbl_apply_status, &msg);
    EnableWindow(g.hwnd_btn_apply_exec, if sel > 0 { 1 } else { 0 });
}

unsafe fn rebuild_backup_tree(g: &mut GuiData) {
    SendMessageW(g.hwnd_tv_backup, TVM_DELETEITEM, 0, TVI_ROOT);
    g.backup_nodes.clear();

    let valid_rels: HashSet<&str> = g.backup_items.iter().map(|it| it.rel.as_str()).collect();
    g.backup_checked.retain(|r| valid_rels.contains(r.as_str()));

    let mut dir_sizes: HashMap<String, u64> = HashMap::new();
    for item in &g.backup_items {
        if item.is_dir {
            continue;
        }
        let parts: Vec<&str> = item.rel.split('/').collect();
        let mut acc = String::new();
        for &seg in &parts[..parts.len().saturating_sub(1)] {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            *dir_sizes.entry(acc.clone()).or_insert(0) += item.size;
        }
    }

    let mut dir_handles: BTreeMap<String, isize> = BTreeMap::new();
    for item in &g.backup_items {
        let parts: Vec<&str> = item.rel.split('/').collect();
        let mut parent_h = TVI_ROOT;
        let mut acc = String::new();

        for &seg in &parts[..parts.len().saturating_sub(1)] {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if let Some(&existing) = dir_handles.get(&acc) {
                parent_h = existing;
            } else {
                let dsz = dir_sizes.get(&acc).copied().unwrap_or(0);
                let dlabel = format!("{}  ({})", seg, format_bytes(dsz));
                let h = tv_insert_item(g.hwnd_tv_backup, parent_h, &dlabel, 1, false);
                dir_handles.insert(acc.clone(), h);
                g.backup_nodes.insert(
                    h,
                    TreeNodeData {
                        rel: acc.clone(),
                        is_file: false,
                        blocked: false,
                    },
                );
                parent_h = h;
            }
        }

        let fname = parts.last().copied().unwrap_or("");
        let label = if item.is_dir {
            format!("[空目录] {}", fname)
        } else {
            let tag = match item.rel.as_str() {
                "build_hashes.txt" => "[账本] ",
                "synonyms.sha256" => "[同义词哈希] ",
                "oov_report.txt" => "[新词报告] ",
                "swamp_panic.log" => "[崩溃日志] ",
                _ => "",
            };
            format!("{}{}  ({})", tag, fname, format_bytes(item.size))
        };
        let checked = g.backup_checked.contains(&item.rel);
        let h = tv_insert_item(
            g.hwnd_tv_backup,
            parent_h,
            &label,
            if checked { 2 } else { 1 },
            false,
        );
        g.backup_nodes.insert(
            h,
            TreeNodeData {
                rel: item.rel.clone(),
                is_file: true,
                blocked: false,
            },
        );
    }

    sync_all_folders_bottom_up(g.hwnd_tv_backup, TVI_ROOT, &g.backup_nodes);
    update_backup_status_label(g);
}

unsafe fn update_backup_status_label(g: &GuiData) {
    if g.backup_items.is_empty() {
        set_window_text(g.hwnd_lbl_backup_status, "backup 目录为空");
        EnableWindow(g.hwnd_btn_backup_del, 0);
        return;
    }
    let mut sel_cnt = 0usize;
    let mut sel_bytes = 0u64;
    let mut total_bytes = 0u64;
    for item in &g.backup_items {
        total_bytes = total_bytes.saturating_add(item.size);
        if g.backup_checked.contains(&item.rel) {
            sel_cnt += 1;
            sel_bytes = sel_bytes.saturating_add(item.size);
        }
    }
    let msg = format!(
        "已选 {} 项 ({}) | 共 {} 项 ({})",
        sel_cnt,
        format_bytes(sel_bytes),
        g.backup_items.len(),
        format_bytes(total_bytes)
    );
    set_window_text(g.hwnd_lbl_backup_status, &msg);
    EnableWindow(g.hwnd_btn_backup_del, if sel_cnt > 0 { 1 } else { 0 });
}

unsafe fn rebuild_downloads_tree(g: &mut GuiData) {
    SendMessageW(g.hwnd_tv_downloads, TVM_DELETEITEM, 0, TVI_ROOT);
    g.downloads_nodes.clear();

    let valid_rels: HashSet<&str> = g.downloads_items.iter().map(|it| it.rel.as_str()).collect();
    g.downloads_checked
        .retain(|r| valid_rels.contains(r.as_str()));

    for item in &g.downloads_items {
        let label = if item.is_dir {
            format!("[目录] {}  ({} 项)", item.rel, item.child_count)
        } else if item.is_zip {
            format!("[ZIP] {}  ({})", item.rel, format_bytes(item.size))
        } else {
            format!("{}  ({})", item.rel, format_bytes(item.size))
        };
        let checked = g.downloads_checked.contains(&item.rel);
        let h = tv_insert_item(
            g.hwnd_tv_downloads,
            TVI_ROOT,
            &label,
            if checked { 2 } else { 1 },
            false,
        );
        g.downloads_nodes.insert(
            h,
            TreeNodeData {
                rel: item.rel.clone(),
                is_file: true,
                blocked: false,
            },
        );
    }

    update_downloads_status_label(g);
}

unsafe fn update_downloads_status_label(g: &GuiData) {
    if g.downloads_dir.is_none() {
        set_window_text(g.hwnd_lbl_dl_status, "未找到 Downloads 目录");
        EnableWindow(g.hwnd_btn_dl_del, 0);
        return;
    }
    if g.downloads_items.is_empty() {
        set_window_text(g.hwnd_lbl_dl_status, "Downloads 目录为空");
        EnableWindow(g.hwnd_btn_dl_del, 0);
        return;
    }
    let mut sel_cnt = 0usize;
    let mut sel_bytes = 0u64;
    let mut zip_cnt = 0usize;
    for item in &g.downloads_items {
        if item.is_zip {
            zip_cnt += 1;
        }
        if g.downloads_checked.contains(&item.rel) {
            sel_cnt += 1;
            sel_bytes = sel_bytes.saturating_add(item.size);
        }
    }
    let msg = format!(
        "已选 {} 项 ({}) | 共 {} 项 ({} ZIP)",
        sel_cnt,
        format_bytes(sel_bytes),
        g.downloads_items.len(),
        zip_cnt
    );
    set_window_text(g.hwnd_lbl_dl_status, &msg);
    EnableWindow(g.hwnd_btn_dl_del, if sel_cnt > 0 { 1 } else { 0 });
}

fn spawn_load_downloads_tree(mailbox: Arc<GuiMailbox>) {
    std::thread::spawn(move || {
        let res = pack_apply::list_downloads_items();
        if let Ok(mut slot) = mailbox.downloads_tree.lock() {
            *slot = Some(res);
        }
        mailbox.post(WM_APP_DOWNLOADS_TREE, 0, 0);
    });
}

fn spawn_load_backup_tree(cfg: ServerConfig, mailbox: Arc<GuiMailbox>) {
    std::thread::spawn(move || {
        let items = pack_apply::list_backup_tree_items(&cfg);
        if let Ok(mut slot) = mailbox.backup_tree.lock() {
            *slot = Some(items);
        }
        mailbox.post(WM_APP_BACKUP_TREE, 0, 0);
    });
}

fn spawn_load_pack_tree(
    cfg: ServerConfig,
    logs: Arc<LogBus>,
    mailbox: Arc<GuiMailbox>,
    more: bool,
) {
    std::thread::spawn(move || {
        match pack_apply::list_pack_files(&cfg, more) {
            Ok(files) => {
                let presets = pack_apply::load_presets_json(&cfg);
                if let Ok(mut slot) = mailbox.pack_result.lock() {
                    *slot = Some((files, presets));
                }
                mailbox.post(WM_APP_PACK_TREE, 0, 0);
            }
            Err(e) => logs.error(format!("[pack] 扫描目录树失败: {}", e)),
        }
    });
}

fn spawn_load_zip_file(
    cfg: ServerConfig,
    logs: Arc<LogBus>,
    mailbox: Arc<GuiMailbox>,
    zip_path: PathBuf,
) {
    std::thread::spawn(move || {
        let bytes = match std::fs::read(&zip_path) {
            Ok(b) => b,
            Err(e) => {
                logs.error(format!("[apply] 读取 ZIP 失败: {}", e));
                return;
            }
        };
        let fname = zip_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("patch.zip")
            .to_string();
        match pack_apply::inspect_apply_zip(&cfg, &bytes) {
            Ok(entries) => {
                logs.info(format!("[apply] 已加载补丁包 {} ({} 个条目)", fname, entries.len()));
                if let Ok(mut slot) = mailbox.apply_result.lock() {
                    *slot = Some((fname, bytes, entries));
                }
                mailbox.post(WM_APP_APPLY_TREE, 0, 0);
            }
            Err(e) => logs.error(format!("[apply] 解析 ZIP 失败: {}", e)),
        }
    });
}

fn spawn_load_backups(cfg: ServerConfig, mailbox: Arc<GuiMailbox>) {
    std::thread::spawn(move || {
        let list = pack_apply::list_apply_backups(&cfg);
        if let Ok(mut slot) = mailbox.backups.lock() {
            *slot = Some(list);
        }
        mailbox.post(WM_APP_BACKUPS, 0, 0);
    });
}

fn spawn_load_synonyms_data(cfg: ServerConfig, mailbox: Arc<GuiMailbox>, include_custom: bool) {
    std::thread::spawn(move || {
        let custom_opt = if include_custom {
            Some(crate::config::read_synonyms_custom_json(&cfg))
        } else {
            None
        };
        let oov = crate::builder::synonyms::read_oov_report(&cfg);
        if let Ok(mut slot) = mailbox.syn_data.lock() {
            *slot = Some((custom_opt, oov));
        }
        mailbox.post(WM_APP_SYN_DATA, 0, 0);
    });
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_CREATE {
        let cs = &*(lparam as *const CREATESTRUCTW);
        let g = &mut *(cs.lpCreateParams as *mut GuiData);
        g.hwnd_main = hwnd;
        g.mailbox.set_hwnd(hwnd);
        let real_dpi = query_dpi(hwnd);
        if real_dpi != g.dpi {
            g.dpi = real_dpi;
            let (new_ui, new_mono) = create_scaled_fonts(real_dpi);
            if !g.font_ui.is_null() {
                windows_sys::Win32::Graphics::Gdi::DeleteObject(g.font_ui);
            }
            if !g.font_mono.is_null() {
                windows_sys::Win32::Graphics::Gdi::DeleteObject(g.font_mono);
            }
            g.font_ui = new_ui;
            g.font_mono = new_mono;
        }
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
        DragAcceptFiles(hwnd, 1);
        build_all_controls(g, hwnd);
        layout_controls(g, hwnd);
        update_log_header_and_button(g);
        spawn_load_pack_tree(
            g.state.config.clone(),
            g.state.logs.clone(),
            g.mailbox.clone(),
            false,
        );
        spawn_load_backups(g.state.config.clone(), g.mailbox.clone());
        spawn_load_backup_tree(g.state.config.clone(), g.mailbox.clone());
        spawn_load_downloads_tree(g.mailbox.clone());
        spawn_load_synonyms_data(g.state.config.clone(), g.mailbox.clone(), true);
        return 0;
    }

    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut GuiData;
    if ptr.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let g = &mut *ptr;

    match msg {
        WM_GETMINMAXINFO => {
            let mmi = &mut *(lparam as *mut MINMAXINFO);
            mmi.ptMinTrackSize.x = sc(860, g.dpi);
            mmi.ptMinTrackSize.y = sc(580, g.dpi);
            0
        }
        WM_DPICHANGED => {
            let new_dpi = (wparam & 0xFFFF) as u32;
            if new_dpi >= 72 && new_dpi != g.dpi {
                g.dpi = new_dpi;
                let (new_ui, new_mono) = create_scaled_fonts(new_dpi);
                let old_ui = g.font_ui;
                let old_mono = g.font_mono;
                g.font_ui = new_ui;
                g.font_mono = new_mono;
                apply_fonts_to_all_controls(g);
                if !old_ui.is_null() {
                    windows_sys::Win32::Graphics::Gdi::DeleteObject(old_ui);
                }
                if !old_mono.is_null() {
                    windows_sys::Win32::Graphics::Gdi::DeleteObject(old_mono);
                }
            }
            if lparam != 0 {
                let suggested = &*(lparam as *const RECT);
                MoveWindow(
                    hwnd,
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    1,
                );
            }
            layout_controls(g, hwnd);
            0
        }
        WM_SIZE => {
            // 忽略 SIZE_MINIMIZED (1)，避免最小化时按 0x0 客户区重排
            if wparam != 1 {
                layout_controls(g, hwnd);
            }
            0
        }
        WM_DRAWITEM => {
            if lparam != 0 {
                let dis = &*(lparam as *const DrawItemStruct);
                if dis.ctl_id == IDC_BTN_CLEAR_LOG as u32 && g.log_btn_red {
                    draw_red_clear_log_button(g, dis);
                    return 1;
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_CTLCOLORSTATIC => {
            let ctrl = lparam as HWND;
            if ctrl == g.hwnd_edit_oov_report || ctrl == g.hwnd_edit_log {
                // 只读 EDIT 控件必须使用 OPAQUE 背景，否则滚动时旧文字不被擦除会导致文字重叠
                SetBkMode(wparam as _, GDI_OPAQUE);
                SetBkColor(wparam as _, RO_EDIT_BG_RGB);
                g.edit_ro_brush as LRESULT
            } else {
                // 普通静态标签交由系统默认 OPAQUE 灰色绘制，更新文本无残影
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
        }
        WM_APP_LOG => {
            drain_logs_to_edit(g);
            0
        }
        WM_APP_VPN => {
            update_vpn_indicator(g, hwnd, wparam != 0);
            0
        }
        WM_APP_PACK_TREE => {
            let taken = g.mailbox.pack_result.lock().ok().and_then(|mut s| s.take());
            if let Some((files, presets_val)) = taken {
                g.pack_all_files = files;
                if let Some(sr) = presets_val.get("skipApplyDocRegex").and_then(|v| v.as_str()) {
                    g.pack_skip_regex = sr.to_string();
                }
                g.pack_presets = presets_val
                    .get("presets")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let prev_sel = SendMessageW(g.hwnd_cmb_pack_preset, CB_GETCURSEL, 0, 0) as i32;
                SendMessageW(g.hwnd_cmb_pack_preset, CB_RESETCONTENT, 0, 0);
                for pr in &g.pack_presets {
                    let name = pr.get("name").and_then(|v| v.as_str()).unwrap_or("预设");
                    let w = to_wide(name);
                    SendMessageW(g.hwnd_cmb_pack_preset, CB_ADDSTRING, 0, w.as_ptr() as LPARAM);
                }
                if !g.pack_presets.is_empty() {
                    let idx = if prev_sel >= 0 && (prev_sel as usize) < g.pack_presets.len() {
                        prev_sel as usize
                    } else {
                        0
                    };
                    SendMessageW(g.hwnd_cmb_pack_preset, CB_SETCURSEL, idx, 0);
                    if let Some(nm) = g.pack_presets[idx].get("name").and_then(|v| v.as_str()) {
                        set_window_text(g.hwnd_edit_preset_name, nm);
                    }
                }
                rebuild_pack_tree(g);
            }
            0
        }
        WM_APP_SYN_DATA => {
            let taken = g.mailbox.syn_data.lock().ok().and_then(|mut s| s.take());
            if let Some((custom_opt, oov_text)) = taken {
                if let Some(c) = custom_opt {
                    let crlf = c.replace("\r\n", "\n").replace('\n', "\r\n");
                    set_window_text(g.hwnd_edit_syn_custom, &crlf);
                }
                let oov_crlf = oov_text.replace("\r\n", "\n").replace('\n', "\r\n");
                set_window_text(g.hwnd_edit_oov_report, &oov_crlf);
            }
            0
        }
        WM_APP_APPLY_TREE => {
            let taken = g.mailbox.apply_result.lock().ok().and_then(|mut s| s.take());
            if let Some((fname, bytes, entries)) = taken {
                g.apply_zip_name = fname;
                g.apply_zip_bytes = bytes;
                g.apply_entries = entries;
                g.apply_checked.clear();
                for e in &g.apply_entries {
                    if e.default_checked && !e.blocked {
                        g.apply_checked.insert(e.rel.clone());
                    }
                }
                rebuild_apply_tree(g);
            }
            0
        }
        WM_APP_BACKUPS => {
            let taken = g.mailbox.backups.lock().ok().and_then(|mut s| s.take());
            if let Some(list) = taken {
                g.backups = list;
                SendMessageW(g.hwnd_cmb_rollback, CB_RESETCONTENT, 0, 0);
                for b in &g.backups {
                    let lbl = format!(
                        "{}  (覆盖 {}, 新增 {})",
                        b.name, b.overwritten_count, b.created_count
                    );
                    let w = to_wide(&lbl);
                    SendMessageW(g.hwnd_cmb_rollback, CB_ADDSTRING, 0, w.as_ptr() as LPARAM);
                }
                if !g.backups.is_empty() {
                    SendMessageW(g.hwnd_cmb_rollback, CB_SETCURSEL, 0, 0);
                }
            }
            0
        }
        WM_APP_CLEAR_NEW_TITLE => {
            set_window_text(g.hwnd_edit_new_title, "");
            0
        }
        WM_APP_BACKUP_TREE => {
            let taken = g.mailbox.backup_tree.lock().ok().and_then(|mut s| s.take());
            if let Some(items) = taken {
                g.backup_items = items;
                rebuild_backup_tree(g);
            }
            0
        }
        WM_APP_DOWNLOADS_TREE => {
            let taken = g.mailbox.downloads_tree.lock().ok().and_then(|mut s| s.take());
            if let Some((dir_opt, items)) = taken {
                g.downloads_dir = dir_opt;
                g.downloads_items = items;
                rebuild_downloads_tree(g);
            }
            0
        }
        WM_APP_EXIT_AND_BUILD => {
            let handoff = g
                .mailbox
                .pending_build_handoff
                .lock()
                .ok()
                .and_then(|mut s| s.take());
            if handoff.is_some() {
                begin_safe_close(g, hwnd, handoff);
            }
            0
        }
        WM_DROPFILES => {
            let hdrop = wparam as HDROP;
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            if count > 0 {
                let len = DragQueryFileW(hdrop, 0, std::ptr::null_mut(), 0);
                let mut buf = vec![0u16; (len + 1) as usize];
                DragQueryFileW(hdrop, 0, buf.as_mut_ptr(), len + 1);
                let path_str = String::from_utf16_lossy(&buf[..len as usize]);
                let p = PathBuf::from(&path_str);
                if p.extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("zip"))
                    .unwrap_or(false)
                {
                    // 自动切换到 Tab 2 (Apply) 并加载该 ZIP
                    SendMessageW(g.hwnd_tab, TCM_SETCURSEL, 2, 0);
                    switch_tab(g, 2);
                    spawn_load_zip_file(
                        g.state.config.clone(),
                        g.state.logs.clone(),
                        g.mailbox.clone(),
                        p,
                    );
                } else {
                    g.state
                        .logs
                        .warn("[apply] 仅支持拖入 .zip 补丁压缩包");
                }
            }
            DragFinish(hdrop);
            0
        }
        WM_NOTIFY => {
            let nmhdr = &*(lparam as *const NMHDR);
            let id = nmhdr.idFrom as u16;
            if id == IDC_TAB && nmhdr.code == TCN_SELCHANGE {
                let cur = SendMessageW(g.hwnd_tab, TCM_GETCURSEL, 0, 0) as i32;
                switch_tab(g, cur);
                if cur == 2 {
                    spawn_load_downloads_tree(g.mailbox.clone());
                    spawn_load_backup_tree(g.state.config.clone(), g.mailbox.clone());
                    spawn_load_backups(g.state.config.clone(), g.mailbox.clone());
                }
                return 0;
            }
            let tree_kind = match id {
                IDC_TV_PACK => Some((TreeKind::Pack, g.hwnd_tv_pack)),
                IDC_TV_APPLY => Some((TreeKind::Apply, g.hwnd_tv_apply)),
                IDC_TV_BACKUP => Some((TreeKind::Backup, g.hwnd_tv_backup)),
                IDC_TV_DOWNLOADS => Some((TreeKind::Downloads, g.hwnd_tv_downloads)),
                _ => None,
            };
            if let Some((kind, tv)) = tree_kind {
                if nmhdr.code == NM_CLICK {
                    let mut pt: POINT = std::mem::zeroed();
                    GetCursorPos(&mut pt);
                    windows_sys::Win32::Graphics::Gdi::ScreenToClient(tv, &mut pt);
                    let mut hti: TVHITTESTINFO = std::mem::zeroed();
                    hti.pt = pt;
                    SendMessageW(tv, TVM_HITTEST, 0, &mut hti as *mut _ as LPARAM);
                    if hti.hItem != 0 && (hti.flags & TVHT_ONITEMSTATEICON) != 0 {
                        toggle_tree_item(g, kind, hti.hItem);
                    }
                    return 0;
                }
                if kind == TreeKind::Downloads && nmhdr.code == NM_DBLCLK {
                    let mut pt: POINT = std::mem::zeroed();
                    GetCursorPos(&mut pt);
                    windows_sys::Win32::Graphics::Gdi::ScreenToClient(tv, &mut pt);
                    let mut hti: TVHITTESTINFO = std::mem::zeroed();
                    hti.pt = pt;
                    SendMessageW(tv, TVM_HITTEST, 0, &mut hti as *mut _ as LPARAM);
                    if hti.hItem != 0 && (hti.flags & TVHT_ONITEMSTATEICON) == 0 {
                        if let Some(node) = g.downloads_nodes.get(&hti.hItem) {
                            if let Some(ref dl_dir) = g.downloads_dir {
                                let full = dl_dir.join(&node.rel);
                                let is_zip = full.is_file()
                                    && full
                                        .extension()
                                        .and_then(|s| s.to_str())
                                        .map(|s| s.eq_ignore_ascii_case("zip"))
                                        .unwrap_or(false);
                                if is_zip {
                                    spawn_load_zip_file(
                                        g.state.config.clone(),
                                        g.state.logs.clone(),
                                        g.mailbox.clone(),
                                        full,
                                    );
                                    return 1;
                                }
                            }
                        }
                    }
                    return 0;
                }
                if nmhdr.code == TVN_KEYDOWN {
                    let tvkd = &*(lparam as *const NMTVKEYDOWN);
                    if tvkd.wVKey == 0x20 {
                        // TVGN_CARET = 9
                        let sel = SendMessageW(tv, TVM_GETNEXTITEM, 9, 0);
                        if sel != 0 {
                            toggle_tree_item(g, kind, sel);
                        }
                    } else if kind == TreeKind::Downloads && tvkd.wVKey == 0x0D {
                        let sel = SendMessageW(tv, TVM_GETNEXTITEM, 9, 0);
                        if sel != 0 {
                            if let Some(node) = g.downloads_nodes.get(&sel) {
                                if let Some(ref dl_dir) = g.downloads_dir {
                                    let full = dl_dir.join(&node.rel);
                                    if full.is_file()
                                        && full
                                            .extension()
                                            .and_then(|s| s.to_str())
                                            .map(|s| s.eq_ignore_ascii_case("zip"))
                                            .unwrap_or(false)
                                    {
                                        spawn_load_zip_file(
                                            g.state.config.clone(),
                                            g.state.logs.clone(),
                                            g.mailbox.clone(),
                                            full,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    return 0;
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as u16;
            let code = ((wparam >> 16) & 0xFFFF) as u16;
            handle_command(g, hwnd, id, code);
            0
        }
        WM_CLOSE => {
            begin_safe_close(g, hwnd, None);
            0
        }
        WM_DESTROY => {
            g.mailbox.clear_hwnd();
            g.mailbox.kill_sim_child();
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn begin_safe_close(
    g: &mut GuiData,
    hwnd: HWND,
    handoff: Option<(PathBuf, PathBuf)>,
) -> bool {
    if g.closing {
        return false;
    }
    let has_handoff = handoff.is_some();
    let active = g.state.runtime.active_ops();
    if active > 0 {
        let prompt = if has_handoff {
            format!(
                "当前仍有 {} 个后台任务正在写入文件或构建！\n\n点击【是】将等待任务安全落盘并退出 swamp.exe 后再拉起 build.bat；\n点击【否】取消退出，暂不拉起 build.bat。",
                active
            )
        } else {
            format!(
                "当前有 {} 个后台任务正在写入文件或构建！\n\n点击【是】将等待任务安全落盘后再退出（推荐）；\n点击【否】取消关闭继续运行。",
                active
            )
        };
        let msg_w = to_wide(&prompt);
        let title_w = to_wide("Swamp 安全退出确认");
        let ans = MessageBoxW(
            hwnd,
            msg_w.as_ptr(),
            title_w.as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        );
        if ans != IDYES {
            if has_handoff {
                g.state
                    .logs
                    .warn("[apply] 已取消自动退出，未拉起 build.bat");
            }
            return false;
        }
    }

    g.closing = true;
    EnableWindow(hwnd, 0);
    set_window_text(hwnd, "Swamp 管理控制台 [正在安全收尾退出...]");
    g.state
        .logs
        .info("[shutdown] 正在等待后台写入完成并优雅关闭服务...");

    // 最多等待 15 秒让正在执行的原子写盘彻底收尾
    for _ in 0..300 {
        if g.state.runtime.active_ops() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    if has_handoff && g.state.runtime.active_ops() > 0 {
        g.closing = false;
        EnableWindow(hwnd, 1);
        let vpn_lbl = match g.last_vpn_online {
            Some(true) => "Online",
            Some(false) => "Offline",
            None => "探测中",
        };
        set_window_text(
            hwnd,
            &format!(
                "Swamp 管理控制台 [VPN: {}] - http://localhost:{}",
                vpn_lbl, g.state.config.port
            ),
        );
        g.state
            .logs
            .error("[shutdown] 等待后台任务超时，已取消自动退出与拉起 build.bat");
        let mw = to_wide("仍有后台任务尚未结束，已取消退出且未拉起 build.bat，请待任务完成后重试。");
        let tw = to_wide("未拉起 build.bat");
        MessageBoxW(hwnd, mw.as_ptr(), tw.as_ptr(), MB_OK | MB_ICONWARNING);
        return false;
    }

    g.handoff_build = handoff;
    g.mailbox.kill_sim_child();
    g.state.shutting_down.store(true, Ordering::SeqCst);
    g.shutdown_notify.notify_waiters();
    DestroyWindow(hwnd);
    true
}

unsafe fn toggle_tree_item(g: &mut GuiData, kind: TreeKind, hitem: isize) {
    let (tv, nodes, checked_set) = match kind {
        TreeKind::Pack => (g.hwnd_tv_pack, &g.pack_nodes, &mut g.pack_checked),
        TreeKind::Apply => (g.hwnd_tv_apply, &g.apply_nodes, &mut g.apply_checked),
        TreeKind::Backup => (g.hwnd_tv_backup, &g.backup_nodes, &mut g.backup_checked),
        TreeKind::Downloads => (
            g.hwnd_tv_downloads,
            &g.downloads_nodes,
            &mut g.downloads_checked,
        ),
    };
    if let Some(info) = nodes.get(&hitem) {
        if info.blocked {
            return;
        }
    }
    let cur = tv_get_state_img(tv, hitem);
    let next = if cur == 2 { 1 } else { 2 };
    sync_subtree_down(tv, hitem, next, nodes, checked_set);
    sync_ancestors_up(tv, hitem, nodes);
    match kind {
        TreeKind::Pack => update_pack_status_label(g),
        TreeKind::Apply => update_apply_status_label(g),
        TreeKind::Backup => update_backup_status_label(g),
        TreeKind::Downloads => update_downloads_status_label(g),
    }
}

unsafe fn handle_command(g: &mut GuiData, hwnd: HWND, id: u16, code: u16) {
    const EN_CHANGE: u16 = 0x0300;
    if id == IDC_EDIT_PACK_FILTER && code == EN_CHANGE {
        rebuild_pack_tree(g);
        return;
    }
    if id == IDC_CMB_PACK_PRESET && code == CBN_SELCHANGE {
        let idx = SendMessageW(g.hwnd_cmb_pack_preset, CB_GETCURSEL, 0, 0) as isize;
        if idx >= 0 && (idx as usize) < g.pack_presets.len() {
            if let Some(nm) = g.pack_presets[idx as usize].get("name").and_then(|v| v.as_str()) {
                set_window_text(g.hwnd_edit_preset_name, nm);
            }
        }
        return;
    }

    match id {
        IDC_BTN_CLEAR_LOG => {
            g.state.logs.clear();
            set_window_text(g.hwnd_edit_log, "");
            update_log_header_and_button(g);
        }
        IDC_BTN_OPEN_SITE => {
            let url = format!(
                "http://localhost:{}/__auth#__swamp_token={}",
                g.state.config.port, g.state.token
            );
            crate::open_url_in_browser(&url, false);
        }
        IDC_BTN_GEN => {
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                st.logs.info("[gen] 开始纯 Rust 全量构建...");
                match crate::builder::run_gen_with_logger(&st.config, Some(&st.logs)) {
                    Ok(()) => {
                        st.logs.info("[gen] 全量构建成功！");
                        spawn_load_synonyms_data(st.config.clone(), mailbox.clone(), false);
                        spawn_load_backup_tree(st.config.clone(), mailbox);
                    }
                    Err(e) => st.logs.error(format!("[gen] 构建失败: {}", e)),
                }
            });
        }
        IDC_BTN_GEN_PUSH | IDC_BTN_PUSH => {
            let run_gen_first = id == IDC_BTN_GEN_PUSH;
            let commit_msg = get_window_text_string(g.hwnd_edit_commit).trim().to_string();
            if commit_msg.is_empty() {
                let m = to_wide("请先在「Commit 说明」框中输入提交信息！");
                let t = to_wide("提示");
                MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONWARNING);
                return;
            }
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _busy = st.runtime.begin_op();
                if run_gen_first {
                    st.logs.info("[gen+push] 第 1 步：执行纯 Rust 全量构建...");
                    if let Err(e) = crate::builder::run_gen_with_logger(&st.config, Some(&st.logs)) {
                        st.logs.error(format!("[gen+push] 构建失败，已中止推送: {}", e));
                        return;
                    }
                    st.logs.info("[gen+push] 构建通过，第 2 步：执行 Git 提交与推送...");
                    spawn_load_synonyms_data(st.config.clone(), mailbox.clone(), false);
                    spawn_load_backup_tree(st.config.clone(), mailbox);
                } else {
                    st.logs.info("[push] 开始执行 Git 提交与推送...");
                }

                if !run_gen_first {
                    st.logs.info("[push] 执行推送前公私隔离复核...");
                    if let Err(e) =
                        crate::builder::generator::verify_public_outputs_clean(&st.config, Some(&st.logs))
                    {
                        st.logs.error(format!("[push] {}", e));
                        return;
                    }
                }

                let root = strip_verbatim_prefix(&st.config.repo_root);
                if !st.config.gitignore_file.is_file() {
                    st.logs.error("[git] 仓库根目录缺少 .gitignore，为防隐私泄露已拒绝推送！");
                    return;
                }

                let add_res = Command::new("git")
                    .args(["add", "-A"])
                    .current_dir(&root)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                match add_res {
                    Ok(o) if o.status.success() => {}
                    Ok(o) => {
                        st.logs.error(format!(
                            "[git] git add 失败: {}",
                            String::from_utf8_lossy(&o.stderr).trim()
                        ));
                        return;
                    }
                    Err(e) => {
                        st.logs.error(format!("[git] 启动 git add 失败: {}", e));
                        return;
                    }
                }

                // 隐私防线：检查暂存区是否包含任何私密/敏感路径，命中立即撤回暂存并中止推送
                let staged_out = Command::new("git")
                    .args(["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"])
                    .current_dir(&root)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                match staged_out {
                    Ok(o) if o.status.success() => {
                        let staged_str = String::from_utf8_lossy(&o.stdout);
                        let violations: Vec<String> = staged_str
                            .split('\0')
                            .filter(|s| !s.is_empty())
                            .map(|s| s.replace('\\', "/"))
                            .filter(|p| {
                                let low = p.to_ascii_lowercase();
                                pack_apply::is_hard_private_rel(p)
                                    || low.starts_with("html/__")
                                    || low.starts_with("src/js/data/shadow")
                                    || low.starts_with("_build/privy/")
                                    || low.starts_with("_build/temp/")
                            })
                            .collect();
                        if !violations.is_empty() {
                            let _ = Command::new("git")
                                .arg("reset")
                                .current_dir(&root)
                                .creation_flags(CREATE_NO_WINDOW)
                                .status();
                            st.logs.error(format!(
                                "[git] 隐私防线拦截：暂存区包含私密/敏感文件，已撤回暂存并中止推送:\n  {}",
                                violations.join("\n  ")
                            ));
                            return;
                        }
                    }
                    Ok(o) => {
                        st.logs.error(format!(
                            "[git] 暂存区隐私检查失败，已中止推送: {}",
                            String::from_utf8_lossy(&o.stderr).trim()
                        ));
                        return;
                    }
                    Err(e) => {
                        st.logs.error(format!("[git] 启动暂存区隐私检查失败，已中止推送: {}", e));
                        return;
                    }
                }

                let diff_res = Command::new("git")
                    .args(["diff", "--cached", "--quiet"])
                    .current_dir(&root)
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
                match diff_res {
                    Ok(s) if s.code() == Some(0) => {
                        st.logs.info("[git] 暂存区无新改动，跳过 commit，直接执行推送检查...");
                    }
                    Ok(s) if s.code() == Some(1) => {
                        let cmt_res = Command::new("git")
                            .args(["commit", "-m", &commit_msg])
                            .current_dir(&root)
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                        match cmt_res {
                            Ok(o) if o.status.success() => {}
                            Ok(o) => {
                                let out_s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                                let err_s = String::from_utf8_lossy(&o.stderr).trim().to_string();
                                st.logs
                                    .error(format!("[git] git commit 失败: {} {}", out_s, err_s));
                                return;
                            }
                            Err(e) => {
                                st.logs.error(format!("[git] 启动 git commit 失败: {}", e));
                                return;
                            }
                        }
                    }
                    Ok(s) => {
                        st.logs.error(format!("[git] git diff --cached 检查异常 (exit={:?})", s.code()));
                        return;
                    }
                    Err(e) => {
                        st.logs.error(format!("[git] 启动 git diff 失败: {}", e));
                        return;
                    }
                }

                match Command::new("git")
                    .arg("push")
                    .current_dir(&root)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                {
                    Ok(o) if o.status.success() => {
                        st.logs.info(format!("[git] 推送成功: {}", commit_msg));
                    }
                    Ok(o) => {
                        st.logs.error(format!(
                            "[git] git push 失败: {}",
                            String::from_utf8_lossy(&o.stderr).trim()
                        ));
                    }
                    Err(e) => {
                        st.logs.error(format!("[git] 启动 git push 失败: {}", e));
                    }
                }
            });
        }
        IDC_BTN_SIM => {
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let Ok(exe) = std::env::current_exe() else {
                    st.logs.error("[sim] 无法定位 swamp.exe");
                    return;
                };
                mailbox.kill_sim_child();
                let sim_port = st.config.sim_port;
                if sim_port == st.config.port {
                    st.logs.error(format!(
                        "[sim] 仿真端口 sim_port={} 与主服务端口冲突，请修改 _build/swamp.toml 后重试",
                        sim_port
                    ));
                    return;
                }
                let kill_cmd = format!(
                    "Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort {} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue | Where-Object {{ $_.ProcessName -eq 'swamp' }} | Stop-Process -Force -ErrorAction SilentlyContinue }}",
                    sim_port
                );
                let _ = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &kill_cmd])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();

                match Command::new(&exe)
                    .args([
                        "sim",
                        "--port",
                        &sim_port.to_string(),
                        "--log-level",
                        "info",
                        "--open",
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                {
                    Ok(child) => {
                        if let Ok(mut slot) = mailbox.sim_child.lock() {
                            *slot = Some(child);
                        }
                        st.logs.info(format!(
                            "[sim] 已启动线上仿真环境 http://localhost:{}（隐身窗口；关闭管理窗将自动回收）",
                            sim_port
                        ));
                    }
                    Err(e) => st.logs.error(format!("[sim] 启动仿真失败: {}", e)),
                }
            });
        }
        IDC_BTN_SELFCHECK => {
            let st = g.state.clone();
            std::thread::spawn(move || {
                st.logs.info("[selfcheck] 开始运行安全与构建自检...");
                let _ = run_selftest_with_logger(Some(&st.logs));
            });
        }
        IDC_BTN_ROOT => {
            let root = strip_verbatim_prefix(&g.state.config.repo_root);
            let _ = Command::new("explorer.exe").arg(&root).spawn();
        }
        IDC_BTN_REAUTH => {
            g.state.runtime.reauth_notify.notify_one();
            g.state
                .logs
                .info("[tasks] 已触发 Google Tasks 重新授权，请在浏览器完成确认");
        }
        IDC_BTN_NEW => {
            let title = get_window_text_string(g.hwnd_edit_new_title).trim().to_string();
            let category = get_window_text_string(g.hwnd_edit_new_cat).trim().to_string();
            let open_ed = is_checked(g.hwnd_chk_new_open);
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                match create_new_html(&st.config, &title, &category) {
                    Ok(created) => {
                        let clean = strip_verbatim_prefix(&created);
                        let path_s = clean.to_string_lossy().into_owned();
                        st.logs.info(format!("[new] 已创建新页: {}", path_s));
                        mailbox.post(WM_APP_CLEAR_NEW_TITLE, 0, 0);
                        if open_ed {
                            if let Err(e) = spawn_vscode(&st.config.vscode_path, &[path_s]) {
                                st.logs.warn(format!("[new] 拉起 VS Code 失败: {}", e));
                            }
                        }
                    }
                    Err(e) => st.logs.error(format!("[new] 创建失败: {}", e)),
                }
            });
        }
        IDC_BTN_WEBP => {
            let max_w: Option<u32> = get_window_text_string(g.hwnd_edit_webp_w).trim().parse().ok();
            let quality: Option<u8> = get_window_text_string(g.hwnd_edit_webp_q).trim().parse().ok();
            let use_alt = is_checked(g.hwnd_chk_webp_alt);
            let update_map = is_checked(g.hwnd_chk_webp_map);
            let st = g.state.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                st.logs.info("[webp] 开始纯 Rust 批量 WebP 转码...");
                match run_webp_batch(
                    &st.config,
                    WebpOptions {
                        max_width: max_w,
                        quality,
                        use_alt_output: use_alt,
                        update_img_mapping: update_map,
                    },
                ) {
                    Ok(s) => st.logs.info(format!(
                        "[webp] 完成: 成功 {}/{} | {} -> {} | 更新HTML: {} | 剪贴板: {} | {}ms",
                        s.success_count,
                        s.total_images,
                        format_bytes(s.original_bytes),
                        format_bytes(s.webp_bytes),
                        s.updated_html_count,
                        if s.clipboard_copied { "已复制" } else { "未复制" },
                        s.elapsed_ms
                    )),
                    Err(e) => st.logs.error(format!("[webp] 转码失败: {}", e)),
                }
            });
        }
        IDC_BTN_KEEP => {
            let sel = SendMessageW(g.hwnd_cmb_keep_mode, CB_GETCURSEL, 0, 0) as i32;
            let mode = if sel == 1 { "merge" } else { "single" }.to_string();
            let tag_name = get_window_text_string(g.hwnd_edit_keep_tag).trim().to_string();
            let category = get_window_text_string(g.hwnd_edit_keep_cat).trim().to_string();
            let st = g.state.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                st.logs.info(format!("[keep2html] 开始转换 ({})...", mode));
                match run_keep2html(
                    &st.config,
                    KeepOptions {
                        mode,
                        tag_name,
                        category,
                    },
                ) {
                    Ok(s) => st.logs.info(format!(
                        "[keep2html] 完成 ({}): 生成 {} 篇，处理图片 {} 张",
                        s.zip_file,
                        s.generated_pages.len(),
                        s.processed_images
                    )),
                    Err(e) => st.logs.error(format!("[keep2html] 转换失败: {}", e)),
                }
            });
        }
        // --- Pack Tab Commands ---
        IDC_CHK_PACK_MORE | IDC_BTN_PACK_REFRESH => {
            let more = is_checked(g.hwnd_chk_pack_more);
            spawn_load_pack_tree(
                g.state.config.clone(),
                g.state.logs.clone(),
                g.mailbox.clone(),
                more,
            );
        }
        IDC_BTN_PACK_CLEAR => {
            g.pack_checked.clear();
            rebuild_pack_tree(g);
        }
        IDC_BTN_PRESET_ONLY | IDC_BTN_PRESET_ADD => {
            let idx = SendMessageW(g.hwnd_cmb_pack_preset, CB_GETCURSEL, 0, 0) as isize;
            if idx >= 0 && (idx as usize) < g.pack_presets.len() {
                if id == IDC_BTN_PRESET_ONLY {
                    g.pack_checked.clear();
                }
                let preset = &g.pack_presets[idx as usize];
                let existing: HashSet<&str> =
                    g.pack_all_files.iter().map(|f| f.rel.as_str()).collect();
                if let Some(paths) = preset.get("paths").and_then(|v| v.as_array()) {
                    for p in paths {
                        if let Some(s) = p.as_str() {
                            if existing.contains(s) {
                                g.pack_checked.insert(s.to_string());
                            }
                        }
                    }
                }
                if let Some(globs) = preset.get("globs").and_then(|v| v.as_array()) {
                    for gl in globs {
                        if let Some(gs) = gl.as_str() {
                            if let Ok(gobj) = globset::GlobBuilder::new(gs)
                                .literal_separator(true)
                                .build()
                            {
                                let m = gobj.compile_matcher();
                                for f in &g.pack_all_files {
                                    if m.is_match(&f.rel) {
                                        g.pack_checked.insert(f.rel.clone());
                                    }
                                }
                            }
                        }
                    }
                }
                rebuild_pack_tree(g);
            }
        }
        IDC_BTN_GIT_MOD => {
            let mods = pack_apply::list_git_modified(&g.state.config);
            if mods.is_empty() {
                g.state
                    .logs
                    .info("[pack] 当前 Git 工作区没有可勾选的非私密改动文件");
            } else {
                for m in mods {
                    g.pack_checked.insert(m);
                }
                rebuild_pack_tree(g);
            }
        }
        IDC_CHK_PACK_MD => {
            let on = is_checked(g.hwnd_chk_pack_md);
            EnableWindow(g.hwnd_edit_pack_md_max, if on { 1 } else { 0 });
            set_window_text(
                g.hwnd_btn_pack_zip,
                if on { "打包 ZIP + 拼接 MD" } else { "按原层级打包 ZIP" },
            );
        }
        IDC_BTN_PACK_ZIP => {
            let paths: Vec<String> = g.pack_checked.iter().cloned().collect();
            if paths.is_empty() {
                let m = to_wide("请先在目录树中勾选至少一个文件！");
                let t = to_wide("提示");
                MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONINFORMATION);
                return;
            }
            let stitch_md = is_checked(g.hwnd_chk_pack_md);
            let max_md_kb: usize = if stitch_md {
                let raw_kb = get_window_text_string(g.hwnd_edit_pack_md_max)
                    .trim()
                    .to_string();
                match raw_kb.parse::<usize>() {
                    Ok(v) if (10..=51200).contains(&v) => v,
                    _ => {
                        let m = to_wide("单 MD 体积上限请输入 10 ~ 51200 之间的整数（单位 KB，建议 150~300）！");
                        let t = to_wide("参数无效");
                        MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONWARNING);
                        return;
                    }
                }
            } else {
                200
            };
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                match pack_apply::create_pack_zip_with_options(
                    &st.config, &paths, stitch_md, max_md_kb,
                ) {
                    Ok(res) => {
                        st.logs.info(format!(
                            "[pack] 打包完成: {} ({} 个文件, {})",
                            res.file_name,
                            res.packed_count,
                            format_bytes(res.zip_size)
                        ));
                        spawn_load_backup_tree(st.config.clone(), mailbox);
                        if let Some(ref md_dir) = res.md_dir {
                            let bin_note = if res.md_skipped_binary > 0 {
                                format!("，跳过二进制 {} 个", res.md_skipped_binary)
                            } else {
                                String::new()
                            };
                            st.logs.info(format!(
                                "[pack] 已拼接 {} 份 Markdown（上限 {} KB{}）-> {}",
                                res.md_files.len(),
                                max_md_kb,
                                bin_note,
                                md_dir
                            ));
                            let _ = Command::new("explorer.exe").arg(md_dir).spawn();
                        } else {
                            let _ = Command::new("explorer.exe")
                                .arg(format!("/select,{}", res.full_path))
                                .spawn();
                        }
                    }
                    Err(e) => st.logs.error(format!("[pack] 打包失败: {}", e)),
                }
            });
        }
        // --- Apply Tab Commands ---
        IDC_BTN_APPLY_BROWSE => {
            let cfg = g.state.config.clone();
            let logs = g.state.logs.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let ps = r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'ZIP 补丁包 (*.zip)|*.zip'; $dl = Join-Path $env:USERPROFILE 'Downloads'; if (Test-Path $dl) { $d.InitialDirectory = $dl }; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"#;
                if let Ok(out) = Command::new("powershell")
                    .args(["-NoProfile", "-STA", "-Command", ps])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                {
                    let chosen = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !chosen.is_empty() {
                        spawn_load_zip_file(cfg, logs, mailbox, PathBuf::from(chosen));
                    }
                }
            });
        }
        IDC_BTN_APPLY_EXEC => {
            if g.apply_zip_bytes.is_empty() || g.apply_checked.is_empty() {
                return;
            }
            let selected: Vec<String> = g.apply_checked.iter().cloned().collect();
            let auto_bak = is_checked(g.hwnd_chk_apply_bak);
            let fix_enc = is_checked(g.hwnd_chk_apply_enc);
            let mut build_and_exit = is_checked(g.hwnd_chk_apply_build);

            let dangerous_selected: Vec<String> = g
                .apply_entries
                .iter()
                .filter(|e| !e.blocked && e.is_dangerous && g.apply_checked.contains(&e.rel))
                .map(|e| e.rel.clone())
                .collect();

            if !dangerous_selected.is_empty() {
                let disabled_note = if build_and_exit {
                    build_and_exit = false;
                    "\n已自动禁用「回填后拉起 build.bat」，请先人工核对改动后再手动编译。"
                } else {
                    ""
                };
                let warn_msg = format!(
                    "以下 {} 个选中文件属于高危构建/配置/隐私规则文件：\n\n  - {}{}\n\n确认您已信任此补丁来源并覆盖这些文件吗？",
                    dangerous_selected.len(),
                    dangerous_selected.join("\n  - "),
                    disabled_note
                );
                let warn_w = to_wide(&warn_msg);
                let warn_t = to_wide("高危构建文件二次确认");
                if MessageBoxW(hwnd, warn_w.as_ptr(), warn_t.as_ptr(), MB_YESNO | MB_ICONWARNING)
                    != IDYES
                {
                    return;
                }
            }

            let confirm_msg = if build_and_exit {
                format!(
                    "确定按仓库原层级回填选中的 {} 个文件，\n并在完成后安全退出 swamp.exe 再接力拉起 _build\\swamp-server\\build.bat 吗？",
                    selected.len()
                )
            } else {
                format!("确定按仓库原层级回填选中的 {} 个文件吗？", selected.len())
            };
            let confirm_w = to_wide(&confirm_msg);
            let title_w = to_wide("确认回填");
            if MessageBoxW(
                hwnd,
                confirm_w.as_ptr(),
                title_w.as_ptr(),
                MB_YESNO | MB_ICONQUESTION_OR_INFO,
            ) != IDYES
            {
                return;
            }

            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            let zname = g.apply_zip_name.clone();
            let zbytes = g.apply_zip_bytes.clone();
            let more = is_checked(g.hwnd_chk_pack_more);

            std::thread::spawn(move || {
                let apply_res = {
                    let _busy = st.runtime.begin_op();
                    pack_apply::execute_apply_zip(
                        &st.config, &zname, &zbytes, &selected, auto_bak, fix_enc,
                    )
                };
                match apply_res {
                    Ok(res) => {
                        st.logs.info(format!(
                            "[apply] 回填成功: 覆盖 {} 个, 新增 {} 个 (备份: {})",
                            res.overwritten, res.created, res.backup_name
                        ));
                        if build_and_exit {
                            let crate_dir = strip_verbatim_prefix(&st.config.build_dir.join("swamp-server"));
                            let build_bat = crate_dir.join("build.bat");
                            if !build_bat.is_file() {
                                st.logs.error(format!(
                                    "[apply] 找不到 {}，已取消自动退出",
                                    build_bat.display()
                                ));
                                return;
                            }
                            if let Ok(mut slot) = mailbox.pending_build_handoff.lock() {
                                *slot = Some((crate_dir, build_bat));
                            }
                            st.logs.info("[apply] 回填完成，正在确认安全退出 swamp.exe 后再接力拉起 build.bat...");
                            mailbox.post(WM_APP_EXIT_AND_BUILD, 0, 0);
                        } else {
                            spawn_load_backups(st.config.clone(), mailbox.clone());
                            spawn_load_backup_tree(st.config.clone(), mailbox.clone());
                            spawn_load_pack_tree(st.config.clone(), st.logs.clone(), mailbox, more);
                        }
                    }
                    Err(e) => st.logs.error(format!("[apply] 回填失败: {}", e)),
                }
            });
        }
        IDC_BTN_BAK_REFRESH => {
            spawn_load_backups(g.state.config.clone(), g.mailbox.clone());
            spawn_load_backup_tree(g.state.config.clone(), g.mailbox.clone());
            spawn_load_downloads_tree(g.mailbox.clone());
        }
        IDC_BTN_DL_OPEN => {
            if let Some(dl_dir) = g
                .downloads_dir
                .clone()
                .or_else(pack_apply::resolve_downloads_dir)
            {
                let clean = strip_verbatim_prefix(&dl_dir);
                let _ = Command::new("explorer.exe").arg(&clean).spawn();
            } else {
                g.state.logs.warn("[downloads] 未找到用户 Downloads 目录");
            }
        }
        IDC_BTN_DL_DEL => {
            if g.downloads_checked.is_empty() {
                return;
            }
            let selected: Vec<String> = g.downloads_checked.iter().cloned().collect();
            let mut file_bytes = 0u64;
            let mut dir_cnt = 0usize;
            for it in &g.downloads_items {
                if g.downloads_checked.contains(&it.rel) {
                    if it.is_dir {
                        dir_cnt += 1;
                    } else {
                        file_bytes = file_bytes.saturating_add(it.size);
                    }
                }
            }
            let extra_dir = if dir_cnt > 0 {
                format!("，含 {} 个整个文件夹", dir_cnt)
            } else {
                String::new()
            };
            let msg_w = to_wide(&format!(
                "确定永久删除 Downloads 中勾选的 {} 项（文件共 {}{}）吗？\n\n删除后不会进入回收站，不可恢复！",
                selected.len(),
                format_bytes(file_bytes),
                extra_dir
            ));
            let title_w = to_wide("确认清理 Downloads");
            if MessageBoxW(
                hwnd,
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_YESNO | MB_ICONWARNING,
            ) != IDYES
            {
                return;
            }
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                match pack_apply::delete_downloads_items(&selected) {
                    Ok((files, dirs, freed)) => {
                        st.logs.info(format!(
                            "[downloads] 已清理 {} 个文件、{} 个目录，释放 {}",
                            files,
                            dirs,
                            format_bytes(freed)
                        ));
                        spawn_load_downloads_tree(mailbox);
                    }
                    Err(e) => st.logs.error(format!("[downloads] 清理失败: {}", e)),
                }
            });
        }
        IDC_BTN_BACKUP_OPEN => {
            let dir = strip_verbatim_prefix(&g.state.config.backup_dir);
            let _ = std::fs::create_dir_all(&dir);
            let _ = Command::new("explorer.exe").arg(&dir).spawn();
        }
        IDC_BTN_BACKUP_DEL => {
            if g.backup_checked.is_empty() {
                return;
            }
            let selected: Vec<String> = g.backup_checked.iter().cloned().collect();
            let sel_bytes: u64 = g
                .backup_items
                .iter()
                .filter(|it| g.backup_checked.contains(&it.rel))
                .map(|it| it.size)
                .sum();
            let msg_w = to_wide(&format!(
                "确定永久删除 backup 中勾选的 {} 项（共 {}）吗？\n\n删除后不可恢复，若删掉 ai_apply_* 将移除对应回滚快照。",
                selected.len(),
                format_bytes(sel_bytes)
            ));
            let title_w = to_wide("确认清理 Backup");
            if MessageBoxW(
                hwnd,
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_YESNO | MB_ICONWARNING,
            ) != IDYES
            {
                return;
            }
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                match pack_apply::delete_backup_items(&st.config, &selected) {
                    Ok((files, dirs, freed)) => {
                        st.logs.info(format!(
                            "[backup] 已清理 {} 个文件、{} 个空目录，释放 {}",
                            files,
                            dirs,
                            format_bytes(freed)
                        ));
                        spawn_load_backups(st.config.clone(), mailbox.clone());
                        spawn_load_backup_tree(st.config.clone(), mailbox);
                    }
                    Err(e) => st.logs.error(format!("[backup] 清理失败: {}", e)),
                }
            });
        }
        IDC_BTN_ROLLBACK => {
            let idx = SendMessageW(g.hwnd_cmb_rollback, CB_GETCURSEL, 0, 0) as isize;
            if idx < 0 || (idx as usize) >= g.backups.len() {
                return;
            }
            let b = g.backups[idx as usize].clone();
            let msg_w = to_wide(&format!(
                "确定回滚快照 [{}]？\n将还原 {} 个被覆盖文件，并清理 {} 个当时新增的文件。",
                b.name, b.overwritten_count, b.created_count
            ));
            let title_w = to_wide("确认回滚");
            if MessageBoxW(
                hwnd,
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_YESNO | MB_ICONWARNING,
            ) != IDYES
            {
                return;
            }
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            let more = is_checked(g.hwnd_chk_pack_more);
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                match pack_apply::rollback_apply_backup(&st.config, &b.name) {
                    Ok((restored, removed)) => {
                        st.logs.info(format!(
                            "[rollback] 已回滚 {}: 还原 {} 个，清理新增 {} 个",
                            b.name, restored, removed
                        ));
                        spawn_load_pack_tree(st.config.clone(), st.logs.clone(), mailbox, more);
                    }
                    Err(e) => st.logs.error(format!("[rollback] 回滚失败: {}", e)),
                }
            });
        }
        IDC_BTN_PRESET_SAVE => {
            let name = get_window_text_string(g.hwnd_edit_preset_name).trim().to_string();
            if name.is_empty() {
                let m = to_wide("请先在「预设名」框中输入预设名称！");
                let t = to_wide("提示");
                MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONWARNING);
                return;
            }
            let mut paths: Vec<String> = g.pack_checked.iter().cloned().collect();
            paths.sort();
            if paths.is_empty() {
                let m = to_wide("请先在目录树中勾选至少一个文件再保存为预设！");
                let t = to_wide("提示");
                MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONWARNING);
                return;
            }
            let new_obj = serde_json::json!({ "name": name, "paths": paths });
            if let Some(pos) = g
                .pack_presets
                .iter()
                .position(|p| p.get("name").and_then(|v| v.as_str()) == Some(name.as_str()))
            {
                g.pack_presets[pos] = new_obj;
            } else {
                g.pack_presets.push(new_obj);
            }
            match crate::config::save_pack_presets(&g.state.config, &g.pack_skip_regex, &g.pack_presets) {
                Ok(()) => {
                    g.state.logs.info(format!("[pack] 已保存预设「{}」至 swamp.toml", name));
                    let more = is_checked(g.hwnd_chk_pack_more);
                    spawn_load_pack_tree(
                        g.state.config.clone(),
                        g.state.logs.clone(),
                        g.mailbox.clone(),
                        more,
                    );
                }
                Err(e) => g.state.logs.error(format!("[pack] 保存预设失败: {}", e)),
            }
        }
        IDC_BTN_PRESET_DEL => {
            let idx = SendMessageW(g.hwnd_cmb_pack_preset, CB_GETCURSEL, 0, 0) as isize;
            if idx < 0 || (idx as usize) >= g.pack_presets.len() {
                return;
            }
            let pname = g.pack_presets[idx as usize]
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let msg_w = to_wide(&format!("确定删除预设「{}」吗？", pname));
            let ttl_w = to_wide("确认删除预设");
            if MessageBoxW(hwnd, msg_w.as_ptr(), ttl_w.as_ptr(), MB_YESNO | MB_ICONWARNING) != IDYES {
                return;
            }
            g.pack_presets.remove(idx as usize);
            match crate::config::save_pack_presets(&g.state.config, &g.pack_skip_regex, &g.pack_presets) {
                Ok(()) => {
                    g.state.logs.info(format!("[pack] 已删除预设「{}」", pname));
                    let more = is_checked(g.hwnd_chk_pack_more);
                    spawn_load_pack_tree(
                        g.state.config.clone(),
                        g.state.logs.clone(),
                        g.mailbox.clone(),
                        more,
                    );
                }
                Err(e) => g.state.logs.error(format!("[pack] 删除预设失败: {}", e)),
            }
        }
        IDC_BTN_SYN_SAVE => {
            let raw = get_window_text_string(g.hwnd_edit_syn_custom).replace("\r\n", "\n");
            match crate::config::save_synonyms_custom_json(&g.state.config, &raw) {
                Ok(pretty) => {
                    let crlf = pretty.replace('\n', "\r\n");
                    set_window_text(g.hwnd_edit_syn_custom, &crlf);
                    g.state.logs.info("[synonyms] 自定义同义词已校验并保存至 _build/swamp.toml");
                }
                Err(e) => {
                    g.state.logs.error(format!("[synonyms] 保存失败: {}", e));
                    let mw = to_wide(&format!("保存失败：\n{}", e));
                    let tw = to_wide("JSON 校验错误");
                    MessageBoxW(hwnd, mw.as_ptr(), tw.as_ptr(), MB_OK | MB_ICONWARNING);
                }
            }
        }
        IDC_BTN_SYN_REBUILD => {
            let raw = get_window_text_string(g.hwnd_edit_syn_custom).replace("\r\n", "\n");
            if let Err(e) = crate::config::save_synonyms_custom_json(&g.state.config, &raw) {
                g.state.logs.error(format!("[synonyms] 保存失败，已中止重建: {}", e));
                let mw = to_wide(&format!("自定义同义词 JSON 校验失败：\n{}", e));
                let tw = to_wide("JSON 校验错误");
                MessageBoxW(hwnd, mw.as_ptr(), tw.as_ptr(), MB_OK | MB_ICONWARNING);
                return;
            }
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                let _busy = st.runtime.begin_op();
                st.logs.info("[synonyms] 开始单遍强制重建 synonyms.js + OOV 报告并执行全量构建 (gen)...");
                match crate::builder::run_gen_with_options(&st.config, Some(&st.logs), true) {
                    Ok(()) => {
                        st.logs.info("[synonyms] 同义词重建 + 全量构建全部完成！");
                        spawn_load_synonyms_data(st.config.clone(), mailbox.clone(), false);
                        spawn_load_backup_tree(st.config.clone(), mailbox);
                    }
                    Err(e) => st.logs.error(format!("[synonyms] 重建与构建失败: {}", e)),
                }
            });
        }
        IDC_BTN_SYN_IMPORT => {
            let st = g.state.clone();
            let mailbox = g.mailbox.clone();
            std::thread::spawn(move || {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let ps = r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'JSON 文件 (*.json)|*.json'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }"#;
                if let Ok(out) = Command::new("powershell")
                    .args(["-NoProfile", "-STA", "-Command", ps])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                {
                    let chosen = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !chosen.is_empty() {
                        match std::fs::read_to_string(&chosen) {
                            Ok(raw) => {
                                let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
                                match crate::config::save_synonyms_custom_json(&st.config, clean) {
                                    Ok(_) => {
                                        st.logs.info(format!("[synonyms] 已从 {} 导入并保存至 swamp.toml", chosen));
                                        spawn_load_synonyms_data(st.config.clone(), mailbox, true);
                                    }
                                    Err(e) => st.logs.error(format!("[synonyms] 导入 JSON 校验失败: {}", e)),
                                }
                            }
                            Err(e) => st.logs.error(format!("[synonyms] 读取 {} 失败: {}", chosen, e)),
                        }
                    }
                }
            });
        }
        IDC_BTN_OOV_REFRESH => {
            spawn_load_synonyms_data(g.state.config.clone(), g.mailbox.clone(), false);
            g.state.logs.info("[synonyms] 已刷新 OOV 新词雷达报告");
        }
        _ => {}
    }
}

const MB_ICONQUESTION_OR_INFO: u32 = MB_ICONINFORMATION;
