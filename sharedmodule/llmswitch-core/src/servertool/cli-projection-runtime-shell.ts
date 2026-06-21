import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ToolCall
} from './types.js';
import { buildServertoolCliProjectionForToolCall } from './cli-projection.js';
import { buildServertoolCliProjectionExecutionContextWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  collectServertoolAdditionalClientToolCallsWithNative,
  isServertoolClientExecCliProjectionToolCallWithNative
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
  const additionalToolCalls = collectAdditionalClientToolCalls(args.base, cliProjectedToolCall.id);
  const projection = buildServertoolCliProjectionForToolCall({
    options: args.options,
    toolCall: cliProjectedToolCall,
    ...(additionalToolCalls.length ? { additionalToolCalls } : {}),
    reasoningText: `继续执行本地 hook ${cliProjectedToolCall.name}。`
  });
  const execution = buildServertoolCliProjectionExecutionContextWithNative({
    requestId: args.options.requestId,
    clientCallId: projection.clientCallId,
    toolName: projection.toolName
  });
  return {
    mode: 'tool_flow',
    finalChatResponse: projection.chatResponse,
    execution: execution as {
      flowId: string;
      context?: JsonObject;
    }
  };
}

export function isClientExecCliProjectionToolCall(toolCall: ToolCall & { executionMode?: string }): boolean {
  return isServertoolClientExecCliProjectionToolCallWithNative({
    executionMode: toolCall.executionMode
  });
}

export const collectAdditionalClientToolCalls = (base: JsonObject, projectedToolCallId: string): JsonValue[] => {
  return collectServertoolAdditionalClientToolCallsWithNative({
    base,
    projectedToolCallId
  }) as JsonValue[];
};
