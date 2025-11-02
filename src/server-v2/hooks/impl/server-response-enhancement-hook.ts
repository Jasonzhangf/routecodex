/**
 * Server Response Enhancement Hook
 *
 * 按照现有规范实现的响应增强Hook
 * 命名: server.02.response-enhancement
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
 * Server响应增强Hook
 */
export class ServerResponseEnhancementHook implements IBidirectionalHook {
  readonly name = 'server.02.response-enhancement';
  readonly stage: UnifiedHookStage = UnifiedHookStage.RESPONSE_POSTPROCESSING;
  readonly priority = 20;
  readonly target = 'response' as const;
  readonly isDebugHook = false;

  async execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookResult> {
    const startTime = Date.now();
    const responseData = data.data as UnknownObject;

    // 增强响应数据
    if (responseData && typeof responseData === 'object') {
      const enhancedResponse = { ...responseData };

      // 添加服务器版本信息
      (enhancedResponse as any).serverInfo = {
        version: 'v2',
        requestId: context.requestId,
        processedAt: new Date().toISOString(),
        stage: context.stage
      };

      console.log(`[ServerResponseEnhancementHook] Enhanced response for request: ${context.requestId}`);

      return {
        success: true,
        data: enhancedResponse,
        metadata: {
          responseEnhanced: true,
          enhancementTime: Date.now() - startTime
        },
        executionTime: Date.now() - startTime
      };
    }

    // 如果不是对象类型，直接返回
    return {
      success: true,
      data: responseData,
      metadata: {
        responseEnhanced: false,
        reason: 'Response data is not an object'
      },
      executionTime: Date.now() - startTime
    };
  }
}