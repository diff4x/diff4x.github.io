# [diff4x's digital swamp](https://github.com/diff4x/diff4x.github.io)

> 本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航
>
> 基建：初代 by diff4x | 进化 by Gemini & Claude & ChatGPT & Grok
---

# 💡 查阅（访客）

站点是单页双栏的纯静态信息库：左侧主屏显示正文、电子书、图库或视频，右侧是目录树和搜索框。不需要登录，访问过一次后可以离线使用。阅读进度、已阅标记、摘抄、收藏和历史都保存在当前浏览器里，同一浏览器开多个标签页，互不干扰。

下面按一次访问的先后顺序写：先认识界面，再找内容、读内容，最后是带走数据和处理异常。

## 1.1 刚进站：界面和通用手势

首页是书签页，放着外链、内置小工具和壁纸。本文（`README`）也在这里：左击在浮窗中打开，中击直接去 GitHub 仓库。

全站把高频操作统一成四类手势，不用逐页记按钮位置：

- 中击：在图库、视频、PDF、EPUB、TXT 中切换全屏；在搜索区域内清空并收起搜索。
- 右击：在侧栏右击呼出全局书签菜单（右键双击恢复浏览器原生菜单）；在搜索结果和 `What's new?` 里，右击音视频试播或暂停，右击文章摘要开始或暂停自动滚屏；右击搜索历史项，删除该词和对应缓存。
- 划选文字：在 HTML、Markdown、TXT、PDF、EPUB 中，划选 1 个汉字显示拼音，划选 2 个及以上字符出现 `✏️`，点击即收入摘抄本。
- 双击：侧栏条目双击复制文件名；代码块双击进入临时编辑；带红框的 `pano_*` 图片双击打开 360° 全景；PDF 正文双击在选字和抓手之间切换；右上角 `🎵` 双击销毁音乐播放器。

右侧栏顶部的 `←` / `→` 可以调整侧栏宽度。

## 1.2 想找内容：先看目录

多数访客会先扫一眼右侧目录。

- 分类名旁标着 `[近期更新/总数]`，没有近期更新时只显示 `[总数]`；72 小时内有更新的条目会高亮。
- 每个条目右侧有 `[Mark]` / `[UnMark]`。标记后条目加删除线，表示已读，历史和搜索结果里同样会体现。

目录里没找到，就用搜索。

## 1.3 搜索内容

### 呼出与切换范围

- 在页面任何位置按 `\` 聚焦搜索框。
- 打开 TXT、PDF、EPUB 时，搜索框自动切成“搜本书”；也可以按 `Ctrl+F` 强制搜本书。结果按章节或页段分组，可展开单条直接跳转。
- 工具条上的“本书 / 全站”按钮可随时切换。

### 不点开就能预览

- 悬停 HTML 或电子书条目，可看到高亮的上下文；右击摘要可自动滚屏或暂停。
- 悬停图片，可看大图。
- 右击音频或视频，弹出带倒计时的试播窗，播放进度会被记住。

### 缩小范围

- 工具条可按文件后缀过滤（可一键反选），也可按 HTML 的“年月”过滤。
- 文章时间戳和 `gallery/拍摄` 都用 `YYYYMMDDHHMMSS` 格式，所以直接搜 `202610` 或 `2610` 就能按月定位。
- 有评论的命中项标 `[💬 数量]`；带 `🔒` 的是作者本地的私有内容，正文不会出现在线上。

### 搜不到时：容错、近义、组合

- 容错（噪值 `0–5`）：允许关键词相邻字之间夹杂无关字符。单个空格不计噪声，换行和句末标点（`。！？；!?;`）不能跨越。实际生效的上限随词长缩放，公式为 $\min(\text{noise}, \text{len} > 25 ? 0 : \lfloor \text{len} / 2 \rfloor)$。以噪值 3 为例：

  | 搜索词长度 | 1 | 2–3 | 4–5 | 6–25 | $\ge 26$ |
  | :--- | :---: | :---: | :---: | :---: | :---: |
  | 字间最多夹杂的无关字数 | 0 | 1 | 2 | 3 | 0 |

- 近义扩展（`近义`）：根据词林和全站公开词频自动扩展相关词。近义词用蓝色高亮，原词是黄色；近义词只做精确匹配，不叠加噪值。
- 布尔组合（`@[...]`）：支持 `&`（且）、`|`（或）、`!`（非）和括号 `()`；最多 26 个单字母形参（`a`–`z`），表达式里至少要有一个正向词。
  - 示例：`@[a&!(b|c)]飞机[31]大炮[]机枪[0]`。`a`、`b`、`c` 依次对应后面的三个词，意思是含“飞机”，且不含“大炮”或“机枪”。
  - 词后面的方括号：`[]` 沿用全局设置；`[N]` 指定噪值，$N \in [0,5]$；`[NM]` 同时指定噪值 $N$ 和近义开关 $M \in \{0,1\}$。示例里“飞机”是噪值 3、开启近义，“机枪”是噪值 0。

## 1.4 看站点最近更新了什么

把鼠标悬停在顶部的 `bookmark` 上，会出现悬浮菜单：

- `What's new?`：两个标签，分别是文件更新日志和最新评论。点条目直接跳到对应位置，可悬停看图、右击试播音视频；也可以在这里开关“有更新 / 有新评论时自动弹窗”。
- `History`：最近 50 条打开记录，可就地标记已读。
- `Fav`：收藏过歌曲后才会出现，一键播放收藏列表。
- `Excerpts`：个人摘抄本，按书名归档，可编辑、排序，也可一键保存或复制。

发布新版本后，侧栏底部会出现橙色更新条。点击后，站点先保存当前的阅读、播放和搜索现场，刷新后在原位置恢复。

## 1.5 读文章

### HTML 正文

- 自动记住滚动位置；右侧可展开跟随目录。
- 代码块右上角可一键复制；双击进入临时编辑，方便对照着改。
- 文中图片点击进入灯箱，可缩放、拖拽。
- 左上角 `diff`：任选两个历史版本对比改动，最多 10 版快照，右侧有缩略定位条。
- 线上版本左上角有 `💬`，可用 GitHub 账号评论。

### Markdown 浮窗（如 `README`）

- 可拖拽、缩放、最大化；带目录、亮暗切换、复制和导出 PDF。
- 顶栏 `Diff` 可在渲染态和源码态之间切换。渲染态对成对修改的行做字、词级高亮，目录上用圆点标出有变更的章节。
- 可勾选“仅看改动”折叠上下文；用 `F7` / `Shift+F7` 或 `[` / `]` 依次跳转改动块。线上最多保留 10 版快照。

## 1.6 读电子书

- TXT：横向多栏，无缝滚屏。点顶部居中的横条呼出控制栏，可调字号、行高、栏宽和配色，也可手动切换编码（自动识别 UTF-8、GB18030、Big5、UTF-16）。按 `B` 记书签，下次自动续读。
- PDF：保留完整大纲和缩放。顶栏有“反色阅读”和“搜本书”切换；双击正文在选字和抓手之间切换；横向模式下滚轮可横向滚动。
- EPUB：支持目录跳转、跨章节的书内检索，以及进度记忆。
- 三种格式都用 `Ctrl+F` 搜本书，中击切换全屏。

## 1.7 看图、看视频、听音乐

- 图库：滚轮或双指缩放，拖拽平移；左右键（手机上左右滑动）切图；按 `Space` 聚焦跳页框。点 `As Wallpaper` 把当前图收藏为首页壁纸；在书签页右下角的 `🎨` 里管理壁纸：固定、顺序或随机轮播，以及铺放方式。
- 全景：`gallery/` 下以 `pano_` 开头、带红框的图片，双击打开 360° 全景。
- 视频：自动记住播放进度。`.mkv` 会自动挂载同名 `.vtt` 字幕，`[` / `]` 可微调字幕延迟，每次 $\pm 0.5\text{ s}$。
- 悬浮音乐：支持收藏、全库播放，以及随机、单曲、列表循环。右上角 `🎵` 单击是显示或隐藏（不中断播放），双击是关闭并销毁。

## 1.8 书签页里的小工具

- `txn_parser`：解析交易流水（`txnl` 格式），生成 12 个月的趋势图；页面上可以下载示例文件试用。
- `⚪ go_board`：19 路离线围棋摆谱，左黑、右白、中提子，自动存档。
- `❓ guestbook`：免登录留言板。

## 1.9 用手机访问

触屏设备会自动挂载底部的虚拟触控板，让悬停预览和右键菜单在手机上也能用。触控板提供：虚拟光标、画面缩放（`+` / `-`）、`▲` / `▼` 滚屏、`暂停跟随`、`框选`、`拖拽`、`左双击`、`中击`、`右击`，以及一个可拖动的 `收起/展开` 悬浮钮。前面说的中击、右击、双击，在手机上用对应按钮完成。

## 1.10 换设备、清理数据、处理异常

所有个人数据都只在当前浏览器里，换设备或清理前先备份。

- 备份与迁移：在搜索框输入 `@bomb` 回车，可选择保留或导出 `.json` 个人备份（收藏、已阅、历史、排版偏好、播放与电子书进度、摘抄本），随后清理本地库，所以清库前请先确认备份已导出。到新环境输入 `@rebirth` 回车，导入备份即可恢复。系统每 7 天提醒一次备份。
- 缓存异常：在网址末尾加 `?repair=1` 访问并确认弹窗，会重置离线缓存和索引库。摘抄本、已阅标记、收藏和历史不会被删除。

## 1.11 快捷键与手势速查

