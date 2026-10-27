// dsh-scrapling/src/settings-fields.ts —— 设置卡的字段表（纯数据，无 React）。
//
// 为什么单独一份表：设置卡要渲染的字段，就是 host.ts 里标了 `.volatile()` 的那些。
// 两边各写一份必然漂移 —— 表里多一个键，用户就在卡上看到一个改不动的输入框；表里少一个
// 键，用户就根本找不到那个开关。`test/settings-card.test.ts` 拿这张表与 host.ts 的
// schema 对账（键集合、默认值、枚举取值全等），所以漂移会让门禁变红，而不是等到用户
// 投诉。
//
// 文案是中英双份而不是只写中文：设置卡的语言跟着宿主走，写死中文等于让英文界面的用户
// 看不懂一半的标签。这份双份文案同时是 locale 字典的**唯一来源** —— 下面的
// `localeDictionaries()` 把它摊成宿主 locale 服务要的扁平键，卡片只通过 `t()` 取字，
// 于是「字段表」与「真正显示出来的文案」不可能各走各的。

/** 一个字段的控件形态。 */
export type FieldKind = "boolean" | "text" | "number" | "enum";

/** 双语文案。 */
export interface Copy {
  /** 简体中文。 */
  readonly zh: string;
  /** 英文。 */
  readonly en: string;
}

/** 设置卡上一个字段的完整描述。 */
export interface FieldSpec {
  /** 对应 host.ts 的 Config 键名。 */
  readonly key: string;
  /** 控件形态。 */
  readonly kind: FieldKind;
  /** 双语标签。 */
  readonly label: Copy;
  /** 双语说明，一句话说清「改了会怎样」。 */
  readonly hint: Copy;
  /** schema 里的默认值；用户把它改回这个值时保存的是「清除覆盖」而不是「写入同值」。 */
  readonly fallback: string | number | boolean;
  /** 枚举字段的取值，取自 schema 的 union。 */
  readonly options?: readonly string[];
  /**
   * 值里可能带凭据，控件默认遮罩显示。
   *
   * 代理地址就是这种：``http://user:pass@host:port`` 是它文档里的合法写法，而明文摆在一个
   * 输入框里等于把密码摊在屏幕上 —— 截图、屏幕共享、录屏、浏览器扩展都能原样读走。
   * 遮罩只改**显示**：值本身仍是原串，编辑与保存语义一点不变。
   */
  readonly secret?: boolean;
}

/** 一组字段。 */
export interface GroupSpec {
  /** 组内稳定 id，仅用于 React key。 */
  readonly id: string;
  /** 组标题。 */
  readonly title: Copy;
  /** 组下的一句说明。 */
  readonly note: Copy;
  /** 字段。 */
  readonly fields: readonly FieldSpec[];
}

/** 设置卡对应的 Host 条目 id（cordis.patch.yml 里 `insert` 的 `id`），也是设置命名空间。 */
export const SETTINGS_ENTRY_ID = "scrapling";

/** 本包在插件管理器里的包名，也就是 `plugins.bundle.config` 这张 keyed slot 的键。 */
export const BUNDLE_PACKAGE_NAME = "@jayyuen66/dsh-scrapling";

