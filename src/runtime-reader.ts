// 设置卡读宿主侧 runtime 的入口（官方 Typert Remote 的消费端）。
//
// descriptor 手写：网关在源模式下按方法签名取参数名，参数与结果都走 src-json；客户端贡献
// 校验要求每个入参带 strict codec，所以这里用 zod schema 只在本进程校验形状、不跨网。
//
// remote 走 `ctx.get("remote")` 而不是 inject：没有远程通道的部署里整张卡仍要渲染，把
// `remote` 写进 inject 会让整条 client 入口不激活。

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/client";
import { isRemoteMounter } from "@jayyuen66/dsh-plugin-shared/lib/typert-client";
import type { RemoteHost } from "@jayyuen66/dsh-plugin-shared/lib/typert-client";
import { z } from "zod";
import {
  JOB_STATUSES,
  PACK_STATES,
  PYTHON_VIAS,
  REFUSED_STATUSES,
  RUNTIME_PACKS,
  RUNTIME_REMOTE_NAMESPACE,
} from "../lib/runtime-shape.ts";
import type {
  RuntimeActionResult,
  RuntimeCancelRequest,
  RuntimePack,
  RuntimePackRequest,
  RuntimeStatusResult,
} from "../lib/runtime-shape.ts";

// RemoteHost / isMounter 由 shared `./lib/typert-client` 收编（七份逐字副本的正主；
// 本仓此前的 field() 访问器与正主的 record[key] 直读行为等价——输入全为 JSON 记录）。
// 再导出放在 import 块之后：夹在中间会让后续 import 被判「不在文件顶部」。
export type { RemoteHost } from "@jayyuen66/dsh-plugin-shared/lib/typert-client";

const PACKAGE_NAME = "@jayyuen66/dsh-scrapling";

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}
const NAMESPACE = RUNTIME_REMOTE_NAMESPACE;
const SERVICE_KEY = `remote.${NAMESPACE}`;

/** strict codec 的统一出口：失败交给 zod 的 `prettifyError`，读到的是一份带字段路径的说明。 */
function parseOrThrow<Result>(schema: z.ZodType<Result>, value: unknown): Result {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

const PACK_MESSAGE = "runtime request requires a known pack";
const PACK_SCHEMA = z.object(
  { pack: z.enum(RUNTIME_PACKS, { error: PACK_MESSAGE }) },
  { error: PACK_MESSAGE },
);

const CANCEL_MESSAGE = "runtime cancel requires a jobId";
const CANCEL_SCHEMA = z.object(
  // 先 trim 再判长度：`min(1)` 只挡空串，纯空白的 jobId 会带着空白上网关。
  { jobId: z.string({ error: CANCEL_MESSAGE }).trim().min(1, { error: CANCEL_MESSAGE }) },
  { error: CANCEL_MESSAGE },
);

const PACK_CODEC: TypertCodec<RuntimePackRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#runtime-pack-request`,
  create: () => ({
    parse(value: unknown): RuntimePackRequest {
      return parseOrThrow(PACK_SCHEMA, value);
    },
  }),
};

const CANCEL_CODEC: TypertCodec<RuntimeCancelRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#runtime-cancel-request`,
  create: () => ({
    parse(value: unknown): RuntimeCancelRequest {
      return parseOrThrow(CANCEL_SCHEMA, value);
    },
  }),
};

const PACK_STATE_SCHEMA = z.enum(PACK_STATES);
const JOB_STATUS_SCHEMA = z.enum(JOB_STATUSES);
const RUNTIME_PACK_SCHEMA = z.enum(RUNTIME_PACKS);

const JOB_VIEW_SCHEMA = z.object({
  id: z.string(),
  pack: RUNTIME_PACK_SCHEMA,
  status: JOB_STATUS_SCHEMA,
  output: z.string(),
});

/** 状态读取接口的返回形状：`ok` 是字面量 true，`job` 只可能是对象或 null。 */
const STATUS_SCHEMA: z.ZodType<RuntimeStatusResult> = z.object({
  ok: z.literal(true),
  packs: z.partialRecord(RUNTIME_PACK_SCHEMA, PACK_STATE_SCHEMA),
  python: z.object({ path: z.string(), via: z.enum(PYTHON_VIAS), version: z.string() }),
  dataDir: z.string(),
  jobsReady: z.boolean(),
  job: JOB_VIEW_SCHEMA.nullable(),
});

/** 动作读取接口的两支：启动成功带 jobId；拒绝带 error 与保留的状态码。
 *  状态码用 zod v4 的 `z.literal(数组)` 重载（core 侧落在同一份 PrimitiveSet，
 *  等价于逐值 union，但少三层 `z.literal(...)` 调用嵌套）。 */
