import type { HttpProtocolClient, ProtocolRequestPayload } from '../http-protocol-client.js';
import type { UnknownObject } from '../../types/common-types.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';

interface ResponsesRequest extends Record<string, unknown> {
  model?: string;
  instructions?: string;
  input?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  stream?: boolean;
}

interface ResponsesEnvelope extends UnknownObject {
  data?: UnknownObject;
}

function hasEnvelope(payload: ProtocolRequestPayload): payload is ProtocolRequestPayload & ResponsesEnvelope {
  return Boolean(payload && typeof payload === 'object' && 'data' in payload);
}

export type ResponsesStreamingMode = 'auto' | 'always' | 'never';

export interface ResponsesClientConfig {
  streaming?: ResponsesStreamingMode;
  betaVersion?: string;
}

export class ResponsesProtocolClient implements HttpProtocolClient<ProtocolRequestPayload> {
  private readonly streaming: ResponsesStreamingMode;
  private readonly betaVersion: string;

  constructor(config: ResponsesClientConfig = {}) {
    this.streaming = config.streaming ?? 'auto';
    this.betaVersion = config.betaVersion ?? 'responses-2024-12-17';
  }

  buildRequestBody(request: ProtocolRequestPayload): Record<string, unknown> {
    const payload = this.extractPayload(request);
    const body: ResponsesRequest = { ...payload };
    const inboundModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (!inboundModel) {
      throw new Error('provider-runtime-error: missing model from virtual router');
    }
    body.model = inboundModel;
    if ('metadata' in body) {
      delete body.metadata;
    }
    return stripInternalKeysDeep(body);
  }

  resolveEndpoint(_request: ProtocolRequestPayload, defaultEndpoint: string): string {
    return defaultEndpoint;
  }

  finalizeHeaders(
    headers: Record<string, string>,
    _request: ProtocolRequestPayload
  ): Record<string, string> {
    const normalized: Record<string, string> = { ...headers };
    const hasBeta = Object.keys(normalized).some(key => key.toLowerCase() === 'openai-beta');
    if (!hasBeta) {
      normalized['OpenAI-Beta'] = this.betaVersion;
    }
    return normalized;
  }

  getStreamingPreference(): ResponsesStreamingMode {
    return this.streaming;
  }

  ensureStreamFlag(body: Record<string, unknown>, useStream: boolean): void {
    if (useStream) {
      body.stream = true;
      return;
    }
    if ('stream' in body) {
      delete body.stream;
    }
  }

  private extractPayload(request: ProtocolRequestPayload): Record<string, unknown> {
    if (hasEnvelope(request)) {
      const data = request.data;
      if (data && typeof data === 'object') {
        return { ...data };
      }
    }
    return { ...(request as Record<string, unknown>) };
  }
}
