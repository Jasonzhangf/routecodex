/**
 * HTTP Server Debug Adapter Implementation
 *
 * This file provides the implementation for HTTP server debug adapters that can capture
 * HTTP requests, responses, and server lifecycle events for debugging purposes.
 */

import { BaseDebugAdapter } from './base-debug-adapter.js';
import { DebugEventBus } from 'rcc-debugcenter';
import type {
  HttpServerDebugAdapter,
  DebugContext,
  DebugData,
  HttpDebugData,
  DebugHttpRequest,
  DebugHttpResponse,
  DebugAdapterConfig,
  DebugUtils
} from '../types/debug-types.js';

/**
 * HTTP Server Debug Adapter implementation
 */
export class HttpServerDebugAdapterImpl extends BaseDebugAdapter implements HttpServerDebugAdapter {
  private serverInfo: {
    host: string;
    port: number;
    protocol: string;
  };
  private requestData: Map<string, DebugHttpRequest> = new Map();
  private responseData: Map<string, DebugHttpResponse> = new Map();
  private requestMetrics: Map<string, {
    startTime: number;
    events: any[];
  }> = new Map();

  /**
   * Constructor
   */
  constructor(
    config: DebugAdapterConfig,
    utils: DebugUtils,
    serverInfo: {
      host: string;
      port: number;
      protocol: string;
    }
  ) {
    super(config, utils);
    this.serverInfo = serverInfo;
  }

  /**
   * Get server information
   */
  get serverInfo(): {
    host: string;
    port: number;
    protocol: string;
  } {
    return { ...this.serverInfo };
  }

  /**
   * Initialize adapter-specific logic
   */
  protected async doInitialize(options?: Record<string, any>): Promise<void> {
    // Initialize server-specific debugging
    await this.initializeServerDebugging(options);

    // Publish server-specific initialization event
    this.publishEvent('http_server_debug_adapter_initialized', {
      serverInfo: this.serverInfo,
      options
    });
  }

  /**
   * Start debugging for specific context
   */
  protected async doStartDebugging(context: DebugContext): Promise<void> {
    // Setup server monitoring for this context
    await this.setupServerMonitoring(context);

    // Capture server state
    await this.captureServerState(context);

    // Publish context-specific debugging start event
    this.publishEvent('http_server_debugging_started', {
      serverInfo: this.serverInfo,
      context
    });
  }

  /**
   * Stop debugging for specific context
   */
  protected async doStopDebugging(context: DebugContext): Promise<void> {
    // Remove server monitoring for this context
    await this.removeServerMonitoring(context);

    // Cleanup context-specific data
    this.cleanupContextData(context);

    // Publish context-specific debugging stop event
    this.publishEvent('http_server_debugging_stopped', {
      serverInfo: this.serverInfo,
      context
    });
  }

  /**
   * Get debug data for specific context
   */
  protected async doGetDebugData(context: DebugContext): Promise<DebugData> {
    // Get HTTP-specific debug data
    const httpDebugData = await this.getHttpDebugData(context);

    return {
      id: this.debugUtils.generateId(`http_debug_${context.id}`),
      context,
      type: 'metrics',
      content: httpDebugData,
      timestamp: Date.now(),
      metadata: {
        serverInfo: this.serverInfo,
        adapterType: 'http_server'
      }
    };
  }

  /**
   * Configure adapter-specific settings
   */
  protected async doConfigure(config: Record<string, any>): Promise<void> {
    // Apply server-specific configuration
    if (config.captureHeaders !== undefined) {
      // Configure header capture
      this.getAdapterConfig().captureHeaders = config.captureHeaders;
    }

    if (config.captureBody !== undefined) {
      // Configure body capture
      this.getAdapterConfig().captureBody = config.captureBody;
    }

    if (config.maxRequestBodySize) {
      // Configure max request body size
      this.getAdapterConfig().maxRequestBodySize = config.maxRequestBodySize;
    }

    if (config.maxResponseBodySize) {
      // Configure max response body size
      this.getAdapterConfig().maxResponseBodySize = config.maxResponseBodySize;
    }

    // Update server configuration
    if (config.serverConfig) {
      await this.updateServerConfig(config.serverConfig);
    }
  }

