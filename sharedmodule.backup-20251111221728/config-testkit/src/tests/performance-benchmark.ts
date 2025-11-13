/**
 * RouteCodex Performance Benchmarking Framework
 * Benchmarks configuration parsing and processing performance
 */

import { ConfigParser } from 'routecodex-config-engine';
import { CompatibilityEngine } from 'routecodex-config-compat';
import type {
  PerformanceBenchmark,
  PerformanceMetric,
  PerformanceThreshold,
  TestResult,
  TestError
} from '../types/testkit-types.js';

export interface BenchmarkResult {
  benchmarkId: string;
  metrics: Record<string, number>;
  thresholds: PerformanceThreshold;
  passed: boolean;
  warnings: string[];
  errors: string[];
  duration: number;
  memoryUsage: {
    start: number;
    end: number;
    delta: number;
  };
}

export class PerformanceBenchmarker {
  private configParser: ConfigParser;
  private compatibilityEngine: CompatibilityEngine;

  constructor() {
    this.configParser = new ConfigParser();
    this.compatibilityEngine = new CompatibilityEngine();
  }

  /**
   * Run a performance benchmark
   */
  async runBenchmark(benchmark: PerformanceBenchmark): Promise<BenchmarkResult> {
    const startTime = performance.now();
    const startMemory = process.memoryUsage().heapUsed;
    const metrics: Record<string, number> = {};
    const warnings: string[] = [];
    const errors: string[] = [];

    try {
      // Warmup iterations
      if (benchmark.warmupIterations > 0) {
        await this.runWarmup(benchmark, benchmark.warmupIterations);
      }

      // Main benchmark iterations
      const results = await this.runIterations(benchmark, benchmark.iterations);

      // Calculate metrics
      for (const metric of benchmark.metrics) {
        const values = results.map(r => r[metric.name]);
        metrics[metric.name] = this.calculateAggregate(values, metric.aggregator);
      }

      // Check thresholds
      const passed = this.checkThresholds(metrics, benchmark.thresholds, warnings);

      return {
        benchmarkId: benchmark.id,
        metrics,
        thresholds: benchmark.thresholds,
        passed,
        warnings,
        errors,
        duration: performance.now() - startTime,
        memoryUsage: {
          start: startMemory,
          end: process.memoryUsage().heapUsed,
          delta: process.memoryUsage().heapUsed - startMemory
        }
      };

    } catch (error) {
      return {
        benchmarkId: benchmark.id,
        metrics: {},
        thresholds: benchmark.thresholds,
        passed: false,
        warnings,
        errors: [`Benchmark failed: ${error}`],
        duration: performance.now() - startTime,
        memoryUsage: {
          start: startMemory,
          end: process.memoryUsage().heapUsed,
          delta: process.memoryUsage().heapUsed - startMemory
        }
      };
    }
  }

  /**
   * Run warmup iterations
   */
  private async runWarmup(benchmark: PerformanceBenchmark, iterations: number): Promise<void> {
    for (let i = 0; i < iterations; i++) {
      await this.runSingleIteration(benchmark);
    }
  }

  /**
   * Run benchmark iterations
   */
  private async runIterations(benchmark: PerformanceBenchmark, iterations: number): Promise<Record<string, number>[]> {
    const results: Record<string, number>[] = [];

    for (let i = 0; i < iterations; i++) {
      const iterationResult = await this.runSingleIteration(benchmark);
      results.push(iterationResult);
    }

    return results;
  }

  /**
   * Run a single benchmark iteration
   */
  private async runSingleIteration(benchmark: PerformanceBenchmark): Promise<Record<string, number>> {
    const iterationStart = performance.now();
    const iterationMemoryStart = process.memoryUsage().heapUsed;
    const result: Record<string, number> = {};

    try {
      // Measure parsing time
      const parseStart = performance.now();
      const validationResult = await this.configParser.parseFromString(
        JSON.stringify(benchmark.config)
      );
      const parseTime = performance.now() - parseStart;
      result.parseTime = parseTime;

      // Measure compatibility processing time
      let compatTime = 0;
      if (validationResult.isValid) {
        const compatStart = performance.now();
        await this.compatibilityEngine.processCompatibility(
          JSON.stringify(benchmark.config)
        );
        compatTime = performance.now() - compatStart;
      }
      result.compatTime = compatTime;

      // Measure total processing time
      const totalTime = performance.now() - iterationStart;
      result.totalTime = totalTime;

      // Measure memory usage
      const memoryUsed = process.memoryUsage().heapUsed - iterationMemoryStart;
      result.memoryUsed = memoryUsed;

      // Calculate throughput (configs per second)
      result.throughput = totalTime > 0 ? 1000 / totalTime : 0;

      // Additional metrics can be added here
      result.validationTime = validationResult.isValid ? 0 : totalTime;
      result.errorCount = validationResult.isValid ? 0 : validationResult.errors.length;

    } catch (error) {
      result.error = 1;
      result.errorTime = performance.now() - iterationStart;
    }

    return result;
  }

