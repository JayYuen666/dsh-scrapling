# Scrapling web scraping

Fetches and extracts web pages — JavaScript rendering, CSS/XPath extraction with self-healing selectors, sessions with login state, a background crawler and page question-answering — all served by one resident Python process.

## What the card changes

Fifty card values grouped by purpose; most are read per call, so a change applies on the next tool call. The values read once when the plugin is assembled need it assembled again — restart the host. That set is: the fifteen tool switches, `provideWebFetch` / `provideWebSearch` together with everything the search provider snapshots alongside them (`searchBackend`, the per-vendor keys, `searxngEndpoint`, `fetchMaxOutputChars`, `fetchTimeoutMs`), plus `pythonBin`, `failFastOnMissingPython` and `dataDir`.

- **Runtime** — `pythonBin` (empty) chooses the interpreter: an explicit path wins, then the managed capability install, then this package's development venv, then `python3` on PATH (`python` on Windows). The managed leg is only tried on macOS arm64 — the one platform with a verified capability pack — and every other platform goes straight from the explicit path to the venv and PATH legs. The plugin logs which one it picked every time. `failFastOnMissingPython` (on) refuses to load when the sidecar cannot start; an interpreter that starts but lacks Scrapling always degrades to "tools unavailable" and names the path. `dataDir` is where the sidecar's state lives.
- **Tool switches** — fifteen of them (fetch, extract, locate, links, render, capture XHR, network history, session, session state, crawl, answer, session read, session actions, download, screenshot). Turning one off removes that tool from the model's view, and its guidance line disappears from the skill body too; what stays resident in the system prompt is one cross-tool selection summary (naming no specific tool), while the full text is recomputed at composition time against the tools actually registered and registered as the virtual skill `scrapling`.
- **Extraction and output** — `extractionType` (markdown/html/text), `mainContentOnly`, `stripInlineImages` (on) and the per-tool output budgets: `fetchMaxOutputChars`, `extractMaxOutputChars` and `renderMaxOutputChars` default to 200000, `xhrMaxOutputChars` to 120000. The host trims that number as UTF-8 **bytes**; the same number goes to the sidecar as `maxContentChars`, which clips by **characters** — so the tighter of the two is what you see. `crawlMaxItems` (1000) caps pages, not output size.
- **Browser** — `headless` (on), `networkIdle` (off), `blockAds` (on, about 3500 domains), `pierceShadow` (off), `waitSelectorState`.
- **Timeouts and recycling** — `fetchTimeoutMs` (120000), `sidecarHandshakeTimeoutMs` (30000), `sidecarGraceMs` (5000).
- **Network and safety** — `proxyUrl` (shown masked), `proxyBypass`, `allowedHosts`, `syntheticDnsRanges`, `nat64Prefixes`, plus the search backends (`searchBackend`, per-vendor API keys, `searxngEndpoint`, `searchPublicFallback` off by default).
- **Page question-answering** — `answerProvider`, `answerModel`, `answerMaxTokens` (2000).

## Some card switches need a second switch

`provideWebFetch` and `provideWebSearch` on the card are not enough by themselves: the deployment side must also select this plugin as the host's fetch and search provider. The same pairing applies to session actions (`allowBrowserActions`), downloads (`allowFileDownloads`, with `downloadMaxBytes` sizing a single file) and login state (`sessionStateDir` — while it is empty the save/load tools are not registered at all). A card switch alone will look like it does nothing.

## Twenty-nine deployment values stay off the card

They change how the plugin is wired, not what a session decides, and each takes effect only on restart. The ones you are most likely to meet:

- `integrationMode` — `native` registers the tools with the host; `mcp` serves the same tool table over MCP instead; `official-mcp` does neither: on a host exposing `mcpManager` it registers the upstream server dynamically, and otherwise it only carries the upstream server's `dsh-mcp-client` entry. The three are mutually exclusive and are read once at assembly, so switching means restarting.
- `mcpPort` (default 39217) must equal the URL in the profile's MCP-client entry. Neither command reads `mcpPort`, so pass it yourself: `setup --mode mcp --port <mcpPort>` and `doctor --mode mcp --port <mcpPort>`. Without `--port`, setup writes the default 39217 and doctor has no expected port to compare against — a profile left on another port then passes silently.
- `officialMcpEnabled` (off) needs both this switch and the `setup` `--accept-risk` flag before any entry is generated, because the upstream server exposes actions this plugin's guard does not see.
- `allowWriteMethods` (off) — reading pages is this plugin's job; changing remote state is not, so that is a deployment statement.
- Also here: browser binary path, real-Chrome and DNS-over-HTTPS options, Redis URL and adaptive storage, the crawler's runtime/robots/delay/concurrency/strategy/checkpoint settings, and the search endpoints.

Write them in the `config:` block of this plugin's row in `cordis.patch.yml`.

## What it needs from outside

Python and Scrapling come from one of two places: the `core` capability pack installs a managed CPython 3.14.9 with Scrapling 0.5 under `dataDir`, or you point `pythonBin` at an interpreter you built yourself — the plugin never installs into your system interpreter. Capability packs exist only on macOS arm64; on any other platform the pack actions refuse (`INSTALL_PACK_BLOCKED`) and the interpreter really is yours to provide. Chromium comes from `python -m patchright install chromium`. Packs are installed as host jobs in layers — `core`, `browser`, `search`, `media`, `adaptive-redis`, `mcp` — and the plugin is usable with only `core`, which is why the tool surface can be partial. When the chosen interpreter starts but has no Scrapling, the tool list is empty and the **load-time warning** names the exact `pip install` line (it is not part of the tool guidance text); that is a prerequisite statement, not a packaging defect. Search backends differ: Tavily, Brave and Serper need their own key, SearXNG needs an instance URL, while `bing` and `duckduckgo` are public endpoints that need no credential — and `auto` only reaches a public engine once `searchPublicFallback` is on. `adaptiveStorage: redis` needs a reachable Redis.

Failures are named, not hidden: `SIDECAR_*`, `INSTALL_*`, `SEARCH_AUTH`, `JOBS_UNAVAILABLE`, `SESSION_STATE_DISABLED`, `MCP_PORT_IN_USE` / `MCP_PORT_MISMATCH` / `MCP_MODE_CONFLICT` / `MCP_CLIENT_MISSING`, `OFFICIAL_MCP_DISABLED`, `RISK_NOT_ACCEPTED`. An MCP token is read from `DSH_SCRAPLING_MCP_TOKEN` in the host's environment only — never from the profile file, which is plain text.

## Further detail

The sidecar protocol, capability-pack installer internals, offline assets and the security model are in the package README (`README.md` / `README.zh-CN.md`).
