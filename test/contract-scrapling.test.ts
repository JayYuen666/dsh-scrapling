// dsh-scrapling/test/contract-scrapling.test.ts —— 用**真实 Scrapling**核对适配器发出的每个关键字。
//
// 为什么需要这一层，而不是再多几条单元测试：本仓其余用例断言的是「我们自己认为契约是什么」。
// 全绿只证明自洽，证明不了与上游对得上——而真实故障形态恰好是**静默失效**：Scrapling 的会话在
// fetch 层只认 `_fetch_params` 的那十几个字段，其余键**丢弃且不报错**（见
// `scrapling/engines/_browsers/_validators.py` 的 `validate_fetch`）。于是「设置卡拧了旋钮、
// 行为没变、日志一个字都没有」。单元测试再怎么加密也撞不到这条缝，因为判据不在我们手里。
//
// 这里的判据全从上游取：`py/tests/contract_probe.py` 把三套引擎换成记录器、驱动 adapters 的
// 真实代码路径，抓下每个调用点实际发出的 kwargs，再拿上游的 TypedDict 与 `_fetch_params` 字段
// 逐一对照。本文件只负责跑探针、把结论变成断言。
//
// 两组断言各管一件事：
// 1. **合法性**（`violations`）：键必须存在于该调用点对应的参数面里。不合法会抛 TypeError，
//    表现为「FETCH_FAILED: Invalid argument type」——用户看到的是抓取失败。
// 2. **有效性**（`silentAtSessionFetch`）：键必须**真被这次调用读到**。不有效不抛任何错，
//    表现为功能静默不存在——这是更贵的一类 bug，所以单独钉一条。
//
// 第三条门禁钉的是探针自己：驱动退化（漏了一个调用点、少填了一批参数）会让上面两组断言
// 同时变成真空通过。所以下面要求探针确实覆盖到每个站点、且键的量在对的数量级上。

import { describe, expect, it } from "vitest";
import { runProbe } from "./probe.ts";
import type { ProbeCall, ProbeReport } from "./probe.ts";

/** 站点名到键集合的索引，便于逐键断言。 */
type KeyIndex = Map<string, Set<string>>;

/**
 * 把探针的 calls 列表索引成 `站点 -> 键集合`。
 *
 * @param calls - 探针记录
 * @returns 索引
 */
function indexKeys(calls: ProbeCall[]): KeyIndex {
  const out: KeyIndex = new Map();
  for (const call of calls) {
    out.set(call.site, new Set(call.keys));
  }
  return out;
}

// 一次探针跑全程共用：两次都要拉起解释器、import scrapling 并真造会话，而两拨读到的
// 必须是同一份上游状态 —— 分两次跑，中途装/换了什么就会让两组断言互相矛盾。
const report: ProbeReport = await runProbe();

/** 会话开场与会话抓取两侧都要点到的站点名。 */
const SESSION_OPEN_SITES = ["session.open.browser", "session.open.stealth"];

