// dsh-scrapling/test/contract-scrapling.test.ts —— 用**真实 Scrapling**核对适配器发出的每个关键字。
//
// 为什么需要这一层，而不是再多几条单元测试：本仓其余用例断言的是「我们自己认为契约是什么」。
// 全绿只证明自洽，证明不了与上游对得上——而真实故障形态恰好是**静默失效**：Scrapling 的会话在
// fetch 层只认 `_fetch_params` 的那十几个字段，其余键**丢弃且不报错**（见
// `scrapling/engines/_browsers/_validators.py` 的 `validate_fetch`）。于是「设置卡拧了旋钮、
// 行为没变、日志一个字都没有」。单元测试再怎么加密也撞不到这条缝，因为判据不在我们手里。
//
// 这里的判据全从上游取：`py/tests/contract_probe.py` 把引擎换成记录器、驱动 adapters 的
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

/** 会话开场两侧都要点到的站点名。 */
const SESSION_OPEN_SITES = ["session.open.static", "session.open.stealth"];

describe("上游 Scrapling 契约：适配器发出的关键字必须被上游读到", () => {
  it("探针确实驱动了全部引擎调用点（驱动退化就是真空通过）", () => {
    const sites = report.calls.map((call) => call.site).toSorted();
    // 0.5 只剩 patchright 一套浏览器，所以「一次性浏览器抓取」与「浏览器的两类会话」各有自己的
    // 站点名（browser.render / session.*.stealth）；原先那一组 browser.stealth 与 browser 会话
    // 的点位已随旧后端一起消失。
    for (const wanted of [
      "static.get",
      "static.post",
      "browser.render",
      "capture.open",
      "capture.fetch",
      "session.open.static",
      "session.open.stealth",
      "session.fetch.static",
      "session.fetch.stealth",
    ]) {
      expect(sites, `调用点 ${wanted} 没被驱动`).toContain(wanted);
    }
    // 键数按「不低于某个下限」钉，而不是写死等号：驱动退化（漏了一个调用点、少填了一批参数）
    // 会掉破下限，而某天上游多认一个键不该让这里变红。
    // capture.fetch 与 session.fetch.stealth 从 11 掉到 9：那两个默认键（blocked_domains /
    // disable_resources）不再被无条件预置——调用方没显式给就整条不发，否则等于替调用方
    // 覆盖上游默认（两键都在 FETCH_LEVEL_KEYS 里，所以两条会话路径各掉两格）。下限跟着
    // 实测值走；若真有驱动退化，掉破的仍是这一条。
    const FLOORS: Record<string, number> = {
      "browser.render": 20,
      "capture.open": 10,
      "capture.fetch": 9,
      "session.open.stealth": 10,
      "session.open.static": 2,
      "session.fetch.stealth": 9,
      "session.fetch.static": 4,
      "static.get": 4,
      "static.post": 4,
    };
    for (const [site, floor] of Object.entries(FLOORS)) {
      expect(report.checked[site], `${site} 抓到的键太少`).toBeGreaterThanOrEqual(floor);
    }
    // 会话 fetch 那两处反过来只能落在 fetch 层的字段面里：涨过上限就是有人又把构造期才生效的
    // 设置往 fetch 层塞（`silentAtSessionFetch` 抓的是同一类漂移，这里先给一道量级闸）。
    const CEILINGS: Record<string, number> = {
      "session.fetch.static": 6,
      "session.fetch.stealth": 14,
    };
    for (const [site, ceiling] of Object.entries(CEILINGS)) {
      expect(report.checked[site], `${site} 又混进了会话级键`).toBeLessThanOrEqual(ceiling);
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
    // 构造期读、之后每次 fetch 再传会被 `validate_fetch` 丢掉的键，必须出现在开场那一帧上，
    // 否则「设置卡拧了旋钮、行为没变、日志一个字都没有」。static 与 stealth 两类会话读的不是
    // 同一组：static 只剩 impersonate / timeout，身份、区域与反检测那一整组只落在浏览器
    // （stealth）那一侧。
    const open = indexKeys(report.calls.filter((call) => call.site.startsWith("session.open.")));
    for (const site of SESSION_OPEN_SITES) {
      expect(open.get(site), `${site} 没被记录`).toBeDefined();
    }
    const WANTED: Record<string, string[]> = {
      "session.open.static": ["impersonate", "timeout"],
      "session.open.stealth": [
        "headless",
        "timeout",
        "block_ads",
        "executable_path",
        "cdp_url",
        "locale",
        "timezone_id",
        "useragent",
        // 下面三条是**只有构造期才认**的反检测启动 flag：漏了就是「代理已开但 WebRTC
        // 仍泄露真实出口 IP」那一类静默失败。
        //
        // `solve_cloudflare` **不在**这一组：它是 fetch 层认得的键，逐次 fetch 传也生效，
        // 所以上游把它挡在会话构造参数之外（见 py/adapters.py 的 SESSION_ONLY_KEYS）。
        "hide_canvas",
        "block_webrtc",
        "allow_webgl",
      ],
    };
    for (const [site, wanted] of Object.entries(WANTED)) {
      const keys = open.get(site);
      for (const key of wanted) {
        expect(keys?.has(key), `${site} 缺 ${key}`).toBe(true);
      }
    }
  });

  it("stealth 路径的三条不变量都成立（不发 extra_flags、走代理时 block_webrtc 为真、参数仍在）", () => {
    // 0.5 把 `config.extra_flags` 从「顶掉上游那套反检测 flag」改成「叠加到它们之上」，于是旧
    // 前提（传了 extra_flags 整套 stealth 就没了）作废。取而代之的是三条：本仓任何路径都**不发**
    // extra_flags；走代理时 `block_webrtc` 为真（WebRTC 防泄露改由这条开关承担）；那套 flag 仍
    // 出现在最终启动参数里。探针把这三条合成 stealthInvariants —— 它对着实际发出的 kwargs 判，
    // 而不是对着某个开关的默认值判。
    expect(report.stealthInvariants).toStrictEqual([]);
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
    // 0.5 给签名加了一个 `_log` 形参（排在第一个），所以期望的第一项是它，其余保持原样。
    expect(facts.responseInitParams).toStrictEqual([
      "_log",
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

  it("上游 Spider 基类默认仍是不遵守 robots.txt、不限速、且只抓正文", () => {
    // README 明写「does not obey robots.txt, per-domain delay is 0, up to 4 concurrent」。
    // 那条声明靠上游默认值成立——默认值一变，README 就变成错的文档。
    expect(facts.spiderDefaults.robots_txt_obey).toBe(false);
    expect(facts.spiderDefaults.autothrottle_enabled).toBe(false);
    expect(facts.spiderDefaults.download_delay).toBe(0);
    expect(facts.spiderDefaults.concurrent_requests).toBe(4);
    // 0.5 起多了一项：默认就只要正文（`main_content_only`），爬虫的每页结果因此也走正文口径。
    expect(facts.spiderDefaults.main_content_only).toBe(true);
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
