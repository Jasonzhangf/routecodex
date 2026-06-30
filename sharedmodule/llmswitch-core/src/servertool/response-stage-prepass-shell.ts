import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { planServertoolResponseStageGateWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import { readRuntimeControlFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

export async function runServertoolResponseStagePrePass(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): Promise<
  | { action: 'continue_to_execution'; responseStageGatePlan: Record<string, unknown> }
  | {
      action: 'return_result';
      responseStageGatePlan: Record<string, unknown>;
      result: ServerSideToolEngineResult;
    }
> {
  const responseStageGatePlan = planServertoolResponseStageGateWithNative({
    payload: args.baseObject,
    adapterContext: args.options.adapterContext as Record<string, unknown>,
    runtimeControl: readRuntimeControlFromAnyBoundMetadataCenter(
      args.options.adapterContext as Record<string, unknown>
    )
  }) as Record<string, unknown>;
  const continueToExecution = {
    action: 'continue_to_execution' as const,
    responseStageGatePlan
  };

  if (responseStageGatePlan.responseHookMatched !== true) {
    return continueToExecution;
  }

  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan
  });
  if (responseStageAutoHook.action === 'return_auto_hook_result') {
    return {
      action: 'return_result',
      responseStageGatePlan,
      result: responseStageAutoHook.result
    };
  }

  return continueToExecution;
}