const REFUSED_STATUS_SCHEMA = z.literal(REFUSED_STATUSES);
const ACTION_SCHEMA: z.ZodType<RuntimeActionResult> = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), jobId: z.string() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    status: REFUSED_STATUS_SCHEMA,
  }),
]);

/** 一个入参位的形状：四枚描述符里只有它不同。 */
type DescriptorParameters = InvocationDescriptor["parameters"];

/** 四个描述符共用的骨架：`id`、`service`、`namespace`、`invocation`、`result` 五件都同。 */
function descriptorFor(method: string, parameters: DescriptorParameters): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters,
    result: { mode: "src-json" },
  };
}

/** 带请求件的那一枚入参：装与修共用 `PACK_CODEC`，取消用 `CANCEL_CODEC`。
 *
 *  类型参数透传下去而不宽化成裸 `TypertCodec`：宽化之后 `PACK_CODEC` 与 `CANCEL_CODEC`
 *  在调用点完全可互换，写成 `requestParameter(CANCEL_CODEC)` 装进 `installPack` 也能过编译，
 *  codec 与请求类型/方法是否配对只剩运行时测试兜底。
 */
function requestParameter<Request>(codec: TypertCodec<Request>): DescriptorParameters {
  return [{ name: "request", wire: "request", source: "json", codec }];
}

/** 每个要带请求件的方法与它的请求类型：codec 与方法配错时在编译期就红。 */
interface MethodRequest {
  readonly installPack: RuntimePackRequest;
  readonly repairPack: RuntimePackRequest;
  readonly cancelJob: RuntimeCancelRequest;
}

/** 带请求件的方法那四枚描述符里的一枚。 */
function requestDescriptor<Method extends keyof MethodRequest>(
  method: Method,
  codec: TypertCodec<MethodRequest[Method]>,
): InvocationDescriptor {
  return descriptorFor(method, requestParameter(codec));
}

/** 宿主四个方法的客户端描述符；测试拿它与宿主侧 `remoteMethods()` 对质。 */
export const RUNTIME_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptorFor("status", []),
  requestDescriptor("installPack", PACK_CODEC),
  requestDescriptor("repairPack", PACK_CODEC),
  requestDescriptor("cancelJob", CANCEL_CODEC),
];

interface RuntimeNamespace {
  status: () => Promise<RemoteResult<unknown>>;
  installPack: (request: RuntimePackRequest) => Promise<RemoteResult<unknown>>;
  repairPack: (request: RuntimePackRequest) => Promise<RemoteResult<unknown>>;
  cancelJob: (request: RuntimeCancelRequest) => Promise<RemoteResult<unknown>>;
}

export interface RuntimeReader {
  status: () => Promise<RuntimeStatusResult>;
  install: (pack: RuntimePack) => Promise<RuntimeActionResult>;
  repair: (pack: RuntimePack) => Promise<RuntimeActionResult>;
  cancel: (jobId: string) => Promise<RuntimeActionResult>;
}

function isNamespace(value: unknown): value is RuntimeNamespace {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof field(value, "status") === "function" &&
    typeof field(value, "installPack") === "function" &&
    typeof field(value, "repairPack") === "function" &&
    typeof field(value, "cancelJob") === "function"
  );
}

/**
 * 网关回包的形状判据。
 *
 * 只认「对象且带一个布尔 `ok` 位」：`ok` 缺席时后面那句 `result.error.code` 会在读属性上
 * 抛 `Cannot read properties of undefined`，症状是一条没有协议含义的崩溃而不是「回包坏了」。
 *
 * **失败那一支的形状由 `failureOf` 兜**，不在这里拦：`{ ok: false }`、`{ ok: false, error:
 * null }`、`{ ok: false, error: { code: 500 } }` 这三类「位置对、形状坏」的回包在运行期真会
 * 出现（对端可能是另一个版本的插件、可能被中间层改写、也可能自己就是坏的），而它们的正确
 * 归宿是「带一条占位码的失败回执」（`REMOTE_BAD_ENVELOPE`）而不是「回包格式非法」—— 后者会
 * 把对端报上来的失败说成客户端这边的解析问题，用户读到的成因而此反过来。类型只在编译期
 * 成立，这条分工是运行期的判据。
 *
 * @param value - 网关交回的任意值
 * @returns 是否是这条协议的回包
 */
function isWireResult(value: unknown): value is RemoteResult<unknown> {
  return isRecord(value) && typeof field(value, "ok") === "boolean";
}

