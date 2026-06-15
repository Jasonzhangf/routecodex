import { randomUUID } from 'crypto';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';
import {
  buildClientExecCliProjectionOutputWithNative,
  buildClientVisibleProjectionShellWithNative,
  type ClientExecCliProjectionOutput,
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export const SERVERTOOL_CLI_PROJECTION_FEATURE_ID = 'feature_id: hub.servertool_cli_projection';
export const SERVERTOOL_CLI_PROJECTION_CANONICAL_BUILDER =
  'build_servertool_cli_projection_01_from_hub_resp_chatprocess_03';

export interface ServertoolCliProjectionPlan {
  clientCallId: string;
  toolName: string;
  command: string;
  chatResponse: JsonObject;
}

type ServertoolCliProjectionOptions = Pick<ServerSideToolEngineOptions, 'requestId'>;

export function buildServertoolCliProjectionForToolCall(args: {
  options: ServertoolCliProjectionOptions;
  toolCall: ToolCall;
  additionalToolCalls?: unknown[];
  reasoningText?: string;
}): ServertoolCliProjectionPlan {
  const toolName = args.toolCall.name;
  const input = parseArguments(args.toolCall.arguments);
  const reasoningText = args.reasoningText || `继续执行本地 hook ${toolName}。`;
  const nativeProjection = buildClientExecCliProjectionOutputWithNative({
    toolName,
    flowId: 'servertool_cli_projection',
    input,
    repeatCount: 0,
    maxRepeats: 0,
  });
  return buildProjectionShell({
    requestId: args.options.requestId,
    nativeProjection,
    reasoningText,
    additionalToolCalls: args.additionalToolCalls
  });
}

export function buildServertoolCliProjectionForAutoFlow(args: {
  options: ServertoolCliProjectionOptions;
  flowId: string;
  reasoningText: string;
  stdoutPreview?: string;
  input?: JsonObject;
}): ServertoolCliProjectionPlan {
  const nativeProjection = buildClientExecCliProjectionOutputWithNative({
    flowId: args.flowId,
    input: args.input ?? {},
    ...(args.stdoutPreview ? { stdoutPreview: args.stdoutPreview } : {})
  });
  return buildProjectionShell({
    requestId: args.options.requestId,
    nativeProjection,
    reasoningText: args.reasoningText
  });
}

function buildProjectionShell(args: {
  requestId: string;
  nativeProjection: ClientExecCliProjectionOutput;
  reasoningText: string;
  additionalToolCalls?: unknown[];
}): ServertoolCliProjectionPlan {
  const clientCallId = `call_servertool_cli_${randomUUID().replace(/-/g, '')}`;
  const toolName = args.nativeProjection.toolName;
  const command = args.nativeProjection.execCommand;
  const chatResponse = buildClientVisibleProjectionShellWithNative({
    requestId: args.requestId,
    clientCallId,
    nativeProjection: args.nativeProjection,
    reasoningText: args.reasoningText,
    ...(args.additionalToolCalls?.length ? { additionalToolCalls: args.additionalToolCalls } : {})
  }) as JsonObject;
  return {
    clientCallId,
    toolName,
    command,
    chatResponse
  };
}

function parseArguments(value: string): JsonObject {
  if (!value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    throw new Error('[servertool.cli] tool arguments must be JSON object');
  }
  throw new Error('[servertool.cli] tool arguments must be JSON object');
}
