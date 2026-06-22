import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  containsSyntheticRouteCodexControlText
} from './orchestration-policy-block.js';
import {
  attachStopGatewayContext,
  inspectStopGatewaySignal
} from './stop-gateway-context.js';
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
    hasSyntheticControlText: containsSyntheticRouteCodexControlText(args.chat),
    stopSignalObserved: stopSignal.observed,
    adapterContext: args.adapterContext as Record<string, unknown>
  });
  if (preflightAction.action === 'return_original_chat') {
    return { kind: 'return_original_chat', chat: args.chat };
  }
  attachStopGatewayContext(args.adapterContext, stopSignal);
  if (stopSignal.observed && preflightAction.action === 'return_original_chat_direct_passthrough') {
    args.logStopEntry('trigger', 'skipped_direct_passthrough', {
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible
    });
    args.logStopCompare('trigger');
    return { kind: 'return_original_chat_direct_passthrough', chat: args.chat };
  }
  if (stopSignal.observed) {
    args.logStopEntry('entry', 'observed', {
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible,
      ...(typeof stopSignal.choiceIndex === 'number' ? { choiceIndex: stopSignal.choiceIndex } : {}),
      ...(typeof stopSignal.hasToolCalls === 'boolean' ? { hasToolCalls: stopSignal.hasToolCalls } : {})
    });
  }
  return { kind: 'continue', stopSignal };
}
