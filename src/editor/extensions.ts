import { convertFileSrc } from '@tauri-apps/api/core'
import { mergeAttributes, Node } from '@tiptap/core'
import Image from '@tiptap/extension-image'

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
 */
export const CaptureBlock = Node.create({
  name: 'captureBlock',
  group: 'block',
  content: 'block+',
  defining: true,

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
})

/** 图片节点：文档里只存相对路径，src 在渲染时现算，换机器也能打开。 */
export const CaptureImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null },
      hash: { default: null },
    }
  },

  renderHTML({ HTMLAttributes }) {
    const { path, hash, ...rest } = HTMLAttributes as Record<string, unknown>
    return [
      'img',
      mergeAttributes(rest, {
        src: fileUrl(path as string),
        'data-hash': hash ?? '',
        loading: 'lazy',
        draggable: 'true',
      }),
    ]
  },
})