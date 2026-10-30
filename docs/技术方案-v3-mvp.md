# Click2Get 技术方案 v3 — 最小可用产品（MVP）

> **一句话**：一个窗口、一篇笔记、托盘常驻、复制即追加。
>
> 本文取代 v2 作为唯一实施依据。v1（Rust + egui 全原生）与 v2（Tauri 三态生命周期）
> 保留在 `docs/技术方案.md`、`docs/技术方案-v2.md` 作为决策留痕，不再是实施目标。

---

## 1. 范围

### 1.1 做什么

| # | 功能 | 验收标准 |
|---|---|---|
| F1 | 单窗口富文本编辑 | 标题/加粗/列表/代码块/撤销重做可用；中文输入法正常 |
| F2 | 监控开关 | 托盘与界面双入口；OFF 时**不读取剪贴板**、不写盘 |
| F3 | 捕获文本 | 复制文本 → 自动追加到文档末尾，**卡片里只有内容本身**（不显示时间、不显示来源进程、无边框底色） |
| F4 | 捕获图片 | 复制图片 → 原图落盘 → 缩略显示在文档里，点击可看大图 |
| F5 | 自动保存 | 防抖 500 ms；崩溃后最多丢 500 ms 的编辑 |
| F6 | 托盘常驻 | 关窗口 = 隐藏；托盘菜单：打开 / 暂停·恢复 / 退出 |
| F7 | 单实例 | 二次启动唤醒已有实例，不起第二个进程 |
| F8 | 隐私底线 | 密码管理器标记的内容不记录；**在应用内复制的任何内容也不记录**（前台窗口是本进程 → 直接跳过） |
| F9 | 多笔记 | 左栏列表按最近更新排序；「新建笔记」即时创建并切过去；重启回到上次那篇 |
| F10 | 主题 | **默认浅色**，标题栏一键切深色；选择持久化 |
| F11 | 侧栏折叠 | 标题栏 ☰ 收起/展开，状态持久化；收起时编辑区居中占满 |
| F12 | 存储位置可见 | 标题栏 ⋯ 菜单里显示数据目录、可打开/复制路径 |
| F13 | 重命名 / 删除 | 行内 hover 出铅笔与垃圾桶；重命名弹层输入，改名后**标题锁定**（不再被正文覆盖）；删除是软删除，移入 `notes/.trash` 并二次确认 |
| F14 | 图片可拖动 | 图片节点 `draggable`，可在文档里拖到别的行 |

### 1.2 明确不做（第一阶段）

归档 · 收藏 · 全文搜索 · 导出 Markdown/PDF · 缩略图管线 · 纹理 LRU ·
内容寻址之外的图片优化 · 三态内存生命周期 · 骨架屏 · 动效规范 · CF_HTML 格式保留 ·
块式虚拟滚动 · 全局热键 · 开机自启 · 多显示器 DPI 精细适配 · 笔记拖动排序 · 回收站还原 UI

> 这些不是"以后再说"的模糊清单，而是**已被决定推迟**的清单。任何一条在开发中被顺手加进来，
> 都应在提交信息里写明理由。

### 1.3 一条不能砍

**F8 是安全底线，不是功能**。砍掉它，产品会在第一次被同事演示时就把密码抄进笔记。

---

## 2. 技术栈

```
壳       Tauri 2.12（wry + WebView2，Windows 11 自带运行时）
前端     Vite + React 19 + TypeScript
编辑器   TipTap 3（@tiptap/react + @tiptap/starter-kit + 自定义 Image/CaptureBlock 节点）
样式     手写 CSS + CSS 变量（不引 UI 框架，避免体积与主题打架）
剪贴板   windows 0.62（自己写监听线程，无现成插件可用）
图像     image 0.25（PNG 编解码）
存储     serde_json + 单文件 JSON（不用 SQLite）
打包     tauri-bundler → NSIS
```

