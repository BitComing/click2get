import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'

/**
 * 把"选中的文字"当成**几整行**来搬。
 *
 * 为什么必须对齐到行：拖拽的单位是行（段落、图片那一行），不是任意字符区间。
 * 如果按字符区间搬，切出来的 slice 是"开口"的（openStart / openEnd > 0），
 * 落到目标位置时会被拼进旁边那段文字里 —— 一行字忽然接在别人半句话后面。
 * 对齐到行的起止，切出来就是完整的块，放哪儿都还是那几行。
 *
 * 所以：在**一行里面**选中几个字，拖起来搬走的也是那一整行（见 expandToRows）。
 * 用户想挪的从来都是"这一行"，不是"这几个字"。
 *
 * 纯函数，只依赖 PMNode / EditorState，`docs/test-move-range.ts` 覆盖。
 */

export type RowSpan = {
  /** 第一行的起点（段落 / 图片行的 before） */
  from: number
  /** 最后一行的终点（after） */
  to: number
  /** 里面有几行 */
  rows: number
}

/** 光标所在的最内层文字块（段落）的 depth；不在文字块里（含块边界）返回 -1。 */
function textblockDepth($pos: ResolvedPos): number {
  let depth = $pos.depth
  while (depth > 0 && !$pos.node(depth).isTextblock) depth--
  // 一路走到 doc 的人，位置落在块边界上（不是某一行里面）
  return depth > 0 ? depth : -1
}

/**
 * 把任意选区扩成"整行"。
 *
 * - 起点落在行中间：从这一行的行首算起（拖走半行也当整行搬，符合"拖这一行"的直觉）；
 * - 终点落在行中间：算到这一行的行尾；
 * - 终点正好在下一行的行首（鼠标拖到换行处）：这一行不算 —— 用户看到的高亮里没有它。
 *
 * 只选了一行里的几个字，返回的也是那**一整行**（rows = 1）：
 * 拖动的单位是行，"拖半句话"没有意义。
 */
export function expandToRows(doc: PMNode, from: number, to: number): RowSpan | null {
  if (to <= from) return null
  let $from: ResolvedPos
  let $to: ResolvedPos
  try {
    $from = doc.resolve(from)
    $to = doc.resolve(to)
  } catch {
    return null
  }

  const start = rowStart($from)
  const end = rowEnd($to)
  if (start < 0 || end <= start) return null

  let rows = 0
  doc.nodesBetween(start, end, (node) => {
    if (node.isTextblock || (node.isLeaf && node.isBlock)) rows++
  })
  if (rows === 0) return null
  return { from: start, to: end, rows }
}

/**
 * 位置所在那一行的起点（行首）；位置本身就在块边界上时，它就是下一行的行首。
 */
export function rowStart($pos: ResolvedPos): number {
  const fd = textblockDepth($pos)
  return fd >= 0 ? $pos.before(fd) : $pos.pos
}

/**
 * 位置所在那一行的终点（行尾）；位置正好在某一行的行首时，往回算到上一行的行尾。
 *
 * 结尾不能直接用 `after(depth)`：段落是文档最后一个节点时它会抛
 * "There is no position after the top-level node"，自己按 nodeSize 算最稳。
 */
export function rowEnd($pos: ResolvedPos): number {
  const td = textblockDepth($pos)
  if (td < 0) return $pos.pos
  if ($pos.parentOffset === 0 && td > 0) return $pos.pos
  return $pos.before(td) + $pos.node(td).nodeSize
}

/**
 * 位置所在的那一整行（段落）。
 *
 * 长按一行、但什么都没选中时走这里：不用先选字，按住的这一行就是拖动单位。
 * 点到块边界 / 图片这类非文字块上返回 null（图片另有 moveImage 走）。
 */
export function spanAtRow(doc: PMNode, pos: number): RowSpan | null {
  let $pos: ResolvedPos
  try {
    $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size))
  } catch {
    return null
  }
  const depth = textblockDepth($pos)
  if (depth < 0) return null
  const node = $pos.node(depth)
  const from = $pos.before(depth)
  return { from, to: from + node.nodeSize, rows: 1 }
}

