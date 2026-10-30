//! 多笔记存储：notes/<id>.json + 图片内容寻址 + 原子写。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn ensure_dirs(dir: &Path) {
    let _ = fs::create_dir_all(dir.join("notes"));
    let _ = fs::create_dir_all(dir.join("images"));
}

fn notes_dir(dir: &Path) -> PathBuf {
    dir.join("notes")
}

fn note_path(dir: &Path, id: &str) -> PathBuf {
    notes_dir(dir).join(format!("{id}.json"))
}

/// 只允许字母数字下划线连字符，挡住 "../.." 这类路径穿越。
fn safe_id(id: &str) -> Option<&str> {
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    if id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Some(id)
    } else {
        None
    }
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    // 加一个自增序号：同一毫秒内连点两次"新建笔记"也不会撞 id
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    format!("n{}_{:04x}{:02x}", now_ms(), (nanos ^ (now_ms() as u32)) & 0xffff, seq & 0xff)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteFull {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub doc: Value,
    pub pending: Vec<Value>,
}

pub fn empty_doc() -> Value {
    json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
}

fn read_note(path: &Path) -> Option<(NoteMeta, Value, Vec<Value>, bool)> {
    let raw = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let id = v.get("id")?.as_str()?.to_string();
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("无标题笔记")
        .to_string();
    let created_at = v.get("createdAt").and_then(|t| t.as_i64()).unwrap_or(0);
    let updated_at = v.get("updatedAt").and_then(|t| t.as_i64()).unwrap_or(created_at);
    let doc = v.get("doc").cloned().unwrap_or_else(empty_doc);
    let pending = v
        .get("pending")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let title_locked = v
        .get("titleLocked")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    Some((
        NoteMeta {
            id,
            title,
            created_at,
            updated_at,
        },
        doc,
        pending,
        title_locked,
    ))
}

/// 扫描 notes/ 得到列表（按最近更新倒序）。不维护索引文件，避免索引与真实文件不同步。
pub fn list(dir: &Path) -> Vec<NoteMeta> {
    let d = notes_dir(dir);
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&d) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some((meta, _, _, _)) = read_note(&p) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn create(dir: &Path, title: &str) -> Result<NoteFull, String> {
    let id = new_id();
    let now = now_ms();
    let doc = empty_doc();
    let payload = json!({
        "version": 1,
        "id": id,
        "title": title,
        "titleLocked": false,
        "createdAt": now,
        "updatedAt": now,
        "doc": doc,
        "pending": [],
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    atomic_write(&note_path(dir, &id), &bytes, None)?;
    Ok(NoteFull {
        id,
        title: title.to_string(),
        created_at: now,
        updated_at: now,
        doc,
        pending: vec![],
    })
}

pub fn load(dir: &Path, id: &str) -> Result<NoteFull, String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let (meta, doc, pending, _) =
        read_note(&note_path(dir, id)).ok_or_else(|| "笔记不存在或已损坏".to_string())?;
    Ok(NoteFull {
        id: meta.id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        doc,
        pending,
    })
}

pub fn save(dir: &Path, id: &str, doc: Value) -> Result<NoteMeta, String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?.to_string();
    let path = note_path(dir, &id);
    let (meta, _, pending, locked) = read_note(&path).unwrap_or((
        NoteMeta {
            id: id.clone(),
            title: "无标题笔记".into(),
            created_at: now_ms(),
            updated_at: now_ms(),
        },
        empty_doc(),
        vec![],
        false,
    ));

    // 用户手动改过标题就不再自动推导，否则每次保存都会把名字冲掉
    let title = if locked {
        meta.title.clone()
    } else {
        derive_title(&doc)
    };
    let now = now_ms();
    let payload = json!({
        "version": 1,
        "id": id,
        "title": title,
        "titleLocked": locked,
        "createdAt": meta.created_at,
        "updatedAt": now,
        "doc": doc,
        "pending": pending,   // 为"关闭即销毁 WebView"预留
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    atomic_write(
        &path,
        &bytes,
        Some(&dir.join("notes").join(format!("{id}.json.bak"))),
    )?;
    Ok(NoteMeta {
        id,
        title,
        created_at: meta.created_at,
        updated_at: now,
    })
}

/// 手动重命名。标题一旦手动改过就锁定，后续保存不再按正文覆盖。
pub fn rename(dir: &Path, id: &str, title: &str) -> Result<NoteMeta, String> {
    let id = safe_id(id)
        .ok_or_else(|| "非法的笔记 id".to_string())?
        .to_string();
    let path = note_path(dir, &id);
    let (meta, doc, pending, _) = read_note(&path).ok_or_else(|| "笔记不存在".to_string())?;

    let trimmed = title.trim();
    let title = if trimmed.is_empty() {
        meta.title.clone()
    } else {
        trimmed.chars().take(80).collect::<String>()
    };

    let payload = json!({
        "version": 1,
        "id": id,
        "title": title,
        "titleLocked": true,
        "createdAt": meta.created_at,
        "updatedAt": meta.updated_at,   // 改名不是编辑，不改变排序
        "doc": doc,
        "pending": pending,
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes, None)?;
    Ok(NoteMeta {
        id,
        title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
    })
}

/// 软删除：移到 notes/.trash/，不做真删（这里记的都是随手抄的东西，误删没法恢复）。
pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let path = note_path(dir, id);
    if !path.exists() {
        return Err("笔记不存在".into());
    }
    let trash = notes_dir(dir).join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("建回收目录失败: {e}"))?;
    let target = trash.join(format!("{}-{}.json", id, now_ms()));
    fs::rename(&path, &target).map_err(|e| format!("移入回收目录失败: {e}"))?;
    let _ = fs::remove_file(dir.join("notes").join(format!("{id}.json.bak")));
    Ok(())
}

/// 标题取文档里第一段非空文字，截 40 字；纯图片笔记给个占位名。
fn derive_title(doc: &Value) -> String {
    fn walk(node: &Value, out: &mut Option<String>) {
        if out.is_some() {
            return;
        }
        if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
            for child in arr {
                if out.is_some() {
                    return;
                }
                if child.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = child.get("text").and_then(|t| t.as_str()) {
                        let t = t.trim();
                        if !t.is_empty() {
                            *out = Some(t.replace(char::is_whitespace, " "));
                            return;
                        }
                    }
                }
                walk(child, out);
            }
        }
    }
    let mut found = None;
    walk(doc, &mut found);
    let t: String = found.unwrap_or_default().chars().take(40).collect();
    let t = t.trim().to_string();
    if t.is_empty() {
        "无标题笔记".into()
    } else {
        t
    }
}

