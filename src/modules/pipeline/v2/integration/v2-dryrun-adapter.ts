/**
 * V2 Dry Run Adapter
 *
 * Integration adapter for V2 parallel dry run functionality.
 * Plugs into existing pipeline managers without disrupting V1 flow.
 */

import type { V2SystemConfig, PipelineRequest, PipelineResponse } from '../types/v2-types.js';
import type { ParallelRunResult } from '../core/v2-parallel-runner.js';
import type { V2PipelineManager } from '../core/v2-pipeline-manager.js';
import type { V2ParallelRunner, ParallelRunConfig, ParallelRunMetrics } from '../core/v2-parallel-runner.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Adapter Configuration
 */
export interface V2DryRunAdapterConfig {
  enabled: boolean;
  autoStart: boolean;
  v2Config: V2SystemConfig;
  parallelConfig: Partial<ParallelRunConfig>;
  healthCheckInterval: number;
  metricsReportingInterval: number;
  failureThreshold: number; // Percentage of V2 failures before disabling
}

/**
 * Adapter Status
 */
export interface AdapterStatus {
  enabled: boolean;
  running: boolean;
  v2ManagerInitialized: boolean;
  parallelRunnerActive: boolean;
  healthStatus: 'healthy' | 'degraded' | 'disabled';
  lastHealthCheck: number;
  totalRequests: number;
  sampledRequests: number;
  currentFailureRate: number;
}

/**
 * V2 Dry Run Adapter
 *
 * Provides seamless integration of V2 dry run into existing pipeline.
 * Monitors health and automatically manages V2 runner lifecycle.
 */
export class V2DryRunAdapter {
  private readonly logger: PipelineDebugLogger;
  private readonly config: V2DryRunAdapterConfig;

  // Core components
  private v2Manager?: V2PipelineManager;
  private parallelRunner?: V2ParallelRunner;

  // State management
  private status: AdapterStatus;
  private healthCheckTimer?: NodeJS.Timeout;
  private metricsReportingTimer?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(config: V2DryRunAdapterConfig, logger?: PipelineDebugLogger) {
    this.config = config;
    this.logger = logger || new PipelineDebugLogger();

    this.status = {
      enabled: config.enabled,
      running: false,
      v2ManagerInitialized: false,
      parallelRunnerActive: false,
      healthStatus: 'healthy',
      lastHealthCheck: Date.now(),
      totalRequests: 0,
      sampledRequests: 0,
      currentFailureRate: 0
    };

    this.logger.logModule('v2-dryrun-adapter', 'initialized', {
      enabled: config.enabled,
      autoStart: config.autoStart
    });
  }

