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
import { EcoDevOAuthFlowStrategy } from '../strategies/ecodev-oauth-flow.js';

let oauthConfigsInitialized = false;

function registerOAuthFlowFactories(): void {
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.DEVICE_CODE, new OAuthDeviceFlowStrategyFactory());
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.AUTHORIZATION_CODE, new OAuthAuthCodeFlowStrategyFactory());
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.HYBRID, new OAuthHybridFlowStrategyFactory());
}

function registerProviderOAuthConfigs(): void {
  OAuthFlowConfigManager.registerDefaultConfig('ecodev', {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      authorizationUrl: 'https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply',
      deviceCodeUrl: 'ecodev-local-callback',
      tokenUrl: 'https://cn.devecostudio.huawei.com/authrouter/auth/api/temptoken/check',
      userInfoUrl: 'https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check'
    },
    client: {
      clientId: '1008',
      scopes: []
    },
    retry: {
      maxAttempts: 1,
      backoffMs: 0
    }
  });
}

export function initializeOAuthConfigs(): void {
  if (oauthConfigsInitialized) {
    return;
  }
  registerOAuthFlowFactories();
  registerProviderOAuthConfigs();
  oauthConfigsInitialized = true;
}

export function getProviderOAuthConfig(
  providerId: string,
  overrides: Record<string, unknown> = {}
): OAuthFlowConfig {
  initializeOAuthConfigs();
  return OAuthFlowConfigManager.createConfig(providerId, overrides);
}

export function createProviderOAuthStrategy(providerId: string, overrides: Record<string, unknown> = {}, tokenFile?: string) {
  const config = getProviderOAuthConfig(providerId, overrides);
  if (providerId.trim().toLowerCase() === 'ecodev') {
    return new EcoDevOAuthFlowStrategy(config, undefined, tokenFile);
  }
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
