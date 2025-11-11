/**
 * V1/V2 Comparison Engine
 * 
 * Core engine for executing V1 and V2 pipeline comparisons
 * with clean architecture and no circular dependencies.
 */

import { EventEmitter } from 'events';
import type { 
  TestScenario, 
  TestResult, 
  ComparisonResult, 
  PipelineExecutor, 
  LoadTestConfig 
} from './types.js';

/**
 * Comparison engine configuration
 */
export interface ComparisonEngineConfig {
  v1Executor: PipelineExecutor;
  v2Executor: PipelineExecutor;
  maxConcurrency?: number;
  timeoutMs?: number;
}

/**
 * V1/V2 Comparison Engine
 */
export class ComparisonEngine extends EventEmitter {
  private readonly config: ComparisonEngineConfig;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;

  constructor(config: ComparisonEngineConfig) {
    super();
    this.config = config;
    this.maxConcurrency = config.maxConcurrency || 5;
    this.timeoutMs = config.timeoutMs || 30000;
  }

  /**
   * Execute comparison for a single scenario
   */
  async executeScenarioComparison(scenario: TestScenario): Promise<ComparisonResult> {
    const scenarioId = `${scenario.id}-${Date.now()}`;
    const startTime = Date.now();
    
    this.emit('scenarioStart', { scenario, scenarioId });
    
    try {
      // Execute V1 and V2 in parallel
      const [v1Result, v2Result] = await Promise.all([
        this.executeWithExecutor(scenario, this.config.v1Executor, 'v1'),
        this.executeWithExecutor(scenario, this.config.v2Executor, 'v2')
      ]);
      
      const endTime = Date.now();
      
      const comparisonResult: ComparisonResult = {
        scenarioId,
        scenarioName: scenario.name,
        v1: {
          executor: this.config.v1Executor.name,
          results: [v1Result],
          totalTime: endTime - startTime,
          successCount: v1Result.success ? 1 : 0,
          errorCount: v1Result.success ? 0 : 1,
          averageLatency: v1Result.latency
        },
        v2: {
          executor: this.config.v2Executor.name,
          results: [v2Result],
          totalTime: endTime - startTime,
          successCount: v2Result.success ? 1 : 0,
          errorCount: v2Result.success ? 0 : 1,
          averageLatency: v2Result.latency
        },
        comparison: {
          consistency: this.calculateConsistency(v1Result, v2Result),
          performanceGain: this.calculatePerformanceGain(v1Result, v2Result),
          similarityScore: this.calculateSimilarity(v1Result, v2Result),
          latencyDifference: v2Result.latency - v1Result.latency
        }
      };
      
      this.emit('scenarioComplete', { scenarioId, result: comparisonResult });
      return comparisonResult;
      
    } catch (error) {
      const endTime = Date.now();
      const errorResult: ComparisonResult = {
        scenarioId,
        scenarioName: scenario.name,
        v1: {
          executor: this.config.v1Executor.name,
          results: [{ requestId: 'error', success: false, latency: 0, executionTime: 0, response: null, error: String(error) }],
          totalTime: endTime - startTime,
          successCount: 0,
          errorCount: 1,
          averageLatency: 0
        },
        v2: {
          executor: this.config.v2Executor.name,
          results: [{ requestId: 'error', success: false, latency: 0, executionTime: 0, response: null, error: String(error) }],
          totalTime: endTime - startTime,
          successCount: 0,
          errorCount: 1,
          averageLatency: 0
        },
        comparison: {
          consistency: 0,
          performanceGain: 0,
          similarityScore: 0,
          latencyDifference: 0
        }
      };
      
      this.emit('scenarioError', { scenarioId, error });
      return errorResult;
    }
  }

  /**
   * Execute batch comparison with concurrency control
   */
  async executeBatchComparison(
    scenarios: TestScenario[],
    config?: LoadTestConfig
  ): Promise<ComparisonResult[]> {
    const results: ComparisonResult[] = [];
    const concurrency = config?.concurrency || this.maxConcurrency;
    
    this.emit('batchStart', { scenarioCount: scenarios.length, concurrency });
    
    // Process scenarios in batches
    for (let i = 0; i < scenarios.length; i += concurrency) {
      const batch = scenarios.slice(i, i + concurrency);
      
      const batchResults = await Promise.all(
        batch.map(scenario => this.executeScenarioComparison(scenario))
      );
      
      results.push(...batchResults);
      
      this.emit('batchProgress', { 
        completed: results.length, 
        total: scenarios.length 
      });
    }
    
    this.emit('batchComplete', { totalResults: results.length });
    return results;
  }

  /**
   * Execute scenario with specific executor
   */
  private async executeWithExecutor(
    scenario: TestScenario, 
    executor: PipelineExecutor, 
    version: 'v1' | 'v2'
  ): Promise<TestResult> {
    const requestId = `${scenario.id}-${version}-${Date.now()}`;
    const startTime = Date.now();
    
    try {
      const response = await Promise.race([
        executor.processRequest(scenario.requests[0]),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), this.timeoutMs)
        )
      ]);
      
      const endTime = Date.now();
      
      return {
        requestId,
        success: true,
        latency: endTime - startTime,
        executionTime: endTime - startTime,
        response,
        metadata: {
          version,
          scenario: scenario.name,
          executor: executor.name
        }
      };
      
    } catch (error) {
      const endTime = Date.now();
      
      return {
        requestId,
        success: false,
        latency: endTime - startTime,
        executionTime: endTime - startTime,
        response: null,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          version,
          scenario: scenario.name,
          executor: executor.name
        }
      };
    }
  }

  /**
   * Calculate consistency between results
   */
  private calculateConsistency(v1Result: TestResult, v2Result: TestResult): number {
    if (!v1Result.success && !v2Result.success) return 1.0;
    if (v1Result.success !== v2Result.success) return 0.5;
    
    // Latency consistency (within 20% tolerance)
    const latencyDiff = Math.abs(v1Result.latency - v2Result.latency);
    const latencyTolerance = Math.max(v1Result.latency, v2Result.latency) * 0.2;
    
    if (latencyDiff > latencyTolerance) return 0.8;
    return 1.0;
  }

  /**
   * Calculate performance gain percentage
   */
  private calculatePerformanceGain(v1Result: TestResult, v2Result: TestResult): number {
    if (!v1Result.success || !v2Result.success) return 0;
    
    return ((v1Result.latency - v2Result.latency) / v1Result.latency) * 100;
  }

  /**
   * Calculate similarity score
   */
  private calculateSimilarity(v1Result: TestResult, v2Result: TestResult): number {
    if (!v1Result.success || !v2Result.success) return 0;
    
    // Basic content similarity
    const v1Content = JSON.stringify(v1Result.response);
    const v2Content = JSON.stringify(v2Result.response);
    
    if (v1Content === v2Content) return 1.0;
    
    // Simple similarity based on content length
    const similarity = 1 - Math.abs(v1Content.length - v2Content.length) / Math.max(v1Content.length, v2Content.length);
    return Math.max(0, similarity);
  }
}

/**
 * Factory function
 */
export function createComparisonEngine(config: ComparisonEngineConfig): ComparisonEngine {
  return new ComparisonEngine(config);
}
