// dsh-scrapling/lib/url-policy.ts —— 抓取前的 URL 安全策略（SSRF 防线）。
//
// 为什么需要它：Scrapling 自身**没有任何** SSRF 防护 —— `follow_redirects="safe"`
// 只是转交给 curl_cffi 处理重定向，浏览器引擎那侧连这个都没有。一个「让模型自由填
// URL」的抓取工具，没有这层就是内网探测器与云凭据窃取器。
//
// 判据移植自 dsh 内置的 `web-fetch-http`：scheme 白名单 → 拒绝 URL 内嵌凭据 →
// 长度上限 → DNS 解析后**整个答案集**都要是公网（混入一条私网即整体拒绝）→
// IPv4-mapped 与 NAT64 地址按内嵌 IPv4 重判。
// 之所以是移植而不是复用：`@deepseek-ai/dsh-web-fetch-http` 的 package.json 只发布
// `lib/index.js`，`policy.ts` / `network.ts` 不在 npm 产物里。
//
// **已知缺口（README 必须同步写明）**：本模块只做「解析前的地址校验」，不做连接钉扎。
// 校验通过到 Python 真正建连之间存在 TOCTOU 窗口。静态抓取侧由 curl_cffi 的
// `follow_redirects="safe"` 兜住重定向，浏览器侧由 py/guard.py 的 route handler 兜住。

import ipaddr from "ipaddr.js";

/** 策略判定被拒的原因；用机器可读码，便于测试与错误文案分离。 */
export type BlockReason =
  | "invalid-url"
  | "scheme-not-allowed"
  | "credentials-not-allowed"
  | "too-long"
  | "ambiguous-authority"
  | "no-address"
  | "private-address"
  | "resolve-failed"
  | "port-not-allowed";

/** 策略判定结果。`ok` 为 false 时 `reason`/`message` 一定存在。 */
export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: BlockReason; message: string };

/** DNS 解析器签名。注入它是为了让测试不碰真实网络。 */
export type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

/** 策略参数。 */
export interface UrlPolicyOptions {
  /** URL 最大字符数；与 dsh 内置 web_fetch 的 2048 对齐。 */
  readonly maxUrlLength: number;
  /**
   * 允许的端口。留空表示**不限制端口** —— 与 dsh 内置 fetch provider 同取舍
   * （它全树唯一的 `.port` 引用是同源比较，没有端口白名单）。
   */
  readonly allowPorts?: readonly number[];
  /** DNS 解析器；不传则用 `node:dns/promises` 的 lookup。 */
  readonly resolve?: ResolveAddresses;
  /**
   * 额外的 NAT64 前缀（如运营商自建前缀）。默认只含两个标准化前缀；用自建前缀的
   * 网络必须把该前缀传进来，否则藏在里面的私网 IPv4 会被当成普通 IPv6 放行。
   */
  readonly nat64Prefixes?: readonly string[];
  /**
   * 显式放行的主机名。命中即跳过「答案集必须全是公网」那一条，其余检查（scheme、内嵌
   * 凭据、长度、端口）照旧。
   *
   * 这是给「抓自建/内网站点」用的，与 Python 侧 guard.py 的 `ALLOWED_HOSTS` 同一份部署
   * 设置：两边必须同解，否则 Host 侧会先把用户明确放行的目标拦掉，Python 侧的放行集合
   * 就永远没机会生效。指向内网等于主动放弃那些目标的 SSRF 防护，由部署方自行承担。
   */
  readonly allowHosts?: readonly string[];
  /**
   * 手动追加的「代理合成地址段」（CIDR）。默认空。
   *
   * 自动检测已经能认出绝大多数 fake-ip 解析器（见 `detectSyntheticResolver`）；这一项是
   * 检测失灵时的手动兜底，比如解析器把合成地址混着真地址一起返回、检测因而判否。
   *
   * 列进来的段等于放弃对它们的 SSRF 防护，指向内网段时请自行承担后果。
   */
  readonly syntheticRanges?: readonly string[];
}