/**
 * 把坏回包说成一句能读的话，且**保证这句话本身不会抛**。
 *
 * 不用 `JSON.stringify`：回包里有循环引用或 bigint 时它自己抛 `TypeError`，把「对端答了坏包」
 * 换成 `Converting circular structure to JSON`；回包很大时还会把整份载荷塞进错误文案，而这张
 * 卡的消费者是 `setFailure(String(error))`，它会原样渲染出来。
 */
function describeEnvelope(value: unknown): string {
  if (!isRecord(value)) {
    return typeof value;
  }
  const keys = Object.keys(value);
  return keys.length === 0 ? "{}" : `{ ${keys.join(", ")} }`;
}

/**
 * 失败回执里那枚错误对象；形状对不上时给出占位码而不是崩在读属性上。
 *
 * 走到这里的前提是 `isWireResult` 已经判过 `error` 是对象且 `code` 是字符串，所以本函数只
 * 补 `message` 一位 —— 但**不假设**它一定在：`RemoteFailure` 的各码对 message 的要求在类型
 * 上并不统一，缺它时给空串比给 `undefined` 好（后者会被拼成字面量 `undefined`）。
 *
 * @param result - 失败那一支的回包（已由 `isWireResult` 收窄）
 * @returns `code` 与 `message`
 */
function failureOf(result: Extract<RemoteResult<unknown>, { readonly ok: false }>): {
  readonly code: string;
  readonly message: string;
} {
  const raw: unknown = result.error;
  const code = isRecord(raw) ? field(raw, "code") : undefined;
  const message = isRecord(raw) ? field(raw, "message") : undefined;
  return {
    code: typeof code === "string" && code !== "" ? code : "REMOTE_BAD_ENVELOPE",
    message: typeof message === "string" ? message : "",
  };
}

async function unwrapWire<Value>(
  call: Promise<RemoteResult<unknown>>,
  schema: z.ZodType<Value>,
): Promise<Value> {
  const result = await call;
  if (!isWireResult(result)) {
    throw new TypeError(
      `runtime remote returned a malformed envelope: ${describeEnvelope(result)}`,
    );
  }
  if (result.ok) {
    return parseOrThrow(schema, result.value);
  }
  // 失败那一支只把码拼进文案：这张卡的唯一消费者是 `setFailure(String(error))`
  // （src/settings-card.ts 的三处 catch），没有人按码分流，所以不再另立一枚错误类。
  const failure = failureOf(result);
  throw new Error(`${failure.code}: ${failure.message}`);
}

function buildReader(ctx: RemoteHost): RuntimeReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RuntimeNamespace> => {
    const mounter = ctx.get?.("remote");
    if (!isRemoteMounter(mounter)) {
      throw new Error("运行环境读面不可用：宿主网关没有提供 remote 服务");
    }
    try {
      mounted ??= mounter.$mount({ package: PACKAGE_NAME, descriptors: RUNTIME_DESCRIPTORS });
      await mounted;
    } catch (error) {
      // 挂载失败不留在缓存里：rejected promise 复用会让之后每次点击都撞同一个 rejection。
      mounted = undefined;
      throw error;
    }
    const namespace = ctx.get?.(SERVICE_KEY, false);
    if (!isNamespace(namespace)) {
      // 挂载已 resolve 但这枚命名空间取不到（网关重启后命名空间被摘掉、服务注册滞后一拍、
      // 或 `isNamespace` 因方法缺失判假）：**同样清缓存**。不清的话 `mounted` 是一条已
      // resolve 的 promise，此后每次调用都跳过挂载、复现同一条「未提供」错误，读取器永久
      // 卡死且无从自愈 —— 用户只能刷新页面。
      mounted = undefined;
      throw new Error(`${SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    async status(): Promise<RuntimeStatusResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.status(), STATUS_SCHEMA);
    },
    async install(pack: RuntimePack): Promise<RuntimeActionResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.installPack({ pack }), ACTION_SCHEMA);
    },
    async repair(pack: RuntimePack): Promise<RuntimeActionResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.repairPack({ pack }), ACTION_SCHEMA);
    },
    async cancel(jobId: string): Promise<RuntimeActionResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.cancelJob({ jobId }), ACTION_SCHEMA);
    },
  };
}

/** 造读取器；连 `ctx.get` 面都没有时返回 undefined（卡片改为显示 CLI 命令）。 */
export function createRuntimeReader(ctx: RemoteHost): RuntimeReader | undefined {
  return typeof ctx.get === "function" ? buildReader(ctx) : undefined;
}
