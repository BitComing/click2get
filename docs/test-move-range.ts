// 回归：把选中的几行整行搬走（node --experimental-strip-types docs\test-move-range.ts）
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import {
  expandToRows,
  moveRangeTransaction,
  rangeBlocks,
  spanAtRow,
} from '../src/editor/moveRange.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { hash: { default: null } },
    },
    captureBlock: { content: 'block*', group: 'block', defining: false },
  },
})

const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
const img = (hash: string) => schema.node('image', { hash })
const cb = (...kids: PMNode[]) => schema.node('captureBlock', null, kids)

/** 一行一个记号，便于肉眼比对 */
const label = (k: PMNode) => {
  const imgs: string[] = []
  k.descendants((n) => {
    if (n.type.name === 'image') imgs.push(`img(${n.attrs.hash})`)
  })
  if (k.type.name === 'image') return `img(${k.attrs.hash})`
  return imgs.length ? `${k.textContent}${imgs.join('')}` : k.textContent || '空行'
}

const outline = (doc: PMNode) => {
  const parts: string[] = []
  doc.forEach((child) => {
    if (child.type.name === 'captureBlock') {
      const inner: string[] = []
      child.forEach((k) => inner.push(label(k)))
      parts.push(`cb[${inner.join(' | ')}]`)
    } else {
      parts.push(label(child))
    }
  })
  return parts.join(' , ')
}

/** 找到某段文字的行起点（段落 before） */
const rowPos = (doc: PMNode, text: string) => {
  let found = -1
  doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isTextblock && node.textContent === text) {
      found = pos
      return false
    }
    return true
  })
  return found
}

