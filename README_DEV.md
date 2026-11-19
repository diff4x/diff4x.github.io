# diff4x's digital swamp — 全站技术架构与开发者文档 (`readme_dev.md`)

> 本文档面向项目作者与二次开发者，系统记录本站（无后端静态全息知识库 / PWA）的设计意图、工程架构、核心算法原理、构建与运行全链路、并发时序、多层缓存与更新自愈机制，以及已知权衡与演进方向。

---

## 1. 主要意图与设计哲学

本站的目标是在**零后端服务器、纯静态托管（GitHub Pages）**的前提下，构建一套具备**桌面级本地知识库体验**的个人数字档案系统：

1. **静态资产即数据库**：以物理目录（`html/`、`gallery/`、`video/`、`audio/`、`ebook/`）作为唯一事实源（Single Source of Truth），通过构建期 Java/Rust 工具链离线生成索引与校验账本，运行期完全在浏览器端完成检索、渲染、比对与持久化。
2. **双态同构（Local Read-Write / Online Read-Only）**：同一份前端代码在本地（`localhost:8000`）自动激活编辑、双语固化、书签拖拽、私密影子检索、任务到期提醒与 `CLI.bat` 快捷操作；在公网（GitHub Pages / `9000` 仿真端口）自动降级为只读展示、私有条目挂锁拦截、启用 Giscus 评论同步与 Service Worker 离线加速。
3. **离线优先与长寿性（Longevity）**：拒绝重型前端构建框架与易腐的 npm 生态依赖；核心运行层采用原生 ESM/Vanilla JS + Rust/Wasm + 浏览器原生能力（Service Worker、IndexedDB、Web Worker、BroadcastChannel、CSS Custom Highlight API），保证数年后依然易于维护和迁移。
4. **隐私边界零泄漏**：私有页面（`__` 前缀）与 `.gitignore` 命中的私密媒体在构建期严格分流，公网产物（`fat_data_*.json`、`synonyms.js` DF 统计、`core-bundle.json`）绝不混入任何私密正文。

---

## 2. 鲜明技术特点

| 维度 | 特点说明 |
| :--- | :--- |
| **前端零框架** | 原生 JS + `iframe` 双栏隔离（`#side` 目录树 + `#content` 视图）+ 延迟动态 `import()` 代码拆分（`deferred-features.js`、`excerpts.js`、`lightbox-logic.js`、`touchpad.js`） |
| **Wasm + Worker 检索引擎** | Rust 编译的 WebAssembly 承担全文宽容匹配、ADS 布尔组合检索、摘要提取、Markdown 预处理与 LCS 差异计算；Worker 内以 `8ms` 自适应时间片异步扫描，支持毫秒级抢占取消 |
| **混合语义近义词系统 (`v5.1`)** | 基于《哈工大同义词林扩展版》+ 公开语料 DF 软加权分桶（`:1..:6`）+ JSON 现代词覆盖（支持 `exclusive` 独占与单向 `aliases`）+ 全词表 DP 分词 + 5 级词林树 LCA 上下文消歧 + Wasm 1MB Bloom 实时校验 |
| **零 DOM 侵入式高亮** | 页内匹配与预览片段均使用 `CSS Custom Highlight API`（`CSS.highlights`）按 `tier` 与 `noise` 分层着色，不破坏原始 DOM 结构，与代码编辑、双语编辑、摘抄选区天然解耦 |
| **客户端版本 Diff 引擎** | SW 更新 HTML 时自动将旧版源码以 `CompressionStream('deflate-raw')` 压缩并去重存入 `MainDB.html_snapshots`（最多保留 10 个历史版本），页内可任意两版本做渲染级 LCS Diff 并生成右侧 Minimap |
| **本地自定义 URL 协议闭环** | 通过自定义协议（`<protocol>://1{..8{`）打通浏览器与本地编辑器、书签原子修改、双语页面固化、账本行号跳转及 `CLI.bat` 触发 |
| **移动端虚拟触控板** | `touchpad.js` 检测到粗指针设备时自动加载，通过 CSS Transform 缩放/平移 `#stage`、动态镜像 `:hover` 规则为 `.tp-hover`，并跨 iframe 派发完整鼠标/滚轮/框选/拖拽仿真事件 |

---

## 3. 技术栈与核心模块拓扑

### 3.1 工具链与 Web 平台能力