  /**
   * Cleanup adapter-specific resources
   */
  protected async doDestroy(): Promise<void> {
    // Clear all request/response data
    this.requestData.clear();
    this.responseData.clear();
    this.requestMetrics.clear();

    // Publish cleanup event
    this.publishEvent('http_server_debug_adapter_destroyed', {
      serverInfo: this.serverInfo,
      requestsCleared: this.requestData.size,
      responsesCleared: this.responseData.size
    });
  }

  /**
   * Capture HTTP request
   */
  async captureRequest(request: DebugHttpRequest): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      // Sanitize request data
      const sanitizedRequest = this.sanitizeRequest(request);

      // Store request data
      this.requestData.set(request.id, sanitizedRequest);

      // Initialize request metrics
      this.requestMetrics.set(request.id, {
        startTime: request.timestamp,
        events: []
      });

      // Update statistics
      this.stats.totalEvents++;

      // Publish request captured event
      this.publishEvent('http_request_captured', {
        serverInfo: this.serverInfo,
        requestId: request.id,
        method: request.method,
        url: request.url,
        timestamp: request.timestamp
      });

    } catch (error) {
      await this.handleAdapterError('capture_request', error as Error, { requestId: request.id });
    }
  }

  /**
   * Capture HTTP response
   */
  async captureResponse(response: DebugHttpResponse): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      // Sanitize response data
      const sanitizedResponse = this.sanitizeResponse(response);

      // Store response data
      this.responseData.set(response.requestId, sanitizedResponse);

      // Update request metrics
      const metrics = this.requestMetrics.get(response.requestId);
      if (metrics) {
        metrics.events.push({
          type: 'response_completed',
          timestamp: response.timestamp,
          responseTime: response.responseTime,
          status: response.status
        });

        // Update performance statistics
        this.updatePerformanceStats(response.responseTime);
      }

      // Update statistics
      this.stats.totalEvents++;

      // Publish response captured event
      this.publishEvent('http_response_captured', {
        serverInfo: this.serverInfo,
        requestId: response.requestId,
        status: response.status,
        responseTime: response.responseTime,
        timestamp: response.timestamp
      });

    } catch (error) {
      await this.handleAdapterError('capture_response', error as Error, { requestId: response.requestId });
    }
  }

  /**
   * Get request/response data
   */
  async getHttpRequestData(requestId: string): Promise<HttpDebugData> {
    const request = this.requestData.get(requestId);
    const response = this.responseData.get(requestId);
    const metrics = this.requestMetrics.get(requestId);

    if (!request) {
      throw new Error(`Request not found: ${requestId}`);
    }

    const context: DebugContext = {
      id: this.debugUtils.generateId(`http_${requestId}`),
      type: 'request',
      requestId,
      timestamp: request.timestamp,
      metadata: {
        serverInfo: this.serverInfo
      }
    };

    const performance = this.calculatePerformanceMetrics(request, response, metrics);

    return {
      id: this.debugUtils.generateId(`http_debug_${requestId}`),
      context,
      type: 'metrics',
      content: {
        request,
        response,
        events: metrics?.events || [],
        performance
      },
      timestamp: Date.now(),
      metadata: {
        serverInfo: this.serverInfo,
        adapterType: 'http_server',
        hasResponse: !!response
      }
    };
  }

  /**
   * Initialize server-specific debugging
   */
  private async initializeServerDebugging(options?: Record<string, any>): Promise<void> {
    // Initialize with default configuration
    const adapterConfig = this.getAdapterConfig();
    adapterConfig.captureHeaders = options?.captureHeaders ?? true;
    adapterConfig.captureBody = options?.captureBody ?? true;
    adapterConfig.maxRequestBodySize = options?.maxRequestBodySize ?? 1024 * 1024; // 1MB
    adapterConfig.maxResponseBodySize = options?.maxResponseBodySize ?? 1024 * 1024; // 1MB
    adapterConfig.sensitiveHeaders = options?.sensitiveHeaders || [
      'authorization',
      'cookie',
      'x-api-key',
      'x-auth-token'
    ];
  }

  /**
   * Setup server monitoring for context
   */
  private async setupServerMonitoring(context: DebugContext): Promise<void> {
    // This can be used to setup context-specific server monitoring
    // For now, we'll just capture the current server state
    await this.captureServerState(context);
  }

  /**
   * Remove server monitoring for context
   */
  private async removeServerMonitoring(context: DebugContext): Promise<void> {
    // Clean up context-specific monitoring data
    this.cleanupContextData(context);
  }

  /**
   * Capture server state
   */
  private async captureServerState(context: DebugContext): Promise<void> {
    try {
      const state = await this.getCurrentServerState();

      this.publishEvent('http_server_state_captured', {
        serverInfo: this.serverInfo,
        context,
        state
      });
    } catch (error) {
      console.warn('Failed to capture server state:', error);
    }
  }

  /**
   * Get HTTP-specific debug data for context
   */
  private async getHttpDebugData(context: DebugContext): Promise<HttpDebugData> {
    // Collect recent requests and responses
    const recentRequests = Array.from(this.requestData.values())
      .filter(req => context.requestId ? req.id === context.requestId : true)
      .slice(-100); // Keep last 100 requests

    const recentResponses = recentRequests
      .map(req => this.responseData.get(req.id))
      .filter(Boolean) as DebugHttpResponse[];

    // Calculate aggregate performance metrics
    const aggregateMetrics = this.calculateAggregateMetrics(recentRequests, recentResponses);

    return {
      request: recentRequests[recentRequests.length - 1] || {
        id: 'sample',
        method: 'GET',
        url: '/sample',
        headers: {},
        timestamp: Date.now()
      },
      response: recentResponses[recentResponses.length - 1],
      events: [],
      performance: aggregateMetrics
    };
  }

  /**
   * Update server configuration
   */
  private async updateServerConfig(config: Record<string, any>): Promise<void> {
    // This would typically update the server configuration
    // For now, we'll just log the config change
    this.publishEvent('http_server_config_updated', {
      serverInfo: this.serverInfo,
      config
    });
  }

  /**
   * Get current server state
   */
  private async getCurrentServerState(): Promise<Record<string, any>> {
    return {
      timestamp: Date.now(),
      initialized: this.initialized,
      activeRequests: this.requestData.size - this.responseData.size,
      totalRequests: this.requestData.size,
      totalResponses: this.responseData.size,
      health: this.getHealth(),
      stats: this.getStats()
    };
  }

  /**
   * Sanitize request data
   */
  private sanitizeRequest(request: DebugHttpRequest): DebugHttpRequest {
    const adapterConfig = this.getAdapterConfig();

    let sanitized = { ...request };

    // Sanitize headers if enabled
    if (adapterConfig.captureHeaders) {
      sanitized.headers = this.sanitizeHeaders(request.headers, adapterConfig.sensitiveHeaders || []);
    } else {
      sanitized.headers = {};
    }

    // Sanitize body if enabled
    if (adapterConfig.captureBody && request.body) {
      sanitized.body = this.sanitizeBody(request.body, adapterConfig.maxRequestBodySize);
    } else {
      sanitized.body = undefined;
    }

    return sanitized;
  }

  /**
   * Sanitize response data
   */
  private sanitizeResponse(response: DebugHttpResponse): DebugHttpResponse {
    const adapterConfig = this.getAdapterConfig();

    let sanitized = { ...response };

    // Sanitize headers if enabled
    if (adapterConfig.captureHeaders) {
      sanitized.headers = this.sanitizeHeaders(response.headers, adapterConfig.sensitiveHeaders || []);
    } else {
      sanitized.headers = {};
    }

    // Sanitize body if enabled
    if (adapterConfig.captureBody && response.body) {
      sanitized.body = this.sanitizeBody(response.body, adapterConfig.maxResponseBodySize);
    } else {
      sanitized.body = undefined;
    }

    return sanitized;
  }

  /**
   * Sanitize headers
   */
  private sanitizeHeaders(headers: Record<string, string>, sensitiveHeaders: string[]): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.some(sensitive => key.toLowerCase().includes(sensitive.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Sanitize body
   */
  private sanitizeBody(body: any, maxSize: number): any {
    if (typeof body === 'string') {
      return body.length > maxSize ? `${body.substring(0, maxSize)}...[TRUNCATED]` : body;
    }

    if (typeof body === 'object') {
      const bodyString = JSON.stringify(body);
      if (bodyString.length > maxSize) {
        return '[LARGE OBJECT TRUNCATED]';
      }
      return this.debugUtils.sanitizeData(body, {
        maxDepth: 3,
        maxArrayLength: 10,
        maxStringLength: 100
      });
    }

    return body;
  }

  /**
   * Calculate performance metrics
   */
  private calculatePerformanceMetrics(
    request: DebugHttpRequest,
    response?: DebugHttpResponse,
    metrics?: { startTime: number; events: any[] }
  ): HttpDebugData['content']['performance'] {
    if (!response || !metrics) {
      return {
        totalProcessingTime: 0,
        serverProcessingTime: 0,
        networkTime: 0
      };
    }

    const totalProcessingTime = response.responseTime;
    const serverProcessingTime = metrics.events
      .filter(event => event.type.includes('server'))
      .reduce((total, event) => total + (event.duration || 0), 0);
    const networkTime = totalProcessingTime - serverProcessingTime;

    return {
      totalProcessingTime,
      serverProcessingTime,
      networkTime: Math.max(0, networkTime)
    };
  }

  /**
   * Calculate aggregate metrics
   */
  private calculateAggregateMetrics(
    requests: DebugHttpRequest[],
    responses: DebugHttpResponse[]
  ): HttpDebugData['content']['performance'] {
    if (responses.length === 0) {
      return {
        totalProcessingTime: 0,
        serverProcessingTime: 0,
        networkTime: 0
      };
    }

    const avgResponseTime = responses.reduce((sum, r) => sum + r.responseTime, 0) / responses.length;
    const maxResponseTime = Math.max(...responses.map(r => r.responseTime));
    const minResponseTime = Math.min(...responses.map(r => r.responseTime));

    return {
      totalProcessingTime: avgResponseTime,
      serverProcessingTime: avgResponseTime * 0.8, // Estimate 80% server time
      networkTime: avgResponseTime * 0.2 // Estimate 20% network time
    };
  }

  /**
   * Cleanup context-specific data
   */
  private cleanupContextData(context: DebugContext): void {
    // Remove request/response data for this context
    if (context.requestId) {
      this.requestData.delete(context.requestId);
      this.responseData.delete(context.requestId);
      this.requestMetrics.delete(context.requestId);
    }
  }

  /**
   * Get recent requests
   */
  getRecentRequests(count: number = 100): DebugHttpRequest[] {
    return Array.from(this.requestData.values()).slice(-count);
  }

  /**
   * Get recent responses
   */
  getRecentResponses(count: number = 100): DebugHttpResponse[] {
    return Array.from(this.responseData.values()).slice(-count);
  }

  /**
   * Get request metrics
   */
  getRequestMetrics(requestId: string): { startTime: number; events: any[] } | undefined {
    return this.requestMetrics.get(requestId);
  }

  /**
   * Clear old data
   */
  clearOldData(maxAge: number = 3600000): void { // 1 hour default
    const cutoffTime = Date.now() - maxAge;

    // Clear old request data
    for (const [id, request] of this.requestData.entries()) {
      if (request.timestamp < cutoffTime) {
        this.requestData.delete(id);
        this.responseData.delete(id);
        this.requestMetrics.delete(id);
      }
    }
  }
}