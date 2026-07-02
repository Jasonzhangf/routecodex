import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import {
  planServertoolRequiredResponseHookEmptyErrorWithNative,
  planServertoolResponseStageRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import type { NativeServertoolResponseStageGate } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { runServertoolAutoHookCaller } from './auto-hook-caller.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export type ServertoolResponseStageAutoHookPassResult =
  | { action: 'return_passthrough_bypass'; result?: never }
  | { action: 'continue_without_result'; result?: never }
  | { action: 'return_auto_hook_result'; result: ServerSideToolEngineResult };

export async function runServertoolResponseStageAutoHookPass(args: {
  options: ServerSideToolEngineOptions;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: NativeServertoolResponseStageGate;
}): Promise<ServertoolResponseStageAutoHookPassResult> {
  const preAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  switch (preAutoHookRuntimeAction.action) {
    case 'return_passthrough_bypass':
      return preAutoHookRuntimeAction.passResult;
    case 'run_auto_hooks':
      break;
    default:
      throw new Error('[servertool] invalid response-stage pre auto-hook action');
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
    hasAutoHookResult: autoHookResult != null,
    autoHookResult
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
      if (autoHookResult == null) {
        throw new Error('[servertool] invalid response-stage auto-hook result action without result');
      }
      return postAutoHookRuntimeAction.passResult;
    case 'return_passthrough_no_auto_hook_result':
      break;
    default:
      throw new Error('[servertool] invalid response-stage post auto-hook action');
  }

  return postAutoHookRuntimeAction.passResult;
}
