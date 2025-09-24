/**
 * Qwen OAuth Implementation
 *
 * Complete rewrite based on CLIProxyAPI's Qwen authentication implementation
 * Using exact OAuth constants, PKCE flow, and token format
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// OAuth Configuration - EXACT copy from CLIProxyAPI
const QWEN_OAUTH_CONFIG = {
    DEVICE_CODE_ENDPOINT: "https://chat.qwen.ai/api/v1/oauth2/device/code",
    TOKEN_ENDPOINT: "https://chat.qwen.ai/api/v1/oauth2/token",
    CLIENT_ID: "f0304373b74a44d2b584a3fb70ca9e56",
    SCOPE: "openid profile email model.completion",
    GRANT_TYPE: "urn:ietf:params:oauth:grant-type:device_code"
};
// API Endpoint - EXACT copy from CLIProxyAPI
const QWEN_API_ENDPOINT = "https://portal.qwen.ai/v1";
/**
 * Qwen Token Storage Format - EXACT copy from CLIProxyAPI
 */
export class QwenTokenStorage {
    constructor(data = {}) {
        this.access_token = data.access_token || '';
        this.refresh_token = data.refresh_token || '';
        this.last_refresh = data.last_refresh || new Date().toISOString();
        this.resource_url = data.resource_url || '';
        this.email = data.email || '';
        this.type = data.type || 'qwen';
        this.expired = data.expired || '';
    }
    toJSON() {
        return {
            access_token: this.access_token,
            refresh_token: this.refresh_token,
            last_refresh: this.last_refresh,
            resource_url: this.resource_url,
            email: this.email,
            type: this.type,
            expired: this.expired
        };
    }
    static fromJSON(json) {
        return new QwenTokenStorage(json);
    }
    isExpired() {
        if (!this.expired)
            return true;
        return new Date(this.expired) <= new Date();
    }
    getAuthorizationHeader() {
        return `Bearer ${this.access_token}`;
    }
}
/**
 * Qwen OAuth Authentication - EXACT copy from CLIProxyAPI logic
 */
