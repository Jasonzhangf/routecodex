import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import { planServertoolEntryContextWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

function nativeEntryTokenSet(tokens: readonly string[] | undefined): Set<string> | null {
  return tokens ? new Set(tokens) : null;
}

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
  const includeToolCallNames = nativeEntryTokenSet(entryContextPlan.includeToolCallNames);
  const excludeToolCallNames = nativeEntryTokenSet(entryContextPlan.excludeToolCallNames);
  const includeAutoHookIds = nativeEntryTokenSet(entryContextPlan.includeAutoHookIds);
  const excludeAutoHookIds = nativeEntryTokenSet(entryContextPlan.excludeAutoHookIds);

  return {
    action: 'continue',
    baseObject: args.base,
    contextBase: {
      base: args.base,
      toolCalls: args.toolCalls,
      adapterContext: args.options.adapterContext,
      requestId: args.options.requestId,
      entryEndpoint: args.options.entryEndpoint,
      runtimeMetadata: runtimeMetadataSnapshot
    },
    includeToolCallNames,
    excludeToolCallNames,
    includeAutoHookIds,
    excludeAutoHookIds
  };
}
