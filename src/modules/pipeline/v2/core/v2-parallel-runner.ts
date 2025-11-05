/**
 * V2 Parallel Runner
 *
 * Runs V2 simulation in parallel with V1 pipeline without affecting the actual flow.
 * Provides real-time validation and comparison between V1 and V2 architectures.
 */

import type { PipelineRequest, PipelineResponse } from '../types/v2-types.js';
import type { V2PipelineManager } from './v2-pipeline-manager.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { writeServerV2Snapshot } from '../../../../server-v2/utils/server-v2-snapshot-writer.js';

/**
 * Parallel Run Configuration
 */
export interface ParallelRunConfig {
  enabled: boolean;
  sampleRate: number; // 0.0 to 1.0, what percentage of requests to sample
  maxConcurrency: number;
  timeoutMs: number;
  comparisonMode: 'strict' | 'lenient' | 'none';
  metricsCollection: boolean;
}

/**
 * Parallel Run Result
 */
export interface ParallelRunResult {
  requestId: string;
  v1Response?: PipelineResponse;
  v2Response?: PipelineResponse;
  v1Success: boolean;
  v2Success: boolean;
  v1Duration?: number;
  v2Duration?: number;
  comparison: {
    matches: boolean;
    differences: string[];
    similarity: number; // 0.0 to 1.0
  };
  errors: {
    v1Error?: string;
    v2Error?: string;
  };
  timestamp: number;
}

/**
 * Parallel Run Metrics
 */
export interface ParallelRunMetrics {
  totalRequests: number;
  sampledRequests: number;
  v1SuccessRate: number;
  v2SuccessRate: number;
  averageComparison: number;
  averageV1Latency: number;
  averageV2Latency: number;
  concurrencyIssues: number;
  timeoutErrors: number;
  lastUpdate: number;
}

/**
 * V2 Parallel Runner
 *
 * Manages parallel execution of V2 simulation alongside V1 pipeline.
 * Non-blocking design with configurable sampling and comparison.
 */
export class V2ParallelRunner {
  private readonly logger: PipelineDebugLogger;
  private readonly v2Manager: V2PipelineManager;
  private readonly config: ParallelRunConfig;

  // State management
  private isRunning = false;
  private activeRuns = new Map<string, Promise<ParallelRunResult>>();
  private metrics: ParallelRunMetrics;
  private runHistory: ParallelRunResult[] = [];
  private maxHistorySize = 1000;

  constructor(
    v2Manager: V2PipelineManager,
    config: Partial<ParallelRunConfig> = {},
    logger?: PipelineDebugLogger
  ) {
    this.v2Manager = v2Manager;
    this.logger = logger || new PipelineDebugLogger();
    this.config = {
      enabled: true,
      sampleRate: 0.1, // 10% sampling by default
      maxConcurrency: 5,
      timeoutMs: 30000, // 30 seconds
      comparisonMode: 'lenient',
      metricsCollection: true,
      ...config
    };

    this.metrics = {
      totalRequests: 0,
      sampledRequests: 0,
      v1SuccessRate: 0,
      v2SuccessRate: 0,
      averageComparison: 0,
      averageV1Latency: 0,
      averageV2Latency: 0,
      concurrencyIssues: 0,
      timeoutErrors: 0,
      lastUpdate: Date.now()
    };
  }

  /**
   * Start parallel runner
   */
  start(): void {
    if (this.isRunning) {
      this.logger.logModule('v2-parallel-runner', 'start-skipped', {
        reason: 'already_running'
      });
      return;
    }

    this.isRunning = true;
    this.metrics.lastUpdate = Date.now();

    this.logger.logModule('v2-parallel-runner', 'start', {
      config: this.config
    });
  }

  /**
   * Stop parallel runner
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.logModule('v2-parallel-runner', 'stop-start', {
      activeRuns: this.activeRuns.size
    });

    this.isRunning = false;

    // Wait for all active runs to complete or timeout
    const promises = Array.from(this.activeRuns.values());
    if (promises.length > 0) {
      try {
        await Promise.allSettled(promises);
      } catch (error) {
        this.logger.logModule('v2-parallel-runner', 'stop-error', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    this.activeRuns.clear();

    this.logger.logModule('v2-parallel-runner', 'stop-complete');
  }

  /**
   * Process request in parallel (non-blocking)
   */
  processParallel(
    requestId: string,
    v1Request: PipelineRequest,
    v1Response: PipelineResponse | null,
    v1Error: Error | null = null,
    v1Duration: number = 0
  ): void {
    if (!this.isRunning || !this.config.enabled) {
      return;
    }

    this.metrics.totalRequests++;

    // Sample based on configured rate
    if (Math.random() > this.config.sampleRate) {
      return;
    }

    this.metrics.sampledRequests++;

    // Check concurrency limits
    if (this.activeRuns.size >= this.config.maxConcurrency) {
      this.metrics.concurrencyIssues++;
      this.logger.logModule('v2-parallel-runner', 'concurrency-limit', {
        requestId,
        activeRuns: this.activeRuns.size
      });
      return;
    }

    // Start parallel run
    const runPromise = this.executeParallelRun(
      requestId,
      v1Request,
      v1Response,
      v1Error,
      v1Duration
    );

    this.activeRuns.set(requestId, runPromise);

    // Handle completion asynchronously
    runPromise
      .then(result => {
        this.handleRunCompletion(result);
        this.activeRuns.delete(requestId);
      })
      .catch(error => {
        this.logger.logModule('v2-parallel-runner', 'run-error', {
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });
        this.activeRuns.delete(requestId);
      });
  }

