/**
 * OAuth设备码流程策略
 *
 * 实现标准的OAuth 2.0设备码流程
 */

import type { UnknownObject } from '../../../types/common-types.js';
import { BaseOAuthFlowStrategy, OAuthFlowType } from '../config/oauth-flows.js';
import type { OAuthFlowConfig } from '../config/oauth-flows.js';
import fs from 'fs/promises';
import path from 'path';
import { logOAuthDebug } from '../../auth/oauth-logger.js';
import { formatOAuthErrorMessage } from '../../auth/oauth-error-message.js';
import { isPermanentOAuthRefreshErrorMessage } from './oauth-refresh-errors.js';

/**
 * 设备码令牌响应
 */
interface DeviceCodeTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in: number;
  // Provider-specific fields
  resource_url?: string;
  apiKey?: string;
}

interface DeviceCodeData extends Record<string, unknown> {
  device_code: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  code_verifier?: string;
}

function resolvePollingIntervalMs(intervalRaw: unknown): number | null {
  const value = Number(intervalRaw);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  // Backward compatibility:
  // - provider configs historically used milliseconds (e.g. 5000)
  // - OAuth device endpoints typically return seconds (e.g. 5)
  // Treat >=1000 as milliseconds, otherwise seconds.
  const ms = value >= 1000 ? value : value * 1000;
  // Guard rail: avoid zero/negative or unreasonably large accidental values.
  return Math.min(Math.max(ms, 1000), 120000);
}

type UserInfoPayload = {
  apiKey?: string;
  data?: {
    apiKey?: string;
    email?: string;
    phone?: string;
  };
} & Record<string, unknown>;

type StoredToken = DeviceCodeTokenResponse & {
  api_key?: string;
  email?: string;
  expires_at?: number;
  expired?: string;
  expiry_date?: number | string;
} & UnknownObject;

/**
 * OAuth设备码流程策略
 */
export class OAuthDeviceFlowStrategy extends BaseOAuthFlowStrategy {
  private tokenFile: string;
  private tokenStorage: StoredToken | null = null;

  constructor(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string) {
    super(config, httpClient);

    this.tokenFile = tokenFile || path.join(
      process.env.HOME || '',
      `.${config.client.clientId}`,
      'oauth_creds.json'
    );
  }

