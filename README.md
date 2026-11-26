# [diff4x's digital swamp](https://github.com/diff4x/diff4x.github.io)

> 个人数字信息库
>
> <img src="https://avatars.githubusercontent.com/u/222525381?v=4" width="200">

本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航

> 静态设计：初代 by diff4x | 进化 by Gemini & Claude & ChatGPT & Grok

---

# 访客如何高效使用

全站采用单页双栏布局：左侧显示正文、图库、音视频或电子书，右侧常驻目录树与搜索栏，所有浏览进度、已阅标记、收藏与摘抄均保存在当前浏览器本地。

## 1. 界面、目录与常用入口

- **调宽与目录状态**：点击右侧栏顶部 `←` / `→` 可调整侧栏宽度。分类名旁标注 `[近期更新/总数]` 或 `[总数]`，72 小时内更新的条目会自动高亮。
- **已阅标记**：每条目录右侧提供 `[Mark]` / `[UnMark]`，标记后条目加删除线，方便追踪阅读进度。
- **快捷交互**：
  - 悬停图片或视频条目可看缩略图；双击条目文字直接复制文件名。
  - 在侧边栏内**右键单击**打开全局书签菜单；**右键双击**呼出浏览器原生右键菜单。
- **侧栏顶部功能区**：
  - `What's new?`：查看站点更新日志与最新评论，点击条目直接跳转定位。
  - `History`：最近 50 条浏览历史。
  - `Fav`：音乐收藏列表（收藏歌曲后自动显示）。
  - `Excerpts`：个人摘抄本，按文章或书名归档管理。
- **首页书签内置工具**：
  - `street_view_uploader`：Google 街景全景图上传器（新标签页）。
  - `txn_parser`：交易流水解析器（新标签页）。
  - `⚪ go_board`：围棋摆谱工具（新标签页）。
  - `❓ README`：站内说明文档（左击打开阅读器，中击跳转 GitHub 仓库）。
  - `❓ guestbook`：免登录留言板（新标签页）。

## 2. 搜索：全站检索与书内检索

### 基本操作与即时预览
- **快速呼出与收起**：页面任意位置按 `\` 聚焦搜索框（在 PDF / EPUB 中也可按 `Ctrl+F` 直接搜本书）；点击 `clear` 或在搜索区域内**鼠标中击**收起；右键点击历史搜索词可删除该条记录及对应缓存。
- **搜全站 / 搜本书自动切换**：打开 TXT / PDF / EPUB 时搜索框自动切为「搜本书」，命中结果按章节或页段分组；点搜索工具条或阅读器顶栏按钮可随时切回「搜全站」。
- **不点开也能预览**：
  - HTML 与电子书命中项：鼠标悬停看命中上下文，**右键**切换预览区自动滚动或暂停。
  - 图片命中项：鼠标悬停看大图预览。
  - 音视频命中项：**右键**直接弹窗试播或暂停（带倒计时，自动记住播放进度）。
- **筛选与时间定位**：
  - 可按文件后缀筛选，HTML 结果支持按「年月」筛选。
  - HTML 时间戳与 `gallery/拍摄` 文件名统一为 `YYYYMMDDHHMMSS`，直接搜 `202610` 或 `2610` 即可定位对应月份的内容。
  - 命中评论的条目会标 `[💬 数量]`；带 `🔒` 的条目为站长本地私密内容，线上不可查看。

### 模糊容错、近义词与布尔组合
- **容错（噪值 0–5）**：允许搜索词相邻字符间夹杂无关字符；单个空格不计噪，换行与句末标点（`。！？；!?;`）不可跨越。实际生效上限随词长自动缩放为 $\min(\text{noise}, \text{len} > 25 ? 0 : \lfloor \text{len} / 2 \rfloor)$。以噪值 3 为例：

  | 搜索词长度 | 1 | 2–3 | 4–5 | 6–25 | $\ge 26$ |
  | :--- | :---: | :---: | :---: | :---: | :---: |
  | 字间最多夹杂无关字数 | 0 | 1 | 2 | 3 | 0 |

- **近义词扩展**：勾选「近义」后会基于词林与站内词频自动扩展相关词（近义词采用精确匹配，不叠加噪值）。
- **布尔组合搜索**：以 `@[...]` 开头启用组合查询，支持 `&`（且）、`|`（或）、`!`（非）与括号 `()`，最多支持 26 个单字母形参（`a`–`z`），且至少需包含一个正向词（不能在空文档上恒真）。
  - 示例：`@[a&!(b|c)]飞机[31]大炮[]机枪[0]`（含「飞机」且不含「大炮」或「机枪」）。
  - 词后方括号：`[]` 沿用全局设置；`[N]` 指定噪值 $N \in [0, 5]$；`[NM]` 同时指定噪值 $N$ 与近义开关 $M \in \{0, 1\}$。

## 3. 阅读、摘抄与版本对比

- **HTML 正文**：
  - 左上角 `diff` 可任选两个历史版本对比改动（最多保留 10 版快照）；线上模式点击 `💬` 可用 GitHub 账号发表评论。
  - 双击代码块可进入临时编辑方便对照修改，右上角支持一键复制；点击文中图片进入灯箱，支持滚轮缩放与拖拽。
- **Markdown 文档（含 README）**：
  - 顶栏 `Diff` 按钮（存在历史版本或草稿改动时显示）支持**渲染态**（含成对修改的行内字/词级高亮、右侧目录变更圆点）与**源码态**双视图切换，可勾选「仅看改动」折叠未变上下文，并用 `▲`/`▼` 或 `F7`/`Shift+F7`/`[`/`]` 在改动块间顺序跳转。
  - 线上模式跟随站点更新保留最多 10 个历史版本；本地模式自动追踪至多 50 版历史（共 51 版）。
- **电子书阅读器（TXT / PDF / EPUB）**：
  - **TXT**：横向多栏无缝滚屏（滚轮、方向键、`Space`/`PageUp`/`PageDown` 翻页），点击顶部居中横条呼出控制栏，可调字号/行高/栏宽、切换亮暗配色、手动切换编码（自动识别 UTF-8/GB18030/Big5/UTF-16）、按 `B` 快速添加书签，并自动记住阅读位置。
  - **PDF / EPUB**：支持页内大纲目录、缩放、书内搜索定位高亮与进度记忆。
- **全站通用的拼音与摘抄**：在 HTML、PDF、EPUB、TXT、Markdown 中，划选**单个汉字**浮现拼音，划选**两个及以上字符**弹出摘抄按钮，一键收入 `Excerpts`。

## 4. 图库、全景与音视频

- **图库与壁纸**：滚轮缩放、鼠标拖拽平移，左右方向键或移动端左右滑动切换上下张，按 `Space` 聚焦跳页框；点击 `As Wallpaper` 收藏为壁纸，在书签页右下角 `🎨` 管理轮播；带红色边框且文件名以 `pano_` 开头的图片，**双击**打开全景浏览。
- **视频播放**：支持 `Space` 播放/暂停、`a`/`d` 或左右方向键快退/快进 3 秒、`w`/`s` 或上下方向键调节音量、`z`/`c` 切换上/下一个视频、`x` 切换全屏；`.mkv` 视频自动挂载同名 `.vtt` 字幕，按 `[` / `]` 以 $\pm 0.5\text{ s}$ 步长微调字幕延迟。
- **悬浮音乐播放器**：支持收藏、顺序循环、单曲循环与随机播放；左上角 `🎵` **单击**显示/隐藏，**双击**关闭销毁。
- **快捷全屏**：在图库、视频、PDF、EPUB、TXT 视图中，**鼠标中击**均可快速切换全屏。

## 5. 快捷键、触屏操控与数据迁移

### 高频快捷键与手势速查

| 场景 | 按键 / 操作 | 作用 |
| :--- | :--- | :--- |
| 全局任意页面 | `\` | 聚焦搜索框 |
| 搜索组件内 | 鼠标中击 / `Esc` | 收起搜索结果或关闭浮层 |
| 侧边栏 | 右键单击 / 右键双击 | 打开全局书签菜单 / 原生右键菜单 |
| 图库 / 视频 / 电子书 | 鼠标中击 | 切换全屏 |
| PDF / EPUB | `Ctrl+F` | 聚焦主站搜索框并搜本书 |
| TXT 阅读器 | `B` / `Space` / 左右键 | 添加书签 / 翻屏 / 横向微滚 |
| 视频播放器 | `Space` · `a`/`d` · `w`/`s` · `z`/`c` · `[`/`]` · `x` | 播停 · 快退进 3s · 音量 · 切集 · 字幕延迟 · 全屏 |
| Markdown Diff | `F7` / `Shift+F7` / `[` / `]` / `Esc` | 下/上一处改动 / 退出对比 |

- **触屏虚拟触控板**：移动或触屏设备会自动加载底部虚拟触控板，提供虚拟光标、缩放（`+`/`-`）、`▲`/`▼` 滚屏、`暂停跟随`、`框选`、`拖拽`、`左双击`、`中击`、`右击` 以及可拖动的 `收起/展开` 悬浮钮，适配正文、侧栏与 Markdown 浮窗。
- **备份与跨设备迁移**：在搜索框输入 `@bomb` 回车可勾选保留或导出个人数据（收藏、已阅、浏览历史、阅读进度、摘抄等）并清空本地库；输入 `@rebirth` 回车可导入导出的 `.json` 备份完整恢复。系统每 7 天提醒一次备份。
- **离线更新与异常修复**：站点支持离线访问，发现新版时顶部会出现更新提示条，点击更新会自动保留当前阅读/播放现场并原地恢复；若遇到缓存异常，在网址末尾加上 `?repair=1` 访问即可重置缓存与索引库（不会删除摘抄、已阅标记等个人数据）。
---

# 作者怎么常规维护

本地运行、构建、媒体处理与补丁管理全部收口在单个原生程序 `_build/swamp.exe`，不依赖 Java、Node、esbuild、cwebp 等外部工具。双击启动后无黑窗运行本地服务（默认 `http://localhost:8000`）并打开桌面管理窗。

## 1. 日常高频流程（按场景速查）

- **写新文章 / 改旧文章并发布**：
  1. 在管理窗「常规」页点 `Open Site` 打开本地站点；新建文章直接用底部的 `新建页面`（自动填好标题和 `#anchor` 时间戳并拉起 VS Code），改旧文章则在网页左上角点 `edit`。
  2. 在 VS Code 里直接写纯文本并 `Ctrl+S` 保存，浏览器会自动刷新并回到原滚动位置。
  3. 回到管理窗，填好 `Commit` 说明，点 `gen + push`（先构建、过隐私检查，再提交推送；想先本地验收就先点 `gen` + `sim (9000)`，确认无误再点 `push`）。
