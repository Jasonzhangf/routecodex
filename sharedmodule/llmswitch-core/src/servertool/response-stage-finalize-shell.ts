import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import { planServertoolResponseStageRuntimeActionWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export async function finalizeServertoolResponseStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: Record<string, unknown>;
}): Promise<ServerSideToolEngineResult> {
  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan
  });
  const autoHookResult = 'result' in responseStageAutoHook ? responseStageAutoHook.result : null;
  const finalizeRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    autoHookEvaluated: true,
    hasAutoHookResult: autoHookResult != null
  });
  if (finalizeRuntimeAction.action === 'return_auto_hook_result') {
    if (autoHookResult == null) {
      throw new Error('native response-stage finalize requested auto-hook result but result was empty');
    }
    return autoHookResult;
  }
  return { mode: 'passthrough', finalChatResponse: args.baseObject };
}
