import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { fileUrl } from './editor/extensions'

/** 引用这张图的笔记。 */
type ImageUser = { id: string; title: string }

/** 与 Rust 侧 storage::ImageMeta 对齐。 */
export type ImageItem = {
  hash: string
  path: string
  bytes: number
  createdAt: number
  width: number
  height: number
  /** 这张图自己的备注（编辑页不展示，在这儿管理） */
  note: string
  /** 引用这张图的笔记（同一篇只出现一次） */
  usedBy: ImageUser[]
}

type ViewMode = 'time' | 'note'

type Group = {
  key: string
  title: string
  /** 笔记 id；"未引用"这组没有 */
  noteId: string | null
  items: ImageItem[]
}

type Props = {
  onClose: () => void
  onToast: (text: string) => void
  /** 从图片右键"查看大图"进来时直接定位到这张 */
  initialHash?: string | null
  /** 把选中的图追加到当前笔记 */
  onInsert: (items: ImageItem[]) => void
  /** 用选中的图新建一篇笔记 */
  onCreateNote: (items: ImageItem[]) => void
  /** 真实删除一篇笔记（不进回收站） */
  onPurgeNote: (noteId: string) => Promise<void>
  /** 删图之前：让外面先把正文落盘（否则待保存的编辑会把刚删的图写回去） */
  onBeforeDelete?: () => Promise<void>
  /** 删图之后：Rust 已把这些图从笔记正文里一并摘掉，这里把受影响的笔记同步一遍 */
  onImagesDeleted?: (info: DeleteImagesResult) => void | Promise<void>
  /** 跳到某篇笔记 */
  onOpenNote: (noteId: string) => void
}

/** delete_images 的返回：移走了几张 + 哪几篇笔记的正文被动过。 */
type DeleteImagesResult = { moved: number; touched: string[] }

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 右键菜单别跑到窗口外面去（宽度按一个菜单项估，够用就行）。 */
function clampMenu(x: number, y: number, width = 210, height = 92) {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  }
}

/**
 * 图片库：把 images/ 里的图全摆出来，点选可多选，删除走 images/.trash。
 *
 * 两种看法：
 * - 按时间：所有图排成一条时间线，可以切最新/最早；
 * - 按笔记：按"被哪篇笔记引用"分组，一组一组看，组上可以直接删笔记（真删）。
 *
 * 缩略图直接用 asset:// 加载原图 —— 项目里的图都是截图，没必要另生成缩略图文件。
 */
