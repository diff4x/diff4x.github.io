# [diff4x's digital swamp](https://github.com/diff4x/diff4x.github.io)

> 个人数字信息库
>
> <img src="https://avatars.githubusercontent.com/u/222525381?v=4" width="200">

本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航

> 静态设计：初代 by diff4x | 进化 by Gemini & Claude & ChatGPT & Grok

---

# 访客如何高效使用

## 1. 界面布局

整个站点是一个单页外壳：左侧是内容区，右侧是目录树（可点顶部 `←` / `→` 调宽），搜索框固定在右侧栏左上方。

- **侧边栏目录**：分类名旁会标注 `[近期更新数/总数]` 或 `[总数]`（72 小时内更新的条目会高亮）。
- **已阅标记**：每条目录右侧有 `[Mark]` / `[UnMark]`，标记后条目加删除线，存在本地浏览器里。
- **快捷操作**：
  - 悬停图片/视频条目显示缩略图；双击条目文字复制文件名。
  - 在侧边栏内**右键单击**呼出全局书签菜单；**右键双击**呼出浏览器原生菜单。
- **书签页链接**：
  - `street_view_uploader`：google 全景图上传器（新标签页中打开）。
  - `txn_parser`：流水解析器（新标签页中打开）。
  - `⚪ go_board`：摆谱（新标签页中打开）。
  - `❓ README`：即你所见（左击调用 md 阅读器，中击跳转线上仓库）。
  - `❓ guestbook`：留言板（免登录；新标签页中打开）。
- **侧栏顶部菜单**：
  - `What's new?`：查看站点文件更新记录与最新评论（点击条目直接定位）。
  - `History`：最近 50 条浏览记录。
  - `Fav`：音乐收藏夹（有收藏时出现）。
  - `Excerpts`：摘抄本，按文章/书名归档管理。

## 2. 高效搜索

- **呼出与收起**：任意位置按 `\` 聚焦搜索框（在 PDF / EPUB 中也可按 `Ctrl+F` 直接搜本书）；点 `clear` 或在搜索组件内**鼠标中击**收起；右键点击搜索历史条目可删除该条记录及对应缓存。
- **搜全站 vs 搜本书**：打开 TXT / PDF / EPUB 时自动切到「搜本书」，命中按章节或页段分组；点击搜索工具条或阅读器上的按钮可随时切回「搜全站」。
- **结果预览**：
  - HTML 与电子书结果：鼠标悬停看命中上下文，**右键**切换自动滚动/暂停。
  - 图片结果：鼠标悬停看大图预览。
  - 音视频结果：**右键**直接弹窗播放或暂停，带倒计时且自动记住播放进度。
- **筛选与按时间查**：
  - 搜索工具条可按文件后缀过滤，HTML 结果额外支持按「年月」筛选。
  - HTML 页面时间戳与 `gallery/拍摄` 文件名统一采用 `YYYYMMDDHHMMSS`，搜 `202610` 或 `2610` 即可定位 2026 年 10 月的条目。
  - 命中评论的条目会标 `[💬 数量]`；带 `🔒` 的条目为作者本地私密内容，线上无法查看。
- **容错（噪值 0 到 5）**：允许搜索词相邻字符之间夹杂无关字，单个空格不计噪，换行与句末标点不可跨越。实际生效上限随词长缩放为 $\min(\text{noise}, \text{len} > 25 ? 0 : \lfloor \text{len} / 2 \rfloor)$。以噪值 3 为例：

  | 搜索词长度 | 1 | 2–3 | 4–5 | 6–25 | $\ge 26$ |
  | :--- | :---: | :---: | :---: | :---: | :---: |
  | 字间最多夹杂无关字数 | 0 | 1 | 2 | 3 | 0 |

- **近义词**：勾选「近义」后，会基于词林与全站词频自动扩展近义词（近义词强制精确匹配，不叠噪值）。
- **布尔组合搜索**：以 `@[...]` 开头进入组合模式，支持 `&`（且）、`|`（或）、`!`（非）和 `()`，最多 26 个单字母形参（`a` 到 `z`），表达式不能在空文档上恒真（至少需包含一个正向词）。
  - 示例：`@[a&!(b|c)]飞机[31]大炮[]机枪[0]`
  - 含义：包含「飞机」且不包含「大炮」或「机枪」。
  - 词后方括号格式：`[]` 用全局噪值和近义；`[N]` 指定噪值 $N \in [0, 5]$；`[NM]` 同时指定噪值 $N$ 与近义开关 $M \in \{0, 1\}$。

## 3. 阅读、标注与播放

- **HTML 正文**：
  - 左上角 `diff` 可选任意两个历史版本比对改动（最多保留 10 个历史快照）。
  - 双击代码块可进入临时编辑，右上角一键复制；点击图片进灯箱（支持滚轮缩放与拖拽）。
  - 线上模式左上角点击 `💬` 可用 GitHub 账号评论。
- **拼音与摘抄**：在 HTML、PDF、EPUB、TXT、README 中，划选**单个汉字**浮现拼音，划选**两个及以上字符**弹出摘抄按钮，写入 `Excerpts`。
- **全屏与壁纸**：图库、视频、PDF、EPUB、TXT 下**鼠标中击**切换全屏；图库中点 `As Wallpaper` 收藏壁纸，在书签页右下角 `🎨` 管理轮播；图库中以 `pano_` 开头的文件双击进入全景浏览。
- **音视频**：音频播放器支持收藏与循环模式，左上角 `🎵` 单击显隐、双击销毁；`.mkv` 视频支持自动挂接同名 `.vtt` 字幕，按左右方括号 `[` `]` 微调字幕延迟，步长 $\pm 0.5\text{ s}$。
- **移动端虚拟触控板**：触屏设备自动加载底部虚拟触控板，支持光标移动、缩放（`+`/`-`）、`▲`/`▼` 滚屏、`暂停跟随`、`框选`、`拖拽`、`左双击`、`中击`、`右击` 及可拖动的 `收起/展开` 按钮（同时适配正文、侧栏与 README 浮窗）。

## 4. 备份与异常修复

- **备份与迁移**：搜索框输入 `@bomb` 回车可选择性保留/导出用户数据（收藏、已阅、历史、进度、摘抄等）并清库；输入 `@rebirth` 回车可导入之前导出的 `.json` 备份恢复。系统每 7 天会提醒一次备份。
- **页面异常**：在网址后加 `?repair=1` 访问，可重置缓存与索引库（会保留摘抄、已阅标记等用户数据）。

---

# 作者怎么常规维护

本地运行与构建全部收口在单个原生程序 `_build/swamp.exe`（不依赖 Java、Node、esbuild、cwebp 等外部工具）。

## 1. 日常启动与桌面控制台

直接双击 `_build/swamp.exe`，无黑窗启动本地伴生服务（默认 `http://127.0.0.1:8000`）并打开桌面管理窗：

