/**
 * Progressive Module Enhancement System
 *
 * Provides a simple, declarative way to enhance existing modules with debugging capabilities
 * while maintaining backward compatibility.
 */

import type { DebugCenter } from '../modules/pipeline/types/external-types.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { PipelineDebugLogger } from '../modules/pipeline/utils/debug-logger.js';

/**
 * Enhancement configuration interface
 */
export interface EnhancementConfig {
  /** Enable or disable debugging for this module */
  enabled: boolean;
  /** Debug level */
  level: 'none' | 'basic' | 'detailed' | 'verbose';
  /** Enable console logging */
  consoleLogging?: boolean;
  /** Enable DebugCenter integration */
  debugCenter?: boolean;
  /** Maximum number of log entries to keep */
  maxLogEntries?: number;
  /** Custom log categories to track */
  categories?: string[];
  /** Performance tracking */
  performanceTracking?: boolean;
  /** Request/response logging */
  requestLogging?: boolean;
  /** Error tracking */
  errorTracking?: boolean;
  /** Transformation logging */
  transformationLogging?: boolean;
}

/**
 * Enhanced module interface
 */
export interface EnhancedModule<T extends object> {
  /** Original module instance */
  original: T;
  /** Enhanced module instance */
  enhanced: T;
  /** Debug logger instance */
  logger: PipelineDebugLogger;
  /** Enhancement configuration */
  config: EnhancementConfig;
  /** Module metadata */
  metadata: {
    moduleId: string;
    moduleType: string;
    enhanced: boolean;
    enhancementTime: number;
  };
}

/**
 * Enhancement registry
 */
export class EnhancementRegistry {
  private static instance: EnhancementRegistry;
  private enhancedModules = new Map<string, EnhancedModule<any>>();
  private configs = new Map<string, EnhancementConfig>();

  private constructor() {}

  static getInstance(): EnhancementRegistry {
    if (!EnhancementRegistry.instance) {
      EnhancementRegistry.instance = new EnhancementRegistry();
    }
    return EnhancementRegistry.instance;
  }

  /**
   * Register an enhanced module
   */
  registerEnhancedModule<T extends object>(
    moduleId: string,
    enhanced: EnhancedModule<T>
  ): void {
    this.enhancedModules.set(moduleId, enhanced);
  }

  /**
   * Get enhanced module by ID
   */
  getEnhancedModule<T extends object>(moduleId: string): EnhancedModule<T> | undefined {
    return this.enhancedModules.get(moduleId);
  }

  /**
   * Get all enhanced modules
   */
  getAllEnhancedModules(): EnhancedModule<any>[] {
    return Array.from(this.enhancedModules.values());
  }

  /**
   * Register enhancement configuration
   */
  registerConfig(moduleId: string, config: EnhancementConfig): void {
    this.configs.set(moduleId, config);
  }

  /**
   * Get enhancement configuration
   */
  getConfig(moduleId: string): EnhancementConfig | undefined {
    return this.configs.get(moduleId);
  }

  /**
   * Check if module is enhanced
   */
  isEnhanced(moduleId: string): boolean {
    return this.enhancedModules.has(moduleId);
  }

  /**
   * Clear all enhanced modules
   */
  clear(): void {
    this.enhancedModules.clear();
    this.configs.clear();
  }
}

/**
 * Module Enhancement Factory
 */
export class ModuleEnhancementFactory {
  private debugCenter: DebugCenter;

  constructor(debugCenter: DebugCenter) {
    this.debugCenter = debugCenter;
  }

