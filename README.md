# [diff4x's digital swamp](https://github.com/diff4x/diff4x.github.io)
> <img src="https://avatars.githubusercontent.com/u/222525381?v=4" width="100">
> 本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航

---
# 🔰 使用说明 (浏览)
## 搜索
- 出入口
  - 按 `\` 将焦点定位到搜索框
  - 按需切换 `搜全站` 或 `搜本书` (pdf、txt、epub)
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
    - 例如查找 2026 年 10 月创建或更新过的内容，可输入 `202610`或更短的 `2610`
  - `筛选` 子项统计了所有结果条目的文件格式
    - `年月` 是针对 HTML 结果条目的进一步统计
- 容错
  - 噪值：搜索词相邻字符之间允许夹杂的无关字数上限（空白不计）
    - 上限随搜索词长度动态缩放，算法为 `min(noise, KW_LEN>25 ? 0 : KW_LEN/2)`
      - 以噪 `3` 为例：
        - | 搜索词长 | 1 | 2–3 | 4–5 | 6–25 | ≥ 26 |
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
- 代码编辑：双击 `code` 代码区域，进入临时编辑模式
- 线上评论：`html` 页面左上角点按评论气泡，登录 GitHub 账号参与评论
- 拼音与摘抄：`html`、`pdf`、`epub`、`txt` 页面中，选中单字提示拼音，选中多字提示摘抄
- 全屏浏览：`gallery`、`video`、`pdf`、`txt` 下 `鼠标中击` 进入全屏
- 壁纸收集：`gallery` 中 `As wallpaper`将图片加入壁纸列表，在 Bookmark 页面右下角集中管理

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
| `What's new?` | 站点的更新记录与最新评论 |
| `History` | 浏览历史 |
| `Fav` | 音乐收藏夹 |
| `Excerpts` | 摘抄薄 |
| `go_board` | 打开网页棋盘 |
| `street_view_uploader` | google 全景图上传 |
| `txn_parser` | 解析当前流水 |

## 播放器
- 音频：允许 `fav` 标记和常规循环，左上角 `🎵` 单击显隐双击销毁
- 视频：允许外挂字幕与延迟微调
- 图片灯箱：支持拖拽与滚轮缩放
- 全景图：`gallery` 中文件名以 `pano_` 为前缀的图片，双击进入沉浸式浏览

## 移动端虚拟触控板
| 控件 | 功能 |
| :--- | :--- |
| `光标映射区` | 镜头与视角跟随 |
| `▲` / `▼` | 上下滚动搜索结果列表或内文目录 |
| `+` / `-` | 缩放页面视图 |
| `框选` | 启用后 (按钮高亮) 滑动选中文字，停用后弹出拼音或摘抄按钮 |
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
| `gen` | **核心构建**：扫描各资源目录和 `html/` 正文生成数据切片，更新文件哈希账本 |
| `new` | **创建新页**：交互式指定标题与分类链代入固定 HTML 模板；分类链中的子分类以 `\|` 分隔 |
| `keep2html` | **笔记转换**：将 google keep 已归档的笔记转换为 HTML 文件 |
| `webp` | **图片压缩**：将配置的截图目录下的图片转为 `webp` 格式落盘至 `gallery/img/`，自动复制文件名到剪贴板 |
| `static-web-server` | **本地运维**：启用本地虚拟服务器（8000，error），在常规窗口中打开站点首页 |
| `simulation` | **线上仿真**：启用本地虚拟服务器（9000，info），在隐身窗口中打开站点首页 |
| `push` | **提交与发布**：`git push` |
| `registering-protocol` | **一次性协议注册** |
| `vpn-heartbeat-tray` | **后台服务**：任务栏常驻网络状态标识，轮询 Google Tasks API，附带 Windows 系统工具入口 |

## 内容栏
- `html` 页面左上角点按 `edit` 调用本地 `VS Code` 编辑实体文件，自动覆写时间戳
- `html` 页面右上角点双击标题重载内容栏
- 左单击 `bookmark` 页面中的 `README` 弹出 markdown 浏览器加载站点手册，即时编辑和固化
  - 中击跳转到本项目的线上 github 仓库
- 可向 `bookmark` 中拖入外部链接，或内部拖动链接进行书签的增删移，这些操作是即时固化的
- `bookmark` 之下的版权声明 `hover` 显示当前线上仓库体积
- 双语页面下的译文对齐操作支持一键固化

## 侧边栏
- 顶部菜单：
| 选项 | 说明 |
| :--- | :--- |
| `CLI.bat` | 单击选择操作，双击直接构建 |
| `root/` | 打开本地仓库根目录 |
| `Katrain` | 启动本地 Katrain |
| `txn_parser` | 解析当前流水 |

## 预设规则
- HTML
  - **正文**：直接写在 `<pre>` 标签内，无需 `<br>`
  - **标题**：行首 N 个 `#` 加空格，自动转换为 `<h{N}>` 参与目录生成
  - **层级缩进**：行首使用 4 的倍数个空格（`4`、`8`、`12`、`16`）缩进时自动进行块级着色
  - **链接**：相对路径或完整 `URL` 自动解析包裹为 `<img>` 或 `<a>`
  - **表格**：写在 `<p>` 标签中，以 `|` 分列，自动渲染为 `<table><td>`
  - **代码块着色**：使用 `<code c>` 格式，其中 `c` 表示目标渲染语言
  - **配图**：`gallery/img` 默认作为 HTML 页面同级引用源

- 文件命名
  - **大型文档**（`_` 前缀）：文件名仅以 1 个 `_` 开头的 HTML 文件（如 `_huge_doc.html`）。正文不参与索引切片制作，但在该页面内进行的搜索结果可被持久化
  - **私人页面**（`__` 前缀）：文件名以 2 个 `_` 开头的 HTML 文件（如 `__private.html`）。正文参与切片制作，但不参与线上发布，仅可在线下本地搜索与访问
  - **全景图片**（`pano_` 前缀）：`gallery/` 目录中以 `pano_` 为前缀的图片，自动识别为全景图

- keep2html
  - keep 笔记正文中的 `[[IMG序号]]` 占位标记，决定生成的 HTML 页面中相应位置引用的图片序号
  - **单篇转换**：笔记需包含两个标签，其中一个固定为 `single`，另一个作为生成的 HTML 分类；笔记标题作为 HTML 的 `title`
  - **多合一转换**：笔记需包含共同的标签名，此标签名作为 HTML 的 `title`，原单篇笔记的标题作为 `<h1>` ，分类名在 CLI 中交互指定
  
## 同义词维护
- 文件职责
  - `cilin.txt` ：保持只读，补丁外置
  - `synonyms_custom.json` ：主要维护区，现代双向词组、单向别名、技术词停扩与词林清洗规则
  - `oov_report.txt` ：本地新词雷达，定期挑出未来搜索会用到、且存在中英文或同义表达的高频词，补充到 `synonyms_custom.json` 的 `groups` 或 `aliases` 中

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
  - `stopExpand`（全局停扩黑名单）：列出的现代技术词禁止从词林 `=` 行扩展，防止语义漂移
  - `dropEqCodes`（词林整行降级）：将指定的 7 位编码行由 `=` 降级为 `@`（停止扩展，但保留词表）
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

