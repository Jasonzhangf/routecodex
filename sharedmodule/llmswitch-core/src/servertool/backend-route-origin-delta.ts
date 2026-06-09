import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolFollowupInjectionPlan } from './types.js';
import { loadOriginSnapshot } from './origin-request-store.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import {
  applyFollowupDeltaPlanWithNative,
  extractAssistantFollowupMessageWithNative,
  resolveFollowupOriginSeedWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export type FollowupOriginSeed = JsonObject;

export function extractAssistantFollowupMessage(finalChatResponse: JsonObject): JsonObject | null {
  return extractAssistantFollowupMessageWithNative(finalChatResponse) as JsonObject | null;
}

export function loadFollowupOriginSeed(adapterContext: AdapterContext): FollowupOriginSeed | null {
  const scope = resolveServertoolPersistentScopeKey(adapterContext);
  const snapshot = scope ? loadOriginSnapshot(scope) : undefined;
  return resolveFollowupOriginSeedWithNative({
    adapterContext,
    ...(snapshot ? { snapshot } : {})
  }) as FollowupOriginSeed | null;
}

export function applyFollowupDeltaPlan(args: {
  adapterContext: AdapterContext;
  finalChatResponse: JsonObject;
  seed: FollowupOriginSeed;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  return applyFollowupDeltaPlanWithNative({
    adapterContext: args.adapterContext as unknown as Record<string, unknown>,
    finalChatResponse: args.finalChatResponse,
    seed: args.seed as unknown as Record<string, unknown>,
    injection: args.injection as unknown as Record<string, unknown>
  }) as JsonObject | null;
}
