#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod export;
mod gallery;
mod ocr;
mod settings;
mod storage;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use settings::Settings;
use storage::NoteFull;

/// 一次捕获事件。前端拿它拼成 captureBlock 节点。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    /// "text" | "image"
    pub kind: String,
    /// 捕获时刻（只入 JSON 不展示，留给以后的排序/导出用）
    pub ts: i64,
    pub text: Option<String>,
    /// 相对数据目录的图片路径，如 images/ab/cd/<hash>.png
    pub path: Option<String>,
    pub hash: Option<String>,
    pub w: Option<u32>,
    pub h: Option<u32>,
    /// 剪切板 HTML 里带了 <a href> 且锚文本就是复制到的文字时，这里是被指向的网址。
    /// 前端据此把这次捕获做成"文字超链接"，而不是一段光秃秃的网址。
    pub href: Option<String>,
    pub truncated: bool,
}

pub struct AppState {
    /// 给剪贴板线程快速读的开关（与 settings.monitoring 保持同步）
    pub monitoring: AtomicBool,
    pub data_dir: PathBuf,
    /// 完整设置的唯一来源（监控开关 / 主题 / 上次打开的笔记）
    pub settings: Mutex<Settings>,
    /// 上一条捕获的 (内容 hash, 时间戳)，用于压掉同一次复制产生的重复通知
    pub last_seen: Mutex<(String, i64)>,
}

/// 改设置 → 落盘 → 返回快照。
pub fn update_settings<F: FnOnce(&mut Settings)>(app: &AppHandle, f: F) -> Settings {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        f(&mut s);
        s.clone()
    };
    settings::save(&state.data_dir, &snapshot);
    snapshot
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    notes: Vec<storage::NoteMeta>,
    settings: Settings,
    data_dir: String,
}

