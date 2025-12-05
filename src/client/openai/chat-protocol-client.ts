import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';

interface DataEnvelope {
  data?: Record<string, unknown>;
}

interface OpenAIChatPayload extends Record<string, unknown> {
  model?: string;
  max_tokens?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  stream?: unknown;
}

function hasDataEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & DataEnvelope {
  return typeof payload === 'object' && payload !== null && 'data' in payload;
}

export class OpenAIChatProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  constructor(private readonly defaultMaxTokens = 8192) {}

  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const payload = this.extractPayload(request);
    const body: OpenAIChatPayload = { ...payload };
    const inboundModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (!inboundModel) {
      throw new Error('provider-runtime-error: missing model from virtual router');
    }
    body.model = inboundModel;

    const resolvedTokens = this.resolveMaxTokens(body);
    if (resolvedTokens > 0) {
      body.max_tokens = resolvedTokens;
    }
    if ('maxTokens' in body) {
      delete body.maxTokens;
    }
    if ('metadata' in body) {
      delete body.metadata;
    }
    if (body.stream === true) {
      delete body.stream;
    }
    return body;
  }

  resolveEndpoint(_request: ProtocolRequestPayload, defaultEndpoint: string): string {
    return defaultEndpoint;
  }

  finalizeHeaders(
    headers: Record<string, string>,
    _request: ProtocolRequestPayload
  ): Record<string, string> {
    return headers;
  }

  private extractPayload(request: ProtocolRequestPayload): Record<string, unknown> {
    if (hasDataEnvelope(request)) {
      const envelope = request as ProtocolRequestPayload & DataEnvelope;
      if (envelope.data && typeof envelope.data === 'object') {
        return envelope.data;
      }
    }
    return { ...request };
  }

  private resolveMaxTokens(payload: OpenAIChatPayload): number {
    const requestTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined;
    const camelTokens = typeof payload.maxTokens === 'number' ? payload.maxTokens : undefined;
    if (typeof requestTokens === 'number' && requestTokens > 0) {
      return requestTokens;
    }
    if (typeof camelTokens === 'number' && camelTokens > 0) {
      return camelTokens;
    }
    const envValue = Number(process.env.ROUTECODEX_DEFAULT_MAX_TOKENS || process.env.RCC_DEFAULT_MAX_TOKENS || NaN);
    if (Number.isFinite(envValue) && envValue > 0) {
      return envValue;
    }
    return this.defaultMaxTokens;
  }
}
