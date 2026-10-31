// 爬虫作业的取消信号与宿主契约。单独成文件，避免 lib/tools.ts 超过行数上限。

import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { pageToText, rowToText } from "./crawl-output.ts";
import type { SidecarClient } from "./sidecar.ts";

/** 爬虫作业往后台作业输出环上写东西的出口。 */
export interface CrawlSink {
  /** 追加一行输出。 */
  append: (text: string) => void;
  /** 更新「当前进度」那一行。 */
  progress: (line: string) => void;
  /**
   * 作业的取消信号。
   *
   * 爬虫必须用**这个**信号，而不是工具执行上下文那个：job_kill 中止的是作业自己的
   * controller，两者毫无关系。
   */
  signal: AbortSignal;
  /** 把这次爬虫的 crawlId 交给宿主，让进度事件找到这个作业的输出环。 */
  track?: (crawlId: string) => void;
}

/** 爬虫作业的干活部分：宿主保证它只被调用一次，返回后作业就算结束。 */
export type CrawlJobRunner = (sink: CrawlSink) => Promise<void>;

/** 起一个后台作业并返回它的 id。 */
export type CrawlJobStarter = (label: string, run: CrawlJobRunner) => Promise<string>;

/**
 * 把多个取消信号合成一个：任一中止则整体中止。
 *
 * @param sources - 参与合成的信号
 * @returns 合并后的信号
 */
export function anySignal(sources: readonly AbortSignal[]): AbortSignal {
  if (sources.length === 0) {
    return AbortSignal.abort();
  }
  // AbortSignal.any 用弱引用追踪源信号，合并信号中止或被回收后登记自动释放；
  // 手写 addEventListener 会把监听留在长命的作业/轮次信号上，同一轮并发 N 个爬虫
  // 就累积 N 份，最终触发 MaxListenersExceededWarning。
  return AbortSignal.any([...sources]);
}

/** 轮询爬虫状态的间隔（毫秒）。 */
const CRAWL_POLL_MS = 500;

/**
 * 叫停 Python 侧那个爬虫。
 *
 * 尽力而为：进程可能已经退了（那一次 job_kill 把 sidecar 一起拆了），这一帧只会换回
 * 一个错误。错误绝不能往外抛 —— 它要盖掉的是调用方真正关心的那个失败原因。
 *
 * @param sidecar - sidecar 客户端
 * @param crawlId - 爬虫 id
 */
async function stopCrawl(sidecar: SidecarClient, crawlId: string): Promise<void> {
  try {
    await sidecar.call("crawl.stop", { crawlId });
  } catch {
    // 已经没人可停了：sidecar 拆掉时爬虫线程跟着退出，这里无事可做。
  }
}

/**
 * 把收尾那一拍的摘要写进输出环：统计与 notice 各一行。
 *
 * @param status - crawl.status 的回包
 * @param sink - 输出出口
 */
function appendFinalNotes(status: Record<string, unknown>, sink: CrawlSink): void {
  if (status["running"] === true) {
    return;
  }
  const { stats } = status;
  if (isRecord(stats) && Object.keys(stats).length > 0) {
    // 只在收尾那一拍写一行：统计不能把每页正文再抄一遍，页面仍走上面的增量 pages。
    sink.append(`crawl stats: ${JSON.stringify(stats)}`);
  }
  // Python 侧把「为什么不完整」写进 notice（shopify 模式撞到非店铺响应、sitemap 发现期
  // 被上限截断）。作业若把它吞掉，模型只看到少了几页、却永远不知道原因 —— 收尾那一拍
  // 透传一次；空串表示没有话要说，不占一行。
  const notice = typeof status["notice"] === "string" ? status["notice"] : "";
  if (notice !== "") {
    sink.append(`crawl notice: ${notice}`);
  }
}

/**
 * 轮询一次爬虫状态并吐出新增页面；还在跑就等一拍再来。
 *
 * @param sidecar - sidecar 客户端
 * @param crawlId - 爬虫 id
 * @param sink - 输出出口
 * @param signal - 取消信号
 * @param seen - 已经输出过多少页，跨轮次累积
 * @returns 结束时一共输出过多少页
 */