| 场景 | 按键 / 手势 | 作用 |
| :--- | :--- | :--- |
| 全局任意页 | `\` | 聚焦搜索框 |
| 搜索区域内 | 中击 · `Esc` · 右击历史项 | 清空并收起 · 失焦关闭 · 删除该词及缓存 |
| 搜索结果、更新日志 | 右击摘要 · 右击音视频 | 滚屏或暂停 · 弹窗试播或暂停（记忆进度） |
| 侧边栏 | 右键单击 · 右键双击 · 双击条目 | 全局书签菜单 · 浏览器原生菜单 · 复制文件名 |
| 阅读视图 | 划选 1 字 · 划选 2 字以上 | 显示拼音 · 出现摘抄按钮 |
| 图库、视频、电子书 | 中击 | 切换全屏 |
| TXT / PDF / EPUB | `Ctrl+F` | 聚焦搜索框并切到“搜本书” |
| TXT 阅读器 | `B` · `Space` / `PgUp` / `PgDn` · `←` / `→` | 加书签 · 翻屏 · 横向微滚 |
| 图库、全景 | `←` / `→` · `Space` · 双击 `pano_*` | 切图 · 聚焦跳页框 · 打开 360° 全景 |
| 视频播放器 | `Space` · `a` / `d` · `w` / `s` · `z` / `c` · `[` / `]` · `x` | 播放或暂停 · 进退 3 s · 音量 · 切集 · 字幕延迟 · 全屏 |
| Markdown Diff | `F7` / `Shift+F7` 或 `[` / `]` · `Esc` | 下一处或上一处改动 · 退出对比 |

---

# 💡 内容更新（作者）

本章只讲日常使用：发布和编辑内容、调教近义词、使用本地工具。不涉及前端、Rust、Wasm 的代码改动；要改框架，看第三章。

本地运行、构建、媒体处理、街景上传和补丁管理，都集中在一个原生程序 `_build/swamp.exe` 里，不依赖 Node、Java、esbuild、cwebp。双击启动后没有黑窗，会开本地服务（`127.0.0.1:8000`）和一个 5 标签页的桌面控制台。

## 2.1 启动、令牌与配置

- 状态与日志：窗口标题显示服务地址和网络心跳（绿 / 红球图标同步到任务栏和系统托盘）。底部是运行日志，最新的在上，落盘到 `_build/temp/swamp_runtime.log`；重启后用带时间戳的虚线衔接，超过阈值会自动瘦身，体积超过 100 KB 时 `清空日志` 按钮变红。点击窗口右上角 `X` 会隐藏到系统托盘继续运行，左键单击托盘图标重新打开窗口，右键托盘图标选 `Exit` 才会真正退出（退出前等待写盘和构建收尾，并回收 `sim (9000)` 子进程）。
- 会话令牌：启动时在内存里生成 64 位随机令牌。点 `Open Site`，服务端签发单次使用、60 秒过期的引导码打开 `/__auth?code=...`，核销后直接下发 `HttpOnly; SameSite=Strict` 会话 Cookie（前端 JS 与 `localStorage` 均无法读取明文令牌），随后清掉地址栏参数；如果主页已经开着，过渡页同步完即自动关闭。重编译重启时，令牌自动交给新进程，已有会话 Cookie 无感续用。会话失效时，站内的写操作会弹出桌面确认框，确认后重新下发 `HttpOnly` Cookie。
- 两层配置，不要混写：

  | 配置文件 | 入库 | 内容 |
  | :--- | :---: | :--- |
  | `_build/swamp.toml` | 是 | 站点域名、Giscus ID、端口、预缓存 Glob 规则、WebP 默认参数、Pack 预设、`[synonyms]` 同义词规则 |
  | `_build/privy/local.toml` | 否 | `vscode_path`、`katrain_dir`、`img_input_dir`、`webp_output_dir2`、`keep_takeout_zip_folder` |
  | `_build/privy/` 下的其他文件 | 否 | `credentials.json`、`tokens.json`（Tasks）；`streetview_credentials.json`、`streetview_tokens.json`（街景）；`upcoming_tasks.json`；`txn.txt` |

  `local.toml` 里的 5 项都涉及启动进程或搬动目录，只读本机私有配置，不会回退去读 `swamp.toml`。

## 2.2 写内容

### HTML 笔记

HTML 笔记是站里的主要内容。

- 新建：在「常规」页填标题和分类链，点 `新建页面`。程序会写入 `<span id="anchor">时间戳-分类</span>`，并打开 VS Code。
- 修改旧文：在本地网页左上角点 `edit`，会自动更新时间戳（缺时间戳的旧页会补上）。按钮变成 `edit ●`，表示进入监听：每次在 VS Code 里 `Ctrl+S`，页面自动刷新并回到原来的滚动位置。右击 `edit ●` 停止监听；双击右上角标题可手动重载。
- 纯文本写法：在 `<pre>` 里直接写纯文本。
  - 行首 `#` 加空格，转成各级标题，并进入右侧目录。
  - 行首缩进 4 / 8 / 12 / 16 个空格，自动按块级着色。
  - 图片名（默认到 `gallery/img/` 里找，含独立成行和行内引用）和 `http(s)://` 链接，自动转成 `<img>` 和 `<a>`。
  - 其余的 `<` `>` `&` 在渲染时自动转义，既防注入，也不会吞掉代码里的 `a < b`。
- 表格和代码：在 `<p>` 内用 `|` 分列，渲染成表格；`<code 语言>` 触发 Prism 高亮，网页上双击可临时编辑。

文件名约定：

| 文件名 | 含义 |
| :--- | :--- |
| `_xxx.html`（单下划线） | 超大页。正文不进 `fat_data` 和 SW 缓存包，但页内可搜，标题可全站搜 |
| `__xxx.html`（双下划线） | 私有页。必须被 `.gitignore` 忽略（构建时强校验）；目录里挂 `🔒`，正文只进本地的 `shadow_data`，不进公网产物 |
| `gallery/` 下的 `pano_xxx` | 全景图 |

### 双语对照页

本地编辑的草稿自动暂存在 `AlignDrafts`。点“固化”会剥离运行期 DOM、原地写回并重载；线上会自动去掉可编辑状态。

### Markdown（含 `README.md`）

- 在书签页左击 `README`，打开左右分栏的编辑器；`Save` 或 `Ctrl+S` 原地落盘（中击跳 GitHub）。开启 `Sync scroll` 时按源码行号锚定联动，编辑器视口第一行始终跟随预览器视口第一行，拖动调整栏宽或缩放窗口时也会保持对齐。
- 点顶栏 `Diff` 时会自动禁用并隐藏编辑栏；本地与线上统一使用 SW 快照源（`MainDB.html_snapshots` 最多 10 版 + 最近一次构建的 SW 缓存版），本地额外附带一份实时读取的“硬盘当前版”作为最新对照（若有未固化草稿也可参与对比），可在渲染态字级高亮和源码态两种视图间切换。

### 书签与只在本机显示的入口

- 本地书签页可以直接拖入外链，也可以把已有链接拖到其他区块或 `del` 区，完成增、删、移，写入是原子的。
- 本地多一个 `KaTrain` 入口。
- `txn_parser` 自动加载 `_build/privy/txn.txt`，点击行号会用 VS Code 跳到对应行。

## 2.3 发布：三步

前端源码保存后 300 ms 会自动热压缩，供本地即时预览（执行 `gen` 时自动避让）。正式发布统一走下面三步：

1. 全量构建（`gen`）：增量压缩，扫描 HTML 和媒体，生成数据切片和缓存清单，同时给出体检报告：
   - 缺失的图片、路径大小写不符；
   - 公开页引用了被 `.gitignore` 忽略的私有图；
   - `<title>` 与文件名不符、缺 14 位时间戳；
   - 孤立图片清单 `gallery/img/idle-list.txt`。

   写入正式目录之前，会在临时目录对全部公网产物做一遍隐私隔离检查。发现私有独占片段就立即中止，正式目录不会被改动。
2. 线上仿真（`sim (9000)`）：用隐身窗口在 9000 端口模拟线上环境。它会关闭 `/__api`、`_build`、`shadow*`、`html/__*.html` 和所有 `.gitignore` 忽略的路径，用来逐项核对线上的 404 表现、SW 离线缓存和功能交互。
3. 安全提交推送（`gen + push` 或 `push`）：填写 Commit 说明后推送。推送前连续做四项检查：复核磁盘上的公网产物 → 校验 `.gitignore` → 扫描暂存区 → 扫描所有未推送的提交历史（含合并提交）。任何一项命中私有路径，立刻 `git reset` 撤回并取消推送。

## 2.4 调教近义词（「同义词」页）

近义扩展以词林为底，再叠加自定义规则。

- 基础词林 `_build/swamp-server/assets/cilin.txt` 保持只读（`=` 表示等义扩词，`#` / `@` 只用于分词保护）。
- 自定义规则在左栏编辑，写回 `_build/swamp.toml`（写入前做 JSON 和 TOML 双重校验）。
- 右栏实时显示构建产出的 `oov_report.txt`，列出公开语料里高频、但词林没收录的词，可以据此决定补哪些规则。
- 改完点 `保存并重建构建`：强制刷新 `synonyms.js`，并执行一次 `gen`。

常用规则键示例：

```json
{
  "dropEqCodes": ["Bh08A38"],
  "pruneWords": { "code7": ["词1", "词2"] },
  "splitFixes": { "保险丝冰箱": ["保险丝", "冰箱"] },
  "stopExpand": ["指针", "堆栈", "对象"],
  "groups": [
    { "c5": "Bo01A", "words": ["电动机", "电机", "马达"] },
    { "c5": "Dd06A", "exclusive": false, "words": ["报错", "异常"] }
  ],
  "aliases": {
    "梯子": ["VPN", "翻墙", "代理"]
  }
}
```

- 字段含义：
  - `groups`（双向同义词组）：组内词互相扩展；`exclusive` 默认为 `true`（独占覆盖），会自动将这些词从词林的旧义项中剥离。
  - `aliases`（单向别名）：搜索键名可召回目标词，但搜索目标词不会反向召回键名，适合俗称、黑话或上下位归类。
  - `stopExpand`：禁止扩展的技术专词，保留在词表内保护分词边界。
  - `dropEqCodes` / `pruneWords` / `splitFixes`：清洗词林里的脏行或黏连词。
- 词林标记说明：
  - `=`（等义行）：参与近义词扩展。
  - `#`（同类行）/ `@`（独立词）：不参与扩展，但保留在词表内，以保护分词边界。

常用的 5 位分类码（`c5`）：

| 领域 | 分类码 |
| :--- | :--- |
| AI / 算法 | `Dk01A` |
| 网络 / 编程 | `Dd06A` |
| 电脑 / 机械 | `Bo01A` |
| 手机 / 电路 | `Bo04A` |
| 影视 | `Dk29D` |
| 音乐 | `Dk28A` / `Dk28B` |
| 徒步 | `Fb01A` |
| 装备 | `Bp29D` |

公开语料中的出现频率，会按文档数分成 7 档，影响候选词的权重和义项消歧（$N$ 为公开 HTML 总数）：

