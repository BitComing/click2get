import { convertFileSrc } from '@tauri-apps/api/core'
import { Extension, mergeAttributes, Node } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'

import { trailingLineTr } from './lineOps'

let dataDir = ''

/** 启动时由 App 注入一次，供图片节点拼绝对路径。 */
export function setDataDir(dir: string) {
  dataDir = dir || ''
}

/** 相对路径 images/ab/cd/x.png → WebView 可加载的 asset:// 地址。 */
export function fileUrl(rel?: string | null): string {
  if (!rel) return ''
  const abs = `${dataDir.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`
  try {
    return convertFileSrc(abs)
  } catch {
    return abs
  }
}

/**
 * 一次捕获 = 一个块。
 * 语义标记 div[data-capture] 是唯一的前向兼容投资：
 * 将来要升级成可折叠卡片 / 按块删除 / 导出块流时，不用再猜哪段是捕获的。
 *
 * 编辑手感相关的两点：
 * - content 用 `block*` 而不是 `block+`：块可以被删空，删空后由下面的插件把它摘掉，
 *   免得留下一段看不见、也删不掉的空白；
 * - 不再 `defining`：光标在块首按 Backspace 能直接和上一块合并（以前会被挡在边界上，
 *   按半天没反应，是"编辑很不自然"的主要来源）。
 */
export const CaptureBlock = Node.create({
  name: 'captureBlock',
  group: 'block',
  content: 'block*',
  defining: false,

  addAttributes() {
    return {
      ts: { default: null },
      notice: { default: false },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-capture]' }]
  },

  renderHTML() {
    // ts / notice 只留在文档 JSON 里，不下发到 DOM（保持 DOM 干净）
    return ['div', { 'data-capture': '' }, 0]
  },

  addProseMirrorPlugins() {
    // 删空的捕获块不该留在文档里：它没有高度，却会让光标"卡"在一块看不见的地方，
    // 后续 Backspace / 方向键的行为也会变得莫名其妙。
    return [
      new Plugin({
        appendTransaction: (trs, _old, newState) => {
          if (!trs.some((tr) => tr.docChanged)) return null
          const doc = newState.doc
          const empty: Array<{ pos: number; size: number }> = []
          doc.descendants((node: PMNode, pos: number) => {
            if (node.type.name === 'captureBlock' && node.childCount === 0) {
              empty.push({ pos, size: node.nodeSize })
            }
          })
          if (empty.length === 0) return null

          const tr = newState.tr
          for (let i = empty.length - 1; i >= 0; i--) {
            const e = empty[i]
            // 整篇只剩这一个空块：换成空段落，doc 的 content 是 block+
            if (doc.childCount === 1 && e.pos === 0) {
              tr.replaceWith(0, e.size, newState.schema.nodes.paragraph.create())
            } else {
              tr.delete(e.pos, e.pos + e.size)
            }
          }
          return tr
        },
      }),
    ]
  },
})

/**
 * 末尾补一行 —— 只在"最后一块以图片收尾"时补，而且补在块**里面**（实现见 lineOps.trailingLineTr）。
 *
 * StarterKit 自带的 trailingNode 做的事是"文档末尾永远挂一个空段落"：
 * 只要最后一个是捕获块，它就把那个空段落再插回来。于是用户在末尾那行空行上退格，
 * 删掉的那个空行下一次事务就又被补回来 —— 正是"删一行、多一行"的手感。
 *
 * 这里换成更窄的规则：
 * - 最后一行本来就是文字行：什么都不补（在末尾那行退格，就真的少一行）；
 * - 最后一块以图结尾：在块里补一行，光标有地方落（点图片下面还能接着写）；
 * - 最后一个是块外的图：在文档末尾补一行。
 */
export const TrailingLine = Extension.create({
  name: 'trailingLine',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (trs, _old, newState) => {
          if (!trs.some((tr) => tr.docChanged)) return null
          return trailingLineTr(newState) ?? null
        },
      }),
    ]
  },
})

/**
 * 图片节点：文档里只存相对路径，src 在渲染时现算，换机器也能打开。
 *
 * **行内（inline）而不是块级**：图片挂在段落里，所以它的前后各有一个真正的光标位置 ——
 * 用鼠标点在图片这一行的空白处（图片右边 / 左边）时，光标就停在那儿，
 * 可以直接在图片前后接着写字。块级图片做不到这一点：它的前后是"块边界"，
 * 光标无处落脚，点上去只会整张选中。
 *
 * 尺寸相关的三件事：
 * - w / h：原图像素尺寸，只进 JSON，用来算比例、给出"原始大小"；
 * - width：用户拖出来的显示宽度（px）。只下发 width，不下发 height，
 *   配合 CSS 的 height:auto + max-width:100%，比例永远不会被拉变形；
 * - height 显式丢弃，免得哪天后端数据里带了个 height 把比例压扁。
 *
 * 备注不在这里：一张图的备注属于图片本身（存在 images/ 旁边），由图片库管理，
 * 编辑页默认不展示 —— 笔记正文保持干净，只有图和字。
 */
export const CaptureImage = Image.extend({
  // 原生 HTML5 拖拽在这里不好用（落点只能按块、还容易和选字打架），
  // 关掉它，改用 imageDrag 里的"长按再拖"。
  draggable: false,

  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null },
      hash: { default: null },
      w: { default: null, rendered: false },
      h: { default: null, rendered: false },
    }
  },

  renderHTML({ HTMLAttributes }) {
    const { path, hash, w, h, height, width, ...rest } = HTMLAttributes as Record<
      string,
      unknown
    >
    void w
    void h
    void height
    const attrs: Record<string, unknown> = {
      ...rest,
      src: fileUrl(path as string),
      'data-hash': hash ?? '',
      loading: 'lazy',
      draggable: 'false',
    }
    // 有显式宽度就写 width 属性；没有就交给 CSS 的"默认宽度"兜住
    if (width) attrs.width = Math.max(1, Math.round(Number(width)))
    return ['img', mergeAttributes(attrs)]
  },
})
  // 行内：图片是段落里的一个"字符"，前后都有光标位置（见上面的注释）
  .configure({ inline: true })