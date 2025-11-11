/**
 * Health Monitor for Hybrid Pipeline Manager
 * 
 * Monitors the health of V1 and V2 pipelines and provides recommendations
 * for mode switching and traffic distribution.
 */

import type { PipelineMode, HybridPipelineMetrics } from './hybrid-config-types.js';
import type { PipelineDebugLogger } from '../../../utils/debug-logger.js';

/**
 * Health metrics for a specific pipeline mode
 */
export interface HealthMetrics {
  successRate: number;
  errorRate: number;
  averageLatency: number;
  p95Latency: number;
  throughput: number;
  lastHealthCheck: number;
  samples: number;
}

/**
 * Health assessment result
 */
export interface HealthAssessment {
  mode: PipelineMode;
  status: 'healthy' | 'degraded' | 'unhealthy';
  metrics: HealthMetrics;
  issues: string[];
  recommendations: string[];
  confidence: number;
}

/**
 * Comparison between V1 and V2 health
 */
export interface HealthComparison {
  v1: HealthAssessment;
  v2: HealthAssessment;
  winner: 'v1' | 'v2' | 'tie';
  confidence: number;
  reasoning: string;
  suggestedAction: 'increase-v2' | 'decrease-v2' | 'maintain' | 'fallback-to-v1';
}

/**
 * Health Monitor
 */
export class HealthMonitor {
  private readonly logger: PipelineDebugLogger;
  private readonly config: {
    errorRateThreshold: number;
    latencyThresholdMs: number;
    minSamples: number;
    healthCheckIntervalMs: number;
  };
  
  private metricsHistory = {
    v1: [] as HealthMetrics[],
    v2: [] as HealthMetrics[]
  };
  
  private healthHistory = {
    v1: [] as HealthAssessment[],
    v2: [] as HealthAssessment[]
  };
  
  private maxHistorySize = 100;
  private monitoringTimer?: NodeJS.Timeout;
  
  constructor(
    config: Partial<typeof HealthMonitor.prototype.config> = {},
    logger?: PipelineDebugLogger
  ) {
    this.config = {
      errorRateThreshold: 0.05, // 5%
      latencyThresholdMs: 5000, // 5 seconds
      minSamples: 50,
      healthCheckIntervalMs: 60000, // 1 minute
      ...config
    };
    
    this.logger = logger || new PipelineDebugLogger();
  }

  /**
   * Start health monitoring
   */
  start(): void {
    if (this.monitoringTimer) {
      return;
    }
    
    this.monitoringTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);
    