#[tauri::command]
fn bootstrap(state: State<AppState>) -> Bootstrap {
    Bootstrap {
        notes: storage::list(&state.data_dir),
        settings: state.settings.lock().unwrap().clone(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn create_note(app: AppHandle, state: State<AppState>) -> Result<NoteFull, String> {
    let note = storage::create(&state.data_dir, "无标题笔记")?;
    // 新建即成为"上次打开的笔记"，重启后回到这篇
    update_settings(&app, |s| s.last_note_id = Some(note.id.clone()));
    Ok(note)
}

#[tauri::command]
fn load_note(app: AppHandle, state: State<AppState>, id: String) -> Result<NoteFull, String> {
    let note = storage::load(&state.data_dir, &id)?;
    update_settings(&app, |s| s.last_note_id = Some(note.id.clone()));
    Ok(note)
}

#[tauri::command]
fn save_note(
    state: State<AppState>,
    id: String,
    doc: serde_json::Value,
) -> Result<storage::NoteMeta, String> {
    storage::save(&state.data_dir, &id, doc)
}

#[tauri::command]
fn rename_note(
    state: State<AppState>,
    id: String,
    title: String,
) -> Result<storage::NoteMeta, String> {
    storage::rename(&state.data_dir, &id, &title)
}

#[tauri::command]
fn delete_note(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    storage::delete(&state.data_dir, &id)?;
    let was_current = state.settings.lock().unwrap().last_note_id.as_deref() == Some(id.as_str());
    if was_current {
        update_settings(&app, |s| s.last_note_id = None);
    }
    Ok(())
}

/// 这篇笔记是不是空白的（没文字、没图）。侧栏删除靠它决定"要不要问一句"。
#[tauri::command]
fn note_blank(state: State<AppState>, id: String) -> bool {
    storage::is_blank(&state.data_dir, &id)
}

/// 侧栏右键 → 批量删除（同样走软删除，进 notes/.trash）。返回真正删掉的篇数。
#[tauri::command]
fn delete_notes(app: AppHandle, state: State<AppState>, ids: Vec<String>) -> Result<usize, String> {
    let moved = storage::delete_many(&state.data_dir, &ids);
    let current = state.settings.lock().unwrap().last_note_id.clone();
    if let Some(cur) = current {
        if ids.iter().any(|id| id == &cur) {
            update_settings(&app, |s| s.last_note_id = None);
        }
    }
    Ok(moved)
}

/// 置顶 / 取消置顶。
#[tauri::command]
fn set_pinned(state: State<AppState>, id: String, pinned: bool) -> Result<storage::NoteMeta, String> {
    storage::set_pinned(&state.data_dir, &id, pinned)
}

// ── 平铺预览页：目录 + 归类 / 排序 ──────────────────────

/// 平铺页要的全部数据（卡片预览 + 目录列表）。一次拿全，前端只管摆。
#[tauri::command]
fn gallery_view(state: State<AppState>) -> gallery::GalleryView {
    gallery::view(&state.data_dir)
}

#[tauri::command]
fn folder_create(
    state: State<AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<gallery::Folder, String> {
    gallery::create_folder(&state.data_dir, &name, parent_id.as_deref())
}

#[tauri::command]
fn folder_rename(state: State<AppState>, id: String, name: String) -> Result<gallery::Folder, String> {
    gallery::rename_folder(&state.data_dir, &id, &name)
}

/// 删目录（连同子目录）：里面的笔记回到未分类，一篇都不删。
#[tauri::command]
fn folder_delete(state: State<AppState>, id: String) -> Result<(), String> {
    gallery::delete_folder(&state.data_dir, &id)
}

/// 同一层目录的新顺序（上移 / 下移之后整条发过来）。
#[tauri::command]
fn folders_save_order(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    gallery::save_folder_order(&state.data_dir, &ids)
}

/// 批量归类（多选拖动 / 多选"移到目录"）：folderId 为 null 表示移回未分类。
#[tauri::command]
fn notes_set_folder(
    state: State<AppState>,
    ids: Vec<String>,
    folder_id: Option<String>,
) -> Result<(), String> {
    gallery::set_notes_folder(&state.data_dir, &ids, folder_id.as_deref())
}

/// 一个目录拖完之后的最终顺序（整条发过来，按下标写成 sort）。
#[tauri::command]
fn notes_save_order(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    gallery::save_order(&state.data_dir, &ids)
}

/// 长按把图片拖到侧栏的某篇笔记上：图片从那篇笔记里挪过来（文件不复制）。
#[tauri::command]
fn append_image_to_note(
    state: State<AppState>,
    id: String,
    path: String,
    hash: String,
    w: Option<u32>,
    h: Option<u32>,
) -> Result<storage::NoteMeta, String> {
    storage::append_image(&state.data_dir, &id, &path, &hash, w, h)
}

/// 长按把正文里选中的几行拖到侧栏的另一篇笔记上：整块追加到那篇笔记末尾。
#[tauri::command]
fn append_blocks_to_note(
    state: State<AppState>,
    id: String,
    blocks: serde_json::Value,
) -> Result<storage::NoteMeta, String> {
    storage::append_blocks(&state.data_dir, &id, blocks)
}

/// 导出：format = "md" | "docx"，stamp 是前端算好的本地时间（导出目录里会开资源管理器并选中它）。
#[tauri::command]
fn export_note(
    state: State<AppState>,
    id: String,
    format: String,
    stamp: String,
) -> Result<export::ExportFile, String> {
    let file = export::export_note(&state.data_dir, &id, &format, &stamp)?;
    // 导出后直接把文件亮给用户：不用自己去找 exports 目录
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", file.path))
        .spawn();
    Ok(file)
}

/// 图片库里的"删除笔记"：真删（不进回收站）。
#[tauri::command]
fn purge_note(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    storage::purge(&state.data_dir, &id)?;
    let was_current = state.settings.lock().unwrap().last_note_id.as_deref() == Some(id.as_str());
    if was_current {
        update_settings(&app, |s| s.last_note_id = None);
    }
    Ok(())
}

/// 图片库：用选中的图片新建一篇笔记。
#[tauri::command]
fn create_note_from_images(
    app: AppHandle,
    state: State<AppState>,
    hashes: Vec<String>,
) -> Result<NoteFull, String> {
    let note = storage::create_from_images(&state.data_dir, &hashes)?;
    update_settings(&app, |s| s.last_note_id = Some(note.id.clone()));
    Ok(note)
}

#[tauri::command]
fn set_monitoring(app: AppHandle, state: State<AppState>, on: bool) -> bool {
    state.monitoring.store(on, Ordering::SeqCst);
    update_settings(&app, |s| s.monitoring = on);
    tray::refresh(&app, on);
    let _ = app.emit("monitor-changed", on);
    on
}

/// 捕获去重开关。比对本身在前端（只有它握着正文），这里只负责记住选择。
#[tauri::command]
fn set_dedupe(app: AppHandle, on: bool) -> bool {
    update_settings(&app, |s| s.dedupe = on);
    on
}

/// 托盘弹窗里的"监控"那一行：点一下切一次，弹窗不关。
#[tauri::command]
fn toggle_monitoring(app: AppHandle) -> bool {
    tray::toggle_monitoring(&app)
}

#[tauri::command]
fn set_theme(app: AppHandle, theme: String) -> String {
    let t = if theme == "dark" { "dark" } else { "light" };
    update_settings(&app, |s| s.theme = t.to_string());
    // 托盘弹窗（另一个窗口）也要跟着换配色
    let _ = app.emit("theme-changed", t);
    t.to_string()
}

#[tauri::command]
fn set_sidebar(app: AppHandle, collapsed: bool) -> bool {
    update_settings(&app, |s| s.sidebar_collapsed = collapsed);
    collapsed
}

/// 侧栏宽度：拖一次记一次，超出范围就夹住。
#[tauri::command]
fn set_sidebar_width(app: AppHandle, width: u32) -> u32 {
    let w = width.clamp(
        settings::MIN_SIDEBAR_WIDTH,
        settings::MAX_SIDEBAR_WIDTH,
    );
    update_settings(&app, |s| s.sidebar_width = w);
    w
}

#[tauri::command]
fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&state.data_dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开文件夹失败: {e}"))
}

/// 应用内"复制"必须走这里：同时写入 Click2GetOwned 标记格式，
/// 否则监听线程会把自己复制出去的内容当成新捕获再记一遍。
#[tauri::command]
fn copy_with_marker(text: String) -> Result<(), String> {
    clipboard::set_text_with_marker(&text)
}

/// 图片库：扫一遍 images/ 下的图片（带尺寸和引用它的笔记标题）。
#[tauri::command]
fn list_images(state: State<AppState>) -> Vec<storage::ImageMeta> {
    storage::list_images(&state.data_dir)
}

/// 图片库多选删除：图移进 images/.trash/，同时把正文里引用它们的节点摘掉。
#[tauri::command]
fn delete_images(
    state: State<AppState>,
    hashes: Vec<String>,
) -> Result<storage::DeleteImagesResult, String> {
    storage::delete_images(&state.data_dir, &hashes)
}

/// 读一张图的备注（备注属于图片，不属于某一篇笔记）。
#[tauri::command]
fn get_image_note(state: State<AppState>, hash: String) -> String {
    storage::read_image_note(&state.data_dir, &hash)
}

/// 写/清空一张图的备注。空字符串 = 删掉备注。
#[tauri::command]
fn set_image_note(state: State<AppState>, hash: String, note: String) -> Result<(), String> {
    storage::set_image_note(&state.data_dir, &hash, &note)
}

/// 全局搜索：正文 + 图片备注。
#[tauri::command]
fn search_notes(state: State<AppState>, query: String) -> Vec<storage::SearchHit> {
    storage::search(&state.data_dir, &query)
}

/// 图片 OCR（Windows 自带识别引擎）。只返回文字，存不存、怎么用由前端决定。
#[tauri::command]
fn ocr_image(state: State<AppState>, hash: String) -> Result<String, String> {
    ocr::recognize_image(&state.data_dir, &hash)
}

#[tauri::command]
fn save_image_b64(state: State<AppState>, b64: String) -> Result<Capture, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let (path, hash, w, h) = storage::save_image(&state.data_dir, &bytes)?;
    Ok(Capture {
        kind: "image".into(),
        ts: storage::now_ms(),
        text: None,
        path: Some(path),
        hash: Some(hash),
        w: Some(w),
        h: Some(h),
        href: None,
        truncated: false,
    })
}

/// 用系统默认浏览器打开链接。只放行 http/https/mailto —— 编辑器里的链接
/// 是"从别处抄来的"，不能让 file:// 或 cmd 之类的东西借这条路跑起来。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let allowed = ["http://", "https://", "mailto:"]
        .iter()
        .any(|p| lower.starts_with(p));
    if !allowed || url.len() > 4096 || url.chars().any(|c| c.is_control()) {
        return Err("不支持的链接".into());
    }

    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op = HSTRING::from("open");
    let file = HSTRING::from(url);
    let ret = unsafe { ShellExecuteW(None, &op, &file, None, None, SW_SHOWNORMAL) };
    // ShellExecuteW 返回值 <= 32 都是错误码
    if ret.0 as isize <= 32 {
        return Err("打开链接失败".into());
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 菜单里的"退出"：先让前端落盘，再退出。
#[tauri::command]
fn quit_gracefully(app: AppHandle) {
    request_quit(&app);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 托盘弹窗：开关主窗口（"打开/关闭"那一行）。
#[tauri::command]
fn toggle_main_window(app: AppHandle) {
    toggle_window(&app);
}

/// 托盘弹窗：新建笔记。
///
/// **不叫出窗口**：从托盘菜单新建笔记的人，多半正开着别的程序在抄东西，
/// 这时候把窗口弹到脸上就是打扰。新笔记在后台建好（侧栏最上面多一条），
/// 想写的时候再点托盘图标打开。
#[tauri::command]
fn tray_new_note(app: AppHandle) {
    let _ = app.emit("new-note", ());
    tray::hide_popup(&app);
}

/// 托盘弹窗：收起自己（点完菜单项之后调）。
#[tauri::command]
fn hide_tray_popup(app: AppHandle) {
    tray::hide_popup(&app);
}

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 托盘图标左键：主窗口在最前面就收起来，否则**拉到最前面**。
///
/// 以前只看"可见 / 最小化"：窗口开在别的程序后面时，点托盘图标会直接把它藏起来，
/// 想把它叫到前面反而得点两次。现在按"它现在是不是前台窗口"判断：
/// - 前台就是它 → 收起（这是"再点一下关掉"）；
/// - 只是被别的窗口压住 / 最小化 / 已隐藏 → 都算"要叫出来"，show + unminimize + 聚焦。
pub fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let minimized = w.is_minimized().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && !minimized && focused {
            let _ = w.hide();
        } else {
            show_window(app);
        }
    }
}

/// 退出前先让前端把最后 500ms 的编辑落盘（emit flush-save），
/// 800ms 后无论前端是否响应都退出，避免卡死。
pub fn request_quit(app: &AppHandle) {
    let _ = app.emit("flush-save", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        handle.exit(0);
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            create_note,
            load_note,
            save_note,
            rename_note,
            note_blank,
            delete_note,
            delete_notes,
            set_pinned,
            gallery_view,
            folder_create,
            folder_rename,
            folder_delete,
            folders_save_order,
            notes_set_folder,
            notes_save_order,
            append_image_to_note,
            append_blocks_to_note,
            export_note,
            purge_note,
            create_note_from_images,
            set_monitoring,
            toggle_monitoring,
            set_dedupe,
            set_theme,
            set_sidebar,
            set_sidebar_width,
            open_data_dir,
            copy_with_marker,
            save_image_b64,
            list_images,
            delete_images,
            get_image_note,
            set_image_note,
            search_notes,
            ocr_image,
            quit_app,
            quit_gracefully,
            hide_window,
            toggle_main_window,
            tray_new_note,
            hide_tray_popup,
            open_url
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .expect("取不到 app_local_data_dir");
            std::fs::create_dir_all(&data_dir)?;
            storage::ensure_dirs(&data_dir);
            storage::migrate_legacy(&data_dir);
            // 图片备注从"笔记节点上的 attrs.note"搬到图片自己的 sidecar
            storage::migrate_image_notes(&data_dir);

            let s = settings::load(&data_dir);

            app.manage(AppState {
                monitoring: AtomicBool::new(s.monitoring),
                data_dir: data_dir.clone(),
                settings: Mutex::new(s.clone()),
                last_seen: Mutex::new((String::new(), 0)),
            });

            // 关窗口 = 隐藏到托盘（进程与 WebView 都不退，捕获继续）
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            tray::build(app.handle())?;
            tray::refresh(app.handle(), s.monitoring);

            clipboard::spawn(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Click2Get 启动失败");
}

fn main() {
    run();
}