import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolFollowupInjectionPlan } from './types.js';
import { loadOriginSnapshot } from './origin-request-store.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import {
  applyFollowupDeltaPlanWithNative,
  extractAssistantFollowupMessageWithNative,
  extractCapturedChatSeedWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export type FollowupOriginSeed = JsonObject;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeSeed(value: Record<string, unknown> | null): FollowupOriginSeed | null {
  const hasMessages = Array.isArray(value?.messages) && value.messages.length > 0;
  const hasInput = typeof value?.input === 'string'
    ? value.input.trim().length > 0
    : Array.isArray(value?.input) && value.input.length > 0;
  if (!value || (!hasMessages && !hasInput)) {
    return null;
  }
  const seed = cloneJson(value) as JsonObject & { messages?: unknown };
  if (typeof seed.model === 'string') {
    const model = seed.model.trim();
    if (model) {
      seed.model = model;
    } else {
      delete seed.model;
    }
  }
  if (hasMessages) {
    seed.messages = cloneJson(value.messages as JsonObject[]);
  }
  return seed as FollowupOriginSeed;
}

export function extractAssistantFollowupMessage(finalChatResponse: JsonObject): JsonObject | null {
  return extractAssistantFollowupMessageWithNative(finalChatResponse) as JsonObject | null;
}

export function loadFollowupOriginSeed(adapterContext: AdapterContext): FollowupOriginSeed | null {
  const record = asRecord(adapterContext);
  const directSeed = normalizeSeed(record?.capturedEntryRequest as Record<string, unknown> | null)
    ?? normalizeSeed(extractCapturedChatSeedWithNative(record?.capturedChatRequest ?? null));
  if (directSeed) {
    return directSeed;
  }
  const scope = resolveServertoolPersistentScopeKey(adapterContext);
  if (!scope) {
    return null;
  }
  const snapshot = loadOriginSnapshot(scope);
  if (!snapshot) {
    return null;
  }
  const capturedSeed = normalizeSeed(asRecord(snapshot.capturedEntryRequest) ?? null)
    ?? normalizeSeed(extractCapturedChatSeedWithNative(snapshot.capturedChatRequest ?? null));
  if (capturedSeed) {
    return capturedSeed;
  }
  return normalizeSeed(snapshot as unknown as Record<string, unknown>);
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