| 后缀 | 出现文档数条件 | 候选乘数 | 义项消歧加分 | 含义 |
| :--- | :--- | :---: | :---: | :--- |
| 无后缀 | $DF = 0$ | 0.62 | $+0.00$ | 公开正文未出现，保留入口 |
| `:1` | $DF = 1$ | 1.00 | $+0.25$ | 孤篇专词或媒体名 |
| `:2` | $2 \le DF \le 3$ | 1.12 | $+0.45$ | 低频、区分度高的词 |
| `:3` | $DF \ge 4$ 且 $DF / N \le 8\%$ | 1.18 | $+0.60$ | 主题特征词（权重最高） |
| `:4` | $8\% < DF / N \le 20\%$ | 1.00 | $+0.35$ | 常见实词 |
| `:5` | $20\% < DF / N \le 40\%$ | 0.68 | $+0.10$ | 偏泛的词，轻度降权 |
| `:6` | $DF / N > 40\%$ | 0.38 | $+0.00$ | 全站高频泛词，强降权 |

## 2.5 本地工具

### 批量转 WebP（「常规」页）

1. 把截图放进 `img_input_dir`。
2. 设置最大宽度和质量，点 `转换 WebP`。
3. 程序用静态链接的 `libwebp`，把结果写入 `gallery/img/`，原图归档到 `img_input_dir/history/`，新文件名自动进剪贴板。

可选项：勾 `备用输出目录`，改写到 `webp_output_dir2`；勾 `替换 HTML 引用`，同步替换页面里的旧图名。

### 导入 Google Keep（「常规」页）

1. 把 Takeout 压缩包放进 `keep_takeout_zip_folder`。
2. 选导出方式：
   - `单篇导出 (single)`：需要同时打上 `single` 标签和分类标签；
   - `按标签合并 (merge)`。
3. 正文里的图片以 `[[IMG1]]` 占位；静态图转成 WebP，多帧 GIF 缩放后保留。

分类为“日记”时，文件名会强制补齐 `__` 前缀，配图归档到 `gallery/diary/`。覆盖同名旧 HTML 之前，会先备份到 `_build/temp/backup/`。

### 上传 Google 街景（「街景上传」页）

- 授权：复用本地的 PKCE OAuth 回调。凭据优先读 `privy/streetview_credentials.json`，没有时回退到 `privy/credentials.json`；刷新令牌单独存在 `privy/streetview_tokens.json`。
- 上传：点 `选择 JPEG...`，或直接把 `.jpg` / `.jpeg` 拖进管理窗（会自动切到这一页）。填写经纬度、朝向、地点 ID、拍摄时间和时区，执行 3 阶段上传；成功后自动回填 `Photo ID`。
- 更新：对已有的 `Photo ID`，可以只发送增量元数据更新。
- 过程和返回内容会完整写入底部运行日志。

### Google Tasks

凭据和令牌放在 `_build/privy/`（`credentials.json`、`tokens.json`）。授权过期后，在「常规」页点 `重新授权 Tasks`。

### 命令行

不开界面时可以用命令行：

| 命令 | 作用 |
| :--- | :--- |
| `swamp gen` / `swamp sim` | 全量构建 / 启动 9000 端口的线上仿真 |
| `swamp new [title] [category] [--open]` | 新建 HTML 页面（`--open` 同时打开 VS Code） |
| `swamp webp [maxW] [quality] [--alt-dir] [--update-mapping]` | 批量转 WebP，文件名复制到剪贴板 |
| `swamp keep2html [single\|merge] [tag] [category]` | 转换 Google Keep Takeout 压缩包 |
| `swamp synonyms` | 强制重建 `synonyms.js` 和未收录词报告，并执行 `gen` |
| `swamp --selftest` | 运行 90 项内置的安全与构建自检 |

## 2.6 出问题时先看这里

- OAuth 过期或要换账号：Tasks 在「常规」页点 `重新授权 Tasks`；街景在「街景上传」页点 `清除令牌`，再重新 `登录授权`。
- 怀疑构建或安全规则出了问题：点 `selfcheck` 运行 90 项自检；原生端异常崩溃时，看 `_build/temp/backup/swamp_panic.log`。
- 浏览器缓存卡死或异常：访问 `?repair=1` 并确认弹窗，会重置 SW、Cache、`MainDB` 和 `BookDB`，不删除摘抄本、已阅标记和个人收藏。
- 补丁回填后出了问题：见 3.2.5。

---

# 💡 架构迭代（作者和 AI）

适用于要改前端（`src/`）、Rust（`_build/swamp-server/`）或 Wasm，以及让 AI 来改的时候。分三节：

- 3.1 给作者：把系统逻辑理一遍，帮助判断从哪里下手。
- 3.2 协作约定：作者和 AI 共同遵守的边界、补丁包要求和代码规约。
- 3.3 给 AI：架构规格。新会话里，AI 读完 3.2、3.3，再看一部分相关源码，就应当能掌握站点的全貌。

---

## 3.1 给作者：系统逻辑梳理

隔一段时间再动框架，先看这一节回忆整体结构，再决定切入点。

### 3.1.1 一个仓库，两个面

站里许多看起来绕远的设计，都来自同一个矛盾：同一个 Git 仓库里，既要放“零后端的公网静态站”，又要放“带私有日记、能写本地文件、能连 IDE 热重载的个人工作台”。

| | 公网面（GitHub Pages） | 本地面（`swamp.exe`） |
| :--- | :--- | :--- |
| 形态 | 纯静态，没有后端代码 | `127.0.0.1` 伴生服务 + 5 标签页控制台 |
| 运行 | 浏览器里 6 个上下文各自独立运行 | 事务构建、热压缩、媒体和街景处理、补丁回填 |
| 私有内容 | 不能进入产物 | 可读、可写、可搜，但不污染任何公网产物 |

两个面之间只有一个合法的环境开关：`store.online_flag`（`"0"` 是本地 Serve，端口 8000；`"1"` 是线上仿真 Sim 或线上生产）。

围绕这条分界，系统在运行时、构建期和协作期形成了五条主要流程。六条不能破的边界放在 3.2.2。

### 3.1.2 五条主要流程，以及为什么这么绕

#### ① 构建与发布：先隔离检查，再原子换入

1. 取构建锁（先 `GEN_LOCK`，再 `ASSET_LOCK`），压住热压缩监听，避免并发覆盖。
2. 产物先写到 `_build/temp/staging_data_*`，`synonyms.js` 暂存在内存。这期间正式目录保持不变。
3. 公开页引用了私有图时，单独告警，不自动剪除。
4. 独立从磁盘重新读取公开页作为排除集，再用 Aho-Corasick（24 字窗口，步长 12）扫描全部公网产物。
5. 没有泄露，才逐文件原子写入正式目录。
6. 推送前再过四道检查：磁盘上的公网产物 → `.gitignore` → 暂存区（命中即 reset）→ 全部未推送历史（`-m`）。

为什么这么做：隐私检查不复用构建流水线里的公开文本作排除集，因为被检查的流水线自己就可能出 bug 导致泄露。必须独立从磁盘重读公开原文对照，才能在不误报的前提下拦住局部泄露。窗口 24 字、步长 12，任何不短于 35 字的片段都会完整覆盖至少一个窗口。

#### ② 离线更新与防撕裂：旧页面一直活在旧版本里

1. 发布新版后，新 SW 开始 install：先从旧缓存桶里取出 HTML 和 MD，存成 `MainDB` 快照。
2. 逐个拉取新文件，带 `?v={hash}`，用 CRC32 校验响应体。不匹配就绕过缓存重试一次；16 个关键文件里任何一个失败，安装中止。
3. 新 SW 进入 waiting，不强行接管。
4. 用户没点“更新”：旧 SW 继续工作，拦截 `core-list.js`，用自己内存里的 `FILE_MANIFEST` 现场合成响应。代码、清单、切片因此锁在同一个版本。
5. 用户点“更新”：发 `SKIP_WAITING`；`controllerchange` 后 `snapshot.js` 拍下一次性的现场，刷新，确认路径仍在 `lite_data` 里才恢复。

为什么这么做：纯静态站做离线，最麻烦的不是没缓存，而是半新不旧的版本撕裂，比如旧 JS 读到了新清单，或者 CDN 返回了旧文件、却被当成新哈希固定下来。由活跃 SW 在内存里合成 `core-list.js`，再加响应体 CRC32 对账，可以避免这两类问题。

#### ③ 统一检索：主线程只拿目录壳，计算和缓存都放到后面

1. 输入后先查 `MainDB.search_cache`（500 条 LRU）。
2. 未命中则交给 Worker。Worker 里的 Wasm 常驻全文和评论的内存库，用 1 MB 语料 Bloom、256 KB 评论 Bloom、4 档文档位图和首字 `ScanPlan` 加速。
3. 以 8 ms 为一个自适应时间片扫描，借 `MessageChannel` 让出主线程；新输入一到，旧扫描立即作废。
4. Wasm 命中后，叠加当前打开页面的 DOM 实时计数，再叠加每 10 分钟同步一次的评论索引，最后套用 `#sf-bar` 的后缀和年月过滤。
5. 打开 TXT、PDF、EPUB 时，向 `__DOC_SEARCH_BRIDGE__` 注册 Provider，借用主站的搜索框和主线程 Wasm。查近义词时传 `skipCorpusFilter` 绕开全站 Bloom，结果单独存在 `BookDB`。

为什么这么做：`MainDB.search_cache` 和 `BookDB` 分成两个库，是因为日常发版会联动清空 `MainDB.search_cache`，而电子书内容基本不变。拆开后，更新几篇笔记不会把几百页 PDF 的提取结果和搜索缓存一起清掉，`BookDB` 只在删书对账时定向清理。

#### ④ 写作、渲染与历史：写的时候尽量简单，显示的时候防注入

1. HTML 里写 `<pre>` 纯文本，另外可用原生的 `<p>` 表格和 `<code>`。
2. 浏览器解析后，`<p>` 和 `<code>` 已经是元素节点，纯文本是直属的文本节点。
3. `content.js` 只把直属文本节点交给 Wasm 的 `format_markdown`：先全量转义 `& < > " '`，再把图片名和 URL 生成 `<img>` / `<a>`。
4. 本地点 `edit`：更新 `#anchor` → 直接启动 `Code.exe` → 25 秒长轮询 `watch-html` → `Ctrl+S` 后记下 `scrollY`，原地重载。

历史 Diff 统一由 SW 在发版 / `gen` 时留底（`MainDB.html_snapshots`，至多 10 版）；本地打开 Markdown 对比时再叠加最近一次 SW 缓存版与实时读取的硬盘当前版，并自动禁用、隐藏编辑栏。