/** 策略对象。 */
export interface UrlPolicy {
  /** 只做**不需要 DNS** 的检查：解析、scheme、凭据、长度、端口。 */
  readonly screen: (input: string) => UrlVerdict;
  /** 补做 DNS 与地址判定，产出最终结论。 */
  readonly verify: (input: string) => Promise<UrlVerdict>;
  /** 判定单个地址字面量是否可抓。 */
  readonly isPublicAddress: (address: string) => boolean;
}

/**
 * 解析地址字面量，失败给判别式的 false 分支而不是抛。
 *
 * @param address - 地址字面量
 * @returns 解析结果
 */
function tryParse(address: string): ParseResult {
  try {
    return { ok: true, value: ipaddr.parse(address) };
  } catch {
    return { ok: false };
  }
}

/** 无法解析的地址所用的哨兵 range：与 "unicast" 不同即可，判等只看是否等于。 */
const UNPARSABLE = "unparsable";

/** 公网判定所用的 range 字面量，出现多次故抽常量。 */
const UNICAST = "unicast";

/**
 * NAT64 里剥出来的内嵌 IPv4 及其判定用 range；未命中给 `null`。
 *
 * 同 ParseResult：用 `null` 而不是 `undefined` 做「没找到」的哨兵。
 */
interface Nat64Match {
  /** 内嵌的 IPv4 字面量。 */
  readonly address: string;
  /** 内嵌 IPv4 的判定用 range。 */
  readonly range: string;
}

/** 只允许的 scheme。与 dsh 内置一致：file:/ftp:/gopher: 一律拒绝。 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * NAT64 的**默认**前缀表（RFC 6052 与 RFC 8215）。
 *
 * 这些前缀把 IPv4 藏进 IPv6，直接按 IPv6 的 range 判会把 `64:ff9b::127.0.0.1`
 * 这类回环地址误判成公网。
 *
 * **已知缺口**：dsh 内置会用 `ipv4only.arpa` 与 `192.0.0.170/171` 哨兵**动态探测**
 * 当前网络真正生效的 NAT64 前缀，从而覆盖运营商自建前缀。本移植只覆盖两个标准化前缀；
 * 用自建前缀的网络需要把该前缀经 `nat64Prefixes` 传进来，否则藏在里面的私网
 * IPv4 会被当作普通 IPv6 unicast 放行。README 的安全章节同步写明这条。
 */
const DEFAULT_NAT64_PREFIXES: readonly string[] = ["64:ff9b::/96", "64:ff9b:1::/48"];

/** 预解析好的一个 NAT64 前缀条目。 */
interface Nat64Prefix {
  /** 前缀网络。 */
  readonly network: ipaddr.IPv6;
  /** 前缀长度（位）。 */
  readonly bits: number;
  /** 内嵌 IPv4 在 16 字节里的起始下标。 */
  readonly offset: number;
}

/**
 * NAT64 前缀长度 → 内嵌 IPv4 在 16 字节里的起始下标（RFC 6052 §2.2）。
 * 前缀越长，u 字节越靠前。
 */
const NAT64_EMBEDDED_OFFSETS: Readonly<Record<number, number>> = {
  96: 12,
  64: 9,
  56: 7,
  48: 6,
  40: 5,
  32: 4,
};

/**
 * 去掉 IPv6 字面量在 URL 里的方括号。
 *
 * @param hostname - URL 的 hostname
 * @returns 不带方括号的地址串
 */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * 解析地址的结果。用判别式字段而不是 `undefined` 表达失败。
 *
 * 为什么不用 `T | undefined`：`consistent-return` 默认把 `return undefined;` 当成
 * 「无返回值」，于是同一个函数里混着 `return 值` 就会报。返回对象字面量即可绕开。
 */
interface ParseResult {
  /** 是否解析成功。 */
  readonly ok: boolean;
  /** 解析成功时的地址对象；失败时缺席。 */
  readonly value?: ipaddr.IPv4 | ipaddr.IPv6;
}

/**
 * 把前缀表解析成定型条目。写坏的前缀在构造期就抛，不留到运行期静默判错。
 *
 * @param prefixes - 形如 `64:ff9b::/96` 的前缀串
 * @returns 定型后的前缀表
 */
