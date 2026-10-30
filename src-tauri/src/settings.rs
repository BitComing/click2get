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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            monitoring: true,
            theme: "light".into(), // 默认浅色
            last_note_id: None,
            sidebar_collapsed: false,
        }
    }
}

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
            s
        })
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) {
    if let Ok(bytes) = serde_json::to_vec(s) {
        let _ = crate::storage::atomic_write(&path(dir), &bytes, None);
    }
}