/**
 * Provider特定的OAuth配置
 *
 * 基于iflow和qwen的实际配置，提供预定义的OAuth流程配置
 */

import { OAuthFlowConfigManager, OAuthFlowType, OAuthActivationType, type OAuthFlowConfig } from './oauth-flows.js';
import { OAuthDeviceFlowStrategyFactory } from '../strategies/oauth-device-flow.js';
import { OAuthAuthCodeFlowStrategyFactory } from '../strategies/oauth-auth-code-flow.js';
import { OAuthHybridFlowStrategyFactory } from '../strategies/oauth-hybrid-flow.js';

/**
 * 注册默认的OAuth流程工厂
 */
function registerOAuthFlowFactories(): void {
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.DEVICE_CODE, new OAuthDeviceFlowStrategyFactory());
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.AUTHORIZATION_CODE, new OAuthAuthCodeFlowStrategyFactory());
  OAuthFlowConfigManager.registerFlowFactory(OAuthFlowType.HYBRID, new OAuthHybridFlowStrategyFactory());
}

/**
 * 注册Provider特定的OAuth配置
 */
function registerProviderOAuthConfigs(): void {
  // Qwen OAuth配置
  OAuthFlowConfigManager.registerDefaultConfig('qwen', {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
      tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
      userInfoUrl: 'https://portal.qwen.ai/api/v1/user/info'
    },
    client: {
      clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
      scopes: ['openid', 'profile', 'email', 'model.completion']
    },
    headers: {
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
      'Accept': 'application/json'
    },
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
      customState: false
    }
  });

  // iFlow OAuth配置 - 主要使用授权码流程，可配置设备码回退
  OAuthFlowConfigManager.registerDefaultConfig('iflow', {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
      tokenUrl: 'https://iflow.cn/oauth/token',
      authorizationUrl: 'https://iflow.cn/oauth',
      userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo'
    },
    client: {
      clientId: 'iflow-desktop-client',
      scopes: ['openid', 'profile', 'email', 'api'],
      redirectUri: 'http://localhost:8080/oauth2callback'
    },
    headers: {
      'User-Agent': 'iflow-cli/2.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://iflow.cn',
      'Referer': 'https://iflow.cn/oauth'
    },
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
      supportsApiKeyExchange: true,
      requireHttpsCallback: true,
      customState: true
    }
  });

  // iFlow OAuth设备码配置（备用）
  OAuthFlowConfigManager.registerDefaultConfig('iflow-device', {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
      tokenUrl: 'https://iflow.cn/oauth/token',
      userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo'
    },
    client: {
      clientId: 'iflow-desktop-client',
      scopes: ['openid', 'profile', 'email', 'api']
    },
    headers: {
      'User-Agent': 'iflow-cli/2.0',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://iflow.cn',
      'Referer': 'https://iflow.cn/oauth'
    },
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
      supportsApiKeyExchange: true,
      requireHttpsCallback: false,
      customState: false
    }
  });
}

/**
 * 初始化OAuth配置系统
 */
export function initializeOAuthConfigs(): void {
  // 注册流程工厂
  registerOAuthFlowFactories();

  // 注册Provider配置
  registerProviderOAuthConfigs();
}

/**
 * 获取Provider的OAuth配置
 */
export function getProviderOAuthConfig(providerId: string, overrides: Record<string, unknown> = {}): OAuthFlowConfig {
  return OAuthFlowConfigManager.createConfig(providerId, overrides);
}

/**
 * 创建Provider的OAuth策略
 */
export function createProviderOAuthStrategy(providerId: string, overrides: Record<string, unknown> = {}) {
  const config = getProviderOAuthConfig(providerId, overrides);
  return OAuthFlowConfigManager.createStrategy(config);
}

/**
 * 预定义的OAuth配置模板
 */
export const OAUTH_CONFIG_TEMPLATES = {
  // 标准OAuth 2.0设备码流程配置模板
  DEVICE_CODE_TEMPLATE: {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
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
      customState: false
    }
  } as Partial<OAuthFlowConfig>,

  // 标准OAuth 2.0授权码流程配置模板
  AUTH_CODE_TEMPLATE: {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    polling: {
      interval: 1000,
      maxAttempts: 30,
      timeout: 120000
    },
    retry: {
      maxAttempts: 3,
      backoffMs: 1000
    },
    features: {
      supportsPKCE: true,
      supportsApiKeyExchange: false,
      requireHttpsCallback: true,
      customState: true
    }
  } as Partial<OAuthFlowConfig>,

  // 主备流程配置模板（不自动回退，需显式配置）
  PRIMARY_FALLBACK_TEMPLATE: {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
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
      supportsApiKeyExchange: true,
      requireHttpsCallback: true,
      customState: true
    }
  } as Partial<OAuthFlowConfig>
};

/**
 * 从模板创建OAuth配置
 */
export function createOAuthConfigFromTemplate(
  template: keyof typeof OAUTH_CONFIG_TEMPLATES,
  providerSpecific: Partial<OAuthFlowConfig> = {}
): OAuthFlowConfig {
  const baseConfig = OAUTH_CONFIG_TEMPLATES[template];
  return OAuthFlowConfigManager.createConfig('custom', { ...baseConfig, ...providerSpecific });
}

// 自动初始化
initializeOAuthConfigs();

export default {
  initializeOAuthConfigs,
  getProviderOAuthConfig,
  createProviderOAuthStrategy,
  OAUTH_CONFIG_TEMPLATES,
  createOAuthConfigFromTemplate
};