- **收截图与导入 Keep 笔记**：
  - 截图放进 `local.toml` 配好的 `img_input_dir`，在「常规」页点 `转换 WebP`：批量缩放压成 WebP 写入 `gallery/img/`，原图移入 `img_input_dir/history/`，新文件名列表自动复制到剪贴板，直接在 VS Code 粘贴即可；需要同步把旧 HTML 里的原图名替换为新 WebP 时勾上 `替换 HTML 引用`。
  - 把 Google Takeout 导出的 Keep 压缩包放到 `keep_takeout_zip_folder`，在「常规」页选 `单篇导出 (single)` 或 `按标签合并 (merge)`，点 `导入 Keep 笔记`。
- **改 `README.md` 并核对改动**：
  - 在站内书签页左击 `README` 打开左右分栏编辑器，`Save` 或 `Ctrl+S` 原地落盘。本地服务会自动为每次落盘记录反向差异链（最新版 + 最多 50 版历史，共 51 版，版名 `yymmddhhmmss`），点顶栏 `Diff` 可在渲染态/源码态之间随时对比当前草稿或任意历史版本。
- **拉 AI 调优代码（打包 -> 回填 -> 编译）**：
  1. 切到「打包协作」页，选预设或点 `选中 Git 改动`，点 `打包 ZIP`（不支持上传 `.zip` 的 AI 界面可勾选 `同时生成 MD` 按上限分卷）。
  2. 拿到 AI 补丁后切到「回填补丁」页，从左侧 `下载目录` 双击 `.zip` 或直接拖进窗口；双击任意文件可用 VS Code `--diff` 看差异。
  3. 点 `回填选中文件`；若改动了 Rust 源码，勾选 `回填后退出并运行 build.bat` 即可安全退出并接力编译（若补丁包含 `[构建配置·未查看]` 文件，必须先逐个双击看完差异才会解锁该勾选框）。

## 2. 桌面控制台详解

窗口顶部标题实时显示服务地址与网络心跳状态（`Swamp 本地服务 (localhost:8000) | 网络: 正常 / 离线 / 检测中`），任务栏图标同步绿/红灯；底部 `运行日志` 最新消息居上并落盘到 `_build/temp/swamp_runtime.log`（重启以时间戳虚线衔接，超阈值自动瘦身，体积偏大时 `清空日志` 按钮变红提示）。关闭窗口时会自动等待进行中的写盘/构建收尾，并回收可能运行中的 `sim (9000)` 子进程。

控制台分为 4 个标签页：

### 标签页 1：常规
- **站点构建与发布**：
  - `Open Site`：带随机内存令牌打开本地站点（已开主页时自动同步令牌并关闭过渡页，不重复开窗）。
  - `gen`：执行全量构建（前端资源增量压缩、HTML/媒体扫描、数据切片、同义词与清单生成、隐私检查）。
  - `gen + push` / `push`：填写 `Commit` 后提交并推送；推送前自动复核公网产物、暂存区以及全部待推送提交历史（含合并提交 `-m`），命中私有文件立即撤销暂存并取消推送。
  - `sim (9000)`：以隐身窗口启动 `9000` 端口线上仿真（禁用 `/__api`、`_build`、`shadow*` 与 `html/__*.html`），用于发版前核验线上真实效果。
  - `selfcheck`：运行 74 项内置安全与构建自检；`root/` 打开仓库根目录；`重新授权 Tasks` 触发 Google Tasks OAuth 授权。
- **底部 3 组快捷工具**：`新建页面`（支持勾选 `创建后用 VS Code 打开`）、`转换 WebP`（可调最大宽度/质量、勾选 `备用输出目录` 与 `替换 HTML 引用`）、`导入 Keep 笔记`（支持 `单篇导出 (single)` 与 `按标签合并 (merge)`）。

### 标签页 2：打包协作
- 三态目录树勾选源码，支持预设下拉切换、`仅选预设` / `累加预设`、预设增删改（存入 `_build/swamp.toml`）、`选中 Git 改动`、`更多目录`、文件名 `筛选`、`清空已选`、`刷新`。
- 勾选 `同时生成 MD` 并设置 `单文件上限`（默认 `200 KB`）可在输出 `.zip` 的同时生成分卷 `.md`。打包完成后仅写日志并刷新备份树，不主动弹出资源管理器。

### 标签页 3：回填补丁
- **三栏布局**：左栏 `下载目录`（双击 `.zip` 直接加载，支持打开/清理）、中栏 `补丁内容`（双击任意文件拉起 VS Code `--diff` 对比原文件或预览新增文件）、右栏 `备份目录 (backup)`（查看与勾选清理历史打包、回填快照和临时备份）。
- **回填选项与安全门禁**：
  - `覆盖前备份`：写入前自动备份所有被覆盖文件并生成 `_manifest.json`（中途异常同样保留清单），可在上方 `回滚快照` 下拉框选 `ai_apply_*` 点 `回滚此快照` 还原。
  - `规范 bat/ps1 编码`：默认勾选。仅对 `.bat`/`.cmd` 自动转为 **UTF-8 无 BOM + CRLF**（防止 `cmd.exe` 把 BOM 当成首行命令报错），对 `.ps1` 自动转为 **UTF-8 带 BOM + CRLF**（防止 PowerShell 5.1 按本地编码解析导致中文乱码）；其余文件原样写入。仅在需要原样保留非 UTF-8 脚本时取消勾选。
  - `回填后退出并运行 build.bat`：写入完毕后等待所有任务结束、关闭 `swamp.exe` 并经内存环境变量交接会话令牌再启动 `build.bat`。
  - **构建配置类文件门禁**：`_build/privy/`、`.git` 等私有区硬禁止回填；涉及 `.cargo`、`Cargo.toml`、`build.rs`、`build.bat`、`swamp.toml`、`.gitignore`、`rust-toolchain*` 或脚本后缀的条目默认不勾选并标为 `[构建配置·未查看]`，须先双击看完 VS Code 差异变为 `[构建配置·已查看]` 后才允许勾选自动编译。

### 标签页 4：同义词
- 左栏直接编辑 `_build/swamp.toml` 中的自定义同义词 JSON，点 `保存到 swamp.toml`（写入前会先做 JSON 与 TOML 预校验）或 `保存并重建构建`（强制重建 `synonyms.js`、更新未收录词报告并自动执行一次 `gen`），也支持 `导入 JSON...`。
- 右栏实时展示构建期产出的 `oov_report.txt`（未收录高频词），点 `刷新未收录词` 重新读取。

## 3. 站内本地写能力

通过 `Open Site` 打开本地站点（`store.online_flag === "0"`）后，站内改动全部经本地鉴权接口原子写盘：

- **HTML 编辑与自动刷新**：文章左上角点 `edit` 更新 `#anchor` 时间戳并拉起 VS Code，按钮变为 `edit ●` 进入监听；VS Code 每次 `Ctrl+S` 后页面自动刷新并回到原滚动位置（右键 `edit ●` 停止监听，双击右上角标题手动重载）。
- **书签拖拽维护**：书签页直接拖入外部链接，或把已有链接拖到其他区块 / `del` 区即可增删移。
- **Markdown 编辑器与本地 51 版 Diff**：书签页左击 `README` 打开左右分栏编辑器，`Save` / `Ctrl+S` 保存（中击跳线上仓库）；站内保存、外部编辑器修改（60 秒内自动保存合并成一版，不刷爆历史）与补丁回填均自动记入 `_build/temp/md_history/`。
- **双语页固化**：双语页草稿自动存在浏览器 `AlignDrafts`，点固化后剥离运行期 DOM 写回原 HTML 并刷新当前页。
- **前端源码自动热压缩**：本地服务监听 `src/js/raw/`、`src/css/raw/`、`src/css/font/`，保存后 300 ms 自动压缩到目标目录（执行 `gen` 时自动互斥避让，发布前仍需点一次 `gen` 刷新清单版本号）。
- **本机专用入口**：侧栏额外显示 `KaTrain`；`txn_parser` 自动读取 `_build/privy/txn.txt`，点击行号可用 VS Code 跳到对应行。

## 4. 内容写法、命名约定与同义词调优

### HTML 正文写法与特殊前缀
- **纯文本写作**：正文直接写在 `<pre>` 内，无需 `<br>`：
  - `#` 加空格自动转各级标题并生成右侧目录；行首 4 / 8 / 12 / 16 个空格缩进自动块级着色。
  - 独立成行的图片名（默认在 `gallery/img/` 查找）与 `http(s)://` 链接自动转为 `<img>` / `<a>`；其余 `< > &` 文本在渲染期自动转义，既防注入也不吞代码里的 `a < b`。
  - `<p>` 内按 `|` 分列自动渲染表格；`<code 语言>` 自动触发 Prism 代码高亮。
- **文件名特殊前缀**：
  - `_xxx.html`（单下划线）：超大文档。正文不进 `fat_data` 切片也不进 SW 缓存包，但页内可搜、标题仍参与全站检索。
  - `__xxx.html`（双下划线）：私密文档。必须被 `.gitignore` 忽略（构建期强制核验），目录挂 `🔒`，正文只进本地 `shadow_data`，绝不进入任何公网产物。
  - `pano_xxx`：`gallery/` 下以此开头的图片识别为全景图。
- **Keep 笔记转换约定**：笔记正文用 `[[IMG1]]`、`[[IMG2]]` 标记配图位置。`single` 模式需同时打 `single` 标签和分类标签；`merge` 模式按共同标签合并为一篇。覆盖同名旧 HTML 前自动备份到 `_build/temp/backup/`。

### 同义词调优速查
- 只读基础词林位于 `_build/swamp-server/assets/cilin.txt`（`=` 等义扩词，`#`/`@` 仅留作分词保护）。
- 自定义规则写在 `_build/swamp.toml` 的 `[synonyms]` 区块：
  - `groups`（双向同义组，`exclusive` 默认为 `true` 覆盖词林旧义）
  - `aliases`（单向别名，不反向污染）
  - `stopExpand`（禁止扩词的技术专词）
  - `dropEqCodes`（整行降级）/ `pruneWords`（按行剔词）/ `splitFixes`（修复粘连词）
- 常用 5 位分类码（`c5`）：AI/算法 `Dk01A`、网络/编程 `Dd06A`、电脑/机械 `Bo01A`、手机/电路 `Bo04A`、影视 `Dk29D`、音乐 `Dk28A`/`Dk28B`、徒步 `Fb01A`、装备 `Bp29D`。
- 公开语料 DF 分桶权重（$N$ 为公开 HTML 总数）：