describe("上游 Scrapling 契约：适配器发出的关键字必须被上游读到", () => {
  it("探针确实驱动了全部引擎调用点（驱动退化就是真空通过）", () => {
    const sites = report.calls.map((call) => call.site).toSorted();
    for (const wanted of [
      "static.get",
      "static.post",
      "browser.render",
      "browser.stealth",
      "session.open.static",
      ...SESSION_OPEN_SITES,
      "session.fetch.static",
      "session.fetch.browser",
      "session.fetch.stealth",
    ]) {
      expect(sites, `调用点 ${wanted} 没被驱动`).toContain(wanted);
    }
    // 一次性抓取那两个站点必须把会话级参数面点亮（_browser_params 读到的键全在）；
    // 会话 fetch 那两个反过来**只能**有 fetch 层认得的键 —— 数量掉到 9 才是修好了，
    // 涨回 17 说明有人又把会话级设置往 fetch 层塞。
    for (const site of ["browser.render", "browser.stealth"]) {
      expect(report.checked[site], `${site} 抓到的键太少`).toBeGreaterThanOrEqual(15);
    }
    for (const site of ["session.fetch.browser", "session.fetch.stealth"]) {
      expect(report.checked[site], `${site} 抓到的键太少`).toBeGreaterThanOrEqual(8);
      expect(report.checked[site], `${site} 又混进了会话级键`).toBeLessThanOrEqual(12);
    }
  });

  it("每个键都在上游对应的参数面里（不合法会抛 TypeError）", () => {
    expect(report.violations).toStrictEqual([]);
  });

  it("会话抓取发出的每个键都真被这次 fetch 读到（不接受静默丢弃）", () => {
    // 失败时把「哪些键、在哪个站点、本可以在哪一层生效」原样摊出来：这一类 bug 的
    // 排查成本全在「看不出来它没生效」上。
    expect(report.silentAtSessionFetch).toStrictEqual([]);
  });

  it("本仓声明的 fetch 层键集与上游实际字段不漂移", () => {
    // adapters.FETCH_LEVEL_KEYS 是本仓手抄的一份上游字段表：上游加了字段而我们没跟，
    // 就是白扔一个能生效的设置；我们多写了上游不认的键，就是又造一个静默丢弃。
    expect(report.fetchLevelKeysDrift).toStrictEqual([]);
  });

  it("会话开场把只有开场才生效的那些设置带上（fetch 层传了也没用）", () => {
    // capture_xhr / block_ads / executable_path / cdp_url / locale / timezone_id /
    // useragent / headless 只在 DynamicSession(...) / StealthySession(...) 的构造期被读。
    // 探针的入参把这些全点亮了，所以开场记录里必须都出现——缺一个就是「用户拧了旋钮没反应」。
    const open = indexKeys(report.calls.filter((call) => call.site.startsWith("session.open.")));
    const wanted = [
      "headless",
      "timeout",
      "capture_xhr",
      "block_ads",
      "executable_path",
      "cdp_url",
      "locale",
      "timezone_id",
      "useragent",
    ];
    for (const site of SESSION_OPEN_SITES) {
      const keys = open.get(site);
      expect(keys, `${site} 没被记录`).toBeDefined();
      for (const key of wanted) {
        expect(keys!.has(key), `${site} 缺 ${key}`).toBe(true);
      }
    }
    // stealth 的 WebRTC/WebGL/canvas 是启动 flag，只在开场生效：漏了就是「代理已开但
    // WebRTC 仍泄露真实出口 IP」那一类静默失败。
    for (const key of ["solve_cloudflare", "hide_canvas", "block_webrtc", "allow_webgl"]) {
      expect(open.get("session.open.stealth")!.has(key), `session.open.stealth 缺 ${key}`).toBe(
        true,
      );
    }
  });

  it("配了代理时 stealth 的整套反检测启动参数必须还在", () => {
    // 探针全程假定部署配了代理，因为那条路径才是坑：_browser_params 与 _make_session 在
    // 有代理时塞一条 extra_flags，而上游 `_base.py` 算 flag 时 `config.extra_flags`
    // **优先于**内部递进来的 53 条 STEALTH_ARGS —— 传了就是整段替换。后果是「stealth 抓取
    // 在有代理的机器上静默退化成普通 Chromium」，连 block_webrtc 自己那两条 flag 也没了。
    // 这条断言不看我们传了什么，它拿传出去的参数真造一次会话、读上游最终下发的 flag。
    expect(report.stealthArgsDowngraded).toStrictEqual([]);
  });

  it("反检测启动参数的条数至少是默认那一组加整套", () => {
    // block_webrtc / hide_canvas / allow_webgl=false 各自还会再加几条，所以是「至少」。
    // 「整套反检测有没有被冲掉」由上一条断言逐条比对负责，这里只钉量级。
    expect(report.facts.stealthArgsTotal).toBeGreaterThanOrEqual(40);
    expect(report.facts.stealthArgCount).toBeGreaterThanOrEqual(
      report.facts.defaultArgsTotal + report.facts.stealthArgsTotal,
    );
  });
});

