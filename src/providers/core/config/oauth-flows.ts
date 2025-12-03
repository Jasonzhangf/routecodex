/**
 * 统一OAuth流程配置系统
 *
 * 分离认证流程和激活流程，支持多种OAuth策略
 */

import type { UnknownObject } from '../../../types/common-types.js';
import * as crypto from 'node:crypto';

/**
 * OAuth认证流程类型
 */
export enum OAuthFlowType {
  /** 设备码流程 */
  DEVICE_CODE = 'device_code',
  /** 授权码流程 */
  AUTHORIZATION_CODE = 'authorization_code',
  /** 混合流程（先尝试授权码，失败则使用设备码） */
  HYBRID = 'hybrid'
}

/**
 * OAuth激活流程类型
 */
export enum OAuthActivationType {
  /** 浏览器自动打开 */
  AUTO_BROWSER = 'auto_browser',
  /** 手动操作 */
  MANUAL = 'manual',
  /** 后台静默激活 */
  SILENT = 'silent'
}

/**
 * OAuth端点配置
 */
export interface OAuthEndpoints {
  /** 设备码获取端点 */
  deviceCodeUrl: string;
  /** 令牌交换端点 */
  tokenUrl: string;
  /** 授权端点（用于授权码流程） */
  authorizationUrl?: string;
  /** 用户信息端点（可选） */
  userInfoUrl?: string;
}

/**
 * OAuth客户端配置
 */
export interface OAuthClientConfig {
  /** 客户端ID */
  clientId: string;
  /** 客户端密钥（可选） */
  clientSecret?: string;
  /** 请求范围 */
  scopes: string[];
  /** 重定向URI（授权码流程使用） */
  redirectUri?: string;
}

/**
 * OAuth流程配置
 */
export interface OAuthFlowConfig {
  /** 流程类型 */
  flowType: OAuthFlowType;
  /** 激活类型 */
  activationType: OAuthActivationType;
  /** 端点配置 */
  endpoints: OAuthEndpoints;
  /** 客户端配置 */
  client: OAuthClientConfig;
  /** 自定义头部 */
  headers?: Record<string, string>;
  /** 轮询配置 */
  polling?: {
    interval: number;
    maxAttempts: number;
    timeout: number;
  };
  /** 重试配置 */
  retry?: {
    maxAttempts: number;
    backoffMs: number;
  };
  /** 特殊配置 */
  features?: {
    /** 支持PKCE */
    supportsPKCE?: boolean;
    /** 支持API密钥交换 */
    supportsApiKeyExchange?: boolean;
    /** 要求HTTPS回调 */
    requireHttpsCallback?: boolean;
    /** 自定义状态参数 */
    customState?: boolean;
  };
}

/**
 * OAuth流程策略基类
 */
export abstract class BaseOAuthFlowStrategy {
  protected config: OAuthFlowConfig;
  protected httpClient: typeof fetch;

  constructor(config: OAuthFlowConfig, httpClient: typeof fetch = fetch) {
    this.config = config;
    this.httpClient = httpClient;
  }

  /**
   * 执行认证流程
   */
  abstract authenticate(options?: { openBrowser?: boolean }): Promise<UnknownObject>;

  /**
   * 刷新令牌
   */
  abstract refreshToken(refreshToken: string): Promise<UnknownObject>;

  /**
   * 验证令牌
   */
  abstract validateToken(token: UnknownObject): boolean;

  /**
   * 获取授权头部
   */
  abstract getAuthHeader(token: UnknownObject): string;

  /**
   * 保存令牌到存储
   */
  abstract saveToken(token: UnknownObject): Promise<void>;

  /**
   * 从存储加载令牌
   */
  abstract loadToken(): Promise<UnknownObject | null>;

  /**
   * 执行激活流程
   */
  async activate(activationData: UnknownObject, options: { openBrowser?: boolean } = {}): Promise<void> {
    switch (this.config.activationType) {
      case OAuthActivationType.AUTO_BROWSER:
        return this.activateWithBrowser(activationData, options);
      case OAuthActivationType.MANUAL:
        return this.activateManually(activationData, options);
      case OAuthActivationType.SILENT:
        return this.activateSilently(activationData, options);
      default:
        throw new Error(`Unsupported activation type: ${this.config.activationType}`);
    }
  }

