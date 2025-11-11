/**
 * Performance Analyzer for V1/V2 Comparison
 * 
 * Analyzes performance metrics and identifies bottlenecks
 * with clean architecture and comprehensive reporting.
 */

import type { 
  ComparisonResult, 
  PerformanceMetrics, 
  LatencyDistribution, 
  PerformanceAnalysis 
} from './types.js';

/**
 * Performance analyzer configuration
 */
export interface PerformanceAnalyzerConfig {
  latencyThresholds?: {
    maxAverageLatency?: number;
    maxP95Latency?: number;
    maxP99Latency?: number;
  };
  throughputThresholds?: {
    minQPS?: number;
  };
  regressionThresholds?: {
    maxPerformanceLoss?: number; // percentage
    minConsistency?: number;
  };
}

/**
 * Performance Analyzer
 */
export class PerformanceAnalyzer {
  private readonly config: PerformanceAnalyzerConfig;
  
  constructor(config: PerformanceAnalyzerConfig = {}) {
    this.config = {
      latencyThresholds: {
        maxAverageLatency: 1000,
        maxP95Latency: 2000,
        maxP99Latency: 5000,
        ...config.latencyThresholds
      },
      throughputThresholds: {
        minQPS: 10,
        ...config.throughputThresholds
      },
      regressionThresholds: {
        maxPerformanceLoss: 20, // 20% max loss
        minConsistency: 0.8,
        ...config.regressionThresholds
      }
    };
  }

  /**
   * Analyze comparison results and generate performance analysis
   */
  analyzeComparisonResults(results: ComparisonResult[]): PerformanceAnalysis {
    if (results.length === 0) {
      return this.createEmptyAnalysis();
    }
    
    const performanceMetrics = this.calculatePerformanceMetrics(results);
    const latencyDistribution = this.calculateLatencyDistribution(results);
    const bottlenecks = this.identifyBottlenecks(results, performanceMetrics);
    const recommendations = this.generateRecommendations(performanceMetrics, bottlenecks);
    
    return {
      summary: {
        totalScenarios: results.length,
        v1AverageLatency: performanceMetrics.v1.averageLatency,
        v2AverageLatency: performanceMetrics.v2.averageLatency,
        performanceGain: performanceMetrics.overallPerformanceGain,
        consistency: this.calculateOverallConsistency(results)
      },
      metrics: performanceMetrics,
      distribution: latencyDistribution,
      bottlenecks,
      recommendations,
      executionTime: Date.now()
    };
  }

  /**
   * Calculate performance metrics
   */
  private calculatePerformanceMetrics(results: ComparisonResult[]): {
    const v1Latencies = results.flatMap(r => r.v1.results.map(res => res.latency));
    const v2Latencies = results.flatMap(r => r.v2.results.map(res => res.latency));
    
    const v1Metrics = this.calculateMetricsForLatencies(v1Latencies);
    const v2Metrics = this.calculateMetricsForLatencies(v2Latencies);
    
    const overallPerformanceGain = this.calculateOverallPerformanceGain(v1Metrics, v2Metrics);
    
    return {
      v1: v1Metrics,
      v2: v2Metrics,
      overallPerformanceGain
    };
  }

  /**
   * Calculate metrics for latency array
   */
  private calculateMetricsForLatencies(latencies: number[]): PerformanceMetrics {
    if (latencies.length === 0) {
      return {
        averageLatency: 0,
        medianLatency: 0,
        p95Latency: 0,
        p99Latency: 0,
        minLatency: 0,
        maxLatency: 0,
        throughputQPS: 0,
        successRate: 0
      };
    }
    
    const sorted = [...latencies].sort((a, b) => a - b);
    const total = latencies.length;
    const successCount = latencies.filter(l => l > 0).length; // Assume positive = success
    
    return {
      averageLatency: latencies.reduce((sum, lat) => sum + lat, 0) / total,
      medianLatency: sorted[Math.floor(total / 2)],
      p95Latency: sorted[Math.floor(total * 0.95)],
      p99Latency: sorted[Math.floor(total * 0.99)],
      minLatency: sorted[0],
      maxLatency: sorted[total - 1],
      throughputQPS: total / (Math.max(...latencies) / 1000), // Rough QPS estimate
      successRate: successCount / total
    };
  }

  /**
   * Calculate overall performance gain
   */
  private calculateOverallPerformanceGain(v1Metrics: PerformanceMetrics, v2Metrics: PerformanceMetrics): number {
    if (v1Metrics.averageLatency === 0) return 0;
    return ((v1Metrics.averageLatency - v2Metrics.averageLatency) / v1Metrics.averageLatency) * 100;
  }

