/**
 * OAuth Configuration Manager
 *
 * Centralized configuration management for OAuth authentication systems,
 * supporting multiple providers with unified configuration handling.
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * OAuth provider configuration
 */
export interface OAuthProviderConfig {
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** Authorization URL */
  authUrl: string;
  /** Token URL */
  tokenUrl: string;
  /** Device code URL (for device flow) */
  deviceCodeUrl?: string;
  /** Requested scopes */
  scopes: string[];
  /** Redirect URI (for auth code flow) */
  redirectUri?: string;
  /** Token file path for persistence */
  tokenFile?: string;
  /** Credentials file path */
  credentialsFile?: string;
  /** Refresh buffer in milliseconds (default: 5 minutes) */
  refreshBuffer?: number;
  /** Provider-specific settings */
  providerSettings?: Record<string, any>;
}

/**
 * OAuth token information
 */
export interface OAuthTokenInfo {
  /** Access token */
  accessToken: string;
  /** Refresh token (if available) */
  refreshToken?: string;
  /** Token type (usually "Bearer") */
  tokenType: string;
  /** Token lifetime in seconds */
  expiresIn: number;
  /** Granted scopes */
  scope: string;
  /** Token issue timestamp */
  issuedAt?: number;
}

/**
 * OAuth authentication state
 */
export interface OAuthAuthState {
  /** Current token information */
  token: OAuthTokenInfo | null;
  /** Authentication status */
  isAuthenticated: boolean;
  /** Token expiry timestamp */
  expiresAt?: number;
  /** Last refresh timestamp */
  lastRefresh?: number;
  /** Authentication method used */
  authMethod: 'device_flow' | 'auth_code' | 'client_credentials' | 'refresh_token';
  /** Provider ID */
  providerId: string;
}

/**
 * OAuth configuration manager
 */
export class OAuthConfigManager {
  private static instance: OAuthConfigManager;
  private configs: Map<string, OAuthProviderConfig> = new Map();
  private authStates: Map<string, OAuthAuthState> = new Map();
  private readonly defaultTokenDir: string;

  /**
   * Get singleton instance
   */
  static getInstance(): OAuthConfigManager {
    if (!OAuthConfigManager.instance) {
      OAuthConfigManager.instance = new OAuthConfigManager();
    }
    return OAuthConfigManager.instance;
  }

  /**
   * Constructor
   */
  private constructor() {
    this.defaultTokenDir = path.join(homedir(), '.routecodex', 'oauth');
  }

  /**
   * Register OAuth provider configuration
   */
  registerProvider(providerId: string, config: OAuthProviderConfig): void {
    // Validate required fields
    if (!config.clientId || !config.clientSecret || !config.tokenUrl) {
      throw new Error(`Missing required OAuth configuration for provider: ${providerId}`);
    }

    // Set default values
    const finalConfig: OAuthProviderConfig = {
      refreshBuffer: 5 * 60 * 1000, // 5 minutes
      tokenFile: path.join(this.defaultTokenDir, `${providerId}-token.json`),
      credentialsFile: path.join(this.defaultTokenDir, `${providerId}-credentials.json`),
      ...config
    };

    this.configs.set(providerId, finalConfig);

    // Initialize auth state
    this.authStates.set(providerId, {
      token: null,
      isAuthenticated: false,
      authMethod: 'device_flow',
      providerId
    });
  }

  /**
   * Get provider configuration
   */
  getProviderConfig(providerId: string): OAuthProviderConfig | null {
    return this.configs.get(providerId) || null;
  }

