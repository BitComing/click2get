//! 托盘：双态图标 + 菜单（打开 / 暂停·恢复 / 退出）。

use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

fn make_icon(on: bool) -> tauri::Result<tauri::image::Image<'static>> {
    let bytes: &'static [u8] = if on {
        include_bytes!("../icons/tray-on.png")
    } else {
        include_bytes!("../icons/tray-off.png")
    };
    tauri::image::Image::from_bytes(bytes)
}

fn tooltip(on: bool) -> &'static str {
    if on {
        "Click2Get · 监控中"
    } else {
        "Click2Get · 已暂停"
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "暂停 / 恢复监控", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &toggle_item, &sep, &quit_item])?;

    TrayIconBuilder::with_id("main")
        .icon(make_icon(true)?)
        .tooltip(tooltip(true))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => crate::show_window(app),
            "toggle" => toggle(app),
            "quit" => crate::request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 切换监控开关（托盘入口）。与前端 set_monitoring 命令共享同一份状态。
fn toggle(app: &AppHandle) {
    let state = app.state::<AppState>();
    let next = !state.monitoring.load(Ordering::SeqCst);
    state.monitoring.store(next, Ordering::SeqCst);
    crate::update_settings(app, |s| s.monitoring = next);
    let _ = app.emit("monitor-changed", next);
    refresh(app, next);
}

/// 更新托盘图标（绿/灰）与 tooltip。
pub fn refresh(app: &AppHandle, on: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(img) = make_icon(on) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(tooltip(on)));
    }
}