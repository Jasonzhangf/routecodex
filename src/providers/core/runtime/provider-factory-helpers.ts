import { GeminiHttpProvider } from './gemini-http-provider.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import { ResponsesProvider } from './responses-provider.js';
import { AnthropicProtocolClient } from '../../../client/anthropic/anthropic-protocol-client.js';
import { MockProvider } from '../../mock/index.js';
import { MimowebProvider } from './mimoweb/mimoweb-provider.js';
import type { OpenAIStandardConfig, ApiKeyAuth } from '../api/provider-config.js';
import type { IProviderV2, ProviderRuntimeAuth, ProviderRuntimeProfile, ProviderType } from '../api/provider-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

type ApiKeyAuthExtended = ApiKeyAuth & { secretRef?: string; rawType?: string; accountAlias?: string };

export type RuntimeFactoryAuthConfig = ApiKeyAuthExtended;

function isOpenCodeZenProviderId(providerId?: string): boolean {
  const normalized = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  return (
    normalized === 'opencode-zen'
    || normalized === 'opencode-zen-free'
    || normalized.startsWith('opencode-zen-')
  );
}

function isGrokAuthRuntime(
  auth: ProviderRuntimeAuth,
  runtime?: ProviderRuntimeProfile
): boolean {
  const rawType = isNonEmptyString(auth.rawType) ? auth.rawType.trim().toLowerCase() : '';
  if (rawType === 'grok' || rawType === 'grok-cli' || rawType === 'grok-cli-session' || rawType === 'supergrok') {
    return true;
  }
  const providerId = typeof runtime?.providerId === 'string' ? runtime.providerId.trim().toLowerCase() : '';
  if (
    providerId === 'grok'
    || providerId === 'grok-cli'
    || providerId === 'supergrok'
    || providerId.startsWith('grok-')
  ) {
    return true;
  }
  const tokenFile = isNonEmptyString(auth.tokenFile) ? auth.tokenFile.trim().toLowerCase() : '';
  return (
    tokenFile.includes('/provider/grok/')
    || tokenFile.includes('provider/grok/auth')
    || tokenFile.includes('.grok/auth.json')
    || tokenFile.endsWith('grok/auth.json')
  );
}

function isOpenCodeZenPlaceholderApiKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'free-access-token' || normalized === 'placeholder';
}

function resolveOpenCodeZenApiKey(rawValue: unknown): { apiKey: string; rawType?: string } {
  const value = isNonEmptyString(rawValue) ? rawValue.trim() : '';
  const normalized = value.toLowerCase();
  if (!value || normalized === 'public' || isOpenCodeZenPlaceholderApiKey(value)) {
    // Match OpenCode CLI no-key path: use public key for Zen free routes.
    return { apiKey: 'public', rawType: 'opencode-zen-public' };
  }
  return { apiKey: value };
}

export function mapRuntimeResponsesConfig(
  source: unknown,
  streamingPref?: 'auto' | 'always' | 'never'
): Record<string, unknown> | undefined {
  if (!source && !streamingPref) {
    return undefined;
  }
  const node = (source && typeof source === 'object' ? (source as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const responses: Record<string, unknown> = {};
  if (typeof node.toolCallIdStyle === 'string') {
    responses.toolCallIdStyle = node.toolCallIdStyle;
  }
  const streamingValue =
    node.streaming !== undefined && node.streaming !== null ? node.streaming : streamingPref;
  if (typeof streamingValue === 'string') {
    responses.streaming = streamingValue;
  } else if (streamingValue === true) {
    responses.streaming = 'always';
  } else if (streamingValue === false) {
    responses.streaming = 'never';
  }
  if (typeof node.instructionsMode === 'string') {
    responses.instructionsMode = node.instructionsMode;
  }
  return Object.keys(responses).length ? responses : undefined;
}

function isLocalBaseUrl(value?: string): boolean {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return false;
  }
  try {
    const url = new URL(raw);
    const host = String(url.hostname || '').trim().toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '::ffff:127.0.0.1'
    );
  } catch {
    const lower = raw.toLowerCase();
    return (
      lower.includes('localhost') ||
      lower.includes('127.0.0.1') ||
      lower.includes('0.0.0.0') ||
      lower.includes('[::1]')
    );
  }
}

