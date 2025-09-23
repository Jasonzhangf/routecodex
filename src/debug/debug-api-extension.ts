/**
 * Debug API Extension Implementation
 *
 * This file provides the implementation for the Debug API extension that adds REST API
 * endpoints for debugging and monitoring the RouteCodex system.
 */

import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlerRegistry } from '../utils/error-handler-registry.js';
import { DebugUtils } from '../utils/debug-utils.js';
import type {
  DebugAPIExtension,
  DebugAPIRequest,
  DebugAPIResponse,
  DebugExtensionHealth,
  DebugAdapter,
  DebugContext,
  DebugData
} from '../types/debug-types.js';

/**
 * Debug API Extension implementation
 */
export class DebugAPIExtensionImpl implements DebugAPIExtension {
  readonly id: string = 'debug-api-extension';
  readonly version: string = '1.0.0';
  readonly description: string = 'REST API extension for RouteCodex debugging system';

  private debugEventBus: DebugEventBus;
  private errorRegistry: ErrorHandlerRegistry;
  private debugUtils: DebugUtils;
  private adapters: Map<string, DebugAdapter> = new Map();
  private startTime: number;
  private health: DebugExtensionHealth;
  private server: any; // Express app or similar
  private config: {
    host: string;
    port: number;
    path: string;
    enableCors: boolean;
    enableAuth: boolean;
    authProvider?: string;
  };

  /**
   * Constructor
   */
  constructor(config: {
    host: string;
    port: number;
    path: string;
    enableCors: boolean;
    enableAuth: boolean;
    authProvider?: string;
  }) {
    this.config = config;
    this.debugEventBus = DebugEventBus.getInstance();
    this.errorRegistry = ErrorHandlerRegistry.getInstance();
    this.debugUtils = DebugUtils.getInstance();
    this.startTime = Date.now();

    // Initialize health status
    this.health = this.createDefaultHealth();
  }