function buildNat64Table(prefixes: readonly string[]): readonly Nat64Prefix[] {
  return prefixes.map((prefix) => {
    // split 的第一个元素恒为字符串，用解构默认值代替 `=== undefined` 三元 ——
    // 后者那条分支永远走不到，还会把分支覆盖率拉低。
    const [netHex = "", bitsText = ""] = prefix.split("/");
    const { value } = tryParse(netHex);
    const bits = Math.trunc(Number(bitsText));
    const offset = NAT64_EMBEDDED_OFFSETS[bits];
    if (!(value instanceof ipaddr.IPv6) || offset === undefined) {
      throw new Error(`malformed NAT64 prefix: ${prefix}`);
    }
    return { network: value, bits, offset };
  });
}

/**
 * 按单个 NAT64 前缀抽出内嵌 IPv4。
 *
 * @param parsed - 已解析的 IPv6
 * @param entry - 已解析好的前缀条目
 * @returns 命中的内嵌 IPv4 及其 range；未命中给 null
 */
function extractNat64(parsed: ipaddr.IPv6, entry: Nat64Prefix): Nat64Match | null {
  if (!parsed.match(entry.network, entry.bits)) {
    return null;
  }
  const { offset } = entry;
  // slice 恒为 4 字节，故 fromByteArray 恒返回 IPv4；统一走 toIPv4Address() 归一，
  // 免掉一条永远为假的 instanceof 分支。
  const inner = ipaddr.fromByteArray(parsed.toByteArray().slice(offset, offset + 4));
  // 4 字节输入恒为 IPv4，所以 else 臂只为让 TS 从联合类型收窄而存在，运行期不可达。
  /* v8 ignore next 1 */
  const ipv4 = inner instanceof ipaddr.IPv4 ? inner : inner.toIPv4Address();
  return { address: ipv4.toString(), range: ipv4.range() };
}

/**
 * 剥出 NAT64 里藏着的 IPv4。
 *
 * @param parsed - 已确认是 IPv6 的地址
 * @returns 藏有 IPv4 时给出其地址与 range，否则 null
 */
function embeddedV4(parsed: ipaddr.IPv6, table: readonly Nat64Prefix[]): Nat64Match | null {
  const found = table.map((entry) => extractNat64(parsed, entry)).find((hit) => hit !== null);
  return found ?? null;
}

/**
 * 把地址归约成「最终按谁的 range 判定」。
 *
 * ipaddr.js 对 IPv4-mapped 与 NAT64 地址报的 range 分别是 `ipv4Mapped` 与 `rfc6052`，
 * 都不是 `unicast`。若先判 `range() !== "unicast"`，就会把 `::ffff:93.184.216.34`
 * （内嵌的是公网地址）连同 `::ffff:127.0.0.1` 一起拒掉 —— 所以「按内嵌 IPv4 重判」
 * 必须做成**换算**而不是**附加检查**：先剥出内嵌 IPv4，再拿它的 range 去判。
 *
 * @param address - 地址字面量
 * @returns 用于判定的 range；无法解析时给一个必然被拒的哨兵
 */
function effectiveRange(address: string, table: readonly Nat64Prefix[]): string {
  const { value } = tryParse(address);
  if (value === undefined) {
    return UNPARSABLE;
  }
  if (value instanceof ipaddr.IPv6 && value.range() === "ipv4Mapped") {
    return value.toIPv4Address().range();
  }
  // 关键：不能只对 ipaddr 标成 rfc6052 的地址查前缀表。标准化前缀恰好落在 rfc6052 段里，
  // 但**运营商自建前缀通常落在 unicast 段**（例如 2001:4860:4860::/96）。只按 range 筛就会
  // 完全跳过它们，藏在里面的私网 IPv4 会被当成普通公网 IPv6 放行。所以这里对**所有** IPv6
  // 都查一次前缀表，命中就改用内嵌 IPv4 的 range。
  if (value instanceof ipaddr.IPv6) {
    const inner = embeddedV4(value, table);
    if (inner !== null) {
      return inner.range;
    }
  }
  return value.range();
}

/**
 * 判定一个地址是否可抓。解析失败一律按不可抓处理。
 *
 * @param address - 地址字面量
 * @returns 是否为公网地址
 */
function isPublicAddress(address: string, table: readonly Nat64Prefix[]): boolean {
  return effectiveRange(address, table) === UNICAST;
}

