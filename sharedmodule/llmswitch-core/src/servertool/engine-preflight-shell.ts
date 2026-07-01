import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  containsSyntheticRouteCodexControlTextWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  attachStopGatewayContext,
  inspectStopGatewaySignal
} from './metadata-center-carrier.js';
import { planServertoolEnginePreflightWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

type StopGatewayContext = ReturnType<typeof inspectStopGatewaySignal>;
type EnginePreflightNativePlan = ReturnType<typeof planServertoolEnginePreflightWithNative>;

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
    adapterContext: args.adapterContext as Record<string, unknown>
  });
  switch (preflightAction.action) {
    case 'return_original_chat':
      return { kind: 'return_original_chat', chat: args.chat };
    case 'return_original_chat_direct_passthrough':
      runPreflightSideEffects({
        preflightAction,
        stopSignal,
        adapterContext: args.adapterContext,
        logStopEntry: args.logStopEntry,
        logStopCompare: args.logStopCompare
      });
      return { kind: 'return_original_chat_direct_passthrough', chat: args.chat };
    case 'continue_to_engine':
      runPreflightSideEffects({
        preflightAction,
        stopSignal,
        adapterContext: args.adapterContext,
        logStopEntry: args.logStopEntry,
        logStopCompare: args.logStopCompare
      });
      return { kind: 'continue', stopSignal };
    default:
      throw new Error(`[servertool] invalid engine preflight action: ${String(preflightAction.action)}`);
  }
}