let failed = 0
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${actual}${ok ? '' : `\n  期望 ${expected}`}`)
}

const base = () =>
  schema.node('doc', null, [cb(p('A1'), p('A2')), cb(p('B1'), p('B2')), p('尾行')])

// 1) 选区在行中间 → 扩成整行
{
  const doc = base()
  const a1 = rowPos(doc, 'A1')
  const b2 = rowPos(doc, 'B2')
  const span = expandToRows(doc, a1 + 2, b2 + 2)
  check(
    '选区扩成整行',
    span ? `${span.from}:${span.to}:${span.rows}` : 'null',
    `${a1}:${b2 + doc.nodeAt(b2).nodeSize}:4`,
  )
}

// 2) 终点正好在下一行行首 → 下一行不算
{
  const doc = base()
  const a1 = rowPos(doc, 'A1')
  const a2 = rowPos(doc, 'A2')
  const span = expandToRows(doc, a1 + 1, a2)
  check('选到下一行行首不算那一行', span ? `${span.rows}` : 'null', '1')
}

// 3) 往下拖：B1/B2 搬到尾部
{
  const st = EditorState.create({ schema, doc: base() })
  const from = rowPos(st.doc, 'B1')
  const to = rowPos(st.doc, 'B2') + st.doc.nodeAt(rowPos(st.doc, 'B2')).nodeSize
  const target = rowPos(st.doc, '尾行') + st.doc.nodeAt(rowPos(st.doc, '尾行')).nodeSize
  const tr = moveRangeTransaction(st, from, to, target)
  check('往下拖两行', tr ? outline(tr.doc) : 'null', 'cb[A1 | A2] , 尾行 , B1 , B2')
}

// 4) 往上拖：B1 搬到最前
{
  const st = EditorState.create({ schema, doc: base() })
  const from = rowPos(st.doc, 'B1')
  const to = from + st.doc.nodeAt(from).nodeSize
  const tr = moveRangeTransaction(st, from, to, 0)
  check('往上拖到最前', tr ? outline(tr.doc) : 'null', 'B1 , cb[A1 | A2] , cb[B2] , 尾行')
}

// 5) 拖到自己身上 = 不动
{
  const st = EditorState.create({ schema, doc: base() })
  const from = rowPos(st.doc, 'B1')
  const to = rowPos(st.doc, 'B2') + st.doc.nodeAt(rowPos(st.doc, 'B2')).nodeSize
  check('丢回原地', moveRangeTransaction(st, from, to, from) ? 'moved' : 'null', 'null')
  check('丢进自己被搬走的范围', moveRangeTransaction(st, from, to, from + 1) ? 'moved' : 'null', 'null')
}

// 6) 落点在段落中间 → 拒绝（否则会把两行拼成一行）
{
  const st = EditorState.create({ schema, doc: base() })
  const from = rowPos(st.doc, 'B1')
  const to = from + st.doc.nodeAt(from).nodeSize
  const mid = rowPos(st.doc, 'A1') + 2
  check('段中间的落点被拒绝', moveRangeTransaction(st, from, to, mid) ? 'moved' : 'null', 'null')
}

// 7) 带图片的行也能整行搬
{
  const doc = schema.node('doc', null, [cb(p('A1'), p('A2')), cb(...[p('B1'), schema.node('paragraph', null, [img('H1')])]), p('尾行')])
  const st = EditorState.create({ schema, doc })
  const from = rowPos(st.doc, 'A1')
  const to = rowPos(st.doc, 'A2') + st.doc.nodeAt(rowPos(st.doc, 'A2')).nodeSize
  const tail = rowPos(st.doc, '尾行')
  const tr = moveRangeTransaction(st, from, to, tail)
  check('文字行搬到图片行前面', tr ? outline(tr.doc) : 'null', 'cb[B1 | img(H1)] , A1 , A2 , 尾行')
}

// 8) 拖到另一篇笔记用的块 JSON：整行、可直接追加
{
  const st = EditorState.create({ schema, doc: base() })
  const from = rowPos(st.doc, 'B1')
  const to = rowPos(st.doc, 'B2') + st.doc.nodeAt(rowPos(st.doc, 'B2')).nodeSize
  const blocks = rangeBlocks(st, from, to)
  check(
    '导出块 JSON',
    blocks.map((b: any) => b.type + ':' + b.content[0].text).join(','),
    'paragraph:B1,paragraph:B2',
  )
}
// ── 在一行里面选中几个字：拖起来的是**一整行** ───────────
//
// 用户报告：选中一行**里面**的几个字，长按拖不动（以前只认"至少两行"的选区）。
// 要的不是"搬那几个字"，而是"搬这一行"：选中的位置只用来决定拖的是哪一行，
// 真正搬走的永远是整行（对齐规则见 expandToRows）。

const rowText = (doc: PMNode, text: string) => rowPos(doc, text) + 1
const mixed = () => schema.node('doc', null, [cb(p('AAABBB'), p('CCC'), p('DDDEEE'))])

/** 一行里选中 [a, b) 这几个字之后，长按拖起来的那几行 */
const draggedRows = (doc: PMNode, a: number, b: number) => expandToRows(doc, a, b)

// 9) 行内选中 → 扩成整行（rows = 1，from/to 是整行）
{
  const doc = mixed()
  const start = rowText(doc, 'AAABBB')
  const span = draggedRows(doc, start + 3, start + 6)
  check(
    '行内选中几个字：拖的是整行',
    span ? `${span.rows} 行 ${span.from === rowPos(doc, 'AAABBB')}:${span.to === rowPos(doc, 'AAABBB') + doc.nodeAt(rowPos(doc, 'AAABBB')).nodeSize}` : 'null',
    '1 行 true:true',
  )
}

// 10) 把这一整行拖到别的行后面
{
  const st = EditorState.create({ schema, doc: mixed() })
  const start = rowText(st.doc, 'AAABBB')
  const span = draggedRows(st.doc, start + 3, start + 6)!
  const target = rowPos(st.doc, 'DDDEEE') + st.doc.nodeAt(rowPos(st.doc, 'DDDEEE')).nodeSize
  const tr = moveRangeTransaction(st, span.from, span.to, target)
  check('行内选中后拖到末尾', tr ? outline(tr.doc) : 'null', 'cb[CCC | DDDEEE | AAABBB]')
}

// 11) 跨块拖同一行
{
  const doc = schema.node('doc', null, [cb(p('AAABBB')), cb(p('CCC'), p('DDDEEE'))])
  const st = EditorState.create({ schema, doc })
  const start = rowText(st.doc, 'AAABBB')
  const span = draggedRows(st.doc, start + 3, start + 6)!
  const target = rowPos(st.doc, 'CCC') + st.doc.nodeAt(rowPos(st.doc, 'CCC')).nodeSize
  const tr = moveRangeTransaction(st, span.from, span.to, target)
  check('行内选中后跨块拖', tr ? outline(tr.doc) : 'null', 'cb[CCC | AAABBB | DDDEEE]')
}

// 12) 拖到侧栏别的笔记：发过去的也是整行（不是那几个字）
{
  const st = EditorState.create({ schema, doc: mixed() })
  const start = rowText(st.doc, 'AAABBB')
  const span = draggedRows(st.doc, start + 3, start + 6)!
  const blocks = rangeBlocks(st, span.from, span.to)
  check(
    '行内选中导出的是整行',
    blocks.map((b: any) => `${b.type}:${(b.content || []).map((c: any) => c.text).join('')}`).join(','),
    'paragraph:AAABBB',
  )
}

// 13) 贴着一行上下边缘选中（从行首选到行尾）同样是这一整行
{
  const doc = mixed()
  const start = rowText(doc, 'DDDEEE')
  const span = draggedRows(doc, start, start + 6)
  check('整行选中', span ? `${span.rows}` : 'null', '1')
}

// ── 什么都没选中，只按住一行：也是整行拖动 ─────────────
//
// 用户报告："长按某一行（不选中文字的情况下），也应该能拖这一行。"
// 这里先验纯函数部分：光标落在行内任意位置 → 得到这一整行。

const rowAt = (doc: PMNode, pos: number) => spanAtRow(doc, pos)

// 14) 光标在行中间
{
  const doc = mixed()
  const start = rowText(doc, 'AAABBB')
  const span = rowAt(doc, start + 2)
  check(
    '按住一行：拿到整行',
    span ? `${span.rows} 行 ${span.from === rowPos(doc, 'AAABBB')}:${span.to === rowPos(doc, 'AAABBB') + doc.nodeAt(rowPos(doc, 'AAABBB')).nodeSize}` : 'null',
    '1 行 true:true',
  )
}

// 15) 按住一行直接丢到别的行后面
{
  const st = EditorState.create({ schema, doc: mixed() })
  const span = rowAt(st.doc, rowText(st.doc, 'AAABBB') + 1)!
  const target = rowPos(st.doc, 'DDDEEE') + st.doc.nodeAt(rowPos(st.doc, 'DDDEEE')).nodeSize
  const tr = moveRangeTransaction(st, span.from, span.to, target)
  check('按住一行拖到末尾', tr ? outline(tr.doc) : 'null', 'cb[CCC | DDDEEE | AAABBB]')
}

// 16) 按在块边界（不是某一行里面）→ 没有可拖的行
{
  const doc = schema.node('doc', null, [cb(p('A1')), p('尾行')])
  check('块边界上没有行', rowAt(doc, 0) ? 'row' : 'null', 'null')
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 个`)
process.exit(failed === 0 ? 0 : 1)
