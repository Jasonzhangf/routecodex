/**
 * Server Request Logging Hook
 *
 * 按照现有规范实现的请求日志Hook
 * 命名: server.01.request-logging
 */

import type { UnknownObject } from '../../../types/common-types.js';
import type {
  IBidirectionalHook,
  HookExecutionContext,
  HookResult,
  HookDataPacket
} from '../../../modules/hooks/types/hook-types.js';
import {
  UnifiedHookStage
} from '../../../modules/hooks/types/hook-types.js';

/**
 * Server请求日志Hook
 */
export class ServerRequestLoggingHook implements IBidirectionalHook {
  readonly name = 'server.01.request-logging';
  readonly stage: UnifiedHookStage = UnifiedHookStage.PIPELINE_PREPROCESSING;
  readonly priority = 10;
  readonly target = 'request' as const;
  readonly isDebugHook = true;

  async execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookResult> {
    const startTime = Date.now();
    const requestData = data.data as UnknownObject;

    console.log(`[ServerRequestLoggingHook] Processing request:`, {
      requestId: context.requestId,
      stage: context.stage,
      dataSize: data.metadata?.size || 0,
      timestamp: new Date().toISOString()
    });

    // 记录请求基本信息到元数据
    const enrichedMetadata = {
      requestInfo: {
        requestId: context.requestId,
        stage: context.stage,
        timestamp: Date.now(),
        serverVersion: 'v2'
      },
      originalMetadata: data.metadata
    };

    return {
      success: true,
      data: requestData, // 不修改原始数据
      metadata: enrichedMetadata,
      executionTime: Date.now() - startTime
    };
  }
}