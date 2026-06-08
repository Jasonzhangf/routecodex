import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  decorateServertoolFinalChatWithNative,
  shouldShortCircuitRequiresActionFollowupWithNative,
  type ServertoolBackendRouteFinalizeDecision
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export function shouldShortCircuitRequiresActionFollowup(args: {
  flowId: string | undefined;
  decision?: ServertoolBackendRouteFinalizeDecision;
  followupBody?: JsonObject;
  hasRequiresActionShape: (payload: JsonObject) => boolean;
}): boolean {
  return shouldShortCircuitRequiresActionFollowupWithNative({
    ...(args.flowId ? { flowId: args.flowId } : {}),
    ...(args.decision ? { decision: args.decision } : {}),
    hasRequiresActionShape: Boolean(args.followupBody && args.hasRequiresActionShape(args.followupBody))
  });
}

export function decorateFinalChatWithServerToolContext(
  chat: JsonObject,
  execution: { flowId: string; context?: JsonObject } | undefined,
  decision?: ServertoolBackendRouteFinalizeDecision
): JsonObject {
  return decorateServertoolFinalChatWithNative({
    chat: chat as Record<string, unknown>,
    ...(execution
      ? {
          execution: {
            flowId: execution.flowId,
            ...(execution.context ? { context: execution.context as Record<string, unknown> } : {})
          }
        }
      : {}),
    ...(decision ? { decision } : {})
  }) as JsonObject;
}
