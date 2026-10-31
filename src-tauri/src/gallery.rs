//! 平铺预览页（标题栏那个"平铺"按钮进去的页面）：卡片预览 + 排序。
//!
//! **这一页现在没有目录**：全部笔记铺成一页。目录相关的读写能力还留在下面
//! （`folders.json` 和笔记里的 `folderId` 都原样保留，老数据不会丢），
//! 只是前端不再调用它们，`view` 也不再按目录分组排序。
//!
//! 排序存在笔记自己的 JSON 里（`sort`，越小越前）：拖动换位只是改一个字段，
//! 不复制正文，也不会出现"排序文件和笔记各说一套"的分裂状态。
//!
//! 另一个约定：整理顺序**不算编辑**。这些操作都不碰 `updatedAt`，所以侧栏顺序不会
//! 因为拖动而乱跳（真正的改动仍然走 storage::save）。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::storage::{self, NoteMeta};

/// 一个目录。空的 `sort`（老文件缺字段）按 0 算。
///
/// 目录可以套目录：`parent_id` 为空就是顶层。层数不设上限，
/// 但前端只画到一定深度之后仍然可展开（见 NoteGallery 的 depth 处理）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// 父目录；None = 顶层
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 同级之间的先后顺序，越小越前
    #[serde(default)]
    pub sort: f64,
}

/// 平铺页里的一张卡片：笔记的元信息 + 卡片上要显示的那点正文。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GalleryNote {
    #[serde(flatten)]
    pub meta: NoteMeta,
    /// 卡片上能看到的正文（最多 12 行，已经压成一行一段）
    pub preview: Vec<String>,
    /// 封面 / 缩略图（相对数据目录的路径，前端拼 asset:// 用）
    pub images: Vec<String>,
    /// 段落数：卡片底部那个"12 段"
    pub blocks: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GalleryView {
    pub notes: Vec<GalleryNote>,
    pub folders: Vec<Folder>,
}

fn folders_path(dir: &Path) -> PathBuf {
    dir.join("folders.json")
}

/// 目录 id：f + 时间戳 + 序号，落在 safe_id 允许的字符集里。
fn new_folder_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    format!("f{}_{:02x}", storage::now_ms(), seq & 0xff)
}

/// 目录名：去掉控制字符、压掉多余空白、最多 40 字。
fn clean_name(name: &str) -> String {
    let flat = name.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().filter(|c| !c.is_control()).take(40).collect()
}

