/**
 * iFlow OAuth Implementation
 *
 * Mirrors the Qwen OAuth flow but with iFlow-specific endpoints and token format.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_IFLOW_CONFIG = {
  DEVICE_CODE_ENDPOINT: 'https://api.iflow.cn/oauth/device_code',
  TOKEN_ENDPOINT: 'https://api.iflow.cn/oauth/token',
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
  scopes?: string[];
  httpClient?: typeof fetch;
}

export class IFlowTokenStorage {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
  scope: string;

  constructor(data: any = {}) {
    this.access_token = data.access_token || '';
    this.refresh_token = data.refresh_token || '';
    this.token_type = data.token_type || 'Bearer';
    this.scope = data.scope || '';
    this.expires_at = data.expires_at || Date.now();
  }

  toJSON() {
    return {
      access_token: this.access_token,
      refresh_token: this.refresh_token,
      token_type: this.token_type,
      scope: this.scope,
      expires_at: this.expires_at
    };
  }

  static fromJSON(json: any) {
    return new IFlowTokenStorage(json);
  }

  isExpired(bufferMs: number = 60_000): boolean {
    return Date.now() + bufferMs >= this.expires_at;
  }

  getAuthorizationHeader(): string {
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
  private scopes: string[];

  constructor(options: IFlowOAuthOptions = {}) {
    this.tokenFile = options.tokenFile || path.join(process.env.HOME || '', '.iflow', 'oauth_creds.json');
    this.httpClient = options.httpClient || fetch;
    this.clientId = options.clientId || DEFAULT_IFLOW_CONFIG.CLIENT_ID;
    this.clientSecret = options.clientSecret;
    this.deviceCodeEndpoint = options.deviceCodeUrl || DEFAULT_IFLOW_CONFIG.DEVICE_CODE_ENDPOINT;
    this.tokenEndpoint = options.tokenUrl || DEFAULT_IFLOW_CONFIG.TOKEN_ENDPOINT;
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
    let lastError: unknown;

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

    const response = await this.httpClient(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    this.tokenStorage = this.createTokenStorage(data);
    await this.saveToken();
    return this.tokenStorage;
  }

  /**
   * Start device flow interactively
   */
  async completeOAuthFlow(openBrowser = true): Promise<IFlowTokenStorage> {
    console.log('Starting iFlow OAuth device flow...');

    const { codeVerifier, codeChallenge } = this.generatePKCEPair();
    const device = await this.requestDeviceCode(codeChallenge);

    console.log('Please visit the following URL to authenticate:');
    console.log(device.verification_uri_complete || device.verification_uri);
    console.log(`User code: ${device.user_code}`);

    if (openBrowser && device.verification_uri_complete) {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        await execAsync(`open "${device.verification_uri_complete}"`);
      } catch {
        console.log('Could not open browser automatically.');
      }
    }

    const token = await this.pollForToken(device, codeVerifier);
    this.tokenStorage = this.createTokenStorage(token);
    await this.saveToken();
    console.log('iFlow OAuth authentication completed successfully!');
    return this.tokenStorage;
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

  private async requestDeviceCode(codeChallenge: string) {
    const formData = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scopes.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    if (this.clientSecret) {
      formData.append('client_secret', this.clientSecret);
    }

    const response = await this.httpClient(this.deviceCodeEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Device authorization failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json();
  }

  private async pollForToken(device: any, codeVerifier: string) {
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

      const response = await this.httpClient(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: formData
      });

      const text = await response.text();
      if (response.ok) {
        return JSON.parse(text);
      }

      const errorData = JSON.parse(text);
      if (errorData.error === 'authorization_pending' || errorData.error === 'slow_down') {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
        continue;
      }

      throw new Error(`OAuth error: ${errorData.error} - ${errorData.error_description || 'No description'}`);
    }

    throw new Error('Authentication timeout. Please restart the device flow.');
  }

  private createTokenStorage(data: any): IFlowTokenStorage {
    const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return new IFlowTokenStorage({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type || 'Bearer',
      scope: data.scope || this.scopes.join(' '),
      expires_at: expiresAt
    });
  }

  private convertLegacyToken(data: any): any {
    if (!data) {
      return data;
    }

    if (data.expiry_date) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type || 'Bearer',
        scope: data.scope || this.scopes.join(' '),
        expires_at: data.expiry_date
      };
    }

    return data;
  }
}

export function createIFlowOAuth(options: IFlowOAuthOptions = {}) {
  return new IFlowOAuth(options);
}
