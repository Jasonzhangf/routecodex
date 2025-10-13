/**
 * Test Adapter for LLMSwitch AJV vs Original Implementation
 * Provides black-box testing capabilities to compare outputs
 */

import type {
  LLMSwitchRequest,
  LLMSwitchResponse,
  ConversionContext,
  MessageFormat
} from '../types/index.js';
import { LLMSwitchAjvAdapter } from './llmswitch-adapter.js';

/**
 * Test result interface
 */
export interface TestResult {
  testName: string;
  testCase: any;
  originalResult: any;
  ajvResult: any;
  passed: boolean;
  differences: Difference[];
  performance: {
    original: number;
    ajv: number;
    improvement: number;
  };
  errors: string[];
}

/**
 * Difference between results
 */
export interface Difference {
  path: string;
  originalValue: any;
  ajvValue: any;
  type: 'missing' | 'extra' | 'different' | 'type_mismatch';
}

/**
 * Mock logger for testing
 */
class MockLogger {
  logs: Array<{ event: string; data: any; timestamp: number }> = [];

  logModule(moduleId: string, event: string, data: any): void {
    this.logs.push({ event, data, timestamp: Date.now() });
  }

  logTransformation(moduleId: string, type: string, input: any, output: any): void {
    this.logs.push({ event: `transformation:${type}`, data: { input, output }, timestamp: Date.now() });
  }

  logPerformance(moduleId: string, metrics: any): void {
    this.logs.push({ event: 'performance', data: metrics, timestamp: Date.now() });
  }

  logError(moduleId: string, error: Error, context?: any): void {
    this.logs.push({ event: 'error', data: { error: error.message, context }, timestamp: Date.now() });
  }

  clear(): void {
    this.logs = [];
  }
}

/**
 * Test adapter for comparing AJV and original implementations
 */
export class LLMSwitchTestAdapter {
  private ajvAdapter: LLMSwitchAjvAdapter;
  private mockLogger: MockLogger;
  private originalAdapter?: any; // To be injected

  constructor(config?: any) {
    this.mockLogger = new MockLogger();

    // Create AJV adapter with test configuration
    const testConfig = {
      id: 'test-llmswitch-ajv',
      type: 'llmswitch-anthropic-openai-ajv',
      config: {
        enableStreaming: true,
        enableTools: true,
        strictMode: false,
        fallbackToOriginal: false, // Disabled for testing
        performanceMonitoring: true,
        customSchemas: {}
      }
    };

    this.ajvAdapter = new LLMSwitchAjvAdapter(testConfig, {
      logger: this.mockLogger
    });
  }

  /**
   * Set the original adapter for comparison
   */
  setOriginalAdapter(originalAdapter: any): void {
    this.originalAdapter = originalAdapter;
  }

  /**
   * Initialize adapters
   */
  async initialize(): Promise<void> {
    await this.ajvAdapter.initialize();

    if (this.originalAdapter && typeof this.originalAdapter.initialize === 'function') {
      await this.originalAdapter.initialize();
    }
  }

  /**
   * Run a single test case
   */
  async runTestCase(testName: string, testCase: any): Promise<TestResult> {
    if (!this.originalAdapter) {
      throw new Error('Original adapter not set. Call setOriginalAdapter() first.');
    }

    const result: TestResult = {
      testName,
      testCase,
      originalResult: null,
      ajvResult: null,
      passed: false,
      differences: [],
      performance: { original: 0, ajv: 0, improvement: 0 },
      errors: []
    };

    try {
      // Test with original implementation
      const originalStart = performance.now();
      result.originalResult = await this.runWithOriginal(testCase);
      const originalEnd = performance.now();
      result.performance.original = originalEnd - originalStart;

      // Test with AJV implementation
      this.mockLogger.clear();
      const ajvStart = performance.now();
      result.ajvResult = await this.runWithAjv(testCase);
      const ajvEnd = performance.now();
      result.performance.ajv = ajvEnd - ajvStart;

      // Calculate performance improvement
      result.performance.improvement =
        ((result.performance.original - result.performance.ajv) / result.performance.original) * 100;

      // Compare results
      result.differences = this.compareResults(result.originalResult, result.ajvResult);
      result.passed = result.differences.length === 0;

      // Collect any errors
      if (this.mockLogger.logs.some(log => log.event === 'error')) {
        result.errors = this.mockLogger.logs
          .filter(log => log.event === 'error')
          .map(log => log.data.error);
      }

    } catch (error) {
      result.errors.push((error as Error).message);
      result.passed = false;
    }

    return result;
  }

  /**
   * Run multiple test cases
   */
  async runTestSuite(testCases: Array<{ name: string; data: any; type: string }>): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (const testCase of testCases) {
      const result = await this.runTestCase(testCase.name, testCase);
      results.push(result);
    }

