/**
 * Hybrid Pipeline Manager
 * 
 * Unified pipeline manager that seamlessly routes requests between V1 and V2
 * architectures based on configuration and real-time health metrics.
 */

import type { PipelineRequest, PipelineResponse } from '../../../interfaces/pipeline-interfaces.js';
import type { PipelineManager } from '../../core/pipeline-manager.js';
import type { V2PipelineManager } from '../v2-pipeline-manager.js';
import type { 
  HybridPipelineConfig, 
  PipelineMode, 
  PipelineSelection,
  HybridPipelineMetrics,
  RoutingDecision
} from './hybrid-config-types.js';
import { TrafficSplitter } from './traffic-splitter.js';
import { PipelineDebugLogger } from '../../../utils/debug-logger.js';

/**
 * Hybrid Pipeline Manager
 * 
 * Provides a unified interface that can route requests to either V1 or V2
 * pipeline managers based on configuration, traffic splitting, and health metrics.
 */
export class HybridPipelineManager {
  private readonly logger: PipelineDebugLogger;
  private readonly config: HybridPipelineConfig;
  
  // Pipeline managers
  private v1Manager?: PipelineManager;
  private v2Manager?: V2PipelineManager;
  
  // Traffic management
  private trafficSplitter?: TrafficSplitter;
  
  // State tracking
  private isInitialized = false;
  private currentMode: PipelineMode = 'v1';
  private metrics: HybridPipelineMetrics;
  private migrationTimer?: NodeJS.Timeout;
  
  // Health tracking
  private healthHistory = {
    v1: { success: 0, errors: 0, totalLatency: 0, samples: 0 },
    v2: { success: 0, errors: 0, totalLatency: 0, samples: 0 }
  };

  constructor(
    config: HybridPipelineConfig,
    logger?: PipelineDebugLogger
  ) {
    this.config = config;
    this.logger = logger || new PipelineDebugLogger();
    this.currentMode = config.mode;
    
    this.metrics = this.initializeMetrics();
    
    this.logger.logModule('hybrid-pipeline-manager', 'created', {
      mode: config.mode,
      hasV2Config: !!config.v2Config,
      hasTrafficSplit: !!config.trafficSplit
    });
  }

