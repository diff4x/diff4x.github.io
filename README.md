# [diff4x's digital swamp](https://github.com/diff4x/diff4x.github.io)

> <img src="https://avatars.githubusercontent.com/u/222525381?v=4" width="100">
>
> 本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航

---

# 🔰 使用说明 (浏览)

## 搜索

- 出入口
  - 按 `\` 将焦点定位到搜索框
  - 按需切换 `搜全站` 或 `搜本书`（`pdf`、`txt`、`epub`）
  - 不同类型的结果区别着色
  - 命中评论时用 `[💬 命中数量]` 额外提示
  - 私有条目以 `🔒` 提示
  - `鼠标右击` 搜索历史中的某一条即删除该记录
  - 点击 `clear` 或组件范围内 `鼠标中击` 收起搜索

- 预览
  - 对于 HTML 条目 `hover` 显示包含搜索词的上下文片段，`鼠标右击` 控制片段滚动或停止
  - 对于图片条目 `hover` 显示小图预览
  - 对于音视频条目 `鼠标右击` 弹窗播放，再次 `鼠标右击` 停止播放
  - 离开条目后预览销毁，保留音视频的播放进度

- 过滤
  - HTML 页面时间戳和 `gallery/拍摄` 均按格式 `YYYYMMDDHHMMSS`
    - 例如查找 2026 年 10 月创建或更新过的内容，可输入 `202610` 或更短的 `2610`
  - `筛选` 子项统计了所有结果条目的文件格式
    - `年月` 是针对 HTML 结果条目的进一步统计

- 容错
  - 噪值：搜索词相邻字符之间允许夹杂的无关字数上限（空白不计）
    - 上限随搜索词长度动态缩放，算法为 $\min(\text{noise}, \text{KW\_LEN} > 25 ? 0 : \text{KW\_LEN} / 2)$
      - 以噪 `3` 为例：

        | 搜索词长 | 1 | 2–3 | 4–5 | 6–25 | $\ge 26$ |
        | :--- | :---: | :---: | :---: | :---: | :---: |
        | 无关字数上限 | 0 | 1 | 2 | 3 | 0 |

        - 搜索 `此人天生坏种` 可命中 `此间的贼人个个天生坏种`
    - 换行与句末标点为硬边界不可跨越

  - 近义：基于《哈工大同义词林扩展版》，结合构建期全站词频统计，运行时加权消歧
    - 开启后搜索 `他简直是秀逗了` 可命中 `他一定是糊涂了`。

- 组合
  - 搜索词以 `@[...]` 开头时进入组合搜索模式
  - 示例：`@[a&!(b|c)]飞机[31]大炮[]机枪[0]`
    - 包含 `a` 且不包含 `b` 或 `c`
      - 包含 `飞机`，且不包含 `大炮` 与 `机枪` 中的任意一个
      - `a` 为 `飞机`（噪值 3，近义 1）
      - `b` 为 `大炮`（噪值与近义取全局设置）
      - `c` 为 `机枪`（噪值 0，近义取全局设置）
    - 第一个 `[]` 是表达式区域，允许 `&`、`|`、`!`、`()` 四种逻辑运算符和互不重复的单字母形参
    - 示例中的表达式有三个形参 `a`、`b`、`c`，依次对应其后三个实参标记符 `[]` 左侧的文本
      - 实参标记符 `[]` 内可填写 0 到 2 位数字：
        - 0 位 `[]`：使用全局噪值与全局近义
        - 1 位 `[N]`（N 为 0–5）：使用指定噪值 N 与全局近义
        - 2 位 `[NM]`（N 为 0–5，M 为 0–1）：使用指定噪值 N 与指定近义 M

- 附加命令
  - `@bomb`：可选式重置数据
  - `@rebirth`：可选式导入数据

## 内容栏

- 站点手册：点击 `bookmark` 页面中的 `README` 弹出 markdown 浏览器加载站点手册，即你所见
- 版本比对：`html` 页面左上角选择任意两个版本按 `diff` 查看差异
- 代码编辑：双击 `code` 代码区域，进入临时编辑模式（右上角提供一键复制）
- 线上评论：`html` 页面左上角点按评论气泡，登录 GitHub 账号参与评论
- 拼音与摘抄：`html`、`pdf`、`epub`、`txt`、`README` 页面中，选中单字提示拼音，选中多字提示摘抄
- 全屏浏览：`gallery`、`video`、`pdf`、`txt` 下 `鼠标中击` 进入全屏
- 壁纸收集：`gallery` 中 `As Wallpaper` 将图片加入壁纸列表，在 Bookmark 页面右下角集中管理

## 侧边栏

- 栏宽可调
- 分类目录旁注其下的文件总数与近期更新总数并着色醒目
- 条目 `mark` 用于标记已阅
- `hover` 图片与视频条目时显示缩略图
- 双击条目文本复制条目名（桌面端若开启了 QTranslate 等划词软件，需临时禁用）
- 侧边栏内 `鼠标右单击` 呼出书签，`鼠标右双击` 呼出浏览器原始菜单
- 顶部菜单：

  | 选项 | 说明 |
  | :--- | :--- |
  | `What's new?` | 站点的更新记录与最新评论；点击正文/媒体记录定位打开，点击 `README.md` 在 `md_viewer` 弹窗中打开 |
  | `History` | 浏览历史 |
  | `Fav` | 音乐收藏夹 |
  | `Excerpts` | 摘抄薄 |
  | `go_board` | 打开网页棋盘 |
  | `street_view_uploader` | Google 全景图上传 |
  | `txn_parser` | 解析当前流水（仅本地环境读取 `_build/secrets/txn.txt`；汇率经外部 API 获取，见 10.4） |

## 播放器

- 音频：允许 `fav` 标记和常规循环，左上角 `🎵` 单击显隐双击销毁
- 视频：`mkv` 文件允许外挂字幕（读取 `video/vtt/<同名>.vtt`；`vtt/` 在 `.gitignore` 中，仅本地可用）与延迟微调（`[` 提前、`]` 延后，每次 0.5 s）
- 图片灯箱：支持拖拽与滚轮缩放
- 全景图：`gallery` 中文件名以 `pano_` 为前缀的图片，双击进入沉浸式浏览

## 移动端虚拟触控板

| 控件 | 功能 |
| :--- | :--- |
| `光标映射区` | 镜头与视角跟随 |
| `暂停跟随` | 停止/恢复光标联动滚屏 |
| `▲` / `▼` | 上下滚动搜索结果列表或内文目录 |
| `+` / `-` | 缩放页面视图 |
| `框选` | 启用后（按钮高亮）滑动选中文字，停用后弹出拼音或摘抄按钮 |
| `拖拽` | 作用于浮动窗口（日志、摘抄、评论、README）的标题栏，启用后窗口随光标移动 |
| `左双击` | 用于全景图沉浸浏览、侧栏条目文本复制，以及音频播放器的销毁 |
| `中击` | 触发全屏或退出搜索状态 |
| `右击` | 用于搜索结果中音视频条目的预览，以及侧边栏书签呼出 |
| `收起/展开` | 控制触控板的显示与隐藏；按住可任意拖放位置 |

## 异常修复

- 在站点 URL 末尾附加 `?repair=1` 强制初始化，或搜索框调用 `@bomb` 选择性重置

---

# 🚧 维护说明 (维护)

## CLI 交互

| 命令 | 作用与执行逻辑 |
| :--- | :--- |
| `gen` | **核心构建**：增量压缩前端资源，扫描各资源目录和 `html/` 正文生成数据切片，按需重建同义词库并更新文件哈希账本 |
| `new` | **创建新页**：交互式指定标题与分类链代入固定 HTML 模板；分类链中的子分类以 `\|` 分隔 |
| `keep2html` | **笔记转换**：取 `keep_takeout_zip_folder` 中最新的 Takeout `zip`（自动解压），将已归档且未删除的 Google Keep 笔记转换为 HTML 文件；图片缩放后转 `webp`（GIF 经 `gif2webp`）。支持单篇与多合一两种模式（规则见「预设规则」） |
| `webp` | **图片压缩**：将 `imgInputDir`（截图目录）顶层的 `jpg` / `png` 按交互参数缩放（默认最大宽 800）并转为 `webp`（默认质量 80），以时间戳序号命名落盘至 `gallery/img/`（可选改存 `webpOutputDir2`）；原图移入该截图目录的 `history/`；可选把 `html/` 中的旧文件名引用回写为新文件名；文件名自动复制到剪贴板 |
| `static-web-server` | **本地运维**：轮换协议主密钥并启动本地静态服务器（`8000`、`error`、`sws.toml`），在常规窗口中打开站点首页 |
| `push` | **提交与发布**：交互输入提交说明并执行 `git add -A` / `commit` / `push` |
| `gen_and_push` | **构建并发布**：顺序执行 `gen`，构建通过后自动进入 `push` |
| `registering-protocol` | **一次性协议注册**：注册自定义协议（协议名取自 `github_page` 域名的首段，当前为 `diff4x://`）并绑定 `protocol_guard.ps1`（需管理员权限） |
| `simulation` | **线上仿真**：启动本地仿真服务器（`9000`、`info`、`sws-sim.toml`），在隐身窗口中打开站点首页 |
| `vpn-heartbeat-tray` | **后台服务**：任务栏常驻网络状态标识（每 10 s 探测一次，绿 / 红），每 5 分钟轮询 Google Tasks API，附带 Windows 系统工具入口（事件查看器 / 设备管理器 / 服务） |

## 内容栏

- `html` 页面左上角点按 `edit` 调用本地 `VS Code` 编辑实体文件，自动覆写时间戳
- `html` 页面右上角双击标题重载内容栏（仅本地环境）
- 左单击 `bookmark` 页面中的 `README` 弹出 markdown 浏览器加载站点手册（本地环境下支持左右分栏编辑，点击 `Save` 或按 `Ctrl+S` 原地固化）
  - 中击跳转到本项目的线上 GitHub 仓库
- 可向 `bookmark` 中拖入外部链接，或内部拖动链接进行书签的增删移，这些操作是即时固化的
- `bookmark` 之下的版权声明 `hover` 显示当前线上仓库体积
- 双语页面下的译文对齐操作支持一键固化，覆写原文件后仅刷新当前双语页自身（不触发全站 `gen` 重载）

## 侧边栏

- 顶部菜单：

  | 选项 | 说明 |
  | :--- | :--- |
  | `CLI.bat` | 单击选择操作，双击直接构建 |
  | `root/` | 打开本地仓库根目录 |
  | `KaTrain` | 启动本地 KaTrain |
  | `txn_parser` | 解析当前流水 |

  > `CLI.bat`、`root/`、`KaTrain` 三项仅在本地环境显示；`txn_parser` 在线上同样可见，但流水文件只在本地读取。

