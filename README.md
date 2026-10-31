# Click2Get

剪贴板捕获式笔记工具 · Windows · Tauri 2 + TipTap

> 实施方案见 [`docs/技术方案-v3-mvp.md`](docs/技术方案-v3-mvp.md)。

## 现在能做到什么

- 开着监控 → 系统里任何地方复制文字/图片，自动追加到**当前打开的笔记**末尾
- **在应用内复制不会记进笔记**（前台是自己的窗口就直接跳过）
- 笔记里的捕获就是正文：不带时间、不带来源进程、没有卡片边框。**复制来的多行文字一行一个段落**（行就是编辑单位），原文的空行不留 —— 内容与内容之间是换行，不是空行；`\r`、U+2028 这些不常见的换行符也认
- 关掉监控 → 完全不读取剪贴板（不是读了不存）；切换监控不会往笔记里插任何提示
- 多笔记：左栏列表（最近编辑在最上）+ 「新建笔记」，hover 出行内的重命名 / 删除；切笔记不会重排列表，只有正文真改了才刷新排序
- 删除是软删除，移入 `notes/.trash`；改名后标题锁定，不会被正文覆盖
- 图片可以**长按拖动**到任意行：按住约 0.26 秒图会"抬起来"跟着指针走，蓝线标出落点，松手就插到那条线上（拖到内容最下面也行）。落点提示只画在**真能放下**的位置——拖着自己的那几行（或图片独占的那一行）时不会画线，免得松手才发现什么都没动；**一条缝里只有一个提示**：两行之间 14px 的段间距算一个插入位置，线画在缝的中点，指针在上半还是下半都不会冒出第二条线（`editor/dropLine.ts`）
- 图片**缩放**：点一下选中 → 右侧两个蓝色手柄拖着改宽度（拖动时显示 px 值）；也可以**右键**弹菜单：在图片库中查看 / 备注… / 识别文字（OCR）/ 默认宽度 / 适应宽度 / 一半宽度 / 原始大小 / **删除图片**。文档里只存 `width`，高度交给 `height:auto`，比例永远不会被拉变形
- 图片**默认宽度 420 px**（比正文一栏窄一截）：长截图不再一上来就铺满一屏；拖过宽度之后右键「默认宽度」可以还原，「原始大小」按原图像素显示
- 图片**备注**：备注属于**图片本身**，不显示在笔记正文里（图下没有灰字，正文只有图和字）。右键「备注…」或**双击图片**可以看图/改；真正的管理入口在图片库 —— 备注存在 `images/.../<hash>.json`，同一张图在两篇笔记里看到的是同一份
- 图片**OCR**：右键「识别文字（OCR）」，用 Windows 自带的识别引擎（离线、不加包体）把字认出来，结果放在一个弹层里 —— 可以**复制**走，也可以**插入到笔记**，**不会**自动写进备注
- **搜索**：`Ctrl+F` 或标题栏放大镜，搜所有笔记的**正文和图片备注**；正文命中选词、图片备注命中直接选中那张图；没被任何笔记引用的图，点结果就进图片库
- 编辑手感：Enter / Backspace / Delete 只认「行」——一次退格正好并掉一行（跨捕获块也一样），回车就在原地拆行，光标在空行上退格那一行就真的没了（不会删完又补回来）；空行严格等于一行高，段间距统一，删空的块会自动消失
- **Ctrl+A 分两段**：先选中光标所在的**这一行**，再按一次才全选（行是编辑单位，一上来全选太容易误伤整篇）
- 选中文字的**右键菜单**里可以把两种"换行"互相转：**拆解成多行**把行内换行（Shift+Enter / 复制进来的换行）拆成单独的行；**合并多行**把选中的几行并成一行、行间用行内换行分隔
- **链接**：正文里的网址自动变蓝可点，点了用系统默认浏览器打开（编辑器本身不导航）；复制网页上的链接文字时，会读剪切板的 CF_HTML，把「标题 → 网址」做成文字超链接
- **图片库**：标题栏的图片按钮打开，缩略图预览所有存过的图；两种看法——
  - **按时间**：所有图一条时间线，可切最新/最早；
  - **按笔记**：按"被哪篇笔记引用"分组，组标题可以直接跳过去，也可以**真实删除那篇笔记**（从磁盘删掉，不进回收站）
  - **备注管理**：有备注的图右下角挂一个「备注」小标，点它打开大图 + 备注编辑区；大图里也能随时展开备注（清空 = 删掉备注）
  - 多选后可**插入到当前笔记**（追加到末尾），或**用这些图新建一篇笔记**
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