describe("上游事实钉桩：本仓代码直接依赖的形状", () => {
  const { facts } = report;

  it("静态 Fetcher 只有四个动词，没有 fetch()", () => {
    // adapters 用 getattr(Fetcher, method.lower()) 分发；上游哪天加个 fetch，
    // 「method: fetch」就会从 BAD_ARGS 变成一条看不懂的成功路径。
    expect(facts.fetcherVerbs).toStrictEqual(["delete", "get", "post", "put"]);
  });

  it("自愈选择器的开关还是那四个参数", () => {
    // select() 只传 adaptive/auto_save，靠 identifier 默认取选择器本身：identifier 一旦
    // 变成必填，自愈就静默失效。
    expect(facts.selectorCssParams).toStrictEqual([
      "self",
      "selector",
      "identifier",
      "adaptive",
      "auto_save",
      "percentage",
    ]);
    expect(facts.selectorCssDefaultPercentage).toBe(40);
  });

  it("markdown 的清洗仍走那两个私有函数", () => {
    // _sanitized_page 直接调 Convertor 的私有面。上游改名不会通知本包。
    expect(facts.convertorPrivates).toStrictEqual([
      "_strip_noise_tags",
      "_sanitize_for_ai",
      "_extract_content",
      "_convert_to_markdown",
    ]);
    expect(facts.responseMarkdownParams).toStrictEqual([
      "self",
      "css_selector",
      "main_content_only",
    ]);
  });

  it("回包构造器仍收本仓 _fake_response 传的那几个键", () => {
    expect(facts.responseInitParams).toStrictEqual([
      "content",
      "cookies",
      "encoding",
      "headers",
      "history",
      "meta",
      "method",
      "reason",
      "request_headers",
      "status",
      "url",
    ]);
  });

  it("adaptive 存储仍只认 storage_file 与 url 两个键", () => {
    // storage_args 是**整体替换**而不是补齐：键名一变，指纹就全落进 default 桶，
    // 跨站点共用一份库还不报错。
    expect(facts.storageInitParams).toStrictEqual(["storage_file", "url"]);
  });

  it("上游 Spider 基类默认仍是不遵守 robots.txt、不限速", () => {
    // README 明写「does not obey robots.txt, per-domain delay is 0, up to 4 concurrent」。
    // 那条声明靠上游默认值成立——默认值一变，README 就变成错的文档。
    expect(facts.spiderDefaults.robots_txt_obey).toBe(false);
    expect(facts.spiderDefaults.autothrottle_enabled).toBe(false);
    expect(facts.spiderDefaults.download_delay).toBe(0);
    expect(facts.spiderDefaults.concurrent_requests).toBe(4);
    expect(facts.spiderDefaults.max_pages).toBe(0);
    expect(facts.spiderDefaults.output_dir).toBeNull();
  });

  it("爬虫子类依赖的类属性与钩子都还在", () => {
    expect(facts.spiderAttrs).toStrictEqual([
      "allowed_domains",
      "max_pages",
      "name",
      "output_dir",
      "start_urls",
    ]);
    expect(facts.crawlHooks).toStrictEqual([
      "configure_sessions",
      "on_scraped_item",
      "parse",
      "pause",
      "rules",
      "start",
    ]);
  });

  it("反注入清洗丢掉的标签集合与上游实测一致", () => {
    // _sanitized_page 复用上游私有函数，注释里写着「script、display:none、aria-hidden、
    // template、noscript」；svg 也在被丢之列，而 iframe **不在**（text 路径另用 ignore_tags
    // 兜）。判据来自实测而不是注释：注释会腐，实测结果不会。
    expect(facts.noiseTagsActuallyStripped).toStrictEqual(["noscript", "script", "style", "svg"]);
  });

  it("会话管理 add 的签名仍让「第一个加的」当默认会话", () => {
    // crawl.configure_sessions 只 add 一个 "default" 而不传 default=True，靠的就是这一点。
    expect(facts.sessionManagerAddParams).toStrictEqual([
      "default",
      "lazy",
      "self",
      "session",
      "session_id",
    ]);
  });
});
