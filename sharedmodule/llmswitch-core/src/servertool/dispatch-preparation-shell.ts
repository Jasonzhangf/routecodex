import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  planServertoolToolCallDispatchWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  applyPreCommandHooksToToolCalls,
} from './pre-command-hooks.js';
import {
  buildServertoolDispatchPlanInput
} from './execution-dispatch-outcome-shell.js';
import { resolveServertoolRuntimePreCommandState } from './pre-command-runtime-state-shell.js';
import { patchToolCallArgumentsById } from './orchestration-blocks.js';
import { readProviderProtocolFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

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
  const runtimeMetadata = readRuntimeMetadata(args.options.adapterContext as unknown as Record<string, unknown>);
  const runtimePreCommandState = resolveServertoolRuntimePreCommandState({
    adapterContext: args.options.adapterContext,
    requestId: args.options.requestId,
    entryEndpoint: args.options.entryEndpoint,
    providerProtocol
  });

  applyPreCommandHooksToToolCalls({
    options: args.options,
    toolCalls: args.toolCalls,
    runtimePreCommandState,
    bases: [args.baseObject, args.baseForExecution],
    patchToolCallArgumentsById
  });

  return {
    dispatchPlan: planServertoolToolCallDispatchWithNative(
      buildServertoolDispatchPlanInput({
        toolCalls: args.toolCalls,
        disableToolCallHandlers: args.options.disableToolCallHandlers === true,
        ...(args.includeToolCallNames ? { includeToolCallHandlerNames: [...args.includeToolCallNames] } : {}),
        ...(args.excludeToolCallNames ? { excludeToolCallHandlerNames: [...args.excludeToolCallNames] } : {}),
        runtimeMetadata
      })
    )
  };
}
