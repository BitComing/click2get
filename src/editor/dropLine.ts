/**
 * 落点线画在哪条缝里 —— **只看缝上下那两行在屏幕上的位置**，不看插入位置本身落在哪个块里。
 *
 * 麻烦在这里：一条视觉上的缝（两行之间那 14px）在文档结构里对应**好几个**插入位置 ——
 * 上一段文字的末尾、上一块的末尾、下一块的开头、下一段文字的开头。指针在缝里挪一两像素，
 * `posAtCoords` 就在它们之间来回报。
 *
 * 以前的算法是"从插入位置朝两边量坐标"（`coordsAtPos(pos, ±1)`），可这些位置
 * 落在段落里的时候，量到的只是**那一行文字自己的框**（ProseMirror 在文字块内部
 * 拿不到"块的边界"，只能返回光标所在那一行的矩形）。于是同一条缝里出现了三个 y：
 * 上一行的底边、缝的正中、下一行的顶边 —— 线跟着指针上下跳，看上去像三个插入位置。
 *
 * 现在的算法不量插入位置，量**行**：先把插入位置换算成"缝上面是哪一行、下面哪一行"
 * （gapAround，顺着文档结构往两边找最近的兄弟块），再取上一行底和下一行顶的中点。
 * 同一条缝里所有插入位置都指向同一对行 → 只有一个 y。
 *
 * 纯函数，`docs/test-drop-line.ts` 覆盖。
 */

import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'

/** 屏幕坐标里的一行（上下边 + 左右边，`getBoundingClientRect()` 天然满足）。 */
export type RowBox = { top: number; bottom: number; left: number; right: number }

/** 落点线该画在哪：y 是线的中点，left / width 是横向范围和宽度。 */
export type DropLine = { y: number; left: number; width: number }

/** 文档里某个块位置在屏幕上的框；量不到（空容器 / 结构特殊）返回 null。 */
export type RectOf = (pos: number) => RowBox | null

/** 插入位置上下那两行。文档头尾只有一边有行，另一边是 null。 */
export type Gap = { above: RowBox | null; below: RowBox | null }

export function dropLineAt(above: RowBox | null, below: RowBox | null, row: RowBox): DropLine {
  const y =
    above && below
      ? (above.bottom + below.top) / 2
      : above
        ? above.bottom
        : below
          ? below.top
          : row.top
  return { y, left: row.left, width: row.right - row.left }
}

/**
 * 插入位置（某一行之前 / 之后）上下那两行。
 *
 * `rowPos` 是指针悬浮着的那一行的块位置，`after` 为真表示插在它后面：
 * 那么上一行就是它自己，下一行是它后面的兄弟；插在前面则反过来。
 *
 * 另一侧的行顺着结构往外找：这一行在自己容器里没有兄弟，就往上爬一层再看，
 * 直到找到同一方向上最近的一个兄弟块（下一段文字、下一个捕获块……）。
 * 一条缝里的所有插入位置都落在同一对行之间，所以它们也得到同一个 y。
 */
export function gapAround(doc: PMNode, rowPos: number, after: boolean, rectOf: RectOf): Gap {
  const hover = rectOf(rowPos)
  return after
    ? { above: hover, below: siblingRow(doc, rowPos, 1, rectOf) }
    : { above: siblingRow(doc, rowPos, -1, rectOf), below: hover }
}

/**
 * `rowPos` 那一行在 `dir` 方向上最近的兄弟行（隔着一层容器也能找到）。
 *
 * 没有高度的兄弟（空容器）跳过：那不是一条看得见的行，不该拿来算缝的中点。
 */
function siblingRow(doc: PMNode, rowPos: number, dir: -1 | 1, rectOf: RectOf): RowBox | null {
  let $pos: ResolvedPos
  try {
    $pos = doc.resolve(rowPos)
  } catch {
    return null
  }
  for (let d = $pos.depth; d >= 0; d--) {
    const parent = $pos.node(d)
    for (let i = $pos.index(d) + dir; i >= 0 && i < parent.childCount; i += dir) {
      const box = rectOf($pos.posAtIndex(i, d))
      if (box && box.bottom > box.top) return box
    }
  }
  return null
}