| 后缀 | 出现文档数条件 | 候选乘数 | 义项消歧加分 | 含义 |
| :--- | :--- | :---: | :---: | :--- |
| 无后缀 | $DF = 0$ | 0.62 | $+0.00$ | 公开正文未出现，保留入口 |
| `:1` | $DF = 1$ | 1.00 | $+0.25$ | 孤篇专词或媒体名 |
| `:2` | $2 \le DF \le 3$ | 1.12 | $+0.45$ | 低频高区分度词 |
| `:3` | $DF \ge 4$ 且 $DF / N \le 8\%$ | 1.18 | $+0.60$ | 主题特征词（权重最高） |
| `:4` | $8\% < DF / N \le 20\%$ | 1.00 | $+0.35$ | 常见实词 |
| `:5` | $20\% < DF / N \le 40\%$ | 0.68 | $+0.10$ | 偏泛词，轻度降权 |
| `:6` | $DF / N > 40\%$ | 0.38 | $+0.00$ | 全站高频泛词，强降权 |

## 5. 配置文件、重新编译与命令行

### 两层配置分工
- **公共配置 `_build/swamp.toml`（入库）**：站点参数、Giscus ID、端口、构建与预缓存 Glob 规则、WebP 默认质量/宽度、Pack 预设、`[synonyms]` 自定义规则。
- **本机私有配置 `_build/privy/local.toml`（`.gitignore` 忽略）**：填写 `vscode_path`、`katrain_dir`、`img_input_dir`、`webp_output_dir2`、`keep_takeout_zip_folder`。出于安全边界，这 5 项涉及进程启动或目录移动的本机路径**只认 `local.toml`**，不会回退读取入库 `swamp.toml`。

### 重新编译（`_build/swamp-server/build.bat`）
所有 Rust 编译产物统一落在 `%LOCALAPPDATA%\swamp-cargo-target`（避开 Dropbox 同步抢锁）：

- **`[1]` 编译 `swamp.exe`**：修改服务端/构建器/控制台 Rust 代码后执行。先对新产物跑完 **74 项 `--selftest`**，全部通过后再带重试覆盖 `_build/swamp.exe`，随后自动启动新版管理窗并 3 秒后退出。
- **`[2]` 编译 Wasm (`src\wasm`)**：修改 `_build/swamp-server/src/lib.rs` 后执行。先经 `%LOCALAPPDATA%\swamp-cargo-target\wasm-stage` 完成 `wasm-pack` 与 `wasm-opt`，再带重试复制 `.wasm` 并用 `swamp.exe minify` 生成压缩胶水脚本（完成后需再执行一次 `gen`）。
- **`[3]` 全部编译**：依次完成 `[1]` 和 `[2]` 并启动新版 `swamp.exe`。任一步出错均会暂停窗口保留报错信息。

### 常用命令行（无需打开管理窗也可直接调用）

| 命令 | 作用 |
| :--- | :--- |
| `swamp gen` | 执行站点全量构建 |
| `swamp sim` | 启动 `9000` 端口线上仿真服务 |
| `swamp new [title] [category] [--open]` | 新建 HTML 页面（`--open` 自动用 VS Code 打开） |
| `swamp webp [maxW] [quality] [--alt-dir] [--update-mapping]` | 批量转换 WebP 并复制文件名到剪贴板 |
| `swamp keep2html [single\|merge] ...` | 转换 Google Keep 导出包 |
| `swamp synonyms` | 强制重建 `synonyms.js`、未收录词报告并执行 `gen` |
| `swamp --selftest` | 运行 74 项内置自检 |
---

# AI怎么下场协作

这一章分两版：**版 A** 用于备忘；**版 B** 给 AI 看的，交代精确的架构、边界和协作规约。

---

## 版A：给站长自己看的“脑内地图”

> 这份笔记不背诵代码细节，只讲清楚**为什么当时要这么折腾、各部件怎么互相搭台、以及哪些地方藏着机关**。隔几个月再回来魔改，或者准备拉 AI 下场干活前，花三分钟扫一眼这里就够了。

### 1. 一句话看懂全站：线上靠浏览器演独角戏，本地全靠 `swamp.exe` 一个人扛

- **线上（GitHub Pages）**：没有服务器、没有数据库、没有后端代码，GitHub 就是一个老实发静态文件的网盘。访客打开网页后，浏览器自己支起一套“三人班子”：
  - **前台总管（`index.js`）**：守着外框 `index.html`，右边挂目录 `#side`，左边挂正文 `#content`，管着搜索栏、音频悬浮条、摘抄本、弹窗和标签页切换。
  - **仓库管理员（Service Worker，`sw.js`）**：拦截网络请求，负责离线缓存、增量更新，以及给旧版文章留底做历史 Diff。
  - **后台苦力（Web Worker + Wasm）**：在独立线程里吃下全站文本，专干搜词、算分、截摘要这类重活，算得再猛也不会把主界面卡死。
- **本地（`_build/swamp.exe`）**：以前东拼西凑的 Java、Node、esbuild、cwebp 已经全部扫进历史，现在所有本地活儿收口进这一个原生程序——既当本地静态服务器，又当构建器、文件监听器、桌面控制台、图床压缩器、Keep 导入器和补丁打包/回填工具。

### 2. 为什么文章里只写 `<pre>` 纯文本，打开却能变漂亮还不怕注入？

你写笔记时只管在 `<pre>` 里敲纯文本，这样 VS Code 编辑最轻快、Git Diff 也一眼看清改了哪行。真正把纯文本变成网页的是打开瞬间跑的 Wasm（`format_markdown`）：

- `#` 标题、4/8/12/16 空格缩进块、独立成行的图片名和 `http(s)://` 链接，全由 Wasm 实时吐成 HTML 结构；你手写的 `<p>` 表格和 `<code>` 块在浏览器读入页面时就已经是正经 HTML 标签，不走纯文本翻译，直接交给表格脚本和 Prism 上色。
- **一个容易忽略的安全机关**：以前把 Keep 笔记里的 `<` 转成 `&lt;` 写进 `<pre>`，其实会被浏览器的文本节点解码还原，再经渲染插回页面时“借尸还魂”。现在 Wasm 渲染纯文本时会先对 `<`、`>`、`&` 和引号做一遍转义，既彻底堵死了意外标签/脚本注入，也顺手保住了技术笔记里随手写的 `a < b` 不会被当成残缺标签吞掉。

### 3. 搜索为什么既能容错、懂近义词，几十万字还不卡？

如果每次敲键盘都拿关键词把全站正文从头扫到尾，页面早就卡成 PPT 了。站里的搜索靠四层“偷懒”：

1. **切片让路 + 喜新厌旧**：搜索全在后台 Worker 里跑，每算 8 毫秒就喘口气看看你是不是又敲了新字。只要还在打字，上一轮没算完的搜索立刻作废丢掉。
2. **两道安检门（先粗筛再细找）**：Wasm 进场时先给全站画了两张极小的“指纹地图”——全站级 Bloom 过滤器（1 MB 管正文、256 KB 管评论）+ 每篇文章自带的字符位图。查一个词之前先翻地图，连字都没出现过的文章和近义词直接跳过，根本不进正文扫描。
3. **近义词不是瞎扩**：底子是词林，叠加你在 `swamp.toml` 里手调的词组/别名/禁扩词，再乘上全站公开文章的词频权重——全站哪哪都有的泛词降权、几篇专文才出现的特征词提权；遇到组合词先按词林编码的“亲缘关系”猜语境，尽量不把技术词扩成八竿子打不着的古汉语。
4. **结果缓存 + 电子书“借壳”**：全站搜过的结果按 LRU 存在 `MainDB` 里，下次秒出；只要正文、同义词或算法版本号一变，旧缓存自动作废。打开 TXT / PDF / EPUB 时，阅读器会把自己临时挂到主站搜索框上，复用同一套 Wasm 匹配和近义词（但会特意跳过全站 Bloom 筛子，免得书里有而站里没有的词被误杀），缓存单独记在 `BookDB` 里——平时网站更新不清空它，只有你把那本书真删了才会连根清掉。

### 4. 离线、更新和多开标签页，为什么不会互相打架？

静态站点做离线缓存，最容易翻车的是**版本撕裂**：新版本正偷偷在后台下着，用户随手按了下 F5，结果旧代码读到了新清单，直接白屏。

- **防撕裂的土办法（很管用）**：在线上模式下，页面请求的 `core-list.js` 根本不走网线，而是由**当前正在值班的 SW 现从自己肚子里拼出来发给页面**。这样在你点击「发现新版本，点击更新」之前，页面拿到的代码、清单和数据永远是同一套，绝不混装。
- **无痛刷新**：点更新的瞬间，主控会给当前标签页拍一张一次性“快照”（正在看的文章/电子书/视频、音乐播放列表和进度、搜索词），刷新完再原地复原；如果正好碰到某文件刚被你删掉或移了目录，恢复程序会识趣地清掉脏记录并退回书签页，不会死循环。
- **多标签页互不串台**：你同时开两个标签页，一个看小说一个翻笔记，不会互相把状态顶掉——因为 20 个和当前页面绑定的状态键都路由进了各自独立的 `sessionStorage`，只有“清空搜索缓存”这种全局动作才会跨标签页打招呼。

### 5. 为什么历史 Diff 在本地和线上走了两条路？

- **HTML 文章 & 线上 Markdown**：全靠 SW 顺手攒“时间胶囊”。每次网站发新版，SW 发现某篇 HTML 或 `.md` 哈希变了，就先把旧桶里的老版本压成 `deflate-raw` 塞进浏览器 `MainDB`（每篇最多留 10 版）。访客在线上就能随时点 `diff` 看你改了什么。
- **本地 Markdown（比如平时狂改 `README.md`）**：本地编辑时可能十分钟改七八稿，总不能每改一次都靠 SW 发版留底。所以本地模式下，由 `swamp.exe` 亲自盯盘，在 `_build/temp/md_history/` 里记一条**反向补丁链**——只存最新全文和最多 50 条“倒推差异”（合起来共 51 版，版名就是 `yymmddhhmmss`）。
  - 每次还原老版本都会拿 SHA-256 核对，保证一字节不差；
  - 用外部编辑器开自动保存也不怕把 50 版瞬间刷爆：watcher 抓到的外部修改在 60 秒内会自动合并成一版，只有你在站内点 `Save` 或隔了一会儿再改才会另起一版；
  - 渲染态 Diff 还会对成对修改的段落/表格行/列表项再跑一遍字级比对，改动哪几个字一眼就能扫出来。

