// 拖拽落点线的位置回归：node --experimental-strip-types docs\test-drop-line.ts
//
// 覆盖一件事：**一条缝只有一个落点提示**。
//
// 一条视觉上的缝（两行之间那 14px）在文档里对应**好几个**插入位置：
// 上一段的末尾、上一块的末尾、下一块的开头、下一段的开头。指针在缝里挪一两像素，
// posAtCoords 就在它们之间来回换。老算法"从插入位置朝两边量 coordsAtPos"，
// 可位置落在段落里时量到的只是那一行文字自己的框，于是同一条缝里出现三个 y：
// 上一行的底边、缝的正中、下一行的顶边（62 / 69 / 76）—— 看上去像三个插入位置。
//
// 现在线的 y 只由"缝上下那两行"决定（dropLineAt + gapAround），和指针报的是哪个
// 插入位置无关：同一条缝里的所有位置都指向同一对行 → 只有一个 y。
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { dropLineAt, gapAround, type RowBox } from '../src/editor/dropLine.ts'

const ROW_H = 24
const GAP = 14
const LEFT = 100
const RIGHT = 700

let failed = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

// ── 小文档：两个捕获块，块里各有一两行 ─────────────────────
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    captureBlock: { content: 'block*', group: 'block', defining: false },
  },
})
const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
const cb = (...kids: PMNode[]) => schema.node('captureBlock', null, kids)
const doc = schema.node('doc', null, [cb(p('AA'), p('A2')), cb(p('BB'))])

/**
 * 按"一行 24 高、行间 14"把文档铺开，得到每个块位置的屏幕框（模拟 DOM：
 * 段落各自一行，容器的高就是里面第一行到最后一行的范围，空容器没有高度）。
 */
function makeLayout(root: PMNode): Map<number, RowBox> {
  const rects = new Map<number, RowBox>()
  let cursor = 0
  const walk = (node: PMNode, pos: number): RowBox | null => {
    if (node.isTextblock || (node.isLeaf && node.isBlock)) {
      const box: RowBox = { top: cursor, bottom: cursor + ROW_H, left: LEFT, right: RIGHT }
      cursor += ROW_H + GAP
      rects.set(pos, box)
      return box
    }
    // 文档的内容从位置 0 开始，其它节点从 pos + 1 开始
    const start = node.type.name === 'doc' ? 0 : pos + 1
    const kids: RowBox[] = []
    node.forEach((child, offset) => {
      const box = walk(child, start + offset)
      if (box) kids.push(box)
    })
    if (kids.length === 0) return null
    const box: RowBox = {
      top: kids[0].top,
      bottom: kids[kids.length - 1].bottom,
      left: LEFT,
      right: RIGHT,
    }
    // doc 的位置也是 0，别把第一个块的框盖掉
    if (node.type.name !== 'doc') rects.set(pos, box)
    return box
  }
  walk(root, 0)
  return rects
}
/** doc 里第 i 个子块的块位置（顶层节点从 0 起算） */
const cbPos = (root: PMNode, i: number) => {
  let at = 0
  root.forEach((node, _offset, index) => {
    if (index < i) at += node.nodeSize
  })
  return at
}
const rowPos = (root: PMNode, text: string) => {
  let found = -1
  root.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isTextblock && node.textContent === text) found = pos
    return true
  })
  return found
}

const rects = makeLayout(doc)
const rectOf = (pos: number) => rects.get(pos) ?? null
const yOf = (row: number, after: boolean) => {
  const gap = gapAround(doc, row, after, rectOf)
  return dropLineAt(gap.above, gap.below, rectOf(row) as RowBox).y
}

// ── 1. 跨块的一道缝：四个插入位置 → 同一个 y ─────────────────
console.log('一块的最后一行与下一块的第一行之间')
const seam = yOf(rowPos(doc, 'A2'), true)
ok('上一段末尾（悬浮在 A2 上）', seam === 69, `y=${seam}`)
ok('上一块末尾（悬浮在捕获块上）', yOf(cbPos(doc, 0), true) === 69, `y=${yOf(cbPos(doc, 0), true)}`)
ok('下一块开头（悬浮在捕获块上）', yOf(cbPos(doc, 1), false) === 69, `y=${yOf(cbPos(doc, 1), false)}`)
ok('下一段开头（悬浮在 BB 上）', yOf(rowPos(doc, 'BB'), false) === 69, `y=${yOf(rowPos(doc, 'BB'), false)}`)
ok('缝的中点 = (62 + 76) / 2', seam === (62 + 76) / 2, `y=${seam}`)
ok(
  '老算法会给出三个不同的位置（62 / 69 / 76）',
  [62, 69, 76].every((v, i, all) => all.indexOf(v) === i),
)

// ── 2. 同一个块里的两行之间：同样只有一个 y ─────────────────
console.log('同一个捕获块里的两行之间')
ok('插在 AA 后面', yOf(rowPos(doc, 'AA'), true) === 31, `y=${yOf(rowPos(doc, 'AA'), true)}`)
ok('插在 A2 前面', yOf(rowPos(doc, 'A2'), false) === 31, `y=${yOf(rowPos(doc, 'A2'), false)}`)

// ── 3. 文档头 / 尾：只有一边能看到行 ────────────────────────
console.log('文档头尾')
ok('最上面贴着第一行的顶', yOf(rowPos(doc, 'AA'), false) === 0, `y=${yOf(rowPos(doc, 'AA'), false)}`)
ok('最下面贴着最后一行的底', yOf(rowPos(doc, 'BB'), true) === 100, `y=${yOf(rowPos(doc, 'BB'), true)}`)

// ── 4. 两侧都量不到时退回悬浮行的顶 ─────────────────────────
console.log('量不到坐标')
const only: RowBox = { top: 50, bottom: 74, left: LEFT, right: RIGHT }
ok('两侧都没有 → 悬浮行的顶', dropLineAt(null, null, only).y === 50)
ok('横向用悬浮行那一路的宽度', dropLineAt(null, null, only).left === LEFT && dropLineAt(null, null, only).width === RIGHT - LEFT)

// ── 5. 空容器不参与"缝"的测量 ───────────────────────────────
console.log('空容器')
{
  const root = schema.node('doc', null, [cb(p('AA')), cb(), cb(p('BB'))])
  const laid = makeLayout(root)
  const aa = rowPos(root, 'AA')
  const gap = gapAround(root, aa, true, (pos) => laid.get(pos) ?? null)
  const y = dropLineAt(gap.above, gap.below, laid.get(aa) as RowBox).y
  ok('中间的空块被跳过，仍然贴下一行', y === 31, `y=${y}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
if (failed) process.exit(1)