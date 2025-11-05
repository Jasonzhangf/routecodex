/**
 * Dynamic Connector
 *
 * Runtime connection manager for V2 virtual pipeline architecture.
 * Handles dynamic connection establishment, execution, and cleanup.
 */

import type { V2SystemConfig, RouteDefinition, PipelineRequest, PipelineResponse, RouteTableConfig, ModuleSpecification, RequestCondition, ModuleConfig } from '../types/v2-types.js';
import type { V2ModuleInstance } from './module-registry.js';
import { StaticInstancePool } from './static-instance-pool.js';
import { VirtualModuleChain } from './virtual-module-chain.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { V2ConnectionError } from '../types/v2-types.js';

/**
 * Connection Metrics
 */
export interface ConnectionMetrics {
  id: string;
  routeId: string;
  chainId: string;
  establishedAt: number;
  duration: number;
  moduleCount: number;
  success: boolean;
  error?: string;
  moduleTimings: Array<{
    moduleId: string;
    duration: number;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Dynamic Connector
 *
 * Manages runtime connections between static module instances.
 * Provides dynamic connection establishment, execution, and cleanup
 * while maintaining strict fail-fast behavior.
 */
export class DynamicConnector {
  private readonly logger: PipelineDebugLogger;
  private readonly metrics = new Map<string, ConnectionMetrics>();
  private readonly activeConnections = new Map<string, VirtualModuleChain>();

  constructor(logger?: PipelineDebugLogger) {
    this.logger = logger || new PipelineDebugLogger();
  }

  /**
   * Handle request through dynamic connection system
   */
  async handleRequest(
    request: PipelineRequest,
    v2Config: V2SystemConfig,
    staticInstancePool: StaticInstancePool
  ): Promise<PipelineResponse> {
    const connectionId = this.generateConnectionId();
    const startTime = Date.now();

    let connection: VirtualModuleChain | null = null;
    let route: RouteDefinition | null = null;
    const moduleTimings: Array<{
      moduleId: string;
      duration: number;
      success: boolean;
      error?: string;
    }> = [];

    try {
      this.logger.logModule('dynamic-connector', 'request-start', {
        connectionId,
        requestId: request.id,
        timestamp: startTime
      });

      // 1. Route request to appropriate route
      route = this.matchRoute(request, v2Config.virtualPipelines.routeTable);
      if (!route) {
        throw new V2ConnectionError(
          `No matching route found for request ${request.id}`,
          {
            connectionId,
            position: -1,
            moduleType: 'dynamic-router',
            moduleId: 'router',
            originalError: 'No matching route',
            timestamp: new Date().toISOString()
          }
        );
      }

      // 2. Build virtual module chain
      connection = await this.buildModuleChain(route, request, staticInstancePool, connectionId);
      this.activeConnections.set(connectionId, connection);

    // 3. Execute request through chain
    const response = await this.executeChain(connection, request);

      // 4. Record successful metrics
      const duration = Date.now() - startTime;
      this.recordMetrics(connectionId, route.id, connection.id, duration, true, moduleTimings);

      this.logger.logModule('dynamic-connector', 'request-success', {
        connectionId,
        routeId: route.id,
        chainId: connection.id,
        requestId: request.id,
        duration,
        moduleCount: moduleTimings.length
      });

      return response;

    } catch (error) {
      // 5. Handle error (fail fast with full context)
      const duration = Date.now() - startTime;
      const errorObj = error instanceof Error ? error : new Error(String(error));

      // Record error metrics
      this.recordMetrics(
        connectionId,
        route?.id || 'unknown',
        connection?.id || 'unknown',
        duration,
        false,
        moduleTimings
      );

      // Create structured error with full context
      const structuredError = this.createStructuredError(errorObj, request, connectionId, duration, moduleTimings);

      this.logger.logModule('dynamic-connector', 'request-error', {
        connectionId,
        routeId: route?.id || 'unknown',
        chainId: connection?.id || 'unknown',
        requestId: request.id,
        duration,
        error: structuredError.message,
        context: structuredError.context
      });

      // 6. Cleanup connection on error
      if (connection) {
        await this.cleanupConnection(connectionId);
      }

      throw structuredError;
    } finally {
      // 7. Ensure cleanup (even on success)
      if (connection) {
        await this.cleanupConnection(connectionId);
      }
    }
  }

  /**
   * Get connection metrics
   */
  getMetrics(): Record<string, ConnectionMetrics> {
    const result: Record<string, ConnectionMetrics> = {};

    for (const [connectionId, metrics] of this.metrics) {
      result[connectionId] = { ...metrics };
    }

    return result;
  }

  /**
   * Get active connections
   */
  getActiveConnections(): string[] {
    return Array.from(this.activeConnections.keys());
  }

  /**
   * Get connection status
   */
  getConnectionStatus(connectionId: string): { exists: boolean; metrics?: ConnectionMetrics; status: ReturnType<VirtualModuleChain['getStatus']> | null } {
    const connection = this.activeConnections.get(connectionId);
    const metrics = this.metrics.get(connectionId);

    return {
      exists: !!connection,
      metrics,
      status: connection ? connection.getStatus() : null
    };
  }

  /**
   * Force cleanup of all active connections
   */
  async forceCleanupAll(): Promise<number> {
    const connectionIds = Array.from(this.activeConnections.keys());
    let cleanedCount = 0;

    this.logger.logModule('dynamic-connector', 'force-cleanup-start', {
      activeConnections: connectionIds.length
    });

    for (const connectionId of connectionIds) {
      try {
        await this.cleanupConnection(connectionId);
        cleanedCount++;
      } catch (error) {
        this.logger.logModule('dynamic-connector', 'cleanup-error', {
          connectionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    this.logger.logModule('dynamic-connector', 'force-cleanup-complete', {
      cleanedConnections: cleanedCount,
      remainingConnections: this.activeConnections.size
    });

    return cleanedCount;
  }

  /**
   * Shutdown dynamic connector
   */
  async shutdown(): Promise<void> {
    this.logger.logModule('dynamic-connector', 'shutdown-start');

    await this.forceCleanupAll();

    this.metrics.clear();
    this.activeConnections.clear();

    this.logger.logModule('dynamic-connector', 'shutdown-complete');
  }

  /**
   * Match request to appropriate route
   */
  private matchRoute(request: PipelineRequest, routeTable: RouteTableConfig): RouteDefinition | null {
    // This is a simplified implementation
    // In a real implementation, this would use the DynamicRouter
    // For now, find the first route that matches basic criteria

    for (const route of routeTable.routes) {
      if (this.matchesRoute(route, request)) {
        return route;
      }
    }

    // Return default route if specified
    if (routeTable.defaultRoute) {
      return routeTable.routes.find((r: RouteDefinition) => r.id === routeTable.defaultRoute) || null;
    }

    return null;
  }

  /**
   * Check if request matches route
   */
  private matchesRoute(route: RouteDefinition, request: PipelineRequest): boolean {
    // Simple pattern matching - implement based on your route.pattern structure
    const body = request.body as unknown;

    // Check model matching
    if (route.pattern.model) {
      if (route.pattern.model instanceof RegExp) {
        const model = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>).model : undefined;
        if (typeof model !== 'string' || !route.pattern.model.test(model)) {
          return false;
        }
      } else if (typeof route.pattern.model === 'string') {
        const model = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>).model : undefined;
        if (typeof model !== 'string' || model !== route.pattern.model) {
          return false;
        }
      }
    }

    // Add more pattern matching logic as needed
    return true;
  }

  /**
   * Build virtual module chain for route
   */
  private async buildModuleChain(
    route: RouteDefinition,
    request: PipelineRequest,
    staticInstancePool: StaticInstancePool,
    connectionId: string
  ): Promise<VirtualModuleChain> {
    const chainId = `chain-${connectionId}`;
    const instances: V2ModuleInstance[] = [];

    try {
      // Get instances for all modules in route
      for (const moduleSpec of route.modules) {
        const config = this.resolveModuleConfig(moduleSpec, request);

        // Get instance from static pool (fail fast if not available)
        const instance = await staticInstancePool.getInstance(moduleSpec.type, config);
        instances.push(instance);
      }

      // Create virtual module chain
      const chain = new VirtualModuleChain(chainId, instances, route.id, this.logger);

      // Validate chain health
      const healthValidation = chain.validateHealth();
      if (!healthValidation.isValid) {
        throw new Error(`Module chain validation failed for route ${route.id}: ${healthValidation.errors.join(', ')}`);
      }

      this.logger.logModule('dynamic-connector', 'chain-built', {
        connectionId,
        chainId,
        routeId: route.id,
        moduleCount: instances.length,
        requestId: request.id
      });

      return chain;

    } catch (error) {
      // Cleanup any partially built chain
      if (instances.length > 0) {
        this.logger.logModule('dynamic-connector', 'chain-build-failed-cleanup', {
          connectionId,
          chainId: chainId || 'unknown',
          routeId: route.id,
          partialModules: instances.length,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      throw error;
    }
  }

  /**
   * Execute request through module chain
   */
  private async executeChain(
    chain: VirtualModuleChain,
    request: PipelineRequest
  ): Promise<PipelineResponse> {
    return chain.process(request);
  }

  /**
   * Cleanup connection
   */
  private async cleanupConnection(connectionId: string): Promise<void> {
    const connection = this.activeConnections.get(connectionId);
    if (!connection) {
      return;
    }

    try {
      await connection.cleanupConnections();
      this.activeConnections.delete(connectionId);

      this.logger.logModule('dynamic-connector', 'connection-cleanup', {
        connectionId,
        chainId: connection.id,
        routeId: connection.routeId
      });

    } catch (error) {
      this.logger.logModule('dynamic-connector', 'cleanup-error', {
        connectionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Resolve module configuration (fail fast on condition mismatch)
   */
  private resolveModuleConfig(moduleSpec: ModuleSpecification, request: PipelineRequest): ModuleConfig {
    // Check conditional selection - must match explicitly
    if (moduleSpec.condition && !this.evaluateCondition(moduleSpec.condition, request)) {
      throw new Error(
        `Condition failed for module ${moduleSpec.type}. No fallback allowed - fail fast.`
      );
    }

    // Resolve configuration reference
    if (typeof moduleSpec.config === 'string') {
      return this.getConfigReference(moduleSpec.config);
    }

    return moduleSpec.config as ModuleConfig;
  }

  /**
   * Evaluate request condition
   */
  private evaluateCondition(condition: RequestCondition, request: PipelineRequest): boolean {
    const value = this.extractValueFromRequest(request, condition.field);

    switch (condition.operator) {
      case 'equals':
        return value === condition.value;
      case 'contains':
        return typeof value === 'string' && typeof condition.value === 'string' && value.toLowerCase().includes(condition.value.toLowerCase());
      case 'exists':
        return value !== undefined && value !== null;
      case 'gt':
        return typeof value === 'number' && typeof condition.value === 'number' && value > condition.value;
      case 'lt':
        return typeof value === 'number' && typeof condition.value === 'number' && value < condition.value;
      default:
        return false;
    }
  }

  /**
   * Extract value from request
   */
  private extractValueFromRequest(request: PipelineRequest, field: string): unknown {
    const body = request.body as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return (body as Record<string, unknown>)[field];
    }
    return undefined;
  }

  /**
   * Get configuration reference
   */
  private getConfigReference(configId: string): ModuleConfig {
    // This would integrate with your configuration system
    // For now, return a basic structure
    return {
      type: configId,
      config: {}
    };
  }

  /**
   * Generate unique connection ID
   */
  private generateConnectionId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `conn-${timestamp}-${random}`;
  }

  /**
   * Create structured error
   */
  private createStructuredError(
    error: Error,
    request: PipelineRequest,
    connectionId: string,
    duration: number,
    moduleTimings: Array<{
      moduleId: string;
      duration: number;
      success: boolean;
      error?: string;
    }>
  ): V2ConnectionError {
    return new V2ConnectionError(
      `Dynamic connection failed for request ${request.id}: ${error.message}`,
      {
        connectionId,
        position: moduleTimings.length > 0 ? moduleTimings.length - 1 : -1,
        moduleType: moduleTimings.length > 0 ? moduleTimings[moduleTimings.length - 1].moduleId : 'unknown',
        moduleId: moduleTimings.length > 0 ? moduleTimings[moduleTimings.length - 1].moduleId : 'unknown',
        originalError: error.message,
        timestamp: new Date().toISOString()
      }
    );
  }

  /**
   * Record connection metrics
   */
  private recordMetrics(
    connectionId: string,
    routeId: string,
    chainId: string,
    duration: number,
    success: boolean,
    moduleTimings: Array<{
      moduleId: string;
      duration: number;
      success: boolean;
      error?: string;
    }>
  ): void {
    this.metrics.set(connectionId, {
      id: connectionId,
      routeId,
      chainId,
      establishedAt: Date.now(),
      duration,
      moduleCount: moduleTimings.length,
      success,
      error: success ? undefined : moduleTimings.find(m => !m.success)?.error,
      moduleTimings
    });
  }
}