/**
 * 代理软件合成地址在 ipaddr.js 里的 range 名。
 *
 * `reserved` 是 `198.18.0.0/15`（RFC 2544 基准测试段，fake-IP 的默认落点），
 * `carrierGradeNat` 是 `100.64.0.0/10`（部分 TUN 客户端的落点）。两者都不是 `unicast`。
 */

/**
 * 判定一个 DNS 答案能否放行。
 *
 * 与 {@link isPublicAddress} 的差别只有一处：处在「解析结果不可信」的状态时，主机名的答案
 * 不再参与公网判定。该放宽**只作用于这里**——字面量不走这条路径，`isPublicAddress` 始终
 * 按严格口径判。
 *
 * @param address - 解析得到的地址
 * @param table - NAT64 前缀表
 * @param relax - 解析结果是否不可信
 * @returns 是否放行
 */
/**
 * 把 IPv4 点分地址折成一个整数，便于做区间比较。
 *
 * @param parsed - 已解析的 IPv4 地址
 * @returns 32 位无符号值
 */
function ipv4ToLong(parsed: ipaddr.IPv4): number {
  return parsed.toByteArray().reduce((accumulator, byte) => accumulator * 256 + byte, 0);
}

function isAcceptableAnswer(
  address: string,
  table: readonly Nat64Prefix[],
  pools: readonly SyntheticRange[],
): boolean {
  if (isPublicAddress(address, table)) {
    return true;
  }
  const parsed = tryParse(address).value;
  if (!(parsed instanceof ipaddr.IPv4)) {
    return false;
  }
  const value = ipv4ToLong(parsed);
  return pools.some(({ first, last }) => value >= first && value <= last);
}

/** 一段 IPv4 的闭区间；合成段判定只在这一层做数值比较，不碰 ipaddr 的网络类型。 */
interface SyntheticRange {
  readonly first: number;
  readonly last: number;
}

/**
 * 解析一条合成段 CIDR。只支持 IPv4 —— IPv6 的合成落点本就不存在，写出来也是误导。
 *
 * @param entry - CIDR 文本
 * @returns 区间；不是合法 IPv4 CIDR 时给 null
 */
function parseSyntheticRange(entry: string): SyntheticRange | null {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  let bits: number;
  try {
    [parsed, bits] = ipaddr.parseCIDR(entry.trim());
  } catch {
    return null;
  }
  if (!(parsed instanceof ipaddr.IPv4) || bits > 32) {
    return null;
  }
  const first = ipv4ToLong(parsed);
  return { first, last: first + 2 ** (32 - bits) - 1 };
}

/** 检测合成解析器时用的控制域名：与用户的目标无关，答案只反映解析器本身的行为。 */
const CONTROL_HOSTS: readonly string[] = ["example.com", "www.iana.org", "www.wikipedia.org"];

/**
 * 判断当前解析器是不是在合成地址。
 *
 * 依据是 fake-ip 的指纹：**所有**主机名都被指到同一个非公网小池里。实测在一台开着 TUN +
 * fake-ip 的机器上，example.com / github.com / wikipedia.org / echarts.apache.org /
 * www.apple.com 全部落在 198.18.0.0/15 内且互不相同，而 IP 字面量原样不动。
 *
 * 这么判而不是枚举段：落点由代理自己定，clash/mihomo 默认 `198.18.0.0/16`，部分 TUN 客户端
 * 用 `100.64.0.0/10`，自建配置里可以是任意段——用户不该被迫先知道自己代理用了哪一段。
 * 控制域名解析失败时不判否：判否只让闸门维持最严，不会误放行。
 *
 * @param resolve - 解析器
 * @param table - NAT64 前缀表
 * @returns 解析器是否在合成地址
 */
