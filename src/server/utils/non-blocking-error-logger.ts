import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

export interface NonBlockingErrorMeta {
  component: string;
  operation: string;
  level?: 'warn' | 'error' | 'debug';
  requestId?: string;
  entryEndpoint?: string;
  [key: string]: unknown;
}

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.routecodex', 'logs');
const DEFAULT_LOG_PATH = path.join(DEFAULT_LOG_DIR, 'non-blocking-errors.log');

function resolveLogPath(): string {
  const envPath = process.env.ROUTECODEX_INTERNAL_ERROR_LOG || process.env.RCC_INTERNAL_ERROR_LOG;
  if (envPath && typeof envPath === 'string') {
    return envPath;
  }
  return DEFAULT_LOG_PATH;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!error) {
    return { message: 'unknown' };
  }
  if (error instanceof Error) {
    const out: Record<string, unknown> = {
      name: error.name,
      message: error.message
    };
    if ('code' in error && (error as { code?: unknown }).code !== undefined) {
      out.code = (error as { code?: unknown }).code;
    }
    if (error.stack) {
      out.stack = error.stack;
    }
    return out;
  }
  if (typeof error === 'object') {
    try {
      return {
        message: JSON.stringify(error)
      };
    } catch {
      return { message: String(error) };
    }
  }
  return { message: String(error) };
}

/**
 * 记录非阻塞错误到独立 JSONL 文件中，绝不向调用方抛出异常
 */
export async function logNonBlockingError(meta: NonBlockingErrorMeta, error: unknown): Promise<void> {
  try {
    const logPath = resolveLogPath();
    const dir = path.dirname(logPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    const record = {
      ts: new Date().toISOString(),
      level: meta.level || 'warn',
      component: meta.component,
      operation: meta.operation,
      requestId: meta.requestId,
      entryEndpoint: meta.entryEndpoint,
      meta,
      error: serializeError(error)
    };
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    // 最后兜底：不打断主流程，必要时可以考虑加一次性 console.error，但避免刷屏
  }
}

/**
 * 运行一个“非阻塞”操作，失败时记录错误但不抛出
 */
export async function runNonBlocking(meta: NonBlockingErrorMeta, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    await logNonBlockingError(meta, error);
  }
}