## 预设规则

- HTML
  - **正文**：直接写在 `<pre>` 标签内，无需 `<br>`
  - **标题**：行首 N 个 `#` 加空格，自动转换为 `<h{N}>` 参与目录生成
  - **层级缩进**：行首使用 4 的倍数个空格（`4`、`8`、`12`、`16`）缩进时自动进行块级着色
  - **链接**：相对路径或完整 `URL` 自动解析包裹为 `<img>` 或 `<a>`；只写文件名（不含 `/`）的图片默认指向 `../gallery/img/`
  - **表格**：写在 `<p>` 标签中，以 `|` 分列，自动渲染为 `<table><td>`
  - **代码块着色**：使用 `<code c>` 格式，其中 `c` 表示目标渲染语言
  - **配图**：`gallery/img` 默认作为 HTML 页面同级引用源

- 文件命名
  - **大型文档**（`_` 前缀）：文件名仅以 1 个 `_` 开头的 HTML 文件（如 `_huge_doc.html`）。正文不参与索引切片制作，但在该页面内进行的搜索结果可被持久化
  - **私人页面**（`__` 前缀）：文件名以 2 个 `_` 开头的 HTML 文件（如 `__private.html`）。正文参与切片制作，但不参与线上发布，仅可在线下本地搜索与访问
  - **全景图片**（`pano_` 前缀）：`gallery/` 目录中以 `pano_` 为前缀的图片，自动识别为全景图

- keep2html
  - Keep 笔记正文中的 `[[IMG序号]]` 占位标记，决定生成的 HTML 页面中相应位置引用的图片序号
  - **单篇转换**：笔记需包含两个标签，其中一个固定为 `single`，另一个作为生成的 HTML 分类；笔记标题作为 HTML 的 `title`
  - **多合一转换**：笔记需包含共同的标签名，此标签名作为 HTML 的 `title`，原单篇笔记的标题作为 `<h1>`，分类名在 CLI 中交互指定
  - 只处理已归档（`Archived`）且未进回收站的笔记；多合一按笔记创建时间升序拼接
  - **日记**：单篇转换中分类为 `日记` 的笔记，图片转存至 `gallery/diary/`（已在 `.gitignore`，仅本地），页面内以 `../gallery/diary/<文件>` 引用；其余分类的图片落在 `gallery/img/`，页面内只写文件名

## 同义词维护

- 文件职责
  - `cilin.txt`：保持只读，补丁外置
  - `synonyms_custom.json`：主要维护区，现代双向词组、单向别名、技术词停扩与词林清洗规则
  - `oov_report.txt`：本地新词雷达，定期挑出未来搜索会用到、且存在中英文或同义表达的高频词，补充到 `synonyms_custom.json` 的 `groups` 或 `aliases` 中
  - `synonyms.sha256`：重建防抖状态（源码哈希 | 产物哈希），随仓库提交；`synonyms.raw.js` 为未压缩中间产物，与 `oov_report.txt` 一样已在 `.gitignore`
  - 也可单独执行 `java -jar gen.jar synonyms`，按已生成的数据切片重建同义词库

- `synonyms_custom.json`

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

- 含义如下：
  - `groups`（双向同义词组）：组内词互相扩展。`exclusive` 默认为 `true`（独占覆盖），会自动将这些词从词林的旧义项中剥离
  - `aliases`（单向别名）：搜索键名可召回目标词，但搜索目标词不会反向召回键名。适合俗称、黑话或上下位归类
  - `stopExpand`（全局停扩黑名单）：列出的现代技术词（至少 2 个字符）禁止从词林 `=` 行扩展，防止语义漂移
  - `dropEqCodes`（词林整行降级）：将指定的 7 位编码行由 `=` 降级为 `@`（停止扩展，但保留词表）；词数少于 2 的 `=` 行也会被自动降级
  - `pruneWords`（按行精准剔词）：仅从指定编码行中删除个别噪声词
  - `splitFixes`（修复粘连词）：修正词林中因漏空格而连写的词

- `cilin.txt`
  - 行格式标记：
    - `=`（等义行）：参与近义词扩展。
    - `#`（同类行）/ `@`（独立词）：不参与扩展，但保留在词表内，以保护分词边界。
  - 常用 5 位分类码（`c5`）备查：

    | 领域 | 推荐 `c5` 分类码 | 对应词林语义类 |
    | :--- | :--- | :--- |
    | AI / 算法 / 学科理论 | `Dk01A` | 知识 / 学科 / 理论 |
    | 网络 / 软件 / 编程 / 系统 | `Dd06A` | 系统 / 结构 / 逻辑 |
    | 电脑 / 电机 / 机械整机 | `Bo01A` | 机器 / 机械 |
    | 手机 / 元器件 / 电路 | `Bo04A` | 电器 / 电子器件 |
    | 影视 / 动漫 | `Dk29D` | 影视作品 |
    | 音乐 / 歌曲 | `Dk28A` / `Dk28B` | 音乐 / 歌曲 |
    | 徒步 / 登山 | `Fb01A` | 行走动作 |
    | 露营 / 户外装备 | `Bp29D` / `Bp11A` | 器物与服饰 |

- 分桶权重表（N：参与统计的公开 HTML 页数，不含 `_` 大型文档与私有页；公开媒体文件名只补 `DF = 1`，不计入 N）

  | 标记 | 条件 | 候选词乘数 | 义项消歧贡献 | 含义说明 |
  | :--- | :--- | :---: | :---: | :--- |
  | 无后缀 | $DF = 0$ | 0.62 | +0.00 | 公网未出现词（降低权重，保留入口） |
  | `:1` | $DF = 1$ | 1.00 | +0.25 | 孤篇专词或媒体标题词 |
  | `:2` | $2 \le DF \le 3$ | 1.12 | +0.45 | 低频高区分度活词 |
  | `:3` | $DF \ge 4$ 且 $DF / N \le 8\%$ | 1.18 | +0.60 | 黄金主题词（权重最高） |
  | `:4` | $8\% < DF / N \le 20\%$ | 1.00 | +0.35 | 常见实词 |
  | `:5` | $20\% < DF / N \le 40\%$ | 0.68 | +0.10 | 偏泛通用词（轻度降权） |
  | `:6` | $DF / N > 40\%$ | 0.38 | +0.00 | 全站高频泛滥词（强降权抑噪） |

---

# 💻 设计说明 (开发)

> **初代** by diff4x | **进化** by Gemini & ChatGPT & Claude & Grok

---

## 一、一页读懂

**一句话**：零后端的个人知识库。内容是静态文件；构建期（Java + Rust）把它们烘焙成「数据切片 + 版本清单 + 检索引擎」；浏览器运行期（原生 ESM + Wasm + Service Worker）完成渲染、检索、比对、标注与离线；GitHub Pages 只负责搬运。

```text
 ① 构建期（本地 Windows · _build/）
    html/  gallery/  audio/  video/  ebook/  README.md  .gitignore
        │  CLI.bat gen
        ├─ esbuild ───────► 压缩后的 JS / CSS（+ source-map）
        ├─ gen.jar ───────► 数据切片 · core-bundle.json · 哈希清单 core-list.js · synonyms.js
        └─ wasm-pack ─────► 渲染 / 检索 / Diff 引擎（lib.rs → .wasm）
        │  git push
        ▼
 ② 分发期（GitHub Pages · 纯静态托管，没有任何服务端逻辑）
        │  首访 / 版本更新
        ▼
 ③ 运行期（浏览器 · PWA）
    sw.js ········ 版本化缓存 · 增量安装 · 请求拦截 · 更新留痕
    index.js ····· 主控：#side 目录树 + #content 视图 + 浮层，由 BUS 事件总线串联
    worker.js ···· 独立线程：Wasm 全文索引 · 模糊 / 同义 / 布尔检索 · 评论融合
```

| 想了解… | 直接看 |
| :--- | :--- |
| 为什么这样设计 | 二、设计原则 |
| 文件放哪、谁生成谁、公私如何隔离 | 三、目录结构 · 四、构建期 |
| 页面怎么搭起来、模块如何分工、怎么通信 | 五、运行期架构 |
| 数据长什么样 | 六、数据模型 |
| 搜索如何又快又准 | 七、搜索子系统 · 十一、算法精粹 |
| 离线、更新、自愈 | 八、离线、更新与自愈 · 九、存储全表 |
| 本地与线上的区别、如何回写本地文件、站点会访问哪些外部地址 | 十、双态一体与本地能力桥（含 10.4） |
| 改代码前该注意什么 | 十二、不变量与踩坑清单 |

---

## 二、设计原则

| 原则 | 含义 | 落地方式 |
| :--- | :--- | :--- |
| **静态文件即事实源** | 不设数据库与服务端，内容、目录、索引全是仓库里的文件 | 源文件 → 构建产物；线上唯一事实源就是仓库 |
| **重活前置，轻活后置** | 能在构建期算好的，绝不留给浏览器 | 构建期做清洗、切片、词频统计、同义词表、哈希清单、压缩；运行期的渲染、检索、Diff 交给 Wasm 与 Worker |
| **双态一体** | 同一份代码按运行环境切换能力 | `store.online_flag`：本地可写，线上只读（见十） |
| **公私硬隔离** | 私有**正文**永不进入任何公网产物（标题、分类、文件名、时间戳作为目录元数据会公开） | 构建期按 `.gitignore` 分流并用 `git check-ignore` 复核；规则缺失即拒绝构建；构建末尾再断言公网产物不含私有正文（见 4.2） |
| **零框架低依赖** | 降低长期维护与迁移成本 | 原生 ESM；无 npm 运行时依赖；第三方库以同源静态文件内置于 `src/third/`（例外：`street_view_uploader.html`，见 10.4） |
| **按需加载** | 首屏只拿最小核心 | 检索栈首屏并行预热；评论、更新日志、摘抄、触控板等一律 `import()` 懒加载 |
| **版本不撕裂，故障可自愈** | 任一时刻「代码 / 清单 / 数据」三者一致；坏了能自己修 | 清单由 SW 合成、切片原子落盘、安装熔断、阶段看门狗、三级自愈（见八） |

---

## 三、目录结构

