//! 多笔记存储：notes/<id>.json + 图片内容寻址 + 原子写。

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
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
pub(crate) fn safe_id(id: &str) -> Option<&str> {
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
    /// 置顶：排序时永远排在最前面，与 updatedAt 无关
    #[serde(default)]
    pub pinned: bool,
    /// 所属目录（目录本身存在 folders.json，见 gallery.rs）；None = 未分类
    #[serde(default)]
    pub folder_id: Option<String>,
    /// 平铺预览页里的位置，越小越靠前。老笔记没有这个字段，按"创建时间倒序"顶替
    /// （见 gallery::view），所以升级不需要迁移一遍已有笔记。
    #[serde(default)]
    pub sort: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteFull {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: bool,
    pub folder_id: Option<String>,
    pub sort: Option<f64>,
    pub doc: Value,
    pub pending: Vec<Value>,
}

/// 引用某张图的笔记。图片库"按笔记"分组要按 id 归组，标题只用来显示。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageUser {
    pub id: String,
    pub title: String,
}

/// 图片库里的一张图。`used_by` 是引用它的笔记（同一篇只算一次）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub hash: String,
    /// 相对数据目录的路径，如 images/ab/cd/<hash>.png
    pub path: String,
    pub bytes: u64,
    /// 文件最后修改时间（毫秒），列表按它倒序
    pub created_at: i64,
    pub width: u32,
    pub height: u32,
    /// 这张图自己的备注（存在 images/ 里，见 set_image_note）
    pub note: String,
    pub used_by: Vec<ImageUser>,
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
    let pinned = v.get("pinned").and_then(|b| b.as_bool()).unwrap_or(false);
    let folder_id = v
        .get("folderId")
        .and_then(|f| f.as_str())
        .map(|s| s.to_string());
    let sort = v.get("sort").and_then(|s| s.as_f64());
    Some((
        NoteMeta {
            id,
            title,
            created_at,
            updated_at,
            pinned,
            folder_id,
            sort,
        },
        doc,
        pending,
        title_locked,
    ))
}

/// 读一篇笔记的原始 JSON（正文 / 标题 / 附带字段都在里面）。
pub(crate) fn read_note_file(dir: &Path, id: &str) -> Option<Value> {
    let id = safe_id(id)?;
    let raw = fs::read_to_string(note_path(dir, id)).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

/// 扫描 notes/ 得到列表（置顶最前，其余按最近更新倒序）。不维护索引文件，避免索引与真实文件不同步。
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
    sort_metas(&mut out);
    out
}

/// 侧栏排序：置顶的在最前，同组内按最近更新倒序。
///
/// 只有这一处定义"顺序"，前端拿到的列表就是最终顺序；
/// 前端本地插入/改名后也要按同一规则排一次（App.tsx 的 sortNotes）。
pub fn sort_metas(out: &mut [NoteMeta]) {
    out.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// 一条全局搜索结果。kind 是 "text"（正文/标题）或 "image"（图片备注）。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub snippet: String,
    pub count: usize,
    /// 图片备注命中时是那张图的 hash；正文/标题命中为 None
    pub hash: Option<String>,
}

/// 全局搜索：正文 + 图片备注，大小写不敏感（中文按子串）。
///
/// 备注归图片所有（`images/.../<hash>.json`），不埋在某一篇笔记的正文里：
/// 同一张图被两篇笔记引用时，两篇里都能命中它；一张没被任何笔记引用的图，
/// 备注也能搜到（点结果直接去图片库看）。
///
/// 不建索引：笔记和图片备注都是单个 JSON 文件，几十上百篇量级下逐篇读一遍足够快，
/// 也省掉了"索引和真实文件不同步"这类只有搜索才会暴露的坑。
pub fn search(dir: &Path, query: &str) -> Vec<SearchHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let needle = q.to_lowercase();
    let remarks = read_all_image_notes(dir);
    let mut referenced: HashSet<String> = HashSet::new();
    let mut out = Vec::new();

    // list() 已按最近更新倒序，搜索结果沿用这个顺序
    for meta in list(dir) {
        let Ok(raw) = fs::read_to_string(note_path(dir, &meta.id)) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let doc = v.get("doc").cloned().unwrap_or_else(empty_doc);

        let mut body = String::new();
        doc_text(&doc, &mut body);
        let body_lower = body.to_lowercase();
        let title_lower = meta.title.to_lowercase();

        // 正文优先；正文里没有再看手动改过的标题（标题不一定出现在正文里）
        let text_hit = if body_lower.contains(&needle) {
            Some((
                snippet(&body, &needle),
                body_lower.matches(&needle).count(),
            ))
        } else if title_lower.contains(&needle) {
            Some((format!("标题：{}", collapse_ws(&meta.title)), 1))
        } else {
            None
        };
        if let Some((snippet, count)) = text_hit {
            out.push(SearchHit {
                id: meta.id.clone(),
                title: meta.title.clone(),
                kind: "text".into(),
                snippet,
                count,
                hash: None,
            });
        }

        // 一篇笔记里可能有好几张图都命中：一条备注一条结果，点哪条就选哪张图
        let mut hashes: Vec<String> = {
            let mut set = HashSet::new();
            collect_hashes(&doc, &mut set);
            set.into_iter().collect()
        };
        hashes.sort();
        for hash in hashes {
            referenced.insert(hash.clone());
            let Some(note) = remarks.get(&hash) else {
                continue;
            };
            let note_lower = note.to_lowercase();
            if !note_lower.contains(&needle) {
                continue;
            }
            out.push(SearchHit {
                id: meta.id.clone(),
                title: meta.title.clone(),
                kind: "image".into(),
                snippet: snippet(note, &needle),
                count: note_lower.matches(&needle).count(),
                hash: Some(hash),
            });
        }
    }

    // 没被任何笔记引用的图：备注也得能搜到，id 留空，前端据此打开图片库
    let mut orphans: Vec<(&String, &String)> = remarks
        .iter()
        .filter(|(h, _)| !referenced.contains(*h))
        .collect();
    orphans.sort_by(|a, b| a.0.cmp(b.0));
    for (hash, note) in orphans {
        let note_lower = note.to_lowercase();
        if !note_lower.contains(&needle) {
            continue;
        }
        out.push(SearchHit {
            id: String::new(),
            title: "图片（未被笔记引用）".into(),
            kind: "image".into(),
            snippet: snippet(note, &needle),
            count: note_lower.matches(&needle).count(),
            hash: Some(hash.clone()),
        });
    }
    out
}

