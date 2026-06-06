import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  buildServertoolCliTicket,
  writeServertoolCliTicket,
  type ServertoolCliTicket
} from './cli-ticket.js';
import type { ServerSideToolEngineOptions, ToolCall } from './types.js';

export const SERVERTOOL_CLI_PROJECTION_FEATURE_ID = 'feature_id: hub.servertool_cli_projection';

export interface ServertoolCliProjectionPlan {
  ticket: ServertoolCliTicket;
  chatResponse: JsonObject;
}

export function buildServertoolCliProjectionForToolCall(args: {
  options: ServerSideToolEngineOptions;
  toolCall: ToolCall;
  reasoningText?: string;
}): ServertoolCliProjectionPlan {
  const ticket = buildServertoolCliTicket({
    entryEndpoint: args.options.entryEndpoint,
    requestId: args.options.requestId,
    ...readScope(args.options.adapterContext),
    modelTool: {
      name: args.toolCall.name,
      callId: args.toolCall.id
    },
    executor: {
      kind: args.toolCall.name === 'servertool_fixture' ? 'fixture' : args.toolCall.name,
      toolName: args.toolCall.name,
      arguments: parseArguments(args.toolCall.arguments),
      capabilities: []
    },
    presentation: {
      reasoningText: args.reasoningText || `RouteCodex will execute servertool ${args.toolCall.name} through client CLI.`,
      stdoutPreview: `${args.toolCall.name} execution requested`
    }
  });
  writeServertoolCliTicket(ticket);
  return {
    ticket,
    chatResponse: buildExecCommandChatResponse({
      requestId: args.options.requestId,
      ticket,
      reasoningText: ticket.presentation.reasoningText
    })
  };
}

export function buildServertoolCliProjectionForAutoFlow(args: {
  options: ServerSideToolEngineOptions;
  flowId: string;
  reasoningText: string;
  stdoutPreview?: string;
}): ServertoolCliProjectionPlan {
  const syntheticCallId = `call_${args.flowId}_${args.options.requestId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const ticket = buildServertoolCliTicket({
    entryEndpoint: args.options.entryEndpoint,
    requestId: args.options.requestId,
    ...readScope(args.options.adapterContext),
    modelTool: {
      name: args.flowId,
      callId: syntheticCallId,
      synthetic: true
    },
    executor: {
      kind: args.flowId === 'stop_message_flow' ? 'stop_message_auto' : args.flowId,
      toolName: args.flowId,
      arguments: {
        flowId: args.flowId
      },
      capabilities: []
    },
    presentation: {
      reasoningText: args.reasoningText,
      stdoutPreview: args.stdoutPreview || `${args.flowId} projected to CLI`
    }
  });
  writeServertoolCliTicket(ticket);
  return {
    ticket,
    chatResponse: buildExecCommandChatResponse({
      requestId: args.options.requestId,
      ticket,
      reasoningText: ticket.presentation.reasoningText
    })
  };
}

function buildExecCommandChatResponse(args: {
  requestId: string;
  ticket: ServertoolCliTicket;
  reasoningText: string;
}): JsonObject {
  const command = `routecodex servertool run --ticket ${args.ticket.ticketId}`;
  return {
    id: `chatcmpl_${args.ticket.ticketId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'routecodex-servertool-cli',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: args.reasoningText,
          reasoning: {
            content: [{ type: 'reasoning_text', text: args.reasoningText }]
          },
          tool_calls: [
            {
              id: args.ticket.clientTool.callId,
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
      ticketId: args.ticket.ticketId,
      clientCallId: args.ticket.clientTool.callId,
      modelToolName: args.ticket.modelTool.name,
      modelToolCallId: args.ticket.modelTool.callId,
      requestId: args.requestId
    }
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

function readScope(adapterContext: unknown): {
  sessionId?: string;
  conversationId?: string;
} {
  const record = adapterContext && typeof adapterContext === 'object' && !Array.isArray(adapterContext)
    ? adapterContext as Record<string, unknown>
    : {};
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined;
  const conversationId = typeof record.conversationId === 'string' && record.conversationId.trim() ? record.conversationId.trim() : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}