/** 落点换算成块边界（和 moveImage.ts 一致）：段落内部只认行首 / 行尾。 */
function blockBoundary(doc: PMNode, targetPos: number): number | null {
  let $t: ResolvedPos
  try {
    $t = doc.resolve(targetPos)
  } catch {
    return null
  }
  if (!$t.parent.isTextblock) return targetPos
  const atStart = $t.parentOffset === 0
  const atEnd = $t.parentOffset === $t.parent.content.size
  if (!atStart && !atEnd) return null
  return atStart ? $t.before($t.depth) : $t.after($t.depth)
}

/**
 * 把这几个行丢到 targetPos 会不会真的动 —— 只做结构判断，不建事务。
 *
 * 拖拽时每帧都要问一次（落点提示线要不要画），所以这里必须便宜；
 * 判断条件和 moveRangeTransaction 一致：落点不合块边界、或者落在
 * 被搬走的这几行里面（丢回原地），都算"拖不过去"。由 docs/test-row-ops.ts 交叉验证。
 */
export function canMoveRange(
  doc: PMNode,
  from: number,
  to: number,
  targetPos: number,
): boolean {
  if (from < 0 || to > doc.content.size || to <= from) return false
  const at = blockBoundary(doc, targetPos)
  if (at === null) return false
  return at < from || at > to
}

/**
 * 把 [from, to) 这几行搬到 targetPos。
 *
 * 先删后插：位置按删除量补偿。落点在自己身上 = 不动（返回 null）。
 * 搬完把光标放到搬过去的内容开头，方便接着改。
 */
export function moveRangeTransaction(
  state: EditorState,
  from: number,
  to: number,
  targetPos: number,
): Transaction | null {
  const doc = state.doc
  if (from < 0 || to > doc.content.size || to <= from) return null

  const at = blockBoundary(doc, targetPos)
  if (at === null) return null
  // 丢回原地 / 丢进被搬走的那几行里 = 没动
  if (at >= from && at <= to) return null

  let slice
  try {
    slice = doc.slice(from, to)
  } catch {
    return null
  }
  // 只搬"整块"：开口的 slice 会和邻居拼在一起，宁可不搬
  if (slice.openStart !== 0 || slice.openEnd !== 0) return null
  if (slice.content.size === 0) return null

  const tr = state.tr.delete(from, to)
  const pos = at > to ? at - (to - from) : at
  if (pos < 0 || pos > tr.doc.content.size) return null

  try {
    tr.insert(pos, slice.content)
  } catch {
    return null
  }
  if (!tr.docChanged) return null

  // 光标落到搬过去那几行的开头（TextSelection.near 会自己找最近的文字位置）
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1))
  } catch {
    /* 结构特殊就算了，光标保持原样也不影响内容正确 */
  }
  dropEmptyBlocks(tr, state.schema)
  return tr
}

/**
 * 搬空了的捕获块不该留在文档里（没有高度，却会让光标卡在一块看不见的地方）。
 * 平时这一步由 CaptureBlock 的插件兜住；这里写进事务里，纯函数也能自证结果。
 */
function dropEmptyBlocks(tr: Transaction, schema: EditorState['schema']) {
  const empty: Array<{ pos: number; size: number }> = []
  tr.doc.descendants((node, pos) => {
    if (node.type.name === 'captureBlock' && node.childCount === 0) {
      empty.push({ pos, size: node.nodeSize })
    }
  })
  // 从后往前删：前面的位置不会因为后面的删除而失效
  for (let i = empty.length - 1; i >= 0; i--) {
    const e = empty[i]
    if (tr.doc.childCount === 1 && e.pos === 0) {
      // 整篇只剩这个空块：换成空段落（doc 的 content 是 block+）
      tr.replaceWith(0, e.size, schema.nodes.paragraph.create())
    } else {
      tr.delete(e.pos, e.pos + e.size)
    }
  }
}

/** 这几行的块级 JSON —— 拖到侧栏另一篇笔记时，把内容原样发过去。 */
export function rangeBlocks(state: EditorState, from: number, to: number): any[] {
  try {
    const json = state.doc.slice(from, to).content.toJSON()
    return Array.isArray(json) ? json : []
  } catch {
    return []
  }
}