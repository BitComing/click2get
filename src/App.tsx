import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Node as PMDoc } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { CaptureBlock, CaptureImage, TrailingLine, fileUrl, setDataDir } from './editor/extensions'
import { MoveByDrag, type DragContent, type DropOnNote } from './editor/dragMove'
import { cleanCopyText } from './editor/clipboard'
import { findDuplicate, type DupHit } from './editor/dedupe'
import { ImageResize } from './editor/imageResize'
import { ImageSelectMask } from './editor/imageMask'
import { appendCapture, type Capture } from './editor/insert'
import { handleLineKey, selectLineOrAll } from './editor/lineOps'
import { countInlineBreaks, countMergeableRuns, mergeRowsIntoOne, splitInlineBreaks } from './editor/lineBreaks'
import { normalizeDoc } from './editor/normalize'
import { revealImage, revealMatch } from './editor/search'
import {
  clearImageSelection,
  contentWidth,
  deleteImageAt,
  selectImage,
  selectedImagePos,
  setImageWidth,
} from './editor/imageActions'
import ImageLibrary, { type ImageItem } from './ImageLibrary'
import NoteGallery from './NoteGallery'
import BarControls, { persistBarOrder, readBarOrder, type BarId } from './BarControls'
import CollectBox from './CollectBox'
import {
  COLLECT_MAX,
  makeCollectItem,
  readCollectBox,
  writeCollectBox,
  type CollectItem,
} from './editor/collectBox'
import SearchPanel, { type SearchHit } from './SearchPanel'

type Theme = 'light' | 'dark'
type NoteMeta = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 置顶：永远排在列表最前面 */
  pinned?: boolean
}
type NoteFull = NoteMeta & { doc: any; pending: any[] }
type Bootstrap = {
  notes: NoteMeta[]
  settings: {
    monitoring: boolean
    theme: Theme
    lastNoteId: string | null
    sidebarCollapsed: boolean
    sidebarWidth: number
    /** 捕获去重：同一段文字 / 同一张图重复复制时不再记一遍 */
    dedupe: boolean
  }
  dataDir: string
}

/** 图片右键菜单：位置、文档位置、图片 hash（"在图片库中查看"要用）。 */
type ImageMenu = { x: number; y: number; pos: number; hash: string | null }

/** 正文里的文字选区右键菜单：位置 + 选区范围。 */
type TextMenu = { x: number; y: number; from: number; to: number }

/** 图片备注弹层。备注属于图片本身，按 hash 存，跟它出现在哪篇笔记里无关。 */
type ImageNoteEdit = { hash: string; path: string | null }

/** OCR 的结果放在这个弹层里，文字可以直接改，改完写进图片备注。 */
type OcrResult = { hash: string; text: string; path: string | null }

/** 侧栏笔记的右键菜单。 */
type NoteMenu = { x: number; y: number; id: string }

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

/** 侧栏宽度范围，与 Rust 侧 settings::MIN/MAX_SIDEBAR_WIDTH 一致。 */
const MIN_SIDE = 170
const MAX_SIDE = 520

/** 侧栏顺序：置顶最前，其余按最近更新倒序（与 Rust 的 storage::sort_metas 对齐）。 */
function sortNotes(list: NoteMeta[]): NoteMeta[] {
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

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
  return sortNotes(next)
}

/** 右键菜单别跑到窗口外面去。 */
function clampMenu(x: number, y: number, width = 200, height = 196) {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  }
}

/**
 * 从正文里删掉拖起来的那几行。
 * 整篇都被拖走了就换成一个空段落（doc 的 content 是 block+，不能是空的）。
 */
function removeRange(ed: Editor, from: number, to: number) {
  const tr = ed.state.tr
  if (from === 0 && to >= ed.state.doc.content.size) {
    tr.replaceWith(0, ed.state.doc.content.size, ed.state.schema.nodes.paragraph.create())
  } else {
    tr.delete(from, to)
  }
  ed.view.dispatch(tr.scrollIntoView())
}

/** "便签条"宽度：再窄侧栏就没地方待了，自动收起（窗口最小 220px，见 tauri.conf.json）。 */
const NARROW_W = 560

/**
 * 悬浮侧栏收回：在 fixed 状态里播完 peekout 动画（styles.css 里 130ms）再撤出布局。
 * 这里多留 20ms 余量——动画是从 React 把 class 画上去之后才开始的，
 * 掐得太准会在淡出没播完时就把浮层拿掉，看着像闪了一下。
 */
const PEEK_OUT_MS = 150

/**
 * 把编辑器里选中的一段内容变成一篇独立文档的 JSON。
 *
 * `doc.slice()` 切出来的是 Fragment：选的是整段就是块节点，选的是半句就是行内节点。
 * 行内片段（还有夹在块之间的那截）要自己包一层段落，否则拼出来的 doc 不合 schema。
 */
function sliceToDoc(doc: PMDoc, from: number, to: number): any | null {
  const slice = doc.slice(from, to)
  const nodes: any[] = []
  let inline: any[] = []
  const flush = () => {
    if (inline.length === 0) return
    nodes.push({ type: 'paragraph', content: inline })
    inline = []
  }
  slice.content.forEach((n) => {
    if (n.isInline) {
      inline.push(n.toJSON())
      return
    }
    flush()
    nodes.push(n.toJSON())
  })
  flush()
  if (nodes.length === 0) return null
  return { type: 'doc', content: nodes }
}