- 分桶权重表 (N：公开 HTML 总数)
| 标记 | 条件 | 候选词乘数 | 义项消歧贡献 | 含义说明 |
| :--- | :--- | :---: | :---: | :--- |
| 无后缀 | `DF = 0` | 0.62 | +0.00 | 公网未出现词（降低权重，保留入口） |
| `:1` | `DF = 1` | 1.00 | +0.25 | 孤篇专词或媒体标题词 |
| `:2` | `2 ≤ DF ≤ 3` | 1.12 | +0.45 | 低频高区分度活词 |
| `:3` | `DF ≥ 4` 且 `DF / N ≤ 8%` | 1.18 | +0.60 | 黄金主题词（权重最高） |
| `:4` | `8% < DF / N ≤ 20%` | 1.00 | +0.35 | 常见实词 |
| `:5` | `20% < DF / N ≤ 40%` | 0.68 | +0.10 | 偏泛通用词（轻度降权） |
| `:6` | `DF / N > 40%` | 0.38 | +0.00 | 全站高频泛滥词（强降权抑噪） |
---

# 💻 设计说明 (开发)

> **初代** by diff4x | **进化** by Gemini & ChatGPT & Claude & Grok

---

## 核心思想

在**零后端、纯静态托管（GitHub Pages）**的前提下，以静态文件为唯一事实源，将索引构建留在构建期，将检索、渲染、版本比对、标注与持久化全部前移至浏览器运行期，打造可本地读写、可离线使用的个人知识库：

* **超级浏览**：统一承载 HTML、PDF、EPUB、TXT、Markdown、图片、音视频与全景图。
* **超级检索**：全站与书内共用 Rust/Wasm 宽容模糊 + 同义语义检索，全站额外支持布尔组合与评论融合检索。
* **双态一体**：同一套前端代码按运行环境自动切态——本地（`localhost:8000`）开放编辑、双语固化、Markdown 覆写、书签拖拽、私密影子检索、任务提醒与 `CLI.bat` 协议联动；线上（GitHub Pages / `9000` 仿真端口）只读、私有条目挂锁、启用 Giscus 评论同步与 Service Worker 离线强缓存。
* **零框架低依赖**：不依赖前端框架与 npm 构建链，运行层为原生 ESM + Rust/Wasm + 浏览器原生 API，第三方库均以同源静态文件内置于 `src/third/`，降低长期维护与迁移成本。
* **公私硬隔离**：私有页面（`__` 前缀）与 `.gitignore` 命中的媒体在构建期严格分流，所有公网产物（`fat_data_*.json`、`synonyms.js` 的 DF 统计、`core-bundle.json`）均不含私有正文或词汇指纹。

---

## 目录结构

```text
📂 _build
 ┣ 📂 esbuild | libwebp                # JS/CSS 压缩与 WebP 转码
 ┣ 📂 server                           # 本地静态服务器 (static-web-server)
 ┣ 📂 jar                              # Java 8 构建器源码与 gen.jar
 ┣ 📂 rs                               # Rust/Wasm 检索引擎源码 (lib.rs)
 ┣ 📂 secrets                          # 本地凭据、到期任务与账单流水 (.gitignore)
 ┣ 📂 synonyms                         # cilin.txt / synonyms_custom.json / oov_report.txt
 ┣ 📂 woff2_split                      # 字体分片
 ┣ 📜 CLI.bat                          # 统一构建菜单与自定义 URL 协议入口
 ┗ 📜 config.properties                # 全局路径、参数与 SW 强缓存名单配置
📂 audio | ebook | gallery | video     # 多层级媒体目录 (遵循物理目录树)
📂 html                                # 单层级 HTML 正文目录 (遵循预设规则)
📂 src
 ┣ 📂 css | js                         # raw/ 源码、压缩产物、map/ SourceMap、data/ 切片
 ┣ 📂 third                            # 同源第三方库 (bibi / pdfjs / prism / markdown / psv / other)
 ┣ 📂 wasm                             # Wasm 编译产物及胶水代码
 ┣ 📂 tpl                              # 视图模板 (side / bookmark / txt / pdf / epub / md_viewer / ...)
 ┗ 📜 cmt_mapper.json                  # Giscus 评论 ID 与页面 title 映射表
📜 .gitignore                          # 私有节点与本地影子数据清单
📜 index.html                          # 单页应用主控 Shell
📜 README.md                           # 站点手册 (构建期由 config.properties 注入路径)
📜 sw.js                               # Service Worker 缓存路由、快照存档与自愈指令载体
```

---

## 技术选型与模块拓扑

### 技术栈

| 维度 | 选型与职责 |
| :--- | :--- |
| **构建侧** | Windows Batch（`CLI.bat`）、Java 8（`gen.jar`：Jackson / Jsoup / SLF4J）、Rust（`wasm-pack`：`wasm-bindgen` / `serde` / `regex` / `similar`）、`esbuild`、`libwebp`、`certutil`（SHA-256 增量校验）、`static-web-server` |
| **运行侧** | ES Modules、`Service Worker`、`Cache Storage`、`IndexedDB`、`Web Worker`、`WebAssembly`、`BroadcastChannel`、`MessageChannel`、`CompressionStream / DecompressionStream`、`CSS Custom Highlight API`、`Shadow DOM`、`ResizeObserver`、`IntersectionObserver` |
| **前端分层** | `iframe` 双栏壳（`#side` 目录树 + `#content` 视图）+ 主控 `index.js` 协调核心模块（`shared-utils`、`search-engine`、`search-preview`、`search-ui`、`comments`、`audio-player`、`snapshot`）+ 闲时/按需懒加载块（`deferred-features`、`excerpts`、`lightbox-logic`、`touchpad`） |

### 模块依赖拓扑

