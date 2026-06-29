import type {
  ProviderForwarderCollection,
  ProviderForwarderProfile,
  ProviderForwarderStrategy,
  ProviderForwarderResolutionMode,
  ProviderForwarderStickyKey,
  ProviderForwarderTarget,
} from './forwarder-types.js';
import { FORWARDER_ID_PREFIX, validateForwarderId } from './forwarder-types.js';
import type {
  ProviderProfile,
  ProviderProfileCollection,
  ProviderTransportConfig,
  ProviderAuthConfig,
  ProviderProtocol
} from './provider-profile.js';

import type { ApiKeyEntry, ApiKeyAuthConfig } from './provider-profile.js';
import { formatUnknownError, isRecord } from '../../utils/common-utils.js';

type UnknownRecord = Record<string, unknown>;
type ConcurrencyMetadata = NonNullable<NonNullable<ProviderProfile['metadata']>['concurrency']>;
type RpmMetadata = NonNullable<NonNullable<ProviderProfile['metadata']>['rpm']>;

export function buildProviderProfiles(config: UnknownRecord): ProviderProfileCollection {
  const providersNode = collectProviderNodes(config);
  const profiles: ProviderProfile[] = [];
  for (const [id, raw] of Object.entries(providersNode)) {
    if (!isRecord(raw)) {
      continue;
    }
    const protocolTypeHint = pickString(raw.type) ?? pickString(raw.providerType) ?? pickString(raw.protocol) ?? pickString(raw.module);
    const moduleType = pickString(raw.providerModule ?? raw.provider_module) ?? pickString(raw.module) ?? pickString(raw.type);
    const protocol = resolveProtocol(id, raw, protocolTypeHint);
    const transport = extractTransport(raw);
    const auth = extractAuth(raw);
    const compatibilityProfile = extractCompatProfile(id, raw);
    const metadata = extractMetadata(raw, compatibilityProfile);
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
  throw new Error(`[provider-profiles] Provider "${id}" has unsupported type "${rawType}".`);
}

const protocolAliases = {
  openai: new Set([
    'openai',
    'glm',
    'lmstudio',
    'chat',
    'openai-http',
    'openai-standard',
    'mock'
  ]),
  responses: new Set(['responses', 'openai-responses', 'responses-http']),
  anthropic: new Set(['anthropic', 'anthropic-http', 'claude', 'mimoweb', 'mimoweb-http']),
  gemini: new Set(['gemini', 'gemini2', 'gemini-chat', 'gemini-http'])
};

function sanitizeType(value?: string): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  return value.trim().toLowerCase().replace(/-provider$/, '');
}