function Workspace({ boot }: { boot: Bootstrap }) {
  const [notes, setNotes] = useState<NoteMeta[]>(sortNotes(boot.notes))
  const [theme, setTheme] = useState<Theme>(boot.settings.theme)
  const [monitoring, setMonitoring] = useState(boot.settings.monitoring)
  /** 捕获去重（默认开）：同样的内容重复复制，不再记第二遍 */
  const [dedupe, setDedupe] = useState(boot.settings.dedupe ?? true)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(boot.settings.sidebarCollapsed)
  /** 侧栏收起时，鼠标停在图标上浮出来的临时侧栏（点图标固定，移开就收） */
  const [sidePeek, setSidePeek] = useState(false)
  /** 浮层正在播放"收回"动画：这期间它还是 position:fixed，正文不受影响 */
  const [sidePeekClosing, setSidePeekClosing] = useState(false)
  /** 浮层刚交回布局的那一小会儿：关掉 .side 的过渡，别让 width 带着正文缩 */
  const [sidePeekSettle, setSidePeekSettle] = useState(false)
  const [sideWidth, setSideWidth] = useState(
    Math.min(MAX_SIDE, Math.max(MIN_SIDE, boot.settings.sidebarWidth || 236)),
  )
  const [sideDragging, setSideDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryHash, setLibraryHash] = useState<string | null>(null)
  const [imgMenu, setImgMenu] = useState<ImageMenu | null>(null)
  const [textMenu, setTextMenu] = useState<TextMenu | null>(null)
  const [noteMenu, setNoteMenu] = useState<NoteMenu | null>(null)
  const [noteEdit, setNoteEdit] = useState<ImageNoteEdit | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [ocr, setOcr] = useState<OcrResult | null>(null)
  const [ocrSaving, setOcrSaving] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** 平铺笔记预览页（所有笔记铺成一页正方形卡片） */
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [renaming, setRenaming] = useState<NoteMeta | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 重命名窗口的输入框：只在打开那一刻聚焦一次，别每次重画都抢选区 */
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  /** 标题栏就地改名：点标题进入，Enter / 点别处保存，Esc 放弃 */
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<NoteMeta | null>(null)
  /** 多选批量删除：待确认的 id 列表 */
  const [confirmBatch, setConfirmBatch] = useState<string[] | null>(null)
  /** 侧栏多选：picked 里的笔记会被批量操作 */
  const [picked, setPicked] = useState<string[]>([])
  const [multi, setMulti] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [newCount, setNewCount] = useState(0)
  const [docEmpty, setDocEmpty] = useState(true)
  /** 标题栏四个控件的顺序（长按拖动可改，存在本地） */
  const [barOrder, setBarOrder] = useState<BarId[]>(() => readBarOrder())
  /** 收纳箱：拖动时先放在这儿的内容（可以跨笔记攒，点一下放到光标处） */
  const [collect, setCollect] = useState<CollectItem[]>(readCollectBox)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const saveTimer = useRef<number | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const currentIdRef = useRef<string | null>(null)
  const loadingRef = useRef(false)
  const notesRef = useRef<NoteMeta[]>(boot.notes)
  /** 去重开关的最新值：捕获监听只订阅一次，闭包里要能读到当前设置 */
  const dedupeRef = useRef(dedupe)
  /** 正文有没有真改过：没改就不保存，免得把侧栏顺序搅乱 */
  const dirtyRef = useRef(false)
  /** 长按把图拖到侧栏笔记上时的处理函数（ImageDrag 只在初始化时拿到一次闭包） */
  const dropOnNoteRef = useRef<(info: DropOnNote) => void>(() => {})
  /** 拖到「新建笔记」/ 垃圾图标 / 收纳箱上的处理函数（同样只在初始化时拿一次闭包） */
  const dragTargetRef = useRef<{
    newNote: (info: DragContent) => void
    trash: (info: DragContent) => void
    tray: (info: DragContent) => void
  }>({ newNote: () => {}, trash: () => {}, tray: () => {} })
  /** 侧栏拖宽用的起点 */
  const sideDragRef = useRef({ x: 0, width: 0 })

  const showToast = useCallback((text: string) => setToast({ id: Date.now(), text }), [])

  /** 收纳箱的最新一份：拖动回调、点按回调都只拿一次闭包，读写一律走这个 ref。 */
  const collectRef = useRef<CollectItem[]>(collect)

  /**
   * 写收纳箱（并同步内存里的那份）。
   *
   * **先落 localStorage 再动正文**：存不进去（本地存储满 / 被禁用）就返回 false，
   * 调用方据此放弃这次收集 —— 内容还老老实实待在正文里，不会出现"删了却没存上"。
   */
  const saveCollect = useCallback((next: CollectItem[]): boolean => {
    if (!writeCollectBox(next)) return false
    collectRef.current = next
    setCollect(next)
    return true
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(t)
  }, [toast])

  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  useEffect(() => {
    dedupeRef.current = dedupe
  }, [dedupe])

  /** 链接一律交给系统默认浏览器，WebView 自己绝不做导航。 */
  const openExternal = useCallback(
    (url: string) => {
      invoke('open_url', { url }).catch(() => showToast('打不开这个链接'))
    },
    [showToast],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 默认的 trailingNode 会在文档末尾永远挂一个空段落、
        // 删掉又补回来（"删一行多一行"的一半原因）。换成只处理图片收尾的 TrailingLine。
        trailingNode: false,
        link: {
          // 点击由 handleClick 接管（走系统浏览器），
          // 否则 WebView 会真的去导航，整个应用被换成网页。
          // enableClickSelection 必须关掉：它一开，Link 插件自己就把点击吃掉
          // （只把链接文字选中），编辑器的 handleClick 根本轮不到。
          openOnClick: false,
          enableClickSelection: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null, class: null },
        },
      }),
      CaptureBlock,
      CaptureImage,
      TrailingLine,
      // 长按拖动：图 / 选中的多行都能拖。落点在正文里 = 换位置；
      // 落在侧栏的笔记上 = 把那几行（或那张图）搬进那篇笔记；
      // 落在收纳箱上 = 先收着，等会儿放到光标处
      MoveByDrag.configure({
        onDropOnNote: (info) => dropOnNoteRef.current(info),
        onDropOnNewNote: (info) => dragTargetRef.current.newNote(info),
        onDropOnTrash: (info) => dragTargetRef.current.trash(info),
        onDropOnTray: (info) => dragTargetRef.current.tray(info),
        isSourceNote: (id) => id === currentIdRef.current,
      }),
      ImageResize,
      // 选中图片时的浅蓝色遮罩：图片是 <img>，浏览器不会像文字那样给它画选区底色
      ImageSelectMask,
    ],
    content: EMPTY_DOC,
    autofocus: false,
    editorProps: {
      attributes: { class: 'c2g-editor', spellcheck: 'false' },
      // 复制出去的纯文本不带完全空行：空段落 / 块边界产生的那些空行不是内容。
      // 行内有字的换行照留（见 editor/clipboard.ts）。
      clipboardTextSerializer: (slice) =>
        cleanCopyText(slice.content.textBetween(0, slice.content.size, '\n', '\n')),
      // 链接：点一下就开浏览器（编辑器里选链接文字的意义不大，导航却会毁掉窗口）
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement | null)?.closest?.('a[href]') as
          | HTMLAnchorElement
          | null
        if (!a) return false
        const href = a.getAttribute('href') ?? ''
        if (!href) return false
        event.preventDefault()
        openExternal(href)
        return true
      },
      // 行级编辑：Backspace / Delete 一次并掉一行，Enter 在原地拆行，
      // 绝不把捕获块拆开搬来搬去（细节见 editor/lineOps.ts）。
      // 选中的是图片时，Backspace / Delete 直接删掉这张图。
      handleKeyDown: (view, event) => {
        // 229 = 输入法正在组词（Windows 上有时 isComposing 是 false，keyCode 还是 229）
        if (event.isComposing || event.keyCode === 229) return false
        // Ctrl+A：第一下选这一行，再按一下才全选（见 lineOps.selectLineOrAll）
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === 'a'
        ) {
          const next = selectLineOrAll(view.state)
          if (next === undefined) return false
          if (next) view.dispatch(next)
          event.preventDefault()
          return true
        }
        const key = event.key
        if (key !== 'Backspace' && key !== 'Delete' && key !== 'Enter') return false
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
        if (key !== 'Enter') {
          const pos = selectedImagePos(view)
          if (pos >= 0) {
            const done = deleteImageAt(view, pos)
            if (done) event.preventDefault()
            return done
          }
        }
        const handled = handleLineKey(view, key)
        if (handled) event.preventDefault()
        return handled
      },
    },
    onUpdate: ({ editor }) => {
      if (loadingRef.current) return
      dirtyRef.current = true
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

  /** 侧栏当前是开着还是收着（窗口变窄时要用最新值判断，不能闭包捕获旧 state）。 */
  const collapsedRef = useRef(sidebarCollapsed)
  useEffect(() => {
    collapsedRef.current = sidebarCollapsed
  }, [sidebarCollapsed])

  /**
   * 窗口拉得很窄（便签条形态）时，左栏自动收起，把宽度全让给正文。
   * 只收不放：用户自己展开回去，说明他就想这么用，不再跟他抢。
   */
  useEffect(() => {
    const check = () => {
      if (window.innerWidth >= NARROW_W || collapsedRef.current) return
      setSidebarCollapsed(true)
      collapsedRef.current = true
      invoke('set_sidebar', { collapsed: true }).catch(() => {})
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /** 保存失败后重试了几次（成功就归零，用来算退避与"只提示一次"）。 */
  const retryRef = useRef(0)
  /** persist 自己：退避重试要能再调一次，而 useCallback 的闭包里拿不到自己。 */
  const persistRef = useRef<(doc: any) => Promise<boolean>>(async () => false)

  /**
   * 落盘当前这篇笔记，返回是否成功。
   *
   * 失败不能只把 dirty 标记置回去就完事 —— 那等于把改动赌在"用户接下来还会不会再敲一个字"
   * 上，切笔记 / 关窗口时就直接丢了（见 issue #7）。这里排一次带退避的重试
   * （500ms → 1s → 2s…，最多 8s），第一次失败告诉用户，后面的重试不再刷屏。
   */
  const persist = useCallback(
    async (doc: any): Promise<boolean> => {
      const id = currentIdRef.current
      if (!id) return false
      // 先清标记：保存期间用户又敲字，onUpdate 会把它重新置上
      dirtyRef.current = false
      try {
        const meta = await invoke<NoteMeta>('save_note', { id, doc })
        setNotes((prev) => upsert(prev, meta))
        retryRef.current = 0
        return true
      } catch {
        dirtyRef.current = true
        const attempt = (retryRef.current += 1)
        if (attempt === 1) showToast('保存失败，正在重试…')
        const delay = Math.min(500 * 2 ** (attempt - 1), 8000)
        if (saveTimer.current) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null
          const ed = editorRef.current
          // 中途切了笔记 / 删了笔记：这一轮重试作废（onUpdate 会给新笔记另排一次）
          if (!ed || !currentIdRef.current || !dirtyRef.current) return
          void persistRef.current(ed.getJSON())
        }, delay)
        return false
      }
    },
    [showToast],
  )

  useEffect(() => {
    persistRef.current = persist
  }, [persist])

  /**
   * 切笔记 / 退出前的那一次落盘：返回是否存上了。
   *
   * 失败会立刻再试一次（这一次是同步等结果的），还不行就如实返回 false，
   * 让调用方决定要不要提醒用户 —— 而不是悄悄地丢。
   */
  const flushSave = useCallback(async (): Promise<boolean> => {
    const ed = editorRef.current
    const id = currentIdRef.current
    if (!ed || !id) return true
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // 没改过就别存：save_note 会刷新 updatedAt，把这篇笔记顶到侧栏最上面
    if (!dirtyRef.current) return true
    dirtyRef.current = false
    for (let i = 0; i < 2; i++) {
      try {
        const meta = await invoke<NoteMeta>('save_note', { id, doc: ed.getJSON() })
        setNotes((prev) => upsert(prev, meta))
        retryRef.current = 0
        return true
      } catch {
        dirtyRef.current = true
      }
    }
    return false
  }, [])

  /** 删笔记 / 切笔记前把待保存的定时器掐掉，不然删完又会被写回来。 */
  const cancelPendingSave = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    dirtyRef.current = false
    // 连退避重试一起取消：笔记都删了，重试再跑一次会把它又写回磁盘（见 issue #7）
    retryRef.current = 0
  }, [])

  /**
   * 捕获去重命中：只提示，不动光标。
   *
   * 用户很可能正在别处写字，这时候把光标抢到那条重复内容上，比多记一条还烦人。
   * 所以只在"原件正好在视野里"时闪一下，看不见就只弹一句提示。
   */
  const revealDuplicate = useCallback(
    (hit: DupHit) => {
      const ed = editorRef.current
      if (ed) {
        const dom = ed.view.nodeDOM(hit.from) as HTMLElement | null
        const box = scrollRef.current?.getBoundingClientRect()
        const r = dom?.getBoundingClientRect?.()
        const visible = !!(r && box && r.bottom > box.top && r.top < box.bottom)
        if (dom && visible) {
          dom.classList.remove('c2g-dup-flash')
          void dom.offsetWidth
          dom.classList.add('c2g-dup-flash')
          window.setTimeout(() => dom.classList.remove('c2g-dup-flash'), 1400)
        }
      }
      showToast(
        hit.kind === 'image' ? '这张图已经在笔记里了，跳过' : '这段内容已经在笔记里了，跳过',
      )
    },
    [showToast],
  )

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

  /** 把一篇笔记灌进编辑器（切笔记 / 新建 / 图片库建笔记都走这里）。
   *  scrollToEnd=false 用于搜索结果跳转：让 revealMatch 自己把命中处滚到眼前。 */
  const showNote = useCallback(
    (full: NoteFull, scrollToEnd = true) => {
      setCurrentId(full.id)
      currentIdRef.current = full.id
      const ed = editorRef.current
      // 换笔记了：上一篇没排完的保存 / 退避重试一律作废，别把旧内容写进新笔记
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      retryRef.current = 0
      loadingRef.current = true
      // normalizeDoc：把旧笔记里被 lift 到块外的段落收回归属，行的行为才一致
      ed?.commands.setContent(normalizeDoc(full.doc ?? EMPTY_DOC), { emitUpdate: false })
      // setContent 会把上一篇的选区尽量留着：上一篇选中的是图片的话，
      // 新笔记里同一位置也变成"选中图片"，虚框和 Delete 都会跟过来。回到正文开头。
      try {
        ed?.commands.setTextSelection(1)
      } catch {
        /* 文档结构特殊就算了，不影响读写 */
      }
      loadingRef.current = false
      dirtyRef.current = false
      setDocEmpty(ed?.isEmpty ?? true)
      setNewCount(0)
      if (scrollToEnd) requestAnimationFrame(() => scrollToBottom())
    },
    [scrollToBottom],
  )

  /**
   * 打开图片备注弹层（右键菜单 / 双击图片）。
   *
   * 备注按 hash 存在图片旁边：同一张图在两篇笔记里看到的是同一份备注，
   * 图片库里改的也是它。编辑页默认不展示备注，所以这里是"要看才点开"的入口。
   */
  const openNoteEditor = useCallback(
    async (pos: number) => {
      const ed = editorRef.current
      if (!ed) return
      const node = ed.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'image') return
      const hash = String(node.attrs.hash ?? '')
      if (!hash) {
        showToast('这张图没有本地文件，存不了备注')
        return
      }
      // 弹层一开就把虚线框收掉，免得它留在弹层背后
      clearImageSelection(ed.view)
      let note = ''
      try {
        note = await invoke<string>('get_image_note', { hash })
      } catch {
        /* 读不到就当没备注，不影响接着写 */
      }
      setNoteEdit({ hash, path: (node.attrs.path as string) ?? null })
      setNoteDraft(note)
    },
    [showToast],
  )

  /**
   * 长按把内容拖到侧栏的另一篇笔记上：从当前笔记里删掉，追加到目标笔记末尾。
   * 能拖两样东西：一张图（追加成一行），或者选中的几行（整块搬过去）。
   *
   * 先把目标那边写好，再删这边 —— 中途失败最多是"没搬成"，不会把内容弄丢。
   * 图片文件是内容寻址的，两篇笔记引用同一张图不会多占空间。
   */
  const moveToNote = useCallback(
    async (info: DropOnNote) => {
      const ed = editorRef.current
      const target = notesRef.current.find((n) => n.id === info.noteId)
      if (!ed || !target) return
      if (info.noteId === currentIdRef.current) {
        showToast('内容已经在这篇笔记里了')
        return
      }

      if (info.kind === 'image') {
        const node = ed.state.doc.nodeAt(info.srcPos)
        if (!node || node.type.name !== 'image' || String(node.attrs.hash ?? '') !== info.hash) {
          showToast('图片位置变了，再拖一次')
          return
        }
        try {
          const meta = await invoke<NoteMeta>('append_image_to_note', {
            id: info.noteId,
            path: info.path,
            hash: info.hash,
            w: info.w || null,
            h: info.h || null,
          })
          setNotes((prev) => upsert(prev, meta))
          const still = ed.state.doc.nodeAt(info.srcPos)
          if (
            still &&
            still.type.name === 'image' &&
            String(still.attrs.hash ?? '') === info.hash
          ) {
            deleteImageAt(ed.view, info.srcPos)
          }
          showToast(`已移到「${meta.title}」`)
        } catch (e) {
          console.error(e)
          showToast('转移失败，图片还在这篇笔记里')
        }
        return
      }

      // 多行文字：目标那边写成功之后，再校验这边还是原来的那几行，然后删
      try {
        const meta = await invoke<NoteMeta>('append_blocks_to_note', {
          id: info.noteId,
          blocks: info.blocks,
        })
        setNotes((prev) => upsert(prev, meta))
        const now = ed.state.doc.slice(info.from, info.to).content.toJSON()
        if (JSON.stringify(now) !== JSON.stringify(info.blocks)) {
          // 拖的过程中这边被改过（比如刚好来了一条捕获）：不冒险删错行
          showToast(`已复制到「${meta.title}」，但原处有新变化，请手动删掉`)
          return
        }
        ed.view.dispatch(ed.state.tr.delete(info.from, info.to))
        await persist(ed.getJSON())
        showToast(`已移到「${meta.title}」`)
      } catch (e) {
        console.error(e)
        showToast('转移失败，内容还在这篇笔记里')
      }
    },
    [persist, showToast],
  )

  useEffect(() => {
    dropOnNoteRef.current = (info) => void moveToNote(info)
  }, [moveToNote])

  /**
   * 把被拖起来的内容搬进**一篇新笔记**（落点是侧栏的「新建笔记」）。
   *
   * 和 moveToNote 一个顺序：先把新笔记写好，再删这边 —— 中途失败最多是"没搬成"，
   * 内容不会丢。搬完留在当前笔记里（不跳过去），侧栏最上面就是那篇新笔记。
   */
  const moveToNewNote = useCallback(
    async (info: DragContent) => {
      const ed = editorRef.current
      if (!ed) return
      try {
        const created = await invoke<NoteFull>('create_note')
        let meta: NoteMeta
        if (info.kind === 'image') {
          const node = ed.state.doc.nodeAt(info.srcPos)
          if (!node || node.type.name !== 'image') {
            showToast('图片位置变了，再拖一次')
            return
          }
          const doc = {
            type: 'doc',
            content: [
              {
                type: 'captureBlock',
                attrs: { ts: Date.now() },
                content: [{ type: 'paragraph', content: [node.toJSON()] }],
              },
            ],
          }
          meta = await invoke<NoteMeta>('save_note', { id: created.id, doc })
          setNotes((prev) => upsert(prev, meta))
          // 写成功之后再校验这边还是那张图（拖动期间可能刚好来了新捕获）
          const still = ed.state.doc.nodeAt(info.srcPos)
          if (
            still &&
            still.type.name === 'image' &&
            String(still.attrs.hash ?? '') === info.hash
          ) {
            deleteImageAt(ed.view, info.srcPos)
          }
        } else {
          const now = ed.state.doc.slice(info.from, info.to).content.toJSON()
          if (JSON.stringify(now) !== JSON.stringify(info.blocks)) {
            showToast('内容有变化，再拖一次')
            return
          }
          const doc = { type: 'doc', content: info.blocks }
          meta = await invoke<NoteMeta>('save_note', { id: created.id, doc })
          setNotes((prev) => upsert(prev, meta))
          ed.view.dispatch(ed.state.tr.delete(info.from, info.to))
          await persist(ed.getJSON())
        }
        showToast(`已移到新笔记「${meta.title}」`)
      } catch (e) {
        console.error(e)
        showToast('移到新笔记失败')
      }
    },
    [persist, showToast],
  )

  /** 落点是垃圾图标：删掉这部分内容（图 / 选中的几行）。 */
  const deleteDragged = useCallback(
    async (info: DragContent) => {
      const ed = editorRef.current
      if (!ed) return
      if (info.kind === 'image') {
        const node = ed.state.doc.nodeAt(info.srcPos)
        if (!node || String(node.attrs.hash ?? '') !== info.hash) {
          showToast('内容位置变了，再拖一次')
          return
        }
        deleteImageAt(ed.view, info.srcPos)
        showToast('已删除')
        return
      }
      const now = ed.state.doc.slice(info.from, info.to).content.toJSON()
      if (JSON.stringify(now) !== JSON.stringify(info.blocks)) {
        showToast('内容位置变了，再拖一次')
        return
      }
      removeRange(ed, info.from, info.to)
      await persist(ed.getJSON())
      showToast('已删除')
    },
    [persist, showToast],
  )

  /**
   * 落点是收纳箱：**先把内容记进箱子，再从正文里删掉**。
   *
   * 顺序是重点：先删再存的话，中间任何一步失败内容就真没了；
   * 现在最坏是"箱子里多一份、正文里还留着"，用户再拖一次或手动删掉都行。
   * 箱子里存的是块级 JSON，图片节点只带路径和 hash，图片文件本身不动。
   */
  const collectDragged = useCallback(
    async (info: DragContent) => {
      const ed = editorRef.current
      if (!ed) return
      const noteId = currentIdRef.current

      let blocks: any[] | null = null
      if (info.kind === 'image') {
        const node = ed.state.doc.nodeAt(info.srcPos)
        if (!node || node.type.name !== 'image' || String(node.attrs.hash ?? '') !== info.hash) {
          showToast('内容位置变了，再拖一次')
          return
        }
        // 和搬进新笔记一样：一张图落地就是一个段落（图是行内节点，必须挂在段落里）
        blocks = [{ type: 'paragraph', content: [node.toJSON()] }]
      } else {
        const now = ed.state.doc.slice(info.from, info.to).content.toJSON()
        if (JSON.stringify(now) !== JSON.stringify(info.blocks)) {
          showToast('内容位置变了，再拖一次')
          return
        }
        blocks = info.blocks
      }

      const item = makeCollectItem({
        blocks,
        noteId,
        noteTitle: notesRef.current.find((n) => n.id === noteId)?.title ?? '无标题笔记',
      })
      const next = [item, ...collectRef.current].slice(0, COLLECT_MAX)
      if (!saveCollect(next)) {
        showToast('收纳箱没存进去（本地存储满了）')
        return
      }

      // 存好了，正文里那一份才删
      if (info.kind === 'image') deleteImageAt(ed.view, info.srcPos)
      else removeRange(ed, info.from, info.to)
      await persist(ed.getJSON())
      showToast(
        next.length > 1
          ? `已收进收纳箱 · 共 ${next.length} 项`
          : '已收进收纳箱 · 把它放到光标处',
      )
    },
    [persist, saveCollect, showToast],
  )

  /**
   * 把收纳箱里的一条放到**当前光标处**（插完就从箱子里拿走 —— 它是"暂存"，不是收藏）。
   * 内容本身还是那几块，插进来之后和手打的一样，能接着改。
   */
  const insertCollectItem = useCallback(
    async (item: CollectItem) => {
      const ed = editorRef.current
      if (!ed) return
      const at = ed.state.selection.from
      const ok = ed.chain().focus().insertContentAt(at, item.blocks).run()
      if (!ok) {
        showToast('这儿放不下这些内容，换个位置再试')
        return
      }
      const rest = collectRef.current.filter((i) => i.id !== item.id)
      saveCollect(rest)
      await persist(ed.getJSON())
      showToast(rest.length > 0 ? `已放到光标处 · 还剩 ${rest.length} 项` : '已放到光标处 · 收纳箱空了')
    },
    [persist, saveCollect, showToast],
  )

  /**
   * 收纳箱里的全部内容，一次放到光标处。
   *
   * 放出来的顺序 = **收进来的先后**：攒了三行 A、B、C，就该原样排成 A、B、C。
   * 列表是倒着显示的（刚收的那条在最上面，一眼能看到），所以这里要反过来取一遍 ——
   * 直接按列表顺序插，攒 A、B、C 放出来会变成 C、B、A。
   */
  const insertAllCollected = useCallback(async () => {
    const ed = editorRef.current
    const items = collectRef.current
    if (!ed || items.length === 0) return
    const blocks = [...items].reverse().flatMap((i) => i.blocks)
    const at = ed.state.selection.from
    const ok = ed.chain().focus().insertContentAt(at, blocks).run()
    if (!ok) {
      showToast('这儿放不下这些内容，换个位置再试')
      return
    }
    saveCollect([])
    await persist(ed.getJSON())
    showToast(`已按收进来的顺序放入 ${items.length} 项`)
  }, [persist, saveCollect, showToast])

  const removeCollectItem = useCallback(
    (id: string) => {
      saveCollect(collectRef.current.filter((i) => i.id !== id))
    },
    [saveCollect],
  )

  const clearCollect = useCallback(() => {
    saveCollect([])
    showToast('收纳箱已清空')
  }, [saveCollect, showToast])

  useEffect(() => {
    dragTargetRef.current = {
      newNote: (info) => void moveToNewNote(info),
      trash: (info) => void deleteDragged(info),
      tray: (info) => void collectDragged(info),
    }
  }, [moveToNewNote, deleteDragged, collectDragged])

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
        editor.commands.setContent(normalizeDoc(full.doc ?? EMPTY_DOC), { emitUpdate: false })
        setDocEmpty(editor.isEmpty)
        requestAnimationFrame(() => scrollToBottom())
      } finally {
        loadingRef.current = false
        dirtyRef.current = false
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
      const cap = e.payload
      // 去重放在"进笔记之前"：同一段文字 / 同一张图，笔记里已经有一份就不再记
      if (dedupeRef.current) {
        const dup = findDuplicate(editor.state.doc, cap)
        if (dup) {
          revealDuplicate(dup)
          return
        }
      }
      const stick = nearBottom()
      appendCapture(editor, cap)
      showToast('已记入')
      if (stick) requestAnimationFrame(() => scrollToBottom())
      else setNewCount((n) => n + 1)
    })
    return () => {
      disposed = true
      un.then((f) => f())
    }
  }, [editor, nearBottom, revealDuplicate, scrollToBottom, showToast])

  // 托盘切换监控：只同步状态，不往笔记里插任何提示
  useEffect(() => {
    const un = listen<boolean>('monitor-changed', (e) => setMonitoring(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // 主题在别处被改（比如以后从托盘弹窗切），这边跟着换
  useEffect(() => {
    const un = listen<string>('theme-changed', (e) =>
      setTheme(e.payload === 'dark' ? 'dark' : 'light'),
    )
    return () => {
      un.then((f) => f())
    }
  }, [])

  // 退出握手：先落盘，再退出。存不上也要让用户知道（Rust 侧 800ms 后无论如何会退出，
  // 所以这里至少把那句实话弹出来 + 留一条日志）
  useEffect(() => {
    const un = listen('flush-save', async () => {
      try {
        const ok = await flushSave()
        if (!ok) {
          console.error('退出前落盘失败：最后一次改动没能写进磁盘')
          showToast('还有改动没存上，请检查数据目录能否写入')
        }
      } finally {
        invoke('quit_app').catch(() => {})
      }
    })
    return () => {
      un.then((f) => f())
    }
  }, [flushSave, showToast])

  const switchNote = async (id: string) => {
    if (id === currentIdRef.current) return
    const saved = await flushSave()
    if (!saved) {
      // 这边没存上就切走 = 那几百毫秒的改动直接丢。宁可停在这儿，让用户再按一次。
      showToast('这篇还没存上，先别切走（正在重试）')
      void persistRef.current(editorRef.current?.getJSON())
      return
    }
    const full = await invoke<NoteFull>('load_note', { id })
    showNote(full)
  }

  /** 搜索结果：正文命中就选中那行字；图片备注命中就选中那张图。 */
  const openSearchHit = async (hit: SearchHit, query: string) => {
    setSearchOpen(false)
    // 图还在、但不属于任何笔记：直接去图片库看它（备注在那儿改）
    if (hit.kind === 'image' && hit.hash && !hit.id) {
      openLibrary(hit.hash)
      return
    }
    try {
      if (hit.id !== currentIdRef.current) {
        await flushSave()
        const full = await invoke<NoteFull>('load_note', { id: hit.id })
        showNote(full, false)
      }
      const ed = editorRef.current
      if (!ed) return
      requestAnimationFrame(() => {
        const ok =
          hit.kind === 'image' && hit.hash
            ? revealImage(ed, hit.hash)
            : revealMatch(ed, query)
        // 标题命中但正文里没有这个词时，退回"只打开笔记"
        if (!ok) showToast(hit.kind === 'image' ? '这张图已经不在笔记里了' : '已打开笔记')
      })
    } catch {
      showToast('打不开这篇笔记')
    }
  }

  // Ctrl+F 打开搜索（ProseMirror 自己不吃这个组合键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const newNote = async () => {
    await flushSave()
    const created = await invoke<NoteFull>('create_note')
    setNotes((prev) => upsert(prev, created))
    showNote(created)
    setDocEmpty(true)
    requestAnimationFrame(() => editorRef.current?.commands.focus('end'))
  }

  // 托盘右键「新建笔记」：复用侧栏按钮的同一条流程（先落盘再建新篇）
  const newNoteRef = useRef(newNote)
  useEffect(() => {
    newNoteRef.current = newNote
  })
  useEffect(() => {
    const un = listen('new-note', () => {
      void newNoteRef.current()
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  const toggleMonitoring = async () => {
    const next = await invoke<boolean>('set_monitoring', { on: !monitoring })
    setMonitoring(next)
  }

  /** 捕获去重开关：关掉之后，同样的内容再复制一次也会照记。 */
  const toggleDedupe = async () => {
    const next = !dedupe
    setDedupe(next)
    dedupeRef.current = next
    try {
      await invoke<boolean>('set_dedupe', { on: next })
    } catch {
      setDedupe(!next)
      dedupeRef.current = !next
      showToast('去重开关没保存上')
    }
  }

  const startRename = (n: NoteMeta) => {
    setRenaming(n)
    setRenameDraft(n.title)
  }

  /**
   * 重命名窗口打开时：聚焦 + 光标放到末尾。
   *
   * **不能**用 `ref={(el) => el.select()}` 那种写法：内联回调每次重画都会重新跑，
   * 用户刚敲一个字、React 一重画，整段文字就又被全选上 —— 下一个字直接替换全部，
   * 根本没法改。所以只在"打开了哪一篇"变化时做一次。
   */
  useEffect(() => {
    if (!renaming) return
    const el = renameInputRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    try {
      el.setSelectionRange(end, end)
    } catch {
      /* 个别环境不支持就算了，至少焦点是对的 */
    }
  }, [renaming])

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

  // ── 标题栏里就地改名 ────────────────────────────────

  /**
   * 点标题就在原地改，不再弹一层框。
   *
   * 几个细节：
   * - 改的是**进入编辑时那一篇**（`titleEditId`），切笔记时 blur 不会改到新笔记上；
   * - Enter 保存、Esc 放弃、点别处 = 保存；
   * - `titleDone` 挡住"Enter 之后紧跟的 blur"——那次 blur 不能再拿旧草稿存一遍。
   */
  const titleDone = useRef(true)
  const titleEditId = useRef<string | null>(null)
  const titleDraftRef = useRef('')
  const titleFocused = useRef(false)

  const beginTitleEdit = () => {
    const id = currentIdRef.current
    if (!id) return
    const cur = notesRef.current.find((n) => n.id === id)
    titleDone.current = false
    titleEditId.current = id
    titleDraftRef.current = cur?.title ?? ''
    titleFocused.current = false
    setTitleDraft(titleDraftRef.current)
    setTitleEditing(true)
  }

  const endTitleEdit = async (save: boolean) => {
    if (titleDone.current) return
    titleDone.current = true
    const id = titleEditId.current
    titleEditId.current = null
    const draft = titleDraftRef.current.trim()
    setTitleEditing(false)
    if (!save || !id || !draft) return
    const cur = notesRef.current.find((n) => n.id === id)
    if (!cur || draft === cur.title) return
    try {
      const meta = await invoke<NoteMeta>('rename_note', { id, title: draft })
      setNotes((prev) => upsert(prev, meta))
      showToast('标题已改')
    } catch {
      showToast('改名失败')
    }
  }

  /** 切了笔记：正在改的那次就地收掉，别让旧草稿跟着新笔记的标题栏走。 */
  const titleShownId = useRef<string | null>(null)
  useEffect(() => {
    if (titleShownId.current === currentId) return
    titleShownId.current = currentId
    if (!titleEditing) return
    titleDone.current = true
    setTitleEditing(false)
  }, [currentId, titleEditing])

  const doDelete = async () => {
    const target = confirmDelete
    setConfirmDelete(null)
    if (!target) return
    cancelPendingSave()
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
      showNote(full)
    } else {
      const created = await invoke<NoteFull>('create_note')
      setNotes([created])
      showNote(created)
      setDocEmpty(true)
    }
  }

  // ── 侧栏多选 / 右键菜单 / 置顶 ────────────────────────

  const togglePick = useCallback((id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const clearMulti = useCallback(() => {
    setPicked([])
    setMulti(false)
  }, [])

  /** 点列表项：多选模式下是勾选，否则就是切笔记；Ctrl / Cmd 点击永远是多选。 */
  const onNoteClick = (e: React.MouseEvent, n: NoteMeta) => {
    if (multi || e.ctrlKey || e.metaKey) {
      if (!multi) {
        setMulti(true)
        // 进入多选时把当前这篇也带上，不然第一次 Ctrl+点 只会选中一篇
        setPicked((prev) => (prev.includes(n.id) ? prev : [...prev, n.id]))
        return
      }
      togglePick(n.id)
      return
    }
    void switchNote(n.id)
  }

  const openNoteMenu = (e: React.MouseEvent, n: NoteMeta) => {
    e.preventDefault()
    e.stopPropagation()
    // 右键点到没选中的笔记：选择集合换成它（和资源管理器一致）
    setPicked((prev) => (prev.includes(n.id) ? prev : [n.id]))
    setNoteMenu({ x: e.clientX, y: e.clientY, id: n.id })
  }

  /** 置顶 / 取消置顶：先本地排一次让人立刻看到，失败再回滚。 */
  const togglePin = async (n: NoteMeta) => {
    const next = !n.pinned
    const optimistic = (v: boolean) =>
      setNotes((prev) => sortNotes(prev.map((x) => (x.id === n.id ? { ...x, pinned: v } : x))))
    optimistic(next)
    try {
      const meta = await invoke<NoteMeta>('set_pinned', { id: n.id, pinned: next })
      setNotes((prev) => upsert(prev, meta))
      showToast(next ? '已置顶' : '已取消置顶')
    } catch {
      optimistic(!next)
      showToast('置顶失败')
    }
  }

  /** 批量删除（侧栏多选 / 平铺预览页共用）：一次命令删完，返回真正移进回收站的篇数。
   *  删到正在编辑的那篇时，会把编辑器切到剩下的一篇（一篇不剩就新建）。 */
  const deleteNotesByIds = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      cancelPendingSave()
      let moved = 0
      try {
        moved = await invoke<number>('delete_notes', { ids })
      } catch {
        showToast('删除失败')
        return
      }
      const rest = notesRef.current.filter((n) => !ids.includes(n.id))
      notesRef.current = rest
      setNotes(rest)
      setPicked([])
      setMulti(false)
      showToast(`已删除 ${moved} 篇笔记`)
      if (currentIdRef.current && !ids.includes(currentIdRef.current)) return

      // 当前打开的这篇被删了：切到第一篇；一篇不剩就新建，别留空壳
      if (rest.length) {
        const full = await invoke<NoteFull>('load_note', { id: rest[0].id })
        showNote(full)
      } else {
        const created = await invoke<NoteFull>('create_note')
        notesRef.current = [created]
        setNotes([created])
        showNote(created)
        setDocEmpty(true)
      }
    },
    [cancelPendingSave, showNote, showToast],
  )

  const doBatchDelete = async () => {
    const ids = confirmBatch ?? []
    setConfirmBatch(null)
    await deleteNotesByIds(ids)
  }

  // ── 侧栏拖宽 ──────────────────────────────────────────

  const onSideResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    sideDragRef.current = { x: e.clientX, width: sideWidth }
    setSideDragging(true)
  }

  const onSideResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sideDragging) return
    const dx = e.clientX - sideDragRef.current.x
    setSideWidth(
      Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(sideDragRef.current.width + dx))),
    )
  }

  const onSideResizeUp = () => {
    if (!sideDragging) return
    setSideDragging(false)
    invoke('set_sidebar_width', { width: sideWidth }).catch(() => {})
  }

  // ── 图片库 ──────────────────────────────────────────

  /** 把图片库里选中的图追加到当前笔记末尾。 */
  const insertImages = useCallback(
    async (items: ImageItem[]) => {
      const ed = editorRef.current
      if (!ed || items.length === 0) return
      for (const it of items) {
        appendCapture(ed, {
          kind: 'image',
          ts: Date.now(),
          path: it.path,
          hash: it.hash,
          w: it.width,
          h: it.height,
        })
      }
      setDocEmpty(false)
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      await persist(ed.getJSON())
      requestAnimationFrame(() => scrollToBottom(true))
      showToast(`已插入 ${items.length} 张图片`)
    },
    [persist, scrollToBottom, showToast],
  )

  /** 用选中的图新建一篇笔记。 */
  const createNoteFromImages = useCallback(
    async (items: ImageItem[]) => {
      if (items.length === 0) return
      await flushSave()
      try {
        const created = await invoke<NoteFull>('create_note_from_images', {
          hashes: items.map((it) => it.hash),
        })
        setNotes((prev) => upsert(prev, created))
        showNote(created)
        showToast(`已用 ${items.length} 张图片新建笔记`)
      } catch {
        showToast('新建笔记失败')
      }
    },
    [flushSave, showNote, showToast],
  )

  /** 真删一篇笔记（图片库的"删除笔记"、空白笔记都用它）。 */
  const purgeNote = useCallback(
    async (noteId: string, message = '笔记已删除') => {
      cancelPendingSave()
      try {
        await invoke('purge_note', { id: noteId })
      } catch {
        showToast('删除失败')
        return
      }
      const rest = notesRef.current.filter((n) => n.id !== noteId)
      notesRef.current = rest
      setNotes(rest)
      showToast(message)
      if (currentIdRef.current !== noteId) return

      if (rest.length) {
        const full = await invoke<NoteFull>('load_note', { id: rest[0].id })
        showNote(full)
      } else {
        const created = await invoke<NoteFull>('create_note')
        notesRef.current = [created]
        setNotes([created])
        showNote(created)
        setDocEmpty(true)
      }
    },
    [cancelPendingSave, showNote, showToast],
  )

  /**
   * 侧栏点「删除」：**空白笔记不问**，直接删文件（它本来就是"新建了没写"留下的空壳，
   * 移到回收站里只会攒一堆垃圾）；有内容的照旧问一句，再软删除。
   */
  const requestDelete = useCallback(
    async (n: NoteMeta) => {
      // 先落盘：判断空不空读的是磁盘上的那一份
      await flushSave()
      let blank = false
      try {
        blank = await invoke<boolean>('note_blank', { id: n.id })
      } catch {
        /* 读不出来就按"有内容"处理，宁可多问一句，也别把东西删了 */
      }
      if (blank) {
        await purgeNote(n.id, '空白笔记已删除')
        return
      }
      setConfirmDelete(n)
    },
    [flushSave, purgeNote],
  )

  /** 图片库删图之前：先把正文落盘，免得待保存的编辑把刚删掉的图又写回笔记文件。 */
  const beforeImagesDelete = useCallback(async () => {
    await flushSave()
  }, [flushSave])

  /**
   * 图片库把图删干净之后：Rust 已经把这些图从所有笔记的正文里摘掉了，
   * 当前这篇如果被动过，就从磁盘重新载进来，免得屏幕上还挂着一张已经删掉的图。
   */
  const afterImagesDelete = useCallback(
    async (info: { moved: number; touched: string[] }) => {
      const id = currentIdRef.current
      if (!id || !info.touched.includes(id)) return
      cancelPendingSave()
      try {
        const full = await invoke<NoteFull>('load_note', { id })
        showNote(full)
      } catch {
        /* 读不回来就算了：下次切笔记自然会读到最新内容 */
      }
    },
    [cancelPendingSave, showNote],
  )

  const toggleTheme = async () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    await invoke('set_theme', { theme: next })
  }

  const toggleSidebar = () => {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    if (!next) closePeekNow()
    invoke('set_sidebar', { collapsed: next }).catch(() => {})
  }

  // ── 收起状态下的悬浮侧栏 ────────────────────────────
  //
  // 侧栏收起后，鼠标停在左上角的侧栏图标上就浮出一层临时侧栏（不占布局，正文不跳）；
  // 移开自动收；点图标 = 固定（走正常的 toggleSidebar）。
  // 用一个小延迟收，是因为从图标移到浮层上会经过几像素的缝隙。
  //
  // 收回分两步走，为的是"正文一个像素都不动"：
  //   1. 先在 fixed 状态下播完淡出 / 左移的动画（浮层不占布局，怎么动都不影响正文）；
  //   2. 动画结束才把浮层交回布局（宽度变回 0）。交接的那一帧要把 width 过渡掐掉，
  //      否则 236 → 0 的过渡会把正文一路挤回去 —— 就是"收回时整个页面短暂偏移"。
  const peekTimer = useRef<number | null>(null)
  /** 淡出动画结束后把浮层撤出布局 */
  const peekLeaveTimer = useRef<number | null>(null)
  /** 撤出布局后的一小段时间里禁掉 .side 的过渡（见 styles.css 的 .side.settling） */
  const peekSettleTimer = useRef<number | null>(null)
  /** 浮层此刻是否真的开着（回调里要判断，不能等 state 更新） */
  const peekOpenRef = useRef(false)

  const cancelPeekTimer = () => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current)
      peekTimer.current = null
    }
  }
  const cancelPeekLeave = () => {
    if (peekLeaveTimer.current !== null) {
      window.clearTimeout(peekLeaveTimer.current)
      peekLeaveTimer.current = null
    }
  }
  const cancelPeekSettle = () => {
    if (peekSettleTimer.current !== null) {
      window.clearTimeout(peekSettleTimer.current)
      peekSettleTimer.current = null
    }
  }
  /** 撤出布局的那一帧把过渡关掉，下一帧起恢复正常 */
  const settlePeek = () => {
    cancelPeekSettle()
    setSidePeekSettle(true)
    peekSettleTimer.current = window.setTimeout(() => {
      peekSettleTimer.current = null
      setSidePeekSettle(false)
    }, 80)
  }

  const openPeek = () => {
    cancelPeekTimer()
    cancelPeekLeave()
    cancelPeekSettle()
    setSidePeekSettle(false)
    setSidePeekClosing(false)
    if (!collapsedRef.current) return
    peekOpenRef.current = true
    setSidePeek(true)
  }

  /** 播放收回动画，动画播完再把浮层撤出布局。 */
  const closePeekAnimated = () => {
    cancelPeekTimer()
    if (!peekOpenRef.current) return
    setSidePeekClosing(true)
    cancelPeekLeave()
    peekLeaveTimer.current = window.setTimeout(() => {
      peekLeaveTimer.current = null
      peekOpenRef.current = false
      setSidePeek(false)
      setSidePeekClosing(false)
      settlePeek()
    }, PEEK_OUT_MS)
  }

  const closePeekSoon = () => {
    cancelPeekTimer()
    if (!collapsedRef.current) return
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null
      closePeekAnimated()
    }, 200)
  }

  /** 立刻收（点浮层里的东西 / 展开侧栏）：不播动画，但同样不能带动正文。 */
  const closePeekNow = () => {
    cancelPeekTimer()
    cancelPeekLeave()
    if (!peekOpenRef.current) return
    peekOpenRef.current = false
    setSidePeek(false)
    setSidePeekClosing(false)
    settlePeek()
  }

  useEffect(
    () => () => {
      cancelPeekTimer()
      cancelPeekLeave()
      cancelPeekSettle()
    },
    [],
  )
  // 收起 / 展开一变，浮层就该收掉（比如窗口变窄自动收起）
  useEffect(() => {
    if (!sidebarCollapsed) closePeekNow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed])

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
    if (dedupeRef.current) {
      const dup = findDuplicate(editor.state.doc, cap)
      if (dup) {
        revealDuplicate(dup)
        return
      }
    }
    appendCapture(editor, cap)
    requestAnimationFrame(() => scrollToBottom())
  }

  // ── 图片右键菜单 ────────────────────────────────────

  /** 打开图片库；顺手把图片选中取消掉，免得虚线框留在弹层背后。 */
  const openLibrary = (hash: string | null = null) => {
    const ed = editorRef.current
    if (ed) clearImageSelection(ed.view)
    setLibraryHash(hash)
    setLibraryOpen(true)
  }

  const onImageContextMenu = (e: React.MouseEvent) => {
    const ed = editorRef.current
    if (!ed) return
    const el = (e.target as HTMLElement | null)?.closest?.('img') as HTMLImageElement | null
    if (!el || !ed.view.dom.contains(el)) {
      // 点在正文的空白/文字上：选中了一段文字就出"文字菜单"
      const sel = ed.state.selection
      const t = e.target as Node | null
      if (!t || !ed.view.dom.contains(t)) return
      if (!(sel instanceof TextSelection) || sel.empty) return
      e.preventDefault()
      e.stopPropagation()
      setImgMenu(null)
      setTextMenu({ x: e.clientX, y: e.clientY, from: sel.from, to: sel.to })
      return
    }
    let pos = -1
    try {
      pos = ed.view.posAtDOM(el, 0)
    } catch {
      pos = -1
    }
    const node = pos >= 0 ? ed.state.doc.nodeAt(pos) : null
    if (!node || node.type.name !== 'image') return
    e.preventDefault()
    e.stopPropagation()
    setTextMenu(null)
    selectImage(ed.view, pos)
    setImgMenu({ x: e.clientX, y: e.clientY, pos, hash: (node.attrs.hash as string) ?? null })
  }

  /**
   * 把选中的文字搬进一篇新笔记。
   *
   * 顺序：先建新笔记并写入切出来的内容，再从这篇里删掉 —— 中途失败最多是"没搬成"，
   * 不会把这段文字弄丢。搬完留在当前笔记里（不跳走），侧栏最上面就是新笔记。
   */
  const moveTextToNewNote = async (menu: TextMenu) => {
    const ed = editorRef.current
    setTextMenu(null)
    if (!ed) return
    const doc = sliceToDoc(ed.state.doc, menu.from, menu.to)
    if (!doc) {
      showToast('没有可移动的内容')
      return
    }
    try {
      const created = await invoke<NoteFull>('create_note')
      const meta = await invoke<NoteMeta>('save_note', { id: created.id, doc })
      setNotes((prev) => upsert(prev, meta))
      ed.view.dispatch(ed.state.tr.delete(menu.from, menu.to))
      await persist(ed.getJSON())
      showToast(`已移到「${meta.title}」`)
    } catch (e) {
      console.error(e)
      showToast('移到新笔记失败')
    }
  }

  /**
   * 右键菜单里的复制 / 剪切。
   *
   * 出去的是**纯文本**，而且不带完全空行（和 Ctrl+C 同一个规矩，见 editor/clipboard.ts）。
   * 走 copy_with_marker 而不是 navigator.clipboard：写剪贴板时打上 Click2GetOwned 标记，
   * 就算监控开着也不会把自己复制出去的东西再记一遍。
   */
  const copySelection = async (cut: boolean) => {
    const ed = editorRef.current
    const menu = textMenu
    setTextMenu(null)
    if (!ed || !menu) return
    const text = cleanCopyText(ed.state.doc.textBetween(menu.from, menu.to, '\n', '\n'))
    if (!text) {
      showToast('没有可复制的文字')
      return
    }
    try {
      await invoke('copy_with_marker', { text })
    } catch {
      showToast(cut ? '剪切失败' : '复制失败')
      return
    }
    if (!cut) {
      showToast('已复制')
      return
    }
    // 剪切：先确认这段还是刚才那段（拖动 / 捕获可能刚好改过文档）
    const now = cleanCopyText(ed.state.doc.textBetween(menu.from, menu.to, '\n', '\n'))
    if (now !== text) {
      showToast('已复制，但选区有变化，请手动删掉')
      return
    }
    ed.view.dispatch(ed.state.tr.delete(menu.from, menu.to))
    await persist(ed.getJSON())
    showToast('已剪切')
  }

  /**
   * 右键菜单里把选中的内容在"行内换行"和"单独的行"之间转。
   *
   * 复制进来的多行文字是一段里的硬换行（见 editor/insert.ts），
   * 想把它当一行一行改就"拆解成多行"；反过来选中几行想合成一段就是"合并多行"。
   * 真正的文档变换在 editor/lineBreaks.ts（纯函数）。
   */
  const convertSelectionRows = (menu: TextMenu, mode: 'split' | 'merge') => {
    const ed = editorRef.current
    setTextMenu(null)
    if (!ed) return
    const tr =
      mode === 'split'
        ? splitInlineBreaks(ed.state, menu.from, menu.to)
        : mergeRowsIntoOne(ed.state, menu.from, menu.to)
    if (!tr) {
      showToast(mode === 'split' ? '选中的文字里没有行内换行' : '至少要选中两行才能合并')
      return
    }
    ed.view.dispatch(tr.scrollIntoView())
    void persist(ed.getJSON())
  }

  /**
   * 用选中的文字去浏览器里搜。
   *
   * 走 open_url（只放行 http/https），搜索词整段塞进 q 参数；
   * 太长的选中截到 200 字 —— 再长搜索引擎也不认。
   */
  const searchSelection = (menu: TextMenu) => {
    const ed = editorRef.current
    setTextMenu(null)
    if (!ed) return
    const q = ed.state.doc
      .textBetween(menu.from, menu.to, '\n')
      .replace(/\s+/g, ' ')
      .trim()
    if (!q) {
      showToast('没有选中文字')
      return
    }
    const words = q.slice(0, 200)
    openExternal(`https://www.bing.com/search?q=${encodeURIComponent(words)}`)
  }

  /** 双击图片 = 看/改这张图的备注（编辑页里备注默认不显示，这是主动打开）。 */
  const onImageDoubleClick = (e: React.MouseEvent) => {
    const ed = editorRef.current
    if (!ed) return
    const el = (e.target as HTMLElement | null)?.closest?.('img') as HTMLImageElement | null
    if (!el || !ed.view.dom.contains(el)) return
    let pos = -1
    try {
      pos = ed.view.posAtDOM(el, 0)
    } catch {
      return
    }
    if (pos < 0) return
    const node = ed.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'image') return
    e.preventDefault()
    void openNoteEditor(pos)
  }

  const commitNoteEdit = async () => {
    const target = noteEdit
    if (!target) return
    try {
      await invoke('set_image_note', { hash: target.hash, note: noteDraft })
      setNoteEdit(null)
      showToast(noteDraft.trim() ? '备注已保存' : '备注已清空')
    } catch (e) {
      console.error(e)
      showToast('备注保存失败')
    }
  }

  /**
   * 右键 OCR：把图里的文字认出来，放进一个**可编辑**的结果弹层。
   *
   * 识别结果默认的归宿是这张图自己的备注（不是笔记正文）：
   * OCR 出来的字一定有错，先让人改，再存进 `images/.../<hash>.json`。
   */
  const runOcr = async (menu: ImageMenu) => {
    const hash = menu.hash
    setImgMenu(null)
    if (!hash) {
      showToast('这张图没有本地文件，没法识别')
      return
    }
    const node = editorRef.current?.state.doc.nodeAt(menu.pos)
    const path = (node?.attrs.path as string) ?? null
    showToast('正在识别图片文字…')
    try {
      const text = await invoke<string>('ocr_image', { hash })
      const clean = text.trim()
      if (!clean) {
        showToast('图里没认出文字')
        return
      }
      setOcr({ hash, text: clean, path })
    } catch (e) {
      console.error(e)
      showToast(typeof e === 'string' && e ? e : 'OCR 不可用')
    }
  }

  /** OCR 结果复制走：必须走 Rust 命令打标记，否则开着监控会被自己再捕获一次。 */
  const copyOcrText = async () => {
    if (!ocr) return
    try {
      await invoke('copy_with_marker', { text: ocr.text })
      showToast('已复制')
    } catch {
      showToast('复制失败')
    }
  }

  /**
   * 把（可能改过的）OCR 文字存进这张图的备注。
   * 已经有备注就接在后面 —— OCR 常常是补一段说明，不是要覆盖原来那句。
   */
  const saveOcrToNote = async () => {
    const target = ocr
    if (!target) return
    const text = target.text.trim()
    if (!text) {
      showToast('没有可保存的文字')
      return
    }
    setOcrSaving(true)
    try {
      let existing = ''
      try {
        existing = await invoke<string>('get_image_note', { hash: target.hash })
      } catch {
        /* 读不到就当原来没有备注 */
      }
      const merged = existing.trim() ? `${existing.trimEnd()}\n${text}` : text
      await invoke('set_image_note', { hash: target.hash, note: merged })
      setOcr(null)
      showToast('已存进图片备注')
    } catch (e) {
      console.error(e)
      showToast('保存备注失败')
    } finally {
      setOcrSaving(false)
    }
  }

  /** 导出当前笔记：先落盘，再让 Rust 生成文件（并打开所在文件夹）。 */
  const exportNote = async (format: 'md' | 'docx') => {
    const id = currentIdRef.current
    if (!id) return
    setMenuOpen(false)
    await flushSave()
    try {
      const file = await invoke<{ name: string; format: string; images: number }>('export_note', {
        id,
        format,
        stamp: localStamp(),
      })
      showToast(
        file.images > 0 ? `已导出 ${file.name}（${file.images} 张图）` : `已导出 ${file.name}`,
      )
    } catch (e) {
      console.error(e)
      showToast(typeof e === 'string' && e ? e : '导出失败')
    }
  }

  const menuPos = imgMenu ? clampMenu(imgMenu.x, imgMenu.y, 208, 400) : null
  const textMenuPos = textMenu ? clampMenu(textMenu.x, textMenu.y, 208, 316) : null
  /**
   * 文字菜单里两项"行操作"可不可用：按当前文档实时算。
   * 文档可能在菜单开着的时候被捕获 / 自动保存动过位置，算不出来就按禁用处理。
   */
  const textMenuRows = (() => {
    const empty = { breaks: 0, merges: 0 }
    if (!textMenu || !editor) return empty
    try {
      return {
        breaks: countInlineBreaks(editor.state.doc, textMenu.from, textMenu.to),
        merges: countMergeableRuns(editor.state.doc, textMenu.from, textMenu.to),
      }
    } catch {
      return empty
    }
  })()
  const menuImgWidth = imgMenu
    ? Math.round(Number(editorRef.current?.state.doc.nodeAt(imgMenu.pos)?.attrs.width) || 0)
    : 0

  /** 侧栏笔记右键菜单的位置 / 目标（都在渲染前算好，免得 JSX 里塞逻辑） */
  const noteMenuPos = noteMenu ? clampMenu(noteMenu.x, noteMenu.y, 224, 276) : null
  const noteMenuTarget = noteMenu ? notes.find((n) => n.id === noteMenu.id) ?? null : null
  const pickedCount = picked.length

  const currentTitle = notes.find((n) => n.id === currentId)?.title ?? '无标题笔记'

  return (
    <div className="app">
      <aside
        className={`side ${sidebarCollapsed ? 'collapsed' : ''} ${
          sidebarCollapsed && sidePeek ? 'peek' : ''
        } ${sidebarCollapsed && sidePeek && sidePeekClosing ? 'peek-out' : ''} ${
          sidePeekSettle ? 'settling' : ''
        } ${sideDragging ? 'resizing' : ''}`}
        style={!sidebarCollapsed || sidePeek ? { width: sideWidth } : undefined}
        onMouseEnter={openPeek}
        onMouseLeave={closePeekSoon}
        onClick={() => {
          // 悬浮侧栏里点任何东西（切笔记 / 新建 / 重命名）之后就收起来
          if (sidebarCollapsed) closePeekNow()
        }}
      >
        <div className="side-inner">
          <div className="side-head">Click2Get</div>
          <button className="new-btn" data-new-note="" onClick={newNote} title="新建笔记（也可以把内容拖到这里）">
            <span className="plus">+</span> 新建笔记
          </button>
          <div className="list">
            {notes.map((n) => {
              const isPicked = picked.includes(n.id)
              return (
                <div
                  key={n.id}
                  data-note-id={n.id}
                  className={`item ${n.id === currentId ? 'active' : ''} ${
                    multi && isPicked ? 'picked' : ''
                  } ${multi ? 'multi' : ''}`}
                  onClick={(e) => onNoteClick(e, n)}
                  onDoubleClick={() => {
                    if (!multi) startRename(n)
                  }}
                  onContextMenu={(e) => openNoteMenu(e, n)}
                  title={multi ? `${n.title}（点击勾选）` : n.title}
                >
                  {multi && (
                    <span className={`pick ${isPicked ? 'on' : ''}`}>
                      {isPicked && <CheckIcon />}
                    </span>
                  )}
                  {n.pinned && (
                    <span className="pin" title="已置顶">
                      <PinIcon />
                    </span>
                  )}
                  {renaming?.id === n.id ? (
                    <span className="item-title renaming-hint">{renameDraft || n.title}</span>
                  ) : (
                    <>
                      <span className="item-title">{n.title}</span>
                      <span className="item-actions">
                        <button
                          className="mini"
                          title={n.pinned ? '取消置顶' : '置顶'}
                          onClick={(e) => {
                            e.stopPropagation()
                            void togglePin(n)
                          }}
                        >
                          <PinIcon />
                        </button>
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
                            void requestDelete(n)
                          }}
                        >
                          <TrashIcon />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              )
            })}
            {notes.length === 0 && <div className="empty">还没有笔记</div>}
          </div>
          {pickedCount > 0 && (
            <div className="pick-bar">
              <span className="pick-info">已选 {pickedCount} 篇</span>
              <div className="spacer" />
              <button className="mini-btn" onClick={() => setConfirmBatch(picked)}>
                批量删除
              </button>
              <button className="mini-btn" onClick={clearMulti}>
                取消
              </button>
            </div>
          )}
        </div>
      </aside>

      {!sidebarCollapsed && (
        <div
          className={`side-resizer ${sideDragging ? 'dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          title="拖动调整笔记栏宽度，双击还原"
          onPointerDown={onSideResizeDown}
          onPointerMove={onSideResizeMove}
          onPointerUp={onSideResizeUp}
          onPointerCancel={onSideResizeUp}
          onDoubleClick={() => {
            setSideWidth(236)
            invoke('set_sidebar_width', { width: 236 }).catch(() => {})
          }}
        />
      )}

      <main className="main">
        <header className="bar">
          <button
            className="icon-btn"
            onClick={toggleSidebar}
            onMouseEnter={openPeek}
            onMouseLeave={closePeekSoon}
            title={sidebarCollapsed ? '展开侧栏（鼠标停留可预览）' : '收起侧栏'}
            aria-expanded={!sidebarCollapsed}
          >
            <SidebarIcon />
          </button>
          {titleEditing ? (
            <input
              className="title title-input"
              value={titleDraft}
              maxLength={80}
              spellCheck={false}
              placeholder="无标题笔记"
              title="改标题（Enter 保存 · Esc 放弃）"
              ref={(el) => {
                // 只在这一轮编辑开始的那一刻聚焦并全选，之后每次重画都别再抢
                if (!el || titleFocused.current) return
                titleFocused.current = true
                el.focus()
                el.select()
              }}
              onChange={(e) => {
                titleDraftRef.current = e.target.value
                setTitleDraft(e.target.value)
              }}
              onBlur={() => void endTitleEdit(true)}
              onKeyDown={(e) => {
                // 别让 Ctrl+F / Esc 这些快捷键漏到窗口上（搜索面板、平铺页还在后面）
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void endTitleEdit(true)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  void endTitleEdit(false)
                }
              }}
            />
          ) : (
            <button
              className="title title-btn"
              onClick={beginTitleEdit}
              title="点击改标题"
            >
              {currentTitle}
            </button>
          )}
          <div className="spacer" />
          {/* 这四个可以长按拖动换顺序（见 BarControls），"更多"固定在最右 */}
          <BarControls
            order={barOrder}
            onOrder={(next) => {
              setBarOrder(next)
              persistBarOrder(next)
            }}
            items={{
              monitor: (
                <button
                  className={`mon ${monitoring ? 'on' : 'off'}`}
                  onClick={() => void toggleMonitoring()}
                  title={monitoring ? '监控中 · 点击暂停' : '已暂停 · 点击恢复监控'}
                  aria-label={monitoring ? '暂停剪贴板监控' : '恢复剪贴板监控'}
                  aria-pressed={monitoring}
                >
                  <span className="dot" />
                </button>
              ),
              gallery: (
                <button
                  className="icon-btn"
                  onClick={() => {
                    // 先把待保存的正文落盘：平铺页的预览是从磁盘读的，
                    // 刚敲的字还没存的话，卡片上看到的会是一分钟前的样子
                    void flushSave().then(() => setGalleryOpen(true))
                  }}
                  title="平铺预览（所有笔记）· 长按可拖动换位置"
                >
                  <TilesIcon />
                </button>
              ),
              search: (
                <button
                  className="icon-btn"
                  onClick={() => setSearchOpen(true)}
                  title="搜索（Ctrl+F）"
                >
                  <SearchIcon />
                </button>
              ),
              library: (
                <button
                  className="icon-btn"
                  onClick={() => openLibrary(null)}
                  title="图片库"
                >
                  <ImageIcon />
                </button>
              ),
            }}
          />
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
              <button className="menu-item" onClick={() => void exportNote('md')}>
                导出为 Markdown
              </button>
              <button className="menu-item" onClick={() => void exportNote('docx')}>
                导出为 Word（.docx）
              </button>
              <div className="menu-sep" />
              {/* 夜间模式收进"更多"里：标题栏只留最常用的几个图标 */}
              <button
                className="menu-item switch-row"
                onClick={() => void toggleTheme()}
                title={theme === 'light' ? '切换到深色' : '切换到浅色'}
              >
                {theme === 'light' ? <MoonIcon /> : <SunIcon />}
                夜间模式
                <span className="menu-state">{theme === 'dark' ? '已开启' : '关'}</span>
              </button>
              {/* 监控开关故意不关菜单：点一下就能看到状态变了，接着还能点别的 */}
              <button
                className="menu-item switch-row"
                onClick={() => void toggleMonitoring()}
                title="开关剪贴板监控（这个菜单不会关）"
              >
                <span className={`dot ${monitoring ? 'on' : ''}`} />
                {monitoring ? '暂停监控' : '恢复监控'}
              </button>
              {/* 捕获去重：同样的内容重复复制，只留一份 */}
              <button
                className="menu-item switch-row"
                onClick={() => void toggleDedupe()}
                title="同一段文字 / 同一张图重复复制时，不再记第二遍"
              >
                捕获去重
                <span className="menu-state">{dedupe ? '已开启' : '关'}</span>
              </button>
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
          onContextMenu={onImageContextMenu}
          onDoubleClick={onImageDoubleClick}
          onScroll={() => {
            setImgMenu(null)
            if (nearBottom() && newCount) setNewCount(0)
          }}
        >
          <EditorContent editor={editor} />
          {docEmpty && <div className="hint">在这里写点什么，或者去别处复制点东西</div>}
        </div>

        {/* 收纳箱：贴在编辑面板右侧、删除图标上面。拖内容过来松手先存着，
            攒够了点它放到光标处（见 CollectBox.tsx） */}
        <CollectBox
          items={collect}
          anchor={scrollRef}
          onInsert={(item) => void insertCollectItem(item)}
          onInsertAll={() => void insertAllCollected()}
          onRemove={removeCollectItem}
          onClear={clearCollect}
        />

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

        {textMenu && textMenuPos && (
          <>
            <div
              className="ctx-backdrop"
              onClick={() => setTextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setTextMenu(null)
              }}
            />
            <div className="ctx-menu" style={{ left: textMenuPos.left, top: textMenuPos.top }}>
              <div className="ctx-title">已选中一段文字</div>
              <button
                className="menu-item"
                title="复制选中的文字（Ctrl+C）"
                onClick={() => void copySelection(false)}
              >
                复制
              </button>
              <button
                className="menu-item"
                title="剪切选中的文字（Ctrl+X）"
                onClick={() => void copySelection(true)}
              >
                剪切
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                disabled={textMenuRows.breaks === 0}
                title={
                  textMenuRows.breaks > 0
                    ? `把选中的 ${textMenuRows.breaks} 个行内换行拆成单独的行`
                    : '选中的文字里没有行内换行（Shift+Enter 那种）'
                }
                onClick={() => convertSelectionRows(textMenu, 'split')}
              >
                拆解成多行
              </button>
              <button
                className="menu-item"
                disabled={textMenuRows.merges === 0}
                title={
                  textMenuRows.merges > 0
                    ? '把这几个单独的行合并成一行（行与行之间用换行分隔）'
                    : '至少选中两行（同一段捕获里的相邻行）才能合并'
                }
                onClick={() => convertSelectionRows(textMenu, 'merge')}
              >
                合并多行
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                title="用选中的文字开浏览器搜（Bing）"
                onClick={() => searchSelection(textMenu)}
              >
                在浏览器中搜索
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                title="把选中的这段搬进一篇新笔记（原来的位置删掉）"
                onClick={() => void moveTextToNewNote(textMenu)}
              >
                移到新笔记
              </button>
            </div>
          </>
        )}

        {imgMenu && menuPos && (
          <>
            <div
              className="ctx-backdrop"
              onClick={() => setImgMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setImgMenu(null)
              }}
            />
            <div className="ctx-menu" style={{ left: menuPos.left, top: menuPos.top }}>
              <div className="ctx-title">
                图片 {menuImgWidth > 0 ? `· ${menuImgWidth} px` : '· 默认宽度'}
              </div>
              <button
                className="menu-item"
                onClick={() => {
                  setImgMenu(null)
                  openLibrary(imgMenu.hash)
                }}
              >
                在图片库中查看
              </button>
              <button
                className="menu-item"
                title="这张图的备注（不在正文里显示，图片库里也能改）"
                onClick={() => {
                  const pos = imgMenu.pos
                  setImgMenu(null)
                  void openNoteEditor(pos)
                }}
              >
                备注…
              </button>
              <button
                className="menu-item"
                disabled={!imgMenu.hash}
                title={
                  imgMenu.hash
                    ? '认出图里的文字（结果可以改，默认存进这张图的备注）'
                    : '这张图没有本地文件'
                }
                onClick={() => void runOcr(imgMenu)}
              >
                识别文字（OCR）
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  const ed = editorRef.current
                  if (ed) setImageWidth(ed.view, imgMenu.pos, null)
                  setImgMenu(null)
                }}
              >
                默认宽度
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  const ed = editorRef.current
                  if (ed) setImageWidth(ed.view, imgMenu.pos, contentWidth(ed.view))
                  setImgMenu(null)
                }}
              >
                适应宽度
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  const ed = editorRef.current
                  if (ed) setImageWidth(ed.view, imgMenu.pos, contentWidth(ed.view) / 2)
                  setImgMenu(null)
                }}
              >
                一半宽度
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  const ed = editorRef.current
                  if (ed) {
                    const w = Number(ed.state.doc.nodeAt(imgMenu.pos)?.attrs.w) || 0
                    setImageWidth(
                      ed.view,
                      imgMenu.pos,
                      w > 0 ? Math.min(w, contentWidth(ed.view)) : null,
                    )
                  }
                  setImgMenu(null)
                }}
              >
                原始大小
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => {
                  const ed = editorRef.current
                  if (ed) deleteImageAt(ed.view, imgMenu.pos)
                  setImgMenu(null)
                  showToast('已从笔记中删除')
                }}
              >
                删除图片
              </button>
            </div>
          </>
        )}

        {noteMenu && noteMenuPos && (
          <>
            <div
              className="ctx-backdrop"
              onClick={() => setNoteMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setNoteMenu(null)
              }}
            />
            <div className="ctx-menu" style={{ left: noteMenuPos.left, top: noteMenuPos.top }}>
              <div className="ctx-title">
                {pickedCount > 1 ? `已选 ${pickedCount} 篇` : noteMenuTarget?.title ?? '笔记'}
              </div>
              {pickedCount <= 1 && noteMenuTarget && (
                <>
                  <button
                    className="menu-item"
                    onClick={() => {
                      const id = noteMenuTarget.id
                      setNoteMenu(null)
                      void switchNote(id)
                    }}
                  >
                    打开
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      const target = noteMenuTarget
                      setNoteMenu(null)
                      startRename(target)
                    }}
                  >
                    重命名…
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      const target = noteMenuTarget
                      setNoteMenu(null)
                      void togglePin(target)
                    }}
                  >
                    {noteMenuTarget.pinned ? '取消置顶' : '置顶笔记'}
                  </button>
                </>
              )}
              <button
                className="menu-item"
                onClick={() => {
                  setNoteMenu(null)
                  if (multi) clearMulti()
                  else setMulti(true)
                }}
              >
                {multi ? '退出多选' : '多选笔记（Ctrl+点击）'}
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => {
                  const ids = pickedCount > 1 ? picked : [noteMenu.id]
                  const single = pickedCount <= 1 ? noteMenuTarget : null
                  setNoteMenu(null)
                  // 单篇：空白笔记直接删，有内容才弹确认；多篇照旧一起确认
                  if (single) void requestDelete(single)
                  else setConfirmBatch(ids)
                }}
              >
                {pickedCount > 1 ? `删除选中的 ${pickedCount} 篇笔记` : '删除笔记'}
              </button>
            </div>
          </>
        )}

        {confirmBatch && (
          <div className="modal-backdrop" onClick={() => setConfirmBatch(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">删除选中的 {confirmBatch.length} 篇笔记？</div>
              <div className="modal-body">
                {confirmBatch.length > 1 && (
                  <>
                    {confirmBatch
                      .map((id) => notes.find((n) => n.id === id)?.title ?? '')
                      .filter(Boolean)
                      .slice(0, 4)
                      .map((t) => `「${t}」`)
                      .join('、')}
                    {confirmBatch.length > 4 ? ` 等 ${confirmBatch.length} 篇` : ''}
                    <br />
                  </>
                )}
                会一起移到 <code>notes/.trash</code>，不会立刻消失。
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirmBatch(null)}>
                  取消
                </button>
                <button className="btn danger" onClick={() => void doBatchDelete()}>
                  删除 {confirmBatch.length} 篇
                </button>
              </div>
            </div>
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
                ref={renameInputRef}
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

        {noteEdit && (
          <div className="modal-backdrop" onClick={() => setNoteEdit(null)}>
            <div className="modal wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">图片备注</div>
              <div className="note-preview">
                {noteEdit.path && <img src={fileUrl(noteEdit.path)} alt="" draggable={false} />}
                <div className="note-preview-hint">
                  备注属于这张图本身：不在笔记正文里显示，图片库里也能改，搜索的时候能搜到。
                </div>
              </div>
              <textarea
                className="modal-textarea"
                autoFocus
                value={noteDraft}
                placeholder="这张图是什么？记一句，以后搜得到…"
                spellCheck={false}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setNoteEdit(null)
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void commitNoteEdit()
                  }
                }}
              />
              <div className="modal-actions">
                <button className="btn" onClick={() => setNoteDraft('')}>
                  清空
                </button>
                <div className="spacer" />
                <button className="btn" onClick={() => setNoteEdit(null)}>
                  取消
                </button>
                <button className="btn primary" onClick={() => void commitNoteEdit()}>
                  保存
                </button>
              </div>
            </div>
          </div>
        )}

        {ocr && (
          <div className="modal-backdrop" onClick={() => setOcr(null)}>
            <div className="modal wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">识别出的文字</div>
              <div className="ocr-preview">
                {ocr.path && <img src={fileUrl(ocr.path)} alt="" draggable={false} />}
                <div className="note-preview-hint">
                  识别结果可以随便改（错字、多余空格、断行都能动）。
                  保存后写进<b>这张图的备注</b>，不进笔记正文；备注在图片库里也看得到、搜得到。
                </div>
              </div>
              <textarea
                className="modal-textarea ocr-edit"
                value={ocr.text}
                autoFocus
                spellCheck={false}
                placeholder="这里应该已经填好了识别出的文字…"
                onChange={(e) => setOcr({ ...ocr, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setOcr(null)
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void saveOcrToNote()
                  }
                }}
              />
              <div className="modal-actions">
                <button className="btn" onClick={() => void copyOcrText()}>
                  复制
                </button>
                <div className="spacer" />
                <button className="btn" onClick={() => setOcr(null)}>
                  关闭
                </button>
                <button
                  className="btn primary"
                  onClick={() => void saveOcrToNote()}
                  disabled={ocrSaving}
                  title="追加到这张图的备注里（Ctrl+Enter）"
                >
                  {ocrSaving ? '保存中…' : '存进图片备注'}
                </button>
              </div>
            </div>
          </div>
        )}

        {searchOpen && (
          <SearchPanel onClose={() => setSearchOpen(false)} onPick={openSearchHit} />
        )}

        {galleryOpen && (
          <NoteGallery
            currentId={currentId}
            onClose={() => setGalleryOpen(false)}
            onToast={showToast}
            onOpen={(id) => {
              // 从卡片打开：先收起平铺页，再走正常的切笔记流程（会先落盘）
              setGalleryOpen(false)
              void switchNote(id)
            }}
            onDeleteNotes={deleteNotesByIds}
          />
        )}

        {libraryOpen && (
          <ImageLibrary
            onClose={() => setLibraryOpen(false)}
            onToast={showToast}
            initialHash={libraryHash}
            onInsert={insertImages}
            onCreateNote={createNoteFromImages}
            onPurgeNote={purgeNote}
            onBeforeDelete={beforeImagesDelete}
            onImagesDeleted={afterImagesDelete}
            onOpenNote={(id) => {
              void switchNote(id)
            }}
          />
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

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.6" cy="9.8" r="1.6" />
      <path d="M3.6 17.2l4.6-4.4 3.4 3.1 3.4-3.6 4.9 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10.6" cy="10.6" r="6.4" />
      <path d="M15.4 15.4L21 21" strokeLinecap="round" />
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

/** 平铺预览：四块小卡片。 */
function TilesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="2" />
      <rect x="13.2" y="3.2" width="7.6" height="7.6" rx="2" />
      <rect x="3.2" y="13.2" width="7.6" height="7.6" rx="2" />
      <rect x="13.2" y="13.2" width="7.6" height="7.6" rx="2" />
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

/** 置顶：图钉。 */
function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path
        d="M9 4h6m-5 0l-.9 6.1a4 4 0 0 1-1.5 2.6L6 14.4V16h12v-1.6l-1.6-1.7a4 4 0 0 1-1.5-2.6L14 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 16v4" strokeLinecap="round" />
    </svg>
  )
}

/** 多选时的小勾。 */
function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4">
      <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 导出文件名里的本地时间：20261030-185300（时区由浏览器决定，后端不再猜）。 */
function localStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
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