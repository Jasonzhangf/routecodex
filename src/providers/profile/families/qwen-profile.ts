import type {
  ApplyRequestHeadersInput,
  ProviderFamilyProfile,
  ResolveOAuthTokenFileInput,
  ResolveUserAgentInput
} from '../profile-contracts.js';

const DEFAULT_QWEN_CODE_UA_VERSION = '0.10.3';

function resolveQwenCodeUserAgentVersion(): string {
  const fromEnv =
    process.env.ROUTECODEX_QWEN_UA_VERSION ||
    process.env.RCC_QWEN_UA_VERSION ||
    process.env.ROUTECODEX_QWEN_CODE_UA_VERSION ||
    process.env.RCC_QWEN_CODE_UA_VERSION;
  const normalized = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  return normalized || DEFAULT_QWEN_CODE_UA_VERSION;
}

function buildQwenCodeUserAgent(): string {
  const version = resolveQwenCodeUserAgentVersion();
  return `QwenCode/${version} (${process.platform}; ${process.arch})`;
}

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

function findHeaderValue(headers: Record<string, string>, target: string): string | undefined {
  const lowered = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      return typeof value === 'string' ? value : undefined;
    }
  }
  return undefined;
}

function deleteHeaderInsensitive(headers: Record<string, string>, target: string): void {
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      delete headers[key];
    }
  }
}

function resolveDashScopeAuthType(input: ApplyRequestHeadersInput): string {
  const fromEnv = (process.env.ROUTECODEX_QWEN_DASHSCOPE_AUTH_TYPE || process.env.RCC_QWEN_DASHSCOPE_AUTH_TYPE || '').trim();
  if (fromEnv) {
    return fromEnv;
  }

  const runtimeAuthType =
    input.runtimeMetadata && typeof input.runtimeMetadata.authType === 'string'
      ? input.runtimeMetadata.authType.trim()
      : '';
  if (runtimeAuthType) {
    return runtimeAuthType;
  }

  return 'qwen-oauth';
}

function hasConfiguredOAuthClient(auth: ResolveOAuthTokenFileInput['auth']): boolean {
  return !!auth.clientId || !!auth.tokenUrl || !!auth.deviceCodeUrl;
}

export const qwenFamilyProfile: ProviderFamilyProfile = {
  id: 'qwen/default',
  providerFamily: 'qwen',
  resolveUserAgent(input: ResolveUserAgentInput): string | undefined {
    return input.uaFromConfig ?? input.uaFromService ?? buildQwenCodeUserAgent();
  },
  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> {
    const headers = { ...(input.headers || {}) };

    const resolvedUserAgent =
      findHeaderValue(headers, 'User-Agent') ||
      buildQwenCodeUserAgent();
    assignHeader(headers, 'User-Agent', resolvedUserAgent);

    // Keep request headers consistent with Qwen Code DashScope-compatible client behavior.
    assignHeader(headers, 'X-DashScope-CacheControl', 'enable');
    assignHeader(headers, 'X-DashScope-UserAgent', resolvedUserAgent);
    assignHeader(headers, 'X-DashScope-AuthType', resolveDashScopeAuthType(input));

    // Remove legacy Gemini-style metadata headers for qwen requests.
    deleteHeaderInsensitive(headers, 'X-Goog-Api-Client');
    deleteHeaderInsensitive(headers, 'Client-Metadata');

    return headers;
  },
  resolveOAuthTokenFileMode(input: ResolveOAuthTokenFileInput): boolean | undefined {
    if (input.oauthProviderId !== 'qwen') {
      return undefined;
    }
    return !hasConfiguredOAuthClient(input.auth);
  }
};
