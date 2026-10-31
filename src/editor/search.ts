import type { Editor } from '@tiptap/react'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

/**
 * 搜索结果跳转：在当前笔记里找到第一处命中，选中并滚过去。
 *
 * 位置在浏览器里现算，而不是让 Rust 算好传过来 —— ProseMirror 的位置按
 * UTF-16 码元计数，跟 Rust 的 char 下标不是一回事，现算最稳。
 */
export function revealMatch(editor: Editor, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  const { doc } = editor.state

  let from = -1
  let to = -1
  doc.descendants((node, pos) => {
    if (from >= 0) return false
    if (node.isText && node.text) {
      const i = node.text.toLowerCase().indexOf(q)
      if (i >= 0) {
        from = pos + i
        to = pos + i + q.length
      }
    }
  })
  if (from < 0) return false
  try {
    const tr = editor.state.tr
      .setSelection(TextSelection.create(doc, from, to))
      .scrollIntoView()
    editor.view.dispatch(tr)
    return true
  } catch {
    return false
  }
}

/**
 * 图片备注的跳转：备注文字不在正文里，只能按 hash 找到那张图，选中它、滚过去。
 * 同一张图出现多次就选第一处。
 */
export function revealImage(editor: Editor, hash: string): boolean {
  if (!hash) return false
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false
    if (node.type.name === 'image' && node.attrs.hash === hash) at = pos
  })
  if (at < 0) return false
  try {
    const tr = editor.state.tr
      .setSelection(NodeSelection.create(editor.state.doc, at))
      .scrollIntoView()
    editor.view.dispatch(tr)
    return true
  } catch {
    return false
  }
}