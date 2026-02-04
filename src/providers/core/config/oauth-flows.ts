/**
 * 统一OAuth流程配置系统
 *
 * 分离认证流程和激活流程，支持多种OAuth策略
 */

import type { UnknownObject } from '../../../types/common-types.js';
import * as crypto from 'node:crypto';
import { openAuthInCamoufox } from './camoufox-launcher.js';

type BrowserOpener = (url: string) => Promise<void> | void;
type OpenModule = {
  default?: BrowserOpener;
  open?: BrowserOpener;
};
type ShellExecOptions = { shell?: boolean | string };
type ExecAsyncFn = (command: string, options?: ShellExecOptions) => Promise<{ stdout: string; stderr: string }>;

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
export interface TokenPortalMetadata {
  /** Landing page URL that shows token alias before redirecting to upstream OAuth */
  baseUrl: string;
  /** Provider identifier (display only) */
  provider?: string;
  /** Friendly alias derived from token file name */
  alias?: string;
  /** Absolute token file path (display only) */
  tokenFile?: string;
  /** Optional name/email to display */
  displayName?: string;
}

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
    /** 需要请求离线访问令牌（access_type=offline/prompt=consent） */
    requestOfflineAccess?: boolean;
  };
  /** RouteCodex token portal metadata (optional) */
  tokenPortal?: TokenPortalMetadata;
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
  abstract authenticate(options?: { openBrowser?: boolean; forceReauthorize?: boolean }): Promise<UnknownObject>;

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

    const portalUrl = this.buildTokenPortalUrl(targetUrl);
    const resolvedUrl = portalUrl || targetUrl;

    const shouldOpen = options.openBrowser !== false;
    if (shouldOpen) {
      console.log('Opening browser for authentication...');
      if (portalUrl) {
        console.log(`Portal URL: ${resolvedUrl}`);
        console.log(`OAuth URL: ${targetUrl}`);
      } else {
        console.log(`URL: ${targetUrl}`);
      }
      if (userCode) {
        console.log(`User Code: ${userCode}`);
      }
    }

    if (shouldOpen) {
      if (portalUrl) {
        await this.waitForPortalReady(portalUrl);
      }

      let opened = false;
      const envPref = (process.env.ROUTECODEX_OAUTH_BROWSER || '').toLowerCase();
      const camoufoxExplicit = envPref === 'camoufox';
      const preferCamoufox = envPref ? camoufoxExplicit : true;

      if (preferCamoufox) {
        const meta = this.extractTokenPortalMetadata(portalUrl);
        try {
          console.log('[OAuth] Launching Camoufox for authentication...');
          opened = await openAuthInCamoufox({
            url: resolvedUrl,
            provider: meta.provider,
            alias: meta.alias
          });
        } catch {
          opened = false;
        }
      }

      if (!opened && camoufoxExplicit) {
        throw new Error(
          'Camoufox OAuth is required but Camoufox is not available. Please install Camoufox first (python3 -m pip install --user -U camoufox) and retry.'
        );
      }

      if (!opened) {
        try {
          const openImport = (await import('open')) as unknown;
          let opener: BrowserOpener | undefined;
          if (typeof openImport === 'function') {
            opener = openImport as BrowserOpener;
          } else {
            const moduleRef = openImport as OpenModule;
            opener = moduleRef.default ?? moduleRef.open;
          }
          if (typeof opener === 'function') {
            await opener(resolvedUrl);
            opened = true;
          }
        } catch {
          /* ignore and fallback */
        }
      }

      if (!opened) {
        try {
          const { exec } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execAsync = promisify(exec) as ExecAsyncFn;
          await execAsync(`open "${resolvedUrl}"`).catch(async () => {
            await execAsync(`xdg-open "${resolvedUrl}"`).catch(async () => {
              const shellOptions: ShellExecOptions = { shell: true };
              await execAsync(`start "" "${resolvedUrl}"`, shellOptions);
            });
          });
          opened = true;
        } catch {
          /* ignore */
        }
      }

      if (!opened) {
        console.log('Could not open browser automatically. Please manually visit the URL.');
      }
    }
  }

  /**
   * 等待 Portal 服务器就绪
   * 在打开浏览器前确保路由已注册，避免 404
   */
  protected async waitForPortalReady(portalUrl: string): Promise<void> {
    try {
      const url = new URL(portalUrl);
      const baseUrl = `${url.protocol}//${url.host}`;
      const healthUrl = `${baseUrl}/health`;

      const timeoutTotalMsRaw = String(
        process.env.ROUTECODEX_OAUTH_PORTAL_READY_TIMEOUT_MS ||
          process.env.RCC_OAUTH_PORTAL_READY_TIMEOUT_MS ||
          '300000'
      ).trim();
      const timeoutTotalMs = Number.parseInt(timeoutTotalMsRaw, 10);
      const totalMs = Number.isFinite(timeoutTotalMs) && timeoutTotalMs > 0 ? timeoutTotalMs : 300000;

      const requestTimeoutMsRaw = String(
        process.env.ROUTECODEX_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS ||
          process.env.RCC_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS ||
          '1500'
      ).trim();
      const requestTimeoutMs = Number.parseInt(requestTimeoutMsRaw, 10);
      const perRequestMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 1500;

      const delayMsRaw = String(
        process.env.ROUTECODEX_OAUTH_PORTAL_READY_POLL_MS ||
          process.env.RCC_OAUTH_PORTAL_READY_POLL_MS ||
          '1000'
      ).trim();
      const delayMsParsed = Number.parseInt(delayMsRaw, 10);
      const delayMs = Number.isFinite(delayMsParsed) && delayMsParsed >= 0 ? delayMsParsed : 1000;

      const deadline = Date.now() + totalMs;

      while (Date.now() < deadline) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), perRequestMs);

          const response = await fetch(healthUrl, {
            method: 'GET',
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            console.log('[OAuth] Portal server is ready');
            return;
          }
        } catch (error) {
          // Server not ready yet, continue waiting
        }
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      // Server didn't respond in time, but continue anyway
      // The route might still work, just log a warning
      console.warn('[OAuth] Portal server health check timed out, continuing anyway...');
    } catch (error) {
      // Invalid URL or other error, just continue
      console.warn(`[OAuth] Failed to check portal readiness: ${error instanceof Error ? error.message : String(error)}`);
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
   * 构造 RouteCodex token portal URL（如果配置可用）
   */
  protected buildTokenPortalUrl(targetUrl: string): string | null {
    const portal = (this.config as OAuthFlowConfig)?.tokenPortal;
    if (!portal?.baseUrl) {
      return null;
    }
    try {
      const sessionId =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : crypto.randomBytes(12).toString('hex');
      const landing = new URL(portal.baseUrl);
      landing.searchParams.set('oauthUrl', targetUrl);
      landing.searchParams.set('sessionId', sessionId);
      if (portal.provider) {
        landing.searchParams.set('provider', portal.provider);
      }
      if (portal.alias) {
        landing.searchParams.set('alias', portal.alias);
      }
      if (portal.tokenFile) {
        landing.searchParams.set('tokenFile', portal.tokenFile);
      }
      if (portal.displayName) {
        landing.searchParams.set('displayName', portal.displayName);
      }
      return landing.toString();
    } catch (error) {
      console.warn(
        `[OAuth] Failed to build token auth portal URL (${portal.baseUrl}): ${error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  /**
   * 从 Token Portal URL 提取 provider / alias 元数据
   * 用于根据 token 名构造稳定的浏览器 profileId。
   */
  protected extractTokenPortalMetadata(
    portalUrl: string | null
  ): { provider?: string; alias?: string } {
    if (!portalUrl) {
      return {};
    }
    try {
      const u = new URL(portalUrl);
      const provider = u.searchParams.get('provider') || undefined;
      const alias = u.searchParams.get('alias') || undefined;
      return { provider, alias };
    } catch {
      return {};
    }
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
