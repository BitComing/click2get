//! 图片 OCR：直接用 Windows 自带的 `Windows.Media.Ocr`。
//!
//! 不引第三方模型（tesseract 的包体、语言数据、识别质量都不划算）：
//! 系统 OCR 是离线的、随语言包更新，中文识别对截图足够用。
//!
//! 调用要点：
//! - WinRT 的异步接口返回 IAsyncOperation，这里用一个极简的阻塞轮询把它跑完；
//! - WinRT 激活需要在初始化过 COM 的线程上，独立线程里 CoInitializeEx 一次最省心；
//! - OcrEngine 对图片尺寸有上限（一般 2600px），超了先等比缩小再识别。

use std::future::IntoFuture;
use std::path::Path;

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// 识别一张内容寻址的图片，返回纯文本（可能为空）。
pub fn recognize_image(dir: &Path, hash: &str) -> Result<String, String> {
    if !crate::storage::is_image_hash(hash) {
        return Err("非法的图片 id".into());
    }
    let path = crate::storage::image_file(dir, hash);
    if !path.exists() {
        return Err("图片文件不存在".into());
    }
    std::thread::spawn(move || recognize(&path))
        .join()
        .map_err(|_| "OCR 线程异常退出".to_string())?
}

fn recognize(path: &Path) -> Result<String, String> {
    unsafe {
        // 线程已经在别的套间里也没关系（RPC_E_CHANGED_MODE），继续用现有套间
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let img = image::open(path).map_err(|e| format!("图片解码失败：{e}"))?;
    let img = limit_size(img)?;

    let mut rgba = img.to_rgba8();
    // Windows 的原生像素顺序是 BGRA
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let (w, h) = (rgba.width() as i32, rgba.height() as i32);

    let writer = DataWriter::new().map_err(werr)?;
    writer.WriteBytes(rgba.as_raw()).map_err(werr)?;
    let buffer = writer.DetachBuffer().map_err(werr)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        w,
        h,
        BitmapAlphaMode::Ignore,
    )
    .map_err(werr)?;

    let engine = create_engine()?;
    let op = engine.RecognizeAsync(&bitmap).map_err(werr)?;
    let result = block_on(op.into_future()).map_err(werr)?;
    let text = result.Text().map_err(werr)?.to_string();
    Ok(normalize(&text))
}

/// 优先中文引擎；装了中文语言包的 Windows 才会有，没有就退回用户语言，再不行报错。
fn create_engine() -> Result<OcrEngine, String> {
    for tag in ["zh-Hans", "zh-Hant", "en-US"] {
        let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag)) else {
            continue;
        };
        if OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Ok(engine);
            }
        }
    }
    OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| {
        "系统里没有可用的 OCR 语言包（设置 → 时间和语言 → 语言 里添加中文的 OCR 组件）".to_string()
    })
}

/// 超过引擎上限就等比缩到上限内。
fn limit_size(img: image::DynamicImage) -> Result<image::DynamicImage, String> {
    let max = OcrEngine::MaxImageDimension().map_err(werr)? as u32;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("图片尺寸为空".into());
    }
    if max == 0 || (w <= max && h <= max) {
        return Ok(img);
    }
    let ratio = (max as f64 / w.max(h) as f64).min(1.0);
    let nw = ((w as f64 * ratio).round() as u32).max(1);
    let nh = ((h as f64 * ratio).round() as u32).max(1);
    Ok(img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3))
}

fn normalize(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    tidy_cjk(&unified).trim().to_string()
}

/// Windows OCR 会把每个汉字当成一个"词"，用空格隔开（"今 天 下 午"）。
/// 直接写进备注会让搜索"今天"搜不到，这里把汉字之间的空白（含换行）全部去掉；
/// 汉字和英文/数字之间的空格保留，免得 "CPU 2 核" 变成 "CPU2核"。
fn tidy_cjk(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !c.is_whitespace() {
            out.push(c);
            i += 1;
            continue;
        }
        let mut j = i;
        let mut has_newline = false;
        while j < chars.len() && chars[j].is_whitespace() {
            if chars[j] == '\n' {
                has_newline = true;
            }
            j += 1;
        }
        let prev = out.chars().last();
        let next = chars.get(j).copied();
        let drop_space = matches!((prev, next), (Some(p), Some(n)) if is_cjk(p) && is_cjk(n));
        if !drop_space {
            out.push(if has_newline { '\n' } else { ' ' });
        }
        i = j;
    }
    out
}

/// 中文汉字与中文标点（含全角）。OCR 的中文断词就发生在这类字符之间。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F   // 中文标点
        | 0x3400..=0x4DBF // 扩展 A
        | 0x4E00..=0x9FFF // 基本汉字
        | 0xF900..=0xFAFF // 兼容汉字
        | 0xFE30..=0xFE4F // 兼容标点
        | 0xFF00..=0xFFEF // 全角字符
        | 0x20000..=0x2FA1F // 扩展 B 及以后
    )
}

fn werr(e: windows::core::Error) -> String {
    format!("OCR 失败：{e}")
}

/// 极简 block_on：WinRT 的 IAsyncOperation 已经实现 IntoFuture，轮询等它完成即可。
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }

    let waker = Waker::from(Arc::new(Noop));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(v) => return v,
            Poll::Pending => std::thread::sleep(std::time::Duration::from_millis(15)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 中文之间的空格要压掉() {
        assert_eq!(tidy_cjk("今 天 下 午 三 点"), "今天下午三点");
        assert_eq!(tidy_cjk("剪 贴\n板 捕 获"), "剪贴板捕获");
        assert_eq!(tidy_cjk("CPU 2 核"), "CPU 2 核");
        assert_eq!(tidy_cjk("第 一 段\nCPU 2 核"), "第一段\nCPU 2 核");
        assert_eq!(tidy_cjk("Hello  World"), "Hello World");
    }

    /// 真机冒烟：拿仓库里的界面截图过一遍 OCR。
    /// 手动跑：`cargo test ocr_冒烟 -- --ignored --nocapture`
    #[test]
    #[ignore = "依赖本机的 Windows OCR 语言包，默认不跑"]
    fn ocr_冒烟() {
        let path = std::path::Path::new("../docs/ui-light.png");
        if !path.exists() {
            eprintln!("没有找到测试截图，跳过");
            return;
        }
        let text = recognize(path).expect("OCR 应该能跑通");
        println!("识别结果：\n{text}");
        assert!(!text.trim().is_empty(), "界面截图里应该能认出文字");
    }
}