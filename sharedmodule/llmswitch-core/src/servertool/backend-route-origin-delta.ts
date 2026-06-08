import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolFollowupInjectionPlan } from './types.js';
import { loadOriginSnapshot } from './origin-request-store.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import { extractCapturedChatSeed } from './backend-route-seed.js';
import {
  applyFollowupDeltaPlanWithNative,
  extractAssistantFollowupMessageWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export type FollowupOriginSeed = JsonObject;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function extractAssistantFollowupMessage(finalChatResponse: JsonObject): JsonObject | null {
  return extractAssistantFollowupMessageWithNative(finalChatResponse) as JsonObject | null;
}

export function loadFollowupOriginSeed(adapterContext: AdapterContext): FollowupOriginSeed | null {
  const record = asRecord(adapterContext);
  const directSeed = extractCapturedChatSeed(record?.capturedEntryRequest ?? null)
    ?? extractCapturedChatSeed(record?.capturedChatRequest ?? null);
  if (directSeed) {
    return directSeed as FollowupOriginSeed;
  }
  const scope = resolveServertoolPersistentScopeKey(adapterContext);
  if (!scope) {
    return null;
  }
  const snapshot = loadOriginSnapshot(scope);
  if (!snapshot) {
    return null;
  }
  const capturedSeed = extractCapturedChatSeed(snapshot.capturedEntryRequest ?? null)
    ?? extractCapturedChatSeed(snapshot.capturedChatRequest ?? null);
  if (capturedSeed) {
    return capturedSeed as FollowupOriginSeed;
  }
  return extractCapturedChatSeed(snapshot) as FollowupOriginSeed | null;
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
