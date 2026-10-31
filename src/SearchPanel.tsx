import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'

/** 与 Rust 侧 storage::SearchHit 对齐。 */
export type SearchHit = {
  id: string
  title: string
  /** "text" 正文 | "image" 图片备注 */
  kind: string
  snippet: string
  count: number
  /** 图片备注命中时是那张图的 hash；正文命中为 null */
  hash: string | null
}

type Props = {
  onClose: () => void
  onPick: (hit: SearchHit, query: string) => void
}

const KIND_LABEL: Record<string, string> = {
  text: '正文',
  image: '图片备注',
}

/** 把命中的关键词标出来（大小写不敏感，按原样切片）。 */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i <= text.length) {
    const at = lower.indexOf(needle, i)
    if (at < 0) {
      out.push(text.slice(i))
      break
    }
    if (at > i) out.push(text.slice(i, at))
    out.push(<mark key={key++}>{text.slice(at, at + q.length)}</mark>)
    i = at + q.length
  }
  return out
}

/**
 * 全局搜索：正文 + 图片备注。
 *
 * 搜索本身在 Rust 里做（逐篇读 notes/*.json，量级小，不建索引）；
 * 这里只管输入、列表和键盘上下选。跳转由 App 负责 —— 打开那篇笔记，
 * 再在编辑器里现算位置、选中并滚过去。
 */
export default function SearchPanel({ onClose, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** 防止慢请求把新结果盖掉 */
  const reqId = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      reqId.current++
      setHits([])
      setLoading(false)
      setError('')
      setActive(0)
      return
    }
    setLoading(true)
    const id = ++reqId.current
    const timer = window.setTimeout(() => {
      invoke<SearchHit[]>('search_notes', { query: q })
        .then((list) => {
          if (id !== reqId.current) return
          setHits(list)
          setActive(0)
          setError('')
        })
        .catch((e) => {
          if (id !== reqId.current) return
          setHits([])
          setError(String(e))
        })
        .finally(() => {
          if (id === reqId.current) setLoading(false)
        })
    }, 160)
    return () => window.clearTimeout(timer)
  }, [query])

  const pick = useCallback(
    (hit: SearchHit) => {
      onPick(hit, query.trim())
    },
    [onPick, query],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (hits.length) setActive((i) => (i + 1) % hits.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (hits.length) setActive((i) => (i - 1 + hits.length) % hits.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[active]
      if (hit) pick(hit)
    }
  }

  const tip = useMemo(() => {
    if (!query.trim()) return '输入关键词，搜索所有笔记的正文和图片备注'
    if (loading) return '正在搜索…'
    if (error) return `搜索失败：${error}`
    if (hits.length === 0) return `没有找到「${query.trim()}」`
    return ''
  }, [query, loading, error, hits.length])

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <SearchIcon />
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="搜索正文和图片备注…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <span className="search-loading" />}
          <kbd className="search-kbd">Esc</kbd>
        </div>

        <div className="search-body">
          {tip && <div className="search-tip">{tip}</div>}
          {hits.map((hit, i) => (
            <button
              key={`${hit.id}-${hit.kind}-${hit.hash ?? ''}`}
              className={`search-hit ${i === active ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(hit)}
            >
              <span className="search-hit-top">
                <span className="search-hit-title">{hit.title || '无标题笔记'}</span>
                <span className={`search-badge ${hit.kind}`}>{KIND_LABEL[hit.kind] ?? hit.kind}</span>
                {hit.count > 1 && <span className="search-count">{hit.count} 处</span>}
              </span>
              <span className="search-hit-snippet">{highlight(hit.snippet, query)}</span>
            </button>
          ))}
        </div>

        <div className="search-foot">
          <span>↑↓ 选择 · Enter 打开 · 图片备注在图片库里改</span>
          <div className="spacer" />
          <span>{hits.length > 0 ? `${hits.length} 条结果` : ''}</span>
        </div>
      </div>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="10.6" cy="10.6" r="6.4" />
      <path d="M15.4 15.4L21 21" strokeLinecap="round" />
    </svg>
  )
}