- **任务栏图标颜色**：实时反映 VPN 心跳状态（绿灯在线 / 红灯离线）。
- **底部实时日志**：最新日志在最上方，自动落盘到 `_build/temp/swamp_runtime.log`；下次启动会续接上次日志，中间以带时间戳的虚线分隔。
- **安全关闭**：关闭窗口会等待正在执行的写盘/构建完成，并自动回收可能运行中的 `simulator` 子进程。

管理窗分为 4 个标签页：

| 标签页 | 常用按钮与作用 |
| :--- | :--- |
| **常规与媒体** | `Open Site`（带随机令牌打开本地站点）、`gen`（全量构建）、`gen + push` / `push`（填写 Commit 后自动检测暂存改动并提交推送）、`simulator (9000)`（隐身窗仿真线上环境）、`selfcheck`（运行 42 项自检）、`root/`（打开仓库目录）、`重授 Google Tasks`；下方集成 `new`（新建 HTML）、`转webp`（批量压缩截图并复制文件名）、`keep2html`（Keep 导出包转 HTML）。 |
| **打包给 AI** | 三态目录树勾选源码，支持预设增删改（存于 `_build/swamp.toml`）、一键勾选 Git 改动、文件名过滤；勾选 `拼接 MD` 并设定单文件上限（默认 200 KB）可同步输出分卷 `.md`，方便在不支持上传 `.zip` 的 AI 界面中使用。 |
| **回填补丁** | 左侧浏览或拖入 AI 返回的补丁 `.zip` 预览并一键回填（覆盖前自动备份，可选编码守卫、回填后等 `swamp.exe` 安全退出再拉起 `build.bat`）；支持按快照一键回滚；右侧显示 `_build/temp/backup` 目录树，可勾选清理冗余的历史打包和备份。 |
| **同义词与新词** | 左侧直接编辑 `_build/swamp.toml` 中的自定义同义词 JSON 并保存/重建 `synonyms.js`（重建后自动 `gen` 一次）；右侧查看构建期生成的 `oov_report.txt` 新词雷达。 |

## 2. 站内本地写能力

通过管理窗 `Open Site` 打开本地站点后，以下改动直接原子落盘，无需手动改文件：

- **HTML 编辑与热重载**：文章左上角点 `edit` 会直接拉起 VS Code 并更新 `#anchor` 时间戳，同时按钮变为 `edit ●` 开启监听；VS Code 每次 `Ctrl+S` 保存后页面自动刷新并回到原滚动位置（右键 `edit ●` 可停止监听）。双击右上角标题可手动重载。
- **书签编辑**：在书签页内直接拖入外部链接，或把链接拖到其他区块 / `del` 区即可增删移。
- **README 编辑**：书签页左击 `README` 弹出左右分栏 Markdown 编辑器，`Save` 或 `Ctrl+S` 原地保存（中击跳转线上仓库）。
- **双语页固化**：双语编辑草稿自动暂存，点固化后剥离运行期节点写回原 HTML 并仅刷新当前页。
- **前端源码热压缩**：本地服务启动后会自动监听 `src/js/raw/`、`src/css/raw/`、`src/css/font/`，保存后 300 ms 自动热压缩到目标位置（`gen` 运行期间自动避让）。
- **侧栏本地入口**：额外显示 `KaTrain`；`txn_parser` 会自动读取 `_build/privy/txn.txt`，点击行号可直接用 VS Code 跳到对应行。

## 3. 内容书写与命名约定

- **HTML 写法**：正文直接写在 `<pre>` 内即可，无需 `<br>`。
  - `#` 加空格自动转各级标题并生成目录；行首 4 / 8 / 12 / 16 个空格缩进自动块级着色。
  - 独立成行的图片名（默认去 `gallery/img/` 找）与 `http(s)://` 链接自动渲染为 `<img>` / `<a>`。
  - `<p>` 内按 `|` 分列自动渲染表格；`<code 语言>` 自动触发 Prism 高亮。
- **特殊文件名前缀**：
  - **单下划线 `_xxx.html`**：超大文档。正文不进 `fat_data` 切片也不进 SW 缓存包，但页内可搜；标题仍参与全站检索。
  - **双下划线 `__xxx.html`**：私密文档。必须匹配 `.gitignore`（默认开启 `private_prefix_check` 强制核验），正文只进本地 `shadow_data`，绝不进入公网产物。
  - **`pano_xxx`**：`gallery/` 下以此开头的图片识别为全景图。