为什么这么做：在 `<pre>` 里写纯文本之所以安全，靠两步接力：DOM 解析阶段先分流，Wasm 再做纯文本转义。即使 Keep 笔记原文里夹带 HTML 标签，入库和渲染两端也都会被转义。

#### ⑤ 本地控制、补丁回填与重启交接：给本地网页写权限，但不给外部可乘之机

1. 服务只绑定 `127.0.0.1`，并校验 Host 白名单。
2. `/__api/*` 要过五重鉴权：Origin、`Sec-Fetch-Site`、`X-Swamp-Client: 1`、常量时间比较的 `HttpOnly` 会话 Cookie，以及 32 MB 体积上限。
3. 补丁回填：硬性禁止写入 `.git`、`.vscode`、`privy` 等路径；高危的构建文件必须在 VS Code Diff 里看过，才会解锁自动编译。
4. 自动编译交接：等 `active_ops == 0` → 停掉 sim → `server_handle.join()` → 用 `SWAMP_HANDOFF_TOKEN` 把令牌交给 `build.bat`（它在独立 `setlocal` 子过程中同时清空 `SWAMP_HANDOFF_TOKEN` 与 `_SWAMP_HANDOFF_TOKEN` 后再调 `cargo` / `wasm-pack`）→ 跑完 90 项 `--selftest` 后覆盖 `swamp.exe` → 新进程接收令牌，旧标签页无感续用。

补充：Tasks 和控制台的「街景上传」页共用 `/__oauth/callback`（PKCE S256，先验证 `state` 再消费，`oauth_pending` 防止并发冲突）。凭据可以共用，令牌分存在 `tokens.json` 和 `streetview_tokens.json`，从而把只读的任务权限和街景的发布权限分开。

### 3.1.3 隐性耦合：隔半年最容易“改 A 坏 B”的 10 处

| 改了这里（A） | 会牵连这里（B） | 漏改的后果 |
| :--- | :--- | :--- |
| `lib.rs` 的匹配、评分或位域打包 | `content.js`、`shared-utils.js`、`search-{ui,preview}.js`、`pdf-viewer.js`、`epub.html`、`txt.html`，以及 5 处 `SEARCH_ALGO_VER` | 高亮颜色错误、区间裁决冲突，或旧缓存顶替新结果 |
| `content.js` 往 `body` 挂新的浮层 | `bilingual.js` 的 `garbageSelectors` | 双语页点“固化”时，运行期挂件被永久写进 HTML 源码 |
| `content.js` 顶层初始化的时序 | 双语页里早期的 `#zhText.value` `MutationObserver` 劫持 | 草稿从 `AlignDrafts` 回填后，页内搜索高亮丢失 |
| `index.css` 里清理“没用到”的 `option[data-type]` | `search-ui.js` 升级 `<select>` 前，借临时 `<option>` 读分类色 | 搜索结果里图、音、视、电子书的配色全部变成黑色 |
| `content.css` 的 `html/body/code` 字体规则 | `md_viewer.html` 启动时 `fetch` 解析 `content.css` 来同步字体 | MD 阅读器字体莫名退回系统默认 |
| `index.html` 的 `viewport width=1024` | `touchpad.js` 的虚拟光标和缩放坐标计算 | 手机上虚拟触控板的指针整体漂移 |
| `pdf-viewer.css` 的高亮样式，或升级 PDF.js | `color: transparent` 透出 Canvas；v6 的私有 `#renderingDone` 要改挂 `_textHighlighter` | 高亮块盖住正文文字，或翻页后搜索高亮全部消失 |
| `side.js` 的目录树重建逻辑 | `side.js` 自渲染和 `index.js` 的 `RENDER_CATALOG` 两处都会触发，必须走 `attachMarkButtonsToDOM` | 刷新后侧栏所有 `[Mark]` 按钮和已读删除线消失 |
| `epub.html` 的章节重载回调 | Bibi 对长书卸载、重装 iframe，会让旧 `Text` 节点脱离文档（必须检查 `isConnected`） | 翻远再翻回的章节里，书内高亮和跳转静默失效 |
| 热更新时恢复视频播放进度 | `lightbox-logic.js`（`loadedmetadata`）和 `snapshot.js`（`readyState >= 1`）的写入先后 | 顺序颠倒，旧进度会覆盖热更瞬间的新进度 |

### 3.1.4 切入点：先判断改的是哪一层

动手前先问三个问题：

1. 这次改动落在哪一层：前端、Rust 服务端，还是 Wasm？这决定了改完要跑什么。
2. 会不会碰到 3.2.2 的六条边界？
3. 有没有命中 3.1.3 的耦合表？

接着按下表决定改完后要做的动作：

| 改动位置 | 改完后 |
| :--- | :--- |
| `src/js/raw/`、`src/css/raw/`、`src/css/font/` | 保存后 300 ms 自动热压缩，本地即时预览；发布前点一次 `gen` |
| `src/tpl/` 下的模板 | 点 `gen` |
| Rust 服务端代码（`main.rs`、`gui.rs`、`builder/` 等，不含 `lib.rs`） | `build.bat` 选 `[1]`，重编 `swamp.exe` |
| `_build/swamp-server/src/lib.rs`（Wasm） | `build.bat` 选 `[2]`（或 `[3]`），再点 `gen` |
| `swamp.toml` 里的 `[synonyms]` | 在控制台「同义词」页重建（见 2.4） |

`build.bat`（位于 `_build/swamp-server/`）的三个选项：

- `[1]` 编译 `swamp.exe`：改了非 `lib.rs` 的 Rust 源码后运行。先对新产物跑完 90 项 `--selftest`，全部通过后，才带重试地覆盖 `_build/swamp.exe`，并交接令牌重启。
- `[2]` 编译 Wasm（`src\wasm`）：改了 `src/lib.rs` 后运行。经 `wasm-stage` 完成 `wasm-pack` 和 `wasm-opt`，复制 `.wasm` 并压缩胶水脚本；完成后必须跑一次 `gen`。
- `[3]` 全部编译：依次执行 `[1]` 和 `[2]`，并启动新版管理窗。

Rust 的构建产物统一放在 `%LOCALAPPDATA%\swamp-cargo-target`，避免和同步盘抢文件锁。

让 AI 帮忙改时，建议用两步：先让它只看代码给方案，确认没偏题、没动禁区，再让它打增量 `.zip`。详细要求见 3.2.3。

---

## 3.2 协作约定

本节作者和 AI 都要遵守。AI 动手前先读完本节。

### 3.2.1 文件边界

AI 的补丁只能修改源码区；产物区由 `gen` 或 `build.bat` 生成，私有区不得读取、修改或打包。

路径约定：`src/js/`、`src/css/`、`src/tpl/`、`src/wasm/` 在仓库根目录；Rust 源码（`src/*.rs`、`src/builder/`、`src/services/`、`src/media/` 等）在 `_build/swamp-server/` 下。

- 源码区（允许修改）：
  - `index.html`（`PARAM-BEGIN..END` 之间除外）、`README.md`、`.gitignore`、`_build/swamp.toml`；
  - `_build/swamp-server/{Cargo.toml, Cargo.lock, build.bat, .cargo/config.toml, src/**}`；
  - `html/*.html`；
  - `src/js/raw/*.js`（不含 `src/js/raw/core-list.js`）、`src/css/raw/*.css`、`src/css/font/font.css`；
  - `src/tpl/*.html`（共 11 个）。
- 产物区（由 `gen` 或 `build.bat` 覆盖，禁止手改）：`/sw.js`、`src/js/*.js`（含 `core-list.js`、`synonyms.js`）、`src/css/*.css`、`src/js/data/*`、`src/wasm/*`、`src/discussion_id_mapper.json`、`gallery/img/idle-list.txt`。
- 私有与临时区（被 `.gitignore` 忽略，不得修改或打包）：
  - `_build/privy/`：`local.toml`、`credentials.json`、`tokens.json`、`streetview_{credentials,tokens}.json`、`upcoming_tasks.json`、`txn.txt`；
  - `_build/temp/`：`swamp_runtime.log`、`build_hashes.txt`、`oov_report.txt`、`synonyms.sha256`、`diff_preview/`、`staging_data_*/`、`backup/`；
  - `.git/`、`.vscode/`。

### 3.2.2 架构硬边界

下面六条是整个架构的承重约束。任何改动都不能破坏；确实需要改变时，必须先和作者讨论。

1. 公私隔离（宁可拒绝，也不放行）
   - `.gitignore` 缺失或没有有效规则时，直接拒绝构建。
   - 私有页必须以 `__` 开头（`keep2html` 导入“日记”时自动补齐）。
   - `Sim (9000)` 联动 `.gitignore` 拦截私有资源。
   - 任何新增的公网产物，都必须纳入 Aho-Corasick 检查和推送前的四道检查。
   - 私有内容的词频永远不进入 `synonyms.js`。
2. 本机信任：入库的配置不能决定执行什么
   - 涉及启动外部进程或搬动目录的 5 项路径（`vscode_path`、`katrain_dir`、`img_input_dir`、`webp_output_dir2`、`keep_takeout_zip_folder`），只认不入库的 `_build/privy/local.toml`。
   - 入库的 `swamp.toml` 在写回前必须通过 `SwampToml` 预校验，输出目录限定在仓库内。
3. 同源与路径安全
   - 街景已收口到桌面控制台，全站默认 CSP 不再有外部工具脚本的特例，也没有外部 CDN。
   - 静态服务只做一次 URL 解码，并在 `canonicalize` 后的真实路径上再复核；不做二次解码，以免误杀文件名里的字面 `%`。
   - 打开 VS Code 优先直接启动 `Code.exe`，绕开 `cmd.exe`。
   - 灯箱的 `about:blank` 和 EPUB 章节都锁定 `script-src 'none'`。
4. 线程与生命周期
   - 浏览器主线程不持有全站 HTML 正文。
   - 多标签页靠 `SiteCore` 的 20 个隔离键和 BUS 的 `tabId` 分开，只有 `SEARCH_CACHE_CLEARED` 跨标签页广播。
   - `@bomb` 清库前，必须先 `.close()` 所有 IDB 连接并清空 iframe。
   - Rust 的阻塞 I/O 走 `spawn_blocking`；GUI 的异步任务从 `g.state.rt_handle` 派发；构建锁的顺序固定为 `GEN_LOCK → ASSET_LOCK`。
