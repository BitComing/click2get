import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * 捕获去重：同样的东西**在进入笔记之前**就拦住，而不是记完再删。
 *
 * 判据只有两条，都好解释：
 * - 文字：把内容按行拆开（每行去掉首尾空白、去掉首尾空行）后，和笔记里某个捕获块的
 *   逐行内容完全相同，就算重复。只比"整块"，不做子串匹配 —— 否则笔记里有一句
 *   "好的，我马上处理"，用户复制一个"好的"也会被吞掉。
 * - 图片：按内容 hash 比。图片文件本来就是内容寻址的，同一个 hash 就是同一张图。
 *
 * 纯函数，`docs/test-dedupe.ts` 覆盖。
 */

export type DupHit = {
  kind: 'text' | 'image'
  /** 命中位置：文字是块的起点，图片是图片节点的位置 */
  from: number
  to: number
  /** 命中的行数（图片算 1 行） */
  rows: number
}

/** 按行规整：统一换行符、每行去首尾空白、去掉首尾空行。 */
export function normalizeCaptureText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

export type CaptureLike = {
  kind: string
  text?: string | null
  hash?: string | null
}

/**
 * 一行里按"硬换行"拆开后的各段。
 *
 * 复制进来的多行文字现在落成**一个段落里的若干 <br>**（见 insert.buildNode），
 * 所以判断重复时不能只看 `textContent`（硬换行没有文字，会粘成一长串），
 * 得把 hardBreak 当成换行读出来。
 */
function blockLines(node: PMNode): string[] {
  if (!node.isTextblock) return []
  const text = node.textBetween(0, node.content.size, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '',
  )
  return text.split('\n')
}

/**
 * 在文档里找这条捕获的"原件"。
 * 命中返回它的位置（调用方拿去闪烁 / 提示），没命中返回 null。
 */
export function findDuplicate(doc: PMNode, cap: CaptureLike): DupHit | null {
  if (cap.kind === 'image') {
    const hash = cap.hash ?? ''
    if (!hash) return null
    let hit: DupHit | null = null
    doc.descendants((node, pos) => {
      if (hit) return false
      if (node.type.name === 'image' && String(node.attrs?.hash ?? '') === hash) {
        hit = { kind: 'image', from: pos, to: pos + node.nodeSize, rows: 1 }
        return false
      }
      return true
    })
    return hit
  }

  const target = normalizeCaptureText(cap.text ?? '')
  // 一两个字的重复没什么信息量，但也确实是"同一段内容"；空内容本来就进不来
  if (!target) return null

  let hit: DupHit | null = null
  doc.forEach((node, offset) => {
    if (hit) return false
    if (node.type.name === 'captureBlock') {
      const lines: string[] = []
      node.forEach((child) => {
        if (child.isTextblock) lines.push(...blockLines(child))
      })
      if (lines.length > 0 && normalizeCaptureText(lines.join('\n')) === target) {
        hit = { kind: 'text', from: offset, to: offset + node.nodeSize, rows: lines.length }
        return false
      }
      return true
    }
    // 用户手打的行（不在捕获块里）也算：复制一段自己已经写过的话，同样不该记第二遍
    if (node.isTextblock) {
      if (normalizeCaptureText(blockLines(node).join('\n')) === target) {
        hit = { kind: 'text', from: offset, to: offset + node.nodeSize, rows: 1 }
        return false
      }
    }
    return true
  })
  return hit
}