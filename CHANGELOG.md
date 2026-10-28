# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。最新版本在最上。

## 0.1.4

### Fixed

- **`scrapling_fetch` 的 `form` / `json` 不再静默落地**：`allowWriteMethods=false` 时这两个参数与 `method` / `body` 走同一道闸，模型参数面里根本不出现；写方法开启时，给了 `form` / `json` 而没给 `method` 会隐含 `POST`（与静态会话抓取一致），显式 `GET` 配请求体判 `BAD_ARGS`。此前请求照发、对端收到空体，而回包上没有任何一行能看出这件事。
- **离线解析器的 `url` 不再被出站闸门误拦**：`scrapling_extract` / `scrapling_locate` / `scrapling_links` 的 `url` 只作相对地址基准，不做 DNS 解析也不连网；此前它被当成取回目标，给一个内网基准地址就会报 `URL_BLOCKED`。
- **URL 守卫错误文案不再回显凭据**：`https://user:pass@host` 在 `URL_BLOCKED` 里脱敏成 `***@`，判定与连接仍用原串。
- **`sessionStateDir` 未配置时不再注册登录态存取工具**：`scrapling_session_state_save` / `scrapling_session_state_load` 现在与 jobs / attachments 同一种门，目录为空时那两只注定回 `SESSION_STATE_DISABLED` 的工具不会出现在工具目录里，并给一条点名修法的告警。
- **模型可见渲染补齐**：`includeHtml` 真正输出每条匹配的 `html`；`scrapling_locate` 的 `attributes`、`ancestors`、`full css` / `full xpath` 与 `truncated` / 截断提示进入模型文本；`session_network` 印出 `id` 与（`includeHeaders` 时）`headers`，`requestId` / `afterId` / `includeHeaders` 不再是无可见效果的旋钮；`capture_xhr` 零捕获时给一条「页面可能没有 XHR，也可能抓早了」的提示。
- **原生工具错误带回错误码**：sidecar 的错误不再只剩 `Error: <message>`，模型能看到 `BAD_ARGS: …` / `URL_BLOCKED: …` 前缀。
- **非法 `impersonate` 报 `BAD_ARGS`**：curl_cffi 在请求时才校验浏览器预设，过去把 `ImpersonateError` 泄漏成一次抓取失败；现在点名可用预设。
- **爬虫作业结算行保留错误码并区分取消与失败**：`BAD_ARGS` / `URL_BLOCKED` 以 `CODE: message` 进入作业最终 detail；`job_kill` 落 `killed` + `cancelled`，异常落 `failed`，不再一律 `killed`。
- **爬虫结果里的 `notice` 能到模型眼前**：`mode=shopify` 遇到 404 / 非 JSON / 非店铺 JSON、`mode=sitemap` 发现期被 `maxPages` 截断时，作业输出多一行 `crawl notice:`（此前 Python 侧有这份原因、JS 侧从不读）。
- **`sitemapFollow` 不再放大抓取**：发现期抓子 sitemap 与 sitemap URL 各自按 `maxPages` 封顶，`maxPages=2` 不会再打出几百次请求。
- **浏览器页面超时与工具调用预算解耦**：`scrapling_render` / `scrapling_capture_xhr` / 会话抓取 / `session_act` 在模型未给 `timeoutMs` 时不再下发页面超时（交给 Python 的 30s），显式值只按 `min(调用值, pageTimeoutMs)` 下发；坏选择器与永不 idle 的页面因此能返回 `ACTION_FAILED` / 结构化超时，而不是把整次调用拖到宿主外层 120s。
- **静态会话的 `extraHeaders` 生效**：此前只有浏览器会话合并它、静态路径静默丢掉；现在与 `headers` 合并，同名以 `extraHeaders` 为准。
- **浏览器下载走附件回退**：`useBrowser=true` 抓二进制响应时 Chromium 会报 `Page.goto: Download is starting`，现在改为先开会话取 URL、再经附件链路落盘；`DOWNLOAD_FAILED` 也补回原始原因。
- **登录态文件错误不再泄漏宿主绝对路径**：`state_load` 的 `FileNotFoundError` / JSON 解析错误只点名模型自己给的文件名。
- **文档与 CLI 同步**：随包 `cordis.patch.yml` 的工具数从 13 改到 19；`setup --status --profile <目录>` 读该 profile 的 `pythonBin`（不再永远回 `python3/path/unknown`）；README 设置卡表把 `duckduckgoEndpoint` 从 volatile 栏移出，并新增 README 与 config schema 的一致性测试。

## 0.1.3

### Added