  /**
   * Initialize the hybrid pipeline manager
   */
  async initialize(
    v1Manager: PipelineManager,
    v2Manager?: V2PipelineManager
  ): Promise<void> {
    if (this.isInitialized) {
      throw new Error('Hybrid Pipeline Manager already initialized');
    }

    this.logger.logModule('hybrid-pipeline-manager', 'initialization-start');

    try {
      // Store pipeline managers
      this.v1Manager = v1Manager;
      this.v2Manager = v2Manager;

      // Validate configuration consistency
      this.validateConfiguration();

      // Initialize traffic splitter for hybrid mode
      if (this.config.mode === 'hybrid' && this.config.trafficSplit) {
        this.trafficSplitter = new TrafficSplitter(
          this.config.trafficSplit,
          this.logger
        );
      }

      // Start progressive migration if enabled
      if (this.config.migration.enableProgressive) {
        this.startProgressiveMigration();
      }

      this.isInitialized = true;
      this.logger.logModule('hybrid-pipeline-manager', 'initialization-complete', {
        mode: this.currentMode,
        v2Enabled: !!this.v2Manager,
        trafficSplitEnabled: !!this.trafficSplitter
      });

    } catch (error) {
      this.logger.logModule('hybrid-pipeline-manager', 'initialization-error', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Process request through appropriate pipeline
   */
  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) {
      throw new Error('Hybrid Pipeline Manager not initialized');
    }

    const startTime = Date.now();
    const selection = this.selectPipeline(request);
    
    this.logger.logModule('hybrid-pipeline-manager', 'request-start', {
      requestId: request.route?.requestId,
      selectedMode: selection.mode,
      reason: selection.reason,
      confidence: selection.confidence
    });

    try {
      let response: PipelineResponse;
      const targetMode = selection.mode;

      // Route to appropriate pipeline
      if (targetMode === 'v2' && this.v2Manager) {
        response = await this.v2Manager.processRequest(request);
      } else if (targetMode === 'v1' && this.v1Manager) {
        response = await this.v1Manager.processRequest(request);
      } else {
        throw new Error(`Pipeline manager not available for mode: ${targetMode}`);
      }

      // Update metrics
      this.updateMetrics(targetMode, true, Date.now() - startTime);

      this.logger.logModule('hybrid-pipeline-manager', 'request-complete', {
        requestId: request.route?.requestId,
        mode: targetMode,
        duration: Date.now() - startTime
      });

      return response;

    } catch (error) {
      // Update error metrics
      this.updateMetrics(selection.mode, false, Date.now() - startTime);

      // Handle fallback if enabled
      if (this.config.fallback.enabled && this.shouldFallback(error)) {
        return this.handleFallback(request, selection, error);
      }

      this.logger.logModule('hybrid-pipeline-manager', 'request-error', {
        requestId: request.route?.requestId,
        mode: selection.mode,
        error: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  }

  /**
   * Select appropriate pipeline for request
   */
  private selectPipeline(request: PipelineRequest): PipelineSelection {
    switch (this.config.mode) {
      case 'v1':
        return { mode: 'v1', reason: 'configured-v1-mode', confidence: 1.0, metadata: {} };
      
      case 'v2':
        return { mode: 'v2', reason: 'configured-v2-mode', confidence: 1.0, metadata: {} };
      
      case 'hybrid':
        if (!this.trafficSplitter) {
          return { mode: 'v1', reason: 'fallback-no-traffic-splitter', confidence: 0.5, metadata: {} };
        }
        
        const decision = this.trafficSplitter.makeDecision(request);
        return {
          mode: decision.target,
          reason: decision.reason,
          confidence: decision.confidence,
          metadata: decision.requestMetadata
        };
      
      default:
        throw new Error(`Unknown pipeline mode: ${this.config.mode}`);
    }
  }

  /**
   * Validate configuration consistency
   */
  private validateConfiguration(): void {
    if (this.config.mode === 'v2' && !this.v2Manager) {
      throw new Error('V2 mode requires V2 pipeline manager');
    }
    
    if (this.config.mode === 'v2' && !this.config.v2Config) {
      throw new Error('V2 mode requires V2 configuration');
    }
    
    if (this.config.mode === 'hybrid' && !this.config.trafficSplit) {
      throw new Error('Hybrid mode requires traffic split configuration');
    }
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): HybridPipelineMetrics {
    return {
      totalRequests: 0,
      requestsByMode: { v1: 0, v2: 0, hybrid: 0 },
      successRates: { v1: 0, v2: 0, hybrid: 0 },
      averageLatency: { v1: 0, v2: 0, hybrid: 0 },
      errorRates: { v1: 0, v2: 0, hybrid: 0 },
      currentSplit: { v1Percentage: 100, v2Percentage: 0 },
      healthStatus: { v1: 'healthy', v2: 'healthy', hybrid: 'healthy' },
      migrationProgress: 0
    };
  }

  /**
   * Update metrics after request completion
   */
  private updateMetrics(mode: PipelineMode, success: boolean, latency: number): void {
    this.metrics.totalRequests++;
    this.metrics.requestsByMode[mode]++;
    
    const health = this.healthHistory[mode];
    if (success) {
      health.success++;
    } else {
      health.errors++;
    }
    health.totalLatency += latency;
    health.samples++;
    
    // Update rates
    const totalSamples = health.samples;
    this.metrics.successRates[mode] = totalSamples > 0 ? health.success / totalSamples : 0;
    this.metrics.errorRates[mode] = totalSamples > 0 ? health.errors / totalSamples : 0;
    this.metrics.averageLatency[mode] = totalSamples > 0 ? health.totalLatency / totalSamples : 0;
    
    // Update health status
    this.updateHealthStatus(mode);
    
    // Update current split for hybrid mode
    if (this.config.mode === 'hybrid' && this.config.trafficSplit) {
      this.metrics.currentSplit.v2Percentage = this.config.trafficSplit.v2Percentage;
      this.metrics.currentSplit.v1Percentage = 100 - this.config.trafficSplit.v2Percentage;
    }
  }

  /**
   * Update health status based on metrics
   */
  private updateHealthStatus(mode: PipelineMode): void {
    const health = this.healthHistory[mode];
    const config = this.config.healthCheck;
    
    if (health.samples < config.minSamples) {
      this.metrics.healthStatus[mode] = 'healthy';
      return;
    }
    
    const errorRate = this.metrics.errorRates[mode];
    const avgLatency = this.metrics.averageLatency[mode];
    
    if (errorRate > config.errorRateThreshold || avgLatency > config.latencyThresholdMs) {
      this.metrics.healthStatus[mode] = 'unhealthy';
    } else if (errorRate > config.errorRateThreshold * 0.5 || avgLatency > config.latencyThresholdMs * 0.7) {
      this.metrics.healthStatus[mode] = 'degraded';
    } else {
      this.metrics.healthStatus[mode] = 'healthy';
    }
  }

  /**
   * Start progressive migration
   */
  private startProgressiveMigration(): void {
    const schedule = this.config.migration.schedule;
    const intervalMs = schedule.updateIntervalMinutes * 60 * 1000;
    const totalSteps = schedule.durationHours * 60 / schedule.updateIntervalMinutes;
    const stepSize = (schedule.targetPercentage - schedule.startPercentage) / totalSteps;
    
    let currentPercentage = schedule.startPercentage;
    let currentStep = 0;
    
    this.migrationTimer = setInterval(() => {
      currentStep++;
      currentPercentage = Math.min(
        schedule.startPercentage + (stepSize * currentStep),
        schedule.targetPercentage
      );
      
      if (this.trafficSplitter && this.config.trafficSplit) {
        this.trafficSplitter.updateStrategy({ v2Percentage: currentPercentage });
        this.config.trafficSplit.v2Percentage = currentPercentage;
      }
      
      this.metrics.migrationProgress = currentStep / totalSteps;
      
      this.logger.logModule('hybrid-pipeline-manager', 'migration-step', {
        step: currentStep,
        totalSteps,
        currentPercentage,
        progress: this.metrics.migrationProgress
      });
      
      if (currentPercentage >= schedule.targetPercentage) {
        clearInterval(this.migrationTimer);
        this.migrationTimer = undefined;
      }
    }, intervalMs);
  }

  /**
   * Check if error should trigger fallback
   */
  private shouldFallback(error: unknown): boolean {
    const errorTypes = this.config.fallback.errorTypes;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return errorTypes.some(type => errorMessage.includes(type));
  }

  /**
   * Handle fallback to V1
   */
  private async handleFallback(
    request: PipelineRequest,
    originalSelection: PipelineSelection,
    originalError: unknown
  ): Promise<PipelineResponse> {
    if (!this.v1Manager) {
      throw originalError;
    }
    
    this.logger.logModule('hybrid-pipeline-manager', 'fallback-triggered', {
      requestId: request.route?.requestId,
      fromMode: originalSelection.mode,
      toMode: 'v1',
      error: originalError instanceof Error ? originalError.message : String(originalError)
    });
    
    const startTime = Date.now();
    try {
      const response = await this.v1Manager.processRequest(request);
      this.updateMetrics('v1', true, Date.now() - startTime);
      return response;
    } catch (fallbackError) {
      this.updateMetrics('v1', false, Date.now() - startTime);
      throw fallbackError;
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): HybridPipelineMetrics {
    return { ...this.metrics };
  }

  /**
   * Get current configuration
   */
  getConfig(): HybridPipelineConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<HybridPipelineConfig>): void {
    Object.assign(this.config, newConfig);
    
    if (newConfig.trafficSplit && this.trafficSplitter) {
      this.trafficSplitter.updateStrategy(newConfig.trafficSplit);
    }
    
    this.logger.logModule('hybrid-pipeline-manager', 'config-updated', {
      newConfigKeys: Object.keys(newConfig)
    });
  }

  /**
   * Get pipeline IDs (V1 compatibility)
   */
  getPipelineIds(): string[] {
    return this.v1Manager?.getPipelineIds() || [];
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.migrationTimer) {
      clearInterval(this.migrationTimer);
      this.migrationTimer = undefined;
    }
    
    if (this.trafficSplitter) {
      this.trafficSplitter.cleanup();
    }
    
    this.isInitialized = false;
    this.logger.logModule('hybrid-pipeline-manager', 'cleanup-complete');
  }
}
