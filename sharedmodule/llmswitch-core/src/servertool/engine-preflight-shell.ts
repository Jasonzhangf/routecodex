import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  containsSyntheticRouteCodexControlTextWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  attachStopGatewayContext,
  inspectStopGatewaySignal
} from './metadata-center-carrier.js';
import {
  planServertoolEnginePreflightWithNative,
  resolveServertoolEnginePreflightDecisionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

type StopGatewayContext = ReturnType<typeof inspectStopGatewaySignal>;
type EnginePreflightNativePlan = ReturnType<typeof planServertoolEnginePreflightWithNative>;
type EnginePreflightOriginalChatResult = Extract<EnginePreflightResult, { kind: 'return_original_chat' }>;
type EnginePreflightDirectPassthroughResult = Extract<EnginePreflightResult, { kind: 'return_original_chat_direct_passthrough' }>;
type EnginePreflightContinueResult = Extract<EnginePreflightResult, { kind: 'continue' }>;

export type EnginePreflightResult =
  | {
      kind: 'return_original_chat';
      chat: JsonObject;
    }
  | {
      kind: 'return_original_chat_direct_passthrough';
      chat: JsonObject;
    }
  | {
      kind: 'continue';
      stopSignal: StopGatewayContext;
    };

type LogStopEntry = (
  stage: 'entry' | 'trigger',
  result: string,
  extra?: Record<string, unknown>
) => void;

type LogStopCompare = (stage: 'entry' | 'trigger', flowId?: string) => void;

function runPreflightSideEffects(args: {
  preflightAction: EnginePreflightNativePlan;
  stopSignal: StopGatewayContext;
  adapterContext: AdapterContext;
  logStopEntry: LogStopEntry;
  logStopCompare: LogStopCompare;
}): void {
  if (args.preflightAction.attachStopGatewayContext === true) {
    attachStopGatewayContext(args.adapterContext, args.stopSignal);
  }
  const logStopEntry = args.preflightAction.logStopEntry;
  if (logStopEntry) {
    args.logStopEntry(logStopEntry.stage, logStopEntry.result, {
      reason: args.stopSignal.reason,
      source: args.stopSignal.source,
      eligible: args.stopSignal.eligible,
      ...(logStopEntry.includeChoiceFacts && typeof args.stopSignal.choiceIndex === 'number'
        ? { choiceIndex: args.stopSignal.choiceIndex }
        : {}),
      ...(logStopEntry.includeChoiceFacts && typeof args.stopSignal.hasToolCalls === 'boolean'
        ? { hasToolCalls: args.stopSignal.hasToolCalls }
        : {})
    });
  }
  const logStopCompare = args.preflightAction.logStopCompare;
  if (logStopCompare) {
    args.logStopCompare(logStopCompare.stage);
  }
}

export function runEnginePreflight(args: {
  chat: JsonObject;
  adapterContext: AdapterContext;
  logStopEntry: LogStopEntry;
  logStopCompare: LogStopCompare;
}): EnginePreflightResult {
  const stopSignal = inspectStopGatewaySignal(args.chat);
  const preflightAction = planServertoolEnginePreflightWithNative({
    hasSyntheticControlText: containsSyntheticRouteCodexControlTextWithNative(args.chat),
    stopSignalObserved: stopSignal.observed,
    chat: args.chat,
    stopSignal,
    adapterContext: args.adapterContext
  });
  const preflightDecision = resolveServertoolEnginePreflightDecisionWithNative({
    preflightAction
  });
  if (preflightDecision.shouldRunSideEffects) {
    runPreflightSideEffects({
      preflightAction,
      stopSignal,
      adapterContext: args.adapterContext,
      logStopEntry: args.logStopEntry,
      logStopCompare: args.logStopCompare
    });
  }
  return preflightDecision.result as EnginePreflightOriginalChatResult
    | EnginePreflightDirectPassthroughResult
    | EnginePreflightContinueResult;
}