    return results;
  }

  /**
   * Generate test report
   */
  generateReport(results: TestResult[]): {
    summary: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    performance: {
      averageImprovement: number;
      fastest: string;
      slowest: string;
    };
    commonDifferences: Array<{
      path: string;
      frequency: number;
      examples: any[];
    }>;
    detailedResults: TestResult[];
  } {
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    const passRate = (passed / results.length) * 100;

    const improvements = results
      .filter(r => r.performance.improvement !== 0)
      .map(r => r.performance.improvement);
    const averageImprovement = improvements.length > 0
      ? improvements.reduce((sum, imp) => sum + imp, 0) / improvements.length
      : 0;

    const fastest = results.reduce((min, r) =>
      r.performance.ajv < min.performance.ajv ? r : min
    );
    const slowest = results.reduce((max, r) =>
      r.performance.ajv > max.performance.ajv ? r : max
    );

    // Analyze common differences
    const differenceMap = new Map<string, { count: number; examples: any[] }>();
    results.forEach(result => {
      result.differences.forEach(diff => {
        const key = diff.path;
        if (!differenceMap.has(key)) {
          differenceMap.set(key, { count: 0, examples: [] });
        }
        const entry = differenceMap.get(key)!;
        entry.count++;
        if (entry.examples.length < 3) {
          entry.examples.push({
            original: diff.originalValue,
            ajv: diff.ajvValue
          });
        }
      });
    });

    const commonDifferences = Array.from(differenceMap.entries())
      .map(([path, data]) => ({
        path,
        frequency: data.count,
        examples: data.examples
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);

    return {
      summary: {
        total: results.length,
        passed,
        failed,
        passRate
      },
      performance: {
        averageImprovement,
        fastest: fastest.testName,
        slowest: slowest.testName
      },
      commonDifferences,
      detailedResults: results
    };
  }

  // Private helper methods

  private async runWithOriginal(testCase: any): Promise<any> {
    if (testCase.type === 'request') {
      return await this.originalAdapter.processIncoming(testCase.data);
    } else if (testCase.type === 'response') {
      return await this.originalAdapter.processOutgoing(testCase.data);
    } else if (testCase.type === 'transform-request') {
      return await this.originalAdapter.transformRequest(testCase.data);
    } else if (testCase.type === 'transform-response') {
      return await this.originalAdapter.transformResponse(testCase.data);
    } else {
      throw new Error(`Unknown test case type: ${testCase.type}`);
    }
  }

  private async runWithAjv(testCase: any): Promise<any> {
    if (testCase.type === 'request') {
      return await this.ajvAdapter.processIncoming(testCase.data);
    } else if (testCase.type === 'response') {
      return await this.ajvAdapter.processOutgoing(testCase.data);
    } else if (testCase.type === 'transform-request') {
      return await this.ajvAdapter.transformRequest(testCase.data);
    } else if (testCase.type === 'transform-response') {
      return await this.ajvAdapter.transformResponse(testCase.data);
    } else {
      throw new Error(`Unknown test case type: ${testCase.type}`);
    }
  }

  private compareResults(original: any, ajv: any): Difference[] {
    const differences: Difference[] = [];

    // Extract data from DTOs if needed
    const originalData = original?.data || original;
    const ajvData = ajv?.data || ajv;

    this.compareObjects(originalData, ajvData, '', differences);

    return differences;
  }

  private compareObjects(obj1: any, obj2: any, path: string, differences: Difference[]): void {
    // Handle null/undefined
    if (obj1 === null || obj1 === undefined) {
      if (obj2 !== null && obj2 !== undefined) {
        differences.push({
          path: path || 'root',
          originalValue: obj1,
          ajvValue: obj2,
          type: 'missing'
        });
      }
      return;
    }

    if (obj2 === null || obj2 === undefined) {
      differences.push({
        path: path || 'root',
        originalValue: obj1,
        ajvValue: obj2,
        type: 'extra'
      });
      return;
    }

    // Handle type differences
    if (typeof obj1 !== typeof obj2) {
      differences.push({
        path: path || 'root',
        originalValue: obj1,
        ajvValue: obj2,
        type: 'type_mismatch'
      });
      return;
    }

    // Handle primitive values
    if (typeof obj1 !== 'object' || Array.isArray(obj1)) {
      if (JSON.stringify(obj1) !== JSON.stringify(obj2)) {
        differences.push({
          path: path || 'root',
          originalValue: obj1,
          ajvValue: obj2,
          type: 'different'
        });
      }
      return;
    }

    // Handle objects
    const keys1 = new Set(Object.keys(obj1));
    const keys2 = new Set(Object.keys(obj2));

    // Check for missing keys
    for (const key of keys1) {
      if (!keys2.has(key)) {
        differences.push({
          path: path ? `${path}.${key}` : key,
          originalValue: obj1[key],
          ajvValue: undefined,
          type: 'missing'
        });
      }
    }

    // Check for extra keys
    for (const key of keys2) {
      if (!keys1.has(key)) {
        differences.push({
          path: path ? `${path}.${key}` : key,
          originalValue: undefined,
          ajvValue: obj2[key],
          type: 'extra'
        });
      }
    }

    // Recursively compare common keys
    for (const key of keys1) {
      if (keys2.has(key)) {
        this.compareObjects(
          obj1[key],
          obj2[key],
          path ? `${path}.${key}` : key,
          differences
        );
      }
    }
  }

  /**
   * Get AJV adapter metrics
   */
  getAjvMetrics(): any {
    return this.ajvAdapter.getMetrics();
  }

  /**
   * Get mock logs
   */
  getLogs(): Array<{ event: string; data: any; timestamp: number }> {
    return this.mockLogger.logs;
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    await this.ajvAdapter.cleanup();
  }
}