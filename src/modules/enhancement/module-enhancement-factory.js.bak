/**
 * Progressive Module Enhancement System
 *
 * Provides a simple, declarative way to enhance existing modules with debugging capabilities
 * while maintaining backward compatibility.
 */
import { DebugEventBus } from 'rcc-debugcenter';
import { PipelineDebugLogger } from '../pipeline/utils/debug-logger.js';
/**
 * Enhancement registry
 */
export class EnhancementRegistry {
    constructor() {
        this.enhancedModules = new Map();
        this.configs = new Map();
    }
    static getInstance() {
        if (!EnhancementRegistry.instance) {
            EnhancementRegistry.instance = new EnhancementRegistry();
        }
        return EnhancementRegistry.instance;
    }
    /**
     * Register an enhanced module
     */
    registerEnhancedModule(moduleId, enhanced) {
        this.enhancedModules.set(moduleId, enhanced);
    }
    /**
     * Get enhanced module by ID
     */
    getEnhancedModule(moduleId) {
        return this.enhancedModules.get(moduleId);
    }
    /**
     * Get all enhanced modules
     */
    getAllEnhancedModules() {
        return Array.from(this.enhancedModules.values());
    }
    /**
     * Register enhancement configuration
     */
    registerConfig(moduleId, config) {
        this.configs.set(moduleId, config);
    }
    /**
     * Get enhancement configuration
     */
    getConfig(moduleId) {
        return this.configs.get(moduleId);
    }
    /**
     * Check if module is enhanced
     */
    isEnhanced(moduleId) {
        return this.enhancedModules.has(moduleId);
    }
    /**
     * Clear all enhanced modules
     */
    clear() {
        this.enhancedModules.clear();
        this.configs.clear();
    }
}
/**
 * Module Enhancement Factory
 */
