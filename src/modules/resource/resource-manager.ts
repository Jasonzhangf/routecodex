/**
 * RouteCodex Resource Manager
 *
 * Centralized resource pooling and management to eliminate resource duplication
 * across pipeline modules and provide efficient resource utilization.
 */

import { DebugEventBus } from 'rcc-debugcenter';
import type { DebugCenter } from '../pipeline/types/external-types.js';

/**
 * Resource pool configuration
 */
export interface ResourcePoolConfig {
  /** Maximum pool size */
  maxPoolSize?: number;
  /** Minimum pool size */
  minPoolSize?: number;
  /** Connection timeout in milliseconds */
  connectionTimeout?: number;
  /** Idle timeout in milliseconds */
  idleTimeout?: number;
  /** Health check interval in milliseconds */
  healthCheckInterval?: number;
  /** Enable health monitoring */
  enableHealthMonitoring?: boolean;
  /** Enable connection recycling */
  enableConnectionRecycling?: boolean;
}

/**
 * Connection pool interface
 */
export interface ConnectionPool {
  /** Pool identifier */
  readonly id: string;
  /** Pool configuration */
  readonly config: ResourcePoolConfig;
  /** Current pool size */
  readonly currentSize: number;
  /** Active connections count */
  readonly activeConnections: number;
  /** Available connections count */
  readonly availableConnections: number;
  /** Total connections created */
  readonly totalCreated: number;
  /** Total connections destroyed */
  readonly totalDestroyed: number;
  /** Get connection from pool */
  getConnection(): Promise<any>;
  /** Release connection back to pool */
  releaseConnection(connection: any): Promise<void>;
  /** Destroy connection */
  destroyConnection(connection: any): Promise<void>;
  /** Get pool statistics */
  getStatistics(): any;
  /** Close all connections */
  close(): Promise<void>;
}

/**
 * Resource metrics
 */
export interface ResourceMetrics {
  /** Resource identifier */
  resourceId: string;
  /** Resource type */
  resourceType: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp */
  lastAccessedAt: number;
  /** Access count */
  accessCount: number;
  /** Current status */
  status: 'active' | 'idle' | 'destroyed' | 'error';
  /** Resource size in bytes */
  size?: number;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Service instance interface
 */
export interface ServiceInstance {
  /** Service identifier */
  readonly id: string;
  /** Service type */
  readonly type: string;
  /** Service instance */
  instance: any;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp */
  lastAccessedAt: number;
  /** Reference count */
  referenceCount: number;
  /** Is service healthy */
  isHealthy: boolean;
  /** Get service status */
  getStatus(): any;
  /** Destroy service */
  destroy(): Promise<void>;
}

/**
 * Centralized Resource Manager
 *
 * Provides unified resource management, connection pooling, and service sharing
 * across all modules to eliminate resource duplication and improve performance.
 */
export class ResourceManager {
  private static instance: ResourceManager;
  private debugCenter: DebugCenter;
  private eventBus: DebugEventBus;
  private isInitialized = false;

  // Connection pools
  private connectionPools: Map<string, ConnectionPool> = new Map();
  private poolConfigs: Map<string, ResourcePoolConfig> = new Map();

  // Shared services
  private sharedServices: Map<string, ServiceInstance> = new Map();
  private serviceFactories: Map<string, () => Promise<any>> = new Map();

  // Resource metrics
  private resourceMetrics: Map<string, ResourceMetrics> = new Map();
  private metricsHistory: Map<string, any[]> = new Map();

  // Performance tracking
  private performanceMetrics: Map<string, any> = new Map();

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor(debugCenter: DebugCenter) {
    this.debugCenter = debugCenter;
    this.eventBus = DebugEventBus.getInstance();
  }

  /**
   * Get singleton instance
   */
  static getInstance(debugCenter?: DebugCenter): ResourceManager {
    if (!ResourceManager.instance) {
      if (!debugCenter) {
        throw new Error('DebugCenter required for first initialization');
      }
      ResourceManager.instance = new ResourceManager(debugCenter);
    }
    return ResourceManager.instance;
  }