```text
📂 _build
 ┣ 📂 backup                           # 本机备份：ai_pack_*.zip / ai_apply_*/ / html_*/（.gitignore）
 ┣ 📂 esbuild | libwebp                # JS/CSS 压缩与 WebP 转码
 ┣ 📂 server                           # 本地静态服务器 (static-web-server) 与 sws.toml / sws-sim.toml
 ┣ 📂 pack_apply                       # 打包与回填（pack_apply.bat / .ps1 + presets.json）
 ┣ 📂 jar                              # Java 8 构建器源码（gen/src/main/java/*.java）、gen.jar、log_watch.vbs（Java 退出后弹出新增的 err.log）
 ┣ 📂 rs                               # Rust/Wasm 引擎源码 (src/lib.rs)
 ┣ 📂 secrets                          # 本地凭据、protocol.key、local.properties、到期任务、账单流水 (.gitignore)
 ┣ 📂 synonyms                         # cilin.txt / synonyms_custom.json / synonyms.sha256 / oov_report.txt
 ┣ 📂 woff2_split                      # 字体分片
 ┣ 📜 CLI.bat                          # 构建菜单 + 自定义 URL 协议入口
 ┣ 📜 protocol_guard.ps1               # 自定义协议认证加密信封（Encrypt-then-MAC）与校验唯一入口
 ┗ 📜 config.properties                # 公共路径、参数、SW 强缓存名单（本机私有路径迁至 secrets/local.properties）
📂 audio | ebook | gallery | video     # 媒体目录（物理目录树即站内分类）
📂 html                                # HTML 正文（单层目录，分类由页内 #anchor 决定）
📂 src
 ┣ 📂 css | js                         # raw/ 源码 → 同名压缩产物；source-map/；js/data/ 数据切片；css/font/font.css → css/font.css
 ┣ 📂 third                            # 同源第三方库 (bibi / pdfjs / prism / markdown / photo-sphere-viewer / other)
 ┣ 📂 wasm                             # Wasm 产物与胶水代码
 ┣ 📂 tpl                              # 视图模板 (side / bookmark / txt / pdf / epub / pano / md_viewer / go_board / street_view_uploader / txn_parser) 与页面模板 (new / bilingual)
 ┗ 📜 cmt_mapper.json                  # Giscus 评论 ID ↔ 页面标题
📜 index.html                          # 单页壳（含由构建期注入的 PARAM 参数块）
📜 sw.js                               # Service Worker（由 raw/sw.js 压缩而来，须位于根目录以获得全站作用域）
📜 README.md                           # 站点手册（被 SW 预缓存，被站内 md_viewer 展示）
📜 .gitignore                          # 私有节点清单，同时是公私分流的判据
📜 .nojekyll                           # 关闭 Jekyll
```

---

## 四、构建期

### 4.1 一条命令：`CLI.bat gen`

```text
Phase 1  增量压缩     src/js/raw/*.js · src/css/raw/*.css · src/css/font/font.css  →  esbuild (minify · es2020 · sourcemap；font.css 无 sourcemap)
                      以 SHA-256 (certutil) 对账 modtime_list.txt 与产物存在性，未变则跳过；新表 new_list.tmp 仅在 gen.jar 成功后才覆盖旧表
                      跳过 core-list.js / sw.js / synonyms.js —— 它们由 gen.jar 生成
Phase 2  数据与清单   java -jar gen.jar          （步骤见下表）
Phase 3  尾项压缩     压缩 gen.jar 刚改写的 raw/core-list.js 与 raw/sw.js（sw.js 输出到站点根目录）
```

`gen.jar`（`Generator.run`）按固定顺序执行：

| 步骤 | 做什么 |
| :--- | :--- |
| ① 注入参数 | 把 `github_page`、Giscus 仓库参数、轮询间隔、`readme_md` 写入 `index.html` 的 `PARAM-BEGIN/END` 块 |
| ② 判定私有 | 解析 `.gitignore` 得到私有路径集合，并用 `git check-ignore` 复核后取并集（只会更保守）；`.gitignore` 缺失或没有有效规则即**拒绝构建**（fail-closed） |
| ③ 扫描 HTML | 核对正文里的图片引用：失效引用与大小写不一致只告警，**默认不改写源文件**（需显式 `prune_missing_images=true`，且受 `prune_max_lines` 上限约束并先备份）；产出 `gallery/img/idle-list.txt`（闲置图片清单）；读取 `#anchor` 的时间戳与分类链、页面标题；剥离 `#` 标题符得到检索纯文本；按 4.2 分流；为新标题分配自增 ID 并登记孤儿评论（`cmt_mapper.json`） |
| ④ 扫描媒体 | 递归扫描 gallery / audio / video / ebook，继承 `.gitignore` 的 localOnly 标记，汇入目录树 |
| ⑤ 切片 | 生成 `lite_data.js` 与 `fat_data_N.json`（按 `sliceSize`，当前 300 KB 一片，字节数按字符数 ×3 估算）；私有页另出 `shadow_data_N.json` + `shadowIndex.js` |
| ⑥ 同义词 | `SynonymBuilder.buildIfNeeded`：只用公开语料统计词频（DF），源或产物哈希变化才重编并调用 esbuild 生成 `synonyms.js`（esbuild 不可用时降级写出未压缩版）；同时写出本地诊断报告 `oov_report.txt` |
| ⑦ 清单 | 生成 `core-bundle.json` 与 `core-list.js`：对公开 HTML、数据切片、`coreFiles` 与 README 算 CRC32（媒体文件不在其内），**仅当任一哈希变化**才生成新的 `BUILD_VERSION`（毫秒时间戳） |
| ⑧ 同步 SW | 把新版本号写回 `raw/sw.js` 的 `importScripts(...?v=)` 与 `self.SW_VERSION`（`sw.js` 缺失或写入失败即报错） |
| ⑨ 隔离断言 | 校验 `core-bundle.json` 不含私有页路径，且私有正文指纹（25% / 50% / 75% 处各 40 字符，三段同时出现才算）不出现在 `lite_data` / `fat_data` / `core-bundle.json` / `synonyms.js` 中 |

**失败即停**：任一页面处理失败、`coreFiles` 里有文件不存在、隔离断言不通过，`gen.jar` 都以非 0 退出码结束，并写出 `-Dgen.status` 指定的状态文件；`CLI.bat` 据此中止尾项压缩（Phase 3）、提交与推送，且不更新增量表（Phase 1 已完成的压缩不回滚，下次会重编）。esbuild 编译失败的文件同样不会写入增量表。以下可选开关**并不出现在 `config.properties` 中**，由 `Generator.java` 按缺省值读取，需要时写进 `config.properties` 或 `secrets/local.properties`：`prune_missing_images`（默认 `false`）/ `prune_max_lines`（默认 `30`）/ `private_prefix_check`（默认 `true`：`__` 前缀页未被 `.gitignore` 命中则拒绝构建）/ `allow_empty_gitignore`（默认 `false`）。`_build/backup/` 应加入 `.gitignore`。

### 4.2 公私分流（最关键的一次分岔）

| 页面类别 | 判定 | `fat_data` | `shadow_data` | `core-bundle` / SW 缓存 | 线上表现 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 公开页 | 默认 | 全文纯文本 | — | 打包并缓存，参与 DF 统计 | 完整可搜 |
| 大型文档 | 文件名以单个 `_` 开头（`exclude=^_[^_].*`） | 空串 `""`（正文不入切片，页内搜索结果走叠加层） | — | 清单标记 `no_cache`，不进 bundle | 可访问；全站检索只检题名 |
| 私有页 | 命中 `.gitignore`（约定以 `__` 开头） | 占位 `"localOnly"` | 全文（仅本地存在） | 不进清单，不进 DF | 目录挂 🔒，无法访问 |
| 私有媒体 | 命中 `.gitignore` | — | — | — | 目录挂 🔒 |

> `fat_data_*.json` 与 `core-bundle.json` 不含私有正文，`synonyms.js` 的词频统计也只来自公开语料。**但目录需要显示 🔒，所以私有页的标题、分类链、文件名、时间戳仍会出现在 `lite_data.js` 与 `cmt_mapper.json` 中**——被隔离的是内容，不是「它存在」这件事。

### 4.3 技术栈

| 层 | 选型 |
| :--- | :--- |
| **构建** | Windows Batch（`CLI.bat`）· PowerShell 5.1（`protocol_guard.ps1` / `pack_apply`）· Java 8（`gen.jar`：Jackson / Jsoup / SLF4J / Google API Client + OAuth + Tasks / Swing·AWT·ImageIO）· Rust（`wasm-pack`：`wasm-bindgen` / `js-sys` / `serde` / `serde_json` / `serde-wasm-bindgen` / `regex` / `lazy_static` / `similar`）· `esbuild` · `libwebp`（`cwebp` / `gif2webp`）· `certutil` · `static-web-server` |
| **运行** | ES Modules · Web Crypto API · Service Worker · Cache Storage · IndexedDB · Web Worker · WebAssembly · `BroadcastChannel` · `MessageChannel` · `CompressionStream` · CSS Custom Highlight API · `requestIdleCallback` |
| **同源内置的第三方** | PDF.js · Bibi（EPUB）· Prism · marked + DOMPurify + highlight.js（+ 本地编辑时按需 CodeMirror 5）· Photo Sphere Viewer + three.js · encoding.js · confetti |

### 4.4 第三方脚本与核心工具版本

| 组件 / 脚本 | 版本 | 位置 / 用途 | 安全与定制说明 |
| :--- | :--- | :--- | :--- |
| **three.min.js** | `version:7` | `src/third/photo-sphere-viewer/three.min.js`（配合 Photo Sphere Viewer） | `pano.html` 注入禁 `eval` CSP、严格校验 `?src=` 仅限同源 `/gallery/` 图片，并修复重复实例化 |
| **bibi** | `1.2.0` | `src/third/bibi/`（EPUB 阅读器） | 保持 `allow-scripts-in-content: false`、`trustworthy-origins: []`，关闭 `accept-local-file`/`bibizine`/`blob`/`base64` 入口；`epub.html` 对章节 iframe 二次去脚本并注入 `script-src 'none'` |
| **marked** | `v4.3.0` | `src/third/markdown/marked.min.js`（Markdown 解析） | 源码无 `eval`；由下游 `DOMPurify` 与页内 CSP 兜底 |
| **DOMPurify** | `3.5.0` | `src/third/markdown/purify.min.js`（Markdown HTML 净化） | `md_viewer.html` 收紧 `FORBID_TAGS`（禁用 `svg`/`math`/`template`/`iframe` 等）与 `ALLOW_UNKNOWN_PROTOCOLS: false` |
| **PDF.js** | `v6.5.438` | `src/third/pdfjs/` + `pdf-viewer.{js,css}`（PDF 阅读与批注） | 根治 CVE-2024-4367；保持零 `'unsafe-inline'` 最严 CSP、强制 `enableScripting: false`；开启涂鸦/文字/高亮/插图批注、支持 `--pdf-page-gap` 可调缝隙（默认 `0px`）与隐藏竖向滚动条 |
| **static-web-server.exe** | `v2.44.3` | `_build/server/`（本地 8000 / 仿真 9000） | 修复 CVE-2025-67487 / CVE-2026-27480；配合 `sws.toml` / `sws-sim.toml` 禁访 secret、堵 8.3 短名与大小写/尾点绕过，并下发全局禁 `eval` CSP 头 |

