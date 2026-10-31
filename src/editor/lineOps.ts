import { splitBlock } from '@tiptap/pm/commands'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import {
  AllSelection,
  NodeSelection,
  TextSelection,
  type EditorState,
  type Selection,
  type Transaction,
} from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
// 带 .ts 后缀：docs 下的回归脚本用 node 直接跑，它不会替我们补后缀
import { expandToRows } from './moveRange.ts'

/**
 * 行级编辑：Enter / Backspace / Delete 只认"行"（段落、图片），不认捕获块边界。
 *
 * 为什么不能交给 ProseMirror 的默认逻辑：捕获块是 div[data-capture] 包着的一串段落，
 * 默认的 Backspace / Delete 在块边界上做的是 join / lift / wrap 这层壳，而不是删一行 ——
 * 于是出现"按一下什么都没少，段落却从块里搬到块外"（块外那段有自己的段间距，看着就多出一行），
 * 空行上按回车还会被 liftEmptyBlock 抬到块外，之后再退格又被 wrap 回块里。删一行，多一行。
 *
 * 这里把三个键都收过来，只做一件事：两行并一行 / 一行拆两行。
 *
 * 返回值约定（方便在没有 DOM 的环境里跑回归）：
 *   undefined   = 不接管，交回 ProseMirror 默认逻辑
 *   null        = 接管，但文档不用改（已经在第一行 / 最后一行）
 *   Transaction = 接管并改文档
 */
export type LineResult = Transaction | null | undefined

type Row = {
  node: PMNode
  /** 行在 doc 里的起点 / 终点 */
  from: number
  to: number
  /** 行内容的起点 / 终点（行首 / 行尾）；非文字行为 -1 */
  textFrom: number
  textTo: number
  /** 文字行？false = 图片这类原子块 */
  text: boolean
  /** 空行？ */
  empty: boolean
  /** 行所在的层级：1 = 直接挂在 doc 下，2 = 挂在捕获块里 */
  depth: number
}

type Place = {
  /** 顶层块的序号与起点 */
  blockIndex: number
  blockPos: number
  block: PMNode
  /** 行在块内的序号与起点 */
  index: number
  from: number
}

/** 把光标所在的节点包成"行"。 */
function rowOf($pos: ResolvedPos): Row | null {
  let depth = $pos.depth
  while (depth > 0 && !$pos.node(depth).isTextblock) depth--
  if (depth === 0) return null
  const node = $pos.node(depth)
  const from = $pos.before(depth)
  return {
    node,
    from,
    to: from + node.nodeSize,
    textFrom: from + 1,
    textTo: from + node.nodeSize - 1,
    text: true,
    empty: node.content.size === 0,
    depth,
  }
}

function rowFromNode(node: PMNode, from: number, depth: number): Row {
  const text = node.isTextblock
  return {
    node,
    from,
    to: from + node.nodeSize,
    textFrom: text ? from + 1 : -1,
    textTo: text ? from + node.nodeSize - 1 : -1,
    text,
    empty: !node.content.size,
    depth,
  }
}

/** 行挂在哪个顶层块的哪个位置。 */
function placeOf(doc: PMNode, node: PMNode): Place | null {
  let off = 0
  for (let bi = 0; bi < doc.childCount; bi++) {
    const block = doc.child(bi)
    if (block === node) {
      return { blockIndex: bi, blockPos: off, block, index: 0, from: off }
    }
    // 捕获块这类容器：往里看一层，行就挂在它下面
    if (!block.isTextblock && !block.isLeaf) {
      let coff = off + 1
      for (let ci = 0; ci < block.childCount; ci++) {
        const child = block.child(ci)
        if (child === node) {
          return { blockIndex: bi, blockPos: off, block, index: ci, from: coff }
        }
        coff += child.nodeSize
      }
    }
    off += block.nodeSize
  }
  return null
}

function blockOffset(doc: PMNode, index: number): number {
  let off = 0
  for (let i = 0; i < index; i++) off += doc.child(i).nodeSize
  return off
}

/** 块里最后一行（一直往里钻到段落 / 图片）。 */
function lastRowOf(node: PMNode, from: number, depth: number): Row | null {
  let cur = node
  let pos = from
  let d = depth
  while (!cur.isTextblock && !cur.isLeaf) {
    const last = cur.lastChild
    if (!last) return null
    pos = pos + 1 + (cur.content.size - last.nodeSize)
    cur = last
    d++
  }
  return rowFromNode(cur, pos, d)
}

/** 块里第一行。 */
function firstRowOf(node: PMNode, from: number, depth: number): Row | null {
  let cur = node
  let pos = from
  let d = depth
  while (!cur.isTextblock && !cur.isLeaf) {
    const first = cur.firstChild
    if (!first) return null
    pos += 1
    cur = first
    d++
  }
  return rowFromNode(cur, pos, d)
}

