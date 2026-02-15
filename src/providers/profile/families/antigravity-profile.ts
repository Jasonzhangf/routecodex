import { resolveAntigravityUserAgent } from '../../auth/antigravity-user-agent.js';
import { resolveAntigravityRequestTypeFromPayload } from '../../core/runtime/antigravity-request-type.js';
import type {
  ApplyRequestHeadersInput,
  ApplyStreamModeHeadersInput,
  ProviderFamilyProfile,
  ResolveUserAgentInput
} from '../profile-contracts.js';

function assignHeader(headers: Record<string, string>, target: string, value: string): void {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    return;
  }
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      headers[key] = normalizedValue;
      return;
    }
  }
  headers[target] = normalizedValue;
}

function deleteHeaderInsensitive(headers: Record<string, string>, target: string): void {
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      delete headers[key];
    }
  }
}

function getAntigravityHeaderMode(): 'minimal' | 'standard' | 'default' {
  const raw = (process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE || process.env.RCC_ANTIGRAVITY_HEADER_MODE || '')
    .trim()
    .toLowerCase();
  if (raw === 'minimal' || raw === 'standard') {
    return raw;
  }
  return 'default';
}

function extractAntigravityAlias(input: ResolveUserAgentInput): string | undefined {
  const runtime = input.runtimeMetadata;
  const candidates = [runtime?.runtimeKey, runtime?.providerKey];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (!value.toLowerCase().startsWith('antigravity.')) {
      continue;
    }
    const parts = value.split('.');
    if (parts.length >= 2 && parts[1] && parts[1].trim()) {
      return parts[1].trim();
    }
  }
  return undefined;
}

function extractRequestId(request: unknown): string | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return undefined;
  }
  const value = (request as Record<string, unknown>).requestId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveRequestType(request: unknown): string {
  return resolveAntigravityRequestTypeFromPayload(request);
}

function applyAntigravityHeaderContract(headers: Record<string, string>, request?: unknown): Record<string, string> {
  const next = { ...headers };

  deleteHeaderInsensitive(next, 'x-goog-api-client');
  deleteHeaderInsensitive(next, 'client-metadata');
  deleteHeaderInsensitive(next, 'accept-encoding');
  deleteHeaderInsensitive(next, 'originator');

  const mode = getAntigravityHeaderMode();
  if (mode === 'minimal') {
    const requestId = extractRequestId(request);
    if (requestId) {
      assignHeader(next, 'requestId', requestId);
    }
    assignHeader(next, 'requestType', resolveRequestType(request));
    return next;
  }

  deleteHeaderInsensitive(next, 'requestId');
  deleteHeaderInsensitive(next, 'requestType');
  return next;
}

function applyAntigravityStreamHeaderContract(input: ApplyStreamModeHeadersInput): Record<string, string> | undefined {
  if (getAntigravityHeaderMode() !== 'minimal') {
    return undefined;
  }
  return {
    ...input.headers,
    Accept: '*/*'
  };
}

export const antigravityFamilyProfile: ProviderFamilyProfile = {
  id: 'antigravity/default',
  providerFamily: 'antigravity',
  async resolveUserAgent(input: ResolveUserAgentInput): Promise<string | undefined> {
    const alias = extractAntigravityAlias(input);
    return resolveAntigravityUserAgent({ alias });
  },
  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> | undefined {
    return applyAntigravityHeaderContract(input.headers, input.request);
  },
  applyStreamModeHeaders(input: ApplyStreamModeHeadersInput): Record<string, string> | undefined {
    return applyAntigravityStreamHeaderContract(input);
  }
};