    this.logger.logModule('health-monitor', 'started', {
      interval: this.config.healthCheckIntervalMs,
      thresholds: this.config
    });
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }
    
    this.logger.logModule('health-monitor', 'stopped');
  }

  /**
   * Update metrics from hybrid pipeline manager
   */
  updateMetrics(hybridMetrics: HybridPipelineMetrics): void {
    const timestamp = Date.now();
    
    // Update V1 metrics
    if (hybridMetrics.requestsByMode.v1 > 0) {
      const v1Metrics: HealthMetrics = {
        successRate: hybridMetrics.successRates.v1,
        errorRate: hybridMetrics.errorRates.v1,
        averageLatency: hybridMetrics.averageLatency.v1,
        p95Latency: hybridMetrics.averageLatency.v1 * 1.2, // Estimate P95
        throughput: hybridMetrics.requestsByMode.v1 / ((timestamp - (this.metricsHistory.v1[this.metricsHistory.v1.length - 1]?.lastHealthCheck || timestamp)) / 1000),
        lastHealthCheck: timestamp,
        samples: hybridMetrics.requestsByMode.v1
      };
      
      this.addMetrics('v1', v1Metrics);
    }
    
    // Update V2 metrics
    if (hybridMetrics.requestsByMode.v2 > 0) {
      const v2Metrics: HealthMetrics = {
        successRate: hybridMetrics.successRates.v2,
        errorRate: hybridMetrics.errorRates.v2,
        averageLatency: hybridMetrics.averageLatency.v2,
        p95Latency: hybridMetrics.averageLatency.v2 * 1.2, // Estimate P95
        throughput: hybridMetrics.requestsByMode.v2 / ((timestamp - (this.metricsHistory.v2[this.metricsHistory.v2.length - 1]?.lastHealthCheck || timestamp)) / 1000),
        lastHealthCheck: timestamp,
        samples: hybridMetrics.requestsByMode.v2
      };
      
      this.addMetrics('v2', v2Metrics);
    }
  }

  /**
   * Assess health of a specific mode
   */
  assessHealth(mode: PipelineMode): HealthAssessment {
    const metrics = this.metricsHistory[mode];
    const latestMetrics = metrics[metrics.length - 1];
    
    if (!latestMetrics || latestMetrics.samples < this.config.minSamples) {
      return {
        mode,
        status: 'healthy',
        metrics: latestMetrics || this.createEmptyMetrics(),
        issues: ['Insufficient data for assessment'],
        recommendations: ['Wait for more samples'],
        confidence: 0.1
      };
    }
    
    const issues: string[] = [];
    const recommendations: string[] = [];
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    let confidence = 0.8;
    
    // Check error rate
    if (latestMetrics.errorRate > this.config.errorRateThreshold) {
      status = 'unhealthy';
      issues.push(`High error rate: ${(latestMetrics.errorRate * 100).toFixed(2)}%`);
      recommendations.push('Investigate error causes');
      confidence = 0.9;
    } else if (latestMetrics.errorRate > this.config.errorRateThreshold * 0.5) {
      status = 'degraded';
      issues.push(`Elevated error rate: ${(latestMetrics.errorRate * 100).toFixed(2)}%`);
      recommendations.push('Monitor error trends');
    }
    
    // Check latency
    if (latestMetrics.averageLatency > this.config.latencyThresholdMs) {
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
      issues.push(`High latency: ${latestMetrics.averageLatency.toFixed(0)}ms`);
      recommendations.push('Optimize performance or increase resources');
      confidence = Math.max(confidence, 0.8);
    } else if (latestMetrics.averageLatency > this.config.latencyThresholdMs * 0.7) {
      if (status === 'healthy') status = 'degraded';
      issues.push(`Elevated latency: ${latestMetrics.averageLatency.toFixed(0)}ms`);
    }
    
    // Check success rate
    if (latestMetrics.successRate < 0.95) {
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
      issues.push(`Low success rate: ${(latestMetrics.successRate * 100).toFixed(2)}%`);
    }
    
    return {
      mode,
      status,
      metrics: latestMetrics,
      issues,
      recommendations,
      confidence
    };
  }

  /**
   * Compare V1 and V2 health
   */
  compareHealth(): HealthComparison {
    const v1Assessment = this.assessHealth('v1');
    const v2Assessment = this.assessHealth('v2');
    
    let winner: 'v1' | 'v2' | 'tie' = 'tie';
    let reasoning = 'Both systems have similar performance';
    let suggestedAction: 'increase-v2' | 'decrease-v2' | 'maintain' | 'fallback-to-v1' = 'maintain';
    
    // If both are unhealthy, V1 gets priority (known stable)
    if (v1Assessment.status === 'unhealthy' && v2Assessment.status === 'unhealthy') {
      winner = 'v1';
      reasoning = 'Both systems unhealthy, preferring stable V1';
      suggestedAction = 'fallback-to-v1';
    }
    // If V1 is unhealthy and V2 is healthy/degraded, prefer V2
    else if (v1Assessment.status === 'unhealthy' && v2Assessment.status !== 'unhealthy') {
      winner = 'v2';
      reasoning = 'V1 unhealthy, V2 performing better';
      suggestedAction = 'increase-v2';
    }
    // If V2 is unhealthy and V1 is healthy, prefer V1
    else if (v2Assessment.status === 'unhealthy' && v1Assessment.status !== 'unhealthy') {
      winner = 'v1';
      reasoning = 'V2 unhealthy, V1 stable';
      suggestedAction = 'decrease-v2';
    }
    // Both healthy/degraded, compare metrics
    else {
      const v1Score = this.calculateHealthScore(v1Assessment);
      const v2Score = this.calculateHealthScore(v2Assessment);
      
      if (v2Score > v1Score * 1.1) { // V2 significantly better
        winner = 'v2';
        reasoning = 'V2 shows better performance metrics';
        suggestedAction = 'increase-v2';
      } else if (v1Score > v2Score * 1.1) { // V1 significantly better
        winner = 'v1';
        reasoning = 'V1 shows better performance metrics';
        suggestedAction = 'decrease-v2';
      }
    }
    
    const confidence = Math.min(v1Assessment.confidence, v2Assessment.confidence);
    
    const comparison: HealthComparison = {
      v1: v1Assessment,
      v2: v2Assessment,
      winner,
      confidence,
      reasoning,
      suggestedAction
    };
    
    this.logger.logModule('health-monitor', 'comparison', {
      winner,
      confidence,
      suggestedAction,
      reasoning
    });
    
    return comparison;
  }

  /**
   * Get health history
   */
  getHealthHistory(): { v1: HealthAssessment[]; v2: HealthAssessment[] } {
    return {
      v1: [...this.healthHistory.v1],
      v2: [...this.healthHistory.v2]
    };
  }

  /**
   * Perform automatic health check
   */
  private performHealthCheck(): void {
    const v1Assessment = this.assessHealth('v1');
    const v2Assessment = this.assessHealth('v2');
    
    this.healthHistory.v1.push(v1Assessment);
    this.healthHistory.v2.push(v2Assessment);
    
    // Trim history if needed
    if (this.healthHistory.v1.length > this.maxHistorySize) {
      this.healthHistory.v1.shift();
    }
    if (this.healthHistory.v2.length > this.maxHistorySize) {
      this.healthHistory.v2.shift();
    }
    
    this.logger.logModule('health-monitor', 'health-check', {
      v1: { status: v1Assessment.status, confidence: v1Assessment.confidence },
      v2: { status: v2Assessment.status, confidence: v2Assessment.confidence }
    });
  }

  /**
   * Add metrics to history
   */
  private addMetrics(mode: 'v1' | 'v2', metrics: HealthMetrics): void {
    this.metricsHistory[mode].push(metrics);
    
    // Trim history if needed
    if (this.metricsHistory[mode].length > this.maxHistorySize) {
      this.metricsHistory[mode].shift();
    }
  }

  /**
   * Create empty metrics
   */
  private createEmptyMetrics(): HealthMetrics {
    return {
      successRate: 0,
      errorRate: 0,
      averageLatency: 0,
      p95Latency: 0,
      throughput: 0,
      lastHealthCheck: Date.now(),
      samples: 0
    };
  }

  /**
   * Calculate health score for comparison
   */
  private calculateHealthScore(assessment: HealthAssessment): number {
    const metrics = assessment.metrics;
    
    // Base score from success rate
    let score = metrics.successRate;
    
    // Penalty for error rate
    score -= metrics.errorRate * 2;
    
    // Penalty for high latency (normalized)
    const latencyPenalty = Math.min(metrics.averageLatency / this.config.latencyThresholdMs, 1) * 0.2;
    score -= latencyPenalty;
    
    // Bonus for high throughput
    const throughputBonus = Math.min(metrics.throughput / 100, 1) * 0.1;
    score += throughputBonus;
    
    // Ensure score is between 0 and 1
    return Math.max(0, Math.min(1, score));
  }
}
