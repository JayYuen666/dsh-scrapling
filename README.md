<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-scrapling@main/icon.svg" width="96" height="96" alt="dsh-scrapling logo" />
</p>

<h1 align="center">dsh-scrapling</h1>

<p align="center"><em>Scrapling web scraping for dsh: JavaScript rendering, structured extraction and a background crawler, behind one resident Python sidecar.</em></p>

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
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

**A web-scraping extension for [dsh](https://github.com/deepseek-ai/deepseek-harness): [Scrapling](https://github.com/D4Vinci/Scrapling) as agent tools — JavaScript rendering, CSS/XPath extraction with self-healing selectors, sessions with login state, a background crawler and page Q&A. You supply the interpreter and the browser engine; everything runs in one resident Python process.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [The tools](#the-tools)
- [Replacing the built-in fetch and search](#replacing-the-builtin-fetch-and-search)
- [Settings](#settings)
- [Proxies](#proxies)
- [Security](#security)
- [Data and privacy](#data-and-privacy)
- [Known boundaries](#known-boundaries)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

dsh ships `web_fetch` and `web_search`. The built-in `web_fetch` is deliberately honest and minimal: a plain HTTP(S) GET with no JavaScript execution and an honest User-Agent. That is a good default — and it means a single-page application yields only its loading shell, and there is no way to ask for "just the product table". Measured on a page whose content exists only after JavaScript runs:

| Pipeline | Text obtained |
|---|---|
| raw HTML to text (no JS) | `SPA Shell / LOADING_PLACEHOLDER` |
| `Fetcher` (curl_cffi, still no JS) | `SPA Shell / LOADING_PLACEHOLDER` |
| browser render (patchright) | full rendered DOM, Markdown table, structured rows |

This package adds what the built-ins structurally cannot do:

- **Browser rendering** — JavaScript execution via patchright.
- **Structured extraction** — CSS/XPath selection returning data, not a wall of Markdown.
- **Self-healing selectors** — Scrapling's `adaptive` mode relocates an element after the site's markup changes; a selector that returns `None` after a class rename returns the relocated element with `adaptive` on.

Everything runs against **one long-lived Python process**. That is not an optimisation: Scrapling's session classes keep cookies, the browser engines keep a page pool, and `adaptive` keeps a SQLite fingerprint database — a process per call would throw all of that away. Tools are registered **conditionally**: the plugin probes what the environment can actually do at startup and registers only what will work, so the model never burns a turn on a tool that was guaranteed to fail. Every tool renders its result row through the official tool-call view slot. `scrapling_answer` is the only tool that spends **another model call** — see [The tools](#the-tools).

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-scrapling
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-scrapling`. The package is on the public npm registry, so installation needs no credentials and no scoped-registry line.

- **Requires Node.js `>= 22.12`.** This is an ESM-only package; that Node floor is what makes `require()` of an ESM entry work at all, which is why `engines.node` is declared.
- **Requires host `dsh` at the `0.2.1-rc.3` line.** The requirement the host actually reads is `engines.dsh` (`^0.2.1-rc.3`), and it decides alone; a host on a later line is refused and needs the explicit risk grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`.
- **Requires Python 3.14+ with Scrapling installed** — in the repository's `_env/.venv`, or reachable from `PATH`, or named by `pythonBin`. In an installed package the `_env/.venv` leg does not exist, so the interpreter is the `python3` on your `PATH`; whichever one is chosen is logged at load time, and a missing Scrapling reports an error carrying the install line to copy.

```sh
pip install "scrapling[rag]>=0.5,<0.6"
python -m patchright install chromium
```

- **Why `rag` and not `fetchers`:** `rag` is `fetchers` plus `markdownify`, and the default `extractionType` is `markdown` — with plain `fetchers` the first fetch raises `ModuleNotFoundError` at the Markdown conversion.
- **Version range:** developed and verified against Scrapling **0.5**, through interfaces that are not stable API surface (`Selector`, `Spider`, `SessionManager`, and the converter's noise-stripping helpers). The upper bound is pinned below `0.6`; outside the range the guards still run, but the anti-injection cleaning and the crawl path may not behave as documented. In 0.5 the browser backend is patchright only (the old standalone stealth fetch is gone; its anti-detection arguments live on `scrapling_render`), `capture_xhr` became session-level recording (hence `scrapling_session_network`), and `extra_flags` became additive — this package sends none, and WebRTC leak protection is carried by the `blockWebrtc` switch.
- **Browser engines are entirely your responsibility.** The plugin downloads nothing. Without a browser it simply does not register the browser-dependent tools, so the model never wastes a turn calling them.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts` enforces it). Consumer profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package there becomes a real second copy whose module-level state splits from the running host's — every native tool call then throws while build and tests stay green. The host packages the artifact imports for value are required peers and stay externalized; the gate imports the built artifact and asserts that no host package body is inlined.
- **The artifact is ESM-only and never committed** — `prepack` rebuilds it, so what ships is always what the current source produces.

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names the sources use, and the host then reports `N entries did not activate` together with `does not provide an export named ...` at boot - the package installs fine and never loads, and no per-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **The layer is mounted.** `dsh --profile web --dump-config` shows this package's layer line.
   - That command is the only accepted "it is in the layer stack" signal, and it is **not read-only** — it rewrites the profile's root assembly file. Read layer lines from stdout **and** check stderr separately: an unmatched patch target appears only on stderr, so the exit code alone proves nothing. Accept both `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The startup log names the interpreter and the plan.** One line prints the probed capabilities and how many of the tools registered; the chosen interpreter path is logged at load. An interpreter that starts but lacks Scrapling is named in the log together with the pip line to copy.
3. **The settings card renders.** The plugin detail page carries the **scrapling** card with every user-editable field grouped by purpose; toggling a value enables Save, and the write returns 200.
4. **A tool round-trip.** Ask the model to fetch a JavaScript-heavy page: the result row renders in the chat through the official tool-call view. On a machine without a browser the render / capture_xhr tools are absent from the model's tool list and their prompt guidance is gone too — that absence is the conditional registration working, not a failure.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **It is not a search engine.** Scrapling only sets a Google referer header for its `google_search` option; discovery needs a deployment-level `searchEndpoint` (see [Settings](#settings)). Without one the search provider stays unavailable and the built-in `web_search` keeps its behaviour.
- **It downloads nothing.** The Python interpreter and the browser engine are supplied by you; missing pieces remove the matching tools instead of being fetched.
- **It opens no HTTP route of its own.** The settings card is a host config form; there is no `/api` surface from this package.
- **It adds no CLI subcommand.**

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- `dsh.bundle.patch` points at `cordis.patch.yml`, whose single registration line is `- id: scrapling` with the **bare package name** — the host scans `dsh.client` on bare package-name entries only.
- The client half registers two surfaces: the settings card (on the `plugins.bundle.config` slot, keyed by the bundle package name — the host dispatches `entryKey: pkg.name`, so the card renders on this package's detail page) and one result row per tool on `tool.call.toolview`, drawn with the official tool-call view props.
- The settings namespace is the entry id `scrapling`; precedence is settings-card value > registration-line `config:` > schema default. Setting a field back to its default saves a **clear-override**, not a write of the same value, so a later default change still reaches you.
- Gate policy and the sidecar environment are snapshotted once when the plugin is applied — **settings changes take effect on the next start**.
- Disabling a tool also removes its system-prompt guidance: the guidance is re-read at each prompt assembly against the tools that scope can actually see, so a machine without a browser loses the render / capture_xhr lines and a sidecar that never came up loses all of them. The section is placed next to the built-in `web_fetch` guidance.
- `scrapling_crawl` registers its own job kind, so `job_list` labels its jobs as crawls rather than shell jobs.

## <img src="https://api.iconify.design/lucide/globe.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The tools

Thirteen tools, each behind one settings switch, all exercised by the test suite:

| Tool | Backend | Needs a browser | Concurrency |
|---|---|---|---|
| `scrapling_fetch` | `Fetcher` (curl_cffi) | no | concurrent; write verbs are serialised once `allowWriteMethods` is on |
| `scrapling_extract` | `Selector` + CSS/XPath + `adaptive` | no | concurrent |
| `scrapling_render` | `StealthySession` (patchright) | yes | serialised; the anti-detection switches (`solveCloudflare` / `hideCanvas` / `blockWebrtc`) live here |
| `scrapling_capture_xhr` | one throwaway session, page-level recording | yes | serialised |
| `scrapling_session_open` / `scrapling_session_fetch` / `scrapling_session_network` / `scrapling_session_state_save` / `scrapling_session_state_load` / `scrapling_session_list` / `scrapling_session_close` | Scrapling session classes | browser sessions only | serialised |
| `scrapling_crawl` | Scrapling Spider framework, runs as a job | no | serialised |
| `scrapling_answer` | any fetch path plus `ctx.llm` | with `render: true` | serialised |

- **Quotas.** At most 8 open sessions (3 of them browser sessions, each a real Chromium process), 2 crawls in flight, per-page bodies clipped by `*MaxOutputChars`, 8 MB per protocol frame, 16 queued frames. A ceiling answers with a specific code (`SESSION_LIMIT` / `CRAWL_BUSY` / `BAD_FRAME`) the model can back off from.
- **`scrapling_crawl` returns a job id immediately** — a crawl takes minutes and a tool call has a timeout. Watch it with `job_list`, read it with `job_output`, stop it with `job_kill`; the tool needs a jobs registry that can attach a controller, and a profile without one simply does not register it (single-page fetching is unaffected). The crawl has a wall-clock ceiling (`crawlMaxRuntimeSeconds`) and never leaves the start domain. Politeness defaults follow Scrapling's spider defaults — robots.txt is **not** obeyed, per-domain delay is 0, up to 4 requests run in parallel — and is a deployment decision, not a per-call one (see [Settings](#settings)).
- **`scrapling_answer` fetches the page first, then hands the text plus your question to a model** and returns the conclusion instead of the whole page. It follows the model the current session is already using by default (read from the session's live request header, so a mid-session model switch is picked up), which burns no separate quota; pin `answerProvider` / `answerModel` to route page-reading elsewhere. Page text is **untrusted input** — the prompt frames it explicitly as data, but that defence is prompt-level: it lowers the risk, it does not remove it.

### Render or static

`scrapling_render` is much slower and heavier than `scrapling_fetch`, so start static. Two criteria:

- **If the rendered result is shorter than the static fetch, go back to static.** Plenty of sites ship readable text from the server and then have their own script empty those containers and swap in canvas / Lottie animation — for those pages rendering can only lose content, and no wait setting brings it back. That is site behaviour, not a plugin defect.
- **`waitSelector` waits for an element to appear, not for content to settle.** The element can be removed after it matched, so "the selector matched" does not mean the content is in the result.

One thing that is not a criterion but worth knowing: axis ticks inside SVG **cannot be fetched at all** — the Markdown conversion emits no `<svg>` / `<text>` nodes, so chart numbers are out of reach whichever tool you use. For actual values, go through `scrapling_capture_xhr` to locate the JSON endpoint.

## <img src="https://api.iconify.design/lucide/arrow-right-left.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Replacing the built-in fetch and search

The plugin registers itself as a **fetch provider** and a **search provider** on `ctx.web`, so the built-in `web_fetch` / `web_search` tools actually run on Scrapling instead of dsh's plain-HTTP implementation. The model still calls `web_fetch` / `web_search` — tool names cannot be swapped (same-name registration throws), the provider seam is the supported channel. Both providers are registered by default (`provideWebFetch` / `provideWebSearch`), but that alone displaces nothing:

1. leave `provideWebFetch` / `provideWebSearch` at their default (`true`);
2. set `fetchProvider` / `searchProvider` to `"scrapling"` in the **deployment** config.

A configured id wins over auto-selection, which is why step 2 is required — and with two usable providers and no id named, `ctx.web` answers `WEB_PROVIDER_AMBIGUOUS` and the tool becomes unavailable outright. Two consequences of pointing that line at this plugin:

- **If the sidecar cannot start, the built-in `web_fetch` reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`** rather than quietly falling back to plain HTTP.
- **If you later remove the plugin but leave the line in**, the built-in tools report `WEB_PROVIDER_CONFIGURED_MISSING` — go back and remove `fetchProvider` / `searchProvider` too.
- **The fetch provider really applies the output budget**: a body over `fetchMaxOutputChars` is cut to a head/tail window and flagged `truncated`, not passed through with a flag. Failures keep the sidecar code prefix (`URL_BLOCKED`, `SIDECAR_TIMEOUT`, `SIDECAR_UNAVAILABLE`), so a policy refusal is distinguishable from a crash or a timeout.

Search is split in two, because Scrapling is not a search engine: **discovery** goes to a deployment-level `searchEndpoint`, expected to be SearXNG-compatible JSON (`GET <endpoint>?q=<query>&format=json` returning `{"results": [{"url", "title", "content"}]}` — any backend producing that shape works); **reading** is this plugin's — the first `searchRenderTopN` results are actually fetched and, with a browser, rendered, so one `web_search` call returns both which pages matter and what they say. Every returned URL goes through the same gate as a fetch; a page that fails to read is skipped alone, because search results routinely contain dead links.

One consequence to know: `dsh-web`'s fetch body is a **closed** union of `html | text` with no `markdown` kind, and adding one is a cross-package change a plugin cannot make. The fetch provider therefore reports Scrapling's Markdown as `text`, which the built-in renderer displays normally. Use `scrapling_fetch` directly when you need `html` or a CSS selector.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

Settings live on the **scrapling** card in the plugin detail page, grouped by purpose, each field with a one-line "what changes if you edit this". The card's language follows the host locale. Values marked below live on the card; the deployment table after them is only settable through the `config:` block of `cordis.patch.yml`.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `pythonBin` | string | `""` | Interpreter name or absolute path. Empty = the repository `_env/.venv` when executable, otherwise `python3` on `PATH` |
| `failFastOnMissingPython` | boolean | `true` | Refuses to load when the sidecar process cannot start (wrong path, protocol mismatch, handshake timeout). An interpreter that starts but lacks Scrapling always degrades to "tools unavailable" with the path named in the log, whatever this switch says |
| `fetchEnabled` / `extractEnabled` / `renderEnabled` / `captureXhrEnabled` / `networkEnabled` / `sessionEnabled` / `sessionStateEnabled` / `crawlEnabled` / `answerEnabled` | boolean | `true` | One kill switch per tool or tool pair. `sessionStateEnabled` gates the state save / load pair, which also needs a deployment-side `sessionStateDir` |
| `extractionType` | enum | `markdown` | `markdown` / `html` / `text`; all three run the same anti-injection cleaning, and `html` additionally strips event-handler attributes, so it is not byte-for-byte raw HTML |
| `mainContentOnly` | boolean | `true` | Extraction scope |
| `*MaxOutputChars` | natural | fetch / extract / render `200000`, xhr `120000` | Per-tool output caps. The sidecar clips by characters, the host then trims to a byte budget |
| `crawlMaxItems` | natural | `1000` | Ceiling over the model-supplied `maxPages`. An out-of-range `maxPages` is passed through so the sidecar reports the parameter error rather than this plugin silently clamping it |
| `stripInlineImages` | boolean | `true` | Drops inline `data:` URI images from the body, keeping only alt text — pure token noise for the model. Code fences are left untouched; pages without inline images come back byte-identical. Stripping happens before the cap. Turn off only when the raw base64 **is** the data (colours, fingerprints) |
| `headless` / `networkIdle` | boolean | `true` / `false` | Browser mode and whether a page must reach network idle before it is read |
| `blockAds` | boolean | `true` | Stacks **on top of** the SSRF guard rather than competing with it: the guard is registered last (so the engine runs it first) and yields with `route.fallback()` |
| `pierceShadow` | boolean | `false` | Merges open shadow roots into the body — the switch for pages that hide their text in shadow DOM. The model can also override it per call on the browser tools |
| `waitSelectorState` | enum | `attached` | The state a `waitSelector` element must reach (`attached` / `detached` / `hidden` / `visible`) |
| `sidecarHandshakeTimeoutMs` / `fetchTimeoutMs` / `sidecarGraceMs` | natural | `30000` / `120000` / `5000` | Handshake budget, per-call cooperative timeout (declared on the tools' `timeoutMs`), and how long the client waits for the process to exit before forcing it down. `scrapling_crawl` passes no timeout — a crawl is measured in minutes |
| `dataDir` | string | `""` | Sidecar working directory (the `adaptive` fingerprint database lands here); empty = `~/.dsh-scrapling`. If it cannot be created, `failFastOnMissingPython` decides whether the plugin refuses to load or degrades to no tools |
| `provideWebFetch` / `provideWebSearch` | boolean | `true` | Whether the `ctx.web` providers are registered at all — see [Replacing the built-in fetch and search](#replacing-the-builtin-fetch-and-search) |
| `answerProvider` / `answerModel` / `answerMaxTokens` | string / natural | `""` / `""` / `2000` | The model `scrapling_answer` routes to and the per-reply token cap. Provider and model left empty mean "follow the model the current session is already using" |
| `allowedHosts` | string | `""` | Extra host names that skip the public-address check (comma-separated). Pointing it at an intranet address means giving up SSRF protection for those targets on purpose |
| `syntheticDnsRanges` | string | `""` | Manual fallback for synthetic DNS: a comma-separated CIDR list of your proxy's fake-IP pool, for resolvers that mix synthetic and real answers. Invalid entries are dropped — a broken fallback degrades to "stay strict", not to a crash |
| `proxyUrl` | string | `""` | Where fetches go out (`http://…` / `socks5://…`, optionally `user:pass@`). Empty = follow the environment; see [Proxies](#proxies). Masked on the card, never enters a tool schema |
| `proxyBypass` | string | `""` | Host names that connect directly, mirroring `NO_PROXY`; `*` means the whole machine goes direct |
| `nat64Prefixes` | string | `""` | Extra NAT64 prefixes (comma-separated CIDRs) for operator-specific networks; a declared prefix applies to every IPv6 address |

**Deployment-only knobs** (not on the card; set them in the `config:` block of `cordis.patch.yml`):

| Field | Default | Purpose |
| --- | --- | --- |
| `requestTimeoutSeconds` / `maxUrlLength` | `120` / `2048` | Python-side per-request ceiling; URL length cap aligned with the built-in fetch |
| `allowWriteMethods` | `false` | Whether the model may change state on a remote host at all — see [Security](#security) |
| `browserExecutablePath` / `browserCdpUrl` / `browserInitScript` | `""` | Strong capabilities: they hand Chromium a file to execute and the browser to a debugger endpoint, or inject a JS file into every page. Deployment config only, unreachable from model input |
| `browserRealChrome` / `browserDnsOverHttps` | `false` | Use the locally installed Google Chrome; route the browser's DNS over HTTPS (useful with a proxy to avoid DNS leaks) |
| `recordRequests` / `maxRecordedRequests` | `false` / `100` | Whether browser sessions record network history by default (the model can turn it on per session with `recordNetwork`), and how many entries a session keeps |
| `sessionStateDir` | `""` | Directory for Playwright-compatible login-state files. The model can only pass a **plain file name**, so the directory stays a deployment decision; empty disables the state save / load pair |
| `crawlMaxRuntimeSeconds` | `1800` | Wall-clock ceiling of one crawl — the page cap says nothing about a site that takes a minute per page |
| `crawlRespectRobots` | `false` | Obey robots.txt; with it on, a domain whose robots.txt cannot be fetched is **blocked** rather than assumed permitted |
| `crawlDownloadDelayMs` / `crawlConcurrentRequests` / `crawlAutothrottle` / `crawlStrategy` | `0` / `4` / `false` / `bfs` | Gap between requests, parallelism, adaptive throttling, breadth- or depth-first order |
| `crawlCheckpointDir` | `""` | Persist the crawl queue so a restarted crawl resumes instead of going back to the start URL |
| `searchEndpoint` / `searchRenderTopN` | `""` / `3` | The SearXNG-compatible discovery backend, and how many of its results are actually fetched and rendered (`0` = link list only) |

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Proxies

Where a fetch goes out, resolved in this order — **first hit wins**:

1. `proxyBypass` or the environment's `NO_PROXY` matches this host -> direct.
2. `proxyUrl` on the settings card is non-empty -> use it.
3. `http_proxy` / `https_proxy` / `all_proxy` in the environment (upper case works too) -> use the matching slot.
4. The operating system's proxy settings (`scutil --proxy` on macOS, Internet Settings on Windows) -> use them.
5. Neither -> direct.

What that looks like in practice — **with or without a proxy, the tools just work, with no setting to fill in**:

| Your setup | Static fetching | Render / XHR |
| --- | --- | --- |
| No proxy | direct | direct |
| TUN mode (system-wide) | direct, forwarded by the TUN | same |
| `HTTPS_PROXY` exported in the shell | follows it automatically | follows it automatically |
| macOS / Windows "system proxy" switch | **follows it automatically** | follows it automatically |
| Intranet targets / internal Git | exclude with `proxyBypass` | exclude with `proxyBypass` |
| PAC (auto-config script) | not followed; stderr says to set `proxyUrl` | followed natively by the browser |

Details worth knowing:

- **The resolved proxy is handed to the browser engine explicitly.** Chromium does not read `HTTP_PROXY` / `ALL_PROXY`, so a proxy that is only exported in a shell would cover static fetches but not the browser — this package closes that gap by passing the resolved proxy on every browser fetch. A **browser session** still picks its proxy once, at `scrapling_session_open`: switching it means a new browser context, which throws away the session's cookies and login state — precisely the reason a session exists. Static sessions decide per request.
- **PAC is the one shape that needs a hand-filled `proxyUrl`.** Evaluating a PAC script means downloading it and running JavaScript, and the dialects differ per platform, so this package does not guess; static fetching says so on stderr, and the browser follows PAC natively through its own system settings.
- **A proxy and synthetic DNS are two different problems.** A fake-IP proxy resolves **every** domain into `198.18.0.0/15` (TUN clients often `100.64.0.0/10`); neither is public unicast, so the gate would reject every URL — turning a proxy on would stop the plugin from working. The gate detects that class of resolver on its own (three control names unrelated to any target, all landing in one non-public pool while staying distinct) and then relaxes to the **whole** of the known pools. The control names only trigger the verdict, never size the pool — three hashed answers carry no size information. Private, loopback and link-local ranges are in neither pool, so intranet and metadata addresses stay blocked on a proxied machine. `syntheticDnsRanges` is the manual fallback for a self-built pool outside the two ranges; when detection does not fire, the gate **stays strict**.
- **Through a proxy, a host name this machine cannot resolve is no longer rejected.** The proxy resolves it, and on a network with DNS filtered by region those are exactly the sites that need a proxy. IP literals, private answers the local resolver *can* produce, and single-label host names (`intranet`, `router`) stay rejected.
- **WebRTC leaks are closed whenever a proxy is in play.** Chromium's WebRTC can send UDP around an HTTP/SOCKS proxy, and one STUN call in a page is enough to learn the visitor's real exit address; `blockWebrtc` is forced on with a proxy, no model input involved.
- **Credentials never reach a log or the capability frame.** The report echoes `scheme://host:port` only, with a `source` field (`settings` / `environment` / `system` / `none`) — the first column to read when someone reports that fetching does not work. A malformed proxy address is logged to stderr and treated as "not configured" rather than failing the load.

## <img src="https://api.iconify.design/lucide/shield-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Security

- **SSRF.** Scrapling itself has no SSRF protection. This package adds a URL policy on the host side — scheme allowlist, rejection of URLs with embedded credentials, length cap, rejection of an authority containing a backslash or control characters, DNS resolution with a whole-answer-set public-address check, IPv4-mapped and NAT64 addresses reclassified by their embedded IPv4 — and enforces it again on the Python side. **What is judged is what gets sent**: the gate decides on the WHATWG-normalised form and the sidecar forwards that same string, otherwise "judged A, connected to B" would be a bypass in its own right. The host-side policy is enforced in one place (`SidecarClient.call`), so it covers every tool and the `web_fetch` provider alike, with a rejection throwing `URL_BLOCKED` before the request reaches the pipe; the `web_search` provider runs the same gate over the URLs it is about to return, so a hit the gate rejects never becomes a citeable source. The browser-side guard covers navigation, subresources, XHR and WebSocket handshakes.
- Known gaps, stated in the open:
  - **Connection pinning** (an undici-level technique) is unavailable for a non-Node transport, leaving a TOCTOU window between validation and connect. Static fetches are covered by curl_cffi's `follow_redirects="safe"`; browser fetches by a route handler on the Python side.
  - **NAT64 prefixes are not discovered dynamically.** The two standardized prefixes are covered; operator-specific ones must be declared via `nat64Prefixes`, otherwise a private IPv4 hidden inside IPv6 is judged as an ordinary public IPv6.
  - **No port allowlist** (any port allowed by default), matching dsh's own built-in fetch provider.
  - **The crawl re-checks every page twice** before it enters the result set — once against the guard (the final URL may still have landed somewhere private) and once against the start domain, because Scrapling's `allow_domains` is a string comparison over links found in the page, not redirect targets. The crawl session uses `follow_redirects="safe"` so curl_cffi refuses a jump into a private range.
  - **WebSocket coverage depends on the Playwright version.** The guard intercepts handshakes via `route_web_socket`; older builds lack that method, WebSocket is then outside the guard, and the plugin says so in the log and the capability report rather than degrading silently.
- **No code execution from model input.** `page_action`, `page_setup`, `selector_config`, `proxy`, `executablePath` and `cdpUrl` never appear in any tool schema, and the browser-side network guard is installed by plugin code. The strong browser capabilities and `allowWriteMethods` come only from deployment config.
- **Write verbs are off by default.** With `allowWriteMethods` off, `method` and `body` are absent from `scrapling_fetch`'s parameter surface, and the sidecar independently refuses a non-GET with `WRITE_DISABLED` — two halves that do not rely on each other. The gate, the proxy decision and `follow_redirects="safe"` bound **where** a request goes, not **what it does once there**; prompt-injected page text can ask for a POST, so turn it on only where the task really is to submit data. `headers` and `cookies` stay available either way — anything handed to them lands in the model context by design.
- **Prompt-injection scrubbing runs unconditionally** on all three extraction paths; there is no model-facing switch to turn it off.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Content |
| --- | --- |
| On disk | The sidecar working directory (`dataDir`, default `~/.dsh-scrapling`) holds Scrapling's `adaptive` fingerprint database; login-state files are written under `sessionStateDir` when it is configured. Settings values live in the host settings document. Nothing else is written |
| Network | Fetches go to the URLs the model supplies, through the configured proxy if any. Search queries go to the deployment-level `searchEndpoint`. `scrapling_answer` sends the fetched page text and the question through the host `llm` service — that content leaves the machine when the routed model is remote |
| Logs | The chosen interpreter, the probed capabilities, and the proxy summary (`scheme://host:port` plus which rung answered — never credentials) |
| In memory | Sessions, cookies and recorded network history live in the sidecar process and disappear with it |
| Telemetry | None |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

Registered honestly, one entry per class.

- **Rendering can only lose content on pages that ship readable text and then swap it out.** Sites that serve text for search engines and no-JS users, then empty those containers into canvas / Lottie animation, come back emptier after rendering — see [Render or static](#render-or-static).
- **Axis ticks inside SVG are unreachable in every tool**: the Markdown conversion emits no `<svg>` / `<text>` nodes. For chart values, locate the JSON endpoint with `scrapling_capture_xhr`.
- **A browser session's proxy is fixed at `session_open`**, and `proxyBypass` does not apply per URL inside it (a context switch would discard the cookies and login state that are the point of a session). Static sessions decide per request.
- **`headers` and `retries` on `scrapling_session_fetch` belong to static sessions.** Upstream silently drops both for browser sessions, so this package refuses them with `BAD_ARGS` naming the knob to use instead — a silent no-op is the failure mode it exists to eliminate.
- **Browser identity knobs only live on the tools that can apply them.** `useragent` / `locale` / `timezoneId` / `headless` are model-visible on the one-shot browser tools and on `scrapling_session_open` — they take effect at session construction, and passing them per request is silently dropped upstream.
- **Network history is session-level.** Recording is a construction-time setting (`recordRequests` deployment default, or `recordNetwork` per `scrapling_session_open`); a session that is not recording answers an error, not an empty list.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
| --- | --- |
| The model says the render / capture_xhr tools do not exist | No browser engine on this machine — the plugin registers only what works. Run `python -m patchright install chromium` and restart. If **every** tool is missing, the sidecar did not start: the startup log names the chosen interpreter, and a missing Scrapling carries the pip line to copy |
| After enabling a proxy, every fetch is blocked | A fake-IP proxy resolves every domain into a non-public range; the gate auto-detects that class and relaxes to the known pools. A self-built pool outside them goes into `syntheticDnsRanges`. Private and loopback addresses stay blocked on purpose |
| `web_fetch` reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` / `_MISSING` | The deployment line points at this plugin: either the sidecar is down (interpreter or Scrapling — see the startup log), or the plugin was removed and the `fetchProvider` / `searchProvider` line is still there. Remove the line too |
| The model cannot POST a form | `allowWriteMethods` is off by default and deployment-only — it decides whether the model may change state on a remote host |
| `web_search` returns nothing | Scrapling is not a search engine. Point the deployment-level `searchEndpoint` at a SearXNG-compatible JSON backend |
| The numbers on a chart are missing | SVG tick labels do not survive the Markdown conversion in any tool. Use `scrapling_capture_xhr` to find the JSON endpoint behind the chart |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check     # typecheck → lint → client build → host build → tests → format, then the Python chain
pnpm run test:py   # end-to-end check of the Python sidecar
```

- **The Python half is gated like the TypeScript half.** `check` ends with `check:py`: an interpreter report, a face count (the shipped `.py` files and the test directory must both be there — a missing test directory makes "clean" and "untested" indistinguishable), ruff check, ruff format, mypy, the sidecar end-to-end, bandit (medium and above), and a coverage floor measured **only over the modules that ship**. Dev tools: `pip install -r py/requirements-dev.txt` into the interpreter `test:py` uses.
- **The Python 3.14 floor is one fact in four places:** both READMEs, the ruff and mypy targets, and a runtime gate in `py/bridge.py` that exits before any Scrapling import with a clean stdout — stdout is protocol frames, so an old interpreter shows the exit code and a stderr line instead of garbage.
- **mypy runs non-strict on purpose.** Playwright's `page` / `route` / `websocket` objects have no shape until runtime, and a strict profile would buy a pile of `ignore` comments that exist only to silence it.
- Sources are TypeScript. `host.js` and `client.js` are **build artifacts** and deliberately `.js`: Node refuses to strip types for packages inside `node_modules`, which is exactly where dsh loads the plugin from. The artifact is ESM-only; `require()` will not get you the plugin, and that is deliberate.
- Gates that pin the published shape: `test/publish-manifest.test.ts` (entry targets covered by `files`, no source file as an entry point, `dsh-*` pins exact and uniform, no host package body inlined, no dates or bad bytes in comments or documents) and `test/readme-parity.test.ts` (the two READMEs name every tool and every settings-card knob, and their section structures match).
- Publishing runs through [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) (manual, OIDC trusted publishing plus `--provenance`).

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-scrapling](https://github.com/JayYuen666/dsh-scrapling). Issues go to that repository's tracker.

This package ships no third-party source code — Scrapling and the browser engines are runtime dependencies, and the only third-party content in the package is the icon (Tabler Icons). [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records that boundary.