/// 读目录列表（按 sort 排好）。文件不存在 / 坏了都当"还没有目录"：
/// 笔记这时候全部算未分类，至少内容不会丢。
fn read_folders(dir: &Path) -> Vec<Folder> {
    let Ok(raw) = fs::read_to_string(folders_path(dir)) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(arr) = v.get("folders").and_then(|f| f.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<Folder> = arr
        .iter()
        .filter_map(|x| serde_json::from_value::<Folder>(x.clone()).ok())
        .filter(|f| !f.name.trim().is_empty())
        .collect();
    out.sort_by(|a, b| {
        a.sort
            .partial_cmp(&b.sort)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

fn write_folders(dir: &Path, folders: &[Folder]) -> Result<(), String> {
    let payload = json!({ "version": 1, "folders": folders });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    storage::atomic_write(&folders_path(dir), &bytes, None)
}

pub fn create_folder(dir: &Path, name: &str, parent_id: Option<&str>) -> Result<Folder, String> {
    let name = clean_name(name);
    if name.is_empty() {
        return Err("目录名不能为空".into());
    }
    let mut folders = read_folders(dir);
    let parent = parent_id.filter(|p| !p.is_empty()).map(|p| p.to_string());
    if let Some(pid) = &parent {
        if !folders.iter().any(|f| &f.id == pid) {
            return Err("父目录不存在".into());
        }
    }
    // 同一个父目录下同名不重复建：直接返回已有的那个，免得出现两个"工作"分不清
    if let Some(f) = folders
        .iter()
        .find(|f| f.name == name && f.parent_id == parent)
    {
        return Ok(f.clone());
    }
    let sort = next_folder_sort(&folders, parent.as_deref());
    let folder = Folder {
        id: new_folder_id(),
        name,
        created_at: storage::now_ms(),
        parent_id: parent,
        sort,
    };
    folders.push(folder.clone());
    write_folders(dir, &folders)?;
    Ok(folder)
}

/// 同级里的下一个位置（目录的 sort 只在同一个父目录内部比较）。
fn next_folder_sort(folders: &[Folder], parent: Option<&str>) -> f64 {
    folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == parent)
        .map(|f| f.sort)
        .fold(0.0_f64, f64::max)
        + 1.0
}

pub fn rename_folder(dir: &Path, id: &str, name: &str) -> Result<Folder, String> {
    let name = clean_name(name);
    if name.is_empty() {
        return Err("目录名不能为空".into());
    }
    let mut folders = read_folders(dir);
    let Some(f) = folders.iter_mut().find(|f| f.id == id) else {
        return Err("目录不存在".into());
    };
    f.name = name;
    let out = f.clone();
    write_folders(dir, &folders)?;
    Ok(out)
}

/// 一个目录连同它所有子孙目录的 id（深度优先）。
pub(crate) fn subtree_ids(folders: &[Folder], root: &str) -> Vec<String> {
    let mut out = vec![root.to_string()];
    let mut i = 0;
    while i < out.len() {
        let cur = out[i].clone();
        for f in folders {
            if f.parent_id.as_deref() == Some(cur.as_str()) && !out.contains(&f.id) {
                out.push(f.id.clone());
            }
        }
        i += 1;
    }
    out
}

/// 删目录：把它和它的子目录一起删掉，里面的笔记一篇都不删 —— 全部回到未分类。
pub fn delete_folder(dir: &Path, id: &str) -> Result<(), String> {
    let folders = read_folders(dir);
    if !folders.iter().any(|f| f.id == id) {
        return Err("目录不存在".into());
    }
    let doomed = subtree_ids(&folders, id);
    let kept: Vec<Folder> = folders
        .iter()
        .filter(|f| !doomed.contains(&f.id))
        .cloned()
        .collect();
    write_folders(dir, &kept)?;
    for meta in storage::list(dir) {
        if let Some(fid) = meta.folder_id.as_deref() {
            if doomed.iter().any(|d| d == fid) {
                let _ = storage::patch_note(dir, &meta.id, |v| {
                    v["folderId"] = Value::Null;
                });
            }
        }
    }
    Ok(())
}

/// 同级目录重新排序（拖 / 上下移之后，把这一层的最终顺序整条发过来）。
pub fn save_folder_order(dir: &Path, ids: &[String]) -> Result<(), String> {
    let mut folders = read_folders(dir);
    for (i, id) in ids.iter().enumerate() {
        if let Some(f) = folders.iter_mut().find(|f| &f.id == id) {
            f.sort = i as f64;
        }
    }
    write_folders(dir, &folders)
}

fn sort_of(m: &NoteMeta) -> f64 {
    // 老笔记没有 sort：按创建时间倒序顶替（等价于"新建的排在前面"）
    m.sort.unwrap_or(-(m.created_at as f64))
}

/// 目标目录当前的末尾位置：挪进来的笔记接在最后，而不是插到某个老位置上去。
fn next_sort(dir: &Path, folder: Option<&str>) -> f64 {
    let mut max: Option<f64> = None;
    for m in storage::list(dir) {
        if m.folder_id.as_deref() != folder {
            continue;
        }
        let s = sort_of(&m);
        max = Some(max.map_or(s, |x| x.max(s)));
    }
    max.map(|m| m + 1.0).unwrap_or(0.0)
}

/// 批量归类：把 ids 全部挪进 folder（None = 未分类），接在目标末尾。
pub fn set_notes_folder(dir: &Path, ids: &[String], folder: Option<&str>) -> Result<(), String> {
    if let Some(fid) = folder {
        if !read_folders(dir).iter().any(|f| f.id == fid) {
            return Err("目录不存在".into());
        }
    }
    let mut next = next_sort(dir, folder);
    for id in ids {
        if storage::safe_id(id).is_none() {
            continue;
        }
        let sort = next;
        next += 1.0;
        let fid = folder.map(|s| s.to_string());
        storage::patch_note(dir, id, |v| {
            v["folderId"] = match &fid {
                Some(f) => Value::String(f.clone()),
                None => Value::Null,
            };
            v["sort"] = json!(sort);
        })?;
    }
    Ok(())
}

/// 重写一个目录里的先后顺序（拖动 / 放置之后由前端把最终顺序整条发过来）。
///
/// 写成 0,1,2… 的整数序号：简单、可读，前端下次拖动的插入位置也直接按数组下标算。
pub fn save_order(dir: &Path, ids: &[String]) -> Result<(), String> {
    for (i, id) in ids.iter().enumerate() {
        if storage::safe_id(id).is_none() {
            continue;
        }
        let sort = i as f64;
        storage::patch_note(dir, id, |v| {
            v["sort"] = json!(sort);
        })?;
    }
    Ok(())
}

/// 卡片预览：把正文压成"一行一段"的纯文本 + 前几张图。
fn walk(node: &Value, lines: &mut Vec<String>, images: &mut Vec<String>, blocks: &mut usize) {
    let children = node.get("content").and_then(|c| c.as_array());

    // 叶子块：里面全是行内节点（文字 / 图片 / 换行），或者本身就是空的
    let inline_only = match children {
        None => true,
        Some(list) => list.iter().all(|c| {
            matches!(
                c.get("type").and_then(|t| t.as_str()).unwrap_or(""),
                "text" | "image" | "hardBreak"
            )
        }),
    };
    if inline_only {
        *blocks += 1;
        let mut buf = String::new();
        for c in children.into_iter().flatten() {
            match c.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" => {
                    if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                        buf.push_str(t);
                    }
                }
                "image" => {
                    if let Some(p) = c.pointer("/attrs/path").and_then(|p| p.as_str()) {
                        if images.len() < 6 {
                            images.push(p.to_string());
                        }
                    }
                }
                // 复制进来的多行是同一个段落里的硬换行：换成空格，
                // 免得"第一行第二行"在卡片预览里粘成一个词
                "hardBreak" => buf.push(' '),
                _ => {}
            }
        }
        let line = buf.split_whitespace().collect::<Vec<_>>().join(" ");
        if !line.is_empty() && lines.len() < 12 {
            lines.push(line);
        }
        return;
    }

    // 容器（doc / 捕获块 / 列表 / 引用）：只往下走，本身不算一段
    for c in children.into_iter().flatten() {
        walk(c, lines, images, blocks);
    }
}

