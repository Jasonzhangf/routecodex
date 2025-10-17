/**
 * Base Handler Abstract Class
 * Provides common functionality for all protocol handlers
 */

import { type Request, type Response } from 'express';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';
import { RouteCodexError } from '../types.js';
import {
  ServiceContainer,
  ServiceLifetime,
  ServiceTokens,
  initializeDefaultServices
} from '../core/service-container.js';

/**
 * Request validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Protocol handler configuration interface
 */
export interface ProtocolHandlerConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  enableValidation?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  targetUrl?: string;
  timeout?: number;
  enablePipeline?: boolean;
  pipelineProvider?: {
    defaultProvider: string;
    modelMapping: Record<string, string>;
  };
}

/**
 * Error response interface
 */
export interface ErrorResponse {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string;
      param?: string | null;
      details?: Record<string, unknown>;
    };
  };
}

/**
 * Base Handler Abstract Class
 * Provides common functionality for all endpoint handlers
 */
export abstract class BaseHandler {
  protected config: ProtocolHandlerConfig;
  protected serviceContainer: ServiceContainer;
  protected errorHandling: ErrorHandlingCenter;
  protected debugEventBus: DebugEventBus;
  protected logger: PipelineDebugLogger;
  private routePools: Record<string, string[]> | null = null;
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string }> | null = null;
  private pipelineManager: any | null = null;
  private classifier: { classify: (payload: unknown) => Promise<unknown> } | null = null;
  private classifierConfig: Record<string, unknown> | null = null;
  private rrIndex: Map<string, number> = new Map();

  constructor(config: ProtocolHandlerConfig, serviceContainer?: ServiceContainer) {
    this.config = {
      enableStreaming: true,
      enableMetrics: true,
      enableValidation: true,
      rateLimitEnabled: false,
      authEnabled: false,
      timeout: 30000,
      enablePipeline: false,
      ...config,
    };

    // Use provided service container or create default
    this.serviceContainer = serviceContainer || ServiceContainer.getInstance();

    this.ensureCoreServices();

    this.errorHandling = this.resolveOrRegister(
      ServiceTokens.ERROR_HANDLING_CENTER,
      () => new ErrorHandlingCenter(),
      ServiceLifetime.Singleton
    );

    this.debugEventBus = this.resolveOrRegister(
      ServiceTokens.DEBUG_EVENT_BUS,
      () => DebugEventBus.getInstance(),
      ServiceLifetime.Singleton
    );

    this.logger = this.resolveOrRegister(
      ServiceTokens.PIPELINE_DEBUG_LOGGER,
      () => new PipelineDebugLogger(null, {
        enableConsoleLogging: true,
        enableDebugCenter: true,
      }),
      ServiceLifetime.Singleton
    );
  }

  /**
   * Handle incoming request - must be implemented by subclasses
   */
  abstract handleRequest(req: Request, res: Response): Promise<void>;

  /**
   * Validate request - can be overridden by subclasses
   */
  protected validateRequest(req: Request): ValidationResult {
    // Basic validation logic
    return { isValid: true, errors: [] };
  }

  /**
   * Build standardized error response
   */
  protected buildErrorResponse(error: any, requestId: string): ErrorResponse {
    return this.buildErrorPayload(error, requestId);
  }

  /**
   * Log helper forwarding to PipelineDebugLogger
   */
  protected logModule(moduleId: string, action: string, data?: Record<string, unknown>): void {
    this.logger.logModule(moduleId, action, data);
  }

  protected logError(error: unknown, context?: Record<string, unknown>): void {
    this.logger.logError(error, context);
  }

  /**
   * Sanitize headers for logging/security
   */
  protected sanitizeHeaders(headers: any): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = ['authorization', 'api-key', 'x-api-key', 'cookie'];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }

    return sanitized;
  }

  /**
   * Generate unique request ID
   */
  protected generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Send JSON response with standard headers
   */
  protected sendJsonResponse(res: Response, data: any, requestId: string): void {
    res.setHeader('x-request-id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json(data);
  }

  /**
   * Log request completion
   */
  protected logCompletion(requestId: string, startTime: number, success: boolean): void {
    const duration = Date.now() - startTime;
    this.logger.logModule(this.constructor.name, 'request_complete', {
      requestId,
      duration,
      success,
    });
  }

  /**
   * Handle error with proper logging and response
   */
  protected async handleError(error: Error, res: Response, requestId: string): Promise<void> {
    const errorResponse = this.buildErrorResponse(error, requestId);

    if (!res.headersSent) {
      res.setHeader('x-request-id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }

    res.status(errorResponse.status).json(errorResponse.body);
  }

  /**
   * Build error payload - can be overridden by subclasses for custom error handling
   */
  private buildErrorPayload(error: unknown, requestId: string): ErrorResponse {
    const e = error as Record<string, unknown>;

    // Determine status code
    const statusFromObj = typeof e?.status === 'number' ? e.status
      : (typeof e?.statusCode === 'number' ? e.statusCode
        : (e?.response && typeof e.response === 'object' && e.response !== null && 'status' in e.response && typeof (e.response as Record<string, unknown>).status === 'number' ? (e.response as Record<string, unknown>).status : undefined));
    const routeCodexStatus = error instanceof RouteCodexError ? error.status : undefined;
    const status = statusFromObj ?? routeCodexStatus ?? 500;

    // Extract error message
    const response = e?.response as any;
    const data = e?.data as any;
    const upstreamMsg = response?.data?.error?.message
      || response?.data?.message
      || data?.error?.message
      || data?.message
      || (typeof e?.message === 'string' ? e.message : undefined);

    let message = upstreamMsg ? String(upstreamMsg) : (error instanceof Error ? error.message : String(error));

    // Handle object stringification
    if (message && /^\[object\s+Object\]$/.test(message)) {
      const serializable = e?.response && typeof e.response === 'object' && e.response !== null && 'data' in e.response && (e.response as Record<string, unknown>).data && typeof (e.response as Record<string, unknown>).data === 'object' && (e.response as Record<string, unknown>).data !== null ? (e.response as Record<string, unknown>).data
        : e?.error ? e.error
        : e?.data ? e.data
        : e;
      try {
        message = JSON.stringify(serializable);
      } catch {
        message = 'Unknown error';
      }
    }

    // Determine error type and code
    const mapStatusToType = (s: number): string => {
      if (s === 400) {return 'bad_request';}
      if (s === 401) {return 'unauthorized';}
      if (s === 403) {return 'forbidden';}
      if (s === 404) {return 'not_found';}
      if (s === 408) {return 'request_timeout';}
      if (s === 409) {return 'conflict';}
      if (s === 422) {return 'unprocessable_entity';}
      if (s === 429) {return 'rate_limit_exceeded';}
      if (s >= 500) {return 'server_error';}
      return 'internal_error';
    };

    const rcxCode = error instanceof RouteCodexError ? error.code : undefined;
    const upstreamCode = response?.data?.error?.code || (typeof e?.code === 'string' ? e.code : undefined);
    const type = rcxCode || mapStatusToType(status as number);
    const code = upstreamCode || type;

    return {
      status: status as number,
      body: {
        error: {
          message,
          type,
          code,
          param: null,
          details: {
            requestId,
          },
        },
      },
    };
  }

  /**
   * Attach pipeline manager (called by router/server)
   */
  public attachPipelineManager(pipelineManager: unknown): void {
    this.pipelineManager = pipelineManager;
    if (pipelineManager) {
      this.serviceContainer.registerInstance(ServiceTokens.PIPELINE_MANAGER, pipelineManager);
    }
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    this.serviceContainer.registerInstance(ServiceTokens.ROUTE_POOLS, routePools);
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    this.routeMeta = routeMeta;
    this.serviceContainer.registerInstance(ServiceTokens.ROUTE_META, routeMeta);
  }

  public attachRoutingClassifier(classifier: { classify: (payload: unknown) => Promise<unknown> }): void {
    this.classifier = classifier;
    this.serviceContainer.registerInstance(ServiceTokens.ROUTING_CLASSIFIER, classifier);
  }

  public attachRoutingClassifierConfig(classifierConfig: Record<string, unknown>): void {
    this.classifierConfig = classifierConfig;
  }

  protected shouldUsePipeline(): boolean {
    return this.config.enablePipeline ?? false;
  }

  protected getPipelineManager(): any {
    if (this.pipelineManager) {
      return this.pipelineManager;
    }

    const resolved = this.serviceContainer.tryResolve<any>('PipelineManager');
    if (resolved) {
      this.pipelineManager = resolved;
      return resolved;
    }

    const globalPipeline = (globalThis as any)?.pipelineManager;
    if (globalPipeline) {
      this.pipelineManager = globalPipeline;
      return globalPipeline;
    }

    return null;
  }

  protected getRoutePools(): Record<string, string[]> | null {
    if (this.routePools) {
      return this.routePools;
    }

    const resolved = this.serviceContainer.tryResolve<Record<string, string[]>>(ServiceTokens.ROUTE_POOLS);
    if (resolved) {
      this.routePools = resolved;
      return resolved;
    }

    const globalPools = (globalThis as any)?.routePools;
    if (globalPools) {
      this.routePools = globalPools;
      return globalPools;
    }

    return null;
  }

  protected getRouteMeta(): Record<string, { providerId: string; modelId: string; keyId?: string }> | null {
    if (this.routeMeta) {
      return this.routeMeta;
    }

    const resolved = this.serviceContainer.tryResolve<Record<string, { providerId: string; modelId: string; keyId?: string }>>(ServiceTokens.ROUTE_META);
    if (resolved) {
      this.routeMeta = resolved;
      return resolved;
    }

    const globalMeta = (globalThis as any)?.routeMeta;
    if (globalMeta) {
      this.routeMeta = globalMeta;
      return globalMeta;
    }

    return null;
  }

  protected getClassifier(): { classify: (payload: unknown) => Promise<unknown> } | null {
    if (this.classifier) {
      return this.classifier;
    }

    const resolved = this.serviceContainer.tryResolve<{ classify: (payload: unknown) => Promise<unknown> }>(ServiceTokens.ROUTING_CLASSIFIER);
    if (resolved) {
      this.classifier = resolved;
      return resolved;
    }
    return null;
  }

  protected async decideRouteCategoryAsync(req: Request, defaultEndpoint: string = '/v1/chat/completions'): Promise<string> {
    const fallback = () => {
      const pools = this.getRoutePools();
      if (!pools) {
        return 'default';
      }
      if (pools.default) {
        return 'default';
      }
      const keys = Object.keys(pools);
      return keys[0] ?? 'default';
    };

    try {
      const classifier = this.getClassifier();
      if (!classifier) {
        return fallback();
      }

      const payload = {
        request: req.body,
        endpoint: req.url || defaultEndpoint,
        protocol: 'openai'
      };

      const result = await classifier.classify(payload);
      const route = result && typeof result === 'object' && result !== null && 'route' in result
        ? (result as Record<string, unknown>).route
        : undefined;

      if (typeof route === 'string' && this.getRoutePools()?.[route]) {
        return route;
      }

      return fallback();
    } catch {
      return fallback();
    }
  }

  protected pickPipelineId(routeName: string): string {
    const pools = this.getRoutePools();
    const pool = (pools && pools[routeName]) || [];
    if (pool.length === 0) {
      throw new Error(`No pipelines available for route ${routeName}`);
    }
    const idx = this.rrIndex.get(routeName) ?? 0;
    const chosen = pool[idx % pool.length];
    this.rrIndex.set(routeName, (idx + 1) % pool.length);
    return chosen;
  }

  protected getClassifierConfig(): Record<string, unknown> | null {
    return this.classifierConfig;
  }

  private ensureCoreServices(): void {
    if (!this.serviceContainer.isRegistered(ServiceTokens.ERROR_HANDLING_CENTER)) {
      initializeDefaultServices(this.serviceContainer);
    }
  }

  private resolveOrRegister<T>(token: string, factory: () => T, lifetime: ServiceLifetime): T {
    const existing = this.serviceContainer.tryResolve<T>(token);
    if (existing) {
      return existing;
    }

    this.serviceContainer.register(token, factory, lifetime);
    return this.serviceContainer.resolve<T>(token);
  }
}
