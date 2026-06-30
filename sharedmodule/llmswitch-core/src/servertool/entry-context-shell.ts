import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  readProviderProtocolFromAnyBoundMetadataCenter,
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import { planServertoolEntryContextWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

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
  const runtimeMetadataSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
    args.options.adapterContext as Record<string, unknown>
  );
  if (!runtimeMetadataSnapshot) {
    throw new Error('Servertool entry context requires MetadataCenter request truth or runtime_control snapshot');
  }
  const entryContextPlan = planServertoolEntryContextWithNative({
    includeToolCallHandlerNames: args.options.includeToolCallHandlerNames,
    excludeToolCallHandlerNames: args.options.excludeToolCallHandlerNames,
    includeAutoHookIds: args.options.includeAutoHookIds,
    excludeAutoHookIds: args.options.excludeAutoHookIds
  });
  const includeToolCallNames =
    entryContextPlan.includeToolCallNames && entryContextPlan.includeToolCallNames.length > 0
      ? new Set(entryContextPlan.includeToolCallNames)
      : null;
  const excludeToolCallNames =
    entryContextPlan.excludeToolCallNames && entryContextPlan.excludeToolCallNames.length > 0
      ? new Set(entryContextPlan.excludeToolCallNames)
      : null;
  const includeAutoHookIds =
    entryContextPlan.includeAutoHookIds && entryContextPlan.includeAutoHookIds.length > 0
      ? new Set(entryContextPlan.includeAutoHookIds)
      : null;
  const excludeAutoHookIds =
    entryContextPlan.excludeAutoHookIds && entryContextPlan.excludeAutoHookIds.length > 0
      ? new Set(entryContextPlan.excludeAutoHookIds)
      : null;

  return {
    action: 'continue',
    baseObject: args.base,
    contextBase: {
      base: args.base,
      toolCalls: args.toolCalls,
      adapterContext: args.options.adapterContext,
      requestId: args.options.requestId,
      entryEndpoint: args.options.entryEndpoint,
      providerProtocol,
      runtimeMetadata: runtimeMetadataSnapshot
    },
    includeToolCallNames,
    excludeToolCallNames,
    includeAutoHookIds,
    excludeAutoHookIds
  };
}

export function asServertoolJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}