/// 平铺页的全部数据：一篇卡片一条，目录列表一份（带父子关系）。
pub fn view(dir: &Path) -> GalleryView {
    let mut folders = read_folders(dir);
    // 手改坏了的 folders.json：父目录不存在、自己当自己的父、绕成环，
    // 都当成顶层目录 —— 前端画树的时候不会转不出来。
    let ids: Vec<String> = folders.iter().map(|f| f.id.clone()).collect();
    for f in folders.iter_mut() {
        if let Some(p) = f.parent_id.clone() {
            if p == f.id || !ids.contains(&p) {
                f.parent_id = None;
            }
        }
    }
    let parents: std::collections::HashMap<String, Option<String>> = folders
        .iter()
        .map(|f| (f.id.clone(), f.parent_id.clone()))
        .collect();
    for i in 0..folders.len() {
        let mut cur = folders[i].parent_id.clone();
        let mut hops = 0;
        while let Some(p) = cur {
            hops += 1;
            if hops > ids.len() {
                folders[i].parent_id = None;
                break;
            }
            cur = parents.get(&p).cloned().flatten();
        }
    }

    let mut notes: Vec<GalleryNote> = Vec::new();
    for mut meta in storage::list(dir) {
        // 目录被手工删掉、folders.json 丢了：这篇笔记按未分类算，
        // 而不是挂在一个不存在的目录下（那样两边都看不见它）
        if let Some(fid) = meta.folder_id.clone() {
            if !folders.iter().any(|f| f.id == fid) {
                meta.folder_id = None;
            }
        }
        let mut preview = Vec::new();
        let mut images = Vec::new();
        let mut blocks = 0usize;
        if let Some(v) = storage::read_note_file(dir, &meta.id) {
            if let Some(doc) = v.get("doc") {
                walk(doc, &mut preview, &mut images, &mut blocks);
            }
        }
        notes.push(GalleryNote {
            meta,
            preview,
            images,
            blocks,
        });
    }
    // 平铺页没有目录：所有笔记排成一条顺序。
    // 手动顺序（sort）优先，没顺序信息的老笔记按"最近更新倒序"兜底。
    notes.sort_by(|a, b| {
        sort_of(&a.meta)
            .partial_cmp(&sort_of(&b.meta))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.meta.updated_at.cmp(&a.meta.updated_at))
            .then_with(|| a.meta.id.cmp(&b.meta.id))
    });
    GalleryView { notes, folders }
}
#[cfg(test)]
mod tests {
    //! 目录树的增删改和"笔记挪目录 / 排序"是最容易写错的地方，
    //! 用真实文件跑一遍（临时目录，测完就删）。

    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "c2g-test-{tag}-{}-{}",
            std::process::id(),
            storage::now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        storage::ensure_dirs(&dir);
        dir
    }

    fn note_ids(dir: &Path) -> Vec<String> {
        storage::list(dir).into_iter().map(|m| m.id).collect()
    }

    #[test]
    fn folders_nest_and_notes_move() {
        let dir = temp_dir("nest");
        let a = storage::create(&dir, "A").unwrap();
        let b = storage::create(&dir, "B").unwrap();

        let work = create_folder(&dir, "Work", None).unwrap();
        let project = create_folder(&dir, "Project", Some(&work.id)).unwrap();
        let deep = create_folder(&dir, "Deep", Some(&project.id)).unwrap();

        // 父子关系落盘了（再看一遍 view）
        let v = view(&dir);
        assert_eq!(v.folders.len(), 3);
        let get = |id: &str| v.folders.iter().find(|f| f.id == id).unwrap().clone();
        assert_eq!(get(&work.id).parent_id, None);
        assert_eq!(get(&project.id).parent_id.as_deref(), Some(work.id.as_str()));
        assert_eq!(get(&deep.id).parent_id.as_deref(), Some(project.id.as_str()));

        // 两篇笔记都挪进最里面那层
        set_notes_folder(&dir, &[a.id.clone(), b.id.clone()], Some(&deep.id)).unwrap();
        let v = view(&dir);
        for n in &v.notes {
            assert_eq!(n.meta.folder_id.as_deref(), Some(deep.id.as_str()));
        }

        // 调顺序：B 在前
        save_order(&dir, &[b.id.clone(), a.id.clone()]).unwrap();
        let v = view(&dir);
        let order: Vec<String> = v
            .notes
            .iter()
            .filter(|n| n.meta.folder_id.as_deref() == Some(deep.id.as_str()))
            .map(|n| n.meta.id.clone())
            .collect();
        assert_eq!(order, vec![b.id.clone(), a.id.clone()]);

        // 挪回未分类
        set_notes_folder(&dir, &[a.id.clone()], None).unwrap();
        let v = view(&dir);
        let folder_of = |id: &str| {
            v.notes
                .iter()
                .find(|n| n.meta.id == id)
                .unwrap()
                .meta
                .folder_id
                .clone()
        };
        assert_eq!(folder_of(&a.id), None);
        assert_eq!(folder_of(&b.id).as_deref(), Some(deep.id.as_str()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_folder_takes_children_and_keeps_notes() {
        let dir = temp_dir("del");
        let a = storage::create(&dir, "A").unwrap();
        let work = create_folder(&dir, "Work", None).unwrap();
        let project = create_folder(&dir, "Project", Some(&work.id)).unwrap();
        set_notes_folder(&dir, &[a.id.clone()], Some(&project.id)).unwrap();

        delete_folder(&dir, &work.id).unwrap();

        let v = view(&dir);
        assert!(v.folders.is_empty(), "子目录应该跟着一起删掉");
        assert_eq!(v.notes.len(), 1, "笔记一篇都不该少");
        assert_eq!(v.notes[0].meta.folder_id, None, "笔记回到未分类");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_order_is_per_level() {
        let dir = temp_dir("order");
        let p = create_folder(&dir, "P", None).unwrap();
        let c1 = create_folder(&dir, "C1", Some(&p.id)).unwrap();
        let c2 = create_folder(&dir, "C2", Some(&p.id)).unwrap();

        // 子目录换顺序，父目录的相对位置不受影响
        save_folder_order(&dir, &[c2.id.clone(), c1.id.clone()]).unwrap();
        let v = view(&dir);
        let kids: Vec<String> = v
            .folders
            .iter()
            .filter(|f| f.parent_id.as_deref() == Some(p.id.as_str()))
            .map(|f| f.id.clone())
            .collect();
        assert_eq!(kids, vec![c2.id, c1.id]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_picks_up_text_and_images() {
        let dir = temp_dir("preview");
        let n = storage::create(&dir, "A").unwrap();
        let doc = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "captureBlock", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "第一行文字" }] },
                    { "type": "paragraph", "content": [
                        { "type": "image", "attrs": { "path": "images/aa/bb/x.png" } }
                    ] }
                ]}
            ]
        });
        storage::save(&dir, &n.id, doc).unwrap();

        let v = view(&dir);
        let note = &v.notes[0];
        assert_eq!(note.preview, vec!["第一行文字".to_string()]);
        assert_eq!(note.images, vec!["images/aa/bb/x.png".to_string()]);
        assert_eq!(note.blocks, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_parent_links_fall_back_to_root() {
        let dir = temp_dir("broken");
        // 手写一个 folders.json：一个指向不存在的父目录、一个自己当自己的父
        let raw = serde_json::json!({
            "version": 1,
            "folders": [
                { "id": "f1", "name": "A", "createdAt": 1, "parentId": "nope", "sort": 1.0 },
                { "id": "f2", "name": "B", "createdAt": 2, "parentId": "f2", "sort": 2.0 }
            ]
        });
        std::fs::write(folders_path(&dir), serde_json::to_vec(&raw).unwrap()).unwrap();

        let v = view(&dir);
        assert_eq!(v.folders.len(), 2);
        for f in &v.folders {
            assert_eq!(f.parent_id, None, "坏掉的父子关系应该退化成顶层");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_name_is_cleaned_and_deduped() {
        let dir = temp_dir("name");
        let a = create_folder(&dir, "  工作  清单 ", None).unwrap();
        assert_eq!(a.name, "工作 清单");
        // 同一层同名不重复建
        let b = create_folder(&dir, "工作 清单", None).unwrap();
        assert_eq!(a.id, b.id);
        // 但不同层可以同名
        let c = create_folder(&dir, "工作 清单", Some(&a.id)).unwrap();
        assert_ne!(a.id, c.id);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
