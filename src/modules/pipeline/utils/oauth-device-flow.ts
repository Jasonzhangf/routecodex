/**
 * OAuth 2.0 Device Code Flow Implementation
 * OAuth 2.0 设备码流程实现
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * Device Code Response
 */
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * OAuth Token Response
 */
interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  /** Epoch milliseconds when token was created */
  created_at?: number;
}

/**
 * OAuth Configuration
 */
interface OAuthConfig {
  clientId: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenFile?: string;
}

/**
 * OAuth Device Flow Progress Callback
 */
interface OAuthProgressCallback {
  onDeviceCode?: (deviceCode: DeviceCodeResponse) => void;
  onTokenReceived?: (token: OAuthTokenResponse) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

export class OAuthDeviceFlow {
  private config: OAuthConfig;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;

  constructor(config: OAuthConfig) {
    this.config = config;
  }

  /**
   * Start OAuth device code flow
   */
  async start(callback?: OAuthProgressCallback): Promise<OAuthTokenResponse> {
    if (this.isRunning) {
      throw new Error('OAuth device flow is already running');
    }

    this.isRunning = true;
    this.shouldStop = false;

    try {
      // Step 1: Request device code
      const deviceCode = await this.requestDeviceCode();
      callback?.onDeviceCode?.(deviceCode);

      // Step 2: Poll for token
      const token = await this.pollForToken(deviceCode, callback);

      // Step 3: Save token
      await this.saveToken(token);
      callback?.onTokenReceived?.(token);

      callback?.onComplete?.();
      return token;

    } catch (error) {
      callback?.onError?.(error as Error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Stop the OAuth flow
   */
  stop(): void {
    this.shouldStop = true;
  }

  /**
   * Request device code from OAuth server
   */
  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    try {
      const response = await fetch(this.config.deviceCodeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          scope: this.config.scopes.join(' ')
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to request device code: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const deviceCode = await response.json() as DeviceCodeResponse;

      console.log('📱 OAuth Device Code Flow Started');
      console.log(`🔑 User Code: ${deviceCode.user_code}`);
      console.log(`🌐 Verification URL: ${deviceCode.verification_uri}`);
      console.log(`⏱️  Please complete authentication in ${Math.round(deviceCode.expires_in / 60)} minutes`);

      return deviceCode;

    } catch (error) {
      console.error('Failed to request device code:', error);
      throw error;
    }
  }

  /**
   * Poll for token using device code
   */
  private async pollForToken(deviceCode: DeviceCodeResponse, _callback?: OAuthProgressCallback): Promise<OAuthTokenResponse> {
    const maxAttempts = Math.floor(deviceCode.expires_in / deviceCode.interval) + 10;
    let attempts = 0;

    console.log(`🔄 Polling for token (attempt ${attempts + 1}/${maxAttempts})`);

    while (attempts < maxAttempts && !this.shouldStop) {
      try {
        const response = await fetch(this.config.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: this.config.clientId,
            device_code: deviceCode.device_code
          })
        });

        const responseText = await response.text();

        if (response.ok) {
          const token = JSON.parse(responseText) as OAuthTokenResponse;

          // Add created_at timestamp
          token.created_at = Date.now();

          console.log('✅ OAuth token received successfully');
          return token;
        }

        const errorData = JSON.parse(responseText);

        // Check for authorization pending
        if (errorData.error === 'authorization_pending') {
          console.log(`⏳ Authorization pending... (${attempts + 1}/${maxAttempts})`);
          await this.sleep(deviceCode.interval * 1000);
          attempts++;
          continue;
        }

        // Check for slow down
        if (errorData.error === 'slow_down') {
          console.log(`🐌 Slow down requested, increasing interval...`);
          await this.sleep((deviceCode.interval + 5) * 1000);
          attempts++;
          continue;
        }

        // Other errors
        throw new Error(`OAuth error: ${errorData.error} - ${errorData.error_description || 'No description'}`);

      } catch (error) {
        if ((error as Error).message.includes('OAuth error:')) {
          // OAuth-specific error
          throw error;
        }

        console.warn(`Poll attempt ${attempts + 1} failed:`, error);

        if (attempts < maxAttempts - 1) {
          await this.sleep(deviceCode.interval * 1000);
          attempts++;
        } else {
          throw new Error(`Max polling attempts reached. Last error: ${error}`);
        }
      }
    }

    if (this.shouldStop) {
      throw new Error('OAuth flow was stopped');
    }

    throw new Error('Token polling timeout - please try again');
  }

  /**
   * Save token to file
   */
  private async saveToken(token: OAuthTokenResponse): Promise<void> {
    if (!this.config.tokenFile) {
      return;
    }

    try {
      // Expand ~ in path
      const tokenPath = this.config.tokenFile.startsWith('~')
        ? this.config.tokenFile.replace('~', homedir())
        : this.config.tokenFile;

      // Create directory if it doesn't exist
      const tokenDir = path.dirname(tokenPath);
      await fs.mkdir(tokenDir, { recursive: true });

      // Save token
      await fs.writeFile(tokenPath, JSON.stringify(token, null, 2));

      console.log(`💾 Token saved to: ${tokenPath}`);

    } catch (error) {
      console.error('Failed to save token:', error);
      throw error;
    }
  }

  /**
   * Sleep helper function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if device flow is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Refresh an existing token
   */
  static async refreshToken(config: OAuthConfig, refreshToken: string): Promise<OAuthTokenResponse> {
    try {
      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.clientId,
          refresh_token: refreshToken
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const token = await response.json() as OAuthTokenResponse;
      token.created_at = Date.now();

      console.log('✅ Token refreshed successfully');
      return token;

    } catch (error) {
      console.error('Failed to refresh token:', error);
      throw error;
    }
  }

  /**
   * Load token from file
   */
  static async loadToken(tokenFile: string): Promise<OAuthTokenResponse | null> {
    try {
      // Expand ~ in path
      const filePath = tokenFile.startsWith('~')
        ? tokenFile.replace('~', homedir())
        : tokenFile;

      const fileContent = await fs.readFile(filePath, 'utf-8');
      const token = JSON.parse(fileContent) as OAuthTokenResponse;

      // Ensure created_at exists
      if (!token.created_at) {
        token.created_at = Date.now();
      }

      return token;

    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null; // File doesn't exist
      }
      console.error('Failed to load token:', error);
      return null;
    }
  }

  /**
   * Validate token status
   */
  static validateToken(token: OAuthTokenResponse): {
    isValid: boolean;
    isExpired: boolean;
    needsRefresh: boolean;
    expiresAt: Date;
    timeToExpiry: number;
  } {
    const now = Date.now();
    const createdAt = token.created_at || now;
    const expiresAt = createdAt + (token.expires_in * 1000);
    const isExpired = expiresAt <= now;
    const needsRefresh = expiresAt <= now + (5 * 60 * 1000); // 5 minutes buffer
    const timeToExpiry = Math.max(0, expiresAt - now);

    return {
      isValid: !isExpired,
      isExpired,
      needsRefresh,
      expiresAt: new Date(expiresAt),
      timeToExpiry
    };
  }
}
