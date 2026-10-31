//! 设置：监控开关 / 主题 / 上次打开的笔记。

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub monitoring: bool,
    /// "light" | "dark"
    pub theme: String,
    pub last_note_id: Option<String>,
    /// 侧栏是否收起（记住上次状态）
    pub sidebar_collapsed: bool,
    /// 侧栏宽度（px）：用户拖过就记住，下次打开还是这么宽
    pub sidebar_width: u32,
    /// 捕获去重：同一段文字 / 同一张图重复复制时，不再记第二遍。
    /// 真正比对在收录端（前端，只有它知道笔记正文），这里只存开关。
    pub dedupe: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            monitoring: true,
            theme: "light".into(), // 默认浅色
            last_note_id: None,
            sidebar_collapsed: false,
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
            dedupe: true,
        }
    }
}

pub const DEFAULT_SIDEBAR_WIDTH: u32 = 236;
/// 拖到多窄都还能看清标题；再宽就会把正文挤成一条缝。
pub const MIN_SIDEBAR_WIDTH: u32 = 170;
pub const MAX_SIDEBAR_WIDTH: u32 = 520;

fn path(dir: &Path) -> std::path::PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .map(|mut s| {
            if s.theme != "dark" {
                s.theme = "light".into();
            }
            // 手改坏了的 settings.json 不该让侧栏变成 0 宽或者占半屏
            s.sidebar_width = s
                .sidebar_width
                .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
            s
        })
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) {
    if let Ok(bytes) = serde_json::to_vec(s) {
        let _ = crate::storage::atomic_write(&path(dir), &bytes, None);
    }
}