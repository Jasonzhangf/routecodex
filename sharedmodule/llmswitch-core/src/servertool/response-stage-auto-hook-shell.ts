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

export async function runServertoolResponseStageAutoHookPass(args: {
  options: ServerSideToolEngineOptions;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: Record<string, unknown>;
}): Promise<
  | { action: 'return_passthrough_bypass' }
  | { action: 'continue_without_result' }
  | { action: 'return_auto_hook_result'; result: ServerSideToolEngineResult }
> {
  const preAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  if (preAutoHookRuntimeAction.action === 'return_passthrough_bypass') {
    return { action: 'return_passthrough_bypass' };
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
    hasAutoHookResult: Boolean(autoHookResult)
  });
  if (postAutoHookRuntimeAction.action === 'return_required_response_hook_empty') {
    throw createServertoolProviderProtocolErrorFromPlan(
      planServertoolRequiredResponseHookEmptyErrorWithNative({
        requestId: args.options.requestId,
        responseHookName: postAutoHookRuntimeAction.responseHookName as string
      })
    );
  }
  if (postAutoHookRuntimeAction.action === 'return_auto_hook_result') {
    if (!autoHookResult) {
      throw new Error('[servertool] native response-stage requested auto-hook result but result was empty');
    }
    return {
      action: 'return_auto_hook_result',
      result: autoHookResult
    };
  }

  return { action: 'continue_without_result' };
}
