import type { FormatAdapter } from './index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { JsonObject } from '../types/json.js';
import { normalizeReasoningInGeminiPayload } from '../../shared/reasoning-normalizer.js';
import {
  parseReqInboundFormatEnvelopeWithNative,
  parseRespInboundFormatEnvelopeWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

interface GeminiFormatPayload extends JsonObject {
  contents?: JsonObject[];
  tools?: JsonObject[];
}

export class GeminiFormatAdapter implements FormatAdapter {
  readonly protocol = 'gemini-chat';

  async parseRequest(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<GeminiFormatPayload>> {
    const parsed = parseReqInboundFormatEnvelopeWithNative({
      rawRequest: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = parsed.payload as GeminiFormatPayload;
    normalizeReasoningInGeminiPayload(payload);
    return {
      protocol: this.protocol,
      direction: 'request',
      payload
    };
  }

  async buildRequest(format: FormatEnvelope<GeminiFormatPayload>, _ctx: AdapterContext): Promise<GeminiFormatPayload> {
    return format.payload as GeminiFormatPayload;
  }

  async parseResponse(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<GeminiFormatPayload>> {
    const parsed = parseRespInboundFormatEnvelopeWithNative({
      payload: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = parsed.payload as GeminiFormatPayload;
    normalizeReasoningInGeminiPayload(payload);
    return {
      protocol: this.protocol,
      direction: 'response',
      payload
    };
  }

  async buildResponse(format: FormatEnvelope<GeminiFormatPayload>, _ctx: AdapterContext): Promise<GeminiFormatPayload> {
    return format.payload as GeminiFormatPayload;
  }
}
