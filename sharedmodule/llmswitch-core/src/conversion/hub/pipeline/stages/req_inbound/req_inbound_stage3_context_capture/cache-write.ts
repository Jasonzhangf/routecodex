/**
 * 请求侧 CACHE.md 写入
 *
 * 在 req_inbound.stage3_context_capture 阶段调用，写入用户请求
 */

import type { ContextCaptureOptions } from './context-capture-orchestration.js';
import {
  writeCacheEntry,
  resolveWorkingDirectoryFromAdapterContextOrFallback,
  extractUserTextFromRequest,
  shouldLogNoWorkingDirectorySkip
} from '../../../../../../servertool/handlers/memory/cache-writer.js';

/**
 * 写入请求到 CACHE.md
 *
 * 错误处理：内部 console.error，不影响主流程
 */
export function writeCacheEntryForRequest(options: ContextCaptureOptions): void {
  try {
    // 1. 解析工作目录
    const workingDirectory = resolveWorkingDirectoryFromAdapterContextOrFallback(
      options.adapterContext as Record<string, unknown>
    );

    if (!workingDirectory) {
      if (shouldLogNoWorkingDirectorySkip(options.adapterContext as Record<string, unknown>)) {
        console.error(
          `[req_inbound.cache] skip: no workingDirectory for requestId=${options.adapterContext.requestId}`
        );
      }
      return;
    }

    // 2. 提取用户文本（兼容 chat / responses）
    const rawRequest = options.rawRequest;
    const content = extractUserTextFromRequest(rawRequest as any);
    if (!content) {
      console.error(
        `[req_inbound.cache] skip: no user message for requestId=${options.adapterContext.requestId}`
      );
      return;
    }

    // 3. 构建写入选项
    const writeOptions = {
      type: 'request' as const,
      workingDirectory,
      requestId: options.adapterContext.requestId,
      sessionId: (options.adapterContext as any).sessionId,
      timestampMs: Date.now(),
      role: 'user' as const,
      content,
      metadata: {
        model: (rawRequest as any).model,
        providerProtocol: options.adapterContext.providerProtocol
      }
    };

    // 4. 写入（错误已在内部处理）
    const result = writeCacheEntry(writeOptions);
    if (result.ok) {
      // 可选：记录成功日志
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[req_inbound.cache] unexpected error: ${message}`);
  }
}
