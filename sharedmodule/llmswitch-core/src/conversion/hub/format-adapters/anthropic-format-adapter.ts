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

interface AnthropicFormatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
}

const ANTHROPIC_WIRE_TOP_LEVEL_FIELDS = new Set([
  'model',
  'messages',
  'tools',
  'system',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking'
]);

const ANTHROPIC_METADATA_ALLOW_KEYS = new Set([
  'user_id',
  'user'
]);

function pruneAnthropicWirePayload(payload: AnthropicFormatPayload): AnthropicFormatPayload {
  const record = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (ANTHROPIC_WIRE_TOP_LEVEL_FIELDS.has(key)) {
      out[key] = record[key];
    }
  }
  // Strip non-Anthropic metadata sub-fields
  if (out.metadata && typeof out.metadata === 'object' && !Array.isArray(out.metadata)) {
    const md = out.metadata as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const k of Object.keys(md)) {
      if (ANTHROPIC_METADATA_ALLOW_KEYS.has(k)) {
        clean[k] = md[k];
      }
    }
    if (Object.keys(clean).length > 0) {
      out.metadata = clean;
    } else {
      delete out.metadata;
    }
  }
  return out as unknown as AnthropicFormatPayload;
}

export class AnthropicFormatAdapter implements FormatAdapter {
  readonly protocol = 'anthropic-messages';

  async parseRequest(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<AnthropicFormatPayload>> {
    const parsed = parseReqInboundFormatEnvelopeWithNative({
      rawRequest: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = normalizeReqInboundReasoningPayloadWithNative({
      payload: parsed.payload as Record<string, unknown>,
      protocol: this.protocol
    }) as AnthropicFormatPayload;
    return {
      protocol: this.protocol,
      direction: 'request',
      payload
    };
  }

  async buildRequest(format: FormatEnvelope<AnthropicFormatPayload>, _ctx: AdapterContext): Promise<AnthropicFormatPayload> {
    return pruneAnthropicWirePayload(format.payload as AnthropicFormatPayload);
  }

  async parseResponse(original: JsonObject, _ctx: AdapterContext): Promise<FormatEnvelope<AnthropicFormatPayload>> {
    const parsed = parseRespInboundFormatEnvelopeWithNative({
      payload: original as unknown as Record<string, unknown>,
      protocol: this.protocol
    });
    const payload = normalizeRespInboundReasoningPayloadWithNative({
      payload: parsed.payload as Record<string, unknown>,
      protocol: this.protocol
    }) as AnthropicFormatPayload;
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
