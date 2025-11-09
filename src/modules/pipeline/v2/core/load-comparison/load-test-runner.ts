/**
 * Load Test Runner for Pipeline Comparison
 * 
 * Executes parallel load tests against V1 and V2 pipelines
 * and collects performance and correctness metrics.
 */

import type { PipelineManager } from '../../../core/pipeline-manager.js';
import type { V2PipelineManager } from '../v2-pipeline-manager.js';
import type { PipelineRequest, PipelineResponse } from '../../../interfaces/pipeline-interfaces.js';
import type { TestScenario, LoadTestConfig } from './test-scenarios.js';
import { getAdaptedTestScenarios } from "./test-scenario-builder.js";
import type { TestResult } from './result-comparator.js';
import { ResultComparator } from './result-comparator.js';
import { PerformanceAnalyzer } from './performance-analyzer.js';
import { PipelineDebugLogger } from '../../../utils/debug-logger.js';

/**
 * Load test execution result
 */
export interface LoadTestResult {
  testId: string;
  startTime: number;
  endTime: number;
  duration: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  v1Results: TestResult[];
  v2Results: TestResult[];
  comparison: {
    consistencyScore: number;
    performanceDifference: number;
    errorRateDifference: number;
    issues: string[];
  };
  performance: {
    v1AverageLatency: number;
    v2AverageLatency: number;
    v1Throughput: number;
    v2Throughput: number;
    v1P95Latency: number;
    v2P95Latency: number;
  };
}

/**
 * Load Test Runner
 */
export class LoadTestRunner {
  private readonly logger: PipelineDebugLogger;
  private readonly v1Manager: PipelineManager;
  private readonly v2Manager?: V2PipelineManager;
  private readonly comparator: ResultComparator;
  private readonly performanceAnalyzer: PerformanceAnalyzer;

  constructor(
    v1Manager: PipelineManager,
    v2Manager: V2PipelineManager | undefined,
    logger?: PipelineDebugLogger
  ) {
    this.v1Manager = v1Manager;
    this.v2Manager = v2Manager;
    this.logger = logger || new PipelineDebugLogger();
    this.comparator = new ResultComparator(logger);
    this.performanceAnalyzer = new PerformanceAnalyzer(logger);
  }

