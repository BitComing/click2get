import type { Editor } from '@tiptap/react'

export type Capture = {
  kind: 'text' | 'image'
  ts: number
  text?: string | null
  path?: string | null
  hash?: string | null
  w?: number | null
  h?: number | null
  /** 剪切板 HTML 里带出来的网址（复制的是"链接文字"而不是"网址"时才有） */
  href?: string | null
  truncated?: boolean
}

/** 链接标记的通用属性：外链一律 noopener，点击由 App 的 handleClick 接管。 */
export function linkMark(href: string) {
  return {
    type: 'link',
    attrs: { href, target: null, rel: 'noopener noreferrer nofollow', class: null },
  }
}

/**
 * 网址识别：http(s):// 和 www. 开头都算。
 * 结尾的标点是句读，不属于网址，单独留下来。
 */
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`，。；：！？、）】》」』]+/gi
const TRAILING = /[.,;:!?)\]}>"'，。；：！？、）】》」』…]+$/

function trimUrl(raw: string): string {
  let u = raw
  while (u.length > 1 && TRAILING.test(u)) u = u.slice(0, -1)
  return u
}

function hrefOf(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url
}

/**
 * 把一段文字拆成 text / link 两种节点。
 * 剪切板里抄来的东西经常是"一句话里夹着个网址"，让它直接可点比记一串死链有用。
 */
export function linkifyText(text: string): any[] {
  const out: any[] = []
  if (!text) return out
  const re = new RegExp(URL_RE.source, 'gi')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const url = trimUrl(m[0])
    if (!url) continue
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) })
    out.push({ type: 'text', text: url, marks: [linkMark(hrefOf(url))] })
    last = start + url.length
    // 结尾标点被留下时，把游标退回去，别让下一轮从标点后面开始找
    if (url.length < m[0].length) re.lastIndex = last
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/**
 * 换行的各种写法：`\n`、`\r\n`、单独的 `\r`，以及 Unicode 的行分隔符 / 段分隔符。
 *
 * 只认 `\n` 是不够的：网页翻译插件、PDF 阅读器、老式 Windows 程序都会给单独的 `\r`
 * 或者 U+2028/2029。拆不开的话，整段内容会原样挤进一个文本节点里 —— 那些字符在
 * 渲染时看不见，于是"复制进来是好几行，落到笔记里成了一行"。
 */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029\u000b\u000c]/

/**
 * 复制来的多行文字按**行**落地：一行一个段落（行就是编辑单位），空行不落地。
 *
 * 为什么不再把多行塞进一个段落里（用硬换行）：
 * - 原文的行与行之间是换行，落到笔记里也应该是一行一行分开的 ——
 *   全塞进一个段落，整段就变成"一行"，选行、拖动、合并多行都只认这一整段，
 *   用户看到的就是"原来的换行被删掉了"；
 * - 但空行不是内容：连续换行 / 只有空白的行都不落成空段落，
 *   否则粘一段话进来就凭空多出几个空行，看着像被人按了几下回车。
 *
 * 行首的缩进照原样留着（渲染是 pre-wrap），只有"整行空白"才丢掉。
 */
function buildTextParagraphs(lines: string[], forcedHref: string | null): any[] {
  const out: any[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    out.push({
      type: 'paragraph',
      content: forcedHref
        ? [{ type: 'text', text: line, marks: [linkMark(forcedHref)] }]
        : linkifyText(line),
    })
  }
  return out
}

/**
 * 复制来的图默认显示多宽。
 *
 * 和 styles.css 的 `--img-default`（420px）一个数：图再大也就铺到这么宽。
 * 在这之上按**长宽**再收一收 ——
 * - 长的图（高 > 宽，比如整屏长截图）：比默认小一点，一张图别占掉一整屏；
 * - 宽的图（高 < 宽，比如横屏截图 / 风景照）：收得更多一些，横图不该铺得比正文还抢眼。
 *
 * 不知道原始尺寸（w / h 缺失）就返回 null，交给 CSS 的默认宽度兜住。
 * 这只是"插进来时的初始宽度"，插完还能拖右下角手柄改，不受这里限制。
 */
export const IMG_DEFAULT_W = 420
const TALL_SCALE = 0.85
const WIDE_SCALE = 0.62

export function defaultImageWidth(w?: number | null, h?: number | null): number | null {
  const nw = Number(w) || 0
  const nh = Number(h) || 0
  if (nw <= 0 || nh <= 0) return null
  const scale = nh > nw ? TALL_SCALE : nh < nw ? WIDE_SCALE : 1
  return Math.max(48, Math.round(Math.min(nw, IMG_DEFAULT_W * scale)))
}

/**
 * 把一次捕获转成 captureBlock 节点 JSON。
 * 卡片里只有内容本身 —— 不展示时间，也不展示来源进程。
 *
 * 复制来的多行文字**一行一个段落**（行就是编辑单位，见 buildTextParagraphs），
 * 空行不落地：原文的换行留成段间距，原文的空行不额外撑出一行。
 */
export function buildNode(cap: Capture) {
  const children: any[] = []

  if (cap.kind === 'text') {
    const lines = (cap.text ?? '').split(LINE_BREAK)
    // 链接文字整段只有一个链接时才有 href，多行的情况交给逐行识别
    const forced = cap.href && lines.filter((l) => l.trim()).length === 1 ? cap.href : null
    const paragraphs = buildTextParagraphs(lines, forced)
    if (cap.truncated) {
      paragraphs.push({
        type: 'paragraph',
        content: [{ type: 'text', text: '（内容过长，已截断到 1 MB）' }],
      })
    }
    if (paragraphs.length === 0) paragraphs.push({ type: 'paragraph' })
    children.push(...paragraphs)
  } else {
    // 图片是行内节点，必须挂在段落里：外面这层段落就是"图片这一行"，
    // 光标能停在图片前面或后面（见 extensions.ts 里 CaptureImage 的注释）
    children.push({
      type: 'paragraph',
      content: [
        {
          type: 'image',
          attrs: {
            path: cap.path,
            hash: cap.hash,
            w: cap.w ?? null,
            h: cap.h ?? null,
            // 按长宽比给一个初始宽度（详见 defaultImageWidth）
            width: defaultImageWidth(cap.w, cap.h),
            alt: '',
            title: null,
          },
        },
      ],
    })
  }

  // captureBlock 的 content 是 block+，至少要有一个块
  if (children.length === 0) children.push({ type: 'paragraph' })

  return {
    type: 'captureBlock',
    attrs: { ts: cap.ts },
    content: children,
  }
}

/**
 * 追加到文档末尾。
 * 注意：绝不调用 .focus() —— 用户正在别的程序里复制，
 * 抢焦点会让人以为"复制了一下，怎么跳走了"。
 *
 * updateSelection: false 也是同一个意思：不动光标。
 * 否则每来一条捕获，选区就跳到新块上（图片还会被整块选中，
 * 虚框和 Delete 都会跟过来），正在写的那句话就被打断了。
 */
export function appendCapture(editor: Editor, cap: Capture) {
  const at = editor.state.doc.content.size
  editor.chain().insertContentAt(at, buildNode(cap), { updateSelection: false }).run()
}