/** 字段表。顺序即卡上的呈现顺序，按「先让用户认出东西、再调细节」排。 */
export const SETTINGS_GROUPS: readonly GroupSpec[] = [
  {
    id: "runtime",
    title: { zh: "运行环境", en: "Runtime" },
    note: {
      zh: "Python 与数据目录。装完 scrapling 之后这里一般不用动。",
      en: "Python and the data directory. Usually untouched once scrapling is installed.",
    },
    fields: [
      {
        key: "pythonBin",
        kind: "text",
        label: { zh: "Python 解释器", en: "Python interpreter" },
        hint: {
          zh: "留空：先用仓内 _env/.venv（装了才用），否则用 PATH 上的 python3（Windows 上是 python）；装了 pyenv/conda 时填绝对路径。",
          en: "Empty: use the repo's _env/.venv when it exists, else python3 from PATH (python on Windows); give an absolute path under pyenv/conda.",
        },
        fallback: "",
      },
      {
        key: "failFastOnMissingPython",
        kind: "boolean",
        label: { zh: "Python 缺失时拒绝加载", en: "Fail fast without Python" },
        hint: {
          zh: "开：Python 起不来就不注册任何工具并报错。关：只警告，工具全部消失。",
          en: "On: register nothing and error out. Off: warn and register nothing.",
        },
        fallback: true,
      },
      {
        key: "dataDir",
        kind: "text",
        label: { zh: "数据目录", en: "Data directory" },
        hint: {
          zh: "留空用 ~/.dsh-scrapling；选择器自愈的指纹库落在这里，需要可写。",
          en: "Leave empty for ~/.dsh-scrapling; the adaptive selector store lives here and must be writable.",
        },
        fallback: "",
      },
    ],
  },
  {
    id: "tools",
    title: { zh: "工具开关", en: "Tools" },
    note: {
      zh: "关掉的工具不会注册给模型，也不会在会话提示里占位置。",
      en: "A disabled tool is never registered with the model and leaves the system prompt too.",
    },
    fields: [
      {
        key: "fetchEnabled",
        kind: "boolean",
        label: { zh: "scrapling_fetch", en: "scrapling_fetch" },
        hint: { zh: "curl_cffi 静态抓取。", en: "Static fetching over curl_cffi." },
        fallback: true,
      },
      {
        key: "extractEnabled",
        kind: "boolean",
        label: { zh: "scrapling_extract", en: "scrapling_extract" },
        hint: {
          zh: "对给定 HTML 做选择器抽取，不发请求。",
          en: "Extract from given HTML without any request.",
        },
        fallback: true,
      },
      {
        key: "locateEnabled",
        kind: "boolean",
        label: { zh: "scrapling_locate", en: "scrapling_locate" },
        hint: {
          zh: "按文本、正则或相似元素定位，返回可复用的选择器。",
          en: "Locate by text, regex, or similar elements and return reusable selectors.",
        },
        fallback: true,
      },
      {
        key: "linksEnabled",
        kind: "boolean",
        label: { zh: "scrapling_links", en: "scrapling_links" },
        hint: {
          zh: "列出页面链接与下一页候选。",
          en: "List page links and next-page candidates.",
        },
        fallback: true,
      },
      {
        key: "renderEnabled",
        kind: "boolean",
        label: { zh: "scrapling_render", en: "scrapling_render" },
        hint: { zh: "Playwright 渲染，能读 SPA。", en: "Playwright rendering; reads SPAs." },
        fallback: true,
      },
      {
        key: "captureXhrEnabled",
        kind: "boolean",
        label: { zh: "scrapling_capture_xhr", en: "scrapling_capture_xhr" },
        hint: {
          zh: "只回传 XHR 的 URL/状态/字节数；站点数据在接口里时用它找那个接口。",
          en: "Returns XHR url/status/bytes only — use it to locate the JSON endpoint.",
        },
        fallback: true,
      },
      {
        key: "networkEnabled",
        kind: "boolean",
        label: { zh: "scrapling_session_network", en: "scrapling_session_network" },
        hint: {
          zh: "读已开会话攒下的网络历史；会话需先用 recordNetwork 打开记录。",
          en: "Read a session's recorded network history; the session must have recordNetwork on.",
        },
        fallback: true,
      },
      {
        key: "sessionEnabled",
        kind: "boolean",
        label: { zh: "scrapling_session_*", en: "scrapling_session_*" },
        hint: {
          zh: "跨请求复用 cookie 与浏览器实例，只管 open / fetch / list / close 这一组；network 与 state_* 各自有独立开关。",
          en: "Reuse cookies and the browser across requests; covers open / fetch / list / close only. The network and state_* groups have their own switches.",
        },
        fallback: true,
      },
      {
        key: "sessionStateEnabled",
        kind: "boolean",
        label: { zh: "scrapling_session_state_*", en: "scrapling_session_state_*" },
        hint: {
          zh: "存/取浏览器登录态；需部署侧配好 sessionStateDir。",
          en: "Save/load browser login state; needs a deployment-side sessionStateDir.",
        },
        fallback: true,
      },
      {
        key: "crawlEnabled",
        kind: "boolean",
        label: { zh: "scrapling_crawl", en: "scrapling_crawl" },
        hint: {
          zh: "后台 Spider 作业，只守起始域；需 profile 带作业后端。",
          en: "Background spider jobs confined to the start domain; needs a jobs backend.",
        },
        fallback: true,
      },
      {
        key: "answerEnabled",
        kind: "boolean",
        label: { zh: "scrapling_answer", en: "scrapling_answer" },
        hint: { zh: "抓完页面交给模型问答。", en: "Answer a question over a fetched page." },
        fallback: true,
      },
      {
        key: "sessionReadEnabled",
        kind: "boolean",
        label: { zh: "scrapling_session_read", en: "scrapling_session_read" },
        hint: {
          zh: "读浏览器会话当前页，不再发请求。",
          en: "Read the current page of a browser session without another request.",
        },
        fallback: true,
      },
      {
        key: "sessionActionsEnabled",
        kind: "boolean",
        label: { zh: "scrapling_session_act", en: "scrapling_session_act" },
        hint: {
          zh: "结构化浏览器动作；还要部署侧打开 allowBrowserActions。",
          en: "Structured browser actions; the deployment must also set allowBrowserActions.",
        },
        fallback: true,
      },
      {
        key: "downloadEnabled",
        kind: "boolean",
        label: { zh: "scrapling_download", en: "scrapling_download" },
        hint: {
          zh: "下载文件到插件目录；还要部署侧打开 allowFileDownloads。",
          en: "Download files into the plugin directory; the deployment must also set allowFileDownloads.",
        },
        fallback: true,
      },
      {
        key: "screenshotEnabled",
        kind: "boolean",
        label: { zh: "scrapling_screenshot", en: "scrapling_screenshot" },
        hint: {
          zh: "页面截图；没有 attachment 服务时不注册。",
          en: "Page screenshots; not registered when no attachment service is mounted.",
        },
        fallback: true,
      },
    ],
  },
  {
    id: "output",
    title: { zh: "抽取与输出", en: "Extraction & output" },
    note: {
      zh: "这几个数字直接决定模型每轮看到多少 token。",
      en: "These numbers are the per-call token bill the model pays.",
    },
    fields: [
      {
        key: "extractionType",
        kind: "enum",
        label: { zh: "默认抽取形态", en: "Default extraction" },
        hint: {
          zh: "markdown 最省 token；html 保留标签；text 只留文字。",
          en: "markdown is cheapest; html keeps tags; text keeps words only.",
        },
        fallback: "markdown",
        options: ["markdown", "html", "text"],
      },
      {
        key: "mainContentOnly",
        kind: "boolean",
        label: { zh: "只保留正文", en: "Main content only" },
        hint: {
          zh: "去掉导航、页脚、侧栏。开：更短更干净；关：要连同导航、按钮这类页面控件一起抓时用。",
          en: "Drop nav/footer/sidebar. On for shorter output; off when you need page chrome.",
        },
        fallback: true,
      },
      {
        key: "fetchMaxOutputChars",
        kind: "number",
        label: { zh: "静态抓取正文上限", en: "fetch output cap" },
        hint: {
          zh: "预算按 UTF-8 字节计，超出部分截断并标注；同一数值也作为 sidecar 的字符上限，最终取更紧的一档。",
          en: "UTF-8 bytes; the payload is clipped and flagged. The same value also caps sidecar characters, so the tighter limit wins.",
        },
        fallback: 200_000,
      },
      {
        key: "extractMaxOutputChars",
        kind: "number",
        label: { zh: "抽取结果上限", en: "extract output cap" },
        hint: {
          zh: "预算按 UTF-8 字节计；同一数值也作为 sidecar 的字符上限。",
          en: "UTF-8 bytes; the same value also caps sidecar characters.",
        },
        fallback: 200_000,
      },
      {
        key: "renderMaxOutputChars",
        kind: "number",
        label: { zh: "渲染结果上限", en: "render output cap" },
        hint: {
          zh: "预算按 UTF-8 字节计；会话类工具共用这一档，同一数值也作为 sidecar 的字符上限。",
          en: "UTF-8 bytes; the session tools share this budget, and the same value also caps sidecar characters.",
        },
        fallback: 200_000,
      },
      {
        key: "xhrMaxOutputChars",
        kind: "number",
        label: { zh: "XHR 快照上限", en: "XHR snapshot cap" },
        hint: {
          zh: "预算按 UTF-8 字节计；同一数值也作为 sidecar 的字符上限。",
          en: "UTF-8 bytes; the same value also caps sidecar characters.",
        },
        fallback: 120_000,
      },
      {
        key: "crawlMaxItems",
        kind: "number",
        label: { zh: "爬虫默认页数上限", en: "Crawl page cap" },
        hint: {
          zh: "爬虫工具每次调用的默认上限，模型可按次调小。",
          en: "Default per-call page cap; the model may lower it per call.",
        },
        fallback: 1000,
      },
      {
        key: "stripInlineImages",
        kind: "boolean",
        label: { zh: "剥掉内嵌 base64 图片", en: "Strip inline base64 images" },
        hint: {
          zh: "默认开。内嵌 data: URI 图片对模型是纯 token 噪音——模型从 base64 里读不出任何图形信息，只留 alt 文本；代码围栏内的原样保留。没有内联图的页面不受影响。要从 base64 里取配色或指纹这类原始数据时才关掉。",
          en: "On by default. Inline data: URI images are pure token noise - the model cannot read a shape out of base64, so only the alt text is kept; ones inside code fences are left alone. Pages without inline images are unaffected. Turn it off to read the raw base64 (colours, fingerprints).",
        },
        fallback: true,
      },
    ],
  },
  {
    id: "browser",
    title: { zh: "浏览器行为", en: "Browser behaviour" },
    note: {
      zh: "只在渲染 / XHR 两条路径上生效。",
      en: "Only affects the render / XHR paths.",
    },
    fields: [
      {
        key: "headless",
        kind: "boolean",
        label: { zh: "无头运行", en: "Headless" },
        hint: {
          zh: "关掉会弹出浏览器窗口，反检测站点上成功率更高。",
          en: "Off shows a window and beats more anti-bot checks.",
        },
        fallback: true,
      },
      {
        key: "networkIdle",
        kind: "boolean",
        label: { zh: "等网络静默", en: "Wait for network idle" },
        hint: {
          zh: "等到没有在途请求再返回。更准，但慢；埋了长连接的站点可能一直等不到。",
          en: "Wait until no requests are in flight. Slower, and pages with long-lived sockets never settle.",
        },
        fallback: false,
      },
      {
        key: "blockAds",
        kind: "boolean",
        label: { zh: "拦截广告与追踪", en: "Block ads and trackers" },
        hint: {
          zh: "约 3500 个已知广告域。省流量，偶尔误伤。",
          en: "~3,500 known ad domains. Saves bandwidth, occasionally over-blocks.",
        },
        fallback: true,
      },
      {
        key: "pierceShadow",
        kind: "boolean",
        label: { zh: "穿透 Shadow DOM", en: "Pierce Shadow DOM" },
        hint: {
          zh: "把 open shadow root 里的内容并进正文，默认关；页面把正文封进 shadow DOM 时才打开。",
          en: "Merge open shadow root content into the body; off by default. On when a page hides its content in shadow DOM.",
        },
        fallback: false,
      },
      {
        key: "waitSelectorState",
        kind: "enum",
        label: { zh: "等待选择器的状态", en: "Wait selector state" },
        hint: {
          zh: "配 waitSelector 用；attached 最宽松。",
          en: "Used with waitSelector; attached is the loosest.",
        },
        fallback: "attached",
        options: ["attached", "detached", "hidden", "visible"],
      },
    ],
  },
  {
    id: "timeouts",
    title: { zh: "超时与回收", en: "Timeouts & teardown" },
    note: {
      zh: "抓取慢若不在这几项里，先看页面上要等的东西。",
      en: "If a fetch is slow for a reason other than these, look at what the page waits for.",
    },
    fields: [
      {
        key: "fetchTimeoutMs",
        kind: "number",
        label: { zh: "单次抓取超时（毫秒）", en: "Per-fetch timeout (ms)" },
        hint: {
          zh: "同时是工具的超时预算与 Python 侧的请求上限。",
          en: "Also the tool budget and the Python-side request cap.",
        },
        fallback: 120_000,
      },
      {
        key: "sidecarHandshakeTimeoutMs",
        kind: "number",
        label: { zh: "sidecar 握手超时（毫秒）", en: "Handshake timeout (ms)" },
        hint: {
          zh: "冷启动要拉起一个 Python 进程并导入 Scrapling。",
          en: "Cold start spawns a Python process and imports Scrapling.",
        },
        fallback: 30_000,
      },
      {
        key: "sidecarGraceMs",
        kind: "number",
        label: { zh: "退出宽限（毫秒）", en: "Shutdown grace (ms)" },
        hint: {
          zh: "插件卸载后等 Python 收尾的时间。",
          en: "How long Python gets to finish after the plugin unloads.",
        },
        fallback: 5000,
      },
    ],
  },
  {
    id: "network",
    title: { zh: "网络与安全", en: "Network & safety" },
    note: {
      zh: "通常什么都不用填：TUN 模式的代理由系统接管，环境里的 HTTPS_PROXY 与 macOS / Windows 的「系统代理」都会被自动接上。",
      en: "Usually nothing to fill: a TUN-mode proxy is taken from the system, and both HTTPS_PROXY in the environment and the macOS / Windows system proxy are picked up automatically.",
    },
    fields: [
      {
        key: "proxyUrl",
        kind: "text",
        secret: true,
        label: { zh: "代理地址", en: "Proxy URL" },
        hint: {
          zh: "如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890，可带 user:pass@。留空=依次跟随环境变量与系统代理设置；填了就压过那两者。值按密码遮罩显示，点「显示」可查看。",
          en: "e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:7890, user:pass@ allowed. Empty follows the environment and then the OS proxy settings; setting it outranks both. Masked like a password; press Show to reveal it.",
        },
        fallback: "",
      },
      {
        key: "proxyBypass",
        kind: "text",
        label: { zh: "代理绕过清单", en: "Proxy bypass" },
        hint: {
          zh: "逗号分隔的主机名，命中即直连；内网站点要填。整台机器直连填 *。浏览器会话不逐条生效（它的代理在开场时定死）。",
          en: "Comma-separated hostnames that connect directly; list your internal sites. Use * for the whole machine. Not applied per URL inside a browser session (its proxy is fixed at open).",
        },
        fallback: "",
      },
      {
        key: "syntheticDnsRanges",
        kind: "text",
        label: { zh: "合成 DNS 段（兜底）", en: "Synthetic DNS ranges (fallback)" },
        hint: {
          zh: "平时留空：fake-ip 型代理由系统自动认出，这里只用于识别失灵时。列进来的段等于放弃对它们的 SSRF 防护。",
          en: "Leave empty: fake-ip resolvers are detected automatically. Only for detection failures. Listed ranges give up SSRF protection.",
        },
        fallback: "",
      },
      {
        key: "allowedHosts",
        kind: "text",
        label: { zh: "额外放行的内网主机", en: "Extra allowed hosts" },
        hint: {
          zh: "逗号分隔。指到内网等于主动放弃对那些目标的 SSRF 防护，只在真要抓自建站点时填。",
          en: "Comma-separated. Pointing these at internal hosts gives up SSRF protection for them — only for self-hosted targets.",
        },
        fallback: "",
      },
      {
        key: "nat64Prefixes",
        kind: "text",
        label: { zh: "额外 NAT64 前缀", en: "Extra NAT64 prefixes" },
        hint: {
          zh: "用运营商自建 NAT64 的网络才需要，形如 2001:4860:4860::/96。",
          en: "Only for carrier-grade NAT64 networks, e.g. 2001:4860:4860::/96.",
        },
        fallback: "",
      },
      {
        key: "provideWebFetch",
        kind: "boolean",
        label: { zh: "接管内置 web_fetch", en: "Provide the built-in web_fetch" },
        hint: {
          zh: '默认开；部署配置里仍要写 fetchProvider: "scrapling"，否则 base bundle 那条 fetchProvider: http 仍然赢。',
          en: 'On by default; the deployment config still needs fetchProvider: "scrapling", otherwise the base bundle\'s fetchProvider: http wins.',
        },
        fallback: true,
      },
      {
        key: "provideWebSearch",
        kind: "boolean",
        label: { zh: "接管内置 web_search", en: "Provide the built-in web_search" },
        hint: {
          zh: '默认开；部署配置里仍要写 searchProvider: "scrapling"，否则不会接管。',
          en: 'On by default; the deployment config still needs searchProvider: "scrapling", otherwise it does not take over.',
        },
        fallback: true,
      },
      {
        key: "searchBackend",
        kind: "enum",
        options: ["auto", "tavily", "bing", "brave", "serper", "duckduckgo", "searxng"],
        label: { zh: "搜索发现后端", en: "Search discovery backend" },
        hint: {
          zh: "auto 有 Tavily key 走 Tavily、配了 SearXNG 走 SearXNG；两者都没有时，只有打开「允许公共搜索回退」才走公共引擎（DuckDuckGo → Bing）。只有 Tavily 与 Bing 打过真实端点；其余四条按文档形状实现，真实 key 未验。",
          en: 'auto uses Tavily when a key is set, SearXNG when an instance is configured; with neither, only "Allow public search fallback" routes to public engines (DuckDuckGo → Bing). Only Tavily and Bing have been run against the real endpoints; the other four follow their documented shapes and are unverified with real keys.',
        },
        fallback: "auto",
      },
      {
        key: "searchPublicFallback",
        kind: "boolean",
        label: { zh: "允许公共搜索回退", en: "Allow public search fallback" },
        hint: {
          zh: "默认关。打开后 auto 后端在没配 key、也没配 SearXNG 时会回落到 DuckDuckGo/Bing —— 查询词会发给公共引擎。",
          en: "Off by default. When enabled, the auto backend falls back to DuckDuckGo/Bing if no API key or SearXNG is configured — queries are then sent to public engines.",
        },
        fallback: false,
      },
      {
        key: "tavilyApiKey",
        kind: "text",
        secret: true,
        label: { zh: "Tavily API key", en: "Tavily API key" },
        hint: {
          zh: "Tavily 后端必填；没配时 search 报 SEARCH_AUTH，不会静默换后端。",
          en: "Required by the Tavily backend; without it search reports SEARCH_AUTH instead of silently switching backends.",
        },
        fallback: "",
      },
      {
        key: "braveApiKey",
        kind: "text",
        secret: true,
        label: { zh: "Brave Search API key", en: "Brave Search API key" },
        hint: {
          zh: "Brave 后端必填；没配时 search 报 SEARCH_AUTH。",
          en: "Required by the Brave backend; without it search reports SEARCH_AUTH.",
        },
        fallback: "",
      },
      {
        key: "serperApiKey",
        kind: "text",
        secret: true,
        label: { zh: "Serper API key", en: "Serper API key" },
        hint: {
          zh: "Serper 后端必填；没配时 search 报 SEARCH_AUTH。",
          en: "Required by the Serper backend; without it search reports SEARCH_AUTH.",
        },
        fallback: "",
      },
      {
        key: "searxngEndpoint",
        kind: "text",
        label: { zh: "SearXNG 实例地址", en: "SearXNG instance URL" },
        hint: {
          zh: "SearXNG 后端必填，例如 https://searx.example.com；会拼上 /search?format=json。留空表示这条后端不可用。",
          en: "Required by the SearXNG backend, e.g. https://searx.example.com; /search?format=json is appended. Empty means the backend is unusable.",
        },
        fallback: "",
      },
    ],
  },
  {
    id: "answer",
    title: { zh: "页面问答", en: "Page Q&A" },
    note: {
      zh: "provider 与 model 留空跟随当前会话用的模型，不额外烧一份额度；token 上限留空用默认值。",
      en: "provider and model blank follow the session's own model, costing no extra quota; the token cap falls back to its default.",
    },
    fields: [
      {
        key: "answerProvider",
        kind: "text",
        label: { zh: "回答用 provider", en: "Answer provider" },
        hint: { zh: "留空跟随会话模型。", en: "Blank follows the session model." },
        fallback: "",
      },
      {
        key: "answerModel",
        kind: "text",
        label: { zh: "回答用模型 id", en: "Answer model id" },
        hint: { zh: "与 provider 一起生效。", en: "Takes effect together with the provider." },
        fallback: "",
      },
      {
        key: "answerMaxTokens",
        kind: "number",
        label: { zh: "单次回答 token 上限", en: "Answer token cap" },
        hint: { zh: "一次回答的输出预算。", en: "Output budget per answer." },
        fallback: 2000,
      },
    ],
  },
];