- **Keep 转 HTML**：笔记中用 `[[IMG1]]`、`[[IMG2]]` 标记配图位置。`single` 模式需同时打 `single` 标签和分类标签；`merge` 模式按共同标签合并为一篇。覆盖同名旧 HTML 前会自动备份。
- **同义词调优**：
  - 只读底表位于 `_build/swamp-server/assets/cilin.txt`（`=` 等义扩词，`#`/`@` 仅留作分词保护）。
  - 自定义规则在 `_build/swamp.toml` 的 `[synonyms]` 区块维护：`groups`（双向同义组，`exclusive` 默认为 `true` 覆盖词林旧义）、`aliases`（单向别名，不反向污染）、`stopExpand`（禁止扩词的技术词）、`dropEqCodes`（整行降级）、`pruneWords`（按行剔词）、`splitFixes`（修复粘连词）。
  - 常用 5 位分类码（`c5`）：AI/算法 `Dk01A`、网络/编程 `Dd06A`、电脑/机械 `Bo01A`、手机/电路 `Bo04A`、影视 `Dk29D`、音乐 `Dk28A`/`Dk28B`、徒步 `Fb01A`、装备 `Bp29D`。
  - DF 分桶权重（$N$ 为公开 HTML 总数）：

    | 后缀 | 出现文档数条件 | 候选乘数 | 义项消歧加分 | 含义 |
    | :--- | :--- | :---: | :---: | :--- |
    | 无后缀 | $DF = 0$ | 0.62 | $+0.00$ | 公开正文未出现，保留入口 |
    | `:1` | $DF = 1$ | 1.00 | $+0.25$ | 孤篇专词或媒体名 |
    | `:2` | $2 \le DF \le 3$ | 1.12 | $+0.45$ | 低频高区分度词 |
    | `:3` | $DF \ge 4$ 且 $DF / N \le 8\%$ | 1.18 | $+0.60$ | 主题特征词（权重最高） |
    | `:4` | $8\% < DF / N \le 20\%$ | 1.00 | $+0.35$ | 常见实词 |
    | `:5` | $20\% < DF / N \le 40\%$ | 0.68 | $+0.10$ | 偏泛词，轻度降权 |
    | `:6` | $DF / N > 40\%$ | 0.38 | $+0.00$ | 全站高频泛词，强降权 |

## 4. 配置文件与重新编译

- **公共配置**：`_build/swamp.toml`（入库）。
- **本机私有配置**：`_build/privy/local.toml`（被 `.gitignore` 忽略），填写本机 `vscode_path`、`katrain_dir`、`img_input_dir`、`webp_output_dir2`、`keep_takeout_zip_folder` 等含本机路径的项。
- **重编译**：运行 `_build/swamp-server/build.bat`：
  - `[1]` 编译 `_build/swamp.exe`，跑完 42 项 `--selftest` 后自动拉起新 `swamp.exe` 并 3 秒后退出。
  - `[2]` 用 `wasm-pack` 编译 Wasm 并用 `swamp.exe minify` 压缩胶水脚本，无错 3 秒后退出。
  - `[3]` 全部编译并启动新 `swamp.exe`。任何一步出错都会停住窗口看报错。

---

# 怎么与AI协作进行站点调优

这一章分两版：**版 A** 用大白话讲清楚前后端和构建的来龙去脉，方便作者自己随时翻看；**版 B** 写给 AI 看，交代精确的架构、边界和协作规矩。

---

## 版A：通俗理解（给作者自己看）

### 1. 这个站到底是怎么跑起来的？

一句话：**线上没有任何程序在跑，全靠浏览器自己干活；本地所有脏活累活全交给 `_build/swamp.exe` 一个人干。**

- **平时写作和改代码（本地）**：你改的是 `html/` 里的原文、`src/js/raw/` 里的前端源码，或者 `_build/swamp-server/` 里的 Rust 源码。
- **点一下 `gen`（构建）**：`swamp.exe` 把你写的源码全部压成小文件，把几百篇 HTML 抽成纯文本切成 300 KB 一块的数据片，算好同义词表，给每个文件算指纹记进清单，最后检查一遍私密文章有没有漏进公网文件。全部没问题才统一替换落盘。
- **点一下 `push`（发布）**：把仓库推上 GitHub Pages，GitHub 只管当个静态网盘发文件。
- **访客打开网页（浏览器）**：浏览器先加载一个空壳 `index.html`，里面嵌两个框——右边 `#side` 画目录树，左边 `#content` 显示文章或电子书。背后同时起两个“帮手”：
  - **Service Worker（`sw.js`）**：管离线缓存和版本更新，像个本地仓库管理员。
  - **Web Worker（`worker.js` + Wasm）**：在后台独立线程里吃进全部文章数据做搜索，算得快还不卡页面。

### 2. 为什么文章里只写纯文本就能变漂亮？

`html/*.html` 里其实只有 `<pre>` 包着的纯文本，这样你平时用 VS Code 写起来最轻快、Diff 也干净。打开文章时，`content.js` 会调用已经预热好的 Wasm（`format_markdown`），瞬间把 `#` 标题、4 倍空格缩进、图片路径、网址、`<p>` 表格和代码块渲染成网页结构，再顺手挂上目录、灯箱、拼音、摘抄和历史 Diff 按钮。

### 3. 搜索为什么又能容错、又能搜近义词、还很快？

- **不卡主界面**：搜索全在后台 Worker 里跑，每算 8 毫秒就歇一拍看看你是不是又打了新字；只要你还在打字，旧搜索立刻作废。
- **先粗筛再细找**：Wasm 里先建了两张“指纹地图”（全局 Bloom 过滤器 + 每篇文章自带的字符位图）。搜一个词之前，先查地图，根本不可能出现的文章和近义词直接跳过，绝不傻扫全文。
- **结果缓存**：搜过的词会存在浏览器数据库（`MainDB`）里，下次秒出；一旦文章更新、同义词更新或算法版本号涨了，旧缓存会自动作废重算。
- **书内搜索**：打开 TXT / PDF / EPUB 时，阅读器会把自己“挂”到主站搜索框上，复用同一套 Wasm 匹配和近义词逻辑，结果单独存在 `BookDB` 里，平时站点更新不会清空它，只有这本书真的被删了才会清理。