/** 上一行（跨捕获块也算）。 */
function prevRow(doc: PMNode, cur: Row): Row | null {
  const place = placeOf(doc, cur.node)
  if (!place) return null
  if (place.index > 0) {
    const sib = place.block.child(place.index - 1)
    return rowFromNode(sib, place.from - sib.nodeSize, cur.depth)
  }
  for (let bi = place.blockIndex - 1; bi >= 0; bi--) {
    const block = doc.child(bi)
    const row = lastRowOf(block, blockOffset(doc, bi), 1)
    if (row) return row
  }
  return null
}

/** 下一行（跨捕获块也算）。 */
function nextRow(doc: PMNode, cur: Row): Row | null {
  const place = placeOf(doc, cur.node)
  if (!place) return null
  if (place.index < place.block.childCount - 1) {
    const sib = place.block.child(place.index + 1)
    return rowFromNode(sib, place.from + cur.node.nodeSize, cur.depth)
  }
  for (let bi = place.blockIndex + 1; bi < doc.childCount; bi++) {
    const block = doc.child(bi)
    const row = firstRowOf(block, blockOffset(doc, bi), 1)
    if (row) return row
  }
  return null
}

/** 空行被摘掉以后，光标该落在相邻行的哪里。 */
function caretAt(tr: Transaction, row: Row): Selection {
  return row.text
    ? TextSelection.create(tr.doc, row.textTo)
    : NodeSelection.create(tr.doc, row.from)
}

/**
 * 退格 / Delete 的公共部分。
 * dir = -1：退格，把这一行并到上一行；dir = 1：Delete，把下一行并到这一行。
 */
function deleteLine(state: EditorState, dir: -1 | 1): LineResult {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return undefined
  const $head = sel.$head
  const parent = $head.parent
  if (!parent.isTextblock) return undefined
  // 只有真的在行首 / 行尾才接管；行中间是正常的删字
  if (dir < 0 ? $head.parentOffset !== 0 : $head.parentOffset !== parent.content.size) {
    return undefined
  }
  // 列表、引用这些嵌套结构交回默认逻辑，别硬并
  if ($head.depth > 2) return undefined

  const cur = rowOf($head)
  if (!cur) return undefined
  const other = dir < 0 ? prevRow(state.doc, cur) : nextRow(state.doc, cur)
  if (!other) {
    // 已经是第一行 / 最后一行：吃掉这次按键。
    // 不能交回默认逻辑 —— 那会在块边界上把捕获块拆开。
    return null
  }
  if (other.depth > 2) return undefined

  try {
    const tr = state.tr
    if (cur.empty) {
      // 这一行是空的：整行摘掉，光标落到相邻行（相邻是图片就选中它）
      tr.delete(cur.from, cur.to)
      if (dir < 0) {
        tr.setSelection(caretAt(tr, other))
      } else {
        // 下一行整体往前挪了一行的长度
        const shift = cur.node.nodeSize
        tr.setSelection(
          other.text
            ? TextSelection.create(tr.doc, other.textFrom - shift)
            : NodeSelection.create(tr.doc, other.from - shift),
        )
      }
      return tr
    }
    if (!other.text) {
      // 旁边是图片：先选中它，再按一次才删（别一键毁图）
      tr.setSelection(NodeSelection.create(state.doc, other.from))
      return tr
    }
    if (other.empty) {
      // 另一行是空的：整行摘掉，别留下空块。
      //
      // 光标必须跟着这一删往前走（caret 在行首，删的是它前面那一行）。
      // 以前这里写的是 `cur.textTo` —— 那是**删之前**的坐标，删掉一行后
      // 它会指到这一行文字的中间甚至下一行去：光标就从行首跳到了行尾。见 test-line-ops 22。
      tr.delete(other.from, other.to)
      const caret = tr.mapping.map(sel.head, 1)
      tr.setSelection(TextSelection.create(tr.doc, caret))
      return tr
    }
    // 两行都有字：删掉中间那个换行（跨块时顺带把块的边界一起吃掉）
    const from = dir < 0 ? other.textTo : cur.textTo
    const to = dir < 0 ? cur.textFrom : other.textFrom
    tr.delete(from, to)
    tr.setSelection(TextSelection.create(tr.doc, from))
    return tr
  } catch {
    // 万一结构特殊到删不了，交回默认逻辑，别把编辑器搞崩
    return undefined
  }
}

/** Backspace：光标在行首。 */
export function deleteLineBackward(state: EditorState): LineResult {
  return deleteLine(state, -1)
}

/** Delete：光标在行尾。 */
export function deleteLineForward(state: EditorState): LineResult {
  return deleteLine(state, 1)
}

/**
 * Enter：在原地把这一行拆成两行。
 *
 * 不用默认逻辑的原因同上：空行的默认回车会被 liftEmptyBlock 抬出捕获块。
 */
