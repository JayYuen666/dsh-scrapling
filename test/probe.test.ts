// test/probe.test.ts —— runProbe 的启动失败分支必须点名解释器路径（审查报告测试基建条目）。
//
// test/probe.ts 的注释原先承诺「挂 error 监听兜住其余启动失败」，但实现里没有那条监听：
// 启动失败只有 error 事件、永远没有 close，events.once(child, "close") 会以同一个错误拒绝，
// 于是用户读到的是一句裸 EACCES，分不清是解释器不可执行还是别的权限问题。
//
// 这里造一个**存在但不可执行**的解释器（不能用不存在的路径：那会在 existsSync 预检就被
// 换成「缺少探针解释器」，根本走不到 spawn）。权限位在 Windows 不成立，整条跳过。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProbe } from "./probe.ts";

describe("runProbe 的启动失败分支", () => {
  it.skipIf(process.platform === "win32")(
    "解释器在但不可执行时，报一句点名路径的话并把 EACCES 挂在 cause 上",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "dsh-probe-"));
      const interpreter = path.join(dir, "python-not-executable");
      writeFileSync(interpreter, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      try {
        await expect(runProbe({ pythonPath: interpreter })).rejects.toThrow(
          /探针起不来：.*python-not-executable/u,
        );
        await expect(runProbe({ pythonPath: interpreter })).rejects.toMatchObject({
          cause: { code: "EACCES" },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