**为什么不用 SQLite**：单篇笔记 + 富文本文档，数据库会退化成一个"装一个 JSON 的容器"，
却要背 schema、迁移、连接池三份债。JSON 文件 + 原子写在本阶段是更小的解。
将来要搜索/多笔记时，`note.json` 可一次性导入 SQLite，没有迁移债。

**为什么图片走内置 `asset` 协议**：`app.security.assetProtocol` 配好 scope 后，
前端 `convertFileSrc()` 即可，不必实现自定义协议。这同时绕开了 Tauri 在 Windows 上
把自定义协议改写为 `http://<scheme>.localhost/` 的坑（见 v2 讨论）。

---

## 3. 数据与存储

### 3.1 目录

```
%LOCALAPPDATA%\com.click2get.app\
  notes\<id>.json         # 一篇笔记一个文件（TipTap JSON + pending）
  notes\<id>.json.bak     # 该篇的上一版，写坏时兜底
  notes\.trash\           # 软删除的笔记（<id>-<时间戳>.json）
  images\ab\cd\<sha256>.png
  settings.json           # 监控开关 / 主题 / 上次打开的笔记 / 侧栏折叠
  note.json.migrated      # 老版本单篇存储，首次启动自动导入后改名留档
```

- `ab\cd` 是 sha256 前四位分两级目录，避免单目录堆几十万文件。
- **不维护索引文件**：笔记列表由扫描 `notes/*.json` 得到，避免"索引和真实文件不同步"这类
  只能靠人肉修的历史包袱。几十篇的规模下扫描开销可以忽略。

### 3.2 notes/<id>.json

```json
{
  "version": 1,
  "id": "n1793329210080_6970",
  "title": "被复制的正文…",
  "createdAt": 1761792000000,
  "updatedAt": 1761792000000,
  "doc": { "type": "doc", "content": [ … ] },
  "pending": []
}
```

- `doc` 是前端编辑器的完整状态，**唯一内容源**。
- `title` 由后端从文档第一段非空文字推导（截 40 字），前端不负责命名；
  纯图片笔记会得到"无标题笔记"。
- `pending` 本阶段恒为空数组，**为"关闭窗口即销毁 WebView"预留**（见 8.1）。
  现在只占一个字段，将来改造时不必迁移存量数据。
- 文件 id 只允许 `[A-Za-z0-9_-]`，挡住 `../..` 这类路径穿越。

### 3.3 写入规则

```
写 -> <id>.json.tmp -> sync_all() -> 复制旧版为 <id>.json.bak -> rename(tmp, <id>.json)
```

`std::fs::rename` 在 Windows 上映射到 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，
可原地替换。顺序很重要：**先 sync 再 rename**，否则断电可能留下零字节的文件。

单篇文件解析失败时该篇直接退回 `pending` 空、`doc` 空（不阻塞其它笔记）；
老的单篇 `note.json` 会在首次启动时导入成第一篇笔记，成功后改名 `note.json.migrated`。

### 3.4 图片

- 落盘只存原图，不生成缩略图。显示尺寸交给 CSS（`max-width: 100%`）。
- 文件名 = `sha256(原始字节).png`；同一张图复制 10 次只占一份（3 行代码，顺手做）。
- 文档里存**相对路径** `images/ab/cd/<hash>.png`，渲染时拼数据目录 + `convertFileSrc`。
  存相对路径而不是绝对路径，是为了将来换机器/换目录时文档仍能打开。

---

## 4. 捕获链路

### 4.1 线程模型

```
[监听线程]                          [主线程 (Tauri)]
message-only 窗口                   窗口 / 托盘 / 插件
AddClipboardFormatListener
  └ WM_CLIPBOARDUPDATE
       ├ 监控 OFF? → return（不 OpenClipboard）
       ├ 前台窗口是本进程? → return（应用内复制不记）
       ├ 排除格式? → return
       ├ 文本: CF_UNICODETEXT
       ├ 图片: "PNG" → CF_DIBV5 兜底 → 落盘 + sha256
       └ emit("capture", Capture) ──────► 前端 editor 尾部插入
```