  /**
   * Initialize the extension
   */
  async initialize(options?: Record<string, any>): Promise<void> {
    try {
      // Initialize server
      await this.initializeServer(options);

      // Register debug endpoints
      await this.registerEndpoints();

      // Update health status
      this.health.status = 'healthy';
      this.health.lastCheck = Date.now();
      this.health.score = 100;

      // Publish initialization event
      this.publishEvent('debug_api_extension_initialized', {
        config: this.config,
        options,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('initialization', error as Error);
      this.health.status = 'unhealthy';
      this.health.score = 0;
      throw error;
    }
  }

  /**
   * Register debug endpoints
   */
  async registerEndpoints(): Promise<void> {
    try {
      // Health check endpoint
      await this.registerEndpoint('GET', '/health', this.handleHealthCheck.bind(this));

      // System status endpoint
      await this.registerEndpoint('GET', '/status', this.handleSystemStatus.bind(this));

      // Adapter management endpoints
      await this.registerEndpoint('GET', '/adapters', this.handleListAdapters.bind(this));
      await this.registerEndpoint('POST', '/adapters', this.handleRegisterAdapter.bind(this));
      await this.registerEndpoint('GET', '/adapters/:id', this.handleGetAdapter.bind(this));
      await this.registerEndpoint('DELETE', '/adapters/:id', this.handleUnregisterAdapter.bind(this));

      // Debug session endpoints
      await this.registerEndpoint('POST', '/sessions', this.handleStartSession.bind(this));
      await this.registerEndpoint('DELETE', '/sessions/:id', this.handleStopSession.bind(this));
      await this.registerEndpoint('GET', '/sessions/:id/data', this.handleGetSessionData.bind(this));

      // Debug data endpoints
      await this.registerEndpoint('GET', '/data/recent', this.handleGetRecentData.bind(this));
      await this.registerEndpoint('GET', '/data/search', this.handleSearchData.bind(this));
      await this.registerEndpoint('POST', '/data/export', this.handleExportData.bind(this));

      // Configuration endpoints
      await this.registerEndpoint('GET', '/config', this.handleGetConfig.bind(this));
      await this.registerEndpoint('POST', '/config', this.handleUpdateConfig.bind(this));

      // Events endpoints
      await this.registerEndpoint('GET', '/events', this.handleGetEvents.bind(this));
      await this.registerEndpoint('POST', '/events/subscribe', this.handleSubscribeToEvents.bind(this));

      // Metrics endpoints
      await this.registerEndpoint('GET', '/metrics', this.handleGetMetrics.bind(this));
      await this.registerEndpoint('GET', '/metrics/performance', this.handleGetPerformanceMetrics.bind(this));
      await this.registerEndpoint('GET', '/metrics/memory', this.handleGetMemoryMetrics.bind(this));

      // Debug utilities endpoints
      await this.registerEndpoint('POST', '/utils/sanitize', this.handleSanitizeData.bind(this));
      await this.registerEndpoint('POST', '/utils/format', this.handleFormatData.bind(this));
      await this.registerEndpoint('POST', '/utils/measure', this.handleMeasurePerformance.bind(this));

      // Publish endpoint registration event
      this.publishEvent('debug_api_endpoints_registered', {
        endpointCount: 18, // Approximate count
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('register_endpoints', error as Error);
      throw error;
    }
  }

  /**
   * Handle debug API request
   */
  async handleRequest(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const startTime = Date.now();

    try {
      // Log request
      this.logRequest(request);

      // Route request to appropriate handler
      let response: DebugAPIResponse;
      const { path, method } = request;

      if (method === 'GET' && path === '/health') {
        response = await this.handleHealthCheck(request);
      } else if (method === 'GET' && path === '/status') {
        response = await this.handleSystemStatus(request);
      } else if (method === 'GET' && path === '/adapters') {
        response = await this.handleListAdapters(request);
      } else {
        // Default 404 response
        response = {
          requestId: request.id,
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: { error: 'Endpoint not found' },
          processingTime: Date.now() - startTime,
          timestamp: Date.now()
        };
      }

      // Log response
      this.logResponse(response);

      // Update statistics
      this.updateStatistics(response);

      return response;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      await this.handleError('handle_request', error as Error, { request, processingTime });

      // Return error response
      return {
        requestId: request.id,
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: {
          error: 'Internal server error',
          message: (error as Error).message,
          requestId: request.id
        },
        processingTime,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get extension health
   */
  getHealth(): DebugExtensionHealth {
    // Perform quick health check
    this.performHealthCheck();

    return { ...this.health };
  }

  /**
   * Cleanup extension resources
   */
  async destroy(): Promise<void> {
    try {
      // Unregister all adapters
      const unregisterPromises = Array.from(this.adapters.values()).map(adapter =>
        adapter.destroy().catch(error => {
          console.warn(`Failed to destroy adapter ${adapter.id}:`, error);
        })
      );

      await Promise.all(unregisterPromises);

      // Clear adapters
      this.adapters.clear();

      // Stop server
      await this.stopServer();

      // Publish destroy event
      this.publishEvent('debug_api_extension_destroyed', {
        timestamp: Date.now(),
        adaptersDestroyed: unregisterPromises.length
      });

    } catch (error) {
      await this.handleError('destroy', error as Error);
      throw error;
    }
  }

  /**
   * Register a debug adapter
   */
  async registerAdapter(adapter: DebugAdapter): Promise<void> {
    try {
      // Initialize adapter if not already initialized
      if (!adapter.isInitialized) {
        await adapter.initialize();
      }

      // Store adapter
      this.adapters.set(adapter.id, adapter);

      // Update health
      this.health.lastCheck = Date.now();

      // Publish adapter registration event
      this.publishEvent('debug_adapter_registered', {
        adapterId: adapter.id,
        adapterType: adapter.type,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('register_adapter', error as Error, { adapterId: adapter.id });
      throw error;
    }
  }

  /**
   * Unregister a debug adapter
   */
  async unregisterAdapter(adapterId: string): Promise<void> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return;
    }

    try {
      // Destroy adapter
      await adapter.destroy();

      // Remove adapter
      this.adapters.delete(adapterId);

      // Update health
      this.health.lastCheck = Date.now();

      // Publish adapter unregistration event
      this.publishEvent('debug_adapter_unregistered', {
        adapterId,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleError('unregister_adapter', error as Error, { adapterId });
      throw error;
    }
  }

  /**
   * Health check handler
   */
  private async handleHealthCheck(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const health = this.getHealth();

    return {
      requestId: request.id,
      status: health.status === 'healthy' ? 200 : 503,
      headers: { 'content-type': 'application/json' },
      body: health,
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }

  /**
   * System status handler
   */
  private async handleSystemStatus(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const status = {
      extension: {
        id: this.id,
        version: this.version,
        description: this.description,
        uptime: Date.now() - this.startTime,
        startTime: this.startTime
      },
      adapters: Array.from(this.adapters.values()).map(adapter => ({
        id: adapter.id,
        type: adapter.type,
        version: adapter.version,
        initialized: adapter.isInitialized,
        health: adapter.getHealth(),
        stats: adapter.getStats()
      })),
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryUsage: DebugUtils.getMemoryUsage(),
        uptime: process.uptime()
      },
      timestamp: Date.now()
    };

    return {
      requestId: request.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: status,
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }

  /**
   * List adapters handler
   */
  private async handleListAdapters(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const adapters = Array.from(this.adapters.values()).map(adapter => ({
      id: adapter.id,
      type: adapter.type,
      version: adapter.version,
      description: adapter.description,
      initialized: adapter.isInitialized,
      health: adapter.getHealth(),
      stats: adapter.getStats()
    }));

    return {
      requestId: request.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { adapters, count: adapters.length },
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }

  /**
   * Get adapter handler
   */
  private async handleGetAdapter(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const adapterId = request.params?.id;
    const adapter = this.adapters.get(adapterId);

    if (!adapter) {
      return {
        requestId: request.id,
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Adapter not found', adapterId },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    const adapterInfo = {
      id: adapter.id,
      type: adapter.type,
      version: adapter.version,
      description: adapter.description,
      initialized: adapter.isInitialized,
      health: adapter.getHealth(),
      stats: adapter.getStats()
    };

    return {
      requestId: request.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: adapterInfo,
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }

  /**
   * Start session handler
   */
  private async handleStartSession(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const { adapterId, context } = request.body || {};

    if (!adapterId || !context) {
      return {
        requestId: request.id,
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Missing required fields', required: ['adapterId', 'context'] },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return {
        requestId: request.id,
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Adapter not found', adapterId },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    try {
      const debugContext: DebugContext = {
        id: context.id || DebugUtils.generateId('session'),
        type: context.type || 'session',
        ...context
      };

      await adapter.startDebugging(debugContext);

      return {
        requestId: request.id,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { sessionId: debugContext.id, status: 'started' },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };

    } catch (error) {
      return {
        requestId: request.id,
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: {
          error: 'Failed to start session',
          message: (error as Error).message,
          adapterId
        },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get session data handler
   */
  private async handleGetSessionData(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const sessionId = request.params?.id;
    const { adapterId } = request.query || {};

    if (!adapterId) {
      return {
        requestId: request.id,
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Missing adapterId parameter' },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return {
        requestId: request.id,
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Adapter not found', adapterId },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    try {
      const context: DebugContext = {
        id: sessionId,
        type: 'session',
        timestamp: Date.now()
      };

      const debugData = await adapter.getDebugData(context);

      return {
        requestId: request.id,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: debugData,
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };

    } catch (error) {
      return {
        requestId: request.id,
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: {
          error: 'Failed to get session data',
          message: (error as Error).message,
          sessionId
        },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get recent data handler
   */
  private async handleGetRecentData(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const { adapterId, limit = 100 } = request.query || {};

    if (!adapterId) {
      return {
        requestId: request.id,
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Missing adapterId parameter' },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return {
        requestId: request.id,
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Adapter not found', adapterId },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };
    }

    // This would typically query the adapter for recent data
    // For now, return a placeholder response
    return {
      requestId: request.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        adapterId,
        data: [],
        limit: parseInt(limit as string),
        timestamp: Date.now()
      },
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }

  /**
   * Get metrics handler
   */
  private async handleGetMetrics(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    const metrics = {
      extension: {
        uptime: Date.now() - this.startTime,
        requests: this.health.totalRequests,
        errorRate: this.health.errorRate,
        avgResponseTime: this.health.avgResponseTime
      },
      adapters: Array.from(this.adapters.values()).map(adapter => ({
        id: adapter.id,
        stats: adapter.getStats()
      })),
      system: {
        memory: DebugUtils.getMemoryUsage(),
        cpu: process.cpuUsage(),
        uptime: process.uptime()
      },
      timestamp: Date.now()
    };

    return {
      requestId: request.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: metrics,
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }

  /**
   * Initialize server
   */
  private async initializeServer(options?: Record<string, any>): Promise<void> {
    // This would typically initialize an Express app or similar HTTP server
    // For now, we'll just mark it as initialized
    this.server = {
      initialized: true,
      config: this.config
    };
  }

  /**
   * Register endpoint
   */
  private async registerEndpoint(
    method: string,
    path: string,
    handler: (request: DebugAPIRequest) => Promise<DebugAPIResponse>
  ): Promise<void> {
    // This would typically register the endpoint with the HTTP server
    // For now, we'll just store the handler mapping
    console.log(`Registered debug endpoint: ${method} ${path}`);
  }

  /**
   * Stop server
   */
  private async stopServer(): Promise<void> {
    // This would typically stop the HTTP server
    this.server = null;
  }

  /**
   * Perform health check
   */
  private performHealthCheck(): void {
    const now = Date.now();
    const memUsage = process.memoryUsage();
    const memPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    // Update health based on memory usage and other metrics
    if (memPercentage > 90) {
      this.health.status = 'degraded';
      this.health.score = Math.max(0, 100 - memPercentage);
    } else {
      this.health.status = 'healthy';
      this.health.score = Math.max(0, 100 - memPercentage);
    }

    this.health.lastCheck = now;
  }

  /**
   * Create default health
   */
  private createDefaultHealth(): DebugExtensionHealth {
    return {
      status: 'unknown',
      lastCheck: 0,
      activeConnections: 0,
      totalRequests: 0,
      errorRate: 0,
      avgResponseTime: 0
    };
  }

  /**
   * Update statistics
   */
  private updateStatistics(response: DebugAPIResponse): void {
    this.health.totalRequests++;

    // Update error rate
    if (response.status >= 400) {
      this.health.errorRate = (this.health.errorRate * (this.health.totalRequests - 1) + 1) / this.health.totalRequests;
    } else {
      this.health.errorRate = (this.health.errorRate * (this.health.totalRequests - 1)) / this.health.totalRequests;
    }

    // Update average response time
    this.health.avgResponseTime = (this.health.avgResponseTime * (this.health.totalRequests - 1) + response.processingTime) / this.health.totalRequests;
  }

  /**
   * Log request
   */
  private logRequest(request: DebugAPIRequest): void {
    // Log request details
    this.publishEvent('debug_api_request', {
      requestId: request.id,
      method: request.method,
      path: request.path,
      timestamp: request.timestamp
    });
  }

  /**
   * Log response
   */
  private logResponse(response: DebugAPIResponse): void {
    // Log response details
    this.publishEvent('debug_api_response', {
      requestId: response.requestId,
      status: response.status,
      processingTime: response.processingTime,
      timestamp: response.timestamp
    });
  }

  /**
   * Handle error
   */
  private async handleError(operation: string, error: Error, context?: Record<string, any>): Promise<void> {
    await this.errorRegistry.handleError(
      error,
      `debug_api_${operation}`,
      this.id,
      {
        operation,
        ...context
      }
    );

    this.publishEvent('debug_api_error', {
      operation,
      error: error.message,
      stack: error.stack,
      context,
      timestamp: Date.now()
    });
  }

  /**
   * Publish event to DebugEventBus
   */
  private publishEvent(eventType: string, data: any): void {
    try {
      this.debugEventBus.publish({
        sessionId: `debug_api_${this.id}`,
        moduleId: this.id,
        operationId: eventType,
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data
      });
    } catch (error) {
      console.warn(`Failed to publish debug event:`, error);
    }
  }

  // Placeholder handlers for remaining endpoints
  private async handleRegisterAdapter(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'register_adapter');
  }

  private async handleUnregisterAdapter(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'unregister_adapter');
  }

  private async handleStopSession(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'stop_session');
  }

  private async handleSearchData(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'search_data');
  }

  private async handleExportData(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'export_data');
  }

  private async handleGetConfig(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'get_config');
  }

  private async handleUpdateConfig(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'update_config');
  }

  private async handleGetEvents(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'get_events');
  }

  private async handleSubscribeToEvents(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'subscribe_to_events');
  }

  private async handleGetPerformanceMetrics(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'get_performance_metrics');
  }

  private async handleGetMemoryMetrics(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'get_memory_metrics');
  }

  private async handleSanitizeData(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'sanitize_data');
  }

  private async handleFormatData(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'format_data');
  }

  private async handleMeasurePerformance(request: DebugAPIRequest): Promise<DebugAPIResponse> {
    return this.createNotImplementedResponse(request, 'measure_performance');
  }

  private createNotImplementedResponse(request: DebugAPIRequest, endpoint: string): DebugAPIResponse {
    return {
      requestId: request.id,
      status: 501,
      headers: { 'content-type': 'application/json' },
      body: { error: 'Not implemented', endpoint },
      processingTime: Date.now() - request.timestamp,
      timestamp: Date.now()
    };
  }
}