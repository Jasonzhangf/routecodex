import type {
  ApplyRequestHeadersInput,
  BuildRequestBodyInput,
  ProviderFamilyProfile,
  ResolveEndpointInput,
  ResolveOAuthTokenFileInput,
  ResolveUserAgentInput
} from '../profile-contracts.js';

type UnknownRecord = Record<string, unknown>;

const DEFAULT_QWEN_CODE_UA_VERSION = '0.10.3';
const QWEN_OAUTH_AUTH_TYPE = 'qwen-oauth';
const QWEN_OAUTH_CODER_MODEL = 'coder-model';
const QWEN_OAUTH_VISION_MODEL = 'vision-model';
const QWEN_WEB_SEARCH_ENDPOINT = '/api/v1/indices/plugin/web_search';

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

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getRequestMetadata(request: unknown): UnknownRecord | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  return isRecord(request.metadata) ? request.metadata : undefined;
}

function isQwenWebSearchRequest(input: ResolveEndpointInput | BuildRequestBodyInput): boolean {
  const metadata = getRequestMetadata(input.request);
  return metadata?.qwenWebSearch === true;
}

function normalizeQwenWebSearchEndpoint(value: unknown): string {
  if (typeof value !== 'string') {
    return QWEN_WEB_SEARCH_ENDPOINT;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return QWEN_WEB_SEARCH_ENDPOINT;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.includes('/indices/plugin/web_search')) {
    return trimmed;
  }
  return QWEN_WEB_SEARCH_ENDPOINT;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function buildQwenWebSearchBody(input: BuildRequestBodyInput): UnknownRecord {
  const sourceBody =
    isRecord(input.request) && isRecord(input.request.data)
      ? input.request.data
      : isRecord(input.defaultBody)
        ? input.defaultBody
        : {};
  const body: UnknownRecord = { ...sourceBody };
  const queryRaw =
    typeof body.uq === 'string' && body.uq.trim()
      ? body.uq.trim()
      : typeof body.query === 'string' && body.query.trim()
        ? body.query.trim()
        : '';
  body.uq = queryRaw;
  body.page = toPositiveInt(body.page, 1);
  body.rows = toPositiveInt(body.rows ?? body.count, 10);
  delete body.query;
  delete body.count;
  delete body.metadata;
  delete body.qwenWebSearch;
  delete body.entryEndpoint;
  delete body.model;
  delete body.messages;
  delete body.tools;
  delete body.stream;
  delete body.max_tokens;
  delete body.maxTokens;
  return body;
}

function extractAuthType(input: BuildRequestBodyInput): string {
  const runtimeType =
    input.runtimeMetadata && typeof input.runtimeMetadata.authType === 'string'
      ? input.runtimeMetadata.authType
      : '';
  if (runtimeType.trim()) {
    return runtimeType.trim().toLowerCase();
  }
  const metadataNode = isRecord(input.request) && isRecord(input.request.metadata) ? input.request.metadata : undefined;
  const metadataType = typeof metadataNode?.authType === 'string' ? metadataNode.authType : '';
  return metadataType.trim().toLowerCase();
}

function isQwenOAuthAuthType(authType: string): boolean {
  const normalized = authType.trim().toLowerCase();
  return normalized === QWEN_OAUTH_AUTH_TYPE || normalized === 'oauth';
}

function resolveQwenOAuthModel(requestedModel: string): string {
  const normalized = requestedModel.trim().toLowerCase();
  if (normalized === QWEN_OAUTH_VISION_MODEL) {
    return QWEN_OAUTH_VISION_MODEL;
  }
  if (normalized === QWEN_OAUTH_CODER_MODEL) {
    return QWEN_OAUTH_CODER_MODEL;
  }
  if (normalized.includes('vision') || normalized.includes('-vl')) {
    return QWEN_OAUTH_VISION_MODEL;
  }
  return QWEN_OAUTH_CODER_MODEL;
}

export const qwenFamilyProfile: ProviderFamilyProfile = {
  id: 'qwen/default',
  providerFamily: 'qwen',
  resolveEndpoint(input: ResolveEndpointInput): string | undefined {
    if (!isQwenWebSearchRequest(input)) {
      return undefined;
    }
    const metadata = getRequestMetadata(input.request);
    return normalizeQwenWebSearchEndpoint(metadata?.entryEndpoint);
  },
  buildRequestBody(input: BuildRequestBodyInput) {
    if (isQwenWebSearchRequest(input)) {
      return buildQwenWebSearchBody(input);
    }
    const authType = extractAuthType(input);
    if (authType && !isQwenOAuthAuthType(authType)) {
      return undefined;
    }
    const body = input.defaultBody;
    if (!body || typeof body !== 'object') {
      return undefined;
    }
    const requestBody = body as UnknownRecord;
    const rawModel = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
    if (!rawModel) {
      return body;
    }
    const resolvedModel = resolveQwenOAuthModel(rawModel);
    if (resolvedModel && resolvedModel !== rawModel) {
      requestBody.model = resolvedModel;
    }
    return body;
  },
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
