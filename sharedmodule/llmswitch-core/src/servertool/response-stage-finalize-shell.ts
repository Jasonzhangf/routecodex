import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import { planServertoolResponseStageRuntimeActionWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import type { NativeServertoolResponseStageGate } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export async function finalizeServertoolResponseStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: NativeServertoolResponseStageGate;
}): Promise<ServerSideToolEngineResult> {
  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan
  });
  const finalizeRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject,
    autoHookEvaluated: true,
    hasAutoHookResult: responseStageAutoHook.action === 'return_auto_hook_result'
  });
  switch (finalizeRuntimeAction.action) {
    case 'return_auto_hook_result':
      return responseStageAutoHook.result;
    case 'return_passthrough_bypass':
    case 'return_passthrough_no_auto_hook_result':
      return finalizeRuntimeAction.passthroughResult as ServerSideToolEngineResult;
    default:
      throw new Error('[servertool] invalid response-stage finalize action');
  }
}