### 4. 离线和更新为什么不会“新旧混在一起崩掉”？

最容易出事故的场景是：新版本正在后台下载，用户突然刷新，结果拿到了“旧代码 + 新清单”。站里的做法是：**线上环境下，`core-list.js` 不走网络，而是由当前正在管事的 SW 直接从内存里拼出来发给页面**。这样在用户点「发现新版本，点击更新」之前，页面拿到的代码、清单、数据永远是同一套。点更新后，主控会先把你正在看的页面、视频/音乐进度、搜索词拍个“快照”存进当前标签页，刷新完再原地恢复。

### 5. 私密文章（`__` 开头）是怎么保证不泄露的？

构建时 `swamp.exe` 会同时读 `.gitignore` 和调用 `git check-ignore`，把私密页分流出去：
- **目录信息**（标题、分类、时间）会进 `lite_data.js`，所以线上目录里能看到它挂着 `🔒`；
- **正文内容**只写进本地才有的 `shadow_data_*.json`（在 `.gitignore` 里，不会推上去），公网切片里只填 `"localOnly"` 占位，同义词词频也不统计私密页；
- 构建结束前，还会拿每篇私密页的片段（含 JSON 转义形式）去扫一遍所有准备发布的公网文件，真发现泄露直接报错中止，连旧数据都不会被污染。

### 6. 为什么本地页面能直接改文件、开 VS Code，线上却不行？

前端全站只看一个开关 `store.online_flag`（本地为 `"0"`，线上和 `9000` 仿真端口为 `"1"`）。本地模式下，`swamp.exe` 只监听本机 `127.0.0.1`，启动时在内存里生成一个随机令牌，通过 `Open Site` 放到网址 `#` 后面传给浏览器再立刻抹掉。前端每次保存 Markdown、改书签、点 `edit` 或开 KaTrain，都是带这个令牌向本地服务发 JSON 请求，后端校验来源和令牌通过后才原子写盘。

---

## 版B：专业描述与协作规范（AI 思维导向）

### 1. 编译环境与目录结构

- **编译环境（Windows）**：
  - 单 Crate 双目标（Rust 2021，`_build/swamp-server/Cargo.toml`，版本 `3.1.0`）：
    - 原生端：`--bin swamp`，`--profile release-exe`（`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "unwind"`），产物复制为 `_build/swamp.exe`。
    - Wasm 端：`--lib` (`compute_intensive_task_processor`, `cdylib`)，`wasm-pack build --target web`，`.cargo/config.toml` 开启 `target-feature=+simd128`，`release` 配置 `opt-level = "z"`, `panic = "abort"`，`wasm-opt -Oz` 优化，胶水 JS 由 `swamp.exe minify` 压缩输出至 `src/wasm/`。
  - Cargo 目标目录统一重定向至 `_build/temp/target`。

```text
_build/
  swamp.toml                    # 唯一公共配置（站点参数、precache Glob、Pack 预设、[synonyms] 自定义规则）
  swamp.exe                     # 唯一运行期二进制（伴生服务 + 4 标签页原生 Win32 管理窗）
  swamp-server/                 # 单 Crate Rust 工程
    .cargo/config.toml          # target-dir = "../temp/target" & wasm32 simd128
    Cargo.toml / build.bat
    assets/cilin.txt            # 外置只读基础词林
    src/
      main.rs                   # CLI / Serve / Sim 入口、Router、/__oauth/callback、安全退出交接 build.bat
      lib.rs                    # Wasm 引擎（#![cfg(target_arch = "wasm32")]）：渲染/搜索/Bloom/ADS/LCS Diff
      config.rs                 # 配置加载与 swamp.toml 区块原子写回
      security.rs               # 静态路径守卫、参数校验、CSP/API 鉴权中间件、42 项 --selftest
      static_fs.rs              # 静态文件托管（支持单段 Byte Range）
      api_files.rs              # write_bytes_atomic / write_atomic 与 /__api/files/*, /__api/bookmarks
      api_ops.rs                # /__api/ops/*（edit、watch-html 长轮询、explorer、cli、txn、katrain）
      gui.rs                    # Win32 Per-Monitor HiDPI 4 标签页管理窗 + Arc<GuiMailbox>
      builder/                  # mod.rs（单飞锁+日志桥）、minify.rs、html_utils.rs、generator.rs、synonyms.rs + synonyms_tpl.js
      media/                    # webp.rs（静态 libwebp）、keep2html.rs
      services/                 # log_bus.rs、watcher.rs、tasks.rs（VPN 心跳 + Google Tasks OAuth）、pack_apply.rs
  privy/                        # 本机私有区（.gitignore；HTTP 默认拒绝，仅白名单放行 txn.txt 与 upcoming_tasks.json）
    local.toml / credentials.json / tokens.json / upcoming_tasks.json / txn.txt
  temp/                         # 临时与构建产出区（.gitignore）
    swamp_runtime.log           # 持久化运行日志（新来居上）
    target/                     # Cargo 编译缓存
    backup/                     # build_hashes.txt、synonyms.sha256、oov_report.txt、ai_pack_*、ai_apply_*、keep2html_*
html/                           # 单层 HTML 原文（分类由 #anchor 决定）
gallery/ | audio/ | video/ | ebook/  # 物理目录树即站内分类
src/
  js/raw/*.js -> src/js/*.js    # 源码 -> 压缩产物（sw.js 输出至仓库根目录）
  css/raw/*.css -> src/css/*.css; src/css/font/font.css -> src/css/font.css
  js/data/                      # lite_data.js、fat_data_N.json、core-bundle.json；本地另有 shadow_data_N.json、shadowIndex.js
  tpl/                          # side / bookmark / txt / pdf / epub / pano / md_viewer / bilingual / new / go_board / txn_parser / street_view_uploader
  third/                        # 同源第三方库
  wasm/                         # compute_intensive_task_processor.{min.js, _bg.wasm}
  discussion_id_mapper.json     # Giscus discussion ID <-> 文章标题映射（同时作检索 recordId）
index.html / sw.js / README.md / .gitignore / .nojekyll
```