export class ModuleEnhancementFactory {
    constructor(debugCenter) {
        this.debugCenter = debugCenter;
    }
    /**
     * Register enhancement configuration
     */
    registerConfig(moduleId, config) {
        EnhancementRegistry.getInstance().registerConfig(moduleId, config);
    }
    /**
     * Sanitize request data for logging
     */
    sanitizeRequest(request) {
        if (!request || typeof request !== 'object') {
            return request;
        }
        const sanitized = { ...request };
        // Remove sensitive fields
        const sensitiveFields = ['apiKey', 'api_key', 'token', 'password', 'secret', 'authorization'];
        sensitiveFields.forEach(field => {
            if (field in sanitized) {
                sanitized[field] = '[REDACTED]';
            }
        });
        return sanitized;
    }
    /**
     * Sanitize response data for logging
     */
    sanitizeResponse(response) {
        if (!response || typeof response !== 'object') {
            return response;
        }
        return response;
    }
    /**
     * Track performance metrics
     */
    trackPerformance(moduleId, method, processingTime) {
        try {
            const eventBus = DebugEventBus.getInstance();
            eventBus.publish({
                sessionId: 'performance',
                moduleId,
                operationId: `performance:${method}`,
                timestamp: Date.now(),
                type: 'start',
                position: 'middle',
                data: {
                    method,
                    processingTime,
                    performance: {
                        avgTime: processingTime,
                        minTime: processingTime,
                        maxTime: processingTime,
                        count: 1
                    }
                }
            });
        }
        catch (error) {
            // Ignore if event bus is not available
        }
    }
    /**
     * Sanitize arguments for logging
     */
    sanitizeArgs(args) {
        return args.map(arg => this.sanitizeRequest(arg));
    }
    /**
     * Sanitize result data for logging
     */
    sanitizeResult(result) {
        return this.sanitizeResponse(result);
    }
    /**
     * Sanitize context data for logging
     */
    sanitizeContext(context) {
        if (!context || typeof context !== 'object') {
            return context;
        }
        return this.sanitizeRequest(context);
    }
    /**
     * Create enhanced module with debugging capabilities
     */
    createEnhancedModule(originalModule, moduleId, moduleType, config = {
        enabled: true,
        level: 'detailed',
        consoleLogging: true,
        debugCenter: true,
        maxLogEntries: 1000,
        performanceTracking: true,
        requestLogging: true,
        errorTracking: true,
        transformationLogging: true
    }) {
        // Don't enhance if disabled
        if (!config.enabled) {
            return {
                // EnhancementConfig properties
                enabled: config.enabled,
                level: config.level,
                consoleLogging: config.consoleLogging,
                debugCenter: config.debugCenter,
                maxLogEntries: config.maxLogEntries,
                categories: config.categories,
                performanceTracking: config.performanceTracking,
                requestLogging: config.requestLogging,
                errorTracking: config.errorTracking,
                transformationLogging: config.transformationLogging,
                // EnhancedModule specific properties
                original: originalModule,
                enhanced: originalModule,
                logger: this.createFallbackLogger(),
                metadata: {
                    moduleId,
                    moduleType,
                    enhanced: false,
                    enhancementTime: Date.now()
                }
            };
        }
        // Create debug logger
        const logger = new PipelineDebugLogger(this.debugCenter, {
            enableConsoleLogging: config.consoleLogging,
            enableDebugCenter: config.debugCenter,
            maxLogEntries: config.maxLogEntries,
            logLevel: config.level
        });
        // Create enhanced module based on type
        const enhancedModule = this.enhanceModule(originalModule, moduleId, moduleType, logger, config);
        const enhanced = {
            // EnhancementConfig properties
            enabled: config.enabled,
            level: config.level,
            consoleLogging: config.consoleLogging,
            debugCenter: config.debugCenter,
            maxLogEntries: config.maxLogEntries,
            categories: config.categories,
            performanceTracking: config.performanceTracking,
            requestLogging: config.requestLogging,
            errorTracking: config.errorTracking,
            transformationLogging: config.transformationLogging,
            // EnhancedModule specific properties
            original: originalModule,
            enhanced: enhancedModule,
            logger,
            metadata: {
                moduleId,
                moduleType,
                enhanced: true,
                enhancementTime: Date.now()
            }
        };
        // Register with registry
        EnhancementRegistry.getInstance().registerEnhancedModule(moduleId, enhanced);
        logger.logModule(moduleId, 'enhancement-complete', {
            moduleType,
            config,
            enhancementTime: enhanced.metadata.enhancementTime
        });
        return enhanced;
    }
    /**
     * Enhance module based on its type
     */
    enhanceModule(module, moduleId, moduleType, logger, config) {
        switch (moduleType) {
            case 'provider':
                return this.enhanceProviderModule(module, moduleId, logger, config);
            case 'pipeline':
                return this.enhancePipelineModule(module, moduleId, logger, config);
            case 'compatibility':
                return this.enhanceCompatibilityModule(module, moduleId, logger, config);
            case 'workflow':
                return this.enhanceWorkflowModule(module, moduleId, logger, config);
            case 'llmswitch':
                return this.enhanceLLMSwitchModule(module, moduleId, logger, config);
            case 'http-server':
                return this.enhanceHTTPServerModule(module, moduleId, logger, config);
            default:
                return this.enhanceGenericModule(module, moduleId, logger, config);
        }
    }
    /**
     * Enhance provider module
     */
    enhanceProviderModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap key methods with debugging
        if ('processIncoming' in enhanced && typeof enhanced.processIncoming === 'function') {
            const originalProcessIncoming = enhanced.processIncoming;
            enhanced.processIncoming = async function (request) {
                const startTime = Date.now();
                const requestId = request._metadata?.requestId || `req-${Date.now()}`;
                try {
                    logger.logProviderRequest(requestId, 'request-start', {
                        moduleId,
                        request: factory.sanitizeRequest(request)
                    });
                    const result = await originalProcessIncoming.call(this, request);
                    const processingTime = Date.now() - startTime;
                    logger.logProviderRequest(requestId, 'request-success', {
                        moduleId,
                        processingTime,
                        response: factory.sanitizeResponse(result)
                    });
                    // Performance tracking
                    if (config.performanceTracking) {
                        factory.trackPerformance(moduleId, 'processIncoming', processingTime);
                    }
                    return result;
                }
                catch (error) {
                    const processingTime = Date.now() - startTime;
                    logger.logProviderRequest(requestId, 'request-error', {
                        moduleId,
                        processingTime,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    if (config.errorTracking) {
                        logger.logError(error, { moduleId, requestId, method: 'processIncoming' });
                    }
                    throw error;
                }
            };
        }
        // Wrap initialize method
        if ('initialize' in enhanced && typeof enhanced.initialize === 'function') {
            const originalInitialize = enhanced.initialize;
            enhanced.initialize = async function () {
                try {
                    logger.logModule(moduleId, 'initialization-start');
                    const result = await originalInitialize.call(this);
                    logger.logModule(moduleId, 'initialization-success');
                    return result;
                }
                catch (error) {
                    logger.logModule(moduleId, 'initialization-error', { error });
                    throw error;
                }
            };
        }
        return enhanced;
    }
    /**
     * Enhance pipeline module
     */
    enhancePipelineModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap processRequest method
        if ('processRequest' in enhanced && typeof enhanced.processRequest === 'function') {
            const originalProcessRequest = enhanced.processRequest;
            enhanced.processRequest = async function (request) {
                const startTime = Date.now();
                const requestId = request.route?.requestId || `req-${Date.now()}`;
                try {
                    logger.logRequest(requestId, 'pipeline-start', {
                        moduleId,
                        pipelineId: moduleId,
                        request: factory.sanitizeRequest(request)
                    });
                    const result = await originalProcessRequest.call(this, request);
                    const processingTime = Date.now() - startTime;
                    logger.logRequest(requestId, 'pipeline-complete', {
                        moduleId,
                        processingTime,
                        response: factory.sanitizeResponse(result)
                    });
                    if (config.performanceTracking) {
                        factory.trackPerformance(moduleId, 'processRequest', processingTime);
                    }
                    return result;
                }
                catch (error) {
                    const processingTime = Date.now() - startTime;
                    logger.logRequest(requestId, 'pipeline-error', {
                        moduleId,
                        processingTime,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    if (config.errorTracking) {
                        logger.logError(error, { moduleId, requestId, method: 'processRequest' });
                    }
                    throw error;
                }
            };
        }
        return enhanced;
    }
    /**
     * Enhance compatibility module
     */
    enhanceCompatibilityModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap processIncoming method
        if ('processIncoming' in enhanced && typeof enhanced.processIncoming === 'function') {
            const originalProcessIncoming = enhanced.processIncoming;
            enhanced.processIncoming = async function (request) {
                const startTime = Date.now();
                const requestId = request._metadata?.requestId || `req-${Date.now()}`;
                try {
                    logger.logTransformation(requestId, 'compatibility-transform-start', {
                        moduleId,
                        input: factory.sanitizeRequest(request)
                    });
                    const result = await originalProcessIncoming.call(this, request);
                    const processingTime = Date.now() - startTime;
                    logger.logTransformation(requestId, 'compatibility-transform-complete', {
                        moduleId,
                        processingTime,
                        output: factory.sanitizeResponse(result)
                    });
                    if (config.transformationLogging) {
                        logger.logTransformation(requestId, 'transformation', request, result);
                    }
                    return result;
                }
                catch (error) {
                    const processingTime = Date.now() - startTime;
                    logger.logTransformation(requestId, 'compatibility-transform-error', {
                        moduleId,
                        processingTime,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    if (config.errorTracking) {
                        logger.logError(error, { moduleId, requestId, method: 'processIncoming' });
                    }
                    throw error;
                }
            };
        }
        return enhanced;
    }
    /**
     * Enhance workflow module
     */
    enhanceWorkflowModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap execute method
        if ('execute' in enhanced && typeof enhanced.execute === 'function') {
            const originalExecute = enhanced.execute;
            enhanced.execute = async function (context) {
                const startTime = Date.now();
                const requestId = context.requestId || `req-${Date.now()}`;
                try {
                    logger.logModule(moduleId, 'workflow-start', {
                        moduleId,
                        context: factory.sanitizeRequest(context)
                    });
                    const result = await originalExecute.call(this, context);
                    const processingTime = Date.now() - startTime;
                    logger.logModule(moduleId, 'workflow-complete', {
                        moduleId,
                        processingTime,
                        result: factory.sanitizeResponse(result)
                    });
                    if (config.performanceTracking) {
                        factory.trackPerformance(moduleId, 'execute', processingTime);
                    }
                    return result;
                }
                catch (error) {
                    const processingTime = Date.now() - startTime;
                    logger.logModule(moduleId, 'workflow-error', {
                        moduleId,
                        processingTime,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    if (config.errorTracking) {
                        logger.logError(error, { moduleId, requestId, method: 'execute' });
                    }
                    throw error;
                }
            };
        }
        return enhanced;
    }
    /**
     * Enhance LLM switch module
     */
    enhanceLLMSwitchModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap processIncoming method
        if ('processIncoming' in enhanced && typeof enhanced.processIncoming === 'function') {
            const originalProcessIncoming = enhanced.processIncoming;
            enhanced.processIncoming = async function (request) {
                const startTime = Date.now();
                const requestId = request._metadata?.requestId || `req-${Date.now()}`;
                try {
                    logger.logModule(moduleId, 'llm-switch-start', {
                        moduleId,
                        request: factory.sanitizeRequest(request)
                    });
                    const result = await originalProcessIncoming.call(this, request);
                    const processingTime = Date.now() - startTime;
                    logger.logModule(moduleId, 'llm-switch-complete', {
                        moduleId,
                        processingTime,
                        routing: result._metadata?.routing
                    });
                    if (config.performanceTracking) {
                        factory.trackPerformance(moduleId, 'processIncoming', processingTime);
                    }
                    return result;
                }
                catch (error) {
                    const processingTime = Date.now() - startTime;
                    logger.logModule(moduleId, 'llm-switch-error', {
                        moduleId,
                        processingTime,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    if (config.errorTracking) {
                        logger.logError(error, { moduleId, requestId, method: 'processIncoming' });
                    }
                    throw error;
                }
            };
        }
        return enhanced;
    }
    /**
     * Enhance HTTP server module
     */
    enhanceHTTPServerModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap handleRequest method
        if ('handleRequest' in enhanced && typeof enhanced.handleRequest === 'function') {
            const originalHandleRequest = enhanced.handleRequest;
            enhanced.handleRequest = async function (request, response) {
                const startTime = Date.now();
                const requestId = request.headers?.['x-request-id'] || `req-${Date.now()}`;
                try {
                    logger.logModule(moduleId, 'http-request-start', {
                        moduleId,
                        method: request.method,
                        url: request.url,
                        requestId
                    });
                    const result = await originalHandleRequest.call(this, request, response);
                    const processingTime = Date.now() - startTime;
                    logger.logModule(moduleId, 'http-request-complete', {
                        moduleId,
                        processingTime,
                        status: response.statusCode
                    });
                    if (config.performanceTracking) {
                        factory.trackPerformance(moduleId, 'handleRequest', processingTime);
                    }
                    return result;
                }
                catch (error) {
                    const processingTime = Date.now() - startTime;
                    logger.logModule(moduleId, 'http-request-error', {
                        moduleId,
                        processingTime,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    if (config.errorTracking) {
                        logger.logError(error, { moduleId, requestId, method: 'handleRequest' });
                    }
                    throw error;
                }
            };
        }
        return enhanced;
    }
    /**
     * Enhance generic module
     */
    enhanceGenericModule(module, moduleId, logger, config) {
        const enhanced = { ...module };
        const factory = this;
        // Wrap all methods with debugging
        const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(module))
            .filter(name => typeof enhanced[name] === 'function' && name !== 'constructor');
        methodNames.forEach(methodName => {
            const originalMethod = enhanced[methodName];
            if (typeof originalMethod === 'function') {
                enhanced[methodName] = async function (...args) {
                    const startTime = Date.now();
                    const requestId = `req-${Date.now()}`;
                    try {
                        logger.logModule(moduleId, `method-start:${methodName}`, {
                            moduleId,
                            method: methodName,
                            args: factory.sanitizeRequest(args)
                        });
                        const result = await originalMethod.apply(module, args);
                        const processingTime = Date.now() - startTime;
                        logger.logModule(moduleId, `method-complete:${methodName}`, {
                            moduleId,
                            method: methodName,
                            processingTime,
                            result: factory.sanitizeResponse(result)
                        });
                        if (config.performanceTracking) {
                            factory.trackPerformance(moduleId, methodName, processingTime);
                        }
                        return result;
                    }
                    catch (error) {
                        const processingTime = Date.now() - startTime;
                        logger.logModule(moduleId, `method-error:${methodName}`, {
                            moduleId,
                            method: methodName,
                            processingTime,
                            error: error instanceof Error ? error.message : String(error)
                        });
                        if (config.errorTracking) {
                            logger.logError(error, { moduleId, requestId, method: methodName });
                        }
                        throw error;
                    }
                };
            }
        });
        return enhanced;
    }
    /**
     * Create fallback logger for disabled modules
     */
    createFallbackLogger() {
        // Create a minimal logger that does nothing
        return new PipelineDebugLogger(this.debugCenter, {
            enableConsoleLogging: false,
            enableDebugCenter: false,
            maxLogEntries: 0,
            logLevel: 'none'
        });
    }
}
