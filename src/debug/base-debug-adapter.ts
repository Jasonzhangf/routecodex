/**
 * Base Debug Adapter Implementation
 *
 * This file provides the base implementation for all debug adapters in the RouteCodex debugging system.
 * It includes common functionality for initialization, health monitoring, statistics tracking,
 * and resource management.
 */

import { DebugEventBus } from '../utils/external-mocks.js';
import { ErrorHandlerRegistry } from '../utils/error-handler-registry.js';
import type {
  DebugAdapter,
  DebugAdapterConfig,
  DebugContext,
  DebugData,
  DebugAdapterHealth,
  DebugAdapterStats,
  DebugHealthIssue,
  DebugUtils
} from '../types/debug-types.js';
import { DebugSystemEvent } from '../types/debug-types.js';

/**
 * Abstract base class for all debug adapters
 */
export abstract class BaseDebugAdapter implements DebugAdapter {
  protected debugEventBus: DebugEventBus;
  protected errorRegistry: ErrorHandlerRegistry;
  protected debugUtils: DebugUtils;

  protected initialized = false;
  protected config: DebugAdapterConfig;
  protected startTime: number;
  protected sessions: Map<string, DebugContext> = new Map();
  protected stats: DebugAdapterStats;
  protected health: DebugAdapterHealth;
  protected issues: DebugHealthIssue[] = [];

  /**
   * Constructor
   */
  constructor(config: DebugAdapterConfig, utils: DebugUtils) {
    this.config = {
      enabled: true,
      priority: 0,
      ...config
    };

    this.debugEventBus = DebugEventBus.getInstance();
    this.errorRegistry = ErrorHandlerRegistry.getInstance();
    this.debugUtils = utils;
    this.startTime = Date.now();

    // Initialize default stats
    this.stats = this.createDefaultStats();

    // Initialize default health
    this.health = this.createDefaultHealth();

    // Publish adapter registration event
    this.publishEvent(DebugSystemEvent.ADAPTER_REGISTERED, {
      adapterId: this.id,
      adapterType: this.type,
      config: this.config
    });
  }

  /**
   * Get adapter identifier
   */
  get id(): string {
    return this.config.id;
  }

  /**
   * Get adapter type
   */
  get type(): string {
    return this.config.type;
  }

  /**
   * Get adapter version
   */
  get version(): string {
    return '1.0.0';
  }

  /**
   * Get adapter description
   */
  get description(): string {
    return `${this.type} debug adapter for ${this.id}`;
  }

  /**
   * Check if adapter is initialized
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize the adapter
   */
  async initialize(options?: Record<string, any>): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Initialize adapter-specific logic
      await this.doInitialize(options);

      // Update initialization status
      this.initialized = true;

      // Update health status
      this.health.status = 'healthy';
      this.health.lastCheck = Date.now();
      this.health.score = 100;

