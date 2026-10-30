//! 单文件存储：note.json + images/ + 原子写。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn ensure_dirs(dir: &Path) {
    let _ = fs::create_dir_all(dir.join("images"));
}

fn doc_path(dir: &Path) -> PathBuf {
    dir.join("note.json")
}

fn bak_path(dir: &Path) -> PathBuf {
    dir.join("note.json.bak")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 读取：note.json 坏掉时退回 .bak，两份都坏就把损坏文件改名留档（绝不静默覆盖）。
pub fn load(dir: &Path) -> (Value, Vec<Value>) {
    for p in [doc_path(dir), bak_path(dir)] {
        if !p.exists() {
            continue;
        }
        let raw = match fs::read_to_string(&p) {
            Ok(s) => s,
            Err(_) => continue,
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(v) => {
                let doc = v.get("doc").cloned().unwrap_or(Value::Null);
                let pending = v
                    .get("pending")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default();
                if !doc.is_null() {
                    return (doc, pending);
                }
            }
            Err(_) => {
                let keep = dir.join(format!("note.corrupt-{}.json", now_ms()));
                let _ = fs::rename(&p, keep);
            }
        }
    }
    (Value::Null, Vec::new())
}

pub fn save_doc(dir: &Path, doc: Value) -> Result<(), String> {
    // pending 目前恒为空，但要原样保留（为"关闭即销毁 WebView"预留）
    let pending = fs::read_to_string(doc_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("pending").cloned())
        .unwrap_or_else(|| json!([]));

    let payload = json!({
        "version": 1,
        "savedAt": now_ms(),
        "doc": doc,
        "pending": pending,
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    atomic_write(&doc_path(dir), &bytes, Some(&bak_path(dir)))
}

/// tmp → fsync → 备份旧版 → rename 覆盖。
pub fn atomic_write(path: &Path, bytes: &[u8], bak: Option<&Path>) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("写入失败: {e}"))?;
        f.sync_all().map_err(|e| format!("落盘失败: {e}"))?;
    }
    if let Some(b) = bak {
        if path.exists() {
            let _ = fs::copy(path, b);
        }
    }
    // Windows 上映射到 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，可原地替换
    fs::rename(&tmp, path).map_err(|e| format!("替换失败: {e}"))
}

/// 落盘一张图片，返回 (相对路径, hash, 宽, 高)。按内容寻址，重复图片只占一份。
pub fn save_image(dir: &Path, bytes: &[u8]) -> Result<(String, String, u32, u32), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let (w, h) = (img.width(), img.height());

    // 统一转成 PNG（CF_DIB 那条路进来的是 BMP）
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;

    let hash = sha256_hex(&png);
    let sub = dir.join("images").join(&hash[0..2]).join(&hash[2..4]);
    fs::create_dir_all(&sub).map_err(|e| format!("建目录失败: {e}"))?;
    let file = sub.join(format!("{hash}.png"));
    if !file.exists() {
        atomic_write(&file, &png, None)?;
    }
    let rel = format!("images/{}/{}/{}.png", &hash[0..2], &hash[2..4], hash);
    Ok((rel, hash, w, h))
}