5. 单一事实源与门禁
   - `MainDB` 的 Schema、20 个隔离键、`createStore` 只在 `site-core.js` 里定义。
   - 环境分支只认 `store.online_flag`（没有 `localStorage` 的 `sw.js` 除外）。
   - 任何要替换 `_build/swamp.exe` 的改动，都必须通过 90 项 `--selftest`。
6. 历史契约与锚点不可变
   - `store.lightbox_stauts`、`store.bookmarkhtml_modifing`、`MainDB.html_snapshots`、`__TXT_SEARCH_BRIDGE__`、`<span id="anchor">`、`<a id="end_flag">`、`_f`、`_uncategorized`，都是跨文件的契约，禁止单点“顺手纠错”或改名。
   - 所有构建产物（含 `src/js/raw/core-list.js`）都由 `gen` 独占生成，禁止手改。

### 3.2.3 协作流程与补丁包要求

1. 先分析、后交付。第一轮只读代码、给方案，说明要改哪些文件、是否碰到 3.2.1 和 3.2.2 的边界；作者确认后，再交付增量 `.zip`。
2. 补丁包的内容：
   - 路径从仓库根目录起算，不要多包一层顶层目录；
   - 只包含本次新增或修改的完整源码文件，不要 diff 片段，不要用省略号代替未改动的部分；
   - 不放入任何构建产物，也不放 `.git/`、`.vscode/`、`_build/privy/`。
3. 编码与换行：
   - `.bat` / `.cmd`：UTF-8 无 BOM + CRLF；
   - `.ps1`：UTF-8 带 BOM + CRLF；
   - 其余文件严格保持原文件的换行风格。
4. 验证说明写进仓库根目录的 `PATCH_NOTES.md`；回填时会自动跳过这个文件。
5. 回复正文里必须明确列出这些动作：删除或重命名文件、修改 `local.toml`、重编译 `swamp.exe` 或 Wasm、执行 `gen`。
6. 改动影响入口、配置、协议、用户操作方式、安全策略或自检数量时，同一轮里同步修订 `README.md`。

### 3.2.4 代码编排与注释规约

修改任何源码时，都按整体的最终状态来整理：清掉过时的、过程性的、考古性的、复述代码的注释，以及 `TODO` 和死代码；改动的原因只写进 `PATCH_NOTES.md` 或 Commit。存量代码的大规模重排要单独成批，不和功能改动混在同一个补丁里。

- JS（`src/js/raw/*.js`，不含 `core-list.js`；以及 `src/tpl/*.html` 里自写的 `<script>`），自上而下分 6 段：
  1. 文件头 `/** ... */`，用 1–3 行写职责和上下文；
  2. 导入、受控头和反脱壳守卫；
  3. 常量与可调参数，只给阈值加带单位的行尾短注；
  4. 模块运行态；
  5. 功能方法，用 `// --- 单元名 ---` 分组；默认不写方法注释，只有存在前置条件、位域或副作用时，才用 1–2 行点明；
  6. 初始化与导出。

  重排不能引发 TDZ，也不能改变早期副作用的执行时序。
- CSS（`src/css/raw/*.css`）：
  - `@charset "UTF-8";` 必须在第 1 行第 1 个字节；
  - 分 6 段：文件头 → `:root` 变量 → 全局与滚动条 → 主体布局（同一组件内保持 基础 → 子元素 → 交互覆盖 的层叠顺序）→ 独立浮窗 → `@keyframes` / `@media`；
  - 合并分散重复的选择器，4 空格缩进，伪元素用双冒号。
- Rust（`src/**/*.rs`），分 6 段：属性与 `//!` 头 → 导入（`std` → 外部 crate → `crate::`）→ 常量与静态量 → 数据结构与 `impl` → 核心业务（`// --- 单元名 ---`）→ 入口，以及按功能域分组的自检。注释只允许：`//!`、简短的单元注释、带单位的参数注释、说明契约的 `///`，以及 `SAFETY:` 和红线短注。
- Windows `.bat`：
  - 底线是 UTF-8 无 BOM + CRLF；
  - 前两行固定为 `@echo off` 和 `chcp 65001 >nul`；
  - `if (...)` 和 `for (...)` 的括号块内禁止使用 `::`，只能用 `rem`，且 `rem` 的内容里不能出现裸的 `% & | < > ^`。

### 3.2.5 作者侧操作：打包、回填与回滚

打包给 AI（「打包协作」页）：

- 在三态目录树里勾选要发给 AI 的源码；预设可增删改（存在 `swamp.toml`），也可以点 `选中 Git 改动`。
- 私有区和构建产物（含 `raw/core-list.js`）自动排除。
- 输出统一写入系统下载目录（`Downloads`），支持三种模式：`仅 ZIP`（默认）、`仅 MD`、`ZIP + MD`；生成 MD 时按单文件 KB 上限分卷（默认 200 KB）。

审阅与回填（「回填补丁」页）：

1. 在左栏 `下载目录` 里双击 `.zip`，或直接把它拖进窗口。
2. 在中栏双击任意文件，用 VS Code 的 `--diff` 查看改动。
3. 右栏 `backup` 里可以随时勾选，清理历史补丁包和快照。

回填的门禁和防误操作：

- `_build/privy/`、`.git/`、`.vscode/` 等禁区，硬性禁止回填。
- 涉及 `.cargo`、`Cargo.*`、`*.rs`、`build.bat`、`swamp.toml`、`.gitignore`、`rust-toolchain*` 或脚本后缀的条目，默认不勾选，并标为 `[构建配置·未查看]`；补丁包内含大小写冲突的重复条目会直接拒绝加载。必须逐个双击看完 Diff，标记变成 `[已查看]`，才会解锁“回填后退出并运行 `build.bat`”。
- 默认勾选 `覆盖前备份`：自动生成 `_manifest.json`，中途报错时同样保留，可在顶部 `回滚快照` 下拉里一键还原。
- 默认勾选 `规范 bat/ps1 编码`：`.bat` / `.cmd` 转为 UTF-8 无 BOM + CRLF，`.ps1` 转为 UTF-8 带 BOM + CRLF。

补丁改坏了：在「回填补丁」页，选 `回滚快照` 里对应的 `ai_apply_*`，点 `回滚此快照`，会还原被覆盖的文件，并清理新增的文件。

---

## 3.3 给 AI：架构规格

目标：新会话中，AI 仅凭本文档加一部分相关源码，就能判断站点怎么运行、问题大概在哪里，并交付不引入回归的补丁。

基线：单 Crate 双目标的 Rust 工程 `_build/swamp-server`（`v3.1.0`）+ 纯静态前端（11 个视图模板，没有外部工具脚本 CDN）+ 90 项 `--selftest` 自检。

读法：

1. 先读 3.2，确认边界和交付要求。
2. 用 3.3.3 的路由表，找到要看的源码文件和改后要做的动作。
3. 改之前，对照 3.1.3 的耦合表和 3.3.7 的契约清单。
4. 文档与源码不一致时，以源码为准，在回复里指出，并按 3.2.3 同轮修订 README。

### 3.3.1 运行拓扑

本地原生端（`_build/swamp.exe`）：

- Win32 Per-Monitor HiDPI 的 5 标签页控制台（`gui.rs` + `Arc<GuiMailbox>`）。
- Axum HTTP（Serve 为 `127.0.0.1:8000`，Sim 为 `9000`）：`host_guard` → `security_headers` → Router。
- 事务构建器（`builder/*`）：`GEN_LOCK` → `ASSET_LOCK`，做增量压缩、切片、同义词和隔离检查。
- 文件监听器（`watcher.rs`）：raw 文件 300 ms 热压缩；html 保存时广播。
- 后台与媒体服务：VPN 心跳、Tasks 轮询、Street View 上传、WebP、Keep2HTML、Pack。

浏览器自治端有 6 个执行上下文（`/__api/*`、`/__auth`、`/__oauth` 只在 Serve 模式下可用）：

1. 顶层主控（`index.html` + `site-core.js` + `index.js` + 按需懒加载的业务模块）：持有 `window.sharedWasm`（主线程 Wasm）、`window.data`（只有轻量的 4 元组，没有 HTML 正文）、`__DOC_SEARCH_BRIDGE__`、`VirtualCursor`、`callLocalApi`，以及 `MainDB` / `BookDB` 的代理。
2. `#side` iframe（`side.html` + `side.js`）：目录树、`SideDB` 已读记录、右键书签。
3. `#content` iframe：bookmark、html（`content` + `bilingual`）、`about:blank` 灯箱、pdf、epub、txt。
4. `#md-viewer-frame`（`md_viewer.html`）：MD 渲染、CodeMirror、双轨 Diff。
5. Web Worker（`worker.js` + Wasm + `synonyms.js`）：全文和评论的内存库，8 ms 切片检索。
6. Service Worker（`/sw.js`）：离线缓存、合成 `core-list`、快照。

另有独立新标签页工具：`go_board.html`、`txn_parser.html`、`pano.html`。

### 3.3.2 三态运行矩阵

业务代码唯一合法的环境开关是 `store.online_flag`。

| 能力维度 | 本地服务 Serve（`online_flag="0"`） | 线上仿真 Sim（`online_flag="1"`） | 线上生产 GitHub Pages（`online_flag="1"`） |
| :--- | :--- | :--- | :--- |
| 监听与入口 | `127.0.0.1:8000` + Win32 5 标签页窗 | `127.0.0.1:9000`（隐身 Chrome，无窗） | `https://<github_page>` |
| 控制面 `/__api/*` | 挂载（5 重鉴权 + 32 MB 限体） | 不挂载 | 不存在 |
| `_build/**` 静态访问 | 默认拒绝；白名单只放行 `privy/txn.txt` 和 `privy/upcoming_tasks.json` | 整个目录拒绝 | 不入库 |
| 私有内容访问 | 可读可搜（`html/__*.html`、`shadow*`、私有图库） | 强制拒绝（硬拦 `shadow*`、`html/__*`、`gallery/{diary,playboy}`，并联动 `.gitignore` 返回 404） | 不入库（目录标 `🔒`，切片占位 `"localOnly"`） |
| SW `fetch` 策略 | Network-Only（`no-store`），断网回退缓存；放行 `/__api`、`/__auth*`、`/__oauth` | Cache-First；活跃 SW 实时合成 `core-list.js` | 同 Sim |
| 站内写能力 | HTML `edit` 热重载、双语固化、书签拖拽、MD 编辑保存、KaTrain、`txn_parser` 跳行 | 全部关闭（双语页移除 `contenteditable`） | 全部关闭 |
| MD Diff 历史源 | SW 快照 `MainDB.html_snapshots`（最多 10 版）+ SW 当前缓存版 + 硬盘当前版（及未固化草稿） | SW 快照 `MainDB.html_snapshots`（最多 10 版，`vN`） | 同 Sim |
| 评论与同步 | 不弹 Giscus 窗，保留评论索引入口 | 加载映射表和 Giscus 弹窗 | 完整启用，每 10 分钟同步 `comments.json` |

