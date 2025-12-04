import type { ProviderProfile, ProviderProfileCollection, ProviderTransportConfig, ProviderAuthConfig, ProviderProtocol } from './provider-profile.js';

type UnknownRecord = Record<string, unknown>;

export function buildProviderProfiles(config: UnknownRecord): ProviderProfileCollection {
  const providersNode = isRecord(config.providers) ? config.providers : {};
  const profiles: ProviderProfile[] = [];
  for (const [id, raw] of Object.entries(providersNode)) {
    if (!isRecord(raw)) {
      continue;
    }
    const protocol = resolveProtocol(id, raw);
    const transport = extractTransport(raw);
    const auth = extractAuth(raw);
    const compatibilityProfiles = extractCompatProfiles(raw);
    const metadata = extractMetadata(raw);
    profiles.push({
      id,
      protocol,
      transport,
      auth,
      compatibilityProfiles,
      metadata
    });
  }
  return {
    profiles,
    byId: profiles.reduce<Record<string, ProviderProfile>>((acc, profile) => {
      acc[profile.id] = profile;
      return acc;
    }, {})
  };
}

function resolveProtocol(id: string, raw: UnknownRecord): ProviderProtocol {
  const rawType =
    pickString(raw.type) ??
    pickString(raw.providerType) ??
    pickString(raw.protocol) ??
    pickString(raw.module);
  if (!rawType) {
    return 'openai';
  }
  const normalized = rawType.trim().toLowerCase().replace(/-provider$/, '');
  if (protocolAliases.openai.has(normalized)) return 'openai';
  if (protocolAliases.responses.has(normalized)) return 'responses';
  if (protocolAliases.anthropic.has(normalized)) return 'anthropic';
  if (protocolAliases.gemini.has(normalized)) return 'gemini';
  throw new Error(`[provider-profiles] Provider "${id}" has unsupported type "${rawType}".`);
}

const protocolAliases = {
  openai: new Set(['openai', 'glm', 'qwen', 'lmstudio', 'iflow', 'chat', 'openai-http', 'openai-standard']),
  responses: new Set(['responses', 'openai-responses', 'responses-http']),
  anthropic: new Set(['anthropic', 'anthropic-http', 'claude']),
  gemini: new Set(['gemini', 'gemini2', 'gemini-chat', 'gemini-http'])
};

function extractTransport(raw: UnknownRecord): ProviderTransportConfig {
  const headers = extractHeaders(raw.headers) ?? extractHeaders(raw.defaultHeaders);
  return {
    baseUrl: pickString(raw.baseUrl ?? raw.base_url),
    endpoint: pickString(raw.endpoint),
    timeoutMs: pickNumber(raw.timeout ?? raw.timeoutMs),
    maxRetries: pickNumber(raw.retryAttempts ?? raw.retry_attempts),
    headers
  };
}

function extractHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, raw]) => [key, pickString(raw)] as const)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) return undefined;
  return entries.reduce<Record<string, string>>((acc, [key, val]) => {
    acc[key] = val;
    return acc;
  }, {});
}

function extractAuth(raw: UnknownRecord): ProviderAuthConfig {
  const authNode = isRecord(raw.auth) ? raw.auth : undefined;
  const oauthNode = isRecord(raw.oauth)
    ? raw.oauth
    : isRecord(authNode?.oauth)
      ? (authNode.oauth as UnknownRecord)
      : undefined;
  const typeHint = pickString(authNode?.type) ?? pickString(raw.authType);
  const apiKeyValue = pickString(authNode?.apiKey ?? raw.apiKey);
  const secretRefValue = pickString(authNode?.secretRef ?? raw.secretRef);
  const envRefValue = pickString(authNode?.env ?? raw.apiKeyEnv ?? raw.env);
  const normalizedType = normalizeAuthType(typeHint, oauthNode, apiKeyValue, secretRefValue, envRefValue);
  if (normalizedType === 'oauth') {
    const scopes = pickStringArray(oauthNode?.scopes ?? authNode?.scopes ?? raw.scopes);
    return {
      kind: 'oauth',
      clientId: pickString(oauthNode?.clientId ?? authNode?.clientId ?? raw.clientId),
      clientSecret: pickString(oauthNode?.clientSecret ?? authNode?.clientSecret ?? raw.clientSecret),
      tokenUrl: pickString(oauthNode?.tokenUrl ?? authNode?.tokenUrl ?? raw.tokenUrl),
      deviceCodeUrl: pickString(oauthNode?.deviceCodeUrl ?? authNode?.deviceCodeUrl ?? raw.deviceCodeUrl),
      authorizationUrl: pickString(oauthNode?.authorizationUrl ?? authNode?.authorizationUrl ?? raw.authorizationUrl),
      userInfoUrl: pickString(oauthNode?.userInfoUrl ?? authNode?.userInfoUrl ?? raw.userInfoUrl),
      refreshUrl: pickString(oauthNode?.refreshUrl ?? authNode?.refreshUrl ?? raw.refreshUrl),
      tokenFile: pickString(authNode?.tokenFile ?? raw.tokenFile),
      scopes
    };
  }
  if (normalizedType === 'apikey') {
    return {
      kind: 'apikey',
      apiKey: apiKeyValue,
      secretRef: secretRefValue,
      env: envRefValue
    };
  }
  return { kind: 'none' };
}

function normalizeAuthType(
  authType: string | undefined,
  oauthNode?: UnknownRecord,
  apiKey?: string,
  secretRef?: string,
  envRef?: string
): 'oauth' | 'apikey' | 'none' {
  const normalized = authType?.trim().toLowerCase();
  if (normalized && (normalized.includes('oauth') || normalized === 'bearer-oauth')) {
    return 'oauth';
  }
  if (normalized && (normalized === 'apikey' || normalized === 'bearer')) {
    return 'apikey';
  }
  if (oauthNode) {
    return 'oauth';
  }
  if (apiKey || secretRef || envRef) {
    return 'apikey';
  }
  return normalized ? 'apikey' : 'none';
}

function extractCompatProfiles(raw: UnknownRecord): string[] {
  const direct = pickStringArray(raw.compatibilityProfiles);
  if (direct) return direct;
  const compatNode = raw.compatibility;
  if (Array.isArray(compatNode)) {
    const arr = pickStringArray(compatNode);
    if (arr) return arr;
  }
  if (isRecord(compatNode) && Array.isArray(compatNode.profiles)) {
    const arr = pickStringArray(compatNode.profiles);
    if (arr) return arr;
  }
  return [];
}

function extractMetadata(raw: UnknownRecord): ProviderProfile['metadata'] {
  const defaultModel = pickString(raw.defaultModel ?? raw.default_model);
  const modelsNode = isRecord(raw.models) ? raw.models : undefined;
  const supportedModels = modelsNode ? Object.keys(modelsNode) : undefined;
  if (!defaultModel && (!supportedModels || supportedModels.length === 0)) {
    return undefined;
  }
  return {
    defaultModel,
    supportedModels
  };
}

function pickString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function pickNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => pickString(entry))
      .filter((entry): entry is string => typeof entry === 'string');
    return normalized.length ? Array.from(new Set(normalized)) : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
