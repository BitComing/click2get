//! 导出：Markdown 与 Word（.docx）。
//!
//! 不引第三方库：
//! - Markdown 直接按 doc JSON 走一遍，图片写成相对路径（`../images/...`），
//!   导出的 .md 就躺在 `<数据目录>/exports/` 里，双击就能在编辑器里看；
//! - .docx 本质是"一堆 XML 打成一个 zip"，图放进 `word/media/`。zip 用
//!   **不压缩（store）**方式手写 —— 导出的笔记体量就几十 KB，换来零依赖很划算，
//!   也不会因为加了 flate2 让 exe 变大。
//!
//! 两个格式共用同一套"遍历 doc JSON"的逻辑，保证导出的顺序、换行、图片位置一致。

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::storage;

/// 这个节点是不是一张图（图片现在是行内节点，会夹在段落中间）。
fn is_image_node(node: &Value) -> bool {
    node.get("type").and_then(|t| t.as_str()) == Some("image")
}

/// 一次导出的结果，前端拿它拼 toast（文件名比全路径好读）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    /// 绝对路径
    pub path: String,
    /// 文件名（不含目录）
    pub name: String,
    /// "md" | "docx"
    pub format: String,
    /// 文件里带了多少张图
    pub images: usize,
}

pub fn export_note(dir: &Path, id: &str, format: &str, stamp: &str) -> Result<ExportFile, String> {
    let note = storage::load(dir, id)?;
    let title = file_stem(&note.title);
    let stamp = normalize_stamp(stamp);

    let (ext, label, bytes, images) = match format {
        "md" | "markdown" => {
            let (text, images) = to_markdown(dir, &note.doc);
            (".md", "md", text.into_bytes(), images)
        }
        "docx" | "word" => {
            let (bytes, images) = to_docx(dir, &note.doc)?;
            (".docx", "docx", bytes, images)
        }
        other => return Err(format!("不支持的导出格式：{other}")),
    };

    let out_dir = dir.join("exports");
    fs::create_dir_all(&out_dir).map_err(|e| format!("建导出目录失败：{e}"))?;
    let name = format!("{title}-{stamp}{ext}");
    let path = out_dir.join(&name);
    storage::atomic_write(&path, &bytes, None)?;

    Ok(ExportFile {
        path: path.to_string_lossy().to_string(),
        name,
        format: label.to_string(),
        images,
    })
}

/// 标题里不能出现的字符换掉，剩下的截断 —— 免得导出失败在一个冒号上。
fn file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let t = cleaned.trim().trim_matches('.').trim();
    let t: String = t.chars().take(40).collect();
    if t.is_empty() {
        "笔记".to_string()
    } else {
        t
    }
}

/// 前端给的是本地时间（`20261030-185300`）；这里只做清洗，绝不自己算时区。
fn normalize_stamp(stamp: &str) -> String {
    let s: String = stamp
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '-')
        .collect();
    if s.is_empty() {
        format!("{}", storage::now_ms())
    } else {
        s.chars().take(32).collect()
    }
}

// ── Markdown ────────────────────────────────────────────

