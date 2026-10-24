# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。最新版本在最上。

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
