// dsh-scrapling/src/settings-fields.ts —— 设置卡的字段表（纯数据，无 React）。
//
// 为什么单独一份表：设置卡要渲染的字段，就是 host.ts 里标了 `.volatile()` 的那些。
// 两边各写一份必然漂移 —— 表里多一个键，用户就在卡上看到一个改不动的输入框；表里少一个
// 键，用户就根本找不到那个开关。`test/settings-card.test.ts` 拿这张表与 host.ts 的
// schema 对账（键集合、默认值、枚举取值全等），所以漂移会让门禁变红，而不是等到用户
// 投诉。
//
// 文案是中英双份而不是只写中文：设置卡的语言跟着宿主走，写死中文等于让英文界面的用户
// 看不懂一半的标签。

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
  /** 中文标签。 */
  readonly label: Copy;
  /** 中文说明，一句话说清「改了会怎样」。 */
  readonly hint: Copy;
  /** schema 里的默认值；用户把它改回这个值时保存的是「清除覆盖」而不是「写入同值」。 */
  readonly fallback: string | number | boolean;
  /** 枚举字段的取值，取自 schema 的 union。 */
  readonly options?: readonly string[];
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
          zh: "留空用 PATH 上的 python3；装了 pyenv/conda 时填绝对路径。",
          en: "Leave empty to use python3 from PATH; give an absolute path under pyenv/conda.",
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
        key: "stealthEnabled",
        kind: "boolean",
        label: { zh: "scrapling_stealth_fetch", en: "scrapling_stealth_fetch" },
        hint: {
          zh: "patchright 反检测抓取，最吃资源，默认关。",
          en: "patchright anti-detection; heavy, off by default.",
        },
        fallback: false,
      },
      {
        key: "sessionEnabled",
        kind: "boolean",
        label: { zh: "scrapling_session_*", en: "scrapling_session_*" },
        hint: {
          zh: "跨请求复用 cookie 与浏览器实例。",
          en: "Reuse cookies and the browser across requests.",
        },
        fallback: true,
      },
      {
        key: "crawlEnabled",
        kind: "boolean",
        label: { zh: "scrapling_crawl", en: "scrapling_crawl" },
        hint: { zh: "后台 Spider 作业，默认关。", en: "Background spider jobs; off by default." },
        fallback: false,
      },
      {
        key: "answerEnabled",
        kind: "boolean",
        label: { zh: "scrapling_answer", en: "scrapling_answer" },
        hint: { zh: "抓完页面交给模型问答。", en: "Answer a question over a fetched page." },
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
          zh: "去掉导航、页脚、侧栏。开：更短更干净；关：抓页面控件类目标需要它。",
          en: "Drop nav/footer/sidebar. On for shorter output; off when you need page chrome.",
        },
        fallback: true,
      },
      {
        key: "fetchMaxOutputChars",
        kind: "number",
        label: { zh: "静态抓取正文上限", en: "fetch output cap" },
        hint: {
          zh: "字符数，超出部分截断并标注。",
          en: "Characters; the payload is clipped and flagged.",
        },
        fallback: 200_000,
      },
      {
        key: "extractMaxOutputChars",
        kind: "number",
        label: { zh: "抽取结果上限", en: "extract output cap" },
        hint: { zh: "字符数。", en: "Characters." },
        fallback: 200_000,
      },
      {
        key: "renderMaxOutputChars",
        kind: "number",
        label: { zh: "渲染结果上限", en: "render output cap" },
        hint: {
          zh: "字符数；会话类工具共用这一档。",
          en: "Characters; the session tools share this budget.",
        },
        fallback: 200_000,
      },
      {
        key: "xhrMaxOutputChars",
        kind: "number",
        label: { zh: "XHR 快照上限", en: "XHR snapshot cap" },
        hint: { zh: "字符数。", en: "Characters." },
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
      zh: "只在渲染 / 反检测 / XHR 三条路径上生效。",
      en: "Only affects the render / stealth / XHR paths.",
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
        key: "captureXhrPattern",
        kind: "text",
        label: { zh: "XHR 捕获正则", en: "XHR capture pattern" },
        hint: {
          zh: "只记录 URL 匹配这个正则的请求；.* 是全部。",
          en: "Only record requests whose URL matches; .* means all.",
        },
        fallback: ".*",
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
        label: { zh: "代理地址", en: "Proxy URL" },
        hint: {
          zh: "如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890，可带 user:pass@。留空=依次跟随环境变量与系统代理设置；填了就压过那两者。",
          en: "e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:7890, user:pass@ allowed. Empty follows the environment and then the OS proxy settings; setting it outranks both.",
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
          zh: '打开后还要在部署配置里写 fetchProvider: "scrapling"。',
          en: 'Also needs fetchProvider: "scrapling" in the deployment config.',
        },
        fallback: false,
      },
      {
        key: "provideWebSearch",
        kind: "boolean",
        label: { zh: "接管内置 web_search", en: "Provide the built-in web_search" },
        hint: {
          zh: "打开后还要配 searchEndpoint（SearXNG 兼容接口）与 searchProvider。",
          en: "Also needs a SearXNG-compatible searchEndpoint and searchProvider.",
        },
        fallback: false,
      },
    ],
  },
  {
    id: "answer",
    title: { zh: "页面问答", en: "Page Q&A" },
    note: {
      zh: "三项都留空就跟随当前会话用的模型，不额外烧一份额度。",
      en: "All blank follows the session's own model, costing no extra quota.",
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
