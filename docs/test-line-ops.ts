// 行级编辑回归：node --experimental-strip-types docs\test-line-ops.ts
// 覆盖 Backspace / Delete / Enter 在"块内、跨块、块外段落、图片相邻"各种位置上的行为，
// 再用随机文档跑不变量：行数只许减不许增、捕获块只许减不许增、不留空块。
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { deleteLineBackward, deleteLineForward, splitLine, trailingLineTr, type LineResult } from '../src/editor/lineOps.ts'
import { normalizeDoc } from '../src/editor/normalize.ts'

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
      group: 'block',
      atom: true,
      draggable: false,
      attrs: { hash: { default: null } },
      toDOM: () => ['img'],
    },
    text: { group: 'inline' },
  },
})

const p = (t = '') => schema.node('paragraph', null, t ? [schema.text(t)] : [])
const img = (hash = 'x') => schema.node('image', { hash })
const cb = (...kids: PMNode[]) => schema.node('captureBlock', null, kids)
const doc = (...kids: PMNode[]) => schema.node('doc', null, kids)

/** 和 extensions.ts 里 CaptureBlock 的 appendTransaction 一致的收尾 */
function cleanup(state: EditorState): EditorState {
  const empty: Array<{ pos: number; size: number }> = []
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'captureBlock' && node.childCount === 0) {
      empty.push({ pos, size: node.nodeSize })
    }
  })
  if (empty.length === 0) return state
  let tr = state.tr
  for (let i = empty.length - 1; i >= 0; i--) {
    const e = empty[i]
    if (state.doc.childCount === 1 && e.pos === 0) {
      tr = tr.replaceWith(0, e.size, schema.nodes.paragraph.create())
    } else {
      tr = tr.delete(e.pos, e.pos + e.size)
    }
  }
  return state.apply(tr)
}

function outline(doc: PMNode): string {
  const parts: string[] = []
  doc.forEach((child) => {
    if (child.type.name === 'captureBlock') {
      const inner: string[] = []
      child.forEach((k) =>
        inner.push(k.type.name === 'image' ? `img(${k.attrs.hash})` : k.textContent || '空行'),
      )
      parts.push(`cb[${inner.join(' | ')}]`)
    } else if (child.type.name === 'image') {
      parts.push(`img(${child.attrs.hash})`)
    } else {
      parts.push(`段落:${child.textContent || '空行'}`)
    }
  })
  return parts.join(' , ')
}

function lineCount(doc: PMNode): number {
  let n = 0
  doc.forEach((b) => (b.isTextblock ? (n += 1) : b.forEach(() => (n += 1))))
  return n
}
function blockCount(doc: PMNode): number {
  let n = 0
  doc.forEach((b) => b.type.name === 'captureBlock' && (n += 1))
  return n
}

/** 找第 nth 个内容等于 text 的段落，返回它内容起点 */
function startOf(doc: PMNode, text: string, nth = 0): number {
  let hit = -1
  let seen = 0
  doc.descendants((node, pos) => {
    if (hit >= 0) return false
    if (node.isTextblock && node.textContent === text) {
      if (seen === nth) hit = pos + 1
      seen += 1
    }
    return true
  })
  return hit
}
function endOf(doc: PMNode, text: string, nth = 0): number {
  const s = startOf(doc, text, nth)
  return s < 0 ? -1 : s + text.length
}
function imagePos(doc: PMNode, hash = 'x'): number {
  let hit = -1
  doc.descendants((node, pos) => {
    if (hit < 0 && node.type.name === 'image' && node.attrs.hash === hash) hit = pos
  })
  return hit
}

type Key = 'Backspace' | 'Delete' | 'Enter'
const COMMANDS: Record<Key, (s: EditorState) => LineResult> = {
  Backspace: deleteLineBackward,
  Delete: deleteLineForward,
  Enter: splitLine,
}

/** 模拟编辑器：按键 → 事务 → 选块收尾，返回新状态（选区跟着映射） */
function press(state: EditorState, key: Key): { state: EditorState; handled: boolean } {
  const result = COMMANDS[key](state)
  if (result === undefined) return { state, handled: false }
  if (result === null) return { state, handled: true }
  return { state: cleanup(state.apply(result as Transaction)), handled: true }
}