export function mapRuntimeAuthToConfig(
  auth: ProviderRuntimeAuth,
  runtimeKey: string,
  runtime?: ProviderRuntimeProfile
): RuntimeFactoryAuthConfig {
  if (auth.type === 'apikey') {
    const isOpenCodeZen = isOpenCodeZenProviderId(runtime?.providerId);
    const isGrok = isGrokAuthRuntime(auth, runtime);
    const rawType = isNonEmptyString(auth.rawType) ? auth.rawType.trim().toLowerCase() : undefined;
    const openCodeZenResolved = isOpenCodeZen ? resolveOpenCodeZenApiKey(auth.value) : null;
    const resolvedApiKey = openCodeZenResolved
        ? openCodeZenResolved.apiKey
        : (isNonEmptyString(auth.value) ? auth.value.trim() : '');

    if (!resolvedApiKey) {
      const baseUrl =
        runtime && typeof (runtime as any).baseUrl === 'string'
          ? String((runtime as any).baseUrl).trim()
          : runtime && typeof (runtime as any).endpoint === 'string'
            ? String((runtime as any).endpoint).trim()
            : '';
      // Independent grok provider loads tokens from ~/.rcc/provider/grok/auth (tokenFile).
      // Inert placeholder values are allowed; real credentials never come from inline apiKey.
      const allowEmpty = isLocalBaseUrl(baseUrl) || isGrok;
      if (!allowEmpty) {
        throw new Error(`[ProviderFactory] runtime ${runtimeKey} missing inline apiKey value`);
      }
    }
    const apiKeyAuth: ApiKeyAuthExtended = {
      type: 'apikey',
      // Grok credentials live only in token files; keep an inert non-secret placeholder for generic apikey plumbing.
      apiKey: isGrok ? 'grok-token-file-mode' : resolvedApiKey,
      rawType: openCodeZenResolved?.rawType ?? (isGrok ? (rawType || 'grok') : (rawType || auth.rawType)),
      accountAlias: auth.accountAlias,
      tokenFile: auth.tokenFile || (isGrok ? '~/.rcc/provider/grok/auth/token-1.json' : undefined),
      mobile: auth.mobile,
      account: (auth as ApiKeyAuthExtended & { account?: string }).account,
      username: (auth as ApiKeyAuthExtended & { username?: string }).username,
      password: auth.password,
      accountFile: auth.accountFile,
    };
    return apiKeyAuth;
  }

  throw new Error(`[ProviderFactory] runtime ${runtimeKey} uses unsupported auth type '${auth.type}'`);
}

export function resolveProviderModule(value?: string): OpenAIStandardConfig['type'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  switch (trimmed) {
    case 'openai-standard':
    case 'openai-http-provider':
    case 'responses-http-provider':
    case 'anthropic-http-provider':
    case 'gemini-http-provider':
    case 'mimoweb-provider':
    case 'mock-provider':
     return trimmed as OpenAIStandardConfig['type'];
    case 'anthropic':
      return 'anthropic-http-provider';
    case 'openai':
      return 'openai-http-provider';
    case 'responses':
      return 'responses-http-provider';
    case 'gemini':
      return 'gemini-http-provider';
    case 'mimoweb':
      return 'mimoweb-provider';
    default:
      return undefined;
  }
}

export function mapProviderModule(providerType: ProviderType): OpenAIStandardConfig['type'] {
  if (providerType === 'responses') {
    return 'responses-http-provider';
  }
  if (providerType === 'anthropic') {
    return 'anthropic-http-provider';
  }
  if (providerType === 'gemini') {
    return 'gemini-http-provider';
  }
  if (providerType === 'mock') {
    return 'mock-provider';
  }
  if (providerType === 'mimoweb') {
    return 'mimoweb-provider';
  }
  return 'openai-http-provider';
}

export function instantiateProvider(
  providerType: ProviderType,
  moduleType: string,
  config: OpenAIStandardConfig,
  dependencies: ModuleDependencies
): IProviderV2 {
  if (moduleType === 'mimoweb-provider') {
    return new MimowebProvider(config, dependencies);
  }
  if (moduleType === 'mock-provider') {
    return new MockProvider(config, dependencies);
  }
  if (moduleType === 'gemini-http-provider') {
    return new GeminiHttpProvider(config, dependencies);
  }
  switch (providerType) {
    case 'openai':
      return new HttpTransportProvider(config, dependencies, 'openai-standard');
    case 'responses':
      return new ResponsesProvider(
        { ...config, config: { ...config.config, providerType: 'responses' } },
        dependencies
      );
    case 'anthropic':
      return new HttpTransportProvider(
        { ...config, config: { ...config.config, providerType: 'anthropic' } },
        dependencies,
        'anthropic-http-provider',
        new AnthropicProtocolClient()
      );
    case 'gemini': {
      return new GeminiHttpProvider(config, dependencies);
    }
    default:
      break;
  }

  if (moduleType === 'openai-http-provider' || moduleType === 'openai-standard') {
    return new HttpTransportProvider(
      { ...config, config: { ...config.config, providerType: 'openai' } },
      dependencies,
      'openai-http-provider'
    );
  }
  if (moduleType === 'responses-http-provider') {
    return new ResponsesProvider(
      { ...config, config: { ...config.config, providerType: 'responses' } },
      dependencies
    );
  }
  if (moduleType === 'anthropic-http-provider') {
    return new HttpTransportProvider(
      { ...config, config: { ...config.config, providerType: 'anthropic' } },
      dependencies,
      'anthropic-http-provider',
      new AnthropicProtocolClient()
    );
  }
  if (providerType === 'mimoweb') {
    return new MimowebProvider(config, dependencies);
  }
  const error = new Error(`[ProviderFactory] Unsupported providerType='${providerType}' and moduleType='${moduleType}'`);
  (error as Error & { code?: string }).code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
  throw error;
}

export function getAuthSignature(auth: ApiKeyAuth): string {
  const apiKeyAuth = auth as ApiKeyAuthExtended;
  if (isNonEmptyString(apiKeyAuth.secretRef)) {
    return apiKeyAuth.secretRef.trim();
  }
  return apiKeyAuth.apiKey.trim();
}
