import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fileUrl } from './editor/extensions'
import { metaOf, previewOf, type CollectItem } from './editor/collectBox'

/**
 * 收纳箱（界面部分）。
 *
 * 位置：贴在**编辑面板的右侧**、拖动时浮出来的删除图标**上面** ——
 * 拖内容过去松手，内容就临时存进箱子（正文里那份删掉），箱子带着数量停在那儿；
 * 攒够了、光标放到合适的地方，点一下箱子，把里面的东西放出来。
 *
 * 摆放坐标和 `dragMove.ts` 的 `placeTrash()` 是同一套（面板右边进 14px、竖直居中），
 * 所以两个图标永远上下对齐；删除图标是拖动时临时建的，箱子则是常驻的 ——
 * 有内容就一直在，空的时候只在拖动期间露出来（提示"这儿能放"）。
 */

/** 删除图标的高度 / 与收纳箱之间的空隙：和 dragMove.placeTrash() 的外框一致。 */
const TRASH_H = 58
const GAP = 10
/** 图标宽度：和 .c2g-trash-zone 同宽，两者才对得齐右边。 */
const BOX_W = 58
/** 离编辑面板右边缘多少像素（与 placeTrash() 的 14 一致）。 */
const EDGE = 14
/** 标题栏高度：面板再高也不能压到标题栏上。 */
const BAR_H = 44

type Props = {
  items: CollectItem[]
  /** 正文所在的滚动面板：收纳箱按它的位置贴边 */
  anchor: React.RefObject<HTMLDivElement | null>
  /** 放到光标处（插完这一条就从箱子里拿走） */
  onInsert: (item: CollectItem) => void
  /** 全按列表顺序放到光标处 */
  onInsertAll: () => void
  /** 把某一条从箱子里扔掉（正文里已经没有了，这里只是清掉暂存） */
  onRemove: (id: string) => void
  onClear: () => void
}

export default function CollectBox({ items, anchor, onInsert, onInsertAll, onRemove, onClear }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [open, setOpen] = useState(false)
  const count = items.length

  // 箱子是空的、又是"刚被放空"的：面板自己收起来（清空 / 全部放完之后）
  const hadItems = useRef(false)
  useEffect(() => {
    if (count > 0) hadItems.current = true
    else if (hadItems.current) {
      hadItems.current = false
      setOpen(false)
    }
  }, [count])

  // 面板开着时 Esc 关掉（捕获阶段，别让编辑器的 Esc 抢走）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  /**
   * 贴边：面板位置会随窗口大小、侧栏宽度变化，所以 resize 和面板尺寸变化都重算一次。
   * 竖直方向对齐"删除图标的正上方"：删除图标高 58、居中，箱子坐在它上面留 10px。
   */
  useLayoutEffect(() => {
    const place = () => {
      const panel = anchor.current
      const box = boxRef.current
      if (!panel || !box) return
      const r = panel.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      const w = box.offsetWidth || BOX_W
      const h = box.offsetHeight || BOX_W
      const trashTop = r.top + (r.height - TRASH_H) / 2
      setPos({
        left: Math.round(r.right - w - EDGE),
        top: Math.round(Math.max(BAR_H + 10, trashTop - h - GAP)),
      })
    }
    place()
    window.addEventListener('resize', place)
    let ro: ResizeObserver | null = null
    const panel = anchor.current
    if (panel && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(place)
      ro.observe(panel)
    }
    return () => {
      window.removeEventListener('resize', place)
      ro?.disconnect()
    }
  }, [anchor, count, open])

  const previews = useMemo(() => items.map((it) => previewOf(it.blocks)), [items])
  // 面板贴在箱子**左边**：面板右边缘离窗口右边 = 箱子左边缘再往里让 10px
  const panelRight = pos ? Math.max(12, Math.round(window.innerWidth - pos.left + 10)) : 12

  return (
    <>
      <div
        ref={boxRef}
        data-collect-box=""
        role="button"
        tabIndex={0}
        aria-haspopup="true"
        aria-expanded={open}
        className={`c2g-collect ${count > 0 ? 'filled' : ''} ${open ? 'open' : ''}`}
        style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
        title={
          count > 0
            ? `收纳箱 · ${count} 项：点开可以把它们放到光标处`
            : '收纳箱：把内容拖到这里先放着，跨笔记也能攒'
        }
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setOpen((v) => !v)
        }}
      >
        <CollectIcon />
        <span className="c2g-collect-label">收纳箱</span>
        {count > 0 && <span className="c2g-collect-count">{count}</span>}
      </div>

      {open && pos && (
        <>
          <div className="c2g-collect-backdrop" onClick={() => setOpen(false)} />
          <div className="c2g-collect-panel" style={{ right: panelRight, top: BAR_H + 12 }}>
            <div className="c2g-collect-head">
              <span>收纳箱 · {count} 项</span>
              <div className="spacer" />
              <button
                className="mini-btn"
                disabled={count === 0}
                title="按收进来的先后顺序，全部放到光标处"
                onClick={onInsertAll}
              >
                全部放入
              </button>
              <button
                className="mini-btn"
                disabled={count === 0}
                title="清空收纳箱（正文里已经没有了）"
                onClick={onClear}
              >
                清空
              </button>
            </div>
            <div className="c2g-collect-list">
              {count === 0 && (
                <div className="c2g-collect-empty">
                  把正文里的几行（或一张图）拖到收纳箱上松手，就会先存在这儿；
                  攒够了、光标放到想放的地方，再点这一条。
                </div>
              )}
              {items.map((item, i) => {
                const p = previews[i]
                return (
                  <div className="c2g-collect-row" key={item.id}>
                    <button
                      className="c2g-collect-item"
                      onClick={() => onInsert(item)}
                      title="放到光标处"
                    >
                      {p.thumb && <img className="c2g-collect-thumb" src={fileUrl(p.thumb)} alt="" />}
                      <span className="c2g-collect-body">
                        <span className={`c2g-collect-text ${p.text ? '' : 'muted'}`}>
                          {p.text || (p.images > 0 ? '图片' : '（空内容）')}
                        </span>
                        <span className="c2g-collect-meta">{metaOf(item, p)}</span>
                      </span>
                    </button>
                    <button
                      className="c2g-collect-remove"
                      title="从收纳箱里扔掉了事"
                      aria-label="从收纳箱删掉这一项"
                      onClick={() => onRemove(item.id)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="c2g-collect-foot">
              点某一项 → 放到光标处（先点好正文里的位置）；「全部放入」按收进来的先后排好
            </div>
          </div>
        </>
      )}
    </>
  )
}

/** 收纳箱：带盖的小箱子，中间一道取物口。 */
function CollectIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path
        d="M3.6 9.2h16.8l-1.1 8.5a2 2 0 0 1-2 1.8H6.7a2 2 0 0 1-2-1.8L3.6 9.2Z"
        strokeLinejoin="round"
      />
      <path
        d="M3.9 9.2 5.3 5.2a1.7 1.7 0 0 1 1.6-1.1h10.2a1.7 1.7 0 0 1 1.6 1.1l1.4 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.8 12.6h4.4" strokeLinecap="round" />
    </svg>
  )
}