### 2. 同源第三方库版本与安全定制

| 组件 | 版本 | 位置 | 安全与定制约束 |
| :--- | :--- | :--- | :--- |
| **PDF.js** | `v6.5.438` | `src/third/pdfjs/` + `pdf-viewer.{js,css}` | 严格 CSP（零 `'unsafe-inline'`），`enableScripting: false`；文本层通过 `_textHighlighter` 适配 v6 私有字段；支持批注与书内搜索桥接 |
| **Bibi (EPUB)** | `1.2.0` | `src/third/bibi/` + `src/tpl/epub.html` | `allow-scripts-in-content: false`、`trustworthy-origins: []`，关闭本地/base64/blob 入口；章节 iframe 二次剥离脚本并注入 `script-src 'none'` |
| **marked** | `v4.3.0` | `src/third/markdown/marked.min.js` | 配合 `md_viewer.html` 前置 `protectMath` 与后置 `fixBold` / `highlightCode` |
| **DOMPurify** | `3.5.0` | `src/third/markdown/purify.min.js` | `md_viewer.html` 禁用 `script/style/iframe/object/embed/form/svg/math/template`、`srcdoc/formaction` 与未知协议 |
| **highlight.js** | 同源精简版 | `src/third/markdown/highlight.min.js` | 仅高亮显式标注且已注册的语言 |
| **CodeMirror 5** | 同源 | `src/third/markdown/codemirror/` | 仅本地编辑态按需加载，在 `swamp.toml` precache 中排除 |
| **Photo Sphere Viewer + three.js** | three `r7` (`version:7`) | `src/third/photo-sphere-viewer/` | `pano.html` 禁 `eval` CSP，强校验 `?src=` 仅限同源 `/gallery/` 图片 |
| **Prism / encoding.js / confetti** | 同源 | `src/third/prism/`, `src/third/other/` | 代码高亮、TXT 编码兜底、更新庆祝动画 |

### 3. 模块拓扑与通信面

前端模块维持严格有向无环图（DAG）：

```text
site-core.js (Window/iframe/SW 共享事实源：MainDB v3 Schema、20 个 tab 隔离键、createStore、白名单校验)
  └─ shared-utils.js (零外部依赖原语：DOM/拖拽/媒体进度/CSS.highlights/ADS 求值/callLocalApi)
       ├─ search-engine.js <-> search-ui.js -> search-preview.js   [首屏并行预热]
       ├─ index.js (主控：会话隔离、Wasm/Worker 引导、SW 注册与自愈、切片同步、懒加载路由)
       │    ├─ 按需 import()：comments.js / audio-player.js / snapshot.js / lightbox-logic.js / excerpts.js / book-db.js / touchpad.js (仅触屏)
       │    └─ 顶层外围聚合：deferred-features.js (What's new、@bomb/@rebirth、7 天备份、全局书签、到期任务、拼音/容量/夜间闪烁、md_viewer 浮窗)
       ├─ 独立线程：worker.js -> synonyms.js + Wasm (lib.rs)
       ├─ iframe 视图脚本：side.js / content.js / bookmark.js / bilingual.js / pdf-viewer.js / txn_parser.js / epub.html / txt.html
       └─ 离线层：sw.js + core-list.js
```

三个通信面：
1. **状态面**：`SiteCore.createStore` Proxy，持久数据进 `localStorage`，20 个每标签页状态键（`resource_type`、`*_path`、`*list`、`last_html`、`keyword`、`lightbox_stauts`、`jump_from_search*` 等）自动路由至 `sessionStorage`。
2. **事件面**：`BroadcastChannel('bus')`，消息格式 `{ type, payload, from, target, tabId }`。`target` 为 `index | side | content | *`；接收端丢弃非本 `tabId` 消息，仅 `SEARCH_CACHE_CLEARED` 例外。
3. **直连面**：同源 `window.top` 句柄（`sharedWasm`、`__DOC_SEARCH_BRIDGE__` / `__TXT_SEARCH_BRIDGE__`、`VirtualCursor`、`pinyinData`、`callLocalApi`、`parseAdsQuery` / `buildTermSpecs` / `ensureTermSpecs`）。

### 4. 核心时序关系

- **浏览器启动序列**：
  1. `index.html` 成人校验 -> 注入 `PARAM` 常量 -> `site-core.js` -> `index.js` 同步吸收 `#__swamp_token` 并 `replaceState`。
  2. 并行预热主线程 Wasm 与 `search-engine`/`search-ui`，挂载 `__DOC_SEARCH_BRIDGE__`。
  3. `onload`：检查 `?repair=1`（2 秒后异步绕缓存检查 `/sw.js` 远端 `repair_command_id`）-> 恢复侧栏比例 -> 加载 `#side` -> 注册 SW -> 初始化搜索 UI。
  4. `loadScripts`（90 s 看门狗）：预热 Worker 与 `MainDB.chunks` -> 加载 `core-list.js` ->（本地）`shadowIndex.js` -> `lite_data.js` -> `RENDER_CATALOG` -> 有 `ss_restore_strict` 快照则按需加载 `snapshot.js` 恢复，否则直开 `bookmark.html` -> 显示搜索框。
  5. `loadDataInBatches`：按清单哈希差分拉取 `fat_data_*.json` -> **全成功才原子批量落盘并清缓存** -> 推入 Worker `BUILD_DATA`（45 s 看门狗）-> `DATA_READY` 绑定缓存命名空间、媒体/书籍删除对账与 `BookDB` 清理、播放更新彩带。
  6. 空闲期加载 `comments.js`、`deferred-features.js` 与（触屏）`touchpad.js`。
