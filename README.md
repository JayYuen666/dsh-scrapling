<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-scrapling@main/icon.svg" width="96" height="96" alt="dsh-scrapling logo" />
</p>

<h1 align="center">dsh-scrapling</h1>

<p align="center"><em>Scrapling web scraping for dsh: JavaScript rendering, structured extraction and a background crawler, behind one resident Python sidecar.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-scrapling"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-scrapling?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-scrapling"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-scrapling?style=flat-square" alt="npm downloads (total)" /></a>
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
- [Runtime packs (macOS arm64)](#runtime-packs-macos-arm64)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [The tools](#the-tools)
- [Replacing the built-in fetch and search](#replacing-the-builtin-fetch-and-search)
- [MCP mode](#mcp-mode)
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
- **Requires Python 3.14+ with Scrapling installed** — in the repository's `_env/.venv`, or reachable from `PATH`, or named by `pythonBin`. In an installed package the `_env/.venv` leg does not exist, so the interpreter is the `python3` on your `PATH` (`python` on Windows); whichever one is chosen is logged at load time, and a missing Scrapling reports an error carrying the install line to copy.

```sh
pip install "scrapling[rag]>=0.5,<0.6"
python -m patchright install chromium
```

- **Why `rag` and not `fetchers`:** `rag` is `fetchers` plus `markdownify`, and the default `extractionType` is `markdown` — with plain `fetchers` the first fetch raises `ModuleNotFoundError` at the Markdown conversion.
- **Version range:** developed and verified against Scrapling **0.5**, through interfaces that are not stable API surface (`Selector`, `Spider`, `SessionManager`, and the converter's noise-stripping helpers). The upper bound is pinned below `0.6`; outside the range the guards still run, but the anti-injection cleaning and the crawl path may not behave as documented. In 0.5 the browser backend is patchright only (the old standalone stealth fetch is gone; its anti-detection arguments live on `scrapling_render`), `capture_xhr` became session-level recording (hence `scrapling_session_network`), and `extra_flags` became additive — this package sends none, and WebRTC leak protection is carried by the `blockWebrtc` switch.
- **Without the installer, the browser engine is yours.** The optional CLI can install the verified macOS arm64 set; the plugin itself downloads nothing at load time. Without a browser it simply does not register the browser-dependent tools, so the model never wastes a turn calling them.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts` enforces it). Consumer profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package there becomes a real second copy whose module-level state splits from the running host's — every native tool call then throws while build and tests stay green. The host packages the artifact imports for value are required peers and stay externalized; the gate imports the built artifact and asserts that no host package body is inlined.
- **The artifact is ESM-only and never committed** — `prepack` rebuilds it, so what ships is always what the current source produces.

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names the sources use, and the host then reports `N entries did not activate` together with `does not provide an export named ...` at boot - the package installs fine and never loads, and no per-repository CI run can see it.

## Runtime packs (macOS arm64)

The package ships `bin/dsh-scrapling.mjs`. It installs the ability packs into `dataDir/runtime` (default `~/.dsh-scrapling`) — never into system Python and never into the user's Playwright cache. There is **no `postinstall`**; nothing is downloaded when the plugin loads.

```sh
dsh-scrapling setup --feature core --apply
dsh-scrapling setup --feature browser --apply
dsh-scrapling setup --status
```

- `core` installs managed Python 3.14.9, Scrapling 0.5 and its pinned wheels; `browser` adds the full Chromium build (not the headless shell).
- `search`, `media`, `mcp` and `adaptive-redis` all ride on `core`'s venv: `mcp` brings the official `scrapling-mcp` server (the `mcp` package, 16 tools) that `official-mcp` mode needs, and `adaptive-redis` brings the `redis` client behind `adaptiveStorage: redis`. Every pack is installable; the settings card reports each as `ready`, `missing`, `corrupt` or `installing`.
- `--feature` is a dry run by default; `--apply` writes. `--repair` re-installs without touching user data, and `--uninstall <pack> [--purge]` removes runtime files; only `--purge` removes `elements_storage.db` and `downloads/`.
- `--offline <dir>` installs with no network at all: `<dir>` must hold the Python archive named exactly as the manifest URL's last segment (browser and `curl -O` both keep `cpython-3.14.9+…-install_only.tar.gz`, and the percent-encoded spelling is accepted too) plus a `wheels/` directory with one wheel per pinned requirement - `pip download --only-binary=:all: --require-hashes -r py/runtime-requirements.txt -d <dir>/wheels` produces it. The hash check on the Python archive is the same one the networked path runs, and pip is invoked with `--no-index`; a missing archive or wheelhouse fails as `INSTALL_OFFLINE_ASSETS` instead of silently going online.
- The settings card can start the same install/repair/cancel actions through the `scraplingRuntime` remote when the profile has both a remote surface and a jobs backend; otherwise it prints the CLI command.
- `integrationMode` is deployment-only; `setup --mode` prints or writes the client entry for the two MCP shapes and `doctor` checks a profile against it — see [MCP mode](#mcp-mode). `official-mcp` starts `scrapling-mcp` from the managed venv, which the `mcp` pack provisions (`setup --feature mcp --apply`).
- Only **macOS arm64** is verified. Windows, Linux and macOS x64 are blocked (B1/B2): every pack reports `blocked` and the installer refuses rather than guessing an asset path.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **The layer is mounted.** `dsh --profile web --dump-config` shows this package's layer line.
   - That command is the only accepted "it is in the layer stack" signal, and it is **not read-only** — it rewrites the profile's root assembly file. Read layer lines from stdout **and** check stderr separately: an unmatched patch target appears only on stderr, so the exit code alone proves nothing. Accept both `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The startup log names the interpreter and the plan.** One line prints the probed capabilities and how many of the tools registered; the chosen interpreter path is logged at load. An interpreter that starts but lacks Scrapling is named in the log together with the pip line to copy.
3. **The settings card renders.** The plugin detail page carries the **scrapling** card with every user-editable field grouped by purpose; toggling a value enables Save, and the write returns 200.
4. **A tool round-trip.** Ask the model to fetch a JavaScript-heavy page: the result row renders in the chat through the official tool-call view. On a machine without a browser the render / capture_xhr tools are absent from the model's tool list and their prompt guidance is gone too — that absence is the conditional registration working, not a failure.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **It is not a search engine.** Discovery runs in the Python sidecar against one of six backends (`searchBackend`: `auto` / `tavily` / `bing` / `brave` / `serper` / `duckduckgo` / `searxng`); Scrapling's own `google_search` option only sets a referer header. Each backend needs its own setting (`tavilyApiKey`, `braveApiKey`, `serperApiKey`, `searxngEndpoint`) — a backend that is selected but not configured reports `SEARCH_AUTH` instead of silently switching to another one.
- **The npm tarball bundles no interpreter or browser.** They come from your machine or from the optional CLI installer, which downloads the verified macOS arm64 set into `dataDir/runtime`; missing pieces remove the matching tools instead of being fetched at load time.
- **It opens no HTTP route of its own.** The settings card is a host config form; there is no `/api` surface from this package.
- **It adds no dsh subcommand.** The package's own `dsh-scrapling` CLI only manages runtime packs.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- `dsh.bundle.patch` points at `cordis.patch.yml`, whose single registration line is `- id: scrapling` with the **bare package name** — the host scans `dsh.client` on bare package-name entries only.
- The client half registers two surfaces: the settings card (on the `plugins.bundle.config` slot, keyed by the bundle package name — the host dispatches `entryKey: pkg.name`, so the card renders on this package's detail page) and one result row per tool on `tool.call.toolview`, drawn with the official tool-call view props.
- The settings namespace is the entry id `scrapling`; precedence is settings-card value > registration-line `config:` > schema default. Setting a field back to its default saves a **clear-override**, not a write of the same value, so a later default change still reaches you.
- Gate policy and the sidecar environment are snapshotted once when the plugin is applied — **settings changes take effect on the next start**.
- Disabling a tool also removes its system-prompt guidance: the guidance is re-read at each prompt assembly against the tools that scope can actually see, so a machine without a browser loses the render / capture_xhr lines and a sidecar that never came up loses all of them. The section is placed next to the built-in `web_fetch` guidance.
- `scrapling_crawl` registers its own job kind, so `job_list` labels its jobs as crawls rather than shell jobs.

## <img src="https://api.iconify.design/lucide/globe.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The tools

Nineteen tools, behind fifteen settings switches (the seven session/state tools share switches), all exercised by the test suite:

| Tool | Backend | Needs a browser | Concurrency |
|---|---|---|---|
| `scrapling_fetch` | `Fetcher` (curl_cffi) | no | concurrent; write verbs are serialised once `allowWriteMethods` is on |
| `scrapling_extract` | `Selector` + CSS/XPath + `adaptive` | no | concurrent |
| `scrapling_locate` | text / regex / similar-element lookup; returns generated selectors | no | concurrent |
| `scrapling_links` | `LinkExtractor` plus next-page candidates | no | concurrent |
| `scrapling_render` | `StealthySession` (patchright) | yes | serialised; the anti-detection switches (`solveCloudflare` / `hideCanvas` / `blockWebrtc`) live here |
| `scrapling_capture_xhr` | one throwaway session, page-level recording | yes | serialised |
| `scrapling_session_open` / `scrapling_session_fetch` / `scrapling_session_network` / `scrapling_session_state_save` / `scrapling_session_state_load` / `scrapling_session_list` / `scrapling_session_close` | Scrapling session classes | browser sessions only | serialised |
| `scrapling_session_read` | current DOM of a browser session page | yes | serialised |
| `scrapling_session_act` | structured actions on a session page (deployment gate) | yes | serialised |
| `scrapling_download` | byte download into `dataDir/downloads` (deployment gate) | no | concurrent |
| `scrapling_screenshot` | PNG/JPEG screenshot handed to the attachment service | yes | serialised |
| `scrapling_crawl` | Scrapling Spider framework (`content` / `sitemap` / `feed` / `shopify`) as a job | no | serialised |
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

Search is split in two, because Scrapling is not a search engine: **discovery** runs in the Python sidecar against the backend `searchBackend` names — Tavily, Bing HTML, Brave (API), Serper (API), DuckDuckGo HTML or SearXNG (JSON API); **reading** is this plugin's — the first `searchRenderTopN` results are actually fetched and, with a browser, rendered, so one `web_search` call returns both which pages matter and what they say. `auto` uses Tavily when `tavilyApiKey` is set, SearXNG when `searxngEndpoint` is set, and with neither configured it only goes to a public engine (Bing; DuckDuckGo when that backend is named explicitly) if `searchPublicFallback` is on — otherwise the provider is unavailable and `web_search` reports `SEARCH_BACKEND_MISSING` instead of querying anyone. Only Tavily and Bing have been exercised against the real endpoints here; Brave, Serper, DuckDuckGo and SearXNG are implemented to their documented request/response shapes and verified against local stubs, with real keys and real instances still unverified. Every returned URL goes through the same gate as a fetch; a page that fails to read is skipped alone, because search results routinely contain dead links.

One consequence to know: `dsh-web`'s fetch body is a **closed** union of `html | text` with no `markdown` kind, and adding one is a cross-package change a plugin cannot make. The fetch provider therefore reports Scrapling's Markdown as `text`, which the built-in renderer displays normally. Use `scrapling_fetch` directly when you need `html` or a CSS selector.

## <img src="https://api.iconify.design/lucide/plug-zap.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> MCP mode

`integrationMode` selects one of three mutually exclusive tool surfaces. It is deployment configuration (the `config:` block of `cordis.patch.yml`), it is read once when the plugin is assembled, and changing it requires a restart.

| Mode | What it registers |
|---|---|
| `native` (default) | the `scrapling_*` tools listed above |
| `mcp` | no native tools; the plugin serves the same tool table over MCP |
| `official-mcp` | no native tools and no server from this plugin; `setup` only generates the `dsh-mcp-client` entry for the official `scrapling-mcp`, which runs in its own process, with its own sessions, and **without this plugin's URL guard** |

In `mcp` mode the server runs inside the plugin's own host process and calls the same sidecar, so the URL guard, sessions, jobs and adaptive storage are the same ones the native tools use — there is no second implementation to drift.

- **Endpoint** `http://127.0.0.1:<mcpPort>/mcp` (`mcpPort`, default `39217`). Only loopback is bound; a request whose declared body exceeds 1 MiB is refused with `413`, and any other path gets `404`. The server is stateless: each request gets its own protocol instance, so nothing survives across them.
- **Auth** off by default. Set the environment variable `DSH_SCRAPLING_MCP_TOKEN` and every request must then carry `Authorization: Bearer <token>`. The token is only ever read from the environment, never from the profile, so it does not land in a config file.
- **Tools** are the same `ToolDefinition` objects native registers: same JSON Schema, same argument validation, same renderers. `scrapling_answer` is not served — it routes through the model of the hosting session, which an external client does not have. `search` exists only on this surface, because an MCP client has no `ctx.web` seam. The gates are identical: with `allowBrowserActions=false` there is no `session_act`, with `allowFileDownloads=false` there is no `download`, and `search` is absent when no search backend is available.
- **Results** are text content; a screenshot comes back as MCP image content instead of a host attachment. A failing tool returns `isError` with a readable message rather than dropping the connection.
- **Names**: the MCP raw name is the tool name without the `scrapling_` prefix, and dsh's MCP client shows it as `mcp__scrapling__<raw>`.

| Native tool | MCP raw name |
|---|---|
| `scrapling_fetch` | `fetch` |
| `scrapling_extract` | `extract` |
| `scrapling_locate` | `locate` |
| `scrapling_links` | `links` |
| `scrapling_render` | `render` |
| `scrapling_capture_xhr` | `capture_xhr` |
| `scrapling_session_open` | `session_open` |
| `scrapling_session_fetch` | `session_fetch` |
| `scrapling_session_network` | `session_network` |
| `scrapling_session_state_save` | `session_state_save` |
| `scrapling_session_state_load` | `session_state_load` |
| `scrapling_session_list` | `session_list` |
| `scrapling_session_close` | `session_close` |
| `scrapling_crawl` | `crawl` |
| `scrapling_session_read` | `session_read` |
| `scrapling_session_act` | `session_act` |
| `scrapling_download` | `download` |
| `scrapling_screenshot` | `screenshot` |
| — (`ctx.web` only) | `search` |

Connecting dsh needs `@deepseek-ai/dsh-mcp-client`, which this plugin deliberately does not depend on. Pin the build that matches the current host — npm `latest` is older than the host's own line and the host rejects the mismatch:

```bash
dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client@0.2.1-rc.3
```

Then add one entry to that profile's `cordis.patch.yml` — this is exactly what `dsh-scrapling setup --mode mcp` prints, so you can also let the CLI write it (drop `headers` when no token is configured):

```yaml
- insert:
    - id: scrapling-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: scrapling
        transport: streamable-http
        url: http://127.0.0.1:39217/mcp
        failOnStartupError: false
        # only with DSH_SCRAPLING_MCP_TOKEN set:
        # headers:
        #   Authorization: !!js '`Bearer ${process.env.DSH_SCRAPLING_MCP_TOKEN}`'
```

`mcpPort` and that URL have to say the same thing; after changing the port, re-apply the entry.

`failOnStartupError` is `false` here on purpose: the port only starts listening once the plugin has finished handshaking with the Python sidecar, and the client throws its fiber on the **first** failed connect (`Version negotiation probe failed: connect ECONNREFUSED` → the host reports `1 entry did not activate`). Its own reconnect is on by default (500ms backoff, 10 attempts), so a first-attempt refusal is meant to be absorbed - setting this to `true` would let fiber start order decide whether the mode works. The official `stdio` entry keeps `true`: there the client spawns the server itself, so a failed connect is a real failure and should be loud.

### <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> `setup --mode` and `doctor`

`setup --mode` writes that entry text; it never edits a profile. Without `--apply` it is a dry run, and with `--apply` it drops the text in `<dataDir>/mcp/<mode>.patch.yml` and prints the path - applying it to `cordis.patch.yml` stays your action, because the host offers no safe append API for that file (`dsh --dump-config` rewrites the profile's root config).

```sh
dsh-scrapling setup --mode mcp --port 45991 --with-auth --apply
dsh-scrapling setup --mode native --apply     # a file that deliberately contains no entry
dsh-scrapling doctor --mode mcp --profile <profileDir>
```

`doctor` reads what the profile actually says - `cordis.patch.yml` plus that profile's `package.json` - and prints one line per problem: two entries under `serverName: scrapling`, this plugin's entry next to an official `stdio` one, entries that do not match the mode, an entry whose port disagrees with `--port`, a profile without `@deepseek-ai/dsh-mcp-client` or with it pinned to something other than `0.2.1-rc.3` / `next`, and an official entry while `officialMcpEnabled` is off. Exit `0` is "consistent", `1` names at least one problem, `2` is a bad argument. `integrationMode` itself is a plugin setting the CLI cannot read, so `--mode` is the claim being checked and has to match the deployment.

`official-mcp` asks for two separate statements before it produces anything: `officialMcpEnabled: true` in the profile and `--accept-risk` on the command line; missing either one prints `OFFICIAL_MCP_DISABLED` / `RISK_NOT_ACCEPTED` and writes nothing. The entry it generates starts `<dataDir>/runtime/venv/bin/scrapling-mcp`, so run `setup --feature mcp --apply` first - see [Runtime packs](#runtime-packs-macos-arm64). When that binary is missing, `setup` prints a line saying so.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

Settings live on the **scrapling** card in the plugin detail page, grouped by purpose, each field with a one-line "what changes if you edit this". The card's language follows the host locale. Values marked below live on the card; the deployment table after them is only settable through the `config:` block of `cordis.patch.yml`.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `pythonBin` | string | `""` | Interpreter name or absolute path. Empty = the repository `_env/.venv` when usable, otherwise `python3` on `PATH` (`python` on Windows) |
| `failFastOnMissingPython` | boolean | `true` | Refuses to load when the sidecar process cannot start (wrong path, protocol mismatch, handshake timeout). An interpreter that starts but lacks Scrapling always degrades to "tools unavailable" with the path named in the log, whatever this switch says |
| `fetchEnabled` / `extractEnabled` / `locateEnabled` / `linksEnabled` / `renderEnabled` / `captureXhrEnabled` / `networkEnabled` / `sessionEnabled` / `sessionStateEnabled` / `crawlEnabled` / `answerEnabled` / `sessionReadEnabled` / `sessionActionsEnabled` / `downloadEnabled` / `screenshotEnabled` | boolean | `true` | One kill switch per tool or tool pair. `sessionStateEnabled` gates the state save / load pair, which also needs a deployment-side `sessionStateDir` |
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
| `searchBackend` / `tavilyApiKey` | enum / secret | `auto` / `""` | Discovery backend (`auto` / `tavily` / `bing` / `brave` / `serper` / `duckduckgo` / `searxng`) and the Tavily key. `auto` uses Tavily when a key is set, SearXNG when `searxngEndpoint` is set, and only falls back to public engines when `searchPublicFallback` is on (otherwise it reports `SEARCH_BACKEND_MISSING`); a backend selected without its own key (or instance) reports `SEARCH_AUTH` |
| `searchPublicFallback` | boolean | `false` | Lets `auto` fall back to public engines (DuckDuckGo / Bing) when neither a key nor SearXNG is configured. Off by default on purpose: turning it on sends query strings to third-party public engines |
| `braveApiKey` / `serperApiKey` | secret | `""` | Keys for the Brave Search and Serper.dev backends |
| `searxngEndpoint` | string | `""` | Base URL of a SearXNG instance (`…/search?format=json` is appended); empty means the backend is unusable and reports `SEARCH_AUTH` |
| `duckduckgoEndpoint` | string | `https://html.duckduckgo.com/html/` | DuckDuckGo HTML endpoint; override for a mirror or a test stub |
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
| `adaptiveStorage` | `sqlite` | Where `adaptive` fingerprints live: `sqlite` (one file under `dataDir`) or `redis` (one keyspace, shareable across processes and hosts). Deployment-only - the model only ever says "save" or "relocate" |
| `redisUrl` | `redis://127.0.0.1:6379/0` | Connection string read when `adaptiveStorage: redis`. The password never reaches logs or error text; an unreachable server fails as `ADAPTIVE_STORAGE_UNAVAILABLE` |
| `crawlMaxRuntimeSeconds` | `1800` | Wall-clock ceiling of one crawl — the page cap says nothing about a site that takes a minute per page |
| `crawlRespectRobots` | `false` | Obey robots.txt; with it on, a domain whose robots.txt fetch **fails** (network error or HTTP 5xx) is blocked rather than assumed permitted, while a **missing** robots.txt (HTTP 404, the common case) is treated as allowing everything |
| `crawlDownloadDelayMs` / `crawlConcurrentRequests` / `crawlAutothrottle` / `crawlStrategy` | `0` / `4` / `false` / `bfs` | Gap between requests, parallelism, adaptive throttling, breadth- or depth-first order |
| `crawlCheckpointDir` | `""` | Persist the crawl queue so a restarted crawl resumes instead of going back to the start URL |
| `tavilyApiEndpoint` / `bingEndpoint` / `searchRenderTopN` | `https://api.tavily.com/search` / `https://www.bing.com/search` / `3` | Discovery endpoints (overridable for tests or proxies), and how many results are actually fetched and rendered (`0` = link list only) |
| `allowBrowserActions` / `allowFileDownloads` / `downloadMaxBytes` | `false` / `false` / `10485760` | Deployment-only gates for structured actions and downloads, plus the per-download byte cap. Both gates default off and also hide their tools from the model |

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

- **SSRF.** Scrapling itself has no SSRF protection. This package adds a URL policy on the host side — scheme allowlist, rejection of URLs with embedded credentials, length cap, rejection of an authority containing a backslash or control characters, DNS resolution with a whole-answer-set public-address check, IPv4-mapped and NAT64 addresses reclassified by their embedded IPv4 — and enforces the scheme, credential and address rules again on the Python side (the length cap stays with the host policy, because it is a deployment setting). Outbound paths accept only `http`/`https` and reject embedded credentials; `ws`/`wss` are judged by address alone in the WebSocket-handshake check. **What is judged is what gets sent**: the gate decides on the WHATWG-normalised form and the sidecar forwards that same string, otherwise "judged A, connected to B" would be a bypass in its own right. The host-side policy is enforced in one place (`SidecarClient.call`), and that one place screens every URL the model can hand over — `url`, plus crawl's `sitemapUrl` and `feedUrl` — so it covers every tool and the `web_fetch` provider alike, with a rejection throwing `URL_BLOCKED` before the request reaches the pipe; the `web_search` provider runs the same gate over the URLs it is about to return, so a hit the gate rejects never becomes a citeable source. The browser-side guard covers navigation, subresources, XHR and WebSocket handshakes.
- Known gaps, stated in the open:
  - **Connection pinning** (an undici-level technique) is unavailable for a non-Node transport, leaving a TOCTOU window between validation and connect. Static fetches are covered by curl_cffi's `follow_redirects="safe"`; browser fetches by a route handler on the Python side.
  - **NAT64 prefixes are not discovered dynamically.** The two standardized prefixes are covered; operator-specific ones must be declared via `nat64Prefixes`, otherwise a private IPv4 hidden inside IPv6 is judged as an ordinary public IPv6.
  - **No port allowlist** (any port allowed by default), matching dsh's own built-in fetch provider.
  - **The crawl re-checks every page twice** before it enters the result set — once against the guard (the final URL may still have landed somewhere private) and once against the start domain, because Scrapling's `allow_domains` is a string comparison over links found in the page, not redirect targets. The crawl session uses `follow_redirects="safe"` so curl_cffi refuses a jump into a private range.
  - **WebSocket coverage depends on the Playwright version.** The guard intercepts handshakes via `route_web_socket`; older builds lack that method, WebSocket is then outside the guard, and the plugin reports that as `websocketGuard` in the handshake capabilities (the startup log prints the probed capabilities) rather than degrading silently.
- **No code execution from model input.** `page_action`, `page_setup`, `selector_config`, `proxy`, `executablePath` and `cdpUrl` never appear in any tool schema, and the browser-side network guard is installed by plugin code. The strong browser capabilities and `allowWriteMethods` come only from deployment config.
- **Write verbs are off by default.** With `allowWriteMethods` off, `method` and `body` are absent from `scrapling_fetch`'s parameter surface, and the sidecar independently refuses a non-GET with `WRITE_DISABLED` — two halves that do not rely on each other. The gate, the proxy decision and `follow_redirects="safe"` bound **where** a request goes, not **what it does once there**; prompt-injected page text can ask for a POST, so turn it on only where the task really is to submit data. `headers` and `cookies` stay available either way — anything handed to them lands in the model context by design.
- **Prompt-injection scrubbing runs unconditionally** on all three extraction paths; there is no model-facing switch to turn it off.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Content |
| --- | --- |
| On disk | The sidecar working directory (`dataDir`, default `~/.dsh-scrapling`) holds Scrapling's `adaptive` fingerprint database; login-state files are written under `sessionStateDir` when it is configured. Settings values live in the host settings document. Nothing else is written |
| Network | Fetches go to the URLs the model supplies, through the configured proxy if any. Search queries go from the Python sidecar to Tavily or Bing (the configured `tavilyApiKey` is sent to Tavily and never logged). `scrapling_answer` sends the fetched page text and the question through the host `llm` service — that content leaves the machine when the routed model is remote |
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
- **`scrapling_screenshot` bypasses text cleaning.** Screenshots capture whatever the page renders in the viewport — including visual secrets (tokens, private messages, data behind a login) that never appear in the DOM text the other tools clean. They are stored through the host attachment service and are only available when that service is mounted. What comes back is the service's **normalized** reference: a declared PNG can be persisted as `image/jpeg` at a smaller raster, with `originalDimensions` carrying what the page actually produced (host contract: `saveImage` in `@deepseek-ai/dsh-attachment`). `scrapling_download` writes bytes under `dataDir/downloads`, never overwrites an existing file, and refuses path components in `filename`.
- **`scrapling_locate` and `scrapling_links` are offline parsers.** Both take HTML and never fetch; `scrapling_links` keeps relative links only when `baseUrl` is supplied — with an empty `baseUrl` it returns no links rather than guessing absolute URLs. Both share `extractMaxOutputChars`.
- **Adaptive relocation is best-effort.** Scrapling saves only the first matching element, and a near-identical sibling can be chosen when the original attributes change. Treat a relocated match as a hint and verify it; `scrapling_locate` never saves fingerprints.
- **Runtime packs are verified on macOS arm64 only.** Windows, Linux and macOS x64 report every pack as `blocked`; the installer refuses rather than guessing an asset path (B1/B2).
- **The `adaptive-redis` pack is a client, not a storage engine.** Upstream ships only `SQLiteStorageSystem`; the Redis backend here is this plugin's `py/redis_storage.py`, a `StorageSystemMixin` subclass keyed by registered domain. Enabling it changes where fingerprints live, so treat it as a deployment decision, not a per-call switch. The plugin's own MCP server is separate — it runs in-process and needs no pack.
- **Shopify crawl mode walks the store's JSON API.** `mode=shopify` uses the store's `/collections.json` and each collection's `/products.json` (upstream's `ShopifySpider`) and yields one row per variant — `name` (product + variant, minus `Default Title`), `price`, `sku`, `stock` (`null` when available, `0` when not), `identifier`, `brand`, `category`, `image_url`, `url`, `barcode`, `old_price`, `description`. It never scrapes product HTML, and it obeys the same URL gate, robots setting, delay and concurrency knobs as the other crawl modes. Verified against a local fixture store; a real Shopify store has not been exercised (B11).
- **`official-mcp` generates configuration only.** `integrationMode=official-mcp` registers no native tool and starts no server from this plugin; `setup --mode official-mcp --accept-risk` produces the `dsh-mcp-client` entry for the official server, whose binary comes from the `mcp` pack (B10 is the risk decision that entry stands on).

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
| --- | --- |
| The model says the render / capture_xhr tools do not exist | No browser engine on this machine — the plugin registers only what works. Run `python -m patchright install chromium` and restart. If **every** tool is missing, the sidecar did not start: the startup log names the chosen interpreter, and a missing Scrapling carries the pip line to copy |
| After enabling a proxy, every fetch is blocked | A fake-IP proxy resolves every domain into a non-public range; the gate auto-detects that class and relaxes to the known pools. A self-built pool outside them goes into `syntheticDnsRanges`. Private and loopback addresses stay blocked on purpose |
| `web_fetch` reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` / `_MISSING` | The deployment line points at this plugin: either the sidecar is down (interpreter or Scrapling — see the startup log), or the plugin was removed and the `fetchProvider` / `searchProvider` line is still there. Remove the line too |
| The model cannot POST a form | `allowWriteMethods` is off by default and deployment-only — it decides whether the model may change state on a remote host |
| `web_search` reports `SEARCH_AUTH` | The selected backend has no credential: Tavily/Brave/Serper need their key, SearXNG needs `searxngEndpoint`. Set it, or switch `searchBackend`. With `searchBackend=auto` and no key and no `searxngEndpoint`, the plugin reports `SEARCH_BACKEND_MISSING` — set a key / endpoint, or turn on `searchPublicFallback` to allow public engines |
| The numbers on a chart are missing | SVG tick labels do not survive the Markdown conversion in any tool. Use `scrapling_capture_xhr` to find the JSON endpoint behind the chart |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check     # typecheck → lint → client build → host build → tests → format, then the Python chain
pnpm run test:py   # end-to-end check of the Python sidecar
```

- **The Python half is gated like the TypeScript half.** `check` ends with `check:py`: an interpreter report, a face count (the shipped `.py` files and the test directory must both be there — a missing test directory makes "clean" and "untested" indistinguishable), a dependency consistency check, ruff check, ruff format, mypy, the sidecar end-to-end, bandit (all severities; `# nosec` only for justified false positives), and a coverage floor measured **only over the modules that ship**. Dev tools: `pip install -r py/requirements-dev.txt` into the interpreter `test:py` uses.
- **The Python 3.14 floor is one fact in four places:** both READMEs, the ruff and mypy targets, and a runtime gate in `py/bridge.py` that exits before any Scrapling import with a clean stdout — stdout is protocol frames, so an old interpreter shows the exit code and a stderr line instead of garbage.
- **mypy checks untyped bodies and rejects unannotated defs and unused ignores.** Playwright's `page` / `route` / `websocket` objects have no shape until runtime, so `ignore_missing_imports` and `ANN401` stay off; those three checks are on, not the full `strict` profile.
- Sources are TypeScript. `host.js` and `client.js` are **build artifacts** and deliberately `.js`: Node refuses to strip types for packages inside `node_modules`, which is exactly where dsh loads the plugin from. The artifact is ESM-only; `require()` will not get you the plugin, and that is deliberate.
- Gates that pin the published shape: `test/publish-manifest.test.ts` (entry targets covered by `files`, no source file as an entry point, `dsh-*` pins exact and uniform, no host package body inlined, no dates or bad bytes in comments or documents) and `test/readme-parity.test.ts` (the two READMEs name every tool and every settings-card knob, and their section structures match).
- Publishing runs through [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) (manual, OIDC trusted publishing plus `--provenance`).

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-scrapling](https://github.com/JayYuen666/dsh-scrapling). Issues go to that repository's tracker.

This package ships no third-party source code — Scrapling and the browser engines are runtime dependencies, and the only third-party content in the package is the icon (Tabler Icons). [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records that boundary.
