import { OpenAIHttpProvider } from './openai-http-provider.js';
import { ResponsesHttpProvider } from './responses-http-provider.js';
import { AnthropicHttpProvider } from './anthropic-http-provider.js';
import { iFlowHttpProvider } from './iflow-http-provider.js';
import { DeepSeekHttpProvider } from './deepseek-http-provider.js';
import { ChatHttpProvider } from './chat-http-provider.js';
import { GeminiHttpProvider } from './gemini-http-provider.js';
import { MockProvider } from '../../mock/index.js';
import { GeminiCLIHttpProvider } from './gemini-cli-http-provider.js';
import type { OpenAIStandardConfig, ApiKeyAuth, OAuthAuth, OAuthAuthType } from '../api/provider-config.js';
import type { IProviderV2, ProviderRuntimeAuth, ProviderRuntimeProfile, ProviderType } from '../api/provider-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

type ApiKeyAuthExtended = ApiKeyAuth & { secretRef?: string; rawType?: string; accountAlias?: string };
type OAuthAuthExtended = OAuthAuth & { oauthProviderId?: string };

export type RuntimeFactoryAuthConfig = ApiKeyAuthExtended | OAuthAuthExtended;

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
    const rawType = isNonEmptyString(auth.rawType) ? auth.rawType.trim().toLowerCase() : undefined;
    if (rawType !== 'deepseek-account' && !isNonEmptyString(auth.value)) {
      const baseUrl =
        runtime && typeof (runtime as any).baseUrl === 'string'
          ? String((runtime as any).baseUrl).trim()
          : runtime && typeof (runtime as any).endpoint === 'string'
            ? String((runtime as any).endpoint).trim()
            : '';
      const allowEmpty = isLocalBaseUrl(baseUrl) || rawType === 'deepseek-account';
      if (!allowEmpty) {
        throw new Error(`[ProviderFactory] runtime ${runtimeKey} missing inline apiKey value`);
      }
    }
    const apiKeyAuth: ApiKeyAuthExtended = {
      type: 'apikey',
      apiKey: rawType === 'deepseek-account' ? '' : (isNonEmptyString(auth.value) ? auth.value.trim() : ''),
      rawType: rawType || auth.rawType,
      accountAlias: auth.accountAlias,
      tokenFile: auth.tokenFile
    };
    return apiKeyAuth;
  }

  const oauthType: OAuthAuthType = isNonEmptyString(auth.rawType)
    ? (auth.rawType.trim() as OAuthAuthType)
    : 'oauth';

  const oauthAuth: OAuthAuthExtended = {
    type: oauthType,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    scopes: auth.scopes,
    tokenFile: auth.tokenFile,
    tokenUrl: auth.tokenUrl,
    deviceCodeUrl: auth.deviceCodeUrl,
    authorizationUrl: auth.authorizationUrl,
    userInfoUrl: auth.userInfoUrl,
    refreshUrl: auth.refreshUrl
  };

  if (auth.oauthProviderId) {
    oauthAuth.oauthProviderId = auth.oauthProviderId;
  }

  return oauthAuth;
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
    case 'gemini-cli-http-provider':
    case 'iflow-http-provider':
    case 'deepseek-http-provider':
    case 'mock-provider':
      return trimmed as OpenAIStandardConfig['type'];
    case 'deepseek':
      return 'deepseek-http-provider';
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
  return 'openai-http-provider';
}

export function instantiateProvider(
  providerType: ProviderType,
  moduleType: string,
  config: OpenAIStandardConfig,
  dependencies: ModuleDependencies
): IProviderV2 {
  if (moduleType === 'mock-provider') {
    return new MockProvider(config, dependencies);
  }
  if (moduleType === 'gemini-cli-http-provider') {
    return new GeminiCLIHttpProvider(config, dependencies);
  }
  if (moduleType === 'gemini-http-provider') {
    return new GeminiHttpProvider(config, dependencies);
  }
  if (moduleType === 'deepseek-http-provider') {
    return new DeepSeekHttpProvider(config, dependencies);
  }

  switch (providerType) {
    case 'openai':
      return new ChatHttpProvider(config, dependencies);
    case 'responses':
      return new ResponsesHttpProvider(config, dependencies);
    case 'anthropic':
      return new AnthropicHttpProvider(config, dependencies);
    case 'gemini': {
      const oauthType = config?.config?.auth?.type;
      if (oauthType === 'gemini-cli-oauth') {
        return new GeminiCLIHttpProvider(config, dependencies);
      }
      return new GeminiHttpProvider(config, dependencies);
    }
    default:
      break;
  }

  if (moduleType === 'openai-http-provider' || moduleType === 'openai-standard') {
    return new OpenAIHttpProvider(config, dependencies);
  }
  if (moduleType === 'responses-http-provider') {
    return new ResponsesHttpProvider(config, dependencies);
  }
  if (moduleType === 'anthropic-http-provider') {
    return new AnthropicHttpProvider(config, dependencies);
  }
  if (moduleType === 'iflow-http-provider') {
    return new iFlowHttpProvider(config, dependencies);
  }
  const error = new Error(`[ProviderFactory] Unsupported providerType='${providerType}' and moduleType='${moduleType}'`);
  (error as Error & { code?: string }).code = 'ERR_UNSUPPORTED_PROVIDER_TYPE';
  throw error;
}

export function getAuthSignature(auth: ApiKeyAuth | OAuthAuth): string {
  if (auth.type === 'apikey') {
    const apiKeyAuth = auth as ApiKeyAuthExtended;
    if (isNonEmptyString(apiKeyAuth.secretRef)) {
      return apiKeyAuth.secretRef.trim();
    }
    return apiKeyAuth.apiKey.trim();
  }

  const tokenFile = isNonEmptyString(auth.tokenFile) ? auth.tokenFile.trim() : '';
  if (tokenFile) {
    return tokenFile;
  }
  if (isNonEmptyString(auth.clientId)) {
    return auth.clientId.trim();
  }
  if (isNonEmptyString(auth.authorizationUrl)) {
    return auth.authorizationUrl.trim();
  }
  return auth.type;
}
