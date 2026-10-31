import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { fileUrl } from './editor/extensions'

/** 与 Rust 侧 gallery::GalleryNote 对齐（NoteMeta 的字段是摊平的）。 */
export type GalleryNote = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  sort: number | null
  /** 卡片上显示的正文，一行一段（最多 12 行） */
  preview: string[]
  /** 封面 / 缩略图（相对数据目录的路径） */
  images: string[]
  /** 段落数 */
  blocks: number
}

/** `gallery_view` 还会带一份 folders（老数据），这一页不用它，直接忽略。 */
type GalleryView = { notes: GalleryNote[] }

/** 长按多久算"要拖了"。 */
const LONG_PRESS = 280
/** 按住之后手指/鼠标挪过这么多像素也算开始拖。 */
const DRAG_START = 6
/**
 * 松手时"算不算真的拖过"。
 *
 * 手抖几像素不该把"点开笔记"吃掉 —— 只有确实挪开这么远（或者真的换了位置），
 * 才抑制紧随其后的 click；否则就当用户只是点了下卡片。
 */
const CLICK_SLOP = 12
/** 拖到滚动区上下边缘这么近就开始自动滚。 */
const EDGE = 64

/**
 * 落点：锚在哪张卡上、放在它前面还是后面。`anchorId` 为 null = 接在最后。
 *
 * 刻意**不用数字下标**——拖动时布局一点不动（被拖的卡片留在原位只变淡），
 * 所以"插到第几格"靠锚点卡 + 前后关系表示，真正写盘的下标在松手时算。
 * 用下标的话每次落点变化都要重排网格，两篇笔记换位置时就会连着闪。
 */
type DragTarget = { anchorId: string | null; side: 'before' | 'after' }

type Session = {
  ids: string[]
  target: DragTarget | null
  startX: number
  startY: number
  /** 从按下到现在，指针最远挪了多远（决定松手后要不要把 click 吃掉） */
  dist: number
  /** 已经过了长按/位移门槛，真的在拖了 */
  active: boolean
}

type Props = {
  /** 当前正文里打开的那篇（卡片上打个标记） */
  currentId: string | null
  onOpen: (id: string) => void
  onClose: () => void
  onToast: (text: string) => void
  /** 批量删除交给外面做：删的可能是正在编辑的那篇，得由 App 决定切到哪篇 */
  onDeleteNotes: (ids: string[]) => Promise<void>
}

/** 卡片右下角的时间：同年只写月日，跨年才带年份。 */
function fmtDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

