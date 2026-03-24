import { getBootstrapProviderTemplates, isManagedBootstrapTemplate } from '../cli/config/bootstrap-provider-templates.js';
import type { InitProviderTemplate } from '../cli/config/init-provider-catalog.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeModelsNode(node: unknown): Record<string, UnknownRecord> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return {};
  }
  return node as Record<string, UnknownRecord>;
}

export type ProviderTemplateId =
  | 'openai'
  | 'responses'
  | 'anthropic'
  | 'gemini'
  | 'qwen'
  | 'iflow'
  | 'gemini-cli'
  | 'antigravity'
  | 'deepseek-web'
  | 'custom';

export interface ProviderTemplate {
  id: ProviderTemplateId | string;
  label: string;
  providerTypeHint: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
  seedModels?: string[];
  defaultCompat?: string;
  defaultAuthType?: string;
  source: 'bootstrap-generic' | 'bootstrap-managed' | 'builtin';
  providerTemplate?: UnknownRecord;
}

export type BuildProviderFromTemplateOptions = {
  additionalModelIds?: string[];
  defaultModelId?: string;
};

const CUSTOM_PROVIDER_TEMPLATE: ProviderTemplate = {
  id: 'custom',
  label: 'Custom provider (manual configuration)',
  providerTypeHint: 'openai',
  source: 'builtin'
};

function catalogEntryToProviderTemplate(entry: InitProviderTemplate): ProviderTemplate {
  const provider = entry.provider as UnknownRecord;
  const models = normalizeModelsNode((provider as { models?: unknown }).models);
  const modelIds = Object.keys(models);
  return {
    id: entry.id,
    label: entry.label,
    providerTypeHint: readString((provider as { type?: unknown }).type) ?? entry.id,
    defaultBaseUrl: readString((provider as { baseURL?: unknown }).baseURL) ?? readString((provider as { baseUrl?: unknown }).baseUrl),
    defaultModel: entry.defaultModel,
    seedModels: modelIds.filter((modelId) => modelId !== entry.defaultModel),
    defaultCompat: readString((provider as { compatibilityProfile?: unknown }).compatibilityProfile),
    defaultAuthType: readString((provider as { auth?: unknown }).auth && (provider as { auth: UnknownRecord }).auth.type) ?? 'apikey',
    source: isManagedBootstrapTemplate(entry.id) ? 'bootstrap-managed' : 'bootstrap-generic',
    providerTemplate: JSON.parse(JSON.stringify(provider))
  };
}

export function getProviderTemplates(): ProviderTemplate[] {
  return [...getBootstrapProviderTemplates().map(catalogEntryToProviderTemplate), CUSTOM_PROVIDER_TEMPLATE];
}

export function pickProviderTemplate(id?: string): ProviderTemplate {
  const normalized = (id || '').trim().toLowerCase();
  const templates = getProviderTemplates();
  if (!normalized) {
    return templates[0];
  }
  const found = templates.find((t) => t.id === normalized);
  return found ?? templates[templates.length - 1];
}

export function buildProviderFromTemplate(
  providerId: string,
  tpl: ProviderTemplate,
  baseUrl: string,
  authType: string,
  apiKeyOrPlaceholder: string,
  tokenFile: string,
  primaryModelId: string,
  options?: BuildProviderFromTemplateOptions
): UnknownRecord {
  const provider: UnknownRecord = tpl.providerTemplate
    ? JSON.parse(JSON.stringify(tpl.providerTemplate))
    : {
        enabled: true,
        type: tpl.providerTypeHint
      };
  provider.id = providerId;
  provider.enabled = true;
  provider.type = tpl.providerTypeHint;
  provider.baseURL = baseUrl;

  const baseAuth = isRecord(provider.auth) ? { ...provider.auth } : {};
  const nextAuthType = authType.trim() || tpl.defaultAuthType || String(baseAuth.type || 'apikey');
  const auth: UnknownRecord = {
    ...baseAuth,
    type: nextAuthType
  };
  if (nextAuthType.toLowerCase().includes('apikey')) {
    auth.apiKey = apiKeyOrPlaceholder.trim() || readString(baseAuth.apiKey) || 'YOUR_API_KEY_HERE';
  } else if (nextAuthType.toLowerCase().includes('oauth') || nextAuthType.toLowerCase().includes('cookie') || nextAuthType.toLowerCase().includes('account')) {
    const resolvedTokenFile = tokenFile.trim() || readString(baseAuth.tokenFile) || readString(baseAuth.cookieFile);
    if (resolvedTokenFile) {
      if (nextAuthType.toLowerCase().includes('cookie')) {
        auth.cookieFile = resolvedTokenFile;
      } else if (nextAuthType.toLowerCase().includes('account') && Array.isArray(baseAuth.entries) && baseAuth.entries.length > 0) {
        const [first, ...rest] = baseAuth.entries as UnknownRecord[];
        auth.entries = [{ ...first, tokenFile: resolvedTokenFile }, ...rest];
      } else {
        auth.tokenFile = resolvedTokenFile;
      }
    }
  }
  provider.auth = auth;

  const models = normalizeModelsNode(provider.models);
  const seedModels = Array.isArray(tpl.seedModels) ? tpl.seedModels : [];
  const additionalModelIds = Array.isArray(options?.additionalModelIds) ? options!.additionalModelIds : [];
  const modelInsertOrder = [primaryModelId, ...additionalModelIds]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  const defaultModelIdCandidate = readString(options?.defaultModelId);
  const defaultModelId = defaultModelIdCandidate || modelInsertOrder[0] || tpl.defaultModel;

  for (const modelId of seedModels) {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
      continue;
    }
    models[normalizedModelId] = isRecord(models[normalizedModelId]) ? models[normalizedModelId] : { supportsStreaming: true };
  }
  for (const key of modelInsertOrder) {
    models[key] = isRecord(models[key]) ? models[key] : { supportsStreaming: true };
  }
  if (defaultModelId) {
    const key = defaultModelId.trim();
    if (key) {
      models[key] = isRecord(models[key]) ? models[key] : { supportsStreaming: true };
      provider.defaultModel = key;
    }
  }
  provider.models = models;

  if (tpl.defaultCompat && !readString((provider as { compatibilityProfile?: unknown }).compatibilityProfile)) {
    (provider as { compatibilityProfile?: string }).compatibilityProfile = tpl.defaultCompat;
  }

  if (tpl.id === 'responses' && !isRecord((provider as UnknownRecord).responses)) {
    (provider as UnknownRecord).responses = {
      process: 'chat',
      streaming: 'always'
    };
  }

  return provider;
}
