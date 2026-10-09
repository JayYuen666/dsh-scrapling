# @jayyuen66/dsh-scrapling

English · [中文](./README.zh-CN.md)

[Scrapling](https://github.com/D4Vinci/Scrapling) web scraping for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh),
exposed as agent tools backed by a long-lived Python process.

## Why this plugin exists

dsh ships `web_fetch` and `web_search`. `web_fetch` is deliberately honest and minimal:
a plain HTTP(S) GET with no JavaScript execution, an honest `User-Agent`
(`deepseek-harness/0.2.0-rc.2`, explicitly *"never a browser disguise"*), and a
turndown-based HTML-to-markdown conversion. That is a good default, but it means a
single-page application yields only its loading shell, and there is no way to ask for
"just the product table".

Measured on a page whose content exists only after JavaScript runs:

| Pipeline | Text obtained |
|---|---|
| raw HTML to text (no JS) | `SPA Shell / LOADING_PLACEHOLDER` |
| `Fetcher` (curl_cffi, still no JS) | `SPA Shell / LOADING_PLACEHOLDER` |
| `DynamicFetcher` (Playwright) | full rendered DOM, Markdown table, structured rows |

This plugin adds exactly three things dsh's built-in tools cannot do:

1. **Browser rendering** - JavaScript execution via Playwright / patchright.
2. **Structured extraction** - CSS/XPath selection returning data, not a wall of Markdown.
3. **Self-healing selectors** - Scrapling's `adaptive` mode relocates an element after
   the site's markup changes. Verified working: a selector that returns `None` after a
   class rename returns the relocated element when `adaptive=True`.

## Status

All eleven tools (the session family counts as four) are implemented, registered and
exercised by the test suite. Tools
are registered **conditionally**: the plugin probes what the environment can actually
do at startup and only registers tools that will work, so the model never burns a
turn on a tool that was guaranteed to fail.

| Tool | Backend | Needs a browser | Concurrency |
|---|---|---|---|
| `scrapling_fetch` | `Fetcher` (curl_cffi) | no | safe |
| `scrapling_extract` | `Selector` + CSS/XPath + `adaptive` | no | safe |
| `scrapling_render` | `DynamicFetcher` (Playwright) | yes | serialised |
| `scrapling_capture_xhr` | `capture_xhr` | yes | serialised |
| `scrapling_stealth_fetch` | `StealthyFetcher` (patchright) | yes | serialised |
| `scrapling_session_open` / `scrapling_session_fetch` / `scrapling_session_list` / `scrapling_session_close` | Scrapling session classes | depends | serialised |
| `scrapling_crawl` | Scrapling Spider framework | no | serialised, runs as a job |
| `scrapling_answer` | any of the above, plus `ctx.llm` | no (yes with `render:true`) | serialised |

`scrapling_answer` is the only tool that spends **another model call**: it fetches the page
first, then hands the text plus your question to a model and returns the conclusion instead
of the whole page. By default it follows **the model the current session is already using**
(read from the session's live request header, so a mid-session model switch is picked up),
which means the plugin does not burn a separate quota; you can pin `answerProvider` /
`answerModel` on the settings card to route page-reading to a different model.

Page text is **untrusted input** — a page can say "ignore your previous instructions". The
answer prompt frames the text explicitly as data and forbids acting on it, but that defence
is prompt-level: it lowers the risk, it does not remove it.

Everything runs against **one long-lived Python process**. That is not an
optimisation — Scrapling's session classes keep cookies, the browser engines keep a
page pool, and `adaptive` keeps a SQLite fingerprint database. A process per call
would throw all of that away.

`scrapling_crawl` returns a **job id immediately** rather than blocking: a crawl takes
minutes, a tool call has a timeout. Watch it with `job_list`, read it with
`job_output`, stop it with `job_kill`.

## Requirements

- **Python 3.10+** with Scrapling installed, reachable via `PATH` (or set `pythonBin`).
- **Browser engines are entirely the user's responsibility.** The plugin does not
  download anything. Without a browser it simply does not register the
  browser-dependent tools, so the model never wastes a turn calling them.

```sh
pip install "scrapling[rag]>=0.4.15,<0.5"
python -m playwright install chromium
```

> **Why `rag` and not `fetchers`?** `rag` is `fetchers` plus `markdownify`, and the
> default `extractionType` is `markdown` — with plain `fetchers` the Markdown conversion
> raises `ModuleNotFoundError` on the first fetch. The Python side then tells you exactly
> which package is missing.

> **Version range**: this plugin is developed and verified against Scrapling **0.4.15**
> and depends on its `Convertor._strip_noise_tags` / `_sanitize_for_ai`, `Selector`,
> `Spider` and `SessionManager` interfaces. None of those are stable API surface, so the
> upper bound is pinned below `0.5`; outside the range the guards still run, but the
> anti-injection cleaning and the crawl path may not behave as documented.

## Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-scrapling
```

The plugin is also installable from the Web UI via **Sidebar -> Plugins -> Add plugin**.

## Replacing the built-in `web_fetch` and `web_search`

The plugin registers itself as a **fetch provider** and a **search provider** on
`ctx.web`, so the built-in `web_fetch` / `web_search` tools actually run on Scrapling
instead of dsh's plain-HTTP implementation. The model still calls `web_fetch` /
`web_search` — that is what "replacing the built-in one" means here.

> **Tool names cannot be swapped; only the backend can.** `ToolRuntime.register` ends at
> `NamedEntries.insert`, which **throws** on a duplicate name
> (`tool "X" is already registered`). Registering a same-named tool is therefore closed off;
> the `ctx.web` provider seam is the supported replacement channel.

Both must be done together, or the built-in tools break:

1. set `provideWebFetch` / `provideWebSearch` to `true` in the plugin config;
2. set `fetchProvider` / `searchProvider` to `"scrapling"` in the **deployment** config.

> **Why both?** `ctx.web` auto-selects only when exactly one usable provider is registered.
> A second one without naming it yields `WEB_PROVIDER_AMBIGUOUS` and the tool becomes
> unavailable outright. Hence both switches default to `false`.

When `searchEndpoint` is empty the search provider's `available()` is `false` — a second
guard: enabling `provideWebSearch` without configuring an endpoint cannot displace the
built-in `web_search`.

### Search + render in one call

Scrapling is **not** a search engine (its `google_search` option only sets a Google referer
header), so `web_search` is split in two:

- **Discovery** → a configurable search backend (deployment-level `searchEndpoint`),
  expected to be SearXNG-compatible JSON: GET `<endpoint>?q=<query>&format=json` returning
  `{"results": [{"url", "title", "content"}]}`. Any backend producing that shape works.
- **Reading** → this plugin's sidecar. The first `searchRenderTopN` results (3 by default)
  are actually fetched and, when a browser is available, rendered through Playwright. The
  body lands in `content`, the URLs in `sources`.

One `web_search` call therefore yields both "which pages are relevant" and "what those
pages actually say" — the latter being exactly the SPA content `web_fetch` structurally
cannot read. Returned URLs are re-checked one by one by this plugin's URL gate; the parsing
layer deliberately does not duplicate that policy. A page that fails to read is skipped
alone — search results routinely contain dead links.

One consequence to know: `dsh-web`'s `WebFetchBody` is a **closed** union with only
`html | text`, no `markdown`; adding a kind is a cross-package change a plugin cannot make.
So the fetch provider reports Scrapling's Markdown as `text`, which the built-in renderer
displays normally. Use `scrapling_fetch` directly when you need `html` or a CSS selector.

## Configuration

Settings live on the **scrapling** card in the plugin detail page (Settings → Plugins →
expand this bundle). Every field marked user-editable in [`host.ts`](./host.ts) appears
there, grouped by what it is for and with a one-line "what changes if you edit this";
deployment-level fields are only settable through the `config:` block in
[`cordis.patch.yml`](./cordis.patch.yml). Setting a field back to its default saves a
**clear-override**, not a write of the same value - so when the default changes later,
that field follows along.

Notable switches:

- `pythonBin` - interpreter name or absolute path; empty means `python3` on `PATH`.
- `fetchEnabled` / `extractEnabled` / `renderEnabled` / `captureXhrEnabled` /
  `sessionEnabled` / `answerEnabled` - on by default.
- `stealthEnabled` / `crawlEnabled` - **off** by default (extra browser dependency /
  long-running background job).
- `extractionType` - `markdown` (default), `html` or `text`. All three paths run the
  same anti-injection cleaning; `html` additionally strips event-handler attributes
  (`on*`, `srcdoc`, `formaction`) and `meta refresh`, so the result is **not**
  byte-for-byte raw HTML.
- `*MaxOutputChars` - per-tool output caps. `crawlMaxItems` is the deployment-side
  ceiling over the model-supplied `maxPages`; an out-of-range `maxPages` (0, negative,
  NaN) is passed through unchanged so the sidecar reports the parameter error rather
  than this plugin silently clamping it into a legal-looking value.
- `stripInlineImages` - **on** by default: inline `data:` URI images are dropped from
  the body and only their alt text is kept. Such an image is pure token noise - a
  base64 SVG costs characters in the context while the model cannot read a shape out
  of it. Pages with no inline images come back **byte-identical**; where there are some, the
  saving depends entirely on how many - a site either inlines none or inlines a whole wall of
  logos, and little in between. So turning this on is free for pages without inline images, and
  the whole benefit lands when it matches.
  `data:` URIs inside code fences are left untouched - there they are almost always
  sample code a tutorial is teaching, and stripping would be editing the document.
  Turn this off only when the raw base64 *is* the data (colours, fingerprints).
  Stripping happens **before** the cap: the other way round is pointless, since those
  tens of kilobytes have already eaten the `maxContentChars` budget.
- `answerProvider` / `answerModel` / `answerMaxTokens` - the model `scrapling_answer`
  routes to and the per-call token ceiling. Provider and model left empty mean "follow
  the model the current session is already using"; `answerMaxTokens` caps the reply.
- `mainContentOnly` / `headless` / `networkIdle` / `captureXhrPattern` /
  `waitSelectorState` / `dataDir` - extraction scope, browser mode, the XHR capture
  filter, the selector state a page must reach before it is read, and the sidecar
  working directory. Each is documented at its declaration in [`host.ts`](./host.ts).
- `sidecarHandshakeTimeoutMs` / `fetchTimeoutMs` / `sidecarGraceMs` - the budget for the
  sidecar handshake, the per-call cooperative timeout (declared as the tools' `timeoutMs`), and
  how long the client waits for the process to exit after that timeout before forcing it down.
  The three are on the settings card. `scrapling_crawl` is the exception: it runs as a job and
  passes no timeout, because a crawl is measured in minutes and a fixed budget would tear the
  process down on every success.
- `failFastOnMissingPython` - `true` (default) refuses to load when the interpreter is
  unusable, because every tool needs the sidecar and a silent degrade leaves the model
  discovering "all tools are missing" several turns later. `false` degrades to "all
  tools unavailable" with a warning.
- `blockAds` - on by default. It stacks **on top of** the SSRF guard rather than
  competing with it: the guard is registered last (so Playwright runs it first) and
  yields with `route.fallback()`, leaving Scrapling's own interception handler reachable.
- `allowedHosts` - extra host names that skip the public-address check. The same setting
  feeds both layers, so an explicitly allowed intranet target is not rejected by the
  host-side policy before the Python side ever sees it. Pointing it at an intranet
  address means giving up SSRF protection for those targets on purpose.
- `syntheticDnsRanges` - manual fallback for synthetic DNS: a comma-separated CIDR list
  of your proxy's fake-IP pool. Detection is the main path and should handle it; this is
  for the case where the resolver mixes synthetic and real answers. Invalid entries are
  dropped rather than refusing to load - this is a fallback, and a broken one degrades to
  "stay strict", not to a crash.
- `proxyUrl` - where fetches go out, e.g. `http://127.0.0.1:7890` or
  `socks5://127.0.0.1:7890`, optionally with `user:pass@`. **Empty means follow the
  environment.** It is a deployment-level capability and never enters a tool schema. The
  resolution order is spelled out under [Proxies](#proxies).
- `proxyBypass` - host names that should connect directly, mirroring `NO_PROXY`.

**Deployment-grade knobs** (not on the settings card; set them in the `config:` block of
`cordis.patch.yml`): `requestTimeoutSeconds`, `maxUrlLength`, `browserExecutablePath`,
`browserCdpUrl`, `searchEndpoint`, `searchRenderTopN`. The first two of the browser pair are
strong capabilities - one hands Chromium a file
to execute, the other hands the browser to a debugger endpoint - so they come only from
deployment config and are unreachable from model input.

> **Settings changes need a dsh restart.** The gate policy and the sidecar environment are
> snapshotted once when the plugin is applied; edits on the settings card take effect on the
> next start.

Disabling a tool also removes its system-prompt guidance, so the model is never told
about a capability that is not registered.

## Proxies

Where a fetch goes out, resolved in this order - **first hit wins**:

1. `proxyBypass` or the environment's `NO_PROXY` matches this host -> direct.
2. `proxyUrl` on the settings card is non-empty -> use it.
3. `http_proxy` / `https_proxy` / `all_proxy` in the environment (upper case works too) ->
   use the matching slot.
4. The operating system's proxy settings (`scutil --proxy` on macOS, Internet Settings on
   Windows) -> use them.
5. Neither -> direct.

Each rung exists because leaving it out loses a class of users. The settings card is
explicit intent; environment variables cover CI, ssh sessions and `docker exec`, where a
proxy is only ever `export`ed in the shell; the OS settings are what proxy clients default
to on macOS and Windows - flip "system proxy" on in Clash Verge or Surge and every browser
on the machine is proxied, while curl_cffi has no idea system settings exist.

An explicit `proxyUrl` makes the last two rungs irrelevant: an explicit setting should
outrank an implicit source, otherwise "I set 7890 and it still goes through 1080" has
nowhere to be debugged from. The bypass list cuts across everything above it - a hit
connects directly no matter where the proxy came from.

What that looks like in practice - **with or without a proxy, the tools just work, with no
setting to fill in**:

| Your setup | Static fetching | Render / stealth / XHR |
| --- | --- | --- |
| No proxy | direct | direct |
| TUN mode (system-wide) | direct, forwarded by the TUN | same |
| `HTTPS_PROXY` exported in the shell | follows it automatically | follows it automatically |
| macOS / Windows "system proxy" switch | **follows it automatically** | follows it automatically |
| Intranet targets / internal Git | exclude with `proxyBypass` | exclude with `proxyBypass` |
| PAC (auto-config script) | not followed; stderr says to set `proxyUrl` | followed natively by the browser |

PAC is the one shape that still needs a hand-filled setting: evaluating it means
downloading a script and running JavaScript, and the dialects differ per platform, so this
plugin does not guess. When it sees one it says so on stderr instead of quietly connecting
directly.

Details worth knowing:

- **A proxy and synthetic DNS are two different problems.** A fake-IP proxy resolves
  **every** domain into `198.18.0.0/15` (TUN clients often land in `100.64.0.0/10`);
  neither is a public unicast range, so the gate rejects every URL and turning a proxy on
  makes the plugin stop working. The plugin **detects** that class of resolver on its
  own: it resolves three control names unrelated to any target - `example.com`,
  `www.iana.org`, `www.wikipedia.org` - and if all of them land in one non-public pool
  while staying distinct, it treats the resolver as fake-IP and **learns that pool's
  boundary from the control answers**, allowing only addresses inside it.
  `syntheticDnsRanges` is the manual fallback for detection failures. When detection does
  not fire, the gate **stays strict**; an IP literal written into the URL is still judged
  strictly, so `http://169.254.169.254/` stays blocked either way.
- **Through a proxy, a host name this machine cannot resolve is no longer rejected.** The
  request never leaves this machine's network namespace, the proxy resolves the name, and
  a local resolver coming up empty says nothing - while on a network with DNS filtered by
  region, those are exactly the sites that need a proxy to be reachable at all. IP
  literals, private answers the local resolver *can* produce, and single-label host names
  (`intranet`, `router`) stay rejected.
- **WebRTC leaks are closed when proxied.** Chromium's WebRTC can send UDP around an
  HTTP/SOCKS proxy, so one STUN call in a page is enough to learn the visitor's real exit
  address. patchright gets `block_webrtc`; Playwright has no equivalent switch, so it goes
  in as a Chromium launch flag.
- **A browser session picks its proxy once, at `session_open`**, and the whole session
  shares it. The bypass list therefore does not apply per URL inside a browser session:
  Playwright's proxy lives on the BrowserContext, and switching it means a new context,
  which throws away the session's cookies and login state - precisely the reason a
  session exists. Static sessions have no such limit and decide per request.
- **Credentials never reach a log or the capability frame.** The capability report echoes
  `scheme://host:port` only, and its `source` field names which rung answered
  (`settings` / `environment` / `system` / `none`) - that column is the first thing to look
  at when someone reports that fetching does not work.
- **A malformed proxy address does not stop the plugin from loading.** A scheme outside
  `http` / `https` / `socks4` / `socks5` / `socks5h` is logged to stderr and treated as
  "not configured", rather than thrown out as a load failure.

## Render or static: how to choose

`scrapling_render` is much slower and heavier than `scrapling_fetch`, so start static.
Two criteria:

**If the result is shorter than the static fetch, go back to static.** Plenty of sites
ship readable text from the server (for search engines and no-JS users) and then have their
own script empty those containers and swap in canvas / Lottie animation - for those pages
rendering can only lose content, and `networkIdle`, `waitSelector`, `mainContentOnly` and
`headless` all fail to bring it back: in the rendered DOM those containers are simply empty.
That is site behaviour, not a plugin defect.

**`waitSelector` waits for an element to appear, not for content to settle.** The element
can be removed after it matched, so "the selector matched" does not mean that content is
in the result.

One thing that is not a criterion but worth knowing: axis ticks inside SVG **cannot be
fetched at all**. After Chromium renders, the markdown conversion emits no `<svg>` or
`<text>` nodes, so "the numbers on the chart" are out of reach whichever tool you use - the
copy on an example card is server-rendered and was already there statically, it is not a
rendering product. For actual values, go through `scrapling_capture_xhr` to locate the
JSON endpoint.

## Security notes

- **SSRF.** Scrapling itself has no SSRF protection. This plugin adds a URL policy on
  the host side (scheme allowlist, credential rejection, length cap, rejection of an
  authority containing a backslash or control characters, DNS resolution with a
  whole-answer-set public-address check, and IPv4-mapped / NAT64 addresses reclassified
  by their embedded IPv4) and enforces it again on the Python side. **What is judged is
  what gets sent**: the gate decides on the WHATWG-normalised form and the sidecar forwards
  that same normalised string, otherwise "judged A, connected to B" becomes a bypass in
  its own right. The browser-side guard is registered by the plugin's own code and covers
  navigation, subresources, XHR and WebSocket handshakes.

  Known gaps, all stated in the open:
  - **Connection pinning** (an undici-level technique) is unavailable for a non-Node
    transport, leaving a TOCTOU window between validation and connect. Static fetches are
    covered by curl_cffi's `follow_redirects="safe"`; browser fetches by a route handler
    on the Python side.
  - **NAT64 prefixes are not discovered dynamically.** dsh's built-in probes the active
    prefix via the `ipv4only.arpa` sentinel; this plugin covers the two standardized
    prefixes (`64:ff9b::/96`, `64:ff9b:1::/48`). Declare any operator-specific prefix via
    the `nat64Prefixes` setting, otherwise a private IPv4 hidden inside IPv6 is judged as
    an ordinary public IPv6. Conversely, a declared prefix applies to **every** IPv6
    address, not only the ones inside the RFC 6052 segment.
  - **No port allowlist** (any port allowed by default), matching dsh's own built-in
    fetch provider.
  - **`scrapling_crawl` re-checks addresses itself, but redirect targets still rest on
    domain consistency alone.** The start URL goes through `guard.url_allowed` (the same
    implementation the browser path uses, so both layers agree), the crawl session sets
    `follow_redirects="safe"` so curl_cffi refuses to follow a jump into a private range, and
    each page's final URL is re-checked before it enters the result set. Scrapling's
    `allow_domains`, though, is a string comparison that covers links found in the page and
    not redirect targets - so on that seam the host gate's start-URL check is still the only
    defence.
  - **WebSocket coverage depends on the Playwright version.** The guard intercepts
    handshakes via `route_web_socket`. Older builds lack that method, WebSocket is then
    outside the guard, and the plugin says so in the log and in the capability report
    rather than degrading silently.
  - **Browser binary path and CDP endpoint are deployment-grade capabilities.** They come
    only from deployment config and are unreachable from model input; pointing at them
    hands over "run this file" and "attach the browser to this debugger".

  The host-side policy is enforced by `SidecarClient.call`, so it covers every tool and
  the `web_fetch` provider alike; a rejection throws `URL_BLOCKED` before the request is
  written to the pipe.
- **Browser engines ignore proxy environment variables.** Playwright does not read
  `HTTP_PROXY` / `HTTPS_PROXY`, so `scrapling_render` / `scrapling_capture_xhr` /
  `scrapling_stealth_fetch` connect **directly** even when the rest of the system is
  routed through a proxy — a browser-bound request leaves the tunnel. curl_cffi (behind
  `scrapling_fetch` and the crawler) *does* honour those variables, so the two halves
  behave differently on a proxy-bound network. This is stated rather than papered over:
  routing the browser through a proxy means handing the plugin a deployment-grade
  capability, and shipping that without a way to check it against a live proxy would be
  worse than saying so. `allowSyntheticDns` above only fixes the *gate*; it does not
  change where traffic goes.
- **There are quotas; the resident resources are not unbounded.** At most 8 concurrent
  sessions (of which at most 3 may be `browser`/`stealth`, each a real Chromium process), at
  most 2 crawls in flight, per-page bodies clipped at `maxContentChars`, 8 MB per protocol
  frame, and 16 frames of pending queue. Hitting a ceiling yields a specific error code
  (`SESSION_LIMIT` / `CRAWL_BUSY` / `BAD_FRAME`) the model can back off from, rather than
  exhausting the machine.
- **No code execution from the model.** `page_action`, `page_setup`, `selector_config`,
  `proxy`, `executablePath` and `cdpUrl` are never exposed in any tool schema. The
  browser-side network guard is
  installed by plugin code, never by model input.
- **Prompt-injection scrubbing** runs unconditionally on returned content; there is no
  model-facing switch to turn it off.

## Development

```sh
pnpm install          # install dependencies
pnpm run check        # typecheck + lint + build + test + format check
pnpm run build        # bundles host.ts / src/client-entry.ts into host.js / client.js
pnpm run test:py      # end-to-end check of the Python sidecar (needs _env/.venv)
```

Sources are all TypeScript. `host.js` and `client.js` are **build artifacts** and are
deliberately `.js`: Node refuses to strip types for packages inside `node_modules`,
which is exactly where dsh loads the plugin from.

The artifact is **ESM-only**: `require()` will not get you the plugin. That is deliberate
(the host loads it by package name), not a defect.

At build time every package declared in `dependencies`, `peerDependencies` **or**
`devDependencies` is externalised. The ones the host provides at runtime (cordis,
dsh-tools, dsh-subprocess, dsh-jobs) must not be inlined: the bundle would otherwise
carry its own private copy, splitting module-level state, and for packages that resolve
their own `package.json` relative to `import.meta.url` it would fail to load outright with
`MODULE_NOT_FOUND`. `test/publish-manifest.test.ts` imports the built artifact and asserts
that no host package body is inlined, so both halves stay pinned.

Publishing runs through [`.github/workflows/publish.yml`](./.github/workflows/publish.yml)
(manual, OIDC trusted publishing plus `--provenance`).

## License

MIT — see [`LICENSE`](./LICENSE). Where this package stops and third-party code begins:
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