```text
                        ┌──────────────────────────────────────────────┐
                        │               构建期 (_build/)                │
                        │  CLI.bat ──► certutil SHA256 + esbuild 压缩   │
                        │          ──► gen.jar (Generator +             │
                        │               SynonymBuilder v5.1 +           │
                        │               BookmarkManager)                │
                        │  rs/lib.rs ──► wasm-pack ──► src/wasm/*.wasm  │
                        └──────────────────────┬───────────────────────┘
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              浏览器运行期 (PWA)                               │
│                                                                              │
│  ┌────────────────────┐      CacheStorage (core-cache-{ver} / media-cache)   │
│  │   sw.js (SW 线程)   │◄────────────────────────────────────────────────┐   │
│  └─────────┬──────────┘      MainDB (html_snapshots / update_logs / sys) │   │
│            │ 线上对齐 core-list.js / 本地直连 no-store                     │   │
│            ▼                                                             │   │
│  ┌────────────────────────────────────────────────────────────────────┐  │   │
│  │ index.html / index.js (主控 Shell, 持 TAB_ID 与 __DOC_SEARCH_BRIDGE__)│   │
│  │  ├─ 底层原语 (零依赖): shared-utils.js                              │  │   │
│  │  ├─ 检索栈: search-engine.js ◄──► search-ui.js ──► search-preview.js│  │   │
│  │  ├─ 协作者: comments.js / audio-player.js / snapshot.js             │  │   │
│  │  ├─ 懒加载: deferred-features.js (含 md_viewer 浮窗) / excerpts.js / │  │   │
│  │  │          lightbox-logic.js / touchpad.js                        │  │   │
│  │  ├─ BroadcastChannel('bus') ◄───► #side (side.js + SideDB)         │  │   │
│  │  ├─ BroadcastChannel('bus') ◄───► #content:                        │  │   │
│  │  │    ├─ html/* (content.js / bilingual.js + AlignDrafts)          │  │   │
│  │  │    ├─ bookmark.html (bookmark.js) ──► md_viewer.html (弹窗)      │  │   │
│  │  │    ├─ txt.html / pdf.html / epub.html (经 __DOC_SEARCH_BRIDGE__) │  │   │
│  │  │    └─ txn_parser / pano / go_board / lightbox-logic             │  │   │
│  │  └─ Worker (worker.js)                                             │  │   │
│  │       ├─ Wasm (lib.rs): IndexedDoc + DocFilter + Bloom + ADS + LCS │  │   │
│  │       └─ synonyms.js (v5.1): Cilin + DF 软加权 + DP + LCA          │  │   │
│  └────────────────────────────────────────────────────────────────────┘  │   │
└──────────────────────────────────────────────────────────────────────────────┘
```

* **`shared-utils.js` 与 `deferred-features.js` 的严格分层**：前者位于依赖图最底层（零外部依赖、入 `CRITICAL_URLS` 安装熔断名单），提供 `$`、`makeDraggable`、`mediaPos*`、`CSS.highlights` 池等全站原语；后者位于最顶层（仅在空闲期或交互触发时动态 `import()`），聚合更新日志、彩带、`@bomb`/`@rebirth`、7 天备份、全局书签、到期任务与 `openMdViewer()`，确保依赖图为严格有向无环图（DAG），首屏零冗余下载。

---

## 数据分层与存储模型

```text
[物理源文件] (html/, gallery/, video/, audio/, ebook/, README.md)
    │
    ├──► 清洗与切片 (gen.jar)
    │     ├──► 公开非排除 HTML 正文 ───► fat_data_*.json (按 sliceSize 分片)
    │     ├──► 私密 HTML (__前缀) ─────► shadow_data_*.json + shadowIndex.js (.gitignore)
    │     ├──► 全站目录与状态标记 ─────► lite_data.js
    │     ├──► 首屏 HTML/CSS/JSON/MD ──► core-bundle.json
    │     └──► 全站静态文件 CRC32 ─────► core-list.js + sw.js (SW_VERSION)
    │
    └──► 浏览器运行时内存 (Worker Wasm 全文 + 主线程 slim 视图 window.data)
          ├── 标题: HTML 剔除 .html / 媒体保留物理全名 (Wasm 索引层去后缀防污染)
          ├── 正文: 主线程仅留占位标记 (html 为 "" 或 "localOnly")，全文常驻 Worker Wasm
          ├── 路径: HTML 为 html/xxx.html，媒体为相对路径
          └── 类型: "html" | "image" | "ebook" | "video" | "audio"
```

* **轻数据**（`lite_data.js`）：HTML 条目 `[fileName, recordId, "html", "timestamp[-localOnly]"]`；媒体条目 `[fileName, -1, type, "localOnly"|""]`。
* **胖数据与影子数据**：`fat_data_*.json` 映射 `recordId -> cleanText | "localOnly" | ""`（单 `_` 超大文档写空串，页内搜索结果走叠加层）；`shadow_data_*.json` 仅本地存在，保存 `__` 私密正文供离线融合检索。
* **哈希账本**（`core-list.js`）：采用目录分组紧凑编码 `目录|文件1:CRC32:srcFlag*文件2:CRC32:srcFlag;...`（`0=standalone`、`1=core-bundle.json`、`2=no_cache`），同时暴露 `window.dataIndex`。
* **评论映射**（`cmt_mapper.json`）：`records` 绑定页面 `title` 与 Giscus 讨论 ID，`orphanIds` 追踪已删页面的孤立评论。

---

## CLI 构建与自定义协议时序

### `CLI.bat [0] gen` 增量构建时序

```text
CLI.bat :run_gen
  ├─ Phase 1: 源码增量压缩 (SHA-256)
  │    ├─ 遍历 src/js/raw/*.js (跳过 core-list.js / sw.js / synonyms.js)
  │    │    └─ certutil -hashfile SHA256 比对 modtime_list.txt + 产物存在性
  │    │         └─ 变更项 → esbuild --minify --target=es2020 --sourcemap → src/js/ + 重写 sourceMappingURL 到 src/map/
  │    ├─ 遍历 src/css/raw/*.css → 同理增量压缩至 src/css/
  │    └─ 压缩 font.css → src/css/font.css
  │
  ├─ Phase 2: 数据清洗、同义词与清单生成 (java -jar jar\gen.jar gen)
  │    ├─ 1. injectScriptToIndexHtml(): 将 github_page / giscus / update_interval / readme_md 注入 index.html PARAM 块
  │    ├─ 2. parseGitIgnore(): 编译私密路径正则
  │    ├─ 3. processHtmlFilesAndImages():
  │    │       ├─ 清理正文失效图片引用，输出 gallery/img/idle-list.txt
  │    │       ├─ 剥离 Markdown 标题符号生成 cleanText，分流 fatDataMap / shadowDataMap / publicDocsForDf
  │    │       └─ 更新 src/cmt_mapper.json (records & orphanIds)
  │    ├─ 4. scanAllMedias(): 递归扫描 gallery/audio/video/ebook (继承父目录 localOnly 标记)
  │    ├─ 5. generateLiteAndFatData() + generateShadowData(): 生成切片与目录树
  │    ├─ 6. SynonymBuilder.buildIfNeeded(publicDocsForDf, liteDataTree):
  │    │       ├─ 仅用公开非排除 HTML + 公开媒体名做全词表 FMM，统计 7 档 DF (:1..:6)
  │    │       ├─ 应用 synonyms_custom.json 清洗与独占剥离，刷新本地 oov_report.txt
  │    │       └─ 校验 synonyms.sha256 (rawSha|outSha) → 仅变更时调 esbuild (不加 --bundle) 输出 src/js/synonyms.js
  │    ├─ 7. generateManifest():
  │    │       ├─ 汇总 html/ + data/ + config.properties.coreFiles + readme_md 写入 core-bundle.json
  │    │       ├─ 对比旧 core-list.js 全部 CRC32，无变化则跳过版本递增
  │    │       └─ 有变化 → 生成新 BUILD_VERSION 写入 src/js/raw/core-list.js
  │    └─ 8. updateSwVersion(): 同步重写 src/js/raw/sw.js 的 importScripts(?v=ver) 与 self.SW_VERSION
  │
  └─ Phase 3: 尾项顺序压缩
       └─ 压缩新生成的 src/js/raw/core-list.js → src/js/core-list.js 与 sw.js → 根目录 /sw.js
```