  /**
   * Calculate aggregate value from array of numbers
   */
  private calculateAggregate(values: number[], aggregator: string): number {
    if (values.length === 0) return 0;

    switch (aggregator) {
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'avg':
        return values.reduce((sum, val) => sum + val, 0) / values.length;
      case 'median':
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
      case 'p95':
        const sorted95 = [...values].sort((a, b) => a - b);
        const index95 = Math.floor(sorted95.length * 0.95);
        return sorted95[Math.min(index95, sorted95.length - 1)];
      case 'p99':
        const sorted99 = [...values].sort((a, b) => a - b);
        const index99 = Math.floor(sorted99.length * 0.99);
        return sorted99[Math.min(index99, sorted99.length - 1)];
      default:
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }
  }

  /**
   * Check if metrics meet thresholds
   */
  private checkThresholds(
    metrics: Record<string, number>,
    thresholds: PerformanceThreshold,
    warnings: string[]
  ): boolean {
    let passed = true;

    for (const [metricName, value] of Object.entries(metrics)) {
      if (value >= thresholds.critical) {
        warnings.push(`${metricName}: ${value}${thresholds.unit} exceeds critical threshold (${thresholds.critical}${thresholds.unit})`);
        passed = false;
      } else if (value >= thresholds.warning) {
        warnings.push(`${metricName}: ${value}${thresholds.unit} exceeds warning threshold (${thresholds.warning}${thresholds.unit})`);
      }
    }

    return passed;
  }

  /**
   * Create common performance benchmarks
   */
  createCommonBenchmarks(): PerformanceBenchmark[] {
    return [
      this.createSmallConfigBenchmark(),
      this.createMediumConfigBenchmark(),
      this.createLargeConfigBenchmark(),
      this.createComplexConfigBenchmark(),
      this.createErrorConfigBenchmark()
    ];
  }

  /**
   * Create small configuration benchmark
   */
  private createSmallConfigBenchmark(): PerformanceBenchmark {
    return {
      id: 'small-config',
      name: 'Small Configuration Parsing',
      iterations: 1000,
      warmupIterations: 100,
      config: {
        version: '1.0.0',
        port: 8080,
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai',
          providers: {
            'openai-provider': {
              type: 'openai',
              enabled: true,
              apiKey: 'test-key',
              models: {
                'gpt-3.5-turbo': {
                  maxTokens: 4096
                }
              }
            }
          },
          routing: {
            default: ['openai-provider.gpt-3.5-turbo']
          }
        }
      },
      metrics: [
        { name: 'parseTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'compatTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'totalTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'throughput', type: 'throughput', unit: 'configs/sec', aggregator: 'avg' },
        { name: 'memoryUsed', type: 'memory', unit: 'bytes', aggregator: 'max' }
      ],
      thresholds: {
        warning: 10,
        critical: 50,
        unit: 'ms'
      }
    };
  }

