/**
 * Minimal BaseModule shim for ConfigManagerModule.
 *
 * 说明：
 * - 上游 rcc-basemodule 在当前开发环境中缺失 dist 构建产物，
 *   直接 import 会在运行时触发 ESM 解析错误。
 * - ConfigManagerModule 只依赖 BaseModule 的元信息和运行状态接口，
 *   不使用更复杂的模块系统特性。
 * - 为了在不修改 node_modules 的前提下保证 dev/worktree 可运行，
 *   这里实现一个最小可用的 BaseModule 替身，仅供本模块内部使用。
 */

export interface BaseModuleInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
}

// Alias to keep naming parity with upstream rcc-basemodule types
export type ModuleInfo = BaseModuleInfo & { type?: string };

export abstract class BaseModule {
  private readonly info: BaseModuleInfo;
  private running = false;

  protected constructor(info: BaseModuleInfo) {
    this.info = info;
  }

  getInfo(): BaseModuleInfo {
    return this.info;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 统一事件日志入口（与上游 BaseModule 行为对齐的最小实现）
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected logEvent(_category: string, _event: string, _data?: unknown): void {
    // 本地 dev 场景：默认静默；可按需改为 console.debug
  }

  /**
   * 统一错误处理入口（与上游 BaseModule 行为对齐的最小实现）
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async handleError(_error: Error, _context: string): Promise<void> {
    // 本地 dev 场景：默认交由调用方自行处理
  }

  /**
   * 子类可显式标记运行状态；当前 ConfigManagerModule 未使用，
   * 仅为兼容潜在的 BaseModule 接口预留。
   */
  protected setRunning(running: boolean): void {
    this.running = running;
  }
}