  /**
   * 浏览器自动激活
   */
  protected async activateWithBrowser(activationData: UnknownObject, options: { openBrowser?: boolean } = {}): Promise<void> {
    const { verificationUri, userCode, authUrl } = activationData as {
      verificationUri?: string;
      userCode?: string;
      authUrl?: string;
    };

    const targetUrl = authUrl || verificationUri;
    if (!targetUrl) {
      throw new Error('No activation URL provided');
    }

    console.log('Opening browser for authentication...');
    console.log(`URL: ${targetUrl}`);
    if (userCode) {
      console.log(`User Code: ${userCode}`);
    }

    if (options.openBrowser !== false) {
      // Prefer npm 'open' for cross-platform behavior; fallback to OS-specific commands
      let opened = false;
      try {
        const openMod: any = await import('open');
        if (openMod && (openMod.default || openMod.open)) {
          const opener = openMod.default || openMod.open;
          await opener(targetUrl);
          opened = true;
        }
      } catch { /* ignore and fallback */ }
      if (!opened) {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync: any = promisify(exec);
          // macOS
          await execAsync(`open \"${targetUrl}\"`).catch(async () => {
            // Linux
            await execAsync(`xdg-open \"${targetUrl}\"`).catch(async () => {
              // Windows
              await execAsync(`start \"\" \"${targetUrl}\"`, { shell: true } as any);
            });
          });
          opened = true;
        } catch { /* ignore */ }
      }
      if (!opened) {
        console.log('Could not open browser automatically. Please manually visit the URL.');
      }
    }
  }

  /**
   * 手动激活
   */
  protected async activateManually(activationData: UnknownObject, _options: { openBrowser?: boolean } = {}): Promise<void> {
    const { verificationUri, userCode, authUrl, instructions } = activationData as {
      verificationUri?: string;
      userCode?: string;
      authUrl?: string;
      instructions?: string;
    };

    const targetUrl = authUrl || verificationUri;

    console.log('=== Manual Authentication Required ===');
    if (instructions) {
      console.log(instructions);
    } else {
      console.log(`Please visit: ${targetUrl}`);
      if (userCode) {
        console.log(`Enter user code: ${userCode}`);
      }
    }
    console.log('======================================');
  }

  /**
   * 静默激活
   */
  protected async activateSilently(activationData: UnknownObject, _options: { openBrowser?: boolean } = {}): Promise<void> {
    // 默认实现：静默激活实际上不做任何事，依赖后台流程
    console.log('Silent activation initiated...');
  }

  /**
   * 生成PKCE对
   */
  protected generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { codeVerifier: verifier, codeChallenge: challenge };
  }

  /**
   * 执行HTTP请求
   */
  protected async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const defaultHeaders = {
      // 注意：表单请求会在调用处覆盖此项
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this.config.headers
    } as Record<string, string>;

    const mergedOptions: RequestInit = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers as Record<string, string> || {})
      }
    };

    return this.httpClient(url, mergedOptions);
  }

  /**
   * 解析错误响应
   */
  protected async parseErrorResponse(response: Response): Promise<Error> {
    try {
      const errorText = await response.text();
      const errorData = JSON.parse(errorText);
      return new Error(`OAuth error: ${errorData.error} - ${errorData.error_description || 'No description'}`);
    } catch {
      const errorText = await response.text();
      return new Error(`HTTP error: ${response.status} ${response.statusText} - ${errorText}`);
    }
  }
}

/**
 * OAuth流程工厂接口
 */
export interface OAuthFlowStrategyFactory {
  createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy;
  getFlowType(): OAuthFlowType;
}

/**
 * OAuth流程配置管理器
 */
export class OAuthFlowConfigManager {
  private static flowFactories = new Map<OAuthFlowType, OAuthFlowStrategyFactory>();
  private static defaultConfigs = new Map<string, Partial<OAuthFlowConfig>>();

  /**
   * 注册OAuth流程策略工厂
   */
  static registerFlowFactory(flowType: OAuthFlowType, factory: OAuthFlowStrategyFactory): void {
    this.flowFactories.set(flowType, factory);
  }

  /**
   * 获取OAuth流程策略工厂
   */
  static getFlowFactory(flowType: OAuthFlowType): OAuthFlowStrategyFactory | null {
    return this.flowFactories.get(flowType) || null;
  }

  /**
   * 注册默认配置
   */
  static registerDefaultConfig(providerId: string, config: Partial<OAuthFlowConfig>): void {
    this.defaultConfigs.set(providerId, config);
  }

  /**
   * 获取默认配置
   */
  static getDefaultConfig(providerId: string): Partial<OAuthFlowConfig> | null {
    return this.defaultConfigs.get(providerId) || null;
  }

  /**
   * 创建OAuth流程配置
   */
  static createConfig(providerId: string, overrides: Partial<OAuthFlowConfig> = {}): OAuthFlowConfig {
    const defaultConfig = this.getDefaultConfig(providerId) || {};
    const merged = { ...defaultConfig, ...overrides } as OAuthFlowConfig;

    // 验证必需字段
    if (!merged.flowType) {
      throw new Error(`OAuth flow type is required for provider: ${providerId}`);
    }
    if (!merged.endpoints || !merged.endpoints.deviceCodeUrl || !merged.endpoints.tokenUrl) {
      throw new Error(`OAuth endpoints are required for provider: ${providerId}`);
    }
    if (!merged.client || !merged.client.clientId) {
      throw new Error(`OAuth client config is required for provider: ${providerId}`);
    }

    // 设置默认值
    const defaultValues = {
      activationType: OAuthActivationType.AUTO_BROWSER,
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
        customState: false
      }
    };

    return {
      ...defaultValues,
      ...merged
    };
  }

  /**
   * 创建OAuth流程策略
   */
  static createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy {
    const factory = this.getFlowFactory(config.flowType);
    if (!factory) {
      throw new Error(`No factory registered for OAuth flow type: ${config.flowType}`);
    }
    return factory.createStrategy(config, httpClient, tokenFile);
  }

  /**
   * 列出所有支持的流程类型
   */
  static getSupportedFlowTypes(): OAuthFlowType[] {
    return Array.from(this.flowFactories.keys());
  }

  /**
   * 列出所有注册的provider
   */
  static getRegisteredProviders(): string[] {
    return Array.from(this.defaultConfigs.keys());
  }
}

export default OAuthFlowConfigManager;
