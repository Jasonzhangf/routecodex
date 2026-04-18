import type { AdapterContext, ChatEnvelope } from '../../../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../../../types/format-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import { isJsonObject } from '../../../../types/json.js';
import {
  applyReqInboundSemanticLiftWithNative,
  mapReqInboundResumeToolOutputsDetailedWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export interface ReqInboundSemanticLiftOptions {
  chatEnvelope: ChatEnvelope;
  formatEnvelope: FormatEnvelope<JsonObject>;
  adapterContext: AdapterContext;
  responsesResume?: JsonObject;
}

export function liftReqInboundSemantics(options: ReqInboundSemanticLiftOptions): void {
  const normalizedResponsesResume =
    options.responsesResume && isJsonObject(options.responsesResume) ? options.responsesResume : undefined;
  const formatRecord = options.formatEnvelope as unknown as Record<string, unknown>;
  const protocol =
    typeof options.formatEnvelope.protocol === 'string' && options.formatEnvelope.protocol.trim().length
      ? options.formatEnvelope.protocol
      : typeof formatRecord.format === 'string' && String(formatRecord.format).trim().length
        ? String(formatRecord.format)
        : options.adapterContext.providerProtocol;
  const lifted = applyReqInboundSemanticLiftWithNative({
    chatEnvelope: options.chatEnvelope as unknown as Record<string, unknown>,
    payload: options.formatEnvelope.payload,
    protocol,
    entryEndpoint: options.adapterContext.entryEndpoint,
    responsesResume: normalizedResponsesResume,
    sessionId: typeof (options.adapterContext as Record<string, unknown>).sessionId === 'string'
      ? String((options.adapterContext as Record<string, unknown>).sessionId)
      : undefined,
    conversationId: typeof (options.adapterContext as Record<string, unknown>).conversationId === 'string'
      ? String((options.adapterContext as Record<string, unknown>).conversationId)
      : undefined
  });
  replaceEnvelope(options.chatEnvelope as unknown as Record<string, unknown>, lifted);
}

export function mapResumeToolOutputsDetailed(
  responsesResume: JsonObject
): Array<{ tool_call_id: string; content: string }> {
  return mapReqInboundResumeToolOutputsDetailedWithNative(responsesResume);
}

function replaceEnvelope(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}