### 6. 四道防盗门：私密日记怎么防漏，本地写权限怎么防乱来？

这个站既放着公开折腾的笔记，又混着只有本机可见的 `__` 私密内容，还给了本地网页直接改磁盘和拉起 VS Code 的权力，所以设了四道硬防线：

1. **构建时的“搜身安检”**：
   - `__` 开头的私密页必须被 `.gitignore` 管住，构建时还会调 `git check-ignore` 双重核对；目录信息进 `lite_data.js`（线上挂 `🔒`），正文只进本地 `shadow_data_*.json`，公网切片里只写 `"localOnly"`，同义词词频统计也直接绕开私密页。
   - **所有产物先在临时目录里攒齐，连 `synonyms.js` 都在内存里憋着不落盘**。提交之前，用 Aho-Corasick 自动机把每篇私密正文切成 24 字宽、步长 12 字的重叠碎片，把所有准备公开发布的文件（包括 `lite_data.js`）从头到尾线性搜一遍；只要撞上某句公开正文里根本没有的私密独有片段，当场报错叫停，正式目录一根毫毛都不会动。
2. **推送前的“全历史安检”**：
   - 就算哪天没点 `gen` 直接点 `push`，程序也会先复核一遍磁盘上的公网产物，再在 `git add -A` 后检查暂存区，最后还要把所有还没推上去的本地提交（包括合并提交）全部翻一遍。只要混进任何私密路径，立刻撤销暂存、拒绝推送。
3. **本地接口的“认门又认牌”**：
   - `swamp.exe` 只监听本机 `127.0.0.1`，而且全站卡死 `Host` 白名单（防恶意网页靠 DNS Rebinding 偷看你的本地流水或私密页）。
   - 启动时在内存里摇一个 64 位随机令牌，点 `Open Site` 时借 URL `#` 传进浏览器后立刻抹掉地址栏痕迹；之后网页每次保存文件、改书签、点 `edit` 或开 KaTrain，都要核对来源 + 同源头 + 令牌。万一你重编译重启了 `swamp.exe`，令牌会通过环境变量悄悄交接给新进程（`build.bat` 跑 `cargo` 前会先清掉它防泄漏），旧标签页不用重开；真失效了，桌面还会弹确认框让你亲手点“是”续签。
   - 像 `vscode_path`、`katrain_dir`、截图输入目录这类会启动程序或搬动文件的路径，只信你本机私有的 `_build/privy/local.toml`，就算入库的 `swamp.toml` 被改坏也不会被带偏。
4. **和 AI 传补丁的“后悔药与保险栓”**：
   - 打包给 AI 自动剔除所有私密文件和压缩产物；
   - 回填 AI 补丁时，`_build/privy/` 和 `.git` 是绝对禁区；如果补丁动到了 `build.bat`、`Cargo.toml`、`.cargo`、`.gitignore`、`swamp.toml` 或脚本文件，默认不勾，而且**必须先双击拉起 VS Code 看过 Diff 才解锁「回填后自动编译」**；
   - 写盘前先全量校验体积再动手，自动备份被覆盖的文件，哪怕写到一半磁盘报错也会留好回滚清单，随时一键还原；
   - 重新编译 `swamp.exe` 时，先对新产物跑完 74 项 `--selftest` 全部通过才盖掉旧的；编译 Wasm 时也先借道 `%LOCALAPPDATA%` 避开 Dropbox 抢锁再复制回仓库。

### 7. 拉 AI 干活时的“防踩坑备忘”

以后不管换哪家 AI 帮你改这个站，自己心里记住这四条就稳了：

- **分清要跑哪个动作**：只改前端 `src/js/raw/` 或 `src/css/raw/` 时，本地监听会自动热压缩，发布前点一次 `gen` 即可；改了 Rust 服务端代码（`main.rs`、`gui.rs`、`builder/` 等）要跑 `build.bat` 选 `[1]` 重编 `swamp.exe`；只要动了 `_build/swamp-server/src/lib.rs`，就必须重编 Wasm（`build.bat` 选 `[2]` 或 `[3]`）再点 `gen`。
- **绝对不要手改（也别让 AI 改）构建产物**：根目录 `sw.js`、`src/js/*.js`、`src/css/*.css`、`src/js/data/*`、`src/js/synonyms.js` 全是 `gen` 吐出来的，改了也会被下次构建冲掉。
- **几个“祖传机关”别让 AI 好心办坏事**：代码里 `lightbox_stauts` 和 `bookmarkhtml_modifing` 这两个错别字键名牵连好几个文件，别顺手“纠错”；如果以后给文章页 `content.js` 新加了挂在 `body` 上的悬浮小组件，记得顺手把它的选择器写进 `bilingual.js` 的清理列表，不然双语页点固化时会把那个小组件永久焊死进源码里。
- **坚持两步协作法**：先让 AI 只看代码给方案，你扫一眼确认没偏题、没动禁区，再让它打增量 `.zip` 回填——比一上来让它闷头改十几个文件省心十倍。
---

## 版B：AI 系统规格书与行为地图

> 本节面向新会话中的 AI 协作者。目标是在仅读取 `README.md` + 局部源码包的前提下，零偏差掌握全站运行时拓扑、跨边界契约、核心状态机、安全信任边界与高危耦合点。

---

### 1. 零号心智模型与三态运行矩阵

全站遵循 **「线上纯静态浏览器自治 + 本地单文件原生伴生服务」** 双轨架构：线上（GitHub Pages）零后端代码，所有渲染、检索、Diff 与离线缓存均在浏览器完成；本地所有构建、热压缩、版本追踪、媒体处理与写盘均收口于单 Crate 双目标 Rust 工程（`_build/swamp-server`，`v3.1.0`）产出的单个二进制 `_build/swamp.exe`。

前端业务代码判断运行环境的**唯一合法开关**是 `store.online_flag`（由 `index.js` 根据 `hostname`/`protocol`/`port !== '9000'` 写入，业务代码严禁散落判断 host/port）：

| 维度 | 本地模式 (`Serve`) | 线上仿真 (`Sim`) | 线上生产 (`GitHub Pages`) |
| :--- | :--- | :--- | :--- |
| **入口与端口** | `swamp.exe` -> `127.0.0.1:8000` + Win32 管理窗 | `swamp.exe sim` -> `127.0.0.1:9000`（隐身窗） | `https://<github_page>` |
| **`store.online_flag`** | `"0"` | `"1"` | `"1"` |
| **SW `fetch` 策略** | Network-Only（`no-store`），断网回退缓存；放行 `/__api/*`、`/__auth*`、`/__oauth/*` | Cache-First；`core-list.js` 由活跃 SW 实时合成 | 同 `Sim` |
| **本地控制面 `/__api/*`** | 挂载（4 重鉴权 + Host 白名单） | **不挂载** | 不存在 |
| **`_build/**` 静态访问** | 默认拒绝，仅白名单放行 `_build/privy/txn.txt` 与 `_build/privy/upcoming_tasks.json` | 整目录拒绝 | 不入库 / 不存在 |
| **私密页 (`html/__*.html`) 与 `shadow*`** | 可读可搜（加载 `shadowIndex.js` + `shadow_data_*.json`） | **强制拒绝**（与线上 404 行为一致） | 不入库（目录标 `🔒`，切片仅占位 `"localOnly"`） |
| **站内写能力** | HTML `edit` 热重载、双语固化、书签拖拽、README 编辑器、KaTrain、`txn_parser` 跳行 | 全部关闭 | 全部关闭 |
| **Markdown Diff 版本源** | 伴生服务 `/__api/ops/md-history` & `md-rev`（反向差异链，最多 51 版，`yymmddhhmmss`）+ 未固化草稿 | SW 快照 `MainDB.html_snapshots`（最多 10 版，`vN`） | 同 `Sim` |
| **Giscus 评论与同步** | 不加载评论弹窗（仍保留评论索引模块入口） | 加载 `discussion_id_mapper.json` 与 Giscus 弹窗 | 完整启用（10 分钟同步 `comments.json`） |

#### 单 Crate 双目标编译约束（Windows）
- **原生端 (`--bin swamp`)**：`cargo build --profile release-exe`（`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "unwind"` 支持 panic 落盘至 `_build/temp/backup/swamp_panic.log`）。
- **Wasm 端 (`--lib`, `compute_intensive_task_processor`, `cdylib`)**：`wasm-pack build --target web`，`.cargo/config.toml` 开启 `target-feature=+simd128`，`release` 配置 `opt-level = "z"`, `panic = "abort"`，`wasm-opt -Oz`；`build.bat` 先输出到同步盘外的 `%LOCALAPPDATA%\swamp-cargo-target\wasm-stage` 防 Dropbox/杀软 `os error 32` 抢锁，再带重试复制到 `src/wasm/` 并用 `swamp.exe minify` 压缩胶水 JS。
- **目标目录与自检门禁**：`build.bat` 通过 `CARGO_TARGET_DIR` 将构建产物统一放至 `%LOCALAPPDATA%\swamp-cargo-target`（`.cargo/config.toml` 保留 `../temp/target` 供脱离 `build.bat` 单独执行 `cargo` 时防污染仓库）；`build.bat exe` 先对 target 产物跑完 **74 项 `--selftest`** 全部通过后再带重试覆盖 `_build/swamp.exe`。

---

### 2. 文件所有权与目录边界图谱

改动任何代码前，先核对文件属于「源码」「构建产物」「私有区」还是「临时区」——**严禁手改任何构建产物**：