- **新增 `scrapling_locate` 与 `scrapling_links`**：前者按文本、正则或相似元素定位并返回生成的 CSS/XPath 选择器，后者列出链接与下一页候选。两者只解析调用方给的 HTML，不发网络请求；对应设置开关 `locateEnabled` / `linksEnabled` 默认开启。
- **抓取参数与响应元数据**：`scrapling_fetch` / `scrapling_render` / 会话抓取支持查询参数、表单/JSON 请求体、HTTP/3、编码回退、重试间隔、安全响应元数据与 `extractionType=json`；网络历史支持方法、状态、类型、静态资源与时间窗过滤。
- **爬虫 sitemap / feed / Shopify 模式**：`mode=sitemap` 只抓 sitemap（或匹配 `sitemapFollow` 的子 sitemap）里的 loc，不跟随页面内链接；`mode=feed` 读 XML/CSV feed 并按 `fields` 映射出结构化行。三种模式沿用 content 模式的 URL/域闸门与部署级待站策略。`mode=shopify` 走店铺的 `/collections.json` + `/products.json`（上游 `ShopifySpider`）按变体出行；本地夹具店已跑通，真实 Shopify 店铺未验。
- **爬虫内容选项与统计**：`scrapling_crawl` 支持 CSS 选择器与内容规则、`mainContentOnly`、页数/时长上限；作业状态带已抓页数与跳过原因。
- **搜索 provider**：`ctx.web` 的 `web_search` 可由 Scrapling 的 Tavily/Bing 发现层接管（`searchBackend`），搜索结果可选择性渲染。
- **浏览器与媒体工具**：`scrapling_session_read`、`scrapling_session_act`、`scrapling_download`、`scrapling_screenshot`；动作与下载有部署级门禁，截图经宿主 attachment 服务。
- **`mcp` 模式（`integrationMode: mcp`）**：插件在宿主进程内起一个 streamable-http 的 MCP server，默认 `http://127.0.0.1:39217/mcp`（端口走部署项 `mcpPort`），端出与 native **同一份** `ToolDefinition` 表：19 个原始名去掉 `scrapling_answer`，再加 MCP 独有的 `search`。URL 闸门、会话、作业与 adaptive 存储全部复用，门禁一致（`allowBrowserActions=false` 就没有 `session_act`）。只绑回环，声明正文超过 1 MiB 判 `413`，非 `/mcp` 路径 `404`；token 只从环境变量 `DSH_SCRAPLING_MCP_TOKEN` 读，不写进 profile；截图以 MCP image content 交出而不是宿主附件。新增运行期依赖 `@modelcontextprotocol/sdk@1.32.2`，它只在真的起 server 时才动态载入，`native` 模式一行都不执行。

- **`setup --mode` 与 `doctor`**：`dsh-scrapling setup --mode native|mcp|official-mcp [--port N] [--with-auth] [--accept-risk] [--profile 目录] [--apply]` 产出 `dsh-mcp-client` 的条目文本；不带 `--apply` 只打印，带上就写到 `<dataDir>/mcp/<模式>.patch.yml` 并打出路径，profile 本体一个字都不改（宿主没有安全追加 `cordis.patch.yml` 的接口）。`dsh-scrapling doctor --mode <模式> --profile <目录> [--port N]` 读那份 profile 自己写下的 `cordis.patch.yml` 与 `package.json`，逐条点名：同一 `serverName` 两条例目、本插件条目与官方 `stdio` 条目并存、条目类型与模式不符、条目端口与 `--port` 不一致、客户端缺失或钉的不是 `0.2.1-rc.3`/`next`、`officialMcpEnabled` 关着却留着官方条目；一致退 0、有点名退 1、参数不对退 2。`official-mcp` 需要 profile 的开关与命令行的 `--accept-risk` 两处分别表态，缺任一处只打错误码不写文件；官方二进制尚未由 `mcp` 包提供时，它额外打一行说明这条条目起不来。
- **运行时能力包安装器与 CLI**：`core` 装托管 Python 3.14.9 + Scrapling 0.5，`browser` 装完整 Chromium；`dsh-scrapling setup --status|--feature|--repair|--uninstall|--purge` 是唯一安装入口，设置卡显示包状态并可在有 remote/作业后端时发起安装、修复与取消。

### Fixed

- **两道 URL 闸门不再一边宽一边严**：Python 侧此前在每条发出请求的路径上都接受 `ws:`/`wss:`（那只有 WebSocket 握手判定该认），也不看 URL 内嵌的凭据。现在请求侧只认 `http`/`https`，内嵌凭据一律判拒 —— Host 侧 `url-policy` 的这两条在 Python 侧同样成立。放行名单只豁免「地址必须公网」这一条，不豁免这两条。
- **crawl 的第二、第三个 URL 现在过宿主闸门**：`SidecarClient.call` 原先只筛 `params.url`，模型给的 `sitemapUrl` / `feedUrl` 原样进 payload；现在三处都筛，归一过的写进同一份新的参数对象，判否即止、不再为后面的 URL 继续解析。