/** 展平后的字段表，顺序与卡上一致。 */
export const SETTINGS_FIELDS: readonly FieldSpec[] = SETTINGS_GROUPS.flatMap(
  (group) => group.fields,
);

/** 字段键的清单，供与 schema 对账。 */
export const SETTINGS_FIELD_KEYS: readonly string[] = SETTINGS_FIELDS.map((field) => field.key);

/** 本包 Client 半注册的字典命名空间。 */
export const LOCALE_NS = "dshScrapling";

/** 宿主自带的两种语言。字典按语言逐份注册，键集必须完全一致。 */
type BuiltInLang = "zh" | "en";

/** 设置卡自身的文案：按钮、状态行与读屏提示。字段标签不在这里 —— 它们由字段表摊出来。 */
const CHROME: Readonly<Record<BuiltInLang, Readonly<Record<string, string>>>> = {
  zh: {
    save: "保存",
    saving: "保存中…",
    undo: "撤销",
    reveal: "显示",
    conceal: "隐藏",
    statusLoading: "正在读取设置…",
    statusReadonly: "这个连接以只读方式运行，设置改不了。",
    statusClean: "没有未保存的改动",
    statusChanged: "已改动 {count} 项，未保存",
    statusInvalid: "有 {count} 项填的不是合法数字，改好后才能保存",
    rejected: "保存被宿主拒绝了，设置未改动",
    stale: "设置已经被别处改过，请重新打开这张卡再保存",
    failed: "保存失败：{reason}",
    runtimeTitle: "运行环境",
    runtimeHint: "能力包装在数据目录的 runtime/ 下；安装是后台作业，关掉这张卡也会继续。",
    runtimeUnavailable: "宿主没有提供远程读面；请在终端运行：",
    runtimeJobsMissing: "这个 profile 没有作业后端；请在终端运行：",
    runtimeInstall: "安装",
    runtimeRepair: "修复",
    runtimeCancel: "取消",
    runtimePython: "解释器",
    runtimeDataDir: "数据目录",
    runtimeJobRunning: "正在安装 {pack}…",
    runtimeJobEnded: "安装结束：{status}",
    runtimeError: "安装失败：{reason}",
    "runtime.state.ready": "就绪",
    "runtime.state.missing": "未安装",
    "runtime.state.corrupt": "文件缺失",
    "runtime.state.installing": "安装中",
    "runtime.state.blocked": "暂不提供",
    "runtime.pack.core": "核心（Python + Scrapling）",
    "runtime.pack.browser": "完整 Chromium",
    "runtime.pack.search": "搜索发现",
    "runtime.pack.media": "截图与下载",
    "runtime.pack.adaptive-redis": "自适应存储（Redis）",
    "runtime.pack.mcp": "MCP（未验证）",
  },
  en: {
    save: "Save",
    saving: "Saving…",
    undo: "Undo",
    reveal: "Show",
    conceal: "Hide",
    statusLoading: "Reading settings…",
    statusReadonly: "This connection runs read-only; settings cannot be changed here.",
    statusClean: "No unsaved changes",
    statusChanged: "{count} change(s) not saved yet",
    statusInvalid: "{count} field(s) are not valid numbers; fix them to save",
    rejected: "The host refused the save; nothing changed",
    stale: "Settings changed elsewhere; reopen this page before saving",
    failed: "Save failed: {reason}",
    runtimeTitle: "Runtime",
    runtimeHint:
      "Capability packs live under runtime/ in the data directory; installs run as background jobs and keep going when this page closes.",
    runtimeUnavailable: "The host offers no remote surface; run this in a terminal:",
    runtimeJobsMissing: "This profile has no jobs backend; run this in a terminal:",
    runtimeInstall: "Install",
    runtimeRepair: "Repair",
    runtimeCancel: "Cancel",
    runtimePython: "Interpreter",
    runtimeDataDir: "Data directory",
    runtimeJobRunning: "Installing {pack}…",
    runtimeJobEnded: "Install finished: {status}",
    runtimeError: "Install failed: {reason}",
    "runtime.state.ready": "Ready",
    "runtime.state.missing": "Not installed",
    "runtime.state.corrupt": "Files missing",
    "runtime.state.installing": "Installing",
    "runtime.state.blocked": "Unavailable",
    "runtime.pack.core": "Core (Python + Scrapling)",
    "runtime.pack.browser": "Full Chromium",
    "runtime.pack.search": "Search discovery",
    "runtime.pack.media": "Screenshots & downloads",
    "runtime.pack.adaptive-redis": "Adaptive storage (Redis)",
    "runtime.pack.mcp": "MCP (unverified)",
  },
};

