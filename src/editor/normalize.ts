/**
 * 旧笔记的规整：两件事，都是为了让"行"的行为一致。
 *
 * 1. 把"块外的段落"收回捕获块里。
 *
 * 早先按回车时用的是 ProseMirror 默认逻辑，在捕获块里的空段落上会被 liftEmptyBlock
 * 抬到块外，变成 doc 下直接挂着的段落。这种段落和块里的行长得一样，但表现完全不同
 * （段间距按"顶层块"算、退格时又会被 join / wrap 折腾），是"删一行多一行"的另一半原因。
 *
 * 2. 把块级的图片包进段落里（图片现在改成行内节点了）。
 *
 * 以前图片自己就是一个块，前后是块边界，光标停不到图片旁边；
 * 现在图片是段落里的一个行内节点，所以老笔记里的 `{type:'image'}` 都要包一层
 * `{type:'paragraph', content:[图片]}` 才对得上 schema（不包会被 setContent 拒绝）。
 * 这一步是纯搬家：顺序、图片属性都不动。
 *
 * 纯函数、只吃 JSON，方便在 node 里跑回归。
 */

type Json = Record<string, any>

const isParagraph = (n: Json | undefined) => n?.type === 'paragraph'
const isEmptyParagraph = (n: Json | undefined) => isParagraph(n) && !(n?.content?.length)
const isImage = (n: Json | undefined) => n?.type === 'image'

function copy(n: Json): Json {
  const out: Json = { ...n }
  if (Array.isArray(n.content)) out.content = n.content.map(copy)
  if (n.attrs && typeof n.attrs === 'object') out.attrs = { ...n.attrs }
  return out
}

/** 块级图片 → 段落里的一张图（行内）。段落里的图原样保留。 */
function wrapImages(node: Json): Json {
  const out = copy(node)
  if (!Array.isArray(out.content)) return out
  out.content = out.content.map((child: Json) =>
    isImage(child) ? { type: 'paragraph', content: [child] } : wrapImages(child),
  )
  return out
}

export function normalizeDoc<T extends Json>(doc: T): T {
  const source = wrapImages(doc ?? {})
  const content = Array.isArray(source?.content) ? (source.content as Json[]) : []
  if (content.length === 0) return source as T

  // 空的捕获块（没有内容）留着只会让光标卡在看不见的地方
  const items = content.filter(
    (n) => !(n?.type === 'captureBlock' && !(n?.content?.length)),
  )

  const out: Json[] = []
  let i = 0
  while (i < items.length) {
    const node = items[i]
    if (!isParagraph(node)) {
      out.push(copy(node))
      i++
      continue
    }

    // 一串连续的顶层段落
    let j = i
    let run: Json[] = []
    while (j < items.length && isParagraph(items[j])) {
      run.push(items[j])
      j++
    }

    const prev =
      out.length > 0 && out[out.length - 1]?.type === 'captureBlock' ? out[out.length - 1] : null
    const next = j < items.length && items[j]?.type === 'captureBlock' ? items[j] : null
    // 文档开头的占位空行：后面还有块，就是新建笔记时留下的，丢掉
    if (!prev && next && out.length === 0) run = run.filter((n) => !isEmptyParagraph(n))

    if (run.length === 0) {
      i = j
      continue
    }
    if (prev) {
      prev.content = [...(prev.content ?? []), ...run.map(copy)]
      i = j
      continue
    }
    if (next) {
      const block = copy(next)
      block.content = [...run.map(copy), ...(block.content ?? [])]
      out.push(block)
      i = j + 1
      continue
    }
    // 整篇都没有捕获块（还在空白笔记阶段）：原样留着
    out.push(...run.map(copy))
    i = j
  }

  return { ...source, content: out } as unknown as T
}