  /**
   * Execute load test with given scenarios and configuration
   */
  async executeLoadTest(
    scenarios: TestScenario[],
    config: LoadTestConfig
  ): Promise<LoadTestResult> {
    const testId = `load-test-${Date.now()}`;
    const startTime = Date.now();

    this.logger.logModule('load-test-runner', 'test-start', {
      testId,
      scenarios: scenarios.length,
      concurrency: config.concurrency,
      duration: config.duration
    });

    try {
      // Generate test requests from scenarios
      const testRequests = this.generateTestRequests(scenarios, config);
      
      // Execute V1 load test
      const v1Results = await this.executePipelineLoadTest(
        this.v1Manager,
        testRequests,
        config,
        'v1'
      );

      // Execute V2 load test if available
      let v2Results: TestResult[] = [];
      if (this.v2Manager) {
        v2Results = await this.executePipelineLoadTest(
          this.v2Manager,
          testRequests,
          config,
          'v2'
        );
      }

      // Analyze results
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      const comparison = this.comparator.compareResults(v1Results, v2Results);
      const performance = this.performanceAnalyzer.analyzePerformance(v1Results, v2Results, duration);

      const result: LoadTestResult = {
        testId,
        startTime,
        endTime,
        duration,
        totalRequests: testRequests.length,
        successfulRequests: v1Results.filter(r => r.success).length,
        failedRequests: v1Results.filter(r => !r.success).length,
        v1Results,
        v2Results,
        comparison,
        performance
      };

      this.logger.logModule('load-test-runner', 'test-complete', {
        testId,
        duration,
        consistencyScore: comparison.consistencyScore,
        performanceDiff: comparison.performanceDifference
      });

      return result;

    } catch (error) {
      this.logger.logModule('load-test-runner', 'test-error', {
        testId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Execute single scenario comparison
   */
  async executeScenarioComparison(
    scenario: TestScenario
  ): Promise<LoadTestResult> {
    const config: LoadTestConfig = {
      concurrency: 1,
      duration: 10,
      rampUpTime: 2,
      scenarioWeight: { [scenario.id]: 1 }
    };

    return this.executeLoadTest([scenario], config);
  }

  /**
   * Execute load test for a specific pipeline
   */
  private async executePipelineLoadTest(
    manager: PipelineManager | V2PipelineManager,
    requests: PipelineRequest[],
    config: LoadTestConfig,
    pipelineVersion: 'v1' | 'v2' = 'v1'
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const concurrency = Math.max(1, Number(config.concurrency || 1));
    const semaphore = new Semaphore(concurrency);

    this.logger.logModule('load-test-runner', 'pipeline-test-start', {
      pipelineVersion,
      total: requests.length,
      concurrency
    });

    const promises = requests.map(async (request, index) => {
      await semaphore.acquire();
      const startTime = Date.now();
      try {
        // Ramp-up spread
        if (config.rampUpTime && config.rampUpTime > 0) {
          const delay = (index / Math.max(1, requests.length)) * (config.rampUpTime * 1000);
          if (delay > 0) await new Promise(r => setTimeout(r, delay));
        }

        // Call pipeline manager (support both v1/v2 interfaces)
        const fn: any = (manager as any).processRequest || (manager as any).process;
        if (typeof fn !== 'function') throw new Error('Pipeline manager has no processRequest/process method');
        const response: PipelineResponse = await fn.call(manager, request);

        const endTime = Date.now();
        const result: TestResult = {
          requestId: request.route?.requestId || `req-${index}`,
          request,
          response,
          success: true,
          startTime,
          endTime,
          latency: endTime - startTime,
          pipelineVersion,
          error: undefined
        };
        results.push(result);
        return result;
      } catch (error) {
        const endTime = Date.now();
        const result: TestResult = {
          requestId: request.route?.requestId || `req-${index}`,
          request,
          response: undefined,
          success: false,
          startTime,
          endTime,
          latency: endTime - startTime,
          pipelineVersion,
          error: error instanceof Error ? error.message : String(error)
        };
        results.push(result);
        return result;
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);

    this.logger.logModule('load-test-runner', 'pipeline-test-complete', {
      pipelineVersion,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      avgLatency: results.length ? (results.reduce((sum, r) => sum + r.latency, 0) / results.length) : 0
    });

    return results;
  }
  /**
   * Run real-world comparison test using codex samples
   */
  async runRealWorldComparison(
    concurrency: number = 5,
    sampleDir?: string
  ): Promise<LoadTestResult> {
    const scenarios = await getAdaptedTestScenarios(sampleDir);
    this.logger.logModule('load-test-runner', 'scenarios-built', { count: scenarios.length });
    const config: LoadTestConfig = {
      concurrency,
      duration: 60,
      rampUpTime: 10,
      scenarioWeight: {}
    };
    scenarios.forEach((scenario: any, index: number) => {
      config.scenarioWeight[scenario.id || scenario.name || `scenario-${index}`] = 1;
    });
    return await this.executeLoadTest(scenarios, config);
  }
  // (removed malformed executePipelineVersionLoadTest)
  /**
   * Semaphore implementation for concurrency control
  private class Semaphore {
    private permits: number;
    private waitQueue: (() => void)[] = [];
    constructor(maxConcurrency: number) {
    }
    
    async acquire(): Promise<void> {
      return new Promise<void>(resolve => {
        if (this.permits > 0) {
          this.permits--;
          resolve();
        } else {
          this.waitQueue.push(resolve);
        }
      });
    }
    
    release(): void {
      this.permits++;
      if (this.waitQueue.length > 0) {
        const next = this.waitQueue.shift();
        if (next) next();
      }
    }
  }

  /**
   * Generate test requests from scenarios
   */
  private generateTestRequests(
    scenarios: TestScenario[],
    config: LoadTestConfig
  ): PipelineRequest[] {
    const requests: PipelineRequest[] = [];
    
    // Calculate how many requests per scenario based on duration and weight
    const totalWeight = Object.values(config.scenarioWeight).reduce((sum, weight) => sum + weight, 0);
    const totalRequests = Math.floor(config.duration * 10); // 10 requests per second baseline
    
    for (const scenario of scenarios) {
      const weight = config.scenarioWeight[scenario.id] || 1;
      const scenarioRequests = Math.floor((weight / totalWeight) * totalRequests);
      
      for (let i = 0; i < scenarioRequests; i++) {
        // Use cyclic requests from scenario
        const requestIndex = i % scenario.requests.length;
        const originalRequest = scenario.requests[requestIndex];
        
        const request: PipelineRequest = {
          ...originalRequest,
          route: {
            ...originalRequest.route,
            requestId: `${originalRequest.route.requestId}-test-${i}`,
            timestamp: Date.now()
          }
        };
        
        requests.push(request);
      }
    }
    
    return requests;
  }
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private available: number;
  private waiters: (() => void)[] = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }

    return new Promise(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    this.available++;
    
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve();
      this.available--;
    }
  }
}
