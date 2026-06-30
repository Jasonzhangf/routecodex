import { randomUUID } from 'crypto';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ToolCall
} from './types.js';
import {
  buildClientExecCliProjectionOutputWithNative,
  buildClientVisibleProjectionShellWithNative,
  buildServertoolCliProjectionExecutionContextWithNative,
  parseServertoolCliProjectionToolArgumentsWithNative
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
  const projectionInput = parseServertoolCliProjectionToolArgumentsWithNative({
    arguments: cliProjectedToolCall.arguments
  });
  const nativeProjection = buildClientExecCliProjectionOutputWithNative({
    toolName,
    flowId: 'servertool_cli_projection',
    input: projectionInput,
    repeatCount: 0,
    maxRepeats: 0
  });
  const clientCallId = `call_servertool_cli_${randomUUID().replace(/-/g, '')}`;
  const chatResponse = buildClientVisibleProjectionShellWithNative({
    requestId: args.options.requestId,
    clientCallId,
    nativeProjection,
    reasoningText: `继续执行本地 hook ${toolName}。`,
    ...(additionalToolCalls.length ? { additionalToolCalls } : {})
  }) as JsonObject;
  const execution = buildServertoolCliProjectionExecutionContextWithNative({
    requestId: args.options.requestId,
    clientCallId,
    toolName
  });
  return {
    mode: 'tool_flow',
    finalChatResponse: chatResponse,
    execution: execution as {
      flowId: string;
      context?: JsonObject;
    }
  };
}