- **浏览器参数越界不再被报成一次抓取失败**：上游把会话的这两个键收在 `RetriesCount`（1..10）与 `PagesCount`（1..50）里，越界值不在 Scrapling 的参数校验里被拒，而是在它的类型层炸成 `TypeError: Invalid argument type: Expected int <= 10 - at $.retries`，本包再把它归成一次失败。现在 `retries` 与 `maxPages` 在浏览器路径上先判，超限直接 `BAD_ARGS` 并点名上限；静态抓取那一侧的 `retries` 仍不设上限（上游那张表里它是裸 `Optional[int]`）。
- **检索后端扩到六条**：新增 Brave（API）、Serper（API）、DuckDuckGo HTML 与 SearXNG（JSON API）四条发现路径，部署面新增 `braveApiKey` / `serperApiKey` / `searxngEndpoint` / `duckduckgoEndpoint`，`searchBackend` 的取值域随之扩大；每条后端只把自己那把 key 递给 sidecar（拼错后端名不会把 Tavily 的 key 递出去），选中却没配凭据的后端报 `SEARCH_AUTH` 而不是静默换后端。四条后端按各家文档的请求/响应形状实现，用本地 stub 验证形状与错误面（命中映射、401/429、无效 JSON、DDG 的 `uddg` 跳板解码、无结果带 note）；**真实端点与真实 key 未验证**。
- **adaptive 指纹库可放 Redis**：新增 `py/redis_storage.py`（`StorageSystemMixin` 子类，按键 `<prefix>:<注册域>:<sha256(identifier)>` 落、值是该元素的 orjson 指纹；口令不进日志与错误文本），部署面新增 `adaptiveStorage`（`sqlite`/`redis`，默认 sqlite）与 `redisUrl`；`adaptive-redis` 能力包解除 blocked，`redis==8.1.0` 连同哈希钉进 `py/runtime-requirements.txt`。真机：本机 redis-server 上 save/retrieve 往返、经 sidecar 的 `select` 真的把指纹写进 Redis；连不上与缺客户端各有一条点名的 `ADAPTIVE_STORAGE_UNAVAILABLE`。
- **离线安装可用**：`setup --feature <包> --offline <目录> --apply` 全程不联网完成安装 —— 目录里放 Python 归档（名字同清单 URL 最后一段，解码与转义两种写法都认）与 `wheels/`（每条钉版一枚 wheel）。归档哈希照旧按清单校验，pip 带 `--no-index --find-links`；缺归档或缺 wheelhouse 报 `INSTALL_OFFLINE_ASSETS`，不再是一句「未验证」。真机：在代理指向死端口的进程里用 130 MB 资产包装出 core，venv 里 `scrapling` 与 `mcp` 可导入、`scrapling-mcp --help` 可跑。
- **`mcp` 能力包上线**：安装器过去只装 `scrapling==0.5`，而官方 server 的依赖挂在 Scrapling 的 `ai` extra 上（`mcp>=2.0.0`），托管 venv 里因此没有可跑的 `scrapling-mcp`。现在把 `mcp==2.3.0` 及 22 个传递依赖连同哈希钉进 `py/runtime-requirements.txt`，`setup --feature mcp --apply` 走与 `core` 同一条安装/卸载路径。真机验证：CLI 装出的 venv 里 `scrapling-mcp --help` 可用、stdio `tools/list` 回 16 枚工具，宿主在 `integrationMode=official-mcp` 下按本插件生成的条目把 16 枚全部注册成 `mcp__scrapling__*`。
- **venv 里的 console script 不再因为暂存目录改名而失效**：venv 建在 `runtime/.tmp/venv-<uuid>` 再整体 rename 到 `runtime/venv`，而 pip 把解释器绝对路径写进入口脚本的 shebang，于是 `scrapling-mcp` 一跑就是 `bad interpreter: .../.tmp/venv-…/bin/python3`（装 `mcp` 包时真机撞到）。安装后现在会把 `bin/` 下以暂存路径开头的 shebang 改到最终路径；判据是一条用假 pip 写出暂存 shebang 的单测。
- **`mcp` 模式的客户端条目首装不再会被启动顺序打死**：真宿主沙箱实测，`failOnStartupError: true` 时客户端在第一趟 `connect ECONNREFUSED 127.0.0.1:<mcpPort>` 就抛掉 fiber，宿主报「1 entry did not activate」—— 而端口要等插件与 sidecar 握手完成才 listen。`setup --mode mcp` 生成的条目与两份 README 的示例都改成 `false`，让宿主 MCP 客户端自带的重连（默认开启，500ms 起退避、上限 10 次）去吸收这一次竞态；官方 `stdio` 那条相反，server 由客户端自己 spawn，连不上是真坏，仍留 `true`。
- **设置卡的安装 / 修复 / 取消按钮点了必报 `arguments-invalid`**：宿主 gateway 对源码态 Remote 描述符按**参数名**组包（`methodParameterNames` 读方法的形参表），而 `build-host.ts` 用 `minify: true` 把 `installPack(request)` 的形参压成了单字母，线上名字与客户端描述符声明的 `request` 对不上，`assertExactArguments` 直接拒。现在改为 `minify: { compress: true, mangle: false }`（体积 +25%，注释里写明原因），新增 `test/build-signature.test.ts` 对内存构建产物断言四个方法的形参名与 `src/runtime-reader.ts` 的 `RUNTIME_DESCRIPTORS` 逐字一致，防止将来重新打开标识符压缩又静默坏掉。
- **MCP server 可以被伪造 Host / Origin 打到**：`streamable-http` 默认不校验来源，本机浏览器里的任意页面都能对本机端口发请求。现在按绑定地址推导 `allowedHosts` / `allowedOrigins`（通配绑定时列回环三枚 + 各网卡非 internal 地址；显式绑定只认该字面量），并在 transport 上开 `enableDnsRebindingProtection`；没设 `DSH_SCRAPLING_MCP_TOKEN` 时往 stderr 打一行「无鉴权」警告，但不阻断（回环可达性是既有契约）。
- **`uninstall` 没有 dry-run、也不走安装锁**：现在默认只打印计划，必须显式 `--apply` 才落地，且落地在 `withInstallLock` 里做——安装进行中撤包会拿到 `INSTALL_BUSY` 而不是把 venv 从安装器脚下抽走。
- **安装锁按「写了一小时」判陈旧会接管活进程**：一次正常 pip 安装要下载几百 MB，跑过一小时很常见；接管一把活进程持有的锁等于让两个安装同时写同一个 venv。判据改成 pid 优先（本进程、`kill(pid, 0)` 成功、EPERM 都算活，ESRCH 才算死），锁里读不出 pid 时才退回 mtime 宽限；释放时也只在锁里写的是本进程 pid 时才删，避免把别人的新锁删掉。
- **venv 安装过程中有一段「没有解释器」的窗口，state.json 也可能留下半截**：旧实现先删旧 venv 再 rename 暂存目录，中途失败就两头空。现在先把暂存的 `bin/` shebang 改到最终路径，再把旧 venv 挪到 `.tmp/venv-previous-<uuid>`、暂存目录 rename 进正位；**「落地」以 `state.json` 写成功为准**——rename 之后、状态还没写成就失败时，`finally` 会把新 venv 撤掉、把旧 venv 搬回原位（以前这种半完成状态会留下「新 venv + 旧状态」，且旧 venv 已被删）。`state.json` 改成同目录临时文件 + `rename` 原子替换，内容坏掉时报 `INSTALL_STATE_CORRUPT` 并点名文件（以前当成空态，下一次写入会把 `browser: ready` 抹掉）。
- **runtime 目录权限**：`dataDir/runtime` 建出来即 `0700`、已存在也重收（早期按 umask 建成的 0755 因此能修好），Windows 上跳过；登录态文件保存后 `0600`。见 spec §11.6。
- **会话抓取会替调用方决定浏览器参数**：`session_fetch` 此前把 `blocked_domains` / `disable_resources` 以空值发下去，等于强制覆盖上游默认；现在只有调用方显式给了才出现在 payload 里。浏览器下载补上 `page_setup` 与 `guard.browser_proxy(url)`（后者在配了代理的机器上防止下载走直连泄露出口 IP）。
- **下载上限可以被调用方绕过**：部署的 `downloadMaxBytes` 现在与调用值取 `min`，浏览器路径也按同一上限夹取；部署项本身不是正整数时报 `BAD_ARGS` 并点名键。`crawl` 超预算时不再丢掉已经抓到的页（已收页与 `more=true` 一起回）；`mode=shopify` 的 `sitemapUrl` 现在同样过 URL 闸门，并按 `sitemapUrl` 的源主机解析店铺（以前只按 `url` 主机，跨主机必然抓空）。
- **MCP 条目文本与 profile 读取的边界**：`setup --mode` 写的 `command` 行改成双引号标量 + 转义（含空格、`#`、冒号、引号、换行），往返 `JSON.parse === command`；`mcp-profile` 读 `cordis.patch.yml` 时认 `\r\n` 行尾，开关只认 `true` / `True` / `TRUE`，不再把裸 `yes`/`on` 当开启。
- **日志与错误文本里仍有可用的凭据碎片**：无 scheme 的 `user:pass@host` 形式此前被 `urlsplit` 读成 scheme、authority 落进 path，脱敏正则抓不到；现在单独处理这一段。`py/guard.py` 里一段重复的死块也已删掉（真正的分支仍在，日志过 `redact_url_secrets`）。
- **Redis 超时是死参数，feed / Shopify 到点不暂停**：`_default_client` 以前收了 `timeout_seconds` 却从不使用，现在同时设 `socket_timeout` 与 `socket_connect_timeout`（默认 2.0s）；sitemap / feed / shopify 收集行时按 `crawlMaxRuntimeSeconds` / 每页 `pause` 到点停下，不再在一个不响应的端点上把预算烧完。
- **读不到上次安装作业时被当成「没有作业」**：`runtime-remote` 的状态读取改成 fail-closed——读失败回 500 并说明读不出什么，不再静默显示「无作业」让用户以为可以重装。`web-provider` 的 `describeRaw` 兜住 `JSON.stringify` 返回 `undefined`（循环引用、`undefined`）时 `.slice` 抛 `TypeError`。
- **`includeHtml` 被 `oneMatch` 路径丢掉**：抽取命中单条时结果对象不带 HTML，调用方要原文只能再抓一次；现在按参数透传。
- **旧代 sidecar 的退出回调会拆掉新一代**：上一代进程延迟触发的 `error` / `done` 事件会把刚起来的进程收尾掉（表现为工具偶发 `SIDECAR_CLOSED`）。`#teardown` 增加第三参 `origin` 做代际判定，非当前句柄的事件记一行 `[sidecar] ignoring stale teardown` 后返回。
- **搜索的公共回退默认被打开**（D10）：`searchPublicFallback` 现在默认 `false`，`auto` 在既没有 Tavily key、也没有 SearXNG 端点、又没开回退时抛 `SEARCH_BACKEND_MISSING`，不再擅自把查询词发给公共引擎；`available()` 同步把这个开关当作发现路径的输入。打开时只发 Bing（两级 DDG → Bing 链等 B4 真实端点验证后再接，见 spec §6.2）。
- **adaptive 存储故障连正文一起失败**：指纹库写/读失败现在返回正文并附 `ADAPTIVE_STORAGE_FAILED: <异常类型>: <原因>` notice，与 spec §7.2 对齐；`extractionType=json` 的结果先剥 `data:` URI 再按 `maxContentChars` 截断（内嵌 base64 之前会把预算吃光）。
- **`scrapling_locate` 参数面与 spec A14 对齐**：新增 `by`（`text`/`regex`/`similar`，与旧名 `queryType` 互认）与 `query`，两者都缺时报 `BAD_ARGS`；抓取 / 渲染 / 抽取 / 定位支持每次调用的 `timeoutSeconds` / `timeoutMs` / `maxContentChars`（仍受设置里的上限封顶）；`session_list` 透传 `alive` / `settings` / `poolStats`。
- **`doctor` 不提示搜索接管**：现在按 spec §6.4 检查 `searchProvider`：未设时提示 `SEARCH_PROVIDER_NOT_CONFIGURED`；设成 `scrapling` 但 `auto` 没有任何发现路径（或显式后端缺凭据）时给 `SEARCH_BACKEND_MISSING` / `SEARCH_AUTH` 与修法；发现「指向 scrapling 但能力包未就绪 / 后端不可用」时计入退出码（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`）。
- **测试基建：探针起不来时给的是裸 spawn 错误**：`test/probe.ts` 现在先做两道路径预检、再 `await once(child, "close")`，失败转成「探针起不来：<python>（<message>）」并带 `cause`；`test/probe.test.ts` 用假 python 路径钉住这条拒绝。`py/tests/test_bridge.py` 里那条超长 `# nosec` 注释按 bandit 要求拆行。
- **能力报告缺 WebSocket 覆盖面**：两份 README 承诺「日志与能力报告都如实标出」，实际只有 `guard.install` 往 stderr 记的那一行 —— 握手时的 `capabilities` 里根本没有这一位，装载阶段的日志看不出这台机器到底拦不拦得住握手。现在报 `websocketGuard`（不启浏览器，按 Page 类上有没有 `route_web_socket` 判），`install` 与能力报告共用同一条判据。
- **sidecar 收尾不停爬虫**：`bridge` 的两条关机路径只关会话，蜘蛛线程留给进程退出带走，而那段里它们还在往 stdout 推事件帧 —— 宿主已经不读这一路了。`close_all_crawls` 现在逐只叫停、按 `SHUTDOWN_JOIN_SECONDS` 有界等地等线程退出（等不到的记一行 stderr，不拖成假关机），并接进两条收尾路径的会话关闭之前。
- **MCP 无鉴权警告指了一处不存在的设置**：警告写「Set `DSH_SCRAPLING_MCP_TOKEN` (or the mcpToken setting)」，而本包刻意没有 `mcpToken` 这一项 —— token 只从环境读、绝不进 profile。文案改成只说环境变量。