---

## 五、运行期架构

### 5.1 骨架：单页壳 + 双 iframe + 浮层

```text
index.html（壳）
 ├─ #side      iframe → side.html     目录树 · 已阅标记 · 顶部菜单 · 历史/收藏 · 悬停缩略图
 ├─ #content   iframe → 按 resource_type 装载视图（见下表）
 ├─ 浮层（挂在主控）   #search 搜索框与结果 · 中央预览 · 音乐播放器 · 评论 · 摘抄本 · 更新日志 · md_viewer · 触控板
 └─ 不可见的核心       index.js 主控 · worker.js 检索线程 · sw.js
```

`#content` 能装载的视图：

| 视图 | 载体 | 要点 |
| :--- | :--- | :--- |
| HTML 正文 | `html/*.html` + `content.js` | 源文件是 `<pre>` 纯文本，运行期由 Wasm `format_markdown` 渲染（标题、缩进着色、图片与链接、表格）；随后挂载目录、代码工具、版本 Diff、拼音与摘抄、评论、灯箱 |
| 书签首页 | `bookmark.html` + `bookmark.js` | 书签、壁纸、README 入口；拖拽编辑经协议回写 |
| PDF / EPUB / TXT | `pdf.html`（PDF.js v6 + `pdf-viewer.{js,css}`）/ `epub.html`（Bibi）/ `txt.html`（自研） | 统一经 `__DOC_SEARCH_BRIDGE__` 接入主站搜索；阅读进度与书签存 localStorage；PDF 支持涂鸦/文字批注与可调页间缝隙 |
| 图片 / 视频 | `lightbox-logic.js` 的 `renderLightboxFrame()` | 无模板文件：向 `about:blank` 的 iframe 写入纯静态 DOM + `script-src 'none'` 严格 CSP，所有事件由父模块直接绑定（零内联脚本） |
| 全景图 | `pano.html`（Photo Sphere Viewer） | `gallery/` 中 `pano_` 前缀图片双击进入 |
| 双语页 | HTML 页 + `bilingual.js` | 中英对照编辑、草稿暂存、一键固化；页面骨架取自 `src/tpl/bilingual.html`（与 `new.html` 同属复制进 `html/` 的页面模板，不是运行期视图） |
| 独立工具 | `txn_parser.html` · `go_board.html` · `street_view_uploader.html` | 由侧栏菜单以新标签页打开；`txn_parser` 被嵌入时还会主动跳出 iframe。`go_board` 与 `street_view_uploader` 未设 CSP `<meta>`，后者还依赖外部脚本（见 10.4） |

「反脱壳」：`html/` 正文页（`content.js`）与书签页（`bookmark.html`）被直接访问（`top === self`）时会跳回站点首页，保证这两类页面始终运行在壳之内；`txn_parser.html` 方向相反，被嵌入时会跳出 iframe；PDF / EPUB / TXT / 全景 / `md_viewer` 没有此跳转，`top === self` 在这些视图里只用于确定 BUS 上下文 ID。

### 5.2 三个通信面

| 通信面 | 载体 | 用途 | 约束 |
| :--- | :--- | :--- | :--- |
| **状态** | `SiteCore.createStore`：`sessionStorage` + `localStorage` 双路由 Proxy（值 JSON 化） | 持久偏好/历史/收藏/阅读进度走 `localStorage`；20 个每标签页状态（`resource_type`、`*_path`、`*list`、`last_html`、`keyword`、`lightbox_stauts`、`jump_from_search*` 等）自动路由至 `sessionStorage` | 多标签页并发浏览与热更新快照互不串扰；`protocol_name` 写入强制 scheme 白名单 |
| **事件** | `BroadcastChannel('bus')`，消息 `{type, payload, from, target, tabId}` | 主控 ↔ `#side` ↔ `#content` 的指令与通知（`RENDER_CATALOG`、`show_current`、`LOCAL_SEARCH_RESULT` …） | `target ∈ index \| side \| content \| *`；接收端丢弃非本标签页消息，仅 `SEARCH_CACHE_CLEARED` 允许跨标签页 |
| **直连** | `window.top.*` 句柄 | `sharedWasm`（页内高亮与 Diff 复用主线程 Wasm 实例）· `__DOC_SEARCH_BRIDGE__`（阅读器注册搜索 provider）· `VirtualCursor` · `pinyinData` | 仅限同源 iframe；用于需要同步返回值或共享大对象的场景 |

### 5.3 模块分层

| 层 | 文件 | 职责 | 加载时机 |
| :--- | :--- | :--- | :--- |
| 事实源核 | `site-core.js` | 零依赖全站单一事实源（兼容 Window / iframe / SW）：统一维护 `MainDB` v3 Schema、每标签页 `sessionStorage` 路由、`createStore` Proxy、`protocol_name` 与音频路径白名单校验 | 首屏（在 SW 安装熔断名单内） |
| 引导核 | `index.js` | 会话隔离与 BUS、首屏 `#__diff4x_key` 协议密钥吸收、IDB 代理、Wasm/Worker 引导、SW 注册与自愈、切片同步、懒加载路由、全屏/灯箱收口 | 首屏 |
| 底层原语 | `shared-utils.js` | 零依赖：`$`、窗口拖拽、媒体进度、半角/哈希、`CSS.highlights` 池、ADS 求值与区间合并、协议 Encrypt-then-MAC 封包 | 首屏（在 SW 安装熔断名单内） |
| 检索栈 | `search-engine.js` · `search-ui.js` · `search-preview.js` | 状态/缓存/命令/ADS 解析 · 输入/结果列表/过滤条 · 中央悬浮预览 | 首屏并行预热 |
| 按需协作者 | `comments.js` · `audio-player.js` · `snapshot.js` · `lightbox-logic.js` · `excerpts.js` · `book-db.js` | 评论同步、音乐播放、现场快照、图/视频灯箱、摘抄本、电子书缓存库 | 用到才 `import()` |
| 外围聚合 | `deferred-features.js` | 更新日志、彩带、`@bomb` / `@rebirth`、7 天备份提醒、全局书签、到期任务、拼音词库、闲时工具、`md_viewer` 浮窗 | 空闲期 / 交互触发 |
| 设备增强 | `touchpad.js` | 移动端虚拟触控板与虚拟光标（桌面端零下载） | 仅粗指针设备 |
| 检索线程 | `worker.js` + `synonyms.js` + Wasm | 调度、抢占、近义展开、全文索引与扫描 | 主控预热 |
| 视图脚本 | `side.js` · `content.js` · `bookmark.js` · `bilingual.js` · `txn_parser.js` · `pdf-viewer.js` · 其余阅读器脚本 | 各自 iframe 内的交互（`audio-player.js` 全面 DOM 构造、完整路径收藏去重、`favList` 白名单校验与无杂音首播） | 随页面 |
| 离线层 | `sw.js` + `core-list.js` | 缓存与更新 | 浏览器注册 |

依赖始终保持有向无环：`shared-utils.js` 在最底层，`deferred-features.js` 在最顶层，首屏不为外围功能付费。

### 5.4 启动序列

```text
index.html   成人确认 → 注入的 PARAM 常量 → index.js
  ├─ 立即执行   生成 TAB_ID · 建 BUS · VirtualCursor 占位 · 并行预热 (Wasm ‖ search-engine ‖ search-ui) · 挂 __DOC_SEARCH_BRIDGE__
  └─ onload
       ├─ 探测 ?repair=1；2 s 后探测远端修复指令
       ├─ 恢复侧栏比例 → 加载 #side → 注册 SW
       ├─ searchUI.init()
       ├─ loadScripts()                                         [90 s 看门狗]
       │    ├─ 预热 Worker · 预读 MainDB.chunks
       │    ├─ core-list.js →（本地）shadowIndex.js → lite_data.js → RENDER_CATALOG 渲染目录树
       │    ├─ 有现场快照 → snapshot.restoreSnap()；否则 → bookmark.html；随后展示搜索框
       │    └─ loadDataInBatches()：按哈希差分拉切片 → 全部成功才原子落盘 → BUILD_DATA   [45 s Wasm 看门狗]
       │         └─ Worker 建索引 → DATA_READY → 绑定缓存命名空间 · 媒体对账 · 更新彩带与日志
       └─ 空闲期    comments.js · deferred-features.js ·（触屏）touchpad.js
```

---

## 六、数据模型

| 产物 | 位置 | 形态 | 用途 |
| :--- | :--- | :--- | :--- |
| `lite_data.js` | `src/js/data/` | `window.LITE_DATA = { html / image / ebook / video / audio → 嵌套目录 → "_f": [[文件名, recordId, 类型, 标记], …] }`。HTML 标记为 `时间戳[-localOnly]`；媒体 recordId 恒为 `-1`，标记为 `"localOnly"` 或空 | 目录树、近期更新着色、完整性校验 |
| `fat_data_N.json` | `src/js/data/` | `{ recordId: 纯文本 \| "localOnly" \| "" }`，约 300 KB 一片 | 全文检索语料 |
| `shadow_data_N.json` + `shadowIndex.js` | 仅本地（`.gitignore`） | 私有页正文 | 本地融合检索 |
| `core-bundle.json` | `src/js/data/` | `{ webPath: 文件内容 }`：公开 HTML + `coreFiles` 中的 html/css/json/md + README | SW 首装 / 大更新时一次请求取回大批小文件 |
| `core-list.js` | `src/js/` | `BUILD_VERSION` + `FILE_MANIFEST` + `window.dataIndex`；清单按目录分组紧凑编码 `目录\|名:CRC32:来源*…`，来源 `0` 独立文件 / `1` 来自 bundle / `2` no_cache | SW 差分依据；运行期判断切片是否过期 |
| `synonyms.js` | `src/js/` | 词林 + DF 分桶 + 现代词覆盖（v5.1） | Worker 内近义扩展 |
| `cmt_mapper.json` | `src/` | `records: [{id, title}]` + `orphanIds` | 评论与页面绑定；其 `id` 同时用作检索的 recordId |

