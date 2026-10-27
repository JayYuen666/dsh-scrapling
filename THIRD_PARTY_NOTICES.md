# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**与第三方的边界**：
哪一部分来自第三方、在什么意义上「来自」，以及本包自身代码与第三方代码的分界在哪里。

## 结论：随包分发的第三方内容只有一处

`py/`、`lib/`、`host.ts`、`src/` 下全部是本仓原创代码，不含任何第三方源码、词表或文案。
Scrapling 及浏览器引擎都是**运行期依赖**——本包通过它们的公开 API 调用它们，它们不由本包
分发，许可文本也随各自的包走，本文件不重复。

唯一随包分发的第三方内容是**图标**（`icon.svg`），见下节。它是一段路径数据，MIT 允许再分发，
且本包已在下方保留其版权与许可声明。

## 图标：Tabler Icons

- 上游项目：`Tabler Icons`
- 上游仓库：https://github.com/tabler/tabler-icons
- 上游许可：MIT，Copyright (c) Paweł Kuna
- 取用图标：`spider`
- 来源：https://icones.js.org/icons/tabler/spider

`icon.svg` 中的形状路径取自该图标的 `spider`。改动仅有两处，都不涉及形状本身：把
`currentColor` 换成本包插件图标配色（`#658EFF` 主色 + `#54ECE7` 底衬），以及把外层 `<g>` 与
画布尺寸对齐本族插件统一的 `36×36` / `viewBox 0 0 24 24` 规格。路径数据未作改动。

## 机制与接口来源：Scrapling

- 上游项目：`Scrapling`
- 上游仓库：https://github.com/D4Vinci/Scrapling
- 上游许可：BSD 3-Clause，Copyright (c) 2024 Karim Shoair
- 验证版本：0.5

本包**使用**而非**包含**以下接口：

| 接口 | 用途 |
| --- | --- |
| `Fetcher` / `StealthyFetcher` / `FetcherSession` / `StealthySession` / `Selector` / `Spider` / `SessionManager` | 各工具的抓取与抽取实现 |
| `Convertor._strip_noise_tags`、`Convertor._sanitize_for_ai` | 反注入清洗；`html` 路径的输出不再是字节级原始文档，代价在此 |

这些都不是稳定 API 面。README 把 Scrapling 版本上界钉在 `0.6` 之前，正是为了守住这一组接口：
装到范围外时守卫照常运行，但反注入清洗与爬虫链路可能不按文档描述工作。

## 运行期依赖

运行期依赖的许可由各自包随包分发，本包不重复其文本：

| 依赖 | 版本 | 许可 | 引入方 |
| --- | --- | --- | --- |
| `scrapling` | 0.5 | BSD-3-Clause | Python sidecar |
| `browserforge` | 1.2.4 | MIT | Scrapling 静态抓取的浏览器头生成 |
| `apify-fingerprint-datapoints` | 0.15.0 | Apache-2.0 | browserforge 的指纹数据 |
| `playwright` | 1.64.1 | Apache-2.0（Microsoft） | 网络守卫 |
| `patchright` | 1.64.2 | Apache-2.0（Microsoft，patch 由 Kaliiiiiiiiii-Vinyzu 提供） | 浏览器渲染与网络守卫 |
| `ipaddr.js` | 2.5.0 | MIT | Host 侧 URL 策略的地址分类 |

其余随 venv 安装的固定版本（含 `click`、`protego`、`curl_cffi`、`lxml` 等）见
`py/runtime-requirements.txt`，每一行都带 SHA256；本文件不复述整张表。

## 运行时下载的资产（不随 npm 分发）

安装器按需下载下面两项到 `dataDir/runtime`，它们**不在 npm tarball 内**，因此不属于本包
分发的第三方内容：

- **Python 3.14.9**：来自 `astral-sh/python-build-standalone` 的
  `cpython-3.14.9+20261021-aarch64-apple-darwin-install_only.tar.gz`；URL、体积与 SHA256
  钉在 `runtime-manifest.json`，下载后先校验再解压。
- **完整 Chromium**：由 `patchright install chromium` 从 Playwright 的 CDN 下载；不含
  `--only-shell`，因为 headless shell 的组件不足以跑 `StealthyFetcher`（V2）。

许可文本随这两个上游产物各自提供；本包只负责下载、校验与落盘。

`patchright` 是 Playwright 的补丁分支，与 `playwright` 并存安装：两者是不同的 Python 包，
本包按能力探测判断浏览器抓取能不能用。

dsh 宿主包（`@deepseek-ai/dsh` 及其子包）是 peer 依赖，由宿主提供、不随本包分发。