### 自定义 URL 协议路由表（`<protocol>://<action>{<params>`）

`CLI.bat` 在启动阶段以纯字符串替换检测 `://`（避免管道衍生子 CMD 触发 AutoRun 报错），经 PowerShell `[uri]::UnescapeDataString` 解码后按 `{` 拆出 `action` 与 `params` 分发：

| 协议号 | 路由目标 | 触发来源与执行闭环 |
| :---: | :--- | :--- |
| **`1{`** | `:case_edit` | HTML 页 `edit` 按钮 → `Stamper` 覆写时间戳并用 VS Code 打开源文件 |
| **`2{`** | `:case_bookmark` | `bookmark.js` 拖拽链接 → `BookmarkManager.java` 增删移 + 更新 `#end_flag` + `.tmp` 原子落盘；主控每 1s 轮询清缓存重载直至 `linksHash` 变更（30s 上限与拖拽锁 31s 对齐） |
| **`3{`** | `:case_explorer` | 侧栏 `root/` → 资源管理器打开本地仓库根目录 |
| **`4{`** | `:run_menu` | 侧栏单击 `CLI.bat` → 呼出交互式菜单 |
| **`5{`** | `:case_overwrite` | `bilingual.js` 双语固化 → 克隆文档剥离 19 类运行期注入节点 → 写入剪贴板并 `await destroyDraft()` → PowerShell 读剪贴板覆写 `html/<title>.html` → 自动触发 `:run_gen` |
| **`6{`** | `:run_gen` | 侧栏双击 `CLI.bat` → 直接静默执行全量增量构建 |
| **`7{`** | `:case_jump_txn_file_line` | `txn_parser.js` 点击流水行 → `code -g _build/secrets/txn.txt:<line>` 精准跳转 |
| **`8{`** | `:case_go` | 侧栏 `Katrain` → PowerShell 后台 `uv run python -m katrain` 启动围棋分析 |
| **`9{`** | `:case_overwrite_md` | `md_viewer.html` 点 Save / `Ctrl+S` → 校验 `.md` 后缀且拦截 `..` / `:` 路径穿越 → PowerShell 以 **UTF-8 无 BOM + `.tmp` 原子替换**覆写目标 MD → 前端 400ms 轮询确认磁盘一致 |

---

## Service Worker 全生命周期时序

### 安装、大包自适应与安装熔断（`install` → `activate`）

```text
发现新版 /sw.js (线上 10s / 本地 2s / 标签页切回可见时触发 reg.update())
  └─ install 阶段:
       ├─ 1. 定位旧缓存桶 lastCacheName (优先最新旧 core-cache-*；同版本重装回退同名桶)
       │      └─ 读取 /sw-manifest.json 得到 oldManifest，并向窗口广播 SW_UPDATE_STATUS(isUpdate)
       ├─ 2. 遍历 allFilesToCache (排除 fat_data_* 与 no_cache):
       │      ├─ synonyms.js / .wasm / 胶水 JS 哈希变更 → 延迟任务写入 sys_state['pending_search_cache_clear']
       │      ├─ /html/* 哈希变更 → 后台并发 (最多 4 路) 取旧响应 → CompressionStream('deflate-raw') 压缩
       │      │                     → 按时间戳 + 字节双重去重写入 MainDB.html_snapshots (每页上限 10 版)
       │      ├─ 哈希未变 → 直接从旧桶拷贝响应至新桶 core-cache-{BUILD_VERSION}
       │      └─ 哈希变更 → 按 meta.source 分入 bundleUpdates 或 standaloneUpdates
       ├─ 3. 大包 / 单文件自适应同步:
       │      ├─ 首次安装或 bundleUpdates.length > CORE_BUNDLE_THRESHOLD (15):
       │      │    └─ 单请求拉取 core-bundle.json?v=ver → 内存按扩展名构造 MIME (.html/.css/.json/.js/.md) 写入新桶
       │      └─ 小幅增量更新 (≤ 15 个): 合并进 standaloneUpdates 逐个拉取
       ├─ 4. 并发拉取 standaloneUpdates (带 fetchWithLock 去重 + 30s AbortController 超时):
       │      ├─ 并发度按网络自适应: 2g/slow-2g → 1；3g 或文件数 > 21 → 2；4g → 4
       │      ├─ 若拉取失败:
       │      │    ├─ 命中 CRITICAL_URLS 熔断名单 (index.js, shared-utils.js, search-engine/preview/ui,
       │      │    │   snapshot.js, side.js, content.js, lite_data.js, worker.js) → 抛错中止整次安装!
       │      │    └─ 非关键模块失败 → 从旧桶回退旧响应，且 committedManifest 保留旧 hash (下次联网自动修复)
       │      └─ 记录 新增 / 更新 / 删除 到 MainDB.update_logs
       └─ 5. 写入 committedManifest 到新桶 /sw-manifest.json → 进入 waiting
            ├─ 本地模式 (online_flag="0"): 自动发送 SKIP_WAITING
            └─ 线上模式 (online_flag="1"): 通知 #side 顶部弹出“发现新版本, 点击更新”
                 └─ 用户点击 → BUS execute_update (按 TAB_ID 隔离) → SKIP_WAITING
  └─ activate 阶段:
       ├─ 删除所有过期 core-cache-* 桶
       ├─ 检测 pending_search_cache_clear → 清空 MainDB.search_cache 与 search_cache_lru
       └─ clients.claim() → 主页面触发 controllerchange → takeSnapshot(true) → reload
```

### 线上 / 线下请求拦截策略（`fetch`）

```text
同源 HTTP 请求 (排除 sw.js 与跨域)
  ├─ [本地模式 IS_LOCAL_MODE = localhost/127.0.0.1 且 port ≠ 9000]
  │    └─ Network-Only (cache: 'no-store') → 仅断网异常时回退 coreCache / caches.match
  │
  └─ [线上模式 / 9000 仿真端口]
       ├─ 1. core-list.js:
       │       └─ 不走网络! 直接用当前激活 SW 内存中的 FILE_MANIFEST + BUILD_VERSION 动态合成响应
       │          (彻底杜绝新 SW waiting 期间刷新页面出现“旧代码 + 新清单”的版本撕裂)
       │          若异常缺失则回退读取当前桶 /sw-manifest.json，并注入 window._isOfflineDataFallback = true
       ├─ 2. worker.js / synonyms.js / *.wasm / 胶水 JS:
       │       └─ 严格匹配当前桶 core-cache-{BUILD_VERSION} (ignoreSearch) → 未命中再网络拉取并回填当前桶
       ├─ 3. /audio/ /video/ /gallery/ /ebook/ /cmaps/ / 字体:
       │       └─ 独立持久化桶 media-cache (Cache-First，未命中再拉取缓存；媒体 Diff 发现删除时定向 delete)
       └─ 4. 其余静态核心文件:
               ├─ 若 URL 带 ?v=reqVer 且与激活态 FILE_MANIFEST[path].hash 不一致 → 尝试直连网络
               └─ 否则优先命中当前桶 core-cache-{ver} → 未命中则走 fetchWithLock(request)
```

