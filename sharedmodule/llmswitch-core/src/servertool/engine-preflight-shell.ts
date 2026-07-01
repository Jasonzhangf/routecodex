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
      if (preflightAction.attachStopGatewayContext === true) {
        attachStopGatewayContext(args.adapterContext, stopSignal);
      }
      if (preflightAction.logStopEntry) {
        args.logStopEntry(preflightAction.logStopEntry.stage, preflightAction.logStopEntry.result, {
          reason: stopSignal.reason,
          source: stopSignal.source,
          eligible: stopSignal.eligible,
          ...(preflightAction.logStopEntry.includeChoiceFacts && typeof stopSignal.choiceIndex === 'number'
            ? { choiceIndex: stopSignal.choiceIndex }
            : {}),
          ...(preflightAction.logStopEntry.includeChoiceFacts && typeof stopSignal.hasToolCalls === 'boolean'
            ? { hasToolCalls: stopSignal.hasToolCalls }
            : {})
        });
      }
      if (preflightAction.logStopCompare) {
        args.logStopCompare(preflightAction.logStopCompare.stage);
      }
      return { kind: 'return_original_chat_direct_passthrough', chat: args.chat };
    case 'continue_to_engine':
      if (preflightAction.attachStopGatewayContext === true) {
        attachStopGatewayContext(args.adapterContext, stopSignal);
      }
      if (preflightAction.logStopEntry) {
        args.logStopEntry(preflightAction.logStopEntry.stage, preflightAction.logStopEntry.result, {
          reason: stopSignal.reason,
          source: stopSignal.source,
          eligible: stopSignal.eligible,
          ...(preflightAction.logStopEntry.includeChoiceFacts && typeof stopSignal.choiceIndex === 'number'
            ? { choiceIndex: stopSignal.choiceIndex }
            : {}),
          ...(preflightAction.logStopEntry.includeChoiceFacts && typeof stopSignal.hasToolCalls === 'boolean'
            ? { hasToolCalls: stopSignal.hasToolCalls }
            : {})
        });
      }
      if (preflightAction.logStopCompare) {
        args.logStopCompare(preflightAction.logStopCompare.stage);
      }
      return { kind: 'continue', stopSignal };
    default:
      throw new Error(`[servertool] invalid engine preflight action: ${String(preflightAction.action)}`);
  }
}
