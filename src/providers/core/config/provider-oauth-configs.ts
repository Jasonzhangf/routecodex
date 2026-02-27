/**
 * Provider特定的OAuth配置
 *
 * 基于iflow和qwen的实际配置，提供预定义的OAuth流程配置
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, DEFAULT_CONFIG, API_PATHS } from "../../../constants/index.js";
import { OAuthFlowConfigManager, OAuthFlowType, OAuthActivationType, type OAuthFlowConfig } from './oauth-flows.js';
import type { ProviderProfileCollection } from '../../profile/provider-profile.js';
import type { ProviderProfile } from '../../profile/provider-profile.js';
import { OAuthDeviceFlowStrategyFactory } from '../strategies/oauth-device-flow.js';
import { OAuthAuthCodeFlowStrategyFactory } from '../strategies/oauth-auth-code-flow.js';
import { OAuthHybridFlowStrategyFactory } from '../strategies/oauth-hybrid-flow.js';

type OAuthClientField = 'clientId' | 'clientSecret';
type LocalOAuthClientConfig = Record<string, Partial<Record<OAuthClientField, string>>>;

const LOCAL_OAUTH_CLIENTS_FILE = path.join(os.homedir(), '.routecodex', 'auth', 'oauth-clients.local.json');

let localOAuthClientsCache: LocalOAuthClientConfig | null | undefined;

function readLocalOAuthClients(): LocalOAuthClientConfig | null {
  if (localOAuthClientsCache !== undefined) {
    return localOAuthClientsCache;
  }
  try {
    const raw = fs.readFileSync(LOCAL_OAUTH_CLIENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localOAuthClientsCache = null;
      return null;
    }
    localOAuthClientsCache = parsed as LocalOAuthClientConfig;
    return localOAuthClientsCache;
  } catch {
    localOAuthClientsCache = null;
    return null;
  }
}

function readOAuthCredential(
  primary: string,
  secondary: string,
  fallback: string,
  providerId: 'gemini-cli' | 'antigravity',
  field: OAuthClientField
): string {
  const fromPrimary = String(process.env[primary] || '').trim();
  if (fromPrimary) return fromPrimary;
  const fromSecondary = String(process.env[secondary] || '').trim();
  if (fromSecondary) return fromSecondary;
  const local = readLocalOAuthClients();
  const fromLocal = String(local?.[providerId]?.[field] || '').trim();
  if (fromLocal) return fromLocal;
  return fallback;
}

const DEFAULT_GEMINI_CLI_GOOGLE_CLIENT_ID = 'ROUTECODEX_GEMINI_CLI_GOOGLE_CLIENT_ID_NOT_SET';
const DEFAULT_GEMINI_CLI_GOOGLE_CLIENT_SECRET = 'ROUTECODEX_GEMINI_CLI_GOOGLE_CLIENT_SECRET_NOT_SET';
const DEFAULT_ANTIGRAVITY_GOOGLE_CLIENT_ID = 'ROUTECODEX_ANTIGRAVITY_GOOGLE_CLIENT_ID_NOT_SET';
const DEFAULT_ANTIGRAVITY_GOOGLE_CLIENT_SECRET = 'ROUTECODEX_ANTIGRAVITY_GOOGLE_CLIENT_SECRET_NOT_SET';

const GEMINI_CLI_GOOGLE_CLIENT_ID = readOAuthCredential(
  'ROUTECODEX_GEMINI_CLI_GOOGLE_CLIENT_ID',
  'RCC_GEMINI_CLI_GOOGLE_CLIENT_ID',
  DEFAULT_GEMINI_CLI_GOOGLE_CLIENT_ID,
  'gemini-cli',
  'clientId'
);
const GEMINI_CLI_GOOGLE_CLIENT_SECRET = readOAuthCredential(
  'ROUTECODEX_GEMINI_CLI_GOOGLE_CLIENT_SECRET',
  'RCC_GEMINI_CLI_GOOGLE_CLIENT_SECRET',
  DEFAULT_GEMINI_CLI_GOOGLE_CLIENT_SECRET,
  'gemini-cli',
  'clientSecret'
);
const ANTIGRAVITY_GOOGLE_CLIENT_ID = readOAuthCredential(
  'ROUTECODEX_ANTIGRAVITY_GOOGLE_CLIENT_ID',
  'RCC_ANTIGRAVITY_GOOGLE_CLIENT_ID',
  DEFAULT_ANTIGRAVITY_GOOGLE_CLIENT_ID,
  'antigravity',
  'clientId'
);
const ANTIGRAVITY_GOOGLE_CLIENT_SECRET = readOAuthCredential(
  'ROUTECODEX_ANTIGRAVITY_GOOGLE_CLIENT_SECRET',
  'RCC_ANTIGRAVITY_GOOGLE_CLIENT_SECRET',
  DEFAULT_ANTIGRAVITY_GOOGLE_CLIENT_SECRET,
  'antigravity',
  'clientSecret'
);

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
      userInfoUrl: 'https://chat.qwen.ai/api/v1/user/info'
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
      customState: false,
      // 对齐 Gemini/Antigravity：始终请求可刷新离线 token
      requestOfflineAccess: true
    }
  });

  // iFlow OAuth默认配置：优先授权码流程（回调链路）
  // 说明：
  // - /oauth/device/code 当前会返回 HTML 页面而非 device-code JSON，导致手动 OAuth 在首步即失败。
  // - 默认改为授权码流程，走 /oauth + localhost 回调，保留 iflow-device 作为显式设备码备用。
  OAuthFlowConfigManager.registerDefaultConfig('iflow', {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      // 授权码主链路
      deviceCodeUrl: 'https://iflow.cn/api/oauth2/device/code',
      tokenUrl: 'https://iflow.cn/oauth/token',
      authorizationUrl: 'https://iflow.cn/oauth',
      userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo'
    },
    client: {
      // 对齐CLIProxyAPI：使用官方客户端ID和密钥
      clientId: '10009311001',
      clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
      scopes: ['openid', 'profile', 'email', 'api'],
      // 对齐 CLIProxyAPI：iflow OAuth callback 默认使用 11451，避免与主服务端口冲突
      redirectUri: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:11451${API_PATHS.OAUTH_CALLBACK}`
    },
    headers: {
      'User-Agent': 'iFlow-Cli',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://iflow.cn',
      'Referer': 'https://iflow.cn/oauth',
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
      supportsApiKeyExchange: true,
      requireHttpsCallback: true,
      customState: true,
      // 对齐 Antigravity/Gemini：请求离线 refresh_token，便于自动续期
      requestOfflineAccess: true
    }
  });

  // iFlow OAuth设备码配置（备用）
  OAuthFlowConfigManager.registerDefaultConfig('iflow-device', {
    flowType: OAuthFlowType.DEVICE_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      // 兼容历史 CLI 链路：设备码端点仍使用 /api/oauth2 前缀
      deviceCodeUrl: 'https://iflow.cn/api/oauth2/device/code',
      tokenUrl: 'https://iflow.cn/api/oauth2/token',
      userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo'
    },
    client: {
      // 使用与主配置相同的客户端凭据
      clientId: '10009311001',
      clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
      scopes: ['openid', 'profile', 'email', 'api']
    },
    headers: {
      'User-Agent': 'iFlow-Cli',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://iflow.cn',
      'Referer': 'https://iflow.cn/oauth',
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
      supportsApiKeyExchange: true,
      requireHttpsCallback: false,
      customState: false
    }
  });

  // Gemini CLI OAuth 配置 - 对齐 CLIProxyAPI / Gemini CLI 登录行为
  // 使用标准 Google OAuth 2.0 授权码流程，后续通过 gemini-cli-userinfo-helper 获取项目列表。
  OAuthFlowConfigManager.registerDefaultConfig('gemini-cli', {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      // 使用标准设备码端点以满足配置校验要求，实际流程仍以授权码为主
      deviceCodeUrl: 'https://oauth2.googleapis.com/device/code'
    },
    client: {
      clientId: GEMINI_CLI_GOOGLE_CLIENT_ID,
      clientSecret: GEMINI_CLI_GOOGLE_CLIENT_SECRET,
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ],
      redirectUri: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.OAUTH_CALLBACK_PORT}${API_PATHS.OAUTH_CALLBACK}`
    },
    headers: {
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
      customState: true,
      // 对齐 gcli2api：始终请求 offline refresh_token
      requestOfflineAccess: true
    }
  });

  // Antigravity OAuth 配置 - 复用 gcli2api 中的 Antigravity 客户端配置
  // 仅用于本地开发 / 调试场景，通过独立 providerId 实现与 gemini-cli 的 OAuth 隔离。
  OAuthFlowConfigManager.registerDefaultConfig('antigravity', {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      deviceCodeUrl: 'https://oauth2.googleapis.com/device/code'
    },
    client: {
      clientId: ANTIGRAVITY_GOOGLE_CLIENT_ID,
      clientSecret: ANTIGRAVITY_GOOGLE_CLIENT_SECRET,
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
      ],
      redirectUri: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.OAUTH_CALLBACK_PORT}${API_PATHS.OAUTH_CALLBACK}`
    },
    headers: {
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
      customState: true,
      requestOfflineAccess: true
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
export function getProviderOAuthConfig(
  providerId: string,
  overrides: Record<string, unknown> = {}
): OAuthFlowConfig {
  return OAuthFlowConfigManager.createConfig(providerId, overrides);
}

/**
 * 创建Provider的OAuth策略
 */
export function createProviderOAuthStrategy(providerId: string, overrides: Record<string, unknown> = {}, tokenFile?: string) {
  const config = getProviderOAuthConfig(providerId, overrides);
  return OAuthFlowConfigManager.createStrategy(config, undefined, tokenFile);
}

/**
 * 从 ProviderProfile 集合中，根据 providerId 提取 oauthBrowser 首选项。
 * 目前用于在 OAuth 浏览器激活时优先选择 Camoufox。
 */
export function resolveOAuthBrowserPreference(
  providerId: string,
  profiles: ProviderProfileCollection | undefined
): 'camoufox' | 'default' | undefined {
  if (!profiles) {
    return undefined;
  }
  const profile: ProviderProfile | undefined = profiles.byId[providerId];
  const browser = profile?.transport?.oauthBrowser;
  return browser;
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
