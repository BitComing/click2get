import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CaptureBlock, CaptureImage, setDataDir } from './editor/extensions'
import { appendCapture, type Capture } from './editor/insert'

type Theme = 'light' | 'dark'
type NoteMeta = { id: string; title: string; createdAt: number; updatedAt: number }
type NoteFull = NoteMeta & { doc: any; pending: any[] }
type Bootstrap = {
  notes: NoteMeta[]
  settings: {
    monitoring: boolean
    theme: Theme
    lastNoteId: string | null
    sidebarCollapsed: boolean
  }
  dataDir: string
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    invoke<Bootstrap>('bootstrap')
      .then((b) => {
        setDataDir(b.dataDir)
        setBoot(b)
      })
      .catch((e) => setError(String(e)))
  }, [])

  if (error) return <div className="fatal">启动失败：{error}</div>
  if (!boot) return <div className="boot">正在加载…</div>
  return <Workspace boot={boot} />
}

function upsert(list: NoteMeta[], meta: NoteMeta): NoteMeta[] {
  const next = list.some((n) => n.id === meta.id)
    ? list.map((n) => (n.id === meta.id ? meta : n))
    : [meta, ...list]
  return [...next].sort((a, b) => b.updatedAt - a.updatedAt)
}

function Workspace({ boot }: { boot: Bootstrap }) {
  const [notes, setNotes] = useState<NoteMeta[]>(boot.notes)
  const [theme, setTheme] = useState<Theme>(boot.settings.theme)
  const [monitoring, setMonitoring] = useState(boot.settings.monitoring)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(boot.settings.sidebarCollapsed)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState<NoteMeta | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<NoteMeta | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [newCount, setNewCount] = useState(0)
  const [docEmpty, setDocEmpty] = useState(true)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const saveTimer = useRef<number | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const currentIdRef = useRef<string | null>(null)
  const loadingRef = useRef(false)

  const editor = useEditor({
    extensions: [StarterKit, CaptureBlock, CaptureImage],
    content: EMPTY_DOC,
    autofocus: false,
    editorProps: { attributes: { class: 'c2g-editor', spellcheck: 'false' } },
    onUpdate: ({ editor }) => {
      if (loadingRef.current) return
      setDocEmpty(editor.isEmpty)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void persist(editor.getJSON())
      }, 500)
    },
  })

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    currentIdRef.current = currentId
  }, [currentId])

  // 主题：写进 <html data-theme>
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const persist = useCallback(async (doc: any) => {
    const id = currentIdRef.current
    if (!id) return
    try {
      const meta = await invoke<NoteMeta>('save_note', { id, doc })
      setNotes((prev) => upsert(prev, meta))
    } catch {
      /* 保存失败不打断输入，下一次 500ms 会重试 */
    }
  }, [])

  const flushSave = useCallback(async () => {
    const ed = editorRef.current
    const id = currentIdRef.current
    if (!ed || !id) return
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    try {
      const meta = await invoke<NoteMeta>('save_note', { id, doc: ed.getJSON() })
      setNotes((prev) => upsert(prev, meta))
    } catch {
      /* ignore */
    }
  }, [])

  const nearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setNewCount(0)
  }, [])

  const showToast = useCallback((text: string) => setToast({ id: Date.now(), text }), [])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(t)
  }, [toast])

  // 首次进来：恢复上次笔记，没有就新建一篇
  useEffect(() => {
    if (!editor) return
    let cancelled = false
    ;(async () => {
      loadingRef.current = true
      try {
        let list = notes
        let id = boot.settings.lastNoteId
        if (!id || !list.some((n) => n.id === id)) id = list[0]?.id ?? null
        if (!id) {
          const created = await invoke<NoteFull>('create_note')
          if (cancelled) return
          list = upsert(list, created)
          setNotes(list)
          id = created.id
        }
        const full = await invoke<NoteFull>('load_note', { id })
        if (cancelled) return
        setCurrentId(full.id)
        currentIdRef.current = full.id
        editor.commands.setContent(full.doc ?? EMPTY_DOC, { emitUpdate: false })
        setDocEmpty(editor.isEmpty)
        requestAnimationFrame(() => scrollToBottom())
      } finally {
        loadingRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
    // 只在 editor 就绪时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // 捕获事件 → 追加到当前笔记
  useEffect(() => {
    if (!editor) return
    let disposed = false
    const un = listen<Capture>('capture', (e) => {
      if (disposed) return
      const stick = nearBottom()
      appendCapture(editor, e.payload)
      showToast('已记入')
      if (stick) requestAnimationFrame(() => scrollToBottom())
      else setNewCount((n) => n + 1)
    })
    return () => {
      disposed = true
      un.then((f) => f())
    }
  }, [editor, nearBottom, scrollToBottom, showToast])

  // 托盘切换监控：只同步状态，不往笔记里插任何提示
  useEffect(() => {
    const un = listen<boolean>('monitor-changed', (e) => setMonitoring(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // 退出握手：先落盘，再退出
  useEffect(() => {
    const un = listen('flush-save', async () => {
      try {
        await flushSave()
      } finally {
        invoke('quit_app').catch(() => {})
      }
    })
    return () => {
      un.then((f) => f())
    }
  }, [flushSave])

  const switchNote = async (id: string) => {
    if (id === currentIdRef.current) return
    await flushSave()
    const full = await invoke<NoteFull>('load_note', { id })
    loadingRef.current = true
    setCurrentId(full.id)
    currentIdRef.current = full.id
    editorRef.current?.commands.setContent(full.doc ?? EMPTY_DOC, { emitUpdate: false })
    loadingRef.current = false
    setDocEmpty(editorRef.current?.isEmpty ?? true)
    setNewCount(0)
    requestAnimationFrame(() => scrollToBottom())
  }

  const newNote = async () => {
    await flushSave()
    const created = await invoke<NoteFull>('create_note')
    setNotes((prev) => upsert(prev, created))
    setCurrentId(created.id)
    currentIdRef.current = created.id
    loadingRef.current = true
    editorRef.current?.commands.setContent(created.doc ?? EMPTY_DOC, { emitUpdate: false })
    loadingRef.current = false
    setDocEmpty(true)
    setNewCount(0)
    requestAnimationFrame(() => {
      scrollToBottom()
      editorRef.current?.commands.focus('end')
    })
  }

  const toggleMonitoring = async () => {
    const next = await invoke<boolean>('set_monitoring', { on: !monitoring })
    setMonitoring(next)
  }

  const startRename = (n: NoteMeta) => {
    setRenaming(n)
    setRenameDraft(n.title)
  }

  const commitRename = async () => {
    const target = renaming
    setRenaming(null)
    if (!target) return
    const t = renameDraft.trim()
    if (!t || t === target.title) return
    try {
      const meta = await invoke<NoteMeta>('rename_note', { id: target.id, title: t })
      setNotes((prev) => upsert(prev, meta))
    } catch {
      showToast('重命名失败')
    }
  }

  const doDelete = async () => {
    const target = confirmDelete
    setConfirmDelete(null)
    if (!target) return
    try {
      await invoke('delete_note', { id: target.id })
    } catch {
      showToast('删除失败')
      return
    }
    const rest = notes.filter((n) => n.id !== target.id)
    setNotes(rest)
    if (currentIdRef.current !== target.id) return

    // 删的是当前打开的这篇：切到下一篇；没有就新建一篇，别留空壳
    if (rest.length) {
      const full = await invoke<NoteFull>('load_note', { id: rest[0].id })
      setCurrentId(full.id)
      currentIdRef.current = full.id
      loadingRef.current = true
      editorRef.current?.commands.setContent(full.doc ?? EMPTY_DOC, { emitUpdate: false })
      loadingRef.current = false
      setDocEmpty(editorRef.current?.isEmpty ?? true)
    } else {
      const created = await invoke<NoteFull>('create_note')
      setNotes([created])
      setCurrentId(created.id)
      currentIdRef.current = created.id
      loadingRef.current = true
      editorRef.current?.commands.setContent(created.doc ?? EMPTY_DOC, { emitUpdate: false })
      loadingRef.current = false
      setDocEmpty(true)
    }
    setNewCount(0)
  }

  const toggleTheme = async () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    await invoke('set_theme', { theme: next })
  }

  const toggleSidebar = () => {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    invoke('set_sidebar', { collapsed: next }).catch(() => {})
  }

  const copyPath = async () => {
    setMenuOpen(false)
    // 走 Rust 命令：写剪贴板时打上 Click2GetOwned 标记，避免被自己再捕获一次
    try {
      await invoke('copy_with_marker', { text: boot.dataDir })
      showToast('路径已复制')
    } catch {
      showToast('复制失败')
    }
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    const img = files.find((f) => f.type.startsWith('image/'))
    if (!img || !editor) return
    e.preventDefault()
    const b64 = await blobToBase64(img)
    const cap = await invoke<Capture>('save_image_b64', { b64 })
    appendCapture(editor, cap)
    requestAnimationFrame(() => scrollToBottom())
  }

  const currentTitle = notes.find((n) => n.id === currentId)?.title ?? '无标题笔记'

  return (
    <div className="app">
      <aside className={`side ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="side-inner">
          <div className="side-head">Click2Get</div>
          <button className="new-btn" onClick={newNote} title="新建笔记">
            <span className="plus">+</span> 新建笔记
          </button>
          <div className="list">
            {notes.map((n) => (
              <div
                key={n.id}
                className={`item ${n.id === currentId ? 'active' : ''}`}
                onClick={() => switchNote(n.id)}
                onDoubleClick={() => startRename(n)}
                title={n.title}
              >
                {renaming?.id === n.id ? (
                  <span className="item-title renaming-hint">{renameDraft || n.title}</span>
                ) : (
                  <>
                    <span className="item-title">{n.title}</span>
                    <span className="item-actions">
                      <button
                        className="mini"
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation()
                          startRename(n)
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        className="mini"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDelete(n)
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
            {notes.length === 0 && <div className="empty">还没有笔记</div>}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="bar">
          <button
            className="icon-btn"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          >
            <SidebarIcon />
          </button>
          <div className="title">{currentTitle}</div>
          <div className="spacer" />
          <button
            className={`status ${monitoring ? 'on' : 'off'}`}
            onClick={toggleMonitoring}
            title={monitoring ? '点击暂停监控' : '点击恢复监控'}
          >
            <span className="dot" />
            {monitoring ? '监控中' : '已暂停'}
          </button>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === 'light' ? '切换到深色' : '切换到浅色'}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
          <button className="icon-btn" onClick={() => setMenuOpen((v) => !v)} title="更多">
            <MoreIcon />
          </button>
        </header>

        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="menu">
              <div className="menu-path" title={boot.dataDir}>
                {boot.dataDir}
              </div>
              <button className="menu-item" onClick={() => { setMenuOpen(false); invoke('open_data_dir') }}>
                打开数据文件夹
              </button>
              <button className="menu-item" onClick={copyPath}>
                复制存储路径
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { setMenuOpen(false); invoke('hide_window') }}>
                隐藏到托盘
              </button>
              <button
                className="menu-item danger"
                onClick={() => {
                  setMenuOpen(false)
                  void flushSave()
                  invoke('quit_gracefully').catch(() => {})
                }}
              >
                退出 Click2Get
              </button>
            </div>
          </>
        )}

        <div
          className="scroll"
          ref={scrollRef}
          onPaste={onPaste}
          onScroll={() => {
            if (nearBottom() && newCount) setNewCount(0)
          }}
        >
          <EditorContent editor={editor} />
          {docEmpty && <div className="hint">在这里写点什么，或者去别处复制点东西</div>}
        </div>

        {newCount > 0 && (
          <button className="newbar" onClick={() => scrollToBottom(true)}>
            {newCount} 条新捕获 ↓
          </button>
        )}

        {toast && (
          <div className="toast" key={toast.id}>
            {toast.text}
          </div>
        )}

        {confirmDelete && (
          <div className="modal-backdrop" onClick={() => setConfirmDelete(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">删除这篇笔记？</div>
              <div className="modal-body">
                「{confirmDelete.title}」
                <br />
                会移到 <code>notes/.trash</code>，不会立刻消失。
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
                <button className="btn danger" onClick={doDelete}>
                  删除
                </button>
              </div>
            </div>
          </div>
        )}

        {renaming && (
          <div className="modal-backdrop" onClick={() => setRenaming(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">重命名笔记</div>
              <input
                className="modal-input"
                ref={(el) => {
                  // 打开即聚焦并全选，直接敲键盘就是替换
                  if (el) {
                    el.focus()
                    el.select()
                  }
                }}
                value={renameDraft}
                maxLength={80}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setRenaming(null)
                  }
                }}
              />
              <div className="modal-actions">
                <button className="btn" onClick={() => setRenaming(null)}>
                  取消
                </button>
                <button className="btn primary" onClick={commitRename}>
                  确定
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" strokeLinecap="round" />
    </svg>
  )
}

function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.4 5v14" strokeLinecap="round" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5.6" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.4" cy="12" r="1.7" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20z" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h16M9.5 7V5h5v2M6.5 7l.9 12.2A1.8 1.8 0 0 0 9.2 21h5.6a1.8 1.8 0 0 0 1.8-1.8L17.5 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1z" strokeLinejoin="round" />
    </svg>
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}