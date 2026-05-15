import { buildAnthropicResponseFromChat } from '../../../../response/response-runtime.js';
import { type JsonObject } from '../../../../types/json.js';
import type { BridgeToolDefinition } from '../../../../../types/bridge-message-types.js';
import { normalizeResponsesToolCallIds } from '../../../../../shared/responses-tool-utils.js';
import {
  applyClientPassthroughPatchWithNative,
  buildResponsesPayloadFromChatWithNative,
  resolveAliasMapFromRespSemanticsWithNative,
  resolveClientToolsRawFromRespSemanticsWithNative,
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { normalizeOpenaiChatReasoningOutboundWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import {
  shouldLogClientRemapDebugWithNative,
  assertNoUnknownToolNamesWithNative,
  remapChatToolCallsWithNative,
} from '../../../../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface ClientRemapProtocolSwitchOptions {
  payload: JsonObject;
  clientProtocol: ClientProtocol;
  requestId: string;
  requestSemantics?: JsonObject;
  responseSemantics?: JsonObject;
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
    if (shouldLogDebug) {
      console.log('[CLIENT-REMAP:DEBUG] input payload choices[0].finish_reason:', (options.payload as any)?.choices?.[0]?.finish_reason);
      console.log('[CLIENT-REMAP:DEBUG] input payload choices[0].message.tool_calls count:', (options.payload as any)?.choices?.[0]?.message?.tool_calls?.length);
    }
    clientPayload = buildResponsesPayloadFromChatWithNative(options.payload, {
      requestId: options.requestId,
      responseSemantics: options.responseSemantics,
      ...(toolsRaw ? { toolsRaw } : {})
    }) as JsonObject;
  }

  if (shouldLogDebug) {
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload status:', (clientPayload as any)?.status);
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload output count:', (clientPayload as any)?.output?.length);
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload output types:', (clientPayload as any)?.output?.map((o: any) => o.type));
    console.log('[CLIENT-REMAP:DEBUG] responsesPayload required_action:', JSON.stringify((clientPayload as any)?.required_action)?.slice(0, 200));
  }
  const patchedPayload = applyClientPassthroughPatchWithNative(
    clientPayload,
    options.payload
  ) as JsonObject;
  Object.assign(clientPayload as Record<string, unknown>, patchedPayload as Record<string, unknown>);
  if (options.clientProtocol === 'openai-responses') {
    normalizeResponsesToolCallIds(clientPayload as Record<string, unknown>);
  }
  enforceClientToolNameContract(options, clientPayload, toolsRaw);
  return clientPayload;
}
