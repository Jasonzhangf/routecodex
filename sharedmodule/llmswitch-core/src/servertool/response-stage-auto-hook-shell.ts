import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import {
  resolveServertoolResponseStageAutoHookPostDecisionWithNative,
  resolveServertoolResponseStageAutoHookPreDecisionWithNative
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
  const preAutoHookDecision = resolveServertoolResponseStageAutoHookPreDecisionWithNative({
    responseStageGatePlan: args.responseStageGatePlan
  });
  if (preAutoHookDecision.action === 'return_pass_result') {
    return preAutoHookDecision.result;
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
    autoHookResult
  });
  if (postAutoHookDecision.action === 'throw_required_response_hook_empty') {
    throw createServertoolProviderProtocolErrorFromPlan(postAutoHookDecision.errorPlan);
  }
  return postAutoHookDecision.result;
}
