/**
 * 简化的LM Studio Provider - 只做HTTP请求，不做任何转换
 */
import { DebugEventBus } from '../../../../utils/external-mocks.js';
/**
 * 简化的LM Studio Provider - 标准HTTP服务器
 */
export class LMStudioProviderSimple {
    constructor(config, dependencies) {
        this.dependencies = dependencies;
        this.type = 'lmstudio-http';
        this.providerType = 'lmstudio';
        this.isInitialized = false;
        this.authContext = null;
        this.headers = {};
        // Debug enhancement properties
        this.debugEventBus = null;
        this.isDebugEnhanced = false;
        this.providerMetrics = new Map();
        this.requestHistory = [];
        this.errorHistory = [];
        this.maxHistorySize = 50;
        this.id = `provider-${Date.now()}`;
        this.config = config;
        this.logger = dependencies.logger;
        const providerConfig = this.config.config;
        this.baseUrl = providerConfig.baseUrl || 'http://localhost:1234';
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
            console.log('LM Studio Provider Simple debug enhancements initialized');
        }
        catch (error) {
            console.warn('Failed to initialize LM Studio Provider Simple debug enhancements:', error);
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
    addToRequestHistory(request) {
        this.requestHistory.push(request);
        // Keep only recent history
        if (this.requestHistory.length > this.maxHistorySize) {
            this.requestHistory.shift();
        }
    }
    /**
     * Add to error history
     */
    addToErrorHistory(error) {
        this.errorHistory.push(error);
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
                moduleId: 'lmstudio-provider-simple',
                operationId: type,
                timestamp: Date.now(),
                type: 'debug',
                position: 'middle',
                data: {
                    ...data,
                    providerId: this.id,
                    source: 'lmstudio-provider-simple'
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
            providerId: this.id,
            isInitialized: this.isInitialized,
            baseUrl: this.baseUrl,
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
            errorHistory: [...this.errorHistory.slice(-10)] // Last 10 errors
        };
    }
    /**
     * Get detailed debug information
     */
    getDebugInfo() {
        return {
            providerId: this.id,
            providerType: this.providerType,
            enhanced: this.isDebugEnhanced,
            eventBusAvailable: !!this.debugEventBus,
            requestHistorySize: this.requestHistory.length,
            errorHistorySize: this.errorHistory.length,
            hasAuth: !!this.authContext
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
     * Initialize the provider
     */
    async initialize() {
        const startTime = Date.now();
        const initId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Debug: Record initialization start
        if (this.isDebugEnhanced) {
            this.recordProviderMetric('initialization_start', {
                initId,
                baseUrl: this.baseUrl,
                providerType: this.providerType,
                timestamp: startTime
            });
            this.publishDebugEvent('initialization_start', {
                initId,
                baseUrl: this.baseUrl,
                providerType: this.providerType,
                timestamp: startTime
            });
        }
        try {
            this.logger.logModule(this.id, 'initializing', {
                baseUrl: this.baseUrl,
                providerType: this.providerType
            });
            // Validate configuration
            this.validateConfig();
            // Initialize authentication
            await this.initializeAuth();
            this.isInitialized = true;
            this.logger.logModule(this.id, 'initialized');
            const totalTime = Date.now() - startTime;
            // Debug: Record initialization completion
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('initialization_complete', {
                    initId,
                    success: true,
                    totalTime,
                    hasAuth: !!this.authContext
                });
                this.publishDebugEvent('initialization_complete', {
                    initId,
                    success: true,
                    totalTime,
                    hasAuth: !!this.authContext
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
                this.addToErrorHistory({
                    initId,
                    error,
                    startTime,
                    endTime: Date.now(),
                    totalTime,
                    operation: 'initialize'
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
     * Process incoming request - 直接发送，不做转换
     */
    async processIncoming(request) {
        const startTime = Date.now();
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        if (!this.isInitialized) {
            throw new Error('LM Studio Provider is not initialized');
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
                endpoint: `${this.baseUrl}/v1/chat/completions`,
                method: 'POST',
                hasAuth: !!this.authContext,
                hasTools: !!request.tools
            });
            // Compatibility模块已经处理了所有转换，直接发送请求
            const response = await this.sendChatRequest(request);
            const totalTime = Date.now() - startTime;
            // Debug: Record request completion
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('request_complete', {
                    requestId,
                    success: true,
                    totalTime,
                    responseStatus: response.status,
                    hasData: !!response.data,
                    tokensUsed: response.metadata?.tokensUsed || 0
                });
                this.addToRequestHistory({
                    requestId,
                    request,
                    response,
                    startTime,
                    endTime: Date.now(),
                    totalTime,
                    success: true
                });
                this.publishDebugEvent('request_complete', {
                    requestId,
                    success: true,
                    totalTime,
                    response
                });
            }
            this.logger.logProviderRequest(this.id, 'request-success', {
                responseTime: response.metadata?.processingTime,
                status: response.status
            });
            return response;
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
     * Process outgoing response - 直接返回
     */
    async processOutgoing(response) {
        return response;
    }
    /**
     * Send request to provider
     */
    async sendRequest(request, options) {
        return this.processIncoming(request);
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
            this.logger.logModule(this.id, 'cleanup-complete');
        }
        catch (error) {
            this.logger.logModule(this.id, 'cleanup-error', { error });
            throw error;
        }
    }
    /**
     * Get module status
     */
    getStatus() {
        return {
            id: this.id,
            type: this.type,
            isInitialized: this.isInitialized,
            baseUrl: this.baseUrl,
            lastActivity: Date.now()
        };
    }
    /**
     * Check provider health
     */
    async checkHealth() {
        try {
            const startTime = Date.now();
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                headers: this.headers
            });
            const processingTime = Date.now() - startTime;
            this.logger.logModule(this.id, 'health-check', {
                status: response.status,
                processingTime
            });
            return response.ok;
        }
        catch (error) {
            this.logger.logModule(this.id, 'health-check-error', { error });
            return false;
        }
    }
    /**
     * Validate configuration
     */
    validateConfig() {
        const providerConfig = this.config.config;
        if (!providerConfig.baseUrl) {
            throw new Error('LM Studio baseUrl is required');
        }
        if (!providerConfig.auth) {
            throw new Error('LM Studio auth configuration is required');
        }
        this.logger.logModule(this.id, 'config-validation-success', {
            type: this.config.type,
            baseUrl: providerConfig.baseUrl,
            authType: providerConfig.auth.type
        });
    }
    /**
     * Initialize authentication
     */
    async initializeAuth() {
        const providerConfig = this.config.config;
        const authConfig = providerConfig.auth || { type: 'apikey' };
        let resolvedApiKey = '';
        if (authConfig.type === 'apikey') {
            const rawKey = authConfig.apiKey;
            if (typeof rawKey === 'string') {
                // Resolve ${ENV} or ${ENV:-default} patterns
                const envMatch = rawKey.match(/^\$\{([^}:]+)(?::-(.*))?}$/);
                if (envMatch) {
                    const envName = envMatch[1];
                    const def = envMatch[2] || '';
                    resolvedApiKey = process.env[envName] || def || '';
                }
                else if (rawKey.includes('${')) {
                    // Unresolved placeholder: treat as empty
                    resolvedApiKey = '';
                }
                else {
                    resolvedApiKey = rawKey;
                }
            }
        }
        this.authContext = {
            type: authConfig.type,
            token: resolvedApiKey || '',
            credentials: {
                apiKey: resolvedApiKey || '',
                headerName: 'Authorization',
                prefix: 'Bearer '
            }
        };
        // Prepare headers
        this.headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'RouteCodex/1.0.0'
        };
        if (authConfig.type === 'apikey' && resolvedApiKey) {
            this.headers['Authorization'] = `Bearer ${resolvedApiKey}`;
        }
        this.logger.logModule(this.id, 'auth-initialized', {
            type: authConfig.type,
            hasToken: !!authConfig.apiKey
        });
    }
    /**
     * Send chat request to LM Studio
     */
    async sendChatRequest(request) {
        const startTime = Date.now();
        const httpRequestId = `http_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const endpoint = `${this.baseUrl}/v1/chat/completions`;
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
            // Make HTTP request using fetch
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(request)
            });
            if (!response.ok) {
                const errorText = await response.text();
                // Debug: Record HTTP request failure
                if (this.isDebugEnhanced) {
                    this.recordProviderMetric('http_request_failed', {
                        httpRequestId,
                        status: response.status,
                        error: errorText,
                        processingTime: Date.now() - startTime
                    });
                    this.addToErrorHistory({
                        httpRequestId,
                        error: new Error(`LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`),
                        request,
                        startTime,
                        endTime: Date.now(),
                        processingTime: Date.now() - startTime,
                        operation: 'sendChatRequest'
                    });
                    this.publishDebugEvent('http_request_failed', {
                        httpRequestId,
                        status: response.status,
                        error: errorText,
                        processingTime: Date.now() - startTime
                    });
                }
                throw new Error(`LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`);
            }
            const responseData = await response.json();
            const processingTime = Date.now() - startTime;
            // Debug: Record HTTP request success
            if (this.isDebugEnhanced) {
                this.recordProviderMetric('http_request_complete', {
                    httpRequestId,
                    success: true,
                    processingTime,
                    status: response.status,
                    tokensUsed: responseData.usage?.total_tokens || 0,
                    hasChoices: !!responseData.choices,
                    choiceCount: responseData.choices?.length || 0
                });
                this.publishDebugEvent('http_request_complete', {
                    httpRequestId,
                    success: true,
                    processingTime,
                    response: responseData,
                    status: response.status
                });
            }
            // Return standardized response format
            return {
                data: responseData,
                status: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                metadata: {
                    requestId: `req-${Date.now()}`,
                    processingTime,
                    tokensUsed: responseData.usage?.total_tokens || 0,
                    model: responseData.model
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
            const providerError = this.createProviderError(error);
            throw providerError;
        }
    }
    /**
     * Handle provider errors
     */
    async handleProviderError(error, request) {
        const providerError = this.createProviderError(error);
        await this.dependencies.errorHandlingCenter.handleError(providerError, {
            module: this.id,
            action: 'processIncoming',
            request
        });
    }
    /**
     * Create provider error
     */
    createProviderError(error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        const providerError = new Error(errorObj.message);
        providerError.type = 'network';
        providerError.statusCode = error.statusCode || 500;
        providerError.details = error;
        providerError.retryable = this.isRetryableError(error);
        return providerError;
    }
    /**
     * Check if error is retryable
     */
    isRetryableError(error) {
        if (!error.statusCode)
            return false;
        // Retry on 5xx errors, 429 (rate limit), and network errors
        return error.statusCode >= 500 ||
            error.statusCode === 429 ||
            error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT';
    }
}