  /**
   * Get current metrics
   */
  getMetrics(): ParallelRunMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Get run history
   */
  getRunHistory(limit?: number): ParallelRunResult[] {
    if (limit) {
      return this.runHistory.slice(-limit);
    }
    return [...this.runHistory];
  }

  /**
   * Get performance comparison
   */
  getPerformanceComparison(): {
    v1FasterCount: number;
    v2FasterCount: number;
    similarCount: number;
    averageSpeedup: number;
  } {
    const recentRuns = this.runHistory.slice(-100); // Last 100 runs
    let v1FasterCount = 0;
    let v2FasterCount = 0;
    let similarCount = 0;
    let totalSpeedup = 0;
    let validComparisons = 0;

    for (const run of recentRuns) {
      if (run.v1Success && run.v2Success && run.v1Duration && run.v2Duration) {
        const speedup = run.v1Duration / run.v2Duration;
        totalSpeedup += speedup;
        validComparisons++;

        if (speedup > 1.1) {
          v2FasterCount++;
        } else if (speedup < 0.9) {
          v1FasterCount++;
        } else {
          similarCount++;
        }
      }
    }

    return {
      v1FasterCount,
      v2FasterCount,
      similarCount,
      averageSpeedup: validComparisons > 0 ? totalSpeedup / validComparisons : 0
    };
  }

  /**
   * Clear history and reset metrics
   */
  reset(): void {
    this.runHistory = [];
    this.metrics = {
      totalRequests: 0,
      sampledRequests: 0,
      v1SuccessRate: 0,
      v2SuccessRate: 0,
      averageComparison: 0,
      averageV1Latency: 0,
      averageV2Latency: 0,
      concurrencyIssues: 0,
      timeoutErrors: 0,
      lastUpdate: Date.now()
    };

    this.logger.logModule('v2-parallel-runner', 'reset');
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ParallelRunConfig>): void {
    const oldConfig = { ...this.config };
    Object.assign(this.config, newConfig);

    this.logger.logModule('v2-parallel-runner', 'config-updated', {
      oldConfig,
      newConfig: this.config
    });
  }

