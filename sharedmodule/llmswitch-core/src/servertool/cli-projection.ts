import { randomUUID } from 'crypto';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';

export const SERVERTOOL_CLI_PROJECTION_FEATURE_ID = 'feature_id: hub.servertool_cli_projection';
export const SERVERTOOL_CLI_PROJECTION_CANONICAL_BUILDER =
  'build_servertool_cli_projection_01_from_hub_resp_chatprocess_03';

export interface ServertoolCliProjectionPlan {
  clientCallId: string;
  toolName: string;
  command: string;
  chatResponse: JsonObject;
}

export function buildServertoolCliProjectionForToolCall(args: {
  options: ServerSideToolEngineOptions;
  toolCall: ToolCall;
  reasoningText?: string;
}): ServertoolCliProjectionPlan {
  const toolName = args.toolCall.name;
  const input = parseArguments(args.toolCall.arguments);
  const reasoningText = args.reasoningText || `RouteCodex will execute servertool ${toolName} through client CLI.`;
  return buildProjection({
    requestId: args.options.requestId,
    toolName,
    input,
    reasoningText
  });
}

export function buildServertoolCliProjectionForAutoFlow(args: {
  options: ServerSideToolEngineOptions;
  flowId: string;
  reasoningText: string;
  stdoutPreview?: string;
  input?: JsonObject;
}): ServertoolCliProjectionPlan {
  const toolName = args.flowId === 'stop_message_flow' ? 'stop_message_auto' : args.flowId;
  return buildProjection({
    requestId: args.options.requestId,
    toolName,
    input: {
      flowId: args.flowId,
      ...(args.input ?? {}),
      ...(args.stdoutPreview ? { stdoutPreview: args.stdoutPreview } : {})
    },
    reasoningText: args.reasoningText
  });
}

function buildProjection(args: {
  requestId: string;
  toolName: string;
  input: JsonObject;
  reasoningText: string;
}): ServertoolCliProjectionPlan {
  const toolName = formatServertoolCliToolName(args.toolName);
  const clientCallId = `call_servertool_cli_${randomUUID().replace(/-/g, '')}`;
  const command = `routecodex servertool run ${toolName} --input-json ${shellQuoteJson(args.input)}`;
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

function formatServertoolCliToolName(toolName: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(toolName)) {
    throw new Error(`[servertool.cli] unsafe tool name for CLI projection: ${toolName}`);
  }
  return toolName;
}

function shellQuoteJson(value: JsonObject): string {
  return `'${JSON.stringify(value).replace(/'/g, `'\\''`)}'`;
}