/// 老版本单篇 note.json → 第一篇笔记（只跑一次，成功后把旧文件改名留档）。
pub fn migrate_legacy(dir: &Path) {
    let legacy = dir.join("note.json");
    if !legacy.exists() {
        return;
    }
    if fs::read_dir(notes_dir(dir))
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
    {
        return; // 已经有笔记了，不动它
    }
    let raw = match fs::read_to_string(&legacy) {
        Ok(s) => s,
        Err(_) => return,
    };
    let v: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let doc = v.get("doc").cloned().unwrap_or_else(empty_doc);
    if doc.is_null() {
        return;
    }
    let id = new_id();
    let now = now_ms();
    let payload = json!({
        "version": 1,
        "id": id,
        "title": derive_title(&doc),
        "createdAt": now,
        "updatedAt": now,
        "doc": doc,
        "pending": [],
    });
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        if atomic_write(&note_path(dir, &id), &bytes, None).is_ok() {
            let _ = fs::rename(&legacy, dir.join("note.json.migrated"));
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
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
    fs::rename(&tmp, path).map_err(|e| format!("替换失败: {e}"))
}

/// 落盘一张图片，返回 (相对路径, hash, 宽, 高)。按内容寻址，重复图片只占一份。
pub fn save_image(dir: &Path, bytes: &[u8]) -> Result<(String, String, u32, u32), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let (w, h) = (img.width(), img.height());

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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        // 测试是并发跑的，目录名必须唯一，否则会互相 remove_dir_all
        let p = std::env::temp_dir().join(format!(
            "c2g-test-{}-{}-{}",
            std::process::id(),
            now_ms(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&p).unwrap();
        ensure_dirs(&p);
        p
    }

    fn doc_with(text: &str) -> Value {
        json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
        })
    }

    #[test]
    fn 标题按正文推导() {
        let d = tmpdir();
        let n = create(&d, "无标题笔记").unwrap();
        let meta = save(&d, &n.id, doc_with("正文第一句")).unwrap();
        assert_eq!(meta.title, "正文第一句");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 手动改名后锁定_保存不再覆盖() {
        let d = tmpdir();
        let n = create(&d, "无标题笔记").unwrap();
        save(&d, &n.id, doc_with("原文")).unwrap();

        let meta = rename(&d, &n.id, "我起的名字").unwrap();
        assert_eq!(meta.title, "我起的名字");

        // 之后再保存正文，标题必须保住
        let meta = save(&d, &n.id, doc_with("完全不同的正文")).unwrap();
        assert_eq!(meta.title, "我起的名字");
        assert_eq!(load(&d, &n.id).unwrap().title, "我起的名字");

        // 而且改名不该改变排序用的 updatedAt
        assert_eq!(meta.updated_at, load(&d, &n.id).unwrap().updated_at);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 删除是移入回收目录而不是真删() {
        let d = tmpdir();
        let n = create(&d, "要删掉的").unwrap();
        assert_eq!(list(&d).len(), 1);

        delete(&d, &n.id).unwrap();

        assert_eq!(list(&d).len(), 0, "列表里不该再有它");
        assert!(load(&d, &n.id).is_err(), "不该还能打开");
        let trash = d.join("notes").join(".trash");
        assert!(trash.exists(), "回收目录应该被建出来");
        assert_eq!(
            fs::read_dir(&trash).unwrap().count(),
            1,
            "文件应该躺在回收目录里"
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 列表按最近更新倒序() {
        let d = tmpdir();
        let a = create(&d, "A").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = create(&d, "B").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        save(&d, &a.id, doc_with("改过 A")).unwrap();

        let l = list(&d);
        assert_eq!(l[0].id, a.id, "刚编辑过的排最前");
        assert_eq!(l[1].id, b.id);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 拒绝路径穿越的_id() {
        let d = tmpdir();
        assert!(load(&d, "../settings").is_err());
        assert!(load(&d, "..\\evil").is_err());
        assert!(delete(&d, "../../x").is_err());
        fs::remove_dir_all(&d).ok();
    }
}