  /**
   * 执行设备码认证流程
   */
  async authenticate(options: { openBrowser?: boolean; forceReauthorize?: boolean } = {}): Promise<UnknownObject> {
    try {
      const forceReauth = options.forceReauthorize === true;
      // 1. 尝试加载现有令牌
      const existingToken = this.coerceStoredToken(await this.loadToken());
      if (!forceReauth && existingToken && this.validateToken(existingToken)) {
        logOAuthDebug('[OAuth] Using existing valid token');
        return existingToken;
      }

      // 2. 如果令牌过期但可以刷新，则尝试刷新
      if (!forceReauth && existingToken?.refresh_token) {
        try {
          logOAuthDebug('[OAuth] Token expired, attempting refresh...');
          const refreshedRaw = await this.refreshToken(existingToken.refresh_token);
          const refreshedToken = this.ensureStoredToken(refreshedRaw);
          await this.saveToken(refreshedToken);
          logOAuthDebug('[OAuth] Token refreshed successfully');
          return refreshedToken;
        } catch (error) {
          console.warn('Token refresh failed, initiating new authentication:', error instanceof Error ? error.message : String(error));
        }
      }

      // 3. 执行新的设备码认证流程
      logOAuthDebug('[OAuth] Starting OAuth device code flow...');

      const deviceCodeData = await this.initiateDeviceCodeFlow();
      await this.activate(deviceCodeData, options);
      const tokenResponse = await this.pollForToken(deviceCodeData);

      // 4. 处理特殊激活（如API密钥交换）
      const finalToken = await this.handlePostTokenActivation(tokenResponse);

      // 5. 保存令牌
      await this.saveToken(finalToken);

      logOAuthDebug('[OAuth] OAuth device code flow completed successfully!');
      return finalToken;

    } catch (error) {
      console.error('OAuth device code flow failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 初始化设备码流程
   */
  private async initiateDeviceCodeFlow(): Promise<DeviceCodeData> {
    if (!this.config.endpoints.deviceCodeUrl) {
      throw new Error('Device code URL is required for device code flow');
    }

    const formData = new URLSearchParams({
      client_id: this.config.client.clientId,
      scope: this.config.client.scopes.join(' ')
    });

    // 启用 PKCE：对齐 Qwen CLI 实现（设备码 + 代码校验）
    let codeVerifier: string | undefined;
    if (this.config.features?.supportsPKCE) {
      try {
        const pair = this.generatePKCEPair();
        codeVerifier = pair.codeVerifier;
        formData.append('code_challenge', pair.codeChallenge);
        formData.append('code_challenge_method', 'S256');
      } catch {
        // PKCE 生成失败时不阻断设备码流程，只是不加校验参数
        codeVerifier = undefined;
      }
    }

    const response = await this.makeRequest(this.config.endpoints.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData
    });

    if (!response.ok) {
      throw await this.parseErrorResponse(response);
    }

    // 设备码端点尝试解析 JSON；若失败打印预览并中断
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      const text = await response.text().catch(() => '');
      const preview = (text || '').slice(0, 180);
      throw new Error(`Device code endpoint did not return JSON (preview='${preview}')`);
    }

    const dbgEnabled = String(process.env.ROUTECODEX_OAUTH_DEBUG || '1') === '1';
    if (dbgEnabled) {
      try { logOAuthDebug(`[OAuth] device-code raw: ${JSON.stringify(raw).slice(0, 512)}`); } catch { /* ignore */ }
    }

    // 兼容多种形状（顶层/ data / result；蛇形/驼峰；uri/url）
    const rawObj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
    const container = rawObj && (rawObj.data || rawObj.result)
      ? (rawObj.data || rawObj.result)
      : rawObj;
    const mapped = container && typeof container === 'object' ? container as Record<string, unknown> : undefined;
    const mapValue = (obj: Record<string, unknown> | undefined, keys: string[]): unknown => {
      if (!obj) {
        return undefined;
      }
      for (const k of keys) {
        if (k in obj && obj[k] !== null && obj[k] !== undefined) {
          return obj[k];
        }
      }
      return undefined;
    };

    const device_code = mapValue(mapped, ['device_code', 'deviceCode', 'deviceCodeId']);
    const user_code = mapValue(mapped, ['user_code', 'userCode', 'user_code_text']);
    const verification_uri = mapValue(mapped, ['verification_uri', 'verification_url', 'verificationUri', 'verificationUrl']);
    const verification_uri_complete = mapValue(
      mapped,
      ['verification_uri_complete', 'verification_url_complete', 'verificationUriComplete', 'verificationUrlComplete']
    );
    const expires_in = Number(mapValue(mapped, ['expires_in', 'expiresIn'])) || 600;
    const interval = Number(mapValue(mapped, ['interval'])) || 5;

    if (!verification_uri && !verification_uri_complete) {
      const keys = mapped ? Object.keys(mapped).join(',') : '';
      throw new Error(`Device code JSON missing verification URL fields (keys present: ${keys})`);
    }
    if (!device_code || typeof device_code !== 'string') {
      throw new Error('Device code JSON missing device_code field');
    }

    // 友好提示
    console.log('Please visit the following URL to authorize the device:');
    console.log(verification_uri || verification_uri_complete);
    if (user_code) {
      console.log(`And enter the code: ${user_code}`);
    }
    if (verification_uri_complete) {
      console.log('Or visit directly:');
      console.log(verification_uri_complete);
    }

    const resolvedUserCode = typeof user_code === 'string' ? user_code : undefined;
    const resolvedVerificationUri = typeof verification_uri === 'string' ? verification_uri : undefined;
    let resolvedVerificationUriComplete =
      typeof verification_uri_complete === 'string' ? verification_uri_complete : undefined;

    // Qwen requires user_code/client in the authorize URL; ensure we keep/construct it.
    if (resolvedUserCode && resolvedVerificationUri) {
      const deviceUrl = String(this.config.endpoints.deviceCodeUrl || '');
      const isQwenDevice = deviceUrl.includes('chat.qwen.ai');
      if (isQwenDevice) {
        try {
          const url = new URL(resolvedVerificationUriComplete || resolvedVerificationUri);
          if (!url.searchParams.get('user_code')) {
            url.searchParams.set('user_code', resolvedUserCode);
          }
          if (!url.searchParams.get('client')) {
            url.searchParams.set('client', 'qwen-code');
          }
          resolvedVerificationUriComplete = url.toString();
        } catch {
          // Leave as-is when URL parsing fails.
        }
      }
    }

    const result: DeviceCodeData = {
      device_code,
      user_code: resolvedUserCode,
      verification_uri: resolvedVerificationUri,
      verification_uri_complete: resolvedVerificationUriComplete,
      expires_in,
      interval,
      code_verifier: codeVerifier
    };

    return result;
  }

  /**
   * 激活设备码流程
   */
  public async activate(deviceCodeData: DeviceCodeData, options: { openBrowser?: boolean } = {}): Promise<void> {
    const url = deviceCodeData.verification_uri_complete || deviceCodeData.verification_uri;
    const userCode = deviceCodeData.user_code;
    // 复用基类的跨平台打开逻辑（open/xdg-open/start），并打印URL与User Code
    await super.activateWithBrowser({ verificationUri: url, userCode, authUrl: url }, options);
  }

  /**
   * 轮询获取令牌
   */
  private async pollForToken(deviceCodeData: DeviceCodeData): Promise<DeviceCodeTokenResponse> {
    const maxAttempts = this.config.polling?.maxAttempts || 60;
    const interval =
      resolvePollingIntervalMs(deviceCodeData.interval) ??
      resolvePollingIntervalMs(this.config.polling?.interval) ??
      5000;
    const deviceCode = deviceCodeData.device_code;
    const codeVerifier: string | undefined = deviceCodeData.code_verifier;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }

      try {
        const formData = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.config.client.clientId,
          device_code: deviceCode
        });

