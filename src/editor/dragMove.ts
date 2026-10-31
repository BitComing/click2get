import { Extension } from '@tiptap/core'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'

import { moveImageTransaction, canMoveImage } from './moveImage'
import { dropLineAt, gapAround, type RowBox } from './dropLine'
import {
  canMoveRange,
  expandToRows,
  moveRangeTransaction,
  rangeBlocks,
  spanAtRow,
} from './moveRange'

/** 按住多久算"长按"（毫秒）。太短会和普通点选打架，太长会让人觉得没反应。 */
const HOLD_MS = 260
/** 长按期间手指/鼠标挪动超过这个距离，就当用户想拖选文字，放弃长按。 */
const MOVE_TOL = 8
/** 拖到滚动区上下边缘这么多像素内开始自动滚。 */
const EDGE = 72
/** 拖多行时 ghost 里最多预览几行。 */
const GHOST_LINES = 6
const GHOST_CHARS = 90
/** 落点线离"原位置"灰线这么近，就算同一条缝：灰线让位，一条缝只留一个提示。 */
const SAME_GAP = 10

type DropTarget = {
  /** 插入位置（块边界） */
  pos: number
  /** 指示线在视口里的 y */
  y: number
  left: number
  width: number
}

/** 被拖起来的东西：一张图，或者选中的**几行**文字。 */
type ImageSource = {
  kind: 'image'
  el: HTMLImageElement
  pos: number
}

type TextSource = {
  kind: 'text'
  /** 要搬的那几行（整行对齐，见 moveRange.expandToRows） */
  from: number
  to: number
  rows: number
  text: string
  /** 没有文字的块（比如 md 的 `---`）：纸条上写这个，别显示"（空行）" */
  label?: string
  /**
   * "被动"来源：按下时**没有选中任何东西**，只是按住了一行。
   *
   * 这种不能像选区那样在 pointerdown 里 preventDefault（那样会把点击定位光标、
   * 双击选词、直接拖选文字全废掉），所以先照常让浏览器走，等真的长按到点才接管。
   */
  passive?: boolean
}

type Source = ImageSource | TextSource

/**
 * 被拖起来的那一坨内容 —— 和"搬到哪"无关的部分。
 *
 * 拖到正文里是换位置，拖到别的笔记 / 新建笔记 / 垃圾图标 / 收纳箱是另一种处理，
 * 但它们都需要同一份信息：图是什么，或者哪几行、块级 JSON 长什么样。
 */
export type DragContent =
  | {
      kind: 'image'
      /** 图片在文档里的位置（外面据此把它从当前笔记里删掉） */
      srcPos: number
      hash: string
      path: string
      w: number
      h: number
    }
  | {
      kind: 'text'
      /** 这几行在当前笔记里的范围（写进目标笔记之后再删） */
      from: number
      to: number
      /** 这几行的块级 JSON，原样追加到目标笔记末尾 */
      blocks: any[]
    }

/** 拖到侧栏某篇笔记上松手时，要交给外面处理的信息。 */
export type DropOnNote = DragContent & { noteId: string }

export type MoveDragOptions = {
  /** 松手落在侧栏的某篇笔记上：把内容挪过去 */
  onDropOnNote?: (info: DropOnNote) => void
  /** 松手落在侧栏的「新建笔记」上：把内容搬进一篇新笔记 */
  onDropOnNewNote?: (info: DragContent) => void
  /** 松手落在垃圾图标上：把这部分内容删掉 */
  onDropOnTrash?: (info: DragContent) => void
  /**
   * 松手落在**收纳箱**上：先收着（正文里那份删掉，交给外面存进箱子）。
   * 收纳箱是常驻的（见 CollectBox.tsx），这里只按 `[data-collect-box]` 找它。
   */
  onDropOnTray?: (info: DragContent) => void
  /** 这篇笔记就是内容现在所在的笔记：不算落点，别高亮它 */
  isSourceNote?: (noteId: string) => boolean
}

/* ── "原文淡下去"的装饰 ────────────────────────────────
 * 拖动时原文还在文档里（松手才真搬），用一个 inline decoration 把它压淡，
 * 视觉上等于"抬起来了"。装饰不改文档，不会被自动保存记进去。
 */
type LiftRange = { from: number; to: number } | null
const liftKey = new PluginKey<LiftRange>('c2gLift')