### Changed

- **协议面下线 `extract`**：`scrapling_extract` 自始至终走 `select`，离线正文归一的 `extract` 方法没有任何调用方，留着等于给「已有 HTML → 正文」多开一条可以绕开清洗的入口。清洗只剩 `to_payload` 一条口（`scrapling_session_read` 走的就是它）：判据改钉在进程内的 `to_payload` 调用上，上游键名对照由 `contract_probe` 直接摆到同一处调用点，协议侧只钉「`extract` 回 `UNKNOWN_METHOD`」。

- **门禁与 Python 启动器改成跨平台**：`py` / `py:which` 从 `sh -c` 换成 `py-launcher.mjs`（POSIX 找 `_env/.venv/bin/python`，Windows 找 `_env/.venv/Scripts/python.exe`；都没有才落 PATH 上的 `python3` / `python`），`face:py` 从 `python -c` 移到 `face-py.mjs`，覆盖率链不再用 `DSH_PY_COVERAGE=1` 这种前缀式赋值与 `mkdir -p`。CI 矩阵因此加了一格 `windows-latest`（node 24）：验的是插件与门禁在 Windows 上跑得通，运行时能力包仍只在 macOS arm64 提供。
- **`pythonBin` 留空时的回落文案说清平台**：POSIX 上的回落名是 `python3`，Windows 上是 `python`（`resolveRuntime` 交给宿主的是 `python.exe`）；两份 README 与设置卡提示同步。

