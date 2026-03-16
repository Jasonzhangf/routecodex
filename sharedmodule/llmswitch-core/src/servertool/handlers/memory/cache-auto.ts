/**
 * CACHE.md 响应侧自动写入（auto hook）
 *
 * 在 resp_process.stage3_servertool_orchestration 阶段触发
 * 仅当 finish_reason === 'stop' 时写入 assistant 响应
 */

import type {
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan
} from '../../types.js';
import { registerServerToolHandler } from '../../registry.js';
import {
  writeCacheEntry,
  resolveWorkingDirectoryFromAdapterContextOrFallback,
  extractAssistantTextFromResponse,
  extractFinishReason
} from './cache-writer.js';

const FLOW_ID = 'memory_cache_auto';

const handler: ServerToolHandler = async (
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | null> => {
  try {
    // 1. 解析工作目录
    const workingDirectory = resolveWorkingDirectoryFromAdapterContextOrFallback(
      ctx.adapterContext as Record<string, unknown>
    );

    if (!workingDirectory) {
      console.error(
        `[memory_cache_auto] skip: no workingDirectory for requestId=${ctx.requestId}`
      );
      return null;
    }

    // 2. 检查 response 是否有 finish_reason = 'stop'
    const chatResponse = ctx.base;
    const finishReason = extractFinishReason(chatResponse);

    if (!finishReason || finishReason.toLowerCase() !== 'stop') {
      // 不是 stop，跳过
      return null;
    }

    // 3. 提取 assistant 文本
    const content = extractAssistantTextFromResponse(chatResponse);
    if (!content) {
      console.error(
        `[memory_cache_auto] skip: no assistant content for requestId=${ctx.requestId}`
      );
      return null;
    }

    // 4. 构建写入选项
    const writeOptions = {
      type: 'response' as const,
      workingDirectory,
      requestId: ctx.requestId,
      sessionId: (ctx.adapterContext as any).sessionId,
      timestampMs: Date.now(),
      role: 'assistant' as const,
      content,
      metadata: {
        model: (chatResponse as any).model,
        providerProtocol: ctx.providerProtocol,
        finishReason
      }
    };

    // 5. 写入（错误已在内部处理）
    const result = writeCacheEntry(writeOptions);
    if (result.ok) {
      // 可选：记录成功日志
    }

    // 6. 返回 null（不修改 response，只是记录）
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[memory_cache_auto] unexpected error: ${message}`);
    return null;
  }
};

// 注册为 auto hook（default 阶段，优先级 100）
registerServerToolHandler('memory_cache_auto', handler, {
  trigger: 'auto',
  phase: 'default',
  priority: 100
});
