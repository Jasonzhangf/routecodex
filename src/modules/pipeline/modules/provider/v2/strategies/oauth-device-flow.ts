/**
 * OAuth设备码流程策略
 *
 * 实现标准的OAuth 2.0设备码流程
 */

import type { UnknownObject } from '../../../../../../types/common-types.js';
import { BaseOAuthFlowStrategy, OAuthFlowType } from '../config/oauth-flows.js';
import type { OAuthFlowConfig } from '../config/oauth-flows.js';
import fs from 'fs/promises';
import path from 'path';

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

/**
 * OAuth设备码流程策略
 */
export class OAuthDeviceFlowStrategy extends BaseOAuthFlowStrategy {
  private tokenFile: string;
  private tokenStorage: UnknownObject | null = null;

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
  async authenticate(options: { openBrowser?: boolean } = {}): Promise<UnknownObject> {
    try {
      // 1. 尝试加载现有令牌
      const existingToken = await this.loadToken();
      if (existingToken && this.validateToken(existingToken)) {
        console.log('Using existing valid token');
        return existingToken;
      }

      // 2. 如果令牌过期但可以刷新，则尝试刷新
      if (existingToken && (existingToken as any).refresh_token) {
        try {
          console.log('Token expired, attempting refresh...');
          const refreshedToken = await this.refreshToken((existingToken as any).refresh_token);
          await this.saveToken(refreshedToken);
          console.log('Token refreshed successfully');
          return refreshedToken;
        } catch (error) {
          console.warn('Token refresh failed, initiating new authentication:', error instanceof Error ? error.message : String(error));
        }
      }

      // 3. 执行新的设备码认证流程
      console.log('Starting OAuth device code flow...');

      const deviceCodeData = await this.initiateDeviceCodeFlow();
      await this.activate(deviceCodeData, options);
      const tokenResponse = await this.pollForToken(deviceCodeData);

      // 4. 处理特殊激活（如API密钥交换）
      const finalToken = await this.handlePostTokenActivation(tokenResponse);

      // 5. 保存令牌
      await this.saveToken(finalToken);

      console.log('OAuth device code flow completed successfully!');
      return finalToken;

    } catch (error) {
      console.error('OAuth device code flow failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 初始化设备码流程
   */
  private async initiateDeviceCodeFlow(): Promise<UnknownObject> {
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
    let raw: any;
    try {
      raw = await response.json();
    } catch {
      const text = await response.text().catch(() => '');
      const preview = (text || '').slice(0, 180);
      throw new Error(`Device code endpoint did not return JSON (preview='${preview}')`);
    }

    const dbgEnabled = String(process.env.ROUTECODEX_OAUTH_DEBUG || '1') === '1';
    if (dbgEnabled) {
      try { console.log(`[OAuth] device-code raw: ${JSON.stringify(raw).slice(0, 512)}`); } catch { /* ignore */ }
    }

    // 兼容多种形状（顶层/ data / result；蛇形/驼峰；uri/url）
    const d = (raw && typeof raw === 'object' && (raw.data || raw.result)) ? (raw.data || raw.result) : raw;
    const map = (obj: any, keys: string[]): any => {
      for (const k of keys) {
        if (obj && typeof obj === 'object' && obj[k] != null) return obj[k];
      }
      return undefined;
    };

    const device_code = map(d, ['device_code', 'deviceCode', 'deviceCodeId']);
    const user_code = map(d, ['user_code', 'userCode', 'user_code_text']);
    const verification_uri = map(d, ['verification_uri', 'verification_url', 'verificationUri', 'verificationUrl']);
    const verification_uri_complete = map(d, ['verification_uri_complete', 'verification_url_complete', 'verificationUriComplete', 'verificationUrlComplete']);
    const expires_in = Number(map(d, ['expires_in', 'expiresIn'])) || 600;
    const interval = Number(map(d, ['interval'])) || 5;

    if (!verification_uri && !verification_uri_complete) {
      throw new Error(`Device code JSON missing verification URL fields (keys present: ${Object.keys(d || {}).join(',')})`);
    }
    if (!device_code) {
      throw new Error('Device code JSON missing device_code field');
    }

    // 友好提示
    console.log('Please visit the following URL to authorize the device:');
    console.log(verification_uri || verification_uri_complete);
    if (user_code) console.log(`And enter the code: ${user_code}`);
    if (verification_uri_complete) {
      console.log('Or visit directly:');
      console.log(verification_uri_complete);
    }

    const result: any = {
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete,
      expires_in,
      interval
    };

    if (codeVerifier) {
      result.code_verifier = codeVerifier;
    }

    return result as UnknownObject;
  }

  /**
   * 激活设备码流程
   */
  public async activate(deviceCodeData: UnknownObject, options: { openBrowser?: boolean } = {}): Promise<void> {
    const url = (deviceCodeData as any).verification_uri_complete || (deviceCodeData as any).verification_uri;
    const userCode = (deviceCodeData as any).user_code;
    // 复用基类的跨平台打开逻辑（open/xdg-open/start），并打印URL与User Code
    await super.activateWithBrowser({ verificationUri: url, userCode, authUrl: url } as any, options);
  }

  /**
   * 轮询获取令牌
   */
  private async pollForToken(deviceCodeData: UnknownObject): Promise<DeviceCodeTokenResponse> {
    const maxAttempts = this.config.polling?.maxAttempts || 60;
    const interval = (this.config.polling?.interval || 5) * 1000;
    const deviceCode = (deviceCodeData as any).device_code;
    const codeVerifier: string | undefined = (deviceCodeData as any).code_verifier;

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
          console.log(`Authorization pending... (${attempt + 1}/${maxAttempts})`);
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
  private async handlePostTokenActivation(tokenResponse: DeviceCodeTokenResponse): Promise<UnknownObject> {
    // 统一补标准过期字段，方便 validate 使用
    const computeStandardShape = (payload: DeviceCodeTokenResponse & { apiKey?: string; api_key?: string; email?: string }): UnknownObject => {
      const expiresAt = Date.now() + (payload.expires_in * 1000);
      return {
        ...payload,
        expires_at: expiresAt,
        expired: new Date(expiresAt).toISOString(),
        expiry_date: expiresAt
      } as UnknownObject;
    };

    if (!this.config.features?.supportsApiKeyExchange) {
      return computeStandardShape(tokenResponse);
    }

    const enriched: DeviceCodeTokenResponse & { apiKey?: string; api_key?: string; email?: string } = { ...tokenResponse };

    // 尝试获取API密钥（如果有用户信息端点）
    if (this.config.endpoints.userInfoUrl && tokenResponse.access_token) {
      try {
        const userInfoResponse = await this.makeRequest(
          `${this.config.endpoints.userInfoUrl}?accessToken=${encodeURIComponent(tokenResponse.access_token)}`,
          { method: 'GET' }
        );

        if (userInfoResponse.ok) {
          const userInfo = await userInfoResponse.json();
          const root: any = userInfo;
          let apiKey: string | undefined;
          let email: string | undefined;

          if (root && typeof root.apiKey === 'string') {
            apiKey = root.apiKey;
          } else if (root && typeof root.data === 'object' && root.data) {
            const data = root.data as any;
            if (typeof data.apiKey === 'string') {
              apiKey = data.apiKey;
            }
            if (typeof data.email === 'string') {
              email = data.email;
            } else if (typeof data.phone === 'string') {
              email = data.phone;
            }
          }

          if (apiKey && apiKey.trim()) {
            enriched.apiKey = apiKey.trim();
            // 兼容 CLIProxyAPI 的字段命名
            enriched.api_key = apiKey.trim();
          }
          if (email && email.trim()) {
            enriched.email = email.trim();
          }
        }
      } catch (error) {
        console.warn('Failed to fetch user info for API key:', error instanceof Error ? error.message : String(error));
      }
    }

    return {
      ...computeStandardShape(enriched)
    } as UnknownObject;
  }

  /**
   * 刷新令牌
   */
  async refreshToken(refreshToken: string): Promise<UnknownObject> {
    const maxAttempts = this.config.retry?.maxAttempts || 3;
    let lastError: unknown;

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

        // 转换为标准格式并尝试补全 apiKey（对齐 iflow 行为）
        const expiresAt = Date.now() + (tokenData.expires_in * 1000);
        const base: UnknownObject = {
          ...tokenData,
          expires_at: expiresAt,
          expired: new Date(expiresAt).toISOString()
        } as UnknownObject;
        const finalToken = await this.handlePostTokenActivation(base as any);
        return finalToken;

      } catch (error) {
        lastError = error;
        console.warn(`Token refresh attempt ${attempt + 1} failed:`, error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(`Token refresh failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /**
   * 验证令牌
   */
  validateToken(token: UnknownObject): boolean {
    if (!token || typeof token !== 'object') {
      return false;
    }

    const tokenObj = token as any;

    // 检查必需字段
    if (!tokenObj.access_token) {
      return false;
    }

    // 检查过期时间
    const expiresAt = tokenObj.expires_at || tokenObj.expired || tokenObj.expiry_date;
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
    const tokenObj = token as any;

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
    try {
      const dir = path.dirname(this.tokenFile);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.tokenFile, JSON.stringify(token, null, 2));
      this.tokenStorage = token;
      console.log(`[OAuth] [device_code] Token saved to: ${this.tokenFile}`);
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
      const token = JSON.parse(content) as UnknownObject;
      this.tokenStorage = token;
      console.log(`[OAuth] [device_code] Token loaded from: ${this.tokenFile}`);
      return token;
    } catch (error) {
      this.tokenStorage = null;
      return null;
    }
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
