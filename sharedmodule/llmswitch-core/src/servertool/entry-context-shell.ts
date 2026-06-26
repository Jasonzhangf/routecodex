import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import { readProviderProtocolFromAnyBoundMetadataCenter } from './stopless-metadata-carrier.js';

export function resolveServertoolEntryContext(args: {
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  base: JsonObject | null;
}):
  | { action: 'return_non_object_base' }
  | {
      action: 'continue';
      baseObject: JsonObject;
      contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
      includeToolCallNames: Set<string> | null;
      excludeToolCallNames: Set<string> | null;
      includeAutoHookIds: Set<string> | null;
      excludeAutoHookIds: Set<string> | null;
    } {
  if (!args.base) {
    return { action: 'return_non_object_base' };
  }
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(args.options.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool entry context requires metadata center runtime_control.providerProtocol');
  }

  return {
    action: 'continue',
    baseObject: args.base,
    contextBase: {
      base: args.base,
      toolCalls: args.toolCalls,
      adapterContext: args.options.adapterContext,
      requestId: args.options.requestId,
      entryEndpoint: args.options.entryEndpoint,
      providerProtocol
    },
    includeToolCallNames: normalizeFilterTokenSet(args.options.includeToolCallHandlerNames),
    excludeToolCallNames: normalizeFilterTokenSet(args.options.excludeToolCallHandlerNames),
    includeAutoHookIds: normalizeFilterTokenSet(args.options.includeAutoHookIds),
    excludeAutoHookIds: normalizeFilterTokenSet(args.options.excludeAutoHookIds)
  };
}

export function asServertoolJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function normalizeFilterTokenSet(values: string[] | undefined): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim().toLowerCase();
    if (!value) {
      continue;
    }
    normalized.add(value);
  }
  return normalized.size > 0 ? normalized : null;
}
