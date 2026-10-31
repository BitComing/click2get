// 回归：捕获进笔记时的节点构造（node --experimental-strip-types docs\test-insert.ts）
//
// 重点盯两类毛病：
// - 间距：复制来的文字几乎都以换行结尾，块尾不能因此多出一个空行（手打回车不会多）；
//   开头也一样；原文的空行也不该撑出空段落来。
// - 换行方式：复制进来的多行**一行一个段落**（行就是编辑单位）。
//   全塞进一个段落里，整段就变成"一行"，看着就是"原来的换行被删掉了"。
import { buildNode, defaultImageWidth, type Capture } from '../src/editor/insert.ts'

let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}\n      期望 ${e}\n      实际 ${a}`)
  }
}

const capture = (over: Partial<Capture>): Capture => ({
  kind: 'text',
  ts: 1,
  text: '',
  ...over,
})

/** 块里的每一行：段落里按硬换行拆开，有字的给文字，空行给 '' */
function lines(node: any): string[] {
  const out: string[] = []
  for (const p of node.content ?? []) {
    if (p.type === 'image') {
      out.push('<img>')
      continue
    }
    let cur = ''
    for (const t of p.content ?? []) {
      if (t.type === 'hardBreak') {
        out.push(cur)
        cur = ''
        continue
      }
      cur += t.text ?? ''
    }
    out.push(cur)
  }
  return out
}

/** 段落里所有 text 节点（找链接标记用） */
function texts(node: any): any[] {
  return (node.content ?? []).flatMap((p: any) => (p.content ?? []).filter((t: any) => t.type === 'text'))
}

/** 硬换行的个数 */
function breaks(node: any): number {
  return (node.content ?? []).reduce(
    (n: number, p: any) => n + (p.content ?? []).filter((t: any) => t.type === 'hardBreak').length,
    0,
  )
}

// ── 首尾空行 ────────────────────────────────────────

check('结尾一个换行：不多出空行', lines(buildNode(capture({ text: '第一行\n第二行\n' }))), [
  '第一行',
  '第二行',
])

check('结尾好几个换行：一个空行都不留', lines(buildNode(capture({ text: '只有一行\n\n\n' }))), [
  '只有一行',
])

check('开头空行：一样去掉', lines(buildNode(capture({ text: '\n\n第一行' }))), ['第一行'])

check('首尾都有空行：两头都干净', lines(buildNode(capture({ text: '\n   \n第一行\n第二行\n\t\n' }))), [
  '第一行',
  '第二行',
])

check('中间的空行不留：内容之间只留一个换行', lines(buildNode(capture({ text: '第一行\n\n第三行\n' }))), [
  '第一行',
  '第三行',
])

check('连续好几个空行也只算一个换行', lines(buildNode(capture({ text: '第一行\n\n\n\n第三行' }))), [
  '第一行',
  '第三行',
])

// 空行全被去掉以后块就空了，得留一个空段落 —— captureBlock 的 content 是 block*
check('只有空白：留一个空段落', lines(buildNode(capture({ text: '\n \n' }))), [''])

check('CRLF 一样处理', lines(buildNode(capture({ text: '第一行\r\n第二行\r\n' }))), [
  '第一行',
  '第二行',
])

check('单独的 \\r 也当换行', lines(buildNode(capture({ text: '第一行\r第二行' }))), ['第一行', '第二行'])

check('U+2028 也当换行', lines(buildNode(capture({ text: '第一行\u2028第二行' }))), [
  '第一行',
  '第二行',
])

// ── 换行方式：一行一个段落 ──────────────────────────

const multi = buildNode(capture({ text: '第一行\n第二行\n第三行\n' }))
check('三行落成三个段落', multi.content.length, 3)
check('段落之间不再靠硬换行', breaks(multi), 0)
check('每段的文字就是原来那一行', lines(multi), ['第一行', '第二行', '第三行'])

const blank = buildNode(capture({ text: '第一行\n\n第三行\n' }))
check('空行不产生空段落', blank.content.length, 2)

// ── 链接与截断 ──────────────────────────────────────

const one = buildNode(capture({ text: '示例站点\n', href: 'https://example.com/' }))
check('整段一个链接：带上 href', lines(one), ['示例站点'])
check('整段一个链接：mark 是 link', texts(one)[0].marks?.[0]?.attrs?.href, 'https://example.com/')

const many = buildNode(
  capture({ text: '一句话 https://a.test/x 夹着网址\n第二行\n', href: 'https://x.test/' }),
)
check('多行时不整段套 href', lines(many), ['一句话 https://a.test/x 夹着网址', '第二行'])
check(
  '多行时逐行识别网址',
  texts(many).find((t) => t.marks?.length)?.marks?.[0]?.attrs?.href,
  'https://a.test/x',
)

const cut = buildNode(capture({ text: '第一行\n', truncated: true }))
check('截断提示跟在内容后面', lines(cut), ['第一行', '（内容过长，已截断到 1 MB）'])

// ── 图片 ────────────────────────────────────────────

const img = buildNode({ kind: 'image', ts: 1, path: 'images/ab/cd.png', hash: 'H', w: 800, h: 600 })
check('一张图就是一个段落里的一个行内节点', img.content.length, 1)
check('图片节点带 path / hash / 原尺寸 / 初始宽度', img.content[0].content[0].attrs, {
  path: 'images/ab/cd.png',
  hash: 'H',
  w: 800,
  h: 600,
  width: 260,
  alt: '',
  title: null,
})

// 长（高）大于宽：比默认 420 小一点；长小于宽：收得更多
check('竖图（高 > 宽）只收一点', defaultImageWidth(800, 1200), 357)
check('横图（高 < 宽）收得更多', defaultImageWidth(1600, 900), 260)
check('正方形按默认宽度', defaultImageWidth(800, 800), 420)
check('小图不放大', defaultImageWidth(200, 300), 200)
check('不知道原尺寸就交给 CSS', defaultImageWidth(null, null), null)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)