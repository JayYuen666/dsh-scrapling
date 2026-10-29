# Scrapling 网页抓取

抓取与结构化抽取网页——JS 渲染、CSS/XPath 抽取、选择器自愈、带登录态的会话、后台爬虫与页面问答，全部由一个常驻 Python 进程提供。

## 设置卡上改的是什么

卡上五十个取值按用途分组，多数每次调用现读，改完下一次调用就生效，不需要重启宿主。`pythonBin`、`failFastOnMissingPython` 与 `dataDir` 在插件装载时生效，改它们需要重启。

- **运行环境** — `pythonBin`（留空）决定用哪个解释器：显式路径优先，其次托管的能力包安装，再次本包的开发 venv，最后落回 PATH 上的 `python3`。每次都会播报选中的是哪一支。`failFastOnMissingPython`（默认开）让 sidecar 起不来时直接拒绝装载；而解释器起得来但没装 Scrapling 时，一律降级成「工具不可用」并在日志里点名路径。`dataDir` 是 sidecar 状态的落点。
- **工具开关** — 十五个（fetch、extract、locate、links、render、capture XHR、会话网络历史、session、登录态、crawl、answer、session read、页面动作、download、screenshot）。关掉一个就是模型看不见它，连对应的提示词段落一起撤掉。
- **抽取与输出** — `extractionType`（markdown/html/text）、`mainContentOnly`，以及各工具的输出预算（`fetchMaxOutputChars` 等，默认 200000）——那是 UTF-8 字节预算，两侧都会执行。
- **浏览器** — `headless`（默认开）、`networkIdle`（默认关）、`blockAds`（默认开，约 3500 个域名）、`pierceShadow`（默认关）、`waitSelectorState`。
- **超时与回收** — `fetchTimeoutMs`（120000）、`sidecarHandshakeTimeoutMs`（30000）、`sidecarGraceMs`（5000）。
- **网络与安全** — `proxyUrl`（显示时遮蔽）、`proxyBypass`、`allowedHosts`、`syntheticDnsRanges`、`nat64Prefixes`，以及搜索侧的 `searchBackend`、各家 API key、`searxngEndpoint`、`searchPublicFallback`（默认关）。
- **页面问答** — `answerProvider`、`answerModel`、`answerMaxTokens`（2000）。

## 有些卡上开关还要配一道部署侧的开关

卡上的 `provideWebFetch` 与 `provideWebSearch` 单独拨过去不够：部署侧还得把本插件选成宿主的 fetch / search 提供方，基座那一份仍会接管。页面动作、下载与登录态三档同理。只看卡上会以为开关坏了。

## 三十项部署值留在卡外

它们改的是本插件怎么接进宿主，不是某次会话该怎么走，而且都要重启才生效。最可能遇到的是这几项：

- `integrationMode` — `native` 把工具注册进宿主；`mcp` 改为把同一份工具表端给 MCP；`official-mcp` 两者都不做，只带上游 server 那条目。三档互斥，且只在装配时读一次，切换必须重启。
- `mcpPort`（默认 39217）要与 profile 里 MCP 客户端条目的 URL 同值；改完要重跑本包的 `setup`，它的 `doctor` 会比对两边。
- `officialMcpEnabled`（默认关）需要这一档加上 `setup` 的 `--accept-risk` 同一次表态才生成条目，因为上游 server 暴露的动作不归本插件的守卫看。
- `allowWriteMethods`（默认关）——读网页是这插件的本职，改对端状态不是，所以这一档属于部署表态。
- 同一档位的还有：浏览器二进制与 CDP 端点、真 Chrome 与 DNS-over-HTTPS 选项、Redis 地址与自适应存储、爬虫的运行时/robots/延时/并发/策略/checkpoint、各家搜索端点。

这些都写在本插件注册行的 `config:` 块里。

## 需要外部提供什么

Python 与 Scrapling 由你提供，本插件从不动你的系统解释器。Chromium 由 `python -m patchright install chromium` 装。能力包按层作为宿主作业安装——`core`、`browser`、`search`、`media`、`adaptive-redis`、`mcp`；只有 `core` 时插件照用，所以工具面本来就可以是不完整的。回退到的解释器没装 Scrapling 时工具表为空，指引会给出可照抄的 `pip install` 命令——那是「装之前要做的一件事」，不是产物缺陷。搜索后端要各自的 API key 或一套 SearXNG。`adaptiveStorage: redis` 要连得上的 Redis。

失败是被点名的，不是被藏起来的：`SIDECAR_*`、`INSTALL_*`、`SEARCH_AUTH`、`JOBS_UNAVAILABLE`、`SESSION_STATE_DISABLED`、`MCP_PORT_IN_USE` / `MCP_PORT_MISMATCH` / `MCP_MODE_CONFLICT` / `MCP_CLIENT_MISSING`、`OFFICIAL_MCP_DISABLED`、`RISK_NOT_ACCEPTED`。MCP 的 token 只从宿主环境变量 `DSH_SCRAPLING_MCP_TOKEN` 读，绝不写进 profile——那份文件是明文。

## 更完整的说明

sidecar 协议、能力包安装器内部、离线资产与安全模型都写在随包 README（`README.md` / `README.zh-CN.md`）。