/// 把文档里的文字节点拼起来（每块后补一个换行，免得多段粘成一个词）。
fn doc_text(v: &Value, out: &mut String) {
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    // 硬换行（复制进来的多行就是这个）也要断开，否则搜索时两行会被拼成一个词
    if kind == "hardBreak" {
        out.push('\n');
        return;
    }
    if kind == "text" {
        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
            out.push_str(t);
        }
        return;
    }
    if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
        for child in arr {
            doc_text(child, out);
            out.push('\n');
        }
    }
}

/// 所有"有备注"的图：hash → 备注。搜索和迁移共用。
fn read_all_image_notes(dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut files = Vec::new();
    walk_png(&images_dir(dir), &mut files);
    for p in files {
        let Some(hash) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let note = read_image_note(dir, hash);
        if !note.trim().is_empty() {
            out.insert(hash.to_string(), note);
        }
    }
    out
}

/// 命中处前后各留一点上下文，压成一行。needle 必须是已经小写化的查询串。
fn snippet(text: &str, needle: &str) -> String {
    const BEFORE: usize = 24;
    const AFTER: usize = 48;
    let lower = text.to_lowercase();
    let Some(byte_at) = lower.find(needle) else {
        return collapse_ws(&text.chars().take(BEFORE + AFTER).collect::<String>());
    };
    // lower 的字节下标换算成原文的字符下标：中文/ASCII 一一对应，
    // 极少数小写化会改字符数的语言（如土耳其语 İ）最多截偏一两个字，不影响阅读
    let char_at = lower[..byte_at].chars().count();
    let needle_chars = needle.chars().count();
    let total = text.chars().count();
    let start = char_at.saturating_sub(BEFORE);
    let end = (char_at + needle_chars + AFTER).min(total);

    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    s.extend(text.chars().skip(start).take(end - start));
    if end < total {
        s.push('…');
    }
    collapse_ws(&s)
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 落一篇新笔记。`title_locked` 为 true 时后续保存不会再按正文改写标题。
fn write_new_note(
    dir: &Path,
    title: &str,
    doc: Value,
    title_locked: bool,
) -> Result<NoteFull, String> {
    let id = new_id();
    let now = now_ms();
    // 新建的笔记排在"未分类"最前面：sort 用负数时间戳，越新越小
    let sort = -(now as f64);
    let payload = json!({
        "version": 1,
        "id": id,
        "title": title,
        "titleLocked": title_locked,
        "createdAt": now,
        "updatedAt": now,
        "pinned": false,
        "folderId": Value::Null,
        "sort": sort,
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
        pinned: false,
        folder_id: None,
        sort: Some(sort),
        doc,
        pending: vec![],
    })
}

pub fn create(dir: &Path, title: &str) -> Result<NoteFull, String> {
    write_new_note(dir, title, empty_doc(), false)
}

/// 用图片库里的若干张图拼一篇新笔记：一张图一行（段落里放一个行内图片节点）。
/// hash 非法或图片已经不在的，直接跳过。
pub fn create_from_images(dir: &Path, hashes: &[String]) -> Result<NoteFull, String> {
    let mut content = Vec::new();
    for h in hashes {
        if !is_image_hash(h) {
            continue;
        }
        let path = images_dir(dir)
            .join(&h[0..2])
            .join(&h[2..4])
            .join(format!("{h}.png"));
        if !path.exists() {
            continue;
        }
        let (w, ht) = png_size(&path).unwrap_or((0, 0));
        content.push(image_line(
            &format!("images/{}/{}/{}.png", &h[0..2], &h[2..4], h),
            h,
            Some(w),
            Some(ht),
        ));
    }
    if content.is_empty() {
        return Err("选中的图片都已经不在了".into());
    }
    let n = content.len();
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "captureBlock",
            "attrs": { "ts": now_ms() },
            "content": content,
        }]
    });
    // 纯图片的笔记推导不出标题，直接锁死一个，免得下次保存被改成"无标题笔记"
    write_new_note(dir, &format!("图片笔记 · {n} 张"), doc, true)
}

/// 一行图片：图片是行内节点，所以一定包在段落里（前端要在图片前后停光标）。
fn image_line(path: &str, hash: &str, w: Option<u32>, h: Option<u32>) -> Value {
    json!({
        "type": "paragraph",
        "content": [{
            "type": "image",
            "attrs": {
                "path": path,
                "hash": hash,
                "w": w,
                "h": h,
                "width": null,
                "alt": "",
                "title": null,
            }
        }]
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
        pinned: meta.pinned,
        folder_id: meta.folder_id,
        sort: meta.sort,
        doc,
        pending,
    })
}

pub fn save(dir: &Path, id: &str, doc: Value) -> Result<NoteMeta, String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?.to_string();
    let path = note_path(dir, &id);
    let existing = read_note(&path);

    // 内容一个字没变就不算"编辑"：不碰 updatedAt，也不重写文件。
    // 否则切笔记 / 退出前的兜底保存会把没改过的笔记顶到列表最前面，
    // 侧栏顺序就会在用户眼前跳来跳去。
    if let Some((meta, stored_doc, _, _)) = existing.as_ref() {
        if *stored_doc == doc {
            return Ok(meta.clone());
        }
    }

    let (meta, _, pending, locked) = existing.unwrap_or((
        NoteMeta {
            id: id.clone(),
            title: "无标题笔记".into(),
            created_at: now_ms(),
            updated_at: now_ms(),
            pinned: false,
            folder_id: None,
            sort: None,
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
        "pinned": meta.pinned,
        // 归类和排序不归"编辑"管：保存正文时原样带回去，否则每次打字都会把笔记
        // 从目录里掉出来、或者位置被重置
        "folderId": meta.folder_id,
        "sort": meta.sort,
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
        pinned: meta.pinned,
        folder_id: meta.folder_id,
        sort: meta.sort,
    })
}

