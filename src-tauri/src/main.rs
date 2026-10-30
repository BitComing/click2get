#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
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
fn set_monitoring(app: AppHandle, state: State<AppState>, on: bool) -> bool {
    state.monitoring.store(on, Ordering::SeqCst);
    update_settings(&app, |s| s.monitoring = on);
    tray::refresh(&app, on);
    let _ = app.emit("monitor-changed", on);
    on
}

#[tauri::command]
fn set_theme(app: AppHandle, theme: String) -> String {
    let t = if theme == "dark" { "dark" } else { "light" };
    update_settings(&app, |s| s.theme = t.to_string());
    t.to_string()
}

#[tauri::command]
fn set_sidebar(app: AppHandle, collapsed: bool) -> bool {
    update_settings(&app, |s| s.sidebar_collapsed = collapsed);
    collapsed
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
        truncated: false,
    })
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

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
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
            set_monitoring,
            set_theme,
            set_sidebar,
            open_data_dir,
            copy_with_marker,
            save_image_b64,
            quit_app,
            quit_gracefully,
            hide_window
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .expect("取不到 app_local_data_dir");
            std::fs::create_dir_all(&data_dir)?;
            storage::ensure_dirs(&data_dir);
            storage::migrate_legacy(&data_dir);

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