拖图的落点/换位逻辑是纯函数（不依赖 DOM），可直接用 Node 跑回归：

```powershell
node docs\test-image-drag.ts
```

行级编辑（Enter / Backspace / Delete）同样是纯函数，回归脚本覆盖了块内、跨块、块外段落、图片相邻等位置，外加 400 组随机文档的行数不变量：

```powershell
node --experimental-strip-types docs\test-line-ops.ts
```

行内换行 ↔ 单独的行（右键「拆解成多行 / 合并多行」）、Ctrl+A 的两段式选择、拖拽落点提示能不能画、落点线到底画在哪条缝里，也都有纯函数回归：

```powershell
node --experimental-strip-types docs\test-row-ops.ts
node --experimental-strip-types docs\test-drop-line.ts
```

复制进来的多行文字怎么落成行、复制出去的纯文本怎么留换行，各有一个回归：

```powershell
node --experimental-strip-types docs\test-insert.ts
node --experimental-strip-types docs\test-copy-text.ts
```

打开笔记时的规整也有一条，重点是**幂等**（跑一遍和跑十遍结果必须一样）——
否则"打开一次多一层段落"这种问题会随着每次打开悄悄累积：

```powershell
node --experimental-strip-types docs\test-normalize.ts
```

> **注意**：Tauri 会把前端产物**编译进 exe**。只跑 `pnpm build` 不重编 Rust，
> 界面改动不会出现——这是本项目最容易踩的坑。改前端后一律 `pnpm build && cargo build`。

## 打包

CLI 已作为 devDependency 锁定在 `@tauri-apps/cli@2.12.4`（与 tauri 2.12.5 配套），无需再 `cargo install`。

```powershell
pnpm dist             # = vite build && tauri build，一条命令出安装包
```

产物（`src-tauri/target/release/`）：

| 文件 | 说明 |
|---|---|
| `click2get.exe` | 单文件绿色版，3.96 MB，双击即用（依赖系统 WebView2） |
| `bundle/nsis/Click2Get_0.1.0_x64-setup.exe` | NSIS 安装包，1.58 MB，装到 `%LOCALAPPDATA%\Click2Get`，免管理员 |
| `bundle/Click2Get_0.1.0_x64_portable.zip` | 便携版压缩包，1.86 MB（`Compress-Archive` 手动重打，只含 exe） |

首次打包会自动下载 NSIS（~1.5 MB）到 `%LOCALAPPDATA%\tauri`，之后离线可打。全量 release 编译约 3 分钟（`lto` + `opt-level=s`）。

> **注意**：`pnpm dist` 只更新 `target/release/`，**不会**更新已安装的副本。
> 桌面/开始菜单快捷方式指向 `%LOCALAPPDATA%\Click2Get\click2get.exe`，那个文件要等
> 重跑 setup.exe 才会被替换。验证新版本时别去点快捷方式，直接开 `target/release/click2get.exe`。
> 另外应用带 `tauri-plugin-single-instance`：旧实例还在跑时，双击新 exe 只会把旧窗口拉到前台
> 然后自己退出，看着就像"改动没生效"。换 exe 前先退掉旧进程。

## 数据

```
%LOCALAPPDATA%\com.click2get.app\
  notes\<id>.json        # 一篇笔记一个文件（TipTap JSON）
  notes\<id>.json.bak    # 上一版兜底
  notes\.trash\          # 软删除的笔记躺在里面
  images\ab\cd\<sha256>.png
  images\ab\cd\<sha256>.json   # 这张图的备注（有备注才存在）
  images\.trash\         # 图片库里删掉的图躺在这里
  settings.json          # 监控开关 / 主题 / 上次打开的笔记 / 侧栏折叠
```

点标题栏右上角 ⋯ 可以直接打开这个目录、或把路径复制走。

## 代码地图

