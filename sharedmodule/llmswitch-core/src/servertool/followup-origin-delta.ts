import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolFollowupInjectionPlan } from './types.js';
import { loadOriginSnapshot } from './origin-request-store.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import {
  applyFollowupDeltaPlanWithNative,
  extractAssistantFollowupMessageWithNative,
  extractCapturedChatSeedWithNative
} from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

export type FollowupOriginSeed = { model?: string; messages: JsonObject[]; tools?: JsonObject[]; parameters?: Record<string, unknown> };

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeSeed(value: Record<string, unknown> | null): FollowupOriginSeed | null {
  if (!value || !Array.isArray(value.messages) || value.messages.length === 0) {
    return null;
  }
  return {
    ...(typeof value.model === 'string' && value.model.trim() ? { model: value.model.trim() } : {}),
    messages: cloneJson(value.messages as JsonObject[]),
    ...(Array.isArray(value.tools) ? { tools: cloneJson(value.tools as JsonObject[]) } : {}),
    ...(value.parameters && typeof value.parameters === 'object' && !Array.isArray(value.parameters)
      ? { parameters: cloneJson(value.parameters as Record<string, unknown>) }
      : {})
  };
}

export function extractAssistantFollowupMessage(finalChatResponse: JsonObject): JsonObject | null {
  return extractAssistantFollowupMessageWithNative(finalChatResponse) as JsonObject | null;
}

export function loadFollowupOriginSeed(adapterContext: AdapterContext): FollowupOriginSeed | null {
  const record = asRecord(adapterContext);
  const directSeed = normalizeSeed(extractCapturedChatSeedWithNative(record?.capturedChatRequest ?? null));
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
  const capturedSeed = normalizeSeed(extractCapturedChatSeedWithNative(snapshot.capturedChatRequest ?? null));
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
