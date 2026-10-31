// 行级操作回归：node --experimental-strip-types docs\test-row-ops.ts
//
// 覆盖三件事（都是纯函数，不依赖 DOM）：
//   1. Ctrl+A：第一下选这一行，第二下才全选；
//   2. 右键菜单：拆解成多行 / 合并多行（行内硬换行 ↔ 单独的行）；
//   3. 拖拽落点提示：丢回原地 / 丢进被搬走的那几行里 → 不算能落，不该画线。
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
  type Selection,
  type Transaction,
} from '@tiptap/pm/state'
import { selectLineOrAll } from '../src/editor/lineOps.ts'
import {
  countInlineBreaks,
  countMergeableRuns,
  mergeRowsIntoOne,
  splitInlineBreaks,
} from '../src/editor/lineBreaks.ts'
import { canMoveRange, moveRangeTransaction, expandToRows } from '../src/editor/moveRange.ts'
import { canMoveImage, moveImageTransaction } from '../src/editor/moveImage.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    captureBlock: {
      group: 'block',
      content: 'block*',
      attrs: { ts: { default: null } },
      toDOM: () => ['div', { 'data-capture': '' }, 0],
    },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      draggable: false,
      attrs: { hash: { default: null } },
      toDOM: () => ['img'],
    },
    horizontalRule: {
      group: 'block',
      atom: true,
      draggable: false,
      toDOM: () => ['hr'],
    },
    hardBreak: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: false,
      toDOM: () => ['br'],
    },
    text: { group: 'inline' },
  },
})

/** "aa\nbb" → 一个段落，行与行之间是硬换行（和 editor/insert.ts 落出来的形态一致） */
const p = (s = '') => {
  const kids: PMNode[] = []
  s.split('\n').forEach((line, i) => {
    if (i) kids.push(schema.nodes.hardBreak.create())
    if (line) kids.push(schema.text(line))
  })
  return schema.node('paragraph', null, kids)
}
const img = (hash = 'H') => schema.node('image', { hash })
const hr = () => schema.nodes.horizontalRule.create()
const cb = (...kids: PMNode[]) => schema.node('captureBlock', null, kids)
const doc = (...kids: PMNode[]) => schema.node('doc', null, kids)
const state = (d: PMNode) => EditorState.create({ schema, doc: d })

/** 段落里的内容：硬换行写成 ⏎，图片写成 img(hash) */
function inlineLabel(node: PMNode): string {
  let out = ''
  node.forEach((child) => {
    if (child.type.name === 'hardBreak') out += '⏎'
    else if (child.type.name === 'image') out += `img(${child.attrs.hash})`
    else if (child.isText) out += child.text
  })
  return out
}

const outline = (d: PMNode) => {
  const parts: string[] = []
  d.forEach((child) => {
    if (child.type.name === 'captureBlock') {
      const inner: string[] = []
      child.forEach((k) => inner.push(k.isTextblock ? inlineLabel(k) || '空行' : k.type.name))
      parts.push(`cb[${inner.join(' | ')}]`)
    } else {
      parts.push(child.isTextblock ? inlineLabel(child) || '空行' : child.type.name)
    }
  })
  return parts.join(' , ')
}

function findPos(d: PMNode, pred: (n: PMNode) => boolean): number {
  let hit = -1
  d.descendants((node, pos) => {
    if (hit >= 0) return false
    if (pred(node)) {
      hit = pos
      return false
    }
    return true
  })
  return hit
}
/** 第 nth 个内容等于 label 的段落（返回段落节点位置） */
const paraPos = (d: PMNode, label: string, nth = 0) => {
  let seen = 0
  return findPos(d, (n) => {
    if (!n.isTextblock || inlineLabel(n) !== label) return false
    if (seen === nth) return true
    seen += 1
    return false
  })
}
const rowRange = (d: PMNode, label: string, nth = 0) => {
  const pos = paraPos(d, label, nth)
  const node = d.nodeAt(pos)
  return { from: pos, to: pos + (node?.nodeSize ?? 0), textFrom: pos + 1, textTo: pos + 1 + (node?.content.size ?? 0) }
}
const imagePos = (d: PMNode, hash = 'H') =>
  findPos(d, (n) => n.type.name === 'image' && n.attrs.hash === hash)