async function detectSyntheticResolver(
  resolve: ResolveAddresses,
  table: readonly Nat64Prefix[],
): Promise<SyntheticRange[]> {
  const answers = await Promise.all(
    CONTROL_HOSTS.map(async (host) => {
      try {
        return await resolve(host);
      } catch {
        return [] as readonly string[];
      }
    }),
  );
  const flat = answers.flat();
  // 答案不够、或全指向同一处（解析器坏了）都当没检测到：判否只让闸门维持最严，不会误放行。
  if (flat.length < CONTROL_HOSTS.length || new Set(flat).size < 2) {
    return [];
  }
  if (!flat.every((address) => !isPublicAddress(address, table))) {
    return [];
  }
  // 学出那个池：取所有控制答案的最长公共前缀。只放宽**落在池子里**的地址——代理的假地址只
  // 覆盖公网域名，本机名与内网名在同一个解析器下照样解析正确；把整段结果一律放行会让
  // http://localhost/ 跟着开，那才是真正要守住的底线。
  const longs: number[] = [];
  for (const address of flat) {
    const parsed = tryParse(address).value;
    if (!(parsed instanceof ipaddr.IPv4)) {
      return [];
    }
    longs.push(ipv4ToLong(parsed));
  }
  // 取覆盖全部控制答案的最小 2 的幂对齐块：先按跨度定块大小，再向下对齐。
  const low = Math.min(...longs);
  const high = Math.max(...longs);
  const size = 2 ** Math.ceil(Math.log2(high - low + 1));
  /* v8 ignore next -- 跨度上界到不了：low/high 都是 32 位无符号值，high - low + 1 最大
     2^32 - 1，取整到 2 的幂后最大就是 2^32。留着只为防 long 溢出成负数时算出 0。 */
  if (size > 4_294_967_296) {
    return [];
  }
  const first = Math.floor(low / size) * size;
  return [{ first, last: first + size - 1 }];
}

/**
 * 判断 hostname 是否是 IP 字面量（而非需要 DNS 的名字）。
 *
 * @param hostname - URL 的 hostname
 * @returns 是否为 IP 字面量
 */
function isIpLiteral(hostname: string): boolean {
  return tryParse(stripBrackets(hostname)).ok;
}

/**
 * authority 里不该出现的字符：反斜杠与 C0 控制字符。
 *
 * WHATWG URL 把 http/https 的 `\` 当路径分隔符，libcurl 按 RFC 3986 不当。对
 * `http://a.example\@127.0.0.1/` 这类串，两边读出的 host 完全不同：闸门看到的是
 * `a.example`，真正建连的却是 `127.0.0.1`。authority 里本来就不该有反斜杠或控制字符，
 * 整类拒掉比逐个枚举差分形态省事，也不用担心以后 WHATWG 或 curl 改规则时又冒出新形态。
 */
function isAuthorityAmbiguity(char: string): boolean {
  /* v8 ignore next -- 调用方是 split("") 的结果，不会产出空串，这个兜底到不了 */
  const code = char.codePointAt(0) ?? 0;
  // 31 是最后一个 C0 控制字符（空格是 32），127 是 DEL。用十进制是因为十六进制大小写
  // 在 formatter 与 lint 之间来回翻。
  return char === "\\" || code <= 31 || code === 127;
}

/**
 * 取原始串里的 authority 段（scheme 之后、path/query/fragment 之前）。
 *
 * 必须切原始串而不是 `new URL` 的结果 —— 后者已经按 WHATWG 规则重写过了，那正是差分
 * 的来源。
 *
 * @param input - 原始 URL
 * @returns authority 文本；没有 `://` 时返回整串
 */
