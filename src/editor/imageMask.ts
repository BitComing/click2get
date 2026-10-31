import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * 选中的图片盖一层**浅蓝色半透明遮罩** —— 和文字被选中时的 `::selection` 一个观感。
 *
 * 为什么不能只加个 class：图片是 `<img>`，替换元素里画不出半透明底色，
 * `::after` 也没有落脚的地方（装饰只会把 class 打在 img 自己身上）。
 * 所以这里和缩放手柄一样，用一层 fixed 的浮层压在图片盒子上 ——
 * 纯装饰：不进文档、不参与保存，滚动 / 改宽度 / 换主题时重算位置。
 *
 * 覆盖两种"选中"：
 * - 单击选中一张图（NodeSelection）；
 * - 鼠标拖出来的选区里夹着图（"文字 + 图片"一起选）。
 */

const MASK_CLASS = 'c2g-img-mask'

class ImageMaskController {
  private view: EditorView
  private layer: HTMLDivElement
  private pool: HTMLDivElement[] = []
  private raf = 0
  private off: Array<() => void> = []

  constructor(view: EditorView) {
    this.view = view
    const layer = document.createElement('div')
    layer.className = 'c2g-img-mask-layer'
    document.body.appendChild(layer)
    this.layer = layer

    // 滚动（含正文那个滚动容器）、窗口缩放：位置都得跟着走
    const schedule = () => this.schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    this.off.push(() => window.removeEventListener('scroll', schedule, true))
    this.off.push(() => window.removeEventListener('resize', schedule))
  }

  update() {
    // 等这一帧的 DOM 更新落地再量盒子，否则拿到的是搬动前的位置
    this.schedule()
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.off.forEach((f) => f())
    this.layer.remove()
  }

  private schedule() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.sync()
    })
  }

  /** 当前该盖遮罩的图片：拿到它们的视口矩形。 */
  private targets(): DOMRect[] {
    const { selection, doc } = this.view.state
    const out: DOMRect[] = []
    const add = (pos: number) => {
      const el = this.view.nodeDOM(pos) as HTMLElement | null
      const r = el?.getBoundingClientRect?.()
      if (r && r.width > 2 && r.height > 2) out.push(r)
    }

    if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
      add(selection.from)
      return out
    }
    if (selection.empty) return out
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name === 'image') add(pos)
    })
    return out
  }

  private sync() {
    const rects = this.targets()
    rects.forEach((r, i) => {
      let el = this.pool[i]
      if (!el) {
        el = document.createElement('div')
        el.className = MASK_CLASS
        this.layer.appendChild(el)
        this.pool.push(el)
      }
      el.style.display = 'block'
      el.style.left = `${Math.round(r.left)}px`
      el.style.top = `${Math.round(r.top)}px`
      el.style.width = `${Math.round(r.width)}px`
      el.style.height = `${Math.round(r.height)}px`
    })
    for (let i = rects.length; i < this.pool.length; i++) this.pool[i].style.display = 'none'
  }
}

/** 选中图片时的浅蓝色遮罩（纯装饰，见文件头注释）。 */
export const ImageSelectMask = Extension.create({
  name: 'imageSelectMask',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => new ImageMaskController(view),
      }),
    ]
  },
})