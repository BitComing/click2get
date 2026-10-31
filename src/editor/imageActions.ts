import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** 位置上的图片节点；不是图片就 null。 */
export function imageNodeAt(view: EditorView, pos: number): PMNode | null {
  if (pos < 0) return null
  const node = view.state.doc.nodeAt(pos)
  return node && node.type.name === 'image' ? node : null
}

/** 选中一张图（右键菜单 / 点一下图片都走这里）。 */
export function selectImage(view: EditorView, pos: number) {
  if (!imageNodeAt(view, pos)) return
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
}

/**
 * 正文可用宽度（px）：图片最多铺满一栏。
 * 用编辑区自身的盒子算，不猜 720 这个数字。
 */
export function contentWidthOf(dom: HTMLElement): number {
  const cs = window.getComputedStyle(dom)
  const pl = Number.parseFloat(cs.paddingLeft) || 0
  const pr = Number.parseFloat(cs.paddingRight) || 0
  const w = dom.clientWidth - pl - pr
  return w > 0 ? Math.floor(w) : 640
}

export function contentWidth(view: EditorView): number {
  return contentWidthOf(view.dom as HTMLElement)
}

/**
 * 设置图片显示宽度。width 传 null 表示回到"原始大小"（由 CSS 的 max-width 兜住）。
 * 只写 width，不动 height —— 比例交给 height:auto。
 */
export function setImageWidth(view: EditorView, pos: number, width: number | null) {
  const node = imageNodeAt(view, pos)
  if (!node) return
  const next = width == null ? null : Math.max(24, Math.round(width))
  const tr = view.state.tr
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: next })
  tr.setSelection(NodeSelection.create(tr.doc, pos))
  view.dispatch(tr)
}

/**
 * 从正文里删掉一张图。
 *
 * 图片是行内节点，独占一行的时候整行（段落）一起删，别留一行看不见内容的空白；
 * 如果是"文字 + 图"混在一行，就只删图，文字留着。
 * （老笔记里块级的图：块里只有它时整块一起删，否则会留下一个空块。）
 */
export function deleteImageAt(view: EditorView, pos: number): boolean {
  const node = imageNodeAt(view, pos)
  if (!node) return false
  const doc = view.state.doc
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  let from = pos
  let to = pos + node.nodeSize
  // 这一行/块里只有这张图：整行一起删
  if (parent.childCount === 1 && (parent.isTextblock || parent.type.name === 'captureBlock')) {
    from = $pos.before($pos.depth)
    to = $pos.after($pos.depth)
  }

  const tr = view.state.tr
  // 整篇就只有这一张图：删完会变成空文档（doc 的 content 是 block+），换一个空段落
  if (from === 0 && to === doc.content.size) {
    tr.replaceWith(0, to, view.state.schema.nodes.paragraph.create())
  } else {
    tr.delete(from, to)
  }
  view.dispatch(tr.scrollIntoView())
  return true
}

/** 选中的是不是一张图（键盘 Delete / 右键菜单用）。 */
export function selectedImagePos(view: EditorView): number {
  const sel = view.state.selection
  return sel instanceof NodeSelection && sel.node.type.name === 'image' ? sel.from : -1
}

/** 取消图片选中（开弹层时用，免得虚线框和手柄留在弹层后面）。 */
export function clearImageSelection(view: EditorView) {
  const sel = view.state.selection
  if (!(sel instanceof NodeSelection)) return
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.from)))
  } catch {
    /* 文档刚被改动过，位置对不上就算了 */
  }
}