/// 只改笔记的附加字段（folderId / sort），正文、标题、updatedAt 一个字都不动。
///
/// 平铺预览页里的"挪目录 / 拖动排序"走这里：整理归类不是编辑内容，
/// 不该让笔记在侧栏里被顶到最前面，也不该触发标题重新推导。
pub fn patch_note<F: FnOnce(&mut Value)>(dir: &Path, id: &str, f: F) -> Result<(), String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let mut v = read_note_file(dir, id).ok_or_else(|| "笔记不存在".to_string())?;
    if !v.is_object() {
        return Err("笔记结构异常".into());
    }
    f(&mut v);
    let bytes = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
    atomic_write(&note_path(dir, id), &bytes, None)
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
        "pinned": meta.pinned,
        "folderId": meta.folder_id,
        "sort": meta.sort,
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
        pinned: meta.pinned,
        folder_id: meta.folder_id,
        sort: meta.sort,
    })
}

/// 置顶 / 取消置顶。
///
/// 只改 pinned，不碰 updatedAt —— 置顶是"分类"，不是"编辑"，
/// 否则每次置顶都会把这篇笔记顶到非置顶区的最前面，看着像内容变了。
pub fn set_pinned(dir: &Path, id: &str, pinned: bool) -> Result<NoteMeta, String> {
    let id = safe_id(id)
        .ok_or_else(|| "非法的笔记 id".to_string())?
        .to_string();
    let path = note_path(dir, &id);
    let (meta, doc, pending, locked) = read_note(&path).ok_or_else(|| "笔记不存在".to_string())?;

    if meta.pinned == pinned {
        return Ok(meta);
    }

    let payload = json!({
        "version": 1,
        "id": id,
        "title": meta.title,
        "titleLocked": locked,
        "createdAt": meta.created_at,
        "updatedAt": meta.updated_at,
        "pinned": pinned,
        "folderId": meta.folder_id,
        "sort": meta.sort,
        "doc": doc,
        "pending": pending,
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes, None)?;
    Ok(NoteMeta {
        id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        pinned,
        folder_id: meta.folder_id,
        sort: meta.sort,
    })
}

/// 把一张图追加到指定笔记末尾（长按把图从一篇笔记拖到另一篇时用）。
///
/// 走一遍 save()，标题推导 / updatedAt / .bak 兜底都和普通编辑一致；
/// 图片文件本身是内容寻址的，两篇笔记引用同一张图不会产生副本。
pub fn append_image(
    dir: &Path,
    id: &str,
    path: &str,
    hash: &str,
    w: Option<u32>,
    h: Option<u32>,
) -> Result<NoteMeta, String> {
    if !is_image_hash(hash) {
        return Err("非法的图片 id".into());
    }
    if !image_file(dir, hash).exists() {
        return Err("图片文件不存在".into());
    }
    let rel = if path.is_empty() {
        format!("images/{}/{}/{}.png", &hash[0..2], &hash[2..4], hash)
    } else {
        path.to_string()
    };
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let (meta, mut doc, _, _) =
        read_note(&note_path(dir, id)).ok_or_else(|| "笔记不存在".to_string())?;

    let block = json!({
        "type": "captureBlock",
        "attrs": { "ts": now_ms() },
        "content": [image_line(&rel, hash, w, h)]
    });

    // doc.content 是 block+，缺了就先补一个空数组（损坏的笔记也不至于丢掉图）
    let content = doc
        .get_mut("content")
        .and_then(|c| c.as_array_mut())
        .ok_or_else(|| "笔记结构异常".to_string())?;
    content.push(block);

    save(dir, &meta.id, doc)
}

/// 把若干"块"追加到指定笔记末尾（长按把选中的几行拖到另一篇笔记时用）。
///
/// 只做追加这一件事，标题推导 / updatedAt / .bak 兜底仍然走 save()，
/// 和普通编辑完全一致。块是前端从 TipTap 文档里整行切出来的，
/// 这里只挡掉明显不是节点的东西（没有 type 的对象）。
pub fn append_blocks(dir: &Path, id: &str, blocks: Value) -> Result<NoteMeta, String> {
    let list = blocks.as_array().ok_or_else(|| "内容格式不对".to_string())?;
    let mut add: Vec<Value> = Vec::new();
    for b in list {
        if b.is_object() && b.get("type").and_then(|t| t.as_str()).is_some() {
            add.push(b.clone());
        }
    }
    if add.is_empty() {
        return Err("没有可移动的内容".into());
    }

    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let (meta, mut doc, _, _) =
        read_note(&note_path(dir, id)).ok_or_else(|| "笔记不存在".to_string())?;
    let content = doc
        .get_mut("content")
        .and_then(|c| c.as_array_mut())
        .ok_or_else(|| "笔记结构异常".to_string())?;
    content.extend(add);

    save(dir, &meta.id, doc)
}

/// 批量删除（侧栏多选删除）：逐个软删除，跳过不存在的，返回真正删掉的篇数。
pub fn delete_many(dir: &Path, ids: &[String]) -> usize {
    let mut moved = 0;
    for id in ids {
        if delete(dir, id).is_ok() {
            moved += 1;
        }
    }
    moved
}

/// 这篇笔记是不是"空的"：没有文字、没有图片、也没有分割线。
///
/// 空段落、空捕获块都算空 —— 新建了没写、或者写完又全删掉的笔记就是这种。
/// 删除时靠它跳过确认、直接删文件（见 delete）。
pub fn is_blank(dir: &Path, id: &str) -> bool {
    let Some(id) = safe_id(id) else {
        return false;
    };
    match read_note(&note_path(dir, id)) {
        Some((_, doc, _, _)) => doc_is_blank(&doc),
        None => false,
    }
}

/// 文档里还有没有任何"用户写上去的东西"。图片、分割线都算内容。
fn doc_is_blank(node: &Value) -> bool {
    if let Some(kind) = node.get("type").and_then(|t| t.as_str()) {
        match kind {
            "text" => {
                let text = node.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if !text.trim().is_empty() {
                    return false;
                }
            }
            // 图片 / 分割线是用户明确放上去的，不算空
            "image" | "horizontalRule" => return false,
            _ => {}
        }
    }
    match node.get("content").and_then(|c| c.as_array()) {
        Some(children) => children.iter().all(doc_is_blank),
        None => true,
    }
}

/// 软删除：移到 notes/.trash/，不做真删（这里记的都是随手抄的东西，误删没法恢复）。
///
/// 例外：**空白笔记**没有保留价值，直接删文件，连回收站都不进。
/// 那种笔记就是"点了个新建、什么都没写"留下的空壳，攒多了只会让人在回收站里翻垃圾。
pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let path = note_path(dir, id);
    if !path.exists() {
        return Err("笔记不存在".into());
    }
    if is_blank(dir, id) {
        return purge(dir, id);
    }
    let trash = notes_dir(dir).join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("建回收目录失败: {e}"))?;
    let target = trash.join(format!("{}-{}.json", id, now_ms()));
    fs::rename(&path, &target).map_err(|e| format!("移入回收目录失败: {e}"))?;
    let _ = fs::remove_file(dir.join("notes").join(format!("{id}.json.bak")));
    Ok(())
}