  /**
   * Calculate latency distribution
   */
  private calculateLatencyDistribution(results: ComparisonResult[]): LatencyDistribution {
    const v1Latencies = results.flatMap(r => r.v1.results.map(res => res.latency));
    const v2Latencies = results.flatMap(r => r.v2.results.map(res => res.latency));
    
    const allLatencies = [...v1Latencies, ...v2Latencies];
    const minLatency = Math.min(...allLatencies);
    const maxLatency = Math.max(...allLatencies);
    
    // Create 10 buckets from min to max
    const bucketCount = 10;
    const bucketSize = (maxLatency - minLatency) / bucketCount;
    const buckets = Array.from({ length: bucketCount + 1 }, (_, i) => minLatency + (i * bucketSize));
    
    const v1Distribution = buckets.map(bucket => 
      v1Latencies.filter(lat => lat <= bucket).length
    );
    
    const v2Distribution = buckets.map(bucket => 
      v2Latencies.filter(lat => lat <= bucket).length
    );
    
    return {
      buckets,
      v1Distribution,
      v2Distribution
    };
  }

  /**
   * Identify performance bottlenecks
   */
  private identifyBottlenecks(results: ComparisonResult[], metrics: any): Array<{
    type: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
    affectedScenarios: string[];
    details: any;
  }> {
    const bottlenecks = [];
    
    // High latency bottlenecks
    if (metrics.v2.averageLatency > this.config.latencyThresholds!.maxAverageLatency!) {
      bottlenecks.push({
        type: 'high_latency',
        severity: 'high',
        description: `V2 average latency ${metrics.v2.averageLatency.toFixed(2)}ms exceeds threshold`,
        affectedScenarios: results.filter(r => r.v2.averageLatency > this.config.latencyThresholds!.maxAverageLatency!).map(r => r.scenarioId),
        details: { threshold: this.config.latencyThresholds!.maxAverageLatency }
      });
    }
    
    // Performance regression
    if (metrics.overallPerformanceGain < -this.config.regressionThresholds!.maxPerformanceLoss!) {
      bottlenecks.push({
        type: 'performance_regression',
        severity: 'high',
        description: `Performance loss of ${Math.abs(metrics.overallPerformanceGain).toFixed(1)}% detected`,
        affectedScenarios: results.map(r => r.scenarioId),
        details: { performanceGain: metrics.overallPerformanceGain }
      });
    }
    
    // Low consistency
    const overallConsistency = this.calculateOverallConsistency(results);
    if (overallConsistency < this.config.regressionThresholds!.minConsistency!) {
      bottlenecks.push({
        type: 'low_consistency',
        severity: 'medium',
        description: `Response consistency ${(overallConsistency * 100).toFixed(1)}% below threshold`,
        affectedScenarios: results.filter(r => r.comparison.consistency < 0.9).map(r => r.scenarioId),
        details: { consistency: overallConsistency }
      });
    }
    
    return bottlenecks;
  }

  /**
   * Generate performance recommendations
   */
  private generateRecommendations(metrics: any, bottlenecks: any[]): string[] {
    const recommendations = [];
    
    // Performance recommendations
    if (metrics.overallPerformanceGain < 0) {
      recommendations.push('V2 shows performance degradation. Consider optimizing critical paths.');
    }
    
    if (bottlenecks.some(b => b.type === 'high_latency')) {
      recommendations.push('High latency detected. Investigate V2 pipeline bottlenecks.');
    }
    
    if (bottlenecks.some(b => b.type === 'low_consistency')) {
      recommendations.push('Response consistency issues detected. Review V2 compatibility layer.');
    }
    
    if (metrics.v2.successRate < metrics.v1.successRate * 0.9) {
      recommendations.push('V2 error rate higher than V1. Review error handling.');
    }
    
    return recommendations;
  }

  /**
   * Calculate overall consistency
   */
  private calculateOverallConsistency(results: ComparisonResult[]): number {
    if (results.length === 0) return 0;
    
    const totalConsistency = results.reduce((sum, r) => sum + r.comparison.consistency, 0);
    return totalConsistency / results.length;
  }

  /**
   * Create empty analysis
   */
  private createEmptyAnalysis(): PerformanceAnalysis {
    return {
      summary: {
        totalScenarios: 0,
        v1AverageLatency: 0,
        v2AverageLatency: 0,
        performanceGain: 0,
        consistency: 0
      },
      metrics: {
        v1: this.calculateMetricsForLatencies([]),
        v2: this.calculateMetricsForLatencies([]),
        overallPerformanceGain: 0
      },
      distribution: {
        buckets: [],
        v1Distribution: [],
        v2Distribution: []
      },
      bottlenecks: [],
      recommendations: ['No test results available for analysis'],
      executionTime: Date.now()
    };
  }
}

/**
 * Factory function
 */
export function createPerformanceAnalyzer(config?: PerformanceAnalyzerConfig): PerformanceAnalyzer {
  return new PerformanceAnalyzer(config);
}
