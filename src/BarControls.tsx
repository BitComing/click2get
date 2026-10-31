import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 标题栏右边那四个小控件（监控 / 平铺 / 搜索 / 图片库）。
 *
 * 以前顺序是写死的，现在可以**长按拖动换位置**：
 * - 按一下就松开 = 正常点击（各控件自己的功能不受影响）；
 * - 按住不动约 0.3 秒再横向拖 = 抬起这一项，其余几项跟着让位（拖动过程中就实时换位）；
 * - 松手落定并把顺序存进本地；Esc / 窗口失焦 = 放回原样。
 *
 * 顺序只是一条界面偏好，放在 localStorage 就够了（不进笔记数据、也不需要后端参与）。
 * 存在本地的值一律当"不可信输入"校验：必须是这四个 id 的一个排列，否则回默认顺序。
 */

export type BarId = 'monitor' | 'gallery' | 'search' | 'library'

export const DEFAULT_BAR_ORDER: BarId[] = ['monitor', 'gallery', 'search', 'library']

const KNOWN = new Set<string>(DEFAULT_BAR_ORDER)
const STORAGE_KEY = 'c2g.bar-order'

/** 按住多久算"要拖了"。和卡片那边一个手感。 */
const HOLD_MS = 280
/** 长按到点之前挪开这么多像素，就当是普通点击。 */
const MOVE_TOL = 6

export function readBarOrder(): BarId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_BAR_ORDER
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list) || list.length !== DEFAULT_BAR_ORDER.length) return DEFAULT_BAR_ORDER
    if (!list.every((id) => typeof id === 'string' && KNOWN.has(id))) return DEFAULT_BAR_ORDER
    if (new Set(list).size !== list.length) return DEFAULT_BAR_ORDER
    return list as BarId[]
  } catch {
    return DEFAULT_BAR_ORDER
  }
}

function writeBarOrder(order: BarId[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
  } catch {
    /* 存不进去也不影响这次使用 */
  }
}

type Props = {
  order: BarId[]
  onOrder: (next: BarId[]) => void
  items: Record<BarId, ReactNode>
}

export default function BarControls({ order, onOrder, items }: Props) {
  /** 正在被抬起来的那一项（null = 没在拖） */
  const [dragId, setDragId] = useState<BarId | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const orderRef = useRef(order)
  const timer = useRef<number | null>(null)
  /** 拖动开始前的顺序：取消时放回去 */
  const before = useRef<BarId[]>(order)
  const press = useRef<{ id: BarId | null; x: number; y: number; active: boolean }>({
    id: null,
    x: 0,
    y: 0,
    active: false,
  })
  /** 拖完紧跟着的那个 click 要吃掉（否则松手会顺手把监控关掉） */
  const skipClick = useRef(false)

  useEffect(() => {
    orderRef.current = order
  }, [order])

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const stopDrag = useCallback(() => {
    clearTimer()
    press.current = { id: null, x: 0, y: 0, active: false }
    setDragId(null)
    document.body.classList.remove('bar-reordering')
  }, [])

  const startDrag = useCallback((id: BarId) => {
    before.current = orderRef.current
    press.current.active = true
    setDragId(id)
    document.body.classList.add('bar-reordering')
  }, [])

  /**
   * 指针挪到哪儿，就把这一项插到哪儿。
   *
   * 落点只看**其余几项**的中线：指针越过谁的中线，就插到谁那一侧。
   * 被拖的那一项自己不进候选，否则它会跟着自己动、来回横跳。
   */
  const track = useCallback(
    (x: number) => {
      const id = press.current.id
      const box = boxRef.current
      if (!id || !box) return
      const others = Array.from(box.querySelectorAll<HTMLElement>('[data-bar-id]')).filter(
        (el) => el.dataset.barId !== id,
      )
      let index = others.length
      for (let i = 0; i < others.length; i++) {
        const r = others[i].getBoundingClientRect()
        if (x < r.left + r.width / 2) {
          index = i
          break
        }
      }
      const cur = orderRef.current
      const rest = cur.filter((k) => k !== id)
      const next = [...rest.slice(0, index), id, ...rest.slice(index)]
      if (next.join('|') !== cur.join('|')) {
        // 先改本地那份：同一个事件循环里可能连着来两次 pointermove，
        // 等 React 把新 order 传回来就晚了
        orderRef.current = next
        onOrder(next)
      }
    },
    [onOrder],
  )

  // 挂在 window 上：拖出这个小组件也不会断
  const api = useRef({ track, stopDrag })
  api.current = { track, stopDrag }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current
      if (!p.id) return
      if (!p.active) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOL) {
          // 还没按住就先动了：这是普通点击 / 误触，别接管
          clearTimer()
          p.id = null
        }
        return
      }
      e.preventDefault()
      api.current.track(e.clientX)
    }

    const onUp = () => {
      const p = press.current
      if (!p.id) return
      const wasActive = p.active
      api.current.stopDrag()
      if (wasActive) {
        skipClick.current = true
        // 松手后浏览器还会补一个 click；这里留个兜底，免得它一直挂着
        window.setTimeout(() => {
          skipClick.current = false
        }, 300)
      }
    }

    const onCancel = () => {
      const p = press.current
      if (!p.id) return
      const wasActive = p.active
      api.current.stopDrag()
      if (wasActive) {
        orderRef.current = before.current
        onOrder(before.current)
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !press.current.active) return
      e.preventDefault()
      e.stopPropagation()
      api.current.stopDrag()
      orderRef.current = before.current
      onOrder(before.current)
    }

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onOrder])

  const onDown = (e: React.PointerEvent<HTMLDivElement>, id: BarId) => {
    if (e.button !== 0 || !e.isPrimary) return
    skipClick.current = false
    press.current = { id, x: e.clientX, y: e.clientY, active: false }
    clearTimer()
    timer.current = window.setTimeout(() => {
      timer.current = null
      startDrag(id)
    }, HOLD_MS)
  }

  return (
    <div className="bar-actions" ref={boxRef}>
      {order.map((id) => (
        <div
          key={id}
          className={`bar-item ${dragId === id ? 'dragging' : ''}`}
          data-bar-id={id}
          onPointerDown={(e) => onDown(e, id)}
          onClickCapture={(e) => {
            if (!skipClick.current) return
            skipClick.current = false
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {items[id]}
        </div>
      ))}
    </div>
  )
}

/** 顺序变化后写盘（组件外用，保持调用点直白）。 */
export function persistBarOrder(order: BarId[]) {
  writeBarOrder(order)
}