### 3.3.3 需求到源码的路由表

定位问题或承接新需求时，按此表找文件和改后要做的动作。

- 路径约定：Rust 文件（`src/*.rs`、`src/builder/`、`src/services/`、`src/media/`）相对 `_build/swamp-server/`；其余路径相对仓库根。
- 动作缩写：`exe` 指 `build.bat` 的 `[1]`，`wasm` 指 `[2]`，`gen` 指全量构建。

| 业务域 / 常见任务 | 首选源码文件与关键符号 | 必查联动项 | 改后必需动作 |
| :--- | :--- | :--- | :--- |
| 全文、模糊、近义、ADS 检索与评分 | `_build/swamp-server/src/lib.rs`（`ScanPlan`、`weigh_section_hits`、`scan_docs_ads`）、`src/js/raw/worker.js`、`src/js/raw/search-engine.js` | 改匹配或评分语义必须递增 `SEARCH_ALGO_VER`（5 处） | 改 `lib.rs`：`wasm` + `gen`；仅改 JS：`gen` |
| 搜索 UI、筛选条、悬浮预览 | `src/js/raw/search-ui.js`（`#sf-bar`、`upgradeSearchResultsBox`）、`src/js/raw/search-preview.js` | `index.css` 保留 `option[data-type]`，用于读取分类色 | `gen` |
| 同义词词林扩展与 OOV 报告 | `_build/swamp-server/src/builder/{synonyms.rs,synonyms_tpl.js}`、`_build/swamp.toml` 的 `[synonyms]` | `worker.js` 搜全站用 Bloom，搜电子书必传 `skipCorpusFilter: true` | 改 Rust：`exe` + `gen`；仅改规则：在控制台重建 |
| HTML 渲染、页内高亮、代码工具、HTML Diff | `src/js/raw/content.js`、`src/lib.rs`（`format_markdown`、`compute_lcs_diff`）、`src/css/raw/content.css` | 新增挂在 `body` 上的运行期 DOM，必须补入 `bilingual.js` 的 `garbageSelectors` | 改 `lib.rs`：`wasm` + `gen`；否则 `gen` |
| 双语对照页编辑与固化 | `src/js/raw/bilingual.js`、`src/css/raw/bilingual.css`、`src/tpl/bilingual.html`、`src/api_files.rs`（`put_html`） | `content.js` 里早期的 `MutationObserver` 劫持 `#zhText.value` | `gen`（改 Rust 需 `exe`） |
| Markdown 阅读、编辑与双轨 Diff | `src/tpl/md_viewer.html`、`src/api_files.rs`（`put_md`） | `md_viewer.html` 解析 `content.css` 来同步字体；CodeMirror 被排除出 precache | 改 Rust：`exe`；改模板：`gen` |
| 电子书阅读与书内搜（TXT / PDF / EPUB） | `src/tpl/{txt,epub,pdf}.html`、`src/js/raw/{pdf-viewer,book-db}.js`、`src/css/raw/pdf-viewer.css` | `BookDB` 只在删书时定向清理；PDF.js v6 用 `_textHighlighter` 适配文本层 | `gen` |
| 图库、视频灯箱、全景与悬浮音乐 | `src/js/raw/{lightbox-logic,audio-player,shared-utils}.js`、`src/tpl/pano.html` | 灯箱 `about:blank` 禁止内联脚本；进度持久化走 `shared-utils.js` | `gen` |
| 侧边栏目录、已读标记、右键菜单 | `src/js/raw/side.js`、`src/css/raw/side.css`、`src/tpl/side.html`、`src/js/raw/deferred-features.js` | `buildCatalogFromLiteData` 重建 DOM 后，必须重新调用 `attachMarkButtonsToDOM` | `gen` |
| 离线缓存、防撕裂、热更新与自愈 | `src/js/raw/sw.js`、`src/js/raw/index.js`、`src/js/raw/snapshot.js`、`src/js/raw/site-core.js` | 新增的离线静态资源要命中 `swamp.toml` 的 `precache.include`；首屏核心资源加入 `CRITICAL_URLS` | `gen` |
| 本地编辑热重载、书签拖拽、摘抄、评论 | `src/api_ops.rs`（`post_edit`、`get_watch_html`）、`src/js/raw/{bookmark,excerpts,comments}.js` | `#anchor` 和 `#end_flag` 是硬锚点契约 | 改 Rust：`exe`；改 JS：`gen` |
| 触屏虚拟触控板 | `src/js/raw/touchpad.js`、`src/css/raw/index.css` | 依赖 `index.html` 的 `width=1024`，以及各 iframe 顶部的 `VirtualCursor.attach(window)` | `gen` |
| 全量构建、压缩器、隐私隔离检查 | `_build/swamp-server/src/builder/{mod,generator,minify,html_utils}.rs` | 任何新的公网产物，都要纳入 `assert_no_private_leak` 和 `verify_public_outputs_clean` | `exe` + `gen` |
| 控制台 GUI、打包与回填、Git 推送、街景与 Tasks | `_build/swamp-server/src/{gui,main,security,static_fs}.rs`、`src/services/{pack_apply,tasks,street_view,watcher,log_bus}.rs` | 新增 API 或安全规则，要同步补充 `security.rs` 里的 `--selftest` | `exe` |
| 独立工具页与媒体批处理 | `src/tpl/{go_board,txn_parser}.html`、`src/js/raw/txn_parser.js`、`src/media/{webp,keep2html}.rs` | `go_board` 的静态资源在 `swamp.toml` 里预缓存；`keep2html` 的“日记”强制 `__` 前缀 | 改 Rust：`exe`；改前端：`gen` |

### 3.3.4 编译目标与第三方库

单 Crate 双目标编译（Windows）：

- 原生端（`--bin swamp`）：`cargo build --profile release-exe`，参数为 `opt-level="s"`、`lto=true`、`codegen-units=1`、`strip=true`、`panic="unwind"`（崩溃日志写到 `_build/temp/backup/swamp_panic.log`）。`build.bat` 固定把 `CARGO_TARGET_DIR` 指到同步盘之外的 `%LOCALAPPDATA%\swamp-cargo-target`，并且先通过全部 90 项 `--selftest`，再带重试地替换 `_build/swamp.exe`。
- Wasm 端（`--lib`，`compute_intensive_task_processor`，`cdylib`）：`wasm-pack build --target web`，`.cargo/config.toml` 开启 `+simd128`，`release` 配置为 `opt-level="z"`、`panic="abort"`，再跑 `wasm-opt -Oz`。先在 `%LOCALAPPDATA%\swamp-cargo-target\wasm-stage` 暂存（避开网盘抢锁），再复制 `.wasm`，并用 `swamp.exe minify` 压缩胶水 JS。

同源第三方库及其定制：

- PDF.js（`6.5.438`）：`pdf.html` 的 CSP 没有 `'unsafe-inline'`；`enableScripting: false` 双重锁定；v6 把 `TextLayerBuilder.#renderingDone` 改成了私有成员，所以 `pdf-viewer.js` 通过 `pageView._textHighlighter` 适配文本层高亮；预缓存 `en-US` 和 `zh-CN/*.ftl`。
- Bibi（`1.2.0`）：`epub.html` 在加载 `bibi.js` 前拦截创建章节 `<iframe>` 并锁定 `sandbox="allow-same-origin"`（不含 `allow-scripts`），再在 `bibi:postprocessed-item` 和 `loaded-item` 事件里执行 `hardenChapterDocument` 做纵深剥离；章节从占位符重载时，要检查 `prev.nodes[0].node.isConnected`，防止旧节点失联。
- marked（`4.3.0`）+ DOMPurify（`3.5.0`）+ hljs + CodeMirror 5：`md_viewer.html` 的处理管线是 `protectMath → marked → restoreMath → DOMPurify（禁 script/style/iframe/svg/math/form/template/srcdoc）→ fixBold → highlightCode`；CodeMirror 5 只在本地编辑态加载，并被 `precache.exclude` 排除。
- Photo Sphere Viewer（`2.9`） + three.js（`2.3`）：`pano.html` 使用早期的 PSV 构造器（`time_anim`、`navbar_style`），并强制校验 `?src=` 必须是同源的 `/gallery/*.{jpg,jpeg,png,webp,gif}`。
- Prism、encoding.js、confetti：分别用于 HTML 代码高亮、TXT 编码兜底、更新时的彩纸。

### 3.3.5 跨边界契约

#### Wasm 导出面与高亮位域（`src/lib.rs`）

22 个导出函数：

- 数据建库：`set_data`、`build_flat_data`、`build_and_set_data`、`doc_count`、`set_comments`、`comment_doc_count`。
- 检索与摘要：`supports_weighted_keywords`、`bloom_might_match`、`prepare_search`、`scan_prepared_range`、`search_multi_range`、`prepare_ads_search`、`scan_prepared_ads_range`、`search_ads_range`、`prepare_comment_search`、`scan_prepared_comments_range`、`search_comments`、`get_snippets`、`get_snippets_ads`。
- 渲染与页内：`format_markdown`、`find_content_matches_multi`、`compute_lcs_diff`。

`find_content_matches_multi` 返回 `{ count, matches: Uint32Array }`，每 3 个 `u32` 是一条命中：`[start_u16, end_u16, packed_meta]`。`packed_meta` 的位域：

- `bits 0..7`（`meta & 0xff`）：`noise`，取值 0–255。
- `bits 8..9`（`(meta >> 8) & 3`）：`tier`。`0` 是原词，`1` 是 1-hop、自定义或别名，`2` 是双槽组合。
- `bits 16..23`（`(meta >>> 16) & 0xff`）：`weight`，取值 10–100。

全站统一的匹配与裁决规则（Wasm、`content.js`、`search-engine.js`、`shared-utils.js` 必须保持一致）：

