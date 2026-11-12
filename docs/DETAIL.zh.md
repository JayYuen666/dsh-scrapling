# Scrapling 网页抓取

抓取与结构化抽取网页——JS 渲染、CSS/XPath 抽取、选择器自愈、带登录态的会话、后台爬虫与页面问答，全部由一个常驻 Python 进程提供。

## 设置卡上改的是什么

卡上五十个取值按用途分组，多数每次调用现读，改完下一次调用就生效。另有几项只在装配时读一次，改完要让插件重新装配——重启宿主即可。这几项是：十五个工具开关、`provideWebFetch` / `provideWebSearch` 以及与它们一起被检索 provider 快照的 `searchBackend`、各家 key、`searxngEndpoint`、`fetchMaxOutputChars`、`fetchTimeoutMs`，再加上 `pythonBin`、`failFastOnMissingPython` 与 `dataDir`。

- **运行环境** — `pythonBin`（留空）决定用哪个解释器：显式路径优先，其次托管的能力包安装，再次本包的开发 venv，最后落回 PATH 上的 `python3`（Windows 上是 `python`）。托管那一档只在 macOS arm64 上尝试——有已验能力包的就这一个平台——其余平台从显式路径直接跳到 venv 与 PATH。每次都会播报选中的是哪一支。`failFastOnMissingPython`（默认开）让 sidecar 起不来时直接拒绝装载；而解释器起得来但没装 Scrapling 时，一律降级成「工具不可用」并在日志里点名路径。`dataDir` 是 sidecar 状态的位置。
- **工具开关** — 十五个（fetch、extract、locate、links、render、capture XHR、会话网络历史、session、登录态、crawl、answer、session read、页面动作、download、screenshot）。关掉一个就是模型看不见它，连对应的提示词段落一起撤掉。
- **抽取与输出** — `extractionType`（markdown/html/text）、`mainContentOnly`、`stripInlineImages`（默认开），以及各工具的输出预算：`fetchMaxOutputChars`、`extractMaxOutputChars`、`renderMaxOutputChars` 默认 200000，`xhrMaxOutputChars` 默认 120000。宿主侧按 UTF-8 **字节**裁剪，同一个数值交给 sidecar 时叫 `maxContentChars`，那边按**字符**截——两处谁更紧就按谁收。`crawlMaxItems`（1000）管的是页数，不是输出大小。
- **浏览器** — `headless`（默认开）、`networkIdle`（默认关）、`blockAds`（默认开，约 3500 个域名）、`pierceShadow`（默认关）、`waitSelectorState`。
- **超时与回收** — `fetchTimeoutMs`（120000）、`sidecarHandshakeTimeoutMs`（30000）、`sidecarGraceMs`（5000）。
- **网络与安全** — `proxyUrl`（显示时遮蔽）、`proxyBypass`、`allowedHosts`、`syntheticDnsRanges`、`nat64Prefixes`，以及搜索侧的 `searchBackend`、各家 API key、`searxngEndpoint`、`searchPublicFallback`（默认关）。
- **页面问答** — `answerProvider`、`answerModel`、`answerMaxTokens`（2000）。

## 有些卡上开关还要配一道部署侧的开关

卡上的 `provideWebFetch` 与 `provideWebSearch` 单独拨过去不够：部署侧还得把本插件选成宿主的 fetch / search 提供方，否则 dsh 自带的那一份仍会接管。页面动作（`allowBrowserActions`）、下载（`allowFileDownloads`，单次大小由 `downloadMaxBytes` 管）与登录态（`sessionStateDir`，留空时存/取那两个工具根本不注册）三档同理。只看卡上会以为开关坏了。

## 二十九项部署值留在卡外

它们改的是本插件怎么接进宿主，不是某次会话该怎么走，而且都要重启才生效。最可能遇到的是这几项：

- `integrationMode` — `native` 把工具注册进宿主；`mcp` 改为把同一份工具表交给 MCP；`official-mcp` 两者都不做：宿主有 `mcpManager` 时动态注册上游 server，没有时只引入上游 server 的 `dsh-mcp-client` 条目。三档互斥，且只在装配时读一次，切换必须重启。
- `mcpPort`（默认 39217）要与 profile 里 MCP 客户端条目的 URL 同值。这两条命令都不读 `mcpPort`，要自己带上：`setup --mode mcp --port <mcpPort>` 与 `doctor --mode mcp --port <mcpPort>`。不带 `--port` 时，setup 按默认的 39217 生成，doctor 也没有期望端口可比——profile 停在别的端口上照样一声不响地过。
- `officialMcpEnabled`（默认关）需要这一档加上 `setup` 的 `--accept-risk` 同一次表态才生成条目，因为上游 server 暴露的动作不归本插件的守卫看。
- `allowWriteMethods`（默认关）——读网页是这插件的本职，改对端状态不是，所以这一档属于部署表态。
- 同一档位的还有：浏览器二进制路径、真 Chrome 与 DNS-over-HTTPS 选项、Redis 地址与自适应存储、爬虫的运行时/robots/延时/并发/策略/checkpoint、各家搜索端点。

这些都写在本插件注册行的 `config:` 块里。

## 需要外部提供什么

Python 与 Scrapling 有两个来源：`core` 能力包会在 `dataDir` 下装一份托管的 CPython 3.14.9 加 Scrapling 0.5；或者把 `pythonBin` 指向你自己装好的解释器——本插件从不动你的系统解释器。能力包只在 macOS arm64 提供，其他平台上一律拒绝安装（`INSTALL_PACK_BLOCKED`），那时 Python 才真是「由你提供」。Chromium 由 `python -m patchright install chromium` 装。能力包按层作为宿主作业安装——`core`、`browser`、`search`、`media`、`adaptive-redis`、`mcp`；只有 `core` 时插件照用，所以工具这一层本来就可以是不完整的。选中的解释器起得来但里面没 Scrapling 时工具表为空，可照抄的 `pip install` 命令写在**装载时的告警**里（不在工具提示词段落里）——那是「装之前要做的一件事」，不是产物缺陷。搜索后端分三类：Tavily、Brave、Serper 要各自的 key，SearXNG 要实例地址，而 `bing` 与 `duckduckgo` 是公共端点、不要凭据；`auto` 只有在打开 `searchPublicFallback` 之后才会走公共引擎。`adaptiveStorage: redis` 要连得上的 Redis。

失败是被点名的，不是被藏起来的：`SIDECAR_*`、`INSTALL_*`、`SEARCH_AUTH`、`JOBS_UNAVAILABLE`、`SESSION_STATE_DISABLED`、`MCP_PORT_IN_USE` / `MCP_PORT_MISMATCH` / `MCP_MODE_CONFLICT` / `MCP_CLIENT_MISSING`、`OFFICIAL_MCP_DISABLED`、`RISK_NOT_ACCEPTED`。MCP 的 token 只从宿主环境变量 `DSH_SCRAPLING_MCP_TOKEN` 读，绝不写进 profile——那份文件是明文。

## 更完整的说明

sidecar 协议、能力包安装器内部、离线资产与安全模型都写在随包 README（`README.md` / `README.zh-CN.md`）。