  /**
   * Initialize adapter
   */
  async initialize(): Promise<void> {
    if (this.status.v2ManagerInitialized) {
      return;
    }

    this.logger.logModule('v2-dryrun-adapter', 'initialization-start');

    try {
      // Initialize V2 Pipeline Manager
      const { V2PipelineManager } = await import('../core/v2-pipeline-manager.js');
      this.v2Manager = new V2PipelineManager(this.logger);
      await this.v2Manager.initialize(this.config.v2Config);

      // Initialize Parallel Runner
      const { V2ParallelRunner } = await import('../core/v2-parallel-runner.js');
      this.parallelRunner = new V2ParallelRunner(
        this.v2Manager,
        this.config.parallelConfig,
        this.logger
      );

      this.status.v2ManagerInitialized = true;

      // Auto-start if configured
      if (this.config.autoStart && this.config.enabled) {
        await this.start();
      }

      this.logger.logModule('v2-dryrun-adapter', 'initialization-complete');

    } catch (error) {
      this.logger.logModule('v2-dryrun-adapter', 'initialization-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.status.healthStatus = 'disabled';
      throw error;
    }
  }

  /**
   * Start adapter
   */
  async start(): Promise<void> {
    if (!this.status.enabled || this.status.running) {
      return;
    }

    if (!this.status.v2ManagerInitialized) {
      await this.initialize();
    }

    this.logger.logModule('v2-dryrun-adapter', 'start');

    try {
      // Start parallel runner
      if (this.parallelRunner) {
        this.parallelRunner.start();
        this.status.parallelRunnerActive = true;
      }

      // Start health monitoring
      this.startHealthMonitoring();

      // Start metrics reporting
      this.startMetricsReporting();

      this.status.running = true;
      this.status.healthStatus = 'healthy';

      this.logger.logModule('v2-dryrun-adapter', 'start-complete');

    } catch (error) {
      this.logger.logModule('v2-dryrun-adapter', 'start-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Stop adapter
   */
  async stop(): Promise<void> {
    if (!this.status.running) {
      return;
    }

    this.logger.logModule('v2-dryrun-adapter', 'stop-start');
    this.isShuttingDown = true;

    try {
      // Stop parallel runner
      if (this.parallelRunner) {
        await this.parallelRunner.stop();
        this.status.parallelRunnerActive = false;
      }

      // Stop monitoring timers
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = undefined;
      }

      if (this.metricsReportingTimer) {
        clearInterval(this.metricsReportingTimer);
        this.metricsReportingTimer = undefined;
      }

      this.status.running = false;

      this.logger.logModule('v2-dryrun-adapter', 'stop-complete');

    } catch (error) {
      this.logger.logModule('v2-dryrun-adapter', 'stop-error', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * Process request through adapter (main integration point)
   */
  processRequest(
    requestId: string,
    request: PipelineRequest,
    v1Response: PipelineResponse | null,
    v1Error: Error | null,
    v1Duration: number = 0
  ): void {
    if (!this.status.running || !this.parallelRunner) {
      return;
    }

    this.status.totalRequests++;

    try {
      // Delegate to parallel runner
      this.parallelRunner.processParallel(
        requestId,
        request,
        v1Response,
        v1Error,
        v1Duration
      );

      // Update sampled count estimate
      if (Math.random() < (this.config.parallelConfig.sampleRate || 0.1)) {
        this.status.sampledRequests++;
      }

    } catch (error) {
      this.logger.logModule('v2-dryrun-adapter', 'process-error', {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get adapter status
   */
  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  /**
   * Get detailed metrics
   */
  getMetrics(): {
    adapter: AdapterStatus;
    parallel?: ParallelRunMetrics;
    performance?: ReturnType<V2ParallelRunner['getPerformanceComparison']>;
  } {
    const result: {
      adapter: AdapterStatus;
      parallel?: ParallelRunMetrics;
      performance?: ReturnType<V2ParallelRunner['getPerformanceComparison']>;
    } = {
      adapter: this.getStatus()
    };

    if (this.parallelRunner) {
      result.parallel = this.parallelRunner.getMetrics();
      result.performance = this.parallelRunner.getPerformanceComparison();
    }

    return result;
  }

  /**
   * Get recent run results
   */
  getRecentRuns(limit: number = 50): ParallelRunResult[] {
    if (!this.parallelRunner) {
      return [];
    }

    return this.parallelRunner.getRunHistory(limit);
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<V2DryRunAdapterConfig>): Promise<void> {
    const oldEnabled = this.config.enabled;
    const oldParallelConfig = { ...this.config.parallelConfig };

    // Update config
    Object.assign(this.config, newConfig);
    this.status.enabled = this.config.enabled;

    this.logger.logModule('v2-dryrun-adapter', 'config-updated', {
      oldEnabled,
      newEnabled: this.config.enabled,
      changes: Object.keys(newConfig)
    });

    // Handle enable/disable changes
    if (oldEnabled !== this.config.enabled) {
      if (this.config.enabled && !this.status.running) {
        return this.start();
      } else if (!this.config.enabled && this.status.running) {
        return this.stop();
      }
    }

    // Update parallel runner config
    if (this.parallelRunner && JSON.stringify(oldParallelConfig) !== JSON.stringify(this.config.parallelConfig)) {
      this.parallelRunner.updateConfig(this.config.parallelConfig);
    }

    return Promise.resolve();
  }

  /**
   * Force health check
   */
  async performHealthCheck(): Promise<void> {
    await this.checkHealth();
  }

  /**
   * Shutdown adapter
   */
  async shutdown(): Promise<void> {
    this.logger.logModule('v2-dryrun-adapter', 'shutdown-start');

    await this.stop();

    if (this.v2Manager) {
      await this.v2Manager.shutdown();
      this.v2Manager = undefined;
    }

    this.parallelRunner = undefined;
    this.status.v2ManagerInitialized = false;

    this.logger.logModule('v2-dryrun-adapter', 'shutdown-complete');
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      if (!this.isShuttingDown) {
        await this.checkHealth();
      }
    }, this.config.healthCheckInterval);
  }

  /**
   * Start metrics reporting
   */
  private startMetricsReporting(): void {
    if (this.metricsReportingTimer) {
      clearInterval(this.metricsReportingTimer);
    }

    this.metricsReportingTimer = setInterval(() => {
      if (!this.isShuttingDown && this.status.running) {
        this.reportMetrics();
      }
    }, this.config.metricsReportingInterval);
  }

  /**
   * Check system health
   */
  private async checkHealth(): Promise<void> {
    const previousStatus = this.status.healthStatus;

    try {
      if (!this.parallelRunner || !this.v2Manager) {
        this.status.healthStatus = 'disabled';
        return;
      }

      const metrics = this.parallelRunner.getMetrics();
      const recentRuns = this.parallelRunner.getRunHistory(20);

      // Calculate failure rate
      const failureRate = recentRuns.length > 0
        ? recentRuns.filter(run => !run.v2Success).length / recentRuns.length
        : 0;

      this.status.currentFailureRate = failureRate;

      // Update health status based on failure rate
      if (failureRate > this.config.failureThreshold) {
        this.status.healthStatus = 'degraded';

        // Consider disabling if failure rate is very high
        if (failureRate > this.config.failureThreshold * 2) {
          this.logger.logModule('v2-dryrun-adapter', 'auto-disable', {
            failureRate,
            threshold: this.config.failureThreshold
          });

          await this.updateConfig({ enabled: false });
        }
      } else {
        this.status.healthStatus = 'healthy';
      }

      this.status.lastHealthCheck = Date.now();

      // Log status changes
      if (previousStatus !== this.status.healthStatus) {
        this.logger.logModule('v2-dryrun-adapter', 'health-status-changed', {
          from: previousStatus,
          to: this.status.healthStatus,
          failureRate,
          sampledRequests: metrics.sampledRequests
        });
      }

    } catch (error) {
      this.status.healthStatus = 'degraded';
      this.logger.logModule('v2-dryrun-adapter', 'health-check-error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Report metrics
   */
  private reportMetrics(): void {
    if (!this.parallelRunner) {
      return;
    }

    const metrics = this.getMetrics();

    this.logger.logModule('v2-dryrun-adapter', 'metrics-report', {
      totalRequests: this.status.totalRequests,
      sampledRequests: this.status.sampledRequests,
      v1SuccessRate: metrics.parallel?.v1SuccessRate,
      v2SuccessRate: metrics.parallel?.v2SuccessRate,
      averageComparison: metrics.parallel?.averageComparison,
      healthStatus: this.status.healthStatus,
      performance: metrics.performance
    });
  }
}
