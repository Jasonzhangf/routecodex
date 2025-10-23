/**
 * Response Handler
 * Handles HTTP responses and formats them for clients
 */

import { BaseModule, type ModuleInfo } from 'rcc-basemodule';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import {
  type ResponseContext,
  type OpenAICompletionResponse,
  type ServerConfig,
  RouteCodexError,
} from '../server/types.js';
import type { UnknownObject } from '../types/common-types.js';

/**
 * Response handler options
 */
export interface ResponseHandlerOptions {
  enableCompression?: boolean;
  enableCaching?: boolean;
  cacheTTL?: number;
  enableCors?: boolean;
  enableMetrics?: boolean;
  maxResponseSize?: number;
}

/**
 * Cached response
 */
interface CachedResponse {
  data: UnknownObject;
  headers: Record<string, string>;
  timestamp: number;
  hits: number;
}

/**
 * Response Handler class
 */
export class ResponseHandler extends BaseModule {
  private config: ServerConfig;
  private debugEventBus: DebugEventBus;
  private errorHandling: ErrorHandlingCenter;
  private options: ResponseHandlerOptions;
  private responseCache: Map<string, CachedResponse> = new Map();
  private metrics: {
    totalResponses: number;
    cachedResponses: number;
    averageResponseSize: number;
    averageResponseTime: number;
  };
  private _isInitialized = false;
  public id: string;
  public type: string;
  public version: string;
  private responseHistory: Array<{
    id: string;
    requestId: string;
    status: number;
    timestamp: number;
    duration: number;
    wasCached: boolean;
    processingTime: number;
  }> = [];
  private errorHistory: Array<{
    id: string;
    requestId: string;
    error: string;
    timestamp: number;
    processingTime: number;
  }> = [];
  private maxHistorySize: number = 50;
  private streamingStats: {
    activeStreams: number;
    totalStreams: number;
    averageChunksPerStream: number;
    totalChunksSent: number;
  } = {
    activeStreams: 0,
    totalStreams: 0,
    averageChunksPerStream: 0,
    totalChunksSent: 0,
  };

  constructor(config: ServerConfig, options: ResponseHandlerOptions = {}) {
    const moduleInfo: ModuleInfo = {
      id: 'response-handler',
      name: 'ResponseHandler',
      version: '0.0.1',
      description: 'Handles HTTP responses and formats them for clients',
      type: 'core',
    };

    super(moduleInfo);

    this.config = config;
    try {
      this.debugEventBus = (String(process.env.ROUTECODEX_ENABLE_DEBUGCENTER || '0') === '1') ? DebugEventBus.getInstance() : (null as any);
    } catch { this.debugEventBus = null as any; }
    this.errorHandling = new ErrorHandlingCenter();

    // Add debug properties
    this.id = moduleInfo.id;
    this.type = 'core';
    this.version = moduleInfo.version || '0.0.1';

    // Set default options
    this.options = {
      enableCompression: true,
      enableCaching: false,
      cacheTTL: 300000, // 5 minutes
      enableCors: true,
      enableMetrics: true,
      maxResponseSize: 50 * 1024 * 1024, // 50MB
      ...options,
    };

    // Initialize metrics
    this.metrics = {
      totalResponses: 0,
      cachedResponses: 0,
      averageResponseSize: 0,
      averageResponseTime: 0,
    };
  }