- 有效噪值上限：$\min(\text{noise}, \text{len} > 25 ? 0 : \lfloor \text{len}/2 \rfloor)$。单个空白不计噪，连续空白超过 1 个才计噪；`\n`、`\r` 和 `。！？；!?;` 是硬边界，不能跨越；匹配前统一做全角转半角和小写折叠。
- 重叠区间的裁决优先级：`tier` 升序 → `noise` 升序 → `weight` 降序 → 覆盖长度降序。
- 评分：
  - 标题基分 5000（每 1 噪 $-500$，同义封顶 4500，饱和 $k=1$）；
  - 正文基分 100（每 1 噪 $-10$，同义封顶 450，饱和 $k=4$）；
  - 按权重降序加权求和 $\sum v_i \cdot k/(k+i)$；
  - 叠加“文档最小原词噪值”的保底分：噪值 0 加 10000，1 加 3000，2 加 2200，3 加 1500，4 加 900，其余加 500。
- `SEARCH_ALGO_VER = 11`：修改任何匹配或评分语义，必须同步递增 `search-engine.js`、`book-db.js`、`pdf-viewer.js`、`epub.html`、`txt.html` 这 5 处。

#### `BroadcastChannel('bus')` 与 `window.top` 直连

- BUS 消息信封：`{ type, payload, from, target, tabId }`，`target` 取 `index`、`side`、`content` 或 `*`。所有接收端都必须丢弃 `tabId && myTab && tabId !== myTab` 的跨标签页消息；唯一的跨标签页例外是 `SEARCH_CACHE_CLEARED`。
- 常见消息：
  - 目录与导航：`REQUEST_CATALOG` / `RENDER_CATALOG`、`#{html,gallery,video,audio,ebook} a`、`SYNC_CURRENT`、`show_current`、`update_bookmark_menu`、`mask`、`adj_side_width`。
  - 视图与播放：`image` / `video` / `pdf` / `epub` / `txt` / `audio`、`play_fav_list` / `PLAY_PRESET_AUDIO` / `UPDATE_FAV_LIST`、`lightbox`（`{ status: "0"|"1" }`）、`OPEN_MD_VIEWER`、`reload_bookmark`。
  - 检索与高亮：`quick_search`、`CLEAR_SEARCH`、`DESTROY_HIGHLIGHT`、`REFRESH_HIGHLIGHT`、`LOCAL_SEARCH_{COUNT,RESULT,SNIPPETS,SNIPPETS_RESULT}`、`SEARCH_CACHE_CLEARED`。
  - 外围与系统：`load_comments` / `sh_comments` / `cm_count` / `COMMENT_COUNTS`、`OPEN_EXCERPTS_NOTEBOOK` / `SAVE_EXCERPT`、`show_changelog`、`{SHOW,CLOSE}_GLOBAL_BOOKMARKS`、`show_update_banner` → `execute_update`、`SIM_POINTER`。
- `window.top` 上的直连句柄：`SiteCore`、`sharedWasm`、`__DOC_SEARCH_BRIDGE__`（别名 `__TXT_SEARCH_BRIDGE__`，含 `register`、`unregister`、`getScope`、`setScope`）、`VirtualCursor`、`callLocalApi`、`pinyinData`、`commentCounts`、`lite_data`、`readme_md`、`parseAdsQuery`、`buildAdsPositiveTerms`、`buildTermSpecs`、`hasTermSpecs`、`ensureTermSpecs`、`takeSnapshot`、`_isBombing`。

#### 本地控制面 HTTP（仅 Serve 模式挂载）

所有请求都先经过 `host_guard_middleware`（只放行 `localhost:<port>` 和 `127.0.0.1:<port>`）和 `security_headers_middleware`（统一的 `CSP_HEADER_VALUE`，`.svg` 单独使用 `CSP: sandbox`）。`/__api/*` 还要经过 `api_auth_middleware`：强制检查 `Origin` 白名单（写接口必带）、`Sec-Fetch-Site: same-origin`、`X-Swamp-Client: 1`、`subtle` 常量时间比较的 `HttpOnly` Cookie（`swamp_session`），以及 32 MB 的体积上限。

| 路由 | 方法 | 职责与关键约束 |
| :--- | :--- | :--- |
| `/__auth` | GET | 核销一次性 60 s 引导码 `?code=...`，下发 `Set-Cookie: swamp_session=...; Path=/; HttpOnly; SameSite=Strict` 并抹掉 URL；用 `navigator.locks.query()` 检测 `swamp_main_tab` 锁，已有主页则自行关闭，否则跳转 `/` |
| `/__auth/refresh` | POST | 401 时自动续签：校验 Origin、Sec-Fetch-Site、`X-Swamp-Client: 1` 和 JSON；同一时刻只弹一个 Win32 物理确认框（拒绝后冷却 10 s，通过后宽限 3 s），仅通过 `Set-Cookie` 下发 `HttpOnly` Cookie |
| `/__oauth/callback` | GET | Google Tasks 和 Street View 共用：先核对 `state`，再消费 `PendingOAuth`；CSP 为 `script-src 'none'` |
| `/__api/health`、`/__api/tasks` | GET | 探活；返回内存中近期到期的 Tasks |
| `/__api/files/html`、`/__api/files/md` | PUT | 原子写盘：双语页（带 BOM，只限已存在的文件）；MD（`spawn_blocking`，排除 `_build` 和 `.git`） |
| `/__api/bookmarks` | POST | 原子地增、删、移 `src/tpl/bookmark.html` 里的书签，并更新 `#end_flag` 的毫秒时间戳 |
| `/__api/ops/edit`、`/__api/ops/watch-html` | POST、GET | 更新 `<span id="anchor">`（兼容无时间戳的旧页）并拉起 VS Code；25 s 长轮询监听保存广播，另有 2 s 兜底，`shutting_down` 时立即退出 |
| `/__api/ops/{explorer,cli,txn,katrain}` | POST | 打开仓库根目录；触发 `gen`；用 VS Code 的 `-g txn.txt:<line>` 跳行；聚焦或用 `uv run` 启动 KaTrain |

#### 存储 Schema 与淘汰规则

- `SiteCore.createStore` 只在 `site-core.js` 里定义。默认读写 `localStorage`；下面 20 个按标签页隔离的键（`TAB_SCOPED_KEYS`）自动路由到 `sessionStorage`：`resource_type`、`content_src`、`pdf_path`、`epub_path`、`txt_path`、`image_path`、`video_path`、`song_path`、`imagelist`、`videolist`、`playlist`、`last_html`、`lightbox_stauts`、`jump_from_search`、`jump_from_search_ex`、`giscus_jump`、`keyword`、`bookmarkhtml_modifing`、`bookmarkhtml_linksHash`、`force_refresh_cache`。
- 缓存与数据库：

| 存储 | 名称 / 版本 | Store / 内容 | 上限与清理规则 |
| :--- | :--- | :--- | :--- |
| Cache | `core-cache-{BUILD_VERSION}` | 站点壳、静态脚本和样式、HTML、Wasm、`synonyms.js`、`README.md`、`go_board` 素材、`sw-manifest.json` | 新 SW `activate` 时删除旧桶 |
| Cache | `media-cache` | `/audio/`、`/video/`、`/gallery/`、`/ebook/`，字体，PDF 的 `cmaps`、`standard_fonts`、`iccs`、`wasm`、`images` | Cache-First；只在删除媒体或字体换 query 时定向清理 |
| IDB | `MainDB` v3 | `chunks`、`update_logs`、`search_cache`、`sys_state`、`html_snapshots` | `search_cache` 为 500 条 LRU（单次命中 $>300$ 的不入库）；`html_snapshots` 每页 10 版，`deflate-raw` 压缩 |
| IDB | `BookDB` v1 | `book_extracts`、`search_cache`（TXT / PDF / EPUB） | 提取内容最多 30 本 / 32 MB（单本 12 MB）；搜索缓存最多 600 条 / 16 MB（单书 80 条，单条 512 KB）；超过 4 KB 的压缩；站点更新不清空，只在删书时由 `pruneDeletedBooks` 清理 |
| IDB | `ExcerptsDB`、`SideDB`、`AlignDrafts`（均为 v1） | 摘抄（`books`）、已读（`marks`）、双语草稿（`draft_texts`） | 持久保留；`@bomb` 删库前必须先显式 `.close()` |
| 本地文件 | `_build/temp/` | `swamp_runtime.log`（800 条，启动时超过 1000 条或 512 KB 就瘦身）、`build_hashes.txt`、`oov_report.txt`、`synonyms.sha256`、`diff_preview/`（保留 10 份）、`backup/` | 受 `.gitignore` 和 HTTP 默认拒绝保护 |

### 3.3.6 四条数据流管线

设计原因见 3.1.2，这里只记实现细节。

#### 管线 A：事务构建与公私隔离（`swamp gen` 和 `push`）

1. 锁序：`GEN_LOCK.try_lock()`（同一时刻只允许一个构建）→ 阻塞获取 `ASSET_LOCK.lock()`（等热压缩收尾；全程阻断 `watcher` 的非阻塞 `try_acquire_asset_lock`，并有 1.5 s 的尾项冷却）。
2. Phase 1，并行压缩：
   - 用 `rayon` 压缩 `src/{js,css}/raw/*` 和 `font.css`（跳过 `core-list.js`、`sw.js`、`synonyms.js`）；
   - 核对 `build_hashes.txt`（格式 `swamp-min-v3|raw_sha|out_sha`），并清理废弃产物；
   - ES2020 的 JS 压缩器要保护：`}\nwhile` 的 ASI、`for await (...) /re/`、`#privateField`、嵌套的模板字面量；CSS 压缩器要保护 `calc()` 和空的自定义属性 `--x: ;`。