  /**
   * Create enhanced module with debugging capabilities
   */
  createEnhancedModule<T extends object>(
    originalModule: T,
    moduleId: string,
    moduleType: string,
    config: EnhancementConfig = {
      enabled: true,
      level: 'detailed',
      consoleLogging: true,
      debugCenter: true,
      maxLogEntries: 1000,
      performanceTracking: true,
      requestLogging: true,
      errorTracking: true,
      transformationLogging: true
    }
  ): EnhancedModule<T> {
    // Don't enhance if disabled
    if (!config.enabled) {
      return {
        original: originalModule,
        enhanced: originalModule,
        logger: this.createFallbackLogger(),
        config,
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

    const enhanced: EnhancedModule<T> = {
      original: originalModule,
      enhanced: enhancedModule,
      logger,
      config,
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
  private enhanceModule<T extends object>(
    module: T,
    moduleId: string,
    moduleType: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    switch (moduleType) {
      case 'provider':
        return this.enhanceProviderModule(module as any, moduleId, logger, config);
      case 'pipeline':
        return this.enhancePipelineModule(module as any, moduleId, logger, config);
      case 'compatibility':
        return this.enhanceCompatibilityModule(module as any, moduleId, logger, config);
      case 'workflow':
        return this.enhanceWorkflowModule(module as any, moduleId, logger, config);
      case 'llmswitch':
        return this.enhanceLLMSwitchModule(module as any, moduleId, logger, config);
      case 'http-server':
        return this.enhanceHTTPServerModule(module as any, moduleId, logger, config);
      default:
        return this.enhanceGenericModule(module, moduleId, logger, config);
    }
  }

  /**
   * Enhance provider module
   */
  private enhanceProviderModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap key methods with debugging
    if ('processIncoming' in enhanced && typeof enhanced.processIncoming === 'function') {
      const originalProcessIncoming = enhanced.processIncoming;
      enhanced.processIncoming = async function(request: any) {
        const startTime = Date.now();
        const requestId = request._metadata?.requestId || `req-${Date.now()}`;

        try {
          logger.logProviderRequest(requestId, 'request-start', {
            moduleId,
            request: this.sanitizeRequest(request)
          });

          const result = await originalProcessIncoming.call(this, request);

          const processingTime = Date.now() - startTime;
          logger.logProviderRequest(requestId, 'request-success', {
            moduleId,
            processingTime,
            response: this.sanitizeResponse(result)
          });

          // Performance tracking
          if (config.performanceTracking) {
            this.trackPerformance(moduleId, 'processIncoming', processingTime);
          }

          return result;
        } catch (error) {
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
      enhanced.initialize = async function() {
        try {
          logger.logModule(moduleId, 'initialization-start');
          const result = await originalInitialize.call(this);
          logger.logModule(moduleId, 'initialization-success');
          return result;
        } catch (error) {
          logger.logModule(moduleId, 'initialization-error', { error });
          throw error;
        }
      };
    }

    return enhanced as T;
  }

  /**
   * Enhance pipeline module
   */
  private enhancePipelineModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap processRequest method
    if ('processRequest' in enhanced && typeof enhanced.processRequest === 'function') {
      const originalProcessRequest = enhanced.processRequest;
      enhanced.processRequest = async function(request: any) {
        const startTime = Date.now();
        const requestId = request.route?.requestId || `req-${Date.now()}`;

        try {
          logger.logRequest(requestId, 'pipeline-start', {
            moduleId,
            pipelineId: moduleId,
            request: this.sanitizeRequest(request)
          });

          const result = await originalProcessRequest.call(this, request);

          const processingTime = Date.now() - startTime;
          logger.logRequest(requestId, 'pipeline-complete', {
            moduleId,
            processingTime,
            response: this.sanitizeResponse(result)
          });

          if (config.performanceTracking) {
            this.trackPerformance(moduleId, 'processRequest', processingTime);
          }

          return result;
        } catch (error) {
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

    return enhanced as T;
  }

  /**
   * Enhance compatibility module
   */
  private enhanceCompatibilityModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap processIncoming method
    if ('processIncoming' in enhanced && typeof enhanced.processIncoming === 'function') {
      const originalProcessIncoming = enhanced.processIncoming;
      enhanced.processIncoming = async function(request: any) {
        const startTime = Date.now();
        const requestId = request._metadata?.requestId || `req-${Date.now()}`;

        try {
          logger.logTransformation(requestId, 'compatibility-transform-start', {
            moduleId,
            input: this.sanitizeRequest(request)
          });

          const result = await originalProcessIncoming.call(this, request);

          const processingTime = Date.now() - startTime;
          logger.logTransformation(requestId, 'compatibility-transform-complete', {
            moduleId,
            processingTime,
            output: this.sanitizeResponse(result)
          });

          if (config.transformationLogging) {
            logger.logTransformation(requestId, 'transformation', request, result);
          }

          return result;
        } catch (error) {
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

    return enhanced as T;
  }

  /**
   * Enhance workflow module
   */
  private enhanceWorkflowModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap execute method
    if ('execute' in enhanced && typeof enhanced.execute === 'function') {
      const originalExecute = enhanced.execute;
      enhanced.execute = async function(context: any) {
        const startTime = Date.now();
        const requestId = context.requestId || `req-${Date.now()}`;

        try {
          logger.logModule(moduleId, 'workflow-start', {
            moduleId,
            context: this.sanitizeContext(context)
          });

          const result = await originalExecute.call(this, context);

          const processingTime = Date.now() - startTime;
          logger.logModule(moduleId, 'workflow-complete', {
            moduleId,
            processingTime,
            result: this.sanitizeResult(result)
          });

          if (config.performanceTracking) {
            this.trackPerformance(moduleId, 'execute', processingTime);
          }

          return result;
        } catch (error) {
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

    return enhanced as T;
  }

  /**
   * Enhance LLM switch module
   */
  private enhanceLLMSwitchModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap processIncoming method
    if ('processIncoming' in enhanced && typeof enhanced.processIncoming === 'function') {
      const originalProcessIncoming = enhanced.processIncoming;
      enhanced.processIncoming = async function(request: any) {
        const startTime = Date.now();
        const requestId = request._metadata?.requestId || `req-${Date.now()}`;

        try {
          logger.logModule(moduleId, 'llm-switch-start', {
            moduleId,
            request: this.sanitizeRequest(request)
          });

          const result = await originalProcessIncoming.call(this, request);

          const processingTime = Date.now() - startTime;
          logger.logModule(moduleId, 'llm-switch-complete', {
            moduleId,
            processingTime,
            routing: result._metadata?.routing
          });

          if (config.performanceTracking) {
            this.trackPerformance(moduleId, 'processIncoming', processingTime);
          }

          return result;
        } catch (error) {
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

    return enhanced as T;
  }

  /**
   * Enhance HTTP server module
   */
  private enhanceHTTPServerModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap handleRequest method
    if ('handleRequest' in enhanced && typeof enhanced.handleRequest === 'function') {
      const originalHandleRequest = enhanced.handleRequest;
      enhanced.handleRequest = async function(request: any, response: any) {
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
            this.trackPerformance(moduleId, 'handleRequest', processingTime);
          }

          return result;
        } catch (error) {
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

    return enhanced as T;
  }

  /**
   * Enhance generic module
   */
  private enhanceGenericModule<T extends object>(
    module: T,
    moduleId: string,
    logger: PipelineDebugLogger,
    config: EnhancementConfig
  ): T {
    const enhanced = { ...module };

    // Wrap all methods with debugging
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(module))
      .filter(name => typeof enhanced[name as keyof T] === 'function' && name !== 'constructor');

    methodNames.forEach(methodName => {
      const originalMethod = enhanced[methodName as keyof T];
      if (typeof originalMethod === 'function') {
        enhanced[methodName as keyof T] = async function(...args: any[]) {
          const startTime = Date.now();
          const requestId = `req-${Date.now()}`;

          try {
            logger.logModule(moduleId, `method-start:${methodName}`, {
              moduleId,
              method: methodName,
              args: this.sanitizeArgs(args)
            });

            const result = await originalMethod.apply(this, args);

            const processingTime = Date.now() - startTime;
            logger.logModule(moduleId, `method-complete:${methodName}`, {
              moduleId,
              method: methodName,
              processingTime,
              result: this.sanitizeResult(result)
            });

            if (config.performanceTracking) {
              this.trackPerformance(moduleId, methodName, processingTime);
            }

            return result;
          } catch (error) {
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
        } as any;
      }
    });

    return enhanced as T;
  }

  /**
   * Create fallback logger for disabled modules
   */
  private createFallbackLogger(): PipelineDebugLogger {
    // Create a minimal logger that does nothing
    return {
      logModule: () => {},
      logPipeline: () => {},
      logRequest: () => {},
      logResponse: () => {},
      logTransformation: () => {},
      logProviderRequest: () => {},
      logError: () => {},
      logDebug: () => {},
      getRequestLogs: () => ({ general: [], transformations: [], provider: [] }),
      getPipelineLogs: () => ({ general: [], transformations: [], provider: [] }),
      getRecentLogs: () => [],
      getTransformationLogs: () => [],
      getProviderLogs: () => [],
      getStatistics: () => ({
        totalLogs: 0,
        logsByLevel: {},
        logsByCategory: {},
        logsByPipeline: {},
        transformationCount: 0,
        providerRequestCount: 0
      }),
      clearLogs: () => {},
      exportLogs: () => ({})
    } as PipelineDebugLogger;
  }

  /**
   * Sanitize request data for logging
   */
  private sanitizeRequest(request: any): any {
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
  private sanitizeResponse(response: any): any {
    if (!response || typeof response !== 'object') {
      return response;
    }

    return response;
  }

  /**
   * Sanitize context data for logging
   */
  private sanitizeContext(context: any): any {
    return this.sanitizeRequest(context);
  }

  /**
   * Sanitize result data for logging
   */
  private sanitizeResult(result: any): any {
    return this.sanitizeResponse(result);
  }

  /**
   * Sanitize arguments for logging
   */
  private sanitizeArgs(args: any[]): any[] {
    return args.map(arg => this.sanitizeRequest(arg));
  }

  /**
   * Track performance metrics
   */
  private trackPerformance(moduleId: string, method: string, processingTime: number): void {
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
    } catch (error) {
      // Ignore if event bus is not available
    }
  }
}