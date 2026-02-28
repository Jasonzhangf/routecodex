/**
 * OAuth授权码流程策略
 *
 * 实现标准的OAuth 2.0授权码流程，支持PKCE
 */
import type { UnknownObject } from '../../../types/common-types.js';
import { BaseOAuthFlowStrategy, OAuthFlowType } from '../config/oauth-flows.js';
import type { OAuthFlowConfig } from '../config/oauth-flows.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { logOAuthDebug } from '../../auth/oauth-logger.js';
import { formatOAuthErrorMessage } from '../../auth/oauth-error-message.js';
import crypto from 'crypto';
import { isPermanentOAuthRefreshErrorMessage } from './oauth-refresh-errors.js';

/**
 * 授权码令牌响应
 */
interface AuthCodeTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number | string;
  expiresIn?: number | string;
  expires?: number | string;
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

function resolveGoogleUiLanguageHint(): string | null {
  const raw = String(
    process.env.ROUTECODEX_OAUTH_GOOGLE_HL ||
      process.env.RCC_OAUTH_GOOGLE_HL ||
      'en'
  ).trim();
  if (!raw) {
    return null;
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'auto' || lowered === 'off' || lowered === 'none' || lowered === '0' || lowered === 'false') {
    return null;
  }
  return raw;
}

function isTruthyFlag(value: string | undefined): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const normalizeFlowStyle = (value: string | undefined, fallback: FlowStyle): FlowStyle => {
  if (value === 'web' || value === 'standard' || value === 'legacy') {
    return value;
  }
  return fallback;
};