监听线程独立于 WebView 生命周期：窗口隐藏/关闭都不影响捕获。

### 4.2 关键约束

1. **监控开关是一个 `AtomicBool`，不是线程启停。** 在 `WM_CLIPBOARDUPDATE` 处理函数的
   第一行读取；OFF 时直接返回，不调用 `OpenClipboard`。这保证"关闭监控"在隐私语义上是
   "不读取"，而不是"读了但不存"。
2. **监听线程只创建一次**，`CreateWindowExW` + `AddClipboardFormatListener` + `GetMessageW`
   循环必须在同一线程内完成。销毁重建会漏事件（Windows 不重放）。
3. **`OpenClipboard` 带退避重试**：3 次 × 20 ms。对方程序临时持有剪贴板是常态。
4. **过滤顺序**（先便宜后昂贵）：监控开关 → 排除格式 → 文本长度 → 图片尺寸 → 解码。

### 4.3 过滤规则

| 规则 | 动作 |
|---|---|
| `ExcludeClipboardContentFromMonitorProcessing` 格式存在 | 跳过（密码管理器置位） |
| `Click2GetOwned` 格式存在 | 跳过（自己写的剪贴板） |
| 文本 trim 后长度 < 2 | 跳过 |
| 文本 > 1 MB | 记录但截断到 1 MB，标注"已截断" |
| 图片边长 > 8000 px 或 > 20 MB | 记录但不内联显示，只存一个"过大图片"占位块 |
| 内容 sha256 与上一条捕获相同 | 跳过（防重复触发） |
| `CF_HDROP`（复制的文件） | 忽略 |

### 4.4 自捕获防护（易漏，必须做）

前端"复制这段"按钮**不能**用 `navigator.clipboard.writeText`，否则监听线程看到的是一次
无标记的普通复制，会把自己复制的内容再记一遍。必须走 Rust 命令：

```rust
#[tauri::command]
fn copy_with_marker(text: String) -> Result<(), String> {
    // OpenClipboard → EmptyClipboard
    // → SetClipboardData(CF_UNICODETEXT, text)
    // → SetClipboardData(RegisterClipboardFormatW(w!("Click2GetOwned")), 空数据)
    // → CloseClipboard
}
```

### 4.5 不做来源追踪

**不取前台进程名，也不记录时间到界面上。** 早先方案里的
`GetForegroundWindow` → `QueryFullProcessImageNameW` 那套已删除：

- 用户明确表示笔记里不需要"哪个进程复制来的"
- 少一个每 200 ms 就要命的错误来源（进程名取不到、权限被拒、UWP 应用只给 `ApplicationFrameHost`）
- 少读取一次系统信息，隐私上更干净

`ts` 仍然写进节点的 attrs（不渲染），只为将来排序/导出留个抓手。

---

## 5. 编辑器

### 5.1 自定义节点：只有两个

**CaptureBlock** —— 一次捕获 = 一个块。外层是 `div[data-capture]`，第一个 `p` 是来源行，
CSS 用 `[data-capture] > p:first-child` 把它压到小字灰色，不需要第二个节点类型。

```ts
const CaptureBlock = Node.create({
  name: 'captureBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    ts:  { default: null },
    src: { default: null },
  }),
  parseHTML: () => [{ tag: 'div[data-capture]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-capture': '', ...HTMLAttributes }, 0],
})
```

这个 `data-capture` 属性是**唯一的前向兼容投资**：将来要升级成可折叠卡片、按块删除、
导出块流时，不用再猜"哪段是捕获的、哪段是用户手写的"。

**CaptureImage** —— 基于 `Image` 扩展，`src` 由相对路径现算：

```ts
const CaptureImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      hash: { default: null },
      path: { default: null },   // images/ab/cd/<hash>.png
    }
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', {
      ...HTMLAttributes,
      src: fileUrl(HTMLAttributes.path),   // convertFileSrc(join(dataDir, path))
      loading: 'lazy',
      'data-c2g': '',
    }]
  },
})
```