/// doc JSON → Markdown 文本，返回 (文本, 图片张数)。
pub fn to_markdown(dir: &Path, doc: &Value) -> (String, usize) {
    let mut images = 0;
    let mut blocks: Vec<String> = Vec::new();
    if let Some(items) = doc.get("content").and_then(|c| c.as_array()) {
        for node in items {
            md_block(dir, node, &mut blocks, &mut images, 0);
        }
    }

    let mut text = blocks
        .iter()
        .filter(|b| !b.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n");
    // 空行（用户在笔记里敲出来的空段落）保留一份，但不留一长串
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    if !text.is_empty() {
        text.push('\n');
    }
    (text, images)
}

fn md_block(dir: &Path, node: &Value, out: &mut Vec<String>, images: &mut usize, level: usize) {
    let kind = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        // 捕获块只是个容器，导出时完全透明
        "captureBlock" | "doc" => {
            if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
                for child in arr {
                    md_block(dir, child, out, images, level);
                }
            }
        }
        "paragraph" => {
            // 图片是行内节点，会和文字漂在同一行：按顺序拆成"文字段 + 图"，
            // 图永远单独成段（Markdown 里图片本来就是块级写法）
            let Some(children) = node.get("content").and_then(|c| c.as_array()) else {
                out.push(String::new());
                return;
            };
            if !children.iter().any(is_image_node) {
                out.push(md_inline(node));
                return;
            }
            let mut buf: Vec<Value> = Vec::new();
            let flush = |buf: &mut Vec<Value>, out: &mut Vec<String>| {
                if buf.is_empty() {
                    return;
                }
                let text = md_inline(&json!({ "content": std::mem::take(buf) }));
                if !text.trim().is_empty() {
                    out.push(text);
                }
            };
            for child in children {
                if is_image_node(child) {
                    flush(&mut buf, out);
                    md_block(dir, child, out, images, level);
                } else {
                    buf.push(child.clone());
                }
            }
            flush(&mut buf, out);
        }
        "heading" => {
            let depth = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1)
                .clamp(1, 6);
            let marks = "#".repeat(depth as usize);
            out.push(format!("{marks} {}", md_inline(node)));
        }
        "image" => {
            let attrs = node.get("attrs").cloned().unwrap_or(Value::Null);
            let rel = attrs.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let hash = attrs.get("hash").and_then(|h| h.as_str()).unwrap_or("");
            let alt = attrs.get("alt").and_then(|a| a.as_str()).unwrap_or("");
            let mut line = if rel.is_empty() {
                String::new()
            } else {
                // 导出文件在 exports/ 下，图在 images/ 下：退一级就对了
                format!("![{alt}](../{})", rel.replace('\\', "/"))
            };
            if line.is_empty() && !hash.is_empty() {
                line = format!("![{alt}](图 {hash})");
            }
            if !line.is_empty() {
                out.push(line);
                *images += 1;
            }
            // 图片备注跟着图走：放在图下面当引用块，别丢掉用户写过的字
            let note = if hash.is_empty() {
                String::new()
            } else {
                storage::read_image_note(dir, hash)
            };
            if !note.trim().is_empty() {
                // 第一行带"备注："前缀，其余行只加引用符号
                let quoted: String = note
                    .lines()
                    .enumerate()
                    .map(|(i, l)| {
                        if i == 0 {
                            format!("> 备注：{}", l.trim_end())
                        } else {
                            format!("> {}", l.trim_end())
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                out.push(quoted);
            }
        }
        "bulletList" | "orderedList" => {
            let ordered = kind == "orderedList";
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for (i, item) in items.iter().enumerate() {
                    let bullet = if ordered {
                        format!("{}.", i + 1)
                    } else {
                        "-".to_string()
                    };
                    // 列表项里的第一段接在项目符号后面，其余段落缩进对齐
                    let mut first = true;
                    if let Some(children) = item.get("content").and_then(|c| c.as_array()) {
                        for child in children {
                            let ckind =
                                child.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            if ckind == "paragraph" {
                                let indent = "  ".repeat(level);
                                if first {
                                    out.push(format!("{indent}{bullet} {}", md_inline(child)));
                                    first = false;
                                } else {
                                    out.push(format!("{indent}{}  {}", " ".repeat(bullet.len() + 1), md_inline(child)));
                                }
                            } else {
                                md_block(dir, child, out, images, level + 1);
                            }
                        }
                    }
                    if first {
                        out.push(format!("{}-", "  ".repeat(level)));
                    }
                }
            }
        }
        "blockquote" => {
            if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
                for child in arr {
                    let mut inner: Vec<String> = Vec::new();
                    md_block(dir, child, &mut inner, images, level);
                    for line in inner.join("\n").lines() {
                        out.push(format!("> {}", line));
                    }
                }
            }
        }
        "codeBlock" => {
            let lang = node
                .get("attrs")
                .and_then(|a| a.get("language"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            let code = inline_text(node);
            out.push(format!("```{lang}\n{code}\n```"));
        }
        "horizontalRule" => out.push("---".to_string()),
        "hardBreak" => out.push(String::new()),
        _ => {
            // 不认识的节点：有文字就把文字导出去，别整块丢掉
            let text = inline_text(node);
            if !text.trim().is_empty() {
                out.push(text);
            }
        }
    }
}

/// 一个段落里的行内内容（文字 + 链接 / 加粗 / 斜体 / 行内代码）。
fn md_inline(node: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
        for child in arr {
            let kind = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "text" {
                let text = child.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let mut t = text.to_string();
                let marks = child
                    .get("marks")
                    .and_then(|m| m.as_array())
                    .cloned()
                    .unwrap_or_default();
                for mark in marks.iter().rev() {
                    let mkind = mark.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    t = match mkind {
                        "bold" => format!("**{t}**"),
                        "italic" => format!("*{t}*"),
                        "strike" => format!("~~{t}~~"),
                        "code" => format!("`{t}`"),
                        "link" => {
                            let href = mark
                                .get("attrs")
                                .and_then(|a| a.get("href"))
                                .and_then(|h| h.as_str())
                                .unwrap_or("");
                            if href.is_empty() {
                                t
                            } else if t == href {
                                format!("<{href}>")
                            } else {
                                format!("[{t}]({href})")
                            }
                        }
                        _ => t,
                    };
                }
                out.push_str(&t);
            } else if kind == "hardBreak" {
                out.push_str("  \n");
            } else {
                out.push_str(&inline_text(child));
            }
        }
    } else if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        out.push_str(text);
    }
    out
}

