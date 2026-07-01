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
  switch (finalizeRuntimeAction.action) {
    case 'return_auto_hook_result':
      return autoHookResult as ServerSideToolEngineResult;
    case 'return_passthrough_bypass':
    case 'return_passthrough_no_auto_hook_result':
      return { mode: finalizeRuntimeAction.resultMode, finalChatResponse: args.baseObject };
    default:
      throw new Error(
        `[servertool] invalid response-stage finalize action: ${String((finalizeRuntimeAction as { action: string }).action)}`
      );
  }
}
