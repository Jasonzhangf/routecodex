import type { FormatAdapter } from './index.js';
import type { AdapterContext } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import {
  parseReqInboundFormatEnvelopeWithNative,
  parseRespInboundFormatEnvelopeWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import {
  normalizeReqInboundReasoningPayloadWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import {
  normalizeRespInboundReasoningPayloadWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

interface ResponsesFormatPayload extends JsonObject {
  input?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: JsonValue[];
  output?: JsonValue[];
  id?: string;
}

export class ResponsesFormatAdapter implements FormatAdapter {
  readonly protocol = 'openai-responses';

  async parseRequest(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<ResponsesFormatPayload>> {
    const parsed = parseReqInboundFormatEnvelopeWithNative({
      rawRequest: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = normalizeReqInboundReasoningPayloadWithNative({
      payload: parsed.payload as Record<string, unknown>,
      protocol: this.protocol
    }) as ResponsesFormatPayload;
    return {
      protocol: this.protocol,
      direction: 'request',
      payload
    };
  }

  async buildRequest(format: FormatEnvelope<ResponsesFormatPayload>, _ctx: AdapterContext): Promise<ResponsesFormatPayload> {
    return format.payload as ResponsesFormatPayload;
  }

  async parseResponse(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<ResponsesFormatPayload>> {
    const parsed = parseRespInboundFormatEnvelopeWithNative({
      payload: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = normalizeRespInboundReasoningPayloadWithNative({
      payload: parsed.payload as Record<string, unknown>,
      protocol: this.protocol
    }) as ResponsesFormatPayload;
    return {
      protocol: this.protocol,
      direction: 'response',
      payload
    };
  }

  async buildResponse(format: FormatEnvelope<ResponsesFormatPayload>, _ctx: AdapterContext): Promise<ResponsesFormatPayload> {
    return format.payload as ResponsesFormatPayload;
  }
}