export class QwenOAuth {
    constructor(config = {}) {
        this.tokenFile = config.tokenFile || path.join(process.env.HOME || '', '.qwen', 'oauth_creds.json');
        this.tokenStorage = null;
        this.httpClient = config.httpClient || fetch;
    }
    /**
     * Generate PKCE code verifier - EXACT copy from CLIProxyAPI
     */
    generateCodeVerifier() {
        const bytes = crypto.randomBytes(32);
        return bytes.toString('base64url');
    }
    /**
     * Generate PKCE code challenge - EXACT copy from CLIProxyAPI
     */
    generateCodeChallenge(codeVerifier) {
        const hash = crypto.createHash('sha256').update(codeVerifier).digest();
        return hash.toString('base64url');
    }
    /**
     * Generate PKCE pair - EXACT copy from CLIProxyAPI
     */
    generatePKCEPair() {
        const codeVerifier = this.generateCodeVerifier();
        const codeChallenge = this.generateCodeChallenge(codeVerifier);
        return { codeVerifier, codeChallenge };
    }
    /**
     * Initiate device flow - EXACT copy from CLIProxyAPI
     */
    async initiateDeviceFlow() {
        const { codeVerifier, codeChallenge } = this.generatePKCEPair();
        const formData = new URLSearchParams({
            client_id: QWEN_OAUTH_CONFIG.CLIENT_ID,
            scope: QWEN_OAUTH_CONFIG.SCOPE,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        });
        const response = await this.httpClient(QWEN_OAUTH_CONFIG.DEVICE_CODE_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Device authorization failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
        }
        const data = await response.json();
        // Check if the response indicates success
        if (!data.device_code) {
            throw new Error('Device authorization failed: device_code not found in response');
        }
        // Add the code_verifier to the result so it can be used later for polling
        data.code_verifier = codeVerifier;
        return data;
    }
    /**
     * Poll for token - EXACT copy from CLIProxyAPI
     */
    async pollForToken(deviceCode, codeVerifier) {
        let pollInterval = 5000; // 5 seconds
        const maxAttempts = 60; // 5 minutes max
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const formData = new URLSearchParams({
                grant_type: QWEN_OAUTH_CONFIG.GRANT_TYPE,
                client_id: QWEN_OAUTH_CONFIG.CLIENT_ID,
                device_code: deviceCode,
                code_verifier: codeVerifier
            });
            try {
                const response = await this.httpClient(QWEN_OAUTH_CONFIG.TOKEN_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    },
                    body: formData
                });
                const bodyText = await response.text();
                if (response.status !== 200) {
                    // Parse the response as JSON to check for OAuth RFC 8628 standard errors
                    try {
                        const errorData = JSON.parse(bodyText);
                        if (response.status === 400) {
                            const errorType = errorData.error;
                            switch (errorType) {
                                case "authorization_pending":
                                    // User has not yet approved the authorization request. Continue polling.
                                    console.log(`Polling attempt ${attempt + 1}/${maxAttempts}...`);
                                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                                    continue;
                                case "slow_down":
                                    // Client is polling too frequently. Increase poll interval.
                                    pollInterval = Math.min(pollInterval * 1.5, 10000);
                                    console.log(`Server requested to slow down, increasing poll interval to ${pollInterval}ms`);
                                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                                    continue;
                                case "expired_token":
                                    throw new Error('Device code expired. Please restart the authentication process');
                                case "access_denied":
                                    throw new Error('Authorization denied by user. Please restart the authentication process');
                            }
                        }
                        // For other errors, return with proper error information
                        const errorType = errorData.error || 'unknown';
                        const errorDesc = errorData.error_description || 'Unknown error';
                        throw new Error(`Device token poll failed: ${errorType} - ${errorDesc}`);
                    }
                    catch (parseError) {
                        if (parseError instanceof SyntaxError) {
                            // If JSON parsing fails, fall back to text response
                            throw new Error(`Device token poll failed: ${response.status} ${response.statusText}. Response: ${bodyText}`);
                        }
                        throw parseError;
                    }
                }
                // Success - parse token data
                const tokenResponse = JSON.parse(bodyText);
                // Convert to QwenTokenData format and save
                const tokenData = {
                    access_token: tokenResponse.access_token,
                    refresh_token: tokenResponse.refresh_token || '',
                    token_type: tokenResponse.token_type,
                    resource_url: tokenResponse.resource_url || '',
                    expire: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
                };
                return tokenData;
            }
            catch (error) {
                console.log(`Polling attempt ${attempt + 1}/${maxAttempts} failed:`, error instanceof Error ? error.message : String(error));
                if (attempt === maxAttempts - 1) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
        }
        throw new Error('Authentication timeout. Please restart the authentication process');
    }
    /**
     * Refresh tokens - EXACT copy from CLIProxyAPI
     */
    async refreshTokens(refreshToken) {
        const formData = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: QWEN_OAUTH_CONFIG.CLIENT_ID
        });
        const response = await this.httpClient(QWEN_OAUTH_CONFIG.TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            try {
                const errorData = JSON.parse(errorText);
                throw new Error(`Token refresh failed: ${errorData.error} - ${errorData.error_description}`);
            }
            catch (parseError) {
                if (parseError instanceof SyntaxError) {
                    throw new Error(`Token refresh failed: ${errorText}`);
                }
                throw parseError;
            }
        }
        const tokenResponse = await response.json();
        return {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token || '',
            token_type: tokenResponse.token_type,
            resource_url: tokenResponse.resource_url || '',
            expire: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
        };
    }
    /**
     * Refresh tokens with retry - EXACT copy from CLIProxyAPI
     */
    async refreshTokensWithRetry(refreshToken, maxRetries = 3) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (attempt > 0) {
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, attempt * 1000));
            }
            try {
                const tokenData = await this.refreshTokens(refreshToken);
                return tokenData;
            }
            catch (error) {
                lastError = error;
                console.warn(`Token refresh attempt ${attempt + 1} failed:`, error instanceof Error ? error.message : String(error));
            }
        }
        throw new Error(`Token refresh failed after ${maxRetries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    /**
     * Create token storage - EXACT copy from CLIProxyAPI
     */
    createTokenStorage(tokenData) {
        return new QwenTokenStorage({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            last_refresh: new Date().toISOString(),
            resource_url: tokenData.resource_url,
            expired: tokenData.expire
        });
    }
    /**
     * Update token storage - EXACT copy from CLIProxyAPI
     */
    updateTokenStorage(storage, tokenData) {
        storage.access_token = tokenData.access_token;
        storage.refresh_token = tokenData.refresh_token;
        storage.last_refresh = new Date().toISOString();
        storage.resource_url = tokenData.resource_url;
        storage.expired = tokenData.expire;
    }
    /**
     * Load token from file
     */
    async loadToken() {
        try {
            const tokenContent = await fs.readFile(this.tokenFile, 'utf-8');
            const tokenData = JSON.parse(tokenContent);
            this.tokenStorage = QwenTokenStorage.fromJSON(tokenData);
            // Check if token is expired and refresh if needed
            if (this.tokenStorage.isExpired() && this.tokenStorage.refresh_token) {
                console.log('Token expired, attempting refresh...');
                try {
                    const newTokenData = await this.refreshTokensWithRetry(this.tokenStorage.refresh_token);
                    this.updateTokenStorage(this.tokenStorage, newTokenData);
                    await this.saveToken();
                    console.log('Token refreshed successfully');
                }
                catch (error) {
                    console.warn('Failed to refresh token:', error instanceof Error ? error.message : String(error));
                    // Continue with expired token, will trigger re-authentication on API call
                }
            }
            return this.tokenStorage;
        }
        catch (error) {
            // No token file exists or is invalid
            return null;
        }
    }
    /**
     * Save token to file
     */
    async saveToken() {
        if (!this.tokenStorage) {
            throw new Error('No token storage to save');
        }
        await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
        await fs.writeFile(this.tokenFile, JSON.stringify(this.tokenStorage.toJSON(), null, 2));
    }
    /**
     * Get API endpoint - EXACT copy from CLIProxyAPI logic
     */
    getAPIEndpoint() {
        if (this.tokenStorage && this.tokenStorage.resource_url) {
            return `https://${this.tokenStorage.resource_url}/v1`;
        }
        return QWEN_API_ENDPOINT;
    }
    /**
     * Get authorization header
     */
    getAuthorizationHeader() {
        if (!this.tokenStorage) {
            throw new Error('No token available');
        }
        return this.tokenStorage.getAuthorizationHeader();
    }
    /**
     * Check if authenticated
     */
    isAuthenticated() {
        return this.tokenStorage !== null && !this.tokenStorage.isExpired();
    }
    /**
     * Complete OAuth flow
     */
    async completeOAuthFlow(openBrowser = true) {
        try {
            console.log('Starting OAuth device flow...');
            // Initiate device flow
            const deviceFlow = await this.initiateDeviceFlow();
            console.log('Please visit the following URL to authenticate:');
            console.log(deviceFlow.verification_uri_complete);
            console.log(`User code: ${deviceFlow.user_code}`);
            // Open browser if requested
            if (openBrowser) {
                const { exec } = await import('child_process');
                const { promisify } = await import('util');
                const execAsync = promisify(exec);
                try {
                    await execAsync(`open "${deviceFlow.verification_uri_complete}"`);
                }
                catch (browserError) {
                    console.log('Could not open browser automatically. Please manually visit the URL above.');
                }
            }
            console.log('Waiting for authentication...');
            // Poll for token
            const tokenData = await this.pollForToken(deviceFlow.device_code, deviceFlow.code_verifier);
            // Create token storage
            this.tokenStorage = this.createTokenStorage(tokenData);
            // Save token
            await this.saveToken();
            console.log('OAuth authentication completed successfully!');
            return this.tokenStorage;
        }
        catch (error) {
            console.error('OAuth flow failed:', error instanceof Error ? error.message : String(error));
            throw error;
        }
    }
}
/**
 * Create Qwen OAuth instance
 */
export function createQwenOAuth(config = {}) {
    return new QwenOAuth(config);
}
/**
 * Complete OAuth flow and return token
 */
export async function completeQwenOAuth(config = {}) {
    const oauth = createQwenOAuth(config);
    return await oauth.completeOAuthFlow(config.openBrowser !== false);
}
