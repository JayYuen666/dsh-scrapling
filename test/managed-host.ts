// 安装器与 runtime 解析只承诺 macOS arm64（`installerSupported()`），而这两条腿的用例
// 在任何 CI 上都要跑：Linux 上按真实平台跑，量到的是「六个包全 blocked」，不是安装逻辑。
// 所以用例显式把自己伪装成承诺平台，另外单独留一条用例钉「非承诺平台 → blocked」。
//
// 用 defineProperty 而不是 vi.spyOn：同一进程里可能嵌套（文件级伪装 + 单条用例改成
// linux），保存/恢复原始描述符才能嵌套而不互相踩。

/** 把 process.platform / process.arch 伪装成给定值，返回恢复函数。 */
export function mockPlatform(platform: string, arch: string): () => void {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const savedArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { configurable: true, get: () => platform });
  Object.defineProperty(process, "arch", { configurable: true, get: () => arch });
  return () => {
    if (savedPlatform !== undefined) {
      Object.defineProperty(process, "platform", savedPlatform);
    }
    if (savedArch !== undefined) {
      Object.defineProperty(process, "arch", savedArch);
    }
  };
}
