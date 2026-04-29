import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';
import { OpenAIChatProtocolClient } from '../openai/chat-protocol-client.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';

const DEFAULT_VERSION = '2023-06-01';

interface DataEnvelope {
  data?: Record<string, unknown>;
}

function buildMalformedAnthropicRequest(message: string, details?: Record<string, unknown>): Error {
  const error = new Error(message);
  Object.assign(error, {
    code: 'MALFORMED_REQUEST',
    statusCode: 400,
    details
  });
  return error;
}

function hasDataEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & DataEnvelope {
  return typeof payload === 'object' && payload !== null && 'data' in payload;
}

function normalizeAnthropicToolChoice(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw buildMalformedAnthropicRequest('Invalid Anthropic tool_choice: empty string', {
        tool_choice: raw
      });
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'auto') {
      return { type: 'auto' };
    }
    if (lower === 'none') {
      return { type: 'none' };
    }
    if (lower === 'any' || lower === 'required') {
      return { type: 'any' };
    }
    return { type: trimmed };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  throw buildMalformedAnthropicRequest('Invalid Anthropic tool_choice: expected string or object', {
    tool_choice_type: Array.isArray(raw) ? 'array' : typeof raw
  });
}

export class AnthropicProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  private readonly chatClient = new OpenAIChatProtocolClient();
  private readonly version: string;

  constructor(version: string = DEFAULT_VERSION) {
    this.version = version;
  }

  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const rawPayload = this.extractPayload(request);
    const body = this.chatClient.buildRequestBody(request);
    const bodyRecord = body as Record<string, unknown>;
    const normalizedToolChoice = normalizeAnthropicToolChoice(bodyRecord.tool_choice);
    if (normalizedToolChoice !== undefined) {
      bodyRecord.tool_choice = normalizedToolChoice;
    }

    // Anthropic Messages supports top-level `metadata`. Some Claude-Code-gated proxies require it to exist.
    // The OpenAI chat client deletes `metadata`, so restore it (after stripping internal "__*" keys).
    const rawMetadata = (rawPayload as Record<string, unknown>).metadata;
    if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
      bodyRecord.metadata = stripInternalKeysDeep(rawMetadata as Record<string, unknown>);
    }

    return body;
  }

  resolveEndpoint(request: ProtocolRequestPayload, defaultEndpoint: string): string {
    return this.chatClient.resolveEndpoint(request, defaultEndpoint);
  }

  finalizeHeaders(
    headers: Record<string, string>,
    request: ProtocolRequestPayload
  ): Record<string, string> {
    const base = this.chatClient.finalizeHeaders(headers, request);
    const normalized: Record<string, string> = { ...base };

    const hasVersion = Object.keys(normalized).some(key => key.toLowerCase() === 'anthropic-version');
    if (!hasVersion) {
      normalized['anthropic-version'] = this.version;
    }

    const headerKeys = Object.keys(normalized);
    const hasXApiKey = headerKeys.some(key => key.toLowerCase() === 'x-api-key');
    if (!hasXApiKey) {
      const authKey = headerKeys.find(key => key.toLowerCase() === 'authorization');
      if (authKey) {
        const token = normalized[authKey]?.replace(/^Bearer\s+/i, '').trim();
        if (token) {
          normalized['x-api-key'] = token;
          delete normalized[authKey];
        }
      }
    }

    if (!('Accept' in normalized) && !('accept' in normalized)) {
      normalized['Accept'] = 'application/json';
    }

    return normalized;
  }

  private extractPayload(request: ProtocolRequestPayload): Record<string, unknown> {
    if (hasDataEnvelope(request)) {
      const envelope = request as ProtocolRequestPayload & DataEnvelope;
      if (envelope.data && typeof envelope.data === 'object') {
        return envelope.data;
      }
    }
    return { ...(request as Record<string, unknown>) };
  }
}
