import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import { contentWidthOf } from './imageActions'

/** 再小就没法看了，也不利于抓住手柄。 */
const MIN_W = 48

type HandleDir = 'e' | 'se'
const HANDLES: HandleDir[] = ['e', 'se']

/**
 * 选中图片后浮出一个虚线框 + 右下角手柄，拖着改显示宽度。
 *
 * 为什么不直接用 width/height 双属性：只写 width、CSS 里 height:auto，
 * 比例由浏览器保证，永远不会被拉扁 —— 这也是"从图片库复制过来的图比例不对"
 * 那类问题的根因（同时给了宽高、又和 max-width 打架）。
 */
class ImageResizeController {
  private view: EditorView
  private box: HTMLDivElement
  private label: HTMLSpanElement
  private img: HTMLImageElement | null = null
  private pos = -1
  private startX = 0
  private startW = 0
  private width = 0
  private dir: HandleDir = 'se'
  private resizing = false
  private ro: ResizeObserver | null = null
  private off: Array<() => void> = []

  constructor(view: EditorView) {
    this.view = view

    const box = document.createElement('div')
    box.className = 'c2g-resize-box'
    box.style.display = 'none'
    for (const dir of HANDLES) {
      const h = document.createElement('div')
      h.className = `c2g-rh c2g-rh-${dir}`
      h.dataset.dir = dir
      h.addEventListener('pointerdown', (e) => this.onDown(e, dir))
      box.appendChild(h)
    }
    const label = document.createElement('span')
    label.className = 'c2g-rw'
    box.appendChild(label)
    document.body.appendChild(box)

    this.box = box
    this.label = label

    const onScroll = () => this.sync()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    this.off.push(() => window.removeEventListener('scroll', onScroll, true))
    this.off.push(() => window.removeEventListener('resize', onScroll))
  }

  update(_view: EditorView) {
    this.sync()
  }

  destroy() {
    this.stopResize()
    this.ro?.disconnect()
    this.ro = null
    this.off.forEach((f) => f())
    this.off = []
    this.box.remove()
  }

  // ── 外框定位 ────────────────────────────────────────

  private sync = () => {
    if (this.resizing) return
    const sel = this.view.state.selection
    if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return this.hide()
    if (document.body.classList.contains('c2g-img-dragging')) return this.hide()

    const node = this.view.nodeDOM(sel.from) as HTMLElement | null
    const img = node instanceof HTMLImageElement ? node : null
    if (!img || !img.isConnected) return this.hide()

    const r = img.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return this.hide()

    if (this.img !== img) {
      this.ro?.disconnect()
      this.ro = new ResizeObserver(() => this.sync())
      this.ro.observe(img)
    }
    this.img = img
    this.pos = sel.from

    const box = this.box
    box.style.display = 'block'
    box.style.left = `${Math.round(r.left)}px`
    box.style.top = `${Math.round(r.top)}px`
    box.style.width = `${Math.round(r.width)}px`
    box.style.height = `${Math.round(r.height)}px`
  }

  private hide() {
    this.box.style.display = 'none'
    this.img = null
    this.pos = -1
    this.ro?.disconnect()
    this.ro = null
  }

  // ── 拖动改宽度 ──────────────────────────────────────

  private onDown = (e: PointerEvent, dir: HandleDir) => {
    const img = this.img
    if (!img) return
    e.preventDefault()
    e.stopPropagation()

    this.dir = dir
    this.resizing = true
    this.startX = e.clientX
    this.startW = img.getBoundingClientRect().width
    this.width = this.startW
    document.body.classList.add('c2g-img-resizing')
    this.box.classList.add('c2g-resize-active')
    this.setLabel(this.startW)

    window.addEventListener('pointermove', this.onMove, true)
    window.addEventListener('pointerup', this.onUp, true)
    window.addEventListener('pointercancel', this.onUp, true)
    window.addEventListener('keydown', this.onKey, true)
  }

  private onMove = (e: PointerEvent) => {
    const img = this.img
    if (!this.resizing || !img) return
    e.preventDefault()
    const dx = e.clientX - this.startX
    // 右侧手柄往右拉变宽；往左拉变窄（左右都是贴着右边缘改）
    const w = Math.min(Math.max(Math.round(this.startW + dx), MIN_W), this.maxWidth())
    this.width = w
    img.style.width = `${w}px`
    img.style.height = 'auto'
    this.setLabel(w)
    this.place()
  }

  private onUp = () => {
    if (!this.resizing) return
    const img = this.img
    const width = this.width
    this.stopResize()
    if (!img) return
    img.style.width = ''
    img.style.height = ''
    this.commit(width)
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    const img = this.img
    this.stopResize()
    if (img) {
      img.style.width = ''
      img.style.height = ''
    }
    this.sync()
  }

  private stopResize() {
    if (!this.resizing) return
    this.resizing = false
    this.box.classList.remove('c2g-resize-active')
    document.body.classList.remove('c2g-img-resizing')
    window.removeEventListener('pointermove', this.onMove, true)
    window.removeEventListener('pointerup', this.onUp, true)
    window.removeEventListener('pointercancel', this.onUp, true)
    window.removeEventListener('keydown', this.onKey, true)
  }

  private commit(width: number) {
    const pos = this.pos
    if (pos < 0) return
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'image') return
    if (Math.round(Number(node.attrs.width) || 0) === Math.round(width)) return
    const tr = this.view.state.tr
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: Math.round(width) })
    tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(tr)
    this.sync()
  }

  /** 拖动中图片会被 max-width 卡住，外框跟着图片实际尺寸走。 */
  private place() {
    const img = this.img
    if (!img) return
    const r = img.getBoundingClientRect()
    this.box.style.left = `${Math.round(r.left)}px`
    this.box.style.top = `${Math.round(r.top)}px`
    this.box.style.width = `${Math.round(r.width)}px`
    this.box.style.height = `${Math.round(r.height)}px`
  }

  private setLabel(w: number) {
    this.label.textContent = `${Math.round(w)} px`
  }

  private maxWidth(): number {
    return contentWidthOf(this.view.dom as HTMLElement)
  }
}

/** 图片缩放手柄：选中即出现，拖右边改宽度，Esc 取消。 */
export const ImageResize = Extension.create({
  name: 'imageResize',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => new ImageResizeController(view),
      }),
    ]
  },
})