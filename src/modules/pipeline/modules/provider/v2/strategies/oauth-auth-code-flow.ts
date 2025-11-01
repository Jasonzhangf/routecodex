/**
 * OAuth授权码流程策略
 *
 * 实现标准的OAuth 2.0授权码流程，支持PKCE
 */

import type { UnknownObject } from '../../../../../../types/common-types.js';
import { BaseOAuthFlowStrategy, OAuthFlowType } from '../config/oauth-flows.js';
import type { OAuthFlowConfig } from '../config/oauth-flows.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { findOpenPort } from '../../../../utils/oauth-helpers.js';

/**
 * 授权码令牌响应
 */
interface AuthCodeTokenResponse {
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
 * OAuth授权码流程策略
 */
export class OAuthAuthCodeFlowStrategy extends BaseOAuthFlowStrategy {
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
   * 执行授权码认证流程
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

      // 3. 执行新的授权码认证流程
      console.log('Starting OAuth authorization code flow...');

      const authCodeData = await this.initiateAuthCodeFlow();
      await this.activate(authCodeData, options);
      const tokenResponse = await this.exchangeCodeForToken(authCodeData);

      // 4. 处理特殊激活（如API密钥交换）
      const finalToken = await this.handlePostTokenActivation(tokenResponse);

      // 5. 保存令牌
      await this.saveToken(finalToken);

