//! 剪贴板监听 + 读写（Win32 事件驱动，无轮询）。

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE,
};

use crate::{storage, AppState, Capture};

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;

const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 8000;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[inline]
fn as_hglobal(h: HANDLE) -> HGLOBAL {
    // HGLOBAL 与 HANDLE 在 ABI 上等价，用 transmute_copy 规避
    // windows crate 各版本之间字段类型（isize / 指针）的差异。
    unsafe { std::mem::transmute_copy(&h) }
}

#[inline]
fn as_handle(hg: HGLOBAL) -> HANDLE {
    unsafe { std::mem::transmute_copy(&hg) }
}

fn has_format(fmt: u32) -> bool {
    unsafe { IsClipboardFormatAvailable(fmt).is_ok() }
}

fn exclude_format() -> u32 {
    // 密码管理器（1Password / KeePass / Bitwarden）会置这个格式，
    // 表示"这段内容不要被剪贴板历史/監控程序记录"。
    unsafe { RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")) }
}

fn owned_format() -> u32 {
    unsafe { RegisterClipboardFormatW(w!("Click2GetOwned")) }
}

fn png_format() -> u32 {
    unsafe { RegisterClipboardFormatW(w!("PNG")) }
}

/// 启动监听线程。线程常驻，监控开关只控制"是否读取"。
pub fn spawn(app: AppHandle) {
    thread::spawn(move || unsafe {
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Click2Get-ClipboardListener"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };

        if AddClipboardFormatListener(hwnd).is_err() {
            return;
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_CLIPBOARDUPDATE {
                handle_update(&app);
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

unsafe fn handle_update(app: &AppHandle) {
    let state = app.state::<AppState>();

    // ① 监控关闭 —— 在 OpenClipboard 之前返回，语义上是"不读取"
    if !state.monitoring.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }

    // ② 在我们自己的窗口里复制的东西不记录。
    //    这条比"写剪贴板时打标记"更保险：Ctrl+C、右键复制、将来任何复制入口都覆盖到。
    if own_window_is_foreground() {
        return;
    }

    // ③ 排除格式（不打开剪贴板即可检测）
    if has_format(exclude_format()) {
        return;
    }
    if has_format(owned_format()) {
        return;
    }

    // ④ 打开剪贴板（退避重试：对方程序可能正持有）
    let mut opened = false;
    for _ in 0..4 {
        if OpenClipboard(None).is_ok() {
            opened = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !opened {
        return;
    }

    let captured: Option<Capture> = read_text(&state).or_else(|| read_image(&state));

    let _ = CloseClipboard();

    if let Some(cap) = captured {
        let _ = app.emit("capture", cap);
    }
}


/// 读文本。命中则返回 Capture（内部已做长度截断与去重）。
unsafe fn read_text(state: &AppState) -> Option<Capture> {
    if !has_format(CF_UNICODETEXT) {
        return None;
    }
    let raw = GetClipboardData(CF_UNICODETEXT).ok()?;
    if raw.is_invalid() {
        return None;
    }
    let hg = as_hglobal(raw);
    let ptr = GlobalLock(hg);
    if ptr.is_null() {
        return None;
    }
    let size = GlobalSize(hg);
    if size < 4 {
        let _ = GlobalUnlock(hg);
        return None;
    }
    let units = size / 2;
    let slice = std::slice::from_raw_parts(ptr as *const u16, units);
    let end = slice.iter().position(|&c| c == 0).unwrap_or(units);
    let mut text = String::from_utf16_lossy(&slice[..end]);
    let _ = GlobalUnlock(hg);

    // 过滤：太短 / 全空白
    let trimmed_len = text.trim().chars().count();
    if trimmed_len < 2 {
        return None;
    }

    // 去重：与上一条相同、且间隔很短（同一次复制的重复通知）则跳过
    let hash = storage::sha256_hex(text.as_bytes());
    if skip_duplicate(state, &hash) {
        return None;
    }

    let mut truncated = false;
    if text.len() > MAX_TEXT_BYTES {
        let mut cut = MAX_TEXT_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        truncated = true;
    }

    Some(Capture {
        kind: "text".into(),
        ts: storage::now_ms(),
        text: Some(text),
        path: None,
        hash: None,
        w: None,
        h: None,
        truncated,
    })
}

/// 读图片。优先 PNG 格式（Chrome/Edge/截图工具都给这个），CF_DIB 兜底。
unsafe fn read_image(state: &AppState) -> Option<Capture> {
    let bytes: Vec<u8> = if has_format(png_format()) {
        read_format_bytes(png_format())?
    } else if has_format(CF_DIB) {
        let dib = read_format_bytes(CF_DIB)?;
        dib_to_bmp(&dib).or_else(|| dib_to_bmp_raw(&dib))?
    } else {
        return None;
    };

    if bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }

    let (path, hash, w, h) = storage::save_image(&state.data_dir, &bytes).ok()?;
    if w > MAX_IMAGE_EDGE || h > MAX_IMAGE_EDGE {
        return None;
    }
    // 同一张图被重复通知时只记一次
    if skip_duplicate(state, &hash) {
        return None;
    }

    Some(Capture {
        kind: "image".into(),
        ts: storage::now_ms(),
        text: None,
        path: Some(path),
        hash: Some(hash),
        w: Some(w),
        h: Some(h),
        truncated: false,
    })
}

/// 前台窗口是不是我们自己的进程（= 用户在笔记软件里复制的）。
fn own_window_is_foreground() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid != 0 && pid == std::process::id()
    }
}

/// 同一条内容在 1.5 秒内重复触发（Windows 有时连发两次 WM_CLIPBOARDUPDATE）就跳过。
fn skip_duplicate(state: &AppState, hash: &str) -> bool {
    let now = storage::now_ms();
    let mut last = state.last_seen.lock().unwrap();
    if last.0 == hash && now - last.1 < 1500 {
        return true;
    }
    *last = (hash.to_string(), now);
    false
}

unsafe fn read_format_bytes(fmt: u32) -> Option<Vec<u8>> {
    let raw = GetClipboardData(fmt).ok()?;
    if raw.is_invalid() {
        return None;
    }
    let hg = as_hglobal(raw);
    let ptr = GlobalLock(hg);
    if ptr.is_null() {
        return None;
    }
    let size = GlobalSize(hg);
    if size == 0 {
        let _ = GlobalUnlock(hg);
        return None;
    }
    let out = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(hg);
    Some(out)
}

/// CF_DIB 的载荷就是"缺了 14 字节文件头"的 BMP，补回去即可交给 image 解码。
fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let bi_size = u32::from_le_bytes(dib[0..4].try_into().ok()?) as usize;
    let bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(dib[16..20].try_into().ok()?);
    // 只处理真彩色；带调色板的老格式交给系统 PNG 路径
    if bit_count != 24 && bit_count != 32 {
        return None;
    }
    let extra = if compression == 3 { 12 } else { 0 }; // BI_BITFIELDS
    let off_bits = 14 + bi_size + extra;
    let file_size = 14 + dib.len();
    let mut out = Vec::with_capacity(file_size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(off_bits as u32).to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

fn dib_to_bmp_raw(dib: &[u8]) -> Option<Vec<u8>> {
    dib_to_bmp(dib)
}

/// 复制文本并打上自捕获标记。
pub fn set_text_with_marker(text: &str) -> Result<(), String> {
    let owned = owned_format();
    let mut last_err = String::from("写剪贴板失败");
    for _ in 0..4 {
        unsafe {
            if OpenClipboard(None).is_err() {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        }
        let res = (|| -> Result<(), String> {
            unsafe {
                EmptyClipboard().map_err(|e| e.message())?;
                let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
                let bytes =
                    std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
                let h = alloc_global_bytes(bytes).ok_or_else(|| "分配全局内存失败".to_string())?;
                SetClipboardData(CF_UNICODETEXT, Some(h)).map_err(|e| e.message())?;
                let marker =
                    alloc_global_bytes(&[1u8]).ok_or_else(|| "分配全局内存失败".to_string())?;
                SetClipboardData(owned, Some(marker)).map_err(|e| e.message())?;
            }
            Ok(())
        })();
        unsafe {
            let _ = CloseClipboard();
        }
        match res {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(last_err)
}

unsafe fn alloc_global_bytes(data: &[u8]) -> Option<HANDLE> {
    let hg = GlobalAlloc(GMEM_MOVEABLE, data.len()).ok()?;
    let ptr = GlobalLock(hg);
    if ptr.is_null() {
        return None;
    }
    std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
    let _ = GlobalUnlock(hg);
    Some(as_handle(hg))
}