function authorityOf(input: string): string {
  const schemeEnd = input.indexOf("://");
  const rest = schemeEnd === -1 ? input : input.slice(schemeEnd + 3);
  const end = rest.search(/[/?#]/u);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * 默认 DNS 解析器：一次 lookup 取齐 A 与 AAAA。
 *
 * 为什么一次取全而不是先 A 后 AAAA：只查 A 会漏掉「A 记录是公网、AAAA 指向 NAT64
 * 内网」这种把流量导到私网的配置；一次拿全再整体判定更严。
 *
 * @param hostname - 主机名
 * @returns 解析到的地址字面量
 */
async function resolveWithNodeDns(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import("node:dns/promises");
  const found = await lookup(hostname, { all: true });
  return found.map((entry) => entry.address);
}

/**
 * 建一个 URL 策略。
 *
 * @param options - 策略参数
 * @returns 带 `screen` / `verify` / `isPublicAddress` 的策略对象
 */
export function createUrlPolicy(options: UrlPolicyOptions): UrlPolicy {
  const { maxUrlLength, allowPorts } = options;
  const resolve = options.resolve ?? resolveWithNodeDns;
  const table = buildNat64Table([...DEFAULT_NAT64_PREFIXES, ...(options.nat64Prefixes ?? [])]);
  const allowed = new Set((options.allowHosts ?? []).map((host) => host.trim().toLowerCase()));
  // 合成段的手动兜底；自动检测才是主路径，见 detectSyntheticResolver。
  // 写错的段直接丢掉而不是让插件起不来：它只是兜底，坏了退化成「维持最严」而不是崩溃。
  const manualRanges = (options.syntheticRanges ?? [])
    .map((entry) => parseSyntheticRange(entry))
    .filter((range) => range !== null);
  // 检测只做一次并缓存：它要额外解析三个控制域名，而每个 URL 都会走到这里。
  let detected: Promise<SyntheticRange[]> | undefined;

  /**
   * 只做不需要 DNS 的检查。
   *
   * @param input - 原始 URL
   * @returns 判定结论
   */
  const screen = (input: string): UrlVerdict => {
    if (input.length > maxUrlLength) {
      return {
        ok: false,
        reason: "too-long",
        message: `URL exceeds the maximum length of ${maxUrlLength}`,
      };
    }
    if (
      authorityOf(input)
        .split("")
        .some((char) => isAuthorityAmbiguity(char))
    ) {
      return {
        ok: false,
        reason: "ambiguous-authority",
        message: "URL authority contains a backslash or a control character",
      };
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { ok: false, reason: "invalid-url", message: `invalid URL: ${input}` };
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return {
        ok: false,
        reason: "scheme-not-allowed",
        message: `unsupported URL scheme "${url.protocol}" (only http and https are allowed)`,
      };
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return {
        ok: false,
        reason: "credentials-not-allowed",
        message: "credentials in URLs are not allowed",
      };
    }
    if (allowPorts !== undefined && url.port.length > 0 && !allowPorts.includes(Number(url.port))) {
      return {
        ok: false,
        reason: "port-not-allowed",
        message: `port ${url.port} is not in the allow list`,
      };
    }
    return { ok: true, url };
  };

  /**
   * 补做 DNS 与地址判定。
   *
   * @param input - 原始 URL
   * @returns 判定结论
   */
  const verify = async (input: string): Promise<UrlVerdict> => {
    const screened = screen(input);
    if (!screened.ok) {
      return screened;
    }
    const { url } = screened;
    const literal = isIpLiteral(url.hostname);
    let addresses: readonly string[];
    if (literal) {
      addresses = [stripBrackets(url.hostname)];
    } else {
      try {
        addresses = await resolve(url.hostname);
      } catch (error) {
        return {
          ok: false,
          reason: "resolve-failed",
          message: `failed to resolve host: ${url.hostname} (${String(error)})`,
        };
      }
    }
    if (addresses.length === 0) {
      return {
        ok: false,
        reason: "no-address",
        message: `host resolved to no addresses: ${url.hostname}`,
      };
    }
    // 显式放行的主机名：跳过公网判定。与 Python 侧 guard.py 的 ALLOWED_HOSTS 同一份配置，
    // 两边同解——否则 Host 侧会先把用户明确放行的目标拦掉。
    if (allowed.has(url.hostname.toLowerCase())) {
      return screened;
    }
    // 合成解析下，主机名的答案不是任何真实目标——按它判公网等于判了个不存在的东西。
    // 检测到就放宽（IP 字面量不走这条路，`literal` 一票否决）。手动白名单是兜底。
    const pools = literal
      ? []
      : [...manualRanges, ...(await (detected ??= detectSyntheticResolver(resolve, table)))];
    const offender = addresses.find((address) => !isAcceptableAnswer(address, table, pools));
    if (offender !== undefined) {
      return {
        ok: false,
        reason: "private-address",
        message: `host resolves to a non-public address (${offender}): ${url.hostname}`,
      };
    }
    return screened;
  };

  return { screen, verify, isPublicAddress: (address: string) => isPublicAddress(address, table) };
}
