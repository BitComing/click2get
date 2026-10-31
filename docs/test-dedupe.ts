// 回归：捕获去重的判据（node --experimental-strip-types docs\test-dedupe.ts）
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { findDuplicate, normalizeCaptureText } from '../src/editor/dedupe.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false },
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

/** 一个段落里的两行：复制进来的多行现在长这样（行之间是硬换行） */
const hb = (a: string, b: string) =>
  schema.node('paragraph', null, [schema.text(a), schema.node('hardBreak'), schema.text(b)])

const doc = schema.node('doc', null, [
  cb(p('第一行'), p('第二行')),
  cb(p('单独一句')),
  cb(schema.node('paragraph', null, [img('H1')])),
  cb(hb('硬换行第一行', '硬换行第二行')),
  p('手打的一行'),
])

let failed = 0
function check(name: string, actual: string, expected: string) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${actual}${ok ? '' : `\n  期望 ${expected}`}`)
}

const hit = (kind: string, text?: string, hash?: string) => {
  const h = findDuplicate(doc, { kind, text, hash })
  return h ? `${h.kind}:${h.rows}` : 'null'
}

// 1) 整块文字完全相同 → 重复
check('同样的两行再复制一次', hit('text', '第一行\n第二行'), 'text:2')
// 2) 空白、换行符不同也算同一段（复制同一处内容经常差在行尾空格）
check('行尾空格 / CRLF 不影响判定', hit('text', '  第一行  \r\n第二行\r\n'), 'text:2')
// 3) 只是子串 → 不算重复（笔记里有一句更长的，不能把短的那句吞掉）
check('子串不算重复', hit('text', '第一行'), 'null')
// 4) 单行整块相同 → 重复
check('单个行块相同', hit('text', '单独一句'), 'text:1')
// 5) 手打的行也算
check('手打的行相同', hit('text', '手打的一行'), 'text:1')
// 6) 新内容照常进来
check('新内容不拦', hit('text', '从来没抄过的一句话'), 'null')
// 7) 图片按 hash 判重
check('同一张图', hit('image', undefined, 'H1'), 'image:1')
check('另一张图', hit('image', undefined, 'H2'), 'null')
// 8) 空内容不判重（后端本来就挡掉了 <2 字）
check('空文本不判重', hit('text', '   \n  '), 'null')
// 9) 多行落在同一个段落的硬换行里：也要按两行认出来
check('硬换行的多行照旧算同一段', hit('text', '硬换行第一行\n硬换行第二行'), 'text:2')
check('硬换行里的单行不算重复', hit('text', '硬换行第一行'), 'null')

check('带中间空行的内容再复制一次也算重复', hit('text', '第一行\n\n第二行'), 'text:2')
check('规整函数不留空行（和插入端的规则一致）', normalizeCaptureText('a\n\nb\n'), 'a\nb')

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 个`)
process.exit(failed === 0 ? 0 : 1)