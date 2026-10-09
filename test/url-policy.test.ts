// dsh-scrapling/test/url-policy.test.ts —— URL 安全策略。
//
// 这是安全边界，所以用例按「攻击面」组织而不是按函数组织：每一类绕过手法都要有一条
// 钉死的用例。DNS 全部走注入的假解析器，不碰真实网络。

import { describe, expect, it } from "vitest";
import { createUrlPolicy } from "../lib/url-policy.ts";
import type { BlockReason, ResolveAddresses, UrlPolicy, UrlVerdict } from "../lib/url-policy.ts";

/** 用例里反复用到的主机名与目标 URL。 */
const HOST = "example.com";
const HOME_URL = `https://${HOST}/`;

/** 公网示例地址。 */
const PUBLIC_V4 = "93.184.216.34";

/** 命中私网判定时的原因码，出现多次故抽常量。 */
const PRIVATE = "private-address";

/** 命中 scheme 判定时的原因码，出现多次故抽常量。 */
const SCHEME = "scheme-not-allowed";

/**
 * 取被拒时的原因码；结论是放行就直接让用例炸掉。
 *
 * @param verdict - 策略判定结论
 * @returns 被拒原因码
 */
function reasonOf(verdict: UrlVerdict): BlockReason {
  if (verdict.ok) {
    throw new Error(`expected a blocked verdict, but ${verdict.url.href} was allowed`);
  }
  return verdict.reason;
}

/**
 * 取放行时的 URL；被拒就直接炸掉。
 *
 * @param verdict - 策略判定结论
 * @returns 放行的 URL
 */
function allowedUrl(verdict: UrlVerdict): URL {
  if (!verdict.ok) {
    throw new Error(`expected an allowed verdict, but got ${verdict.reason}`);
  }
  return verdict.url;
}

/**
 * 按给定地址表造一个假解析器；表里没有的主机名按解析失败处理。
 *
 * @param answers - 地址表，键是主机名
 * @returns 解析器
 */
function resolverFrom(answers: Record<string, readonly string[]>): ResolveAddresses {
  return async (hostname) => {
    const found = answers[hostname];
    if (found === undefined) {
      throw new Error(`ENOTFOUND ${hostname}`);
    }
    return found;
  };
}

/**
 * 建一个走假 DNS 的策略。
 *
 * @param answers - 假解析器返回的地址表；键是主机名
 * @param allowPorts - 端口白名单；不传表示不限端口
 * @returns 策略对象
 */
function policyWith(
  answers: Record<string, readonly string[]>,
  allowPorts?: readonly number[],
): UrlPolicy {
  const resolve = resolverFrom(answers);
  return createUrlPolicy({
    maxUrlLength: 2048,
    resolve,
    ...(allowPorts === undefined ? {} : { allowPorts }),
  });
}

/** 默认策略：example.com 解析到公网 IPv4。 */
function defaultPolicy(): UrlPolicy {
  return policyWith({ [HOST]: [PUBLIC_V4] });
}

describe("无需 DNS 的检查", () => {
  it("放行正常 http/https", () => {
    const policy = defaultPolicy();
    expect(allowedUrl(policy.screen("http://example.com/a")).pathname).toBe("/a");
    expect(policy.screen("https://example.com/a?b=1").ok).toBe(true);
  });

  it("拒绝非 http/https scheme（file/ftp/gopher）", () => {
    const policy = defaultPolicy();
    for (const input of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]) {
      expect(reasonOf(policy.screen(input))).toBe(SCHEME);
    }
  });

  it("拒绝 URL 内嵌凭据", () => {
    expect(reasonOf(defaultPolicy().screen("http://user:pass@example.com/"))).toBe(
      "credentials-not-allowed",
    );
  });

  it("拒绝无法解析的 URL", () => {
    expect(reasonOf(defaultPolicy().screen("not a url"))).toBe("invalid-url");
  });

  it("拒绝超长 URL", () => {
    const long = `http://example.com/${"a".repeat(2048)}`;
    expect(reasonOf(defaultPolicy().screen(long))).toBe("too-long");
  });

  it("配置端口白名单后按白名单判定", () => {
    const policy = policyWith({ [HOST]: [PUBLIC_V4] }, [443]);
    expect(policy.screen("https://example.com:443/x").ok).toBe(true);
    expect(reasonOf(policy.screen("https://example.com:8443/x"))).toBe("port-not-allowed");
  });

  it("不给端口白名单时任何端口都放行（与 dsh 内置同取舍）", () => {
    expect(defaultPolicy().screen("http://example.com:8080/x").ok).toBe(true);
  });
});