/// 真删除：直接从磁盘删掉笔记文件（连 .bak 一起），不进回收目录。
/// 侧栏删除是软删除（挪进 notes/.trash），只有图片库里"删除笔记"走这里 ——
/// 那边是按笔记整理图片的场景，留着回收站只会让人以为没删干净。
pub fn purge(dir: &Path, id: &str) -> Result<(), String> {
    let id = safe_id(id).ok_or_else(|| "非法的笔记 id".to_string())?;
    let path = note_path(dir, id);
    if !path.exists() {
        return Err("笔记不存在".into());
    }
    fs::remove_file(&path).map_err(|e| format!("删除笔记失败: {e}"))?;
    let _ = fs::remove_file(dir.join("notes").join(format!("{id}.json.bak")));
    let _ = fs::remove_file(dir.join("notes").join(format!("{id}.json.tmp")));
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
        "folderId": Value::Null,
        "sort": -(now as f64),
        "doc": doc,
        "pending": [],
    });
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        if atomic_write(&note_path(dir, &id), &bytes, None).is_ok() {
            let _ = fs::rename(&legacy, dir.join("note.json.migrated"));
        }
    }
}

/// 把旧版"图片备注存在图片节点 attrs.note 里"的数据搬到图片自己的 sidecar，
/// 再从笔记 JSON 里摘掉 note 字段。备注从此属于图片，图片库一处管理。
///
/// 幂等：跑完之后笔记里没有 note 字段，再跑什么也不做。
/// 只在图片文件真的存在时才搬 —— 图没了（被删进回收站）就原样留着，不丢文字。
pub fn migrate_image_notes(dir: &Path) {
    let Ok(entries) = fs::read_dir(notes_dir(dir)) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&p) else {
            continue;
        };
        let Ok(mut v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(doc) = v.get_mut("doc") else {
            continue;
        };
        let mut changed = false;
        take_legacy_image_notes(dir, doc, &mut changed);
        if !changed {
            continue;
        }
        let Ok(bytes) = serde_json::to_vec(&v) else {
            continue;
        };
        let bak = p.with_extension("json.bak");
        let _ = atomic_write(&p, &bytes, Some(&bak));
    }
}

/// 递归把 attrs.note 搬进 sidecar 并删掉这个字段。
fn take_legacy_image_notes(dir: &Path, v: &mut Value, changed: &mut bool) {
    if v.get("type").and_then(|t| t.as_str()) == Some("image") {
        let hash = v
            .get("attrs")
            .and_then(|a| a.get("hash"))
            .and_then(|h| h.as_str())
            .map(|s| s.to_string());
        let legacy = v
            .get("attrs")
            .and_then(|a| a.get("note"))
            .and_then(|n| n.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        let mut moved = false;
        if let Some(hash) = hash {
            if !legacy.is_empty() && is_image_hash(&hash) && image_file(dir, &hash).exists() {
                let existing = read_image_note(dir, &hash);
                if existing.trim().is_empty() {
                    moved = set_image_note(dir, &hash, &legacy).is_ok();
                } else if !existing.contains(&legacy) {
                    // 同一张图在两篇笔记里各有一句备注：合并，别丢
                    let merged = format!("{}\n{}", existing.trim_end(), legacy);
                    moved = set_image_note(dir, &hash, &merged).is_ok();
                } else {
                    moved = true;
                }
            }
        }
        if moved {
            if let Some(attrs) = v.get_mut("attrs").and_then(|a| a.as_object_mut()) {
                attrs.remove("note");
                *changed = true;
            }
        }
    }
    if let Some(arr) = v.get_mut("content").and_then(|c| c.as_array_mut()) {
        for child in arr {
            take_legacy_image_notes(dir, child, changed);
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

fn images_dir(dir: &Path) -> PathBuf {
    dir.join("images")
}

/// 只认内容寻址的文件名：64 位小写十六进制。删除走这里，挡住 "../" 之类的路径。
pub(crate) fn is_image_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// hash → 图片的绝对路径。调用方必须先确认 hash 合法。
pub(crate) fn image_file(dir: &Path, hash: &str) -> PathBuf {
    images_dir(dir)
        .join(&hash[0..2])
        .join(&hash[2..4])
        .join(format!("{hash}.png"))
}

/// 图片备注跟着图片走：和 png 放在一起、同样按 hash 命名。
/// 这样备注属于"这张图"，而不是"某篇笔记里的这一次引用"；图片被删/挪时会一起处理。
fn image_note_path(dir: &Path, hash: &str) -> PathBuf {
    images_dir(dir)
        .join(&hash[0..2])
        .join(&hash[2..4])
        .join(format!("{hash}.json"))
}

/// 读一张图的备注；没有就返回空串（不是错误 —— 大多数图都没备注）。
pub fn read_image_note(dir: &Path, hash: &str) -> String {
    if !is_image_hash(hash) {
        return String::new();
    }
    let Ok(raw) = fs::read_to_string(image_note_path(dir, hash)) else {
        return String::new();
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v.get("note").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .unwrap_or_default()
}

/// 写一张图的备注。空备注 = 删掉 sidecar（图片库里不留一堆空文件）。
pub fn set_image_note(dir: &Path, hash: &str, note: &str) -> Result<(), String> {
    if !is_image_hash(hash) {
        return Err("非法的图片 id".into());
    }
    if !image_file(dir, hash).exists() {
        return Err("图片文件不存在".into());
    }
    let path = image_note_path(dir, hash);
    let text = note.trim();
    if text.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let payload = json!({
        "version": 1,
        "note": text,
        "updatedAt": now_ms(),
    });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes, None)
}

/// 从 PNG 头里读宽高，不解码整张图（图片库可能有几百张）。
fn png_size(path: &Path) -> Option<(u32, u32)> {
    let mut head = [0u8; 24];
    File::open(path).ok()?.read_exact(&mut head).ok()?;
    if &head[0..8] != b"\x89PNG\r\n\x1a\n" || &head[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let h = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    Some((w, h))
}

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 递归收集 images/ 下的 png，跳过回收站。
fn walk_png(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().and_then(|n| n.to_str()) == Some(".trash") {
                continue;
            }
            walk_png(&p, out);
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("png"))
            .unwrap_or(false)
        {
            out.push(p);
        }
    }
}

/// 把笔记里所有 image 节点的 hash 收集到 set（递归整棵 doc）。
fn collect_hashes(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::Object(map) => {
            if let Some(h) = map.get("hash").and_then(|h| h.as_str()) {
                if is_image_hash(h) {
                    out.insert(h.to_string());
                }
            }
            for (_, child) in map {
                collect_hashes(child, out);
            }
        }
        Value::Array(arr) => {
            for child in arr {
                collect_hashes(child, out);
            }
        }
        _ => {}
    }
}

/// hash → 引用它的笔记列表。只在打开图片库时扫一遍，不进索引。
fn image_usage(dir: &Path) -> HashMap<String, Vec<ImageUser>> {
    let mut usage: HashMap<String, Vec<ImageUser>> = HashMap::new();
    let Ok(entries) = fs::read_dir(notes_dir(dir)) else {
        return usage;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(id) = v.get("id").and_then(|t| t.as_str()).map(|s| s.to_string()) else {
            continue;
        };
        let title = v
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("无标题笔记")
            .to_string();
        let mut hashes = HashSet::new();
        collect_hashes(&v, &mut hashes);
        for h in hashes {
            let users = usage.entry(h).or_default();
            // 同一篇笔记里同一张图可能出现多次，只记一条
            if users.iter().any(|u| u.id == id) {
                continue;
            }
            users.push(ImageUser {
                id: id.clone(),
                title: title.clone(),
            });
        }
    }
    for users in usage.values_mut() {
        users.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));
    }
    usage
}

