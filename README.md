# 花园培植
- 本人觉得有趣的、有启发性的、阴暗的东西，以及各类总结、备忘、导航
---

# 基建
- 这是一套 DIY 静态文档检索系统, 特点包括：
  - 聚合浏览
    - HTML、PDF、EPUB、TXT、图片、音视频、全景图
  - 超级搜索
  - 增量热更新
  - 离线高可用
  - 公私文件并存
  - 版本比对
  - 摘抄管理
  - 状态快照
- 工具链
  - HTTP Server、Custom URL Protocol、Batch、Java、Rust、Git
- Web 平台
  - Vanilla JS、iframe、BroadcastChannel、postMessage、Proxy、localStorage、Service Worker、IndexedDB、Web Worker、WebAssembly、CSS Custom Highlight
> Workflow designed by diff4x | Optimized or implemented by Gemini & ChatGPT & Claude & Grok
---

## 使用
- 搜索
  - 按 `\` 定位到搜索框, 不同类型的结果区别着色
  - 宽容语义
    - 填空搜索, "烟侍椅" 可命中 "烟枪侍女太师椅"
    - 近义搜索, "他简直是秀逗了" 可命中 "他一定是糊涂了"
  - 悬停, 右击, 中击
    - 对于 html 条目 hover 弹窗显示包含搜索词的上下文片段, 右击滚动或停止
    - 对于图片条目 hover 弹窗小图预览
    - 对于音频和视频条目, 右击弹窗加载播放, 再次右击停止播放
    - 中击结果列表、历史词列表、搜索框, 等同点击 clear 退出搜索
  - 按日期搜索
    - html 页面时间戳和 `img` 图片名皆按格式`yyyymmddhhmmss`
    - 例如查找2024年1月份更新过的页面, 可输入 `202401` 或更短的 `2401`
  - 搜索框内置命令 (回车生效)
    - `@noise=n` 设置搜索宽容度（n 取值 0~5，默认 5）, 相邻两个搜索词字符之间，最多允许插入 n 个非空白杂字 
      - 搜索词长 (不含空格) 超过 `25` 自动从宽容匹配降为完全匹配 
        - `[@noise=5, 有效词长25]` 将跨越24 (间隙) × 5 (最大杂字) + 25 (搜索词本体) = 145 个有效字符, 在一两百字里零星拼凑出 25 个字，结果通常是无意义的噪点
    - `@bomb`, `@rebirth` 分别进行可选式重置与恢复个人数据
- 页面
  - 本地按页面左上角 `edit` 即以本地编辑器打开对应实体页同时覆写时间戳, 编辑完回到页面, 双击顶部菜单中 `CLI` 即时构建呈现
  - 页面左上角 `diff` 查看版本差异
  - `html`, `pdf`, `epub`, `txt` 页面选中单字提示拼音, 多字提示摘抄
  - `pdf`, `epub`, `txt` 横向对开
  - `gallery`, `video`, `pdf`, `txt` 中击全屏
  - `code` 区域双击编辑
  - 线上时私有条目自动加小锁提示
  - 本地首页(书签页)通过拖拽内部或外部书签实现即时增删移, 这些操作都是固化的
  - 本地双语比对支持页面内即时修改与固化
  - 侧栏支持条目 `mark`
  - 侧栏 hover 图片视频条目显示缩略
  - 侧栏双击条目复制条目名
    - 桌面端需临时禁用 QTranslate
  - 侧栏右键单击弹出书签, 右键双击调出原始菜单
  - 侧栏栏宽可调, 分类附有其下的文件数量,近期更新过的页面数量并有颜色醒目
  - 侧栏菜单条目
    - What's new? 查看版本日志
    - History 浏览记录
    - Fav 音乐收藏
    - Excerpts 摘抄薄
    - CLI.bat 单击选择操作, 双击直接构建
    - root/ 本地 repo
    - Katrain 本地围棋
    - go_board 棋盘
    - street_view_uploader 全景上传
    - txn_parser 当前流水解析
  - 音频播放器支持 `fav` 标记和竖直播放进度
  - 视频频播放器支持外挂字幕、字幕延迟微调
  - 灯箱支持拖动, 滚轮缩放
  - `gallery` 中全景图片文件名称约定前缀 `pano_`, 双击进入沉浸式浏览
    - `gallery/img` 默认为 `HTML` 页面同级引用源
    - `As wallpaper` 添加到 bookmark 壁纸列表, 在 bookmark 页面右下角集中管理
- HTML 预设规则
  - 正文: 直接写在 `<pre>` 标签内，免除 `<br>`
  - h 标签：行首 `n`个`#` + 空格，自动转换为 `<h{n}>` 参与页内目录生成
  - 层级缩进：行首使用 `4` 的倍数个空格 `4, 8, 12, 16`缩进，自动赋予对应的块级着色
  - 链接解析：相对路径或完整 `URL` 自动被 `<img>` 或 `<a>` 包裹
  - 轻量表格：写在 `<p>` 标签中，行间以 `|` 分隔，自动渲染为 `<table><td>`
  - 代码着色：使用 `<code c>` 即表示要渲染的目标语种为 `c`
  - 文件名：
    - 开头仅以 `1` 个 `_` 命名的 html 文件定义为超大型文档
      - 正文不参与切片制作, 但在该页面下所进行的搜索结果可被持久化
    - 开头以 `2` 个 `_` 命名的 html 文件定义为私人页面
      - 正文参与切片制作但不参与发布, 仅线下可被搜索及访问
