import { randomUUID } from 'crypto';
import type {
  ApplyRequestHeadersInput,
  BuildRequestBodyInput,
  ProviderFamilyProfile,
  ResolveEndpointInput,
  ResolveOAuthTokenFileInput
} from '../profile-contracts.js';

function readStreamIntent(request: unknown): boolean | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return undefined;
  }
  const record = request as Record<string, unknown>;
  if (typeof record.stream === 'boolean') {
    return record.stream;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const dataStream = (data as Record<string, unknown>).stream;
    if (typeof dataStream === 'boolean') {
      return dataStream;
    }
  }
  // Fallback: read stream intent from metadata (used by /v1/responses entry)
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const metaStream = (metadata as Record<string, unknown>).stream;
    if (typeof metaStream === 'boolean') {
      return metaStream;
    }
  }
  return undefined;
}

function assignHeader(headers: Record<string, string>, name: string, value: string): void {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existingKey) {
    headers[existingKey] = value;
    return;
  }
  headers[name] = value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function createChatId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function readTargetModelId(input: BuildRequestBodyInput): string | undefined {
  const target = input.runtimeMetadata?.target;
  const modelId = target && typeof target.modelId === 'string' ? target.modelId.trim() : '';
  const model = target && typeof target.model === 'string' ? target.model.trim() : '';
  return modelId || model || undefined;
}

function buildEcoDevRequestBody(input: BuildRequestBodyInput): Record<string, unknown> | undefined {
  const targetModelId = readTargetModelId(input);
  const body = targetModelId
    ? {
        ...input.defaultBody,
        model: targetModelId
      }
    : input.defaultBody;
  return {
    ...body,
    stream: false
  };
}

export const ecodevFamilyProfile: ProviderFamilyProfile = {
  id: 'ecodev/default',
  providerFamily: 'ecodev',

  resolveOAuthTokenFileMode(input: ResolveOAuthTokenFileInput): boolean | undefined {
    const provider = input.oauthProviderId.trim().toLowerCase();
    const tokenFile = typeof input.tokenFile === 'string' ? input.tokenFile.trim() : '';
    if (
      provider === 'ecodev'
      && tokenFile.length > 0
    ) {
      return true;
    }
    return undefined;
  },

  resolveEndpoint(input: ResolveEndpointInput): string | undefined {
    void input;
    return '/v2/no-stream/chat/completions';
  },

  buildRequestBody(input: BuildRequestBodyInput): Record<string, unknown> | undefined {
    return buildEcoDevRequestBody(input);
  },

  resolveStreamIntent() {
    return false;
  },

  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> | undefined {
    const headers = { ...input.headers };
    assignHeader(headers, 'lang', 'en');
    if (!hasHeader(headers, 'Chat-Id')) {
      headers['Chat-Id'] = createChatId();
    }
    return headers;
  }
};