/// 图片库：列出 images/ 下所有内容寻址的图片，按修改时间倒序。
pub fn list_images(dir: &Path) -> Vec<ImageMeta> {
    let usage = image_usage(dir);
    let mut files = Vec::new();
    walk_png(&images_dir(dir), &mut files);

    let mut out: Vec<ImageMeta> = files
        .into_iter()
        .filter_map(|p| {
            let hash = p.file_stem()?.to_str()?.to_string();
            if !is_image_hash(&hash) {
                return None;
            }
            let rel = p
                .strip_prefix(dir)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .ok()?;
            let (width, height) = png_size(&p).unwrap_or((0, 0));
            Some(ImageMeta {
                used_by: usage.get(&hash).cloned().unwrap_or_default(),
                note: read_image_note(dir, &hash),
                hash,
                path: rel,
                bytes: fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
                created_at: modified_ms(&p),
                width,
                height,
            })
        })
        .collect();

    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.hash.cmp(&b.hash)));
    out
}

/// 图片库删图的结果：移走了几张 + 哪几篇笔记的正文被动过（前端据此刷新当前笔记）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteImagesResult {
    pub moved: usize,
    pub touched: Vec<String>,
}

/// 多选删除：移进 images/.trash/，和笔记一样不做真删。
///
/// 图都被删了，笔记正文里还留着它只会是一块加载不出来的破图 ——
/// 所以顺手把这些图片节点从所有笔记里摘掉（见 strip_images_from_notes）。
/// 返回真正移走的张数，以及正文被改过的笔记 id。
pub fn delete_images(dir: &Path, hashes: &[String]) -> Result<DeleteImagesResult, String> {
    let trash = images_dir(dir).join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("建图片回收目录失败: {e}"))?;

    let mut moved = 0;
    let mut gone: HashSet<String> = HashSet::new();
    for h in hashes {
        if !is_image_hash(h) {
            continue;
        }
        let path = images_dir(dir)
            .join(&h[0..2])
            .join(&h[2..4])
            .join(format!("{h}.png"));
        if !path.exists() {
            continue;
        }
        let mut target = trash.join(format!("{h}.png"));
        if target.exists() {
            target = trash.join(format!("{}-{}.png", h, now_ms()));
        }
        fs::rename(&path, &target).map_err(|e| format!("移入图片回收目录失败: {e}"))?;
        // 备注跟着图一起进回收站，免得图回来时备注丢了
        let note = image_note_path(dir, h);
        if note.exists() {
            let mut note_target = trash.join(format!("{h}.json"));
            if note_target.exists() {
                note_target = trash.join(format!("{}-{}.json", h, now_ms()));
            }
            let _ = fs::rename(&note, &note_target);
        }
        gone.insert(h.clone());
        moved += 1;
    }

    let touched = if gone.is_empty() {
        Vec::new()
    } else {
        strip_images_from_notes(dir, &gone)
    };
    Ok(DeleteImagesResult { moved, touched })
}