async function drainOnce(
  sidecar: SidecarClient,
  crawlId: string,
  sink: CrawlSink,
  signal: AbortSignal,
  seen: number,
): Promise<number> {
  // 只取 seen 之后新增的那一段：整份 pages 每轮重发是 O(n²)。
  // status 是受 MAX_STATUS_BYTES 封顶的短回包，沿用 sidecar 的默认请求超时：
  // 对端卡死但不退出时，没有超时的轮询会让作业既无进度也无失败原因。
  const raw = await sidecar.call("crawl.status", { crawlId, since: seen }, { signal });
  // 协议层 decodeFrame 已拒绝非对象帧；这里的守卫只防第三方 SidecarClient 实现
  // 不按协议回包（测试覆盖非对象分支）。
  const status = isRecord(raw) ? raw : {};
  const failure = typeof status["error"] === "string" ? status["error"] : "";
  if (failure !== "") {
    throw new Error(`crawl failed: ${failure}`);
  }
  // 对端形状异常时按空数组处理，并过滤非对象项；正常路径每轮都会走到这里，
  // 非数组分支由 malformed 回包用例覆盖。
  const allPages = Array.isArray(status["pages"]) ? status["pages"] : [];
  const pages = allPages.filter((page): page is Record<string, unknown> => isRecord(page));
  for (const page of pages) {
    sink.append(pageToText(page));
  }
  const allRows = Array.isArray(status["rows"]) ? status["rows"] : [];
  const rows = allRows.filter((row): row is Record<string, unknown> => isRecord(row));
  for (const row of rows) {
    sink.append(rowToText(row));
  }
  const total = seen + pages.length + rows.length;
  if (status["more"] === true) {
    if (total === seen) {
      // 对端说还有，却一个可消费条目都没给：继续递归既不等待也不校验 signal，
      // 会变成打满 CPU 的忙循环。按协议错误收口。
      throw new Error("crawl.status returned more=true without new pages or rows");
    }
    // 对端按字节预算只回了一段（见 py/crawl.py 的 MAX_STATUS_BYTES）：紧接着取下一段，
    // 一页都不丢。这里不睡那一拍 —— 睡眠的意思是「还没跑完，等它攒点新页」，而现在是有
    // 现成的页等着读。
    return drainOnce(sidecar, crawlId, sink, signal, total);
  }
  appendFinalNotes(status, sink);
  // 页数比 maxPages 少时，模型该能看出是「整体截止到了点」而不是站点就这么大；挂在收尾
  // 那一行里说，不再单独发一条进度 —— 同一件事两句进度只会让输出环里多一行噪音。
  const budgetNote =
    status["running"] !== true && status["expired"] === true
      ? " (stopped at its runtime budget; the page cap was not reached)"
      : "";
  sink.progress(
    `${total} ${status["mode"] === "feed" ? "row(s)" : "page(s)"} crawled${budgetNote}`,
  );
  if (status["running"] !== true) {
    return total;
  }
  await sleep(CRAWL_POLL_MS, undefined, { signal });
  // 自己递归而不是回调 drainCrawl：叫停只在最外层那一个 try 里做一次，
  // 每层各停一遍会让一次 job_kill 打出 N 帧 crawl.stop。
  return drainOnce(sidecar, crawlId, sink, signal, total);
}

/**
 * 把一个跑着的爬虫的页面增量写进作业输出环，直到它结束。
 *
 * 轮询而不是等一个大回包：一次爬取可能几分钟，作业的输出环是给模型增量看的，
 * 等全部跑完再一次性吐出来等于没有进度可言。
 *
 * 写成递归而不是循环：每一步都要等上一次 sidecar 往返，顺序不能并行；
 * 递归也让「顺序等待」这件事在代码结构上显形，不用靠注释说明为什么不能并发。
 *
 * @param sidecar - sidecar 客户端
 * @param crawlId - 爬虫 id
 * @param sink - 输出出口
 * @param signal - 取消信号
 * @param seen - 已经输出过多少页，跨轮次累积
 */
export async function drainCrawl(
  sidecar: SidecarClient,
  crawlId: string,
  sink: CrawlSink,
  signal: AbortSignal,
  seen: number,
): Promise<number> {
  try {
    return await drainOnce(sidecar, crawlId, sink, signal, seen);
  } catch (error: unknown) {
    // 轮询断了（job_kill、本轮超时、sidecar 崩了）不等于爬虫停了：Python 侧的 Spider 跑在
    // 自己的线程里，Node 侧的取消它根本看不见。先叫停再抛，否则作业显示已杀、爬虫还在
    // 后台跑，Python 进程也一直被一个没人管的蜘蛛占着。
    await stopCrawl(sidecar, crawlId);
    throw error;
  }
}