export default function ImageLibrary({
  onClose,
  onToast,
  initialHash,
  onInsert,
  onCreateNote,
  onPurgeNote,
  onBeforeDelete,
  onImagesDeleted,
  onOpenNote,
}: Props) {
  const [items, setItems] = useState<ImageItem[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewHash, setPreviewHash] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('time')
  const [asc, setAsc] = useState(false)
  const [purging, setPurging] = useState<Group | null>(null)
  /** 大图预览下面那块备注编辑区 */
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  /** 从 tile 上的"备注"按钮进来时，预览要直接把备注区打开 */
  const wantNotePanel = useRef(false)
  /** 大图上右键：菜单开在指针处 */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  /** OCR：识别结果（null = 没开结果面板） */
  const [ocrText, setOcrText] = useState<string | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrSaving, setOcrSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await invoke<ImageItem[]>('list_images')
      setItems(list)
      setError('')
      // 图片可能刚被别处删掉，选中集合和大图预览跟着收一遍
      setSelected((prev) => prev.filter((h) => list.some((it) => it.hash === h)))
      setPreviewHash((prev) => (prev && list.some((it) => it.hash === prev) ? prev : null))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 从图片右键"查看大图"进来：直接开大图
  useEffect(() => {
    if (initialHash) setPreviewHash(initialHash)
  }, [initialHash])

  // 开着图片库时又捕获了新图：列表自动跟上
  useEffect(() => {
    const un = listen('capture', () => {
      void load()
    })
    return () => {
      un.then((f) => f())
    }
  }, [load])

  const total = items?.length ?? 0
  const totalBytes = useMemo(() => (items ?? []).reduce((n, it) => n + it.bytes, 0), [items])
  const allSelected = total > 0 && selected.length === total

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const selectedItems = useMemo(
    () => (items ?? []).filter((it) => selectedSet.has(it.hash)),
    [items, selectedSet],
  )

  const sorted = useMemo(() => {
    const list = [...(items ?? [])]
    list.sort((a, b) => {
      const d = asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
      return d !== 0 ? d : a.hash.localeCompare(b.hash)
    })
    return list
  }, [items, asc])

  /** 按笔记分组：一张图被两篇笔记引用时会出现在两组里，这是内容寻址的正常结果。 */
  const groups = useMemo<Group[]>(() => {
    if (mode !== 'note') return []
    const map = new Map<string, Group>()
    const orphan: ImageItem[] = []
    for (const it of sorted) {
      if (it.usedBy.length === 0) {
        orphan.push(it)
        continue
      }
      for (const u of it.usedBy) {
        let g = map.get(u.id)
        if (!g) {
          g = { key: u.id, title: u.title || '无标题笔记', noteId: u.id, items: [] }
          map.set(u.id, g)
        }
        g.items.push(it)
      }
    }
    // 最近用过的笔记排前面；没人引用的丢到最后
    const out = [...map.values()].sort((a, b) => b.items[0].createdAt - a.items[0].createdAt)
    if (orphan.length) {
      out.push({ key: '__orphan', title: '未引用的图片', noteId: null, items: orphan })
    }
    return out
  }, [mode, sorted])

  const toggle = useCallback((hash: string) => {
    setSelected((prev) => (prev.includes(hash) ? prev.filter((h) => h !== hash) : [...prev, hash]))
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.length === total ? [] : (items ?? []).map((it) => it.hash)))
  }, [items, total])

  const previewIndex = previewHash ? (items ?? []).findIndex((it) => it.hash === previewHash) : -1
  const previewItem = previewIndex >= 0 ? (items ?? [])[previewIndex] : null

  // 换一张图就把备注草稿换成这张图的；从 tile 的"备注"按钮进来时顺手把编辑区打开
  useEffect(() => {
    const it = (items ?? []).find((x) => x.hash === previewHash)
    setNoteDraft(it?.note ?? '')
    if (!previewHash) {
      setNoteOpen(false)
      wantNotePanel.current = false
      return
    }
    if (wantNotePanel.current) {
      setNoteOpen(true)
      wantNotePanel.current = false
    }
  }, [previewHash, items])

  /** 备注按图片存：这里改的就是编辑页右键"备注…"看到的那一份。 */
  const saveNote = useCallback(async () => {
    const it = previewItem
    if (!it) return
    setNoteSaving(true)
    try {
      await invoke('set_image_note', { hash: it.hash, note: noteDraft })
      const next = noteDraft.trim()
      setItems((prev) => prev?.map((x) => (x.hash === it.hash ? { ...x, note: next } : x)) ?? prev)
      onToast(next ? '备注已保存' : '备注已清空')
    } catch (e) {
      onToast('备注保存失败')
      console.error(e)
    } finally {
      setNoteSaving(false)
    }
  }, [previewItem, noteDraft, onToast])

  const stepPreview = useCallback(
    (delta: number) => {
      if (!items || items.length === 0 || previewIndex < 0) return
      const next = (previewIndex + delta + items.length) % items.length
      setPreviewHash(items[next].hash)
    },
    [items, previewIndex],
  )

  /** 换一张图就把右键菜单 / OCR 结果收掉（它们都是"针对这张图"的）。 */
  useEffect(() => {
    setCtxMenu(null)
    setOcrText(null)
  }, [previewHash])

  /**
   * 大图右键 → 识别文字（OCR）。
   *
   * 和编辑页里那个是同一个后端命令；结果同样先让人改，再决定存不存。
   * 结果的归宿还是这张图的备注（图片库本来就管这个），不往笔记正文里塞。
   */
  const runOcr = useCallback(async () => {
    const it = previewItem
    setCtxMenu(null)
    if (!it) return
    setOcrBusy(true)
    try {
      const text = (await invoke<string>('ocr_image', { hash: it.hash })).trim()
      if (!text) {
        onToast('图里没认出文字')
        return
      }
      setOcrText(text)
    } catch (e) {
      console.error(e)
      onToast(typeof e === 'string' && e ? e : 'OCR 不可用')
    } finally {
      setOcrBusy(false)
    }
  }, [previewItem, onToast])

  /** OCR 结果复制走：走 Rust 命令打标记，否则开着监控会被自己再捕获一次。 */
  const copyOcr = useCallback(async () => {
    if (ocrText === null) return
    try {
      await invoke('copy_with_marker', { text: ocrText })
      onToast('已复制')
    } catch {
      onToast('复制失败')
    }
  }, [ocrText, onToast])

  /** 识别结果追加进这张图的备注（常常是补一段说明，不覆盖原来那句）。 */
  const saveOcr = useCallback(async () => {
    const it = previewItem
    if (!it || ocrText === null) return
    const text = ocrText.trim()
    if (!text) {
      onToast('没有可保存的文字')
      return
    }
    setOcrSaving(true)
    try {
      let existing = ''
      try {
        existing = await invoke<string>('get_image_note', { hash: it.hash })
      } catch {
        /* 读不到就当原来没有备注 */
      }
      const merged = existing.trim() ? `${existing.trimEnd()}\n${text}` : text
      await invoke('set_image_note', { hash: it.hash, note: merged })
      setItems((prev) => prev?.map((x) => (x.hash === it.hash ? { ...x, note: merged } : x)) ?? prev)
      setNoteDraft(merged)
      setOcrText(null)
      onToast('已存进图片备注')
    } catch (e) {
      console.error(e)
      onToast('保存备注失败')
    } finally {
      setOcrSaving(false)
    }
  }, [previewItem, ocrText, onToast])

  const doDelete = useCallback(async () => {
    if (!selected.length) return
    const hashes = selected
    setBusy(true)
    try {
      // 先把正文落盘：否则那 500ms 内的待保存内容会把刚删的图又写回笔记
      await onBeforeDelete?.()
      // Rust 侧连正文一起处理：图移进 images/.trash，笔记里引用它的节点同时摘掉，
      // 不然笔记页面上会留一块加载不出来的破图
      const res = await invoke<DeleteImagesResult>('delete_images', { hashes })
      setConfirming(false)
      setSelected([])
      setPreviewHash(null)
      await load()
      await onImagesDeleted?.(res)
      onToast(res.moved > 0 ? `已删除 ${res.moved} 张图片` : '这些图片已经不在了')
    } catch (e) {
      onToast('删除失败')
      console.error(e)
    } finally {
      setBusy(false)
    }
  }, [selected, onToast, onBeforeDelete, onImagesDeleted, load])

  const doPurge = useCallback(async () => {
    const target = purging
    if (!target || !target.noteId) return
    setBusy(true)
    try {
      await onPurgeNote(target.noteId)
      setPurging(null)
      await load()
    } catch (e) {
      onToast('删除笔记失败')
      console.error(e)
    } finally {
      setBusy(false)
    }
  }, [purging, onPurgeNote, load, onToast])

  // Esc 逐层退出；大图预览时左右键翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // 由外到里一层层关：OCR 结果 → 右键菜单 → 备注区 → 大图 → 其他弹层 → 图片库
        if (ocrText !== null) setOcrText(null)
        else if (ctxMenu) setCtxMenu(null)
        else if (previewHash && noteOpen) setNoteOpen(false)
        else if (previewHash) setPreviewHash(null)
        else if (purging) setPurging(null)
        else if (confirming) setConfirming(false)
        else onClose()
        return
      }
      if (!previewHash || ocrText !== null) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        stepPreview(1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        stepPreview(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewHash, noteOpen, purging, confirming, ocrText, ctxMenu, onClose, stepPreview])

  const renderTiles = (list: ImageItem[]) => (
    <div className="lib-grid">
      {list.map((it) => {
        const on = selectedSet.has(it.hash)
        const tip = `${it.width}×${it.height} · ${fmtBytes(it.bytes)}${
          it.usedBy.length ? ` · 被「${it.usedBy.map((u) => u.title).join('」「')}」引用` : ''
        }${it.note ? `\n备注：${it.note}` : ''}`
        return (
          <div
            key={it.hash}
            className={`lib-tile ${on ? 'on' : ''}`}
            title={tip}
            role="checkbox"
            aria-checked={on}
            tabIndex={0}
            onClick={() => toggle(it.hash)}
            onDoubleClick={() => setPreviewHash(it.hash)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggle(it.hash)
              }
            }}
          >
            <img src={fileUrl(it.path)} alt="" loading="lazy" draggable={false} />
            <span className={`lib-check ${on ? 'on' : ''}`}>{on && <CheckIcon />}</span>
            {it.usedBy.length > 0 && <span className="lib-used">被引用</span>}
            {/* 每张图都能直接备注：没备注的图在 hover 时也有入口，不用先进大图 */}
            <button
              className={`lib-annotate ${it.note ? 'has' : ''}`}
              title={it.note ? `备注：${it.note}` : '给这张图加备注'}
              onClick={(e) => {
                e.stopPropagation()
                wantNotePanel.current = true
                setPreviewHash(it.hash)
              }}
            >
              <NoteIcon />
            </button>
            {it.note && (
              <button
                className="lib-hasnote"
                title={`备注：${it.note}`}
                onClick={(e) => {
                  e.stopPropagation()
                  wantNotePanel.current = true
                  setPreviewHash(it.hash)
                }}
              >
                备注
              </button>
            )}
            <button
              className="lib-zoom"
              title="查看大图"
              onClick={(e) => {
                e.stopPropagation()
                wantNotePanel.current = false
                setPreviewHash(it.hash)
              }}
            >
              <ExpandIcon />
            </button>
          </div>
        )
      })}
    </div>
  )

  /** 右键菜单别跑到窗口外面去 */
  const ctxPos = ctxMenu ? clampMenu(ctxMenu.x, ctxMenu.y) : null

  return (
    <div className="lib-backdrop" onClick={onClose}>
      <div className="lib" onClick={(e) => e.stopPropagation()}>
        <div className="lib-head">
          <div className="lib-title">图片库</div>
          <div className="lib-sub">{items ? `${total} 张 · ${fmtBytes(totalBytes)}` : '正在读取…'}</div>
          <div className="spacer" />
          <div className="lib-views" role="tablist" aria-label="查看方式">
            <button
              className={mode === 'time' ? 'on' : ''}
              role="tab"
              aria-selected={mode === 'time'}
              onClick={() => setMode('time')}
              title="所有图片按时间排"
            >
              按时间
            </button>
            <button
              className={mode === 'note' ? 'on' : ''}
              role="tab"
              aria-selected={mode === 'note'}
              onClick={() => setMode('note')}
              title="按引用它的笔记分组"
            >
              按笔记
            </button>
          </div>
          {mode === 'time' && (
            <button
              className="lib-sort"
              onClick={() => setAsc((v) => !v)}
              title="切换时间排序方向"
            >
              {asc ? '最早优先' : '最新优先'}
            </button>
          )}
          <button className="btn" onClick={toggleAll} disabled={total === 0}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <CloseIcon />
          </button>
        </div>

        <div className="lib-body">
          {error && (
            <div className="lib-empty">
              <div>读取图片失败：{error}</div>
              <button className="btn" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
          {!error && items === null && <div className="lib-empty">正在读取…</div>}
          {!error && items !== null && items.length === 0 && (
            <div className="lib-empty">
              还没有图片。
              <br />
              复制一张图，或者往编辑器里粘贴图片，它就会出现在这里。
            </div>
          )}
          {!error && items !== null && items.length > 0 && mode === 'time' && renderTiles(sorted)}
          {!error &&
            items !== null &&
            items.length > 0 &&
            mode === 'note' &&
            groups.map((g) => (
              <section className="lib-group" key={g.key}>
                <header className="lib-group-head">
                  {g.noteId ? (
                    <button
                      className="lib-group-title"
                      onClick={() => {
                        onOpenNote(g.noteId!)
                        onClose()
                      }}
                      title="打开这篇笔记"
                    >
                      {g.title}
                    </button>
                  ) : (
                    <span className="lib-group-title static">{g.title}</span>
                  )}
                  <span className="lib-group-count">{g.items.length} 张</span>
                  <div className="spacer" />
                  {g.noteId && (
                    <button
                      className="mini-danger"
                      onClick={() => setPurging(g)}
                      title="从磁盘上真实删除这篇笔记（不进回收站）"
                    >
                      <TrashIcon />
                      删除笔记
                    </button>
                  )}
                </header>
                {renderTiles(g.items)}
              </section>
            ))}
        </div>

        <div className="lib-foot">
          <div className="lib-selinfo">
            已选 <b>{selected.length}</b> 张
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => setSelected([])} disabled={selected.length === 0 || busy}>
            取消选择
          </button>
          <button
            className="btn"
            onClick={() => {
              onInsert(selectedItems)
              onClose()
            }}
            disabled={selected.length === 0 || busy}
            title="把选中的图片追加到当前笔记末尾"
          >
            插入到笔记
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onCreateNote(selectedItems)
              onClose()
            }}
            disabled={selected.length === 0 || busy}
            title="用选中的图片新建一篇笔记"
          >
            新建笔记
          </button>
          <button
            className="btn danger"
            onClick={() => setConfirming(true)}
            disabled={selected.length === 0 || busy}
          >
            删除选中
          </button>
        </div>

        {confirming && (
          <div className="lib-confirm-layer" onClick={() => setConfirming(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">删除 {selected.length} 张图片？</div>
              <div className="modal-body">
                图片会移到 <code>images/.trash</code>，不会立刻消失。
                {selectedItems.some((it) => it.usedBy.length > 0) && (
                  <>
                    <br />
                    <b>其中有图片正被笔记引用</b>，删掉后笔记正文里的这几张图会一起消失。
                  </>
                )}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                  取消
                </button>
                <button className="btn danger" onClick={doDelete} disabled={busy}>
                  {busy ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          </div>
        )}

        {purging && (
          <div className="lib-confirm-layer" onClick={() => setPurging(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">真实删除这篇笔记？</div>
              <div className="modal-body">
                「{purging.title}」会从磁盘上直接删除，
                <b>不进回收站、也找不回来</b>。
                <br />
                图片本身会留在图片库里（会变成"未引用"）。
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setPurging(null)} disabled={busy}>
                  取消
                </button>
                <button className="btn danger" onClick={doPurge} disabled={busy}>
                  {busy ? '删除中…' : '真实删除'}
                </button>
              </div>
            </div>
          </div>
        )}

        {previewItem && (
          <div
            className={`lib-preview ${noteOpen ? 'with-note' : ''}`}
            onClick={() => setPreviewHash(null)}
          >
            <div className="lib-preview-bar" onClick={(e) => e.stopPropagation()}>
              <span>
                {previewIndex + 1} / {total}
              </span>
              <span className="lib-preview-meta">
                {previewItem.width}×{previewItem.height} · {fmtBytes(previewItem.bytes)}
              </span>
              <div className="spacer" />
              <button
                className={`btn ${noteOpen ? 'on' : ''}`}
                onClick={() => setNoteOpen((v) => !v)}
                title="这张图的备注：不在笔记正文里显示，只在这里和图片右键里改"
              >
                备注{previewItem.note && !noteOpen ? ' •' : ''}
              </button>
              <button
                className="btn"
                onClick={() => {
                  onInsert([previewItem])
                  onClose()
                }}
                title="把这张图追加到当前笔记末尾"
              >
                插入到笔记
              </button>
              <button className="icon-btn" onClick={() => setPreviewHash(null)} title="关闭（Esc）">
                <CloseIcon />
              </button>
            </div>
            <img
              src={fileUrl(previewItem.path)}
              alt=""
              draggable={false}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setCtxMenu({ x: e.clientX, y: e.clientY })
              }}
            />

            {/* 大图右键菜单：目前只有 OCR（后面要加别的就往下排） */}
            {ctxMenu && ctxPos && (
              <div
                className="lib-menu-layer"
                onClick={(e) => {
                  e.stopPropagation()
                  setCtxMenu(null)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCtxMenu(null)
                }}
              >
                <div
                  className="ctx-menu"
                  style={{ left: ctxPos.left, top: ctxPos.top }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="ctx-title">
                    图片 · {previewItem.width}×{previewItem.height}
                  </div>
                  <button
                    className="menu-item"
                    disabled={ocrBusy}
                    title="认出图里的文字（结果可以改，默认存进这张图的备注）"
                    onClick={() => void runOcr()}
                  >
                    {ocrBusy ? '正在识别…' : '识别文字（OCR）'}
                  </button>
                </div>
              </div>
            )}
            {total > 1 && (
              <>
                <button
                  className="lib-nav prev"
                  title="上一张（←）"
                  onClick={(e) => {
                    e.stopPropagation()
                    stepPreview(-1)
                  }}
                >
                  ‹
                </button>
                <button
                  className="lib-nav next"
                  title="下一张（→）"
                  onClick={(e) => {
                    e.stopPropagation()
                    stepPreview(1)
                  }}
                >
                  ›
                </button>
              </>
            )}

            {noteOpen && (
              <div className="lib-note-panel" onClick={(e) => e.stopPropagation()}>
                <div className="lib-note-head">
                  <span>图片备注</span>
                  <span className="lib-note-hint">属于这张图本身 · 编辑页不显示 · 搜索能搜到</span>
                </div>
                <textarea
                  className="modal-textarea lib-note-input"
                  value={noteDraft}
                  autoFocus
                  placeholder="这张图是什么？记一句，以后搜得到…"
                  spellCheck={false}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // 别让 Esc / Ctrl+Enter 冒到图片库的全局快捷键上
                    e.stopPropagation()
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setNoteOpen(false)
                    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      void saveNote()
                    }
                  }}
                />
                <div className="lib-note-actions">
                  <button className="btn" onClick={() => setNoteDraft('')} disabled={noteSaving}>
                    清空
                  </button>
                  <div className="spacer" />
                  <button className="btn" onClick={() => setNoteOpen(false)} disabled={noteSaving}>
                    收起
                  </button>
                  <button className="btn primary" onClick={() => void saveNote()} disabled={noteSaving}>
                    {noteSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            )}

            {/* OCR 结果：和大图一样盖在最上面，改完再决定存不存 */}
            {ocrText !== null && (
              <div className="lib-ocr-layer" onClick={(e) => e.stopPropagation()}>
                <div className="modal wide" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-title">识别出的文字</div>
                  <div className="note-preview">
                    <img src={fileUrl(previewItem.path)} alt="" draggable={false} />
                    <div className="note-preview-hint">
                      识别结果可以随便改（错字、多余空格、断行都能动）。
                      保存后追加进<b>这张图的备注</b>，不进笔记正文；备注在编辑页右键里也看得到、搜得到。
                    </div>
                  </div>
                  <textarea
                    className="modal-textarea ocr-edit"
                    value={ocrText}
                    autoFocus
                    spellCheck={false}
                    placeholder="这里应该已经填好了识别出的文字…"
                    onChange={(e) => setOcrText(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setOcrText(null)
                      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault()
                        void saveOcr()
                      }
                    }}
                  />
                  <div className="modal-actions">
                    <button className="btn" onClick={() => void copyOcr()}>
                      复制
                    </button>
                    <div className="spacer" />
                    <button className="btn" onClick={() => setOcrText(null)}>
                      关闭
                    </button>
                    <button
                      className="btn primary"
                      onClick={() => void saveOcr()}
                      disabled={ocrSaving}
                      title="追加到这张图的备注里（Ctrl+Enter）"
                    >
                      {ocrSaving ? '保存中…' : '存进图片备注'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2">
      <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 备注：一张带几行字的小卡片。 */
function NoteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 4.5h14v11l-4 4H5z" strokeLinejoin="round" />
      <path d="M15 19.5v-4h4M8.5 8.5h7M8.5 12h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M4 7h16M9.5 7V5h5v2M6.5 7l.9 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.5 7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}