**运行期内存形态**：全文常驻 Worker 内的 Wasm；主线程只持有扁平的轻量数组 `window.data`（每 4 项一条：标题、占位、路径、类型），正文永不进入主线程。`recordId` 经由标题与 `cmt_mapper.json` 绑定，页面标题（`<title>`）变更即视为新页面，文件名不参与绑定。

---

## 七、搜索子系统

### 7.1 分层

```text
search-ui.js        输入（IME 保护、防抖）· 结果列表 · #sf-bar 过滤与作用域切换
     ▼
search-engine.js    命令识别 · 结果缓存 · ADS 语法解析 · 近义 / 评论 / 页内叠加 · 书内桥
     ▼  postMessage（携带 token 与命名空间 ns）
worker.js           抢占调度（8 ms 时间片）· 数据与评论的代际重扫
     ▼
Wasm（lib.rs）      Bloom 预筛 · DocFilter · 单遍扫描 · 评分 · 布尔求值 · 摘要
     ◄─ synonyms.js 近义展开（同在 Worker 内）
```

### 7.2 一次全站搜索

1. 输入 → IME 组词期间暂停 → 防抖 → `++_searchToken`。
2. 查结果缓存（内存 LRU → IDB LRU；键 = `n{噪值}|l{近义}|归一化关键词`）：精确命中直接渲染；前缀命中先给临时结果，同时继续精确扫描。
3. 未命中则交给 Worker：`bumpToken` 抢占旧任务 → 展开近义 → `prepare_search` 编译扫描计划，并用全局 Bloom 预筛（零命中直接短路）→ 以 8 ms 为时间片分片扫描全库，每片经 `MessageChannel` 让出事件队列，token 变更即丢弃。
4. 评论索引同样分片扫描，与正文结果融合，命中评论的条目标注 `[💬 N]`。
5. 返回后主线程核对 `token` 与 `ns` 才渲染；命中数 ≤ 300 的结果写入缓存。
6. 叠加层：当前页置顶；单 `_` 大文档不在切片中，由 `content.js` 页内补算（`LOCAL_SEARCH_COUNT`）；`#sf-bar` 按类型 / 年月过滤。
7. 悬停条目 → 摘要请求 → 中央预览窗展示带高亮的上下文并自动滚动。

### 7.3 五种形态

| 形态 | 触发 | 与普通检索的差异 |
| :--- | :--- | :--- |
| 全站普通 | 直接输入 | 缓存 + Worker 全库扫描 + 评论融合 |
| 布尔组合 | `@[表达式]词[噪近]…` | 前端解析为带逐词参数的计划，Worker 求值，不走结果缓存 |
| 书内 | 打开 TXT / PDF / EPUB 自动切入 | 阅读器注册 provider，按章节 / 页段 / DOM 块粒度检索，结果存入 BookDB |
| 页内 | 从全站搜索跳入 HTML 页 | `content.js` 复用主线程 Wasm 计算页内全部命中，分层高亮并生成右侧导航 |
| 命令 | `@bomb` / `@rebirth` | 不检索，转交 `deferred-features.js` |

**书内检索协议**：阅读器就绪后调用 `top.__DOC_SEARCH_BRIDGE__.register(provider)`，引擎随即把作用域切到书内，`#sf-bar` 出现「本书 / 全站」切换钮；provider 实现 `runSearch` / `runAdsSearch`。

| 阅读器 | 分片与聚合 | 高亮 |
| :--- | :--- | :--- |
| TXT | 按换行切成约 3.6 万字符的 DOM 块；按章节标题或每 1.8 万字分段聚合 | `CSS.highlights` 无损着色 |
| PDF | 打开即在 `requestIdleCallback` 中静默提取文本，搜索时自动提速；按大纲章节或固定页段聚合 | 仅对已渲染页的透明文字层着色，缩放 / 滚动时增量补绘 |
| EPUB | 抽取各章 iframe 正文（跳过注音），按 TOC 最细叶子节点聚合 | 各章 `contentWindow.CSS.highlights` 独立注册 |

开启近义时，Worker 跳过 HTML 语料的 Bloom 裁剪（`cacheTag='raw'`），避免书内独有的近义词被误杀。

### 7.4 评论与页内联动

* **评论同步（`comments.js`）**：启动先从 `MainDB.sys_state` 读本地快照推给 Worker（`SET_COMMENTS`），之后定时及切回可见时拉取 `{data_repo}` 仓库的 `comments.json`；有新评论则更新快照、重建 `COMMENT_BLOOM`、刷新当前结果的评论叠加层，并按偏好弹出 What's new。
* **页内高亮（`content.js`）**：复用 `sharedWasm.find_content_matches_multi` 与同一份近义展开，进入 Diff 视图时自动清除搜索并屏蔽高亮刷新，避免二者冲突。

### 7.5 缓存的四重失效

| 触发 | 机制 |
| :--- | :--- |
| 核心切片或算法变更 | `DATA_READY` 后绑定命名空间 `core` = `v{SEARCH_ALGO_VER}\|d:{数据指纹}`，不匹配即清库并广播 `SEARCH_CACHE_CLEARED` |
| 同义词库变更 | `SYNONYMS_READY` 后绑定命名空间 `syn`，不匹配即清库并重搜 |
| `synonyms.js` / Wasm 变更 | SW 安装时写入 `pending_search_cache_clear` 标记，`activate` 阶段同步清库 |
| 切片增量更新 | 仅当本轮全部变更切片都拉取成功才原子落盘并清缓存，任一失败则整轮跳过 |

---

## 八、离线、更新与自愈

### 8.1 两个缓存桶

| 桶 | 内容 | 生命周期 |
| :--- | :--- | :--- |
| `core-cache-{BUILD_VERSION}` | 壳、HTML、CSS、JS、Wasm、`synonyms.js`、README、`sw-manifest.json`（仅限清单内文件：未登记 `coreFiles` 的文件，如 `md_viewer.html`，SW 不做运行时缓存） | 随版本整桶更替；新 SW `activate` 时删除旧桶 |
| `media-cache` | gallery / video / audio / ebook、字体、PDF cmaps / `standard_fonts` / `iccs` / `wasm` / `images` | Cache-First，常驻；检测到文件被删才定向清理 |

### 8.2 安装：增量、分流、熔断

1. 取最新旧桶中的 `sw-manifest.json` 作为 `oldManifest`，向窗口广播 `SW_UPDATE_STATUS`。
2. 逐项对账 `FILE_MANIFEST`（排除 `fat_data_*` 与 `no_cache`）：哈希未变 → 从旧桶直接拷贝；变更 → 按来源归入「bundle 批」或「独立批」。
3. **bundle 批**：首装或变更超过 15 项 → 一次请求 `core-bundle.json`，在本地构造响应写入新桶；不超过 15 项 → 并入独立批逐个拉取。
4. **独立批**：并发拉取，并发度随网速取 4 / 2 / 1（4g / 3g 或文件数超过 21 / 2g），每个请求带 30 s 超时并对同 URL 合并。
5. **失败处置**：命中 `CRITICAL_URLS`（`/`、`index.html`、`site-core.js`、`index.js`、`shared-utils.js`、`book-db.js`、检索三件套、`snapshot.js`、`side.js`、`content.js`、`lite_data.js`、`worker.js`、Wasm）→ 抛错，整次安装中止，旧版继续服务；非关键文件 → 回退旧桶副本，清单仍记旧哈希，下次联网自动补齐。
6. 写入新桶的 `sw-manifest.json` → 进入 waiting。

### 8.3 请求拦截

| 请求 | 本地模式 | 线上模式（含 `9000` 仿真端口） |
| :--- | :--- | :--- |
| 通用 | Network-Only（`no-store`），仅断网时回退缓存 | 当前桶优先；URL 带 `?v=` 且与清单哈希不符时直连网络 |
| `core-list.js` | 同上 | **不走网络**：用 SW 内存里的 `FILE_MANIFEST` + `BUILD_VERSION` 合成响应；缺失则读 `sw-manifest.json` 并置 `_isOfflineDataFallback` |
| `site-core.js` / `worker.js` / `synonyms.js` / Wasm | 同上 | 严格取当前桶，未命中才联网并回填 |
| 媒体 / 字体 / cmaps | 同上 | `media-cache` Cache-First |

> 线上 `core-list.js` 由 SW 合成，是「版本不撕裂」的核心：新 SW 在 waiting 期间，刷新页面也不会拿到「旧代码 + 新清单」。

### 8.4 无感热更新

```text
updatefound → installed → waiting
  ├─ 本地：自动 SKIP_WAITING
  └─ 线上：#side 顶部提示「发现新版本」，用户确认后（按 TAB_ID 隔离）SKIP_WAITING
activate    删除旧桶 · 若有 pending_search_cache_clear 则清搜索缓存 · clients.claim()
controllerchange
  → takeSnapshot(true)   主屏类型与路径 · 音视频进度与模式 · 搜索词 → sessionStorage['ss_restore_strict'] → reload
  → restoreSnap()        先校验 lite_data 中目标是否仍存在（已删则销毁脏状态、退回书签页）
                         → 还原主屏 / 音视频 / 搜索框 → 播放彩带，弹出 What's new
```

### 8.5 更新的副产物

* **HTML 版本快照**：页面哈希变化时，旧版源码经 `CompressionStream('deflate-raw')` 压缩，存入 `MainDB.html_snapshots`（每页至多 10 版，按时间戳与压缩字节双重去重），即页内 Diff 的数据来源。
* **更新日志**：新增 / 更新 / 删除写入 `update_logs`，供 What's new 展示（正文/媒体记录点击在侧栏定位打开，`README.md` 记录点击直接在 `md_viewer` 浮窗打开）。
* **搜索缓存失效标记**：见 7.5。
* **书籍清理**：清单中消失的 `/ebook/*` 会定向清除 `media-cache` 与 BookDB 中对应条目。

### 8.6 降级与自愈