```text
[源码区 — 允许 AI 补丁修改]
  index.html                     # 单页外壳（仅 PARAM-BEGIN..PARAM-END 块由 gen 注入）
  README.md / .gitignore         # 公共文档与隐私忽略规则（.gitignore 属高危构建配置类）
  _build/swamp.toml              # 唯一入库公共配置（站点参数、precache Glob、Pack 预设、[synonyms] 自定义规则）
  _build/swamp-server/           # 单 Crate Rust 工程（Cargo.toml / build.bat / .cargo/config.toml / src/**）
    assets/cilin.txt             # 外置只读基础词林（非必要不传 AI）
    src/lib.rs                   # #![cfg(target_arch = "wasm32")] Wasm 引擎（渲染/检索/Bloom/ADS/LCS Diff）
    src/main.rs                  # CLI / Serve / Sim 入口、Router、Host 中间件、/__auth*、/__oauth/callback、退出交接
    src/config.rs                # swamp.toml + privy/local.toml 分级加载与标记块预校验原子写回
    src/security.rs              # Host 白名单、双阶段静态守卫、参数校验、CSP/API 鉴权、74 项 --selftest
    src/static_fs.rs             # 静态托管（单段 Byte Range、canonicalize 二次复核、.svg sandbox CSP）
    src/api_files.rs             # write_bytes_atomic / write_atomic、/__api/files/{html,md}、/__api/bookmarks
    src/api_ops.rs               # /__api/ops/{edit,watch-html,explorer,cli,txn,katrain,md-history,md-rev}
    src/gui.rs                   # Win32 Per-Monitor HiDPI 4 标签页管理窗 + Arc<GuiMailbox> 无 UAF 并发模型
    src/builder/{mod,minify,html_utils,generator,synonyms}.rs + synonyms_tpl.js
    src/media/{webp,keep2html}.rs
    src/services/{log_bus,md_history,watcher,tasks,pack_apply}.rs
  html/*.html                    # 单层 HTML 原文（分类完全由 <span id="anchor"> 决定；_ 超大文档 / __ 私密文档）
  src/js/raw/*.js                # 前端 JS 源码（不含自动生成的 raw/core-list.js，raw/sw.js 的版本号行由 gen 维护）
  src/css/raw/*.css              # 前端 CSS 源码
  src/css/font/font.css          # 字体样式源码
  src/tpl/*.html                 # 12 个视图模板（side/bookmark/txt/pdf/epub/pano/md_viewer/bilingual/new/go_board/txn_parser/street_view_uploader）

[构建产物区 — 由 swamp gen / build.bat 自动生成，禁止手改或打进补丁]
  sw.js                          # 由 src/js/raw/sw.js 压缩输出至仓库根目录
  src/js/*.js                    # 由 src/js/raw/*.js 压缩；synonyms.js 由 synonyms.rs 生成；core-list.js 由 generator.rs 生成
  src/css/*.css                  # 由 src/css/raw/*.css 与 src/css/font/font.css 压缩
  src/js/data/                   # lite_data.js、fat_data_N.json、core-bundle.json；本地另有 shadow_data_N.json、shadowIndex.js
  src/wasm/                      # compute_intensive_task_processor.{min.js,_bg.wasm}
  src/discussion_id_mapper.json  # Giscus discussion ID <-> 文章标题映射（同时作为检索 recordId 持久化表）
  gallery/img/idle-list.txt      # 未被 HTML 引用的孤立图片清单

[本机私有区 & 临时区 — .gitignore 忽略，绝不入库/打包/回填]
  _build/privy/                  # local.toml、credentials.json、tokens.json、upcoming_tasks.json、txn.txt
  _build/temp/                   # swamp_runtime.log、md_history/*.json、diff_preview/、staging_data_*/、backup/
```

#### 同源第三方库清单与定制约束

| 组件 | 版本 | 位置 | 关键定制与安全约束 |
| :--- | :--- | :--- | :--- |
| **PDF.js** | `6.5.438` | `src/third/pdfjs/` + `pdf-viewer.{js,css}` | `pdf.html` 严格 CSP（零 `'unsafe-inline'`）；双锁 `enableScripting: false`；v6 私有化 `TextLayerBuilder.#renderingDone`，通过 `pageView._textHighlighter` 适配文本层高亮 |
| **Bibi (EPUB)** | `1.2.0` | `src/third/bibi/` + `src/tpl/epub.html` | 禁 `allow-scripts-in-content` 与本地/base64/blob 入口；`hardenChapterDocument` 二次剥离章节 iframe 脚本/内联事件并注入 `script-src 'none'` |
| **marked + DOMPurify + hljs** | `4.3.0` / `3.5.0` / 精简版 | `src/third/markdown/` | `md_viewer.html` 管线：`protectMath -> marked -> restoreMath -> DOMPurify(禁 script/style/iframe/svg/math/form/template/srcdoc) -> fixBold -> highlightCode` |
| **CodeMirror 5** | 同源 | `src/third/markdown/codemirror/` | 仅本地编辑态按需加载，在 `swamp.toml` `precache.exclude` 中排除 |
| **Photo Sphere Viewer + three.js** | `7` | `src/third/photo-sphere-viewer/` | `pano.html` 禁 `eval` CSP，强校验 `?src=` 仅限同源 `/gallery/*.{jpg,jpeg,png,webp,gif}` |
| **Prism / encoding.js / confetti** | 同源 | `src/third/{prism,other}/` | HTML 代码高亮、TXT 中文编码兜底、更新彩带动画 |

---

### 3. 四条跨边界契约（The Invisible Wires）

前端维持严格有向无环图（DAG）：`site-core.js` -> `shared-utils.js` -> `{search-engine, search-ui, search-preview, index}` -> 按需 `import()`（`comments` / `audio-player` / `snapshot` / `lightbox-logic` / `excerpts` / `book-db` / `deferred-features` / 触屏 `touchpad`）；独立线程 `worker.js` -> `synonyms.js` + Wasm；离线层 `sw.js` + `core-list.js`。模块间通过四条严格契约协作：

#### 契约 A：存储与状态路由（`SiteCore` 单一事实源）
- **`SiteCore.createStore`**（仅定义于 `src/js/raw/site-core.js`，兼容 Window / iframe / SW）：默认读写 `localStorage`，但以下 **20 个每标签页隔离键 (`TAB_SCOPED_KEYS`)** 自动路由至 `sessionStorage`：
  `resource_type`, `content_src`, `pdf_path`, `epub_path`, `txt_path`, `image_path`, `video_path`, `song_path`, `imagelist`, `videolist`, `playlist`, `last_html`, `lightbox_stauts`, `jump_from_search`, `jump_from_search_ex`, `giscus_jump`, `keyword`, `bookmarkhtml_modifing`, `bookmarkhtml_linksHash`, `force_refresh_cache`。
- **全站存储介质与淘汰策略**：

| 介质 | 名称 | Schema / 内容 | 上限与生命周期 |
| :--- | :--- | :--- | :--- |
| Cache Storage | `core-cache-{BUILD_VERSION}` | 站点壳、静态脚本样式、HTML、Wasm、`synonyms.js`、`README.md`、`sw-manifest.json` | 新 SW `activate` 删旧桶 |
| Cache Storage | `media-cache` | `/audio/` `/video/` `/gallery/` `/ebook/`、字体、PDF cmaps/standard_fonts/iccs/wasm/images | Cache-First；仅检测到文件删除或字体 query 换版时定向清理 |
| IndexedDB | `MainDB` v3 | `chunks`（fat 切片）、`update_logs`、`search_cache`、`sys_state`（LRU 索引、评论快照、媒体路径快照、命名空间指纹、`pending_search_cache_clear`）、`html_snapshots`（HTML 与线上 `.md` 快照） | `search_cache` 最多 500 条 LRU（单次 $>300$ 命中不入库）；`html_snapshots` 每页最多 10 版 `deflate-raw` |
| IndexedDB | `BookDB` v1 | `book_extracts`（PDF 文本+大纲提取）、`search_cache`（TXT/PDF/EPUB 书内搜索缓存） | 提取上限 30 本 / 32 MB（单本 12 MB）；搜索上限 600 条 / 16 MB（单书 80 条、单条 512 KB）；$>4$ KB 启用 `deflate-raw`；常规站点更新**不清空**，仅删书时定向清理 |
| IndexedDB | `ExcerptsDB` / `SideDB` / `AlignDrafts` (v1) | 摘抄本 (`books`)、侧栏已阅标记 (`marks`)、双语页编辑草稿 (`draft_texts`) | 持久保留；`@bomb` 清理前必先显式 `.close()` |
| `localStorage` | `store` + `__swamp_local_token__` + 独立工具键 | 用户偏好、历史、收藏、进度、壁纸、`mlp-dark`、`txt.history_*`、`BibiBiscuit*`、`pdfjs.history`、`goBoardSaveData`、`fx_rates`、`txn_*`、`tp-toggle-pos` | 定时闲时巡检，超 4 MB 弹窗告警 |
| `sessionStorage` | `ss_restore_strict` + 20 个 tab 键 + `__swamp_live_edit*` | 热更新一次性现场快照、每标签页视图状态、本地 HTML 监听滚动恢复 | 随标签页销毁 |
| 本地磁盘 | `_build/temp/` | `swamp_runtime.log`（800 条上限，启动超 1000 条或 512 KB 自动瘦身）、`md_history/*.json`（最新+50 反向差异=51 版）、`diff_preview/`（保留最近 10 份，启停清理）、`backup/`（`build_hashes.txt`、`synonyms.sha256`、`oov_report.txt`、`ai_pack_*`、`ai_apply_*`、`keep2html_*`、`html_*`） | 受 `.gitignore` 与 HTTP 默认拒绝保护 |

#### 契约 B：`BroadcastChannel('bus')` 通信协议
统一消息信封：`{ type, payload, from, target, tabId }`。`target` 取值 `index | side | content | *`。所有接收端必须丢弃 `tabId && myTab && tabId !== myTab` 的跨标签页消息——**唯一豁免项是 `SEARCH_CACHE_CLEARED`**（用于多标签页同步清空内存搜索缓存）。

- **目录与导航**：`REQUEST_CATALOG` / `RENDER_CATALOG`、`#html a` / `#gallery a` / `#video a` / `#audio a` / `#ebook a`、`SYNC_CURRENT`、`show_current`、`update_bookmark_menu`、`mask`、`adj_side_width`。
- **视图切换与播控**：`image` / `video` / `pdf` / `epub` / `txt` / `audio`、`play_fav_list` / `PLAY_PRESET_AUDIO` / `UPDATE_FAV_LIST`、`lightbox`（`{ status: "0" | "1" }`）、`OPEN_MD_VIEWER`、`reload_bookmark`。
- **检索与高亮**：`quick_search`、`CLEAR_SEARCH`、`DESTROY_HIGHLIGHT`、`REFRESH_HIGHLIGHT`、`LOCAL_SEARCH_COUNT` -> `LOCAL_SEARCH_RESULT`、`LOCAL_SEARCH_SNIPPETS` -> `LOCAL_SEARCH_SNIPPETS_RESULT`、`SEARCH_CACHE_CLEARED`。
- **评论、摘抄与杂项**：`load_comments` / `sh_comments` / `cm_count` / `COMMENT_COUNTS`、`OPEN_EXCERPTS_NOTEBOOK` / `SAVE_EXCERPT`、`show_changelog`、`SHOW_GLOBAL_BOOKMARKS` / `CLOSE_GLOBAL_BOOKMARKS`、`show_update_banner` -> `execute_update`、`SIM_POINTER`（触控板虚拟光标）。