  /**
   * Get all registered provider IDs
   */
  getProviderIds(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Check if provider is registered
   */
  hasProvider(providerId: string): boolean {
    return this.configs.has(providerId);
  }

  /**
   * Update provider configuration
   */
  updateProviderConfig(providerId: string, updates: Partial<OAuthProviderConfig>): void {
    const existing = this.configs.get(providerId);
    if (!existing) {
      throw new Error(`Provider not registered: ${providerId}`);
    }

    this.configs.set(providerId, { ...existing, ...updates });
  }

  /**
   * Remove provider configuration
   */
  removeProvider(providerId: string): void {
    this.configs.delete(providerId);
    this.authStates.delete(providerId);
  }

  /**
   * Get authentication state for provider
   */
  getAuthState(providerId: string): OAuthAuthState | null {
    return this.authStates.get(providerId) || null;
  }

  /**
   * Update authentication state
   */
  updateAuthState(providerId: string, state: Partial<OAuthAuthState>): void {
    const existing = this.authStates.get(providerId);
    if (!existing) {
      throw new Error(`Provider not registered: ${providerId}`);
    }

    this.authStates.set(providerId, { ...existing, ...state });
  }

  /**
   * Set authentication token
   */
  async setAuthToken(providerId: string, token: OAuthTokenInfo): Promise<void> {
    const config = this.getProviderConfig(providerId);
    if (!config) {
      throw new Error(`Provider not registered: ${providerId}`);
    }

    // Calculate expiry timestamp
    const issuedAt = token.issuedAt || Date.now();
    const expiresAt = issuedAt + (token.expiresIn * 1000);

    // Update auth state
    this.updateAuthState(providerId, {
      token,
      isAuthenticated: true,
      expiresAt,
      lastRefresh: Date.now()
    });

    // Save token to file
    await this.saveToken(providerId, token);
  }

  /**
   * Clear authentication state
   */
  clearAuthState(providerId: string): void {
    this.updateAuthState(providerId, {
      token: null,
      isAuthenticated: false,
      expiresAt: undefined,
      lastRefresh: undefined
    });
  }

  /**
   * Check if token needs refresh
   */
  needsTokenRefresh(providerId: string): boolean {
    const state = this.getAuthState(providerId);
    if (!state || !state.isAuthenticated || !state.expiresAt) {
      return true;
    }

    const config = this.getProviderConfig(providerId);
    if (!config) {
      return true;
    }

    const refreshBuffer = config.refreshBuffer || 5 * 60 * 1000;
    const timeUntilExpiry = state.expiresAt - Date.now();

    return timeUntilExpiry <= refreshBuffer;
  }

  /**
   * Save token to file
   */
  private async saveToken(providerId: string, token: OAuthTokenInfo): Promise<void> {
    const config = this.getProviderConfig(providerId);
    if (!config || !config.tokenFile) {
      return;
    }

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(config.tokenFile), { recursive: true });

      // Add timestamp for tracking
      const tokenWithTimestamp = {
        ...token,
        issuedAt: Date.now(),
        savedAt: Date.now()
      };

      await fs.writeFile(config.tokenFile, JSON.stringify(tokenWithTimestamp, null, 2));
    } catch (error) {
      console.warn(`Failed to save OAuth token for ${providerId}:`, error);
    }
  }

  /**
   * Load token from file
   */
  async loadToken(providerId: string): Promise<OAuthTokenInfo | null> {
    const config = this.getProviderConfig(providerId);
    if (!config || !config.tokenFile) {
      return null;
    }

    try {
      const tokenData = await fs.readFile(config.tokenFile, 'utf-8');
      const parsedToken = JSON.parse(tokenData);

      // Validate token structure
      if (!parsedToken.accessToken || !parsedToken.expiresIn) {
        throw new Error('Invalid token format');
      }

      return parsedToken as OAuthTokenInfo;
    } catch (error) {
      // Token file doesn't exist or is invalid
      return null;
    }
  }

  /**
   * Delete token file
   */
  async deleteTokenFile(providerId: string): Promise<void> {
    const config = this.getProviderConfig(providerId);
    if (!config || !config.tokenFile) {
      return;
    }

    try {
      await fs.unlink(config.tokenFile);
    } catch (error) {
      // File doesn't exist or other error - ignore
    }
  }

  /**
   * Get token directory path
   */
  getTokenDir(): string {
    return this.defaultTokenDir;
  }

  /**
   * Export all configurations (for debugging/backup)
   */
  exportConfigurations(): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [providerId, config] of this.configs) {
      result[providerId] = {
        ...config,
        // Don't export sensitive data
        clientSecret: '[REDACTED]',
        tokenFile: config.tokenFile,
        credentialsFile: config.credentialsFile
      };
    }

    return result;
  }

  /**
   * Clear all configurations and states
   */
  clear(): void {
    this.configs.clear();
    this.authStates.clear();
  }
}