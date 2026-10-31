//! 托盘：双态图标 + 一个自己的小弹窗菜单（新建 / 开关窗口 / 暂停·恢复 / 退出）。
//!
//! 为什么不用系统原生菜单：原生菜单点任何一下都会收起来，而"暂停/恢复监控"
//! 需要点完之后菜单还留着（用户常连着点两下确认状态）。所以右键弹的是
//! 我们自己的一个无边框小窗口（前端在 src/TrayMenu.tsx）。
//!
//! 左键单击托盘图标 = 打开 / 关闭主窗口。
//!
//! 两件曾经踩过的坑（改之前先读这一段）：
//!
//! 1. **弹窗必须提前建好。** 它以前是"第一次右键才建"：在托盘事件回调里现场建一个
//!    WebView 窗口，慢（几百毫秒空白）而且一旦失败就被 `let Ok(win) = … else { return }`
//!    悄悄吃掉 —— 表现就是"右键点了没反应，菜单永远不出来"。现在启动时就建好并藏着，
//!    右键只做"摆位置 + show()"，既快也不会失败。
//! 2. **位置只信鼠标，图标矩形只当参考。** 图标被收进溢出面板（Win11 默认就把新图标
//!    放那儿）时，事件里的矩形可能是空的甚至是负的；按它摆位置会把菜单丢到屏幕外面，
//!    看着也像"没弹出来"。所以：矩形不合理就用鼠标坐标兜底，最后再夹进显示器范围。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, Rect, Size, WebviewUrl,
    WebviewWindowBuilder,
};

/// 弹窗大小（逻辑像素）：和 styles.css 里的 `.tray-menu` 是配套的 ——
/// 卡片是"窗口 inset 8px"的那块，四行按钮各 25px，加起来 136 高。
/// 改布局记得两边一起改，不然不是留白就是被裁掉半行。
const POPUP_W: f64 = 176.0;
const POPUP_H: f64 = 136.0;
/// 弹窗和托盘图标之间的缝（逻辑像素）：贴着图标弹，别飘太远。
const POPUP_GAP: f64 = 4.0;

/// 弹窗刚因为失焦而关掉的时刻。
///
/// 点托盘图标时，系统会先把焦点从弹窗拿走（于是弹窗自己收起），紧接着才把
/// "点了托盘"这个事件送到我们手里。记一下收起的时间，就能把紧接着的那次
/// 点击当成"再点一下就关掉"，而不是手忙脚乱地又弹一次。
static LAST_HIDE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 调试日志：只在 debug 构建里写 %TEMP%\click2get-tray.log。
///
/// 托盘这条路出错时是"什么都不发生"，没有日志就只能靠猜；release 里一行都不写。
fn trace(msg: impl AsRef<str>) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let path = std::env::temp_dir().join("click2get-tray.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{} {}", now_ms(), msg.as_ref());
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = msg;
    }
}

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
    TrayIconBuilder::with_id("main")
        .icon(make_icon(true)?)
        .tooltip(tooltip(true))
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // 双击的第二次按下会变成 DoubleClick，不再有 Click；当成"再点一下"处理，
            // 免得用户手快点两下时第二下完全没反应。
            let (button, state, rect, cursor) = match event {
                TrayIconEvent::Click {
                    button,
                    button_state,
                    rect,
                    position,
                    ..
                } => (button, button_state, rect, position),
                TrayIconEvent::DoubleClick {
                    button,
                    rect,
                    position,
                    ..
                } => (button, MouseButtonState::Up, rect, position),
                _ => return,
            };
            trace(format!(
                "tray event button={button:?} state={state:?} rect={:?}/{:?} cursor={cursor:?}",
                rect.position, rect.size
            ));
            if !matches!(state, MouseButtonState::Up) {
                return;
            }
            let app = tray.app_handle();
            match button {
                // 左键：开 / 关主窗口
                MouseButton::Left => crate::toggle_window(app),
                // 右键：贴着小图标弹出自己的菜单
                MouseButton::Right => show_popup(app, rect, Some(cursor)),
                _ => {}
            }
        })
        .build(app)?;

    // 见文件头第 1 条：提前建好、藏着。失败也只是这一路不能用，不能拖垮启动。
    if let Err(e) = popup_window(app) {
        trace(format!("popup_window(prewarm) failed: {e}"));
    }
    Ok(())
}

/// 主窗口的 WebView2 启动参数（tauri.conf.json 里的 `additionalBrowserArgs`）。
///
/// **这是右键菜单能不能弹出来的关键。** WebView2 在一个进程里只认一套"环境参数"：
/// 主窗口带着 `--disable-gpu …` 这一串起来之后，再建一个参数不同的 WebView 会直接
/// 失败 —— HRESULT 0x8007139F，报"组或资源的状态不是执行请求操作的正确状态"。
/// 托盘弹窗以前就是这么挂的：窗口建不出来，右键看起来就是"点了没反应"，
/// 而且错误被 `let Ok(win) = … else { return }` 吃掉了，连日志都没有。
///
/// 从配置里读，而不是抄一份常量：主窗口那串参数改了，这里自动跟着改。
fn main_browser_args(app: &AppHandle) -> Option<String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone())
}

