import { HttpClient } from '../utils/http-client.js';
import { ServiceProfileValidator } from '../config/service-profiles.js';
import type { IAuthProvider } from '../../auth/auth-interface.js';
import type { OAuthAuth, OpenAIStandardConfig } from '../api/provider-config.js';
import type { ServiceProfile } from '../api/provider-types.js';
import { DEFAULT_PROVIDER } from '../../../constants/index.js';
import { AuthModeUtils, AuthProviderFactory } from './transport/index.js';

type OAuthAuthExtended = OAuthAuth & { rawType?: string; oauthProviderId?: string; tokenFile?: string };

export function createTransportAuthProvider(options: {
  config: OpenAIStandardConfig;
  providerType: string;
  moduleType: string;
  serviceProfile: ServiceProfile;
  extensions?: Record<string, unknown>;
}): {
  authProvider: IAuthProvider;
  authMode: 'apikey' | 'oauth';
  oauthProviderId?: string;
} {
  const { config, providerType, moduleType, serviceProfile, extensions } = options;
  const auth = config.config.auth;
  const authMode = AuthModeUtils.normalizeAuthMode(auth.type);
  const resolvedOAuthProviderId =
    authMode === 'oauth'
      ? AuthModeUtils.ensureOAuthProviderId(auth as unknown as OAuthAuthExtended, extensions)
      : undefined;

  const serviceProfileKey =
    moduleType === 'gemini-cli-http-provider'
      ? 'gemini-cli'
      : (resolvedOAuthProviderId ?? providerType);

  const validation = ServiceProfileValidator.validateServiceProfile(
    serviceProfileKey,
    authMode
  );
  if (!validation.isValid) {
    throw new Error(
      `Invalid auth configuration for ${serviceProfileKey}: ${validation.errors.join(', ')}`
    );
  }

  const authFactory = new AuthProviderFactory({
    providerType,
    moduleType,
    config,
    serviceProfile
  });
  const authProvider = authFactory.createAuthProvider();

  return {
    authProvider,
    authMode,
    oauthProviderId: authMode === 'oauth'
      ? (resolvedOAuthProviderId ?? serviceProfileKey)
      : undefined
  };
}

export function createTransportHttpClient(options: {
  config: OpenAIStandardConfig;
  serviceProfile: ServiceProfile;
  effectiveBaseUrl: string;
}): HttpClient {
  const { config, serviceProfile, effectiveBaseUrl } = options;
  const envTimeout = Number(process.env.ROUTECODEX_PROVIDER_TIMEOUT_MS || process.env.RCC_PROVIDER_TIMEOUT_MS || NaN);
  const effectiveTimeout = Number.isFinite(envTimeout) && envTimeout > 0
    ? envTimeout
    : (config.config.overrides?.timeout ?? serviceProfile.timeout ?? DEFAULT_PROVIDER.TIMEOUT_MS);

  const envRetries = Number(process.env.ROUTECODEX_PROVIDER_RETRIES || process.env.RCC_PROVIDER_RETRIES || NaN);
  const effectiveRetries = Number.isFinite(envRetries) && envRetries >= 0
    ? envRetries
    : (config.config.overrides?.maxRetries ?? serviceProfile.maxRetries ?? DEFAULT_PROVIDER.MAX_RETRIES);

  const overrideHeaders =
    config.config.overrides?.headers ||
    (config.config as { headers?: Record<string, string> }).headers ||
    undefined;

  const envStreamIdleTimeoutMs = Number(
    process.env.ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS ||
      process.env.RCC_PROVIDER_STREAM_IDLE_TIMEOUT_MS ||
      NaN
  );
  const normalizedStreamIdleTimeoutMs = Number.isFinite(envStreamIdleTimeoutMs) && envStreamIdleTimeoutMs > 0
    ? envStreamIdleTimeoutMs
    : (
        typeof config.config.overrides?.streamIdleTimeoutMs === 'number' &&
        Number.isFinite(config.config.overrides.streamIdleTimeoutMs)
          ? config.config.overrides.streamIdleTimeoutMs
          : undefined
      );

  const envStreamHeadersTimeoutMs = Number(
    process.env.ROUTECODEX_PROVIDER_STREAM_HEADERS_TIMEOUT_MS ||
      process.env.RCC_PROVIDER_STREAM_HEADERS_TIMEOUT_MS ||
      NaN
  );
  const normalizedStreamHeadersTimeoutMs = Number.isFinite(envStreamHeadersTimeoutMs) && envStreamHeadersTimeoutMs > 0
    ? envStreamHeadersTimeoutMs
    : (
        typeof config.config.overrides?.streamHeadersTimeoutMs === 'number' &&
        Number.isFinite(config.config.overrides.streamHeadersTimeoutMs)
          ? config.config.overrides.streamHeadersTimeoutMs
          : undefined
      );

  return new HttpClient({
    baseUrl: effectiveBaseUrl,
    timeout: effectiveTimeout,
    maxRetries: effectiveRetries,
    streamIdleTimeoutMs: normalizedStreamIdleTimeoutMs ?? serviceProfile.streamIdleTimeoutMs,
    streamHeadersTimeoutMs: normalizedStreamHeadersTimeoutMs ?? serviceProfile.streamHeadersTimeoutMs,
    defaultHeaders: {
      'Content-Type': 'application/json',
      ...(serviceProfile.headers || {}),
      ...(overrideHeaders || {})
    }
  });
}
