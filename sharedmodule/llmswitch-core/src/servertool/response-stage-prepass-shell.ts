import type {
  ServerSideToolEngineOptions,
  ServerToolHandlerContext
} from './types.js';
import type { ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolResponseStageGateWithNative,
  type NativeServertoolResponseStageGate
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { planServertoolResponseStageRuntimeActionWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import { readRuntimeControlFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

export async function runServertoolResponseStagePrePass(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): Promise<
  | { action: 'continue_to_execution'; responseStageGatePlan: NativeServertoolResponseStageGate }
  | {
      action: 'return_result';
      responseStageGatePlan: NativeServertoolResponseStageGate;
      result: ServerSideToolEngineResult;
    }
> {
  const responseStageGatePlan = planServertoolResponseStageGateWithNative({
    payload: args.baseObject,
    adapterContext: args.options.adapterContext,
    runtimeControl: readRuntimeControlFromAnyBoundMetadataCenter(
      args.options.adapterContext
    )
  });

  const prepassRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });

  switch (prepassRuntimeAction.action) {
    case 'run_auto_hooks':
      break;
    case 'return_passthrough_no_auto_hook_result':
      return prepassRuntimeAction.prepassResult;
    default:
      throw new Error('[servertool] invalid response-stage prepass action');
  }

  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan
  });
  switch (responseStageAutoHook.action) {
    case 'return_auto_hook_result':
      {
        const postAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
          responseStageGatePlan,
          autoHookEvaluated: true,
          hasAutoHookResult: true,
          autoHookResult: responseStageAutoHook.result
        });
        if (postAutoHookRuntimeAction.action !== 'return_auto_hook_result') {
          throw new Error('[servertool] invalid response-stage prepass auto-hook post action');
        }
        return postAutoHookRuntimeAction.prepassResult;
      }
    case 'continue_without_result':
    case 'return_passthrough_bypass':
      {
        const postAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative({
          responseStageGatePlan,
          autoHookEvaluated: true,
          hasAutoHookResult: false
        });
        if (
          postAutoHookRuntimeAction.action !== 'return_passthrough_bypass' &&
          postAutoHookRuntimeAction.action !== 'return_passthrough_no_auto_hook_result'
        ) {
          throw new Error('[servertool] invalid response-stage prepass post action');
        }
        return postAutoHookRuntimeAction.prepassResult;
      }
    default:
      throw new Error('[servertool] invalid response-stage prepass auto-hook action');
  }
}