function extractTransport(raw: UnknownRecord): ProviderTransportConfig {
  const headers = extractHeaders(raw.headers) ?? extractHeaders(raw.defaultHeaders);
  const transportNode = isRecord(raw.transport) ? (raw.transport as UnknownRecord) : undefined;
  const backendRaw = pickString(raw.transportBackend ?? transportNode?.backend);
  const normalizedBackend = backendRaw?.trim().toLowerCase();
  const backend =
    normalizedBackend === 'vercel-ai-sdk'
      ? 'vercel-ai-sdk'
      : normalizedBackend === 'openai-sdk'
        ? 'openai-sdk'
        : normalizedBackend === 'native-http'
          ? 'native-http'
          : undefined;
  return {
    baseUrl: pickString(raw.baseURL ?? raw.baseUrl ?? raw.base_url),
    endpoint: pickString(raw.endpoint),
    timeoutMs: pickNumber(raw.timeout ?? raw.timeoutMs),
    maxRetries: pickNumber(raw.retryAttempts ?? raw.retry_attempts),
    headers,
    backend
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
 if (normalizedType === 'apikey') {
   return {
     kind: 'apikey',
     entries: extractApiKeyEntriesArray(authNode),
     apiKey: apiKeyValue,
     secretRef: secretRefValue,
      env: envRefValue,
      rawType: typeHint,
      mobile: pickString(authNode?.mobile ?? authNode?.account ?? authNode?.username ?? raw.mobile ?? raw.account),
      password: pickString(authNode?.password ?? raw.password),
      accountFile: pickString(authNode?.accountFile ?? authNode?.account_file ?? raw.accountFile ?? raw.account_file),
      accountAlias: pickString(authNode?.accountAlias ?? authNode?.account_alias ?? raw.accountAlias ?? raw.account_alias),
      tokenFile: pickString(authNode?.tokenFile ?? authNode?.token_file ?? raw.tokenFile ?? raw.token_file)
    };
  }
 return { kind: 'none' };
}

/**
 * 从 authNode 提取 API Key entries 数组
 */
function extractApiKeyEntriesArray(authNode: UnknownRecord | undefined): ApiKeyEntry[] | undefined {
  if (!authNode || !Array.isArray(authNode.entries)) {
    return undefined;
  }
  const entries = authNode.entries
    .filter((e: unknown) => isRecord(e))
    .map((e: unknown) => ({
      alias: pickString((e as UnknownRecord).alias),
      apiKey: pickString((e as UnknownRecord).apiKey),
      secretRef: pickString((e as UnknownRecord).secretRef),
      env: pickString((e as UnknownRecord).env ?? (e as UnknownRecord).envRef),
    }));
  return entries.length > 0 ? entries : undefined;
}

/**
 * 从 ApiKeyAuthConfig 提取所有 API Key 条目（统一单 key 和多 key 模式）
 */
export function extractApiKeyEntries(auth: ApiKeyAuthConfig): ApiKeyEntry[] {
  if (auth.entries && auth.entries.length > 0) {
    return auth.entries;
  }
  const singleEntry: ApiKeyEntry = {
    apiKey: auth.apiKey,
    secretRef: auth.secretRef,
    env: auth.env
  };
  if (singleEntry.apiKey || singleEntry.secretRef || singleEntry.env) {
    return [singleEntry];
  }
  return [];
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
    throw new Error('[provider-profiles] OAuth auth has been removed. Use auth.type="apikey".');
  }
  if (normalized && (normalized === 'apikey' || normalized === 'bearer')) {
    return 'apikey';
  }
  if (oauthNode) {
    throw new Error('[provider-profiles] OAuth auth has been removed. Remove the oauth block.');
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

function extractMetadata(raw: UnknownRecord, compatibilityProfile?: string): ProviderProfile['metadata'] {
  const defaultModel = pickString(raw.defaultModel ?? raw.default_model);
  const modelsNode = isRecord(raw.models) ? raw.models : undefined;
  const supportedModels = modelsNode ? Object.keys(modelsNode) : undefined;
  const concurrency = extractConcurrencyMetadata(raw.concurrency ?? (isRecord(raw.extensions) ? (raw.extensions as UnknownRecord).concurrency : undefined));
  const rpm = extractRpmMetadata(raw.rpm ?? (isRecord(raw.extensions) ? (raw.extensions as UnknownRecord).rpm : undefined));

  if (!defaultModel && (!supportedModels || supportedModels.length === 0) && !concurrency && !rpm) {
    return undefined;
  }

  const metadata: ProviderProfile['metadata'] = {};
  if (defaultModel) {
    metadata.defaultModel = defaultModel;
  }
  if (supportedModels && supportedModels.length > 0) {
    metadata.supportedModels = supportedModels;
  }
  if (concurrency) {
    metadata.concurrency = concurrency;
  }
  if (rpm) {
    metadata.rpm = rpm;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function extractConcurrencyMetadata(raw: unknown): ConcurrencyMetadata | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const node = raw as UnknownRecord;
  const maxInFlight = pickPositiveInt(node.maxInFlight ?? node.max_in_flight ?? node.maxConcurrency);
  if (!maxInFlight) {
    return undefined;
  }
  const acquireTimeoutMs = pickPositiveInt(node.acquireTimeoutMs ?? node.acquire_timeout_ms);
  const staleLeaseMs = pickPositiveInt(node.staleLeaseMs ?? node.stale_lease_ms);
  return {
    maxInFlight,
    ...(acquireTimeoutMs ? { acquireTimeoutMs } : {}),
    ...(staleLeaseMs ? { staleLeaseMs } : {})
  };
}

function extractRpmMetadata(raw: unknown): RpmMetadata | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const node = raw as UnknownRecord;
  const requestsPerMinute = pickPositiveInt(node.requestsPerMinute ?? node.requests_per_minute ?? node.maxRequestsPerMinute ?? node.max_requests_per_minute ?? node.limit);
  if (!requestsPerMinute) {
    return undefined;
  }
  const acquireTimeoutMs = pickPositiveInt(node.acquireTimeoutMs ?? node.acquire_timeout_ms);
  return {
    requestsPerMinute,
    ...(acquireTimeoutMs ? { acquireTimeoutMs } : {})
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

function pickPositiveInt(value: unknown): number | undefined {
  const parsed = pickNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : undefined;
}

// ==================== ProviderForwarder loader ====================

export function buildForwarderProfiles(
  config: UnknownRecord,
  knownProviderIds: Set<string>
): ProviderForwarderCollection {
  const forwardersNode = collectForwarderNodes(config);
  const profiles: ProviderForwarderProfile[] = [];
  for (const [id, raw] of Object.entries(forwardersNode)) {
    if (!isRecord(raw)) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' is not an object`);
    }
    // P0-2: id opaque, only namespace check
    const validation = validateForwarderId(id);
    if (!validation.ok) {
      throw new Error(`[forwarder-profiles] ${validation.reason}`);
    }
    // 显式 model/protocol 字段；禁止从 id 推断
    const protocol = pickString(raw.protocol) as ProviderForwarderProfile['protocol'] | undefined;
    if (!protocol) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' missing protocol`);
    }
    if (!['openai', 'responses', 'anthropic', 'gemini'].includes(protocol)) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' has unsupported protocol '${protocol}'`);
    }
    const model = pickString(raw.model) ?? pickString(raw.modelId);
    if (!model) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' missing model`);
    }
    // 不接受旧字段名 transportOverride（hard guardrail）
    if ('transportOverride' in raw) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' transportOverride is not supported (forwarder is a pure index, no field merge)`);
    }
    const resolutionMode = (pickString(raw.resolutionMode) as ProviderForwarderResolutionMode | undefined) ?? 'model-first';
    if (!['model-first', 'provider-first'].includes(resolutionMode)) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' has invalid resolutionMode`);
    }
    const strategy = (pickString(raw.strategy) as ProviderForwarderStrategy | undefined) ?? 'round-robin';
    if (!['round-robin', 'priority', 'weighted'].includes(strategy)) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' has invalid strategy`);
    }
    const stickyKey = (pickString(raw.stickyKey) as ProviderForwarderStickyKey | undefined) ?? 'none';
    if (!['session', 'request', 'none'].includes(stickyKey)) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' has invalid stickyKey`);
    }
    const targets = parseForwarderTargets(raw.targets, id, knownProviderIds);
    if (targets.length === 0) {
      throw new Error(`[forwarder-profiles] forwarder '${id}' has no enabled targets`);
    }
    const weights = parseForwarderWeights(raw.weights);
    profiles.push({
      id,
      protocol,
      model,
      resolutionMode,
      strategy,
      stickyKey,
      targets,
      ...(weights ? { weights } : {}),
    });
  }
  return {
    profiles,
    byId: profiles.reduce<Record<string, ProviderForwarderProfile>>((acc, profile) => {
      acc[profile.id] = profile;
      return acc;
    }, {}),
  };
}