- **本地全量构建（`builder::run_gen_with_logger`）**：
  1. 获取全局单飞锁 `GEN_LOCK`，置 `GEN_IN_PROGRESS = true`（挂起 `watcher.rs` 热压缩，结束后保留 1.5 s 尾项冷却）。
  2. **Phase 1**：`rayon` 并行增量压缩 `js/raw/*.js`、`css/raw/*.css`、`font/font.css`（跳过 `core-list.js`/`sw.js`/`synonyms.js`），核对 `ver|raw_sha|out_sha`，自动清理账本中已删源对应的僵尸产物。
  3. **Phase 2（事务暂存）**：
     - 内存准备 `index.html` 注入文本；加载 `.gitignore`（无有效规则即 fail-closed）；
     - 扫描 `html/*.html`，调用 `git check-ignore` 复核私有页，检查 `__` 前缀与**重复 `<title>`**，校验图片引用，按公/大文档/私分流；
     - 扫描四类媒体目录并批量调用 `git check-ignore` 复核；
     - 在 `_build/temp/staging_data_<pid>_<ms>` 暂存目录写出 `lite_data.js`、`fat_data_*.json`、`shadow_data_*.json`、`shadowIndex.js`、`core-bundle.json`；
     - 按需重建 `synonyms.js`（仅公开语料 DF；`minify_js` 失败直接报错）；
     - 解析 `[build.precache]` 显式项与 Glob，生成清单（仅 `(path, hash, source)` 任一变化才递进 `BUILD_VERSION`）；
     - 对暂存目录执行无盲区 `assert_no_private_leak`；
     - **全部通过后统一提交**：暂存目录迁入 `src/js/data/`，依次原子写出 `index.html`、`discussion_id_mapper.json`、`idle-list.txt`、`raw/core-list.js`、`raw/sw.js`。
  4. **Phase 3**：压缩 `raw/core-list.js` -> `src/js/core-list.js` 与 `raw/sw.js` -> `/sw.js`，最后落盘 `build_hashes.txt`。
- **回填后重启编译交接**：`Apply` 线程写完文件 -> 发 `WM_APP_EXIT_AND_BUILD` -> UI 主线程走 `begin_safe_close`（有活跃写盘时弹确认框，拒绝则中止交接）-> 回收 `sim` 子进程、销毁窗口 -> `main.rs` 执行 `server_handle.join()` 彻底释放端口与文件句柄 -> 退出前最后一步拉起 `build.bat`。

### 5. 数据结构与存储设计

**构建产物形态**：
- `lite_data.js`：`window.LITE_DATA = { html, image, ebook, video, audio }`，递归目录树叶子为 `_f: [[fileName, recordId, itemType, info], ...]`。HTML 的 `info` 为 `YYYYMMDDHHMMSS[-localOnly]`；媒体 `recordId` 为 `-1`。
- `fat_data_N.json` / `shadow_data_N.json`：`{ "<recordId>": "<纯文本 | localOnly | ''>" }`，按 `slice_size_kb`（默认 300 KB）切片。
- `core-bundle.json`：`{ "<webPath>": "<UTF-8 文本>" }`，打包公开 HTML 及可内联的 precache 文本资产。
- `core-list.js`：采用 JSON 字面量 `const __SWAMP_MANIFEST_GROUPS__ = { "<dir/>": [[name, crc32Hex, flag], ...] }`（`flag`: `0` standalone / `1` core-bundle / `2` no_cache），运行期展开为 `FILE_MANIFEST`、`allFilesToCache` 与 `window.dataIndex`。
- 运行期主线程只存扁平轻量 4 元组 `window.data = [title, placeholder, path, type, ...]`，全文常驻 Worker 内 Wasm 内存。

**客户端与本地存储全表**：

| 介质 | 名称 | 内容与淘汰策略 |
| :--- | :--- | :--- |
| Cache Storage | `core-cache-{BUILD_VERSION}` | 站点壳、静态脚本样式、HTML、Wasm、`synonyms.js`、README、`sw-manifest.json`；新 SW `activate` 删除旧桶 |
| Cache Storage | `media-cache` | 媒体、字体、PDF cmaps/standard_fonts/iccs/wasm/images；Cache-First，仅检测到删除时定向清理 |
| IndexedDB | `MainDB` v3 | `chunks`（fat 切片）、`update_logs`、`search_cache`（最多 500 条 LRU，单次 $>300$ 条不入库）、`sys_state`（LRU 索引、评论快照、媒体路径快照、`pending_search_cache_clear`）、`html_snapshots`（每页最多 10 版 deflate-raw 快照） |
| IndexedDB | `BookDB` v1 | `book_extracts`（最多 30 本 / 32 MB，单本上限 12 MB）、`search_cache`（最多 600 条 / 16 MB，单书 80 条、单条 512 KB）；超 4 KB 启用 deflate-raw；常规更新不清空，仅删书时清理 |
| IndexedDB | `ExcerptsDB` / `SideDB` / `AlignDrafts` (v1) | 摘抄本、侧栏已阅标记、双语页编辑草稿 |
| `localStorage` | `store` + `__swamp_local_token__` | 用户偏好、历史、收藏、滚动/媒体/电子书进度、壁纸、本地会话令牌（定时巡检 4 MB 告警） |
| `sessionStorage` | `ss_restore_strict` + 20 个 tab 键 | 热更新一次性现场快照 + 每标签页隔离状态 |
| 本地磁盘 | `_build/temp/` | `swamp_runtime.log`（上限 800 条）、`backup/build_hashes.txt`（`swamp-min-v3\|raw_sha\|out_sha`）、`backup/synonyms.sha256`、`backup/oov_report.txt`、打包与回填快照 |

### 6. 缓存机制与搜索算法