/** 结果行那一行的文案：字段名与那一个「看详情」的入口。 */
const ROW_CHROME: Readonly<Record<BuiltInLang, Readonly<Record<string, string>>>> = {
  zh: {
    "row.url": "URL",
    "row.http": "HTTP",
    "row.body": "正文",
    "row.matched": "匹配",
    "row.sessionCount": "会话数",
    "row.session": "会话",
    "row.name": "名称",
    "row.type": "类型",
    "row.start": "起始",
    "row.pageCap": "上限",
    "row.job": "作业",
    "row.inspect": "在轨迹里查看",
    "row.truncated": "已截断",
  },
  en: {
    "row.url": "URL",
    "row.http": "HTTP",
    "row.body": "Body",
    "row.matched": "Matched",
    "row.sessionCount": "Sessions",
    "row.session": "Session",
    "row.name": "Name",
    "row.type": "Type",
    "row.start": "Start",
    "row.pageCap": "Page cap",
    "row.job": "Job",
    "row.inspect": "Inspect this call",
    "row.truncated": "Truncated",
  },
};

/**
 * 把字段表与卡面文案摊成宿主 locale 服务要的字典。
 *
 * 键的形状：字段是 `field.<key>.label` / `field.<key>.hint`，分组是
 * `group.<id>.title` / `group.<id>.note`，卡面文案直接用自己的键。键从字段表推出来，
 * 所以往表里加一个字段就自动多出两条词典项 —— 不需要在这里再抄一遍。
 *
 * @returns 语言 → 键值表；两份的键集相等
 */
export function localeDictionaries(): Record<BuiltInLang, Record<string, string>> {
  const result: Record<BuiltInLang, Record<string, string>> = {
    zh: { ...CHROME.zh, ...ROW_CHROME.zh },
    en: { ...CHROME.en, ...ROW_CHROME.en },
  };
  for (const group of SETTINGS_GROUPS) {
    result.zh[`group.${group.id}.title`] = group.title.zh;
    result.zh[`group.${group.id}.note`] = group.note.zh;
    result.en[`group.${group.id}.title`] = group.title.en;
    result.en[`group.${group.id}.note`] = group.note.en;
    for (const field of group.fields) {
      result.zh[`field.${field.key}.label`] = field.label.zh;
      result.zh[`field.${field.key}.hint`] = field.hint.zh;
      result.en[`field.${field.key}.label`] = field.label.en;
      result.en[`field.${field.key}.hint`] = field.hint.en;
    }
  }
  return result;
}