| 文件 | 职责 |
|---|---|
| [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | 应用装配、命令（bootstrap/save_note/purge_note/open_url…）、窗口与退出握手 |
| [`src-tauri/src/clipboard.rs`](src-tauri/src/clipboard.rs) | Win32 剪贴板监听线程、过滤、图片解码、自捕获标记、CF_HTML 里的链接 |
| [`src-tauri/src/storage.rs`](src-tauri/src/storage.rs) | note.json 原子写、.bak 兜底、图片内容寻址、图片备注 sidecar（读写 + 旧数据搬家）、图片库扫描/软删除/真删除、用图建笔记、全文搜索（正文 + 图片备注） |
| [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs) | 图片 OCR：Windows.Media.Ocr，离线识别，汉字之间的 OCR 空格会压掉 |
| [`src-tauri/src/tray.rs`](src-tauri/src/tray.rs) | 托盘双态图标与菜单 |
| [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs) | 监控开关持久化 |
| [`src/App.tsx`](src/App.tsx) | 界面、捕获事件订阅、自动保存、退出落盘、图片右键菜单、备注/OCR 弹层、搜索跳转 |
| [`src/SearchPanel.tsx`](src/SearchPanel.tsx) | 全局搜索弹层：输入防抖、结果高亮、键盘上下选 |
| [`src/ImageLibrary.tsx`](src/ImageLibrary.tsx) | 图片库弹层：按时间 / 按笔记两种视图、备注管理、多选、插入笔记、用图建笔记、删笔记、大图预览 |
| [`src/editor/extensions.ts`](src/editor/extensions.ts) | `captureBlock` 节点（空块自动清理）、图片节点（相对路径 → asset URL、只下发 width；备注不在这里）、`TrailingLine`（只在图收尾时补一行） |
| [`src/editor/lineOps.ts`](src/editor/lineOps.ts) | 行级编辑：Enter 就地拆行、Backspace/Delete 一次并一行（跨捕获块也行）、Ctrl+A 先选这一行再全选，纯函数（`docs/test-line-ops.ts` 覆盖） |
| [`src/editor/lineBreaks.ts`](src/editor/lineBreaks.ts) | 行内换行 ↔ 单独的行：右键「拆解成多行 / 合并多行」的文档变换（纯函数，`docs/test-row-ops.ts` 覆盖） |
| [`src/editor/normalize.ts`](src/editor/normalize.ts) | 打开笔记时规整文档：把旧数据里被 lift 到块外的段落收回捕获块、块级图片包一层段落（段落里的行内图**不动**）；纯函数，必须幂等 |
| [`src/editor/search.ts`](src/editor/search.ts) | 搜索结果在编辑器里定位：正文选词 / 按 hash 选中图片、滚过去 |
| [`src/editor/dragMove.ts`](src/editor/dragMove.ts) | 长按拖动（图 / 整行 / 选中的几行）：指针接管、ghost、落点指示线、原位置灰线、拖进侧栏笔记 / 新建笔记 / 垃圾图标、自动滚动 |
| [`src/editor/dropLine.ts`](src/editor/dropLine.ts) | 落点线画在哪条缝里：只看插入位置（上下邻居的中点），一条缝只有一个提示（纯函数，`docs/test-drop-line.ts` 覆盖） |
| [`src/editor/clipboard.ts`](src/editor/clipboard.ts) | 复制出去的纯文本：空行不留、内容之间的换行照留（纯函数，`docs/test-copy-text.ts` 覆盖） |
| [`src/editor/moveImage.ts`](src/editor/moveImage.ts) | 拖图的换位事务（纯函数，`docs/test-image-drag.ts` 覆盖） |
| [`src/editor/imageResize.ts`](src/editor/imageResize.ts) | 选中图片后的虚线框 + 缩放手柄（拖动改 width，Esc 取消） |
| [`src/editor/imageActions.ts`](src/editor/imageActions.ts) | 图片的选中 / 改宽 / 删除 / 内容宽度（右键菜单和缩放手柄共用） |
| [`src/editor/moveRange.ts`](src/editor/moveRange.ts) | 搬"几整行"的换位事务：整行对齐、开口 slice 不搬、空块清掉（纯函数，`docs/test-move-range.ts` 覆盖） |
| [`src/editor/insert.ts`](src/editor/insert.ts) | 捕获 → 节点 JSON（一行一个段落、空行不留、网址自动成链、链接文字带 href）、追加 |

## 已知妥协

- 常驻内存实测 **124 MB**（私有内存合计；已用 `--disable-gpu` 从 206 MB 压下来）。
  想更低就要改成"关窗口即销毁 WebView"，`note.json` 的 `pending` 字段已为此预留。
- 单篇笔记无限增长，约 1000 条后滚动会掉帧。
- 不保留复制时的格式（纯文本落地）。