#### 契约 C：同源 `window.top` 直连句柄 & Wasm 导出面
- **主控挂载至 `window.top`**：`SiteCore`、`sharedWasm`（`{ ready, failed, weightedKeywords, format_markdown, find_content_matches_multi, compute_lcs_diff }`）、`__DOC_SEARCH_BRIDGE__`（与 `__TXT_SEARCH_BRIDGE__` 指向同一对象：`register/unregister/getScope/setScope`）、`VirtualCursor`（桌面端轻量占位，触屏加载 `touchpad.js` 后回放挂载）、`callLocalApi`、`pinyinData`、`commentCounts`、`lite_data`、`readme_md`、`parseAdsQuery`、`buildAdsPositiveTerms`、`buildTermSpecs`、`hasTermSpecs`、`ensureTermSpecs`、`takeSnapshot`、`_isBombing`。
- **Wasm (`lib.rs`) 22 个导出函数**：
  - 数据构建：`set_data`, `build_flat_data`, `build_and_set_data`, `doc_count`, `set_comments`, `comment_doc_count`。
  - 检索与摘要：`supports_weighted_keywords`, `bloom_might_match`, `prepare_search`, `scan_prepared_range`, `search_multi_range`, `prepare_ads_search`, `scan_prepared_ads_range`, `search_ads_range`, `prepare_comment_search`, `scan_prepared_comments_range`, `search_comments`, `get_snippets`, `get_snippets_ads`。
  - 渲染与页内：`format_markdown`, `find_content_matches_multi`, `compute_lcs_diff`。

#### 契约 D：本地伴生 HTTP 控制面（仅 `Serve` 模式挂载）
全站挂载 `host_guard_middleware`（仅放行 `localhost:<port>` / `127.0.0.1:<port>`）与 `security_headers_middleware`；`/__api/*` 额外挂载 4 重 `api_auth_middleware`（`Origin` 白名单 + `Sec-Fetch-Site: same-origin` + `subtle` 常量时间 `X-Swamp-Token` 比对 + 32 MB body 上限）：

| 路由 | 方法 | 作用与关键约束 |
| :--- | :--- | :--- |
| `/__auth` | GET | 轻量同步页：从 `#__swamp_token` 写入 `localStorage.__swamp_local_token__` 并 `replaceState`；通过 `navigator.locks.query()` 探测是否已有持有 `swamp_main_tab` 共享锁的主页，有则自动关闭本页不重复开窗，无则跳 `/` |
| `/__auth/refresh` | POST | 401 自动续签兜底：校核 Origin + Sec-Fetch-Site + JSON，使用 `try_lock()` 单飞弹出本机 Win32 物理确认框（拒绝冷却 10 s，通过宽限 3 s） |
| `/__oauth/callback` | GET | Google Tasks OAuth 回调：先校核 `state` 匹配再消费 `PendingOAuth`，对 `error` 清洗换行并 HTML 转义，强制下发 `script-src 'none'` CSP |
| `/__api/health` / `/__api/tasks` | GET | 服务健康探活 / 返回内存中的近期到期 Google Tasks |
| `/__api/files/html` | PUT | 双语页原子写盘（UTF-8 带 BOM），校验 `validate_title` 且文件必须已存在 |
| `/__api/files/md` | PUT | Markdown 原子写盘（移入 `spawn_blocking`），校验 `validate_rel_md_path` 且排除 `_build`/`.git`，落盘后同步写入 `md_history` 返回新 `ver` |
| `/__api/bookmarks` | POST | 原子增删移 `src/tpl/bookmark.html` 书签并更新 `#end_flag` 毫秒时间戳 |
| `/__api/ops/edit` | POST | 更新 `<span id="anchor">` 14 位时间戳，返回文件 SHA-256 `sig` 并拉起 VS Code |
| `/__api/ops/watch-html` | GET | 25 s 长轮询监听编辑中的 HTML 保存（订阅 `html_change_tx` + 2 s 兜底 + `shutting_down` 原子秒退） |
| `/__api/ops/md-history` / `md-rev` | GET | 严格只读（零写盘，`spawn_blocking`）获取本地 `.md` 版本列表与沿反向差异链还原的任意历史版本原文 |
| `/__api/ops/explorer` / `cli` / `txn` / `katrain` | POST | 打开仓库根目录 / 触发 `gen` / VS Code `-g txn.txt:<line>` 跳行 / 聚焦或 `uv run` 启动 KaTrain |

---

### 4. 六大核心行为状态机

#### 状态机 1：浏览器冷启动、SW 防撕裂与现场恢复
1. **同步引导**：`index.html` 成人确认（跳过爬虫 UA）-> 注入 `PARAM` 常量 -> 加载 `site-core.js` -> `index.js` 吸收 `#__swamp_token` 并持有 `swamp_main_tab` 共享 Web Lock。
2. **并行预热**：同时 `import()` 主线程 Wasm 与 `search-engine`+`search-ui`，挂载 `__DOC_SEARCH_BRIDGE__`。
3. **`onload` 自愈与挂载**：检查 `?repair=1`（2 秒后异步绕缓存检查 `/sw.js` 的 `repair_command_id`）-> 恢复侧栏 flex 比例 -> 加载 `#side` -> 注册 `/sw.js` -> 初始化搜索 UI。
4. **SW 防撕裂核心机制**：线上模式下，SW 拦截 `/src/js/core-list.js` 时**不走网络**，而是直接用当前活跃 SW 自身的 `FILE_MANIFEST` 与 `BUILD_VERSION` 在内存中拼出 JS 响应。因此在旧页面激活新版 SW 之前，代码、清单、切片版本永远锁死在同一套。
5. **SW 增量安装**：对比旧桶 `sw-manifest.json` -> 未变项直拷 -> 变更的 `/html/*` 与 `*.md` 压存 `deflate-raw` 至 `MainDB.html_snapshots`（上限 10 版，`.md` 时间戳取旧桶 `core-cache-{BUILD_VERSION}`）-> `core-bundle.json` 变更数 $>15$ 或首装时拉大包解包，否则按网速（4/2/1 并发、30 s 超时、`inFlightRequests` 合并）独立拉取 -> `CRITICAL_URLS`（16 项）任一失败中止安装，非关键文件回退旧桶并保留旧哈希 -> 若 `synonyms.js`/`.wasm`/胶水变更则写 `pending_search_cache_clear`，于 `activate` 时清库。
6. **数据同步与恢复**：`loadScripts`（90 s 看门狗）并行预热 Worker 与 `MainDB.chunks` -> 注入 `core-list.js` ->（本地）`shadowIndex.js` -> `lite_data.js` -> `RENDER_CATALOG` -> 有 `ss_restore_strict` 快照则懒加载 `snapshot.js` 恢复（先校验文件是否仍存在，丢失则清脏键回退书签页），否则直开 `bookmark.html` -> `loadDataInBatches` 差分拉取 `fat_data_*.json`（**0 失败才原子 `saveBatch` 落盘并清搜索缓存**）-> Worker `BUILD_DATA`（45 s 看门狗）-> `DATA_READY` 返回轻量 `window.data` + `fp` -> 绑定 `core` 命名空间、媒体增删对账（清理 `media-cache` 与 `BookDB.pruneDeletedBooks`）、播更新彩带、闲时预热基础字体、`comments.js`、`deferred-features.js` 与（触屏）`touchpad.js`。

#### 状态机 2：五维统一检索引擎（全站 / 书内 / 页内 / 评论 / 双语）
- **内存与加速分层**：主线程仅存轻量 4 元组 `[title, placeholder, path, type, ...]`；全文常驻 Worker Wasm 内存，建有 1 MB 语料 bigram Bloom、256 KB 评论 bigram Bloom、按文档字数分 4 档（$\le 64 / 512 / 4096 / >4096$）的文档级 unigram/bigram `DocFilter`，以及基于首字 256-bit 掩码 + 倒排桶的单遍 `ScanPlan`。
- **匹配与位域打包契约（全站/页内/电子书共用）**：
  - 噪值上限：$\min(\text{noise}, \text{len} > 25 ? 0 : \lfloor \text{len}/2 \rfloor)$；单个空白不计噪，连续空白超 1 个计噪；硬边界 `\n \r 。！？；!?;` 不可跨越；匹配前统一全角转半角 + 小写折叠。
  - **区间裁决优先级**：`tier`（`0` 原词 > `1` 1-hop/自定义 > `2` 双槽组合）> `noise`（升序）> `weight`（降序）> 覆盖长度（降序）。
  - **`find_content_matches_multi` 返回的 `Uint32Array` 三元组 `[start_u16, end_u16, packed_meta]`**：`bits 0..7` = `noise`（0–255），`bits 8..9` = `tier`（0–2），`bits 16..23` = `weight`（10–100）。所有前端高亮（`content.js`、`shared-utils.js`、`search-ui.js`、`search-preview.js`、`pdf-viewer.js`、`epub.html`、`txt.html`）均按此位布局解包并分配 CSS Custom Highlight 槽位与优先级。
  - **计分公式**：标题基分 5000（每噪 $-500$，同义封顶 4500，饱和系数 $k = 1$）；正文基分 100（每噪 $-10$，同义封顶 450，饱和系数 $k = 4$）；按降序权重加权 $v \cdot k/(k+i)$ 累加；最后按文档最小原词噪值加保底分（0 噪 $+10000$、1 噪 $+3000$、2 噪 $+2200$、3 噪 $+1500$、4 噪 $+900$、其余 $+500$）。
