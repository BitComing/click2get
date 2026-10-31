// 临时验证脚本：node docs/_move-test.ts（跑完即可删）
//
// 注意图片节点是**行内**的（和 src/editor/extensions.ts 里 `configure({ inline: true })` 一致）：
// 一张图独占一行时，它待在一个只有它的段落里。以前这里把图声明成块级，
// 和真实文档结构不一致，于是这个脚本里的四条用例一直是"图丢了"的假失败。
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { moveImageTransaction } from '../src/editor/moveImage.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    captureBlock: { content: 'block*', group: 'block', defining: false },
    image: { group: 'inline', inline: true, atom: true, attrs: { id: {} }, draggable: false },
  },
})

const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
const img = (id: string) => schema.node('image', { id })
/** 图片独占的一"行"：只有这张图的段落 */
const imgRow = (id: string) => schema.node('paragraph', null, [img(id)])
const cb = (...kids: PMNode[]) => schema.node('captureBlock', null, kids)

/** 一行里有什么：文字原样，行内图片记作 img(id) */
const label = (k: PMNode) => {
  const parts: string[] = []
  k.forEach((c) => parts.push(c.type.name === 'image' ? `img(${c.attrs.id})` : (c.text ?? '')))
  return parts.join('') || '空行'
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

const findImg = (doc: PMNode, id: string) => {
  let found = -1
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'image' && node.attrs.id === id) found = pos
  })
  return found
}

const findText = (doc: PMNode, text: string) => {
  let found = -1
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) found = pos
  })
  return found
}

let failed = 0
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${actual}${ok ? '' : `\n  期望 ${expected}`}`)
}

function run(
  state: EditorState,
  imgId: string,
  targetPos: number,
): { doc: PMNode } | null {
  const srcPos = findImg(state.doc, imgId)
  const srcNode = state.doc.nodeAt(srcPos)
  if (!srcNode) throw new Error('找不到图片')
  const tr = moveImageTransaction(state, srcPos, targetPos, srcNode)
  return tr ? { doc: tr.doc } : null
}

// 场景：两段文字 + 图片行 + 图片行 + 尾行
const base = () =>
  schema.node('doc', null, [
    cb(p('A1'), p('A2')),
    cb(imgRow('X')),
    cb(imgRow('Y')),
    p('尾行'),
  ])

// 1) 把 X 拖进 cb1 的两行之间 —— 图片独占的块要整块消失
{
  const st = EditorState.create({ schema, doc: base() })
  const target = findText(st.doc, 'A2') - 1 // A2 段落起点
  const r = run(st, 'X', target)
  check('拖进别的块的两行之间', r ? outline(r.doc) : 'null', 'cb[A1 | img(X) | A2] , cb[img(Y)] , 尾行')
}

// 2) 往上拖：把 Y 拖到最前
{
  const st = EditorState.create({ schema, doc: base() })
  const target = 0
  const r = run(st, 'Y', target)
  check('拖到文档最前', r ? outline(r.doc) : 'null', 'img(Y) , cb[A1 | A2] , cb[img(X)] , 尾行')
}

// 3) 往下拖：把 X 拖到尾部（目标在源之后，要补偿位置偏移）
{
  const st = EditorState.create({ schema, doc: base() })
  const target = findText(st.doc, '尾行') - 1
  const r = run(st, 'X', target)
  check('拖到尾部（位置补偿）', r ? outline(r.doc) : 'null', 'cb[A1 | A2] , cb[img(Y)] , img(X) , 尾行')
}

// 4) 丢回自己身上 = 不动
{
  const st = EditorState.create({ schema, doc: base() })
  const r = run(st, 'X', findImg(st.doc, 'X'))
  check('丢回原地', r ? outline(r.doc) : 'null', 'null')
}

// 5) 块里还有别的内容：只删图片，块要留着
{
  const doc = schema.node('doc', null, [cb(p('B1'), imgRow('Z'), p('B2')), p('尾行')])
  const st = EditorState.create({ schema, doc })
  const target = findText(st.doc, 'B1') - 1
  const r = run(st, 'Z', target)
  check('多内容块里移动图片', r ? outline(r.doc) : 'null', 'cb[img(Z) | B1 | B2] , 尾行')
}

// 6) 非法落点（段落文字中间）要被拒绝，不能抛异常
{
  const st = EditorState.create({ schema, doc: base() })
  const target = findText(st.doc, 'A1') + 1
  const r = run(st, 'X', target)
  check('非法落点被拒绝', r ? outline(r.doc) : 'null', 'null')
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 个`)
process.exit(failed === 0 ? 0 : 1)