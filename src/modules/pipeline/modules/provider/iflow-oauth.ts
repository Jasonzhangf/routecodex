/**
 * iFlow OAuth Implementation
 *
 * Mirrors the Qwen OAuth flow but with iFlow-specific endpoints and token format.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_IFLOW_CONFIG = {
  // Prefer iflow.cn host; code supports fallback between device_code and device/code
  DEVICE_CODE_ENDPOINT: 'https://iflow.cn/oauth/device/code',
  TOKEN_ENDPOINT: 'https://iflow.cn/oauth/token',
  AUTHORIZATION_ENDPOINT: 'https://iflow.cn/oauth',
  CLIENT_ID: 'iflow-desktop-client',
  SCOPE: 'openid profile email api',
  GRANT_TYPE: 'urn:ietf:params:oauth:grant-type:device_code'
};

interface IFlowOAuthOptions {
  tokenFile?: string;
  clientId?: string;
  clientSecret?: string;
  deviceCodeUrl?: string;
  tokenUrl?: string;
  authUrl?: string;
  scopes?: string[];
  httpClient?: typeof fetch;
}

export class IFlowTokenStorage {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
  scope: string;
  apiKey?: string;

  constructor(data: Record<string, unknown> = {}) {
    this.access_token = String(data.access_token || '');
    this.refresh_token = String(data.refresh_token || '');
    this.token_type = String(data.token_type || 'Bearer');
    this.scope = String(data.scope || '');
    this.expires_at = Number(data.expires_at || Date.now());
    if (typeof (data as any).apiKey === 'string') {
      this.apiKey = String((data as any).apiKey);
    }
  }

  toJSON() {
    return {
      access_token: this.access_token,
      refresh_token: this.refresh_token,
      token_type: this.token_type,
      scope: this.scope,
      expires_at: this.expires_at,
      ...(this.apiKey ? { apiKey: this.apiKey } : {})
    };
  }

  static fromJSON(json: any) {
    const src = (json && typeof json === 'object') ? (json as Record<string, unknown>) : {};
    return new IFlowTokenStorage(src);
  }

  isExpired(bufferMs: number = 60_000): boolean {
    return Date.now() + bufferMs >= this.expires_at;
  }

  getAuthorizationHeader(): string {
    // Prefer apiKey for LLM API calls if present; fallback to OAuth token
    if (this.apiKey && this.apiKey.trim()) {
      return `Bearer ${this.apiKey}`;
    }
    return `${this.token_type} ${this.access_token}`.trim();
  }
}

export class IFlowOAuth {
  private tokenFile: string;
  private tokenStorage: IFlowTokenStorage | null = null;
  private httpClient: typeof fetch;
  private clientId: string;
  private clientSecret?: string;
  private deviceCodeEndpoint: string;
  private tokenEndpoint: string;
  private authorizationEndpoint: string;
  private scopes: string[];

  constructor(options: IFlowOAuthOptions = {}) {
    this.tokenFile = options.tokenFile || path.join(process.env.HOME || '', '.iflow', 'oauth_creds.json');
    this.httpClient = options.httpClient || fetch;
    this.clientId = options.clientId || DEFAULT_IFLOW_CONFIG.CLIENT_ID;
    this.clientSecret = options.clientSecret;
    this.deviceCodeEndpoint = options.deviceCodeUrl || DEFAULT_IFLOW_CONFIG.DEVICE_CODE_ENDPOINT;
    this.tokenEndpoint = options.tokenUrl || DEFAULT_IFLOW_CONFIG.TOKEN_ENDPOINT;
    this.authorizationEndpoint = options.authUrl || DEFAULT_IFLOW_CONFIG.AUTHORIZATION_ENDPOINT;
    this.scopes = options.scopes || DEFAULT_IFLOW_CONFIG.SCOPE.split(' ');
  }

  /**
   * Load token from disk
   */
  async loadToken(): Promise<IFlowTokenStorage | null> {
    try {
      const content = await fs.readFile(this.tokenFile, 'utf-8');
      const json = JSON.parse(content);
      this.tokenStorage = IFlowTokenStorage.fromJSON(
        json.expires_at ? json : this.convertLegacyToken(json)
      );

      if (this.tokenStorage.isExpired()) {
        await this.refreshTokensWithRetry(this.tokenStorage.refresh_token);
        await this.saveToken();
        return this.tokenStorage;
      }

      return this.tokenStorage;
    } catch {
      this.tokenStorage = null;
      return null;
    }
  }

  /**
   * Save token to disk
   */
  async saveToken(): Promise<void> {
    if (!this.tokenStorage) {return;}
    const dir = path.dirname(this.tokenFile);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.tokenFile, JSON.stringify(this.tokenStorage.toJSON(), null, 2));
  }

  /**
   * Refresh token with retries
   */
  async refreshTokensWithRetry(refreshToken: string, maxRetries = 3) {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
      try {
        return await this.refreshTokens(refreshToken);
      } catch (error) {
        lastError = error;
        console.warn(`iFlow token refresh attempt ${attempt + 1} failed:`, error instanceof Error ? error.message : error);
      }
    }

    throw new Error(`Token refresh failed after ${maxRetries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /**
   * Perform token refresh
   */
  async refreshTokens(refreshToken: string): Promise<IFlowTokenStorage> {
    const formData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken
    });

    if (this.clientSecret) {
      formData.append('client_secret', this.clientSecret);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    };
    if (this.clientSecret) {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
    const response = await this.httpClient(this.tokenEndpoint, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    this.tokenStorage = this.createTokenStorage(data);
    await this.fetchAndAttachApiKey(this.tokenStorage.access_token);
    await this.saveToken();
    return this.tokenStorage;
  }

  /**
   * Start OAuth: Prefer auth-code (web) flow; fallback to device flow.
   */
  async completeOAuthFlow(openBrowser = true): Promise<IFlowTokenStorage> {
    // Try Authorization Code flow first
    try {
      const storage = await this.completeAuthCodeFlow(openBrowser);
      this.tokenStorage = storage;
      await this.saveToken();
      console.log('iFlow OAuth authentication (auth-code) completed successfully!');
      return this.tokenStorage;
    } catch (e) {
      console.warn('[iFlow OAuth] Auth-code flow failed, falling back to device flow:', e instanceof Error ? e.message : e);
    }

    console.log('Starting iFlow OAuth device flow...');
    try {
      console.log(`[iFlow OAuth] Using endpoints:\n  device: ${this.deviceCodeEndpoint}\n  token:  ${this.tokenEndpoint}`);
    } catch {
      // Intentionally empty - logging errors might expose sensitive information
    }

    const { codeVerifier, codeChallenge } = this.generatePKCEPair();
    const device = await this.requestDeviceCode(codeChallenge);

    console.log('Please visit the following URL to authenticate:');
    console.log(device.verification_uri_complete || device.verification_uri);
    console.log(`User code: ${device.user_code}`);

    if (openBrowser) {
      const urlToOpen = device.verification_uri_complete || device.verification_uri;
      if (urlToOpen) {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          await execAsync(`open "${urlToOpen}"`);
        } catch {
          console.log('Could not open browser automatically.');
        }
      }
    }

    const token = await this.pollForToken(device, codeVerifier);
    this.tokenStorage = this.createTokenStorage(token);
    await this.fetchAndAttachApiKey(this.tokenStorage.access_token);
    await this.saveToken();
    console.log('iFlow OAuth authentication (device) completed successfully!');
    return this.tokenStorage;
  }

  private async completeAuthCodeFlow(openBrowser = true): Promise<IFlowTokenStorage> {
    const { codeVerifier, codeChallenge } = this.generatePKCEPair();
    const http = await import('http');
    const url = await import('url');
    const host = process.env.OAUTH_CALLBACK_HOST || 'localhost';
    const port = await this.findOpenPort();
    const redirectUri = `http://${host}:${port}/oauth2callback`;
    const state = crypto.randomBytes(16).toString('hex');

    const auth = new URL(this.authorizationEndpoint);
    auth.searchParams.set('loginMethod', 'phone');
    auth.searchParams.set('type', 'phone');
    auth.searchParams.set('redirect', `${encodeURIComponent(redirectUri)}&state=${state}`);
    auth.searchParams.set('client_id', this.clientId);
    // PKCE hints (server may ignore for web flow)
    auth.searchParams.set('code_challenge', codeChallenge);
    auth.searchParams.set('code_challenge_method', 'S256');

    const loginComplete = new Promise<any>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          if (!req.url || req.url.indexOf('/oauth2callback') === -1) {
            res.statusCode = 302;
            res.setHeader('Location', 'https://iflow.cn');
            res.end();
            reject(new Error(`Unexpected request: ${req.url}`));
            return;
          }
          const params = new url.URL(req.url, 'http://localhost/').searchParams;
          const err = params.get('error');
          if (err) {
            res.statusCode = 302;
            res.setHeader('Location', 'https://iflow.cn');
            res.end();
            reject(new Error(`Error during authentication: ${err}`));
            return;
          }
          const receivedState = params.get('state');
          if (receivedState !== state) {
            res.statusCode = 400;
            res.end('State mismatch. Possible CSRF attack');
            reject(new Error('State mismatch. Possible CSRF attack'));
            return;
          }
          const code = params.get('code');
          if (!code) {
            res.statusCode = 400;
            res.end('No code found in request');
            reject(new Error('No code found in request'));
            return;
          }
          const form = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: this.clientId,
            code_verifier: codeVerifier
          });
          const headers: Record<string,string> = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'RouteCodex-OAuth/1.0'
          };
          if (this.clientSecret) {
            const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
            headers['Authorization'] = `Basic ${basic}`;
          }
          const resp = await this.httpClient(this.tokenEndpoint, {
            method: 'POST',
            headers,
            body: form
          });
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Token request failed: ${resp.status} ${resp.statusText} - ${text}`);
          }
          const data = await resp.json();
          res.statusCode = 302;
          res.setHeader('Location', 'https://iflow.cn');
          res.end();
          resolve(data);
        } catch (e) {
          try { res.statusCode = 500; res.end('Authentication failed'); } catch {
            // Response might already be closed
          }
          reject(e instanceof Error ? e : new Error(String(e)));
        } finally {
          server.close();
        }
      });
      server.listen(port, host);
    });

    console.log('Opening browser for iFlow login (auth-code flow)...');
    console.log(`[iFlow OAuth] Authorization URL: ${auth.toString()}`);
    if (openBrowser) {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        await execAsync(`open "${auth.toString()}"`);
      } catch {
        console.log('Could not open browser automatically.');
      }
    }

    const tokenData = await loginComplete;
    const storage = this.createTokenStorage(tokenData);
    await this.fetchAndAttachApiKey(storage.access_token);
    return storage;
  }

  private async findOpenPort(): Promise<number> {
    const net = await import('net');
    return new Promise((resolve, reject) => {
      try {
        const server = net.createServer();
        server.listen(0, () => {
          const addr = server.address();
          server.close();
          if (typeof addr === 'object' && addr && 'port' in addr) {
            resolve((addr as any).port);
          } else {
            reject(new Error('Failed to acquire an open port'));
          }
        });
        server.on('error', reject);
      } catch (e) {
        reject(e as any);
      }
    });
  }

  getAuthorizationHeader(): string {
    if (!this.tokenStorage) {return '';}
    return this.tokenStorage.getAuthorizationHeader();
  }

  getToken(): IFlowTokenStorage | null {
    return this.tokenStorage;
  }

  /**
   * PKCE helpers
   */
  private generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { codeVerifier: verifier, codeChallenge: challenge };
  }

  private async requestDeviceCode(codeChallenge: string): Promise<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number }> {
    const formData = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scopes.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    if (this.clientSecret) {
      formData.append('client_secret', this.clientSecret);
    }

    // Attempt primary endpoint
    const resp = await this.httpClient(this.deviceCodeEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'RouteCodex-OAuth/1.0'
      },
      body: formData
    });

    // If 404, try the alternate path variant (device_code <-> device/code)
    if (!resp.ok && resp.status === 404) {
      const primaryText = await resp.text().catch(() => '');
      const alt = this.deviceCodeEndpoint.includes('/device_code')
        ? this.deviceCodeEndpoint.replace('/device_code', '/device/code')
        : this.deviceCodeEndpoint.replace('/device/code', '/device_code');
      try {
        console.warn(`[iFlow OAuth] Primary device endpoint returned 404, retrying alternate: ${alt}`);
        const retry = await this.httpClient(alt, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'RouteCodex-OAuth/1.0'
          },
          body: formData
        });
        if (retry.ok) {
          // Switch to the working endpoint for the rest of the session
          this.deviceCodeEndpoint = alt;
          return await retry.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
        }
        const retryText = await retry.text().catch(() => '');
        // Try host switch to api.iflow.cn as last resort
        const url = new URL(alt);
        url.host = 'api.iflow.cn';
        const altHost = url.toString();
        console.warn(`[iFlow OAuth] Alternate still failed; trying host fallback: ${altHost}`);
        const retry2 = await this.httpClient(altHost, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'RouteCodex-OAuth/1.0'
          },
          body: formData
        });
        if (!retry2.ok) {
          const retry2Text = await retry2.text().catch(() => '');
          throw new Error(`Device authorization failed: 404 on ${this.deviceCodeEndpoint} (${primaryText}); alternate ${alt} => ${retry.status} ${retry.statusText} (${retryText}); alt-host ${altHost} => ${retry2.status} ${retry2.statusText} (${retry2Text})`);
        }
        this.deviceCodeEndpoint = altHost;
        return await retry2.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
      } catch (e) {
        // If alternate attempt threw before response parse
        throw e instanceof Error ? e : new Error(String(e));
      }
    }

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Device authorization failed: ${resp.status} ${resp.statusText} - ${errorText}`);
    }

    // Some environments may return HTML (intercept pages). Detect and retry alternate endpoint.
    try {
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const body = await resp.text();
        if (body.trim().startsWith('<')) {
          const alt = this.deviceCodeEndpoint.includes('/device_code')
            ? this.deviceCodeEndpoint.replace('/device_code', '/device/code')
            : this.deviceCodeEndpoint.replace('/device/code', '/device_code');
          console.warn(`[iFlow OAuth] Non-JSON response from device endpoint; retrying alternate: ${alt}`);
          const retry = await this.httpClient(alt, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json',
              'User-Agent': 'RouteCodex-OAuth/1.0'
            },
            body: formData
          });
          if (!retry.ok) {
            const retryText = await retry.text().catch(() => '');
            // Try host switch to api.iflow.cn as last resort
            const url = new URL(alt);
            url.host = 'api.iflow.cn';
            const altHost = url.toString();
            console.warn(`[iFlow OAuth] Alternate still failed; trying host fallback: ${altHost}`);
            const retry2 = await this.httpClient(altHost, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'RouteCodex-OAuth/1.0'
              },
              body: formData
            });
            if (!retry2.ok) {
              const retry2Text = await retry2.text().catch(() => '');
              throw new Error(`Device authorization failed: ${retry.status} ${retry.statusText} (${retryText}); alt-host ${altHost} => ${retry2.status} ${retry2.statusText} (${retry2Text})`);
            }
            this.deviceCodeEndpoint = altHost;
            return await retry2.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
          } else {
            // retry.ok but might still be non-JSON (intercept page). Detect and try host fallback.
            const ct = retry.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
              const url = new URL(alt);
              url.host = 'api.iflow.cn';
              const altHost = url.toString();
              console.warn(`[iFlow OAuth] Alternate path returned non-JSON; trying host fallback: ${altHost}`);
              const retry2 = await this.httpClient(altHost, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Accept': 'application/json',
                  'User-Agent': 'RouteCodex-OAuth/1.0'
                },
                body: formData
              });
              if (!retry2.ok) {
                const retry2Text = await retry2.text().catch(() => '');
                throw new Error(`Device authorization failed: alt-path non-JSON; alt-host ${altHost} => ${retry2.status} ${retry2.statusText} (${retry2Text})`);
              }
              this.deviceCodeEndpoint = altHost;
              return await retry2.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
            }
            // Looks like JSON
            this.deviceCodeEndpoint = alt;
            return await retry.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
          }
        }
      }
      // Normal JSON path
      return await resp.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
    } catch (e) {
      // If JSON parse fails because of HTML or other, surface a clearer error
      const body = await resp.text().catch(() => '');
      throw new Error(`Device authorization response not JSON. Endpoint: ${this.deviceCodeEndpoint}. Body sample: ${body.slice(0, 200)}`);
    }
  }

  private async pollForToken(device: { device_code: string; verification_uri: string; verification_uri_complete?: string; user_code: string; expires_in?: number; interval?: number }, codeVerifier: string): Promise<{ access_token: string; refresh_token?: string; token_type?: string; scope?: string; expires_in: number }> {
    const interval = device.interval || 5;
    const maxAttempts = Math.floor((device.expires_in || 300) / interval) + 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const formData = new URLSearchParams({
        grant_type: DEFAULT_IFLOW_CONFIG.GRANT_TYPE,
        client_id: this.clientId,
        device_code: device.device_code,
        code_verifier: codeVerifier
      });

      if (this.clientSecret) {
        formData.append('client_secret', this.clientSecret);
      }

      const currentTokenEndpoint = this.tokenEndpoint;
      let response = await this.httpClient(currentTokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'RouteCodex-OAuth/1.0'
        },
        body: formData
      });

      let text = await response.text();
      if (response.ok) {
        try {
          return JSON.parse(text) as { access_token: string; refresh_token?: string; token_type?: string; scope?: string; expires_in: number };
        } catch {
          // Try host fallback if JSON parse fails
          try {
            const u = new URL(currentTokenEndpoint);
            u.host = u.host === 'iflow.cn' ? 'api.iflow.cn' : 'iflow.cn';
            const altToken = u.toString();
            console.warn(`[iFlow OAuth] Token endpoint non-JSON; retry alternate host: ${altToken}`);
            response = await this.httpClient(altToken, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'RouteCodex-OAuth/1.0'
              },
              body: formData
            });
            text = await response.text();
            if (response.ok) {
              return JSON.parse(text) as { access_token: string; refresh_token?: string; token_type?: string; scope?: string; expires_in: number };
            }
          } catch {
            // Continue with next method
          }
        }
      }

      try {
        const errorData = JSON.parse(text);
        if (errorData.error === 'authorization_pending' || errorData.error === 'slow_down') {
          await new Promise(resolve => setTimeout(resolve, interval * 1000));
          continue;
        }
        throw new Error(`OAuth error: ${errorData.error} - ${errorData.error_description || 'No description'}`);
      } catch {
        // Non-JSON error body
        throw new Error(`OAuth error (non-JSON): ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
      }
    }

    throw new Error('Authentication timeout. Please restart the device flow.');
  }

  private createTokenStorage(data: { access_token: string; refresh_token?: string; token_type?: string; scope?: string; expires_in: number }): IFlowTokenStorage {
    const expiresAt = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
    return new IFlowTokenStorage({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type || 'Bearer',
      scope: data.scope || this.scopes.join(' '),
      expires_at: expiresAt
    });
  }

  private convertLegacyToken(data: any): Record<string, unknown> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const src = data as Record<string, unknown>;

    if ('expiry_date' in src) {
      return {
        access_token: src.access_token,
        refresh_token: src.refresh_token,
        token_type: src.token_type || 'Bearer',
        scope: src.scope || this.scopes.join(' '),
        expires_at: src.expiry_date,
        ...(src.apiKey ? { apiKey: src.apiKey } : {})
      } as Record<string, unknown>;
    }

    return src;
  }

  /**
   * Retrieve apiKey via user info endpoint and attach to tokenStorage
   */
  private async fetchAndAttachApiKey(accessToken: string): Promise<void> {
    try {
      const url = `https://iflow.cn/api/oauth/getUserInfo?accessToken=${encodeURIComponent(accessToken)}`;
      const resp = await this.httpClient(url, { method: 'GET' });
      if (!resp.ok) { return; }
      const data = await resp.json().catch(() => null) as any;
      const apiKey = data?.apiKey || data?.data?.apiKey;
      if (typeof apiKey === 'string' && apiKey.trim()) {
        if (!this.tokenStorage) {
          this.tokenStorage = new IFlowTokenStorage({ access_token: accessToken, expires_at: Date.now() + 3600_000 });
        }
        this.tokenStorage.apiKey = apiKey.trim();
      }
    } catch {
      // silently ignore
    }
  }
}

export function createIFlowOAuth(options: IFlowOAuthOptions = {}) {
  return new IFlowOAuth(options);
}
