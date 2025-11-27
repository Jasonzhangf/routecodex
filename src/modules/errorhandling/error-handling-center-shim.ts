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

type ErrorContextPayload = {
  error?: unknown;
  source?: string;
  severity?: unknown;
  timestamp?: number;
  [key: string]: unknown;
};

export class ErrorHandlingCenter {
  async initialize(): Promise<void> {
    // no-op for local dev
  }

  async destroy(): Promise<void> {
    // no-op for local dev
  }

  async handleError(error: unknown, context?: unknown): Promise<void> {
    const prefix = '[ErrorHandlingCenter]';

    if (this.isErrorContextPayload(error)) {
      // eslint-disable-next-line no-console
      console.error(prefix, { context, errorContext: error });
      return;
    }

    const normalizedError = this.normalizeError(error);

    if (typeof context === 'string' && context.trim().length > 0) {
      // eslint-disable-next-line no-console
      console.error(`${prefix}[${context}]`, normalizedError);
      return;
    }

    // eslint-disable-next-line no-console
    console.error(prefix, { context, error: normalizedError });
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    if (typeof error === 'string') {
      return new Error(error);
    }
    try {
      return new Error(JSON.stringify(error));
    } catch {
      return new Error(String(error));
    }
  }

  private isErrorContextPayload(payload: unknown): payload is ErrorContextPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    return 'error' in payload && 'source' in payload;
  }
}
