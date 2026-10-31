/**
 * 收纳箱：拖起来的**那几行**（或那张图）先临时放到一边，攒够了再在光标处放出来。
 *
 * 和"拖动 = 搬家"是一回事，只是搬家的目的地不写死：
 * 拖到正文里 = 换位置；拖到侧栏笔记 = 搬进那篇；拖到删除图标 = 扔掉；
 * 拖到**收纳箱** = 先存着 —— 可以跨笔记地一件一件攒，最后放到任意光标处。
 *
 * 存的是块的 JSON（图片是行内节点，跟着 JSON 走），所以：
 * - 图片本身在 `images/` 里是内容寻址的，正文里删掉节点不会删文件，箱子里那份还能插回去；
 * - 箱子只进 localStorage（一条界面级的暂存，不进笔记数据、不占后台接口），
 *   关掉应用再打开，攒着的东西还在。
 *
 * 这里只有纯数据与纯函数（预览、读写），界面在 CollectBox.tsx。
 */

export type CollectItem = {
  id: string
  /** 收进箱子的时间（列表按收集顺序排，新的在上） */
  at: number
  /** 从哪篇笔记收来的：只用来显示"来自哪一篇" */
  noteId: string | null
  noteTitle: string
  /** 这几行的块级 JSON，放出来时原样插回文档 */
  blocks: any[]
}

/** 箱子最多攒多少条：太多了既看不清，也容易一把插错地方。 */
export const COLLECT_MAX = 40

const STORAGE_KEY = 'c2g.collect-box.v1'

/** 预览里最多显示几行 / 每行截到几个字（再长就交给"展开"去管，列表要扫得快）。 */
const PREVIEW_ROWS = 3
const PREVIEW_CHARS = 46

/** 一个节点里的纯文字（图片不算字，硬换行算换行）。 */
function textOf(node: any): string {
  if (!node || typeof node !== 'object') return ''
  if (node.type === 'text') return String(node.text ?? '')
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'image') return ''
  const kids = Array.isArray(node.content) ? node.content : []
  return kids.map(textOf).join('')
}

export type CollectPreview = {
  /** 前几行的文字（截断过）；纯图片的条目是空串 */
  text: string
  /** 里面有几张图 */
  images: number
  /** 第一张图的相对路径（列表左边的小缩略图） */
  thumb: string | null
  /** 一共几行（非空行） */
  rows: number
}

/**
 * 一条内容在列表里长什么样：前几行文字、几张图、第一张图的路径。
 *
 * 块结构可能有多层（捕获块 > 段落 / 图片行），所以按"段落"收行、按"图片"计数，
 * 别的层（captureBlock、blockquote…）只是往下走一层。
 */
export function previewOf(blocks: any[]): CollectPreview {
  const lines: string[] = []
  const acc = { images: 0, thumb: null as string | null }

  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'image') {
      acc.images++
      const path = node.attrs?.path
      if (!acc.thumb && path) acc.thumb = String(path)
      return
    }
    if (node.type === 'paragraph' || node.type === 'heading') {
      lines.push(textOf(node))
      return
    }
    for (const kid of Array.isArray(node.content) ? node.content : []) walk(kid)
  }
  for (const block of Array.isArray(blocks) ? blocks : []) walk(block)

  const filled = lines.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
  const shown = filled
    .slice(0, PREVIEW_ROWS)
    .map((l) => (l.length > PREVIEW_CHARS ? `${l.slice(0, PREVIEW_CHARS)}…` : l))
  return { text: shown.join('\n'), images: acc.images, thumb: acc.thumb, rows: filled.length }
}

/** 列表里那一行小字：来自哪篇、几行 / 几张图。 */
export function metaOf(item: CollectItem, preview: CollectPreview): string {
  const parts: string[] = []
  if (preview.rows > 0) parts.push(`${preview.rows} 行`)
  if (preview.images > 0) parts.push(`${preview.images} 张图`)
  if (parts.length === 0) parts.push('空内容')
  const from = item.noteTitle ? `来自「${item.noteTitle}」` : '来自别处'
  return `${from} · ${parts.join(' · ')}`
}

/** 新收进来的一条。id 只要在这一次会话里不重复就够（列表 key / 删除用）。 */
export function makeCollectItem(opts: {
  blocks: any[]
  noteId: string | null
  noteTitle: string
}): CollectItem {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    noteId: opts.noteId,
    noteTitle: opts.noteTitle || '无标题笔记',
    blocks: opts.blocks,
  }
}

/**
 * 读回收纳箱。localStorage 里的东西一律当**不可信输入**：
 * 不是数组、条目缺 blocks、blocks 不是数组的，全部丢掉，别让一条坏数据把界面带崩。
 */
export function readCollectBox(): CollectItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    const out: CollectItem[] = []
    for (const it of list) {
      if (!it || typeof it !== 'object') continue
      const rec = it as Record<string, unknown>
      const blocks = rec.blocks
      if (!Array.isArray(blocks) || blocks.length === 0) continue
      out.push({
        id: String(rec.id ?? `restored-${out.length}`),
        at: Number(rec.at) || 0,
        noteId: rec.noteId ? String(rec.noteId) : null,
        noteTitle: String(rec.noteTitle ?? ''),
        blocks,
      })
      if (out.length >= COLLECT_MAX) break
    }
    return out
  } catch {
    return []
  }
}

/** 写回收纳箱：失败（本地存储满 / 被禁用）返回 false，调用方据此放弃这次收集。 */
export function writeCollectBox(items: CollectItem[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    return true
  } catch {
    return false
  }
}