- **布尔组合（ADS）**：`@[expr]词1[NM]词2[]...`，支持 `& | ! ()` 与最多 26 个单字母形参（嵌套上限 8 层）；德摩根下推 NNF，前后端双端拦截空文档恒真；`ads_optimize` 按（非否定 > 噪值升序 > 词长降序）排序短路；先联合正文+评论求值，再仅正文复核判定 `viaComment`。
- **抢占式调度**：Worker 通过 `MessageChannel` 让出事件循环，8 ms 自适应时间片（`16–4096` 篇动态伸缩）；`token` 变更立即作废，`dataGen`/`commentGen` 变更自动重扫。
- **近义词扩展（`synonyms_tpl.js` `cilin-1hop-df-v5.1`）**：A 整词直达 -> B `#`/`@` 独立词与 `stopExpand` 保护不拆 -> C DP 最优分词（带 ASCII 词边界保护）+ 词林 5 级编码 LCA 上下文消歧 + 公开语料 DF 7 档乘数 + `K`/`L` 虚词降权；全站搜用 `bloom_might_match` 裁剪，**书内搜必传 `skipCorpusFilter: true`（`cacheTag: 'raw'`）跳过全站 Bloom 裁剪**。
- **四重搜索缓存失效**：① `core` 命名空间 `v{SEARCH_ALGO_VER}|d:{dataFp}` 变动清库并跨标签页广播 `SEARCH_CACHE_CLEARED`；② `syn` 命名空间 `synonyms.js` 指纹变动清库并重搜；③ SW 安装检测到 `synonyms.js`/`.wasm`/胶水变更置 `pending_search_cache_clear`；④ `fat_data_*.json` 增量全成功原子落盘后主动清库。
- **书内搜与双语页特判**：TXT / PDF / EPUB 打开时通过 `__DOC_SEARCH_BRIDGE__.register(provider)` 接管主站搜索框，结果存入独立的 `BookDB`；双语页（含 `#engText`/`#zhText`）在 `content.js` 早期通过 `MutationObserver` 劫持 `zhText.value` 以在草稿回填后恢复高亮，悬停预览未打开的双语页时由 `search-engine.js` `requestFetchedBilingualSnippets` 实时抓页提取文本算摘要。

#### 状态机 3：内容渲染、页内 Diff 与实时编辑
- **HTML 双阶段安全渲染**：`content.js` 仅提取 `<pre>` 的直接 `TEXT_NODE` 交给 Wasm `format_markdown`——该函数在生成 `<img>` / `<a target="_blank" rel="noopener noreferrer">` 之前对所有非媒体纯文本转义 `& < > " '`（并拦截非 `http(s)` 协议图片路径），从而彻底阻断 `createContextualFragment` 的标签复活注入；而作者手写的 `<p>` 表格与 `<code>` 块在浏览器初始解析阶段已是 `ELEMENT_NODE`，不受转义影响，随后转表格并交 Prism 高亮。
- **HTML 历史 Diff 与本地热重载**：
  - Diff：从 `MainDB.html_snapshots` 读最多 10 版快照，双方 `<pre>` 渲染为标准化 Token（`html_line`/`table_*`/`code_*`）送 Wasm `compute_lcs_diff`（矩阵超 $2.5 \times 10^7$ 熔断），右侧挂接 `#diff-minimap`；开启 Diff 时自动清除页内搜索高亮并广播 `CLEAR_SEARCH`。
  - 热重载：点击 `edit` -> `POST /__api/ops/edit` 更新 `#anchor` 并拉起 VS Code -> 前端循环长轮询 `GET /__api/ops/watch-html` -> 保存落盘后 `watcher.rs` 广播文件名 -> `sessionStorage` 记下 `scrollY` 后 `location.reload()` 原地恢复。
- **Markdown 通用双轨 Diff（`md_viewer.html`）**：
  - 线上：读取 `MainDB.html_snapshots`（键名兼容 `/README.md` 与相对路径），最多 10 版，命名 `vN (最新)` / `vK · YYYY-MM-DD HH:MM`。
  - 本地：由 `services/md_history.rs` 跟踪落盘变更，反向 Myers 行级差异链存于 `_build/temp/md_history/<sha256前20位>.json`（当前落盘全文 + 最多 50 条反向差异 = **共 51 版**，版名 12 位 `yymmddhhmmss`，同秒 `+1s` 单调递增；`watcher` 外部保存启用 60 s 合并窗口防自动保存刷爆历史，站内 `Save`/回填不合并；还原必校验 `old_sha256`；文件读取 I/O 失败拒绝覆盖，JSON 损坏改名 `.corrupt` 留档再重建；GET 接口严格只读并通过 `spawn_blocking` 执行）。
  - 视图：默认渲染态（按块/表格行/嵌套列表项/代码行配平 `<span>` 做结构化 DOM Diff，成对修改自动执行行内字/词级高亮）+ 一键切源码态 Unified Diff + 仅看改动折叠 + 右侧 `#toc` 6px 变更圆点 + 逐块跳转（`F7`/`Shift+F7`/`[`/`]`）。

#### 状态机 4：本地事务化全量构建（`swamp gen`）
1. **双锁并发控制**：`GEN_LOCK` 保证全量构建单飞（并发 `gen` 立即返回忙），随后阻塞获取 `ASSET_LOCK` 等待毫秒级单文件热压缩收尾并全程阻断 `watcher.rs`（`watcher` 用非阻塞 `try_acquire_asset_lock`，拿不到直接跳过，避免热压缩导致手动 `gen` 误报忙），结束后保留 1.5 s 尾项冷却。
2. **Phase 1（增量压缩）**：`rayon` 并行压缩 `src/js/raw/*.js`、`src/css/raw/*.css`、`src/css/font/font.css`（跳过 `core-list.js`/`sw.js`/`synonyms.js`），核对 `build_hashes.txt`（`swamp-min-v3|raw_sha|out_sha`），自动删除已删源码对应的废弃产物。内置纯 Rust ES2020 JS 压缩器（正确保护 `}\nwhile` ASI、`for await (...) /re/`、`#privateField`、嵌套模板字面量）与 CSS 压缩器（保留 `calc()` 空格、引号外反斜杠转义、空自定义属性 `--foo: ;`）。
3. **Phase 2（暂存事务与全覆盖隔离断言）**：
   - 内存准备 `index.html` 参数注入（`serde_json::to_string` + 转义 `</`）；加载 `.gitignore`（无有效规则默认 fail-closed 拒绝构建）。
   - 扫描 `html/*.html` + `git check-ignore` 复核 + 强核验 `__` 前缀与重复 `<title>`；对 `<title> != file_stem`、空时间戳 `#anchor`、缺失/大小写不符图片（跳过 `<code>` 块）输出告警；`extract_body_text` 仅剥离合法 `<[A-Za-z/!?]...>` 标签（不吞 `a < b`）并保留 `\n` 硬边界，公/大/私分流。
   - 扫描四类媒体目录（带 `canonicalize` `visited_dirs` 防符号链接循环 + 目录名保留字 `_f`/`__proto__` 防御）并批量 `git check-ignore` 复核。
   - 在 `_build/temp/staging_data_<pid>_<ms>` 写出 `lite_data.js`、`fat_data_*.json`、`shadow_data_*.json`、`shadowIndex.js`、`core-bundle.json`；内存中暂存重建 `synonyms.js` 与 `oov_report`（断言前绝不落盘）。
   - 校验 `[build.precache]` 显式项/Glob 与 `readme_md`（强制规范化 + 位于仓库内 + 非 `_build`/非私有），生成清单（仅 `(path, hash, source)` 变化时推进 `BUILD_VERSION`，未变化时仍核验 `raw/sw.js` 版本对齐）。
   - **Aho-Corasick 全覆盖零误报隔离断言**：独立从磁盘读取公开 HTML 与 `README.md` 作排除集（不复用流水线产物）；将所有私有页剥离 `#anchor` 后的正文按 24 字窗口 / 12 字重叠步长（100% 捕获 $\ge 35$ 字局部泄露）编入单个 `AhoCorasick` 自动机，单遍扫描全部暂存公网产物（含 `fat_data_*.json`、`core-bundle.json`、`lite_data.js`、`synonyms.js`、`core-list.js`，仅对 `lite_data.js` 放行该页已知元信息），私有独占片段单处命中即中止构建。
   - **原子提交**：全部通过后统一写盘——`synonyms.js`、`index.html`、`discussion_id_mapper.json`，`commit_staging_to_data_dir` 逐文件 `write_bytes_atomic` 覆盖 `src/js/data/` 后再清理废弃旧片，最后写 `raw/core-list.js`、`raw/sw.js`、`idle-list.txt`。
4. **Phase 3**：增量压缩 `raw/core-list.js` -> `src/js/core-list.js`、`raw/sw.js` -> `/sw.js`，落盘 `build_hashes.txt`。

#### 状态机 5：补丁回填、编译交接与安全推送闭环
- **补丁分级与必看 Diff 门禁**：`pack_apply.rs` 硬拦截路径穿越、8.3 短名、尾点/尾空格、Windows 保留设备名、`.git` 及全部 `is_hard_private_rel`（含 `_build/privy/`）；对任意层级 `.cargo`、`Cargo.toml`/`Cargo.lock`/`build.rs`/`build.bat`/`rust-toolchain*`/`_build/swamp.toml`/`.github/*`/`.gitignore`/`.gitattributes`/`.gitmodules` 及脚本后缀（`bat/cmd/ps1/exe/dll/msi/vbs/vbe/scr/lnk/hta/wsf/py/sh`）标为 `[构建配置·未查看]` 且默认不勾选。只要选中了任意未双击通过 VS Code `--diff`（`.code-workspace` 自动追加 `.txt`）查看过的高危文件，「回填后退出并运行 `build.bat`」自动取消勾选并禁用，全部查看标为 `[构建配置·已查看]` 后才解锁，且执行前仍弹窗确认。
- **两遍原子回填与交接**：`execute_apply_zip` 第一遍全量解压校验（单文件 64 MB / 总量 256 MB / 私密禁区），第二遍在 RAII `ManifestGuard` 保护下备份并写盘（确保中途失败也写出 `_manifest.json` 可一键回滚），可选「规范 `bat/ps1` 编码」（`.bat`/`.cmd` 转 UTF-8 无 BOM + CRLF，`.ps1` 转 UTF-8 带 BOM + CRLF）。若勾选自动编译，发 `WM_APP_EXIT_AND_BUILD` -> `begin_safe_close` 等待 `active_ops == 0` -> 置 `shutting_down = true` -> 回收 `sim` 子进程、销毁窗口 -> `main.rs` `server_handle.join()` 释放全部句柄 -> 经环境变量 `SWAMP_HANDOFF_TOKEN` 传递令牌拉起 `build.bat`（`build.bat` 首行即转存并清空环境变量防泄漏给 `cargo`，新 `swamp.exe` 启动立即吸收并抹除，无缝续接旧浏览器标签页）。
- **推送四重隐私门禁**：独立 `push` 先执行 `verify_public_outputs_clean` -> 校验 `.gitignore` 存在 -> `git add -A` 后扫描 `git diff --cached --name-only -z`，命中 `is_private_push_path` 立即 `git reset` 中止 -> 推送前用 `git log -m --name-only -z` 扫描 `@{u}..HEAD`（新分支无上游时自动回退 `HEAD --not --remotes` 或 `HEAD`）全部待推送提交历史，命中即中止。