### Boundaries

- 运行时能力包只在 **macOS arm64** 验证；Windows、Linux 与 macOS x64 的包状态为 `blocked`。
- `adaptive-redis` 与 `mcp` 包均已可用：`redis==8.1.0` 与 `mcp==2.3.0` 连同传递依赖（带哈希）钉在 `py/runtime-requirements.txt`，装进与 `core` 同一个 venv，官方 `scrapling-mcp` 由此可起。`integrationMode` 有 `native` / `mcp` / `official-mcp` 三档：前两档直接可用；`official-mcp` 只由 `setup` 生成条目配置，设成它既不注册原生工具也不起本插件的 server（B10 是这条条目背后的风险确认）。
- Shopify 档只在本地夹具店上验过，真实店铺未跑；official-mcp 的条目文本可生成，依赖 `mcp` 包。

## 0.1.2

这一版收口协议边界、sidecar 生命周期与 Windows 路径/编码三类只在真实部署里才暴露的缺陷；工具面与设置项未增。

### Changed

- **宿主线抬到 `0.2.1-rc.3`**：`engines.dsh`、peer/dev 依赖、overrides 与 README 徽标/正文同值；shared 下限随根真源投影。
- **构建脚本薄化**：host/client 构建统一走 shared 的 `lib/build-*`，产物仍落 `dist/`；CI/CodeQL/Scorecard/Dependabot 同步。
- **`dataDir` 建不出来时按 `failFastOnMissingPython` 处置**：开着拒绝加载并点明路径，关着降级为不注册任何工具，不再留下「设置卡能开、工具全没有」的空壳。
- **crawl 作业的同步异常落成拒绝**：`attachController` / `start` 在调用那一刻抛错时也走 `JOBS_UNAVAILABLE`，不再从 Promise 的声明缝里漏出裸宿主错误。