/// 从所有笔记正文里摘掉这些图片节点，返回被改过的笔记 id。
///
/// 图片拷进正文是"内容寻址"的：同一张图可能出现在好几篇笔记里，所以是全局扫一遍。
/// 摘完变空的段落 / 捕获块一起清掉（不然会留一行看不见内容的空白）。
fn strip_images_from_notes(dir: &Path, hashes: &HashSet<String>) -> Vec<String> {
    let mut touched = Vec::new();
    let Ok(entries) = fs::read_dir(notes_dir(dir)) else {
        return touched;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    paths.sort();

    for p in paths {
        let Some((meta, mut doc, _, _)) = read_note(&p) else {
            continue;
        };
        if !strip_images(&mut doc, hashes) {
            continue;
        }
        // 整篇的图都删光了：doc 的 content 是 block+，至少留一个空段落
        if doc
            .get("content")
            .and_then(|c| c.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true)
        {
            doc = empty_doc();
        }
        if save(dir, &meta.id, doc).is_ok() {
            touched.push(meta.id);
        }
    }
    touched
}

/// 递归摘掉命中的图片节点；返回这份 JSON 有没有被改动。
fn strip_images(node: &mut Value, hashes: &HashSet<String>) -> bool {
    let hit = |v: &Value| -> bool {
        v.get("type").and_then(|t| t.as_str()) == Some("image")
            && v.get("attrs")
                .and_then(|a| a.get("hash"))
                .and_then(|h| h.as_str())
                .map(|h| hashes.contains(h))
                .unwrap_or(false)
    };

    let Some(children) = node.get_mut("content").and_then(|c| c.as_array_mut()) else {
        return false;
    };

    let mut changed = false;
    let mut out: Vec<Value> = Vec::with_capacity(children.len());
    for mut child in std::mem::take(children) {
        if hit(&child) {
            changed = true;
            continue;
        }
        // 这一小块里本来有没有要删的图：有、而且摘完变空了，就整块一起走
        let had_hit = contains_hit(&child, hashes);
        if strip_images(&mut child, hashes) {
            changed = true;
        }
        let emptied = child
            .get("content")
            .and_then(|c| c.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(false);
        let kind = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if had_hit && emptied && (kind == "paragraph" || kind == "captureBlock") {
            continue;
        }
        out.push(child);
    }
    // children 已经被 take 出来了：不管改没改都要放回去
    // （只在 changed 时赋值会把没动过的孩子一起丢掉）
    *children = out;
    changed
}

/// 这块 JSON 里有没有命中要删的图（只看，不改）。
fn contains_hit(node: &Value, hashes: &HashSet<String>) -> bool {
    if node.get("type").and_then(|t| t.as_str()) == Some("image")
        && node
            .get("attrs")
            .and_then(|a| a.get("hash"))
            .and_then(|h| h.as_str())
            .map(|h| hashes.contains(h))
            .unwrap_or(false)
    {
        return true;
    }
    node.get("content")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().any(|v| contains_hit(v, hashes)))
        .unwrap_or(false)
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
    fn 内容没变的保存不刷新更新时间() {
        let d = tmpdir();
        let n = create(&d, "笔记").unwrap();
        let doc = doc_with("写点什么");
        let first = save(&d, &n.id, doc.clone()).unwrap();
        assert_eq!(list(&d)[0].updated_at, first.updated_at);

        // 切笔记/退出前的兜底保存会原样再存一次：不算编辑，排序不能动
        std::thread::sleep(std::time::Duration::from_millis(10));
        let again = save(&d, &n.id, doc).unwrap();
        assert_eq!(again.updated_at, first.updated_at, "同样的正文不该刷新 updatedAt");
        assert_eq!(list(&d)[0].updated_at, first.updated_at, "侧栏排序也不该变");

        // 真改了内容才刷新
        std::thread::sleep(std::time::Duration::from_millis(10));
        let changed = save(&d, &n.id, doc_with("改了一笔")).unwrap();
        assert!(changed.updated_at > first.updated_at, "改过内容应该刷新 updatedAt");
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

    #[test]
    fn 置顶的笔记永远排在最前() {
        let d = tmpdir();
        let a = create(&d, "A").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = create(&d, "B").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        // 让 A 成为"最近编辑"的那篇
        save(&d, &a.id, doc_with("改过 A")).unwrap();
        assert_eq!(list(&d)[0].id, a.id, "没置顶时按最近更新排");

        let pinned = set_pinned(&d, &b.id, true).unwrap();
        assert!(pinned.pinned);
        let l = list(&d);
        assert_eq!(l[0].id, b.id, "置顶的排最前，哪怕它更旧");
        assert_eq!(l[1].id, a.id);

        // 置顶不改变 updatedAt，也不刷新排序用的时间
        assert_eq!(l[0].updated_at, pinned.updated_at);

        // 保存正文不该把 pinned 丢掉
        save(&d, &b.id, doc_with("B 改了一笔")).unwrap();
        assert!(load(&d, &b.id).unwrap().pinned, "保存后仍然置顶");
        assert_eq!(list(&d)[0].id, b.id);

        // 取消置顶后回到时间序
        set_pinned(&d, &b.id, false).unwrap();
        assert_eq!(list(&d)[0].id, b.id, "B 刚被编辑过");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 改名不会丢掉置顶() {
        let d = tmpdir();
        let n = create(&d, "笔记").unwrap();
        set_pinned(&d, &n.id, true).unwrap();
        let meta = rename(&d, &n.id, "新名字").unwrap();
        assert!(meta.pinned);
        assert!(load(&d, &n.id).unwrap().pinned);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 图片可以转移到另一篇笔记() {
        let d = tmpdir();
        let (rel, hash, w, h) = save_image(&d, &png_bytes(8, 5)).unwrap();
        let a = create(&d, "A").unwrap();
        let b = create(&d, "B").unwrap();

        let meta = append_image(&d, &b.id, &rel, &hash, Some(w), Some(h)).unwrap();
        assert_eq!(meta.id, b.id);

        let doc = load(&d, &b.id).unwrap().doc;
        let content = doc["content"].as_array().unwrap();
        let block = &content[content.len() - 1];
        assert_eq!(block["type"].as_str().unwrap(), "captureBlock");
        // 图片是行内节点：外面那层段落就是"图片这一行"
        assert_eq!(block["content"][0]["type"].as_str().unwrap(), "paragraph");
        assert_eq!(
            block["content"][0]["content"][0]["type"].as_str().unwrap(),
            "image"
        );
        assert_eq!(
            block["content"][0]["content"][0]["attrs"]["hash"]
                .as_str()
                .unwrap(),
            hash
        );
        assert_eq!(
            block["content"][0]["content"][0]["attrs"]["w"]
                .as_u64()
                .unwrap(),
            8
        );

        // A 还是空的，图片库里的"被谁引用"跟着变成 B
        let a_doc = load(&d, &a.id).unwrap().doc;
        assert_ne!(a_doc["content"][0]["type"].as_str(), Some("image"));
        let users = &list_images(&d)[0].used_by;
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].id, b.id);

        // 非法 hash / 不存在的 id 都要挡住
        assert!(append_image(&d, &b.id, &rel, "../x", Some(1), Some(1)).is_err());
        assert!(append_image(&d, "nope", &rel, &hash, None, None).is_err());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 批量删除只删给出的那几篇() {
        let d = tmpdir();
        let a = create(&d, "A").unwrap();
        let b = create(&d, "B").unwrap();
        let c = create(&d, "C").unwrap();
        assert_eq!(list(&d).len(), 3);

        let moved = delete_many(&d, &[a.id.clone(), c.id.clone(), "../x".to_string()]);
        assert_eq!(moved, 2, "非法 id 跳过，不报错");
        let rest = list(&d);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, b.id);
        assert!(load(&d, &a.id).is_err());
        fs::remove_dir_all(&d).ok();
    }

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([12, 34, 56, 255]));
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn 图片库列出尺寸并按引用统计归属() {
        let d = tmpdir();
        let (rel, hash, w, h) = save_image(&d, &png_bytes(3, 2)).unwrap();
        assert_eq!((w, h), (3, 2));

        let list = list_images(&d);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].hash, hash);
        assert_eq!(list[0].path, rel);
        assert_eq!((list[0].width, list[0].height), (3, 2));
        assert!(list[0].bytes > 0);
        assert!(list[0].used_by.is_empty(), "还没笔记引用它");

        // 同一张图存两次只占一份（内容寻址），列表里也只有一条
        save_image(&d, &png_bytes(3, 2)).unwrap();
        assert_eq!(list_images(&d).len(), 1);

        // 写一篇引用它的笔记
        let n = create(&d, "带图的").unwrap();
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "captureBlock",
                "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "带图的" }] },
                    { "type": "image", "attrs": { "path": rel, "hash": hash } }
                ]
            }]
        });
        save(&d, &n.id, doc).unwrap();
        let users = &list_images(&d)[0].used_by;
        assert_eq!(users.len(), 1, "只有一篇笔记引用它");
        assert_eq!(users[0].id, n.id);
        assert_eq!(users[0].title, "带图的");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 图片库记下引用它的笔记_id_供按笔记分组() {
        let d = tmpdir();
        let (rel, hash, _, _) = save_image(&d, &png_bytes(4, 4)).unwrap();
        let a = create(&d, "A").unwrap();
        let b = create(&d, "B").unwrap();
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "captureBlock",
                "content": [
                    { "type": "image", "attrs": { "path": rel, "hash": hash } },
                    { "type": "image", "attrs": { "path": rel, "hash": hash } }
                ]
            }]
        });
        save(&d, &a.id, doc.clone()).unwrap();
        save(&d, &b.id, doc).unwrap();

        let users = &list_images(&d)[0].used_by;
        assert_eq!(users.len(), 2, "两篇笔记各算一次，同篇里重复不算");
        assert_eq!(users[0].id, a.id);
        assert_eq!(users[1].id, b.id);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 真删除笔记不留回收站() {
        let d = tmpdir();
        let n = create(&d, "要真删的").unwrap();
        purge(&d, &n.id).unwrap();
        assert_eq!(list(&d).len(), 0);
        assert!(!note_path(&d, &n.id).exists(), "文件应该从磁盘上没了");
        assert!(
            !d.join("notes").join(".trash").exists(),
            "真删除不该产生回收目录"
        );
        assert!(purge(&d, &n.id).is_err(), "删第二次应该报不存在");
        assert!(purge(&d, "../settings").is_err(), "路径穿越要被挡住");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 用图片新建笔记() {
        let d = tmpdir();
        let (rel_a, a, _, _) = save_image(&d, &png_bytes(6, 3)).unwrap();
        let (_, b, _, _) = save_image(&d, &png_bytes(2, 5)).unwrap();

        let note = create_from_images(&d, &[a.clone(), b.clone(), "../x".to_string()]).unwrap();
        assert_eq!(note.title, "图片笔记 · 2 张");
        let lines = &note.doc["content"][0]["content"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"].as_str().unwrap(), "paragraph");
        let img = &lines[0]["content"][0];
        assert_eq!(img["attrs"]["path"].as_str().unwrap(), rel_a);
        assert_eq!(img["attrs"]["hash"].as_str().unwrap(), a);
        assert_eq!(img["attrs"]["w"].as_u64().unwrap(), 6);
        assert_eq!(img["attrs"]["h"].as_u64().unwrap(), 3);

        // 标题锁定：存一次不该被改成"无标题笔记"
        let meta = save(&d, &note.id, note.doc.clone()).unwrap();
        assert_eq!(meta.title, "图片笔记 · 2 张");
        assert_eq!(list_images(&d)[0].used_by.len(), 1, "新笔记引用了图片");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 多选删除图片进回收站_非法hash被忽略() {
        let d = tmpdir();
        let (_, a, _, _) = save_image(&d, &png_bytes(2, 2)).unwrap();
        let (_, b, _, _) = save_image(&d, &png_bytes(5, 4)).unwrap();
        assert_eq!(list_images(&d).len(), 2);

        // 路径穿越的"hash"不能碰到任何文件
        assert_eq!(
            delete_images(&d, &["../../settings".to_string(), "..\\evil".to_string()])
                .unwrap()
                .moved,
            0
        );
        assert_eq!(list_images(&d).len(), 2);

        assert_eq!(delete_images(&d, &[a.clone(), b.clone()]).unwrap().moved, 2);
        assert!(list_images(&d).is_empty(), "删完列表应该空");
        let trash = d.join("images").join(".trash");
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 2, "两张都在回收站");

        // 再删一次不会报错，也不会重复计数
        assert_eq!(delete_images(&d, &[a]).unwrap().moved, 0);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 删掉图片时正文里的那一块跟着摘掉() {
        let d = tmpdir();
        let (rel, hash, _w, _h) = save_image(&d, &png_bytes(4, 4)).unwrap();
        let (_, keep, _, _) = save_image(&d, &png_bytes(3, 3)).unwrap();
        let n = create(&d, "笔记").unwrap();

        // 一篇笔记里：一行文字、要删的图、另一张图（同一个捕获块里）
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "captureBlock",
                "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "第一行" }] },
                    {
                        "type": "paragraph",
                        "content": [{ "type": "image", "attrs": { "path": rel, "hash": hash } }]
                    },
                    {
                        "type": "paragraph",
                        "content": [{ "type": "image", "attrs": {
                            "path": format!("images/x/{keep}.png"), "hash": keep.clone()
                        } }]
                    }
                ]
            }]
        });
        save(&d, &n.id, doc).unwrap();

        let res = delete_images(&d, &[hash.clone()]).unwrap();
        assert_eq!(res.moved, 1);
        assert_eq!(res.touched, vec![n.id.clone()], "这篇笔记的正文被动过");

        let after = load(&d, &n.id).unwrap().doc;
        let block = &after["content"][0];
        let lines = block["content"].as_array().unwrap();
        assert_eq!(lines.len(), 2, "只剩文字行和另一张图");
        assert_eq!(lines[0]["content"][0]["text"].as_str().unwrap(), "第一行");
        assert_eq!(
            lines[1]["content"][0]["attrs"]["hash"].as_str().unwrap(),
            keep
        );
        // 图片文件确实进了回收站，wi/h 这些属性也没被动过
        assert!(!image_file(&d, &hash).exists());
        assert_eq!(list_images(&d).len(), 1);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 删图后整篇只剩空块也不留空白() {
        let d = tmpdir();
        let (rel, hash, _, _) = save_image(&d, &png_bytes(2, 2)).unwrap();
        let n = create(&d, "只有一张图").unwrap();
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "captureBlock",
                "content": [{
                    "type": "paragraph",
                    "content": [{ "type": "image", "attrs": { "path": rel, "hash": hash } }]
                }]
            }]
        });
        save(&d, &n.id, doc).unwrap();

        delete_images(&d, &[hash]).unwrap();
        let after = load(&d, &n.id).unwrap().doc;
        let content = after["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"].as_str().unwrap(), "paragraph");
        assert!(content[0].get("content").is_none(), "留下一个空段落给光标");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 搜索命中正文和图片备注() {
        let d = tmpdir();
        let n = create(&d, "笔记").unwrap();
        let (_, hash, _, _) = save_image(&d, &png_bytes(2, 2)).unwrap();
        // 备注属于图片，存在图片旁边，不埋进笔记正文
        set_image_note(&d, &hash, "登录页截图，按钮在右上角").unwrap();
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": "会议纪要：下周三评审" }]
                },
                {
                    "type": "captureBlock",
                    "content": [{
                        "type": "image",
                        "attrs": { "hash": hash }
                    }]
                }
            ]
        });
        save(&d, &n.id, doc).unwrap();

        let hits = search(&d, "评审");
        assert_eq!(hits.len(), 1, "正文命中一条");
        assert_eq!(hits[0].kind, "text");
        assert_eq!(hits[0].id, n.id);
        assert_eq!(hits[0].hash, None);
        assert!(hits[0].snippet.contains("评审"), "片段要带上下文");

        let hits = search(&d, "按钮");
        assert_eq!(hits.len(), 1, "图片备注单独成一条");
        assert_eq!(hits[0].kind, "image");
        assert_eq!(hits[0].hash.as_deref(), Some(hash.as_str()));
        assert!(hits[0].snippet.contains("按钮"));

        // 一篇笔记正文和备注都命中时，两条结果都要有
        save(
            &d,
            &n.id,
            json!({
                "type": "doc",
                "content": [{
                    "type": "captureBlock",
                    "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "按钮" }] },
                        { "type": "image", "attrs": { "hash": hash } }
                    ]
                }]
            }),
        )
        .unwrap();
        let hits = search(&d, "按钮");
        assert_eq!(hits.len(), 2, "正文一条 + 图片备注一条");
        assert_eq!(hits[0].kind, "text");
        assert_eq!(hits[1].kind, "image");

        // 没被任何笔记引用的图，备注也要能搜到（id 为空，前端据此打开图片库）
        let (_, orphan, _, _) = save_image(&d, &png_bytes(4, 4)).unwrap();
        set_image_note(&d, &orphan, "孤零零的一张图").unwrap();
        let hits = search(&d, "孤零零");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "image");
        assert!(hits[0].id.is_empty());
        assert_eq!(hits[0].hash.as_deref(), Some(orphan.as_str()));

        assert!(search(&d, "   ").is_empty(), "空查询不返回任何东西");
        assert!(search(&d, "这个词一定不存在").is_empty());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 旧的图注会搬到图片自己的备注里() {
        let d = tmpdir();
        let n = create(&d, "笔记").unwrap();
        let (_, hash, _, _) = save_image(&d, &png_bytes(3, 3)).unwrap();
        save(
            &d,
            &n.id,
            json!({
                "type": "doc",
                "content": [{
                    "type": "captureBlock",
                    "content": [{ "type": "image", "attrs": { "hash": hash, "note": "旧备注" } }]
                }]
            }),
        )
        .unwrap();

        migrate_image_notes(&d);
        assert_eq!(read_image_note(&d, &hash), "旧备注", "备注应该搬到图片旁边");
        let raw = fs::read_to_string(note_path(&d, &n.id)).unwrap();
        assert!(!raw.contains("\"note\""), "笔记 JSON 里不该再留 note 字段");

        // 幂等：再跑一次不改任何东西
        migrate_image_notes(&d);
        assert_eq!(read_image_note(&d, &hash), "旧备注");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 搜索不区分大小写并且统计次数() {
        let d = tmpdir();
        let n = create(&d, "笔记").unwrap();
        save(&d, &n.id, doc_with("Hello hello HELLO")).unwrap();

        let hits = search(&d, "hello");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].count, 3);
        assert_eq!(hits[0].snippet, "Hello hello HELLO");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn 搜索也能命中手动改过的标题() {
        let d = tmpdir();
        let n = create(&d, "笔记").unwrap();
        save(&d, &n.id, doc_with("正文里没有那两个字")).unwrap();
        rename(&d, &n.id, "项目评审").unwrap();

        let hits = search(&d, "评审");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "text");
        assert!(hits[0].snippet.contains("项目评审"), "标题命中时片段显示标题");
        fs::remove_dir_all(&d).ok();
    }
}
