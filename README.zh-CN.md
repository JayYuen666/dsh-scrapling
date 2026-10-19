# @jayyuen66/dsh-scrapling

[English](./README.md) · 简体中文

把 [Scrapling](https://github.com/D4Vinci/Scrapling) 的网页抓取能力封装成
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 agent 工具，
后端是一个常驻的 Python 进程。

## 为什么需要这个插件

dsh 自带 `web_fetch` 与 `web_search`。`web_fetch` 是刻意做「诚实且最小」的：
纯 HTTP(S) GET，不执行 JavaScript，UA 也是诚实的
（`deepseek-harness/0.2.0-rc.2`，源码注释原话 "never a browser disguise"），
HTML 转 Markdown 用 turndown。作为默认档这没问题，但代价是：
**单页应用只会拿到加载中的空壳**，而且没法要求「只给我那个商品表格」。

在一个「内容只有 JS 执行后才出现」的页面上实测：

| 管线 | 拿到的文本 |
|---|---|
| 原始 HTML 转文本（无 JS） | `SPA Shell / LOADING_PLACEHOLDER` |
| `Fetcher`（curl_cffi，同样无 JS） | `SPA Shell / LOADING_PLACEHOLDER` |
| `DynamicFetcher`（Playwright） | 完整渲染后的 DOM、Markdown 表格、结构化行 |

本插件补的是 dsh 自带工具**做不到**的三件事：

1. **浏览器渲染** —— 经 Playwright / patchright 执行 JavaScript。
2. **结构化抽取** —— CSS/XPath 选择后返回数据，而不是一大坨 Markdown。
3. **选择器自愈** —— Scrapling 的 `adaptive` 模式能在站点改版后重新定位元素。
   已实测：class 改名后原选择器返回 `None`，`adaptive=True` 时能重定位到元素。

## 当前状态

十三个工具（会话类算七个）全部实现、注册，并有测试覆盖。工具是**条件注册**的：插件启动时先探测运行环境
真正具备什么，只注册能用的 —— 模型不会浪费一轮去调用一个注定失败的工具。

| 工具 | 后端 | 需要浏览器 | 并发 |
|---|---|---|---|
| `scrapling_fetch` | `Fetcher`（curl_cffi） | 否 | 可并发；开了 `allowWriteMethods` 之后写动词转串行（并行写就是重复提交） |
| `scrapling_extract` | `Selector` + CSS/XPath + `adaptive` | 否 | 可并发 |
| `scrapling_render` | `StealthySession`（patchright） | 是 | 串行；反检测开关（`solveCloudflare` / `hideCanvas` / `blockWebrtc`）也在这一条上 |
| `scrapling_capture_xhr` | `capture_xhr`（会话级记录） | 是 | 串行 |
| `scrapling_session_open` / `scrapling_session_fetch` / `scrapling_session_network` / `scrapling_session_state_save` / `scrapling_session_state_load` / `scrapling_session_list` / `scrapling_session_close` | Scrapling 会话类 | 看情况 | 串行 |
| `scrapling_crawl` | Scrapling Spider 框架 | 否 | 串行，后台作业 |
| `scrapling_answer` | 上面任一抓取 + `ctx.llm` | 否（`render:true` 时是） | 串行 |

`scrapling_answer` 是唯一会**再调一次模型**的工具：先把页面抓下来，再带着问题交给模型
作答，直接拿结论而不是整页正文。它默认跟随**当前会话正在用的模型**（读的是会话的活请求
头，中途换模型也跟着变），所以插件不额外烧一份额度；也可以在设置卡上单独指定
`answerProvider` / `answerModel`，把「读网页」和「写代码」分给不同模型。

网页正文是**不可信输入**——页面上可以写「忽略之前的指令」。问答的系统提示把正文显式框成
数据并禁止执行其中的指令，但这道防线是提示层面的：它降低风险，不等于消除风险，重要页面
仍应人工复核。

一切都在**同一个常驻 Python 进程**里跑。这不是优化选择 —— Scrapling 的会话类要保留
cookie，浏览器引擎要保留页面池，`adaptive` 要保留 SQLite 指纹库。每次调用起一个进程，
这些东西全都会丢。

`scrapling_crawl` **立刻返回作业 id** 而不是阻塞：一次爬取是分钟级的，而工具调用有超时。
用 `job_list` 看进度、`job_output` 读结果、`job_kill` 中断。爬虫另有总时长上限
（`crawlMaxRuntimeSeconds`），且不会爬出起始域。礼貌性由部署方定夺，这里如实声明：它由部署级
旋钮配置（`crawlRespectRobots`、`crawlDownloadDelayMs`、`crawlConcurrentRequests`、
`crawlAutothrottle`、`crawlStrategy`、`crawlCheckpointDir`），而**它们的默认值沿用 Scrapling
spider 的默认值** —— **不遵守** robots.txt、每域延迟为 0、最多 4 个请求并发。爬取被锁在
起始域内，不会向无关站点扩散；需要更温和行为的站点是部署方的决定，而不是某次调用的参数。

## 环境要求

- **Python 3.14+**，装好 Scrapling，能从 `PATH` 找到（或设置 `pythonBin`）。
- **浏览器完全由用户负责。** 插件不下载任何东西。没有浏览器时它只是不注册那些依赖
  浏览器的工具，模型不会浪费一轮去调用它们。

```sh
pip install "scrapling[rag]>=0.5,<0.6"
python -m patchright install chromium
```

> **为什么是 `rag` 而不是 `fetchers`？** `rag` 就是 `fetchers` 再加上 `markdownify`，而
> `extractionType` 默认就是 `markdown` —— 装成 `fetchers` 的话，第一次抓取就会在 Markdown
> 转换处抛 `ModuleNotFoundError`。Python 侧会明确告诉你是哪个包没装。

> **版本范围**：本插件在 Scrapling **0.5** 上开发与验证，并依赖它的
> `Convertor._strip_noise_tags` / `_sanitize_for_ai`、`Selector`、`Spider` 与
> `SessionManager` 这些接口。这些都还不是稳定 API 面，所以上界钉在 `0.6` 之前；装到
> 范围外时守卫会照常运行，但反注入清洗与爬虫链路可能不按预期。

> **0.5 破坏了什么，本插件怎么跟着走：**
> - **浏览器后端只剩 patchright。** 0.5 删掉了纯 Playwright 后端（`DynamicFetcher` /
>   `DynamicSession`），浏览器抓取因此只剩一条代码路径。原来独立的 `scrapling_stealth_fetch`
>   随之**删除**：它的反检测参数现在都在 `scrapling_render` 上。
> - **`capture_xhr` 改成会话级记录。** 捕获现在记进会话，于是本插件新增
>   `scrapling_session_network` 来读一个已开会话攒下的历史；`scrapling_capture_xhr` 自己为
>   单页起一个临时会话。
> - **`extra_flags` 现在是叠加而非替换。** 上游把 `config.extra_flags` 从「顶掉内建反检测
>   flag」改成「叠加到它们之上」，所以过去那条「传了 `extra_flags` 整套 stealth 就没了」的
>   不变量不再成立。本插件**任何路径都不发** `extra_flags`，WebRTC 防泄露由 `block_webrtc`
>   开关本身承担。

## 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-scrapling
```

也可以在 Web 界面里 **Sidebar -> Plugins -> Add plugin** 安装。

## 替代 dsh 内置的 `web_fetch` 与 `web_search`

插件可以把自己注册成 `ctx.web` 的 **fetch provider** 与 **search provider**，于是内置的
`web_fetch` / `web_search` 工具实际由 Scrapling 执行，而不是 dsh 那套纯 HTTP 实现。这才是
「替代自带的」那条路 —— 模型调用的仍然是 `web_fetch` / `web_search`。

> **工具名换不掉，只能换后端。** `ToolRuntime.register` 最终落到 `NamedEntries.insert`，
> 重名会**抛错**（`tool "X" is already registered`）。所以同名注册工具这条路是封死的，
> `ctx.web` 的 provider 接缝是官方留的替换通道。

**`provideWebFetch` 与 `provideWebSearch` 默认就是开的**，所以只要 sidecar 起来了，两个
provider 都会被注册。但这**还不足以**真正接管内置工具：部署配置仍要点名。

1. `provideWebFetch` / `provideWebSearch` 保持默认（`true`）；
2. 在**部署配置**里把 `fetchProvider` / `searchProvider` 设为 `"scrapling"`。

> **为什么第 2 步仍然必须做。** base bundle 里写的是 `fetchProvider: http`，而**配了 id 就
> 以它为准**——所以仅仅「注册了 provider」并不会顶掉任何东西。（而且两个 provider 都可用、
> 又没点名时，`ctx.web` 会给出 `WEB_PROVIDER_AMBIGUOUS`，对应工具直接不可用。）

把那一行指向本插件之后，有两个反向风险要知道：

- **sidecar 起不来时，内置 `web_fetch` 会报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`**，而不是
  悄悄退回纯 HTTP——被配置的 provider 不可用，工具会如实报出来。
- **日后卸掉插件却留着那一行**，内置工具会报 `WEB_PROVIDER_CONFIGURED_MISSING`——点名的
  provider 不再注册了。要回去把 `fetchProvider` / `searchProvider` 一并撤掉。

`searchEndpoint` 留空时 search provider 的 `available()` 为 false —— 这也是一道闸：光开
`provideWebSearch` 而没配端点，不会把内置 `web_search` 顶掉。

### 搜索 + 渲染一体化

Scrapling 自己**不是搜索引擎**（源码里 `google_search` 只是一个「加 Google referer 头」的
选项），所以 `web_search` 这一段拆成两截：

- **检索** → 一个可配置的搜索后端（部署级 `searchEndpoint`），期望 SearXNG 兼容的 JSON
  接口：GET `<endpoint>?q=<query>&format=json`，回包形如
  `{"results": [{"url", "title", "content"}]}`。别的后端只要能出这个形状也行。
- **读取** → 由本插件的 sidecar 完成，前 `searchRenderTopN`（默认 3）条会**真的抓下来并
  渲染**（浏览器可用时走 Playwright），正文放进 `content`，URL 放进 `sources`。

这样一次 `web_search` 就同时拿到「哪些页面相关」与「这些页面实际说了什么」，后者正是内置
`web_fetch` 结构上读不到的 SPA 内容。返回的 URL 会逐条过本插件的 URL 闸门；解析层不重复
一份安全策略。单条页面读不到只跳过那一条 —— 搜索结果里混着失效链接是常态。

有一个后果需要知道：`dsh-web` 的 `WebFetchBody` 是**封闭**联合，只有 `html | text`，
没有 `markdown`；新增一种 kind 是跨包的协同改动，不是插件能扩展的。所以 fetch provider 把
Scrapling 的 Markdown 输出报成 `text`，内置渲染路径显示完全正常。
需要 `html` 或 CSS 选择器时请直接用 `scrapling_fetch`。

## 配置

设置项在插件详情页的 **scrapling** 卡片下（设置 → 插件 → 展开本包）。[`host.ts`](./host.ts)
里标了可编辑的字段都会按用途分组出现在卡上，每项带一句「改了会怎样」；部署级字段只能通过
[`cordis.patch.yml`](./cordis.patch.yml) 的 `config:` 块设置。卡片把值改回默认值时保存的是
「清除覆盖」而不是写入同一个值——将来默认值变了，你这一项就会跟着变。

主要开关：

- `pythonBin` —— 解释器名或绝对路径；留空表示用 `PATH` 上的 `python3`。
- `failFastOnMissingPython` —— 解释器不可用时直接**拒绝加载**（默认 `true`），而不是降级成
  「所有工具不可用」：每个工具都要 sidecar，静默降级只会让模型在几轮之后才发现工具全都不见了。
  设成 `false` 才走降级，附一条警告。
- `fetchEnabled` / `extractEnabled` / `renderEnabled` / `captureXhrEnabled` /
  `networkEnabled` / `sessionEnabled` / `sessionStateEnabled` / `crawlEnabled` /
  `answerEnabled` —— 默认开。`scrapling_crawl`
  要求 profile 带作业后端；没有时它会当场报 `JOBS_UNAVAILABLE`，而不是静默地什么都不做。
  `sessionStateEnabled` 管的是 `scrapling_session_state_save` /
  `scrapling_session_state_load` 这一对，而它们要能可用还得部署侧配好 `sessionStateDir`。
- `pierceShadow` —— **默认关**：它把 open shadow root 的内容并进正文。页面把正文封进
  shadow DOM 时，一段普通 HTML 读不到它，这一枚就是为那种页面准备的；模型也能在浏览器类
  工具上按次覆盖。
- `extractionType` —— `markdown`（默认）/ `html` / `text`。三条路径都过同一套反注入
  清洗；`html` 额外剥掉事件处理器属性（`on*`、`srcdoc`、`formaction`）与 `meta refresh`，
  因此**拿到的不是字节级原始 HTML**。
- `allowedHosts` —— **安全相关的放行名单**，默认空（最严）。指向内网等于主动放弃那些目标
  的 SSRF 防护，抓自建/内网站点时才会需要。它同时喂 Host 闸门与 Python 侧守卫，两边同解。
- `syntheticDnsRanges` —— 合成 DNS 的**手动兜底**：填你那个代理的 fake-IP 段（CIDR，逗号
  分隔）。主路径是自动检测（见下「代理」），这一项留给「解析器把合成地址和真地址混着返回」
  的场合。写错的段直接丢掉而不是让插件起不来——它只是兜底，坏了退化成「维持最严」，不该崩。
- `proxyUrl` —— 抓取从哪儿出去，形如 `http://127.0.0.1:7890` 或
  `socks5://127.0.0.1:7890`，可带 `user:pass@`。**留空表示跟随环境。** 它是部署级能力，
  绝不进入任何工具 schema。判定顺序见下面的「代理」。
- `proxyBypass` —— 直连、不走代理的主机名，对应 `NO_PROXY`。
- `*MaxOutputChars` —— 各工具的输出封顶。宿主侧的封顶只影响进模型上下文的那一段；
  sidecar 侧先按 `maxContentChars`（字符）截一次，宿主再按字节预算收口。`crawlMaxItems` 是部署侧给模型可传的
  `maxPages` 封的顶；越界的 `maxPages`（0、负数、NaN）**原样透传**，让 sidecar 报参数错误，
  而不是由本插件悄悄夹成一个看起来合法的值。`crawlMaxRuntimeSeconds` 是爬虫的**墙上时钟**
  上限：页数上限管不了一页等一分钟的站点，而爬虫是没人看的后台线程。到点由蜘蛛走引擎自己
  的停机通道收尾，而不是等站点自己没得爬。
- `stripInlineImages` —— 默认**开**：剥掉正文里内嵌的 `data:` URI 图片，只留 alt 文本。
  这类图片对模型是纯 token 噪音 —— 一段 base64 SVG 编码进上下文要按字符计费，而模型从里面
  读不出任何图形信息。**不含内联图的页面逐字节不变**；含内联的页面省掉的量取决于内联图有多少 ——
  站点要么一个都不内联，要么就是一整面 logo 墙，中间态很少。所以默认开启对不含内联图的站点零
  风险，收益全部出现在命中时。代码围栏内的 `data:` URI 原样保留：那里多半是教程在教的示例代码，
  剥掉等于把文档改了。要把内联图当**原始数据**读（取配色或指纹之类）时才关掉。剥图发生在封顶
  **之前**：顺序反了等于白剥，那些体积早就把 `maxContentChars` 的额度吃光了。
- `answerProvider` / `answerModel` / `answerMaxTokens` —— `scrapling_answer` 走哪条模型路由
  以及单次回答的 token 上限。provider 与 model 都留空表示「跟随当前会话的模型」，
  `answerMaxTokens` 封住回答长度。
- `sidecarHandshakeTimeoutMs` / `fetchTimeoutMs` / `sidecarGraceMs` —— sidecar 握手的等待预算、
  单次调用的协同超时（声明在各工具的 `timeoutMs` 上），以及超时之后客户端再等进程退出多久才
  强制拆掉。三项都在设置卡上。`scrapling_crawl` 是例外：它作为作业运行且不传超时——一次爬取
  是分钟级的，套一个固定预算会让每次成功都在最后一刻被判超时，然后整个进程被拆掉重来。
- `blockAds` —— 默认开。它**叠在** SSRF 守卫之上而不是与它竞争：守卫最后注册（于是浏览器引擎
  先跑它）并用 `route.fallback()` 放行，让 Scrapling 自己的拦截处理器仍然可达。
- `mainContentOnly` / `headless` / `networkIdle` / `waitSelectorState` / `dataDir` ——
  抽取范围、浏览器模式、页面被读取前必须达到的选择器状态，以及 sidecar 的工作目录。
  逐项说明见 [`host.ts`](./host.ts) 里的注释。

**部署级旋钮**（不在设置卡上，只走 [`cordis.patch.yml`](./cordis.patch.yml) 的 `config:`
块）：`requestTimeoutSeconds`、`maxUrlLength`、`browserExecutablePath`、`browserCdpUrl`、
`browserInitScript`、`browserRealChrome`、`browserDnsOverHttps`、`recordRequests`、
`maxRecordedRequests`、`sessionStateDir`、`crawlMaxRuntimeSeconds`、`crawlRespectRobots`、
`crawlDownloadDelayMs`、`crawlConcurrentRequests`、`crawlAutothrottle`、`crawlStrategy`、
`crawlCheckpointDir`、`searchEndpoint`、`searchRenderTopN`、`allowWriteMethods`（默认 `false`）。
其中 `browserExecutablePath`、`browserCdpUrl` 与 `browserInitScript` 是强能力 —— 它们等于让
Chromium 执行指定文件、把浏览器交给指定调试端点、或往每个页面注入一段 JS —— 所以只从部署配置来，
模型入参到不了。`allowWriteMethods` 同理：它决定模型能不能改对端的状态，因此默认关，也只从部署
配置来。爬虫那几枚与 `sessionStateDir` 同样是部署方的决定，见下面
[会话、网络历史与爬虫礼仪](#会话网络历史与爬虫礼仪)。

> **改完设置要重启 dsh。** 闸门策略与 sidecar 的环境变量都在插件 `apply()` 时取一次快照，
> 设置卡上的改动要等下次启动才生效。

关掉某个工具时，它的 system prompt 指引段**也一并消失**，
不会出现「工具没了但提示词还在」的割裂。指引每次装配都按「那个 scope 真看得见哪些工具」
现取，所以没装浏览器的机器会少掉 render / capture_xhr 那几句，sidecar 没起来的机器则一句都不说 ——
叫模型去调一个不存在的工具，代价是一轮往返加一个看不懂的 `UNKNOWN_TOOL`。

## 会话、网络历史与爬虫礼仪

Scrapling 0.5 放出几项能力，本插件把它们做成工具，每项旁边配一枚部署旋钮。工具在设置卡上，
旋钮只走部署配置（[`cordis.patch.yml`](./cordis.patch.yml) 的 `config:` 块）。

- **网络历史。** 一个已开会话可以记录它发出的 XHR/fetch 请求。`recordRequests` 是部署级默认值，
  模型可以在 `scrapling_session_open` 上用 `recordNetwork` 为这一个会话打开记录。用
  `scrapling_session_network` 读回来（`urlPattern` / `includeBody` / `networkLimit` /
  `maxBodyChars`）；`maxRecordedRequests` 决定一个会话最多留多少条。没开记录的会话会**报错**，
  而不是回一个空列表。
- **Shadow DOM。** `pierceShadow` 把 open shadow root 并进正文（默认关）；模型也能在浏览器类
  工具上按次覆盖。
- **登录态。** `sessionStateDir` 指向一个存放 Playwright 兼容登录态文件的目录。
  `scrapling_session_state_save` / `scrapling_session_state_load` 一存一取；模型只能给一个
  **纯文件名**（不能带路径），所以目录始终是部署方的决定。留空表示这对工具被禁用。
- **爬虫礼仪与顺序。** `crawlRespectRobots`（默认关）让蜘蛛遵守 robots.txt；打开后，取不到
  robots.txt 的域会被**阻塞**，而不是当作允许。`crawlDownloadDelayMs`（`0`）是请求之间的间隔，
  `crawlConcurrentRequests`（`4`）是并发数，`crawlAutothrottle`（关）让蜘蛛自行放慢，
  `crawlStrategy`（`bfs` / `dfs`）选广度或深度优先。
- **断点续爬。** `crawlCheckpointDir`（空）让爬取把队列落盘，重启后从断点接着走，而不是回到
  起始 URL 重跑。
- **浏览器附加项。** `browserInitScript` 往每个页面注入一段 JS（强能力），`browserRealChrome`
  改用本机安装的 Google Chrome 而不是自带 Chromium，`browserDnsOverHttps` 让浏览器的 DNS 走
  DoH（配代理时防 DNS 泄露）。

## 代理

抓取从哪儿出去，按这个顺序判定，**先命中先算**：

1. `proxyBypass` 或环境里的 `NO_PROXY` 命中这个主机 → 直连。
2. 设置卡上的 `proxyUrl` 非空 → 用它。
3. 环境里的 `http_proxy` / `https_proxy` / `all_proxy`（大写同样认）→ 用对应那一栏。
4. 操作系统的**代理设置**（macOS 的 `scutil --proxy`、Windows 的 Internet Settings）→ 用它。
5. 都没有 → 直连。

四档各自的存在理由，少一档就有一类用户抓不到东西：设置卡是显式意图；环境变量覆盖 CI、
ssh 会话、docker exec 这类只在 shell 里 export 过的地方；系统代理是 macOS 与 Windows 上
代理软件的默认形态——Clash Verge、Surge 等把「系统代理」一勾，浏览器立刻就上，而
curl_cffi 对系统设置一无所知，不补这一档就会发现「浏览器能上、本插件的静态抓取抓不到」。

设置卡里显式填了 `proxyUrl`，后面两档整份被忽略：显式设置就该压过隐式来源，否则「我明明
填了 7890 却还在走 1080」这类问题无从查起。绕过清单横切在最前，命中即直连。

各环境下的实际表现 —— **开或不开代理，工具都直接可用，一行设置都不用填**：

| 你的环境 | 静态抓取 | 渲染 / XHR |
| --- | --- | --- |
| 不开代理 | 直连 | 直连 |
| TUN 模式（系统层接管） | 直连，由 TUN 转发 | 同左 |
| 只在 shell 里 export `HTTPS_PROXY` | 自动跟随 | 自动跟随 |
| macOS / Windows「系统代理」开关 | **自动跟随** | 自动跟随 |
| 内网站点 / 内网 Git | 用 `proxyBypass` 排除 | 用 `proxyBypass` 排除 |
| PAC（自动配置脚本） | 不跟随，stderr 会提示填 `proxyUrl` | 浏览器原生跟随 |

PAC 是唯一还需要手工填一次的形态：求值 PAC 要下载脚本并跑 JavaScript，各平台格式互不相同，
本包不猜。见到 PAC 时会在 stderr 指明该填 `proxyUrl`，而不是静默直连。

几条容易踩的细节：

- **代理与合成 DNS 是两件事。** fake-IP 模式的代理把**每个**域名都解析进 `198.18.0.0/15`
  （TUN 客户端常落在 `100.64.0.0/10`），两段都不是公网 unicast，闸门于是把每个 URL 都判成
  私网——开了代理反而全都抓不了。插件**自动识别**这一类解析器：从 `example.com` /
  `www.iana.org` / `www.wikipedia.org` 三个与用户目标无关的控制域名各解析一次，全部落在同一段
  非公网段里且互不相同，即判为 fake-ip，随后放宽到**已知合成池的整段**——198.18.0.0/15
  （clash / mihomo 的默认落点）与 100.64.0.0/10（部分 TUN 客户端）。私网、回环、链路本地
  一个都不在池子里，所以 `http://192.168.1.10/`、`http://127.0.0.1/`、
  `http://169.254.169.254/` 在开着代理的机器上**照旧被拒**。

  控制域名只用来**触发**判定，不用来推断池的大小。这一点踩过坑：三个答案是按名字哈希散列的，
  跨度纯属偶然——真机上实测是 .126/.134/.135，跨度 10，按「覆盖样本的最小 2 的幂块」切出来是
  198.18.0.112..127 这么个 /28，于是 `www.iana.org`、`www.wikipedia.org` **自己都过不去**，
  `github.com`（.38）与 `opencode.ai`（.61）更被挡在门外。三个样本不含任何池大小的信息。

  `syntheticDnsRanges` 是识别失灵时的手动兜底（自建池若落在上面两段之外）。识别不出来时
  **维持最严**，不会误放行；URL 里写死的 IP 字面量照旧严格判定。
- **走了代理时，本机解析不出来的主机名不再判否。** 请求不从本机网络命名空间出去，域名由代理
  解析，本机解析器答不上来什么也说明不了——而在 DNS 被按地区过滤的网络里，恰恰是这些站点才
  需要代理才能访问。IP 字面量、本地能解析出来的私网答案、单标签主机名（`intranet`、`router`
  这类）三条**照旧拒**。
- **走代理时会关掉 WebRTC 泄露。** Chromium 的 WebRTC 能绕过 HTTP/SOCKS 代理直接发 UDP，页面
  里一句 STUN 就能问出访客的真实出口 IP。0.5 起这道防护由 `block_webrtc` 开关本身承担：只要
  有代理在，本插件就把它打开，一路上**不发**任何 `extra_flags`。（0.5 之前才需要往 Chromium
  的启动参数里塞两条 flag，因为那时的 `config.extra_flags` 会**替换**上游自己算出的反检测
  flag；上游改成叠加之后，那个绕法随旧浏览器后端一起消失。）
- **网络历史是会话级的。** 记录是构造期设置（部署默认 `recordRequests`，或每次
  `scrapling_session_open` 上的 `recordNetwork`），`scrapling_session_network` 读的是这个会话
  跨多次抓取攒下的历史。对比之下 `scrapling_capture_xhr` 为单页起一个临时会话，只回那一页发出
  的请求。
- **`scrapling_session_fetch` 的 `headers` 与 `retries` 只属于 static 会话，给浏览器会话会直接报错。**
  浏览器那侧的请求头是 `extraHeaders`，重试则是会话构造期的设置；上游对这两个键一声不吭地
  丢掉，所以本包替它报错（`BAD_ARGS` 并点名该改用哪个旋钮）——「拧了没反应」正是这个插件要
  消灭的那类故障。
- **浏览器会话的代理在 `session_open` 时定一次**，之后整个会话共用。绕过清单因此对浏览器会话
  不逐 URL 生效——Playwright 的代理挂在 BrowserContext 上，中途换只能新建 context，而新建就
  等于丢掉这个会话攒下的 cookie 与登录态，那恰恰是会话存在的理由。静态会话没有这个限制，
  每个请求各自判一次。
- **写方法默认关，而且闸门本来就管不到它。** `allowWriteMethods` 是部署级设置（只走
  `cordis.patch.yml`，不进设置卡），它决定 `scrapling_fetch` 要不要把 `method`（POST/PUT/DELETE）
  与 `body` 摆到模型面前。关着（默认）时这两个入参**根本不在参数面里**，而 sidecar 那侧还会独立
  硬拒一次非 GET（`WRITE_DISABLED`），手搓一帧也写不出去 —— 两道判断不互相依赖。只有任务确实是
  「提交数据」时才打开：被注入的页面文字完全可以要求发一个 POST，而 SSRF 闸门、代理判定、
  `follow_redirects="safe"` 管的是请求**去哪里**，不是**到了之后干什么**。`headers` 与 `cookies`
  两档都照旧可见——给你放行名单里的主机发一个带凭据的 GET 是正常用法——但要清楚交给它们的凭据
  按设计就会进模型上下文。`fetchEnabled` 仍是粗粒度总闸。
- **浏览器身份类的旋钮只开在真能用上它的工具上。** `useragent` / `locale` / `timezoneId` /
  `headless` 摆在一次性的浏览器工具与 `scrapling_session_open` 上——它们只在**会话构造期**生效，
  会话内每次抓取传过去会被上游静默丢掉。
- **凭据不会出现在任何日志或能力协商帧里。** 能力上报只回显 `scheme://host:port`，并用 `source`
  标出代理来自 `settings` / `environment` / `system` / `none` 哪一档——用户报「抓不到东西」时，
  这一栏就是第一眼的答案。
- **填错的代理地址不会让插件起不来。** 协议不在 `http` / `https` / `socks4` / `socks5` /
  `socks5h` 之内时记一行 stderr 并按「未配置」处理，而不是抛出去让插件加载失败。

## 渲染还是静态：怎么选

`scrapling_render` 比 `scrapling_fetch` 慢得多、也更吃内存，所以默认从静态抓取起步。两条
判据：

**结果比静态抓取短，就退回静态抓取。** 不少页面在服务端下发了可读文字（给搜索引擎与无 JS 用户），
加载后又用自己的脚本把那些容器清空、换成 canvas / Lottie 动画 —— 对这类页面渲染后只会更少。
`networkIdle`、`waitSelector`、`mainContentOnly`、`headless` 都补不回来：直接看渲染后的 DOM，
那些容器已经是空的。这是站点行为，不是插件缺陷。

**`waitSelector` 等的是「元素出现」，不是「内容稳定」。** 元素可能在匹配成功之后才被脚本移除，
所以「选择器匹配上了」不代表那部分内容还在结果里。

还有一条不成判据但值得知道：SVG 里的坐标轴刻度**抓不到**。markdown 转换不输出 `<svg>` /
`<text>` 节点，所以「图表上的数字」用哪个工具都拿不到 —— 示例卡片上那些文案是服务端就有的，不是
渲染产物。真要数值就走 `scrapling_capture_xhr` 找 JSON 接口。

## 安全说明

- **SSRF。** Scrapling 自身**没有任何** SSRF 防护。本插件在 Host 侧加一层 URL 策略
  （scheme 白名单、拒绝 URL 内嵌凭据、长度上限、authority 里有反斜杠或控制字符即拒、
  DNS 解析后按**整个答案集**判定是否全为公网、IPv4-mapped 与 NAT64 地址按内嵌 IPv4
  重判），并在 Python 侧再强制一次。**判的和发出去的是同一个地址**：闸门判的是 WHATWG
  归一后的结果，sidecar 转发给 Python 的也是这个归一串 —— 否则「判的是 A、连的是 B」
  本身就会成为绕过面。浏览器侧的网络守卫由插件自己的代码注册，覆盖主导航、子资源、XHR
  与 WebSocket 握手。

  已知缺口若干，都写在明处：
  - **连接钉扎**（undici 层技术）对非 Node 传输不可用；校验与真正建连之间有 TOCTOU
    窗口。静态抓取由 curl_cffi 的 `follow_redirects="safe"` 兜住重定向，浏览器抓取由
    Python 侧的 route handler 兜住。
  - **NAT64 前缀不做动态探测。** dsh 内置会用 `ipv4only.arpa` 哨兵探测当前网络真正生效
    的前缀；本插件默认覆盖两个标准化前缀（`64:ff9b::/96`、`64:ff9b:1::/48`）。用运营商
    自建前缀的网络请用设置里的 `nat64Prefixes` 显式声明，否则藏在 IPv6 里的私网 IPv4
    会被当成普通公网 IPv6 放行。反过来，自建前缀一旦声明就**对所有 IPv6 生效**，不限于
    落在 RFC 6052 段里的那些。
  - **没有端口白名单**（默认不限端口），与 dsh 内置 fetch provider 的取舍一致。
  - **`scrapling_crawl` 已有自己的地址复核，但起点那一关仍是第一道。** 起点 URL 过
    `guard.url_allowed`（与浏览器路径同一个实现，两侧同解），爬虫会话设了
    `follow_redirects="safe"` 让 curl_cffi 拒绝跳向私网的跳转，每一页收进结果前再复判
    **两次**：一次过守卫（最终 URL 仍可能落在私网上），一次过起始域 —— Scrapling 的
    `allow_domains` 是字符串比较，只管页面里发现的链接、不管重定向目标，所以跳向站外
    公网主机的那一跳必须在这里拦住。
  - **WebSocket 覆盖依赖 Playwright 版本。** 守卫用 `route_web_socket` 拦握手；更老的
    Playwright 没有这个方法，那种情况下 WebSocket 不在守卫范围内，插件会往日志与能力报告
    里如实标出，不会静默降级。
  - **浏览器二进制路径与 CDP 端点是部署级强能力。** 只从部署配置来，模型入参到不了；
    指向它们等于交出「执行这个文件」与「把浏览器交给这个调试端点」。

  Host 侧那道策略由 `SidecarClient.call` 统一执行，因此覆盖每一个工具，也覆盖
  `web_fetch` provider；判否时抛 `URL_BLOCKED`，请求根本不会写进管道。`web_search` provider
  也对它准备交回的 URL 跑同一道闸门：被闸门判否的命中不会成为可引用的 source，模型因此不会
  拿到一个「下一次抓取必然被拒」的地址。

- **浏览器引擎不认代理环境变量。** patchright 不读 `HTTP_PROXY` / `HTTPS_PROXY`，所以
  `scrapling_render` 与 `scrapling_capture_xhr` 即使在整台机器
  都走代理时也**直连**——走浏览器的那部分请求会溜出隧道。而 `scrapling_fetch` 与爬虫底下的
  curl_cffi **是**认这些变量的，于是两半在必须走代理的网络上行为不一致。这里写明而不是绕过去：
  把浏览器也送进代理等于交给本包一项部署级强能力，而在没法对着一个真实代理验证的前提下
  把它发出去，比说清楚更糟。上面的 `allowSyntheticDns` 只修闸门，**不改变流量去向**。

- **有配额，不是无上限的常驻资源。** 同开会话至多 8 个（其中浏览器会话 —— 也就是 `stealth`
  会话类型 —— 至多 3
  个，每个都是一个真实的 Chromium 进程）、同时在跑的爬虫至多 2 个、单页正文按
  `maxContentChars` 封顶、单个协议帧 8 MB、待处理队列 16 帧。撞上限时返回的是明确的错误码
  （`SESSION_LIMIT` / `CRAWL_BUSY` / `BAD_FRAME`），由模型自己退避，而不是把机器吃光。
- **不接受来自模型的代码执行。** `page_action`、`page_setup`、`selector_config`、
  `proxy`、`executablePath`、`cdpUrl` **绝不进入任何工具 schema**。浏览器侧的网络守卫
  由插件自己的代码注册，绝不来自模型入参。
- **反注入清洗无条件执行**，且不提供任何让模型关掉它的开关：`markdown`、`html`、`text`
  三条提取路径都过 Scrapling 的 `_strip_noise_tags` + `_sanitize_for_ai`，`html` 再补一道
  属性剥离。代价是 `html` 不再是字节级原始文档。

## 开发

```sh
pnpm install          # 安装依赖
pnpm run check        # 类型检查 + lint + 构建 + 测试 + 格式检查
pnpm run build        # 把 host.ts / src/client-entry.ts 打成 host.js / client.js
pnpm run test:py      # 端到端验证 Python sidecar（需仓库根的 _env/.venv）
```

源码全部是 TypeScript。`host.js` 与 `client.js` 是**构建产物**，故意用 `.js`：
Node 拒绝为 `node_modules` 里的包剥类型，而 dsh 正是从 `node_modules` 加载本插件的。

产物是 **ESM-only**：`require()` 拿不到它，这是有意的（宿主按包名载入运行），不是缺陷。

构建时 `dependencies` / `peerDependencies` / `devDependencies` 三张表里的包**一律外部化**。
运行期由宿主提供的那些（cordis、dsh-tools、dsh-subprocess、dsh-jobs）若被内联，本包会拿到
一份私有的副本 —— 模块级状态会裂成多份，更有甚者（按 `import.meta.url` 相对解析自身
package.json 的那种）一 import 就抛 `MODULE_NOT_FOUND`。`test/publish-manifest.test.ts` 会把
产物真的载入一次、并断言没有内联的宿主包正文，把这两件事钉住。

发布走 [`.github/workflows/publish.yml`](./.github/workflows/publish.yml)（手动触发，
OIDC trusted publishing + `--provenance`）。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。本包代码与第三方代码的边界见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
