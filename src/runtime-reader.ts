// 设置卡读宿主侧 runtime 的那一面（官方 Typert Remote 的消费侧）。
//
// descriptor 手写：网关在源模式下按方法签名取参数名，参数与结果都走 src-json；客户端贡献
// 校验要求每个入参带 strict codec，所以这里手写 parser，只在本进程校验形状、不跨网。
//
// remote 走 `ctx.get("remote")` 而不是 inject：没有远程面的部署里整张卡仍要渲染，把
// `remote` 写进 inject 会让整条 client 入口不激活。

import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { RUNTIME_REMOTE_NAMESPACE, isRuntimePack } from "../lib/runtime-shape.ts";
import type {
  RuntimeActionResult,
  RuntimeCancelRequest,
  RuntimePack,
  RuntimePackRequest,
  RuntimeStatusResult,
} from "../lib/runtime-shape.ts";

const PACKAGE_NAME = "@jayyuen66/dsh-scrapling";

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}
const NAMESPACE = RUNTIME_REMOTE_NAMESPACE;
const SERVICE_KEY = `remote.${NAMESPACE}`;

const PACK_CODEC: TypertCodec<RuntimePackRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#runtime-pack-request`,
  create: () => ({
    parse(value: unknown): RuntimePackRequest {
      const pack = isRecord(value) ? field(value, "pack") : undefined;
      if (!isRuntimePack(pack)) {
        throw new TypeError("runtime request requires a known pack");
      }
      return { pack };
    },
  }),
};

const CANCEL_CODEC: TypertCodec<RuntimeCancelRequest> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#runtime-cancel-request`,
  create: () => ({
    parse(value: unknown): RuntimeCancelRequest {
      const jobId = isRecord(value) ? field(value, "jobId") : undefined;
      if (typeof jobId !== "string" || jobId.length === 0) {
        throw new TypeError("runtime cancel requires a jobId");
      }
      return { jobId };
    },
  }),
};

/** 宿主四个方法的客户端描述符；测试拿它与宿主侧 `remoteMethods()` 对质。 */
export const RUNTIME_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${NAMESPACE}/status`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: "status",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${NAMESPACE}/installPack`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: "installPack",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: PACK_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${NAMESPACE}/repairPack`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: "repairPack",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: PACK_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${NAMESPACE}/cancelJob`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: "cancelJob",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: CANCEL_CODEC }],
    result: { mode: "src-json" },
  },
];

export interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

interface RemoteMounter {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

interface RuntimeNamespace {
  status: () => Promise<RemoteResult<RuntimeStatusResult>>;
  installPack: (request: RuntimePackRequest) => Promise<RemoteResult<RuntimeActionResult>>;
  repairPack: (request: RuntimePackRequest) => Promise<RemoteResult<RuntimeActionResult>>;
  cancelJob: (request: RuntimeCancelRequest) => Promise<RemoteResult<RuntimeActionResult>>;
}

export interface RuntimeReader {
  status: () => Promise<RuntimeStatusResult>;
  install: (pack: RuntimePack) => Promise<RuntimeActionResult>;
  repair: (pack: RuntimePack) => Promise<RuntimeActionResult>;
  cancel: (jobId: string) => Promise<RuntimeActionResult>;
}

function isMounter(value: unknown): value is RemoteMounter {
  return isRecord(value) && typeof field(value, "$mount") === "function";
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

async function unwrapWire<Value>(
  call: Promise<
    { ok: false; error: { code: string; message: string } } | { ok: true; value: Value }
  >,
): Promise<Value> {
  const result = await call;
  if (result.ok) {
    return result.value;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

function buildReader(ctx: RemoteHost): RuntimeReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RuntimeNamespace> => {
    const mounter = ctx.get?.("remote");
    if (!isMounter(mounter)) {
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
      throw new Error(`${SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    async status(): Promise<RuntimeStatusResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.status());
    },
    async install(pack: RuntimePack): Promise<RuntimeActionResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.installPack({ pack }));
    },
    async repair(pack: RuntimePack): Promise<RuntimeActionResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.repairPack({ pack }));
    },
    async cancel(jobId: string): Promise<RuntimeActionResult> {
      const namespace = await namespaceOf();
      return unwrapWire(namespace.cancelJob({ jobId }));
    },
  };
}

/** 造读取器；连 `ctx.get` 面都没有时返回 undefined（卡片改为显示 CLI 命令）。 */
export function createRuntimeReader(ctx: RemoteHost): RuntimeReader | undefined {
  return typeof ctx.get === "function" ? buildReader(ctx) : undefined;
}
