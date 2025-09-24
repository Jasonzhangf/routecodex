/**
 * Qwen Provider Implementation
 *
 * Complete rewrite based on CLIProxyAPI's Qwen client implementation
 * Using exact OAuth flow, API endpoints, and token format
 */
import { createQwenOAuth } from './qwen-oauth.js';
import { DebugEventBus } from '../../../../utils/external-mocks.js';
// API Endpoint - EXACT copy from CLIProxyAPI
const QWEN_API_ENDPOINT = "https://portal.qwen.ai/v1";
/**
 * Qwen Provider Module - Complete rewrite based on CLIProxyAPI
 */
export class QwenProvider {
    constructor(config, dependencies) {
        this.dependencies = dependencies;
        this.type = 'qwen-provider';
        this.providerType = 'qwen';
        this.isInitialized = false;
        this.authContext = null;
        this.healthStatus = null;
        this.oauth = null;
        this.tokenStorage = null;
        this.isTestMode = false;
        // Debug enhancement properties
        this.debugEventBus = null;
        this.isDebugEnhanced = false;
        this.providerMetrics = new Map();
        this.requestHistory = [];
        this.authHistory = [];
        this.errorHistory = [];
        this.maxHistorySize = 50;
        this.id = `provider-${Date.now()}`;
        this.config = config;
        this.logger = dependencies.logger;
        // Initialize OAuth with CLIProxyAPI-compatible settings
        this.oauth = createQwenOAuth({
            tokenFile: this.getTokenFile()
        });
        // Initialize debug enhancements
        this.initializeDebugEnhancements();
    }
    /**
     * Initialize debug enhancements
     */
    initializeDebugEnhancements() {
        try {
            this.debugEventBus = DebugEventBus.getInstance();
            this.isDebugEnhanced = true;
            console.log('Qwen Provider debug enhancements initialized');
        }
        catch (error) {
            console.warn('Failed to initialize Qwen Provider debug enhancements:', error);
            this.isDebugEnhanced = false;
        }
    }
    /**
     * Record provider metric
     */
    recordProviderMetric(operation, data) {
        if (!this.providerMetrics.has(operation)) {
            this.providerMetrics.set(operation, {
                values: [],
                lastUpdated: Date.now()
            });
        }
        const metric = this.providerMetrics.get(operation);
        metric.values.push(data);
        metric.lastUpdated = Date.now();
        // Keep only last 50 measurements
        if (metric.values.length > 50) {
            metric.values.shift();
        }
    }
    /**
     * Add to request history
     */
    addToRequestHistory(operation) {
        this.requestHistory.push(operation);
        // Keep only recent history
        if (this.requestHistory.length > this.maxHistorySize) {
            this.requestHistory.shift();
        }
    }
    /**
     * Add to auth history
     */
    addToAuthHistory(operation) {
        this.authHistory.push(operation);
        // Keep only recent history
        if (this.authHistory.length > this.maxHistorySize) {
            this.authHistory.shift();
        }
    }
    /**
     * Add to error history
     */
    addToErrorHistory(operation) {
        this.errorHistory.push(operation);
        // Keep only recent history
        if (this.errorHistory.length > this.maxHistorySize) {
            this.errorHistory.shift();
        }
    }
    /**
     * Publish debug event
     */
    publishDebugEvent(type, data) {
        if (!this.isDebugEnhanced || !this.debugEventBus)
            return;
        try {
            this.debugEventBus.publish({
                sessionId: `session_${Date.now()}`,
                moduleId: 'qwen-provider',
                operationId: type,
                timestamp: Date.now(),
                type: 'debug',
                position: 'middle',
                data: {
                    ...data,
                    providerId: this.id,
                    source: 'qwen-provider'
                }
            });
        }
        catch (error) {
            // Silent fail if debug event bus is not available
        }
    }
    /**
     * Get debug status with enhanced information
     */
    getDebugStatus() {
        const baseStatus = {
            id: this.id,
            type: this.type,
            providerType: this.providerType,
            isInitialized: this.isInitialized,
            healthStatus: this.healthStatus,
            hasAuth: !!this.authContext,
            hasToken: !!this.tokenStorage,
            isEnhanced: this.isDebugEnhanced
        };
        if (!this.isDebugEnhanced) {
            return baseStatus;
        }
        return {
            ...baseStatus,
            debugInfo: this.getDebugInfo(),
            providerMetrics: this.getProviderMetrics(),
            requestHistory: [...this.requestHistory.slice(-10)], // Last 10 requests
            authHistory: [...this.authHistory.slice(-5)], // Last 5 auth operations
            errorHistory: [...this.errorHistory.slice(-5)] // Last 5 errors
        };
    }
    /**
     * Get detailed debug information
     */
    getDebugInfo() {
        return {
            providerId: this.id,
            enhanced: this.isDebugEnhanced,
            eventBusAvailable: !!this.debugEventBus,
            requestHistorySize: this.requestHistory.length,
            authHistorySize: this.authHistory.length,
            errorHistorySize: this.errorHistory.length,
            providerMetricsSize: this.providerMetrics.size,
            maxHistorySize: this.maxHistorySize,
            apiEndpoint: this.getAPIEndpoint()
        };
    }
    /**
     * Get provider metrics
     */
    getProviderMetrics() {
        const metrics = {};
        for (const [operation, metric] of this.providerMetrics.entries()) {
            metrics[operation] = {
                count: metric.values.length,
                lastUpdated: metric.lastUpdated,
                recentValues: metric.values.slice(-5) // Last 5 values
            };
        }
        return metrics;
    }
    /**
     * Get token file path
     */
    getTokenFile() {
        const providerConfig = this.config.config;
        if (providerConfig.auth?.oauth?.tokenFile) {
            return providerConfig.auth.oauth.tokenFile;
        }
        return process.env.HOME ? `${process.env.HOME}/.qwen/oauth_creds.json` : './qwen-token.json';
    }
    /**
     * Initialize the provider
     */
    async initialize() {
        const startTime = Date.now();
        const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Debug: Record initialization start
        if (this.isDebugEnhanced) {
            this.recordProviderMetric('initialization_start', {
                initId,
                config: this.config,
                providerType: this.providerType,
                timestamp: startTime
            });
            this.publishDebugEvent('initialization_start', {
                initId,
                config: this.config,
                providerType: this.providerType,
                timestamp: startTime
            });
        }
        try {
            this.logger.logModule(this.id, 'initializing', {
                config: this.config,
                providerType: this.providerType
            });
            // Validate configuration
            this.validateConfig();
            // Initialize OAuth and load token
            await this.initializeAuth();
            // Perform initial health check
            await this.checkHealth();
            this.isInitialized = true;
            this.logger.logModule(this.id, 'initialized');
            const totalTime = Date.now() - startTime;
            // Debug: Record initialization completion
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('initialization_complete', {
                    initId,
                    success: true,
                    totalTime,
                    hasAuth: !!this.authContext,
                    hasToken: !!this.tokenStorage
                });
                this.publishDebugEvent('initialization_complete', {
                    initId,
                    success: true,
                    totalTime,
                    hasAuth: !!this.authContext,
                    hasToken: !!this.tokenStorage
                });
            }
        }
        catch (error) {
            const totalTime = Date.now() - startTime;
            // Debug: Record initialization failure
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('initialization_failed', {
                    initId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
                this.publishDebugEvent('initialization_failed', {
                    initId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
            }
            this.logger.logModule(this.id, 'initialization-error', { error });
            throw error;
        }
    }
    /**
     * Process incoming request - Send to Qwen provider
     */
    async processIncoming(request) {
        const startTime = Date.now();
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        if (!this.isInitialized) {
            throw new Error('Qwen Provider is not initialized');
        }
        // Debug: Record request processing start
        if (this.isDebugEnhanced) {
            this.recordProviderMetric('request_start', {
                requestId,
                requestType: typeof request,
                hasMessages: !!request.messages,
                hasTools: !!request.tools,
                model: request.model,
                timestamp: startTime
            });
            this.publishDebugEvent('request_start', {
                requestId,
                request,
                timestamp: startTime
            });
        }
        try {
            this.logger.logProviderRequest(this.id, 'request-start', {
                endpoint: this.getAPIEndpoint(),
                method: 'POST',
                hasAuth: !!this.tokenStorage
            });
            // Ensure we have a valid token
            await this.ensureValidToken();
            // Send HTTP request using CLIProxyAPI logic
            const response = await this.sendChatRequest(request);
            // Process response
            const processedResponse = this.processResponse(response);
            const totalTime = Date.now() - startTime;
            // Debug: Record request completion
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('request_complete', {
                    requestId,
                    success: true,
                    totalTime,
                    responseStatus: response.status,
                    hasChoices: !!processedResponse.choices,
                    choiceCount: processedResponse.choices?.length || 0
                });
                this.addToRequestHistory({
                    requestId,
                    request,
                    response: processedResponse,
                    startTime,
                    endTime: Date.now(),
                    totalTime,
                    success: true
                });
                this.publishDebugEvent('request_complete', {
                    requestId,
                    success: true,
                    totalTime,
                    response: processedResponse
                });
            }
            this.logger.logProviderRequest(this.id, 'request-success', {
                responseTime: response.metadata?.processingTime,
                status: response.status
            });
            return processedResponse;
        }
        catch (error) {
            const totalTime = Date.now() - startTime;
            // Debug: Record request failure
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('request_failed', {
                    requestId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
                this.addToErrorHistory({
                    requestId,
                    error,
                    request,
                    startTime,
                    endTime: Date.now(),
                    totalTime,
                    operation: 'processIncoming'
                });
                this.publishDebugEvent('request_failed', {
                    requestId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
            }
            await this.handleProviderError(error, request);
            throw error;
        }
    }
    /**
     * Process outgoing response - Not typically used for providers
     */
    async processOutgoing(response) {
        // For providers, outgoing response processing is usually minimal
        // as they are the final stage in the pipeline
        return response;
    }
    /**
     * Send request to provider
     */
    async sendRequest(request, options) {
        return this.processIncoming(request);
    }
    /**
     * Check provider health
     */
    async checkHealth() {
        try {
            const startTime = Date.now();
            // Perform health check request
            const healthCheck = await this.performHealthCheck();
            const responseTime = Date.now() - startTime;
            this.healthStatus = {
                status: healthCheck.isHealthy ? 'healthy' : 'unhealthy',
                timestamp: Date.now(),
                responseTime,
                details: healthCheck.details
            };
            this.logger.logProviderRequest(this.id, 'health-check', this.healthStatus);
            return healthCheck.isHealthy;
        }
        catch (error) {
            this.healthStatus = {
                status: 'unhealthy',
                timestamp: Date.now(),
                responseTime: 0,
                details: {
                    error: error instanceof Error ? error.message : String(error),
                    connectivity: 'disconnected'
                }
            };
            this.logger.logProviderRequest(this.id, 'health-check', { error });
            return false;
        }
    }
    /**
     * Clean up resources
     */
    async cleanup() {
        try {
            this.logger.logModule(this.id, 'cleanup-start');
            // Reset state
            this.isInitialized = false;
            this.authContext = null;
            this.healthStatus = null;
            this.tokenStorage = null;
            this.logger.logModule(this.id, 'cleanup-complete');
        }
        catch (error) {
            this.logger.logModule(this.id, 'cleanup-error', { error });
            throw error;
        }
    }
    /**
     * Get provider status
     */
    getStatus() {
        return {
            id: this.id,
            type: this.type,
            providerType: this.providerType,
            isInitialized: this.isInitialized,
            authStatus: this.tokenStorage ? 'authenticated' : 'unauthenticated',
            healthStatus: this.healthStatus,
            lastActivity: Date.now()
        };
    }
    /**
     * Get provider metrics
     */
    async getMetrics() {
        return {
            requestCount: 0, // Would track actual requests
            successCount: 0,
            errorCount: 0,
            averageResponseTime: 0,
            timestamp: Date.now()
        };
    }
    /**
     * Validate provider configuration
     */
    validateConfig() {
        if (!this.config.type || this.config.type !== 'qwen-provider') {
            throw new Error('Invalid Provider type configuration');
        }
        const providerConfig = this.config.config;
        if (!providerConfig.baseUrl && !providerConfig.auth?.oauth) {
            throw new Error('Provider base URL or OAuth configuration is required');
        }
        this.logger.logModule(this.id, 'config-validation-success', {
            type: this.config.type,
            baseUrl: providerConfig.baseUrl,
            hasOAuth: !!providerConfig.auth?.oauth
        });
    }
    /**
     * Initialize authentication
     */
    async initializeAuth() {
        const startTime = Date.now();
        const authId = `auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Debug: Record auth initialization start
        if (this.isDebugEnhanced) {
            this.recordProviderMetric('auth_initialization_start', {
                authId,
                tokenFile: this.getTokenFile(),
                timestamp: startTime
            });
            this.publishDebugEvent('auth_initialization_start', {
                authId,
                tokenFile: this.getTokenFile(),
                timestamp: startTime
            });
        }
        try {
            // Load existing token
            this.tokenStorage = await this.oauth.loadToken();
            if (this.tokenStorage) {
                this.logger.logModule(this.id, 'token-loaded', {
                    hasToken: !!this.tokenStorage.access_token,
                    isExpired: this.tokenStorage.isExpired()
                });
            }
            // Create auth context
            this.authContext = {
                type: 'oauth',
                token: this.tokenStorage?.access_token || '',
                credentials: {
                    clientId: this.oauth.constructor.name,
                    tokenFile: this.getTokenFile()
                },
                metadata: {
                    provider: 'qwen',
                    initialized: Date.now(),
                    hasToken: !!this.tokenStorage
                }
            };
            const totalTime = Date.now() - startTime;
            // Debug: Record auth initialization completion
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('auth_initialization_complete', {
                    authId,
                    success: true,
                    totalTime,
                    hasToken: !!this.tokenStorage,
                    isExpired: this.tokenStorage?.isExpired()
                });
                this.addToAuthHistory({
                    authId,
                    operation: 'initializeAuth',
                    success: true,
                    hasToken: !!this.tokenStorage,
                    startTime,
                    endTime: Date.now(),
                    totalTime
                });
                this.publishDebugEvent('auth_initialization_complete', {
                    authId,
                    success: true,
                    totalTime,
                    hasToken: !!this.tokenStorage
                });
            }
        }
        catch (error) {
            const totalTime = Date.now() - startTime;
            // Debug: Record auth initialization failure
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('auth_initialization_failed', {
                    authId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
                this.addToAuthHistory({
                    authId,
                    operation: 'initializeAuth',
                    success: false,
                    error,
                    startTime,
                    endTime: Date.now(),
                    totalTime
                });
                this.publishDebugEvent('auth_initialization_failed', {
                    authId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
            }
            this.logger.logModule(this.id, 'auth-initialization-error', { error });
            throw error;
        }
    }
    /**
     * Ensure valid token
     */
    async ensureValidToken() {
        if (!this.tokenStorage || this.tokenStorage.isExpired()) {
            if (this.isTestMode) {
                throw new Error('Test mode: No valid token available. Please run authentication first.');
            }
            // Try to refresh token or start new OAuth flow
            try {
                if (this.tokenStorage && this.tokenStorage.refresh_token) {
                    try {
                        const newTokenData = await this.oauth.refreshTokensWithRetry(this.tokenStorage.refresh_token);
                        this.oauth.updateTokenStorage(this.tokenStorage, newTokenData);
                        await this.oauth.saveToken();
                        this.logger.logModule(this.id, 'token-refreshed', { success: true });
                    }
                    catch (refreshError) {
                        this.logger.logModule(this.id, 'token-refresh-failed', {
                            error: refreshError instanceof Error ? refreshError.message : String(refreshError)
                        });
                        const storage = await this.oauth.completeOAuthFlow(true);
                        this.tokenStorage = storage || await this.oauth.loadToken();
                        if (!this.tokenStorage || !this.tokenStorage.access_token) {
                            throw new Error('OAuth flow did not return a valid token');
                        }
                        this.logger.logModule(this.id, 'oauth-completed', { success: true, reason: 'refresh-fallback' });
                    }
                }
                else {
                    // Start new OAuth flow
                    const storage = await this.oauth.completeOAuthFlow(true);
                    this.tokenStorage = storage || await this.oauth.loadToken();
                    this.logger.logModule(this.id, 'oauth-completed', { success: true, reason: 'no-refresh-token' });
                }
                if (this.authContext) {
                    this.authContext.token = this.tokenStorage?.access_token || '';
                    if (this.authContext.metadata) {
                        this.authContext.metadata.hasToken = !!this.tokenStorage?.access_token;
                        this.authContext.metadata.lastUpdated = Date.now();
                    }
                }
            }
            catch (error) {
                this.logger.logModule(this.id, 'auth-error', { error });
                throw new Error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    /**
     * Get API endpoint - EXACT copy from CLIProxyAPI logic
     */
    getAPIEndpoint() {
        if (this.tokenStorage && this.tokenStorage.resource_url) {
            return `https://${this.tokenStorage.resource_url}/v1`;
        }
        const providerConfig = this.config.config;
        return providerConfig.baseUrl || QWEN_API_ENDPOINT;
    }
    /**
     * Send chat request - EXACT copy from CLIProxyAPI logic
     */
    async sendChatRequest(request) {
        const startTime = Date.now();
        const httpRequestId = `http_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const endpoint = this.getAPIEndpoint();
        // Debug: Record HTTP request start
        if (this.isDebugEnhanced) {
            this.recordProviderMetric('http_request_start', {
                httpRequestId,
                endpoint,
                model: request?.model,
                hasTools: !!request.tools,
                timestamp: startTime
            });
            this.publishDebugEvent('http_request_start', {
                httpRequestId,
                endpoint,
                request,
                timestamp: startTime
            });
        }
        try {
            const url = `${endpoint}/chat/completions`;
            const authHeader = this.oauth.getAuthorizationHeader();
            this.logger.logProviderRequest(this.id, 'request-start', {
                model: request?.model,
                hasInput: Array.isArray(request?.input),
                keys: Object.keys(request || {})
            });
            console.log('[QwenProvider] sending request payload:', JSON.stringify(request));
            const payload = this.buildQwenPayload(request);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authHeader,
                    'User-Agent': 'google-api-nodejs-client/9.15.1',
                    'X-Goog-Api-Client': 'gl-node/22.17.0',
                    'Client-Metadata': this.getClientMetadataString(),
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const processingTime = Date.now() - startTime;
            if (!response.ok) {
                const errorText = await response.text();
                // Debug: Record HTTP request failure
                if (this.isDebugEnhanced) {
                    this.recordProviderMetric('http_request_failed', {
                        httpRequestId,
                        status: response.status,
                        error: errorText,
                        processingTime
                    });
                    this.addToErrorHistory({
                        httpRequestId,
                        error: new Error(`HTTP ${response.status}: ${errorText}`),
                        request,
                        startTime,
                        endTime: Date.now(),
                        processingTime,
                        operation: 'sendChatRequest'
                    });
                    this.publishDebugEvent('http_request_failed', {
                        httpRequestId,
                        status: response.status,
                        error: errorText,
                        processingTime
                    });
                }
                throw this.createProviderError({
                    message: `HTTP ${response.status}: ${errorText}`,
                    status: response.status
                }, 'api');
            }
            const data = await response.json();
            const totalTime = Date.now() - startTime;
            // Debug: Record HTTP request success
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('http_request_complete', {
                    httpRequestId,
                    success: true,
                    totalTime,
                    status: response.status,
                    tokensUsed: data.usage?.total_tokens,
                    hasChoices: !!data.choices,
                    choiceCount: data.choices?.length || 0
                });
                this.publishDebugEvent('http_request_complete', {
                    httpRequestId,
                    success: true,
                    totalTime,
                    response: data,
                    status: response.status
                });
            }
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
        }
        catch (error) {
            const totalTime = Date.now() - startTime;
            // Debug: Record HTTP request error
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('http_request_error', {
                    httpRequestId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
                this.addToErrorHistory({
                    httpRequestId,
                    error,
                    request,
                    startTime,
                    endTime: Date.now(),
                    totalTime,
                    operation: 'sendChatRequest'
                });
                this.publishDebugEvent('http_request_error', {
                    httpRequestId,
                    error: error instanceof Error ? error.message : String(error),
                    totalTime
                });
            }
            throw this.createProviderError(error, 'network');
        }
    }
    /**
     * Build sanitized payload for Qwen API
     */
    buildQwenPayload(request) {
        const allowedKeys = [
            'model',
            'messages',
            'input',
            'parameters',
            'tools',
            'stream',
            'response_format',
            'user',
            'metadata'
        ];
        const payload = {};
        for (const key of allowedKeys) {
            if (request[key] !== undefined) {
                payload[key] = request[key];
            }
        }
        return payload;
    }
    /**
     * Get client metadata - EXACT copy from CLIProxyAPI logic
     */
    getClientMetadata() {
        const metadata = new Map([
            ['ideType', 'IDE_UNSPECIFIED'],
            ['platform', 'PLATFORM_UNSPECIFIED'],
            ['pluginType', 'GEMINI']
        ]);
        return metadata;
    }
    /**
     * Get client metadata string - EXACT copy from CLIProxyAPI logic
     */
    getClientMetadataString() {
        const md = this.getClientMetadata();
        const parts = [];
        for (const [k, v] of md) {
            parts.push(`${k}=${v}`);
        }
        return parts.join(',');
    }
    /**
     * Process provider response
     */
    processResponse(response) {
        const processedResponse = {
            ...response.data,
            _providerMetadata: {
                provider: 'qwen',
                processingTime: response.metadata?.processingTime,
                tokensUsed: response.metadata?.tokensUsed,
                timestamp: Date.now()
            }
        };
        return processedResponse;
    }
    /**
     * Perform health check
     */
    async performHealthCheck() {
        try {
            // Would perform actual health check request
            // For now, simulate a health check
            const isHealthy = this.tokenStorage !== null && !this.tokenStorage.isExpired();
            return {
                isHealthy,
                details: {
                    authentication: isHealthy ? 'valid' : 'invalid',
                    connectivity: 'connected',
                    timestamp: Date.now()
                }
            };
        }
        catch (error) {
            return {
                isHealthy: false,
                details: {
                    authentication: 'unknown',
                    connectivity: 'disconnected',
                    error: error instanceof Error ? error.message : String(error)
                }
            };
        }
    }
    /**
     * Handle provider errors
     */
    async handleProviderError(error, request) {
        const providerError = this.createProviderError(error, 'unknown');
        this.logger.logModule(this.id, 'provider-error', {
            error: providerError,
            request: {
                model: request.model,
                hasMessages: !!request.messages
            }
        });
        // Would integrate with error handling center here
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
    createProviderError(error, type) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        const providerError = new Error(errorObj.message);
        providerError.type = type;
        providerError.statusCode = error.status || error.statusCode;
        providerError.details = error.details || error;
        providerError.retryable = this.isErrorRetryable(type);
        return providerError;
    }
    /**
     * Check if error is retryable
     */
    isErrorRetryable(errorType) {
        const retryableTypes = ['network', 'timeout', 'rate_limit', 'server'];
        return retryableTypes.includes(errorType);
    }
    /**
     * Set test mode
     */
    setTestMode(enabled) {
        this.isTestMode = enabled;
    }
    /**
     * Validate token (for testing)
     */
    async validateToken() {
        try {
            await this.ensureValidToken();
            return this.tokenStorage !== null && !this.tokenStorage.isExpired();
        }
        catch (error) {
            return false;
        }
    }
}