export function splitLine(state: EditorState): LineResult {
  const sel = state.selection
  // 选中图片时回车：在图片这一行的后面补一行，光标落过去。
  // 图片是行内节点，所以"补一行"是补在它所在的段落后面（块边界）。
  if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
    const $pos = state.doc.resolve(sel.from)
    // 行内图：段落后面补一行；老的块级图：捕获块里补一行
    const at = $pos.parent.isTextblock
      ? $pos.after($pos.depth)
      : $pos.parent.type.name === 'captureBlock'
        ? sel.from + sel.node.nodeSize
        : -1
    if (at < 0) return undefined
    try {
      const tr = state.tr.insert(at, state.schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, at + 1))
      return tr
    } catch {
      return undefined
    }
  }
  if (!(sel instanceof TextSelection) || !sel.empty) return undefined
  const $head = sel.$head
  if (!$head.parent.isTextblock) return undefined
  if ($head.parent.type.name !== 'paragraph') return undefined
  if ($head.depth > 2) return undefined

  let out: Transaction | null = null
  const ok = splitBlock(state, (tr) => {
    out = tr
  })
  if (!ok) return undefined
  return out
}

/**
 * 选中范围盖住的整行，换算成"整行的文字范围"。
 *
 * `expandToRows` 给的是块边界（`before` / `after`），选中文字要用的是块里面的
 * 第一个和最后一个位置 —— 也就是行首到行尾，不含块的 token。
 * 全是空行时没有可选的文字，返回 null。
 */
function rowTextRange(
  doc: PMNode,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const span = expandToRows(doc, from, to)
  if (!span) return null
  const start = span.from + 1
  const end = span.to - 1
  return end > start ? { from: start, to: end } : null
}

/**
 * Ctrl+A：先选中光标所在的**这一行**，再按一次才全选。
 *
 * 这个编辑器里"行"才是编辑单位（段落、图片那一行）。Ctrl+A 一上来就全选，
 * 想改一行的人很容易顺手把整篇覆盖掉；可"选全文"又总得有条路，
 * 所以做成两段：第一次 = 这一行（或者选区碰到的这几整行），第二次 = 全文。
 *
 * - 光标在空行上：没有可选的文字，直接全选；
 * - 已经整行选中 / 选了好几整行：再按就是全选；
 * - 选中的是图片这类整块节点：它本身就是"一行"，再按就是全选；
 * - 已经是全选：不接管，交给 ProseMirror 默认的 selectAll（保持全选）。
 */
export function selectLineOrAll(state: EditorState): LineResult {
  const doc = state.doc
  const sel = state.selection
  if (sel instanceof AllSelection) return undefined

  // 图片 / 分割线这类整块已经是"一行"了：再按就是全选
  if (!(sel instanceof TextSelection)) {
    return state.tr.setSelection(new AllSelection(doc))
  }

  const headRow = rowOf(sel.$head)
  if (!headRow) return undefined

  if (!sel.empty) {
    const range = rowTextRange(doc, sel.from, sel.to)
    // 选区已经把碰到的整行都盖住了 → 下一步就是全选
    if (range && sel.from <= range.from && sel.to >= range.to) {
      return state.tr.setSelection(new AllSelection(doc))
    }
    if (range) {
      try {
        return state.tr.setSelection(TextSelection.create(doc, range.from, range.to))
      } catch {
        // 选区边上正好是图片 / 分割线这类原子块：这两个位置不是文字位置，
        // 退回"光标所在这一行"，别让 Ctrl+A 抛异常
      }
    }
  }

  // 空行没有"这一行"可选，直接把全文选上
  if (headRow.empty) return state.tr.setSelection(new AllSelection(doc))
  return state.tr.setSelection(TextSelection.create(doc, headRow.textFrom, headRow.textTo))
}

function run(view: EditorView, result: LineResult): boolean {
  if (result === undefined) return false
  if (result) view.dispatch(result)
  return true
}
/** 编辑器用的薄壳：把 LineResult 落到 view 上，返回"这次按键归我管"。 */
export function handleLineKey(view: EditorView, key: string): boolean {
  const state = view.state
  if (key === 'Backspace') return run(view, deleteLineBackward(state))
  if (key === 'Delete') return run(view, deleteLineForward(state))
  if (key === 'Enter') return run(view, splitLine(state))
  return false
}

/**
 * 末尾补一行：只在"最后一块以图收尾"时补，而且补在块里面。
 *
 * 原来用的是 StarterKit 的 trailingNode —— 它不管最后是块还是图，都要在文档末尾挂一个
 * 空段落；用户把末尾那行空行退格删掉，下一次事务它又插回来。删一行、多一行，就是这么来的。
 * 这里只保留真正需要的那种情况：最后一行是图，得有个文字行让光标落脚。
 */
export function trailingLineTr(state: EditorState): Transaction | null {
  const doc = state.doc
  const last = doc.lastChild
  if (!last) return null
  const paragraph = state.schema.nodes.paragraph
  if (last.type.name === 'captureBlock') {
    const inner = last.lastChild
    if (inner && inner.isTextblock) return null
    // 块的 close token 前面 = 块内末尾
    return state.tr.insert(doc.content.size - 1, paragraph.create())
  }
  if (last.isTextblock) return null
  return state.tr.insert(doc.content.size, paragraph.create())
}