#### 状态机 6：后台伴生服务与媒体工具
- **VPN 心跳与 Google Tasks**：按 `heartbeat_interval_sec` 探测 `heartbeat_url` 并刷新窗口图标红/绿灯；Tasks OAuth 启用 PKCE (S256) 与 Google HTTPS 域名白名单，API 401 时优先用 `refresh_token` 刷新重试再考虑重授，结果同步落盘至 `_build/privy/upcoming_tasks.json`。
- **媒体处理**：`webp.rs` 使用静态链接 `libwebp` 批量缩放转码并复制文件名至剪贴板；`keep2html.rs` 解压目录先写 `"IN_PROGRESS"` 标记实现中断自愈（仍保护无标记用户目录），附件路径经 `canonicalize` 约束在解压目录内，静态图转 WebP、多帧 GIF 缩放保留，正文与渲染端构成双阶段转义。

---

### 5. 安全信任模型（Trusted vs Untrusted）

- **完全信任源**：仅限本机私有的 `_build/privy/local.toml`（及兼容旧 `local.properties`）。凡涉及拉起外部进程或移动目录的配置（`vscode_path`、`katrain_dir`、`img_input_dir`、`webp_output_dir2`、`keep_takeout_zip_folder`）**只认本机私有配置**，绝不回退读取入库的 `_build/swamp.toml`。
- **半信任/受限源**：入库 `_build/swamp.toml`（`webp_output_dir` 强约束在仓库内，`heartbeat_url` 强校验 `http(s)://`，写回前须通过 `toml::from_str::<SwampToml>` 预校验）、AI 补丁 `.zip`、Google Keep Takeout `.zip`、外部浏览器页面。
- **纵深防线**：
  - 仅监听 `127.0.0.1`，全路由 `Host` 白名单防 DNS Rebinding；
  - 静态文件 `validate_static_request_path`（单次 URL 解码）+ `canonicalize` 后 `validate_decoded_static_path`（不二次解码，防符号链接/Junction 绕过且不误杀字面 `%` 文件名），`.svg` 下发 `Content-Security-Policy: sandbox`；
  - 全站禁 `eval`（默认 CSP 仅放行 `'wasm-unsafe-eval'`；`street_view_uploader.html` 单独放行 Tailwind CDN + Google GSI；灯箱 `about:blank` 达 `script-src 'none'`；`pdf.html` 零 `'unsafe-inline'`）；
  - 外部命令优先直启 `Code.exe` 绕过 `cmd.exe`，回退时拦截全部 cmd 元字符；
  - `swamp.exe --selftest` 固化 **74 项**回归用例（覆盖路径守卫、Host 白名单、API 鉴权、PKCE RFC 7636 向量、JS/CSS 压缩、HTML 抽取、补丁分级与 `ManifestGuard`、全覆盖隔离断言、`md_history` 差异还原与损坏保护）。

---

### 6. 硬性不变量、遗留契约陷阱与“改 A 必查 B”

#### 12 条硬性不变量
1. **只改源码不改构建产物**（见第 2 节边界图谱）。
2. **新增需离线静态文件**：必须命中 `_build/swamp.toml` `[build.precache]`；首屏关键模块同步加入 `src/js/raw/sw.js` `CRITICAL_URLS`。
3. **主线程不持全文**：全文检索、摘要抽取与 Diff 计算一律放 Worker / Wasm。
4. **改匹配或评分语义必递增 `SEARCH_ALGO_VER`**（当前 `11`，同步更新 `search-engine.js`、`book-db.js`、`pdf-viewer.js`、`epub.html`、`txt.html`）。
5. **BUS 消息必检 `tabId`**（唯一跨标签页豁免：`SEARCH_CACHE_CLEARED`）。
6. **删 IDB 前先关连接**：清库必须先关 `MainDB` / `BookDB` / `ExcerptsDB` / `SideDB` 并置 iframe 为 `about:blank`，期间置 `window._isBombing = true`。
7. **公私隔离底线**：任何新增公网产物严禁读取私有正文或词频，并同步纳入 `assert_no_private_leak` 与 `verify_public_outputs_clean`。
8. **单一事实源**：`MainDB` Schema、20 个 `TAB_SCOPED_KEYS`、`createStore` 与白名单校验只在 `src/js/raw/site-core.js` 定义。
9. **环境分支只认 `store.online_flag`**。
10. **不移除内容页反脱壳脚本**（`top === self` 跳转首页）。
11. **本机私有路径不入库**：一律写入 `_build/privy/local.toml`。
12. **新增本地 API 必须走鉴权中间件并补充 `--selftest`**，`Sim` 模式绝不挂载。

#### 切勿“顺手修正”的历史契约陷阱
- `store.lightbox_stauts` 与 `store.bookmarkhtml_modifing`：原始拼写横跨 `site-core.js`、`index.js`、`lightbox-logic.js`、`snapshot.js`，**禁止单点改拼写**。
- `MainDB` 对象仓库名 `html_snapshots`：线上模式同时存放 `/html/*.html` 与 `*.md` 快照，保持原名避免无谓升库。
- `window.__TXT_SEARCH_BRIDGE__` 与 `window.__DOC_SEARCH_BRIDGE__`：互为别名，`txt.html` / `pdf-viewer.js` / `epub.html` 均有引用。
- DOM 锚点契约：HTML 依赖 `<span id="anchor">YYYYMMDDHHMMSS-分类链</span>`；`bookmark.html` 依赖 `<a id="end_flag" href="...">`；`bilingual.js` 固化前通过 `garbageSelectors` 剥离运行期注入节点（新增 `content.js` 顶层 DOM 节点时必须同步补入 `garbageSelectors`）。
- 目录树保留键：`lite_data.js` 叶子数组键名固定为 `_f`，无分类固定为 `_uncategorized`，分类名禁用 `_f` / `__proto__` / `constructor` / `prototype`。

#### “改 A 必查 B”高频联动表

| 如果你修改了… | 必须同步检查或执行… |
| :--- | :--- |
| `_build/swamp-server/src/lib.rs` | 执行 `build.bat all`（或 `[2]` 重编 Wasm）+ `gen`；若改匹配/评分语义，递增 `SEARCH_ALGO_VER`（5 处） |
| `_build/swamp-server/src/*.rs`（非 `lib.rs`） | 执行 `build.bat exe`（通过 74 项 `--selftest`）；新增 API/规则同步补 `--selftest` 与 `README.md` |
| `src/js/raw/*.js` 或 `src/css/raw/*.css` | 本地 `watcher` 会 300 ms 自动热压缩；发布前仍需执行 `gen` 刷新清单与 `BUILD_VERSION` |
| `src/tpl/*.html` | 核对 `<meta http-equiv="Content-Security-Policy">`、`swamp.toml` precache 规则，并执行 `gen` 重建 `core-bundle.json` |
| `src/js/raw/content.js` 新增挂在 `body` 的运行期元素 | 同步把选择器加入 `src/js/raw/bilingual.js` 的 `garbageSelectors`，避免双语固化时把运行期 DOM 写回源码 |
| `src/js/raw/site-core.js` 修改 `MainDB` / `TAB_SCOPED_KEYS` | 同步核对 `sw.js`（引用 `SiteCore.openMainDB`）、`deferred-features.js`（`@bomb`/`@rebirth`）与 `README.md` |

---

### 7. AI 协作协议与交付规范

#### 两步协作法
1. **第一步（只分析、不盲改）**：提供上下文压缩包（或 MD 分卷）与现象/目标，AI 定位根因并给出最小改动方案，确认边界后再动手。
2. **第二步（按规范交付补丁）**：确认方案后，AI 交付可直接拖入管理窗「回填补丁」页的增量完整文件 `.zip`。

#### 按场景最小上下文集
- **核心检索**：`README.md` + `_build/swamp-server/src/lib.rs` + `src/js/raw/{worker,search-engine,search-ui,shared-utils}.js`
- **近义词调优**：`README.md` + `_build/swamp.toml` + `_build/swamp-server/src/builder/{synonyms.rs,synonyms_tpl.js}` + `oov_report.txt`（不传 `cilin.txt`）
- **构建与本地服务**：`README.md` + `.gitignore` + `_build/swamp.toml` + `_build/swamp-server/` 源码（不传 `Cargo.lock` 与 `target/`）
- **SW / 热更新 / 清单**：`README.md` + `index.html` + `src/js/raw/{site-core,index,sw,snapshot}.js` + `_build/swamp.toml` + `generator.rs` + `config.rs`
- **电子书阅读器**：`README.md` + `src/tpl/{pdf,epub,txt}.html` + `src/js/raw/{pdf-viewer,book-db,search-preview,shared-utils}.js` + `src/css/raw/pdf-viewer.css`
- **Markdown 预览与 Diff**：`README.md` + `src/tpl/md_viewer.html` + `src/js/raw/sw.js` + `_build/swamp-server/src/{services/md_history.rs,api_files.rs,api_ops.rs}`

#### 打包与回填铁律
- **上传给 AI（Pack）**：仓库根目录相对路径，仅含源码与配置，不含构建产物、`.map`、`_build/privy/`、`_build/temp/`；不支持 `.zip` 时用管理窗「同时生成 MD」按单文件 KB 上限分卷。
- **AI 返回补丁（Apply）**：
  - 所有条目直接从**仓库根目录相对路径**起算，严禁外包顶层文件夹（如 `patch/`、`repo/`）。
  - **仅打本次实际新增或修改的增量文件**，且每个文件必为**可直接覆盖的完整源码**（禁止省略注释或 diff 片段）。
  - **只改源码不改构建产物**（不塞压缩后 JS/CSS、根目录 `sw.js`、`core-list.js`、`core-bundle.json`、`synonyms.js`、`.wasm`）。
  - **编码与换行**：`.bat` / `.cmd` 用 UTF-8 无 BOM + CRLF；`.ps1` 用 UTF-8 带 BOM + CRLF；其余保持原编码与换行风格。
  - **说明文件与必需动作声明**：验证步骤写进根目录 `PATCH_NOTES.md`（Apply 自动跳过）；禁含 `.git` 与 `_build/privy/` 内文件；凡涉及**删除/重命名文件、修改 `local.toml`、重编译 `swamp.exe`/Wasm、或执行 `gen`**，必须在回复正文显式列出。
- **`README.md` 同步原则**：改动影响功能入口、配置项、构建步骤、通信契约、存储结构、安全策略、版本号或自检数时，同轮补丁同步修订对应位置；保持克制客观的实话文风，不追加逐日更新流水账。
