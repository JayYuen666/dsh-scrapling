<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-scrapling@main/icon.svg" width="96" height="96" alt="dsh-scrapling logo" />
</p>

<h1 align="center">dsh-scrapling</h1>

<p align="center"><em>把 Scrapling 的网页抓取带给 dsh：JavaScript 渲染、结构化抽取与后台爬虫，由一个常驻 Python 进程驱动。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-scrapling"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-scrapling?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-scrapling"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-scrapling?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-scrapling/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-scrapling/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,python,react,nodejs,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一条 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的网页抓取扩展：把 [Scrapling](https://github.com/D4Vinci/Scrapling) 封装成 agent 工具 —— JavaScript 渲染、带选择器自愈的 CSS/XPath 结构化抽取、可存登录态的会话、后台爬虫与页面问答。解释器与浏览器引擎由你提供；一切跑在同一个常驻 Python 进程里。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [确认它真的在工作](#确认它真的在工作)
- [它不提供什么](#它不提供什么)
- [在 dsh 里启用](#在-dsh-里启用)
- [工具一览](#工具一览)
- [替代内置的抓取与搜索](#替代内置的抓取与搜索)
- [设置项](#设置项)
- [代理](#代理)
- [安全说明](#安全说明)
- [数据与隐私](#数据与隐私)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可证](#许可证)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

dsh 自带 `web_fetch` 与 `web_search`。内置的 `web_fetch` 刻意做「诚实且最小」：纯 HTTP(S) GET，不执行 JavaScript，UA 也是诚实的。作为默认档这没问题 —— 代价是**单页应用只会拿到加载中的空壳**，而且没法要求「只给我那个商品表格」。在一个「内容只有 JS 执行后才出现」的页面上实测：

| 管线 | 拿到的文本 |
|---|---|
| 原始 HTML 转文本（无 JS） | `SPA Shell / LOADING_PLACEHOLDER` |
| `Fetcher`（curl_cffi，同样无 JS） | `SPA Shell / LOADING_PLACEHOLDER` |
| 浏览器渲染（patchright） | 完整渲染后的 DOM、Markdown 表格、结构化行 |

本包补的是内置工具结构上做不到的事：

- **浏览器渲染** —— 经 patchright 执行 JavaScript。
- **结构化抽取** —— CSS/XPath 选择后返回数据，而不是一大坨 Markdown。
- **选择器自愈** —— Scrapling 的 `adaptive` 模式能在站点改版后重新定位元素；class 改名后原选择器返回 `None`，`adaptive` 打开时能重定位到元素。

一切都在**同一个常驻 Python 进程**里跑。这不是优化选择：Scrapling 的会话类要保留 cookie，浏览器引擎要保留页面池，`adaptive` 要保留 SQLite 指纹库 —— 每次调用起一个进程，这些东西全都会丢。工具是**条件注册**的：插件启动时先探测运行环境真正具备什么，只注册能用的，模型不会浪费一轮去调用一个注定失败的工具。每个工具的结果行都经官方 tool-call 视图槽渲染。`scrapling_answer` 是唯一会**再调一次模型**的工具 —— 见[工具一览](#工具一览)。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-scrapling
```

卸载用 `dsh plugin --profile web remove @jayyuen66/dsh-scrapling`。包在公共 npm registry 上，安装不需要凭据，也不需要 scoped-registry 配置行。

- **需要 Node.js `>= 22.12`。** 本包是 ESM-only；正是这条 Node 下限让 `require()` 一个 ESM 入口得以工作，`engines.node` 因此声明。
- **需要宿主 `dsh` 处在 `0.2.1-rc.3` 版本线。** 宿主真正读的是 `engines.dsh`（`^0.2.1-rc.3`），且它**单独决定**；更新版本线的宿主会被拒，需要显式风险授权 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`。
- **需要 Python 3.14+ 且装好 Scrapling** —— 在仓内 `_env/.venv` 里、能从 `PATH` 找到、或由 `pythonBin` 指定。装出去的包里没有 `_env/.venv` 这一档，解释器就是你 `PATH` 上的 `python3`；选中哪一支会在装载时写进日志，缺 Scrapling 时报错里带着可直接照抄的安装命令。

```sh
pip install "scrapling[rag]>=0.5,<0.6"
python -m patchright install chromium
```

- **为什么是 `rag` 而不是 `fetchers`：** `rag` 就是 `fetchers` 再加上 `markdownify`，而 `extractionType` 默认是 `markdown` —— 装成 `fetchers` 的话，第一次抓取就会在 Markdown 转换处抛 `ModuleNotFoundError`。
- **版本范围：** 本包在 Scrapling **0.5** 上开发与验证，依赖的 `Selector`、`Spider`、`SessionManager` 与转换器的去噪接口都不是稳定 API 面，所以上界钉在 `0.6` 之前；装到范围外时守卫照常运行，但反注入清洗与爬虫链路可能不按预期。0.5 里浏览器后端只剩 patchright（原来独立的 stealth 抓取工具随之删除，反检测参数都在 `scrapling_render` 上）；`capture_xhr` 改成会话级记录（于是有了 `scrapling_session_network`）；`extra_flags` 改为叠加 —— 本包一支都不发，WebRTC 防泄露由 `blockWebrtc` 开关承担。
- **浏览器引擎完全由用户负责。** 插件不下载任何东西。没有浏览器时它只是不注册依赖浏览器的工具，模型不会浪费一轮去调用它们。
- **`dependencies` 里没有 `@deepseek-ai/*`，这是契约**（`test/publish-manifest.test.ts` 钉住）。消费方 profile 以 `nodeLinker: hoisted` 与 `autoInstallPeers: false` 安装，宿主包一旦进了 `dependencies` 就会物化成真实存在的第二份副本，模块级状态与运行中的宿主裂开 —— 每次原生工具调用都抛错，而构建与测试一路绿。产物按值 import 的宿主包都是 required peer 并保持外部化；门禁会把构建产物真的载入一次、断言没有内联的宿主包正文。
- **产物是 ESM-only 且从不提交** —— `prepack` 重建它，发出去的永远是当前源码产出的那份。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

profile 若用 pnpm `overrides` 钉了 `@jayyuen66/dsh-plugin-shared`，钉的值不得低于本包声明的版本。钉低了会装到一份缺少源码所需名字的产物，宿主启动时报 `N entries did not activate` 与 `does not provide an export named ...` —— 包装得上、永远不装载，任何单仓 CI 都看不见。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **层已挂载。** `dsh --profile web --dump-config` 能看到本包的层行。
   - 这条命令是唯一被认的「它在层栈里」信号，而且它**不是只读的** —— 会把 profile 的根装配文件重写一遍。层行从 stdout 读，stderr **单独**查：未命中的 patch 目标只出现在 stderr，只看退出码证明不了任何事。`# == <层>` 与 `# == <层>, patched by <路径>` 两种形态都要认。
2. **启动日志点名解释器与注册计划。** 有一行打印探测到的能力与注册了几个工具；选中的解释器路径在装载时写进日志。解释器起得来但没装 Scrapling 时，日志点名解释器路径，并附可直接照抄的 pip 命令。
3. **设置卡渲染。** 插件详情页上有 **scrapling** 卡，全部用户可改字段按用途分组；改一个值后保存按钮亮起，写入返回 200。
4. **一次工具往返。** 让模型抓一个重 JS 的页面：结果行经官方 tool-call 视图渲染在会话里。没有浏览器的机器上，render / capture_xhr 不在模型的工具列表里，对应的提示指引也一并消失 —— 那是条件注册在起作用，不是故障。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

- **它不是搜索引擎。** Scrapling 的 `google_search` 选项只是加一个 Google referer 头；检索需要部署级的 `searchEndpoint`（见[设置项](#设置项)）。没配它，search provider 一直不可用，内置 `web_search` 保持原行为。
- **它不下载任何东西。** Python 解释器与浏览器引擎由你提供；缺什么就少注册什么，不会替你抓。
- **它不自开 HTTP 路由。** 设置卡是宿主的配置表单；本包没有自己的 `/api` 面。
- **它不加 CLI 子命令。**

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，唯一一行注册是 `- id: scrapling`，`name` 用**裸包名** —— 宿主只扫裸包名条目的 `dsh.client` 声明。
- client 半注册两个面：设置卡（坐在 `plugins.bundle.config` 槽上，键是 bundle 包名 —— 宿主按 `entryKey: pkg.name` 派发，所以卡画在本包的详情页上），以及每个工具在 `tool.call.toolview` 上的一行结果，用官方 tool-call 视图 props 画。
- 设置命名空间就是条目 id `scrapling`；优先级为 设置卡现值 > 注册行 `config:` > schema 默认值。把一项改回默认值保存的是**清除覆盖**而不是写入同一个值，将来默认值变了你这一项也会跟着变。
- 闸门策略与 sidecar 环境在插件 `apply()` 时取一次快照 —— **设置卡的改动要等下次启动才生效**。
- 关掉某个工具时，它的 system prompt 指引段也一并消失：指引每次装配都按「那个 scope 真注册着哪些工具」现取，没装浏览器的机器少掉 render / capture_xhr 那几句，sidecar 没起来的机器一句都没有。指引段排在内置 `web_fetch` 指引旁边。
- `scrapling_crawl` 登记自己的作业类型，`job_list` 因此把它的作业标成爬虫而不是 shell 作业。

## <img src="https://api.iconify.design/lucide/globe.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 工具一览

十三个工具，每个背后一枚设置开关，全部有测试覆盖：

| 工具 | 后端 | 需要浏览器 | 并发 |
|---|---|---|---|
| `scrapling_fetch` | `Fetcher`（curl_cffi） | 否 | 可并发；开了 `allowWriteMethods` 之后写动词转串行 |
| `scrapling_extract` | `Selector` + CSS/XPath + `adaptive` | 否 | 可并发 |
| `scrapling_render` | `StealthySession`（patchright） | 是 | 串行；反检测开关（`solveCloudflare` / `hideCanvas` / `blockWebrtc`）也在这一条上 |
| `scrapling_capture_xhr` | 单页临时会话、页级记录 | 是 | 串行 |
| `scrapling_session_open` / `scrapling_session_fetch` / `scrapling_session_network` / `scrapling_session_state_save` / `scrapling_session_state_load` / `scrapling_session_list` / `scrapling_session_close` | Scrapling 会话类 | 仅浏览器会话 | 串行 |
| `scrapling_crawl` | Scrapling Spider 框架，作为作业运行 | 否 | 串行 |
| `scrapling_answer` | 任一抓取路径 + `ctx.llm` | `render: true` 时是 | 串行 |

- **配额。** 同开会话至多 8 个（其中浏览器会话 3 个，每个是一个真实的 Chromium 进程）、同时在跑的爬虫 2 个、单页正文按 `*MaxOutputChars` 封顶、单个协议帧 8 MB、待处理队列 16 帧。撞上限返回明确的错误码（`SESSION_LIMIT` / `CRAWL_BUSY` / `BAD_FRAME`），由模型自己退避。
- **`scrapling_crawl` 立刻返回作业 id** —— 一次爬取是分钟级的，而工具调用有超时。用 `job_list` 看进度、`job_output` 读结果、`job_kill` 中断；这一工具要求作业后端能 attach controller，没有的 profile 干脆不注册它（单页抓取不受影响）。爬虫另有总时长上限（`crawlMaxRuntimeSeconds`），且不会爬出起始域。礼貌性默认沿用 Scrapling spider 的默认值 —— **不遵守** robots.txt、每域延迟 0、最多 4 个请求并发 —— 它是部署决定，不是某次调用的参数（见[设置项](#设置项)）。
- **`scrapling_answer` 先抓页面，再带着问题交给模型**，直接拿结论而不是整页正文。默认跟随当前会话正在用的模型（读的是会话的活请求头，中途换模型也跟着变），不额外烧一份额度；要单独指定就用 `answerProvider` / `answerModel`。网页正文是**不可信输入** —— 提示把它显式框成数据，但这道防线是提示层面的：它降低风险，不等于消除风险。

### 渲染还是静态

`scrapling_render` 比 `scrapling_fetch` 慢得多、也更吃内存，所以默认从静态抓取起步。两条判据：

- **渲染结果比静态抓取短，就退回静态抓取。** 不少页面在服务端下发了可读文字，加载后又用自己的脚本把那些容器清空、换成 canvas / Lottie 动画 —— 对这类页面渲染后只会更少，任何等待设置都补不回来。这是站点行为，不是插件缺陷。
- **`waitSelector` 等的是「元素出现」，不是「内容稳定」。** 元素可能在匹配成功之后才被脚本移除，所以「选择器匹配上了」不代表那部分内容还在结果里。

还有一条不成判据但值得知道：SVG 里的坐标轴刻度**用哪个工具都抓不到** —— Markdown 转换不输出 `<svg>` / `<text>` 节点。真要图表数值，走 `scrapling_capture_xhr` 找背后的 JSON 接口。

## <img src="https://api.iconify.design/lucide/arrow-right-left.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 替代内置的抓取与搜索

插件把自己注册成 `ctx.web` 的 **fetch provider** 与 **search provider**，于是内置的 `web_fetch` / `web_search` 实际由 Scrapling 执行，而不是 dsh 那套纯 HTTP 实现。模型调用的仍然是 `web_fetch` / `web_search` —— 工具名换不掉（同名注册会抛错），provider 接缝是官方留的替换通道。两个 provider 默认注册（`provideWebFetch` / `provideWebSearch`），但这本身顶不掉任何东西：

1. `provideWebFetch` / `provideWebSearch` 保持默认（`true`）；
2. 在**部署配置**里把 `fetchProvider` / `searchProvider` 设为 `"scrapling"`。

配了 id 就以它为准，这就是第 2 步必须做的原因 —— 而两个 provider 都可用、又没点名时，`ctx.web` 会给 `WEB_PROVIDER_AMBIGUOUS`，对应工具直接不可用。把那一行指向本插件后，有两个反向风险：

- **sidecar 起不来时，内置 `web_fetch` 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`**，而不是悄悄退回纯 HTTP。
- **fetch provider 会真正执行输出预算**：正文超过 `fetchMaxOutputChars` 时按头尾窗口实际裁剪并标记 `truncated`，不是原样放行只打一个标记。失败保留 sidecar 的错误码前缀（`URL_BLOCKED`、`SIDECAR_TIMEOUT`、`SIDECAR_UNAVAILABLE`），策略拒绝、进程崩溃与超时可以区分。
- **日后卸掉插件却留着那一行**，内置工具报 `WEB_PROVIDER_CONFIGURED_MISSING` —— 要回去把 `fetchProvider` / `searchProvider` 一并撤掉。

搜索拆成两截，因为 Scrapling 自己不是搜索引擎：**检索**走部署级的 `searchEndpoint`，期望 SearXNG 兼容的 JSON 接口（GET `<endpoint>?q=<query>&format=json`，回包形如 `{"results": [{"url", "title", "content"}]}`，能出这个形状的别的后端也行）；**读取**由本插件完成 —— 前 `searchRenderTopN` 条会真的抓下来并在有浏览器时渲染，一次 `web_search` 同时拿到「哪些页面相关」与「这些页面实际说了什么」。返回的 URL 逐条过与抓取同一道闸门；单条页面读不到只跳过那一条，搜索结果里混着失效链接是常态。

有一个后果需要知道：`dsh-web` 的抓取正文是 `html | text` 的**封闭**联合，没有 `markdown` 这一档，加一种 kind 是跨包的协同改动，不是插件能扩展的。所以 fetch provider 把 Scrapling 的 Markdown 输出报成 `text`，内置渲染路径显示完全正常。要 `html` 或 CSS 选择器时直接用 `scrapling_fetch`。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

设置在插件详情页的 **scrapling** 卡上，按用途分组，每项带一句「改了会怎样」。卡面语言跟随宿主 locale。下表里的值都在卡上；卡后那张部署表只能通过 `cordis.patch.yml` 的 `config:` 块设置。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `pythonBin` | string | `""` | 解释器名或绝对路径。留空 = 仓内 `_env/.venv` 可执行就用它，否则用 `PATH` 上的 `python3` |
| `failFastOnMissingPython` | boolean | `true` | sidecar 进程起不来（路径错、协议对不上、握手超时）时拒绝加载。解释器起得来但没装 Scrapling 时，无论这枚开关如何都只降级为「工具不可用」，日志点名解释器路径 |
| `fetchEnabled` / `extractEnabled` / `renderEnabled` / `captureXhrEnabled` / `networkEnabled` / `sessionEnabled` / `sessionStateEnabled` / `crawlEnabled` / `answerEnabled` | boolean | `true` | 每个工具一枚总闸。`sessionStateEnabled` 管登录态存取那一对，它们还要部署侧配好 `sessionStateDir` |
| `extractionType` | enum | `markdown` | `markdown` / `html` / `text`；三条路径过同一套反注入清洗，`html` 额外剥事件处理器属性，因此**不是字节级原始 HTML** |
| `mainContentOnly` | boolean | `true` | 抽取范围 |
| `*MaxOutputChars` | natural | fetch / extract / render `200000`，xhr `120000` | 各工具的输出封顶。sidecar 先按字符截一次，宿主再按字节预算收口 |
| `crawlMaxItems` | natural | `1000` | 给模型可传的 `maxPages` 封的顶。越界的 `maxPages` 原样透传，让 sidecar 报参数错误，而不是由本包悄悄夹成看起来合法的值 |
| `stripInlineImages` | boolean | `true` | 剥掉正文里内嵌的 `data:` URI 图片、只留 alt 文本 —— 对模型是纯 token 噪音。代码围栏内的原样保留；不含内联图的页面逐字节不变。剥图发生在封顶**之前**。只有把内联图当**原始数据**读（配色、指纹）时才关 |
| `headless` / `networkIdle` | boolean | `true` / `false` | 浏览器模式，以及页面是否要等到网络空闲才被读取 |
| `blockAds` | boolean | `true` | **叠在** SSRF 守卫之上而不是与它竞争：守卫最后注册（于是引擎先跑它）并用 `route.fallback()` 放行 |
| `pierceShadow` | boolean | `false` | 把 open shadow root 的内容并进正文 —— 页面把正文封进 shadow DOM 时的开关。模型也能在浏览器类工具上按次覆盖 |
| `waitSelectorState` | enum | `attached` | `waitSelector` 的元素要达到的状态（`attached` / `detached` / `hidden` / `visible`） |
| `sidecarHandshakeTimeoutMs` / `fetchTimeoutMs` / `sidecarGraceMs` | natural | `30000` / `120000` / `5000` | 握手预算、单次调用的协同超时（声明在各工具的 `timeoutMs` 上）、超时后等进程退出的宽限。`scrapling_crawl` 不传超时 —— 一次爬取是分钟级的 |
| `dataDir` | string | `""` | sidecar 工作目录（`adaptive` 指纹库落这里）；留空 = `~/.dsh-scrapling`。目录建不出来时由 `failFastOnMissingPython` 决定：拒绝加载，或降级为不注册任何工具 |
| `provideWebFetch` / `provideWebSearch` | boolean | `true` | 是否注册 `ctx.web` 的两个 provider —— 见[替代内置的抓取与搜索](#替代内置的抓取与搜索) |
| `answerProvider` / `answerModel` / `answerMaxTokens` | string / natural | `""` / `""` / `2000` | `scrapling_answer` 走哪条模型路由与单次回答的 token 上限。provider 与 model 都留空表示「跟随当前会话的模型」 |
| `allowedHosts` | string | `""` | 额外放行的主机名（逗号分隔）。指向内网等于主动放弃那些目标的 SSRF 防护 |
| `syntheticDnsRanges` | string | `""` | 合成 DNS 的手动兜底：填代理 fake-IP 池的 CIDR（逗号分隔），留给把合成地址与真地址混着返回的解析器。写错的段直接丢掉 —— 兜底坏了退化成「维持最严」，不该崩 |
| `proxyUrl` | string | `""` | 抓取从哪儿出去（`http://…` / `socks5://…`，可带 `user:pass@`）。留空 = 跟随环境，见[代理](#代理)。卡上遮罩显示，绝不进入工具 schema |
| `proxyBypass` | string | `""` | 直连、不走代理的主机名，对应 `NO_PROXY`；填 `*` 表示整台机器直连 |
| `nat64Prefixes` | string | `""` | 额外的 NAT64 前缀（逗号分隔的 CIDR），给运营商自建网络用；声明的前缀对所有 IPv6 地址生效 |

**部署级旋钮**（不在卡上，只走 `cordis.patch.yml` 的 `config:` 块）：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `requestTimeoutSeconds` / `maxUrlLength` | `120` / `2048` | Python 侧单次请求的硬上限；URL 长度上限与内置抓取对齐 |
| `allowWriteMethods` | `false` | 模型能不能改对端状态 —— 见[安全说明](#安全说明) |
| `browserExecutablePath` / `browserCdpUrl` / `browserInitScript` | `""` | 强能力：让 Chromium 执行指定文件、把浏览器交给调试端点、往每个页面注入 JS。只从部署配置来，模型入参到不了 |
| `browserRealChrome` / `browserDnsOverHttps` | `false` | 改用本机安装的 Google Chrome；浏览器 DNS 走 DoH（配代理时防 DNS 泄露） |
| `recordRequests` / `maxRecordedRequests` | `false` / `100` | 浏览器会话是否默认记录网络历史（模型可在 `scrapling_session_open` 上按次用 `recordNetwork` 打开），以及一个会话最多留多少条 |
| `sessionStateDir` | `""` | 存放 Playwright 兼容登录态文件的目录。模型只能给**纯文件名**，目录始终是部署方的决定；留空禁用存取这一对 |
| `crawlMaxRuntimeSeconds` | `1800` | 一次爬虫的墙上时钟上限 —— 页数上限管不了一页等一分钟的站点 |
| `crawlRespectRobots` | `false` | 遵守 robots.txt；打开后，取不到 robots.txt 的域被**阻塞**而不是当作允许 |
| `crawlDownloadDelayMs` / `crawlConcurrentRequests` / `crawlAutothrottle` / `crawlStrategy` | `0` / `4` / `false` / `bfs` | 请求间隔、并发数、自适应限速、广度或深度优先 |
| `crawlCheckpointDir` | `""` | 把爬取队列落盘，重启后从断点接着走而不是回到起始 URL |
| `searchEndpoint` / `searchRenderTopN` | `""` / `3` | SearXNG 兼容的检索后端，以及前几条要真的抓下来渲染（`0` = 只给链接列表） |

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 代理

抓取从哪儿出去，按这个顺序判定，**先命中先算**：

1. `proxyBypass` 或环境里的 `NO_PROXY` 命中这个主机 → 直连。
2. 设置卡上的 `proxyUrl` 非空 → 用它。
3. 环境里的 `http_proxy` / `https_proxy` / `all_proxy`（大写同样认）→ 用对应那一栏。
4. 操作系统的代理设置（macOS 的 `scutil --proxy`、Windows 的 Internet Settings）→ 用它。
5. 都没有 → 直连。

各环境下的实际表现 —— **开或不开代理，工具都直接可用，一行设置都不用填**：

| 你的环境 | 静态抓取 | 渲染 / XHR |
| --- | --- | --- |
| 不开代理 | 直连 | 直连 |
| TUN 模式（系统层接管） | 直连，由 TUN 转发 | 同左 |
| 只在 shell 里 export `HTTPS_PROXY` | 自动跟随 | 自动跟随 |
| macOS / Windows「系统代理」开关 | **自动跟随** | 自动跟随 |
| 内网站点 / 内网 Git | 用 `proxyBypass` 排除 | 用 `proxyBypass` 排除 |
| PAC（自动配置脚本） | 不跟随，stderr 会提示填 `proxyUrl` | 浏览器原生跟随 |

几条容易踩的细节：

- **解析出来的代理会显式交给浏览器引擎。** Chromium 不读 `HTTP_PROXY` / `ALL_PROXY`，只在 shell 里 export 过的代理会盖住静态抓取却盖不住浏览器 —— 本包把解析出的代理随每次浏览器抓取传进去，补上这个缺口。**浏览器会话**的代理仍在 `scrapling_session_open` 时定一次：中途换要新建浏览器 context，而新建等于丢掉会话攒下的 cookie 与登录态 —— 那恰恰是会话存在的理由。静态会话每个请求各自判一次。
- **PAC 是唯一还要手工填 `proxyUrl` 的形态。** 求值 PAC 要下载脚本并跑 JavaScript，各平台格式互不相同，本包不猜；静态抓取在 stderr 指明，浏览器则经自己的系统设置原生跟随。
- **代理与合成 DNS 是两件事。** fake-IP 模式的代理把**每个**域名都解析进 `198.18.0.0/15`（TUN 客户端常落在 `100.64.0.0/10`），两段都不是公网 unicast，闸门会把每个 URL 都判成私网 —— 开了代理反而全都抓不了。闸门**自动识别**这一类解析器（三个与用户目标无关的控制域名全部落在同一段非公网段里），随后放宽到已知合成池的**整段**。控制域名只用来触发判定，不用来推断池的大小 —— 三个按名字哈希的答案不含任何大小信息。私网、回环、链路本地都不在池子里，内网与元数据地址在开着代理的机器上照旧被拒。`syntheticDnsRanges` 是自建池落在两段之外时的手动兜底；识别不出来时**维持最严**。
- **走了代理时，本机解析不出来的主机名不再判否。** 域名由代理解析，而在 DNS 被按地区过滤的网络里，恰恰是这些站点才需要代理。IP 字面量、本地能解析出来的私网答案、单标签主机名（`intranet`、`router`）照旧拒。
- **走代理时关掉 WebRTC 泄露。** Chromium 的 WebRTC 能绕过 HTTP/SOCKS 代理直接发 UDP，页面里一句 STUN 就能问出访客的真实出口 IP；有代理在就把 `blockWebrtc` 钉成真，不看模型入参。
- **凭据不会出现在任何日志或能力协商帧里。** 上报只回显 `scheme://host:port`，并用 `source` 标出代理来自 `settings` / `environment` / `system` / `none` 哪一档 —— 用户报「抓不到东西」时，这一栏就是第一眼的答案。填错的代理地址记一行 stderr 并按「未配置」处理，而不是让插件加载失败。

## <img src="https://api.iconify.design/lucide/shield-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安全说明

- **SSRF。** Scrapling 自身没有任何 SSRF 防护。本包在 Host 侧加一层 URL 策略 —— scheme 白名单、拒绝 URL 内嵌凭据、长度上限、authority 里有反斜杠或控制字符即拒、DNS 解析后按**整个答案集**判定是否全为公网、IPv4-mapped 与 NAT64 地址按内嵌 IPv4 重判 —— 并在 Python 侧再强制一次。**判的和发出去的是同一个地址**：闸门判的是 WHATWG 归一后的结果，sidecar 转发的也是这个归一串，否则「判的是 A、连的是 B」本身就会成为绕过面。Host 侧那道策略由 `SidecarClient.call` 统一执行，因此覆盖每一个工具与 `web_fetch` provider，判否时抛 `URL_BLOCKED`、请求根本不会写进管道；`web_search` provider 对它准备交回的 URL 跑同一道闸门，被拒的命中不会成为可引用的 source。浏览器侧的守卫覆盖主导航、子资源、XHR 与 WebSocket 握手。
- 已知缺口，写在明处：
  - **连接钉扎**（undici 层技术）对非 Node 传输不可用；校验与真正建连之间有 TOCTOU 窗口。静态抓取由 curl_cffi 的 `follow_redirects="safe"` 兜住重定向，浏览器抓取由 Python 侧的 route handler 兜住。
  - **NAT64 前缀不做动态探测。** 两个标准化前缀已覆盖；运营商自建的要用 `nat64Prefixes` 声明，否则藏在 IPv6 里的私网 IPv4 会被当成普通公网 IPv6 放行。
  - **没有端口白名单**（默认不限端口），与 dsh 内置 fetch provider 的取舍一致。
  - **爬虫每页收进结果前复判两次** —— 一次过守卫（最终 URL 仍可能落在私网上），一次过起始域，因为 Scrapling 的 `allow_domains` 是对页面里链接的字符串比较、不管重定向目标。爬虫会话设了 `follow_redirects="safe"`，curl_cffi 拒绝跳向私网的跳转。
  - **WebSocket 覆盖依赖 Playwright 版本。** 守卫用 `route_web_socket` 拦握手；更老的 Playwright 没有这个方法，那种情况下 WebSocket 不在守卫范围内，插件会往日志与能力报告里如实标出，不会静默降级。
- **不接受来自模型的代码执行。** `page_action`、`page_setup`、`selector_config`、`proxy`、`executablePath`、`cdpUrl` 绝不进入任何工具 schema，浏览器侧的网络守卫由插件自己的代码注册。浏览器强能力与 `allowWriteMethods` 只从部署配置来。
- **写方法默认关。** `allowWriteMethods` 关着时，`method` 与 `body` 根本不在 `scrapling_fetch` 的参数面里，sidecar 那侧还独立硬拒一次非 GET（`WRITE_DISABLED`）—— 两道判断各管一侧、不依赖对方。闸门、代理判定、`follow_redirects="safe"` 管的是请求**去哪里**，不是**到了之后干什么**；被注入的页面文字完全可以要求发一个 POST，所以只有任务确实是「提交数据」时才打开。`headers` 与 `cookies` 照旧可见 —— 交给它们的任何内容按设计就会进模型上下文。
- **反注入清洗无条件执行**，三条提取路径都过，不提供任何让模型关掉它的开关。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 口径 | 内容 |
| --- | --- |
| 写盘 | sidecar 工作目录（`dataDir`，默认 `~/.dsh-scrapling`）里是 Scrapling `adaptive` 的指纹库；配了 `sessionStateDir` 时登录态文件写在那个目录下。设置值在宿主的设置文档里。其余什么都不写 |
| 网络 | 抓取发往模型给的 URL，配了代理就走代理。搜索查询发往部署级的 `searchEndpoint`。`scrapling_answer` 把抓到的页面正文与问题经宿主 `llm` 服务送出 —— 路由到的模型在远端时，这些内容就离开了本机 |
| 日志 | 选中的解释器、探测到的能力、代理摘要（`scheme://host:port` 加来自哪一档 —— 绝无凭据） |
| 内存 | 会话、cookie 与录下的网络历史都在 sidecar 进程里，随进程一起消失 |
| 遥测 | 无 |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

按类登记，一类一条。

- **对「服务端下发可读文字、加载后自己换掉」的页面，渲染只会丢内容。** 这类站点把文字给搜索引擎与无 JS 用户，加载后清空容器换成 canvas / Lottie 动画，渲染后拿到的更少 —— 见[渲染还是静态](#渲染还是静态)。
- **SVG 里的坐标轴刻度用哪个工具都拿不到**：Markdown 转换不输出 `<svg>` / `<text>` 节点。要图表数值，用 `scrapling_capture_xhr` 找 JSON 接口。
- **浏览器会话的代理在 `session_open` 时定一次**，会话内 `proxyBypass` 不逐 URL 生效（换 context 会丢掉会话存在的理由 —— cookie 与登录态）。静态会话每个请求各自判一次。
- **`scrapling_session_fetch` 的 `headers` 与 `retries` 只属于 static 会话。** 上游对浏览器会话静默丢掉这两个键，本包替它报错（`BAD_ARGS` 并点名该改用哪个旋钮）——「拧了没反应」正是这条边界要消灭的故障形态。
- **浏览器身份类的旋钮只开在真能用上它的工具上。** `useragent` / `locale` / `timezoneId` / `headless` 摆在一次性的浏览器工具与 `scrapling_session_open` 上 —— 它们只在会话构造期生效，会话内传过去会被上游静默丢掉。
- **网络历史是会话级的。** 记录是构造期设置（部署默认 `recordRequests`，或每次 `scrapling_session_open` 上的 `recordNetwork`）；没开记录的会话报错，而不是回一个空列表。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题 | 回答 |
| --- | --- |
| 模型说 render / capture_xhr 工具不存在 | 这台机器没有浏览器引擎 —— 插件只注册能用的。跑 `python -m patchright install chromium` 再重启。如果**所有**工具都不在，是 sidecar 没起来：启动日志点名选中的解释器，缺 Scrapling 的报错里带着可照抄的 pip 命令 |
| 开了代理之后所有抓取都被拦 | fake-IP 代理把每个域名都解析进非公网段；闸门会自动识别这一类并放宽到已知池。自建池落在两段之外的，填进 `syntheticDnsRanges`。私网与回环地址被拦是故意的 |
| `web_fetch` 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` / `_MISSING` | 部署那一行指向了本插件：要么 sidecar 没起来（解释器或 Scrapling —— 看启动日志），要么插件已卸载而 `fetchProvider` / `searchProvider` 那一行还在。把那一行也撤掉 |
| 模型发不了 POST | `allowWriteMethods` 默认关且只走部署配置 —— 它决定模型能不能改对端的状态 |
| `web_search` 什么都不返回 | Scrapling 不是搜索引擎。把部署级的 `searchEndpoint` 指向一个 SearXNG 兼容的 JSON 后端 |
| 图表上的数字拿不到 | SVG 刻度标签在任何工具里都活不过 Markdown 转换。用 `scrapling_capture_xhr` 找图表背后的 JSON 接口 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check     # 类型检查 → lint → client 构建 → host 构建 → 测试 → 格式，随后是 Python 链
pnpm run test:py   # Python sidecar 的端到端验证
```

- **Python 这一侧与 TypeScript 同等待遇。** `check` 以 `check:py` 收尾：解释器播报、面清点（随包发布的 `.py` 与测试目录必须都在 —— 测试目录缺失时「干净」与「没测过」不可分辨）、ruff check、ruff format、mypy、sidecar 端到端、bandit（medium 及以上）、以及**只量随包发布模块**的覆盖率地板。开发工具装法：往 `test:py` 用的那个解释器里 `pip install -r py/requirements-dev.txt`。
- **Python 3.14 地板写在四处、说的是同一件事：** 两份 README、ruff 与 mypy 的 target、以及 `py/bridge.py` 的运行时硬闸 —— 在任何 Scrapling import 之前退出且 stdout 零字节（stdout 是协议帧，旧解释器看到的是退出码加一行 stderr，而不是乱码）。
- **mypy 刻意不跑严格档。** Playwright 的 `page` / `route` / `websocket` 运行前没有形状，严格档只会买来一堆只为让它闭嘴的 `ignore`。
- 源码全部是 TypeScript。`host.js` 与 `client.js` 是**构建产物**且故意用 `.js`：Node 拒绝为 `node_modules` 里的包剥类型，而 dsh 正是从那里加载本插件的。产物是 ESM-only，`require()` 拿不到它，这是有意的。
- 钉住发布形态的门：`test/publish-manifest.test.ts`（入口目标都在 `files` 覆盖内、源码不作入口、`dsh-*` 一律精确钉且同版本、没有内联的宿主包正文、注释与文档里没有日期与坏字节）与 `test/readme-parity.test.ts`（两份 README 都写全每个工具与每枚设置卡旋钮，章节结构一致）。
- 发布走 [`.github/workflows/publish.yml`](./.github/workflows/publish.yml)（手动触发，OIDC trusted publishing + `--provenance`）。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可证

MIT。源码在 [github.com/JayYuen666/dsh-scrapling](https://github.com/JayYuen666/dsh-scrapling)，issue 走该仓库的 tracker。

本包不随包分发第三方源码 —— Scrapling 与浏览器引擎都是运行期依赖，随包的第三方内容只有图标（Tabler Icons）。[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 记录这条边界。
