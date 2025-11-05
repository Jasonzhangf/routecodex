/**
 * V2 Dry Run Factory
 *
 * Factory and utilities for creating and managing V2 dry run integration.
 * Provides simple API for integrating V2 parallel execution into existing systems.
 */

import type { V2SystemConfig, PipelineRequest, PipelineResponse } from '../types/v2-types.js';
import type { V2DryRunAdapter, V2DryRunAdapterConfig, AdapterStatus } from './v2-dryrun-adapter.js';
import type { V2ParallelRunner, ParallelRunMetrics } from '../core/v2-parallel-runner.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Factory Configuration
 */
export interface V2DryRunFactoryConfig {
  v2Config: V2SystemConfig;
  enabled?: boolean;
  sampleRate?: number;
  autoStart?: boolean;
  failureThreshold?: number;
  loggingLevel?: 'none' | 'basic' | 'detailed';
}

/**
 * Dry Run Manager Interface
 */
export interface IV2DryRunManager {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  processRequest(
    requestId: string,
    request: PipelineRequest,
    v1Response?: PipelineResponse | null,
    v1Error?: Error | null,
    v1Duration?: number
  ): void;
  getStatus(): AdapterStatus;
  getMetrics(): {
      adapter: AdapterStatus;
      parallel?: ParallelRunMetrics;
      performance?: ReturnType<V2ParallelRunner['getPerformanceComparison']>;
    };
  shutdown(): Promise<void>;
}

/**
 * V2 Dry Run Factory
 *
 * Provides factory methods and utilities for V2 dry run integration.
 * Handles configuration, lifecycle management, and error handling.
 */
export class V2DryRunFactory {
  private static instances = new Map<string, V2DryRunAdapter>();
  private static defaultLogger = new PipelineDebugLogger();

  /**
   * Create V2 dry run manager with default configuration
   */
  static async createManager(
    config: V2DryRunFactoryConfig,
    instanceId: string = 'default'
  ): Promise<IV2DryRunManager> {
    if (this.instances.has(instanceId)) {
      throw new Error(`V2 dry run instance '${instanceId}' already exists`);
    }

    const logger = config.loggingLevel === 'none'
      ? undefined
      : this.defaultLogger;

    // Build adapter configuration
    const adapterConfig: V2DryRunAdapterConfig = {
      enabled: config.enabled ?? true,
      autoStart: config.autoStart ?? false,
      v2Config: config.v2Config,
      parallelConfig: {
        enabled: true,
        sampleRate: config.sampleRate ?? 0.1, // 10% sampling
        maxConcurrency: 5,
        timeoutMs: 30000,
        comparisonMode: 'lenient',
        metricsCollection: true
      },
      healthCheckInterval: 60000, // 1 minute
      metricsReportingInterval: 300000, // 5 minutes
      failureThreshold: config.failureThreshold ?? 0.5 // 50% failure rate
    };

    // Create adapter
    const { V2DryRunAdapter } = await import('./v2-dryrun-adapter.js');
    const adapter = new V2DryRunAdapter(adapterConfig, logger);
    await adapter.initialize();

    this.instances.set(instanceId, adapter);

    // Return manager interface
    return new V2DryRunManagerWrapper(adapter, instanceId);
  }

  /**
   * Get existing manager instance
   */
  static getManager(instanceId: string = 'default'): IV2DryRunManager | null {
    const adapter = this.instances.get(instanceId);
    if (!adapter) {
      return null;
    }

    return new V2DryRunManagerWrapper(adapter, instanceId);
  }

  /**
   * Remove manager instance
   */
  static async removeManager(instanceId: string): Promise<void> {
    const adapter = this.instances.get(instanceId);
    if (adapter) {
      await adapter.shutdown();
      this.instances.delete(instanceId);
    }
  }

