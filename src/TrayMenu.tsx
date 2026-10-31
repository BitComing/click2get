import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type Boot = {
  settings: { monitoring: boolean; theme: string }
}

/**
 * 托盘弹窗：右键系统托盘图标弹出来的那个小菜单。
 *
 * 它跑在一个独立窗口里（label = "tray"，见 src-tauri/src/tray.rs），
 * main.tsx 按窗口 label 决定挂 App 还是它。
 *
 * 为什么不用系统原生菜单：原生菜单点任何一项都会收起来，而"监控"这一行
 * 需要点完之后菜单还在（常常要连点两下确认状态）。所以这里用 HTML 自己画。
 */
export default function TrayMenu() {
  const [monitoring, setMonitoring] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    // html 也要标上：透明窗口里 html/body 任何一层有底色，圆角外面就是一圈方框
    document.documentElement.classList.add('tray-body')
    document.body.classList.add('tray-body')
    return () => {
      document.documentElement.classList.remove('tray-body')
      document.body.classList.remove('tray-body')
    }
  }, [])

  /** 每次弹出来都读一遍真实状态：弹窗是常驻的，状态可能在水面下变过。 */
  const sync = useCallback(async () => {
    try {
      const b = await invoke<Boot>('bootstrap')
      setMonitoring(b.settings.monitoring)
      setTheme(b.settings.theme === 'dark' ? 'dark' : 'light')
    } catch {
      /* 读不到就按默认走，不影响点按钮 */
    }
  }, [])

  useEffect(() => {
    void sync()
    const un1 = listen('tray-shown', () => void sync())
    const un2 = listen<boolean>('monitor-changed', (e) => setMonitoring(e.payload))
    const un3 = listen<string>('theme-changed', (e) =>
      setTheme(e.payload === 'dark' ? 'dark' : 'light'),
    )
    return () => {
      un1.then((f) => f())
      un2.then((f) => f())
      un3.then((f) => f())
    }
  }, [sync])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Esc = 收起弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      invoke('hide_tray_popup').catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** 点监控那一行：只切状态，不收弹窗。 */
  const toggleMonitoring = async () => {
    try {
      setMonitoring(await invoke<boolean>('toggle_monitoring'))
    } catch {
      /* 切不动就保持原样，下一次点还能再试 */
    }
  }

  const close = () => {
    invoke('hide_tray_popup').catch(() => {})
  }

  return (
    <div className="tray-menu" role="menu" aria-label="Click2Get">
      <button
        className="tray-item"
        role="menuitem"
        onClick={() => {
          invoke('tray_new_note').catch(() => {})
        }}
      >
        新建笔记
      </button>
      <button
        className="tray-item"
        role="menuitem"
        onClick={() => {
          invoke('toggle_main_window').catch(() => {})
          close()
        }}
      >
        打开 / 关闭窗口
      </button>
      <button
        className="tray-item"
        role="menuitemcheckbox"
        aria-checked={monitoring}
        title="剪贴板监控开关（点了菜单不会收起来）"
        onClick={() => void toggleMonitoring()}
      >
        <span className={`dot ${monitoring ? 'on' : ''}`} />
        {monitoring ? '监控中' : '已暂停'}
        <span className="tray-state">{monitoring ? '点此暂停' : '点此恢复'}</span>
      </button>
      <div className="tray-sep" />
      <button
        className="tray-item danger"
        role="menuitem"
        onClick={() => {
          close()
          invoke('quit_gracefully').catch(() => {})
        }}
      >
        退出 Click2Get
      </button>
    </div>
  )
}