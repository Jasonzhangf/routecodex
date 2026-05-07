import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import { inspectStopGatewaySignal, isStopEligibleForServerTool } from './stop-gateway-context.js';
import { syncReasoningStopModeFromRequest } from './handlers/reasoning-stop-state.js';
import { getServerToolHandler } from './registry.js';

type ServerToolEngineRunner = (
  overrides: Partial<ServerSideToolEngineOptions>
) => Promise<ServerSideToolEngineResult>;

export async function runReasoningStopGuardPrepass(args: {
  chat: JsonObject;
  adapterContext: AdapterContext;
  stopSignal: ReturnType<typeof inspectStopGatewaySignal>;
  runEngine: ServerToolEngineRunner;
  logProgress: (step: number, total: number, message: string, extra?: Record<string, unknown>) => void;
  logStopEntry: (stage: 'entry' | 'trigger', result: string, extra?: Record<string, unknown>) => void;
}): Promise<{ chat: JsonObject; executed: true; flowId?: string } | null> {
  const reasoningStopMode = syncReasoningStopModeFromRequest(args.adapterContext);
  const reasoningStopGuardHandler = getServerToolHandler('reasoning_stop_guard');
  const reasoningStopGuardEnabled =
    reasoningStopGuardHandler &&
    reasoningStopGuardHandler.trigger === 'auto' &&
    reasoningStopGuardHandler.registration.executionMode === 'auto_hook';
  const reasoningStopEligible = isStopEligibleForServerTool(args.chat, args.adapterContext);

  if (
    !args.stopSignal.observed ||
    !reasoningStopGuardEnabled ||
    !reasoningStopEligible ||
    reasoningStopMode === 'off'
  ) {
    return null;
  }

  args.logProgress(0, 5, 'reasoning_stop_guard_check', { flowId: 'reasoning_stop_guard_flow' });
  const guardResult = await args.runEngine({
    disableToolCallHandlers: true,
    includeAutoHookIds: ['reasoning_stop_guard'],
    excludeAutoHookIds: ['stop_message_auto']
  });
  if (!guardResult.execution?.flowId) {
    return null;
  }

  const guardFlowId = guardResult.execution.flowId;
  args.logProgress(1, 5, 'matched', { flowId: guardFlowId });
  args.logStopEntry('trigger', 'reasoning_stop_guard_activated', {
    flowId: guardFlowId,
    reason: args.stopSignal.reason,
    source: args.stopSignal.source,
    eligible: args.stopSignal.eligible
  });

  if (guardFlowId === 'reasoning_stop_finalize_flow') {
    args.logProgress(5, 5, 'completed (reasoning_stop_finalize)', { flowId: guardFlowId });
    return {
      chat: guardResult.finalChatResponse,
      executed: true,
      flowId: guardFlowId
    };
  }

  return null;
}

export async function runPrimaryServerToolEngineSelection(args: {
  runEngine: ServerToolEngineRunner;
}): Promise<ServerSideToolEngineResult> {
  let engineResult = await args.runEngine({
    disableToolCallHandlers: true,
    includeAutoHookIds: ['stop_message_auto']
  });
  if (engineResult.mode === 'passthrough' || !engineResult.execution) {
    engineResult = await args.runEngine({
      excludeAutoHookIds: ['stop_message_auto']
    });
  }
  return engineResult;
}
