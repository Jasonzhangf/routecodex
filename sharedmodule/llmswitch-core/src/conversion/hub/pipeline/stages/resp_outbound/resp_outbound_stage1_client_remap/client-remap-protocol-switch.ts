import { buildAnthropicResponseFromChat } from '../../../../response/response-runtime.js';
import { type JsonObject } from '../../../../types/json.js';
import type { BridgeToolDefinition } from '../../../../../types/bridge-message-types.js';
import {
  applyClientPassthroughPatchWithNative,
  buildResponsesPayloadFromChatWithNative,
  resolveAliasMapFromRespSemanticsWithNative,
  resolveClientToolsRawFromRespSemanticsWithNative,
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { normalizeOpenaiChatReasoningOutboundWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import { buildResponsesPayloadFromChat } from '../../../../../responses/responses-openai-bridge/response-payload.js';
import {
  shouldLogClientRemapDebugWithNative,
  assertNoUnknownToolNamesWithNative,
  remapChatToolCallsWithNative,
} from '../../../../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';
import { normalizeResponsesToolCallIdsWithNative } from '../../../../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface ClientRemapProtocolSwitchOptions {
  payload: JsonObject;
  clientProtocol: ClientProtocol;
  requestId: string;
  requestSemantics?: JsonObject;
  responseSemantics?: JsonObject;
}

function hasChatToolCalls(payload: JsonObject): boolean {
  const choices = Array.isArray((payload as Record<string, unknown>).choices)
    ? ((payload as Record<string, unknown>).choices as unknown[])
    : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const toolCalls = (message as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return true;
    }
  }
  return false;
}

function hasResponsesFunctionCalls(payload: JsonObject): boolean {
  const output = Array.isArray((payload as Record<string, unknown>).output)
    ? ((payload as Record<string, unknown>).output as unknown[])
    : [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = typeof (item as Record<string, unknown>).type === 'string'
      ? String((item as Record<string, unknown>).type).trim().toLowerCase()
      : '';
    if (type === 'function_call') {
      return true;
    }
  }
  const requiredAction = (payload as Record<string, unknown>).required_action;
  if (!requiredAction || typeof requiredAction !== 'object' || Array.isArray(requiredAction)) {
    return false;
  }
  const submitToolOutputs = (requiredAction as Record<string, unknown>).submit_tool_outputs;
  if (!submitToolOutputs || typeof submitToolOutputs !== 'object' || Array.isArray(submitToolOutputs)) {
    return false;
  }
  const toolCalls = (submitToolOutputs as Record<string, unknown>).tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function remapChatToolCallsToClientNames(
  payload: JsonObject,
  clientToolsRaw?: BridgeToolDefinition[]
): string[] {
  const result = remapChatToolCallsWithNative(payload, clientToolsRaw);
  Object.assign(payload, result.payload);
  return result.unknownNames;
}

function remapResponsesToolCallsToClientNames(
  payload: JsonObject,
  clientToolsRaw?: BridgeToolDefinition[]
): string[] {
  const result = remapChatToolCallsWithNative(payload, clientToolsRaw);
  Object.assign(payload, result.payload);
  return result.unknownNames;
}

function enforceClientToolNameContract(
  options: ClientRemapProtocolSwitchOptions,
  payload: JsonObject,
  toolsRaw?: BridgeToolDefinition[]
): void {
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
    return;
  }
  const unknownFromChat = remapChatToolCallsToClientNames(payload, toolsRaw);
  const unknownFromResponses = remapResponsesToolCallsToClientNames(payload, toolsRaw);
  if (unknownFromChat.length > 0 || unknownFromResponses.length > 0) {
    assertNoUnknownToolNamesWithNative({
      requestId: options.requestId,
      clientProtocol: options.clientProtocol,
      unknownNames: [...unknownFromChat, ...unknownFromResponses],
      clientToolsRaw: toolsRaw
    });
  }
}

export function buildClientPayloadForProtocol(options: ClientRemapProtocolSwitchOptions): JsonObject {
  let clientPayload: JsonObject;
  const toolsRaw = resolveClientToolsRawFromRespSemanticsWithNative(options.requestSemantics) as
    | BridgeToolDefinition[]
    | undefined;
  const shouldLogDebug = shouldLogClientRemapDebugWithNative(options.payload);
  if (options.clientProtocol === 'openai-chat') {
    clientPayload = normalizeOpenaiChatReasoningOutboundWithNative(options.payload) as JsonObject;
  } else if (options.clientProtocol === 'anthropic-messages') {
    clientPayload = buildAnthropicResponseFromChat(options.payload, {
      aliasMap: resolveAliasMapFromRespSemanticsWithNative(options.requestSemantics)
    });
  } else {
    clientPayload = buildResponsesPayloadFromChatWithNative(options.payload, {
      requestId: options.requestId,
      responseSemantics: options.responseSemantics,
      ...(toolsRaw ? { toolsRaw } : {})
    }) as JsonObject;
    if (hasChatToolCalls(options.payload) && !hasResponsesFunctionCalls(clientPayload)) {
      const recovered = buildResponsesPayloadFromChat(options.payload, {
        requestId: options.requestId,
        ...(toolsRaw ? { toolsRaw } : {})
      }) as JsonObject;
      if (hasResponsesFunctionCalls(recovered)) {
        clientPayload = recovered;
      }
    }
  }
  const patchedPayload = applyClientPassthroughPatchWithNative(
    clientPayload,
    options.payload
  ) as JsonObject;
  Object.assign(clientPayload as Record<string, unknown>, patchedPayload as Record<string, unknown>);
  if (options.clientProtocol === 'openai-responses') {
    normalizeResponsesToolCallIdsWithNative(clientPayload);
  }
  enforceClientToolNameContract(options, clientPayload, toolsRaw);
  return clientPayload;
}
