/**
 * Provider特定的OAuth配置
 */
import { LOCAL_HOSTS, HTTP_PROTOCOLS, DEFAULT_CONFIG, API_PATHS } from '../../../constants/index.js';
import { OAuthFlowConfigManager, OAuthFlowType, OAuthActivationType, type OAuthFlowConfig } from './oauth-flows.js';
import type { ProviderProfileCollection } from '../../profile/provider-profile.js';
import type { ProviderProfile } from '../../profile/provider-profile.js';
import { OAuthDeviceFlowStrategyFactory } from '../strategies/oauth-device-flow.js';
import { OAuthAuthCodeFlowStrategyFactory } from '../strategies/oauth-auth-code-flow.js';
import { OAuthHybridFlowStrategyFactory } from '../strategies/oauth-hybrid-flow.js';

function registerOAuthFlowFactories(): void {
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.DEVICE_CODE, new OAuthDeviceFlowStrategyFactory());
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.AUTHORIZATION_CODE, new OAuthAuthCodeFlowStrategyFactory());
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.HYBRID, new OAuthHybridFlowStrategyFactory());
}

function registerProviderOAuthConfigs(): void {
  OAuthFlowConfigManager.registerDefaultConfig('qwen', {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
      tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
      userInfoUrl: 'https://chat.qwen.ai/api/v1/user/info'
    },
    client: {
      clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
      scopes: ['openid', 'profile', 'email', 'model.completion']
    },
    headers: {},
    polling: {
      interval: 5000,
      maxAttempts: 60,
      timeout: 300000
    },
    retry: {
      maxAttempts: 3,
      backoffMs: 1000
    },
    features: {
      supportsPKCE: true,
      supportsApiKeyExchange: false,
      requireHttpsCallback: true,
      customState: false,
      requestOfflineAccess: true
    }
  });
}

export function initializeOAuthConfigs(): void {
  registerOAuthFlowFactories();
  registerProviderOAuthConfigs();
}

export function getProviderOAuthConfig(
  providerId: string,
  overrides: Record<string, unknown> = {}
): OAuthFlowConfig {
  return OAuthFlowConfigManager.createConfig(providerId, overrides);
}

export function createProviderOAuthStrategy(providerId: string, overrides: Record<string, unknown> = {}, tokenFile?: string) {
  const config = getProviderOAuthConfig(providerId, overrides);
  return OAuthFlowConfigManager.createStrategy(config, undefined, tokenFile);
}

export function resolveOAuthBrowserPreference(
  providerId: string,
  profiles: ProviderProfileCollection | undefined
): 'camoufox' | 'default' | undefined {
  if (!profiles) {
    return undefined;
  }
  const profile: ProviderProfile | undefined = profiles.byId[providerId];
  return profile?.transport?.oauthBrowser;
}

export const OAUTH_CONFIG_TEMPLATES = {
  DEVICE_CODE_TEMPLATE: {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.MANUAL,
    endpoints: {
      deviceCodeUrl: '',
      tokenUrl: ''
    },
    client: {
      clientId: '',
      scopes: []
    },
    polling: {
      interval: 5000,
      maxAttempts: 60,
      timeout: 300000
    },
    retry: {
      maxAttempts: 3,
      backoffMs: 1000
    }
  },
  AUTHORIZATION_CODE_TEMPLATE: {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      authorizationUrl: '',
      tokenUrl: ''
    },
    client: {
      clientId: '',
      clientSecret: '',
      scopes: [],
      redirectUri: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.OAUTH_CALLBACK_PORT}${API_PATHS.OAUTH_CALLBACK}`
    },
    retry: {
      maxAttempts: 3,
      backoffMs: 1000
    }
  }
} as const;