  /**
   * Execute parallel run
   */
  private async executeParallelRun(
    requestId: string,
    v1Request: PipelineRequest,
    v1Response: PipelineResponse | null,
    v1Error: Error | null,
    v1Duration: number
  ): Promise<ParallelRunResult> {
    const startTime = Date.now();
    const result: ParallelRunResult = {
      requestId,
      v1Success: !v1Error,
      v2Success: false,
      comparison: {
        matches: false,
        differences: [],
        similarity: 0
      },
      errors: {},
      timestamp: startTime
    };

    if (v1Response) {
      result.v1Response = v1Response;
      result.v1Duration = v1Duration;
    }

    if (v1Error) {
      result.errors.v1Error = v1Error.message;
    }

    try {
      // Execute V2 simulation with timeout
      const v2Promise = this.v2Manager.processRequest(v1Request);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('V2 parallel run timeout')), this.config.timeoutMs);
      });

      const v2Response = await Promise.race([v2Promise, timeoutPromise]);
      const v2Duration = Date.now() - startTime;

      result.v2Response = v2Response;
      result.v2Success = true;
      result.v2Duration = v2Duration;

      // 写入 V2 响应快照（不阻塞主流程）
      try {
        await writeServerV2Snapshot({
          phase: 'server-response',
          requestId,
          entryEndpoint: '/v2/chat/completions',
          data: {
            status: v2Response.status,
            headers: v2Response.headers,
            body: v2Response.body,
            metadata: v2Response.metadata
          } as any
        });
      } catch { /* ignore snapshot errors */ }

      // Compare responses if both succeeded
      if (v1Response && this.config.comparisonMode !== 'none') {
        result.comparison = this.compareResponses(v1Response, v2Response);
      }

    } catch (v2Error) {
      result.errors.v2Error = v2Error instanceof Error ? v2Error.message : String(v2Error);

      if (v2Error instanceof Error && v2Error.message === 'V2 parallel run timeout') {
        this.metrics.timeoutErrors++;
      }
    }

    // 落盘最终对比摘要（异步）
    try {
      await writeServerV2Snapshot({
        phase: 'server-final',
        requestId: result.requestId,
        entryEndpoint: '/v2/chat/completions',
        data: {
          v1Success: result.v1Success,
          v2Success: result.v2Success,
          comparison: result.comparison,
          v1Duration: result.v1Duration,
          v2Duration: result.v2Duration,
          errors: result.errors
        } as any
      });
    } catch { /* ignore snapshot errors */ }

    return result;
  }

  /**
   * Handle run completion
   */
  private handleRunCompletion(result: ParallelRunResult): void {
    // Add to history
    this.runHistory.push(result);

    // Limit history size
    if (this.runHistory.length > this.maxHistorySize) {
      this.runHistory = this.runHistory.slice(-this.maxHistorySize);
    }

    // Update metrics
    this.updateMetrics();

    // Log significant events
    if (result.v1Success !== result.v2Success) {
      this.logger.logModule('v2-parallel-runner', 'success-mismatch', {
        requestId: result.requestId,
        v1Success: result.v1Success,
        v2Success: result.v2Success,
        errors: result.errors
      });
    }

    if (result.comparison.similarity < 0.5 && result.comparison.similarity > 0) {
      this.logger.logModule('v2-parallel-runner', 'low-similarity', {
        requestId: result.requestId,
        similarity: result.comparison.similarity,
        differences: result.comparison.differences.slice(0, 3) // First 3 differences
      });
    }
  }

  /**
   * Compare V1 and V2 responses
   */
  private compareResponses(v1Response: PipelineResponse, v2Response: PipelineResponse): {
    matches: boolean;
    differences: string[];
    similarity: number;
  } {
    const differences: string[] = [];
    let similarity = 0;
    let totalChecks = 0;

    // Compare status codes
    totalChecks++;
    if (v1Response.status === v2Response.status) {
      similarity += 1;
    } else {
      differences.push(`Status: V1=${v1Response.status}, V2=${v2Response.status}`);
    }

    // Compare headers (key comparison)
    totalChecks++;
    const v1HeaderKeys = Object.keys(v1Response.headers).sort();
    const v2HeaderKeys = Object.keys(v2Response.headers).sort();

    if (JSON.stringify(v1HeaderKeys) === JSON.stringify(v2HeaderKeys)) {
      similarity += 0.8; // 80% weight for header structure
    } else {
      differences.push(`Header structure differs`);
    }

    // Compare body content
    totalChecks++;
    try {
      const v1BodyStr = JSON.stringify(v1Response.body);
      const v2BodyStr = JSON.stringify(v2Response.body);

      if (v1BodyStr === v2BodyStr) {
        similarity += 1;
      } else {
        // Check for partial similarity
        if (typeof v1Response.body === 'object' && typeof v2Response.body === 'object') {
          const v1Keys = Object.keys(v1Response.body as Record<string, unknown>);
          const v2Keys = Object.keys(v2Response.body as Record<string, unknown>);
          const commonKeys = v1Keys.filter(key => v2Keys.includes(key));
          const similarityRatio = commonKeys.length / Math.max(v1Keys.length, v2Keys.length);
          similarity += similarityRatio;

          if (similarityRatio < 0.8) {
            differences.push(`Body structure differs significantly`);
          }
        } else {
          differences.push(`Body content differs`);
        }
      }
    } catch (error) {
      differences.push(`Body comparison failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const finalSimilarity = totalChecks > 0 ? similarity / totalChecks : 0;
    const matches = this.config.comparisonMode === 'strict'
      ? finalSimilarity > 0.95
      : this.config.comparisonMode === 'lenient'
        ? finalSimilarity > 0.7
        : true; // 'none' mode always matches

    return {
      matches,
      differences,
      similarity: finalSimilarity
    };
  }

  /**
   * Update aggregated metrics
   */
  private updateMetrics(): void {
    if (!this.config.metricsCollection) {
      return;
    }

    const recentRuns = this.runHistory.slice(-100); // Last 100 runs for metrics

    if (recentRuns.length === 0) {
      return;
    }

    let v1SuccessCount = 0;
    let v2SuccessCount = 0;
    let totalComparison = 0;
    let totalV1Latency = 0;
    let totalV2Latency = 0;
    let validV1Latency = 0;
    let validV2Latency = 0;

    for (const run of recentRuns) {
      if (run.v1Success) {v1SuccessCount++;}
      if (run.v2Success) {v2SuccessCount++;}
      totalComparison += run.comparison.similarity;

      if (run.v1Duration) {
        totalV1Latency += run.v1Duration;
        validV1Latency++;
      }

      if (run.v2Duration) {
        totalV2Latency += run.v2Duration;
        validV2Latency++;
      }
    }

    this.metrics.v1SuccessRate = v1SuccessCount / recentRuns.length;
    this.metrics.v2SuccessRate = v2SuccessCount / recentRuns.length;
    this.metrics.averageComparison = totalComparison / recentRuns.length;
    this.metrics.averageV1Latency = validV1Latency > 0 ? totalV1Latency / validV1Latency : 0;
    this.metrics.averageV2Latency = validV2Latency > 0 ? totalV2Latency / validV2Latency : 0;
    this.metrics.lastUpdate = Date.now();
  }
}