  /**
   * Initialize the resource manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize default connection pools
      this.initializeDefaultPools();

      // Start health monitoring
      this.startHealthMonitoring();

      this.isInitialized = true;
      this.log('info', 'ResourceManager initialized successfully');
    } catch (error) {
      this.log('error', 'Failed to initialize ResourceManager', error);
      throw error;
    }
  }

  /**
   * Get or create connection pool for a provider
   */
  getConnectionPool(providerId: string, config?: ResourcePoolConfig): ConnectionPool {
    const poolId = `pool_${providerId}`;

    // Return existing pool if already exists
    if (this.connectionPools.has(poolId)) {
      return this.connectionPools.get(poolId)!;
    }

    // Create new pool with default or provided configuration
    const poolConfig: ResourcePoolConfig = {
      maxPoolSize: 10,
      minPoolSize: 1,
      connectionTimeout: 30000,
      idleTimeout: 300000,
      healthCheckInterval: 60000,
      enableHealthMonitoring: true,
      enableConnectionRecycling: true,
      ...config
    };

    // Store configuration
    this.poolConfigs.set(poolId, poolConfig);

    // Create and register connection pool
    const pool = this.createConnectionPool(poolId, poolConfig);
    this.connectionPools.set(poolId, pool);

    this.log('info', `Created connection pool for provider ${providerId}`);
    return pool;
  }

  /**
   * Get shared service instance
   */
  async getSharedService<T>(
    key: string,
    factory: () => Promise<T>,
    config?: { ttl?: number; forceRefresh?: boolean }
  ): Promise<T> {
    const now = Date.now();
    const ttl = config?.ttl || 300000; // 5 minutes default

    // Check if service exists and is healthy
    const existingService = this.sharedServices.get(key);
    if (existingService && existingService.isHealthy) {
      // Check TTL
      if (now - existingService.createdAt < ttl && !config?.forceRefresh) {
        existingService.lastAccessedAt = now;
        existingService.referenceCount++;
        this.recordResourceAccess(key);
        return existingService.instance as T;
      }

      // Service expired, destroy it
      await this.destroyService(existingService);
    }

    // Create new service instance
    const service = await this.createSharedService(key, factory);
    this.recordResourceAccess(key);

    return service.instance as T;
  }

  /**
   * Register service factory
   */
  registerServiceFactory(key: string, factory: () => Promise<any>): void {
    this.serviceFactories.set(key, factory);
    this.log('info', `Registered service factory for ${key}`);
  }

  /**
   * Get service from registered factory
   */
  async getService(key: string): Promise<any> {
    const factory = this.serviceFactories.get(key);
    if (!factory) {
      throw new Error(`No factory registered for service ${key}`);
    }
    return this.getSharedService(key, factory);
  }

  /**
   * Get resource metrics
   */
  getResourceMetrics(resourceId?: string): ResourceMetrics | Map<string, ResourceMetrics> {
    if (resourceId) {
      return this.resourceMetrics.get(resourceId)!;
    }
    return new Map(this.resourceMetrics);
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): Map<string, any> {
    return new Map(this.performanceMetrics);
  }

  /**
   * Get system-wide resource status
   */
  getSystemResourceStatus(): any {
    const pools: any = {};
    const services: any = {};

    // Connection pools status
    for (const [id, pool] of this.connectionPools) {
      pools[id] = {
        id: pool.id,
        currentSize: pool.currentSize,
        activeConnections: pool.activeConnections,
        availableConnections: pool.availableConnections,
        totalCreated: pool.totalCreated,
        totalDestroyed: pool.totalDestroyed,
        statistics: pool.getStatistics()
      };
    }

    // Shared services status
    for (const [key, service] of this.sharedServices) {
      services[key] = {
        id: service.id,
        type: service.type,
        referenceCount: service.referenceCount,
        isHealthy: service.isHealthy,
        age: Date.now() - service.createdAt,
        lastAccessed: Date.now() - service.lastAccessedAt,
        status: service.getStatus()
      };
    }

    return {
      managerId: 'ResourceManager',
      version: '1.0.0',
      isInitialized: this.isInitialized,
      poolCount: this.connectionPools.size,
      serviceCount: this.sharedServices.size,
      totalResourceCount: this.resourceMetrics.size,
      connectionPools: pools,
      sharedServices: services,
      timestamp: Date.now()
    };
  }