| 机制 | 触发 | 行为 |
| :--- | :--- | :--- |
| 离线降级 | 无网，或 `core-list.js` 缺失 | SW 用 `sw-manifest.json` 合成 `dataIndex`；主控跳过切片下载，直接用 `MainDB.chunks` 建索引 |
| 阶段看门狗 | `loadScripts` 90 s / Wasm 建索引 45 s | 超时只标错并询问「继续等待 / 修复」，**不自动删库**，慢网下不会误清本地快照与日志 |
| 自愈 ① 远端指令 | 主控 2 s 后绕缓存读取 `/sw.js` 中的 `repair_command_id` | 远端编号大于本地记录（且本地非 0）→ 自动自愈 |
| 自愈 ② URL | 访问 `/?repair=1` | 注销全部 SW · 清空 CacheStorage · 删除 `MainDB` 与 `BookDB` · 清快照 → 回首页；**保留**摘抄、已阅标记、草稿等用户数据 |
| 自愈 ③ 交互 | 搜索框输入 `@bomb` | 勾选要保留的数据模块：A「保留所选，清理其余」（导出 → 清库 → 回填 → 重载）/ B「导出所选，全部清理」/ C「全部清理」。清库前先关闭全部 IDB 句柄并将 iframe 置为 `about:blank` |

---

## 九、存储全表

| 介质 | 名称 | 内容 | 容量与淘汰 |
| :--- | :--- | :--- | :--- |
| Cache Storage | `core-cache-{ver}` | 站点壳与核心静态文件 | 整桶随版本更替 |
| Cache Storage | `media-cache` | 媒体、字体、PDF cmaps | 常驻；媒体被删时定向清理 |
| IndexedDB | `MainDB` v3 | `chunks`（fat 切片）· `update_logs` · `search_cache` · `sys_state`（缓存 LRU 索引、评论快照、媒体路径快照、待清标记）· `html_snapshots` | `search_cache` 至多 500 条 LRU，单次结果超 300 条不入库；`html_snapshots` 每页至多 10 版 |
| IndexedDB | `BookDB` v1 | `book_extracts`（PDF 全文提取与大纲）· `search_cache`（书内搜索结果） | 提取至多 30 本 / 32 MB（单本 12 MB）；结果至多 600 条 / 16 MB（单书 80 条、单条 512 KB）；超 4 KB 即 deflate；仅书被删时清理，常规更新不动 |
| IndexedDB | `ExcerptsDB` v1 | `books`：按书名 / HTML 归档的摘抄 | 单例连接 |
| IndexedDB | `SideDB` v1 | `marks`：侧栏已阅标记 | 单例连接，断线自动重连 |
| IndexedDB | `AlignDrafts` v1 | `draft_texts`：双语页编辑草稿 | 防抖暂存；固化前销毁 |
| localStorage | `store` | 布局、浏览历史、搜索历史（至多 100）、收藏、滚动位置、媒体进度（至多 500 条）、壁纸、筛选 / 噪值 / 近义偏好、PDF / EPUB / TXT 进度与书签、流水账本偏好与汇率缓存 | 定时 `lsAlert()` 巡检容量 |
| sessionStorage | `ss_restore_strict` + 20 个每标签页状态键 | 热更新 / `@bomb` / `@rebirth` 一次性现场快照，以及 `SiteCore` 隔离的每标签页当前路径、资源类型、搜索词与灯箱状态 | 随标签页生命周期销毁 |

---

## 十、双态一体与本地能力桥

### 10.1 双态

判据：`store.online_flag = isLocalEnv ? "0" : "1"`，其中 `isLocalEnv` 指 `localhost` / `127.0.0.1` / `file:` 且端口不是 `9000`。

| 能力 | 本地（`"0"`） | 线上（`"1"`） |
| :--- | :--- | :--- |
| 页面编辑（`edit` 调用 VS Code 并更新时间戳） | ✔ | ✘ |
| 双语对照编辑与固化 | ✔ | 控制面板隐藏 |
| Markdown 覆写（`md_viewer`） | ✔ | 只读预览 |
| 书签拖拽增删移 | ✔ | ✘ |
| 私有页影子检索 | ✔ 加载 `shadowIndex.js` 与影子切片 | ✘ 目录仅显示 🔒 |
| 到期任务提醒 | ✔ 轮询 `_build/secrets/upcoming_tasks.json`（由托盘进程写出） | ✘ |
| Service Worker | Network-Only，新版自动接管，探测 2 s | 强缓存，用户确认后接管，探测 10 s |

`CLI.bat [4]` 启动本地服务前会自动清理同端口旧进程、通过 `-Mode EnsureKey -Rotate` 轮换 32 字节会话主密钥（落盘至 `_build/secrets/protocol.key`），并以 `_build/server/sws.toml` 启动 `static-web-server`（黑名单式禁访：`_build/secrets/` 下的 `protocol.*`、`local.*`、`credentials.*`、`tokens`，以及 `_build/config.*`、`_build/server/`、`_build/jar/`、`_build/rs/`、`_build/backup/` 和 `_build` 顶层的 `*.bat` / `*.ps1` / `*.vbs` / `*.jar`，同时阻断 Windows 大小写、8.3 短名 `~1` 与尾点/尾空格归一化绕过；`secrets/` 下的 `txn.txt`、`upcoming_tasks.json` 因未命中规则而保持可读；另关闭隐藏文件与目录列表，并对所有响应下发 `nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: strict-origin-when-cross-origin` 与禁 `eval` 的 CSP 头——脚本源仅 `'self'`、`'unsafe-inline'`、`'wasm-unsafe-eval'` 和 `https://giscus.app`，并带 `frame-ancestors 'self'`）。`CLI.bat [8] simulation` 挂载 `sws-sim.toml` 整目录封禁 `_build/**` 与 `shadow*` 切片，在 `9000` 端口以隐身窗口验证线上行为。

本机私有路径（VS Code、JDK、KaTrain、截图与 Keep 目录等）已从 `config.properties` 剥离至 `_build/secrets/local.properties`（`.gitignore` 忽略，`CLI.bat` 与 `Config.java` 自动合并覆盖）。

### 10.2 本地能力桥：认证加密一次性信封协议

浏览器无权写本地文件，于是用一条闭环让静态页面也能回写：**页面将请求封入认证加密一次性信封 → 触发协议 → `protocol_guard.ps1` 先验签后解密并做业务白名单校验 → `CLI.bat` 落盘（`.tmp` 原子替换）→ 页面轮询确认 / 由 SW 感知变更后刷新**。

* **零 HTTP 暴露密钥分发**：`CLI.bat [4]` 打开 `http://localhost:<port>/#__diff4x_key=<64位hex>`（`#fragment` 不进 HTTP 请求与日志）；`index.js` 首屏同步吸收写入当前 Origin 专属 `localStorage['__diff4x_proto_key__']`，随即 `history.replaceState` 抹掉地址栏痕迹；`@bomb` Plan A 清理本地存储时自动保留该密钥。
* **Encrypt-then-MAC 一次性信封**：协议固定格式 `diff4x://env/v1.<base64url(packet)>`（路径位保留 Base64url 大小写，**彻底拒收所有明文 `diff4x://1{...` 请求**）。主密钥经域分离 SHA-256 派生 `K_enc` 与 `K_mac`；明文 JSON 内嵌 `v`、`act`、`p`、`ts`、`nonce`、`origin`，经 `AES-256-CBC` 加密后对 `[0x01]||IV||CT` 计算 `HMAC-SHA256`。
* **服务端强校验**：注册表直接调用 `protocol_guard.ps1 -Mode Launch "%1"`（绕过 `cmd` 二次解析），严格按序执行：常量时间验签 → AES 解密 → 真实 UTC 纪元时间窗（±30 s）→ Origin 白名单（仅 `http://localhost:<port>` / `http://127.0.0.1:<port>`）→ 跨进程 Mutex Nonce 去重（90 s 滑动窗防重放）→ 业务参数白/黑名单与仓库根落点检查；批处理仅接触动作编号与 base64，绝不向任何命令串拼接原文；拒收原因写入 `%TEMP%\diff4x_proto_reject.log`。
* **参数与存储细节**：信封 URL 上限 8192 字符，`nonce` 为 32 位 hex，记录于 `%TEMP%\diff4x_proto_nonces.txt`；允许的 Origin 端口取自 `config.properties` 的 `port`（`protocol_guard.ps1` 不读取 `local.properties`）；协议名取自 `github_page` 域名首段，浏览器端 `store.protocol_name` 经 scheme 白名单校验；`-Mode SelfTest` 覆盖加解密、验签、篡改、过期 / 未来时间戳、非法 Origin（线上站、`9000` 仿真、DNS Rebinding）、路径穿越、`javascript:` 链接与非法行号等用例。

| `n` | 路由 | 发起方 → 执行 | 回写确认 |
| :---: | :--- | :--- | :--- |
| `1` | `:case_edit` | `content.js` 的 `edit` → `Stamper` 覆写时间戳，并用 VS Code 打开源文件 | — |
| `2` | `:case_bookmark` | `bookmark.js` 拖拽 → 先封包成功再 `BookmarkManager` 增删移并更新 `#end_flag`（参数为 `块ID}标题}链接`，块ID 为 `del` 表示删除；标题缺省即等于链接时由 `CLI.bat` 交互补全；新增与移动的链接都置于目标块顶部） | 主控清缓存并重载书签页，直至 `linksHash` 变化（上限约 30 次） |
| `3` | `:case_explorer` | 侧栏 `root/`（无参）→ 资源管理器直接打开 `$Script:Root` 仓库根目录（公网 JS 不含本机路径） | — |
| `4` | `:run_menu` | 侧栏单击 `CLI.bat` → 呼出交互菜单 | — |
| `5` | `:case_overwrite` | `bilingual.js` 固化：克隆文档并剥离运行期注入节点 → 写剪贴板 → 先封包成功再销毁草稿 → PowerShell 读剪贴板以 UTF-8 带 BOM 覆写 `html/<title>.html`（`.tmp` 原子替换，写后清空剪贴板，不触发 `gen`） | 每 400 ms 拉取原页比对，内容变化或写入一致即仅刷新当前双语页自身；超时给出手动解锁 |
| `6` | `:run_gen` | 侧栏双击 `CLI.bat` → 静默全量构建 | — |
| `7` | `:case_jump_txn_file_line` | `txn_parser.js` 点击流水行 → `code -g txn.txt:<行>` | — |
| `8` | `:case_go` | 侧栏 `KaTrain` → 读取 `secrets/local.properties` 的 `katrain_dir` 经 `$env:KATRAIN_DIR` 启动 KaTrain | — |
| `9` | `:case_overwrite_md` | `md_viewer` Save / `Ctrl+S` → 校验 `.md` 后缀并拦截路径穿越 → UTF-8 无 BOM + `.tmp` 原子替换 | 前端轮询，确认磁盘内容一致 |

### 10.3 全站纵深防御（CSP 与反注入）