      console.log('OAuth authorization code flow completed successfully!');
      return finalToken;

    } catch (error) {
      console.error('OAuth authorization code flow failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 初始化授权码流程
   */
  private async initiateAuthCodeFlow(): Promise<UnknownObject> {
    if (!this.config.endpoints.authorizationUrl) {
      throw new Error('Authorization URL is required for authorization code flow');
    }

    if (!this.config.client.redirectUri) {
      throw new Error('Redirect URI is required for authorization code flow');
    }

    const { codeVerifier, codeChallenge } = this.generatePKCEPair();
    const state = this.generateState();

    const authUrl = new URL(this.config.endpoints.authorizationUrl);

    // 标准OAuth2参数
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', this.config.client.clientId);
    authUrl.searchParams.set('redirect_uri', this.config.client.redirectUri);
    authUrl.searchParams.set('scope', this.config.client.scopes.join(' '));
    authUrl.searchParams.set('state', state);

    // 添加PKCE参数（如果支持）
    if (this.config.features?.supportsPKCE) {
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    }

    return {
      authUrl: authUrl.toString(),
      state,
      codeVerifier,
      codeChallenge
    };
  }

  /**
   * 启动本地HTTP服务器接收回调
   */
  private async startCallbackServer(state: string, codeVerifier: string): Promise<{
    callbackPromise: Promise<{ code: string; verifier: string }>;
    redirectUri: string;
  }> {
    const http = await import('http');
    const url = await import('url');

    // 查找可用端口
    const port = await findOpenPort();
    const host = process.env.OAUTH_CALLBACK_HOST || 'localhost';

    const callbackPromise = new Promise<{ code: string; verifier: string }>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          if (!req.url || !req.url.includes('/oauth2callback')) {
            res.statusCode = 302;
            res.setHeader('Location', 'https://example.com');
            res.end();
            reject(new Error(`Unexpected request: ${req.url}`));
            return;
          }

          const params = new url.URL(req.url, `http://${host}:${port}`).searchParams;

          // 检查错误
          const error = params.get('error');
          if (error) {
            res.statusCode = 302;
            res.setHeader('Location', 'https://example.com');
            res.end();
            reject(new Error(`Authorization error: ${error}`));
            return;
          }

          // 验证状态参数
          const receivedState = params.get('state');
          if (receivedState !== state) {
            res.statusCode = 400;
            res.end('State mismatch. Possible CSRF attack');
            reject(new Error('State mismatch. Possible CSRF attack'));
            return;
          }

          // 获取授权码
          const code = params.get('code');
          if (!code) {
            res.statusCode = 400;
            res.end('No authorization code found');
            reject(new Error('No authorization code found'));
            return;
          }

          // 成功响应
          res.statusCode = 302;
          res.setHeader('Location', 'https://example.com');
          res.end();

          resolve({ code, verifier: codeVerifier });

        } catch (error) {
          try {
            res.statusCode = 500;
            res.end('Authentication failed');
          } catch {
            // Response might already be closed
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          server.close();
        }
      });

      server.listen(port, host);
    });

    // 更新重定向URI
    const redirectUri = `http://${host}:${port}/oauth2callback`;

    return { callbackPromise, redirectUri };
  }

  /**
   * 交换授权码获取令牌
   */
  private async exchangeCodeForToken(authCodeData: UnknownObject): Promise<AuthCodeTokenResponse> {
    const data = authCodeData as any;

    // 如果还没有启动回调服务器，启动它
    if (!data.code) {
      const serverResult = await this.startCallbackServer(data.state, data.codeVerifier);

      // 更新授权URL中的重定向URI
      const authUrl = new URL(data.authUrl);
      authUrl.searchParams.set('redirect_uri', serverResult.redirectUri);
      data.authUrl = authUrl.toString();

      // 等待回调
      const callbackResult = await serverResult.callbackPromise;
      data.code = callbackResult.code;
      data.codeVerifier = callbackResult.verifier;
    }

    const formData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: data.code,
      redirect_uri: this.config.client.redirectUri!,
      client_id: this.config.client.clientId
    });

    // 添加PKCE验证器（如果支持）
    if (this.config.features?.supportsPKCE && data.codeVerifier) {
      formData.append('code_verifier', data.codeVerifier);
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

    if (!response.ok) {
      throw await this.parseErrorResponse(response);
    }

    return await response.json() as AuthCodeTokenResponse;
  }

  /**
   * 生成状态参数
   */
  private generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * 处理令牌后激活（如API密钥交换）
   */
  private async handlePostTokenActivation(tokenResponse: AuthCodeTokenResponse): Promise<UnknownObject> {
    if (!this.config.features?.supportsApiKeyExchange) {
      return tokenResponse as unknown as UnknownObject;
    }

    // 尝试获取API密钥（如果有用户信息端点）
    if (this.config.endpoints.userInfoUrl && tokenResponse.access_token) {
      try {
        const userInfoResponse = await this.makeRequest(
          `${this.config.endpoints.userInfoUrl}?accessToken=${encodeURIComponent(tokenResponse.access_token)}`,
          { method: 'GET' }
        );

        if (userInfoResponse.ok) {
          const userInfo = await userInfoResponse.json();
          if ((userInfo as any).apiKey) {
            (tokenResponse as any).apiKey = (userInfo as any).apiKey;
          }
        }
      } catch (error) {
        console.warn('Failed to fetch user info for API key:', error instanceof Error ? error.message : String(error));
      }
    }

    // 转换为标准格式
    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    return {
      ...tokenResponse,
      expires_at: expiresAt,
      expired: new Date(expiresAt).toISOString()
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

        const tokenData = await response.json() as AuthCodeTokenResponse;

        // 转换为标准格式
        const expiresAt = Date.now() + (tokenData.expires_in * 1000);
        return {
          ...tokenData,
          expires_at: expiresAt,
          expired: new Date(expiresAt).toISOString()
        } as UnknownObject;

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
    const expiresAt = tokenObj.expires_at || tokenObj.expired;
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
    if (tokenObj.apiKey && tokenObj.apiKey.trim()) {
      return `Bearer ${tokenObj.apiKey}`;
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
      return token;
    } catch (error) {
      this.tokenStorage = null;
      return null;
    }
  }
}

/**
 * 授权码流程策略工厂
 */
export class OAuthAuthCodeFlowStrategyFactory {
  createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch): BaseOAuthFlowStrategy {
    return new OAuthAuthCodeFlowStrategy(config, httpClient);
  }

  getFlowType(): OAuthFlowType {
    return OAuthFlowType.AUTHORIZATION_CODE;
  }
}