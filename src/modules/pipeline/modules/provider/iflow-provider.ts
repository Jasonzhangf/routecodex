/**
 * iFlow Provider Implementation
 *
 * Provides iFlow API integration with OAuth 2.0 Device Flow authentication,
 * PKCE security, token management, and automatic refresh capabilities.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse, ProviderError } from '../../types/provider-types.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { AuthResolver } from '../../utils/auth-resolver.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * iFlow OAuth Configuration
 */
interface iFlowOAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  deviceCodeUrl: string;
  scopes: string[];
  tokenFile?: string;
  credentialsFile?: string;
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
}

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
 * iFlow Credentials (from existing file)
 */
interface iFlowCredentials {
  username?: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
}

/**
 * iFlow Provider Module
 */
export class iFlowProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'iflow-http';
  readonly providerType = 'iflow';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private healthStatus: any = null;
  private requestCount = 0;
  private successCount = 0;
  private errorCount = 0;
  private totalResponseTime = 0;
  private authResolver: AuthResolver;

  // OAuth configuration
  private oauthConfig: iFlowOAuthConfig = {
    clientId: '10009311001',
    clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
    authUrl: 'https://iflow.cn/oauth',
    tokenUrl: 'https://iflow.cn/oauth/token',
    deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
    scopes: ['openid', 'profile', 'api'],
    tokenFile: process.env.HOME ? `${process.env.HOME}/.iflow/oauth_creds.json` : './iflow-token.json',
    credentialsFile: process.env.HOME ? `${process.env.HOME}/.iflow/credentials.json` : './iflow-credentials.json'
  };

  // API endpoint
  private apiEndpoint: string = 'https://api.iflow.cn/v1';

  // Token management
  private tokenData: OAuthTokenResponse | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;

  // Authentication state
  private isAuthenticating = false;
  private authPromise: Promise<void> | null = null;

  // PKCE state
  private pkceCodeVerifier: string | null = null;
  private pkceCodeChallenge: string | null = null;

  // Test mode flag
  private isTestMode: boolean = false;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as any;

    // 初始化AuthResolver
    const providerConfig = config.config as any;
    this.authResolver = new AuthResolver(providerConfig.authMappings || {});
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config,
        providerType: this.providerType
      });

      // Validate configuration
      this.validateConfig();

      // Load existing credentials or start OAuth flow
      await this.initializeAuthentication();

      // Perform initial health check
      await this.checkHealth();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Send to iFlow API
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('iFlow Provider is not initialized');
    }

    if (!this.authContext) {
      throw new Error('iFlow Provider is not authenticated');
    }

    try {
      const startTime = Date.now();
      this.requestCount++;

      this.logger.logProviderRequest(this.id, 'request-start', {
        endpoint: this.getEndpoint(),
        method: 'POST',
        hasAuth: !!this.authContext,
        hasTools: !!request.tools
      });

      // 根据认证类型选择请求方式
      let response;
      if (this.authContext.type === 'apikey') {
        response = await this.sendApiKeyRequest(request);
      } else {
        response = await this.sendChatRequest(request);
      }

      // Update metrics
      const responseTime = Date.now() - startTime;
      this.totalResponseTime += responseTime;
      this.successCount++;

      this.logger.logProviderRequest(this.id, 'request-success', {
        responseTime,
        status: response.status
      });

      return response;

    } catch (error) {
      this.errorCount++;
      await this.handleProviderError(error, request);
      throw error;
    }
  }

  /**
   * Process outgoing response - Not typically used for providers
   */
  async processOutgoing(response: any): Promise<any> {
    return response;
  }

  /**
   * Send request to provider
   */
  async sendRequest(request: any, options?: any): Promise<ProviderResponse> {
    return this.processIncoming(request);
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const startTime = Date.now();

      // Check authentication status
      let isAuthValid = false;
      if (this.authContext) {
        if (this.authContext.type === 'apikey') {
          // For API key auth, just check if token exists
          isAuthValid = !!this.authContext.token;
        } else {
          // For OAuth, validate token
          isAuthValid = await this.validateToken();
        }
      }

      const responseTime = Date.now() - startTime;
      this.healthStatus = {
        status: isAuthValid ? 'healthy' : 'unhealthy',
        timestamp: Date.now(),
        responseTime,
        details: {
          authentication: isAuthValid ? 'valid' : 'invalid',
          authType: this.authContext?.type || 'unknown',
          tokenExpiry: this.tokenData ? new Date(Date.now() + (this.tokenData.expires_in * 1000)).toISOString() : 'unknown'
        }
      };

      this.logger.logProviderRequest(this.id, 'health-check', this.healthStatus);

      return isAuthValid;

    } catch (error) {
      this.healthStatus = {
        status: 'unhealthy',
        timestamp: Date.now(),
        responseTime: 0,
        details: {
          authentication: 'unknown',
          error: error instanceof Error ? error.message : String(error)
        }
      };

      this.logger.logProviderRequest(this.id, 'health-check', { error });
      return false;
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Clear token refresh timer
      if (this.tokenRefreshTimer) {
        clearInterval(this.tokenRefreshTimer);
        this.tokenRefreshTimer = null;
      }

      // Reset state
      this.isInitialized = false;
      this.authContext = null;
      this.tokenData = null;
      this.healthStatus = null;
      this.pkceCodeVerifier = null;
      this.pkceCodeChallenge = null;

      this.logger.logModule(this.id, 'cleanup-complete');

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get provider status
   */
  getStatus(): {
    id: string;
    type: string;
    providerType: string;
    isInitialized: boolean;
    authStatus: string;
    healthStatus: any;
    requestMetrics: any;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      authStatus: this.authContext ? 'authenticated' : 'unauthenticated',
      healthStatus: this.healthStatus,
      requestMetrics: {
        requestCount: this.requestCount,
        successCount: this.successCount,
        errorCount: this.errorCount,
        averageResponseTime: this.requestCount > 0 ? Math.round(this.totalResponseTime / this.requestCount) : 0
      },
      lastActivity: Date.now()
    };
  }

  /**
   * Get provider metrics
   */
  async getMetrics(): Promise<any> {
    return {
      requestCount: this.requestCount,
      successCount: this.successCount,
      errorCount: this.errorCount,
      averageResponseTime: this.requestCount > 0 ? Math.round(this.totalResponseTime / this.requestCount) : 0,
      timestamp: Date.now(),
      tokenStatus: this.tokenData ? {
        expiresAt: new Date(Date.now() + (this.tokenData.expires_in * 1000)).toISOString(),
        hasRefreshToken: !!this.tokenData.refresh_token
      } : null
    };
  }

  /**
   * Validate provider configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'iflow-http') {
      throw new Error('Invalid provider type configuration');
    }

    const providerConfig = this.config.config as ProviderConfig;
    if (!providerConfig.baseUrl) {
      throw new Error('Provider base URL is required');
    }

    // Check if using auth file resolution or OAuth
    if (providerConfig.auth && providerConfig.auth.type === 'apikey') {
      // Using auth file resolution - validate auth configuration
      if (!providerConfig.auth.apiKey) {
        throw new Error('Auth API key configuration is required');
      }
    } else {
      // Using OAuth - Override OAuth config if provided in provider config
      if (providerConfig.auth && providerConfig.auth.oauth) {
        Object.assign(this.oauthConfig, providerConfig.auth.oauth);
      }
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      baseUrl: providerConfig.baseUrl,
      clientId: this.oauthConfig.clientId
    });
  }

  /**
   * Initialize authentication
   */
  private async initializeAuthentication(): Promise<void> {
    try {
      const providerConfig = this.config.config as ProviderConfig;

      // Check if using auth file resolution or OAuth
      if (providerConfig.auth && providerConfig.auth.type === 'apikey') {
        // Using auth file resolution
        await this.initializeAuthFileResolution();
      } else {
        // Using OAuth flow
        await this.initializeOAuthFlow();
      }

      this.logger.logModule(this.id, 'auth-initialized', {
        hasToken: !!this.authContext?.token,
        authType: this.authContext?.type
      });

    } catch (error) {
      this.logger.logModule(this.id, 'auth-initialization-error', { error });
      throw error;
    }
  }

  /**
   * Initialize auth file resolution
   */
  private async initializeAuthFileResolution(): Promise<void> {
    const providerConfig = this.config.config as ProviderConfig;
    const authConfig = providerConfig.auth;

    // 使用AuthResolver解析token
    const actualApiKey = await this.authResolver.resolveToken(authConfig!.apiKey);

    this.authContext = {
      type: authConfig!.type,
      token: actualApiKey,
      credentials: {
        apiKey: actualApiKey,
        headerName: authConfig!.headerName || 'Authorization',
        prefix: authConfig!.prefix || 'Bearer '
      },
      metadata: {
        provider: 'iflow',
        initialized: Date.now(),
        authKeyId: authConfig!.apiKey?.startsWith('auth-') ? authConfig!.apiKey : undefined
      }
    };

    this.logger.logModule(this.id, 'auth-file-resolution-initialized', {
      type: authConfig!.type,
      hasToken: !!this.authContext.token,
      authKeyId: this.authContext.metadata?.authKeyId
    });
  }

  /**
   * Initialize OAuth flow
   */
  private async initializeOAuthFlow(): Promise<void> {
    // Try to load existing token and credentials
    await this.loadCredentials();
    await this.loadToken();

    if (this.tokenData) {
      // Validate and refresh if needed
      const isValid = await this.validateToken();
      if (!isValid) {
        await this.refreshToken();
      }
    } else {
      // Start OAuth device flow with PKCE
      await this.startOAuthFlow();
    }

    // Setup automatic token refresh
    this.setupTokenRefresh();

    // Create auth context
    this.authContext = {
      type: 'oauth',
      token: this.tokenData!.access_token,
      credentials: {
        accessToken: this.tokenData!.access_token,
        refreshToken: this.tokenData!.refresh_token,
        tokenType: this.tokenData!.token_type,
        expiresAt: Date.now() + (this.tokenData!.expires_in * 1000)
      },
      metadata: {
        provider: 'iflow',
        clientId: this.oauthConfig.clientId,
        scopes: this.oauthConfig.scopes,
        initialized: Date.now()
      }
    };

    // Notify调度中心认证成功
    await this.notifyAuthStatus('authenticated', {
      provider: 'iflow',
      tokenExpiry: new Date(Date.now() + (this.tokenData!.expires_in * 1000)).toISOString()
    });
  }

  /**
   * Load credentials from file
   */
  private async loadCredentials(): Promise<void> {
    try {
      const credentialsFile = this.oauthConfig.credentialsFile;
      if (!credentialsFile) {
        return;
      }
      const credentialsData = await fs.readFile(credentialsFile, 'utf-8');
      const credentials = JSON.parse(credentialsData) as iFlowCredentials;

      // Use credentials if available
      if (credentials.accessToken) {
        this.tokenData = {
          access_token: credentials.accessToken,
          refresh_token: credentials.refreshToken,
          token_type: 'Bearer',
          expires_in: 3600, // Default 1 hour
          scope: this.oauthConfig.scopes.join(' ')
        };
      }

      this.logger.logModule(this.id, 'credentials-loaded', {
        credentialsFile,
        hasAccessToken: !!credentials.accessToken
      });

    } catch (error) {
      // Credentials file doesn't exist or is invalid
      // This is expected for first-time setup
    }
  }

  /**
   * Save credentials to file
   */
  private async saveCredentials(): Promise<void> {
    try {
      const credentialsFile = this.oauthConfig.credentialsFile;
      if (!credentialsFile || !this.tokenData) {
        return;
      }
      const credentials: iFlowCredentials = {
        accessToken: this.tokenData.access_token,
        refreshToken: this.tokenData.refresh_token
      };

      await fs.writeFile(credentialsFile, JSON.stringify(credentials, null, 2));

      this.logger.logModule(this.id, 'credentials-saved', {
        credentialsFile,
        hasAccessToken: !!credentials.accessToken
      });

    } catch (error) {
      this.logger.logModule(this.id, 'credentials-save-error', { error });
    }
  }

  /**
   * Load token from file
   */
  private async loadToken(): Promise<void> {
    try {
      const tokenFile = this.oauthConfig.tokenFile;
      if (!tokenFile) {
        return;
      }

      // Ensure directory exists
      const tokenDir = path.dirname(tokenFile);
      await fs.mkdir(tokenDir, { recursive: true });

      const tokenData = await fs.readFile(tokenFile, 'utf-8');
      const parsedTokenData = JSON.parse(tokenData);

      // Handle iFlow's specific token format
      if (parsedTokenData.access_token && parsedTokenData.expiry_date) {
        // Convert iFlow format to standard OAuth format
        const currentTime = Date.now();
        const expiresInSeconds = Math.max(0, Math.floor((parsedTokenData.expiry_date - currentTime) / 1000));

        this.tokenData = {
          access_token: parsedTokenData.access_token,
          refresh_token: parsedTokenData.refresh_token,
          token_type: parsedTokenData.token_type || 'bearer',
          expires_in: expiresInSeconds,
          scope: parsedTokenData.scope || ''
        };

        this.logger.logModule(this.id, 'token-loaded', {
          tokenFile,
          format: 'iflow',
          hasRefreshToken: !!this.tokenData.refresh_token,
          expiresInSeconds
        });
      } else {
        // Try standard OAuth format
        this.tokenData = parsedTokenData;
        this.logger.logModule(this.id, 'token-loaded', {
          tokenFile,
          format: 'standard',
          hasRefreshToken: !!this.tokenData?.refresh_token
        });
      }

    } catch (error) {
      // Token file doesn't exist or is invalid
      this.tokenData = null;
      this.logger.logModule(this.id, 'token-load-failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Save token to file
   */
  private async saveToken(): Promise<void> {
    try {
      const tokenFile = this.oauthConfig.tokenFile;
      if (!tokenFile || !this.tokenData) {
        return;
      }

      // Ensure directory exists
      const tokenDir = path.dirname(tokenFile);
      await fs.mkdir(tokenDir, { recursive: true });

      await fs.writeFile(tokenFile, JSON.stringify(this.tokenData, null, 2));

      this.logger.logModule(this.id, 'token-saved', {
        tokenFile,
        hasRefreshToken: !!this.tokenData.refresh_token
      });

    } catch (error) {
      this.logger.logModule(this.id, 'token-save-error', { error });
    }
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCECodes(): { codeVerifier: string; codeChallenge: string } {
    // Generate code verifier (random string)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Generate code challenge (SHA256 hash of verifier)
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }

  /**
   * Start OAuth device flow with PKCE
   */
  private async startOAuthFlow(): Promise<void> {
    this.logger.logModule(this.id, 'oauth-flow-start');

    // Generate PKCE codes
    const pkceCodes = this.generatePKCECodes();
    this.pkceCodeVerifier = pkceCodes.codeVerifier;
    this.pkceCodeChallenge = pkceCodes.codeChallenge;

    // Get device code with PKCE
    const deviceCode = await this.getDeviceCode();

    console.log('\\n🔐 iFlow OAuth Authentication Required');
    console.log('==========================================');
    console.log(`📱 User Code: ${deviceCode.user_code}`);
    console.log(`🌐 Verification URL: ${deviceCode.verification_uri}`);
    console.log(`🔗 Complete URL: ${deviceCode.verification_uri_complete}`);
    console.log('==========================================');
    console.log('⏳ Please open the URL above and enter the user code to authenticate...');
    console.log('');

    // Poll for token with PKCE
    await this.pollForToken(deviceCode);

    this.logger.logModule(this.id, 'oauth-flow-complete');
  }

  /**
   * Get device code from iFlow with PKCE
   */
  private async getDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await fetch(this.oauthConfig.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: this.oauthConfig.clientId,
        scope: this.oauthConfig.scopes.join(' '),
        code_challenge: this.pkceCodeChallenge!,
        code_challenge_method: 'S256'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to get device code: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Poll for token using device code with PKCE
   */
  private async pollForToken(deviceCode: DeviceCodeResponse): Promise<void> {
    const maxAttempts = (deviceCode.expires_in / deviceCode.interval) + 10;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(this.oauthConfig.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: this.oauthConfig.clientId,
            client_secret: this.oauthConfig.clientSecret,
            device_code: deviceCode.device_code,
            code_verifier: this.pkceCodeVerifier!
          })
        });

        const data = await response.json();

        if (response.ok) {
          this.tokenData = data as OAuthTokenResponse;
          await this.saveToken();
          await this.saveCredentials();
          return;
        }

        // Check if we need to continue polling
        if (data.error === 'authorization_pending') {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, deviceCode.interval * 1000));
          continue;
        }

        // Handle other errors
        throw new Error(`OAuth error: ${data.error} - ${data.error_description}`);

      } catch (error) {
        if (attempts >= maxAttempts - 1) {
          throw error;
        }
        attempts++;
        await new Promise(resolve => setTimeout(resolve, deviceCode.interval * 1000));
      }
    }

    throw new Error('OAuth token polling timed out');
  }

  /**
   * Validate current token
   */
  private async validateToken(): Promise<boolean> {
    if (!this.tokenData) {
      return false;
    }

    // Check if token is expired (with 5 minute buffer)
    const expiresAt = Date.now() + (this.tokenData.expires_in * 1000);
    const isExpired = expiresAt <= Date.now() + (5 * 60 * 1000);

    if (isExpired) {
      return false;
    }

    // Optionally validate with a test request
    try {
      const response = await fetch(`${this.apiEndpoint}/models`, {
        headers: {
          'Authorization': `Bearer ${this.tokenData.access_token}`,
          'Content-Type': 'application/json'
        }
      });

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Refresh access token
   */
  private async refreshToken(): Promise<void> {
    if (!this.tokenData?.refresh_token) {
      const error = new Error('No refresh token available, please re-authenticate');
      await this.notifyAuthStatus('error', {
        reason: 'no_refresh_token',
        error: error.message
      });
      throw error;
    }

    this.logger.logModule(this.id, 'token-refresh-start');

    try {
      const response = await fetch(this.oauthConfig.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.oauthConfig.clientId,
          client_secret: this.oauthConfig.clientSecret,
          refresh_token: this.tokenData.refresh_token
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Failed to refresh token: ${response.status} ${response.statusText} - ${errorText}`);

        // If refresh fails, notify and try to re-authenticate
        await this.notifyAuthStatus('expired', {
          reason: 'refresh_token_failed',
          error: error.message,
          status: response.status
        });

        throw error;
      }

      this.tokenData = await response.json() as OAuthTokenResponse;
      await this.saveToken();
      await this.saveCredentials();

      // Update auth context
      if (this.authContext) {
        this.authContext.token = this.tokenData.access_token;
        this.authContext.credentials = {
          ...this.authContext.credentials,
          accessToken: this.tokenData.access_token,
          refreshToken: this.tokenData.refresh_token,
          expiresAt: Date.now() + (this.tokenData.expires_in * 1000)
        };
      }

      // Notify successful refresh
      await this.notifyAuthStatus('authenticated', {
        provider: 'iflow',
        tokenExpiry: new Date(Date.now() + (this.tokenData.expires_in * 1000)).toISOString(),
        refreshed: true
      });

      this.logger.logModule(this.id, 'token-refresh-success');

    } catch (error) {
      this.logger.logModule(this.id, 'token-refresh-error', { error });
      throw error;
    }
  }

  /**
   * Setup automatic token refresh
   */
  private setupTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
    }

    // Refresh token 5 minutes before expiry
    const refreshInterval = (this.tokenData!.expires_in - 300) * 1000;

    this.tokenRefreshTimer = setInterval(async () => {
      try {
        await this.refreshToken();
      } catch (error) {
        this.logger.logModule(this.id, 'auto-refresh-error', { error });
        // If automatic refresh fails, notify dispatch center
        await this.notifyAuthStatus('expired', {
          reason: 'auto_refresh_failed',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, refreshInterval);

    this.logger.logModule(this.id, 'token-refresh-setup', {
      refreshInterval
    });
  }

  /**
   * Send API key request to iFlow (using auth file resolution)
   */
  private async sendApiKeyRequest(request: any): Promise<ProviderResponse> {
    const startTime = Date.now();
    const endpoint = `${this.apiEndpoint}/chat/completions`;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'RouteCodex/1.0.0'
      };

      // Add authentication header
      const authHeader = this.authContext!.credentials.headerName || 'Authorization';
      const authPrefix = this.authContext!.credentials.prefix || 'Bearer ';
      headers[authHeader] = authPrefix + this.authContext!.token;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`iFlow API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const processingTime = Date.now() - startTime;

      return {
        data,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          tokensUsed: data.usage?.total_tokens,
          model: request.model
        }
      };

    } catch (error) {
      throw this.createProviderError(error, 'network');
    }
  }

  /**
   * Send chat request to iFlow
   */
  private async sendChatRequest(request: any): Promise<ProviderResponse> {
    const startTime = Date.now();
    const endpoint = `${this.apiEndpoint}/chat/completions`;

    // Check token expiry before sending request
    if (this.isTokenExpired()) {
      this.logger.logModule(this.id, 'token-expired-detected', {
        tokenExpiry: new Date(Date.now() + (this.tokenData!.expires_in * 1000)).toISOString()
      });

      try {
        await this.refreshToken();
      } catch (refreshError) {
        // If refresh fails, notify and try to re-authenticate
        await this.notifyAuthStatus('expired', {
          reason: 'token_refresh_failed',
          error: refreshError instanceof Error ? refreshError.message : String(refreshError)
        });
        throw refreshError;
      }
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.tokenData!.access_token}`,
          'User-Agent': 'RouteCodex/1.0.0'
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`iFlow API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const processingTime = Date.now() - startTime;

      return {
        data,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        metadata: {
          requestId: `req-${Date.now()}`,
          processingTime,
          tokensUsed: data.usage?.total_tokens,
          model: request.model
        }
      };

    } catch (error) {
      throw this.createProviderError(error, 'network');
    }
  }

  /**
   * Get API endpoint
   */
  private getEndpoint(): string {
    return this.apiEndpoint;
  }

  /**
   * Handle provider errors
   */
  private async handleProviderError(error: any, request: any): Promise<void> {
    const providerError = this.createProviderError(error, 'unknown');

    this.logger.logModule(this.id, 'provider-error', {
      error: providerError,
      request: {
        model: request.model,
        hasMessages: !!request.messages,
        hasTools: !!request.tools
      }
    });

    // Integrate with error handling center
    await this.dependencies.errorHandlingCenter.handleError({
      type: 'provider-error',
      message: providerError.message,
      details: {
        providerId: this.id,
        error: providerError,
        request
      },
      timestamp: Date.now()
    });
  }

  /**
   * Create provider error
   */
  private createProviderError(error: unknown, type: string): ProviderError {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
    providerError.type = type as any;
    providerError.statusCode = (error as any).status || (error as any).statusCode;
    providerError.details = (error as any).details || error;
    providerError.retryable = this.isErrorRetryable(type);

    return providerError;
  }

  /**
   * Check if error is retryable
   */
  private isErrorRetryable(errorType: string): boolean {
    const retryableTypes = ['network', 'timeout', 'rate_limit', 'server'];
    return retryableTypes.includes(errorType);
  }

  /**
   * Notify dispatch center of authentication status changes
   */
  private async notifyAuthStatus(status: 'authenticated' | 'expired' | 'error', details: any): Promise<void> {
    try {
      // Log authentication status change
      this.logger.logModule(this.id, 'auth-status-change', {
        status,
        details,
        timestamp: Date.now()
      });

      // Send notification to dispatch center if available
      if (this.dependencies.dispatchCenter) {
        await this.dependencies.dispatchCenter.notify({
          type: 'auth-status-change',
          provider: 'iflow',
          status,
          details,
          timestamp: Date.now()
        });
      }

      // If authentication failed, open browser for re-authentication
      if (status === 'expired' || status === 'error') {
        await this.openAuthenticationPage();
      }

    } catch (error) {
      this.logger.logModule(this.id, 'auth-notification-error', { error });
      // Don't throw error for notification failures
    }
  }

  /**
   * Set test mode (disables browser opening)
   */
  public setTestMode(isTestMode: boolean): void {
    this.isTestMode = isTestMode;
    this.logger.logModule(this.id, 'test-mode-set', { isTestMode });
  }

  /**
   * Open browser authentication page for re-authentication
   */
  private async openAuthenticationPage(): Promise<void> {
    // Don't open browser in test mode
    if (this.isTestMode) {
      this.logger.logModule(this.id, 'browser-open-skipped', {
        reason: 'test_mode_enabled',
        url: 'https://iflow.cn'
      });
      return;
    }

    try {
      const { exec } = await import('child_process');
      const iflowAuthUrl = 'https://iflow.cn';

      // Try to open browser based on platform
      const platform = process.platform;
      let command: string;

      switch (platform) {
        case 'darwin': // macOS
          command = `open "${iflowAuthUrl}"`;
          break;
        case 'win32': // Windows
          command = `start "${iflowAuthUrl}"`;
          break;
        default: // Linux and others
          command = `xdg-open "${iflowAuthUrl}"`;
      }

      exec(command, (error) => {
        if (error) {
          this.logger.logModule(this.id, 'browser-open-error', { error: error.message });
        } else {
          this.logger.logModule(this.id, 'browser-opened', { url: iflowAuthUrl });
        }
      });

    } catch (error) {
      this.logger.logModule(this.id, 'auth-page-open-error', { error });
    }
  }

  /**
   * Check if token is expired or about to expire
   */
  private isTokenExpired(): boolean {
    if (!this.tokenData) {
      return true;
    }

    // Consider expired if less than 30 seconds remaining
    const bufferTime = 30;
    return this.tokenData.expires_in <= bufferTime;
  }
}