let failed = 0
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${actual}${ok ? '' : `\n  期望 ${expected}`}`)
}

function caret(doc: PMNode, pos: number): EditorState {
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) })
}
function caretOnImage(doc: PMNode, pos: number): EditorState {
  return EditorState.create({ schema, doc, selection: NodeSelection.create(doc, pos) })
}

// ── 固定场景 ──────────────────────────────────────────────

// 1. 跨块退格：两行并一行
{
  const d = doc(cb(p('aaa')), cb(p('bbb')))
  const r = press(caret(d, startOf(d, 'bbb')), 'Backspace')
  check('跨块退格把两行并成一行', outline(r.state.doc), 'cb[aaabbb]')
}

// 2. 跨块 Delete：同样两行并一行
{
  const d = doc(cb(p('aaa')), cb(p('bbb')))
  const r = press(caret(d, endOf(d, 'aaa')), 'Delete')
  check('跨块 Delete 把两行并成一行', outline(r.state.doc), 'cb[aaabbb]')
}

// 3. 块里最后一行是空行：退格删掉这一行
{
  const d = doc(cb(p('aaa'), p('')))
  const r = press(caret(d, startOf(d, '')), 'Backspace')
  check('空行退格：行没了', outline(r.state.doc), 'cb[aaa]')
}

// 4. 块里中间的空行：退格删掉这一行，后面那行不动
{
  const d = doc(cb(p('aaa'), p(''), p('ccc')))
  const r = press(caret(d, startOf(d, '')), 'Backspace')
  check('中间空行退格：只少这一行', outline(r.state.doc), 'cb[aaa | ccc]')
}

// 5. 行首退格是"并到上一行"，不是"把块拆开"
{
  const d = doc(cb(p('aaa'), p('bbb')))
  const r = press(caret(d, startOf(d, 'bbb')), 'Backspace')
  check('块内退格并上一行', outline(r.state.doc), 'cb[aaabbb]')
}

// 6. 块外段落（旧笔记的形状）：退格把它吃掉，别 wrap 成新块
{
  const d = doc(cb(p('aaa')), p(''), cb(p('bbb')))
  const r = press(caret(d, startOf(d, '')), 'Backspace')
  check('块外空段落退格：并进上一块', outline(r.state.doc), 'cb[aaa] , cb[bbb]')
}

// 7. 块外段落 + Delete：同样吃掉，别把下一块的行 lift 出来
{
  const d = doc(cb(p('aaa')), p(''), cb(p('bbb')))
  const r = press(caret(d, startOf(d, '')), 'Delete')
  check('块外空段落 Delete：整段消失', outline(r.state.doc), 'cb[aaa] , cb[bbb]')
}

// 8. 块外有字的段落：并进上一块
{
  const d = doc(cb(p('aaa')), p('手写的一行'), cb(p('bbb')))
  const r = press(caret(d, startOf(d, '手写的一行')), 'Backspace')
  check('块外有字段落并进上一块', outline(r.state.doc), 'cb[aaa手写的一行] , cb[bbb]')
}

// 9. 一行末尾回车：块里多一行（不跑到块外）
{
  const d = doc(cb(p('aaa')))
  const r = press(caret(d, endOf(d, 'aaa')), 'Enter')
  check('回车在块里拆行', outline(r.state.doc), 'cb[aaa | 空行]')
}

// 10. 行中间回车
{
  const d = doc(cb(p('aabb')))
  const r = press(caret(d, startOf(d, 'aabb') + 2), 'Enter')
  check('回车从光标处拆行', outline(r.state.doc), 'cb[aa | bb]')
}

// 11. 空行上回车：还是块里两行空行（以前会被 lift 到块外）
{
  const d = doc(cb(p('aaa'), p('')))
  const r = press(caret(d, startOf(d, '')), 'Enter')
  check('空行回车留在块里', outline(r.state.doc), 'cb[aaa | 空行 | 空行]')
}

// 12. 第一行行首退格：什么都不做，也绝不把块拆开
{
  const d = doc(cb(p('aaa'), p('bbb')))
  const r = press(caret(d, startOf(d, 'aaa')), 'Backspace')
  check('第一行行首退格不动文档', outline(r.state.doc), 'cb[aaa | bbb]')
}

// 13. 最后一行行尾 Delete：什么都不做
{
  const d = doc(cb(p('aaa'), p('bbb')))
  const r = press(caret(d, endOf(d, 'bbb')), 'Delete')
  check('最后一行行尾 Delete 不动文档', outline(r.state.doc), 'cb[aaa | bbb]')
}

// 14. 上一行是图片：先选中图片，不删
{
  const d = doc(cb(img('X')), cb(p('bbb')))
  const r = press(caret(d, startOf(d, 'bbb')), 'Backspace')
  const sel = r.state.selection
  check(
    '图片前面退格：选中图片',
    `${outline(r.state.doc)} / ${sel instanceof NodeSelection ? 'NodeSelection' : 'Text'}`,
    'cb[img(X)] , cb[bbb] / NodeSelection',
  )
}

// 15. 空行前面是图片：空行先删掉，落点选到图片上
{
  const d = doc(cb(img('X'), p('')))
  const r = press(caret(d, startOf(d, '')), 'Backspace')
  const sel = r.state.selection
  check(
    '图片后面的空行退格',
    `${outline(r.state.doc)} / ${sel instanceof NodeSelection ? 'NodeSelection' : 'Text'}`,
    'cb[img(X)] / NodeSelection',
  )
}

// 16. 图片节点上回车：在图片后面补一行，仍然在块里
{
  const d = doc(cb(img('X')))
  const r = press(caretOnImage(d, imagePos(d, 'X')), 'Enter')
  check('图片上回车补一行', outline(r.state.doc), 'cb[img(X) | 空行]')
}

// 17. 三块连着退（每次把光标放回最后一行的行首）：每次只少一行，最后剩一行
{
  const d = doc(cb(p('a')), cb(p('b')), cb(p('c')))
  let st = caret(d, startOf(d, 'c'))
  const trace: number[] = [lineCount(st.doc)]
  for (let i = 0; i < 4; i++) {
    // 光标放到当前最后一行行首（等于用户把光标点到那儿）
    let lastStart = -1
    st.doc.descendants((node, pos) => {
      if (node.isTextblock) lastStart = pos + 1
    })
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, lastStart)))
    st = press(st, 'Backspace').state
    trace.push(lineCount(st.doc))
  }
  check('连按退格行数单调减到底', trace.join(' → ') + ' / ' + outline(st.doc), '3 → 2 → 1 → 1 → 1 / cb[abc]')
}

// 18. 捕获文本自带结尾换行（每条捕获末尾都有一个空行）时，退格删的是最后那个空行
{
  const d = doc(cb(p('aaa'), p('')), cb(p('bbb'), p('')))
  const r = press(caret(d, startOf(d, '')), 'Backspace')
  check('结尾空行退格', outline(r.state.doc), 'cb[aaa] , cb[bbb | 空行]')
}

// 19. 整篇只有一个空段落：两个键都不动
{
  const d = doc(p(''))
  const a = press(caret(d, 1), 'Backspace').state
  const b = press(caret(d, 1), 'Delete').state
  check('空笔记退格/删除都不动', `${outline(a.doc)} / ${outline(b.doc)}`, '段落:空行 / 段落:空行')
}

// 20. 行间距统一：跨块退格把两行并成一行，再按回车拆开 ——
//     拆出来的两行必须留在**同一个块里**，这样它们之间的关系跟普通两行完全一样
//     （块内行距和块间行距在 styles.css 里是同一个 14px，见"行间距只有一个来源"）
{
  const d = doc(cb(p('aaa')), cb(p('bbb')))
  const merged = press(caret(d, startOf(d, 'bbb')), 'Backspace').state
  const r = press(merged, 'Enter').state
  check('跨块合并后再回车：两行仍同一个块', outline(r.doc), 'cb[aaa | bbb]')

  // 再退一次、再回车一次，结构不能漂到块外去
  const back = press(r, 'Backspace').state
  const again = press(back, 'Enter').state
  check('反复合并/拆行不会把行甩出块外', outline(again.doc), 'cb[aaa | bbb]')
}

// 21. 块外段落上做同样的事：两行都留在块外，不是一行在块里一行在块外
{
  const d = doc(p('aaa'), p('bbb'))
  const merged = press(caret(d, startOf(d, 'bbb')), 'Backspace').state
  const r = press(merged, 'Enter').state
  check('块外段落合并再回车：仍是块外段落', outline(r.doc), '段落:aaa , 段落:bbb')
}

// ── 光标位置：行首退格不许跳 ─────────────────────────────
//
// 用户报告：光标在"有内容的一行"的开头、上面一行是空行时，按退格光标会跳到
// 这一行文字的**结尾**，有时候干脆跳到**下一行**。原因是当时按"删之前的坐标"
// 算落点（cur.textTo），删掉上面那一行之后这个坐标就偏了一整行。

/** 光标落在哪个字上、偏移多少 —— 断言行首退格"光标原地不动"用 */
function caretInfo(state: EditorState): string {
  const sel = state.selection
  if (!(sel instanceof TextSelection)) return sel instanceof NodeSelection ? 'NodeSelection' : '其他'
  const $h = sel.$head
  return `${$h.parent.textContent || '空行'}@${$h.parentOffset}`
}

// 22. 上面一行是空的：空行被吃掉，光标留在这一行开头
{
  const d = doc(cb(p(''), p('bbb'), p('ccc')))
  const r = press(caret(d, startOf(d, 'bbb')), 'Backspace')
  check(
    '上一行是空行：退格后光标还在行首',
    `${outline(r.state.doc)} / ${caretInfo(r.state)}`,
    'cb[bbb | ccc] / bbb@0',
  )
}

// 23. 行再长也一样（差一整行时，短行会跳进行尾、长行会跳进下一行，这里两种长度都试）
{
  const d = doc(cb(p('aaa'), p(''), p('hello world'), p('tail')))
  const r = press(caret(d, startOf(d, 'hello world')), 'Backspace')
  check(
    '长行行首退格：光标不动',
    `${outline(r.state.doc)} / ${caretInfo(r.state)}`,
    'cb[aaa | hello world | tail] / hello world@0',
  )
}

// 24. 上一行在**另一块**里：跨块退格同样只删空行，光标留在行首
{
  const d = doc(cb(p('aaa'), p('')), cb(p('bbb')))
  const r = press(caret(d, startOf(d, 'bbb')), 'Backspace')
  check(
    '跨块空行退格：光标留在行首',
    `${outline(r.state.doc)} / ${caretInfo(r.state)}`,
    'cb[aaa] , cb[bbb] / bbb@0',
  )
}

// 25. 连着一串空行：每按一次少一行，光标一直在这一行开头
{
  const d = doc(cb(p(''), p(''), p(''), p('target')))
  let st = caret(d, startOf(d, 'target'))
  const trace: string[] = []
  for (let i = 0; i < 4; i++) {
    st = press(st, 'Backspace').state
    trace.push(`${outline(st.doc)} ${caretInfo(st)}`)
  }
  check(
    '一串空行连按退格：光标一直停在行首',
    trace.join(' → '),
    'cb[空行 | 空行 | target] target@0 → cb[空行 | target] target@0 → cb[target] target@0 → cb[target] target@0',
  )
}

// 26. 后面还跟着图片块时也一样：只删空行，光标留在行首
{
  const d = doc(cb(p('fig'), p(''), p('x')), cb(img('Y')))
  const r = press(caret(d, startOf(d, 'x')), 'Backspace')
  check(
    '空行退格（后面还有图片块）',
    `${outline(r.state.doc)} / ${caretInfo(r.state)}`,
    'cb[fig | x] , cb[img(Y)] / x@0',
  )
}

// ── normalizeDoc ─────────────────────────────────────────
{
  const old = {
    type: 'doc',
    content: [
      { type: 'paragraph' },
      { type: 'captureBlock', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }, { type: 'paragraph' }] },
      { type: 'paragraph' },
      { type: 'captureBlock', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '手写' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '两行' }] },
      { type: 'captureBlock', content: [] },
    ],
  }
  const n = normalizeDoc(old)
  const node = schema.nodeFromJSON(n)
  check(
    '旧笔记规整：块外段落按原顺序收回块里',
    outline(node),
    'cb[A | 空行 | 空行] , cb[B | 手写 | 两行]',
  )
  check('旧笔记规整：空块被丢掉', String(n.content.length), '2')
}

// ── 末尾补一行（尾行只在以图收尾时补，而且补在块里）──────
function trail(d: PMNode): string {
  const st = EditorState.create({ schema, doc: d })
  const tr = trailingLineTr(st)
  return outline(tr ? st.apply(tr).doc : d)
}
check('尾行：以文字收尾不补', trail(doc(cb(p('aaa')))), 'cb[aaa]')
check('尾行：以空行收尾不补（删掉就不会再长回来）', trail(doc(cb(p('aaa'), p('')))), 'cb[aaa | 空行]')
check('尾行：块以图收尾，在块里补一行', trail(doc(cb(img('X')))), 'cb[img(X) | 空行]')
check('尾行：图片后已有空行就不再补', trail(doc(cb(img('X'), p('')))), 'cb[img(X) | 空行]')

// ── 随机不变量 ───────────────────────────────────────────
let rnd = 1234567
function rand(n: number) {
  rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
  return rnd % n
}
const words = ['a', 'bb', 'ccc', '', '']
function randomDoc(): PMNode {
  const blocks: PMNode[] = []
  const nBlocks = 1 + rand(4)
  for (let i = 0; i < nBlocks; i++) {
    const kind = rand(6)
    if (kind === 0) {
      blocks.push(img(`h${i}`))
      continue
    }
    if (kind === 1) {
      blocks.push(p(words[rand(words.length)]))
      continue
    }
    const rows: PMNode[] = []
    const nRows = 1 + rand(4)
    for (let k = 0; k < nRows; k++) rows.push(rand(8) === 0 ? img(`h${i}${k}`) : p(words[rand(words.length)]))
    blocks.push(cb(...rows))
  }
  return doc(...blocks)
}

const keys: Key[] = ['Backspace', 'Delete', 'Enter']
let ivFail = 0
for (let t = 0; t < 400; t++) {
  let st = EditorState.create({ schema, doc: randomDoc() })
  for (let step = 0; step < 6; step++) {
    const before = lineCount(st.doc)
    const beforeBlocks = blockCount(st.doc)
    // 随便挑一个位置下手：段落起点 / 终点 / 中间
    const rows: number[] = []
    st.doc.descendants((node, pos) => {
      if (node.isTextblock) {
        rows.push(pos + 1, pos + node.nodeSize - 1)
        if (node.content.size > 1) rows.push(pos + 1 + rand(node.content.size - 1))
      }
    })
    if (rows.length === 0) break
    const pos = rows[rand(rows.length)]
    let sel
    try {
      sel = TextSelection.create(st.doc, pos)
    } catch {
      continue
    }
    st = st.apply(st.tr.setSelection(sel))
    const key = keys[rand(keys.length)]
    let after: EditorState
    try {
      after = press(st, key).state
    } catch (e) {
      ivFail++
      console.log(`FAIL  随机用例抛异常：${(e as Error).message}\n      ${outline(st.doc)}`)
      break
    }
    const afterLines = lineCount(after.doc)
    const afterBlocks = blockCount(after.doc)
    // 回车本来就会多一行（拆行），退格 / Delete 只许多减不许增
    const allowed = before + (key === 'Enter' ? 1 : 0)
    if (afterLines > allowed) {
      ivFail++
      console.log(`FAIL  行数不对：「${key}」 ${outline(st.doc)} → ${outline(after.doc)}`)
    }
    if (afterBlocks > beforeBlocks) {
      ivFail++
      console.log(`FAIL  捕获块变多：「${key}」 ${outline(st.doc)} → ${outline(after.doc)}`)
    }
    let emptyBlock = false
    after.doc.forEach((b) => {
      if (b.type.name === 'captureBlock' && b.childCount === 0) emptyBlock = true
    })
    if (emptyBlock) {
      ivFail++
      console.log(`FAIL  留下空块：「${key}」 ${outline(after.doc)}`)
    }
    // 光标必须落在一个真实的位置上：文字行里的某一个字缝，或者一整张图。
    // 落在块边界上 = 算坐标时用了删之前的旧位置（转到别的行去就是这么来的）。
    const s = after.selection
    const okSel =
      (s instanceof TextSelection && s.$head.parent.inlineContent) || s instanceof NodeSelection
    if (!okSel) {
      ivFail++
      console.log(`FAIL  光标位置不合法：「${key}」 ${outline(after.doc)}`)
    }
    st = after
  }
  if (ivFail > 6) break
}
check('随机 400 组：行数不增、块不增、不留空块、光标位置合法', ivFail === 0 ? '通过' : `失败 ${ivFail} 处`, '通过')

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 个`)
process.exit(failed === 0 ? 0 : 1)