import type { JsonObject, ServerSideToolEngineOptions, ToolCall } from './types.js';
import {
  planServertoolToolCallDispatchWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import { buildServertoolDispatchPlanInputWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';

export function prepareServertoolDispatchStage(args: {
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  includeToolCallNames: Set<string> | null;
  excludeToolCallNames: Set<string> | null;
}): {
  dispatchPlan: ReturnType<typeof planServertoolToolCallDispatchWithNative>;
} {
  const runtimeMetadata = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
    args.options.adapterContext
  );
  return {
    dispatchPlan: planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInputWithNative({
        toolCalls: args.toolCalls,
        disableToolCallHandlers: args.options.disableToolCallHandlers === true,
        includeToolCallHandlerNames: args.includeToolCallNames != null ? [...args.includeToolCallNames] : null,
        excludeToolCallHandlerNames: args.excludeToolCallNames != null ? [...args.excludeToolCallNames] : null,
        runtimeMetadata
      })
    )
  };
}