* **全站禁 `eval`**：`sws.toml` / `sws-sim.toml` 响应头与各 HTML 模板 `<meta>` 统一移除 `'unsafe-eval'`、精准放行 `'wasm-unsafe-eval'`；其中图片/视频灯箱达到 `script-src 'none'`，`pdf.html` 达到 `script-src 'self' 'wasm-unsafe-eval'; style-src 'self'`，`bilingual.html` 达到 `script-src 'self' 'wasm-unsafe-eval'`。例外：`go_board.html` 与 `street_view_uploader.html` 没有 CSP `<meta>`（见 10.4）。
* **多点反注入收口**：`pdf.html` 锁定 `enableScripting: false`；`epub.html` 对章节 iframe 剥离脚本并注入 `script-src 'none'`；`md_viewer.html` 收紧 `DOMPurify`；`pano.html` 强校验同源 `/gallery/`；`txt.html` 异常提示改用 `textContent`；`audio-player.js` 与 `@rebirth` 对 `favList` 执行路径白名单校验并全面 DOM 构造渲染。

另有一条**非协议**通道：`CLI.bat vpn-heartbeat-tray`（`gen.jar tray`）常驻托盘：每 10 s 以 GET 探测 `URL_TO_CHECK`（`config.properties`，当前为 `https://www.google.com`）并切换绿 / 红图标；同一进程内每 5 分钟（心跳显示断网时静默跳过）以只读权限拉取 Google Tasks，把到期日不晚于今后 7 天的任务（含已过期者）写入 `secrets/upcoming_tasks.json`，前端只读取该文件。首次授权经浏览器与本机 `8888` 回环端口完成，凭据位于 `secrets/credentials.json` 与 `secrets/tokens/`；凭据失效时自动清除并重新授权，两次弹窗授权至少间隔 4 小时。

### 10.4 外部网络请求清单

站点自身的脚本、样式与数据均为同源静态文件。本次审计在 `src/js/raw/`、`src/tpl/` 中检索到的跨源请求如下（`bookmark.html` 里的外链书签由用户点击跳转，不在此列）：

| 地址 | 用途 | 发起方 |
| :--- | :--- | :--- |
| `giscus.app`（`client.js` 与评论 iframe） | 评论嵌入 | 浏览器（`comments.js`） |
| `raw.githubusercontent.com/{data_repo}/main/comments.json` | 评论快照同步（定时及切回可见时） | 浏览器（`comments.js`） |
| `api.github.com/repos/diff4x/diff4x.github.io` | `bookmark` 页版权声明 `hover` 显示线上仓库体积 | 浏览器（`bookmark.js`） |
| `api.frankfurter.app`、`open.er-api.com` | `txn_parser` 汇率（缓存键 `fx_rates`） | 浏览器（`txn_parser.js`） |
| `cdn.tailwindcss.com`、`accounts.google.com/gsi/client`、`streetviewpublish.googleapis.com` | `street_view_uploader` 的样式、Google 登录与全景图发布 | 浏览器（该页自身） |
| `URL_TO_CHECK`、Google Tasks API | 托盘心跳与到期任务 | 本机 Java 进程 |

其中 `street_view_uploader.html` 是本次检索中唯一直接引入外部脚本的页面，且没有 CSP `<meta>`；`giscus.app` 的脚本由 `comments.js` 动态注入，并被 `sws.toml` 的 CSP 头放行。

---

## 十一、算法精粹

### 11.1 检索内核（`lib.rs` · `worker.js` · `search-engine.js`）

| 问题 | 方案 |
| :--- | :--- |
| 输入有错字、夹杂字 | **宽容噪值匹配**：相邻字符间允许夹杂的无关字数上限为 `min(noise, 词长>25 ? 0 : 词长/2)`；单个空白不计噪，换行与句末标点（`\n \r 。！？；!?;`）为不可跨越的硬边界 |
| 重叠命中谁算数 | **区间裁决**：原词、同义词、组合词区间重叠时，依次比较 `tier`（原词优先）→ `noise`（小者优先）→ `weight`（大者优先）→ 长度（长者优先） |
| 排序既要精确优先又要防堆叠 | **次线性饱和计分**：标题基准 5000（每噪 −500，同义封顶 4500），正文基准 100（每噪 −10，同义封顶 450）；同一文档的命中按分降序，第 `i` 次乘 `k/(k+i)`；另按文档内**最小精确噪值**追加保底分：0 噪 +10000、1 噪 +3000、2 噪 +2200、3 噪 +1500、4 噪 +900、其余 +500 |
| 全库扫描太慢 | **两级过滤 + 单遍扫描**：① 全局 bigram Bloom（语料 1 MB、评论 256 KB），在扫描前裁掉不可能命中的候选词与同义变体；② 每篇文档按字数分 4 档（≤64 / ≤512 / ≤4096 / >4096）自适应分配 unigram / bigram 位图（`DocFilter`）；③ 编译 `ScanPlan`（首字掩码 + 首字倒排表），剩 0 个候选整篇跳过，剩 1 个走快路径，多个则单遍线性扫描 |
| 布尔组合 | **手写递归下降 + NNF**：括号深度 ≤ 8、形参 ≤ 26；德摩根律把 `!` 下推到叶子；前端与 Wasm 双端校验 `adsHoldsOnEmpty`，拦截 `@[!a]` 这类在空文档上恒真的纯否定查询；Wasm 侧 `ads_optimize()` 将 `And` 子句按（非否定优先 → 噪值升序 → 词长降序）重排以尽早短路；先联合正文与评论求值，再仅用正文二次求值，判定是否 `viaComment` |
| 搜索不能卡界面 | **自适应时间片与抢占**：`MessageChannel` 让出队列（绕开 `setTimeout` 的 4 ms 钳位），目标 8 ms 一片，按实际耗时在 16 ~ 4096 篇之间伸缩；新请求到达立即 `bumpToken`，旧扫描在下个边界中止；扫描途中若数据或评论更新（`dataGen` / `commentGen` 递增）则自动重扫 |

### 11.2 近义词（`SynonymBuilder.java` → `synonyms.js` v5.1，运行于 Worker）

* **三路查词**：A 路整词直达（所有键经 `compactKey` 归一，含带空格的现代词组）；B 路独立词边界保护（命中 `#` / `@` 独立词或 `stopExpand` 技术词时禁止拆字扩出古典杂义）；C 路 DP 最优分词 + 词林树最近公共祖先（LCA）消歧，同句其余词的 5 级词林码作上下文，共享层级越深权重越大（同 5 级 ×1.85、同 4 级 ×1.45、同 2–3 级 ×1.18、同 1 级 ×1.08）。
* **语料 DF 软加权**：构建期仅对公开语料做正向最大匹配，统计 7 档 DF 后缀（`:1`..`:6` 与无后缀）；候选乘数 `DF_CAND_MULT = [0.62, 1.00, 1.12, 1.18, 1.00, 0.68, 0.38]`——中低频特征词抬高、全站高频泛词压低、公网未现词降权但保留入口；虚词大类 `K` / `L` 的义项权重再压至 ×0.22 / ×0.55。
* **隐私与防漂移**：DF 只来自公开语料；最终由 Worker 注入 `bloom_might_match`，滤掉当前语料（含本地私有影子与评论）中根本不存在的变体；所有同义扩展锁定 `maxNoise = 0`。

### 11.3 渲染与阅读

| 主题 | 方案 |
| :--- | :--- |
| **语义 LCS Diff**（`content.js` + `lib.rs`） | 历史快照与当前 `<pre>` 都渲染为标准化 Token 序列（`html_line` / `table_row` / `code_line`），交给 Rust `similar` 的 LCS 算法求最小编辑脚本；矩阵规模超过 2500 万格即熔断，防大文档 OOM；结果着色并生成 `#diff-minimap` |
| **无损分层高亮** | `CSS.highlights` 按 `tier（3 档）× noise（6 档）` 映射为 18 个全局 `Highlight`，各带不同优先级；只操作 `Range`、不改 DOM，因此不触发重排，也不干扰代码编辑、双语编辑与摘抄选区 |
| **TXT 编码判定**（`txt.html`） | BOM 精确识别 → 严格 UTF-8 解码 → 样本奇偶空字节占比判无 BOM 的 UTF-16 → 对比 `gb18030` 与 `big5`（综合 CJK 频次、中文标点、简繁特征字与乱码罚分）→ `encoding.js` 兜底 |
| **TXT 抗排版锚定与阻尼滚屏** | 用 `caretRangeFromPoint` 反查视口左上角的精确字符偏移并持久化；调字号、行高、栏宽或缩放窗口后二分定位回同一句话；垂直滚轮经 rAF 指数阻尼（`diff × 0.24`）转为横向滚动，触控板原生横滑保持 1:1 跟手 |

---

## 十二、不变量与踩坑清单

面向后续维护者与 AI Agent：改动前先对照。

