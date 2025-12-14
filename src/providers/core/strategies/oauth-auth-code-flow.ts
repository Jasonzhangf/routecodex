/**
 * OAuth授权码流程策略
 *
 * 实现标准的OAuth 2.0授权码流程，支持PKCE
 */
import type { UnknownObject } from '../../../types/common-types.js';
import { BaseOAuthFlowStrategy, OAuthFlowType } from '../config/oauth-flows.js';
import type { OAuthFlowConfig } from '../config/oauth-flows.js';
import fs from 'fs/promises';
import path from 'path';
import { logOAuthDebug } from '../../auth/oauth-logger.js';
import crypto from 'crypto';

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

type FlowStyle = 'web' | 'standard' | 'legacy';

interface AuthCodeFlowState extends Record<string, unknown> {
  authUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  flowStyle: FlowStyle;
  redirectUri?: string;
  code?: string;
}

type UserInfoPayload = {
  apiKey?: string;
  data?: {
    apiKey?: string;
    email?: string;
    phone?: string;
  };
} & Record<string, unknown>;

type StoredToken = UnknownObject & AuthCodeTokenResponse & {
  api_key?: string;
  email?: string;
  expires_at?: number;
  expired?: string;
};

const normalizeFlowStyle = (value: string | undefined, fallback: FlowStyle): FlowStyle => {
  if (value === 'web' || value === 'standard' || value === 'legacy') {
    return value;
  }
  return fallback;
};

/**
 * OAuth授权码流程策略
 */