* **构建侧**：Windows Batch（`CLI.bat`）、Java 8（`gen.jar`，依赖 Jackson / Jsoup / SLF4J）、Rust（`wasm-pack`，依赖 `wasm-bindgen` / `serde` / `regex` / `similar`）、`esbuild`、`libwebp`、`certutil`（SHA-256 增量校验）、`static-web-server`。
* **运行侧**：ES Modules、`Service Worker`、`Cache Storage`、`IndexedDB`（4 个独立库）、`Web Worker`、`WebAssembly`、`BroadcastChannel`、`CompressionStream / DecompressionStream`、`CSS Custom Highlight API`、`Shadow DOM`、`ResizeObserver`、`MutationObserver`。

### 3.2 模块关系图

```text
                        ┌──────────────────────────────────────────────┐
                        │               构建期 (_build/)                │
                        │  CLI.bat ──► esbuild (SHA256 增量压缩 JS/CSS) │
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
│  └─────────┬──────────┘      MainDB.html_snapshots / update_logs / sys   │   │
│            │ 拦截与对齐 core-list.js                                      │   │
│            ▼                                                             │   │
│  ┌────────────────────────────────────────────────────────────────────┐  │   │
│  │ index.html / index.js (主控 Shell, 持 TAB_ID 隔离)                  │  │   │
│  │  ├─ BroadcastChannel('bus') ◄───► #side (side.js + SideDB)         │  │   │
│  │  ├─ BroadcastChannel('bus') ◄───► #content (content.js /           │  │   │
│  │  │                                  bookmark.js / bilingual.js /   │  │   │
│  │  │                                  lightbox-logic.js / pdf/epub)  │  │   │
│  │  ├─ 懒加载 chunk: deferred-features.js / excerpts.js / touchpad.js │  │   │
│  │  └─ Worker (worker.js)                                             │  │   │
│  │       ├─ Wasm (lib.rs): IndexedDoc + DocFilter + Bloom + ADS + LCS │  │   │
│  │       └─ synonyms.js (v5.1): Cilin + DF 软加权 + DP + LCA          │  │   │
│  └────────────────────────────────────────────────────────────────────┘  │   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 构建流程 (`CLI.bat` + `gen.jar` + `wasm-pack`)

### 4.1 源码编译与增量防漏 (`CLI.bat [0] gen`)

1. **SHA-256 增量压缩 JS / CSS**：
   * `CLI.bat` 遍历 `src/js/raw/*.js` 与 `src/css/raw/*.css`，调用 `certutil -hashfile ... SHA256` 计算真实文件内容摘要（取代脆弱的分钟级时间戳+字节数判断），并与 `.hash` 记录及目标产物存在性比对。
   * 仅变更文件调用 `esbuild --minify --sourcemap` 输出至 `src/js/`、`src/css/`，并以 UTF-8 编码安全重写 `sourceMappingURL` 指向 `src/map/`。
   * 批量循环显式跳过 `synonyms.js`，避免覆盖构建器独占生成的词库文件。
2. **数据清洗与切片 (`Generator.java`)**：
   * 扫描 `html/` 目录：解析 `<title>`、`#anchor` 时间戳与分类链、`.gitignore` 私有标记（`isGitIgnored` / `__` 前缀）、大型排除文档标记（单 `_` 前缀，不进入切片但保留页内本地搜索持久化）；维护 `src/cmt_mapper.json` 评论 ID 映射与 `orphanIds`。
   * 扫描 `gallery/`、`video/`、`audio/`、`ebook/` 多层级目录，生成目录树 `src/js/data/lite_data.js`（条目格式 `[fileName, id, type, flags]`）。
   * 正文切片分流：
     * 公开 HTML 正文（保留 `#anchor` 以便按年份/分类检索）分片写入 `src/js/data/fat_data_*.json`；私有条目仅写入占位符 `"localOnly"`，排除大文档写入 `""`。
     * 私有 HTML 明文单独写入本地 `shadowData_*.json` 与 `shadowIndex.js`（纳入 `.gitignore`，绝不推送到公网）。
   * 打包首屏静态核心包 `src/js/data/core-bundle.json`（聚合 HTML/CSS/JSON）。
3. **同义词词库构建 (`SynonymBuilder.java`, `v5.1`)**：
   * 仅收集**公开、非排除 HTML** 的“标题 + 剥离 `#anchor` 后的正文”以及公开媒体文件名（作为 DF=1 补充），**严禁读取 `shadowDataMap`**。
   * 加载 `cilin.txt` 与 `synonyms_custom.json`（处理 `dropEqCodes`、`pruneWords`、`splitFixes`、`stopExpand`、双向 `groups` 的 `exclusive` 独占剥离、单向 `aliases`）。
   * 用全量词表执行正向最大匹配（FMM）统计每个词的公开文档频率 `DF`，量化为 0~6 共 7 个分桶（`0`=未出现、`1`=1 篇、`2`=2~3 篇、`3`=`<=8%`、`4`=`<=20%`、`5`=`<=40%`、`6`=`>40%`），以 `:1..:6` 后缀压缩编码进 `CILIN_RAW_DATA`。
   * 同步输出本地诊断报告 `oov_report.txt`（高频未收录英文术语与中文 OOV 候选 Top 60）。
   * **双重哈希防抖**（`synonyms.sha256` 保存 `rawSha|outSha`）：仅当未压缩源码或压缩目标变化时，才调用 `esbuild --minify --target=es2020`（无 `--bundle`，保留 ESM `export`）生成 `src/js/synonyms.js`。
4. **全局清单与 SW 注入**：
   * `Generator.generateManifest()` 计算所有静态资源的内容哈希，压缩写入 `src/js/core-list.js`（包含 `BUILD_VERSION`、`FILE_MANIFEST`、`dataIndex`），并自动同步更新根目录 `sw.js` 的 `importScripts` 与 `SW_VERSION`。
5. **Wasm 独立编译 (`_build/rs/`)**：
   * 当修改 `lib.rs` 时，通过 `wasm-pack` 编译产出 `src/wasm/compute_intensive_task_processor.min.js` 与 `compute_intensive_task_processor_bg.wasm`；清单扫描会自动捕获二者哈希变化并触发线上旧搜索缓存失效。

---

## 5. 运行流程与模块协作

### 5.1 启动与首屏链路

```text
index.html (成人校验 → 注入 PARAM 常量 → 加载 index.js / index.css)
  └─ window.onload
       ├─ 1. 远端应急指令探测 (2s 后绕缓存拉 /sw.js 校验 repair_command_id)
       ├─ 2. 恢复侧栏 flex 布局 & 初始化搜索框 (自定义 listbox + sf-bar 筛选条)
       ├─ 3. 加载 #side iframe (src/tpl/side.html)
       ├─ 4. 注册 Service Worker (sw()) 与更新接管监听 (snap())
       ├─ 5. loadScripts(6) 启动 90s 阶段看门狗:
       │       ├─ 预热 searchWorker (并行初始化 Wasm + import('./synonyms.js'))
       │       ├─ 预读 MainDB.chunks
       │       ├─ 加载 core-list.js → (本地) shadowIndex.js → lite_data.js
       │       ├─ 向 #side 推送 RENDER_CATALOG 立即渲染目录树
       │       ├─ 启动 restore_snap() 恢复主屏/视频/音频/搜索词状态，完成后展示 #search
       │       └─ loadDataInBatches(): 比对切片 hash → 增量拉取缺失/变更切片 → 原子落盘 IDB
       │            └─ postMessage('BUILD_DATA') (切换为 45s Wasm 构建看门狗)
       │                 └─ Worker 组装扁平数据、构建 IndexedDoc/DocFilter/CorpusBloom
       │                      └─ 返回 DATA_READY (slim 视图 + fp 指纹) → 清除看门狗、媒体 Diff 日志
       ├─ 6. 并行后台初始化: cmt_mapper() / startCommentSync() / loadPinyinData()
       └─ 7. 空闲回调 (idleRun): 7 天备份提醒 + (本地) 到期任务弹球 + (触屏) touchpad.js
```

### 5.2 跨 iframe 通信与多标签页隔离

* `index.js` 顶层生成唯一 `window.__TAB_ID__`（优先 `crypto.randomUUID()`）。
* 同源子页面（`side.js`、`content.js`、`bookmark.js`、`lightbox-logic.js`）均通过 `window.top.__TAB_ID__` 读取所属标签页 ID，并在 `BroadcastChannel('bus')` 发出的每条消息中携带 `tabId`。
* 接收端严格过滤 `if (tabId && myTab && tabId !== myTab) return;`。仅 `SEARCH_CACHE_CLEARED` 允许跨 Tab 广播以保持内存缓存同步，彻底根除多标签页互相跳转、重复保存摘抄与跨 Tab 清高亮的问题。

---

## 6. 核心引擎原理

### 6.1 Wasm 检索引擎 (`lib.rs`)

#### (1) 索引结构与两级过滤
* **预处理 (`install_data`)**：
  * 将每篇文档的标题、正文折叠为小写半角 `Vec<char>`（`fold_char` 统一处理全角空格 `\u{3000}`、全角 ASCII `\u{FF01}..\u{FF5E}` 及 Unicode 小写）。
  * **纯文件名策略**：所有非 `html` 资源（含 `gallery` 图片与 `video`/`audio`/`ebook`）在索引阶段调用 `strip_file_ext` 剥离最后一个 `.后缀`（要求 `dot > 0`），且不回退匹配路径目录，保证搜 `mp3`/`jpg`/`插曲` 不会误带出整类文件；`GLOBAL_DATA` 中仍保留完整文件名用于展示与点击打开。
* **全局语料布隆过滤器**：
  * `CORPUS_BLOOM`：1 MB（`131072` 个 `u64`，8,388,608 bits，4 哈希 bigram）。
  * `COMMENT_BLOOM`：256 KB（`32768` 个 `u64`，2,097,152 bits）。
  * Bigram 构建与 `try_match_at(eff_noise = 0)` 严格对齐：允许跨至多 1 个非硬断行空白建立 bigram，遇硬断行（`\n \r 。！？；!?;`）断开，保证 **Zero False Negative（零漏召回）**。
* **文档级自适应位图 (`DocFilter`)**：
  * 按文档字符数分 4 档分配 unigram 与 bigram 位图（`<=64` / `<=512` / `<=4096` / `>4096` 分别占用 `4/4`、`16/16`、`32/64`、`64/256` words）。
  * 扫描时先用 `ScanPlan`（含 256-bit `first_mask` 与首字倒排表 `by_first`）配合 `DocFilter` 过滤文档内不可能命中的候选词：0 命中直接跳过整篇文档，1 命中走单模式快路径，多命中按首字掩码单遍线性扫描。

#### (2) 宽容匹配与计分排序模型
* **噪值缩放**：`effective_noise = kw_len > 25 ? 0 : min(noise_level, kw_len / 2)`；单空白跳过不计噪，连续空白超 1 个开始计噪，硬断行阻断跨句匹配。
* **重叠区间统一裁决 (`merge_tagged_hits`)**：跨原词、同义词及 ADS 多正向词汇总重叠区间时，严格遵循：
  $$\text{tier (0 > 1 > 2)} \succ \text{noise (越小越优)} \succ \text{weight (越大越优)} \succ \text{span 长度 (越长越优)}$$
* **计分公式 (`weigh_section_hits` + `tier0_doc_bonus`)**：
  * 标题基准 `5000`（每噪 `-500`，词频饱和参数 $k=1$，同义词上限 `TITLE_SYN_CAP = 4500`）。
  * 正文基准 `100`（每噪 `-10`，词频饱和参数 $k=4$，同义词上限 `CONTENT_SYN_CAP = 450`）。
  * 次线性词频饱和：按单次命中分值降序排列，第 $i$ 次命中权重乘以 $\frac{k}{k+i}$，防止长文靠同义词堆砌反超精准命中。
  * 原词保底阶梯奖励（按文档最佳 `tier=0` 最小噪值）：0 噪 `+10000`、1 噪 `+3000`、2 噪 `+2200`、3 噪 `+1500`、4 噪 `+900`、5+ 噪 `+500`，确保精确命中永远稳居前列。

#### (3) ADS 布尔组合检索
* 前端 `parseAdsQuery()` 解析 `@[expr]词1[nl]词2[nl]...`（最大括号深度 8），通过德摩根定律下推否定转化为 NNF 树（仅含 `and` / `or` / 带 `neg` 标记的 `term`），并在前端与 Wasm 双重校验 `adsHoldsOnEmpty`（防止全否定查询匹配全库）。
* Wasm 端 `ads_optimize()` 对 `And` 子句按 `(非否定优先, 噪值升序, 词长降序)` 重排实现短路加速；单文档复用 `AdsScratch` 状态缓存，避免重复扫描；同时支持正文与评论联合布尔求值，并通过二次纯正文求值准确标记 `viaComment`。

### 6.2 近义词扩展引擎 (`synonyms.js v5.1`)

1. **查词分流**：
   * **情况 A（整词/短语直达）**：所有词库键均经 `compactKey()`（半角 + 去空白 + 小写）索引，使带空格现代短语（如 `Stable Diffusion`）也能直接命中自定义双向组或单向别名。
   * **情况 B（独立词保护）**：单块输入若直接命中 `#`/`@` 独立词或 `stopExpand` 技术术语（如 `指针`、`容器`、`缓存`、`宏定义`），不强行拆字乱扩。
   * **情况 C（DP 分词 + 上下文消歧）**：按空白分块执行全词表动态规划最优切分（保护英文词边界 `hasValidAsciiBoundary`），其余词的 5 级词林码作为上下文参与 LCA 树距离加权（同 5 级 `1.85x`、同 4 级 `1.45x`、同 2 级 `1.18x`）。
2. **DF 软加权与隐私兼容**：
   * 候选词得分乘以 `DF_CAND_MULT[bucket]`（中低频特征词最高 `1.18x`，超高频泛词压低至 `0.38x`，公网未出现词降权为 `0.62x` 而非硬删除）。
   * 义项消歧叠加 `senseDfBoost`：同义组内活跃语料词越多，该义项权重越高；虚词大类 `K`/`L` 分别降权至 `0.22x` / `0.55x`。
   * 运行时通过 Worker 注入 `existsInCorpus: (w) => bloom_might_match(w)` 过滤当前全库（含本地私密影子与动态评论）不存在的候选变体，兼顾隐私与零浪费扫描。
3. **权重映射**：自定义双向组 `weight=88`、单向别名 `weight=85`、词林单槽 `35~80`（`tier=1`）、双槽联合替换 `25~55`（`tier=2`，需词表或 Bloom 验证），全部限定 `maxNoise=0` 防止语义漂移叠加高噪爆炸。

### 6.3 页面 Diff、双语固化、账本与书签引擎

* **LCS Diff (`content.js` + `lib.rs`)**：将历史快照与当前页 `<pre>` 均渲染为标准化 Token 序列（`html_line`、`table_row`、`code_line`），调用 Rust `similar::capture_diff_slices(Algorithm::Lcs)` 计算最小编辑脚本（超过 `25,000,000` 单元格自动降级避免 OOM），着色渲染 `#diff-pre` 与 `#diff-minimap`。启动 Diff 时自动退出当前页搜索导航并向主页面发 `CLEAR_SEARCH`；处于 `_isDiffMode` 时拦截 `search()` 与 `REFRESH_HIGHLIGHT`，避免 DOM 隐藏冲突。
* **双语固化 (`bilingual.js`)**：本地编辑时防抖 2s 暂存至 `AlignDrafts` IDB；点击固化时克隆文档并剥离 19 类运行期注入节点（`#bar`、`#toc`、`.code-tools`、`#diff-pre`、Prism 资源等）写入剪贴板，`await destroyDraft()` 后触发 `://5{`，并轮询检测磁盘更新自动重载（8s 后给出手动解锁兜底）。
* **账本解析 (`txn_parser.js`)**：手写递归下降四则算式求值器 `evalAmount`（禁用 `eval`，32 层括号深度限制，中间态 `scrubFloat` 抹除浮点噪声、最终 `roundCent` 一次性取整到分）；异步拉取实时汇率后通过 `data-amt`/`data-expr` 原地无损刷新 `.tip`，不重置用户正在操作的筛选面板。
* **书签固化 (`bookmark.js` + `BookmarkManager.java`)**：拖拽触发 `://2{` 后，Java 端完成增删移与 `#end_flag` 更新并通过同目录 `.tmp` 原子替换落盘；前端 `index.js` 30s 轮询比对 `bookmarkhtml_linksHash` 刷新 iframe，`bookmark.js` 拖拽锁超时（31s）与轮询窗口严格对齐。

---

## 7. 性能设计与实测级优化特征

| 优化点 | 实现机制 | 效果 |
| :--- | :--- | :--- |
| **Worker 自适应时间片** | `SLICE_MS = 8ms` 动态调节 `sliceDocs`（`16..4096`），通过 `MessageChannel` 微宏任务让出队列检查 `latestToken` | 连续键入时旧搜索毫秒级抢占取消，UI 与输入零卡顿 |
| **Wasm 预编译执行计划** | `prepare_search` / `prepare_ads_search` / `prepare_comment_search` 在首片前一次性编译 `ScanPlan` 并做 Bloom 裁剪 | 避免分片循环中重复反序列化 JS 词表与重建字符表 |
| **首屏大包合并策略** | `sw.js` 设置 `CORE_BUNDLE_THRESHOLD = 15`，首次安装或大版本更新走单个 `core-bundle.json` 内存解压写入 CacheStorage，小更新走单文件并发拉取（按 `2g`/`3g`/`4g` 动态调节并发 `1/2/4`） | 规避数百个小文件的 HTTP 建连瀑布，增量更新极省流量 |
| **按需代码拆分** | `deferred-features.js`、`excerpts.js`、`lightbox-logic.js`、`touchpad.js`、`confetti.browser.min.js`、`prism.js` 全部懒加载 | 桌面端首屏不下载触控板、彩带、代码高亮器与摘抄薄代码 |
| **主线程零词库负担** | `synonyms.js` 仅在 Worker 内 `import()`，主线程与 `content.js` 通过 `termSpecsCache`（LRU 256）及 `EXPAND_QUERY` 按需同步当前查询的扩展规格 | 释放主线程解析阻塞与内存占用 |
| **CSS Custom Highlight** | 仅创建 `Range` 塞入全局 `Highlight` 对象，完全不插入 `<mark>`/`<span>` 包裹节点 | 万字长文千处命中瞬时高亮，销毁与重绘零重排 |

---

## 8. 关键时序与并发状态机

### 8.1 搜索请求抢占与代际一致时序

```text
用户输入 → debounce (普通 150ms / ADS 450ms) → ++window._searchToken
  ├─ 查 searchResultCache (内存 48 → IDB LRU 500)
  │    ├─ 精确命中: CANCEL Worker 旧任务 + 异步补查评论 + 渲染缓存
  │    └─ 未命中 (或非近义前缀命中先出 provisional 预览): postMessage(SEARCH / SEARCH_ADS, token, ns)
  └─ Worker:
       ├─ 收到新请求即 bumpToken(token)，旧分片扫描在下一 8ms 边界直接 return null
       ├─ 普通扫描监测 dataGen；ADS 扫描监测 `${dataGen}:${commentGen}`
       │    └─ 若中途收到 BUILD_DATA 或 SET_COMMENTS（清空 PREPARED_ADS），自动重新 prepare 并从头扫描，绝不静默截断
       └─ 返回结果携带 token 与 ns (computeQueryContextSig)；主线程双重核验 token 与 ns 匹配后才渲染并落盘缓存
```

### 8.2 SW 更新与快照接管时序

```text
轮询 reg.update() (线上 10s / 本地 2s / 切回可见标签页)
  └─ 发现新版 sw.js → install 阶段
       ├─ 对比 oldManifest (优先旧版本桶，同 BUILD_VERSION 重装回退同名桶)
       ├─ 变更的 /html/* 后台并发压缩存入 MainDB.html_snapshots (时间戳+字节去重)
       ├─ synonyms.js / .wasm / 胶水 JS 变更 → 写 sys_state['pending_search_cache_clear']
       ├─ 非关键文件失败降级复用旧响应时，committedManifest 保留 oldManifest[url] 哈希
       └─ 进入 waiting 状态:
            ├─ 本地模式: 自动 SKIP_WAITING
            └─ 线上模式: 侧栏顶部弹出“发现新版本, 点击更新”
                 (此时页面继续刷新仍由旧 SW 提供旧版 core-list.js，绝不发生“旧代码+新数据”版本撕裂)
  └─ 用户点击更新 → execute_update (按 TAB_ID 隔离) → SKIP_WAITING → activate
       ├─ 删除过期 core-cache-* 桶
       ├─ 若存在 pending_search_cache_clear → 清空 search_cache 与 LRU 索引
       └─ clients.claim() → 触发主页面 controllerchange
            └─ takeSnapshot(true) 捕捉主屏/视频/音频/搜索词写入 sessionStorage → reload
                 └─ 新版启动 → restore_snap() 校验 lite_data 完整性 → 恢复视图 & 播放彩带 + What's new?
```

### 8.3 阶段看门狗与非破坏性自愈

* `loadScripts` 启动 **90 秒**看门狗；数据送入 Worker 后切换为 **45 秒** Wasm 构建看门狗；`DATA_READY` 到达立即清除。
* 超时不再静默炸库，而是写入 `#sf-status` 错误提示并弹出确认框，由用户决定继续等待还是触发 `executeSelfHealing()`，避免慢网环境下误删用户积累的 `html_snapshots` 与 `update_logs`。

---

## 9. 多层缓存体系与失效矩阵

### 9.1 存储分层一览

| 存储介质 | 命名空间 / 库表 | 存储内容 | 容量/淘汰策略 |
| :--- | :--- | :--- | :--- |
| **Cache Storage** | `core-cache-{BUILD_VERSION}` | 站点壳代码、HTML、CSS、Wasm、`synonyms.js`、`sw-manifest.json` | 严格按桶读写（不跨桶全局匹配），`activate` 时删除旧版本桶 |
| **Cache Storage** | `media-cache` | 媒体文件（`gallery/video/audio/ebook`）、字体与 `cmaps` | 按需缓存，媒体 Diff 侦测到删除时定向 `delete` |
| **IndexedDB** | `MainDB` (v3) | `chunks`（fat 切片）、`update_logs`（更新日志）、`search_cache`（搜索结果）、`sys_state`（LRU/命名空间/媒体快照/评论快照）、`html_snapshots`（HTML 历史压缩包） | `search_cache` 最多 500 条 LRU（单次命中 >300 不入库）；`html_snapshots` 每页最多 10 版 |
| **IndexedDB** | `ExcerptsDB` (v1) | `books`（按书名/html 归档的摘抄） | 单例连接缓存，原子单事务读取 |
| **IndexedDB** | `SideDB` (v1) | `marks`（侧栏删除线标记） | 单例连接 + 断线自动重连 `ensureDB()` |
| **IndexedDB** | `AlignDrafts` (v1) | `draft_texts`（本地双语页自动暂存草稿） | 单例连接，固化前 `await destroyDraft()` |
| **localStorage** | 业务键 + `txn_*` | 布局、历史（50）、搜索历史（100）、收藏、滚动位置、媒体进度（500）、壁纸、筛选/噪值/近义设置、账本视图与汇率 | 每分钟 `ls_alert()` 监控，超 4MB 预警 |
| **sessionStorage** | `ss_restore_strict` | SW 升级 / `@bomb` Plan A / `@rebirth` 重载前的一次性页面快照 | 读取后立即删除 |

### 9.2 搜索缓存精确失效链路

搜索缓存键格式为 `n{noise}|l{syn}|normalizedKw`，并绑定双命名空间槽位（持久化在 `MainDB.sys_state`）：
1. **`core` 槽位**：`v{SEARCH_ALGO_VER}|d:{window._dataFp}`（当前 `SEARCH_ALGO_VER = 11`；任何前端/Wasm 搜索语义调整或切片内容变动，都会自动清空 `search_cache`）。
2. **`syn` 槽位**：`syn:{hash(synonymIndex.version + '|' + synonymIndex.sig)}`（`cilin-1hop-df-v5.1` 规则、自定义词库或 DF 分桶任一变化即自动失效）。
3. **SW 激活兜底**：`synonyms.js`、`.wasm` 或 Wasm 胶水 JS 哈希变更时，SW 在 `activate` 阶段同步清空 `search_cache` 与 `search_cache_lru`。

---

## 10. 更新、降级与灾难恢复机制

1. **版本一致保护**：线上模式下 SW 直接用自身激活态的 `FILE_MANIFEST` 响应 `core-list.js`，消除新 SW `waiting` 期间的“旧代码拉新数据”撕裂；旧缓存回退保留旧 hash，确保下次网络恢复可重新拉取修复。
2. **离线降级**：无网时 `sw.js` 从 `sw-manifest.json` 构造数值有序的 `dataIndex`；`index.js` 检测到离线降级标志或 `navigator.onLine === false` 时跳过切片网络拉取，直接用 IDB 存量切片构建 Wasm 索引。
3. **本地/直连回退**：`cmt_mapper()` 与 `loadPinyinData()` 支持在 SW 未接管或本地模式（不写 CacheStorage）下回退直接 `fetch()`，避免无缓存时的长时间空轮询。
4. **三级应急自愈**：
   * **远端指令**：更新 `sw.js` 中的 `repair_command_id` 递增数字，客户端启动 2s 探测到远端值大于本地基线即执行全清自愈。
   * **URL 手动指令**：访问 `/?repair=1` 强制注销 SW、清空缓存与 `MainDB` 并回到首页。
   * **交互式重置/恢复**：搜索框输入 `@bomb`（支持“保留所选 / 导出全清 / 全部清理”，清库前主动关闭 `dbProxy`/`ExcerptsSys`/`MarkSystem` 句柄并先抓快照防丢失）与 `@rebirth`（导入 JSON 恢复，覆盖音乐、标记、历史、布局、滚动、搜索历史、偏好与播控进度、PDF/EPUB/TXT 进度、摘抄薄）。

---

## 11. 客观优缺点分析

### 优点
* **极致低成本与高自主权**：纯静态文件零运维成本，任意静态托管或本地 HTTP 服务即可完整运行，数据全归用户掌控。
* **检索能力远超普通静态站**：在纯浏览器端实现了宽容噪值匹配、布尔组合检索、DF 软加权词林同义扩展、评论融合检索与精准上下文片段预览。
* **离线与增量体验成熟**：支持增量大包/单文件自适应同步、断网全功能查阅、本地版本 Diff 追溯与无缝快照热更新。
* **隐私工程严谨**：公开切片、影子切片、DF 词频统计与 Bloom 校验职责清晰，线上线下隔离彻底。

### 局限与权衡
* **全量正文常驻内存上限**：Wasm `GLOBAL_DATA` + `INDEXED_DOCS` 需将全站公开正文载入 Worker 内存。当前规模（约 2~5 MB 文本，内存约 10~20 MB）非常轻快；若未来正文文本膨胀至 50~100 MB 以上，启动反序列化与内存占用将显著抬升。
* **单机本地状态分散在浏览器存储**：标记、摘抄、历史版本快照、播控进度依赖浏览器本地 `localStorage` / `IndexedDB`，跨设备同步目前依赖 7 天 JSON 手动导出与 `@rebirth` 导入。
* **构建脚本平台耦合**：`CLI.bat` 与自定义 URL 协议注册强依赖 Windows 环境（Batch / `certutil` / PowerShell）。
* **CSS Custom Highlight 兼容性边界**：依赖较新的 Chromium / Safari / Firefox 内核，老旧浏览器仅能展示结果列表而无法渲染页内高亮。
* **无自动测试套件**：Java / Rust / 前端 JS 之间的契约（如 `pack_hl_meta` 位布局、`FILE_MANIFEST` 格式、`BUS` 消息协议）目前主要靠人工联调和审计保证。

---

## 12. 后续演进与提升方向

1. **自动化契约测试（高性价比）**：
   * 在 Rust 侧补齐 `cargo test` 单元测试（覆盖宽容噪值、硬断行、非 HTML 去后缀、ADS 短路与计分排序）；
   * 增加轻量 Node/Playwright 冒烟测试，自动化验证 `synonyms.js` 扩展用例（含带空格短语、stopExpand、单向别名）与 SW 升级/快照恢复流程。
2. **Wasm 二进制索引快照（面向更大语料）**：
   * 若未来文章体积超过 20 MB，可将构建期或首次构建后的 `IndexedDoc` / `DocFilter` / `CorpusBloom` 序列化为紧凑二进制写入 IDB，二次冷启动直接 mmap/反序列化进 Wasm 线性内存，跳过字符折叠与位图重建。
3. **跨设备加密云同步（可选增强）**：
   * 利用已有 GitHub 私有仓库或 WebDAV，将 `@bomb` / `initBackupReminder` 导出的结构化 JSON（含 `ExcerptsDB`、`SideDB`、`localStorage` 偏好）在客户端经 Web Crypto API（AES-GCM）加密后增量同步。
4. **首屏解析微优化**：
   * 将 `index.html` 中通过内联脚本动态赋值的 `index.js` / `index.css` 改为静态 `<link>` / `<script defer>`，让浏览器 HTML Preload Scanner 提前并行拉取核心资源。
5. **构建器跨平台化**：
   * 将 `CLI.bat` 的增量哈希与 `esbuild` 调度收敛进 `gen.jar` 或轻量 Python/Node 脚本中，使 Windows / macOS / Linux 可共用同一套构建入口。