/// 纯文字（代码块、未知节点用）。
fn inline_text(node: &Value) -> String {
    let mut s = String::new();
    if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        s.push_str(text);
        return s;
    }
    if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
        for child in arr {
            let kind = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "hardBreak" {
                s.push('\n');
            } else {
                s.push_str(&inline_text(child));
            }
        }
    }
    s
}

// ── Word (.docx) ────────────────────────────────────────

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";

/// 一页正文里能放下的最大宽度（px，96 dpi 下约 6.4 英寸）。
const MAX_IMG_PX: f64 = 600.0;
/// Word 的长度单位是 EMU：1 px = 9525 EMU（96 dpi）。
const EMU_PER_PX: f64 = 9525.0;

struct Docx {
    /// document.xml 里已经写好的段落
    body: String,
    /// word/_rels/document.xml.rels 里的图片关系
    rels: String,
    /// word/media/ 下的图片
    media: Vec<(String, Vec<u8>)>,
    /// 图片计数：docPr / rId / 文件名都用它
    images: usize,
}

/// doc JSON → .docx 字节，返回 (字节, 图片张数)。
pub fn to_docx(dir: &Path, doc: &Value) -> Result<(Vec<u8>, usize), String> {
    let mut cx = Docx {
        body: String::new(),
        rels: String::new(),
        media: Vec::new(),
        images: 0,
    };
    if let Some(items) = doc.get("content").and_then(|c| c.as_array()) {
        for node in items {
            docx_block(dir, node, &mut cx, 0);
        }
    }
    if cx.body.is_empty() {
        cx.body.push_str("<w:p/>");
    }

    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <w:document xmlns:w=\"{NS_W}\" xmlns:r=\"{NS_R}\" xmlns:wp=\"{NS_WP}\" \
         xmlns:a=\"{NS_A}\" xmlns:pic=\"{NS_PIC}\"><w:body>{}{}</w:body></w:document>",
        cx.body,
        "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" \
         w:bottom=\"1134\" w:left=\"1134\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/></w:sectPr>"
    );

    let styles = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <w:styles xmlns:w=\"{NS_W}\"><w:docDefaults><w:rPrDefault><w:rPr>\
         <w:rFonts w:ascii=\"Segoe UI\" w:hAnsi=\"Segoe UI\" w:eastAsia=\"Microsoft YaHei\" w:cs=\"Segoe UI\"/>\
         <w:sz w:val=\"21\"/><w:szCs w:val=\"21\"/></w:rPr></w:rPrDefault>\
         <w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"300\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault>\
         </w:docDefaults>\
         <w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>\
         <w:pPr><w:keepNext/><w:spacing w:before=\"320\" w:after=\"160\"/><w:outlineLvl w:val=\"0\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"36\"/></w:rPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>\
         <w:pPr><w:keepNext/><w:spacing w:before=\"280\" w:after=\"140\"/><w:outlineLvl w:val=\"1\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"30\"/></w:rPr></w:style>\
         <w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>\
         <w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/><w:outlineLvl w:val=\"2\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"26\"/></w:rPr></w:style>\
         </w:styles>"
    );

    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Default Extension=\"png\" ContentType=\"image/png\"/>\
         <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
         <Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
         </Types>"
        .to_string();

    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
         </Relationships>"
        .to_string();

    let doc_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
         {}</Relationships>",
        cx.rels
    );

    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("[Content_Types].xml".into(), content_types.into_bytes()),
        ("_rels/.rels".into(), root_rels.into_bytes()),
        ("word/document.xml".into(), document.into_bytes()),
        ("word/styles.xml".into(), styles.into_bytes()),
        ("word/_rels/document.xml.rels".into(), doc_rels.into_bytes()),
    ];
    for (name, bytes) in &cx.media {
        entries.push((format!("word/media/{name}"), bytes.clone()));
    }

    Ok((zip_store(&entries), cx.images))
}

