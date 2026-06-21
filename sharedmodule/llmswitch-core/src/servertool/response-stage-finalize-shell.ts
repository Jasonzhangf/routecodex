import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { planServertoolResponseStageGateWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';

export async function finalizeServertoolResponseStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  initialResponseStageGatePlan?: Record<string, unknown>;
}): Promise<ServerSideToolEngineResult> {
  const responseStagePlan =
    args.initialResponseStageGatePlan?.responseHookMatched === true
      ? args.initialResponseStageGatePlan
      : planServertoolResponseStageGateWithNative({
          payload: args.baseObject,
          adapterContext: args.options.adapterContext as Record<string, unknown>
        });

  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: responseStagePlan as Record<string, unknown>
  });
  if (responseStageAutoHook.action === 'return_passthrough_bypass') {
    return { mode: 'passthrough', finalChatResponse: args.baseObject };
  }
  if (responseStageAutoHook.action === 'return_auto_hook_result') {
    return responseStageAutoHook.result;
  }
  return { mode: 'passthrough', finalChatResponse: args.baseObject };
}