### Fixed

- **问答边界可被页面正文伪造**：`</PAGE>`、`</ page>` 等写法能冒充闭合标签；现在按大小写与空白无关匹配，替换成不含标签语法的 〔page-close〕 / 〔page-end〕，系统提示同步改。
- **搜索后端不响应时永久挂起**：请求加 `AbortSignal.timeout` 并与调用方 signal 合并；超时原样抛出，不误报成「后端回了坏东西」。
- **sidecar 正常退出不触发收尾**：`done` 的 resolve 分支现在也走 `SIDECAR_CLOSED`，`alive`、能力缓存与在途请求不再停在陈旧状态；`onEvent` 回调抛错只记日志，不再拆掉整个常驻进程；`#starting` 只清同代；先编码后登记 pending；stdin 失效即收尾。
- **帧错误分类与序列化**：新增 `frame-too-large`；`JSON.stringify` 返回 `undefined` 的值也判帧失败，不再写出字面量 `undefined`。
- **输出预算非法时绕过截断**：`NaN`、0、负数与小数回落到 200000 字节并取整，不再把 `NaN` 传给 `TextRetainer`。
- **错误文本可能是空串或 `[object Object]`**：`asText` 对空白串回退，对数字/布尔/bigint 取 `String`。
- **属主线程停止后投递永久阻塞**：会话 worker 加 `_closed` 标记与 600 秒兜底，分别报 `NO_SUCH_SESSION` / `SESSION_CLOSED`。
- **构造中被关闭的浏览器会话跨线程 close 抛 greenlet 且被吞**：改在属主线程关闭后再停线程，墓碑与 `pop` 放在同一临界区，防会话复活。
- **capture 的会话路径漏部署代理与 `block_webrtc`**：配了代理的机器上这条路径会直连、泄露真实出口 IP；现在补 proxy，走代理时强制 `block_webrtc`。
- **Windows 管道按本地 ANSI 编码**：非 ASCII 帧编码失败会被 worker 吞掉、调用方只能等超时；stdout/stderr 强制 UTF-8。反斜杠 `bridgePath` 下 `py/` 目录解析失败，改用 `os.path.dirname`。
- **单页超过回包预算会顶破宿主切帧线**：新增 `_shrink_page` 把单页压到预算内并标 `truncated`，不再让整个 sidecar 被判成坏帧拆掉。
- **NAT64 的 /40、/48、/56 内嵌 IPv4 读取错误**：IPv4 被第 9 个字节切断，按连续 4 字节切会把私网地址读成公网；改取 5 字节窗口并剔除 u 字节。
- **Windows 系统代理的 REG_DWORD 写法 `0x1` 不被识别**，畸形端口或方括号会抛错；现在接受 `0x1`，`ValueError` 一律按「地址不可用」返回 `None`。
- **`web_fetch` 只标记 `truncated` 而不真裁**：超长正文仍会进上下文；改为 `capText` 真正头尾截断，失败保留 sidecar 错误码前缀（`URL_BLOCKED`、`SIDECAR_TIMEOUT`、`SIDECAR_UNAVAILABLE`），取消原样抛出。
- **设置卡数字输入用 `type=number` 会把 `-` 或粘贴的非数字洗成空串**，再被当成 clear 静默删掉覆盖；改为 text + `inputMode=numeric`，回显非法原文，非法时删掉该字段草稿。

