import React from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App'
import TrayMenu from './TrayMenu'
import './styles.css'

/**
 * 同一个前端跑在两个窗口里：主窗口（label = "main"）和托盘弹窗（label = "tray"）。
 * 托盘弹窗只是个小菜单，不需要整篇笔记的界面，所以按 label 分开挂载。
 * 在浏览器里直接开 vite（没有 Tauri 注入）时拿不到 label，按主窗口处理。
 */
function windowLabel(): string {
  try {
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {windowLabel() === 'tray' ? <TrayMenu /> : <App />}
  </React.StrictMode>,
)