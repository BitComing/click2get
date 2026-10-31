import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
// 带 .ts 后缀：docs 下的回归脚本用 node 直接跑，它不会替我们补后缀
import { expandToRows } from './moveRange.ts'

/**
 * 行的两种形态之间的转换：
 *
 * - **拆解成多行**：把行内的硬换行（Shift+Enter / 复制进来的换行，文档里是 hardBreak）
 *   拆成一段一段的行。复制进来的一大段文字想改成"一行一行"时用。
 * - **合并多行**：把选中的几行并成一行，原来行与行之间变成硬换行。
 *   把它们当成"一段里的几行"来编辑、复制走时用。
 *
 * 两个都是纯函数：只依赖 EditorState / PMNode，`docs/test-row-ops.ts` 覆盖。
 * 返回值沿用 lineOps 的约定：null = 这件事在这些位置上做不成。
 */

/** 位置范围内的硬换行（行内换行）位置，从前往后。 */
function inlineBreakPositions(doc: PMNode, from: number, to: number): number[] {
  const out: number[] = []
  if (from < 0 || to > doc.content.size || to <= from) return out
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'hardBreak' && pos >= from && pos + node.nodeSize <= to) {
      out.push(pos)
    }
    return true
  })
  return out
}

/** 选中范围里有几个行内换行。右键菜单用它决定"拆解成多行"能不能点。 */
export function countInlineBreaks(doc: PMNode, from: number, to: number): number {
  return inlineBreakPositions(doc, from, to).length
}

/** 把文档里的位置收成"能放文字光标"的位置（落在块边界上时找最近的文字）。 */
function textPosNear(doc: PMNode, pos: number, dir: 1 | -1): number | null {
  const at = Math.min(Math.max(pos, 0), doc.content.size)
  let $pos
  try {
    $pos = doc.resolve(at)
  } catch {
    return null
  }
  if ($pos.parent.isTextblock) return at
  try {
    return TextSelection.near($pos, dir).$head.pos
  } catch {
    return null
  }
}

/**
 * 操作完把选区落在被改动的这几行上（整行选中），接着复制 / 再拆 / 再合都顺手。
 * 位置经过 mapping 之后可能落在块边界上，textPosNear 会自己找最近的文字位置。
 */
function selectRowsAround(tr: Transaction, from: number, to: number) {
  const a = textPosNear(tr.doc, from, 1)
  const b = textPosNear(tr.doc, to, -1)
  if (a !== null && b !== null && b > a) {
    try {
      tr.setSelection(TextSelection.create(tr.doc, a, b))
      return
    } catch {
      /* 结构特殊，退回光标 */
    }
  }
  const at = a ?? b
  if (at === null) return
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(at)))
  } catch {
    /* 光标放不下就算了，内容已经改对 */
  }
}

/**
 * 拆解成多行：把 [from, to) 里的每个行内换行变成一次"分段"。
 *
 * 从后往前拆（后面的先拆，前面位置的坐标就不会被前面的拆分带动）。
 * 选区只盖住半行也没关系：拆的是换行本身，那一行剩下的文字仍然跟着它这一边。
 */
export function splitInlineBreaks(
  state: EditorState,
  from: number,
  to: number,
): Transaction | null {
  const breaks = inlineBreakPositions(state.doc, from, to)
  if (breaks.length === 0) return null

  const tr = state.tr
  let changed = false
  for (let i = breaks.length - 1; i >= 0; i--) {
    const pos = breaks[i]
    let $break
    try {
      $break = tr.doc.resolve(pos)
    } catch {
      continue
    }
    const node = $break.parent
    if (!node.isTextblock) continue
    const start = $break.before($break.depth)
    const offset = pos - start - 1
    if (offset < 0 || offset >= node.content.size) continue
    try {
      // 硬换行本身不属于任何一边：左边到它前面，右边从它后面开始
      const left = node.content.cut(0, offset)
      const right = node.content.cut(offset + 1)
      tr.replaceWith(start, start + node.nodeSize, [
        node.type.create(node.attrs, left),
        node.type.create(node.attrs, right),
      ])
      changed = true
    } catch {
      /* 这一处结构特殊，跳过，别把整次操作搞崩 */
    }
  }
  if (!changed) return null

  selectRowsAround(tr, tr.mapping.map(from, -1), tr.mapping.map(to, 1))
  return tr
}

type Row = {
  node: PMNode
  /** 行在文档里的起点（段落节点本身的位置） */
  pos: number
  /** 行挂在哪个容器下面（同一批能合并的行必须同父） */
  parent: PMNode | null
}

/**
 * 选区里"能合并的几行"：同一父节点下、紧挨着的几个段落。
 *
 * 只返回至少两行的组 —— 一行没什么可合并的。跨捕获块 / 中间夹着图片行、
 * 列表项的边界都会断开成不同的组，各合各的。
 */
export function mergeableRuns(doc: PMNode, from: number, to: number): Row[][] {
  if (from < 0 || to > doc.content.size || to <= from) return []
  const span = expandToRows(doc, from, to)
  if (!span) return []

  const rows: Row[] = []
  doc.nodesBetween(span.from, span.to, (node, pos, parent) => {
    if (!node.isTextblock) return true
    if (pos < span.from || pos + node.nodeSize > span.to) return false
    rows.push({ node, pos, parent })
    return false
  })

  const runs: Row[][] = []
  let cur: Row[] = []
  const flush = () => {
    if (cur.length > 1) runs.push(cur)
    cur = []
  }
  for (const row of rows) {
    const prev = cur[cur.length - 1]
    const sameParent = !!prev && prev.parent === row.parent
    const adjacent = !!prev && prev.pos + prev.node.nodeSize === row.pos
    const eligible = row.node.type.name === 'paragraph' && !!row.parent
    if (!eligible) {
      flush()
      continue
    }
    if (prev && (!sameParent || !adjacent)) flush()
    cur.push(row)
  }
  flush()
  return runs
}

/** 选中的这几行能不能合并（右键菜单用）。 */
export function countMergeableRuns(doc: PMNode, from: number, to: number): number {
  return mergeableRuns(doc, from, to).length
}

/**
 * 合并多行：每组合并成一段，原来的行与行之间留一个硬换行。
 *
 * 顺序同样是"从后往前"：后面的组先合，前面组的坐标不受影响。
 */
export function mergeRowsIntoOne(
  state: EditorState,
  from: number,
  to: number,
): Transaction | null {
  const runs = mergeableRuns(state.doc, from, to)
  if (runs.length === 0) return null
  const hardBreak = state.schema.nodes.hardBreak
  if (!hardBreak) return null

  const tr = state.tr
  let merged = false
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r]
    const start = run[0].pos
    const last = run[run.length - 1]
    const end = last.pos + last.node.nodeSize

    const head = run[0].node
    let content = head.content
    for (let i = 1; i < run.length; i++) {
      // 行与行之间就是复制进来时的那种硬换行（Shift+Enter）
      content = content.append(Fragment.from(hardBreak.create()))
      content = content.append(run[i].node.content)
    }
    const node = head.type.create(head.attrs, content)
    try {
      tr.replaceWith(start, end, node)
      merged = true
    } catch {
      /* ignore */
    }
  }
  if (!merged) return null

  selectRowsAround(tr, tr.mapping.map(from, -1), tr.mapping.map(to, 1))
  return tr
}