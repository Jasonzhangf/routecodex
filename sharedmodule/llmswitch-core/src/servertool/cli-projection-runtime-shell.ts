import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ToolCall
} from './types.js';
import {
  buildServertoolCliProjectionRuntimeBranchWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  collectServertoolAdditionalClientToolCallsWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export function buildServertoolCliProjectionBranchResult(args: {
  options: ServerSideToolEngineOptions;
  base: JsonObject;
  executableToolCalls: Array<ToolCall & { executionMode?: string }>;
  projectedToolCallIndex?: number;
}): ServerSideToolEngineResult {
  const cliProjectedToolCall =
    typeof args.projectedToolCallIndex === 'number'
      ? args.executableToolCalls[args.projectedToolCallIndex]
      : undefined;
  if (!cliProjectedToolCall) {
    throw new Error(
      `[servertool] native execution-branch projected missing tool call index: ${String(args.projectedToolCallIndex ?? '')}`
    );
  }
  const additionalToolCalls = collectServertoolAdditionalClientToolCallsWithNative({
    base: args.base,
    projectedToolCallId: cliProjectedToolCall.id
  });
  const toolName = cliProjectedToolCall.name;
  const branch = buildServertoolCliProjectionRuntimeBranchWithNative({
    requestId: args.options.requestId,
    toolName,
    toolArguments: cliProjectedToolCall.arguments,
    ...(additionalToolCalls.length ? { additionalToolCalls } : {})
  });
  return {
    mode: 'tool_flow',
    finalChatResponse: branch.chatResponse as JsonObject,
    execution: branch.execution as {
      flowId: string;
      context?: JsonObject;
    }
  };
}
