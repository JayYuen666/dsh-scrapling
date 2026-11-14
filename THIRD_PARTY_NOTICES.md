# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**与第三方的边界**：
哪一部分来自第三方、在什么意义上「来自」，以及本包自身代码与第三方代码的分界在哪里。

## 结论：随包分发的第三方内容有两处

`py/`、`lib/`、`host.ts`、`src/` 下全部是本仓原创代码，不含任何第三方源码、词表或文案。
Scrapling 及浏览器引擎都是**运行期依赖**——本包调用它们暴露的接口，其中反注入清洗用的
`Convertor._strip_noise_tags` 与 `Convertor._sanitize_for_ai` 是上游的私有下划线方法，不在上游文档
里（见「机制与接口来源」）。它们不由本包分发，许可文本也随各自的包走，本文件不重复。

随包分发的第三方内容有两处：**图标**（`icon.svg`，Scrapling 官方标记，BSD 3-Clause）与
**CLI 单文件产物内联的 zod**（`bin/dsh-scrapling.mjs`，MIT）。本包在下方保留各自的版权与
许可声明。

## 图标：Scrapling 官方标记

- 上游项目：`Scrapling`
- 上游仓库：https://github.com/D4Vinci/Scrapling
- 上游资源：https://scrapling.readthedocs.io/zh-cn/latest/assets/logo.png（486×480 PNG，带 alpha）
- 上游许可：BSD 3-Clause，Copyright (c) 2024 Karim shoair

`icon.svg` 的图形**全部来自这张官方标记**：形状与 alpha 通道逐像素同源，没有重新绘制的部分。
本包只做了一件渲染期的事——把官方图拆成「本体」与「高光」两张遮罩分别上色：本体取
`currentColor`（跟随 DSH 导航行的前景色，深色主题为浅色、浅色主题为深色），高光保留官方绿
（`#B3FB2A`，取自官方图的眼睛与吸盘）。这样两种主题下都与官方标记一致，而形状本身一个像素
都没改。同一份遮罩字节也内联在 `client.js` 里，作为设置页导航图标的 `mask-image`。

BSD 3-Clause 允许再分发与修改，唯一的实质义务是保留版权声明与本许可条件——也就是这一节。
以下是许可正文：

```text
BSD 3-Clause License

Copyright (c) 2024, Karim shoair
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## CLI 单文件产物内联的 zod

- 上游项目：`zod`
- 上游仓库：https://github.com/colinhacks/zod
- 上游许可：MIT，Copyright (c) 2020 Colin McDonnell
- 版本：伞根 catalog 4.6.7（`package.json` 写作 `catalog:`）

`bin/dsh-scrapling.mjs` 由 `build-cli.ts` 用 rolldown 打成单文件、只外置 `node:` 内置模块，
因此 zod 的实现被内联进该产物；host 侧的 `client.js` 按宿主 `PLATFORM_MODULES` 外置 zod。
所以 zod 既是运行期依赖，也是 CLI 产物里的一份第三方代码，此处保留其版权与许可声明。

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
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | `lib/mcp-server.ts` 的 MCP server 实现 |
| `ipaddr.js` | 2.5.0 | MIT | Host 侧 URL 策略的地址分类 |
| `fs-native-extensions` | 1.5.3 | Apache-2.0 | `lib/installer.ts` 的安装锁：OS 级 `flock`/`LockFileEx` 互斥，进程退出自动释放 |
| `zod` | catalog（伞根 4.6.7） | MIT | Host 侧 `lib/runtime.ts` / `lib/sidecar.ts` 的形状校验走本包 dependencies 里的 zod；设置卡 `src/runtime-reader.ts`、`src/settings-card.ts` 的 strict codec 由宿主 `PLATFORM_MODULES` 提供；CLI 单文件产物内联 |

其余随 venv 安装的固定版本（含 `click`、`protego`、`curl_cffi`、`lxml` 等）见
`py/runtime-requirements.txt`，每一行都带 SHA256；本文件不复述整张表。

## 运行时下载的资产（不随 npm 分发）

安装器按需下载下面两项到 `dataDir/runtime`，它们**不在 npm tarball 内**，因此不属于本包
分发的第三方内容。这条下载路径只在 macOS arm64 上走到：`lib/installer.ts` 的
`installCapabilityPack` 先判平台，其余平台在任何下载之前抛 `INSTALL_PACK_BLOCKED`；
`runtime-manifest.json` 也只收录 `darwinArm64` 一份资产，另列出不支持的三种平台。

- **Python 3.14.9**：来自 `astral-sh/python-build-standalone` 的
  `cpython-3.14.9+20261021-aarch64-apple-darwin-install_only.tar.gz`；URL、体积与 SHA256
  钉在 `runtime-manifest.json`，下载后先校验再解压。
- **完整 Chromium**：由 `patchright install chromium` 从 Playwright 的 CDN 下载；不含
  `--only-shell`，因为 headless shell 的组件不足以跑 `StealthyFetcher`（V2）。

许可文本随这两个上游产物各自提供；本包只负责下载、校验与写到磁盘。

`patchright` 是 Playwright 的补丁分支，与 `playwright` 并存安装：两者是不同的 Python 包，
本包按能力探测判断浏览器抓取能不能用。

dsh 宿主族包里本仓声明为 peer 的只有 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-output-retention`、
`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-web` 与
`@deepseek-ai/schemastery`，由宿主提供、不随本包分发。产物里运行期 import 到的是除
`@deepseek-ai/dsh` 之外的那五个（`host.js`），`client.js` 只外置 `react` 与 `zod`。其余
`@deepseek-ai/*` 是本仓 devDependencies，只用于类型检查与客户端构建，产物里没有对它们的运行期 import。