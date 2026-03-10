import { scanDeepSeekAccountTokenFiles, scanOAuthTokenFiles } from '../token-file-scanner.js';
import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type ProviderAuthConfig
} from '../types.js';
import { asRecord, normalizeAlias, pushUnique, readOptionalString } from './utils.js';

export interface ProviderAuthEntry {
  keyAlias: string;
  auth: ProviderAuthConfig;
}

type AuthFieldDefaults = Partial<ProviderAuthConfig>;

const MULTI_TOKEN_OAUTH_PROVIDERS = new Set<string>(['iflow', 'qwen', 'gemini-cli', 'antigravity']);

interface AuthTypeInfo {
  type: ProviderAuthConfig['type'];
  oauthProviderId?: string;
  raw?: string;
}

export function extractProviderAuthEntries(providerId: string, raw: unknown): ProviderAuthEntry[] {
  const provider = asRecord(raw);
  const auth = asRecord(provider.auth);
  const entries: ProviderAuthEntry[] = [];
  const aliasSet = new Set<string>();
  const baseTypeInfo = interpretAuthType(auth.type);
  const baseType = baseTypeInfo.type;
  const baseTypeSource = typeof auth.type === 'string' ? auth.type : undefined;
  const defaults = collectAuthDefaults(auth);

  const buildAuthCandidate = (
    typeHint: string | undefined,
    extras: Record<string, unknown> = {}
  ): Record<string, unknown> => {
    const source = typeof typeHint === 'string' && typeHint.trim() ? typeHint.trim() : baseTypeSource;
    const typeInfo = interpretAuthType(source ?? baseType);
    const rawType = typeInfo.raw ?? source ?? baseTypeSource;
    return {
      ...extras,
      type: typeInfo.type,
      rawType,
      oauthProviderId: (extras as any).oauthProviderId ?? typeInfo.oauthProviderId
    };
  };

  const pushEntry = (candidateAlias: string | undefined, authConfig: Record<string, unknown>) => {
    const alias = normalizeAlias(candidateAlias, aliasSet);
    const typeSource = (authConfig as any).rawType ?? (authConfig as any).type ?? baseTypeSource ?? baseType;
    const typeInfo = interpretAuthType(typeSource);
    const entryType = typeInfo.type;
    const oauthProviderId =
      (authConfig as any).oauthProviderId ?? typeInfo.oauthProviderId ?? baseTypeInfo.oauthProviderId;

    if (entryType === 'oauth' && !oauthProviderId) {
      throw new VirtualRouterError(
        `Provider ${providerId} OAuth auth entries must declare provider-specific type (e.g. "qwen-oauth")`,
        VirtualRouterErrorCode.CONFIG_ERROR
      );
    }

    const normalized: ProviderAuthConfig = {
      type: entryType,
      rawType: typeof typeSource === 'string' ? typeSource : undefined,
      oauthProviderId,
      value: readOptionalString((authConfig as any).value ?? (authConfig as any).apiKey),
      secretRef: readOptionalString((authConfig as any).secretRef)
    };
    normalized.tokenFile = readOptionalString((authConfig as any).tokenFile);
    normalized.tokenUrl = readOptionalString((authConfig as any).tokenUrl ?? (authConfig as any).token_url);
    normalized.deviceCodeUrl = readOptionalString(
      (authConfig as any).deviceCodeUrl ?? (authConfig as any).device_code_url
    );
    normalized.clientId = readOptionalString((authConfig as any).clientId ?? (authConfig as any).client_id);
    normalized.clientSecret = readOptionalString(
      (authConfig as any).clientSecret ?? (authConfig as any).client_secret
    );
    normalized.authorizationUrl = readOptionalString(
      (authConfig as any).authorizationUrl ??
      (authConfig as any).authorization_url ??
      (authConfig as any).authUrl
    );
    normalized.userInfoUrl = readOptionalString((authConfig as any).userInfoUrl ?? (authConfig as any).user_info_url);
    normalized.refreshUrl = readOptionalString((authConfig as any).refreshUrl ?? (authConfig as any).refresh_url);
    normalized.scopes = normalizeScopeList((authConfig as any).scopes ?? (authConfig as any).scope);

    normalized.secretRef ??= defaults.secretRef;
    normalized.tokenFile ??= defaults.tokenFile;
    normalized.tokenUrl ??= defaults.tokenUrl;
    normalized.deviceCodeUrl ??= defaults.deviceCodeUrl;
    normalized.clientId ??= defaults.clientId;
    normalized.clientSecret ??= defaults.clientSecret;
    normalized.authorizationUrl ??= defaults.authorizationUrl;
    normalized.userInfoUrl ??= defaults.userInfoUrl;
    normalized.refreshUrl ??= defaults.refreshUrl;
    normalized.scopes = mergeScopes(normalized.scopes, defaults.scopes);

    if (entryType === 'apiKey' && !normalized.secretRef) {
      normalized.secretRef = `${providerId}.${alias}`;
    }

    entries.push({ keyAlias: alias, auth: normalized });
    aliasSet.add(alias);
  };

  const fromRecord = (record: unknown) => {
    const data = asRecord(record);
    const alias = readOptionalString(data.alias as string | undefined);
    const typeValue = (data.type as string | undefined) ?? baseTypeSource ?? baseType;
    pushEntry(
      alias,
      buildAuthCandidate(typeValue, {
        value: (data.value as string | undefined) ?? (data.apiKey as string | undefined),
        secretRef: data.secretRef,
        tokenFile: data.tokenFile,
        tokenUrl: (data.tokenUrl as string | undefined) ?? (data.token_url as string | undefined),
        deviceCodeUrl: (data.deviceCodeUrl as string | undefined) ?? (data.device_code_url as string | undefined),
        clientId: (data.clientId as string | undefined) ?? (data.client_id as string | undefined),
        clientSecret: (data.clientSecret as string | undefined) ?? (data.client_secret as string | undefined),
        authorizationUrl:
          (data.authorizationUrl as string | undefined) ??
          (data.authorization_url as string | undefined) ??
          (data.authUrl as string | undefined),
        userInfoUrl: (data.userInfoUrl as string | undefined) ?? (data.user_info_url as string | undefined),
        refreshUrl: (data.refreshUrl as string | undefined) ?? (data.refresh_url as string | undefined),
        scopes: (data.scopes as unknown) ?? (data.scope as unknown)
      })
    );
  };

  if (Array.isArray(auth.entries)) {
    for (const entry of auth.entries) {
      fromRecord(entry);
    }
  }

  if (Array.isArray(auth.keys)) {
    for (const entry of auth.keys) {
      fromRecord(entry);
    }
  } else {
    const keysObject = asRecord(auth.keys);
    for (const [alias, entry] of Object.entries(keysObject)) {
      if (entry && typeof entry === 'object') {
        fromRecord({ alias, ...(entry as Record<string, unknown>) });
      } else if (typeof entry === 'string') {
        pushEntry(alias, buildAuthCandidate(baseTypeSource, { value: entry }));
      }
    }
  }

  const apiKeyField = provider.apiKey ?? provider.apiKeys ?? auth.apiKey;
  if (Array.isArray(apiKeyField)) {
    for (const item of apiKeyField) {
      if (typeof item === 'string' && item.trim()) {
        pushEntry(undefined, buildAuthCandidate(baseTypeSource, { value: item.trim() }));
      } else if (item && typeof item === 'object') {
        fromRecord(item);
      }
    }
  } else if (typeof apiKeyField === 'string' && apiKeyField.trim()) {
    pushEntry(undefined, buildAuthCandidate(baseTypeSource, { value: apiKeyField.trim() }));
  }

  const hasExplicitEntries = entries.length > 0;

  if (baseType === 'oauth' && !hasExplicitEntries) {
    const scanCandidates = new Set<string>();
    const pushCandidate = (value?: string) => {
      if (typeof value === 'string' && value.trim()) {
        scanCandidates.add(value.trim().toLowerCase());
      }
    };
    pushCandidate((auth as any).oauthProviderId as string | undefined);
    pushCandidate(baseTypeInfo.oauthProviderId);
    pushCandidate(providerId);

    for (const candidate of scanCandidates) {
      if (!MULTI_TOKEN_OAUTH_PROVIDERS.has(candidate)) {
        continue;
      }
      const tokenFiles = scanOAuthTokenFiles(candidate);
      if (!tokenFiles.length) {
        continue;
      }
      const baseTypeAlias = baseTypeInfo.oauthProviderId?.toLowerCase();
      for (const match of tokenFiles) {
        const alias =
          match.alias && match.alias !== 'default'
            ? `${match.sequence}-${match.alias}`
            : String(match.sequence);
        const typeHint =
          baseTypeSource && baseTypeAlias === candidate
            ? baseTypeSource
            : `${candidate}-oauth`;
        const authConfig: Record<string, unknown> = {
          ...defaults,
          type: typeHint,
          tokenFile: match.filePath,
          oauthProviderId: candidate
        };
        pushEntry(alias, authConfig);
      }
    }
  }

  const baseRawType = String(baseTypeInfo.raw ?? baseTypeSource ?? '').trim().toLowerCase();
  if (baseType === 'apiKey' && baseRawType === 'deepseek-account' && !hasExplicitEntries) {
    const tokenFiles = scanDeepSeekAccountTokenFiles();
    for (const match of tokenFiles) {
      const authConfig: Record<string, unknown> = {
        ...defaults,
        type: baseTypeSource ?? 'deepseek-account',
        tokenFile: match.filePath
      };
      pushEntry(match.alias, authConfig);
    }
  }

  if (!entries.length) {
    const fallbackExtras: Record<string, unknown> = {
      value: readOptionalString(auth.value as string | undefined),
      secretRef: readOptionalString(auth.secretRef as string | undefined),
      tokenFile: readOptionalString((auth.tokenFile as string | undefined) ?? (auth.file as string | undefined)),
      tokenUrl: readOptionalString((auth.tokenUrl as string | undefined) ?? (auth.token_url as string | undefined)),
      deviceCodeUrl: readOptionalString(
        (auth.deviceCodeUrl as string | undefined) ?? (auth.device_code_url as string | undefined)
      ),
      clientId: readOptionalString((auth.clientId as string | undefined) ?? (auth.client_id as string | undefined)),
      clientSecret: readOptionalString(
        (auth.clientSecret as string | undefined) ?? (auth.client_secret as string | undefined)
      ),
      authorizationUrl: readOptionalString(
        (auth as any).authorizationUrl ?? (auth as any).authorization_url ?? (auth as any).authUrl
      ),
      userInfoUrl: readOptionalString((auth as any).userInfoUrl ?? (auth as any).user_info_url),
      refreshUrl: readOptionalString((auth as any).refreshUrl ?? (auth as any).refresh_url),
      scopes: normalizeScopeList((auth as any).scopes ?? (auth as any).scope),
      cookieFile: readOptionalString((auth as any).cookieFile as string | undefined)
    };
    const fallbackHasData = Boolean(
      (fallbackExtras as any).value ||
      (fallbackExtras as any).secretRef ||
      (fallbackExtras as any).tokenFile ||
      (fallbackExtras as any).tokenUrl ||
      (fallbackExtras as any).deviceCodeUrl ||
      (fallbackExtras as any).clientId ||
      (fallbackExtras as any).clientSecret ||
      (fallbackExtras as any).cookieFile ||
      ((fallbackExtras as any).scopes &&
        Array.isArray((fallbackExtras as any).scopes) &&
        (fallbackExtras as any).scopes.length)
    );
    if (fallbackHasData) {
      pushEntry(undefined, buildAuthCandidate(baseTypeSource, fallbackExtras));
    }
  }

  if (!entries.length && baseType === 'apiKey') {
    const authDeclared =
      Object.prototype.hasOwnProperty.call(provider, 'auth') ||
      Object.prototype.hasOwnProperty.call(provider, 'apiKey') ||
      Object.prototype.hasOwnProperty.call(provider, 'apiKeys') ||
      Object.prototype.hasOwnProperty.call(provider, 'authType');
    if (authDeclared) {
      pushEntry(undefined, buildAuthCandidate(baseTypeSource, { value: '' }));
    }
  }
  if (!entries.length) {
    throw new VirtualRouterError(
      `Provider ${providerId} is missing auth configuration`,
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }

  return entries;
}

function collectAuthDefaults(auth: Record<string, unknown>): AuthFieldDefaults {
  return {
    secretRef: readOptionalString(auth.secretRef as string | undefined) ?? readOptionalString((auth as any).file),
    tokenFile: readOptionalString(auth.tokenFile as string | undefined) ?? readOptionalString((auth as any).file),
    tokenUrl: readOptionalString((auth.tokenUrl as string | undefined) ?? (auth as any).token_url),
    deviceCodeUrl: readOptionalString(
      (auth.deviceCodeUrl as string | undefined) ?? (auth as any).device_code_url
    ),
    clientId: readOptionalString((auth.clientId as string | undefined) ?? (auth as any).client_id),
    clientSecret: readOptionalString((auth.clientSecret as string | undefined) ?? (auth as any).client_secret),
    authorizationUrl: readOptionalString(
      (auth as any).authorizationUrl ?? (auth as any).authorization_url ?? (auth as any).authUrl
    ),
    userInfoUrl: readOptionalString((auth as any).userInfoUrl ?? (auth as any).user_info_url),
    refreshUrl: readOptionalString((auth as any).refreshUrl ?? (auth as any).refresh_url),
    scopes: normalizeScopeList((auth as any).scopes ?? (auth as any).scope)
  };
}

function normalizeScopeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized: string[] = [];
    for (const item of value) {
      const str = readOptionalString(item);
      if (str) {
        pushUnique(normalized, str);
      }
    }
    return normalized.length ? normalized : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return normalized.length ? normalized : undefined;
  }
  return undefined;
}

function mergeScopes(primary?: string[], fallback?: string[]): string[] | undefined {
  if ((!primary || !primary.length) && (!fallback || !fallback.length)) {
    return undefined;
  }
  const merged = new Set<string>();
  for (const scope of primary ?? []) {
    if (scope.trim()) merged.add(scope.trim());
  }
  for (const scope of fallback ?? []) {
    if (scope.trim()) merged.add(scope.trim());
  }
  return merged.size ? Array.from(merged) : undefined;
}

function interpretAuthType(value: unknown): AuthTypeInfo {
  if (typeof value !== 'string') {
    return { type: 'apiKey' };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { type: 'apiKey' };
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'apikey' || lower === 'api-key') {
    return { type: 'apiKey', raw: trimmed };
  }
  if (lower === 'oauth') {
    return { type: 'oauth', raw: trimmed };
  }
  const match = lower.match(/^([a-z0-9._-]+)-oauth$/);
  if (match) {
    return { type: 'oauth', oauthProviderId: match[1], raw: trimmed };
  }
  if (lower.includes('oauth')) {
    return { type: 'oauth', raw: trimmed };
  }
  return { type: 'apiKey', raw: trimmed };
}
