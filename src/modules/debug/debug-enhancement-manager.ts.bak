/**
 * RouteCodex Debug Enhancement Manager
 *
 * Centralized debug enhancement management to eliminate code duplication
 * across pipeline modules and provide unified debugging capabilities.
 */

import { DebugEventBus } from 'rcc-debugcenter';
import { ModuleEnhancementFactory } from '../enhancement/module-enhancement-factory.js';
import type { DebugCenter } from '../pipeline/types/external-types.js';
import type { EnhancementConfig } from '../enhancement/module-enhancement-factory.js';

/**
 * Debug enhancement configuration
 */
export interface DebugEnhancementConfig {
  /** Enable debug enhancements */
  enabled?: boolean;
  /** Debug level */
  level?: 'basic' | 'detailed' | 'verbose';
  /** Enable console logging */
  consoleLogging?: boolean;
  /** Enable debug center integration */
  debugCenter?: boolean;
  /** Enable performance tracking */
  performanceTracking?: boolean;
  /** Enable request logging */
  requestLogging?: boolean;
  /** Enable error tracking */
  errorTracking?: boolean;
  /** Enable transformation logging */
  transformationLogging?: boolean;
  /** Maximum history size */
  maxHistorySize?: number;
}

/**
 * Debug enhancement instance
 */
export interface DebugEnhancement {
  /** Enhancement ID */
  id: string;
  /** Configuration */
  config: DebugEnhancementConfig;
  /** Enhancement factory */
  factory: ModuleEnhancementFactory;
  /** Event bus */
  eventBus: DebugEventBus;
  /** Metrics collection */
  metrics: Map<string, any>;
  /** Request history */
  requestHistory: any[];
  /** Error history */
  errorHistory: any[];
  /** Enhancement is active */
  isActive: boolean;
  /** Record metric */
  recordMetric(operationId: string, value: number, tags?: Record<string, string>): void;
  /** Add request to history */
  addRequestToHistory(request: any): void;
  /** Add error to history */
  addErrorToHistory(error: any): void;
  /** Get metrics statistics */
  getMetricsStats(): Map<string, any>;
  /** Get request history */
  getRequestHistory(): any[];
  /** Get error history */
  getErrorHistory(): any[];
}

/**
 * Centralized Debug Enhancement Manager
 *
 * Provides unified debug enhancement capabilities across all modules,
 * eliminating code duplication and ensuring consistent behavior.
 */
export class DebugEnhancementManager {
  private static instance: DebugEnhancementManager;
  private enhancements: Map<string, DebugEnhancement> = new Map();
  private debugCenter: DebugCenter;
  private globalEventBus: DebugEventBus;
  private globalFactory: ModuleEnhancementFactory;
  private isInitialized = false;

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor(debugCenter: DebugCenter) {
    this.debugCenter = debugCenter;
    this.globalEventBus = DebugEventBus.getInstance();
    this.globalFactory = new ModuleEnhancementFactory(debugCenter);
  }

  /**
   * Get singleton instance
   */
  static getInstance(debugCenter?: DebugCenter): DebugEnhancementManager {
    if (!DebugEnhancementManager.instance) {
      if (!debugCenter) {
        throw new Error('DebugCenter required for first initialization');
      }
      DebugEnhancementManager.instance = new DebugEnhancementManager(debugCenter);
    }
    return DebugEnhancementManager.instance;
  }

  /**
   * Initialize the debug enhancement manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize global factory - no initialize method available
      // await this.globalFactory.initialize();

      this.isInitialized = true;
      this.log('info', 'DebugEnhancementManager initialized successfully');
    } catch (error) {
      this.log('error', 'Failed to initialize DebugEnhancementManager', error);
      throw error;
    }
  }

  /**
   * Register or get debug enhancement for a component
   */
  registerEnhancement(id: string, config: DebugEnhancementConfig = {}): DebugEnhancement {
    // Return existing enhancement if already registered
    if (this.enhancements.has(id)) {
      return this.enhancements.get(id)!;
    }

    // Create new enhancement
    const enhancement = this.createEnhancement(id, config);
    this.enhancements.set(id, enhancement);

    this.log('info', `Registered debug enhancement for ${id}`);
    return enhancement;
  }

  /**
   * Get existing debug enhancement
   */
  getEnhancement(id: string): DebugEnhancement | null {
    return this.enhancements.get(id) || null;
  }

  /**
   * Remove debug enhancement
   */
  removeEnhancement(id: string): boolean {
    const removed = this.enhancements.delete(id);
    if (removed) {
      this.log('info', `Removed debug enhancement for ${id}`);
    }
    return removed;
  }

  /**
   * Get all registered enhancements
   */
  getAllEnhancements(): Map<string, DebugEnhancement> {
    return new Map(this.enhancements);
  }

  /**
   * Get global metrics across all enhancements
   */
  getGlobalMetrics(): Map<string, any> {
    const globalMetrics = new Map<string, any>();

    for (const [id, enhancement] of this.enhancements) {
      const enhancementMetrics = enhancement.getMetricsStats();
      for (const [metricId, stats] of enhancementMetrics) {
        const globalMetricId = `${id}.${metricId}`;
        globalMetrics.set(globalMetricId, {
          ...stats,
          componentId: id
        });
      }
    }

    return globalMetrics;
  }