      // Publish initialization event
      this.publishEvent(DebugSystemEvent.ADAPTER_INITIALIZED, {
        adapterId: this.id,
        options,
        timestamp: Date.now()
      });

    } catch (error) {
      // Handle initialization error
      await this.handleAdapterError('initialization', error as Error);
      this.health.status = 'unhealthy';
      this.health.score = 0;
      throw error;
    }
  }

  /**
   * Start debugging for a specific context
   */
  async startDebugging(context: DebugContext): Promise<void> {
    if (!this.initialized) {
      throw new Error(`Adapter ${this.id} is not initialized`);
    }

    try {
      // Validate context
      this.validateContext(context);

      // Store session
      this.sessions.set(context.id, context);

      // Update statistics
      this.stats.totalSessions++;
      this.stats.activeSessions++;

      // Adapter-specific debugging start
      await this.doStartDebugging(context);

      // Publish session started event
      this.publishEvent(DebugSystemEvent.SESSION_STARTED, {
        adapterId: this.id,
        context,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleAdapterError('start_debugging', error as Error, { context });
      throw error;
    }
  }

  /**
   * Stop debugging for a specific context
   */
  async stopDebugging(context: DebugContext): Promise<void> {
    if (!this.sessions.has(context.id)) {
      return;
    }

    try {
      // Adapter-specific debugging stop
      await this.doStopDebugging(context);

      // Remove session
      this.sessions.delete(context.id);

      // Update statistics
      this.stats.activeSessions = Math.max(0, this.stats.activeSessions - 1);

      // Publish session ended event
      this.publishEvent(DebugSystemEvent.SESSION_ENDED, {
        adapterId: this.id,
        context,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleAdapterError('stop_debugging', error as Error, { context });
      throw error;
    }
  }

  /**
   * Get debug data for a specific context
   */
  async getDebugData(context: DebugContext): Promise<DebugData> {
    if (!this.sessions.has(context.id)) {
      throw new Error(`No active debug session for context: ${context.id}`);
    }

    try {
      // Get adapter-specific debug data
      const data = await this.doGetDebugData(context);

      // Update statistics
      this.stats.totalEvents++;

      // Publish data captured event
      this.publishEvent(DebugSystemEvent.DATA_CAPTURED, {
        adapterId: this.id,
        context,
        dataType: data.type,
        timestamp: Date.now()
      });

      return data;

    } catch (error) {
      await this.handleAdapterError('get_debug_data', error as Error, { context });
      throw error;
    }
  }

  /**
   * Get adapter health status
   */
  getHealth(): DebugAdapterHealth {
    // Perform quick health check
    this.performQuickHealthCheck();

    return {
      ...this.health,
      issues: [...this.issues]
    };
  }

  /**
   * Get adapter statistics
   */
  getStats(): DebugAdapterStats {
    // Update memory usage
    this.updateMemoryUsage();

    return {
      ...this.stats,
      memoryUsage: { ...this.stats.memoryUsage },
      performance: { ...this.stats.performance },
      custom: this.stats.custom ? { ...this.stats.custom } : undefined
    };
  }

  /**
   * Configure the adapter
   */
  async configure(config: Record<string, any>): Promise<void> {
    try {
      // Merge configuration
      this.config = {
        ...this.config,
        config: {
          ...this.config.config,
          ...config
        }
      };

      // Adapter-specific configuration
      await this.doConfigure(config);

      // Publish configuration update event
      this.publishEvent(DebugSystemEvent.ADAPTER_CONFIGURED, {
        adapterId: this.id,
        config,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleAdapterError('configure', error as Error, { config });
      throw error;
    }
  }

  /**
   * Cleanup adapter resources
   */
  async destroy(): Promise<void> {
    try {
      // Stop all active sessions
      const stopPromises = Array.from(this.sessions.values()).map(context =>
        this.stopDebugging(context).catch(error => {
          console.warn(`Failed to stop debug session for context ${context.id}:`, error);
        })
      );

      await Promise.all(stopPromises);

      // Adapter-specific cleanup
      await this.doDestroy();

      // Clear sessions
      this.sessions.clear();

      // Reset initialization status
      this.initialized = false;

      // Publish destroy event
      this.publishEvent(DebugSystemEvent.ADAPTER_DESTROYED, {
        adapterId: this.id,
        timestamp: Date.now()
      });

    } catch (error) {
      await this.handleAdapterError('destroy', error as Error);
      throw error;
    }
  }

  /**
   * Abstract method: Initialize adapter-specific logic
   */
  protected abstract doInitialize(options?: Record<string, any>): Promise<void>;

  /**
   * Abstract method: Start debugging for specific context
   */
  protected abstract doStartDebugging(context: DebugContext): Promise<void>;

  /**
   * Abstract method: Stop debugging for specific context
   */
  protected abstract doStopDebugging(context: DebugContext): Promise<void>;

  /**
   * Abstract method: Get debug data for specific context
   */
  protected abstract doGetDebugData(context: DebugContext): Promise<DebugData>;

  /**
   * Abstract method: Configure adapter-specific settings
   */
  protected abstract doConfigure(config: Record<string, any>): Promise<void>;

  /**
   * Abstract method: Cleanup adapter-specific resources
   */
  protected abstract doDestroy(): Promise<void>;

  /**
   * Create default statistics
   */
  protected createDefaultStats(): DebugAdapterStats {
    return {
      totalSessions: 0,
      activeSessions: 0,
      totalEvents: 0,
      totalErrors: 0,
      avgProcessingTime: 0,
      memoryUsage: {
        used: 0,
        total: 0,
        percentage: 0
      },
      performance: {
        avgResponseTime: 0,
        maxResponseTime: 0,
        minResponseTime: Infinity,
        throughput: 0
      }
    };
  }

  /**
   * Create default health status
   */
  protected createDefaultHealth(): DebugAdapterHealth {
    return {
      status: 'unknown',
      lastCheck: 0,
      score: 0,
      issues: []
    };
  }

  /**
   * Validate debug context
   */
  protected validateContext(context: DebugContext): void {
    if (!context.id) {
      throw new Error('Debug context must have an ID');
    }

    if (!context.type) {
      throw new Error('Debug context must have a type');
    }

    if (!context.timestamp) {
      context.timestamp = Date.now();
    }
  }

  /**
   * Perform quick health check
   */
  protected performQuickHealthCheck(): void {
    const now = Date.now();

    // Check if adapter is initialized
    if (!this.initialized) {
      this.health.status = 'unhealthy';
      this.health.score = 0;
      return;
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    const memPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    if (memPercentage > 90) {
      this.health.status = 'degraded';
      this.health.score = Math.max(0, 100 - memPercentage);
      this.addHealthIssue('high_memory_usage', 'high', 'memory',
        `Memory usage is high: ${memPercentage.toFixed(2)}%`);
    } else {
      this.health.status = 'healthy';
      this.health.score = Math.max(0, 100 - memPercentage);
    }

    // Clear resolved issues
    this.issues = this.issues.filter(issue => {
      return issue.severity === 'critical' ||
             (now - issue.timestamp) < 300000; // Keep critical issues for 5 minutes
    });

    this.health.lastCheck = now;
  }

  /**
   * Update memory usage statistics
   */
  protected updateMemoryUsage(): void {
    const memUsage = process.memoryUsage();
    this.stats.memoryUsage = {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
      percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100
    };
  }

  /**
   * Update performance statistics
   */
  protected updatePerformanceStats(responseTime: number): void {
    const perf = this.stats.performance;

    perf.avgResponseTime = (perf.avgResponseTime * (this.stats.totalEvents - 1) + responseTime) / this.stats.totalEvents;
    perf.maxResponseTime = Math.max(perf.maxResponseTime, responseTime);
    perf.minResponseTime = Math.min(perf.minResponseTime, responseTime);

    // Calculate throughput (events per second)
    const uptime = (Date.now() - this.startTime) / 1000;
    perf.throughput = this.stats.totalEvents / uptime;
  }

  /**
   * Add health issue
   */
  protected addHealthIssue(
    id: string,
    severity: DebugHealthIssue['severity'],
    type: DebugHealthIssue['type'],
    description: string,
    recommendedAction?: string
  ): void {
    const issue: DebugHealthIssue = {
      id: `${this.id}_${id}_${Date.now()}`,
      severity,
      type,
      description,
      timestamp: Date.now(),
      recommendedAction
    };

    this.issues.push(issue);

    // Keep only recent issues
    if (this.issues.length > 100) {
      this.issues = this.issues.slice(-100);
    }

    // Publish health issue event
    this.publishEvent(DebugSystemEvent.HEALTH_ISSUE_DETECTED, {
      adapterId: this.id,
      issue,
      timestamp: Date.now()
    });
  }

  /**
   * Handle adapter error
   */
  protected async handleAdapterError(
    operation: string,
    error: Error,
    context?: Record<string, any>
  ): Promise<void> {
    this.stats.totalErrors++;

    // Log to error registry
    await this.errorRegistry.handleError(
      error,
      `debug_adapter_${operation}`,
      this.id,
      {
        adapterId: this.id,
        operation,
        ...context
      }
    );

    // Add health issue
    this.addHealthIssue(
      `${operation}_error`,
      'high',
      'performance',
      `Error in ${operation}: ${error.message}`,
      'Check adapter logs and configuration'
    );

    // Publish error event
    this.publishEvent(DebugSystemEvent.SYSTEM_ERROR, {
      adapterId: this.id,
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
  protected publishEvent(
    eventType: DebugSystemEvent | string,
    data: any,
    position: 'start' | 'middle' | 'end' = 'middle'
  ): void {
    try {
      this.debugEventBus.publish({
        sessionId: `debug_${this.id}`,
        moduleId: this.id,
        operationId: eventType,
        timestamp: Date.now(),
        type: 'start',
        position,
        data: {
          adapterId: this.id,
          adapterType: this.type,
          ...data
        }
      });
    } catch (error) {
      console.warn(`Failed to publish debug event:`, error);
    }
  }

  /**
   * Measure execution time for a function
   */
  protected async measureExecutionTime<T>(
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await fn();
      const executionTime = Date.now() - startTime;

      // Update performance statistics
      this.updatePerformanceStats(executionTime);

      return result;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      await this.handleAdapterError(operation, error as Error, { executionTime });
      throw error;
    }
  }

  /**
   * Check if adapter is enabled
   */
  protected isEnabled(): boolean {
    return this.config.enabled !== false;
  }

  /**
   * Get adapter configuration
   */
  protected getAdapterConfig<T = Record<string, any>>(): T {
    return (this.config.config || {}) as T;
  }

  /**
   * Get active sessions
   */
  protected getActiveSessions(): DebugContext[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Check if session is active
   */
  protected isSessionActive(contextId: string): boolean {
    return this.sessions.has(contextId);
  }
}