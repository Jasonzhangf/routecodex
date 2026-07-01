import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';
import {
  planServertoolToolCallDispatchWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { buildServertoolDispatchPlanInputWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
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
    args.options.adapterContext as Record<string, unknown>
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