  /**
   * Get system-wide debug status
   */
  getSystemDebugStatus(): any {
    const enhancements: any = {};

    for (const [id, enhancement] of this.enhancements) {
      enhancements[id] = {
        id: enhancement.id,
        isActive: enhancement.isActive,
        metricsCount: enhancement.metrics.size,
        requestHistoryCount: enhancement.requestHistory.length,
        errorHistoryCount: enhancement.errorHistory.length,
        config: enhancement.config
      };
    }

    return {
      managerId: 'DebugEnhancementManager',
      version: '1.0.0',
      isInitialized: this.isInitialized,
      enhancementCount: this.enhancements.size,
      globalMetricsCount: this.getGlobalMetrics().size,
      enhancements,
      timestamp: Date.now()
    };
  }

  /**
   * Reset all enhancements
   */
  resetAll(): void {
    for (const enhancement of this.enhancements.values()) {
      enhancement.metrics.clear();
      enhancement.requestHistory.length = 0;
      enhancement.errorHistory.length = 0;
    }
    this.log('info', 'Reset all debug enhancements');
  }

  /**
   * Create a new debug enhancement instance
   */
  private createEnhancement(id: string, config: DebugEnhancementConfig): DebugEnhancement {
    const metrics = new Map<string, any>();
    const requestHistory: any[] = [];
    const errorHistory: any[] = [];
    const maxHistorySize = config.maxHistorySize || 100;

    // Create component-specific factory
    const factory = new ModuleEnhancementFactory(this.debugCenter);

    // Register configuration with factory
    const debugConfig: EnhancementConfig = {
      enabled: config.enabled ?? true,
      level: config.level === 'basic' ? 'basic' : config.level === 'verbose' ? 'verbose' : 'detailed',
      consoleLogging: config.consoleLogging ?? true,
      debugCenter: config.debugCenter ?? true,
      performanceTracking: config.performanceTracking ?? true,
      requestLogging: config.requestLogging ?? true,
      errorTracking: config.errorTracking ?? true,
      transformationLogging: config.transformationLogging ?? true
    };

    factory.registerConfig(id, debugConfig);

    const enhancement: DebugEnhancement = {
      id,
      config,
      factory,
      eventBus: this.globalEventBus,
      metrics,
      requestHistory,
      errorHistory,
      isActive: true,

      recordMetric: (operationId: string, value: number, tags?: Record<string, string>) => {
        if (!metrics.has(operationId)) {
          metrics.set(operationId, {
            values: [],
            lastUpdated: Date.now(),
            tags: tags || {},
            count: 0,
            sum: 0,
            min: Infinity,
            max: -Infinity
          });
        }

        const metric = metrics.get(operationId)!;
        metric.values.push(value);
        metric.count++;
        metric.sum += value;
        metric.min = Math.min(metric.min, value);
        metric.max = Math.max(metric.max, value);
        metric.lastUpdated = Date.now();

        // Keep only last 50 values
        if (metric.values.length > 50) {
          metric.values.shift();
        }

        // Publish debug event
        this.globalEventBus.publish({
          sessionId: `session_${Date.now()}`,
          moduleId: id,
          operationId: `metric_${operationId}`,
          timestamp: Date.now(),
          type: 'start',
          position: 'middle',
          data: {
            operationId,
            value,
            tags,
            count: metric.count,
            average: metric.sum / metric.count
          }
        });
      },

      addRequestToHistory: (request: any) => {
        requestHistory.push({
          ...request,
          timestamp: Date.now(),
          componentId: id
        });

        // Keep only recent history
        if (requestHistory.length > maxHistorySize) {
          requestHistory.shift();
        }
      },

      addErrorToHistory: (error: any) => {
        errorHistory.push({
          ...error,
          timestamp: Date.now(),
          componentId: id
        });

        // Keep only recent history
        if (errorHistory.length > maxHistorySize) {
          errorHistory.shift();
        }

        // Publish error event
        this.globalEventBus.publish({
          sessionId: `session_${Date.now()}`,
          moduleId: id,
          operationId: 'error_occurred',
          timestamp: Date.now(),
          type: 'error',
          position: 'middle',
          data: {
            error: error.message || String(error),
            componentId: id,
            errorHistoryCount: errorHistory.length
          }
        });
      },

      getMetricsStats: (): Map<string, any> => {
        const stats = new Map<string, any>();

        for (const [metricId, metric] of metrics) {
          stats.set(metricId, {
            count: metric.count,
            sum: metric.sum,
            average: metric.count > 0 ? metric.sum / metric.count : 0,
            min: metric.min === Infinity ? 0 : metric.min,
            max: metric.max === -Infinity ? 0 : metric.max,
            lastUpdated: metric.lastUpdated,
            tags: metric.tags
          });
        }

        return stats;
      },

      getRequestHistory: (): any[] => {
        return [...requestHistory];
      },

      getErrorHistory: (): any[] => {
        return [...errorHistory];
      }
    };

    return enhancement;
  }

  /**
   * Internal logging method
   */
  private log(level: 'info' | 'warn' | 'error', message: string, error?: any): void {
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      component: 'DebugEnhancementManager',
      error: error ? error.message || String(error) : undefined
    };

    // Publish to debug event bus
    this.globalEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'DebugEnhancementManager',
      operationId: 'log_message',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: logEntry
    });

    // Console output for critical messages
    if (level === 'error' || process.env.NODE_ENV === 'development') {
      console.log(`[DebugEnhancementManager] ${level.toUpperCase()}: ${message}`, error || '');
    }
  }

  /**
   * Destroy the debug enhancement manager
   */
  async destroy(): Promise<void> {
    try {
      // Clear all enhancements
      this.enhancements.clear();

      // Reset instance
      DebugEnhancementManager.instance = (null as any);
      this.isInitialized = false;

      this.log('info', 'DebugEnhancementManager destroyed successfully');
    } catch (error) {
      this.log('error', 'Failed to destroy DebugEnhancementManager', error);
      throw error;
    }
  }
}