### 降级、阶段看门狗与三级自愈时序

```text
[离线降级]
  无网启动 → SW 用 sw-manifest.json 构造数值有序 dataIndex + _isOfflineDataFallback=true
          → index.js 跳过切片网络拉取，直接用 MainDB.chunks 现有切片构建 Wasm 索引

[非破坏性阶段看门狗]
  loadScripts() 启动 90s 看门狗 ──► 数据送入 Worker 切为 45s Wasm 看门狗 ──► DATA_READY 清除
  └─ 若超时: 不自动删库! 仅在 #sf-status 标错 + confirm 询问用户继续等待或调用 executeSelfHealing()
             (保护慢网下用户本地 html_snapshots 与 update_logs 不被误清)

[三级应急自愈]
  1. 远端静默指令: index.js onload 2s 后绕缓存拉 /sw.js → 解析 repair_command_id
                   若 remoteId > localId (且 localId≠0) → 自动执行 executeSelfHealing()
  2. URL 手动指令: 访问 /?repair=1 → 立即注销全部 SW + 清空全部 CacheStorage + 关闭并删 MainDB + 清快照 → 重载首页
  3. 交互式重置:   搜索框输入 @bomb → 可选 Plan A (保留所选+抓快照重建) / Plan B (导出 JSON 后全清) / Plan C (全清)
                   清库前按序关闭 dbProxy / ExcerptsSys / MarkSystem 句柄并将 iframe 置 about:blank，防止 IDB onblocked 死锁
```

---

## 全场景搜索时序

### 全站普通搜索（缓存命中 / 前缀预览 / Worker 分片 / 评论叠加）

```text
用户输入 → composition 保护 (IME 组词期间暂停) → debounce 150ms → ++window._searchToken
  ├─ 1. 查 searchResultCache (内存 Map 48 → IDB LRU 500, 键格式 n{noise}|l{syn}|normKw):
  │      ├─ [精确命中] CANCEL Worker 旧任务 → 异步发 SEARCH_COMMENTS 补查评论 → 直接渲染缓存
  │      │              (若开近义但主线程缺 termSpecs → 异步发 EXPAND_QUERY 补全标题高亮着色)
  │      ├─ [非近义前缀命中] 先出 provisional 预览结果，同时继续发 Worker 精确扫描
  │      └─ [未命中] 跳过缓存
  ├─ 2. 主线程 postMessage(SEARCH, { keyword, noise, synonymsEnabled, token, ns })
  └─ 3. Worker 线程:
         ├─ bumpToken(token) 立即抢占中止任何进行中的旧扫描
         ├─ resolvePayloadTermSpecs() 调 synonyms.js 展开同义词表 (注入 bloom_might_match 裁剪)
         ├─ prepare_search() 一次性编译 ScanPlan + 全局 Bloom 预筛 (0 命中直接短路返回 [])
         ├─ scanAll() 以 SLICE_MS=8ms 自适应分片扫描全库:
         │    ├─ 每片通过 MessageChannel 让出事件队列，检测 token 变更即返回 null 丢弃
         │    └─ 若扫描途中收到 BUILD_DATA (dataGen 递增) → 自动重新 prepare 并从头扫描
         ├─ runCommentSearch() 同理分片扫描 COMMENT_BLOOM + 评论库 (监测 commentGen)
         └─ 返回 SEARCH_RESULTS { results, commentHits, termSpecs, token, ns, synApplied }
  └─ 4. 主线程核对 token === window._searchToken 且 ns === computeQueryContextSig():
         ├─ 缓存 termSpecs + 写 searchResultCache (命中数 ≤ 300 且 synApplied=true)
         ├─ 600ms 后发 COMMIT_CURSOR：若新词为上次提交词的延伸前缀且不在历史中，发 DELETE_CACHE 清理中间碎片缓存
         ├─ 若当前页在结果中置顶；若为单 _ 大文档不在切片中，发 LOCAL_SEARCH_COUNT 让 content.js 页内补算并回传 LOCAL_SEARCH_RESULT
         └─ 合并页内叠加层 + 评论叠加层 + #sf-bar 类型/年月过滤 → 渲染 .sr-opt 与标题分层高亮
```

### 布尔组合搜索（`@[...]`）时序

```text
用户输入 @[a&!(b|c)]飞机[31]大炮[]机枪[0] → debounce 450ms → ++window._searchToken
  ├─ 前端 parseAdsQuery():
  │    ├─ 统一全角符号 (＠【】＆｜！（）) → 解析表达式 AST (括号嵌套深度 ≤ 8，最多 26 词)
  │    ├─ 德摩根律下推否定 → NNF 树 (and / or / neg term) → 校验 adsHoldsOnEmpty 拦截纯否定全库匹配
  │    └─ 失败直接写 #sf-status 错误提示并取消 Worker；成功展示中文逻辑摘要
  ├─ postMessage(SEARCH_ADS, { plan, token, ns }) → 不走 searchResultCache
  ├─ Worker:
  │    ├─ 按各 term 独立的 (noise, like) 展开词表 → prepare_ads_search() + ads_optimize() 短路重排
  │    ├─ 联合正文与评论求值，再仅用正文二次求值判定 viaComment (标注 [💬])
  │    └─ 监测 `${dataGen}:${commentGen}`，数据或评论更新时自动重扫
  └─ 悬停结果 → requestSnippets() 仅提取正向词 (buildAdsPositiveTerms) 调用 get_snippets_ads() 合并高亮片段
```

### 书内统一搜索时序（`__DOC_SEARCH_BRIDGE__`：TXT / PDF / EPUB）

```text
打开 txt.html / pdf.html / epub.html
  └─ 文档就绪后调用 window.top.__DOC_SEARCH_BRIDGE__.register(provider)
       ├─ search-engine 自动切入 searchScope='txt'，#sf-bar 显示 [本书/全站] 切换钮并隐藏全站筛选器
       └─ 用户按 \ 或 Ctrl+F (PDF/EPUB 捕获阶段接管原生查找) → 全屏下临时浮出 #search (dataset.fsTemp="1")

[书内检索执行]
  用户输入 → searchTxtBook(kw):
    ├─ 若为 @[...] 组合语法 → 立即拦截，#sf-status 提示“文内搜索不支持组合语法”，清高亮
    ├─ 开启近义时: ensureTermSpecs([{ text: kw, like: true, skipCorpusFilter: true }])
    │              └─ Worker 跳过 HTML 语料 CORPUS_BLOOM 裁剪 (cacheTag='raw')，避免书内独有近义词被误杀
    └─ 调用 provider.runSearch({ keyword, specs, noise, token, reportStatus }):
         ├─ TXT:  按换行分 ~36KB 文本块 → 调 window.top.sharedWasm.find_content_matches_multi 分片扫描
         │        → 按章节标题/18000字分段聚合 + CSS.highlights 无损着色
         ├─ PDF:  打开即后台 requestIdleCallback 每批 3 页静默预提取；搜索时未提完自动提速为每批 6 页并实时
         │        reportStatus("正在提取 PDF 文本 X/N 页...") → 按大纲章节或固定页段 (20/30/50 页) 聚合
         │        → 仅对已渲染页绘制透明文字层高亮 (color: transparent)，滚动/缩放由 textlayerrendered 增量补绘
         └─ EPUB: 跳过 <rt>/<rp> 注音抽取各章节 iframe 正文与 #id 锚点 → 按 TOC 最细叶子节点聚合
                  → 向命中章节各自的 contentWindow.CSS.highlights 独立注册高亮

[交互与预览]
  ├─ 结果列表以 [▸ 章节/页段名 [命中数] · 位置] 折叠展示；单命中点击直达，多命中点击原地展开 [↳ #1 …片段…]
  ├─ 悬停章节或单条锚记 → 复用主站 #center-snippet-preview 展示上下文高亮并支持右击滚屏
  ├─ 点击锚记 → 瞬时定位 (TXT 横向滚动居中 / PDF 切页后等 textlayerrendered 居中 / EPUB 匹配 item.Pages 瞬时 focusOn)
  │             + 叠加橙色焦点高亮 + 脉冲提示框
  └─ 若全屏下切回「全站」并点击全站条目 → loadContent() 先调 exitLightbox() 恢复 #side、清 fsTemp 并退出全屏
```