  /**
   * Create medium configuration benchmark
   */
  private createMediumConfigBenchmark(): PerformanceBenchmark {
    const config = this.createMediumTestConfig();

    return {
      id: 'medium-config',
      name: 'Medium Configuration Parsing',
      iterations: 500,
      warmupIterations: 50,
      config,
      metrics: [
        { name: 'parseTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'compatTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'totalTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'throughput', type: 'throughput', unit: 'configs/sec', aggregator: 'avg' },
        { name: 'memoryUsed', type: 'memory', unit: 'bytes', aggregator: 'max' }
      ],
      thresholds: {
        warning: 25,
        critical: 100,
        unit: 'ms'
      }
    };
  }

  /**
   * Create large configuration benchmark
   */
  private createLargeConfigBenchmark(): PerformanceBenchmark {
    const config = this.createLargeTestConfig();

    return {
      id: 'large-config',
      name: 'Large Configuration Parsing',
      iterations: 100,
      warmupIterations: 10,
      config,
      metrics: [
        { name: 'parseTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'compatTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'totalTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'throughput', type: 'throughput', unit: 'configs/sec', aggregator: 'avg' },
        { name: 'memoryUsed', type: 'memory', unit: 'bytes', aggregator: 'max' }
      ],
      thresholds: {
        warning: 100,
        critical: 500,
        unit: 'ms'
      }
    };
  }

  /**
   * Create complex configuration benchmark
   */
  private createComplexConfigBenchmark(): PerformanceBenchmark {
    const config = this.createComplexTestConfig();

    return {
      id: 'complex-config',
      name: 'Complex Configuration Parsing',
      iterations: 200,
      warmupIterations: 20,
      config,
      metrics: [
        { name: 'parseTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'compatTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'totalTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'throughput', type: 'throughput', unit: 'configs/sec', aggregator: 'avg' },
        { name: 'memoryUsed', type: 'memory', unit: 'bytes', aggregator: 'max' }
      ],
      thresholds: {
        warning: 75,
        critical: 250,
        unit: 'ms'
      }
    };
  }

  /**
   * Create error configuration benchmark
   */
  private createErrorConfigBenchmark(): PerformanceBenchmark {
    return {
      id: 'error-config',
      name: 'Error Configuration Handling',
      iterations: 1000,
      warmupIterations: 100,
      config: {
        version: '1.0.0',
        port: 'invalid', // Invalid type
        virtualrouter: {
          inputProtocol: 'invalid-protocol',
          outputProtocol: 'openai',
          providers: {
            'invalid-provider': {
              type: 'invalid-type',
              enabled: 'true', // String instead of boolean
              apiKey: [], // Array instead of string
              models: {} // Empty models
            }
          },
          routing: {
            default: ['invalid-provider.invalid-model']
          }
        }
      },
      metrics: [
        { name: 'parseTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'totalTime', type: 'time', unit: 'ms', aggregator: 'p95' },
        { name: 'errorCount', type: 'time', unit: 'count', aggregator: 'avg' },
        { name: 'errorTime', type: 'time', unit: 'ms', aggregator: 'p95' }
      ],
      thresholds: {
        warning: 25,
        critical: 100,
        unit: 'ms'
      }
    };
  }

  /**
   * Create medium test configuration
   */
  private createMediumTestConfig(): any {
    return {
      version: '1.0.0',
      port: 8080,
      virtualrouter: {
        inputProtocol: 'openai',
        outputProtocol: 'openai',
        providers: {
          'openai-provider': {
            type: 'openai',
            enabled: true,
            apiKey: 'test-key',
            models: {
              'gpt-3.5-turbo': {
                maxTokens: 4096
              },
              'gpt-4': {
                maxTokens: 8192
              }
            }
          },
          'anthropic-provider': {
            type: 'anthropic',
            enabled: true,
            apiKey: 'test-key',
            models: {
              'claude-3-sonnet': {
                maxTokens: 4096
              }
            }
          }
        },
        routing: {
          default: ['openai-provider.gpt-3.5-turbo'],
          'long-context': ['openai-provider.gpt-4'],
          'creative': ['anthropic-provider.claude-3-sonnet']
        }
      }
    };
  }

  /**
   * Create large test configuration
   */
  private createLargeTestConfig(): any {
    const config = this.createMediumTestConfig();

    // Add more providers
    for (let i = 1; i <= 10; i++) {
      const providerId = `provider-${i}`;
      config.virtualrouter.providers[providerId] = {
        type: 'openai',
        enabled: true,
        apiKey: `test-key-${i}`,
        models: {
          [`model-${i}-1`]: {
            maxTokens: 4096
          },
          [`model-${i}-2`]: {
            maxTokens: 8192
          }
        }
      };
    }

    // Add more routing rules
    for (let i = 1; i <= 20; i++) {
      config.virtualrouter.routing[`route-${i}`] = [
        `provider-${i % 10 + 1}.model-${i % 2 + 1}-${Math.floor(i / 2) + 1}`
      ];
    }

    return config;
  }

  /**
   * Create complex test configuration
   */
  private createComplexTestConfig(): any {
    const config = this.createMediumTestConfig();

    // Add complex compatibility configurations
    config.virtualrouter.providers['openai-provider'].compatibility = {
      type: 'lmstudio-compatibility',
      config: {
        toolsEnabled: true,
        customRules: [
          {
            id: 'tool-mapping',
            transform: 'mapping',
            sourcePath: 'tools',
            targetPath: 'tools',
            mapping: {
              'type': 'type',
              'function': 'function'
            }
          }
        ]
      }
    };

    // Add OAuth configurations
    config.virtualrouter.providers['anthropic-provider'].oauth = {
      'anthropic-oauth': {
        type: 'auth-code',
        clientId: 'test-client-id',
        authUrl: 'https://auth.anthropic.com/auth',
        tokenUrl: 'https://auth.anthropic.com/token',
        scopes: ['read', 'write']
      }
    };

    // Add thinking configurations
    config.virtualrouter.providers['openai-provider'].models['gpt-4'].thinking = {
      enabled: true,
      payload: {
        type: 'enabled'
      }
    };

    // Add complex pipeline configurations
    config.pipeline = {
      modules: [
        {
          name: 'logging',
          enabled: true,
          config: {
            level: 'debug',
            outputs: ['console', 'file']
          }
        },
        {
          name: 'metrics',
          enabled: true,
          config: {
            enabled: true,
            endpoint: 'http://localhost:9090'
          }
        }
      ]
    };

    return config;
  }

  /**
   * Run multiple benchmarks and generate a report
   */
  async runBenchmarkSuite(benchmarks: PerformanceBenchmark[]): Promise<{
    results: BenchmarkResult[];
    summary: {
      total: number;
      passed: number;
      failed: number;
      totalDuration: number;
    };
  }> {
    const results: BenchmarkResult[] = [];

    for (const benchmark of benchmarks) {
      const result = await this.runBenchmark(benchmark);
      results.push(result);
    }

    const summary = {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      totalDuration: results.reduce((sum, r) => sum + r.duration, 0)
    };

    return { results, summary };
  }
}