1. **产物不手改**：`core-list.js`、`sw.js`、`synonyms.js`、`core-bundle.json`、压缩后的 JS/CSS 均由 `CLI.bat gen` 生成；`gen.jar` 先改写 `raw/core-list.js` 与 `raw/sw.js`，再由脚本压缩，直接改产物会被覆盖。
2. **新增需离线的静态文件**：必须登记到 `config.properties` 的 `coreFiles`，才会进入清单与 SW 预缓存。
3. **熔断名单要同步**：首屏必需的新模块要加入 `sw.js` 的 `CRITICAL_URLS`（拉取失败将中止整次安装）；非关键模块失败会自动回退旧版。
4. **主线程不持全文**：任何需要全文的逻辑走 Worker / Wasm；主线程只拿 `window.data` 的轻量视图。
5. **改评分或匹配语义必须递增 `SEARCH_ALGO_VER`**（当前为 11），否则用户本地的旧搜索缓存会给出过期结果。
6. **新增 BUS 消息默认不跨标签页**：必须携带并校验 `tabId`，仅 `SEARCH_CACHE_CLEARED` 例外。
7. **清库顺序**：先关闭 `MainDB` / `BookDB` / `ExcerptsDB` / `SideDB` 的所有句柄，并把 iframe 置为 `about:blank`，再删库，否则 `onblocked` 会死锁；清库期间 `_isBombing` 会屏蔽 `controllerchange` 触发的重载。
8. **隐私底线**：任何新增的公网产物都不得读取私有页正文或其词汇统计；同义词 DF 只来自公开语料；新增产物后，要把它加进 `assertNoPrivateLeak` 的检查范围。
9. **回写必须闭环**：本地写文件一律「`.tmp` 原子替换 + 前端轮询确认」，不假设协议调用一定成功。
10. **环境分支只认 `store.online_flag`**：不要在业务代码里另行判断 host 或端口。
11. **反脱壳的范围**：`content.js`（`html/` 正文页）与 `bookmark.html` 开头的 `top === self` 跳转保证这两类页面始终运行在壳内，不要移除；`txn_parser.html` 的跳出逻辑同理。PDF / EPUB / TXT / 全景 / `md_viewer` 没有此跳转，不要想当然地依赖它。
12. **切片版本一致性**：切片拉取要么全部成功再原子落盘，要么整轮放弃，不允许半新半旧。
13. **协议一律走认证加密信封，参数一律不可信**：前端调用本地协议必须统一经 `shared-utils.js` 的 `sealProtocolUrl` / `invokeProtocol`（禁止拼明文 `diff4x://1{...`）；新增动作须同步在 `protocol_guard.ps1` 加业务校验与 `SelfTest` 用例（改动后执行 `-Mode SelfTest`）；任何 URL 文本都不得拼进命令串。
14. **构建失败必须让调用方知道**：新增的构建步骤要抛异常而不是 `catch` 后继续；成功标记（如增量哈希表）只在步骤成功后写入；不要在 gen 里改写源文件。
15. **状态与 Schema 单一事实源**：`MainDB` Schema、每标签页 `sessionStorage` 键集合、`createStore` Proxy、以及 `protocol_name` / 音频路径白名单均由 `src/js/raw/site-core.js` 唯一定义，禁止在其他模块或 `sw.js` 抄写副本。
16. **本机私有路径不入库**：含用户名或本机盘符的路径一律写入 `_build/secrets/local.properties`（`.gitignore` 忽略且 `sws.toml` 禁访），不得写进 `config.properties`、`CLI.bat` 或任何公网 JS。
17. **新增视图模板要补 CSP 并决定是否离线**：`src/tpl/` 下新增的视图要写 `<meta>` CSP（不含 `'unsafe-eval'`）；需要离线可用的要登记到 `coreFiles`——SW 不会运行时缓存清单外的文件。

### 已知限制（截至 2026-11-24 审计；修复后请删除对应条目）

- `md_viewer.html` 未登记 `coreFiles`：首次未联网时 README 弹窗打不开（`README.md` 本身已预缓存）。
- `street_view_uploader.html` 引用的外部脚本不在 `sws.toml` 的 CSP 脚本源白名单内，经本地 `8000` / 仿真 `9000` 访问时按 CSP 规则会被浏览器拦截（未实测）；线上 GitHub Pages 不下发响应头，不受影响。
- `protocol_guard.ps1` 只读 `config.properties` 的 `port`：在 `local.properties` 中覆盖端口会让 Origin 校验失败。
- `webp` 的「回写 HTML 引用」拿 `exclude` 的原始正则文本去比对带 `.html` 的文件名，永远不会匹配，因此不会跳过被排除的页面。
- `sws.toml` 的黑名单未覆盖 `_build/pack_apply/`、`_build/synonyms/` 等目录（`sws-sim.toml` 整目录封禁，不受影响）。
- `pack_apply/presets.json` 中 Java 源码与 `lib.rs` 的预设路径与当前目录结构不符（实际为 `_build/jar/gen/src/main/java/` 与 `_build/rs/src/lib.rs`），这些预设勾选会找不到对应文件，需手动勾选。

---

## 十三、AI Agent 会话与协作

借助 AI Agent 做二次开发、算法调优或 Bug 修复时，按「最小必传集 + 按场景加传」提供上下文，避免无关大文件稀释注意力。

### 基础必传清单

| 文件路径 | 作用与必传原因 |
| :--- | :--- |
| `README.md` | 让 AI 一次性掌握全局约束（Java 8、零框架原生 ESM、公私隔离、模块拓扑、SW 与缓存协议、不变量清单） |
| `_build/rs/src/lib.rs` | 检索与渲染核心算法（噪值匹配、评分、DocFilter、Bloom、ADS 布尔求值、LCS Diff、`format_markdown`） |
| `src/js/raw/worker.js` | Worker 调度（8 ms 时间片、抢占取消、代际重扫、同义词与 Bloom 交互） |
| `src/js/raw/search-engine.js` | 主线程检索内核（IDB LRU 缓存、双命名空间失效、ADS 解析、书内桥接、高亮区间计算） |
| `src/js/raw/search-ui.js` | 搜索前端交互（防抖、联想、结果列表、折叠锚记、`#sf-bar` 筛选与作用域切换） |

### 按调优目标加传

> 下表中不带目录的 `*.java` 均位于 `_build/jar/gen/src/main/java/`。

| 目标 | 加传文件 |
| :--- | :--- |
| 近义词召回、消歧、新词扩充 | `SynonymBuilder.java` + `synonyms_custom.json` + `_build/synonyms/oov_report.txt`（无需上传生成后的 `synonyms.js` 与 `cilin.txt`） |
| HTML 页内高亮、Diff、双语固化 | `src/js/raw/content.js` + `src/js/raw/bilingual.js` + `src/js/raw/shared-utils.js` |
| 电子书书内搜索与阅读器 | `src/tpl/txt.html` / `pdf.html` / `epub.html` + `src/js/raw/pdf-viewer.js` + `src/css/raw/pdf-viewer.css` + `src/js/raw/index.js` + `src/js/raw/search-preview.js` + `src/js/raw/book-db.js` |
| Markdown 浮窗预览与本地固化 | `src/tpl/md_viewer.html` + `src/js/raw/deferred-features.js` + `_build/CLI.bat` |
| 评论融合搜索与同步 | `src/js/raw/comments.js` |
| SW 缓存、热更新快照、构建清单 | `src/js/raw/site-core.js` + `src/js/raw/index.js` + `src/js/raw/sw.js` + `src/js/raw/snapshot.js` + `Generator.java` + `_build/config.properties` |
| 构建链、安全配置与协议桥 | `_build/CLI.bat` + `_build/protocol_guard.ps1` + `_build/server/sws.toml` + `Gen.java` + `Generator.java` + `Config.java` + `_build/config.properties` |

### 压缩包收发与回填约定（配合 `_build/pack_apply/`）

本项目使用独立的 `_build/pack_apply/`（WinForms 三态目录树复选框工具）按仓库相对层级打包上传与一键解压回填，AI 交付代码改动时须严格遵守以下打包规范：

1. **输入包约定（上传给 AI 的 `.zip`）**
   - 包内所有文件路径均为**仓库根目录相对路径**（如 `src/js/raw/index.js`、`_build/CLI.bat`）。
   - 仅包含源码与必要配置。`pack_apply` 打包时硬拦截 `.git/`、`_build/secrets/`、`_build/backup/`、`node_modules/`、`_build/rs/target/`，并默认排除压缩产物（`src/js/*.js`、`src/css/*.css`、根目录 `sw.js`）、`shadow*` 切片、`html/__*.html`、`.map`、可执行文件 / `jar` / `wasm` / `zip` 以及常见图片、音视频、电子书与字体文件；成品落在 `_build/backup/ai_pack_YYYYMMDD_HHmmss.zip`。
   - `_build/pack_apply/presets.json` 内置 7 个场景预设（基础必传集、安全加固与协议桥全套、电子书阅读器、HTML 正文 / 高亮 / Diff / 双语、SW 缓存 / 热更新 / 构建清单、近义词构建与调优、全部前端源码）。

2. **输出包约定（AI 返回的补丁 `.zip`）**
   - **路径与仓库根对齐**：所有条目直接从仓库根相对路径起算（如 `src/js/raw/side.js`、`README.md`），**严禁套一层多余的顶层目录**（禁止 `patch/src/...` 或 `repo/src/...`）。
   - **只打增量文件**：压缩包内**仅放本次实际新增或修改的文件**，未改动的文件不要塞回包里。
   - **必须为完整文件**：包内每个文件都必须是可直接覆盖落盘的完整源码，**严禁使用 `// ... 其余代码省略` 或 diff 片段代替完整内容**。
   - **只改源码不改产物**：前端仅修改 `src/js/raw/*`、`src/css/raw/*`、`src/tpl/*`、`index.html` 等源文件，**不要**生成或覆盖 `src/js/*.js` 压缩产物、根目录 `sw.js`、`core-list.js`、`core-bundle.json`、`synonyms.js`（均由本地 `CLI.bat gen` 生成）。
   - **编码与换行**：`.bat` / `.cmd` 使用 UTF-8 无 BOM + CRLF；`.ps1` 使用 UTF-8 带 BOM + CRLF；其余文件保持原编码与换行风格。
   - **说明文档命名**：如需在包内附带说明或验证步骤，请命名为根目录 `PATCH_NOTES.md`、`APPLY_AND_VERIFY.md`、`README_PATCH.md` 或 `UPGRADE_*.md`（匹配 `presets.json` 的 `skipApplyDocRegex`，仅对根目录生效；回填工具会识别为说明文件并默认跳过，不污染仓库）。注意 `README.md` 不属于说明文件，会按普通文件覆盖。
   - **禁区与删除项**：禁止包含 `.git/` 内文件；如涉及删除旧文件、重命名文件、升级第三方库或需要手工执行 `CLI.bat gen` / 修改 `_build/secrets/local.properties`，必须在回复正文中单独列出清单（ZIP 覆盖无法执行删除操作）。

3. **回填端行为（`pack_apply` 的 Apply 页）**
   - 自动列出系统「下载」目录中最新的 `.zip`，也可浏览选择，或把 `.zip` 拖到窗口 / `pack_apply.bat`；逐条目标注 `[覆盖]` / `[新增]` / `[说明-默认跳过]` / `[敏感-需手动确认]` / `[拦截]`。
   - 防 Zip Slip 路径穿越；硬拦截 `.git/`；`_build/secrets/` 下的条目默认不选，需二次确认。
   - 覆盖前默认按相对层级备份到 `_build/backup/ai_apply_YYYYMMDD_HHmmss/`（含回滚清单），可用「从备份回滚」还原被覆盖文件并清理当时新增的文件；回填时自动守卫 `.bat` / `.ps1` 的编码与 CRLF。


### 高效提问与 Badcase 复现格式

```text
【查词】: `xxx` （噪值: 5 / 近义: 开启 / 范围: 全站或书内）
【现状】: 当前排名第 1 的是《页面 A》，期望结果《页面 B》排在第 12 位（或未召回）。
【期望】: 请结合 lib.rs 与 search-engine.js 分析匹配与评分原因，并给出最小改动方案。

如果是先讨论、后打包的两步协作，首轮只需说「按仓库根目录相对层级打包的 zip，先解压分析某某问题」，等确认方案再回「按原相对层级打增量完整文件 zip」
```