function liftPlugin() {
  return new Plugin<LiftRange>({
    key: liftKey,
    state: {
      init: () => null,
      apply: (tr, value) => {
        const meta = tr.getMeta(liftKey)
        if (meta !== undefined) return meta as LiftRange
        return tr.docChanged ? null : value
      },
    },
    props: {
      decorations(state) {
        const range = liftKey.getState(state)
        if (!range) return null
        if (range.from < 0 || range.to > state.doc.content.size) return null
        try {
          return DecorationSet.create(state.doc, [
            Decoration.inline(range.from, range.to, { class: 'c2g-lift' }),
          ])
        } catch {
          return null
        }
      },
    },
  })
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

/**
 * 长按拖动：图片、或者选中的多行文字，都能被"抬起来"拖走。
 *
 * - 落点在正文里：换位置（图片走 moveImage.ts，文字走 moveRange.ts）；
 * - 落在侧栏的某篇笔记上：交给外面把内容搬到那篇笔记（onDropOnNote）；
 * - 落在垃圾图标上：删掉（onDropOnTrash）；
 * - 落在收纳箱上：先收着，等会儿再放到别处（onDropOnTray）。
 *
 * 选中的文字要先被"按住"：按下 260ms 不动才抬起来。这期间如果指针挪开了，
 * 说明用户是在拖选文字 —— 我们接管了 mousedown，所以这里自己把选区延出来。
 */
class MoveDragController {
  private view: EditorView
  private options: MoveDragOptions
  private scrollEl: HTMLElement | null
  private timer: number | null = null
  private raf = 0
  private downX = 0
  private downY = 0
  private downPos = -1
  private x = 0
  private y = 0
  private pointerId = -1
  private source: Source | null = null
  private active = false
  /** 按住后没等到长按就拖开了：手动把选区延出来 */
  private extending = false
  private ghost: HTMLElement | null = null
  private grabX = 0
  private grabY = 0
  private line: HTMLElement | null = null
  private target: DropTarget | null = null
  /** 指针下面那篇笔记（侧栏列表项） */
  private noteEl: HTMLElement | null = null
  private noteId: string | null = null
  /** 拖动时浮出来的垃圾图标（松手 = 删掉这一坨内容） */
  private trashEl: HTMLElement | null = null
  /** 常驻的收纳箱图标（松手 = 先收着，等会儿再放到别处） */
  private collectEl: HTMLElement | null = null
  private overTray = false
  /** "原位置"的横线：拖动期间一直停在内容被抬起来的地方 */
  private originEl: HTMLElement | null = null
  /** 指针下面那个「新建笔记」按钮（松手 = 搬进新笔记） */
  private newNoteEl: HTMLElement | null = null
  private overTrash = false
  private overNewNote = false
  private dirty = false
  private swallowClick = false
  private off: Array<() => void> = []

  constructor(view: EditorView, options: MoveDragOptions) {
    this.view = view
    this.options = options
    this.scrollEl = (view.dom.closest('.scroll') as HTMLElement | null) ?? view.dom.parentElement
    this.bind()
  }

  private bind() {
    const add = (
      el: EventTarget,
      type: string,
      fn: EventListener,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn, opts)
      this.off.push(() => el.removeEventListener(type, fn, opts))
    }

    // 捕获阶段先看 pointerdown，拿到图片元素 / 选区
    add(this.view.dom, 'pointerdown', this.onPointerDown as EventListener, true)
    // 图片和"按在选区里"都不要走 PM 的 mousedown：
    // 它会把图片选成 NodeSelection、把选区收成光标，跟拖拽打架
    add(this.view.dom, 'mousedown', this.onMouseDown as EventListener, true)
    add(window, 'pointermove', this.onPointerMove as EventListener, true)
    // 长按已经开始：别让浏览器 / ProseMirror 还按着这次按下继续拉选区
    add(window, 'mousemove', this.onMouseMoveCapture as EventListener, true)
    add(window, 'pointerup', this.onPointerUp as EventListener, true)
    add(window, 'pointercancel', this.onPointerCancel as EventListener, true)
    add(window, 'keydown', this.onKeyDown as EventListener, true)
    add(window, 'blur', this.onCancel as EventListener)
    // 窗口 / 侧栏宽度一变，贴在编辑面板右侧的垃圾图标要重新贴一次
    add(window, 'resize', this.onResize as EventListener)
    // 长按在触摸屏上会触发系统菜单，按住时挡掉
    add(this.view.dom, 'contextmenu', this.onContextMenu as EventListener, true)
    // 拖动结束后浏览器还会补一个 click，别让它把图片选上 / 把光标挪走
    add(this.view.dom, 'click', this.onClick as EventListener, true)
    // 兜底：拖选中的文字时，别让浏览器自己发起原生拖拽
    add(this.view.dom, 'dragstart', this.onDragStart as EventListener, true)
  }

  destroy() {
    this.cancelDrag()
    this.clearTimer()
    this.off.forEach((f) => f())
    this.off = []
  }

  // ── 指针 ──────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent) => {
    this.swallowClick = false
    this.extending = false
    // 上一轮没收尾的（在窗口外面松的手）：先清干净再开始
    this.resetSource()
    if (e.button !== 0 || !e.isPrimary) return

    const target = e.target as Element | null
    const img = target?.closest?.('img') as HTMLImageElement | null
    const hit = this.view.posAtCoords({ left: e.clientX, top: e.clientY })
    const sel = this.view.state.selection

    if (img && this.view.dom.contains(img)) {
      // 图上按下去时，如果当前选区已经把这张图圈进去了，说明用户选的是"图 + 字"：
      // 整段一起搬（否则只会抬起这一张图，选区里的字留在原地）
      const range = sel instanceof TextSelection && !sel.empty ? sel : null
      if (range && hit && hit.pos >= range.from && hit.pos <= range.to) {
        const mixed = this.rangeSource(range.from, range.to)
        if (mixed && mixed.text.trim()) {
          e.preventDefault()
          e.stopPropagation()
          this.source = mixed
          this.begin(e, hit.pos)
          return
        }
      }
      let pos = -1
      try {
        pos = this.view.posAtDOM(img, 0)
      } catch {
        return
      }
      const node = this.view.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'image') return
      this.source = { kind: 'image', el: img, pos }
      this.begin(e, pos)
      return
    }

    // md 的 `---`：它是叶子块（horizontalRule），既不是图片也不是文字块，
    // 单独认一下 —— 按住它不动，也能像别的行一样拖走 / 拖进垃圾图标。
    const block = this.blockSourceAt(target)
    if (block) {
      this.source = block
      this.begin(e, hit?.pos ?? block.from)
      return
    }

    const src = this.textSourceAt(e.clientX, e.clientY)
    if (src) {
      // 按在选中的文字上：先别让 PM 把选区收掉，长按到点才真抬起来
      e.preventDefault()
      e.stopPropagation()
      this.source = src
      this.begin(e, hit?.pos ?? -1)
      return
    }

    // 什么都没选中：按住这一行不动也能把整行拖走。
    // 这里**不** preventDefault —— 点击定位光标、双击选词、直接拖选文字都还要照常可用；
    // 指针在长按到点之前挪开了就放弃（见 onPointerMove）。
    const row = this.rowSourceAt(e.clientX, e.clientY)
    if (!row) return
    this.source = row
    this.begin(e, hit?.pos ?? row.from)
  }

  private begin(e: PointerEvent, downPos: number) {
    this.pointerId = e.pointerId
    this.downX = e.clientX
    this.downY = e.clientY
    this.downPos = downPos
    this.x = e.clientX
    this.y = e.clientY
    this.clearTimer()
    this.timer = window.setTimeout(this.activate, HOLD_MS)
  }

  /** 一段选区 → 一次"整行拖动"。文字为空（比如只圈了一张图）返回 null。 */
  private rangeSource(from: number, to: number): TextSource | null {
    const span = expandToRows(this.view.state.doc, from, to)
    if (!span) return null
    const text = this.view.state.doc.textBetween(span.from, span.to, '\n')
    return { kind: 'text', from: span.from, to: span.to, rows: span.rows, text }
  }

  /** 按住的那一行（没选中文字时用）：整行当拖动单位。 */
  private rowSourceAt(x: number, y: number): TextSource | null {
    const hit = this.view.posAtCoords({ left: x, top: y })
    if (!hit) return null
    const span = spanAtRow(this.view.state.doc, hit.pos)
    if (!span) return null
    const text = this.view.state.doc.textBetween(span.from, span.to, '\n')
    // 空行没什么可拖的，别把它变成一个"拖起来什么都没有"的手势
    if (!text.trim()) return null
    return { kind: 'text', from: span.from, to: span.to, rows: span.rows, text, passive: true }
  }

  /**
   * 按住一个**叶子块**（md 的 `---` = horizontalRule）。
   *
   * 它既不是图片（没有 <img>）也不是文字块（spanAtRow 认不出来），
   * 但用户眼里它就是自己画的一行，理应能像别的行一样拖动 / 拖进垃圾图标。
   * 用 `nodeDOM(pos) === el` 反查位置：叶子节点没有内容坐标，
   * posAtDOM 在它上面不可靠。
   */
  private blockSourceAt(target: Element | null): TextSource | null {
    const el = target?.closest?.('hr') as HTMLElement | null
    if (!el || !this.view.dom.contains(el)) return null
    let pos = -1
    this.view.state.doc.descendants((node, p) => {
      if (pos >= 0) return false
      if (node.type.name === 'horizontalRule' && this.view.nodeDOM(p) === el) pos = p
      return true
    })
    if (pos < 0) return null
    const node = this.view.state.doc.nodeAt(pos)
    if (!node) return null
    return {
      kind: 'text',
      from: pos,
      to: pos + node.nodeSize,
      rows: 1,
      text: '',
      label: '分割线',
      passive: true,
    }
  }

  /**
   * 指针下面是不是"选中的文字"。
   *
   * 拖动单位是**行**：选区落在一行里面的几个字上也算 —— 拖起来的是那一整行
   * （以前要求"至少选中两行"才让拖，于是行内选中的字完全拖不动）。
   * 选区里混着图片 / 多行时，也是整段（含图）一起搬。
   */
  private textSourceAt(x: number, y: number): TextSource | null {
    const sel = this.view.state.selection
    if (!(sel instanceof TextSelection) || sel.empty) return null
    const hit = this.view.posAtCoords({ left: x, top: y })
    if (!hit) return null
    // 必须按在选区"里面"：压在两端的边界上是要拉长 / 缩短选区
    if (hit.pos <= sel.from || hit.pos >= sel.to) return null

    const src = this.rangeSource(sel.from, sel.to)
    if (!src || !src.text.trim()) return null
    return src
  }

  private onMouseDown = (e: MouseEvent) => {
    if (!this.source && !this.active) return
    // 只是"按住了一行"（还没长按到点）：mousedown 照常交给浏览器
    if (this.source && this.source.kind === 'text' && this.source.passive && !this.active) return
    e.preventDefault()
    e.stopPropagation()
  }

  /** 长按接管之后，挡住浏览器 / PM 的选区延伸（它们还在按上一次 mousedown 走）。 */
  private onMouseMoveCapture = (e: MouseEvent) => {
    if (!this.active) return
    e.preventDefault()
    e.stopPropagation()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.pointerId !== -1 && e.pointerId !== this.pointerId) return

    if (this.extending) {
      this.x = e.clientX
      this.y = e.clientY
      this.selectTo(e.clientX, e.clientY)
      return
    }

    if (!this.active) {
      if (this.timer !== null) {
        const dx = e.clientX - this.downX
        const dy = e.clientY - this.downY
        if (Math.hypot(dx, dy) > MOVE_TOL) {
          this.clearTimer()
          // 按在选区里却直接拖开：用户想拖选文字，把选区延出来（mousedown 被我们挡住了）
          if (this.source?.kind === 'text' && !this.source.passive && this.downPos >= 0) {
            this.extending = true
            this.selectTo(e.clientX, e.clientY)
          }
          this.source = null
        }
      }
      return
    }

    this.x = e.clientX
    this.y = e.clientY
    this.positionGhost()
    this.updateTarget()
  }

  /** 手动拖选：锚点按在哪儿就从哪儿开始，和原生拖选一致。 */
  private selectTo(x: number, y: number) {
    if (this.downPos < 0) return
    const hit = this.view.posAtCoords({ left: x, top: y })
    if (!hit) return
    const { state, dispatch } = this.view
    try {
      const head = clamp(hit.pos, 0, state.doc.content.size)
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, this.downPos, head)))
    } catch {
      /* 位置落在结构边界上时 PM 会拒绝，忽略这一帧 */
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.pointerId !== -1 && e.pointerId !== this.pointerId) return
    if (!this.active) {
      const src = this.source
      const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY)
      const extending = this.extending
      this.clearTimer()
      this.resetSource()
      this.extending = false
      if (!src || extending || this.swallowClick || moved > MOVE_TOL) return
      // 只是"按住一行"、还没到长按：这一下就是普通点击，浏览器已经处理过了
      if (src.kind === 'text' && src.passive) return
      // 没长按、也没拖着选字：就是"点了一下"
      if (src.kind === 'image') this.select(src.pos)
      else this.caretAt(e.clientX, e.clientY)
      return
    }
    this.drop()
  }

  /** 点选一张图（NodeSelection），让缩放手柄知道该围住哪张。 */
  private select(pos: number) {
    const { state, dispatch } = this.view
    if (state.selection instanceof NodeSelection && state.selection.from === pos) return
    const node = state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'image') return
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)))
  }

  /** 点在选区里但没长按：和原生点击一样，光标落到点的位置。 */
  private caretAt(x: number, y: number) {
    const hit = this.view.posAtCoords({ left: x, top: y })
    if (!hit) return
    const { state, dispatch } = this.view
    try {
      dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(hit.pos))))
    } catch {
      /* ignore */
    }
  }

  private onPointerCancel = () => {
    if (this.active) this.cancelDrag()
    else {
      this.clearTimer()
      this.resetSource()
      this.extending = false
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.active) {
      e.preventDefault()
      e.stopPropagation()
      this.cancelDrag()
    }
  }

  private onContextMenu = (e: Event) => {
    if (this.active) e.preventDefault()
  }

  private onClick = (e: MouseEvent) => {
    if (!this.swallowClick) return
    this.swallowClick = false
    e.preventDefault()
    e.stopPropagation()
  }

  private onDragStart = (e: DragEvent) => {
    const target = e.target as Element | null
    if (this.source || this.active || target?.closest?.('img')) e.preventDefault()
  }

  private onCancel = () => {
    this.extending = false
    if (this.active) this.cancelDrag()
    else this.clearTimer()
  }

  private onResize = () => {
    if (!this.active) return
    this.placeTrash()
    this.dirty = true
  }

  // ── 长按 → 拖拽 ──────────────────────────────────────

  private activate = () => {
    this.timer = null
    const src = this.source
    if (!src) return
    if (src.kind === 'image' && !src.el.isConnected) {
      this.resetSource()
      return
    }

    this.active = true
    this.swallowClick = true
    document.body.classList.add('c2g-img-dragging')

    if (src.kind === 'image') {
      const rect = src.el.getBoundingClientRect()
      // 记下"按在图片的哪个点"，拖动时图片就跟手，不会突然跳到指针中心
      this.grabX = clamp(this.x - rect.left, 0, rect.width)
      this.grabY = clamp(this.y - rect.top, 0, rect.height)
      const ghost = document.createElement('img')
      ghost.src = src.el.currentSrc || src.el.src
      ghost.alt = ''
      ghost.className = 'c2g-img-ghost'
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      document.body.appendChild(ghost)
      this.ghost = ghost
      src.el.classList.add('c2g-img-lifted')
      try {
        src.el.setPointerCapture(this.pointerId)
      } catch {
        /* 某些环境下拿不到指针捕获，不影响窗口级监听 */
      }
    } else {
      // 文字：指针落在纸条的左上角附近，别把整段字挡在光标底下
      this.grabX = 18
      this.grabY = 20
      this.ghost = textGhost(src)
      this.setLift({ from: src.from, to: src.to })
      // 被动来源（按住一整行）：按住这段时间里如果把选区拉出来了一点，收成光标，
      // 不然拖动时那一截字还挂着蓝色的选区底色
      if (src.passive) this.collapseToPressed()
      window.getSelection()?.removeAllRanges()
    }

    const line = document.createElement('div')
    line.className = 'c2g-drop-line'
    line.style.display = 'none'
    document.body.appendChild(line)
    this.line = line

    // 两件"内容被抬起来"才出现的东西：
    // 1. 垃圾图标 —— 拖过去松手 = 删除，贴在编辑面板右侧（竖直居中）；
    // 2. 一条灰线停在内容原来待的地方 —— 拖动时原文淡下去，这根线告诉人"它本来在这儿"。
    this.trashEl = createTrashZone()
    this.placeTrash()
    // 收纳箱是常驻元素（由 React 画，见 CollectBox.tsx），这里只拿个引用：
    // 指针压上去时给它加 .hot；它在垃圾图标**上面**，两个不重叠。
    this.collectEl = document.querySelector('[data-collect-box]') as HTMLElement | null
    this.originEl = createOriginLine()
    this.placeOriginLine()

    this.positionGhost()
    this.dirty = true
    this.raf = requestAnimationFrame(this.tick)
  }

  private setLift(range: LiftRange) {
    try {
      this.view.dispatch(this.view.state.tr.setMeta(liftKey, range))
    } catch {
      /* 文档刚变过、位置对不上：装饰失效不影响搬运 */
    }
  }

  /** 把选区收回按下的那个点（长按一行时用）。 */
  private collapseToPressed() {
    const { state, dispatch } = this.view
    if (state.selection.empty) return
    const at = clamp(this.downPos, 0, state.doc.content.size)
    try {
      dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(at))))
    } catch {
      /* 位置落在结构边界上时 PM 会拒绝，留着旧选区也不影响搬运 */
    }
  }

  private positionGhost() {
    const ghost = this.ghost
    if (!ghost) return
    ghost.style.left = `${this.x - this.grabX}px`
    ghost.style.top = `${this.y - this.grabY}px`
  }

  private tick = () => {
    if (!this.active) return
    const el = this.scrollEl
    if (el) {
      const r = el.getBoundingClientRect()
      let dy = 0
      if (this.y < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - this.y) / 3)
      else if (this.y > r.bottom - EDGE) dy = Math.ceil((this.y - (r.bottom - EDGE)) / 3)
      if (dy !== 0) {
        el.scrollTop += dy
        this.dirty = true
      }
    }
    if (this.dirty) {
      this.dirty = false
      this.updateTarget()
    }
    // 自动滚动 / 手动滚轮都会让"原位置"移动，每帧重算一次（一次 rect 读取）
    this.placeOriginLine()
    // 滚动条 / 侧栏宽度变了，右侧的垃圾图标也跟着贴齐
    this.placeTrash()
    this.raf = requestAnimationFrame(this.tick)
  }

  /**
   * 垃圾图标贴在**编辑面板的右侧**、竖直居中：拖到那儿松手就删掉。
   *
   * 它挂在 body 上（固定定位），所以位置得自己算：面板右边进来 14px；
   * 面板窄到放不下时往左挪，宁可压住正文的留白，也不让它跑出窗口。
   */
  private placeTrash() {
    const el = this.trashEl
    if (!el) return
    const panel = this.scrollEl
    const r = panel?.getBoundingClientRect()
    const right = r ? r.right : window.innerWidth
    const top = r ? r.top : 0
    const bottom = r ? r.bottom : window.innerHeight
    const w = el.offsetWidth || 58
    const h = el.offsetHeight || 58
    el.style.left = `${Math.round(right - w - 14)}px`
    el.style.top = `${Math.round(top + (bottom - top - h) / 2)}px`
  }

  private updateTarget() {
    const under = document.elementFromPoint(this.x, this.y) as HTMLElement | null

    // ① 收纳箱：优先级最高（它就贴在删除图标上面）。
    //    拖过来松手 = 先收着 —— 正文里那份删掉，但内容不会没，箱子里留着一份。
    const collectEl = this.collectEl
    if (collectEl && under?.closest?.('[data-collect-box]')) {
      this.overTray = true
      collectEl.classList.add('hot')
      if (this.overTrash) {
        this.overTrash = false
        this.trashEl?.classList.remove('hot')
      }
      this.clearNoteTarget()
      this.clearNewNoteTarget()
      this.target = null
      if (this.line) this.line.style.display = 'none'
      return
    }
    if (this.overTray) {
      this.overTray = false
      collectEl?.classList.remove('hot')
    }

    // ② 垃圾图标：压住别的落点
    if (this.trashEl && under?.closest?.('.c2g-trash-zone')) {
      this.overTrash = true
      this.trashEl.classList.add('hot')
      this.clearNoteTarget()
      this.clearNewNoteTarget()
      this.target = null
      if (this.line) this.line.style.display = 'none'
      return
    }
    if (this.overTrash) {
      this.overTrash = false
      this.trashEl?.classList.remove('hot')
    }

    // ③ 侧栏的「新建笔记」：松手 = 搬进一篇新笔记
    const newBtn = under?.closest?.('[data-new-note]') as HTMLElement | null
    if (newBtn) {
      this.overNewNote = true
      if (this.newNoteEl !== newBtn) {
        this.newNoteEl?.classList.remove('drop-on')
        newBtn.classList.add('drop-on')
        this.newNoteEl = newBtn
      }
      this.clearNoteTarget()
      this.target = null
      if (this.line) this.line.style.display = 'none'
      return
    }
    this.overNewNote = false
    this.clearNewNoteTarget()

    // ④ 侧栏的笔记：拖到列表项上就是"搬到这篇笔记"，不在正文里画落点线
    const note = this.noteAt(this.x, this.y, under)
    if (note) {
      if (this.noteEl !== note.el) {
        this.noteEl?.classList.remove('drop-on')
        note.el.classList.add('drop-on')
        this.noteEl = note.el
      }
      this.noteId = note.id
      this.target = null
      if (this.line) this.line.style.display = 'none'
      return
    }
    this.clearNoteTarget()

    const target = this.targetAt(this.x, this.y)
    this.target = target
    const line = this.line
    if (!line) return
    if (!target) {
      line.style.display = 'none'
      return
    }
    line.style.display = 'block'
    line.style.left = `${target.left}px`
    line.style.width = `${target.width}px`
    line.style.top = `${target.y - 2}px`
  }

  private clearNoteTarget() {
    if (!this.noteEl && !this.noteId) return
    this.noteEl?.classList.remove('drop-on')
    this.noteEl = null
    this.noteId = null
  }

  private clearNewNoteTarget() {
    if (!this.newNoteEl) return
    this.newNoteEl.classList.remove('drop-on')
    this.newNoteEl = null
  }

  /** 指针下面是不是侧栏里的某篇笔记（不是当前这篇）。 */
  private noteAt(
    x: number,
    y: number,
    under?: HTMLElement | null,
  ): { id: string; el: HTMLElement } | null {
    const el = under ?? (document.elementFromPoint(x, y) as HTMLElement | null)
    const item = el?.closest?.('[data-note-id]') as HTMLElement | null
    if (!item) return null
    const id = item.dataset.noteId ?? ''
    if (!id) return null
    if (this.options.isSourceNote?.(id)) return null
    return { id, el: item }
  }

  /**
   * 落点：找指针下面那一"行"（段落/图片这类块），按上半/下半决定插在它前面还是后面。
   * 这样既能落到两段之间，也能落进一段多行文字的内部 —— 就是"任意行"。
   */
  private targetAt(x: number, y: number): DropTarget | null {
    const view = this.view
    const hit = view.posAtCoords({ left: x, top: y })
    if (!hit) return null

    let $pos: ResolvedPos
    try {
      $pos = view.state.doc.resolve(hit.pos)
    } catch {
      return null
    }

    const rowPos = $pos.parent.isTextblock
      ? $pos.before($pos.depth)
      : this.nearestChildPos($pos, y)
    if (rowPos < 0) return null

    const node = view.state.doc.nodeAt(rowPos)
    if (!node) return null
    const el = view.nodeDOM(rowPos) as HTMLElement | null
    const rect = el?.getBoundingClientRect?.()
    if (!rect || rect.height === 0) return null
    const box: RowBox = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }

    const after = y > rect.top + rect.height / 2
    const pos = after ? rowPos + node.nodeSize : rowPos

    // 有些位置"松手也不会有任何变化"：落在被拖走的那几行自己身上
    // （含图片独占的那一行 / 那一个块）。蓝线画在那儿等于骗人 —— 干脆不画。
    if (!this.canDropAt(pos)) return null

    // 线的位置只认"这道缝上下那两行在哪儿"：同一条缝里不管指针报的是哪个插入位置
    // （上一段的末尾 / 上一块的末尾 / 下一块的开头 / 下一段的开头），上下两行都是同一对，
    // 所以只有一个 y。见 editor/dropLine.ts。
    const gap = gapAround(view.state.doc, rowPos, after, (p) => this.rowRectAt(p))
    const line = dropLineAt(gap.above, gap.below, box)
    return { pos, y: line.y, left: line.left, width: line.width }
  }

  /** 某一行（块）在屏幕上的框；量不到返回 null。 */
  private rowRectAt(pos: number): RowBox | null {
    try {
      const el = this.view.nodeDOM(pos) as HTMLElement | null
      return el ? this.boxOf(el) : null
    } catch {
      /* nodeDOM 在结构边界上会抛，当成量不到 */
      return null
    }
  }

  /** DOM 元素的外框；没有高度（空容器）的算量不到。 */
  private boxOf(el: HTMLElement | Element): RowBox | null {
    const r = el.getBoundingClientRect()
    if (!r || r.height === 0) return null
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
  }

  /** 这个落点松手会不会真的动？（判断条件和真正的移动函数一致） */
  private canDropAt(pos: number): boolean {
    const src = this.source
    if (!src) return false
    const doc = this.view.state.doc
    if (src.kind === 'image') {
      const node = doc.nodeAt(src.pos)
      if (!node) return false
      return canMoveImage(doc, src.pos, pos, node)
    }
    return canMoveRange(doc, src.from, src.to, pos)
  }

  /** 指针落在容器空隙里时，挑纵向最近的子块当落点行。 */
  private nearestChildPos($pos: ResolvedPos, y: number): number {
    const parent = $pos.parent
    const idx = $pos.index()
    const candidates: number[] = []
    if (idx > 0) candidates.push($pos.posAtIndex(idx - 1))
    if (idx < parent.childCount) candidates.push($pos.posAtIndex(idx))

    let best = -1
    let bestDist = Number.POSITIVE_INFINITY
    for (const p of candidates) {
      const el = this.view.nodeDOM(p) as HTMLElement | null
      const rect = el?.getBoundingClientRect?.()
      if (!rect) continue
      const dist = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
      if (dist < bestDist) {
        bestDist = dist
        best = p
      }
    }
    return best
  }

  // ── 落下 / 收尾 ──────────────────────────────────────

  private drop() {
    const source = this.source
    if (!source) {
      this.cancelDrag()
      return
    }
    // 落点 / 目标先记下来：cancelDrag 会把 source、noteId 这些都清掉
    const content = this.contentOf(source)
    const target = this.target
    const noteId = this.noteId
    const overTrash = this.overTrash
    const overTray = this.overTray
    const overNewNote = this.overNewNote
    const view = this.view
    const opts = this.options
    this.cancelDrag()
    if (!content) return

    // ⓪ 落在收纳箱上：先收着（正文里那份由外面删，箱子也由外面记）
    if (overTray && opts.onDropOnTray) {
      opts.onDropOnTray(content)
      return
    }

    // ① 落在垃圾图标上：删掉这部分内容（文档怎么删由外面决定，它还要落盘 + 提示）
    if (overTrash && opts.onDropOnTrash) {
      opts.onDropOnTrash(content)
      return
    }

    // ② 落在「新建笔记」上：搬进一篇新笔记
    if (overNewNote && opts.onDropOnNewNote) {
      opts.onDropOnNewNote(content)
      return
    }

    // ③ 落在侧栏的笔记上：交给外面把内容搬过去（这里不动文档）
    if (noteId && opts.onDropOnNote) {
      opts.onDropOnNote({ ...content, noteId })
      return
    }

    // ④ 落在正文里：换位置
    if (!target) return
    if (content.kind === 'image') {
      const node = view.state.doc.nodeAt(content.srcPos)
      if (!node) return
      const tr = moveImageTransaction(view.state, content.srcPos, target.pos, node)
      if (tr) view.dispatch(tr.scrollIntoView())
      return
    }
    const tr = moveRangeTransaction(view.state, content.from, content.to, target.pos)
    if (tr) view.dispatch(tr.scrollIntoView())
  }

  /** 把"被抬起来的东西"转成外面能用的内容描述；文档在这一刻还没变。 */
  private contentOf(source: Source): DragContent | null {
    const state = this.view.state
    if (source.kind === 'image') {
      const node = state.doc.nodeAt(source.pos)
      if (!node || node.type.name !== 'image') return null
      return {
        kind: 'image',
        srcPos: source.pos,
        hash: String(node.attrs.hash ?? ''),
        path: String(node.attrs.path ?? ''),
        w: Number(node.attrs.w) || 0,
        h: Number(node.attrs.h) || 0,
      }
    }
    const blocks = rangeBlocks(state, source.from, source.to)
    if (blocks.length === 0) return null
    return { kind: 'text', from: source.from, to: source.to, blocks }
  }

  private cancelDrag() {
    if (this.timer !== null) this.clearTimer()
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    const wasActive = this.active
    this.active = false
    document.body.classList.remove('c2g-img-dragging')
    this.ghost?.remove()
    this.ghost = null
    this.line?.remove()
    this.line = null
    this.trashEl?.remove()
    this.trashEl = null
    this.originEl?.remove()
    this.originEl = null
    this.overTrash = false
    this.overNewNote = false
    this.overTray = false
    this.collectEl?.classList.remove('hot')
    this.collectEl = null
    if (this.source?.kind === 'image') {
      this.source.el.classList.remove('c2g-img-lifted')
      try {
        this.source.el.releasePointerCapture(this.pointerId)
      } catch {
        /* 指针已经抬起时会抛，忽略 */
      }
    }
    this.resetSource()
    this.target = null
    this.noteEl?.classList.remove('drop-on')
    this.noteEl = null
    this.noteId = null
    this.newNoteEl?.classList.remove('drop-on')
    this.newNoteEl = null
    this.dirty = false
    if (wasActive) this.setLift(null)
  }

  /** 把"原位置"的灰线钉在内容被抬起来之前待的地方。 */
  private placeOriginLine() {
    const line = this.originEl
    const src = this.source
    if (!line || !src) return
    const rect = this.sourceRect(src)
    if (!rect) {
      line.style.display = 'none'
      return
    }
    line.style.display = 'block'
    line.style.left = `${rect.left}px`
    line.style.width = `${Math.max(24, rect.width)}px`
    line.style.top = `${rect.top - 3}px`
    // 落点线正好也画在这条缝里时，灰线让位 —— 一条缝里只留一个提示
    // （两条线叠在一起只会让人以为"这里有两个可以放的地方"）。
    const onLine = this.line
    const drop = onLine && onLine.style.display !== 'none' ? this.target : null
    line.style.visibility = drop && Math.abs(drop.y - rect.top) <= SAME_GAP ? 'hidden' : 'visible'
  }

  /** 被拖动那一坨在视口里的位置（滚动时跟着走）。 */
  private sourceRect(src: Source): DOMRect | null {
    const view = this.view
    const pos = src.kind === 'image' ? src.pos : src.from
    try {
      const el = view.nodeDOM(pos) as HTMLElement | null
      const r = el?.getBoundingClientRect?.()
      if (r && r.height > 0) return r
    } catch {
      /* nodeDOM 在结构边界上会抛，退回下面按坐标算 */
    }
    if (src.kind === 'image') {
      const r = src.el.getBoundingClientRect()
      return r.height > 0 ? r : null
    }
    try {
      const a = view.coordsAtPos(src.from)
      const b = view.coordsAtPos(Math.max(src.from, src.to - 1))
      const top = Math.min(a.top, b.top)
      const bottom = Math.max(a.bottom, b.bottom)
      const left = Math.min(a.left, b.left)
      if (bottom <= top) return null
      return new DOMRect(left, top, Math.max(a.right, b.right) - left, bottom - top)
    } catch {
      return null
    }
  }

  private resetSource() {
    this.source = null
    this.pointerId = -1
    this.downPos = -1
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }
}

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
  '<path d="M4 7h16M9.5 7V5h5v2M6.5 7l.9 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.5 7" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** 拖动时浮在底部的垃圾图标：内容是"抬起来"的，松手在这里就是删掉。 */