### Added

- 帧错误分类 `frame-too-large` 与会话错误码 `SESSION_CLOSED`。没有新增工具或设置项。

## 0.1.1

### Fixed

- **默认 profile 下 crawl 作业必挂**：`dsh-jobs-local` 的 `servesOwner` 先看宿主平面有没有 controller，而 web profile 把宿主平面的 `tool-jobs` 显式 disabled。现在起作业时自挂 controller、`start()` 后立即 detach；只挂一瞬是刻意的，常驻会替全宿主打开那道闸门。
- **`planTools` 增加 jobs 维度**：后端不可用时不注册 `scrapling_crawl`，其余工具照常，并给出可读的跳过原因。
- **测试夹具不再让 `start` 无条件成功**：改为复刻真注册表的闸门，并用真 `LocalJobRegistry` 钉住「裸 start 被拒 / attach 后成功 / detach 后回到被拒」三态。
- **URL 准入闸门此前只被自身测试引用**：生产路径上无人构造策略对象，Host 侧 SSRF 防线实际未生效；现在 crawl/adapters 与输出环一并接上。

## 0.1.0

### Changed

- **跟上 Scrapling 0.5**：普通 Playwright 后端删除，浏览器抓取只剩 patchright；`scrapling_stealth_fetch` 并进 `scrapling_render`；`capture_xhr` 变成会话级记录，新增 `scrapling_session_network` 与 `scrapling_session_state_save` / `_load`；`extra_flags` 从「替换」改为「叠加」，本包一条都不发。
- **爬虫礼仪改成部署级 knobs**：robots、delay、并发、autothrottle、strategy、checkpoint 目录；默认值沿用上游。
- **宿主族依赖与 peer 升到 `0.2.1-rc.2`**，`engines.node >=22.12.0`；Python 门禁走八步链，解释器地板 3.14 同时落在两份 README、`pyproject.toml` 与 `bridge.py` 的运行时硬闸。
- **结果行改用宿主官方 `ToolCallViewProps`**：此前手抄的 props 把 `phase` 放在 `block` 里，结果侧字段永远不渲染；现在按顶层 `phase` 与 `result` 分支的 `block.meta` 投影。
- 补 `dsh-client-ui-tool` 与三枚 provider 作 devDependencies，修掉新检出里类型感知 lint 的 4 条 `no-unsafe-*`；清理注释里的文件行号引用。

### Fixed

- 发布链装的是 0.4 的 Scrapling 而本仓声明 `>=0.5,<0.6`，契约测试与 mypy 在 0.4 上红；发布链改为读本仓自己的声明。
- 结果行字段从不渲染的 props 形状错误。
- 官方类型自身未声明的宿主包在干净检出里使 `block` 退化成 error 类型，`tsc` 不红而类型感知 lint 红。

## 0.0.3

### Changed

- **契约测试改用上游判据**：新增 `py/tests/contract_probe.py`，把三套引擎换成记录器驱动 adapters 的真实路径，并用记录型字典问运行时「到底读了哪个键」；静态扫源码会把按表驱动的读法误判成没读。
- **写方法默认关**：新增部署开关 `allowWriteMethods`（默认 false，只走 `cordis.patch.yml`）。关着时参数面里没有 `method` / `body`，Host 与 Python 两侧各判一次。
- **系统提示的降级路按装配 scope 现问 `ctx.tools.get`**：没装浏览器或 Python 起不来时，模型不再读到一串点了就报 `UNKNOWN_TOOL` 的建议。