export class OAuthAuthCodeFlowStrategy extends BaseOAuthFlowStrategy {
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
   * 执行授权码认证流程
   */
  async authenticate(options: { openBrowser?: boolean } = {}): Promise<UnknownObject> {
    try {
      // 1. 尝试加载现有令牌
      const existingToken = this.coerceStoredToken(await this.loadToken());
      if (existingToken && this.validateToken(existingToken)) {
        logOAuthDebug('[OAuth] Using existing valid token');
        return existingToken;
      }

      // 2. 如果令牌过期但可以刷新，则尝试刷新
      if (existingToken?.refresh_token) {
        try {
          logOAuthDebug('[OAuth] Token expired, attempting refresh...');
          const refreshedTokenRaw = await this.refreshToken(existingToken.refresh_token);
          const refreshedToken = this.ensureStoredToken(refreshedTokenRaw);
          await this.saveToken(refreshedToken);
          logOAuthDebug('[OAuth] Token refreshed successfully');
          return refreshedToken;
        } catch (error) {
          console.warn('Token refresh failed, initiating new authentication:', error instanceof Error ? error.message : String(error));
        }
      }

      // 3. 执行新的授权码认证流程（先启动本地回调服务，再打开浏览器）
      logOAuthDebug('[OAuth] Starting OAuth authorization code flow...');

      const authCodeData = await this.initiateAuthCodeFlow();

      // 3.1 启动本地回调服务（固定 localhost:8080，路径 /oauth2callback）
      const serverResult = await this.startCallbackServer(authCodeData.state, authCodeData.codeVerifier);

      // 3.2 更新授权URL中的重定向参数（与本地回调服务一致），再打开浏览器
      try {
        const urlObj = new URL(authCodeData.authUrl);
        const style = authCodeData.flowStyle;
        if (style === 'web' || style === 'legacy') {
          // iflow web 登录样式：redirect=<redirectUri> & state=<state>
          // 由 URLSearchParams 负责一次性编码，避免双重编码；state 保持独立参数
          urlObj.searchParams.set('redirect', serverResult.redirectUri);
        } else {
          urlObj.searchParams.set('redirect_uri', serverResult.redirectUri);
        }
        authCodeData.authUrl = urlObj.toString();
        authCodeData.redirectUri = serverResult.redirectUri;
      } catch { /* ignore */ }

      await this.activate(authCodeData, options);

      // 3.3 等待回调，获取授权码
      try {
        const cb = await serverResult.callbackPromise;
        authCodeData.code = cb.code;
        authCodeData.codeVerifier = cb.verifier;
      } catch (err) {
        console.error('OAuth authorization callback error:', err instanceof Error ? err.message : String(err));
        throw err;
      }

      // 3.4 交换令牌
      const tokenResponse = await this.exchangeCodeForToken(authCodeData);

      // 4. 处理特殊激活（如API密钥交换）
      const finalToken = await this.handlePostTokenActivation(tokenResponse);

      // 5. 保存令牌
      await this.saveToken(finalToken);

      logOAuthDebug('[OAuth] OAuth authorization code flow completed successfully!');
      return finalToken;

    } catch (error) {
      console.error('OAuth authorization code flow failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 初始化授权码流程
   */
  private async initiateAuthCodeFlow(): Promise<AuthCodeFlowState> {
    if (!this.config.endpoints.authorizationUrl) {
      throw new Error('Authorization URL is required for authorization code flow');
    }

    if (!this.config.client.redirectUri) {
      throw new Error('Redirect URI is required for authorization code flow');
    }

    const { codeVerifier, codeChallenge } = this.generatePKCEPair();
    const state = this.generateState();
    const authUrl = new URL(this.config.endpoints.authorizationUrl);
    const isIflowHost = /(?:^|\.)iflow\.cn$/.test(authUrl.hostname);
    const styleEnv = (process.env.IFLOW_AUTH_STYLE || '').toLowerCase();
    const style: FlowStyle = isIflowHost
      ? normalizeFlowStyle(styleEnv, 'web')
      : styleEnv === 'legacy'
        ? 'legacy'
        : 'standard';

    if (style === 'web') {
      // 对齐你粘贴的 iflow 页面 URL：loginMethod=phone&type=phone&redirect=<encoded(redirectUri)>&state=<state>&client_id=...
      const redirectUri = this.config.client.redirectUri!;
      authUrl.searchParams.set('loginMethod', 'phone');
      authUrl.searchParams.set('type', 'phone');
      authUrl.searchParams.set('redirect', encodeURIComponent(redirectUri));
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('client_id', this.config.client.clientId);
      // 可选：保留 PKCE 参数（服务端可能忽略）
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    } else if (style === 'legacy') {
      // 老式 iflow Web 登录参数（state 融合在 redirect），兼容历史
      const redirectUri = this.config.client.redirectUri!;
      authUrl.searchParams.set('loginMethod', 'phone');
      authUrl.searchParams.set('type', 'phone');
      authUrl.searchParams.set('redirect', `${encodeURIComponent(redirectUri)}&state=${state}`);
      authUrl.searchParams.set('client_id', this.config.client.clientId);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    } else {
      // 标准 OAuth2 授权码样式
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', this.config.client.clientId);
      authUrl.searchParams.set('redirect_uri', this.config.client.redirectUri!);
      authUrl.searchParams.set('scope', this.config.client.scopes.join(' '));
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    }

    // 记录样式供后续交换 token 逻辑使用
    const flowStyle = style;
    const flowState: AuthCodeFlowState = {
      authUrl: authUrl.toString(),
      state,
      codeVerifier,
      codeChallenge,
      flowStyle
    };
    return flowState;
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

    // 固定为 localhost:8080/oauth2callback（与 iflow CLI 一致）
    const configured = this.config.client.redirectUri;
    let host = 'localhost';
    let port: number = 8080;
    let pathName = '/oauth2callback';
    try {
      if (configured) {
        const u = new URL(configured);
        host = u.hostname || host;
        const parsedPort = Number(u.port || '');
        if (Number.isFinite(parsedPort) && parsedPort > 0) {
          port = parsedPort;
        }
        pathName = u.pathname || pathName;
      }
    } catch { /* ignore parsing errors */ }

    const callbackPromise = new Promise<{ code: string; verifier: string }>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const full = new url.URL(req.url || '/', `http://${host}:${port}`);
          const reqPath = full.pathname || '';
          const okPath = reqPath === pathName || /oauth.*callback/i.test(reqPath);
          if (!req.url || !okPath) {
            res.statusCode = 302;
            res.setHeader('Location', 'https://example.com');
            res.end();
            reject(new Error(`Unexpected request: ${req.url}`));
            return;
          }

          const params = full.searchParams;

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

          logOAuthDebug('[OAuth] Received authorization code via local callback');
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

    // 更新重定向URI（使用配置中的路径或默认）
    const redirectUri = `http://${host}:${port}${pathName}`;
    logOAuthDebug(`[OAuth] Starting local callback server at ${redirectUri}`);

    return { callbackPromise, redirectUri };
  }

  /**
   * 交换授权码获取令牌
   */
  private async exchangeCodeForToken(authCodeData: AuthCodeFlowState): Promise<AuthCodeTokenResponse> {
    const data = authCodeData;

    // 如果还没有启动回调服务器，启动它
    if (!data.code) {
      const serverResult = await this.startCallbackServer(data.state, data.codeVerifier);

      // 更新授权URL中的重定向参数
      const authUrl = new URL(data.authUrl);
      if (data.flowStyle === 'web' || data.flowStyle === 'legacy') {
        // 由 URLSearchParams 统一编码，不手动 encodeURIComponent，避免双重编码
        authUrl.searchParams.set('redirect', serverResult.redirectUri);
      } else {
        authUrl.searchParams.set('redirect_uri', serverResult.redirectUri);
      }
      data.authUrl = authUrl.toString();
      data.redirectUri = serverResult.redirectUri;

      // 等待回调
      const callbackResult = await serverResult.callbackPromise;
      data.code = callbackResult.code;
      data.codeVerifier = callbackResult.verifier;
    }

    const redirectUri = data.redirectUri ?? this.config.client.redirectUri;
    if (!data.code || !redirectUri) {
      throw new Error('Authorization code or redirect URI missing during token exchange');
    }

    const formData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: data.code,
      redirect_uri: redirectUri,
      client_id: this.config.client.clientId
    });

    // 添加PKCE验证器（如果支持）：web/legacy 不添加 code_verifier
    if (this.config.features?.supportsPKCE && data.codeVerifier && data.flowStyle !== 'web' && data.flowStyle !== 'legacy') {
      formData.append('code_verifier', data.codeVerifier);
    }

    // 添加客户端密钥（如果存在）
    if (this.config.client.clientSecret) {
      formData.append('client_secret', this.config.client.clientSecret);
    }

    // iflow web 登录样式常用 Basic(client_id:client_secret)
    const tokenHeaders: Record<string,string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.config.client.clientSecret) {
      const basic = Buffer.from(`${this.config.client.clientId}:${this.config.client.clientSecret}`).toString('base64');
      tokenHeaders['Authorization'] = `Basic ${basic}`;
    }
    const response = await this.makeRequest(this.config.endpoints.tokenUrl, {
      method: 'POST',
      headers: tokenHeaders,
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
  private async handlePostTokenActivation(tokenResponse: AuthCodeTokenResponse): Promise<StoredToken> {
    const enrichedToken: StoredToken = { ...tokenResponse };

    // 尝试获取API密钥（如果有用户信息端点）
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
            enrichedToken.apiKey = trimmed;
            enrichedToken.api_key = trimmed; // 兼容 CLIProxyAPI 的字段命名
          }
          if (email?.trim()) {
            enrichedToken.email = email.trim();
          }
        }
      } catch (error) {
        console.warn('Failed to fetch user info for API key:', error instanceof Error ? error.message : String(error));
      }
    }

