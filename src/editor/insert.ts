import type { Editor } from '@tiptap/react'

export type Capture = {
  kind: 'text' | 'image'
  ts: number
  text?: string | null
  path?: string | null
  hash?: string | null
  w?: number | null
  h?: number | null
  truncated?: boolean
}

/**
 * 把一次捕获转成 captureBlock 节点 JSON。
 * 卡片里只有内容本身 —— 不展示时间，也不展示来源进程。
 */
export function buildNode(cap: Capture) {
  const children: any[] = []

  if (cap.kind === 'text') {
    const lines = (cap.text ?? '').split(/\r?\n/)
    for (const line of lines) {
      children.push(
        line
          ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
          : { type: 'paragraph' },
      )
    }
    if (cap.truncated) {
      children.push({
        type: 'paragraph',
        content: [{ type: 'text', text: '（内容过长，已截断到 1 MB）' }],
      })
    }
  } else {
    children.push({
      type: 'image',
      attrs: { path: cap.path, hash: cap.hash, alt: '', title: null },
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
 */
export function appendCapture(editor: Editor, cap: Capture) {
  const at = editor.state.doc.content.size
  editor.chain().insertContentAt(at, buildNode(cap)).run()
}