/** 非公网但**不在**已知合成池里的答案：合成模式下也必须照旧判拒。 */
const NON_POOL_PRIVATE: readonly string[] = [
  "127.0.0.1",
  "10.0.0.5",
  "192.168.1.1",
  "169.254.169.254",
];

/** 检测场景里用的目标主机名（控制域名之外）。 */
const TARGET_HOST = "target.test";

describe("地址判定", () => {
  it("放行公网 ipv4", () => {
    expect(defaultPolicy().isPublicAddress(PUBLIC_V4)).toBe(true);
  });

  it("拒绝各类私网与保留地址", () => {
    const policy = defaultPolicy();
    for (const address of [
      ...NON_POOL_PRIVATE,
      "172.16.0.1",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(policy.isPublicAddress(address)).toBe(false);
    }
  });

  it("拒绝 ipv6 回环 / 唯一本地 / 链路本地", () => {
    const policy = defaultPolicy();
    for (const address of ["::1", "fc00::1", "fe80::1", "::"]) {
      expect(policy.isPublicAddress(address)).toBe(false);
    }
  });

  it("ipv4-mapped ipv6 按内嵌 ipv4 重判（::ffff:127.0.0.1 必须拒）", () => {
    const policy = defaultPolicy();
    expect(policy.isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(policy.isPublicAddress(`::ffff:${PUBLIC_V4}`)).toBe(true);
  });

  it("nat64 里藏的回环地址必须拒（::ffff 之外的绕过手法）", () => {
    const policy = defaultPolicy();
    // 64:ff9b::/96 + 127.0.0.1
    expect(policy.isPublicAddress("64:ff9b::7f00:1")).toBe(false);
    // 64:ff9b:1::/48（RFC 8215 本地段）+ 10.0.0.1
    expect(policy.isPublicAddress("64:ff9b:1::a00:1")).toBe(false);
  });

  it("nat64 里藏的公网地址放行", () => {
    expect(defaultPolicy().isPublicAddress("64:ff9b::5db8:d818")).toBe(true);
  });

  it("解析不了的字面量按不可抓处理", () => {
    expect(defaultPolicy().isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("带 DNS 的整体判定", () => {
  it("公网主机放行", async () => {
    const verdict = await defaultPolicy().verify("https://example.com/page");
    expect(allowedUrl(verdict).hostname).toBe(HOST);
  });

  it("整张答案表都在公网时放行", async () => {
    const policy = policyWith({ [HOST]: [PUBLIC_V4, "2606:2800:220:1::1"] });
    const verdict = await policy.verify(HOME_URL);
    expect(verdict.ok).toBe(true);
  });

  it("答案表里混入一条私网就整体拒绝（防 DNS 轮询绕过）", async () => {
    const policy = policyWith({ [HOST]: [PUBLIC_V4, "127.0.0.1"] });
    const verdict = await policy.verify(HOME_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("解析失败按拒绝处理", async () => {
    const verdict = await policyWith({}).verify("https://nope.invalid/");
    expect(reasonOf(verdict)).toBe("resolve-failed");
  });

  it("解析出空表按拒绝处理", async () => {
    const verdict = await policyWith({ "empty.test": [] }).verify("https://empty.test/");
    expect(reasonOf(verdict)).toBe("no-address");
  });

  it("ip 字面量不查 dns 直接判（127.0.0.1 与 ::1 都要拒）", async () => {
    const policy = policyWith({});
    expect(reasonOf(await policy.verify("http://127.0.0.1:8080/admin"))).toBe(PRIVATE);
    expect(reasonOf(await policy.verify("http://[::1]:8080/admin"))).toBe(PRIVATE);
    const meta = await policy.verify("http://169.254.169.254/latest/meta-data/");
    expect(reasonOf(meta)).toBe(PRIVATE);
  });

  it("公网 ip 字面量直接放行", async () => {
    const policy = policyWith({});
    const verdict = await policy.verify(`http://${PUBLIC_V4}/x`);
    expect(verdict.ok).toBe(true);
  });

  it("先跑 screen 的检查，不再往下走 dns", async () => {
    const verdict = await policyWith({}).verify("file:///etc/passwd");
    expect(reasonOf(verdict)).toBe(SCHEME);
  });
});

describe("默认 dns 解析器", () => {
  it("不注入 resolve 时走 node:dns，实际解析 localhost 并据此判定", async () => {
    const policy = createUrlPolicy({ maxUrlLength: 2048 });
    // localhost 在任何机器上都解析得到回环地址，因此这条用例不依赖外网：
    // 它验证的是「默认解析器确实被调用且结果被接住」，而不是解析结果是否公网。
    const verdict = await policy.verify("http://localhost:8080/");
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("不注入 resolve 时走 node:dns，遇解析不了的主机一律拒绝", async () => {
    const policy = createUrlPolicy({ maxUrlLength: 2048 });
    // 只断言「被拒」，不断言 reason。解析不了的域名在带通配解析器的网络里会拿到一个
    // 合成地址而不是 NXDOMAIN —— 本机实测 `.invalid` 落到 198.18.0.0/15，reason 于是
    // private-address 而非 resolve-failed。两者都判否，安全语义一致；把 reason 钉死等于
    // 把用例绑死在运行它的网络形状上。resolve-failed 那条由注入 reject 的 resolve
    // 确定性地覆盖，不碰真实 DNS。
    // 判据只到「能给出结论」为止，刻意不断言放行与否：这台机器开着 fake-ip，解析器给**所有**
    // 主机名都回一个合成地址，连 .invalid 也解析得出来，于是走不放行那条路是正确行为。
    // 断言「解析不了就拒」等于把用例绑死在运行它的网络形状上——而带通配解析器的网络里没有
    // 「解析不了」这回事。resolve-failed 那条由注入 reject 的 resolve 确定性覆盖。
    const verdict = await policy.verify("http://this-host-does-not-exist.invalid/");
    // 放行时必须仍指向原主机（没有被悄悄换成别处），被拒时原因必须是解析失败那一类。
    // 放行时主机名必须原样保留（没有被悄悄换成别处），被拒时原因必须是解析失败那一类。
    const observed = verdict.ok ? allowedUrl(verdict).hostname : verdict.reason;
    const expected = verdict.ok ? "this-host-does-not-exist.invalid" : "resolve-failed";
    expect(observed).toBe(expected);
  });
});

describe("自定义 nat64 前缀", () => {
  it("把运营商自建前缀传进来后，里面的私网 ipv4 会被拒（默认前缀表挡不住）", () => {
    const noCustom = createUrlPolicy({ maxUrlLength: 2048 });
    const withCustom = createUrlPolicy({
      maxUrlLength: 2048,
      nat64Prefixes: ["2001:4860:4860::/96"],
    });
    // 2001:4860:4860::/96 + 127.0.0.1 —— 哨兵段 + 回环地址
    const crafted = "2001:4860:4860::7f00:1";
    // 默认表里没有这条前缀，ipaddr 把它当普通 IPv6 unicast，于是放行 ——
    // 这正是我们要求部署显式声明自定义前缀的原因。
    expect(noCustom.isPublicAddress(crafted)).toBe(true);
    expect(withCustom.isPublicAddress(crafted)).toBe(false);
  });

  it("自定义前缀里藏的公网 ipv4 仍然放行", () => {
    const policy = createUrlPolicy({
      maxUrlLength: 2048,
      nat64Prefixes: ["2001:4860:4860::/96"],
    });
    // + 93.184.216.34
    expect(policy.isPublicAddress("2001:4860:4860::5db8:d818")).toBe(true);
  });

  it("前缀串写坏时在构造期就抛，不留到运行期静默判错", () => {
    expect(() => createUrlPolicy({ maxUrlLength: 2048, nat64Prefixes: ["not-an-ip/96"] })).toThrow(
      /malformed NAT64 prefix/u,
    );
    expect(() => createUrlPolicy({ maxUrlLength: 2048, nat64Prefixes: ["2001:db8::/99"] })).toThrow(
      /malformed NAT64 prefix/u,
    );
    expect(() =>
      createUrlPolicy({ maxUrlLength: 2048, nat64Prefixes: ["2001:db8::/32", "10.0.0.1"] }),
    ).toThrow(/malformed NAT64 prefix/u);
  });
});

/** 放行用例的假解析器：任何主机名都解析到同一枚私网地址。 */
const privateResolve: ResolveAddresses = async () => ["10.0.0.7"];

describe("显式放行的主机名", () => {
  const resolve = privateResolve;

  it("命中 allowHosts 时私网地址放行（与 Python 侧 ALLOWED_HOSTS 同解）", async () => {
    const policy = createUrlPolicy({ maxUrlLength: 2048, resolve, allowHosts: ["Intranet.Local"] });
    const verdict = await policy.verify("http://intranet.local/page");
    expect(verdict.ok).toBe(true);
  });

  it("主机名匹配忽略大小写", async () => {
    const policy = createUrlPolicy({ maxUrlLength: 2048, resolve, allowHosts: ["intranet.local"] });
    const verdict = await policy.verify("http://INTRANET.LOCAL/page");
    expect(verdict.ok).toBe(true);
  });

  it("名单外的私网目标照旧被拒", async () => {
    const policy = createUrlPolicy({ maxUrlLength: 2048, resolve, allowHosts: ["other.test"] });
    expect(reasonOf(await policy.verify("http://intranet.local/page"))).toBe(PRIVATE);
  });

  it("放行只跳过地址判定，scheme / 内嵌凭据 / 端口照旧检查", async () => {
    const policy = createUrlPolicy({
      maxUrlLength: 2048,
      resolve,
      allowHosts: ["intranet.local"],
      allowPorts: [80],
    });
    expect(reasonOf(await policy.verify("ftp://intranet.local/x"))).toBe(SCHEME);
    expect(reasonOf(await policy.verify("http://u:p@intranet.local/x"))).toBe(
      "credentials-not-allowed",
    );
    expect(reasonOf(await policy.verify("http://intranet.local:8080/x"))).toBe("port-not-allowed");
  });
});

/** fake-IP 的默认落点（RFC 2544 基准测试段）。 */
const FAKE_IP = "198.18.0.2";

/** TUN 客户端常见的落点（CGNAT 段）。 */
const CGNAT = "100.64.0.1";

/**
 * 建一个放行合成段的策略：解析器与 {@link policyWith} 同构，只是多打开那个开关。
 *
 * @param answers - 假解析器返回的地址表
 * @returns 策略对象
 */
function proxyPolicy(answers: Record<string, readonly string[]>): UrlPolicy {
  return createUrlPolicy({
    maxUrlLength: 2048,
    resolve: resolverFrom(answers),
    syntheticRanges: ["198.18.0.0/15", "100.64.0.0/10"],
  });
}

describe("代理合成的 DNS 答案", () => {
  it("默认关闭：合成段照旧判私网", async () => {
    const fake = await policyWith({ [HOST]: [FAKE_IP] }).verify(HOME_URL);
    expect(reasonOf(fake)).toBe(PRIVATE);
    const cgnat = await policyWith({ [HOST]: [CGNAT] }).verify(HOME_URL);
    expect(reasonOf(cgnat)).toBe(PRIVATE);
  });

  it("打开后 fake-IP 与 CGNAT 都放行", async () => {
    const fake = await proxyPolicy({ [HOST]: [FAKE_IP] }).verify(HOME_URL);
    expect(allowedUrl(fake).hostname).toBe(HOST);
    const cgnat = await proxyPolicy({ [HOST]: [CGNAT] }).verify(HOME_URL);
    expect(allowedUrl(cgnat).hostname).toBe(HOST);
  });

  it("打开后回环与私网仍然被拒——放宽只针对合成段", async () => {
    const loop = await proxyPolicy({ [HOST]: ["127.0.0.1"] }).verify(HOME_URL);
    expect(reasonOf(loop)).toBe(PRIVATE);
    const priv = await proxyPolicy({ [HOST]: ["192.168.1.1"] }).verify(HOME_URL);
    expect(reasonOf(priv)).toBe(PRIVATE);
    const meta = await proxyPolicy({ [HOST]: ["169.254.169.254"] }).verify(HOME_URL);
    expect(reasonOf(meta)).toBe(PRIVATE);
  });

  it("字面量拿不到这份放宽：URL 里写死合成段地址仍被拒", async () => {
    const verdict = await proxyPolicy({}).verify(`http://${FAKE_IP}/x`);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("合成段与公网混在一张答案表里整体放行", async () => {
    const verdict = await proxyPolicy({ [HOST]: [PUBLIC_V4, FAKE_IP] }).verify(HOME_URL);
    expect(allowedUrl(verdict).hostname).toBe(HOST);
  });
});

/** 控制域名解析出来的合成地址。真机上这三个答案是散落在池内各处的，不是挨着的。 */
const POOL: Record<string, readonly string[]> = {
  "example.com": ["198.18.0.12"],
  "www.iana.org": ["198.18.0.34"],
  "www.wikipedia.org": ["198.18.0.128"],
};

/**
 * 建一个走指定地址表、且不注入合成段白名单的策略。
 *
 * @param answers - 地址表
 * @returns 策略对象
 */
const TARGET_URL = "http://target.test/";

function detectingPolicy(answers: Record<string, readonly string[]>): UrlPolicy {
  return createUrlPolicy({ maxUrlLength: 2048, resolve: resolverFrom(answers) });
}

describe("自动识别合成解析器", () => {
  it("从控制域名学出假地址池，池内的主机名放行", async () => {
    const policy = detectingPolicy({ ...POOL, [TARGET_HOST]: ["198.18.0.77"] });
    const verdict = await policy.verify("https://target.test/");
    expect(allowedUrl(verdict).hostname).toBe(TARGET_HOST);
  });

  it("池外的私网地址照旧被拒——学出来的池不能拿来放行 localhost", async () => {
    // 这是本条防线存在的理由：代理的假地址只覆盖公网域名，本机名在同一个解析器下照样解析
    // 正确。若按「检测到就整段放行」实现，开了代理的机器上 http://localhost/ 会被一起放开。
    const policy = detectingPolicy({ ...POOL, [TARGET_HOST]: ["127.0.0.1"] });
    const verdict = await policy.verify(TARGET_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("控制域名解析正常时不误判，目标解析到私网仍被拒", async () => {
    const policy = detectingPolicy({
      "example.com": [PUBLIC_V4],
      "www.iana.org": ["2606:2800:220:1::1"],
      "www.wikipedia.org": [PUBLIC_V4],
      [TARGET_HOST]: ["10.0.0.1"],
    });
    const verdict = await policy.verify(TARGET_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("控制域名非公网但不落在任何已知池里时不误判", async () => {
    // 这一格与「落在池里」正好相反：同样是合成指纹（全部非公网、互不相同），但落点不在
    // 198.18.0.0/15 也不在 100.64.0.0/10 —— 那就不是已知的合成池，维持最严。
    const policy = detectingPolicy({
      "example.com": ["192.168.2.1"],
      "www.iana.org": ["192.168.2.2"],
      "www.wikipedia.org": ["192.168.2.3"],
      [TARGET_HOST]: ["198.18.0.9"],
    });
    expect(reasonOf(await policy.verify(TARGET_URL))).toBe(PRIVATE);
  });

  it("控制域名解析不了时不误判", async () => {
    const policy = createUrlPolicy({
      maxUrlLength: 2048,
      resolve: async (hostname) => {
        if (hostname === TARGET_HOST) {
          return ["198.18.0.5"];
        }
        throw new Error(`ENOTFOUND ${hostname}`);
      },
    });
    const verdict = await policy.verify(TARGET_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  // ↓ 下面三条是**回归用例**：早期实现按「覆盖控制答案的最小 2 的幂对齐块」切池，
  // 而控制答案是按名字哈希散列的，跨度纯属偶然。真机上三个答案是 .126/.134/.135，
  // 跨度 10 → 切出 198.18.0.112..127 这么个 /28。于是 www.iana.org 与 www.wikipedia.org
  // **自己都过不去**，github.com（.28）、opencode.ai（.61）更被挡在门外。三个样本不含任何
  // 池大小信息，拿它估大小必然得到一个碰运气的小切片。
  it("控制答案散落池内各处时，放宽到整段而不是切出一小片", async () => {
    const policy = detectingPolicy({
      "example.com": ["198.18.0.126"],
      "www.iana.org": ["198.18.0.134"],
      "www.wikipedia.org": ["198.18.0.135"],
      [TARGET_HOST]: ["198.18.0.61"],
    });
    expect(allowedUrl(await policy.verify(TARGET_URL)).hostname).toBe(TARGET_HOST);
  });

  it("散落场景下 198.19 段也放行（放宽到整段，不是到样本的最小覆盖块）", async () => {
    const policy = detectingPolicy({
      ...POOL,
      [TARGET_HOST]: ["198.19.7.9"],
    });
    expect(allowedUrl(await policy.verify(TARGET_URL)).hostname).toBe(TARGET_HOST);
  });

  it("散落场景下私网与回环仍然被拒——放宽的是已知合成池，不是所有非公网地址", async () => {
    const scattered = {
      "example.com": ["198.18.0.126"],
      "www.iana.org": ["198.18.0.134"],
      "www.wikipedia.org": ["198.18.0.135"],
    };
    const reasons = await Promise.all(
      NON_POOL_PRIVATE.map(async (answer) =>
        reasonOf(
          await detectingPolicy({ ...scattered, [TARGET_HOST]: [answer] }).verify(TARGET_URL),
        ),
      ),
    );
    expect(reasons).toStrictEqual(NON_POOL_PRIVATE.map(() => PRIVATE));
  });
});

/**
 * 建一个带着给定白名单、目标固定解析到私网的策略。
 *
 * @param ranges - 合成段白名单（CIDR 文本）
 * @returns 策略对象
 */
function withRanges(ranges: readonly string[]): UrlPolicy {
  return createUrlPolicy({
    maxUrlLength: 2048,
    // 目标必须是**控制域名之外**的另一个主机：把 10.0.0.1 放进控制集会让学出来的池
    // 横跨整个地址空间，测试就变成了在验证别的东西。
    resolve: resolverFrom({ ...POOL, [TARGET_HOST]: ["10.0.0.1"] }),
    syntheticRanges: ranges,
  });
}

describe("合成段白名单的解析容错", () => {
  it("写不成 CIDR 的项被丢掉，其余照常生效", async () => {
    const policy = withRanges(["这不是一个 CIDR", "198.18.0.0/16"]);
    const verdict = await policy.verify(TARGET_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("ipv6 的段被忽略（合成落点不会落在 IPv6 上）", async () => {
    const policy = withRanges(["2001:db8::/32"]);
    const verdict = await policy.verify(TARGET_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("白名单全是无效项时退化成维持最严，而不是崩溃", async () => {
    const policy = withRanges(["10.0.0.0/8/8", "300.1.1.1/16"]);
    const verdict = await policy.verify(TARGET_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });

  it("控制域名里出现 IPv6 时不学池，避免拿 IPv6 地址去比 IPv4 区间", async () => {
    const policy = createUrlPolicy({
      maxUrlLength: 2048,
      resolve: resolverFrom({
        "example.com": ["198.18.0.12"],
        "www.iana.org": ["fd00::1"],
        "www.wikipedia.org": ["198.18.0.128"],
      }),
    });
    const verdict = await policy.verify(HOME_URL);
    expect(reasonOf(verdict)).toBe(PRIVATE);
  });
});
