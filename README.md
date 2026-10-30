# Click2Get

剪贴板捕获式笔记工具 · Windows · Tauri 2 + TipTap

> 实施方案见 [`docs/技术方案-v3-mvp.md`](docs/技术方案-v3-mvp.md)。

## 现在能做到什么

- 开着监控 → 系统里任何地方复制文字/图片，自动追加到**当前打开的笔记**末尾
- **在应用内复制不会记进笔记**（前台是自己的窗口就直接跳过）
- 笔记里的捕获就是正文：不带时间、不带来源进程、没有卡片边框
- 关掉监控 → 完全不读取剪贴板（不是读了不存）；切换监控不会往笔记里插任何提示
- 多笔记：左栏列表（最近编辑在最上）+ 「新建笔记」，hover 出行内的重命名 / 删除
- 删除是软删除，移入 `notes/.trash`；改名后标题锁定，不会被正文覆盖
- 图片可以拖到别的行
- 默认浅色主题，标题栏一键切深色；☰ 可折叠侧栏；⋯ 菜单里能看到数据目录
- 关窗口 → 收进托盘，捕获照常；托盘图标绿/灰表示当前状态
- 自动保存，崩了最多丢 0.5 秒的编辑

## 环境

| 项 | 版本 |
|---|---|
| tauri | 2.12.5 |
| tauri-build | 2.7.4 |
| tauri-plugin-single-instance | 2.5.5 |
| windows (crate) | 0.62.2 |
| WebView2 Runtime | 156.x（Win11 自带） |
| Rust | 1.96 |
| Node | 22 |

## 开发

```powershell
pnpm install          # 前端依赖
pnpm build            # 产出 dist/
cd src-tauri
cargo build           # 把 dist 嵌进 exe（缺这步改动不会生效）
cargo run
```

> **注意**：Tauri 会把前端产物**编译进 exe**。只跑 `pnpm build` 不重编 Rust，
> 界面改动不会出现——这是本项目最容易踩的坑。改前端后一律 `pnpm build && cargo build`。

打包（需要先装 CLI：`cargo install tauri-cli --version 2.12.4`）：

```powershell
cd src-tauri
cargo tauri build
```

## 数据

```
%LOCALAPPDATA%\com.click2get.app\
  notes\<id>.json        # 一篇笔记一个文件（TipTap JSON）
  notes\<id>.json.bak    # 上一版兜底
  notes\.trash\          # 软删除的笔记躺在里面
  images\ab\cd\<sha256>.png
  settings.json          # 监控开关 / 主题 / 上次打开的笔记 / 侧栏折叠
```

点标题栏右上角 ⋯ 可以直接打开这个目录、或把路径复制走。

## 代码地图

| 文件 | 职责 |
|---|---|
| [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | 应用装配、命令（bootstrap/save_note/set_monitoring…）、窗口与退出握手 |
| [`src-tauri/src/clipboard.rs`](src-tauri/src/clipboard.rs) | Win32 剪贴板监听线程、过滤、图片解码、自捕获标记 |
| [`src-tauri/src/storage.rs`](src-tauri/src/storage.rs) | note.json 原子写、.bak 兜底、图片内容寻址 |
| [`src-tauri/src/tray.rs`](src-tauri/src/tray.rs) | 托盘双态图标与菜单 |
| [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs) | 监控开关持久化 |
| [`src/App.tsx`](src/App.tsx) | 界面、捕获事件订阅、自动保存、退出落盘 |
| [`src/editor/extensions.ts`](src/editor/extensions.ts) | `captureBlock` 节点 + 图片节点（相对路径 → asset URL） |
| [`src/editor/insert.ts`](src/editor/insert.ts) | 捕获 → 节点 JSON、追加、系统提示 |

## 已知妥协

- 常驻内存实测 **124 MB**（私有内存合计；已用 `--disable-gpu` 从 206 MB 压下来）。
  想更低就要改成"关窗口即销毁 WebView"，`note.json` 的 `pending` 字段已为此预留。
- 单篇笔记无限增长，约 1000 条后滚动会掉帧。
- 不保留复制时的格式（纯文本落地）。