function select(st: EditorState, from: number, to = from): EditorState {
  return st.apply(st.tr.setSelection(TextSelection.create(st.doc, from, to)))
}
function sel(st: EditorState): Selection {
  return st.selection
}
const selString = (s: Selection) =>
  s instanceof AllSelection
    ? '全文'
    : `${s.from}-${s.to}${s.empty ? '(光标)' : ''}`

let failed = 0
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${actual}${ok ? '' : `\n  期望 ${expected}`}`)
}

// ── 1. Ctrl+A：先这一行，再全文 ────────────────────────

const ctrlA = () => doc(cb(p('A1'), p('A2')), cb(p('B1')))

{
  const d = ctrlA()
  const st = select(state(d), paraPos(d, 'A1') + 2)
  const next = selectLineOrAll(st)
  const applied = next ? st.apply(next) : st
  const a1 = rowRange(st.doc, 'A1')
  check('Ctrl+A①：选中光标所在这一行', selString(sel(applied)), `${a1.textFrom}-${a1.textTo}`)

  const again = selectLineOrAll(applied)
  const all = again ? applied.apply(again) : applied
  check('Ctrl+A②：再按一次全选', selString(sel(all)), '全文')

  const third = selectLineOrAll(all)
  check('Ctrl+A③：已经是全选 → 交给默认逻辑', third === undefined ? 'default' : 'handled', 'default')
}

{
  const d = ctrlA()
  const a1 = rowRange(d, 'A1')
  const st = select(state(d), a1.textFrom) // 光标正好在行首
  const next = selectLineOrAll(st)
  const applied = next ? st.apply(next) : st
  check('行首的 Ctrl+A 选的是这一行（不是上一行）', selString(sel(applied)), `${a1.textFrom}-${a1.textTo}`)
}

{
  const d = ctrlA()
  const a1 = rowRange(d, 'A1')
  const a2 = rowRange(d, 'A2')
  // 从 A1 中间选到 A2 中间：第一下扩成这两整行，第二下全选
  const st = select(state(d), a1.textFrom + 1, a2.textFrom + 1)
  const next = selectLineOrAll(st)
  const applied = next ? st.apply(next) : st
  check(
    '选中半个 A1 + 半个 A2：先扩成整行',
    selString(sel(applied)),
    `${a1.textFrom}-${a2.textTo}`,
  )
  const again = selectLineOrAll(applied)
  const all = again ? applied.apply(again) : applied
  check('扩成整行之后再按一次 = 全文', selString(sel(all)), '全文')
}

{
  const d = doc(cb(p('A1')), p(''))
  const empty = paraPos(d, '')
  const st = select(state(d), empty + 1)
  const next = selectLineOrAll(st)
  const applied = next ? st.apply(next) : st
  check('空行上的 Ctrl+A 直接全选', selString(sel(applied)), '全文')
}

{
  const d = doc(cb(p('A1'), schema.node('paragraph', null, [img()])))
  const st = state(d)
  const pos = imagePos(d)
  const withNode = st.apply(st.tr.setSelection(NodeSelection.create(st.doc, pos)))
  const next = selectLineOrAll(withNode)
  const applied = next ? withNode.apply(next) : withNode
  check('选中图片（已经是一行）再按 Ctrl+A = 全文', selString(sel(applied)), '全文')
}

// ── 2. 拆解成多行 / 合并多行 ───────────────────────────

{
  const d = doc(cb(p('aa\nbb\ncc')))
  const row = rowRange(d, 'aa⏎bb⏎cc')
  const st = select(state(d), row.textFrom, row.textTo)
  check('统计选区里的行内换行', String(countInlineBreaks(st.doc, row.textFrom, row.textTo)), '2')
  const tr = splitInlineBreaks(st, row.textFrom, row.textTo)
  check('拆解成多行', tr ? outline(tr.doc) : 'null', 'cb[aa | bb | cc]')
  // 拆完这几行应该还是选中的（接着复制 / 再操作）
  check(
    '拆完选区落在新行上',
    tr ? `${tr.selection.from}:${tr.selection.to}` : 'null',
    tr ? `${rowFrom(tr.doc, 'aa')}:${rowTextTo(tr.doc, 'cc')}` : 'null',
  )
}

{
  const d = doc(p('a\nb'))
  const row = rowRange(d, 'a⏎b')
  const st = select(state(d), row.textFrom, row.textTo)
  const tr = splitInlineBreaks(st, row.textFrom, row.textTo)
  check('单个段落也能拆（不在捕获块里）', tr ? outline(tr.doc) : 'null', 'a , b')
}

{
  const d = doc(cb(p('aa\nbb')))
  const row = rowRange(d, 'aa⏎bb')
  const st = select(state(d), row.textFrom, row.textFrom + 2) // 只选了 aa，没碰到换行
  check('选区里没有换行 → 拆不了', splitInlineBreaks(st, row.textFrom, row.textFrom + 2) ? 'moved' : 'null', 'null')
}

{
  const d = doc(cb(p('A1'), p('A2'), p('A3')))
  const a1 = rowRange(d, 'A1')
  const a3 = rowRange(d, 'A3')
  const st = select(state(d), a1.textFrom, a3.textTo)
  check('统计能合并的行组', String(countMergeableRuns(st.doc, a1.textFrom, a3.textTo)), '1')
  const tr = mergeRowsIntoOne(st, a1.textFrom, a3.textTo)
  check('合并多行', tr ? outline(tr.doc) : 'null', 'cb[A1⏎A2⏎A3]')
}

{
  const d = doc(cb(p('A1'), p('A2')))
  const a1 = rowRange(d, 'A1')
  const a2 = rowRange(d, 'A2')
  const st = select(state(d), a1.textFrom, a2.textTo)
  const tr = mergeRowsIntoOne(st, a1.textFrom, a2.textTo)
  const merged = tr ? state(tr.doc) : null
  check(
    '合并后选区覆盖合并出来的那一行',
    tr && merged ? `${tr.selection.from}:${tr.selection.to}` : 'null',
    merged ? `${rowFrom(merged.doc, 'A1⏎A2')}:${rowTextTo(merged.doc, 'A1⏎A2')}` : 'null',
  )
  // 合并是"再拆一下"的逆操作
  const back =
    tr && merged
      ? splitInlineBreaks(
          select(merged, tr.selection.from, tr.selection.to),
          tr.selection.from,
          tr.selection.to,
        )
      : null
  check('合并后还能拆回去', back ? outline(back.doc) : 'null', 'cb[A1 | A2]')
}

{
  const d = doc(cb(p('A1'), p('A2')))
  const a1 = rowRange(d, 'A1')
  const st = select(state(d), a1.textFrom, a1.textTo)
  check('只选一行 → 合并不了', mergeRowsIntoOne(st, a1.textFrom, a1.textTo) ? 'merged' : 'null', 'null')
}

{
  const d = doc(cb(p('A1'), hr(), p('A2')))
  const a1 = rowRange(d, 'A1')
  const a2 = rowRange(d, 'A2')
  const st = select(state(d), a1.textFrom, a2.textTo)
  check('中间隔着分割线 → 不硬合', mergeRowsIntoOne(st, a1.textFrom, a2.textTo) ? 'merged' : 'null', 'null')
}

{
  const d = doc(cb(p('A1'), p('A2')), cb(p('B1'), p('B2')))
  const a1 = rowRange(d, 'A1')
  const b2 = rowRange(d, 'B2')
  const st = select(state(d), a1.textFrom, b2.textTo)
  const tr = mergeRowsIntoOne(st, a1.textFrom, b2.textTo)
  check('跨捕获块：每组各合各的', tr ? outline(tr.doc) : 'null', 'cb[A1⏎A2] , cb[B1⏎B2]')
  check('跨捕获块：统计到两组', String(countMergeableRuns(st.doc, a1.textFrom, b2.textTo)), '2')
}

/** 段落节点里文字部分的起点 / 终点（给上面的选区断言用） */
function rowFrom(d: PMNode, label: string) {
  return paraPos(d, label) + 1
}
function rowTextTo(d: PMNode, label: string) {
  const pos = paraPos(d, label)
  return pos + 1 + d.nodeAt(pos)!.content.size
}

// ── 3. 拖拽落点：不能落的地方不画提示线 ───────────────

{
  const d = doc(cb(p('A1'), p('A2')), p('尾巴'))
  const rows = expandToRows(d, rowRange(d, 'A1').textFrom, rowRange(d, 'A2').textTo)!
  const ownFrom = rowRange(d, 'A1').from
  const ownTo = rowRange(d, 'A2').to
  const tail = rowRange(d, '尾巴')
  check('落回自己身上 → 不能落', canMoveRange(d, rows.from, rows.to, ownFrom) ? 'yes' : 'no', 'no')
  check('落进被搬走的行里 → 不能落', canMoveRange(d, rows.from, rows.to, ownTo) ? 'yes' : 'no', 'no')
  check('落到别的行上 → 能落', canMoveRange(d, rows.from, rows.to, tail.from) ? 'yes' : 'no', 'yes')
  // 和真正的移动函数完全一致
  const st = state(d)
  const real = !!moveRangeTransaction(st, rows.from, rows.to, ownFrom)
  check('和 moveRangeTransaction 的判断一致', real ? 'moved' : 'null', 'null')
}

{
  // 图片独占一行：上面 / 下面的落点就是它自己
  const d = doc(cb(p('A1'), schema.node('paragraph', null, [img('H')]), p('A3')))
  const st = state(d)
  const iPos = imagePos(d)
  const node = st.doc.nodeAt(iPos)!
  const paraStart = findPos(d, (n) => n.isTextblock && inlineLabel(n) === 'img(H)')
  const paraEnd = paraStart + d.nodeAt(paraStart)!.nodeSize
  check('图片：落在自己的行上 → 不画线', canMoveImage(d, iPos, paraStart, node) ? 'yes' : 'no', 'no')
  check('图片：落在自己行的另一边 → 不画线', canMoveImage(d, iPos, paraEnd, node) ? 'yes' : 'no', 'no')
  const a3 = rowRange(d, 'A3')
  check('图片：落到别的行 → 能落', canMoveImage(d, iPos, a3.to, node) ? 'yes' : 'no', 'yes')
  check(
    '图片：和 moveImageTransaction 判断一致',
    moveImageTransaction(st, iPos, paraEnd, node) ? 'moved' : 'null',
    'null',
  )
}

{
  // 图和字在同一行（段里还有别的字）：这一行的段落边界是"能落"的（图会被拎成单独一行）
  const d = doc(cb(p('A1'), schema.node('paragraph', null, [schema.text('前'), img('H'), schema.text('后')])), p('尾'))
  const st = state(d)
  const iPos = imagePos(d)
  const node = st.doc.nodeAt(iPos)!
  const paraStart = findPos(d, (n) => n.isTextblock && inlineLabel(n) === '前img(H)后')
  const paraEnd = paraStart + d.nodeAt(paraStart)!.nodeSize
  check('图夹在字中间：段落边界不是它自己 → 能落', canMoveImage(d, iPos, paraEnd, node) ? 'yes' : 'no', 'yes')
  check(
    '图夹在字中间：和 moveImageTransaction 判断一致',
    moveImageTransaction(st, iPos, paraEnd, node) ? 'moved' : 'null',
    'moved',
  )
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 个`)
process.exit(failed === 0 ? 0 : 1)