/** 没有显式 sort 的老笔记：按创建时间倒序，和"新建的排前面"一个意思。 */
function sortKey(n: GalleryNote): number {
  return n.sort ?? -n.createdAt
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function hitQuery(n: GalleryNote, q: string): boolean {
  if (n.title.toLowerCase().includes(q)) return true
  return n.preview.some((line) => line.toLowerCase().includes(q))
}

/**
 * 平铺笔记预览：所有笔记一块儿铺成同一片格子，跟图片库一样是个弹窗
 * （半透明底 + 居中面板，点面板外的空白就退回去）。
 *
 * 没有目录、没有层级 —— 一页就是全部笔记，按自己的顺序排开：
 * - **点卡片**打开正文；
 * - **按住拖动**换位置（落点靠锚点卡 + 前后表示，拖动过程中布局不动）；
 * - **Ctrl+点击 / 右键**多选，底部出现批量条；
 * - **搜索**右上角搜标题和正文，命中的铺成一页。
 *
 * 每张卡都是正方形（宽 = 高，见 styles.css 里 .gal-card 的 aspect-ratio），
 * 所以整片格子是均匀的方块阵，不会因为字数多少长得参差不齐。
 *
 * 排序只写笔记的 sort，不动正文、不动 updatedAt —— 整理是整理，不该把笔记在侧栏里
 * 顶到最前面（见 Rust 侧 storage::patch_note）。
 */
export default function NoteGallery({ currentId, onOpen, onClose, onToast, onDeleteNotes }: Props) {
  const [notes, setNotes] = useState<GalleryNote[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [multi, setMulti] = useState(false)
  /** 拖动中要重画的部分：谁在被拖 + 落点。鼠标位置不在这里（跟手由 DOM 直接改）。 */
  const [drag, setDrag] = useState<{ ids: string[]; target: DragTarget | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  /** 卡片现在显示的顺序（落点按它换算下标） */
  const orderRef = useRef<string[]>([])
  const sessionRef = useRef<Session | null>(null)
  const pressTimer = useRef<number | null>(null)
  const skipClickRef = useRef(false)
  const autoRef = useRef<{ dy: number; x: number; y: number; raf: number | null }>({
    dy: 0,
    x: 0,
    y: 0,
    raf: null,
  })

  const load = useCallback(async () => {
    try {
      const v = await invoke<GalleryView>('gallery_view')
      setNotes(v.notes)
      setError('')
      const alive = new Set(v.notes.map((n) => n.id))
      setPicked((prev) => prev.filter((id) => alive.has(id)))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 开着这个页面时又捕获了新内容：列表自动跟上
  useEffect(() => {
    const un = listen('capture', () => {
      void load()
    })
    return () => {
      un.then((f) => f())
    }
  }, [load])

  // ── 数据整理 ────────────────────────────────────────

  /** 显示顺序：sort 优先，没 sort 的老笔记按创建时间倒序兜底。 */
  const ordered = useMemo(
    () =>
      [...(notes ?? [])].sort(
        (a, b) =>
          sortKey(a) - sortKey(b) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id),
      ),
    [notes],
  )

  // 当前显示的顺序（拖动落点换算用）
  useLayoutEffect(() => {
    orderRef.current = ordered.map((n) => n.id)
  }, [ordered])

  const total = notes?.length ?? 0
  const pickedSet = useMemo(() => new Set(picked), [picked])
  const titleOf = useCallback(
    (id: string) => notes?.find((n) => n.id === id)?.title ?? '笔记',
    [notes],
  )

  /** 按网格里显示的先后排一遍（多选整批拖动时，落下去的顺序要和看到的一致）。 */
  const inDisplayOrder = useCallback((ids: string[]) => {
    const pos = new Map<string, number>()
    orderRef.current.forEach((id, i) => pos.set(id, i))
    return [...ids].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0))
  }, [])

  /** 把本地顺序改一遍：落盘成功前界面已经是新样子，不闪。 */
  const applyLocal = useCallback((order: string[]) => {
    const sortMap = new Map(order.map((id, i) => [id, i]))
    setNotes((prev) =>
      prev ? prev.map((n) => (sortMap.has(n.id) ? { ...n, sort: sortMap.get(n.id)! } : n)) : prev,
    )
  }, [])

  // ── 搜索 ────────────────────────────────────────────

  const needle = query.trim().toLowerCase()
  const hits = useMemo(
    () => (needle ? ordered.filter((n) => hitQuery(n, needle)) : null),
    [needle, ordered],
  )

  // ── 落点计算 ─────────────────────────────────────────

  /**
   * 指针下面是哪张卡、插到它的前/后。
   *
   * 只判断"锚点"，不重排任何东西 —— 拖动过程中布局是静止的（见 DragTarget 注释）。
   * 返回 null 表示"位置没变 / 不在任何可放置的地方"，调用方保持原落点。
   */
  const hitTest = useCallback((x: number, y: number): DragTarget | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return null
    const cur = sessionRef.current?.target

    const card = el.closest('[data-gal-card]') as HTMLElement | null
    if (card && card.dataset.galCard) {
      const id = card.dataset.galCard
      const r = card.getBoundingClientRect()
      const mid = r.left + r.width / 2
      // 已经锚在这张卡上了才留死区：指针贴中线来回 1px 时线不要左右横跳
      const band = Math.min(16, r.width * 0.14)
      if (cur && cur.anchorId === id && x > mid - band && x < mid + band) {
        return null
      }
      return { anchorId: id, side: x > mid ? 'after' : 'before' }
    }

    const zone = el.closest('[data-gal-drop]') as HTMLElement | null
    if (zone && zone.dataset.galDrop) {
      // 格子里的缝、最后一张右边的空地：锚到"离得最近的那张卡"
      const cardEls = Array.from(zone.querySelectorAll<HTMLElement>('[data-gal-card]'))
      let best: { id: string; side: 'before' | 'after'; d: number } | null = null
      for (const c of cardEls) {
        const r = c.getBoundingClientRect()
        const dx = x - (r.left + r.width / 2)
        const dy = y - (r.top + r.height / 2)
        const d = Math.abs(dx) + Math.abs(dy) * 2
        if (!best || d < best.d) {
          best = {
            id: c.dataset.galCard ?? '',
            side: x > r.left + r.width / 2 ? 'after' : 'before',
            d,
          }
        }
      }
      if (best && best.id) return { anchorId: best.id, side: best.side }
      return { anchorId: null, side: 'after' }
    }
    return null
  }, [])

  /** 把"锚点 + 前后"换算成"去掉被拖的卡片之后的下标"。 */
  const resolveIndex = useCallback((target: DragTarget, ids: string[]) => {
    const full = orderRef.current
    const moving = new Set(ids)
    if (!target.anchorId) return full.filter((id) => !moving.has(id)).length
    const pos = full.indexOf(target.anchorId)
    const cut = pos >= 0 ? pos + (target.side === 'after' ? 1 : 0) : full.length
    return full.slice(0, cut).filter((id) => !moving.has(id)).length
  }, [])

  // ── 拖动 ────────────────────────────────────────────

  const setGhostPos = useCallback((x: number, y: number) => {
    const el = ghostRef.current
    if (el) el.style.transform = `translate(${x + 14}px, ${y + 12}px)`
  }, [])

  const stopAutoScroll = useCallback(() => {
    const a = autoRef.current
    if (a.raf !== null) cancelAnimationFrame(a.raf)
    a.raf = null
    a.dy = 0
  }, [])

  const refreshTarget = useCallback(
    (x: number, y: number) => {
      const s = sessionRef.current
      if (!s || !s.active) return
      const next = hitTest(x, y)
      if (!next) return
      const prev = s.target
      if (prev && prev.anchorId === next.anchorId && prev.side === next.side) return
      s.target = next
      setDrag({ ids: s.ids, target: next })
    },
    [hitTest],
  )

  const tickScroll = useCallback(() => {
    const el = scrollRef.current
    const a = autoRef.current
    if (!el || !a.dy) {
      a.raf = null
      return
    }
    el.scrollTop += a.dy
    refreshTarget(a.x, a.y)
    a.raf = requestAnimationFrame(tickScroll)
  }, [refreshTarget])

  const trackPointer = useCallback(
    (x: number, y: number) => {
      const s = sessionRef.current
      if (s) {
        const d = Math.hypot(x - s.startX, y - s.startY)
        if (d > s.dist) s.dist = d
      }
      setGhostPos(x, y)
      refreshTarget(x, y)

      const el = scrollRef.current
      const a = autoRef.current
      a.x = x
      a.y = y
      a.dy = 0
      if (el) {
        const r = el.getBoundingClientRect()
        if (y < r.top + EDGE) a.dy = -Math.ceil(((r.top + EDGE - y) / EDGE) * 16)
        else if (y > r.bottom - EDGE) a.dy = Math.ceil(((y - (r.bottom - EDGE)) / EDGE) * 16)
      }
      if (a.dy && a.raf === null) a.raf = requestAnimationFrame(tickScroll)
      if (!a.dy) stopAutoScroll()
    },
    [refreshTarget, setGhostPos, stopAutoScroll, tickScroll],
  )

  const startDrag = useCallback(
    (x: number, y: number) => {
      const s = sessionRef.current
      if (!s || s.active) return
      if (pressTimer.current !== null) {
        window.clearTimeout(pressTimer.current)
        pressTimer.current = null
      }
      s.active = true
      document.body.classList.add('gal-dragging')
      autoRef.current.x = x
      autoRef.current.y = y
      setGhostPos(x, y)
      const t = hitTest(x, y)
      s.target = t
      setDrag({ ids: s.ids, target: t })
    },
    [hitTest, setGhostPos],
  )

  /**
   * 收尾。commit=false 是"取消"（Esc / 窗口失焦），什么都不写。
   *
   * 顺序：本地先摆好（界面立刻是新样子）→ 写顺序 → 重新读一遍对齐。
   * 中途失败就重新读，界面回到磁盘上的样子，不留"看着挪了其实没挪"的状态。
   */
  const finishDrag = useCallback(
    (commit: boolean) => {
      if (pressTimer.current !== null) {
        window.clearTimeout(pressTimer.current)
        pressTimer.current = null
      }
      stopAutoScroll()
      document.body.classList.remove('gal-dragging')

      const s = sessionRef.current
      sessionRef.current = null
      setDrag(null)
      if (!s || !s.active) return

      // 手抖几像素就松手：这颗 click 还是"打开笔记"，别吃掉；
      // 真挪开了一段距离才当成拖动的手尾
      skipClickRef.current = s.dist >= CLICK_SLOP
      window.setTimeout(() => {
        skipClickRef.current = false
      }, 0)

      const target = s.target
      if (!commit || !target) return

      const index = resolveIndex(target, s.ids)
      const moving = new Set(s.ids)
      const rest = orderRef.current.filter((id) => !moving.has(id))
      const order = [...rest.slice(0, index), ...s.ids, ...rest.slice(index)]
      if (sameIds(orderRef.current, order)) return

      // 真要落盘了：这一下肯定是拖动，别让松手后的 click 又把笔记打开
      skipClickRef.current = true
      applyLocal(order)
      void (async () => {
        try {
          await invoke('notes_save_order', { ids: order })
          await load()
        } catch (e) {
          console.error(e)
          onToast('没保存上，已经恢复原样')
          await load()
        }
      })()
    },
    [applyLocal, load, onToast, resolveIndex, stopAutoScroll],
  )

  /** 最新的实现放这儿：监听只挂一次，永远用最新闭包。 */
  const apiRef = useRef({ startDrag, trackPointer, finishDrag })
  apiRef.current = { startDrag, trackPointer, finishDrag }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const s = sessionRef.current
      if (!s) return
      const api = apiRef.current
      if (!s.active) {
        const far =
          Math.abs(e.clientX - s.startX) >= DRAG_START || Math.abs(e.clientY - s.startY) >= DRAG_START
        if (!far) return
        api.startDrag(e.clientX, e.clientY)
      }
      // 松手了却没收到 mouseup（在窗口外面松的）：就地落地，别让卡片一直粘着鼠标
      if (e.buttons === 0) {
        api.finishDrag(true)
        return
      }
      api.trackPointer(e.clientX, e.clientY)
    }

    const onUp = () => {
      if (!sessionRef.current) return
      apiRef.current.finishDrag(true)
    }

    const onBlur = () => {
      if (!sessionRef.current) return
      apiRef.current.finishDrag(false)
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const onCardMouseDown = (e: React.MouseEvent<HTMLElement>, note: GalleryNote) => {
    if (e.button !== 0 || busy || sessionRef.current) return
    if ((e.target as HTMLElement).closest('button')) return
    if (needle) return // 搜索结果里不拖
    const ids = pickedSet.has(note.id) ? inDisplayOrder(picked) : [note.id]
    sessionRef.current = {
      ids,
      target: null,
      startX: e.clientX,
      startY: e.clientY,
      dist: 0,
      active: false,
    }
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      const s = sessionRef.current
      if (!s || s.active) return
      apiRef.current.startDrag(s.startX, s.startY)
    }, LONG_PRESS)
  }

  const openCard = (e: React.MouseEvent, note: GalleryNote) => {
    if (skipClickRef.current) return
    if (multi || e.ctrlKey || e.metaKey) {
      setMulti(true)
      togglePick(note.id)
      return
    }
    onOpen(note.id)
  }

  // ── 键盘 ────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        // 在这个页面里 Ctrl+F 是"搜笔记"，不是全局搜索面板
        e.preventDefault()
        e.stopPropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (sessionRef.current) {
        finishDrag(false)
        return
      }
      if (confirmDelete) {
        setConfirmDelete(null)
        return
      }
      if (query) {
        setQuery('')
        return
      }
      if (multi) {
        setMulti(false)
        setPicked([])
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirmDelete, finishDrag, multi, onClose, query])

  // ── 批量 ────────────────────────────────────────────

  const doDeletePicked = async () => {
    const ids = confirmDelete
    setConfirmDelete(null)
    if (!ids || ids.length === 0) return
    setBusy(true)
    try {
      await onDeleteNotes(ids)
      setPicked([])
      setMulti(false)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const togglePick = (id: string) => {
    setMulti(true)
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // ── 渲染 ────────────────────────────────────────────

  const dragIds = useMemo(() => new Set(drag?.ids ?? []), [drag])
  const pickedCount = picked.length
  /** 铺出来的是全部笔记，还是搜索结果 */
  const shown = hits ?? ordered

  const renderCard = (n: GalleryNote) => {
    const isPicked = pickedSet.has(n.id)
    const beingDragged = dragIds.has(n.id)
    const drop =
      drag && drag.target && drag.target.anchorId === n.id ? drag.target.side : null
    return (
      <article
        key={n.id}
        className={`gal-card ${isPicked ? 'picked' : ''} ${beingDragged ? 'dragging' : ''} ${
          n.id === currentId ? 'current' : ''
        } ${n.images.length > 0 ? 'with-cover' : 'text-only'} ${
          drop === 'before' ? 'drop-before' : drop === 'after' ? 'drop-after' : ''
        }`}
        data-gal-card={n.id}
        onMouseDown={(e) => onCardMouseDown(e, n)}
        onClick={(e) => openCard(e, n)}
        onContextMenu={(e) => {
          e.preventDefault()
          togglePick(n.id)
        }}
        title={`${n.title}（点击打开，按住拖动换位置）`}
      >
        {n.images.length > 0 && (
          <div className="gal-cover">
            <img src={fileUrl(n.images[0])} alt="" draggable={false} loading="lazy" />
            {n.images.length > 1 && <span className="gal-cover-more">+{n.images.length - 1}</span>}
          </div>
        )}

        {n.pinned && (
          <span className="gal-pin" title="已置顶">
            <PinIcon />
          </span>
        )}

        <div className="gal-card-body">
          <h3 className={`gal-card-title ${n.pinned ? 'has-pin' : ''}`}>{n.title}</h3>
          {n.preview.length > 0 || n.images.length > 0 ? (
            <p className="gal-card-text">{n.preview.join('\n')}</p>
          ) : (
            <p className="gal-card-text gal-card-blank">这篇还是空的</p>
          )}
        </div>

        <div className="gal-card-foot">
          <button
            className={`gal-pick ${isPicked ? 'on' : ''} ${multi ? 'show' : ''}`}
            title={isPicked ? '取消选中' : '选中这篇'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              togglePick(n.id)
            }}
          >
            {isPicked && <CheckIcon />}
          </button>
          <span className="gal-card-meta">{n.blocks > 0 ? `${n.blocks} 段` : ''}</span>
          <span className="gal-card-date">{fmtDate(n.updatedAt || n.createdAt)}</span>
        </div>
      </article>
    )
  }

  return (
    // 和图片库一样：一层半透明底 + 居中一块面板。
    // 点面板外面的空白 / 按 Esc 都退出（Esc 的分层见上面的 onKey）。
    <>
      <div className="gal-backdrop" onClick={onClose} />
      <div className="gal">
        <header className="gal-bar">
          <div className="gal-head">
            <div className="gal-title">
              {needle ? `搜索「${query.trim()}」` : '所有笔记'}
            </div>
            <div className="gal-sub">
              {notes
                ? `${
                    needle ? `${shown.length} / ${total}` : total
                  } 篇${pickedCount > 0 ? ` · 已选 ${pickedCount} 篇` : ''}`
                : '正在读取…'}
            </div>
          </div>
          <div className="spacer" />
          <div className="gal-searchbox">
            <SearchIcon />
            <input
              ref={searchRef}
              className="gal-search"
              value={query}
              placeholder="搜索标题、正文…"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  if (query) setQuery('')
                  else searchRef.current?.blur()
                }
              }}
            />
            {query && (
              <button className="gal-search-clear" onClick={() => setQuery('')} title="清空（Esc）">
                <CloseIcon />
              </button>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon />
          </button>
        </header>

        <div className={`gal-body ${drag ? 'dragging' : ''}`} ref={scrollRef}>
          {error && (
            <div className="gal-empty">
              <div>读取笔记失败：{error}</div>
              <button className="btn" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
          {!error && notes === null && <div className="gal-empty">正在读取…</div>}

          {/* 一页 = 全部笔记，全都铺在同一片格子里（搜索结果也一样铺在这一片） */}
          {!error && notes !== null && (
            <div className="gal-grid" data-gal-drop="all">
              {shown.map((n) => renderCard(n))}
              {shown.length === 0 && (
                <div className="gal-grid-hint">
                  {needle
                    ? `没有找到包含「${query.trim()}」的笔记`
                    : '还没有笔记。在别处复制点东西，或者回编辑页新建一篇，它就会出现在这里。'}
                </div>
              )}
            </div>
          )}

          {!error && notes !== null && !needle && (
            <div className="gal-foot">
              <span className="gal-hint">
                按住卡片拖动可以换位置 · Ctrl+点击 / 右键多选 · Ctrl+F 搜索
              </span>
            </div>
          )}
        </div>

        {drag && (
          <div className="gal-drag-hint">
            {drag.target
              ? drag.target.anchorId === null
                ? '松手 = 放到最后'
                : '松手 = 放到这个位置'
              : '拖到两张卡片之间松手'}
          </div>
        )}

        {pickedCount > 0 && (
          <div className="gal-bulk">
            <span className="gal-bulk-info">
              已选 <b>{pickedCount}</b> 篇
            </span>
            <div className="spacer" />
            <button className="btn danger" onClick={() => setConfirmDelete(picked)} disabled={busy}>
              删除
            </button>
            <button
              className="btn"
              onClick={() => {
                setPicked([])
                setMulti(false)
              }}
              disabled={busy}
            >
              取消
            </button>
          </div>
        )}

        {confirmDelete && (
          <div className="modal-backdrop" onClick={() => setConfirmDelete(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">删除选中的 {confirmDelete.length} 篇笔记？</div>
              <div className="modal-body">
                {confirmDelete
                  .map((id) => titleOf(id))
                  .slice(0, 4)
                  .map((t) => `「${t}」`)
                  .join('、')}
                {confirmDelete.length > 4 ? ` 等 ${confirmDelete.length} 篇` : ''}
                <br />
                会一起移到 <code>notes/.trash</code>，不会立刻消失。
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
                <button className="btn danger" onClick={() => void doDeletePicked()}>
                  删除 {confirmDelete.length} 篇
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 跟着指针的纸条放在面板外面：它是 viewport 坐标（transform 直接写指针位置），
          放进有 transform 的面板里会被面板的坐标系再偏移一次。 */}
      {drag && (
        <div
          className="gal-ghost"
          ref={(el) => {
            ghostRef.current = el
            if (el) {
              const s = autoRef.current
              el.style.transform = `translate(${s.x + 14}px, ${s.y + 12}px)`
            }
          }}
        >
          <span className="gal-ghost-count">{drag.ids.length}</span>
          <span className="gal-ghost-title">{titleOf(drag.ids[0])}</span>
        </div>
      )}
    </>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" strokeLinecap="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="10.6" cy="10.6" r="6.2" />
      <path d="M15.3 15.3L21 21" strokeLinecap="round" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path
        d="M9 4h6m-5 0l-.9 6.1a4 4 0 0 1-1.5 2.6L6 14.4V16h12v-1.6l-1.6-1.7a4 4 0 0 1-1.5-2.6L14 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 16v4" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4">
      <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