- **SW 更新与防撕裂**：
  - 安装期比对旧桶 `sw-manifest.json`：未变项直接拷贝；`core-bundle.json` 来源变更数 $> 15$ 或首装时拉大包解包，否则并入独立批按网速（4/2/1 并发，30 s 超时，同 URL 合并）拉取。
  - `CRITICAL_URLS` 任一拉取失败直接中止安装；非关键文件回退旧桶并保留旧哈希。
  - 线上拦截 `core-list.js` 时由 SW 用自身 `FILE_MANIFEST` 实时合成响应，杜绝 waiting 期间“旧代码 + 新清单”撕裂；本地模式走 Network-Only 断网回退缓存，放行 `/__api/*`。
- **搜索缓存四重失效**：
  1. `core` 命名空间：`v{SEARCH_ALGO_VER}|d:{dataFp}` 变化清空 `search_cache` 并跨标签页广播 `SEARCH_CACHE_CLEARED`；
  2. `syn` 命名空间：`synonyms.js` 指纹变化清空并重搜；
  3. SW 安装检测到 `synonyms.js` / `.wasm` / Wasm 胶水变化，写 `pending_search_cache_clear`，`activate` 时清库；
  4. 增量切片全成功原子落盘后主动清库。
- **检索与评分内核（`lib.rs` + `worker.js` + `synonyms.js` v5.1）**：
  - 噪值上限 $\min(\text{noise}, \text{len} > 25 ? 0 : \lfloor \text{len}/2 \rfloor)$；硬边界 `\n \r 。！？；!?;`。
  - 重叠区间裁决优先级：`tier`（原词 > 1-hop > 双槽）> `noise` > `weight` > 长度。
  - 计分：标题基分 5000（每噪 $-500$，同义封顶 4500），正文基分 100（每噪 $-10$，同义封顶 450）；同类命中降序后按次线性饱和系数 $k / (k + i)$ 累加（标题 $k = 1$，正文 $k = 4$）；再按文档最小原词噪值加保底分（0 噪 $+10000$，1 噪 $+3000$，2 噪 $+2200$，3 噪 $+1500$，4 噪 $+900$，其余 $+500$）。
  - 加速：全局 bigram Bloom（语料 1 MB、评论 256 KB）-> 文档级自适应 unigram/bigram `DocFilter`（按字数分 4 档）-> `ScanPlan` 首字掩码与倒排单遍扫描。
  - 布尔组合（ADS）：手写递归下降 -> 德摩根下推 NNF -> 双端拦截空文档恒真 -> `ads_optimize` 将 `And` 子句按（非否定 > 噪值升序 > 词长降序）排序短路；先联合正文+评论求值，再仅正文复核判定 `viaComment`。
  - 抢占调度：`MessageChannel` 让出事件循环，8 ms 自适应时间片（16–4096 篇动态伸缩）；`token` 变更立即中止，`dataGen` / `commentGen` 变更自动重扫。
  - 近义扩展：三路策略（A 整词直达 -> B `#`/`@` 独立词与 `stopExpand` 保护不拆 -> C DP 最优分词 + 词林 5 级编码 LCA 上下文消歧），受语料 DF 分桶乘数与 `K`/`L` 虚词降权约束；全站搜用 `bloom_might_match` 裁剪，书内搜用 `cacheTag='raw'` 跳过全站 Bloom 裁剪。
  - 页内 Diff：双方 `<pre>` 渲染为标准化 Token 序列，调用 Rust `similar` LCS（矩阵超 $2.5 \times 10^7$ 格熔断防 OOM）。

### 7. 安全防范与鲁棒性

- **本地服务安全边界**：
  - 仅绑定 `127.0.0.1:<port>`；32 字节随机 Hex 令牌仅驻留内存，通过 `#__swamp_token=` 传入并立即 `replaceState` 抹除。
  - `/__api/*` 四重鉴权：`Origin` 白名单 + `Sec-Fetch-Site: same-origin` + `subtle` 常量时间比对 `X-Swamp-Token` + 参数白/黑名单（`sim` 模式完全不挂载）。
  - 静态路径守卫：解码后拦截控制字符、反斜杠、`.`/`..`、隐藏文件、Windows 8.3 短名、尾点/尾空格、`:`、内部命名空间；`Serve` 模式对 `_build/**` 默认拒绝仅白名单放行 `txn.txt` 与 `upcoming_tasks.json`，`Sim` 模式整目录封禁 `_build/**` 与 `shadow*`。
  - 防命令注入与 XSS：`validate_title` 禁止 Windows 路径非法字符及 `&;()`；Windows 优先解析 `Code.exe` 直接拉起，回退 `cmd /c` 时拦截全部 cmd 元字符；`/__oauth/callback` 对 `error` 执行 HTML 转义并强制下发 `script-src 'none'` CSP。
  - 补丁回填安全：`pack_apply.rs` 校拦截路径穿越、8.3 短名、尾点/尾空格、Windows 保留设备名及 `.git`，限制单文件 64 MB / 总解压 256 MB，大小写不敏感路径去重，备份目录删除受 `canonicalize` + `starts_with` 约束。
  - 全站禁 `eval`：默认 CSP 放行 `'wasm-unsafe-eval'` 禁 `'unsafe-eval'`；`street_view_uploader.html` 单独放行 Tailwind CDN 与 Google GSI；灯箱 `about:blank` 达到 `script-src 'none'`，`pdf.html` 零 `'unsafe-inline'`，`bilingual.html` 补齐 `<meta>` CSP。
  - 公私隔离：`assert_no_private_leak` 对 `fat_data_*.json` 逐条校验私有 `recordId` 必为 `"localOnly"`，并对全长度私有正文（原文 + JSON 转义串）扫描全部公网产物。