function createTrashZone(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'c2g-trash-zone'
  el.innerHTML = `${TRASH_SVG}<span>删除</span>`
  document.body.appendChild(el)
  return el
}

/** "内容原本在这儿"的灰线（拖动开始时出现，松手消失）。 */
function createOriginLine(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'c2g-origin-line'
  document.body.appendChild(el)
  return el
}

/** 拖动多行时跟着指针走的那张"纸条"：前几行文字 + 行数。 */
function textGhost(src: TextSource): HTMLElement {
  const box = document.createElement('div')
  box.className = 'c2g-drag-ghost'
  const body = document.createElement('div')
  body.className = 'c2g-drag-ghost-text'
  const onlyLabel = !src.text.trim() && !!src.label
  if (onlyLabel) {
    body.textContent = src.label as string
  } else {
    const lines = src.text.split('\n')
    const shown = lines.slice(0, GHOST_LINES).map((l) => {
      const t = l.trim() || '（空行）'
      return t.length > GHOST_CHARS ? `${t.slice(0, GHOST_CHARS)}…` : t
    })
    if (lines.length > GHOST_LINES) shown.push('…')
    body.textContent = shown.join('\n')
  }
  const badge = document.createElement('div')
  badge.className = 'c2g-drag-ghost-badge'
  badge.textContent = onlyLabel ? '移动这一行' : `移动 ${src.rows} 行`
  box.append(body, badge)
  document.body.appendChild(box)
  return box
}

/**
 * 长按 → 拖拽：
 * - 按住一张图：图片跟着指针走；
 * - 按住一段**选中的多行文字**：这几行淡下去，一张"纸条"跟着指针走；
 * - 落点画一条蓝色指示线，松手就把内容挪到那条线上（可以插进任意两行之间）；
 * - 拖到侧栏的某篇笔记上松手 = 把内容搬到那篇笔记（见 onDropOnNote）。
 */
export const MoveByDrag = Extension.create<MoveDragOptions>({
  name: 'moveByDrag',

  addOptions() {
    return {}
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      liftPlugin(),
      new Plugin({
        view: (view) => new MoveDragController(view, options),
      }),
    ]
  },
})