/// 弹窗窗口（懒创建：第一次右键才建，之后一直复用、只隐藏）。
fn popup_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("tray") {
        return Ok(w);
    }

    let mut builder = WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("index.html".into()))
        .title("Click2Get")
        .inner_size(POPUP_W, POPUP_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        // 关掉系统投影：无边框透明窗口的系统阴影是贴着窗口矩形画的，不跟圆角，
        // 看着就是那圈"黑框"。投影改由 CSS 画（.tray-menu 的 box-shadow）。
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false);
    // 必须和主窗口一模一样，否则 WebView2 直接拒绝建窗口（见 main_browser_args）
    if let Some(args) = main_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    let win = builder.build()?;
    trace("popup_window created");

    // 点到别处（窗口失去焦点）= 收起菜单
    let w = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
                LAST_HIDE_MS.store(now_ms(), Ordering::SeqCst);
            }
        }
    });

    Ok(win)
}

/// 把弹窗摆到托盘图标旁边并显示出来。
///
/// `rect` 是图标矩形（可能是空的），`cursor` 是点下去那一刻的鼠标位置 ——
/// 后者永远可信，所以矩形不合理时用它兜底。
pub fn show_popup(app: &AppHandle, rect: Rect, cursor: Option<PhysicalPosition<f64>>) {
    let win = match popup_window(app) {
        Ok(w) => w,
        Err(e) => {
            trace(format!("popup_window failed: {e}"));
            return;
        }
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        LAST_HIDE_MS.store(now_ms(), Ordering::SeqCst);
        return;
    }
    // 刚刚才因为失焦收起来（就是这一次点击造成的）：这次点击当作"关掉"
    if now_ms().saturating_sub(LAST_HIDE_MS.load(Ordering::SeqCst)) < 250 {
        return;
    }

    let scale = win.scale_factor().unwrap_or(1.0);
    let (ix, iy) = match rect.position {
        Position::Physical(p) => (p.x as f64, p.y as f64),
        Position::Logical(p) => (p.x * scale, p.y * scale),
    };
    let (iw, ih) = match rect.size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width * scale, s.height * scale),
    };
    // 图标矩形可能是 0 尺寸、也可能在屏幕外（图标被收进溢出面板时就这样）
    let anchor = if iw >= 4.0 && ih >= 4.0 && ix > -1000.0 && iy > -1000.0 {
        (ix, iy, iw, ih)
    } else if let Some(c) = cursor {
        trace(format!("icon rect unusable, fall back to cursor {c:?}"));
        (c.x, c.y, 0.0, 0.0)
    } else {
        (ix, iy, iw.max(0.0), ih.max(0.0))
    };

    let pw = POPUP_W * scale;
    let ph = POPUP_H * scale;
    let gap = POPUP_GAP * scale;
    // 右边对齐图标，向上弹；任务栏在屏幕上方时改成向下弹
    let mut left = anchor.0 + anchor.2 - pw;
    let mut top = anchor.1 - ph - gap;
    if top < 0.0 {
        top = anchor.1 + anchor.3 + gap;
    }
    // 不管图标矩形对不对劲，最后都夹回显示器里：宁可位置差一点，不能看不见
    if let Ok(Some(mon)) = win.current_monitor().or_else(|_| win.primary_monitor()) {
        let s = mon.size();
        let max_left = (s.width as f64 - pw).max(0.0);
        let max_top = (s.height as f64 - ph).max(0.0);
        left = left.min(max_left);
        top = top.min(max_top);
    }
    let left = left.max(0.0);
    let top = top.max(0.0);
    trace(format!("show popup at {left},{top} (anchor {anchor:?}, scale {scale})"));

    if let Err(e) = win.set_position(PhysicalPosition::<f64>::new(left, top)) {
        trace(format!("set_position failed: {e}"));
    }
    if let Err(e) = win.show() {
        trace(format!("show failed: {e}"));
    }
    // 拿不到焦点也不影响点菜单（always_on_top 已经保证它在最前面）
    let _ = win.set_focus();
    // 弹窗可能一直开着：每次显示都让它重新读一遍当前状态（监控开关 / 主题）
    let _ = app.emit("tray-shown", ());
}

pub fn hide_popup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("tray") {
        let _ = w.hide();
    }
}

/// 切换监控开关（托盘弹窗的入口；和前端 set_monitoring 命令共享同一份状态）。
pub fn toggle_monitoring(app: &AppHandle) -> bool {
    let state = app.state::<crate::AppState>();
    let next = !state.monitoring.load(Ordering::SeqCst);
    state.monitoring.store(next, Ordering::SeqCst);
    crate::update_settings(app, |s| s.monitoring = next);
    let _ = app.emit("monitor-changed", next);
    refresh(app, next);
    next
}

/// 更新托盘图标（蓝/灰）与 tooltip。
pub fn refresh(app: &AppHandle, on: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(img) = make_icon(on) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(tooltip(on)));
    }
}