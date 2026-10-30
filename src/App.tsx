import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CaptureBlock, CaptureImage, setDataDir } from './editor/extensions'
import { appendCapture, appendNotice, type Capture } from './editor/insert'

type Bootstrap = {
  doc: any
  pending: any[]
  monitoring: boolean
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

function Workspace({ boot }: { boot: Bootstrap }) {
  const [monitoring, setMonitoring] = useState(boot.monitoring)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [newCount, setNewCount] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const saveTimer = useRef<number | null>(null)
  const editorRef = useRef<Editor | null>(null)

  const editor = useEditor({
    extensions: [StarterKit, CaptureBlock, CaptureImage],
    content: boot.doc ?? EMPTY_DOC,
    autofocus: false,
    editorProps: {
      attributes: { class: 'c2g-editor', spellcheck: 'false' },
    },
    onUpdate: ({ editor }) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        invoke('save_note', { doc: editor.getJSON() }).catch(() => {})
      }, 500)
    },
  })

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

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

  const showToast = useCallback((text: string) => {
    setToast({ id: Date.now(), text })
  }, [])

  // toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(t)
  }, [toast])

  // 启动后：把 pending（本次预留）合并进文档，并滚到底
  useEffect(() => {
    if (!editor) return
    const pending = boot.pending ?? []
    if (pending.length) {
      const at = editor.state.doc.content.size
      editor.chain().insertContentAt(at, { type: 'doc', content: pending }).run()
    }
    requestAnimationFrame(() => scrollToBottom())
  }, [editor, boot.pending, scrollToBottom])

  // 捕获事件 → 追加 + toast
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

  // 托盘切换监控 → 同步界面状态
  useEffect(() => {
    const un = listen<boolean>('monitor-changed', (e) => {
      const on = e.payload
      setMonitoring(on)
      if (on && editorRef.current) {
        appendNotice(editorRef.current, '监控已恢复')
      }
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  // 退出握手：先把最后编辑落盘，再退出进程
  useEffect(() => {
    const un = listen('flush-save', async () => {
      const ed = editorRef.current
      try {
        if (ed) await invoke('save_note', { doc: ed.getJSON() })
      } finally {
        invoke('quit_app').catch(() => {})
      }
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  const toggleMonitoring = async () => {
    const next = await invoke<boolean>('set_monitoring', { on: !monitoring })
    setMonitoring(next)
    if (next && editor) appendNotice(editor, '监控已恢复')
  }

  // 手动粘贴图片：与监控开关解耦，任何时候都可用
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

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">Click2Get</div>
        <div className="spacer" />
        <button
          className={`status ${monitoring ? 'on' : 'off'}`}
          onClick={toggleMonitoring}
          title={monitoring ? '点击暂停监控' : '点击恢复监控'}
        >
          <span className="dot" />
          {monitoring ? '监控中' : '已暂停'}
        </button>
      </header>

      <div
        className="scroll"
        ref={scrollRef}
        onPaste={onPaste}
        onScroll={() => {
          if (nearBottom() && newCount) setNewCount(0)
        }}
      >
        <EditorContent editor={editor} />
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
    </div>
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