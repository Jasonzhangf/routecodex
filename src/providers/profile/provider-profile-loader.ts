import type {
  ProviderProfile,
  ProviderProfileCollection,
  ProviderTransportConfig,
  ProviderAuthConfig,
  ProviderProtocol
} from './provider-profile.js';

type UnknownRecord = Record<string, unknown>;

export function buildProviderProfiles(config: UnknownRecord): ProviderProfileCollection {
  const providersNode = collectProviderNodes(config);
  const profiles: ProviderProfile[] = [];
  for (const [id, raw] of Object.entries(providersNode)) {
    if (!isRecord(raw)) {
      continue;
    }
    const moduleType = pickString(raw.type) ?? pickString(raw.module);
    const protocol = resolveProtocol(id, raw, moduleType);
    const transport = extractTransport(raw);
    const auth = extractAuth(raw);
    const compatibilityProfile = extractCompatProfile(id, raw);
    const metadata = extractMetadata(raw);
    profiles.push({
      id,
      protocol,
      moduleType: moduleType?.trim(),
      transport,
      auth,
      compatibilityProfile,
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

function resolveProtocol(id: string, raw: UnknownRecord, moduleType?: string): ProviderProtocol {
  const moduleHint = sanitizeType(moduleType);
  const rawType =
    sanitizeType(pickString(raw.providerType)) ??
    sanitizeType(pickString(raw.protocol)) ??
    moduleHint ??
    sanitizeType(pickString(raw.module));
  if (!rawType) {
    return 'openai';
  }
  const normalized = rawType.trim();
  if (protocolAliases.openai.has(normalized)) {
    return 'openai';
  }
  if (protocolAliases.responses.has(normalized)) {
    return 'responses';
  }
  if (protocolAliases.anthropic.has(normalized)) {
    return 'anthropic';
  }
  if (protocolAliases.gemini.has(normalized)) {
    return 'gemini';
  }
  if (protocolAliases['gemini-cli'].has(normalized)) {
    return 'gemini-cli';
  }
  throw new Error(`[provider-profiles] Provider "${id}" has unsupported type "${rawType}".`);
}

const protocolAliases = {
  openai: new Set(['openai', 'glm', 'qwen', 'lmstudio', 'iflow', 'chat', 'openai-http', 'openai-standard', 'mock']),
  responses: new Set(['responses', 'openai-responses', 'responses-http']),
  anthropic: new Set(['anthropic', 'anthropic-http', 'claude']),
  gemini: new Set(['gemini', 'gemini2', 'gemini-chat', 'gemini-http']),
  'gemini-cli': new Set(['gemini-cli', 'gemini-cli-chat', 'gemini-cli-http'])
};

function sanitizeType(value?: string): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  return value.trim().toLowerCase().replace(/-provider$/, '');
}

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
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, raw]) => [key, pickString(raw)] as const)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) {
    return undefined;
  }
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

function extractCompatProfile(providerId: string, raw: UnknownRecord): string | undefined {
  const declared = pickString(raw.compatibilityProfile);
  const legacyFields: string[] = [];
  if (typeof raw.compatibility_profile === 'string') {
    legacyFields.push('compatibility_profile');
  }
  if (typeof raw.compat === 'string') {
    legacyFields.push('compat');
  }
  if (isRecord(raw.compatibility)) {
    const compatNode = raw.compatibility as Record<string, unknown>;
    if (typeof compatNode.profile === 'string') {
      legacyFields.push('compatibility.profile');
    }
    if (typeof compatNode.id === 'string') {
      legacyFields.push('compatibility.id');
    }
  }
  if (legacyFields.length > 0) {
    throw new Error(
      `[provider-profiles] Provider "${providerId}" uses legacy compatibility field(s): ${legacyFields.join(
        ', '
      )}. Rename to "compatibilityProfile".`
    );
  }
  return declared;
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

function collectProviderNodes(config: UnknownRecord): Record<string, UnknownRecord> {
  const entries: Record<string, UnknownRecord> = {};
  const merge = (node?: UnknownRecord) => {
    if (!node) {
      return;
    }
    for (const [id, raw] of Object.entries(node)) {
      if (isRecord(raw)) {
        entries[id] = raw;
      }
    }
  };
  merge(isRecord(config.providers) ? (config.providers as UnknownRecord) : undefined);
  const vr = isRecord(config.virtualrouter) ? (config.virtualrouter as UnknownRecord) : undefined;
  if (vr && isRecord(vr.providers)) {
    merge(vr.providers as UnknownRecord);
  }
  return entries;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  if (!value) {
    return undefined;
  }
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