fn docx_block(dir: &Path, node: &Value, cx: &mut Docx, level: usize) {
    let kind = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        "captureBlock" | "doc" => {
            if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
                for child in arr {
                    docx_block(dir, child, cx, level);
                }
            }
        }
        "paragraph" => {
            // 图片是行内节点，会和文字漂在同一行：按顺序拆成"文字段 + 图"，
            // 图单独占一段（Word 里的图和文字也不会挤在一起）
            let Some(children) = node.get("content").and_then(|c| c.as_array()) else {
                cx.body.push_str("<w:p/>");
                return;
            };
            if !children.iter().any(is_image_node) {
                let runs = docx_runs(node);
                if runs.is_empty() {
                    cx.body.push_str("<w:p/>");
                } else {
                    cx.body.push_str(&format!(
                        "<w:p><w:pPr><w:spacing w:after=\"160\"/></w:pPr>{runs}</w:p>"
                    ));
                }
                return;
            }
            let mut buf: Vec<Value> = Vec::new();
            for child in children {
                if is_image_node(child) {
                    docx_paragraph(&mut buf, cx);
                    docx_image(dir, child, cx);
                } else {
                    buf.push(child.clone());
                }
            }
            docx_paragraph(&mut buf, cx);
        }
        "heading" => {
            let depth = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1)
                .clamp(1, 3);
            let runs = docx_runs(node);
            cx.body.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"Heading{depth}\"/></w:pPr>{runs}</w:p>"
            ));
        }
        "image" => docx_image(dir, node, cx),
        "bulletList" | "orderedList" => {
            let ordered = kind == "orderedList";
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for (i, item) in items.iter().enumerate() {
                    let mark = if ordered {
                        format!("{}. ", i + 1)
                    } else {
                        "• ".to_string()
                    };
                    let mut first = true;
                    if let Some(children) = item.get("content").and_then(|c| c.as_array()) {
                        for child in children {
                            let ckind =
                                child.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            if ckind == "paragraph" {
                                let mut runs = String::new();
                                if first {
                                    runs.push_str(&docx_run(&mark, false, false, false));
                                    first = false;
                                }
                                runs.push_str(&docx_runs(child));
                                let indent = 360 + level as i64 * 360;
                                cx.body.push_str(&format!(
                                    "<w:p><w:pPr><w:ind w:left=\"{indent}\" w:hanging=\"360\"/>\
                                     <w:spacing w:after=\"60\"/></w:pPr>{runs}</w:p>"
                                ));
                            } else {
                                docx_block(dir, child, cx, level + 1);
                            }
                        }
                    }
                }
            }
        }
        "blockquote" => {
            if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
                for child in arr {
                    let runs = docx_runs(child);
                    if runs.is_empty() {
                        continue;
                    }
                    cx.body.push_str(&format!(
                        "<w:p><w:pPr><w:ind w:left=\"567\"/><w:spacing w:after=\"120\"/>\
                         <w:pBdr><w:left w:val=\"single\" w:sz=\"12\" w:space=\"8\" w:color=\"BFBFBF\"/></w:pBdr>\
                         </w:pPr>{runs}</w:p>"
                    ));
                }
            }
        }
        "codeBlock" => {
            let text = inline_text(node);
            let mut runs = String::new();
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    runs.push_str("<w:br/>");
                }
                runs.push_str(&docx_run(line, false, false, true));
            }
            cx.body.push_str(&format!(
                "<w:p><w:pPr><w:shd w:val=\"clear\" w:fill=\"F4F4F6\"/><w:spacing w:after=\"160\"/></w:pPr>{runs}</w:p>"
            ));
        }
        "horizontalRule" => {
            cx.body.push_str(
                "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"D9D9DE\"/></w:pBdr></w:pPr></w:p>",
            );
        }
        "hardBreak" => cx.body.push_str("<w:p/>"),
        _ => {
            let text = inline_text(node);
            if !text.trim().is_empty() {
                let runs = docx_run(&text, false, false, false);
                cx.body
                    .push_str(&format!("<w:p><w:pPr><w:spacing w:after=\"120\"/></w:pPr>{runs}</w:p>"));
            }
        }
    }
}

