import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';
import { OpenAIChatProtocolClient } from '../openai/chat-protocol-client.js';

const DEFAULT_VERSION = '2023-06-01';

export class AnthropicProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  private readonly chatClient = new OpenAIChatProtocolClient();
  private readonly version: string;

  constructor(version: string = DEFAULT_VERSION) {
    this.version = version;
  }

  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const body = this.chatClient.buildRequestBody(request);

    try {
      const bodyRecord = body as Record<string, unknown>;
      const raw = bodyRecord.tool_choice;
      if (raw !== undefined && raw !== null) {
        let normalized: Record<string, unknown> | undefined;
        if (typeof raw === 'string') {
          const trimmed = raw.trim();
          if (trimmed) {
            const lower = trimmed.toLowerCase();
            if (lower === 'auto') {
              normalized = { type: 'auto' };
            } else if (lower === 'none') {
              normalized = { type: 'none' };
            } else if (lower === 'any') {
              normalized = { type: 'any' };
            } else if (lower === 'required') {
              normalized = { type: 'any' };
            } else {
              normalized = { type: trimmed };
            }
          }
        } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          normalized = { ...(raw as Record<string, unknown>) };
        }
        if (normalized) {
          bodyRecord.tool_choice = normalized;
        } else {
          // If we couldn't normalize, drop invalid value to avoid upstream 422.
          delete bodyRecord.tool_choice;
        }
      }
    } catch {
      // best-effort; fall back to original body on failure
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
}
