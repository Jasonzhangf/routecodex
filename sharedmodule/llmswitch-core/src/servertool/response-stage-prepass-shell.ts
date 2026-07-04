import type {
  ServerSideToolEngineOptions,
  ServerToolHandlerContext
} from './types.js';
import type { ServerSideToolEngineResult } from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolResponseStageGateWithNative,
  type NativeServertoolResponseStageGate
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  resolveServertoolResponseStagePrepassInitialApplicationWithNative,
  resolveServertoolResponseStagePrepassAfterAutoHookWithNative,
  resolveServertoolResponseStagePrepassInitialDecisionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
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
    ),
    allowFollowup: false
  });

  const prepassDecision = resolveServertoolResponseStagePrepassInitialDecisionWithNative({
    responseStageGatePlan,
    baseObject: args.baseObject
  });

  const initialApplication = resolveServertoolResponseStagePrepassInitialApplicationWithNative({
    decision: prepassDecision
  });
  if (initialApplication.runAutoHook === false) {
    return initialApplication.result;
  }

  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan,
    baseObject: args.baseObject
  });
  return resolveServertoolResponseStagePrepassAfterAutoHookWithNative({
    responseStageGatePlan,
    baseObject: args.baseObject,
    responseStageAutoHookResult: responseStageAutoHook
  }).result;
}