### 页内高亮与评论融合检索时序

* **HTML 页内搜索联动（`content.js`）**：从全站搜索跳入 HTML 页时，`content.js` 复用 `window.top.sharedWasm.find_content_matches_multi` 与 `ensureTermSpecs` 计算页内所有命中，通过 `CSS.highlights` 分层着色并构建右下角 `#s_nav` 导航条；进入 `_isDiffMode` 时自动向主控发 `CLEAR_SEARCH` 并屏蔽 `REFRESH_HIGHLIGHT`，避免与 Diff 视图冲突。
* **评论同步与叠加（`comments.js`）**：启动先从 `MainDB.sys_state['comments_latest']` 秒级加载本地快照推送给 Worker（`SET_COMMENTS`），随后每 10 分钟及切回可见超时后拉取 `raw.githubusercontent.com/{data_repo}/main/comments.json`；发现新评论时更新快照、推送 Worker 重建 `COMMENT_BLOOM`、刷新当前搜索结果的评论叠加层，并按偏好弹出 `What's new?` 评论页。

---

## 多层缓存架构与失效时序

### 存储介质分层

| 存储介质 | 命名空间 / 库表 | 存储内容 | 容量与淘汰策略 |
| :--- | :--- | :--- | :--- |
| **Cache Storage** | `core-cache-{BUILD_VERSION}` | 站点壳代码、HTML、CSS、Wasm、`synonyms.js`、预览版 Markdown 依赖、`README.md`、`sw-manifest.json` | 严格按当前版本桶读写；新 SW `activate` 时整桶删除旧版 |
| **Cache Storage** | `media-cache` | `gallery` / `video` / `audio` / `ebook`、字体、PDF `cmaps` | 按需缓存；媒体 Diff 侦测到文件删除时定向 `delete` |
| **IndexedDB** | `MainDB` (v3) | `chunks`（fat 切片）、`update_logs`、`search_cache`、`sys_state`、`html_snapshots` | `search_cache` 上限 500 条 LRU（单次结果 $>300$ 不入库）；`html_snapshots` 每页上限 10 版 |
| **IndexedDB** | `ExcerptsDB` (v1) | `books`（按书名 / HTML 归档的摘抄） | 单例连接缓存，单事务读取 |
| **IndexedDB** | `SideDB` (v1) | `marks`（侧栏已阅划线标记） | 单例连接，`ensureDB()` 断线自动重连 |
| **IndexedDB** | `AlignDrafts` (v1) | `draft_texts`（本地双语页编辑草稿） | 2s 防抖暂存，固化前 `await destroyDraft()` 销毁 |
| **localStorage** | 业务 Key + `txn_*` + `txt.history*` | 布局、历史（50）、搜索历史（100）、收藏、滚动位置、媒体进度（500）、壁纸、筛选/噪值/近义偏好、PDF/EPUB/TXT 进度与书签、账本汇率 | 每分钟 `lsAlert()` 巡检，超 $4\text{ MB}$ 预警 |
| **sessionStorage** | `ss_restore_strict` | SW 升级 / `@bomb` Plan A / `@rebirth` 重载前的一次性视图快照 | 读取恢复后立即删除 |

### 搜索缓存写入与多级失效时序

```text
[写入路径 (内存 + 延迟合并落盘)]
  命中结果 (≤300 条) → memSet (LRU 48, 键 = n{noise}|l{syn}|normKw) → 进 dirty 队列
                     → 400ms 防抖 (或 pagehide 立即) flush → 写 IDB search_cache
                     → 比对 epoch 防止清空后脏写回填 → lru.touchAndEvict (超 500 条淘汰最久未用)

[四重失效机制]
  1. 核心切片/算法变更: DATA_READY 后 bindNamespace('core', `v${SEARCH_ALGO_VER}|d:${_dataFp}`)
                        不匹配 → 清空 search_cache + 重置 LRU + 广播 SEARCH_CACHE_CLEARED (唯一允许跨 Tab 的消息)
  2. 同义词库变更:     SYNONYMS_READY 后 bindNamespace('syn', `syn:${hash(version + '|' + sig)}`) → 不匹配即清库并重搜
  3. SW 激活兜底:      synonyms.js / .wasm / 胶水 JS 变更 → SW install 写标记 → activate 阶段同步清库
  4. 切片原子增量更新: loadDataInBatches() 仅当本轮全部变更切片拉取成功 (failedCount===0) 才原子 saveBatch 落盘并清缓存
```

---

## 核心模块协作流程

### 首屏启动与看门狗时序

```text
index.html (成人校验 → 注入 PARAM 常量 → 加载 index.js / index.css)
  ├─ 顶层立即执行:
  │    ├─ 初始化 __TAB_ID__、BroadcastChannel('bus')、VirtualCursor 占位
  │    ├─ 并行预热: import(Wasm) + Promise.all([import(search-engine), import(search-ui)])
  │    └─ 挂接 window.__DOC_SEARCH_BRIDGE__ (别名 __TXT_SEARCH_BRIDGE__)
  └─ window.onload:
       ├─ 1. 探测 ?repair=1；2s 后绕缓存拉 /sw.js 探测远端 repair_command_id
       ├─ 2. 恢复侧栏 flex 比例，加载 #side iframe，绑定 snap() controllerchange 与 sw() 注册
       ├─ 3. 等待 searchStackReady → searchUI.init() (将原生 <select> 升级为自定义 listbox)
       ├─ 4. loadScripts(6) 启动 90s 看门狗:
       │      ├─ 预热 Worker (并行加载 Wasm 与 synonyms.js) + 预读 MainDB.chunks
       │      ├─ 加载 core-list.js → (本地) shadowIndex.js → lite_data.js
       │      ├─ 向 #side 推送 RENDER_CATALOG 渲染目录树
       │      ├─ 若存在 ss_restore_strict → 懒加载 snapshot.js restoreSnap() 恢复主屏/音视频/搜索状态
       │      │   否则直接加载 src/tpl/bookmark.html；完成后展示 #search
       │      └─ loadDataInBatches(): 比对 hash 增量拉取切片 → 清理废弃切片 → 原子落盘
       │           └─ postMessage('BUILD_DATA') (切为 45s Wasm 看门狗)
       │                └─ Worker 组装索引 → DATA_READY → 清除看门狗、媒体 Diff 清理 media-cache、触发更新彩带与日志
       └─ 5. idleRun() 空闲期:
              ├─ 懒加载 comments.js (拉取快照 + 定时同步)
              ├─ 懒加载 deferred-features.js (拼音词库、夜间催睡标题/图标闪烁、lsAlert、7天备份、本地到期任务乒乓盒)
              └─ 粗指针设备懒加载 touchpad.js (回放挂接已登记窗口的 VirtualCursor)
```

