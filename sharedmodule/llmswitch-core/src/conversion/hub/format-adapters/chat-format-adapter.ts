import type { FormatAdapter } from './index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { normalizeReasoningInChatPayload } from '../../shared/reasoning-normalizer.js';
import {
  parseReqInboundFormatEnvelopeWithNative,
  parseRespInboundFormatEnvelopeWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

interface ChatFormatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: JsonValue[];
}

export class ChatFormatAdapter implements FormatAdapter {
  readonly protocol = 'openai-chat';

  async parseRequest(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<ChatFormatPayload>> {
    const parsed = parseReqInboundFormatEnvelopeWithNative({
      rawRequest: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = parsed.payload as ChatFormatPayload;
    normalizeReasoningInChatPayload(payload);
    return {
      protocol: this.protocol,
      direction: 'request',
      payload
    };
  }

  async buildRequest(format: FormatEnvelope<ChatFormatPayload>, _ctx: AdapterContext): Promise<ChatFormatPayload> {
    return format.payload as ChatFormatPayload;
  }

  async parseResponse(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<ChatFormatPayload>> {
    const parsed = parseRespInboundFormatEnvelopeWithNative({
      payload: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = parsed.payload as ChatFormatPayload;
    normalizeReasoningInChatPayload(payload);
    return {
      protocol: this.protocol,
      direction: 'response',
      payload
    };
  }

  async buildResponse(format: FormatEnvelope<ChatFormatPayload>, _ctx: AdapterContext): Promise<ChatFormatPayload> {
    return format.payload as ChatFormatPayload;
  }
}
