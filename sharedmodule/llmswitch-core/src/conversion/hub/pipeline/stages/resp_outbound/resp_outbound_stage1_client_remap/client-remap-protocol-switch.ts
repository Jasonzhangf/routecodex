import { buildAnthropicResponseFromChat } from '../../../../response/response-runtime.js';
import { type JsonObject } from '../../../../types/json.js';
import { normalizeResponsesToolCallIds } from '../../../../../shared/responses-tool-utils.js';
import {
  applyClientPassthroughPatchWithNative,
  buildResponsesPayloadFromChatWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import {
  resolveAliasMapFromSemantics,
  resolveClientToolsRawFromSemantics
} from './chat-process-semantics-bridge.js';

export type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface ClientRemapProtocolSwitchOptions {
  payload: JsonObject;
  clientProtocol: ClientProtocol;
  requestId: string;
  requestSemantics?: JsonObject;
}

export function buildClientPayloadForProtocol(options: ClientRemapProtocolSwitchOptions): JsonObject {
  let clientPayload: JsonObject;
  if (options.clientProtocol === 'openai-chat') {
    clientPayload = options.payload;
  } else if (options.clientProtocol === 'anthropic-messages') {
    clientPayload = buildAnthropicResponseFromChat(options.payload, {
      aliasMap: resolveAliasMapFromSemantics(options.requestSemantics)
    });
  } else {
    const toolsRaw = resolveClientToolsRawFromSemantics(options.requestSemantics);
    clientPayload = buildResponsesPayloadFromChatWithNative(options.payload, {
      requestId: options.requestId,
      ...(toolsRaw ? { toolsRaw } : {})
    }) as JsonObject;
  }

  const patchedPayload = applyClientPassthroughPatchWithNative(
    clientPayload,
    options.payload
  ) as JsonObject;
  Object.assign(clientPayload as Record<string, unknown>, patchedPayload as Record<string, unknown>);
  if (options.clientProtocol === 'openai-responses') {
    normalizeResponsesToolCallIds(clientPayload as Record<string, unknown>);
  }
  return clientPayload;
}