### 多标签页隔离与跨 iframe 协作

* **会话隔离**：`index.js` 为每个标签页生成唯一 `window.__TAB_ID__`；所有同源子 iframe 通过 `window.top.__TAB_ID__` 附带 `tabId` 发送 `BroadcastChannel('bus')` 消息，接收端严格执行 `if (tabId && myTab && tabId !== myTab) return;`，仅 `SEARCH_CACHE_CLEARED` 允许跨标签页同步内存失效，彻底消除多 Tab 互相跳页、重复保存摘抄与跨 Tab 清高亮。
* **无损热更新接管（`snapshot.js`）**：新 SW 触发 `controllerchange` 后，主控执行 `takeSnapshot(true)` 将当前文档路径、滚动位置、音视频播放进度、活跃搜索词存入 `sessionStorage['ss_restore_strict']` 后刷新；新版首屏读出快照、校验 `lite_data` 完整性并还原现场，随后消费 `force_refresh_cache` 播放彩带并弹出 `What's new?`。
* **全屏与灯箱收口（`index.js` + `search-ui.js`）**：主控统一以 `setLightboxState()` / `exitLightboxMode()` 管理 `#side`、`#search`、`#content.mask2`、音视频控件与 `store.lightbox_stauts`，并监听 `fullscreenchange`；无论用户按 `Esc` 退出全屏，还是在全屏阅读 TXT/PDF/EPUB 时用搜索切回全站打开新页面，侧边栏、工具栏与搜索框都会同步复原。
* **站内 Markdown 预览与编辑（`md_viewer.html` + `deferred-features.js`）**：点击书签或右键全局菜单中的 `README` 弹出默认最大化的可八向缩放浮窗（中键/Ctrl+点击仍跳 GitHub）；所有依赖同源置于 `src/third/markdown/`，线上只强缓存 `marked`/`purify`/`highlight` 并以「左预览 | 右目录」两列展示，线下按需加载 CodeMirror 5 并在宽窗下呈「左编辑 | 中预览 | 右目录」三列可拉动布局、窄窗下自适应「上预览+目录 / 下编辑」上下栏。

---

## 算法精粹

### 两级索引过滤与单遍扫描（`lib.rs`）

1. **字符规整与去后缀索引**：`fold_char` 将全角空格、全角 ASCII 与 Unicode 大写折叠为半角小写 `Vec<char>`；非 HTML 媒体在构建索引时调用 `strip_file_ext`（要求 $\text{dot} > 0$）剥离扩展名且不索引目录路径避免召回整类文件。
2. **全局 Bigram Bloom 过滤器**：`CORPUS_BLOOM`（$1\text{ MB}$ = $131,072 \times \text{u64}$ = $8,388,608\text{ bit}$，4 哈希）与 `COMMENT_BLOOM`（$256\text{ KB}$ = $2,097,152\text{ bit}$），其 bigram 抽取规则与 `try_match_at(eff_noise = 0)` 严格对齐（允许跨至多 1 个非硬断行空白、遇硬断行中断），在扫描前毫秒级裁剪不可能命中的候选词与同义变体。
3. **文档级自适应位图（`DocFilter`）+ `ScanPlan`**：按文档字符数分 4 档（$\le 64$ / $\le 512$ / $\le 4096$ / $> 4096$）分别分配 `4/4`、`16/16`、`32/64`、`64/256` words 的 unigram/bigram 位图；扫描前编译 `ScanPlan`（256-bit `first_mask` + 首字倒排表 `by_first`），每篇文档先过 `DocFilter` 过滤候选词：剩 0 个整篇跳过，剩 1 个走单模式快路径，多个按首字掩码单遍线性扫描。

### 宽容噪值匹配与次线性饱和计分（`lib.rs`）

* **动态噪值缩放**：
  `min(noise, KW_LEN>25 ? 0 : KW_LEN/2)`
  单个空白不计噪，连续空白自第 2 个起计噪，遇到硬断行符（`\n \r 。！？；!?;`）立即阻断跨句匹配。
* **4 维重叠区间裁决（`merge_tagged_hits`）**：原词、同义词、组合多词区间重叠时，依次比较：
  $$\text{tier } (0 > 1 > 2) \longrightarrow \text{noise (小者优先)} \longrightarrow \text{weight (大者优先)} \longrightarrow \text{span 长度 (长者优先)}$$
* **次线性词频饱和与精确保底**：标题基准 $5000$（每噪 $-500$，$k=1$，同义上限 $4500$），正文基准 $100$（每噪 $-10$，$k=4$，同义上限 $450$）；命中按单次分值降序排列，第 $i$ 次命中乘衰减因子 $\frac{k}{k+i}$，防止长文靠同义词堆叠反超精确命中；此外按文档内 `tier=0` 最小噪值追加阶梯保底分（$0\text{ 噪}+10000$、$1\text{ 噪}+3000$、$2\text{ 噪}+2200$、$3\text{ 噪}+1500$、$4\text{ 噪}+900$、$5+\text{ 噪}+500$）。

### 布尔代数与短路优化（`search-engine.js` + `lib.rs`）

* **NNF 范式转换与纯否定防御**：手写递归下降解析器（括号最大深度 8）经德摩根律将 `!` 全部下推至叶节点，规整为仅含 `and` / `or` / 带 `neg` 标记 `term` 的 NNF 树；前端与 Wasm 双端均校验 `adsHoldsOnEmpty(expr)`，拦截如 `@[!a]` 这类在空文档上恒为真的纯否定查询。
* **短路重排与 `viaComment` 判定**：Wasm 侧 `ads_optimize()` 将 `And` 子句按 `(非否定优先, 噪值升序, 词长降序)` 重排以最大化早期短路；单文档复用 `AdsScratch` 零分配缓冲，先联合正文+评论求值，再以纯正文二次求值精准判定是否仅由评论命中（`viaComment`）。

### 近义词扩展与语料消歧算法（`SynonymBuilder.java` + `synonyms.js v5.1`）