`fileUrl()` 依赖启动时通过 `invoke('get_paths')` 取到一次数据目录，缓存在模块变量里。

### 5.2 插入策略

```ts
function appendCapture(editor: Editor, cap: Capture) {
  const at = editor.state.doc.content.size   // 文档末尾
  editor.chain().insertContentAt(at, buildNode(cap)).run()
  // 注意：绝不调用 .focus()
}
```

**不要 `focus()`**。用户正在 Chrome 里复制，若插入动作把焦点抢到我们窗口，
他会发现"复制了一下，怎么跳走了"——这是最容易犯也最致命的交互 bug。
插入完成后再轻量确认：右下角 toast "已记入 · 14:32"，2 秒淡出；不闪任务栏、不弹窗。

### 5.3 追加位置

固定追加到**文档末尾**，不跟随光标。理由：跟着光标会打断用户正在写的一段话，
而且光标在文中时插入到文中会让"捕获流"的时序错乱。用户正在编辑时若滚动不在底部，
显示一个"1 条新捕获 ↓"浮标，点击滚到底。

### 5.4 撤销语义

捕获插入是一个正常的 ProseMirror 事务，会被记入撤销栈。所以 **Ctrl+Z 天然就是
"撤销上一条捕获"**（撤销一条后要重新聚焦编辑器才会生效）。不额外做撤销按钮——
但要在 toast 后面跟一句"Ctrl+Z 撤销"，让这个入口可发现。

### 5.5 手动插入（与监控开关解耦）

监控 OFF 只关闭自动捕获。手动路径**始终可用**：

- 编辑器内 `Ctrl+V` 粘贴图片 → 拦截 paste 事件，取 `File` → `invoke('save_image')` → 插块
- 拖入文件 → 同上

理由：监控 OFF 表达的是"别偷记我的东西"，不是"应用罢工"。

---

## 6. 状态机

MVP 只有**两维、四态**，没有第三态：

| | 窗口可见 | 窗口隐藏（关 X / 托盘隐藏） |
|---|---|---|
| **监控 ON** | 正常编辑 + 实时追加 | 照常捕获，追加进内存文档 |
| **监控 OFF** | 编辑可用，不捕获 | 不捕获 |

- 关窗口（X）= `api.prevent_close()` + `window.hide()`，**进程与 WebView 都不退**。
- 托盘"退出" = 真退出（唯一真正停止捕获的方式）。
- 监控开关状态持久化在 `tauri-plugin-store` 或一个 `settings.json` 里；**重启后恢复上次状态**
  （上次关着，这次仍是关着——开机自动变回 ON 会让在敏感场景里的人措手不及）。
- 重新打开监控时，在文档末尾插一条系统提示：
  `监控已恢复 · 暂停期间（14:32–15:07）的复制未记录`。
  这一行消掉绝大多数"我复制的东西怎么没记上"的投诉，成本约 10 行。

**状态必须始终可见**：窗口内一个绿点/灰点，托盘图标两套（ON/OFF 各一个）。
宁可土一点，也不能让用户不知道现在到底记不记。

---

## 7. 界面

MVP 只要一个视图 + 一个设置浮层。

```
┌──────────────────────────────────────────────────┐
│  Click2Get                            ● 监控中    │  ← 44px 标题条（自绘）
├──────────────────────────────────────────────────┤
│                                                  │
│   Rust 的 borrow checker 本质上…                  │  ← 捕获的文字：没有框，就是正文
│                                                  │
│   [ 图片 ]                                        │  ← 捕获的图片：只有图片本身
│                                                  │
│   （空白区 = 自己写的地方，光标在这里）            │
│                                        [已记入]    │  ← toast
└──────────────────────────────────────────────────┘
```