/// 把攒下的一串行内节点写成一个段落（拆图时用；空了就什么都不写）。
fn docx_paragraph(buf: &mut Vec<Value>, cx: &mut Docx) {
    if buf.is_empty() {
        return;
    }
    let runs = docx_runs(&json!({ "content": std::mem::take(buf) }));
    if runs.is_empty() {
        return;
    }
    cx.body
        .push_str(&format!("<w:p><w:pPr><w:spacing w:after=\"160\"/></w:pPr>{runs}</w:p>"));
}

/// 一段里的所有 run（文字 / 加粗 / 斜体 / 行内代码 / 换行）。
fn docx_runs(node: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
        for child in arr {
            let kind = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "hardBreak" {
                out.push_str("<w:r><w:br/></w:r>");
                continue;
            }
            if kind != "text" {
                out.push_str(&docx_runs(child));
                continue;
            }
            let text = child.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if text.is_empty() {
                continue;
            }
            let marks = child
                .get("marks")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default();
            let mut bold = false;
            let mut italic = false;
            let mut code = false;
            for mark in marks.iter() {
                match mark.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "bold" => bold = true,
                    "italic" => italic = true,
                    "code" => code = true,
                    _ => {}
                }
            }
            // 文字里的换行要变成 Word 的 <w:br/>
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    out.push_str("<w:r><w:br/></w:r>");
                }
                if !line.is_empty() {
                    out.push_str(&docx_run(line, bold, italic, code));
                }
            }
            }
    } else if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        out.push_str(&docx_run(text, false, false, false));
    }
    out
}

fn docx_run(text: &str, bold: bool, italic: bool, code: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut props = String::new();
    if code {
        props.push_str("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:eastAsia=\"Microsoft YaHei\"/>");
    }
    if bold {
        props.push_str("<w:b/>");
    }
    if italic {
        props.push_str("<w:i/>");
    }
    if code {
        props.push_str("<w:shd w:val=\"clear\" w:fill=\"F1F1F4\"/>");
    }
    let rpr = if props.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{props}</w:rPr>")
    };
    format!(
        "<w:r>{rpr}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_escape(text)
    )
}

