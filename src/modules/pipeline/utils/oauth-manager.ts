/**
 * OAuth Manager - Centralized OAuth Authentication Management
 * OAuth管理器 - 统一的OAuth认证管理
 */

import { EnhancedAuthResolver } from './enhanced-auth-resolver.js';
import { OAuthDeviceFlow } from './oauth-device-flow.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * OAuth Provider Configuration
 */
interface OAuthProviderConfig {
  id: string;
  name: string;
  clientId: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenFile: string;
  enabled: boolean;
}

/**
 * OAuth Session Status
 */
export interface OAuthSessionStatus {
  providerId: string;
  status: 'idle' | 'pending' | 'authenticated' | 'expired' | 'error';
  tokenStatus?: {
    isValid: boolean;
    isExpired: boolean;
    needsRefresh: boolean;
    expiresAt: Date;
    timeToExpiry: number;
  };
  lastActivity: Date;
  error?: string;
}

/**
 * OAuth Manager Configuration
 */
interface OAuthManagerConfig {
  providers: OAuthProviderConfig[];
  autoRefresh: boolean;
  refreshBuffer: number; // minutes before expiry to refresh
  maxSessions: number;
}

export class OAuthManager {
  private config: OAuthManagerConfig;
  private authResolver: EnhancedAuthResolver;
  private activeSessions: Map<string, OAuthDeviceFlow> = new Map();
  private sessionStatus: Map<string, OAuthSessionStatus> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: OAuthManagerConfig) {
    this.config = config;
    this.authResolver = new EnhancedAuthResolver();

    // Initialize OAuth providers
    this.initializeProviders();
  }

  /**
   * Initialize OAuth providers
   */
  private initializeProviders(): void {
    for (const provider of this.config.providers) {
      if (!provider.enabled) {
        continue;
      }

      // Add OAuth configuration to auth resolver
      this.authResolver.addOAuthConfig(`auth-${provider.id}`, {
        clientId: provider.clientId,
        deviceCodeUrl: provider.deviceCodeUrl,
        tokenUrl: provider.tokenUrl,
        scopes: provider.scopes,
        tokenFile: provider.tokenFile
      });

      // Add auth mapping
      this.authResolver.addAuthMapping(`auth-${provider.id}`, provider.tokenFile);

      // Initialize session status
      this.sessionStatus.set(provider.id, {
        providerId: provider.id,
        status: 'idle',
        lastActivity: new Date()
      });

      console.log(`✅ OAuth provider initialized: ${provider.name} (${provider.id})`);
    }
  }

  /**
   * Start OAuth authentication for a provider
   */
  async authenticate(providerId: string, openBrowser: boolean = true): Promise<boolean> {
    const provider = this.config.providers.find(p => p.id === providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }

    if (!provider.enabled) {
      throw new Error(`Provider is not enabled: ${providerId}`);
    }

    // Check if already have active session
    if (this.activeSessions.has(providerId)) {
      console.warn(`OAuth session already active for provider: ${providerId}`);
      return false;
    }

    try {
      // Update session status
      this.updateSessionStatus(providerId, 'pending');

      console.log(`🔐 Starting OAuth authentication for ${provider.name}`);

      // Create OAuth device flow
      const oauthFlow = new OAuthDeviceFlow({
        clientId: provider.clientId,
        deviceCodeUrl: provider.deviceCodeUrl,
        tokenUrl: provider.tokenUrl,
        scopes: provider.scopes,
        tokenFile: provider.tokenFile
      });

      this.activeSessions.set(providerId, oauthFlow);

      // Start OAuth flow
      const token = await oauthFlow.start({
        onDeviceCode: (deviceCode) => {
          console.log(`📱 Device code: ${deviceCode.user_code}`);
          console.log(`🌐 Verify at: ${deviceCode.verification_uri_complete}`);

          if (openBrowser) {
            this.openVerificationUrl(deviceCode.verification_uri_complete);
          }
        },
        onTokenReceived: (token) => {
          console.log(`✅ Token received for ${provider.name}`);
        },
        onError: (error) => {
          console.error(`OAuth error for ${provider.name}:`, error);
          this.updateSessionStatus(providerId, 'error', error.message);
        },
        onComplete: () => {
          console.log(`🎉 OAuth authentication completed for ${provider.name}`);
          this.updateSessionStatus(providerId, 'authenticated');
          this.setupAutoRefresh(providerId, token);
        }
      });

      // Clean up active session
      this.activeSessions.delete(providerId);

      return true;

    } catch (error) {
      console.error(`OAuth authentication failed for ${provider.name}:`, error);
      this.updateSessionStatus(providerId, 'error', (error as Error).message);
      this.activeSessions.delete(providerId);
      return false;
    }
  }

  /**
   * Get authentication token for a provider
   */
  async getToken(providerId: string): Promise<string> {
    const authId = `auth-${providerId}`;
    return await this.authResolver.resolveToken(authId);
  }

  /**
   * Get token status for a provider
   */
  getTokenStatus(providerId: string) {
    const authId = `auth-${providerId}`;
    return this.authResolver.getTokenStatus(authId);
  }

  /**
   * Get session status for all providers
   */
  getAllSessionStatus(): OAuthSessionStatus[] {
    return Array.from(this.sessionStatus.values());
  }

  /**
   * Get session status for a specific provider
   */
  getSessionStatus(providerId: string): OAuthSessionStatus | undefined {
    return this.sessionStatus.get(providerId);
  }

  /**
   * Refresh token for a provider
   */
  async refreshToken(providerId: string): Promise<boolean> {
    const provider = this.config.providers.find(p => p.id === providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }

    try {
      // Load current token
      const token = await OAuthDeviceFlow.loadToken(provider.tokenFile);
      if (!token || !token.refresh_token) {
        throw new Error('No refresh token available');
      }

      // Refresh token
      const newToken = await OAuthDeviceFlow.refreshToken(
        {
          clientId: provider.clientId,
          deviceCodeUrl: provider.deviceCodeUrl,
          tokenUrl: provider.tokenUrl,
          scopes: provider.scopes
        },
        token.refresh_token
      );

      // Save new token
      await this.saveTokenToFile(provider.tokenFile, newToken);

      // Update session status
      this.updateSessionStatus(providerId, 'authenticated');

      // Setup auto-refresh
      this.setupAutoRefresh(providerId, newToken);

      console.log(`✅ Token refreshed for ${provider.name}`);
      return true;

    } catch (error) {
      console.error(`Failed to refresh token for ${provider.name}:`, error);
      this.updateSessionStatus(providerId, 'error', (error as Error).message);
      return false;
    }
  }

  /**
   * Setup automatic token refresh
   */
  private setupAutoRefresh(providerId: string, token: any): void {
    if (!this.config.autoRefresh) {
      return;
    }

    // Clear existing timer
    const existingTimer = this.refreshTimers.get(providerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Calculate refresh time (expiry time - buffer)
    const now = Date.now();
    const createdAt = token.created_at || now;
    const expiresAt = createdAt + (token.expires_in * 1000);
    const refreshTime = expiresAt - (this.config.refreshBuffer * 60 * 1000);

    // Set up refresh timer
    const delay = Math.max(0, refreshTime - now);
    if (delay > 0) {
      const timer = setTimeout(async () => {
        try {
          await this.refreshToken(providerId);
        } catch (error) {
          console.error(`Auto-refresh failed for ${providerId}:`, error);
        }
      }, delay);

      this.refreshTimers.set(providerId, timer);

      console.log(`🔄 Auto-refresh scheduled for ${providerId} in ${Math.round(delay / 1000)} seconds`);
    }
  }

  /**
   * Save token to file
   */
  private async saveTokenToFile(tokenFile: string, token: any): Promise<void> {
    try {
      // Expand ~ in path
      const filePath = tokenFile.startsWith('~')
        ? tokenFile.replace('~', homedir())
        : tokenFile;

      // Create directory if it doesn't exist
      const tokenDir = path.dirname(filePath);
      await fs.mkdir(tokenDir, { recursive: true });

      // Save token
      await fs.writeFile(filePath, JSON.stringify(token, null, 2));

    } catch (error) {
      console.error('Failed to save token:', error);
      throw error;
    }
  }

  /**
   * Open verification URL in browser
   */
  private openVerificationUrl(url: string): void {
    try {
      const { exec } = require('child_process');
      let command: string;

      switch (process.platform) {
        case 'darwin':
          command = `open "${url}"`;
          break;
        case 'win32':
          command = `start "${url}"`;
          break;
        default:
          command = `xdg-open "${url}"`;
          break;
      }

      exec(command, (error: any) => {
        if (error) {
          console.error('Failed to open browser:', error);
        } else {
          console.log('🌐 Browser opened for authentication');
        }
      });
    } catch (error) {
      console.error('Failed to open browser:', error);
    }
  }

  /**
   * Update session status
   */
  private updateSessionStatus(providerId: string, status: OAuthSessionStatus['status'], error?: string): void {
    const sessionStatus = this.sessionStatus.get(providerId);
    if (sessionStatus) {
      sessionStatus.status = status;
      sessionStatus.lastActivity = new Date();
      sessionStatus.error = error;

      // Update token status if authenticated
      if (status === 'authenticated') {
        const tokenStatus = this.getTokenStatus(providerId);
        sessionStatus.tokenStatus = tokenStatus;
      }
    }
  }

  /**
   * Check if provider is authenticated
   */
  isAuthenticated(providerId: string): boolean {
    const status = this.getSessionStatus(providerId);
    return status?.status === 'authenticated' && (status.tokenStatus?.isValid === true);
  }

  /**
   * Get auth resolver for external use
   */
  getAuthResolver(): EnhancedAuthResolver {
    return this.authResolver;
  }

  /**
   * Stop OAuth session for a provider
   */
  stopSession(providerId: string): void {
    const session = this.activeSessions.get(providerId);
    if (session) {
      session.stop();
      this.activeSessions.delete(providerId);
      this.updateSessionStatus(providerId, 'idle');
    }
  }

  /**
   * Stop all OAuth sessions
   */
  stopAllSessions(): void {
    for (const [providerId, session] of this.activeSessions) {
      session.stop();
      this.updateSessionStatus(providerId, 'idle');
    }
    this.activeSessions.clear();
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopAllSessions();

    // Clear all timers
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();

    // Cleanup auth resolver
    this.authResolver.cleanup();
  }
}