  /**
   * Initialize the response handler
   */
  public async initialize(): Promise<void> {
    try {
      await this.errorHandling.initialize();
      this._isInitialized = true;

      (this.debugEventBus as any)?.publish?.({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'response_handler_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          options: this.options,
          cacheTTL: this.options.cacheTTL,
          maxResponseSize: this.options.maxResponseSize,
        },
      });
    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Handle successful response
   */
  public async handleSuccessResponse(responseContext: ResponseContext): Promise<ResponseContext> {
    const startTime = Date.now();

    try {
      (this.debugEventBus as any)?.publish?.({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'success_response_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          responseId: responseContext.id,
          requestId: responseContext.requestId,
          status: responseContext.status,
          duration: responseContext.duration,
        },
      });

      // Format response headers
      const headers = this.formatResponseHeaders(responseContext);

      // Format response body
      const body = this.formatResponseBody(responseContext);

      // Create final response context
      const finalResponseContext: ResponseContext = {
        ...responseContext,
        headers,
        body,
      };

      // Update metrics
      this.updateMetrics(finalResponseContext);

      // Cache response if enabled
      let wasCached = false;
      if (this.options.enableCaching && this.shouldCacheResponse(finalResponseContext)) {
        this.cacheResponse(finalResponseContext);
        wasCached = this.isResponseCached(finalResponseContext);
      }

      const processingTime = Date.now() - startTime;

      // Add to response history
      this.addToResponseHistory(finalResponseContext, processingTime, wasCached);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'success_response_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          responseId: responseContext.id,
          requestId: responseContext.requestId,
          processingTime,
          finalStatus: finalResponseContext.status,
          wasCached: this.isResponseCached(finalResponseContext),
        },
      });

      return finalResponseContext;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      await this.handleError(error as Error, 'success_response');

      // Return error response
      return this.createErrorResponse(
        responseContext.requestId,
        new RouteCodexError(
          'Failed to process successful response',
          'response_processing_error',
          500
        ),
        processingTime
      );
    }
  }

  /**
   * Handle error response
   */
  public async handleErrorResponse(
    requestId: string,
    error: Error | RouteCodexError,
    duration?: number
  ): Promise<ResponseContext> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'error_response_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          requestId,
          error: error.message,
          errorType: error instanceof RouteCodexError ? error.code : 'unknown',
          duration,
        },
      });

      const responseContext = this.createErrorResponse(requestId, error, duration);

      // Update metrics for error responses
      this.updateMetrics(responseContext);

      const processingTime = Date.now() - startTime;

      // Add to error history
      this.addResponseErrorToHistory(requestId, error.message, processingTime);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'error_response_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          requestId,
          processingTime,
          errorStatus: responseContext.status,
          errorType: (responseContext.body.error as Record<string, unknown>)?.['type'],
        },
      });

      return responseContext;
    } catch (handlerError) {
      const processingTime = Date.now() - startTime;
      console.error('Error in error response handler:', handlerError);

      // Fallback error response
      return {
        id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        requestId,
        timestamp: Date.now(),
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          error: {
            message: 'Internal server error',
            type: 'internal_error',
            code: 'internal_error',
          },
        },
        duration: processingTime,
      };
    }
  }

  /**
   * Handle streaming response
   */
  public async handleStreamingResponse(
    responseContext: ResponseContext,
    onChunk: (chunk: string) => void,
    onComplete: () => void
  ): Promise<void> {
    const startTime = Date.now();

    try {
      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'streaming_response_start',
        timestamp: startTime,
        type: 'start',
        position: 'middle',
        data: {
          responseId: responseContext.id,
          requestId: responseContext.requestId,
        },
      });

      // Format streaming headers
      const headers = this.formatStreamingHeaders(responseContext);

      // Set headers on the response context
      responseContext.headers = headers;

      // Simulate streaming chunks (in real implementation, this would stream from provider)
      const chunks = this.generateStreamingChunks(responseContext);

      // Update streaming stats
      this.streamingStats.activeStreams++;
      this.updateStreamingStats(chunks.length);

      for (const chunk of chunks) {
        onChunk(chunk);
        // Small delay to simulate real streaming
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      onComplete();

      const processingTime = Date.now() - startTime;

      // Update active streams count
      this.streamingStats.activeStreams--;

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'streaming_response_end',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          responseId: responseContext.id,
          requestId: responseContext.requestId,
          processingTime,
          chunkCount: chunks.length,
        },
      });
    } catch (error) {
      const processingTime = Date.now() - startTime;
      await this.handleError(error as Error, 'streaming_response');

      // Send error chunk
      onChunk(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'streaming_error',
            code: 'streaming_error',
          },
        })
      );

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: this.id,
        operationId: 'streaming_response_error',
        timestamp: Date.now(),
        type: 'error',
        position: 'middle',
        data: {
          responseId: responseContext.id,
          requestId: responseContext.requestId,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Format response headers
   */
  private formatResponseHeaders(responseContext: ResponseContext): Record<string, string> {
    const headers: Record<string, string> = {
      ...responseContext.headers,
      'X-Response-ID': responseContext.id,
      'X-Request-ID': responseContext.requestId,
      'X-Response-Time': responseContext.duration.toString(),
      'X-Server': 'RouteCodex/0.0.1',
    };

    // Add CORS headers if enabled
    if (this.options.enableCors) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With';
    }

    // Add security headers
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['X-Frame-Options'] = 'DENY';
    headers['X-XSS-Protection'] = '1; mode=block';

    // Add provider info if available
    if (responseContext.providerId) {
      headers['X-Provider'] = responseContext.providerId;
    }

    return headers;
  }

  /**
   * Format streaming headers
   */
  private formatStreamingHeaders(responseContext: ResponseContext): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Response-ID': responseContext.id,
      'X-Request-ID': responseContext.requestId,
      'X-Server': 'RouteCodex/0.0.1',
    };

    // Add CORS headers if enabled
    if (this.options.enableCors) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With';
    }

    return headers;
  }

  /**
   * Format response body
   */
  private formatResponseBody(responseContext: ResponseContext): UnknownObject {
    // If body is already properly formatted, return as-is
    if (responseContext.body && typeof responseContext.body === 'object') {
      // Add response metadata
      if (this.options.enableMetrics) {
        return {
          ...responseContext.body,
          _meta: {
            responseId: responseContext.id,
            requestId: responseContext.requestId,
            duration: responseContext.duration,
            provider: responseContext.providerId,
            model: responseContext.modelId,
            timestamp: responseContext.timestamp,
          },
        };
      }
    }

    return responseContext.body;
  }

  /**
   * Create error response
   */
  private createErrorResponse(
    requestId: string,
    error: Error | RouteCodexError,
    duration?: number
  ): ResponseContext {
    const status = error instanceof RouteCodexError ? error.status : 500;
    const code = error instanceof RouteCodexError ? error.code : 'internal_error';
    const type = error instanceof RouteCodexError ? error.code : 'internal_error';

    return {
      id: `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      requestId,
      timestamp: Date.now(),
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Response-ID': `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        'X-Request-ID': requestId,
        'X-Response-Time': duration?.toString() || '0',
        'X-Server': 'RouteCodex/0.0.1',
      },
      body: {
        error: {
          message: error.message,
          type: type,
          code: code,
        },
      },
      duration: duration || 0,
    };
  }

  /**
   * Generate streaming chunks
   */
  private generateStreamingChunks(responseContext: ResponseContext): string[] {
    const chunks: string[] = [];

    // Generate some sample streaming chunks
    const sampleResponse = responseContext.body as unknown as OpenAICompletionResponse;
    if (
      sampleResponse &&
      sampleResponse.choices &&
      Array.isArray(sampleResponse.choices) &&
      sampleResponse.choices.length > 0
    ) {
      const content = sampleResponse.choices[0].message.content || '';
      const words = content.split(' ');

      let currentChunk = '';
      for (const word of words) {
        currentChunk += `${word} `;

        // Create chunk every few words
        if (currentChunk.length > 20 || word === words[words.length - 1]) {
          chunks.push(
            JSON.stringify({
              id: sampleResponse.id,
              object: 'chat.completion.chunk',
              created: sampleResponse.created,
              model: sampleResponse.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: currentChunk.trim(),
                  },
                },
              ],
            })
          );
          currentChunk = '';
        }
      }
    }

    // Add final chunk
    chunks.push('[DONE]');

    return chunks;
  }

  /**
   * Check if response should be cached
   */
  private shouldCacheResponse(responseContext: ResponseContext): boolean {
    // Only cache successful GET requests or specific read-only operations
    if (responseContext.status !== 200) {
      return false;
    }

    // Don't cache streaming responses
    if (responseContext.headers['Content-Type'] === 'text/event-stream') {
      return false;
    }

    // Don't cache responses with usage data (they're unique per request)
    if (responseContext.usage) {
      return false;
    }

    return true;
  }

  /**
   * Cache response
   */
  private cacheResponse(responseContext: ResponseContext): void {
    const cacheKey = this.generateCacheKey(responseContext);

    const cachedResponse: CachedResponse = {
      data: responseContext.body,
      headers: responseContext.headers,
      timestamp: Date.now(),
      hits: 0,
    };

    this.responseCache.set(cacheKey, cachedResponse);

    // Clean up old cache entries
    this.cleanupCache();
  }

  /**
   * Check if response is cached
   */
  private isResponseCached(responseContext: ResponseContext): boolean {
    const cacheKey = this.generateCacheKey(responseContext);
    const cached = this.responseCache.get(cacheKey);

    if (!cached) {
      return false;
    }

    // Check if cache is still valid
    const now = Date.now();
    if (now - cached.timestamp > (this.options.cacheTTL || 300000)) {
      this.responseCache.delete(cacheKey);
      return false;
    }

    // Update hit count
    cached.hits++;

    // Update response context with cached data
    responseContext.body = cached.data;
    responseContext.headers = { ...responseContext.headers, ...cached.headers };
    responseContext.headers['X-Cache'] = 'HIT';

    return true;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(responseContext: ResponseContext): string {
    // Simple cache key based on request ID and response structure
    return `${responseContext.requestId}_${responseContext.status}_${JSON.stringify(responseContext.body)}`;
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    const ttl = this.options.cacheTTL || 300000;

    for (const [key, cached] of this.responseCache.entries()) {
      if (now - cached.timestamp > ttl) {
        this.responseCache.delete(key);
      }
    }
  }

  /**
   * Update metrics
   */
  private updateMetrics(responseContext: ResponseContext): void {
    if (!this.options.enableMetrics) {
      return;
    }

    this.metrics.totalResponses++;

    // Update average response size
    const responseSize = JSON.stringify(responseContext.body).length;
    if (this.metrics.totalResponses === 1) {
      this.metrics.averageResponseSize = responseSize;
    } else {
      this.metrics.averageResponseSize =
        (this.metrics.averageResponseSize * (this.metrics.totalResponses - 1) + responseSize) /
        this.metrics.totalResponses;
    }

    // Update average response time
    if (this.metrics.totalResponses === 1) {
      this.metrics.averageResponseTime = responseContext.duration;
    } else {
      this.metrics.averageResponseTime =
        (this.metrics.averageResponseTime * (this.metrics.totalResponses - 1) +
          responseContext.duration) /
        this.metrics.totalResponses;
    }

    // Check if response was cached
    if (responseContext.headers['X-Cache'] === 'HIT') {
      this.metrics.cachedResponses++;
    }
  }

  /**
   * Add response to history
   */
  private addToResponseHistory(
    responseContext: ResponseContext,
    processingTime: number,
    wasCached: boolean
  ): void {
    this.responseHistory.push({
      id: responseContext.id,
      requestId: responseContext.requestId,
      status: responseContext.status,
      timestamp: responseContext.timestamp,
      duration: responseContext.duration,
      wasCached,
      processingTime,
    });

    // Keep history size limited
    if (this.responseHistory.length > this.maxHistorySize) {
      this.responseHistory.shift();
    }
  }

  /**
   * Add error to history
   */
  private addResponseErrorToHistory(
    requestId: string,
    error: string,
    processingTime: number
  ): void {
    this.errorHistory.push({
      id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      requestId,
      error,
      timestamp: Date.now(),
      processingTime,
    });

    // Keep history size limited
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Update streaming stats
   */
  private updateStreamingStats(chunks: number): void {
    this.streamingStats.totalStreams++;
    this.streamingStats.totalChunksSent += chunks;

    // Update average chunks per stream
    if (this.streamingStats.totalStreams === 1) {
      this.streamingStats.averageChunksPerStream = chunks;
    } else {
      this.streamingStats.averageChunksPerStream =
        (this.streamingStats.averageChunksPerStream * (this.streamingStats.totalStreams - 1) +
          chunks) /
        this.streamingStats.totalStreams;
    }
  }

  /**
   * Get debug status with enhanced information
   */
  getDebugStatus(): UnknownObject {
    const baseStatus = {
      responseHandlerId: this.id,
      name: 'ResponseHandler',
      version: this.version,
      isInitialized: this._isInitialized,
      type: this.type,
      isEnhanced: true,
    };

    return {
      ...baseStatus,
      debugInfo: this.getDebugInfo(),
      responseMetrics: this.getResponseMetrics(),
      cacheStats: this.getCacheStats(),
      streamingStats: this.streamingStats,
      responseHistory: [...this.responseHistory.slice(-10)],
      errorHistory: [...this.errorHistory.slice(-10)],
    };
  }

  /**
   * Get detailed debug information
   */
  private getDebugInfo(): UnknownObject {
    return {
      responseHandlerId: this.id,
      name: 'ResponseHandler',
      version: this.version,
      enhanced: true,
      eventBusAvailable: !!this.debugEventBus,
      uptime: this._isInitialized ? Date.now() - (Date.now() - 10000) : 0, // Simplified uptime
      memoryUsage: process.memoryUsage(),
      responseHistorySize: this.responseHistory.length,
      errorHistorySize: this.errorHistory.length,
      maxHistorySize: this.maxHistorySize,
      activeStreams: this.streamingStats.activeStreams,
      totalStreamsProcessed: this.streamingStats.totalStreams,
    };
  }

  /**
   * Get response metrics
   */
  private getResponseMetrics(): UnknownObject {
    return {
      totalResponses: this.metrics.totalResponses,
      cachedResponses: this.metrics.cachedResponses,
      averageResponseSize: Math.round(this.metrics.averageResponseSize),
      averageResponseTime: Math.round(this.metrics.averageResponseTime),
      cacheHitRate:
        this.metrics.totalResponses > 0
          ? `${((this.metrics.cachedResponses / this.metrics.totalResponses) * 100).toFixed(2)}%`
          : '0%',
      compressionEnabled: this.options.enableCompression,
      corsEnabled: this.options.enableCors,
      metricsEnabled: this.options.enableMetrics,
    };
  }

  /**
   * Get cache statistics
   */
  private getCacheStats(): UnknownObject {
    return {
      cacheSize: this.responseCache.size,
      cacheEnabled: this.options.enableCaching,
      cacheTTL: this.options.cacheTTL,
      maxResponseSize: this.options.maxResponseSize,
      cacheHitRate:
        this.metrics.totalResponses > 0
          ? `${((this.metrics.cachedResponses / this.metrics.totalResponses) * 100).toFixed(2)}%`
          : '0%',
    };
  }

  /**
   * Get metrics
   */
  public getMetrics(): UnknownObject {
    return {
      ...this.metrics,
      cacheSize: this.responseCache.size,
      cacheEnabled: this.options.enableCaching,
      compressionEnabled: this.options.enableCompression,
      corsEnabled: this.options.enableCors,
    };
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.responseCache.clear();
  }

  /**
   * Handle error
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `${this.id}.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: this.id,
        context: {
          stack: error.stack,
          name: error.name,
        },
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Update configuration
   */
  public async updateConfig(newConfig: Partial<ServerConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: this.id,
      operationId: 'config_updated',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        changes: Object.keys(newConfig),
      },
    });
  }

  /**
   * Get handler status
   */
  public getStatus(): UnknownObject {
    return {
      initialized: this._isInitialized,
      running: true,
      options: this.options,
      metrics: this.getMetrics(),
      cacheSize: this.responseCache.size,
    };
  }

  /**
   * Stop response handler
   */
  public async stop(): Promise<void> {
    this.responseCache.clear();
    await this.errorHandling.destroy();
  }
}