**视觉原则：捕获的内容不套任何容器。** 没有卡片、没有边框、没有底色，捕获块与用户的正文
在同一条视觉流里，只靠 18px 留白区分。这一条是用户直接要求的，不要"为了好看"加回来。

样式 token（一份 CSS 变量，别散落）：

```css
:root{
  --bg:#0E0E10; --bg-card:#16161A; --bg-hover:#1E1E23;
  --fg:#EDEDEF; --fg-dim:#A0A0A8; --fg-mute:#6B6B75;
  --accent:#5B8CFF; --line:rgba(255,255,255,.06);
  --r-card:12px; --r-ctrl:8px;
  --t:160ms cubic-bezier(.2,0,0,1);
}
```

正文 15px / 行高 1.75；`[data-capture]` 卡片 `background: var(--bg-card)`、圆角 12、
内边距 12px 16px、块间 8px 间距；来源行 12px `--fg-mute`。

---

## 8. 已知妥协（明写，不藏）

### 8.1 内存实测：124 MB（已处理 GPU 进程）

不做 v2 的三态生命周期，WebView 关窗口时**不销毁**。这是 MVP 最大的一处妥协。

M0 实测（debug 构建，Win11 / 150% DPI / 已捕获若干条）：

| 配置 | 私有内存合计 | 说明 |
|---|---|---|
| 默认（GPU 合成开） | **206 MB** | gpu-process 一项就吃掉 102.5 MB，明显异常 |
| `--disable-gpu`（当前默认） | **124 MB** | gpu-process 降到 18.2 MB，界面肉眼无差别 |

逐项（`--disable-gpu` 后）：

| 进程 | 私有内存 |
|---|---|
| click2get（主进程） | 12.5 MB |
| browser | 40.0 MB |
| renderer | 33.3 MB |
| gpu-process | 18.2 MB |
| 2 × utility | 17.5 MB |
| crashpad | 2.5 MB |

当前落在 `tauri.conf.json` → `windows[0].additionalBrowserArgs`：

```
--disable-gpu
--disable-background-networking --disable-component-update --disable-sync
--js-flags=--max-old-space-size=192
```

对这个纯文字/图片笔记应用，关掉 GPU 合成没有可感知代价（文字锐利、滚动正常），
换回来 82 MB 很划算。**如果以后要做图片密集的滚动动效，这一条要重新测。**

> 别用工作集求和对外报数：WebView2 的多个进程共享大量页面，求和会把同一块内存算七八次
> （窗口可见时工作集求和能到 470 MB）。看私有内存。

若 124 MB 仍不可接受 → 走"关闭即销毁"，`pending` 字段已预留，代价是 300–500 ms 冷启动。

若这个数字不可接受，升级路径已预留：**关闭窗口即销毁 WebviewWindow**，捕获改由 Rust
直接写 `pending` 数组（字段已存在），下次开窗时前端把 `pending` 合并进 `doc` 后清空。
届时内存回到 ~30 MB，代价是 300–500 ms 冷启动。**但不要现在做**——先有真实用户抱怨，
再决定花这 2 天。

### 8.2 单篇笔记会无限增长

不做归档、不做虚拟滚动。已知风险：超过约 1000 条捕获后滚动开始掉帧。
MVP 的缓解：文档顶部常驻一行"已记录 N 条"，到 800 条时提示"建议新建笔记"
（提示但不强制，导出/归档能力留到 v4）。真实用户到不了这个量级就会暴露真正的问题。

### 8.3 不保留复制时的格式

浏览器复制的加粗/超链接/列表进笔记后是纯文本。原因：`CF_HTML` 是外部 HTML，
清洗成本高，且是 Stored XSS 的入口（WebView + IPC 权限）。v4 再做，做时也必须白名单清洗。

### 8.4 无搜索

Ctrl+F 在 ProseMirror 里不生效，浏览器原生查找也不可用。用户只能靠滚动。
这是可接受的：单篇、按时间倒序、最近的在上……不，**按时间正序，最新的在最下**
（追加流语义）。找旧内容靠滚动，MVP 认了。

