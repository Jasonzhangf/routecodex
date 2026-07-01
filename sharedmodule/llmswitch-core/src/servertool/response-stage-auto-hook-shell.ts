import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import {
  planServertoolRequiredResponseHookEmptyErrorWithNative,
  planServertoolResponseStageRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { runServertoolAutoHookCaller } from './auto-hook-caller.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export type ServertoolResponseStageAutoHookPassResult =
  | { action: 'return_passthrough_bypass'; result?: never }
  | { action: 'continue_without_result'; result?: never }
  | { action: 'return_auto_hook_result'; result: ServerSideToolEngineResult };

function hasServerSideToolEngineResult(
  value: ServerSideToolEngineResult | null
): value is ServerSideToolEngineResult {
  return value !== null;
}

export async function runServertoolResponseStageAutoHookPass(args: {
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: Record<string, unknown>;
}): Promise<ServertoolResponseStageAutoHookPassResult> {
  const preAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  switch (preAutoHookRuntimeAction.action) {
    case 'return_passthrough_bypass':
      return { action: 'return_passthrough_bypass' };
    case 'run_auto_hooks':
      break;
    default:
      throw new Error(
        `[servertool] invalid response-stage pre auto-hook action: ${String(
          (preAutoHookRuntimeAction as { action: string }).action
        )}`
      );
  }

  const autoHookResult = await runServertoolAutoHookCaller({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds
  });
  const postAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    autoHookEvaluated: true,
    hasAutoHookResult: hasServerSideToolEngineResult(autoHookResult)
  });
  switch (postAutoHookRuntimeAction.action) {
    case 'return_required_response_hook_empty':
      throw createServertoolProviderProtocolErrorFromPlan(
        planServertoolRequiredResponseHookEmptyErrorWithNative({
          requestId: args.options.requestId,
          responseHookName: postAutoHookRuntimeAction.responseHookName
        })
      );
    case 'return_auto_hook_result':
      if (!hasServerSideToolEngineResult(autoHookResult)) {
        throw new Error('[servertool] invalid response-stage auto-hook result action without result');
      }
      return {
        action: 'return_auto_hook_result',
        result: autoHookResult
      };
    case 'return_passthrough_no_auto_hook_result':
      break;
    default:
      throw new Error(
        `[servertool] invalid response-stage post auto-hook action: ${String(
          (postAutoHookRuntimeAction as { action: string }).action
        )}`
      );
  }

  return { action: 'continue_without_result' };
}
