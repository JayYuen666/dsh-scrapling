# Scrapling web scraping

Fetches and extracts web pages — JavaScript rendering, CSS/XPath extraction with self-healing selectors, sessions with login state, a background crawler and page question-answering — all served by one resident Python process.

## What the card changes

Fifty card values grouped by purpose; most are read per call, so a change applies on the next tool call without restarting the host. `pythonBin`, `failFastOnMissingPython` and `dataDir` are applied when the plugin loads, so changing them needs a restart.

- **Runtime** — `pythonBin` (empty) chooses the interpreter: an explicit path wins, then the managed capability install, then this package's development venv, then `python3` on PATH. The plugin logs which one it picked every time. `failFastOnMissingPython` (on) refuses to load when the sidecar cannot start; an interpreter that starts but lacks Scrapling always degrades to "tools unavailable" and names the path. `dataDir` is where the sidecar's state lives.
- **Tool switches** — fifteen of them (fetch, extract, locate, links, render, capture XHR, network history, session, session state, crawl, answer, session read, session actions, download, screenshot). Turning one off removes that tool from the model's view, and the guidance text for it disappears too.
- **Extraction and output** — `extractionType` (markdown/html/text), `mainContentOnly`, and the per-tool output budgets (`fetchMaxOutputChars` and friends, default 200000) which are UTF-8 byte budgets enforced on both sides.
- **Browser** — `headless` (on), `networkIdle` (off), `blockAds` (on, about 3500 domains), `pierceShadow` (off), `waitSelectorState`.
- **Timeouts and recycling** — `fetchTimeoutMs` (120000), `sidecarHandshakeTimeoutMs` (30000), `sidecarGraceMs` (5000).
- **Network and safety** — `proxyUrl` (shown masked), `proxyBypass`, `allowedHosts`, `syntheticDnsRanges`, `nat64Prefixes`, plus the search backends (`searchBackend`, per-vendor API keys, `searxngEndpoint`, `searchPublicFallback` off by default).
- **Page question-answering** — `answerProvider`, `answerModel`, `answerMaxTokens` (2000).

## Some card switches need a second switch

`provideWebFetch` and `provideWebSearch` on the card are not enough by themselves: the deployment side must also select this plugin as the host's fetch and search provider. The same pairing applies to session actions, downloads and session state. A card switch alone will look like it does nothing.

## Thirty deployment values stay off the card

They change how the plugin is wired, not what a session decides, and each takes effect only on restart. The ones you are most likely to meet:

- `integrationMode` — `native` registers the tools with the host; `mcp` serves the same tool table over MCP instead; `official-mcp` does neither and only carries the upstream server's entry. The three are mutually exclusive and are read once at assembly, so switching means restarting.
- `mcpPort` (default 39217) must equal the URL in the profile's MCP-client entry; after changing it, re-run the plugin's `setup` — its `doctor` check compares the two.
- `officialMcpEnabled` (off) needs both this switch and the `setup` `--accept-risk` flag before any entry is generated, because the upstream server exposes actions this plugin's guard does not see.
- `allowWriteMethods` (off) — reading pages is this plugin's job; changing remote state is not, so that is a deployment statement.
- Also here: browser binary and CDP endpoint, real-Chrome and DNS-over-HTTPS options, Redis URL and adaptive storage, the crawler's runtime/robots/delay/concurrency/strategy/checkpoint settings, and the search endpoints.

Write them in the `config:` block of this plugin's row in `cordis.patch.yml`.

## What it needs from outside

Python and the Scrapling library are yours to provide: the plugin never installs them into your system interpreter. Chromium comes from `python -m patchright install chromium`. Capability packs are installed as host jobs in layers — `core`, `browser`, `search`, `media`, `adaptive-redis`, `mcp` — and the plugin is usable with only `core`, which is why the tool surface can be partial. If the interpreter you fall back to has no Scrapling, the tool list is empty and the guidance names the exact `pip install` command; that is a prerequisite statement, not a packaging defect. Search backends need their own API key or a SearXNG instance. `adaptiveStorage: redis` needs a reachable Redis.

Failures are named, not hidden: `SIDECAR_*`, `INSTALL_*`, `SEARCH_AUTH`, `JOBS_UNAVAILABLE`, `SESSION_STATE_DISABLED`, `MCP_PORT_IN_USE` / `MCP_PORT_MISMATCH` / `MCP_MODE_CONFLICT` / `MCP_CLIENT_MISSING`, `OFFICIAL_MCP_DISABLED`, `RISK_NOT_ACCEPTED`. An MCP token is read from `DSH_SCRAPLING_MCP_TOKEN` in the host's environment only — never from the profile file, which is plain text.

## Further detail

The sidecar protocol, capability-pack installer internals, offline assets and the security model are in the package README (`README.md` / `README.zh-CN.md`).