  /**
   * Get all active instances
   */
  static getActiveInstances(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * Shutdown all instances
   */
  static async shutdownAll(): Promise<void> {
    const shutdownPromises = Array.from(this.instances.entries()).map(
      async ([id, adapter]) => {
        try {
          await adapter.shutdown();
        } catch (error) {
          this.defaultLogger.logModule('v2-dryrun-factory', 'shutdown-error', {
            instanceId: id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    );

    await Promise.allSettled(shutdownPromises);
    this.instances.clear();
  }

  /**
   * Create quick start configuration for testing
   */
  static createQuickStartConfig(v2Config: V2SystemConfig): V2DryRunFactoryConfig {
    return {
      v2Config,
      enabled: true,
      sampleRate: 0.05, // 5% sampling for conservative testing
      autoStart: true,
      failureThreshold: 0.8, // High threshold for testing
      loggingLevel: 'basic'
    };
  }

  /**
   * Create production configuration
   */
  static createProductionConfig(v2Config: V2SystemConfig): V2DryRunFactoryConfig {
    return {
      v2Config,
      enabled: true,
      sampleRate: 0.02, // 2% sampling for production
      autoStart: false,
      failureThreshold: 0.3, // Lower threshold for production
      loggingLevel: 'basic'
    };
  }

  /**
   * Create development configuration
   */
  static createDevelopmentConfig(v2Config: V2SystemConfig): V2DryRunFactoryConfig {
    // 强制 dry-run 模式：跳过实例预热，避免真实上游调用
    const cfg: V2SystemConfig = { ...v2Config, system: { ...v2Config.system, enableDryRun: true } };
    return {
      v2Config: cfg,
      enabled: true,
      sampleRate: 0.5, // 50% sampling for development
      autoStart: true,
      failureThreshold: 0.9, // Very high threshold for development
      loggingLevel: 'detailed'
    };
  }
}

/**
 * Manager Wrapper
 *
 * Wraps V2DryRunAdapter to provide a clean interface and handle factory management.
 */
class V2DryRunManagerWrapper implements IV2DryRunManager {
  private readonly adapter: V2DryRunAdapter;
  private readonly instanceId: string;

  constructor(adapter: V2DryRunAdapter, instanceId: string) {
    this.adapter = adapter;
    this.instanceId = instanceId;
  }

  async initialize(): Promise<void> {
    // Adapter is already initialized in factory
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  processRequest(
    requestId: string,
    request: PipelineRequest,
    v1Response: PipelineResponse | null = null,
    v1Error: Error | null = null,
    v1Duration: number = 0
  ): void {
    this.adapter.processRequest(requestId, request, v1Response, v1Error, v1Duration);
  }

  getStatus(): AdapterStatus {
    return this.adapter.getStatus();
  }

  getMetrics(): {
      adapter: AdapterStatus;
      parallel?: ParallelRunMetrics;
      performance?: ReturnType<V2ParallelRunner['getPerformanceComparison']>;
    } {
    return this.adapter.getMetrics();
  }

  async shutdown(): Promise<void> {
    await V2DryRunFactory.removeManager(this.instanceId);
  }
}

/**
 * Pipeline Integration Helper
 *
 * Provides helper functions for integrating V2 dry run into existing pipeline code.
 */
export class V2PipelineIntegrationHelper {
  private static stringifyHeaders(input: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[String(k)] = typeof v === 'string' ? v : JSON.stringify(v ?? '');
      }
    }
    return out;
  }
  /**
   * Create middleware for Express.js style pipelines
   */
  static createExpressMiddleware(dryRunManager: IV2DryRunManager) {
    type ExpressLikeRequest = { id?: string; method?: unknown; headers?: unknown; body?: unknown };
    type ExpressLikeResponse = { send: (data: unknown) => unknown; on: (event: 'error'|'finish', handler: (arg?: any) => void) => void; statusCode: number; getHeaders: () => Record<string, unknown> };
    return (req: Record<string, unknown>, res: Record<string, unknown>, next: (error?: unknown) => void) => {
      const startTime = Date.now();
      const reqLike = req as unknown as ExpressLikeRequest;
      const resLike = res as unknown as ExpressLikeResponse;
      const requestId = reqLike.id || `req-${Date.now()}`;

      // Capture response
      const originalSend = resLike.send.bind(resLike);
      let responseData: unknown;
      let responseError: Error | null = null;

      (resLike as ExpressLikeResponse).send = function(data: unknown) {
        responseData = data;
        return originalSend.call(this, data);
      };

      // Handle errors
      resLike.on('error', (error: Error) => {
        responseError = error;
      });

      // Process after response is sent
      resLike.on('finish', () => {
        const duration = Date.now() - startTime;

        const pipelineRequest: PipelineRequest = {
          id: requestId,
          method: (reqLike.method as string) || 'POST',
          headers: V2PipelineIntegrationHelper.stringifyHeaders(reqLike.headers),
          body: (reqLike.body as Record<string, unknown>) || ({} as Record<string, unknown>),
          metadata: {
            timestamp: startTime,
            source: 'express'
          }
        };

        const pipelineResponse: PipelineResponse | null = responseData ? {
          id: `response-${requestId}`,
          status: (resLike.statusCode as number) || 200,
          headers: V2PipelineIntegrationHelper.stringifyHeaders(resLike.getHeaders()),
          body: (typeof responseData === 'object' && responseData !== null
            ? (responseData as Record<string, unknown>)
            : { value: responseData } as Record<string, unknown>),
          metadata: {
            timestamp: Date.now(),
            duration,
            source: 'express'
          }
        } : null;

        dryRunManager.processRequest(requestId, pipelineRequest, pipelineResponse, responseError, duration);
      });

      next();
    };
  }

  /**
   * Create wrapper for existing request handlers
   */
  static wrapRequestHandler<
    T extends readonly unknown[],
    R
  >(
    dryRunManager: IV2DryRunManager,
    handler: (...args: T) => Promise<R>
  ) {
    return async (...args: T): Promise<R> => {
      const startTime = Date.now();
      const requestId = `req-${startTime}-${Math.random().toString(36).substr(2, 9)}`;

      try {
        const result = await handler(...args);
        const duration = Date.now() - startTime;

        // Try to extract request/response from arguments and result
        // This is a generic implementation - specific implementations may need customization
        const pipelineRequest = this.extractPipelineRequest(args, requestId, startTime);
        const pipelineResponse = this.extractPipelineResponse(result, requestId, duration);

        if (pipelineRequest) {
          dryRunManager.processRequest(requestId, pipelineRequest, pipelineResponse, null, duration);
        }

        return result;

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorObj = error instanceof Error ? error : new Error(String(error));

        const pipelineRequest = this.extractPipelineRequest(args, requestId, startTime);
        if (pipelineRequest) {
          dryRunManager.processRequest(requestId, pipelineRequest, null, errorObj, duration);
        }

        throw errorObj;
      }
    };
  }

  /**
   * Extract pipeline request from function arguments
   */
  private static extractPipelineRequest(args: readonly unknown[], requestId: string, timestamp: number): PipelineRequest | null {
    // This is a generic implementation - customize based on your request format
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      const firstArg = args[0] as Record<string, unknown>;

      // Check if it looks like a request object
      if (firstArg.method || firstArg.url || firstArg.body) {
        return {
          id: requestId,
          method: (firstArg.method as string) || 'POST',
          headers: V2PipelineIntegrationHelper.stringifyHeaders(firstArg.headers),
          body: (firstArg.body as Record<string, unknown>) || {},
          metadata: {
            timestamp,
            source: 'wrapped'
          }
        };
      }
    }

    return null;
  }

  /**
   * Extract pipeline response from function result
   */
  private static extractPipelineResponse(result: unknown, requestId: string, duration: number): PipelineResponse | null {
    // This is a generic implementation - customize based on your response format
    if (result && typeof result === 'object') {
      const resultObj = result as Record<string, unknown>;
      // Check if it looks like a response object
      if (resultObj.status !== undefined || resultObj.data !== undefined || resultObj.body !== undefined) {
        return {
          id: `response-${requestId}`,
          status: (resultObj.status as number) || 200,
          headers: V2PipelineIntegrationHelper.stringifyHeaders(resultObj.headers),
          body: (typeof resultObj.body === 'object' && resultObj.body !== null
            ? (resultObj.body as Record<string, unknown>)
            : (typeof resultObj.data === 'object' && resultObj.data !== null
              ? (resultObj.data as Record<string, unknown>)
              : (resultObj as Record<string, unknown>))),
          metadata: {
            timestamp: Date.now(),
            duration,
            source: 'wrapped'
          }
        };
      }
    }

    return null;
  }
}
