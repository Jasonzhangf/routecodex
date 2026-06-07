import { randomUUID } from 'crypto';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';
import {
  buildClientExecCliProjectionOutputWithNative,
  type ClientExecCliProjectionOutput,
} from '../router/virtual-router/engine-selection/native-servertool-core-semantics.js';

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
  reasoningText?: string;
}): ServertoolCliProjectionPlan {
  const toolName = args.toolCall.name;
  const input = parseArguments(args.toolCall.arguments);
  const reasoningText = args.reasoningText || `RouteCodex will execute servertool ${toolName} through client CLI.`;
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
    reasoningText
  });
}

export function buildServertoolCliProjectionForAutoFlow(args: {
  options: ServertoolCliProjectionOptions;
  flowId: string;
  reasoningText: string;
  stdoutPreview?: string;
  input?: JsonObject;
}): ServertoolCliProjectionPlan {
  const toolName = args.flowId === 'stop_message_flow' ? 'stop_message_auto' : args.flowId;
  const repeatCount = typeof args.input?.repeatCount === 'number' ? args.input.repeatCount : 0;
  const maxRepeats = typeof args.input?.maxRepeats === 'number' ? args.input.maxRepeats : 0;
  const nativeProjection = buildClientExecCliProjectionOutputWithNative({
    toolName,
    flowId: args.flowId,
    input: {
      flowId: args.flowId,
      ...(args.input ?? {}),
      ...(args.stdoutPreview ? { stdoutPreview: args.stdoutPreview } : {})
    },
    repeatCount,
    maxRepeats,
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
}): ServertoolCliProjectionPlan {
  const clientCallId = `call_servertool_cli_${randomUUID().replace(/-/g, '')}`;
  const toolName = args.nativeProjection.toolName;
  const command = args.nativeProjection.execCommand;
  const chatResponse: JsonObject = {
    id: `chatcmpl_${clientCallId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'routecodex-servertool-cli',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_text: args.reasoningText,
          reasoning_content: args.reasoningText,
          reasoning: {
            summary: [{ type: 'summary_text', text: args.reasoningText }],
            content: [{ type: 'reasoning_text', text: args.reasoningText }]
          },
          tool_calls: [
            {
              id: clientCallId,
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: command })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    __servertool_cli_projection: {
      clientCallId,
      toolName,
      requestId: args.requestId
    }
  };
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