/// 一张图 = 一个独立段落，宽度按笔记里存的显示宽度（没有就按原图，最多一栏宽）。
fn docx_image(dir: &Path, node: &Value, cx: &mut Docx) {
    let attrs = node.get("attrs").cloned().unwrap_or(Value::Null);
    let hash = attrs.get("hash").and_then(|h| h.as_str()).unwrap_or("");
    let rel_path = attrs.get("path").and_then(|p| p.as_str()).unwrap_or("");
    if !hash.is_empty() && !storage::is_image_hash(hash) {
        return;
    }
    let file = if !hash.is_empty() {
        storage::image_file(dir, hash)
    } else {
        dir.join(rel_path.replace('/', "\\"))
    };
    let Ok(bytes) = fs::read(&file) else {
        // 图没了就写一行占位文字，别导出一个空段落
        let runs = docx_run("（图片文件已不存在）", false, true, false);
        cx.body
            .push_str(&format!("<w:p><w:pPr><w:spacing w:after=\"120\"/></w:pPr>{runs}</w:p>"));
        return;
    };

    let natural_w = attrs.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let natural_h = attrs.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let shown = attrs
        .get("width")
        .and_then(|v| v.as_f64())
        .filter(|w| *w > 0.0)
        .unwrap_or(if natural_w > 0.0 { natural_w } else { 480.0 });
    let w = shown.min(MAX_IMG_PX).max(48.0);
    let h = if natural_w > 0.0 && natural_h > 0.0 {
        w * natural_h / natural_w
    } else {
        w * 0.62
    };

    cx.images += 1;
    let n = cx.images;
    let name = format!("image{n}.png");
    cx.media.push((name.clone(), bytes));
    let rid = format!("rIdImg{n}");
    cx.rels.push_str(&format!(
        "<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{name}\"/>"
    ));

    let cx_emu = (w * EMU_PER_PX).round() as i64;
    let cy_emu = (h * EMU_PER_PX).round() as i64;
    cx.body.push_str(&format!(
        "<w:p><w:pPr><w:spacing w:before=\"80\" w:after=\"160\"/></w:pPr><w:r><w:drawing>\
         <wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
         <wp:extent cx=\"{cx_emu}\" cy=\"{cy_emu}\"/>\
         <wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>\
         <wp:docPr id=\"{n}\" name=\"图片 {n}\"/>\
         <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
         <a:graphic><a:graphicData uri=\"{NS_PIC}\"><pic:pic>\
         <pic:nvPicPr><pic:cNvPr id=\"{n}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
         <pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
         <pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx_emu}\" cy=\"{cy_emu}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
         </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    ));
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 不允许的控制字符：直接丢掉，免得 Word 报"文件已损坏"
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

