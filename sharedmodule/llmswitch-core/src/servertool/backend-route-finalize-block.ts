import type { JsonObject } from '../conversion/hub/types/json.js';
import {
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