### Fixed

- 配代理时 stealth 的 53 条反检测启动参数被 `extra_flags` 整段冲掉；改为只加在 Playwright 侧，并用与上游 `block_webrtc` 等价的两条 flag。
- 会话路径上 `capture_xhr` / `block_ads` / `executable_path` / `cdp_url` / `locale` / `timezone_id` / `useragent` / `headless` 只在构造期生效；参数按层级分家，部署级设置从 `session.open` 发出。
- stealth 会话的 `block_webrtc` 强制开启取错代理结论，`proxyBypass=*` 时「直连却强制屏蔽」，用户明确填的 `false` 被静默盖掉；改为只认 `_make_session` 自己算出的代理。
- `requestTimeoutSeconds` / `maxUrlLength` 是发了没人读的死键（连同 `ToolSettings` 上没人读的字段删除）；22 个「Python 实现而 Host 从不发」的入参接成模型可见。
- 上游把工具参数编译成开放根对象，写意图被悄悄改成 GET；Host 侧就地抛 `WRITE_DISABLED`，Python 侧对手搓帧再拒一次。
- 非 dict/str 的 body（数组、数字）两个分支都不进，请求照发而对端收到空体；其余非 `None` 一律走 `json=`。
- 开放写方法后 `scrapling_fetch` 仍声明可并发；改为按本次调用的动词判，读并发、写串行。
- `crawlStarted` 在 `thread.start()` 之后才发，快蜘蛛可能先推 progress；改为先发帧再 start，start 抛错时摘掉占位并归还名额。
- 测试之间互相污染：并发名额那节的蜘蛛只清登记表不停 daemon 线程，进度事件写进后续用例的替身；改为按 id 逐只叫停并有界 join。

### Added

- 真站点端到端正例、真 `curl_cffi` 写方法往返、能力帧与注入面一致性门禁；两份构建与 Python 门禁全绿。

## 0.0.2

### Fixed

- **设置卡与结果行一起静默消失**：模块级 `inject` 只有 `["slots"]`，`apply` 却从同一个 ctx 读 `ctx.locale` 与 `ctx.configForms`；cordis 对没注入的名字抛错，异常落在 `ctx.effect` 体内只进 logger，后面的 `slots.register` 一次都没跑。现在清单交齐三枚服务，`apply` 平铺。
- **卡片值面改成可订阅的 FormSource**：原先每帧读一次快照、不订阅宿主变化；现在走 `useSyncExternalStore`。
- **测试替身按声明的清单放行服务**：未注入的名字抛与宿主逐字相同的错，不再无条件交出整套服务。

## 0.0.1

### Fixed

- 会话专属执行线程：browser/stealth 的 open/fetch/close 固定在属主线程，消除 Playwright sync 的 greenlet 跨线程崩溃与 close 静默失败导致的浏览器泄漏。
- WHATWG IPv4 精确解析替换字符形态正则：八进制/整数/十六进制写法照拦，真实域名不再误杀。
- `adaptive` 自愈选择器落地 `scrapling_extract`，指纹库按 `dataDir` 落盘；`cssSelector` 在 html/text 路径生效。
- sidecar 优雅关闭：dispose 发 shutdown 帧，bridge 关会话后退出。
- 会话注册表原子化、爬虫总时长上限与 `crawl.stop`、XHR 摘要脱敏、协议严格校验、截断标记合并、构建原子写；依赖升到 dsh 0.2.1-alpha.2，Python 侧 ruff/mypy 门禁。
- CI 的 Python 门禁在 hostedtoolcache 解释器上找不到 ruff；备检查工具一步把 `_env/.venv/bin` 写进 `GITHUB_PATH`。

## 0.0.1-rc.3

首个发布。把 Scrapling 的抓取能力封装成 11 个模型工具，由一个常驻 Python sidecar 驱动：静态抓取、CSS/XPath 抽取、选择器自愈、浏览器渲染与 capture_xhr、stealth 抓取、会话类工具与 Spider 爬虫、`scrapling_answer`；同时接管 `ctx.web` 的 fetch / search provider。

安全面：Host 侧 URL 闸门与 Python 侧 `guard.py` 两侧同解；`page_action`、`page_setup`、`selector_config`、`proxy`、`executablePath`、`cdpUrl` 绝不进入任何模型 schema。兼容 fake-IP / TUN 代理的 `allowSyntheticDns` 默认关；放宽只作用于解析结果，URL 里写死的 IP 字面量照旧严格判定。

产物压缩：源码注释不随包发布，`host.js` 与 tarball 明显缩小；新增门禁让压缩后的产物自己跑一遍注册计划。测试不允许 skipped；缺可选依赖报 `DEPENDENCY_MISSING` 并给出 `pip install "scrapling[rag]>=0.5,<0.6"`。