- CLI
  - `gen` 核心构建, 扫描资源目录与 `html` 正文生成数据切片, 压缩源码, 维护文件哈希账本与评论映射
  - `new` 交互指定标题和分类链, 分类链中以`|`作为子类分隔符
  - `keep2html` 要求笔记已归档,便于转换之后在归档里删除原笔记
    - 笔记正文中使用 `[[IMG序号]]` 占位标记来决定将来的html页面中同样位置将引用笔记中的第几张图片
    - 单一时标签要两个,其中一个固定为 `single`,另一个将作为 `html` 分类,笔记标题作为 `html` 的 `title`
    - 多合一时要有共同的标签名,连同分类名在 `CLI` 中交互指定,此标签名也会作为 `html` 的 `title` ,原笔记标题被替为 `h1`
  - `webp` 将配置的截图目录下的图片转为 `webp` 并落盘至 `gallery/img`, 同时将文件名复制到剪贴板, 贴进 `html` 双击页面右上角标题重载即显
  - `static-web-server` 本地运维, 启用本地虚拟服务器 [8000 error] 同时打开站点首页
  - `push` git push
  - `registering-protocol` 本地 `url` 协议注册
  - `simulation` 线上仿真, 启用本地虚拟服务器 [9000 info] 同时在隐身窗口打开站点首页
  - `vpn-heartbeat-tray` 任务栏常驻互联网状态标识 & `Google Tasks API` 轮询
- 移动端虚拟触控板
  - [光标映射区] 镜头跟随
  - [▲ / ▼] 滚动结果列表或内文目录
  - [+ / -] 缩放页面
  - [框选] 启用后按钮高亮, 滑动选中文字, 停用框选, 提示拼音或进行摘抄
  - [拖拽] 作用于浮动窗[日志,摘抄,评论]标题栏, 启用后按钮高亮, 窗口跟随光标移动
  - [左双击] 用于全景图沉浸浏览, 以及 side 条目文本复制, 音频播放器销毁
  - [中击] 用于全屏或退出搜索
  - [右击] 用于搜索结果中的音视频条目预览, 以及 side 区域书签呼出
  - [日志] 调试消息
- 其它
  - `cmt_mapper` 中 `records` 记录评论与页面 `title` 的对应关系, `orphanIds` 记录孤立失联的评论便于定点清除
  - 异常修复：
    - 站点地址附带 `?repair=1` 重新访问
    - 若搜索框可见, 输入 `@bomb` 可彻底重置
---

## 目录结构
```text
📂 _build 
 ┣ 📂 esbuild | libwebp                # 压缩
 ┣ 📂 server                           # 本地服务器
 ┣ 📂 jar                              # 数据清洗
 ┣ 📂 rs                               # 冷排
 ┣ 📂 secrets                          # 凭据,任务,流水
 ┣ 📂 woff2_split                      # 字体切片
 ┣ 📜 CLI.bat                          # 构建入口
 ┗ 📜 config.properties                # 配置
📂 audio | ebook | gallery | video     # 多层级 (类资源管理器)
📂 html                                # 单一层级 (遵循 HTML 预设规则)
📂 src
 ┣ 📂 css | js
 ┣ 📂 third                            # 三方库
 ┣  ┣ 📂 bibi
 ┣  ┣ 📂 pdfjs
 ┣  ┣ 📂 photo-sphere-viewer
 ┣  ┣ 📂 prism
 ┣  ┗ 📂 other
 ┣ 📂 wasm
 ┣ 📂 tpl                              # 样板
 ┗ 📜 cmt_mapper.json                  # 评论映射
📜 .gitignore                          # 私有节点清单
📜 index.html
📜 README.md                           # 即你所见
📜 sw.js                               # 缓存路由
```
---

## 数据演变
- HTML
  - fileName、title、htmlContent、cleanText
  - 状态标记
    - timeStamp
    - isGitIgnored（是否命中私有文件清单）
    - isExcluded（是否命中大型文档清单）
  - 评论映射
    - records 中为此 title 分配或关联一个独立 currentRecordId
- 媒体 
  - link, type, local（向下穿透继承的私有标记）
  - 不参与正文检索和评论映射，ID 统一为 -1
- 轻数据
  - HTML [文件名, currentRecordId, "html", "时间戳-localOnly(如果有)"]
  - 媒体 [文件名, -1, 具体的type, "localOnly(如果有)"]
- 胖数据
  - currentRecordId -> cleanText (公开) | "localOnly" (私有) | "" (被排除的大型文档)
- 影子数据
  - currentRecordId -> cleanText (私有)
- 核心包
  - 虚拟路由路径 -> htmlContent
  - 实际路由路径 -> css | json
- 哈希表
  - path -> FileMeta [hash, source]
  - 压缩后 `目录|文件1:hash:来源标记*文件2:hash:来源标记`
  - source[0: standalone, 1: core-bundle.json, 2: no_cache]
- window.data
  - 标题, 正文, 路径, 类型
    - 标题
      - HTML： 已剔除 .html 后缀
      - 媒体： 保持物理文件的全名
    - 正文
      - 公开 HTML： cleanText
      - 私有 HTML： 线上 "localOnly", 线下 "localOnly" + 影子切片明文
      - 公开媒体： ""
      - 私有媒体： "localOnly"
    - 路径
      - HTML： 固定的二级虚拟路由：html/文件名.html
      - 媒体： 相对物理路径
    - 类型
      - "html" | "image" | "ebook" (pdf/epub/txt) | "video" | "audio" 
