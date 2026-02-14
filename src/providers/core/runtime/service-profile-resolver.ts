import { DynamicProfileLoader } from '../config/service-profiles.js';
import type { ServiceProfile } from '../api/provider-types.js';
import { DEFAULT_PROVIDER } from '../../../constants/index.js';

export interface ServiceProfileResolverInput {
  cfg: {
    baseUrl?: string;
    endpoint?: string;
    defaultModel?: string;
    timeout?: number;
    maxRetries?: number;
    headers?: Record<string, string>;
    authCapabilities?: {
      required?: string[];
      optional?: string[];
    };
    overrides?: {
      baseUrl?: string;
      endpoint?: string;
      defaultModel?: string;
      timeout?: number;
      maxRetries?: number;
      headers?: Record<string, string>;
    };
    protocol?: string;
  };
  profileKey: string;
  providerType: string;
}

export class ServiceProfileResolver {
  static resolve(input: ServiceProfileResolverInput): ServiceProfile {
    const { cfg, profileKey, providerType } = input;
    const useConfigCoreEnv = String(
      process.env.ROUTECODEX_USE_CONFIG_CORE_PROVIDER_DEFAULTS ||
      process.env.RCC_USE_CONFIG_CORE_PROVIDER_DEFAULTS ||
      ''
    ).trim().toLowerCase();
    const forceConfigCoreDefaults =
      useConfigCoreEnv === '1' ||
      useConfigCoreEnv === 'true' ||
      useConfigCoreEnv === 'yes' ||
      useConfigCoreEnv === 'on';

    const baseFromCfg = (cfg.baseUrl || cfg.overrides?.baseUrl || '').trim();
    const endpointFromCfg = (cfg.overrides?.endpoint || cfg.endpoint || '').trim();
    const defaultModelFromCfg = (cfg.overrides?.defaultModel || cfg.defaultModel || '').trim();
    const timeoutFromCfg = cfg.overrides?.timeout ?? cfg.timeout;
    const maxRetriesFromCfg = cfg.overrides?.maxRetries ?? cfg.maxRetries;
    const headersFromCfg = (cfg.overrides?.headers || cfg.headers) as Record<string, string> | undefined;
    const authCapsFromCfg = cfg.authCapabilities;

    const hasConfigCoreProfile =
      !!baseFromCfg ||
      !!endpointFromCfg ||
      !!defaultModelFromCfg ||
      typeof timeoutFromCfg === 'number' ||
      typeof maxRetriesFromCfg === 'number' ||
      !!authCapsFromCfg ||
      !!headersFromCfg;

    const baseProfile =
      DynamicProfileLoader.buildServiceProfile(profileKey) ||
      DynamicProfileLoader.buildServiceProfile(providerType);

    if (hasConfigCoreProfile || forceConfigCoreDefaults) {
      if (forceConfigCoreDefaults) {
        if (!baseFromCfg) {
          throw new Error(
            `Provider config-core defaults missing baseUrl for providerId=${profileKey}`
          );
        }
        if (!endpointFromCfg && !baseProfile?.defaultEndpoint) {
          throw new Error(
            `Provider config-core defaults missing endpoint for providerId=${profileKey}`
          );
        }
      }

      const defaultBaseUrl =
        baseFromCfg ||
        baseProfile?.defaultBaseUrl ||
        'https://api.openai.com/v1';

      const defaultEndpoint =
        endpointFromCfg ||
        baseProfile?.defaultEndpoint ||
        '/chat/completions';

      const defaultModel =
        (defaultModelFromCfg && defaultModelFromCfg.length > 0)
          ? defaultModelFromCfg
          : (baseProfile?.defaultModel ?? '');

      const genericRequiredAuth: string[] = [];
      const genericOptionalAuth: string[] = ['apikey', 'oauth'];

      const requiredAuth =
        authCapsFromCfg?.required && authCapsFromCfg.required.length
          ? authCapsFromCfg.required
          : (baseProfile?.requiredAuth ?? genericRequiredAuth);

      const optionalAuth =
        authCapsFromCfg?.optional && authCapsFromCfg.optional.length
          ? authCapsFromCfg.optional
          : (baseProfile?.optionalAuth ?? genericOptionalAuth);

      const mergedHeaders: Record<string, string> = {
        ...(baseProfile?.headers || {}),
        ...(headersFromCfg || {})
      };

      const timeout =
        typeof timeoutFromCfg === 'number'
          ? timeoutFromCfg
          : (baseProfile?.timeout ?? DEFAULT_PROVIDER.TIMEOUT_MS);

      const maxRetries =
        typeof maxRetriesFromCfg === 'number'
          ? maxRetriesFromCfg
          : (baseProfile?.maxRetries ?? DEFAULT_PROVIDER.MAX_RETRIES);

      return {
        defaultBaseUrl,
        defaultEndpoint,
        defaultModel,
        requiredAuth,
        optionalAuth,
        headers: mergedHeaders,
        timeout,
        maxRetries,
        hooks: baseProfile?.hooks,
        features: baseProfile?.features,
        extensions: {
          ...(baseProfile?.extensions || {}),
          protocol: cfg.protocol || (baseProfile?.extensions as Record<string, unknown> | undefined)?.protocol
        }
      };
    }

    if (baseProfile) {
      return baseProfile;
    }

    throw new Error(`Unknown providerType='${providerType}' (no service profile registered)`);
  }
}
