/**
 * Minimal ErrorHandlingCenter shim.
 *
 * 说明：
 * - 上游 rcc-errorhandling 在本地 dev 环境中缺失 dist 构建产物；
 * - RouteCodex V2 服务器主要依赖其统一错误记录与销毁生命周期；
 * - 为保持 dev/worktree 可运行，这里提供一个最小实现：
 *   - initialize/destroy 为 no-op；
 *   - handleError 简单输出到控制台，避免吞掉错误。
 */

export class ErrorHandlingCenter {
  async initialize(): Promise<void> {
    // no-op for local dev
  }

  async destroy(): Promise<void> {
    // no-op for local dev
  }

  async handleError(error: Error, context: string): Promise<void> {
    // 基本错误输出，方便本地调试
    // eslint-disable-next-line no-console
    console.error(`[ErrorHandlingCenter][${context}]`, error);
  }
}