function collectForwarderNodes(config: UnknownRecord): Record<string, UnknownRecord> {
  const out: Record<string, UnknownRecord> = {};
  if (isRecord(config.forwarders)) {
    for (const [id, raw] of Object.entries(config.forwarders)) {
      if (isRecord(raw)) {
        out[id] = raw;
      }
    }
  }
  return out;
}

function parseForwarderTargets(
  raw: unknown,
  forwarderId: string,
  knownProviderIds: Set<string>
): ProviderForwarderTarget[] {
  if (!Array.isArray(raw)) {
    throw new Error(`[forwarder-profiles] forwarder '${forwarderId}' targets must be an array`);
  }
  const result: ProviderForwarderTarget[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      throw new Error(`[forwarder-profiles] forwarder '${forwarderId}' has invalid target entry`);
    }
    const providerId = pickString(entry.providerId) ?? pickString(entry.providerKey);
    if (!providerId) {
      throw new Error(`[forwarder-profiles] forwarder '${forwarderId}' target missing providerId`);
    }
    if (!knownProviderIds.has(providerId)) {
      throw new Error(`[forwarder-profiles] forwarder '${forwarderId}' references unknown providerId '${providerId}'`);
    }
    result.push({
      providerId,
      ...(pickPositiveInt(entry.weight) !== undefined ? { weight: pickPositiveInt(entry.weight) } : {}),
      ...(pickNumber(entry.priority) !== undefined ? { priority: pickNumber(entry.priority) } : {}),
      ...(entry.disabled === true ? { disabled: true } : {}),
    });
  }
  return result;
}

function parseForwarderWeights(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = pickNumber(v);
    if (n !== undefined && n > 0) {
      out[k] = n;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// Re-export the prefix for callers
export { FORWARDER_ID_PREFIX, validateForwarderId };
