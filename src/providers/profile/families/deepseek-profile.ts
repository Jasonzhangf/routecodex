import type {
  ApplyRequestHeadersInput,
  ApplyStreamModeHeadersInput,
  ProviderFamilyProfile,
  ResolveUserAgentInput
} from '../profile-contracts.js';
import {
  DEEPSEEK_UPSTREAM_CLIENT_VERSION,
  DEEPSEEK_UPSTREAM_USER_AGENT
} from '../../core/contracts/deepseek-provider-contract.js';

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

function getDeepSeekHeaderMode(): 'minimal' | 'standard' | 'default' {
  const raw = (process.env.ROUTECODEX_DEEPSEEK_HEADER_MODE || process.env.RCC_DEEPSEEK_HEADER_MODE || '')
    .trim()
    .toLowerCase();
  if (raw === 'minimal' || raw === 'standard') {
    return raw;
  }
  return 'default';
}

// extractDeepSeekAlias is kept for future use (UA customization based on alias)
// function extractDeepSeekAlias(input: ResolveUserAgentInput): string | undefined {
//   const runtime = input.runtimeMetadata;
//   const candidates = [runtime?.runtimeKey, runtime?.providerKey];
//   for (const candidate of candidates) {
//     const value = typeof candidate === 'string' ? candidate.trim() : '';
//     if (!value.toLowerCase().startsWith('deepseek.')) {
//       continue;
//     }
//     const parts = value.split('.');
//     if (parts.length >= 2 && parts[1] && parts[1].trim()) {
//       return parts[1].trim();
//     }
//   }
//   return undefined;
// }

function extractRequestId(request: unknown): string | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return undefined;
  }
  const value = (request as Record<string, unknown>).requestId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveRequestType(request: unknown): string {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return 'agent';
  }
  const metadataRaw = (request as Record<string, unknown>).metadata;
  if (!metadataRaw || typeof metadataRaw !== 'object' || Array.isArray(metadataRaw)) {
    return 'agent';
  }
  const hasImageAttachment =
    (metadataRaw as Record<string, unknown>).hasImageAttachment === true ||
    (metadataRaw as Record<string, unknown>).hasImageAttachment === 'true';
  return hasImageAttachment ? 'image_gen' : 'agent';
}

function applyDeepSeekHeaderContract(headers: Record<string, string>, request?: unknown): Record<string, string> {
  const next = { ...headers };

  // DeepSeek upstream identity must stay single-source and never leak client/Codex identity.
  deleteHeaderInsensitive(next, 'x-goog-api-client');
  deleteHeaderInsensitive(next, 'client-metadata');
  deleteHeaderInsensitive(next, 'accept-encoding');
  deleteHeaderInsensitive(next, 'originator');
  deleteHeaderInsensitive(next, 'anthropic-originator');
  deleteHeaderInsensitive(next, 'session_id');
  deleteHeaderInsensitive(next, 'conversation_id');
  deleteHeaderInsensitive(next, 'anthropic-session-id');
  deleteHeaderInsensitive(next, 'anthropic-conversation-id');

  assignHeader(next, 'User-Agent', DEEPSEEK_UPSTREAM_USER_AGENT);
  assignHeader(next, 'x-client-platform', 'android');
  assignHeader(next, 'x-client-version', DEEPSEEK_UPSTREAM_CLIENT_VERSION);
  assignHeader(next, 'x-client-locale', 'zh_CN');
  assignHeader(next, 'accept-charset', 'UTF-8');
  assignHeader(next, 'Origin', 'https://chat.deepseek.com');
  assignHeader(next, 'Referer', 'https://chat.deepseek.com/');
  assignHeader(next, 'Sec-Fetch-Site', 'same-origin');
  assignHeader(next, 'Sec-Fetch-Mode', 'cors');
  assignHeader(next, 'Sec-Fetch-Dest', 'empty');

  const mode = getDeepSeekHeaderMode();
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

function applyDeepSeekStreamHeaderContract(input: ApplyStreamModeHeadersInput): Record<string, string> | undefined {
  if (getDeepSeekHeaderMode() !== 'minimal') {
    return undefined;
  }
  return {
    ...input.headers,
    Accept: '*/*'
  };
}

export const deepseekFamilyProfile: ProviderFamilyProfile = {
  id: 'deepseek/default',
  providerFamily: 'deepseek',
  async resolveUserAgent(_input: ResolveUserAgentInput): Promise<string | undefined> {
    return DEEPSEEK_UPSTREAM_USER_AGENT;
  },
  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> | undefined {
    return applyDeepSeekHeaderContract(input.headers, input.request);
  },
  applyStreamModeHeaders(input: ApplyStreamModeHeadersInput): Record<string, string> | undefined {
    return applyDeepSeekStreamHeaderContract(input);
  }
};
