export function extractDefaultModels(provider: Record<string, unknown>): string[] | undefined {
  const modelsNode = provider.models as unknown;
  if (!modelsNode || typeof modelsNode !== 'object' || Array.isArray(modelsNode)) {
    return undefined;
  }
  const keys = Object.keys(modelsNode as Record<string, unknown>);
  return keys.length ? keys : undefined;
}

export function extractCredentialsRef(provider: Record<string, unknown>): string | undefined {
  const auth = provider.auth as unknown;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const entries = (auth as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  const first = entries[0] as { tokenFile?: unknown };
  if (typeof first.tokenFile === 'string' && first.tokenFile.trim()) {
    return first.tokenFile.trim();
  }
  return undefined;
}

export function scrubProviderConfig(provider: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...provider };
  const auth = clone.auth as unknown;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const safeAuth: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
    // 删除潜在的敏感字段（目前 v2 配置中一般不存在这些字段，此处为防御性实现）。
    delete safeAuth.apiKey;
    delete safeAuth.api_key;
    delete safeAuth.clientSecret;
    delete safeAuth.secret;
    clone.auth = safeAuth;
  }
  return clone;
}

function isSafeSecretReference(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('authfile-')) {
    return true;
  }
  if (/^\$\{[A-Z0-9_]+\}$/i.test(trimmed)) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return true;
  }
  return false;
}

export function extractProvidersV1(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  const root = config as Record<string, unknown>;
  const vrNode = root.virtualrouter;
  if (!vrNode || typeof vrNode !== 'object' || Array.isArray(vrNode)) {
    return {};
  }
  const providersNode = (vrNode as Record<string, unknown>).providers;
  if (providersNode && typeof providersNode === 'object' && !Array.isArray(providersNode)) {
    return providersNode as Record<string, unknown>;
  }
  return {};
}

export function applyProviderUpsertV1(config: unknown, id: string, provider: Record<string, unknown>): Record<string, unknown> {
  const root = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : {};
  const vrNode = root.virtualrouter;
  const vr = (vrNode && typeof vrNode === 'object' && !Array.isArray(vrNode))
    ? (vrNode as Record<string, unknown>)
    : {};
  const providersNode = vr.providers;
  const providers = (providersNode && typeof providersNode === 'object' && !Array.isArray(providersNode))
    ? (providersNode as Record<string, unknown>)
    : {};
  return {
    ...root,
    virtualrouter: {
      ...vr,
      providers: {
        ...providers,
        [id]: { ...provider, id }
      }
    }
  };
}

export function applyProviderDeleteV1(config: unknown, id: string): Record<string, unknown> {
  const root = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>)
    : {};
  const vrNode = root.virtualrouter;
  const vr = (vrNode && typeof vrNode === 'object' && !Array.isArray(vrNode))
    ? (vrNode as Record<string, unknown>)
    : {};
  const providersNode = vr.providers;
  const providers = (providersNode && typeof providersNode === 'object' && !Array.isArray(providersNode))
    ? ({ ...(providersNode as Record<string, unknown>) })
    : {};
  delete providers[id];
  return {
    ...root,
    virtualrouter: {
      ...vr,
      providers
    }
  };
}

export function summarizeProviderV1(provider: unknown): Record<string, unknown> {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return { type: null, enabled: null, baseURL: null, modelCount: 0, modelsPreview: [], authType: null };
  }
  const rec = provider as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type : null;
  const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : null;
  const baseURL = typeof rec.baseURL === 'string' ? rec.baseURL : null;
  const compatibilityProfile = typeof rec.compatibilityProfile === 'string' ? rec.compatibilityProfile : null;
  const models = rec.models;
  const modelsPreview =
    models && typeof models === 'object' && !Array.isArray(models)
      ? Object.keys(models as Record<string, unknown>).sort((a, b) => a.localeCompare(b)).slice(0, 6)
      : [];
  const modelCount =
    models && typeof models === 'object' && !Array.isArray(models)
      ? Object.keys(models as Record<string, unknown>).length
      : 0;
  const auth = rec.auth;
  const authType =
    auth && typeof auth === 'object' && !Array.isArray(auth) && typeof (auth as Record<string, unknown>).type === 'string'
      ? ((auth as Record<string, unknown>).type as string)
      : null;
  return { type, enabled, baseURL, compatibilityProfile, modelCount, modelsPreview, authType };
}

export function scrubProviderConfigV1(provider: unknown): Record<string, unknown> {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return {};
  }
  const clone: Record<string, unknown> = { ...(provider as Record<string, unknown>) };
  const auth = clone.auth as unknown;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const authClone: Record<string, unknown> = { ...(auth as Record<string, unknown>) };
    const fields = ['apiKey', 'api_key', 'value', 'clientSecret', 'client_secret', 'secret', 'cookie'];
    for (const field of fields) {
      const raw = authClone[field];
      if (raw === undefined) {
        continue;
      }
      if (typeof raw === 'string' && isSafeSecretReference(raw)) {
        continue;
      }
      delete authClone[field];
    }
    clone.auth = authClone;
  }
  return clone;
}

export function validateAndNormalizeProviderConfigV1(
  providerId: string,
  provider: Record<string, unknown>
): { ok: true; provider: Record<string, unknown> } | { ok: false; message: string } {
  const idNode = typeof provider.id === 'string' ? provider.id.trim() : '';
  if (idNode && idNode !== providerId) {
    return { ok: false, message: `provider.id must match id (${providerId})` };
  }

  const auth = provider.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { ok: false, message: 'provider.auth must be an object' };
  }
  const authRec = auth as Record<string, unknown>;
  const secretFields = ['apiKey', 'api_key', 'value', 'clientSecret', 'client_secret', 'secret', 'cookie'];
  for (const field of secretFields) {
    const value = authRec[field];
    if (typeof value === 'string' && value.trim()) {
      if (!isSafeSecretReference(value)) {
        return {
          ok: false,
          message: `provider.auth must not include inline secret field "${field}". Use authfile-* or an env var reference (e.g. \${MY_KEY}).`
        };
      }
    }
  }

  return { ok: true, provider: { ...provider, id: providerId } };
}

export function validateAndNormalizeProviderConfig(
  providerId: string,
  provider: Record<string, unknown>
): { ok: true; provider: Record<string, unknown> } | { ok: false; message: string } {
  const idNode = typeof provider.id === 'string' ? provider.id.trim() : '';
  if (idNode && idNode !== providerId) {
    return { ok: false, message: `provider.id must match providerId (${providerId})` };
  }
  const auth = provider.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { ok: false, message: 'provider.auth must be an object' };
  }
  const authRec = auth as Record<string, unknown>;
  const secretFields = ['apiKey', 'api_key', 'value', 'clientSecret', 'client_secret', 'secret'];
  for (const field of secretFields) {
    const authFieldValue = authRec[field];
    if (typeof authFieldValue === 'string' && authFieldValue.trim()) {
      return {
        ok: false,
        message: `provider.auth must not include inline secret field "${field}". Use secretRef (authfile-...) or tokenFile.`
      };
    }
  }

  const normalized: Record<string, unknown> = { ...provider };
  if (!idNode) {
    normalized.id = providerId;
  }
  return { ok: true, provider: normalized };
}
