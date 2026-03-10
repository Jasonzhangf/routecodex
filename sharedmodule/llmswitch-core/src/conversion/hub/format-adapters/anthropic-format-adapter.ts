import type { FormatAdapter } from './index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { normalizeReasoningInAnthropicPayload } from '../../shared/reasoning-normalizer.js';
import {
  parseReqInboundFormatEnvelopeWithNative,
  parseRespInboundFormatEnvelopeWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

interface AnthropicFormatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
}

export class AnthropicFormatAdapter implements FormatAdapter {
  readonly protocol = 'anthropic-messages';

  async parseRequest(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<AnthropicFormatPayload>> {
    const parsed = parseReqInboundFormatEnvelopeWithNative({
      rawRequest: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = parsed.payload as AnthropicFormatPayload;
    normalizeReasoningInAnthropicPayload(payload);
    return {
      protocol: this.protocol,
      direction: 'request',
      payload
    };
  }

  async buildRequest(format: FormatEnvelope<AnthropicFormatPayload>, _ctx: AdapterContext): Promise<AnthropicFormatPayload> {
    return format.payload as AnthropicFormatPayload;
  }

  async parseResponse(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<AnthropicFormatPayload>> {
    const parsed = parseRespInboundFormatEnvelopeWithNative({
      payload: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = parsed.payload as AnthropicFormatPayload;
    normalizeReasoningInAnthropicPayload(payload);
    return {
      protocol: this.protocol,
      direction: 'response',
      payload
    };
  }

  async buildResponse(format: FormatEnvelope<AnthropicFormatPayload>, _ctx: AdapterContext): Promise<AnthropicFormatPayload> {
    return format.payload as AnthropicFormatPayload;
  }
}
