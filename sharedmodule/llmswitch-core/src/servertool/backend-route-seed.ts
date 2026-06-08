import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  extractCapturedChatSeedWithNative,
  normalizeFollowupParametersWithNative,
  resolveFollowupModelWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export type CapturedChatSeed = {
  model?: string;
  messages: JsonObject[];
  tools?: JsonObject[];
  parameters?: Record<string, unknown>;
};

function normalizeSeed(value: Record<string, unknown> | null): CapturedChatSeed | null {
  if (!value || !Array.isArray(value.messages) || value.messages.length === 0) {
    return null;
  }
  return value as CapturedChatSeed;
}

export function resolveFollowupModel(seedModel: unknown, adapterContext: unknown): string {
  return resolveFollowupModelWithNative(seedModel, adapterContext);
}

export function normalizeFollowupParameters(value: unknown): Record<string, unknown> | undefined {
  return normalizeFollowupParametersWithNative(value);
}

export function sanitizeFollowupParametersForResolvedModel(args: {
  parameters: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return normalizeFollowupParametersWithNative(args.parameters ?? null);
}

export function extractCapturedChatSeed(source: unknown): CapturedChatSeed | null {
  return normalizeSeed(extractCapturedChatSeedWithNative(source ?? null));
}