function resolveCallbackTimeoutMs(isIflowOAuth: boolean): number {
  const envRaw = String(process.env.ROUTECODEX_OAUTH_CALLBACK_TIMEOUT_MS || '').trim();
  const parsed = Number.parseInt(envRaw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim().toLowerCase();
  const headful = isTruthyFlag(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE);
  if (isIflowOAuth && autoMode === 'iflow' && !headful) {
    // Automatic iFlow auth should fail fast and retry, instead of hanging for 10 minutes.
    return 90_000;
  }
  return 10 * 60 * 1000;
}

function shouldAllowLenientStateCallback(): boolean {
  const overrideRaw = String(process.env.ROUTECODEX_OAUTH_LENIENT_STATE || process.env.RCC_OAUTH_LENIENT_STATE || '').trim();
  if (overrideRaw) {
    return isTruthyFlag(overrideRaw);
  }
  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
  const headful = isTruthyFlag(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE);
  return autoMode.length > 0 && headful;
}

function publishInteractiveLockCallbackPort(port: number): void {
  const lockFile = String(process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE || '').trim();
  if (!lockFile || !Number.isFinite(port) || port <= 0) {
    return;
  }
  try {
    if (!fsSync.existsSync(lockFile)) {
      return;
    }
    const raw = fsSync.readFileSync(lockFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const node = parsed as Record<string, unknown>;
    if (typeof node.pid !== 'number' || node.pid !== process.pid) {
      return;
    }
    node.callbackPort = port;
    node.updatedAt = Date.now();
    fsSync.writeFileSync(lockFile, `${JSON.stringify(node, null, 2)}\n`, 'utf8');
  } catch {
    // non-fatal
  }
}

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
      // Avoid unhandled rejection when callback promise settles after early activate failure.
      void serverResult.callbackPromise.catch(() => {});

      // 3.2 更新授权URL中的重定向参数（与本地回调服务一致），再打开浏览器
      try {
        const urlObj = new URL(authCodeData.authUrl);
        this.applyAuthRedirectParams(urlObj, authCodeData.flowStyle, serverResult.redirectUri, authCodeData.state);
        authCodeData.authUrl = urlObj.toString();
        authCodeData.redirectUri = serverResult.redirectUri;
      } catch { /* ignore */ }

      const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
      const devMode = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '').trim();
      const camoufoxHeadfulAuto = autoMode.length > 0 && devMode.length > 0;
      let activateFailed: unknown = null;
      try {
        await this.activate(authCodeData, options);
      } catch (activateError) {
        activateFailed = activateError;
        if (!camoufoxHeadfulAuto) {
          await this.abortPendingCallbackServer(serverResult.redirectUri, 'browser_launch_failed');
          throw activateError;
        }
        const msg = activateError instanceof Error ? activateError.message : String(activateError);
        console.warn(`[OAuth] Camoufox automation failed in headful mode; keep callback server alive for manual recovery: ${msg}`);
      }

      // 3.3 等待回调，获取授权码
      try {
        const cb = await serverResult.callbackPromise;
        authCodeData.code = cb.code;
        authCodeData.codeVerifier = cb.verifier;
      } catch (err) {
        console.error('OAuth authorization callback error:', err instanceof Error ? err.message : String(err));
        if (activateFailed) {
          throw activateFailed instanceof Error ? activateFailed : new Error(String(activateFailed));
        }
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
    const hostname = authUrl.hostname;
    const isIflowHost = /(?:^|\.)iflow\.cn$/.test(hostname);
    const isGoogleOAuthHost = /(?:^|\.)accounts\.google\.com$/i.test(hostname);
    const googleUiLanguage = resolveGoogleUiLanguageHint();
    if (isGoogleOAuthHost && googleUiLanguage) {
      authUrl.searchParams.set('hl', googleUiLanguage);
    }
    const styleEnv = (process.env.IFLOW_AUTH_STYLE || '').toLowerCase();
    const style: FlowStyle = isIflowHost
      // iFlow default should stay on web-style redirect/state split:
      // redirect=<callback>&state=<state>&client_id=...
      // legacy format is still available via IFLOW_AUTH_STYLE=legacy.
      ? normalizeFlowStyle(styleEnv, 'web')
      : styleEnv === 'legacy'
        ? 'legacy'
        : 'standard';

    if (style === 'web') {
      // iflow web 风格：redirect 为原始回调 URL，state 顶层参数。
      const redirectUri = this.config.client.redirectUri!;
      authUrl.searchParams.set('loginMethod', 'phone');
      authUrl.searchParams.set('type', 'phone');
      authUrl.searchParams.set('redirect', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('client_id', this.config.client.clientId);
    } else if (style === 'legacy') {
      // 老式 iflow Web 登录参数（state 融合在 redirect），兼容历史
      const redirectUri = this.config.client.redirectUri!;
      authUrl.searchParams.set('loginMethod', 'phone');
      authUrl.searchParams.set('type', 'phone');
      authUrl.searchParams.set('redirect', `${encodeURIComponent(redirectUri)}&state=${state}`);
      authUrl.searchParams.set('client_id', this.config.client.clientId);
    } else {
      // 标准 OAuth2 授权码样式
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', this.config.client.clientId);
      authUrl.searchParams.set('redirect_uri', this.config.client.redirectUri!);
      authUrl.searchParams.set('scope', this.config.client.scopes.join(' '));
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      const wantsOfflineAccess =
        this.config.features?.requestOfflineAccess === true || isGoogleOAuthHost;
      if (wantsOfflineAccess) {
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('include_granted_scopes', 'true');
      }
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

    // 回调路径固定为 /oauth2callback；监听地址放宽为所有本地地址，
    // 避免 localhost 在 IPv4/IPv6 解析差异时出现连接拒绝。
    const configured = this.config.client.redirectUri;
    let redirectHost = 'localhost';
    let port: number = 8080;
    let pathName = '/oauth2callback';
    try {
      if (configured) {
        const u = new URL(configured);
        redirectHost = u.hostname || redirectHost;
        const parsedPort = Number(u.port || '');
        if (Number.isFinite(parsedPort) && parsedPort > 0) {
          port = parsedPort;
        }
        pathName = u.pathname || pathName;
      }
    } catch { /* ignore parsing errors */ }

    const envPortRaw = String(process.env.OAUTH_CALLBACK_PORT || '').trim();
    if (this.isIflowOAuthProvider() && !envPortRaw) {
      // Align with official iFlow CLI: choose ephemeral callback port by default.
      port = 0;
    }
    if (envPortRaw) {
      const parsedEnvPort = Number(envPortRaw);
      if (!Number.isFinite(parsedEnvPort) || parsedEnvPort <= 0 || parsedEnvPort > 65535) {
        throw new Error(`Invalid value for OAUTH_CALLBACK_PORT: "${envPortRaw}"`);
      }
      port = parsedEnvPort;
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    let listeningPort = port;
    const callbackTimeoutMs = resolveCallbackTimeoutMs(this.isIflowOAuthProvider());

    let startupSettled = false;
    let resolveStartup: ((boundPort: number) => void) | null = null;
    let rejectStartup: ((error: Error) => void) | null = null;
    const startupPromise = new Promise<number>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const settleStartupSuccess = (boundPort: number): void => {
      if (startupSettled) {
        return;
      }
      startupSettled = true;
      resolveStartup?.(boundPort);
    };
    const settleStartupFailure = (message: string): void => {
      if (startupSettled) {
        return;
      }
      startupSettled = true;
      rejectStartup?.(new Error(message));
    };

    const callbackPromise = new Promise<{ code: string; verifier: string }>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          logOAuthDebug(`[OAuth] Callback server received request: ${req.url}`);
          const full = new url.URL(req.url || '/', `http://${redirectHost}:${listeningPort}`);
          const reqPath = full.pathname || '';
          const okPath = reqPath === pathName || /oauth.*callback/i.test(reqPath);

          if (!req.url || !okPath) {
            logOAuthDebug(`[OAuth] Ignoring non-callback request: ${req.url}`);
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/html');
            res.end('<html><body><h1>Not Found</h1><p>This is the OAuth callback server. Please use the correct callback path.</p></body></html>');
            return; // 不要拒绝 Promise，继续等待正确的 callback
          }

          const params = full.searchParams;

          // 检查错误
          const error = params.get('error');
          if (error) {
            logOAuthDebug(`[OAuth] Authorization error: ${error}`);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            res.end('<html><body><h1>OAuth Error</h1><p>Authorization failed. You can close this window.</p></body></html>');

            if (timeoutHandle) {clearTimeout(timeoutHandle);}
            server.close();
            reject(new Error(`Authorization error: ${error}`));
            return;
          }

          // 验证状态参数
          const receivedState = params.get('state');
          if (receivedState !== state) {
            logOAuthDebug(`[OAuth] State mismatch: expected ${state}, got ${receivedState}`);
            const mismatchCode = params.get('code');
            if (mismatchCode && shouldAllowLenientStateCallback()) {
              console.warn('[OAuth] State mismatch detected, but accepting callback code in headful-auto compatibility mode.');
              logOAuthDebug('[OAuth] Lenient state mode accepted callback code despite mismatch');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/html');
              res.end('<html><body><h1>OAuth Success!</h1><p>Authentication successful. You can close this window now.</p><script>setTimeout(function(){window.close()},3000);</script></body></html>');
              if (timeoutHandle) {clearTimeout(timeoutHandle);}
              server.close();
              resolve({ code: mismatchCode, verifier: codeVerifier });
              return;
            }
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/html');
            res.end('<html><body><h1>OAuth Error</h1><p>State mismatch. Possible CSRF attack. You can close this window.</p></body></html>');
            // Do not terminate the whole auth flow for a single stale/foreign callback.
            // Keep waiting for a callback carrying the expected state.
            logOAuthDebug('[OAuth] Ignoring mismatched state callback and continuing to wait for valid callback');
            return;
          }

          // 获取授权码
          const code = params.get('code');
          if (!code) {
            logOAuthDebug('[OAuth] No authorization code found in callback');
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/html');
            res.end('<html><body><h1>OAuth Error</h1><p>No authorization code found. You can close this window.</p></body></html>');

            if (timeoutHandle) {clearTimeout(timeoutHandle);}
            server.close();
            reject(new Error('No authorization code found'));
            return;
          }

          // 成功响应
          logOAuthDebug('[OAuth] Successfully received authorization code via callback');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body><h1>OAuth Success!</h1><p>Authentication successful. You can close this window now.</p><script>setTimeout(function(){window.close()},3000);</script></body></html>');

          if (timeoutHandle) {clearTimeout(timeoutHandle);}
          server.close();
          resolve({ code, verifier: codeVerifier });

        } catch (error) {
          logOAuthDebug(`[OAuth] Callback handler error: ${error instanceof Error ? error.message : String(error)}`);
          try {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/html');
            res.end('<html><body><h1>OAuth Error</h1><p>Internal server error. You can close this window.</p></body></html>');
          } catch {
            // Response might already be closed
          }

          if (timeoutHandle) {clearTimeout(timeoutHandle);}
          server.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      let retriedWithEphemeralPort = false;
      server.on('error', (error: Error & { code?: string }) => {
        logOAuthDebug(`[OAuth] Callback server error: ${error.message}`);
        if (error.code === 'EADDRINUSE' && !retriedWithEphemeralPort) {
          retriedWithEphemeralPort = true;
          console.warn(
            `[OAuth] Callback port ${port} is in use; retrying with an ephemeral local port.`
          );
          try {
            server.listen(0);
            return;
          } catch (listenError) {
            const msg = listenError instanceof Error ? listenError.message : String(listenError);
            const startupMsg = `Failed to retry callback server on ephemeral port: ${msg}`;
            settleStartupFailure(startupMsg);
            if (timeoutHandle) {clearTimeout(timeoutHandle);}
            reject(new Error(startupMsg));
            return;
          }
        }

        console.error(
          '[OAuth] Callback server failed to start or encountered an error:',
          error.message
        );
        const startupMsg = `Failed to start callback server: ${error.message}`;
        settleStartupFailure(startupMsg);
        if (timeoutHandle) {clearTimeout(timeoutHandle);}
        reject(new Error(startupMsg));
      });

      server.on('listening', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object' && 'port' in addr && typeof addr.port === 'number') {
          listeningPort = addr.port;
        }
        settleStartupSuccess(listeningPort);

        logOAuthDebug(
          `[OAuth] Callback server listening on 0.0.0.0:${listeningPort}${pathName} (redirect host=${redirectHost})`
        );
        console.log(
          `[OAuth] Waiting for OAuth callback at http://${redirectHost}:${listeningPort}${pathName}`
        );
        console.log(
          `[OAuth] You have ${Math.max(1, Math.floor(callbackTimeoutMs / 1000))} seconds to complete the authentication in your browser`
        );
        publishInteractiveLockCallbackPort(listeningPort);
        try {
          const envBrowser = String(process.env.ROUTECODEX_OAUTH_BROWSER || '').trim().toLowerCase();
          const camoufoxDefault = !envBrowser || envBrowser === 'camoufox';
          const devMode = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '').trim();
          const headless = !devMode;
          if (camoufoxDefault && headless) {
            console.log(
              `[OAuth] Tip: no browser window? You may be running Camoufox headless. Re-run with "--headful" (or set ROUTECODEX_CAMOUFOX_DEV_MODE=1).`
            );
          } else {
            console.log(
              `[OAuth] Tip: if no browser window opened, manually visit the Portal URL printed above to continue.`
            );
          }
        } catch {
          // ignore
        }

        // Timeout is adaptive: fast-fail for headless auto mode, long timeout for manual/headful.
        timeoutHandle = setTimeout(() => {
          logOAuthDebug(`[OAuth] Callback server timeout (${callbackTimeoutMs} ms)`);
          console.warn(`[OAuth] OAuth callback timeout after ${Math.floor(callbackTimeoutMs / 1000)} seconds. Please try again.`);
          server.close();
          reject(new Error(`OAuth callback timeout after ${Math.floor(callbackTimeoutMs / 1000)} seconds`));
        }, callbackTimeoutMs);
      });

      // 不指定 host，监听所有地址，避免 localhost 解析到仅 IPv6 或仅 IPv4 时造成连接被拒绝
      try {
        server.listen(port);
      } catch (listenError) {
        const msg = listenError instanceof Error ? listenError.message : String(listenError);
        const startupMsg = `Failed to start callback server: ${msg}`;
        settleStartupFailure(startupMsg);
        reject(new Error(startupMsg));
      }
    });

    // Wait for callback server to bind. This also allows EADDRINUSE fallback to settle final port.
    listeningPort = await startupPromise;
    // 更新重定向URI（使用配置中的路径或默认）
    const redirectUri = `http://${redirectHost}:${listeningPort}${pathName}`;
    logOAuthDebug(`[OAuth] Callback redirect URI: ${redirectUri}`);

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
      this.applyAuthRedirectParams(authUrl, data.flowStyle, serverResult.redirectUri, data.state);
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

    const response = await this.requestTokenEndpoint(formData);

    if (!response.ok) {
      throw await this.parseErrorResponse(response);
    }

    const raw = await response.json() as UnknownObject;
    return this.normalizeTokenResponse(raw);
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
        const userInfoUrl = `${this.config.endpoints.userInfoUrl}?accessToken=${encodeURIComponent(tokenResponse.access_token)}`;
        const userInfoResponse = this.isIflowOAuthProvider()
          ? await this.fetchIflowUserInfoWithRetry(userInfoUrl)
          : await this.makeRequest(userInfoUrl, { method: 'GET' });

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
    const expiresIn = this.resolveExpiresInSeconds(tokenResponse);
    const expiresAt = Date.now() + (expiresIn * 1000);
    enrichedToken.expires_in = expiresIn;
    enrichedToken.expires_at = expiresAt;
    enrichedToken.expired = new Date(expiresAt).toISOString();
    return enrichedToken;
  }

  private resolveExpiresInSeconds(tokenResponse: AuthCodeTokenResponse): number {
    const parsePositiveNumber = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
      return null;
    };

    const direct =
      parsePositiveNumber(tokenResponse.expires_in) ??
      parsePositiveNumber(tokenResponse.expiresIn) ??
      parsePositiveNumber(tokenResponse.expires);
    if (direct !== null) {
      return direct;
    }

    const storedExpiresAt = this.tokenStorage?.expires_at;
    const remainingMs =
      typeof storedExpiresAt === 'number' && Number.isFinite(storedExpiresAt)
        ? storedExpiresAt - Date.now()
        : NaN;
    if (Number.isFinite(remainingMs) && remainingMs > 60_000) {
      return Math.floor(remainingMs / 1000);
    }

    // Fallback: avoid NaN timestamp crashes when provider omits expires_in.
    return 3600;
  }

  private readPositiveNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  private readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private normalizeTokenResponse(payload: UnknownObject): AuthCodeTokenResponse {
    const root = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {};
    const data = root.data && typeof root.data === 'object'
      ? root.data as Record<string, unknown>
      : root;

    const accessToken =
      this.readNonEmptyString(data.access_token) ??
      this.readNonEmptyString(data.accessToken) ??
      this.readNonEmptyString(data.token);

    const message =
      this.readNonEmptyString(root.message) ??
      this.readNonEmptyString(root.msg) ??
      this.readNonEmptyString(root.error_description) ??
      this.readNonEmptyString((root.error as Record<string, unknown> | undefined)?.message);
    const code = this.readNonEmptyString(root.code);
    const markedFailure = root.success === false || (code !== undefined && code !== '' && code !== '0');

    if (!accessToken) {
      if (markedFailure) {
        throw new Error(`OAuth token endpoint rejected request${code ? ` (${code})` : ''}: ${message || 'unknown error'}`);
      }
      throw new Error(`OAuth token endpoint response missing access_token${message ? `: ${message}` : ''}`);
    }

    return {
      access_token: accessToken,
      refresh_token:
        this.readNonEmptyString(data.refresh_token) ??
        this.readNonEmptyString(data.refreshToken),
      token_type:
        this.readNonEmptyString(data.token_type) ??
        this.readNonEmptyString(data.tokenType),
      scope: this.readNonEmptyString(data.scope),
      expires_in:
        this.readPositiveNumber(data.expires_in) ??
        this.readPositiveNumber(data.expiresIn) ??
        this.readPositiveNumber(data.expires) ??
        undefined,
      resource_url: this.readNonEmptyString(data.resource_url) ?? this.readNonEmptyString(data.resourceUrl),
      apiKey: this.readNonEmptyString(data.apiKey) ?? this.readNonEmptyString(data.api_key)
    };
  }

  private buildTokenRequestHeaders(): Record<string, string> {
    const tokenHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    if (this.config.client.clientSecret) {
      const basic = Buffer.from(`${this.config.client.clientId}:${this.config.client.clientSecret}`).toString('base64');
      tokenHeaders.Authorization = `Basic ${basic}`;
    }
    return tokenHeaders;
  }

  /**
   * Token endpoint requests keep headers minimal and bypass provider-level common headers,
   * matching iFlow CLI behavior and avoiding compat surprises.
   */
  private async requestTokenEndpoint(formData: URLSearchParams): Promise<Response> {
    return this.httpClient(this.config.endpoints.tokenUrl, {
      method: 'POST',
      headers: this.buildTokenRequestHeaders(),
      body: formData.toString()
    });
  }

  private isIflowOAuthProvider(): boolean {
    const authUrl = String(this.config.endpoints.authorizationUrl || '').toLowerCase();
    const tokenUrl = String(this.config.endpoints.tokenUrl || '').toLowerCase();
    const userInfoUrl = String(this.config.endpoints.userInfoUrl || '').toLowerCase();
    return (
      authUrl.includes('iflow.cn') ||
      tokenUrl.includes('iflow.cn/oauth/token') ||
      userInfoUrl.includes('iflow.cn/api/oauth/getuserinfo')
    );
  }

  private async fetchIflowUserInfoWithRetry(url: string): Promise<Response> {
    const retryDelaysMs = [1000, 2000, 3000];
    let lastError: unknown;
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      try {
        const response = await this.httpClient(url, { method: 'GET' });
        if (response.ok) {
          return response;
        }
        const shouldRetry =
          (response.status >= 500 || response.status === 408 || response.status === 429) &&
          attempt < retryDelaysMs.length - 1;
        if (!shouldRetry) {
          return response;
        }
      } catch (error) {
        lastError = error;
        if (attempt >= retryDelaysMs.length - 1) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to fetch iFlow user info');
  }

  private applyAuthRedirectParams(
    authUrl: URL,
    flowStyle: FlowStyle,
    redirectUri: string,
    state: string
  ): void {
    if (flowStyle === 'legacy') {
      // Keep parity with official iFlow CLI:
      // redirect=<encodeURIComponent(redirectUri)>&state=<state> (state embedded in redirect).
      authUrl.searchParams.delete('state');
      authUrl.searchParams.delete('redirect_uri');
      authUrl.searchParams.set('redirect', `${encodeURIComponent(redirectUri)}&state=${state}`);
      return;
    }

    if (flowStyle === 'web') {
      authUrl.searchParams.delete('redirect_uri');
      authUrl.searchParams.set('redirect', redirectUri);
      authUrl.searchParams.set('state', state);
      return;
    }

    authUrl.searchParams.delete('redirect');
    authUrl.searchParams.delete('state');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
  }

  private async abortPendingCallbackServer(redirectUri: string, reason: string): Promise<void> {
    try {
      const url = new URL(redirectUri);
      url.searchParams.set('error', reason || 'cancelled');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      await fetch(url.toString(), { method: 'GET', signal: controller.signal });
      clearTimeout(timeout);
    } catch {
      // best-effort callback abort
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
    if (typeof candidate.access_token !== 'string') {
      return null;
    }
    const expiresInRaw = candidate.expires_in ?? candidate.expiresIn ?? candidate.expires;
    if (typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0) {
      candidate.expires_in = expiresInRaw;
      return candidate as StoredToken;
    }
    if (typeof expiresInRaw === 'string') {
      const parsed = Number(expiresInRaw.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        candidate.expires_in = parsed;
        return candidate as StoredToken;
      }
    }
    if (typeof candidate.expires_at === 'number' && Number.isFinite(candidate.expires_at)) {
      return candidate as StoredToken;
    }
    if (typeof candidate.expired === 'string' && Number.isFinite(Date.parse(candidate.expired))) {
      return candidate as StoredToken;
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
    const configuredMaxAttempts = this.config.retry?.maxAttempts || 3;
    // Align iFlow CLI auth behavior: refresh endpoint errors should not loop retries.
    const maxAttempts = this.isIflowOAuthProvider() ? 1 : configuredMaxAttempts;
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

        const response = await this.requestTokenEndpoint(formData);

        if (!response.ok) {
          throw await this.parseErrorResponse(response);
        }

        const raw = await response.json() as UnknownObject;
        const tokenData = this.normalizeTokenResponse(raw);

        // Google OAuth doesn't always return a new refresh_token during refresh
        // Preserve the original refresh_token if not provided in the new response
        if (!tokenData.refresh_token && refreshToken) {
          tokenData.refresh_token = refreshToken;
        }

        return await this.handlePostTokenActivation(tokenData);

      } catch (error) {
        lastError = error;
        const msg = formatOAuthErrorMessage(error);
        console.warn(`Token refresh attempt ${attempt + 1} failed:`, msg);
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
    const wrapper = token && typeof token === 'object' && typeof (token as Record<string, unknown>).token === 'object'
      ? (token as UnknownObject)
      : null;
    const stored = this.ensureStoredToken(wrapper ? (wrapper as Record<string, unknown>).token as UnknownObject : token);
    try {
      const dir = path.dirname(this.tokenFile);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.tokenFile, JSON.stringify(wrapper ?? stored, null, 2));
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