1. **三路查词分流**：
   * **A 路（整词/短语直达）**：所有词库键经 `compactKey()`（半角 + 去空白 + 小写）建索引，带空格现代词组（如 `Stable Diffusion`）也能直达双向组或单向别名。
   * **B 路（独立词边界保护）**：直接命中 `#` / `@` 独立词或 `stopExpand` 技术术语时，禁止拆字扩出古典杂义。
   * **C 路（DP 最优分词 + 词林树 LCA 消歧）**：用全词表做动态规划求最优切分（`hasValidAsciiBoundary` 防止撕裂英文单词），以同句其余词的 5 级词林码作为上下文，按树上最近公共祖先（LCA）深度加权（同 5 级 $1.85\times$、同 4 级 $1.45\times$、同 2 级 $1.18\times$）。
2. **DF 软加权与隐私隔离**：构建期仅对公开非排除语料执行 FMM 统计 7 档 DF（`:1..:6`），运行时候选分乘 `DF_CAND_MULT[bucket]`（中低频特征词峰值 $1.18\times$、高频泛词压至 $0.38\times$、公网未现词保留 $0.62\times$ 而不删除），义项消歧叠加 `senseDfBoost`，虚词大类 `K`/`L` 分别压至 $0.22\times$/$0.55\times$；最终由 Worker 注入 `bloom_might_match` 滤掉当前语料（含本地私密影子与评论）中不存在的变体，全部同义扩展锁定 `maxNoise=0` 防语义漂移。

### Worker 自适应时间片与抢占调度（`worker.js`）

* 采用 **`MessageChannel` 零延迟让出队列**（规避 `setTimeout(0)` 在浏览器中的 4ms 最小钳位），每个时间片目标 $\text{SLICE\_MS} = 8\text{ ms}$；每扫完一片按耗时比例 $\text{clamp}(\frac{8}{\max(dt, 0.5)}, 0.5, 2.0)$ 动态伸缩 `sliceDocs`（范围 $16 \sim 4096$），兼顾快速设备吞吐与低端机响应；新请求到达立即 `bumpToken(token)`，旧扫描在下个 $8\text{ ms}$ 边界即刻中止。

### 渲染级语义 LCS Diff 与快照压缩（`content.js` + `lib.rs` + `sw.js`）

* **语义 Token 化 Diff**：将历史 HTML 快照与当前 `<pre>` 均渲染为标准化 Token 序列（`html_line`、`table_row`、`code_line`），送入 Rust `similar::capture_diff_slices(Algorithm::Lcs)` 计算最小编辑脚本，并设 $25,000,000$ 单元格矩阵规模熔断阈值防大文档 OOM，输出着色视图与右侧 `#diff-minimap` 缩略定位条。
* **零冗余压缩存档**：SW 更新 HTML 时通过浏览器原生 `CompressionStream('deflate-raw')` 压缩旧版源码，结合 `#anchor` 时间戳与压缩字节数组逐字节比对做双重去重，单页保留最近 10 版。

### 无损分层高亮与多端阅读器算法

* **CSS Custom Highlight 18 槽优先级池**：按 `tier (0/1/2) × noise (0..5)` 映射至 18 个全局 `Highlight` 对象并赋差异化 `priority`（精确命中 $100 \to 50$，一级近义 $40 \to 15$，二级组合 $20 \to 5$，当前焦点 $200$），仅操作 `Range` 不修改 DOM，彻底消除重排且不干扰代码编辑、双语编辑与摘抄选区；PDF 场景特化为 `color: transparent` + 低透明底色避免透明文字层重影，EPUB 场景在各章节 `iframe` 的 `contentWindow.CSS.highlights` 独立注册。
* **中文四级编码自动判定（`txt.html`）**：BOM 精确识别（UTF-8 / UTF-16LE / UTF-16BE）→ 严格 `TextDecoder('utf-8', { fatal: true })` → 16 KB 样本奇偶空字节占比判无 BOM UTF-16 → 32 KB 样本对比 `gb18030` 与 `big5`，综合 CJK 频次、中文标点、简繁高频特征字集与 `\uFFFD`/控制符罚分择优 → `encoding.min.js` 兜底。
* **TXT 抗排版字符锚定与阻尼横向滚屏（`txt.html`）**：按换行切分 ~36 KB DOM 块，利用 `caretRangeFromPoint` 反查当前视口左上角精确 `charOffset` 并持久化，调字号/行高/栏宽或缩放窗口时二分查块并精确定位回同一句话；垂直滚轮通过 rAF 指数阻尼（`diff * 0.24`）转为无缝横向滚动，触控板原生横向滑动保持 1:1 跟手。
---

## AI Agent 会话与协作

在借助 AI Agent 对本知识库进行二次开发、算法调优或 Bug 修复时，按「最小必传集 + 按场景加传」提供上下文，避免无关大文件稀释注意力：

### 基础必传清单

| 文件路径 | 作用与必传原因 |
| :--- | :--- |
| `README.md` | 让 AI 一次性掌握全局约束（Java 8、零框架原生 ESM、隐私隔离、模块拓扑、SW 与缓存协议） |
| `_build/rs/.../lib.rs` | 检索核心算法（噪值匹配、评分、DocFilter、Bloom、ADS 布尔求值、LCS Diff） |
| `src/js/raw/worker.js` | Worker 线程调度（8ms 时间片、抢占取消、代际重扫、同义词与 Bloom 交互） |
| `src/js/raw/search-engine.js` | 主线程检索内核（IDB LRU 缓存、双命名空间失效、ADS 解析、书内桥接、高亮区间计算） |
| `src/js/raw/search-ui.js` | 搜索前端交互（防抖、联想、结果列表、折叠锚记、`#sf-bar` 筛选与作用域切换） |

### 按调优目标加传清单

* **近义词召回、消歧与新词扩充**：`SynonymBuilder.java` + `synonyms_custom.json` + `_build/synonyms/oov_report.txt`（无需上传生成后的 `synonyms.js` 与 `cilin.txt`）。
* **HTML 页内高亮、Diff 与双语固化**：`src/js/raw/content.js` + `src/js/raw/bilingual.js` + `src/js/raw/shared-utils.js`。
* **电子书书内搜索与阅读器**：对应模板 `src/tpl/txt.html` / `src/tpl/pdf.html` / `src/tpl/epub.html` + `src/js/raw/index.js` + `src/js/raw/search-preview.js`。
* **Markdown 浮窗预览与本地固化**：`src/tpl/md_viewer.html` + `src/js/raw/deferred-features.js` + `_build/CLI.bat`。
* **评论融合搜索与同步**：`src/js/raw/comments.js`。
* **SW 缓存、快照热更新与构建清单**：`src/js/raw/index.js` + `src/js/raw/sw.js` + `src/js/raw/snapshot.js` + `Generator.java` + `_build/config.properties`。

### 高效提问与 Badcase 复现格式

```text
【查词】: `xxx` （噪值: 5 / 近义: 开启 / 范围: 全站或书内）
【现状】: 当前排名第 1 的是《页面 A》，期望结果《页面 B》排在第 12 位（或未召回）。
【期望】: 请结合 lib.rs 与 search-engine.js 分析匹配与评分原因，并给出最小改动方案。
```