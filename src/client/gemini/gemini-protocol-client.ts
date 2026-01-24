import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';

interface DataEnvelope {
  data?: Record<string, unknown>;
}

interface GeminiPayload extends Record<string, unknown> {
  model?: string;
  max_tokens?: number;
  generationConfig?: Record<string, unknown>;
}

function hasDataEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & DataEnvelope {
  return typeof payload === 'object' && payload !== null && 'data' in payload;
}

export class GeminiProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const payload = this.extractPayload(request);
    const body: GeminiPayload = { ...payload };

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      throw new Error('provider-runtime-error: missing model from virtual router');
    }

    // Internal routing/debug metadata must never be forwarded to upstream providers.
    // (It can be huge, e.g. __raw_request_body / clientHeaders, and may trigger 400s.)
    if ('metadata' in body) {
      delete (body as unknown as { metadata?: unknown }).metadata;
    }

    const generationConfig = this.extractGenerationConfig(body);
    delete body.model;
    if ('max_tokens' in body) {
      delete body.max_tokens;
    }
    if (generationConfig) {
      body.generationConfig = generationConfig;
    }
    return stripInternalKeysDeep(body);
  }

  resolveEndpoint(request: ProtocolRequestPayload, defaultEndpoint: string): string {
    const payload = this.extractPayload(request);
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    if (!model) {
      return defaultEndpoint;
    }
    return `/models/${encodeURIComponent(model)}:generateContent`;
  }

  finalizeHeaders(
    headers: Record<string, string>,
    _request: ProtocolRequestPayload
  ): Record<string, string> {
    const normalized: Record<string, string> = { ...headers };
    const hasGeminiKey = Object.keys(normalized).some(key => key.toLowerCase() === 'x-goog-api-key');
    if (!hasGeminiKey) {
      const authorizationKey = Object.keys(normalized).find(key => key.toLowerCase() === 'authorization');
      if (authorizationKey) {
        const token = normalized[authorizationKey]?.replace(/^Bearer\s+/i, '').trim();
        if (token) {
          normalized['x-goog-api-key'] = token;
          delete normalized[authorizationKey];
        }
      }
    }
    if (!('Accept' in normalized) && !('accept' in normalized)) {
      normalized['Accept'] = 'application/json';
    }
    return normalized;
  }

  private extractPayload(request: ProtocolRequestPayload): GeminiPayload {
    if (hasDataEnvelope(request)) {
      const envelopeData = request.data;
      if (envelopeData && typeof envelopeData === 'object') {
        return envelopeData as GeminiPayload;
      }
    }
    return { ...(request as Record<string, unknown>) } as GeminiPayload;
  }

  private extractGenerationConfig(payload: GeminiPayload): Record<string, unknown> | undefined {
    const generationConfig =
      typeof payload.generationConfig === 'object' && payload.generationConfig !== null
        ? { ...(payload.generationConfig as Record<string, unknown>) }
        : {};

    if (typeof payload.max_tokens === 'number') {
      generationConfig.maxOutputTokens = payload.max_tokens;
    }

    return Object.keys(generationConfig).length > 0 ? generationConfig : undefined;
  }
}
