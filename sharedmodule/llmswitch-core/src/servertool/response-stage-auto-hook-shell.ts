import type {
  JsonObject,
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import {
  resolveServertoolResponseStageAutoHookPostApplicationWithNative,
  resolveServertoolResponseStageAutoHookPostDecisionWithNative,
  resolveServertoolResponseStageAutoHookPreApplicationWithNative,
  resolveServertoolResponseStageAutoHookPreDecisionWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import type { NativeServertoolResponseStageGate } from 'rcc-llmswitch-core/native/servertool-wrapper';
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
  baseObject: JsonObject;
}): Promise<ServertoolResponseStageAutoHookPassResult> {
  const preAutoHookDecision = resolveServertoolResponseStageAutoHookPreDecisionWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject
  });
  const preAutoHookApplication = resolveServertoolResponseStageAutoHookPreApplicationWithNative({
    decision: preAutoHookDecision
  });
  if (preAutoHookApplication.returnPassResult) {
    return preAutoHookApplication.result;
  }
  if (!preAutoHookApplication.runAutoHooks) {
    throw new Error('[servertool] invalid response-stage pre auto-hook application');
  }

  const autoHookResult = await runServertoolAutoHookCaller({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds
  });
  const postAutoHookDecision = resolveServertoolResponseStageAutoHookPostDecisionWithNative({
    requestId: args.options.requestId,
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject,
    autoHookResult
  });
  const postAutoHookApplication = resolveServertoolResponseStageAutoHookPostApplicationWithNative({
    decision: postAutoHookDecision
  });
  if (postAutoHookApplication.throwRequiredResponseHookEmpty) {
    throw createServertoolProviderProtocolErrorFromPlan(postAutoHookApplication.errorPlan);
  }
  if (!postAutoHookApplication.returnPassResult) {
    throw new Error('[servertool] invalid response-stage post auto-hook application');
  }
  return postAutoHookApplication.result;
}
