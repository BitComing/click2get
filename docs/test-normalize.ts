// 回归：打开笔记时的规整（node --experimental-strip-types docs\test-normalize.ts）
//
// 两条不能破的规矩：
// 1. **幂等**：normalizeDoc 跑一遍和跑十遍结果必须一样。以前它给"已经行内的图片"再包一层段落，
//    于是每打开一次就多一层 `paragraph > paragraph > image`，行级编辑（靠 depth 判断）跟着失效。
// 2. 块级图片（直接挂在 doc / captureBlock 下）仍然要补一层段落，老笔记才能打开。
import { normalizeDoc } from '../src/editor/normalize.ts'

type Json = Record<string, any>

let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`PASS  ${name}`)
    return
  }
  failed++
  console.log(`FAIL  ${name}\n      期望 ${e}\n      实际 ${a}`)
}

const p = (...content: Json[]) => ({ type: 'paragraph', ...(content.length ? { content } : {}) })
const text = (t: string) => ({ type: 'text', text: t })
const img = (hash: string) => ({ type: 'image', attrs: { path: `images/aa/bb/${hash}.png`, hash } })
const cb = (...content: Json[]) => ({ type: 'captureBlock', attrs: { ts: 1 }, content })
const doc = (...content: Json[]) => ({ type: 'doc', content })

/** 第一张图片上方套了几层段落（`cb > p > image` 是 1 层）。 */
function paragraphLayersAboveImage(root: Json): number {
  let found = -1
  const walk = (n: Json, layers: number) => {
    if (found >= 0) return
    if (n.type === 'image') {
      found = layers
      return
    }
    const inner = layers + (n.type === 'paragraph' ? 1 : 0)
    for (const kid of Array.isArray(n.content) ? n.content : []) walk(kid, inner)
  }
  walk(root, 0)
  return found
}

// ① 行内图片（正常笔记的样子）：一个字段都不该改，更不能再包一层
const inline = doc(cb(p(text('看图'), img('H1')), p(img('H2'))))
check('行内图片原样保留', normalizeDoc(inline), inline)
check('行内图片：图片上方只有 1 层段落', paragraphLayersAboveImage(normalizeDoc(inline)), 1)

// ② 幂等：跑四遍和跑一遍一样（这条如果红了，就是"打开一次多一层"又回来了）
let once = normalizeDoc(inline) as Json
let many = once
for (let i = 0; i < 4; i++) many = normalizeDoc(many) as Json
check('反复规整结果不变（幂等）', many, once)

// ③ 老数据的块级图片：直接挂在捕获块下面 → 补一层段落
const blockLevelInCb = doc(cb(p(text('上面一行')), img('H3')))
check(
  '捕获块下的块级图片补一层段落',
  normalizeDoc(blockLevelInCb),
  doc(cb(p(text('上面一行')), p(img('H3')))),
)

// ④ 更老的：图片直接挂在 doc 下
check('doc 下的块级图片补一层段落', normalizeDoc(doc(img('H4'))), doc(p(img('H4'))))

// ⑤ 标题里的图片也是行内的，不该被包
check(
  '标题里的图片不包段落',
  normalizeDoc(doc({ type: 'heading', attrs: { level: 1 }, content: [img('H5')] })),
  doc({ type: 'heading', attrs: { level: 1 }, content: [img('H5')] }),
)

// ⑥ 原有的两件事不能被这次改动带坏：块外段落收回捕获块、空捕获块摘掉
check(
  '块外段落收回相邻的捕获块',
  normalizeDoc(doc(cb(p(text('块里'))), p(text('块外')))),
  doc(cb(p(text('块里')), p(text('块外')))),
)
check('空捕获块被摘掉', normalizeDoc(doc(cb(), p(text('只剩这句')))), doc(p(text('只剩这句'))))

// ⑦ 新建笔记那种"占位空行 + 空块"：空行不留
check('开头的占位空行丢掉', normalizeDoc(doc(p(), cb(p(text('正文'))))), doc(cb(p(text('正文')))))

// ⑧ 空文档不炸
check('空 content 原样返回', normalizeDoc({ type: 'doc', content: [] }), { type: 'doc', content: [] })

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 个`)
process.exit(failed === 0 ? 0 : 1)