- **鲁棒性与自愈**：
  - 原子写盘（`write_bytes_atomic` / `write_atomic`）：`{name}.{pid}.{seq}.swamp.tmp` 写完再 `rename`，Windows 共享冲突（错误码 5/32）自动退避重试 4 次。
  - 无 UAF 并发模型：`gui.rs` 后台线程与 UI 通过 `Arc<GuiMailbox>` + `PostMessageW` 通信，杜绝裸指针跨线程访问。
  - `swamp.exe --selftest` 内置 42 项回归用例，每次 `build.bat exe` 自动执行。
  - 前端看门狗（90 s / 45 s）仅提示不自动删库；三级自愈通道（远端 `repair_command_id` -> URL `?repair=1` -> `@bomb` 交互清理）。

### 8. 硬性条件（改动前必核对）

1. **只改源码，不手改构建产物**：`src/js/*.js`、`src/css/*.css`、根目录 `sw.js`、`core-list.js`、`synonyms.js`、`core-bundle.json`、`lite_data.js`、`fat_data_*.json` 均由 `swamp.exe gen` 生成。
2. **新增需离线的静态文件**：必须命中 `_build/swamp.toml` `[build.precache]` 规则；首屏关键模块同步加入 `src/js/raw/sw.js` 的 `CRITICAL_URLS`。
3. **主线程不持全文**：全文检索与 Diff 逻辑放 Worker / Wasm，主线程只保留 `window.data` 轻量视图。
4. **改匹配或评分语义必递增 `SEARCH_ALGO_VER`**（当前 `11`，需同步更新 `search-engine.js` 与 `book-db.js` / 阅读器默认参数）。
5. **BUS 消息必检 `tabId`**：仅 `SEARCH_CACHE_CLEARED` 允许跨标签页。
6. **删 IDB 前先关连接**：清库必须先关 `MainDB` / `BookDB` / `ExcerptsDB` / `SideDB` 并置 iframe 为 `about:blank`，清库期置 `window._isBombing = true`。
7. **公私隔离底线**：任何新增公网产物严禁读取私有正文或其词频，并同步纳入 `assert_no_private_leak` 检查。
8. **单一事实源**：`MainDB` Schema、20 个 `TAB_SCOPED_KEYS`、`createStore` 与路径/协议白名单只在 `src/js/raw/site-core.js` 定义。
9. **环境分支只认 `store.online_flag`**，不要在业务代码里散落判断 host/port。
10. **不移除内容页反脱壳脚本**（`top === self` 跳转回首页）。
11. **本机私有路径不入库**：一律写入 `_build/privy/local.toml`。
12. **新增本地 API 必须走鉴权中间件并补充 `--selftest`**，`sim` 模式绝不挂载。

### 9. AI 协作约定

#### 两步协作法
1. **第一步（只分析、不盲改）**：提供上下文压缩包（或 MD 分卷）与具体现象/目标，让 AI 定位根因并给出最小改动方案，双方确认边界后再动手。
2. **第二步（按约定交付补丁）**：确认方案后，让 AI 按下述回填规范打包增量完整文件 `.zip`（或输出完整文件代码块）。

**按场景最小上传集**（与 `swamp.toml` Pack 预设对应）：
- 核心检索：`README.md` + `_build/swamp-server/src/lib.rs` + `src/js/raw/{worker,search-engine,search-ui}.js`
- 近义词调优：`README.md` + `_build/swamp.toml` + `_build/swamp-server/src/builder/{synonyms.rs,synonyms_tpl.js}` + `oov_report.txt`（无需传 `cilin.txt`）
- 构建与本地服务：`README.md` + `.gitignore` + `_build/swamp.toml` + `_build/swamp-server/` 源码（不传 `Cargo.lock` 与 `target/`）
- SW / 热更新 / 清单：`README.md` + `index.html` + `src/js/raw/{site-core,index,sw,snapshot}.js` + `_build/swamp.toml` + `generator.rs` + `config.rs`
- 电子书阅读器：`README.md` + `src/tpl/{pdf,epub,txt}.html` + `src/js/raw/{pdf-viewer,book-db,search-preview,shared-utils}.js` + `src/css/raw/pdf-viewer.css`

#### 打包与回填规范
- **上传给 AI（Pack）**：仓库根目录相对路径，仅含源码与配置，不含压缩产物、`.map`、`_build/privy/`、`_build/temp/`。若目标 AI 不支持 `.zip`，在管理窗 Pack 页勾选「拼接 MD」并设置合适单文件 KB 上限分卷上传。
- **AI 返回补丁（Apply）**：
  - 所有条目直接从**仓库根目录相对路径**起算，严禁多套一层顶层目录（如 `patch/`、`repo/`）。
  - **仅打本次实际新增或修改的增量文件**，每个文件必须是**可直接覆盖的完整源码**，禁止用省略注释或 diff 片段替代。
  - **只改源码不改构建产物**（不塞压缩后 JS/CSS、根目录 `sw.js`、`core-list.js`、`core-bundle.json`、`synonyms.js`）。
  - **编码与换行**：`.bat` / `.cmd` 用 UTF-8 无 BOM + CRLF；`.ps1` 用 UTF-8 带 BOM + CRLF；其余文件保持原编码与换行风格。
  - **说明文件与禁区**：验证步骤放根目录 `PATCH_NOTES.md` 或 `APPLY_AND_VERIFY.md`（Apply 默认自动跳过）；禁止包含 `.git` 内文件；若涉及**删除/重命名文件、修改 `local.toml`、重编译 `swamp.exe`/Wasm 或执行 `gen`**，必须在回复正文显式列出。

#### `README.md` 同步修正原则
- 只要改动影响了功能入口、配置项、构建步骤、架构拓扑、存储结构、安全策略、版本号或自检数量，应在同一次补丁中同步修订 `README.md` 的对应位置，不留陈旧描述（如已淘汰的旧脚本名或旧参数）。
- 保持克制、客观的实话文风：写清楚“是什么、在哪、怎么工作、有哪些限制”，不堆修饰词，不写营销腔，不破坏全文结构与版 A / 版 B 的定位分工；不要在 `README.md` 里追加零散的逐日更新流水账，直接把最终现状写准确。