        // Qwen 等提供商要求在轮询阶段携带 code_verifier（PKCE）
        if (this.config.features?.supportsPKCE && codeVerifier) {
          formData.append('code_verifier', codeVerifier);
        }

        // 添加客户端密钥（如果存在）
        if (this.config.client.clientSecret) {
          formData.append('client_secret', this.config.client.clientSecret);
        }

        const response = await this.makeRequest(this.config.endpoints.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: formData
        });

        if (response.ok) {
          try {
            return await response.json() as DeviceCodeTokenResponse;
          } catch {
            const t = await response.text().catch(() => '');
            const preview = (t || '').slice(0, 180);
            throw new Error(`Token endpoint did not return JSON (preview='${preview}')`);
          }
        }

        // 如果是授权待处理错误，继续轮询
        const errorData = await response.json().catch(() => ({}));
        if (errorData.error === 'authorization_pending') {
          logOAuthDebug(`[OAuth] Authorization pending... (${attempt + 1}/${maxAttempts})`);
          continue;
        }

        // 其他错误直接抛出
        throw await this.parseErrorResponse(response);

      } catch (error) {
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        console.warn(`Token request attempt ${attempt + 1} failed, retrying...`);
      }
    }

    throw new Error(`Device authorization timed out after ${maxAttempts} attempts`);
  }

  /**
   * 处理令牌后激活（如API密钥交换）
   */
  private async handlePostTokenActivation(tokenResponse: DeviceCodeTokenResponse): Promise<StoredToken> {
    const normalizeToken = (payload: StoredToken): StoredToken => {
      const expiresAt = Date.now() + (payload.expires_in * 1000);
      return {
        ...payload,
        expires_at: expiresAt,
        expired: new Date(expiresAt).toISOString(),
        expiry_date: expiresAt
      };
    };

    const enriched: StoredToken = { ...tokenResponse };

    if (this.config.features?.supportsApiKeyExchange && this.config.endpoints.userInfoUrl && tokenResponse.access_token) {
      try {
        const userInfoResponse = await this.makeRequest(
          `${this.config.endpoints.userInfoUrl}?accessToken=${encodeURIComponent(tokenResponse.access_token)}`,
          { method: 'GET' }
        );

        if (userInfoResponse.ok) {
          const userInfo = await userInfoResponse.json() as UserInfoPayload;
          const apiKey = typeof userInfo.apiKey === 'string'
            ? userInfo.apiKey
            : typeof userInfo.data?.apiKey === 'string'
              ? userInfo.data.apiKey
              : undefined;
          const email = typeof userInfo.data?.email === 'string'
            ? userInfo.data.email
            : typeof userInfo.data?.phone === 'string'
              ? userInfo.data.phone
              : undefined;

          if (apiKey?.trim()) {
            const trimmed = apiKey.trim();
            enriched.apiKey = trimmed;
            enriched.api_key = trimmed;
          }
          if (email?.trim()) {
            enriched.email = email.trim();
          }
        }
      } catch (error) {
        console.warn('Failed to fetch user info for API key:', error instanceof Error ? error.message : String(error));
      }
    }

    return normalizeToken(enriched);
  }

  /**
   * 刷新令牌
   */
  async refreshToken(refreshToken: string): Promise<StoredToken> {
    const configuredMaxAttempts = this.config.retry?.maxAttempts || 3;
    const tokenUrl = String(this.config.endpoints.tokenUrl || '').toLowerCase();
    const maxAttempts = tokenUrl.includes('iflow.cn/oauth/token') ? 1 : configuredMaxAttempts;
    let lastError: unknown;
    let abortedEarly = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoffMs = (this.config.retry?.backoffMs || 1000) * attempt;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }

      try {
        const formData = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.config.client.clientId
        });

        if (this.config.client.clientSecret) {
          formData.append('client_secret', this.config.client.clientSecret);
        }

        const response = await this.makeRequest(this.config.endpoints.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: formData
        });

        if (!response.ok) {
          throw await this.parseErrorResponse(response);
        }

        const tokenData = await response.json() as DeviceCodeTokenResponse;
        return await this.handlePostTokenActivation(tokenData);

      } catch (error) {
        lastError = error;
        const msg = formatOAuthErrorMessage(error);
        logOAuthDebug(`[OAuth] Token refresh attempt ${attempt + 1} failed: ${msg}`);
        if (isPermanentOAuthRefreshErrorMessage(msg)) {
          abortedEarly = true;
          break;
        }
      }
    }

    const lastMsg = formatOAuthErrorMessage(lastError);
    if (abortedEarly) {
      throw new Error(`Token refresh failed (permanent): ${lastMsg}`);
    }
    throw new Error(`Token refresh failed after ${maxAttempts} attempts: ${lastMsg}`);
  }

  /**
   * 验证令牌
   */
  validateToken(token: UnknownObject): boolean {
    const stored = this.coerceStoredToken(token);
    if (!stored) {
      return false;
    }

    // 检查必需字段
    if (!stored.access_token) {
      return false;
    }

    // 检查过期时间
    const expiresAt = stored.expires_at || stored.expired || stored.expiry_date;
    if (expiresAt) {
      const expiryDate = new Date(expiresAt);
      if (expiryDate <= new Date()) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取授权头部
   */
  getAuthHeader(token: UnknownObject): string {
    const tokenObj = this.ensureStoredToken(token);

    // 优先使用API密钥（如果存在）
    const apiKey = (tokenObj.apiKey || tokenObj.api_key || '').trim();
    if (apiKey) {
      return `Bearer ${apiKey}`;
    }

    const tokenType = tokenObj.token_type || 'Bearer';
    return `${tokenType} ${tokenObj.access_token}`;
  }

  /**
   * 保存令牌
   */
  async saveToken(token: UnknownObject): Promise<void> {
    const wrapper = token && typeof token === 'object' && typeof (token as Record<string, unknown>).token === 'object'
      ? (token as UnknownObject)
      : null;
    const stored = this.ensureStoredToken(wrapper ? (wrapper as Record<string, unknown>).token as UnknownObject : token);
    try {
      const dir = path.dirname(this.tokenFile);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.tokenFile, JSON.stringify(wrapper ?? stored, null, 2));
      this.tokenStorage = stored;
      logOAuthDebug(`[OAuth] [device_code] Token saved to: ${this.tokenFile}`);
    } catch (error) {
      console.error('Failed to save token:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 加载令牌
   */
  async loadToken(): Promise<UnknownObject | null> {
    try {
      const content = await fs.readFile(this.tokenFile, 'utf-8');
      const raw = JSON.parse(content) as UnknownObject;
      const token = this.coerceStoredToken(raw);
      this.tokenStorage = token;
      logOAuthDebug(`[OAuth] [device_code] Token loaded from: ${this.tokenFile}`);
      return token;
    } catch (error) {
      this.tokenStorage = null;
      return null;
    }
  }

  private coerceStoredToken(token: UnknownObject | null | undefined): StoredToken | null {
    if (!token || typeof token !== 'object') {
      return null;
    }
    const record = token as Record<string, unknown>;
    const candidate = record.token && typeof record.token === 'object'
      ? (record.token as Record<string, unknown>)
      : record;
    if (typeof candidate.access_token !== 'string' || typeof candidate.expires_in !== 'number') {
      return null;
    }
    return candidate as StoredToken;
  }

  private ensureStoredToken(token: UnknownObject): StoredToken {
    const stored = this.coerceStoredToken(token);
    if (!stored) {
      throw new Error('Invalid token payload for OAuth device code flow');
    }
    return stored;
  }
}

/**
 * 设备码流程策略工厂
 */
export class OAuthDeviceFlowStrategyFactory {
  createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy {
    return new OAuthDeviceFlowStrategy(config, httpClient, tokenFile);
  }

  getFlowType(): OAuthFlowType {
    return OAuthFlowType.DEVICE_CODE;
  }
}