  /**
   * Cleanup expired resources
   */
  async cleanup(): Promise<void> {
    try {
      const now = Date.now();
      const expiredServices: ServiceInstance[] = [];

      // Find expired services
      for (const service of this.sharedServices.values()) {
        if (now - service.lastAccessedAt > 300000) { // 5 minutes
          expiredServices.push(service);
        }
      }

      // Destroy expired services
      for (const service of expiredServices) {
        await this.destroyService(service);
      }

      // Cleanup old metrics
      this.cleanupOldMetrics();

      this.log('info', `Cleaned up ${expiredServices.length} expired services`);
    } catch (error) {
      this.log('error', 'Failed to cleanup resources', error);
    }
  }

  /**
   * Destroy the resource manager
   */
  async destroy(): Promise<void> {
    try {
      // Close all connection pools
      for (const pool of this.connectionPools.values()) {
        await pool.close();
      }
      this.connectionPools.clear();

      // Destroy all shared services
      for (const service of this.sharedServices.values()) {
        await service.destroy();
      }
      this.sharedServices.clear();

      // Clear all metrics and configurations
      this.resourceMetrics.clear();
      this.metricsHistory.clear();
      this.performanceMetrics.clear();
      this.poolConfigs.clear();
      this.serviceFactories.clear();

      // Reset instance
      ResourceManager.instance = (null as any);
      this.isInitialized = false;

      this.log('info', 'ResourceManager destroyed successfully');
    } catch (error) {
      this.log('error', 'Failed to destroy ResourceManager', error);
      throw error;
    }
  }

  /**
   * Create a connection pool
   */
  private createConnectionPool(poolId: string, config: ResourcePoolConfig): ConnectionPool {
    const connections: any[] = [];
    const availableConnections: any[] = [];
    const activeConnections: Set<any> = new Set();
    let totalCreated = 0;
    let totalDestroyed = 0;

    const getConnection = async (): Promise<any> => {
        // Try to get available connection
        if (availableConnections.length > 0) {
          const connection = availableConnections.pop()!;
          activeConnections.add(connection);
          return connection;
        }

        // Create new connection if under limit
        if (connections.length < config.maxPoolSize!) {
          const connection = await this.createConnectionForPool(poolId);
          connections.push(connection);
          totalCreated++;
          activeConnections.add(connection);
          return connection;
        }

        // Wait for available connection
        return this.waitForAvailableConnectionForPool(poolId, availableConnections, activeConnections);
      };

      const releaseConnection = async (connection: any): Promise<void> => {
        if (activeConnections.has(connection)) {
          activeConnections.delete(connection);

          if (connections.length <= config.minPoolSize!) {
            availableConnections.push(connection);
          } else {
            // Destroy excess connection
            await this.destroyConnectionForPool(connection);
            const index = connections.indexOf(connection);
            if (index > -1) {
              connections.splice(index, 1);
            }
            totalDestroyed++;
          }
        }
      };

      const destroyConnection = async (connection: any): Promise<void> => {
        if (activeConnections.has(connection)) {
          activeConnections.delete(connection);
        }

        const index = connections.indexOf(connection);
        if (index > -1) {
          connections.splice(index, 1);
        }

        const availableIndex = availableConnections.indexOf(connection);
        if (availableIndex > -1) {
          availableConnections.splice(availableIndex, 1);
        }

        await this.destroyConnectionForPool(connection);
        totalDestroyed++;
      };

      const getStatistics = (): any => {
        return {
          currentSize: connections.length,
          activeConnections: activeConnections.size,
          availableConnections: availableConnections.length,
          totalCreated,
          totalDestroyed,
          utilizationRate: connections.length > 0 ? activeConnections.size / connections.length : 0,
          averageWaitTime: this.calculateAverageWaitTimeForPool(poolId)
        };
      };

      const close = async (): Promise<void> => {
        // Destroy all connections
        for (const connection of connections) {
          await this.destroyConnectionForPool(connection);
        }
        connections.length = 0;
        availableConnections.length = 0;
        activeConnections.clear();
      };

      const pool: ConnectionPool = {
        id: poolId,
        config,
        get currentSize() { return connections.length; },
        get activeConnections() { return activeConnections.size; },
        get availableConnections() { return availableConnections.length; },
        get totalCreated() { return totalCreated; },
        get totalDestroyed() { return totalDestroyed; },
        getConnection,
        releaseConnection,
        destroyConnection,
        getStatistics,
        close
      };

    // Initialize minimum connections
    (async () => {
      for (let i = 0; i < config.minPoolSize!; i++) {
        try {
          const connection = await this.createConnectionForPool(poolId);
          connections.push(connection);
          availableConnections.push(connection);
          totalCreated++;
        } catch (error) {
          this.log('warn', `Failed to create initial connection for pool ${poolId}`, error);
        }
      }
    })().catch(error => {
      this.log('error', `Failed to initialize connections for pool ${poolId}`, error);
    });

    return pool;
  }