3. Phase 2，暂存事务与隔离检查：
   - 在内存里准备 `index.html` 的参数注入；加载 `.gitignore`（没有有效规则就拒绝构建）。
   - 区分 `all_image_set` 和 `public_image_set`（联动 `git check-ignore`）；扫描 `html/*.html`，强制验证 `__` 页面被忽略，以及 `<title>` 唯一；公开页引用私有图时单独告警、不误剪；`extract_body_text` 只剥离合法的 `<[A-Za-z/!?]...>` 标签，并保留 `\n` 硬边界。
   - 扫描媒体目录：`canonicalize` + `visited_dirs` 防环，禁用 `_f`、`__proto__`、`constructor`、`prototype`，并联动 `git check-ignore`。
   - 在 `_build/temp/staging_data_<pid>_<ms>`（由 RAII 的 `StagingDirGuard` 管理）写出 `lite_data.js`、`fat_data_*.json`、`shadow*`、`core-bundle.json`；`synonyms.js` 只在内存暂存、不落盘；只有 `(path, hash, source)` 发生变化，才推进 `BUILD_VERSION`。
   - Aho-Corasick 全覆盖检查：独立从磁盘读取公开 HTML 和 `README.md` 作为排除集；私有页去掉 `#anchor` 后的正文（连续短行自动合并）切成 24 字、步长 12 的重叠窗口，编入同一个自动机，线性扫描全部公网产物（含 `lite_data.js` 与已清理历史已删私有记录的 `discussion_id_mapper.json`，仅放行活跃私有页已知的文件名、标题和时间戳）；命中即中止，正式目录不做任何改动。
   - 原子提交：先写 `synonyms.js`、`index.html`、`discussion_id_mapper.json`，再逐文件 `write_bytes_atomic` 提交 `src/js/data/` 并删除废弃切片，最后写 `raw/core-list.js`、`raw/sw.js`、`idle-list.txt`。
4. Phase 3 与推送四重门禁：压缩 `raw/core-list.js` 和 `raw/sw.js`，落盘账本。独立的 `push` 依次执行：
   1. `verify_public_outputs_clean`；
   2. 校验 `.gitignore`；
   3. `git add -A` 后扫描暂存区，以 `is_private_push_path` 硬编码底线与 `.gitignore` 规则的并集判定，任一命中即 `git reset` 并中止；
   4. 扫描 `git log -m --name-only -z`，覆盖全部未推送的提交历史。

#### 管线 B：冷启动、SW 防撕裂与现场恢复

1. 首屏与认证：`index.html` 先非阻塞地显示成人遮罩（跳过爬虫 UA）→ 注入 `PARAM` → 加载 `site-core.js` → `index.js` 清理历史明文令牌并持有 `swamp_main_tab` 共享 Web Lock（会话由 `HttpOnly` Cookie 承载）→ 并行预热主线程 Wasm 和搜索模块。
2. 自愈与防撕裂：`?repair=1` 用 `URLSearchParams` 精确匹配，并用 `confirm()` 二次确认（取消则剥离该参数）。线上模式下，活跃 SW 拦截 `/src/js/core-list.js`，直接用自己的 `FILE_MANIFEST` 在内存里合成响应，保证点“更新”之前，代码、清单、切片的版本是锁定的。
3. SW 安装对账：
   - 变更的 `/html/*` 和 `*.md`，压缩存入 `MainDB.html_snapshots`；
   - 变更文件超过 15 个，或首次安装，拉取 `core-bundle.json`；否则逐个拉取并附带 `?v={hash}`，做 IEEE CRC32 响应体对账（不匹配就用 `cache:'reload'` 重试一次）；
   - `CRITICAL_URLS` 的 16 项里任何一项失败，安装中止；非关键文件失败则回退旧桶并保留旧哈希；
   - `synonyms.js` 或 Wasm 有变更时，写入 `pending_search_cache_clear`，在 `activate` 阶段清库。
4. 数据同步与恢复：
   1. `loadScripts`（90 s 看门狗）并行预热 Worker 和 `MainDB.chunks`；
   2. `RENDER_CATALOG`；
   3. 如果存在 `ss_restore_strict` 快照，先校验路径是否完好，再恢复（缺失则清掉脏键，退回书签页）；
   4. 差分拉取 `fat_data_*.json`（0 个失败才 `saveBatch` 落盘并清搜索缓存）；
   5. Worker 执行 `BUILD_DATA`（45 s 看门狗）；
   6. 对账媒体和 `BookDB.pruneDeletedBooks`；
   7. 空闲时预热基础字体、`comments.js`、`deferred-features.js` 和触屏用的 `touchpad.js`。

#### 管线 C：检索、渲染与双轨 Diff

- 检索加速：Worker 持有 1 MB 语料 Bloom、256 KB 评论 Bloom、4 档文档 `DocFilter` 和首字 256-bit 的 `ScanPlan`；以 8 ms 的自适应时间片（每片 16–4096 篇文档）借 `MessageChannel` 协作让出，`token` 一变就作废旧扫描。ADS 语法为 `@[expr]词1[NM]...`，最多 26 个形参、8 层嵌套；双端都拒绝空文档恒真的表达式，并按非否定、低噪、长词优先的顺序短路。
- 近义词与书内搜：`synonyms_tpl.js`（`cilin-1hop-df-v5.1`）依次经过整词直达 → `#` / `@` 与 `stopExpand` 保护 → DP 分词 + 5 级编码 LCA 消歧 + 公开语料 DF 的 7 档乘数 + `K` / `L` 降权。书内搜必须传 `skipCorpusFilter: true`（`cacheTag: 'raw'`），绕过全站 Bloom。搜索缓存有四条失效途径：`core` 命名空间、`syn` 指纹、SW 的 `pending_search_cache_clear`、`fat_data` 增量落盘。
- HTML 渲染与 Diff：
  - `content.js` 只把 `<pre>` 的直属文本节点交给 Wasm 的 `format_markdown`；生成 `<img>` / `<a>` 之前先全量转义 `& < > " '`，防止标签复活；`<p>` 表格和 `<code>` 元素节点保持原样。
  - HTML Diff 跟踪 `inCode`，防止改语言时出现嵌套的 `<code>`。
  - MD 的 Diff 统一由 SW 留底（`MainDB.html_snapshots`，至多 10 版），本地额外读取最新 SW 缓存版与实时硬盘当前版；进入 Diff 时禁用并隐藏编辑栏；正常编辑态下通过 `marked.lexer` 源码行映射实现预览与编辑器的行级锚定联动滚动。

#### 管线 D：补丁回填、安全交接与伴生服务

- 三级补丁防线：
  - 硬禁止：`.git/`、`.vscode/`、`_build/{privy,temp,secrets,backup}/`、`target/`、`html/__*`、`shadow*`、`cilin.txt`、`protocol.key`、`{,streetview_}{credentials,tokens}.json`，以及路径穿越、8.3 短文件名、设备名。
  - 构建与脚本类（`.cargo`、`Cargo.*`、`*.rs`、`build.bat`、`rust-toolchain*`、`swamp.toml`、`.github/*`、`.git*`、脚本后缀）：标 `[构建配置·未查看]`，默认不勾选；同时拒绝含重复或大小写冲突条目的 ZIP；必须双击在 VS Code 里用 `--diff` 看完（`.code-workspace` 自动追 `.txt`），才解锁自动编译。
- 两遍写盘与交接：
  - Pass 1 做全量校验，单文件上限 64 MB，总量上限 256 MB。
  - Pass 2 在 RAII 的 `ManifestGuard` 保护下备份并写盘，可选地规范 `.bat` / `.cmd`（UTF-8 无 BOM + CRLF）和 `.ps1`（UTF-8 带 BOM + CRLF）。
  - 自动编译经 `WM_APP_EXIT_AND_BUILD`，等 `active_ops == 0` → 停 `sim` → `server_handle.join()` → 通过 `SWAMP_HANDOFF_TOKEN` 交接令牌并拉起 `build.bat`（调用 `cargo` / `wasm-pack` / `swamp.exe` 子命令时在独立 `setlocal` 子过程中同时清空 `SWAMP_HANDOFF_TOKEN` 与 `_SWAMP_HANDOFF_TOKEN`）。
- 5 标签页的伴生服务：
  - VPN 心跳，以及 Tasks 与 Street View 共用的 PKCE OAuth 回调（`oauth_pending` 互斥）。
  - Street View 优先读 `privy/streetview_credentials.json`，回退 `privy/credentials.json`，令牌单独存 `privy/streetview_tokens.json`；使用 `reqwest::Url` 严格校验 `uploadUrl` 只能是 `https://*.googleapis.com:443` 且关闭自动重定向，大图读盘走 `tokio::fs`。
  - `keep2html` 解压限制：单文件 64 MB、总量 512 MB；用 `"IN_PROGRESS"` 标记支持中断后自愈；“日记”分类（`single` 和 `merge` 两种模式）都强制补 `__` 前缀，并归档到 `gallery/diary/`。

### 3.3.7 容易被“顺手改坏”的契约与安全细节

3.1.3 的 10 处耦合和 3.2.2 的六条边界同样适用。这里补充其余的：

- 保留拼写与命名：
  - `store.lightbox_stauts`、`store.bookmarkhtml_modifing`（横跨 `site-core`、`index`、`lightbox-logic`、`snapshot`）；
  - `MainDB` 的 `html_snapshots`（同时存 HTML 和线上 `.md`）；
  - `window.__TXT_SEARCH_BRIDGE__` 和 `__DOC_SEARCH_BRIDGE__` 两个别名；
  - `lite_data.js` 里保留的键 `_f` 和 `_uncategorized`。
- DOM 与样式的隐性契约：
  - HTML 锚点 `<span id="anchor">YYYYMMDDHHMMSS-分类链</span>`（`post_edit` 兼容无时间戳的旧页并自动补全）；`bookmark.html` 依赖 `<a id="end_flag" href="...">`。
  - `index.css` 必须保留 `#searchResults option[data-type]`；`pdf-viewer.css` 的高亮必须保持 `color: transparent`；`index.html` 的 `width=1024` 不能改成 `device-width`。
- 删库与异步的红线：
  - `@bomb` 清库前，必须先关闭 `MainDB`、`BookDB`、`ExcerptsDB`、`SideDB`，并把 iframe 置为 `about:blank`（期间 `_isBombing = true`）。
  - GUI 里派发 Tokio 异步任务，要借 `g.state.rt_handle.spawn(async move { ... })`，注意不要和被 move 走的 `st` 产生借用冲突。
- 信任边界：
  - 完全信任的来源只有本机私有配置，见 3.2.2 第 2 条；兼容旧的 `local.properties`。
  - 受限来源：`swamp.toml`（`webp_output_dir` 限制在仓库内，`heartbeat_url` 限制为 `http(s)://`，写回前必须通过 `toml::from_str::<SwampToml>`）、AI 补丁 `.zip`、Keep `.zip`、外部浏览器页面。
  - 纵深防线：全站没有外部工具脚本 CDN，也没有 `eval`；拉起 VS Code 时，直接启动 `Code.exe` 失败后才会回退，回退路径会拦截全部 cmd 元字符；90 项 `--selftest` 是编译发布的硬门禁。