import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state'

/**
 * 把图片从 srcPos 挪到 targetPos（target 必须是块边界，或者段落的首/尾）。
 *
 * 图片是行内节点（挂在段落里），所以"落下来"的时候要自己包一层段落：
 * 直接在块边界插入一个行内节点会被 schema 拒绝。
 *
 * 单独抽成纯函数：只依赖 EditorState，便于在没有 DOM 的环境里验证移动逻辑。
 * 返回 null 表示这次移动不成立（位置非法 / 原地不动 / 插入会被 schema 拒绝）。
 */

/** 块边界：段落内部只认行首 / 行尾；落在段落中间返回 null。 */
export function blockBoundaryAt(doc: PMNode, targetPos: number): number | null {
  let $t
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
 * 拖走这张图要删掉的范围。
 *
 * 这一行里只有这张图就整行一起删（别留一行空白）；这一行又是块里唯一的内容，
 * 整个块也一起带走 —— 留一个空块 = 留下一行看不见、也点不掉的东西。
 */
export function imageDeleteRange(
  doc: PMNode,
  srcPos: number,
  node: PMNode,
): { from: number; to: number } | null {
  let $src
  try {
    $src = doc.resolve(srcPos)
  } catch {
    return null
  }
  const parent = $src.parent

  let delFrom = srcPos
  let delTo = srcPos + node.nodeSize
  let rowDepth = -1
  if (parent.childCount === 1 && (parent.isTextblock || parent.type.name === 'captureBlock')) {
    rowDepth = $src.depth
    delFrom = $src.before(rowDepth)
    delTo = delFrom + $src.node(rowDepth).nodeSize
  }
  // 这一行又是块里唯一的内容（图独占的那一块）：块也一起带走
  if (rowDepth > 0 && $src.node(rowDepth - 1).type.name === 'captureBlock') {
    const up = rowDepth - 1
    const upNode = $src.node(up)
    if (upNode.childCount === 1) {
      delFrom = $src.before(up)
      delTo = delFrom + upNode.nodeSize
    }
  }
  return { from: delFrom, to: delTo }
}

/**
 * 把图丢到 targetPos 会不会真的动 —— 只做结构判断，不建事务。
 *
 * 拖拽时每帧都要问一次（落点提示线要不要画），所以这里必须便宜；
 * 判断条件和 moveImageTransaction 完全一致，并且由 docs/test-row-ops.ts 交叉验证。
 */
export function canMoveImage(
  doc: PMNode,
  srcPos: number,
  targetPos: number,
  node: PMNode,
): boolean {
  const atNode = doc.nodeAt(srcPos)
  if (!atNode || !atNode.eq(node) || atNode.type.name !== 'image') return false
  const del = imageDeleteRange(doc, srcPos, node)
  if (!del) return false
  const at = blockBoundaryAt(doc, targetPos)
  if (at === null) return false
  // 丢回原地 / 丢进自己被删掉的范围 = 没动
  return at < del.from || at > del.to
}

export function moveImageTransaction(
  state: EditorState,
  srcPos: number,
  targetPos: number,
  srcNode: PMNode,
): Transaction | null {
  const doc = state.doc
  const node = doc.nodeAt(srcPos)
  // 拖的过程中文档可能被追加了捕获、或图片被别处改掉，位置对不上就放弃
  if (!node || !node.eq(srcNode) || node.type.name !== 'image') return null

  const del = imageDeleteRange(doc, srcPos, node)
  if (!del) return null

  // 落点只接受块边界；万一给的是段落内部，按"段前 / 段后"换算成块边界
  const at = blockBoundaryAt(doc, targetPos)
  if (at === null) return null

  // 丢回原地 / 丢进自己被删掉的范围 = 没动
  if (at >= del.from && at <= del.to) return null

  const tr = state.tr
  tr.delete(del.from, del.to)

  // 删除发生在目标之前时，目标位置跟着往前挪
  const pos = at > del.to ? at - (del.to - del.from) : at
  if (pos < 0 || pos > tr.doc.content.size) return null

  try {
    // 图片是行内的：落到块边界时自己包一层段落，它就是"图片那一行"
    tr.insert(pos, state.schema.nodes.paragraph.create(null, node))
  } catch {
    return null
  }
  if (!tr.docChanged) return null
  tr.setSelection(NodeSelection.create(tr.doc, pos + 1))
  return tr
}