  /**
   * Create a connection (mock implementation)
   */
  private async createConnectionForPool(poolId: string): Promise<any> {
    // Mock connection creation - in real implementation, this would
    // create actual HTTP connections or other resources
    await new Promise(resolve => setTimeout(resolve, 10)); // Simulate connection time

    return {
      id: `conn_${poolId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      poolId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isHealthy: true,
      useCount: 0
    };
  }

  /**
   * Destroy a connection (mock implementation)
   */
  private async destroyConnectionForPool(connection: any): Promise<void> {
    // Mock connection destruction
    connection.isHealthy = false;
    connection.destroyedAt = Date.now();
  }

  /**
   * Wait for available connection
   */
  private async waitForAvailableConnectionForPool(poolId: string, availableConnections: any[], activeConnections: Set<any>): Promise<any> {
    const startTime = Date.now();
    const timeout = this.poolConfigs.get(poolId)?.connectionTimeout || 30000;

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (availableConnections.length > 0) {
          clearInterval(checkInterval);
          const connection = availableConnections.pop()!;
          activeConnections.add(connection);
          connection.useCount++;
          connection.lastUsed = Date.now();
          resolve(connection);
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Connection timeout for pool ${poolId}`));
        }
      }, 100);
    });
  }

  /**
   * Create shared service instance
   */
  private async createSharedService(key: string, factory: () => Promise<any>): Promise<ServiceInstance> {
    const instance = await factory();
    const service: ServiceInstance = {
      id: `service_${key}_${Date.now()}`,
      type: key,
      instance,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      referenceCount: 1,
      isHealthy: true,
      getStatus(): any {
        return {
          id: this.id,
          type: this.type,
          referenceCount: this.referenceCount,
          isHealthy: this.isHealthy,
          age: Date.now() - this.createdAt
        };
      },
      async destroy(): Promise<void> {
        try {
          // Call destroy method if available
          if (typeof this.instance.destroy === 'function') {
            await this.instance.destroy();
          }
          this.isHealthy = false;
        } catch (error) {
          console.warn(`Failed to destroy service ${this.id}:`, error);
        }
      }
    };

    this.sharedServices.set(key, service);
    this.recordResourceCreation(key, service.type);

    this.log('info', `Created shared service for ${key}`);
    return service;
  }

  /**
   * Destroy service instance
   */
  private async destroyService(service: ServiceInstance): Promise<void> {
    try {
      await service.destroy();
      this.sharedServices.delete(service.id);
      this.recordResourceDestruction(service.id);
    } catch (error) {
      this.log('error', `Failed to destroy service ${service.id}`, error);
    }
  }

  /**
   * Initialize default connection pools
   */
  private initializeDefaultPools(): void {
    // Initialize common provider pools
    const defaultProviders = ['lmstudio', 'qwen', 'openai', 'anthropic'];

    for (const provider of defaultProviders) {
      this.getConnectionPool(provider, {
        maxPoolSize: 5,
        minPoolSize: 1,
        connectionTimeout: 30000,
        idleTimeout: 300000
      });
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    // Start periodic cleanup
    setInterval(() => {
      this.cleanup().catch(error => {
        this.log('error', 'Health monitoring cleanup failed', error);
      });
    }, 60000); // Every minute
  }

  /**
   * Record resource creation
   */
  private recordResourceCreation(resourceId: string, resourceType: string): void {
    const metrics: ResourceMetrics = {
      resourceId,
      resourceType,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      status: 'active'
    };

    this.resourceMetrics.set(resourceId, metrics);
    this.recordPerformanceMetric('resource_created', { resourceId, resourceType });
  }

  /**
   * Record resource access
   */
  private recordResourceAccess(resourceId: string): void {
    const metrics = this.resourceMetrics.get(resourceId);
    if (metrics) {
      metrics.lastAccessedAt = Date.now();
      metrics.accessCount++;
    }

    this.recordPerformanceMetric('resource_accessed', { resourceId });
  }

  /**
   * Record resource destruction
   */
  private recordResourceDestruction(resourceId: string): void {
    const metrics = this.resourceMetrics.get(resourceId);
    if (metrics) {
      metrics.status = 'destroyed';
      metrics.lastAccessedAt = Date.now();
    }

    this.recordPerformanceMetric('resource_destroyed', { resourceId });
  }

  /**
   * Record performance metric
   */
  private recordPerformanceMetric(metricName: string, data: any): void {
    const now = Date.now();

    if (!this.performanceMetrics.has(metricName)) {
      this.performanceMetrics.set(metricName, {
        count: 0,
        lastUpdated: now,
        values: []
      });
    }

    const metric = this.performanceMetrics.get(metricName)!;
    metric.count++;
    metric.lastUpdated = now;
    metric.values.push({ ...data, timestamp: now });

    // Keep only last 100 values
    if (metric.values.length > 100) {
      metric.values.shift();
    }
  }

  /**
   * Cleanup old metrics
   */
  private cleanupOldMetrics(): void {
    const cutoffTime = Date.now() - 3600000; // 1 hour ago

    // Clean old performance metrics
    for (const [name, metric] of this.performanceMetrics) {
      metric.values = metric.values.filter((v: any) => v.timestamp > cutoffTime);
    }

    // Clean old resource metrics
    for (const [id, metrics] of this.resourceMetrics) {
      if (metrics.status === 'destroyed' && metrics.lastAccessedAt < cutoffTime) {
        this.resourceMetrics.delete(id);
      }
    }
  }

  /**
   * Calculate average wait time (mock implementation)
   */
  private calculateAverageWaitTimeForPool(poolId: string): number {
    // Mock implementation - would track actual wait times in real implementation
    return Math.random() * 100; // Random wait time between 0-100ms
  }

  /**
   * Internal logging method
   */
  private log(level: 'info' | 'warn' | 'error', message: string, error?: any): void {
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      component: 'ResourceManager',
      error: error ? error.message || String(error) : undefined
    };

    // Publish to debug event bus
    this.eventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'ResourceManager',
      operationId: 'log_message',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: logEntry
    });

    // Console output for critical messages
    if (level === 'error' || process.env.NODE_ENV === 'development') {
      console.log(`[ResourceManager] ${level.toUpperCase()}: ${message}`, error || '');
    }
  }
}