---

## 9. 里程碑

| 阶段 | 内容 | 估时 |
|---|---|---|
| **M0** | Tauri 脚手架、窗口、托盘、单实例、关窗口到托盘、`.bak` 存储骨架 | 0.5 天 |
| **M1** | 剪贴板监听线程、过滤、来源应用、emit 到前端、开关（内存 AtomicBool + 持久化） | 1 天 |
| **M2** | TipTap 编辑器 + 两个自定义节点 + 追加插入 + toast + 图片落盘与显示 | 1 天 |
| **M3** | 自动保存与恢复、暂停提示行、托盘图标两态、异常兜底、NSIS 打包 | 0.5 天 |
| **M4** | 实测校准：内存三段、中文 IME、200 条捕获滚动帧率、关窗后是否仍捕获 | 0.5 天 |

合计 **3.5 天**（单人全职）。

> M1 结束时就应该有一次"关掉窗口，去浏览器复制三样东西，再打开窗口看是不是都在"的
> 端到端验证。这一条过了，产品就成立了；剩下的都是打磨。

---

## 10. 验收清单

- [ ] 关掉窗口去 Chrome 复制文本 → 打开窗口，内容在
- [ ] 捕获的块里**看不到**时间和来源应用，也没有边框/底色
- [ ] 复制一张截图 → 图片显示在文档里，重启后仍在
- [ ] 同一张图复制 3 次 → 磁盘上只有 1 个文件，文档里有 3 个块
- [ ] 关闭监控 → 复制 5 次 → 一个都不进笔记；重开监控 → 出现"暂停期间未记录"提示
- [ ] 在 1Password 里复制密码 → 不进笔记（若本机无密码管理器，用置位该格式的测试程序验证）
- [ ] 在本应用里复制正文（Ctrl+C）→ 剪贴板有内容，但**不会**在笔记里多出任何东西
- [ ] 从记事本/浏览器复制 → 照常记入（证明上面的拦截没有误伤）
- [ ] 悬浮笔记行出现铅笔/垃圾桶；改名后标题锁定，继续编辑正文不会把名字冲掉
- [ ] 删除有二次确认；删完文件在 `notes/.trash`，列表里消失，当前笔记自动切到下一篇
- [ ] 图片能拖到别的行（ProseMirror 原生拖拽）
- [ ] 点暂停/恢复监控 → 笔记内容**不发生变化**
- [ ] 复制时应用窗口在后台 → **不抢焦点**，只弹 toast
- [ ] 编辑到一半强制结束进程 → 重启后最多丢 0.5 秒的编辑
- [ ] 二次启动 exe → 不出现第二个进程，已有窗口被唤醒
- [ ] 中文输入法：输入"测试一下"，候选框定位正确，无重复上屏
- [ ] 200 条捕获的文档，滚动帧率 ≥ 50 fps
- [ ] 窗口隐藏 10 分钟后任务管理器内存 ≤ 150 MB

---

## 11. 与 v1 / v2 的关系

| 决策点 | v1 | v2 | **v3（本文）** |
|---|---|---|---|
| 渲染 | egui 自绘 | WebView2 | WebView2 |
| 编辑器 | 块流自绘 | TipTap 块卡片 | TipTap（块卡片简化为 `div[data-capture]`） |
| 存储 | SQLite | SQLite | **单 JSON 文件** |
| 生命周期 | 单进程常驻 | 三态 | **两维四态，不做挂起** |
| 内存（隐藏） | 22–30 MB | ≤35 MB | **110–150 MB（明写妥协）** |
| 工期 | 2 周 | 2.5 周 | **3.5 天** |

v3 的判断是：**先把产品跑到用户手里，用真实抱怨决定该往内存砸时间还是往功能砸时间。**
v1 的 egui 路线仍然是内存真正不够时的正确答案，代码不必重写——`note.json` 可以直接
被 egui 版本读入（把 `captureBlock` 摊平成块即可）。