// ── 极简 zip（不压缩） ──────────────────────────────────

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 把若干 (文件名, 内容) 打成一个 store 方式的 zip。
///
/// 只写必要字段：本地文件头 / 中央目录 / 结尾记录。docx 只要求这是个合法 zip，
/// 不要求压缩，所以整段没有 deflate。
fn zip_store(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    // 1980-01-01 00:00 的 DOS 时间戳（有些解压工具不接受 0）
    let dos_time: u16 = 0;
    let dos_date: u16 = 0x0021;

    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;

        out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method = store
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes()); // compressed
        out.extend_from_slice(&size.to_le_bytes()); // uncompressed
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method
        central.extend_from_slice(&dos_time.to_le_bytes());
        central.extend_from_slice(&dos_date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }

    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);

    out.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // disk with cd
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmpdir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "c2g-export-{}-{}-{}",
            std::process::id(),
            storage::now_ms(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        storage::ensure_dirs(&p);
        p
    }

    fn doc() -> Value {
        json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "第一行" }] },
                {
                    "type": "captureBlock",
                    "attrs": { "ts": 1 },
                    "content": [
                        { "type": "paragraph", "content": [
                            { "type": "text", "text": "看这个 " },
                            { "type": "text", "text": "链接", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] }
                        ]},
                        { "type": "paragraph", "content": [{ "type": "text", "text": "加粗", "marks": [{ "type": "bold" }] }] }
                    ]
                },
                { "type": "image", "attrs": { "path": "images/ab/cd/x.png", "hash": "" } }
            ]
        })
    }

    #[test]
    fn markdown_保留行序_链接和图片() {
        let tmp = std::env::temp_dir();
        let (md, images) = to_markdown(&tmp, &doc());
        assert_eq!(images, 1);
        assert!(md.starts_with("第一行"), "第一行在最前：{md}");
        assert!(md.contains("看这个 [链接](https://example.com)"), "{md}");
        assert!(md.contains("**加粗**"), "{md}");
        assert!(md.contains("![](../images/ab/cd/x.png)"), "{md}");
        assert!(md.ends_with('\n'));
    }

    #[test]
    fn markdown_空文档也不炸() {
        let (md, images) = to_markdown(
            &std::env::temp_dir(),
            &json!({ "type": "doc", "content": [] }),
        );
        assert!(md.is_empty());
        assert_eq!(images, 0);
    }

    #[test]
    fn markdown_段落里的行内图按顺序拆出来() {
        // 图片是行内节点：它和文字漂在同一段里，导出时要拆成"文字段 + 图"
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "captureBlock",
                    "content": [{
                        "type": "paragraph",
                        "content": [
                            { "type": "text", "text": "图前" },
                            {
                                "type": "image",
                                "attrs": { "path": "images/ab/cd/y.png", "hash": "" }
                            },
                            { "type": "text", "text": "图后" }
                        ]
                    }]
                }
            ]
        });

        let (md, images) = to_markdown(&std::env::temp_dir(), &doc);
        assert_eq!(images, 1);
        let blocks: Vec<&str> = md.split("\n\n").map(|s| s.trim_end_matches('\n')).collect();
        assert_eq!(blocks[0], "图前", "{md}");
        assert!(blocks[1].contains("![](../images/ab/cd/y.png)"), "{md}");
        assert_eq!(blocks[2], "图后", "{md}");
    }

    #[test]
    fn docx_是合法_zip_且包含正文与关系() {
        // 用一张真图，才能走到 word/media 那条路
        let dir = tmpdir();
        let img = image::RgbaImage::from_pixel(8, 4, image::Rgba([9, 9, 9, 255]));
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let (rel, hash, w, h) = storage::save_image(&dir, &png).unwrap();

        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "captureBlock",
                "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "带图的" }] },
                    { "type": "image", "attrs": { "path": rel, "hash": hash, "w": w, "h": h } }
                ]
            }]
        });

        let (bytes, images) = to_docx(&dir, &doc).unwrap();
        assert_eq!(images, 1);
        assert_eq!(&bytes[0..4], &0x0403_4B50u32.to_le_bytes(), "zip 本地头");

        // 结尾记录里的条目数：5 个固定部件 + 1 张图
        let eocd = bytes.len() - 22;
        assert_eq!(
            &bytes[eocd..eocd + 4],
            &0x0605_4B50u32.to_le_bytes(),
            "zip 结尾记录"
        );
        let count = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]);
        assert_eq!(count, 6, "条目数");

        // 中央目录里必须能看到 document.xml 和 media/image1.png
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("word/document.xml"));
        assert!(text.contains("word/media/image1.png"));
        assert!(text.contains("r:embed=\"rIdImg1\"") || text.contains("rIdImg1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crc32_和标准实现一致() {
        // "123456789" 的 CRC-32 是 0xCBF43926
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    /// 手写一个样张（含图、链接、加粗），用来看 Word 里到底长什么样：
    /// `cargo test 导出样张 -- --ignored --nocapture`
    #[test]
    #[ignore = "只用来生成人工检查的样张"]
    fn 导出样张() {
        let dir = tmpdir();
        let img = image::RgbaImage::from_pixel(320, 180, image::Rgba([40, 90, 200, 255]));
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let (rel, hash, w, h) = storage::save_image(&dir, &png).unwrap();
        storage::set_image_note(&dir, &hash, "蓝色方块：图片备注会跟着导出").unwrap();

        let note = storage::create(&dir, "样张").unwrap();
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "今天下午三点产品和设计的对一下" }] },
                { "type": "captureBlock", "content": [
                    { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "待办" }] },
                    { "type": "paragraph", "content": [
                        { "type": "text", "text": "看 " },
                        { "type": "text", "text": "这个链接", "marks": [{ "type": "link", "attrs": { "href": "https://example.com/a" } }] },
                        { "type": "text", "text": "，另外 " },
                        { "type": "text", "text": "加粗一段", "marks": [{ "type": "bold" }] }
                    ]},
                    { "type": "image", "attrs": { "path": rel, "hash": hash, "w": w, "h": h, "width": 300 } },
                    { "type": "paragraph" }
                ]}
            ]
        });
        storage::save(&dir, &note.id, doc).unwrap();

        let md = export_note(&dir, &note.id, "md", "20261030-190000").unwrap();
        let docx = export_note(&dir, &note.id, "docx", "20261030-190000").unwrap();
        println!("MARKDOWN {}", md.path);
        println!("DOCX {}", docx.path);
        println!("{}", std::fs::read_to_string(&md.path).unwrap());
    }

    #[test]
    fn 文件名里的非法字符被替换() {
        assert_eq!(file_stem("会议: 下午/三点"), "会议_ 下午_三点");
        assert_eq!(file_stem("   "), "笔记");
        assert_eq!(normalize_stamp("20261030-185300"), "20261030-185300");
        assert_eq!(normalize_stamp("a/,2026"), "2026");
    }
}