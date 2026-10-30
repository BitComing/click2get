//! 极简设置：只存监控开关（重启后恢复上次状态）。

use std::path::Path;

use serde_json::{json, Value};

fn path(dir: &Path) -> std::path::PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> bool {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("monitoring").and_then(|x| x.as_bool()))
        .unwrap_or(true) // 首次启动默认开启
}

pub fn save(dir: &Path, monitoring: bool) {
    let payload = json!({ "monitoring": monitoring });
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        let _ = crate::storage::atomic_write(&path(dir), &bytes, None);
    }
}