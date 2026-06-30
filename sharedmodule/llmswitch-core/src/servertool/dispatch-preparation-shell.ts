import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';
import {
  planServertoolToolCallDispatchWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { buildServertoolDispatchPlanInputWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  readProviderProtocolFromAnyBoundMetadataCenter,
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';

export function prepareServertoolDispatchStage(args: {
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  baseObject: JsonObject;
  baseForExecution: JsonObject;
  includeToolCallNames: Set<string> | null;
  excludeToolCallNames: Set<string> | null;
}): {
  dispatchPlan: ReturnType<typeof planServertoolToolCallDispatchWithNative>;
} {
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(args.options.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool dispatch preparation requires metadata center runtime_control.providerProtocol');
  }
  const runtimeMetadata = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
    args.options.adapterContext as Record<string, unknown>
  );
  const dispatchPlanInput = buildServertoolDispatchPlanInputWithNative({
    toolCalls: args.toolCalls,
    disableToolCallHandlers: args.options.disableToolCallHandlers === true,
    ...(args.includeToolCallNames ? { includeToolCallHandlerNames: [...args.includeToolCallNames] } : {}),
    ...(args.excludeToolCallNames ? { excludeToolCallHandlerNames: [...args.excludeToolCallNames] } : {}),
    runtimeMetadata
  });

  return {
    dispatchPlan: planServertoolToolCallDispatchWithNative(dispatchPlanInput)
  };
}