    // 转换为标准格式
    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    enrichedToken.expires_at = expiresAt;
    enrichedToken.expired = new Date(expiresAt).toISOString();
    return enrichedToken;
  }

  private coerceStoredToken(token: UnknownObject | null | undefined): StoredToken | null {
    if (!token || typeof token !== 'object') {
      return null;
    }
    const record = token as Record<string, unknown>;
    if (typeof record.access_token === 'string' && typeof record.expires_in === 'number') {
      return token as StoredToken;
    }
    return null;
  }

  private ensureStoredToken(token: UnknownObject): StoredToken {
    const stored = this.coerceStoredToken(token);
    if (!stored) {
      throw new Error('Invalid token payload for OAuth authorization code flow');
    }
    return stored;
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
        return await this.handlePostTokenActivation(tokenData);

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
    const stored = this.coerceStoredToken(token);
    if (!stored) {
      return false;
    }
    const expiresAt = stored.expires_at || stored.expired;
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
    const stored = this.ensureStoredToken(token);
    try {
      const dir = path.dirname(this.tokenFile);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.tokenFile, JSON.stringify(stored, null, 2));
      this.tokenStorage = stored;
      logOAuthDebug(`[OAuth] [auth_code] Token saved to: ${this.tokenFile}`);
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
      const stored = this.coerceStoredToken(token);
      this.tokenStorage = stored;
      logOAuthDebug(`[OAuth] [auth_code] Token loaded from: ${this.tokenFile}`);
      return stored;
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
  createStrategy(config: OAuthFlowConfig, httpClient?: typeof fetch, tokenFile?: string): BaseOAuthFlowStrategy {
    return new OAuthAuthCodeFlowStrategy(config, httpClient, tokenFile);
  }

  getFlowType(): OAuthFlowType {
    return OAuthFlowType.AUTHORIZATION_CODE;
  }
}
