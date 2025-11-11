/**
 * Core Type Definitions for V1/V2 Pipeline Comparison
 * 
 * Centralized type definitions to avoid circular dependencies
 * and ensure clean module architecture.
 */

import type { PipelineRequest, PipelineResponse } from '../../../interfaces/pipeline-interfaces.js';

/**
 * Test endpoints supported
 */
export type TestEndpoint = 'chat' | 'responses' | 'messages';

/**
 * Test providers supported
 */
export type TestProvider = 'openai' | 'anthropic' | 'glm' | 'qwen' | 'lmstudio' | 'iflow';

/**
 * Single test result
 */
export interface TestResult {
  requestId: string;
  success: boolean;
  latency: number; // ms
  executionTime: number; // ms
  response: any;
  error?: string;
  metadata?: Record<string, any>;
}

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
 * Test scenario definition
 */
export interface TestScenario {
  id: string;
  name: string;
  description: string;
  endpoint: TestEndpoint;
  provider: TestProvider;
  requests: PipelineRequest[];
  expectedOutput: {
    status: number;
    hasContent?: boolean;
    hasChoices?: boolean;
    hasToolCalls?: boolean;
    isStreaming?: boolean;
  };
  metadata?: Record<string, any>;
}

/**
 * Comparison result between V1 and V2
 */
export interface ComparisonResult {
  scenarioId: string;
  scenarioName: string;
  v1: {
    executor: string;
    results: TestResult[];
    totalTime: number;
    successCount: number;
    errorCount: number;
    averageLatency: number;
  };
  v2: {
    executor: string;
    results: TestResult[];
    totalTime: number;
    successCount: number;
    errorCount: number;
    averageLatency: number;
  };
  comparison: {
    consistency: number; // 0-1
    performanceGain: number; // percentage
    similarityScore: number;
    latencyDifference: number;
  };
}

/**
 * Performance metrics for analysis
 */
export interface PerformanceMetrics {
  averageLatency: number;
  medianLatency: number;
  p95Latency: number;
  p99Latency: number;
  minLatency: number;
  maxLatency: number;
  throughputQPS: number;
  successRate: number; // 0-1
}

/**
 * Latency distribution buckets
 */
export interface LatencyDistribution {
  buckets: number[];
  v1Distribution: number[];
  v2Distribution: number[];
}

/**
 * Complete performance analysis result
 */
export interface PerformanceAnalysis {
  summary: {
    totalScenarios: number;
    v1AverageLatency: number;
    v2AverageLatency: number;
    performanceGain: number;
    consistency: number;
  };
  metrics: {
    v1: PerformanceMetrics;
    v2: PerformanceMetrics;
    overallPerformanceGain: number;
  };
  distribution: LatencyDistribution;
  bottlenecks: Array<{
    type: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
    affectedScenarios: string[];
    details: any;
  }>;
  recommendations: string[];
  executionTime?: number;
}

/**
 * Complete test report
 */
export interface TestReport {
  metadata: {
    generatedAt: number;
    version: string;
    totalScenarios: number;
    executionTime: number;
  };
  summary: {
    overallResult: 'pass' | 'fail' | 'warning';
    performanceGain: number;
    consistency: number;
    bottlenecks: number;
    recommendations: number;
  };
  performance: PerformanceAnalysis;
  scenarioResults: ComparisonResult[];
  recommendations: Array<{
    category: 'performance' | 'reliability' | 'compatibility' | 'architecture';
    priority: 'high' | 'medium' | 'low';
    description: string;
    details?: any;
  }>;
  rawResults: {
    comparisonResults: ComparisonResult[];
    scenarios: TestScenario[];
    metadata?: any;
  };
}

/**
 * Load test configuration
 */
export interface LoadTestConfig {
  concurrency: number;
  duration: number; // seconds
  rampUpTime: number; // seconds
  scenarioWeight: Record<string, number>; // scenario weight by name
}

/**
 * Load test case definition
 */
export interface LoadTestCase {
  id: string;
  name: string;
  description: string;
  scenario: TestScenario;
  expectedDuration: number;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Pipeline executor interface
 */
export interface PipelineExecutor {
  name: string;
  version: 'v1' | 'v2';
  processRequest(request: PipelineRequest): Promise<PipelineResponse>;
}
