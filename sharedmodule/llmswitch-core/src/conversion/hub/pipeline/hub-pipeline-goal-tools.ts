import type { AdapterContext } from "../types/chat-envelope.js";
import type { StandardizedRequest } from "../types/standardized.js";
import { resolveGoalCapableRequestWithNative } from "../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js";

export function resolveGoalCapableRequest(args: {
  request?: StandardizedRequest;
  adapterContext?: AdapterContext;
}): {
  requestGoalCapable: boolean;
  adapterContextGoalCapable: boolean;
} {
  return resolveGoalCapableRequestWithNative({
    request: args.request,
    adapterContext: args.adapterContext,
  });
}

export function isGoalCapableStandardizedRequest(
  request: StandardizedRequest,
): boolean {
  return resolveGoalCapableRequest({ request }).requestGoalCapable;
}

export function isGoalCapableAdapterContext(
  adapterContext: AdapterContext,
): boolean {
  return resolveGoalCapableRequest({ adapterContext }).adapterContextGoalCapable;
}
